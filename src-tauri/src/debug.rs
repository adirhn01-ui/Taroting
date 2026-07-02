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
