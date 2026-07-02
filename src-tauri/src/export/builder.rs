//! Pure `ExportSpec -> BuiltExport`. Never a shell string: media paths only
//! ever appear as standalone `-i` argv entries; the filtergraph references
//! stream indices. The video chain mirrors `src/editor/preview/transforms.ts`
//! (crop -> rotate -> flip -> scale-to-fit x userScale -> position -> opacity)
//! exactly so the export matches the preview.

use std::ffi::OsString;

use crate::error::{AppError, Result};
use crate::export::model::{BitratePreset, ExportSpec};
use crate::hw::EncoderReport;
use crate::project::schema::{Clip, MediaRef, Timeline, Track};

/// Result of building an export. `start_export` decides whether to splice the
/// filtergraph inline (`-filter_complex <str>`) or into a script file
/// (`-filter_complex_script <path>`): the `FILTER_PLACEHOLDER` OsString in
/// `args` marks where the filter value goes, and the preceding flag is already
/// `-filter_complex`. The caller rewrites both when using script mode.
pub struct BuiltExport {
    pub args: Vec<OsString>,
    pub filter_complex: String,
    pub duration_sec: f64,
}

/// Sentinel argv entry replaced by `start_export` with either the inline
/// filter string or the script path.
pub const FILTER_PLACEHOLDER: &str = "\u{0}TAROTING_FILTER\u{0}";

fn round_even(v: f64) -> i64 {
    let n = v.round() as i64;
    n - (n % 2)
}

/* ------------------------------------------------------------------ */
/* Transform math — mirrors transforms.ts computeTransform             */
/* ------------------------------------------------------------------ */

struct Placement {
    crop: Option<(i64, i64, i64, i64)>, // cw, ch, cx, cy
    rotate: u32,
    flip_h: bool,
    flip_v: bool,
    dw: i64,
    dh: i64,
    ox: i64,
    oy: i64,
    opacity: f64,
}

/// Compute per-clip crop rect + scaled display size + overlay position, using
/// the identical fit math as the preview transform.
fn placement(clip: &Clip, media: &MediaRef, canvas_w: u32, canvas_h: u32) -> Placement {
    let cw = canvas_w as f64;
    let ch = canvas_h as f64;

    let (rotate, flip_h, flip_v, scale, x, y, opacity, crop_rect) = match &clip.transform {
        Some(t) => (
            t.rotate,
            t.flip_h,
            t.flip_v,
            t.scale,
            t.x,
            t.y,
            t.opacity,
            t.crop.as_ref().map(|c| (c.x, c.y, c.w, c.h)),
        ),
        None => (0, false, false, 1.0, 0.0, 0.0, 1.0, None),
    };

    let src_w = media.width.unwrap_or(canvas_w).max(1) as f64;
    let src_h = media.height.unwrap_or(canvas_h).max(1) as f64;

    // crop defaults to the full frame; clamp like the preview does.
    let (crop_x, crop_y, raw_cw, raw_ch) = crop_rect.unwrap_or((0.0, 0.0, src_w, src_h));
    let crop_w = raw_cw.min(src_w - crop_x).max(1.0);
    let crop_h = raw_ch.min(src_h - crop_y).max(1.0);

    // fit the cropped (and possibly rotated) region into the canvas
    let rotated = rotate == 90 || rotate == 270;
    let fit_w = if rotated { crop_h } else { crop_w };
    let fit_h = if rotated { crop_w } else { crop_h };
    let fit = (cw / fit_w).min(ch / fit_h);
    let k = fit * scale;

    let dw = round_even(crop_w * k);
    let dh = round_even(crop_h * k);
    let ox = ((cw - dw as f64) / 2.0 + x).round() as i64;
    let oy = ((ch - dh as f64) / 2.0 + y).round() as i64;

    // Only emit a crop filter when it actually narrows the frame.
    let crop = if crop_x > 0.0
        || crop_y > 0.0
        || (crop_w - src_w).abs() > 0.5
        || (crop_h - src_h).abs() > 0.5
    {
        Some((
            crop_w.round() as i64,
            crop_h.round() as i64,
            crop_x.round() as i64,
            crop_y.round() as i64,
        ))
    } else {
        None
    };

    Placement {
        crop,
        rotate,
        flip_h,
        flip_v,
        dw,
        dh,
        ox,
        oy,
        opacity,
    }
}

