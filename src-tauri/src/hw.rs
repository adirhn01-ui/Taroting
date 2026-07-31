//! Hardware encoder detection. Each candidate encoder is probed with a real
//! 0.5s test encode; the first that exits 0 wins per codec. Software fallbacks
//! (libx264/libx265/libsvtav1) are assumed usable without probing. The chosen
//! report is cached to %APPDATA%\Taroting\encoders.json, keyed by the ffmpeg
//! version string (re-probe when the version changes or `force` is set).

use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::jobs::ffmpeg;
use crate::paths;

/// The chosen encoder ffmpeg name per codec after probing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderReport {
    pub h264: String,
    pub hevc: String,
    pub av1: String,
    /// Human-readable probe results, e.g. "h264_nvenc: ok".
    pub detail: Vec<String>,
}

/// Wire shape for `detect_encoders`: the report plus the ffmpeg version it was
/// probed against. The version rides on this view rather than on
/// `EncoderReport` itself so the on-disk `encoders.json` shape stays untouched
/// — an existing cache keeps deserializing and nobody pays for a full re-probe
/// (real test encodes) on the first launch after an upgrade.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderReportView {
    #[serde(flatten)]
    pub report: EncoderReport,
    pub ffmpeg_version: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedReport {
    ffmpeg_version: String,
    report: EncoderReport,
}

const H264_CANDIDATES: &[&str] = &["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];
const HEVC_CANDIDATES: &[&str] = &["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"];
const AV1_CANDIDATES: &[&str] = &["av1_nvenc", "av1_qsv", "av1_amf", "libsvtav1"];

/// Software fallbacks that are always assumed present (skip probing).
fn is_software(enc: &str) -> bool {
    matches!(enc, "libx264" | "libx265" | "libsvtav1")
}

/// Read the ffmpeg version line (e.g. "ffmpeg version 8.1.1-...").
fn ffmpeg_version() -> String {
    match ffmpeg::run("ffmpeg", &["-version"]) {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap_or("unknown")
            .trim()
            .to_string(),
        Err(_) => "unknown".to_string(),
    }
}

/// Run a real 0.5s test encode; returns true when ffmpeg exits 0.
fn probe_encoder(enc: &str) -> bool {
    let cmd = ffmpeg::command("ffmpeg");
    let mut cmd = match cmd {
        Ok(c) => c,
        Err(_) => return false,
    };
    let status = cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=duration=0.5:size=640x360:rate=30",
            "-frames:v",
            "15",
            "-c:v",
            enc,
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status();
    matches!(status, Ok(s) if s.success())
}

/// Pick the first usable encoder from a candidate list. Software fallbacks are
/// accepted without probing. Records each attempt in `detail`.
fn choose(candidates: &[&str], detail: &mut Vec<String>) -> String {
    for &enc in candidates {
        if is_software(enc) {
            detail.push(format!("{enc}: assumed"));
            return enc.to_string();
        }
        if probe_encoder(enc) {
            detail.push(format!("{enc}: ok"));
            return enc.to_string();
        } else {
            detail.push(format!("{enc}: unavailable"));
        }
    }
    // Guaranteed software fallback per family.
    candidates.last().unwrap_or(&"libx264").to_string()
}

fn cache_file() -> Result<std::path::PathBuf> {
    let dir = paths::data_dir()?;
    Ok(dir.join("encoders.json"))
}

fn read_cache(path: &std::path::Path, version: &str) -> Option<EncoderReport> {
    let bytes = std::fs::read(path).ok()?;
    let cached: CachedReport = serde_json::from_slice(&bytes).ok()?;
    if cached.ffmpeg_version == version {
        Some(cached.report)
    } else {
        None
    }
}

fn write_cache(path: &std::path::Path, version: &str, report: &EncoderReport) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cached = CachedReport {
        ffmpeg_version: version.to_string(),
        report: report.clone(),
    };
    if let Ok(json) = serde_json::to_vec_pretty(&cached) {
        let _ = std::fs::write(path, json);
    }
}

/// Probe all codec families and build a report (bypasses cache).
pub fn probe_all() -> EncoderReport {
    let mut detail = Vec::new();
    let h264 = choose(H264_CANDIDATES, &mut detail);
    let hevc = choose(HEVC_CANDIDATES, &mut detail);
    let av1 = choose(AV1_CANDIDATES, &mut detail);
    EncoderReport { h264, hevc, av1, detail }
}

