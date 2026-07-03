//! OS integration: first-launch file-open capture and the app-triggered
//! uninstall entry. All zero-cost when unused; no new crates (the registry is
//! read by spawning `reg query` and parsing stdout).

use std::path::Path;
use std::sync::Mutex;

use crate::error::{AppError, Result};

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
        if Path::new(path).is_file() {
            if let Ok(mut q) = self.0.lock() {
                q.push(path.to_string());
            }
        }
    }
}

/// Called from `main()` before the frontend boots. Records argv[1] into the
/// open-path queue iff it is an existing file. Second-instance launches are
/// handled by the single-instance plugin's callback, which pushes into the same
/// queue.
pub fn capture_launch_arg(queue: &OpenPathQueue) {
    if let Some(arg) = std::env::args().nth(1) {
        queue.push_if_file(&arg);
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

/// Uninstall Taroting: locate the NSIS uninstall entry in the current-user
/// registry, spawn its (quiet) uninstall string detached, then exit the app so
/// the uninstaller can replace the running exe.
#[tauri::command]
pub fn uninstall_app() -> Result<()> {
    let cmd = find_uninstall_string()
        .ok_or_else(|| AppError::BadInput("not installed".into()))?;

    // Spawn detached via cmd's `start` so the uninstaller outlives this process.
    // The uninstall string is itself a full command line (path + args); build one
    // raw command line for cmd so nothing gets re-quoted. The empty "" title arg
    // stops `start` from treating a quoted exe path as the window title.
    let line = format!("/C start \"\" /B {cmd}");
    std::process::Command::new("cmd")
        .raw_arg_line(&line)
        .spawn()
        .map_err(AppError::Io)?;

    // Give the detached launcher a beat, then exit so the uninstaller can delete
    // our exe. exit(0) skips Drop but we hold no external resources needing it.
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

/// Enumerate HKCU uninstall subkeys and return the QuietUninstallString (falling
/// back to UninstallString) of the entry whose DisplayName is "Taroting".
fn find_uninstall_string() -> Option<String> {
    // `reg query "HKCU\..."` echoes subkeys with the EXPANDED hive name, so we
    // query with the short form but must match the expanded prefix below.
    let query_base = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall";
    let out = run_reg(&["query", query_base]).ok()?;
    for key in parse_uninstall_subkeys(&out) {
        // read DisplayName; match Taroting.
        if let Some(name) = reg_value(&key, "DisplayName") {
            if name == "Taroting" {
                return reg_value(&key, "QuietUninstallString")
                    .or_else(|| reg_value(&key, "UninstallString"));
            }
        }
    }
    None
}

/// The expanded prefix `reg query` prints for subkeys of the HKCU Uninstall key.
/// `reg` always echoes the full hive name (`HKEY_CURRENT_USER`), never `HKCU`.
const EXPANDED_UNINSTALL_PREFIX: &str =
    r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall";

/// Extract the child subkey paths from raw `reg query <Uninstall>` stdout.
///
/// `reg` prints a leading blank line, then one line per subkey using the
/// expanded hive name. We keep only lines that sit strictly BELOW the Uninstall
/// key (a `\` must follow the prefix), so the parent key header itself is
/// excluded. Matching is case-insensitive because registry paths are.
fn parse_uninstall_subkeys(out: &str) -> Vec<String> {
    let prefix_lower = EXPANDED_UNINSTALL_PREFIX.to_ascii_lowercase();
    let mut keys = Vec::new();
    for line in out.lines() {
        let key = line.trim();
        let key_lower = key.to_ascii_lowercase();
        // Must be a descendant: prefix followed by a separator + non-empty name.
        if let Some(rest) = key_lower.strip_prefix(&prefix_lower) {
            if rest.starts_with('\\') && rest.len() > 1 {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

/// Read a single REG_SZ value from a key, returning its data. Parses the
/// `reg query` line: `    ValueName    REG_SZ    the data...`.
fn reg_value(key: &str, name: &str) -> Option<String> {
    let out = run_reg(&["query", key, "/v", name]).ok()?;
    for line in out.lines() {
        let line = line.trim();
        if line.starts_with(name) {
            // Split on REG_SZ (or REG_EXPAND_SZ) and take the remainder.
            if let Some(idx) = line.find("REG_") {
                let rest = &line[idx..];
                if let Some(sp) = rest.find(char::is_whitespace) {
                    let data = rest[sp..].trim();
                    if !data.is_empty() {
                        return Some(data.to_string());
                    }
                }
            }
        }
    }
    None
}

fn run_reg(args: &[&str]) -> std::io::Result<String> {
    let output = std::process::Command::new("reg").args(args).output()?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// Windows-only extension: pass an already-formed command line to cmd without
// re-quoting. std::process on Windows lets us append a raw arg line.
trait RawArgLine {
    fn raw_arg_line(&mut self, line: &str) -> &mut Self;
}

impl RawArgLine for std::process::Command {
    fn raw_arg_line(&mut self, line: &str) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.raw_arg(line);
        }
        #[cfg(not(windows))]
        {
            self.arg(line);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_subkeys_uses_expanded_prefix() {
        // Representative captured `reg query` output: a leading blank line, then
        // one expanded-prefix line per subkey. The parent key header (bare
        // Uninstall path, no trailing name) must be excluded.
        let raw = "\r\n\
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\r\n\
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Discord\r\n\
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Taroting\r\n\
\r\n\
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1\r\n";
        let keys = parse_uninstall_subkeys(raw);
        assert_eq!(
            keys,
            vec![
                r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Discord",
                r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Taroting",
                r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1",
            ]
        );
    }

    #[test]
    fn parse_subkeys_is_case_insensitive_and_skips_hkcu_short_form() {
        // Real `reg` output never uses the short "HKCU" form, but a case-varied
        // expanded prefix must still match; unrelated hives must not.
        let raw = "\r\n\
hkey_current_user\\software\\microsoft\\windows\\currentversion\\uninstall\\Taroting\r\n\
HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other\r\n\
HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ShortForm\r\n";
        let keys = parse_uninstall_subkeys(raw);
        assert_eq!(keys.len(), 1);
        assert!(keys[0].to_ascii_lowercase().ends_with("uninstall\\taroting"));
    }
}
