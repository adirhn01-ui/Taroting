//! Crash notes and page recovery — so "it just ended itself, no error
//! message" leaves something behind.
//!
//! Release builds use `panic = "abort"`, and nothing else in the process
//! records a native fault (an access violation inside a codec or driver DLL),
//! so until now either one vanished without a trace. And when WebView2's page
//! process died, nothing listened: the window stayed blank forever.
//!
//! **What is written, and where.** One small text note,
//! `%LOCALAPPDATA%\Taroting\last-crash.txt` (`paths::app_local_dir`, redirected
//! under autotest), written AS the process dies:
//! - a Rust panic, from the panic hook (it runs before the abort);
//! - a native fault, from an unhandled-exception filter, with NO heap use —
//!   the heap may be what broke;
//! - the WebView2 engine (browser process) dying, from its ProcessFailed event.
//!
//! The next launch's `take_crash_notes` hands the note to the page once
//! ("Taroting closed unexpectedly last time.", details copyable through the
//! redacting pane) and renames it to `last-crash.seen.txt`: shown once, still
//! on disk for anyone asked to look. Nothing is ever sent anywhere.
//!
//! **Recovery.** A dead page process (RENDER_PROCESS_EXITED) is reloaded, at
//! most [`RELOADS_MAX`] times per [`RELOAD_WINDOW`], with an in-memory note the
//! reloaded page shows. A dead engine restarts the app (from another thread,
//! so the single-instance mutex is released before the new process starts —
//! see `on_engine_exit`), unless the previous note says the engine also died
//! less than [`ENGINE_LOOP_WINDOW`] ago.
//!
//! **Zero overhead until something breaks.** `install` computes one path and
//! registers two callbacks; `watch_webview` registers one COM event handler.
//! No thread, timer, file or poll exists until a crash.

use std::fmt::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::paths;

const NOTE_FILE: &str = "last-crash.txt";
const SEEN_FILE: &str = "last-crash.seen.txt";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A panic message longer than this is cut (on a char boundary).
const MAX_MESSAGE_CHARS: usize = 2000;
/// Read at most this much of a note: ours are a few hundred bytes, and a file
/// grown by anything else must not be streamed into the page whole.
const MAX_NOTE_BYTES: u64 = 16 * 1024;
/// The fault note is built in a stack buffer of this size (no heap).
#[cfg_attr(not(windows), allow(dead_code))]
const FAULT_NOTE_MAX: usize = 1024;

/// Page reloads allowed within [`RELOAD_WINDOW`]. A page that dies again and
/// again is left dead rather than reloaded forever.
pub const RELOADS_MAX: usize = 3;
pub const RELOAD_WINDOW: Duration = Duration::from_secs(120);
/// An engine death this soon after the previous one does not restart again.
pub const ENGINE_LOOP_WINDOW: Duration = Duration::from_secs(60);

/* ------------------------------ the note ------------------------------ */

/// A crash the page should say something about — mirrored by `CrashNote` in
/// src/core/ipc.ts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashNote {
    /// "panic" | "fault" | "engine" from the note file; "page" in memory.
    pub kind: &'static str,
    /// UTC "YYYY-MM-DDTHH:MM:SSZ", when the note has a readable time.
    pub at: Option<String>,
    /// The whole note text.
    pub detail: String,
}

/// This run's page reloads, waiting for the reloaded page to ask. In memory
/// only; a poisoned lock is still read (a note is worth more than the panic
/// that poisoned it).
#[derive(Default)]
pub struct Notes(Mutex<Vec<CrashNote>>);

impl Notes {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn push(&self, note: CrashNote) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push(note);
    }

    fn drain(&self) -> Vec<CrashNote> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// UTC wall-clock time, field by field — what `GetSystemTime` returns, so the
/// fault filter can stamp a note without allocating.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UtcTime {
    pub year: u16,
    pub month: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
}

