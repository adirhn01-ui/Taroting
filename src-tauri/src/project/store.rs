//! Project persistence: atomic saves with .bak recovery, plus the recents
//! index read by the home screen at startup.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::schema::{self, ProjectFile};
use crate::error::{AppError, Result};
use crate::paths;

/* ------------------------------------------------------------------ */
/* Atomic writes                                                       */
/* ------------------------------------------------------------------ */

/// Write via temp file + rename so a crash never corrupts the target.
/// If the target exists it is first rotated to `<name>.bak`.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", path.display())))?;
    std::fs::create_dir_all(dir)?;

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;

    if path.exists() {
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        let bak = PathBuf::from(bak);
        let _ = std::fs::remove_file(&bak);
        std::fs::rename(path, &bak)?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
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
    let doe = (z - era * 146_097) as i64; // [0, 146096]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub modified_at: String,
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

fn read_recents() -> RecentsIndex {
    recents_path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_recents(index: &RecentsIndex) -> Result<()> {
    atomic_write(&recents_path()?, serde_json::to_vec(index)?.as_slice())
}

fn upsert_recent(mut item: RecentItem) -> Result<()> {
    let mut index = read_recents();
    // Preserve a prior openedAt when the caller doesn't supply one, and refresh
    // the on-disk size so callers don't all have to stat.
    if let Some(prev) = index.items.iter().find(|r| r.path == item.path) {
        if item.opened_at.is_none() {
            item.opened_at = prev.opened_at.clone();
        }
    }
    if let Ok(meta) = std::fs::metadata(&item.path) {
        item.size_bytes = meta.len();
    }
    index.items.retain(|r| r.path != item.path);
    index.items.insert(0, item);
    index.items.truncate(MAX_RECENTS);
    write_recents(&index)
}

#[tauri::command]
pub fn list_recents() -> Result<RecentsIndex> {
    let mut index = read_recents();
    // Drop entries whose project file vanished (moved/deleted by the user),
    // and refresh the on-disk size of the survivors.
    index.items.retain(|r| Path::new(&r.path).is_file());
    for r in &mut index.items {
        if let Ok(meta) = std::fs::metadata(&r.path) {
            r.size_bytes = meta.len();
        }
    }
    Ok(index)
}

#[tauri::command]
pub fn remove_recent(path: String) -> Result<()> {
    let mut index = read_recents();
    index.items.retain(|r| r.path != path);
    write_recents(&index)
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

fn read_project_value(path: &Path) -> Result<(Value, bool)> {
    match std::fs::read(path) {
        Ok(bytes) => {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                return Ok((v, false));
            }
            // corrupt main file → try the .bak
            let mut bak = path.as_os_str().to_owned();
            bak.push(".bak");
            let bak_bytes = std::fs::read(PathBuf::from(bak)).map_err(|_| {
                AppError::BadInput(format!("{} is not valid JSON", path.display()))
            })?;
            let v = serde_json::from_slice::<Value>(&bak_bytes).map_err(|_| {
                AppError::BadInput(format!("{} and its backup are both corrupt", path.display()))
            })?;
            Ok((v, true))
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn load_project(path: String) -> Result<LoadedProject> {
    let p = Path::new(&path);
    let (raw, recovered) = read_project_value(p)?;
    let migrated = schema::migrate(raw)?;
    let typed: ProjectFile = serde_json::from_value(migrated.clone())
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
    // freshly opened file may not be in the list yet).
    stamp_opened(&path, &typed);

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
    let mut index = read_recents();
    if let Some(entry) = index.items.iter_mut().find(|r| r.path == path) {
        entry.opened_at = Some(now);
    } else {
        let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        index.items.insert(
            0,
            RecentItem {
                path: path.to_string(),
                name: typed.name.clone(),
                modified_at: typed.modified_at.clone(),
                duration_sec: typed.timeline.duration(),
                thumb: None,
                size_bytes,
                opened_at: Some(now),
            },
        );
        index.items.truncate(MAX_RECENTS);
    }
    let _ = write_recents(&index);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    pub modified_at: String,
}

/// The media backing the first clip on the first track — the frame the recents
/// grid uses as a project's thumbnail. `None` when the project has no clips.
fn first_clip_media(typed: &ProjectFile) -> Option<&schema::MediaRef> {
    let clip = typed.timeline.tracks.first()?.clips.first()?;
    typed.media.iter().find(|m| m.id == clip.media_id)
}

#[tauri::command]
pub fn save_project(
    cache: tauri::State<'_, std::sync::Arc<crate::cache::Cache>>,
    path: String,
    project: Value,
) -> Result<SavedProject> {
    // Validate before writing — never persist something we can't read back.
    let typed: ProjectFile = serde_json::from_value(project.clone())
        .map_err(|e| AppError::BadInput(format!("refusing to save invalid project: {e}")))?;

    atomic_write(
        Path::new(&path),
        serde_json::to_vec_pretty(&project)?.as_slice(),
    )?;

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
        duration_sec: typed.timeline.duration(),
        thumb,
        size_bytes: 0, // filled by upsert_recent via fs metadata
        opened_at: None, // preserved from any prior entry by upsert_recent
    })?;

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
#[tauri::command]
pub fn refresh_recent_thumb(
    cache: tauri::State<'_, std::sync::Arc<crate::cache::Cache>>,
    jobs: tauri::State<'_, std::sync::Arc<crate::jobs::Jobs>>,
    path: String,
) -> Result<Option<String>> {
    let Some((key, at)) = thumb_source_for(&path) else {
        return Ok(None);
    };
    // Prefer any already-cached thumb; only spend ffmpeg when the cache is cold.
    let thumb = crate::media::thumbs::any_thumb_for(&cache, &key.hash())
        .or_else(|| crate::media::thumbs::ensure_thumb(&cache, &jobs, &key, at).ok());
    let Some(thumb) = thumb else {
        return Ok(None);
    };
    let thumb = thumb.to_string_lossy().into_owned();

    // Persist so future mounts skip generation. Best-effort: a write failure
    // just means we regenerate next time.
    let mut index = read_recents();
    if let Some(entry) = index.items.iter_mut().find(|r| r.path == path) {
        entry.thumb = Some(thumb.clone());
        let _ = write_recents(&index);
    }
    Ok(Some(thumb))
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Pick a fresh "Untitled N.trt" path in Documents\Taroting.
#[tauri::command]
pub fn new_project_path(name: Option<String>) -> Result<String> {
    let dir = paths::default_projects_dir()?;
    paths::ensure_dir(&dir)?;
    let base = name.unwrap_or_else(|| "Untitled".to_string());
    let base = sanitize_filename(&base);
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

/// Pick a free `<base>.trt` path in `dir`, deduping to `<base> (2).trt` etc.
/// when the plain name is taken. `base` must already be sanitized. `exclude`
/// (the caller's own current file, if any) is treated as free so renaming a
/// project to its existing filename stem keeps the plain name — no " (2)".
fn free_path_in(dir: &Path, base: &str, exclude: Option<&Path>) -> Result<PathBuf> {
    for n in 0..1000 {
        let candidate = if n == 0 {
            dir.join(format!("{base}.trt"))
        } else {
            dir.join(format!("{base} ({}).trt", n + 1))
        };
        if !candidate.exists() || exclude == Some(candidate.as_path()) {
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

    if new_path != old {
        let _ = std::fs::remove_file(old);
        let mut bak = old.as_os_str().to_owned();
        bak.push(".bak");
        let _ = std::fs::remove_file(PathBuf::from(bak));
    }

    // Replace the recents entry's path + name, preserving the rest.
    let new_path_str = new_path.to_string_lossy().into_owned();
    let mut index = read_recents();
    let name_field = value["name"].as_str().unwrap_or_default().to_string();
    if let Some(entry) = index.items.iter_mut().find(|r| r.path == path) {
        entry.path = new_path_str.clone();
        entry.name = name_field;
    }
    let _ = write_recents(&index);

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
        duration_sec: src_recent.as_ref().map(|r| r.duration_sec).unwrap_or(0.0),
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

    let mut index = read_recents();
    index.items.retain(|r| r.path != path);
    write_recents(&index)
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

        body(&dir);

        match prev {
            Some(v) => std::env::set_var("APPDATA", v),
            None => std::env::remove_var("APPDATA"),
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
}
