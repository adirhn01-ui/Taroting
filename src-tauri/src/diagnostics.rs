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

/// Milliseconds since the Unix epoch, now.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// A UTC time (epoch milliseconds) as a filename-safe stamp, e.g.
/// `20260728-140501-042Z`. Fixed width, so name order stays age order for
/// `prune`. Milliseconds because two saves in one second (a double-click on
/// Save report) used to get the same name, and the second overwrote the first.
/// (`project::store::now_iso8601` is the ISO form; its colons are illegal in a
/// Windows filename, so this variant is separate by necessity.)
fn utc_stamp(millis: u64) -> String {
    let ms = millis % 1000;
    let secs = millis / 1000;
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
    format!("{year:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}-{ms:03}Z")
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

/// A name already taken moves the stamp on by this many milliseconds, at most.
const NAME_TRIES: u64 = 1000;

/// Write one report into `dir` and prune. Split out from the command so it is
/// testable without writing into the real user profile.
fn write_report(dir: &Path, content: &str) -> Result<String> {
    write_report_at(dir, content, now_millis())
}

/// [`write_report`] at a given time, so a test can make two saves collide.
///
/// The file is created with `create_new`, never truncated: a name that is
/// already there (a second save in the same millisecond, or a clock set back)
/// moves the stamp on by one millisecond rather than overwriting a report. A
/// later stamp, not a "-2" suffix: the suffix would sort before the original
/// and break name-order-is-age-order.
fn write_report_at(dir: &Path, content: &str, millis: u64) -> Result<String> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    for step in 0..NAME_TRIES {
        let path = dir.join(format!("{PREFIX}{}{SUFFIX}", utc_stamp(millis.saturating_add(step))));
        let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        if let Err(e) = file.write_all(capped(content).as_bytes()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(e.into());
        }
        drop(file);
        prune(dir);
        return Ok(path.to_string_lossy().into_owned());
    }
    Err(AppError::BadInput("no free name for the diagnostic report".into()))
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
        let s = utc_stamp(now_millis());
        assert_eq!(s.len(), 20, "unexpected stamp: {s}");
        assert!(s.ends_with('Z'));
        assert!(
            !s.contains(':') && !s.contains('/') && !s.contains('\\'),
            "stamp is not filename safe: {s}"
        );
        let year: i64 = s[0..4].parse().unwrap();
        assert!((2024..3000).contains(&year), "implausible year: {year}");
        // 2026-07-28 14:05:01.042 UTC, then the carries: a millisecond into
        // the next second, a second into the next day.
        assert_eq!(utc_stamp(1_785_247_501_042), "20260728-140501-042Z");
        assert_eq!(utc_stamp(1_785_247_501_999), "20260728-140501-999Z");
        assert_eq!(utc_stamp(1_785_247_502_000), "20260728-140502-000Z");
        assert_eq!(utc_stamp(1_785_283_199_999), "20260728-235959-999Z");
        assert_eq!(utc_stamp(1_785_283_200_000), "20260729-000000-000Z");
        // fixed width: lexicographic order == chronological order
        let times = [1_785_247_501_009, 1_785_247_501_010, 1_785_247_501_999, 1_785_247_502_000];
        let stamps: Vec<String> = times.iter().map(|&t| utc_stamp(t)).collect();
        assert!(stamps.windows(2).all(|w| w[0] < w[1]), "{stamps:?}");
    }

    /// Two saves at the SAME millisecond (the double-click case, forced): two
    /// files, both contents intact, the second one millisecond later so name
    /// order stays age order. With a truncating write the second save
    /// replaced the first report.
    #[test]
    fn two_saves_in_the_same_millisecond_keep_both_reports() {
        let dir = scratch("collide");
        let at = 1_785_247_501_999; // the bump must carry into the next second
        let first = write_report_at(&dir, "first report", at).unwrap();
        let second = write_report_at(&dir, "second report", at).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first report");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "second report");
        assert!(first.ends_with(&format!("{PREFIX}20260728-140501-999Z{SUFFIX}")), "{first}");
        assert!(second.ends_with(&format!("{PREFIX}20260728-140502-000Z{SUFFIX}")), "{second}");
        let _ = std::fs::remove_dir_all(&dir);
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
