//! Pure `ExportSpec -> BuiltExport`. Never a shell string: media paths only
//! ever appear as standalone `-i` argv entries; the filtergraph references
//! stream indices. The video chain mirrors `src/editor/preview/transforms.ts`
//! (crop -> rotate -> flip -> scale-to-fit x userScale -> position -> opacity)
//! exactly so the export matches the preview.
//!
//! v0.6 additions:
//!   * unlimited stacked video layers — the bottom video track keeps the
//!     segment/concat pipeline (+ a tail-pad black segment to the full timeline
//!     duration); higher tracks are applied bottom->top, each clip becoming one
//!     windowed overlay stage.
//!   * per-clip keyframe animation on x/y/scale/opacity (sum-of-clamped-ramps
//!     expressions; scale via `eval=frame`; opacity via the verified alphamerge
//!     trick).
//!   * generated media (solid color + drawtext text) as lavfi source chains
//!     that consume no `-i` input slot.

use std::ffi::OsString;

use crate::error::{AppError, Result};
use crate::export::model::{BitratePreset, ExportSpec};
use crate::hw::EncoderReport;
use crate::project::schema::{
    Clip, Generator, Keyframe, MediaRef, Track,
};

/// Result of building an export. `start_export` decides whether to splice the
/// filtergraph inline (`-filter_complex <str>`) or into a script file
/// (`-filter_complex_script <path>`): the `FILTER_PLACEHOLDER` OsString in
/// `args` marks where the filter value goes, and the preceding flag is already
/// `-filter_complex`. The caller rewrites both when using script mode.
///
/// `text_payloads` carries the contents of each drawtext `textfile`. `build`
/// stays pure: it embeds an opaque placeholder (`TEXT_PLACEHOLDER_PREFIX{i}…`)
/// in the filtergraph where the escaped textfile path belongs; `start_export`
/// materialises each payload to `%TEMP%` and substitutes the escaped real path
/// before deciding inline-vs-script filter mode.
pub struct BuiltExport {
    pub args: Vec<OsString>,
    pub filter_complex: String,
    pub duration_sec: f64,
    /// (placeholder, file-content) pairs for drawtext textfiles.
    pub text_payloads: Vec<(String, String)>,
}

/// Sentinel argv entry replaced by `start_export` with either the inline
/// filter string or the script path.
pub const FILTER_PLACEHOLDER: &str = "\u{0}TAROTING_FILTER\u{0}";

/// Placeholder pattern for a drawtext textfile path. `build` embeds
/// `\u{0}TAROTING_TEXT_{i}\u{0}` (escaped-quoted) into the graph; `start_export`
/// swaps it for the escaped real path.
pub fn text_placeholder(i: usize) -> String {
    format!("\u{0}TAROTING_TEXT_{i}\u{0}")
}

fn round_even(v: f64) -> i64 {
    let n = v.round() as i64;
    n - (n % 2)
}

/* ------------------------------------------------------------------ */
/* Font mapping + filter-path escaping                                 */
/* ------------------------------------------------------------------ */

/// Map a (family, bold, italic) request to a concrete C:\Windows\Fonts file.
/// Impact has only a regular face, so bold/italic requests fall back to it.
fn font_file(family: &str, bold: bool, italic: bool) -> Option<&'static str> {
    let base = match family {
        "Segoe UI" => ["segoeui", "segoeuib", "segoeuii", "segoeuiz"],
        "Arial" => ["arial", "arialbd", "ariali", "arialbi"],
        "Georgia" => ["georgia", "georgiab", "georgiai", "georgiaz"],
        "Times New Roman" => ["times", "timesbd", "timesi", "timesbi"],
        "Courier New" => ["cour", "courbd", "couri", "courbi"],
        "Impact" => return Some("impact"),
        _ => return None,
    };
    let idx = match (bold, italic) {
        (false, false) => 0,
        (true, false) => 1,
        (false, true) => 2,
        (true, true) => 3,
    };
    // Map back to a &'static str.
    Some(match family {
        "Segoe UI" => ["segoeui", "segoeuib", "segoeuii", "segoeuiz"][idx],
        "Arial" => ["arial", "arialbd", "ariali", "arialbi"][idx],
        "Georgia" => ["georgia", "georgiab", "georgiai", "georgiaz"][idx],
        "Times New Roman" => ["times", "timesbd", "timesi", "timesbi"][idx],
        "Courier New" => ["cour", "courbd", "couri", "courbi"][idx],
        _ => base[idx],
    })
}

/// Full path to a mapped font file.
pub fn font_path(family: &str, bold: bool, italic: bool) -> Option<String> {
    font_file(family, bold, italic).map(|f| format!(r"C:\Windows\Fonts\{f}.ttf"))
}

/// Escape a filesystem path for use inside a drawtext filter option value:
/// backslashes -> forward slashes, ':' -> '\:', then wrap in single quotes.
/// A path containing a single quote cannot be represented and is rejected.
fn escape_filter_path(path: &str) -> Result<String> {
    if path.contains('\'') {
        return Err(AppError::BadInput(format!(
            "path contains a single quote which cannot be escaped for ffmpeg: {path}"
        )));
    }
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
    Ok(out)
}

