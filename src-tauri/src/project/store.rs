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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub modified_at: String,
    pub duration_sec: f64,
    pub thumb: Option<String>,
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

fn upsert_recent(item: RecentItem) -> Result<()> {
    let mut index = read_recents();
    index.items.retain(|r| r.path != item.path);
    index.items.insert(0, item);
    index.items.truncate(MAX_RECENTS);
    write_recents(&index)
}

#[tauri::command]
pub fn list_recents() -> Result<RecentsIndex> {
    let mut index = read_recents();
    // Drop entries whose project file vanished (moved/deleted by the user).
    index.items.retain(|r| Path::new(&r.path).is_file());
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

    // Verify media identity (path exists + size/mtime match).
    let mut missing = Vec::new();
    for m in &typed.media {
        let ok = std::fs::metadata(&m.path)
            .map(|meta| meta.len() == m.size)
            .unwrap_or(false);
        if !ok {
            missing.push(m.id.clone());
        }
    }

    Ok(LoadedProject {
        project: migrated,
        missing,
        recovered,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    pub modified_at: String,
}

#[tauri::command]
pub fn save_project(path: String, project: Value) -> Result<SavedProject> {
    // Validate before writing — never persist something we can't read back.
    let typed: ProjectFile = serde_json::from_value(project.clone())
        .map_err(|e| AppError::BadInput(format!("refusing to save invalid project: {e}")))?;

    atomic_write(
        Path::new(&path),
        serde_json::to_vec_pretty(&project)?.as_slice(),
    )?;

    upsert_recent(RecentItem {
        path: path.clone(),
        name: typed.name.clone(),
        modified_at: typed.modified_at.clone(),
        duration_sec: typed.timeline.duration(),
        thumb: None, // thumbnails arrive with the media pipeline milestone
    })?;

    Ok(SavedProject {
        modified_at: typed.modified_at,
    })
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
