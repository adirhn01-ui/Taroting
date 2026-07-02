//! Export engine: turn an `ExportSpec` into a single ffmpeg invocation on the
//! export lane, streaming progress and atomically publishing the result.

pub mod builder;
pub mod estimate;
pub mod model;

use std::ffi::OsString;
use std::sync::Arc;

use tauri::{AppHandle, State};
use xxhash_rust::xxh3::xxh3_64;

use crate::error::{AppError, Result};
use crate::hw;
use crate::jobs::{self, JobId, JobKind, Jobs, Lane};

use self::builder::{BuiltExport, FILTER_PLACEHOLDER};
use self::model::ExportSpec;

/// Filtergraphs longer than this are written to a script file and passed via
/// `-filter_complex_script` to avoid command-line length limits.
const INLINE_FILTER_LIMIT: usize = 8000;

/// Splice the built filtergraph into the argv. When inline, the placeholder is
/// replaced with the filter string. When using a script file, the preceding
/// `-filter_complex` flag is rewritten to `-filter_complex_script` and the
/// placeholder becomes the script path. Returns the optional temp-file path so
/// the caller can delete it after the job.
fn finalize_args(built: &BuiltExport, out_path: &str) -> Result<(Vec<OsString>, Option<std::path::PathBuf>)> {
    let mut args = built.args.clone();
    let pos = args
        .iter()
        .position(|a| a == FILTER_PLACEHOLDER)
        .ok_or_else(|| AppError::Ffmpeg("filter placeholder missing from args".into()))?;

    if built.filter_complex.len() > INLINE_FILTER_LIMIT {
        // script mode: write filter to a temp file
        let hash = xxh3_64(out_path.as_bytes());
        let script = std::env::temp_dir().join(format!("taroting-filter-{hash:016x}.txt"));
        std::fs::write(&script, built.filter_complex.as_bytes())?;
        // flag is at pos-1
        if pos == 0 {
            return Err(AppError::Ffmpeg("malformed filter args".into()));
        }
        args[pos - 1] = OsString::from("-filter_complex_script");
        args[pos] = OsString::from(&script);
        Ok((args, Some(script)))
    } else {
        args[pos] = OsString::from(&built.filter_complex);
        Ok((args, None))
    }
}

#[tauri::command]
pub fn start_export(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    spec: ExportSpec,
) -> Result<JobId> {
    let encoders = hw::detect(false);
    let built = builder::build(&spec, &encoders)?;
    let out_path = spec.out_path.clone();

    let (mut final_args, script_tmp) = finalize_args(&built, &out_path)?;

    // ffmpeg writes to "<out>.part"; the container is preserved because -f is
    // set from the format, not inferred from the extension.
    let part_path = std::path::PathBuf::from(format!("{out_path}.part"));
    // replace the output path (last argv entry) with the .part path
    let last = final_args.len() - 1;
    final_args[last] = OsString::from(&part_path);

    let total = built.duration_sec;
    let handle = jobs.allocate(JobKind::Export);
    let job_id = handle.id;

    let app_clone = app.clone();
    let jobs_arc = Arc::clone(&jobs);
    let out_final = out_path.clone();

    jobs.submit(
        Lane::Export,
        Box::new(move || {
            // cleanup on cancel/failure targets the .part file
            handle.set_output(part_path.clone());

            let result = jobs::execute_ffmpeg(&app_clone, &handle, final_args, Some(total));

            // always remove the filter script if we made one
            if let Some(script) = &script_tmp {
                let _ = std::fs::remove_file(script);
            }

            match result {
                Ok(()) => {
                    // publish: remove any existing output, then rename .part → out
                    let final_pb = std::path::PathBuf::from(&out_final);
                    if final_pb.exists() {
                        let _ = std::fs::remove_file(&final_pb);
                    }
                    match std::fs::rename(&part_path, &final_pb) {
                        Ok(()) => {
                            jobs::complete_job(
                                &app_clone,
                                &jobs_arc,
                                &handle,
                                serde_json::json!({ "path": out_final }),
                            );
                        }
                        Err(e) => {
                            jobs::fail_job(
                                &app_clone,
                                &jobs_arc,
                                &handle,
                                format!("failed to finalize output: {e}"),
                                Vec::new(),
                            );
                        }
                    }
                }
                Err(failure) => {
                    jobs::fail_job(
                        &app_clone,
                        &jobs_arc,
                        &handle,
                        failure.message,
                        failure.log_tail,
                    );
                }
            }
        }),
    );

    Ok(job_id)
}

