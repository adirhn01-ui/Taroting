//! Output size estimation. Custom-bitrate mode is exact; auto (quality) mode
//! uses a bits-per-pixel heuristic and is flagged inexact.

use serde::Serialize;

use crate::error::Result;
use crate::export::model::{EstimateInput, ExportPreset};
#[cfg(test)]
use crate::export::model::ExportSpec;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeEstimate {
    pub bytes: u64,
    pub exact: bool,
}

/// Bits-per-pixel heuristic per video codec (auto mode).
fn bpp(vcodec: &str) -> f64 {
    match vcodec {
        "hevc" => 0.065,
        "av1" => 0.05,
        _ => 0.10, // h264 and anything else
    }
}

/// Estimate from the four scalars the answer actually depends on. This is the
/// whole implementation; both entry points below funnel into it.
fn estimate_core(
    duration_sec: f64,
    timeline_w: u32,
    timeline_h: u32,
    timeline_fps: f64,
    preset: &ExportPreset,
) -> SizeEstimate {
    let dur = duration_sec.max(0.0);
    let (w, h) = preset.output_dims(timeline_w, timeline_h);
    let fps = preset.fps_value(timeline_fps).max(1.0);

    if preset.format == "gif" {
        // gif ≈ W*H*fps*dur*0.13 bytes; fps capped at 30
        let gfps = fps.min(30.0);
        let bytes = (w as f64 * h as f64 * gfps * dur * 0.13).round() as u64;
        return SizeEstimate { bytes, exact: false };
    }

    // Determine whether video bitrate is custom (exact) or auto.
    let video_custom = preset.video_bitrate.kbps();
    let audio_custom = preset.audio_bitrate.kbps();

    if let Some(vk) = video_custom {
        // custom-bitrate mode: exact. If audio is also custom use it; else
        // fall back to the auto audio figure but still report exact since the
        // dominant term (video) is exact.
        let ak = audio_custom.unwrap_or_else(|| auto_audio_kbps(&preset.format));
        let bytes = ((vk + ak) as f64 * 1000.0 / 8.0 * dur).round() as u64;
        return SizeEstimate { bytes, exact: true };
    }

    // auto (quality) mode: bits-per-pixel heuristic
    let video_bits = w as f64 * h as f64 * fps * bpp(&preset.vcodec) * dur;
    let ak = audio_custom.unwrap_or_else(|| auto_audio_kbps(&preset.format));
    let audio_bits = ak as f64 * 1000.0 * dur;
    let bytes = ((video_bits + audio_bits) / 8.0).round() as u64;
    SizeEstimate { bytes, exact: false }
}

/// Auto audio bitrate by container: 192kbps generally, 160k for webm (opus).
fn auto_audio_kbps(format: &str) -> u64 {
    match format {
        "webm" => 160,
        _ => 192,
    }
}

/// The estimate as the frontend asks for it: four scalars and the preset.
pub fn estimate_size(input: &EstimateInput) -> SizeEstimate {
    estimate_core(
        input.duration_sec,
        input.width,
        input.height,
        input.fps,
        &input.preset,
    )
}

/// The same estimate entered from a full `ExportSpec`.
///
/// Nothing in a running build takes this path any more — the dialog sends
/// `EstimateInput` — but it is what proves the reduced payload is not a
/// behaviour change: the tests below run both entry points over the same
/// project and assert the byte counts match. Test-only so the shipped binary
/// carries no path that can silently start walking a whole project again.
#[cfg(test)]
pub fn estimate(spec: &ExportSpec) -> SizeEstimate {
    estimate_core(
        spec.timeline.duration(),
        spec.timeline.width,
        spec.timeline.height,
        spec.timeline.fps.num as f64 / spec.timeline.fps.den.max(1) as f64,
        &spec.preset,
    )
}