/// Parse a "#RRGGBB" / "#RRGGBBAA" / "#RGB" color into ffmpeg `0xRRGGBB` plus an
/// optional two-hex-digit alpha suffix (from an 8-digit form). Falls back to
/// white on anything unparseable.
fn parse_color(color: &str) -> (String, Option<String>) {
    let hex = color.trim().trim_start_matches('#');
    let expand3 = |h: &str| -> String {
        h.chars().flat_map(|c| [c, c]).collect()
    };
    let (rgb, alpha) = match hex.len() {
        3 => (expand3(hex), None),
        6 => (hex.to_string(), None),
        8 => (hex[..6].to_string(), Some(hex[6..8].to_string())),
        _ => ("ffffff".to_string(), None),
    };
    if rgb.chars().all(|c| c.is_ascii_hexdigit()) {
        (rgb.to_lowercase(), alpha.map(|a| a.to_lowercase()))
    } else {
        ("ffffff".to_string(), None)
    }
}

/* ------------------------------------------------------------------ */
/* Keyframe breakpoints — mirrors anim.ts clampedBreakpoints           */
/* ------------------------------------------------------------------ */

/// Index of the last keyframe whose t <= s (binary search); -1 if before first.
fn floor_index(kfs: &[Keyframe], s: f64) -> isize {
    let (mut lo, mut hi, mut ans) = (0isize, kfs.len() as isize - 1, -1isize);
    while lo <= hi {
        let mid = (lo + hi) / 2;
        if kfs[mid as usize].t <= s {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    ans
}

/// Clamped linear evaluation of a keyframe track at source time s.
fn eval_kfs(kfs: &[Keyframe], s: f64) -> f64 {
    let n = kfs.len();
    debug_assert!(n > 0);
    let first = &kfs[0];
    if s <= first.t {
        return first.v;
    }
    let last = &kfs[n - 1];
    if s >= last.t {
        return last.v;
    }
    let i = floor_index(kfs, s);
    let a = &kfs[i as usize];
    let b = &kfs[i as usize + 1];
    let span = b.t - a.t;
    if span <= 0.0 {
        return a.v;
    }
    a.v + (b.v - a.v) * (s - a.t) / span
}

struct Breakpoint {
    tl: f64,
    v: f64,
}

/// Timeline-LOCAL breakpoints for a clip, identical to anim.ts
/// `clampedBreakpoints`: synthetic endpoints at tl=0 and tl=dur (clamped
/// evaluation), interior keyframes strictly inside (srcIn, srcOut) mapped to
/// (t-srcIn)/speed, dropping any within 1e-9 of an endpoint. Ghost keyframes
/// act only as interpolation anchors.
fn clamped_breakpoints(kfs: &[Keyframe], src_in: f64, src_out: f64, speed: f64) -> Vec<Breakpoint> {
    let dur = (src_out - src_in) / speed;
    let mut out = vec![Breakpoint { tl: 0.0, v: eval_kfs(kfs, src_in) }];
    for k in kfs {
        if k.t <= src_in || k.t >= src_out {
            continue;
        }
        let tl = (k.t - src_in) / speed;
        if tl <= 1e-9 || tl >= dur - 1e-9 {
            continue;
        }
        out.push(Breakpoint { tl, v: k.v });
    }
    out.push(Breakpoint { tl: dur, v: eval_kfs(kfs, src_out) });
    out
}

/// Emit a piecewise-linear expression as a sum of clamped ramps. `tvar` is the
/// clip-local time expression: `"t"` in concat segments (PTS restarts at 0),
/// `"(t-{start})"` inside overlay stages. Precision matches the plan (v to 4dp,
/// tl/dt to 4dp).
fn ramp_expr(bps: &[Breakpoint], tvar: &str) -> String {
    let mut e = format!("{:.4}", bps[0].v);
    for w in bps.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let dv = b.v - a.v;
        let dt = b.tl - a.tl;
        if dt.abs() < 1e-9 || dv.abs() < 1e-12 {
            continue;
        }
        e.push_str(&format!(
            "+({dv:.4})*clip(({tvar}-{:.4})/{dt:.4},0,1)",
            a.tl
        ));
    }
    e
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
    /// Post-crop source dims (before rotate), used to size the alphamerge mask.
    post_crop_w: i64,
    post_crop_h: i64,
    /// fitW/fitH for animated scale (cropW*fit, cropH*fit) — the pre-userScale
    /// display size that the scale expression multiplies by S(t).
    fit_w: f64,
    fit_h: f64,
    /// x/y offsets (before centering) — carried for animated overlay exprs.
    x: f64,
    y: f64,
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
        post_crop_w: crop_w.round() as i64,
        post_crop_h: crop_h.round() as i64,
        fit_w: crop_w * fit,
        fit_h: crop_h * fit,
        x,
        y,
    }
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/// A media source consumed by ffmpeg. `File` occupies one `-i` slot; generated
/// media never appear here (they are lavfi source chains in the filtergraph).
enum InputSource {
    File(OsString),
}

/// A leading-flags + source bundle. Assigned a stable input index by position.
struct InputEntry {
    flags: Vec<OsString>,
    source: InputSource,
}

struct AudioInput {
    input_index: usize,
    clip: Clip,
    /// timeline start in ms (adelay)
    delay_ms: i64,
}

/// How a video clip's frames enter the graph.
enum ClipInput {
    /// A real file input at this `-i` index → `[idx:v]`.
    File(usize),
    /// A lavfi generator source chain (already includes trim to clip_dur).
    Generated(Generator),
}

struct VideoSeg {
    input: ClipInput,
    clip: Clip,
}

/// A gap (pure black) or a clip segment on a video track.
enum Segment {
    Gap(f64),
    Clip(VideoSeg),
}

fn media_for<'a>(media: &'a [MediaRef], id: &str) -> Option<&'a MediaRef> {
    media.iter().find(|m| m.id == id)
}

/// A clip contributes audio iff its media has audio AND it isn't muted,
/// detached, or on a muted track.
fn clip_audible(clip: &Clip, media: &MediaRef, track: &Track) -> bool {
    media.has_audio && !clip.audio.muted && !clip.audio.detached && !track.muted
}

