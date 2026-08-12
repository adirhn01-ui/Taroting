//! Project persistence: atomic saves with .bak recovery, plus the recents
//! index read by the home screen at startup.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::schema::{self, ProjectFile};
use crate::error::{AppError, Result};
use crate::paths;

/* ------------------------------------------------------------------ */
/* Atomic writes                                                       */
/* ------------------------------------------------------------------ */

/// `<path>.bak` — the previous contents, rotated aside by `atomic_write`.
fn bak_path(path: &Path) -> PathBuf {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    PathBuf::from(bak)
}

/// Write via temp file + rename so a crash never corrupts the target.
/// If the target exists it is first rotated to `<name>.bak`.
///
/// Failure is atomic in BOTH directions: if the second rename fails (an AV /
/// OneDrive scanner holding the name, power loss, a full volume) the rotated
/// original is moved straight back. Without that restore the target simply
/// ceased to exist — a save that failed halfway deleted the project.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", path.display())))?;
    std::fs::create_dir_all(dir)?;

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;

    let bak = bak_path(path);
    let rotated = if path.exists() {
        // Rename straight ONTO any existing backup — rename replaces it
        // atomically. Deleting the old `.bak` first meant that a rotation which
        // then failed (a scanner holding the name, a full volume) left no backup
        // at all, and the one moment a backup matters most is the moment a write
        // is going wrong.
        std::fs::rename(path, &bak)?;
        true
    } else {
        false
    };
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Put the original back before surfacing the error. The `.tmp` is left
        // on disk deliberately: it holds the bytes we failed to commit, and the
        // next successful write overwrites it anyway.
        if rotated {
            let _ = std::fs::rename(&bak, path);
        }
        return Err(e.into());
    }
    Ok(())
}

/// The outcome of reading a JSON file that has a `.bak` sibling.
///
/// The distinction that earns its keep is `Absent` vs `Unreadable`. "Nothing is
/// stored" is a legitimate empty state that a caller may freely write over;
/// "something is stored but we could not read it" is NOT, because writing the
/// empty value over it rotates the last good copy into `.bak` and then hides it
/// forever — the fresh primary parses fine, so the `.bak` fallback below never
/// fires again. That is the exact sequence that wiped a user's whole recents
/// list.
///
/// Every caller takes the three states directly. A convenience wrapper that
/// mapped `Absent` and `Unreadable` onto one `None` used to sit here, and it
/// was the only thing settings ever called — which is precisely how the
/// settings read kept the bug this enum exists to prevent.
pub enum JsonRead<T> {
    /// Parsed. `recovered` is true when the `.bak` supplied it.
    Parsed { value: T, recovered: bool },
    /// Neither copy is on disk — a clean first run.
    Absent,
    /// At least one copy exists but nothing could be parsed out of it.
    Unreadable,
}

/// `(parsed value, whether the file is there at all)`.
///
/// A file we cannot even open for a reason OTHER than "it isn't there" — a
/// permission error, an exclusive lock, a bad sector — counts as PRESENT: the
/// data may well still exist, so the caller must not overwrite it.
fn read_json_one<T: serde::de::DeserializeOwned>(path: &Path) -> (Option<T>, bool) {
    match std::fs::read(path) {
        Ok(bytes) => (serde_json::from_slice::<T>(&bytes).ok(), true),
        Err(e) => (None, e.kind() != std::io::ErrorKind::NotFound),
    }
}

/// Read a JSON file, falling back to the `<path>.bak` that `atomic_write`
/// rotates aside, and report which of the three outcomes occurred.
///
/// Those `.bak` files existed from the start but nothing ever read them, so a
/// corrupt primary silently became "no data": for settings that meant every
/// preference reset to defaults, and for recents it meant every project card
/// disappearing from home. Both then re-saved over the last good backup.
pub fn read_json_status<T: serde::de::DeserializeOwned>(path: &Path) -> JsonRead<T> {
    let (primary, primary_present) = read_json_one::<T>(path);
    if let Some(value) = primary {
        return JsonRead::Parsed { value, recovered: false };
    }
    let (backup, bak_present) = read_json_one::<T>(&bak_path(path));
    if let Some(value) = backup {
        return JsonRead::Parsed { value, recovered: true };
    }
    if primary_present || bak_present {
        JsonRead::Unreadable
    } else {
        JsonRead::Absent
    }
}

/* ------------------------------------------------------------------ */
/* Recents index                                                       */
/* ------------------------------------------------------------------ */

const MAX_RECENTS: usize = 24;

/// Current UTC time as an ISO 8601 string (e.g. `2026-07-02T15:04:05Z`),
/// computed from the Unix epoch with no external date crate.
fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    // civil-from-days (Howard Hinnant), epoch shifted to 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hh, mm, ss
    )
}

/// A duration safe to persist. `Timeline::duration()` can come back non-finite
/// from a hand-edited or hostile `.trt` (`speed: 0` divides by zero; a
/// `timelineStart` + `srcOut` near f64::MAX sums to infinity) — both parse
/// fine. serde_json writes a non-finite f64 as `null`, which used to make the
/// WHOLE recents index unparseable: every project card vanished from home
/// because of one bad entry.
fn finite_duration(d: f64) -> f64 {
    if d.is_finite() {
        d
    } else {
        0.0
    }
}

/// Tolerate a missing or `null` `durationSec` instead of failing the entire
/// index. `#[serde(default)]` alone only covers an ABSENT field; an index
/// already written by an older build carries a literal `null` here, and that
/// still has to degrade to one wrong duration rather than an empty home screen.
fn de_duration_sec<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?
        .filter(|n| n.is_finite())
        .unwrap_or(0.0))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub modified_at: String,
    #[serde(default, deserialize_with = "de_duration_sec")]
    pub duration_sec: f64,
    pub thumb: Option<String>,
    /// on-disk size of the `.trt` file; refreshed by `list_recents`
    #[serde(default)]
    pub size_bytes: u64,
    /// last time this project was opened (ISO 8601 UTC); stamped by `load_project`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentsIndex {
    pub schema: u32,
    pub items: Vec<RecentItem>,
}

impl Default for RecentsIndex {
    fn default() -> Self {
        RecentsIndex {
            schema: 1,
            items: Vec::new(),
        }
    }
}

fn recents_path() -> Result<PathBuf> {
    Ok(paths::data_dir()?.join("recents.json"))
}

/// The recents index plus whether it is safe to write back over it.
struct Recents {
    index: RecentsIndex,
    /// False when an index EXISTS on disk that we could not read. Persisting the
    /// empty default we fall back to would destroy it: `atomic_write` rotates
    /// the last good copy into `.bak`, and the fresh empty primary then parses
    /// fine, so the recovery path never looks at that backup again. One
    /// unreadable file plus one ordinary save is all it took to lose the entire
    /// list. Absence is different and stays writable — that is a first run.
    writable: bool,
}

fn read_recents_checked() -> Recents {
    let empty = |writable| Recents {
        index: RecentsIndex::default(),
        writable,
    };
    // No data dir means we could not even look; refuse to write blind.
    let Ok(path) = recents_path() else {
        return empty(false);
    };
    match read_json_status::<RecentsIndex>(&path) {
        JsonRead::Parsed { value, .. } => Recents { index: value, writable: true },
        JsonRead::Absent => empty(true),
        JsonRead::Unreadable => empty(false),
    }
}

fn read_recents() -> RecentsIndex {
    read_recents_checked().index
}

fn write_recents(index: &RecentsIndex) -> Result<()> {
    atomic_write(&recents_path()?, serde_json::to_vec(index)?.as_slice())
}

/// Persist an index that came from `read_recents_checked`, unless the read
/// failed — see `Recents::writable`.
///
/// Skipping is reported as success on purpose: recents is a convenience, and a
/// corrupt index must not be able to fail the project save that triggered the
/// update. The user keeps their work and their (unreadable) index; nothing is
/// destroyed, so a later repair is still possible.
fn write_recents_checked(recents: &Recents) -> Result<()> {
    if !recents.writable {
        return Ok(());
    }
    write_recents(&recents.index)
}

fn upsert_recent(mut item: RecentItem) -> Result<()> {
    let mut recents = read_recents_checked();
    // Preserve a prior openedAt when the caller doesn't supply one, and refresh
    // the on-disk size so callers don't all have to stat.
    if let Some(prev) = recents.index.items.iter().find(|r| r.path == item.path) {
        if item.opened_at.is_none() {
            item.opened_at = prev.opened_at.clone();
        }
    }
    if let Ok(meta) = std::fs::metadata(&item.path) {
        item.size_bytes = meta.len();
    }
    recents.index.items.retain(|r| r.path != item.path);
    recents.index.items.insert(0, item);
    recents.index.items.truncate(MAX_RECENTS);
    write_recents_checked(&recents)
}

#[tauri::command]
pub fn list_recents() -> Result<RecentsIndex> {
    let mut index = read_recents();
    // Drop entries whose project file vanished (moved/deleted by the user), but
    // KEEP one whose primary is gone while its .bak survives: that combination
    // means an interrupted save, not a deletion, and read_project_value can
    // recover it. Without this the card disappears from home and the user has no
    // way to reach the recovery at all. delete_project and rename_project both
    // remove the .bak alongside the primary, so an orphan .bak is unambiguous.
    index
        .items
        .retain(|r| Path::new(&r.path).is_file() || bak_path(Path::new(&r.path)).is_file());
    for r in &mut index.items {
        if let Ok(meta) = std::fs::metadata(&r.path) {
            r.size_bytes = meta.len();
        }
    }
    Ok(index)
}

#[tauri::command]
pub fn remove_recent(path: String) -> Result<()> {
    let mut recents = read_recents_checked();
    recents.index.items.retain(|r| r.path != path);
    write_recents_checked(&recents)
}

/* ------------------------------------------------------------------ */
/* Load / save                                                         */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    pub project: Value,
    /// media ids whose file is missing or changed (size/mtime mismatch)
    pub missing: Vec<String>,
    /// true when the main file was corrupt and the .bak was used
    pub recovered: bool,
}