/* ------------------------------------------------------------------ */
/* Input collection                                                    */
/* ------------------------------------------------------------------ */

struct AudioInput {
    input_index: usize,
    clip: Clip,
    /// timeline start in ms (adelay)
    delay_ms: i64,
}

struct VideoSeg {
    input_index: usize,
    clip: Clip,
}

/// A gap (pure black) or a clip segment on the video track.
enum Segment {
    Gap(f64),
    Clip(VideoSeg),
}

fn media_for<'a>(media: &'a [MediaRef], id: &str) -> Option<&'a MediaRef> {
    media.iter().find(|m| m.id == id)
}

fn video_track(timeline: &Timeline) -> Option<&Track> {
    timeline.tracks.iter().find(|t| t.kind == "video")
}

/// A clip contributes audio iff its media has audio AND it isn't muted,
/// detached, or on a muted track.
fn clip_audible(clip: &Clip, media: &MediaRef, track: &Track) -> bool {
    media.has_audio && !clip.audio.muted && !clip.audio.detached && !track.muted
}

/* ------------------------------------------------------------------ */
/* atempo / audio helpers                                              */
/* ------------------------------------------------------------------ */

/// Decompose a speed factor into atempo stages each within [0.5, 2.0].
fn atempo_factors(speed: f64) -> Vec<f64> {
    let mut factors = Vec::new();
    let mut remaining = speed;
    if (remaining - 1.0).abs() < 1e-9 {
        return factors;
    }
    while remaining > 2.0 + 1e-9 {
        factors.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-9 {
        factors.push(0.5);
        remaining /= 0.5;
    }
    factors.push(remaining);
    factors
}

/* ------------------------------------------------------------------ */
/* Main builder                                                         */
/* ------------------------------------------------------------------ */

pub fn build(spec: &ExportSpec, encoders: &EncoderReport) -> Result<BuiltExport> {
    let preset = &spec.preset;
    let format = preset.format.as_str();
    let is_gif = format == "gif";

    // --- validation -------------------------------------------------
    if format == "webm" && (preset.vcodec == "h264" || preset.vcodec == "hevc") {
        return Err(AppError::BadInput(
            "webm only supports the av1 (or vp9) video codec, not h264/hevc".into(),
        ));
    }
    let total_clips: usize = spec
        .timeline
        .tracks
        .iter()
        .map(|t| t.clips.len())
        .sum();
    if total_clips == 0 {
        return Err(AppError::BadInput(
            "cannot export an empty timeline (no clips)".into(),
        ));
    }

    let (canvas_w, canvas_h) = preset.output_dims(spec.timeline.width, spec.timeline.height);
    let fps_str = preset.output_fps(&spec.timeline);

    // duration = timeline duration (max clip end across all tracks)
    let duration_sec = spec.timeline.duration();

    /* ---- collect video segments in deterministic order ---- */
    let mut inputs: Vec<OsString> = Vec::new(); // -i entries as we assign indices
    let mut input_flags: Vec<Vec<OsString>> = Vec::new(); // per-input leading flags
    let mut segments: Vec<Segment> = Vec::new();

    let vtrack = video_track(&spec.timeline);
    let mut vclips: Vec<Clip> = vtrack
        .map(|t| t.clips.clone())
        .unwrap_or_default();
    vclips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));

    let mut cursor = 0.0_f64;
    for clip in &vclips {
        let media = media_for(&spec.media, &clip.media_id).ok_or_else(|| {
            AppError::BadInput(format!("clip references unknown media {}", clip.media_id))
        })?;

        // gap before this clip
        let gap = clip.timeline_start - cursor;
        if gap > 0.0005 {
            segments.push(Segment::Gap(gap));
        }

        let idx = input_flags.len();
        let mut flags: Vec<OsString> = Vec::new();
        if media.kind == "image" {
            // still image: loop for the clip's timeline duration
            flags.push("-loop".into());
            flags.push("1".into());
            flags.push("-t".into());
            flags.push(format!("{:.6}", clip.duration()).into());
        } else {
            // video / gif: input-level trim to used segment
            flags.push("-ss".into());
            flags.push(format!("{:.6}", clip.src_in).into());
            flags.push("-to".into());
            flags.push(format!("{:.6}", clip.src_out).into());
        }
        flags.push("-i".into());
        input_flags.push(flags);
        inputs.push(OsString::from(&media.path));

        segments.push(Segment::Clip(VideoSeg {
            input_index: idx,
            clip: clip.clone(),
        }));
        cursor = clip.end();
    }

    /* ---- collect audio inputs (track order, then start) ---- */
    let mut audio_inputs: Vec<AudioInput> = Vec::new();
    for track in &spec.timeline.tracks {
        let mut clips = track.clips.clone();
        clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
        for clip in &clips {
            let media = match media_for(&spec.media, &clip.media_id) {
                Some(m) => m,
                None => continue,
            };
            if !clip_audible(clip, media, track) {
                continue;
            }
            let idx = input_flags.len();
            let mut flags: Vec<OsString> = Vec::new();
            flags.push("-ss".into());
            flags.push(format!("{:.6}", clip.src_in).into());
            flags.push("-to".into());
            flags.push(format!("{:.6}", clip.src_out).into());
            flags.push("-i".into());
            input_flags.push(flags);
            inputs.push(OsString::from(&media.path));

            audio_inputs.push(AudioInput {
                input_index: idx,
                clip: clip.clone(),
                delay_ms: (clip.timeline_start * 1000.0).round() as i64,
            });
        }
    }

    let want_audio = !is_gif && !audio_inputs.is_empty();

    /* ---- build filtergraph ---- */
    let mut fc = String::new();
    build_video_graph(
        &mut fc,
        &segments,
        &spec.media,
        canvas_w,
        canvas_h,
        &fps_str,
        duration_sec,
        is_gif,
    );

    if want_audio {
        build_audio_graph(&mut fc, &audio_inputs, duration_sec);
    }

    /* ---- assemble argv ---- */
    let mut args: Vec<OsString> = Vec::new();
    for a in ["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"] {
        args.push(a.into());
    }
    // inputs (flags then path, interleaved, preserving assigned indices)
    for (flags, path) in input_flags.iter().zip(inputs.iter()) {
        for f in flags {
            args.push(f.clone());
        }
        args.push(path.clone());
    }

    // filter_complex: flag + placeholder (start_export swaps the value/flag)
    args.push("-filter_complex".into());
    args.push(FILTER_PLACEHOLDER.into());

    // maps
    if is_gif {
        args.push("-map".into());
        args.push("[gifout]".into());
    } else {
        args.push("-map".into());
        args.push("[vout]".into());
        if want_audio {
            args.push("-map".into());
            args.push("[aout]".into());
        }
    }

    // video codec + quality/bitrate flags
    if is_gif {
        // palette pipeline handles color; container flags added below.
    } else {
        push_video_codec(&mut args, spec, encoders);
    }

    // audio codec
    if is_gif {
        // gif has no audio (already unmapped)
    } else if want_audio {
        push_audio_codec(&mut args, spec);
        args.push("-ar".into());
        args.push("48000".into());
    } else {
        args.push("-an".into());
    }

    // container flags + output
    push_container(&mut args, format);
    args.push(OsString::from(&spec.out_path));

    Ok(BuiltExport {
        args,
        filter_complex: fc,
        duration_sec,
    })
}

