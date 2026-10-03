//! Thumbnails: single frames, made on the thumb lane.
//!
//! The command is async and every wait happens on a blocking-pool thread:
//! the editor asks for one thumbnail per visual media as it mounts, and when
//! `get_thumbnail` was a plain command each one held the WebView's UI thread
//! for its whole ffmpeg run — a cold project froze the window for the sum of
//! them. What the lane worker does once it picks a request up is bounded
//! ([`THUMB_BUDGET`], the child killed when it runs out), so one stalled file
//! (a sleeping share, a cloud file still hydrating) costs its own budget and
//! nothing more, instead of wedging every request queued behind it.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::State;

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::error::{AppError, Result};
use crate::jobs::{self, Jobs, Lane};
use crate::media::source::{source_file, INPUT_PROTOCOL_ARGS};

const THUMB_WIDTH: u32 = 320;

/// How long the lane worker may spend on one thumbnail, counted from the
/// moment it picks the request up and shared by both attempts (see
/// `make_thumb`). Under `run_blocking_on_lane`'s own 30 s on purpose: the
/// child is killed and the lane is free again before the caller gives up, so
/// nothing keeps running for a request nobody is waiting on.
const THUMB_BUDGET: Duration = Duration::from_secs(20);

/// The furthest `-ss` a request may ask for. Only an absurd value meets it:
/// `at_sec` arrives from the webview, and a week is longer than any media.
const MAX_AT_SEC: f64 = 7.0 * 24.0 * 3600.0;

/// `at_sec` as a seek this code can format: a NaN, an infinity or a negative
/// number (from a crafted `.trt` via the frontend) would reach `-ss` as text
/// ffmpeg refuses, or as a 300-digit number. Every ordinary value is returned
/// unchanged, so the cache names of existing thumbnails stay what they were.
fn seek_of(at_sec: f64) -> f64 {
    if at_sec.is_finite() && at_sec > 0.0 {
        at_sec.min(MAX_AT_SEC)
    } else {
        0.0
    }
}

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

/// The input: `-noautorotate` where `ignores_orientation` says so, then the
/// file-only protocol list right before `-i` (`media::source`) — the path
/// came out of a `.trt`, and the bundled ffmpeg would open a URL here.
fn push_input(args: &mut Vec<OsString>, src: &Path) {
    if ignores_orientation(src) {
        args.push("-noautorotate".into());
    }
    args.extend(INPUT_PROTOCOL_ARGS.iter().map(OsString::from));
    args.push("-i".into());
    args.push(src.into());
}

/// The muxer and encoder are named rather than read off the output's
/// extension, because ffmpeg writes to a `.tmp` name (see `make_thumb`) and
/// could not tell a muxer from that. They are exactly what `.jpg` picked, so
/// the bytes are unchanged (pinned in the tests). `-update 1` writes ONE file
/// under the name as given: the image2 muxer otherwise reads a `%d` in the
/// path as a frame-number pattern, and a profile folder may contain a `%`.
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
    for a in ["-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "-update", "1"] {
        args.push(a.into());
    }
    args.push(dst.into());
    args
}

/// A finished thumbnail: a file with something in it. A 0-byte file is what a
/// write cut short used to leave at the final name (ffmpeg wrote there
/// directly), and it was served as a valid thumbnail forever; it now counts
/// as missing, so such a leftover heals on the next request.
fn is_ready(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}

/// First already-generated thumbnail for a media hash (used for recents).
/// Skips empty files for the reason `is_ready` gives. A partial file never
/// matches at all: its name starts with `~`, not the hash (`tmp_path_for`).
pub fn any_thumb_for(cache: &Cache, hash: &str) -> Option<PathBuf> {
    let dir = cache.root().join(CacheKind::Thumbs.dir_name());
    let read = std::fs::read_dir(dir).ok()?;
    for entry in read.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(hash) && entry.metadata().is_ok_and(|m| m.len() > 0) {
            return Some(entry.path());
        }
    }
    None
}

