//! Settings persistence: %APPDATA%\Taroting\settings.json.
//! The TypeScript side owns defaults; Rust stores whatever it's given and
//! returns `null` when no settings file exists yet (frontend applies defaults).

use serde_json::Value;

use crate::error::Result;
use crate::paths;
use crate::project::store::{atomic_write, read_json_with_bak};

fn settings_path() -> Result<std::path::PathBuf> {
    Ok(paths::data_dir()?.join("settings.json"))
}

/// The stored settings, or `None` when there are none to restore (first run, or
/// both copies unreadable) so the frontend applies its defaults.
///
/// A truncated/corrupt settings.json used to silently return `None` here — every
/// preference reset to defaults, and the next save then rotated the last GOOD
/// copy out of `settings.json.bak` for good. `atomic_write` has been keeping
/// that backup all along; now it is actually consulted.
#[tauri::command]
pub fn get_settings() -> Result<Option<Value>> {
    let path = settings_path()?;
    Ok(read_json_with_bak::<Value>(&path).0)
}

#[tauri::command]
pub fn save_settings(settings: Value) -> Result<()> {
    let path = settings_path()?;
    let dir = paths::data_dir()?;
    paths::ensure_dir(&dir)?;
    atomic_write(&path, serde_json::to_vec_pretty(&settings)?.as_slice())
}
