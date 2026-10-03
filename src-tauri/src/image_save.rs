//! Writing an image project's output — an export the user named, the Home card
//! thumbnail, a pasted image — through one chunked save protocol.
//!
//! **The protocol.** `image_save_begin` (JSON: the destination, the format, the
//! declared byte count) opens `<target>.taroting-part` (called "the `.part`"
//! below) and returns a token plus the final path. `image_save_chunk` carries
//! the bytes as a RAW request body (the token in the `x-taroting-save` header,
//! because the body IS the bytes), any number of times. `image_save_commit` checks the declared total and the
//! format's magic bytes, syncs, and renames the `.part` over the target;
//! `image_save_abort` removes the `.part` and forgets the token. Any failure
//! removes the `.part` too, so nothing half-written is ever left beside the
//! user's files.
//!
//! **Why its own suffix, not a plain `.part`.** A plain `<name>.part` beside the
//! user's files may be anyone's — a browser's half-finished download — so a
//! leftover could not be told from someone else's file: it had to be refused,
//! and one left by a crash mid-export blocked that name until the user found
//! and deleted it by hand. `.taroting-part` is only ever ours, so a leftover
//! is the app's own (a save a crash cut short) and the next save to that name
//! simply truncates it. Within a run, two saves still never share one (see
//! "One save per `.part`" below), and a foreign `.part` is never touched.
//!
//! **Why not `atomic_write`.** It keeps the previous file as a `.bak`, which is
//! right for a project and wrong for an exported picture: the user would find a
//! stray copy of their old export next to the new one. `.part` + rename gives
//! the same all-or-nothing replace without it.
//!
//! **Why the path travels only in the begin call.** It is the one input that
//! decides where bytes land, so it is checked once, as JSON, against the rules
//! below — an absolute path whose extension matches the format, never a source
//! file of the project (`path_identity`, not case folding: the filesystem
//! decides) — and every later call can only name a token.
//!
//! **Zero cost when unused.** The managed state is an empty map: no thread, no
//! timer, nothing resident until a save begins.
//!
//! The wire shapes below are the frozen part (src/core/ipc.ts mirrors them, and
//! the tests at the bottom pin both directions). Tauri `State` parameters are
//! not part of the wire.
//!
//! **Concurrency.** Each open save sits behind its own lock, and the map of
//! open saves behind another that is only ever held briefly. A chunk takes the
//! save's lock for its write; commit and abort first take the save OUT of the
//! map and then wait on its lock, so an abort that arrives mid-write waits for
//! that write, closes the file and removes the `.part` — and a chunk that
//! arrives after it finds either no token or a closed save, never a
//! half-finished file to append to.
//!
//! **One save per `.part`.** Two saves to one target would share one `.part`
//! (opened with truncate): the second begin would empty the first save's
//! bytes, and the first commit — whose count and magic are checked from memory
//! — would rename that empty file over the target. So every `.part` is owned
//! by exactly one save, from begin until its file is closed or renamed away
//! (a commit in progress, already out of the token map, still owns it). A
//! second begin for a user's export is refused; a second project CARD
//! supersedes the first — the image editor stops waiting on a slow card after
//! a cap and may start the next one while the old one still streams, and the
//! newer card shows the newer edits.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::InvokeBody;
use tauri::Manager;

use crate::error::{AppError, Result};
use crate::project::store::{self, path_identity, PathIdentity};

/// Where a save lands. `kind`-tagged with camelCase fields, exactly as
/// `ImageSaveDest` in src/core/ipc.ts sends it. `rename_all_fields` is not
/// optional here: `rename_all` on an enum renames only the variant TAGS, so
/// `project_path` would silently stay snake_case on the wire and every
/// thumbnail save would fail to deserialize (the PlaybackPlan `jobId` bug).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ImageSaveDest {
    /// An export the user named. `sources` = every non-generator media path of
    /// the IN-MEMORY project, so a layer added since the last save is covered:
    /// the target may be none of them.
    #[serde(rename = "user")]
    User { path: String, sources: Vec<String> },
    /// The Home card of an image project: a rendered JPEG in the cache's
    /// thumbnail dir, named from `project_id` and a hash of `project_path`
    /// (`card_file_name` — never a path the frontend chose). Recorded on the
    /// project's recents entry unless it is temporary.
    #[serde(rename = "projectThumb")]
    ProjectThumb { project_path: String, project_id: String },
    /// A pasted image, written where the user can see and relink it
    /// (Documents\Taroting\Pasted images) under a name the backend picks.
    #[serde(rename = "pasted")]
    Pasted { project_name: String },
}

/// The output format, as TS `ImageExportFormat` names it.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    /// The name a refusal shows the user.
    fn label(self) -> &'static str {
        match self {
            ImageFormat::Png => "PNG",
            ImageFormat::Jpeg => "JPEG",
            ImageFormat::Webp => "WebP",
        }
    }
}

/// A save's token and the path it lands at (begin) or landed at (commit).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBegun {
    pub token: u64,
    pub path: String,
}

/// Largest file one save may declare.
pub const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
/// Largest Home card thumbnail.
pub const MAX_THUMB_BYTES: u64 = 1024 * 1024;
/// Largest single chunk body.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// Saves that may be open at once; a begin beyond this is refused.
pub const MAX_PENDING: usize = 4;

/// An open save nobody has touched for this long is one its page abandoned (a
/// reload mid-export leaves its token unreachable). It is reaped only when a
/// begin would otherwise be refused for want of a slot — never on a timer — so
/// a lost page cannot lock image saving out for the rest of the run. The
/// client streams a finished blob, so a live save goes milliseconds between
/// chunks, not a minute.
const STALE_AFTER: Duration = Duration::from_secs(60);

/// The Home card file of an image project is
/// `imgproj-<project id>-<path hash>.jpg` in the cache's thumbnail dir.
pub(crate) const CARD_PREFIX: &str = "imgproj-";

/// The file name of an image project's Home card, or `None` for an id the
/// protocol does not accept (see `valid_project_id`).
///
/// Keyed by the project's PATH as well as its id: a `.trt` copied in File
/// Explorer keeps its id (only the app's Duplicate assigns a new one), and
/// with the id alone both copies wrote one `imgproj-<id>.jpg` — both Home
/// cards pointed at it, and whichever copy was edited last set the picture on
/// both. The path is folded to one slash style and lower case, so two
/// spellings of one file share a card; folding can only over-match (two files
/// in a case-sensitive folder), which costs a shared picture, never a crash.
/// The hash is hex, so the name stays inside `[A-Za-z0-9-]` like the id.
pub(crate) fn card_file_name(project_id: &str, project_path: &str) -> Option<String> {
    valid_project_id(project_id)
        .then(|| format!("{CARD_PREFIX}{project_id}-{:016x}.jpg", path_hash(project_path)))
}