/// Register a video clip's frame source, pushing a File input entry when the
/// media is a real file (generated media consume no slot).
fn register_clip_input(
    inputs: &mut Vec<InputEntry>,
    clip: &Clip,
    media: &MediaRef,
) -> ClipInput {
    if let Some(gen) = &media.generator {
        return ClipInput::Generated(gen.clone());
    }
    let idx = inputs.len();
    let mut flags: Vec<OsString> = Vec::new();
    if media.kind == "image" {
        flags.push("-loop".into());
        flags.push("1".into());
        flags.push("-t".into());
        flags.push(format!("{:.6}", clip.duration()).into());
    } else {
        flags.push("-ss".into());
        flags.push(format!("{:.6}", clip.src_in).into());
        flags.push("-to".into());
        flags.push(format!("{:.6}", clip.src_out).into());
    }
    flags.push("-i".into());
    inputs.push(InputEntry {
        flags,
        source: InputSource::File(OsString::from(&media.path)),
    });
    ClipInput::File(idx)
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
    let total_clips: usize = spec.timeline.tracks.iter().map(|t| t.clips.len()).sum();
    if total_clips == 0 {
        return Err(AppError::BadInput(
            "cannot export an empty timeline (no clips)".into(),
        ));
    }

    // Pre-check every text generator maps to an existing font file before we
    // spawn ffmpeg, so failures surface as a clear BadInput.
    for m in &spec.media {
        if let Some(Generator::Text { font_family, bold, italic, .. }) = &m.generator {
            match font_path(font_family, *bold, *italic) {
                Some(p) => {
                    if !std::path::Path::new(&p).exists() {
                        return Err(AppError::BadInput(format!(
                            "font file for '{font_family}' not found at {p}"
                        )));
                    }
                }
                None => {
                    return Err(AppError::BadInput(format!(
                        "unsupported text font family '{font_family}'"
                    )));
                }
            }
        }
    }

    let (canvas_w, canvas_h) = preset.output_dims(spec.timeline.width, spec.timeline.height);
    let fps_str = preset.output_fps(&spec.timeline);
    let duration_sec = spec.timeline.duration();

    // Video tracks are a contiguous prefix; tracks[0] is TOPMOST, the last
    // video track is the BOTTOM layer that owns the concat pipeline.
    let video_tracks: Vec<&Track> = spec
        .timeline
        .tracks
        .iter()
        .filter(|t| t.kind == "video")
        .collect();

    let mut inputs: Vec<InputEntry> = Vec::new();
    let mut text_payloads: Vec<(String, String)> = Vec::new();

    /* ---- bottom track → segment list (owns concat + tail-pad) ---- */
    let bottom = video_tracks.last().copied();
    let mut segments: Vec<Segment> = Vec::new();
    if let Some(bt) = bottom {
        let mut vclips = bt.clips.clone();
        vclips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
        let mut cursor = 0.0_f64;
        for clip in &vclips {
            let media = media_for(&spec.media, &clip.media_id).ok_or_else(|| {
                AppError::BadInput(format!("clip references unknown media {}", clip.media_id))
            })?;
            let gap = clip.timeline_start - cursor;
            if gap > 0.0005 {
                segments.push(Segment::Gap(gap));
            }
            let input = register_clip_input(&mut inputs, clip, media);
            segments.push(Segment::Clip(VideoSeg { input, clip: clip.clone() }));
            cursor = clip.end();
        }
        // tail-pad to the full timeline duration when the bottom track's
        // content ends early.
        let tail = duration_sec - cursor;
        if tail > 0.0005 {
            segments.push(Segment::Gap(tail));
        }
    }

    /* ---- higher tracks (bottom->top, excluding the bottom) ---- */
    // Each higher clip becomes one overlay stage. We collect them per track in
    // reverse index order so the topmost track (tracks[0]) is applied last.
    struct OverlayClip {
        input: ClipInput,
        clip: Clip,
    }
    let mut overlay_layers: Vec<Vec<OverlayClip>> = Vec::new();
    if video_tracks.len() > 1 {
        // indices 0..len-1 are the higher tracks; iterate them in REVERSE so we
        // emit bottom-most higher track first, ending with tracks[0].
        for track in video_tracks[..video_tracks.len() - 1].iter().rev() {
            let mut clips = track.clips.clone();
            clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
            let mut layer: Vec<OverlayClip> = Vec::new();
            for clip in &clips {
                let media = media_for(&spec.media, &clip.media_id).ok_or_else(|| {
                    AppError::BadInput(format!(
                        "clip references unknown media {}",
                        clip.media_id
                    ))
                })?;
                let input = register_clip_input(&mut inputs, clip, media);
                layer.push(OverlayClip { input, clip: clip.clone() });
            }
            overlay_layers.push(layer);
        }
    }

    /* ---- audio inputs (track order, then start) ---- */
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
            let idx = inputs.len();
            let mut flags: Vec<OsString> = Vec::new();
            flags.push("-ss".into());
            flags.push(format!("{:.6}", clip.src_in).into());
            flags.push("-to".into());
            flags.push(format!("{:.6}", clip.src_out).into());
            flags.push("-i".into());
            inputs.push(InputEntry {
                flags,
                source: InputSource::File(OsString::from(&media.path)),
            });
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
    let mut gen = GraphGen {
        w: canvas_w,
        h: canvas_h,
        fps: &fps_str,
        text_payloads: &mut text_payloads,
        stage_n: 0,
    };
    let has_overlays = overlay_layers.iter().any(|l| !l.is_empty());
    // With no higher layers the bottom concat writes [vout] directly (goldens
    // stay byte-identical). With overlays the concat writes an intermediate
    // label that overlay stages thread up to the final [vout].
    let base_out = if has_overlays { None } else { Some("[vout]") };
    let mut prev = gen.build_bottom(&mut fc, &segments, &spec.media, duration_sec, base_out);

    // Apply higher layers bottom->top, threading the composite label. The last
    // overlay stage writes [vout].
    let overlay_clips: Vec<&OverlayClip> =
        overlay_layers.iter().flatten().collect();
    for (i, oc) in overlay_clips.iter().enumerate() {
        let media = media_for(&spec.media, &oc.clip.media_id).expect("validated");
        let last = i + 1 == overlay_clips.len();
        let out = if last { Some("[vout]") } else { None };
        prev = gen.build_overlay_stage(&mut fc, &prev, &oc.input, &oc.clip, media, out);
    }
    let _ = prev;

    // Normalize: the video graph must end WITHOUT a trailing ';' so the gif and
    // audio sub-graphs (which prepend their own ';') splice cleanly. The
    // no-overlay concat path already ends bare; overlay stages leave a ';'.
    if fc.ends_with(';') {
        fc.pop();
    }

    if is_gif {
        fc.push_str(";[vout]split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=bayer:bayer_scale=4[gifout]");
    }

    if want_audio {
        build_audio_graph(&mut fc, &audio_inputs, duration_sec);
    }

    /* ---- assemble argv ---- */
    let mut args: Vec<OsString> = Vec::new();
    for a in ["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"] {
        args.push(a.into());
    }
    for entry in &inputs {
        for f in &entry.flags {
            args.push(f.clone());
        }
        match &entry.source {
            InputSource::File(p) => args.push(p.clone()),
        }
    }

    args.push("-filter_complex".into());
    args.push(FILTER_PLACEHOLDER.into());

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

    if is_gif {
        // palette pipeline handles color
    } else {
        push_video_codec(&mut args, spec, encoders);
    }

    if is_gif {
        // gif has no audio
    } else if want_audio {
        push_audio_codec(&mut args, spec);
        args.push("-ar".into());
        args.push("48000".into());
    } else {
        args.push("-an".into());
    }

    push_container(&mut args, format);
    args.push(OsString::from(&spec.out_path));

    Ok(BuiltExport {
        args,
        filter_complex: fc,
        duration_sec,
        text_payloads,
    })
}