impl UtcTime {
    /// Now. `None` off Windows (no port ships yet), written as "unknown".
    fn now() -> Option<Self> {
        #[cfg(windows)]
        {
            // SAFETY: GetSystemTime only fills the struct it is handed.
            let mut st: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
            unsafe { windows_sys::Win32::System::SystemInformation::GetSystemTime(&mut st) };
            Some(Self {
                year: st.wYear,
                month: st.wMonth,
                day: st.wDay,
                hour: st.wHour,
                minute: st.wMinute,
                second: st.wSecond,
            })
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

impl fmt::Display for UtcTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

/// The three lines every note starts with. `kind:` is always the third line
/// and the free text (a panic message) always the last field, so a message
/// that contains "kind: engine" cannot change what the note is read as.
fn write_head(w: &mut impl fmt::Write, kind: &str, at: Option<UtcTime>) -> fmt::Result {
    writeln!(w, "Taroting {VERSION}")?;
    match at {
        Some(t) => writeln!(w, "time: {t}")?,
        None => writeln!(w, "time: unknown")?,
    }
    writeln!(w, "kind: {kind}")
}

/// A whole note: the head, then `key: value` lines in the order given.
fn note_text(kind: &str, at: Option<UtcTime>, fields: &[(&str, &str)]) -> String {
    let mut s = String::with_capacity(256);
    let _ = write_head(&mut s, kind, at);
    for (k, v) in fields {
        let _ = writeln!(s, "{k}: {v}");
    }
    s
}

/// The panic note. The panic hook and the autotest's synthetic note both build
/// their text here and write it through [`write_note`].
fn panic_note_text(at: Option<UtcTime>, thread: &str, location: &str, message: &str) -> String {
    note_text(
        "panic",
        at,
        &[
            ("thread", thread),
            ("location", location),
            ("message", truncate_chars(message, MAX_MESSAGE_CHARS)),
        ],
    )
}

/// At most `max` chars of `s`, cut on a char boundary (never mid-character).
fn truncate_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((end, _)) => s.get(..end).unwrap_or(s),
        None => s,
    }
}

/// A panic location with the BUILD machine's paths removed. Dependencies are
/// compiled from `<CARGO_HOME>\registry\src\<index>\<crate>-<ver>\…` (or
/// `git\checkouts\…`), which carries the build account's user name; only the
/// part from `<crate>-<ver>\` on says anything about the bug. Our own crate's
/// locations are already relative (`src\…`) and pass through untouched. Any
/// other absolute path keeps its shape with the account name replaced.
pub fn sanitize_location(file: &str) -> String {
    let parts = path_parts(file);
    let at = |i: usize| parts.get(i).map(|&(_, p)| p);
    let is = |i: usize, name: &str| at(i).is_some_and(|p| p.eq_ignore_ascii_case(name));
    for i in 0..parts.len() {
        // registry\src\<index>\<crate>-<ver>\… → <crate>-<ver>\…
        let keep = if is(i, "registry") && is(i + 1, "src") {
            parts.get(i + 3)
        } else if is(i, "git") && is(i + 1, "checkouts") {
            parts.get(i + 2)
        } else {
            None
        };
        if let Some(&(start, _)) = keep {
            return file.get(start..).unwrap_or(file).to_owned();
        }
    }
    // C:\Users\<name>\…, /home/<name>/…, /Users/<name>/…
    let drive = at(0).is_some_and(|p| p.len() == 2 && p.ends_with(':'));
    let name = if drive && is(1, "users") {
        parts.get(2)
    } else if file.starts_with('/') && (is(0, "home") || is(0, "users")) {
        parts.get(1)
    } else {
        None
    };
    match name {
        Some(&(start, n)) => {
            let head = file.get(..start).unwrap_or("");
            let tail = file.get(start + n.len()..).unwrap_or("");
            format!("{head}<user>{tail}")
        }
        None => file.to_owned(),
    }
}

/// The non-empty components of a path split on `\` and `/`, each with its byte
/// offset. Separators are ASCII, so every offset is a char boundary.
fn path_parts(file: &str) -> Vec<(usize, &str)> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (i, c) in file.char_indices() {
        if c == '\\' || c == '/' {
            if let Some(p) = file.get(start..i).filter(|p| !p.is_empty()) {
                parts.push((start, p));
            }
            start = i + 1;
        }
    }
    if let Some(p) = file.get(start..).filter(|p| !p.is_empty()) {
        parts.push((start, p));
    }
    parts
}

/// A fixed buffer as an `fmt::Write` — the fault filter's only "allocation".
/// Writing past the end keeps what fits and reports an error.
struct StackText<'a> {
    out: &'a mut [u8],
    len: usize,
}

impl fmt::Write for StackText<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let room = self.out.len().saturating_sub(self.len);
        let n = s.len().min(room);
        match (self.out.get_mut(self.len..self.len + n), s.as_bytes().get(..n)) {
            (Some(dst), Some(src)) => dst.copy_from_slice(src),
            _ => return Err(fmt::Error),
        }
        self.len += n;
        if n < s.len() {
            Err(fmt::Error)
        } else {
            Ok(())
        }
    }
}

/// The fault note, formatted into `out` without touching the heap; returns the
/// number of bytes written (never more than `out.len()`). Pure, so the filter's
/// text is unit-tested.
///
/// `module` is the faulting module's FILE NAME as UTF-16 (anything outside
/// printable ASCII becomes `?`, so the note is plain ASCII); `offset` is the
/// fault address relative to that module's base. With no module (`None`),
/// `offset` is the raw fault address.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn format_fault_note(
    code: u32,
    module: Option<&[u16]>,
    offset: usize,
    at: Option<UtcTime>,
    out: &mut [u8],
) -> usize {
    let mut w = StackText { out, len: 0 };
    let _ = write_fault(&mut w, code, module, offset, at);
    w.len
}

#[cfg_attr(not(windows), allow(dead_code))]
fn write_fault(
    w: &mut StackText<'_>,
    code: u32,
    module: Option<&[u16]>,
    offset: usize,
    at: Option<UtcTime>,
) -> fmt::Result {
    write_head(w, "fault", at)?;
    writeln!(w, "code: 0x{code:08X}")?;
    match module {
        Some(name) => {
            w.write_str("module: ")?;
            for &unit in name {
                let c = if (0x20..0x7F).contains(&unit) { char::from(unit as u8) } else { '?' };
                w.write_char(c)?;
            }
            writeln!(w, "+0x{offset:X}")
        }
        None => writeln!(w, "module: unknown\naddress: 0x{offset:X}"),
    }
}

/* ------------------------------ files ------------------------------ */

struct NotePaths {
    dir: PathBuf,
    /// NUL-terminated UTF-16 copies for the fault filter, which must not
    /// allocate to build them.
    #[cfg(windows)]
    dir_w: Vec<u16>,
    #[cfg(windows)]
    file_w: Vec<u16>,
}

static NOTE: OnceLock<NotePaths> = OnceLock::new();

