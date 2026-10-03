//! Project persistence: atomic saves with .bak recovery, plus the recents
//! index read by the home screen at startup.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use super::image_rules;
use super::schema::{self, ProjectFile};
use crate::error::{AppError, Result};
use crate::media::source::{is_cloud_placeholder, may_touch};
use crate::paths;

/* ------------------------------------------------------------------ */
/* The store worker                                                    */
/* ------------------------------------------------------------------ */

// Every command here used to be a plain sync command, and in Tauri 2 that
// runs on the WebView2 UI thread: an autosave on a disk Defender or OneDrive
// is busy with, a Home listing against a sleeping NAS, a settings write behind
// a backup agent's lock — each one froze the whole window for as long as the
// disk took.
//
// The UI thread also SERIALIZED them, and correctness leaned on that without
// saying so. Two saves of one project share one `<path>.tmp`, so two writers
// at once interleave their bytes into the file that is then renamed into
// place; a reader landing between a save's two renames finds no primary and
// reports a `.bak` "recovery" of a project nothing happened to; Keep saves to
// the new path and only then deletes the old one. Moving each command to its
// own pool thread would have kept the window responsive and broken all three.
//
// So everything that WRITES project or settings state runs on this one
// worker thread, one job at a time, in the order the jobs were queued. One
// thread rather than a lock per path because the writes are not per path:
// recents.json is shared by every save, rename writes one path and deletes
// another, and settings ride along. A lock per path would need an order for
// taking two of them; one queue has none to get wrong.
//
// What the queue guarantees is FIFO among the jobs it holds: a save already
// queued when a delete of the same file is queued is written first, and the
// delete then removes it (pinned by
// `a_save_queued_before_a_delete_cannot_resurrect_the_file`).
//
// What it does NOT promise is the arrival order of the invokes themselves.
// An async command's arguments are parsed, and its job queued, on a tokio
// task, and two tasks spawned in order may start in either order — a save
// carrying a large project can reach the queue after a delete invoked well
// after it. Only the frontend can order those, by awaiting one invoke before
// it sends the next: an autosave coalesces through its own in-flight write,
// settings writes are chained, Keep awaits each step. Discard is where a miss
// matters most: a save that reaches the queue after the delete re-creates the
// temp `.trt` with `tempEdited: true`, and the startup sweep does not delete
// such a file — it KEEPS it and offers it back on Home, so the project the
// user discarded would return. Nothing here can tell that late save from a
// real one: temp names are reused once free (`fresh_untitled_in`), so a
// remembered "discarded" path would refuse the next session's saves.
//
// What stays OFF the worker is what only needs a consistent view, never an
// order: listing recents (its read holds `RECENTS_LOCK`, and dozens of stats
// against a dead share must not hold every save up behind them), loading a
// project (a 512 MB parse and its probes; only its repair write and its
// recents stamp are queued), path checks, and the thumbnail backfill, whose
// ffmpeg must never delay a save.

/// One unit of work for the worker.
type StoreJob = Box<dyn FnOnce() + Send>;

thread_local! {
    /// True on the worker thread itself, so a job that reaches a helper which
    /// queues and waits runs that work inline instead of waiting on itself.
    static ON_STORE_WORKER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The worker's queue, started on first use. `None` when the thread could not
/// be started at all; every job then runs on its caller, which is the old
/// unordered behaviour, never a failure.
fn store_queue() -> Option<&'static mpsc::Sender<StoreJob>> {
    static QUEUE: OnceLock<Option<mpsc::Sender<StoreJob>>> = OnceLock::new();
    QUEUE
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<StoreJob>();
            std::thread::Builder::new()
                .name("taroting-store".into())
                .spawn(move || {
                    ON_STORE_WORKER.with(|w| w.set(true));
                    for job in rx {
                        job();
                    }
                })
                .ok()
                .map(|_| tx)
        })
        .as_ref()
}

/// Queue `job` behind every job already queued, without waiting for it. On
/// the worker itself, or when the worker is gone, it runs right here.
fn submit_to_store(job: StoreJob) {
    if ON_STORE_WORKER.with(|w| w.get()) {
        return job();
    }
    match store_queue() {
        Some(tx) => {
            if let Err(mpsc::SendError(job)) = tx.send(job) {
                job();
            }
        }
        None => job(),
    }
}

/// The error a caller sees when the worker dropped its job unanswered — only
/// possible if a job panicked, which a release build turns into an abort long
/// before anyone could read this.
fn store_stopped() -> AppError {
    AppError::Io(std::io::Error::other("the project store stopped unexpectedly"))
}

/// Run `work` on the worker and BLOCK until it is done. For callers that are
/// already off the UI thread (a load's repair write, a test). Never from an
/// async task: `on_store` is the one for those.
fn on_store_blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    if ON_STORE_WORKER.with(|w| w.get()) {
        return Ok(work());
    }
    let (tx, rx) = mpsc::channel();
    submit_to_store(Box::new(move || {
        let _ = tx.send(work());
    }));
    rx.recv().map_err(|_| store_stopped())
}

/// Run `work` on the worker and await its answer — what every queued command
/// does. The task waits on a channel, not on a thread: nothing is blocked
/// while the job sits in the queue.
pub(crate) async fn on_store<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<T>>(1);
    submit_to_store(Box::new(move || {
        // Capacity one, one send: never full, so this never blocks the worker.
        let _ = tx.try_send(work());
    }));
    rx.recv().await.ok_or_else(store_stopped)?
}

/// Run blocking work that only has to be off the UI thread, NOT on the worker
/// (see above for which work that is).
async fn off_ui<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(format!("a background task failed: {e}"))))?
}

/* ------------------------------------------------------------------ */
/* Atomic writes                                                       */
/* ------------------------------------------------------------------ */

/// `<path>.bak` — the previous contents, rotated aside by `atomic_write`.
fn bak_path(path: &Path) -> PathBuf {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    PathBuf::from(bak)
}

/// `<path>.tmp` — the bytes `atomic_write` stages before renaming them into
/// place. ONE fixed name per target, on purpose: the store worker never runs
/// two writes at once, and a failed write's leftover is overwritten by the
/// next one instead of piling up.
fn tmp_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

/// Write via temp file + rename so a crash never corrupts the target.
/// If the target exists it is first rotated to `<name>.bak`.
///
/// Failure is atomic in BOTH directions: if the second rename fails (an AV /
/// OneDrive scanner holding the name, power loss, a full volume) the rotated
/// original is moved straight back. Without that restore the target simply
/// ceased to exist — a save that failed halfway deleted the project.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", path.display())))?;
    std::fs::create_dir_all(dir)?;

    let tmp = tmp_path(path);
    std::fs::write(&tmp, bytes)?;

    let bak = bak_path(path);
    let rotated = if path.exists() {
        // Rename straight ONTO any existing backup — rename replaces it
        // atomically. Deleting the old `.bak` first meant that a rotation which
        // then failed (a scanner holding the name, a full volume) left no backup
        // at all, and the one moment a backup matters most is the moment a write
        // is going wrong.
        std::fs::rename(path, &bak)?;
        true
    } else {
        false
    };
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Put the original back before surfacing the error. The `.tmp` is left
        // on disk deliberately: it holds the bytes we failed to commit, and the
        // next successful write overwrites it anyway.
        if rotated {
            let _ = std::fs::rename(&bak, path);
        }
        return Err(e.into());
    }
    Ok(())
}

/// A project as the pretty JSON every `.trt` writer here puts on disk,
/// refused when it would be larger than `image_rules::MAX_TRT_BYTES` — the cap
/// every READ enforces (`read_capped`). Writing past it saves a project the
/// next open refuses, and the `.bak` recovery does not step in (it keys on a
/// missing file, not an oversize one). Pretty-printing is what gets there: a
/// compact file under the cap, or a drawing duplicated many times over, can
/// re-serialize past it.
///
/// Every writer, not only the save: rename deletes the readable original once
/// its copy is down, and a load-time repair would replace it.
fn project_bytes(value: &Value) -> Result<Vec<u8>> {
    project_bytes_within(value, image_rules::MAX_TRT_BYTES)
}

/// `project_bytes` against any cap, so the tests can prove the refusal
/// without half a gigabyte of JSON.
fn project_bytes_within(value: &Value, cap: u64) -> Result<Vec<u8>> {
    const MB: u64 = 1024 * 1024;
    let bytes = serde_json::to_vec_pretty(value)?;
    if bytes.len() as u64 > cap {
        let limit = if cap >= MB && cap % MB == 0 {
            format!("{} MB", cap / MB)
        } else {
            format!("{cap} bytes")
        };
        return Err(AppError::BadInput(format!(
            "refusing to save: the project would be larger than {limit}, which Taroting can't open"
        )));
    }
    Ok(bytes)
}

/// The outcome of reading a JSON file that has a `.bak` sibling.
///
/// The distinction that earns its keep is `Absent` vs `Unreadable`. "Nothing is
/// stored" is a legitimate empty state that a caller may freely write over;
/// "something is stored but we could not read it" is NOT, because writing the
/// empty value over it rotates the last good copy into `.bak` and then hides it
/// forever — the fresh primary parses fine, so the `.bak` fallback below never
/// fires again. That is the exact sequence that wiped a user's whole recents
/// list.
///
/// Every caller takes the three states directly. A convenience wrapper that
/// mapped `Absent` and `Unreadable` onto one `None` used to sit here, and it
/// was the only thing settings ever called — which is precisely how the
/// settings read kept the bug this enum exists to prevent.
pub enum JsonRead<T> {
    /// Parsed. `recovered` is true when the `.bak` supplied it.
    Parsed { value: T, recovered: bool },
    /// Neither copy is on disk — a clean first run.
    Absent,
    /// At least one copy exists but nothing could be parsed out of it.
    Unreadable,
}

/// Largest recents.json or settings.json a read accepts: hundreds of times
/// what 24 recents cards or a whole settings object take. Both are read whole
/// on every Home listing and on every save's recents update, so a crafted or
/// runaway file must not be read into memory each time.
const JSON_INDEX_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// `(parsed value, whether the file is there at all)`.
///
/// A file we cannot even open for a reason OTHER than "it isn't there" — a
/// permission error, an exclusive lock, a bad sector — counts as PRESENT: the
/// data may well still exist, so the caller must not overwrite it. So does a
/// file over `JSON_INDEX_MAX_BYTES`: it is left unread, and unwritten.
fn read_json_one<T: serde::de::DeserializeOwned>(path: &Path) -> (Option<T>, bool) {
    read_json_one_within(path, JSON_INDEX_MAX_BYTES)
}

/// `read_json_one` against any cap, so a test can prove the oversize rule
/// without megabytes of JSON.
fn read_json_one_within<T: serde::de::DeserializeOwned>(path: &Path, cap: u64) -> (Option<T>, bool) {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return (None, e.kind() != std::io::ErrorKind::NotFound),
    };
    // Sized from the opened handle, and the read bounded too, so a file that
    // grows between the two still cannot be read past the cap.
    match file.metadata() {
        Ok(meta) if meta.len() <= cap => {}
        _ => return (None, true),
    }
    let mut bytes = Vec::new();
    if file.take(cap + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > cap {
        return (None, true);
    }
    (serde_json::from_slice::<T>(&bytes).ok(), true)
}

/// Read a JSON file, falling back to the `<path>.bak` that `atomic_write`
/// rotates aside, and report which of the three outcomes occurred.
///
/// Those `.bak` files existed from the start but nothing ever read them, so a
/// corrupt primary silently became "no data": for settings that meant every
/// preference reset to defaults, and for recents it meant every project card
/// disappearing from home. Both then re-saved over the last good backup.
pub fn read_json_status<T: serde::de::DeserializeOwned>(path: &Path) -> JsonRead<T> {
    let (primary, primary_present) = read_json_one::<T>(path);
    if let Some(value) = primary {
        return JsonRead::Parsed { value, recovered: false };
    }
    let (backup, bak_present) = read_json_one::<T>(&bak_path(path));
    if let Some(value) = backup {
        return JsonRead::Parsed { value, recovered: true };
    }
    if primary_present || bak_present {
        JsonRead::Unreadable
    } else {
        JsonRead::Absent
    }
}

/* ------------------------------------------------------------------ */
/* Recents index                                                       */
/* ------------------------------------------------------------------ */

const MAX_RECENTS: usize = 24;

/// The most of a project's name, and of its `modifiedAt`, a recents entry
/// keeps. Both are copied from the `.trt` itself, which a crafted file can
/// fill with megabytes; the index is read whole on every listing and every
/// save, so it holds what a card can show and no more.
const RECENT_NAME_MAX_CHARS: usize = 256;
const RECENT_STAMP_MAX_CHARS: usize = 64;

/// `s` cut to at most `max` characters — whole characters, never a byte
/// index, so a multi-byte name is never split.
fn clipped(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Current UTC time as an ISO 8601 string (e.g. `2026-07-02T15:04:05Z`),
/// computed from the Unix epoch with no external date crate.
fn now_iso8601() -> String {
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
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hh, mm, ss
    )
}

/// A duration safe to persist. `Timeline::duration()` can come back non-finite
/// from a hand-edited or hostile `.trt` (`speed: 0` divides by zero; a
/// `timelineStart` + `srcOut` near f64::MAX sums to infinity) — both parse
/// fine. serde_json writes a non-finite f64 as `null`, which used to make the
/// WHOLE recents index unparseable: every project card vanished from home
/// because of one bad entry.
fn finite_duration(d: f64) -> f64 {
    if d.is_finite() {
        d
    } else {
        0.0
    }
}

/// Tolerate a missing or `null` `durationSec` instead of failing the entire
/// index. `#[serde(default)]` alone only covers an ABSENT field; an index
/// already written by an older build carries a literal `null` here, and that
/// still has to degrade to one wrong duration rather than an empty home screen.
fn de_duration_sec<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?
        .filter(|n| n.is_finite())
        .unwrap_or(0.0))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub modified_at: String,
    #[serde(default, deserialize_with = "de_duration_sec")]
    pub duration_sec: f64,
    pub thumb: Option<String>,
    /// on-disk size of the `.trt` file; refreshed by `list_recents`
    #[serde(default)]
    pub size_bytes: u64,
    /// last time this project was opened (ISO 8601 UTC); stamped by `load_project`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
    /// `Some("image")` for an image project; absent for a video project (TS
    /// `RecentItem.kind`). Only the literal string "image" reads as the kind:
    /// anything else in the index is treated as absent rather than failing the
    /// parse, since one unparseable field would blank the whole home screen.
    #[serde(
        default,
        deserialize_with = "schema::image_kind_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentsIndex {
    pub schema: u32,
    pub items: Vec<RecentItem>,
}

impl Default for RecentsIndex {
    fn default() -> Self {
        RecentsIndex {
            schema: 1,
            items: Vec::new(),
        }
    }
}

fn recents_path() -> Result<PathBuf> {
    Ok(paths::data_dir()?.join("recents.json"))
}

/// The recents index plus whether it is safe to write back over it.
struct Recents {
    index: RecentsIndex,
    /// False when an index EXISTS on disk that we could not read. Persisting the
    /// empty default we fall back to would destroy it: `atomic_write` rotates
    /// the last good copy into `.bak`, and the fresh empty primary then parses
    /// fine, so the recovery path never looks at that backup again. One
    /// unreadable file plus one ordinary save is all it took to lose the entire
    /// list. Absence is different and stays writable — that is a first run.
    writable: bool,
}

fn read_recents_checked() -> Recents {
    let empty = |writable| Recents {
        index: RecentsIndex::default(),
        writable,
    };
    // No data dir means we could not even look; refuse to write blind.
    let Ok(path) = recents_path() else {
        return empty(false);
    };
    match read_json_status::<RecentsIndex>(&path) {
        JsonRead::Parsed { value, .. } => Recents { index: value, writable: true },
        JsonRead::Absent => empty(true),
        JsonRead::Unreadable => empty(false),
    }
}

/// The one lock every recents.json read-modify-write holds, from the read to
/// the write. Until image saves, every writer was a sync command on the main
/// thread and could not overlap another; a project card's commit now stamps
/// its entry from a blocking-pool thread (`set_recent_thumb`) while a save, an
/// open or Home's thumbnail backfill runs on the main one. Unlocked, one of the
/// two updates was lost (whichever read first wrote last, from its stale copy)
/// and both `atomic_write`s shared one `recents.json.tmp`, so their bytes could
/// interleave into the file that is then renamed into place.
///
/// Held only across the file work itself — never across ffmpeg, a probe or an
/// await — and never taken twice on one thread: `std::sync::Mutex` is not
/// re-entrant, so a helper that locks must not call another that does.
static RECENTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Poison-tolerant: a poisoned lock only means an earlier holder panicked,
/// which under `panic = "abort"` cannot happen in a release build — never
/// worth taking recents (or the app) down over.
fn lock_recents() -> std::sync::MutexGuard<'static, ()> {
    RECENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Read, edit and write back the recents index as ONE step under
/// `RECENTS_LOCK`. `edit` returns whether it changed anything; an unchanged
/// index is not rewritten. The write follows `write_recents_checked`, so an
/// index that exists but could not be read is never replaced.
fn update_recents(edit: impl FnOnce(&mut RecentsIndex) -> bool) -> Result<()> {
    let _guard = lock_recents();
    let mut recents = read_recents_checked();
    if !edit(&mut recents.index) {
        return Ok(());
    }
    write_recents_checked(&recents)
}

/// A plain read, under the lock so it never meets a write halfway through its
/// renames (the primary rotated to `.bak`, the new one not yet in place).
fn read_recents() -> RecentsIndex {
    let _guard = lock_recents();
    read_recents_checked().index
}

fn write_recents(index: &RecentsIndex) -> Result<()> {
    atomic_write(&recents_path()?, serde_json::to_vec(index)?.as_slice())
}

/// Persist an index that came from `read_recents_checked`, unless the read
/// failed — see `Recents::writable`.
///
/// Skipping is reported as success on purpose: recents is a convenience, and a
/// corrupt index must not be able to fail the project save that triggered the
/// update. The user keeps their work and their (unreadable) index; nothing is
/// destroyed, so a later repair is still possible.
fn write_recents_checked(recents: &Recents) -> Result<()> {
    if !recents.writable {
        return Ok(());
    }
    write_recents(&recents.index)
}

fn upsert_recent(mut item: RecentItem) -> Result<()> {
    // Refresh the on-disk size so callers don't all have to stat — before the
    // lock, which covers the recents file and nothing else.
    if let Ok(meta) = std::fs::metadata(&item.path) {
        item.size_bytes = meta.len();
    }
    item.name = clipped(&item.name, RECENT_NAME_MAX_CHARS);
    item.modified_at = clipped(&item.modified_at, RECENT_STAMP_MAX_CHARS);
    update_recents(|index| {
        // Preserve a prior openedAt when the caller doesn't supply one.
        if let Some(prev) = index.items.iter().find(|r| r.path == item.path) {
            if item.opened_at.is_none() {
                item.opened_at = prev.opened_at.clone();
            }
            // An image project's card is a RENDERED picture the image editor
            // writes (`set_recent_thumb`), never a frame the backend can look
            // up, so a save, which knows no thumbnail, must not blank the one
            // the card already has.
            if item.kind.as_deref() == Some("image") && item.thumb.is_none() {
                item.thumb = prev.thumb.clone();
            }
        }
        index.items.retain(|r| r.path != item.path);
        index.items.insert(0, item);
        index.items.truncate(MAX_RECENTS);
        true
    })
}

/// Point an image project's recents card at the picture the image editor just
/// rendered (`image_save`, `ProjectThumb`). Only an EXISTING entry is touched:
/// a card appears when a project is saved or opened, never because a
/// thumbnail landed. A temporary project has no card at all, so nothing is
/// read or written for one. Best-effort like every recents side effect — a
/// failure here must not fail the save that produced the picture.
pub(crate) fn set_recent_thumb(project_path: &str, thumb: &str) {
    if is_temp_project_path(project_path) {
        return;
    }
    let _ = update_recents(|index| {
        let Some(entry) = index.items.iter_mut().find(|r| r.path == project_path) else {
            return false;
        };
        if entry.thumb.as_deref() == Some(thumb) {
            return false;
        }
        entry.thumb = Some(thumb.to_string());
        true
    });
}

/// Off the UI thread and off the store worker: a card per entry is a stat per
/// entry, and against a sleeping NAS each one is an SMB timeout that must
/// hold up neither the window nor anybody's save.
#[tauri::command]
pub async fn list_recents() -> Result<RecentsIndex> {
    off_ui(list_recents_now).await
}

/// `list_recents`' body.
///
/// An index that is on disk but cannot be read is an ERROR, not an empty
/// list. Answering "no projects" made Home say "No projects yet" over a
/// user's whole library, with nothing to tell them it was still there.
fn list_recents_now() -> Result<RecentsIndex> {
    let recents = {
        let _guard = lock_recents();
        read_recents_checked()
    };
    if !recents.writable {
        return Err(AppError::Io(std::io::Error::other(
            "the list is on disk but could not be read",
        )));
    }
    let mut index = recents.index;
    // Drop entries whose project file vanished (moved/deleted by the user), but
    // KEEP one whose primary is gone while its .bak survives. That is what an
    // interrupted save leaves, and read_project_value recovers it; it is ALSO
    // what deleting a saved-twice project's .trt in Explorer leaves, and that
    // card is kept on purpose (owner's ruling): the .bak still holds the work,
    // and Delete, Rename and Duplicate all work on such a card.
    //
    // One stat per card; the .bak is asked about only when the primary is
    // gone. A primary that cannot be asked at all (a share that is offline, a
    // permission error) keeps its card: an unreachable project is not a
    // deleted one, and this listing writes nothing, so the card's fate is
    // decided again on the next listing.
    index.items.retain_mut(|r| match std::fs::metadata(&r.path) {
        Ok(meta) if meta.is_file() => {
            r.size_bytes = meta.len();
            true
        }
        Ok(_) => bak_path(Path::new(&r.path)).is_file(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => bak_path(Path::new(&r.path)).is_file(),
        Err(_) => true,
    });
    Ok(index)
}

#[tauri::command]
pub async fn remove_recent(path: String) -> Result<()> {
    on_store(move || remove_recent_now(&path)).await
}

fn remove_recent_now(path: &str) -> Result<()> {
    update_recents(|index| {
        index.items.retain(|r| r.path != path);
        true
    })
}

/* ------------------------------------------------------------------ */
/* Load / save                                                         */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    pub project: Value,
    /// media ids whose file is missing or changed (size/mtime mismatch)
    pub missing: Vec<String>,
    /// true when the main file was corrupt and the .bak was used
    pub recovered: bool,
}

/// File mtime as ms since the Unix epoch, matching `probe_sync`'s derivation
/// exactly so the load-time scan compares like-for-like against `mtime_ms`.
fn mtime_ms_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The `.bak` sibling, parsed as JSON. `None` when it is absent or corrupt too
/// (or over the `.trt` size cap, or too dense to parse — `refuse_value_bomb`).
fn read_bak_value(path: &Path) -> Option<Value> {
    let bytes = image_rules::read_capped(&bak_path(path)).ok()?;
    parse_bak_bytes(path, &bytes)
}

/// A `.bak`'s bytes as JSON, behind the same density check as every read.
fn parse_bak_bytes(path: &Path, bytes: &[u8]) -> Option<Value> {
    refuse_value_bomb(bytes, path).ok()?;
    serde_json::from_slice::<Value>(bytes).ok()
}

/* ------------------------------------------------------------------ */
/* Parse-memory guard                                                  */
/* ------------------------------------------------------------------ */

// A `.trt` is parsed whole into `serde_json::Value` (the raw document is what
// load hands on, unknown fields and all), and a Value costs far more than the
// bytes it came from: every object is a B-tree whose first node alone is 632
// bytes, every value a 32-byte slot in a vector that grows by doubling, every
// string a heap block. A file under the 512 MB read cap made of nothing but
// `{}` or `0` asks for tens of gigabytes, and a failed allocation aborts the
// app silently — every other window's unsaved work with it. The size cap
// stops a big file; this stops a DENSE one.
//
// So a file over `VALUE_SCAN_FROM_BYTES` is scanned once before the parse
// (O(n), no allocation; string contents skipped, escapes honoured) for what
// the parse would cost, and refused above `VALUE_BUDGET`. Below that size the
// worst a file can ask for is a few hundred megabytes, and the scan is skipped
// so an ordinary project pays nothing for it.

/// Files at or under this are parsed without the scan.
const VALUE_SCAN_FROM_BYTES: usize = 1024 * 1024;

/// What one `{` costs once parsed: the B-tree's first node, 632 bytes for a
/// `String` → `Value` map, plus the allocator's header.
const OBJECT_COST: u64 = 704;
/// What one more value in an array or object costs: its 32-byte slot, twice
/// over for the doubling growth of the vector holding it.
const SLOT_COST: u64 = 64;
/// What one string costs beyond its own bytes: the heap block's rounding and
/// header.
const STRING_COST: u64 = 32;

/// The heaviest stroke the editor writes, as `value_cost` prices it — a shape
/// (arrow, line), whose two endpoint arrays cost more than an ink stroke's one
/// points string; that string's length is priced separately below. A test
/// prices every stroke shape against it.
const WORST_STROKE_COST: u64 = 1_700;

/// The most a parse may cost: a drawing at every cap at once —
/// `MAX_STROKES_TOTAL` of the heaviest stroke, `MAX_POINTS_TOTAL` points of
/// base64 (16 characters each) — plus room for the rest of the project. So
/// the biggest drawing the editor can build still opens, and a crafted file
/// can never ask for more memory than that drawing would (about 3.8 GB by
/// this pricing; less in fact, the pricing is deliberately pessimistic).
const VALUE_BUDGET: u64 = image_rules::MAX_STROKES_TOTAL * WORST_STROKE_COST
    + image_rules::MAX_POINTS_TOTAL * 16
    + 64 * 1024 * 1024;

/// What parsing `bytes` into a `Value` would cost, priced per `{`, per value
/// in a container (`[` and `,` outside strings) and per string. Whitespace is
/// free; numbers, `true`, `false` and `null` are priced through the comma
/// before them.
fn value_cost(bytes: &[u8]) -> u64 {
    let mut cost: u64 = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i;
                i += 1;
                // Skip the string, honouring escapes: `\"` does not close it
                // and `\\` does not escape the quote after it.
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => i += 2,
                        b'"' => break,
                        _ => i += 1,
                    }
                }
                cost += STRING_COST + (i.min(bytes.len()) - start) as u64;
            }
            b'{' => cost += OBJECT_COST,
            b'[' | b',' => cost += SLOT_COST,
            _ => {}
        }
        i += 1;
    }
    cost
}

/// Refuse a project whose parse would cost more than `VALUE_BUDGET`.
fn refuse_value_bomb(bytes: &[u8], path: &Path) -> Result<()> {
    refuse_value_bomb_within(bytes, path, VALUE_SCAN_FROM_BYTES, VALUE_BUDGET)
}

/// `refuse_value_bomb` against any threshold and budget, so the tests can
/// prove the refusal with kilobytes instead of gigabytes.
fn refuse_value_bomb_within(bytes: &[u8], path: &Path, scan_from: usize, budget: u64) -> Result<()> {
    if bytes.len() <= scan_from || value_cost(bytes) <= budget {
        return Ok(());
    }
    Err(AppError::BadInput(format!(
        "{} holds more data than Taroting can open safely",
        path.display()
    )))
}

/// What a read that found no primary settled on, on the store worker.
enum Settled {
    /// The primary was there after all: a save had it mid-rename.
    Primary(std::io::Result<Vec<u8>>),
    /// The primary really is gone: the `.bak`, read in the same step.
    Gone(std::io::Result<Vec<u8>>),
}

/// An oversize `.trt` (see `image_rules::read_capped`) as the user-facing
/// refusal; every other io error keeps its own kind.
fn capped_read_error(e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::InvalidData {
        AppError::BadInput(e.to_string())
    } else {
        e.into()
    }
}

/// Read a project as JSON, falling back to its `.bak`. `(value, recovered)`.
///
/// Runs OFF the store worker (load, the thumbnail backfill), so a save may be
/// running at the same moment — and between its two renames a save leaves no
/// primary at all. Reading the `.bak` then reported a recovery of a project
/// nothing had happened to. So a missing primary is settled ON the worker,
/// where no save can be half done: the primary is read again there, and only
/// if it is still gone is the `.bak` read, in the same step.
fn read_project_value(path: &Path) -> Result<(Value, bool)> {
    match image_rules::read_capped(path) {
        Ok(bytes) => parse_project_bytes(path, &bytes),
        // Nothing to settle: a save mid-rename has always rotated the primary
        // onto the `.bak` first, so with neither on disk there is no save.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !bak_path(path).exists() => Err(e.into()),
        // The primary is GONE — a save whose final rename failed used to leave
        // exactly this state, and returning NotFound here made the loss look
        // permanent. The rotated `.bak` is the last good copy, so recover from
        // it (flagged `recovered`) exactly as for a corrupt primary.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let primary = path.to_path_buf();
            let settled = on_store_blocking(move || match image_rules::read_capped(&primary) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    Settled::Gone(image_rules::read_capped(&bak_path(&primary)))
                }
                read => Settled::Primary(read),
            })?;
            match settled {
                Settled::Primary(Ok(bytes)) => parse_project_bytes(path, &bytes),
                Settled::Primary(Err(e)) => Err(capped_read_error(e)),
                Settled::Gone(bak) => bak
                    .ok()
                    .and_then(|bytes| parse_bak_bytes(path, &bytes))
                    .map(|v| (v, true))
                    .ok_or_else(|| e.into()),
            }
        }
        Err(e) => Err(capped_read_error(e)),
    }
}

/// A primary's bytes as JSON, or — corrupt — its `.bak` instead.
fn parse_project_bytes(path: &Path, bytes: &[u8]) -> Result<(Value, bool)> {
    refuse_value_bomb(bytes, path)?;
    if let Ok(v) = serde_json::from_slice::<Value>(bytes) {
        return Ok((v, false));
    }
    // corrupt main file → try the .bak
    match read_bak_value(path) {
        Some(v) => Ok((v, true)),
        None if bak_path(path).exists() => Err(AppError::BadInput(format!(
            "{} and its backup are both corrupt",
            path.display()
        ))),
        None => Err(AppError::BadInput(format!(
            "{} is not valid JSON",
            path.display()
        ))),
    }
}

/// A file's length and modification time, taken just before a load reads it.
/// A load-time repair is written back only while the file still has exactly
/// this stamp, checked on the store worker: anything else means a save landed
/// after the read, and writing the repaired READ over it would revert that
/// save.
type FileStamp = (u64, SystemTime);

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// Whether the file behind `m` is on disk with exactly the size and mtime the
/// project recorded.
///
/// The one identity rule, shared by the missing-media scan, the thumbnail
/// resolver and the rotation repair below — it was spelled out separately at
/// each of them. The repair in particular MUST agree with the scan: a file that
/// fails this is the relink path's business, and re-probing it would write a
/// REPLACED file's dimensions into a project the user has not relinked yet.
///
/// Compares both size and mtime. `mtime_ms_of` uses the exact derivation from
/// `probe_sync` (modified() → ms since epoch, u64) so an unchanged file
/// compares bit-identical; an exact match is correct (no tolerance).
///
/// A share off the local network fails it without being looked at
/// (`media::source::may_touch`): the stat alone would connect to whatever
/// server a crafted project names, and hand it the user's sign-in.
fn identity_intact(m: &schema::MediaRef) -> bool {
    let path = Path::new(&m.path);
    may_touch(path)
        && media_stat(path)
            .map(|meta| meta.len() == m.size && mtime_ms_of(&meta) == m.mtime_ms)
            .unwrap_or(false)
}

/// The stat of a path a `.trt` gave (`identity_intact`, `path_exists_now`).
/// In the tests it also records every path it was asked about, so a test can
/// prove a path was never looked at.
#[cfg(not(test))]
fn media_stat(path: &Path) -> std::io::Result<std::fs::Metadata> {
    std::fs::metadata(path)
}

#[cfg(test)]
thread_local! {
    static STATTED: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn media_stat(path: &Path) -> std::io::Result<std::fs::Metadata> {
    STATTED.with(|s| s.borrow_mut().push(path.to_path_buf()));
    std::fs::metadata(path)
}

/// A media entry whose stored dimensions a fresh probe contradicts by exactly a
/// transposition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DimFix {
    /// Index into the project's `media` array.
    index: usize,
    /// What the project had stored — the pre-fix, coded pair.
    from: (u32, u32),
    /// What the file actually decodes to.
    to: (u32, u32),
}

/// Is `probed` the transpose of `stored`, and does that transposition mean
/// anything?
///
/// This is the whole discriminator between the two ways a fresh probe can
/// disagree with a stored pair. A rotated recording stored its CODED size and
/// the probe now reports the DECODED one, which is that pair swapped and
/// nothing else. Any other disagreement — 1920x1080 stored, 1280x720 probed —
/// is a DIFFERENT FILE, not a rotation, and quietly adopting its dimensions
/// here would paper over exactly what the relink dialog exists to ask the user
/// about. (The identity check in `rotation_fixes` is the first line of that
/// defence and catches every ordinary replacement; this is what holds if a
/// replacement ever slipped through with a colliding size and mtime.)
///
/// A square pair is excluded because its transpose is itself: there is no
/// correction to make, and calling it one would hand `transposed_canvas` a
/// "fix" with which to turn a canvas that was never wrong.
fn is_transposition(stored: (u32, u32), probed: (u32, u32)) -> bool {
    stored.0 != stored.1 && probed == (stored.1, stored.0)
}

/// Re-probe the media that could be carrying pre-rotation-fix dimensions and
/// return the corrections. One ffprobe per candidate, which is why the caller
/// runs this at most once per project.
///
/// Measured on this machine, warm: ~38 ms per candidate, all of it process
/// startup — a 12-video project spends 490 ms in its one repairing load, a
/// 40-video project 1.5 s. Serial, deliberately. The probes are independent and
/// a bounded fan-out roughly halves the wall time (measured: 10 concurrent
/// ffprobes in 203 ms against 452 ms serial), but this runs ONCE in a project's
/// life, against a defect that is otherwise permanent, and the load it delays
/// is one the user asked for. Concurrency on the load path would outlive its
/// justification by years. If it ever needs bounding, bound it here — the
/// candidate filter below is where the cheap wins already are.
fn rotation_fixes(media: &[schema::MediaRef]) -> Vec<DimFix> {
    rotation_fixes_with(media, |path| {
        let info = crate::media::probe::probe_sync(path).ok()?;
        Some((info.width?, info.height?))
    })
}

/// `rotation_fixes` with the probe injected (the decoded size, or `None` when
/// it fails), so the tests can pin which files it is ever asked about.
fn rotation_fixes_with(
    media: &[schema::MediaRef],
    mut probe: impl FnMut(&str) -> Option<(u32, u32)>,
) -> Vec<DimFix> {
    let mut fixes = Vec::new();
    for (index, m) in media.iter().enumerate() {
        // Only a video stream can carry the stream-level Display Matrix this
        // repair is about. A still's turn lives elsewhere — EXIF orientation,
        // applied per frame, invisible to `-show_streams` — and is repaired by
        // `repair_still_orientation`, which reads the header first and spends
        // a frame probe only on a still that header says was stored stale;
        // re-probing every still here would make a 200-photo slideshow spawn
        // 200 processes. The GIF muxer drops a rotation you ask it to write, so
        // a gif cannot have been stored wrong. A generator has no file to probe.
        if m.kind != "video" || m.generator.is_some() {
            continue;
        }
        let (Some(w), Some(h)) = (m.width, m.height) else {
            continue;
        };
        // A square frame transposes to itself — there is nothing to find, so
        // do not pay a process to find it.
        if w == h {
            continue;
        }
        // Missing or changed on disk: already reported in `missing`, and the
        // relink path re-probes and self-heals once the user points at the
        // file. Unreadable (an exclusive lock, a codec ffprobe cannot open) is
        // the same situation — leave the entry exactly as authored. A cloud
        // placeholder too, exactly as the still repair: ffprobe would download
        // an online-only file whole, on the load the user is waiting on.
        // Identity first — it reads metadata only — and nothing opens the file
        // before the placeholder check has said it is local.
        if !identity_intact(m) || is_cloud_placeholder(Path::new(&m.path)) {
            continue;
        }
        let Some((pw, ph)) = probe(&m.path) else {
            continue;
        };
        if is_transposition((w, h), (pw, ph)) {
            fixes.push(DimFix { index, from: (w, h), to: (pw, ph) });
        }
    }
    fixes
}

