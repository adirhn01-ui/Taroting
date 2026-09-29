//! OS integration: first-launch file-open capture and the app-triggered
//! uninstall entry. All zero-cost when unused; no new crates.

use std::ffi::OsStr;
use std::path::Path;
use std::sync::Mutex;

use crate::error::{AppError, Result};

/// Keep a spawned child from allocating a console window. A release build is
/// `windows_subsystem = "windows"`, so it owns no console for a console-mode
/// child to inherit and Windows would hand that child a fresh, visible one.
/// Ignored for GUI-subsystem processes, which is why the uninstaller's wizard
/// still appears. Same constant and idiom as `jobs::ffmpeg::command`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Server-side queue of file paths waiting to be opened by the frontend.
///
/// Two producers push here: the first-launch argv capture (`capture_launch_arg`)
/// and the single-instance callback (a second launch forwarding a path). The
/// frontend is the sole consumer and DRAINS the queue atomically via
/// [`take_pending_open_paths`], so every path is delivered to exactly one caller
/// no matter how the boot-window race between the "open-path" wake-up event and
/// the startup drain resolves. `Mutex<Vec<_>>` (not `Arc<Mutex<_>>`) is enough:
/// Tauri manages the value and hands out `State<'_, OpenPathQueue>` refs.
#[derive(Default)]
pub struct OpenPathQueue(pub Mutex<Vec<String>>);

impl OpenPathQueue {
    /// Push a path onto the queue if it points at an existing file. Called by
    /// producers; silently ignores non-files and poisoned locks.
    pub fn push_if_file(&self, path: &str) {
        self.push_os_if_file(OsStr::new(path));
    }

    /// `push_if_file` for a path that has NOT been through UTF-8 validation —
    /// the launch argv, which on Windows is whatever UTF-16 the shell handed us.
    ///
    /// Existence is tested on the OS string itself, so a name Windows can store
    /// but Rust cannot decode is never mistaken for some other file. Only a
    /// losslessly-decodable path is queued: the queue leaves this process as
    /// JSON and comes back as a path to load, and a lossy U+FFFD would name a
    /// file that does not exist. Dropping such a path costs the user one
    /// double-click that does nothing; queueing a mangled one costs them a
    /// "project not found" they cannot explain.
    fn push_os_if_file(&self, path: &OsStr) {
        if !Path::new(path).is_file() {
            return;
        }
        let Some(path) = path.to_str() else { return };
        if let Ok(mut q) = self.0.lock() {
            q.push(path.to_string());
        }
    }
}

/// Called from `main()` before the frontend boots. Records argv[1] into the
/// open-path queue iff it is an existing file. Second-instance launches are
/// handled by the single-instance plugin's callback, which pushes into the same
/// queue.
///
/// `args_os`, never `args`: `std::env::args()` is documented to PANIC on an
/// argument that is not valid Unicode. This runs before any window exists,
/// under `panic = "abort"` — so a double-clicked file whose name the shell
/// passes as undecodable UTF-16 would kill the process outright, with nothing
/// on screen to explain it.
pub fn capture_launch_arg(queue: &OpenPathQueue) {
    if let Some(arg) = std::env::args_os().nth(1) {
        queue.push_os_if_file(&arg);
    }
}

/// Atomically drain every queued open-path. The frontend calls this once at
/// startup (right after attaching its "open-path" listener) and again on each
/// "open-path" wake-up event. Because the drain empties the queue under the
/// lock, each path is returned to exactly one caller — no double-opening.
#[tauri::command]
pub fn take_pending_open_paths(
    queue: tauri::State<'_, OpenPathQueue>,
) -> Vec<String> {
    match queue.0.lock() {
        Ok(mut q) => std::mem::take(&mut *q),
        Err(_) => Vec::new(),
    }
}

/// Uninstall Taroting: run the NSIS uninstaller that the installer wrote beside
/// our exe, then exit so it can delete the directory we are running from.
///
/// **Never add `/S`.** The uninstaller is interactive BY DESIGN. The app-data
/// purge in `windows/hooks.nsh` is gated on `$DeleteAppDataCheckboxState` — the
/// "Delete the application data" tick on the uninstaller's confirm page — which
/// a silent or passive run leaves unset. Passing `/S` would quietly turn this
/// button into "uninstall but always keep settings and caches", with no way
/// left to ask. The installer writes no `QuietUninstallString` for the same
/// reason; there is nothing quiet to run.
#[tauri::command]
pub async fn uninstall_app() -> Result<()> {
    tauri::async_runtime::spawn_blocking(run_uninstaller)
        .await
        .map_err(|e| AppError::BadInput(format!("uninstall task failed: {e}")))?
}