/* ------------------------------------------------------------------ */
/* Video graph generator                                               */
/* ------------------------------------------------------------------ */

struct GraphGen<'a> {
    w: u32,
    h: u32,
    fps: &'a str,
    text_payloads: &'a mut Vec<(String, String)>,
    /// monotonically increasing suffix for unique stage labels
    stage_n: usize,
}

impl<'a> GraphGen<'a> {
    fn next_n(&mut self) -> usize {
        let n = self.stage_n;
        self.stage_n += 1;
        n
    }

    /// Emit the lavfi source chain for a generator, producing frames of the
    /// generated media at `dur` seconds. The returned expression is the head of
    /// the per-clip chain (a source, not a filtered stream label).
    fn generator_source(&mut self, gen: &Generator, dur: f64) -> Result<String> {
        let (w, h, fps) = (self.w, self.h, self.fps);
        match gen {
            Generator::Solid { color } => {
                let (rgb, _) = parse_color(color);
                Ok(format!("color=c=0x{rgb}:s={w}x{h}:r={fps}:d={dur:.6}"))
            }
            Generator::Text {
                text,
                font_family,
                size_px,
                color,
                bold,
                italic,
            } => {
                let font = font_path(font_family, *bold, *italic).ok_or_else(|| {
                    AppError::BadInput(format!("unsupported text font family '{font_family}'"))
                })?;
                let font_esc = escape_filter_path(&font)?;
                let (rgb, alpha) = parse_color(color);
                let aa = alpha.unwrap_or_default();
                let px = size_px.round().max(1.0) as i64;
                let line_spacing = (0.25 * size_px).round() as i64;
                let idx = self.text_payloads.len();
                let placeholder = text_placeholder(idx);
                self.text_payloads.push((placeholder.clone(), text.clone()));
                // The textfile placeholder is embedded escaped-quoted; the
                // caller substitutes the escaped real path for the placeholder
                // BEFORE deciding inline-vs-script filter mode.
                let text_ref = escape_filter_path(&placeholder)?;
                Ok(format!(
                    "color=black@0.0:s={w}x{h}:r={fps}:d={dur:.6},format=rgba,\
drawtext=fontfile={font_esc}:textfile={text_ref}:fontsize={px}:fontcolor=0x{rgb}{aa}:\
x=0:y=0:line_spacing={line_spacing}:expansion=none"
                ))
            }
        }
    }

