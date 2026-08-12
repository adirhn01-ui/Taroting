//! Pure `ExportSpec -> BuiltExport`. Never a shell string: media paths only
//! ever appear as standalone `-i` argv entries; the filtergraph references
//! stream indices. The video chain mirrors `src/editor/preview/transforms.ts`
//! (crop -> flip -> rotate -> scale-to-fit x userScale -> position -> opacity)
//! exactly so the export matches the preview. Flip precedes rotate so the
//! composite is source->screen = R*F (see `emit_clip_chain`).
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
    let faces: [&'static str; 4] = match family {
        "Segoe UI" => ["segoeui", "segoeuib", "segoeuii", "segoeuiz"],
        "Arial" => ["arial", "arialbd", "ariali", "arialbi"],
        "Georgia" => ["georgia", "georgiab", "georgiai", "georgiaz"],
        "Times New Roman" => ["times", "timesbd", "timesi", "timesbi"],
        "Courier New" => ["cour", "courbd", "couri", "courbi"],
        "Impact" => return Some("impact"),
        _ => return None,
    };
    // [regular, bold, italic, bold-italic]
    Some(faces[usize::from(bold) + 2 * usize::from(italic)])
}

/// Full path to a mapped font file.
pub fn font_path(family: &str, bold: bool, italic: bool) -> Option<String> {
    font_file(family, bold, italic).map(|f| format!(r"C:\Windows\Fonts\{f}.ttf"))
}

/// FreeType's line height as a fraction of font size, per whitelisted family.
/// drawtext's pitch is `max_glyph_h + line_spacing`, so this makes the exported
/// pitch equal the preview's fixed `line-height: 1.25`.
fn line_height_em(family: &str) -> f64 {
    match family {
        "Segoe UI" => 1.3301,
        "Georgia" => 1.1362,
        "Courier New" => 1.1328,
        "Impact" => 1.2197,
        _ => 1.1499, // Arial, Times New Roman
    }
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
    // Validate the WHOLE string before any slicing. Two reasons this must come
    // first: `hex.len()` is a byte count while `hex[..6]` is a byte-index slice,
    // so a multi-byte char (e.g. "#aaaaaÀa", 8 bytes) lands mid-char and panics
    // — and with `panic = "abort"` that kills the app mid-export. And the alpha
    // suffix is spliced straight into the drawtext `fontcolor=` option, so it
    // has to be hex-validated too, not just the rgb half. `.trt` files are
    // shareable, so a hand-edited color is attacker-controlled input.
    // is_ascii_hexdigit() is false for every non-ASCII char, so passing this
    // guard proves byte length == char count and every index below is a
    // char boundary.
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return ("ffffff".to_string(), None);
    }
    match hex.len() {
        3 => (
            hex.chars().flat_map(|c| [c, c]).collect::<String>().to_lowercase(),
            None,
        ),
        6 => (hex.to_lowercase(), None),
        8 => (hex[..6].to_lowercase(), Some(hex[6..8].to_lowercase())),
        _ => ("ffffff".to_string(), None),
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
    /// Pre-crop source dims. A generated frame MUST be synthesized at this size:
    /// crop/scale/alphamerge downstream all assume the chain starts here.
    src_w: i64,
    src_h: i64,
    /// fitW/fitH for animated scale (cropW*fit, cropH*fit) — the pre-userScale
    /// display size that the scale expression multiplies by S(t).
    fit_w: f64,
    fit_h: f64,
    /// x/y offsets (before centering), ALREADY CONVERTED TO OUTPUT px — carried
    /// for animated overlay exprs. See `placement` for the two pixel spaces.
    x: f64,
    y: f64,
    /// Project-canvas px -> output px, per axis. Keyframed x/y values are
    /// authored in canvas px exactly like the static offsets, so `overlay_xy`
    /// needs these to convert them too.
    sx: f64,
    sy: f64,
}

