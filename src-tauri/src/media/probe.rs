//! ffprobe wrapper: probe a media file into structured MediaInfo.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::jobs::ffmpeg;
use crate::media::exif;

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
    /// Stills only, and always `Some(true)` on one: `width`/`height` already
    /// account for the file's EXIF orientation. The load-time repair in
    /// `project/store.rs` reads it off the raw project JSON to know a still
    /// has been through this probe (the typed `schema::MediaRef` deliberately
    /// does not carry it — raw serde keeps it through every save).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oriented: Option<bool>,
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
struct FfFrame {
    #[serde(default)]
    side_data_list: Vec<FfSideData>,
}

#[derive(Deserialize)]
struct FfFramesOut {
    #[serde(default)]
    frames: Vec<FfFrame>,
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

/// Whether a side-data entry is the display matrix. ffprobe spells it
/// "Display Matrix" at stream level (a rotated recording) and "3x3
/// displaymatrix" at frame level (a still's EXIF orientation, which never
/// appears at stream level).
fn is_display_matrix(s: &FfSideData) -> bool {
    matches!(s.side_data_type.as_deref(), Some("Display Matrix" | "3x3 displaymatrix"))
}

/// The stream's display rotation in degrees, from either place ffprobe puts it.
fn display_rotation(stream: &FfStream) -> u32 {
    let deg = stream
        .side_data_list
        .iter()
        .find(|s| is_display_matrix(s))
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

/// Whether ffprobe's `format_name` names an image2-family demuxer: "image2"
/// itself or a per-codec "*_pipe" one (png_pipe, jpeg_pipe, webp_pipe, ...).
///
/// This is what makes a file a STILL, and nothing else may: the export builder
/// opens a still with `-loop 1`, a private option of exactly these demuxers,
/// and on any other it is a fatal "Option loop not found" before a frame is
/// read. The export builder's `loops_as_still` calls THIS function, so the
/// probe can never hand it a still it will refuse — one rule, one place.
pub(crate) fn is_image2_family(container: &str) -> bool {
    container.contains("image2") || container.contains("_pipe")
}

/// The file's kind, from the parsed probe alone. Pure, so the classification
/// rules are testable against ffprobe JSON without a file that produces it.
///
/// Two rules that used to be looser, and why:
/// - A still is ONLY what an image2-family demuxer opened. The old "one frame
///   and no audio" promotion also caught AVIF/HEIC (demuxed by mov), ico and a
///   one-frame apng or mp4, all of which then failed export on `-loop 1`. A
///   one-frame mp4 is now simply a one-frame video.
/// - A visual stream reporting a zero side is refused. An animated WebP probes
///   "successfully" at 0x0 and cannot be decoded at all; admitting it created
///   a clip that no preview or export could ever draw.
fn classify(parsed: &FfProbeOut) -> Result<&'static str> {
    let container = parsed.format.as_ref().and_then(|f| f.format_name.as_deref());
    let video = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0);
    let audio = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    if video.is_some_and(|v| v.width == Some(0) || v.height == Some(0)) {
        return Err(AppError::BadInput(
            "This file has no picture Taroting can read.".into(),
        ));
    }

    let is_gif = container.is_some_and(|c| c.contains("gif"));
    let is_image = !is_gif && video.is_some() && container.is_some_and(is_image2_family);

    Ok(if is_gif {
        "gif"
    } else if is_image {
        "image"
    } else if video.is_some() {
        "video"
    } else if audio.is_some() {
        "audio"
    } else {
        return Err(AppError::Ffmpeg("no decodable streams".into()));
    })
}

