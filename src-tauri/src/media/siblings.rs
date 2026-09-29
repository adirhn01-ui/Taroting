//! A media file's neighbours in its own folder, in Explorer's natural name
//! order, for the viewer's previous/next. Bounded by a radius on each side so a
//! folder of thousands of photos never crosses the IPC boundary whole.
//!
//! One `read_dir` and one pass: two heaps of at most `radius` names each, never
//! a sorted copy of the folder. Nothing is resident between calls — no cache,
//! no watcher — so a viewer that is not open costs exactly nothing.

use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::fs::DirEntry;
use std::path::Path;

use crate::error::{AppError, Result};
use crate::media::extensions::{family_of_ext, step_family, StepFamily};
use crate::project::store::{path_identity, PathIdentity};

/// Mirrors `SiblingWindow` in src/core/ipc.ts, field for field.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiblingWindow {
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub index: Option<u32>,
    pub total: u32,
    pub family: crate::media::extensions::StepFamily,
}

/// The most neighbours returned on each side, whatever the caller asks for.
const MAX_RADIUS: u32 = 32;

/// `radius` clamped to 1..=32. async + spawn_blocking.
///
/// A folder scan is blocking I/O of unbounded length (a network share, a
/// folder of ten thousand photos), so it never runs on the IPC thread.
#[tauri::command]
pub async fn list_siblings(path: String, radius: u32) -> Result<SiblingWindow> {
    tauri::async_runtime::spawn_blocking(move || list_sync(&path, radius))
        .await
        .map_err(|e| AppError::BadInput(format!("folder scan failed: {e}")))?
}

fn bad<T>(msg: &str) -> Result<T> {
    Err(AppError::BadInput(msg.into()))
}

/// `\\.\` names a device (a volume, a pipe, COM1), not a file. Rust's own
/// prefix parser accepts either separator there, so `//./` is the same thing
/// in disguise and is refused the same way.
fn is_device_path(path: &str) -> bool {
    path.chars()
        .take(4)
        .map(|c| if c == '/' { '\\' } else { c })
        .eq(r"\\.\".chars())
}

/// Whether an absolute path lives on a drive or a share — the only places a
/// media file does. `\\?\` is a door into the whole object namespace, not
/// just into files: `\\?\pipe\` lists the machine's named pipes and
/// `\\?\GLOBALROOT\` reaches raw devices, and the viewer has no business
/// scanning either. So the prefix is allow-listed (`C:\`, `\\server\share\`
/// and their `\\?\` spellings) rather than the bad ones deny-listed.
#[cfg(windows)]
fn is_file_namespace(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(p)) => matches!(
            p.kind(),
            Prefix::Disk(_) | Prefix::UNC(..) | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..)
        ),
        _ => false,
    }
}