impl NotePaths {
    fn new(dir: PathBuf) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
            let dir_w = wide(&dir);
            let file_w = wide(&dir.join(NOTE_FILE));
            Self { dir, dir_w, file_w }
        }
        #[cfg(not(windows))]
        {
            Self { dir }
        }
    }
}

/// The folder notes live in: the one `install` fixed, else computed now.
fn note_dir() -> Option<PathBuf> {
    NOTE.get()
        .map(|p| p.dir.clone())
        .or_else(|| paths::app_local_dir().ok())
}

/// Replace the note in `dir` with `text`. The one writer behind the panic hook,
/// the engine note and the autotest's synthetic note. Never fails loudly: it
/// may be running inside a dying process.
fn write_note(dir: &Path, text: &str) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(NOTE_FILE), text.as_bytes());
}

fn read_capped(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_NOTE_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// What a note's head says: its kind (one we know, else "panic" — a damaged
/// note still means the app ended) and its time. Only the head lines are read.
fn parse_head(text: &str) -> (&'static str, Option<String>) {
    let mut kind = None;
    let mut at = None;
    for line in text.lines().take(3) {
        if let Some(k) = line.strip_prefix("kind: ") {
            kind = Some(k.trim());
        } else if let Some(t) = line.strip_prefix("time: ") {
            let t = t.trim();
            if is_stamp(t) {
                at = Some(t.to_owned());
            }
        }
    }
    let kind = match kind {
        Some("fault") => "fault",
        Some("engine") => "engine",
        _ => "panic",
    };
    (kind, at)
}

/// "YYYY-MM-DDTHH:MM:SSZ", exactly.
fn is_stamp(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, &c)| match i {
            4 | 7 => c == b'-',
            10 => c == b'T',
            13 | 16 => c == b':',
            19 => c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// Hand over the note in `dir`, once: read it, then rename it to
/// last-crash.seen.txt (replacing an older one) so the next launch does not
/// show it again but it stays on disk. A rename that fails (a locked or odd
/// `.seen`) falls back to deleting the note — showing it on every launch
/// would be worse than losing the copy.
fn take_file_note(dir: &Path) -> Option<CrashNote> {
    let file = dir.join(NOTE_FILE);
    if !file.is_file() {
        return None;
    }
    let text = read_capped(&file)?;
    if std::fs::rename(&file, dir.join(SEEN_FILE)).is_err() {
        let _ = std::fs::remove_file(&file);
    }
    let (kind, at) = parse_head(&text);
    let detail = if text.trim().is_empty() {
        "(the crash note was empty — the process ended while writing it)".to_owned()
    } else {
        text
    };
    Some(CrashNote { kind, at, detail })
}

/// The newest note in `dir`, shown or not, as (kind, age by its file time).
/// The note is usually already `.seen` by the time this asks: the page takes
/// it within moments of loading. A rename keeps the file time. A time in the
/// future (clock change) reads as age zero, the cautious answer.
fn previous_note(dir: &Path) -> Option<(&'static str, Duration)> {
    let newest = [NOTE_FILE, SEEN_FILE]
        .into_iter()
        .map(|name| dir.join(name))
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok().filter(|m| m.is_file())?;
            Some((meta.modified().ok()?, p))
        })
        .max_by_key(|(t, _)| *t)?;
    let (kind, _) = parse_head(&read_capped(&newest.1)?);
    let age = SystemTime::now().duration_since(newest.0).unwrap_or(Duration::ZERO);
    Some((kind, age))
}

/* ------------------------- recovery decisions ------------------------- */

/// May the page be reloaded `now` (time since the watch began)? Records the
/// reload when it may. At most [`RELOADS_MAX`] within any [`RELOAD_WINDOW`]; a
/// refused attempt is not recorded.
pub fn take_reload(history: &mut Vec<Duration>, now: Duration) -> bool {
    history.retain(|&t| now.saturating_sub(t) < RELOAD_WINDOW);
    if history.len() >= RELOADS_MAX {
        return false;
    }
    history.push(now);
    true
}

/// May a dead engine restart the app, given the previous note (kind, age)?
/// Not when the engine also died less than [`ENGINE_LOOP_WINDOW`] ago: that is
/// a restart loop, and a window that keeps reappearing is worse than one note.
pub fn engine_restart_allowed(previous: Option<(&str, Duration)>) -> bool {
    !matches!(previous, Some(("engine", age)) if age < ENGINE_LOOP_WINDOW)
}

/* ------------------------------ install ------------------------------ */

/// Arm the panic hook and the fault filter. FIRST statement of `main()`, so a
/// failure anywhere after it leaves a note. If the note's folder cannot even
/// be named (no %LOCALAPPDATA%), nothing is installed.
pub fn install() {
    let Ok(dir) = paths::app_local_dir() else { return };
    if NOTE.set(NotePaths::new(dir)).is_err() {
        return; // already installed
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        on_panic(info);
        previous(info);
    }));
    #[cfg(windows)]
    fault::install();
}

/// The panic hook body. Must never panic itself: no unwrap, no indexing that
/// can fail, every write's error ignored.
fn on_panic(info: &std::panic::PanicHookInfo<'_>) {
    let Some(paths) = NOTE.get() else { return };
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(non-text panic payload)");
    let location = info.location().map_or_else(
        || "unknown".to_owned(),
        |l| format!("{}:{}:{}", sanitize_location(l.file()), l.line(), l.column()),
    );
    let thread = std::thread::current();
    let text = panic_note_text(UtcTime::now(), thread.name().unwrap_or("unnamed"), &location, message);
    write_note(&paths.dir, &text);
}

