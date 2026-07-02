//! Peak analysis for the Normalize button: run ffmpeg volumedetect over a
//! clip's source range and suggest the gain that brings the peak to -1 dBFS.

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::jobs::ffmpeg;

pub const TARGET_PEAK_DB: f64 = -1.0;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeResult {
    pub max_volume_db: f64,
    pub suggested_gain_db: f64,
}

/// Parse `[Parsed_volumedetect_0 @ …] max_volume: -12.4 dB` from stderr.
pub fn parse_max_volume(stderr: &str) -> Option<f64> {
    for line in stderr.lines() {
        if let Some(idx) = line.find("max_volume:") {
            let rest = line[idx + "max_volume:".len()..].trim();
            let num = rest.split_whitespace().next()?;
            return num.parse().ok();
        }
    }
    None
}

fn scan_sync(path: &str, src_in: f64, src_out: f64) -> Result<NormalizeResult> {
    let out = ffmpeg::command("ffmpeg")?
        .args([
            "-hide_banner",
            "-ss", &format!("{src_in:.3}"),
            "-to", &format!("{src_out:.3}"),
            "-i", path,
            "-map", "a:0",
            "-af", "volumedetect",
            "-f", "null", "-",
        ])
        .output()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Err(AppError::Ffmpeg(format!(
            "volume analysis failed: {}",
            stderr.lines().last().unwrap_or("")
        )));
    }
    let max = parse_max_volume(&stderr)
        .ok_or_else(|| AppError::Ffmpeg("no max_volume in volumedetect output".into()))?;
    Ok(NormalizeResult {
        max_volume_db: max,
        suggested_gain_db: ((TARGET_PEAK_DB - max) * 10.0).round() / 10.0,
    })
}

#[tauri::command]
pub async fn normalize_scan(path: String, src_in: f64, src_out: f64) -> Result<NormalizeResult> {
    tauri::async_runtime::spawn_blocking(move || scan_sync(&path, src_in, src_out))
        .await
        .map_err(|e| AppError::Ffmpeg(format!("normalize task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_volumedetect_output() {
        let stderr = "\
[Parsed_volumedetect_0 @ 0000021] n_samples: 441000
[Parsed_volumedetect_0 @ 0000021] mean_volume: -21.4 dB
[Parsed_volumedetect_0 @ 0000021] max_volume: -6.3 dB
[Parsed_volumedetect_0 @ 0000021] histogram_6db: 12
";
        assert_eq!(parse_max_volume(stderr), Some(-6.3));
        assert_eq!(parse_max_volume("no volume here"), None);
    }

    /// E2E: a -20 dB sine peak should suggest ≈ +19 dB of gain.
    #[test]
    fn scans_a_real_tone() {
        let dir = std::env::temp_dir().join("taroting normalize test");
        std::fs::create_dir_all(&dir).unwrap();
        let tone = dir.join("quiet tone.wav");
        // Regenerate every run so a stale/differently-scaled fixture can't
        // wedge the assertion. aevalsrc gives a build-independent 0.1 amplitude
        // (== -20 dBFS peak); the `sine` filter's amplitude varies by ffmpeg
        // build, so we don't rely on it here.
        {
            let out = ffmpeg::command("ffmpeg")
                .unwrap()
                .args([
                    "-y",
                    "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*440*t):d=2",
                    tone.to_str().unwrap(),
                ])
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        let r = scan_sync(tone.to_str().unwrap(), 0.0, 2.0).unwrap();
        assert!(
            (r.max_volume_db + 20.0).abs() < 1.5,
            "expected ≈ -20 dB peak, got {}",
            r.max_volume_db
        );
        assert!((r.suggested_gain_db - 19.0).abs() < 1.6);
    }
}