    /// Build the bottom-track segment/concat pipeline. Returns the label of the
    /// composite (`[vout]` when there are no higher layers to apply). When
    /// overlays follow, the caller threads this label into overlay stages.
    fn build_bottom(
        &mut self,
        fc: &mut String,
        segments: &[Segment],
        media: &[MediaRef],
        duration_sec: f64,
        final_label: Option<&str>,
    ) -> String {
        let (w, h, fps) = (self.w, self.h, self.fps);
        let mut labels: Vec<String> = Vec::new();

        if segments.is_empty() {
            let d = duration_sec.max(0.04);
            let n = self.next_n();
            fc.push_str(&format!("color=black:s={w}x{h}:r={fps}:d={d:.6}[s{n}];"));
            labels.push(format!("[s{n}]"));
        } else {
            for seg in segments {
                match seg {
                    Segment::Gap(g) => {
                        let n = self.next_n();
                        fc.push_str(&format!("color=black:s={w}x{h}:r={fps}:d={g:.6}[s{n}];"));
                        labels.push(format!("[s{n}]"));
                    }
                    Segment::Clip(vseg) => {
                        let clip = &vseg.clip;
                        let m = media
                            .iter()
                            .find(|m| m.id == clip.media_id)
                            .expect("media exists (validated in build)");
                        let p = placement(clip, m, w, h);
                        let clip_dur = clip.duration();
                        let n = self.next_n();

                        // per-clip chain → [v{n}]; concat segments have PTS
                        // restarting at 0 so keyframe time var is "t".
                        let chain_label = format!("[v{n}]");
                        self.emit_clip_chain(
                            fc,
                            &vseg.input,
                            clip,
                            &p,
                            clip_dur,
                            &chain_label,
                            None,
                        );

                        // black base for this segment, overlay clip onto it.
                        fc.push_str(&format!(
                            "color=black:s={w}x{h}:r={fps}:d={clip_dur:.6}[b{n}];"
                        ));
                        let (ox, oy) = self.overlay_xy(clip, &p, "t");
                        fc.push_str(&format!(
                            "[b{n}]{chain_label}overlay={ox}:{oy}:shortest=1[s{n}];"
                        ));
                        labels.push(format!("[s{n}]"));
                    }
                }
            }
        }

        // concat all segments. With no higher layers we write the final label
        // directly (byte-identical to v0.5); otherwise an intermediate label.
        let count = labels.len();
        for l in &labels {
            fc.push_str(l);
        }
        match final_label {
            Some(out) => {
                fc.push_str(&format!("concat=n={count}:v=1:a=0{out}"));
                out.to_string()
            }
            None => {
                let cn = self.next_n();
                fc.push_str(&format!("concat=n={count}:v=1:a=0[cc{cn}];"));
                format!("[cc{cn}]")
            }
        }
    }

    /// One overlay stage for a higher-layer clip: trimmed input → per-clip chain
    /// with `setpts=PTS+start/TB` last → windowed overlay onto `prev`. Returns
    /// the new composite label.
    fn build_overlay_stage(
        &mut self,
        fc: &mut String,
        prev: &str,
        input: &ClipInput,
        clip: &Clip,
        media: &MediaRef,
        final_label: Option<&str>,
    ) -> String {
        let p = placement(clip, media, self.w, self.h);
        let clip_dur = clip.duration();
        let n = self.next_n();
        let start = clip.timeline_start;
        let end = clip.end();

        // Overlay stages live on the timeline clock: the chain's own time var is
        // clip-local ("t") for scale/geq, and the overlay x/y/enable use
        // "(t-start)". The final setpts shift moves the chain onto the timeline.
        let chain_label = format!("[ov{n}]");
        self.emit_clip_chain(
            fc,
            input,
            clip,
            &p,
            clip_dur,
            &chain_label,
            Some(start),
        );

        let (ox, oy) = self.overlay_xy(clip, &p, &format!("(t-{start:.4})"));
        let out = final_label.map(|s| s.to_string()).unwrap_or_else(|| format!("[nxt{n}]"));
        fc.push_str(&format!(
            "{prev}{chain_label}overlay={ox}:{oy}:\
enable='gte(t,{start:.6})*lt(t,{end:.6})'{out};"
        ));
        out
    }