/// Autotest only (`debug::debug_write_crash_note`): a note as if `kind` had
/// happened, written through the same builder and writer as the real ones —
/// without the real thing.
pub fn write_synthetic_note(kind: &str, message: &str) -> Result<()> {
    let at = UtcTime::now();
    let text = match kind {
        "panic" => panic_note_text(at, "autotest", "(synthetic, no panic)", message),
        "fault" | "engine" => note_text(kind, at, &[("message", truncate_chars(message, MAX_MESSAGE_CHARS))]),
        _ => return Err(AppError::BadInput(format!("unknown crash note kind {kind:?}"))),
    };
    let dir = note_dir().ok_or_else(|| AppError::BadInput("no folder for crash notes".into()))?;
    write_note(&dir, &text);
    Ok(())
}

/// The display engine could not be created at startup: the window has no
/// page, and main.rs is about to say so in a native box and end the process.
/// An "engine" note whose `restarted:` line says no, so the next launch's page
/// reads it as "the display engine stopped, so Taroting closed"
/// (`ENGINE_NOT_RESTARTED` in src/core/crash-notes.ts) — the true account —
/// and its detail carries the one thing known about the cause: whether a
/// WebView2 runtime was found, and which version.
pub fn write_startup_failure_note(runtime: &str) {
    if let Some(dir) = note_dir() {
        write_note(&dir, &startup_failure_note_text(UtcTime::now(), runtime));
    }
}

fn startup_failure_note_text(at: Option<UtcTime>, runtime: &str) -> String {
    note_text(
        "engine",
        at,
        &[
            ("process", "engine"),
            ("reason", "could not be created at startup"),
            ("runtime", truncate_chars(runtime, MAX_MESSAGE_CHARS)),
            ("restarted", "no (the display engine could not start)"),
        ],
    )
}

/// The previous run's note (once) and this run's page reloads.
#[tauri::command]
pub async fn take_crash_notes(notes: tauri::State<'_, Notes>) -> Result<Vec<CrashNote>> {
    let mut out: Vec<CrashNote> = note_dir().and_then(|d| take_file_note(&d)).into_iter().collect();
    out.extend(notes.drain());
    Ok(out)
}

/* --------------------------- Windows: faults --------------------------- */

#[cfg(windows)]
mod fault {
    //! The unhandled-exception filter. It runs on the faulting thread, maybe
    //! on an overflowed stack (std's stack-overflow handler passes the
    //! exception on), maybe with a corrupt heap: so no allocation, ~2 KiB of
    //! stack, Win32 calls only. A Rust panic never gets here — the abort is a
    //! `__fastfail`, which no filter sees; the panic hook covers it.

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HMODULE, INVALID_HANDLE_VALUE, SYSTEMTIME};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, WriteFile, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetUnhandledExceptionFilter, EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS, LPTOP_LEVEL_EXCEPTION_FILTER,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemTime;

    use super::{format_fault_note, UtcTime, FAULT_NOTE_MAX, NOTE};

    /// Whatever filter was there before ours; it still runs after the note.
    static PREVIOUS: OnceLock<LPTOP_LEVEL_EXCEPTION_FILTER> = OnceLock::new();
    /// One note per process: a fault inside the filter must not re-enter it.
    static ENTERED: AtomicBool = AtomicBool::new(false);

    pub(super) fn install() {
        // SAFETY: registers a plain function; nothing else is touched.
        let previous = unsafe { SetUnhandledExceptionFilter(Some(on_unhandled)) };
        let _ = PREVIOUS.set(previous);
    }

    unsafe extern "system" fn on_unhandled(info: *const EXCEPTION_POINTERS) -> i32 {
        if !ENTERED.swap(true, Ordering::SeqCst) {
            // SAFETY: `info` is the system's, valid for this call (checked for null).
            unsafe { record(info) };
        }
        match PREVIOUS.get().copied().flatten() {
            // SAFETY: the filter the system held before ours, called as it would have been.
            Some(previous) => unsafe { previous(info) },
            // Let Windows Error Reporting record the crash as usual.
            None => EXCEPTION_CONTINUE_SEARCH,
        }
    }

    unsafe fn record(info: *const EXCEPTION_POINTERS) {
        let Some(paths) = NOTE.get() else { return };
        // SAFETY: both pointers come from the system and are null-checked.
        let (code, address) = match unsafe { info.as_ref().and_then(|i| i.ExceptionRecord.as_ref()) } {
            Some(r) => (r.ExceptionCode as u32, r.ExceptionAddress as usize),
            None => (0, 0),
        };
        let mut name = [0u16; 512];
        // SAFETY: `name` outlives the returned slice.
        let module = unsafe { module_at(address, &mut name) };
        // SAFETY: fills the struct it is handed.
        let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetSystemTime(&mut st) };
        let at = UtcTime {
            year: st.wYear,
            month: st.wMonth,
            day: st.wDay,
            hour: st.wHour,
            minute: st.wMinute,
            second: st.wSecond,
        };
        let mut text = [0u8; FAULT_NOTE_MAX];
        let n = match module {
            Some((file, base)) => format_fault_note(code, Some(file), address.wrapping_sub(base), Some(at), &mut text),
            None => format_fault_note(code, None, address, Some(at), &mut text),
        };
        if let Some(bytes) = text.get(..n) {
            // SAFETY: both paths are NUL-terminated (NotePaths::new).
            unsafe { write_raw(&paths.dir_w, &paths.file_w, bytes) };
        }
    }

    /// The file name of the module holding `address`, and that module's base.
    unsafe fn module_at(address: usize, name: &mut [u16]) -> Option<(&[u16], usize)> {
        if address == 0 {
            return None;
        }
        let mut module: HMODULE = std::ptr::null_mut();
        // SAFETY: FROM_ADDRESS reads the "name" as an address inside a module;
        // UNCHANGED_REFCOUNT takes no reference, so there is nothing to free.
        let ok = unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                address as *const u16,
                &mut module,
            )
        };
        if ok == 0 || module.is_null() {
            return None;
        }
        // SAFETY: writes at most `name.len()` units into `name`.
        let len = unsafe { GetModuleFileNameW(module, name.as_mut_ptr(), name.len() as u32) } as usize;
        let full = name.get(..len.min(name.len()))?;
        let start = full
            .iter()
            .rposition(|&c| c == u16::from(b'\\') || c == u16::from(b'/'))
            .map_or(0, |i| i + 1);
        let file = full.get(start..).filter(|f| !f.is_empty())?;
        Some((file, module as usize))
    }

    unsafe fn write_raw(dir: &[u16], file: &[u16], bytes: &[u8]) {
        // SAFETY: NUL-terminated wide paths; the handle is checked and closed.
        unsafe {
            // Normally there already (the cache lives beside it); harmless if so.
            CreateDirectoryW(dir.as_ptr(), std::ptr::null());
            let h = CreateFileW(
                file.as_ptr(),
                GENERIC_WRITE,
                0,
                std::ptr::null(),
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            );
            if h == INVALID_HANDLE_VALUE || h.is_null() {
                return;
            }
            let mut written = 0u32;
            WriteFile(h, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut());
            CloseHandle(h);
        }
    }
}

