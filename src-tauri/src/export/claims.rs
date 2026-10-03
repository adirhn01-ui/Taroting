//! The `<out>.part` names this app has claimed for an export, remembered on
//! disk so a later run can tell its own leftovers from anyone else's file.
//!
//! `claim_part` (export/mod.rs) takes `<out>.part` with `create_new` before an
//! export is queued, and refuses when the name is taken: the file in the way
//! may be someone else's (a browser download in progress). But it is just as
//! often our own, left by an export the app could not clean up after — a
//! crash, Task Manager, a power cut, the app closed while an export was still
//! queued — and nothing on disk tells the two apart. Before this list the
//! user had to find and delete that file by hand before exporting to the same
//! name again, right after the kind of crash that left it.
//!
//! So every claim is written down here (with the identity of the file it made)
//! and crossed off when its job is done with it. What is still listed
//! when the next run starts is a leftover: the startup sweep deletes it, and
//! a re-export that finds it first deletes it and claims the name again. A
//! `.part` that is not listed, or is listed but is no longer the file we
//! created, keeps the refusal. File size is never the test: a claim this run
//! just made is 0 bytes too, and so is a download that has just begun.
//!
//! `%LOCALAPPDATA%\Taroting\export-claims.json` (`paths::app_local_dir`,
//! redirected under autotest). Absent whenever nothing is claimed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[cfg_attr(test, allow(dead_code))]
const FILE: &str = "export-claims.json";

/// One claimed `.part`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Claim {
    path: PathBuf,
    /// The claimed file's identity (`file_identity`), so a file that replaced
    /// ours at the same name is not mistaken for it.
    id: String,
}

/// Every read-modify-write of the list, in this process.
static LIST: Mutex<()> = Mutex::new(());

/// The claims THIS run made and still holds. A listed name in here is a live
/// export's (queued or running), never a leftover, whatever the list says.
static LIVE: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where the list lives. The tests' own file is in the temp folder: they claim
/// `.part`s through the real `claim_part`, and must never write into the
/// owner's app data. One name for every run, so runs leave one file at most.
fn list_path() -> Option<PathBuf> {
    #[cfg(test)]
    {
        Some(std::env::temp_dir().join("taroting-export-claims-test.json"))
    }
    #[cfg(not(test))]
    {
        crate::paths::app_local_dir().ok().map(|d| d.join(FILE))
    }
}

