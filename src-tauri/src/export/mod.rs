//! Export engine: turn an `ExportSpec` into a single ffmpeg invocation on the
//! export lane, streaming progress and atomically publishing the result.

pub mod builder;
pub mod estimate;
pub mod model;

use std::ffi::OsString;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use xxhash_rust::xxh3::xxh3_64;

use crate::error::{AppError, Result};
use crate::hw;
use crate::jobs::{self, JobId, JobKind, Jobs, Lane};

use self::builder::{BuiltExport, FILTER_PLACEHOLDER};
use self::model::ExportSpec;

/// Filtergraphs longer than this are written to a script file and passed via
/// `-filter_complex_script` to avoid command-line length limits.
const INLINE_FILTER_LIMIT: usize = 8000;

/// Temp files created while finalizing an export, cleaned up in every exit path
/// (success, failure, cancel).
struct ExportTemps {
    /// The `-filter_complex_script` file, if the graph exceeded the inline limit.
    script: Option<std::path::PathBuf>,
    /// The drawtext `textfile` files (one per text generator).
    texts: Vec<std::path::PathBuf>,
}

impl ExportTemps {
    fn cleanup(&self) {
        if let Some(s) = &self.script {
            let _ = std::fs::remove_file(s);
        }
        for t in &self.texts {
            let _ = std::fs::remove_file(t);
        }
    }
}

/// Escape a materialized textfile path for drawtext.
///
/// The transformation itself is `builder::escape_filter_value` — the ONE copy,
/// shared with the builder rather than mirrored here. This function is the
/// %TEMP%-specific rejection around it: an escaper that drifts from the one that
/// wrote the placeholder produces a graph ffmpeg parses differently from the one
/// whose length chose inline-vs-script mode.
///
/// A single quote is REJECTED for the same reason the builder rejects it:
/// ffmpeg's filter-option syntax has no escape that survives inside a quoted
/// value (neither `\'` nor `'\''`), so the path would silently truncate and
/// ffmpeg would report a missing file. This path is `%TEMP%`, so on an account
/// like `O'Brien` that would break EVERY export containing text — hence the
/// message names the way out instead of just failing.
fn escape_text_path(path: &str) -> Result<String> {
    if path.contains('\'') {
        return Err(AppError::BadInput(format!(
            "text export needs a temp folder path without an apostrophe; \
             set the TMP environment variable to a path like C:\\Temp \
             and restart Taroting (current temp path: {path})"
        )));
    }
    Ok(builder::escape_filter_value(path))
}

/// Splice the built filtergraph into the argv. Text payloads are materialized to
/// `%TEMP%` and their placeholders substituted (escaped) BEFORE deciding
/// inline-vs-script, so the composed graph feeds the length check. When inline,
/// the placeholder is replaced with the filter string; in script mode the
/// preceding `-filter_complex` flag becomes `-filter_complex_script` and the
/// placeholder becomes the script path. Returns temp files to delete after the
/// job.
fn finalize_args(built: &BuiltExport, out_path: &str) -> Result<(Vec<OsString>, ExportTemps)> {
    let mut args = built.args.clone();
    let pos = args
        .iter()
        .position(|a| a == FILTER_PLACEHOLDER)
        .ok_or_else(|| AppError::Ffmpeg("filter placeholder missing from args".into()))?;

    let hash = xxh3_64(out_path.as_bytes());

    // Materialize drawtext textfiles and substitute their escaped real paths for
    // the placeholders inside the graph.
    let mut filter = built.filter_complex.clone();
    let mut texts: Vec<std::path::PathBuf> = Vec::new();
    for (i, (placeholder, content)) in built.text_payloads.iter().enumerate() {
        let file = std::env::temp_dir().join(format!("taroting-text-{hash:016x}-{i}.txt"));
        if let Err(e) = std::fs::write(&file, content.as_bytes()) {
            // best-effort cleanup of any earlier files before bailing
            for t in &texts {
                let _ = std::fs::remove_file(t);
            }
            return Err(e.into());
        }
        texts.push(file.clone());
        let esc = match escape_text_path(&file.to_string_lossy()) {
            Ok(esc) => esc,
            Err(e) => {
                for t in &texts {
                    let _ = std::fs::remove_file(t);
                }
                return Err(e);
            }
        };
        // The placeholder was embedded escaped-quoted (`'…'`); replace the
        // quoted placeholder with the quoted real path.
        let quoted_placeholder = format!("'{placeholder}'");
        filter = filter.replace(&quoted_placeholder, &esc);
    }

    if filter.len() > INLINE_FILTER_LIMIT {
        let script = std::env::temp_dir().join(format!("taroting-filter-{hash:016x}.txt"));
        if let Err(e) = std::fs::write(&script, filter.as_bytes()) {
            for t in &texts {
                let _ = std::fs::remove_file(t);
            }
            return Err(e.into());
        }
        if pos == 0 {
            for t in &texts {
                let _ = std::fs::remove_file(t);
            }
            return Err(AppError::Ffmpeg("malformed filter args".into()));
        }
        args[pos - 1] = OsString::from("-filter_complex_script");
        args[pos] = OsString::from(&script);
        Ok((args, ExportTemps { script: Some(script), texts }))
    } else {
        args[pos] = OsString::from(&filter);
        Ok((args, ExportTemps { script: None, texts }))
    }
}

/// Publish a finished encode: move `<out>.part` onto `<out>`.
///
/// Renames STRAIGHT onto the destination — it never deletes what is already
/// there first. `rename` replaces atomically on Windows, so a failure leaves the
/// user's previous export at that path completely untouched; the old
/// remove-then-rename destroyed that previous export whenever the rename then
/// failed, which needs nothing more exotic than a media player, an AV scanner or
/// a sync client holding the file (Windows opens without `FILE_SHARE_DELETE`,
/// so the rename fails while the delete had already gone through).
///
/// On failure the `.part` file is deliberately left on disk and NAMED in the
/// error. The encode is complete at that point: it is the user's finished video,
/// and making them re-run a long export to get it back would be absurd.
fn publish_export(part: &std::path::Path, final_path: &std::path::Path) -> std::result::Result<(), String> {
    std::fs::rename(part, final_path).map_err(|e| {
        format!(
            "the export finished but could not be saved to {}: {e}. \
             The finished video is at {} — close anything using the destination \
             file, then rename that file to remove the .part suffix.",
            final_path.display(),
            part.display()
        )
    })
}

/* ------------------------------------------------------------------ */
/* Failure detail + redaction                                          */
/* ------------------------------------------------------------------ */

/// The two most diagnostic artifacts of a failed export (the argv and the
/// filtergraph) plus the error itself. Held ONLY between a failed export and
/// the next successful one — a healthy export clears it, so nothing is retained
/// in the normal case.
pub struct ExportFailureDetail {
    argv: Vec<String>,
    filter_complex: String,
    message: String,
    log_tail: Vec<String>,
    ffmpeg_version: String,
}

/// The redacted, shareable form of `ExportFailureDetail`. Field names are the
/// locked wire seam (camelCase).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedFailure {
    argv: Vec<String>,
    filter_complex: String,
    message: String,
    log_tail: Vec<String>,
    ffmpeg_version: String,
}

/// Managed state: the last failed export, or `None` after a successful one.
#[derive(Default)]
pub struct LastExportFailure(std::sync::Mutex<Option<ExportFailureDetail>>);

impl LastExportFailure {
    fn guard(&self) -> std::sync::MutexGuard<'_, Option<ExportFailureDetail>> {
        // A poisoned lock still holds a perfectly good report; never let a
        // diagnostics path be the thing that fails.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn store(&self, detail: ExportFailureDetail) {
        *self.guard() = Some(detail);
    }
    fn clear(&self) {
        *self.guard() = None;
    }
    /// PEEK, not take: the frontend's Copy and Save both need to work.
    fn peek_redacted(&self) -> Option<RedactedFailure> {
        self.guard().as_ref().map(redact_paths)
    }
}

/// Snapshot argv for the failure report. `to_string_lossy` so a non-UTF8 path
/// (perfectly legal on Windows) can never panic here.
fn argv_snapshot(args: &[OsString]) -> Vec<String> {
    args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
}

const VIDEO_EXT: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "mts",
    "ogv", "3gp", "gif",
];
const AUDIO_EXT: &[&str] = &["wav", "mp3", "aac", "m4a", "flac", "ogg", "opus", "wma", "aif", "aiff"];
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp", "tif", "tiff"];

