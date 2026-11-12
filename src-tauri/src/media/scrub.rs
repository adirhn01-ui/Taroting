//! The folder viewer's SCRUB COPY: a small all-keyframe copy of a heavy video,
//! made in the background, that the viewer shows over the picture while the
//! pointer drags the seek bar (`src/viewer/scrub-copy.ts`).
//!
//! Why: an exact seek decodes from the keyframe before its target, and on the
//! owner's 60-100 Mbit/s 1080p60 recordings (a keyframe every 4.17 s) that is
//! 0.6-1.4 s per picture, so the 0.9.4 seek pacer shows the NEAREST keyframe
//! during a fast drag. In a copy where every frame is a keyframe, every seek
//! lands on one: the drag shows the frame under the pointer.
//!
//! MEASURED (2026-11-11, an 8-core desktop CPU with a discrete GPU, ffmpeg at
//! below-normal priority beside other work): `-hwaccel d3d11va` + libx264 ultrafast/fastdecode
//! `-g 1` crf 30 at 360 lines, 30 fps: a 65 s 63 Mbit/s 1080p60 clip takes
//! 10.4 s and is 16.9 MB (software decode: 20.4 s); at 480 lines 27.6 MB.
//! h264_nvenc was faster (4.5 s) but 61 MB and vendor-bound: not used.
//!
//! TIME ALIGNMENT: the copy keeps the source's own timestamps (`-copyts`), so
//! the frame it shows at time t is the source's frame at t — a video track
//! that starts late (a leading empty edit, as the re-packed fragmented copy
//! has) starts late in the copy too. Without `-copyts` ffmpeg shifts the
//! output by the input's start time: measured 0.47 s early on a source whose
//! streams all start at 0.5 s. Proven frame by frame below (`e2e`).
//!
//! Cached as `CacheKind::Scrub` under the PLAYED file's identity (the
//! original, or a prepared copy inside the cache folder), on a lane of its
//! own (`Lane::Scrub`): a scrub copy never delays a remux, a proxy, a repair
//! or a thumbnail.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::jobs::{self, JobHandle, JobId, JobKind, Jobs, Lane};
use crate::media::playability::{job_tmp_suffix, Inflight};
use crate::media::probe::{self, MediaInfo, Rational};
use crate::media::source::{source_file, INPUT_PROTOCOL_ARGS};

/* ------------------------------------------------------------------ */
/* The recipe                                                          */
/* ------------------------------------------------------------------ */

// The constants below are tuned by the OWNER'S FEEL on real clips (how sharp
// the dragged picture looks, how soon the copy is ready, how much disk it
// takes): change them on what the owner says. Any change to them changes the
// copy's bytes, so it bumps SCRUB_RECIPE too.

/// The copy's height at most, in lines (never upscaled; evened down).
/// 480 lines: 27.6 MB for the measured 65 s clip; 360: 16.9 MB.
pub const SCRUB_MAX_LINES: u32 = 480;
/// A source above this frame rate is thinned to it; one at or below it keeps
/// every frame. 30 fps: a drag never needs more.
pub const SCRUB_FPS: u32 = 30;
/// libx264's quality for the copy (higher: smaller and blurrier).
pub const SCRUB_CRF: &str = "30";
/// libx264's speed preset: ultrafast keeps the job short on a slow PC.
pub const SCRUB_PRESET: &str = "ultrafast";
/// The version of everything above, in the cache file's name: a copy made
/// with other settings is never served as this one. 2: the copy states its
/// colour standard (`ScrubColor`); a recipe-1 copy of an untagged HD source
/// shows other colours than the main picture and must not be served.
pub const SCRUB_RECIPE: u32 = 2;

/// The longest a scrub job may run once it has STARTED on its lane: this many
/// seconds per second of source, and never less than `DEADLINE_FLOOR`. The
/// measured worst case is ~0.3 s per source second (software decode); a slow
/// PC gets ten times that. A job past it is stopped and the viewer keeps
/// snapping to keyframes.
const DEADLINE_PER_SOURCE_SECOND: f64 = 3.0;
const DEADLINE_FLOOR: Duration = Duration::from_secs(120);

/// The cache file's suffix (the hash of the played file's identity before it).
pub fn scrub_suffix() -> String {
    format!(".scrub{SCRUB_RECIPE}.mp4")
}

/// The source's frame rate is KNOWN and above `SCRUB_FPS`.
fn above_cap(fps: Option<Rational>) -> bool {
    fps.is_some_and(|r| r.den > 0 && r.num > 0 && u64::from(r.num) > u64::from(SCRUB_FPS) * u64::from(r.den))
}

/* ------------------------------------------------------------------ */
/* The copy's colour standard                                          */
/* ------------------------------------------------------------------ */

// WHY: the copy is shown over the main picture, so the two must look the
// same. The WebView decides the colour standard of an UNTAGGED H.264 stream
// from its height (Chromium, media/ffmpeg/ffmpeg_common.cc): below 720 lines
// BT.601, from 720 lines up BT.709. An untagged 1280x720 source is therefore
// shown as BT.709 and its untagged 480-line copy as BT.601 — the same pixels
// in other colours (measured by the in-app E2E: mean luma distance 14 of 255).
// The copy keeps the source's pixel data untouched and only SAYS which
// standard it is in: the one the source states, or else the one the WebView
// would assume for the SOURCE. Re-measure this if the WebView's rule changes.

/// The colour names the recipe passes through, per field: the names ffprobe
/// prints that the bundled ffmpeg 8.1.1 accepts in BOTH `setparams` and
/// libx264's output options, and whose scale is a no-op (measured one by one).
/// Left out, as measured: `gbr` matrix (libx264 has no such option value),
/// `ycgco`, `bt2020c`, `smpte2085`, `chroma-derived-*`, `ictcp`, `ipt-c2`,
/// `ycgco-re/ro` (the auto scale cannot negotiate them), and the transfers
/// `bt470m` / `bt470bg` (libx264 names them gamma22/gamma28, `setparams` does
/// not) and `log100` / `log316` (swscale refuses them). A source stating one
/// of those gets the height rule for that field, like an unstated one.
const PASS_SPACES: &[&str] = &["bt709", "fcc", "bt470bg", "smpte170m", "smpte240m", "bt2020nc"];
const PASS_PRIMARIES: &[&str] = &[
    "bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "film", "bt2020", "smpte428", "smpte431", "smpte432",
    "ebu3213",
];
const PASS_TRANSFERS: &[&str] = &[
    "bt709", "smpte170m", "smpte240m", "linear", "iec61966-2-4", "bt1361e", "iec61966-2-1", "bt2020-10",
    "bt2020-12", "smpte2084", "smpte428", "arib-std-b67",
];

/// From this many CODED lines up the WebView assumes BT.709 for an untagged
/// stream; below it (or when the height is unknown) BT.601 = `smpte170m`.
const HD_LINES: u32 = 720;

/// The colour bound of the probe: header fields only, like `probe`'s frame
/// probe; a cloud placeholder gets its download time on top.
const COLOR_PROBE_DEADLINE: Duration = Duration::from_secs(15);