/// 64-bit FNV-1a of the folded path. Hand-rolled rather than std's
/// `DefaultHasher`, whose output is explicitly allowed to change between Rust
/// releases — a card's name has to survive an app update.
fn path_hash(project_path: &str) -> u64 {
    project_path
        .replace('/', "\\")
        .to_lowercase()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// The open saves. Managed as `Arc<ImageSaves>` (main.rs).
#[derive(Default)]
pub struct ImageSaves {
    /// The open saves; both maps are empty whenever nothing is being saved.
    open: Mutex<Open>,
    /// The last token handed out; never reused within a run.
    next: AtomicU64,
}

type Save = Arc<Mutex<Pending>>;

#[derive(Default)]
struct Open {
    /// Open saves by token. Commit and abort take a save out of here first.
    by_token: HashMap<u64, Save>,
    /// The save that owns each `.part` (by `part_key`), held from begin until
    /// that save is finished — through a commit too, which has already left
    /// `by_token` — so no second save can open the same file meanwhile.
    by_part: HashMap<String, Save>,
}

impl Open {
    /// Forget `save`'s `.part` claim (it is finished or closed).
    fn release(&mut self, save: &Save) {
        self.by_part.retain(|_, s| !Arc::ptr_eq(s, save));
    }
}

/// The key a `.part` is claimed under: case-folded, one slash style, so two
/// spellings the volume treats as one file cannot both hold it. Folding can
/// only OVER-match (two genuinely different files on a case-sensitive
/// folder), which costs a refused or superseded save, never a shared file.
fn part_key(part: &Path) -> String {
    part.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// One open save.
struct Pending {
    /// The open `.part` file; `None` once the save has been closed (committed,
    /// aborted or failed), which is what a chunk racing the close finds.
    file: Option<File>,
    part: PathBuf,
    /// Whether the file at `part` is still THIS save's to remove. Cleared once
    /// it is removed or renamed into place, so a late close (a superseded
    /// card's commit, arriving after the newer card opened the same `.part`)
    /// can never delete the newer save's file.
    owns_part: bool,
    target: PathBuf,
    format: ImageFormat,
    /// The byte count begin declared; commit requires exactly this many.
    declared: u64,
    written: u64,
    /// The first bytes written, kept for the magic check at commit.
    head: [u8; 12],
    head_len: usize,
    /// The project whose recents card a ProjectThumb commit points at the new
    /// picture (`None` for every other destination). `store::set_recent_thumb`
    /// skips a temporary project itself.
    thumb_recent: Option<String>,
    /// The last begin/chunk, for `STALE_AFTER`.
    touched: Instant,
}

/// A destination resolved to a file: where the bytes land, how the `.part` is
/// opened, and the largest total it may declare.
#[derive(Clone)]
struct Resolved {
    target: PathBuf,
    /// How the `.part` is opened, and what a file already sitting there means.
    part: PartOpen,
    /// What a begin does when another open save already owns this `.part`:
    /// a project card supersedes the older card (true); a user's export is
    /// refused (false). See "One save per `.part`" above.
    supersede: bool,
    max_bytes: u64,
    thumb_recent: Option<String>,
}

/// How a begin opens `<target>.taroting-part` when no open save of ours holds
/// it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PartOpen {
    /// A project card or a user's export: a file already at that name can
    /// only be the app's own (a save a crash cut short — the suffix is ours
    /// alone), so it is simply truncated. A save of THIS run holding it was
    /// already refused or superseded by the `by_part` claim before the open.
    Replace,
    /// A pasted image picks its own free name: created exclusively, so two
    /// pastes racing for " pasted 3.png" cannot share it, and a taken one
    /// means pick again.
    Repick,
}

/// Lock that never panics: a poisoned lock only means another save panicked
/// mid-update, and under `panic = "abort"` that cannot happen in a release
/// build anyway. Never worth taking the app down over.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::BadInput(msg.into())
}

/// The suffix of every file a save writes before it is renamed into place.
/// Ours alone — see "Why its own suffix" above.
const PART_SUFFIX: &str = ".taroting-part";

/// `<target>.taroting-part`, beside the target so the final rename never
/// crosses a volume.
fn part_of(target: &Path) -> PathBuf {
    let mut s: OsString = target.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/* ------------------------------------------------------------------ */
/* Pure checks                                                         */
/* ------------------------------------------------------------------ */

/// The chunk body, which must be RAW bytes. A JSON body means the caller sent
/// an array (one JSON number per byte — tens of times the size, parsed on the
/// way in) or something that is not image data at all.
fn accept_body(body: &InvokeBody) -> Result<&[u8]> {
    match body {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_CHUNK_BYTES => Ok(bytes),
        InvokeBody::Raw(bytes) => Err(bad(format!(
            "an image chunk is at most {MAX_CHUNK_BYTES} bytes, got {}",
            bytes.len()
        ))),
        InvokeBody::Json(_) => Err(bad("image bytes must arrive as a raw body")),
    }
}

/// The save token from the `x-taroting-save` header, a decimal u64.
fn parse_token(headers: &tauri::http::HeaderMap) -> Result<u64> {
    headers
        .get("x-taroting-save")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| bad("the image chunk carries no valid save token"))
}

/// Does the file start the way its format says it must?
fn check_magic(format: ImageFormat, head: &[u8]) -> bool {
    match format {
        ImageFormat::Png => head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        ImageFormat::Jpeg => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        ImageFormat::Webp => head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP",
    }
}

/// A Home card's project id: 1 to 64 of `[A-Za-z0-9-]`, so the file name it
/// builds can never climb out of the thumbnail dir (`..\`, `/`, `:`) or grow
/// without bound. A frontend `crypto.randomUUID()` always passes.
fn valid_project_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Everything a user-named export target must be before a byte is written:
/// an absolute, ordinary path (no `\\.\` device or `\\?\` verbatim form) whose
/// extension is the format's, in a folder that exists, that is not a folder
/// itself — and that is none of the project's source files.
///
/// "Is it a source?" is the filesystem's answer (`path_identity`), never case
/// folding: the volume decides which spellings are one file. When the target
/// EXISTS and a source's identity cannot be settled, the export is refused —
/// overwriting an original is the one mistake this app promises never to make.
/// The single exception is a source that is provably absent (not found): a
/// missing original cannot be the file that is there, and refusing on it would
/// block every overwrite while any layer's photo is offline.
fn check_user_target(target: &Path, sources: &[String], format: ImageFormat) -> Result<()> {
    let text = target.to_string_lossy();
    if text.trim().is_empty() {
        return Err(bad("choose where to save the image"));
    }
    // Checked on the text, not via `is_absolute`: Rust calls a verbatim
    // `\\?\C:\x` absolute, and a device path is absolute too.
    let slashed = text.replace('/', "\\");
    if slashed.starts_with(r"\\.\") || slashed.starts_with(r"\\?\") || slashed.starts_with(r"\??\") {
        return Err(bad("the image can't be saved to a device path"));
    }
    // A colon past the drive prefix names an alternate data stream:
    // `C:\x\a.jpg:s.png` passes every check below (its extension is .png, the
    // "file" does not exist) yet opening its `.part` writes a stream INTO the
    // original a.jpg and changes its modified time. Bytes, not chars, so a
    // multi-byte first character cannot shift the window off a boundary.
    if slashed.as_bytes().get(2..).is_some_and(|rest| rest.contains(&b':')) {
        return Err(bad("the save location isn't a plain file path"));
    }
    if !target.is_absolute() {
        return Err(bad("the save location must be a full path"));
    }
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let ext_ok = match format {
        ImageFormat::Png => ext == "png",
        ImageFormat::Jpeg => ext == "jpg" || ext == "jpeg",
        ImageFormat::Webp => ext == "webp",
    };
    if !ext_ok {
        return Err(bad(format!(
            "a {} file must be named .{}",
            format.label(),
            match format {
                ImageFormat::Png => "png",
                ImageFormat::Jpeg => "jpg or .jpeg",
                ImageFormat::Webp => "webp",
            }
        )));
    }
    if !target.parent().is_some_and(Path::is_dir) {
        return Err(bad("the folder to save into doesn't exist"));
    }
    if target.is_dir() {
        return Err(bad("the save location is a folder"));
    }
    refuse_a_source(target, sources, "that file")?;
    // The save writes `<target>.taroting-part` first and renames it into
    // place, so that file is written too, and must be no original either. (A
    // leftover merely SITTING there is the app's own and is truncated when
    // begin claims it, after the "already being saved" check, so our own
    // in-flight save still gets that answer.)
    let part = part_of(target);
    refuse_a_source(&part, sources, &format!("a file named {}", part_name(&part)))
}