#[tauri::command]
pub fn estimate_export(input: EstimateInput) -> Result<SizeEstimate> {
    Ok(estimate_size(&input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::model::*;
    use crate::project::schema::*;

    fn media() -> MediaRef {
        MediaRef {
            id: "m1".into(),
            path: r"C:\v.mp4".into(),
            size: 1,
            mtime_ms: 1,
            kind: "video".into(),
            duration: 100.0,
            fps: Some(Rational { num: 30, den: 1 }),
            width: Some(1920),
            height: Some(1080),
            container: Some("mp4".into()),
            vcodec: Some("h264".into()),
            acodec: Some("aac".into()),
            pix_fmt: Some("yuv420p".into()),
            bit_depth: Some(8),
            has_audio: true,
            audio_rate: Some(48000),
            audio_channels: Some(2),
            generator: None,
        }
    }

    fn spec_with(preset: ExportPreset, dur_out: f64) -> ExportSpec {
        let clip = Clip {
            id: "c1".into(),
            media_id: "m1".into(),
            timeline_start: 0.0,
            src_in: 0.0,
            src_out: dur_out,
            speed: 1.0,
            transform: None,
            audio: ClipAudio {
                volume: 1.0,
                muted: false,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                gain_offset_db: 0.0,
                detached: false,
            },
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(),
            kind: "video".into(),
            name: "Video".into(),
            muted: false,
            clips: vec![clip],
        };
        ExportSpec {
            media: vec![media()],
            timeline: Timeline {
                fps: Rational { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                tracks: vec![track],
                markers: vec![],
            },
            preset,
            out_path: r"C:\o.mp4".into(),
        }
    }

    /// The derivation the export dialog now performs in TypeScript, mirrored
    /// here so both entry points can be run over the exact same project.
    fn input_for(spec: &ExportSpec) -> EstimateInput {
        EstimateInput {
            duration_sec: spec.timeline.duration(),
            width: spec.timeline.width,
            height: spec.timeline.height,
            fps: spec.timeline.fps.num as f64 / spec.timeline.fps.den.max(1) as f64,
            preset: spec.preset.clone(),
        }
    }

    fn preset() -> ExportPreset {
        ExportPreset {
            format: "mp4".into(),
            vcodec: "h264".into(),
            resolution: ResolutionPreset::Named("original".into()),
            fps: FpsPreset::Original("original".into()),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        }
    }

    #[test]
    fn custom_bitrate_is_exact() {
        let mut p = preset();
        p.video_bitrate = BitratePreset::Kbps(5000);
        p.audio_bitrate = BitratePreset::Kbps(128);
        // 10 second output
        let est = estimate(&spec_with(p, 10.0));
        assert!(est.exact);
        // (5000+128)*1000/8*10 = 6,410,000
        assert_eq!(est.bytes, 6_410_000);
    }

    #[test]
    fn auto_mode_is_inexact_and_uses_bpp() {
        let est = estimate(&spec_with(preset(), 10.0));
        assert!(!est.exact);
        // video: 1920*1080*30*0.10*10 = 62,208,000 bits
        // audio: 192*1000*10 = 1,920,000 bits
        // total /8 = 8,016,000
        assert_eq!(est.bytes, 8_016_000);
    }

    #[test]
    fn gif_estimate() {
        let mut p = preset();
        p.format = "gif".into();
        let est = estimate(&spec_with(p, 2.0));
        assert!(!est.exact);
        // 1920*1080*30*2*0.13 = 16,174,080
        assert_eq!(est.bytes, 16_174_080);
    }

    /// The point of the reduced payload: the four scalars the dialog sends must
    /// produce exactly what the whole project produced. Covers every branch of
    /// the estimator (custom bitrate, auto/bpp, gif) plus a scaled resolution
    /// and a custom fps, since those are the fields the reduction touches.
    #[test]
    fn reduced_input_matches_the_full_spec_path() {
        let mut scaled = preset();
        scaled.resolution = ResolutionPreset::Named("720p".into());
        let mut custom_fps = preset();
        custom_fps.fps = FpsPreset::Custom(23.976);
        let mut custom_bitrate = preset();
        custom_bitrate.video_bitrate = BitratePreset::Kbps(5000);
        custom_bitrate.audio_bitrate = BitratePreset::Kbps(128);
        let mut gif = preset();
        gif.format = "gif".into();
        let mut webm = preset();
        webm.format = "webm".into();
        webm.vcodec = "av1".into();

        for p in [preset(), scaled, custom_fps, custom_bitrate, gif, webm] {
            let spec = spec_with(p, 7.5);
            let full = estimate(&spec);
            let reduced = estimate_size(&input_for(&spec));
            assert_eq!(full.bytes, reduced.bytes);
            assert_eq!(full.exact, reduced.exact);
            // and the command itself agrees with both
            let via_command = estimate_export(input_for(&spec)).unwrap();
            assert_eq!(via_command.bytes, full.bytes);
        }
    }

    /// A fractional timeline rate reaches the estimator as `num / den`. NTSC is
    /// the case that would expose a rounding difference between the two paths.
    #[test]
    fn ntsc_timeline_fps_survives_the_reduction() {
        let mut spec = spec_with(preset(), 10.0);
        spec.timeline.fps = Rational { num: 30000, den: 1001 };
        let full = estimate(&spec);
        assert_eq!(estimate_size(&input_for(&spec)).bytes, full.bytes);
        // video: 1920*1080*(30000/1001)*0.10*10 bits, audio: 192*1000*10 bits
        let fps: f64 = 30000.0 / 1001.0;
        let expected: f64 = ((1920.0 * 1080.0 * fps * 0.10 * 10.0) + (192_000.0 * 10.0)) / 8.0;
        assert_eq!(full.bytes, expected.round() as u64);
    }

    /// Guard the wire contract: the payload the dialog builds must deserialize,
    /// and it must stay small. If a project field ever creeps back into this
    /// type, this fails long before anyone notices the UI-thread stall.
    #[test]
    fn estimate_payload_is_camel_case_and_tiny() {
        let json = r#"{
            "durationSec": 10.0, "width": 1920, "height": 1080, "fps": 30.0,
            "preset": {
                "format": "mp4", "vcodec": "h264", "resolution": "original",
                "fps": "original", "videoBitrate": "auto", "audioBitrate": "auto",
                "useHardware": false
            }
        }"#;
        let input: EstimateInput = serde_json::from_str(json).unwrap();
        assert_eq!(estimate_size(&input).bytes, 8_016_000);
        assert!(serde_json::to_string(&input).unwrap().len() < 256);
    }
}
