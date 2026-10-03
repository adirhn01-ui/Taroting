//! Export engine: turn an `ExportSpec` into ffmpeg invocations on the export
//! lane (one; two for a GIF, whose palette is its own pass), streaming
//! progress and atomically publishing the result.

pub mod builder;
pub mod estimate;
pub mod model;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use xxhash_rust::xxh3::xxh3_64;

use crate::error::{AppError, Result};
use crate::hw;
use crate::jobs::{self, JobFailure, JobId, JobKind, Jobs, Lane};
use crate::project::schema::MediaRef;
use crate::project::store::PathIdentity;

use self::builder::{BuiltExport, FILTER_PLACEHOLDER, PALETTE_PLACEHOLDER};
use self::model::ExportSpec;

/// Filtergraphs longer than this are written to a script file and passed via
/// `-/filter_complex <file>` to avoid command-line length limits.
const INLINE_FILTER_LIMIT: usize = 8000;

/// Temp files of one export attempt, deleted in every exit path (success,
/// failure, cancel): the filtergraph scripts, the drawtext textfiles and a
/// GIF's palette.
struct ExportTemps {
    files: Vec<PathBuf>,
}

impl ExportTemps {
    fn cleanup(&self) {
        for f in &self.files {
            let _ = std::fs::remove_file(f);
        }
    }
}

/// An export attempt with every argv spliced and every temp file named, but
/// nothing written yet: `compose` is pure apart from reading the sidecar's
/// path, so everything that can refuse an export (the command-line length
/// above all) runs before a single byte reaches the disk.
struct Plan {
    /// A GIF's palette pass, run first; `None` for every other format.
    palette_args: Option<Vec<OsString>>,
    /// The encode, writing `<out>.part`.
    args: Vec<OsString>,
    /// The encode's graph as spliced, for the failure report.
    filter_complex: String,
    duration_sec: f64,
    /// The video encoder (`None` for a GIF): whether a failure ran on hardware.
    encoder: Option<String>,
    /// `(path, contents)` to write before the first run.
    writes: Vec<(PathBuf, String)>,
    /// Everything to delete afterwards: the writes, plus the palette the
    /// first pass creates.
    temps: Vec<PathBuf>,
}

impl Plan {
    /// Write the textfiles and scripts. A failure removes what was written.
    fn materialize(&self) -> Result<ExportTemps> {
        let temps = ExportTemps { files: self.temps.clone() };
        for (path, contents) in &self.writes {
            if let Err(e) = std::fs::write(path, contents.as_bytes()) {
                temps.cleanup();
                return Err(e.into());
            }
        }
        Ok(temps)
    }
}

/// Splice a built export into runnable argv: text payloads named, the graph
/// placed inline or into a script, the palette named, the output pointed at
/// `<out>.part`.
///
/// Every name that appears INSIDE a filtergraph is a bare file name in `temp`
/// (`taroting-text-<hash>-<i>.txt`), and ffmpeg runs with `temp` as its
/// working folder, so it resolves there. A full `%TEMP%` path inside the graph
/// is what made text export impossible for a profile like `O'Brien`: ffmpeg's
/// filter syntax has no escape for an apostrophe inside a quoted value. The
/// bare name has nothing to escape, and since `plan_export` refuses relative
/// media and destination paths, nothing else can resolve against that folder.
/// The script paths are separate argv entries and need no escaping, so they
/// stay absolute.
///
/// The text substitution happens BEFORE deciding inline-vs-script, so the
/// composed graph is what the length check measures. In script mode the
/// preceding `-filter_complex` becomes `-/filter_complex` (the "read this
/// option's value from a file" form; `-filter_complex_script` is deprecated
/// in ffmpeg 8).
fn compose(built: &BuiltExport, out_path: &str, temp: &Path) -> Result<Plan> {
    let hash = xxh3_64(out_path.as_bytes());
    let mut writes: Vec<(PathBuf, String)> = Vec::new();

    let mut text_names: Vec<(String, String)> = Vec::new();
    for (i, (placeholder, content)) in built.text_payloads.iter().enumerate() {
        let name = format!("taroting-text-{hash:016x}-{i}.txt");
        writes.push((temp.join(&name), content.clone()));
        // The placeholder was embedded escaped-quoted (`'…'`); the bare name
        // goes in through the same escaper, so the two never drift apart.
        text_names.push((format!("'{placeholder}'"), builder::escape_filter_value(&name)));
    }
    let substitute = |graph: &str| {
        let mut g = graph.to_string();
        for (placeholder, name) in &text_names {
            g = g.replace(placeholder, name);
        }
        g
    };

    let palette = format!("taroting-palette-{hash:016x}.png");
    let mut temps: Vec<PathBuf> = Vec::new();

    // One argv, its graph spliced in (inline or as a script `tag`ged so the
    // two passes of a GIF never share a script file).
    let splice = |args: &[OsString], graph: &str, tag: &str, writes: &mut Vec<(PathBuf, String)>| -> Result<Vec<OsString>> {
        let mut args: Vec<OsString> = args
            .iter()
            .map(|a| if a == PALETTE_PLACEHOLDER { OsString::from(&palette) } else { a.clone() })
            .collect();
        let pos = args
            .iter()
            .position(|a| a == FILTER_PLACEHOLDER)
            .filter(|&p| p > 0)
            .ok_or_else(|| AppError::Ffmpeg("filter placeholder missing from args".into()))?;
        let graph = substitute(graph);
        if graph.len() > INLINE_FILTER_LIMIT {
            let script = temp.join(format!("taroting-filter-{hash:016x}{tag}.txt"));
            args[pos - 1] = OsString::from("-/filter_complex");
            args[pos] = OsString::from(&script);
            writes.push((script, graph));
        } else {
            args[pos] = OsString::from(&graph);
        }
        Ok(args)
    };

    let palette_args = match &built.palette_pass {
        Some(p) => Some(splice(&p.args, &p.filter_complex, "-palette", &mut writes)?),
        None => None,
    };
    let mut args = splice(&built.args, &built.filter_complex, "", &mut writes)?;
    // ffmpeg writes to "<out>.part"; the container is preserved because -f is
    // set from the format, not inferred from the extension.
    let last = args.len() - 1;
    args[last] = OsString::from(format!("{out_path}.part"));

    for a in palette_args.iter().chain(std::iter::once(&args)) {
        refuse_overlong_command(a)?;
    }

    temps.extend(writes.iter().map(|(p, _)| p.clone()));
    if palette_args.is_some() {
        temps.push(temp.join(&palette));
    }
    Ok(Plan {
        palette_args,
        args,
        filter_complex: substitute(&built.filter_complex),
        duration_sec: built.duration_sec,
        encoder: built.encoder.clone(),
        writes,
        temps,
    })
}

/// The longest command line `CreateProcessW` accepts is 32,767 UTF-16 units,
/// terminator included. A little is kept back for anything std adds.
const MAX_COMMAND_LINE: usize = 32_000;

/// Refuse an argv that would not fit on a Windows command line.
///
/// Every video clip adds `-ss … -to … -protocol_whitelist file -i <path>` and
/// every audible clip a second input of the same shape, so a long edit (around
/// 150-230 audible clips, fewer on long paths) passes the limit even with the
/// graph in a script file, and the spawn failed with a bare OS error. The
/// length is measured the way std quotes each argument (see
/// `windows_arg_len`), so the check refuses exactly what would not start.
fn refuse_overlong_command(args: &[OsString]) -> Result<()> {
    let program = crate::jobs::ffmpeg::sidecar_path("ffmpeg")
        .map(|p| windows_arg_len(p.as_os_str()))
        .unwrap_or(260);
    let total = program + args.iter().map(|a| windows_arg_len(a) + 1).sum::<usize>();
    if total > MAX_COMMAND_LINE {
        let inputs = args.iter().filter(|a| *a == "-i").count();
        return Err(AppError::BadInput(format!(
            "This project has too many clips to export in one pass ({inputs} inputs). \
             Try exporting it in parts."
        )));
    }
    Ok(())
}

/// The UTF-16 length one argument takes on a Windows command line, quoted
/// the way std quotes it: wrapped in quotes when it is empty or holds a space
/// or a tab, every `"` escaped with a backslash, and the backslashes before a
/// `"` (or before the closing quote) doubled.
fn windows_arg_len(arg: &OsStr) -> usize {
    #[cfg(windows)]
    let units: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        arg.encode_wide().collect()
    };
    #[cfg(not(windows))]
    let units: Vec<u16> = arg.to_string_lossy().encode_utf16().collect();

    let (space, tab, quote, backslash) = (b' ' as u16, b'\t' as u16, b'"' as u16, b'\\' as u16);
    let quoted = units.is_empty() || units.iter().any(|&c| c == space || c == tab);
    let mut len = 0;
    let mut run = 0;
    for &c in &units {
        if c == backslash {
            run += 1;
        } else {
            if c == quote {
                len += run + 1;
            }
            run = 0;
        }
        len += 1;
    }
    if quoted {
        len += run + 2;
    }
    len
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

