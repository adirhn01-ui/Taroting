//! Peak analysis for the Normalize button: run ffmpeg volumedetect over a
//! clip's source range and suggest the gain that brings the peak to -1 dBFS.

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::jobs::ffmpeg;

pub const TARGET_PEAK_DB: f64 = -1.0;

/// At or below this the selection is silence, not quiet audio: volumedetect
/// bottoms out at `max_volume: -91.0 dB` for an all-zero signal, and naively
/// targeting -1 dBFS from there suggests **+90 dB** — the builder emits
/// `volume=31622.7766` and the export hard-clips.
const SILENCE_FLOOR_DB: f64 = -90.0;
/// Bounds on the suggested correction. Anything outside this is a measurement
/// artefact rather than a gain a user wants applied to their timeline.
const MIN_GAIN_DB: f64 = -40.0;
const MAX_GAIN_DB: f64 = 30.0;

/// Turn a measured peak into a suggestion, or reject it. Kept pure (no ffmpeg)
/// so the silence and non-finite guards are directly testable.
fn result_for_max(max: f64) -> Result<NormalizeResult> {
    // `parse_max_volume` goes through `str::parse::<f64>`, which happily accepts
    // "inf"/"-inf"/"NaN". A non-finite gain serializes to JSON `null`, which
    // then permanently blocks `save_project` on that clip.
    if !max.is_finite() {
        return Err(AppError::BadInput(
            "could not measure this selection's peak level".into(),
        ));
    }
    if max <= SILENCE_FLOOR_DB {
        return Err(AppError::BadInput(
            "this selection is silent — nothing to normalize".into(),
        ));
    }
    let gain = ((TARGET_PEAK_DB - max) * 10.0).round() / 10.0;
    Ok(NormalizeResult {
        max_volume_db: max,
        suggested_gain_db: gain.clamp(MIN_GAIN_DB, MAX_GAIN_DB),
    })
}

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
    result_for_max(max)
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

    #[test]
    fn rejects_silence_instead_of_suggesting_90db() {
        // volumedetect's floor for digital silence. Unbounded, this asked for
        // +90 dB (volume=31622.7766) and hard-clipped the export.
        for silent in [-91.0, -90.0, -120.0, f64::NEG_INFINITY] {
            let err = result_for_max(silent).unwrap_err();
            assert!(
                matches!(err, AppError::BadInput(_)),
                "{silent} dB should be BadInput, got {err:?}"
            );
        }
        // Genuinely quiet-but-real audio is still normalizable.
        assert!(result_for_max(-89.0).is_ok());
    }

    #[test]
    fn rejects_non_finite_max_volume() {
        // `str::parse::<f64>` accepts these, so they really do reach us; a
        // non-finite gain serializes to `null` and blocks save_project forever.
        assert_eq!(
            parse_max_volume("[x] max_volume: inf dB"),
            Some(f64::INFINITY)
        );
        assert!(parse_max_volume("[x] max_volume: NaN dB").unwrap().is_nan());

        for bad in [f64::INFINITY, f64::NAN] {
            let err = result_for_max(bad).unwrap_err();
            assert!(matches!(err, AppError::BadInput(_)), "got {err:?}");
        }
    }

    #[test]
    fn normal_peak_is_unchanged_and_extremes_are_clamped() {
        // The ordinary path keeps its exact one-decimal suggestion.
        let r = result_for_max(-6.3).unwrap();
        assert_eq!(r.max_volume_db, -6.3);
        assert!((r.suggested_gain_db - 5.3).abs() < 1e-9, "{r:?}");

        // Already-loud audio suggests attenuation, still unclamped in range.
        assert!((result_for_max(3.0).unwrap().suggested_gain_db + 4.0).abs() < 1e-9);

        // Only implausible corrections are bounded.
        assert_eq!(result_for_max(-80.0).unwrap().suggested_gain_db, 30.0);
        assert_eq!(result_for_max(60.0).unwrap().suggested_gain_db, -40.0);
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
