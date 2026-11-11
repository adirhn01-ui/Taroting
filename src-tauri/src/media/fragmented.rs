//! Whether an MP4/MOV is FRAGMENTED: its `moov` holds an `mvex` box and its
//! samples live in `moof`+`mdat` fragments after it (what OBS writes, and
//! ffmpeg's `-movflags frag_keyframe`), rather than in one set of sample
//! tables inside the `moov`.
//!
//! WHY: measured on WebView2 157 with the owner's OBS recording, a seek
//! during a fast drag while such a file plays raises MediaError 2
//! ("PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer seek failed"); ordinary MP4s
//! never did. So the preview plays a fragmented file from a stream-copied,
//! non-fragmented copy (`playability::Decision::Defragment`), and the engine
//! never sees the layout. Export, thumbnails, waveforms and the damage scan
//! keep reading the original.
//!
//! Read with `damage.rs`'s box helpers, headers only: the top-level box
//! headers until `moov`, then the headers of `moov`'s children — never a
//! sample table, so a long recording costs a handful of small reads. An
//! untrusted file in a `panic = "abort"` build: anything that does not add up
//! is `None`, which only means the file plays as it always did.

use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;

use super::damage::{child_types, find_moov, Reader};
use super::source::{is_cloud_placeholder, source_file};

/// Whether a `moov`'s children (their types) include `mvex` — the one test
/// for "fragmented", shared with the two readers that hold a whole `moov`
/// in memory (`damage.rs`, `keyframes.rs`) and so refuse such a file.
pub(super) fn has_mvex<'a>(mut types: impl Iterator<Item = &'a [u8; 4]>) -> bool {
    types.any(|t| t == b"mvex")
}

/// `Some(true)` when `path` is a fragmented MP4/MOV, `Some(false)` when it is
/// an MP4/MOV with a `moov` and no `mvex`, `None` for anything else: not a
/// path a sidecar may open (`media::source::source_file`), a cloud
/// placeholder (reading it would download it), a file another program is
/// still WRITING (a recording in progress, a copy not finished: see
/// `open_settled`), not an MP4/MOV this reads, or malformed.
pub fn is_fragmented(path: &str) -> Option<bool> {
    let src = source_file(path).ok()?;
    if is_cloud_placeholder(src) {
        return None;
    }
    let file = open_settled(src).ok()?;
    let len = file.metadata().ok()?.len();
    fragmented_in(file, len)
}

/// `path` opened for reading, refusing to share it with a WRITER: Windows
/// fails the open with a sharing violation while any other handle on the
/// file has write access — OBS's while it records, Explorer's while it
/// copies. A file still growing is no file to copy from (the copy would
/// stop where the recording is), so it keeps playing as it always did.
/// Readers are shared (the asset protocol, a thumbnail's ffmpeg), and so is
/// delete. The handle lives for the few reads `is_fragmented` makes; a
/// program opening the file for writing in those milliseconds is refused.
fn open_settled(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_DELETE: u32 = 0x4;
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
    }
    options.open(path)
}

