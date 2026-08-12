//! Settings persistence: %APPDATA%\Taroting\settings.json.
//! The TypeScript side owns defaults; Rust stores whatever it's given and
//! reports WHICH of the three read outcomes occurred, so the frontend can tell
//! "nothing saved yet" from "something is saved and we could not read it".

use serde::Serialize;
use serde_json::Value;

use crate::error::Result;
use crate::paths;
use crate::project::store::{atomic_write, read_json_status, JsonRead};

fn settings_path() -> Result<std::path::PathBuf> {
    Ok(paths::data_dir()?.join("settings.json"))
}

/// How a settings read went. Serialized as `"ok" | "absent" | "unreadable"`.
///
/// `Absent` and `Unreadable` are the two that MUST NOT be conflated, and they
/// were: both arrived at the frontend as a bare `null`. A settings.json that
/// exists but cannot be read — the classic cause is a Windows file lock from an
/// AV scanner, a backup agent or a roaming profile mid-sync, which makes
/// `std::fs::read` fail on a perfectly intact file — therefore looked exactly
/// like a first run. Nothing was surfaced, the frontend's overwrite guard
/// marked itself verified, and the next `updateSettings` wrote
/// `{ ...DEFAULTS, ...patch }` straight over the user's real preferences. The
/// save after that rotated the last good `.bak` away too.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SettingsStatus {
    /// Settings were read; `settings` holds them.
    Ok,
    /// Neither settings.json nor its `.bak` is on disk — a clean first run.
    /// There is nothing to lose, so a caller may freely write defaults.
    Absent,
    /// A copy EXISTS but nothing could be parsed out of it. Refuse to write:
    /// `atomic_write` would rotate the last good copy into `.bak` and the fresh
    /// primary would then parse fine, hiding that backup forever.
    Unreadable,
}

/// The result of `get_settings`: the outcome, plus the value when there is one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRead {
    pub status: SettingsStatus,
    /// The stored settings — `Some` exactly when `status` is `Ok`, `None`
    /// otherwise. The frontend still owns the defaults it merges onto.
    pub settings: Option<Value>,
    /// True when the `.bak` supplied the value because the primary was corrupt.
    /// The settings ARE intact; the file they came from was not.
    pub recovered: bool,
}

impl SettingsRead {
    fn empty(status: SettingsStatus) -> Self {
        SettingsRead {
            status,
            settings: None,
            recovered: false,
        }
    }
}

/// Read the stored settings and say which of the three outcomes occurred.
///
/// A truncated/corrupt settings.json used to silently return "no settings" —
/// every preference reset to defaults, and the next save then rotated the last
/// GOOD copy out of `settings.json.bak` for good. `atomic_write` has been
/// keeping that backup all along; now it is consulted, AND the case where even
/// it cannot be read is reported as its own state instead of being flattened
/// into the same answer as "you have never saved anything".
#[tauri::command]
pub fn get_settings() -> Result<SettingsRead> {
    // No data dir means we could not even look, which is not the same as
    // looking and finding nothing — report it as unreadable so a caller stays
    // off the write path, exactly as `read_recents_checked` does.
    let Ok(path) = settings_path() else {
        return Ok(SettingsRead::empty(SettingsStatus::Unreadable));
    };
    Ok(match read_json_status::<Value>(&path) {
        JsonRead::Parsed { value, recovered } => SettingsRead {
            status: SettingsStatus::Ok,
            settings: Some(value),
            recovered,
        },
        JsonRead::Absent => SettingsRead::empty(SettingsStatus::Absent),
        JsonRead::Unreadable => SettingsRead::empty(SettingsStatus::Unreadable),
    })
}

#[tauri::command]
pub fn save_settings(settings: Value) -> Result<()> {
    let path = settings_path()?;
    let dir = paths::data_dir()?;
    paths::ensure_dir(&dir)?;
    atomic_write(&path, serde_json::to_vec_pretty(&settings)?.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape the frontend switches on. These three discriminant
    /// strings are a contract with `ipc.ts`: a rename here would leave the
    /// frontend with an unrecognised status, and "unrecognised" is precisely
    /// the case that must never quietly become "first run" again. The
    /// behavioural tests live next to the recents ones in `project::store`,
    /// where APPDATA is isolated under a lock; this one is pure serialization.
    #[test]
    fn settings_read_serializes_to_a_tagged_shape() {
        let ok = SettingsRead {
            status: SettingsStatus::Ok,
            settings: Some(serde_json::json!({ "theme": "dark" })),
            recovered: true,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({
                "status": "ok",
                "settings": { "theme": "dark" },
                "recovered": true,
            })
        );

        // The two empty states differ ONLY in the tag, which is the whole point
        // of the change: `settings: null` no longer says which one happened.
        for (status, tag) in [
            (SettingsStatus::Absent, "absent"),
            (SettingsStatus::Unreadable, "unreadable"),
        ] {
            assert_eq!(
                serde_json::to_value(SettingsRead::empty(status)).unwrap(),
                serde_json::json!({ "status": tag, "settings": null, "recovered": false }),
            );
        }
    }
}