    /// Emit the full per-clip filter chain into `[out_label]`.
    ///
    /// Order: source/input → setpts speed → crop → [opacity alphamerge] →
    /// transpose/flips → scale (animated or static) → setsar=1 → fps →
    /// [static opacity colorchannelmixer] → [setpts timeline shift].
    ///
    /// Animated scale/geq always use the clip-local time var ("t"/"T") since
    /// those filters run before the final setpts shift. `shift_start` =
    /// Some(start) for overlay stages (appends the trailing
    /// `setpts=PTS+start/TB`); None for concat segments.
    #[allow(clippy::too_many_arguments)]
    fn emit_clip_chain(
        &mut self,
        fc: &mut String,
        input: &ClipInput,
        clip: &Clip,
        p: &Placement,
        clip_dur: f64,
        out_label: &str,
        shift_start: Option<f64>,
    ) {
        let fps = self.fps;
        let mut chain = String::new();

        // head: file stream label OR generator lavfi source
        match input {
            ClipInput::File(i) => {
                chain.push_str(&format!("[{i}:v]setpts=(PTS-STARTPTS)/{:.6}", clip.speed));
            }
            ClipInput::Generated(gen) => {
                // generated media trim to clip_dur locally; speed still applies.
                let src = self
                    .generator_source(gen, clip_dur * clip.speed)
                    .expect("generator source (font pre-checked)");
                chain.push_str(&src);
                chain.push_str(&format!(",trim=0:{:.6},setpts=(PTS-STARTPTS)/{:.6}", clip_dur * clip.speed, clip.speed));
            }
        }

        if let Some((cw, ch, cx, cy)) = p.crop {
            chain.push_str(&format!(",crop={cw}:{ch}:{cx}:{cy}"));
        }

        // Animated opacity: insert the alphamerge trick after crop, before
        // transpose. Post-crop dims size the mask. geq's own time var is capital
        // T (clip-local, before the setpts shift).
        let opacity_kfs = clip.keyframes.as_ref().and_then(|k| k.opacity.as_ref());
        if let Some(kfs) = opacity_kfs.filter(|k| k.len() >= 2) {
            let bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
            let expr = ramp_expr(&bps, "T");
            let (cw, ch) = (p.post_crop_w.max(1), p.post_crop_h.max(1));
            let a = self.next_n();
            chain.push_str(&format!(
                "[chain{a}];color=black:s=16x16:r={fps}:d={clip_dur:.6},format=gray,\
geq=lum='255*({expr})',scale={cw}:{ch}[al{a}];[chain{a}][al{a}]alphamerge"
            ));
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

        // scale — animated (eval=frame) or static.
        let scale_kfs = clip.keyframes.as_ref().and_then(|k| k.scale.as_ref());
        if let Some(kfs) = scale_kfs.filter(|k| k.len() >= 2) {
            let bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
            // scale runs before the setpts shift → time var is clip-local "t".
            let s = ramp_expr(&bps, "t");
            chain.push_str(&format!(
                ",scale=w='trunc({:.4}*({s})/2)*2':h='trunc({:.4}*({s})/2)*2':eval=frame",
                p.fit_w, p.fit_h
            ));
        } else {
            chain.push_str(&format!(",scale={}:{}", p.dw, p.dh));
        }
        chain.push_str(&format!(",setsar=1,fps={fps}"));

        // static opacity (only when not animated)
        if opacity_kfs.filter(|k| k.len() >= 2).is_none() && p.opacity < 0.999 {
            chain.push_str(&format!(",format=rgba,colorchannelmixer=aa={:.4}", p.opacity));
        }

        // overlay stages shift onto the timeline as the LAST filter.
        if let Some(start) = shift_start {
            chain.push_str(&format!(",setpts=PTS+{start:.6}/TB"));
        }

        chain.push_str(&format!("{out_label};"));
        fc.push_str(&chain);
    }

    /// The overlay x/y expressions. When position or scale animates, x/y become
    /// centered expressions (`(main_w-overlay_w)/2 + X`); otherwise the static
    /// integer ox:oy. `tbase` is the overlay-clock time expression used by
    /// animated x/y ("t" for concat, "(t-start)" for overlay stages).
    fn overlay_xy(&self, clip: &Clip, p: &Placement, tbase: &str) -> (String, String) {
        let x_kfs = clip.keyframes.as_ref().and_then(|k| k.x.as_ref());
        let y_kfs = clip.keyframes.as_ref().and_then(|k| k.y.as_ref());
        let scale_anim = clip
            .keyframes
            .as_ref()
            .and_then(|k| k.scale.as_ref())
            .filter(|k| k.len() >= 2)
            .is_some();
        let x_anim = x_kfs.filter(|k| k.len() >= 2).is_some();
        let y_anim = y_kfs.filter(|k| k.len() >= 2).is_some();

        // Centered expressions are needed whenever position OR scale animates
        // (scale changes overlay_w/h per frame, so a fixed ox no longer centers).
        if !x_anim && !y_anim && !scale_anim {
            return (format!("{}", p.ox), format!("{}", p.oy));
        }

        let x_off = if let Some(kfs) = x_kfs.filter(|k| k.len() >= 2) {
            let bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
            ramp_expr(&bps, tbase)
        } else {
            format!("{:.4}", p.x)
        };
        let y_off = if let Some(kfs) = y_kfs.filter(|k| k.len() >= 2) {
            let bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
            ramp_expr(&bps, tbase)
        } else {
            format!("{:.4}", p.y)
        };
        (
            format!("'(main_w-overlay_w)/2+{x_off}'"),
            format!("'(main_h-overlay_h)/2+{y_off}'"),
        )
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
        for f in atempo_factors(clip.speed) {
            chain.push_str(&format!("atempo={f},"));
        }
        chain.push_str("asetpts=PTS-STARTPTS");
        let gain = clip.audio.volume * 10f64.powf(clip.audio.gain_offset_db / 20.0);
        chain.push_str(&format!(",volume={gain:.4}"));
        if clip.audio.fade_in_sec > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={:.4}", clip.audio.fade_in_sec));
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

    fn gen_media(id: &str, generator: Generator) -> MediaRef {
        MediaRef {
            id: id.into(),
            path: "gen".into(),
            size: 0,
            mtime_ms: 0,
            kind: "image".into(),
            duration: 0.0,
            fps: None,
            width: Some(400),
            height: Some(200),
            container: None,
            vcodec: None,
            acodec: None,
            pix_fmt: None,
            bit_depth: None,
            has_audio: false,
            audio_rate: None,
            audio_channels: None,
            generator: Some(generator),
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

    fn vtrack_id(id: &str, clips: Vec<Clip>) -> Track {
        Track { id: id.into(), kind: "video".into(), name: "Video".into(), muted: false, clips }
    }

    fn vtrack(clips: Vec<Clip>) -> Track {
        vtrack_id("vt", clips)
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
        assert!(b.filter_complex.contains("concat=n=1:v=1:a=0"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("scale=1920:1080"));
        assert!(b.filter_complex.contains("overlay=0:0:shortest=1"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("[vout]"), "{}", b.filter_complex);
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(a.windows(2).any(|w| w[0] == "-crf" && w[1] == "20"));
        assert!(a.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p"));
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "mp4"));
        assert_eq!(a.last().unwrap(), r"C:\out.mp4");
        assert!(a.contains(&r"C:\v.mp4".to_string()));
    }

    #[test]
    fn two_clips_with_gap_makes_black_segment_concat_n3() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let c1 = clip("c1", "m1", 0.0, 0.0, 2.0);
        let c2 = clip("c2", "m1", 3.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c1, c2])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(b.filter_complex.contains("color=black:s=1920x1080:r=30:d=1.000000"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("concat=n=3:v=1:a=0"), "{}", b.filter_complex);
    }

    #[test]
    fn speed_crop_rotate_flip_opacity_chain() {
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
        assert!(fc.contains("setpts=(PTS-STARTPTS)/2.000000"), "{fc}");
        assert!(fc.contains("crop=50:50:10:10"), "{fc}");
        assert!(fc.contains("transpose=1"), "{fc}");
        assert!(fc.contains("hflip"), "{fc}");
        assert!(!fc.contains("vflip"), "{fc}");
        assert!(fc.contains("scale=100:100"), "{fc}");
        assert!(fc.contains("colorchannelmixer=aa=0.5000"), "{fc}");
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
        assert!(fc.contains("volume=0.9976"), "{fc}");
        assert!(fc.contains("afade=t=in:st=0:d=0.5000"), "{fc}");
        assert!(fc.contains("afade=t=out:st=2.0000:d=1.0000"), "{fc}");
        assert!(fc.contains("adelay=1500|1500"), "{fc}");
        assert!(fc.contains("amix=inputs=2:duration=first:normalize=0[aout]"), "{fc}");
        assert!(fc.contains("anullsrc=r=48000:cl=stereo"), "{fc}");
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
        assert!(a.windows(2).any(|w| w[0] == "-ar" && w[1] == "48000"));
    }

    #[test]
    fn atempo_chain_for_extreme_speeds() {
        let f = atempo_factors(0.25);
        assert_eq!(f.len(), 2);
        assert!(f.iter().all(|&x| (x - 0.5).abs() < 1e-9));
        let f = atempo_factors(3.0);
        assert_eq!(f.len(), 2);
        assert!((f[0] - 2.0).abs() < 1e-9);
        assert!((f[1] - 1.5).abs() < 1e-9);
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
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let ac = clip("a1", "m1", 0.0, 0.0, 3.0);
        let atrack = Track {
            id: "at".into(), kind: "audio".into(), name: "Audio".into(),
            muted: false, clips: vec![ac],
        };
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![]), atrack]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(b.filter_complex.contains("concat=n=1:v=1:a=0"), "{}", b.filter_complex);
        assert!(b.filter_complex.contains("amix"));
    }

    #[test]
    fn very_long_filter_flags_script_mode_via_placeholder() {
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

    /* ----- v0.6 additions ----- */

    #[test]
    fn tail_pad_black_when_bottom_ends_early() {
        // bottom clip ends at 2s; a longer audio clip pushes timeline to 5s.
        let m = media("m1", r"C:\v.mp4", 1920, 1080, true);
        let vc = clip("c1", "m1", 0.0, 0.0, 2.0);
        let ac = clip("a1", "m1", 0.0, 0.0, 5.0);
        let atrack = Track {
            id: "at".into(), kind: "audio".into(), name: "Audio".into(),
            muted: false, clips: vec![ac],
        };
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack(vec![vc]), atrack]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // clip segment + tail-pad black to 5s → concat n=2, a 3s black tail.
        assert!(fc.contains("color=black:s=1920x1080:r=30:d=3.000000"), "{fc}");
        assert!(fc.contains("concat=n=2:v=1:a=0"), "{fc}");
    }

    #[test]
    fn two_stacked_tracks_overlay_stage_with_enable_and_setpts() {
        // bottom: 6s clip. top: 2s clip windowed at [2,4).
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let bottom = clip("b1", "m1", 0.0, 0.0, 6.0);
        let mut top = clip("t1", "m1", 2.0, 0.0, 2.0);
        top.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 1.0, x: 0.0, y: 0.0, opacity: 1.0,
        });
        let top_track = vtrack_id("vtop", vec![top]);
        let bot_track = vtrack_id("vbot", vec![bottom]);
        // tracks[0] = top (topmost), last = bottom.
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![top_track, bot_track]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // overlay stage with enable window [2,4) and setpts shift by start=2.
        assert!(fc.contains("enable='gte(t,2.000000)*lt(t,4.000000)'"), "{fc}");
        assert!(fc.contains("setpts=PTS+2.000000/TB"), "{fc}");
        assert!(fc.contains("[vout]"), "{fc}");
        // two -i inputs (bottom + top), no lavfi generated source.
        let a = argstr(&b);
        assert_eq!(a.iter().filter(|s| s.as_str() == "-i").count(), 2);
    }