/// Spawn `uninstall.exe` from our own directory and exit.
///
/// `$INSTDIR\uninstall.exe` is both checks at once: it exists only in an
/// installed copy (a portable unzip has no uninstaller, hence "not installed"),
/// and it belongs to whichever install produced the exe we are running — a
/// stronger identity proof than a registry `DisplayName`, which any other
/// program can write. Nothing is read out of the registry any more: `reg query`
/// flashed a console window per call, its stdout is OEM-codepage bytes that
/// `from_utf8_lossy` mangles for a non-ASCII account name, and the value came
/// back out through `cmd /C start` as a shell string, where `%VAR%` expands
/// even inside quotes. Spawning the path directly is args-as-arrays, like every
/// other process this app starts.
///
/// Runs on the blocking pool, off the webview's thread, because of the sleep.
fn run_uninstaller() -> Result<()> {
    let exe = std::env::current_exe()?;
    let uninstaller = exe
        .parent()
        .map(|dir| dir.join("uninstall.exe"))
        .filter(|p| p.is_file())
        .ok_or_else(|| AppError::BadInput("not installed".into()))?;

    let mut cmd = std::process::Command::new(&uninstaller);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(AppError::Io)?;

    // uninstall.exe self-copies to %TEMP% and re-execs from there before it can
    // delete $INSTDIR; give it that beat before we let go of our own exe.
    // exit(0) skips Drop but we hold no external resources needing it, and the
    // spawned child is not ours to reap — it outlives us on purpose.
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

/* ------------------------------------------------------------------ */
/* Close escape hatch                                                  */
/* ------------------------------------------------------------------ */

/// A JS close listener makes Tauri swallow the native close, so a hung or
/// crashed renderer would leave X doing nothing, forever. This remembers the
/// first close request the webview has not acknowledged (`close_ack`).
///
/// One timestamp, not a counter: the only question is "has the webview been
/// silent for 5 s since the user FIRST asked to close". A live webview acks
/// every request within milliseconds (before it shows any Keep prompt), so a
/// user clicking X again while that prompt is up is never force-closed.
///
/// The ack cannot overtake the record it answers. Tauri's `attach_window`
/// (tauri 2.11.5 `manager/window.rs` L99-103) emits `tauri://close-requested`
/// and then runs the app's `on_window_event` listeners synchronously inside the
/// same event-loop callback. On Windows every webview→host message (IPC
/// protocol request or postMessage) arrives as a WebView2 event on the UI
/// thread, which is still inside this close callback when the stamp is
/// written — so the ack cannot precede the stamp, whichever thread later runs
/// the command.
#[derive(Default)]
pub struct CloseWatch {
    first_unacked: Mutex<Option<std::time::Instant>>,
}

impl CloseWatch {
    /// Record a close request at `now`; `true` means "destroy the window".
    /// A force clears the stamp; an empty slot takes `now`; a pending request
    /// younger than [`FORCE_CLOSE_AFTER`] is LEFT ALONE — refreshing it would
    /// let a user clicking X every second postpone the escape hatch forever.
    ///
    /// Poison-tolerant: a poisoned lock still holds a valid `Option<Instant>`,
    /// and `unwrap()` here would abort the process from inside a window event.
    fn note_request(&self, now: std::time::Instant) -> bool {
        let mut slot = self.first_unacked.lock().unwrap_or_else(|e| e.into_inner());
        if should_force_close(*slot, now) {
            *slot = None;
            return true;
        }
        if slot.is_none() {
            *slot = Some(now);
        }
        false
    }

    /// The webview answered: nothing is pending any more.
    fn ack(&self) {
        *self.first_unacked.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Force-destroy when a close request arrives this long after an earlier one
/// the webview never acknowledged.
pub const FORCE_CLOSE_AFTER: std::time::Duration = std::time::Duration::from_secs(5);

/// Pure decision: force-destroy when a close request arrives ≥
/// [`FORCE_CLOSE_AFTER`] after an earlier one the webview never acknowledged.
///
/// `saturating_duration_since`, not `now - t`: `Instant` subtraction's
/// non-panicking behaviour on a backwards pair is documented only as
/// "currently", and release is `panic = "abort"`. A stamp from the future
/// reads as zero elapsed — never a force.
pub fn should_force_close(
    first_unacked: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    match first_unacked {
        Some(t) => now.saturating_duration_since(t) >= FORCE_CLOSE_AFTER,
        None => false,
    }
}

/// Pure decision for one close request on window `label` at `now`.
///
/// Only "main" is watched: the stamp is one window's state, and a close on any
/// other window must neither start its clock nor be destroyed by it — so the
/// label check short-circuits BEFORE `note_request` can write a stamp.
fn should_destroy(label: &str, watch: &CloseWatch, now: std::time::Instant) -> bool {
    label == "main" && watch.note_request(now)
}

/// Called from main.rs `.on_window_event` for `WindowEvent::CloseRequested`.
///
/// The decision lives in [`should_destroy`] so it is testable without a
/// window; only the `destroy()` call itself is left to the manual check.
/// `destroy()` posts `WindowMessage::Destroy` through the event-loop proxy
/// (tauri-runtime-wry `destroy`), so calling it from inside this handler does
/// not re-enter the loop. Its error is ignored: there is nothing further to try
/// from here, and the next X starts a fresh 5 s clock.
pub fn on_close_requested<R: tauri::Runtime>(window: &tauri::Window<R>, watch: &CloseWatch) {
    if should_destroy(window.label(), watch, std::time::Instant::now()) {
        let _ = window.destroy();
    }
}

/// The webview answered: clear the pending timestamp.
#[tauri::command]
pub fn close_ack(watch: tauri::State<'_, CloseWatch>) {
    watch.ack();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file whose name the shell can hand us but Rust cannot decode: an
    /// unpaired UTF-16 surrogate. `OsString` carries it losslessly (WTF-8),
    /// `to_str()` refuses it, and `to_string_lossy()` would rewrite it to
    /// U+FFFD — a different, non-existent file.
    #[cfg(windows)]
    fn undecodable_name(stem: &str) -> std::ffi::OsString {
        use std::os::windows::ffi::OsStringExt;
        let mut units: Vec<u16> = stem.encode_utf16().collect();
        units.push(0xD800);
        std::ffi::OsString::from_wide(&units)
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("taroting-os-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn queues_only_existing_files() {
        let dir = temp_dir("queue");
        let file = dir.join("real.trt");
        std::fs::write(&file, b"{}").unwrap();

        let q = OpenPathQueue::default();
        q.push_if_file(dir.join("missing.trt").to_str().unwrap());
        // A directory is not a file, and opening one would be nonsense.
        q.push_if_file(dir.to_str().unwrap());
        q.push_if_file(file.to_str().unwrap());

        let queued = std::mem::take(&mut *q.0.lock().unwrap());
        assert_eq!(queued, vec![file.to_str().unwrap().to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The undecodable path EXISTS, so the `is_file` gate passes and the only
    /// thing that can reject it is the UTF-8 check. Swap `to_str()` for a lossy
    /// conversion and this queues a U+FFFD path that no `load_project` will
    /// ever find.
    #[cfg(windows)]
    #[test]
    fn skips_an_existing_file_whose_name_is_not_utf8() {
        let dir = temp_dir("wtf8");
        let name = undecodable_name("weird");
        let mut path = dir.clone().into_os_string();
        path.push(std::path::MAIN_SEPARATOR_STR);
        path.push(&name);

        std::fs::write(&path, b"{}").expect("NTFS stores unpaired surrogates");
        assert!(Path::new(&path).is_file(), "fixture must exist on disk");
        assert!(path.to_str().is_none(), "fixture must not be valid UTF-8");

        let q = OpenPathQueue::default();
        q.push_os_if_file(&path);
        assert!(
            q.0.lock().unwrap().is_empty(),
            "an undecodable path must be dropped, never lossily rewritten"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- close escape hatch ---- */

    use std::time::{Duration, Instant};

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// The boundary rows straddle 5 s by 100 ms so `>=` vs `>` and an off-by-
    /// one-second constant each flip exactly one row. The future-stamp row pins
    /// the saturating subtraction: a clock pair that runs backwards must read
    /// as "not yet", never as a panic or a force.
    #[test]
    fn should_force_close_table() {
        let t0 = Instant::now();
        let rows: [(Option<Instant>, Instant, bool, &str); 5] = [
            (None, t0 + ms(60_000), false, "nothing pending"),
            (Some(t0), t0 + ms(4_900), false, "4.9 s is still patient"),
            (Some(t0), t0 + ms(5_000), true, "exactly 5.0 s forces"),
            (Some(t0), t0 + ms(60_000), true, "60 s forces"),
            (Some(t0 + ms(1_000)), t0, false, "a stamp in the future"),
        ];
        for (first, now, want, why) in rows {
            assert_eq!(should_force_close(first, now), want, "{why}");
        }
    }

    /// Distinguishes "leave the pending stamp alone" from "overwrite it with
    /// now": an overwrite would make the third request see 100 ms and wait.
    #[test]
    fn pending_request_is_not_refreshed_by_a_younger_one() {
        let w = CloseWatch::default();
        let t0 = Instant::now();
        assert!(!w.note_request(t0), "the first request only starts the clock");
        assert!(!w.note_request(t0 + ms(4_900)), "4.9 s after the first");
        assert!(w.note_request(t0 + ms(5_000)), "5.0 s after the FIRST forces");
    }

    /// After a force the slot is empty again, so the very next request starts
    /// a new clock instead of forcing on a stale stamp.
    #[test]
    fn force_clears_so_the_next_request_starts_fresh() {
        let w = CloseWatch::default();
        let t0 = Instant::now();
        assert!(!w.note_request(t0));
        assert!(w.note_request(t0 + ms(7_000)));
        assert!(!w.note_request(t0 + ms(7_001)), "a fresh first request");
        assert_eq!(*w.first_unacked.lock().unwrap(), Some(t0 + ms(7_001)));
    }

    /// The label gate, row by row on a fresh watch each: "main" starts the
    /// clock and forces at 5 s; any other label never stamps (slot stays
    /// `None`) and so never forces, however late the second request is.
    #[test]
    fn should_destroy_only_watches_main() {
        let t0 = Instant::now();

        let main = CloseWatch::default();
        assert!(!should_destroy("main", &main, t0), "main: first request waits");
        assert_eq!(*main.first_unacked.lock().unwrap(), Some(t0), "main stamps");
        assert!(should_destroy("main", &main, t0 + ms(5_000)), "main forces at 5 s");

        let other = CloseWatch::default();
        assert!(!should_destroy("other", &other, t0), "other: no force");
        assert_eq!(*other.first_unacked.lock().unwrap(), None, "other never stamps");
        assert!(!should_destroy("other", &other, t0 + ms(60_000)), "other: never forces");
        assert_eq!(*other.first_unacked.lock().unwrap(), None, "still no stamp");
    }

    /// A live webview acks every request, so a request long after an acked one
    /// is a fresh first request, never a force.
    #[test]
    fn ack_clears_the_pending_request() {
        let w = CloseWatch::default();
        let t0 = Instant::now();
        assert!(!w.note_request(t0));
        w.ack();
        assert_eq!(*w.first_unacked.lock().unwrap(), None);
        assert!(!w.note_request(t0 + ms(60_000)), "acked, so 60 s later is new");
    }

    /// A panic while the lock was held must not turn the escape hatch itself
    /// into a crash (release aborts on panic). The poisoned slot still carries
    /// the stamp written before the panic, and the clock keeps working on it.
    #[test]
    fn poisoned_lock_does_not_panic() {
        let w = std::sync::Arc::new(CloseWatch::default());
        let t0 = Instant::now();
        let w2 = w.clone();
        let _ = std::thread::spawn(move || {
            let mut slot = w2.first_unacked.lock().unwrap();
            *slot = Some(t0);
            panic!("poison the close watch");
        })
        .join();
        assert!(w.first_unacked.is_poisoned(), "fixture must be poisoned");

        assert!(!w.note_request(t0 + ms(3_000)), "stamp kept, 3 s is patient");
        assert!(w.note_request(t0 + ms(5_500)), "and 5.5 s still forces");
        assert!(!w.note_request(t0 + ms(5_600)));
        w.ack();
        assert!(!w.note_request(t0 + ms(20_000)), "ack worked through poison");
    }
}