/// File mtime as ms since the Unix epoch, matching `probe_sync`'s derivation
/// exactly so the load-time scan compares like-for-like against `mtime_ms`.
fn mtime_ms_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The `.bak` sibling, parsed as JSON. `None` when it is absent or corrupt too.
fn read_bak_value(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(bak_path(path)).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

fn read_project_value(path: &Path) -> Result<(Value, bool)> {
    match std::fs::read(path) {
        Ok(bytes) => {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                return Ok((v, false));
            }
            // corrupt main file → try the .bak
            match read_bak_value(path) {
                Some(v) => Ok((v, true)),
                None if bak_path(path).exists() => Err(AppError::BadInput(format!(
                    "{} and its backup are both corrupt",
                    path.display()
                ))),
                None => Err(AppError::BadInput(format!(
                    "{} is not valid JSON",
                    path.display()
                ))),
            }
        }
        // The primary is GONE — a save whose final rename failed used to leave
        // exactly this state, and returning NotFound here made the loss look
        // permanent. The rotated `.bak` is the last good copy, so recover from
        // it (flagged `recovered`) exactly as for a corrupt primary.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            read_bak_value(path).map(|v| (v, true)).ok_or_else(|| e.into())
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn load_project(path: String) -> Result<LoadedProject> {
    let p = Path::new(&path);
    let (raw, recovered) = read_project_value(p)?;
    let migrated = schema::migrate(raw)?;
    let typed: ProjectFile = ProjectFile::deserialize(&migrated)
        .map_err(|e| AppError::BadInput(format!("invalid project file: {e}")))?;

    // Verify media identity (path exists + size/mtime match). Generated media
    // (text/solid) has no file identity — its `path` is a display label.
    let mut missing = Vec::new();
    for m in &typed.media {
        if m.generator.is_some() {
            continue;
        }
        // Compare both size and mtime. mtime_ms uses the exact derivation from
        // probe_sync (modified() → ms since epoch, u64) so an unchanged file
        // compares bit-identical; an exact match is correct (no tolerance).
        let ok = std::fs::metadata(&m.path)
            .map(|meta| meta.len() == m.size && mtime_ms_of(&meta) == m.mtime_ms)
            .unwrap_or(false);
        if !ok {
            missing.push(m.id.clone());
        }
    }

    // Stamp openedAt on this path's recents entry (create it if absent — a
    // freshly opened file may not be in the list yet). Temp quick-view projects
    // are deliberately excluded from recents, so they are never stamped.
    if !is_temp_project_path(&path) {
        stamp_opened(&path, &typed);
    }

    Ok(LoadedProject {
        project: migrated,
        missing,
        recovered,
    })
}

/// Record that `path` was just opened. Updates the existing recents entry's
/// `opened_at`, or inserts a fresh entry built from the loaded project.
fn stamp_opened(path: &str, typed: &ProjectFile) {
    let now = now_iso8601();
    let mut recents = read_recents_checked();
    if let Some(entry) = recents.index.items.iter_mut().find(|r| r.path == path) {
        entry.opened_at = Some(now);
    } else {
        let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        recents.index.items.insert(
            0,
            RecentItem {
                path: path.to_string(),
                name: typed.name.clone(),
                modified_at: typed.modified_at.clone(),
                duration_sec: finite_duration(typed.timeline.duration()),
                thumb: None,
                size_bytes,
                opened_at: Some(now),
            },
        );
        recents.index.items.truncate(MAX_RECENTS);
    }
    let _ = write_recents_checked(&recents);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    pub modified_at: String,
}

/// The media the recents grid uses as a project's thumbnail: the earliest
/// visual clip across all video tracks. `None` when no video-track clip exists
/// (generator-only / audio-only projects keep the placeholder by design).
///
/// Selection: gather every clip on a `kind == "video"` track, ordered by
/// `timelineStart` ascending, tie-broken by topmost track (lowest track index).
/// An empty topmost track no longer hides a lower track's clip. The earliest
/// candidate whose media resolves to a non-audio source wins; audio-kind media
/// on a video track (shouldn't happen, but be defensive) is skipped in favor of
/// the next candidate so the thumbnail is always a real frame.
fn first_clip_media(typed: &ProjectFile) -> Option<&schema::MediaRef> {
    // (timelineStart, track index) sort key selects the earliest clip, breaking
    // ties toward the topmost track. Track order is topmost-first, so a lower
    // index means a higher (more visible) track.
    let mut candidates: Vec<(f64, usize, &schema::Clip)> = typed
        .timeline
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == "video")
        .flat_map(|(ti, t)| t.clips.iter().map(move |c| (c.timeline_start, ti, c)))
        .collect();
    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));

    candidates.into_iter().find_map(|(_, _, clip)| {
        let media = typed.media.iter().find(|m| m.id == clip.media_id)?;
        // Prefer a visual result: skip audio-kind media (defensive — video
        // tracks shouldn't carry audio) so the next candidate gets a chance.
        (media.kind != "audio").then_some(media)
    })
}

#[tauri::command]
pub fn save_project(
    cache: tauri::State<'_, std::sync::Arc<crate::cache::Cache>>,
    path: String,
    project: Value,
) -> Result<SavedProject> {
    // Validate before writing — never persist something we can't read back.
    let typed: ProjectFile = ProjectFile::deserialize(&project)
        .map_err(|e| AppError::BadInput(format!("refusing to save invalid project: {e}")))?;

    atomic_write(
        Path::new(&path),
        serde_json::to_vec_pretty(&project)?.as_slice(),
    )?;

    // Temp quick-view projects (autosaved to the temp dir) must never enter
    // recents. Pressing Back re-saves to a permanent Documents path, which does
    // upsert. Skip both the thumb lookup and the upsert for temp-dir paths.
    if !is_temp_project_path(&path) {
        // Thumbnail for the recents grid: any cached thumb of the first clip's media.
        let thumb = first_clip_media(&typed)
            .map(|m| {
                crate::cache::MediaKey {
                    path: m.path.clone(),
                    size: m.size,
                    mtime_ms: m.mtime_ms,
                }
                .hash()
            })
            .and_then(|h| crate::media::thumbs::any_thumb_for(&cache, &h))
            .map(|p| p.to_string_lossy().into_owned());

        upsert_recent(RecentItem {
            path: path.clone(),
            name: typed.name.clone(),
            modified_at: typed.modified_at.clone(),
            duration_sec: finite_duration(typed.timeline.duration()),
            thumb,
            size_bytes: 0, // filled by upsert_recent via fs metadata
            opened_at: None, // preserved from any prior entry by upsert_recent
        })?;
    }

    Ok(SavedProject {
        modified_at: typed.modified_at,
    })
}

/// The media key + frame offset a project's thumbnail should come from, or
/// `None` when no real frame is possible: unreadable project, no clips, a
/// generator/audio first clip (no file / no frame), or a source file that is
/// missing or changed on disk. Pure and ffmpeg-free so the skip paths are
/// unit-testable; `refresh_recent_thumb` layers cache lookup + generation on top.
fn thumb_source_for(path: &str) -> Option<(crate::cache::MediaKey, f64)> {
    let (raw, _) = read_project_value(Path::new(path)).ok()?;
    let migrated = schema::migrate(raw).ok()?;
    let typed: ProjectFile = serde_json::from_value(migrated).ok()?;

    // Generated media (text/solid) has no file; audio has no frame. Both are
    // skipped exactly as the editor's bin does — placeholder is acceptable.
    let media = first_clip_media(&typed)?;
    if media.generator.is_some() || media.kind == "audio" {
        return None;
    }
    // The source must exist and match identity (size + mtime) before we hand a
    // path to ffmpeg — a stale/replaced file would otherwise yield a wrong or
    // failed frame. Mirrors load_project's missing-media identity check.
    let identity_ok = std::fs::metadata(&media.path)
        .map(|meta| meta.len() == media.size && mtime_ms_of(&meta) == media.mtime_ms)
        .unwrap_or(false);
    if !identity_ok {
        return None;
    }

    let key = crate::cache::MediaKey {
        path: media.path.clone(),
        size: media.size,
        mtime_ms: media.mtime_ms,
    };
    // `at_sec` matches the editor bin's frame choice so both reuse one cached file.
    let at = (media.duration / 2.0).clamp(0.0, 0.5);
    Some((key, at))
}

/// One lazily-taken listing of the thumbs cache directory, reused for a whole
/// batch of lookups.
///
/// `media::thumbs::any_thumb_for` does a full `read_dir` per call, so resolving
/// N recents cards meant N complete scans of that directory on every home mount.
/// The listing is only taken once a lookup actually needs it, so a batch whose
/// projects all skip (generator-only, audio-only, missing source) still scans
/// nothing at all.
struct ThumbListing<'a> {
    cache: &'a crate::cache::Cache,
    entries: Option<Vec<(String, PathBuf)>>,
}

impl<'a> ThumbListing<'a> {
    fn new(cache: &'a crate::cache::Cache) -> Self {
        ThumbListing { cache, entries: None }
    }

    /// First cached thumb whose file name starts with `hash`, in `read_dir`
    /// order — the same choice `any_thumb_for` makes for the same directory.
    fn find(&mut self, hash: &str) -> Option<PathBuf> {
        let cache = self.cache;
        let entries = self.entries.get_or_insert_with(|| {
            let dir = cache
                .root()
                .join(crate::cache::CacheKind::Thumbs.dir_name());
            std::fs::read_dir(dir)
                .map(|read| {
                    read.flatten()
                        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
                        .collect()
                })
                .unwrap_or_default()
        });
        entries
            .iter()
            .find(|(name, _)| name.starts_with(hash))
            .map(|(_, path)| path.clone())
    }

    /// Register a thumb generated during this batch so a later card sharing the
    /// same source media hits the listing instead of the filesystem.
    fn record(&mut self, path: &Path) {
        let (Some(entries), Some(name)) = (self.entries.as_mut(), path.file_name()) else {
            return;
        };
        entries.push((name.to_string_lossy().into_owned(), path.to_path_buf()));
    }
}

/// Resolve a thumbnail for each of `paths`, then persist all of them with ONE
/// recents read + write. Returns `(project path, thumb path)` for the projects
/// that resolved, in input order; the rest are simply absent (fail-soft).
///
/// The batching is the whole point: `atomic_write` is five filesystem
/// operations, so a home mount with a dozen thumb-less cards used to spend ~48
/// of them on recents.json — plus one full thumbs-directory scan per card.
fn refresh_thumbs_for(
    cache: &crate::cache::Cache,
    jobs: &crate::jobs::Jobs,
    paths: &[String],
) -> Vec<(String, String)> {
    let mut listing = ThumbListing::new(cache);
    let mut resolved: Vec<(String, String)> = Vec::new();

    for path in paths {
        let Some((key, at)) = thumb_source_for(path) else {
            continue;
        };
        // Prefer an already-cached thumb; only spend ffmpeg when it is cold.
        let thumb = match listing.find(&key.hash()) {
            Some(hit) => Some(hit),
            None => crate::media::thumbs::ensure_thumb(cache, jobs, &key, at).ok(),
        };
        let Some(thumb) = thumb else { continue };
        listing.record(&thumb);
        resolved.push((path.clone(), thumb.to_string_lossy().into_owned()));
    }

    // Persist so future mounts skip generation. Best-effort: a write failure
    // just means we regenerate next time.
    if !resolved.is_empty() {
        let mut recents = read_recents_checked();
        let mut changed = false;
        for (path, thumb) in &resolved {
            if let Some(entry) = recents.index.items.iter_mut().find(|r| r.path == *path) {
                if entry.thumb.as_deref() != Some(thumb.as_str()) {
                    entry.thumb = Some(thumb.clone());
                    changed = true;
                }
            }
        }
        if changed {
            let _ = write_recents_checked(&recents);
        }
    }

    resolved
}