    #[test]
    fn animated_x_emits_ramp_expression() {
        // 2-kf x animation: v0=0 at srcIn, v1=100 at srcOut. clip 0..4 @1x.
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut top = clip("t1", "m1", 0.0, 0.0, 4.0);
        top.keyframes = Some(ClipKeyframes {
            x: Some(vec![Keyframe { t: 0.0, v: 0.0 }, Keyframe { t: 4.0, v: 100.0 }]),
            y: None, scale: None, opacity: None,
        });
        let bottom = clip("b1", "m1", 0.0, 0.0, 4.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack_id("vtop", vec![top]), vtrack_id("vbot", vec![bottom])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // overlay x uses centered expr with (t-start) ramp; start=0.
        assert!(
            fc.contains("'(main_w-overlay_w)/2+0.0000+(100.0000)*clip(((t-0.0000)-0.0000)/4.0000,0,1)'"),
            "{fc}"
        );
    }

    #[test]
    fn animated_scale_uses_eval_frame_and_trunc() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut top = clip("t1", "m1", 0.0, 0.0, 4.0);
        top.keyframes = Some(ClipKeyframes {
            x: None, y: None,
            scale: Some(vec![Keyframe { t: 0.0, v: 1.0 }, Keyframe { t: 4.0, v: 2.0 }]),
            opacity: None,
        });
        let bottom = clip("b1", "m1", 0.0, 0.0, 4.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack_id("vtop", vec![top]), vtrack_id("vbot", vec![bottom])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("eval=frame"), "{fc}");
        assert!(fc.contains("scale=w='trunc("), "{fc}");
        assert!(fc.contains("/2)*2'"), "{fc}");
        // scale ramp uses clip-local "t".
        assert!(fc.contains("*(1.0000+(1.0000)*clip((t-0.0000)/4.0000,0,1))/2)*2"), "{fc}");
    }

