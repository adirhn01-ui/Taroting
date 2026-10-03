//! OS integration: first-launch file-open capture and the app-triggered
//! uninstall entry. All zero-cost when unused; no new crates.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
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

/// Called from `main()` before the frontend boots. Records the launch's file
/// argument into the open-path queue. Second-instance launches are handled by
/// the single-instance plugin's callback, which pushes into the same queue.
///
/// `args_os`, never `args`: `std::env::args()` is documented to PANIC on an
/// argument that is not valid Unicode. This runs before any window exists,
/// under `panic = "abort"` — so a double-clicked file whose name the shell
/// passes as undecodable UTF-16 would kill the process outright, with nothing
/// on screen to explain it.
///
/// A SECOND launch never gets here: `forward_to_running` hands it over first,
/// on the same `args_os` rule (`forward_payload`). The single-instance plugin's
/// own forward still calls `std::env::args()` and would abort on such a name,
/// but it now runs only for a launch that slips into the milliseconds between
/// that pre-check and the plugin's own check — and that abort is the second
/// launch's alone; the running app never sees it.
///
/// Not for a process that crash.rs restarted after the display engine died
/// (`engine_restart`): that restart runs with THIS session's original command
/// line, so a session begun by double-clicking a clip would open that clip
/// again — the viewer, or a fresh temporary project — instead of Home, where
/// the work that was open is offered back.
pub fn capture_launch_arg(queue: &OpenPathQueue, engine_restart: bool) {
    if let Some(arg) = launch_file_arg(std::env::args_os(), engine_restart) {
        queue.push_os_if_file(&arg);
    }
}

/// `capture_launch_arg`'s decision, on an argv it is handed.
fn launch_file_arg(args: impl Iterator<Item = OsString>, engine_restart: bool) -> Option<OsString> {
    if engine_restart {
        return None;
    }
    first_file_arg(args)
}

/// The environment variable crash.rs sets on itself just before it restarts
/// the app after a dead engine. The restarted process inherits it (a spawned
/// process gets its parent's environment) and is the only one that ever has
/// it: `take_engine_restart_marker` removes it at once.
pub const ENGINE_RESTART_ENV: &str = "TAROTING_ENGINE_RESTART";

/// Whether this process is crash.rs's restart, removing the marker so no
/// process this one starts (ffmpeg, a later restart) inherits it. Called once,
/// first thing in `main()`'s launch handling, while only one thread runs.
pub fn take_engine_restart_marker() -> bool {
    let restarted = std::env::var_os(ENGINE_RESTART_ENV).is_some();
    if restarted {
        std::env::remove_var(ENGINE_RESTART_ENV);
    }
    restarted
}

/// The first argument after argv[0] that is an existing, losslessly-decodable
/// file — the single-instance callback's `skip(1)` + `is_file` rule, so a
/// first launch and a forwarded second launch pick the same file out of the
/// same command line, plus the queue's own decodability gate (the callback's
/// argv arrives already decoded, so it has nothing to pass over).
///
/// Not `nth(1)`: a shell verb written with an UNQUOTED exe path
/// (`C:\Users\John Smith\…\taroting.exe "%1"`) is split at the space by the
/// argv parser, the exe's own tail lands in argv[1], and the file in argv[2].
/// `nth(1)` then tested the tail, found no file, and a double-clicked `.trt`
/// opened Home instead of the project on every profile path with a space.
///
/// An undecodable name is passed over HERE rather than dropped by the queue:
/// the queue would refuse it anyway (see `push_os_if_file`), and stopping at it
/// would lose a decodable file further along the same command line.
///
/// Returned ABSOLUTE (`launch_path_in`): a command-line launch can name a file
/// relative to its working directory, and the queued path leaves this process
/// for a frontend where nothing resolves it — the viewer's folder listing
/// refuses a relative path, and a temporary project would store one.
pub fn first_file_arg(args: impl Iterator<Item = OsString>) -> Option<OsString> {
    let cwd = std::env::current_dir().unwrap_or_default();
    first_file_arg_in(args, &cwd)
}

/// `first_file_arg` against an explicit working directory, so the tests never
/// have to move the process's own.
fn first_file_arg_in(args: impl Iterator<Item = OsString>, cwd: &Path) -> Option<OsString> {
    args.skip(1)
        .filter_map(|a| launch_path_in(cwd, &a))
        .find(|p| p.to_str().is_some() && p.is_file())
        .map(PathBuf::into_os_string)
}

/// The file a forwarded SECOND launch names: `first_file_arg`'s rule against
/// the working directory of the launch that sent it (the single-instance
/// callback's `cwd`), never this process's — a relative name tested here
/// found nothing, or a same-named file in the wrong folder. Absolute, like
/// every queued path.
pub fn forwarded_file_arg(argv: &[String], cwd: &str) -> Option<String> {
    let cwd = Path::new(cwd);
    argv.iter()
        .skip(1)
        .filter_map(|a| launch_path_in(cwd, OsStr::new(a)))
        .find(|p| p.is_file())
        .and_then(|p| p.to_str().map(str::to_owned))
}

/// `arg` as an absolute path, a relative one taken against `cwd` (an absolute
/// `arg` replaces `cwd` whole). `std::path::absolute`, never `canonicalize`:
/// the latter answers with a `\\?\` verbatim path, which the viewer's folder
/// listing refuses as surely as a relative one, and it touches the disk.
fn launch_path_in(cwd: &Path, arg: &OsStr) -> Option<PathBuf> {
    std::path::absolute(cwd.join(arg)).ok()
}