/// Compute per-clip crop rect + scaled display size + overlay position, using
/// the identical fit math as the preview transform.
///
/// TWO PIXEL SPACES MEET HERE and mixing them is precisely the bug this
/// signature exists to make hard:
///   * `canvas` is the PROJECT canvas (`timeline.width/height`). `t.x`/`t.y`,
///     the x/y keyframe values and the crop rect are all authored against it —
///     the preview positions a layer with `translate(posX * stageScale)`, i.e.
///     canvas px times the on-screen zoom.
///   * `out` is the EXPORT resolution (`ExportPreset::output_dims`). Every
///     number ffmpeg receives — `scale=`, `overlay=`, the black bases — is in
///     it.
/// The two are equal only for the "Original" preset. `fit` is measured against
/// `out`, so the MEDIA scales with the resolution on its own; the offsets do
/// not, and must be multiplied by out/canvas. Adding raw canvas-px x/y to an
/// output-px centring term shifted every off-centre clip: at 720p from a 1080p
/// canvas, an x of 307 landed 102 px off, at 2160p it landed 307 px off, while
/// a centred clip (x = y = 0) stayed exact at every resolution — which is why
/// nothing caught it.
fn placement(clip: &Clip, media: &MediaRef, canvas: (u32, u32), out: (u32, u32)) -> Placement {
    let (canvas_w, canvas_h) = canvas;
    let cw = out.0 as f64;
    let ch = out.1 as f64;
    // canvas px -> output px, per axis. A Custom resolution need not preserve
    // the timeline's aspect, so the two factors are not always equal.
    let sx = cw / canvas_w.max(1) as f64;
    let sy = ch / canvas_h.max(1) as f64;

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

    // A media with no recorded size falls back to the PROJECT canvas, never to
    // the output: the preview treats it as canvas-sized (`media.width ??
    // project.width`) and the crop rect is clamped against that same space.
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
    // x/y are CANVAS px; cw/ch (and therefore dw/dh) are OUTPUT px. The offsets
    // have to be converted before they can be added to an output-space centring
    // term — see the header of this function.
    let ox = ((cw - dw as f64) / 2.0 + x * sx).round() as i64;
    let oy = ((ch - dh as f64) / 2.0 + y * sy).round() as i64;

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
        src_w: src_w.round().clamp(1.0, 16384.0) as i64,
        src_h: src_h.round().clamp(1.0, 16384.0) as i64,
        fit_w: crop_w * fit,
        fit_h: crop_h * fit,
        x: x * sx,
        y: y * sy,
        sx,
        sy,
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
        // SOURCE seconds, not timeline seconds. `emit_clip_chain` puts a
        // `setpts=(PTS-STARTPTS)/speed` on every clip, so a stream cut to
        // `clip.duration()` here — which is ALREADY the timeline length,
        // (src_out-src_in)/speed — comes out `duration/speed` long: a 2 s image
        // at speed 2 exported 1 s of frames and every later segment slid 1 s
        // ahead of its (correctly delayed) audio. The video branch below feeds
        // the same source span through -ss/-to, and the generator path
        // synthesizes `clip_dur * speed`; `src_out - src_in` is that quantity,
        // written as the source window so a zero speed cannot make it NaN.
        flags.push("-t".into());
        flags.push(format!("{:.6}", clip.src_out - clip.src_in).into());
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
///
/// `speed` is a bare `f64` in `project::schema` with no deserialize-time
/// validation, and `.trt` files are shareable and hand-editable — the store's
/// own test loads a project carrying `"speed": 0.0`. The halve/double loop
/// below only terminates for a FINITE POSITIVE speed: `0.0 / 0.5` stays `0.0`,
/// a negative diverges to -inf, and `inf / 2.0` stays inf. Each pass pushes
/// another factor, so the Vec grows without bound (measured: 20M entries,
/// 256 MiB and still climbing) until the allocator fails, and with
/// `panic = "abort"` that kills the app mid-export along with unsaved work.
///
/// Such a speed has no honest tempo — the video chain's
/// `setpts=(PTS-STARTPTS)/speed` is just as meaningless for it, and a NaN has
/// no nearest legal value — so the audio is left at its natural tempo, exactly
/// as for speed 1.0. Clamping into the editor's [MIN_SPEED, MAX_SPEED] =
/// [0.25, 4.0] (src/core/project.ts) was the alternative and is rejected here:
/// it would also have to reel in finite out-of-range speeds like 8.0, which
/// terminate today and stay in step with the video chain, and slowing only the
/// audio would invent an A/V desync where there is none.
fn atempo_factors(speed: f64) -> Vec<f64> {
    let mut factors = Vec::new();
    if !speed.is_finite() || speed <= 0.0 {
        return factors;
    }
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

    // The EXPORT resolution, which equals the project canvas only for the
    // "Original" preset. Both spaces travel from here into `placement`, which
    // is where mixing them up used to mis-place off-centre clips.
    let (out_w, out_h) = preset.output_dims(spec.timeline.width, spec.timeline.height);
    let canvas = (spec.timeline.width, spec.timeline.height);
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
        let mut vclips: Vec<&Clip> = bt.clips.iter().collect();
        vclips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
        let mut cursor = 0.0_f64;
        for clip in vclips {
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
            let mut clips: Vec<&Clip> = track.clips.iter().collect();
            clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
            let mut layer: Vec<OverlayClip> = Vec::new();
            for clip in clips {
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
        let mut clips: Vec<&Clip> = track.clips.iter().collect();
        clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
        for clip in clips {
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
        w: out_w,
        h: out_h,
        canvas,
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
    for entry in inputs {
        args.extend(entry.flags);
        match entry.source {
            InputSource::File(p) => args.push(p),
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
    /// OUTPUT dims: the exported frame size and the size of every black base.
    w: u32,
    h: u32,
    /// PROJECT-CANVAS dims: the px space clip offsets and keyframe values are
    /// authored in. Equal to `w`/`h` only when exporting at "Original".
    canvas: (u32, u32),
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
    ///
    /// `w`/`h` are the generated media's OWN recorded dims (`Placement::src_w/h`),
    /// never the export canvas: crop, scale and the opacity alpha-mask are all
    /// derived from `media.width/height`, so synthesizing at canvas size makes
    /// the frame disagree with every downstream filter (an `alphamerge` "Input
    /// frame sizes do not match" abort, and wrong geometry even without it).
    fn generator_source(&mut self, gen: &Generator, w: i64, h: i64, dur: f64) -> Result<String> {
        let fps = self.fps;
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
                // 1.25 mirrors LINE_HEIGHT in src/editor/media/generators.ts.
                let line_spacing = (1.25 * size_px).round() as i64
                    - (line_height_em(font_family) * size_px).round() as i64;
                let idx = self.text_payloads.len();
                let placeholder = text_placeholder(idx);
                self.text_payloads.push((placeholder.clone(), text.clone()));
                // The textfile placeholder is embedded escaped-quoted; the
                // caller substitutes the escaped real path for the placeholder
                // BEFORE deciding inline-vs-script filter mode.
                let text_ref = escape_filter_path(&placeholder)?;
                // boxw/boxh pin the layout box to the measured text box and
                // text_align=L+M reproduces the DOM's `text-align: start` plus
                // the half-leading that vertically centres the lines in it.
                // No `box=1` — nothing is drawn, the box only positions.
                Ok(format!(
                    "color=black@0.0:s={w}x{h}:r={fps}:d={dur:.6},format=rgba,\
drawtext=fontfile={font_esc}:textfile={text_ref}:fontsize={px}:fontcolor=0x{rgb}{aa}:\
x=0:y=0:boxw={w}:boxh={h}:text_align=L+M:line_spacing={line_spacing}:expansion=none"
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
                        let p = placement(clip, m, self.canvas, (w, h));
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
        let p = placement(clip, media, self.canvas, (self.w, self.h));
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
    /// flips → transpose → scale (animated or static) → setsar=1 → fps →
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
                    .generator_source(gen, p.src_w, p.src_h, clip_dur * clip.speed)
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
        // T (clip-local, before the setpts shift). A track with >=1 keyframe is
        // authoritative (mirrors preview's evalKfs): a single keyframe is a
        // constant equal to its value; multi-kf uses the ramp. The static
        // transform opacity is only used when no opacity track exists.
        let opacity_kfs = clip.keyframes.as_ref().and_then(|k| k.opacity.as_ref());
        if let Some(kfs) = opacity_kfs.filter(|k| !k.is_empty()) {
            let expr = if kfs.len() == 1 {
                format!("{:.4}", kfs[0].v)
            } else {
                let bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
                ramp_expr(&bps, "T")
            };
            let (cw, ch) = (p.post_crop_w.max(1), p.post_crop_h.max(1));
            let a = self.next_n();
            // The mask MULTIPLIES the source alpha, it must not replace it: a
            // bare alphamerge overwrites the alpha channel, so a text generator
            // (or an alpha PNG) with an opacity keyframe exported as an opaque
            // black rectangle with the text on it. Extract the incoming alpha,
            // multiply it by the ramp mask, merge the product back. The three
            // extra passes are paid only by clips that have an opacity keyframe.
            chain.push_str(&format!(
                ",format=rgba[chain{a}];[chain{a}]split[cm{a}][ca{a}];[ca{a}]alphaextract[cx{a}];\
color=black:s=16x16:r={fps}:d={clip_dur:.6},format=gray,geq=lum='255*({expr})',\
scale={cw}:{ch}[al{a}];[cx{a}][al{a}]blend=all_mode=multiply[am{a}];\
[cm{a}][am{a}]alphamerge"
            ));
        }

        // Flips FIRST, then rotate. ffmpeg applies chain filters left-to-right to
        // frames, so this composites as R∘F (source->screen = R*F), matching the
        // preview's `rotate(r) scale(fh,fv)` (CSS right-to-left = R*F). Flip-after-
        // rotate would give F*R, a full mirror for rotate∈{90,270} with one flip.
        if p.flip_h {
            chain.push_str(",hflip");
        }
        if p.flip_v {
            chain.push_str(",vflip");
        }
        match p.rotate {
            90 => chain.push_str(",transpose=1"),
            180 => chain.push_str(",transpose=1,transpose=1"),
            270 => chain.push_str(",transpose=2"),
            _ => {}
        }

        // scale — a track with >=1 keyframe is authoritative over the static
        // transform scale (mirrors preview's evalKfs). A single keyframe is a
        // constant scale factor: emit fixed display dims (fit * v). Multi-kf
        // uses the per-frame ramp expression (eval=frame).
        let scale_kfs = clip.keyframes.as_ref().and_then(|k| k.scale.as_ref());
        match scale_kfs.filter(|k| !k.is_empty()) {
            Some(kfs) if kfs.len() == 1 => {
                let sw = round_even(p.fit_w * kfs[0].v);
                let sh = round_even(p.fit_h * kfs[0].v);
                chain.push_str(&format!(",scale={sw}:{sh}"));
            }
            Some(kfs) => {
                let bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
                // scale runs before the setpts shift → time var is clip-local "t".
                let s = ramp_expr(&bps, "t");
                chain.push_str(&format!(
                    ",scale=w='trunc({:.4}*({s})/2)*2':h='trunc({:.4}*({s})/2)*2':eval=frame",
                    p.fit_w, p.fit_h
                ));
            }
            None => {
                chain.push_str(&format!(",scale={}:{}", p.dw, p.dh));
            }
        }
        chain.push_str(&format!(",setsar=1,fps={fps}"));

        // static opacity — only when NO opacity keyframe track exists. Any track
        // (len>=1) is handled by the alphamerge branch above, so the static
        // transform opacity must not also be applied.
        if opacity_kfs.filter(|k| !k.is_empty()).is_none() && p.opacity < 0.999 {
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
        // A track with >=1 keyframe is authoritative (mirrors preview's evalKfs):
        // its presence alone forces the centered-expression path. A single-kf
        // scale re-sizes overlay_w/h off the static transform, and a single-kf
        // x/y overrides the static offset baked into p.ox/p.oy — both need the
        // runtime `(main-overlay)/2 + off` form to stay centered/positioned.
        let scale_kf = clip
            .keyframes
            .as_ref()
            .and_then(|k| k.scale.as_ref())
            .filter(|k| !k.is_empty());
        let x_kf = x_kfs.filter(|k| !k.is_empty());
        let y_kf = y_kfs.filter(|k| !k.is_empty());

        // Centered expressions are needed whenever position OR scale has any
        // keyframe (scale changes overlay_w/h, so a fixed ox no longer centers).
        if x_kf.is_none() && y_kf.is_none() && scale_kf.is_none() {
            return (format!("{}", p.ox), format!("{}", p.oy));
        }

        // Per axis: single kf → constant value; multi-kf → ramp; absent → static.
        //
        // `s` is the canvas->output factor. Keyframed x/y values are authored in
        // PROJECT-CANVAS px exactly like the static transform offsets, while
        // `(main_w-overlay_w)/2` below is OUTPUT px — the same units mix-up that
        // `placement` documents, and it has to be undone on this path too.
        // Scaling the breakpoint VALUES rather than wrapping the emitted
        // expression in a multiply keeps the per-frame expression as cheap as
        // before. `p.x`/`p.y` arrive already converted.
        let offset = |kf: Option<&&Vec<Keyframe>>, stat: f64, s: f64| -> String {
            match kf {
                Some(kfs) if kfs.len() == 1 => format!("{:.4}", kfs[0].v * s),
                Some(kfs) => {
                    let mut bps = clamped_breakpoints(kfs, clip.src_in, clip.src_out, clip.speed);
                    for b in &mut bps {
                        b.v *= s;
                    }
                    ramp_expr(&bps, tbase)
                }
                None => format!("{stat:.4}"),
            }
        };
        let x_off = offset(x_kf.as_ref(), p.x, p.sx);
        let y_off = offset(y_kf.as_ref(), p.y, p.sy);
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

    /// Generated media with EXPLICIT intrinsic dims. They are a parameter, not a
    /// constant, because issue #1 was a canvas-vs-media size confusion: a fixture
    /// whose dims happen to equal the canvas turns every generator test into a
    /// no-op. Callers must pass dims that differ from the timeline on both axes.
    fn gen_media(id: &str, generator: Generator, w: u32, h: u32) -> MediaRef {
        MediaRef {
            id: id.into(),
            path: "gen".into(),
            size: 0,
            mtime_ms: 0,
            kind: "image".into(),
            duration: 0.0,
            fps: None,
            width: Some(w),
            height: Some(h),
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
        // Flip must be applied BEFORE transpose so source->screen = R*F, matching
        // the preview. Order-reversal (flip after rotate) mirrors the export.
        let hflip_at = fc.find("hflip").expect("hflip present");
        let transpose_at = fc.find("transpose=1").expect("transpose present");
        assert!(hflip_at < transpose_at, "hflip must precede transpose: {fc}");
        assert!(
            fc.contains("crop=50:50:10:10,hflip,transpose=1"),
            "chain must be crop,hflip,transpose: {fc}"
        );
        assert!(fc.contains("scale=100:100"), "{fc}");
        assert!(fc.contains("colorchannelmixer=aa=0.5000"), "{fc}");
        assert!(fc.contains("overlay=0:0:shortest=1"), "{fc}");
    }

    /// `preset` with a named resolution instead of "original".
    fn preset_at(format: &str, vcodec: &str, resolution: &str) -> ExportPreset {
        let mut p = preset(format, vcodec);
        p.resolution = ResolutionPreset::Named(resolution.into());
        p
    }

    /// The `ox:oy` and `dw:dh` ffmpeg is handed for a single-clip export.
    fn overlay_and_scale(b: &BuiltExport) -> (String, String) {
        let fc = &b.filter_complex;
        let grab = |head: &str, tail: &str| {
            let i = fc.find(head).unwrap_or_else(|| panic!("no {head} in {fc}")) + head.len();
            let j = fc[i..].find(tail).unwrap_or_else(|| panic!("no {tail} after {head}")) + i;
            fc[i..j].to_string()
        };
        (grab("overlay=", ":shortest=1"), grab(",scale=", ","))
    }

    #[test]
    fn an_off_centre_clip_keeps_its_place_at_every_export_resolution() {
        // The units bug: t.x/t.y are PROJECT-CANVAS px, `overlay=` is OUTPUT px.
        // The media already scaled correctly (fit is measured against the output
        // box) so only off-centre clips moved — 102 px at 720p, 307 px at 2160p
        // for this x — and a centred clip was right everywhere, which is how it
        // shipped. Expected values come from the shared parity table's
        // export-720p / export-2160p rows.
        let build_at = |resolution: &str| {
            let m = media("m1", r"C:\v.mp4", 854, 482, false);
            let mut c = clip("c1", "m1", 0.0, 0.0, 2.0);
            c.transform = Some(ClipTransform {
                crop: None, rotate: 0, flip_h: false, flip_v: false,
                scale: 1.13, x: 307.0, y: -151.0, opacity: 1.0,
            });
            let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
            build(
                &spec(vec![m], tl, preset_at("mp4", "h264", resolution), r"C:\o.mp4"),
                &enc(),
            )
            .unwrap()
        };

        // 1920x1080 canvas at Original: the preview's own numbers.
        let (xy, sz) = overlay_and_scale(&build_at("original"));
        assert_eq!((xy.as_str(), sz.as_str()), ("186:-221", "2162:1220"));

        // 1280x720: everything shrinks by 2/3, offsets included. Adding the raw
        // 307/-151 would have emitted 226:-198.
        let (xy, sz) = overlay_and_scale(&build_at("720p"));
        assert_eq!((xy.as_str(), sz.as_str()), ("124:-148", "1442:814"));

        // 3840x2160: everything doubles. The raw offsets would have given 65:-291.
        let (xy, sz) = overlay_and_scale(&build_at("2160p"));
        assert_eq!((xy.as_str(), sz.as_str()), ("372:-442", "4324:2440"));
    }

    #[test]
    fn a_centred_clip_is_the_one_case_the_resolution_cannot_break() {
        // The control that explains the silence: with x = y = 0 the offsets
        // contribute nothing, so the centring term alone is right at every
        // resolution. A test written with a centred fixture proves nothing
        // about the conversion.
        let build_at = |resolution: &str| {
            let m = media("m1", r"C:\v.mp4", 854, 482, false);
            let c = clip("c1", "m1", 0.0, 0.0, 2.0);
            let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
            build(
                &spec(vec![m], tl, preset_at("mp4", "h264", resolution), r"C:\o.mp4"),
                &enc(),
            )
            .unwrap()
        };
        let num = |s: &str| s.parse::<i64>().unwrap_or_else(|_| panic!("not a number: {s}"));
        for (r, out_w, out_h) in [("original", 1920, 1080), ("720p", 1280, 720), ("2160p", 3840, 2160)] {
            let (xy, sz) = overlay_and_scale(&build_at(r));
            let (ox, oy) = xy.split_once(':').expect("ox:oy");
            let (dw, dh) = sz.split_once(':').expect("dw:dh");
            // The display box sits dead centre on both axes — within the one
            // pixel the even-rounding of the extent can cost.
            assert!((2 * num(ox) + num(dw) - out_w).abs() <= 1, "{r}: {xy} / {sz}");
            assert!((2 * num(oy) + num(dh) - out_h).abs() <= 1, "{r}: {xy} / {sz}");
        }
    }

    #[test]
    fn a_keyframed_offset_is_converted_to_output_px_as_well() {
        // Any x/y/scale keyframe switches the overlay to the centred-expression
        // form, which builds its own offset term out of the RAW keyframe values.
        // Those are authored in canvas px exactly like the static transform, so
        // they need the identical conversion — fixing only `placement` would
        // leave every animated clip mis-placed.
        let build_at = |resolution: &str| {
            let m = media("m1", r"C:\v.mp4", 854, 482, false);
            let mut c = clip("c1", "m1", 0.0, 0.0, 4.0);
            c.keyframes = Some(ClipKeyframes {
                x: Some(vec![
                    Keyframe { t: 0.0, v: -200.0 },
                    Keyframe { t: 4.0, v: 200.0 },
                ]),
                y: Some(vec![Keyframe { t: 0.0, v: 50.0 }]),
                scale: None,
                opacity: None,
            });
            let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
            build(
                &spec(vec![m], tl, preset_at("mp4", "h264", resolution), r"C:\o.mp4"),
                &enc(),
            )
            .unwrap()
            .filter_complex
        };

        // Original: the authored values, unconverted.
        let fc = build_at("original");
        assert!(
            fc.contains("overlay='(main_w-overlay_w)/2+-200.0000+(400.0000)*clip((t-0.0000)/4.0000,0,1)':'(main_h-overlay_h)/2+50.0000'"),
            "{fc}"
        );
        // 2160p doubles the canvas, so every breakpoint doubles with it. The
        // ramp is scaled through its VALUES, not by wrapping the expression in
        // a multiply, so the per-frame cost is unchanged.
        let fc = build_at("2160p");
        assert!(
            fc.contains("overlay='(main_w-overlay_w)/2+-400.0000+(800.0000)*clip((t-0.0000)/4.0000,0,1)':'(main_h-overlay_h)/2+100.0000'"),
            "{fc}"
        );
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
    fn atempo_terminates_on_a_speed_that_cannot_be_factored() {
        // The halve/double loop only converges for a finite POSITIVE speed:
        // 0.0/0.5 is still 0.0, a negative diverges to -inf, inf/2.0 is still
        // inf. Each pass pushed another factor, so this used to grow a Vec
        // until the allocator failed and `panic = "abort"` took the app down
        // mid-export. `speed` is unvalidated in the schema and `.trt` files are
        // hand-editable, so these are reachable, not hypothetical.
        for bad in [0.0, -0.0, -1.0, -0.5, f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let f = atempo_factors(bad);
            assert!(f.is_empty(), "speed {bad} produced {} stage(s)", f.len());
        }

        // Everything finite and positive keeps its old decomposition, including
        // the extremes: the guard must not have narrowed the working range.
        assert_eq!(atempo_factors(0.25).len(), 2);
        assert_eq!(atempo_factors(4.0).len(), 2);
        assert!(atempo_factors(4.0).iter().all(|&x| (x - 2.0).abs() < 1e-9));
        // Out-of-editor-range speeds are honoured rather than clamped, so the
        // audio keeps step with the video chain's `setpts=(PTS-STARTPTS)/speed`.
        let f = atempo_factors(8.0);
        assert_eq!(f.len(), 3);
        assert!(f.iter().all(|&x| (x - 2.0).abs() < 1e-9));
        // f64::MAX = (2 - 2^-52) * 2^1023, so 1023 halvings land just under 2
        // and the loop ends. Absurd, but bounded — it terminated before the
        // guard and still does.
        assert_eq!(atempo_factors(f64::MAX).len(), 1024);
        assert_eq!(atempo_factors(f64::MIN_POSITIVE).len(), 1022);

        // The product must still reconstruct the requested speed.
        for s in [0.25, 0.4, 1.5, 3.0, 4.0, 8.0] {
            let p: f64 = atempo_factors(s).iter().product();
            assert!((p - s).abs() < 1e-9, "speed {s} decomposed to {p}");
        }
    }

    #[test]
    fn a_speed_zero_project_still_builds_instead_of_eating_the_heap() {
        // `project::store`'s own test loads a `.trt` carrying `"speed": 0.0`, so
        // this reaches the builder. It cannot produce a sane export — the clip
        // has no finite duration — but it must come back rather than allocate
        // until the process dies with the user's unsaved work.
        let m = media("m1", r"C:\v.mp4", 854, 482, true);
        let mut c = clip("c1", "m1", 0.0, 0.0, 2.0);
        c.speed = 0.0;
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(!b.filter_complex.contains("atempo"), "{}", b.filter_complex);
    }

    /// A still image: the only input kind that gets `-loop 1 -t <len>` instead
    /// of an `-ss`/`-to` source window. Dims differ from every canvas used here.
    fn image_media(id: &str, path: &str) -> MediaRef {
        let mut m = media(id, path, 854, 482, false);
        m.kind = "image".into();
        m
    }

    #[test]
    fn an_image_at_speed_still_covers_its_whole_timeline_slot() {
        // `-t` feeds the input SOURCE seconds; `emit_clip_chain` then divides
        // PTS by speed. Handing it `clip.duration()` — already the timeline
        // length — divided the length a second time: a 2 s slot at speed 2
        // exported 1 s of frames, and because `adelay` on the audio stayed
        // right, everything after it drifted by the difference.
        let m = image_media("m1", r"C:\still.png");
        let mut c = clip("c1", "m1", 0.0, 0.0, 4.0);
        c.speed = 2.0; // 4 source seconds at 2x → a 2 s slot on the timeline
        assert!((c.duration() - 2.0).abs() < 1e-9);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();

        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-loop" && w[1] == "1"), "{a:?}");
        // 4 source seconds in, halved by the setpts → a 2 s segment out.
        assert!(a.windows(2).any(|w| w[0] == "-t" && w[1] == "4.000000"), "{a:?}");
        assert!(b.filter_complex.contains("setpts=(PTS-STARTPTS)/2.000000"), "{}", b.filter_complex);
        // …and the black base it is overlaid onto is the TIMELINE length, so a
        // short input would leave the tail of the segment empty.
        assert!(b.filter_complex.contains("d=2.000000"), "{}", b.filter_complex);
        assert!((b.duration_sec - 2.0).abs() < 1e-9);
    }

    #[test]
    fn an_image_a_generator_and_a_video_agree_on_length_at_the_same_speed() {
        // The generator path always got this right (it synthesizes
        // `clip_dur * speed` and then divides), and the video path gets it from
        // its -ss/-to window. The image path was the odd one out; pin all three
        // against each other so it cannot drift off again alone.
        let build_one = |m: MediaRef, speed: f64| {
            let mut c = clip("c1", "m1", 0.0, 0.0, 4.0);
            c.speed = speed;
            let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
            build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap()
        };

        for speed in [0.5, 1.0, 2.0] {
            let slot = 4.0 / speed;
            let img = build_one(image_media("m1", r"C:\still.png"), speed);
            let vid = build_one(media("m1", r"C:\v.mp4", 854, 482, false), speed);
            let gen = build_one(
                gen_media("m1", Generator::Solid { color: "#00ff00".into() }, 854, 482),
                speed,
            );
            for (what, b) in [("image", &img), ("video", &vid), ("generator", &gen)] {
                assert!(
                    (b.duration_sec - slot).abs() < 1e-9,
                    "{what} at speed {speed}: {} != {slot}", b.duration_sec
                );
                assert!(
                    b.filter_complex.contains(&format!("d={slot:.6}")),
                    "{what} at speed {speed} must cover a {slot:.6}s slot: {}",
                    b.filter_complex
                );
            }
            // The image input and the generator source are handed the SAME
            // number of source seconds — the quantity the setpts then divides.
            let t = argstr(&img);
            let i = t.iter().position(|s| s == "-t").expect("-t on the image input");
            assert_eq!(t[i + 1], "4.000000", "image source span at speed {speed}");
            assert!(
                gen.filter_complex.contains("d=4.000000") || (speed - 1.0).abs() < 1e-9,
                "generator source span at speed {speed}: {}", gen.filter_complex
            );
        }
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
    fn single_keyframe_opacity_exports_constant_from_keyframe() {
        // One opacity keyframe (v=0.30) with a DIFFERENT static transform opacity
        // (1.0). Export must honor the keyframe (matches preview's evalKfs), not
        // the stale static value. The alphamerge geq carries the constant 0.30;
        // no static colorchannelmixer is emitted.
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut top = clip("t1", "m1", 0.0, 0.0, 4.0);
        top.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 1.0, x: 0.0, y: 0.0, opacity: 1.0,
        });
        top.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 0.30 }]),
        });
        let bottom = clip("b1", "m1", 0.0, 0.0, 4.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack_id("vtop", vec![top]), vtrack_id("vbot", vec![bottom])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("alphamerge"), "{fc}");
        // constant 0.30 in the geq lum, no ramp clip() term.
        assert!(fc.contains("geq=lum='255*(0.3000)'"), "{fc}");
        // must NOT fall back to the static transform opacity via colorchannelmixer.
        assert!(!fc.contains("colorchannelmixer"), "{fc}");
    }

    #[test]
    fn single_keyframe_scale_exports_constant_display_dims() {
        // One scale keyframe (v=2.0) with static transform scale left at 1.0.
        // Export must size the clip off the keyframe (fit*2), NOT the static
        // scale. 1920x1080 fit into 1920x1080 → fit=1.0, fit_w/h=1920/1080;
        // constant scale 2.0 → 3840x2160. No eval=frame (plain constant dims).
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut top = clip("t1", "m1", 0.0, 0.0, 4.0);
        top.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 1.0, x: 0.0, y: 0.0, opacity: 1.0,
        });
        top.keyframes = Some(ClipKeyframes {
            x: None, y: None,
            scale: Some(vec![Keyframe { t: 1.0, v: 2.0 }]),
            opacity: None,
        });
        let bottom = clip("b1", "m1", 0.0, 0.0, 4.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack_id("vtop", vec![top]), vtrack_id("vbot", vec![bottom])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("scale=3840:2160"), "{fc}");
        // constant, not a per-frame ramp.
        assert!(!fc.contains("eval=frame"), "{fc}");
        // a single-kf scale still forces the centered overlay expr (the static ox
        // was computed off transform.scale=1.0 and would mis-center at 2x).
        assert!(fc.contains("(main_w-overlay_w)/2"), "{fc}");
    }

    #[test]
    fn single_keyframe_position_exports_constant_offset() {
        // One x keyframe (v=120) and one y keyframe (v=-40), static transform
        // x/y left at 0. Export must center-offset by the keyframe constants.
        let m = media("m1", r"C:\v.mp4", 1920, 1080, false);
        let mut top = clip("t1", "m1", 0.0, 0.0, 4.0);
        top.transform = Some(ClipTransform {
            crop: None, rotate: 0, flip_h: false, flip_v: false,
            scale: 1.0, x: 0.0, y: 0.0, opacity: 1.0,
        });
        top.keyframes = Some(ClipKeyframes {
            x: Some(vec![Keyframe { t: 2.0, v: 120.0 }]),
            y: Some(vec![Keyframe { t: 2.0, v: -40.0 }]),
            scale: None, opacity: None,
        });
        let bottom = clip("b1", "m1", 0.0, 0.0, 4.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 },
            vec![vtrack_id("vtop", vec![top]), vtrack_id("vbot", vec![bottom])]);
        let b = build(&spec(vec![m], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // constant offsets, no clip() ramp term.
        assert!(fc.contains("'(main_w-overlay_w)/2+120.0000'"), "{fc}");
        assert!(fc.contains("'(main_h-overlay_h)/2+-40.0000'"), "{fc}");
        assert!(!fc.contains("clip("), "{fc}");
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
        let gm = gen_media("g1", Generator::Solid { color: "#ff0000".into() }, 400, 200);
        let c = clip("c1", "g1", 0.0, 0.0, 3.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        // The source is synthesized at the MEDIA's dims, not the canvas: the old
        // `s=1920x1080` assertion pinned the bug behind issue #1.
        assert!(fc.contains("color=c=0xff0000:s=400x200"), "{fc}");
        // generated media consume no -i input slot.
        let a = argstr(&b);
        assert_eq!(a.iter().filter(|s| s.as_str() == "-i").count(), 0);
    }

    #[test]
    fn parse_color_accepts_the_three_valid_forms() {
        assert_eq!(parse_color("#f0a"), ("ff00aa".to_string(), None));
        assert_eq!(parse_color("#FF00AA"), ("ff00aa".to_string(), None));
        assert_eq!(
            parse_color("#ff00aa80"),
            ("ff00aa".to_string(), Some("80".to_string()))
        );
        // a bare value with no leading '#' is still accepted
        assert_eq!(parse_color("ff00aa"), ("ff00aa".to_string(), None));
    }

    #[test]
    fn parse_color_rejects_non_hex_without_panicking() {
        // A `.trt` is shareable, so a hand-edited color is untrusted input.
        // `hex.len()` is a BYTE count while `hex[..6]` slices by byte index, so
        // an 8-byte-but-not-8-char value used to slice mid-character and panic
        // — fatal under `panic = "abort"`. It must fall back to white instead.
        let multibyte = "#aaaaa\u{c0}a"; // 5 ASCII + one 2-byte char + 1 ASCII
        assert_eq!(multibyte.trim_start_matches('#').len(), 8);
        assert_eq!(parse_color(multibyte), ("ffffff".to_string(), None));

        // The alpha suffix reaches the drawtext `fontcolor=` option, so it has
        // to be hex-validated too — not just the rgb half.
        assert_eq!(parse_color("#ffffff:x"), ("ffffff".to_string(), None));
        assert_eq!(parse_color("#ffffff'q"), ("ffffff".to_string(), None));
        assert_eq!(parse_color("#ffffffzz"), ("ffffff".to_string(), None));

        // plain garbage and empties
        assert_eq!(parse_color("#zzz"), ("ffffff".to_string(), None));
        assert_eq!(parse_color(""), ("ffffff".to_string(), None));
        assert_eq!(parse_color("#12345"), ("ffffff".to_string(), None));
    }

    #[test]
    fn crafted_color_cannot_inject_into_the_drawtext_filtergraph() {
        // End-to-end: a crafted color must neither kill the process nor change
        // the graph. The strongest statement is that a hostile color produces a
        // filtergraph byte-identical to the plain-white fallback — so no part of
        // it survived into the graph. (Asserting on the absence of a substring
        // is too weak here: drawtext's own `x=` option legitimately follows
        // `fontcolor=`, so `0xffffff:x` appears in perfectly normal output.)
        let graph_for = |color: &str| {
            let gm = gen_media(
                "g1",
                Generator::Text {
                    text: "hi".into(),
                    font_family: "Georgia".into(),
                    size_px: 48.0,
                    color: color.into(),
                    bold: false,
                    italic: false,
                },
                400,
                200,
            );
            let c = clip("c1", "g1", 0.0, 0.0, 2.0);
            let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
            build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc())
                .unwrap()
                .filter_complex
        };

        let white = graph_for("#ffffff");
        assert!(white.contains("fontcolor=0xffffff:"), "{white}");
        // option-separator injection, quote injection, non-hex alpha, and the
        // multi-byte value that used to abort the process
        for hostile in ["#ffffff:x", "#ffffff'q", "#ffffffzz", "#aaaaa\u{c0}a", "#zzz"] {
            assert_eq!(graph_for(hostile), white, "hostile color leaked: {hostile}");
        }
        // a VALID alpha must still come through, or the guard is too aggressive
        assert!(graph_for("#ffffff80").contains("fontcolor=0xffffff80:"));
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
        }, 620, 120);
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
        let gm = gen_media("g1", Generator::Solid { color: "#00ff00".into() }, 400, 200);
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
        }, 400, 200);
        let c = clip("c1", "g1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let r = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc());
        assert!(r.is_err());
    }

    /* -------- generator size / text metrics / alpha (issue #1) -------- */

    #[test]
    fn generator_with_opacity_keyframe_matches_alphamerge_sizes() {
        // GitHub issue #1, with the reporter's exact numbers. A generator whose
        // intrinsic size differs from the canvas plus ONE opacity keyframe used
        // to abort ffmpeg with "[Parsed_alphamerge_N] Input frame sizes do not
        // match (398x934 vs 270x114)": the source was synthesized at the CANVAS
        // size while the alpha mask was sized from the MEDIA. Both halves of that
        // pair must now read 270x114 — the frame and its mask agree.
        let gm = gen_media("g1", Generator::Solid { color: "#ff0000".into() }, 270, 114);
        let mut c = clip("c1", "g1", 0.0, 0.0, 3.0);
        c.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 1.0 }]),
        });
        let tl = timeline(398, 934, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc());
        assert!(b.is_ok(), "build must succeed: {:?}", b.err());
        let fc = &b.unwrap().filter_complex;
        // the lavfi source frame …
        assert!(fc.contains("color=c=0xff0000:s=270x114:"), "{fc}");
        // … and the alpha mask scaled to meet it.
        assert!(fc.contains("scale=270:114"), "{fc}");
        // The generator must NOT be synthesized at the canvas size. (Asserting on
        // a bare "s=398x934" would be wrong: the per-segment black base is
        // legitimately canvas-sized. The bug lives in the GENERATOR source, so
        // that is what this pins.)
        assert!(!fc.contains("color=c=0xff0000:s=398x934"), "{fc}");
    }

    #[test]
    fn generator_source_uses_media_dims_not_canvas() {
        // 400x200 media on a 1920x1080 canvas: synthesize at 400x200, then let the
        // normal fit-scale do the enlarging. fit = min(1920/400, 1080/200) = 4.8
        // → 400*4.8 x 200*4.8 = 1920x960 (letterboxed, aspect preserved).
        let gm = gen_media("g1", Generator::Solid { color: "#0000ff".into() }, 400, 200);
        let c = clip("c1", "g1", 0.0, 0.0, 3.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("color=c=0x0000ff:s=400x200"), "{fc}");
        assert!(fc.contains("scale=1920:960"), "{fc}");
    }

    #[test]
    fn text_line_spacing_matches_preview_line_height() {
        // The preview's line pitch is a fixed `line-height: 1.25`; drawtext's is
        // `max_glyph_h + line_spacing`, and max_glyph_h is font-dependent. So
        // line_spacing must be the DIFFERENCE, per family — never a flat 0.25em.
        let size = 96.0_f64;
        for family in [
            "Segoe UI",
            "Arial",
            "Georgia",
            "Times New Roman",
            "Courier New",
            "Impact",
        ] {
            let gm = gen_media(
                "g1",
                Generator::Text {
                    text: "two\nlines".into(),
                    font_family: family.into(),
                    size_px: size,
                    color: "#ffffff".into(),
                    bold: false,
                    italic: false,
                },
                620,
                240,
            );
            let c = clip("c1", "g1", 0.0, 0.0, 2.0);
            let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
            let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
            let expect = (1.25 * size).round() as i64
                - (line_height_em(family) * size).round() as i64;
            assert!(
                b.filter_complex.contains(&format!("line_spacing={expect}:")),
                "{family}: expected line_spacing={expect} in {}",
                b.filter_complex
            );
        }

        // Segoe UI — the DEFAULT family — has a line height TALLER than 1.25em,
        // so its correct line_spacing is NEGATIVE. ffmpeg honours that; clamping
        // it to zero would over-space every default-font export.
        let segoe = (1.25 * size).round() as i64
            - (line_height_em("Segoe UI") * size).round() as i64;
        assert_eq!(segoe, -8, "Segoe UI line_spacing at 96px");
        assert!(segoe < 0, "Segoe UI must stay negative");
        // …while the other five stay positive, so the sign is genuinely per-font.
        for family in ["Arial", "Georgia", "Times New Roman", "Courier New", "Impact"] {
            let v = (1.25 * size).round() as i64
                - (line_height_em(family) * size).round() as i64;
            assert!(v > 0, "{family} line_spacing should be positive, got {v}");
        }
    }

    #[test]
    fn text_is_centred_in_its_intrinsic_box() {
        // drawtext now lays out inside a box the size of the MEASURED text box.
        // Without it, P1's tighter canvas clips the glyphs. L = left (the DOM's
        // `text-align: start`), M = middle (the DOM's half-leading).
        let gm = gen_media(
            "g1",
            Generator::Text {
                text: "Hi".into(),
                font_family: "Georgia".into(),
                size_px: 48.0,
                color: "#ffffff".into(),
                bold: false,
                italic: false,
            },
            318,
            126,
        );
        let c = clip("c1", "g1", 0.0, 0.0, 2.0);
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("boxw=318:boxh=126"), "{fc}");
        assert!(fc.contains("text_align=L+M"), "{fc}");
        // no drawn box — the box only positions.
        assert!(!fc.contains("box=1"), "{fc}");
    }

    #[test]
    fn opacity_keyframes_preserve_source_alpha() {
        // alphamerge REPLACES the alpha channel, so a text generator (or an alpha
        // PNG) with an opacity keyframe exported as a translucent black rectangle
        // with the text on it — an empty area read luma 128 instead of 255. The
        // ramp mask must MULTIPLY the source alpha instead.
        let gm = gen_media(
            "g1",
            Generator::Text {
                text: "fade".into(),
                font_family: "Georgia".into(),
                size_px: 48.0,
                color: "#ffffff".into(),
                bold: false,
                italic: false,
            },
            318,
            126,
        );
        let mut c = clip("c1", "g1", 0.0, 0.0, 3.0);
        c.keyframes = Some(ClipKeyframes {
            x: None, y: None, scale: None,
            opacity: Some(vec![Keyframe { t: 0.0, v: 0.0 }, Keyframe { t: 3.0, v: 1.0 }]),
        });
        let tl = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        let b = build(&spec(vec![gm], tl, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        let fc = &b.filter_complex;
        assert!(fc.contains("alphaextract"), "{fc}");
        assert!(fc.contains("blend=all_mode=multiply"), "{fc}");
        // the product, not the raw ramp, is what gets merged back in.
        assert!(fc.contains("alphamerge"), "{fc}");

        // A clip WITHOUT an opacity keyframe pays none of it (the perf veto).
        let gm2 = gen_media("g2", Generator::Solid { color: "#ff0000".into() }, 400, 200);
        let c2 = clip("c2", "g2", 0.0, 0.0, 3.0);
        let tl2 = timeline(1920, 1080, Rational { num: 30, den: 1 }, vec![vtrack(vec![c2])]);
        let b2 = build(&spec(vec![gm2], tl2, preset("mp4", "h264"), r"C:\o.mp4"), &enc()).unwrap();
        assert!(!b2.filter_complex.contains("alphaextract"), "{}", b2.filter_complex);
        assert!(!b2.filter_complex.contains("blend="), "{}", b2.filter_complex);
    }

    /* ------------------------------------------------------------------ */
    /* Preview <-> export placement parity (SHARED golden table)           */
    /* ------------------------------------------------------------------ */
    //
    // `placement()` above and `computeTransformInto` in
    // `src/editor/preview/transforms.ts` implement the same math twice. Both
    // files claim in a comment to mirror each other and, until this table,
    // nothing checked it — which is how GitHub issue #1 shipped: the preview and
    // the export disagreed about every text generator's size and the suite could
    // not see it.
    //
    // THE TABLE IS SHARED, one file asserted by two suites:
    //   * here, through `placement()`;
    //   * `src/editor/preview/export-parity.test.ts` (vitest), through the real
    //     `computeTransform`.
    // It lives on the TypeScript side because that is where the reference
    // implementation is, and `include_str!` is deliberate: moving or renaming
    // the JSON breaks THIS BUILD, not just the vitest run, so the two
    // implementations cannot drift apart quietly.
    //
    // The expected values were generated from `computeTransformInto` (the
    // preview is the arbiter — builder.rs's own header says this chain mirrors
    // it "so the export matches the preview") and are asserted here unchanged.
    // A failing row means one of the two implementations moved; it is never a
    // reason to edit the number.

    const PARITY_TABLE: &str =
        include_str!("../../../src/editor/preview/preview-export-parity.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ParityCrop { x: f64, y: f64, w: f64, h: f64 }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ParityIn {
        media_w: Option<u32>,
        media_h: Option<u32>,
        /// PROJECT canvas — the px space x/y and the crop rect are authored in.
        canvas_w: u32,
        canvas_h: u32,
        /// EXPORT resolution — the px space ffmpeg is spoken to in. Equal to
        /// the canvas only for the "Original" preset.
        export_w: u32,
        export_h: u32,
        rotate: u32,
        flip_h: bool,
        flip_v: bool,
        crop: Option<ParityCrop>,
        scale: f64,
        x: f64,
        y: f64,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ParityOut {
        /// even-rounded display size — ffmpeg `scale=dw:dh`
        dw: i64,
        dh: i64,
        /// integer overlay position — ffmpeg `overlay=ox:oy`
        ox: i64,
        oy: i64,
        /// the preview's exact, un-rounded extent and media shift, project px
        dw_exact: f64,
        dh_exact: f64,
        /// the same extent with the fit measured against the EXPORT box — what
        /// the export actually scales to. Equals dw_exact/dh_exact at Original.
        dw_exact_out: f64,
        dh_exact_out: f64,
        off_x_exact: f64,
        off_y_exact: f64,
        /// fit * userScale, project px per source px
        k: f64,
        src_w: i64,
        src_h: i64,
        post_crop_w: i64,
        post_crop_h: i64,
        /// ffmpeg `crop=cw:ch:cx:cy`, or null when nothing narrows
        crop_filter: Option<[i64; 4]>,
    }

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ParityCase {
        name: String,
        why: String,
        #[serde(rename = "in")]
        input: ParityIn,
        out: ParityOut,
    }

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ParityTable { cases: Vec<ParityCase> }

    /// Relative closeness. Only used where IEEE non-associativity makes bitwise
    /// equality unreachable — see the `fit_w` assertion below for the
    /// justification. Everything else is compared exactly.
    fn rel_close(a: f64, b: f64, rel: f64) -> bool {
        (a - b).abs() <= rel * a.abs().max(b.abs()).max(1.0)
    }

    #[test]
    fn placement_matches_the_shared_preview_parity_table() {
        let table: ParityTable =
            serde_json::from_str(PARITY_TABLE).expect("parity table must parse");
        // A truncated or emptied fixture must fail loudly rather than pass
        // vacuously — the whole point is that the rows exist.
        assert!(
            table.cases.len() >= 20,
            "parity table shrank to {} rows",
            table.cases.len()
        );

        for case in &table.cases {
            let n = &case.name;
            assert!(case.why.len() > 30, "{n}: every row states why it exists");
            let i = &case.input;
            let o = &case.out;

            let mut m = media("pm", r"C:\parity.mp4", 1, 1, false);
            m.width = i.media_w;
            m.height = i.media_h;
            let mut c = clip("pc", "pm", 0.0, 0.0, 1.0);
            c.transform = Some(ClipTransform {
                crop: i.crop.as_ref().map(|k| ClipCrop { x: k.x, y: k.y, w: k.w, h: k.h }),
                rotate: i.rotate,
                flip_h: i.flip_h,
                flip_v: i.flip_v,
                scale: i.scale,
                x: i.x,
                y: i.y,
                opacity: 1.0,
            });

            let p = placement(&c, &m, (i.canvas_w, i.canvas_h), (i.export_w, i.export_h));
            // canvas px -> output px, the conversion the offsets need.
            let sx = i.export_w as f64 / i.canvas_w as f64;
            let sy = i.export_h as f64 / i.canvas_h as f64;

            // --- the four values ffmpeg actually receives -------------------
            assert_eq!(p.dw, o.dw, "{n}: scale width");
            assert_eq!(p.dh, o.dh, "{n}: scale height");
            assert_eq!(p.ox, o.ox, "{n}: overlay x");
            assert_eq!(p.oy, o.oy, "{n}: overlay y");

            // --- the discretisation, re-derived from the PREVIEW's floats ---
            // This is the actual cross-implementation check: this crate's own
            // `round_even` applied to the number the preview produced must land
            // on the number `placement` emitted. The extent comes from the
            // preview math evaluated in the EXPORT box, because that is what
            // `placement` fits against; the OFFSETS come from the preview's own
            // box and are converted, because that is the space they are
            // authored in.
            assert_eq!(round_even(o.dw_exact_out), p.dw, "{n}: round_even(preview dw)");
            assert_eq!(round_even(o.dh_exact_out), p.dh, "{n}: round_even(preview dh)");

            // --- how far the integer export may sit from the preview --------
            // The preview positions its crop box continuously; the export must
            // land on integers with even extents. Pin the bound rather than
            // trusting it: round_even moves the extent by < 1.5 px, halved by
            // the centring (< 0.75), plus the final round (<= 0.5) → < 1.25.
            let preview_left = (i.export_w as f64 - o.dw_exact_out) / 2.0 + i.x * sx;
            let preview_top = (i.export_h as f64 - o.dh_exact_out) / 2.0 + i.y * sy;
            assert!((p.ox as f64 - preview_left).abs() < 1.25, "{n}: ox drift");
            assert!((p.oy as f64 - preview_top).abs() < 1.25, "{n}: oy drift");
            assert!((p.dw as f64 - o.dw_exact_out).abs() < 1.5, "{n}: dw drift");
            assert!((p.dh as f64 - o.dh_exact_out).abs() < 1.5, "{n}: dh drift");

            // --- pass-through fields ---------------------------------------
            assert_eq!(p.rotate, i.rotate, "{n}: rotate");
            assert_eq!(p.flip_h, i.flip_h, "{n}: flipH");
            assert_eq!(p.flip_v, i.flip_v, "{n}: flipV");
            // x/y leave `placement` in OUTPUT px (the keyframed overlay path
            // adds them to `(main_w-overlay_w)/2`, which is output px too).
            assert_eq!(p.x, i.x * sx, "{n}: x");
            assert_eq!(p.y, i.y * sy, "{n}: y");
            assert_eq!(p.sx, sx, "{n}: canvas->output x factor");
            assert_eq!(p.sy, sy, "{n}: canvas->output y factor");
            assert_eq!(p.opacity, 1.0, "{n}: opacity");

            // --- the sizes issue #1 got wrong -------------------------------
            // `src_w/src_h` is what a generator is synthesized at; the
            // `post_crop_*` pair is what sizes the opacity alpha mask. When
            // those disagree with the preview, alphamerge aborts the export.
            assert_eq!(p.src_w, o.src_w, "{n}: generator source width");
            assert_eq!(p.src_h, o.src_h, "{n}: generator source height");
            assert_eq!(p.post_crop_w, o.post_crop_w, "{n}: alpha-mask width");
            assert_eq!(p.post_crop_h, o.post_crop_h, "{n}: alpha-mask height");
            assert_eq!(
                p.crop,
                o.crop_filter.map(|a| (a[0], a[1], a[2], a[3])),
                "{n}: crop filter"
            );

            // --- the animated-scale path agrees with the static one ---------
            // `fit_w/fit_h` are pre-userScale (crop_w * fit) and feed the
            // keyframed `scale=` expression, so a divergence here would show up
            // only on animated clips. Compared with a relative tolerance
            // because Rust evaluates (crop_w * fit) * scale while the preview
            // evaluates crop_w * (fit * scale): IEEE multiplication is not
            // associative, so the two differ by a few ULP and nothing more.
            assert!(
                rel_close(p.fit_w * i.scale, o.dw_exact_out, 1e-9),
                "{n}: fit_w*scale {} vs preview {}", p.fit_w * i.scale, o.dw_exact_out
            );
            assert!(
                rel_close(p.fit_h * i.scale, o.dh_exact_out, 1e-9),
                "{n}: fit_h*scale {} vs preview {}", p.fit_h * i.scale, o.dh_exact_out
            );

            // --- the table's own derived columns stay self-consistent -------
            // k, dwExact and the offsets are all CANVAS px, so they check
            // against each other and never against the output columns.
            assert!(rel_close(o.post_crop_w as f64 * o.k, o.dw_exact, 1e-9), "{n}: k vs dwExact");
            assert!(rel_close(o.post_crop_h as f64 * o.k, o.dh_exact, 1e-9), "{n}: k vs dhExact");
            let crop_x = o.crop_filter.map_or(0.0, |a| a[2] as f64);
            let crop_y = o.crop_filter.map_or(0.0, |a| a[3] as f64);
            assert!(rel_close(-o.off_x_exact, crop_x * o.k, 1e-9), "{n}: offX vs crop x");
            assert!(rel_close(-o.off_y_exact, crop_y * o.k, 1e-9), "{n}: offY vs crop y");
        }
    }

    /// The table must keep rows that can SEE the canvas-vs-output distinction.
    /// A row exported at "Original" has one box wearing two hats and cannot
    /// tell the spaces apart — every row was such a row while the offsets were
    /// being added in the wrong units. Mirrors the vitest guard of the same
    /// name; both suites have to agree the fixture is still load-bearing.
    #[test]
    fn the_parity_table_keeps_rows_the_export_resolution_actually_moves() {
        let table: ParityTable =
            serde_json::from_str(PARITY_TABLE).expect("parity table must parse");

        // What a builder that added canvas-px x/y onto an output-px centring
        // term emits — the shipped bug, kept here so rows must diverge from it.
        let unscaled = |i: &ParityIn, o: &ParityOut| -> (i64, i64) {
            (
                ((i.export_w as f64 - o.dw as f64) / 2.0 + i.x).round() as i64,
                ((i.export_h as f64 - o.dh as f64) / 2.0 + i.y).round() as i64,
            )
        };
        let off_original = |c: &&ParityCase| {
            c.input.export_w != c.input.canvas_w || c.input.export_h != c.input.canvas_h
        };

        let rows: Vec<&ParityCase> = table.cases.iter().filter(off_original).collect();
        assert!(rows.len() >= 4, "only {} off-Original rows", rows.len());
        assert!(
            rows.iter().any(|c| c.input.export_w > c.input.canvas_w)
                && rows.iter().any(|c| c.input.export_w < c.input.canvas_w),
            "both an upscale and a downscale must appear"
        );
        // A non-aspect-preserving export: the only shape that catches one ratio
        // used for both axes, or the two swapped.
        assert!(
            rows.iter().any(|c| {
                let i = &c.input;
                i.export_w as f64 / i.canvas_w as f64 != i.export_h as f64 / i.canvas_h as f64
            }),
            "no row scales the two axes differently"
        );

        let moved = table
            .cases
            .iter()
            .filter(|c| {
                let (bx, by) = unscaled(&c.input, &c.out);
                (bx - c.out.ox).abs() >= 2 && (by - c.out.oy).abs() >= 2
            })
            .count();
        assert!(moved >= 2, "only {moved} rows move on both axes");

        // At Original the two formulas MUST agree: applying a ratio there would
        // mean converting between a space and itself.
        for c in table.cases.iter().filter(|c| !off_original(c)) {
            let (bx, by) = unscaled(&c.input, &c.out);
            assert_eq!((bx, by), (c.out.ox, c.out.oy), "{}: Original must not shift", c.name);
            assert_eq!(c.out.dw_exact_out, c.out.dw_exact, "{}: extent at Original", c.name);
            assert_eq!(c.out.dh_exact_out, c.out.dh_exact, "{}: extent at Original", c.name);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Hardware encoding — the DEFAULT path                                */
    /* ------------------------------------------------------------------ */
    //
    // `DEFAULT_EXPORT_PRESET.useHardware` is `true` (src/core/types.ts), so the
    // hardware branch of `chosen_encoder` and every NVENC/QSV/AMF arm of
    // `push_quality` are what most exports actually run — and no test in the
    // tree set the flag: the `enc()` fixture built an nvenc-capable report and
    // then every case selected software anyway.
    //
    // These pin ARGUMENT CONSTRUCTION only. Nothing here encodes: real NVENC is
    // machine-dependent and unrepeatable, while the arg-building is pure.

    fn report(h264: &str, hevc: &str, av1: &str) -> EncoderReport {
        EncoderReport {
            h264: h264.into(),
            hevc: hevc.into(),
            av1: av1.into(),
            detail: vec![],
        }
    }

    fn hw_preset(format: &str, vcodec: &str) -> ExportPreset {
        let mut p = preset(format, vcodec);
        p.use_hardware = true;
        p
    }

    /// Media dims deliberately differ from the canvas on both axes — issue #1's
    /// lesson holds even in tests that are not about geometry.
    fn built_with(p: ExportPreset, encoders: &EncoderReport) -> BuiltExport {
        let out = format!(r"C:\o.{}", p.format);
        let m = media("m1", r"C:\v.mp4", 1918, 1078, false);
        let c = clip("c1", "m1", 0.0, 0.0, 2.0);
        let tl = timeline(1280, 720, Rational { num: 30, den: 1 }, vec![vtrack(vec![c])]);
        build(&spec(vec![m], tl, p, &out), encoders).unwrap()
    }

    /// Everything `push_video_codec` emits: `-c:v <enc>` plus the quality or
    /// bitrate run that follows it, up to the trailing `-pix_fmt`.
    fn vcodec_args(b: &BuiltExport) -> Vec<String> {
        let a = argstr(b);
        let i = a.iter().position(|s| s == "-c:v").expect("-c:v must be emitted");
        let j = a.iter().position(|s| s == "-pix_fmt").expect("-pix_fmt must follow");
        assert!(j > i, "-pix_fmt must come after -c:v: {a:?}");
        a[i..j].to_vec()
    }

    fn assert_vcodec_args(b: &BuiltExport, expect: &[&str]) {
        let want: Vec<String> = expect.iter().map(|s| (*s).to_string()).collect();
        assert_eq!(vcodec_args(b), want);
    }

    #[test]
    fn hardware_nvenc_is_selected_with_its_exact_args_per_codec() {
        let r = report("h264_nvenc", "hevc_nvenc", "av1_nvenc");
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "h264"), &r),
            &["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "hevc"), &r),
            &["-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "26", "-b:v", "0"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "av1"), &r),
            &["-c:v", "av1_nvenc", "-cq", "30"],
        );
    }

    #[test]
    fn hardware_qsv_is_selected_with_its_exact_args_per_codec() {
        let r = report("h264_qsv", "hevc_qsv", "av1_qsv");
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "h264"), &r),
            &["-c:v", "h264_qsv", "-global_quality", "23"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mov", "hevc"), &r),
            &["-c:v", "hevc_qsv", "-global_quality", "26"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "av1"), &r),
            &["-c:v", "av1_qsv", "-global_quality", "30"],
        );
    }

    #[test]
    fn hardware_amf_is_selected_with_its_exact_args_per_codec() {
        let r = report("h264_amf", "hevc_amf", "av1_amf");
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "h264"), &r),
            &["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "hevc"), &r),
            &["-c:v", "hevc_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "25", "-qp_p", "27"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "av1"), &r),
            &["-c:v", "av1_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "28", "-qp_p", "30"],
        );
    }

    #[test]
    fn the_use_hardware_flag_changes_the_encoder_for_every_codec() {
        // The flag has to be READ, not merely present: with the same report,
        // hardware and software must resolve to different encoders AND
        // different quality args for all three codecs. (A test that only
        // asserted the hardware side would still pass if the branch were
        // inverted and both arms returned the same thing.)
        let r = report("h264_nvenc", "hevc_nvenc", "av1_nvenc");
        for (codec, sw) in [("h264", "libx264"), ("hevc", "libx265"), ("av1", "libsvtav1")] {
            let hw = vcodec_args(&built_with(hw_preset("mp4", codec), &r));
            let soft = vcodec_args(&built_with(preset("mp4", codec), &r));
            assert_ne!(hw, soft, "{codec}: use_hardware changed nothing");
            assert_eq!(hw[1], format!("{codec}_nvenc"), "{codec}: hardware encoder");
            assert_eq!(soft[1], sw, "{codec}: software encoder");
        }
    }

    #[test]
    fn hardware_requested_but_only_software_probed_degrades_to_software() {
        // A machine with no GPU encoder: `hw::choose` falls through to the
        // software candidate for every family, so the report holds lib* names
        // even though the user asked for hardware. The args must then be the
        // SOFTWARE ones — never NVENC flags pinned onto libx264, which ffmpeg
        // rejects outright.
        let r = report("libx264", "libx265", "libsvtav1");
        for (codec, expect) in [
            ("h264", ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]),
            ("hevc", ["-c:v", "libx265", "-preset", "medium", "-crf", "23"]),
            ("av1", ["-c:v", "libsvtav1", "-preset", "8", "-crf", "32"]),
        ] {
            let hw = built_with(hw_preset("mp4", codec), &r);
            assert_vcodec_args(&hw, &expect);
            // …and byte-identical to what use_hardware:false would emit.
            assert_eq!(
                vcodec_args(&hw),
                vcodec_args(&built_with(preset("mp4", codec), &r)),
                "{codec}: hardware fallback must equal the software path"
            );
        }
    }

    #[test]
    fn a_codec_with_no_hardware_option_degrades_without_dragging_its_siblings() {
        // The common real shape: the driver exposes h264 acceleration only.
        // Each codec resolves independently, so one fallback must not turn the
        // others off.
        let r = report("h264_nvenc", "libx265", "libsvtav1");
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "h264"), &r),
            &["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "hevc"), &r),
            &["-c:v", "libx265", "-preset", "medium", "-crf", "23"],
        );
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "av1"), &r),
            &["-c:v", "libsvtav1", "-preset", "8", "-crf", "32"],
        );
    }

    #[test]
    fn hardware_with_an_unknown_codec_falls_back_to_libx264() {
        // `chosen_encoder`'s hardware arm has no entry for anything outside
        // h264/hevc/av1, and a `.trt` carries the codec string verbatim.
        let r = report("h264_nvenc", "hevc_nvenc", "av1_nvenc");
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "vp9"), &r),
            &["-c:v", "libx264", "-preset", "medium", "-crf", "20"],
        );
    }

    #[test]
    fn an_unrecognised_encoder_name_gets_the_generic_quality_args() {
        // `encoders.json` is deserialized straight into `EncoderReport` with no
        // whitelist (`hw::read_cache`), so a stale or hand-edited cache can put
        // any string into `-c:v`. It must fall through to the generic `-crf`
        // rather than pairing an unknown encoder with NVENC-only flags.
        let r = report("h264_vaapi", "hevc_nvenc", "av1_nvenc");
        assert_vcodec_args(
            &built_with(hw_preset("mp4", "h264"), &r),
            &["-c:v", "h264_vaapi", "-crf", "23"],
        );
    }

    #[test]
    fn hardware_with_an_explicit_bitrate_replaces_the_quality_args() {
        let r = report("h264_nvenc", "hevc_nvenc", "av1_nvenc");
        let mut p = hw_preset("mp4", "h264");
        p.video_bitrate = BitratePreset::Kbps(12000);
        let b = built_with(p, &r);
        assert_vcodec_args(
            &b,
            &["-c:v", "h264_nvenc", "-b:v", "12000k", "-maxrate", "24000k", "-bufsize", "48000k"],
        );
        let a = argstr(&b);
        assert!(!a.contains(&"-cq".to_string()), "{a:?}");
        assert!(!a.contains(&"-rc".to_string()), "{a:?}");
    }

    #[test]
    fn hardware_av1_in_webm_keeps_both_the_encoder_and_the_container() {
        // webm is the one container that REJECTS h264/hevc, so it is the only
        // place the hardware av1 arm can be reached alongside a non-mp4 muxer.
        let r = report("h264_nvenc", "hevc_nvenc", "av1_qsv");
        let b = built_with(hw_preset("webm", "av1"), &r);
        assert_vcodec_args(&b, &["-c:v", "av1_qsv", "-global_quality", "30"]);
        let a = argstr(&b);
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "webm"), "{a:?}");
    }

    #[test]
    fn gif_emits_no_video_codec_even_with_hardware_requested() {
        // The palette pipeline owns the gif output, so `push_video_codec` is
        // skipped entirely: an `-c:v h264_nvenc` leaking in here would make the
        // gif muxer fail.
        let r = report("h264_nvenc", "hevc_nvenc", "av1_nvenc");
        let a = argstr(&built_with(hw_preset("gif", "h264"), &r));
        assert!(!a.contains(&"-c:v".to_string()), "{a:?}");
        assert!(!a.contains(&"h264_nvenc".to_string()), "{a:?}");
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "gif"), "{a:?}");
    }
}