/* ------------------------------------------------------------------ */
/* Video graph                                                          */
/* ------------------------------------------------------------------ */

#[allow(clippy::too_many_arguments)]
fn build_video_graph(
    fc: &mut String,
    segments: &[Segment],
    media: &[MediaRef],
    w: u32,
    h: u32,
    fps: &str,
    duration_sec: f64,
    is_gif: bool,
) {
    let mut labels: Vec<String> = Vec::new();
    let mut n = 0usize;

    if segments.is_empty() {
        // empty video track → single black segment for the whole duration
        let d = duration_sec.max(0.04);
        fc.push_str(&format!(
            "color=black:s={w}x{h}:r={fps}:d={d:.6}[s0];"
        ));
        labels.push("[s0]".into());
    } else {
        for seg in segments {
            match seg {
                Segment::Gap(g) => {
                    fc.push_str(&format!(
                        "color=black:s={w}x{h}:r={fps}:d={g:.6}[s{n}];"
                    ));
                    labels.push(format!("[s{n}]"));
                    n += 1;
                }
                Segment::Clip(vseg) => {
                    let clip = &vseg.clip;
                    let m = media
                        .iter()
                        .find(|m| m.id == clip.media_id)
                        .expect("media exists (validated in build)");
                    let p = placement(clip, m, w, h);
                    let clip_dur = clip.duration();
                    let i = vseg.input_index;

                    // per-clip video chain
                    let mut chain = String::new();
                    chain.push_str(&format!("[{i}:v]setpts=(PTS-STARTPTS)/{:.6}", clip.speed));
                    if let Some((cw, ch, cx, cy)) = p.crop {
                        chain.push_str(&format!(",crop={cw}:{ch}:{cx}:{cy}"));
                    }
                    match p.rotate {
                        90 => chain.push_str(",transpose=1"),
                        180 => chain.push_str(",transpose=1,transpose=1"),
                        270 => chain.push_str(",transpose=2"),
                        _ => {}
                    }
                    if p.flip_h {
                        chain.push_str(",hflip");
                    }
                    if p.flip_v {
                        chain.push_str(",vflip");
                    }
                    chain.push_str(&format!(
                        ",scale={}:{},setsar=1,fps={fps}",
                        p.dw, p.dh
                    ));
                    if p.opacity < 0.999 {
                        chain.push_str(&format!(
                            ",format=rgba,colorchannelmixer=aa={:.4}",
                            p.opacity
                        ));
                    }
                    chain.push_str(&format!("[v{n}];"));
                    fc.push_str(&chain);

                    // black base for this segment
                    fc.push_str(&format!(
                        "color=black:s={w}x{h}:r={fps}:d={clip_dur:.6}[b{n}];"
                    ));
                    // overlay clip onto base
                    fc.push_str(&format!(
                        "[b{n}][v{n}]overlay={}:{}:shortest=1[s{n}];",
                        p.ox, p.oy
                    ));
                    labels.push(format!("[s{n}]"));
                    n += 1;
                }
            }
        }
    }

    // concat all segments
    let count = labels.len();
    for l in &labels {
        fc.push_str(l);
    }
    fc.push_str(&format!("concat=n={count}:v=1:a=0[vout]"));

    if is_gif {
        fc.push_str(";[vout]split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=bayer:bayer_scale=4[gifout]");
    }
}