/// The rotation ffmpeg applies to the first decoded frame of `path`, from the
/// frame-level side data — the only place a still's EXIF orientation shows up
/// (`-show_streams` reports nothing for it). `None` when the process or its
/// output fails, or no frame decoded; `Some(0.0)` when a frame decoded with no
/// display matrix, which is ffmpeg saying "no rotation" and is believed.
///
/// Measured on a 12 MP JPEG: ~118 ms, against ~50 ms for the stream probe —
/// which is why only a still whose header says it turns pays for it.
fn frame_rotation(path: &str) -> Option<f64> {
    let out = ffmpeg::run(
        "ffprobe",
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-read_intervals",
            "%+#1",
            "-show_entries",
            "frame=width,height:frame_side_data=side_data_type,rotation",
            "-of",
            "json",
            path,
        ],
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed: FfFramesOut = serde_json::from_slice(&out.stdout).ok()?;
    let frame = parsed.frames.first()?;
    Some(
        frame
            .side_data_list
            .iter()
            .find(|s| is_display_matrix(s))
            .and_then(|s| s.rotation)
            .unwrap_or(0.0),
    )
}

/// Whether the first decoded frame of `path` is the TRANSPOSE of its coded
/// size — ffmpeg's own verdict on a still's orientation. `None` when the frame
/// probe fails (see `frame_rotation`); `Some(false)` when a frame decoded with
/// no quarter turn, which is also what a still whose EXIF block ffmpeg
/// REJECTED looks like, whatever its orientation entry says.
///
/// The one confirmation the header sniff answers to: import (`still_transposes`)
/// and the load-time still repair in `project/store.rs` both call this, so
/// the two can never disagree about the same file.
pub(crate) fn frame_transposes(path: &str) -> Option<bool> {
    frame_rotation(path).map(|deg| swaps_dimensions(normalize_rotation(deg)))
}