/* ------------------------------------------------------------------ */
/* E2E: real ffmpeg + ffprobe                                          */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod e2e {
    use super::*;
    use crate::export::model::*;
    use crate::jobs::ffmpeg;
    use crate::media::probe;
    use crate::project::schema::*;

    fn fixtures_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("taroting export e2e");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ffmpeg_ok(args: &[&str]) {
        let out = ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
        assert!(
            out.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Run built argv directly through the sidecar (no job system needed for
    /// the encode itself), splicing the filter inline.
    fn run_built(built: &BuiltExport, out: &str, part: &std::path::Path) {
        let (mut args, tmp) = finalize_args(built, out).unwrap();
        let last = args.len() - 1;
        args[last] = OsString::from(part);
        let res = ffmpeg::command("ffmpeg").unwrap().args(&args).output().unwrap();
        if let Some(t) = tmp {
            let _ = std::fs::remove_file(t);
        }
        assert!(
            res.status.success(),
            "export ffmpeg failed: {}",
            String::from_utf8_lossy(&res.stderr)
        );
    }

    fn fixture_media(dir: &std::path::Path) -> (std::path::PathBuf, MediaRef) {
        // 3s testsrc2 + sine, 640x360, with a space in the path
        let src = dir.join("src fixture.mp4");
        if !src.exists() {
            ffmpeg_ok(&[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest",
                src.to_str().unwrap(),
            ]);
        }
        let info = probe::probe_sync(src.to_str().unwrap()).unwrap();
        let media = MediaRef {
            id: "m1".into(),
            path: src.to_string_lossy().into_owned(),
            size: info.size,
            mtime_ms: info.mtime_ms,
            kind: "video".into(),
            duration: info.duration,
            fps: Some(Rational { num: 30, den: 1 }),
            width: Some(640),
            height: Some(360),
            container: info.container.clone(),
            vcodec: info.vcodec.clone(),
            acodec: info.acodec.clone(),
            pix_fmt: info.pix_fmt.clone(),
            bit_depth: Some(8),
            has_audio: true,
            audio_rate: Some(48000),
            audio_channels: Some(2),
            generator: None,
        };
        (src, media)
    }

    fn default_audio() -> ClipAudio {
        ClipAudio {
            volume: 1.0,
            muted: false,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            gain_offset_db: 0.0,
            detached: false,
        }
    }

    fn enc() -> crate::hw::EncoderReport {
        // force software so this test doesn't depend on hardware
        crate::hw::EncoderReport {
            h264: "libx264".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        }
    }

    #[test]
    fn export_two_clips_with_gap_h264_software() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);

        // clip A [0.5..1.5] at timeline 0; gap 0.5s; clip B [2.0..3.0] at 1.5
        let a = Clip {
            id: "a".into(), media_id: "m1".into(), timeline_start: 0.0,
            src_in: 0.5, src_out: 1.5, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let b = Clip {
            id: "b".into(), media_id: "m1".into(), timeline_start: 1.5,
            src_in: 2.0, src_out: 3.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![a, b],
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360, tracks: vec![track],
            markers: vec![],
        };
        let preset = ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 640, h: 360 },
            fps: FpsPreset::Custom(30.0),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        };
        let out = dir.join("two clip out.mp4");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec {
            media: vec![media], timeline: tl, preset, out_path: out_s.clone(),
        };

        let built = builder::build(&spec, &enc()).unwrap();
        // total timeline duration = 1.5 (A) + 0.5 gap? no: A dur 1s @0, gap 0.5, B 1s @1.5 → end 2.5
        assert!((built.duration_sec - 2.5).abs() < 1e-6, "dur {}", built.duration_sec);

        let part = dir.join("two clip out.mp4.part");
        run_built(&built, &out_s, &part);
        std::fs::rename(&part, &out).unwrap();

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert_eq!(info.width, Some(640));
        assert_eq!(info.height, Some(360));
        assert!((info.duration - 2.5).abs() < 0.2, "duration {}", info.duration);
        assert!(info.has_audio);
        assert_eq!(info.acodec.as_deref(), Some("aac"));
    }

    #[test]
    fn export_gif_slice() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);
        let c = Clip {
            id: "c".into(), media_id: "m1".into(), timeline_start: 0.0,
            src_in: 0.0, src_out: 1.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![c],
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360, tracks: vec![track],
            markers: vec![],
        };
        let preset = ExportPreset {
            format: "gif".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 320, h: 180 },
            fps: FpsPreset::Custom(15.0),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        };
        let out = dir.join("slice out.gif");
        let out_s = out.to_string_lossy().into_owned();
        let spec = ExportSpec { media: vec![media], timeline: tl, preset, out_path: out_s.clone() };
        let built = builder::build(&spec, &enc()).unwrap();
        let part = dir.join("slice out.gif.part");
        run_built(&built, &out_s, &part);
        std::fs::rename(&part, &out).unwrap();

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "gif");
        assert!(!info.has_audio);
    }

    #[test]
    fn custom_bitrate_estimate_is_exact() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);
        let c = Clip {
            id: "c".into(), media_id: "m1".into(), timeline_start: 0.0,
            src_in: 0.0, src_out: 10.0, speed: 1.0, transform: None, audio: default_audio(),
            keyframes: None,
        };
        let track = Track {
            id: "vt".into(), kind: "video".into(), name: "Video".into(),
            muted: false, clips: vec![c],
        };
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360, tracks: vec![track],
            markers: vec![],
        };
        let preset = ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Named("original".into()),
            fps: FpsPreset::Original("original".into()),
            video_bitrate: BitratePreset::Kbps(4000),
            audio_bitrate: BitratePreset::Kbps(160),
            use_hardware: false,
        };
        let spec = ExportSpec { media: vec![media], timeline: tl, preset, out_path: r"C:\o.mp4".into() };
        let est = estimate::estimate(&spec);
        assert!(est.exact);
        // (4000+160)*1000/8*10 = 5,200,000
        assert_eq!(est.bytes, 5_200_000);
    }
}