/// Backfill a recents card's thumbnail after the fact. `load_project` /
/// `stamp_opened` and the open-with flow can create a recents entry before any
/// thumbnail is cached (thumbs are generated lazily by the editor's bin), so
/// cards opened via the OS "Open with" show a placeholder until the next save.
/// The home screen calls this for every thumb-less card on mount.
///
/// Resolves the first clip's file-backed media and returns a thumb path from
/// the cache — generating one on the thumb lane if absent. Fails soft: any
/// error (unparseable project, no clips, generator/audio-only media,
/// missing/changed source file, ffmpeg failure) yields `Ok(None)` so the home
/// screen is never blocked or toasted. On success the recents entry's `thumb`
/// is persisted so subsequent mounts hit the cache without ffmpeg.
///
/// A whole mount's worth of cards should go through `refresh_recent_thumbs`
/// instead; this single-path form is kept for one-off callers and is a literal
/// one-element batch, so the two can never drift apart.
#[tauri::command]
pub fn refresh_recent_thumb(
    cache: tauri::State<'_, std::sync::Arc<crate::cache::Cache>>,
    jobs: tauri::State<'_, std::sync::Arc<crate::jobs::Jobs>>,
    path: String,
) -> Result<Option<String>> {
    // At most one entry can come back for one input path.
    refresh_recent_thumbs(cache, jobs, vec![path]).map(|m| m.into_values().next())
}