/// The canvas the timeline should be transposed to, or `None` to leave it be.
///
/// THE JUDGEMENT CALL. A canvas is adopted from the first visual media added to
/// an EMPTY timeline (`addMedia`, src/core/project.ts), so a portrait clip
/// stored pre-swap created a landscape canvas and has been letterboxed into it
/// ever since. Transposing that back is the fix the user is actually asking
/// for.
///
/// But the same shape — a canvas equal to a clip's stale dimensions — is also
/// what a DELIBERATE choice looks like: a user framing a portrait clip inside a
/// landscape canvas on purpose typed those very numbers. Nothing in the file
/// separates the two, so the rule is drawn where the ambiguity disappears
/// rather than where it is merely unlikely:
///
/// > transpose only when the corrected clip is the project's ONLY visual media
/// > and the canvas is exactly that clip's stale dimensions.
///
/// A single visual media means there is nothing else the canvas could have been
/// framed for, and no second clip that a transposition would silently reframe.
/// Audio is not counted: it has no dimensions, could never have set the canvas,
/// and its presence says nothing about framing — a portrait clip over a music
/// bed is still a single-clip portrait project. Generators and stills ARE
/// counted, even though `addMedia` never adopts a canvas from them, precisely
/// because they are visual: a title card sized against the current canvas is
/// evidence the canvas was already being composed against, and reframing under
/// it would move the title.
///
/// Everything else is left alone — and "left alone" is a correct outcome, not a
/// failure. The clip now carries its true dimensions, so it letterboxes
/// properly inside whatever canvas it is in: visible, and one click to change.
/// A wrong transposition is neither.
///
/// No clamping on the way out. Both numbers come from a canvas the app already
/// accepted, and swapping a valid pair leaves each value inside the same range
/// (`clampCanvas`: even, [16, 8192]) that the other one satisfied.
fn transposed_canvas(typed: &ProjectFile, fixes: &[DimFix]) -> Option<(u32, u32)> {
    let [fix] = fixes else {
        return None;
    };
    let mut visual = typed.media.iter().enumerate().filter(|(_, m)| m.kind != "audio");
    let (only, _) = visual.next()?;
    if visual.next().is_some() || only != fix.index {
        return None;
    }
    ((typed.timeline.width, typed.timeline.height) == fix.from).then_some(fix.to)
}

/// Write the corrections into the RAW project value.
///
/// The raw `Value` is what `load_project` hands back and what the editor's next
/// save writes out, and it carries fields this build knows nothing about — a
/// newer build's, or a hand-added one; tolerating them is a stated property of
/// the format. Re-serializing the typed `ProjectFile` over it would silently
/// drop every one of them, so the repair edits exactly the numbers it owns and
/// leaves the rest of the document untouched.
fn apply_dim_fixes(value: &mut Value, fixes: &[DimFix], canvas: Option<(u32, u32)>) {
    for fix in fixes {
        if let Some(entry) = value
            .get_mut("media")
            .and_then(|m| m.get_mut(fix.index))
            .and_then(Value::as_object_mut)
        {
            entry.insert("width".into(), fix.to.0.into());
            entry.insert("height".into(), fix.to.1.into());
        }
    }
    if let Some((w, h)) = canvas {
        if let Some(timeline) = value.get_mut("timeline").and_then(Value::as_object_mut) {
            timeline.insert("width".into(), w.into());
            timeline.insert("height".into(), h.into());
        }
    }
}

/// One-shot repair for projects saved before `probe_sync` learned to read the
/// display matrix. Gated by the caller on `ROTATION_REPAIR_SCHEMA`, so this
/// runs once in a project's life and never on a load that is already current.
///
/// KNOWN RESIDUE, and the reason it is accepted. Media that could not be read
/// on the one load that repairs the project is stamped as repaired along with
/// everything else, so a clip that happened to be on an unplugged drive that
/// day keeps its stale dimensions afterwards. Relinking re-probes and fixes it
/// — and that load reports it missing, so the user is asked. The alternative,
/// withholding the stamp until every candidate has been read, buys that rare
/// case by making a project with one permanently-deleted clip re-probe all its
/// OTHER clips on every open, for good: a lasting per-load cost traded against
/// a one-off that announces itself. A cloud placeholder (an online-only
/// OneDrive file) is left unread and stamped the same way: probing it would
/// download it, and relink or a later re-import fixes it like the unplugged
/// drive.
///
/// The crops of every transposed clip are clamped into its new box
/// (`clamp_clip_crops`), as the still repair does: a crop authored against the
/// stale landscape box can hang off the portrait one, and the preview clamps
/// x/y while the export does not.
fn repair_rotated_dimensions(
    path: &Path,
    value: &mut Value,
    typed: &ProjectFile,
    recovered: bool,
    read_as: Option<FileStamp>,
) {
    let fixes = rotation_fixes(&typed.media);
    apply_dim_fixes(value, &fixes, transposed_canvas(typed, &fixes));
    for fix in &fixes {
        if let Some(m) = typed.media.get(fix.index) {
            clamp_clip_crops(value, &m.id, fix.to);
        }
    }

    // Persist even when nothing needed correcting. The version stamp is what
    // records that this project has BEEN through the re-probe, and without
    // writing it back every open pays for the probes again — which would make
    // the schema gate, and with it the performance argument for gating at all,
    // pointless.
    persist_repair(path, value, recovered, read_as);
}

/// Write a load-time repair back to the project file.
///
/// Except after a recovery. `atomic_write` rotates the current primary onto
/// the `.bak`, and in a recovery the `.bak` IS the last good copy while the
/// primary is the corrupt (or absent) one — so a write that then failed its
/// second rename would restore the corrupt primary over the only good copy and
/// leave nothing readable at all. A recovered project simply repairs again on
/// the next load until the user's own next save carries it: that costs one
/// load and risks nothing.
///
/// Fail-soft otherwise: a read-only volume or a locked file must not fail the
/// open. The repair is already in `value`, so the user gets a correct project
/// this session and the next load tries again.
///
/// The write is queued on the store worker, behind any save already queued,
/// and happens only while the file still carries `read_as` — the stamp it had
/// when the load read it. The load runs off the worker, so an autosave can
/// land between its read and this write; writing the repaired read over that
/// save would revert it. A skipped repair costs one more repair on the next
/// load, nothing else. No stamp at all (the file could not be stat'd) skips
/// it too.
fn persist_repair(path: &Path, value: &Value, recovered: bool, read_as: Option<FileStamp>) {
    if recovered {
        return;
    }
    let Some(read_as) = read_as else {
        return;
    };
    // Past the load cap, skipped like any other failed write: the file on
    // disk still opens, the repaired one would not. Serialized here, off the
    // worker: only the write itself needs the queue.
    let Ok(bytes) = project_bytes(value) else {
        return;
    };
    let path = path.to_path_buf();
    let _ = on_store_blocking(move || {
        if file_stamp(&path) == Some(read_as) {
            let _ = atomic_write(&path, &bytes);
        }
    });
}

/// Correct the stored size of stills probed before `probe_sync` learned EXIF
/// orientation, and mark every still checked. Returns whether `value` changed.
///
/// A photo shot in portrait is usually CODED landscape with orientation 6 or
/// 8, and ffmpeg autorotates it on decode, so the old probe stored the coded
/// pair while the filtergraph received its transpose: a squashed preview and
/// export, and a hard abort as soon as the clip carried a crop wider than the
/// decoded frame or an opacity keyframe. Nothing in the JSON reveals it; the
/// file's header does.
///
/// Runs on EVERY load, not behind a schema gate (owner's decision: no schema
/// bump for this). What keeps that cheap is the `oriented` flag — a flagged
/// still is skipped without touching its file, bar the one header-read
/// recheck below — and what keeps it CORRECT is that the repair is idempotent
/// without the flag: it only fires while the stored pair is exactly the one
/// its header says is wrong, which a repaired entry never is again. So a copy
/// that loses the flag costs one header read, never a second transposition.
/// Only a flag that is literally `true` counts; any other value from a
/// hand-edited file is simply checked and replaced.
///
/// The header decides who is a CANDIDATE; ffmpeg decides the turn. The sniff
/// is knowingly more lenient than ffmpeg's EXIF parser — ffmpeg drops the
/// whole block, orientation and all, over one out-of-line value past its end
/// (`media/exif.rs`) — so trusting it alone would transpose a still that was
/// stored RIGHT and write that down for good. So, for a still whose tag the
/// app follows (whose tag the WebView ignores is below):
/// - Sniff 1..=4, a stored pair that is not the coded pair, or a square:
///   flagged, and no process spawned. Nothing here can be the stale case.
/// - Sniff 5..=8 with the stored pair exactly the coded pair: the same
///   frame-level ffprobe import uses (`probe::frame_transposes`). A quarter
///   turn → transposed and flagged; no turn (ffmpeg rejected the block) →
///   flagged, size untouched; the probe FAILED → nothing changes and nothing
///   is flagged, so the next load asks again.
/// - Sniff `None` (a header the sniff will not vouch for: unknown format, a
///   capped walk, two Exif blocks, an orientation entry it cannot read): left
///   alone and unflagged, with no process — the same as a file that fails
///   identity. Import sends such a file to the frame probe; the load path does
///   not pay a process per load for one, only the header re-read.
///
/// Cost: the frame probe (~120 ms on a 12 MP JPEG) only ever runs for a still
/// stored by the pre-fix probe with a turned header, and once it answers the
/// flag retires it. KNOWN RESIDUE: such a still whose frame never decodes
/// (a corrupt body behind a good header) pays that probe on every load until
/// it is relinked — rare, legacy-only (today's import stores the transpose,
/// which never matches the coded pair again), and a bounded cost, where
/// flagging it unconfirmed would vouch for a size nobody measured.
///
/// Whose rule the still follows is decided per FILE from the same header read
/// (`exif::read_still`, the function the probe asks). A still the WebView
/// draws unturned — any WebP or TIFF, a PNG whose image data comes before any
/// eXIf — is right at its CODED size by design: it is stamped
/// `noAutorotate: true` (with `oriented`) and never sent to the frame probe.
/// Stored at the TRANSPOSE of that coded pair (not square), it is transposed
/// BACK to it first and its clips' crops clamped into the coded box — the
/// forward repair's mirror — because a stamp alone would make the export
/// decode the coded frame against a turned size: the hard-abort shape. That
/// brings a late-eXIf PNG imported by 0.8.1 (stored coded, exported
/// autorotated, so turned in the export alone) into line — the stamp makes
/// the export stop turning it — and equally a copy that lost `oriented`
/// after a build that followed ffmpeg's turn had stored it turned. A flagged
/// still whose header gives no size is left alone and unflagged: which way
/// it is stored cannot be told. Every still that follows ffmpeg and is
/// checked loses any `noAutorotate` it carries, so the two flags always agree
/// with one header read.
///
/// The one flagged entry the `oriented` skip would hide: a PNG or WebP (by
/// its recorded `vcodec` / `container`) stamped `oriented` WITHOUT
/// `noAutorotate`. Earlier builds of this rule flagged fewer files — one
/// followed ffmpeg's turn on every tagged PNG and WebP and stored them turned,
/// the next flagged a PNG only when a tail search FOUND a late tag, missing
/// one past its window — so their stamp can sit on a file today's rule flags.
/// Such an entry is re-read with `exif::read_flag` (chunk headers only, never
/// the tail search) behind the same identity and placeholder checks, and
/// settled exactly as above, once: the stamp it gains ends the recheck. One
/// the rule still follows — a PNG with an eXIf before its image data — is
/// left as it was stamped, and so pays that one small header read on every
/// load: rare files, whose settled answer no stamp records.
///
/// Order: identity, then placeholder, then header, then the frame probe.
/// Nothing may open the file before the placeholder check has said it is
/// local — the header read included, and the frame probe above all, which
/// would download an online-only file whole. A file that fails the identity
/// check is the relink path's business, exactly as for the video repair; a
/// cloud placeholder is left unflagged, so it is looked at on a later load
/// once it is local.
///
/// The canvas is never turned. `addMedia` does not adopt a canvas from a
/// still, but `openMediaAsProject` (a quick-view / viewer temp project of a
/// photo) does size the canvas from it — such a project repaired here keeps
/// its old canvas and letterboxes the still, which is safe: nothing is
/// cropped away and export matches the preview. Silently reshaping a canvas
/// the user may have composed on would not be. The CROPS of the transposed
/// still's clips are clamped into the new box (`clamp_clip_crops`).
fn repair_still_orientation(value: &mut Value, media: &[schema::MediaRef]) -> bool {
    repair_still_orientation_with(value, media, crate::media::probe::frame_transposes)
}

/// `repair_still_orientation` with the frame probe injected, so the tests can
/// pin exactly when it runs and what a failure does.
fn repair_still_orientation_with(
    value: &mut Value,
    media: &[schema::MediaRef],
    mut frame_transposes: impl FnMut(&str) -> Option<bool>,
) -> bool {
    let mut fixes = Vec::new();
    // Every still this load settled, with its per-file `noAutorotate`.
    let mut checked: Vec<(usize, bool)> = Vec::new();
    for (index, m) in media.iter().enumerate() {
        if m.kind != "image" || m.generator.is_some() {
            continue;
        }
        let oriented = value
            .get("media")
            .and_then(|a| a.get(index))
            .and_then(|e| e.get("oriented"))
            == Some(&Value::Bool(true));
        // Stamped by a build whose rule flagged fewer files (see above).
        let recheck = oriented && m.no_autorotate != Some(true) && recorded_png_or_webp(m);
        if oriented && !recheck {
            continue;
        }
        // Identity, then placeholder, then the header — nothing may open the
        // file before the placeholder check has said it is local.
        if !identity_intact(m) || is_cloud_placeholder(Path::new(&m.path)) {
            continue;
        }
        if recheck {
            // Headers only: this runs on every load for a PNG the rule
            // follows, so it must never reach the sniff's tail search.
            let flag = crate::media::exif::read_flag(Path::new(&m.path));
            if flag.no_autorotate {
                settle_unturned(index, m, flag.coded, &mut fixes, &mut checked);
            }
            continue;
        }
        let still = crate::media::exif::read_still(Path::new(&m.path));
        if still.no_autorotate {
            settle_unturned(index, m, still.coded, &mut fixes, &mut checked);
            continue;
        }
        let Some(sniff) = still.sniff else {
            continue;
        };
        if let (Some(w), Some(h)) = (m.width, m.height) {
            // A square's transpose is itself: flagged below, never probed.
            if sniff.transposes() && w != h && (w, h) == sniff.coded {
                match frame_transposes(&m.path) {
                    Some(true) => fixes.push(DimFix { index, from: (w, h), to: (h, w) }),
                    Some(false) => {}
                    None => continue,
                }
            }
        }
        checked.push((index, false));
    }
    apply_dim_fixes(value, &fixes, None);
    for fix in &fixes {
        if let Some(m) = media.get(fix.index) {
            clamp_clip_crops(value, &m.id, fix.to);
        }
    }
    for &(index, no_autorotate) in &checked {
        if let Some(entry) = value
            .get_mut("media")
            .and_then(|a| a.get_mut(index))
            .and_then(Value::as_object_mut)
        {
            entry.insert("oriented".into(), Value::Bool(true));
            if no_autorotate {
                entry.insert("noAutorotate".into(), Value::Bool(true));
            } else {
                entry.remove("noAutorotate");
            }
        }
    }
    !checked.is_empty()
}

/// Settle a still every decoder in the app opens `-noautorotate`: its CODED
/// size is the right one, so a stored pair that is exactly its transpose (not
/// square — `is_transposition`) is turned back to it, and the still is
/// stamped. Any other stored pair is stamped as it is — the relink path's
/// business if it is a different file, as for every still. No `coded` at all
/// (a header that gives no size) settles nothing: which way the entry is
/// stored cannot be told, and a stamp against a turned size is the abort.
fn settle_unturned(
    index: usize,
    m: &schema::MediaRef,
    coded: Option<(u32, u32)>,
    fixes: &mut Vec<DimFix>,
    checked: &mut Vec<(usize, bool)>,
) {
    let Some(coded) = coded else {
        return;
    };
    if let (Some(w), Some(h)) = (m.width, m.height) {
        if is_transposition((w, h), coded) {
            fixes.push(DimFix { index, from: (w, h), to: coded });
        }
    }
    checked.push((index, true));
}

/// Whether a still's entry records a PNG or a WebP — by the codec or the
/// demuxer the probe stored, either being enough. The two formats an earlier
/// build of the per-file rule could stamp `oriented` while withholding the
/// `noAutorotate` today's rule gives them (`repair_still_orientation`).
fn recorded_png_or_webp(m: &schema::MediaRef) -> bool {
    matches!(m.vcodec.as_deref(), Some("png" | "webp"))
        || matches!(m.container.as_deref(), Some("png_pipe" | "webp_pipe"))
}

/// `CROP_MIN` in `src/editor/preview/canvas-math.ts`: the smallest crop
/// extent, in source px, the editor lets a crop shrink to.
const CROP_MIN: f64 = 8.0;

/// Clamp the crop of every clip of `media_id` (on any track) into a frame of
/// `(w, h)` — `clampCrop` in `src/editor/preview/canvas-math.ts`, number for
/// number, which is what relink runs after its own change of dimensions
/// (`clampClipCrops`, src/editor/media/relink.ts).
///
/// Why here: a crop authored against the stale landscape box can hang off
/// the new portrait one, and nothing on the load path clamps it against the
/// media's size — `sanitizeProject` (src/core/project.ts) only drops crops
/// that are not rectangles. The export builder then clamps w/h but not x/y,
/// while the preview clamps all four, so the two would show different parts
/// of the photo. Clamping once, here, makes the stored crop the one both see.
///
/// Only a crop `sanitizeCrop` would KEEP is touched — four finite numbers,
/// x/y >= 0, w/h > 0. Anything else it drops, and clamping it first would
/// resurrect it (`f64::max` quietly discards a NaN that `Math.max` spreads).
/// A crop is rewritten only when a component moves, and whole values are
/// written as integers, so an untouched crop stays byte-identical.
fn clamp_clip_crops(value: &mut Value, media_id: &str, (w, h): (u32, u32)) {
    let (sw, sh) = (f64::from(w), f64::from(h));
    let Some(tracks) = value
        .get_mut("timeline")
        .and_then(|t| t.get_mut("tracks"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for track in tracks {
        let Some(clips) = track.get_mut("clips").and_then(Value::as_array_mut) else {
            continue;
        };
        for clip in clips {
            if clip.get("mediaId").and_then(Value::as_str) != Some(media_id) {
                continue;
            }
            let Some(crop) = clip
                .get_mut("transform")
                .and_then(|t| t.get_mut("crop"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            let num = |k: &str| crop.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
            let (Some(x), Some(y), Some(cw), Some(ch)) = (num("x"), num("y"), num("w"), num("h")) else {
                continue;
            };
            if x < 0.0 || y < 0.0 || cw <= 0.0 || ch <= 0.0 {
                continue;
            }
            let clamp = |v: f64, lo: f64, hi: f64| v.max(lo).min(hi);
            let nw = clamp(cw, CROP_MIN, sw);
            let nh = clamp(ch, CROP_MIN, sh);
            let nx = clamp(x, 0.0, sw - nw);
            let ny = clamp(y, 0.0, sh - nh);
            let nw = nw.min(sw - nx);
            let nh = nh.min(sh - ny);
            for (k, old, new) in [("x", x, nx), ("y", y, ny), ("w", cw, nw), ("h", ch, nh)] {
                if new != old {
                    crop.insert(k.into(), json_number(new));
                }
            }
        }
    }
}

/// A finite `f64` as JSON: an integer when it is a whole number (what every
/// crop the editor writes is, and what `clampCrop` keeps whole numbers at),
/// a float otherwise.
fn json_number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
    }
}

/// Off the UI thread, and off the store worker: a load reads and parses up to
/// 512 MB, stats every media file (an SMB timeout each on a dead share) and may
/// spend a probe per stale clip, none of which may hold up a save. Its two
/// writes — a repair and the recents stamp — are queued (`persist_repair`,
/// `stamp_opened`).
#[tauri::command]
pub async fn load_project(path: String) -> Result<LoadedProject> {
    off_ui(move || load_project_now(&path)).await
}

/// `load_project`'s body.
fn load_project_now(path: &str) -> Result<LoadedProject> {
    let p = Path::new(path);
    // Before the read, so a save landing at any point after it changes the
    // stamp the repair write checks.
    let read_as = file_stamp(p);
    let (raw, recovered) = read_project_value(p)?;
    let schema::Migrated { mut value, from } = schema::migrate(raw)?;
    let typed: ProjectFile = ProjectFile::deserialize(&value)
        .map_err(|e| AppError::BadInput(format!("invalid project file: {e}")))?;
    // A drawing is an image project's layer; in a video project it is a
    // crafted or damaged file, refused before the editor sees it. The full
    // stroke validation is NOT run here: a damaged stroke must not make an
    // image project unopenable (the image editor drops it with a notice), and
    // `save_project` re-validates everything it writes.
    image_rules::refuse_misplaced_drawings(&typed)?;

    // Verify media identity (path exists + size/mtime match). Generated media
    // (text/solid) has no file identity — its `path` is a display label.
    let mut missing = Vec::new();
    for m in &typed.media {
        if m.generator.is_none() && !identity_intact(m) {
            missing.push(m.id.clone());
        }
    }

    // Projects written before the display-matrix fix carry a rotated clip's
    // CODED dimensions, and a canvas adopted from them. Nothing in the JSON can
    // reveal that, so repair it against the files themselves — once, gated on
    // the schema stamp, because doing it on every open is an ffprobe per clip
    // on a path the user is waiting on.
    //
    // Stills first, and ungated (header reads, and only for unflagged stills;
    // a frame probe only for one whose header says it was stored stale),
    // so that when the video repair runs its one write carries both; otherwise
    // the still repair writes on its own, and only when it changed something.
    let stills_changed = repair_still_orientation(&mut value, &typed.media);
    if from < schema::ROTATION_REPAIR_SCHEMA {
        repair_rotated_dimensions(p, &mut value, &typed, recovered, read_as);
    } else if stills_changed {
        persist_repair(p, &value, recovered, read_as);
    }

    // Stamp openedAt on this path's recents entry (create it if absent — a
    // freshly opened file may not be in the list yet). Temp quick-view projects
    // are deliberately excluded from recents, so they are never stamped.
    if !is_temp_project_path(path) {
        stamp_opened(path, &typed);
    }

    Ok(LoadedProject {
        project: value,
        missing,
        recovered,
    })
}

/// The recents `kind` of a project: `Some("image")` for an image project, and
/// `None` — no key written — for a video one, whatever else its `kind` holds.
fn recent_kind(typed: &ProjectFile) -> Option<String> {
    (typed.kind.as_deref() == Some("image")).then(|| "image".to_string())
}

/// The duration a recents card shows. An image project has none: its layers
/// are one-unit clips (`srcOut 1`), so the timeline arithmetic would put a
/// "0:01" on a picture's card.
fn recent_duration(typed: &ProjectFile) -> f64 {
    if recent_kind(typed).is_some() {
        0.0
    } else {
        finite_duration(typed.timeline.duration())
    }
}

/// Record that `path` was just opened. Updates the existing recents entry's
/// `opened_at`, or inserts a fresh entry built from the loaded project.
///
/// Queued on the store worker and NOT waited for: it is best-effort like
/// every recents side effect, and a load must not wait behind a slow save of
/// some other project for a timestamp. Queued before the load returns, so it
/// is ahead of any save the editor makes of this project after opening it.
fn stamp_opened(path: &str, typed: &ProjectFile) {
    let fresh = RecentItem {
        path: path.to_string(),
        name: clipped(&typed.name, RECENT_NAME_MAX_CHARS),
        modified_at: clipped(&typed.modified_at, RECENT_STAMP_MAX_CHARS),
        duration_sec: recent_duration(typed),
        thumb: None,
        size_bytes: 0,
        opened_at: Some(now_iso8601()),
        kind: recent_kind(typed),
    };
    submit_to_store(Box::new(move || {
        let mut fresh = fresh;
        fresh.size_bytes = std::fs::metadata(&fresh.path).map(|m| m.len()).unwrap_or(0);
        let _ = update_recents(|index| {
            if let Some(entry) = index.items.iter_mut().find(|r| r.path == fresh.path) {
                entry.opened_at = fresh.opened_at;
            } else {
                index.items.insert(0, fresh);
                index.items.truncate(MAX_RECENTS);
            }
            true
        });
    }));
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    pub modified_at: String,
}

/// The media the recents grid uses as a project's thumbnail: the earliest
/// visual clip across all video tracks. `None` when no video-track clip exists
/// (generator-only / audio-only projects keep the placeholder by design).
///
/// Selection: gather every clip on a `kind == "video"` track, ordered by
/// `timelineStart` ascending, tie-broken by topmost track (lowest track index).
/// An empty topmost track no longer hides a lower track's clip. The earliest
/// candidate whose media resolves to a non-audio source wins; audio-kind media
/// on a video track (shouldn't happen, but be defensive) is skipped in favor of
/// the next candidate so the thumbnail is always a real frame.
fn first_clip_media(typed: &ProjectFile) -> Option<&schema::MediaRef> {
    // (timelineStart, track index) sort key selects the earliest clip, breaking
    // ties toward the topmost track. Track order is topmost-first, so a lower
    // index means a higher (more visible) track.
    let mut candidates: Vec<(f64, usize, &schema::Clip)> = typed
        .timeline
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == "video")
        .flat_map(|(ti, t)| t.clips.iter().map(move |c| (c.timeline_start, ti, c)))
        .collect();
    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));

    candidates.into_iter().find_map(|(_, _, clip)| {
        let media = typed.media.iter().find(|m| m.id == clip.media_id)?;
        // Prefer a visual result: skip audio-kind media (defensive — video
        // tracks shouldn't carry audio) so the next candidate gets a chance.
        (media.kind != "audio").then_some(media)
    })
}

/// The cache is looked up, never required: it only supplies the recents
/// card's thumbnail, and main.rs runs without one when `%LOCALAPPDATA%` is
/// unusable — a `State` parameter there failed EVERY save before its body ran.
///
/// Queued on the store worker: never on the UI thread, never beside another
/// write.
///
/// The request is `{ path, project }` either way it arrives. As a JSON body,
/// tauri's ipc handler parses it whole on the WebView's UI thread before this
/// command exists — for a large image project, a hitch on every autosave. As
/// RAW bytes (`Uint8Array`, the way `image_save_chunk` sends its chunks) it
/// is only copied there, and parsed here, on the store worker.
#[tauri::command]
pub async fn save_project(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<SavedProject> {
    use tauri::Manager;
    let body = save_body(request.body())?;
    let cache = app.try_state::<Arc<crate::cache::Cache>>().map(|c| Arc::clone(&c));
    on_store(move || {
        let (path, project) = body.into_parts()?;
        save_project_at(cache.as_deref(), path, project)
    })
    .await
}

/// A save request as it arrived: already parsed (a JSON body), or the bytes
/// of one, parsed only on the store worker.
enum SaveBody {
    Parsed(String, Value),
    Raw(Vec<u8>),
}

#[derive(Deserialize)]
struct SaveRequest {
    path: String,
    project: Value,
}

/// The most a raw request may hold: the project's own cap, plus room for the
/// path and the wrapper around it. Refused before it is parsed.
const MAX_SAVE_REQUEST_BYTES: u64 = image_rules::MAX_TRT_BYTES + 64 * 1024;

fn save_body(body: &tauri::ipc::InvokeBody) -> Result<SaveBody> {
    save_body_within(body, MAX_SAVE_REQUEST_BYTES)
}

/// `save_body` against any cap, so a test need not build a 512 MB body.
fn save_body_within(body: &tauri::ipc::InvokeBody, cap: u64) -> Result<SaveBody> {
    let bad = |what: &str| AppError::BadInput(format!("invalid save request: {what}"));
    match body {
        tauri::ipc::InvokeBody::Json(v) => {
            let path = v.get("path").and_then(Value::as_str).ok_or_else(|| bad("no path"))?;
            let project = v.get("project").ok_or_else(|| bad("no project"))?;
            Ok(SaveBody::Parsed(path.to_owned(), project.clone()))
        }
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() as u64 > cap => {
            Err(bad("too large"))
        }
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(SaveBody::Raw(bytes.clone())),
    }
}

impl SaveBody {
    fn into_parts(self) -> Result<(String, Value)> {
        match self {
            SaveBody::Parsed(path, project) => Ok((path, project)),
            SaveBody::Raw(bytes) => serde_json::from_slice::<SaveRequest>(&bytes)
                .map(|r| (r.path, r.project))
                .map_err(|e| AppError::BadInput(format!("invalid save request: {e}"))),
        }
    }
}

/// The path a project is written to or deleted at, refused unless it is
/// plainly a project file: an absolute `.trt` (any case) on a drive or a
/// share, with no device form (`\\.\`, `\\?\`) and no alternate data stream.
///
/// Defence in depth for a compromised webview, which could otherwise hand
/// these commands any path at all: delete any file of the user's (plus its
/// `.bak`), or overwrite one with project JSON. It does NOT close every such
/// sink — an export's output path is an arbitrary write by design — it keeps
/// the project commands from being two more. Every path the app itself passes
/// comes from `new_project_path`, `temp_project_path`, rename/duplicate (all
/// `.trt` by construction) or a `.trt` the user opened.
fn project_target(path: &str) -> Result<&Path> {
    let refuse = || Err(AppError::BadInput(format!("not a Taroting project path: {path}")));
    let starts = |prefix: &str| {
        path.chars()
            .take(4)
            .map(|c| if c == '/' { '\\' } else { c })
            .eq(prefix.chars())
    };
    if path.contains('\0') || crate::media::source::is_device_path(path) || starts(r"\\?\") {
        return refuse();
    }
    let p = Path::new(path);
    if !p.is_absolute() || !crate::media::source::is_file_namespace(p) {
        return refuse();
    }
    // A colon past the drive names a stream of some other file ("a.txt:x.trt"
    // writes into a.txt). The drive's own colon lives in the prefix component.
    let stream = p.components().any(|c| match c {
        std::path::Component::Normal(s) => s.to_string_lossy().contains(':'),
        _ => false,
    });
    if stream || !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("trt")) {
        return refuse();
    }
    Ok(p)
}

/// `(at_sec, cache suffix)` of the frame a project card shows: the frame the
/// editor's bin asks `get_thumbnail` for (half the clip, at most half a
/// second in), so the card and the bin share one cached file. The suffix is
/// `ensure_thumb`'s own spelling (src/media/thumbs.rs), byte for byte; the
/// save-time lookup below is only a hit while the two agree, which a test
/// pins.
pub(crate) fn card_thumb_frame(duration: f64) -> (f64, String) {
    let at = (duration / 2.0).clamp(0.0, 0.5);
    (at, format!("_{}.jpg", (at * 1000.0) as u64))
}

/// The cached card thumbnail of `media`, if one exists: the exact file for the
/// card's frame first (one stat), then any frame of that media (a whole
/// thumbs-directory listing) only when that misses. Every autosave asks this,
/// and the listing used to run on every one of them. `is_file`, not
/// `existing_file`: a save is not a use of the thumbnail, so it must not
/// touch the cache's LRU index.
fn cached_card_thumb(cache: &crate::cache::Cache, media: &schema::MediaRef) -> Option<PathBuf> {
    let hash = crate::cache::MediaKey {
        path: media.path.clone(),
        size: media.size,
        mtime_ms: media.mtime_ms,
    }
    .hash();
    let (_, suffix) = card_thumb_frame(media.duration);
    let exact = cache.file_path(crate::cache::CacheKind::Thumbs, &hash, &suffix);
    if exact.is_file() {
        return Some(exact);
    }
    crate::media::thumbs::any_thumb_for(cache, &hash)
}

/// `save_project` minus the Tauri state wrapper, so the tests can drive the
/// real save path (validation, write, recents) against a scratch cache.
fn save_project_at(cache: Option<&crate::cache::Cache>, path: String, project: Value) -> Result<SavedProject> {
    save_project_within(cache, path, project, image_rules::MAX_TRT_BYTES)
}

/// `save_project_at` against any size cap (`project_bytes_within`).
fn save_project_within(
    cache: Option<&crate::cache::Cache>,
    path: String,
    project: Value,
    cap: u64,
) -> Result<SavedProject> {
    let target = project_target(&path)?;
    // Validate before writing — never persist something we can't read back.
    let typed: ProjectFile = ProjectFile::deserialize(&project)
        .map_err(|e| AppError::BadInput(format!("refusing to save invalid project: {e}")))?;
    // The typed parse is lenient about image-project content (a damaged
    // stroke is skipped, not refused), so it proves the shape of nothing
    // there: the raw value about to be written is checked instead. For a
    // video project this is the drawing refusal plus the schema/kind pairing
    // the loader insists on; everything else is image-only.
    let refuse = |e: AppError| match e {
        AppError::BadInput(m) => AppError::BadInput(format!("refusing to save invalid project: {m}")),
        other => other,
    };
    image_rules::refuse_misplaced_drawings(&typed).map_err(refuse)?;
    image_rules::check_schema_kind(&typed).map_err(refuse)?;
    image_rules::validate_image_project(&project, &typed).map_err(refuse)?;
    let image = recent_kind(&typed).is_some();

    // Sized BEFORE the file is touched: a refusal leaves the previous save
    // (and its `.bak`) exactly as they were.
    let bytes = project_bytes_within(&project, cap)?;
    atomic_write(target, &bytes)?;

    // Temp quick-view projects (autosaved to the temp dir) must never enter
    // recents. Pressing Back re-saves to a permanent Documents path, which does
    // upsert. Skip both the thumb lookup and the upsert for temp-dir paths.
    if !is_temp_project_path(&path) {
        // Thumbnail for the recents grid: the cached card frame of the first
        // clip's media. Never for an image project: its card is the rendered
        // picture the image editor writes, and the raw first photo would
        // overwrite it (`upsert_recent` keeps the card's current thumb
        // instead). Never for a generator or audio first clip either: neither
        // has a frame in the cache (the same rule as `thumb_source_for`), so
        // looking would only ever be a full directory listing that misses.
        let thumb = (!image)
            .then(|| first_clip_media(&typed))
            .flatten()
            .filter(|m| m.generator.is_none() && m.kind != "audio")
            .and_then(|m| cache.and_then(|c| cached_card_thumb(c, m)))
            .map(|p| p.to_string_lossy().into_owned());

        // Best-effort, like every other recents side effect. The project is
        // already on disk: reporting this save as failed because recents.json
        // was locked by a scanner made autosave say "Save failed" for good,
        // made Keep write "<name> 2.trt" duplicates on retry, and left
        // Duplicate's copy on disk without a card.
        if let Err(e) = upsert_recent(RecentItem {
            path: path.clone(),
            name: typed.name.clone(),
            modified_at: typed.modified_at.clone(),
            duration_sec: recent_duration(&typed),
            thumb,
            size_bytes: 0, // filled by upsert_recent via fs metadata
            opened_at: None, // preserved from any prior entry by upsert_recent
            kind: recent_kind(&typed),
        }) {
            eprintln!("Taroting: saved {path}, but the recent projects list was not updated ({e})");
        }
    }

    Ok(SavedProject {
        modified_at: typed.modified_at,
    })
}