/// The report resolved for this process run, with the ffmpeg version it was
/// keyed by. Empty until the first `detect`.
///
/// The on-disk cache cannot be consulted without first spawning
/// `ffmpeg -version` — that string IS its key, and weakening the key is exactly
/// the invalidation a swapped binary depends on. So the spawn is removed one
/// level up instead: every detect after the first in a run answers from here and
/// spawns nothing at all.
///
/// A sidecar replaced WHILE the app runs is therefore not noticed until it
/// restarts. That is the correct trade: the version key exists so an app update
/// — which rewrites the sidecar and restarts the process — re-probes, and
/// `detect(true)` still bypasses this memo (and refreshes it), so an explicit
/// re-detect keeps working mid-session.
static MEMO: Mutex<Option<(EncoderReport, String)>> = Mutex::new(None);

/// Serve `resolve` once per run, unless `force` demands a fresh probe.
///
/// The lock is deliberately held across `resolve`: the export dialog kicks off a
/// background detect on open while the Export button starts another, and on a
/// cold cache each of those is up to nine real ~0.5 s test encodes. Serializing
/// makes the second wait for the first instead of duplicating the whole probe.
fn memoized<F>(
    memo: &Mutex<Option<(EncoderReport, String)>>,
    force: bool,
    resolve: F,
) -> (EncoderReport, String)
where
    F: FnOnce() -> (EncoderReport, String),
{
    // A poisoned lock still holds a perfectly good report, and encoder
    // detection must never be the thing that fails an export.
    let mut slot = memo.lock().unwrap_or_else(|e| e.into_inner());
    if !force {
        if let Some(hit) = slot.as_ref() {
            return hit.clone();
        }
    }
    let fresh = resolve();
    // Store even on a forced probe, so a re-detect can't leave the memo stale.
    *slot = Some(fresh.clone());
    fresh
}

/// Detect (or load cached) the best encoder per codec, together with the ffmpeg
/// version string the probe was keyed by. The version is computed anyway to key
/// the cache, so callers that need it (the export failure report) get it here
/// instead of paying for a second `ffmpeg -version` spawn.
pub fn detect(force: bool) -> (EncoderReport, String) {
    memoized(&MEMO, force, || match cache_file() {
        Ok(path) => detect_with_cache(force, &path),
        // No %APPDATA% to cache into: probe rather than fail the export.
        Err(_) => (probe_all(), ffmpeg_version()),
    })
}

/// `detect` against an explicit cache file. Tests point this at their own temp
/// file so a parallel run cannot race the shared `%APPDATA%` one.
fn detect_with_cache(force: bool, cache: &std::path::Path) -> (EncoderReport, String) {
    let version = ffmpeg_version();
    if !force {
        if let Some(cached) = read_cache(cache, &version) {
            return (cached, version);
        }
    }
    let report = probe_all();
    write_cache(cache, &version, &report);
    (report, version)
}

