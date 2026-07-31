//! Derived-file cache: %LOCALAPPDATA%\Taroting\cache\{remux,proxy,waveform,thumbs,filmstrip}.
//!
//! Every entry is keyed by xxh3(path|size|mtime) of its SOURCE media, so any
//! change to a source file automatically invalidates its derived files.
//! A small index tracks last-use for LRU eviction against the user's cap.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use xxhash_rust::xxh3::xxh3_64;

use crate::error::Result;
use crate::paths;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaKey {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

impl MediaKey {
    pub fn hash(&self) -> String {
        let ident = format!("{}|{}|{}", self.path, self.size, self.mtime_ms);
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

pub struct Cache {
    root: PathBuf,
    index: Mutex<Index>,
}

impl Cache {
    pub fn new() -> Result<Self> {
        let root = paths::cache_dir()?;
        std::fs::create_dir_all(&root)?;
        let index = read_index(&root);
        Ok(Cache {
            root,
            index: Mutex::new(index),
        })
    }

    #[cfg(test)]
    pub fn new_at(root: PathBuf) -> Self {
        std::fs::create_dir_all(&root).unwrap();
        let index = read_index(&root);
        Cache {
            root,
            index: Mutex::new(index),
        }
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
    /// this also runs from `Drop`: with `panic = "abort"`, a panicking shutdown
    /// path would take the whole process down over a last-use timestamp.
    fn flush(&self) {
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

    /// Absolute path for a per-source directory (filmstrips).
    pub fn dir_path(&self, kind: CacheKind, hash: &str, suffix: &str) -> PathBuf {
        self.root.join(kind.dir_name()).join(format!("{hash}{suffix}"))
    }

    /// Record (or refresh) an entry's last-use.
    ///
    /// Always exact in memory; the disk copy is written at most once per
    /// `FLUSH_INTERVAL_MS` so a cache hit costs a hash insert rather than a full
    /// serialize + blocking write held under the mutex.
    pub fn mark_used(&self, path: &Path) {
        let rel = self.rel(path);
        let now = now_ms();
        let mut index = self.index.lock().unwrap();
        index.entries.insert(rel, now);
        index.dirty = true;
        // `last_flush_ms` starts at 0, so the first touch of a run persists
        // immediately and the rest of that burst rides along with it.
        if now.saturating_sub(index.last_flush_ms) >= FLUSH_INTERVAL_MS {
            self.save_index(&mut index);
        }
    }

    /// An existing, ready file for this key (refreshes LRU when found).
    pub fn existing_file(&self, kind: CacheKind, hash: &str, suffix: &str) -> Option<PathBuf> {
        let p = self.file_path(kind, hash, suffix);
        if p.is_file() {
            self.mark_used(&p);
            Some(p)
        } else {
            None
        }
    }

    pub fn ensure_kind_dir(&self, kind: CacheKind) -> Result<PathBuf> {
        let dir = self.root.join(kind.dir_name());
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /* -------------------------- size + eviction ------------------- */

    fn entry_size(path: &Path) -> u64 {
        if path.is_dir() {
            walk_size(path)
        } else {
            path.metadata().map(|m| m.len()).unwrap_or(0)
        }
    }

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

    /// Delete least-recently-used entries until total size ≤ cap.
    /// Entries whose file name starts with a hash in `keep` are protected.
    pub fn enforce_limit(&self, cap_bytes: u64, keep: &HashSet<String>) -> u64 {
        let mut entries: Vec<(PathBuf, u64, u64)> = Vec::new(); // path, lastUsed, size
        {
            let index = self.index.lock().unwrap();
            for kind in ALL_KINDS {
                let dir = self.root.join(kind.dir_name());
                let Ok(read) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in read.flatten() {
                    let path = entry.path();
                    let rel = self.rel(&path);
                    let last = index.entries.get(&rel).copied().unwrap_or_else(|| {
                        path.metadata()
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0)
                    });
                    entries.push((path, last, 0));
                }
            }
        }
        for e in &mut entries {
            e.2 = Self::entry_size(&e.0);
        }
        let mut total: u64 = entries.iter().map(|e| e.2).sum();
        if total <= cap_bytes {
            return 0;
        }

        entries.sort_by_key(|e| e.1); // oldest first
        let mut freed = 0u64;
        // Collect the evicted entries and write the index ONCE at the end —
        // a per-file serialize + blocking write under the mutex is needless.
        let mut removed: Vec<String> = Vec::new();
        for (path, _, size) in entries {
            if total <= cap_bytes {
                break;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().to_string());
            let protected = name
                .as_deref()
                .map(|n| keep.iter().any(|h| n.starts_with(h.as_str())))
                .unwrap_or(false);
            if protected {
                continue;
            }
            let ok = if path.is_dir() {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            if ok {
                total = total.saturating_sub(size);
                freed += size;
                removed.push(self.rel(&path));
            }
        }
        if !removed.is_empty() {
            let mut index = self.index.lock().unwrap();
            for rel in &removed {
                index.entries.remove(rel);
            }
            // Eviction is the one moment the persisted stamps really matter, so
            // this write also lands whatever `mark_used` still had coalesced.
            self.save_index(&mut index);
        }
        freed
    }

    /// Remove everything except entries protected by `keep` hashes.
    pub fn clear(&self, keep: &HashSet<String>) -> u64 {
        self.enforce_limit(0, keep)
    }
}

impl Drop for Cache {
    /// Best-effort flush on a clean shutdown. A hard kill skips this, which is
    /// exactly why `mark_used` also flushes on an interval rather than relying
    /// on teardown.
    fn drop(&mut self) {
        self.flush();
    }
}

fn walk_size(dir: &Path) -> u64 {
    let mut total = 0;
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += walk_size(&path);
        } else {
            total += path.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
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

#[tauri::command]
pub fn cache_stats(cache: tauri::State<'_, std::sync::Arc<Cache>>) -> CacheStats {
    cache.stats()
}

#[tauri::command]
pub fn clear_cache(
    cache: tauri::State<'_, std::sync::Arc<Cache>>,
    keep_active: Vec<MediaKey>,
) -> u64 {
    let keep: HashSet<String> = keep_active.iter().map(MediaKey::hash).collect();
    cache.clear(&keep)
}

#[tauri::command]
pub fn enforce_cache_limit(
    cache: tauri::State<'_, std::sync::Arc<Cache>>,
    cap_mb: u64,
    keep_active: Vec<MediaKey>,
) -> u64 {
    let keep: HashSet<String> = keep_active.iter().map(MediaKey::hash).collect();
    cache.enforce_limit(cap_mb.saturating_mul(1024 * 1024), &keep)
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
}