/// The partial file one attempt writes before it is renamed onto `dst`.
///
/// Unique per attempt (process id and a counter), so two runs never write the
/// same file. It starts with `~` rather than the media hash on purpose: every
/// lookup that serves a thumbnail by hash — `any_thumb_for` here, the recents
/// listing in `project/store.rs` — matches names that START with the hash,
/// and would hand Home a file ffmpeg is still writing. A partial orphaned by a
/// crash needs no sweep of its own: `Cache::enforce_limit` lists every file in
/// the kind dir, so it ages out LRU like any other.
fn tmp_path_for(dst: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dst.with_file_name(format!("~{name}.{}.{n}.tmp", std::process::id()))
}

/// A partial file, deleted when this goes out of scope — on EVERY way out of
/// an attempt: killed at the deadline, failed, empty, or a rename that did
/// not happen. After a successful rename there is nothing left at the path
/// and the delete is a no-op. One rule in one place, rather than a remove
/// on each path that a later edit could miss.
struct Partial(PathBuf);

impl Drop for Partial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Nothing behind these locks is left half-updated by a panic, and with
    // `panic = "abort"` a poisoned lock would only turn a thumbnail into a
    // dead process.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/* ------------------------------------------------------------------ */
/* Failures worth remembering                                          */
/* ------------------------------------------------------------------ */

/// Thumbnails ffmpeg has already failed to make, by destination path — which
/// carries the source's path, size and mtime (`MediaKey::hash`), so a file
/// that changes, or a different file at the same path, is a new name and is
/// tried afresh.
///
/// Home retries a thumb-less card on every visit, which is right for a
/// missing file (a drive that comes back heals the card) and wasteful for a
/// file that is present but undecodable: that spawned ffmpeg again on every
/// Home mount, for the same answer. Only a run that FINISHED and made no
/// frame is remembered (`make_thumb`); a timeout, a refused or missing source,
/// a file another program has locked and a child that would not start are
/// all retried next time, because each can be different next time.
///
/// In memory only, so a restart retries everything; Clear cache does too
/// (`forget_failures`).
static FAILED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

fn failed_before(dst: &Path) -> bool {
    lock(&FAILED).contains(dst)
}

fn remember_failure(dst: &Path) {
    lock(&FAILED).insert(dst.to_path_buf());
}

/// Forget every remembered failure, so the next request for each tries
/// ffmpeg again. For Clear cache: the one action a user takes to say "redo
/// all of it".
// Called from `cache::clear_cache`, which wires it in this same release.
#[allow(dead_code)]
pub fn forget_failures() {
    lock(&FAILED).clear();
}

/* ------------------------------------------------------------------ */
/* One run per destination                                             */
/* ------------------------------------------------------------------ */

/// One thumbnail being made, and its outcome once it is known.
#[derive(Default)]
struct Flight {
    outcome: Mutex<Option<std::result::Result<(), String>>>,
    landed: Condvar,
}

/// The thumbnails being made right now, by destination path.
///
/// The editor and Home can ask for the same thumbnail at the same moment (a
/// project's first card is its first clip; two editors mounting one media),
/// and each request used to queue its own ffmpeg onto the same file. Now the
/// first request makes it and every request that arrives while it runs waits
/// for that one outcome instead of queueing a second run.
#[derive(Default)]
struct Flights(Mutex<HashMap<PathBuf, Arc<Flight>>>);

impl Flights {
    /// Run `make` for `dst` unless a run for it is already under way, in which
    /// case wait for that run's outcome. The slot is freed only AFTER `make`
    /// returns — by then a successful run has already renamed its file onto
    /// `dst` — so a request can never find neither the file nor the run and
    /// start a duplicate in between. (A request that checked for the file just
    /// before the rename and reaches here just after the slot is freed starts
    /// a run that finds the file and returns at once: `make_on_lane` looks
    /// before it spends anything.)
    fn run(&self, dst: &Path, make: impl FnOnce() -> Result<()>) -> Result<()> {
        let (flight, leads) = {
            let mut map = lock(&self.0);
            match map.get(dst) {
                Some(f) => (Arc::clone(f), false),
                None => {
                    let f = Arc::new(Flight::default());
                    map.insert(dst.to_path_buf(), Arc::clone(&f));
                    (f, true)
                }
            }
        };
        if !leads {
            let mut outcome = lock(&flight.outcome);
            loop {
                if let Some(o) = outcome.as_ref() {
                    return o.clone().map_err(AppError::Ffmpeg);
                }
                outcome = flight.landed.wait(outcome).unwrap_or_else(|e| e.into_inner());
            }
        }
        let result = make();
        *lock(&flight.outcome) = Some(result.as_ref().map(|_| ()).map_err(ToString::to_string));
        lock(&self.0).remove(dst);
        flight.landed.notify_all();
        result
    }
}