/// Lowercase extension of a path-ish string, without touching the filesystem.
fn ext_of(path: &str) -> String {
    let tail = path.rsplit(['\\', '/']).next().unwrap_or(path);
    match tail.rfind('.') {
        Some(i) if i + 1 < tail.len() => tail[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn kind_for(ext: &str) -> &'static str {
    if VIDEO_EXT.contains(&ext) {
        "video"
    } else if AUDIO_EXT.contains(&ext) {
        "audio"
    } else if IMAGE_EXT.contains(&ext) {
        "image"
    } else {
        "file"
    }
}

/// Case-insensitive (ASCII) literal replace. `to_ascii_lowercase` preserves
/// byte length, so every index taken from the folded copy is a valid char
/// boundary in the original — validate before you slice.
fn replace_ci(hay: &str, needle: &str, with: &str) -> String {
    if needle.is_empty() || needle.len() > hay.len() {
        return hay.to_string();
    }
    let folded = hay.to_ascii_lowercase();
    let want = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(hay.len());
    let mut i = 0;
    while let Some(off) = folded[i..].find(&want) {
        let start = i + off;
        out.push_str(&hay[i..start]);
        out.push_str(with);
        i = start + want.len();
    }
    out.push_str(&hay[i..]);
    out
}

/// Build the stable real-path → pseudonym map for ONE report. Inputs are the
/// argv entries following `-i`; the final argv entry is the output. Keys are
/// sorted longest-first so `<out>.part` wins over `<out>` and no alias can be
/// applied inside another.
fn build_alias_map(argv: &[String]) -> Vec<(String, String)> {
    let mut aliases: Vec<(String, String)> = Vec::new();
    let mut counts = std::collections::HashMap::<&'static str, u32>::new();
    let push = |path: &str, alias: String, aliases: &mut Vec<(String, String)>| {
        if !path.is_empty() && !aliases.iter().any(|(k, _)| k == path) {
            aliases.push((path.to_string(), alias));
        }
    };

    // Output first: ffmpeg writes "<out>.part", but stderr and the message can
    // mention either form. Both collapse to the same placeholder.
    if let Some(last) = argv.last() {
        let real = last.strip_suffix(".part").unwrap_or(last);
        let ext = ext_of(real);
        let alias = if ext.is_empty() {
            "<out>".to_string()
        } else {
            format!("<out.{ext}>")
        };
        push(last, alias.clone(), &mut aliases);
        push(real, alias, &mut aliases);
    }

    for (i, a) in argv.iter().enumerate() {
        if a != "-i" {
            continue;
        }
        let Some(path) = argv.get(i + 1) else { continue };
        if aliases.iter().any(|(k, _)| k == path) {
            continue;
        }
        let ext = ext_of(path);
        let kind = kind_for(&ext);
        let n = counts.entry(kind).or_insert(0);
        *n += 1;
        let alias = if ext.is_empty() {
            format!("{kind}{n}")
        } else {
            format!("{kind}{n}.{ext}")
        };
        push(path, alias, &mut aliases);
    }

    aliases.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    aliases
}

/// The deny-list swept LAST over every field: our own known-sensitive strings.
/// ffmpeg's stderr is free text from a third-party binary, so a deny-list on
/// strings we know identify this machine is the correct shape there — an
/// allow-list cannot be written for text we do not author.
fn env_terms() -> Vec<(String, &'static str)> {
    let mut terms: Vec<(String, &'static str)> = Vec::new();
    let add = |var: &str, tag: &'static str, terms: &mut Vec<(String, &'static str)>| {
        let Some(raw) = std::env::var_os(var) else { return };
        let raw = raw.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        if raw.len() < 3 {
            return; // too short to be a safe literal to sweep
        }
        // The same directory appears in three shapes: as-is, forward-slashed
        // (drawtext path escaping), and forward-slashed with '\:' colons.
        let fwd = raw.replace('\\', "/");
        let esc = fwd.replace(':', "\\:");
        for v in [raw, fwd, esc] {
            if !terms.iter().any(|(k, _)| *k == v) {
                terms.push((v, tag));
            }
        }
    };
    add("TEMP", "<temp>", &mut terms);
    add("TMP", "<temp>", &mut terms);
    add("LOCALAPPDATA", "<localappdata>", &mut terms);
    add("APPDATA", "<appdata>", &mut terms);
    add("USERPROFILE", "<home>", &mut terms);
    add("USERNAME", "<user>", &mut terms);
    // Longest first: %TEMP% lives under %LOCALAPPDATA%, and every one of them
    // contains the bare username.
    terms.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    terms
}

/// Apply the alias map, then the deny-list sweep. Pure.
fn scrub(s: &str, aliases: &[(String, String)], terms: &[(String, &'static str)]) -> String {
    let mut out = s.to_string();
    for (real, alias) in aliases {
        out = replace_ci(&out, real, alias);
    }
    for (term, tag) in terms {
        out = replace_ci(&out, term, tag);
    }
    out
}

/// Redact a failure into its shareable form. Media *properties* (w×h, fps,
/// codec, pix_fmt, duration, size) survive untouched — they are the
/// reproduction and are not personal. Text-generator content never reaches
/// here: the builder emits `textfile=<path>`, never inline `text=`.
fn redact_paths(detail: &ExportFailureDetail) -> RedactedFailure {
    redact_with(detail, &env_terms())
}

/// Pure core of `redact_paths` with the machine-specific terms injected.
fn redact_with(detail: &ExportFailureDetail, terms: &[(String, &'static str)]) -> RedactedFailure {
    let aliases = build_alias_map(&detail.argv);
    RedactedFailure {
        argv: detail.argv.iter().map(|a| scrub(a, &aliases, terms)).collect(),
        filter_complex: scrub(&detail.filter_complex, &aliases, terms),
        message: scrub(&detail.message, &aliases, terms),
        log_tail: detail.log_tail.iter().map(|l| scrub(l, &aliases, terms)).collect(),
        ffmpeg_version: detail.ffmpeg_version.clone(),
    }
}

/// Redacted detail of the last failed export, or `null` when the last export
/// succeeded (or none has run). Peeks — repeated calls return the same report.
#[tauri::command]
pub fn export_failure_report(state: State<'_, LastExportFailure>) -> Option<RedactedFailure> {
    state.peek_redacted()
}

/* ------------------------------------------------------------------ */
/* Export command                                                      */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn start_export(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    spec: ExportSpec,
) -> Result<JobId> {
    let (encoders, ffmpeg_version) = hw::detect(false);
    let built = builder::build(&spec, &encoders)?;
    let out_path = spec.out_path.clone();

    let (mut final_args, temps) = finalize_args(&built, &out_path)?;

    // ffmpeg writes to "<out>.part"; the container is preserved because -f is
    // set from the format, not inferred from the extension.
    let part_path = std::path::PathBuf::from(format!("{out_path}.part"));
    // replace the output path (last argv entry) with the .part path
    let last = final_args.len() - 1;
    final_args[last] = OsString::from(&part_path);

    let total = built.duration_sec;
    // MOVE the graph out of `built` (not a clone — `built` is dead after
    // `finalize_args` + `duration_sec`), so the report costs no extra
    // allocation. The argv snapshot is one small Vec per export start.
    let filter_complex = built.filter_complex;
    let argv = argv_snapshot(&final_args);

    let handle = jobs.allocate(JobKind::Export);
    let job_id = handle.id;

    let app_clone = app.clone();
    let jobs_arc = Arc::clone(&jobs);
    let out_final = out_path.clone();

    jobs.submit(
        Lane::Export,
        Box::new(move || {
            // cleanup on cancel/failure targets the .part file
            handle.set_output(part_path.clone());

            let result = jobs::execute_ffmpeg(&app_clone, &handle, final_args, Some(total));

            // always remove temp files (filter script + textfiles) whatever the
            // outcome: success, failure, or cancel.
            temps.cleanup();

            // Record (or clear) the diagnostic detail for `export_failure_report`.
            // Nothing is retained after a healthy export. A user-initiated
            // cancel is not a failure: it neither stores a bogus report nor
            // discards a real one the user has not copied out yet.
            let remember = |message: &str, log_tail: &[String]| {
                if handle.is_canceled() {
                    return;
                }
                if let Some(state) = app_clone.try_state::<LastExportFailure>() {
                    state.store(ExportFailureDetail {
                        argv: argv.clone(),
                        filter_complex: filter_complex.clone(),
                        message: message.to_string(),
                        log_tail: log_tail.to_vec(),
                        ffmpeg_version: ffmpeg_version.clone(),
                    });
                }
            };

            match result {
                Ok(()) => {
                    // The encode is COMPLETE, so the .part file is no longer a
                    // partial: it is the finished video. Drop the job's cleanup
                    // target before anything can fail, because fail_job() runs
                    // cleanup_output() and would otherwise delete the very file
                    // the user is waiting for.
                    handle.clear_output();

                    let final_pb = std::path::PathBuf::from(&out_final);
                    match publish_export(&part_path, &final_pb) {
                        Ok(()) => {
                            if let Some(state) = app_clone.try_state::<LastExportFailure>() {
                                state.clear();
                            }
                            jobs::complete_job(
                                &app_clone,
                                &jobs_arc,
                                &handle,
                                serde_json::json!({ "path": out_final }),
                            );
                        }
                        Err(message) => {
                            remember(&message, &[]);
                            jobs::fail_job(
                                &app_clone,
                                &jobs_arc,
                                &handle,
                                message,
                                Vec::new(),
                            );
                        }
                    }
                }
                Err(failure) => {
                    remember(&failure.message, &failure.log_tail);
                    jobs::fail_job(
                        &app_clone,
                        &jobs_arc,
                        &handle,
                        failure.message,
                        failure.log_tail,
                    );
                }
            }
        }),
    );

    Ok(job_id)
}

/* ------------------------------------------------------------------ */
/* Unit: path escaping + redaction                                     */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod unit {
    use super::*;

    /// Machine-specific sweep terms, injected so the tests stay pure (no env
    /// mutation, no dependency on whoever is running them).
    fn terms() -> Vec<(String, &'static str)> {
        let mut t: Vec<(String, &'static str)> = vec![
            (r"C:\Users\adele\AppData\Local\Temp".into(), "<temp>"),
            ("C:/Users/adele/AppData/Local/Temp".into(), "<temp>"),
            (r"C\:/Users/adele/AppData/Local/Temp".into(), "<temp>"),
            (r"C:\Users\adele\AppData\Local".into(), "<localappdata>"),
            (r"C:\Users\adele\AppData\Roaming".into(), "<appdata>"),
            (r"C:\Users\adele".into(), "<home>"),
            ("adele".into(), "<user>"),
        ];
        t.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        t
    }

    fn detail(argv: &[&str], filter: &str, message: &str, tail: &[&str]) -> ExportFailureDetail {
        ExportFailureDetail {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            filter_complex: filter.to_string(),
            message: message.to_string(),
            log_tail: tail.iter().map(|s| s.to_string()).collect(),
            ffmpeg_version: "ffmpeg version 8.1.1-full_build".into(),
        }
    }

    /* -------- (1) the apostrophe crash -------- */

    #[test]
    fn escape_text_path_rejects_an_apostrophe_with_an_actionable_message() {
        let err = escape_text_path(r"C:\Users\O'Brien\AppData\Local\Temp\taroting-text-0.txt")
            .unwrap_err();
        assert!(matches!(err, AppError::BadInput(_)), "wrong variant: {err:?}");
        let msg = err.to_string();
        // must name the workaround, not just complain
        assert!(msg.contains("apostrophe"), "message: {msg}");
        assert!(msg.contains("TMP"), "message must name the TMP variable: {msg}");
        assert!(msg.contains(r"C:\Temp"), "message must give a concrete path: {msg}");
    }

    /// ONE escaper, two rejection messages.
    ///
    /// The builder embeds a PLACEHOLDER escaped by its own wrapper and this
    /// module substitutes the real path escaped by that one; the graph whose
    /// length picks inline-vs-script mode is measured between those two steps.
    /// If the transformations ever drift apart, the string ffmpeg parses is not
    /// the string that was measured — so they are the same function, and this is
    /// what says so.
    #[test]
    fn the_textfile_escaper_is_the_builders_escaper() {
        for p in [
            r"C:\Users\adele\AppData\Local\Temp\taroting-text-ab-0.txt",
            r"D:\a folder\with-dashes_and.dots.txt",
            r"\\server\share\clip.txt",
            "no-separators-at-all",
        ] {
            assert_eq!(
                escape_text_path(p).unwrap(),
                builder::escape_filter_value(p),
                "escapers disagree on {p}"
            );
        }
        // Both still refuse a quote — the rejection is what stayed per-caller.
        assert!(escape_text_path("a'b").is_err());
    }

    #[test]
    fn escape_text_path_leaves_a_normal_path_unchanged() {
        let esc = escape_text_path(r"C:\Users\adele\AppData\Local\Temp\taroting-text-ab-0.txt")
            .unwrap();
        assert_eq!(
            esc,
            r"'C\:/Users/adele/AppData/Local/Temp/taroting-text-ab-0.txt'"
        );
    }

    /* -------- (2) redaction -------- */

    #[test]
    fn redaction_uses_one_consistent_map_across_argv_graph_and_stderr() {
        let src = r"C:\Users\adele\Videos\Trip To Rome.mp4";
        let d = detail(
            &[
                "-i", src,
                "-i", r"D:\Sound\Theme Song.wav",
                // the SAME source registered a second time must reuse its alias
                "-i", src,
                "-filter_complex", "",
                r"D:\Exports\Final Cut.mp4.part",
            ],
            &format!("[0:v]scale=1920:1080[v];movie='{src}'[m]"),
            "ffmpeg exited with 0xffffffea",
            &[format!("[in#0 @ 0000] Error opening input: {src}").as_str()],
        );
        let r = redact_with(&d, &terms());

        // one map: the same file is video1.mp4 in argv, graph AND stderr
        assert_eq!(r.argv[1], "video1.mp4");
        assert_eq!(r.argv[5], "video1.mp4", "same path must reuse its alias");
        assert!(r.filter_complex.contains("movie='video1.mp4'"), "{}", r.filter_complex);
        assert!(r.log_tail[0].ends_with("video1.mp4"), "{}", r.log_tail[0]);

        // and nothing real survives anywhere
        for s in r.argv.iter().chain([&r.filter_complex, &r.message]).chain(r.log_tail.iter()) {
            assert!(!s.contains("adele"), "username leaked: {s}");
            assert!(!s.contains("Trip To Rome"), "real filename leaked: {s}");
            assert!(!s.contains("Users"), "directory component leaked: {s}");
        }
        // media properties are the reproduction — they must NOT be scrubbed
        assert!(r.filter_complex.contains("scale=1920:1080"));
        assert_eq!(r.ffmpeg_version, "ffmpeg version 8.1.1-full_build");
    }

    #[test]
    fn redaction_sweeps_a_path_seen_only_in_stderr() {
        let d = detail(
            &["-i", r"D:\Clips\a.mp4", r"D:\out.mp4.part"],
            "",
            "",
            &[
                r"[Parsed_drawtext_3] Cannot find file C:\Users\adele\AppData\Local\Temp\taroting-text-1.txt",
                r"Conversion failed for C:\Users\adele\Documents\Taroting\My Wedding.trt",
            ],
        );
        let r = redact_with(&d, &terms());
        // never an argv entry, so it has no alias — the deny-list still gets it
        assert!(r.log_tail[0].starts_with("[Parsed_drawtext_3] Cannot find file <temp>"), "{}", r.log_tail[0]);
        assert!(r.log_tail[1].contains("<home>"), "{}", r.log_tail[1]);
        for line in &r.log_tail {
            assert!(!line.contains("adele"), "username leaked: {line}");
        }
    }

    #[test]
    fn redaction_preserves_the_extension_per_media_kind() {
        let d = detail(
            &[
                "-i", r"C:\a\one.MOV",
                "-i", r"C:\a\two.wav",
                "-i", r"C:\a\three.png",
                "-i", r"C:\a\four.srt",
                "-i", r"C:\a\five.mkv",
                r"C:\a\out.webm.part",
            ],
            "",
            "",
            &[],
        );
        let r = redact_with(&d, &terms());
        assert_eq!(r.argv[1], "video1.mov", "extension preserved, kind classified");
        assert_eq!(r.argv[3], "audio1.wav");
        assert_eq!(r.argv[5], "image1.png");
        assert_eq!(r.argv[7], "file1.srt", "unknown kinds still keep their extension");
        assert_eq!(r.argv[9], "video2.mkv", "counter is per-kind and stable");
        assert_eq!(r.argv[10], "<out.webm>");
    }

    #[test]
    fn redaction_collapses_the_part_file_and_the_final_output() {
        let d = detail(
            &["-i", r"C:\a\clip.mp4", r"D:\My Exports\Holiday Reel.mp4.part"],
            "",
            r"failed to finalize output: rename D:\My Exports\Holiday Reel.mp4.part failed",
            &[r"Could not write header for D:\My Exports\Holiday Reel.mp4"],
        );
        let r = redact_with(&d, &terms());
        assert_eq!(r.argv[2], "<out.mp4>");
        assert!(r.message.contains("<out.mp4>"), "{}", r.message);
        // the non-.part form, which only ffmpeg mentions, collapses identically
        assert_eq!(r.log_tail[0], "Could not write header for <out.mp4>");
        for s in [&r.message, &r.log_tail[0]] {
            assert!(!s.contains("Holiday Reel"), "output name leaked: {s}");
            assert!(!s.contains("My Exports"), "output directory leaked: {s}");
        }
    }

    /// A non-UTF8 path is legal on Windows; snapshotting must go through
    /// `to_string_lossy` so it can never panic on the way into a report.
    #[cfg(windows)]
    #[test]
    fn redaction_survives_a_non_utf8_path() {
        use std::os::windows::ffi::OsStringExt;
        // lone surrogate: not valid UTF-16, so not convertible to UTF-8
        let bad = OsString::from_wide(&[0x0044u16, 0xD800, 0x002E, 0x006D, 0x0070, 0x0034]);
        let argv = vec![OsString::from("-i"), bad, OsString::from("D:\\out.mp4.part")];
        let snapshot = argv_snapshot(&argv);
        assert_eq!(snapshot.len(), 3);
        assert!(snapshot[1].contains('\u{FFFD}'), "expected a replacement char");

        let d = ExportFailureDetail {
            argv: snapshot,
            filter_complex: String::new(),
            message: String::new(),
            log_tail: Vec::new(),
            ffmpeg_version: String::new(),
        };
        let r = redact_with(&d, &terms());
        assert_eq!(r.argv.len(), 3);
        assert_eq!(r.argv[1], "video1.mp4", "lossy path still aliases by extension");
    }

    #[test]
    fn replace_ci_is_case_insensitive_and_boundary_safe() {
        assert_eq!(replace_ci(r"C:\USERS\Adele\x", r"c:\users\adele", "<home>"), "<home>\\x");
        // a multi-byte char either side of the match must survive intact
        assert_eq!(replace_ci("é-adele-é", "ADELE", "<user>"), "é-<user>-é");
        assert_eq!(replace_ci("nothing", "", "x"), "nothing");
    }

    /// The wire seam the frontend codes against: `null`, or exactly
    /// `{ argv, filterComplex, message, logTail, ffmpegVersion }`.
    #[test]
    fn export_failure_report_wire_shape_is_the_locked_seam() {
        let none: Option<RedactedFailure> = None;
        assert_eq!(serde_json::to_string(&none).unwrap(), "null");

        let state = LastExportFailure::default();
        state.store(detail(
            &["-i", r"C:\a\clip.mp4", r"C:\a\out.mp4.part"],
            "[0:v]null[vout]",
            "ffmpeg exited with 1",
            &["boom"],
        ));
        let v = serde_json::to_value(state.peek_redacted().unwrap()).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["argv", "ffmpegVersion", "filterComplex", "logTail", "message"]
        );
        assert!(v["argv"].is_array());
        assert!(v["logTail"].is_array());
        assert!(v["filterComplex"].is_string());
    }

    /* -------- (2b) publishing a finished encode -------- */

    fn publish_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taroting-publish-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn publish_replaces_an_existing_export_at_the_same_path() {
        let dir = publish_dir("ok");
        let part = dir.join("Reel.mp4.part");
        let out = dir.join("Reel.mp4");
        std::fs::write(&part, b"new encode").unwrap();
        std::fs::write(&out, b"previous export").unwrap();

        publish_export(&part, &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"new encode");
        assert!(!part.exists(), "the .part must be consumed by a successful publish");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The lost-work bug, reproduced through the file the publish actually
    /// moves. An AV scanner or search indexer grabbing the file ffmpeg has just
    /// closed is the everyday Windows way for a rename to fail, and it is what
    /// made the old delete-then-rename destructive: the `remove_file` succeeded
    /// (the destination was never the locked file), the rename then failed, and
    /// the user's previous export was simply gone.
    #[cfg(windows)]
    #[test]
    fn a_failed_publish_destroys_neither_the_new_encode_nor_the_old_export() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = publish_dir("locked");
        let part = dir.join("Holiday Reel.mp4.part");
        let out = dir.join("Holiday Reel.mp4");
        std::fs::write(&part, b"the finished encode").unwrap();
        std::fs::write(&out, b"last week's export").unwrap();

        // share_mode 0 = FILE_SHARE_NONE: nothing may move this file while the
        // handle is open, so the rename fails with "used by another process".
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&part)
            .unwrap();

        let message = publish_export(&part, &out).expect_err("rename must fail while locked");

        assert_eq!(
            std::fs::read(&out).unwrap(),
            b"last week's export",
            "the previous export must not be destroyed by a failed publish"
        );
        assert!(
            part.exists(),
            "the completed encode must survive a publish failure"
        );
        // The user has to be told WHERE the finished video is, or it may as
        // well have been deleted.
        assert!(
            message.contains("Holiday Reel.mp4.part"),
            "message must name the kept file: {message}"
        );

        drop(lock);
        assert_eq!(std::fs::read(&part).unwrap(), b"the finished encode");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (3) the managed state -------- */

    #[test]
    fn last_export_failure_stores_peeks_and_clears() {
        let state = LastExportFailure::default();
        assert!(state.peek_redacted().is_none(), "nothing retained before a failure");

        state.store(detail(
            &["-i", r"C:\a\clip.mp4", r"C:\a\out.mp4.part"],
            "[0:v]null[vout]",
            "ffmpeg exited with 1",
            &["boom"],
        ));
        let first = state.peek_redacted().expect("failure retained");
        assert_eq!(first.message, "ffmpeg exited with 1");
        // PEEK, not take: Copy and Save both have to work
        let second = state.peek_redacted().expect("peek must not consume");
        assert_eq!(second.argv, first.argv);

        state.clear();
        assert!(state.peek_redacted().is_none(), "a healthy export must clear it");
    }
}

/* ------------------------------------------------------------------ */
/* E2E: real ffmpeg + ffprobe                                          */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod e2e {
    use super::*;
    use crate::export::model::*;
    use crate::jobs::ffmpeg;
    use crate::media::probe;
    use crate::project::schema::*;

    fn fixtures_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("taroting export e2e");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ffmpeg_ok(args: &[&str]) {
        let out = ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
        assert!(
            out.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Run built argv directly through the sidecar (no job system needed for
    /// the encode itself), splicing the filter inline.
    fn run_built(built: &BuiltExport, out: &str, part: &std::path::Path) {
        let (mut args, temps) = finalize_args(built, out).unwrap();
        let last = args.len() - 1;
        args[last] = OsString::from(part);
        let res = ffmpeg::command("ffmpeg").unwrap().args(&args).output().unwrap();
        temps.cleanup();
        assert!(
            res.status.success(),
            "export ffmpeg failed: {}",
            String::from_utf8_lossy(&res.stderr)
        );
    }

    fn fixture_media(dir: &std::path::Path) -> (std::path::PathBuf, MediaRef) {
        // 3s testsrc2 + sine, 640x360, with a space in the path
        let src = dir.join("src fixture.mp4");
        if !src.exists() {
            ffmpeg_ok(&[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest",
                src.to_str().unwrap(),
            ]);
        }
        let info = probe::probe_sync(src.to_str().unwrap()).unwrap();
        let media = MediaRef {
            id: "m1".into(),
            path: src.to_string_lossy().into_owned(),
            size: info.size,
            mtime_ms: info.mtime_ms,
            kind: "video".into(),
            duration: info.duration,
            fps: Some(Rational { num: 30, den: 1 }),
            width: Some(640),
            height: Some(360),
            container: info.container.clone(),
            vcodec: info.vcodec.clone(),
            acodec: info.acodec.clone(),
            pix_fmt: info.pix_fmt.clone(),
            bit_depth: Some(8),
            has_audio: true,
            audio_rate: Some(48000),
            audio_channels: Some(2),
            generator: None,
        };
        (src, media)
    }

    fn default_audio() -> ClipAudio {
        ClipAudio {
            volume: 1.0,
            muted: false,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            gain_offset_db: 0.0,
            detached: false,
        }
    }

    fn enc() -> crate::hw::EncoderReport {
        // force software so this test doesn't depend on hardware
        crate::hw::EncoderReport {
            h264: "libx264".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        }
    }

    /* -------- helpers for pixel/probe verification -------- */

    /// Average luma (YAVG, 0..255) of a WxH crop region at time `t` of `path`,
    /// via `signalstats` + `metadata=print`. A robust, container-independent way
    /// to assert whether pixels changed in a region.
    fn yavg(path: &std::path::Path, t: f64, x: u32, y: u32, w: u32, h: u32) -> f64 {
        let vf = format!("crop={w}:{h}:{x}:{y},signalstats,metadata=print");
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args([
                "-hide_banner",
                "-nostats",
                "-ss",
                &format!("{t:.3}"),
                "-i",
                path.to_str().unwrap(),
                "-frames:v",
                "1",
                "-vf",
                &vf,
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        for line in stderr.lines() {
            if let Some(idx) = line.find("lavfi.signalstats.YAVG=") {
                let v = &line[idx + "lavfi.signalstats.YAVG=".len()..];
                if let Ok(n) = v.trim().parse::<f64>() {
                    return n;
                }
            }
        }
        panic!("no YAVG in ffmpeg output: {stderr}");
    }

    fn probe_dur(path: &std::path::Path) -> f64 {
        probe::probe_sync(path.to_str().unwrap()).unwrap().duration
    }

    fn clip_at(id: &str, media: &str, start: f64, si: f64, so: f64) -> Clip {
        Clip {
            id: id.into(), media_id: media.into(), timeline_start: start,
            src_in: si, src_out: so, speed: 1.0, transform: None,
            audio: default_audio(), keyframes: None,
        }
    }

    fn vtrack(id: &str, clips: Vec<Clip>) -> Track {
        Track { id: id.into(), kind: "video".into(), name: "V".into(), muted: false, clips }
    }

    fn preset_640(fps: f64) -> ExportPreset {
        ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 640, h: 360 },
            fps: FpsPreset::Custom(fps),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        }
    }

    fn encode(spec: &ExportSpec, dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        encode_with(spec, dir, name, &enc())
    }

    /// `encode` against an explicit encoder report, so a test can drive the
    /// hardware branch of `chosen_encoder` without touching real detection.
    fn encode_with(
        spec: &ExportSpec,
        dir: &std::path::Path,
        name: &str,
        encoders: &crate::hw::EncoderReport,
    ) -> std::path::PathBuf {
        let out = dir.join(name);
        let out_s = out.to_string_lossy().into_owned();
        let built = builder::build(spec, encoders).unwrap();
        let part = dir.join(format!("{name}.part"));
        run_built(&built, &out_s, &part);
        std::fs::rename(&part, &out).unwrap();
        out
    }

    /// A PRIVATE fixture directory per test.
    ///
    /// The shared `fixtures_dir` is reused across tests that run in parallel, and
    /// a fixture half-written by one of them reads back as a corrupt file in
    /// another ("moov atom not found"). Anything built fresh by a single test
    /// lives here instead, where nothing else can be mid-write in it.
    fn case_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("taroting export case {tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Read one ffprobe field off a file's first video stream.
    fn probe_field(path: &std::path::Path, entry: &str) -> String {
        let out = ffmpeg::run(
            "ffprobe",
            &[
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", entry,
                "-of", "default=nw=1:nk=1",
                path.to_str().unwrap(),
            ],
        )
        .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Decode the whole file and fail on the first decoder complaint.
    ///
    /// A container can accept a stream, exit 0 and still produce something no
    /// decoder can open — which is exactly the shape of the AVI defect below, so
    /// "ffprobe named a codec" is not enough on its own.
    fn decodes_cleanly(path: &std::path::Path) -> std::result::Result<(), String> {
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args([
                "-hide_banner", "-loglevel", "error",
                "-i", path.to_str().unwrap(),
                "-f", "null", "-",
            ])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() && stderr.is_empty() {
            Ok(())
        } else {
            Err(format!("exit={:?} stderr={stderr}", out.status.code()))
        }
    }

    /* -------- reading rotation out of real pixels -------- */

    /// A 640x360 source whose four quadrants are four different colours.
    ///
    /// ASYMMETRIC BY CONSTRUCTION, and that is the entire point. Every earlier
    /// rotation test measured a bounding box, and a box cannot tell a correct
    /// quarter turn from one the wrong way round — both come out 360x640. Four
    /// distinct quadrants give each of the four orientations (none, 90, 180,
    /// 270) a DIFFERENT corner layout, so the assertion names a direction.
    fn quad_fixture(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let src = dir.join(name);
        let quad = |c: &str| format!("color={c}:s=320x180:r=30:d=1");
        ffmpeg_ok(&[
            "-y",
            "-f", "lavfi", "-i", &quad("red"),
            "-f", "lavfi", "-i", &quad("lime"),
            "-f", "lavfi", "-i", &quad("blue"),
            "-f", "lavfi", "-i", &quad("white"),
            "-filter_complex", "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack,format=yuv420p",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "5",
            src.to_str().unwrap(),
        ]);
        src
    }

    /// Name the colour at the centre of each quadrant of a decoded frame, in
    /// the order [top-left, top-right, bottom-left, bottom-right].
    ///
    /// Patches are averaged well inside each quadrant so neither the export's
    /// rescale nor yuv420p's chroma subsampling at the seams can reach them,
    /// and the four references are chosen to survive a lossy encode: which
    /// channels are high is unambiguous for all of red/green/blue/white.
    fn corner_colors(path: &std::path::Path, t: f64) -> [String; 4] {
        let w: u32 = probe_field(path, "stream=width").parse().unwrap();
        let h: u32 = probe_field(path, "stream=height").parse().unwrap();
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args([
                "-hide_banner", "-loglevel", "error",
                "-ss", &format!("{t:.3}"),
                "-i", path.to_str().unwrap(),
                "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ])
            .output()
            .unwrap();
        let px = out.stdout;
        assert_eq!(
            px.len(),
            (w as usize) * (h as usize) * 3,
            "expected one {w}x{h} rgb24 frame from {}",
            path.display()
        );

        let name_at = |cx: u32, cy: u32| -> String {
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in cy.saturating_sub(4)..(cy + 4).min(h) {
                for x in cx.saturating_sub(4)..(cx + 4).min(w) {
                    let i = ((y as usize) * (w as usize) + x as usize) * 3;
                    r += px[i] as u32;
                    g += px[i + 1] as u32;
                    b += px[i + 2] as u32;
                    n += 1;
                }
            }
            let (r, g, b) = (r / n, g / n, b / n);
            match (r >= 128, g >= 128, b >= 128) {
                (true, true, true) => "white".into(),
                (true, false, false) => "red".into(),
                (false, true, false) => "green".into(),
                (false, false, true) => "blue".into(),
                _ => format!("rgb({r},{g},{b})"),
            }
        };
        [
            name_at(w / 4, h / 4),
            name_at(3 * w / 4, h / 4),
            name_at(w / 4, 3 * h / 4),
            name_at(3 * w / 4, 3 * h / 4),
        ]
    }

    /// Is this encoder usable on THIS machine? A real short encode, because
    /// `-encoders` lists everything ffmpeg was built with, present hardware or
    /// not.
    fn encoder_available(enc_name: &str) -> bool {
        ffmpeg::command("ffmpeg")
            .unwrap()
            .args([
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=duration=0.2:size=320x180:rate=30",
                "-frames:v", "5",
                "-c:v", enc_name,
                "-f", "null", "-",
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// A small solid-color generated media (kind image, generator=solid).
    fn solid_media(id: &str, color: &str) -> MediaRef {
        MediaRef {
            id: id.into(), path: "solid".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(640), height: Some(360),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Solid { color: color.into() }),
        }
    }

    /* -------- (1) two-layer composite -------- */

    #[test]
    fn e2e_two_layer_composite_overlay_window() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);

        // bottom: 6s testsrc2 (two 3s fixture clips concatenated).
        let bottom = vtrack(
            "vbot",
            vec![clip_at("b1", "m1", 0.0, 0.0, 3.0), clip_at("b2", "m1", 3.0, 0.0, 3.0)],
        );
        // top: a WHITE solid (unambiguously distinct from testsrc2) windowed at
        // [2,4), centered at half canvas via scale 0.5.
        let white = solid_media("white", "#ffffff");
        let mut top_clip = clip_at("t1", "white", 2.0, 0.0, 2.0);
        top_clip.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 0.5, x: 0.0, y: 0.0, opacity: 1.0,
        });
        let top = vtrack("vtop", vec![top_clip]);
        // tracks[0] topmost, last = bottom.
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![top, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![media, white], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("composite.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "composite.mp4");

        assert!((probe_dur(&out) - 6.0).abs() < 0.15, "dur {}", probe_dur(&out));
        // center 120x120 region: at t=3 the white overlay is present (bright),
        // at t=5 the overlay window has closed → testsrc2 shows through.
        let center = |t: f64| yavg(&out, t, 260, 120, 120, 120);
        let inside = center(3.0);
        let outside = center(5.0);
        assert!(inside > 200.0, "white overlay should be bright at t=3: {inside}");
        assert!(
            inside - outside > 40.0,
            "overlay presence should raise center YAVG: t3={inside} t5={outside}"
        );
    }

    /* -------- (2) animated position -------- */

    #[test]
    fn e2e_animated_position_displaces_box() {
        let dir = fixtures_dir();
        // solid red box on a black-ish base: bottom black-ish (use a solid dark),
        // top a small red solid clip that pans left→right over 4s.
        let base = solid_media("base", "#202020");
        let box_media = solid_media("box", "#ff0000");
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 4.0)]);
        let mut top = clip_at("t1", "box", 0.0, 0.0, 4.0);
        top.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 0.15, x: 0.0, y: 0.0, opacity: 1.0,
        });
        top.keyframes = Some(ClipKeyframes {
            x: Some(vec![Keyframe { t: 0.0, v: -200.0 }, Keyframe { t: 4.0, v: 200.0 }]),
            y: None, scale: None, opacity: None,
        });
        let toptrack = vtrack("vtop", vec![top]);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![toptrack, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, box_media], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("animpos.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "animpos.mp4");

        // At t=0 the box sits left-of-center (x=-200); at t=4 right-of-center
        // (x=+200). Probe a left strip and a right strip: redness (high YAVG on a
        // red region relative to dark base) swaps sides.
        let left = |t: f64| yavg(&out, t, 40, 140, 80, 80);
        let right = |t: f64| yavg(&out, t, 520, 140, 80, 80);
        // early: box on the left → left brighter than right.
        assert!(left(0.1) > right(0.1) + 3.0, "t0 left={} right={}", left(0.1), right(0.1));
        // late: box on the right → right brighter than left.
        assert!(right(3.9) > left(3.9) + 3.0, "t4 left={} right={}", left(3.9), right(3.9));
    }

    /* -------- (3) animated opacity -------- */

    #[test]
    fn e2e_animated_opacity_alpha_ramp() {
        let dir = fixtures_dir();
        // bottom black, top white full-frame ramping opacity 0.2 → 1.0 over 4s.
        let base = solid_media("base", "#000000");
        let white = solid_media("white", "#ffffff");
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 4.0)]);
        let mut top = clip_at("t1", "white", 0.0, 0.0, 4.0);
        top.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 0.2 }, Keyframe { t: 4.0, v: 1.0 }]),
        });
        let toptrack = vtrack("vtop", vec![top]);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![toptrack, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, white], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("animop.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "animop.mp4");

        // white-over-black composited luma tracks opacity: ~20% early, ~100% late.
        let early = yavg(&out, 0.1, 280, 140, 80, 80);
        let late = yavg(&out, 3.9, 280, 140, 80, 80);
        assert!(early < 120.0, "early alpha should be dim: {early}");
        assert!(late > 180.0, "late alpha should be bright: {late}");
        assert!(late - early > 60.0, "alpha ramp should brighten: {early} -> {late}");
    }

    /* -------- (4) text over solid -------- */

    #[test]
    fn e2e_text_over_solid_renders() {
        let dir = fixtures_dir();
        // bottom: a black solid. top: white text on transparent, centered.
        //
        // The text media is a REALISTIC measured box (560x120 for one 96px
        // line) and differs from the 640x360 canvas on BOTH axes on purpose:
        // the old fixture declared 640x360, and identical numbers turned this
        // test into a no-op that hid a real size-mismatch bug (issue #1).
        let base = solid_media("base", "#000000");
        let text = MediaRef {
            id: "txt".into(), path: "Text".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(560), height: Some(120),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Text {
                text: "TAROTING 100%".into(),
                font_family: "Arial".into(),
                size_px: 96.0,
                color: "#ffffff".into(),
                bold: true,
                italic: false,
            }),
        };
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 2.0)]);
        let toptrack = vtrack("vtop", vec![clip_at("t1", "txt", 0.0, 0.0, 2.0)]);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![toptrack, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, text], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("textsolid.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "textsolid.mp4");

        // The 560x120 text box is centred on the 640x360 canvas, and drawtext
        // centres the glyphs vertically inside it (text_align=L+M, mirroring
        // the DOM's half-leading). So the glyphs land in the middle band, not
        // at the top-left. Both bands are asserted so the test still pins
        // GEOMETRY rather than merely "something rendered".
        let text_band = yavg(&out, 1.0, 0, 130, 640, 100);
        let empty_band = yavg(&out, 1.0, 0, 300, 640, 55);
        let top_band = yavg(&out, 1.0, 0, 0, 640, 100);
        assert!(empty_band < 20.0, "band below the text box should be dark: {empty_band}");
        assert!(top_band < 20.0, "band above the text box should be dark: {top_band}");
        assert!(
            text_band - empty_band > 5.0,
            "text band should be brighter than empty: text={text_band} empty={empty_band}"
        );
    }

    #[test]
    fn export_two_clips_with_gap_h264_software() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);

        // clip A [0.5..1.5] at timeline 0; gap 0.5s; clip B [2.0..3.0] at 1.5
        let a = Clip {
            id: "a".into(), media_id: "m1".into(), timeline_start: 0.0,
            src_in: 0.5, src_out: 1.5, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let b = Clip {
            id: "b".into(), media_id: "m1".into(), timeline_start: 1.5,
            src_in: 2.0, src_out: 3.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![a, b],
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360, tracks: vec![track],
            markers: vec![],
        };
        let preset = ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 640, h: 360 },
            fps: FpsPreset::Custom(30.0),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        };
        let out = dir.join("two clip out.mp4");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec {
            media: vec![media], timeline: tl, preset, out_path: out_s.clone(),
        };

        let built = builder::build(&spec, &enc()).unwrap();
        // total timeline duration = 1.5 (A) + 0.5 gap? no: A dur 1s @0, gap 0.5, B 1s @1.5 → end 2.5
        assert!((built.duration_sec - 2.5).abs() < 1e-6, "dur {}", built.duration_sec);

        let part = dir.join("two clip out.mp4.part");
        run_built(&built, &out_s, &part);
        std::fs::rename(&part, &out).unwrap();

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert_eq!(info.width, Some(640));
        assert_eq!(info.height, Some(360));
        assert!((info.duration - 2.5).abs() < 0.2, "duration {}", info.duration);
        assert!(info.has_audio);
        assert_eq!(info.acodec.as_deref(), Some("aac"));
    }

    #[test]
    fn export_gif_slice() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);
        let c = Clip {
            id: "c".into(), media_id: "m1".into(), timeline_start: 0.0,
            src_in: 0.0, src_out: 1.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![c],
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360, tracks: vec![track],
            markers: vec![],
        };
        let preset = ExportPreset {
            format: "gif".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 320, h: 180 },
            fps: FpsPreset::Custom(15.0),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        };
        let out = dir.join("slice out.gif");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec { media: vec![media], timeline: tl, preset, out_path: out_s.clone() };
        let built = builder::build(&spec, &enc()).unwrap();
        let part = dir.join("slice out.gif.part");
        run_built(&built, &out_s, &part);
        std::fs::rename(&part, &out).unwrap();

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "gif");
        assert!(!info.has_audio);
    }

    /* -------- (5) the opacity mask at an extreme source width -------- */

    /// The alpha mask is seeded at 16x16 and enlarged to the clip's post-crop
    /// size. swscale's graph builder refuses a single pass beyond ~6890x on an
    /// axis, so from that seed anything past ~110,240 px wide aborted the whole
    /// export with "Failed initializing scaling graph (Not yet implemented in
    /// FFmpeg, patches welcome)" — no frames, no useful message.
    ///
    /// 131056x120 is an authorable source, not a contrivance: a text
    /// generator's box is `measureText`'s natural width and nothing caps it, so
    /// one long unbroken pasted line gets there. The opacity KEYFRAME is what
    /// emits the mask at all — the identical project with static opacity takes
    /// the `colorchannelmixer` path and exports fine, which is why this hid.
    #[test]
    fn e2e_animated_opacity_survives_a_source_wider_than_one_swscale_pass() {
        let dir = case_dir("maskwidth");
        let mut wide = solid_media("wide", "#2080ff");
        wide.width = Some(131_056);
        wide.height = Some(120);

        let mut c = clip_at("c1", "wide", 0.0, 0.0, 0.2);
        c.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![
                Keyframe { t: 0.0, v: 1.0 },
                Keyframe { t: 0.2, v: 0.25 },
            ]),
        });
        // Canvas, source and output all differ on both axes.
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 1280, height: 720,
            tracks: vec![vtrack("v", vec![c])], markers: vec![],
        };
        let preset = ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 1920, h: 1080 },
            fps: FpsPreset::Custom(30.0),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        };
        let spec = ExportSpec {
            media: vec![wide], timeline: tl, preset,
            out_path: dir.join("widemask.mp4").to_string_lossy().into_owned(),
        };
        // `encode` asserts ffmpeg exited 0 — with a single-pass mask it does not.
        let out = encode(&spec, &dir, "widemask.mp4");

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.width, Some(1920));
        assert_eq!(info.height, Some(1080));
        // 131056:120 fits to a 1920x2 strip centred at y=539. It must actually
        // carry the colour: `alphamerge` REPLACING the alpha instead of
        // multiplying it would leave a black band here even though ffmpeg
        // exited 0.
        let strip = yavg(&out, 0.05, 0, 539, 1920, 2);
        assert!(strip > 20.0, "the fitted strip should be lit, got YAVG {strip}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (6) AVI must not hand back an undecodable stream -------- */

    /// Every codec the dialog still OFFERS for AVI must come back as the codec
    /// that was asked for, and must decode.
    ///
    /// The defect this pins: AVI + HEVC exits 0 and writes a NULL fourcc, which
    /// ffprobe reads back as `rawvideo` and no decoder can open. HEVC was
    /// removed from the offered list (a frontend list a Rust test cannot see),
    /// but nothing asserted the PROPERTY — so the next codec added to a
    /// container would be exposed to exactly the same trap. This is that
    /// assertion, and it is deliberately about the file, not the list.
    #[test]
    fn e2e_avi_writes_a_stream_that_decodes_back_as_the_codec_asked_for() {
        let dir = case_dir("avi");
        let (_src, media) = fixture_media(&dir);

        for vcodec in ["h264", "av1"] {
            let c = clip_at("c1", "m1", 0.0, 0.0, 1.0);
            let tl = Timeline {
                fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
                tracks: vec![vtrack("v", vec![c])], markers: vec![],
            };
            let preset = ExportPreset {
                format: "avi".into(), vcodec: vcodec.into(),
                resolution: ResolutionPreset::Custom { w: 320, h: 180 },
                fps: FpsPreset::Custom(15.0),
                video_bitrate: BitratePreset::Auto(AutoTag::Auto),
                audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
                use_hardware: false,
            };
            let name = format!("avi-{vcodec}.avi");
            let spec = ExportSpec {
                media: vec![media.clone()], timeline: tl, preset,
                out_path: dir.join(&name).to_string_lossy().into_owned(),
            };
            let out = encode(&spec, &dir, &name);

            let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
            assert_eq!(
                info.vcodec.as_deref(),
                Some(vcodec),
                "avi+{vcodec} came back as {:?}",
                info.vcodec
            );
            assert_ne!(
                info.vcodec.as_deref(),
                Some("rawvideo"),
                "avi+{vcodec}: a null fourcc reads back as rawvideo"
            );
            // The mechanism underneath: AVI identifies the stream by fourcc, and
            // the failure mode was an empty one.
            let tag = probe_field(&out, "stream=codec_tag_string");
            assert_ne!(tag, "[0][0][0][0]", "avi+{vcodec} wrote a null fourcc");
            assert!(!tag.is_empty(), "avi+{vcodec} wrote no fourcc at all");
            // And the whole file must decode, not merely be labelled.
            decodes_cleanly(&out)
                .unwrap_or_else(|e| panic!("avi+{vcodec} does not decode: {e}"));
            // AVI carries mp3 audio here — the container has to survive that too.
            assert!(info.has_audio, "avi+{vcodec} lost its audio track");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (7) rotation DIRECTION, read from pixels -------- */

    /// Each rotation must land each colour in a specific corner.
    ///
    /// A bounding box cannot distinguish these: 90 and 270 produce a frame of
    /// identical extent, and so do 0 and 180. Only the corner layout separates
    /// all four, which is why the fixture is four different colours and the
    /// expectations below are corner NAMES.
    ///
    /// Read them as a quarter turn of the source [red, green / blue, white]:
    /// clockwise (90) sends the top-left to the top-right; counter-clockwise
    /// (270) sends it to the bottom-left.
    #[test]
    fn e2e_clip_rotation_lands_every_corner_in_the_right_place() {
        let dir = case_dir("rotate");
        let src = quad_fixture(&dir, "quad.mp4");
        let info = probe::probe_sync(src.to_str().unwrap()).unwrap();
        let media = MediaRef {
            id: "m1".into(), path: src.to_string_lossy().into_owned(),
            size: info.size, mtime_ms: info.mtime_ms, kind: "video".into(),
            duration: info.duration, fps: Some(Rational { num: 30, den: 1 }),
            width: Some(640), height: Some(360),
            container: info.container.clone(), vcodec: info.vcodec.clone(),
            acodec: None, pix_fmt: info.pix_fmt.clone(), bit_depth: Some(8),
            has_audio: false, audio_rate: None, audio_channels: None, generator: None,
        };

        // [top-left, top-right, bottom-left, bottom-right]
        let cases: [(u32, (u32, u32), [&str; 4]); 4] = [
            (0, (480, 270), ["red", "green", "blue", "white"]),
            (90, (270, 480), ["blue", "red", "white", "green"]),
            (180, (480, 270), ["white", "blue", "green", "red"]),
            (270, (270, 480), ["green", "white", "red", "blue"]),
        ];
        for (rotate, (ow, oh), want) in cases {
            let mut c = clip_at("c1", "m1", 0.0, 0.0, 1.0);
            c.transform = Some(ClipTransform {
                crop: None, rotate, flip_h: false, flip_v: false,
                scale: 1.0, x: 0.0, y: 0.0, opacity: 1.0,
            });
            // Canvas differs from the source AND from every output, so nothing
            // here can coincide its way to a pass.
            let tl = Timeline {
                fps: Rational { num: 30, den: 1 }, width: 1600, height: 900,
                tracks: vec![vtrack("v", vec![c])], markers: vec![],
            };
            let preset = ExportPreset {
                format: "mp4".into(), vcodec: "h264".into(),
                resolution: ResolutionPreset::Custom { w: ow, h: oh },
                fps: FpsPreset::Custom(30.0),
                video_bitrate: BitratePreset::Auto(AutoTag::Auto),
                audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
                use_hardware: false,
            };
            let name = format!("rot{rotate}.mp4");
            let spec = ExportSpec {
                media: vec![media.clone()], timeline: tl, preset,
                out_path: dir.join(&name).to_string_lossy().into_owned(),
            };
            let out = encode(&spec, &dir, &name);

            let probed = probe::probe_sync(out.to_str().unwrap()).unwrap();
            assert_eq!(
                (probed.width, probed.height),
                (Some(ow), Some(oh)),
                "rotate {rotate}: exported extent"
            );
            let got = corner_colors(&out, 0.5);
            assert_eq!(
                got.iter().map(String::as_str).collect::<Vec<_>>(),
                want.to_vec(),
                "rotate {rotate}: corners are [TL, TR, BL, BR]"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other rotation a real recording carries: a Display Matrix in the
    /// container, which is how every phone stores portrait footage.
    ///
    /// ffmpeg autorotates on decode, so the frames reaching the filtergraph are
    /// already turned and `media.width/height` must be the DISPLAY size — the
    /// pairing `project::schema::ROTATION_REPAIR_SCHEMA` exists to repair. This
    /// asserts the turn actually reaches the exported pixels, and in which
    /// direction: ffprobe reports this matrix as rotation=90 and the decoder
    /// applies a quarter turn COUNTER-clockwise.
    #[test]
    fn e2e_container_rotation_metadata_reaches_the_exported_pixels() {
        let dir = case_dir("rotmeta");
        let flat = quad_fixture(&dir, "quad.mp4");
        let rotated = dir.join("quad-r90.mp4");
        ffmpeg_ok(&[
            "-y",
            "-display_rotation:v:0", "90",
            "-i", flat.to_str().unwrap(),
            "-c", "copy",
            rotated.to_str().unwrap(),
        ]);

        // Fixture guards. Without these the assertion below could pass on a
        // fixture that was simply PAINTED rotated.
        assert_eq!(
            probe_field(&rotated, "stream_side_data=rotation"),
            "90",
            "the fixture must carry a real Display Matrix"
        );
        assert_eq!(
            (
                probe_field(&rotated, "stream=width"),
                probe_field(&rotated, "stream=height"),
            ),
            ("640".to_string(), "360".to_string()),
            "the CODED frame must still be the landscape one"
        );

        // probe_sync is rotation-aware: this is the size a MediaRef records, and
        // the size the preview's <video> element reports.
        let info = probe::probe_sync(rotated.to_str().unwrap()).unwrap();
        assert_eq!(
            (info.width, info.height),
            (Some(360), Some(640)),
            "a quarter-turn recording must be recorded at its DISPLAY size"
        );

        let media = MediaRef {
            id: "m1".into(), path: rotated.to_string_lossy().into_owned(),
            size: info.size, mtime_ms: info.mtime_ms, kind: "video".into(),
            duration: info.duration, fps: Some(Rational { num: 30, den: 1 }),
            width: info.width, height: info.height,
            container: info.container.clone(), vcodec: info.vcodec.clone(),
            acodec: None, pix_fmt: info.pix_fmt.clone(), bit_depth: Some(8),
            has_audio: false, audio_rate: None, audio_channels: None, generator: None,
        };
        // No clip transform at all: every degree of turn here comes from the file.
        let c = clip_at("c1", "m1", 0.0, 0.0, 1.0);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 1600, height: 900,
            tracks: vec![vtrack("v", vec![c])], markers: vec![],
        };
        let preset = ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 270, h: 480 },
            fps: FpsPreset::Custom(30.0),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        };
        let spec = ExportSpec {
            media: vec![media], timeline: tl, preset,
            out_path: dir.join("meta.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "meta.mp4");

        let got = corner_colors(&out, 0.5);
        assert_eq!(
            got.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["green", "white", "red", "blue"],
            "a rotation=90 Display Matrix is a quarter turn counter-clockwise"
        );
        // Named separately so a no-op autorotation reads as what it is rather
        // than as some other mistake.
        assert_ne!(
            got[0], "red",
            "top-left is still the CODED top-left: the rotation was dropped"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (8) hardware-encoder geometry -------- */

    /// Every geometry number this project has ever measured came out of
    /// libx264. NVENC/QSV/AMF share the whole filtergraph and differ only in
    /// codec args, but "should be identical" is not a measurement — so each
    /// encoder this machine can actually run is put through the same export and
    /// its output size probed.
    ///
    /// libx264 is a row here too, deliberately: it makes the test assert
    /// something real on a machine with no hardware encoder at all, instead of
    /// skipping into a silent pass.
    #[test]
    fn e2e_available_encoders_all_honour_the_export_resolution() {
        let dir = case_dir("hwgeom");
        let (_src, media) = fixture_media(&dir);

        // (encoder, preset vcodec, ffprobe codec_name, hardware?)
        let candidates: [(&str, &str, &str, bool); 10] = [
            ("libx264", "h264", "h264", false),
            ("libx265", "hevc", "hevc", false),
            ("h264_nvenc", "h264", "h264", true),
            ("h264_qsv", "h264", "h264", true),
            ("h264_amf", "h264", "h264", true),
            ("hevc_nvenc", "hevc", "hevc", true),
            ("hevc_qsv", "hevc", "hevc", true),
            ("hevc_amf", "hevc", "hevc", true),
            ("av1_nvenc", "av1", "av1", true),
            ("av1_qsv", "av1", "av1", true),
        ];

        let mut ran: Vec<&str> = Vec::new();
        let mut skipped: Vec<&str> = Vec::new();
        for (enc_name, vcodec, want_codec, hardware) in candidates {
            if !encoder_available(enc_name) {
                skipped.push(enc_name);
                continue;
            }
            let report = crate::hw::EncoderReport {
                h264: enc_name.into(),
                hevc: enc_name.into(),
                av1: enc_name.into(),
                detail: vec![],
            };
            let c = clip_at("c1", "m1", 0.0, 0.0, 1.0);
            // Source 640x360, canvas 1280x720, output 480x270: three different
            // sizes, so an encoder that quietly kept the source or the canvas
            // size is visible rather than coincidentally right.
            let tl = Timeline {
                fps: Rational { num: 30, den: 1 }, width: 1280, height: 720,
                tracks: vec![vtrack("v", vec![c])], markers: vec![],
            };
            let preset = ExportPreset {
                format: "mp4".into(), vcodec: vcodec.into(),
                resolution: ResolutionPreset::Custom { w: 480, h: 270 },
                fps: FpsPreset::Custom(30.0),
                video_bitrate: BitratePreset::Auto(AutoTag::Auto),
                audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
                use_hardware: hardware,
            };
            let name = format!("{enc_name}.mp4");
            let spec = ExportSpec {
                media: vec![media.clone()], timeline: tl, preset,
                out_path: dir.join(&name).to_string_lossy().into_owned(),
            };
            // Without this the whole row could quietly run on libx264 — ffprobe
            // reports "h264" for every h264 encoder alive, so the file cannot
            // tell us which one made it.
            let argv: Vec<String> = builder::build(&spec, &report)
                .unwrap()
                .args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert!(
                argv.windows(2).any(|w| w[0] == "-c:v" && w[1] == enc_name),
                "{enc_name} was not the encoder actually selected: {argv:?}"
            );
            let out = encode_with(&spec, &dir, &name, &report);

            let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
            assert_eq!(
                (info.width, info.height),
                (Some(480), Some(270)),
                "{enc_name}: exported at the wrong size"
            );
            assert_eq!(
                info.vcodec.as_deref(),
                Some(want_codec),
                "{enc_name}: wrong codec in the file"
            );
            assert!((info.duration - 1.0).abs() < 0.25, "{enc_name}: duration {}", info.duration);
            decodes_cleanly(&out)
                .unwrap_or_else(|e| panic!("{enc_name} output does not decode: {e}"));
            let _ = std::fs::remove_file(&out);
            ran.push(enc_name);
        }

        println!("encoder geometry — ran {ran:?}; unavailable on this machine {skipped:?}");
        assert!(
            ran.contains(&"libx264"),
            "the software control row must always run; ran {ran:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_bitrate_estimate_is_exact() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);
        let c = Clip {
            id: "c".into(), media_id: "m1".into(), timeline_start: 0.0,
            src_in: 0.0, src_out: 10.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![c],
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360, tracks: vec![track],
            markers: vec![],
        };
        let preset = ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Named("original".into()),
            fps: FpsPreset::Original("original".into()),
            video_bitrate: BitratePreset::Kbps(4000),
            audio_bitrate: BitratePreset::Kbps(160),
            use_hardware: false,
        };
        let spec = ExportSpec { media: vec![media], timeline: tl, preset, out_path: r"C:\o.mp4".into() };
        let est = estimate::estimate(&spec);
        assert!(est.exact);
        // (4000+160)*1000/8*10 = 5,200,000
        assert_eq!(est.bytes, 5_200_000);
    }
}