/// Whether the FIRST queued path is a file the frontend opens on its own —
/// media (the shared extension table) or a `.trt` project. It decides one
/// thing: whether the webview boots straight into that file instead of
/// mounting Home first (`window.__tarotingLaunchFile`, main.rs).
///
/// PEEKS, never drains: the frontend's `take_pending_open_paths` is still the
/// queue's only consumer. An empty queue (every plain launch) answers before
/// any lookup, and `.trt` is checked before the media table, so neither pays
/// for the table's one-time parse. A poisoned lock answers `false`: no hint is
/// simply today's boot, Home first.
pub fn queued_known_launch(queue: &OpenPathQueue) -> bool {
    let Ok(q) = queue.0.lock() else { return false };
    let Some(first) = q.first() else { return false };
    let ext = file_ext(first);
    ext.eq_ignore_ascii_case("trt") || crate::media::extensions::family_of_ext(ext).is_some()
}

/// The frontend's `fileExt` (src/core/format.ts): the text after the LAST dot
/// of the last path segment, `/` or `\`. Not `Path::extension`, which reads a
/// bare `.trt` as a stem with no extension — the two sides would then disagree
/// about a file the frontend routes as a project. Case is left to the caller.
fn file_ext(path: &str) -> &str {
    let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
    name.rfind('.').map_or("", |i| &name[i + 1..])
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
pub async fn uninstall_app(app: tauri::AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || run_uninstaller(&app))
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
fn run_uninstaller(app: &tauri::AppHandle) -> Result<()> {
    use tauri::Manager;
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

    // `exit(0)` below skips every destructor and the run loop's Exit event, so
    // the cache index's coalesced last-use stamps are written HERE or never.
    // Before the beat, so the write is done well before the wizard can reach
    // the "delete the application data" step. A disabled cache is not managed.
    if let Some(cache) = app.try_state::<std::sync::Arc<crate::cache::Cache>>() {
        cache.flush();
    }
    // An orderly exit too, for the same reason: the next launch must not
    // report it as one that ended without a word (crash.rs).
    crate::crash::disarm_exit_watch();

    // uninstall.exe self-copies to %TEMP% and re-execs from there before it can
    // delete $INSTDIR; give it that beat before we let go of our own exe. The
    // spawned child is not ours to reap — it outlives us on purpose.
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

/* ------------------------------------------------------------------ */
/* Second launches                                                     */
/* ------------------------------------------------------------------ */

/// The bundle identifier `tauri.conf.json` declares. tauri-plugin-single-instance
/// (2.4.3, its `semver` feature off) names its mutex, its hidden event window's
/// class and that window's title after it: `<id>-sim`, `<id>-sic`, `<id>-siw`.
/// The forwarding below must use exactly those names, so a test pins this
/// constant against the config file and the plugin's feature list.
pub const APP_IDENTIFIER: &str = "com.taroting.app";

/// `dwData` of the plugin's WM_COPYDATA. Its window procedure ignores any
/// other tag, so a payload sent under a different one is silently dropped.
#[cfg_attr(not(windows), allow(dead_code))]
const FORWARD_TAG: usize = 1542;

/// How long a second launch waits for the running instance's event window
/// when the instance's mutex already exists. The plugin creates the mutex and
/// then the window a few calls later, so a launch landing between the two used
/// to find "an instance, but no window" and start a second full instance (its
/// setup sweep could delete the first one's live quick-view files).
pub const WINDOW_WAIT: std::time::Duration = std::time::Duration::from_millis(250);

/// How long a second launch waits for the running instance to take its
/// message. WM_COPYDATA is handled only when the instance's UI thread pumps,
/// so during a busy spell the launch has to wait — the file is delivered once
/// the thread is free. The plugin's own `SendMessageW` waited FOREVER: an
/// instance that never got free again collected one hung process per
/// double-click, for good. This bound ends them.
///
/// Long on purpose. A send that times out is WITHDRAWN, not left queued
/// (measured: `a_busy_instance_gets_the_file_once_it_is_free`), so a short
/// limit would drop the file of every double-click made during an ordinary
/// few-second busy spell. Repeats of one double-click that all land when the
/// thread frees up are folded into one open by [`RecentForward`].
pub const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// What became of an attempt to hand this launch to a running instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Forward {
    /// No other instance to hand over to: this process runs as the app.
    Stay,
    /// The running instance took the message.
    Delivered,
    /// The running instance is alive but did not take the message within
    /// [`SEND_TIMEOUT`]; the message was withdrawn. The launch still ends:
    /// a second full instance beside a wedged one would be worse than one
    /// double-click that did nothing.
    Unanswered,
    /// The instance's window went away while we waited: it is closing. This
    /// process runs as the app instead of handing its file to a dying one.
    Gone,
}

impl Forward {
    /// True when the process should end here: the launch was handed over,
    /// or the instance is alive but would not take it.
    pub fn ends_launch(self) -> bool {
        matches!(self, Forward::Delivered | Forward::Unanswered)
    }
}

/// The plugin's three object names for one identifier, as NUL-terminated
/// UTF-16. A parameter rather than constants so the tests run against names
/// of their own and never touch a Taroting the owner has open.
pub struct InstanceNames {
    #[cfg_attr(not(windows), allow(dead_code))]
    mutex: Vec<u16>,
    #[cfg_attr(not(windows), allow(dead_code))]
    class: Vec<u16>,
    #[cfg_attr(not(windows), allow(dead_code))]
    window: Vec<u16>,
}

impl InstanceNames {
    pub fn of(id: &str) -> Self {
        let wide = |suffix: &str| -> Vec<u16> {
            format!("{id}-{suffix}").encode_utf16().chain(std::iter::once(0)).collect()
        };
        InstanceNames { mutex: wide("sim"), class: wide("sic"), window: wide("siw") }
    }
}

/// The message a second launch sends: the plugin's own wire format,
/// `"{cwd}|{argv0}|{file}\0"` as UTF-8, which its window procedure reads back
/// with a lossy `CStr` conversion and a split on `|` (no Windows path can
/// contain one). The running instance's callback then picks the file with
/// [`forwarded_file_arg`].
///
/// Built from `args_os`, never `args`. The plugin's own forward calls
/// `std::env::args()`, which PANICS on an argument that is not valid Unicode —
/// an abort under `panic = "abort"`, before the running window was even
/// focused. Here the file is chosen exactly as a first launch chooses it
/// ([`first_file_arg_in`]: absolute, existing, losslessly decodable), so an
/// undecodable name is passed over rather than mangled into a file that does
/// not exist, and a relative name no longer depends on the receiver joining it
/// to a working directory that might itself be undecodable (that is sent
/// empty, as the plugin does).
pub fn forward_payload(cwd: &Path, args: impl Iterator<Item = OsString>) -> Vec<u8> {
    let mut args = args;
    let argv0 = args.next().map(|a| a.to_string_lossy().into_owned()).unwrap_or_default();
    let mut text = format!("{}|{argv0}", cwd.to_str().unwrap_or_default());
    // `first_file_arg_in` skips argv[0] itself; it has already been taken.
    let rest = std::iter::once(OsString::new()).chain(args);
    if let Some(file) = first_file_arg_in(rest, cwd) {
        if let Some(file) = file.to_str() {
            text.push('|');
            text.push_str(file);
        }
    }
    text.push('\0');
    text.into_bytes()
}

/// [`forward_payload`] for this process's own command line.
pub fn launch_payload() -> Vec<u8> {
    forward_payload(&std::env::current_dir().unwrap_or_default(), std::env::args_os())
}

/// `main()`, before anything else: if an instance is already running, hand
/// this launch to it. Runs BEFORE the single-instance plugin, which would
/// otherwise do the forwarding itself with the three flaws described on
/// [`WINDOW_WAIT`], [`SEND_TIMEOUT`] and [`forward_payload`].
///
/// A plain first launch pays one `OpenMutexW` that finds nothing; `payload` is
/// built only when there is somewhere to send it. The plugin still runs
/// afterwards and still owns the mutex, the window and the receiving side. A
/// launch that slips in after this check (no mutex yet) and before the
/// plugin's (mutex AND window up) still takes the plugin's own forward: a
/// window of milliseconds, against the whole life of the app before.
pub fn forward_to_running(
    names: &InstanceNames,
    payload: impl FnOnce() -> Vec<u8>,
    wait: std::time::Duration,
    timeout: std::time::Duration,
) -> Forward {
    #[cfg(windows)]
    {
        if !win::mutex_exists(names) {
            return Forward::Stay;
        }
        match win::wait_for_window(names, |_| true, wait) {
            Some(hwnd) => win::send(hwnd, &payload(), timeout),
            None => Forward::Stay,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (names, payload, wait, timeout);
        Forward::Stay
    }
}

/// `.setup()`, first thing: did the plugin make THIS process the instance?
///
/// The plugin starts a second full instance when its `CreateMutexW` reports
/// "already exists" but the first instance's window is not up yet. The
/// pre-check in `main()` waits for that window, but a launch can still reach
/// the plugin inside the gap. So: if an instance window belongs to `own_pid`,
/// the plugin made us the instance and nothing changes (one `FindWindowExW`,
/// no wait). Otherwise wait for ANOTHER process's window and hand over to it
/// before this process sweeps temp projects or writes anything. `Stay` when
/// none appears — the old behaviour, a second instance.
///
/// Enumerated, not a single `FindWindowW`: while a closing instance's window
/// and a fresh one's briefly coexist, the first match could be either.
pub fn forward_if_not_primary(
    names: &InstanceNames,
    own_pid: u32,
    payload: impl FnOnce() -> Vec<u8>,
    wait: std::time::Duration,
    timeout: std::time::Duration,
) -> Forward {
    #[cfg(windows)]
    {
        if win::find_window(names, |pid| pid == own_pid).is_some() {
            return Forward::Stay;
        }
        match win::wait_for_window(names, |pid| pid != own_pid, wait) {
            Some(hwnd) => win::send(hwnd, &payload(), timeout),
            None => Forward::Stay,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (names, own_pid, payload, wait, timeout);
        Forward::Stay
    }
}

#[cfg(windows)]
mod win {
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows_sys::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetWindowThreadProcessId, IsWindow, SendMessageTimeoutW, SMTO_NORMAL,
        WM_COPYDATA,
    };

    use super::{Forward, InstanceNames, FORWARD_TAG};

    const POLL: Duration = Duration::from_millis(10);

    /// Whether some process holds the instance mutex. Opened for SYNCHRONIZE
    /// only and closed at once: a handle kept here would keep the mutex alive
    /// after the instance that owns it has gone.
    pub(super) fn mutex_exists(names: &InstanceNames) -> bool {
        // SAFETY: a NUL-terminated name; the handle is closed before return.
        unsafe {
            let h = OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, names.mutex.as_ptr());
            if h.is_null() {
                return false;
            }
            CloseHandle(h);
            true
        }
    }

    /// The first top-level instance window whose owning process `want`s.
    pub(super) fn find_window(names: &InstanceNames, want: impl Fn(u32) -> bool) -> Option<HWND> {
        let mut after: HWND = std::ptr::null_mut();
        loop {
            // SAFETY: NUL-terminated names; `after` is null or a window this
            // loop was just handed, which is all FindWindowExW asks of it.
            let hwnd = unsafe {
                FindWindowExW(std::ptr::null_mut(), after, names.class.as_ptr(), names.window.as_ptr())
            };
            if hwnd.is_null() {
                return None;
            }
            let mut pid = 0u32;
            // SAFETY: a window handle and a writable u32.
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            if want(pid) {
                return Some(hwnd);
            }
            after = hwnd;
        }
    }

    /// [`find_window`], polled until `wait` has passed.
    pub(super) fn wait_for_window(
        names: &InstanceNames,
        want: impl Fn(u32) -> bool,
        wait: Duration,
    ) -> Option<HWND> {
        let start = Instant::now();
        loop {
            if let Some(hwnd) = find_window(names, &want) {
                return Some(hwnd);
            }
            if start.elapsed() >= wait {
                return None;
            }
            std::thread::sleep(POLL);
        }
    }

    /// Send `payload` as the plugin's WM_COPYDATA, waiting at most `timeout`.
    /// SMTO_NORMAL, deliberately not SMTO_ABORTIFHUNG: that flag gives up at
    /// once on a thread that has been busy for five seconds, and a busy
    /// instance should still get the file once it is free.
    ///
    /// Delivered only when the window procedure ANSWERED 1, as the plugin's
    /// does for every WM_COPYDATA. A send also "succeeds", answering 0, when
    /// the receiving thread ends with the message unhandled (measured:
    /// `an_instance_that_closes_while_we_wait_is_gone`), and that file was
    /// handed to nobody.
    pub(super) fn send(hwnd: HWND, payload: &[u8], timeout: Duration) -> Forward {
        let cds = COPYDATASTRUCT {
            dwData: FORWARD_TAG,
            cbData: u32::try_from(payload.len()).unwrap_or(u32::MAX),
            lpData: payload.as_ptr() as *mut _,
        };
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        let mut answer = 0usize;
        // SAFETY: `cds` and the bytes it points at outlive the call, which
        // is the whole of WM_COPYDATA's contract with the sender.
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_COPYDATA,
                0,
                &cds as *const COPYDATASTRUCT as isize,
                SMTO_NORMAL,
                millis,
                &mut answer,
            )
        };
        if sent != 0 && answer != 0 {
            return Forward::Delivered;
        }
        // SAFETY: IsWindow accepts any value and never faults.
        if unsafe { IsWindow(hwnd) } != 0 {
            Forward::Unanswered
        } else {
            Forward::Gone
        }
    }
}

