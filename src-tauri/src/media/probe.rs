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
    /// Carries the Display Matrix on a rotated recording. Without this the
    /// rotation was invisible here — see `display_rotation`.
    #[serde(default)]
    side_data_list: Vec<FfSideData>,
    #[serde(default)]
    tags: FfStreamTags,
}

#[derive(Deserialize, Default)]
struct FfDisposition {
    #[serde(default)]
    attached_pic: i32,
}

#[derive(Deserialize)]
struct FfSideData {
    side_data_type: Option<String>,
    /// Signed degrees. ffprobe reports 270° as -90 and 180° as -180, and some
    /// builds print it as a float, so this is read as f64 and normalised.
    rotation: Option<f64>,
}

#[derive(Deserialize, Default)]
struct FfStreamTags {
    /// The pre-side-data spelling: a container-level `rotate` tag, still written
    /// by plenty of cameras and by older ffmpeg builds.
    rotate: Option<String>,
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

/// Degrees folded into [0, 360) and snapped to a quarter turn.
///
/// ffprobe reports the display rotation SIGNED — 270° comes back as -90 and
/// 180° as -180 — and a phone that was not held perfectly square can write a
/// matrix that decodes to something like 89.97, so rounding to the nearest
/// quarter turn is what makes the value usable. A non-finite value means the
/// matrix was nonsense; treat that as no rotation rather than guessing.
fn normalize_rotation(deg: f64) -> u32 {
    if !deg.is_finite() {
        return 0;
    }
    let quarters = (deg / 90.0).round() as i64;
    (quarters.rem_euclid(4) as u32) * 90
}

/// The stream's display rotation in degrees, from either place ffprobe puts it.
fn display_rotation(stream: &FfStream) -> u32 {
    let deg = stream
        .side_data_list
        .iter()
        .find(|s| s.side_data_type.as_deref() == Some("Display Matrix"))
        .and_then(|s| s.rotation)
        .or_else(|| stream.tags.rotate.as_deref().and_then(|r| r.trim().parse().ok()))
        .unwrap_or(0.0);
    normalize_rotation(deg)
}

/// Whether a display rotation transposes the frame.
///
/// ffmpeg autorotates on decode (there is no `-noautorotate` anywhere in this
/// codebase), so on a quarter turn the frame that actually reaches the
/// filtergraph is the transpose of the CODED size ffprobe reports — a 1920x1080
/// portrait phone recording decodes to 1080x1920. The preview agrees: the
/// `<video>` element autorotates too. A half turn flips both axes and leaves
/// the dimensions alone.
fn swaps_dimensions(rotation: u32) -> bool {
    rotation == 90 || rotation == 270
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

    // Record the dimensions of the frame that will be DECODED, not the coded
    // ones: every consumer (the filtergraph the export builds, the canvas the
    // timeline adopts, the preview's <video>) sees the autorotated frame, so
    // storing the coded size on a portrait recording made all three disagree
    // with the pixels — a stretched export at best, and a hard `blend` /`crop`
    // size-mismatch abort as soon as the clip carried an opacity keyframe or a
    // crop.
    let (width, height) = match (video.and_then(|v| v.width), video.and_then(|v| v.height)) {
        (Some(w), Some(h)) if video.is_some_and(|v| swaps_dimensions(display_rotation(v))) => {
            (Some(h), Some(w))
        }
        wh => wh,
    };

    Ok(MediaInfo {
        path: path.to_string(),
        size: meta.len(),
        mtime_ms,
        kind: kind.to_string(),
        duration,
        fps,
        width,
        height,
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

    /// ffprobe's signed, occasionally fractional degrees folded into the four
    /// quarter turns. -90 IS 270: that spelling is what a 270° recording
    /// actually probes as, and reading it as "no rotation" is the whole bug.
    #[test]
    fn rotation_normalizes_every_spelling_ffprobe_uses() {
        assert_eq!(normalize_rotation(0.0), 0);
        assert_eq!(normalize_rotation(90.0), 90);
        assert_eq!(normalize_rotation(180.0), 180);
        assert_eq!(normalize_rotation(270.0), 270);
        // the signed forms ffprobe emits for 270 and 180
        assert_eq!(normalize_rotation(-90.0), 270);
        assert_eq!(normalize_rotation(-180.0), 180);
        assert_eq!(normalize_rotation(-270.0), 90);
        // wrapped and off-axis values still land on a real quarter turn
        assert_eq!(normalize_rotation(360.0), 0);
        assert_eq!(normalize_rotation(450.0), 90);
        assert_eq!(normalize_rotation(89.97), 90);
        assert_eq!(normalize_rotation(-0.03), 0);
        // a nonsense matrix must not invent a rotation
        assert_eq!(normalize_rotation(f64::NAN), 0);
        assert_eq!(normalize_rotation(f64::INFINITY), 0);

        // only a quarter turn transposes; a half turn keeps the dimensions
        assert!(swaps_dimensions(90));
        assert!(swaps_dimensions(270));
        assert!(!swaps_dimensions(0));
        assert!(!swaps_dimensions(180));
    }

    /// Encode a landscape fixture, stamp `deg` of display rotation onto a
    /// stream copy of it (exactly the shape a portrait phone recording has:
    /// coded landscape + a Display Matrix), and return the rotated file.
    fn rotated_fixture(dir: &std::path::Path, deg: i32) -> std::path::PathBuf {
        let flat = dir.join("flat landscape.mp4");
        if !flat.exists() {
            let out = ffmpeg::run(
                "ffmpeg",
                &[
                    "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    flat.to_str().unwrap(),
                ],
            )
            .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let rotated = dir.join(format!("rotated {deg}.mp4"));
        // `-display_rotation` on the INPUT + `-c copy` writes the matrix through
        // to the output without touching the pixels, so the coded size stays
        // 640x360 and only the metadata says otherwise.
        let out = ffmpeg::run(
            "ffmpeg",
            &[
                "-y",
                "-display_rotation", &deg.to_string(),
                "-i", flat.to_str().unwrap(),
                "-c", "copy",
                rotated.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        rotated
    }

    /// The dimensions ffmpeg ACTUALLY decodes `path` to, measured by decoding
    /// one frame to a PNG and probing that. This is the ground truth every
    /// consumer sees, and what `probe_sync` has to agree with.
    fn decoded_dimensions(dir: &std::path::Path, path: &std::path::Path) -> (u32, u32) {
        let png = dir.join("decoded probe.png");
        let out = ffmpeg::run(
            "ffmpeg",
            &["-y", "-i", path.to_str().unwrap(), "-frames:v", "1", png.to_str().unwrap()],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let info = probe_sync(png.to_str().unwrap()).unwrap();
        (info.width.unwrap(), info.height.unwrap())
    }

    /// No fixture in this repo carried rotation metadata, which is exactly why
    /// a broken portrait export sailed past a fully green test suite. A 90°
    /// Display Matrix must make `probe_sync` report the PORTRAIT dimensions,
    /// because that is what comes out of the decoder.
    #[test]
    fn probe_reports_the_decoded_size_for_a_rotated_recording() {
        let dir = std::env::temp_dir().join("taroting rotation test");
        std::fs::create_dir_all(&dir).unwrap();

        for deg in [90, 270] {
            let rotated = rotated_fixture(&dir, deg);
            let info = probe_sync(rotated.to_str().unwrap()).unwrap();
            assert_eq!(
                (info.width, info.height),
                (Some(360), Some(640)),
                "{deg}° must report the transposed (portrait) size"
            );
            assert_eq!(
                (info.width.unwrap(), info.height.unwrap()),
                decoded_dimensions(&dir, &rotated),
                "{deg}°: stored dims must equal what the decoder hands the filtergraph"
            );
        }

        // A half turn flips both axes: same dimensions, no swap.
        let half = rotated_fixture(&dir, 180);
        let info = probe_sync(half.to_str().unwrap()).unwrap();
        assert_eq!((info.width, info.height), (Some(640), Some(360)), "180° must not swap");
        assert_eq!(
            (info.width.unwrap(), info.height.unwrap()),
            decoded_dimensions(&dir, &half),
        );

        // ...and an unrotated file is untouched by any of this.
        let flat = rotated_fixture(&dir, 0);
        let info = probe_sync(flat.to_str().unwrap()).unwrap();
        assert_eq!((info.width, info.height), (Some(640), Some(360)));

        let _ = std::fs::remove_dir_all(&dir);
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