/// Whether ffmpeg's autorotate transposes this still on decode.
///
/// The header sniff decides whether the question needs a second process at
/// all. Orientations 1-4 never change the dimensions (a mirror or a half turn
/// keeps both axes), so an ordinary photo — orientation 1, or none — keeps the
/// single-probe cost it always had. A header saying 5-8 is confirmed by the
/// frame probe, because what matters is what the DECODER does — and the sniff
/// is more lenient than ffmpeg's EXIF parser, which drops the whole block over
/// a bad offset anywhere in it (`media/exif.rs`). If that probe fails, the
/// sniffed orientation stands in for it: at import the file is already known
/// to open (the stream probe just succeeded), and a well-formed 5-8 is exactly
/// what autorotate applies. A header the sniff will not vouch for goes straight
/// to the frame probe: a format it does not know (bmp, jxl), a walk that hit a
/// cap, two Exif blocks in one JPEG (or two eXIf chunks in a PNG), or an
/// orientation entry it cannot read — rare files, and the only honest answer
/// for them is the decoder's.
fn still_transposes(path: &str) -> bool {
    match exif::sniff(std::path::Path::new(path)) {
        Some(s) if !s.transposes() => false,
        sniffed => frame_transposes(path).unwrap_or_else(|| sniffed.is_some_and(|s| s.transposes())),
    }
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

    let kind = classify(&parsed).map_err(|e| match e {
        AppError::Ffmpeg(msg) => AppError::Ffmpeg(format!("{msg} in {path}")),
        other => other,
    })?;
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
    //
    // A still carries its turn somewhere else entirely: EXIF orientation,
    // which ffmpeg applies per FRAME and `-show_streams` never shows. Same
    // consequence, same fix — see `still_transposes`.
    let is_still = kind == "image";
    let swapped = video.is_some_and(|v| swaps_dimensions(display_rotation(v)))
        || (is_still && still_transposes(path));
    let (width, height) = match (video.and_then(|v| v.width), video.and_then(|v| v.height)) {
        (Some(w), Some(h)) if swapped => (Some(h), Some(w)),
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
        oriented: is_still.then_some(true),
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

    fn parsed(json: serde_json::Value) -> FfProbeOut {
        serde_json::from_value(json).unwrap()
    }

    fn one_stream(container: &str, stream: serde_json::Value) -> FfProbeOut {
        parsed(serde_json::json!({ "streams": [stream], "format": { "format_name": container } }))
    }

    /// The classification rules, against ffprobe JSON shaped like the real
    /// thing. Each non-still case below was called "image" by the old
    /// one-frame promotion, and every one of them then died on `-loop 1`.
    #[test]
    fn only_an_image2_family_demuxer_makes_a_still() {
        let frame = |w: u32, h: u32| {
            serde_json::json!({ "codec_type": "video", "width": w, "height": h, "nb_frames": "1" })
        };
        for container in ["png_pipe", "jpeg_pipe", "webp_pipe", "tiff_pipe", "image2"] {
            assert_eq!(classify(&one_stream(container, frame(96, 40))).unwrap(), "image", "{container}");
        }
        // AVIF/HEIC demux through mov; ico and apng have their own demuxers;
        // and a one-frame mp4 is a one-frame video.
        for container in ["mov,mp4,m4a,3gp,3g2,mj2", "ico", "apng", "matroska,webm"] {
            assert_eq!(classify(&one_stream(container, frame(96, 40))).unwrap(), "video", "{container}");
        }
        assert_eq!(classify(&one_stream("gif", frame(96, 40))).unwrap(), "gif");

        // Album art is not a picture of the file's own: an mp3 stays audio.
        let mp3 = parsed(serde_json::json!({
            "streams": [
                { "codec_type": "audio" },
                { "codec_type": "video", "width": 0, "height": 0, "disposition": { "attached_pic": 1 } }
            ],
            "format": { "format_name": "mp3" }
        }));
        assert_eq!(classify(&mp3).unwrap(), "audio", "a 0x0 cover must not reject the song");

        let nothing = parsed(serde_json::json!({ "streams": [], "format": { "format_name": "data" } }));
        assert!(matches!(classify(&nothing), Err(AppError::Ffmpeg(_))));
    }

    /// An animated WebP probes "successfully" at 0x0 and cannot be decoded;
    /// neither can anything else whose picture has a zero side. Refused, in
    /// words a person can act on.
    #[test]
    fn a_picture_with_a_zero_side_is_refused() {
        for (w, h) in [(0, 0), (0, 40), (96, 0)] {
            let stream = serde_json::json!({ "codec_type": "video", "width": w, "height": h });
            for container in ["webp_pipe", "mov,mp4,m4a,3gp,3g2,mj2"] {
                match classify(&one_stream(container, stream.clone())) {
                    Err(AppError::BadInput(msg)) => {
                        assert_eq!(msg, "This file has no picture Taroting can read.")
                    }
                    other => panic!("{container} {w}x{h}: expected a refusal, got {:?}", other.ok()),
                }
            }
        }
    }

    /// A real one-frame mp4, end to end: a video, not a still.
    #[test]
    fn a_single_frame_mp4_is_a_video() {
        let dir = std::env::temp_dir().join("taroting one frame test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("one frame.mp4");
        let out = ffmpeg::run(
            "ffmpeg",
            &[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=96x40:rate=30",
                "-frames:v", "1",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                file.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let info = probe_sync(file.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "video");
        assert_eq!(info.oriented, None, "only a still carries the orientation stamp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Encode one 96x40 frame of `testsrc2` to `name` — width and height far
    /// apart, so a transposed answer can never pass for a right one.
    fn encode_still(dir: &std::path::Path, name: &str) -> Vec<u8> {
        let file = dir.join(name);
        let out = ffmpeg::run(
            "ffmpeg",
            &[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=96x40",
                "-frames:v", "1",
                file.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        std::fs::read(&file).unwrap()
    }

    /// Add a SHORT Orientation entry to IFD0 of a TIFF file: the entries are
    /// re-sorted by tag (TIFF requires it) into a new IFD appended at the end,
    /// and the header is pointed at it. Every value offset in the old entries
    /// still points at data that has not moved.
    fn tiff_with_orientation(src: &[u8], o: u16) -> Vec<u8> {
        let le = &src[..2] == b"II";
        let r16 = |b: &[u8], i: usize| {
            let a = [b[i], b[i + 1]];
            if le { u16::from_le_bytes(a) } else { u16::from_be_bytes(a) }
        };
        let r32 = |b: &[u8], i: usize| {
            let a = [b[i], b[i + 1], b[i + 2], b[i + 3]];
            if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) }
        };
        let w16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let ifd = r32(src, 4) as usize;
        let n = r16(src, ifd) as usize;
        let mut entries: Vec<Vec<u8>> =
            (0..n).map(|i| src[ifd + 2 + i * 12..ifd + 14 + i * 12].to_vec()).collect();
        let next = r32(src, ifd + 2 + n * 12);
        let mut e = Vec::new();
        e.extend_from_slice(&w16(0x0112));
        e.extend_from_slice(&w16(3));
        e.extend_from_slice(&w32(1));
        e.extend_from_slice(&w16(o));
        e.extend_from_slice(&[0, 0]);
        entries.push(e);
        entries.sort_by_key(|e| r16(e, 0));
        let mut out = src.to_vec();
        if out.len() % 2 == 1 {
            out.push(0);
        }
        let at = out.len() as u32;
        out.extend_from_slice(&w16(entries.len() as u16));
        for e in &entries {
            out.extend_from_slice(e);
        }
        out.extend_from_slice(&w32(next));
        out[4..8].copy_from_slice(&w32(at));
        out
    }

    /// What ffmpeg ACTUALLY decodes a still to: one frame out to BMP, whose
    /// header is the answer (width and height, little-endian at 18 and 22).
    /// BMP because it cannot carry EXIF: a PNG reference got ffmpeg's copy of
    /// the source's EXIF block (measured), so reading it meant trusting the
    /// header sniffer — the code under test — and a 300-entry IFD0 comes back
    /// as a 302-entry eXIf that sniffer rightly refuses to read.
    fn decoded_still_dims(dir: &std::path::Path, path: &std::path::Path) -> (u32, u32) {
        let bmp = dir.join("decoded still.bmp");
        let out = ffmpeg::run(
            "ffmpeg",
            &["-y", "-i", path.to_str().unwrap(), "-frames:v", "1", bmp.to_str().unwrap()],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let b = std::fs::read(&bmp).unwrap();
        assert_eq!(&b[..2], b"BM", "not a BMP");
        let side = |at: usize| i32::from_le_bytes(b[at..at + 4].try_into().unwrap()).unsigned_abs();
        (side(18), side(22))
    }

    /// Ground truth for every EXIF orientation, in both TIFF byte orders, and
    /// for PNG (eXIf before and after the image data) and WebP: the stored
    /// size must be what the decoder hands the filtergraph. Before this, 5-8
    /// stored the coded landscape size for a portrait-decoding photo.
    #[test]
    fn probe_reports_the_decoded_size_of_every_exif_orientation() {
        use crate::media::exif::tests::{
            exif_left_to_ffmpeg, ffmpeg_rejected_exif, jpeg_with_exif, jpeg_with_exif_id,
            png_exif_left_to_ffmpeg, png_with_exif, tiff_orientation, webp_with_exif,
        };
        let dir = std::env::temp_dir().join("taroting exif probe test");
        std::fs::create_dir_all(&dir).unwrap();

        let jpg = encode_still(&dir, "base.jpg");
        let png = encode_still(&dir, "base.png");
        let webp = encode_still(&dir, "base.webp");

        let mut cases: Vec<(String, Vec<u8>, bool)> = Vec::new();
        for o in 1..=8u16 {
            cases.push((format!("o{o}.jpg"), jpeg_with_exif(&jpg, &tiff_orientation(o, false)), o >= 5));
        }
        for o in [3u16, 6, 7] {
            cases.push((format!("o{o} le.jpg"), jpeg_with_exif(&jpg, &tiff_orientation(o, true)), o >= 5));
        }
        cases.push(("o6.png".into(), png_with_exif(&png, &tiff_orientation(6, false), false), true));
        cases.push(("o8 late.png".into(), png_with_exif(&png, &tiff_orientation(8, true), true), true));
        cases.push(("o1.png".into(), png.clone(), false));
        cases.push(("o6.webp".into(), webp_with_exif(&webp, 96, 40, &tiff_orientation(6, false)), true));
        cases.push(("o1.webp".into(), webp.clone(), false));
        // TIFF autorotates too (measured); its orientation is an IFD0 entry of
        // the file itself.
        let tif = encode_still(&dir, "base.tif");
        cases.push(("o6.tif".into(), tiff_with_orientation(&tif, 6), true));
        cases.push(("o1.tif".into(), tif, false));
        // A header the sniff gives up on (200 comment segments ahead of the
        // Exif, past its walk cap) is not a header that says "upright": the
        // frame probe answers instead.
        let turned = jpeg_with_exif(&jpg, &tiff_orientation(6, false));
        let mut padded = vec![0xFF, 0xD8];
        for _ in 0..200 {
            padded.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x02]);
        }
        padded.extend_from_slice(&turned[2..]);
        assert_eq!(crate::media::exif::tests::sniff_bytes(&padded), None, "the fixture must defeat the sniff");
        cases.push(("o6 unsniffable.jpg".into(), padded, true));
        // ffmpeg matches an APP1 on "Exif" alone and skips the next two bytes
        // unread, and honours a count-2 SHORT orientation on its first value:
        // all three decode PORTRAIT. The sniff used to call each of them
        // orientation 1, which skipped the frame probe and stored landscape.
        for (name, id) in [("o6 id 00FF.jpg", b"Exif\0\xFF"), ("o6 id XY.jpg", b"ExifXY")] {
            cases.push((name.into(), jpeg_with_exif_id(&jpg, id, &tiff_orientation(6, false)), true));
        }
        let mut count2 = tiff_orientation(6, false);
        count2[17] = 2; // the entry's count, big-endian low byte
        cases.push(("o6 count 2.jpg".into(), jpeg_with_exif(&jpg, &count2), true));
        // ...and the other way round: blocks ffmpeg DROPS whole — a value out
        // of line past the block, in IFD0 or in a sub-IFD it follows, or a
        // truncated sub-IFD — decode LANDSCAPE though the sniff still reads a
        // well-formed orientation 6. The frame probe is what keeps these
        // upright, here and in the load-time repair.
        for (name, t) in ffmpeg_rejected_exif() {
            cases.push((format!("{name}.jpg"), jpeg_with_exif(&jpg, &t), false));
        }
        // Headers that are ffmpeg's call, not the sniff's: an orientation of
        // count 3 held out of line (in both byte orders, and ahead of a
        // readable 1), a 300-entry IFD0, two Exif APP1s, two eXIf chunks or a
        // late one with a bad CRC. Every portrait row here sniffed as
        // orientation 1 — no frame probe, landscape stored, the squash back.
        // Each must now defeat the sniff, so the frame probe answers.
        let jpgs = exif_left_to_ffmpeg(&jpg).into_iter().map(|(n, b, t)| (format!("{n}.jpg"), b, t));
        let pngs = png_exif_left_to_ffmpeg(&png).into_iter().map(|(n, b, t)| (format!("{n}.png"), b, t));
        for (name, bytes, portrait) in jpgs.chain(pngs) {
            let sniffed = crate::media::exif::tests::sniff_bytes(&bytes);
            assert_eq!(sniffed, None, "{name}: the fixture must defeat the sniff");
            cases.push((name, bytes, portrait));
        }

        for (name, bytes, portrait) in cases {
            let file = dir.join(&name);
            std::fs::write(&file, bytes).unwrap();
            let info = probe_sync(file.to_str().unwrap()).unwrap();
            assert_eq!(info.kind, "image", "{name}");
            assert_eq!(info.oriented, Some(true), "{name}: every probed still is stamped");
            let expected = if portrait { (40, 96) } else { (96, 40) };
            assert_eq!(
                (info.width, info.height),
                (Some(expected.0), Some(expected.1)),
                "{name}"
            );
            assert_eq!(
                expected,
                decoded_still_dims(&dir, &file),
                "{name}: stored dims must equal what the decoder produces"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