#[tauri::command]
pub async fn detect_encoders(force: bool) -> Result<EncoderReportView> {
    tauri::async_runtime::spawn_blocking(move || {
        let (report, ffmpeg_version) = detect(force);
        EncoderReportView { report, ffmpeg_version }
    })
    .await
    .map_err(|e| crate::error::AppError::Ffmpeg(format!("encoder detection failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_always_chosen_without_probe() {
        let mut detail = Vec::new();
        let enc = choose(&["libx264"], &mut detail);
        assert_eq!(enc, "libx264");
        assert!(detail.iter().any(|d| d.contains("assumed")));
    }

    /// End-to-end: force a probe, expect at least a usable h264 encoder
    /// (libx264 at minimum) and that the cache file is written. Runs against
    /// its OWN cache file — sharing the real `%APPDATA%` one made this flaky
    /// under parallel load (a half-written file reads back as a cache miss and
    /// silently re-probes).
    #[test]
    fn detect_returns_usable_h264_and_writes_cache() {
        let path = std::env::temp_dir()
            .join(format!("taroting-encoders-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let (report, _version) = detect_with_cache(true, &path);
        // must resolve to SOME encoder for each codec
        assert!(!report.h264.is_empty());
        assert!(!report.hevc.is_empty());
        assert!(!report.av1.is_empty());
        // h264 must at least fall back to libx264
        let ok_h264 = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]
            .contains(&report.h264.as_str());
        assert!(ok_h264, "unexpected h264 encoder: {}", report.h264);
        // cache file exists after detect
        assert!(path.exists(), "cache not written at {}", path.display());
        // second call (non-forced) should read cache and match version-keyed value
        let (again, _) = detect_with_cache(false, &path);
        assert_eq!(again.h264, report.h264);

        let _ = std::fs::remove_file(&path);
    }

    /// A version string keyed with the report so the export failure report can
    /// name the exact binary without a second `ffmpeg -version` spawn. Non-empty
    /// even when the sidecar is missing ("unknown").
    #[test]
    fn ffmpeg_version_is_never_empty() {
        let version = ffmpeg_version();
        assert!(!version.trim().is_empty(), "empty ffmpeg version");
    }

    /// A stale cache keyed to a different ffmpeg version must be ignored.
    #[test]
    fn cache_is_keyed_by_ffmpeg_version() {
        let path = std::env::temp_dir()
            .join(format!("taroting-encoders-key-{}.json", std::process::id()));
        let report = EncoderReport {
            h264: "h264_nvenc".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        };
        write_cache(&path, "ffmpeg version 8.1.1", &report);
        assert_eq!(
            read_cache(&path, "ffmpeg version 8.1.1").map(|r| r.h264),
            Some("h264_nvenc".to_string())
        );
        assert!(
            read_cache(&path, "ffmpeg version 9.0.0").is_none(),
            "a different ffmpeg version must invalidate the cache"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The memo is what makes a repeat export click free, so pin all three of
    /// its properties: it serves the second call without resolving again, a
    /// forced detect still re-probes, and a forced detect REFRESHES it rather
    /// than leaving a stale report behind. Driven through an owned memo cell
    /// with a counting resolver, so no real ffmpeg is spawned.
    #[test]
    fn memo_serves_repeat_detects_and_force_refreshes_it() {
        let memo: Mutex<Option<(EncoderReport, String)>> = Mutex::new(None);
        let calls = std::cell::Cell::new(0u32);
        let probe = |tag: &str| {
            calls.set(calls.get() + 1);
            (
                EncoderReport {
                    h264: tag.to_string(),
                    hevc: "libx265".into(),
                    av1: "libsvtav1".into(),
                    detail: vec![],
                },
                format!("ffmpeg version {tag}"),
            )
        };

        let first = memoized(&memo, false, || probe("a"));
        assert_eq!(calls.get(), 1);
        assert_eq!(first.0.h264, "a");

        // The export click after the dialog's background detect: no spawn.
        let again = memoized(&memo, false, || probe("b"));
        assert_eq!(calls.get(), 1, "a repeat detect must not re-probe");
        assert_eq!(again.0.h264, "a");
        assert_eq!(again.1, "ffmpeg version a", "the version rides with the memo");

        // force still bypasses it...
        let forced = memoized(&memo, true, || probe("c"));
        assert_eq!(calls.get(), 2, "force must re-probe");
        assert_eq!(forced.0.h264, "c");

        // ...and the refreshed value is what later callers see.
        let after = memoized(&memo, false, || probe("d"));
        assert_eq!(calls.get(), 2);
        assert_eq!(after.0.h264, "c", "force must not leave a stale memo");
    }

    /// The wire shape must stay a flat superset of `EncoderReport` — the cached
    /// on-disk form is unchanged, but the frontend sees `ffmpegVersion`.
    #[test]
    fn encoder_report_view_flattens_to_camel_case_superset() {
        let view = EncoderReportView {
            report: EncoderReport {
                h264: "libx264".into(),
                hevc: "libx265".into(),
                av1: "libsvtav1".into(),
                detail: vec!["libx264: assumed".into()],
            },
            ffmpeg_version: "ffmpeg version 8.1.1".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&view).unwrap();
        assert_eq!(v["h264"], "libx264");
        assert_eq!(v["detail"][0], "libx264: assumed");
        assert_eq!(v["ffmpegVersion"], "ffmpeg version 8.1.1");
        // no nested "report" key — the view is flat.
        assert!(v.get("report").is_none());
    }
}