/// Refuse an export whose destination is one of the project's own source files.
///
/// Originals are never modified — and an export onto one would modify it
/// twice over: ffmpeg reads the source while `publish_export` is about to
/// rename the finished `.part` over it, and the dialog's overwrite strip had no
/// way to know that the file it offered to "Replace" was one the project reads.
/// `<out>.part` is checked as well, because ffmpeg runs with `-y` and would
/// truncate a source that happened to carry that name before reading a frame.
///
/// Identity is asked of the filesystem (`canonicalize`, the same question
/// `path_identity` asks), never of a folding rule, so "C:\Clips\A.mp4" and
/// "c:\clips\a.MP4" are caught as one file on NTFS and two names a
/// case-sensitive folder keeps apart are not confused. The destination is
/// resolved ONCE per candidate rather than once per media item: the sources
/// are the only thing that varies, and this runs on the main thread before the
/// job starts, so a project with many clips must not pay two resolutions each.
/// The mapping is `path_identity`'s: byte-equal is `Same` with no filesystem
/// call, two resolved paths are `Same` or `Different`, and either side that
/// will not resolve is `Unknown`.
///
/// `Unknown` is decided without the filesystem's word only where that is
/// safe: a destination that does not exist cannot be any file the project
/// reads (this is the normal export, and it resolves to `Unknown`, so refusing
/// there would block every export), and neither can a source that is proven
/// absent (it can't be the destination that does exist). `try_exists` rather
/// than `exists`, because only `Ok(false)` is proof; a permission error is not.
///
/// A source that EXISTS but will not resolve — or any source against a
/// destination that will not (`canonicalize` fails outright on volumes whose
/// driver lacks `GetFinalPathNameByHandleW`: some RAM disks, VirtualBox shares,
/// Dokan/FUSE drives) — falls back to the comparison the export dialog makes
/// (`comparable_path`, the backend twin of `comparablePath`). Refusing it
/// instead turned the dialog's Replace into a button that always failed on
/// such a volume, where 0.8.1 replaced the file. Only a source that cannot be
/// asked about at all (`try_exists` is `Err`) still refuses, and that refusal
/// says so ("couldn't check", e.g. an unreachable share) instead of claiming
/// an overwrite nobody proved.
fn refuse_overwriting_a_source(out_path: &str, media: &[MediaRef]) -> Result<()> {
    refuse_overwriting_a_source_with(out_path, media, |p| std::fs::canonicalize(p).ok())
}

/// Refuse an export whose source file is gone, or is not a file path at all,
/// naming it. The relink dialog is offered only when a project opens, so a
/// file moved or deleted after that reached ffmpeg, and the export failed as
/// "ffmpeg exited with ..." with the real cause buried in the log.
///
/// `sources` is `BuiltExport::sources`: the files ffmpeg will actually open,
/// not every media entry. A file only a muted clip uses is never opened, and
/// that export works today, so it is not refused.
///
/// First the SHAPE (`media::source`'s rules, the same gate every media sink
/// uses): a path from a `.trt` that is relative (it would resolve against the
/// app's own folder), a URL, a device or object-namespace path, or one with a
/// NUL in it is not a media file, whatever is or is not on disk. Shares stay
/// allowed. Then presence: only `Ok(false)` is proof the file is gone; a
/// volume that cannot answer (`Err`) is left to ffmpeg, which will open it or
/// say why. (Not `source_file` itself: its metadata read refuses that
/// unanswered case too, and its messages do not name the file.)
fn refuse_missing_sources(sources: &[OsString]) -> Result<()> {
    use crate::media::source::{is_device_path, is_file_namespace};
    // One look per FILE, in argv order (so the file named is still the first
    // one ffmpeg would open): a long edit of one clip opens it once per cut.
    let mut seen = std::collections::HashSet::with_capacity(sources.len());
    for src in sources {
        if !seen.insert(src.as_os_str()) {
            continue;
        }
        let text = src.to_string_lossy();
        let path = Path::new(src);
        let name = builder::display_name(&text);
        if text.contains('\0') || is_device_path(&text) || !path.is_absolute() || !is_file_namespace(path) {
            return Err(AppError::BadInput(format!(
                "{name} isn't a full path to a file on a drive or a share. \
                 Reopen the project to relink it, or replace it, then export."
            )));
        }
        if matches!(path.try_exists(), Ok(false)) {
            return Err(AppError::BadInput(format!(
                "{name} is missing. Reopen the project to relink it, or replace it, then export."
            )));
        }
    }
    Ok(())
}

/// Refuse a destination that is not a plain, full file path.
///
/// A relative one (`out.mp4`, and on Windows `D:out.mp4` and `\out.mp4`,
/// which name a drive or a root but still resolve against a working folder)
/// landed in the app's own folder — the install folder, or System32 — or
/// failed with a raw error. A `\\.\` or `\\?\` form names a device or the
/// whole object namespace rather than a file. A colon past the drive names
/// an alternate data stream: `C:\x\a.mp4:s.mp4` would write a stream INTO
/// `a.mp4`. The same rules as the image editor's save (`image_save.rs`), on
/// the text, because Rust calls a device path absolute too. A share
/// (`\\server\share\…`) is an ordinary destination.
fn refuse_unusable_destination(out_path: &str) -> Result<()> {
    if out_path.trim().is_empty() {
        return Err(AppError::BadInput("Choose where to save the export.".into()));
    }
    let slashed = out_path.replace('/', "\\");
    if slashed.starts_with(r"\\.\") || slashed.starts_with(r"\\?\") || slashed.starts_with(r"\??\") {
        return Err(AppError::BadInput(
            "The export can't be saved to a device path. Choose a folder on a drive or a share.".into(),
        ));
    }
    // Bytes, not chars, so a multi-byte first character cannot shift the
    // window off a boundary.
    if slashed.as_bytes().get(2..).is_some_and(|rest| rest.contains(&b':')) {
        return Err(AppError::BadInput(
            "The export location isn't a plain file path. Choose another name.".into(),
        ));
    }
    if !Path::new(out_path).is_absolute() {
        return Err(AppError::BadInput("Choose a full folder path to export to.".into()));
    }
    Ok(())
}

/// A path compared the way Windows names files: separators unified, ASCII case
/// folded — `comparablePath` in `export-dialog.ts`, rule for rule. ASCII only,
/// on purpose: NTFS folds with a far narrower table than full Unicode, so
/// "Straße" and "Straẞe" are two files there and must not read as one. The
/// fallback for a path the filesystem would not resolve, never the first
/// question.
fn comparable_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
}

