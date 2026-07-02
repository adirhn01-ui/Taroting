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

/// Temp files created while finalizing an export, cleaned up in every exit path
/// (success, failure, cancel).
struct ExportTemps {
    /// The `-filter_complex_script` file, if the graph exceeded the inline limit.
    script: Option<std::path::PathBuf>,
    /// The drawtext `textfile` files (one per text generator).
    texts: Vec<std::path::PathBuf>,
}

impl ExportTemps {
    fn cleanup(&self) {
        if let Some(s) = &self.script {
            let _ = std::fs::remove_file(s);
        }
        for t in &self.texts {
            let _ = std::fs::remove_file(t);
        }
    }
}

/// Escape a materialized textfile path for drawtext (mirrors the builder's
/// `escape_filter_path`): backslashes → forward slashes, ':' → '\:', wrapped in
/// single quotes.
fn escape_text_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 4);
    out.push('\'');
    for ch in path.chars() {
        match ch {
            '\\' => out.push('/'),
            ':' => out.push_str("\\:"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Splice the built filtergraph into the argv. Text payloads are materialized to
/// `%TEMP%` and their placeholders substituted (escaped) BEFORE deciding
/// inline-vs-script, so the composed graph feeds the length check. When inline,
/// the placeholder is replaced with the filter string; in script mode the
/// preceding `-filter_complex` flag becomes `-filter_complex_script` and the
/// placeholder becomes the script path. Returns temp files to delete after the
/// job.
fn finalize_args(built: &BuiltExport, out_path: &str) -> Result<(Vec<OsString>, ExportTemps)> {
    let mut args = built.args.clone();
    let pos = args
        .iter()
        .position(|a| a == FILTER_PLACEHOLDER)
        .ok_or_else(|| AppError::Ffmpeg("filter placeholder missing from args".into()))?;

    let hash = xxh3_64(out_path.as_bytes());

    // Materialize drawtext textfiles and substitute their escaped real paths for
    // the placeholders inside the graph.
    let mut filter = built.filter_complex.clone();
    let mut texts: Vec<std::path::PathBuf> = Vec::new();
    for (i, (placeholder, content)) in built.text_payloads.iter().enumerate() {
        let file = std::env::temp_dir().join(format!("taroting-text-{hash:016x}-{i}.txt"));
        if let Err(e) = std::fs::write(&file, content.as_bytes()) {
            // best-effort cleanup of any earlier files before bailing
            for t in &texts {
                let _ = std::fs::remove_file(t);
            }
            return Err(e.into());
        }
        texts.push(file.clone());
        let esc = escape_text_path(&file.to_string_lossy());
        // The placeholder was embedded escaped-quoted (`'…'`); replace the
        // quoted placeholder with the quoted real path.
        let quoted_placeholder = format!("'{placeholder}'");
        filter = filter.replace(&quoted_placeholder, &esc);
    }

    if filter.len() > INLINE_FILTER_LIMIT {
        let script = std::env::temp_dir().join(format!("taroting-filter-{hash:016x}.txt"));
        if let Err(e) = std::fs::write(&script, filter.as_bytes()) {
            for t in &texts {
                let _ = std::fs::remove_file(t);
            }
            return Err(e.into());
        }
        if pos == 0 {
            for t in &texts {
                let _ = std::fs::remove_file(t);
            }
            return Err(AppError::Ffmpeg("malformed filter args".into()));
        }
        args[pos - 1] = OsString::from("-filter_complex_script");
        args[pos] = OsString::from(&script);
        Ok((args, ExportTemps { script: Some(script), texts }))
    } else {
        args[pos] = OsString::from(&filter);
        Ok((args, ExportTemps { script: None, texts }))
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

    let (mut final_args, temps) = finalize_args(&built, &out_path)?;

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

            // always remove temp files (filter script + textfiles) whatever the
            // outcome: success, failure, or cancel.
            temps.cleanup();

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
        let (mut args, temps) = finalize_args(built, out).unwrap();
        let last = args.len() - 1;
        args[last] = OsString::from(part);
        let res = ffmpeg::command("ffmpeg").unwrap().args(&args).output().unwrap();
        temps.cleanup();
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

    /* -------- helpers for pixel/probe verification -------- */

    /// Average luma (YAVG, 0..255) of a WxH crop region at time `t` of `path`,
    /// via `signalstats` + `metadata=print`. A robust, container-independent way
    /// to assert whether pixels changed in a region.
    fn yavg(path: &std::path::Path, t: f64, x: u32, y: u32, w: u32, h: u32) -> f64 {
        let vf = format!("crop={w}:{h}:{x}:{y},signalstats,metadata=print");
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args([
                "-hide_banner",
                "-nostats",
                "-ss",
                &format!("{t:.3}"),
                "-i",
                path.to_str().unwrap(),
                "-frames:v",
                "1",
                "-vf",
                &vf,
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        for line in stderr.lines() {
            if let Some(idx) = line.find("lavfi.signalstats.YAVG=") {
                let v = &line[idx + "lavfi.signalstats.YAVG=".len()..];
                if let Ok(n) = v.trim().parse::<f64>() {
                    return n;
                }
            }
        }
        panic!("no YAVG in ffmpeg output: {stderr}");
    }

    fn probe_dur(path: &std::path::Path) -> f64 {
        probe::probe_sync(path.to_str().unwrap()).unwrap().duration
    }

    fn clip_at(id: &str, media: &str, start: f64, si: f64, so: f64) -> Clip {
        Clip {
            id: id.into(), media_id: media.into(), timeline_start: start,
            src_in: si, src_out: so, speed: 1.0, transform: None,
            audio: default_audio(), keyframes: None,
        }
    }

    fn vtrack(id: &str, clips: Vec<Clip>) -> Track {
        Track { id: id.into(), kind: "video".into(), name: "V".into(), muted: false, clips }
    }

    fn preset_640(fps: f64) -> ExportPreset {
        ExportPreset {
            format: "mp4".into(), vcodec: "h264".into(),
            resolution: ResolutionPreset::Custom { w: 640, h: 360 },
            fps: FpsPreset::Custom(fps),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        }
    }

    fn encode(spec: &ExportSpec, dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let out = dir.join(name);
        let out_s = out.to_string_lossy().into_owned();
        let built = builder::build(spec, &enc()).unwrap();
        let part = dir.join(format!("{name}.part"));
        run_built(&built, &out_s, &part);
        std::fs::rename(&part, &out).unwrap();
        out
    }

    /// A small solid-color generated media (kind image, generator=solid).
    fn solid_media(id: &str, color: &str) -> MediaRef {
        MediaRef {
            id: id.into(), path: "solid".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(640), height: Some(360),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Solid { color: color.into() }),
        }
    }

    /* -------- (1) two-layer composite -------- */

    #[test]
    fn e2e_two_layer_composite_overlay_window() {
        let dir = fixtures_dir();
        let (_src, media) = fixture_media(&dir);

        // bottom: 6s testsrc2 (two 3s fixture clips concatenated).
        let bottom = vtrack(
            "vbot",
            vec![clip_at("b1", "m1", 0.0, 0.0, 3.0), clip_at("b2", "m1", 3.0, 0.0, 3.0)],
        );
        // top: a WHITE solid (unambiguously distinct from testsrc2) windowed at
        // [2,4), centered at half canvas via scale 0.5.
        let white = solid_media("white", "#ffffff");
        let mut top_clip = clip_at("t1", "white", 2.0, 0.0, 2.0);
        top_clip.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 0.5, x: 0.0, y: 0.0, opacity: 1.0,
        });
        let top = vtrack("vtop", vec![top_clip]);
        // tracks[0] topmost, last = bottom.
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![top, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![media, white], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("composite.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "composite.mp4");

        assert!((probe_dur(&out) - 6.0).abs() < 0.15, "dur {}", probe_dur(&out));
        // center 120x120 region: at t=3 the white overlay is present (bright),
        // at t=5 the overlay window has closed → testsrc2 shows through.
        let center = |t: f64| yavg(&out, t, 260, 120, 120, 120);
        let inside = center(3.0);
        let outside = center(5.0);
        assert!(inside > 200.0, "white overlay should be bright at t=3: {inside}");
        assert!(
            inside - outside > 40.0,
            "overlay presence should raise center YAVG: t3={inside} t5={outside}"
        );
    }

    /* -------- (2) animated position -------- */

    #[test]
    fn e2e_animated_position_displaces_box() {
        let dir = fixtures_dir();
        // solid red box on a black-ish base: bottom black-ish (use a solid dark),
        // top a small red solid clip that pans left→right over 4s.
        let base = solid_media("base", "#202020");
        let box_media = solid_media("box", "#ff0000");
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 4.0)]);
        let mut top = clip_at("t1", "box", 0.0, 0.0, 4.0);
        top.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 0.15, x: 0.0, y: 0.0, opacity: 1.0,
        });
        top.keyframes = Some(ClipKeyframes {
            x: Some(vec![Keyframe { t: 0.0, v: -200.0 }, Keyframe { t: 4.0, v: 200.0 }]),
            y: None, scale: None, opacity: None,
        });
        let toptrack = vtrack("vtop", vec![top]);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![toptrack, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, box_media], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("animpos.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "animpos.mp4");

        // At t=0 the box sits left-of-center (x=-200); at t=4 right-of-center
        // (x=+200). Probe a left strip and a right strip: redness (high YAVG on a
        // red region relative to dark base) swaps sides.
        let left = |t: f64| yavg(&out, t, 40, 140, 80, 80);
        let right = |t: f64| yavg(&out, t, 520, 140, 80, 80);
        // early: box on the left → left brighter than right.
        assert!(left(0.1) > right(0.1) + 3.0, "t0 left={} right={}", left(0.1), right(0.1));
        // late: box on the right → right brighter than left.
        assert!(right(3.9) > left(3.9) + 3.0, "t4 left={} right={}", left(3.9), right(3.9));
    }

    /* -------- (3) animated opacity -------- */

    #[test]
    fn e2e_animated_opacity_alpha_ramp() {
        let dir = fixtures_dir();
        // bottom black, top white full-frame ramping opacity 0.2 → 1.0 over 4s.
        let base = solid_media("base", "#000000");
        let white = solid_media("white", "#ffffff");
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 4.0)]);
        let mut top = clip_at("t1", "white", 0.0, 0.0, 4.0);
        top.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 0.2 }, Keyframe { t: 4.0, v: 1.0 }]),
        });
        let toptrack = vtrack("vtop", vec![top]);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![toptrack, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, white], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("animop.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "animop.mp4");

        // white-over-black composited luma tracks opacity: ~20% early, ~100% late.
        let early = yavg(&out, 0.1, 280, 140, 80, 80);
        let late = yavg(&out, 3.9, 280, 140, 80, 80);
        assert!(early < 120.0, "early alpha should be dim: {early}");
        assert!(late > 180.0, "late alpha should be bright: {late}");
        assert!(late - early > 60.0, "alpha ramp should brighten: {early} -> {late}");
    }

    /* -------- (4) text over solid -------- */

    #[test]
    fn e2e_text_over_solid_renders() {
        let dir = fixtures_dir();
        // bottom: a black solid. top: white text on transparent, centered.
        let base = solid_media("base", "#000000");
        let text = MediaRef {
            id: "txt".into(), path: "Text".into(), size: 0, mtime_ms: 0,
            kind: "image".into(), duration: 0.0, fps: None,
            width: Some(640), height: Some(360),
            container: None, vcodec: None, acodec: None, pix_fmt: None,
            bit_depth: None, has_audio: false, audio_rate: None, audio_channels: None,
            generator: Some(Generator::Text {
                text: "TAROTING 100%".into(),
                font_family: "Arial".into(),
                size_px: 96.0,
                color: "#ffffff".into(),
                bold: true,
                italic: false,
            }),
        };
        let bottom = vtrack("vbot", vec![clip_at("b1", "base", 0.0, 0.0, 2.0)]);
        let toptrack = vtrack("vtop", vec![clip_at("t1", "txt", 0.0, 0.0, 2.0)]);
        let tl = Timeline {
            fps: Rational { num: 30, den: 1 }, width: 640, height: 360,
            tracks: vec![toptrack, bottom], markers: vec![],
        };
        let spec = ExportSpec {
            media: vec![base, text], timeline: tl, preset: preset_640(30.0),
            out_path: dir.join("textsolid.mp4").to_string_lossy().into_owned(),
        };
        let out = encode(&spec, &dir, "textsolid.mp4");

        // Drawtext renders at top-left (x=0,y=0). The text region has bright
        // pixels; a far-bottom empty region stays (near-)black.
        let text_region = yavg(&out, 1.0, 0, 0, 400, 120);
        let empty_region = yavg(&out, 1.0, 0, 300, 400, 60);
        assert!(empty_region < 20.0, "empty region should be dark: {empty_region}");
        assert!(
            text_region - empty_region > 5.0,
            "text region should be brighter than empty: text={text_region} empty={empty_region}"
        );
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