fn read(list: &Path) -> Vec<Claim> {
    std::fs::read(list)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Replace the list: through a temporary file and a rename, so a crash mid-
/// write leaves the old list or the new one, never half of one. An empty list
/// is no file at all.
fn write(list: &Path, claims: &[Claim]) {
    if claims.is_empty() {
        let _ = std::fs::remove_file(list);
        return;
    }
    let Ok(bytes) = serde_json::to_vec(claims) else { return };
    if let Some(dir) = list.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = list.with_extension("json.tmp");
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, list).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Which file is at `path`: its volume and its file index on that volume,
/// which a new file at the same name never shares. Not the creation time:
/// NTFS "tunnels" it, so a file deleted and made again under the same name
/// within seconds inherits the old one's.
#[cfg(windows)]
fn file_identity(path: &Path) -> Option<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let file = std::fs::File::open(path).ok()?;
    // SAFETY: the handle is the open file's own, borrowed for this call, and
    // the struct is plain data the call fills.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }
    Some(format!(
        "{:08x}-{:08x}{:08x}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}

#[cfg(not(windows))]
fn file_identity(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    Some(format!("{:x}-{:x}", meta.dev(), meta.ino()))
}

/// Whether the file at `claim.path` is still the one we created.
fn still_ours(claim: &Claim, meta: &std::fs::Metadata) -> bool {
    meta.is_file() && file_identity(&claim.path).as_deref() == Some(claim.id.as_str())
}

/// Write down a claim `claim_part` has just made.
pub(super) fn record(part: &Path) {
    lock(&LIVE).insert(part.to_path_buf());
    if let Some(list) = list_path() {
        record_in(&list, part);
    }
}

fn record_in(list: &Path, part: &Path) {
    let Some(id) = file_identity(part) else { return };
    let _guard = lock(&LIST);
    let mut claims = read(list);
    claims.retain(|c| c.path != part);
    claims.push(Claim { path: part.to_path_buf(), id });
    write(list, &claims);
}

/// Cross a claim off: its job has published the file, deleted it, or kept it
/// as the user's (a finished encode that could not be renamed — from then on
/// it is theirs, and the refusal protects it).
pub(super) fn release(part: &Path) {
    lock(&LIVE).remove(part);
    if let Some(list) = list_path() {
        release_in(&list, part);
    }
}

fn release_in(list: &Path, part: &Path) {
    let _guard = lock(&LIST);
    let mut claims = read(list);
    let before = claims.len();
    claims.retain(|c| c.path != part);
    if claims.len() != before {
        write(list, &claims);
    }
}

/// Whether the file at `part` is a leftover of ours: an earlier run claimed
/// it, never released it, and it is still the very file that run created.
/// Never a claim this run holds.
pub(super) fn left_by_earlier_run(part: &Path) -> bool {
    if lock(&LIVE).contains(part) {
        return false;
    }
    list_path().is_some_and(|list| left_over_in(&list, part))
}

fn left_over_in(list: &Path, part: &Path) -> bool {
    let _guard = lock(&LIST);
    let Ok(meta) = std::fs::metadata(part) else { return false };
    read(list).iter().any(|c| c.path == part && still_ours(c, &meta))
}

/// Delete what earlier runs left claimed, on a thread of its own. Called from
/// `.setup()` in the PRIMARY instance only, after the autotest wipe: no export
/// of this run exists yet, so everything listed is a leftover.
pub fn sweep_stale_in_background() {
    let Some(list) = list_path() else { return };
    let started = SystemTime::now();
    let _ = std::thread::Builder::new()
        .name("taroting-claims-sweep".into())
        .spawn(move || {
            sweep_in(&list, started);
        });
}

/// Delete every listed `.part` that is still the file we created and is older
/// than `started`, and cross off every entry that is settled: deleted, gone,
/// or replaced by someone else's file (left alone). One that could not be
/// deleted (another program has it open) stays listed for next time. Returns
/// how many files went.
fn sweep_in(list: &Path, started: SystemTime) -> usize {
    let _guard = lock(&LIST);
    let live = lock(&LIVE).clone();
    let mut removed = 0;
    let mut keep = Vec::new();
    for claim in read(list) {
        if live.contains(&claim.path) {
            keep.push(claim);
            continue;
        }
        let Ok(meta) = std::fs::metadata(&claim.path) else { continue };
        if !still_ours(&claim, &meta) || meta.modified().map_or(true, |m| m >= started) {
            continue;
        }
        if std::fs::remove_file(&claim.path).is_ok() {
            removed += 1;
        } else {
            keep.push(claim);
        }
    }
    write(list, &keep);
    removed
}

/// Tests only: forget that this run holds `part`, as if the claim had been
/// made by a run that has since ended.
#[cfg(test)]
pub(super) fn as_if_from_an_earlier_run(part: &Path) {
    lock(&LIVE).remove(part);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn scratch(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("taroting claims {tag} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("claims.json");
        (dir, list)
    }

    /// A claim survives in the list until released; a released one is gone,
    /// and the last release removes the file itself.
    #[test]
    fn a_claim_is_listed_until_its_job_releases_it() {
        let (dir, list) = scratch("list");
        let a = dir.join("a.mp4.part");
        let b = dir.join("b.mp4.part");
        std::fs::write(&a, b"").unwrap();
        std::fs::write(&b, b"x").unwrap();
        record_in(&list, &a);
        record_in(&list, &b);
        assert!(left_over_in(&list, &a) && left_over_in(&list, &b));
        release_in(&list, &a);
        assert!(!left_over_in(&list, &a), "released, so no longer ours to delete");
        assert!(left_over_in(&list, &b));
        release_in(&list, &b);
        assert!(!list.exists(), "an empty list is no file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The startup sweep deletes a leftover that is still the file we made,
    /// and leaves alone a listed name now holding someone else's file (made
    /// after ours was deleted), an unlisted `.part`, and a file newer than the
    /// sweep's start. Every settled entry is crossed off.
    #[test]
    fn the_sweep_deletes_only_our_own_leftovers() {
        let (dir, list) = scratch("sweep");
        let ours = dir.join("ours.mp4.part");
        let replaced = dir.join("replaced.mp4.part");
        let stranger = dir.join("stranger.mp4.part");
        for p in [&ours, &replaced, &stranger] {
            std::fs::write(p, b"partial").unwrap();
        }
        record_in(&list, &ours);
        record_in(&list, &replaced);
        // Someone else's file at a listed name: ours was deleted, theirs is
        // a new file — made at once, so NTFS hands it our creation time.
        std::fs::remove_file(&replaced).unwrap();
        std::fs::write(&replaced, b"a download").unwrap();
        assert!(!left_over_in(&list, &replaced), "fixture: a new file is not ours");

        let started = SystemTime::now() + Duration::from_secs(1);
        assert_eq!(sweep_in(&list, started), 1);
        assert!(!ours.exists(), "our leftover must go");
        assert!(replaced.exists(), "a file that replaced ours is not ours to delete");
        assert!(stranger.exists(), "an unlisted .part is never touched");
        assert!(!list.exists(), "every entry was settled");

        // Newer than the sweep's start: kept on disk (crossed off the list).
        let fresh = dir.join("fresh.mp4.part");
        std::fs::write(&fresh, b"partial").unwrap();
        record_in(&list, &fresh);
        assert_eq!(sweep_in(&list, SystemTime::now() - Duration::from_secs(60)), 0);
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A claim this run holds is a live export's, never a leftover.
    #[test]
    fn a_live_claim_is_never_a_leftover() {
        let part = std::env::temp_dir().join(format!("taroting claims live {}.mp4.part", std::process::id()));
        let _ = std::fs::remove_file(&part);
        std::fs::write(&part, b"").unwrap();
        record(&part);
        assert!(!left_by_earlier_run(&part), "this run's own claim");
        lock(&LIVE).remove(&part);
        assert!(left_by_earlier_run(&part), "the same claim, from an earlier run");
        release(&part);
        assert!(!left_by_earlier_run(&part));
        let _ = std::fs::remove_file(&part);
    }
}