/* ------------------------------------------------------------------ */
/* Audio graph                                                          */
/* ------------------------------------------------------------------ */

fn build_audio_graph(fc: &mut String, audio: &[AudioInput], total_dur: f64) {
    fc.push(';');
    let mut labels: Vec<String> = Vec::new();
    for (n, ai) in audio.iter().enumerate() {
        let clip = &ai.clip;
        let i = ai.input_index;
        let mut chain = format!("[{i}:a]");
        // atempo chain for non-unity speed
        for f in atempo_factors(clip.speed) {
            chain.push_str(&format!("atempo={f},"));
        }
        chain.push_str("asetpts=PTS-STARTPTS");
        let gain = clip.audio.volume * 10f64.powf(clip.audio.gain_offset_db / 20.0);
        chain.push_str(&format!(",volume={gain:.4}"));
        if clip.audio.fade_in_sec > 0.0 {
            chain.push_str(&format!(
                ",afade=t=in:st=0:d={:.4}",
                clip.audio.fade_in_sec
            ));
        }
        if clip.audio.fade_out_sec > 0.0 {
            let clip_dur = clip.duration();
            let st = (clip_dur - clip.audio.fade_out_sec).max(0.0);
            chain.push_str(&format!(
                ",afade=t=out:st={st:.4}:d={:.4}",
                clip.audio.fade_out_sec
            ));
        }
        let d = ai.delay_ms.max(0);
        chain.push_str(&format!(",adelay={d}|{d}[a{n}];"));
        fc.push_str(&chain);
        labels.push(format!("[a{n}]"));
    }
    // base silence bed guarantees full duration
    fc.push_str(&format!(
        "anullsrc=r=48000:cl=stereo,atrim=0:{total_dur:.6}[ab];"
    ));
    fc.push_str("[ab]");
    for l in &labels {
        fc.push_str(l);
    }
    let k = labels.len() + 1;
    fc.push_str(&format!("amix=inputs={k}:duration=first:normalize=0[aout]"));
}

