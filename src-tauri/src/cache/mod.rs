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

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    /// path relative to the cache root → last-used unix ms
    entries: HashMap<String, u64>,
}

pub struct Cache {
    root: PathBuf,
    index: Mutex<Index>,
}

impl Cache {
    pub fn new() -> Result<Self> {
        let root = paths::cache_dir()?;
        std::fs::create_dir_all(&root)?;
        let index = std::fs::read(root.join("index.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Ok(Cache {
            root,
            index: Mutex::new(index),
        })
    }

    #[cfg(test)]
    pub fn new_at(root: PathBuf) -> Self {
        std::fs::create_dir_all(&root).unwrap();
        Cache {
            root,
            index: Mutex::new(Index::default()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn save_index(&self, index: &Index) {
        if let Ok(bytes) = serde_json::to_vec(index) {
            let _ = std::fs::write(self.root.join("index.json"), bytes);
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
    pub fn mark_used(&self, path: &Path) {
        let rel = self.rel(path);
        let mut index = self.index.lock().unwrap();
        index.entries.insert(rel, now_ms());
        self.save_index(&index);
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
                let rel = self.rel(&path);
                let mut index = self.index.lock().unwrap();
                index.entries.remove(&rel);
                self.save_index(&index);
            }
        }
        freed
    }

    /// Remove everything except entries protected by `keep` hashes.
    pub fn clear(&self, keep: &HashSet<String>) -> u64 {
        self.enforce_limit(0, keep)
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
}
