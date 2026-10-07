//! The playback decision tree: can WebView2 play this file directly, does it
//! need a lossless remux, or a full preview proxy? Plus the `plan_playback`
//! command that consults/populates the cache and spawns preparation jobs.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::error::{AppError, Result};
use crate::jobs::{self, JobId, JobKind, Jobs, Lane};
use crate::media::source::source_file;
use crate::media::{damage, prepare, probe};
use crate::project::schema::MediaRef;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecHints {
    pub hevc: bool,
    pub av1: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Direct,
    Remux { audio_copy_ok: bool },
    Proxy,
    AudioDirect,
    AudioRemux,
    ImageDirect,
    GifProxy,
}

fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Audio codecs Chromium's `<audio>`/`<video>` stack decodes.
fn audio_codec_playable(acodec: Option<&str>) -> bool {
    match acodec {
        None => true,
        Some(a) => {
            matches!(a, "aac" | "mp3" | "opus" | "vorbis" | "flac") || a.starts_with("pcm_")
        }
    }
}

/// Audio codecs that can be stream-copied into an MP4 container.
fn audio_copy_ok_in_mp4(acodec: Option<&str>) -> bool {
    matches!(acodec, None | Some("aac") | Some("mp3"))
}

pub fn decide(media: &MediaRef, hints: CodecHints, force_proxy_large: bool) -> Decision {
    match media.kind.as_str() {
        "audio" => {
            let ext = ext_of(&media.path);
            let container_ok = matches!(ext.as_str(), "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac");
            if container_ok && audio_codec_playable(media.acodec.as_deref()) {
                Decision::AudioDirect
            } else {
                Decision::AudioRemux
            }
        }
        "image" => Decision::ImageDirect,
        "gif" | "imageSeq" => Decision::GifProxy,
        _ => {
            // video
            let bit_depth = media.bit_depth.unwrap_or(8);
            let pix = media.pix_fmt.as_deref().unwrap_or("yuv420p");
            let chroma420 = pix.contains("420");
            let vcodec_ok = match media.vcodec.as_deref() {
                Some("h264") => bit_depth <= 8 && chroma420,
                Some("vp8") | Some("vp9") => true,
                Some("av1") => hints.av1,
                Some("hevc") => hints.hevc,
                _ => false,
            };
            if !vcodec_ok {
                return Decision::Proxy;
            }

            let big = media.width.unwrap_or(0) >= 3800 || media.height.unwrap_or(0) >= 2100;
            if force_proxy_large && big {
                return Decision::Proxy;
            }

            let ext = ext_of(&media.path);
            let container = media.container.as_deref().unwrap_or("");
            let is_webm_family = matches!(media.vcodec.as_deref(), Some("vp8") | Some("vp9") | Some("av1"));
            let container_ok = match ext.as_str() {
                "mp4" | "m4v" => container.contains("mp4"),
                "webm" => is_webm_family,
                _ => false, // mov/mkv/avi/… → remux (fast, lossless)
            };
            let audio_ok = audio_codec_playable(media.acodec.as_deref());

            if container_ok && audio_ok {
                Decision::Direct
            } else {
                Decision::Remux {
                    audio_copy_ok: audio_copy_ok_in_mp4(media.acodec.as_deref()),
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* classify: what the viewer asks before anything starts               */
/* ------------------------------------------------------------------ */

/// How much work stands between a file and playback, coarsened for a caller
/// that decides whether to play at once, remux quietly, or offer a button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackClass {
    Direct,
    /// Only the container is wrong: a stream copy, audio included.
    ContainerOnly,
    /// A remux that must also re-encode the audio (or an audio-only remux).
    Remux,
    Proxy,
}

/// Read straight off `decide()`, so the viewer's verdict and the job
/// `plan_playback` would start can never disagree. The one extra question —
/// is the audio web-playable? — is `decide()`'s own helper, asked the same way
/// it asks it: a `Remux` whose audio plays was a container problem only.
pub fn classify(media: &MediaRef, hints: CodecHints, force_proxy_large: bool) -> PlaybackClass {
    match decide(media, hints, force_proxy_large) {
        Decision::Direct | Decision::AudioDirect | Decision::ImageDirect => PlaybackClass::Direct,
        Decision::Remux { .. } if audio_codec_playable(media.acodec.as_deref()) => {
            PlaybackClass::ContainerOnly
        }
        Decision::Remux { .. } | Decision::AudioRemux => PlaybackClass::Remux,
        Decision::Proxy | Decision::GifProxy => PlaybackClass::Proxy,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackClassInfo {
    pub class: PlaybackClass,
    /// The cache already holds this exact file's remux/proxy, so planning
    /// would answer `Ready` without starting a job. Always false for `Direct`.
    pub prepared: bool,
    /// The cache already holds a full REPAIR copy of this exact file
    /// (`repair_target`): an earlier preview found it undecodable as it is,
    /// so a repair plan would answer `Ready` at once. An instant copy alone
    /// does not count — the full repair is still to come. Only ever true for
    /// a video; says nothing about `class` or `prepared`, which stay what
    /// `decide()` makes them.
    pub repaired: bool,
}

/// The cache file a decision prepares into, or `None` when it plays as-is.
///
/// The ONE table both `plan_playback` (which writes the file) and
/// `classify_playback` (which only looks for it) read, so the two can never
/// name different files — a drift there would report "prepared" for a file
/// nothing writes, or re-prepare one that is sitting in the cache.
fn prepared_target(d: &Decision) -> Option<(CacheKind, &'static str)> {
    match d {
        Decision::Remux { .. } => Some((CacheKind::Remux, ".mp4")),
        Decision::AudioRemux => Some((CacheKind::Remux, ".m4a")),
        Decision::Proxy | Decision::GifProxy => Some((CacheKind::Proxy, ".mp4")),
        Decision::Direct | Decision::AudioDirect | Decision::ImageDirect => None,
    }
}

/// Which copy of a damaged recording a cache file holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepairCopy {
    /// The full repair (`prepare::repair_args`): the whole file decoded by
    /// ffmpeg, which conceals what it cannot read. `drops`: with the in-band
    /// headers removed (`prepare::DROP_INBAND_HEADERS`).
    Full { drops: bool },
    /// The instant copy (`prepare::quick_repair_args`): a lossless stream
    /// copy whose video starts at the first clean keyframe.
    Quick,
}

/// The cache file a REPAIR copy is written to, by its recipe. The key
/// (`MediaKey::hash`) is the source's alone, so each recipe needs a name of
/// its own: the header-free full copy is different bytes from the proxy's
/// `.mp4`; the plain one, though the proxy recipe, is kept apart so that a
/// cached repair means a repair was made — never merely that a proxy exists;
/// and the instant copy, a stream copy like a remux, sits with the remuxes
/// under a name no remux uses.
///
/// The ONE table for repair outputs, as `prepared_target` is for the rest:
/// `plan_sync` writes and looks up through it, `classify_info` and
/// `discard_quick` only look.
///
/// `.repairps.mp4` is RETIRED, never to be named again: an earlier recipe
/// wrote the header-free copy there dropping only SPS/PPS (`7|8`), and kept
/// the display-orientation SEI that turned the real recording's whole repair
/// ~90 degrees. Such copies sit in caches made before the fix, under keys
/// that did not change (the source's own; `cache::RECIPE_VERSION` was not
/// bumped, as that recipe never shipped) — read under the old name they would
/// play turned as "repaired". Under the new name they are misses; Clear cache
/// removes them, as does the LRU trim once the cache is full.
fn repair_target(copy: RepairCopy) -> (CacheKind, &'static str) {
    match copy {
        RepairCopy::Full { drops: true } => (CacheKind::Proxy, ".repairh.mp4"),
        RepairCopy::Full { drops: false } => (CacheKind::Proxy, ".repair.mp4"),
        RepairCopy::Quick => (CacheKind::Remux, ".quick.mp4"),
    }
}

/// A recording: what `decide()`'s video arm handles, and the only kind a
/// repair copy is made of. Audio, stills and GIFs never reach the WebView's
/// video decoder as themselves (a GIF plays its proxy), and a generator has
/// no file at all.
fn is_video(media: &MediaRef) -> bool {
    media.generator.is_none() && !matches!(media.kind.as_str(), "audio" | "image" | "gif" | "imageSeq")
}

/// No job and no ffmpeg, but not free either: the cache lookup takes the
/// index lock, which a trim holds across each delete, and a hit refreshes
/// that file's LRU stamp — which rewrites the whole index.json on the first
/// hit of a run and then every couple of seconds. The viewer asks on every
/// step, so all of it runs on a blocking-pool thread, never on the WebView's
/// UI thread. A hit stamps exactly as `plan_playback`'s own lookup would —
/// the caller asks because it is about to play it.
///
/// The cache is looked up, never required: main.rs runs without one when
/// `%LOCALAPPDATA%` is unusable, and a `State` parameter failed this command
/// before its body ran — so the viewer refused even an MP4 that plays as-is.
/// No cache simply means nothing is prepared. A lookup that could not run
/// answers "not prepared" too: the answer is advisory, and the
/// `plan_playback` that follows looks again.
#[tauri::command]
pub async fn classify_playback(
    app: AppHandle,
    media: MediaRef,
    hints: CodecHints,
    force_proxy_large: bool,
) -> PlaybackClassInfo {
    let cache = app.try_state::<Arc<Cache>>().map(|c| Arc::clone(&c));
    let class = classify(&media, hints, force_proxy_large);
    tauri::async_runtime::spawn_blocking(move || {
        classify_info(cache.as_deref(), &media, hints, force_proxy_large)
    })
    .await
    .unwrap_or(PlaybackClassInfo { class, prepared: false, repaired: false })
}

/// `classify_playback` minus the Tauri handle, so the tests can drive it with
/// and without a cache.
fn classify_info(
    cache: Option<&Cache>,
    media: &MediaRef,
    hints: CodecHints,
    force_proxy_large: bool,
) -> PlaybackClassInfo {
    let class = classify(media, hints, force_proxy_large);
    let prepared = prepared_target(&decide(media, hints, force_proxy_large))
        .zip(cache)
        .is_some_and(|((kind, suffix), cache)| {
            cache.existing_file(kind, &media_key(media).hash(), suffix).is_some()
        });
    // The lookup a repair plan starts with, so the two always agree.
    let repaired = is_video(media) && cache.is_some_and(|cache| cached_full_repair(cache, media).is_some());
    PlaybackClassInfo { class, prepared, repaired }
}

/* ------------------------------------------------------------------ */
/* plan_playback                                                       */
/* ------------------------------------------------------------------ */

/// De-duplicates concurrent preparation jobs per output file.
///
/// ONE map for every preparation output — remuxes, proxies and waveform
/// `.pk`s alike. It is keyed by the absolute output path, so entries of
/// different kinds can never collide. `Clone` shares the map (it is an `Arc`),
/// which is how a job closure gets a handle it can `release` through.
#[derive(Default, Clone)]
pub struct Inflight(pub Arc<Mutex<HashMap<PathBuf, JobId>>>);

impl Inflight {
    /// Claim `output` for a new job unless a LIVE job already holds it;
    /// `Err(existing_id)` means "join that job".
    ///
    /// `allocate` runs ONLY on a miss, and it runs while the lock is held. Both
    /// halves matter: allocating first and dropping the handle on a hit leaks a
    /// job the frontend never sees finish, and releasing the lock between the
    /// lookup and the insert re-opens the exact race this closes.
    ///
    /// A slot whose job has been CANCELED counts as a miss. A canceled job
    /// keeps its slot until its worker runs — for a queued one, until a lane
    /// dequeues it — and handing that id to the next request for the same
    /// file (the viewer stepping back onto it, the editor re-mounting) left
    /// the caller waiting on a job that could only ever report failure. The
    /// new job overwrites the slot; the dead one's own `release` then sees a
    /// different id there and leaves it alone.
    ///
    /// Poison-tolerant for the same reason the cache index is: with
    /// `panic = "abort"` a poisoned map would turn a playback request into a
    /// dead process, and the map holds nothing worth protecting — a stale
    /// entry costs one redundant decode, never a wrong answer.
    pub fn claim<T>(
        &self,
        jobs: &Jobs,
        output: &Path,
        allocate: impl FnOnce() -> (JobId, T),
    ) -> std::result::Result<(JobId, T), JobId> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&existing) = map.get(output) {
            if !jobs.is_canceled(existing) {
                return Err(existing);
            }
        }
        let claimed = allocate();
        map.insert(output.to_path_buf(), claimed.0);
        Ok(claimed)
    }

    /// Free the slot once job `id` has stopped writing — but ONLY if the slot
    /// still names `id`. A canceled job still runs its closure to the end, and
    /// by then a successor may own the slot; removing it unconditionally let a
    /// third request start a duplicate job onto the successor's output.
    pub fn release(&self, output: &Path, id: JobId) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(output) == Some(&id) {
            map.remove(output);
        }
    }
}

/// The partial-output suffix for job `id` preparing into `suffix`.
///
/// Per JOB, not per output: a job canceled while still QUEUED is replaced at
/// once (see `Inflight::claim`), and when a lane finally dequeues it,
/// `fail_job` deletes whatever it named as its output. With one shared
/// `.tmp` that was the successor's half-written file. Every recipe writing to
/// it names its muxer explicitly (`-f mp4` in prepare.rs; the waveform writes
/// its own bytes), so the extension carries no meaning. A tmp orphaned by a
/// crash is deleted by the next launch's startup sweep
/// (`cache::sweep_stale_partials_in_background`: older than that run, so no
/// job of the new run can own it), and until then `Cache::enforce_limit`,
/// which lists every file in each kind dir and dates unindexed ones by mtime,
/// ages it out LRU like any entry.
pub(crate) fn job_tmp_suffix(suffix: &str, id: JobId) -> String {
    format!("{suffix}.{id}.tmp")
}

/// `rename_all` on an enum renames only the VARIANT tags; the fields inside a
/// struct variant need `rename_all_fields`, or `job_id` reaches the webview as
/// `job_id` while it reads `jobId` — and every job it started was registered
/// under `undefined`, so no progress/done/failed event ever matched it.
///
/// `repair` and `upgrade` are skipped when absent, so every plan that names
/// no repair copy reaches the webview byte-for-byte as it always did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "mode")]
pub enum PlaybackPlan {
    /// Play the original file directly.
    Direct { path: String },
    /// A prepared file already exists in the cache.
    Ready {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        repair: Option<RepairNote>,
        #[serde(skip_serializing_if = "Option::is_none")]
        upgrade: Option<UpgradeJob>,
    },
    /// Preparation is running; listen for job events.
    Pending {
        job_id: JobId,
        output: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        repair: Option<RepairNote>,
        #[serde(skip_serializing_if = "Option::is_none")]
        upgrade: Option<UpgradeJob>,
    },
}

/// Present on a plan only when it names a REPAIR copy: the preview of a file
/// the WebView's own decoder refused (it stops a whole file at the first
/// undecodable frame; ffmpeg conceals and carries on). Mirror of `RepairNote`
/// in src/core/ipc.ts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairNote {
    /// The full repair decodes the file with its in-band H.264 SPS/PPS/SEI
    /// removed (`prepare::DROP_INBAND_HEADERS`) — what the editor records as
    /// `MediaRef.drop_inband_headers` for export.
    pub drops_headers: bool,
    /// SOURCE seconds from 0 the file cannot be read for: the damaged prefix
    /// `damage::scan_damaged_prefix` found, ending at the first keyframe after
    /// which every frame is sound. Absent when it found none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damaged_until: Option<f64>,
    /// This plan names the INSTANT copy (`RepairCopy::Quick`); the full
    /// repair is the plan's `upgrade`. Only ever `Some(true)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick: Option<bool>,
}

/// The full repair running behind an instant copy: its job events arrive
/// under `job_id`, and its `job:done` names `output`, the copy that
/// supersedes the instant one. Mirror of `UpgradeJob` in src/core/ipc.ts.
/// Renamed on its own: the enum's `rename_all_fields` renames the variant's
/// fields, never the fields of a struct inside one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeJob {
    pub job_id: JobId,
    pub output: String,
}

