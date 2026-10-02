//! Thumbnails: single frames, made on the thumb lane, synchronous-ish.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::State;

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::error::{AppError, Result};
use crate::jobs::{self, Jobs, Lane};

const THUMB_WIDTH: u32 = 320;

/// Whether `src` is a still the WebView draws unturned whatever orientation
/// tag it may carry (a WebP, a TIFF, a PNG whose image data comes before any
/// eXIf — measured) — so a thumbnail of it must be decoded with
/// `-noautorotate`, or a tagged one would show the photo turned while the
/// preview and the export show it as coded. On an untagged one the flag
/// changes nothing: the thumbnail is byte-identical either way (measured).
///
/// The thumbnail job holds only a path, so it asks `exif::read_flag` — the same
/// per-file rule the probe applied when it stored the export's answer
/// (`MediaRef.noAutorotate`) for the same file, so the thumbnail is turned
/// exactly as the export is. Chunk and segment headers only, and only ever
/// inside the job, i.e. on a cache miss. A video, a GIF, a JPEG, a BMP or
/// anything unreadable keeps its autorotate — a rotated recording is turned
/// by the `<video>` element too.
///
/// Known exotic mismatch: this decides by magic bytes, not media kind, so an
/// APNG (probed as a video, exported autorotated) is thumbnailed `-noautorotate`.
fn ignores_orientation(src: &Path) -> bool {
    crate::media::exif::read_flag(src).no_autorotate
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
    jobs::run_blocking_on_lane(jobs, Lane::Thumb, move |abandoned| {
        let args = thumbnail_args(&src, &dst_for_job, at_sec);
        // The caller has given up (reading the orientation above can be slow
        // on a dead network share): nobody wants this frame any more, so no
        // ffmpeg is spent on it.
        if abandoned.load(Ordering::Relaxed) {
            return Err(AppError::Ffmpeg("thumbnail abandoned".into()));
        }
        let mut cmd = jobs::ffmpeg::command("ffmpeg")?;
        cmd.args(&args);
        let out = jobs::ffmpeg::output_owned(&mut cmd)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::exif::tests::{jpeg_with_exif, png_with_exif, tiff_orientation, webp_with_exif};

    fn s(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// The thumbnail argv, whole, decided per FILE: a WebP turned by its EXIF,
    /// an untagged WebP, a PNG with the same orientation in an eXIf AFTER its
    /// image data and an untagged PNG get `-noautorotate` right before their
    /// `-i`; the same PNG eXIf BEFORE the image data, a JPEG with that EXIF, a
    /// BMP, an MP4 and an AVI (a RIFF file, like a WebP) get exactly the argv
    /// they always had. The two tagged PNGs differ in nothing but where the
    /// chunk sits, so a decision by format fails here. Then the real
    /// thumbnail of each photo: the late PNG and the tagged WebP come out
    /// LANDSCAPE (coded, as the preview and the export show them), the early
    /// PNG and the JPEG portrait.
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
        let plain_png = dir.join("o1.png");
        std::fs::write(&plain_png, &png).unwrap();
        let bmp = dir.join("plain.bmp");
        std::fs::write(&bmp, base("bmp")).unwrap();
        // Never decoded: only their magic bytes are read.
        let mp4 = dir.join("clip.mp4");
        std::fs::write(&mp4, b"\0\0\0\x18ftypmp42\0\0\0\0").unwrap();
        let avi = dir.join("clip.avi");
        std::fs::write(&avi, b"RIFF\x24\0\0\0AVI LIST").unwrap();

        let dst = dir.join("thumb.jpg");
        let rows = [
            (&webp, true),
            (&late, true),
            (&untagged, true),
            (&plain_png, true),
            (&early, false),
            (&jpg, false),
            (&bmp, false),
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

        // What lets `cache::RECIPE_VERSION` stay put: an untagged PNG or WebP
        // is flagged now and was not before, and its thumbnail is the same
        // bytes either way — so no cache a shipped build wrote goes stale.
        for file in [&plain_png, &untagged] {
            let thumb = |args: Vec<OsString>| {
                let _ = std::fs::remove_file(&dst);
                let out = crate::jobs::ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
                std::fs::read(&dst).unwrap()
            };
            let flagged = thumbnail_args(file, &dst, 0.0);
            let plain: Vec<OsString> = flagged.iter().filter(|a| *a != "-noautorotate").cloned().collect();
            assert_eq!(flagged.len(), plain.len() + 1, "{file:?} is flagged");
            assert!(thumb(flagged) == thumb(plain), "{file:?}: -noautorotate changed an untagged thumbnail");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