static FLIGHTS: LazyLock<Flights> = LazyLock::new(Flights::default);

/* ------------------------------------------------------------------ */
/* Making one                                                          */
/* ------------------------------------------------------------------ */

/// What a lane run came to, short of an error worth retrying.
enum Made {
    Done,
    /// ffmpeg ran to the end and no frame came out, from the requested time
    /// or from the start: the file is present but undecodable.
    NoFrame(String),
}

/// ffmpeg's own words for a file it may not open — another program holding
/// it exclusively. That ends when the other program lets go, and the file's
/// identity does not change, so it is not remembered as undecodable.
fn is_locked_out(stderr: &str) -> bool {
    stderr.contains("Permission denied")
}

/// Make the thumbnail of `src` at `at_sec` into `dst`, within `until`.
///
/// ffmpeg writes to a partial name (`tmp_path_for`) that is renamed onto
/// `dst` only once it holds a frame; a run that is killed, fails or writes
/// nothing deletes its partial and leaves `dst` absent. Writing to `dst`
/// directly is what let a killed or 0-byte write be served as a valid
/// thumbnail forever.
///
/// A run that ends without a frame and was asked for a time past zero is
/// tried once more from the start: a seek past the last frame decodes
/// nothing — with exit 0 and no file on a full-range source, an encoder
/// error on others (both measured) — and before this the missing path was
/// returned as if it were the thumbnail, then stored in recents. A run the
/// deadline killed is not retried: the time is spent.
fn make_thumb(src: &Path, dst: &Path, at_sec: f64, until: Instant, abandoned: &AtomicBool) -> Result<Made> {
    let mut seeks = vec![at_sec];
    if at_sec > 0.0 {
        seeks.push(0.0);
    }
    let mut last_words = String::new();
    for at in seeks {
        // The caller has given up (reading the orientation can be slow on a
        // dead network share): nobody wants this frame any more, so no
        // ffmpeg is spent on it.
        if abandoned.load(Ordering::Relaxed) {
            return Err(AppError::Ffmpeg("thumbnail abandoned".into()));
        }
        let tmp = Partial(tmp_path_for(dst));
        // Built first: the argv reads the file's header (`ignores_orientation`),
        // and that time comes out of the budget too, so ffmpeg's deadline
        // never runs past the lane's.
        let args = thumbnail_args(src, &tmp.0, at);
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(AppError::Ffmpeg("thumbnail timed out".into()));
        }
        let mut cmd = jobs::ffmpeg::command("ffmpeg")?;
        cmd.args(args);
        #[cfg(test)]
        tests::count_run(dst);
        let ran = jobs::ffmpeg::run_with_deadline(cmd, left);
        let out = match ran {
            Ok(Some(out)) => out,
            Ok(None) => return Err(AppError::Ffmpeg("thumbnail timed out".into())),
            Err(e) => return Err(e.into()),
        };
        if out.status.success() && is_ready(&tmp.0) {
            std::fs::rename(&tmp.0, dst)?;
            return Ok(Made::Done);
        }
        drop(tmp);
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if is_locked_out(&stderr) {
            return Err(AppError::Ffmpeg(format!("thumbnail failed: {stderr}")));
        }
        last_words = stderr;
    }
    Ok(Made::NoFrame(if last_words.is_empty() {
        "thumbnail failed: no frame could be decoded".into()
    } else {
        format!("thumbnail failed: {last_words}")
    }))
}