/// What ffprobe says about the source's first video stream: its colour tags
/// as printed (empty when absent) and its CODED height (the WebView's rule
/// reads the coded size, not the rotated display size `MediaInfo` carries).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceColor {
    pub space: String,
    pub primaries: String,
    pub transfer: String,
    pub height: Option<u32>,
}

/// The colour standard the copy states: `-colorspace` / `-color_primaries` /
/// `-color_trc` values (and the same in `setparams`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrubColor {
    pub space: String,
    pub primaries: String,
    pub transfer: String,
}

/// A name that may become an argv element and a filter option value: short,
/// lower-case letters, digits, `_` and `-` only (no `:`, `,`, quote or space
/// that could reach the filtergraph).
fn is_safe_name(v: &str) -> bool {
    (1..=24).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// The value the source STATES for one field, when the recipe can pass it
/// through; `None` = not stated, unsafe, or not passable.
fn stated<'a>(value: &'a str, passable: &[&str]) -> Option<&'a str> {
    let v = value.trim();
    if matches!(v, "" | "unknown" | "unspecified" | "reserved") || !is_safe_name(v) {
        return None;
    }
    passable.contains(&v).then_some(v)
}

/// The copy's colour standard: what the source states, field by field, else
/// what the WebView would assume for the SOURCE (see above). `fallback_height`
/// stands in when the probe gave no coded height.
pub fn decide_color(src: &SourceColor, fallback_height: Option<u32>) -> ScrubColor {
    let guess = match src.height.or(fallback_height) {
        Some(h) if h >= HD_LINES => "bt709",
        _ => "smpte170m",
    };
    let pick = |v: &str, passable: &[&str]| stated(v, passable).unwrap_or(guess).to_string();
    ScrubColor {
        space: pick(&src.space, PASS_SPACES),
        primaries: pick(&src.primaries, PASS_PRIMARIES),
        transfer: pick(&src.transfer, PASS_TRANSFERS),
    }
}

/// The ONE ffprobe call: the first video stream's coded height and colour
/// tags, one `key=value` per line. Same input rules as every sink.
fn color_probe_args(src: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=height,color_space,color_primaries,color_transfer",
        "-of", "default=noprint_wrappers=1",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.extend(INPUT_PROTOCOL_ARGS.iter().map(OsString::from));
    args.push("-i".into());
    args.push(src.into());
    args
}

/// ffprobe's `key=value` lines read into a `SourceColor`; anything else is
/// ignored (an unparsable answer = all unknown).
fn parse_color_probe(stdout: &str) -> SourceColor {
    let mut c = SourceColor::default();
    for line in stdout.lines() {
        let Some((k, v)) = line.trim().split_once('=') else { continue };
        let v = v.trim().to_string();
        match k.trim() {
            "color_space" => c.space = v,
            "color_primaries" => c.primaries = v,
            "color_transfer" => c.transfer = v,
            "height" => c.height = v.parse().ok().filter(|h| *h > 0),
            _ => {}
        }
    }
    c
}

/// Probe `src`'s colour tags (blocking: called on the blocking pool by
/// `plan`). An owned sidecar under a deadline; a failed, killed or
/// unparsable probe answers all unknown.
fn probe_color(src: &Path, meta: &std::fs::Metadata) -> SourceColor {
    let Ok(mut cmd) = crate::jobs::ffmpeg::command("ffprobe") else {
        return SourceColor::default();
    };
    cmd.args(color_probe_args(src));
    let deadline = crate::media::source::deadline_for(COLOR_PROBE_DEADLINE, meta);
    match crate::jobs::ffmpeg::run_with_deadline(cmd, deadline) {
        Ok(Some(out)) if out.status.success() => parse_color_probe(&String::from_utf8_lossy(&out.stdout)),
        _ => SourceColor::default(),
    }
}

/// The copy's filter chain: first `setparams` STATES the colour standard on
/// every frame (a tag, no pixel change), then down to `SCRUB_MAX_LINES` at
/// most, never up, at an EVEN height (libx264 refuses an odd one in yuv420p:
/// measured, a 181-line source failed with `min(480,ih)` alone — the proxy's
/// own lesson), and thinned to `SCRUB_FPS` only when the source is known to
/// be faster.
///
/// Why `setparams` and not the output options alone (MEASURED, ffmpeg 8.1.1,
/// on the untagged 720p fixture): with only `-colorspace bt709` etc. on the
/// output, ffmpeg's format negotiation made the scaler CONVERT the untagged
/// (taken as BT.601) frames to BT.709 — luma 16 of 255 off per pixel on
/// average — and the encoder still wrote primaries/transfer as unknown (it
/// takes those from the frames). Tagged frames scale with the same matrix in
/// and out: the pixels match the untagged copy exactly.
fn scrub_filter(fps: Option<Rational>, color: &ScrubColor) -> String {
    let mut vf = format!(
        "setparams=colorspace={}:color_primaries={}:color_trc={},scale=-2:'min({SCRUB_MAX_LINES},trunc(ih/2)*2)':flags=fast_bilinear",
        color.space, color.primaries, color.transfer
    );
    if above_cap(fps) {
        vf.push_str(&format!(",fps={SCRUB_FPS}"));
    }
    vf
}

