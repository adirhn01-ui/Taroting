//! Thumbnails (single frames, thumb lane, synchronous-ish) and filmstrips
//! (sparse frame sequences for timeline clips, background lane).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::error::{AppError, Result};
use crate::jobs::{self, JobId, JobKind, Jobs, Lane};

const THUMB_WIDTH: u32 = 320;

fn thumbnail_args(src: &Path, dst: &Path, at_sec: f64) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for a in ["-y", "-hide_banner", "-loglevel", "error"] {
        args.push(a.into());
    }
    args.push("-ss".into());
    args.push(format!("{at_sec:.3}").into());
    args.push("-i".into());
    args.push(src.into());
    for a in ["-frames:v", "1", "-vf"] {
        args.push(a.into());
    }
    args.push(format!("scale={THUMB_WIDTH}:-2").into());
    for a in ["-q:v", "5"] {
        args.push(a.into());
    }
    args.push(dst.into());
    args
}

/// First already-generated thumbnail for a media hash (used for recents).
pub fn any_thumb_for(cache: &Cache, hash: &str) -> Option<PathBuf> {
    let dir = cache.root().join(CacheKind::Thumbs.dir_name());
    let read = std::fs::read_dir(dir).ok()?;
    for entry in read.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(hash) {
            return Some(entry.path());
        }
    }
    None
}

#[tauri::command]
pub fn get_thumbnail(
    jobs: State<'_, Arc<Jobs>>,
    cache: State<'_, Arc<Cache>>,
    key: MediaKey,
    at_sec: f64,
) -> Result<String> {
    let hash = key.hash();
    let suffix = format!("_{}.jpg", (at_sec * 1000.0) as u64);
    if let Some(existing) = cache.existing_file(CacheKind::Thumbs, &hash, &suffix) {
        return Ok(existing.to_string_lossy().into_owned());
    }
    cache.ensure_kind_dir(CacheKind::Thumbs)?;
    let dst = cache.file_path(CacheKind::Thumbs, &hash, &suffix);
    let src = PathBuf::from(&key.path);

    let dst_for_job = dst.clone();
    let out = jobs::run_blocking_on_lane(&jobs, Lane::Thumb, move || {
        let args = thumbnail_args(&src, &dst_for_job, at_sec);
        let out = jobs::ffmpeg::command("ffmpeg")?
            .args(&args)
            .output()?;
        if !out.status.success() {
            return Err(AppError::Ffmpeg(format!(
                "thumbnail failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(())
    });
    out?;
    cache.mark_used(&dst);
    Ok(dst.to_string_lossy().into_owned())
}

/* ------------------------------------------------------------------ */
/* Filmstrips                                                          */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum FilmstripResult {
    Ready { dir: String, frame_count: u32 },
    Pending { job_id: JobId, dir: String },
}

fn filmstrip_args(src: &Path, dir: &Path, interval_sec: f64, height_px: u32) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for a in [
        "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
    ] {
        args.push(a.into());
    }
    args.push("-i".into());
    args.push(src.into());
    args.push("-vf".into());
    args.push(format!("fps=1/{interval_sec},scale=-2:{height_px}").into());
    for a in ["-q:v", "6"] {
        args.push(a.into());
    }
    args.push(dir.join("%05d.jpg").into());
    args
}

fn count_frames(dir: &Path) -> u32 {
    std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "jpg"))
                .count() as u32
        })
        .unwrap_or(0)
}

#[tauri::command]
pub fn ensure_filmstrip(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    cache: State<'_, Arc<Cache>>,
    key: MediaKey,
    duration: f64,
    interval_sec: f64,
    height_px: u32,
) -> Result<FilmstripResult> {
    let interval_sec = interval_sec.max(0.1);
    let hash = key.hash();
    let suffix = format!("_h{height_px}_i{}", (interval_sec * 1000.0) as u64);
    let dir = cache.dir_path(CacheKind::Filmstrip, &hash, &suffix);
    let marker = dir.join(".complete");

    if marker.is_file() {
        cache.mark_used(&dir);
        return Ok(FilmstripResult::Ready {
            dir: dir.to_string_lossy().into_owned(),
            frame_count: count_frames(&dir),
        });
    }

    cache.ensure_kind_dir(CacheKind::Filmstrip)?;
    std::fs::create_dir_all(&dir)?;

    let handle = jobs.allocate(JobKind::Filmstrip);
    let job_id = handle.id;
    let app_clone = app.clone();
    let jobs_arc = Arc::clone(&jobs);
    let cache_arc = Arc::clone(&cache);
    let src = PathBuf::from(&key.path);
    let dir_clone = dir.clone();

    jobs.submit(
        Lane::Background,
        Box::new(move || {
            // whole directory is the "partial output" on cancel/fail
            handle.set_output(dir_clone.clone());
            let args = filmstrip_args(&src, &dir_clone, interval_sec, height_px);
            let total = if duration > 0.0 { Some(duration) } else { None };
            match jobs::execute_ffmpeg(&app_clone, &handle, args, total) {
                Ok(()) => {
                    let _ = std::fs::write(dir_clone.join(".complete"), b"");
                    cache_arc.mark_used(&dir_clone);
                    jobs::complete_job(
                        &app_clone,
                        &jobs_arc,
                        &handle,
                        serde_json::json!({
                            "dir": dir_clone.to_string_lossy(),
                            "frameCount": count_frames(&dir_clone),
                        }),
                    );
                }
                Err(failure) => {
                    jobs::fail_job(&app_clone, &jobs_arc, &handle, failure.message, failure.log_tail);
                }
            }
        }),
    );

    Ok(FilmstripResult::Pending {
        job_id,
        dir: dir.to_string_lossy().into_owned(),
    })
}