/// Refuse `dest` when it is one of `sources`, or when it EXISTS and a
/// source's sameness with it cannot be settled. `it` names `dest` in the
/// refusal.
fn refuse_a_source(dest: &Path, sources: &[String], it: &str) -> Result<()> {
    let exists = dest.exists();
    for src in sources {
        // A share off the local network is never looked at
        // (`media::source::may_touch`): only its spelling can say it is the
        // destination.
        if !crate::media::source::may_touch(Path::new(src)) {
            if dest.to_string_lossy().replace('/', "\\").eq_ignore_ascii_case(&src.replace('/', "\\")) {
                return Err(bad(format!(
                    "{it} is one of this project's originals, which are never overwritten; choose another name"
                )));
            }
            continue;
        }
        match path_identity(dest, Path::new(src)) {
            PathIdentity::Same => {
                return Err(bad(format!(
                    "{it} is one of this project's originals, which are never overwritten; choose another name"
                )))
            }
            PathIdentity::Different => {}
            PathIdentity::Unknown => {
                let absent = matches!(
                    std::fs::symlink_metadata(src),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound
                );
                if exists && !absent {
                    return Err(bad(format!(
                        "couldn't confirm {it} isn't one of this project's originals; choose another name"
                    )));
                }
            }
        }
    }
    Ok(())
}