/// The lane a preparation job runs on. A proxy (a GIF's included) is a full
/// re-encode — minutes on a slow CPU — so it runs on its own one-worker
/// `Transcode` lane; on `Background` two of them held both workers, and every
/// quick remux and waveform queued behind them (the viewer stepping onto an
/// MKV waited for someone else's proxy to finish). Remuxes stay on
/// `Background`. The cost: proxies now run one at a time.
fn lane_for(kind: JobKind) -> Lane {
    match kind {
        JobKind::Proxy => Lane::Transcode,
        JobKind::Remux | JobKind::Waveform => Lane::Background,
        // Never prepared here; answered truthfully all the same.
        JobKind::Export => Lane::Export,
    }
}

fn media_key(media: &MediaRef) -> MediaKey {
    MediaKey {
        path: media.path.clone(),
        size: media.size,
        mtime_ms: media.mtime_ms,
    }
}

#[allow(clippy::too_many_arguments)]
fn ensure_prepared(
    app: &AppHandle,
    jobs: &Arc<Jobs>,
    cache: &Arc<Cache>,
    inflight: &Inflight,
    media: &MediaRef,
    cache_kind: CacheKind,
    job_kind: JobKind,
    suffix: &str,
    args_for: impl FnOnce(&std::path::Path, &std::path::Path) -> Vec<std::ffi::OsString>,
) -> Result<PlaybackPlan> {
    let hash = media_key(media).hash();
    if let Some(ready) = cache.existing_file(cache_kind, &hash, suffix) {
        return Ok(PlaybackPlan::Ready {
            path: ready.to_string_lossy().into_owned(),
            repair: None,
            upgrade: None,
        });
    }

    // A miss means ffmpeg will open the source, and the path is the `.trt`'s:
    // refused unless it names a real file (`media::source`). Checked after the
    // lookup, so an offline file still plays the copy it already has.
    let src = source_file(&media.path)?;
    cache.ensure_kind_dir(cache_kind)?;
    let final_path = cache.file_path(cache_kind, &hash, suffix);

    let handle = match inflight.claim(jobs, &final_path, || {
        let h = jobs.allocate(job_kind);
        (h.id, h)
    }) {
        Ok((_, handle)) => handle,
        Err(existing) => {
            return Ok(PlaybackPlan::Pending {
                job_id: existing,
                output: final_path.to_string_lossy().into_owned(),
                repair: None,
                upgrade: None,
            })
        }
    };
    // Named only now that the job id exists — see `job_tmp_suffix`.
    let tmp_path = cache.file_path(cache_kind, &hash, &job_tmp_suffix(suffix, handle.id));

    let args = args_for(src, &tmp_path);
    let total = if media.duration > 0.0 { Some(media.duration) } else { None };

    let app = app.clone();
    let jobs_arc = Arc::clone(jobs);
    let cache_arc = Arc::clone(cache);
    let inflight_arc = Inflight::clone(inflight);
    let final_for_job = final_path.clone();
    let job_handle = handle.clone();

    jobs.submit(
        lane_for(job_kind),
        Box::new(move || {
            job_handle.set_output(tmp_path.clone());
            let result = jobs::execute_ffmpeg(&app, &job_handle, args, total, None);
            // The slot is freed only once the output is where it belongs (or
            // the job has failed). Freed before the rename, a request arriving
            // in between found neither the slot nor the final file, and
            // started a second full job onto the same output.
            match result {
                Ok(()) => {
                    let renamed = std::fs::rename(&tmp_path, &final_for_job);
                    inflight_arc.release(&final_for_job, job_handle.id);
                    if let Err(e) = renamed {
                        jobs::fail_job(
                            &app,
                            &jobs_arc,
                            &job_handle,
                            format!("finalize failed: {e}"),
                            Vec::new(),
                        );
                        return;
                    }
                    cache_arc.mark_used(&final_for_job);
                    jobs::complete_job(
                        &app,
                        &jobs_arc,
                        &job_handle,
                        serde_json::json!({ "path": final_for_job.to_string_lossy() }),
                    );
                }
                Err(failure) => {
                    inflight_arc.release(&final_for_job, job_handle.id);
                    jobs::fail_job(&app, &jobs_arc, &job_handle, failure.message, failure.log_tail);
                }
            }
        }),
    );

    Ok(PlaybackPlan::Pending {
        job_id: handle.id,
        output: final_path.to_string_lossy().into_owned(),
        repair: None,
        upgrade: None,
    })
}

/// The cache is looked up, never required (see `classify_playback`). With
/// none there is nowhere to prepare into, so the original is handed over as
/// it is: a file the webview can play still plays, and one it cannot fails
/// in the player like any undecodable file, instead of the command failing
/// before it runs.
///
/// Async, with the work on a blocking-pool thread: a cache hit refreshes the
/// LRU index, which writes it to disk on an interval, and the source check
/// stats a path that may be on a sleeping network share — neither belongs on
/// the WebView's UI thread. Concurrent plans for one file are already
/// serialized where it matters, by `Inflight::claim`.
///
/// `repair`: plan the REPAIR copies instead (`plan_repair`) — asked for a
/// video the WebView refused with a decode error on the file it was handed.
/// Absent (every caller before it existed) is `false`.
#[tauri::command]
pub async fn plan_playback(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    inflight: State<'_, Inflight>,
    media: MediaRef,
    hints: CodecHints,
    force_proxy_large: bool,
    repair: Option<bool>,
) -> Result<PlaybackPlan> {
    let (jobs, inflight) = (Arc::clone(&jobs), Inflight::clone(&inflight));
    tauri::async_runtime::spawn_blocking(move || {
        plan_sync(&app, &jobs, &inflight, &media, hints, force_proxy_large, repair)
    })
    .await
    .map_err(|e| AppError::Ffmpeg(format!("playback planning stopped unexpectedly: {e}")))?
}

/// The original file as the answer — only once it is known to BE a file. The
/// path comes out of a `.trt`, and "play it directly" hands it to the player
/// as it is, so a URL or a device path is refused here rather than answered.
fn direct(media: &MediaRef) -> Result<PlaybackPlan> {
    source_file(&media.path)?;
    Ok(PlaybackPlan::Direct {
        path: media.path.clone(),
    })
}

