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

/// Whether `src` is a still whose orientation tag the WebView ignores (a
/// WebP's EXIF, a PNG eXIf after the image data — measured) — so a thumbnail
/// or filmstrip of it must be decoded with `-noautorotate`, or it would show
/// the photo turned while the preview and the export show it as coded.
///
/// These jobs hold only a path, so they ask `exif::read_still` — the same
/// per-file function the probe asked when it stored the export's answer
/// (`MediaRef.noAutorotate`) for the same file, so the thumbnail is turned
/// exactly as the export is. A header read, and only ever inside the job,
/// i.e. on a cache miss. A video, a GIF, an untagged still or anything
/// unreadable keeps its autorotate — a rotated recording is turned by the
/// `<video>` element too.
fn ignores_orientation(src: &Path) -> bool {
    crate::media::exif::read_still(src).no_autorotate
}

/// The input: `-noautorotate` right before `-i` where `ignores_orientation`
/// says so, and nothing new otherwise — every other file's argv is exactly
/// what it was.
fn push_input(args: &mut Vec<OsString>, src: &Path) {
    if ignores_orientation(src) {
        args.push("-noautorotate".into());
    }
    args.push("-i".into());
    args.push(src.into());
}

fn thumbnail_args(src: &Path, dst: &Path, at_sec: f64) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for a in ["-y", "-hide_banner", "-loglevel", "error"] {
        args.push(a.into());
    }
    args.push("-ss".into());
    args.push(format!("{at_sec:.3}").into());
    push_input(&mut args, src);
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

/// Ensure a single thumbnail exists on disk for `key` at `at_sec`, generating
/// it via the thumb lane when absent, and return its cache path. Reuse-first:
/// returns the cached file immediately when present. Callers needing the frame
/// synchronously (recents refresh, editor bin) share this one code path.
pub fn ensure_thumb(cache: &Cache, jobs: &Jobs, key: &MediaKey, at_sec: f64) -> Result<PathBuf> {
    let hash = key.hash();
    let suffix = format!("_{}.jpg", (at_sec * 1000.0) as u64);
    if let Some(existing) = cache.existing_file(CacheKind::Thumbs, &hash, &suffix) {
        return Ok(existing);
    }
    cache.ensure_kind_dir(CacheKind::Thumbs)?;
    let dst = cache.file_path(CacheKind::Thumbs, &hash, &suffix);
    let src = PathBuf::from(&key.path);

    let dst_for_job = dst.clone();
    jobs::run_blocking_on_lane(jobs, Lane::Thumb, move || {
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
    })?;
    cache.mark_used(&dst);
    Ok(dst)
}

#[tauri::command]
pub fn get_thumbnail(
    jobs: State<'_, Arc<Jobs>>,
    cache: State<'_, Arc<Cache>>,
    key: MediaKey,
    at_sec: f64,
) -> Result<String> {
    ensure_thumb(&cache, &jobs, &key, at_sec).map(|p| p.to_string_lossy().into_owned())
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
    push_input(&mut args, src);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::exif::tests::{jpeg_with_exif, png_with_exif, tiff_orientation, webp_with_exif};

    fn s(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// Both jobs' argv, whole, decided per FILE: a WebP turned by its EXIF,
    /// and a PNG with the same orientation in an eXIf AFTER its image data,
    /// get `-noautorotate` right before their `-i`; the same PNG eXIf BEFORE
    /// the image data, a JPEG with that EXIF, an untagged WebP, an MP4 and an
    /// AVI (a RIFF file, like a WebP) get exactly the argv they always had.
    /// The two PNGs differ in nothing but where the chunk sits, and the two
    /// WebPs in nothing but the tag, so a decision by format fails here. Then
    /// the real thumbnail of each photo: the late PNG and the tagged WebP
    /// come out LANDSCAPE (coded, as the preview and the export show them),
    /// the early PNG and the JPEG portrait.
    #[test]
    fn a_still_the_webview_leaves_unturned_is_thumbnailed_as_coded() {
        let dir = std::env::temp_dir().join("taroting thumbs orientation");
        std::fs::create_dir_all(&dir).unwrap();
        let base = |ext: &str| {
            let p = dir.join(format!("base.{ext}"));
            let out = crate::jobs::ffmpeg::run(
                "ffmpeg",
                &["-y", "-f", "lavfi", "-i", "testsrc2=size=96x40", "-frames:v", "1", p.to_str().unwrap()],
            )
            .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            std::fs::read(&p).unwrap()
        };
        let t6 = tiff_orientation(6, false);
        let plain_webp = base("webp");
        let webp = dir.join("o6.webp");
        std::fs::write(&webp, webp_with_exif(&plain_webp, 96, 40, &t6)).unwrap();
        let untagged = dir.join("o1.webp");
        std::fs::write(&untagged, &plain_webp).unwrap();
        let jpg = dir.join("o6.jpg");
        std::fs::write(&jpg, jpeg_with_exif(&base("jpg"), &t6)).unwrap();
        let png = base("png");
        let early = dir.join("o6 early.png");
        std::fs::write(&early, png_with_exif(&png, &t6, false)).unwrap();
        let late = dir.join("o6 late.png");
        std::fs::write(&late, png_with_exif(&png, &t6, true)).unwrap();
        // Never decoded: only their magic bytes are read.
        let mp4 = dir.join("clip.mp4");
        std::fs::write(&mp4, b"\0\0\0\x18ftypmp42\0\0\0\0").unwrap();
        let avi = dir.join("clip.avi");
        std::fs::write(&avi, b"RIFF\x24\0\0\0AVI LIST").unwrap();

        let dst = dir.join("thumb.jpg");
        let strip = dir.join("strip");
        let rows = [
            (&webp, true),
            (&late, true),
            (&early, false),
            (&jpg, false),
            (&untagged, false),
            (&mp4, false),
            (&avi, false),
        ];
        for (file, raw) in rows {
            let src = file.to_string_lossy().into_owned();
            let flag: &[&str] = if raw { &["-noautorotate"] } else { &[] };
            let want_thumb: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.000"]
                .iter()
                .chain(flag)
                .chain(&["-i", src.as_str(), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5"])
                .map(|a| a.to_string())
                .chain([dst.to_string_lossy().into_owned()])
                .collect();
            assert_eq!(s(&thumbnail_args(file, &dst, 0.0)), want_thumb, "{src}");
            let want_strip: Vec<String> =
                ["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"]
                    .iter()
                    .chain(flag)
                    .chain(&["-i", src.as_str(), "-vf", "fps=1/1,scale=-2:48", "-q:v", "6"])
                    .map(|a| a.to_string())
                    .chain([strip.join("%05d.jpg").to_string_lossy().into_owned()])
                    .collect();
            assert_eq!(s(&filmstrip_args(file, &strip, 1.0, 48)), want_strip, "{src}");
        }

        for (file, landscape) in [(&webp, true), (&late, true), (&early, false), (&jpg, false)] {
            let _ = std::fs::remove_file(&dst);
            let out = crate::jobs::ffmpeg::command("ffmpeg")
                .unwrap()
                .args(thumbnail_args(file, &dst, 0.0))
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let info = crate::media::probe::probe_sync(dst.to_str().unwrap()).unwrap();
            let (w, h) = (info.width.unwrap(), info.height.unwrap());
            assert_eq!(w, THUMB_WIDTH, "{file:?}");
            assert_eq!(w > h, landscape, "{file:?}: thumbnail came out {w}x{h}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