/* ---------------------- Windows: the page process ---------------------- */

/// Watch the main window's WebView2 for a dead page or engine (see the module
/// doc). Called once from `.setup()`. A failure to arm is logged, never fatal:
/// the app then simply behaves as it did before.
#[cfg(windows)]
pub fn watch_webview(win: &tauri::WebviewWindow) {
    use tauri::Manager;
    let app = win.app_handle().clone();
    if let Err(e) = win.with_webview(move |pw| page::arm(app, pw.controller())) {
        eprintln!("Taroting: page recovery not armed ({e})");
    }
}

#[cfg(not(windows))]
pub fn watch_webview(_win: &tauri::WebviewWindow) {}

/// A WebView2 ProcessFailed reason as words, for the note.
#[cfg_attr(not(windows), allow(dead_code))]
fn reason_name(reason: i32) -> &'static str {
    match reason {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch failed",
        5 => "out of memory",
        6 => "profile deleted",
        _ => "unknown",
    }
}

#[cfg(windows)]
mod page {
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller, ICoreWebView2ProcessFailedEventArgs,
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows::core::Interface;

    use super::{
        engine_restart_allowed, note_dir, note_text, previous_note, reason_name, take_reload, write_note, CrashNote,
        Notes, UtcTime,
    };

    /// Runs on the UI thread (inside `with_webview`).
    pub(super) fn arm(app: AppHandle, controller: ICoreWebView2Controller) {
        // SAFETY: plain COM calls on the UI thread that owns the controller.
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(e) => {
                eprintln!("Taroting: page recovery not armed ({e})");
                return;
            }
        };
        let mut watch = Watch { app, started: Instant::now(), reloads: Vec::new() };
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            watch.on_failed(sender, args);
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: as above; the token is never needed (the watch lives as long as the page).
        if let Err(e) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
            eprintln!("Taroting: page recovery not armed ({e})");
        }
    }

    struct Watch {
        app: AppHandle,
        started: Instant,
        reloads: Vec<Duration>,
    }

    impl Watch {
        /// Never panics: every COM error is ignored or logged.
        fn on_failed(&mut self, sender: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>) {
            let Some(args) = args else { return };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            // SAFETY: COM getter into a local.
            if unsafe { args.ProcessFailedKind(&mut kind) }.is_err() {
                return;
            }
            // Unresponsive, GPU, utility and frame processes recover on their
            // own (or are not ours to restart): ignored.
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                self.on_page_exit(sender, &args);
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                on_engine_exit(&self.app, &args);
            }
        }

        fn on_page_exit(&mut self, sender: Option<ICoreWebView2>, args: &ICoreWebView2ProcessFailedEventArgs) {
            if !take_reload(&mut self.reloads, self.started.elapsed()) {
                eprintln!("Taroting: the page stopped again; not reloading it a fourth time in two minutes");
                return;
            }
            let (reason, exit) = details(args);
            let at = UtcTime::now();
            let detail = note_text("page", at, &[("process", "page"), ("reason", reason), ("exit code", &exit)]);
            if let Some(notes) = self.app.try_state::<Notes>() {
                notes.push(CrashNote { kind: "page", at: at.map(|t| t.to_string()), detail });
            }
            if let Some(webview) = sender {
                // SAFETY: COM call on the UI thread that raised the event.
                if let Err(e) = unsafe { webview.Reload() } {
                    eprintln!("Taroting: page reload failed ({e})");
                }
            }
        }
    }

    /// The whole engine is gone, and the window with it. Write the note, then
    /// restart from ANOTHER thread: off the main thread `AppHandle::restart`
    /// asks the event loop to exit and the new process is spawned only after
    /// `RunEvent::Exit` has reached every plugin — tauri-plugin-single-instance
    /// releases and closes its mutex there — so the new process becomes the
    /// primary instance instead of forwarding itself to this dying one. (On
    /// the main thread `restart` would skip those events and spawn at once.)
    fn on_engine_exit(app: &AppHandle, args: &ICoreWebView2ProcessFailedEventArgs) {
        // No main window: the app is already closing, nothing to recover.
        if app.get_webview_window("main").is_none() {
            return;
        }
        let Some(dir) = note_dir() else { return };
        // Read BEFORE writing ours, which replaces last-crash.txt.
        let allowed = engine_restart_allowed(previous_note(&dir));
        let (reason, exit) = details(args);
        let restart = if allowed { "yes" } else { "no (the engine also stopped less than a minute earlier)" };
        let text = note_text(
            "engine",
            UtcTime::now(),
            &[("process", "engine"), ("reason", reason), ("exit code", &exit), ("restarted", restart)],
        );
        write_note(&dir, &text);
        if !allowed {
            return;
        }
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("taroting-restart".into())
            .spawn(move || {
                app.restart();
            });
        if let Err(e) = spawned {
            eprintln!("Taroting: could not restart after the engine stopped ({e})");
        }
    }

    /// Reason and exit code, when this runtime reports them (Args2).
    fn details(args: &ICoreWebView2ProcessFailedEventArgs) -> (&'static str, String) {
        let Ok(args) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() else {
            return ("unknown", "unknown".to_owned());
        };
        let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        // SAFETY: COM getters into locals.
        let reason = if unsafe { args.Reason(&mut reason) }.is_ok() { reason_name(reason.0) } else { "unknown" };
        let mut code = 0i32;
        let exit = if unsafe { args.ExitCode(&mut code) }.is_ok() {
            format!("0x{:08X}", code as u32)
        } else {
            "unknown".to_owned()
        };
        (reason, exit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("taroting-crash-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const AT: UtcTime = UtcTime { year: 2026, month: 9, day: 30, hour: 21, minute: 4, second: 17 };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /* ---- message truncation ---- */

    #[test]
    fn a_long_message_is_cut_to_2000_chars_on_a_char_boundary() {
        // 3-byte chars: char 2000 starts at byte 6000, and byte 2000 is
        // mid-character — a byte-count cut would panic or split one.
        let msg = "€".repeat(2600);
        let cut = truncate_chars(&msg, MAX_MESSAGE_CHARS);
        assert_eq!(cut.chars().count(), 2000);
        assert_eq!(cut.len(), 6000);
        assert!(msg.starts_with(cut));
        // a mix: ASCII then a 4-byte char exactly at the limit
        let mixed = format!("{}🎬tail", "a".repeat(1999));
        let cut = truncate_chars(&mixed, MAX_MESSAGE_CHARS);
        assert_eq!(cut, format!("{}🎬", "a".repeat(1999)));
        // short text is untouched
        assert_eq!(truncate_chars("index 9 out of range", MAX_MESSAGE_CHARS), "index 9 out of range");
    }

    /* ---- location sanitising ---- */

    #[test]
    fn a_registry_location_loses_everything_before_the_crate() {
        let loc = r"C:\Users\Dana Okafor\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\tauri-2.11.5\src\app.rs";
        assert_eq!(sanitize_location(loc), r"tauri-2.11.5\src\app.rs");
        // forward slashes, a different CARGO_HOME, a different index dir
        let loc = "/home/builder/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde_json-1.0.140/src/de.rs";
        assert_eq!(sanitize_location(loc), "serde_json-1.0.140/src/de.rs");
        // mixed separators, as Windows sometimes reports them
        let loc = r"D:\cargo-home/registry\src/github.com-1ecc6299db9ec823\wry-0.55.1\src\webview2\mod.rs";
        assert_eq!(sanitize_location(loc), r"wry-0.55.1\src\webview2\mod.rs");
    }

    #[test]
    fn a_git_checkout_location_keeps_only_the_checkout() {
        let loc = r"C:\Users\Mo\.cargo\git\checkouts\tao-3c9b1f7e2a\4d5e6f7\src\platform_impl\windows\event_loop.rs";
        assert_eq!(sanitize_location(loc), r"tao-3c9b1f7e2a\4d5e6f7\src\platform_impl\windows\event_loop.rs");
    }

    #[test]
    fn our_own_relative_location_is_unchanged() {
        assert_eq!(sanitize_location(r"src\media\probe.rs"), r"src\media\probe.rs");
        assert_eq!(sanitize_location("src/export/builder.rs"), "src/export/builder.rs");
        // std's own paths carry no account name and stay as they are
        let std_loc = "/rustc/31fca3adb2/library/core/src/slice/index.rs";
        assert_eq!(sanitize_location(std_loc), std_loc);
    }

    #[test]
    fn any_other_profile_path_loses_only_the_account_name() {
        assert_eq!(
            sanitize_location(r"E:\Users\Jane Q\vendor\ffi-glue\src\lib.rs"),
            r"E:\Users\<user>\vendor\ffi-glue\src\lib.rs"
        );
        assert_eq!(sanitize_location("/home/sam/work/glue/src/x.rs"), "/home/<user>/work/glue/src/x.rs");
        // a relative path that merely contains a "users" folder is not a profile
        assert_eq!(sanitize_location(r"src\users\list.rs"), r"src\users\list.rs");
    }

    /* ---- the fault note ---- */

    #[test]
    fn the_fault_note_carries_code_module_offset_and_time_exactly() {
        let mut out = [0u8; FAULT_NOTE_MAX];
        let n = format_fault_note(0xC000_0005, Some(&wide("avcodec-61.dll")), 0x1A_2B3C, Some(AT), &mut out);
        let text = std::str::from_utf8(&out[..n]).unwrap();
        assert_eq!(
            text,
            format!(
                "Taroting {VERSION}\ntime: 2026-09-30T21:04:17Z\nkind: fault\ncode: 0xC0000005\nmodule: avcodec-61.dll+0x1A2B3C\n"
            )
        );
        // the page reads it back as a fault at that time
        assert_eq!(parse_head(text), ("fault", Some("2026-09-30T21:04:17Z".to_owned())));
    }

    #[test]
    fn a_small_code_is_zero_padded_and_an_unknown_module_gives_the_address() {
        let mut out = [0u8; FAULT_NOTE_MAX];
        let at = UtcTime { year: 2031, month: 1, day: 2, hour: 3, minute: 5, second: 8 };
        let n = format_fault_note(0x8000_0003, None, 0x7FF6_1234_ABCD, Some(at), &mut out);
        let text = std::str::from_utf8(&out[..n]).unwrap();
        assert!(text.contains("time: 2031-01-02T03:05:08Z\n"), "{text}");
        assert!(text.contains("code: 0x80000003\n"), "{text}");
        assert!(text.ends_with("module: unknown\naddress: 0x7FF61234ABCD\n"), "{text}");
        let n = format_fault_note(0x0000_00FD, None, 0, None, &mut out);
        let text = std::str::from_utf8(&out[..n]).unwrap();
        assert!(text.contains("time: unknown\n") && text.contains("code: 0x000000FD\n"), "{text}");
    }

    #[test]
    fn a_non_ascii_module_name_becomes_question_marks() {
        let mut out = [0u8; FAULT_NOTE_MAX];
        // "é" is one UTF-16 unit, "𝄞" two (a surrogate pair), a tab is a control
        let n = format_fault_note(0xC000_0409, Some(&wide("caf\u{e9}\t\u{1D11E}.dll")), 0x40, Some(AT), &mut out);
        let text = std::str::from_utf8(&out[..n]).unwrap();
        assert!(text.contains("module: caf????.dll+0x40\n"), "{text}");
        assert!(text.is_ascii());
    }

    #[test]
    fn the_fault_note_never_writes_past_its_buffer() {
        let long = wide(&"x".repeat(5000));
        for size in [0usize, 1, 17, 64, 100, FAULT_NOTE_MAX] {
            let mut out = vec![0xAAu8; size + 8];
            let (buf, guard) = out.split_at_mut(size);
            let n = format_fault_note(0xC000_0005, Some(&long), 0x10, Some(AT), buf);
            assert!(n <= size, "wrote {n} into {size}");
            assert!(guard.iter().all(|&b| b == 0xAA), "wrote past {size}");
        }
        // a long name fills the 1 KiB note exactly, cut mid-name
        let mut out = [0u8; FAULT_NOTE_MAX];
        assert_eq!(format_fault_note(1, Some(&long), 2, Some(AT), &mut out), FAULT_NOTE_MAX);
    }

    /* ---- notes on disk ---- */

    #[test]
    fn a_note_is_handed_over_once_then_kept_as_seen() {
        let dir = scratch("take");
        let text = panic_note_text(Some(AT), "main", r"tauri-2.11.5\src\app.rs:612:9", "kind: engine\nboom");
        write_note(&dir, &text);
        // an older .seen is replaced, not kept beside it
        std::fs::write(dir.join(SEEN_FILE), "Taroting 0.8.1\ntime: unknown\nkind: fault\n").unwrap();

        let note = take_file_note(&dir).expect("the note");
        assert_eq!(note.kind, "panic", "the message's `kind: engine` must not change the kind");
        assert_eq!(note.at.as_deref(), Some("2026-09-30T21:04:17Z"));
        assert_eq!(note.detail, text);
        assert!(note.detail.contains("message: kind: engine\nboom"));
        assert!(!dir.join(NOTE_FILE).exists(), "the note was not moved");
        assert_eq!(std::fs::read_to_string(dir.join(SEEN_FILE)).unwrap(), text);

        assert_eq!(take_file_note(&dir), None, "a second take showed the note again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_note_that_cannot_become_seen_is_deleted_rather_than_shown_forever() {
        let dir = scratch("unrenamable");
        // a FOLDER where .seen would go: the rename must fail
        std::fs::create_dir_all(dir.join(SEEN_FILE)).unwrap();
        write_note(&dir, &note_text("engine", None, &[("reason", "crashed")]));
        let note = take_file_note(&dir).expect("the note");
        assert_eq!((note.kind, note.at.as_deref()), ("engine", None));
        assert!(!dir.join(NOTE_FILE).exists());
        assert_eq!(take_file_note(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_note_and_an_empty_note() {
        let dir = scratch("empty");
        assert_eq!(take_file_note(&dir), None);
        std::fs::write(dir.join(NOTE_FILE), b"").unwrap();
        let note = take_file_note(&dir).expect("an empty note is still a crash");
        assert_eq!(note.kind, "panic");
        assert!(note.detail.contains("empty"), "{}", note.detail);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_command_returns_the_file_note_then_this_runs_page_notes() {
        // take_crash_notes = take_file_note + Notes::drain, in that order
        let notes = Notes::default();
        let page = CrashNote { kind: "page", at: None, detail: "kind: page".into() };
        notes.push(page.clone());
        assert_eq!(notes.drain(), vec![page]);
        assert_eq!(notes.drain(), vec![], "page notes are shown once");
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let note = CrashNote { kind: "fault", at: Some("2026-09-30T21:04:17Z".into()), detail: "d".into() };
        assert_eq!(
            serde_json::to_value(&note).unwrap(),
            serde_json::json!({ "kind": "fault", "at": "2026-09-30T21:04:17Z", "detail": "d" })
        );
    }

    #[test]
    fn a_synthetic_note_refuses_an_unknown_kind() {
        assert!(matches!(write_synthetic_note("page", "x"), Err(AppError::BadInput(_))));
    }

    /// The startup-failure note must come back as an ENGINE note whose
    /// `restarted:` line starts a line with "no" — the frontend picks its
    /// "so Taroting closed" title with `/^restarted: no\b/m`, and anything
    /// else would tell the user the app restarted when it did not. The
    /// runtime line carries the one diagnostic there is.
    #[test]
    fn a_startup_failure_note_reads_as_an_engine_that_did_not_restart() {
        let dir = scratch("startup");
        write_note(&dir, &startup_failure_note_text(Some(AT), "not found (WebView2 error)"));
        let note = take_file_note(&dir).expect("the note");
        assert_eq!(note.kind, "engine");
        assert_eq!(note.at.as_deref(), Some("2026-09-30T21:04:17Z"));
        assert!(
            note.detail.lines().any(|l| l.starts_with("restarted: no ")),
            "no `restarted: no` line in {:?}",
            note.detail
        );
        assert!(note.detail.contains("\nruntime: not found (WebView2 error)\n"), "{}", note.detail);
        assert!(note.detail.contains("\nreason: could not be created at startup\n"), "{}", note.detail);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- recovery decisions ---- */

    #[test]
    fn three_reloads_in_two_minutes_then_none_until_the_window_moves() {
        let s = Duration::from_secs;
        let mut h = Vec::new();
        assert!(take_reload(&mut h, s(5)));
        assert!(take_reload(&mut h, s(47)));
        assert!(take_reload(&mut h, s(118)));
        // the 4th: all three are within 120 s of 119
        assert!(!take_reload(&mut h, s(119)));
        assert_eq!(h, vec![s(5), s(47), s(118)], "a refused reload must not be recorded");
        // 124 - 5 = 119 < 120: still refused
        assert!(!take_reload(&mut h, s(124)));
        // 126 - 5 = 121: the first one has left the window
        assert!(take_reload(&mut h, s(126)));
        assert_eq!(h, vec![s(47), s(118), s(126)]);
    }

    #[test]
    fn a_young_engine_note_stops_a_restart_and_nothing_else_does() {
        let s = Duration::from_secs;
        assert!(!engine_restart_allowed(Some(("engine", s(12)))));
        assert!(!engine_restart_allowed(Some(("engine", Duration::ZERO))));
        assert!(engine_restart_allowed(Some(("engine", s(60)))));
        assert!(engine_restart_allowed(Some(("engine", s(3600)))));
        assert!(engine_restart_allowed(Some(("panic", s(12)))));
        assert!(engine_restart_allowed(Some(("fault", s(1)))));
        assert!(engine_restart_allowed(None));
    }

    #[test]
    fn the_previous_note_is_the_newest_file_seen_or_not() {
        use std::fs::File;
        let dir = scratch("previous");
        let now = SystemTime::now();
        let s = Duration::from_secs;
        let set_age = |name: &str, age: Duration| {
            File::options().write(true).open(dir.join(name)).unwrap().set_modified(now - age).unwrap();
        };
        assert_eq!(previous_note(&dir), None);

        // an engine note already shown 20 s ago, an older unshown panic note
        std::fs::write(dir.join(SEEN_FILE), note_text("engine", Some(AT), &[])).unwrap();
        std::fs::write(dir.join(NOTE_FILE), note_text("panic", Some(AT), &[])).unwrap();
        set_age(SEEN_FILE, s(20));
        set_age(NOTE_FILE, s(300));
        let (kind, age) = previous_note(&dir).unwrap();
        assert_eq!(kind, "engine");
        assert!(age >= s(19) && age < s(60), "age {age:?}");
        assert!(!engine_restart_allowed(Some((kind, age))));

        // the same engine note, 90 s old: a restart is allowed again
        set_age(SEEN_FILE, s(90));
        let (kind, age) = previous_note(&dir).unwrap();
        assert_eq!(kind, "engine");
        assert!(engine_restart_allowed(Some((kind, age))));

        // the panic note is the newer one now: not a loop
        set_age(NOTE_FILE, s(10));
        assert_eq!(previous_note(&dir).map(|(k, _)| k), Some("panic"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn process_failed_reasons_have_words() {
        assert_eq!(reason_name(3), "crashed");
        assert_eq!(reason_name(2), "terminated");
        assert_eq!(reason_name(5), "out of memory");
        assert_eq!(reason_name(41), "unknown");
    }
}