/// `refuse_overwriting_a_source` with the resolver injected, so a test can
/// stand in for a volume `canonicalize` cannot resolve.
fn refuse_overwriting_a_source_with(
    out_path: &str,
    media: &[MediaRef],
    resolve: impl Fn(&std::path::Path) -> Option<std::path::PathBuf>,
) -> Result<()> {
    let out = std::path::PathBuf::from(out_path);
    let part = std::path::PathBuf::from(format!("{out_path}.part"));
    for dest in [&out, &part] {
        if matches!(dest.try_exists(), Ok(false)) {
            continue;
        }
        let real_dest = resolve(dest);
        for m in media.iter().filter(|m| m.generator.is_none()) {
            let src = std::path::Path::new(&m.path);
            let identity = if dest.as_path() == src {
                PathIdentity::Same
            } else {
                match (&real_dest, resolve(src)) {
                    (Some(d), Some(s)) if *d == s => PathIdentity::Same,
                    (Some(_), Some(_)) => PathIdentity::Different,
                    _ => PathIdentity::Unknown,
                }
            };
            let name = builder::display_name(&m.path);
            match identity {
                PathIdentity::Same => {
                    return Err(AppError::BadInput(format!(
                        "This would overwrite {name}, which this project uses. Choose another name."
                    )));
                }
                PathIdentity::Different => {}
                PathIdentity::Unknown => match src.try_exists() {
                    Ok(false) => {}
                    Ok(true) if comparable_path(dest) == comparable_path(src) => {
                        return Err(AppError::BadInput(format!(
                            "This would overwrite {name}, which this project uses. Choose another name."
                        )));
                    }
                    Ok(true) => {}
                    Err(_) => {
                        return Err(AppError::BadInput(format!(
                            "Couldn't check whether this would overwrite {name}, which this project uses. \
                             Choose another name."
                        )));
                    }
                },
            }
        }
    }
    Ok(())
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

// The redaction kinds deliberately name MORE types than the app imports (a
// failure report may quote any path ffmpeg touched), so these stay hand
// lists rather than reading media-extensions.json. They must never name
// FEWER: `redaction_kind_covers_every_importable_extension` pins every
// importable extension to its kind, so a type added to the JSON cannot
// quietly redact as "file1.xyz".
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

/// What `start_export` decides before anything touches the disk: the
/// destination must be a plain full path, then the graph, then the two
/// refusals — a destination that is one of the project's own sources, and a
/// source file that is gone (or not a full path to a file at all). One
/// function, so the tests pin the refusals the real command makes rather than
/// a copy of them.
fn plan_export(spec: &ExportSpec, encoders: &hw::EncoderReport) -> Result<BuiltExport> {
    refuse_unusable_destination(&spec.out_path)?;
    let built = builder::build(spec, encoders)?;
    refuse_overwriting_a_source(&spec.out_path, &spec.media)?;
    refuse_missing_sources(&built.sources)?;
    Ok(built)
}

/// The destination as `create_new` found it: claimed for this export.
///
/// ffmpeg runs with `-y`, so a file already called `<out>.part` (a browser
/// download in progress, someone else's work) was truncated by the first
/// frame and then deleted by the failure cleanup. Claiming the name first
/// makes it ours or refuses the export. The job's cleanup removes the claim
/// on failure or cancel, and the publish rename consumes it on success.
///
/// The file in the way is just as often the user's own: an export killed with
/// the app (a crash, Task Manager, a power cut) leaves its `.part`, and so does
/// an app closed while an export was still queued. Nothing on disk tells the
/// two apart, so the refusal says both, and says what to do.
///
/// A folder that is not there is the one OS error worth its own words (the
/// dialog's folder may have been deleted or renamed since it was chosen); any
/// other keeps the OS's text, which is the only thing that can name it.
fn claim_part(part: &Path) -> Result<()> {
    let folder = || part.parent().map(|p| p.display().to_string()).unwrap_or_default();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(part) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::BadInput(format!(
            "A file named {} is in the way. It may be left from an export that didn't finish: \
             delete it if so, or choose another name.",
            builder::display_name(&part.to_string_lossy())
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(AppError::BadInput(format!(
            "The folder {} doesn't exist. Choose another folder.",
            folder()
        ))),
        Err(e) => Err(AppError::BadInput(format!("Taroting can't write the export to {}: {e}", folder()))),
    }
}

/// An export ready to hand to the lane: its first attempt planned and its
/// temp files written, and `<out>.part` claimed.
struct Prepared {
    plan: Plan,
    temps: ExportTemps,
    part: PathBuf,
}

/// Everything `start_export` does before the job exists, in the order that
/// lets each refusal leave nothing behind: plan (pure), compose (pure, incl.
/// the command-line length), claim `<out>.part`, write the temp files.
fn prepare_export(spec: &ExportSpec, encoders: &hw::EncoderReport, temp: &Path) -> Result<Prepared> {
    let built = plan_export(spec, encoders)?;
    let plan = compose(&built, &spec.out_path, temp)?;
    let part = PathBuf::from(format!("{}.part", spec.out_path));
    claim_part(&part)?;
    match plan.materialize() {
        Ok(temps) => Ok(Prepared { plan, temps, part }),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Run one planned attempt: a GIF's palette pass, then the encode. The temp
/// files go whatever happens. `run` is the ffmpeg runner: the job system's in
/// the app, a plain sidecar spawn in the tests.
fn run_plan(
    plan: &Plan,
    temps: ExportTemps,
    run: &mut dyn FnMut(Vec<OsString>, Option<f64>) -> std::result::Result<(), JobFailure>,
) -> std::result::Result<(), JobFailure> {
    let result = (|| {
        if let Some(palette) = &plan.palette_args {
            // No ratio for this pass: ffmpeg reports no progress while the
            // palette's single frame is still pending (it is written at end
            // of stream), so the bar waits at 0 and then runs once, with the
            // encode.
            run(palette.clone(), None).map_err(|f| JobFailure {
                message: if f.message == "canceled" {
                    f.message
                } else {
                    format!("{} (while preparing the GIF's colours)", f.message)
                },
                log_tail: f.log_tail,
            })?;
        }
        run(plan.args.clone(), Some(plan.duration_sec))
    })();
    temps.cleanup();
    result
}

/// How an export job ended, with what its failure report needs.
struct Outcome {
    result: std::result::Result<(), JobFailure>,
    /// The encode was redone in software after a hardware failure.
    hw_fallback: bool,
    /// The argv and graph of the LAST attempt (the one the result is about).
    argv: Vec<String>,
    filter_complex: String,
}

/// The export job's body: the prepared attempt, and when it failed on a
/// HARDWARE encoder, the same export again in software on the same job.
///
/// A hardware encoder can pass the half-second probe and still fail a real
/// export (a driver rolled back, a GPU swapped, a size or feature the probe
/// never tried), and `encoders.json` is keyed only by the ffmpeg version, so
/// before this the same failure repeated on every export until an app update.
/// Now the encoder is forgotten (`forget`, which is `hw::invalidate`: the
/// next export re-probes) and the software encode runs at once; progress
/// restarts for it. The retry is built lazily, so an export that never fails
/// pays nothing for it. A cancel is never retried, and a software failure is
/// final.
fn run_export(
    spec: &ExportSpec,
    prepared: Prepared,
    temp: &Path,
    run: &mut dyn FnMut(Vec<OsString>, Option<f64>) -> std::result::Result<(), JobFailure>,
    canceled: &dyn Fn() -> bool,
    forget: &dyn Fn(&str),
) -> Outcome {
    let Prepared { plan, temps, .. } = prepared;
    let result = run_plan(&plan, temps, run);
    let first = Outcome {
        result,
        hw_fallback: false,
        argv: argv_snapshot(&plan.args),
        filter_complex: plan.filter_complex.clone(),
    };
    let hardware = match &plan.encoder {
        Some(enc) if spec.preset.use_hardware && !hw::is_software(enc) => enc.clone(),
        _ => return first,
    };
    if first.result.is_ok() || canceled() {
        return first;
    }
    forget(&hardware);

    let mut soft = spec.clone();
    soft.preset.use_hardware = false;
    let retry = builder::build(&soft, &hw::software_report())
        .and_then(|built| compose(&built, &soft.out_path, temp))
        .and_then(|plan| plan.materialize().map(|temps| (plan, temps)));
    match retry {
        Ok((plan, temps)) => Outcome {
            result: run_plan(&plan, temps, run),
            hw_fallback: true,
            argv: argv_snapshot(&plan.args),
            filter_complex: plan.filter_complex,
        },
        // The software plan could not even be built: report the hardware
        // failure, which is the one that actually ran.
        Err(_) => first,
    }
}

/// Start an export. Async, with everything slow on a blocking thread: a sync
/// command runs on the WebView's UI thread, and this one waits on the
/// encoder-probe lock (held by the dialog's own background detect for as long
/// as a cold probe takes — seconds of test encodes), checks every source on
/// disk (an unreachable share hangs that) and writes the temp files. The
/// window froze for all of it.
#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    spec: ExportSpec,
) -> Result<JobId> {
    let jobs = Arc::clone(&jobs);
    tauri::async_runtime::spawn_blocking(move || start_export_blocking(app, jobs, spec))
        .await
        .map_err(|e| AppError::Ffmpeg(format!("the export could not start: {e}")))?
}

fn start_export_blocking(app: AppHandle, jobs: Arc<Jobs>, spec: ExportSpec) -> Result<JobId> {
    // Only an export that asked for hardware needs to know what this machine
    // has; a software one never waits on (or starts) the probe.
    let encoders = if spec.preset.use_hardware {
        hw::detect(false).0
    } else {
        hw::software_report()
    };
    let temp = std::env::temp_dir();
    // Before the job exists: every refusal surfaces here, from the dialog's
    // own await, and leaves nothing on disk.
    let prepared = prepare_export(&spec, &encoders, &temp)?;

    let handle = jobs.allocate(JobKind::Export);
    let job_id = handle.id;
    let jobs_arc = Arc::clone(&jobs);

    jobs.submit(
        Lane::Export,
        Box::new(move || {
            // cleanup on cancel/failure targets the .part file (the claim)
            let part_path = prepared.part.clone();
            handle.set_output(part_path.clone());

            let outcome = {
                let mut run = |args: Vec<OsString>, total: Option<f64>| {
                    jobs::execute_ffmpeg(&app, &handle, args, total, Some(&temp))
                };
                run_export(&spec, prepared, &temp, &mut run, &|| handle.is_canceled(), &hw::invalidate)
            };
            let Outcome { result, hw_fallback, argv, filter_complex } = outcome;

            // Record (or clear) the diagnostic detail for `export_failure_report`.
            // Nothing is retained after a healthy export. A user-initiated
            // cancel is not a failure: it neither stores a bogus report nor
            // discards a real one the user has not copied out yet. The version
            // comes from the encoder memo when a detect ran; otherwise it is
            // read now, and only because the export failed.
            let remember = |message: &str, log_tail: &[String]| {
                if handle.is_canceled() {
                    return;
                }
                if let Some(state) = app.try_state::<LastExportFailure>() {
                    state.store(ExportFailureDetail {
                        argv: argv.clone(),
                        filter_complex: filter_complex.clone(),
                        message: message.to_string(),
                        log_tail: log_tail.to_vec(),
                        ffmpeg_version: hw::memo_version().unwrap_or_else(hw::ffmpeg_version),
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

                    let final_pb = PathBuf::from(&spec.out_path);
                    match publish_export(&part_path, &final_pb) {
                        Ok(()) => {
                            if let Some(state) = app.try_state::<LastExportFailure>() {
                                state.clear();
                            }
                            jobs::complete_job(&app, &jobs_arc, &handle, done_output(&spec.out_path, hw_fallback));
                        }
                        Err(message) => {
                            remember(&message, &[]);
                            jobs::fail_job(&app, &jobs_arc, &handle, message, Vec::new());
                        }
                    }
                }
                Err(failure) => {
                    remember(&failure.message, &failure.log_tail);
                    jobs::fail_job(&app, &jobs_arc, &handle, failure.message, failure.log_tail);
                }
            }
        }),
    );

    Ok(job_id)
}

/// The export job's done payload: `{ path }`, plus `hwFallback: true` when the
/// hardware encode failed and the file was made in software (the dialog says
/// so). The key is absent otherwise, never `false`.
fn done_output(path: &str, hw_fallback: bool) -> serde_json::Value {
    if hw_fallback {
        serde_json::json!({ "path": path, "hwFallback": true })
    } else {
        serde_json::json!({ "path": path })
    }
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

    /* -------- (1) composing the argv: temp names, script mode, length -------- */

    /// A text clip in a minimal project, built by the real builder.
    fn text_spec(out: &str, format: &str) -> (ExportSpec, crate::hw::EncoderReport) {
        use crate::export::model::*;
        use crate::project::schema::*;
        let text = MediaRef {
            id: "t".into(), path: "Text".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(300), height: Some(80),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Text {
                text: "Ab".into(), font_family: "Arial".into(), size_px: 48.0,
                color: "#000000".into(), bold: false, italic: false,
            }),
            no_autorotate: None,
        };
        let clip = Clip {
            id: "c".into(), media_id: "t".into(), timeline_start: 0.0, src_in: 0.0, src_out: 1.0,
            speed: 1.0, transform: None,
            audio: ClipAudio { volume: 1.0, muted: false, fade_in_sec: 0.0, fade_out_sec: 0.0, gain_offset_db: 0.0, detached: false },
            keyframes: None, adjust: None,
        };
        let spec = ExportSpec {
            media: vec![text],
            timeline: Timeline {
                fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
                tracks: vec![Track { id: "v".into(), kind: "video".into(), name: "V".into(), muted: false, clips: vec![clip], hidden: None }],
                markers: vec![],
            },
            preset: ExportPreset {
                format: format.into(), vcodec: "h264".into(),
                resolution: ResolutionPreset::Custom { w: 320, h: 180 },
                fps: FpsPreset::Custom(15.0),
                video_bitrate: BitratePreset::Auto(AutoTag::Auto),
                audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
                use_hardware: false,
            },
            out_path: out.into(),
        };
        (spec, crate::hw::software_report())
    }

    /// The textfile goes into the graph as a BARE name and is written into
    /// the temp folder ffmpeg will run in. With a temp folder whose path holds
    /// an apostrophe (a profile like O'Brien), the old full path could not be
    /// written into a filter value at all and every text export was refused;
    /// now no part of that folder's path is in the graph.
    #[test]
    fn a_text_file_is_named_in_the_graph_without_its_folder() {
        let temp = publish_dir("o'brien temp");
        assert!(temp.to_string_lossy().contains('\''), "premise: the temp path has an apostrophe");
        let out = temp.join("Final Cut.mp4").to_string_lossy().into_owned();
        let (spec, enc) = text_spec(&out, "mp4");
        let built = builder::build(&spec, &enc).unwrap();
        let plan = compose(&built, &out, &temp).unwrap();

        let hash = xxh3_64(out.as_bytes());
        let name = format!("taroting-text-{hash:016x}-0.txt");
        assert!(plan.filter_complex.contains(&format!("textfile='{name}':")), "{}", plan.filter_complex);
        let graph = plan.args.iter().find(|a| a.to_string_lossy().contains("drawtext")).unwrap();
        assert!(!graph.to_string_lossy().contains("o'brien"), "no folder in the graph: {graph:?}");
        assert!(!graph.to_string_lossy().contains(&builder::text_placeholder(0)), "{graph:?}");
        assert_eq!(plan.writes, [(temp.join(&name), "Ab".to_string())]);
        assert_eq!(plan.args.last().unwrap(), &OsString::from(format!("{out}.part")));

        let temps = plan.materialize().unwrap();
        assert_eq!(std::fs::read_to_string(temp.join(&name)).unwrap(), "Ab");
        temps.cleanup();
        assert!(!temp.join(&name).exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// A graph past `INLINE_FILTER_LIMIT` goes to a script passed with
    /// `-/filter_complex` (not the deprecated `-filter_complex_script`), and
    /// the script holds exactly the graph an inline export would have held.
    #[test]
    fn a_long_graph_goes_to_a_script_behind_the_file_form_of_the_option() {
        let temp = publish_dir("script mode");
        let out = temp.join("long.mp4").to_string_lossy().into_owned();
        let (mut spec, enc) = text_spec(&out, "mp4");
        let one = spec.timeline.tracks[0].clips[0].clone();
        spec.timeline.tracks[0].clips = (0..60)
            .map(|i| crate::project::schema::Clip { id: format!("c{i}"), timeline_start: i as f64, ..one.clone() })
            .collect();
        let built = builder::build(&spec, &enc).unwrap();
        assert!(built.filter_complex.len() > INLINE_FILTER_LIMIT, "premise: a long graph");
        let plan = compose(&built, &out, &temp).unwrap();
        let i = plan.args.iter().position(|a| a == "-/filter_complex").expect("the file form of the option");
        assert!(!plan.args.iter().any(|a| a == "-filter_complex" || a == "-filter_complex_script"));
        let script = PathBuf::from(&plan.args[i + 1]);
        let (_, body) = plan.writes.iter().find(|(p, _)| *p == script).expect("the script is written");
        assert_eq!(body, &plan.filter_complex);
        assert!(plan.temps.contains(&script), "and deleted afterwards");
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// A GIF composes into two runs: the palette pass writes the palette
    /// under a bare name, the encode reads that same name back, both graphs
    /// get the same text name, and the palette is in the cleanup list though
    /// nothing writes it before the run.
    #[test]
    fn a_gif_composes_into_a_palette_pass_and_an_encode_sharing_one_palette() {
        let temp = publish_dir("gif plan");
        let out = temp.join("loop.gif").to_string_lossy().into_owned();
        let (spec, enc) = text_spec(&out, "gif");
        let plan = compose(&builder::build(&spec, &enc).unwrap(), &out, &temp).unwrap();
        let hash = xxh3_64(out.as_bytes());
        let palette = format!("taroting-palette-{hash:016x}.png");
        let p1 = plan.palette_args.as_ref().expect("a palette pass");
        assert_eq!(p1.last().unwrap(), &OsString::from(&palette), "pass 1 writes the palette");
        let i = plan.args.iter().position(|a| a == palette.as_str()).expect("pass 2 reads it");
        assert_eq!(plan.args[i - 1], "-i");
        assert_eq!(plan.args.last().unwrap(), &OsString::from(format!("{out}.part")));
        for a in [p1, &plan.args] {
            assert!(a.iter().any(|s| s.to_string_lossy().contains(&format!("textfile='taroting-text-{hash:016x}-0.txt'"))));
            assert!(!a.iter().any(|s| s == PALETTE_PLACEHOLDER || s == FILTER_PLACEHOLDER));
        }
        assert!(plan.temps.contains(&temp.join(&palette)));
        assert!(!plan.writes.iter().any(|(p, _)| *p == temp.join(&palette)));
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// A project whose argv cannot fit on a Windows command line is refused
    /// with a message that says what to do, BEFORE anything is written — not
    /// left to fail at spawn with an OS error. 300 audible clips on long
    /// paths; the same project with 20 clips composes.
    #[test]
    fn an_argv_too_long_for_windows_is_refused_before_anything_is_written() {
        let dir = publish_dir("too many clips");
        let long = dir.join(format!("{}.mp4", "a very long clip name for a very long edit ".repeat(4)));
        let project = |n: usize| {
            let (mut spec, enc) = spec_over(&dir, false);
            let mut m = source("m1", &long);
            m.has_audio = true;
            spec.media = vec![m];
            let one = crate::project::schema::Clip {
                id: "c".into(), media_id: "m1".into(), timeline_start: 0.0, src_in: 0.0, src_out: 0.5,
                speed: 1.0, transform: None,
                audio: crate::project::schema::ClipAudio {
                    volume: 1.0, muted: false, fade_in_sec: 0.0, fade_out_sec: 0.0, gain_offset_db: 0.0, detached: false,
                },
                keyframes: None, adjust: None,
            };
            spec.timeline.tracks = vec![crate::project::schema::Track {
                id: "v".into(), kind: "video".into(), name: "V".into(), muted: false, hidden: None,
                clips: (0..n).map(|i| crate::project::schema::Clip { id: format!("c{i}"), timeline_start: i as f64 * 0.5, ..one.clone() }).collect(),
            }];
            (spec, enc)
        };
        let (spec, enc) = project(300);
        let built = builder::build(&spec, &enc).unwrap();
        let err = match compose(&built, &spec.out_path, &dir) {
            Err(e) => e,
            Ok(_) => panic!("300 audible clips on long paths cannot fit"),
        };
        assert!(matches!(err, AppError::BadInput(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            "This project has too many clips to export in one pass (600 inputs). Try exporting it in parts."
        );
        let (spec, enc) = project(20);
        compose(&builder::build(&spec, &enc).unwrap(), &spec.out_path, &dir).expect("20 clips fit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The quoting arithmetic, against the rules std applies: no quotes for a
    /// plain argument, quotes for a space, an escaped `"`, and the backslashes
    /// before a quote (or the closing quote) doubled.
    #[test]
    fn windows_arg_len_counts_what_std_puts_on_the_command_line() {
        for (arg, len) in [
            ("abc", 3),
            ("", 2),
            ("a b", 5),
            (r"C:\x\y", 6),
            (r"C:\my dir\", 13),
            (r#"a"b"#, 4),
            (r#"a\"b"#, 6),
        ] {
            assert_eq!(windows_arg_len(OsStr::new(arg)), len, "{arg:?}");
        }
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

    /// Every extension the app can import redacts as its own kind, read from
    /// the shared table rather than a copy of it. A gif is a video to the
    /// redactor: it moves, and VIDEO_EXT has always named it.
    #[test]
    fn redaction_kind_covers_every_importable_extension() {
        use crate::media::extensions::{all, Family};
        assert!(!all().is_empty(), "an empty table would pass this vacuously");
        for (ext, family) in all() {
            let want = match family {
                Family::Video | Family::Gif => "video",
                Family::Audio => "audio",
                Family::Image => "image",
            };
            assert_eq!(kind_for(ext), want, "{ext} ({family:?}) redacts as the wrong kind");
        }
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

    /* -------- (4) never export onto a source -------- */

    /// A source media entry for the overwrite guard: only `path` and
    /// `generator` are read, the rest is a plausible probe.
    fn source(id: &str, path: &std::path::Path) -> MediaRef {
        MediaRef {
            id: id.into(),
            path: path.to_string_lossy().into_owned(),
            size: 17,
            mtime_ms: 1,
            kind: "video".into(),
            duration: 3.0,
            fps: None,
            width: Some(640),
            height: Some(360),
            container: Some("mov,mp4,m4a,3gp,3g2,mj2".into()),
            vcodec: Some("h264".into()),
            acodec: None,
            pix_fmt: Some("yuv420p".into()),
            bit_depth: Some(8),
            has_audio: false,
            audio_rate: None,
            audio_channels: None,
            generator: None,
            no_autorotate: None,
        }
    }

    fn refused_naming(out: &std::path::Path, media: &[MediaRef], name: &str) {
        let err = refuse_overwriting_a_source(&out.to_string_lossy(), media)
            .expect_err("an export onto a source must be refused");
        assert!(matches!(err, AppError::BadInput(_)), "wrong variant: {err:?}");
        let msg = err.to_string();
        assert!(msg.contains(&format!("overwrite {name},")), "must name {name}: {msg}");
        assert!(msg.contains("Choose another name"), "must say what to do: {msg}");
    }

    /// Real files throughout: the guard's whole point is to ask the filesystem,
    /// so a test that only compared strings would prove nothing about it. The
    /// source is listed SECOND behind an unrelated one, so a guard that only
    /// looked at `media[0]` fails here.
    #[test]
    fn an_export_onto_one_of_the_projects_own_files_is_refused() {
        let dir = publish_dir("guard-same");
        let other = dir.join("Intro.mov");
        let src = dir.join("Holiday Clip.mp4");
        std::fs::write(&other, b"intro").unwrap();
        std::fs::write(&src, b"the original footage").unwrap();
        let media = [source("m1", &other), source("m2", &src)];

        refused_naming(&src, &media, "Holiday Clip.mp4");
        // The same file spelled through a `..` detour is still the same file.
        let detour = dir.join("sub").join("..").join("Holiday Clip.mp4");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        refused_naming(&detour, &media, "Holiday Clip.mp4");

        assert_eq!(std::fs::read(&src).unwrap(), b"the original footage");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// NTFS folds case, so this spelling IS the source. A byte comparison would
    /// have waved it through and the publish rename would have replaced it.
    #[cfg(windows)]
    #[test]
    fn the_same_source_spelled_in_another_case_is_still_refused() {
        let dir = publish_dir("guard-case");
        let src = dir.join("Holiday Clip.mp4");
        std::fs::write(&src, b"the original footage").unwrap();
        let media = [source("m1", &src)];

        for spelling in ["holiday clip.mp4", "HOLIDAY CLIP.MP4", "Holiday Clip.MP4"] {
            refused_naming(&dir.join(spelling), &media, "Holiday Clip.mp4");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Replacing an earlier export, or any file the project does not read, is
    /// an ordinary overwrite and stays the user's call in the dialog.
    #[test]
    fn replacing_a_file_the_project_does_not_use_is_allowed() {
        let dir = publish_dir("guard-other");
        let src = dir.join("Holiday Clip.mp4");
        let previous = dir.join("Holiday Clip export.mp4");
        std::fs::write(&src, b"the original footage").unwrap();
        std::fs::write(&previous, b"last week's export").unwrap();

        refuse_overwriting_a_source(&previous.to_string_lossy(), &[source("m1", &src)])
            .expect("an unrelated existing file may be replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The normal export: nothing at the destination yet. `path_identity`
    /// answers `Unknown` for a path that does not exist, and reading that as
    /// "refuse" would block every export there is. A source that is missing
    /// too (moved, offline drive) must not trip it either: it can't be a file
    /// that does not exist.
    #[test]
    fn a_destination_that_does_not_exist_yet_is_never_refused() {
        let dir = publish_dir("guard-new");
        let src = dir.join("Holiday Clip.mp4");
        std::fs::write(&src, b"the original footage").unwrap();
        let missing = dir.join("Offline Drive Clip.mp4");
        let media = [source("m1", &src), source("m2", &missing)];

        let fresh = dir.join("Holiday Clip final.mp4");
        refuse_overwriting_a_source(&fresh.to_string_lossy(), &media)
            .expect("a new file cannot be a source");

        // ...and an EXISTING destination next to a missing source is decided by
        // the sources that exist, not refused on the missing one's `Unknown`.
        let previous = dir.join("Holiday Clip export.mp4");
        std::fs::write(&previous, b"last week's export").unwrap();
        refuse_overwriting_a_source(&previous.to_string_lossy(), &media)
            .expect("a proven-absent source is not the destination");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ffmpeg writes `<out>.part` with `-y`, so a source carrying that name
    /// would be truncated before the first frame was read, even though the
    /// destination itself is new.
    #[test]
    fn a_source_named_like_the_part_file_is_refused() {
        let dir = publish_dir("guard-part");
        let src = dir.join("Reel.mp4.part");
        std::fs::write(&src, b"a source that happens to end in .part").unwrap();

        refused_naming(&dir.join("Reel.mp4"), &[source("m1", &src)], "Reel.mp4.part");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A source the filesystem cannot be asked about at all (an unreachable
    /// share behaves the same way; a NUL in the name is the portable way to
    /// make `try_exists` fail rather than answer `false`) is not PROVEN to be
    /// the destination, so the refusal must not claim an overwrite: it says the
    /// check failed. A proven `Same` keeps the plain wording.
    #[test]
    fn an_unanswerable_source_is_refused_as_unchecked_not_as_an_overwrite() {
        let dir = publish_dir("guard-unknown");
        let previous = dir.join("Holiday Clip export.mp4");
        std::fs::write(&previous, b"last week's export").unwrap();
        let unreadable = dir.join("Rem\0ote Clip.mp4");
        assert!(unreadable.try_exists().is_err(), "premise: the source cannot be checked");

        let err = refuse_overwriting_a_source(&previous.to_string_lossy(), &[source("m1", &unreadable)])
            .expect_err("an unprovable source must still refuse");
        assert!(matches!(err, AppError::BadInput(_)), "wrong variant: {err:?}");
        let msg = err.to_string();
        assert!(
            msg.starts_with("Couldn't check whether this would overwrite Rem"),
            "must say it could not check: {msg}"
        );
        assert!(!msg.contains("This would overwrite"), "must not claim an overwrite: {msg}");
        assert!(msg.contains("Choose another name"), "must say what to do: {msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A volume `canonicalize` cannot resolve (some RAM disks, VirtualBox
    /// shares, Dokan/FUSE drives), stood in for by a resolver that never
    /// answers. The files are real, so `try_exists` still says they are there.
    /// Replacing an earlier export there was refused as "couldn't check" —
    /// 0.8.1 replaced it — so the dialog's Replace always failed. The fallback
    /// is the dialog's own comparison: an unrelated file may be replaced, and
    /// the source itself, however it is spelled, is still refused as an
    /// overwrite.
    #[cfg(windows)]
    #[test]
    fn a_volume_that_will_not_resolve_falls_back_to_comparing_the_names() {
        let dir = publish_dir("guard-unresolvable");
        let src = dir.join("Holiday Clip.mp4");
        let previous = dir.join("Holiday Clip export.mp4");
        std::fs::write(&src, b"the original footage").unwrap();
        std::fs::write(&previous, b"last week's export").unwrap();
        let media = [source("m1", &src)];
        let unresolvable = |_: &std::path::Path| None;

        refuse_overwriting_a_source_with(&previous.to_string_lossy(), &media, unresolvable)
            .expect("an unrelated existing file may be replaced on any volume");

        let spellings = [
            src.to_string_lossy().to_ascii_uppercase(),
            // Upper case AND forward slashes, so neither `Path`'s own equality
            // (which already treats both separators as one) nor folding case
            // alone is what matches it.
            src.to_string_lossy().to_ascii_uppercase().replace('\\', "/"),
        ];
        for spelling in spellings {
            let err = refuse_overwriting_a_source_with(&spelling, &media, unresolvable)
                .expect_err("the source itself must still be refused");
            let msg = err.to_string();
            assert!(
                msg.contains("This would overwrite Holiday Clip.mp4,"),
                "{spelling}: must claim the overwrite it found by name: {msg}"
            );
        }
        assert_eq!(std::fs::read(&src).unwrap(), b"the original footage");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Generated media have no file; their `path` is a placeholder and never
    /// names anything on disk, so it is not compared at all.
    #[test]
    fn generated_media_never_count_as_a_source() {
        let dir = publish_dir("guard-gen");
        let out = dir.join("Titles.mp4");
        std::fs::write(&out, b"previous export").unwrap();
        let mut gen = source("m1", &out);
        gen.generator = Some(crate::project::schema::Generator::Solid { color: "#123456".into() });

        refuse_overwriting_a_source(&out.to_string_lossy(), &[gen])
            .expect("a generator is not a file the export could overwrite");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (5) a source file that is gone -------- */

    /// A project over real files: a video clip with sound, a MUTED clip on an
    /// audio track, a Solid generator whose placeholder path names nothing on
    /// disk, and a media entry no clip uses. Built by the real builder, so the
    /// files checked are the ones ffmpeg would be handed.
    fn spec_over(dir: &std::path::Path, voice_muted: bool) -> (ExportSpec, crate::hw::EncoderReport) {
        use crate::export::model::*;
        use crate::project::schema::*;
        let audio = |muted: bool| ClipAudio {
            volume: 1.0,
            muted,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            gain_offset_db: 0.0,
            detached: false,
        };
        let clip = |id: &str, media_id: &str, start: f64, muted: bool| Clip {
            id: id.into(),
            media_id: media_id.into(),
            timeline_start: start,
            src_in: 0.0,
            src_out: 2.0,
            speed: 1.0,
            transform: None,
            audio: audio(muted),
            keyframes: None,
            adjust: None,
        };
        let track = |id: &str, kind: &str, clips: Vec<Clip>| Track {
            id: id.into(),
            kind: kind.into(),
            name: id.into(),
            muted: false,
            clips,
            hidden: None,
        };
        let mut holiday = source("m1", &dir.join("Holiday Clip.mp4"));
        holiday.has_audio = true;
        let mut voice = source("m2", &dir.join("Voice Memo.m4a"));
        voice.kind = "audio".into();
        voice.has_audio = true;
        let mut title = source("m3", &dir.join("Title Card.png"));
        title.generator = Some(Generator::Solid { color: "#123456".into() });
        let unused = source("m4", &dir.join("Unused B-roll.mp4"));
        let spec = ExportSpec {
            media: vec![holiday, voice, title, unused],
            timeline: Timeline {
                fps: Rational { num: 30, den: 1 },
                width: 1280,
                height: 720,
                tracks: vec![
                    track("v1", "video", vec![clip("c1", "m1", 0.0, false), clip("c3", "m3", 2.0, false)]),
                    track("a1", "audio", vec![clip("c2", "m2", 0.5, voice_muted)]),
                ],
                markers: vec![],
            },
            preset: ExportPreset {
                format: "mp4".into(),
                vcodec: "h264".into(),
                resolution: ResolutionPreset::Named("original".into()),
                fps: FpsPreset::Original("original".into()),
                video_bitrate: BitratePreset::Auto(AutoTag::Auto),
                audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
                use_hardware: false,
            },
            out_path: dir.join("Export final.mp4").to_string_lossy().into_owned(),
        };
        let encoders = crate::hw::EncoderReport {
            h264: "libx264".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        };
        (spec, encoders)
    }

    /// The pre-flight the real command runs (`plan_export`), not the helper
    /// alone: dropping the check from `start_export`'s path fails these.
    fn plan_over(dir: &std::path::Path, voice_muted: bool) -> Result<BuiltExport> {
        let (spec, encoders) = spec_over(dir, voice_muted);
        plan_export(&spec, &encoders)
    }

    fn refused_as_missing(dir: &std::path::Path, name: &str) {
        let Err(err) = plan_over(dir, false) else { panic!("a missing source must be refused") };
        assert!(matches!(err, AppError::BadInput(_)), "wrong variant: {err:?}");
        assert_eq!(
            err.to_string(),
            format!("{name} is missing. Reopen the project to relink it, or replace it, then export.")
        );
    }

    /// A clip's file deleted after the project opened is refused before ffmpeg
    /// runs, naming the file. Everything else about the project is fine, so
    /// the refusal can only be about that one file.
    #[test]
    fn an_export_whose_source_is_gone_names_the_file() {
        let dir = publish_dir("missing-src");
        std::fs::write(dir.join("Holiday Clip.mp4"), b"footage").unwrap();
        std::fs::write(dir.join("Voice Memo.m4a"), b"voice").unwrap();
        std::fs::write(dir.join("Unused B-roll.mp4"), b"b-roll").unwrap();

        // All there (the generator's placeholder path is not): exported.
        plan_over(&dir, false).expect("every file ffmpeg opens is present");

        std::fs::remove_file(dir.join("Holiday Clip.mp4")).unwrap();
        refused_as_missing(&dir, "Holiday Clip.mp4");

        // The voice memo gone too, with its clip still heard: the first file
        // ffmpeg would open is the one named.
        std::fs::remove_file(dir.join("Voice Memo.m4a")).unwrap();
        refused_as_missing(&dir, "Holiday Clip.mp4");
        std::fs::write(dir.join("Holiday Clip.mp4"), b"footage").unwrap();
        refused_as_missing(&dir, "Voice Memo.m4a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Files ffmpeg never opens are never refused: the one only a muted clip
    /// uses (that export works without it today), one no clip uses, and a
    /// generator's placeholder path.
    #[test]
    fn a_missing_file_ffmpeg_never_opens_does_not_block_the_export() {
        let dir = publish_dir("missing-unopened");
        std::fs::write(dir.join("Holiday Clip.mp4"), b"footage").unwrap();
        // "Voice Memo.m4a", "Unused B-roll.mp4" and "Title Card.png" never exist.
        let built = plan_over(&dir, true).expect("nothing ffmpeg opens is missing");
        let opened: Vec<String> = built
            .sources
            .iter()
            .map(|s| builder::display_name(&s.to_string_lossy()))
            .collect();
        // The video, and the same file again for its sound: nothing else.
        assert_eq!(opened, ["Holiday Clip.mp4", "Holiday Clip.mp4"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Only `Ok(false)` proves a file is gone. A path the filesystem cannot be
    /// asked about is left to ffmpeg; an unreachable share behaves this way,
    /// and so does a name Windows calls invalid (`<`), which is the portable
    /// stand-in here. (A NUL used to be the stand-in; a NUL path is now
    /// refused by shape, below, because no process can even be handed one.)
    #[cfg(windows)]
    #[test]
    fn a_source_that_cannot_be_checked_is_left_to_ffmpeg() {
        let dir = publish_dir("missing-unknown");
        let unreadable = dir.join("Rem<ote Clip.mp4");
        assert!(unreadable.try_exists().is_err(), "premise: the source cannot be checked");
        refuse_missing_sources(&[unreadable.into_os_string()])
            .expect("an unanswered check is not proof the file is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A source that is not a full path to a file is refused by its shape,
    /// naming it, whatever is on disk — the relative name even though a file
    /// of that name exists in the working directory, where it would have
    /// resolved. A URL, a device and a NUL go the same way; a share does not.
    #[test]
    fn a_source_that_is_not_a_full_file_path_is_refused_by_name() {
        let cwd = std::env::current_dir().unwrap();
        let here = std::fs::read_dir(&cwd)
            .unwrap()
            .flatten()
            .find(|e| e.path().is_file())
            .expect("the working directory holds a file");
        let relative = here.file_name().into_string().unwrap();
        let mut bad = vec![relative.clone(), "https://example.com/clip.mp4".into(), "C:\\clip\0.mp4".into()];
        if cfg!(windows) {
            bad.extend([r"C:clip.mp4".to_string(), r"\clip.mp4".into(), r"\\.\pipe\clip.mp4".into(), r"\\?\pipe\clip.mp4".into()]);
        }
        for p in bad {
            let err = refuse_missing_sources(&[OsString::from(&p)]).expect_err(&p);
            assert!(matches!(err, AppError::BadInput(_)), "{p}: {err:?}");
            assert!(err.to_string().contains("isn't a full path to a file"), "{p}: {err}");
        }
        let err = refuse_missing_sources(&[OsString::from(&relative)]).unwrap_err().to_string();
        assert!(err.starts_with(&format!("{relative} isn't")), "the file is named: {err}");
    }

    /// The destination must be a plain full path: relative, drive- or
    /// root-relative, device, verbatim and alternate-data-stream forms are
    /// refused before anything is built; a drive path and a share are not.
    #[test]
    fn a_destination_that_is_not_a_plain_full_path_is_refused() {
        let mut bad: Vec<(&str, &str)> = vec![
            ("", "Choose where"),
            ("Final Cut.mp4", "full folder path"),
            (r"exports\Final Cut.mp4", "full folder path"),
        ];
        if cfg!(windows) {
            bad.extend([
                (r"D:Final Cut.mp4", "full folder path"),
                (r"\Final Cut.mp4", "full folder path"),
                (r"\\.\C:\Final Cut.mp4", "device path"),
                (r"\\?\C:\Final Cut.mp4", "device path"),
                ("//./pipe/x.mp4", "device path"),
                (r"C:\clips\a.mp4:stream.mp4", "plain file path"),
            ]);
        }
        for (p, needle) in bad {
            let err = refuse_unusable_destination(p).expect_err(p);
            assert!(matches!(err, AppError::BadInput(_)), "{p}: {err:?}");
            assert!(err.to_string().contains(needle), "{p}: {err}");
        }
        if cfg!(windows) {
            refuse_unusable_destination(r"C:\Exports\Final Cut.mp4").unwrap();
            refuse_unusable_destination(r"\\server\share\Final Cut.mp4").unwrap();
        }
        // ...and it is the real command's pre-flight that refuses it.
        let dir = publish_dir("relative-dest");
        std::fs::write(dir.join("Holiday Clip.mp4"), b"footage").unwrap();
        std::fs::write(dir.join("Voice Memo.m4a"), b"voice").unwrap();
        let (mut spec, enc) = spec_over(&dir, false);
        spec.out_path = "Export final.mp4".into();
        let Err(err) = plan_export(&spec, &enc) else { panic!("a relative destination must be refused") };
        assert!(err.to_string().contains("full folder path"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (6) the .part name is claimed, never clobbered -------- */

    /// A file already named `<out>.part` (a browser download, someone else's
    /// work) is refused by name and left byte-for-byte alone; ffmpeg's `-y`
    /// used to truncate it and the failure cleanup then deleted it. The
    /// refusal names the likelier owner too — an export of the user's own
    /// that never finished — and what to do about it. Without one, the export
    /// claims the name, so the job's cleanup has something of its own to
    /// remove.
    #[test]
    fn a_foreign_part_file_is_refused_and_left_alone() {
        let dir = publish_dir("foreign-part");
        std::fs::write(dir.join("Holiday Clip.mp4"), b"footage").unwrap();
        std::fs::write(dir.join("Voice Memo.m4a"), b"voice").unwrap();
        let (spec, enc) = spec_over(&dir, false);
        let part = dir.join("Export final.mp4.part");
        std::fs::write(&part, b"half of somebody's download").unwrap();

        let Err(err) = prepare_export(&spec, &enc, &dir) else { panic!("the .part is in the way") };
        assert!(matches!(err, AppError::BadInput(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            "A file named Export final.mp4.part is in the way. It may be left from an export that \
             didn't finish: delete it if so, or choose another name."
        );
        assert_eq!(std::fs::read(&part).unwrap(), b"half of somebody's download");

        std::fs::remove_file(&part).unwrap();
        let prepared = prepare_export(&spec, &enc, &dir).expect("nothing in the way now");
        assert_eq!(prepared.part, part);
        assert!(part.exists(), "the name is claimed before the job starts");
        assert_eq!(std::fs::metadata(&part).unwrap().len(), 0);
        prepared.temps.cleanup();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A destination folder that is gone (deleted or renamed since the dialog
    /// chose it) is refused in words, before anything is written: no claim,
    /// no folder created, no raw "(os error 3)".
    #[test]
    fn a_missing_destination_folder_is_named_not_reported_as_an_os_error() {
        let dir = publish_dir("missing-folder");
        std::fs::write(dir.join("Holiday Clip.mp4"), b"footage").unwrap();
        std::fs::write(dir.join("Voice Memo.m4a"), b"voice").unwrap();
        let (mut spec, enc) = spec_over(&dir, false);
        let gone = dir.join("Renamed since");
        spec.out_path = gone.join("Export final.mp4").to_string_lossy().into_owned();

        let Err(err) = prepare_export(&spec, &enc, &dir) else { panic!("there is no folder to export into") };
        assert!(matches!(err, AppError::BadInput(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            format!("The folder {} doesn't exist. Choose another folder.", gone.display())
        );
        assert!(!gone.exists(), "the refusal must not create the folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The done payload: `hwFallback: true` exactly when the encode was
    /// redone in software, and no such key otherwise (the dialog reads the
    /// key, so a `false` would be a second spelling of "no").
    #[test]
    fn the_done_output_names_a_hardware_fallback_only_when_one_happened() {
        assert_eq!(done_output(r"C:\o.mp4", false), serde_json::json!({ "path": r"C:\o.mp4" }));
        assert_eq!(
            done_output(r"C:\o.mp4", true),
            serde_json::json!({ "path": r"C:\o.mp4", "hwFallback": true })
        );
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

    /// The app's ffmpeg runner without the job system: the sidecar run to its
    /// end with `temp` as its working folder (where the textfile and palette
    /// names resolve, exactly as `execute_ffmpeg` is told in the app), failing
    /// with its stderr as the log tail.
    fn direct_runner(
        temp: &std::path::Path,
    ) -> impl FnMut(Vec<OsString>, Option<f64>) -> std::result::Result<(), JobFailure> + '_ {
        move |args, _total| {
            let res = ffmpeg::command("ffmpeg").unwrap().current_dir(temp).args(&args).output().unwrap();
            if res.status.success() {
                Ok(())
            } else {
                Err(JobFailure {
                    message: format!("ffmpeg exited with {}", res.status),
                    log_tail: String::from_utf8_lossy(&res.stderr).lines().map(String::from).collect(),
                })
            }
        }
    }

    /// Run a built export the way the job does — composed, its temp files
    /// written, every pass run, the temp files removed — minus the job
    /// system. `part` is where the encode must land.
    fn run_built(built: &BuiltExport, out: &str, part: &std::path::Path) {
        run_built_in(built, out, part, &std::env::temp_dir());
    }

    fn run_built_in(built: &BuiltExport, out: &str, part: &std::path::Path, temp: &std::path::Path) {
        let plan = compose(built, out, temp).unwrap();
        assert_eq!(plan.args.last().unwrap(), part.as_os_str());
        let temps = plan.materialize().unwrap();
        if let Err(f) = run_plan(&plan, temps, &mut direct_runner(temp)) {
            panic!("export ffmpeg failed: {}\n{}", f.message, f.log_tail.join("\n"));
        }
        for t in &plan.temps {
            assert!(!t.exists(), "temp file left behind: {}", t.display());
        }
    }

    /// The shared 3 s fixture, made once and trusted only when it probes.
    ///
    /// Parallel tests in this run, and other `cargo test` processes on the
    /// machine, all reach for it. Before: each wrote the final name directly
    /// behind an `exists()` check, so one test probed another's half-written
    /// file ("moov atom not found"), and a run killed mid-write left a
    /// truncated fixture that every later run trusted. Now one creator at a
    /// time in this process, a part file named by process, the final name
    /// only by rename, and a file that does not probe is made again.
    fn fixture_media(dir: &std::path::Path) -> (std::path::PathBuf, MediaRef) {
        static CREATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        // 3s testsrc2 + sine, 640x360, with a space in the path
        let src = dir.join("src fixture.mp4");
        {
            let _one_at_a_time = CREATE.lock().unwrap_or_else(|e| e.into_inner());
            if src.exists() && probe::probe_sync(src.to_str().unwrap()).is_err() {
                let _ = std::fs::remove_file(&src);
            }
            if !src.exists() {
                let part = dir.join(format!("src fixture.{}.part.mp4", std::process::id()));
                ffmpeg_ok(&[
                    "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest",
                    part.to_str().unwrap(),
                ]);
                // Another process may have renamed its own copy in first, and
                // be reading it (Windows then refuses the replace): theirs is
                // as good as ours.
                if std::fs::rename(&part, &src).is_err() {
                    let _ = std::fs::remove_file(&part);
                    assert!(src.exists(), "fixture could not be published");
                }
            }
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
            no_autorotate: None,
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
            audio: default_audio(), keyframes: None, adjust: None,
        }
    }

    fn vtrack(id: &str, clips: Vec<Clip>) -> Track {
        Track { id: id.into(), kind: "video".into(), name: "V".into(), muted: false, clips, hidden: None }
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
            no_autorotate: None,
        }
    }

    /* -------- (0) a video stream shorter than its clip -------- */

    /// A full-length drop of a file whose audio outlasts its video: the clip's
    /// `src_out` is the probed CONTAINER duration (1.5 s here), the video
    /// stream ends at 1.0 s. The segment used to end with the stream
    /// (`overlay=...:shortest=1`), so the export came out ~0.5 s short and the
    /// white clip after it started at 1.0 s instead of 1.5 s — every later
    /// segment early against its `adelay`-placed audio. It must hold the last
    /// red frame to the end of its slot and keep the next clip on its
    /// absolute time.
    #[test]
    fn e2e_a_video_stream_shorter_than_its_clip_keeps_later_clips_on_time() {
        let dir = case_dir("short video stream");
        let src = dir.join("short video.mp4");
        ffmpeg_ok(&[
            "-y",
            "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            src.to_str().unwrap(),
        ]);
        let info = probe::probe_sync(src.to_str().unwrap()).unwrap();
        let video_end: f64 = probe_field(&src, "stream=duration").parse().unwrap();
        assert!(
            info.duration - video_end > 0.3,
            "premise: the container ({}) outlasts the video stream ({video_end})",
            info.duration
        );
        let media = MediaRef {
            id: "m1".into(),
            path: src.to_string_lossy().into_owned(),
            size: info.size,
            mtime_ms: info.mtime_ms,
            kind: "video".into(),
            duration: info.duration,
            fps: Some(Rational { num: 30, den: 1 }),
            width: Some(320),
            height: Some(180),
            container: info.container.clone(),
            vcodec: info.vcodec.clone(),
            acodec: info.acodec.clone(),
            pix_fmt: info.pix_fmt.clone(),
            bit_depth: Some(8),
            has_audio: true,
            audio_rate: info.audio_rate,
            audio_channels: info.audio_channels,
            generator: None,
            no_autorotate: None,
        };
        let white = solid_media("white", "#ffffff");
        let slot = info.duration;
        let bottom = vtrack(
            "vbot",
            vec![clip_at("a", "m1", 0.0, 0.0, slot), clip_at("b", "white", slot, 0.0, 1.0)],
        );
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![media, white], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("held.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "held.mp4");

        let exported: f64 = probe_field(&out, "stream=duration").parse().unwrap();
        assert!(
            (exported - (slot + 1.0)).abs() < 0.05,
            "the video must be as long as the timeline: {exported} vs {}",
            slot + 1.0
        );
        let centre = |t: f64| yavg(&out, t, 260, 120, 120, 120);
        let held = centre(slot - 0.2);
        let next = centre(slot + 0.2);
        assert!(held < 120.0, "the last red frame must hold to the end of its slot: YAVG {held}");
        assert!(next > 200.0, "the white clip must start on its own time: YAVG {next}");
        let _ = std::fs::remove_dir_all(&dir);
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
            no_autorotate: None,
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
            keyframes: None, adjust: None,
        };
        let b = Clip {
            id: "b".into(), media_id: "m1".into(), timeline_start: 1.5,
            src_in: 2.0, src_out: 3.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None, adjust: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![a, b], hidden: None,
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
            keyframes: None, adjust: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![c], hidden: None,
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
        // carry the colour: a mask that came out empty or mis-sized would
        // leave a black band here even though ffmpeg exited 0. (This source is
        // OPAQUE, so it cannot tell an `alphamerge` that replaces the alpha
        // from one that multiplies it — both give the ramp. That is
        // `e2e_text_opacity_keyframes_keep_the_empty_text_box_transparent`.)
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
            no_autorotate: None,
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
            no_autorotate: None,
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
            keyframes: None, adjust: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![c], hidden: None,
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

    /* -------- (9) the alpha a text clip brings with it -------- */

    /// A black "Ab" text clip whose opacity is KEYFRAMED (0.3 -> 0.9 over
    /// 3 s) over a white solid. A text frame is transparent everywhere but the
    /// glyphs, and the opacity mask must MULTIPLY that alpha (issue #1, part
    /// 4): wired straight into `alphamerge` instead, the ramp replaces it and
    /// the whole 300x80 box exports as a translucent black rectangle.
    ///
    /// Geometry: the 300x80 box contain-fits the 640x360 canvas at 2.133x, so
    /// it spans x 0..640, y ~95..265. At t=2.0 the opacity is 0.7. A patch
    /// inside the box but right of the glyphs must stay white (~235; the
    /// regressed graph measures ~82 there), and a patch over the glyphs must
    /// be darker than it, so the text did render.
    #[test]
    fn e2e_text_opacity_keyframes_keep_the_empty_text_box_transparent() {
        let dir = case_dir("text-alpha-kf");
        let base = solid_media("base", "#ffffff");
        let text = MediaRef {
            id: "txt".into(), path: "Text".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(300), height: Some(80),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Text {
                text: "Ab".into(),
                font_family: "Arial".into(),
                size_px: 48.0,
                color: "#000000".into(),
                bold: false,
                italic: false,
            }),
            no_autorotate: None,
        };
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 3.0)]);
        let mut t = clip_at("t1", "txt", 0.0, 0.0, 3.0);
        t.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 0.3 }, Keyframe { t: 3.0, v: 0.9 }]),
        });
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![vtrack("vtop", vec![t]), bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, text], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("textalpha.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "textalpha.mp4");

        let empty_box = yavg(&out, 2.0, 440, 170, 30, 20);
        let glyphs = yavg(&out, 2.0, 10, 150, 110, 60);
        assert!(empty_box >= 200.0, "the empty part of the text box must stay transparent: YAVG {empty_box}");
        assert!(glyphs < empty_box - 20.0, "the glyphs must render: glyphs {glyphs} vs box {empty_box}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (10) script mode, end to end -------- */

    /// A graph past `INLINE_FILTER_LIMIT` (sixty 0.1 s solid clips) goes to
    /// a script behind `-/filter_complex` and actually encodes from it, to
    /// the frame: 6 s at 30 fps is 180 frames. `run_built_in` also checks the
    /// script is gone afterwards.
    #[test]
    fn e2e_a_graph_too_long_to_inline_encodes_from_its_script() {
        let dir = case_dir("script");
        let colours = ["#ff0000", "#00ff00", "#0000ff"];
        let media: Vec<MediaRef> = colours.iter().enumerate().map(|(i, c)| solid_media(&format!("s{i}"), c)).collect();
        let clips: Vec<Clip> = (0..60)
            .map(|i| clip_at(&format!("c{i}"), &format!("s{}", i % 3), i as f64 * 0.1, 0.0, 0.1))
            .collect();
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![vtrack("v", clips)], markers: vec![],
        };
        let out = dir.join("script.mp4");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec { media, timeline: tl, preset: preset_640(30.0), out_path: out_s.clone() };
        let built = builder::build(&spec, &enc()).unwrap();
        assert!(built.filter_complex.len() > INLINE_FILTER_LIMIT, "premise: {} chars", built.filter_complex.len());
        let plan = compose(&built, &out_s, &dir).unwrap();
        assert!(plan.args.iter().any(|a| a == "-/filter_complex"), "script mode");
        let part = dir.join("script.mp4.part");
        run_built_in(&built, &out_s, &part, &dir);
        let frames = ffmpeg::run(
            "ffprobe",
            &["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames",
              "-of", "default=nw=1:nk=1", part.to_str().unwrap()],
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&frames.stdout).trim(), "180");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (11) the GIF's two passes -------- */

    /// The two-pass GIF is the same file the old single `split` graph made,
    /// byte for byte — the change is memory, not output — and its palette
    /// does not outlive the export. The single-pass reference is built from
    /// the very graph the encode used, with the palette input swapped for
    /// the old in-graph `split`.
    #[test]
    fn e2e_a_two_pass_gif_is_the_single_pass_gif_without_the_buffering() {
        let dir = case_dir("gif two pass");
        let (_src, media) = fixture_media(&dir);
        let c = clip_at("c", "m1", 0.0, 0.3, 1.3);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![vtrack("v", vec![c])], markers: vec![],
        };
        let mut preset = preset_640(15.0);
        preset.format = "gif".into();
        preset.resolution = ResolutionPreset::Custom { w: 320, h: 180 };
        let out = dir.join("two.gif");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec { media: vec![media], timeline: tl, preset, out_path: out_s.clone() };
        let built = builder::build(&spec, &enc()).unwrap();
        let part = dir.join("two.gif.part");
        run_built_in(&built, &out_s, &part, &dir);

        // The old graph: the same video graph, split into palettegen and
        // paletteuse inside one run.
        let plan = compose(&built, &out_s, &dir).unwrap();
        let video = &plan.filter_complex[..plan.filter_complex.rfind(";[vout]").unwrap()];
        let single = format!(
            "{video};[vout]split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=bayer:bayer_scale=4[gifout]"
        );
        let mut args: Vec<OsString> = Vec::new();
        let mut i = 0;
        while i < plan.args.len() {
            let a = &plan.args[i];
            if a == "-protocol_whitelist" && plan.args.get(i + 3).is_some_and(|p| p.to_string_lossy().starts_with("taroting-palette-")) {
                i += 4; // the palette input
                continue;
            }
            args.push(if a.to_string_lossy().contains("[vout][1:v]paletteuse") { OsString::from(&single) } else { a.clone() });
            i += 1;
        }
        let reference = dir.join("one.gif");
        let n = args.len();
        args[n - 1] = OsString::from(&reference);
        let res = ffmpeg::command("ffmpeg").unwrap().current_dir(&dir).args(&args).output().unwrap();
        assert!(res.status.success(), "{}", String::from_utf8_lossy(&res.stderr));

        assert_eq!(std::fs::read(&part).unwrap(), std::fs::read(&reference).unwrap(), "the GIF must not change");
        assert!(plan.palette_args.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (12) a hardware failure is redone in software -------- */

    fn hw_spec(dir: &std::path::Path, media: MediaRef) -> ExportSpec {
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![vtrack("v", vec![clip_at("c", "m1", 0.0, 0.0, 1.0)])], markers: vec![],
        };
        let mut preset = preset_640(30.0);
        preset.use_hardware = true;
        ExportSpec {
            media: vec![media], timeline: tl, preset,
            out_path: dir.join("hw.mp4").to_string_lossy().into_owned(),
        }
    }

    /// A "hardware" encoder that cannot run here (VA-API does not exist on
    /// Windows) stands in for a driver that passed the probe and then failed
    /// the real export. The job forgets that encoder, redoes the same export
    /// in software on the same `.part`, and reports the fallback; a cancel is
    /// never retried.
    #[test]
    fn e2e_a_failed_hardware_export_is_redone_in_software() {
        assert!(!encoder_available("h264_vaapi"), "premise: h264_vaapi cannot encode on this machine");
        let dir = case_dir("hw fallback");
        let (_src, media) = fixture_media(&dir);
        let report = crate::hw::EncoderReport {
            h264: "h264_vaapi".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        };
        let spec = hw_spec(&dir, media.clone());

        let prepared = prepare_export(&spec, &report, &dir).unwrap();
        assert_eq!(prepared.plan.encoder.as_deref(), Some("h264_vaapi"));
        let part = prepared.part.clone();
        let forgotten = std::cell::RefCell::new(Vec::<String>::new());
        let outcome = run_export(
            &spec,
            prepared,
            &dir,
            &mut direct_runner(&dir),
            &|| false,
            &|enc| forgotten.borrow_mut().push(enc.to_string()),
        );
        assert!(outcome.result.is_ok(), "{:?}", outcome.result.err().map(|f| f.message));
        assert!(outcome.hw_fallback);
        assert_eq!(*forgotten.borrow(), ["h264_vaapi"], "the failed encoder is forgotten");
        assert!(outcome.argv.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"), "{:?}", outcome.argv);
        let info = probe::probe_sync(part.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        decodes_cleanly(&part).unwrap();
        std::fs::remove_file(&part).unwrap();

        // A canceled hardware export stays canceled: no retry, nothing forgotten.
        let prepared = prepare_export(&spec, &report, &dir).unwrap();
        let forgotten = std::cell::RefCell::new(Vec::<String>::new());
        let outcome = run_export(
            &spec,
            prepared,
            &dir,
            &mut direct_runner(&dir),
            &|| true,
            &|enc| forgotten.borrow_mut().push(enc.to_string()),
        );
        assert!(outcome.result.is_err());
        assert!(!outcome.hw_fallback);
        assert!(forgotten.borrow().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------- (13) text export from a temp folder with an apostrophe -------- */

    /// The O'Brien case end to end: a text export run in a temp folder whose
    /// path holds an apostrophe encodes, because the graph names its textfile
    /// without the folder. (It used to be refused outright.)
    #[test]
    fn e2e_text_exports_from_a_temp_folder_with_an_apostrophe() {
        let dir = case_dir("o'brien");
        assert!(dir.to_string_lossy().contains('\''));
        let base = solid_media("base", "#000000");
        let text = MediaRef {
            id: "txt".into(), path: "Text".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(560), height: Some(120),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Text {
                text: "TAROTING".into(), font_family: "Arial".into(), size_px: 96.0,
                color: "#ffffff".into(), bold: true, italic: false,
            }),
            no_autorotate: None,
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![
                vtrack("vtop", vec![clip_at("t1", "txt", 0.0, 0.0, 1.0)]),
                vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 1.0)]),
            ],
            markers: vec![],
        };
        let out = dir.join("text.mp4");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec { media: vec![base, text], timeline: tl, preset: preset_640(30.0), out_path: out_s.clone() };
        let built = builder::build(&spec, &enc()).unwrap();
        let part = dir.join("text.mp4.part");
        run_built_in(&built, &out_s, &part, &dir);
        let text_band = yavg(&part, 0.5, 0, 130, 640, 100);
        assert!(text_band > 5.0, "the text must render: {text_band}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