/// Queue the thumbnail on the thumb lane and wait for it (the lane's wait is
/// counted from when a worker picks it up — `run_blocking_on_lane`).
fn make_on_lane(jobs: &Jobs, src: PathBuf, dst: PathBuf, at_sec: f64, budget: Duration) -> Result<()> {
    jobs::run_blocking_on_lane(jobs, Lane::Thumb, move |abandoned| {
        let until = Instant::now() + budget;
        if abandoned.load(Ordering::Relaxed) {
            return Err(AppError::Ffmpeg("thumbnail abandoned".into()));
        }
        // An earlier run whose caller gave up may have finished it since.
        if is_ready(&dst) {
            return Ok(());
        }
        match make_thumb(&src, &dst, at_sec, until, &abandoned)? {
            Made::Done => Ok(()),
            Made::NoFrame(message) => {
                remember_failure(&dst);
                Err(AppError::Ffmpeg(message))
            }
        }
    })
}

/// Ensure a single thumbnail exists on disk for `key` at `at_sec`, generating
/// it via the thumb lane when absent, and return its cache path. Reuse-first:
/// returns the cached file immediately when present — before the source is
/// even looked at, so an offline file keeps the thumbnail it already has.
/// Blocking: call it off the UI thread. `get_thumbnail` does; the recents
/// refresh (`project/store.rs`) must too.
pub fn ensure_thumb(cache: &Cache, jobs: &Jobs, key: &MediaKey, at_sec: f64) -> Result<PathBuf> {
    ensure_thumb_within(cache, jobs, key, at_sec, THUMB_BUDGET)
}

/// `ensure_thumb` with the lane budget as a parameter, so a test can run the
/// deadline out in milliseconds.
fn ensure_thumb_within(
    cache: &Cache,
    jobs: &Jobs,
    key: &MediaKey,
    at_sec: f64,
    budget: Duration,
) -> Result<PathBuf> {
    let at = seek_of(at_sec);
    let hash = key.hash();
    let suffix = format!("_{}.jpg", (at * 1000.0) as u64);
    let dst = cache.file_path(CacheKind::Thumbs, &hash, &suffix);
    if is_ready(&dst) {
        cache.mark_used(&dst);
        return Ok(dst);
    }
    // The path is the `.trt`'s: refused unless it names a real file, so a URL
    // or a device never reaches ffmpeg (`media::source`).
    let src = source_file(&key.path)?.to_path_buf();
    if failed_before(&dst) {
        return Err(AppError::Ffmpeg(
            "thumbnail failed: this file had no frame Taroting could decode".into(),
        ));
    }
    cache.ensure_kind_dir(CacheKind::Thumbs)?;
    FLIGHTS.run(&dst, || make_on_lane(jobs, src, dst.clone(), at, budget))?;
    cache.mark_used(&dst);
    Ok(dst)
}

