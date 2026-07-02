//! The playback decision tree: can WebView2 play this file directly, does it
//! need a lossless remux, or a full preview proxy? Plus the `plan_playback`
//! command that consults/populates the cache and spawns preparation jobs.

use std::collections::HashMap;
use std::path::PathBuf;
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
/* plan_playback                                                       */
/* ------------------------------------------------------------------ */

/// De-duplicates concurrent preparation jobs per output file.
#[derive(Default)]
pub struct Inflight(pub Arc<Mutex<HashMap<PathBuf, JobId>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
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
    let tmp_path = cache.file_path(cache_kind, &hash, &format!("{suffix}.tmp"));

    let mut inflight_map = inflight.0.lock().unwrap();
    if let Some(&existing) = inflight_map.get(&final_path) {
        return Ok(PlaybackPlan::Pending {
            job_id: existing,
            output: final_path.to_string_lossy().into_owned(),
        });
    }

    let handle = jobs.allocate(job_kind);
    inflight_map.insert(final_path.clone(), handle.id);
    drop(inflight_map);

    let args = args_for(std::path::Path::new(&media.path), &tmp_path);
    let total = if media.duration > 0.0 { Some(media.duration) } else { None };

    let app = app.clone();
    let jobs_arc = Arc::clone(jobs);
    let cache_arc = Arc::clone(cache);
    let inflight_arc = Arc::clone(&inflight.0);
    let final_for_job = final_path.clone();
    let job_handle = handle.clone();

    jobs.submit(
        Lane::Background,
        Box::new(move || {
            job_handle.set_output(tmp_path.clone());
            let result = jobs::execute_ffmpeg(&app, &job_handle, args, total);
            inflight_arc.lock().unwrap().remove(&final_for_job);
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
    match decide(&media, hints, force_proxy_large) {
        Decision::Direct | Decision::AudioDirect | Decision::ImageDirect => {
            Ok(PlaybackPlan::Direct {
                path: media.path.clone(),
            })
        }
        Decision::Remux { audio_copy_ok } => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            CacheKind::Remux, JobKind::Remux, ".mp4",
            move |src, dst| prepare::remux_args(src, dst, audio_copy_ok),
        ),
        Decision::AudioRemux => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            CacheKind::Remux, JobKind::Remux, ".m4a",
            prepare::audio_remux_args,
        ),
        Decision::Proxy => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            CacheKind::Proxy, JobKind::Proxy, ".mp4",
            prepare::proxy_args,
        ),
        Decision::GifProxy => ensure_prepared(
            &app, &jobs, &cache, &inflight, &media,
            CacheKind::Proxy, JobKind::Proxy, ".mp4",
            prepare::gif_proxy_args,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