/// The last path a second launch forwarded, and when — so a burst of the same
/// double-click opens the file once. While the UI thread is busy for a few
/// seconds, every double-click's launch waits on it (see [`SEND_TIMEOUT`]),
/// and once it is free it handles them all within milliseconds; without this
/// each one became another open of the same file. Seeded with the launch's own file, so an
/// impatient second double-click on the file that is still starting the app
/// does not open it twice either.
#[derive(Default)]
pub struct RecentForward(Mutex<Option<(String, std::time::Instant)>>);

/// The same path again within this long is a repeat.
pub const REPEAT_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);

impl RecentForward {
    /// Remember `path` (the launch's own file) as arriving at `now`.
    pub fn seeded(path: Option<String>, now: std::time::Instant) -> Self {
        RecentForward(Mutex::new(path.map(|p| (p, now))))
    }

    /// True when `path` arrives less than [`REPEAT_WINDOW`] after the same
    /// path did. Every call is remembered, so a steady stream of repeats stays
    /// a repeat. Poison-tolerant: it runs inside the plugin's window
    /// procedure, where a panic aborts the app.
    pub fn is_repeat(&self, path: &str, now: std::time::Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let repeat = matches!(&*last, Some((p, t))
            if p == path && now.saturating_duration_since(*t) < REPEAT_WINDOW);
        *last = Some((path.to_owned(), now));
        repeat
    }
}

