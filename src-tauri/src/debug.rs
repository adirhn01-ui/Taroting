//! Dev-only support for the in-app autotest harness. Every command here is a
//! hard error in release builds — nothing debug-related ships.

use serde::Serialize;

use crate::error::{AppError, Result};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    pub autotest: bool,
    pub fixtures_dir: String,
    pub report_path: String,
}

fn dev_only() -> Result<()> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(AppError::BadInput("debug commands are disabled in release builds".into()))
    }
}

/// True when this process was launched to run the in-app E2E suite. Pinned to a
/// debug build as well as the environment variable, so a shipped Taroting can
/// never take any autotest path, whatever the environment says.
pub fn autotest_mode() -> bool {
    cfg!(debug_assertions) && std::env::var("TAROTING_AUTOTEST").is_ok_and(|v| v == "1")
}

/// Autotest only: the private scratch root that every OWNER-data location is
/// redirected into (see `paths.rs`), so an E2E run can never write into the
/// owner's settings, recents, projects or temporary projects — it used to leave
/// an "Autotest N.trt" in their Documents\Taroting on every run. Wiped when an
/// autotest primary instance starts, so each run begins from factory defaults.
pub fn autotest_root() -> std::path::PathBuf {
    std::env::temp_dir().join("taroting-autotest")
}

pub fn report_path() -> std::path::PathBuf {
    std::env::temp_dir().join("taroting-autotest-report.json")
}

#[tauri::command]
pub fn debug_info() -> Result<DebugInfo> {
    dev_only()?;
    let fixtures = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("tests").join("fixtures"))
        .unwrap_or_default();
    Ok(DebugInfo {
        autotest: std::env::var("TAROTING_AUTOTEST").is_ok_and(|v| v == "1"),
        fixtures_dir: fixtures.to_string_lossy().into_owned(),
        report_path: report_path().to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn debug_write_report(content: String) -> Result<()> {
    dev_only()?;
    std::fs::write(report_path(), content)?;
    Ok(())
}