fn list_sync(path: &str, radius: u32) -> Result<SiblingWindow> {
    // Every refusal names what the caller sent, never a guess at what it
    // meant: the family, the folder and the file all come from `path` itself.
    if path.is_empty() {
        return bad("no file was given");
    }
    if path.contains('\0') {
        return bad("the file path is not valid");
    }
    if is_device_path(path) {
        return bad("a device path is not a media file");
    }
    let current_path = Path::new(path);
    // A relative path would resolve against the process CWD — whatever folder
    // the app happened to be launched from — and list the wrong neighbours.
    if !current_path.is_absolute() {
        return bad("the file path must be absolute");
    }
    #[cfg(windows)]
    if !is_file_namespace(current_path) {
        return bad("a device path is not a media file");
    }
    let Some(current) = current_path.file_name().and_then(|n| n.to_str()) else {
        return bad("the path does not name a file");
    };
    let Some(family) = ext_family(current) else {
        return bad("not a media file");
    };
    let Some(parent) = current_path.parent() else {
        return bad("the file has no folder");
    };

    let cap = radius.clamp(1, MAX_RADIUS) as usize;
    let current_wide = wide_of(current);
    let current = Spelling {
        name: current,
        wide: &current_wide,
    };

    // `below` keeps the `cap` GREATEST names under the current one (a
    // min-heap, so its root is the first to be displaced); `above` keeps the
    // `cap` SMALLEST names over it (a max-heap, likewise).
    let mut below: BinaryHeap<Reverse<Key>> = BinaryHeap::with_capacity(cap + 1);
    let mut above: BinaryHeap<Key> = BinaryHeap::with_capacity(cap + 1);
    let mut count_below = 0usize;
    let mut total = 0usize;
    let mut found = false;
    // One scratch spelling for every entry; a name is copied out only when it
    // actually enters a heap.
    let mut buf: Vec<u16> = Vec::new();

    for entry in std::fs::read_dir(parent)? {
        // An entry that vanished or cannot be read mid-scan is simply not a
        // neighbour; the rest of the folder still is.
        let Ok(entry) = entry else { continue };
        // Lossless names only: this one leaves the process as JSON and comes
        // back as a path to open, and a U+FFFD would name a file that does
        // not exist (os.rs `push_os_if_file`, same doctrine).
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // AppleDouble sidecars (`._IMG_1.JPG`) carry a media extension and
        // hold no media: a Mac-written USB stick is full of them.
        if name.starts_with("._") {
            continue;
        }
        if ext_family(&name) != Some(family) {
            continue;
        }
        if !is_listable_file(&entry) {
            continue;
        }
        total += 1;
        if name == current.name {
            found = true;
            continue;
        }
        fill_wide(&mut buf, &name);
        let this = Spelling {
            name: &name,
            wide: &buf,
        };
        let logical = logical_cmp(this, current);
        // Natural order folds case, so `CLIP2.MP4` (a CLI launch, a hand-typed
        // path) ties with `clip2.mp4` on disk. Only the filesystem can say
        // whether that is the same file or a case-sensitive folder's twin —
        // and listing the current file as its own neighbour would make "next"
        // open what is already on screen. `Unknown` is not proof: it lists.
        if logical == Ordering::Equal
            && path_identity(&parent.join(&name), current_path) == PathIdentity::Same
        {
            found = true;
            continue;
        }
        // Distinct names always differ ordinally, so this is never Equal.
        if logical.then_with(|| this.wide.cmp(current.wide)) == Ordering::Less {
            count_below += 1;
            if below.len() >= cap {
                let displaces = below
                    .peek()
                    .is_some_and(|Reverse(k)| total_cmp(this, k.spelling()) == Ordering::Greater);
                if !displaces {
                    continue;
                }
                below.pop();
            }
            below.push(Reverse(Key::from(this)));
        } else {
            if above.len() >= cap {
                let displaces = above
                    .peek()
                    .is_some_and(|k| total_cmp(this, k.spelling()) == Ordering::Less);
                if !displaces {
                    continue;
                }
                above.pop();
            }
            above.push(Key::from(this));
        }
    }

    // Both sides come out of the heaps' OWN sort, never `slice::sort`: the
    // order is not transitive (see `total_cmp`), and the std slice sorts
    // detect that and panic — which `panic = "abort"` turns into the whole app
    // dying on a folder of `01`/`①`/`1a` names. The heap sort only ever asks
    // one pair at a time and cannot notice. `below` holds `Reverse` keys, so
    // its ascending order is the names' descending one: flip it back.
    let mut before: Vec<Key> = below
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse(k)| k)
        .collect();
    before.reverse();
    let after = above.into_sorted_vec();
    // The caller's own spelling of the folder, never canonicalized: the cache
    // key (MediaKey) hashes the exact string, so a `\\?\`-rewritten path would
    // be a different file to it.
    let to_paths = |keys: Vec<Key>| -> Vec<String> {
        keys.into_iter()
            .filter_map(|k| parent.join(k.name).into_os_string().into_string().ok())
            .collect()
    };
    Ok(SiblingWindow {
        before: to_paths(before),
        after: to_paths(after),
        index: found.then(|| u32::try_from(count_below + 1).unwrap_or(u32::MAX)),
        total: u32::try_from(total).unwrap_or(u32::MAX),
        family,
    })
}