/// Batched `refresh_recent_thumb`: same resolution rules, same fail-soft
/// behavior, but one thumbs-directory scan and one recents read/write for the
/// entire home mount instead of one of each per card.
///
/// Returns a map of project path → thumb path containing ONLY the projects that
/// resolved; a project that skips (or whose generation fails) is absent, which
/// is the batched equivalent of the single-path `null`.
///
/// Generation is sequential, so on a cold thumbnail cache the whole batch
/// answers together rather than card by card — callers wanting progressive fill
/// should chunk their paths.
#[tauri::command]
pub fn refresh_recent_thumbs(
    cache: tauri::State<'_, std::sync::Arc<crate::cache::Cache>>,
    jobs: tauri::State<'_, std::sync::Arc<crate::jobs::Jobs>>,
    paths: Vec<String>,
) -> Result<HashMap<String, String>> {
    Ok(refresh_thumbs_for(&cache, &jobs, &paths).into_iter().collect())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Pick a fresh "Untitled N.trt" path in `dir`, deduping with a bare-space
/// suffix ("<base> 2.trt") the way `new_project_path` always has. `base` must
/// already be sanitized. Shared by the permanent (Documents) and temp flows so
/// both name identically.
fn fresh_untitled_in(dir: &Path, base: &str) -> Result<String> {
    for n in 0..1000 {
        let candidate = if n == 0 {
            dir.join(format!("{base}.trt"))
        } else {
            dir.join(format!("{base} {}.trt", n + 1))
        };
        if !candidate.exists() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err(AppError::BadInput("could not find a free project name".into()))
}

/// Pick a fresh "Untitled N.trt" path in Documents\Taroting.
#[tauri::command]
pub fn new_project_path(name: Option<String>) -> Result<String> {
    let dir = paths::default_projects_dir()?;
    paths::ensure_dir(&dir)?;
    let base = sanitize_filename(&name.unwrap_or_else(|| "Untitled".to_string()));
    fresh_untitled_in(&dir, &base)
}

/// True when `path` lives inside the temp-projects dir. Used to gate recents
/// side effects: quick-view projects there must never appear in recents, so
/// `load_project` skips stamping and `save_project` skips the upsert for them.
/// A resolution failure (no LOCALAPPDATA) yields `false` — the safe default is
/// the classic permanent behavior.
fn is_temp_project_path(path: &str) -> bool {
    paths::temp_projects_dir()
        .map(|tmp| Path::new(path).starts_with(&tmp))
        .unwrap_or(false)
}

/// The temp-projects dir as a string, for the frontend to classify open-with
/// paths that physically live there as temp (matching the recents exclusion the
/// backend already applies). Cached once per app run on the frontend, so this
/// adds no repeated IPC.
#[tauri::command]
pub fn temp_projects_dir() -> Result<String> {
    Ok(paths::temp_projects_dir()?.to_string_lossy().into_owned())
}

/// Pick a fresh "Untitled N.trt" path in the temp-projects dir. Mirrors
/// `new_project_path` but targets scratch storage for the quick-view flow.
#[tauri::command]
pub fn temp_project_path(name: Option<String>) -> Result<String> {
    let dir = paths::temp_projects_dir()?;
    paths::ensure_dir(&dir)?;
    let base = sanitize_filename(&name.unwrap_or_else(|| "Untitled".to_string()));
    fresh_untitled_in(&dir, &base)
}

/// Best-effort wipe of stale files in the temp-projects dir. Called once at
/// startup, before any project opens, so it never races a live quick-view
/// session. ONLY touches the app's own tmp-projects dir; a missing dir or any
/// per-file error is ignored (the next startup retries).
pub fn cleanup_temp_projects() {
    let Ok(dir) = paths::temp_projects_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return; // dir absent or unreadable → nothing to wipe
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Whether two paths name the same file on disk.
///
/// `Unknown` is not a shrug. It is the state where the filesystem could not be
/// asked — a path vanished mid-operation, or could not be opened at all — and
/// the two callers below resolve it in OPPOSITE directions, each toward the
/// answer whose failure is cosmetic rather than destructive. Collapsing it into
/// a bool would silently pick one of them for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathIdentity {
    /// Provably one and the same file.
    Same,
    /// Provably two different files.
    Different,
    /// The filesystem gave no answer; nothing may be inferred from that.
    Unknown,
}

/// The path the filesystem itself reports for `p`, in the directory entry's
/// true case (`GetFinalPathNameByHandle` on Windows). `None` when the file
/// cannot be resolved: it is gone, or it cannot be opened at all.
///
/// It opens the file only to ask its name, so an exclusive lock held by
/// another process (an AV scanner, a sync agent) does not defeat it the way it
/// defeats a read.
fn real_path(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// Do two paths name the same file?
///
/// This has to agree with `Path::exists`, and on Windows `exists` asks a
/// filesystem that compares names case-INSENSITIVELY. A plain `==` did not, so
/// renaming "My Film" to "my film" found the candidate taken (by the original)
/// but not excluded (byte-unequal), deduped to "my film (2).trt", and then
/// deleted "My Film.trt" — a case-only rename silently renumbered the project.
///
/// Folding both names in Rust does not agree with it either, and it fails in
/// the far more dangerous direction. Rust's `to_lowercase` is full Unicode;
/// NTFS folds with its own `$UpCase` table, which is much narrower. Measured on
/// this platform: "Straße.trt" (U+00DF) and "Straẞe.trt" (U+1E9E) are TWO files
/// on disk, as are "Kelvin.trt" and "Kelvin.trt" (U+212A KELVIN SIGN) — and
/// `to_lowercase` calls both pairs equal. Claiming equality there is what turns
/// a rename into a deletion: `free_path_in` reports the neighbour's path free,
/// and `atomic_write` rotates that innocent project into `.bak` and writes over
/// it. A name-folding rule cannot be right in general anyway — a case-sensitive
/// directory (`fsutil file setCaseSensitiveInfo`), a FAT stick or a network
/// share all fold differently, and none of them tell us in advance.
///
/// So ask the filesystem instead of imitating it. `canonicalize` resolves each
/// name to the directory entry's real case, so equal canonical paths mean
/// literally the same file — exactly what this volume folds, and nothing else.
fn path_identity(a: &Path, b: &Path) -> PathIdentity {
    // Byte-identical needs no filesystem, and answers even for a path that
    // does not exist yet.
    if a == b {
        return PathIdentity::Same;
    }
    match (real_path(a), real_path(b)) {
        (Some(a), Some(b)) if a == b => PathIdentity::Same,
        (Some(_), Some(_)) => PathIdentity::Different,
        _ => PathIdentity::Unknown,
    }
}

/// Pick a free `<base>.trt` path in `dir`, deduping to `<base> (2).trt` etc.
/// when the plain name is taken. `base` must already be sanitized. `exclude`
/// (the caller's own current file, if any) is treated as free so renaming a
/// project to its existing filename stem keeps the plain name — no " (2)".
///
/// Only a PROVEN `Same` counts as free. An unprovable answer dedupes, because
/// the two outcomes are not equally bad: a needless " (2)" is a cosmetic wart
/// on the file the user is renaming, while a wrong "that's mine" hands back an
/// occupied path and destroys somebody else's project.
fn free_path_in(dir: &Path, base: &str, exclude: Option<&Path>) -> Result<PathBuf> {
    for n in 0..1000 {
        let candidate = if n == 0 {
            dir.join(format!("{base}.trt"))
        } else {
            dir.join(format!("{base} ({}).trt", n + 1))
        };
        // `exists()` short-circuits, so the identity check only runs — and only
        // touches the disk — for a candidate that is actually taken.
        if !candidate.exists()
            || exclude.is_some_and(|e| path_identity(e, &candidate) == PathIdentity::Same)
        {
            return Ok(candidate);
        }
    }
    Err(AppError::BadInput("could not find a free project name".into()))
}

/// Read a project file as a raw JSON `Value`, preserving unknown fields.
fn read_raw_value(path: &Path) -> Result<Value> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::BadInput(format!("{} is not valid JSON", path.display())))
}

/// Rename a project on disk: rewrite its inner `name`, move the file to a
/// sanitized/deduped path in the same dir, drop the stale `.bak`, and update
/// the recents entry. Returns the new path.
#[tauri::command]
pub fn rename_project(path: String, new_name: String) -> Result<String> {
    let old = Path::new(&path);
    let dir = old
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", old.display())))?;

    let mut value = read_raw_value(old)?;
    let base = sanitize_filename(&new_name);
    // Exclude our own current file so renaming to the same sanitized stem
    // keeps the filename instead of deduping to "<base> (2).trt".
    let new_path = free_path_in(dir, &base, Some(old))?;

    value["name"] = Value::String(new_name);
    atomic_write(&new_path, serde_json::to_vec_pretty(&value)?.as_slice())?;

    // Clean up the old location only when it is PROVABLY a different file. A
    // case-only rename lands on the same file on Windows, so deleting "the old
    // one" here would delete the project we just wrote. An unprovable answer
    // must not be resolved that way either: leaving a stale copy behind is
    // recoverable, deleting the live one is not.
    if path_identity(&new_path, old) == PathIdentity::Different {
        let _ = std::fs::remove_file(old);
        let mut bak = old.as_os_str().to_owned();
        bak.push(".bak");
        let _ = std::fs::remove_file(PathBuf::from(bak));
    }

    // Replace the recents entry's path + name, preserving the rest.
    let new_path_str = new_path.to_string_lossy().into_owned();
    let mut recents = read_recents_checked();
    let name_field = value["name"].as_str().unwrap_or_default().to_string();
    if let Some(entry) = recents.index.items.iter_mut().find(|r| r.path == path) {
        entry.path = new_path_str.clone();
        entry.name = name_field;
    }
    let _ = write_recents_checked(&recents);

    Ok(new_path_str)
}

/// Duplicate a project: copy its raw JSON with a new `name` + `id`, to a
/// deduped path derived from `new_name`, and add it to recents. The caller
/// supplies `new_id` (frontend `crypto.randomUUID()`). Returns the new path.
#[tauri::command]
pub fn duplicate_project(path: String, new_name: String, new_id: String) -> Result<String> {
    let src = Path::new(&path);
    let dir = src
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", src.display())))?;

    let mut value = read_raw_value(src)?;
    value["name"] = Value::String(new_name.clone());
    value["id"] = Value::String(new_id);

    let base = sanitize_filename(&new_name);
    // No exclusion: a duplicate must never overwrite its source.
    let new_path = free_path_in(dir, &base, None)?;
    atomic_write(&new_path, serde_json::to_vec_pretty(&value)?.as_slice())?;

    let new_path_str = new_path.to_string_lossy().into_owned();
    let size_bytes = std::fs::metadata(&new_path).map(|m| m.len()).unwrap_or(0);
    // Carry the source's duration/thumb across so the new card looks right
    // before it is ever opened+saved.
    let src_recent = read_recents().items.into_iter().find(|r| r.path == path);
    upsert_recent(RecentItem {
        path: new_path_str.clone(),
        name: new_name,
        modified_at: value["modifiedAt"].as_str().unwrap_or_default().to_string(),
        duration_sec: src_recent
            .as_ref()
            .map(|r| finite_duration(r.duration_sec))
            .unwrap_or(0.0),
        thumb: src_recent.and_then(|r| r.thumb),
        size_bytes,
        opened_at: None,
    })?;

    Ok(new_path_str)
}

/// Permanently delete a project file, its `.bak` sibling, and its recents entry.
#[tauri::command]
pub fn delete_project(path: String) -> Result<()> {
    let p = Path::new(&path);
    std::fs::remove_file(p)?;
    let mut bak = p.as_os_str().to_owned();
    bak.push(".bak");
    let _ = std::fs::remove_file(PathBuf::from(bak));

    let mut recents = read_recents_checked();
    recents.index.items.retain(|r| r.path != path);
    write_recents_checked(&recents)
}

pub fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("a<b>c:d"), "a_b_c_d");
        assert_eq!(sanitize_filename("  spaced  "), "spaced");
        assert_eq!(sanitize_filename("dots..."), "dots");
        assert_eq!(sanitize_filename(""), "Untitled");
        assert_eq!(sanitize_filename("***"), "___");
    }

    // The recents index lives under %APPDATA%, a process-global env var. Every
    // test touching rename/duplicate/delete (which read+write recents) points
    // APPDATA at its own temp dir; ENV_LOCK serializes them so parallel threads
    // never share state. `with_isolated` acquires the lock, sets up a private
    // temp dir + APPDATA, runs the body, then restores and cleans up.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_isolated(tag: &str, body: impl FnOnce(&Path)) {
        // Hold the lock for the whole test; recover it even if a prior test panicked.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "taroting-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var_os("APPDATA");
        std::env::set_var("APPDATA", dir.join("appdata"));
        // The temp-projects dir hangs off LOCALAPPDATA; isolate it too so the
        // quick-view tests never touch the real %LOCALAPPDATA%\Taroting.
        let prev_local = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", dir.join("localappdata"));

        body(&dir);

        match prev {
            Some(v) => std::env::set_var("APPDATA", v),
            None => std::env::remove_var("APPDATA"),
        }
        match prev_local {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_json(path: &Path, v: &Value) {
        std::fs::write(path, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    }

    /// mtime of a just-written file, using the same derivation as the scan.
    fn disk_mtime_ms(path: &Path) -> u64 {
        mtime_ms_of(&std::fs::metadata(path).unwrap())
    }

    #[test]
    fn load_skips_generated_media_in_missing_scan() {
        with_isolated("gen-missing", |dir| {
            // A real file whose size + mtime match its media entry, plus a
            // generated solid whose `path` is a display label (no file on disk).
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let m1_mtime = disk_mtime_ms(&media_file);
            let proj = dir.join("Gen.trt");
            write_json(
                &proj,
                &serde_json::json!({
                    "schema": 1, "app": "taroting", "id": "p1", "name": "Gen",
                    "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                    "media": [{
                        "id": "m1", "path": media_file.to_string_lossy(), "size": 10,
                        "mtimeMs": m1_mtime, "kind": "video", "duration": 1.0, "hasAudio": false
                    }, {
                        "id": "m2", "path": "Solid #00ff00", "size": 0, "mtimeMs": 0,
                        "kind": "image", "duration": 0.0, "hasAudio": false,
                        "width": 64, "height": 64,
                        "generator": { "type": "solid", "color": "#00ff00" }
                    }, {
                        "id": "m3", "path": "C:\\definitely\\not\\there.mp4", "size": 1,
                        "mtimeMs": 0, "kind": "video", "duration": 1.0, "hasAudio": false
                    }],
                    "timeline": {
                        "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                        "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                     "muted": false, "clips": [] }]
                    },
                    "export": {}
                }),
            );

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            // The generator is never "missing"; the bogus file-backed media is.
            assert_eq!(loaded.missing, vec!["m3".to_string()]);
        });
    }

    /// Build a one-media project at `proj` referencing `media_file` with the
    /// given stored size + mtime, then load and return the `missing` ids.
    fn missing_for(proj: &Path, media_file: &Path, size: u64, mtime_ms: u64) -> Vec<String> {
        write_json(
            proj,
            &serde_json::json!({
                "schema": 1, "app": "taroting", "id": "p1", "name": "Scan",
                "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                "media": [{
                    "id": "m1", "path": media_file.to_string_lossy(), "size": size,
                    "mtimeMs": mtime_ms, "kind": "video", "duration": 1.0, "hasAudio": false
                }],
                "timeline": {
                    "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                    "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                 "muted": false, "clips": [] }]
                },
                "export": {}
            }),
        );
        load_project(proj.to_string_lossy().into_owned())
            .unwrap()
            .missing
    }

    #[test]
    fn load_flags_same_size_different_mtime_as_missing() {
        with_isolated("scan-mtime", |dir| {
            // Same-size in-place content replacement bumps the file's mtime; the
            // stored mtime_ms is now stale, so the media must be flagged missing.
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let size = std::fs::metadata(&media_file).unwrap().len();
            let stale_mtime = disk_mtime_ms(&media_file).wrapping_sub(5_000);

            let proj = dir.join("Scan.trt");
            assert_eq!(missing_for(&proj, &media_file, size, stale_mtime), vec!["m1"]);
        });
    }

    #[test]
    fn load_does_not_flag_unchanged_file() {
        with_isolated("scan-unchanged", |dir| {
            // Size + mtime both match what's on disk: not missing.
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let size = std::fs::metadata(&media_file).unwrap().len();
            let mtime = disk_mtime_ms(&media_file);

            let proj = dir.join("Scan.trt");
            assert!(missing_for(&proj, &media_file, size, mtime).is_empty());
        });
    }

    #[test]
    fn now_iso8601_is_well_formed() {
        let s = now_iso8601();
        // e.g. 2026-07-02T15:04:05Z
        assert_eq!(s.len(), 20, "unexpected length: {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
        let year: i64 = s[0..4].parse().unwrap();
        assert!(year >= 2024 && year < 3000, "implausible year: {year}");
    }

    /// Build a project at `proj` whose first (and only) clip references the
    /// first media entry, so `first_clip_media` resolves. `media` is the media
    /// array; the timeline gets one video track with a clip on `media[0]`.
    fn write_project_with_clip(proj: &Path, media: Value) {
        let first_id = media[0]["id"].as_str().unwrap().to_string();
        write_json(
            proj,
            &serde_json::json!({
                "schema": 1, "app": "taroting", "id": "p1", "name": "Thumb",
                "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                "media": media,
                "timeline": {
                    "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                    "tracks": [{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                        "clips": [{
                            "id": "c1", "mediaId": first_id,
                            "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 2.0, "speed": 1.0,
                            "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                                       "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                        }] }]
                },
                "export": {}
            }),
        );
    }

    #[test]
    fn thumb_source_none_for_unreadable_or_clipless_or_missing() {
        with_isolated("thumb-none", |dir| {
            // Nonexistent project file → None.
            let ghost = dir.join("nope.trt");
            assert!(thumb_source_for(&ghost.to_string_lossy()).is_none());

            // Valid project but no clips → first_clip_media None → None.
            let clipless = dir.join("Clipless.trt");
            write_json(
                &clipless,
                &serde_json::json!({
                    "schema": 1, "app": "taroting", "id": "p1", "name": "Clipless",
                    "createdAt": "x", "modifiedAt": "y",
                    "media": [], "export": {},
                    "timeline": { "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                        "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                     "muted": false, "clips": [] }] }
                }),
            );
            assert!(thumb_source_for(&clipless.to_string_lossy()).is_none());

            // First clip's file-backed media is missing on disk → None (never
            // hands a nonexistent path to ffmpeg).
            let missing = dir.join("Missing.trt");
            write_project_with_clip(
                &missing,
                serde_json::json!([{
                    "id": "m1", "path": "C:\\definitely\\not\\there.mp4", "size": 1,
                    "mtimeMs": 0, "kind": "video", "duration": 2.0, "hasAudio": false
                }]),
            );
            assert!(thumb_source_for(&missing.to_string_lossy()).is_none());
        });
    }

    #[test]
    fn thumb_source_skips_generator_and_audio_first_clip() {
        with_isolated("thumb-skip", |dir| {
            // Generator-only first clip (a solid): no file, must skip cleanly.
            let gen = dir.join("Gen.trt");
            write_project_with_clip(
                &gen,
                serde_json::json!([{
                    "id": "m1", "path": "Solid #00ff00", "size": 0, "mtimeMs": 0,
                    "kind": "image", "duration": 0.0, "hasAudio": false,
                    "width": 64, "height": 64,
                    "generator": { "type": "solid", "color": "#00ff00" }
                }]),
            );
            assert!(thumb_source_for(&gen.to_string_lossy()).is_none());

            // Audio-only first clip: real file on disk, but no video frame.
            let audio_file = dir.join("a.bin");
            std::fs::write(&audio_file, b"0123456789").unwrap();
            let a_mtime = disk_mtime_ms(&audio_file);
            let aud = dir.join("Audio.trt");
            write_project_with_clip(
                &aud,
                serde_json::json!([{
                    "id": "m1", "path": audio_file.to_string_lossy(), "size": 10,
                    "mtimeMs": a_mtime, "kind": "audio", "duration": 2.0, "hasAudio": true
                }]),
            );
            assert!(thumb_source_for(&aud.to_string_lossy()).is_none());
        });
    }

    #[test]
    fn thumb_source_resolves_key_for_present_video() {
        with_isolated("thumb-ok", |dir| {
            // A file whose size + mtime match its media entry: identity ok →
            // returns the media key + a frame offset clamped into [0, 0.5].
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let mtime = disk_mtime_ms(&media_file);
            let proj = dir.join("Ok.trt");
            write_project_with_clip(
                &proj,
                serde_json::json!([{
                    "id": "m1", "path": media_file.to_string_lossy(), "size": 10,
                    "mtimeMs": mtime, "kind": "video", "duration": 4.0, "hasAudio": false
                }]),
            );

            let (key, at) = thumb_source_for(&proj.to_string_lossy()).expect("should resolve");
            assert_eq!(key.size, 10);
            assert_eq!(key.mtime_ms, mtime);
            assert_eq!(key.path, media_file.to_string_lossy());
            // duration 4.0 → 4/2 = 2.0, clamped to the 0.5 cap.
            assert_eq!(at, 0.5);

            // A same-size in-place edit bumps mtime → identity stale → None.
            std::fs::write(&media_file, b"9876543210").unwrap();
            // touch mtime forward deterministically via a second write; on the
            // off chance the clock granularity kept mtime equal, force it.
            let stale = thumb_source_for(&proj.to_string_lossy());
            if disk_mtime_ms(&media_file) != mtime {
                assert!(stale.is_none(), "stale mtime must skip");
            }
        });
    }

    /* -------------------- batched thumbnail backfill ------------------- */

    /// Build a project at `<dir>/<name>.trt` backed by a real media file, seed a
    /// cached thumbnail for it, and put a thumb-less recents entry in place —
    /// i.e. exactly the state a home mount backfills. Returns the project path.
    fn seed_thumbless_card(dir: &Path, cache: &crate::cache::Cache, name: &str) -> String {
        let media_file = dir.join(format!("{name}.bin"));
        std::fs::write(&media_file, b"0123456789").unwrap();
        let mtime = disk_mtime_ms(&media_file);
        let proj = dir.join(format!("{name}.trt"));
        write_project_with_clip(
            &proj,
            serde_json::json!([{
                "id": "m1", "path": media_file.to_string_lossy(), "size": 10,
                "mtimeMs": mtime, "kind": "video", "duration": 4.0, "hasAudio": false
            }]),
        );

        // A thumb already in the cache: the batch must reuse it, so the test
        // never depends on ffmpeg.
        let hash = crate::cache::MediaKey {
            path: media_file.to_string_lossy().into_owned(),
            size: 10,
            mtime_ms: mtime,
        }
        .hash();
        cache
            .ensure_kind_dir(crate::cache::CacheKind::Thumbs)
            .unwrap();
        std::fs::write(
            cache.file_path(crate::cache::CacheKind::Thumbs, &hash, "_500.jpg"),
            b"jpg",
        )
        .unwrap();

        let path = proj.to_string_lossy().into_owned();
        upsert_recent(RecentItem {
            path: path.clone(),
            name: name.into(),
            modified_at: "m".into(),
            duration_sec: 4.0,
            thumb: None,
            size_bytes: 0,
            opened_at: None,
        })
        .unwrap();
        path
    }

    /// The batching property, observed through `atomic_write`'s own `.bak`
    /// rotation: after the batch, `recents.json.bak` still holds the PRE-batch
    /// state. A second write would have rotated the once-updated file into the
    /// backup, so this pins "one write for the whole mount", not merely "the
    /// right end state".
    #[test]
    fn batched_thumb_refresh_writes_recents_exactly_once() {
        with_isolated("thumb-batch", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let jobs = crate::jobs::Jobs::default();
            let a = seed_thumbless_card(dir, &cache, "Alpha");
            let b = seed_thumbless_card(dir, &cache, "Beta");

            let resolved = refresh_thumbs_for(&cache, &jobs, &[a.clone(), b.clone()]);
            assert_eq!(resolved.len(), 2, "both cards should resolve: {resolved:?}");
            assert_eq!(resolved[0].0, a, "results follow input order");

            // End state: both entries carry their thumb.
            let items = read_recents().items;
            for path in [&a, &b] {
                let entry = items.iter().find(|r| r.path == *path).unwrap();
                assert!(entry.thumb.is_some(), "{path} should have a thumb");
            }

            // ...and the backup proves only ONE write produced it.
            let bak = paths::data_dir().unwrap().join("recents.json.bak");
            let prior: RecentsIndex =
                serde_json::from_slice(&std::fs::read(&bak).unwrap()).unwrap();
            assert_eq!(prior.items.len(), 2, "backup should be the pre-batch index");
            assert!(
                prior.items.iter().all(|r| r.thumb.is_none()),
                "a second write would have rotated a half-updated index into .bak: {prior:?}"
            );
        });
    }

    /// The single-path form still behaves exactly as before now that it shares
    /// the batched core: it returns the thumb, persists it, and stays silent for
    /// a project that cannot produce one.
    #[test]
    fn single_thumb_refresh_still_resolves_and_fails_soft() {
        with_isolated("thumb-single", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let jobs = crate::jobs::Jobs::default();
            let path = seed_thumbless_card(dir, &cache, "Solo");

            let resolved = refresh_thumbs_for(&cache, &jobs, std::slice::from_ref(&path));
            let thumb = resolved.first().map(|(_, t)| t.clone()).unwrap();
            assert!(thumb.ends_with("_500.jpg"), "got {thumb}");
            let items = read_recents().items;
            assert_eq!(
                items.iter().find(|r| r.path == path).unwrap().thumb.as_deref(),
                Some(thumb.as_str())
            );

            // A generator-only project yields nothing and touches no thumbs dir.
            let gen = dir.join("Gen.trt");
            write_project_with_clip(
                &gen,
                serde_json::json!([{
                    "id": "m1", "path": "Solid #00ff00", "size": 0, "mtimeMs": 0,
                    "kind": "image", "duration": 0.0, "hasAudio": false,
                    "width": 64, "height": 64,
                    "generator": { "type": "solid", "color": "#00ff00" }
                }]),
            );
            assert!(
                refresh_thumbs_for(&cache, &jobs, &[gen.to_string_lossy().into_owned()]).is_empty()
            );
        });
    }

    /// Parse a raw project JSON `Value` into a typed `ProjectFile` for testing
    /// `first_clip_media` directly (no files on disk, no identity checks).
    fn typed_project(v: Value) -> ProjectFile {
        serde_json::from_value(schema::migrate(v).unwrap()).unwrap()
    }

    /// A file-backed video `MediaRef` JSON with the given id, sized 10 bytes.
    fn video_media(id: &str) -> Value {
        serde_json::json!({
            "id": id, "path": format!("C:\\media\\{id}.mp4"), "size": 10,
            "mtimeMs": 1, "kind": "video", "duration": 2.0, "hasAudio": false
        })
    }

    /// A clip JSON on `media_id` starting at `start` seconds.
    fn clip_at(id: &str, media_id: &str, start: f64) -> Value {
        serde_json::json!({
            "id": id, "mediaId": media_id,
            "timelineStart": start, "srcIn": 0.0, "srcOut": 2.0, "speed": 1.0,
            "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                       "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
        })
    }

    /// Assemble a project with the given `media` array and `tracks` array.
    fn project_with_tracks(media: Value, tracks: Value) -> Value {
        serde_json::json!({
            "schema": 1, "app": "taroting", "id": "p1", "name": "Multi",
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
            "media": media,
            "timeline": {
                "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                "tracks": tracks
            },
            "export": {}
        })
    }

    #[test]
    fn first_clip_media_uses_lower_track_when_top_is_empty() {
        // User's exact repro: V2 (topmost) empty, V1 (below) holds a clip at 0.
        // The empty top track must NOT hide V1's clip — its media resolves.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([video_media("m1")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false, "clips": [] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("c1", "m1", 0.0)] }
            ]),
        ));
        let media = first_clip_media(&proj).expect("bottom track's clip must resolve");
        assert_eq!(media.id, "m1");
    }

    #[test]
    fn first_clip_media_picks_earliest_across_tracks() {
        // Two non-empty video tracks: top starts at 5.0, bottom starts at 1.0.
        // The earliest clip (bottom, t=1.0) wins regardless of track order.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([video_media("mTop"), video_media("mBottom")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false,
                  "clips": [clip_at("c2", "mTop", 5.0)] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("c1", "mBottom", 1.0)] }
            ]),
        ));
        let media = first_clip_media(&proj).expect("earliest clip must resolve");
        assert_eq!(media.id, "mBottom");

        // Tie at the same start → topmost (lowest index) track wins.
        let tied = typed_project(project_with_tracks(
            serde_json::json!([video_media("mTop"), video_media("mBottom")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false,
                  "clips": [clip_at("c2", "mTop", 2.0)] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("c1", "mBottom", 2.0)] }
            ]),
        ));
        assert_eq!(first_clip_media(&tied).unwrap().id, "mTop");
    }

    #[test]
    fn first_clip_media_none_when_all_video_tracks_empty() {
        // No clips on any video track → None (placeholder by design).
        let proj = typed_project(project_with_tracks(
            serde_json::json!([video_media("m1")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false, "clips": [] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false, "clips": [] }
            ]),
        ));
        assert!(first_clip_media(&proj).is_none());
    }

    #[test]
    fn first_clip_media_skips_audio_media_on_video_track() {
        // Defensive: earliest clip resolves to audio-kind media (shouldn't happen
        // on a video track). Fall back to the next candidate with a real frame.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([
                {
                    "id": "mAudio", "path": "C:\\media\\a.m4a", "size": 10,
                    "mtimeMs": 1, "kind": "audio", "duration": 2.0, "hasAudio": true
                },
                video_media("mVideo")
            ]),
            serde_json::json!([
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("cA", "mAudio", 0.0), clip_at("cV", "mVideo", 3.0)] }
            ]),
        ));
        let media = first_clip_media(&proj).expect("should fall through to video");
        assert_eq!(media.id, "mVideo");
    }

    #[test]
    fn first_clip_media_ignores_audio_tracks() {
        // An audio track carrying an earlier clip must be ignored entirely; only
        // the video track's clip is a thumbnail candidate.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([
                {
                    "id": "mA", "path": "C:\\media\\a.m4a", "size": 10,
                    "mtimeMs": 1, "kind": "audio", "duration": 2.0, "hasAudio": true
                },
                video_media("mV")
            ]),
            serde_json::json!([
                { "id": "tv", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("cV", "mV", 4.0)] },
                { "id": "ta", "kind": "audio", "name": "A1", "muted": false,
                  "clips": [clip_at("cA", "mA", 0.0)] }
            ]),
        ));
        assert_eq!(first_clip_media(&proj).unwrap().id, "mV");
    }

    #[test]
    fn rename_preserves_unknown_fields_and_updates_name() {
        with_isolated("rename", |dir| {
            let old = dir.join("Old.trt");
            let value = serde_json::json!({
                "schema": 1, "app": "taroting", "id": "abc", "name": "Old",
                "createdAt": "x", "modifiedAt": "y",
                "media": [], "timeline": {}, "export": {},
                "futureField": { "nested": [1, 2, 3] }
            });
            write_json(&old, &value);

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "Fresh".into()).unwrap();
            assert!(new_path.ends_with("Fresh.trt"), "got {new_path}");
            assert!(!old.exists(), "old file should be gone");

            let written: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(written["name"], "Fresh");
            assert_eq!(written["id"], "abc"); // untouched
            assert_eq!(written["futureField"]["nested"], serde_json::json!([1, 2, 3]));
        });
    }

    #[test]
    fn rename_dedupes_when_target_exists() {
        with_isolated("rename-dedupe", |dir| {
            let old = dir.join("A.trt");
            write_json(&old, &serde_json::json!({ "name": "A", "id": "1" }));
            write_json(&dir.join("Taken.trt"), &serde_json::json!({ "name": "Taken" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "Taken".into()).unwrap();
            assert!(new_path.ends_with("Taken (2).trt"), "got {new_path}");
        });
    }

    #[test]
    fn rename_to_own_name_keeps_filename() {
        with_isolated("rename-self", |dir| {
            // Renaming to a name whose sanitized form equals the current stem
            // must keep "Self.trt", not dedupe to "Self (2).trt".
            let old = dir.join("Self.trt");
            write_json(&old, &serde_json::json!({ "name": "Self", "id": "1" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "Self".into()).unwrap();
            assert!(new_path.ends_with("Self.trt"), "got {new_path}");
            assert!(!new_path.ends_with("Self (2).trt"), "got {new_path}");
            assert!(Path::new(&new_path).exists());
        });
    }

    /// Every `.trt` sitting directly in `dir`, by on-disk name.
    fn trt_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".trt"))
            .collect();
        names.sort();
        names
    }

    /// A case-only rename must produce ONE file with the new casing. `exists()`
    /// is case-insensitive on Windows while the old `exclude == Some(..)` test
    /// was byte-exact, so the candidate looked taken but not excluded: the
    /// rename deduped to "my film (2).trt" and then deleted the original.
    #[test]
    fn rename_changing_only_case_keeps_a_single_file() {
        with_isolated("rename-case", |dir| {
            let old = dir.join("My Film.trt");
            write_json(&old, &serde_json::json!({ "name": "My Film", "id": "1" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "my film".into()).unwrap();

            assert!(new_path.ends_with("my film.trt"), "got {new_path}");
            assert!(!new_path.contains("(2)"), "case-only rename must not dedupe: {new_path}");
            assert_eq!(
                trt_names(dir),
                vec!["my film.trt".to_string()],
                "exactly one project file, under the new casing"
            );
            // ...and it is the renamed project, not an emptied leftover.
            let written: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(written["name"], "my film");
            assert_eq!(written["id"], "1");
        });
    }

    /// The dedupe itself must still work: a DIFFERENT project already holding
    /// the target name (case-insensitively) still pushes the rename to " (2)".
    #[test]
    fn rename_still_dedupes_against_another_project_differing_only_in_case() {
        with_isolated("rename-case-other", |dir| {
            let old = dir.join("Draft.trt");
            write_json(&old, &serde_json::json!({ "name": "Draft", "id": "1" }));
            write_json(&dir.join("Taken.trt"), &serde_json::json!({ "name": "Taken", "id": "2" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "taken".into()).unwrap();
            assert!(new_path.ends_with("taken (2).trt"), "got {new_path}");
            // the other project is untouched
            let other: Value = read_raw_value(&dir.join("Taken.trt")).unwrap();
            assert_eq!(other["id"], "2");
        });
    }

    /// Two names Rust's `to_lowercase` folds together and Windows does NOT.
    /// Renaming one onto the other must dedupe, never overwrite.
    ///
    /// This is measured against real files rather than string rules, because
    /// string rules are exactly what got this wrong: folding in Rust reported
    /// the neighbour's path free, `atomic_write` rotated that innocent project
    /// into `.bak` and wrote over it, and the rename's own cleanup then
    /// mis-fired too, so the original was orphaned. One rename, two projects
    /// destroyed.
    #[test]
    fn rename_never_overwrites_a_unicode_neighbour() {
        with_isolated("rename-unicode", |dir| {
            // U+00DF vs U+1E9E, and ASCII "K" vs U+212A KELVIN SIGN. Both pairs
            // lowercase to the same string in Rust; both are two files on NTFS.
            let pairs = [
                ("Stra\u{00df}e", "Stra\u{1e9e}e"),
                ("Kelvin", "\u{212a}elvin"),
            ];
            for (i, (mine, neighbour)) in pairs.into_iter().enumerate() {
                let case = dir.join(format!("case{i}"));
                std::fs::create_dir_all(&case).unwrap();
                let mine_path = case.join(format!("{mine}.trt"));
                let neighbour_path = case.join(format!("{neighbour}.trt"));
                write_json(&mine_path, &serde_json::json!({ "name": mine, "id": "mine" }));
                write_json(
                    &neighbour_path,
                    &serde_json::json!({ "name": neighbour, "id": "neighbour" }),
                );

                // The premise, measured rather than assumed: this filesystem
                // keeps the two names apart even though Rust folds them.
                assert_eq!(mine.to_lowercase(), neighbour.to_lowercase());
                assert_eq!(
                    trt_names(&case).len(),
                    2,
                    "{mine} and {neighbour} must be two files on disk"
                );

                // Rename mine to the neighbour's exact name.
                let new_path = rename_project(
                    mine_path.to_string_lossy().into_owned(),
                    neighbour.to_string(),
                )
                .unwrap();

                // The name belongs to somebody else, so this must dedupe...
                assert!(
                    new_path.ends_with(&format!("{neighbour} (2).trt")),
                    "got {new_path}"
                );
                // ...and the neighbour must be exactly as it was: not rotated
                // into a `.bak`, not written over.
                let victim: Value = read_raw_value(&neighbour_path).unwrap();
                assert_eq!(victim["id"], "neighbour", "the neighbour was overwritten");
                assert!(
                    !case.join(format!("{neighbour}.trt.bak")).exists(),
                    "the neighbour was rotated into a .bak"
                );
                // The renamed project kept its own contents under the new name.
                let renamed: Value = read_raw_value(Path::new(&new_path)).unwrap();
                assert_eq!(renamed["id"], "mine");
                assert_eq!(renamed["name"], neighbour);
                assert_eq!(trt_names(&case).len(), 2, "no third file, and none lost");
            }
        });
    }

    /// The case-only rename fix has to keep working for names Windows folds but
    /// ASCII rules do not: NTFS folds Ü/ü, so "Ünsteady" → "ünsteady" is one
    /// file and must stay one file. An ASCII-only comparison would under-match
    /// here and dedupe to " (2)" — harmless, but avoidable by asking the
    /// filesystem which names it actually folds.
    #[test]
    fn rename_changing_only_non_ascii_case_keeps_a_single_file() {
        with_isolated("rename-case-unicode", |dir| {
            let old = dir.join("\u{dc}nsteady.trt");
            write_json(
                &old,
                &serde_json::json!({ "name": "\u{dc}nsteady", "id": "1" }),
            );

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "\u{fc}nsteady".into()).unwrap();

            assert!(new_path.ends_with("\u{fc}nsteady.trt"), "got {new_path}");
            assert!(
                !new_path.contains("(2)"),
                "case-only rename must not dedupe: {new_path}"
            );
            assert_eq!(
                trt_names(dir),
                vec!["\u{fc}nsteady.trt".to_string()],
                "exactly one project file, under the new casing"
            );
            let written: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(written["id"], "1");
            assert_eq!(written["name"], "\u{fc}nsteady");
        });
    }

    /// The predicate itself, against files that really exist. `Same` must mean
    /// the filesystem says so, not that some folding rule says so.
    #[test]
    fn path_identity_answers_from_the_filesystem() {
        with_isolated("path-identity", |dir| {
            let one = dir.join("My Film.trt");
            std::fs::write(&one, b"x").unwrap();
            // One file, three spellings this filesystem folds together.
            for spelling in ["My Film.trt", "my film.trt", "MY FILM.TRT"] {
                assert_eq!(
                    path_identity(&one, &dir.join(spelling)),
                    PathIdentity::Same,
                    "{spelling} names the same file"
                );
            }

            // Pairs Rust's to_lowercase folds and Windows keeps apart. Each is
            // written with distinct contents and read back, so "two files" is
            // observed, not assumed.
            for (a, b) in [
                ("Stra\u{00df}e.trt", "Stra\u{1e9e}e.trt"),
                ("Kelvin.trt", "\u{212a}elvin.trt"),
            ] {
                let (pa, pb) = (dir.join(a), dir.join(b));
                std::fs::write(&pa, b"aaa").unwrap();
                std::fs::write(&pb, b"bbb").unwrap();
                assert_eq!(std::fs::read(&pa).unwrap(), b"aaa", "{a} was clobbered by {b}");
                assert_eq!(
                    path_identity(&pa, &pb),
                    PathIdentity::Different,
                    "{a} and {b} are two files on disk"
                );
            }

            // Nothing to open → no answer at all. Callers must not read one
            // into it; each picks the direction whose failure is cosmetic.
            assert_eq!(
                path_identity(&dir.join("ghost.trt"), &one),
                PathIdentity::Unknown
            );
            // ...though two identical paths need no filesystem to compare.
            assert_eq!(
                path_identity(&dir.join("ghost.trt"), &dir.join("ghost.trt")),
                PathIdentity::Same
            );
        });
    }

    #[test]
    fn duplicate_gives_fresh_id_and_leaves_original() {
        with_isolated("dup", |dir| {
            let src = dir.join("Src.trt");
            write_json(
                &src,
                &serde_json::json!({ "name": "Src", "id": "orig-id", "modifiedAt": "z", "keep": true }),
            );

            let new_path = duplicate_project(
                src.to_string_lossy().into_owned(),
                "Src copy".into(),
                "new-id".into(),
            )
            .unwrap();
            assert!(new_path.ends_with("Src copy.trt"), "got {new_path}");
            assert!(src.exists(), "original must remain");

            let orig: Value = read_raw_value(&src).unwrap();
            assert_eq!(orig["id"], "orig-id"); // original untouched

            let copy: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(copy["id"], "new-id");
            assert_eq!(copy["name"], "Src copy");
            assert_eq!(copy["keep"], true); // unknown field preserved
        });
    }

    #[test]
    fn delete_removes_file_and_bak() {
        with_isolated("delete", |dir| {
            let target = dir.join("Gone.trt");
            atomic_write(&target, b"one").unwrap();
            atomic_write(&target, b"two").unwrap(); // creates Gone.trt.bak
            let bak = dir.join("Gone.trt.bak");
            assert!(target.exists() && bak.exists());

            delete_project(target.to_string_lossy().into_owned()).unwrap();
            assert!(!target.exists(), "file should be deleted");
            assert!(!bak.exists(), ".bak should be deleted");
        });
    }

    #[test]
    fn recents_lifecycle_across_commands() {
        with_isolated("recents", |dir| {
            // Seed a recents entry for a source project.
            let src = dir.join("Proj.trt");
            write_json(
                &src,
                &serde_json::json!({ "name": "Proj", "id": "1", "modifiedAt": "m" }),
            );
            upsert_recent(RecentItem {
                path: src.to_string_lossy().into_owned(),
                name: "Proj".into(),
                modified_at: "m".into(),
                duration_sec: 12.5,
                thumb: None,
                size_bytes: 0,
                opened_at: Some("2020-01-01T00:00:00Z".into()),
            })
            .unwrap();
            assert_eq!(read_recents().items.len(), 1, "seed should persist");

            // Rename → recents entry path+name updated in place.
            let renamed =
                rename_project(src.to_string_lossy().into_owned(), "Renamed".into()).unwrap();
            let items = read_recents().items;
            assert!(items.iter().any(|r| r.path == renamed && r.name == "Renamed"));
            assert!(!items.iter().any(|r| r.name == "Proj"));

            // Duplicate → new recents entry carrying the source duration, no openedAt.
            let dup = duplicate_project(renamed.clone(), "Renamed copy".into(), "dup-id".into())
                .unwrap();
            let items = read_recents().items;
            let dup_entry = items.iter().find(|r| r.path == dup).unwrap();
            assert_eq!(dup_entry.duration_sec, 12.5);
            assert!(dup_entry.opened_at.is_none());

            // Delete → recents entry removed.
            delete_project(dup.clone()).unwrap();
            assert!(!read_recents().items.iter().any(|r| r.path == dup));

            // list_recents refreshes size_bytes for survivors.
            let listed = list_recents().unwrap();
            let entry = listed.items.iter().find(|r| r.path == renamed).unwrap();
            assert!(entry.size_bytes > 0, "size should be stat'ed");
        });
    }

    #[test]
    fn atomic_write_rotates_backup() {
        let dir = std::env::temp_dir().join(format!("taroting-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("file.json");

        atomic_write(&target, b"one").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"one");

        atomic_write(&target, b"two").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"two");
        let bak = dir.join("file.json.bak");
        assert_eq!(std::fs::read(&bak).unwrap(), b"one");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------------------- corruption / data-loss guards ---------------- */

    #[test]
    fn a_zero_speed_clip_is_normalised_and_keeps_recents_intact() {
        with_isolated("nonfinite-duration", |dir| {
            // A healthy project already sitting in recents.
            let healthy = dir.join("Healthy.trt");
            write_json(&healthy, &minimal_project("Healthy"));
            upsert_recent(RecentItem {
                path: healthy.to_string_lossy().into_owned(),
                name: "Healthy".into(),
                modified_at: "m".into(),
                duration_sec: 12.5,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
            })
            .unwrap();

            // `speed: 0` USED to make Clip::duration() infinite, and
            // Timeline::duration() propagated it. serde_json writes a non-finite
            // f64 as `null`, which made the WHOLE index unparseable — 2 entries
            // in, 0 out, i.e. every project card gone from home.
            //
            // `de_speed` in schema.rs now normalises a zero/negative/non-finite
            // speed to 1.0 at the deserialize boundary, so the hazard no longer
            // starts. This case is kept, and still loaded end to end, because it
            // is the regression guard for that: if the normalisation is ever
            // dropped the duration goes non-finite again right here. The index's
            // own tolerance for a `null` duration is guarded separately by
            // `null_duration_in_a_stored_index_does_not_wipe_it`.
            let mut v = minimal_project("Poisoned");
            v["media"] = serde_json::json!([video_media("m1")]);
            v["timeline"]["tracks"] = serde_json::json!([{
                "id": "t1", "kind": "video", "name": "V1", "muted": false,
                "clips": [{
                    "id": "c1", "mediaId": "m1",
                    "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 2.0, "speed": 0.0,
                    "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                               "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                }]
            }]);
            let poisoned = dir.join("Poisoned.trt");
            write_json(&poisoned, &v);

            // The speed is normalised on the way in, so the duration is finite:
            // 2.0 s of source at 1.0x. A revert of `de_speed` fails here first.
            let typed = typed_project(v);
            assert!(
                typed.timeline.duration().is_finite(),
                "a zero speed must be normalised at deserialize, not propagated"
            );
            assert_eq!(typed.timeline.tracks[0].clips[0].speed, 1.0);

            // load_project → stamp_opened persists it into the index.
            load_project(poisoned.to_string_lossy().into_owned()).unwrap();

            let listed = list_recents().unwrap();
            assert_eq!(listed.items.len(), 2, "index was wiped: {listed:?}");
            let bad = listed.items.iter().find(|r| r.name == "Poisoned").unwrap();
            assert_eq!(
                bad.duration_sec, 2.0,
                "the normalised 1.0x speed must yield the real 2 s duration"
            );
            let ok = listed.items.iter().find(|r| r.name == "Healthy").unwrap();
            assert_eq!(ok.duration_sec, 12.5, "the other entry must be intact");
        });
    }

    #[test]
    fn null_duration_in_a_stored_index_does_not_wipe_it() {
        // An index written by an older build carries a literal `null` here.
        // Parsing must degrade to one wrong duration, never to an empty home.
        let raw = r#"{"schema":1,"items":[
            {"path":"C:\\a.trt","name":"A","modifiedAt":"m","durationSec":null},
            {"path":"C:\\b.trt","name":"B","modifiedAt":"m","durationSec":4.5},
            {"path":"C:\\c.trt","name":"C","modifiedAt":"m"}]}"#;
        let index: RecentsIndex = serde_json::from_str(raw).unwrap();
        assert_eq!(index.items.len(), 3);
        assert_eq!(index.items[0].duration_sec, 0.0);
        assert_eq!(index.items[1].duration_sec, 4.5);
        assert_eq!(index.items[2].duration_sec, 0.0);
    }

    #[test]
    fn load_recovers_from_bak_when_primary_missing() {
        with_isolated("bak-missing-primary", |dir| {
            // A save whose final rename failed used to leave exactly this on
            // disk: no project, only the rotated `.bak`. Reading it returned
            // NotFound, so the project looked permanently lost even though a
            // good copy was sitting right next to it.
            let proj = dir.join("Rescued.trt");
            write_json(&dir.join("Rescued.trt.bak"), &minimal_project("Rescued"));
            assert!(!proj.exists());

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert!(loaded.recovered, "must be flagged as recovered from .bak");
            assert_eq!(loaded.project["name"], "Rescued");

            // With neither copy present the error still surfaces.
            let ghost = dir.join("Ghost.trt");
            assert!(load_project(ghost.to_string_lossy().into_owned()).is_err());
        });
    }

    /// The recovery above is only useful if the user can still REACH the
    /// project. list_recents drops entries whose file is gone, which would hide
    /// exactly the interrupted-save case it is meant to rescue.
    #[test]
    fn recents_keeps_a_project_surviving_only_as_bak() {
        with_isolated("recents-bak-survivor", |dir| {
            let alive = dir.join("Alive.trt");
            write_json(&alive, &minimal_project("Alive"));

            // Interrupted save: primary rotated to .bak, replacement never landed.
            let wounded = dir.join("Wounded.trt");
            write_json(&dir.join("Wounded.trt.bak"), &minimal_project("Wounded"));
            assert!(!wounded.exists());

            // Genuinely deleted: neither copy on disk.
            let gone = dir.join("Gone.trt");

            for (p, name) in [(&alive, "Alive"), (&wounded, "Wounded"), (&gone, "Gone")] {
                upsert_recent(RecentItem {
                    path: p.to_string_lossy().into_owned(),
                    name: name.into(),
                    modified_at: String::new(),
                    duration_sec: 0.0,
                    thumb: None,
                    size_bytes: 0,
                    opened_at: None,
                })
                .unwrap();
            }

            let names: Vec<String> = list_recents()
                .unwrap()
                .items
                .into_iter()
                .map(|r| r.path)
                .collect();
            let has = |p: &std::path::Path| names.iter().any(|n| n == &*p.to_string_lossy());

            assert!(has(&alive), "a normal project must stay listed");
            assert!(has(&wounded), "a .bak-only project must stay reachable");
            assert!(!has(&gone), "a deleted project must still be dropped");
        });
    }

    /// Both halves of the ".bak was written but never read" bug. The settings
    /// half lives here rather than in `settings.rs` because APPDATA is a
    /// process-global: only `ENV_LOCK` + `with_isolated` keep it from racing the
    /// other tests in this file.
    #[test]
    fn corrupt_primary_recovers_from_bak_for_recents_and_settings() {
        with_isolated("bak-recovery", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();

            // Recents: a truncated index used to silently mean "no projects".
            let good = RecentsIndex {
                schema: 1,
                items: vec![RecentItem {
                    path: "C:\\projects\\Kept.trt".into(),
                    name: "Kept".into(),
                    modified_at: "m".into(),
                    duration_sec: 3.5,
                    thumb: None,
                    size_bytes: 0,
                    opened_at: None,
                }],
            };
            std::fs::write(
                data.join("recents.json.bak"),
                serde_json::to_vec(&good).unwrap(),
            )
            .unwrap();
            std::fs::write(data.join("recents.json"), b"{\"schema\":1,\"items\":[{\"pa").unwrap();

            let items = read_recents().items;
            assert_eq!(items.len(), 1, "should have recovered from the .bak");
            assert_eq!(items[0].name, "Kept");
            assert_eq!(items[0].duration_sec, 3.5);

            // Settings: a corrupt file used to silently apply ALL defaults, and
            // the next save then destroyed the last good backup for good.
            let settings = data.join("settings.json");
            std::fs::write(
                data.join("settings.json.bak"),
                serde_json::to_vec(&serde_json::json!({ "theme": "dark", "monitorVolume": 0.42 }))
                    .unwrap(),
            )
            .unwrap();
            std::fs::write(&settings, b"not json at all").unwrap();

            let loaded = crate::settings::get_settings().unwrap();
            assert_eq!(loaded.status, crate::settings::SettingsStatus::Ok);
            assert!(loaded.recovered, "the .bak supplied the value");
            let value = loaded
                .settings
                .expect("settings should be recovered from the .bak");
            assert_eq!(value["theme"], "dark");
            assert_eq!(value["monitorVolume"], 0.42);

            // Nothing on disk at all is still a clean first run → frontend defaults.
            std::fs::remove_file(&settings).unwrap();
            std::fs::remove_file(data.join("settings.json.bak")).unwrap();
            let fresh = crate::settings::get_settings().unwrap();
            assert_eq!(fresh.status, crate::settings::SettingsStatus::Absent);
            assert!(fresh.settings.is_none());
        });
    }

    /// `get_settings` must tell the three read outcomes apart. Collapsing
    /// "exists but unreadable" into the same `null` as "nothing there yet" made
    /// the frontend treat a corrupt or locked settings.json as a FIRST RUN: no
    /// toast, the overwrite guard marked itself verified, and the next save put
    /// `{ ...DEFAULTS, ...patch }` over the user's real preferences.
    #[test]
    fn get_settings_separates_absent_from_unreadable() {
        use crate::settings::{get_settings, SettingsStatus};

        with_isolated("settings-status", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let settings = data.join("settings.json");
            let bak = data.join("settings.json.bak");

            // Neither copy on disk → a clean first run; defaults are safe.
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Absent);
            assert!(r.settings.is_none());
            assert!(!r.recovered);

            // A readable primary → Ok, no recovery involved.
            std::fs::write(&settings, br#"{"theme":"dark","monitorVolume":0.42}"#).unwrap();
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Ok);
            assert!(!r.recovered);
            assert_eq!(r.settings.unwrap()["monitorVolume"], 0.42);

            // Corrupt primary + good backup → still Ok, flagged as recovered.
            std::fs::write(&bak, br#"{"theme":"light"}"#).unwrap();
            std::fs::write(&settings, b"not json at all").unwrap();
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Ok);
            assert!(r.recovered, "the .bak supplied the value");
            assert_eq!(r.settings.unwrap()["theme"], "light");

            // Both copies corrupt → Unreadable, NOT Absent. Something is stored;
            // we simply cannot read it, so nothing may be written over it.
            std::fs::write(&bak, b"also not json").unwrap();
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Unreadable);
            assert!(r.settings.is_none());
        });
    }

    /// The cause named in `get_settings`'s own comment: a Windows lock making
    /// `std::fs::read` fail. The file is present and perfectly VALID — the read
    /// just cannot happen right now — which is the case most easily mistaken
    /// for a first run, and the most expensive one to get wrong.
    #[cfg(windows)]
    #[test]
    fn a_locked_settings_file_reads_as_unreadable_not_absent() {
        use crate::settings::{get_settings, SettingsStatus};
        use std::os::windows::fs::OpenOptionsExt;

        with_isolated("settings-locked", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let settings = data.join("settings.json");
            std::fs::write(&settings, br#"{"theme":"dark"}"#).unwrap();

            // FILE_SHARE_NONE, as an AV scanner or a sync agent would hold it:
            // every byte is intact, `std::fs::read` just gets a sharing
            // violation (os error 32) rather than NotFound.
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&settings)
                .unwrap();

            let r = get_settings().unwrap();
            assert_eq!(
                r.status,
                SettingsStatus::Unreadable,
                "a locked settings.json is present, not absent"
            );
            assert!(r.settings.is_none());

            // Released → readable again, and the file was never touched.
            drop(lock);
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Ok);
            assert_eq!(r.settings.unwrap()["theme"], "dark");
        });
    }

    /// An index that exists but cannot be read is NOT an empty index. Writing
    /// the empty default over it rotated the last good copy into `.bak`, and
    /// because the fresh primary then parsed fine the recovery path never
    /// looked at that backup again — one unreadable file plus one ordinary save
    /// lost the user's entire recents list.
    #[test]
    fn an_unreadable_recents_index_is_never_overwritten() {
        with_isolated("recents-unreadable", |dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let recents = data.join("recents.json");
            let bak = data.join("recents.json.bak");

            // Both copies truncated: unreadable, not absent.
            std::fs::write(&recents, b"{\"schema\":1,\"items\":[{\"pa").unwrap();
            std::fs::write(&bak, b"{\"schema\":1,\"items\":[{\"na").unwrap();
            let before = std::fs::read(&recents).unwrap();
            let before_bak = std::fs::read(&bak).unwrap();

            let card = |path: &Path, name: &str| RecentItem {
                path: path.to_string_lossy().into_owned(),
                name: name.into(),
                modified_at: "m".into(),
                duration_sec: 1.0,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
            };

            let proj = dir.join("Saved.trt");
            write_json(&proj, &minimal_project("Saved"));

            // A save must still succeed — recents is a convenience, and a
            // corrupt index must not be able to fail the user's actual work.
            upsert_recent(card(&proj, "Saved")).unwrap();
            assert_eq!(
                std::fs::read(&recents).unwrap(),
                before,
                "an unreadable index must be left exactly as found"
            );
            assert_eq!(
                std::fs::read(&bak).unwrap(),
                before_bak,
                "the backup must not be rotated away either"
            );

            // The other mutation paths hold the same line.
            load_project(proj.to_string_lossy().into_owned()).unwrap(); // stamp_opened
            remove_recent(proj.to_string_lossy().into_owned()).unwrap();
            delete_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(std::fs::read(&recents).unwrap(), before);
            assert_eq!(std::fs::read(&bak).unwrap(), before_bak);

            // Genuine ABSENCE is a different thing and stays writable — that is
            // just a first run.
            std::fs::remove_file(&recents).unwrap();
            std::fs::remove_file(&bak).unwrap();
            let fresh = dir.join("Fresh.trt");
            write_json(&fresh, &minimal_project("Fresh"));
            upsert_recent(card(&fresh, "Fresh")).unwrap();
            assert_eq!(
                read_recents().items.len(),
                1,
                "an absent index must accept writes"
            );
        });
    }

    /// A rotation that fails must leave the previous backup where it was.
    /// Deleting the old `.bak` first meant a write going wrong took the backup
    /// down with it — no primary update, and no fallback either.
    #[cfg(windows)]
    #[test]
    fn a_failed_rotation_leaves_the_previous_backup_intact() {
        use std::os::windows::fs::OpenOptionsExt;

        with_isolated("bak-rotation", |dir| {
            let target = dir.join("Project.trt");
            atomic_write(&target, b"first").unwrap();
            atomic_write(&target, b"second").unwrap(); // rotates "first" into .bak
            let bak = dir.join("Project.trt.bak");
            assert_eq!(std::fs::read(&bak).unwrap(), b"first");

            // Hold the PRIMARY with no sharing (FILE_SHARE_NONE) so it cannot be
            // moved: the rotation rename fails, while the `.bak` — a different
            // file — stays perfectly deletable. That asymmetry is exactly what
            // made the old pre-delete destructive.
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&target)
                .unwrap();

            let err = atomic_write(&target, b"third");
            assert!(err.is_err(), "the rotation should have failed");
            assert_eq!(
                std::fs::read(&bak).unwrap(),
                b"first",
                "the last good backup must survive a failed write"
            );

            drop(lock);
            assert_eq!(
                std::fs::read(&target).unwrap(),
                b"second",
                "and the primary must be untouched"
            );
        });
    }

    /* -------------------- temp quick-view projects -------------------- */

    /// A minimal, clip-less but valid project JSON — enough for load_project to
    /// parse and (for a non-temp path) stamp a recents entry.
    fn minimal_project(name: &str) -> Value {
        serde_json::json!({
            "schema": 1, "app": "taroting", "id": "p1", "name": name,
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
            "media": [], "export": {},
            "timeline": {
                "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                             "muted": false, "clips": [] }]
            }
        })
    }

    #[test]
    fn temp_project_path_lands_in_temp_dir_and_dedupes() {
        with_isolated("temp-path", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();

            // First call → "<base>.trt" directly under the temp dir, nowhere near
            // Documents\Taroting.
            let p1 = temp_project_path(Some("Clip".into())).unwrap();
            let p1_path = Path::new(&p1);
            assert!(p1_path.starts_with(&tmp), "{p1} should be under {tmp:?}");
            assert!(p1.ends_with("Clip.trt"), "got {p1}");
            assert!(is_temp_project_path(&p1), "path must classify as temp");

            // Materialize it, then a second call must dedupe with a bare-space
            // suffix (mirroring new_project_path's naming).
            std::fs::write(p1_path, b"{}").unwrap();
            let p2 = temp_project_path(Some("Clip".into())).unwrap();
            assert!(p2.ends_with("Clip 2.trt"), "got {p2}");

            // A Documents path is NOT classified as temp.
            let permanent = new_project_path(Some("Clip".into())).unwrap();
            assert!(!is_temp_project_path(&permanent), "{permanent} is not temp");
        });
    }

    #[test]
    fn temp_projects_dir_command_matches_creation_dir() {
        with_isolated("temp-dir-cmd", |_dir| {
            // The command the frontend uses to classify open-with paths must
            // report exactly the dir temp_project_path creates into — otherwise a
            // .trt physically in the temp dir wouldn't be recognized as temp.
            let reported = temp_projects_dir().unwrap();
            let created = temp_project_path(Some("Clip".into())).unwrap();
            assert!(
                Path::new(&created).starts_with(&reported),
                "{created} should live under reported dir {reported}"
            );
            // And the reported dir is precisely paths::temp_projects_dir().
            assert_eq!(
                reported,
                paths::temp_projects_dir().unwrap().to_string_lossy()
            );
        });
    }

    #[test]
    fn load_project_on_temp_path_creates_no_recents_entry() {
        with_isolated("temp-load", |_dir| {
            // A project living in the temp dir must never be stamped into recents.
            let temp_path = temp_project_path(Some("Quick".into())).unwrap();
            write_json(Path::new(&temp_path), &minimal_project("Quick"));

            load_project(temp_path.clone()).unwrap();
            assert!(
                read_recents().items.is_empty(),
                "temp quick-view load must not touch recents"
            );

            // Sanity: the same load from a permanent path DOES stamp recents, so
            // the skip is specific to the temp dir (not a broken stamp path).
            let perm_dir = paths::default_projects_dir().unwrap();
            paths::ensure_dir(&perm_dir).unwrap();
            let perm_path = perm_dir.join("Kept.trt");
            write_json(&perm_path, &minimal_project("Kept"));
            load_project(perm_path.to_string_lossy().into_owned()).unwrap();
            assert_eq!(
                read_recents().items.len(),
                1,
                "permanent load should stamp exactly one recents entry"
            );
        });
    }

    #[test]
    fn cleanup_temp_projects_wipes_only_the_temp_dir() {
        with_isolated("temp-cleanup", |_dir| {
            // Seed a stale scratch file in the temp dir and an unrelated project
            // in Documents\Taroting.
            let temp_path = temp_project_path(Some("Stale".into())).unwrap();
            std::fs::write(&temp_path, b"{}").unwrap();
            let mut bak = temp_path.clone();
            bak.push_str(".bak");
            std::fs::write(&bak, b"{}").unwrap();

            let perm_dir = paths::default_projects_dir().unwrap();
            paths::ensure_dir(&perm_dir).unwrap();
            let keep = perm_dir.join("Keep.trt");
            std::fs::write(&keep, b"{}").unwrap();

            cleanup_temp_projects();

            // Everything (including the .bak) in the temp dir is gone; the temp
            // dir itself remains; the Documents project is untouched.
            assert!(!Path::new(&temp_path).exists(), "temp file must be wiped");
            assert!(!Path::new(&bak).exists(), "temp .bak must be wiped");
            assert!(
                paths::temp_projects_dir().unwrap().is_dir(),
                "temp dir itself should survive"
            );
            assert!(keep.exists(), "Documents project must be untouched");

            // Idempotent: a second run on the now-empty dir is a clean no-op.
            cleanup_temp_projects();
            assert!(keep.exists());
        });
    }
}