/// The media key + frame offset a project's thumbnail should come from, or
/// `None` when no real frame is possible: unreadable project, no clips, a
/// generator/audio first clip (no file / no frame), or a source file that is
/// missing or changed on disk. Pure and ffmpeg-free so the skip paths are
/// unit-testable; `refresh_recent_thumb` layers cache lookup + generation on top.
fn thumb_source_for(path: &str) -> Option<(crate::cache::MediaKey, f64)> {
    let (raw, _) = read_project_value(Path::new(path)).ok()?;
    let typed: ProjectFile = serde_json::from_value(schema::migrate(raw).ok()?.value).ok()?;
    // An image project's card is the rendered picture its editor writes; a
    // frame of its first photo would replace it on every Home mount (and
    // after a cache eviction, until the next edit renders a new one).
    if typed.kind.as_deref() == Some("image") {
        return None;
    }

    // Generated media (text/solid) has no file; audio has no frame. Both are
    // skipped exactly as the editor's bin does — placeholder is acceptable.
    let media = first_clip_media(&typed)?;
    if media.generator.is_some() || media.kind == "audio" {
        return None;
    }
    // The source must exist and match identity (size + mtime) before we hand a
    // path to ffmpeg — a stale/replaced file would otherwise yield a wrong or
    // failed frame. The same rule `load_project`'s missing-media scan applies.
    // Nor an online-only cloud file: decoding one frame downloads it whole,
    // and Home must never pull a video down just to draw a card.
    if !identity_intact(media) || is_cloud_placeholder(Path::new(&media.path)) {
        return None;
    }

    let key = crate::cache::MediaKey {
        path: media.path.clone(),
        size: media.size,
        mtime_ms: media.mtime_ms,
    };
    // `at_sec` matches the editor bin's frame choice so both reuse one cached file.
    let (at, _) = card_thumb_frame(media.duration);
    Some((key, at))
}

/// One lazily-taken listing of the thumbs cache directory, reused for a whole
/// batch of lookups.
///
/// `media::thumbs::any_thumb_for` does a full `read_dir` per call, so resolving
/// N recents cards meant N complete scans of that directory on every home mount.
/// The listing is only taken once a lookup actually needs it, so a batch whose
/// projects all skip (generator-only, audio-only, missing source) still scans
/// nothing at all.
struct ThumbListing<'a> {
    cache: &'a crate::cache::Cache,
    entries: Option<Vec<(String, PathBuf)>>,
}

impl<'a> ThumbListing<'a> {
    fn new(cache: &'a crate::cache::Cache) -> Self {
        ThumbListing { cache, entries: None }
    }

    /// First cached thumb whose file name starts with `hash`, in `read_dir`
    /// order — the same choice `any_thumb_for` makes for the same directory.
    fn find(&mut self, hash: &str) -> Option<PathBuf> {
        let cache = self.cache;
        let entries = self.entries.get_or_insert_with(|| {
            let dir = cache
                .root()
                .join(crate::cache::CacheKind::Thumbs.dir_name());
            std::fs::read_dir(dir)
                .map(|read| {
                    read.flatten()
                        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
                        .collect()
                })
                .unwrap_or_default()
        });
        entries
            .iter()
            .find(|(name, _)| name.starts_with(hash))
            .map(|(_, path)| path.clone())
    }

    /// Register a thumb generated during this batch so a later card sharing the
    /// same source media hits the listing instead of the filesystem.
    fn record(&mut self, path: &Path) {
        let (Some(entries), Some(name)) = (self.entries.as_mut(), path.file_name()) else {
            return;
        };
        entries.push((name.to_string_lossy().into_owned(), path.to_path_buf()));
    }
}

/// Resolve a thumbnail for each of `paths`, then persist all of them with ONE
/// recents read + write. Returns `(project path, thumb path)` for the projects
/// that resolved, in input order; the rest are simply absent (fail-soft).
///
/// The batching is the whole point: `atomic_write` is five filesystem
/// operations, so a home mount with a dozen thumb-less cards used to spend ~48
/// of them on recents.json — plus one full thumbs-directory scan per card.
fn refresh_thumbs_for(
    cache: &crate::cache::Cache,
    jobs: &crate::jobs::Jobs,
    paths: &[String],
) -> Vec<(String, String)> {
    let mut listing = ThumbListing::new(cache);
    let mut resolved: Vec<(String, String)> = Vec::new();

    for path in paths {
        let Some((key, at)) = thumb_source_for(path) else {
            continue;
        };
        // Prefer an already-cached thumb; only spend ffmpeg when it is cold.
        let thumb = match listing.find(&key.hash()) {
            Some(hit) => Some(hit),
            None => crate::media::thumbs::ensure_thumb(cache, jobs, &key, at).ok(),
        };
        let Some(thumb) = thumb else { continue };
        listing.record(&thumb);
        resolved.push((path.clone(), thumb.to_string_lossy().into_owned()));
    }

    // Persist so future mounts skip generation. Best-effort: a write failure
    // just means we regenerate next time. Only this write-back holds the
    // recents lock; the ffmpeg work above never does.
    if !resolved.is_empty() {
        let _ = update_recents(|index| {
            let mut changed = false;
            for (path, thumb) in &resolved {
                if let Some(entry) = index.items.iter_mut().find(|r| r.path == *path) {
                    if entry.thumb.as_deref() != Some(thumb.as_str()) {
                        entry.thumb = Some(thumb.clone());
                        changed = true;
                    }
                }
            }
            changed
        });
    }

    resolved
}

/// Backfill a recents card's thumbnail after the fact. `load_project` /
/// `stamp_opened` and the open-with flow can create a recents entry before any
/// thumbnail is cached (thumbs are generated lazily by the editor's bin), so
/// cards opened via the OS "Open with" show a placeholder until the next save.
/// The home screen calls this for every thumb-less card on mount.
///
/// Resolves the first clip's file-backed media and returns a thumb path from
/// the cache — generating one on the thumb lane if absent. Fails soft: any
/// error (unparseable project, no clips, generator/audio-only media,
/// missing/changed source file, ffmpeg failure) yields `Ok(None)` so the home
/// screen is never blocked or toasted. On success the recents entry's `thumb`
/// is persisted so subsequent mounts hit the cache without ffmpeg.
///
/// A whole mount's worth of cards should go through `refresh_recent_thumbs`
/// instead; this single-path form is kept for one-off callers and is a literal
/// one-element batch, so the two can never drift apart.
#[tauri::command]
pub async fn refresh_recent_thumb(
    cache: tauri::State<'_, Arc<crate::cache::Cache>>,
    jobs: tauri::State<'_, Arc<crate::jobs::Jobs>>,
    path: String,
) -> Result<Option<String>> {
    // At most one entry can come back for one input path.
    refresh_recent_thumbs(cache, jobs, vec![path])
        .await
        .map(|m| m.into_values().next())
}

/// Batched `refresh_recent_thumb`: same resolution rules, same fail-soft
/// behavior, but one thumbs-directory scan and one recents read/write for the
/// entire home mount instead of one of each per card.
///
/// Returns a map of project path → thumb path containing ONLY the projects that
/// resolved; a project that skips (or whose generation fails) is absent, which
/// is the batched equivalent of the single-path `null`.
///
/// Generation is sequential, so on a cold thumbnail cache the whole batch
/// answers together rather than card by card — callers wanting progressive fill
/// should chunk their paths.
///
/// Off the UI thread, where a batch of cold cards used to freeze the window
/// for up to 30 s each, and off the store worker: ffmpeg must never hold up a
/// save. Its one write, the recents write-back, holds `RECENTS_LOCK` like
/// every other recents update.
#[tauri::command]
pub async fn refresh_recent_thumbs(
    cache: tauri::State<'_, Arc<crate::cache::Cache>>,
    jobs: tauri::State<'_, Arc<crate::jobs::Jobs>>,
    paths: Vec<String>,
) -> Result<HashMap<String, String>> {
    let (cache, jobs) = (Arc::clone(&cache), Arc::clone(&jobs));
    off_ui(move || Ok(refresh_thumbs_for(&cache, &jobs, &paths).into_iter().collect())).await
}

/// One stat — but a stat of a path on a sleeping share is an SMB timeout, so
/// it is still off the UI thread.
#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool> {
    off_ui(move || Ok(path_exists_now(Path::new(&path)))).await
}

/// `path_exists`'s body. The editor asks it about media `load_project`
/// reported missing — paths a `.trt` gave — so a share off the local network
/// answers "does not exist" without being looked at
/// (`media::source::may_touch`): the stat alone would connect to whatever
/// server a crafted project names and hand it the user's sign-in, the very
/// stat the load's own scan declined to make. `media_stat` is the plain
/// metadata read `exists()` makes.
fn path_exists_now(path: &Path) -> bool {
    may_touch(path) && media_stat(path).is_ok()
}

/// Whether a project name is in use: by its `.trt`, or by a `.bak` the `.trt`
/// is gone from. That `.bak` is a recoverable project with a card on Home
/// (`list_recents`); handing its name to a new project made that card open
/// the new one, and the new one's second save rotated over the old `.bak` —
/// the last copy of the old work.
fn name_taken(candidate: &Path) -> bool {
    candidate.exists() || bak_path(candidate).exists()
}