/// Async, with the work on a blocking-pool thread: see the module docs. The
/// payload is the same path string the sync command returned.
#[tauri::command]
pub async fn get_thumbnail(
    jobs: State<'_, Arc<Jobs>>,
    cache: State<'_, Arc<Cache>>,
    key: MediaKey,
    at_sec: f64,
) -> Result<String> {
    let (jobs, cache) = (Arc::clone(&jobs), Arc::clone(&cache));
    tauri::async_runtime::spawn_blocking(move || ensure_thumb(&cache, &jobs, &key, at_sec))
        .await
        .map_err(|e| AppError::Ffmpeg(format!("thumbnail task failed: {e}")))?
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::exif::tests::{jpeg_with_exif, png_with_exif, tiff_orientation, webp_with_exif};

    fn s(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// ffmpeg runs started for each destination, so a test can tell "made
    /// once" from "made again" without timing anything. Keyed by destination
    /// because the tests run in parallel and each uses its own.
    static RUNS: LazyLock<Mutex<HashMap<PathBuf, usize>>> = LazyLock::new(Default::default);

    pub(super) fn count_run(dst: &Path) {
        *lock(&RUNS).entry(dst.to_path_buf()).or_default() += 1;
    }

    fn runs(dst: &Path) -> usize {
        lock(&RUNS).get(dst).copied().unwrap_or(0)
    }

    /// A fresh folder for one test, with a cache inside it.
    fn scratch(name: &str) -> (PathBuf, Cache) {
        let dir = std::env::temp_dir().join(format!("taroting thumbs {name} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cache = Cache::new_at(dir.join("cache"));
        (dir, cache)
    }

    fn encode(out: &Path, args: &[&str]) {
        let mut all = vec!["-y"];
        all.extend_from_slice(args);
        all.push(out.to_str().unwrap());
        let res = crate::jobs::ffmpeg::run("ffmpeg", &all).unwrap();
        assert!(res.status.success(), "{}", String::from_utf8_lossy(&res.stderr));
    }

    /// A one-second limited-range H.264 clip.
    fn clip(dir: &Path) -> PathBuf {
        let p = dir.join("clip one.mp4");
        encode(&p, &[
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]);
        p
    }

    fn key_of(path: &Path, mtime_ms: u64) -> MediaKey {
        MediaKey { path: path.to_string_lossy().into_owned(), size: 1234, mtime_ms }
    }

    fn partials(cache: &Cache) -> Vec<String> {
        std::fs::read_dir(cache.root().join(CacheKind::Thumbs.dir_name()))
            .map(|r| {
                r.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every thumbnail input is limited to plain files, flagged still or not.
    #[test]
    fn the_thumbnail_input_is_files_only() {
        let dir = std::env::temp_dir().join(format!("taroting thumbs argv {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let webp = dir.join("plain.webp");
        std::fs::write(&webp, b"RIFF\x1a\0\0\0WEBPVP8L\x0d\0\0\0\x2f\0\0\0\x10\x07\x10\x11\x11\x88\x88\xfe\x07\0").unwrap();
        let mp4 = dir.join("clip.mp4");
        std::fs::write(&mp4, b"\0\0\0\x18ftypmp42\0\0\0\0").unwrap();
        for src in [&webp, &mp4] {
            let args = thumbnail_args(src, &dir.join("t.tmp"), 1.5);
            crate::media::source::assert_inputs_whitelisted(&args);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The muxer and encoder named for the `.tmp` output, `-update 1` and the
    /// protocol list change no byte of the thumbnail: the argv before them,
    /// written to a `.jpg`, makes the identical file. This is what lets
    /// `cache::RECIPE_VERSION` stay put — no cached thumbnail goes stale.
    #[test]
    fn the_named_muxer_writes_the_same_bytes_the_extension_did() {
        let (dir, _cache) = scratch("bytes");
        let src = clip(&dir);
        let tmp = dir.join("new.123.tmp");
        let jpg = dir.join("old.jpg");
        let new_args = thumbnail_args(&src, &tmp, 0.5);
        let old_args: Vec<OsString> = {
            let named = ["-protocol_whitelist", "file", "-f", "image2", "-c:v", "mjpeg", "-update", "1"];
            let mut v: Vec<OsString> = Vec::new();
            let mut i = 0;
            let n = new_args.len() - 1;
            while i < n {
                let pair_start = new_args[i].to_str().is_some_and(|a| named.contains(&a))
                    && new_args.get(i + 1).and_then(|b| b.to_str()).is_some_and(|b| named.contains(&b));
                if pair_start {
                    i += 2;
                } else {
                    v.push(new_args[i].clone());
                    i += 1;
                }
            }
            v.push(jpg.clone().into());
            v
        };
        assert_eq!(old_args.len(), new_args.len() - 8, "{:?}", s(&old_args));
        for args in [new_args, old_args] {
            let out = crate::jobs::ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let (a, b) = (std::fs::read(&tmp).unwrap(), std::fs::read(&jpg).unwrap());
        assert!(!a.is_empty());
        assert!(a == b, "the named muxer changed the thumbnail");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A URL, a device and a missing file are refused as bad input with no
    /// ffmpeg started and nothing written: the path comes out of a `.trt`.
    #[test]
    fn a_path_that_is_not_a_file_never_reaches_ffmpeg() {
        let (dir, cache) = scratch("refused");
        let jobs = Jobs::default();
        for path in ["https://example.com/clip.mp4", r"\\.\pipe\clip.mp4", "clip.mp4"] {
            let key = MediaKey { path: path.into(), size: 9, mtime_ms: 9 };
            let dst = cache.file_path(CacheKind::Thumbs, &key.hash(), "_500.jpg");
            match ensure_thumb(&cache, &jobs, &key, 0.5) {
                Err(AppError::BadInput(_)) => {}
                other => panic!("{path}: {other:?}"),
            }
            assert_eq!(runs(&dst), 0, "{path}");
            assert!(!dst.exists(), "{path}");
        }
        let gone = dir.join("gone.mp4");
        assert!(matches!(ensure_thumb(&cache, &jobs, &key_of(&gone, 1), 0.5), Err(AppError::BadInput(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An empty file at the final name — what a write cut short left there —
    /// is made again rather than served, by `ensure_thumb` and by the recents
    /// lookup alike.
    #[test]
    fn an_empty_leftover_is_made_again() {
        let (dir, cache) = scratch("empty");
        let jobs = Jobs::default();
        let key = key_of(&clip(&dir), 11);
        cache.ensure_kind_dir(CacheKind::Thumbs).unwrap();
        let dst = cache.file_path(CacheKind::Thumbs, &key.hash(), "_500.jpg");
        std::fs::write(&dst, b"").unwrap();
        assert_eq!(any_thumb_for(&cache, &key.hash()), None, "an empty file is not a thumbnail");

        let made = ensure_thumb(&cache, &jobs, &key, 0.5).unwrap();
        assert_eq!(made, dst);
        assert!(std::fs::metadata(&dst).unwrap().len() > 0);
        assert_eq!(runs(&dst), 1);
        assert_eq!(any_thumb_for(&cache, &key.hash()), Some(dst.clone()));
        // And a second request is a plain cache hit.
        ensure_thumb(&cache, &jobs, &key, 0.5).unwrap();
        assert_eq!(runs(&dst), 1);
        assert!(partials(&cache).is_empty(), "{:?}", partials(&cache));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Asked for a time past the last frame, the thumbnail comes from the
    /// start instead. A full-range source (MJPEG yuvj420p) made ffmpeg exit 0
    /// with no file, and the missing path was returned as the thumbnail; a
    /// limited-range one failed outright. Both now come back as a real frame,
    /// after exactly two runs. Asked for 0, only one run is ever made.
    #[test]
    fn a_seek_past_the_end_falls_back_to_the_first_frame() {
        let (dir, cache) = scratch("past end");
        let jobs = Jobs::default();
        let full = dir.join("full range.avi");
        encode(&full, &[
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1",
            "-c:v", "mjpeg", "-pix_fmt", "yuvj420p",
        ]);
        let limited = clip(&dir);
        for (src, mtime) in [(&full, 21), (&limited, 22)] {
            let key = key_of(src, mtime);
            let thumb = ensure_thumb(&cache, &jobs, &key, 5.0).unwrap_or_else(|e| panic!("{src:?}: {e}"));
            assert!(std::fs::metadata(&thumb).unwrap().len() > 0, "{src:?}");
            assert_eq!(runs(&thumb), 2, "{src:?}: the seek, then the start");
        }
        let key = key_of(&limited, 23);
        let at_zero = ensure_thumb(&cache, &jobs, &key, 0.0).unwrap();
        assert_eq!(runs(&at_zero), 1);
        assert!(partials(&cache).is_empty(), "{:?}", partials(&cache));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A run that outlives its budget is killed and leaves nothing behind —
    /// no final file, no partial — and is NOT remembered as a failure: the
    /// same request with time to spare then succeeds.
    ///
    /// The INPUT is what is slow, not the budget that is short: a 4K clip
    /// whose only keyframe is its first frame, asked for a frame near its end,
    /// makes ffmpeg decode ~29 s of frames to get there (about 0.7 s on a fast
    /// machine, longer on any slower one), while the file stays tiny because
    /// every frame is the same grey. The file is read once beforehand, so a
    /// cold cache or a first antivirus look cannot spend the budget before the
    /// run starts — with a budget of milliseconds that started no run at all
    /// and failed on timing.
    #[test]
    fn a_run_out_of_time_is_killed_and_leaves_nothing() {
        let (dir, cache) = scratch("deadline");
        let jobs = Jobs::default();
        let src = dir.join("one keyframe.mp4");
        encode(&src, &[
            "-f", "lavfi", "-i", "color=c=gray:size=3840x2160:rate=30:duration=30",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-x264-params", "keyint=infinite:scenecut=0",
        ]);
        std::fs::read(&src).unwrap();
        ignores_orientation(&src);
        let key = key_of(&src, 31);
        let dst = cache.file_path(CacheKind::Thumbs, &key.hash(), "_29500.jpg");
        let started = Instant::now();
        let err = ensure_thumb_within(&cache, &jobs, &key, 29.5, Duration::from_millis(150)).unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5), "killed at the deadline: {:?}", started.elapsed());
        assert_eq!(runs(&dst), 1, "started, killed, and not tried from the start");
        assert!(!dst.exists());
        assert!(partials(&cache).is_empty(), "{:?}", partials(&cache));
        assert!(!failed_before(&dst));
        ensure_thumb(&cache, &jobs, &key, 29.5).unwrap();
        assert!(is_ready(&dst));
        assert_eq!(runs(&dst), 2, "the frame is there for a run with time to decode it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A present but undecodable file costs ONE run, then is answered from
    /// memory — until its identity changes (a new name: tried again) or Clear
    /// cache forgets the failures.
    #[test]
    fn an_undecodable_file_is_not_retried_until_it_changes_or_is_forgotten() {
        let (dir, cache) = scratch("undecodable");
        let jobs = Jobs::default();
        let junk = dir.join("junk.mp4");
        std::fs::write(&junk, vec![0x5au8; 4096]).unwrap();
        let key = key_of(&junk, 41);
        let dst = cache.file_path(CacheKind::Thumbs, &key.hash(), "_0.jpg");

        assert!(ensure_thumb(&cache, &jobs, &key, 0.0).is_err());
        assert_eq!(runs(&dst), 1);
        assert!(ensure_thumb(&cache, &jobs, &key, 0.0).is_err());
        assert_eq!(runs(&dst), 1, "the second request must not run ffmpeg again");

        let changed = key_of(&junk, 42);
        let changed_dst = cache.file_path(CacheKind::Thumbs, &changed.hash(), "_0.jpg");
        assert!(ensure_thumb(&cache, &jobs, &changed, 0.0).is_err());
        assert_eq!(runs(&changed_dst), 1, "a changed file is tried afresh");

        forget_failures();
        assert!(ensure_thumb(&cache, &jobs, &key, 0.0).is_err());
        assert_eq!(runs(&dst), 2, "forgotten, so tried again");
        assert!(!dst.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Four requests for one thumbnail at once make it once and all get it.
    #[test]
    fn concurrent_requests_for_one_thumbnail_make_it_once() {
        let (dir, cache) = scratch("concurrent");
        let cache = Arc::new(cache);
        let jobs = Arc::new(Jobs::default());
        let key = key_of(&clip(&dir), 51);
        let dst = cache.file_path(CacheKind::Thumbs, &key.hash(), "_250.jpg");
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (cache, jobs, key) = (Arc::clone(&cache), Arc::clone(&jobs), key.clone());
                std::thread::spawn(move || ensure_thumb(&cache, &jobs, &key, 0.25))
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap().unwrap(), dst);
        }
        assert_eq!(runs(&dst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A request arriving while a run for the same destination is under way
    /// waits for THAT run's outcome — an error included — and runs nothing of
    /// its own; once the run has landed, the next request runs afresh.
    #[test]
    fn a_second_request_waits_for_the_running_one() {
        let flights = Arc::new(Flights::default());
        let dst = PathBuf::from(r"C:\cache\thumbs\0011223344556677_500.jpg");
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let leader = {
            let (flights, dst) = (Arc::clone(&flights), dst.clone());
            std::thread::spawn(move || {
                flights.run(&dst, || {
                    started_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                    Err(AppError::Ffmpeg("no frame".into()))
                })
            })
        };
        started_rx.recv().unwrap();
        let follower_ran = Arc::new(AtomicBool::new(false));
        let follower = {
            let (flights, dst, ran) = (Arc::clone(&flights), dst.clone(), Arc::clone(&follower_ran));
            std::thread::spawn(move || {
                flights.run(&dst, || {
                    ran.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        // The follower has joined once it holds its own reference to the
        // flight (the map's, the leader's and the follower's).
        let flight = Arc::clone(lock(&flights.0).get(&dst).unwrap());
        while Arc::strong_count(&flight) < 4 {
            std::thread::yield_now();
        }
        drop(flight);
        go_tx.send(()).unwrap();
        assert_eq!(leader.join().unwrap().unwrap_err().to_string(), "no frame");
        assert_eq!(follower.join().unwrap().unwrap_err().to_string(), "no frame");
        assert!(!follower_ran.load(Ordering::SeqCst), "the follower must not run its own");
        assert!(lock(&flights.0).is_empty(), "the slot is freed");
        assert!(flights.run(&dst, || Ok(())).is_ok(), "a later request runs afresh");
    }

    /// A partial is gone however its attempt ends; a renamed one leaves the
    /// renamed file alone.
    #[test]
    fn a_partial_never_outlives_its_attempt() {
        let (dir, _cache) = scratch("partial");
        let dst = dir.join("0123_500.jpg");
        let abandoned = Partial(tmp_path_for(&dst));
        std::fs::write(&abandoned.0, b"half a jpeg").unwrap();
        let left = abandoned.0.clone();
        drop(abandoned);
        assert!(!left.exists(), "an abandoned partial must be deleted");

        let kept = Partial(tmp_path_for(&dst));
        std::fs::write(&kept.0, b"a whole jpeg").unwrap();
        std::fs::rename(&kept.0, &dst).unwrap();
        drop(kept);
        assert_eq!(std::fs::read(&dst).unwrap(), b"a whole jpeg");
        let name = tmp_path_for(&dst).file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("~0123_500.jpg.") && name.ends_with(".tmp"), "{name}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Out-of-range seeks become something ffmpeg can parse, and every
    /// ordinary one is left alone (it names the cache file).
    #[test]
    fn seeks_are_sanitized_without_moving_ordinary_ones() {
        for at in [0.0, 0.25, 0.5, 3.75, 120.0] {
            assert_eq!(seek_of(at), at);
        }
        for bad in [f64::NAN, f64::NEG_INFINITY, -0.5] {
            assert_eq!(seek_of(bad), 0.0, "{bad}");
        }
        assert_eq!(seek_of(f64::INFINITY), 0.0);
        assert_eq!(seek_of(1e300), MAX_AT_SEC);
    }

    /// The command must not run on the UI thread: an async command with the
    /// work on the blocking pool. Pinned in the source, because the command
    /// needs a Tauri runtime to call. Only the code before the test module is
    /// searched (both needles also appear as literals in this test), and the
    /// split must find that module: a checkout with CRLF line endings missed
    /// it, searched the whole file and passed with the command reverted.
    #[test]
    fn get_thumbnail_runs_off_the_ui_thread() {
        let file = include_str!("thumbs.rs").replace("\r\n", "\n");
        let (code, _) = file.split_once("#[cfg(test)]\nmod tests {").expect("the test module is found");
        let code: String = code.split_whitespace().collect();
        assert!(code.contains("pubasyncfnget_thumbnail("));
        assert!(code.contains("spawn_blocking(move||ensure_thumb(&cache,&jobs,&key,at_sec))"));
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
                .chain(&["-protocol_whitelist", "file", "-i", src.as_str()])
                .chain(&["-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5"])
                .chain(&["-f", "image2", "-c:v", "mjpeg", "-update", "1"])
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