/* ------------------------------------------------------------------ */
/* Codec / quality / container flag builders                           */
/* ------------------------------------------------------------------ */

fn chosen_encoder(spec: &ExportSpec, encoders: &EncoderReport) -> String {
    let codec = spec.preset.vcodec.as_str();
    if spec.preset.use_hardware {
        match codec {
            "h264" => encoders.h264.clone(),
            "hevc" => encoders.hevc.clone(),
            "av1" => encoders.av1.clone(),
            _ => "libx264".into(),
        }
    } else {
        software_lib(codec).into()
    }
}

fn software_lib(codec: &str) -> &'static str {
    match codec {
        "h264" => "libx264",
        "hevc" => "libx265",
        "av1" => "libsvtav1",
        _ => "libx264",
    }
}

fn push(args: &mut Vec<OsString>, items: &[&str]) {
    args.extend(items.iter().map(OsString::from));
}

fn push_video_codec(args: &mut Vec<OsString>, spec: &ExportSpec, encoders: &EncoderReport) {
    let enc = chosen_encoder(spec, encoders);
    push(args, &["-c:v", &enc]);

    let vb = spec.preset.video_bitrate;
    if let Some(k) = vb.kbps() {
        // custom bitrate replaces the quality flags
        push(
            args,
            &[
                "-b:v",
                &format!("{k}k"),
                "-maxrate",
                &format!("{}k", k * 2),
                "-bufsize",
                &format!("{}k", k * 4),
            ],
        );
    } else {
        push_quality(args, &enc);
    }

    // pixel format: yuv420p for all supported codecs
    push(args, &["-pix_fmt", "yuv420p"]);
}

