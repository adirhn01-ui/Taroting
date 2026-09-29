//! The playback decision tree: can WebView2 play this file directly, does it
//! need a lossless remux, or a full preview proxy? Plus the `plan_playback`
//! command that consults/populates the cache and spawns preparation jobs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::error::Result;
use crate::jobs::{self, JobId, JobKind, Jobs, Lane};
use crate::media::prepare;
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

/// Pure CPU plus at most one stat: no job, no ffmpeg, so it is registered
/// sync. A hit refreshes that file's LRU stamp exactly as `plan_playback`'s
/// own lookup would — the caller asks because it is about to play it.
#[tauri::command]
pub fn classify_playback(
    cache: State<'_, Arc<Cache>>,
    media: MediaRef,
    hints: CodecHints,
    force_proxy_large: bool,
) -> PlaybackClassInfo {
    let class = classify(&media, hints, force_proxy_large);
    let prepared = prepared_target(&decide(&media, hints, force_proxy_large))
        .map(|(kind, suffix)| {
            cache
                .existing_file(kind, &media_key(&media).hash(), suffix)
                .is_some()
        })
        .unwrap_or(false);
    PlaybackClassInfo { class, prepared }
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
/// crash needs no sweep of its own: `Cache::enforce_limit` lists every file in
/// each kind dir, dating unindexed ones by mtime, so it ages out LRU.
pub(crate) fn job_tmp_suffix(suffix: &str, id: JobId) -> String {
    format!("{suffix}.{id}.tmp")
}

/// `rename_all` on an enum renames only the VARIANT tags; the fields inside a
/// struct variant need `rename_all_fields`, or `job_id` reaches the webview as
/// `job_id` while it reads `jobId` — and every job it started was registered
/// under `undefined`, so no progress/done/failed event ever matched it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "mode")]
pub enum PlaybackPlan {
    /// Play the original file directly.
    Direct { path: String },
    /// A prepared file already exists in the cache.
    Ready { path: String },
    /// Preparation is running; listen for job events.
    Pending { job_id: JobId, output: String },
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
    inflight: &State<'_, Inflight>,
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
        });
    }

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
            })
        }
    };
    // Named only now that the job id exists — see `job_tmp_suffix`.
    let tmp_path = cache.file_path(cache_kind, &hash, &job_tmp_suffix(suffix, handle.id));

    let args = args_for(std::path::Path::new(&media.path), &tmp_path);
    let total = if media.duration > 0.0 { Some(media.duration) } else { None };

    let app = app.clone();
    let jobs_arc = Arc::clone(jobs);
    let cache_arc = Arc::clone(cache);
    let inflight_arc = Inflight::clone(inflight);
    let final_for_job = final_path.clone();
    let job_handle = handle.clone();

    jobs.submit(
        Lane::Background,
        Box::new(move || {
            job_handle.set_output(tmp_path.clone());
            let result = jobs::execute_ffmpeg(&app, &job_handle, args, total);
            inflight_arc.release(&final_for_job, job_handle.id);
            match result {
                Ok(()) => {
                    if let Err(e) = std::fs::rename(&tmp_path, &final_for_job) {
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
                    jobs::fail_job(&app, &jobs_arc, &job_handle, failure.message, failure.log_tail);
                }
            }
        }),
    );

    Ok(PlaybackPlan::Pending {
        job_id: handle.id,
        output: final_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn plan_playback(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    cache: State<'_, Arc<Cache>>,
    inflight: State<'_, Inflight>,
    media: MediaRef,
    hints: CodecHints,
    force_proxy_large: bool,
) -> Result<PlaybackPlan> {
    let decision = decide(&media, hints, force_proxy_large);
    // Where the output lives comes from `prepared_target` alone, the table
    // `classify_playback` reads; each arm below only picks the recipe.
    let Some((cache_kind, suffix)) = prepared_target(&decision) else {
        return Ok(PlaybackPlan::Direct {
            path: media.path.clone(),
        });
    };
    match decision {
        Decision::Remux { audio_copy_ok } => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            cache_kind, JobKind::Remux, suffix,
            move |src, dst| prepare::remux_args(src, dst, audio_copy_ok),
        ),
        Decision::AudioRemux => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            cache_kind, JobKind::Remux, suffix,
            prepare::audio_remux_args,
        ),
        Decision::Proxy => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            cache_kind, JobKind::Proxy, suffix,
            prepare::proxy_args,
        ),
        Decision::GifProxy => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            cache_kind, JobKind::Proxy, suffix,
            prepare::gif_proxy_args,
        ),
        // `prepared_target` names no file for these, so the early return above
        // already answered; kept total rather than `unreachable!()` because a
        // panic here would abort the whole app.
        Decision::Direct | Decision::AudioDirect | Decision::ImageDirect => {
            Ok(PlaybackPlan::Direct {
                path: media.path.clone(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The webview reads these by their camelCase names (src/core/ipc.ts
    /// `PlaybackPlan`, `WaveformResult`, `FilmstripResult`). Pinned on the
    /// WIRE: no Rust type check can see a field the JS side reads as
    /// `undefined`, and that is exactly how every editor job went unheard.
    #[test]
    fn job_results_reach_the_webview_in_camel_case() {
        use serde_json::json;
        let wire = |v: serde_json::Result<serde_json::Value>| v.expect("serializes");
        assert_eq!(
            wire(serde_json::to_value(PlaybackPlan::Pending { job_id: 7, output: "o".into() })),
            json!({ "mode": "pending", "jobId": 7, "output": "o" })
        );
        assert_eq!(
            wire(serde_json::to_value(crate::media::waveform::WaveformResult::Pending {
                job_id: 8,
                output: "w".into()
            })),
            json!({ "state": "pending", "jobId": 8, "output": "w" })
        );
        assert_eq!(
            wire(serde_json::to_value(crate::media::thumbs::FilmstripResult::Pending {
                job_id: 9,
                dir: "d".into()
            })),
            json!({ "state": "pending", "jobId": 9, "dir": "d" })
        );
        assert_eq!(
            wire(serde_json::to_value(crate::media::thumbs::FilmstripResult::Ready {
                dir: "d".into(),
                frame_count: 3
            })),
            json!({ "state": "ready", "dir": "d", "frameCount": 3 })
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

        let rows: Vec<(&str, MediaRef, CodecHints, bool, Decision, PlaybackClass)> = vec![
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
        ];

        let mut seen = std::collections::HashSet::new();
        for (name, m, hints, force, decision, class) in &rows {
            assert_eq!(decide(m, *hints, *force), *decision, "{name}: decide()");
            assert_eq!(classify(m, *hints, *force), *class, "{name}: classify()");
            seen.insert(std::mem::discriminant(decision));
        }
        assert_eq!(seen.len(), 7, "the table must reach every Decision variant");
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
        })
        .unwrap();
        assert_eq!(info, serde_json::json!({ "class": "containerOnly", "prepared": true }));
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
        assert!(play.contains("inflight_arc.release(&final_for_job, job_handle.id)"));
        assert!(wave.contains("inflight_arc.release(&final_clone, handle.id)"));
        assert_eq!(job_tmp_suffix(".m4a", 12), ".m4a.12.tmp");
    }
}
