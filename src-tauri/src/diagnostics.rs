//! Saving a diagnostic report to disk.
//!
//! Deliberately a FIXED app-owned directory
//! (`%LOCALAPPDATA%\Taroting\diagnostics`) and not an arbitrary-path write
//! command: handing the webview a general fs-write primitive would be a far
//! larger attack surface than this feature is worth. The caller supplies only
//! the text.

use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::paths;

/// Reports larger than this are truncated — a diagnostic report is a page of
/// text, and nothing good comes of letting the webview stream megabytes to disk.
const MAX_BYTES: usize = 1024 * 1024;

/// Newest N reports kept; older ones are pruned on every save.
const KEEP: usize = 10;

const PREFIX: &str = "taroting-report-";
const SUFFIX: &str = ".txt";

/// Current UTC time as a filename-safe stamp, e.g. `20260728-140501Z`.
/// (`project::store::now_iso8601` is the ISO form; its colons are illegal in a
/// Windows filename, so this variant is separate by necessity.)
fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    // civil-from-days (Howard Hinnant), epoch shifted to 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}Z")
}

/// Truncate to at most `MAX_BYTES`, never mid-character (validate before you
/// slice — a multi-byte char straddling the cap would panic).
fn capped(content: &str) -> &str {
    if content.len() <= MAX_BYTES {
        return content;
    }
    let mut end = MAX_BYTES;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    &content[..end]
}

/// Delete all but the newest `KEEP` reports. The stamp sorts lexicographically
/// in chronological order, so name order IS age order (no mtime dependency).
fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut names: Vec<String> = read
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(PREFIX) && n.ends_with(SUFFIX))
        .collect();
    if names.len() <= KEEP {
        return;
    }
    names.sort_unstable_by(|a, b| b.cmp(a)); // newest first
    for stale in &names[KEEP..] {
        let _ = std::fs::remove_file(dir.join(stale));
    }
}

/// Write one report into `dir` and prune. Split out from the command so it is
/// testable without writing into the real user profile.
fn write_report(dir: &Path, content: &str) -> Result<String> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{PREFIX}{}{SUFFIX}", utc_stamp()));
    std::fs::write(&path, capped(content).as_bytes())?;
    prune(dir);
    Ok(path.to_string_lossy().into_owned())
}

/// `%LOCALAPPDATA%\Taroting\diagnostics`, derived from the cache dir's parent so
/// the app-root location stays defined in exactly one place (`paths.rs`).
fn diagnostics_dir() -> Result<PathBuf> {
    let cache = paths::cache_dir()?;
    let root = cache
        .parent()
        .ok_or_else(|| AppError::BadInput("cache directory has no parent".into()))?;
    Ok(root.join("diagnostics"))
}

/// Save a diagnostic report and return the path it was written to.
#[tauri::command]
pub fn save_diagnostic_report(content: String) -> Result<String> {
    write_report(&diagnostics_dir()?, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("taroting-diag-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn utc_stamp_is_filename_safe_and_sorts_chronologically() {
        let s = utc_stamp();
        assert_eq!(s.len(), 16, "unexpected stamp: {s}");
        assert!(s.ends_with('Z'));
        assert!(
            !s.contains(':') && !s.contains('/') && !s.contains('\\'),
            "stamp is not filename safe: {s}"
        );
        let year: i64 = s[0..4].parse().unwrap();
        assert!((2024..3000).contains(&year), "implausible year: {year}");
        // lexicographic order == chronological order
        assert!("20260728-140501Z" < "20260728-140502Z");
        assert!("20260728-235959Z" < "20260729-000000Z");
    }

    #[test]
    fn content_is_capped_at_one_megabyte_on_a_char_boundary() {
        // 3-byte chars straddle the cap: a byte-index slice would panic.
        let big = "€".repeat(MAX_BYTES);
        let out = capped(&big);
        assert!(out.len() <= MAX_BYTES);
        assert!(out.len() > MAX_BYTES - 4, "truncated too aggressively");
        assert!(big.starts_with(out));
        // small content is returned untouched
        assert_eq!(capped("hello"), "hello");
    }

    #[test]
    fn save_writes_into_the_app_owned_dir_and_returns_its_path() {
        let dir = scratch("write");
        let path = write_report(&dir, "argv: <out.mp4>").unwrap();
        let pb = PathBuf::from(&path);
        assert!(pb.is_file(), "report not written at {path}");
        assert_eq!(pb.parent().unwrap(), dir.as_path());
        let name = pb.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(PREFIX) && name.ends_with(SUFFIX), "bad name: {name}");
        assert_eq!(std::fs::read_to_string(&pb).unwrap(), "argv: <out.mp4>");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_only_the_newest_ten_reports() {
        let dir = scratch("prune");
        std::fs::create_dir_all(&dir).unwrap();
        for day in 1..=15 {
            std::fs::write(dir.join(format!("{PREFIX}202607{day:02}-000000Z{SUFFIX}")), b"x")
                .unwrap();
        }
        // an unrelated file must survive the prune
        std::fs::write(dir.join("notes.txt"), b"keep me").unwrap();
        prune(&dir);

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(PREFIX))
            .collect();
        left.sort();
        assert_eq!(left.len(), KEEP, "expected {KEEP} reports, got {left:?}");
        assert_eq!(left[0], format!("{PREFIX}20260706-000000Z{SUFFIX}"));
        assert_eq!(left[KEEP - 1], format!("{PREFIX}20260715-000000Z{SUFFIX}"));
        assert!(dir.join("notes.txt").is_file(), "unrelated file was deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
