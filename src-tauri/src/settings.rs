//! Settings persistence: %APPDATA%\Taroting\settings.json.
//! The TypeScript side owns defaults; Rust stores whatever it's given and
//! returns `null` when no settings file exists yet (frontend applies defaults).

use serde_json::Value;

use crate::error::Result;
use crate::paths;
use crate::project::store::atomic_write;

fn settings_path() -> Result<std::path::PathBuf> {
    Ok(paths::data_dir()?.join("settings.json"))
}

#[tauri::command]
pub fn get_settings() -> Result<Option<Value>> {
    let path = settings_path()?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn save_settings(settings: Value) -> Result<()> {
    let path = settings_path()?;
    let dir = paths::data_dir()?;
    paths::ensure_dir(&dir)?;
    atomic_write(&path, serde_json::to_vec_pretty(&settings)?.as_slice())
}