/// The first queued path, without draining: the launch's own file, read in
/// `main()` to seed [`RecentForward`].
pub fn first_queued(queue: &OpenPathQueue) -> Option<String> {
    queue.0.lock().ok()?.first().cloned()
}

/// A plain native error box, for the one failure that leaves no page to show
/// anything in (the display engine could not start, main.rs). Blocks until
/// the user dismisses it.
pub fn show_error(title: &str, text: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let (title, text) = (wide(title), wide(text));
        // SAFETY: NUL-terminated strings that outlive the call; no owner window.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
    #[cfg(not(windows))]
    eprintln!("{title}: {text}");
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

    /* ---- launch argument ---- */

    fn os(s: &str) -> OsString {
        OsString::from(s)
    }

    /// The argv an UNQUOTED shell verb produces on a profile path with a space:
    /// the exe path split in two, the file third. `nth(1)` would test
    /// "Smith\…\taroting.exe" and find nothing. The file is REAL (a temp file),
    /// so the `is_file` rule is what picks it, not its position; the fixture
    /// asserts argv[1] is not a file, so the row cannot pass by argv[1] being
    /// found instead.
    #[test]
    fn first_file_arg_finds_the_file_past_a_split_exe_path() {
        let dir = temp_dir("argv-space");
        let file = dir.join("holiday clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let tail = r"Smith\AppData\Local\Taroting\taroting.exe";
        assert!(!Path::new(tail).is_file(), "fixture: the exe tail must not resolve");

        let argv = vec![os(r"C:\Users\John"), os(tail), file.clone().into_os_string()];
        assert_eq!(first_file_arg(argv.into_iter()), Some(file.into_os_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A restart after a dead engine carries the session's ORIGINAL argv. The
    /// same argv, naming a real file, opens it on a normal launch and opens
    /// nothing on the restart.
    #[test]
    fn an_engine_restart_never_reopens_the_launch_file() {
        let dir = temp_dir("argv-restart");
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let argv = || vec![os(r"C:\Taroting\taroting.exe"), file.clone().into_os_string()].into_iter();
        assert_eq!(launch_file_arg(argv(), false), Some(file.clone().into_os_string()), "fixture: a launch file");
        assert_eq!(launch_file_arg(argv(), true), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No argument, an argv[0] that IS a file (the running exe always is —
    /// it must never be "opened"), switches, a missing path and a directory:
    /// none of them is a launch file.
    #[test]
    fn first_file_arg_ignores_argv0_and_non_files() {
        let dir = temp_dir("argv-none");
        let exe = dir.join("taroting.exe");
        std::fs::write(&exe, b"MZ").unwrap();

        assert_eq!(first_file_arg(std::iter::empty()), None, "no argv at all");
        assert_eq!(first_file_arg(vec![exe.clone().into_os_string()].into_iter()), None);
        let argv = vec![
            exe.into_os_string(),
            os("--flag"),
            dir.join("missing.trt").into_os_string(),
            dir.clone().into_os_string(),
        ];
        assert_eq!(first_file_arg(argv.into_iter()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An existing file with an undecodable name is passed OVER, and the
    /// decodable file after it is the one returned. Stopping at the first file
    /// instead would hand the queue a name it refuses, and the launch would
    /// open Home with a real file sitting on its command line.
    #[cfg(windows)]
    #[test]
    fn first_file_arg_passes_over_an_undecodable_file() {
        let dir = temp_dir("argv-wtf8");
        let mut weird = dir.clone().into_os_string();
        weird.push(std::path::MAIN_SEPARATOR_STR);
        weird.push(undecodable_name("weird"));
        std::fs::write(&weird, b"{}").unwrap();
        assert!(Path::new(&weird).is_file() && weird.to_str().is_none(), "fixture");
        let good = dir.join("fine.trt");
        std::fs::write(&good, b"{}").unwrap();

        let argv = vec![os("taroting.exe"), weird.clone(), good.clone().into_os_string()];
        assert_eq!(first_file_arg(argv.into_iter()), Some(good.into_os_string()));
        let alone = vec![os("taroting.exe"), weird];
        assert_eq!(first_file_arg(alone.into_iter()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A relative launch argument resolves against the LAUNCH's working
    /// directory and is returned absolute; an absolute one is returned as it
    /// is whatever the working directory. The relative row's cwd is a temp
    /// dir, never the test process's own, so the bare name cannot resolve by
    /// accident — and it is asserted not to.
    #[test]
    fn launch_arguments_come_back_absolute() {
        let dir = temp_dir("argv-relative");
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let other = temp_dir("argv-elsewhere");
        assert!(!Path::new("clip.mp4").is_file(), "fixture: the bare name must not resolve here");

        let relative = vec![os("taroting.exe"), os("clip.mp4")];
        assert_eq!(first_file_arg_in(relative.into_iter(), &dir), Some(file.clone().into_os_string()));
        let absolute = vec![os("taroting.exe"), file.clone().into_os_string()];
        assert_eq!(first_file_arg_in(absolute.into_iter(), &other), Some(file.clone().into_os_string()));
        // Against a directory that does not hold it, the bare name is no file.
        let elsewhere = vec![os("taroting.exe"), os("clip.mp4")];
        assert_eq!(first_file_arg_in(elsewhere.into_iter(), &other), None);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// The forwarded second launch: its relative name is found in ITS working
    /// directory, not this process's, and queued absolute; a name that exists
    /// only in some other folder is not opened from there.
    #[test]
    fn a_forwarded_launch_resolves_against_its_own_directory() {
        let dir = temp_dir("fwd-relative");
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let other = temp_dir("fwd-elsewhere");
        let (dir_s, other_s) = (dir.to_str().unwrap(), other.to_str().unwrap());
        let file_s = file.to_str().unwrap().to_string();
        let argv = |a: &str| vec!["taroting.exe".to_string(), a.to_string()];
        assert!(!Path::new("clip.mp4").is_file(), "fixture: the bare name must not resolve here");

        assert_eq!(forwarded_file_arg(&argv("clip.mp4"), dir_s), Some(file_s.clone()));
        assert_eq!(forwarded_file_arg(&argv(&file_s), other_s), Some(file_s.clone()));
        assert_eq!(forwarded_file_arg(&argv("clip.mp4"), other_s), None);
        assert_eq!(forwarded_file_arg(&["taroting.exe".to_string()], dir_s), None, "argv[0] only");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    fn queue_of(paths: &[&str]) -> OpenPathQueue {
        OpenPathQueue(Mutex::new(paths.iter().map(|p| p.to_string()).collect()))
    }

    /// Only the FIRST path decides, case-insensitively, media or `.trt`. Each
    /// row pairs a first path with a second of the OPPOSITE verdict, so reading
    /// any entry but `[0]` flips it. The bare `.trt` row is the one
    /// `Path::extension` would get wrong (it has no stem); the "trt.txt" row
    /// catches a substring match. Nothing is drained.
    #[test]
    fn queued_known_launch_peeks_the_first_path() {
        let rows: [(&[&str], bool, &str); 9] = [
            (&[r"C:\v\CLIP.MP4", r"C:\n\notes.txt"], true, "upper-case media"),
            (&[r"C:\p\Cut.Trt", r"C:\n\notes.txt"], true, "a project, any case"),
            (&[r"C:\p\.trt", r"C:\n\notes.txt"], true, "a bare .trt, like fileExt"),
            (&[r"D:/a/photo.webp"], true, "forward slashes"),
            (&[r"C:\n\notes.txt", r"C:\v\clip.mp4"], false, "unknown first, media second"),
            (&[r"C:\n\trt.txt"], false, "trt only in the stem"),
            (&[r"C:\n\README"], false, "no extension"),
            (&[r"C:\dot.mp4\README"], false, "the dot is in a folder, not the name"),
            (&[], false, "empty queue"),
        ];
        for (paths, want, why) in rows {
            let q = queue_of(paths);
            assert_eq!(queued_known_launch(&q), want, "{why}");
            assert_eq!(q.0.lock().unwrap().len(), paths.len(), "{why}: peeked, never drained");
        }
    }

    /// No hint beats a crash: a poisoned queue boots Home, today's path.
    #[test]
    fn queued_known_launch_is_false_on_a_poisoned_queue() {
        let q = std::sync::Arc::new(queue_of(&[r"C:\v\clip.mp4"]));
        let q2 = q.clone();
        let _ = std::thread::spawn(move || {
            let _g = q2.0.lock().unwrap();
            panic!("poison the queue");
        })
        .join();
        assert!(q.0.is_poisoned(), "fixture must be poisoned");
        assert!(!queued_known_launch(&q));
    }

    /* ---- second launches ---- */

    /// The forwarding talks to tauri-plugin-single-instance by NAME, so the
    /// names must be the plugin's: the identifier from tauri.conf.json, and no
    /// `semver` feature (it appends a version to every name). That feature
    /// pulls in the semver crate, so the lock file's entry for the plugin
    /// shows it. The version pin makes an upgrade stop here, where its names
    /// and wire format get re-checked against its source.
    #[test]
    fn the_instance_names_are_the_plugins() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        assert_eq!(conf["identifier"], APP_IDENTIFIER);

        let lock = include_str!("../Cargo.lock");
        let entry = lock
            .split("[[package]]")
            .find(|p| p.contains("name = \"tauri-plugin-single-instance\""))
            .expect("the plugin is in Cargo.lock");
        assert!(
            entry.contains("version = \"2.4.3\""),
            "the plugin changed version: re-check its names and WM_COPYDATA format, then move this pin"
        );
        assert!(!entry.contains("\"semver"), "the semver feature is on: every name has a version suffix");

        let names = InstanceNames::of(APP_IDENTIFIER);
        let text = |w: &[u16]| String::from_utf16(w).unwrap();
        assert_eq!(text(&names.mutex), "com.taroting.app-sim\0");
        assert_eq!(text(&names.class), "com.taroting.app-sic\0");
        assert_eq!(text(&names.window), "com.taroting.app-siw\0");
    }

    /// What the plugin's window procedure does with the bytes (its WM_COPYDATA
    /// arm): a lossy C string, split on `|`, the first part the working
    /// directory and the rest argv.
    fn plugin_parse(bytes: &[u8]) -> (String, Vec<String>) {
        let text = std::ffi::CStr::from_bytes_until_nul(bytes)
            .expect("NUL-terminated")
            .to_string_lossy()
            .into_owned();
        let mut parts = text.split('|');
        let cwd = parts.next().unwrap_or_default().to_string();
        (cwd, parts.map(str::to_string).collect())
    }

    /// argv[1] is an EXISTING file whose name is not valid Unicode (where the
    /// plugin's `std::env::args()` aborts the process), argv[2] a relative
    /// name of a real file. The payload passes over the first, sends the
    /// second absolute, and the receiver's own parsing plus
    /// `forwarded_file_arg` — run against a DIFFERENT directory — recover it.
    #[cfg(windows)]
    #[test]
    fn the_payload_passes_over_an_undecodable_name_and_reaches_the_receiver() {
        let dir = temp_dir("payload");
        let mut weird = dir.clone().into_os_string();
        weird.push(std::path::MAIN_SEPARATOR_STR);
        weird.push(undecodable_name("weird"));
        std::fs::write(&weird, b"{}").unwrap();
        assert!(Path::new(&weird).is_file() && weird.to_str().is_none(), "fixture");
        let file = dir.join("clip two.mp4");
        std::fs::write(&file, b"x").unwrap();
        let file_s = file.to_str().unwrap().to_string();
        let exe = r"C:\Program Files\Taroting\taroting.exe";

        let bytes = forward_payload(&dir, vec![os(exe), weird, os("clip two.mp4")].into_iter());
        assert_eq!(bytes.last(), Some(&0), "the receiver reads up to a NUL");
        let (cwd, argv) = plugin_parse(&bytes);
        assert_eq!(cwd, dir.to_str().unwrap());
        assert_eq!(argv, vec![exe.to_string(), file_s.clone()]);

        let other = temp_dir("payload-elsewhere");
        assert_eq!(forwarded_file_arg(&argv, other.to_str().unwrap()), Some(file_s));

        // No file at all: still a message (the running window is focused).
        let bytes = forward_payload(&dir, vec![os(exe)].into_iter());
        assert_eq!(plugin_parse(&bytes), (dir.to_str().unwrap().to_string(), vec![exe.to_string()]));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// A stand-in for a running Taroting: the plugin's mutex, and its hidden
    /// event window on a thread of its own, recording every WM_COPYDATA. Its
    /// names are the test's own (never the real identifier, which an owner's
    /// open Taroting answers to), the window is never shown, and the thread
    /// is ended when the stand-in is dropped.
    #[cfg(windows)]
    mod stand_in {
        use std::sync::mpsc::{channel, Receiver, Sender};
        use std::thread::JoinHandle;
        use std::time::Duration;

        use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
        use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentThreadId};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
            GetWindowLongPtrW, PeekMessageW, PostThreadMessageW, RegisterClassExW, SetWindowLongPtrW,
            TranslateMessage, CREATESTRUCTW, GWLP_USERDATA, MSG, WM_COPYDATA, WM_NCCREATE,
            WM_NCDESTROY, WM_QUIT, PM_NOREMOVE, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
        };

        type Got = Sender<(usize, Vec<u8>)>;

        /// When the window comes up after the mutex, how long the thread is
        /// busy before it pumps messages, and whether it then ends without
        /// ever pumping (its window dies with it).
        #[derive(Clone, Copy, Default)]
        pub struct Plan {
            pub window_after: Duration,
            pub busy_for: Duration,
            pub end_unpumped: bool,
        }

        pub struct StandIn {
            thread_id: u32,
            join: Option<JoinHandle<()>>,
            pub got: Receiver<(usize, Vec<u8>)>,
            window_up: Receiver<()>,
        }

        impl StandIn {
            /// Block until the window exists.
            pub fn wait_for_window(&self) {
                self.window_up.recv_timeout(Duration::from_secs(5)).expect("the window came up");
            }
        }

        impl Drop for StandIn {
            fn drop(&mut self) {
                // SAFETY: posting to a thread id; harmless if it has ended.
                unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
                if let Some(join) = self.join.take() {
                    let _ = join.join();
                }
            }
        }

        pub fn id(tag: &str) -> String {
            format!("taroting-test-{}-{tag}", std::process::id())
        }

        fn wide(s: String) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        /// Returns once the mutex exists (the window may still be coming).
        pub fn start(id: &str, plan: Plan) -> StandIn {
            let (mutex_tx, mutex_rx) = channel();
            let (window_tx, window_up) = channel();
            let (got_tx, got) = channel::<(usize, Vec<u8>)>();
            let id = id.to_owned();
            let join = std::thread::spawn(move || {
                let (mutex_name, class, title) =
                    (wide(format!("{id}-sim")), wide(format!("{id}-sic")), wide(format!("{id}-siw")));
                // SAFETY: plain Win32 calls with NUL-terminated names; the
                // sender box is freed in WM_NCDESTROY (or leaked with a window
                // the system destroys at thread exit, harmless in a test).
                unsafe {
                    // Give the thread its message queue NOW, so the WM_QUIT
                    // a drop posts is queued even while the thread is still
                    // asleep before its window exists.
                    let mut msg: MSG = std::mem::zeroed();
                    PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                    let mutex = CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr());
                    assert!(!mutex.is_null(), "stand-in mutex");
                    let _ = mutex_tx.send(GetCurrentThreadId());
                    std::thread::sleep(plan.window_after);
                    let hinstance = GetModuleHandleW(std::ptr::null());
                    let mut wc: WNDCLASSEXW = std::mem::zeroed();
                    wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
                    wc.lpfnWndProc = Some(proc);
                    wc.hInstance = hinstance;
                    wc.lpszClassName = class.as_ptr();
                    RegisterClassExW(&wc);
                    let sender = Box::into_raw(Box::new(got_tx));
                    let hwnd = CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        class.as_ptr(),
                        title.as_ptr(),
                        WS_POPUP,
                        0,
                        0,
                        0,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        hinstance,
                        sender as *const std::ffi::c_void,
                    );
                    assert!(!hwnd.is_null(), "stand-in window");
                    let _ = window_tx.send(());
                    std::thread::sleep(plan.busy_for);
                    if !plan.end_unpumped {
                        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                            TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                        DestroyWindow(hwnd);
                    }
                    CloseHandle(mutex);
                }
            });
            let thread_id = mutex_rx.recv_timeout(Duration::from_secs(5)).expect("the mutex came up");
            StandIn { thread_id, join: Some(join), got, window_up }
        }

        unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            match msg {
                WM_NCCREATE => {
                    let create = &*(lparam as *const CREATESTRUCTW);
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
                WM_COPYDATA => {
                    let cds = &*(lparam as *const COPYDATASTRUCT);
                    let bytes = std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize).to_vec();
                    let got = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Got;
                    if !got.is_null() {
                        let _ = (*got).send((cds.dwData, bytes));
                    }
                    1
                }
                WM_NCDESTROY => {
                    let got = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Got;
                    if !got.is_null() {
                        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                        drop(Box::from_raw(got));
                    }
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    #[cfg(windows)]
    const PAYLOAD: &[u8] = b"C:\\work|C:\\Taroting\\taroting.exe|C:\\work\\clip.mp4\0";

    /// A plain first launch: no mutex, so the answer is immediate and the
    /// payload (which touches the disk) is never even built.
    #[cfg(windows)]
    #[test]
    fn with_no_instance_running_a_launch_stays_at_once() {
        let names = InstanceNames::of(&stand_in::id("none"));
        let built = std::cell::Cell::new(false);
        let start = Instant::now();
        let got = forward_to_running(&names, || { built.set(true); PAYLOAD.to_vec() }, WINDOW_WAIT, SEND_TIMEOUT);
        assert_eq!(got, Forward::Stay);
        assert!(start.elapsed() < WINDOW_WAIT, "no mutex must not wait for a window");
        assert!(!built.get(), "the payload was built for nobody");
    }

    /// The running instance receives the message byte for byte, under the
    /// tag its window procedure accepts.
    #[cfg(windows)]
    #[test]
    fn a_running_instance_receives_the_plugins_message() {
        let id = stand_in::id("running");
        let primary = stand_in::start(&id, stand_in::Plan::default());
        primary.wait_for_window();
        let got = forward_to_running(&InstanceNames::of(&id), || PAYLOAD.to_vec(), WINDOW_WAIT, SEND_TIMEOUT);
        assert_eq!(got, Forward::Delivered);
        assert_eq!(primary.got.recv_timeout(ms(2_000)).unwrap(), (1542, PAYLOAD.to_vec()));
    }

    /// The race the plugin loses: the mutex exists, the window does not yet.
    /// The window comes up 80 ms later — inside [`WINDOW_WAIT`] — and the
    /// launch is handed over instead of starting a second instance. A check
    /// that looks once (no wait) answers `Stay` here.
    #[cfg(windows)]
    #[test]
    fn a_window_that_comes_up_after_the_mutex_is_waited_for() {
        let id = stand_in::id("late-window");
        let plan = stand_in::Plan { window_after: ms(80), ..Default::default() };
        let primary = stand_in::start(&id, plan);
        let got = forward_to_running(&InstanceNames::of(&id), || PAYLOAD.to_vec(), WINDOW_WAIT, SEND_TIMEOUT);
        assert_eq!(got, Forward::Delivered);
        assert_eq!(primary.got.recv_timeout(ms(2_000)).unwrap().1, PAYLOAD.to_vec());
    }

    /// A mutex whose window never comes (within the wait): the launch stops
    /// waiting and stays, the old behaviour, instead of hanging.
    #[cfg(windows)]
    #[test]
    fn a_mutex_without_a_window_is_waited_for_only_briefly() {
        let id = stand_in::id("no-window");
        let plan = stand_in::Plan { window_after: ms(1_500), ..Default::default() };
        let _primary = stand_in::start(&id, plan);
        let start = Instant::now();
        let got = forward_to_running(&InstanceNames::of(&id), || PAYLOAD.to_vec(), ms(100), SEND_TIMEOUT);
        assert_eq!(got, Forward::Stay);
        let took = start.elapsed();
        assert!(took >= ms(100) && took < ms(1_000), "waited {took:?}");
    }

    /// The running instance's UI thread is busy for 600 ms. A launch whose
    /// limit runs out first (100 ms) is told `Unanswered` at its limit, not
    /// held for the whole spell — and its message is WITHDRAWN: it never
    /// arrives, which is why [`SEND_TIMEOUT`] is long. A launch with time to
    /// spare waits the spell out and is delivered, exactly once.
    #[cfg(windows)]
    #[test]
    fn a_busy_instance_gets_the_file_once_it_is_free() {
        let id = stand_in::id("busy");
        let plan = stand_in::Plan { busy_for: ms(600), ..Default::default() };
        let primary = stand_in::start(&id, plan);
        primary.wait_for_window();
        let names = InstanceNames::of(&id);

        let start = Instant::now();
        let early = b"early|C:\\Taroting\\taroting.exe\0".to_vec();
        let got = forward_to_running(&names, || early.clone(), WINDOW_WAIT, ms(100));
        let took = start.elapsed();
        assert_eq!(got, Forward::Unanswered);
        assert!(took >= ms(100) && took < ms(450), "the launch waited {took:?}");

        let got = forward_to_running(&names, || PAYLOAD.to_vec(), WINDOW_WAIT, ms(3_000));
        assert_eq!(got, Forward::Delivered);
        assert!(start.elapsed() >= ms(400), "delivered before the thread was free?");
        assert_eq!(primary.got.recv_timeout(ms(2_000)).unwrap(), (1542, PAYLOAD.to_vec()));
        std::thread::sleep(ms(100));
        assert!(primary.got.try_recv().is_err(), "the withdrawn message arrived after all");
    }

    /// The instance's thread ends (its window with it) while the launch is
    /// waiting on it: `Gone`, well before the send limit, so the launch runs
    /// as the app rather than ending with its file handed to nobody.
    #[cfg(windows)]
    #[test]
    fn an_instance_that_closes_while_we_wait_is_gone() {
        let id = stand_in::id("closing");
        let plan = stand_in::Plan { busy_for: ms(150), end_unpumped: true, ..Default::default() };
        let primary = stand_in::start(&id, plan);
        primary.wait_for_window();
        let start = Instant::now();
        let got = forward_to_running(&InstanceNames::of(&id), || PAYLOAD.to_vec(), WINDOW_WAIT, ms(3_000));
        assert_eq!(got, Forward::Gone);
        assert!(start.elapsed() < ms(2_500), "waited {:?}", start.elapsed());
    }

    /// The setup-time check. The stand-in's window belongs to THIS process,
    /// so with our real pid it is our own window — the plugin made us the
    /// instance: `Stay` at once, nothing built or sent. With a pid that is
    /// not ours (as for a launch that lost the race), the same window is
    /// another instance's, and the launch is handed to it.
    #[cfg(windows)]
    #[test]
    fn the_setup_check_keeps_the_instance_and_hands_a_racer_over() {
        let id = stand_in::id("setup");
        let primary = stand_in::start(&id, stand_in::Plan::default());
        primary.wait_for_window();
        let names = InstanceNames::of(&id);

        let built = std::cell::Cell::new(false);
        let start = Instant::now();
        let own = forward_if_not_primary(
            &names,
            std::process::id(),
            || { built.set(true); PAYLOAD.to_vec() },
            WINDOW_WAIT,
            SEND_TIMEOUT,
        );
        assert_eq!(own, Forward::Stay);
        assert!(start.elapsed() < ms(100) && !built.get(), "the instance itself must not wait or send");
        assert!(primary.got.try_recv().is_err(), "nothing was sent");

        let not_ours = std::process::id().wrapping_add(4);
        let racer = forward_if_not_primary(&names, not_ours, || PAYLOAD.to_vec(), WINDOW_WAIT, SEND_TIMEOUT);
        assert_eq!(racer, Forward::Delivered);
        assert_eq!(primary.got.recv_timeout(ms(2_000)).unwrap().1, PAYLOAD.to_vec());
    }

    /// The burst rule. Seeded with the launch's own file; the same path
    /// within 2 s is a repeat, at 2 s it is not; a different path is never a
    /// repeat and becomes the one remembered; repeats keep the window sliding.
    #[test]
    fn the_same_forwarded_file_within_two_seconds_is_a_repeat() {
        let t0 = Instant::now();
        let a = r"C:\v\clip.mp4";
        let b = r"C:\v\other.mp4";
        let recent = RecentForward::seeded(Some(a.to_string()), t0);
        assert!(recent.is_repeat(a, t0 + ms(1_900)), "the launch file again, 1.9 s later");
        assert!(recent.is_repeat(a, t0 + ms(3_800)), "1.9 s after that repeat: still sliding");
        assert!(!recent.is_repeat(a, t0 + ms(5_800)), "2.0 s after the last one: a new open");
        assert!(!recent.is_repeat(b, t0 + ms(5_801)), "another file is never a repeat");
        assert!(!recent.is_repeat(a, t0 + ms(5_802)), "and it replaced the remembered one");

        let fresh = RecentForward::seeded(None, t0);
        assert!(!fresh.is_repeat(a, t0), "a plain launch remembers nothing");
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