fn plan_sync(
    app: &AppHandle,
    jobs: &Arc<Jobs>,
    inflight: &Inflight,
    media: &MediaRef,
    hints: CodecHints,
    force_proxy_large: bool,
    repair: Option<bool>,
) -> Result<PlaybackPlan> {
    if wants_repair(media, repair) {
        let Some(cache) = app.try_state::<Arc<Cache>>() else {
            return direct(media);
        };
        let mut steps = LiveRepair { app, jobs, cache: &cache, inflight, media };
        return plan_repair(&cache, media, &SCANNED, &mut steps);
    }
    let decision = decide(media, hints, force_proxy_large);
    // Where the output lives comes from `prepared_target` alone, the table
    // `classify_playback` reads; each arm below only picks the recipe.
    let Some((cache_kind, suffix)) = prepared_target(&decision) else {
        return direct(media);
    };
    let Some(cache) = app.try_state::<Arc<Cache>>() else {
        return direct(media);
    };
    match decision {
        Decision::Remux { audio_copy_ok } => ensure_prepared(
            app, jobs, &cache, inflight, media,
            cache_kind, JobKind::Remux, suffix,
            move |src, dst| prepare::remux_args(src, dst, audio_copy_ok),
        ),
        Decision::AudioRemux => ensure_prepared(
            app, jobs, &cache, inflight, media,
            cache_kind, JobKind::Remux, suffix,
            prepare::audio_remux_args,
        ),
        Decision::Proxy => ensure_prepared(
            app, jobs, &cache, inflight, media,
            cache_kind, JobKind::Proxy, suffix,
            prepare::proxy_args,
        ),
        Decision::GifProxy => ensure_prepared(
            app, jobs, &cache, inflight, media,
            cache_kind, JobKind::Proxy, suffix,
            prepare::gif_proxy_args,
        ),
        // `prepared_target` names no file for these, so the early return above
        // already answered; kept total rather than `unreachable!()` because a
        // panic here would abort the whole app.
        Decision::Direct | Decision::AudioDirect | Decision::ImageDirect => direct(media),
    }
}

/// Whether a plan goes to the repair copy: a video, when the caller asks
/// (`repair`: the WebView refused the file it was handed) or when its media
/// entry already records that it needs one (`drop_inband_headers`, stamped by
/// an earlier repair). Anything else — every healthy file — plans exactly as
/// it always did.
fn wants_repair(media: &MediaRef, repair: Option<bool>) -> bool {
    is_video(media) && (repair == Some(true) || media.drop_inband_headers == Some(true))
}

/// The full repair copy of this exact file already in the cache, and whether
/// it dropped the in-band headers. The header-free copy first: it is only
/// made of a file the filter is safe for, and it was decoded with the
/// header's parameter sets where a plain copy believed the in-band ones.
fn cached_full_repair(cache: &Cache, media: &MediaRef) -> Option<(String, bool)> {
    let hash = media_key(media).hash();
    [true, false].into_iter().find_map(|drops| {
        let (kind, suffix) = repair_target(RepairCopy::Full { drops });
        cache
            .existing_file(kind, &hash, suffix)
            .map(|ready| (ready.to_string_lossy().into_owned(), drops))
    })
}

/// Delete the instant copy of `media`: once the full repair exists it is
/// never planned again, and it is a whole stream copy (~400 MB for three
/// minutes of 1080p60). Best effort, and never while a job is still writing
/// it — checked and deleted under the inflight lock, so no job can claim it
/// in between. The LRU stamp it leaves is harmless (a trim counts an entry
/// already gone as freed).
fn discard_quick(cache: &Cache, inflight: &Inflight, media: &MediaRef) {
    let (kind, suffix) = repair_target(RepairCopy::Quick);
    let path = cache.file_path(kind, &media_key(media).hash(), suffix);
    let held = inflight.0.lock().unwrap_or_else(|e| e.into_inner());
    if !held.contains_key(&path) {
        let _ = std::fs::remove_file(&path);
    }
}

/// What a repair plan does beyond its own decisions — the header probe, the
/// damage scan, starting (or joining) the two jobs, deleting a superseded
/// instant copy — so the tests drive `plan_repair` without a Tauri handle, an
/// ffprobe or a real recording. `LiveRepair` is the real thing.
trait RepairSteps {
    /// `probe::h264_param_sets_in_header`.
    fn header_has_param_sets(&mut self, src: &Path) -> bool;
    /// `damage::scan_damaged_prefix`.
    fn damaged_prefix(&mut self, src: &Path) -> Option<f64>;
    /// Start or join the full repair into `RepairCopy::Full { drops }`.
    fn start_full(&mut self, drops: bool) -> Result<PlaybackPlan>;
    /// Start or join the instant copy, its video from `from` seconds.
    fn start_quick(&mut self, from: f64) -> Result<PlaybackPlan>;
    /// `discard_quick`.
    fn discard_quick(&mut self);
}

/// `RepairSteps` for real: the header probe, the damage scan, and the two
/// jobs through `ensure_prepared`.
struct LiveRepair<'a> {
    app: &'a AppHandle,
    jobs: &'a Arc<Jobs>,
    cache: &'a Arc<Cache>,
    inflight: &'a Inflight,
    media: &'a MediaRef,
}

impl RepairSteps for LiveRepair<'_> {
    fn header_has_param_sets(&mut self, src: &Path) -> bool {
        probe::h264_param_sets_in_header(src)
    }

    fn damaged_prefix(&mut self, src: &Path) -> Option<f64> {
        damage::scan_damaged_prefix(src)
    }

    fn start_full(&mut self, drops: bool) -> Result<PlaybackPlan> {
        // A proxy-shaped job: a full re-encode, on the proxies' own lane, at
        // below-normal priority like every job (`jobs::job_command`).
        let (cache_kind, suffix) = repair_target(RepairCopy::Full { drops });
        ensure_prepared(
            self.app, self.jobs, self.cache, self.inflight, self.media,
            cache_kind, JobKind::Proxy, suffix,
            move |src, dst| prepare::repair_args(src, dst, drops),
        )
    }

    fn start_quick(&mut self, from: f64) -> Result<PlaybackPlan> {
        // A stream copy, seconds at most: on the remuxes' lane, so it never
        // queues behind the full repair it stands in for.
        let (cache_kind, suffix) = repair_target(RepairCopy::Quick);
        ensure_prepared(
            self.app, self.jobs, self.cache, self.inflight, self.media,
            cache_kind, JobKind::Remux, suffix,
            move |src, dst| prepare::quick_repair_args(src, dst, from),
        )
    }

    fn discard_quick(&mut self) {
        discard_quick(self.cache, self.inflight, self.media);
    }
}

/// What `damage::scan_damaged_prefix` answered for a source, held in memory
/// by its cache key (`MediaKey::hash`: path, size, mtime) for the rest of
/// the run. A repaired file's plan asks for the damaged span every time —
/// every viewer step onto it, every editor mount — and the scan reads the
/// first bytes of every frame: ~20 ms warm, ~270 ms cold on NVMe for three
/// minutes of 60 fps, unmeasured (plausibly seconds) on a spinning disk,
/// where the answer used to be instant. The answer is a fact of the file's
/// bytes, and the key names them: a rewritten file has another size or mtime
/// and is scanned afresh.
///
/// `None` is remembered too: "no damaged prefix" costs as much to find. So is
/// a read that failed mid-scan, which also answers `None` — that file keeps
/// it until the app restarts, and its copy plays all the same, only without
/// the damaged span.
///
/// Bounded to the `SCAN_MEMO_LEN` files asked about most recently, the least
/// recent dropped first: a few kilobytes at most. Poison-tolerant like
/// `Inflight`: with `panic = "abort"` a poisoned lock would end a playback
/// request, and a lost answer only costs one more scan.
struct ScanMemo(Mutex<VecDeque<(String, Option<f64>)>>);

const SCAN_MEMO_LEN: usize = 64;

/// The run's one memo, which `plan_sync` hands every repair plan. Tests hand
/// `plan_repair` memos of their own, so no test answers from another's scan.
static SCANNED: ScanMemo = ScanMemo::new();

impl ScanMemo {
    const fn new() -> Self {
        ScanMemo(Mutex::new(VecDeque::new()))
    }

    /// The answer remembered for `key`, or `scan`'s, which is then
    /// remembered. The lock is not held across the scan — cold it takes a
    /// good part of a second, and every other plan would wait on it — so two
    /// plans of one file at the same moment may both scan; the later answer
    /// (the same) replaces the earlier.
    fn answer(&self, key: String, scan: impl FnOnce() -> Option<f64>) -> Option<f64> {
        {
            let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(at) = held.iter().position(|(k, _)| *k == key) {
                if let Some(entry) = held.remove(at) {
                    let answer = entry.1;
                    // Asked again: the most recent, dropped last.
                    held.push_back(entry);
                    return answer;
                }
            }
        }
        let answer = scan();
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|(k, _)| *k != key);
        while held.len() >= SCAN_MEMO_LEN {
            held.pop_front();
        }
        held.push_back((key, answer));
        answer
    }
}

/// `steps.damaged_prefix(src)` for `media`, unless `scans` already holds
/// this exact file's answer (`ScanMemo`).
fn damaged_prefix(scans: &ScanMemo, media: &MediaRef, src: &Path, steps: &mut impl RepairSteps) -> Option<f64> {
    scans.answer(media_key(media).hash(), || steps.damaged_prefix(src))
}