/// The step family of a file name's extension, or `None` when it is not media.
///
/// Everything after the LAST dot, exactly as the frontend's `fileExt` reads
/// it — not `Path::extension`, which calls `.mp4` a stem with no extension.
/// The two must agree on every name, or a file the frontend routes to the
/// viewer is refused here and never appears as anyone's neighbour.
fn ext_family(name: &str) -> Option<StepFamily> {
    let (_, ext) = name.rsplit_once('.')?;
    family_of_ext(ext).map(step_family)
}

/// Whether a media-named entry is a plain file the viewer can show. Cheapest
/// test first: the file type and (on Windows) the attributes both come from
/// the directory listing itself; only a symlink costs a second look.
fn is_listable_file(entry: &DirEntry) -> bool {
    let Ok(file_type) = entry.file_type() else {
        return false;
    };
    // A folder named `x.mp4` is not a video. (A junction or a symlinked
    // folder reports as a symlink, never as a dir — the follow below drops it.)
    if file_type.is_dir() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Hidden and system files are what Explorer hides by default —
        // `desktop.ini`'s cousins, a thumbnail cache named like a JPEG.
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        let hidden = entry.metadata().map_or(true, |m| {
            m.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
        });
        if hidden {
            return false;
        }
    }
    if file_type.is_symlink() {
        // Follow it once: a link to a file is that file, a dangling link or a
        // link to a folder is nothing to show.
        return std::fs::metadata(entry.path()).is_ok_and(|m| m.is_file());
    }
    file_type.is_file()
}

/// A name and its UTF-16 spelling, NUL-terminated for `StrCmpLogicalW`. The
/// names are valid UTF-8 (`into_string` succeeded), so `encode_utf16` here is
/// exactly the OS's own wide spelling.
#[derive(Clone, Copy)]
struct Spelling<'a> {
    name: &'a str,
    wide: &'a [u16],
}

/// An owned `Spelling`, as held in the heaps.
struct Key {
    name: String,
    wide: Vec<u16>,
}

impl Key {
    fn spelling(&self) -> Spelling<'_> {
        Spelling {
            name: &self.name,
            wide: &self.wide,
        }
    }
}

impl From<Spelling<'_>> for Key {
    fn from(s: Spelling<'_>) -> Self {
        Key {
            name: s.name.to_owned(),
            wide: s.wide.to_vec(),
        }
    }
}

