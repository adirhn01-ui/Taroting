//! Derived-file cache: %LOCALAPPDATA%\Taroting\cache\{remux,proxy,waveform,thumbs,filmstrip}.
//!
//! Every entry is keyed by xxh3(path|size|mtime) of its SOURCE media, so any
//! change to a source file automatically invalidates its derived files.
//! A small index tracks last-use for LRU eviction against the user's cap.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::DirEntry;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use xxhash_rust::xxh3::xxh3_64;

use crate::error::{AppError, Result};
use crate::paths;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaKey {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// The version of the RECIPES that turn a source file into its derived files.
///
/// **Bump this whenever any recipe changes.** That means `prepare::proxy_args`,
/// `remux_args`, `audio_remux_args`, `gif_proxy_args`, `thumbs`' `THUMB_WIDTH`
/// or its scale/quality flags, and the waveform format (`SAMPLE_RATE`,
/// `PAIRS_PER_SEC`, the `TPK1` layout) — anything whose output bytes would
/// differ for an unchanged input file.
///
/// Without it the key covered only the SOURCE: `{path, size, mtime}` says
/// nothing about how the derived file was produced, so a build that widened
/// thumbnails or changed the proxy's CRF kept serving every previously cached
/// output, forever, for any file the user had not touched. The bug reads as
/// "the setting did nothing" on exactly the machines with the most cache.
///
/// Bumping it orphans the existing entries rather than deleting them — the new
/// keys simply miss, and LRU eviction reclaims the old files against the user's
/// cap in the normal way.
///
/// The key is GLOBAL: a bump re-derives every proxy, remux and waveform too, so
/// it is owed only when some input a SHIPPED build could have cached now comes
/// out different. v0.9 added `-noautorotate` to thumbnails/filmstrips of stills
/// the WebView draws unturned (`exif::read_flag`: every WebP and TIFF, and a
/// PNG whose first IDAT comes before any eXIf — tagged or not) and
/// deliberately did NOT bump. WebP/TIFF were not importable in any released
/// build; JPEG and early-eXIf PNG argv is unchanged; and on an UNTAGGED PNG —
/// the one flagged input a 0.8.1 cache holds in bulk — the flag is a no-op:
/// its thumbnail is byte-identical with and without it (measured on the
/// bundled ffmpeg, pinned in `thumbs.rs`'s tests). The one stale shape left is
/// the thumbnail of a PNG with an orientation tag after its image data, served
/// turned where the preview is not. That is cosmetic and very rare, and it
/// heals on Clear cache, on LRU eviction or when the file is re-saved —
/// re-deriving every user's proxies and waveforms for it would not be
/// proportionate.
pub const RECIPE_VERSION: u32 = 1;

impl MediaKey {
    pub fn hash(&self) -> String {
        self.hash_with(RECIPE_VERSION)
    }

    /// The identity actually hashed: source file identity AND the recipe version
    /// that produced the derived file. Split out so a test can prove the version
    /// participates without waiting for a real recipe change to prove it.
    fn hash_with(&self, recipe: u32) -> String {
        let ident = format!("{}|{}|{}|r{}", self.path, self.size, self.mtime_ms, recipe);
        format!("{:016x}", xxh3_64(ident.as_bytes()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheKind {
    Remux,
    Proxy,
    Waveform,
    Thumbs,
    Filmstrip,
}

impl CacheKind {
    pub fn dir_name(self) -> &'static str {
        match self {
            CacheKind::Remux => "remux",
            CacheKind::Proxy => "proxy",
            CacheKind::Waveform => "waveform",
            CacheKind::Thumbs => "thumbs",
            CacheKind::Filmstrip => "filmstrip",
        }
    }
}

const ALL_KINDS: [CacheKind; 5] = [
    CacheKind::Remux,
    CacheKind::Proxy,
    CacheKind::Waveform,
    CacheKind::Thumbs,
    CacheKind::Filmstrip,
];

fn now_ms() -> u64 {
    unix_ms(Some(SystemTime::now()))
}

fn unix_ms(t: Option<SystemTime>) -> u64 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A half-written file rather than a cache entry: a derive job's
/// `<hash><suffix>.<id>.tmp` (`playability::job_tmp_suffix`) or a project
/// card's `<card>.jpg.part` (`image_save`). Both are renamed over their final
/// name when the write completes, so one that is still here either belongs to
/// a writer that is running right now or was orphaned by a run that died.
fn is_partial_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.ends_with(".tmp") || name.ends_with(".part")
}

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

/// How long a burst of `mark_used` calls may accumulate in memory before the
/// index is written to disk.
///
/// The in-memory map is updated on EVERY call, so LRU order stays exact for this
/// process — only the persisted copy lags. That matters because opening a
/// project fires `getThumbnail` + `ensureWaveform` + `planPlayback` per media
/// item, so a 20-media project used to perform ~60 full index serializations and
/// blocking writes, each one under the mutex, on the cold-launch path. Within
/// one window that whole burst becomes a single write.
///
/// A hard process kill can therefore lose up to this much last-use history. The
/// cost is bounded to a STALE TIMESTAMP on entries touched inside the final
/// window (they look older than they are, so eviction may reach one of them
/// sooner than a perfect LRU would) — never a corrupt index: `save_index`
/// renames a fully-written temp file over the target, so `index.json` is only
/// ever replaced whole.
const FLUSH_INTERVAL_MS: u64 = 2_000;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    /// path relative to the cache root → last-used unix ms
    entries: HashMap<String, u64>,
    /// Coalescing bookkeeping. `skip` keeps `index.json`'s on-disk shape byte
    /// for byte what it always was, so an index written by any earlier build
    /// still loads and no user pays a cache reset for this.
    #[serde(skip)]
    dirty: bool,
    #[serde(skip)]
    last_flush_ms: u64,
}

/// Load the index from `root`, defaulting when it is absent or unreadable.
/// Deliberately reads only `index.json`: a stray `index.json.tmp` left behind by
/// a kill mid-flush is never authoritative.
fn read_index(root: &Path) -> Index {
    std::fs::read(root.join("index.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// One top-level entry of a kind directory, as a trim's listing saw it. Its
/// type, size and mtime come from the directory read itself (on Windows
/// `FindNextFileW` hands them over with the name), so listing a cache of
/// thousands of thumbnails costs no extra stat per file.
struct Listed {
    path: PathBuf,
    rel: String,
    is_dir: bool,
    is_partial: bool,
    size: u64,
    modified: Option<SystemTime>,
}

/// What became of one eviction candidate.
enum Evicted {
    /// Deleted by this trim.
    Removed,
    /// Already gone (another hand removed it): it no longer counts against the
    /// cap, but this trim freed nothing.
    Gone,
    /// Left in place: used or rewritten since the listing, or not removable.
    Kept,
}

pub struct Cache {
    root: PathBuf,
    index: Mutex<Index>,
    /// Held for the whole of a trim (`enforce_limit`, and so `clear`). Two
    /// trims planned from the same listing over-evict: both see the cache over
    /// its cap, one removes the oldest entry, the other's removal of that same
    /// entry finds nothing, and it goes on to remove the next one as well. The
    /// commands run off the UI thread, which is what lets a Clear cache meet a
    /// job-burst trim at all; the second one waits — never skips — and plans
    /// from what the first left. Lock order is this, THEN `index`; never the
    /// reverse.
    trim: Mutex<()>,
    /// When this process's cache came up. A partial file older than this was
    /// left behind by an earlier run; one at or after it belongs to a writer of
    /// THIS run, because its creation, and so its mtime, cannot predate the
    /// process.
    started: SystemTime,
}

impl Cache {
    pub fn new() -> Result<Self> {
        let root = paths::cache_dir()?;
        std::fs::create_dir_all(&root)?;
        Ok(Self::with_root(root))
    }

    fn with_root(root: PathBuf) -> Self {
        let index = read_index(&root);
        Cache {
            root,
            index: Mutex::new(index),
            trim: Mutex::new(()),
            started: SystemTime::now(),
        }
    }

    #[cfg(test)]
    pub fn new_at(root: PathBuf) -> Self {
        std::fs::create_dir_all(&root).unwrap();
        Self::with_root(root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Persist the index whole, via a temp file renamed over the target: a kill
    /// mid-write can then only lose the newest stamps, never truncate the file
    /// that is already there.
    fn save_index(&self, index: &mut Index) {
        // Stamp the attempt whether or not it lands. A full or read-only volume
        // must not turn every cache hit back into a failed blocking write.
        index.last_flush_ms = now_ms();
        let Ok(bytes) = serde_json::to_vec(&*index) else {
            return;
        };
        let tmp = self.root.join("index.json.tmp");
        if std::fs::write(&tmp, &bytes).is_ok()
            && std::fs::rename(&tmp, self.root.join("index.json")).is_ok()
        {
            index.dirty = false;
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// Write out any stamps still coalesced in memory. Poison-tolerant because
    /// it runs on the way out (`Drop`, and the app's exit paths): with
    /// `panic = "abort"`, a panicking shutdown path would take the whole
    /// process down over a last-use timestamp.
    ///
    /// `pub(crate)` for those exit paths, which must call it themselves — see
    /// the `Drop` impl for why teardown alone never does.
    pub(crate) fn flush(&self) {
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if index.dirty {
            self.save_index(&mut index);
        }
    }

    fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// Absolute path an entry (a single file) should live at.
    pub fn file_path(&self, kind: CacheKind, hash: &str, suffix: &str) -> PathBuf {
        self.root.join(kind.dir_name()).join(format!("{hash}{suffix}"))
    }

    /// Record (or refresh) an entry's last-use.
    ///
    /// Always exact in memory; the disk copy is written at most once per
    /// `FLUSH_INTERVAL_MS` so a cache hit costs a hash insert rather than a full
    /// serialize + blocking write held under the mutex.
    pub fn mark_used(&self, path: &Path) {
        let rel = self.rel(path);
        let mut index = self.index.lock().unwrap();
        self.stamp(&mut index, rel);
    }

    /// `mark_used`'s body, for a caller already holding the index lock.
    fn stamp(&self, index: &mut Index, rel: String) {
        let now = now_ms();
        index.entries.insert(rel, now);
        index.dirty = true;
        // `last_flush_ms` starts at 0, so the first touch of a run persists
        // immediately and the rest of that burst rides along with it.
        if now.saturating_sub(index.last_flush_ms) >= FLUSH_INTERVAL_MS {
            self.save_index(index);
        }
    }

    /// An existing, ready file for this key (refreshes LRU when found).
    ///
    /// The existence check and the stamp happen under ONE hold of the index
    /// lock, and a trim deletes a file only under that same lock after checking
    /// its stamp is the one it planned with (`evict`). So once this answers
    /// with a path — `plan_playback`'s Ready, a cached thumbnail — no trim
    /// running beside it can delete that file: either the trim removed it
    /// first and this answers None, or this stamped it first and the trim
    /// leaves it. Checked and stamped separately, a trim could fall between
    /// the two and hand back a path to a file it had just deleted.
    pub fn existing_file(&self, kind: CacheKind, hash: &str, suffix: &str) -> Option<PathBuf> {
        let p = self.file_path(kind, hash, suffix);
        let rel = self.rel(&p);
        let mut index = self.index.lock().unwrap();
        if !p.is_file() {
            return None;
        }
        self.stamp(&mut index, rel);
        Some(p)
    }

    pub fn ensure_kind_dir(&self, kind: CacheKind) -> Result<PathBuf> {
        let dir = self.root.join(kind.dir_name());
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /* -------------------------- size + eviction ------------------- */

    pub fn stats(&self) -> CacheStats {
        let mut total = 0u64;
        let mut by_kind = HashMap::new();
        for kind in ALL_KINDS {
            let dir = self.root.join(kind.dir_name());
            let size = walk_size(&dir);
            total += size;
            by_kind.insert(kind.dir_name().to_string(), size);
        }
        CacheStats {
            total_bytes: total,
            by_kind,
        }
    }

    /// Every top-level entry of every kind directory, sized. Takes no lock: a
    /// directory walk is the slow part of a trim (seconds for a large cache on
    /// a spinning disk), and holding the index across it would stall every
    /// cache hit — every thumbnail, waveform and playback plan — behind it.
    fn list_entries(&self) -> Vec<Listed> {
        let mut out = Vec::new();
        for kind in ALL_KINDS {
            let Ok(read) = std::fs::read_dir(self.root.join(kind.dir_name())) else {
                continue;
            };
            for entry in read.flatten() {
                let path = entry.path();
                let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                let meta = entry.metadata().ok();
                let size = if is_dir {
                    walk_size(&path)
                } else {
                    meta.as_ref().map_or(0, |m| m.len())
                };
                out.push(Listed {
                    rel: self.rel(&path),
                    is_dir,
                    is_partial: !is_dir && is_partial_name(&entry.file_name()),
                    size,
                    modified: meta.and_then(|m| m.modified().ok()),
                    path,
                });
            }
        }
        out
    }

    /// Delete least-recently-used entries until total size ≤ cap.
    /// Entries whose file name starts with a hash in `keep` are protected.
    ///
    /// Runs off the UI thread (see the commands below), so cache hits and job
    /// completions carry on while it walks. It therefore plans from a SNAPSHOT
    /// of the last-use stamps and re-checks each candidate under the index lock
    /// just before deleting it (`evict`): anything used or rewritten since the
    /// snapshot stays. A partial file written by this run is never a candidate
    /// at all — it is a job or a card save still writing (`started`).
    pub fn enforce_limit(&self, cap_bytes: u64, keep: &HashSet<String>) -> u64 {
        self.enforce_limit_with(cap_bytes, keep, || {})
    }

    /// `enforce_limit` with a hook between planning and deleting, so a test can
    /// play the part of a cache hit landing while a trim walks.
    fn enforce_limit_with(
        &self,
        cap_bytes: u64,
        keep: &HashSet<String>,
        after_plan: impl FnOnce(),
    ) -> u64 {
        let _trim = self.trim.lock().unwrap_or_else(|e| e.into_inner());
        let began = SystemTime::now();
        let planned: HashMap<String, u64> = self.index.lock().unwrap().entries.clone();
        let mut entries = self.list_entries();
        let mut total: u64 = entries.iter().map(|e| e.size).sum();
        if total <= cap_bytes {
            return 0;
        }

        // Oldest first. An entry the index has never seen (left by an older
        // build, or written by a job whose stamp has not landed yet) is dated
        // by its mtime.
        entries.sort_by_key(|e| {
            planned
                .get(&e.rel)
                .copied()
                .unwrap_or_else(|| unix_ms(e.modified))
        });
        after_plan();

        let mut freed = 0u64;
        let mut index_changed = false;
        for e in &entries {
            if total <= cap_bytes {
                break;
            }
            let name = e.path.file_name().map(|n| n.to_string_lossy());
            let protected = name
                .as_deref()
                .is_some_and(|n| keep.iter().any(|h| n.starts_with(h.as_str())));
            // A partial this run is writing: a waveform's `.pk.N.tmp` is a Rust
            // file opened with delete sharing, so deleting it would succeed and
            // fail the job at its rename. One with no readable mtime cannot be
            // told apart from that, so it stays too.
            let live_partial = e.is_partial && e.modified.is_none_or(|m| m >= self.started);
            if protected || live_partial {
                continue;
            }
            match self.evict(e, planned.get(&e.rel).copied(), began) {
                Evicted::Removed => {
                    total = total.saturating_sub(e.size);
                    freed += e.size;
                    index_changed = true;
                }
                Evicted::Gone => {
                    total = total.saturating_sub(e.size);
                    index_changed = true;
                }
                Evicted::Kept => {}
            }
        }
        if index_changed {
            // ONE write for the whole trim. Eviction is the one moment the
            // persisted stamps really matter, so it also lands whatever
            // `mark_used` still had coalesced.
            let mut index = self.index.lock().unwrap();
            self.save_index(&mut index);
        }
        freed
    }

    /// Delete one planned candidate unless it changed since the plan.
    ///
    /// The check and a FILE's deletion share one hold of the index lock, the
    /// lock `existing_file` checks and stamps under — so the two can never
    /// interleave (see there). The hold covers a single `remove_file`, never a
    /// walk. A directory's removal IS a walk, so for one the lock is dropped
    /// first; directories are only the legacy filmstrip entries, which nothing
    /// marks used any more.
    fn evict(&self, e: &Listed, planned_stamp: Option<u64>, began: SystemTime) -> Evicted {
        let mut index = self.index.lock().unwrap();
        if index.entries.get(&e.rel).copied() != planned_stamp {
            // Used since the plan (or first used since it): fresh, not a victim.
            return Evicted::Kept;
        }
        if planned_stamp.is_none() {
            // Unindexed, so the plan dated it by mtime. One written since the
            // trim began is live. Read fresh rather than compared with the
            // listing's copy: NTFS keeps a directory's timestamps in its
            // parent's index lazily, so the two can disagree for an entry
            // nothing has touched — and a disagreement would keep it forever.
            match std::fs::symlink_metadata(&e.path) {
                Ok(m) if m.modified().map_or(true, |t| t >= began) => return Evicted::Kept,
                Ok(_) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => return Evicted::Gone,
                Err(_) => return Evicted::Kept,
            }
        }
        let removed = if e.is_dir {
            drop(index);
            let r = std::fs::remove_dir_all(&e.path);
            index = self.index.lock().unwrap();
            r
        } else {
            std::fs::remove_file(&e.path)
        };
        match removed {
            Ok(()) => {
                index.entries.remove(&e.rel);
                index.dirty = true;
                Evicted::Removed
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                index.entries.remove(&e.rel);
                index.dirty = true;
                Evicted::Gone
            }
            Err(_) => Evicted::Kept,
        }
    }

    /// Remove everything except entries protected by `keep` hashes.
    pub fn clear(&self, keep: &HashSet<String>) -> u64 {
        self.enforce_limit(0, keep)
    }

    /// Delete partial files an earlier run left behind: a derive job or card
    /// save that was killed with the app (or crashed it) never reached its
    /// rename. Left alone they hold disk until LRU eviction reaches them, and
    /// job ids restart at 1 every launch, so a new job could be handed the very
    /// file name of a stale one. Only top-level files of the kind directories,
    /// and only those older than this process (`started`): one written by this
    /// run belongs to a job that may still be writing.
    ///
    /// Must run only in the PRIMARY instance. `Cache::new` also runs in a
    /// second launch that is about to hand its file over and exit — and in
    /// that process every partial of the live instance looks "older than this
    /// process". Returns how many files went.
    pub(crate) fn sweep_stale_partials(&self) -> usize {
        let mut removed = 0;
        for kind in ALL_KINDS {
            let Ok(read) = std::fs::read_dir(self.root.join(kind.dir_name())) else {
                continue;
            };
            for entry in read.flatten() {
                if stale_partial(&entry, self.started) && std::fs::remove_file(entry.path()).is_ok()
                {
                    removed += 1;
                }
            }
        }
        removed
    }
}

/// `sweep_stale_partials` on a thread of its own, so app startup never waits
/// on a directory listing. Safe to race with this run's first jobs: their
/// partials are newer than `started` and the sweep leaves them alone. A thread
/// the OS refuses only means no sweep this launch — never a panic, which with
/// `panic = "abort"` would end the app.
pub(crate) fn sweep_stale_partials_in_background(cache: &Arc<Cache>) {
    let cache = Arc::clone(cache);
    let _ = std::thread::Builder::new()
        .name("cache-sweep".into())
        .spawn(move || {
            cache.sweep_stale_partials();
        });
}

fn stale_partial(entry: &DirEntry, started: SystemTime) -> bool {
    entry.file_type().is_ok_and(|t| t.is_file())
        && is_partial_name(&entry.file_name())
        && entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|m| m < started)
}

impl Drop for Cache {
    /// Best-effort flush when a `Cache` is dropped — in practice only in tests
    /// and by any owner that drops one. The app's own cache is NEVER dropped:
    /// it is Tauri managed state, Tauri's `App::run` ends in
    /// `std::process::exit`, and the uninstall path exits the process too, so
    /// no destructor of managed state runs. Stamps still coalesced at exit
    /// reach the disk only if an exit path calls `flush` itself; a hard kill
    /// skips everything, which is why `mark_used` also flushes on an interval.
    fn drop(&mut self) {
        self.flush();
    }
}

/// Total bytes under `dir`. Each entry's type and size come from the directory
/// read (`DirEntry::file_type`/`metadata`), not from a second and third stat
/// per file by path.
fn walk_size(dir: &Path) -> u64 {
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    read.flatten()
        .map(|entry| {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                walk_size(&entry.path())
            } else {
                entry.metadata().map_or(0, |m| m.len())
            }
        })
        .sum()
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub total_bytes: u64,
    pub by_kind: HashMap<String, u64>,
}

/// Each command walks (and two of them delete across) the whole cache: seconds
/// for gigabytes on a spinning disk. A plain command runs on the WebView's UI
/// thread, so none of that work runs there. The trim's own locking (`trim`,
/// and `evict`'s re-check) is what makes running it beside cache hits safe.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(format!("the cache task stopped unexpectedly: {e}"))))
}

#[tauri::command]
pub async fn cache_stats(cache: tauri::State<'_, Arc<Cache>>) -> Result<CacheStats> {
    let cache = Arc::clone(&cache);
    blocking(move || cache.stats()).await
}

#[tauri::command]
pub async fn clear_cache(
    cache: tauri::State<'_, Arc<Cache>>,
    keep_active: Vec<MediaKey>,
) -> Result<u64> {
    let cache = Arc::clone(&cache);
    let keep: HashSet<String> = keep_active.iter().map(MediaKey::hash).collect();
    blocking(move || cache.clear(&keep)).await
}

#[tauri::command]
pub async fn enforce_cache_limit(
    cache: tauri::State<'_, Arc<Cache>>,
    cap_mb: u64,
    keep_active: Vec<MediaKey>,
) -> Result<u64> {
    let cache = Arc::clone(&cache);
    let keep: HashSet<String> = keep_active.iter().map(MediaKey::hash).collect();
    blocking(move || cache.enforce_limit(cap_mb.saturating_mul(1024 * 1024), &keep)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u64) -> MediaKey {
        MediaKey {
            path: format!("C:\\media\\file {n}.mp4"),
            size: 1000 + n,
            mtime_ms: 42,
        }
    }

    #[test]
    fn hash_is_stable_and_identity_sensitive() {
        let a1 = key(1).hash();
        let a2 = key(1).hash();
        let b = key(2).hash();
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        let mut changed = key(1);
        changed.mtime_ms = 43;
        assert_ne!(a1, changed.hash());
    }

    /// The half of the key that is NOT the source file. Identical `{path, size,
    /// mtime}` under two recipe versions must land on different entries, or a
    /// build that changes how a proxy/thumb/waveform is produced keeps serving
    /// the output of the old recipe until the user touches the file.
    #[test]
    fn the_recipe_version_participates_in_the_key() {
        let k = key(7);

        // Same file identity, different recipe → different entry.
        assert_ne!(
            k.hash_with(1),
            k.hash_with(2),
            "a recipe change must invalidate the derived files it produced"
        );
        // ...and it is not merely a distinct-inputs artefact: the version is
        // stable, so an unchanged recipe keeps every existing cache hit.
        assert_eq!(k.hash_with(3), k.hash_with(3));
        assert_eq!(
            k.hash(),
            k.hash_with(RECIPE_VERSION),
            "the shipped key must be the current recipe's"
        );

        // The recipe must not be confusable with the source fields it sits
        // beside: bumping it is not the same edit as changing the file.
        let mut bigger = key(7);
        bigger.size += 1;
        assert_ne!(k.hash_with(2), bigger.hash_with(1));
        assert_ne!(k.hash_with(2), bigger.hash_with(2));
    }

    #[test]
    fn lru_eviction_respects_order_and_protection() {
        let root = std::env::temp_dir().join(format!("taroting-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cache = Cache::new_at(root.clone());
        cache.ensure_kind_dir(CacheKind::Proxy).unwrap();

        let a = cache.file_path(CacheKind::Proxy, "aaaa", ".mp4");
        let b = cache.file_path(CacheKind::Proxy, "bbbb", ".mp4");
        let c = cache.file_path(CacheKind::Proxy, "cccc", ".mp4");
        std::fs::write(&a, vec![0u8; 1000]).unwrap();
        std::fs::write(&b, vec![0u8; 1000]).unwrap();
        std::fs::write(&c, vec![0u8; 1000]).unwrap();

        // use order: a (oldest), then b, then c (newest)
        cache.mark_used(&a);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&b);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&c);

        // cap to 2000 bytes → evict exactly the oldest (a)
        let freed = cache.enforce_limit(2000, &HashSet::new());
        assert_eq!(freed, 1000);
        assert!(!a.exists());
        assert!(b.exists() && c.exists());

        // protect b, cap to 500 → c must go, b survives despite being older
        let keep: HashSet<String> = ["bbbb".to_string()].into_iter().collect();
        cache.enforce_limit(500, &keep);
        assert!(b.exists());
        assert!(!c.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Three 1000-byte proxy entries in a fresh cache root, marked oldest-first
    /// with a gap wide enough that their millisecond stamps cannot collide.
    fn seeded_cache(tag: &str) -> (PathBuf, Cache, [PathBuf; 3]) {
        let root = std::env::temp_dir().join(format!(
            "taroting-cache-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let cache = Cache::new_at(root.clone());
        cache.ensure_kind_dir(CacheKind::Proxy).unwrap();
        let files = [
            cache.file_path(CacheKind::Proxy, "aaaa", ".mp4"),
            cache.file_path(CacheKind::Proxy, "bbbb", ".mp4"),
            cache.file_path(CacheKind::Proxy, "cccc", ".mp4"),
        ];
        for f in &files {
            std::fs::write(f, vec![0u8; 1000]).unwrap();
        }
        (root, cache, files)
    }

    /// The property the coalescing relies on: a burst of hits updates the
    /// in-memory LRU exactly while touching the disk only once, and eviction
    /// reads that in-memory order — so cheapening the write cannot change which
    /// entry goes first.
    #[test]
    fn mark_used_coalesces_writes_without_blurring_lru_order() {
        let (root, cache, [a, b, c]) = seeded_cache("coalesce");

        // First touch of the run persists immediately (last_flush_ms == 0).
        cache.mark_used(&a);
        assert_eq!(
            read_index(&root).entries.len(),
            1,
            "the first mark of a run should reach disk"
        );

        // The rest of the burst lands well inside FLUSH_INTERVAL_MS, so it must
        // NOT produce further writes — this is the ~60-writes-per-project-open
        // saving, observed through the on-disk copy standing still.
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&b);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&c);
        let on_disk = read_index(&root);
        assert_eq!(
            on_disk.entries.len(),
            1,
            "marks inside the window must coalesce, got {on_disk:?}"
        );
        assert!(on_disk.entries.contains_key("proxy/aaaa.mp4"));

        // ...and yet eviction still sees the exact order, because it reads the
        // in-memory map, not the file: `a` is the oldest and goes first.
        assert_eq!(cache.enforce_limit(2000, &HashSet::new()), 1000);
        assert!(!a.exists(), "the least recently used entry must be evicted");
        assert!(b.exists() && c.exists());

        // Eviction flushes, so the pending stamps for b and c land with it.
        let flushed = read_index(&root);
        assert!(!flushed.entries.contains_key("proxy/aaaa.mp4"));
        assert!(flushed.entries.contains_key("proxy/bbbb.mp4"));
        assert!(flushed.entries.contains_key("proxy/cccc.mp4"));

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The app's cache is never dropped (its process ends in `exit`), so the
    /// exit paths flush it by hand. A stamp still coalesced in memory reaches
    /// the disk through `flush` alone — the cache is then leaked, exactly as
    /// the app leaks it, and its `Drop` never runs.
    #[test]
    fn an_explicit_flush_persists_coalesced_stamps_without_a_drop() {
        let (root, cache, [a, b, _]) = seeded_cache("explicit-flush");
        cache.mark_used(&a);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&b);
        assert!(
            !read_index(&root).entries.contains_key("proxy/bbbb.mp4"),
            "the second mark must still be coalesced in memory"
        );
        cache.flush();
        let on_disk = read_index(&root);
        std::mem::forget(cache);
        assert!(on_disk.entries.contains_key("proxy/aaaa.mp4"));
        assert!(on_disk.entries.contains_key("proxy/bbbb.mp4"), "flush must write the pending stamp");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The durability property the coalescing is allowed to lean on: the index
    /// is replaced by a rename, so a kill mid-flush leaves the previous copy
    /// whole and the half-written temp file is never read back as the index.
    #[test]
    fn index_is_replaced_atomically_and_a_crashed_tmp_is_ignored() {
        let (root, cache, [a, _b, _c]) = seeded_cache("atomic");
        cache.mark_used(&a);
        drop(cache);

        let tmp = root.join("index.json.tmp");
        assert!(!tmp.exists(), "a completed flush must leave no temp file");
        assert!(read_index(&root).entries.contains_key("proxy/aaaa.mp4"));

        // Simulate a kill in the middle of the NEXT flush: a truncated temp file
        // next to a still-intact index.json.
        std::fs::write(&tmp, b"{\"entries\":{\"proxy/bbbb").unwrap();

        let reloaded = Cache::new_at(root.clone());
        let entries = reloaded.index.lock().unwrap().entries.clone();
        assert_eq!(entries.len(), 1, "the good index must survive: {entries:?}");
        assert!(
            entries.contains_key("proxy/aaaa.mp4"),
            "the orphan temp file must never be loaded as the index"
        );

        drop(reloaded);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn set_mtime(path: &Path, when: SystemTime) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    const HOUR: std::time::Duration = std::time::Duration::from_secs(3600);

    /// A trim walks off the UI thread now, so cache hits land while it runs.
    /// Whatever is used or rewritten after it planned must survive it: here a
    /// Clear cache (cap 0) meets a playback plan answering Ready for `a` (its
    /// stamp moves) and a rewrite of the unindexed `d` (its mtime moves).
    /// Planned from a snapshot alone, it would delete both.
    #[test]
    fn a_trim_leaves_what_was_used_or_rewritten_after_it_planned() {
        let (root, cache, [a, b, c]) = seeded_cache("replan");
        cache.mark_used(&a);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&b);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&c);
        // Never stamped (an older build's file): dated by its mtime, oldest.
        let d = cache.file_path(CacheKind::Proxy, "dddd", ".mp4");
        std::fs::write(&d, vec![0u8; 1000]).unwrap();
        set_mtime(&d, SystemTime::now() - HOUR);

        let freed = cache.enforce_limit_with(0, &HashSet::new(), || {
            std::thread::sleep(std::time::Duration::from_millis(5));
            assert!(
                cache.existing_file(CacheKind::Proxy, "aaaa", ".mp4").is_some(),
                "the index lock must be free while the trim is between plan and delete"
            );
            set_mtime(&d, SystemTime::now());
        });

        assert!(a.exists(), "an entry answered as ready during the trim was deleted");
        assert!(d.exists(), "an entry rewritten during the trim was deleted");
        assert!(!b.exists() && !c.exists(), "untouched entries must still go");
        assert_eq!(freed, 2000);
        let entries = cache.index.lock().unwrap().entries.clone();
        assert!(entries.contains_key("proxy/aaaa.mp4"));
        assert!(!entries.contains_key("proxy/bbbb.mp4") && !entries.contains_key("proxy/cccc.mp4"));

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An entry that vanished between the plan and its deletion (another trim,
    /// a user emptying the folder) no longer counts against the cap. Treated
    /// as a failed delete instead, the trim kept its total and went on to
    /// remove one entry too many — the newest one, here.
    #[test]
    fn an_entry_already_gone_counts_as_freed_space_not_as_a_failure() {
        let (root, cache, [a, b, c]) = seeded_cache("gone");
        cache.mark_used(&a);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&b);
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.mark_used(&c);

        // 3000 bytes against a 1000-byte cap: a and b must go, c must stay.
        let freed = cache.enforce_limit_with(1000, &HashSet::new(), || {
            std::fs::remove_file(&a).unwrap();
        });

        assert!(c.exists(), "the trim over-evicted after finding its oldest entry gone");
        assert!(!b.exists());
        assert_eq!(freed, 1000, "only what this trim deleted counts as freed");
        assert!(
            !cache.index.lock().unwrap().entries.contains_key("proxy/aaaa.mp4"),
            "a vanished entry's stamp must not linger in the index"
        );

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A Clear cache that arrives while a job-burst trim is walking waits for
    /// it and then runs whole — it is never skipped, and the two never plan
    /// from one listing. Without the trim lock the clear returns at once.
    #[test]
    fn a_clear_waits_for_a_trim_in_flight_then_runs() {
        let (root, cache, files) = seeded_cache("serial");
        let cache = Arc::new(cache);
        let in_flight = cache.trim.lock().unwrap();

        let clearing = {
            let cache = Arc::clone(&cache);
            std::thread::spawn(move || cache.clear(&HashSet::new()))
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!clearing.is_finished(), "the clear ran beside a trim in flight");
        assert!(files.iter().all(|f| f.exists()));

        drop(in_flight);
        assert_eq!(clearing.join().unwrap(), 3000, "the clear must run once the trim ends");
        assert!(files.iter().all(|f| !f.exists()));

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A legacy filmstrip entry is a DIRECTORY of frames. The listing types it
    /// from the directory read itself, sizes it whole and removes it whole.
    /// Typed as a file, it would count as 0 bytes and never be reclaimed.
    #[test]
    fn a_filmstrip_directory_is_sized_and_evicted_whole() {
        let (root, cache, [a, b, c]) = seeded_cache("filmstrip");
        let strip = cache.ensure_kind_dir(CacheKind::Filmstrip).unwrap().join("ffff");
        std::fs::create_dir_all(&strip).unwrap();
        for i in 0..3 {
            std::fs::write(strip.join(format!("{i:04}.jpg")), vec![0u8; 400]).unwrap();
        }
        // The frames' directory is older than every proxy's last use.
        std::thread::sleep(std::time::Duration::from_millis(20));
        cache.mark_used(&a);
        cache.mark_used(&b);
        cache.mark_used(&c);

        let stats = cache.stats();
        assert_eq!(stats.by_kind["filmstrip"], 1200);
        assert_eq!(stats.by_kind["proxy"], 3000);
        assert_eq!(stats.total_bytes, 4200);

        // 4200 against 3000: removing the strip alone is exactly enough.
        assert_eq!(cache.enforce_limit(3000, &HashSet::new()), 1200);
        assert!(!strip.exists(), "the strip must be removed with its frames");
        assert!(a.exists() && b.exists() && c.exists());

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Partial files: one an earlier run orphaned goes at startup, one this run
    /// is still writing is left by the sweep AND by a Clear cache. The fresh
    /// one is a waveform's `.pk.N.tmp` — a Rust file that would really be
    /// deletable mid-write — and a stale-dated DIRECTORY with a partial's name
    /// is not a partial file and stays.
    #[test]
    fn stale_partials_are_swept_and_live_ones_are_never_evicted() {
        let (root, cache, [a, _, _]) = seeded_cache("partials");
        let old = cache.started - HOUR;

        let stale_job = cache.file_path(CacheKind::Proxy, "aaaa", ".mp4.3.tmp");
        std::fs::write(&stale_job, vec![0u8; 700]).unwrap();
        set_mtime(&stale_job, old);
        let thumbs = cache.ensure_kind_dir(CacheKind::Thumbs).unwrap();
        let stale_card = thumbs.join("imgproj-1-2.jpg.part");
        std::fs::write(&stale_card, vec![0u8; 300]).unwrap();
        set_mtime(&stale_card, old);
        // File times can lag the precise clock by a timer tick: wait past it so
        // the live fixture really is newer than the cache.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let waveforms = cache.ensure_kind_dir(CacheKind::Waveform).unwrap();
        let live_job = waveforms.join("bbbb.pk.3.tmp");
        std::fs::write(&live_job, vec![0u8; 500]).unwrap();
        let odd_dir = cache.ensure_kind_dir(CacheKind::Filmstrip).unwrap().join("eeee.tmp");
        std::fs::create_dir_all(&odd_dir).unwrap();
        let odd_mtime = std::fs::metadata(&odd_dir).unwrap().modified().unwrap();
        assert!(odd_mtime >= cache.started, "fixture: the dir is newer than the cache");

        assert_eq!(cache.sweep_stale_partials(), 2);
        assert!(!stale_job.exists() && !stale_card.exists());
        assert!(live_job.exists(), "the sweep deleted a partial this run is writing");
        assert!(a.exists() && odd_dir.exists());
        // Idempotent: nothing stale is left for a second pass.
        assert_eq!(cache.sweep_stale_partials(), 0);

        // A Clear cache takes every real entry and still not the live partial.
        cache.clear(&HashSet::new());
        assert!(!a.exists());
        assert!(live_job.exists(), "a Clear cache deleted a partial this run is writing");

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A stale partial is still a candidate for an ordinary trim (dated by its
    /// mtime), so a run whose startup sweep could not remove one still ages it
    /// out.
    #[test]
    fn a_stale_partial_is_still_evicted_by_a_trim() {
        let (root, cache, [a, b, c]) = seeded_cache("stale-trim");
        cache.mark_used(&a);
        cache.mark_used(&b);
        cache.mark_used(&c);
        let stale = cache.file_path(CacheKind::Proxy, "aaaa", ".mp4.9.tmp");
        std::fs::write(&stale, vec![0u8; 1000]).unwrap();
        set_mtime(&stale, cache.started - HOUR);

        assert_eq!(cache.enforce_limit(3000, &HashSet::new()), 1000);
        assert!(!stale.exists());
        assert!(a.exists() && b.exists() && c.exists());

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }
}
