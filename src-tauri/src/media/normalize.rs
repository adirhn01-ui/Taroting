//! Peak analysis for the Normalize button: run ffmpeg volumedetect over a
//! clip's source range and suggest the gain that brings the peak to -1 dBFS.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::jobs::ffmpeg;
use crate::media::source::{source_file, INPUT_PROTOCOL_ARGS};

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

/// How long one analysis may run. It decodes only the clip's own range of
/// audio, which takes seconds even for an hour of it; the bound is for a
/// source that never answers (a share that went to sleep), which before this
/// held the Normalize button's task forever.
const SCAN_DEADLINE: Duration = Duration::from_secs(300);

/// The volumedetect pass over `[src_in, src_out]` of `src`, its input limited
/// to plain files (`media::source`): the path came out of a `.trt`.
fn scan_args(src: &Path, src_in: f64, src_out: f64) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-hide_banner".into()];
    args.push("-ss".into());
    args.push(format!("{src_in:.3}").into());
    args.push("-to".into());
    args.push(format!("{src_out:.3}").into());
    args.extend(INPUT_PROTOCOL_ARGS.iter().map(OsString::from));
    args.push("-i".into());
    args.push(src.into());
    for a in ["-map", "a:0", "-af", "volumedetect", "-f", "null", "-"] {
        args.push(a.into());
    }
    args
}

fn scan_sync(path: &str, src_in: f64, src_out: f64) -> Result<NormalizeResult> {
    let src = source_file(path)?;
    let mut cmd = ffmpeg::command("ffmpeg")?;
    cmd.args(scan_args(src, src_in, src_out));
    let out = ffmpeg::run_with_deadline(cmd, SCAN_DEADLINE)?.ok_or_else(|| {
        AppError::Ffmpeg("volume analysis took too long and was stopped".into())
    })?;
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

    /// The analysis argv, whole: the source limited to plain files right
    /// before its `-i`, and the range formatted as before.
    #[test]
    fn the_analysis_opens_its_source_as_a_file_only() {
        let args = scan_args(Path::new(r"C:\audio\take two.wav"), 1.5, 4.25);
        crate::media::source::assert_inputs_whitelisted(&args);
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            [
                "-hide_banner", "-ss", "1.500", "-to", "4.250",
                "-protocol_whitelist", "file", "-i", r"C:\audio\take two.wav",
                "-map", "a:0", "-af", "volumedetect", "-f", "null", "-",
            ]
        );
    }

    /// A URL or a device from a `.trt` is refused as bad input before any
    /// ffmpeg starts (a URL used to be fetched and analysed).
    #[test]
    fn a_path_that_is_not_a_file_is_refused() {
        for path in ["https://example.com/a.wav", r"\\.\pipe\a.wav", "a.wav"] {
            assert!(matches!(scan_sync(path, 0.0, 1.0), Err(AppError::BadInput(_))), "{path}");
        }
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
