//! A media file's neighbours in its own folder, in Explorer's natural name
//! order, for the viewer's previous/next. Bounded by a radius on each side so a
//! folder of thousands of photos never crosses the IPC boundary whole.
//!
//! SIGNATURE STUB: the command refuses until the implementation lands (a
//! `BadInput`, never a panic — release is `panic = "abort"`). The
//! `allow(dead_code)` belongs to the stub and goes with it.
#![allow(dead_code)]

/// Mirrors `SiblingWindow` in src/core/ipc.ts, field for field.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiblingWindow {
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub index: Option<u32>,
    pub total: u32,
    pub family: crate::media::extensions::StepFamily,
}

/// `radius` clamped to 1..=32. async + spawn_blocking.
#[tauri::command]
pub async fn list_siblings(path: String, radius: u32) -> crate::error::Result<SiblingWindow> {
    let _ = (path, radius);
    Err(crate::error::AppError::BadInput("not implemented".into()))
}
