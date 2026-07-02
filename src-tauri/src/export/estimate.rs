//! Output size estimation. Custom-bitrate mode is exact; auto (quality) mode
//! uses a bits-per-pixel heuristic and is flagged inexact.

use serde::Serialize;

use crate::error::Result;
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

pub fn estimate(spec: &ExportSpec) -> SizeEstimate {
    let preset = &spec.preset;
    let dur = spec.timeline.duration().max(0.0);
    let (w, h) = preset.output_dims(spec.timeline.width, spec.timeline.height);
    let fps = preset.fps_value(&spec.timeline).max(1.0);

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

#[tauri::command]
pub fn estimate_export(spec: ExportSpec) -> Result<SizeEstimate> {
    Ok(estimate(&spec))
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
}