/// `is_fragmented` over any seekable bytes of length `len`, so the tests run
/// it on files built in memory.
fn fragmented_in<R: Read + Seek>(source: R, len: u64) -> Option<bool> {
    let mut reader = Reader::new(source, len);
    let (at, body) = find_moov(&mut reader)?;
    let types = child_types(&mut reader, at, body)?;
    Some(has_mvex(types.iter()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;
    use std::path::PathBuf;

    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    fn read(bytes: &[u8]) -> Option<bool> {
        fragmented_in(Cursor::new(bytes.to_vec()), bytes.len() as u64)
    }

    /// The layouts this answers, built in memory: each pair differs in ONE
    /// box, so an answer read from the wrong place shows.
    #[test]
    fn reads_the_layout_from_the_box_headers() {
        let ftyp = bx(b"ftyp", b"isom\0\0\x02\0");
        let mvhd = bx(b"mvhd", &[0; 100]);
        let trak = bx(b"trak", &bx(b"tkhd", &[0; 84]));
        let mvex = bx(b"mvex", &bx(b"trex", &[0; 24]));
        let moof = bx(b"moof", &bx(b"mfhd", &[0; 8]));
        let mdat = bx(b"mdat", &[0x5a; 333]);

        // OBS-like: an empty moov with mvex first, then fragments.
        let frag = [ftyp.clone(), bx(b"moov", &[mvhd.clone(), trak.clone(), mvex.clone()].concat()), moof.clone(), mdat.clone(), moof, mdat.clone()].concat();
        assert_eq!(read(&frag), Some(true));
        // The same file without the mvex: an ordinary MP4.
        let plain = [ftyp.clone(), bx(b"moov", &[mvhd.clone(), trak.clone()].concat()), mdat.clone()].concat();
        assert_eq!(read(&plain), Some(false));
        // moov after the mdat (no faststart): found by walking past it.
        let tail = [ftyp.clone(), mdat.clone(), bx(b"moov", &[mvhd.clone(), mvex.clone(), trak.clone()].concat())].concat();
        assert_eq!(read(&tail), Some(true));
        // An `mvex` that is NOT a child of moov (inside a trak) does not count.
        let nested = [ftyp.clone(), bx(b"moov", &[mvhd.clone(), bx(b"trak", &mvex)].concat()), mdat.clone()].concat();
        assert_eq!(read(&nested), Some(false));
        // No moov at all, a non-MP4, an empty file, a moov whose child runs
        // past it: no answer.
        assert_eq!(read(&[ftyp.clone(), mdat.clone()].concat()), None);
        assert_eq!(read(b"\x1a\x45\xdf\xa3 this is matroska, not an mp4 at all"), None);
        assert_eq!(read(b""), None);
        let mut broken = bx(b"moov", &[mvhd, bx(b"mvex", &[0; 16])].concat());
        let n = broken.len();
        broken[n - 24..n - 20].copy_from_slice(&900u32.to_be_bytes());
        assert_eq!(read(&[ftyp, broken].concat()), None);
    }

    /// The shared predicate the two in-memory readers use.
    #[test]
    fn has_mvex_looks_for_the_box_type_only() {
        assert!(has_mvex([*b"mvhd", *b"trak", *b"mvex"].iter()));
        assert!(!has_mvex([*b"mvhd", *b"trak", *b"mehd"].iter()));
        assert!(!has_mvex(std::iter::empty()));
    }

    /// A moov of more children than a real one ever has is not walked.
    #[test]
    fn a_moov_of_endless_children_is_refused() {
        let many: Vec<u8> = (0..2000).flat_map(|_| bx(b"free", &[])).collect();
        assert_eq!(read(&bx(b"moov", &many)), None);
        let few: Vec<u8> = (0..20).flat_map(|_| bx(b"free", &[])).collect();
        assert_eq!(read(&bx(b"moov", &few)), Some(false));
    }

    /// A file of the repo's `tests/fixtures` (made by `npm run fixtures`).
    pub(crate) fn repo_fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join(name)
    }

    /// The real files: the generated OBS-like fixture is fragmented, an
    /// ordinary MP4 fixture is not, a Matroska one is no MP4, and a path that
    /// is not a file is no answer.
    #[test]
    fn answers_for_real_files() {
        let frag = repo_fixture("fragmented_h264.mp4");
        let plain = repo_fixture("direct_h264.mp4");
        let mkv = repo_fixture("remux_h264.mkv");
        for f in [&frag, &plain, &mkv] {
            assert!(f.exists(), "{} is missing: run `npm run fixtures`", f.display());
        }
        assert_eq!(is_fragmented(frag.to_str().unwrap()), Some(true));
        assert_eq!(is_fragmented(plain.to_str().unwrap()), Some(false));
        assert_eq!(is_fragmented(mkv.to_str().unwrap()), None);
        assert_eq!(is_fragmented("relative.mp4"), None);
        assert_eq!(is_fragmented("https://example.com/clip.mp4"), None);
    }

    /// A file another handle is still WRITING is no answer (a recording in
    /// progress); the moment that handle closes it is read.
    #[cfg(windows)]
    #[test]
    fn a_file_still_being_written_is_not_answered() {
        let dir = std::env::temp_dir().join(format!("taroting-fragmented-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("recording.mp4");
        let moov = bx(b"moov", &[bx(b"mvhd", &[0; 100]), bx(b"mvex", &[])].concat());
        std::fs::write(&file, [bx(b"ftyp", b"isom\0\0\x02\0"), moov].concat()).unwrap();
        let path = file.to_str().unwrap().to_string();
        {
            // As OBS holds it: open for writing, sharing read and write.
            let _writer = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
            assert_eq!(is_fragmented(&path), None, "still being written");
        }
        // A reader alone (the asset protocol, ffmpeg) does not stop it.
        let _reader = File::open(&file).unwrap();
        let answer = is_fragmented(&path);
        drop(_reader);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(answer, Some(true));
    }
}