/// The scrub copy's argv. `-copyts` keeps the source's timestamps (see the
/// module comment); `-hwaccel d3d11va` decodes on the GPU where it can, and
/// ffmpeg falls back to software decoding by itself where it cannot (a codec
/// D3D11VA has no profile for, 4:4:4 H.264: measured below). The protocol
/// whitelist sits directly before `-i` (`media::source`). Video only; every
/// frame a keyframe (`-g 1`). The colour standard is stated twice, in the
/// filter (see `scrub_filter`) and as the encoder's OUTPUT options, always
/// the same values.
///
/// No `-color_range`: the frames carry their own range and the encoder
/// writes it. MEASURED (ffmpeg 8.1.1): a full-range `yuvj420p` source keeps
/// its full-range levels through `-pix_fmt yuv420p` and the copy is tagged
/// `pc` — picture and tag agree, as in the source (pinned below).
pub fn scrub_args(src: &Path, dst: &Path, fps: Option<Rational>, color: &ScrubColor) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
        "-copyts",
        "-hwaccel", "d3d11va",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.extend(INPUT_PROTOCOL_ARGS.iter().map(OsString::from));
    args.push("-i".into());
    args.push(src.into());
    let vf = scrub_filter(fps, color);
    args.extend(
        [
            "-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", vf.as_str(),
            "-c:v", "libx264", "-preset", SCRUB_PRESET, "-tune", "fastdecode",
            "-g", "1", "-crf", SCRUB_CRF,
            "-pix_fmt", "yuv420p",
            "-colorspace", color.space.as_str(),
            "-color_primaries", color.primaries.as_str(),
            "-color_trc", color.transfer.as_str(),
            "-movflags", "+faststart", "-f", "mp4",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args.push(dst.into());
    args
}

/// How long a started job may run for a source of `duration` seconds.
fn deadline_for(duration: f64) -> Duration {
    let scaled = if duration.is_finite() && duration > 0.0 {
        Duration::from_secs_f64((duration * DEADLINE_PER_SOURCE_SECOND).min(24.0 * 3600.0))
    } else {
        Duration::ZERO
    };
    scaled.max(DEADLINE_FLOOR)
}

/* ------------------------------------------------------------------ */
/* plan_scrub                                                          */
/* ------------------------------------------------------------------ */

/// What the viewer gets back. Mirror of `ScrubPlan` in src/core/ipc.ts.
/// `rename_all_fields`: the struct variants' fields reach the webview in
/// camelCase (`jobId`), not only the tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "mode")]
pub enum ScrubPlan {
    /// The copy is in the cache.
    Ready { path: String },
    /// The copy is being made; its `job:done` names the file, `job:failed`
    /// ends it. Cancel it with `cancel_job`.
    Pending { job_id: JobId },
    /// No copy for this file: not a file, not a video ffprobe can read, or no
    /// cache. `reason` is for the dev hook, never shown.
    Unavailable { reason: String },
}

fn unavailable(reason: impl Into<String>) -> ScrubPlan {
    ScrubPlan::Unavailable { reason: reason.into() }
}

/// A scrub job, ready to run: what `plan` hands the starter.
struct ScrubJob {
    handle: JobHandle,
    args: Vec<OsString>,
    tmp: PathBuf,
    final_path: PathBuf,
    duration: f64,
}

/// The plan for `path`, with the probe and the job start injected so the
/// tests can drive every branch without Tauri.
fn plan(
    cache: &Cache,
    jobs: &Jobs,
    inflight: &Inflight,
    path: &str,
    probe: impl FnOnce(&str) -> crate::error::Result<MediaInfo>,
    color: impl FnOnce(&Path, &std::fs::Metadata) -> SourceColor,
    start: impl FnOnce(ScrubJob),
) -> ScrubPlan {
    // The path names the file the viewer is playing; anything that is not a
    // plain file is refused before anything else touches it.
    let src = match source_file(path) {
        Ok(src) => src,
        Err(e) => return unavailable(format!("not a file: {e}")),
    };
    let meta = match std::fs::metadata(src) {
        Ok(m) => m,
        Err(e) => return unavailable(format!("cannot read the file: {e}")),
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    let hash = MediaKey { path: path.to_string(), size: meta.len(), mtime_ms }.hash();
    let suffix = scrub_suffix();
    if let Some(ready) = cache.existing_file(CacheKind::Scrub, &hash, &suffix) {
        return ScrubPlan::Ready { path: ready.to_string_lossy().into_owned() };
    }

    let info = match probe(path) {
        Ok(info) => info,
        Err(e) => return unavailable(format!("not readable: {e}")),
    };
    if info.kind != "video" {
        return unavailable(format!("not a video ({})", info.kind));
    }
    if let Err(e) = cache.ensure_kind_dir(CacheKind::Scrub) {
        return unavailable(format!("no cache folder: {e}"));
    }
    let final_path = cache.file_path(CacheKind::Scrub, &hash, &suffix);
    let handle = match inflight.claim(jobs, &final_path, || {
        let h = jobs.allocate(JobKind::Scrub);
        (h.id, h)
    }) {
        Ok((_, handle)) => handle,
        Err(existing) => return ScrubPlan::Pending { job_id: existing },
    };
    let tmp = cache.file_path(CacheKind::Scrub, &hash, &job_tmp_suffix(&suffix, handle.id));
    // The colour tags: one more ffprobe, only for a job about to start.
    let scrub_color = decide_color(&color(src, &meta), info.height);
    let args = scrub_args(src, &tmp, info.fps, &scrub_color);
    let id = handle.id;
    start(ScrubJob { handle, args, tmp, final_path, duration: info.duration });
    ScrubPlan::Pending { job_id: id }
}

/// Run `job` on the scrub lane: the shared job machinery (progress and done
/// events, `cancel_job`, the partial file deleted on failure, the slot in
/// `Inflight` freed only once the file is in place), a deadline from the
/// moment the lane starts it, the `.tmp` renamed into place on success.
fn submit(app: &AppHandle, jobs: &Arc<Jobs>, cache: &Arc<Cache>, inflight: &Inflight, job: ScrubJob) {
    let app = app.clone();
    let jobs_arc = Arc::clone(jobs);
    let cache = Arc::clone(cache);
    let inflight = Inflight::clone(inflight);
    jobs.submit(
        Lane::Scrub,
        Box::new(move || {
            let ScrubJob { handle, args, tmp, final_path, duration } = job;
            handle.set_output(tmp.clone());
            // The watchdog: cancels the job when it overruns. Its channel's
            // sender lives until ffmpeg returns, so a finished job ends the
            // wait at once. A thread the OS refuses only means no deadline.
            let (alive_tx, alive_rx) = mpsc::channel::<()>();
            let timed_out = Arc::new(AtomicBool::new(false));
            let deadline = deadline_for(duration);
            {
                let (jobs, timed_out, id) = (Arc::clone(&jobs_arc), Arc::clone(&timed_out), handle.id);
                let _ = std::thread::Builder::new().name("scrub-deadline".into()).spawn(move || {
                    if let Err(mpsc::RecvTimeoutError::Timeout) = alive_rx.recv_timeout(deadline) {
                        timed_out.store(true, Ordering::Relaxed);
                        jobs.cancel(id);
                    }
                });
            }
            let total = (duration > 0.0).then_some(duration);
            let result = jobs::execute_ffmpeg(&app, &handle, args, total, None);
            drop(alive_tx);
            match result {
                Ok(()) => {
                    let renamed = std::fs::rename(&tmp, &final_path);
                    inflight.release(&final_path, handle.id);
                    if let Err(e) = renamed {
                        jobs::fail_job(&app, &jobs_arc, &handle, format!("finalize failed: {e}"), Vec::new());
                        return;
                    }
                    cache.mark_used(&final_path);
                    jobs::complete_job(&app, &jobs_arc, &handle, serde_json::json!({ "path": final_path.to_string_lossy() }));
                }
                Err(failure) => {
                    inflight.release(&final_path, handle.id);
                    let message = if timed_out.load(Ordering::Relaxed) {
                        format!("the scrub copy took longer than {} s and was stopped", deadline.as_secs())
                    } else {
                        failure.message
                    };
                    jobs::fail_job(&app, &jobs_arc, &handle, message, failure.log_tail);
                }
            }
        }),
    );
}

/// The scrub copy of the video the viewer is playing at `path`: `Ready` when
/// it is cached, `Pending` while a job makes it (one job per file however
/// often it is asked), `Unavailable` when there is none to make. Async, with
/// the stat, the cache lookup and the probe on the blocking pool.
#[tauri::command]
pub async fn plan_scrub(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    inflight: State<'_, Inflight>,
    path: String,
) -> crate::error::Result<ScrubPlan> {
    let (jobs, inflight) = (Arc::clone(&jobs), Inflight::clone(&inflight));
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let Some(cache) = app.try_state::<Arc<Cache>>().map(|c| Arc::clone(&c)) else {
            return unavailable("no cache");
        };
        plan(&cache, &jobs, &inflight, &path, probe::probe_sync, probe_color, |job| {
            submit(&app, &jobs, &cache, &inflight, job)
        })
    })
    .await
    .unwrap_or_else(|e| unavailable(format!("planning stopped: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn rat(num: u32, den: u32) -> Option<Rational> {
        Some(Rational { num, den })
    }

    /// The argv, whole and literal, for a 30 fps source: timestamps kept,
    /// GPU decode asked for BEFORE the input, the protocol whitelist directly
    /// before `-i`, video only, every frame a keyframe, never upscaled, no
    /// frame-rate filter.
    fn col(space: &str, primaries: &str, transfer: &str) -> ScrubColor {
        ScrubColor { space: space.into(), primaries: primaries.into(), transfer: transfer.into() }
    }

    fn src_color(space: &str, primaries: &str, transfer: &str, height: Option<u32>) -> SourceColor {
        SourceColor { space: space.into(), primaries: primaries.into(), transfer: transfer.into(), height }
    }

    #[test]
    fn the_argv_is_the_locked_recipe() {
        let args = s(&scrub_args(
            Path::new(r"C:\rec\Replay 2026.mp4"),
            Path::new(r"C:\c\x.scrub2.mp4.7.tmp"),
            rat(30, 1),
            &col("bt470bg", "bt709", "smpte170m"),
        ));
        assert_eq!(
            args,
            [
                "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
                "-copyts",
                "-hwaccel", "d3d11va",
                "-protocol_whitelist", "file", "-i", r"C:\rec\Replay 2026.mp4",
                "-map", "0:v:0", "-an", "-sn", "-dn",
                "-vf", "setparams=colorspace=bt470bg:color_primaries=bt709:color_trc=smpte170m,scale=-2:'min(480,trunc(ih/2)*2)':flags=fast_bilinear",
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode",
                "-g", "1", "-crf", "30",
                "-pix_fmt", "yuv420p",
                "-colorspace", "bt470bg", "-color_primaries", "bt709", "-color_trc", "smpte170m",
                "-movflags", "+faststart", "-f", "mp4",
                r"C:\c\x.scrub2.mp4.7.tmp",
            ]
        );
        crate::media::source::assert_inputs_whitelisted(&args);
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(&args[i - 2..i], ["-protocol_whitelist", "file"], "the whitelist directly before -i");
        assert!(args.iter().position(|a| a == "-hwaccel").unwrap() < i, "an input option");
    }

    /// The three colour options are OUTPUT options (after `-i`, before the
    /// destination), carry the same values as the filter's `setparams`, and
    /// no `-color_range` is ever emitted (the frames carry their own).
    #[test]
    fn the_colour_options_are_output_options_and_no_range_is_forced() {
        let c = col("smpte170m", "bt2020", "smpte2084");
        let args = s(&scrub_args(Path::new("a.mp4"), Path::new("b.mp4"), None, &c));
        let i = args.iter().position(|a| a == "-i").unwrap();
        let dst = args.len() - 1;
        assert_eq!(args[dst], "b.mp4");
        for (opt, v) in [("-colorspace", "smpte170m"), ("-color_primaries", "bt2020"), ("-color_trc", "smpte2084")] {
            let at = args.iter().position(|a| a == opt).unwrap_or_else(|| panic!("{opt} missing"));
            assert!(at > i + 1 && at + 1 < dst, "{opt} must be an output option");
            assert_eq!(args[at + 1], v, "{opt}");
            assert_eq!(args.iter().filter(|a| *a == opt).count(), 1, "{opt} once");
        }
        assert!(!args.iter().any(|a| a.contains("color_range") || a.contains("range=")), "no range forced: {args:?}");
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(vf.starts_with("setparams=colorspace=smpte170m:color_primaries=bt2020:color_trc=smpte2084,"), "{vf}");
    }

    /// The decision table: a stated (passable) value passes through, field by
    /// field; an unstated one ("unknown", "unspecified", "reserved", empty)
    /// takes what the WebView assumes for the SOURCE's coded height — 719 →
    /// BT.601 (smpte170m), 720 and 1080 → BT.709, unknown → BT.601; the coded
    /// height wins over the fallback; an unsafe, over-long or unpassable value
    /// counts as unstated.
    #[test]
    fn the_colour_decision_table() {
        let all = |c: &str| col(c, c, c);
        for (h, want) in [(Some(719), "smpte170m"), (Some(720), "bt709"), (Some(1080), "bt709"), (None, "smpte170m")] {
            for v in ["unknown", "unspecified", "reserved", "", "  "] {
                assert_eq!(decide_color(&src_color(v, v, v, h), None), all(want), "{v:?} at {h:?}");
                assert_eq!(decide_color(&src_color(v, v, v, None), h), all(want), "{v:?} at fallback {h:?}");
            }
        }
        // Coded height first: a rotated 1280x720 phone clip probes 720 coded
        // lines though its display height is 1280; a 480-line clip shown
        // rotated to 854 is still BT.601.
        assert_eq!(decide_color(&src_color("", "", "", Some(480)), Some(854)), all("smpte170m"));
        // Stated values pass through whatever the height says.
        assert_eq!(decide_color(&src_color("bt709", "bt709", "bt709", Some(360)), None), all("bt709"));
        assert_eq!(decide_color(&src_color("smpte170m", "bt470bg", "iec61966-2-1", Some(2160)), None), col("smpte170m", "bt470bg", "iec61966-2-1"));
        assert_eq!(decide_color(&src_color("bt2020nc", "bt2020", "smpte2084", Some(2160)), None), col("bt2020nc", "bt2020", "smpte2084"));
        // Field by field: only the stated field passes.
        assert_eq!(decide_color(&src_color("bt470bg", "unknown", "", Some(1080)), None), col("bt470bg", "bt709", "bt709"));
        // Unsafe / over-long / not passable by this ffmpeg → the height rule.
        for bad in ["bt709:x", "bt709,scale", "BT709", "bt 709", "bt709'", "abcdefghijklmnopqrstuvwxy", "gbr", "ycgco", "log100", "zzz"] {
            assert_eq!(decide_color(&src_color(bad, bad, bad, Some(1080)), None), all("bt709"), "{bad:?}");
            assert_eq!(decide_color(&src_color(bad, bad, bad, Some(360)), None), all("smpte170m"), "{bad:?}");
        }
        // bt470bg is a passable matrix and primaries but not a transfer.
        assert_eq!(decide_color(&src_color("bt470bg", "bt470bg", "bt470bg", Some(576)), None), col("bt470bg", "bt470bg", "smpte170m"));
    }

    /// The argv-safety gate on its own (the pass lists hold only safe names,
    /// so this is the guard a future list entry cannot slip past).
    #[test]
    fn only_short_plain_names_are_safe() {
        for ok in ["bt709", "iec61966-2-1", "bt2020_10", "a", "abcdefghijklmnopqrstuvwx"] {
            assert!(is_safe_name(ok), "{ok}");
        }
        for bad in ["", "abcdefghijklmnopqrstuvwxy", "Bt709", "bt709:", "bt,709", "bt'709", "bt 709", "bt709\n", "bt\u{e9}709"] {
            assert!(!is_safe_name(bad), "{bad:?}");
        }
        for list in [PASS_SPACES, PASS_PRIMARIES, PASS_TRANSFERS] {
            assert!(list.iter().all(|v| is_safe_name(v)));
        }
    }

    /// The probe's shape: ONE ffprobe call for the first video stream's
    /// height and three colour fields, `key=value` lines, the input whitelisted.
    #[test]
    fn the_colour_probe_is_one_whitelisted_call() {
        let args = s(&color_probe_args(Path::new(r"C:\rec\a b.mp4")));
        assert_eq!(
            args,
            [
                "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=height,color_space,color_primaries,color_transfer",
                "-of", "default=noprint_wrappers=1",
                "-protocol_whitelist", "file", "-i", r"C:\rec\a b.mp4",
            ]
        );
        crate::media::source::assert_inputs_whitelisted(&args);
        assert_eq!(
            parse_color_probe("height=720\r\ncolor_space=unknown\ncolor_transfer=bt709\ncolor_primaries=bt470bg\n"),
            src_color("unknown", "bt470bg", "bt709", Some(720))
        );
        assert_eq!(parse_color_probe(""), SourceColor::default());
        assert_eq!(parse_color_probe("garbage\nheight=N/A\nheight=0"), SourceColor::default());
    }

    /// The frame-rate rule both ways: thinned to 30 only when the rate is
    /// KNOWN and above it (60, 59.94, 30.01); kept at 30, 29.97, 24, and when
    /// unknown or nonsense (0/0, 0/1).
    #[test]
    fn the_frame_rate_is_thinned_only_when_known_to_be_above_the_cap() {
        let c = col("bt709", "bt709", "bt709");
        let vf = |fps| {
            let args = s(&scrub_args(Path::new("a.mp4"), Path::new("b.mp4"), fps, &c));
            args[args.iter().position(|a| a == "-vf").unwrap() + 1].clone()
        };
        let thinned = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,scale=-2:'min(480,trunc(ih/2)*2)':flags=fast_bilinear,fps=30";
        let kept = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,scale=-2:'min(480,trunc(ih/2)*2)':flags=fast_bilinear";
        for fps in [rat(60, 1), rat(60000, 1001), rat(3001, 100)] {
            assert_eq!(vf(fps), thinned, "{fps:?}");
        }
        for fps in [rat(30, 1), rat(30000, 1001), rat(24, 1), None, rat(0, 0), rat(0, 1), rat(60, 0)] {
            assert_eq!(vf(fps), kept, "{fps:?}");
        }
    }

    /// The scale never asks for more lines than the source has (`min(…, ih)`),
    /// and its cap is the constant.
    #[test]
    fn the_scale_never_upscales() {
        let vf = scrub_filter(None, &col("bt709", "bt709", "bt709"));
        assert!(vf.contains(&format!(",scale=-2:'min({SCRUB_MAX_LINES},trunc(ih/2)*2)'")), "{vf}");
        assert!(!vf.contains("max("));
    }

    #[test]
    fn the_deadline_scales_with_the_source_and_has_a_floor() {
        assert_eq!(deadline_for(10.0), DEADLINE_FLOOR);
        assert_eq!(deadline_for(f64::NAN), DEADLINE_FLOOR);
        assert_eq!(deadline_for(600.0), Duration::from_secs(1800));
    }

    /// The wire shape: tagged by `mode`, the fields in camelCase.
    #[test]
    fn the_plan_reaches_the_webview_in_camel_case() {
        let j = |p: ScrubPlan| serde_json::to_value(p).unwrap();
        assert_eq!(j(ScrubPlan::Ready { path: "C:\\c\\a.mp4".into() }), serde_json::json!({ "mode": "ready", "path": "C:\\c\\a.mp4" }));
        assert_eq!(j(ScrubPlan::Pending { job_id: 7 }), serde_json::json!({ "mode": "pending", "jobId": 7 }));
        assert_eq!(j(unavailable("x")), serde_json::json!({ "mode": "unavailable", "reason": "x" }));
    }

    #[test]
    fn plan_scrub_runs_off_the_ui_thread() {
        let code: String = include_str!("scrub.rs").split("#[cfg(test)]").next().unwrap().split_whitespace().collect();
        assert!(code.contains("pubasyncfnplan_scrub("));
        assert!(code.contains("tauri::async_runtime::spawn_blocking("));
        assert!(code.contains("jobs.submit(Lane::Scrub,"), "its own lane");
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("taroting scrub {name} {}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn info(kind: &str) -> MediaInfo {
        MediaInfo {
            path: String::new(), size: 0, mtime_ms: 0, kind: kind.into(), duration: 12.5,
            fps: rat(60, 1), width: Some(1920), height: Some(1080), container: None, vcodec: None,
            acodec: None, pix_fmt: None, bit_depth: None, has_audio: false, audio_rate: None,
            audio_channels: None, oriented: None, no_autorotate: None,
        }
    }

    /// Every branch of the plan: a path that is not a file is Unavailable
    /// with no probe; a non-video is Unavailable; a video misses, starts ONE
    /// job (argv for its own frame rate, into a per-job tmp beside the final
    /// name) and a second ask joins it; a cached copy is Ready with no probe
    /// and no job; a changed file misses again.
    #[test]
    fn the_plan_answers_every_case() {
        let dir = scratch("plan");
        let cache = Cache::new_at(dir.0.join("cache"));
        let jobs = Jobs::default();
        let inflight = Inflight::default();
        let video = dir.0.join("clip one.mp4");
        std::fs::write(&video, b"pretend video").unwrap();
        let vpath = video.to_str().unwrap().to_string();
        let never_probe = |_: &str| -> crate::error::Result<MediaInfo> { panic!("no probe expected") };
        let never_start = |_: ScrubJob| panic!("no job expected");
        let never_color = |_: &Path, _: &std::fs::Metadata| -> SourceColor { panic!("no colour probe expected") };
        let no_tags = |_: &Path, _: &std::fs::Metadata| SourceColor::default();

        for bad in ["", "relative.mp4", "https://example.com/a.mp4", r"\\.\PhysicalDrive0", dir.0.to_str().unwrap()] {
            assert!(matches!(plan(&cache, &jobs, &inflight, bad, never_probe, never_color, never_start), ScrubPlan::Unavailable { .. }), "{bad:?}");
        }
        let missing = dir.0.join("gone.mp4");
        assert!(matches!(plan(&cache, &jobs, &inflight, missing.to_str().unwrap(), never_probe, never_color, never_start), ScrubPlan::Unavailable { .. }));

        for kind in ["audio", "image", "gif"] {
            let p = plan(&cache, &jobs, &inflight, &vpath, |_| Ok(info(kind)), never_color, never_start);
            assert!(matches!(p, ScrubPlan::Unavailable { .. }), "{kind}: {p:?}");
        }
        let refused = plan(&cache, &jobs, &inflight, &vpath, |_| Err(crate::error::AppError::BadInput("nope".into())), never_color, never_start);
        assert!(matches!(refused, ScrubPlan::Unavailable { .. }));

        // The colour probe is asked about the SAME file, and its answer
        // reaches the argv: a stated matrix passes; the unstated fields take
        // the rule for the probe's CODED 576 lines (BT.601), not the 1080 of
        // the stream probe (BT.709).
        let mut started = None;
        let mut probed_color = None;
        let first = plan(
            &cache, &jobs, &inflight, &vpath,
            |_| Ok(info("video")),
            |p, _| {
                probed_color = Some(p.to_path_buf());
                src_color("bt470bg", "unknown", "", Some(576))
            },
            |job| started = Some(job),
        );
        let job = started.expect("a job");
        assert_eq!(probed_color.as_deref(), Some(video.as_path()));
        assert_eq!(first, ScrubPlan::Pending { job_id: job.handle.id });
        assert_eq!(job.handle.kind, JobKind::Scrub);
        assert_eq!(job.duration, 12.5);
        let args = s(&job.args);
        assert_eq!(args[args.iter().position(|a| a == "-i").unwrap() + 1], vpath);
        assert!(args.iter().any(|a| a.ends_with(",fps=30")), "the probed 60 fps reaches the argv");
        let opt = |o: &str| args[args.iter().position(|a| a == o).unwrap() + 1].clone();
        assert_eq!((opt("-colorspace"), opt("-color_primaries"), opt("-color_trc")), ("bt470bg".into(), "smpte170m".into(), "smpte170m".into()));
        assert_eq!(args.last().unwrap(), &job.tmp.to_string_lossy());
        assert_eq!(job.final_path.parent(), Some(dir.0.join("cache").join("scrub").as_path()));
        assert!(job.final_path.to_string_lossy().ends_with(".scrub2.mp4"), "recipe 2: a recipe-1 copy is never served");
        assert_eq!(job.tmp.to_string_lossy(), format!("{}.{}.tmp", job.final_path.to_string_lossy(), job.handle.id));

        let again = plan(&cache, &jobs, &inflight, &vpath, |_| Ok(info("video")), never_color, never_start);
        assert_eq!(again, first, "a second ask joins the job");

        // A recipe-1 copy lying in the cache is not this recipe's.
        let old = job.final_path.to_string_lossy().replace(".scrub2.mp4", ".scrub1.mp4");
        std::fs::write(&old, b"old copy").unwrap();
        assert_eq!(plan(&cache, &jobs, &inflight, &vpath, |_| Ok(info("video")), never_color, never_start), first);

        std::fs::write(&job.final_path, b"copy").unwrap();
        inflight.release(&job.final_path, job.handle.id);
        assert_eq!(
            plan(&cache, &jobs, &inflight, &vpath, never_probe, never_color, never_start),
            ScrubPlan::Ready { path: job.final_path.to_string_lossy().into_owned() }
        );

        // The file changed (size): its old copy is not this file's.
        std::fs::write(&video, b"pretend video, re-recorded").unwrap();
        let mut restarted = false;
        let changed = plan(&cache, &jobs, &inflight, &vpath, |_| Ok(info("video")), no_tags, |_| restarted = true);
        assert!(matches!(changed, ScrubPlan::Pending { .. }) && restarted, "{changed:?}");
    }

    /// The scrub folder is a cache kind like the others: counted in the
    /// stats, emptied by Clear cache.
    #[test]
    fn scrub_copies_are_counted_and_cleared_with_the_cache() {
        let dir = scratch("cache");
        let cache = Cache::new_at(dir.0.join("cache"));
        cache.ensure_kind_dir(CacheKind::Scrub).unwrap();
        let copy = cache.file_path(CacheKind::Scrub, "0123456789abcdef", &scrub_suffix());
        std::fs::write(&copy, vec![0u8; 1234]).unwrap();
        cache.mark_used(&copy);
        let stats = cache.stats();
        assert_eq!(stats.by_kind["scrub"], 1234);
        assert_eq!(stats.total_bytes, 1234);
        assert_eq!(cache.clear(&std::collections::HashSet::new()), 1234);
        assert!(!copy.exists());
    }
}

/// Real runs of the recipe with the bundled ffmpeg.
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::jobs::ffmpeg;
    use crate::media::fragmented::tests::repo_fixture;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("taroting scrub e2e {name} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn ffmpeg_ok<S: AsRef<std::ffi::OsStr>>(args: &[S]) {
        let out = ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
        assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// The argv the job runs for `src`: the same probes, the same decision.
    fn job_args(src: &Path, dst: &Path) -> Vec<OsString> {
        let info = probe::probe_sync(src.to_str().unwrap()).unwrap();
        let color = decide_color(&probe_color(src, &std::fs::metadata(src).unwrap()), info.height);
        scrub_args(src, dst, info.fps, &color)
    }

    /// The scrub copy of `src` at `dst`, made with the exact argv the job runs.
    fn make_copy(src: &Path, dst: &Path) {
        ffmpeg_ok(&job_args(src, dst));
    }

    /// ffprobe's view of the first video stream: (color_space,
    /// color_primaries, color_transfer, color_range).
    fn tags(path: &Path) -> (String, String, String, String) {
        let out = ffmpeg::run("ffprobe", &[
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range", "-of", "json",
            path.to_str().unwrap(),
        ])
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let st = &json["streams"][0];
        let f = |k: &str| st[k].as_str().unwrap_or("unknown").to_string();
        (f("color_space"), f("color_primaries"), f("color_transfer"), f("color_range"))
    }

    fn tags3(path: &Path) -> (String, String, String) {
        let (a, b, c, _) = tags(path);
        (a, b, c)
    }

    fn three(v: &str) -> (String, String, String) {
        (v.into(), v.into(), v.into())
    }

    /// An H.264 test source made by the bundled ffmpeg: libx264 from
    /// testsrc2 writes NO colour tags; `tag` sets them in the bitstream
    /// (h264_metadata, codes per H.273: 1 = BT.709).
    fn h264_source(dir: &Path, name: &str, size: &str, tag: Option<&str>) -> PathBuf {
        let plain = dir.join(format!("{name} plain.mp4"));
        ffmpeg_ok(&[
            "-y", "-v", "error", "-f", "lavfi", "-i", &format!("testsrc2=size={size}:rate=30:duration=2"),
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", plain.to_str().unwrap(),
        ]);
        let Some(bsf) = tag else { return plain };
        let tagged = dir.join(format!("{name}.mp4"));
        ffmpeg_ok(&["-y", "-v", "error", "-i", plain.to_str().unwrap(), "-c", "copy", "-bsf:v", bsf, tagged.to_str().unwrap()]);
        tagged
    }

    /// The Y plane of the frame at `t` seconds, scaled to 64x36 in yuv420p
    /// (luma kept as coded: no matrix, no range conversion).
    fn luma_at(path: &Path, t: f64) -> Vec<u8> {
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
            .arg(path)
            .args(["-frames:v", "1", "-vf", "scale=64:36:flags=area", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(out.stdout.len() >= 64 * 36, "a frame");
        out.stdout[..64 * 36].to_vec()
    }

    fn mean_abs_diff(a: &[u8], b: &[u8]) -> f64 {
        sad(a, b) as f64 / a.len() as f64
    }

    /// (a) The untagged 1280x720 fixture — shown by the WebView as BT.709 —
    /// gets a copy that SAYS bt709 on all three fields (untagged, its 480
    /// lines would be shown as BT.601).
    #[test]
    fn an_untagged_hd_source_gets_a_bt709_copy() {
        let fixture = repo_fixture("counter_audio_h264.mp4");
        assert!(fixture.exists(), "{} is missing: run `npm run fixtures`", fixture.display());
        assert_eq!(tags3(&fixture), three("unknown"), "fixture: untagged");
        let dir = scratch("colour hd");
        let copy = dir.0.join("copy.mp4");
        make_copy(&fixture, &copy);
        assert_eq!(probe::probe_sync(copy.to_str().unwrap()).unwrap().height, Some(480));
        assert_eq!(tags3(&copy), three("bt709"));
    }

    /// (b) An untagged source below 720 lines → smpte170m on all three; (c) a
    /// source TAGGED bt709 at 360 lines keeps bt709 — the height rule alone
    /// would say smpte170m, so this tells "pass through" from "guess".
    #[test]
    fn a_small_source_is_guessed_bt601_unless_it_states_otherwise() {
        let dir = scratch("colour small");
        let untagged = h264_source(&dir.0, "untagged", "640x360", None);
        assert_eq!(tags3(&untagged), three("unknown"), "fixture: untagged");
        let copy = dir.0.join("untagged copy.mp4");
        make_copy(&untagged, &copy);
        assert_eq!(tags3(&copy), three("smpte170m"));

        let tagged = h264_source(
            &dir.0, "tagged", "640x360",
            Some("h264_metadata=matrix_coefficients=1:colour_primaries=1:transfer_characteristics=1"),
        );
        assert_eq!(tags3(&tagged), three("bt709"), "fixture: tagged");
        let copy = dir.0.join("tagged copy.mp4");
        make_copy(&tagged, &copy);
        assert_eq!(tags3(&copy), three("bt709"));
    }

    /// (d) Tagging does not touch the picture data: the copy's luma at 3 s
    /// equals the source's within scaling and crf noise (measured: mean 0.84
    /// of 255, max 4). The output options alone, without `setparams`, made
    /// ffmpeg convert the untagged frames to BT.709: measured mean 16.1, max 29.
    #[test]
    fn tagging_leaves_the_pixels_alone() {
        let fixture = repo_fixture("counter_audio_h264.mp4");
        assert!(fixture.exists(), "{} is missing: run `npm run fixtures`", fixture.display());
        let dir = scratch("colour pixels");
        let copy = dir.0.join("copy.mp4");
        make_copy(&fixture, &copy);
        let d = mean_abs_diff(&luma_at(&fixture, 3.0), &luma_at(&copy, 3.0));
        eprintln!("source vs copy luma at 3 s: mean |diff| {d:.3}");
        assert!(d < 2.5, "the copy's luma moved: mean |diff| {d:.3}");
    }

    /// (e) A full-range (`yuvj420p`, range pc) source: the copy keeps the
    /// full-range levels AND says so (`pc`) — black stays 0 and white 255
    /// (a limited-range copy would hold ~16 and ~235), and the tag agrees.
    #[test]
    fn a_full_range_source_stays_full_range_and_says_so() {
        let dir = scratch("colour full range");
        let src = dir.0.join("full.mp4");
        ffmpeg_ok(&[
            "-y", "-v", "error", "-f", "lavfi",
            "-i", "color=c=black:size=320x180:rate=10:duration=1[a];color=c=white:size=320x180:rate=10:duration=1[b];[a][b]hstack,format=yuvj420p",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuvj420p", src.to_str().unwrap(),
        ]);
        assert_eq!(tags(&src).3, "pc", "fixture: full range");
        let copy = dir.0.join("copy.mp4");
        make_copy(&src, &copy);
        let range = tags(&copy).3;
        let (s, c) = (luma_at(&src, 0.5), luma_at(&copy, 0.5));
        let (min, max) = (c.iter().min().copied().unwrap(), c.iter().max().copied().unwrap());
        eprintln!(
            "full range: copy tagged {range}, luma min {min} max {max} (source min {} max {})",
            s.iter().min().unwrap(), s.iter().max().unwrap()
        );
        assert_eq!(range, "pc", "the copy says full range");
        assert!(min <= 3 && max >= 252, "full-range levels kept: {min}..{max}");
    }

    /// Every decoded video frame of `path`: (pts seconds, keyframe).
    fn frames(path: &Path) -> Vec<(f64, bool)> {
        let out = ffmpeg::run("ffprobe", &[
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pts_time,key_frame", "-of", "json",
            path.to_str().unwrap(),
        ])
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        json["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                let pts = f["pts_time"].as_str().and_then(|t| t.parse().ok()).unwrap_or(f64::NAN);
                (pts, f["key_frame"].as_i64() == Some(1))
            })
            .collect()
    }

    const SIG_W: usize = 32;
    const SIG_H: usize = 18;

    /// Every decoded frame of `path`, shrunk to a 32x18 grey signature, in
    /// presentation order — one per frame `frames` lists.
    fn signatures(path: &Path) -> Vec<Vec<u8>> {
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-map", "0:v:0", "-vf", &format!("scale={SIG_W}:{SIG_H}:flags=area,format=gray"),
                "-fps_mode", "passthrough", "-f", "rawvideo", "-",
            ])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        out.stdout.chunks(SIG_W * SIG_H).map(<[u8]>::to_vec).collect()
    }

    fn sad(a: &[u8], b: &[u8]) -> u64 {
        a.iter().zip(b).map(|(x, y)| u64::from(x.abs_diff(*y))).sum()
    }

    struct Alignment {
        frames: usize,
        /// The largest |source time - copy time| over the copy's frames, each
        /// matched to the source frame its PICTURE is (best signature within
        /// half a second), in seconds.
        max_offset: f64,
        first: (f64, f64),
        last: (f64, f64),
    }

    /// The proof: each frame of the copy is matched by its picture to the
    /// source frame it came from, and that frame's time is compared with the
    /// time the copy shows it at.
    fn alignment(src: &Path, copy: &Path) -> Alignment {
        let (sf, cf) = (frames(src), frames(copy));
        let (ss, cs) = (signatures(src), signatures(copy));
        assert_eq!(ss.len(), sf.len(), "one signature per source frame");
        assert_eq!(cs.len(), cf.len(), "one signature per copy frame");
        assert!(cf.iter().all(|f| f.1), "every frame of the copy is a keyframe");
        let mut max_offset: f64 = 0.0;
        for (c, sig) in cf.iter().zip(&cs) {
            let best = sf
                .iter()
                .zip(&ss)
                .filter(|(f, _)| (f.0 - c.0).abs() <= 0.5)
                .min_by_key(|(_, s)| sad(s, sig))
                .expect("a source frame within half a second");
            max_offset = max_offset.max((best.0 .0 - c.0).abs());
        }
        Alignment {
            frames: cf.len(),
            max_offset,
            first: (sf[0].0, cf[0].0),
            last: (sf[sf.len() - 1].0, cf[cf.len() - 1].0),
        }
    }

    /// One copy frame at 30 fps.
    const ONE_FRAME: f64 = 1.0 / 30.0 + 0.0005;

    fn assert_aligned(name: &str, a: &Alignment) {
        eprintln!(
            "{name}: {} copy frames, max picture offset {:.1} ms, first {:.6}/{:.6}, last {:.6}/{:.6}",
            a.frames, a.max_offset * 1000.0, a.first.0, a.first.1, a.last.0, a.last.1
        );
        assert!(a.max_offset <= ONE_FRAME, "{name}: a picture {:.1} ms off its time", a.max_offset * 1000.0);
        assert!((a.first.0 - a.first.1).abs() <= ONE_FRAME, "{name}: first frame {:?}", a.first);
        assert!((a.last.0 - a.last.1).abs() <= ONE_FRAME, "{name}: last frame {:?}", a.last);
    }

    /// An ordinary 30 fps clip with sound (the E2E's fixture): every frame a
    /// keyframe, at most 480 lines, video only, its length within a frame, and
    /// every picture at its source's time — frame for frame, no thinning.
    #[test]
    fn an_ordinary_clip_is_copied_frame_for_frame_in_time() {
        let fixture = repo_fixture("counter_audio_h264.mp4");
        assert!(fixture.exists(), "{} is missing: run `npm run fixtures`", fixture.display());
        let dir = scratch("ordinary");
        let copy = dir.0.join("copy.mp4");
        make_copy(&fixture, &copy);
        let (a, b) = (probe::probe_sync(fixture.to_str().unwrap()).unwrap(), probe::probe_sync(copy.to_str().unwrap()).unwrap());
        assert_eq!((b.width, b.height), (Some(854), Some(480)));
        assert!(!b.has_audio, "video only");
        assert!((a.duration - b.duration).abs() <= ONE_FRAME, "{} vs {}", a.duration, b.duration);
        let al = alignment(&fixture, &copy);
        assert_eq!(al.frames, frames(&fixture).len(), "30 fps: no frame dropped");
        assert_aligned("ordinary", &al);
    }

    /// The re-packed fragmented recording (the shape a fragmented MP4 plays
    /// from: `prepare::remux_args(.., true)`, a leading empty edit, the video
    /// starting after the audio): the copy starts its video exactly as late.
    #[test]
    fn a_repacked_fragmented_recording_keeps_its_late_start() {
        let fixture = repo_fixture("fragmented_h264.mp4");
        assert!(fixture.exists(), "{} is missing: run `npm run fixtures`", fixture.display());
        let dir = scratch("repacked");
        let repacked = dir.0.join("repacked.mp4");
        ffmpeg_ok(&crate::media::prepare::remux_args(&fixture, &repacked, true));
        let src_frames = frames(&repacked);
        assert!(src_frames[0].0 > 0.03, "fixture: the re-packed video starts late ({})", src_frames[0].0);
        let copy = dir.0.join("copy.mp4");
        make_copy(&repacked, &copy);
        let al = alignment(&repacked, &copy);
        assert_eq!(al.frames, src_frames.len());
        assert_aligned("repacked fragmented", &al);
    }

    /// A 60 fps source with B-frames whose streams all start at 0.5 s: thinned
    /// to 30 fps, and still every picture at its source's time — which a copy
    /// made WITHOUT `-copyts` misses by about half a second (checked, so the
    /// fixture can tell the two apart).
    #[test]
    fn a_fast_late_source_is_thinned_and_still_in_time() {
        let dir = scratch("late60");
        let plain = dir.0.join("src60.mp4");
        ffmpeg_ok(&[
            "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=6",
            "-f", "lavfi", "-i", "sine=duration=6",
            "-c:v", "libx264", "-preset", "veryfast", "-bf", "3", "-g", "120", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", plain.to_str().unwrap(),
        ]);
        let late = dir.0.join("late60.mp4");
        ffmpeg_ok(&["-y", "-v", "error", "-itsoffset", "0.5", "-i", plain.to_str().unwrap(), "-c", "copy", late.to_str().unwrap()]);
        let copy = dir.0.join("copy.mp4");
        make_copy(&late, &copy);
        let al = alignment(&late, &copy);
        let src_count = frames(&late).len();
        assert!(al.frames * 2 >= src_count - 2 && al.frames * 2 <= src_count + 2, "thinned to half: {} of {src_count}", al.frames);
        assert_eq!(probe::probe_sync(copy.to_str().unwrap()).unwrap().height, Some(360), "never upscaled");
        assert_aligned("late 60 fps", &al);

        // The same recipe minus -copyts: the copy starts at ~0 where the
        // source starts at 0.5 — the misalignment this recipe exists to avoid.
        let shifted = dir.0.join("shifted.mp4");
        let args: Vec<OsString> = job_args(&late, &shifted).into_iter().filter(|a| a != "-copyts").collect();
        ffmpeg_ok(&args);
        let bad = alignment(&late, &shifted);
        assert!(bad.max_offset > 0.3 || (bad.first.0 - bad.first.1).abs() > 0.3, "without -copyts the fixture must show the shift");
    }

    /// GPU decoding is asked for, and ffmpeg falls back to software decoding
    /// by itself where D3D11VA cannot decode: MPEG-4 Part 2 (no D3D11VA
    /// profile) and 4:4:4 H.264 at an ODD height (no profile either, and the
    /// even-height rule) both make a whole copy.
    #[test]
    fn sources_the_gpu_cannot_decode_still_make_a_copy() {
        let dir = scratch("fallback");
        let xvid = repo_fixture("legacy_xvid.avi");
        assert!(xvid.exists(), "{} is missing: run `npm run fixtures`", xvid.display());
        let odd = dir.0.join("odd 444.mkv");
        ffmpeg_ok(&[
            "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
            "-vf", "scale=321:181", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p",
            odd.to_str().unwrap(),
        ]);
        for (name, src) in [("xvid", xvid.as_path()), ("odd 444", odd.as_path())] {
            let copy = dir.0.join(format!("{name} copy.mp4"));
            make_copy(src, &copy);
            let (sf, cf) = (frames(src), frames(&copy));
            assert_eq!(cf.len(), sf.len(), "{name}: every frame");
            assert!(cf.iter().all(|f| f.1), "{name}: all keyframes");
            let info = probe::probe_sync(copy.to_str().unwrap()).unwrap();
            assert_eq!(info.height.unwrap_or(1) % 2, 0, "{name}: even height");
        }
    }
}
