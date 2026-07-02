//! Filesystem locations. Everything Taroting writes lives in exactly three
//! places: %APPDATA%\Taroting (settings, recents), %LOCALAPPDATA%\Taroting\cache
//! (regenerable proxies/waveforms/thumbnails), and user-chosen project/export
//! paths. Nothing else is ever touched.

use std::path::PathBuf;

use crate::error::{AppError, Result};

fn env_dir(var: &str) -> Result<PathBuf> {
    std::env::var_os(var)
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

/// Default folder for new projects: Documents\Taroting
pub fn default_projects_dir() -> Result<PathBuf> {
    Ok(env_dir("USERPROFILE")?.join("Documents").join("Taroting"))
}

pub fn ensure_dir(p: &PathBuf) -> Result<()> {
    std::fs::create_dir_all(p)?;
    Ok(())
}
