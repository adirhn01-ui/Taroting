//! Filesystem locations. Everything Taroting writes lives in exactly three
//! places: %APPDATA%\Taroting (settings, recents), %LOCALAPPDATA%\Taroting\cache
//! (regenerable proxies/waveforms/thumbnails), and user-chosen project/export
//! paths. Nothing else is ever touched.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::{AppError, Result};

fn env_dir(var: &str) -> Result<PathBuf> {
    dir_from_env(var, std::env::var_os(var))
}

/// The whole decision, split out from the environment read so it can be tested
/// without mutating process-global state.
///
/// An EMPTY value must fail exactly like a missing one, and is the more
/// dangerous of the two: `PathBuf::from("").join("Taroting")` is the RELATIVE
/// path `Taroting`, which resolves against the process CWD. For a launch from
/// Explorer's open-with that CWD is the folder holding the double-clicked file,
/// so settings, recents and the whole media cache would be created inside the
/// user's own directories — and a second launch from elsewhere would not find
/// them again.
fn dir_from_env(var: &str, value: Option<OsString>) -> Result<PathBuf> {
    value
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AppError::BadInput(format!("environment variable {var} is not set")))
}

/// %APPDATA%\Taroting — settings.json, recents.json
pub fn data_dir() -> Result<PathBuf> {
    Ok(env_dir("APPDATA")?.join("Taroting"))
}

/// %LOCALAPPDATA%\Taroting\cache — regenerable derived files
pub fn cache_dir() -> Result<PathBuf> {
    Ok(env_dir("LOCALAPPDATA")?.join("Taroting").join("cache"))
}

/// %LOCALAPPDATA%\Taroting\tmp-projects — scratch projects for the quick-view
/// (open-with) flow. Files here are never in recents and are wiped at startup;
/// pressing Back in the editor re-saves the project permanently to Documents.
pub fn temp_projects_dir() -> Result<PathBuf> {
    Ok(env_dir("LOCALAPPDATA")?
        .join("Taroting")
        .join("tmp-projects"))
}

/// Default folder for new projects: Documents\Taroting
pub fn default_projects_dir() -> Result<PathBuf> {
    Ok(env_dir("USERPROFILE")?.join("Documents").join("Taroting"))
}

pub fn ensure_dir(p: &PathBuf) -> Result<()> {
    std::fs::create_dir_all(p)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_set_variable_gives_an_absolute_base() {
        let dir = dir_from_env("APPDATA", Some(OsString::from(r"C:\Users\x\AppData\Roaming")))
            .expect("a real value must be accepted");
        assert!(dir.join("Taroting").is_absolute());
    }

    /// An empty value is rejected like a missing one. Without this the joined
    /// path is the RELATIVE "Taroting", i.e. app data written into whatever
    /// directory the process happens to have been started in.
    #[test]
    fn an_empty_variable_is_rejected_like_a_missing_one() {
        for value in [None, Some(OsString::new())] {
            let err = dir_from_env("APPDATA", value).expect_err("must not yield a path");
            assert!(
                matches!(&err, AppError::BadInput(m) if m.contains("APPDATA")),
                "unexpected error: {err}"
            );
        }
        // The failure that matters is the shape of what would have been built.
        assert!(!PathBuf::from("").join("Taroting").is_absolute());
    }
}