/// Pick a fresh "Untitled N.trt" path in `dir`, deduping with a bare-space
/// suffix ("<base> 2.trt") the way `new_project_path` always has. `base` must
/// already be sanitized. Shared by the permanent (Documents) and temp flows so
/// both name identically.
fn fresh_untitled_in(dir: &Path, base: &str) -> Result<String> {
    for n in 0..1000 {
        let candidate = if n == 0 {
            dir.join(format!("{base}.trt"))
        } else {
            dir.join(format!("{base} {}.trt", n + 1))
        };
        if !name_taken(&candidate) {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err(AppError::BadInput("could not find a free project name".into()))
}

/// Pick a fresh "Untitled N.trt" path in Documents\Taroting. On the store
/// worker, so the name is picked after every write already queued has landed.
#[tauri::command]
pub async fn new_project_path(name: Option<String>) -> Result<String> {
    on_store(move || new_project_path_now(name)).await
}

fn new_project_path_now(name: Option<String>) -> Result<String> {
    let dir = paths::default_projects_dir()?;
    paths::ensure_dir(&dir)?;
    let base = sanitize_filename(&name.unwrap_or_else(|| "Untitled".to_string()));
    fresh_untitled_in(&dir, &base)
}

/// True when `path` lives inside the temp-projects dir. Used to gate recents
/// side effects: quick-view projects there must never appear in recents, so
/// `load_project` skips stamping and `save_project` skips the upsert for them.
/// A resolution failure (no LOCALAPPDATA) yields `false` — the safe default is
/// the classic permanent behavior.
///
/// The same rule as the frontend's `isTempProjectPath` (src/core/open-media.ts),
/// which the editor uses to call a session temporary: `/` read as `\`, case
/// folded, and the folder boundary required. A component-wise `starts_with`
/// was case-sensitive, so a differently-cased path into tmp-projects was
/// temporary to the editor and permanent here — it got a recents entry, and
/// with 24 of them, evicted a real project's card for good.
fn is_temp_project_path(path: &str) -> bool {
    paths::temp_projects_dir()
        .map(|tmp| inside_folded(&tmp.to_string_lossy(), path))
        .unwrap_or(false)
}

/// Whether `path` is inside `dir`, compared as the frontend compares paths
/// (`normalizePath` in open-media.ts): separators unified, case folded, and
/// `dir` plus a separator as the prefix, so a sibling folder that merely
/// starts with the same name ("tmp-projects-old") is not inside it.
fn inside_folded(dir: &str, path: &str) -> bool {
    let fold = |s: &str| s.replace('/', "\\").to_lowercase();
    let dir = fold(dir);
    let dir = dir.trim_end_matches('\\');
    if dir.is_empty() {
        return false;
    }
    fold(path).starts_with(&format!("{dir}\\"))
}

/// The temp-projects dir as a string, for the frontend to classify open-with
/// paths that physically live there as temp (matching the recents exclusion the
/// backend already applies). Cached once per app run on the frontend, so this
/// adds no repeated IPC.
#[tauri::command]
pub fn temp_projects_dir() -> Result<String> {
    Ok(paths::temp_projects_dir()?.to_string_lossy().into_owned())
}

/// Pick a fresh "Untitled N.trt" path in the temp-projects dir. Mirrors
/// `new_project_path` but targets scratch storage for the quick-view flow.
#[tauri::command]
pub async fn temp_project_path(name: Option<String>) -> Result<String> {
    on_store(move || temp_project_path_now(name)).await
}

fn temp_project_path_now(name: Option<String>) -> Result<String> {
    let dir = paths::temp_projects_dir()?;
    paths::ensure_dir(&dir)?;
    let base = sanitize_filename(&name.unwrap_or_else(|| "Untitled".to_string()));
    fresh_untitled_in(&dir, &base)
}

/// How long the startup sweep keeps an edited temporary project nobody came
/// back for. Past this it is deleted like an untouched one: the recover line
/// has been on Home for a month of launches.
const ORPHAN_KEEP_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The edited temporary projects this run's startup sweep kept, by their
/// `.trt` path — what `list_orphan_temp_projects` offers back. Recorded by the
/// sweep, never re-read from the folder: a session this run opens lives in the
/// same folder and is marked edited by its first edit, and a fresh listing
/// would offer the user's own open work back to them as an orphan. New temp
/// names never collide with these: `temp_project_path` skips a name whose
/// `.trt` or `.bak` is on disk (`name_taken`).
static KEPT_ORPHANS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// What the sweep does with one temporary project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanFate {
    /// Edited, and recent: kept and offered back.
    Keep,
    /// Never edited, older than `ORPHAN_KEEP_FOR` or past the size cap:
    /// deleted.
    Delete,
    /// Recent and within the cap, but not parseable — a zeroed or cut-short
    /// file. `atomic_write` does not fsync, so a crash or a power loss can
    /// leave exactly that `.trt` beside a complete `.bak`; the sweep then
    /// judges the `.bak` instead (a load recovers from it). With no `.bak`
    /// behind it, or when the file judged IS the `.bak`, it is deleted.
    Unparseable,
    /// Could not be read (a lock, a permission error): left exactly as it is,
    /// and not offered. The next launch decides again.
    Unknown,
}

/// The one field the sweep reads. `schema::true_or_false` is the editor's own
/// rule — only a literal `true` counts — and every other field is skipped by
/// serde without being built.
#[derive(Deserialize)]
struct TempMarker {
    #[serde(default, rename = "tempEdited", deserialize_with = "schema::true_or_false")]
    temp_edited: bool,
}

/// Decide one temporary project's fate from `file` — its `.trt`, or its
/// `.bak` when a crash left only that.
fn orphan_fate(file: &Path, now: SystemTime) -> OrphanFate {
    let Ok(meta) = std::fs::metadata(file) else {
        return OrphanFate::Unknown;
    };
    // Age first: an old orphan is deleted without being read at all.
    let age = meta
        .modified()
        .ok()
        .and_then(|m| now.duration_since(m).ok())
        .unwrap_or(Duration::ZERO);
    if age > ORPHAN_KEEP_FOR || meta.len() > image_rules::MAX_TRT_BYTES {
        return OrphanFate::Delete;
    }
    let Ok(f) = std::fs::File::open(file) else {
        return OrphanFate::Unknown;
    };
    // Streamed, never read whole: the folder can hold a big image project,
    // and this runs during startup.
    match serde_json::from_reader::<_, TempMarker>(std::io::BufReader::new(f)) {
        Ok(m) if m.temp_edited => OrphanFate::Keep,
        Err(e) if e.is_io() => OrphanFate::Unknown,
        // Not JSON at all, or cut short: torn. Valid JSON of the wrong shape
        // is no project — and a load would not fall back to the `.bak` for
        // it either (`parse_project_bytes` only does for invalid JSON).
        Err(e) if e.is_syntax() || e.is_eof() => OrphanFate::Unparseable,
        _ => OrphanFate::Delete,
    }
}

/// Settle the temp-projects folder at startup and return the projects kept.
///
/// A temporary project's Keep/Discard question is only ever asked on a
/// graceful exit, so a crash, a renderer death, a Windows logoff or restart,
/// the close escape hatch or Task Manager leaves it here, and this sweep used
/// to delete it on the next launch — edits and all, without a trace. Now (the
/// owner's ruling):
/// - an EDITED project (`tempEdited: true`, set by the editor on the first
///   edit and stripped by Keep) is kept and offered back on Home, unless it
///   is older than `ORPHAN_KEEP_FOR`;
/// - an untouched one is deleted, as before — it holds nothing a fresh open
///   of the same file would not;
/// - every `.tmp`, `.part` and other leftover is deleted, and a `.bak` beside
///   a readable `.trt` (the copy that counts). A `.trt` that does not parse —
///   a crash before the OS flushed it can leave it zeroed — defers to its
///   `.bak`: an edited, recent `.bak` keeps both and the `.trt` is offered (a
///   load recovers from the `.bak`). A `.bak` with NO `.trt` is the project itself, mid-save when the
///   app died: it is judged like a `.trt`, kept as it is if edited, and the
///   `.trt` path is what is offered (a load recovers it from the `.bak`).
/// Folders are left alone.
fn sweep_temp_dir(dir: &Path, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new(); // dir absent or unreadable → nothing to settle
    };
    // An ASCII suffix in any case, tested on bytes so a name that only
    // LOWERCASES to one (the Kelvin sign folds to "k") is never sliced
    // mid-character.
    let has_suffix = |name: &str, suffix: &str| {
        name.len() >= suffix.len() && name.as_bytes()[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
    };
    let mut projects: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let p = entry.path();
        let file_name = entry.file_name();
        // A name that is not Unicode is no name this app ever wrote: left be.
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if has_suffix(name, ".trt") {
            projects.push(p);
        } else if has_suffix(name, ".trt.bak") {
            // Judged with its project below, under the project's own name.
            // The four bytes cut are ".bak" itself, so the cut is on a
            // character boundary.
            projects.push(p.with_file_name(&name[..name.len() - 4]));
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }
    projects.sort();
    projects.dedup();

    let mut kept = Vec::new();
    for primary in projects {
        let bak = bak_path(&primary);
        let has_primary = primary.is_file();
        let fate = match orphan_fate(if has_primary { &primary } else { &bak }, now) {
            // A torn primary: the `.bak` decides. Both files stay on Keep —
            // the load reads the primary, finds it corrupt and recovers from
            // the `.bak` (flagged `recovered`), so the `.bak` must survive.
            OrphanFate::Unparseable if has_primary && bak.is_file() => match orphan_fate(&bak, now) {
                OrphanFate::Keep => {
                    kept.push(primary);
                    continue;
                }
                OrphanFate::Unknown => OrphanFate::Unknown,
                _ => OrphanFate::Delete,
            },
            fate => fate,
        };
        match fate {
            OrphanFate::Keep => {
                if has_primary {
                    let _ = std::fs::remove_file(&bak);
                }
                kept.push(primary);
            }
            OrphanFate::Delete | OrphanFate::Unparseable => {
                let _ = std::fs::remove_file(&primary);
                let _ = std::fs::remove_file(&bak);
            }
            OrphanFate::Unknown => {}
        }
    }
    kept
}

/// Settle leftover quick-view scratch projects from earlier runs
/// (`sweep_temp_dir`), and remember the ones kept for Home. ONLY touches the
/// app's own tmp-projects dir; a missing dir or any per-file error is ignored
/// (the next startup retries).
///
/// Synchronous, before the event loop starts: a session this run opens must
/// never meet a sweep still going through its folder.
///
/// Must run from the Builder's `.setup()` hook, never from `main()` directly.
/// A second launch (an Explorer double-click while the app is open) is a whole
/// new process that only exits inside plugin initialisation, when the
/// single-instance plugin forwards its argv to the running window. Anything
/// `main()` does before `Builder::run` therefore also runs in that doomed second
/// process — and a sweep there deleted the LIVE instance's quick-view files.
/// `.setup()` runs after every plugin has initialised, so only the instance that
/// owns the single-instance mutex ever gets here, and it gets here before its
/// event loop serves any command, so no session of its own can exist yet.
///
/// Normally the folder is empty and this is one `read_dir`. A kept project
/// costs one streamed read of it per launch until it is settled.
pub fn cleanup_temp_projects() {
    let Ok(dir) = paths::temp_projects_dir() else {
        return;
    };
    let kept = sweep_temp_dir(&dir, SystemTime::now());
    *KEPT_ORPHANS.lock().unwrap_or_else(|e| e.into_inner()) = kept;
}

/// The kept orphans still on disk (by their `.trt`, or by the `.bak` a load
/// recovers them from), as absolute `.trt` paths. One the user has since
/// recovered and kept or discarded is gone, and drops out.
fn orphan_temp_projects() -> Vec<String> {
    let kept = KEPT_ORPHANS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    kept.into_iter()
        .filter(|p| p.is_file() || bak_path(p).is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Edited temporary projects the startup sweep kept — the ones a crash, a
/// logoff or a forced close orphaned — for Home to offer back, and the ones a
/// page reload adopted (`begin_reload_adoption`). Untouched ones were deleted,
/// so this is usually empty. A stat per kept project, off the UI thread.
#[tauri::command]
pub async fn list_orphan_temp_projects() -> Result<Vec<String>> {
    off_ui(|| Ok(orphans_for_home())).await
}

/// What Home is offered: the orphan list once any page reload's adoption has
/// landed in it, so a reloaded page never asks between the two.
fn orphans_for_home() -> Vec<String> {
    wait_for_reload_adoption(RELOAD_ADOPTION_WAIT);
    orphan_temp_projects()
}

/* ------------------------------------------------------------------ */
/* After a page reload                                                 */
/* ------------------------------------------------------------------ */

/// How long a caller that must see a reload's adoption waits for it. Judging
/// is one streamed read per temporary project, normally milliseconds; the
/// bound is for a folder on a disk that has stopped answering.
pub(crate) const RELOAD_ADOPTION_WAIT: Duration = Duration::from_secs(5);

/// Reload adoptions begun and not yet finished, and the signal that one
/// finished.
struct Adopting {
    pending: Mutex<usize>,
    done: std::sync::Condvar,
}

static ADOPTING: Adopting = Adopting { pending: Mutex::new(0), done: std::sync::Condvar::new() };

/// The temporary projects in the folder when the page died, waiting to be
/// judged. Begun on the UI thread inside the page-failure handler (one folder
/// listing, names only); finished on a thread of its own.
pub(crate) struct ReloadAdoption {
    candidates: Vec<PathBuf>,
}

/// The page process died (crash.rs `on_page_exit`) and is about to be
/// reloaded. The reloaded page boots to Home, and the temporary project that
/// was open there is in no list Home shows: temp projects never enter
/// recents, and the orphan list was filled once, by the startup sweep. So its
/// autosaved edits sat on disk, out of reach until the next launch.
///
/// The folder is listed NOW, between the old page's death and the new page's
/// start, while no page owns a session: everything in it is the dead page's
/// (or an older orphan). A session the reloaded page opens afterwards is not
/// in this listing, so it can never be offered back to the user as an orphan.
/// Nothing is deleted or renamed — the dead page's last writes may still be
/// landing on the store worker, and the next startup sweep settles the rest.
///
/// Until [`ReloadAdoption::finish`] runs, `list_orphan_temp_projects` (and
/// crash.rs's note handover) wait for it, up to [`RELOAD_ADOPTION_WAIT`].
pub(crate) fn begin_reload_adoption() -> ReloadAdoption {
    let candidates = paths::temp_projects_dir().map(|dir| temp_project_candidates(&dir)).unwrap_or_default();
    *ADOPTING.pending.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    ReloadAdoption { candidates }
}

impl ReloadAdoption {
    /// Judge the listed projects with the startup sweep's own rule
    /// (`kept_as_orphan`) and add each edited one to the orphan list Home
    /// reads. `before_release` is handed whether any project was newly
    /// adopted and runs BEFORE the waiters are released, so whatever it
    /// records (crash.rs's page note) is in place when they look.
    pub(crate) fn finish(self, before_release: impl FnOnce(bool)) {
        let adopted = adopt_orphans(&self.candidates, SystemTime::now());
        before_release(adopted);
        let mut pending = ADOPTING.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending = pending.saturating_sub(1);
        ADOPTING.done.notify_all();
    }
}

/// Wait until no reload adoption is pending, or `limit` has passed.
pub(crate) fn wait_for_reload_adoption(limit: Duration) {
    let pending = ADOPTING.pending.lock().unwrap_or_else(|e| e.into_inner());
    let _ = ADOPTING.done.wait_timeout_while(pending, limit, |p| *p > 0);
}

/// The temporary projects in `dir`, by their `.trt` path (a `.bak` with no
/// `.trt` stands for its project, as in `sweep_temp_dir`). Names only.
fn temp_project_candidates(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let has_suffix = |name: &str, suffix: &str| {
        name.len() >= suffix.len() && name.as_bytes()[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_owned();
            if has_suffix(&name, ".trt") {
                Some(e.path())
            } else if has_suffix(&name, ".trt.bak") {
                Some(e.path().with_file_name(&name[..name.len() - 4]))
            } else {
                None
            }
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Whether the startup sweep would keep the temporary project at `primary`:
/// `sweep_temp_dir`'s rule, torn-primary deferral included, with nothing
/// deleted.
fn kept_as_orphan(primary: &Path, now: SystemTime) -> bool {
    let bak = bak_path(primary);
    let has_primary = primary.is_file();
    match orphan_fate(if has_primary { primary } else { &bak }, now) {
        OrphanFate::Keep => true,
        OrphanFate::Unparseable if has_primary && bak.is_file() => orphan_fate(&bak, now) == OrphanFate::Keep,
        _ => false,
    }
}

/// Add every kept one of `candidates` to the orphan list; whether any was new.
fn adopt_orphans(candidates: &[PathBuf], now: SystemTime) -> bool {
    let kept: Vec<&PathBuf> = candidates.iter().filter(|p| kept_as_orphan(p, now)).collect();
    let mut list = KEPT_ORPHANS.lock().unwrap_or_else(|e| e.into_inner());
    let mut adopted = false;
    for p in kept {
        if !list.contains(p) {
            list.push(p.clone());
            adopted = true;
        }
    }
    adopted
}

/// Whether two paths name the same file on disk.
///
/// `Unknown` is not a shrug. It is the state where the filesystem could not be
/// asked — a path vanished mid-operation, or could not be opened at all — and
/// the two callers below resolve it in OPPOSITE directions, each toward the
/// answer whose failure is cosmetic rather than destructive. Collapsing it into
/// a bool would silently pick one of them for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathIdentity {
    /// Provably one and the same file.
    Same,
    /// Provably two different files.
    Different,
    /// The filesystem gave no answer; nothing may be inferred from that.
    Unknown,
}

/// The path the filesystem itself reports for `p`, in the directory entry's
/// true case (`GetFinalPathNameByHandle` on Windows). `None` when the file
/// cannot be resolved: it is gone, or it cannot be opened at all.
///
/// It opens the file only to ask its name, so an exclusive lock held by
/// another process (an AV scanner, a sync agent) does not defeat it the way it
/// defeats a read.
fn real_path(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// Do two paths name the same file?
///
/// This has to agree with `Path::exists`, and on Windows `exists` asks a
/// filesystem that compares names case-INSENSITIVELY. A plain `==` did not, so
/// renaming "My Film" to "my film" found the candidate taken (by the original)
/// but not excluded (byte-unequal), deduped to "my film (2).trt", and then
/// deleted "My Film.trt" — a case-only rename silently renumbered the project.
///
/// Folding both names in Rust does not agree with it either, and it fails in
/// the far more dangerous direction. Rust's `to_lowercase` is full Unicode;
/// NTFS folds with its own `$UpCase` table, which is much narrower. Measured on
/// this platform: "Straße.trt" (U+00DF) and "Straẞe.trt" (U+1E9E) are TWO files
/// on disk, as are "Kelvin.trt" and "Kelvin.trt" (U+212A KELVIN SIGN) — and
/// `to_lowercase` calls both pairs equal. Claiming equality there is what turns
/// a rename into a deletion: `free_path_in` reports the neighbour's path free,
/// and `atomic_write` rotates that innocent project into `.bak` and writes over
/// it. A name-folding rule cannot be right in general anyway — a case-sensitive
/// directory (`fsutil file setCaseSensitiveInfo`), a FAT stick or a network
/// share all fold differently, and none of them tell us in advance.
///
/// So ask the filesystem instead of imitating it. `canonicalize` resolves each
/// name to the directory entry's real case, so equal canonical paths mean
/// literally the same file — exactly what this volume folds, and nothing else.
pub(crate) fn path_identity(a: &Path, b: &Path) -> PathIdentity {
    // Byte-identical needs no filesystem, and answers even for a path that
    // does not exist yet.
    if a == b {
        return PathIdentity::Same;
    }
    match (real_path(a), real_path(b)) {
        (Some(a), Some(b)) if a == b => PathIdentity::Same,
        (Some(_), Some(_)) => PathIdentity::Different,
        _ => PathIdentity::Unknown,
    }
}

/// Pick a free `<base>.trt` path in `dir`, deduping to `<base> (2).trt` etc.
/// when the plain name is taken. `base` must already be sanitized. `exclude`
/// (the caller's own current file, if any) is treated as free so renaming a
/// project to its existing filename stem keeps the plain name — no " (2)".
///
/// Only a PROVEN `Same` counts as free. An unprovable answer dedupes, because
/// the two outcomes are not equally bad: a needless " (2)" is a cosmetic wart
/// on the file the user is renaming, while a wrong "that's mine" hands back an
/// occupied path and destroys somebody else's project.
fn free_path_in(dir: &Path, base: &str, exclude: Option<&Path>) -> Result<PathBuf> {
    for n in 0..1000 {
        let candidate = if n == 0 {
            dir.join(format!("{base}.trt"))
        } else {
            dir.join(format!("{base} ({}).trt", n + 1))
        };
        // `name_taken` short-circuits, so the identity checks only run — and
        // only touch the disk — for a candidate that is actually taken. The
        // `.bak` comparison is what lets a card whose `.trt` is gone (only its
        // `.bak` is left) be renamed to a different case of its own name: its
        // `.bak` is the candidate's `.bak`, so the name is its own. Two `.bak`
        // names one file only when the two project names are one name on this
        // volume, so that never frees somebody else's project.
        if !name_taken(&candidate)
            || exclude.is_some_and(|e| {
                path_identity(e, &candidate) == PathIdentity::Same
                    || path_identity(&bak_path(e), &bak_path(&candidate)) == PathIdentity::Same
            })
        {
            return Ok(candidate);
        }
    }
    Err(AppError::BadInput("could not find a free project name".into()))
}

/// Read a project file as a raw JSON `Value`, preserving unknown fields — the
/// `.trt`, or its `.bak` when the `.trt` is gone. That card is kept on Home on
/// purpose (`list_recents`), so Rename and Duplicate must work on it rather
/// than toast "not found" on a project Home is showing.
///
/// Only an OBJECT is a project — from the `.bak` as much as from the `.trt`.
/// Rename and duplicate assign `value["name"]` / `value["id"]` next, and
/// serde_json's `IndexMut` panics on an array, a number, a string or a bool
/// (only `null` becomes an object) — under `panic = "abort"` that kills the
/// app, every other window's unsaved work included, for a Home card whose
/// `.trt` was replaced on disk by `[]`.
///
/// Called on the store worker, where no save can be half done, so a missing
/// `.trt` is really missing.
fn read_raw_value(path: &Path) -> Result<Value> {
    let bytes = match image_rules::read_capped(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match image_rules::read_capped(&bak_path(path)) {
            Ok(bytes) => bytes,
            // Neither copy: the primary's own NotFound is the honest answer.
            Err(b) if b.kind() == std::io::ErrorKind::NotFound => return Err(e.into()),
            Err(b) => return Err(capped_read_error(b)),
        },
        Err(e) => return Err(capped_read_error(e)),
    };
    refuse_value_bomb(&bytes, path)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::BadInput(format!("{} is not valid JSON", path.display())))?;
    if !value.is_object() {
        return Err(AppError::BadInput(format!("{} is not a Taroting project", path.display())));
    }
    Ok(value)
}

/// Whether `path` is provably not on disk — NotFound, not merely unreadable.
fn provably_absent(path: &Path) -> bool {
    matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// Rename a project on disk: rewrite its inner `name`, move the file to a
/// sanitized/deduped path in the same dir, drop the stale `.bak`, and update
/// the recents entry. Returns the new path. On the store worker.
#[tauri::command]
pub async fn rename_project(path: String, new_name: String) -> Result<String> {
    on_store(move || rename_project_now(&path, new_name)).await
}

fn rename_project_now(path: &str, new_name: String) -> Result<String> {
    let old = project_target(path)?;
    let dir = old
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", old.display())))?;

    let mut value = read_raw_value(old)?;
    let base = sanitize_filename(&new_name);
    // Exclude our own current file so renaming to the same sanitized stem
    // keeps the filename instead of deduping to "<base> (2).trt".
    let new_path = free_path_in(dir, &base, Some(old))?;

    value["name"] = Value::String(new_name);
    atomic_write(&new_path, &project_bytes(&value)?)?;

    // Clean up the old location only when it is PROVABLY a different file. A
    // case-only rename lands on the same file on Windows, so deleting "the old
    // one" here would delete the project we just wrote. An unprovable answer
    // must not be resolved that way either: leaving a stale copy behind is
    // recoverable, deleting the live one is not.
    //
    // A card renamed from its `.bak` (its `.trt` was gone) has no old file to
    // compare, so identity can only say Unknown. But with the new file now on
    // disk, an old name that is STILL not found cannot be the new file under
    // another case — that would find it — so the two are different files and
    // the old `.bak` goes.
    if provably_absent(old) || path_identity(&new_path, old) == PathIdentity::Different {
        let _ = std::fs::remove_file(old);
        let _ = std::fs::remove_file(bak_path(old));
        let _ = std::fs::remove_file(tmp_path(old));
    }

    // Replace the recents entry's path + name, preserving the rest.
    let new_path_str = new_path.to_string_lossy().into_owned();
    let name_field = clipped(value["name"].as_str().unwrap_or_default(), RECENT_NAME_MAX_CHARS);
    let _ = update_recents(|index| {
        let Some(entry) = index.items.iter_mut().find(|r| r.path == path) else {
            return false;
        };
        entry.path = new_path_str.clone();
        entry.name = name_field;
        true
    });

    Ok(new_path_str)
}

/// A copy of an image project's rendered card, named for the duplicate's own
/// project id and path (`card_file_name`) and placed beside the original.
/// `None` (the card shows its placeholder until the copy is first edited) when
/// the id is not one the save protocol would accept, when the source is not a
/// rendered card, or when the copy fails.
fn copy_image_card(src: &Path, new_id: &Value, new_path: &str) -> Option<String> {
    let name = crate::image_save::card_file_name(new_id.as_str()?, new_path)?;
    let from_card = src
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(crate::image_save::CARD_PREFIX));
    if !from_card {
        return None;
    }
    let dest = src.parent()?.join(name);
    std::fs::copy(src, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

/// Duplicate a project: copy its raw JSON with a new `name` + `id`, to a
/// deduped path derived from `new_name`, and add it to recents. The caller
/// supplies `new_id` (frontend `crypto.randomUUID()`). Returns the new path.
/// On the store worker.
#[tauri::command]
pub async fn duplicate_project(path: String, new_name: String, new_id: String) -> Result<String> {
    on_store(move || duplicate_project_now(&path, new_name, new_id)).await
}

fn duplicate_project_now(path: &str, new_name: String, new_id: String) -> Result<String> {
    let src = project_target(path)?;
    let dir = src
        .parent()
        .ok_or_else(|| AppError::BadInput(format!("no parent dir for {}", src.display())))?;

    let mut value = read_raw_value(src)?;
    value["name"] = Value::String(new_name.clone());
    value["id"] = Value::String(new_id);

    let base = sanitize_filename(&new_name);
    // No exclusion: a duplicate must never overwrite its source.
    let new_path = free_path_in(dir, &base, None)?;
    atomic_write(&new_path, &project_bytes(&value)?)?;

    let new_path_str = new_path.to_string_lossy().into_owned();
    let size_bytes = std::fs::metadata(&new_path).map(|m| m.len()).unwrap_or(0);
    // Carry the source's duration/thumb across so the new card looks right
    // before it is ever opened+saved.
    let src_recent = read_recents().items.into_iter().find(|r| r.path == *path);
    // From the copied file itself, not the source's recents entry: the file is
    // what Home will open, and an entry can be missing or stale.
    let image = value.get("kind").and_then(Value::as_str) == Some("image");
    let src_thumb = src_recent.as_ref().and_then(|r| r.thumb.clone());
    let thumb = if image {
        // An image card is a rendered file named after the project id and
        // path, which the SOURCE keeps rewriting as it is edited. Sharing that
        // file would make the copy's card follow the original's edits, so the
        // copy gets its own (under its own id and path) or no card picture.
        src_thumb.and_then(|t| copy_image_card(Path::new(&t), &value["id"], &new_path_str))
    } else {
        src_thumb
    };
    // Best-effort, as for a save (see there): the copy is on disk, and an
    // error here left it without a card while telling the user it failed.
    if let Err(e) = upsert_recent(RecentItem {
        path: new_path_str.clone(),
        name: new_name,
        modified_at: value["modifiedAt"].as_str().unwrap_or_default().to_string(),
        duration_sec: src_recent
            .as_ref()
            .map(|r| finite_duration(r.duration_sec))
            .unwrap_or(0.0),
        thumb,
        size_bytes,
        opened_at: None,
        kind: image.then(|| "image".to_string()),
    }) {
        eprintln!("Taroting: duplicated to {new_path_str}, but the recent projects list was not updated ({e})");
    }

    Ok(new_path_str)
}

/// Permanently delete a project file, its `.bak` sibling, and its recents entry.
/// On the store worker.
#[tauri::command]
pub async fn delete_project(path: String) -> Result<()> {
    on_store(move || delete_project_now(&path)).await
}

/// `delete_project`'s body.
///
/// A `.trt` that is already gone is not an error: its card can still be on
/// Home (only the `.bak` left — `list_recents` keeps that card), and refusing
/// with "not found" before the `.bak` or the recents entry were touched made
/// such a card impossible to delete. The `.bak` and any `.tmp` a failed save
/// staged go with it, and the recents entry is dropped best-effort, as every
/// recents side effect is: the files are gone either way.
fn delete_project_now(path: &str) -> Result<()> {
    let p = project_target(path)?;
    match std::fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    let _ = std::fs::remove_file(bak_path(p));
    let _ = std::fs::remove_file(tmp_path(p));

    if let Err(e) = update_recents(|index| {
        index.items.retain(|r| r.path != path);
        true
    }) {
        eprintln!("Taroting: deleted {path}, but the recent projects list was not updated ({e})");
    }
    Ok(())
}

/// Autotest only: delete one file the E2E itself wrote that is NOT a project —
/// an export, a card picture, a scratch copy. `delete_project` refuses
/// anything but a `.trt` (`project_target`), and the suite used to clean up
/// through it.
///
/// Refused outright unless this is a debug build running the harness
/// (`debug::autotest_mode`), so a shipped build cannot take it. Even then it
/// deletes only a file under the run's scratch root or the derived-file cache
/// (where card pictures live), never a folder.
#[tauri::command]
pub async fn debug_remove_test_file(app: tauri::AppHandle, path: String) -> Result<()> {
    use tauri::Manager;
    if !crate::debug::autotest_mode() {
        return Err(AppError::BadInput("test files are removed only under the autotest harness".into()));
    }
    let mut roots = vec![crate::debug::autotest_root()];
    if let Some(cache) = app.try_state::<Arc<crate::cache::Cache>>() {
        roots.push(cache.root().to_path_buf());
    }
    off_ui(move || remove_test_file(&path, &roots)).await
}

/// `debug_remove_test_file`'s body: remove `path` if it is a file under one
/// of `roots`. Already gone is fine. Lexical containment, with `..` refused
/// so it cannot climb out.
fn remove_test_file(path: &str, roots: &[PathBuf]) -> Result<()> {
    let p = Path::new(path);
    let climbs = p
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
    let inside = roots.iter().any(|r| inside_folded(&r.to_string_lossy(), path));
    if !p.is_absolute() || climbs || !inside {
        return Err(AppError::BadInput(format!("not a test file: {path}")));
    }
    match std::fs::symlink_metadata(p) {
        Ok(meta) if meta.is_file() => Ok(std::fs::remove_file(p)?),
        Ok(_) => Err(AppError::BadInput(format!("not a file: {path}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use crate::media::source::FILE_ATTRIBUTE_OFFLINE;

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("a<b>c:d"), "a_b_c_d");
        assert_eq!(sanitize_filename("  spaced  "), "spaced");
        assert_eq!(sanitize_filename("dots..."), "dots");
        assert_eq!(sanitize_filename(""), "Untitled");
        assert_eq!(sanitize_filename("***"), "___");
    }

    // The recents index lives under %APPDATA%, a process-global env var. Every
    // test touching rename/duplicate/delete (which read+write recents) points
    // APPDATA at its own temp dir; ENV_LOCK serializes them so parallel threads
    // never share state. `with_isolated` acquires the lock, sets up a private
    // temp dir + APPDATA, runs the body, then restores and cleans up.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_isolated(tag: &str, body: impl FnOnce(&Path)) {
        // Hold the lock for the whole test; recover it even if a prior test panicked.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "taroting-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var_os("APPDATA");
        std::env::set_var("APPDATA", dir.join("appdata"));
        // The temp-projects dir hangs off LOCALAPPDATA; isolate it too so the
        // quick-view tests never touch the real %LOCALAPPDATA%\Taroting.
        let prev_local = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", dir.join("localappdata"));
        // New projects land in %USERPROFILE%\Documents\Taroting. Without this the
        // keep/cleanup tests wrote "Keep.trt"/"Kept.trt" into the REAL Documents
        // folder of whoever ran the suite, and left them there.
        let prev_profile = std::env::var_os("USERPROFILE");
        std::env::set_var("USERPROFILE", dir.join("userprofile"));

        body(&dir);
        // A job the body queued without waiting for it (a load's recents
        // stamp) must land while THIS test's folders are still the ones the
        // environment points at, not the next test's.
        drain_store();

        match prev {
            Some(v) => std::env::set_var("APPDATA", v),
            None => std::env::remove_var("APPDATA"),
        }
        match prev_local {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        match prev_profile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Wait until every job queued on the store worker so far has run.
    fn drain_store() {
        on_store_blocking(|| ()).unwrap();
    }

    // The commands' bodies under the commands' own names, synchronous, so a
    // test reads as a call of the command. They shadow the async commands the
    // glob import brings in. `load_project` waits for the recents stamp it
    // queued, so a test can read recents right after it.
    fn load_project(path: String) -> Result<LoadedProject> {
        let loaded = load_project_now(&path);
        drain_store();
        loaded
    }
    fn rename_project(path: String, new_name: String) -> Result<String> {
        rename_project_now(&path, new_name)
    }
    fn duplicate_project(path: String, new_name: String, new_id: String) -> Result<String> {
        duplicate_project_now(&path, new_name, new_id)
    }
    fn delete_project(path: String) -> Result<()> {
        delete_project_now(&path)
    }
    fn list_recents() -> Result<RecentsIndex> {
        list_recents_now()
    }
    fn remove_recent(path: String) -> Result<()> {
        remove_recent_now(&path)
    }
    fn temp_project_path(name: Option<String>) -> Result<String> {
        temp_project_path_now(name)
    }
    fn new_project_path(name: Option<String>) -> Result<String> {
        new_project_path_now(name)
    }

    fn write_json(path: &Path, v: &Value) {
        std::fs::write(path, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    }

    /// mtime of a just-written file, using the same derivation as the scan.
    fn disk_mtime_ms(path: &Path) -> u64 {
        mtime_ms_of(&std::fs::metadata(path).unwrap())
    }

    #[test]
    fn load_skips_generated_media_in_missing_scan() {
        with_isolated("gen-missing", |dir| {
            // A real file whose size + mtime match its media entry, plus a
            // generated solid whose `path` is a display label (no file on disk).
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let m1_mtime = disk_mtime_ms(&media_file);
            let proj = dir.join("Gen.trt");
            write_json(
                &proj,
                &serde_json::json!({
                    "schema": 1, "app": "taroting", "id": "p1", "name": "Gen",
                    "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                    "media": [{
                        "id": "m1", "path": media_file.to_string_lossy(), "size": 10,
                        "mtimeMs": m1_mtime, "kind": "video", "duration": 1.0, "hasAudio": false
                    }, {
                        "id": "m2", "path": "Solid #00ff00", "size": 0, "mtimeMs": 0,
                        "kind": "image", "duration": 0.0, "hasAudio": false,
                        "width": 64, "height": 64,
                        "generator": { "type": "solid", "color": "#00ff00" }
                    }, {
                        "id": "m3", "path": "C:\\definitely\\not\\there.mp4", "size": 1,
                        "mtimeMs": 0, "kind": "video", "duration": 1.0, "hasAudio": false
                    }],
                    "timeline": {
                        "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                        "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                     "muted": false, "clips": [] }]
                    },
                    "export": {}
                }),
            );

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            // The generator is never "missing"; the bogus file-backed media is.
            assert_eq!(loaded.missing, vec!["m3".to_string()]);
        });
    }

    /// Build a one-media project at `proj` referencing `media_file` with the
    /// given stored size + mtime, then load and return the `missing` ids.
    fn missing_for(proj: &Path, media_file: &Path, size: u64, mtime_ms: u64) -> Vec<String> {
        write_json(
            proj,
            &serde_json::json!({
                "schema": 1, "app": "taroting", "id": "p1", "name": "Scan",
                "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                "media": [{
                    "id": "m1", "path": media_file.to_string_lossy(), "size": size,
                    "mtimeMs": mtime_ms, "kind": "video", "duration": 1.0, "hasAudio": false
                }],
                "timeline": {
                    "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                    "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                 "muted": false, "clips": [] }]
                },
                "export": {}
            }),
        );
        load_project(proj.to_string_lossy().into_owned())
            .unwrap()
            .missing
    }

    #[test]
    fn load_flags_same_size_different_mtime_as_missing() {
        with_isolated("scan-mtime", |dir| {
            // Same-size in-place content replacement bumps the file's mtime; the
            // stored mtime_ms is now stale, so the media must be flagged missing.
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let size = std::fs::metadata(&media_file).unwrap().len();
            let stale_mtime = disk_mtime_ms(&media_file).wrapping_sub(5_000);

            let proj = dir.join("Scan.trt");
            assert_eq!(missing_for(&proj, &media_file, size, stale_mtime), vec!["m1"]);
        });
    }

    /// Opening a crafted project never stats a share off the local network:
    /// its media is reported missing without being looked at, while a local
    /// file beside it IS looked at (so the row cannot pass by nothing being
    /// stat-ed at all). The server is this machine behind `@SSL`, so even a
    /// regression that did stat it would reach no further than localhost.
    #[cfg(windows)]
    #[test]
    fn opening_a_project_never_stats_a_share_off_the_local_network() {
        with_isolated("scan-unc", |dir| {
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let size = std::fs::metadata(&media_file).unwrap().len();
            let mtime = disk_mtime_ms(&media_file);
            let remote = r"\\127.0.0.1@SSL\share\clip.mp4";
            let proj = dir.join("Remote.trt");
            write_json(
                &proj,
                &serde_json::json!({
                    "schema": 1, "app": "taroting", "id": "p1", "name": "Remote",
                    "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                    "media": [
                        { "id": "m1", "path": media_file.to_string_lossy(), "size": size,
                          "mtimeMs": mtime, "kind": "video", "duration": 1.0, "hasAudio": false },
                        { "id": "m2", "path": remote, "size": 10,
                          "mtimeMs": mtime, "kind": "video", "duration": 1.0, "hasAudio": false }
                    ],
                    "timeline": {
                        "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                        "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                     "muted": false, "clips": [] }]
                    },
                    "export": {}
                }),
            );
            STATTED.with(|s| s.borrow_mut().clear());
            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            let statted = STATTED.with(|s| s.borrow().clone());
            assert_eq!(loaded.missing, vec!["m2"]);
            assert!(statted.contains(&media_file), "fixture: the local file is looked at");
            assert!(!statted.contains(&PathBuf::from(remote)), "the remote share was stat-ed");
        });
    }

    /// The editor's re-check of a missing media file (`path_exists`) declines
    /// the same share the load declined: it answers "does not exist" without
    /// a stat, while a local file beside it IS stat-ed and found (so the row
    /// cannot pass by nothing being looked at). Called through the body, on
    /// this thread, because the stat log is per thread.
    #[cfg(windows)]
    #[test]
    fn checking_a_path_never_stats_a_share_off_the_local_network() {
        with_isolated("exists-unc", |dir| {
            let local = dir.join("v.bin");
            std::fs::write(&local, b"0123456789").unwrap();
            let remote = r"\\127.0.0.1@SSL\share\clip.mp4";
            // The same share spelled so a UNC-prefix check cannot see its
            // server: through the device namespace, and as the NT object path
            // (no Rust prefix at all). The gate fails closed on both.
            let hidden = [r"\\.\UNC\127.0.0.1@SSL\share\clip.mp4", r"\??\UNC\127.0.0.1@SSL\share\clip.mp4"];
            STATTED.with(|s| s.borrow_mut().clear());
            assert!(path_exists_now(&local), "fixture: a local file exists");
            assert!(!path_exists_now(Path::new(remote)), "a refused share reads as missing");
            for h in hidden {
                assert!(!path_exists_now(Path::new(h)), "a disguised share reads as missing: {h}");
            }
            assert!(!path_exists_now(&dir.join("gone.mp4")), "a missing local file reads as missing");
            let statted = STATTED.with(|s| s.borrow().clone());
            assert!(statted.contains(&local), "fixture: the local file is looked at");
            assert!(!statted.contains(&PathBuf::from(remote)), "the remote share was stat-ed");
            for h in hidden {
                assert!(!statted.contains(&PathBuf::from(h)), "the disguised share was stat-ed: {h}");
            }
        });
    }

    /// A save arrives as a JSON body (parsed by tauri) or as raw bytes
    /// (parsed on the store worker); both give the same path and project, and
    /// a raw body that is not a save request, or is past the cap, is refused.
    #[test]
    fn a_save_request_reads_the_same_as_json_or_as_raw_bytes() {
        use tauri::ipc::InvokeBody;
        let project = serde_json::json!({ "schema": 2, "name": "Café" });
        let request = serde_json::json!({ "path": r"C:\Projects\Café.trt", "project": project });
        let parsed = save_body(&InvokeBody::Json(request.clone())).unwrap().into_parts().unwrap();
        let raw = save_body(&InvokeBody::Raw(serde_json::to_vec(&request).unwrap())).unwrap().into_parts().unwrap();
        assert_eq!(parsed, (r"C:\Projects\Café.trt".to_owned(), project.clone()));
        assert_eq!(raw, parsed);

        assert!(save_body(&InvokeBody::Json(serde_json::json!({ "project": project }))).is_err(), "no path");
        let garbage = save_body(&InvokeBody::Raw(b"{\"path\": 7}".to_vec())).unwrap().into_parts();
        assert!(matches!(garbage, Err(AppError::BadInput(_))), "{garbage:?}");
        let body = serde_json::to_vec(&request).unwrap();
        let cap = body.len() as u64;
        assert!(save_body_within(&InvokeBody::Raw(body.clone()), cap).is_ok(), "at the cap");
        let past = save_body_within(&InvokeBody::Raw([body, b" ".to_vec()].concat()), cap);
        assert!(matches!(past, Err(AppError::BadInput(_))), "one byte past the cap");
    }

    #[test]
    fn load_does_not_flag_unchanged_file() {
        with_isolated("scan-unchanged", |dir| {
            // Size + mtime both match what's on disk: not missing.
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let size = std::fs::metadata(&media_file).unwrap().len();
            let mtime = disk_mtime_ms(&media_file);

            let proj = dir.join("Scan.trt");
            assert!(missing_for(&proj, &media_file, size, mtime).is_empty());
        });
    }

    /* -------------------------------------------------------------- */
    /* Rotation repair (schema 1 → 2)                                  */
    /* -------------------------------------------------------------- */

    /// Encode a landscape 640x360 clip and stamp 90° of display rotation onto a
    /// stream copy of it — the exact shape a portrait phone recording has:
    /// coded landscape, plus a Display Matrix saying otherwise. Returns the
    /// rotated file, which `probe_sync` reports as 360x640.
    ///
    /// No fixture in this repo carried rotation metadata, which is precisely
    /// why this class of bug reached users past a green suite. The repair is
    /// worth nothing tested against a synthetic disagreement.
    fn rotated_video_fixture(dir: &Path) -> PathBuf {
        let flat = dir.join("flat.mp4");
        let out = crate::jobs::ffmpeg::run(
            "ffmpeg",
            &[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                flat.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let rotated = dir.join("portrait.mp4");
        // `-display_rotation` on the INPUT + `-c copy` writes the matrix
        // through without touching a pixel, so the coded size stays 640x360.
        let out = crate::jobs::ffmpeg::run(
            "ffmpeg",
            &[
                "-y",
                "-display_rotation", "90",
                "-i", flat.to_str().unwrap(),
                "-c", "copy",
                rotated.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        rotated
    }

    /// A media entry for `file` carrying the dimensions the OLD probe would
    /// have stored — the coded pair, un-transposed — with a true identity so
    /// the repair is allowed to look at it.
    fn pre_swap_media(file: &Path, w: u32, h: u32) -> Value {
        let meta = std::fs::metadata(file).unwrap();
        serde_json::json!({
            "id": "m1", "path": file.to_string_lossy(),
            "size": meta.len(), "mtimeMs": mtime_ms_of(&meta),
            "kind": "video", "duration": 1.0, "hasAudio": false,
            "width": w, "height": h
        })
    }

    /// Write a pre-repair (schema 1) project with the given media and canvas,
    /// one clip on `m1`, and a field this build knows nothing about.
    fn write_pre_repair_project(proj: &Path, media: Value, canvas: (u32, u32)) {
        write_json(
            proj,
            &serde_json::json!({
                "schema": 1, "app": "taroting", "id": "p1", "name": "Portrait",
                "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                "media": media,
                "timeline": {
                    "fps": {"num": 30, "den": 1},
                    "width": canvas.0, "height": canvas.1,
                    "tracks": [{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                        "clips": [{
                            "id": "c1", "mediaId": "m1",
                            "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 1.0, "speed": 1.0,
                            "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                                       "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                        }] }]
                },
                "export": {},
                "unknownFutureField": {"keep": "me"}
            }),
        );
    }

    /// The whole repair, against a real rotated file: a project saved with the
    /// pre-swap dimensions loads corrected, the correction is on disk under the
    /// bumped stamp, and the stamp then keeps it from ever running again.
    #[test]
    fn load_repairs_pre_swap_dimensions_once_and_persists_them() {
        with_isolated("rot-repair", |dir| {
            let file = rotated_video_fixture(dir);
            let proj = dir.join("Portrait.trt");
            write_pre_repair_project(
                &proj,
                serde_json::json!([pre_swap_media(&file, 640, 360)]),
                (640, 360),
            );

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert!(
                loaded.missing.is_empty(),
                "the file is right there, unchanged: {:?}",
                loaded.missing
            );
            assert_eq!(loaded.project["media"][0]["width"], 360);
            assert_eq!(loaded.project["media"][0]["height"], 640);
            // A lone clip whose canvas was adopted from its stale dimensions:
            // the canvas follows it round.
            assert_eq!(loaded.project["timeline"]["width"], 360);
            assert_eq!(loaded.project["timeline"]["height"], 640);

            // The same numbers are on DISK, under the bumped stamp — without
            // that, every open would pay for the probes again.
            let on_disk: Value = serde_json::from_slice(&std::fs::read(&proj).unwrap()).unwrap();
            assert_eq!(on_disk["schema"], schema::CURRENT_SCHEMA);
            assert_eq!(on_disk["media"][0]["width"], 360);
            assert_eq!(on_disk["media"][0]["height"], 640);
            assert_eq!(on_disk["timeline"]["width"], 360);
            assert_eq!(on_disk["timeline"]["height"], 640);
            // ...written as a surgical edit, not a re-serialize of the typed
            // struct, which would have dropped this.
            assert_eq!(on_disk["unknownFutureField"]["keep"], "me");

            // THE GATE. Put the STALE dimensions back — the precise pair this
            // repair exists to correct — while leaving the bumped stamp alone.
            // A second load must hand them straight back untouched, which it
            // can only do by never probing the file. (Poisoning with arbitrary
            // numbers would not test this: a re-probe finds no transposition
            // in them and leaves them alone too, so the test would pass with
            // the gate removed entirely.)
            let mut poisoned = on_disk.clone();
            poisoned["media"][0]["width"] = Value::from(640);
            poisoned["media"][0]["height"] = Value::from(360);
            write_json(&proj, &poisoned);

            let again = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(
                again.project["media"][0]["width"], 640,
                "a second re-probe would have transposed this — the schema gate leaked"
            );
            assert_eq!(again.project["media"][0]["height"], 360);
        });
    }

    /// A transposed clip's crop is clamped into its NEW box, on disk too. The
    /// crop fits the stale 640-wide box and hangs off the 360-wide one; only x
    /// has to move (w, y and h already fit), so the row fails for one reason.
    #[test]
    fn the_rotation_repair_clamps_a_transposed_clip_s_crop() {
        with_isolated("rot-crop", |dir| {
            let file = rotated_video_fixture(dir);
            let proj = dir.join("Cropped.trt");
            write_pre_repair_project(
                &proj,
                serde_json::json!([pre_swap_media(&file, 640, 360)]),
                (640, 360),
            );
            let mut v: Value = serde_json::from_slice(&std::fs::read(&proj).unwrap()).unwrap();
            v["timeline"]["tracks"][0]["clips"][0]["transform"] =
                cropped_clip("c1", "m1", Some([500, 10, 100, 50]))["transform"].clone();
            write_json(&proj, &v);

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(loaded.project["media"][0]["width"], 360, "fixture: the clip was transposed");
            let want = serde_json::json!({ "x": 260, "y": 10, "w": 100, "h": 50 });
            let crop = |p: &Value| p["timeline"]["tracks"][0]["clips"][0]["transform"]["crop"].clone();
            assert_eq!(crop(&loaded.project), want);
            let on_disk: Value = serde_json::from_slice(&std::fs::read(&proj).unwrap()).unwrap();
            assert_eq!(crop(&on_disk), want);
        });
    }

    /// An online-only file is never probed by the rotation repair: ffprobe
    /// would download it on the load the user is waiting on. The local file
    /// beside it, identical but for the offline bit, IS probed and repaired,
    /// so the row cannot pass by nothing being probed at all.
    #[cfg(windows)]
    #[test]
    fn the_rotation_repair_never_probes_a_cloud_placeholder() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        with_isolated("rot-cloud", |dir| {
            let local = dir.join("local.mp4");
            std::fs::write(&local, b"bytes").unwrap();
            let cloud = dir.join("cloud.mp4");
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .attributes(FILE_ATTRIBUTE_OFFLINE)
                .open(&cloud)
                .and_then(|mut f| f.write_all(b"bytes"))
                .unwrap();
            assert!(is_cloud_placeholder(&cloud), "fixture: the offline bit must stick");
            assert!(!is_cloud_placeholder(&local), "fixture: the control is local");

            let mut second = pre_swap_media(&cloud, 640, 360);
            second["id"] = Value::from("m2");
            let media: Vec<schema::MediaRef> =
                serde_json::from_value(serde_json::json!([pre_swap_media(&local, 640, 360), second]))
                    .unwrap();
            let mut asked = Vec::new();
            let fixes = rotation_fixes_with(&media, |p| {
                asked.push(p.to_string());
                Some((360, 640))
            });
            assert_eq!(asked, [local.to_string_lossy().into_owned()]);
            assert_eq!(fixes, [DimFix { index: 0, from: (640, 360), to: (360, 640) }]);
        });
    }

    /// A second VISUAL media means something else may have framed this project,
    /// so the canvas is left where the user had it. The clip's own dimensions
    /// are still repaired — it simply letterboxes correctly now instead of
    /// being stretched.
    #[test]
    fn a_second_visual_media_keeps_the_canvas_out_of_it() {
        with_isolated("rot-canvas", |dir| {
            let file = rotated_video_fixture(dir);
            let proj = dir.join("Titled.trt");
            write_pre_repair_project(
                &proj,
                serde_json::json!([
                    pre_swap_media(&file, 640, 360),
                    {
                        "id": "m2", "path": "Text: Title", "size": 0, "mtimeMs": 0,
                        "kind": "image", "duration": 0.0, "hasAudio": false,
                        "width": 640, "height": 360,
                        "generator": { "type": "solid", "color": "#00ff00" }
                    }
                ]),
                (640, 360),
            );

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(loaded.project["media"][0]["width"], 360, "the clip is still repaired");
            assert_eq!(loaded.project["media"][0]["height"], 640);
            assert_eq!(loaded.project["timeline"]["width"], 640, "the canvas is not");
            assert_eq!(loaded.project["timeline"]["height"], 360);
            // The title card is not a video and was never probed.
            assert_eq!(loaded.project["media"][1]["width"], 640);
        });
    }

    /// An audio bed is not a second visual media: a portrait clip over music is
    /// still a single-clip portrait project, and its canvas follows.
    #[test]
    fn an_audio_companion_does_not_block_the_canvas() {
        with_isolated("rot-scored", |dir| {
            let file = rotated_video_fixture(dir);
            let meta = std::fs::metadata(&file).unwrap();
            let proj = dir.join("Scored.trt");
            write_pre_repair_project(
                &proj,
                serde_json::json!([
                    pre_swap_media(&file, 640, 360),
                    {
                        "id": "m2", "path": file.to_string_lossy(),
                        "size": meta.len(), "mtimeMs": mtime_ms_of(&meta),
                        "kind": "audio", "duration": 1.0, "hasAudio": true
                    }
                ]),
                (640, 360),
            );

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(loaded.project["timeline"]["width"], 360);
            assert_eq!(loaded.project["timeline"]["height"], 640);
        });
    }

    /// A file that no longer matches what the project recorded is the relink
    /// path's business. It is reported missing and left exactly as authored —
    /// adopting a replacement's dimensions here would silently accept a file
    /// the user has not agreed to.
    #[test]
    fn a_changed_file_is_left_to_the_relink_path() {
        with_isolated("rot-relink", |dir| {
            let file = rotated_video_fixture(dir);
            let mut media = pre_swap_media(&file, 640, 360);
            let stale = media["mtimeMs"].as_u64().unwrap().wrapping_sub(5_000);
            media["mtimeMs"] = Value::from(stale);

            let proj = dir.join("Changed.trt");
            write_pre_repair_project(&proj, serde_json::json!([media]), (640, 360));

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(loaded.missing, vec!["m1"]);
            assert_eq!(loaded.project["media"][0]["width"], 640, "untouched");
            assert_eq!(loaded.project["media"][0]["height"], 360);
            assert_eq!(loaded.project["timeline"]["width"], 640);
        });
    }

    /// A file with no rotation is the common case, and it must survive the
    /// repair completely unchanged — including a project whose canvas the rule
    /// would otherwise have been eligible to turn.
    #[test]
    fn an_unrotated_file_is_left_exactly_as_it_was() {
        with_isolated("rot-none", |dir| {
            rotated_video_fixture(dir); // also leaves the un-rotated `flat.mp4`
            let flat = dir.join("flat.mp4");
            let proj = dir.join("Flat.trt");
            write_pre_repair_project(
                &proj,
                serde_json::json!([pre_swap_media(&flat, 640, 360)]),
                (640, 360),
            );

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(loaded.project["media"][0]["width"], 640);
            assert_eq!(loaded.project["media"][0]["height"], 360);
            assert_eq!(loaded.project["timeline"]["width"], 640);
            assert_eq!(loaded.project["timeline"]["height"], 360);
            // Stamped all the same: a project that needed nothing must not be
            // re-probed on every future open just because it needed nothing.
            let on_disk: Value = serde_json::from_slice(&std::fs::read(&proj).unwrap()).unwrap();
            assert_eq!(on_disk["schema"], schema::CURRENT_SCHEMA);
        });
    }

    /// The STREAM re-probe's candidate set is video-only, and that is a
    /// decision rather than an oversight: measured with the bundled ffprobe, a
    /// still exposes no stream-level side data and the gif muxer discards a
    /// rotation you ask it to write, so neither can carry the Display Matrix
    /// this repair is about — while probing them would cost a process per
    /// photo in a slideshow. A still CAN be stored wrong, by EXIF orientation,
    /// but that is `repair_still_orientation`'s business, and for a still the
    /// app follows ffmpeg on it only ever turns one whose header says it is
    /// turned AND whose stored pair is exactly the coded one. This JPEG
    /// carries no orientation, so a still whose stored dimensions are the
    /// exact transpose of its file's is left alone by both repairs, where the
    /// identical disagreement on a video is corrected. (A JPEG, not a PNG: an
    /// untagged PNG is one every decoder opens `-noautorotate`, and the still
    /// repair turns such a still stored at the transpose of its coded pair
    /// back to it — its own business, pinned beside it.)
    #[test]
    fn only_video_media_is_ever_re_probed() {
        with_isolated("rot-video-only", |dir| {
            let still = dir.join("frame.jpg");
            let out = crate::jobs::ffmpeg::run(
                "ffmpeg",
                &[
                    "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=640x360",
                    "-frames:v", "1",
                    still.to_str().unwrap(),
                ],
            )
            .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

            // Recorded transposed, and a lone visual media on a canvas that
            // matches — every condition the repair looks for, except the kind.
            let mut media = pre_swap_media(&still, 360, 640);
            media["kind"] = Value::from("image");
            let proj = dir.join("Still.trt");
            write_pre_repair_project(&proj, serde_json::json!([media]), (360, 640));

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(loaded.project["media"][0]["width"], 360, "a still is never re-probed");
            assert_eq!(loaded.project["media"][0]["height"], 640);
            assert_eq!(loaded.project["timeline"]["width"], 360, "so its canvas cannot move");
            assert_eq!(loaded.project["timeline"]["height"], 640);
        });
    }

    /// The discriminator between the two ways a fresh probe can disagree with
    /// a stored pair.
    #[test]
    fn only_an_exact_transposition_counts_as_the_rotation_bug() {
        // The bug: coded landscape stored, decoded portrait probed (and back).
        assert!(is_transposition((1920, 1080), (1080, 1920)));
        assert!(is_transposition((1080, 1920), (1920, 1080)));

        // A different file, not a rotation — the relink dialog's business.
        assert!(!is_transposition((1920, 1080), (1280, 720)));
        assert!(!is_transposition((1920, 1080), (1080, 720)));
        assert!(!is_transposition((1920, 1080), (720, 1080)));

        // Agreement is not a correction.
        assert!(!is_transposition((1920, 1080), (1920, 1080)));

        // A square frame transposes to itself: nothing to correct, and calling
        // it a correction would arm the canvas rule with a no-op.
        assert!(!is_transposition((1080, 1080), (1080, 1080)));
    }

    /// `video_media` with an explicit kind and dimensions.
    fn sized_media(id: &str, kind: &str, w: u32, h: u32) -> Value {
        let mut m = video_media(id);
        m["kind"] = Value::from(kind);
        m["width"] = Value::from(w);
        m["height"] = Value::from(h);
        m
    }

    /// A typed project with the given media and canvas, and one empty track.
    fn canvas_project(media: Value, canvas: (u32, u32)) -> ProjectFile {
        let mut v = project_with_tracks(
            media,
            serde_json::json!([
                { "id": "t1", "kind": "video", "name": "V1", "muted": false, "clips": [] }
            ]),
        );
        v["timeline"]["width"] = Value::from(canvas.0);
        v["timeline"]["height"] = Value::from(canvas.1);
        typed_project(v)
    }

    /// The timeline rule, stated as cases. Pure — no files, no ffmpeg.
    #[test]
    fn the_canvas_only_follows_a_lone_visual_clip() {
        let fix = DimFix { index: 0, from: (640, 360), to: (360, 640) };

        // The case this exists for: one clip, canvas adopted from its stale
        // dimensions, so the canvas was never anything but a mistake.
        let solo = canvas_project(serde_json::json!([sized_media("m1", "video", 640, 360)]), (640, 360));
        assert_eq!(transposed_canvas(&solo, &[fix]), Some((360, 640)));

        // An audio bed has no dimensions and could never have set the canvas.
        let mut audio = video_media("m2");
        audio["kind"] = Value::from("audio");
        let scored = canvas_project(
            serde_json::json!([sized_media("m1", "video", 640, 360), audio]),
            (640, 360),
        );
        assert_eq!(transposed_canvas(&scored, &[fix]), Some((360, 640)));

        // A second visual media could have: a title card sized against this
        // canvas would be moved by turning it.
        let titled = canvas_project(
            serde_json::json!([
                sized_media("m1", "video", 640, 360),
                sized_media("m2", "image", 640, 360)
            ]),
            (640, 360),
        );
        assert_eq!(transposed_canvas(&titled, &[fix]), None);

        // A canvas that is not the clip's stale dimensions was not adopted from
        // it — it is the user's own framing, and the clip letterboxes inside it.
        let framed = canvas_project(serde_json::json!([sized_media("m1", "video", 640, 360)]), (1920, 1080));
        assert_eq!(transposed_canvas(&framed, &[fix]), None);

        // Nothing corrected → nothing for the canvas to follow.
        assert_eq!(transposed_canvas(&solo, &[]), None);

        // Two corrections is by definition not a lone clip.
        let second = DimFix { index: 1, from: (640, 360), to: (360, 640) };
        assert_eq!(transposed_canvas(&solo, &[fix, second]), None);
    }

    #[test]
    fn now_iso8601_is_well_formed() {
        let s = now_iso8601();
        // e.g. 2026-07-02T15:04:05Z
        assert_eq!(s.len(), 20, "unexpected length: {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
        let year: i64 = s[0..4].parse().unwrap();
        assert!(year >= 2024 && year < 3000, "implausible year: {year}");
    }

    /// Build a project at `proj` whose first (and only) clip references the
    /// first media entry, so `first_clip_media` resolves. `media` is the media
    /// array; the timeline gets one video track with a clip on `media[0]`.
    fn write_project_with_clip(proj: &Path, media: Value) {
        let first_id = media[0]["id"].as_str().unwrap().to_string();
        write_json(
            proj,
            &serde_json::json!({
                "schema": 1, "app": "taroting", "id": "p1", "name": "Thumb",
                "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                "media": media,
                "timeline": {
                    "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                    "tracks": [{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                        "clips": [{
                            "id": "c1", "mediaId": first_id,
                            "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 2.0, "speed": 1.0,
                            "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                                       "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                        }] }]
                },
                "export": {}
            }),
        );
    }

    #[test]
    fn thumb_source_none_for_unreadable_or_clipless_or_missing() {
        with_isolated("thumb-none", |dir| {
            // Nonexistent project file → None.
            let ghost = dir.join("nope.trt");
            assert!(thumb_source_for(&ghost.to_string_lossy()).is_none());

            // Valid project but no clips → first_clip_media None → None.
            let clipless = dir.join("Clipless.trt");
            write_json(
                &clipless,
                &serde_json::json!({
                    "schema": 1, "app": "taroting", "id": "p1", "name": "Clipless",
                    "createdAt": "x", "modifiedAt": "y",
                    "media": [], "export": {},
                    "timeline": { "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                        "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                                     "muted": false, "clips": [] }] }
                }),
            );
            assert!(thumb_source_for(&clipless.to_string_lossy()).is_none());

            // First clip's file-backed media is missing on disk → None (never
            // hands a nonexistent path to ffmpeg).
            let missing = dir.join("Missing.trt");
            write_project_with_clip(
                &missing,
                serde_json::json!([{
                    "id": "m1", "path": "C:\\definitely\\not\\there.mp4", "size": 1,
                    "mtimeMs": 0, "kind": "video", "duration": 2.0, "hasAudio": false
                }]),
            );
            assert!(thumb_source_for(&missing.to_string_lossy()).is_none());
        });
    }

    #[test]
    fn thumb_source_skips_generator_and_audio_first_clip() {
        with_isolated("thumb-skip", |dir| {
            // Generator-only first clip (a solid): no file, must skip cleanly.
            let gen = dir.join("Gen.trt");
            write_project_with_clip(
                &gen,
                serde_json::json!([{
                    "id": "m1", "path": "Solid #00ff00", "size": 0, "mtimeMs": 0,
                    "kind": "image", "duration": 0.0, "hasAudio": false,
                    "width": 64, "height": 64,
                    "generator": { "type": "solid", "color": "#00ff00" }
                }]),
            );
            assert!(thumb_source_for(&gen.to_string_lossy()).is_none());

            // Audio-only first clip: real file on disk, but no video frame.
            let audio_file = dir.join("a.bin");
            std::fs::write(&audio_file, b"0123456789").unwrap();
            let a_mtime = disk_mtime_ms(&audio_file);
            let aud = dir.join("Audio.trt");
            write_project_with_clip(
                &aud,
                serde_json::json!([{
                    "id": "m1", "path": audio_file.to_string_lossy(), "size": 10,
                    "mtimeMs": a_mtime, "kind": "audio", "duration": 2.0, "hasAudio": true
                }]),
            );
            assert!(thumb_source_for(&aud.to_string_lossy()).is_none());
        });
    }

    #[test]
    fn thumb_source_resolves_key_for_present_video() {
        with_isolated("thumb-ok", |dir| {
            // A file whose size + mtime match its media entry: identity ok →
            // returns the media key + a frame offset clamped into [0, 0.5].
            let media_file = dir.join("v.bin");
            std::fs::write(&media_file, b"0123456789").unwrap();
            let mtime = disk_mtime_ms(&media_file);
            let proj = dir.join("Ok.trt");
            write_project_with_clip(
                &proj,
                serde_json::json!([{
                    "id": "m1", "path": media_file.to_string_lossy(), "size": 10,
                    "mtimeMs": mtime, "kind": "video", "duration": 4.0, "hasAudio": false
                }]),
            );

            let (key, at) = thumb_source_for(&proj.to_string_lossy()).expect("should resolve");
            assert_eq!(key.size, 10);
            assert_eq!(key.mtime_ms, mtime);
            assert_eq!(key.path, media_file.to_string_lossy());
            // duration 4.0 → 4/2 = 2.0, clamped to the 0.5 cap.
            assert_eq!(at, 0.5);

            // A same-size in-place edit bumps mtime → identity stale → None.
            std::fs::write(&media_file, b"9876543210").unwrap();
            // touch mtime forward deterministically via a second write; on the
            // off chance the clock granularity kept mtime equal, force it.
            let stale = thumb_source_for(&proj.to_string_lossy());
            if disk_mtime_ms(&media_file) != mtime {
                assert!(stale.is_none(), "stale mtime must skip");
            }
        });
    }

    /* -------------------- batched thumbnail backfill ------------------- */

    /// Build a project at `<dir>/<name>.trt` backed by a real media file, seed a
    /// cached thumbnail for it, and put a thumb-less recents entry in place —
    /// i.e. exactly the state a home mount backfills. Returns the project path.
    fn seed_thumbless_card(dir: &Path, cache: &crate::cache::Cache, name: &str) -> String {
        let media_file = dir.join(format!("{name}.bin"));
        std::fs::write(&media_file, b"0123456789").unwrap();
        let mtime = disk_mtime_ms(&media_file);
        let proj = dir.join(format!("{name}.trt"));
        write_project_with_clip(
            &proj,
            serde_json::json!([{
                "id": "m1", "path": media_file.to_string_lossy(), "size": 10,
                "mtimeMs": mtime, "kind": "video", "duration": 4.0, "hasAudio": false
            }]),
        );

        // A thumb already in the cache: the batch must reuse it, so the test
        // never depends on ffmpeg.
        let hash = crate::cache::MediaKey {
            path: media_file.to_string_lossy().into_owned(),
            size: 10,
            mtime_ms: mtime,
        }
        .hash();
        cache
            .ensure_kind_dir(crate::cache::CacheKind::Thumbs)
            .unwrap();
        std::fs::write(
            cache.file_path(crate::cache::CacheKind::Thumbs, &hash, "_500.jpg"),
            b"jpg",
        )
        .unwrap();

        let path = proj.to_string_lossy().into_owned();
        upsert_recent(RecentItem {
            path: path.clone(),
            name: name.into(),
            modified_at: "m".into(),
            duration_sec: 4.0,
            thumb: None,
            size_bytes: 0,
            opened_at: None,
            kind: None,
        })
        .unwrap();
        path
    }

    /// The batching property, observed through `atomic_write`'s own `.bak`
    /// rotation: after the batch, `recents.json.bak` still holds the PRE-batch
    /// state. A second write would have rotated the once-updated file into the
    /// backup, so this pins "one write for the whole mount", not merely "the
    /// right end state".
    #[test]
    fn batched_thumb_refresh_writes_recents_exactly_once() {
        with_isolated("thumb-batch", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let jobs = crate::jobs::Jobs::default();
            let a = seed_thumbless_card(dir, &cache, "Alpha");
            let b = seed_thumbless_card(dir, &cache, "Beta");

            let resolved = refresh_thumbs_for(&cache, &jobs, &[a.clone(), b.clone()]);
            assert_eq!(resolved.len(), 2, "both cards should resolve: {resolved:?}");
            assert_eq!(resolved[0].0, a, "results follow input order");

            // End state: both entries carry their thumb.
            let items = read_recents().items;
            for path in [&a, &b] {
                let entry = items.iter().find(|r| r.path == *path).unwrap();
                assert!(entry.thumb.is_some(), "{path} should have a thumb");
            }

            // ...and the backup proves only ONE write produced it.
            let bak = paths::data_dir().unwrap().join("recents.json.bak");
            let prior: RecentsIndex =
                serde_json::from_slice(&std::fs::read(&bak).unwrap()).unwrap();
            assert_eq!(prior.items.len(), 2, "backup should be the pre-batch index");
            assert!(
                prior.items.iter().all(|r| r.thumb.is_none()),
                "a second write would have rotated a half-updated index into .bak: {prior:?}"
            );
        });
    }

    /// The single-path form still behaves exactly as before now that it shares
    /// the batched core: it returns the thumb, persists it, and stays silent for
    /// a project that cannot produce one.
    #[test]
    fn single_thumb_refresh_still_resolves_and_fails_soft() {
        with_isolated("thumb-single", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let jobs = crate::jobs::Jobs::default();
            let path = seed_thumbless_card(dir, &cache, "Solo");

            let resolved = refresh_thumbs_for(&cache, &jobs, std::slice::from_ref(&path));
            let thumb = resolved.first().map(|(_, t)| t.clone()).unwrap();
            assert!(thumb.ends_with("_500.jpg"), "got {thumb}");
            let items = read_recents().items;
            assert_eq!(
                items.iter().find(|r| r.path == path).unwrap().thumb.as_deref(),
                Some(thumb.as_str())
            );

            // A generator-only project yields nothing and touches no thumbs dir.
            let gen = dir.join("Gen.trt");
            write_project_with_clip(
                &gen,
                serde_json::json!([{
                    "id": "m1", "path": "Solid #00ff00", "size": 0, "mtimeMs": 0,
                    "kind": "image", "duration": 0.0, "hasAudio": false,
                    "width": 64, "height": 64,
                    "generator": { "type": "solid", "color": "#00ff00" }
                }]),
            );
            assert!(
                refresh_thumbs_for(&cache, &jobs, &[gen.to_string_lossy().into_owned()]).is_empty()
            );
        });
    }

    /// Parse a raw project JSON `Value` into a typed `ProjectFile` for testing
    /// `first_clip_media` directly (no files on disk, no identity checks).
    fn typed_project(v: Value) -> ProjectFile {
        serde_json::from_value(schema::migrate(v).unwrap().value).unwrap()
    }

    /// A file-backed video `MediaRef` JSON with the given id, sized 10 bytes.
    fn video_media(id: &str) -> Value {
        serde_json::json!({
            "id": id, "path": format!("C:\\media\\{id}.mp4"), "size": 10,
            "mtimeMs": 1, "kind": "video", "duration": 2.0, "hasAudio": false
        })
    }

    /// A clip JSON on `media_id` starting at `start` seconds.
    fn clip_at(id: &str, media_id: &str, start: f64) -> Value {
        serde_json::json!({
            "id": id, "mediaId": media_id,
            "timelineStart": start, "srcIn": 0.0, "srcOut": 2.0, "speed": 1.0,
            "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                       "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
        })
    }

    /// Assemble a project with the given `media` array and `tracks` array.
    fn project_with_tracks(media: Value, tracks: Value) -> Value {
        serde_json::json!({
            "schema": 1, "app": "taroting", "id": "p1", "name": "Multi",
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
            "media": media,
            "timeline": {
                "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                "tracks": tracks
            },
            "export": {}
        })
    }

    #[test]
    fn first_clip_media_uses_lower_track_when_top_is_empty() {
        // User's exact repro: V2 (topmost) empty, V1 (below) holds a clip at 0.
        // The empty top track must NOT hide V1's clip — its media resolves.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([video_media("m1")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false, "clips": [] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("c1", "m1", 0.0)] }
            ]),
        ));
        let media = first_clip_media(&proj).expect("bottom track's clip must resolve");
        assert_eq!(media.id, "m1");
    }

    #[test]
    fn first_clip_media_picks_earliest_across_tracks() {
        // Two non-empty video tracks: top starts at 5.0, bottom starts at 1.0.
        // The earliest clip (bottom, t=1.0) wins regardless of track order.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([video_media("mTop"), video_media("mBottom")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false,
                  "clips": [clip_at("c2", "mTop", 5.0)] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("c1", "mBottom", 1.0)] }
            ]),
        ));
        let media = first_clip_media(&proj).expect("earliest clip must resolve");
        assert_eq!(media.id, "mBottom");

        // Tie at the same start → topmost (lowest index) track wins.
        let tied = typed_project(project_with_tracks(
            serde_json::json!([video_media("mTop"), video_media("mBottom")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false,
                  "clips": [clip_at("c2", "mTop", 2.0)] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("c1", "mBottom", 2.0)] }
            ]),
        ));
        assert_eq!(first_clip_media(&tied).unwrap().id, "mTop");
    }

    #[test]
    fn first_clip_media_none_when_all_video_tracks_empty() {
        // No clips on any video track → None (placeholder by design).
        let proj = typed_project(project_with_tracks(
            serde_json::json!([video_media("m1")]),
            serde_json::json!([
                { "id": "t2", "kind": "video", "name": "V2", "muted": false, "clips": [] },
                { "id": "t1", "kind": "video", "name": "V1", "muted": false, "clips": [] }
            ]),
        ));
        assert!(first_clip_media(&proj).is_none());
    }

    #[test]
    fn first_clip_media_skips_audio_media_on_video_track() {
        // Defensive: earliest clip resolves to audio-kind media (shouldn't happen
        // on a video track). Fall back to the next candidate with a real frame.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([
                {
                    "id": "mAudio", "path": "C:\\media\\a.m4a", "size": 10,
                    "mtimeMs": 1, "kind": "audio", "duration": 2.0, "hasAudio": true
                },
                video_media("mVideo")
            ]),
            serde_json::json!([
                { "id": "t1", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("cA", "mAudio", 0.0), clip_at("cV", "mVideo", 3.0)] }
            ]),
        ));
        let media = first_clip_media(&proj).expect("should fall through to video");
        assert_eq!(media.id, "mVideo");
    }

    #[test]
    fn first_clip_media_ignores_audio_tracks() {
        // An audio track carrying an earlier clip must be ignored entirely; only
        // the video track's clip is a thumbnail candidate.
        let proj = typed_project(project_with_tracks(
            serde_json::json!([
                {
                    "id": "mA", "path": "C:\\media\\a.m4a", "size": 10,
                    "mtimeMs": 1, "kind": "audio", "duration": 2.0, "hasAudio": true
                },
                video_media("mV")
            ]),
            serde_json::json!([
                { "id": "tv", "kind": "video", "name": "V1", "muted": false,
                  "clips": [clip_at("cV", "mV", 4.0)] },
                { "id": "ta", "kind": "audio", "name": "A1", "muted": false,
                  "clips": [clip_at("cA", "mA", 0.0)] }
            ]),
        ));
        assert_eq!(first_clip_media(&proj).unwrap().id, "mV");
    }

    #[test]
    fn rename_preserves_unknown_fields_and_updates_name() {
        with_isolated("rename", |dir| {
            let old = dir.join("Old.trt");
            let value = serde_json::json!({
                "schema": 1, "app": "taroting", "id": "abc", "name": "Old",
                "createdAt": "x", "modifiedAt": "y",
                "media": [], "timeline": {}, "export": {},
                "futureField": { "nested": [1, 2, 3] }
            });
            write_json(&old, &value);

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "Fresh".into()).unwrap();
            assert!(new_path.ends_with("Fresh.trt"), "got {new_path}");
            assert!(!old.exists(), "old file should be gone");

            let written: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(written["name"], "Fresh");
            assert_eq!(written["id"], "abc"); // untouched
            assert_eq!(written["futureField"]["nested"], serde_json::json!([1, 2, 3]));
        });
    }

    #[test]
    fn rename_dedupes_when_target_exists() {
        with_isolated("rename-dedupe", |dir| {
            let old = dir.join("A.trt");
            write_json(&old, &serde_json::json!({ "name": "A", "id": "1" }));
            write_json(&dir.join("Taken.trt"), &serde_json::json!({ "name": "Taken" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "Taken".into()).unwrap();
            assert!(new_path.ends_with("Taken (2).trt"), "got {new_path}");
        });
    }

    #[test]
    fn rename_to_own_name_keeps_filename() {
        with_isolated("rename-self", |dir| {
            // Renaming to a name whose sanitized form equals the current stem
            // must keep "Self.trt", not dedupe to "Self (2).trt".
            let old = dir.join("Self.trt");
            write_json(&old, &serde_json::json!({ "name": "Self", "id": "1" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "Self".into()).unwrap();
            assert!(new_path.ends_with("Self.trt"), "got {new_path}");
            assert!(!new_path.ends_with("Self (2).trt"), "got {new_path}");
            assert!(Path::new(&new_path).exists());
        });
    }

    /// Every `.trt` sitting directly in `dir`, by on-disk name.
    fn trt_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".trt"))
            .collect();
        names.sort();
        names
    }

    /// A case-only rename must produce ONE file with the new casing. `exists()`
    /// is case-insensitive on Windows while the old `exclude == Some(..)` test
    /// was byte-exact, so the candidate looked taken but not excluded: the
    /// rename deduped to "my film (2).trt" and then deleted the original.
    #[test]
    fn rename_changing_only_case_keeps_a_single_file() {
        with_isolated("rename-case", |dir| {
            let old = dir.join("My Film.trt");
            write_json(&old, &serde_json::json!({ "name": "My Film", "id": "1" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "my film".into()).unwrap();

            assert!(new_path.ends_with("my film.trt"), "got {new_path}");
            assert!(!new_path.contains("(2)"), "case-only rename must not dedupe: {new_path}");
            assert_eq!(
                trt_names(dir),
                vec!["my film.trt".to_string()],
                "exactly one project file, under the new casing"
            );
            // ...and it is the renamed project, not an emptied leftover.
            let written: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(written["name"], "my film");
            assert_eq!(written["id"], "1");
        });
    }

    /// The dedupe itself must still work: a DIFFERENT project already holding
    /// the target name (case-insensitively) still pushes the rename to " (2)".
    #[test]
    fn rename_still_dedupes_against_another_project_differing_only_in_case() {
        with_isolated("rename-case-other", |dir| {
            let old = dir.join("Draft.trt");
            write_json(&old, &serde_json::json!({ "name": "Draft", "id": "1" }));
            write_json(&dir.join("Taken.trt"), &serde_json::json!({ "name": "Taken", "id": "2" }));

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "taken".into()).unwrap();
            assert!(new_path.ends_with("taken (2).trt"), "got {new_path}");
            // the other project is untouched
            let other: Value = read_raw_value(&dir.join("Taken.trt")).unwrap();
            assert_eq!(other["id"], "2");
        });
    }

    /// Two names Rust's `to_lowercase` folds together and Windows does NOT.
    /// Renaming one onto the other must dedupe, never overwrite.
    ///
    /// This is measured against real files rather than string rules, because
    /// string rules are exactly what got this wrong: folding in Rust reported
    /// the neighbour's path free, `atomic_write` rotated that innocent project
    /// into `.bak` and wrote over it, and the rename's own cleanup then
    /// mis-fired too, so the original was orphaned. One rename, two projects
    /// destroyed.
    #[test]
    fn rename_never_overwrites_a_unicode_neighbour() {
        with_isolated("rename-unicode", |dir| {
            // U+00DF vs U+1E9E, and ASCII "K" vs U+212A KELVIN SIGN. Both pairs
            // lowercase to the same string in Rust; both are two files on NTFS.
            let pairs = [
                ("Stra\u{00df}e", "Stra\u{1e9e}e"),
                ("Kelvin", "\u{212a}elvin"),
            ];
            for (i, (mine, neighbour)) in pairs.into_iter().enumerate() {
                let case = dir.join(format!("case{i}"));
                std::fs::create_dir_all(&case).unwrap();
                let mine_path = case.join(format!("{mine}.trt"));
                let neighbour_path = case.join(format!("{neighbour}.trt"));
                write_json(&mine_path, &serde_json::json!({ "name": mine, "id": "mine" }));
                write_json(
                    &neighbour_path,
                    &serde_json::json!({ "name": neighbour, "id": "neighbour" }),
                );

                // The premise, measured rather than assumed: this filesystem
                // keeps the two names apart even though Rust folds them.
                assert_eq!(mine.to_lowercase(), neighbour.to_lowercase());
                assert_eq!(
                    trt_names(&case).len(),
                    2,
                    "{mine} and {neighbour} must be two files on disk"
                );

                // Rename mine to the neighbour's exact name.
                let new_path = rename_project(
                    mine_path.to_string_lossy().into_owned(),
                    neighbour.to_string(),
                )
                .unwrap();

                // The name belongs to somebody else, so this must dedupe...
                assert!(
                    new_path.ends_with(&format!("{neighbour} (2).trt")),
                    "got {new_path}"
                );
                // ...and the neighbour must be exactly as it was: not rotated
                // into a `.bak`, not written over.
                let victim: Value = read_raw_value(&neighbour_path).unwrap();
                assert_eq!(victim["id"], "neighbour", "the neighbour was overwritten");
                assert!(
                    !case.join(format!("{neighbour}.trt.bak")).exists(),
                    "the neighbour was rotated into a .bak"
                );
                // The renamed project kept its own contents under the new name.
                let renamed: Value = read_raw_value(Path::new(&new_path)).unwrap();
                assert_eq!(renamed["id"], "mine");
                assert_eq!(renamed["name"], neighbour);
                assert_eq!(trt_names(&case).len(), 2, "no third file, and none lost");
            }
        });
    }

    /// The case-only rename fix has to keep working for names Windows folds but
    /// ASCII rules do not: NTFS folds Ü/ü, so "Ünsteady" → "ünsteady" is one
    /// file and must stay one file. An ASCII-only comparison would under-match
    /// here and dedupe to " (2)" — harmless, but avoidable by asking the
    /// filesystem which names it actually folds.
    #[test]
    fn rename_changing_only_non_ascii_case_keeps_a_single_file() {
        with_isolated("rename-case-unicode", |dir| {
            let old = dir.join("\u{dc}nsteady.trt");
            write_json(
                &old,
                &serde_json::json!({ "name": "\u{dc}nsteady", "id": "1" }),
            );

            let new_path =
                rename_project(old.to_string_lossy().into_owned(), "\u{fc}nsteady".into()).unwrap();

            assert!(new_path.ends_with("\u{fc}nsteady.trt"), "got {new_path}");
            assert!(
                !new_path.contains("(2)"),
                "case-only rename must not dedupe: {new_path}"
            );
            assert_eq!(
                trt_names(dir),
                vec!["\u{fc}nsteady.trt".to_string()],
                "exactly one project file, under the new casing"
            );
            let written: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(written["id"], "1");
            assert_eq!(written["name"], "\u{fc}nsteady");
        });
    }

    /// The predicate itself, against files that really exist. `Same` must mean
    /// the filesystem says so, not that some folding rule says so.
    #[test]
    fn path_identity_answers_from_the_filesystem() {
        with_isolated("path-identity", |dir| {
            let one = dir.join("My Film.trt");
            std::fs::write(&one, b"x").unwrap();
            // One file, three spellings this filesystem folds together.
            for spelling in ["My Film.trt", "my film.trt", "MY FILM.TRT"] {
                assert_eq!(
                    path_identity(&one, &dir.join(spelling)),
                    PathIdentity::Same,
                    "{spelling} names the same file"
                );
            }

            // Pairs Rust's to_lowercase folds and Windows keeps apart. Each is
            // written with distinct contents and read back, so "two files" is
            // observed, not assumed.
            for (a, b) in [
                ("Stra\u{00df}e.trt", "Stra\u{1e9e}e.trt"),
                ("Kelvin.trt", "\u{212a}elvin.trt"),
            ] {
                let (pa, pb) = (dir.join(a), dir.join(b));
                std::fs::write(&pa, b"aaa").unwrap();
                std::fs::write(&pb, b"bbb").unwrap();
                assert_eq!(std::fs::read(&pa).unwrap(), b"aaa", "{a} was clobbered by {b}");
                assert_eq!(
                    path_identity(&pa, &pb),
                    PathIdentity::Different,
                    "{a} and {b} are two files on disk"
                );
            }

            // Nothing to open → no answer at all. Callers must not read one
            // into it; each picks the direction whose failure is cosmetic.
            assert_eq!(
                path_identity(&dir.join("ghost.trt"), &one),
                PathIdentity::Unknown
            );
            // ...though two identical paths need no filesystem to compare.
            assert_eq!(
                path_identity(&dir.join("ghost.trt"), &dir.join("ghost.trt")),
                PathIdentity::Same
            );
        });
    }

    #[test]
    fn duplicate_gives_fresh_id_and_leaves_original() {
        with_isolated("dup", |dir| {
            let src = dir.join("Src.trt");
            write_json(
                &src,
                &serde_json::json!({ "name": "Src", "id": "orig-id", "modifiedAt": "z", "keep": true }),
            );

            let new_path = duplicate_project(
                src.to_string_lossy().into_owned(),
                "Src copy".into(),
                "new-id".into(),
            )
            .unwrap();
            assert!(new_path.ends_with("Src copy.trt"), "got {new_path}");
            assert!(src.exists(), "original must remain");

            let orig: Value = read_raw_value(&src).unwrap();
            assert_eq!(orig["id"], "orig-id"); // original untouched

            let copy: Value = read_raw_value(Path::new(&new_path)).unwrap();
            assert_eq!(copy["id"], "new-id");
            assert_eq!(copy["name"], "Src copy");
            assert_eq!(copy["keep"], true); // unknown field preserved
        });
    }

    #[test]
    fn delete_removes_file_and_bak() {
        with_isolated("delete", |dir| {
            let target = dir.join("Gone.trt");
            atomic_write(&target, b"one").unwrap();
            atomic_write(&target, b"two").unwrap(); // creates Gone.trt.bak
            let bak = dir.join("Gone.trt.bak");
            assert!(target.exists() && bak.exists());

            delete_project(target.to_string_lossy().into_owned()).unwrap();
            assert!(!target.exists(), "file should be deleted");
            assert!(!bak.exists(), ".bak should be deleted");
        });
    }

    #[test]
    fn recents_lifecycle_across_commands() {
        with_isolated("recents", |dir| {
            // Seed a recents entry for a source project.
            let src = dir.join("Proj.trt");
            write_json(
                &src,
                &serde_json::json!({ "name": "Proj", "id": "1", "modifiedAt": "m" }),
            );
            upsert_recent(RecentItem {
                path: src.to_string_lossy().into_owned(),
                name: "Proj".into(),
                modified_at: "m".into(),
                duration_sec: 12.5,
                thumb: None,
                size_bytes: 0,
                opened_at: Some("2020-01-01T00:00:00Z".into()),
                kind: None,
            })
            .unwrap();
            assert_eq!(read_recents().items.len(), 1, "seed should persist");

            // Rename → recents entry path+name updated in place.
            let renamed =
                rename_project(src.to_string_lossy().into_owned(), "Renamed".into()).unwrap();
            let items = read_recents().items;
            assert!(items.iter().any(|r| r.path == renamed && r.name == "Renamed"));
            assert!(!items.iter().any(|r| r.name == "Proj"));

            // Duplicate → new recents entry carrying the source duration, no openedAt.
            let dup = duplicate_project(renamed.clone(), "Renamed copy".into(), "dup-id".into())
                .unwrap();
            let items = read_recents().items;
            let dup_entry = items.iter().find(|r| r.path == dup).unwrap();
            assert_eq!(dup_entry.duration_sec, 12.5);
            assert!(dup_entry.opened_at.is_none());

            // Delete → recents entry removed.
            delete_project(dup.clone()).unwrap();
            assert!(!read_recents().items.iter().any(|r| r.path == dup));

            // list_recents refreshes size_bytes for survivors.
            let listed = list_recents().unwrap();
            let entry = listed.items.iter().find(|r| r.path == renamed).unwrap();
            assert!(entry.size_bytes > 0, "size should be stat'ed");
        });
    }

    #[test]
    fn atomic_write_rotates_backup() {
        let dir = std::env::temp_dir().join(format!("taroting-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("file.json");

        atomic_write(&target, b"one").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"one");

        atomic_write(&target, b"two").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"two");
        let bak = dir.join("file.json.bak");
        assert_eq!(std::fs::read(&bak).unwrap(), b"one");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* -------------------- corruption / data-loss guards ---------------- */

    #[test]
    fn a_zero_speed_clip_is_normalised_and_keeps_recents_intact() {
        with_isolated("nonfinite-duration", |dir| {
            // A healthy project already sitting in recents.
            let healthy = dir.join("Healthy.trt");
            write_json(&healthy, &minimal_project("Healthy"));
            upsert_recent(RecentItem {
                path: healthy.to_string_lossy().into_owned(),
                name: "Healthy".into(),
                modified_at: "m".into(),
                duration_sec: 12.5,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
                kind: None,
            })
            .unwrap();

            // `speed: 0` USED to make Clip::duration() infinite, and
            // Timeline::duration() propagated it. serde_json writes a non-finite
            // f64 as `null`, which made the WHOLE index unparseable — 2 entries
            // in, 0 out, i.e. every project card gone from home.
            //
            // `de_speed` in schema.rs now normalises a zero/negative/non-finite
            // speed to 1.0 at the deserialize boundary, so the hazard no longer
            // starts. This case is kept, and still loaded end to end, because it
            // is the regression guard for that: if the normalisation is ever
            // dropped the duration goes non-finite again right here. The index's
            // own tolerance for a `null` duration is guarded separately by
            // `null_duration_in_a_stored_index_does_not_wipe_it`.
            let mut v = minimal_project("Poisoned");
            v["media"] = serde_json::json!([video_media("m1")]);
            v["timeline"]["tracks"] = serde_json::json!([{
                "id": "t1", "kind": "video", "name": "V1", "muted": false,
                "clips": [{
                    "id": "c1", "mediaId": "m1",
                    "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 2.0, "speed": 0.0,
                    "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                               "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                }]
            }]);
            let poisoned = dir.join("Poisoned.trt");
            write_json(&poisoned, &v);

            // The speed is normalised on the way in, so the duration is finite:
            // 2.0 s of source at 1.0x. A revert of `de_speed` fails here first.
            let typed = typed_project(v);
            assert!(
                typed.timeline.duration().is_finite(),
                "a zero speed must be normalised at deserialize, not propagated"
            );
            assert_eq!(typed.timeline.tracks[0].clips[0].speed, 1.0);

            // load_project → stamp_opened persists it into the index.
            load_project(poisoned.to_string_lossy().into_owned()).unwrap();

            let listed = list_recents().unwrap();
            assert_eq!(listed.items.len(), 2, "index was wiped: {listed:?}");
            let bad = listed.items.iter().find(|r| r.name == "Poisoned").unwrap();
            assert_eq!(
                bad.duration_sec, 2.0,
                "the normalised 1.0x speed must yield the real 2 s duration"
            );
            let ok = listed.items.iter().find(|r| r.name == "Healthy").unwrap();
            assert_eq!(ok.duration_sec, 12.5, "the other entry must be intact");
        });
    }

    #[test]
    fn null_duration_in_a_stored_index_does_not_wipe_it() {
        // An index written by an older build carries a literal `null` here.
        // Parsing must degrade to one wrong duration, never to an empty home.
        let raw = r#"{"schema":1,"items":[
            {"path":"C:\\a.trt","name":"A","modifiedAt":"m","durationSec":null},
            {"path":"C:\\b.trt","name":"B","modifiedAt":"m","durationSec":4.5},
            {"path":"C:\\c.trt","name":"C","modifiedAt":"m"}]}"#;
        let index: RecentsIndex = serde_json::from_str(raw).unwrap();
        assert_eq!(index.items.len(), 3);
        assert_eq!(index.items[0].duration_sec, 0.0);
        assert_eq!(index.items[1].duration_sec, 4.5);
        assert_eq!(index.items[2].duration_sec, 0.0);
    }

    #[test]
    fn load_recovers_from_bak_when_primary_missing() {
        with_isolated("bak-missing-primary", |dir| {
            // A save whose final rename failed used to leave exactly this on
            // disk: no project, only the rotated `.bak`. Reading it returned
            // NotFound, so the project looked permanently lost even though a
            // good copy was sitting right next to it.
            let proj = dir.join("Rescued.trt");
            write_json(&dir.join("Rescued.trt.bak"), &minimal_project("Rescued"));
            assert!(!proj.exists());

            let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
            assert!(loaded.recovered, "must be flagged as recovered from .bak");
            assert_eq!(loaded.project["name"], "Rescued");

            // With neither copy present the error still surfaces.
            let ghost = dir.join("Ghost.trt");
            assert!(load_project(ghost.to_string_lossy().into_owned()).is_err());
        });
    }

    /// The recovery above is only useful if the user can still REACH the
    /// project. list_recents drops entries whose file is gone, which would hide
    /// exactly the interrupted-save case it is meant to rescue.
    #[test]
    fn recents_keeps_a_project_surviving_only_as_bak() {
        with_isolated("recents-bak-survivor", |dir| {
            let alive = dir.join("Alive.trt");
            write_json(&alive, &minimal_project("Alive"));

            // Interrupted save: primary rotated to .bak, replacement never landed.
            let wounded = dir.join("Wounded.trt");
            write_json(&dir.join("Wounded.trt.bak"), &minimal_project("Wounded"));
            assert!(!wounded.exists());

            // Genuinely deleted: neither copy on disk.
            let gone = dir.join("Gone.trt");

            for (p, name) in [(&alive, "Alive"), (&wounded, "Wounded"), (&gone, "Gone")] {
                upsert_recent(RecentItem {
                    path: p.to_string_lossy().into_owned(),
                    name: name.into(),
                    modified_at: String::new(),
                    duration_sec: 0.0,
                    thumb: None,
                    size_bytes: 0,
                    opened_at: None,
                    kind: None,
                })
                .unwrap();
            }

            let names: Vec<String> = list_recents()
                .unwrap()
                .items
                .into_iter()
                .map(|r| r.path)
                .collect();
            let has = |p: &std::path::Path| names.iter().any(|n| n == &*p.to_string_lossy());

            assert!(has(&alive), "a normal project must stay listed");
            assert!(has(&wounded), "a .bak-only project must stay reachable");
            assert!(!has(&gone), "a deleted project must still be dropped");
        });
    }

    /// Both halves of the ".bak was written but never read" bug. The settings
    /// half lives here rather than in `settings.rs` because APPDATA is a
    /// process-global: only `ENV_LOCK` + `with_isolated` keep it from racing the
    /// other tests in this file.
    #[test]
    fn corrupt_primary_recovers_from_bak_for_recents_and_settings() {
        with_isolated("bak-recovery", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();

            // Recents: a truncated index used to silently mean "no projects".
            let good = RecentsIndex {
                schema: 1,
                items: vec![RecentItem {
                    path: "C:\\projects\\Kept.trt".into(),
                    name: "Kept".into(),
                    modified_at: "m".into(),
                    duration_sec: 3.5,
                    thumb: None,
                    size_bytes: 0,
                    opened_at: None,
                    kind: None,
                }],
            };
            std::fs::write(
                data.join("recents.json.bak"),
                serde_json::to_vec(&good).unwrap(),
            )
            .unwrap();
            std::fs::write(data.join("recents.json"), b"{\"schema\":1,\"items\":[{\"pa").unwrap();

            let items = read_recents().items;
            assert_eq!(items.len(), 1, "should have recovered from the .bak");
            assert_eq!(items[0].name, "Kept");
            assert_eq!(items[0].duration_sec, 3.5);

            // Settings: a corrupt file used to silently apply ALL defaults, and
            // the next save then destroyed the last good backup for good.
            let settings = data.join("settings.json");
            std::fs::write(
                data.join("settings.json.bak"),
                serde_json::to_vec(&serde_json::json!({ "theme": "dark", "monitorVolume": 0.42 }))
                    .unwrap(),
            )
            .unwrap();
            std::fs::write(&settings, b"not json at all").unwrap();

            let loaded = crate::settings::read_settings().unwrap();
            assert_eq!(loaded.status, crate::settings::SettingsStatus::Ok);
            assert!(loaded.recovered, "the .bak supplied the value");
            let value = loaded
                .settings
                .expect("settings should be recovered from the .bak");
            assert_eq!(value["theme"], "dark");
            assert_eq!(value["monitorVolume"], 0.42);

            // Nothing on disk at all is still a clean first run → frontend defaults.
            std::fs::remove_file(&settings).unwrap();
            std::fs::remove_file(data.join("settings.json.bak")).unwrap();
            let fresh = crate::settings::read_settings().unwrap();
            assert_eq!(fresh.status, crate::settings::SettingsStatus::Absent);
            assert!(fresh.settings.is_none());
        });
    }

    /// `get_settings` must tell the three read outcomes apart. Collapsing
    /// "exists but unreadable" into the same `null` as "nothing there yet" made
    /// the frontend treat a corrupt or locked settings.json as a FIRST RUN: no
    /// toast, the overwrite guard marked itself verified, and the next save put
    /// `{ ...DEFAULTS, ...patch }` over the user's real preferences.
    #[test]
    fn get_settings_separates_absent_from_unreadable() {
        use crate::settings::{read_settings as get_settings, SettingsStatus};

        with_isolated("settings-status", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let settings = data.join("settings.json");
            let bak = data.join("settings.json.bak");

            // Neither copy on disk → a clean first run; defaults are safe.
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Absent);
            assert!(r.settings.is_none());
            assert!(!r.recovered);

            // A readable primary → Ok, no recovery involved.
            std::fs::write(&settings, br#"{"theme":"dark","monitorVolume":0.42}"#).unwrap();
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Ok);
            assert!(!r.recovered);
            assert_eq!(r.settings.unwrap()["monitorVolume"], 0.42);

            // Corrupt primary + good backup → still Ok, flagged as recovered.
            std::fs::write(&bak, br#"{"theme":"light"}"#).unwrap();
            std::fs::write(&settings, b"not json at all").unwrap();
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Ok);
            assert!(r.recovered, "the .bak supplied the value");
            assert_eq!(r.settings.unwrap()["theme"], "light");

            // Both copies corrupt → Unreadable, NOT Absent. Something is stored;
            // we simply cannot read it, so nothing may be written over it.
            std::fs::write(&bak, b"also not json").unwrap();
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Unreadable);
            assert!(r.settings.is_none());
        });
    }

    /// The cause named in `get_settings`'s own comment: a Windows lock making
    /// `std::fs::read` fail. The file is present and perfectly VALID — the read
    /// just cannot happen right now — which is the case most easily mistaken
    /// for a first run, and the most expensive one to get wrong.
    #[cfg(windows)]
    #[test]
    fn a_locked_settings_file_reads_as_unreadable_not_absent() {
        use crate::settings::{read_settings as get_settings, SettingsStatus};
        use std::os::windows::fs::OpenOptionsExt;

        with_isolated("settings-locked", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let settings = data.join("settings.json");
            std::fs::write(&settings, br#"{"theme":"dark"}"#).unwrap();

            // FILE_SHARE_NONE, as an AV scanner or a sync agent would hold it:
            // every byte is intact, `std::fs::read` just gets a sharing
            // violation (os error 32) rather than NotFound.
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&settings)
                .unwrap();

            let r = get_settings().unwrap();
            assert_eq!(
                r.status,
                SettingsStatus::Unreadable,
                "a locked settings.json is present, not absent"
            );
            assert!(r.settings.is_none());

            // Released → readable again, and the file was never touched.
            drop(lock);
            let r = get_settings().unwrap();
            assert_eq!(r.status, SettingsStatus::Ok);
            assert_eq!(r.settings.unwrap()["theme"], "dark");
        });
    }

    /// An index that exists but cannot be read is NOT an empty index. Writing
    /// the empty default over it rotated the last good copy into `.bak`, and
    /// because the fresh primary then parsed fine the recovery path never
    /// looked at that backup again — one unreadable file plus one ordinary save
    /// lost the user's entire recents list.
    #[test]
    fn an_unreadable_recents_index_is_never_overwritten() {
        with_isolated("recents-unreadable", |dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let recents = data.join("recents.json");
            let bak = data.join("recents.json.bak");

            // Both copies truncated: unreadable, not absent.
            std::fs::write(&recents, b"{\"schema\":1,\"items\":[{\"pa").unwrap();
            std::fs::write(&bak, b"{\"schema\":1,\"items\":[{\"na").unwrap();
            let before = std::fs::read(&recents).unwrap();
            let before_bak = std::fs::read(&bak).unwrap();

            let card = |path: &Path, name: &str| RecentItem {
                path: path.to_string_lossy().into_owned(),
                name: name.into(),
                modified_at: "m".into(),
                duration_sec: 1.0,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
                kind: None,
            };

            let proj = dir.join("Saved.trt");
            write_json(&proj, &minimal_project("Saved"));

            // A save must still succeed — recents is a convenience, and a
            // corrupt index must not be able to fail the user's actual work.
            upsert_recent(card(&proj, "Saved")).unwrap();
            assert_eq!(
                std::fs::read(&recents).unwrap(),
                before,
                "an unreadable index must be left exactly as found"
            );
            assert_eq!(
                std::fs::read(&bak).unwrap(),
                before_bak,
                "the backup must not be rotated away either"
            );

            // The other mutation paths hold the same line.
            load_project(proj.to_string_lossy().into_owned()).unwrap(); // stamp_opened
            remove_recent(proj.to_string_lossy().into_owned()).unwrap();
            delete_project(proj.to_string_lossy().into_owned()).unwrap();
            assert_eq!(std::fs::read(&recents).unwrap(), before);
            assert_eq!(std::fs::read(&bak).unwrap(), before_bak);

            // Genuine ABSENCE is a different thing and stays writable — that is
            // just a first run.
            std::fs::remove_file(&recents).unwrap();
            std::fs::remove_file(&bak).unwrap();
            let fresh = dir.join("Fresh.trt");
            write_json(&fresh, &minimal_project("Fresh"));
            upsert_recent(card(&fresh, "Fresh")).unwrap();
            assert_eq!(
                read_recents().items.len(),
                1,
                "an absent index must accept writes"
            );
        });
    }

    /// A rotation that fails must leave the previous backup where it was.
    /// Deleting the old `.bak` first meant a write going wrong took the backup
    /// down with it — no primary update, and no fallback either.
    #[cfg(windows)]
    #[test]
    fn a_failed_rotation_leaves_the_previous_backup_intact() {
        use std::os::windows::fs::OpenOptionsExt;

        with_isolated("bak-rotation", |dir| {
            let target = dir.join("Project.trt");
            atomic_write(&target, b"first").unwrap();
            atomic_write(&target, b"second").unwrap(); // rotates "first" into .bak
            let bak = dir.join("Project.trt.bak");
            assert_eq!(std::fs::read(&bak).unwrap(), b"first");

            // Hold the PRIMARY with no sharing (FILE_SHARE_NONE) so it cannot be
            // moved: the rotation rename fails, while the `.bak` — a different
            // file — stays perfectly deletable. That asymmetry is exactly what
            // made the old pre-delete destructive.
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&target)
                .unwrap();

            let err = atomic_write(&target, b"third");
            assert!(err.is_err(), "the rotation should have failed");
            assert_eq!(
                std::fs::read(&bak).unwrap(),
                b"first",
                "the last good backup must survive a failed write"
            );

            drop(lock);
            assert_eq!(
                std::fs::read(&target).unwrap(),
                b"second",
                "and the primary must be untouched"
            );
        });
    }

    /* -------------------- temp quick-view projects -------------------- */

    /// A minimal, clip-less but valid project JSON — enough for load_project to
    /// parse and (for a non-temp path) stamp a recents entry.
    fn minimal_project(name: &str) -> Value {
        serde_json::json!({
            "schema": 1, "app": "taroting", "id": "p1", "name": name,
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
            "media": [], "export": {},
            "timeline": {
                "fps": {"num": 30, "den": 1}, "width": 640, "height": 360,
                "tracks": [{ "id": "t1", "kind": "video", "name": "V1",
                             "muted": false, "clips": [] }]
            }
        })
    }

    #[test]
    fn temp_project_path_lands_in_temp_dir_and_dedupes() {
        with_isolated("temp-path", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();

            // First call → "<base>.trt" directly under the temp dir, nowhere near
            // Documents\Taroting.
            let p1 = temp_project_path(Some("Clip".into())).unwrap();
            let p1_path = Path::new(&p1);
            assert!(p1_path.starts_with(&tmp), "{p1} should be under {tmp:?}");
            assert!(p1.ends_with("Clip.trt"), "got {p1}");
            assert!(is_temp_project_path(&p1), "path must classify as temp");

            // Materialize it, then a second call must dedupe with a bare-space
            // suffix (mirroring new_project_path's naming).
            std::fs::write(p1_path, b"{}").unwrap();
            let p2 = temp_project_path(Some("Clip".into())).unwrap();
            assert!(p2.ends_with("Clip 2.trt"), "got {p2}");

            // A Documents path is NOT classified as temp.
            let permanent = new_project_path(Some("Clip".into())).unwrap();
            assert!(!is_temp_project_path(&permanent), "{permanent} is not temp");
        });
    }

    #[test]
    fn temp_projects_dir_command_matches_creation_dir() {
        with_isolated("temp-dir-cmd", |_dir| {
            // The command the frontend uses to classify open-with paths must
            // report exactly the dir temp_project_path creates into — otherwise a
            // .trt physically in the temp dir wouldn't be recognized as temp.
            let reported = temp_projects_dir().unwrap();
            let created = temp_project_path(Some("Clip".into())).unwrap();
            assert!(
                Path::new(&created).starts_with(&reported),
                "{created} should live under reported dir {reported}"
            );
            // And the reported dir is precisely paths::temp_projects_dir().
            assert_eq!(
                reported,
                paths::temp_projects_dir().unwrap().to_string_lossy()
            );
        });
    }

    #[test]
    fn load_project_on_temp_path_creates_no_recents_entry() {
        with_isolated("temp-load", |_dir| {
            // A project living in the temp dir must never be stamped into recents.
            let temp_path = temp_project_path(Some("Quick".into())).unwrap();
            write_json(Path::new(&temp_path), &minimal_project("Quick"));

            load_project(temp_path.clone()).unwrap();
            assert!(
                read_recents().items.is_empty(),
                "temp quick-view load must not touch recents"
            );

            // Sanity: the same load from a permanent path DOES stamp recents, so
            // the skip is specific to the temp dir (not a broken stamp path).
            let perm_dir = paths::default_projects_dir().unwrap();
            paths::ensure_dir(&perm_dir).unwrap();
            let perm_path = perm_dir.join("Kept.trt");
            write_json(&perm_path, &minimal_project("Kept"));
            load_project(perm_path.to_string_lossy().into_owned()).unwrap();
            assert_eq!(
                read_recents().items.len(),
                1,
                "permanent load should stamp exactly one recents entry"
            );
        });
    }

    /// A temporary project as the editor writes one, edited (`tempEdited:
    /// true`) or not — and, for the lenient-read rows, with any other value.
    fn temp_project(name: &str, edited: Option<Value>) -> Value {
        let mut p = minimal_project(name);
        if let Some(v) = edited {
            p["tempEdited"] = v;
        }
        p
    }

    /// Backdate a file's modification time by `days`.
    fn age_by_days(path: &Path, days: u64) {
        let when = SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60);
        std::fs::File::options().write(true).open(path).unwrap().set_modified(when).unwrap();
    }

    /// A page reload adopts the temporary projects that were in the folder
    /// when the page died: the edited one is offered back on Home at once
    /// (before, only the next launch's sweep found it), the untouched one is
    /// not offered and NOT deleted (the dead page's writes may still be
    /// landing), and a session the reloaded page opens afterwards — after the
    /// listing — is never offered, edited or not. A waiter for the list is
    /// released only when the adoption is finished, and what `finish`
    /// records first is visible to it.
    #[test]
    fn a_page_reload_offers_back_the_temp_project_that_was_open() {
        with_isolated("temp-reload", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();
            paths::ensure_dir(&tmp).unwrap();
            cleanup_temp_projects();
            assert!(orphan_temp_projects().is_empty(), "fixture: nothing kept at startup");
            let put = |file: &str, v: &Value| write_json(&tmp.join(file), v);
            put("Open.trt", &temp_project("Open", Some(Value::Bool(true))));
            put("Untouched.trt", &temp_project("Untouched", None));

            let adoption = begin_reload_adoption();
            // The reloaded page opens a session of its own and edits it.
            put("New session.trt", &temp_project("New session", Some(Value::Bool(true))));
            let waiter = std::thread::spawn(orphans_for_home);
            std::thread::sleep(Duration::from_millis(100));
            assert!(!waiter.is_finished(), "the list did not wait for the adoption");
            let adopted = std::sync::atomic::AtomicBool::new(false);
            adoption.finish(|a| adopted.store(a, std::sync::atomic::Ordering::SeqCst));
            assert!(adopted.load(std::sync::atomic::Ordering::SeqCst), "the open project was newly adopted");

            let open = tmp.join("Open.trt").to_string_lossy().into_owned();
            assert_eq!(waiter.join().unwrap(), vec![open.clone()]);
            assert_eq!(orphan_temp_projects(), vec![open]);
            assert!(tmp.join("Untouched.trt").exists(), "an adoption never deletes");

            // The reloaded page dies too: its session is adopted now, and the
            // project already offered is not listed twice.
            begin_reload_adoption().finish(|_| {});
            let mut offered = orphan_temp_projects();
            offered.sort();
            let want: Vec<String> =
                ["New session.trt", "Open.trt"].iter().map(|n| tmp.join(n).to_string_lossy().into_owned()).collect();
            assert_eq!(offered, want);
        });
    }

    /// The startup sweep (owner's ruling): an EDITED temporary project a crash
    /// orphaned is kept and offered back unless it is over 30 days old; an
    /// untouched one is deleted, as is every leftover (`.tmp`, `.part`, any
    /// other file, a `.bak` beside its `.trt`). A `.bak` with no `.trt` is the
    /// project itself and is judged as one. Only a literal `true` counts as
    /// edited. Folders and Documents are never touched. Before this every file
    /// in the folder was deleted, edits and all.
    #[test]
    fn the_startup_sweep_keeps_only_edited_recent_temp_projects() {
        with_isolated("temp-sweep", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();
            paths::ensure_dir(&tmp).unwrap();
            let edited = |name: &str| temp_project(name, Some(Value::Bool(true)));
            let put = |file: &str, v: &Value| write_json(&tmp.join(file), v);

            put("Edited.trt", &edited("Edited"));
            put("Edited.trt.bak", &edited("Edited"));
            put("Loud.TRT", &edited("Loud"));
            put("Month old.trt", &edited("Month old"));
            age_by_days(&tmp.join("Month old.trt"), 29);
            put("Too old.trt", &edited("Too old"));
            age_by_days(&tmp.join("Too old.trt"), 31);
            put("Untouched.trt", &temp_project("Untouched", None));
            put("Untouched.trt.bak", &temp_project("Untouched", None));
            put("Truthy.trt", &temp_project("Truthy", Some(Value::from("true"))));
            put("Crashed.trt.bak", &edited("Crashed"));
            put("Plain crash.trt.bak", &temp_project("Plain crash", None));
            std::fs::write(tmp.join("Corrupt.trt"), b"{\"tempEdited\": tr").unwrap();
            // A crash before the OS flushed the last save: the `.trt` is
            // zeroed, the `.bak` beside it is complete and edited.
            std::fs::write(tmp.join("Zeroed.trt"), b"").unwrap();
            put("Zeroed.trt.bak", &edited("Zeroed"));
            // Torn too, but the `.bak` holds nothing worth offering.
            std::fs::write(tmp.join("Torn plain.trt"), b"").unwrap();
            put("Torn plain.trt.bak", &temp_project("Torn plain", None));
            for leftover in ["Edited.trt.tmp", "photo.png.part", "notes.txt"] {
                std::fs::write(tmp.join(leftover), b"x").unwrap();
            }
            std::fs::create_dir(tmp.join("Folder.trt")).unwrap();
            let perm_dir = paths::default_projects_dir().unwrap();
            paths::ensure_dir(&perm_dir).unwrap();
            let documents = perm_dir.join("Untouched.trt");
            write_json(&documents, &temp_project("Documents", None));

            cleanup_temp_projects();

            let mut left: Vec<String> = std::fs::read_dir(&tmp)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            left.sort();
            assert_eq!(
                left,
                ["Crashed.trt.bak", "Edited.trt", "Folder.trt", "Loud.TRT", "Month old.trt", "Zeroed.trt", "Zeroed.trt.bak"]
            );
            assert!(documents.exists(), "Documents is never swept");

            let mut offered = orphan_temp_projects();
            offered.sort();
            let want: Vec<String> = ["Crashed.trt", "Edited.trt", "Loud.TRT", "Month old.trt", "Zeroed.trt"]
                .iter()
                .map(|n| tmp.join(n).to_string_lossy().into_owned())
                .collect();
            assert_eq!(offered, want, "the .bak-only one is offered by its .trt path");
            // That path opens: the load recovers it from the .bak.
            let crashed = load_project(want[0].clone()).unwrap();
            assert!(crashed.recovered);
            assert_eq!(crashed.project["name"], "Crashed");
            // So does the zeroed one: its .bak supplies the project.
            let zeroed = load_project(want[4].clone()).unwrap();
            assert!(zeroed.recovered, "the zeroed .trt is recovered from its .bak");
            assert_eq!(zeroed.project["name"], "Zeroed");

            // A second sweep keeps the same set and deletes nothing more.
            cleanup_temp_projects();
            let mut again = orphan_temp_projects();
            again.sort();
            assert_eq!(again, want);
        });
    }

    /// What Home is offered is what THIS run's sweep kept, never a fresh look
    /// at the folder: a temporary project opened after the sweep — the user's
    /// live session, marked edited by its first edit — is not an orphan. One
    /// the user recovered and then kept or discarded drops out. A new temp
    /// name never collides with a kept orphan, even one left only as a `.bak`.
    #[test]
    fn only_the_sweep_s_survivors_are_offered_back() {
        with_isolated("temp-offer", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();
            paths::ensure_dir(&tmp).unwrap();
            write_json(&tmp.join("Clip.trt.bak"), &temp_project("Clip", Some(Value::Bool(true))));
            write_json(&tmp.join("Photo.trt"), &temp_project("Photo", Some(Value::Bool(true))));
            cleanup_temp_projects();
            assert_eq!(orphan_temp_projects().len(), 2);

            // The live session: a temp project of the same media name, edited.
            let live = temp_project_path(Some("Clip".into())).unwrap();
            assert!(live.ends_with("Clip 2.trt"), "the orphan's name stays its own: {live}");
            write_json(Path::new(&live), &temp_project("Clip", Some(Value::Bool(true))));
            let offered = orphan_temp_projects();
            assert!(!offered.contains(&live), "the open session is offered back: {offered:?}");

            // Recovered and discarded: gone from disk, gone from the offer.
            delete_project(tmp.join("Photo.trt").to_string_lossy().into_owned()).unwrap();
            assert_eq!(orphan_temp_projects(), [tmp.join("Clip.trt").to_string_lossy().into_owned()]);
        });
    }

    /// A temporary project the sweep cannot read (held open with no sharing,
    /// as a scanner would) is neither deleted nor offered: the next launch
    /// decides again.
    #[cfg(windows)]
    #[test]
    fn an_unreadable_temp_project_is_left_for_the_next_launch() {
        use std::os::windows::fs::OpenOptionsExt;
        with_isolated("temp-locked", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();
            paths::ensure_dir(&tmp).unwrap();
            let locked = tmp.join("Locked.trt");
            write_json(&locked, &temp_project("Locked", Some(Value::Bool(true))));
            let hold = std::fs::OpenOptions::new().read(true).share_mode(0).open(&locked).unwrap();
            cleanup_temp_projects();
            drop(hold);
            assert!(locked.exists(), "an unreadable project must not be deleted");
            assert!(orphan_temp_projects().is_empty(), "nor offered");
        });
    }

    /// A REAL JPEG coded (w, h) — one `testsrc2` frame from the bundled ffmpeg,
    /// which the frame probe can decode — carrying `tiff` as its EXIF block.
    /// For every still the repair confirms with ffprobe; a header-only
    /// `still_file` would leave that answer to how leniently ffmpeg decodes
    /// two bytes of scan data.
    fn real_still_file(dir: &Path, name: &str, (w, h): (u16, u16), tiff: &[u8]) -> PathBuf {
        use crate::media::exif::tests::jpeg_with_exif;
        let base = dir.join(format!("{w}x{h} base.jpg"));
        if !base.exists() {
            let size = format!("testsrc2=size={w}x{h}");
            let out = crate::jobs::ffmpeg::run(
                "ffmpeg",
                &["-y", "-f", "lavfi", "-i", &size, "-frames:v", "1", base.to_str().unwrap()],
            )
            .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let file = dir.join(name);
        std::fs::write(&file, jpeg_with_exif(&std::fs::read(&base).unwrap(), tiff)).unwrap();
        file
    }

    /// A header-only JPEG coded (w, h) carrying EXIF orientation `o` (none at
    /// all when `o` is 0). Enough for every still the repair settles from the
    /// header alone — no ffmpeg, no shared `%TEMP%` fixture. A candidate the
    /// frame probe must confirm needs `real_still_file` instead.
    fn still_file(dir: &Path, name: &str, (w, h): (u16, u16), o: u16) -> PathBuf {
        use crate::media::exif::tests::{jpeg_with_exif, tiff_orientation, tiny_jpeg};
        let base = tiny_jpeg(w, h);
        let bytes = if o == 0 { base } else { jpeg_with_exif(&base, &tiff_orientation(o, false)) };
        let file = dir.join(name);
        std::fs::write(&file, bytes).unwrap();
        file
    }

    /// A still entry for `file` with the given stored size and a true identity.
    fn still_media(id: &str, file: &Path, (w, h): (u32, u32)) -> Value {
        let meta = std::fs::metadata(file).unwrap();
        serde_json::json!({
            "id": id, "path": file.to_string_lossy(),
            "size": meta.len(), "mtimeMs": mtime_ms_of(&meta),
            "kind": "image", "duration": 0.0, "hasAudio": false,
            "width": w, "height": h, "container": "jpeg_pipe"
        })
    }

    /// A CURRENT-schema project, so the video repair's unconditional write can
    /// never stand in for the still repair's own, with a field this build
    /// knows nothing about.
    fn write_current_project(proj: &Path, media: Value, canvas: (u32, u32)) {
        write_json(
            proj,
            &serde_json::json!({
                "schema": schema::CURRENT_SCHEMA, "app": "taroting", "id": "p1", "name": "Stills",
                "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
                "media": media,
                "timeline": {
                    "fps": {"num": 30, "den": 1}, "width": canvas.0, "height": canvas.1,
                    "tracks": [{ "id": "t1", "kind": "video", "name": "V1", "muted": false, "clips": [] }]
                },
                "export": {},
                "unknownFutureField": {"keep": "me"}
            }),
        );
    }

    fn read_disk(proj: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(proj).unwrap()).unwrap()
    }

    /// Load `proj` with its `.bak` cleared first, returning the result and
    /// whether the load WROTE the file — `atomic_write` rotates the primary
    /// onto `.bak`, so a `.bak` afterwards is a write, whatever bytes it wrote.
    fn load_and_see_write(proj: &Path) -> (LoadedProject, bool) {
        let _ = std::fs::remove_file(bak_path(proj));
        let loaded = load_project(proj.to_string_lossy().into_owned()).unwrap();
        (loaded, bak_path(proj).exists())
    }

    /// The case this exists for: a portrait photo (coded 64x36, orientation 6)
    /// stored at its coded size by the old probe. One load confirms the turn
    /// with the real frame probe, repairs and flags it and writes that down;
    /// after that the flag keeps the file unread and the project unwritten.
    /// The canvas equals the stale pair on purpose — the exact shape the VIDEO
    /// repair would turn — and must not move.
    #[test]
    fn a_turned_still_is_repaired_once_and_flagged() {
        with_isolated("still-turned", |dir| {
            use crate::media::exif::tests::tiff_orientation;
            let file = real_still_file(dir, "portrait.jpg", (64, 36), &tiff_orientation(6, false));
            let proj = dir.join("Stills.trt");
            write_current_project(&proj, serde_json::json!([still_media("m1", &file, (64, 36))]), (64, 36));

            let (loaded, wrote) = load_and_see_write(&proj);
            assert!(loaded.missing.is_empty(), "{:?}", loaded.missing);
            assert_eq!(loaded.project["media"][0]["width"], 36);
            assert_eq!(loaded.project["media"][0]["height"], 64);
            assert_eq!(loaded.project["media"][0]["oriented"], true);
            assert_eq!(loaded.project["timeline"]["width"], 64, "a still never turns the canvas");
            assert_eq!(loaded.project["timeline"]["height"], 36);
            assert!(wrote, "the repair must be persisted");
            let disk = read_disk(&proj);
            assert_eq!(disk["media"][0]["width"], 36);
            assert_eq!(disk["media"][0]["height"], 64);
            assert_eq!(disk["media"][0]["oriented"], true);
            assert_eq!(disk["unknownFutureField"]["keep"], "me", "a surgical edit, not a re-serialize");

            // Second load: nothing to do, so nothing is written.
            let (again, wrote) = load_and_see_write(&proj);
            assert!(!wrote, "an already-repaired project was rewritten");
            assert_eq!(again.project["media"][0]["width"], 36);

            // THE FLAG. Put the stale pair back with the flag still on: only
            // the flag can keep the next load from transposing it again.
            let mut poisoned = read_disk(&proj);
            poisoned["media"][0]["width"] = Value::from(64);
            poisoned["media"][0]["height"] = Value::from(36);
            write_json(&proj, &poisoned);
            let (flagged, wrote) = load_and_see_write(&proj);
            assert_eq!(flagged.project["media"][0]["width"], 64, "a flagged still was re-read");
            assert_eq!(flagged.project["media"][0]["height"], 36);
            assert!(!wrote);

            // CONSTRUCTION. Repaired dims with the flag lost (a copy that
            // dropped it): re-checked, never turned a second time.
            let mut unflagged = read_disk(&proj);
            unflagged["media"][0]["width"] = Value::from(36);
            unflagged["media"][0]["height"] = Value::from(64);
            unflagged["media"][0].as_object_mut().unwrap().remove("oriented");
            write_json(&proj, &unflagged);
            let (rechecked, _) = load_and_see_write(&proj);
            assert_eq!(rechecked.project["media"][0]["width"], 36, "turned twice");
            assert_eq!(rechecked.project["media"][0]["height"], 64);
            assert_eq!(rechecked.project["media"][0]["oriented"], true);
        });
    }

    /// Everything that must NOT be transposed, each for its own reason, and
    /// what each one gets instead.
    #[test]
    fn only_a_stale_quarter_turned_still_changes_size() {
        with_isolated("still-others", |dir| {
            let plain = still_file(dir, "plain.jpg", (80, 30), 0);
            let upright = still_file(dir, "upright.jpg", (70, 20), 1);
            let half = still_file(dir, "half.jpg", (66, 24), 3);
            let right = still_file(dir, "right.jpg", (90, 50), 6);
            let square = still_file(dir, "square.jpg", (48, 48), 8);
            let other = still_file(dir, "other.jpg", (60, 44), 8);
            // The one row the frame probe confirms, so the one real JPEG.
            let bogus = real_still_file(
                dir,
                "bogus flag.jpg",
                (58, 26),
                &crate::media::exif::tests::tiff_orientation(5, false),
            );
            let changed = still_file(dir, "changed.jpg", (52, 28), 6);
            let mut changed_media = still_media("m8", &changed, (52, 28));
            changed_media["mtimeMs"] = Value::from(changed_media["mtimeMs"].as_u64().unwrap() - 5_000);
            let mut bogus_media = still_media("m7", &bogus, (58, 26));
            bogus_media["oriented"] = Value::from("yes");

            let proj = dir.join("Mixed.trt");
            write_current_project(
                &proj,
                serde_json::json!([
                    still_media("m1", &plain, (80, 30)),   // no EXIF
                    still_media("m2", &upright, (70, 20)), // orientation 1
                    still_media("m3", &half, (66, 24)),    // a half turn keeps both axes
                    still_media("m4", &right, (50, 90)),   // turned, but already stored right
                    still_media("m5", &square, (48, 48)),  // its transpose is itself
                    still_media("m6", &other, (1280, 720)), // not this file's coded pair
                    bogus_media,                           // a flag that is not `true`
                    changed_media                          // the relink path's business
                ]),
                (1920, 1080),
            );

            let (loaded, wrote) = load_and_see_write(&proj);
            let m = &loaded.project["media"];
            let dims = |i: usize| (m[i]["width"].as_u64().unwrap(), m[i]["height"].as_u64().unwrap());
            assert_eq!(dims(0), (80, 30));
            assert_eq!(dims(1), (70, 20));
            assert_eq!(dims(2), (66, 24));
            assert_eq!(dims(3), (50, 90));
            assert_eq!(dims(4), (48, 48));
            assert_eq!(dims(5), (1280, 720));
            assert_eq!(dims(6), (26, 58), "only `true` is the flag; anything else is checked");
            assert_eq!(dims(7), (52, 28));
            for i in 0..7 {
                assert_eq!(m[i]["oriented"], true, "media {i} was checked, so it is flagged");
            }
            assert!(m[7].get("oriented").is_none(), "an unverified file is not vouched for");
            assert_eq!(loaded.missing, vec!["m8"]);
            assert!(wrote, "the flags are worth writing down");
        });
    }

    /// A full clip of `media_id` on the timeline, cropped to `crop` when given.
    fn cropped_clip(id: &str, media_id: &str, crop: Option<[u32; 4]>) -> Value {
        let mut transform = serde_json::json!({
            "rotate": 0, "flipH": false, "flipV": false, "scale": 1.0, "x": 0.0, "y": 0.0, "opacity": 1.0
        });
        if let Some([x, y, w, h]) = crop {
            transform["crop"] = serde_json::json!({ "x": x, "y": y, "w": w, "h": h });
        }
        serde_json::json!({
            "id": id, "mediaId": media_id, "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 5.0,
            "speed": 1.0, "transform": transform,
            "audio": { "volume": 1.0, "muted": false, "fadeInSec": 0.0, "fadeOutSec": 0.0,
                       "gainOffsetDb": 0.0, "detached": false }
        })
    }

    /// A current-schema project value holding `media` and `tracks`, for the
    /// tests that drive the repair directly with an injected frame probe.
    fn stills_value(media: Value, tracks: Value) -> (Value, Vec<schema::MediaRef>) {
        let value = serde_json::json!({
            "schema": schema::CURRENT_SCHEMA, "app": "taroting", "id": "p1", "name": "Stills",
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-01T00:00:00Z",
            "media": media,
            "timeline": { "fps": {"num": 30, "den": 1}, "width": 1920, "height": 1080, "tracks": tracks },
            "export": {}
        });
        let typed = ProjectFile::deserialize(&value).unwrap();
        (value, typed.media)
    }

    /// The verifier's finding, end to end with the real frame probe: on every
    /// layout ffmpeg drops the whole EXIF block for, the header still says 6
    /// at the stored coded size — the exact shape of a stale still — but the
    /// photo DECODES landscape. Flagged, never transposed, and its crop left
    /// exactly as authored. Trusting the sniff alone turned every one of these
    /// sideways and wrote it down.
    #[test]
    fn a_still_ffmpeg_does_not_turn_is_flagged_not_transposed() {
        with_isolated("still-rejected-exif", |dir| {
            use crate::media::exif::tests::ffmpeg_rejected_exif;
            let mut media = Vec::new();
            let mut clips = Vec::new();
            for (i, (name, tiff)) in ffmpeg_rejected_exif().into_iter().enumerate() {
                let file = real_still_file(dir, &format!("{name}.jpg"), (64, 36), &tiff);
                let s = crate::media::exif::read_still(&file).sniff.unwrap();
                assert_eq!((s.orientation, s.coded), (6, (64, 36)), "{name}: must look stale to the sniff");
                let id = format!("m{i}");
                media.push(still_media(&id, &file, (64, 36)));
                clips.push(cropped_clip(&format!("c{i}"), &id, Some([40, 0, 24, 36])));
            }
            let proj = dir.join("Rejected.trt");
            write_current_project(&proj, Value::from(media.clone()), (1920, 1080));
            let mut doc = read_disk(&proj);
            doc["timeline"]["tracks"][0]["clips"] = Value::from(clips);
            write_json(&proj, &doc);

            let (loaded, wrote) = load_and_see_write(&proj);
            for i in 0..media.len() {
                let m = &loaded.project["media"][i];
                assert_eq!((m["width"].as_u64(), m["height"].as_u64()), (Some(64), Some(36)), "media {i} turned");
                assert_eq!(m["oriented"], true, "media {i}: ffmpeg answered, so it is settled");
                assert_eq!(
                    loaded.project["timeline"]["tracks"][0]["clips"][i]["transform"]["crop"],
                    serde_json::json!({ "x": 40, "y": 0, "w": 24, "h": 36 }),
                    "clip {i}: a crop on an untouched still must not move"
                );
            }
            assert!(wrote, "the flags are worth writing down");
        });
    }

    /// A frame probe that FAILS vouches for nothing: the stale-looking still
    /// keeps its size and stays unflagged, so the next load asks again —
    /// while the rows that never needed asking are flagged as before.
    #[test]
    fn a_failed_frame_probe_changes_nothing_and_flags_nothing() {
        with_isolated("still-probe-fails", |dir| {
            let stale = still_file(dir, "stale.jpg", (64, 36), 6);
            let upright = still_file(dir, "upright.jpg", (70, 20), 1);
            let (mut value, media) = stills_value(
                serde_json::json!([still_media("m1", &stale, (64, 36)), still_media("m2", &upright, (70, 20))]),
                serde_json::json!([{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                    "clips": [cropped_clip("c1", "m1", Some([40, 0, 24, 36]))] }]),
            );
            let before = value.clone();
            let changed = repair_still_orientation_with(&mut value, &media, |_| None);
            assert!(changed, "the upright still is still flagged");
            assert_eq!(value["media"][0], before["media"][0], "an unconfirmed still was touched");
            assert!(value["media"][0].get("oriented").is_none());
            assert_eq!(value["media"][1]["oriented"], true);
            assert_eq!(value["timeline"], before["timeline"], "an unconfirmed still's crop moved");

            // Alone, a failing candidate is no change at all — nothing to write.
            let (mut alone, media) = stills_value(
                serde_json::json!([still_media("m1", &stale, (64, 36))]),
                serde_json::json!([]),
            );
            let before = alone.clone();
            assert!(!repair_still_orientation_with(&mut alone, &media, |_| None));
            assert_eq!(alone, before);
        });
    }

    /// The frame probe runs for exactly one shape — a header saying 5..=8 at
    /// the stored, non-square coded pair — and never for a still settled by
    /// the header (1..=4, already transposed, some other size, square), a
    /// flagged one, one whose header is unreadable, or one that fails the
    /// identity check. That is the whole of the load path's process cost.
    #[test]
    fn the_frame_probe_runs_only_for_a_stale_candidate() {
        with_isolated("still-probe-count", |dir| {
            let stale = still_file(dir, "stale.jpg", (64, 36), 8);
            let half = still_file(dir, "half.jpg", (64, 36), 3);
            let right = still_file(dir, "right.jpg", (90, 50), 6);
            let other = still_file(dir, "other.jpg", (60, 44), 7);
            let square = still_file(dir, "square.jpg", (48, 48), 6);
            let flagged = still_file(dir, "flagged.jpg", (80, 30), 6);
            let unreadable = dir.join("unreadable.jpg");
            std::fs::write(&unreadable, b"not an image at all").unwrap();
            let moved = still_file(dir, "moved.jpg", (52, 28), 6);
            let mut flagged_media = still_media("m6", &flagged, (80, 30));
            flagged_media["oriented"] = Value::Bool(true);
            let mut moved_media = still_media("m8", &moved, (52, 28));
            moved_media["size"] = Value::from(1);
            let (mut value, media) = stills_value(
                serde_json::json!([
                    still_media("m1", &stale, (64, 36)),
                    still_media("m2", &half, (64, 36)),
                    still_media("m3", &right, (50, 90)),
                    still_media("m4", &other, (1280, 720)),
                    still_media("m5", &square, (48, 48)),
                    flagged_media,
                    still_media("m7", &unreadable, (64, 36)),
                    moved_media
                ]),
                serde_json::json!([]),
            );
            let mut asked = Vec::new();
            repair_still_orientation_with(&mut value, &media, |p| {
                asked.push(p.to_owned());
                Some(true)
            });
            assert_eq!(asked, vec![stale.to_string_lossy().into_owned()]);
            let m = &value["media"];
            assert_eq!((m[0]["width"].as_u64(), m[0]["height"].as_u64()), (Some(36), Some(64)));
            for i in 0..6 {
                assert_eq!(m[i]["oriented"], true, "media {i}");
            }
            assert!(m[6].get("oriented").is_none(), "an unreadable header is not vouched for");
            assert!(m[7].get("oriented").is_none(), "the relink path's business");
        });
    }

    /// A header-only PNG coded (w, h) carrying `tiff` in an eXIf before the
    /// image data (`late` false) or after it (`late` true). The repair never
    /// decodes one whose tag the WebView ignores, and the injected frame
    /// probe stands in for the rest.
    fn png_still(dir: &Path, name: &str, (w, h): (u32, u32), tiff: &[u8], late: bool) -> PathBuf {
        use crate::media::exif::tests::{png_with_exif, tiny_png};
        let file = dir.join(name);
        std::fs::write(&file, png_with_exif(&tiny_png(w, h), tiff, late)).unwrap();
        file
    }

    /// A still the WebView draws unturned, stored at its coded 64x36 with a
    /// header saying 6, is the EXACT shape of a stale JPEG, and the bundled
    /// ffmpeg's autorotate would turn it — but the WebView does not (measured
    /// for a WebP's EXIF and a PNG eXIf after the image data), so 64x36 is its
    /// right size and the export must decode it `-noautorotate`. The repair
    /// stamps `noAutorotate` (the late PNG is exactly what 0.8.1 stored, and
    /// exported turned): never asked of the frame probe, never transposed, its
    /// crop unmoved. So is an untagged PNG — the rule reads where a tag could
    /// sit, not whether one does. Beside them, each for one reason:
    /// - the SAME PNG with its eXIf before the image data, and a JPEG: the
    ///   WebView turns both, so both are followed — asked, and transposed;
    /// - a late PNG stored at the TRANSPOSE of its coded pair: a stamp alone
    ///   would set the export against the stored size, so it is turned BACK
    ///   to 64x36, its crop clamped into that box, and stamped;
    /// - an upright JPEG carrying a stale `noAutorotate`: checked, and the
    ///   flag it does not deserve is gone.
    ///
    /// Then end to end through `load_project`: stamped and written once,
    /// settled after, and a copy that lost `oriented` is stamped again,
    /// never turned.
    #[test]
    fn a_still_whose_tag_the_webview_ignores_is_stamped_never_turned() {
        with_isolated("still-ignored-tag", |dir| {
            use crate::media::exif::tests::{sniff_bytes, tiff_orientation, tiny_png, webp_with_exif};
            let t6 = tiff_orientation(6, false);
            let base = dir.join("64x36 base.webp");
            let out = crate::jobs::ffmpeg::run(
                "ffmpeg",
                &["-y", "-f", "lavfi", "-i", "testsrc2=size=64x36", "-frames:v", "1", base.to_str().unwrap()],
            )
            .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let webp_file = dir.join("portrait.webp");
            std::fs::write(&webp_file, webp_with_exif(&std::fs::read(&base).unwrap(), 64, 36, &t6)).unwrap();
            let late_file = png_still(dir, "late.png", (64, 36), &t6, true);
            let early_file = png_still(dir, "early.png", (64, 36), &t6, false);
            let turned_file = png_still(dir, "late stored turned.png", (64, 36), &t6, true);
            let jpeg_file = still_file(dir, "stale.jpg", (64, 36), 6);
            let upright_file = still_file(dir, "upright.jpg", (70, 20), 1);
            let plain_file = dir.join("plain.png");
            std::fs::write(&plain_file, tiny_png(64, 36)).unwrap();
            for f in [&webp_file, &late_file, &early_file] {
                let s = sniff_bytes(&std::fs::read(f).unwrap()).unwrap();
                assert_eq!((s.orientation, s.coded), (6, (64, 36)), "{f:?} must look stale to the sniff");
            }
            let as_png = |mut m: Value| {
                m["container"] = Value::from("png_pipe");
                m["vcodec"] = Value::from("png");
                m
            };
            let mut webp = still_media("m1", &webp_file, (64, 36));
            webp["container"] = Value::from("webp_pipe");
            webp["vcodec"] = Value::from("webp");
            let late = as_png(still_media("m2", &late_file, (64, 36)));
            let early = as_png(still_media("m3", &early_file, (64, 36)));
            let turned = as_png(still_media("m5", &turned_file, (36, 64)));
            let mut stale_flag = still_media("m6", &upright_file, (70, 20));
            stale_flag["noAutorotate"] = Value::Bool(true);
            let plain = as_png(still_media("m7", &plain_file, (64, 36)));

            let (mut value, media) = stills_value(
                serde_json::json!([
                    webp.clone(),
                    late.clone(),
                    early,
                    still_media("m4", &jpeg_file, (64, 36)),
                    turned,
                    stale_flag,
                    plain
                ]),
                serde_json::json!([{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                    "clips": [
                        cropped_clip("c1", "m1", Some([40, 0, 24, 36])),
                        cropped_clip("c2", "m2", Some([40, 0, 24, 36])),
                        // Authored against the turned 36x64 box: y hangs off
                        // the coded 64x36 one.
                        cropped_clip("c5", "m5", Some([0, 40, 36, 24]))
                    ] }]),
            );
            let before = value.clone();
            let mut asked = Vec::new();
            assert!(repair_still_orientation_with(&mut value, &media, |p| {
                asked.push(p.to_owned());
                Some(true)
            }));
            let path = |f: &Path| f.to_string_lossy().into_owned();
            assert_eq!(asked, vec![path(&early_file), path(&jpeg_file)], "only the followed stills are asked");
            let m = &value["media"];
            let dims = |i: usize| (m[i]["width"].as_u64().unwrap(), m[i]["height"].as_u64().unwrap());
            for i in [0, 1, 4, 6] {
                assert_eq!(dims(i), (64, 36), "media {i} is not at its coded size");
                assert_eq!(m[i]["oriented"], true, "media {i}");
                assert_eq!(m[i]["noAutorotate"], true, "media {i} was not stamped");
            }
            let clip = |c: usize| &value["timeline"]["tracks"][0]["clips"][c]["transform"]["crop"];
            for c in [0, 1] {
                assert_eq!(clip(c), &before["timeline"]["tracks"][0]["clips"][c]["transform"]["crop"], "clip {c} moved");
            }
            // h 24 fits 36, so y pulls back to 36 - 24.
            assert_eq!(clip(2), &serde_json::json!({ "x": 0, "y": 12, "w": 36, "h": 24 }), "the turned-back crop");
            for i in [2, 3] {
                assert_eq!(dims(i), (36, 64), "media {i}: the followed control");
                assert!(m[i].get("noAutorotate").is_none(), "media {i}");
            }
            assert_eq!(m[5]["oriented"], true);
            assert!(m[5].get("noAutorotate").is_none(), "a stale flag survived its check");
            assert_eq!(dims(5), (70, 20));

            let proj = dir.join("Ignored.trt");
            write_current_project(&proj, serde_json::json!([webp, late]), (1920, 1080));
            let (loaded, wrote) = load_and_see_write(&proj);
            assert!(loaded.missing.is_empty(), "{:?}", loaded.missing);
            for i in [0, 1] {
                let e = &loaded.project["media"][i];
                assert_eq!((e["width"].as_u64(), e["height"].as_u64()), (Some(64), Some(36)), "media {i}");
                assert_eq!((&e["oriented"], &e["noAutorotate"]), (&Value::Bool(true), &Value::Bool(true)), "media {i}");
            }
            assert!(wrote, "the stamps are worth writing down");
            let (_, wrote) = load_and_see_write(&proj);
            assert!(!wrote, "a stamped still is settled");

            let mut lost = read_disk(&proj);
            for i in [0, 1] {
                lost["media"][i].as_object_mut().unwrap().remove("oriented");
            }
            write_json(&proj, &lost);
            let (again, _) = load_and_see_write(&proj);
            for i in [0, 1] {
                let e = &again.project["media"][i];
                assert_eq!((e["width"].as_u64(), e["height"].as_u64()), (Some(64), Some(36)), "media {i} turned");
                assert_eq!((&e["oriented"], &e["noAutorotate"]), (&Value::Bool(true), &Value::Bool(true)), "media {i}");
            }
        });
    }

    /// The one-time recheck of a PNG or WebP stamped `oriented` WITHOUT
    /// `noAutorotate` — what earlier builds of the rule wrote: one followed
    /// ffmpeg's turn on every tagged PNG and WebP and stored them TURNED (so
    /// the export, told nothing, turned them too, while the preview drew them
    /// coded in a turned box); the next flagged only a late tag its tail
    /// search found. Coded 64x36 throughout, so a turned 36x64 can never pass
    /// for a right one:
    /// - a late PNG and a WebP stored turned: turned BACK, stamped, and the
    ///   late PNG's crop clamped into the coded box;
    /// - an untagged PNG and the verifier's late-eXIf-behind-70-KB PNG, stored
    ///   coded: stamped, sizes untouched — one recognised by its `vcodec`
    ///   alone, one by its `container` alone;
    /// - a PNG with its eXIf BEFORE the image data, stored turned: the rule
    ///   still follows it, so it is left exactly as stamped;
    /// - a late PNG that fails identity, a JPEG, and a PNG already carrying
    ///   the flag: never rechecked at all.
    /// The frame probe is never asked. A second pass — the next load — finds
    /// nothing to do, and so does a second load end to end.
    #[test]
    fn a_stamped_png_or_webp_is_rechecked_once_under_the_current_rule() {
        with_isolated("still-recheck", |dir| {
            use crate::media::exif::tests::{
                png_exif_past_the_tail, riff, tiff_orientation, tiny_png, vp8l, webp_with_exif,
            };
            let t6 = tiff_orientation(6, false);
            let late_file = png_still(dir, "late.png", (64, 36), &t6, true);
            let early_file = png_still(dir, "early.png", (64, 36), &t6, false);
            let webp_file = dir.join("portrait.webp");
            std::fs::write(&webp_file, webp_with_exif(&riff(&[vp8l(64, 36)]), 64, 36, &t6)).unwrap();
            let plain_file = dir.join("plain.png");
            std::fs::write(&plain_file, tiny_png(64, 36)).unwrap();
            let past_file = dir.join("late behind 70 KB.png");
            let (_, past_bytes) = png_exif_past_the_tail(&tiny_png(64, 36)).remove(0);
            std::fs::write(&past_file, past_bytes).unwrap();
            let moved_file = png_still(dir, "moved.png", (64, 36), &t6, true);
            let jpeg_file = still_file(dir, "turned.jpg", (64, 36), 6);
            let flagged_file = png_still(dir, "flagged.png", (64, 36), &t6, true);

            let stamped = |id: &str, file: &Path, wh: (u32, u32), container: Option<&str>, vcodec: Option<&str>| {
                let mut m = still_media(id, file, wh);
                m["oriented"] = Value::Bool(true);
                m.as_object_mut().unwrap().remove("container");
                if let Some(c) = container {
                    m["container"] = Value::from(c);
                }
                if let Some(v) = vcodec {
                    m["vcodec"] = Value::from(v);
                }
                m
            };
            let png = (Some("png_pipe"), Some("png"));
            let mut moved = stamped("m6", &moved_file, (36, 64), png.0, png.1);
            moved["size"] = Value::from(1);
            let mut flagged = stamped("m8", &flagged_file, (64, 36), png.0, png.1);
            flagged["noAutorotate"] = Value::Bool(true);
            let (mut value, media) = stills_value(
                serde_json::json!([
                    stamped("m1", &late_file, (36, 64), png.0, png.1),
                    stamped("m2", &early_file, (36, 64), png.0, png.1),
                    stamped("m3", &webp_file, (36, 64), Some("webp_pipe"), Some("webp")),
                    stamped("m4", &plain_file, (64, 36), Some("image2"), Some("png")),
                    stamped("m5", &past_file, (64, 36), Some("png_pipe"), None),
                    moved,
                    stamped("m7", &jpeg_file, (36, 64), Some("jpeg_pipe"), Some("mjpeg")),
                    flagged
                ]),
                serde_json::json!([{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                    "clips": [
                        cropped_clip("c1", "m1", Some([0, 40, 36, 24])),
                        cropped_clip("c2", "m2", Some([0, 40, 36, 24]))
                    ] }]),
            );
            let before = value.clone();
            let never = |p: &str| -> Option<bool> { panic!("the recheck asked the frame probe about {p}") };
            assert!(repair_still_orientation_with(&mut value, &media, never));

            let m = &value["media"];
            let dims = |i: usize| (m[i]["width"].as_u64().unwrap(), m[i]["height"].as_u64().unwrap());
            for i in [0, 2, 3, 4] {
                assert_eq!(dims(i), (64, 36), "media {i} is not at its coded size");
                assert_eq!(m[i]["noAutorotate"], true, "media {i} was not stamped");
                assert_eq!(m[i]["oriented"], true, "media {i}");
            }
            let crop = |c: usize| &value["timeline"]["tracks"][0]["clips"][c]["transform"]["crop"];
            assert_eq!(crop(0), &serde_json::json!({ "x": 0, "y": 12, "w": 36, "h": 24 }), "not clamped");
            assert_eq!(crop(1), &before["timeline"]["tracks"][0]["clips"][1]["transform"]["crop"]);
            for i in [1, 5, 6, 7] {
                assert_eq!(m[i], before["media"][i], "media {i} was touched");
            }

            // The next load: settled, so nothing changes and nothing is written.
            let settled = value.clone();
            let media = ProjectFile::deserialize(&value).unwrap().media;
            assert!(!repair_still_orientation_with(&mut value, &media, never), "a second pass changed something");
            assert_eq!(value, settled);

            // End to end: the first load repairs and writes, the second does not.
            let proj = dir.join("Recheck.trt");
            write_current_project(
                &proj,
                serde_json::json!([
                    stamped("m1", &late_file, (36, 64), png.0, png.1),
                    stamped("m2", &early_file, (36, 64), png.0, png.1)
                ]),
                (1920, 1080),
            );
            let (loaded, wrote) = load_and_see_write(&proj);
            assert!(wrote, "the repair must be persisted");
            let e = &loaded.project["media"];
            assert_eq!((e[0]["width"].as_u64(), e[0]["height"].as_u64()), (Some(64), Some(36)));
            assert_eq!(e[0]["noAutorotate"], true);
            assert_eq!((e[1]["width"].as_u64(), e[1]["height"].as_u64()), (Some(36), Some(64)));
            assert!(e[1].get("noAutorotate").is_none());
            let (again, wrote) = load_and_see_write(&proj);
            assert!(!wrote, "a rechecked project was rewritten");
            assert_eq!(again.project["media"], loaded.project["media"]);
        });
    }

    /// Transposing a still's size must bring its clips' crops into the NEW
    /// box — `clampCrop`'s exact rule, on every track — or the preview (which
    /// clamps x/y) and the export (which does not) show different regions.
    #[test]
    fn a_transposed_still_s_crops_are_clamped_into_the_new_box() {
        with_isolated("still-crop-clamp", |dir| {
            let stale = still_file(dir, "stale.jpg", (64, 36), 6);
            let plain = still_file(dir, "plain.jpg", (64, 36), 0);
            let video_track = |clips: Value| {
                serde_json::json!({ "id": "t1", "kind": "video", "name": "V1", "muted": false, "clips": clips })
            };
            let mut second = video_track(serde_json::json!([
                cropped_clip("c2", "m1", Some([60, 0, 4, 36])), // off the new box entirely
                cropped_clip("c3", "m2", Some([40, 0, 24, 36])), // another media's clip
            ]));
            second["id"] = Value::from("t2");
            let mut odd = cropped_clip("c5", "m1", None);
            odd["transform"]["crop"] = serde_json::json!({ "x": -1, "y": 0, "w": 24, "h": 36 });
            let (mut value, media) = stills_value(
                serde_json::json!([still_media("m1", &stale, (64, 36)), still_media("m2", &plain, (64, 36))]),
                serde_json::json!([
                    video_track(serde_json::json!([
                        cropped_clip("c1", "m1", Some([40, 0, 24, 36])), // fits only the old box
                        cropped_clip("c4", "m1", Some([4, 8, 20, 20])),  // fits both
                        cropped_clip("c6", "m1", None),                  // no crop at all
                        odd                                              // sanitizeCrop drops it
                    ])),
                    second
                ]),
            );
            let before = value.clone();
            assert!(repair_still_orientation_with(&mut value, &media, |_| Some(true)));
            assert_eq!((value["media"][0]["width"].as_u64(), value["media"][0]["height"].as_u64()), (Some(36), Some(64)));
            let clip = |t: usize, c: usize| &value["timeline"]["tracks"][t]["clips"][c];
            let crop = |x: u32, y: u32, w: u32, h: u32| serde_json::json!({ "x": x, "y": y, "w": w, "h": h });
            // w stays 24 (<= 36), x pulls back to 36 - 24.
            assert_eq!(clip(0, 0)["transform"]["crop"], crop(12, 0, 24, 36));
            // w grows to CROP_MIN, then x pulls back to 36 - 8.
            assert_eq!(clip(1, 0)["transform"]["crop"], crop(28, 0, 8, 36));
            assert_eq!(clip(0, 1), &before["timeline"]["tracks"][0]["clips"][1], "a fitting crop was rewritten");
            assert_eq!(clip(0, 2), &before["timeline"]["tracks"][0]["clips"][2]);
            assert_eq!(clip(0, 3), &before["timeline"]["tracks"][0]["clips"][3], "a crop TS drops was clamped");
            assert_eq!(clip(1, 1), &before["timeline"]["tracks"][1]["clips"][1], "another media's clip moved");
        });
    }

    /// A generator's `path` is a label; one that happens to name a real,
    /// identity-matching, turned photo must still never be read or flagged —
    /// and a project with nothing to repair is never written.
    #[test]
    fn a_generator_is_never_touched() {
        with_isolated("still-generator", |dir| {
            let file = still_file(dir, "looks like a photo.jpg", (64, 36), 6);
            let mut gen = still_media("m1", &file, (64, 36));
            gen["generator"] = serde_json::json!({ "type": "solid", "color": "#00ff00" });
            let proj = dir.join("Gen.trt");
            write_current_project(&proj, serde_json::json!([gen]), (1920, 1080));

            let (loaded, wrote) = load_and_see_write(&proj);
            assert_eq!(loaded.project["media"][0]["width"], 64);
            assert_eq!(loaded.project["media"][0]["height"], 36);
            assert!(loaded.project["media"][0].get("oriented").is_none());
            assert!(!wrote);
        });
    }

    /// `RecentItem.kind` is "image" or absent, and nothing else a recents index
    /// holds there may cost the index its parse (the whole home screen reads
    /// from it). A video entry writes no `kind` key, so an index this build
    /// writes for video projects is byte-for-byte what it was.
    #[test]
    fn recents_kind_is_image_or_absent_and_never_fails_the_index() {
        let entry = |kind: Option<Value>| {
            let mut v = serde_json::json!({
                "path": "C:\\p\\Pic.trt", "name": "Pic",
                "modifiedAt": "2026-09-01T00:00:00Z", "durationSec": 0.0, "thumb": null
            });
            if let Some(k) = kind {
                v["kind"] = k;
            }
            v
        };
        let index: RecentsIndex = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "items": [
                entry(Some("image".into())),
                entry(None),
                entry(Some("video".into())),
                entry(Some(7.into())),
                entry(Some(Value::Null)),
            ]
        }))
        .expect("an odd kind must not fail the index");
        let kinds: Vec<Option<&str>> = index.items.iter().map(|i| i.kind.as_deref()).collect();
        assert_eq!(kinds, [Some("image"), None, None, None, None]);

        let out = serde_json::to_value(&index.items[0]).unwrap();
        assert_eq!(out["kind"], "image");
        let video = serde_json::to_value(&index.items[1]).unwrap();
        assert!(video.get("kind").is_none(), "{video}");
    }

    /* ---------------------------- image projects ---------------------------- */

    /// A photo file with a real PNG signature and a true identity entry for it.
    /// Nothing here decodes it; what matters is that it RESOLVES, so a `None`
    /// from the thumbnail resolver is the kind skip and not a missing file.
    fn photo_media(dir: &Path, id: &str) -> Value {
        let file = dir.join(format!("{id}.png"));
        std::fs::write(&file, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]).unwrap();
        let meta = std::fs::metadata(&file).unwrap();
        serde_json::json!({
            "id": id, "path": file.to_string_lossy(), "size": meta.len(), "mtimeMs": mtime_ms_of(&meta),
            "kind": "image", "duration": 0.0, "hasAudio": false, "width": 801, "height": 603
        })
    }

    fn drawing_media(id: &str, colour: &str) -> Value {
        serde_json::json!({
            "id": id, "path": "Drawing", "size": 0, "mtimeMs": 0, "kind": "image",
            "duration": 0.0, "hasAudio": false, "width": 640, "height": 480,
            "generator": { "type": "drawing", "chunks": [[
                { "t": "pen", "c": colour, "w": 4.5, "o": 1.0, "p": "AB+/AB+/AB+/AB+/" }
            ]]}
        })
    }

    fn layer(id: &str, name: &str, media_id: &str) -> Value {
        serde_json::json!({ "id": id, "kind": "video", "name": name, "muted": false, "clips": [{
            "id": format!("c-{id}"), "mediaId": media_id,
            "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 1.0, "speed": 1.0,
            "audio": { "volume": 1.0, "muted": false, "fadeInSec": 0.0, "fadeOutSec": 0.0,
                       "gainOffsetDb": 0.0, "detached": false }
        }]})
    }

    /// An image project: schema 3, kind image, the photo layer on top, a
    /// drawing below it. Its layers are one-unit clips, so a duration taken
    /// from the timeline would read 1.0 — never the 0 a picture's card shows.
    fn image_project(id: &str, media: Value, tracks: Value) -> Value {
        serde_json::json!({
            "schema": 3, "kind": "image", "app": "taroting", "id": id, "name": "Card",
            "createdAt": "2026-09-01T00:00:00Z", "modifiedAt": "2026-09-02T00:00:00Z",
            "image": { "background": "#fafafa" }, "media": media,
            "timeline": { "fps": { "num": 30, "den": 1 }, "width": 1001, "height": 707, "tracks": tracks },
            "export": {}
        })
    }

    /// The exact entry recents holds for `path`, if any.
    fn recent(path: &str) -> Option<RecentItem> {
        read_recents().items.into_iter().find(|r| r.path == path)
    }

    /// A drawing is refused in a video project on load — as an error, never a
    /// panic — and the same content as an image project opens, lands in
    /// recents as an image card with no duration.
    #[test]
    fn load_refuses_a_drawing_only_outside_an_image_project() {
        with_isolated("img-load", |dir| {
            let media = serde_json::json!([photo_media(dir, "ph"), drawing_media("d1", "#1a2b3c")]);
            let tracks = serde_json::json!([layer("t1", "Photo", "ph"), layer("t2", "Drawing 1", "d1")]);

            let mut video = image_project("p-1", media.clone(), tracks.clone());
            video["schema"] = 2.into();
            video.as_object_mut().unwrap().remove("kind");
            let bad = dir.join("Crafted.trt");
            write_json(&bad, &video);
            match load_project(bad.to_string_lossy().into_owned()) {
                Err(AppError::BadInput(m)) => assert!(m.contains("drawing"), "{m}"),
                other => panic!("expected a refusal, got {other:?}"),
            }
            assert!(recent(&bad.to_string_lossy()).is_none(), "a refused file gets no card");

            let good = dir.join("Card.trt");
            write_json(&good, &image_project("p-1", media, tracks));
            let loaded = load_project(good.to_string_lossy().into_owned()).expect("an image project opens");
            assert_eq!(loaded.project["kind"], "image");
            let card = recent(&good.to_string_lossy()).expect("stamped");
            assert_eq!(card.kind.as_deref(), Some("image"));
            assert_eq!(card.duration_sec, 0.0);
        });
    }

    #[test]
    fn save_refuses_what_it_could_not_read_back_and_writes_nothing() {
        with_isolated("img-save-refuse", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let tracks = serde_json::json!([layer("t2", "Drawing 1", "d1")]);
            let refused = |name: &str, project: Value, want: &str| {
                let path = dir.join(name);
                match save_project_at(Some(&cache), path.to_string_lossy().into_owned(), project) {
                    Err(AppError::BadInput(m)) => {
                        assert!(m.starts_with("refusing to save invalid project"), "{m}");
                        assert!(m.contains(want), "{name}: '{m}' lacks '{want}'");
                    }
                    other => panic!("{name}: expected a refusal, got {other:?}"),
                }
                assert!(!path.exists() && !bak_path(&path).exists(), "{name} was written");
            };

            let valid = image_project("p-2", serde_json::json!([drawing_media("d1", "#1a2b3c")]), tracks.clone());
            let mut video = valid.clone();
            video["schema"] = 2.into();
            video.as_object_mut().unwrap().remove("kind");
            refused("Video.trt", video, "drawing layers");

            let mut stale = valid.clone();
            stale["schema"] = 2.into();
            refused("Schema2.trt", stale, "must be schema 3");

            let bad_colour =
                image_project("p-2", serde_json::json!([drawing_media("d1", "#12345g")]), tracks.clone());
            refused("Colour.trt", bad_colour, "stroke 1 of layer 'Drawing 1': color is not #rrggbb");

            let mut video3 = image_project("p-2", serde_json::json!([]), serde_json::json!([]));
            video3.as_object_mut().unwrap().remove("kind");
            refused("Video3.trt", video3, "only valid for an image project");

            save_project_at(Some(&cache), dir.join("Fine.trt").to_string_lossy().into_owned(), valid)
                .expect("the valid fixture saves");
        });
    }

    /// A saved image project's card: kind image, no duration, and the rendered
    /// picture the image editor pointed it at survives every later save — a
    /// save knows no thumbnail, and the first photo must never replace it. A
    /// video project saved alongside keeps today's card exactly.
    #[test]
    fn saving_an_image_project_keeps_its_rendered_card() {
        with_isolated("img-save", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let photo = photo_media(dir, "ph");
            // A cached frame of the photo exists, so a video-style lookup WOULD
            // find one: the image branch must not.
            let key = crate::cache::MediaKey {
                path: photo["path"].as_str().unwrap().into(),
                size: photo["size"].as_u64().unwrap(),
                mtime_ms: photo["mtimeMs"].as_u64().unwrap(),
            };
            let thumbs = cache.ensure_kind_dir(crate::cache::CacheKind::Thumbs).unwrap();
            std::fs::write(thumbs.join(format!("{}_0.5.jpg", key.hash())), b"frame").unwrap();

            let project = image_project(
                "p-3",
                serde_json::json!([photo.clone(), drawing_media("d1", "#1a2b3c")]),
                serde_json::json!([layer("t1", "Photo", "ph"), layer("t2", "Drawing 1", "d1")]),
            );
            let path = dir.join("Card.trt").to_string_lossy().into_owned();
            save_project_at(Some(&cache), path.clone(), project.clone()).unwrap();
            let card = recent(&path).unwrap();
            assert_eq!(
                (card.kind.as_deref(), card.duration_sec, card.thumb.as_deref()),
                (Some("image"), 0.0, None)
            );

            let rendered = thumbs.join("imgproj-p-3.jpg").to_string_lossy().into_owned();
            set_recent_thumb(&path, &rendered);
            save_project_at(Some(&cache), path.clone(), project).unwrap();
            assert_eq!(recent(&path).unwrap().thumb.as_deref(), Some(rendered.as_str()));

            // The same media as a video project: the frame lookup and the
            // timeline duration are exactly what they always were.
            let mut video = image_project(
                "p-4",
                serde_json::json!([photo]),
                serde_json::json!([layer("t1", "Photo", "ph")]),
            );
            video["schema"] = 2.into();
            video.as_object_mut().unwrap().remove("kind");
            video["timeline"]["tracks"][0]["clips"][0]["srcOut"] = 2.5.into();
            let vpath = dir.join("Cut.trt").to_string_lossy().into_owned();
            save_project_at(Some(&cache), vpath.clone(), video).unwrap();
            let vcard = recent(&vpath).unwrap();
            assert_eq!((vcard.kind.as_deref(), vcard.duration_sec), (None, 2.5));
            assert!(vcard.thumb.as_deref().is_some_and(|t| t.contains(&key.hash())), "{:?}", vcard.thumb);
        });
    }

    /// A save that would write a file larger than the load cap is refused
    /// BEFORE the file is touched: the previous save stays byte-identical, no
    /// `.bak` is rotated, and a new path gets neither a file nor a card. The
    /// cap is shrunk to the fixture's own size so the boundary is exact — at
    /// the cap it saves, one byte over it refuses.
    #[test]
    fn save_refuses_a_project_the_load_cap_would_refuse() {
        with_isolated("save-cap", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let project = minimal_project("Big");
            let size = project_bytes(&project).unwrap().len() as u64;

            let kept = dir.join("Kept.trt");
            let kept_s = kept.to_string_lossy().into_owned();
            save_project_within(Some(&cache), kept_s.clone(), project.clone(), size)
                .expect("a project exactly at the cap saves");
            let before = std::fs::read(&kept).unwrap();
            assert!(!bak_path(&kept).exists(), "fixture: one save rotates nothing");

            // One byte longer than the cap.
            let mut grown = project.clone();
            grown["name"] = Value::from("Bigg");
            assert_eq!(project_bytes(&grown).unwrap().len() as u64, size + 1, "fixture");
            let refused = |path: String, value: Value| {
                match save_project_within(Some(&cache), path, value, size) {
                    Err(AppError::BadInput(m)) => {
                        assert!(m.starts_with("refusing to save: the project would be larger than"), "{m}")
                    }
                    other => panic!("expected a refusal, got {other:?}"),
                }
            };
            refused(kept_s.clone(), grown.clone());
            assert_eq!(std::fs::read(&kept).unwrap(), before, "the previous save was replaced");
            assert!(!bak_path(&kept).exists(), "a refused save rotated the previous one aside");
            assert_eq!(recent(&kept_s).unwrap().name, "Big");

            let fresh = dir.join("Fresh.trt");
            refused(fresh.to_string_lossy().into_owned(), grown);
            assert!(!fresh.exists(), "a refused save was written");
            assert!(recent(&fresh.to_string_lossy()).is_none(), "a refused save got a card");
        });
    }

    /// The limit is named the way the load refusal names it, and the real
    /// cap is the load cap.
    #[test]
    fn the_save_cap_is_named_like_the_load_cap() {
        let big = serde_json::json!({ "pad": "x".repeat(64) });
        match project_bytes_within(&big, 10) {
            Err(AppError::BadInput(m)) => assert!(m.contains("larger than 10 bytes"), "{m}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        let mb = 1024 * 1024;
        let huge = serde_json::json!({ "pad": "x".repeat(mb as usize) });
        match project_bytes_within(&huge, mb) {
            Err(AppError::BadInput(m)) => assert!(m.contains("larger than 1 MB"), "{m}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(project_bytes(&big).is_ok(), "a small project is far under 512 MB");
        assert_eq!(image_rules::MAX_TRT_BYTES, 512 * 1024 * 1024);
    }

    /// With no cache (main.rs runs without one when %LOCALAPPDATA% is
    /// unusable) a save still writes and still gets its card, only without a
    /// thumbnail. The same project against a cache holding a frame of its clip
    /// gets one, so the missing thumb is the cache's absence and nothing else.
    #[test]
    fn a_save_without_the_cache_still_writes() {
        with_isolated("save-nocache", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let photo = photo_media(dir, "ph");
            let key = crate::cache::MediaKey {
                path: photo["path"].as_str().unwrap().into(),
                size: photo["size"].as_u64().unwrap(),
                mtime_ms: photo["mtimeMs"].as_u64().unwrap(),
            };
            let thumbs = cache.ensure_kind_dir(crate::cache::CacheKind::Thumbs).unwrap();
            std::fs::write(thumbs.join(format!("{}_0.5.jpg", key.hash())), b"frame").unwrap();
            let mut video = image_project(
                "p-6",
                serde_json::json!([photo]),
                serde_json::json!([layer("t1", "Photo", "ph")]),
            );
            video["schema"] = 2.into();
            video.as_object_mut().unwrap().remove("kind");

            let bare = dir.join("Bare.trt").to_string_lossy().into_owned();
            save_project_at(None, bare.clone(), video.clone()).expect("saves without a cache");
            assert!(Path::new(&bare).is_file());
            assert_eq!(recent(&bare).unwrap().thumb, None);

            let cached = dir.join("Cached.trt").to_string_lossy().into_owned();
            save_project_at(Some(&cache), cached.clone(), video).unwrap();
            assert!(recent(&cached).unwrap().thumb.is_some(), "control: the cache has a frame");
        });
    }

    #[test]
    fn the_thumbnail_backfill_never_replaces_an_image_card() {
        with_isolated("img-thumb", |dir| {
            let photo = photo_media(dir, "ph");
            let tracks = serde_json::json!([layer("t1", "Photo", "ph")]);
            let image = dir.join("Card.trt");
            write_json(&image, &image_project("p-5", serde_json::json!([photo.clone()]), tracks.clone()));
            assert!(thumb_source_for(&image.to_string_lossy()).is_none());

            // The identical project as a video one resolves: the file is there.
            let mut video = image_project("p-5", serde_json::json!([photo]), tracks);
            video["schema"] = 2.into();
            video.as_object_mut().unwrap().remove("kind");
            let vpath = dir.join("Cut.trt");
            write_json(&vpath, &video);
            let (key, _) = thumb_source_for(&vpath.to_string_lossy()).expect("the photo resolves");
            assert!(key.path.ends_with("ph.png"));
        });
    }

    /// A duplicate is an image project too, and its card is its OWN copy of
    /// the rendered picture (named for the new id), so later edits to the
    /// original never show on the copy's card.
    #[test]
    fn duplicating_an_image_project_carries_its_kind_and_copies_its_card() {
        with_isolated("img-dup", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let project = image_project(
                "p-6",
                serde_json::json!([drawing_media("d1", "#1a2b3c")]),
                serde_json::json!([layer("t2", "Drawing 1", "d1")]),
            );
            let src = dir.join("Card.trt").to_string_lossy().into_owned();
            save_project_at(Some(&cache), src.clone(), project).unwrap();
            let thumbs = cache.ensure_kind_dir(crate::cache::CacheKind::Thumbs).unwrap();
            let card = thumbs.join("imgproj-p-6.jpg");
            std::fs::write(&card, b"rendered card of p-6").unwrap();
            set_recent_thumb(&src, &card.to_string_lossy());

            let copy = duplicate_project(src.clone(), "Card copy".into(), "q-7".into()).unwrap();
            let entry = recent(&copy).unwrap();
            assert_eq!(entry.kind.as_deref(), Some("image"));
            // Named for the copy's own id AND path, exactly as its first card
            // save will name it.
            let own = thumbs.join(crate::image_save::card_file_name("q-7", &copy).unwrap());
            assert!(own.file_name().unwrap().to_string_lossy().starts_with("imgproj-q-7-"), "{own:?}");
            assert_eq!(entry.thumb.as_deref(), Some(own.to_string_lossy().as_ref()));
            assert_eq!(std::fs::read(&own).unwrap(), b"rendered card of p-6");
            assert_eq!(std::fs::read(&card).unwrap(), b"rendered card of p-6", "the original's card is untouched");

            // An id the card name could not be built from: no picture, never a
            // shared one or a path outside the thumbnail dir.
            let odd = duplicate_project(src, "Card odd".into(), "..\\x".into()).unwrap();
            assert_eq!(recent(&odd).unwrap().thumb, None);
        });
    }

    /// Only an existing, permanent recents entry takes a rendered card: a
    /// temporary project has none, and a thumbnail landing never creates one.
    #[test]
    fn set_recent_thumb_touches_only_an_existing_permanent_entry() {
        with_isolated("img-card", |dir| {
            let temp_dir = paths::temp_projects_dir().unwrap();
            let temp = temp_dir.join("Quick.trt").to_string_lossy().into_owned();
            let perm = dir.join("Kept.trt").to_string_lossy().into_owned();
            let entry = |path: &str| RecentItem {
                path: path.into(),
                name: "n".into(),
                modified_at: "m".into(),
                duration_sec: 0.0,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
                kind: Some("image".into()),
            };
            write_recents(&RecentsIndex { schema: 1, items: vec![entry(&temp), entry(&perm)] }).unwrap();

            set_recent_thumb(&perm, r"C:\cache\thumbs\imgproj-a.jpg");
            set_recent_thumb(&temp, r"C:\cache\thumbs\imgproj-b.jpg");
            set_recent_thumb(&dir.join("Unknown.trt").to_string_lossy(), r"C:\cache\thumbs\imgproj-c.jpg");

            let items = read_recents().items;
            assert_eq!(items.len(), 2, "no entry is created");
            assert_eq!(recent(&perm).unwrap().thumb.as_deref(), Some(r"C:\cache\thumbs\imgproj-a.jpg"));
            assert_eq!(recent(&temp).unwrap().thumb, None, "a temporary project has no card");
        });
    }

    /// The card commit as the command runs it: each card lands in the cache,
    /// and only the PERMANENT project's recents entry is pointed at its own
    /// card — the temporary one stays without, and an unrelated entry is
    /// never touched.
    #[test]
    fn a_card_commit_stamps_only_the_permanent_recents_entry() {
        use crate::image_save::{begin_thumb, chunk_body, commit_and_stamp, ImageFormat, ImageSaves};
        with_isolated("img-commit", |dir| {
            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let temp = paths::temp_projects_dir().unwrap().join("Quick.trt").to_string_lossy().into_owned();
            let perm = dir.join("Kept.trt").to_string_lossy().into_owned();
            let other = dir.join("Other.trt").to_string_lossy().into_owned();
            let entry = |path: &str| RecentItem {
                path: path.into(),
                name: "n".into(),
                modified_at: "m".into(),
                duration_sec: 0.0,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
                kind: Some("image".into()),
            };
            write_recents(&RecentsIndex { schema: 1, items: vec![entry(&temp), entry(&perm), entry(&other)] })
                .unwrap();

            let saves = ImageSaves::default();
            let jpeg: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 7];
            let mut landed = Vec::new();
            for (path, id) in [(&perm, "p-perm"), (&temp, "p-temp")] {
                let b = begin_thumb(&saves, &cache, path, id, ImageFormat::Jpeg, jpeg.len() as u64).unwrap();
                chunk_body(&saves, b.token, Ok(jpeg.to_vec())).unwrap();
                let saved = commit_and_stamp(&saves, Some(&cache), b.token).unwrap();
                assert_eq!(std::fs::read(&saved.path).unwrap(), jpeg);
                landed.push(saved.path);
            }
            let perm_card = crate::image_save::card_file_name("p-perm", &perm).unwrap();
            assert!(landed[0].ends_with(&perm_card), "{} vs {perm_card}", landed[0]);
            assert_eq!(recent(&perm).unwrap().thumb.as_deref(), Some(landed[0].as_str()));
            assert_eq!(recent(&temp).unwrap().thumb, None, "a temporary project has no card");
            assert_eq!(recent(&other).unwrap().thumb, None);
            assert_eq!(read_recents().items.len(), 3, "no entry is created");
        });
    }

    /// An oversize `.trt` reaches the user as a plain refusal; every other
    /// read error keeps its own kind (the `.bak` recovery needs NotFound).
    #[test]
    fn an_oversize_project_read_is_a_refusal() {
        let big = std::io::Error::new(std::io::ErrorKind::InvalidData, "project file is larger than 512 MB");
        assert!(matches!(capped_read_error(big), AppError::BadInput(m) if m == "project file is larger than 512 MB"));
        let gone = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        assert!(matches!(capped_read_error(gone), AppError::Io(e) if e.kind() == std::io::ErrorKind::NotFound));
    }

    /// A card commit stamps recents from a blocking-pool thread while a save
    /// upserts from the main one. Each thread owns one entry and reads it back
    /// after every write of its own: an update the OTHER thread wrote over from
    /// a stale read shows up as a regression, and the file must parse as the
    /// primary (not via `.bak`) at every step.
    #[test]
    fn concurrent_recents_updates_never_lose_one() {
        with_isolated("recents-race", |dir| {
            let a = dir.join("A.trt").to_string_lossy().into_owned();
            let b = dir.join("B.trt").to_string_lossy().into_owned();
            let item = |path: &str, modified: String| RecentItem {
                path: path.into(),
                name: "n".into(),
                modified_at: modified,
                duration_sec: 0.0,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
                kind: Some("image".into()),
            };
            upsert_recent(item(&a, "0".into())).unwrap();
            upsert_recent(item(&b, "0".into())).unwrap();
            let file = recents_path().unwrap();
            let find = |path: &str| read_recents().items.into_iter().find(|r| r.path == path);
            const ROUNDS: usize = 150;
            std::thread::scope(|s| {
                // The card commit's writer: A's thumb only.
                s.spawn(|| {
                    for i in 0..ROUNDS {
                        let thumb = format!("card-{i}");
                        set_recent_thumb(&a, &thumb);
                        let entry = find(&a).expect("A's entry was lost");
                        assert_eq!(entry.thumb.as_deref(), Some(thumb.as_str()), "A's card update was lost");
                        let _guard = lock_recents();
                        assert!(
                            matches!(read_json_status::<RecentsIndex>(&file), JsonRead::Parsed { recovered: false, .. }),
                            "recents.json did not parse on its own at round {i}"
                        );
                    }
                });
                // A save's writer: B's entry only.
                s.spawn(|| {
                    for i in 0..ROUNDS {
                        upsert_recent(item(&b, i.to_string())).expect("a save's recents update failed");
                        let entry = find(&b).expect("B's entry was lost");
                        assert_eq!(entry.modified_at, i.to_string(), "B's save update was lost");
                    }
                });
            });
            let last = format!("card-{}", ROUNDS - 1);
            assert_eq!(find(&a).unwrap().thumb.as_deref(), Some(last.as_str()));
            assert_eq!(find(&b).unwrap().modified_at, (ROUNDS - 1).to_string());
            assert_eq!(read_recents().items.len(), 2);
        });
    }

    /// Only an object is a project: Rename and Duplicate index into it, and
    /// serde_json's `IndexMut` panics on anything but an object or null —
    /// which under `panic = "abort"` is the whole app. Refused, file untouched.
    #[test]
    fn rename_and_duplicate_refuse_a_file_that_is_not_an_object() {
        with_isolated("not-object", |dir| {
            for (i, body) in ["[]", "0", "\"x\"", "true", "null"].into_iter().enumerate() {
                let p = dir.join(format!("Odd {i}.trt"));
                std::fs::write(&p, body).unwrap();
                let path = p.to_string_lossy().into_owned();
                for r in [
                    rename_project(path.clone(), "Renamed".into()),
                    duplicate_project(path.clone(), "Copy".into(), "q-1".into()),
                ] {
                    assert!(
                        matches!(&r, Err(AppError::BadInput(m)) if m.ends_with("is not a Taroting project")),
                        "{body}: {r:?}"
                    );
                }
                assert_eq!(std::fs::read_to_string(&p).unwrap(), body);
            }
            assert!(!dir.join("Renamed.trt").exists() && !dir.join("Copy.trt").exists());
        });
    }

    /* -------------------- the store worker ----------------------------- */

    /// Two writes of one file share its single `.tmp`. On the UI thread they
    /// could never overlap; off it, unqueued, two threads interleaved their
    /// bytes into that `.tmp` (or renamed it out from under each other). Four
    /// threads, payloads differing in every byte and in length, each writing
    /// through the async queue: every write succeeds, and the file and its
    /// `.bak` are each exactly one of the payloads.
    #[test]
    fn queued_writes_of_one_file_never_tear() {
        with_isolated("store-tear", |dir| {
            let target = dir.join("Torn.trt");
            let payloads: Vec<Vec<u8>> =
                (0..4u8).map(|i| vec![b'a' + i; 1_000_000 + usize::from(i) * 4_099]).collect();
            std::thread::scope(|s| {
                for p in &payloads {
                    let target = target.clone();
                    s.spawn(move || {
                        for _ in 0..6 {
                            let (t, bytes) = (target.clone(), p.clone());
                            tauri::async_runtime::block_on(on_store(move || atomic_write(&t, &bytes)))
                                .expect("a queued write succeeds");
                        }
                    });
                }
            });
            let primary = std::fs::read(&target).unwrap();
            let bak = std::fs::read(bak_path(&target)).unwrap();
            assert!(payloads.contains(&primary), "the file is torn ({} bytes)", primary.len());
            assert!(payloads.contains(&bak), "the .bak is torn ({} bytes)", bak.len());
        });
    }

    /// A load runs off the worker, so a save can be between its two renames
    /// while the load reads — and then there is no primary, only the `.bak`.
    /// That read used to come back `recovered`: a "your project was damaged"
    /// notice for a project nothing had happened to. Hundreds of queued saves
    /// against a reader in a tight loop: never a recovery, never an error.
    #[test]
    fn a_read_overlapping_saves_never_reports_a_recovery() {
        with_isolated("store-overlap", |dir| {
            let target = dir.join("Busy.trt");
            let bytes = serde_json::to_vec(&minimal_project("Busy")).unwrap();
            atomic_write(&target, &bytes).unwrap();
            atomic_write(&target, &bytes).unwrap(); // a .bak, as after any second save
            let done = std::sync::atomic::AtomicBool::new(false);
            let (mut reads, mut recoveries) = (0u32, 0u32);
            std::thread::scope(|s| {
                s.spawn(|| {
                    for _ in 0..400 {
                        let (t, b) = (target.clone(), bytes.clone());
                        on_store_blocking(move || atomic_write(&t, &b)).unwrap().unwrap();
                    }
                    done.store(true, std::sync::atomic::Ordering::SeqCst);
                });
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    let (value, recovered) = read_project_value(&target).expect("every read succeeds");
                    assert_eq!(value["name"], "Busy");
                    reads += 1;
                    recoveries += u32::from(recovered);
                }
            });
            assert!(reads > 0);
            assert_eq!(recoveries, 0, "{recoveries} of {reads} reads reported a recovery");
        });
    }

    /// A job that reaches a helper which queues and waits — from the worker
    /// itself — runs inline instead of waiting on itself forever.
    #[test]
    fn a_queued_job_can_queue_without_deadlocking() {
        let nested = on_store_blocking(|| on_store_blocking(|| 7).unwrap()).unwrap();
        assert_eq!(nested, 7);
        let from_async = tauri::async_runtime::block_on(on_store(|| on_store_blocking(|| 8)));
        assert_eq!(from_async.unwrap(), 8);
    }

    /// The queue's one ordering promise (see the worker's comment): a save
    /// queued before a delete of the same file is written first, so the
    /// delete removes it — the save cannot land afterwards and bring a
    /// discarded project back. The worker is held while both are queued, so
    /// the save is still waiting when the delete joins the queue; both
    /// commands route through the queue, pinned in the source (a delete run
    /// beside the queue would remove nothing and the save would then write).
    #[test]
    fn a_save_queued_before_a_delete_cannot_resurrect_the_file() {
        with_isolated("store-fifo", |dir| {
            let target = dir.join("Discarded.trt");
            atomic_write(&target, &serde_json::to_vec(&minimal_project("Discarded")).unwrap()).unwrap();
            let (release, hold) = mpsc::channel::<()>();
            let (held_tx, held) = mpsc::channel::<()>();
            submit_to_store(Box::new(move || {
                let _ = held_tx.send(());
                let _ = hold.recv();
            }));
            held.recv().unwrap();
            let (saved_tx, saved) = mpsc::channel();
            let (path, project) = (target.to_string_lossy().into_owned(), minimal_project("Late save"));
            submit_to_store(Box::new(move || {
                let _ = saved_tx.send(save_project_at(None, path, project).map(|_| ()));
            }));
            let (deleted_tx, deleted) = mpsc::channel();
            let path = target.to_string_lossy().into_owned();
            submit_to_store(Box::new(move || {
                let _ = deleted_tx.send(delete_project_now(&path));
            }));
            release.send(()).unwrap();
            saved.recv().unwrap().expect("the save is written");
            deleted.recv().unwrap().expect("the delete runs");
            assert!(!target.exists(), "the save landed after the delete");
            assert!(!bak_path(&target).exists() && !tmp_path(&target).exists());
        });
        // Only the code before the test module: the needles appear here too.
        let source = include_str!("store.rs");
        let code: String = source[..source.find("#[cfg(test)]\nmod tests").or_else(|| source.find("#[cfg(test)]\r\nmod tests")).expect("the test module")]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let delete = &code[code.find("pubasyncfndelete_project(").expect("delete_project")..];
        let head = |s: &str, n: usize| s.chars().take(n).collect::<String>();
        assert!(head(delete, 120).contains("{on_store(move||delete_project_now(&path)).await}"), "delete_project is queued");
        let save = &code[code.find("pubasyncfnsave_project(").expect("save_project")..];
        assert!(
            head(save, 400).contains("on_store(move||{let(path,project)=body.into_parts()?;save_project_at("),
            "save_project is queued"
        );
    }

    /* -------------------- load-time repairs ---------------------------- */

    /// A load reads off the worker, so an autosave can land between its read
    /// and its repair write. Written anyway, the repair of the OLD read
    /// reverted that save. Only a file still exactly as the load read it gets
    /// the repair.
    #[test]
    fn a_load_time_repair_never_reverts_a_save_that_landed_after_the_read() {
        with_isolated("repair-stamp", |dir| {
            let proj = dir.join("Raced.trt");
            write_json(&proj, &minimal_project("Read by the load"));
            let read_as = file_stamp(&proj);
            write_json(&proj, &minimal_project("Saved after the read"));
            persist_repair(&proj, &minimal_project("Repaired"), false, read_as);
            assert_eq!(read_disk(&proj)["name"], "Saved after the read");

            let read_as = file_stamp(&proj);
            persist_repair(&proj, &minimal_project("Repaired"), false, read_as);
            assert_eq!(read_disk(&proj)["name"], "Repaired", "an untouched file is repaired");

            // No stamp (the file could not be stat'd at the read): skipped.
            persist_repair(&proj, &minimal_project("Unstamped"), false, None);
            assert_eq!(read_disk(&proj)["name"], "Repaired");
        });
    }

    /* -------------------- recents failures ----------------------------- */

    /// The project is on disk the moment `atomic_write` returns; a recents
    /// update that then fails (recents.json's `.tmp` held by a scanner here)
    /// used to fail the whole save — autosave stuck on "Save failed", Keep
    /// writing "<name> 2.trt" on retry, Duplicate's copy left without a card.
    #[cfg(windows)]
    #[test]
    fn a_save_whose_recents_update_fails_still_succeeds() {
        use std::os::windows::fs::OpenOptionsExt;
        with_isolated("recents-io", |dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let tmp = data.join("recents.json.tmp");
            std::fs::write(&tmp, b"").unwrap();
            let hold = std::fs::OpenOptions::new().read(true).share_mode(0).open(&tmp).unwrap();

            let proj = dir.join("Saved.trt");
            let saved = save_project_at(None, proj.to_string_lossy().into_owned(), minimal_project("Saved"));
            assert!(saved.is_ok(), "{saved:?}");
            assert_eq!(read_disk(&proj)["name"], "Saved");
            let copy = duplicate_project(proj.to_string_lossy().into_owned(), "Saved copy".into(), "c-1".into());
            assert!(copy.as_ref().is_ok_and(|c| Path::new(c).is_file()), "{copy:?}");

            // The updates really did fail: nothing reached recents.
            drop(hold);
            assert!(read_recents().items.is_empty());
        });
    }

    /* -------------------- a card left as its .bak ---------------------- */

    /// A project saved twice keeps a `.bak`; delete its `.trt` in Explorer and
    /// Home keeps the card (owner's ruling: the `.bak` still holds the work).
    /// Delete, Rename and Duplicate all failed on it with "not found" — Delete
    /// before it had touched the `.bak` or the card, so the card could never
    /// go. Now each works from the `.bak`.
    #[test]
    fn a_card_left_only_as_its_bak_can_be_deleted_renamed_and_duplicated() {
        with_isolated("bak-only-card", |dir| {
            let card = |name: &str| {
                let p = dir.join(format!("{name}.trt"));
                write_json(&bak_path(&p), &minimal_project(name));
                let path = p.to_string_lossy().into_owned();
                upsert_recent(RecentItem {
                    path: path.clone(),
                    name: name.into(),
                    modified_at: "m".into(),
                    duration_sec: 3.0,
                    thumb: None,
                    size_bytes: 0,
                    opened_at: None,
                    kind: None,
                })
                .unwrap();
                path
            };

            let gone = card("Gone");
            std::fs::write(tmp_path(Path::new(&gone)), b"a failed save's bytes").unwrap();
            assert!(list_recents().unwrap().items.iter().any(|r| r.path == gone), "the card is listed");
            delete_project(gone.clone()).expect("a .bak-only card deletes");
            assert!(!bak_path(Path::new(&gone)).exists() && !tmp_path(Path::new(&gone)).exists());
            assert!(recent(&gone).is_none(), "and its card goes");

            let moved = card("Moved");
            let arrived = rename_project(moved.clone(), "Arrived".into()).expect("a .bak-only card renames");
            assert!(arrived.ends_with("Arrived.trt"), "{arrived}");
            assert_eq!(read_disk(Path::new(&arrived))["name"], "Arrived");
            assert!(!bak_path(Path::new(&moved)).exists(), "the old .bak goes with the rename");
            assert_eq!(recent(&arrived).map(|r| r.name), Some("Arrived".to_string()));

            let source = card("Source");
            let copy = duplicate_project(source.clone(), "Source copy".into(), "copy-id".into())
                .expect("a .bak-only card duplicates");
            assert_eq!(read_disk(Path::new(&copy))["id"], "copy-id");
            assert_eq!(read_disk(Path::new(&copy))["name"], "Source copy");
            assert!(bak_path(Path::new(&source)).exists(), "a duplicate leaves its source alone");

            // A case-only rename of such a card is still one project, no " (2)".
            let quiet = card("Quiet");
            let renamed = rename_project(quiet, "quiet".into()).unwrap();
            assert!(renamed.ends_with("quiet.trt"), "{renamed}");
            assert!(trt_names(dir).iter().all(|n| !n.contains("quiet (")), "{:?}", trt_names(dir));

            // From the .bak too, only an object is a project (IndexMut aborts).
            let odd = dir.join("Odd.trt");
            std::fs::write(bak_path(&odd), b"[]").unwrap();
            let r = rename_project(odd.to_string_lossy().into_owned(), "Even".into());
            assert!(matches!(&r, Err(AppError::BadInput(m)) if m.ends_with("is not a Taroting project")), "{r:?}");
            // Neither copy on disk: still not found.
            let nothing = dir.join("Nothing.trt").to_string_lossy().into_owned();
            assert!(matches!(rename_project(nothing, "X".into()), Err(AppError::Io(_))));
        });
    }

    /* -------------------- names held by a .bak ------------------------- */

    /// A recoverable project left as its `.bak` holds its name: New project,
    /// a temp project, Rename and Duplicate all pick the next one instead of
    /// handing it out — which made the old card open the new project, and the
    /// new one's second save rotate over the old `.bak`.
    #[test]
    fn a_name_held_only_by_a_bak_is_never_handed_out() {
        with_isolated("bak-names", |dir| {
            let docs = paths::default_projects_dir().unwrap();
            paths::ensure_dir(&docs).unwrap();
            write_json(&docs.join("Untitled.trt.bak"), &minimal_project("Old work"));
            assert!(new_project_path(None).unwrap().ends_with("Untitled 2.trt"));

            let tmp = paths::temp_projects_dir().unwrap();
            paths::ensure_dir(&tmp).unwrap();
            write_json(&tmp.join("Clip.trt.bak"), &minimal_project("Clip"));
            assert!(temp_project_path(Some("Clip".into())).unwrap().ends_with("Clip 2.trt"));

            let held = dir.join("Held.trt");
            write_json(&bak_path(&held), &minimal_project("Held"));
            let other = dir.join("Other.trt");
            write_json(&other, &minimal_project("Other"));
            let renamed = rename_project(other.to_string_lossy().into_owned(), "Held".into()).unwrap();
            assert!(renamed.ends_with("Held (2).trt"), "{renamed}");
            let copy = duplicate_project(renamed, "Held".into(), "h-3".into()).unwrap();
            assert!(copy.ends_with("Held (3).trt"), "{copy}");
            assert!(!held.exists());
            assert_eq!(read_disk(&bak_path(&held))["name"], "Held", "the held .bak is untouched");
        });
    }

    /* -------------------- the save's card thumbnail -------------------- */

    /// Every autosave used to list the whole thumbs directory for the card
    /// picture. It now asks for the card's own frame first — the file the
    /// editor's bin makes for the same media (`_300.jpg` for a 0.6 s clip) —
    /// so with an earlier frame of the same media also cached, the save takes
    /// the card frame where the listing took whichever came first. Generator
    /// and audio first clips never look at all.
    #[test]
    fn a_save_takes_the_card_frame_itself() {
        with_isolated("save-card-frame", |dir| {
            assert_eq!(card_thumb_frame(0.6), (0.3, "_300.jpg".to_string()));
            assert_eq!(card_thumb_frame(10.0), (0.5, "_500.jpg".to_string()));
            assert_eq!(card_thumb_frame(0.0), (0.0, "_0.jpg".to_string()));

            let cache = crate::cache::Cache::new_at(dir.join("cache"));
            let file = dir.join("clip.bin");
            std::fs::write(&file, b"0123456789").unwrap();
            let meta = std::fs::metadata(&file).unwrap();
            let media = serde_json::json!({
                "id": "m1", "path": file.to_string_lossy(), "size": meta.len(),
                "mtimeMs": mtime_ms_of(&meta), "kind": "video", "duration": 0.6, "hasAudio": false
            });
            let hash = crate::cache::MediaKey {
                path: file.to_string_lossy().into_owned(),
                size: meta.len(),
                mtime_ms: mtime_ms_of(&meta),
            }
            .hash();
            cache.ensure_kind_dir(crate::cache::CacheKind::Thumbs).unwrap();
            let earlier = cache.file_path(crate::cache::CacheKind::Thumbs, &hash, "_100.jpg");
            let card = cache.file_path(crate::cache::CacheKind::Thumbs, &hash, "_300.jpg");
            std::fs::write(&earlier, b"frame at 0.1").unwrap();
            std::fs::write(&card, b"frame at 0.3").unwrap();
            assert_eq!(crate::media::thumbs::any_thumb_for(&cache, &hash), Some(earlier.clone()), "precondition");

            let tracks = serde_json::json!([{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                "clips": [clip_at("c1", "m1", 0.0)] }]);
            let path = dir.join("Card.trt").to_string_lossy().into_owned();
            save_project_at(Some(&cache), path.clone(), project_with_tracks(serde_json::json!([media]), tracks))
                .unwrap();
            assert_eq!(recent(&path).unwrap().thumb, Some(card.to_string_lossy().into_owned()));

            // A generator first clip: no frame, so no card picture.
            let solid = serde_json::json!({
                "id": "g1", "path": "Solid", "size": 0, "mtimeMs": 0, "kind": "image",
                "duration": 0.0, "hasAudio": false, "width": 64, "height": 64,
                "generator": { "type": "solid", "color": "#00ff00" }
            });
            let tracks = serde_json::json!([{ "id": "t1", "kind": "video", "name": "V1", "muted": false,
                "clips": [clip_at("c1", "g1", 0.0)] }]);
            let gen_path = dir.join("Solid.trt").to_string_lossy().into_owned();
            save_project_at(Some(&cache), gen_path.clone(), project_with_tracks(serde_json::json!([solid]), tracks))
                .unwrap();
            assert_eq!(recent(&gen_path).unwrap().thumb, None);
        });
    }

    /* -------------------- parse-memory guard --------------------------- */

    /// The scan skips string contents and honours escapes: a string full of
    /// `{`, `[`, `,`, an escaped quote and an escaped backslash costs exactly
    /// what a plain string of the same length does. (Were `\"` read as the
    /// end, the `{` after it would be priced; were `\\` read as escaping the
    /// closing quote, the string would run on to the end of the input.)
    #[test]
    fn the_parse_price_skips_string_contents() {
        let tricky = br#"{"k":"{[,\"{\\","n":[1,2]}"#;
        let plain = br#"{"k":"abcdefgh","n":[1,2]}"#;
        assert_eq!(tricky.len(), plain.len());
        assert_eq!(value_cost(tricky), value_cost(plain));
        // One object, two array slots (the `[` and one `,`) plus the member
        // comma, three strings with their bytes.
        assert_eq!(value_cost(plain), OBJECT_COST + 3 * SLOT_COST + 3 * STRING_COST + 2 + 9 + 2);
    }

    /// The budget admits the biggest drawing the editor can build: every
    /// stroke shape it writes, priced per stroke as it sits pretty-printed in
    /// a project, fits `WORST_STROKE_COST`, so a drawing at every cap at once
    /// prices under `VALUE_BUDGET`. And it refuses what it exists for: a file
    /// at the read cap made of one-key objects, or of bare zeros, prices far
    /// over it.
    #[test]
    fn the_parse_budget_admits_a_cap_sized_drawing_and_refuses_dense_files() {
        let strokes = [
            serde_json::json!({ "t": "pen", "c": "#1a2b3c", "w": 4.5, "o": 1.0, "p": "AB+/AB+/AB+/AB+/" }),
            serde_json::json!({ "t": "marker", "c": "#FFD400", "w": 18.0, "o": 0.4, "p": "AAAAAAAAAAAAAAAA" }),
            serde_json::json!({ "t": "erase", "w": 16.0, "p": "AAAAAAAAAAAAAAAA" }),
            serde_json::json!({ "t": "arrow", "c": "#e5484d", "w": 3.0, "o": 1.0, "a": [10.0, 20.0], "b": [300.0, -5.0] }),
            serde_json::json!({ "t": "line", "c": "#e5484d", "w": 65535.0, "o": 0.25, "a": [-1e7, 1e7], "b": [1e7, -1e7] }),
        ];
        let priced = |n: usize, s: &Value| {
            let chunk: Vec<Value> = std::iter::repeat_n(s.clone(), n).collect();
            value_cost(&serde_json::to_vec_pretty(&serde_json::json!({ "chunks": [chunk] })).unwrap())
        };
        let mut worst = 0;
        for s in &strokes {
            let per = (priced(200, s) - priced(100, s)) / 100;
            assert!(per <= WORST_STROKE_COST, "{s} prices {per} per stroke");
            worst = worst.max(per);
        }
        // The heaviest is within a whisker of the constant, so the budget is
        // not padded beyond what a real drawing needs.
        assert!(worst + 100 > WORST_STROKE_COST, "the heaviest stroke prices only {worst}");
        let cap_sized = image_rules::MAX_STROKES_TOTAL * worst + image_rules::MAX_POINTS_TOTAL * 16;
        assert!(cap_sized < VALUE_BUDGET);

        let per_byte = |unit: &[u8]| value_cost(&unit.repeat(1000)) as f64 / (unit.len() * 1000) as f64;
        let at_cap = |unit: &[u8]| (per_byte(unit) * image_rules::MAX_TRT_BYTES as f64) as u64;
        assert!(at_cap(br#"{"a":0},"#) > 10 * VALUE_BUDGET);
        assert!(at_cap(b"0,") > 4 * VALUE_BUDGET);
        assert!(at_cap(b"{},") > 10 * VALUE_BUDGET);
    }

    /// The refusal itself, at a small budget: a few hundred kilobytes of
    /// one-key objects is refused where an ordinary project of the same size
    /// passes, and nothing at or under the threshold is scanned.
    #[test]
    fn a_dense_file_over_budget_is_refused() {
        let path = Path::new("C:\\p\\Dense.trt");
        let dense = format!("[{}{{\"a\":0}}]", "{\"a\":0},".repeat(40_000));
        let ordinary = serde_json::to_vec_pretty(&serde_json::json!({
            "name": "x".repeat(dense.len()), "media": [], "timeline": {}
        }))
        .unwrap();
        let budget = 1_000_000;
        assert!(matches!(
            refuse_value_bomb_within(dense.as_bytes(), path, 1024, budget),
            Err(AppError::BadInput(m)) if m.contains("more data than Taroting can open safely")
        ));
        assert!(refuse_value_bomb_within(&ordinary, path, 1024, budget).is_ok());
        assert!(refuse_value_bomb_within(dense.as_bytes(), path, dense.len(), budget).is_ok());
    }

    /// Every project read is behind the guard: a real file over the budget
    /// (~16 MB of empty objects, priced at several GB) is refused by load —
    /// also when it is the `.bak` a missing primary would recover from — and
    /// by rename and duplicate, before any of it is parsed.
    #[test]
    fn every_project_read_refuses_a_dense_file() {
        with_isolated("dense-reads", |dir| {
            let mut body = Vec::with_capacity(17_000_000);
            body.push(b'[');
            for _ in 0..5_600_000 {
                body.extend_from_slice(b"{},");
            }
            body.extend_from_slice(b"{}]");
            assert!(value_cost(&body) > VALUE_BUDGET, "the fixture must be over the real budget");

            let dense = dir.join("Dense.trt");
            std::fs::write(&dense, &body).unwrap();
            let path = dense.to_string_lossy().into_owned();
            let refused = |r: Result<()>| matches!(r, Err(AppError::BadInput(m)) if m.contains("more data"));
            assert!(refused(load_project(path.clone()).map(|_| ())), "load");
            assert!(refused(rename_project(path.clone(), "R".into()).map(|_| ())), "rename");
            assert!(refused(duplicate_project(path.clone(), "D".into(), "d".into()).map(|_| ())), "duplicate");

            let wounded = dir.join("Wounded.trt");
            std::fs::write(bak_path(&wounded), &body).unwrap();
            assert!(load_project(wounded.to_string_lossy().into_owned()).is_err(), "a dense .bak is not recovered");
        });
    }

    /* -------------------- recents bounds ------------------------------- */

    /// A crafted `.trt`'s name and `modifiedAt` reach recents.json verbatim
    /// through a save or an open, and recents.json is read whole on every
    /// listing and every save. Both are cut — by whole characters, never mid
    /// character — to what a card shows.
    #[test]
    fn recents_entries_keep_a_bounded_name_and_stamp() {
        with_isolated("recents-bounds", |dir| {
            let mut long = minimal_project(&"é".repeat(10_000));
            long["modifiedAt"] = Value::from("9".repeat(5_000));
            let saved = dir.join("Saved.trt");
            save_project_at(None, saved.to_string_lossy().into_owned(), long.clone()).unwrap();
            let entry = recent(&saved.to_string_lossy()).unwrap();
            assert_eq!(entry.name, "é".repeat(RECENT_NAME_MAX_CHARS));
            assert_eq!(entry.modified_at, "9".repeat(RECENT_STAMP_MAX_CHARS));

            let opened = dir.join("Opened.trt");
            write_json(&opened, &long);
            load_project(opened.to_string_lossy().into_owned()).unwrap();
            let entry = recent(&opened.to_string_lossy()).unwrap();
            assert_eq!(entry.name.chars().count(), RECENT_NAME_MAX_CHARS);
            assert_eq!(entry.modified_at.len(), RECENT_STAMP_MAX_CHARS);
        });
    }

    /// An index or a settings file over the read cap is present but unread —
    /// never parsed, and never written over (the `Unreadable` protection).
    #[test]
    fn an_oversize_index_is_unread_and_kept() {
        let dir = std::env::temp_dir().join(format!("taroting-json-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("index.json");
        std::fs::write(&file, br#"{"schema":1,"items":[]}"#).unwrap();
        let (parsed, present) = read_json_one_within::<RecentsIndex>(&file, 1_000);
        assert!(parsed.is_some() && present);
        let (parsed, present) = read_json_one_within::<RecentsIndex>(&file, 10);
        assert!(parsed.is_none() && present, "over the cap: present, not parsed");
        let (parsed, present) = read_json_one_within::<RecentsIndex>(&dir.join("absent.json"), 10);
        assert!(parsed.is_none() && !present);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Home used to show "No projects yet" over a library whose index was on
    /// disk but unreadable: the listing answered an empty list. It is an
    /// error now (Home toasts it), for both copies corrupt and for an index
    /// past the read cap — a perfectly valid one padded past 4 MB parses fine
    /// without the cap — while an absent index is still an empty list.
    #[test]
    fn an_unreadable_index_lists_as_an_error_not_as_empty() {
        with_isolated("recents-list-error", |_dir| {
            let data = paths::data_dir().unwrap();
            paths::ensure_dir(&data).unwrap();
            let recents = data.join("recents.json");
            assert!(list_recents().unwrap().items.is_empty(), "absent is a first run");

            std::fs::write(&recents, b"{\"schema\":1,\"items\":[{\"pa").unwrap();
            std::fs::write(bak_path(&recents), b"{\"schema\":1,\"items\":[{\"na").unwrap();
            assert!(list_recents().is_err(), "both copies corrupt");

            std::fs::remove_file(bak_path(&recents)).unwrap();
            let mut padded = br#"{"schema":1,"items":[]}"#.to_vec();
            padded.resize(JSON_INDEX_MAX_BYTES as usize + 1, b' ');
            std::fs::write(&recents, &padded).unwrap();
            assert!(list_recents().is_err(), "past the read cap");
            upsert_recent(RecentItem {
                path: "C:\\p\\X.trt".into(),
                name: "X".into(),
                modified_at: "m".into(),
                duration_sec: 0.0,
                thumb: None,
                size_bytes: 0,
                opened_at: None,
                kind: None,
            })
            .unwrap();
            assert_eq!(std::fs::read(&recents).unwrap(), padded, "and never written over");
        });
    }

    /* -------------------- temp path classification -------------------- */

    /// The frontend's own fixtures (src/core/open-media.test.ts): the temp dir
    /// matches whatever the case or slash direction, a trailing separator on
    /// the dir changes nothing, and a sibling folder that merely starts with
    /// the same name is not inside it.
    #[test]
    fn temp_paths_classify_as_the_frontend_classifies_them() {
        let dir = "C:\\Users\\Ana\\AppData\\Local\\Taroting\\tmp-projects";
        assert!(inside_folded(dir, &format!("{dir}\\clip.trt")));
        assert!(inside_folded(dir, "c:/users/ana/appdata/local/taroting/TMP-PROJECTS/clip.trt"));
        assert!(!inside_folded(dir, "C:\\Users\\Ana\\Documents\\Taroting\\clip.trt"));
        assert!(!inside_folded(dir, &format!("{dir}-old\\clip.trt")));
        let trailing = format!("{dir}\\");
        assert!(inside_folded(&trailing, &format!("{dir}\\clip.trt")));
        assert!(!inside_folded(&trailing, &format!("{dir}-old\\clip.trt")));
        assert!(!inside_folded("", &format!("{dir}\\clip.trt")));
    }

    /// A differently-cased path into tmp-projects is temporary to the editor,
    /// so it must be to the store too: saving or opening it leaves recents
    /// alone. Case-sensitive, it got a card — and with 24 of them evicted a
    /// real project's card for good.
    #[test]
    fn a_differently_cased_temp_path_never_enters_recents() {
        with_isolated("temp-case", |_dir| {
            let tmp = paths::temp_projects_dir().unwrap();
            paths::ensure_dir(&tmp).unwrap();
            let shouty = tmp.to_string_lossy().to_uppercase().replace('\\', "/") + "/Quick.trt";
            assert!(is_temp_project_path(&shouty));
            save_project_at(None, shouty.clone(), minimal_project("Quick")).unwrap();
            load_project(shouty).unwrap();
            assert!(read_recents().items.is_empty(), "{:?}", read_recents().items);
        });
    }

    /* -------------------- project paths only --------------------------- */

    /// Save, delete, rename and duplicate take only an absolute `.trt` on a
    /// drive or share: a compromised webview could otherwise delete any file
    /// of the user's (and its `.bak`) or overwrite one with project JSON.
    #[test]
    fn only_a_project_path_is_written_or_deleted() {
        for ok in ["C:\\p\\a.trt", "C:\\p\\A.TRT", "\\\\server\\share\\a.trt", "C:/p/a.trt"] {
            assert!(project_target(ok).is_ok(), "{ok}");
        }
        for bad in [
            "C:\\p\\a.txt",
            "C:\\p\\a.trt.bak",
            "C:\\p\\a",
            "a.trt",
            "\\\\.\\C:\\p\\a.trt",
            "\\\\?\\C:\\p\\a.trt",
            "//?/C:/p/a.trt",
            "C:\\p\\a.txt:s.trt",
            "C:\\p\\a.trt\0",
        ] {
            assert!(matches!(project_target(bad), Err(AppError::BadInput(_))), "{bad:?}");
        }
        with_isolated("project-only", |dir| {
            let doc = dir.join("letter.txt");
            std::fs::write(&doc, b"Dear").unwrap();
            let doc_path = doc.to_string_lossy().into_owned();
            assert!(delete_project(doc_path.clone()).is_err());
            assert!(save_project_at(None, doc_path.clone(), minimal_project("X")).is_err());
            assert!(rename_project(doc_path.clone(), "X".into()).is_err());
            assert!(duplicate_project(doc_path, "X".into(), "x".into()).is_err());
            assert_eq!(std::fs::read(&doc).unwrap(), b"Dear", "untouched");
        });
    }

    /// The E2E's own cleanup (`debug_remove_test_file`'s body): a file under
    /// one of its roots goes, whatever the case of the path; anything outside
    /// them, a `..` climb, a relative path or a folder is refused; a file
    /// already gone is fine.
    #[test]
    fn the_test_cleanup_removes_only_its_own_files() {
        let root = std::env::temp_dir().join(format!("taroting-cleanup-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("taroting-cleanup-out-{}", std::process::id()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let mine = root.join("sub").join("export.png");
        let theirs = outside.join("keep.png");
        std::fs::write(&mine, b"x").unwrap();
        std::fs::write(&theirs, b"x").unwrap();
        let roots = [root.clone()];

        remove_test_file(&mine.to_string_lossy().to_uppercase(), &roots).unwrap();
        assert!(!mine.exists());
        remove_test_file(&mine.to_string_lossy(), &roots).expect("already gone is fine");
        for bad in [
            theirs.to_string_lossy().into_owned(),
            format!("{}\\..\\{}\\keep.png", root.display(), outside.file_name().unwrap().to_string_lossy()),
            "keep.png".to_string(),
            root.join("sub").to_string_lossy().into_owned(),
        ] {
            assert!(remove_test_file(&bad, &roots).is_err(), "{bad}");
        }
        assert!(theirs.exists() && root.join("sub").is_dir());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
