//! Dev-only support for the in-app autotest harness. Every command here is a
//! hard error in release builds — nothing debug-related ships.

use serde::Serialize;
use tauri::Emitter;

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

/// Hand `path` to the frontend exactly as a second launch from File Explorer
/// does — queue it, then wake the "open-path" listener — so the E2E drives the
/// real `routeOpenPath` with no second process and no window on screen.
///
/// `dev_only()` must stay the FIRST statement (a test below pins it): this is
/// a way to make the app open an arbitrary file, and a release build must
/// refuse it before touching anything.
#[tauri::command]
pub fn debug_push_open_path(
    app: tauri::AppHandle,
    queue: tauri::State<'_, crate::os::OpenPathQueue>,
    path: String,
) -> Result<()> {
    dev_only()?;
    if push_and_wake(&queue, &path) {
        let _ = app.emit("open-path", ());
    }
    Ok(())
}

/// Queue `path` through the real producer gate (`push_if_file`) and report
/// whether it was taken. A missing file or a directory is dropped silently, as
/// the single-instance path drops it, so there is nothing to wake anyone for.
///
/// `push_if_file` takes the queue lock itself, so "was it taken" is read as the
/// length growing across the call. The only thing that can blur that is a
/// drain landing in between, and the drain is what this event exists to
/// trigger; the E2E pushes one path and waits for it.
fn push_and_wake(queue: &crate::os::OpenPathQueue, path: &str) -> bool {
    let len = || queue.0.lock().map(|q| q.len()).unwrap_or(0);
    let before = len();
    queue.push_if_file(path);
    len() > before
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A release build must refuse before it queues anything. `cfg(test)` is a
    /// debug build, where `dev_only()` passes, so the refusal itself cannot be
    /// exercised here — instead pin the ORDER in the source: the gate is the
    /// first statement of the body, ahead of any queue or emit.
    #[test]
    fn debug_push_open_path_checks_dev_only_first() {
        let src = include_str!("debug.rs");
        let sig = src
            .find("pub fn debug_push_open_path(")
            .expect("the command exists");
        let body_open = sig + src[sig..].find(") -> Result<()> {").expect("signature");
        let body = &src[body_open + ") -> Result<()> {".len()..];
        let first = body
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .expect("a body");
        assert_eq!(first, "dev_only()?;", "the release gate must come first");
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("taroting-debug-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Three inputs, three different reasons: only the real file is queued and
    /// wakes the listener; the missing file and the directory are each dropped
    /// by `push_if_file`'s own gate and must not fire a wake-up for nothing.
    #[test]
    fn only_a_queued_file_wakes_the_listener() {
        let dir = scratch("push");
        let file = dir.join("clip 2 'b'.mp4");
        std::fs::write(&file, b"x").unwrap();
        let q = crate::os::OpenPathQueue::default();

        assert!(!push_and_wake(&q, dir.join("absent.mp4").to_str().unwrap()));
        assert!(!push_and_wake(&q, dir.to_str().unwrap()));
        assert!(q.0.lock().unwrap().is_empty());

        assert!(push_and_wake(&q, file.to_str().unwrap()));
        // A path already waiting does not mask the next one: the answer is
        // about THIS push, not about whether the queue is non-empty.
        assert!(!push_and_wake(&q, dir.to_str().unwrap()));
        assert_eq!(
            *q.0.lock().unwrap(),
            vec![file.to_str().unwrap().to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