/// The `.part`'s own file name, as a refusal shows it.
fn part_name(part: &Path) -> String {
    part.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The first free `<project> pasted N.png` in `dir` (N ≥ 1). A name whose
/// `.part` exists counts as taken: another paste is writing it right now.
fn pasted_name(dir: &Path, project: &str) -> Result<PathBuf> {
    // Bounded so the name (plus " pasted N.png.taroting-part") stays far inside a
    // file-name component's limit, whatever the project is called.
    let base: String = store::sanitize_filename(project).chars().take(96).collect();
    for n in 1..=9_999u32 {
        let candidate = dir.join(format!("{base} pasted {n}.png"));
        if !candidate.exists() && !part_of(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(bad("couldn't find a free name for the pasted image"))
}

fn resolve_user(path: &str, sources: &[String], format: ImageFormat) -> Result<Resolved> {
    let target = PathBuf::from(path);
    check_user_target(&target, sources, format)?;
    Ok(Resolved { target, part: PartOpen::Replace, supersede: false, max_bytes: MAX_IMAGE_BYTES, thumb_recent: None })
}

fn resolve_pasted(dir: &Path, project_name: &str, format: ImageFormat) -> Result<Resolved> {
    if format != ImageFormat::Png {
        return Err(bad("a pasted image is saved as PNG"));
    }
    std::fs::create_dir_all(dir)?;
    Ok(Resolved {
        target: pasted_name(dir, project_name)?,
        part: PartOpen::Repick,
        supersede: false,
        max_bytes: MAX_IMAGE_BYTES,
        thumb_recent: None,
    })
}

fn resolve_thumb(thumbs_dir: &Path, project_path: &str, project_id: &str, format: ImageFormat) -> Result<Resolved> {
    if format != ImageFormat::Jpeg {
        return Err(bad("a project card is saved as JPEG"));
    }
    let name = card_file_name(project_id, project_path).ok_or_else(|| bad("the project id is not valid"))?;
    Ok(Resolved {
        target: thumbs_dir.join(name),
        part: PartOpen::Replace,
        supersede: true,
        max_bytes: MAX_THUMB_BYTES,
        thumb_recent: Some(project_path.to_string()),
    })
}

/* ------------------------------------------------------------------ */
/* The protocol, free of Tauri state (the commands below wrap it)      */
/* ------------------------------------------------------------------ */

impl ImageSaves {
    /// Open a save for an already-resolved destination. `resolve` runs under
    /// the map lock, so the slot count, the pasted-name choice, the `.part`
    /// claim and the insert are one step: two begins can neither both take the
    /// last slot, nor both pick the same pasted name, nor both open one `.part`.
    fn begin(
        &self,
        format: ImageFormat,
        total: u64,
        resolve: impl Fn() -> Result<Resolved>,
    ) -> Result<SaveBegun> {
        let mut open = lock(&self.open);
        if open.by_token.len() >= MAX_PENDING {
            reap_stale(&mut open, Instant::now());
        }
        if open.by_token.len() >= MAX_PENDING {
            return Err(bad("too many image saves are already running"));
        }
        // A pasted name can be taken between the check and the create (by
        // another process, or a file that appears in the folder); re-pick.
        let mut attempts = 0;
        let (r, file, key) = loop {
            let r = resolve()?;
            if total == 0 || total > r.max_bytes {
                return Err(bad(format!(
                    "an image save must declare 1 to {} bytes, got {total}",
                    r.max_bytes
                )));
            }
            let key = part_key(&part_of(&r.target));
            if let Some(older) = open.by_part.get(&key).cloned() {
                if !r.supersede {
                    return Err(bad("that file is already being saved"));
                }
                // The older card is finished here and now. Its lock is WAITED
                // for, not tried: a write or a commit in flight completes
                // first (neither takes the map lock while holding its own, so
                // this cannot deadlock), and whatever it does after this finds
                // the file closed and the `.part` no longer its own.
                close_locked(&mut lock(&older));
                open.by_token.retain(|_, s| !Arc::ptr_eq(s, &older));
                open.release(&older);
            }
            let mut opts = OpenOptions::new();
            opts.write(true);
            if r.part == PartOpen::Replace {
                opts.create(true).truncate(true);
            } else {
                opts.create_new(true);
            }
            let part = part_of(&r.target);
            match opts.open(&part) {
                Ok(f) => break (r, f, key),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && r.part == PartOpen::Repick && attempts < 8 => {
                    attempts += 1
                }
                Err(e) => return Err(e.into()),
            }
        };
        let token = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let path = r.target.to_string_lossy().into_owned();
        let save = Arc::new(Mutex::new(Pending {
            file: Some(file),
            part: part_of(&r.target),
            owns_part: true,
            target: r.target,
            format,
            declared: total,
            written: 0,
            head: [0; 12],
            head_len: 0,
            thumb_recent: r.thumb_recent,
            touched: Instant::now(),
        }));
        open.by_part.insert(key, Arc::clone(&save));
        open.by_token.insert(token, save);
        Ok(SaveBegun { token, path })
    }

    fn entry(&self, token: u64) -> Option<Save> {
        lock(&self.open).by_token.get(&token).cloned()
    }

    fn take(&self, token: u64) -> Option<Save> {
        lock(&self.open).by_token.remove(&token)
    }

    /// Give up `save`'s `.part` claim. Called only once the save's own lock is
    /// released: the map lock is never taken while holding a save's lock.
    fn release(&self, save: &Save) {
        lock(&self.open).release(save);
    }

    /// Append one chunk. Any failure (a chunk past the declared total, a write
    /// error) ends the save: its `.part` is removed and the token forgotten.
    fn chunk(&self, token: u64, bytes: &[u8]) -> Result<()> {
        let entry = self.entry(token).ok_or_else(|| bad("unknown image save"))?;
        let result = {
            let mut p = lock(&entry);
            let result = write_locked(&mut p, bytes);
            if result.is_err() {
                close_locked(&mut p);
            }
            result
        };
        if result.is_err() {
            self.take(token);
            self.release(&entry);
        }
        result
    }

    /// Check, sync and move the file into place. On any failure the `.part`
    /// is removed. Returns the final path and the recents entry to stamp.
    fn commit(&self, token: u64) -> Result<(SaveBegun, Option<String>)> {
        let entry = self.take(token).ok_or_else(|| bad("unknown image save"))?;
        self.finish(token, &entry)
    }

    /// The part of `commit` after the save has left the token map — split out
    /// so a test can land a newer card's begin in exactly that gap.
    fn finish(&self, token: u64, entry: &Save) -> Result<(SaveBegun, Option<String>)> {
        let done = {
            let mut p = lock(entry);
            let result = finish_locked(&mut p);
            if result.is_err() {
                close_locked(&mut p);
            }
            result.map(|()| {
                (
                    SaveBegun { token, path: p.target.to_string_lossy().into_owned() },
                    p.thumb_recent.take(),
                )
            })
        };
        self.release(entry);
        done
    }

    /// Drop a save and its `.part`. Unknown and already-finished tokens are
    /// fine: abort is what every error path calls, possibly twice.
    fn abort(&self, token: u64) {
        if let Some(entry) = self.take(token) {
            close_locked(&mut lock(&entry));
            self.release(&entry);
        }
    }
}

/// Close every open save idle for `STALE_AFTER`. A save whose lock is held is
/// mid-write, so by definition not stale, and is skipped rather than waited on
/// (this runs under the map lock).
fn reap_stale(open: &mut Open, now: Instant) {
    let Open { by_token, by_part } = open;
    by_token.retain(|_, entry| match entry.try_lock() {
        Ok(mut p) if now.saturating_duration_since(p.touched) >= STALE_AFTER => {
            close_locked(&mut p);
            by_part.retain(|_, s| !Arc::ptr_eq(s, entry));
            false
        }
        _ => true,
    });
}

fn write_locked(p: &mut Pending, bytes: &[u8]) -> Result<()> {
    let Some(file) = p.file.as_mut() else {
        return Err(bad("this image save has already finished"));
    };
    let len = bytes.len() as u64;
    if p.written.saturating_add(len) > p.declared {
        return Err(bad(format!(
            "the image is larger than the {} bytes its save declared",
            p.declared
        )));
    }
    file.write_all(bytes)?;
    let take = (p.head.len() - p.head_len).min(bytes.len());
    p.head[p.head_len..p.head_len + take].copy_from_slice(&bytes[..take]);
    p.head_len += take;
    p.written += len;
    p.touched = Instant::now();
    Ok(())
}

fn finish_locked(p: &mut Pending) -> Result<()> {
    // Taken out here so the handle is closed on every path below; Windows
    // refuses to rename a file that is still open.
    let file = p.file.take().ok_or_else(|| bad("this image save has already finished"))?;
    if p.written != p.declared {
        return Err(bad(format!(
            "the image save ended after {} of {} bytes",
            p.written, p.declared
        )));
    }
    if !check_magic(p.format, &p.head[..p.head_len]) {
        return Err(bad(format!("the image data is not a {} file", p.format.label())));
    }
    file.sync_data()?;
    drop(file);
    // Replaces an existing target (MoveFileEx with REPLACE_EXISTING): the old
    // export is swapped for the new one in one step, and no `.bak` is kept.
    std::fs::rename(&p.part, &p.target)?;
    p.owns_part = false;
    Ok(())
}

/// Close the file (if still open) and remove the `.part` if it is still this
/// save's. Idempotent: a second close never touches the path again, because a
/// newer save may have opened a fresh `.part` there since.
fn close_locked(p: &mut Pending) {
    drop(p.file.take());
    if std::mem::take(&mut p.owns_part) {
        let _ = std::fs::remove_file(&p.part);
    }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/// Every step touches the disk, so none of it runs on the async runtime's own
/// threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| bad(format!("the image save stopped unexpectedly: {e}")))?
}

/// The cache, when this run has one: `main.rs` manages it only if
/// %LOCALAPPDATA% was usable, and only a project card needs it — a user's
/// export must never fail because the cache is off.
fn cache_of(app: &tauri::AppHandle) -> Option<Arc<crate::cache::Cache>> {
    app.try_state::<Arc<crate::cache::Cache>>().map(|c| Arc::clone(&c))
}

/// Open a project card save: the cache's thumbnail dir, the card named from
/// the id and the project path. The command's glue, callable without Tauri.
pub(crate) fn begin_thumb(
    saves: &ImageSaves,
    cache: &crate::cache::Cache,
    project_path: &str,
    project_id: &str,
    format: ImageFormat,
    total: u64,
) -> Result<SaveBegun> {
    let dir = cache.ensure_kind_dir(crate::cache::CacheKind::Thumbs)?;
    saves.begin(format, total, || resolve_thumb(&dir, project_path, project_id, format))
}

/// A chunk request's body as the bytes the write needs — the one copy per
/// chunk: the body is borrowed from the request, and the write runs on a
/// blocking thread that must own what it writes. A refused body is never
/// copied.
fn owned_body(body: &InvokeBody) -> Result<Vec<u8>> {
    accept_body(body).map(<[u8]>::to_vec)
}

/// Append one chunk's body (`owned_body`'s result) to save `token`. A
/// malformed body ends its save, like any other chunk failure: the `.part` is
/// removed and the token forgotten.
pub(crate) fn chunk_body(saves: &ImageSaves, token: u64, body: Result<Vec<u8>>) -> Result<()> {
    match body {
        Ok(bytes) => saves.chunk(token, &bytes),
        Err(e) => {
            saves.abort(token);
            Err(e)
        }
    }
}

/// Commit save `token` and, for a project card, point the project's recents
/// entry at it (`set_recent_thumb` skips a temporary project and an unknown
/// one itself). The command's glue, callable without Tauri.
pub(crate) fn commit_and_stamp(
    saves: &ImageSaves,
    cache: Option<&crate::cache::Cache>,
    token: u64,
) -> Result<SaveBegun> {
    let (saved, recent) = saves.commit(token)?;
    if let Some(project_path) = recent {
        // A card is a cache file: tell the LRU it is fresh, or the next
        // eviction would take it first.
        if let Some(cache) = cache {
            cache.mark_used(Path::new(&saved.path));
        }
        store::set_recent_thumb(&project_path, &saved.path);
    }
    Ok(saved)
}

/// Open a save: validate the destination, open `<target>.part`, return the
/// token and the final path.
#[tauri::command]
pub async fn image_save_begin(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ImageSaves>>,
    dest: ImageSaveDest,
    format: ImageFormat,
    total_bytes: u64,
) -> Result<SaveBegun> {
    let saves = Arc::clone(&state);
    match dest {
        ImageSaveDest::User { path, sources } => blocking(move || {
            // Checked BEFORE the map lock: asking the filesystem about every
            // source can be slow on a network share, and nothing about a
            // user-named target needs to be atomic with the slot count.
            let resolved = resolve_user(&path, &sources, format)?;
            saves.begin(format, total_bytes, || Ok(resolved.clone()))
        })
        .await,
        ImageSaveDest::Pasted { project_name } => {
            let dir = crate::paths::default_projects_dir()?.join("Pasted images");
            blocking(move || saves.begin(format, total_bytes, || resolve_pasted(&dir, &project_name, format)))
                .await
        }
        ImageSaveDest::ProjectThumb { project_path, project_id } => {
            let cache = cache_of(&app).ok_or_else(|| bad("the thumbnail cache is unavailable"))?;
            blocking(move || begin_thumb(&saves, &cache, &project_path, &project_id, format, total_bytes)).await
        }
    }
}

/// Append one chunk. The body must be `InvokeBody::Raw` (a JSON body is
/// refused); the token rides in the `x-taroting-save` header as a decimal u64.
#[tauri::command]
pub async fn image_save_chunk(
    state: tauri::State<'_, Arc<ImageSaves>>,
    request: tauri::ipc::Request<'_>,
) -> Result<()> {
    let token = parse_token(request.headers())?;
    let saves = Arc::clone(&state);
    let body = owned_body(request.body());
    blocking(move || chunk_body(&saves, token, body)).await
}

/// Verify (declared total, magic bytes), sync, and move the `.part` into
/// place. Returns the final path.
#[tauri::command]
pub async fn image_save_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ImageSaves>>,
    token: u64,
) -> Result<SaveBegun> {
    let saves = Arc::clone(&state);
    let cache = cache_of(&app);
    blocking(move || commit_and_stamp(&saves, cache.as_deref(), token)).await
}

/// Drop an open save and its `.part`. Idempotent.
#[tauri::command]
pub async fn image_save_abort(state: tauri::State<'_, Arc<ImageSaves>>, token: u64) -> Result<()> {
    let saves = Arc::clone(&state);
    blocking(move || {
        saves.abort(token);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// What the webview RECEIVES: `{ token, path }`, the shape ipc.ts types
    /// `imageSaveBegin` / `imageSaveCommit` as.
    #[test]
    fn save_begun_reaches_the_webview_in_camel_case() {
        let v = serde_json::to_value(SaveBegun { token: 41, path: r"C:\Out\pic (edited).png".into() })
            .expect("serializes");
        assert_eq!(v, json!({ "token": 41, "path": r"C:\Out\pic (edited).png" }));
    }

    /// What the webview SENDS: the three `ImageSaveDest` shapes exactly as the
    /// ipc.ts union writes them, field for field. The snake_case spelling of a
    /// struct-variant field must NOT deserialize — that is what proves
    /// `rename_all_fields` is on (with only `rename_all`, the snake_case one
    /// would be the one that parses and the camelCase one would fail).
    #[test]
    fn destinations_arrive_from_the_webview_in_camel_case() {
        let dest = |v: serde_json::Value| serde_json::from_value::<ImageSaveDest>(v);

        match dest(json!({ "kind": "user", "path": r"C:\Out\a.png", "sources": [r"C:\In\a.jpg", r"D:\b.webp"] }))
            .expect("user")
        {
            ImageSaveDest::User { path, sources } => {
                assert_eq!(path, r"C:\Out\a.png");
                assert_eq!(sources, [r"C:\In\a.jpg", r"D:\b.webp"]);
            }
            other => panic!("expected User, got {other:?}"),
        }
        match dest(json!({ "kind": "projectThumb", "projectPath": r"C:\P\Pic.trt", "projectId": "a1b2-c3" }))
            .expect("projectThumb")
        {
            ImageSaveDest::ProjectThumb { project_path, project_id } => {
                assert_eq!(project_path, r"C:\P\Pic.trt");
                assert_eq!(project_id, "a1b2-c3");
            }
            other => panic!("expected ProjectThumb, got {other:?}"),
        }
        match dest(json!({ "kind": "pasted", "projectName": "Holiday card" })).expect("pasted") {
            ImageSaveDest::Pasted { project_name } => assert_eq!(project_name, "Holiday card"),
            other => panic!("expected Pasted, got {other:?}"),
        }

        assert!(dest(json!({ "kind": "projectThumb", "project_path": "p", "project_id": "i" })).is_err());
        assert!(dest(json!({ "kind": "pasted", "project_name": "n" })).is_err());
        assert!(dest(json!({ "kind": "User", "path": "p", "sources": [] })).is_err(), "tags are exact");
        assert!(dest(json!({ "path": "p", "sources": [] })).is_err(), "the tag is required");
    }

    /// `ImageExportFormat` in TS: exactly "png" | "jpeg" | "webp".
    #[test]
    fn formats_arrive_by_their_ts_names_only() {
        let fmt = |s: &str| serde_json::from_value::<ImageFormat>(json!(s));
        assert_eq!(fmt("png").unwrap(), ImageFormat::Png);
        assert_eq!(fmt("jpeg").unwrap(), ImageFormat::Jpeg);
        assert_eq!(fmt("webp").unwrap(), ImageFormat::Webp);
        for odd in ["jpg", "PNG", "Webp", "gif", ""] {
            assert!(fmt(odd).is_err(), "{odd}");
        }
    }

    /* -------------------------- the protocol -------------------------- */
    //
    // Every test below works in its own scratch dir (pid + thread id) and
    // never touches the process environment, so none can race the recents
    // tests in store.rs, which swap %APPDATA% under their own lock. The one
    // flow that stamps recents (a card commit) lives there.

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taroting-imgsave-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0];
    const WEBP: &[u8] = b"RIFF\x24\0\0\0WEBPVP8L";

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn msg(r: Result<impl std::fmt::Debug>) -> String {
        match r {
            Err(AppError::BadInput(m)) => m,
            other => panic!("expected BadInput, got {other:?}"),
        }
    }

    #[test]
    fn a_chunk_must_be_a_raw_body_of_at_most_eight_mib() {
        assert_eq!(accept_body(&InvokeBody::Raw(vec![1, 2, 3])).unwrap(), &[1, 2, 3]);
        let json = InvokeBody::Json(serde_json::json!([137, 80, 78, 71]));
        assert_eq!(msg(accept_body(&json)), "image bytes must arrive as a raw body");
        assert!(accept_body(&InvokeBody::Raw(vec![0; MAX_CHUNK_BYTES])).is_ok());
        assert!(msg(accept_body(&InvokeBody::Raw(vec![0; MAX_CHUNK_BYTES + 1]))).contains("at most"));
    }

    #[test]
    fn the_token_header_must_be_a_decimal_u64() {
        use tauri::http::{HeaderMap, HeaderValue};
        let with = |v: Option<&str>| {
            let mut h = HeaderMap::new();
            if let Some(v) = v {
                h.insert("x-taroting-save", HeaderValue::from_str(v).unwrap());
            }
            parse_token(&h)
        };
        assert_eq!(with(Some("4096")).unwrap(), 4096);
        for odd in [None, Some(""), Some("abc"), Some("-3"), Some("1.5"), Some("18446744073709551616")] {
            assert!(with(odd).is_err(), "{odd:?}");
        }
    }

    /// Each format's own magic passes and every other format's is refused, so
    /// a check keyed on the wrong format cannot pass.
    #[test]
    fn magic_bytes_are_checked_per_format() {
        use ImageFormat::*;
        for (f, ok) in [(Png, PNG), (Jpeg, JPEG), (Webp, WEBP)] {
            for (g, other) in [(Png, PNG), (Jpeg, JPEG), (Webp, WEBP)] {
                assert_eq!(check_magic(f, &other[..12.min(other.len())]), f == g, "{f:?} vs {g:?}");
            }
            assert!(!check_magic(f, &ok[..2]), "{f:?}: a truncated head");
        }
        // WebP needs both halves: RIFF alone is a WAV or an AVI too.
        assert!(!check_magic(Webp, b"RIFF\x24\0\0\0WAVE"));
    }

    #[test]
    fn project_ids_are_plain_names_only() {
        assert!(valid_project_id("0f3c9a2e-5b7d-4e1f-9a8b-1c2d3e4f5a6b"));
        assert!(valid_project_id("p-9"));
        for odd in ["", "..\\x", "../x", "a/b", "a:b", "a b", "é", &"a".repeat(65)] {
            assert!(!valid_project_id(odd), "{odd}");
        }
        // Pinned: the hash is part of a name that must survive an app update.
        assert_eq!(card_file_name("p-9", r"C:\P\Pic.trt").as_deref(), Some(PIC_CARD));
        assert_eq!(card_file_name("..\\x", r"C:\P\Pic.trt"), None);
    }

    /// `imgproj-p-9-<hash of C:\P\Pic.trt>.jpg`.
    const PIC_CARD: &str = "imgproj-p-9-c3e96f2ae8b542e4.jpg";

    /// Two `.trt` files that share an id (an Explorer copy keeps it) get two
    /// card files; two spellings of ONE path get one.
    #[test]
    fn a_card_is_keyed_by_project_path_as_well_as_id() {
        let original = card_file_name("p-9", r"C:\P\Pic.trt").unwrap();
        let copy = card_file_name("p-9", r"C:\P\Pic - Copy.trt").unwrap();
        assert_ne!(original, copy);
        assert_eq!(copy, "imgproj-p-9-4c55f915851a3480.jpg");
        assert_eq!(card_file_name("p-9", "c:/p/PIC.trt").unwrap(), original);

        // Through the resolver, as a begin names the file.
        let dir = scratch("card-by-path");
        let saves = ImageSaves::default();
        let mut landed = Vec::new();
        for project in [r"C:\P\Pic.trt", r"C:\P\Pic - Copy.trt"] {
            let b = saves
                .begin(ImageFormat::Jpeg, JPEG.len() as u64, || resolve_thumb(&dir, project, "p-9", ImageFormat::Jpeg))
                .unwrap();
            saves.chunk(b.token, JPEG).unwrap();
            let (done, recent) = saves.commit(b.token).unwrap();
            assert_eq!(recent.as_deref(), Some(project));
            landed.push(done.path);
        }
        assert_ne!(landed[0], landed[1], "two projects, one card file");
        assert_eq!(names_in(&dir), [copy.as_str(), original.as_str()], "sorted: 4c55… before c3e9…");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_targets_are_absolute_matching_and_never_a_source() {
        let dir = scratch("target");
        let src = dir.join("Sea.jpg");
        std::fs::write(&src, JPEG).unwrap();
        let sources = vec![src.to_string_lossy().into_owned()];
        let check = |p: &Path, f: ImageFormat| check_user_target(p, &sources, f);

        // Fine: a new file, and an uppercase extension.
        check(&dir.join("Sea (edited).png"), ImageFormat::Png).unwrap();
        check(&dir.join("Sea (edited).JPG"), ImageFormat::Jpeg).unwrap();
        check(&dir.join("Sea (edited).jpeg"), ImageFormat::Jpeg).unwrap();

        assert!(msg(check(Path::new("out.png"), ImageFormat::Png)).contains("full path"));
        assert!(msg(check(Path::new(""), ImageFormat::Png)).contains("choose where"));
        for device in [r"\\.\X", r"\\.\PhysicalDrive0\a.png", r"\\?\C:\a.png", "//?/C:/a.png", r"\??\C:\a.png"] {
            assert!(msg(check(Path::new(device), ImageFormat::Png)).contains("device path"), "{device}");
        }
        assert!(msg(check(&dir.join("x.trt"), ImageFormat::Png)).contains(".png"));
        assert!(msg(check(&dir.join("x.png"), ImageFormat::Jpeg)).contains(".jpg"));
        assert!(msg(check(&dir.join("x.jpg"), ImageFormat::Webp)).contains(".webp"));
        assert!(msg(check(&dir.join("no-such-dir").join("x.png"), ImageFormat::Png)).contains("folder"));
        // The parent is a FILE.
        assert!(msg(check(&src.join("x.png"), ImageFormat::Png)).contains("folder to save into"));
        // The target is a folder.
        let sub = dir.join("pics.png");
        std::fs::create_dir(&sub).unwrap();
        assert!(msg(check(&sub, ImageFormat::Png)).contains("is a folder"));

        // The source itself, spelled in another case: the filesystem says it
        // is the same file, so it is refused (a byte compare would miss it).
        let other_case = dir.join("SEA.JPG");
        assert_ne!(other_case, src);
        assert!(msg(check(&other_case, ImageFormat::Jpeg)).contains("originals"));
        assert!(msg(check(&src, ImageFormat::Jpeg)).contains("originals"));

        // An alternate data stream of the source: a .png "file" that does not
        // exist, in a folder that does — refused on the colon alone, and the
        // original is left exactly as it was.
        let stream = PathBuf::from(format!("{}:s.png", src.display()));
        assert_eq!(msg(check(&stream, ImageFormat::Png)), "the save location isn't a plain file path");
        assert_eq!(std::fs::read(&src).unwrap(), JPEG);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An EXISTING target whose sameness with a source cannot be settled is
    /// refused; a NEW target, or a source that is provably not on disk, is
    /// not a risk to any original and is allowed.
    #[test]
    fn an_unsettled_identity_refuses_only_an_overwrite() {
        let dir = scratch("unknown");
        let existing = dir.join("old export.png");
        std::fs::write(&existing, PNG).unwrap();
        // An invalid name cannot be resolved, and not because it is absent.
        let unresolvable = vec![dir.join("a<b.png").to_string_lossy().into_owned()];
        assert!(msg(check_user_target(&existing, &unresolvable, ImageFormat::Png)).contains("couldn't confirm"));
        check_user_target(&dir.join("new export.png"), &unresolvable, ImageFormat::Png)
            .expect("a new target overwrites nothing");
        let missing = vec![dir.join("offline photo.png").to_string_lossy().into_owned()];
        check_user_target(&existing, &missing, ImageFormat::Png)
            .expect("a missing original cannot be the file that is there");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The save writes `<target>.taroting-part` too, so it gets the same source check
    /// as the target: an original sitting at that name (in any spelling), or
    /// an offline one recorded under it, is refused before a byte is written.
    #[test]
    fn the_part_of_a_user_target_is_never_a_source_either() {
        let dir = scratch("part-source");
        let target = dir.join("Sea.png");
        let original = dir.join("Sea.png.taroting-part");
        std::fs::write(&original, JPEG).unwrap();
        for spelling in [original.clone(), dir.join("SEA.PNG.TAROTING-PART")] {
            let sources = vec![spelling.to_string_lossy().into_owned()];
            assert_eq!(
                msg(check_user_target(&target, &sources, ImageFormat::Png)),
                "a file named Sea.png.taroting-part is one of this project's originals, which are never overwritten; choose another name",
                "{spelling:?}"
            );
        }
        // Offline, but recorded at exactly that name: still refused.
        let offline = vec![dir.join("Sky.png.taroting-part").to_string_lossy().into_owned()];
        assert!(msg(check_user_target(&dir.join("Sky.png"), &offline, ImageFormat::Png)).contains("originals"));
        // A source elsewhere leaves the name free.
        let elsewhere = vec![dir.join("Other.png").to_string_lossy().into_owned()];
        check_user_target(&dir.join("Sky.png"), &elsewhere, ImageFormat::Png).unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), JPEG, "the original is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A plain `<target>.part` that is not ours — a browser's half-finished
    /// download, say — is never touched: the save writes its own suffix. And a
    /// `<target>.taroting-part` a crash left behind no longer blocks the name:
    /// it can only be the app's own, so the next export truncates it and lands
    /// exactly its own bytes. Three different payloads, so the file on disk
    /// says which one survived where; the leftover is LONGER than the export,
    /// so a write that did not truncate would leave its tail behind.
    #[test]
    fn a_crash_leftover_is_reused_and_a_foreign_part_file_is_never_touched() {
        let dir = scratch("leftover-part");
        let target = dir.join("photo.png");
        let foreign = dir.join("photo.png.part");
        let leftover = dir.join("photo.png.taroting-part");
        std::fs::write(&foreign, b"half a download").unwrap();
        let crash: Vec<u8> = PNG.iter().copied().chain([0xEE; 64]).collect();
        std::fs::write(&leftover, &crash).unwrap();
        let body: Vec<u8> = PNG.iter().copied().chain([0x11; 3]).collect();
        assert!(body.len() < crash.len());

        let saves = ImageSaves::default();
        let b = begin_user(&saves, &target, ImageFormat::Png, body.len() as u64).expect("a leftover never blocks the name");
        saves.chunk(b.token, &body).unwrap();
        saves.commit(b.token).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), body, "the export, with no tail of the leftover");
        assert_eq!(std::fs::read(&foreign).unwrap(), b"half a download", "the foreign .part is untouched");
        assert_eq!(names_in(&dir), ["photo.png", "photo.png.part"]);

        // An abort over a leftover removes it too: nothing of ours is left.
        std::fs::write(&leftover, &crash).unwrap();
        let b = begin_user(&saves, &target, ImageFormat::Png, body.len() as u64).unwrap();
        saves.abort(b.token);
        assert_eq!(names_in(&dir), ["photo.png", "photo.png.part"]);
        assert_eq!(std::fs::read(&target).unwrap(), body, "an aborted save keeps the previous export");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A project card's leftover is reused the same way (the cache's own
    /// file), and an in-run claim still decides first: a leftover never lets
    /// a second export to one file in.
    #[test]
    fn a_leftover_never_bypasses_the_in_run_claim() {
        let dir = scratch("leftover-claim");
        let target = dir.join("Card (edited).jpg");
        let saves = ImageSaves::default();
        let body = card_bytes(0x3C);
        let first = begin_user(&saves, &target, ImageFormat::Jpeg, body.len() as u64).unwrap();
        // The first save's own `.taroting-part` is exactly a "leftover" on
        // disk; the claim, not the file, refuses the second begin.
        assert_eq!(msg(begin_user(&saves, &target, ImageFormat::Jpeg, 16)), "that file is already being saved");
        saves.chunk(first.token, &body).unwrap();
        saves.commit(first.token).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), body);

        std::fs::write(dir.join(format!("{PIC_CARD}.taroting-part")), [0xEE; 40]).unwrap();
        let card = card_bytes(0x7E);
        let b = saves
            .begin(ImageFormat::Jpeg, card.len() as u64, || resolve_thumb(&dir, r"C:\P\Pic.trt", "p-9", ImageFormat::Jpeg))
            .unwrap();
        saves.chunk(b.token, &card).unwrap();
        saves.commit(b.token).unwrap();
        assert_eq!(std::fs::read(dir.join(PIC_CARD)).unwrap(), card);
        assert_eq!(names_in(&dir), ["Card (edited).jpg", PIC_CARD]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pasted_names_count_up_and_are_sanitized() {
        let dir = scratch("pasted");
        let first = pasted_name(&dir, "Holiday card").unwrap();
        assert_eq!(first, dir.join("Holiday card pasted 1.png"));
        std::fs::write(&first, PNG).unwrap();
        assert_eq!(pasted_name(&dir, "Holiday card").unwrap(), dir.join("Holiday card pasted 2.png"));
        // A `.taroting-part` in flight (or left by a crash) is taken too.
        std::fs::write(dir.join("Holiday card pasted 2.png.taroting-part"), b"").unwrap();
        assert_eq!(pasted_name(&dir, "Holiday card").unwrap(), dir.join("Holiday card pasted 3.png"));
        // A plain `.part` is someone else's file and says nothing about ours.
        std::fs::write(dir.join("Holiday card pasted 3.png.part"), b"").unwrap();
        assert_eq!(pasted_name(&dir, "Holiday card").unwrap(), dir.join("Holiday card pasted 3.png"));
        assert_eq!(pasted_name(&dir, "a<b>c:\"d|e?f*").unwrap(), dir.join("a_b_c__d_e_f_ pasted 1.png"));
        assert_eq!(pasted_name(&dir, "  ...  ").unwrap(), dir.join("Untitled pasted 1.png"));
        let long = pasted_name(&dir, &"n".repeat(400)).unwrap();
        assert!(long.file_name().unwrap().len() < 128, "{long:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn begin_user(saves: &ImageSaves, target: &Path, format: ImageFormat, total: u64) -> Result<SaveBegun> {
        let t = target.to_string_lossy().into_owned();
        saves.begin(format, total, || resolve_user(&t, &[], format))
    }

    /// The whole happy path over an existing export: the old file is replaced
    /// in one step, and nothing is left beside it — no `.bak`, no `.taroting-part`.
    #[test]
    fn a_commit_replaces_the_target_and_leaves_nothing_behind() {
        let dir = scratch("commit");
        let target = dir.join("Card (edited).png");
        std::fs::write(&target, b"the previous export").unwrap();
        let body: Vec<u8> = PNG.iter().copied().chain((0..40u8).map(|i| i.wrapping_mul(7))).collect();

        let saves = ImageSaves::default();
        let begun = begin_user(&saves, &target, ImageFormat::Png, body.len() as u64).unwrap();
        assert_eq!(begun.path, target.to_string_lossy());
        assert_eq!(names_in(&dir), ["Card (edited).png", "Card (edited).png.taroting-part"]);
        // Chunks of 5, 7 and the rest: the magic straddles the first boundary.
        saves.chunk(begun.token, &body[..5]).unwrap();
        saves.chunk(begun.token, &body[5..12]).unwrap();
        saves.chunk(begun.token, &body[12..]).unwrap();
        let (done, recent) = saves.commit(begun.token).unwrap();
        assert_eq!((done.token, done.path.as_str()), (begun.token, begun.path.as_str()));
        assert!(recent.is_none(), "a user export stamps no recents card");
        assert_eq!(std::fs::read(&target).unwrap(), body);
        assert_eq!(names_in(&dir), ["Card (edited).png"]);
        // The token is gone: a late chunk or a second commit is refused.
        assert!(msg(saves.chunk(begun.token, &[1])).contains("unknown"));
        assert!(msg(saves.commit(begun.token)).contains("unknown"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_magic_fails_the_commit_and_removes_the_part() {
        let dir = scratch("magic");
        let target = dir.join("pic.png");
        std::fs::write(&target, b"keep me").unwrap();
        let saves = ImageSaves::default();
        let b = begin_user(&saves, &target, ImageFormat::Png, JPEG.len() as u64).unwrap();
        saves.chunk(b.token, JPEG).unwrap();
        assert_eq!(msg(saves.commit(b.token)), "the image data is not a PNG file");
        assert_eq!(names_in(&dir), ["pic.png"]);
        assert_eq!(std::fs::read(&target).unwrap(), b"keep me", "the old export is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn totals_are_declared_up_front_and_held_to() {
        let dir = scratch("totals");
        let target = dir.join("pic.webp");
        let saves = ImageSaves::default();
        assert!(msg(begin_user(&saves, &target, ImageFormat::Webp, 0)).contains("1 to"));
        assert!(msg(begin_user(&saves, &target, ImageFormat::Webp, MAX_IMAGE_BYTES + 1)).contains("1 to"));
        assert!(names_in(&dir).is_empty(), "a refused begin opens nothing");

        // Short: the commit refuses and cleans up.
        let b = begin_user(&saves, &target, ImageFormat::Webp, 20).unwrap();
        saves.chunk(b.token, WEBP).unwrap();
        assert!(msg(saves.commit(b.token)).contains("after 16 of 20 bytes"));
        assert!(names_in(&dir).is_empty());

        // Long: the chunk that crosses the total ends the save there.
        let b = begin_user(&saves, &target, ImageFormat::Webp, 20).unwrap();
        saves.chunk(b.token, WEBP).unwrap();
        assert!(msg(saves.chunk(b.token, &[0; 5])).contains("larger than the 20 bytes"));
        assert!(names_in(&dir).is_empty());
        assert!(msg(saves.chunk(b.token, &[0; 4])).contains("unknown"), "the save is over");

        // Exact: a WebP of exactly the declared size lands.
        let b = begin_user(&saves, &target, ImageFormat::Webp, 20).unwrap();
        saves.chunk(b.token, WEBP).unwrap();
        saves.chunk(b.token, &[9; 4]).unwrap();
        saves.commit(b.token).unwrap();
        assert_eq!(names_in(&dir), ["pic.webp"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn abort_removes_the_part_and_is_idempotent() {
        let dir = scratch("abort");
        let saves = ImageSaves::default();
        let b = begin_user(&saves, &dir.join("a.jpg"), ImageFormat::Jpeg, 64).unwrap();
        saves.chunk(b.token, JPEG).unwrap();
        assert_eq!(names_in(&dir), ["a.jpg.taroting-part"]);
        saves.abort(b.token);
        assert!(names_in(&dir).is_empty());
        saves.abort(b.token);
        saves.abort(987_654);
        assert!(msg(saves.chunk(b.token, JPEG)).contains("unknown"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A chunk that already holds its save when an abort lands finds the file
    /// closed, never a half-written `.part` to append to.
    #[test]
    fn a_chunk_racing_a_close_finds_it_closed() {
        let dir = scratch("race");
        let saves = ImageSaves::default();
        let b = begin_user(&saves, &dir.join("a.png"), ImageFormat::Png, 64).unwrap();
        let held = saves.entry(b.token).unwrap();
        saves.abort(b.token);
        assert_eq!(msg(write_locked(&mut lock(&held), PNG)), "this image save has already finished");
        assert!(names_in(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn at_most_four_saves_are_open_and_an_abandoned_one_is_reaped() {
        let dir = scratch("pending");
        let saves = ImageSaves::default();
        let tokens: Vec<u64> = (0..MAX_PENDING)
            .map(|i| begin_user(&saves, &dir.join(format!("p{i}.png")), ImageFormat::Png, 16).unwrap().token)
            .collect();
        let mut distinct = tokens.clone();
        distinct.dedup();
        assert_eq!(distinct.len(), MAX_PENDING, "tokens are never reused");
        assert!(msg(begin_user(&saves, &dir.join("p9.png"), ImageFormat::Png, 16)).contains("too many"));
        assert!(!dir.join("p9.png.taroting-part").exists());

        saves.abort(tokens[1]);
        let fifth = begin_user(&saves, &dir.join("p5.png"), ImageFormat::Png, 16).unwrap();
        assert!(tokens.iter().all(|t| *t != fifth.token));

        // Full again. One save goes quiet past STALE_AFTER (its page was
        // reloaded mid-export): the next begin reaps it, its `.part` with it,
        // and the live ones are untouched.
        let stale = tokens[2];
        {
            let e = saves.entry(stale).unwrap();
            let mut p = lock(&e);
            p.touched = Instant::now().checked_sub(STALE_AFTER + Duration::from_secs(1)).unwrap();
        }
        let sixth = begin_user(&saves, &dir.join("p6.png"), ImageFormat::Png, 16).unwrap();
        assert!(saves.entry(stale).is_none());
        assert!(!dir.join("p2.png.taroting-part").exists());
        for live in [tokens[0], tokens[3], fifth.token, sixth.token] {
            assert!(saves.entry(live).is_some(), "{live}");
        }
        // The reaped save gave up its `.part` claim with its slot.
        saves.abort(sixth.token);
        begin_user(&saves, &dir.join("p2.png"), ImageFormat::Png, 16).expect("a reaped save's name is free again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two pastes open at once never share a name: the first reserves its
    /// `.part` before the second looks.
    #[test]
    fn concurrent_pastes_get_different_names() {
        let dir = scratch("paste-flow").join("Pasted images");
        let saves = ImageSaves::default();
        let paste = || saves.begin(ImageFormat::Png, PNG.len() as u64, || resolve_pasted(&dir, "Card", ImageFormat::Png));
        let a = paste().unwrap();
        let b = paste().unwrap();
        assert_eq!(a.path, dir.join("Card pasted 1.png").to_string_lossy());
        assert_eq!(b.path, dir.join("Card pasted 2.png").to_string_lossy());
        for t in [a.token, b.token] {
            saves.chunk(t, PNG).unwrap();
            saves.commit(t).unwrap();
        }
        assert_eq!(names_in(&dir), ["Card pasted 1.png", "Card pasted 2.png"]);
        assert!(msg(saves.begin(ImageFormat::Jpeg, 16, || resolve_pasted(&dir, "Card", ImageFormat::Jpeg)))
            .contains("PNG"));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_project_card_is_a_small_jpeg_named_by_id() {
        let dir = scratch("card");
        let saves = ImageSaves::default();
        let card = |id: &str, f: ImageFormat, total: u64| {
            saves.begin(f, total, || resolve_thumb(&dir, r"C:\P\Pic.trt", id, f))
        };
        assert!(msg(card("p-9", ImageFormat::Png, 16)).contains("JPEG"));
        assert!(msg(card("..\\x", ImageFormat::Jpeg, 16)).contains("id"));
        assert!(msg(card("p-9", ImageFormat::Jpeg, MAX_THUMB_BYTES + 1)).contains("1 to 1048576"));
        let b = card("p-9", ImageFormat::Jpeg, JPEG.len() as u64).unwrap();
        assert_eq!(b.path, dir.join(PIC_CARD).to_string_lossy());
        saves.chunk(b.token, JPEG).unwrap();
        let (_, recent) = saves.commit(b.token).unwrap();
        assert_eq!(recent.as_deref(), Some(r"C:\P\Pic.trt"));
        assert_eq!(names_in(&dir), [PIC_CARD]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Card bytes that differ per save, so the file on disk says WHICH save
    /// landed, not just that one did.
    fn card_bytes(tag: u8) -> Vec<u8> {
        JPEG.iter().copied().chain([tag; 9]).collect()
    }

    /// A second card for one project while the first still streams: the newer
    /// card supersedes the older one, whose late chunk and commit are refused
    /// and can neither empty nor delete the newer `.part`.
    #[test]
    fn a_newer_card_supersedes_an_older_one_for_the_same_project() {
        let dir = scratch("card-twice");
        let saves = ImageSaves::default();
        let card = |total: u64| saves.begin(ImageFormat::Jpeg, total, || resolve_thumb(&dir, r"C:\P\Pic.trt", "p-9", ImageFormat::Jpeg));
        let (a_bytes, b_bytes) = (card_bytes(0xAA), card_bytes(0xBB));

        // A has written every byte and is only waiting to commit.
        let a = card(a_bytes.len() as u64).unwrap();
        saves.chunk(a.token, &a_bytes).unwrap();
        let b = card(b_bytes.len() as u64).unwrap();
        assert_ne!(a.token, b.token);
        assert!(msg(saves.chunk(a.token, &[0])).contains("unknown"), "A is over");
        assert!(msg(saves.commit(a.token)).contains("unknown"));
        assert_eq!(names_in(&dir), [format!("{PIC_CARD}.taroting-part")], "B's .part survives A's late calls");
        saves.chunk(b.token, &b_bytes).unwrap();
        saves.commit(b.token).unwrap();
        assert_eq!(std::fs::read(dir.join(PIC_CARD)).unwrap(), b_bytes);

        // The narrower race: A's commit has already taken it out of the token
        // map when B begins. B still supersedes it, and A's commit, finishing
        // after, fails without removing the `.part` B now owns.
        let a = card(a_bytes.len() as u64).unwrap();
        saves.chunk(a.token, &a_bytes).unwrap();
        let committing = saves.take(a.token).unwrap();
        let b = card(b_bytes.len() as u64).unwrap();
        assert!(msg(saves.finish(a.token, &committing)).contains("already finished"));
        saves.chunk(b.token, &b_bytes).unwrap();
        saves.commit(b.token).unwrap();
        assert_eq!(std::fs::read(dir.join(PIC_CARD)).unwrap(), b_bytes);
        assert_eq!(names_in(&dir), [PIC_CARD]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A second export to a file a save is already writing is refused — also
    /// in another spelling — and the first lands intact. Once it has, the
    /// name is free again.
    #[test]
    fn a_second_save_to_one_export_is_refused() {
        let dir = scratch("user-twice");
        let target = dir.join("Card (edited).jpg");
        let saves = ImageSaves::default();
        let body = card_bytes(0x5A);
        let first = begin_user(&saves, &target, ImageFormat::Jpeg, body.len() as u64).unwrap();
        saves.chunk(first.token, &body).unwrap();
        assert_eq!(
            msg(begin_user(&saves, &target, ImageFormat::Jpeg, 16)),
            "that file is already being saved"
        );
        let shouted = dir.join("CARD (EDITED).JPG");
        assert_eq!(msg(begin_user(&saves, &shouted, ImageFormat::Jpeg, 16)), "that file is already being saved");
        saves.commit(first.token).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), body);
        assert_eq!(names_in(&dir), ["Card (edited).jpg"]);

        let again = begin_user(&saves, &target, ImageFormat::Jpeg, body.len() as u64).expect("free once committed");
        saves.abort(again.token);
        let last = begin_user(&saves, &target, ImageFormat::Jpeg, 16).expect("free once aborted");
        saves.abort(last.token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The chunk command's own path: a JSON body (an array of numbers, not raw
    /// bytes) ends the save it names — `.part` gone, token forgotten — and a
    /// raw one appends.
    #[test]
    fn a_json_chunk_body_ends_its_save() {
        let dir = scratch("json-body");
        let saves = ImageSaves::default();
        let b = begin_user(&saves, &dir.join("a.png"), ImageFormat::Png, 64).unwrap();
        chunk_body(&saves, b.token, owned_body(&InvokeBody::Raw(PNG.to_vec()))).unwrap();
        assert_eq!(names_in(&dir), ["a.png.taroting-part"]);
        let json = InvokeBody::Json(json!([137, 80, 78, 71]));
        assert_eq!(msg(chunk_body(&saves, b.token, owned_body(&json))), "image bytes must arrive as a raw body");
        assert!(names_in(&dir).is_empty());
        assert!(saves.entry(b.token).is_none());
        assert!(msg(chunk_body(&saves, b.token, owned_body(&InvokeBody::Raw(PNG.to_vec())))).contains("unknown"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