    #[test]
    fn animated_opacity_uses_alphamerge_geq_16x16() {
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut top = clip("t1", "m1", 0.0, 0.0, 4.0);
        top.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 0.2 }, Keyframe { t: 4.0, v: 1.0 }]),
        });
        let bottom = clip("b1", "m1", 0.0, 0.0, 4.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack_id("vtop", vec![top]), vtrack_id("vbot", vec![bottom])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("s=16x16"), "{fc}");
        assert!(fc.contains("format=gray,geq=lum='255*("), "{fc}");
        assert!(fc.contains("alphamerge"), "{fc}");
        // geq uses capital T time var.
        assert!(fc.contains("clip((T-0.0000)"), "{fc}");
        // no static colorchannelmixer when opacity is animated.
        assert!(!fc.contains("colorchannelmixer"), "{fc}");
    }

    #[test]
    fn ghost_keyframe_endpoints_clamp() {
        // kfs live outside the trim window [1,3): a ghost at t=0 (v=10) and one
        // at t=4 (v=90), interior at t=2 (v=50). srcIn=1, srcOut=3.
        let kfs = vec![
            Keyframe { t: 0.0, v: 10.0 },
            Keyframe { t: 2.0, v: 50.0 },
            Keyframe { t: 4.0, v: 90.0 },
        ];
        let bps = clamped_breakpoints(&kfs, 1.0, 3.0, 1.0);
        // endpoints: at srcIn=1 → lerp(10@0,50@2)=30; at srcOut=3 → lerp(50@2,90@4)=70.
        assert_eq!(bps.len(), 3);
        assert!((bps[0].v - 30.0).abs() < 1e-9, "{}", bps[0].v);
        assert!((bps[0].tl - 0.0).abs() < 1e-9);
        assert!((bps[1].v - 50.0).abs() < 1e-9);
        assert!((bps[1].tl - 1.0).abs() < 1e-9);
        assert!((bps[2].v - 70.0).abs() < 1e-9, "{}", bps[2].v);
        assert!((bps[2].tl - 2.0).abs() < 1e-9);
    }

    #[test]
    fn solid_generator_is_lavfi_no_extra_input() {
        let gm = gen_media("g1", Generator::Solid { color: "#ff0000".into() });
        let c = clip("c1", "g1", 0.0, 0.0, 3.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("color=c=0xff0000:s=1920x1080"), "{fc}");
        // generated media consume no -i input slot.
        let a = argstr(&b);
        assert_eq!(a.iter().filter(|s| s.as_str() == "-i").count(), 0);
    }

    #[test]
    fn text_generator_emits_drawtext_with_escaped_font_and_placeholder() {
        let gm = gen_media("g1", Generator::Text {
            text: "Hello: 100%".into(),
            font_family: "Georgia".into(),
            size_px: 96.0,
            color: "#ffffff".into(),
            bold: false,
            italic: false,
        });
        let c = clip("c1", "g1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // fontfile escaped: drive colon → \: and backslashes → forward slashes.
        assert!(fc.contains(r"fontfile='C\:/Windows/Fonts/georgia.ttf'"), "{fc}");
        assert!(fc.contains("expansion=none"), "{fc}");
        assert!(fc.contains("fontcolor=0xffffff"), "{fc}");
        // textfile placeholder present + payload carries the raw text.
        assert!(fc.contains(&text_placeholder(0)), "{fc}");
        assert_eq!(b.text_payloads.len(), 1);
        assert_eq!(b.text_payloads[0].1, "Hello: 100%");
    }

    #[test]
    fn impact_bold_falls_back_to_regular() {
        assert_eq!(font_file("Impact", true, true), Some("impact"));
        assert_eq!(font_path("Impact", true, false).as_deref(), Some(r"C:\Windows\Fonts\impact.ttf"));
    }

    #[test]
    fn escape_filter_path_handles_space_and_colon() {
        let e = escape_filter_path(r"C:\my media\a.ttf").unwrap();
        assert_eq!(e, r"'C\:/my media/a.ttf'");
        // embedded single quote is rejected.
        assert!(escape_filter_path("a'b").is_err());
    }

    #[test]
    fn generated_clip_with_speed_applies_setpts() {
        let gm = gen_media("g1", Generator::Solid { color: "#00ff00".into() });
        let mut c = clip("c1", "g1", 0.0, 0.0, 4.0);
        c.speed = 2.0; // dur = (4-0)/2 = 2s
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!((b.duration_sec - 2.0).abs() < 1e-6, "{}", b.duration_sec);
        // source generated at dur*speed then setpts speed-divided.
        assert!(fc.contains("setpts=(PTS-STARTPTS)/2.000000"), "{fc}");
        assert!(fc.contains("trim=0:"), "{fc}");
    }

    #[test]
    fn missing_font_is_bad_input() {
        // unsupported family → BadInput before any spawn.
        let gm = gen_media("g1", Generator::Text {
            text: "x".into(),
            font_family: "Comic Sans".into(),
            size_px: 40.0,
            color: "#ffffff".into(),
            bold: false, italic: false,
        });
        let c = clip("c1", "g1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let r = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc());
        assert!(r.is_err());
    }
}