fn push_quality(args: &mut Vec<OsString>, enc: &str) {
    match enc {
        "h264_nvenc" => push(args, &["-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0"]),
        "hevc_nvenc" => push(args, &["-preset", "p5", "-rc", "vbr", "-cq", "26", "-b:v", "0"]),
        "av1_nvenc" => push(args, &["-cq", "30"]),
        "libx264" => push(args, &["-preset", "medium", "-crf", "20"]),
        "libx265" => push(args, &["-preset", "medium", "-crf", "23"]),
        "libsvtav1" => push(args, &["-preset", "8", "-crf", "32"]),
        "h264_qsv" => push(args, &["-global_quality", "23"]),
        "hevc_qsv" => push(args, &["-global_quality", "26"]),
        "av1_qsv" => push(args, &["-global_quality", "30"]),
        "h264_amf" => push(
            args,
            &["-quality", "quality", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24"],
        ),
        "hevc_amf" => push(
            args,
            &["-quality", "quality", "-rc", "cqp", "-qp_i", "25", "-qp_p", "27"],
        ),
        "av1_amf" => push(
            args,
            &["-quality", "quality", "-rc", "cqp", "-qp_i", "28", "-qp_p", "30"],
        ),
        // any other software fallback: reasonable CRF
        _ => push(args, &["-crf", "23"]),
    }
}

fn push_audio_codec(args: &mut Vec<OsString>, spec: &ExportSpec) {
    let format = spec.preset.format.as_str();
    let (codec, auto_kbps) = match format {
        "webm" => ("libopus", 160u64),
        "avi" => ("libmp3lame", 192u64),
        _ => ("aac", 192u64),
    };
    push(args, &["-c:a", codec]);
    match spec.preset.audio_bitrate {
        BitratePreset::Kbps(k) => push(args, &["-b:a", &format!("{k}k")]),
        BitratePreset::Auto(_) => push(args, &["-b:a", &format!("{auto_kbps}k")]),
    }
}

fn push_container(args: &mut Vec<OsString>, format: &str) {
    match format {
        "mp4" => push(args, &["-movflags", "+faststart", "-f", "mp4"]),
        "mov" => push(args, &["-movflags", "+faststart", "-f", "mov"]),
        "webm" => push(args, &["-f", "webm"]),
        "avi" => push(args, &["-f", "avi"]),
        "gif" => push(args, &["-f", "gif"]),
        _ => push(args, &["-f", "mp4"]),
    }
}

/* ================================================================== */
/* Tests                                                               */
/* ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::model::*;
    use crate::hw::EncoderReport;
    use crate::project::schema::*;

    fn enc() -> EncoderReport {
        EncoderReport {
            h264: "h264_nvenc".into(),
            hevc: "hevc_nvenc".into(),
            av1: "av1_nvenc".into(),
            detail: vec![],
        }
    }

    fn media(id: &str, path: &str, w: u32, h: u32, has_audio: bool) -> MediaRef {
        MediaRef {
            id: id.into(),
            path: path.into(),
            size: 1,
            mtime_ms: 1,
            kind: "video".into(),
            duration: 100.0,
            fps: Some(Rational { num: 30, den: 1 }),
            width: Some(w),
            height: Some(h),
            container: Some("mp4".into()),
            vcodec: Some("h264".into()),
            acodec: Some("aac".into()),
            pix_fmt: Some("yuv420p".into()),
            bit_depth: Some(8),
            has_audio,
            audio_rate: Some(48000),
            audio_channels: Some(2),
            generator: None,
        }
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

    fn clip(id: &str, media_id: &str, start: f64, src_in: f64, src_out: f64) -> Clip {
        Clip {
            id: id.into(),
            media_id: media_id.into(),
            timeline_start: start,
            src_in,
            src_out,
            speed: 1.0,
            transform: None,
            audio: default_audio(),
            keyframes: None,
        }
    }

    fn timeline(w: u32, h: u32, fps: Rational, tracks: Vec<Track>) -> Timeline {
        Timeline { fps, width: w, height: h, tracks, markers: vec![] }
    }

    fn vtrack(clips: Vec<Clip>) -> Track {
        Track { id: "vt".into(), kind: "video".into(), name: "Video".into(), muted: false, clips }
    }

    fn preset(format: &str, vcodec: &str) -> ExportPreset {
        ExportPreset {
            format: format.into(),
            vcodec: vcodec.into(),
            resolution: ResolutionPreset::Named("original".into()),
            fps: FpsPreset::Original("original".into()),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        }
    }

    fn spec(media: Vec<MediaRef>, tl: Timeline, preset: ExportPreset, out: &str) -> ExportSpec {
        ExportSpec { media, timeline: tl, preset, out_path: out.into() }
    }

    fn argstr(b: &BuiltExport) -> Vec<String> {
        b.args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn single_full_clip_1080p30_h264_software() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let c = clip("c1", "m1", 0.0, 0.0, 5.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\out.mp4"), &enc()).unwrap();

        assert!((b.duration_sec - 5.0).abs() < 1e-6);
        // one clip → one segment → concat n=1
        assert!(b.filter_complex.contains("concat=n=1:v=1:a=0[vout]"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("scale=1920:1080"));
        // overlay at center (0,0) since original res + no offset
        assert!(b.filter_complex.contains("overlay=0:0:shortest=1"));
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(a.windows(2).any(|w| w[0] == "-crf" && w[1] == "20"));
        assert!(a.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p"));
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "mp4"));
        assert_eq!(a.last().unwrap(), r"C:\out.mp4");
        // input path is a single standalone argv entry
        assert!(a.contains(&r"C:\v.mp4".to_string()));
    }

    #[test]
    fn two_clips_with_gap_makes_black_segment_concat_n3() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let c1 = clip("c1", "m1", 0.0, 0.0, 2.0);
        // gap of 1s between clip end (2.0) and next start (3.0)
        let c2 = clip("c2", "m1", 3.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c1, c2])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        // gap black color segment present
        assert!(b.filter_complex.contains("color=black:s=1920x1080:r=30:d=1.000000"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("concat=n=3:v=1:a=0[vout]"));
    }

    #[test]
    fn speed_crop_rotate_flip_opacity_chain() {
        // Known case: 100x100 canvas, media 100x100, crop to 50x50 at (10,10),
        // rotate 90, flipH, scale 1.0, opacity 0.5, speed 2.
        let m = media("m1", r"C:\v.mp4", 100, 100, false);
        let mut c = clip("c1", "m1", 0.0, 0.0, 4.0);
        c.speed = 2.0;
        c.transform = Some(ClipTransform {
            crop: Some(ClipCrop { x: 10.0, y: 10.0, w: 50.0, h: 50.0 }),
            rotate: 90,
            flip_h: true,
            flip_v: false,
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            opacity: 0.5,
        });
        let tl = timeline(100, 100, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // setpts with speed
        assert!(fc.contains("setpts=(PTS-STARTPTS)/2.000000"), "{fc}");
        assert!(fc.contains("crop=50:50:10:10"), "{fc}");
        assert!(fc.contains("transpose=1"), "{fc}");
        assert!(fc.contains("hflip"), "{fc}");
        assert!(!fc.contains("vflip"), "{fc}");
        // rotated cropped 50x50 into 100x100 → fit = 100/50 = 2, k=2, dw=dh=100
        assert!(fc.contains("scale=100:100"), "{fc}");
        assert!(fc.contains("colorchannelmixer=aa=0.5000"), "{fc}");
        // dw=100 → ox=(100-100)/2+0=0
        assert!(fc.contains("overlay=0:0:shortest=1"), "{fc}");
    }

    #[test]
    fn audio_volume_gain_fade_delay_amix() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let mut c = clip("c1", "m1", 1.5, 0.0, 3.0);
        c.audio.volume = 0.5;
        c.audio.gain_offset_db = 6.0;
        c.audio.fade_in_sec = 0.5;
        c.audio.fade_out_sec = 1.0;
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // volume = 0.5 * 10^(6/20) = 0.5 * 1.99526 = 0.99763
        assert!(fc.contains("volume=0.9976"), "{fc}");
        assert!(fc.contains("afade=t=in:st=0:d=0.5000"), "{fc}");
        // clip dur = 3.0, fade out at 3-1=2.0
        assert!(fc.contains("afade=t=out:st=2.0000:d=1.0000"), "{fc}");
        // start 1.5s → adelay 1500|1500
        assert!(fc.contains("adelay=1500|1500"), "{fc}");
        // one audible clip → amix inputs = 2 (bed + 1)
        assert!(fc.contains("amix=inputs=2:duration=first:normalize=0[aout]"), "{fc}");
        assert!(fc.contains("anullsrc=r=48000:cl=stereo"), "{fc}");
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
        assert!(a.windows(2).any(|w| w[0] == "-ar" && w[1] == "48000"));
    }

    #[test]
    fn atempo_chain_for_extreme_speeds() {
        // 0.25 → 0.5, 0.5 (product 0.25)
        let f = atempo_factors(0.25);
        assert_eq!(f.len(), 2);
        assert!(f.iter().all(|&x| (x - 0.5).abs() < 1e-9));
        // 3.0 → 2.0, 1.5
        let f = atempo_factors(3.0);
        assert_eq!(f.len(), 2);
        assert!((f[0] - 2.0).abs() < 1e-9);
        assert!((f[1] - 1.5).abs() < 1e-9);
        // 1.0 → none
        assert!(atempo_factors(1.0).is_empty());
    }

    #[test]
    fn detached_and_muted_clips_excluded_from_audio() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let mut c1 = clip("c1", "m1", 0.0, 0.0, 2.0);
        c1.audio.detached = true;
        let mut c2 = clip("c2", "m1", 2.0, 0.0, 2.0);
        c2.audio.muted = true;
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c1, c2])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        // no audible clips → no audio graph, -an present
        assert!(!b.filter_complex.contains("amix"), "{}", b.filter_complex);
        let a = argstr(&b);
        assert!(a.contains(&"-an".to_string()));
    }

    #[test]
    fn muted_track_excluded_from_audio() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let c = clip("c1", "m1", 0.0, 0.0, 2.0);
        let mut t = vtrack(vec![c]);
        t.muted = true;
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![t]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(!b.filter_complex.contains("amix"));
    }

    #[test]
    fn webm_with_h264_is_error() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let c = clip("c1", "m1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let r = build(&spec(vec![m], tl, preset("webm", "h264"), r"C:\o.webm"), &enc());
        assert!(r.is_err());
    }

    #[test]
    fn empty_timeline_is_error() {
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![])]);
        let r = build(&spec(vec![], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc());
        assert!(r.is_err());
    }

    #[test]
    fn gif_graph_has_palette() {
        let m = media("m1", r"C:\v.mp4", 640, 360, true);
        let c = clip("c1", "m1", 0.0, 0.0, 1.0);
        let tl = timeline(640, 360, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("gif", "h264"), r"C:\o.gif"), &enc()).unwrap();
        assert!(b.filter_complex.contains("palettegen=stats_mode=diff"));
        assert!(b.filter_complex.contains("paletteuse=dither=bayer:bayer_scale=4"));
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "[gifout]"));
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "gif"));
        // gif has no audio codec / no -an-on-video-map; ensure no aac
        assert!(!a.windows(2).any(|w| w[0] == "-c:a"));
    }

    #[test]
    fn fps_original_ntsc_is_rational() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let c = clip("c1", "m1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30000, den: 1001 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(b.filter_complex.contains("fps=30000/1001"), "{}", b.filter_complex);
    }

    #[test]
    fn path_with_spaces_is_single_argv_entry() {
        let m = media("m1", r"C:\my media\clip one.mp4", 1920, 1080, false);
        let c = clip("c1", "m1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(
            &spec(vec![m], tl, preset("mp4", "h264"), r"C:\out dir\my out.mp4"),
            &enc(),
        )
        .unwrap();
        let a = argstr(&b);
        assert!(a.contains(&r"C:\my media\clip one.mp4".to_string()));
        assert_eq!(a.last().unwrap(), r"C:\out dir\my out.mp4");
    }

    #[test]
    fn custom_bitrate_replaces_quality() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let c = clip("c1", "m1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let mut p = preset("mp4", "h264");
        p.video_bitrate = BitratePreset::Kbps(8000);
        let b = build(&spec(vec![m], tl, p, r"C:\o.mp4"), &enc()).unwrap();
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-b:v" && w[1] == "8000k"));
        assert!(a.windows(2).any(|w| w[0] == "-maxrate" && w[1] == "16000k"));
        assert!(a.windows(2).any(|w| w[0] == "-bufsize" && w[1] == "32000k"));
        assert!(!a.contains(&"-crf".to_string()));
    }

    #[test]
    fn empty_video_track_but_audio_makes_single_black_segment() {
        // video track empty; audio track supplies duration
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let ac = clip("a1", "m1", 0.0, 0.0, 3.0);
        let atrack = Track {
            id: "at".into(), kind: "audio".into(), name: "Audio".into(),
            muted: false, clips: vec![ac],
        };
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![]), atrack]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(b.filter_complex.contains("concat=n=1:v=1:a=0[vout]"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("amix"));
    }

    #[test]
    fn very_long_filter_flags_script_mode_via_placeholder() {
        // Build many clips so the filtergraph is large, then verify caller can
        // detect > 8000 bytes and that the placeholder exists.
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut clips = Vec::new();
        for i in 0..300 {
            clips.push(clip(&format!("c{i}"), "m1", i as f64 * 2.0, 0.0, 1.0));
        }
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(clips)]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(b.filter_complex.len() > 8000, "len={}", b.filter_complex.len());
        let a = argstr(&b);
        assert!(a.contains(&FILTER_PLACEHOLDER.to_string()));
    }
}
