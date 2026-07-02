//! ffprobe wrapper: probe a media file into structured MediaInfo.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::jobs::ffmpeg;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    /// "video" | "audio" | "image" | "gif"
    pub kind: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<Rational>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pix_fmt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    pub has_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_channels: Option<u32>,
}

/* ffprobe JSON shapes (only the fields we read) */

#[derive(Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    duration: Option<String>,
    bits_per_raw_sample: Option<String>,
    nb_frames: Option<String>,
    #[serde(default)]
    disposition: FfDisposition,
}

#[derive(Deserialize, Default)]
struct FfDisposition {
    #[serde(default)]
    attached_pic: i32,
}

#[derive(Deserialize)]
struct FfFormat {
    format_name: Option<String>,
    duration: Option<String>,
}

#[derive(Deserialize)]
struct FfProbeOut {
    #[serde(default)]
    streams: Vec<FfStream>,
    format: Option<FfFormat>,
}

pub fn parse_rational(s: &str) -> Option<Rational> {
    let (n, d) = s.split_once('/')?;
    let num: u32 = n.trim().parse().ok()?;
    let den: u32 = d.trim().parse().ok()?;
    if num == 0 || den == 0 {
        return None;
    }
    Some(Rational { num, den })
}

fn parse_f64(s: &Option<String>) -> Option<f64> {
    s.as_deref()?.parse().ok()
}

pub fn probe_sync(path: &str) -> Result<MediaInfo> {
    let meta = std::fs::metadata(path)?;
    let mtime_ms = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let out = ffmpeg::run(
        "ffprobe",
        &[
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ],
    )?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::Ffmpeg(format!(
            "ffprobe failed for {path}: {}",
            err.trim()
        )));
    }
    let parsed: FfProbeOut = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Ffmpeg(format!("ffprobe JSON parse: {e}")))?;

    let container = parsed.format.as_ref().and_then(|f| f.format_name.clone());

    let video = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0);
    let audio = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let duration = parsed
        .format
        .as_ref()
        .and_then(|f| parse_f64(&f.duration))
        .or_else(|| video.and_then(|v| parse_f64(&v.duration)))
        .or_else(|| audio.and_then(|a| parse_f64(&a.duration)))
        .unwrap_or(0.0);

    let fps = video.and_then(|v| {
        v.avg_frame_rate
            .as_deref()
            .and_then(parse_rational)
            .or_else(|| v.r_frame_rate.as_deref().and_then(parse_rational))
    });

    let is_gif = container.as_deref().is_some_and(|c| c.contains("gif"));
    let single_frame =
        video.and_then(|v| v.nb_frames.as_deref()) == Some("1") && audio.is_none();
    let is_image = !is_gif
        && (container
            .as_deref()
            .is_some_and(|c| c.contains("image2") || c.contains("_pipe"))
            || single_frame);

    let kind = if is_gif {
        "gif"
    } else if is_image {
        "image"
    } else if video.is_some() {
        "video"
    } else if audio.is_some() {
        "audio"
    } else {
        return Err(AppError::Ffmpeg(format!("no decodable streams in {path}")));
    };

    let bit_depth = video.and_then(|v| {
        v.bits_per_raw_sample
            .as_deref()
            .and_then(|b| b.parse().ok())
            .or_else(|| {
                v.pix_fmt.as_deref().map(|p| {
                    if p.contains("10le") || p.contains("10be") {
                        10
                    } else if p.contains("12le") || p.contains("12be") {
                        12
                    } else {
                        8
                    }
                })
            })
    });

    Ok(MediaInfo {
        path: path.to_string(),
        size: meta.len(),
        mtime_ms,
        kind: kind.to_string(),
        duration,
        fps,
        width: video.and_then(|v| v.width),
        height: video.and_then(|v| v.height),
        container,
        vcodec: video.and_then(|v| v.codec_name.clone()),
        acodec: audio.and_then(|a| a.codec_name.clone()),
        pix_fmt: video.and_then(|v| v.pix_fmt.clone()),
        bit_depth,
        has_audio: audio.is_some(),
        audio_rate: audio.and_then(|a| a.sample_rate.as_deref().and_then(|r| r.parse().ok())),
        audio_channels: audio.and_then(|a| a.channels),
    })
}

#[tauri::command]
pub async fn probe_media(path: String) -> Result<MediaInfo> {
    tauri::async_runtime::spawn_blocking(move || probe_sync(&path))
        .await
        .map_err(|e| AppError::Ffmpeg(format!("probe task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: encode a tiny fixture with the ffmpeg sidecar (path with a
    /// space, on purpose), then probe it and check every field we rely on.
    #[test]
    fn probes_a_real_video_file() {
        let dir = std::env::temp_dir().join("taroting probe test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fixture video.mp4");
        if !file.exists() {
            let out = ffmpeg::run(
                "ffmpeg",
                &[
                    "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest",
                    file.to_str().unwrap(),
                ],
            )
            .unwrap();
            assert!(
                out.status.success(),
                "fixture encode failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let info = probe_sync(file.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "video");
        assert!(info.has_audio);
        assert_eq!(info.width, Some(320));
        assert_eq!(info.height, Some(180));
        assert_eq!(info.fps, Some(Rational { num: 30, den: 1 }));
        assert!((info.duration - 2.0).abs() < 0.25, "duration {}", info.duration);
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert_eq!(info.acodec.as_deref(), Some("aac"));
        assert_eq!(info.bit_depth, Some(8));
        assert!(info.size > 0);
    }

    #[test]
    fn rational_parsing() {
        assert_eq!(
            parse_rational("30000/1001"),
            Some(Rational {
                num: 30000,
                den: 1001
            })
        );
        assert_eq!(parse_rational("25/1"), Some(Rational { num: 25, den: 1 }));
        assert_eq!(parse_rational("0/0"), None);
        assert_eq!(parse_rational("garbage"), None);
    }
}