/// The repair plan: two stages for a file whose damage is a prefix, one for
/// anything else.
///
/// A full copy already cached answers at once — no source check, no probe,
/// no job, like `ensure_prepared`'s own lookup, so an offline file still
/// plays the copy it has. It still says how long the damaged part is, when
/// the source can be read (`damage::scan_damaged_prefix`: the tables and a
/// few bytes per frame — ~20 ms for three minutes of 60 fps), once per file
/// per run: later plans answer from `scans` (`ScanMemo`), as do repeat plans
/// on a miss. And the instant copy it superseded is deleted.
///
/// Otherwise the source must be a real file (`media::source`), and the full
/// recipe is chosen: the in-band headers are dropped only from H.264 — the
/// filter names H.264 NAL types, and in HEVC types 6-8 are real slices, so a
/// copy would lose frames — which is the export's own rule
/// (`export::builder`), so the preview and the export never disagree. From
/// H.264 they are dropped when the media entry says so, or else when the
/// header carries its own parameter sets (`probe::h264_param_sets_in_header`,
/// asked only then — one ffprobe, once per repair, never on the normal path).
///
/// The full repair starts FIRST — the long one, minutes on a slow PC — then
/// the scan looks for a damaged prefix (H.264 only). Found, the instant copy
/// starts too and is the answer, noted `quick` with the damaged span, the
/// full repair as its `upgrade`: it plays within a second or so. Not found,
/// the full repair is the answer. A full repair already finished (another
/// plan made it meanwhile) is the answer however the scan came out. An
/// instant copy that cannot start does not fail the plan: the full repair is
/// running, and is answered with the damaged span.
fn plan_repair(
    cache: &Cache,
    media: &MediaRef,
    scans: &ScanMemo,
    steps: &mut impl RepairSteps,
) -> Result<PlaybackPlan> {
    let h264 = media.vcodec.as_deref() == Some("h264");
    if let Some((path, drops)) = cached_full_repair(cache, media) {
        // Never a failure for an offline source: the copy plays without it.
        let damaged_until = if h264 {
            source_file(&media.path).ok().and_then(|src| damaged_prefix(scans, media, src, steps))
        } else {
            None
        };
        steps.discard_quick();
        let repair = RepairNote { drops_headers: drops, damaged_until, quick: None };
        return Ok(PlaybackPlan::Ready { path, repair: Some(repair), upgrade: None });
    }
    let src = source_file(&media.path)?;
    // The flag before the probe: a flagged file needs no ffprobe to answer.
    let drops = h264 && (media.drop_inband_headers == Some(true) || steps.header_has_param_sets(src));
    let full = steps.start_full(drops)?;
    let damaged_until = if h264 { damaged_prefix(scans, media, src, steps) } else { None };
    let note = RepairNote { drops_headers: drops, damaged_until, quick: None };
    let upgrade = match full {
        PlaybackPlan::Ready { path, .. } => {
            steps.discard_quick();
            return Ok(PlaybackPlan::Ready { path, repair: Some(note), upgrade: None });
        }
        PlaybackPlan::Pending { job_id, output, .. } => UpgradeJob { job_id, output },
        // `ensure_prepared` answers only Ready or Pending.
        other => return Ok(other),
    };
    let quick_note = RepairNote { quick: Some(true), ..note };
    Ok(match damaged_until.map(|from| steps.start_quick(from)) {
        Some(Ok(PlaybackPlan::Ready { path, .. })) => {
            PlaybackPlan::Ready { path, repair: Some(quick_note), upgrade: Some(upgrade) }
        }
        Some(Ok(PlaybackPlan::Pending { job_id, output, .. })) => {
            PlaybackPlan::Pending { job_id, output, repair: Some(quick_note), upgrade: Some(upgrade) }
        }
        // No damaged prefix, or no instant copy: the full repair alone.
        _ => PlaybackPlan::Pending {
            job_id: upgrade.job_id,
            output: upgrade.output,
            repair: Some(note),
            upgrade: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The webview reads these by their camelCase names (src/core/ipc.ts
    /// `PlaybackPlan`, `WaveformResult`). Pinned on the WIRE: no Rust type
    /// check can see a field the JS side reads as `undefined`, and that is
    /// exactly how every editor job went unheard.
    #[test]
    fn job_results_reach_the_webview_in_camel_case() {
        use serde_json::json;
        let wire = |v: serde_json::Result<serde_json::Value>| v.expect("serializes");
        // No repair copy: the exact shapes every caller has always read, with
        // no `repair` or `upgrade` key at all (not even `null`).
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Pending { job_id: 7, output: "o".into(), repair: None, upgrade: None })),
            json!({ "mode": "pending", "jobId": 7, "output": "o" })
        );
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Ready { path: "r".into(), repair: None, upgrade: None })),
            json!({ "mode": "ready", "path": "r" })
        );
        // A full repair copy: the note alone, camelCase, with no key for what
        // it does not say. The two values differ so a note serialized from the
        // wrong variant shows.
        let full = |drops| RepairNote { drops_headers: drops, damaged_until: None, quick: None };
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Pending { job_id: 5, output: "p".into(), repair: Some(full(true)), upgrade: None })),
            json!({ "mode": "pending", "jobId": 5, "output": "p", "repair": { "dropsHeaders": true } })
        );
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Ready { path: "q".into(), repair: Some(full(false)), upgrade: None })),
            json!({ "mode": "ready", "path": "q", "repair": { "dropsHeaders": false } })
        );
        // The instant copy: its note says how far the damage runs and that it
        // is the quick one, and the full repair rides along as `upgrade` —
        // whose own fields are camelCase too (`rename_all_fields` does not
        // reach inside it). Two job ids, two outputs, so neither can stand in
        // for the other.
        let quick = RepairNote { drops_headers: true, damaged_until: Some(60.499), quick: Some(true) };
        let upgrade = || Some(UpgradeJob { job_id: 11, output: "f".into() });
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Pending { job_id: 12, output: "q".into(), repair: Some(quick), upgrade: upgrade() })),
            json!({
                "mode": "pending", "jobId": 12, "output": "q",
                "repair": { "dropsHeaders": true, "damagedUntil": 60.499, "quick": true },
                "upgrade": { "jobId": 11, "output": "f" }
            })
        );
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Ready { path: "c".into(), repair: Some(quick), upgrade: upgrade() })),
            json!({
                "mode": "ready", "path": "c",
                "repair": { "dropsHeaders": true, "damagedUntil": 60.499, "quick": true },
                "upgrade": { "jobId": 11, "output": "f" }
            })
        );
        // A full copy of a file whose damage was measured: the span, no `quick`.
        let measured = RepairNote { drops_headers: false, damaged_until: Some(2.5), quick: None };
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Ready { path: "m".into(), repair: Some(measured), upgrade: None })),
            json!({ "mode": "ready", "path": "m", "repair": { "dropsHeaders": false, "damagedUntil": 2.5 } })
        );
        assert_eq!(
            wire(serde_json::to_value(crate::media::waveform::WaveformResult::Pending {
                job_id: 8,
                output: "w".into()
            })),
            json!({ "state": "pending", "jobId": 8, "output": "w" })
        );
    }

    fn media(kind: &str, path: &str) -> MediaRef {
        MediaRef {
            id: "m".into(),
            path: path.into(),
            size: 1,
            mtime_ms: 1,
            kind: kind.into(),
            duration: 10.0,
            fps: None,
            width: Some(1920),
            height: Some(1080),
            container: None,
            vcodec: None,
            acodec: None,
            pix_fmt: None,
            bit_depth: None,
            has_audio: false,
            audio_rate: None,
            audio_channels: None,
            generator: None,
            no_autorotate: None,
            drop_inband_headers: None,
        }
    }

    const NO_HINTS: CodecHints = CodecHints { hevc: false, av1: true };

    #[test]
    fn h264_mp4_plays_directly() {
        let mut m = media("video", r"C:\v\a.mp4");
        m.container = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
        m.vcodec = Some("h264".into());
        m.acodec = Some("aac".into());
        m.pix_fmt = Some("yuv420p".into());
        m.bit_depth = Some(8);
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Direct);
    }

    #[test]
    fn h264_mkv_remuxes_with_audio_copy() {
        let mut m = media("video", r"C:\v\a.mkv");
        m.container = Some("matroska,webm".into());
        m.vcodec = Some("h264".into());
        m.acodec = Some("aac".into());
        m.pix_fmt = Some("yuv420p".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Remux { audio_copy_ok: true });
    }

    #[test]
    fn h264_avi_with_pcm_remuxes_and_transcodes_audio() {
        let mut m = media("video", r"C:\v\a.avi");
        m.container = Some("avi".into());
        m.vcodec = Some("h264".into());
        m.acodec = Some("pcm_s16le".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Remux { audio_copy_ok: false });
    }

    #[test]
    fn hevc_without_extension_proxies_with_it_remuxes() {
        let mut m = media("video", r"C:\v\a.mkv");
        m.container = Some("matroska,webm".into());
        m.vcodec = Some("hevc".into());
        m.acodec = Some("aac".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Proxy);
        let with_hevc = CodecHints { hevc: true, av1: true };
        assert_eq!(decide(&m, with_hevc, false), Decision::Remux { audio_copy_ok: true });
    }

    #[test]
    fn ten_bit_h264_proxies() {
        let mut m = media("video", r"C:\v\a.mp4");
        m.container = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
        m.vcodec = Some("h264".into());
        m.pix_fmt = Some("yuv420p10le".into());
        m.bit_depth = Some(10);
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Proxy);
    }

    #[test]
    fn webm_vp9_direct_mkv_vp9_remuxes() {
        let mut m = media("video", r"C:\v\a.webm");
        m.container = Some("matroska,webm".into());
        m.vcodec = Some("vp9".into());
        m.acodec = Some("opus".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Direct);
        m.path = r"C:\v\a.mkv".into();
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Remux { audio_copy_ok: false });
    }

    #[test]
    fn mov_h264_remuxes_losslessly() {
        let mut m = media("video", r"C:\v\clip.mov");
        m.container = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
        m.vcodec = Some("h264".into());
        m.acodec = Some("aac".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Remux { audio_copy_ok: true });
    }

    #[test]
    fn force_proxy_for_4k_when_enabled() {
        let mut m = media("video", r"C:\v\a.mp4");
        m.container = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
        m.vcodec = Some("h264".into());
        m.width = Some(3840);
        m.height = Some(2160);
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Direct);
        assert_eq!(decide(&m, NO_HINTS, true), Decision::Proxy);
    }

    #[test]
    fn audio_files() {
        let mut m = media("audio", r"C:\a\song.mp3");
        m.acodec = Some("mp3".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::AudioDirect);
        let mut alac = media("audio", r"C:\a\song.m4a");
        alac.acodec = Some("alac".into());
        assert_eq!(decide(&alac, NO_HINTS, false), Decision::AudioRemux);
    }

    #[test]
    fn gif_gets_a_proxy_image_is_direct() {
        assert_eq!(decide(&media("gif", r"C:\a\anim.gif"), NO_HINTS, false), Decision::GifProxy);
        assert_eq!(decide(&media("image", r"C:\a\p.png"), NO_HINTS, false), Decision::ImageDirect);
    }

    #[test]
    fn prores_proxies() {
        let mut m = media("video", r"C:\v\a.mov");
        m.vcodec = Some("prores".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Proxy);
    }

    /// One row per `Decision` (4K twice: forced and not), each built so the
    /// codec, container, audio and size all differ from its neighbours. The
    /// `decide()` column proves the table really reaches every variant, so a
    /// later edit to `decide()` that stops a row landing where it claims fails
    /// here rather than silently turning the row into a duplicate.
    ///
    /// The mkv pair differs ONLY in its audio codec: aac plays in the webview
    /// (just the container is wrong → ContainerOnly), ac3 does not (→ Remux).
    /// Dropping the audio check in `classify` flips exactly that one row.
    #[test]
    fn classify_matches_decide_for_every_decision() {
        let rows = decision_table();
        let mut seen = std::collections::HashSet::new();
        for (name, m, hints, force, decision, class) in &rows {
            assert_eq!(decide(m, *hints, *force), *decision, "{name}: decide()");
            assert_eq!(classify(m, *hints, *force), *class, "{name}: classify()");
            seen.insert(std::mem::discriminant(decision));
        }
        assert_eq!(seen.len(), 7, "the table must reach every Decision variant");
    }

    /// The rows of `classify_matches_decide_for_every_decision`, shared with
    /// the repair tests that must leave every one of them unchanged.
    fn decision_table() -> Vec<(&'static str, MediaRef, CodecHints, bool, Decision, PlaybackClass)> {
        fn v(path: &str, container: &str, vcodec: &str, acodec: Option<&str>, w: u32, h: u32) -> MediaRef {
            let mut m = media("video", path);
            m.container = Some(container.into());
            m.vcodec = Some(vcodec.into());
            m.acodec = acodec.map(Into::into);
            m.has_audio = acodec.is_some();
            m.pix_fmt = Some("yuv420p".into());
            m.bit_depth = Some(8);
            m.width = Some(w);
            m.height = Some(h);
            m
        }
        fn a(path: &str, acodec: &str) -> MediaRef {
            let mut m = media("audio", path);
            m.acodec = Some(acodec.into());
            m.has_audio = true;
            m.width = None;
            m.height = None;
            m
        }
        const MP4: &str = "mov,mp4,m4a,3gp,3g2,mj2";
        const MKV: &str = "matroska,webm";
        let hevc_off = CodecHints { hevc: false, av1: false };
        let hevc_on = CodecHints { hevc: true, av1: false };

        let mut gif = media("gif", r"C:\g\loop.gif");
        gif.width = Some(480);
        gif.height = Some(270);
        let mut png = media("image", r"C:\p\shot.png");
        png.width = Some(3024);
        png.height = Some(4032);

        vec![
            ("h264 aac mp4", v(r"C:\v\a.mp4", MP4, "h264", Some("aac"), 1280, 720),
                hevc_on, false, Decision::Direct, PlaybackClass::Direct),
            ("h264 aac mkv", v(r"C:\v\b.mkv", MKV, "h264", Some("aac"), 1920, 1080),
                hevc_off, false, Decision::Remux { audio_copy_ok: true }, PlaybackClass::ContainerOnly),
            ("h264 ac3 mkv", v(r"C:\v\b.mkv", MKV, "h264", Some("ac3"), 1920, 1080),
                hevc_off, false, Decision::Remux { audio_copy_ok: false }, PlaybackClass::Remux),
            ("silent h264 mov", v(r"C:\v\c.mov", MP4, "h264", None, 720, 1280),
                hevc_on, true, Decision::Remux { audio_copy_ok: true }, PlaybackClass::ContainerOnly),
            ("mp3", a(r"C:\a\song.mp3", "mp3"),
                hevc_off, true, Decision::AudioDirect, PlaybackClass::Direct),
            ("alac in m4a", a(r"C:\a\song.m4a", "alac"),
                hevc_on, false, Decision::AudioRemux, PlaybackClass::Remux),
            ("hevc without the extension", v(r"C:\v\d.mp4", MP4, "hevc", Some("aac"), 2560, 1440),
                hevc_off, false, Decision::Proxy, PlaybackClass::Proxy),
            ("4K h264, large forced", v(r"C:\v\e.mp4", MP4, "h264", Some("opus"), 3840, 2160),
                hevc_off, true, Decision::Proxy, PlaybackClass::Proxy),
            ("4K h264, large allowed", v(r"C:\v\e.mp4", MP4, "h264", Some("opus"), 3840, 2160),
                hevc_off, false, Decision::Direct, PlaybackClass::Direct),
            ("gif", gif, hevc_on, true, Decision::GifProxy, PlaybackClass::Proxy),
            ("png", png, hevc_off, true, Decision::ImageDirect, PlaybackClass::Direct),
        ]
    }

    /// The pre-refactor `plan_playback` arms wrote these files, pinned as
    /// literals: an edit to `prepared_target` that renames any of them would
    /// orphan every cache entry of that kind and has to fail here first.
    #[test]
    fn prepared_target_names_the_same_file_plan_playback_writes() {
        let table = [
            (Decision::Remux { audio_copy_ok: true }, Some((CacheKind::Remux, ".mp4"))),
            (Decision::Remux { audio_copy_ok: false }, Some((CacheKind::Remux, ".mp4"))),
            (Decision::AudioRemux, Some((CacheKind::Remux, ".m4a"))),
            (Decision::Proxy, Some((CacheKind::Proxy, ".mp4"))),
            (Decision::GifProxy, Some((CacheKind::Proxy, ".mp4"))),
            (Decision::Direct, None),
            (Decision::AudioDirect, None),
            (Decision::ImageDirect, None),
        ];
        for (d, want) in table {
            assert_eq!(prepared_target(&d), want, "{d:?}");
        }
    }

    /// The serialized names are the frontend's `PlaybackClass` union (ipc.ts).
    #[test]
    fn playback_class_serializes_as_the_frontend_union() {
        let names: Vec<String> = [
            PlaybackClass::Direct,
            PlaybackClass::ContainerOnly,
            PlaybackClass::Remux,
            PlaybackClass::Proxy,
        ]
        .iter()
        .map(|c| serde_json::to_string(c).unwrap())
        .collect();
        assert_eq!(names, [r#""direct""#, r#""containerOnly""#, r#""remux""#, r#""proxy""#]);
        let info = serde_json::to_value(PlaybackClassInfo {
            class: PlaybackClass::ContainerOnly,
            prepared: true,
            repaired: false,
        })
        .unwrap();
        assert_eq!(
            info,
            serde_json::json!({ "class": "containerOnly", "prepared": true, "repaired": false })
        );
    }

    /// A live job is joined; a CANCELED one is replaced, not handed out again.
    /// The ids come from the real registry, so `is_canceled` is exercised for
    /// real, and the replacement's id must differ from the dead one's.
    #[test]
    fn claim_joins_a_live_job_but_replaces_a_canceled_one() {
        let jobs = Jobs::default();
        let inflight = Inflight::default();
        let out = PathBuf::from(r"C:\cache\remux\0badc0ffee123456.mp4");
        // Lazy, as the real call sites are: a joined request allocates nothing.
        let alloc = |kind| {
            let jobs = &jobs;
            move || {
                let h = jobs.allocate(kind);
                (h.id, h)
            }
        };

        let (first, _h1) = inflight.claim(&jobs, &out, alloc(JobKind::Remux)).expect("free slot");
        // A second plan while the first is live joins it.
        assert_eq!(inflight.claim(&jobs, &out, alloc(JobKind::Proxy)).err(), Some(first));

        assert!(jobs.cancel(first));
        assert!(jobs.is_canceled(first));
        let (second, h2) = inflight
            .claim(&jobs, &out, alloc(JobKind::Remux))
            .expect("a canceled holder must not be joined");
        assert_ne!(second, first);
        assert_eq!(h2.id, second, "the caller gets the NEW job's own handle");
        // And the slot now names the successor, which is live: joined.
        assert_eq!(inflight.claim(&jobs, &out, alloc(JobKind::Proxy)).err(), Some(second));
    }

    /// `classify_playback` takes the cache index lock and can rewrite
    /// index.json, so it must not run on the WebView's UI thread: a plain
    /// `#[tauri::command] fn` does. Pinned in the source because which thread
    /// a command runs on is decided by tauri at registration. Only the code
    /// before the test module is searched: the needles appear here too.
    #[test]
    fn classify_playback_runs_off_the_ui_thread() {
        let code = include_str!("playability.rs").split("#[cfg(test)]").next().unwrap();
        // Line endings as checked out (CRLF here) must not decide the search.
        let code = code.replace('\r', "");
        let at = code.find("pub async fn classify_playback(").expect("classify_playback must be an async command");
        let body = &code[at..];
        let body = &body[..body.find("
}
").expect("the command's end")];
        assert!(body.contains("spawn_blocking"), "its lookup must run on a blocking-pool thread");
    }

    /// No cache at all (main.rs runs without one when %LOCALAPPDATA% is
    /// unusable): the class is still answered and nothing is prepared. The
    /// same media against a cache holding its remux IS prepared, so the
    /// `false` is the cache's absence and nothing else.
    #[test]
    fn classify_answers_without_a_cache() {
        let dir = std::env::temp_dir().join(format!("taroting-classify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = Cache::new_at(dir.join("cache"));
        let mut m = media("video", r"C:\v\a.mkv");
        m.container = Some("matroska,webm".into());
        m.vcodec = Some("h264".into());
        m.acodec = Some("aac".into());
        m.pix_fmt = Some("yuv420p".into());
        let (kind, suffix) = prepared_target(&decide(&m, NO_HINTS, false)).expect("fixture: a remux");
        cache.ensure_kind_dir(kind).unwrap();
        std::fs::write(cache.file_path(kind, &media_key(&m).hash(), suffix), b"remuxed").unwrap();

        let bare = classify_info(None, &m, NO_HINTS, false);
        assert_eq!((bare.class, bare.prepared), (PlaybackClass::ContainerOnly, false));
        let cached = classify_info(Some(&cache), &m, NO_HINTS, false);
        assert_eq!((cached.class, cached.prepared), (PlaybackClass::ContainerOnly, true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The canceled job's closure still runs `release` with its OWN id; that
    /// must leave the successor's slot in place, while the successor's own
    /// release frees it.
    #[test]
    fn release_only_frees_its_own_slot() {
        let jobs = Jobs::default();
        let inflight = Inflight::default();
        let out = PathBuf::from(r"C:\cache\waveform\7766554433221100.pk");
        let a = jobs.allocate(JobKind::Waveform);
        let (a_id, _) = inflight.claim(&jobs, &out, || (a.id, ())).expect("free");
        jobs.cancel(a_id);
        let b = jobs.allocate(JobKind::Waveform);
        let (b_id, _) = inflight.claim(&jobs, &out, || (b.id, ())).expect("replaces A");

        inflight.release(&out, a_id);
        assert_eq!(inflight.0.lock().unwrap().get(&out), Some(&b_id), "A freed B's slot");

        inflight.release(&out, b_id);
        assert!(inflight.0.lock().unwrap().get(&out).is_none());
    }

    /// Both claim sites name their partial file through `job_tmp_suffix`; the
    /// jobs test pins what that buys. Pinned in the source because the call
    /// sites need an `AppHandle` to run.
    #[test]
    fn both_claim_sites_use_per_job_tmp_names() {
        // Only the code BEFORE each file's test module: the needles below also
        // appear as literals inside this very test, and a search over the whole
        // file would find them there and pass with the real call site reverted.
        let play = include_str!("playability.rs").split("#[cfg(test)]").next().unwrap();
        let wave = include_str!("waveform.rs").split("#[cfg(test)]").next().unwrap();
        assert!(play.contains("&job_tmp_suffix(suffix, handle.id)"));
        assert!(wave.contains("&job_tmp_suffix(\".pk\", job_id)"));
        // Each closure frees the slot with its OWN id, never an unconditional
        // remove: a canceled job finishing late must not evict its successor.
        // And only AFTER its rename, on the success path: freed before it, a
        // request in between found neither the slot nor the file and started
        // a duplicate job. The failure path frees it too.
        for (code, release, rename) in [
            (play, "inflight_arc.release(&final_for_job, job_handle.id)", "std::fs::rename(&tmp_path, &final_for_job)"),
            (wave, "inflight_arc.release(&final_clone, handle.id)", "std::fs::rename(&tmp_path, &final_clone)"),
        ] {
            let renamed = code.find(rename).expect(rename);
            let releases: Vec<usize> = code.match_indices(release).map(|(i, _)| i).collect();
            assert_eq!(releases.len(), 2, "{release}: once per outcome");
            assert!(releases.iter().all(|&r| r > renamed), "{release} must follow {rename}");
        }
        assert_eq!(job_tmp_suffix(".m4a", 12), ".m4a.12.tmp");
    }

    /// Proxies (a GIF's too: both are `JobKind::Proxy`) run on the Transcode
    /// lane, remuxes and waveforms on Background — and the job really is
    /// submitted to `lane_for`'s answer, pinned in the source because
    /// submitting needs an `AppHandle`.
    #[test]
    fn proxies_run_on_their_own_lane() {
        assert_eq!(lane_for(JobKind::Proxy), Lane::Transcode);
        assert_eq!(lane_for(JobKind::Remux), Lane::Background);
        assert_eq!(lane_for(JobKind::Waveform), Lane::Background);
        let play = include_str!("playability.rs").split("#[cfg(test)]").next().unwrap();
        let play: String = play.split_whitespace().collect();
        assert!(play.contains("jobs.submit(lane_for(job_kind),"));
        assert!(!play.contains("jobs.submit(Lane::Background"));
        // The GIF arm asks for a Proxy job, so it lands on Transcode too.
        assert!(play.contains("cache_kind,JobKind::Proxy,suffix,prepare::gif_proxy_args"));
    }

    /// The `.trt`'s path is checked before any answer hands it on: every
    /// Direct answer goes through `direct`, which checks it, and a miss in
    /// `ensure_prepared` checks it after the cache lookup and before anything
    /// is claimed or built. Pinned in the source (the command needs an
    /// `AppHandle`); `direct` itself is exercised for real below.
    #[test]
    fn no_answer_hands_on_a_path_that_is_not_a_file() {
        let play = include_str!("playability.rs").split("#[cfg(test)]").next().unwrap();
        let flat: String = play.split_whitespace().collect();
        // The only Direct built anywhere is inside `direct`, after the check.
        let built: Vec<usize> = flat.match_indices("PlaybackPlan::Direct{").map(|(i, _)| i).collect();
        assert_eq!(built.len(), 1, "one place builds a Direct answer");
        let check = flat.find("fndirect(media:&MediaRef)->Result<PlaybackPlan>{source_file(&media.path)?;");
        assert!(check.is_some_and(|c| c < built[0]), "direct checks before it answers");
        let body = &flat[flat.find("fnensure_prepared(").unwrap()..flat.find("pubasyncfnplan_playback(").unwrap()];
        let lookup = body.find("cache.existing_file(cache_kind,&hash,suffix)").unwrap();
        let checked = body.find("letsrc=source_file(&media.path)?;").expect("checked");
        let claimed = body.find("inflight.claim(").unwrap();
        assert!(lookup < checked && checked < claimed);
        assert!(body.contains("args_for(src,&tmp_path)"), "the checked path is the one built into the argv");

        let mut m = media("video", "https://example.com/clip.mp4");
        m.container = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
        m.vcodec = Some("h264".into());
        assert_eq!(decide(&m, NO_HINTS, false), Decision::Direct, "fixture: would play directly");
        assert!(matches!(direct(&m), Err(AppError::BadInput(_))));
        m.path = r"\\.\pipe\clip.mp4".into();
        assert!(matches!(direct(&m), Err(AppError::BadInput(_))));
        let real = std::env::current_exe().unwrap();
        m.path = real.to_string_lossy().into_owned();
        assert!(matches!(direct(&m), Ok(PlaybackPlan::Direct { path }) if path == m.path));
    }

    /// The command must not run on the UI thread (it writes the LRU index and
    /// stats the source): async, with the work on the blocking pool.
    #[test]
    fn plan_playback_runs_off_the_ui_thread() {
        let play = include_str!("playability.rs").split("#[cfg(test)]").next().unwrap();
        let flat: String = play.split_whitespace().collect();
        assert!(flat.contains("pubasyncfnplan_playback("));
        assert!(flat.contains("spawn_blocking(move||{plan_sync(&app,&jobs,&inflight,&media,hints,force_proxy_large,repair)})"));
    }

    /* ---- repair copies ---- */

    /// A scratch cache and a real source file for one test, in a folder of
    /// its own (tests run in parallel, and so may other `cargo test` runs).
    struct Scratch {
        dir: PathBuf,
        cache: Cache,
        source: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("taroting-repair-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let cache = Cache::new_at(dir.join("cache"));
            let source = dir.join("Replay 2026-10-06.mp4");
            std::fs::write(&source, b"not really a video").unwrap();
            Scratch { dir, cache, source }
        }

        /// A recording that `decide()` plays directly: what the WebView then
        /// refuses is what a repair is for.
        fn video(&self) -> MediaRef {
            let mut m = media("video", self.source.to_str().unwrap());
            m.container = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
            m.vcodec = Some("h264".into());
            m.acodec = Some("aac".into());
            m.pix_fmt = Some("yuv420p".into());
            m.bit_depth = Some(8);
            m.has_audio = true;
            m
        }

        /// Put a copy of `m` in the cache, as its job would have.
        fn cache_copy(&self, m: &MediaRef, copy: RepairCopy) -> PathBuf {
            let (kind, suffix) = repair_target(copy);
            self.cache.ensure_kind_dir(kind).unwrap();
            let p = self.cache.file_path(kind, &media_key(m).hash(), suffix);
            std::fs::write(&p, b"copied").unwrap();
            p
        }

        fn cache_repair(&self, m: &MediaRef, drops: bool) -> PathBuf {
            self.cache_copy(m, RepairCopy::Full { drops })
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// `RepairSteps` that answers what a test sets and records, in order,
    /// what `plan_repair` asked of it. An answer a test did not set is a step
    /// that must not happen: asking for it fails the test.
    #[derive(Default)]
    struct Fake {
        header: bool,
        scan: Option<f64>,
        full: Option<PlaybackPlan>,
        quick: Option<Result<PlaybackPlan>>,
        calls: Vec<String>,
    }

    impl RepairSteps for Fake {
        fn header_has_param_sets(&mut self, src: &Path) -> bool {
            self.calls.push(format!("probe {}", src.display()));
            self.header
        }
        fn damaged_prefix(&mut self, src: &Path) -> Option<f64> {
            self.calls.push(format!("scan {}", src.display()));
            self.scan
        }
        fn start_full(&mut self, drops: bool) -> Result<PlaybackPlan> {
            self.calls.push(format!("full drops={drops}"));
            Ok(self.full.take().expect("started a full repair this test did not expect"))
        }
        fn start_quick(&mut self, from: f64) -> Result<PlaybackPlan> {
            self.calls.push(format!("quick from={from}"));
            self.quick.take().expect("started an instant copy this test did not expect")
        }
        fn discard_quick(&mut self) {
            self.calls.push("discard".into());
        }
    }

    fn pending(job_id: JobId, output: &str) -> PlaybackPlan {
        PlaybackPlan::Pending { job_id, output: output.into(), repair: None, upgrade: None }
    }

    fn ready(path: &str) -> PlaybackPlan {
        PlaybackPlan::Ready { path: path.into(), repair: None, upgrade: None }
    }

    fn note(drops: bool, damaged_until: Option<f64>, quick: bool) -> Option<RepairNote> {
        Some(RepairNote { drops_headers: drops, damaged_until, quick: quick.then_some(true) })
    }

    /// The pre-repair cache names stay where they were, and the three repair
    /// copies each get a name of their own beside them — pinned as literals,
    /// since renaming any orphans every copy made under it. The instant copy
    /// sits in the remuxes' folder under a name no remux uses.
    #[test]
    fn repair_copies_have_names_of_their_own() {
        assert_eq!(repair_target(RepairCopy::Full { drops: true }), (CacheKind::Proxy, ".repairh.mp4"));
        assert_eq!(repair_target(RepairCopy::Full { drops: false }), (CacheKind::Proxy, ".repair.mp4"));
        assert_eq!(repair_target(RepairCopy::Quick), (CacheKind::Remux, ".quick.mp4"));
        let taken: Vec<_> = [Decision::Proxy, Decision::Remux { audio_copy_ok: true }, Decision::AudioRemux]
            .iter()
            .filter_map(prepared_target)
            .collect();
        for copy in [RepairCopy::Full { drops: true }, RepairCopy::Full { drops: false }, RepairCopy::Quick] {
            assert!(!taken.contains(&repair_target(copy)), "{copy:?}");
        }
    }

    /// Only a video goes to the repair copy, and only when asked or flagged.
    /// Each "no" row differs from a "yes" row in one thing: the kind, the
    /// generator, the request, or the flag's value.
    #[test]
    fn only_a_video_asked_for_or_flagged_is_planned_for_repair() {
        let s = Scratch::new("route");
        let plain = s.video();
        let mut flagged = s.video();
        flagged.drop_inband_headers = Some(true);
        assert!(!wants_repair(&plain, None), "a healthy file plans as it always did");
        assert!(!wants_repair(&plain, Some(false)));
        assert!(wants_repair(&plain, Some(true)), "asked for");
        assert!(wants_repair(&flagged, None), "flagged");
        assert!(wants_repair(&flagged, Some(false)), "flagged, whatever the request");
        let mut not_flag = s.video();
        not_flag.drop_inband_headers = Some(false);
        assert!(!wants_repair(&not_flag, None), "only a true flag");

        for kind in ["audio", "image", "gif", "imageSeq"] {
            let mut m = flagged.clone();
            m.kind = kind.into();
            assert!(!wants_repair(&m, Some(true)), "{kind}");
        }
        let mut generated = flagged.clone();
        generated.generator = Some(crate::project::schema::Generator::Solid { color: "#123456".into() });
        assert!(!wants_repair(&generated, Some(true)), "a generator has no file");

        // And `plan_sync` asks it FIRST, before `decide()` sends the file
        // anywhere else. Pinned in the source: the command needs an AppHandle.
        let play = include_str!("playability.rs").split("#[cfg(test)]").next().unwrap();
        let flat: String = play.split_whitespace().collect();
        let body = &flat[flat.find("fnplan_sync(").unwrap()..];
        let asked = body.find("ifwants_repair(media,repair){").expect("plan_sync routes by wants_repair");
        assert!(asked < body.find("letdecision=decide(").unwrap());
        // Without the cache there is no copy to make: the branch plays the
        // file as it is, exactly like the normal path without one. With it,
        // the real steps.
        assert!(
            body[asked..].starts_with(
                "ifwants_repair(media,repair){letSome(cache)=app.try_state::<Arc<Cache>>()else{returndirect(media);};\
                 letmutsteps=LiveRepair{app,jobs,cache:&cache,inflight,media};returnplan_repair(&cache,media,&SCANNED,&mutsteps);}"
            ),
            "the repair branch's no-cache answer is the file itself, and it plans with the live steps"
        );
        // The live steps are the REAL probe, the REAL scan and the real jobs.
        // Every `plan_repair` test injects its own, so a stand-in here (a
        // probe answering `false`, a scan answering `None`) would pass them
        // all while every damaged recording lost its fix or its instant copy.
        let live = &flat[flat.find("implRepairStepsforLiveRepair<'_>{").expect("LiveRepair's steps")..];
        for step in [
            "fnheader_has_param_sets(&mutself,src:&Path)->bool{probe::h264_param_sets_in_header(src)}",
            "fndamaged_prefix(&mutself,src:&Path)->Option<f64>{damage::scan_damaged_prefix(src)}",
            "let(cache_kind,suffix)=repair_target(RepairCopy::Full{drops});",
            "cache_kind,JobKind::Proxy,suffix,move|src,dst|prepare::repair_args(src,dst,drops),",
            "let(cache_kind,suffix)=repair_target(RepairCopy::Quick);",
            "cache_kind,JobKind::Remux,suffix,move|src,dst|prepare::quick_repair_args(src,dst,from),",
            "fndiscard_quick(&mutself){discard_quick(self.cache,self.inflight,self.media);}",
        ] {
            assert!(live.contains(step), "{step}");
        }
        // The full repair is a Proxy job (the Transcode lane), the instant
        // copy a Remux job (Background): never queued behind each other.
        assert_eq!((lane_for(JobKind::Proxy), lane_for(JobKind::Remux)), (Lane::Transcode, Lane::Background));
    }

    /// A full repair copy already in the cache answers `Ready` at once, saying
    /// which recipe made it — no header probe, no job — with the damaged span
    /// the scan finds in the source, and the superseded instant copy deleted.
    /// With the source gone the copy still plays: no scan, no failure.
    #[test]
    fn a_cached_full_repair_answers_without_a_probe_or_a_job() {
        for drops in [true, false] {
            let s = Scratch::new(&format!("cached-{drops}"));
            let m = s.video();
            let copy = s.cache_repair(&m, drops);
            let mut steps = Fake { scan: Some(60.499), ..Fake::default() };
            match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps) {
                Ok(PlaybackPlan::Ready { path, repair, upgrade: None }) => {
                    assert_eq!(PathBuf::from(path), copy, "drops {drops}");
                    assert_eq!(repair, note(drops, Some(60.499), false), "drops {drops}");
                }
                other => panic!("drops {drops}: {other:?}"),
            }
            assert_eq!(steps.calls, [format!("scan {}", s.source.display()), "discard".into()], "drops {drops}");

            std::fs::remove_file(&s.source).unwrap();
            let mut offline = Fake { scan: Some(60.499), ..Fake::default() };
            match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut offline) {
                Ok(PlaybackPlan::Ready { path, repair, upgrade: None }) => {
                    assert_eq!(PathBuf::from(path), copy, "offline, drops {drops}");
                    assert_eq!(repair, note(drops, None, false), "offline, drops {drops}");
                }
                other => panic!("offline, drops {drops}: {other:?}"),
            }
            assert_eq!(offline.calls, ["discard"], "offline: nothing to scan");
        }
        // Both cached: the header-free copy wins.
        let s = Scratch::new("cached-both");
        let m = s.video();
        s.cache_repair(&m, false);
        let ps = s.cache_repair(&m, true);
        assert_eq!(cached_full_repair(&s.cache, &m), Some((ps.to_string_lossy().into_owned(), true)));
        // A cached HEVC repair is never scanned: the scan reads H.264 only.
        let mut hevc = s.video();
        hevc.vcodec = Some("hevc".into());
        s.cache_repair(&hevc, false);
        let mut steps = Fake { scan: Some(1.0), ..Fake::default() };
        assert!(matches!(
            plan_repair(&s.cache, &hevc, &ScanMemo::new(), &mut steps),
            Ok(PlaybackPlan::Ready { repair: Some(RepairNote { damaged_until: None, .. }), .. })
        ));
        assert_eq!(steps.calls, ["discard"]);
        // An instant copy alone is not a full repair: it is planned past.
        let fresh = Scratch::new("cached-quick-only");
        let m = fresh.video();
        fresh.cache_copy(&m, RepairCopy::Quick);
        assert_eq!(cached_full_repair(&fresh.cache, &m), None);
    }

    /// On a miss only H.264 ever drops the in-band headers — the export's
    /// rule, so preview and export agree on every codec — and there the
    /// recipe follows the flag, else the header, asked only when the flag has
    /// not already answered. With no damaged prefix the full repair is the
    /// answer, carrying that note. A proxy-shaped `.mp4` sitting in the cache
    /// is not a repair copy.
    #[test]
    fn a_miss_chooses_the_recipe_and_notes_it_on_the_job() {
        let s = Scratch::new("miss");
        let plain = s.video();
        assert_eq!(plain.vcodec.as_deref(), Some("h264"), "the base row is H.264");
        // The ordinary proxy of this file, cached: not what a repair plays.
        let (proxy_kind, proxy_suffix) = prepared_target(&Decision::Proxy).unwrap();
        s.cache.ensure_kind_dir(proxy_kind).unwrap();
        std::fs::write(s.cache.file_path(proxy_kind, &media_key(&plain).hash(), proxy_suffix), b"proxy").unwrap();

        let mut flagged = plain.clone();
        flagged.drop_inband_headers = Some(true);
        let mut hevc = plain.clone();
        hevc.vcodec = Some("hevc".into());
        // Each flagged non-H.264 row differs from `flagged` in the codec
        // alone. Reachable only through a hand-edited or crafted `.trt` (the
        // editor stamps the flag only from a `dropsHeaders: true` answer);
        // the filter on HEVC would drop real slices, and on a codec its parser
        // lacks it would fail the job.
        let flagged_as = |vcodec: Option<&str>| {
            let mut m = flagged.clone();
            m.vcodec = vcodec.map(Into::into);
            m
        };
        let (flagged_hevc, flagged_vp9, flagged_unknown) =
            (flagged_as(Some("hevc")), flagged_as(Some("vp9")), flagged_as(None));
        let src = s.source.display().to_string();
        // (name, media, header answer, calls expected, recipe expected)
        let rows: [(&str, &MediaRef, bool, Vec<String>, bool); 7] = [
            ("h264, header has them", &plain, true,
                vec![format!("probe {src}"), "full drops=true".into(), format!("scan {src}")], true),
            ("h264, header has none", &plain, false,
                vec![format!("probe {src}"), "full drops=false".into(), format!("scan {src}")], false),
            // The header would say no: only the flag can make this `true`,
            // and a probe that ran anyway shows in the calls.
            ("flagged h264: no probe", &flagged, false, vec!["full drops=true".into(), format!("scan {src}")], true),
            // Not H.264: never probed, never scanned.
            ("hevc", &hevc, true, vec!["full drops=false".into()], false),
            ("flagged hevc", &flagged_hevc, true, vec!["full drops=false".into()], false),
            ("flagged vp9", &flagged_vp9, true, vec!["full drops=false".into()], false),
            ("flagged, codec unknown", &flagged_unknown, true, vec!["full drops=false".into()], false),
        ];
        for (name, m, header, calls, drops) in rows {
            // The scan finds nothing: no instant copy, the full repair alone.
            let mut steps = Fake { header, full: Some(pending(41, "out")), ..Fake::default() };
            match plan_repair(&s.cache, m, &ScanMemo::new(), &mut steps) {
                Ok(PlaybackPlan::Pending { job_id: 41, output, repair, upgrade: None }) => {
                    assert_eq!(output, "out", "{name}");
                    assert_eq!(repair, note(drops, None, false), "{name}");
                }
                other => panic!("{name}: {other:?}"),
            }
            assert_eq!(steps.calls, calls, "{name}");
        }
    }

    /// A damaged PREFIX: the full repair starts first, then the scan, then
    /// the instant copy — which is the answer, noted quick with the damaged
    /// span and carrying the full repair as its upgrade. Every id, path and
    /// time differs, so no field can be filled from the wrong source.
    #[test]
    fn a_damaged_prefix_answers_the_instant_copy_with_the_full_repair_as_its_upgrade() {
        let s = Scratch::new("quick");
        let m = s.video();
        let src = s.source.display().to_string();
        let expected_calls =
            vec![format!("probe {src}"), "full drops=true".into(), format!("scan {src}"), "quick from=60.499".into()];

        let mut steps = Fake {
            header: true,
            scan: Some(60.499),
            full: Some(pending(41, "full.repairh.mp4")),
            quick: Some(Ok(pending(42, "fast.quick.mp4"))),
            ..Fake::default()
        };
        match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps) {
            Ok(PlaybackPlan::Pending { job_id, output, repair, upgrade }) => {
                assert_eq!((job_id, output.as_str()), (42, "fast.quick.mp4"));
                assert_eq!(repair, note(true, Some(60.499), true));
                assert_eq!(upgrade, Some(UpgradeJob { job_id: 41, output: "full.repairh.mp4".into() }));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(steps.calls, expected_calls, "full first, then the scan, then the instant copy");

        // The instant copy already made: Ready, the full repair still its upgrade.
        let mut steps = Fake {
            header: true,
            scan: Some(60.499),
            full: Some(pending(41, "full.repairh.mp4")),
            quick: Some(Ok(ready("made.quick.mp4"))),
            ..Fake::default()
        };
        match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps) {
            Ok(PlaybackPlan::Ready { path, repair, upgrade }) => {
                assert_eq!(path, "made.quick.mp4");
                assert_eq!(repair, note(true, Some(60.499), true));
                assert_eq!(upgrade, Some(UpgradeJob { job_id: 41, output: "full.repairh.mp4".into() }));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(steps.calls, expected_calls);

        // The instant copy could not start: the full repair alone, still
        // saying how far the damage runs.
        let mut steps = Fake {
            header: true,
            scan: Some(60.499),
            full: Some(pending(41, "full.repairh.mp4")),
            quick: Some(Err(AppError::Ffmpeg("no room".into()))),
            ..Fake::default()
        };
        match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps) {
            Ok(PlaybackPlan::Pending { job_id: 41, output, repair, upgrade: None }) => {
                assert_eq!(output, "full.repairh.mp4");
                assert_eq!(repair, note(true, Some(60.499), false));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(steps.calls, expected_calls);
    }

    /// The full repair finished between the cache lookup and the job start
    /// (another plan made it): it is the answer, however the scan came out —
    /// no instant copy is started, and a leftover one is deleted.
    #[test]
    fn a_full_repair_that_finished_meanwhile_is_the_answer() {
        let s = Scratch::new("finished");
        let m = s.video();
        let src = s.source.display().to_string();
        let mut steps = Fake {
            header: false,
            scan: Some(7.25),
            full: Some(ready("done.repair.mp4")),
            ..Fake::default()
        };
        match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps) {
            Ok(PlaybackPlan::Ready { path, repair, upgrade: None }) => {
                assert_eq!(path, "done.repair.mp4");
                assert_eq!(repair, note(false, Some(7.25), false));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(steps.calls, [format!("probe {src}"), "full drops=false".into(), format!("scan {src}"), "discard".into()]);
    }

    /// A miss whose source is not a real file is refused before any probe,
    /// scan or job, like every other plan.
    #[test]
    fn a_repair_miss_never_reaches_past_a_bad_source() {
        let s = Scratch::new("bad-source");
        for path in ["https://example.com/clip.mp4".to_string(), s.dir.join("gone.mp4").to_string_lossy().into_owned()] {
            let mut m = s.video();
            m.path = path.clone();
            let mut steps = Fake::default();
            let plan = plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps);
            assert!(matches!(plan, Err(AppError::BadInput(_))), "{path}: {plan:?}");
            assert!(steps.calls.is_empty(), "{path}: {:?}", steps.calls);
        }
    }

    /// `discard_quick` deletes the instant copy of exactly this file — never
    /// while a live job holds it (it may be about to rename into place), and
    /// never anything else under the same key.
    #[test]
    fn discarding_the_instant_copy_spares_a_live_job_and_every_other_copy() {
        let s = Scratch::new("discard");
        let m = s.video();
        let jobs = Jobs::default();
        let inflight = Inflight::default();
        let quick = s.cache_copy(&m, RepairCopy::Quick);
        let full = s.cache_repair(&m, true);
        let (remux_kind, remux_suffix) = prepared_target(&Decision::Remux { audio_copy_ok: true }).unwrap();
        let remux = s.cache.file_path(remux_kind, &media_key(&m).hash(), remux_suffix);
        std::fs::write(&remux, b"remux").unwrap();

        let (id, _handle) = inflight
            .claim(&jobs, &quick, || {
                let h = jobs.allocate(JobKind::Remux);
                (h.id, h)
            })
            .unwrap();
        discard_quick(&s.cache, &inflight, &m);
        assert!(quick.exists(), "a live job holds it");

        inflight.release(&quick, id);
        discard_quick(&s.cache, &inflight, &m);
        assert!(!quick.exists(), "released: deleted");
        assert!(full.exists() && remux.exists(), "only the instant copy goes");
        discard_quick(&s.cache, &inflight, &m); // already gone: nothing to do, no error
    }

    /// `repaired` says whether a full repair copy is cached, for a video
    /// only, and `class`/`prepared` stay exactly what they were for every
    /// row of the decision table — whatever repair copies sit in the cache.
    #[test]
    fn classify_reports_a_cached_repair_copy_and_nothing_else_changes() {
        let s = Scratch::new("classify");
        let m = s.video();
        let before = classify_info(Some(&s.cache), &m, NO_HINTS, false);
        assert_eq!((before.class, before.prepared, before.repaired), (PlaybackClass::Direct, false, false));
        let quick = s.cache_copy(&m, RepairCopy::Quick);
        assert!(!classify_info(Some(&s.cache), &m, NO_HINTS, false).repaired, "an instant copy is not the repair");
        std::fs::remove_file(&quick).unwrap();
        let copy = s.cache_repair(&m, true);
        let after = classify_info(Some(&s.cache), &m, NO_HINTS, false);
        assert_eq!((after.class, after.prepared, after.repaired), (PlaybackClass::Direct, false, true));
        std::fs::remove_file(&copy).unwrap();
        s.cache_repair(&m, false);
        assert!(classify_info(Some(&s.cache), &m, NO_HINTS, false).repaired, "the plain copy counts too");
        assert!(!classify_info(None, &m, NO_HINTS, false).repaired, "no cache, nothing cached");

        // Every row of the decision table, against two caches that both hold
        // its remux/proxy (so `prepared` is true wherever it can be) and
        // differ only in that the second also holds every repair copy under
        // the same key. Only `repaired` may differ, and only for a video. A
        // generator rides along: a video kind, but no file to repair.
        let mut rows = decision_table();
        let mut generated = media("video", r"C:\v\a.mp4");
        generated.generator = Some(crate::project::schema::Generator::Solid { color: "#abcdef".into() });
        rows.push(("solid generator", generated, NO_HINTS, false, Decision::Proxy, PlaybackClass::Proxy));
        let plain = Scratch::new("classify-plain");
        let mut any_prepared = false;
        for (name, r, hints, force, decision, class) in &rows {
            let hash = media_key(r).hash();
            if let Some((kind, suffix)) = prepared_target(decision) {
                for cache in [&plain.cache, &s.cache] {
                    cache.ensure_kind_dir(kind).unwrap();
                    std::fs::write(cache.file_path(kind, &hash, suffix), b"prepared").unwrap();
                }
            }
            for copy in [RepairCopy::Full { drops: true }, RepairCopy::Full { drops: false }, RepairCopy::Quick] {
                let (kind, suffix) = repair_target(copy);
                s.cache.ensure_kind_dir(kind).unwrap();
                std::fs::write(s.cache.file_path(kind, &hash, suffix), b"repaired").unwrap();
            }
            let bare = classify_info(Some(&plain.cache), r, *hints, *force);
            let full = classify_info(Some(&s.cache), r, *hints, *force);
            assert_eq!(full.class, *class, "{name}: class");
            assert_eq!(bare.class, *class, "{name}: class");
            assert_eq!(full.prepared, bare.prepared, "{name}: prepared");
            assert_eq!(full.prepared, prepared_target(&decide(r, *hints, *force)).is_some(), "{name}");
            any_prepared |= full.prepared;
            assert!(!bare.repaired, "{name}: nothing to report without a copy");
            assert_eq!(full.repaired, r.kind == "video" && r.generator.is_none(), "{name}: repaired");
        }
        assert!(any_prepared, "the table must reach a prepared row");
    }

    /// A header-free copy under the RETIRED name `.repairps.mp4` — what the
    /// recipe that kept the turning SEI wrote, sitting in caches made before
    /// the fix under the same key — is no repair: not served, not reported,
    /// and a plan of the file starts the full repair afresh.
    #[test]
    fn a_copy_under_the_retired_name_is_never_served() {
        let s = Scratch::new("retired");
        let m = s.video();
        let (kind, _) = repair_target(RepairCopy::Full { drops: true });
        s.cache.ensure_kind_dir(kind).unwrap();
        std::fs::write(s.cache.file_path(kind, &media_key(&m).hash(), ".repairps.mp4"), b"turned").unwrap();

        assert_eq!(cached_full_repair(&s.cache, &m), None);
        assert!(!classify_info(Some(&s.cache), &m, NO_HINTS, false).repaired);
        let mut steps = Fake { header: true, full: Some(pending(41, "out")), ..Fake::default() };
        match plan_repair(&s.cache, &m, &ScanMemo::new(), &mut steps) {
            Ok(PlaybackPlan::Pending { job_id: 41, repair, upgrade: None, .. }) => {
                assert_eq!(repair, note(true, None, false));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(steps.calls[1], "full drops=true", "{:?}", steps.calls);
    }

    /// The damaged span is scanned once per file per run (`ScanMemo`): a
    /// repeat plan of the same file — still repairing, or repaired — answers
    /// it without the scan, and the span it carries is the FIRST scan's,
    /// though this plan's steps would answer another. A file that differs in
    /// size or in mtime alone is another file, and is scanned.
    #[test]
    fn a_repeat_plan_answers_the_damaged_span_from_memory() {
        let s = Scratch::new("memo");
        let m = s.video();
        let src = s.source.display().to_string();
        let scans = ScanMemo::new();
        let repairing = |scan: f64| Fake {
            header: true,
            scan: Some(scan),
            full: Some(pending(41, "full.repairh.mp4")),
            quick: Some(Ok(pending(42, "fast.quick.mp4"))),
            ..Fake::default()
        };

        let mut first = repairing(60.499);
        match plan_repair(&s.cache, &m, &scans, &mut first) {
            Ok(PlaybackPlan::Pending { job_id: 42, repair, .. }) => assert_eq!(repair, note(true, Some(60.499), true)),
            other => panic!("first: {other:?}"),
        }
        assert_eq!(first.calls, [format!("probe {src}"), "full drops=true".into(), format!("scan {src}"), "quick from=60.499".into()]);

        let mut again = repairing(1.5);
        match plan_repair(&s.cache, &m, &scans, &mut again) {
            Ok(PlaybackPlan::Pending { job_id: 42, repair, .. }) => assert_eq!(repair, note(true, Some(60.499), true)),
            other => panic!("again: {other:?}"),
        }
        assert_eq!(again.calls, [format!("probe {src}"), "full drops=true".into(), "quick from=60.499".into()], "no scan");

        // The full repair done: every plan of it answers from memory too.
        s.cache_repair(&m, true);
        for round in 0..2 {
            let mut cached = Fake { scan: Some(1.5), ..Fake::default() };
            match plan_repair(&s.cache, &m, &scans, &mut cached) {
                Ok(PlaybackPlan::Ready { repair, .. }) => assert_eq!(repair, note(true, Some(60.499), false), "round {round}"),
                other => panic!("round {round}: {other:?}"),
            }
            assert_eq!(cached.calls, ["discard"], "round {round}: no scan");
        }

        // The same path, rewritten: another size, or another mtime.
        let (mut resized, mut touched) = (m.clone(), m.clone());
        resized.size += 1;
        touched.mtime_ms += 1;
        for (name, changed) in [("size", &resized), ("mtime", &touched)] {
            s.cache_repair(changed, true);
            let mut steps = Fake { scan: Some(7.25), ..Fake::default() };
            match plan_repair(&s.cache, changed, &scans, &mut steps) {
                Ok(PlaybackPlan::Ready { repair, .. }) => assert_eq!(repair, note(true, Some(7.25), false), "{name}"),
                other => panic!("{name}: {other:?}"),
            }
            assert_eq!(steps.calls, [format!("scan {src}"), "discard".into()], "{name}: scanned");
        }
    }

    /// The memo keeps the `SCAN_MEMO_LEN` files asked about most recently:
    /// one more drops the least recent, and asking again makes a file the
    /// most recent. A `None` is remembered like any answer. A lock poisoned
    /// by a panic elsewhere still answers (`panic = "abort"` would make a
    /// panic here fatal).
    #[test]
    fn the_scan_memo_keeps_the_most_recent_files_and_outlives_a_poisoned_lock() {
        let memo = ScanMemo::new();
        let scanned = std::cell::Cell::new(0usize);
        let ask = |k: usize| {
            memo.answer(format!("file {k}"), || {
                scanned.set(scanned.get() + 1);
                // File 3 has no damaged prefix.
                (k != 3).then_some(k as f64)
            })
        };
        let scans_for = |k: usize| {
            let before = scanned.get();
            let answer = ask(k);
            assert_eq!(answer, (k != 3).then_some(k as f64), "file {k}");
            scanned.get() - before
        };
        for k in 0..SCAN_MEMO_LEN {
            assert_eq!(scans_for(k), 1, "file {k}: first ask");
        }
        assert_eq!(scans_for(3), 0, "a remembered None");
        assert_eq!(scans_for(0), 0, "remembered; now the most recent");
        assert_eq!(scans_for(SCAN_MEMO_LEN), 1, "one more file");
        assert_eq!(memo.0.lock().unwrap().len(), SCAN_MEMO_LEN, "bounded");
        assert_eq!(scans_for(0), 0, "file 0 was asked again, so file 1 went instead");
        assert_eq!(scans_for(2), 0);
        assert_eq!(scans_for(1), 1, "file 1 was the least recent");

        std::thread::scope(|t| {
            let _ = t
                .spawn(|| {
                    let _held = memo.0.lock().unwrap();
                    panic!("poison the scan memo");
                })
                .join();
        });
        assert!(memo.0.is_poisoned(), "fixture must be poisoned");
        assert_eq!(scans_for(2), 0, "remembered through the poison");
        assert_eq!(scans_for(SCAN_MEMO_LEN + 1), 1, "and still learning");
    }
}