impl Ord for Key {
    fn cmp(&self, other: &Self) -> Ordering {
        total_cmp(self.spelling(), other.spelling())
    }
}
impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for Key {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Key {}

fn fill_wide(buf: &mut Vec<u16>, name: &str) {
    buf.clear();
    buf.extend(name.encode_utf16());
    buf.push(0);
}

fn wide_of(name: &str) -> Vec<u16> {
    let mut v = Vec::with_capacity(name.len() + 1);
    fill_wide(&mut v, name);
    v
}

/// The order the viewer steps in. Natural order alone ties distinct names —
/// it folds case, so `a.png` and `A.png` (both present in a case-sensitive
/// folder) compare equal. The ordinal UTF-16 tie-break makes the order
/// ANTISYMMETRIC (two distinct names are never Equal, and swapping them flips
/// the answer) and leaves natural order untouched wherever it decides.
///
/// It is NOT transitive, and nothing here can make it so: StrCmpLogicalW
/// itself is not (measured: `02` < `①` < `1a`, yet `02` > `1a`; pinned by
/// `natural_order_is_not_transitive`). So a `Key`
/// must NEVER reach `slice::sort`/`sort_by`/`sort_unstable*`, `binary_search`,
/// a `BTreeMap`/`BTreeSet` or `dedup_by`: the slice sorts check for exactly
/// this and panic. `BinaryHeap` push/pop/`into_sorted_vec` compare one pair at
/// a time and never check, so they are the only consumers.
fn total_cmp(a: Spelling<'_>, b: Spelling<'_>) -> Ordering {
    logical_cmp(a, b).then_with(|| a.wide.cmp(b.wide))
}

/// Explorer's own default name order ("clip2" before "clip10", case folded).
/// It is the only order a user has already seen this folder in.
#[cfg(windows)]
fn logical_cmp(a: Spelling<'_>, b: Spelling<'_>) -> Ordering {
    use windows_sys::Win32::UI::Shell::StrCmpLogicalW;
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call
    // (`fill_wide` always pushes the terminator); the function only reads
    // them. A NUL inside a name (refused for the current path, impossible in
    // a directory entry) would merely end the comparison early.
    let r = unsafe { StrCmpLogicalW(a.wide.as_ptr(), b.wide.as_ptr()) };
    r.cmp(&0)
}

#[cfg(not(windows))]
fn logical_cmp(a: Spelling<'_>, b: Spelling<'_>) -> Ordering {
    natural_cmp(a.name, b.name)
}

/// A portable approximation of `StrCmpLogicalW`, for the platforms that do
/// not have it: ASCII digit runs compare by value (a numerically equal run
/// with MORE leading zeros first, as Explorer puts `x010` before `x10`);
/// anything else compares punctuation < digits < letters, then by lowercase.
///
/// It does NOT reproduce Windows' word sort, which gives `-` and `'` almost
/// no weight (Explorer: `a_b` < `ab` < `a-b`). Pinned against the real thing
/// in `fallback_comparator_agrees_with_strcmplogicalw`, minus those rows.
#[cfg(any(not(windows), test))]
fn natural_cmp(a: &str, b: &str) -> Ordering {
    fn class(c: char) -> u8 {
        if c.is_ascii_digit() {
            1
        } else if c.is_alphanumeric() {
            2
        } else {
            0
        }
    }
    fn digit_run(s: &str) -> (&str, &str) {
        s.split_at(s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()))
    }
    let (mut a, mut b) = (a, b);
    loop {
        let (Some(x), Some(y)) = (a.chars().next(), b.chars().next()) else {
            // One ran out: the shorter (a prefix of the other) comes first.
            return a.len().cmp(&b.len());
        };
        if x.is_ascii_digit() && y.is_ascii_digit() {
            let ((ra, rest_a), (rb, rest_b)) = (digit_run(a), digit_run(b));
            let (va, vb) = (ra.trim_start_matches('0'), rb.trim_start_matches('0'));
            // Value first (length, then digits — no parse, so no overflow on a
            // 40-digit run), then the zero-padded spelling first.
            let ord = va
                .len()
                .cmp(&vb.len())
                .then_with(|| va.cmp(vb))
                .then_with(|| rb.len().cmp(&ra.len()));
            if ord != Ordering::Equal {
                return ord;
            }
            (a, b) = (rest_a, rest_b);
            continue;
        }
        let ord = class(x)
            .cmp(&class(y))
            .then_with(|| x.to_lowercase().cmp(y.to_lowercase()));
        if ord != Ordering::Equal {
            return ord;
        }
        (a, b) = (&a[x.len_utf8()..], &b[y.len_utf8()..]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A throwaway folder of empty files, removed before use and on drop (so a
    /// failed assertion does not strand it). Empty is deliberate: a 0-byte
    /// `.mp4` must still be listed — the viewer, not the scan, says it cannot
    /// be shown.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(test: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("taroting-sib-{}-{}", std::process::id(), test));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn files(&self, names: &[&str]) {
            for n in names {
                std::fs::write(self.0.join(n), b"").unwrap();
            }
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_string()
        }
        fn list(&self, current: &str, radius: u32) -> SiblingWindow {
            list_sync(&self.path(current), radius).unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(paths: &[String]) -> Vec<&str> {
        paths
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_str().unwrap())
            .collect()
    }

    fn bad_input(path: &str) -> String {
        match list_sync(path, 8) {
            Err(AppError::BadInput(m)) => m,
            other => panic!("{path:?}: expected BadInput, got {other:?}"),
        }
    }

    #[test]
    fn natural_order_window() {
        let s = Scratch::new("natural");
        // Lexical order would put clip10 before clip2, and ordinal order would
        // put `Clip11`/`IMG_7` ahead of every lowercase name — each axis a
        // wrong comparator could take gives a different answer here.
        s.files(&[
            "clip2.mp4",
            "clip10.mp4",
            "Clip11.mov",
            "d.gif",
            "IMG_7.JPG",
            "z still.png",
            "a1.mp3",
            "notes.txt",
        ]);
        std::fs::create_dir(s.0.join("sub.mp4")).unwrap();
        let w = s.list("clip10.mp4", 16);
        // Full paths: the caller's folder spelling joined to the disk name.
        assert_eq!(w.before, vec![s.path("clip2.mp4")]);
        assert_eq!(
            w.after,
            vec![
                s.path("Clip11.mov"),
                s.path("d.gif"),
                s.path("IMG_7.JPG"),
                s.path("z still.png")
            ]
        );
        assert_eq!(w.index, Some(2));
        assert_eq!(w.total, 6);
        assert_eq!(w.family, StepFamily::Visual);
    }

    #[test]
    fn radius_bounds_the_payload() {
        let s = Scratch::new("radius");
        let all: Vec<String> = (1..=40).map(|i| format!("f{i}.png")).collect();
        s.files(&all.iter().map(String::as_str).collect::<Vec<_>>());

        let w = s.list("f20.png", 3);
        assert_eq!(names(&w.before), ["f17.png", "f18.png", "f19.png"]);
        assert_eq!(names(&w.after), ["f21.png", "f22.png", "f23.png"]);
        assert_eq!((w.index, w.total), (Some(20), 40));

        // 0 is clamped UP to one neighbour a side, never an empty window.
        let w = s.list("f20.png", 0);
        assert_eq!(
            (names(&w.before), names(&w.after)),
            (vec!["f19.png"], vec!["f21.png"])
        );

        // A huge radius is clamped DOWN to 32: f1 has 39 names above it.
        let w = s.list("f1.png", 1000);
        let want: Vec<String> = (2..=33).map(|i| format!("f{i}.png")).collect();
        assert_eq!(names(&w.after), want);
        assert!(w.before.is_empty());
        assert_eq!((w.index, w.total), (Some(1), 40));
    }

    #[test]
    fn audio_walks_only_audio() {
        let s = Scratch::new("audio");
        s.files(&["a1.mp3", "a2.wav", "clip2.mp4"]);
        let w = s.list("a1.mp3", 16);
        assert!(w.before.is_empty());
        assert_eq!(names(&w.after), ["a2.wav"]);
        assert_eq!(
            (w.index, w.total, w.family),
            (Some(1), 2, StepFamily::Audio)
        );
    }

    #[test]
    fn unusual_names_round_trip_exactly() {
        let s = Scratch::new("unusual");
        let odd = ["it's a clip.mp4", "Ünïcode ☕ 2.jpg", "Ünïcode ☕ 10.jpg"];
        s.files(&odd);
        let w = s.list("Ünïcode ☕ 2.jpg", 16);
        assert_eq!(names(&w.before), ["it's a clip.mp4"]);
        assert_eq!(names(&w.after), ["Ünïcode ☕ 10.jpg"]);
        assert_eq!((w.index, w.total), (Some(2), 3));
    }

    #[cfg(windows)]
    #[test]
    fn hidden_system_and_appledouble_are_skipped() {
        use std::os::windows::fs::OpenOptionsExt;
        let s = Scratch::new("hidden");
        s.files(&["v1.mp4", "v2.mp4", "._c.mp4"]);
        for (name, attr) in [("h.mp4", 0x2), ("s.mp4", 0x4)] {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .attributes(attr)
                .open(s.0.join(name))
                .unwrap();
        }
        // All three sort before v1, so any one leaking lands in `before`.
        let w = s.list("v1.mp4", 16);
        assert!(w.before.is_empty(), "leaked: {:?}", w.before);
        assert_eq!(names(&w.after), ["v2.mp4"]);
        assert_eq!((w.index, w.total), (Some(1), 2));

        // A hidden CURRENT file is filtered like any other: no index, and its
        // neighbours come from where it would have sorted.
        let w = s.list("h.mp4", 16);
        assert_eq!(w.index, None);
        assert!(w.before.is_empty());
        assert_eq!(names(&w.after), ["v1.mp4", "v2.mp4"]);
        assert_eq!(w.total, 2);
    }

    #[test]
    fn vanished_current_uses_the_insertion_point() {
        let s = Scratch::new("vanished");
        s.files(&["clip2.mp4", "clip10.mp4"]);
        let w = s.list("clip5.mp4", 16);
        assert_eq!(w.index, None);
        assert_eq!(names(&w.before), ["clip2.mp4"]);
        assert_eq!(names(&w.after), ["clip10.mp4"]);
        assert_eq!(w.total, 2, "a file that is not there is not counted");
    }

    #[cfg(windows)]
    #[test]
    fn case_mismatched_current_is_not_its_own_neighbour() {
        let s = Scratch::new("case");
        s.files(&["clip2.mp4", "clip10.mp4"]);
        let w = s.list("CLIP2.MP4", 16);
        assert_eq!(w.index, Some(1));
        assert!(w.before.is_empty(), "{:?}", w.before);
        assert_eq!(
            names(&w.after),
            ["clip10.mp4"],
            "clip2.mp4 IS the current file"
        );
        assert_eq!(w.total, 2);
    }

    /// "Kelvin.png" and "\u{212A}elvin.png" (KELVIN SIGN) are two files on
    /// NTFS, yet StrCmpLogicalW ties them (measured) — the one tie only the
    /// filesystem can break. Both answers other than `Same` must list.
    #[cfg(windows)]
    #[test]
    fn a_natural_order_tie_that_is_another_file_is_listed() {
        let s = Scratch::new("kelvin");
        s.files(&["Kelvin.png", "z.png"]);
        let kelvin_sign = "\u{212A}elvin.png";

        // Unknown: the current file is not on disk, so identity cannot be
        // proven — Kelvin.png is a neighbour, not the current file.
        let w = s.list(kelvin_sign, 16);
        assert_eq!(w.index, None);
        assert_eq!(names(&w.before), ["Kelvin.png"]);
        assert_eq!(w.total, 2);

        // Different: both exist; the ordinal tie-break puts K (U+004B) first.
        s.files(&[kelvin_sign]);
        let w = s.list(kelvin_sign, 16);
        assert_eq!(w.index, Some(2));
        assert_eq!(names(&w.before), ["Kelvin.png"]);
        assert_eq!(names(&w.after), ["z.png"]);
        assert_eq!(w.total, 3);
    }

    #[test]
    fn rejects_relative_empty_device_and_non_media() {
        let s = Scratch::new("rejects");
        s.files(&["clip.mp4", "notes.txt"]);
        // Each message is asserted, so each case can only pass on its own
        // check: with the device test removed, `\\.\C:\clip.mp4` is absolute
        // and media-named and would go on to scan the volume.
        assert!(bad_input("").contains("no file"));
        assert!(bad_input("clip.mp4").contains("absolute"));
        assert!(bad_input(r"\\.\C:\clip.mp4").contains("device"));
        assert!(bad_input("//./C:/clip.mp4").contains("device"));
        assert!(bad_input(&s.path("notes.txt")).contains("not a media file"));
        assert!(bad_input("C:\\clip\0.mp4").contains("not valid"));
    }

    #[test]
    fn missing_parent_is_io() {
        let s = Scratch::new("missing");
        let path = s.0.join("gone").join("clip.mp4");
        match list_sync(path.to_str().unwrap(), 8) {
            Err(AppError::Io(e)) => assert_eq!(e.kind(), std::io::ErrorKind::NotFound),
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_paths_are_listed_in_their_own_spelling() {
        let s = Scratch::new("verbatim");
        s.files(&["b1.png", "b2.png"]);
        let verbatim = format!(r"\\?\{}", s.path("b1.png"));
        let w = list_sync(&verbatim, 4).unwrap();
        assert_eq!(w.after, vec![format!(r"\\?\{}", s.path("b2.png"))]);
        assert_eq!(w.index, Some(1));
    }

    #[test]
    fn tie_break_makes_case_only_twins_antisymmetric() {
        let (a, b) = (wide_of("a.png"), wide_of("A.png"));
        let (a, b) = (
            Spelling {
                name: "a.png",
                wide: &a,
            },
            Spelling {
                name: "A.png",
                wide: &b,
            },
        );
        // Natural order alone calls them equal — that is the hazard...
        assert_eq!(logical_cmp(a, b), Ordering::Equal);
        // ...and the tie-break makes it a strict, antisymmetric order.
        assert_eq!(total_cmp(a, b), Ordering::Greater);
        assert_eq!(total_cmp(b, a), Ordering::Less);
        assert_eq!(total_cmp(a, a), Ordering::Equal);
    }

    /// `.mp4` is a video to the frontend's `fileExt` (everything after the
    /// last dot), so it is routed to the viewer; the scan must agree, both for
    /// the current file and for a neighbour — `Path::extension` would say
    /// "no extension" and refuse it.
    #[test]
    fn a_dot_named_file_is_media_like_the_frontend_says() {
        let s = Scratch::new("dotname");
        s.files(&[".mp4", "clip.mp4"]);
        let w = s.list(".mp4", 16);
        assert_eq!(w.index, Some(1));
        assert_eq!(names(&w.after), ["clip.mp4"]);
        assert_eq!(w.total, 2);
        let w = s.list("clip.mp4", 16);
        assert_eq!(names(&w.before), [".mp4"]);
        assert_eq!((w.index, w.total), (Some(2), 2));
        // Still nothing after a trailing dot, and still no dot at all.
        assert!(bad_input(&s.path("clip.")).contains("not a media file"));
        assert!(bad_input(&s.path("mp4")).contains("not a media file"));
    }

    /// Only a drive or a share is a place media lives. The `\\?\` spellings
    /// of both stay allowed (`verbatim_paths_are_listed_in_their_own_spelling`
    /// scans one); every other object-namespace door is refused before any
    /// `read_dir` — `\\?\pipe\` would otherwise list the named pipes.
    #[cfg(windows)]
    #[test]
    fn only_drive_and_share_prefixes_are_scanned() {
        for p in [
            r"\\?\pipe\clip.mp4",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\clip.mp4",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\clip.mp4",
        ] {
            assert!(bad_input(p).contains("device"), "{p}");
        }
        for p in [
            r"C:\clip.mp4",
            r"\\server\share\clip.mp4",
            r"\\?\C:\clip.mp4",
            r"\\?\UNC\server\share\clip.mp4",
        ] {
            assert!(is_file_namespace(Path::new(p)), "{p}");
        }
        for p in [r"\\.\C:\clip.mp4", r"\\?\pipe\clip.mp4", r"\clip.mp4"] {
            assert!(!is_file_namespace(Path::new(p)), "{p}");
        }
    }

    /// The doc on `total_cmp` claims the order is not transitive; this pins
    /// that claim to the real StrCmpLogicalW rather than to a comment.
    #[cfg(windows)]
    #[test]
    fn natural_order_is_not_transitive() {
        let names = ["02", "\u{2460}", "1a"];
        let wides: Vec<Vec<u16>> = names.iter().map(|n| wide_of(n)).collect();
        let sp = |i: usize| Spelling {
            name: names[i],
            wide: &wides[i],
        };
        assert_eq!(total_cmp(sp(0), sp(1)), Ordering::Less);
        assert_eq!(total_cmp(sp(1), sp(2)), Ordering::Less);
        assert_eq!(total_cmp(sp(0), sp(2)), Ordering::Greater);
    }

    /// The crash this order used to cause: 24 names below the current one,
    /// radius 32, so all 24 land in `below` and have to come out sorted. With
    /// `slice::sort` there, std's order check panicked on exactly this set —
    /// in a release build (`panic = "abort"`) that is the app dying the moment
    /// the viewer opens a photo in such a folder. Windows only: the set is
    /// intransitive under StrCmpLogicalW specifically; the portable fallback
    /// comparator orders `①` after letters, so the expected window differs.
    #[cfg(windows)]
    #[test]
    fn an_intransitive_folder_does_not_crash_the_scan() {
        let s = Scratch::new("intransitive");
        let mut want: Vec<String> = Vec::new();
        for i in 1..=8u32 {
            let circled = char::from_u32(0x2460 + i - 1).unwrap();
            want.push(format!("0{i}.png"));
            want.push(format!("{circled}.png"));
            want.push(format!("{i}a.png"));
        }
        s.files(&want.iter().map(String::as_str).collect::<Vec<_>>());
        s.files(&["zz.png"]);
        let w = s.list("zz.png", 32);
        assert_eq!((w.index, w.total), (Some(25), 25));
        assert!(w.after.is_empty());
        // No "ascending" exists for this set to check against; every
        // neighbour must simply be there exactly once.
        let mut got: Vec<&str> = names(&w.before);
        got.sort_unstable();
        let mut want: Vec<&str> = want.iter().map(String::as_str).collect();
        want.sort_unstable();
        assert_eq!(got, want);
    }

    #[cfg(windows)]
    #[test]
    fn fallback_comparator_agrees_with_strcmplogicalw() {
        // Signs measured from StrCmpLogicalW on Windows 11 26200, and asserted
        // for BOTH comparators, both ways round. Deliberately absent: `a-b` vs
        // `a_b` — Windows' word sort gives `-` near-zero weight (`a_b` < `ab`
        // < `a-b`), which the portable fallback does not imitate.
        let table: &[(&str, &str, Ordering)] = &[
            ("x2", "x10", Ordering::Less),
            ("x010", "x10", Ordering::Less),
            ("x01", "x1", Ordering::Less),
            ("x1y", "x01y", Ordering::Greater),
            ("photo (2)", "photo (10)", Ordering::Less),
            ("clip10.mp4", "Clip11.mov", Ordering::Less),
            ("a1", "a_", Ordering::Greater),
            ("a.b", "a_b", Ordering::Less),
            ("a b", "a_b", Ordering::Less),
            ("a1", "aa", Ordering::Less),
            ("a", "a1", Ordering::Less),
            ("a0", "a", Ordering::Greater),
            ("a.png", "A.png", Ordering::Equal),
        ];
        for &(x, y, want) in table {
            let (wx, wy) = (wide_of(x), wide_of(y));
            let (sx, sy) = (
                Spelling { name: x, wide: &wx },
                Spelling { name: y, wide: &wy },
            );
            assert_eq!(logical_cmp(sx, sy), want, "StrCmpLogicalW({x:?}, {y:?})");
            assert_eq!(
                logical_cmp(sy, sx),
                want.reverse(),
                "StrCmpLogicalW({y:?}, {x:?})"
            );
            assert_eq!(natural_cmp(x, y), want, "fallback({x:?}, {y:?})");
            assert_eq!(natural_cmp(y, x), want.reverse(), "fallback({y:?}, {x:?})");
        }
    }
}
