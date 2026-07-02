//! Hardware encoder detection. Each candidate encoder is probed with a real
//! 0.5s test encode; the first that exits 0 wins per codec. Software fallbacks
//! (libx264/libx265/libsvtav1) are assumed usable without probing. The chosen
//! report is cached to %APPDATA%\Taroting\encoders.json, keyed by the ffmpeg
//! version string (re-probe when the version changes or `force` is set).

use std::process::Stdio;

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

fn read_cache(version: &str) -> Option<EncoderReport> {
    let path = cache_file().ok()?;
    let bytes = std::fs::read(path).ok()?;
    let cached: CachedReport = serde_json::from_slice(&bytes).ok()?;
    if cached.ffmpeg_version == version {
        Some(cached.report)
    } else {
        None
    }
}

fn write_cache(version: &str, report: &EncoderReport) {
    let Ok(path) = cache_file() else { return };
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

/// Detect (or load cached) the best encoder per codec.
pub fn detect(force: bool) -> EncoderReport {
    let version = ffmpeg_version();
    if !force {
        if let Some(cached) = read_cache(&version) {
            return cached;
        }
    }
    let report = probe_all();
    write_cache(&version, &report);
    report
}

#[tauri::command]
pub async fn detect_encoders(force: bool) -> Result<EncoderReport> {
    tauri::async_runtime::spawn_blocking(move || detect(force))
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
    /// (libx264 at minimum) and that the cache file is written.
    #[test]
    fn detect_returns_usable_h264_and_writes_cache() {
        let report = detect(true);
        // must resolve to SOME encoder for each codec
        assert!(!report.h264.is_empty());
        assert!(!report.hevc.is_empty());
        assert!(!report.av1.is_empty());
        // h264 must at least fall back to libx264
        let ok_h264 = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]
            .contains(&report.h264.as_str());
        assert!(ok_h264, "unexpected h264 encoder: {}", report.h264);
        // cache file exists after detect
        let path = cache_file().unwrap();
        assert!(path.exists(), "cache not written at {}", path.display());
        // second call (non-forced) should read cache and match version-keyed value
        let again = detect(false);
        assert_eq!(again.h264, report.h264);
    }
}
