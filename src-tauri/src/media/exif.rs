//! Still-image header sniffing: the EXIF orientation and the coded size, read
//! straight from the file's own header without decoding a pixel.
//!
//! Why this exists: the bundled ffmpeg turns EXIF orientation (JPEG APP1 in
//! either byte order, PNG eXIf, WebP EXIF, TIFF IFD0) into a per-FRAME display
//! matrix and autorotates on decode, while `-show_streams` exposes nothing for
//! a still. So a photo shot in portrait is coded landscape, probes landscape,
//! and decodes portrait — and every consumer of the stored size disagrees with
//! the pixels. This reader decides whether a still needs the (slower)
//! frame-level probe at all — on import (`probe.rs`) and in the load-time
//! repair (`project/store.rs`) alike. It is never the last word on a turn.
//!
//! Hostile-input rules, because a shared `.trt` can point at any file:
//! - Every read is an explicit-offset `read_exact` into a fixed or bounded
//!   buffer. Nothing reads a whole file; a JPEG's Exif segment can carry a
//!   ~64 KB thumbnail before the SOF, and it is SEEKED past, not read.
//! - Every multi-byte field is taken with `get(..)`, never an index, and every
//!   offset sum is `checked_add`. Malformed or truncated input is `None`, never
//!   a panic (`panic = "abort"` would take the whole app down with it).
//! - Segment and chunk walks are capped, so a file of ten thousand empty
//!   chunks costs a bounded number of reads. A walk that hits its cap before
//!   a definitive end is `None`, NOT "orientation 1": it never saw the whole
//!   header, so it has no business vouching that nothing rotates.
//!
//! The byte-level rules mirror what the bundled ffmpeg 8.1.1 was MEASURED to
//! honour, not what the specs say, because the one thing that matters is
//! agreeing with the decoder: an eXIf AFTER the PNG IDAT still rotates, an EXIF
//! chunk in a simple (non-VP8X) WebP still rotates, and an "Exif\0\0" prefix
//! inside a WebP/PNG EXIF payload is rejected ("invalid TIFF header"): the
//! WebP does NOT rotate, and the PNG does not decode at all. A JPEG APP1 is
//! recognised on its first FOUR bytes, "Exif" — ffmpeg skips the next two
//! unread, so "Exif\0\xFF" and "ExifXY" rotate. The orientation is the FIRST
//! 0x0112 entry of type SHORT with a count of at least 1: mistyped and count-0
//! entries are skipped, so a later SHORT decides; the deciding entry's first
//! value is taken, even out of range (which turns nothing) and even when a
//! later entry says otherwise (all measured).
//!
//! What this reader does NOT do is replicate ffmpeg's rejections, and it is
//! knowingly MORE lenient than ffmpeg's parser. ffmpeg drops the whole EXIF
//! block, orientation and all, when an IFD0 entry or an entry in a sub-IFD it
//! follows (Exif, MakerNote) keeps its value past the end of the block, or a
//! sub-IFD's entry table is truncated (measured); this reader walks IFD0's own
//! entry table and nothing else, so on those files it still reports the
//! orientation. So the answers are read like this:
//! - 1..=4 is final, and is only ever given from ONE block whose IFD0 entry
//!   table was read to its end: the orientation it holds, or 1 because the
//!   file carries no EXIF block, or its IFD0 holds no entry the decoder acts
//!   on (none at all, mistyped, count 0, out of range — each measured not to
//!   rotate). A mirror or a half turn keeps both axes, so whether or not
//!   ffmpeg honours it the size is the same, and no frame probe is spent.
//! - 5..=8 is a CANDIDATE, never a verdict: import and the load-time repair
//!   both confirm it with the frame-level ffprobe before transposing anything.
//! - `None` is "not this reader's call". It covers every header it could not
//!   finish (truncated, malformed, a walk past its cap) and every block it
//!   could not read to the end — an unreadable IFD0 is never "no
//!   orientation". The shapes below were each MEASURED to turn the frame
//!   where this reader used to say 1, storing the photo squashed:
//!   - a deciding orientation of count 3+. Its values sit out of line and
//!     ffmpeg follows the offset (6,6,6 at offset 26 rotates, in both byte
//!     orders) — and it decides even ahead of a readable count-1 entry;
//!   - an IFD0 with more than `MAX_IFD_ENTRIES` entries: ffmpeg reads all 300
//!     of one and rotates. (One claiming more entries than its block holds is
//!     unreadable too; ffmpeg drops that block — and turns by the next one);
//!   - a JPEG with MORE THAN ONE Exif APP1 before SOS. ffmpeg honours the
//!     first block it can PARSE: a first block whose IFD0 overruns it, or
//!     whose Make value points past it, is dropped and a second block's 6
//!     rotates — even one written after the SOF — while a first block that
//!     parses with no orientation at all wins, and a second block's 6 does
//!     not. Choosing between blocks IS ffmpeg's rejection logic, which this
//!     reader deliberately does not replicate;
//!   - a PNG with more than one eXIf. ffmpeg keeps the LAST one's bytes
//!     (early 1 then late 6 rotates; two early, 1 then 6, rotates) and
//!     ignores chunk CRCs (a late eXIf with a bad CRC still rotates), so a
//!     tail candidate whose CRC fails is not ignorable either. WebP is the
//!     other way round — its FIRST EXIF chunk decides, readable or not — so
//!     the WebP walk takes the first.
//!
//!   `None` sends import to the frame probe, and makes the load-time repair
//!   leave the entry unflagged: it is re-sniffed on the next open, which is a
//!   header read, never a process.
//!
//! The dangerous direction is a sniff that says 1..=4 where ffmpeg turns the
//! frame: nothing downstream re-checks that answer, so the stored size is the
//! coded one and the squash is back. Each `None` shape listed above is there
//! because a measured file went exactly that way.
//!
//! Whether ffmpeg's turn is FOLLOWED at all is a separate question, answered
//! per FILE by `read_still` below, because WebView2's answer depends on the
//! file and not just its format: it turns a JPEG by its EXIF and a PNG by an
//! eXIf before the image data, but not a PNG by an eXIf after it, nor a WebP
//! (all measured). Where it does not, every decoder in the app opens the file
//! `-noautorotate` exactly as the WebView draws it, and neither this sniff nor
//! the frame probe behind it is ever asked about that file.

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

/// What a still's header says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sniff {
    /// The EXIF orientation, 1..=8. 1 when the file carries none, or one the
    /// decoder does not act on (mistyped, count 0, out of range). An entry or
    /// block this reader cannot vouch for makes the whole sniff `None`, never
    /// 1 (see the module docs).
    pub orientation: u8,
    /// The CODED (width, height) — what ffprobe's `-show_streams` reports,
    /// before the decoder applies the orientation. Never zero.
    pub coded: (u32, u32),
}

impl Sniff {
    /// Whether ffmpeg's autorotate hands the filtergraph the TRANSPOSE of the
    /// coded size. Orientations 5..=8 are the quarter turns (with or without a
    /// mirror); 2..=4 are mirrors and a half turn, which keep both axes.
    pub fn transposes(&self) -> bool {
        (5..=8).contains(&self.orientation)
    }
}

/// Open `path` only if it is a regular file. A crafted `.trt` can name `CON`,
/// a named pipe or a raw device with size and mtime 0 — which an identity
/// check can pass — and OPENING one of those is already the harm (a pipe
/// blocks, a device reads the disk), so this is asked of the metadata before
/// any open.
fn open_regular(path: &Path) -> Option<std::fs::File> {
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    std::fs::File::open(path).ok()
}

/* ------------------------------------------------------------------ */
/* Whose orientation rule the app follows — decided per FILE           */
/* ------------------------------------------------------------------ */

/// A still's header, read once: the one answer every decoder in the app obeys
/// about its orientation tag, and what the header says about the turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Still {
    /// The sniff — read ONLY for a still the app follows ffmpeg on
    /// (`no_autorotate` false), the one kind whose turn anything asks about.
    /// `None` for a flagged still, whose tag no decoder in the app acts on (so
    /// no PNG tail is searched for it), and for a file that cannot be opened,
    /// is not a still format this knows, or whose header is malformed,
    /// truncated, or not this reader's to vouch for (module docs).
    pub sniff: Option<Sniff>,
    /// Every decoder in the app opens this still `-noautorotate`, and its
    /// stored size is the CODED one: the WebView draws it unturned whatever
    /// its tag says, if it has one (`read_still`). The probe stores this as
    /// `MediaRef.noAutorotate` (`probe.rs`), the load-time repair stamps it on
    /// older entries (`project/store.rs`), the export builder reads that
    /// stored answer (`export/builder.rs`), and the thumbnail and filmstrip
    /// jobs, which hold only a path, ask `read_flag` (`media/thumbs.rs`) — the
    /// same rule (`flag_of`) on the same file.
    pub no_autorotate: bool,
    /// A flagged still's coded (width, height), from the header's own size
    /// fields — IHDR, the VP8X / VP8 / VP8L header, IFD0 — however its
    /// orientation block reads: what the load-time repair compares a stored
    /// size with. `None` for a followed still (nothing needs it), and for a
    /// flagged one whose header gives no size (a zero side included).
    pub coded: Option<(u32, u32)>,
}

/// `read_flag`'s answer: a `Still` without the sniff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Flag {
    /// `Still::no_autorotate`.
    pub no_autorotate: bool,
    /// `Still::coded`.
    pub coded: Option<(u32, u32)>,
}

const NOT_A_STILL: Flag = Flag { no_autorotate: false, coded: None };

/// Read the still at `path` and decide, per FILE, whether the app follows
/// ffmpeg's EXIF turn or ignores the tag the way the WebView does.
///
/// Per file, not per format, because WebView2 answers per file: it turns a
/// PNG by an eXIf before the image data and ignores one after it, while
/// ffmpeg honours both (all measured). Following ffmpeg where the WebView
/// does not makes the preview and the export disagree about the photo's
/// shape — a squashed frame, or a hard size-mismatch abort under a crop or an
/// opacity keyframe. Each row MEASURED on WebView2 runtime 152 unless it
/// says otherwise:
///
/// | file                                             | WebView turns it | `no_autorotate` |
/// |--------------------------------------------------|------------------|-----------------|
/// | JPEG, any                                        | yes (E2E `exif-orientation-still`) | no  |
/// | PNG, an eXIf before the first IDAT               | yes (`exif-orientation-png-early`) | no  |
/// | PNG, the first IDAT before any eXIf — one after it, or none | no (`exif-orientation-png-late`) | yes |
/// | PNG, a walk that never reaches IDAT              | cannot say       | no              |
/// | WebP, any                                        | no (`exif-orientation-webp`)       | yes |
/// | TIFF, any                                        | not drawn at all | yes             |
/// | BMP                                              | no tag to turn   | no              |
/// | GIF, a video, unrecognised or unreadable         | no tag known here | no             |
///
/// "no" is ffmpeg's turn, followed: the probe stores the decoded size (a
/// 5..=8 confirmed by the frame probe) and every decoder autorotates — which
/// on an untagged file is no turn at all. "yes" is decided by where a tag
/// COULD sit, never by reading one: `-noautorotate` on a file ffmpeg would
/// not have turned changes nothing (an untagged PNG's and an untagged WebP's
/// thumbnails come out byte-identical with and without it — measured), and
/// on one it would have turned it is exactly the coded picture the WebView
/// draws. So nothing that follows IDAT — a late eXIf of any size, one behind
/// a large chunk, one with a bad CRC — can make the export disagree with the
/// preview, and no tail read, no frame probe and no window can be fooled
/// about it. (The rule this replaced flagged a PNG only when a tail search
/// FOUND a late tag: an eXIf 6 followed by a 70 KB tEXt, or one whose block
/// overran the 64 KB window, read as "no tag", was stored coded and unflagged,
/// and ffmpeg turned it in the export — measured.) The one row that "cannot
/// say" keeps the earlier builds' argv.
///
/// A BMP is known here only to say it has nothing to turn by: it carries no
/// EXIF and ffmpeg attaches no display matrix to one, so its sniff is
/// orientation 1 and import spends no frame probe on it.
///
/// Known limits, both of files the formats themselves forbid or leave
/// ffmpeg's to call: a PNG with two eXIf chunks (the spec allows one) is
/// followed — the WebView reads one before the image data, ffmpeg keeps the
/// LAST (measured), and the two agree only when both chunks say the same; and
/// a JPEG with two Exif APP1s is ffmpeg's call (module docs), WebView2's
/// parser unmeasured there.
///
/// Cost: one regular-file guard and a 12-byte magic read; a PNG's chunk
/// headers up to its first IDAT; a WebP's or TIFF's own header walk; and the
/// sniff — with it a followed PNG's one tail read — only for a still the app
/// follows. No process.
pub(crate) fn read_still(path: &Path) -> Still {
    match open_regular(path) {
        Some(mut file) => still_reader(&mut file),
        None => Still { sniff: None, no_autorotate: false, coded: None },
    }
}

/// `read_still` without the sniff: the flag and a flagged still's coded size,
/// from chunk and segment HEADERS alone — never the PNG tail search, which
/// only a followed PNG's sniff reads. For the callers that need nothing more
/// and may run often: the thumbnail and filmstrip jobs (once per cache miss)
/// and the load-time recheck of stamped PNGs and WebPs (every load). Decided
/// by the same `flag_of` as `read_still`, so the two never disagree.
pub(crate) fn read_flag(path: &Path) -> Flag {
    match open_regular(path) {
        Some(mut file) => flag_reader(&mut file),
        None => NOT_A_STILL,
    }
}

fn flag_reader<R: Read + Seek>(r: &mut R) -> Flag {
    match read_magic(r) {
        Some((container, magic)) => flag_of(r, container, &magic),
        None => NOT_A_STILL,
    }
}

fn still_reader<R: Read + Seek>(r: &mut R) -> Still {
    let Some((container, magic)) = read_magic(r) else {
        return Still { sniff: None, no_autorotate: false, coded: None };
    };
    let Flag { no_autorotate, coded } = flag_of(r, container, &magic);
    // The sniff answers one question — whether ffmpeg's turn needs a frame
    // probe — and only a still the app follows ffmpeg on ever asks it.
    let sniff = if no_autorotate { None } else { sniff_as(r, container, &magic) };
    Still { sniff, no_autorotate, coded }
}

/// The rule itself (`read_still`'s table), by container: where an
/// orientation tag COULD sit, never what one says.
fn flag_of<R: Read + Seek>(r: &mut R, container: Container, magic: &[u8; 12]) -> Flag {
    let sized = |coded: Option<(u32, u32)>| coded.filter(|&(w, h)| w > 0 && h > 0);
    match container {
        Container::Jpeg | Container::Bmp => NOT_A_STILL,
        Container::Png => match png_unturned(r) {
            Some(coded) => Flag { no_autorotate: true, coded: sized(Some(coded)) },
            None => NOT_A_STILL,
        },
        Container::Webp => Flag {
            no_autorotate: true,
            coded: sized(u32_at(magic, 4, true).and_then(|size| webp(r, size)).map(|h| h.coded)),
        },
        Container::Tiff => Flag { no_autorotate: true, coded: sized(tiff(r).map(|h| h.coded)) },
    }
}

/// The still formats this reader knows, by their magic bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Container {
    Jpeg,
    Png,
    Webp,
    Tiff,
    Bmp,
}

/// The first 12 bytes and what they say the file is. `None` for anything
/// that is not a still format this knows — a GIF, a video, audio, a file too
/// short to tell — so a video is never taken for a still: a rotated RECORDING
/// keeps its autorotate, which the `<video>` element applies too. RIFF alone
/// is not a WebP: an AVI is a RIFF file too.
fn read_magic<R: Read + Seek>(r: &mut R) -> Option<(Container, [u8; 12])> {
    let mut magic = [0u8; 12];
    read_at(r, 0, &mut magic)?;
    let container = if magic.starts_with(&[0xFF, 0xD8]) {
        Container::Jpeg
    } else if magic.starts_with(&PNG_SIG) {
        Container::Png
    } else if magic.starts_with(b"RIFF") && magic.ends_with(b"WEBP") {
        Container::Webp
    } else if magic.starts_with(b"II*\0") || magic.starts_with(b"MM\0*") {
        Container::Tiff
    } else if magic.starts_with(b"BM") {
        Container::Bmp
    } else {
        return None;
    };
    Some((container, magic))
}

/// The PNG half of the rule: the chunk HEADERS, walked from IHDR to the first
/// eXIf, IDAT or IEND — never a chunk body, never the tail. WebView2 reads an
/// eXIf only before the first IDAT (measured — E2E `exif-orientation-png-early`
/// turns, `-late` does not), so:
///
/// - IDAT first: `Some(IHDR's size)`. The WebView draws this PNG coded
///   whatever follows its image data, so the app decodes it `-noautorotate`
///   — right under any late eXIf ffmpeg would honour (it keeps the last one,
///   measured), and a no-op without one.
/// - An eXIf first, readable or not: `None` — the WebView turns by it, so the
///   app follows ffmpeg's turn, as for a JPEG.
/// - A walk that never reaches IDAT — a bad or truncated IHDR, an IEND first,
///   a read past the end, an offset past `u64`, more than `MAX_CHUNKS` chunks
///   (capped like `png`'s walk): `None`, the table's "cannot say" row.
fn png_unturned<R: Read + Seek>(r: &mut R) -> Option<(u32, u32)> {
    let mut ihdr = [0u8; 8 + 13];
    read_at(r, 8, &mut ihdr)?;
    if ihdr.get(..8)? != [0, 0, 0, 13, b'I', b'H', b'D', b'R'] {
        return None;
    }
    let coded = (u32_at(&ihdr, 8, false)?, u32_at(&ihdr, 12, false)?);
    // Past the signature, IHDR's framing, its 13 bytes and its CRC — where
    // `png` starts its walk, so the two walks share one cap.
    let mut pos: u64 = 8 + 8 + 13 + 4;
    for _ in 0..MAX_CHUNKS {
        let mut hdr = [0u8; 8];
        read_at(r, pos, &mut hdr)?;
        match hdr.get(4..8)? {
            b"IDAT" => return Some(coded),
            b"eXIf" | b"IEND" => return None,
            _ => {}
        }
        let len = u64::from(u32_at(&hdr, 0, false)?);
        pos = pos.checked_add(12)?.checked_add(len)?;
    }
    None
}

/// JPEG marker segments walked, SOI to SOS, before giving up. A camera JPEG has
/// ~10-20; the cap exists only so a crafted file cannot make the walk long.
/// Hitting it is `None` even with an SOF and an Exif APP1 already read: a
/// second block could still have followed.
const MAX_JPEG_SEGMENTS: usize = 128;
/// Chunks walked in a PNG before IDAT, and in a whole WebP.
const MAX_CHUNKS: usize = 64;
/// IFD0 entries read. A real IFD0 has a few dozen; 256 * 12 bytes is the fixed
/// stack buffer they are read into. A longer table is UNREADABLE, not
/// orientation-free: ffmpeg reads all 300 entries of one and turns the frame
/// (measured), so it makes the sniff `None`.
const MAX_IFD_ENTRIES: usize = 256;
/// How much of a PNG's tail is searched for an eXIf written after the image
/// data: a full-size EXIF block (the JPEG APP1 ceiling, which camera-derived
/// eXIf payloads inherit) plus a chunk's framing.
const PNG_TAIL: u64 = 64 * 1024 + 12;

const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The header of a file already known to be `container`: the orientation and
/// the coded size, or `None` (see `Still::sniff`).
fn sniff_as<R: Read + Seek>(r: &mut R, container: Container, magic: &[u8; 12]) -> Option<Sniff> {
    let s = match container {
        Container::Jpeg => jpeg(r)?,
        Container::Png => png(r)?,
        Container::Webp => webp(r, u32_at(magic, 4, true)?)?.sniff()?,
        Container::Tiff => tiff(r)?.sniff()?,
        Container::Bmp => bmp(r)?,
    };
    // A zero side is not a size anything downstream can use (and a JPEG whose
    // height lives in a DNL marker reports 0 here): no answer beats that one.
    (s.coded.0 > 0 && s.coded.1 > 0).then_some(s)
}

/// A WebP or TIFF header as its walk read it: the coded size, which the rule
/// needs of a flagged still (`Still::coded`) whatever its orientation block
/// says, and the orientation it can vouch for — `None` where the sniff itself
/// is `None` (an unreadable block, a walk past its cap).
struct Head {
    coded: (u32, u32),
    orientation: Option<u8>,
}

impl Head {
    fn sniff(self) -> Option<Sniff> {
        Some(Sniff { orientation: self.orientation?, coded: self.coded })
    }
}

/// Seek to `pos` and fill `buf` exactly. `None` on any short read, which is
/// how truncation surfaces everywhere below.
fn read_at<R: Read + Seek>(r: &mut R, pos: u64, buf: &mut [u8]) -> Option<()> {
    r.seek(SeekFrom::Start(pos)).ok()?;
    r.read_exact(buf).ok()
}

fn u16_at(b: &[u8], i: usize, le: bool) -> Option<u16> {
    let a: [u8; 2] = b.get(i..i.checked_add(2)?)?.try_into().ok()?;
    Some(if le { u16::from_le_bytes(a) } else { u16::from_be_bytes(a) })
}

fn u32_at(b: &[u8], i: usize, le: bool) -> Option<u32> {
    let a: [u8; 4] = b.get(i..i.checked_add(4)?)?.try_into().ok()?;
    Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
}

/// WebP's little-endian 24-bit field.
fn u24le_at(b: &[u8], i: usize) -> Option<u32> {
    let a: [u8; 3] = b.get(i..i.checked_add(3)?)?.try_into().ok()?;
    Some(u32::from_le_bytes([a[0], a[1], a[2], 0]))
}

/// Orientation as the decoder will act on it, from an IFD0 as parsed — `None`
/// being a block `ifd0` could not read. `Some(1)` when there is nothing to act
/// on: no deciding entry, or a value outside 1..=8, which ffmpeg ignores.
/// `None` when the answer is not this reader's to give: an unreadable block,
/// or a deciding entry it did not read. Every caller hands that `None` on as
/// the sniff's own, so "unreadable" can never come out as "upright".
fn vouched(ifd: Option<&Ifd0>) -> Option<u8> {
    match ifd?.orientation {
        Orientation::Value(v @ 1..=8) => Some(v as u8),
        Orientation::Value(_) | Orientation::Absent => Some(1),
        Orientation::Unknown => None,
    }
}

/// What IFD0's orientation entry says. Three answers, not two, because "the
/// decoder has nothing to turn by" and "the decoder may turn by a value this
/// reader did not read" call for opposite things downstream.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Orientation {
    /// No deciding entry: no 0x0112 at all, or only mistyped or count-0 ones,
    /// which ffmpeg skips (measured).
    #[default]
    Absent,
    /// The deciding entry's first value, as written — possibly out of range.
    Value(u16),
    /// A deciding entry of count 3+, whose values sit out of line. ffmpeg
    /// follows the offset and acts on it (measured); this reader does not.
    Unknown,
}

/// The IFD0 fields this module cares about.
#[derive(Debug, Default)]
struct Ifd0 {
    orientation: Orientation,
    width: Option<u32>,
    height: Option<u32>,
}

/// Parse IFD0 of the TIFF structure occupying `len` bytes at `base`. `None` is
/// "unreadable", which every caller reports as a sniff of `None` (`vouched`) —
/// never as "no orientation".
///
/// Strict on purpose: an IFD that claims more entries than its container
/// holds, or more than `MAX_IFD_ENTRIES`, is `None` rather than a partial read
/// — a partial read is where a false "no orientation" would come from, and
/// ffmpeg reads a table past the cap to its end and turns the frame (measured).
/// The orientation is the FIRST 0x0112 of type SHORT with a count of at least
/// 1, as ffmpeg picks it (measured: a mistyped or count-0 entry is skipped and
/// a later SHORT decides). Count 1 or 2 fits inline and is read on its first
/// value — ffmpeg reads the first value of a count-2 entry too (measured).
/// Count 3+ sits out of line, where ffmpeg follows the offset and turns the
/// frame (measured), so it is `Orientation::Unknown` — and it still DECIDES:
/// a readable count-1 entry after it is not the one ffmpeg acts on (measured:
/// count 3 holding 6, then count 1 holding 1, rotates). Width and height take
/// count 1 only.
fn ifd0<R: Read + Seek>(r: &mut R, base: u64, len: u64) -> Option<Ifd0> {
    if len < 8 {
        return None;
    }
    let mut hdr = [0u8; 8];
    read_at(r, base, &mut hdr)?;
    let le = match hdr.get(..4)? {
        [b'I', b'I', 42, 0] => true,
        [b'M', b'M', 0, 42] => false,
        _ => return None,
    };
    let at = u64::from(u32_at(&hdr, 4, le)?);
    let entries_at = at.checked_add(2)?;
    if at < 8 || entries_at > len {
        return None;
    }
    let mut count = [0u8; 2];
    read_at(r, base.checked_add(at)?, &mut count)?;
    let n = usize::from(u16_at(&count, 0, le)?);
    let bytes = n.checked_mul(12)?;
    if n > MAX_IFD_ENTRIES || entries_at.checked_add(bytes as u64)? > len {
        return None;
    }
    let mut buf = [0u8; MAX_IFD_ENTRIES * 12];
    let entries = buf.get_mut(..bytes)?;
    read_at(r, base.checked_add(entries_at)?, entries)?;

    let mut out = Ifd0::default();
    for e in entries.chunks_exact(12) {
        let (tag, ty, count) = (u16_at(e, 0, le)?, u16_at(e, 2, le)?, u32_at(e, 4, le)?);
        // A SHORT sits left-justified in the 4-byte value field in BOTH byte
        // orders, so reading the first two bytes in the file's order is right
        // for II and MM alike — and is the FIRST value of a count-2 entry.
        let value = match ty {
            3 => u16_at(e, 8, le).map(u32::from),
            4 => u32_at(e, 8, le),
            _ => None,
        };
        match tag {
            0x0112 if ty == 3 && count >= 1 && out.orientation == Orientation::Absent => {
                out.orientation = if count <= 2 {
                    Orientation::Value(u16_at(e, 8, le)?)
                } else {
                    Orientation::Unknown
                };
            }
            0x0100 if count == 1 && out.width.is_none() => out.width = value,
            0x0101 if count == 1 && out.height.is_none() => out.height = value,
            _ => {}
        }
    }
    Some(out)
}

/// JPEG: walk the marker segments from SOI by their lengths, taking the coded
/// size from the first SOFn and the orientation from the APP1 whose id starts
/// "Exif". ffmpeg compares those four bytes and skips the next two without
/// looking (measured: "Exif\0\xFF" and "ExifXY" rotate), so the TIFF block
/// starts six bytes in whatever they are.
///
/// The walk runs to SOS even once it has both, because a SECOND Exif APP1 —
/// before or after the SOF, which ffmpeg honours alike — makes the answer
/// ffmpeg's to give (module docs). Any APP1 starting "Exif" counts, even a
/// stub too short to hold a block — ffmpeg skips those, one more of its own
/// rules this reader does not lean on; a stub alone is unreadable, and `None`
/// only ever costs a frame probe. Cost on a camera JPEG: past the SOF there
/// are the DHT segments (and a DRI) before SOS, a few more 2-byte reads at
/// seeked offsets, and an XMP APP1 ("http://ns.adobe.com/...") is one 4-byte
/// id read. Measured on a camera layout (Exif with a 20 KB thumbnail, XMP,
/// ICC, MPF, 4 DHT, DRI): 18 reads before, 28 now, ~44 µs a sniff with the
/// open. No process.
fn jpeg<R: Read + Seek>(r: &mut R) -> Option<Sniff> {
    let mut pos: u64 = 2;
    let mut coded: Option<(u32, u32)> = None;
    // Set by the first Exif APP1. A second one, or a first this reader cannot
    // vouch for, ends the sniff with `None` on the spot: nothing later in the
    // walk could turn that back into an answer.
    let mut orientation: Option<u8> = None;
    let mut done = false;
    for _ in 0..MAX_JPEG_SEGMENTS {
        let mut m = [0u8; 2];
        if read_at(r, pos, &mut m).is_none() {
            done = true; // end of file: every segment there is has been seen
            break;
        }
        if m[0] != 0xFF {
            return None; // lost sync: not a segment boundary
        }
        match m[1] {
            // A fill byte before the real marker.
            0xFF => {
                pos = pos.checked_add(1)?;
                continue;
            }
            // Standalone markers carry no length.
            0x01 | 0xD0..=0xD7 => {
                pos = pos.checked_add(2)?;
                continue;
            }
            0xD8 => return None,
            0xD9 | 0xDA => {
                done = true;
                break;
            }
            _ => {}
        }
        let mut l = [0u8; 2];
        read_at(r, pos.checked_add(2)?, &mut l)?;
        let seg_len = u64::from(u16::from_be_bytes(l));
        if seg_len < 2 {
            return None;
        }
        let body = pos.checked_add(4)?;
        let body_len = seg_len - 2;
        match m[1] {
            // SOF0-3, 5-7, 9-11, 13-15 — C4 (DHT), C8 (JPG) and CC (DAC) share
            // the range but are not frame headers.
            0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF if coded.is_none() => {
                if body_len < 5 {
                    return None;
                }
                let mut sof = [0u8; 5];
                read_at(r, body, &mut sof)?;
                let h = u16::from_be_bytes([sof[1], sof[2]]);
                let w = u16::from_be_bytes([sof[3], sof[4]]);
                coded = Some((u32::from(w), u32::from(h)));
            }
            0xE1 if body_len >= 4 => {
                let mut id = [0u8; 4];
                read_at(r, body, &mut id)?;
                if id == *b"Exif" {
                    if orientation.is_some() {
                        return None;
                    }
                    // A stub of 4 or 5 bytes has no block at all: unreadable.
                    let tiff = body_len
                        .checked_sub(6)
                        .and_then(|len| ifd0(r, body.checked_add(6)?, len));
                    orientation = Some(vouched(tiff.as_ref())?);
                }
            }
            _ => {}
        }
        pos = body.checked_add(body_len)?;
    }
    if !done {
        return None;
    }
    // Still unset only when no Exif APP1 came before SOS at all: 1 is then
    // the truth, not a guess — there is no block for the decoder to act on.
    Some(Sniff { orientation: orientation.unwrap_or(1), coded: coded? })
}

/// PNG: the size from IHDR (which the spec pins as the first chunk), the
/// orientation from eXIf. Chunks are walked up to the first IDAT, and then the
/// file's TAIL is searched as well, because ffmpeg also honours an eXIf written
/// after the image data — and keeps the LAST eXIf it meets (both measured), so
/// an early one is only the answer when no late one follows. Walking every IDAT
/// to get there would touch the whole file, where the tail is one read.
///
/// More than one eXIf is `None` (module docs). A pure mirror of ffmpeg for any
/// PNG, but `read_still` only ever asks it of a PNG the app FOLLOWS — one with
/// an eXIf before the image data (where the tail is what catches a second,
/// later block: the two-eXIf `None`) or one whose walk never reaches IDAT. A
/// PNG whose first IDAT comes first is flagged by `png_unturned` without it,
/// so what a window-bound tail search can miss past IDAT decides nothing.
/// Cost: the chunk headers up to IDAT, the eXIf's IFD0 and one ≤64 KB tail
/// read. No process.
fn png<R: Read + Seek>(r: &mut R) -> Option<Sniff> {
    let mut ihdr = [0u8; 8 + 13];
    read_at(r, 8, &mut ihdr)?;
    if ihdr.get(..8)? != [0, 0, 0, 13, b'I', b'H', b'D', b'R'] {
        return None;
    }
    let coded = (u32_at(&ihdr, 8, false)?, u32_at(&ihdr, 12, false)?);

    // Past the signature, IHDR's framing, its 13 bytes and its CRC.
    let mut pos: u64 = 8 + 8 + 13 + 4;
    // Set by an eXIf before the image data. A second one, or one this reader
    // cannot vouch for, ends the sniff with `None` on the spot.
    let mut early: Option<u8> = None;
    let mut reached_data = false;
    let mut done = false;
    for _ in 0..MAX_CHUNKS {
        let mut hdr = [0u8; 8];
        if read_at(r, pos, &mut hdr).is_none() {
            done = true;
            break;
        }
        let len = u64::from(u32_at(&hdr, 0, false)?);
        match hdr.get(4..8)? {
            b"eXIf" => {
                if early.is_some() {
                    return None;
                }
                let body = pos.checked_add(8)?;
                early = Some(vouched(ifd0(r, body, len).as_ref())?);
            }
            b"IDAT" | b"IEND" => {
                reached_data = true;
                done = true;
                break;
            }
            _ => {}
        }
        pos = pos.checked_add(12)?.checked_add(len)?;
    }
    if !done {
        return None;
    }
    // The tail search's own `None` is "gave up", not "found nothing".
    let late = if reached_data { png_tail_orientation(r, pos)? } else { None };
    let orientation = match (early, late) {
        // Two blocks. ffmpeg keeps the late one's bytes (measured: early 1
        // then late 6 rotates; an unreadable late block fails the decode) —
        // a rule about ITS parser, which this reader does not imitate.
        (Some(_), Some(_)) => return None,
        (Some(o), None) | (None, Some(o)) => o,
        (None, None) => 1,
    };
    Some(Sniff { orientation, coded })
}

/// An eXIf chunk in the last `PNG_TAIL` bytes (never before `from`, the first
/// IDAT): `Some(Some(o))` found, `Some(None)` there is none, `None` the search
/// cannot say — an unreadable tail, an eXIf it cannot vouch for, or a
/// candidate whose CRC fails.
///
/// A candidate is four bytes spelling "eXIf" whose length lands inside the
/// window. The CRC then tells a real chunk from four coincidental bytes of
/// compressed image data — but only in one direction: ffmpeg does not check
/// chunk CRCs, and a late eXIf with a bad one still rotates (measured). So a
/// failing CRC is not a chunk to skip past; it is `None`, and at most one CRC
/// (a bitwise pass over ≤64 KB) is ever spent. The scan runs BACKWARDS from
/// the end, where a real late eXIf sits (next to IEND) — and where the LAST
/// of several sits, which is the one ffmpeg keeps.
fn png_tail_orientation<R: Read + Seek>(r: &mut R, from: u64) -> Option<Option<u8>> {
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let start = end.saturating_sub(PNG_TAIL).max(from);
    let n = usize::try_from(end.checked_sub(start)?).ok()?;
    let mut buf = vec![0u8; n];
    read_at(r, start, &mut buf)?;
    // `t` is where a chunk TYPE would start: 4 bytes of length before it, 4
    // bytes of type from it.
    for t in (4..buf.len().saturating_sub(3)).rev() {
        if buf.get(t..t + 4) != Some(b"eXIf".as_slice()) {
            continue;
        }
        let Some(len) = u32_at(&buf, t - 4, false).and_then(|l| usize::try_from(l).ok()) else {
            continue;
        };
        let Some(data_end) = t.checked_add(4).and_then(|d| d.checked_add(len)) else {
            continue;
        };
        let (Some(typed), Some(crc)) = (buf.get(t..data_end), u32_at(&buf, data_end, false)) else {
            continue;
        };
        if crc32(typed) != crc {
            return None;
        }
        let tiff = ifd0(&mut Cursor::new(&buf[..]), (t + 4) as u64, len as u64);
        return Some(Some(vouched(tiff.as_ref())?));
    }
    Some(None)
}

/// The PNG chunk CRC (ISO 3309 / zlib's polynomial), bitwise: it runs over at
/// most one candidate chunk in the tail window, so a table is not worth its
/// 1 KB.
fn crc32(bytes: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in bytes {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// WebP: walk the RIFF chunks. The size comes from the VP8X canvas when there
/// is one (24-bit minus-one fields), else from the VP8 / VP8L bitstream
/// header; the orientation from an EXIF chunk, which ffmpeg honours whether or
/// not a VP8X announces it (measured), so every chunk is looked at. Unlike
/// PNG, the FIRST EXIF chunk decides, readable or not (measured: 1 then 6
/// does not rotate; an unreadable block then 6 does not either), so a later
/// one is not looked at and a first one this reader cannot vouch for is `None`.
/// The walk goes on past such a block all the same, so the coded size a WebP
/// carries after it is still found (`Head`).
fn webp<R: Read + Seek>(r: &mut R, riff_size: u32) -> Option<Head> {
    let end = 8u64.checked_add(u64::from(riff_size))?;
    let mut pos: u64 = 12;
    let mut coded: Option<(u32, u32)> = None;
    // Set by the FIRST EXIF chunk: its vouched orientation, or `None` when
    // this reader cannot vouch for it.
    let mut exif: Option<Option<u8>> = None;
    let mut done = false;
    for _ in 0..MAX_CHUNKS {
        let mut hdr = [0u8; 8];
        if pos.checked_add(8)? > end || read_at(r, pos, &mut hdr).is_none() {
            done = true; // the RIFF (or the file) ended: every chunk was seen
            break;
        }
        let size = u64::from(u32_at(&hdr, 4, true)?);
        let body = pos.checked_add(8)?;
        match hdr.get(..4)? {
            b"VP8X" if coded.is_none() => {
                if size < 10 {
                    return None;
                }
                let mut x = [0u8; 10];
                read_at(r, body, &mut x)?;
                coded = Some((u24le_at(&x, 4)? + 1, u24le_at(&x, 7)? + 1));
            }
            b"VP8 " if coded.is_none() => {
                // 3-byte frame tag, then the 9D 01 2A start code, then two
                // 14-bit dimensions (the top two bits are a scale hint).
                if size < 10 {
                    return None;
                }
                let mut k = [0u8; 10];
                read_at(r, body, &mut k)?;
                if k.get(3..6)? != [0x9D, 0x01, 0x2A] {
                    return None;
                }
                coded = Some((
                    u32::from(u16_at(&k, 6, true)? & 0x3FFF),
                    u32::from(u16_at(&k, 8, true)? & 0x3FFF),
                ));
            }
            b"VP8L" if coded.is_none() => {
                // Signature 0x2F, then 14-bit minus-one width and height.
                if size < 5 {
                    return None;
                }
                let mut l = [0u8; 5];
                read_at(r, body, &mut l)?;
                if l[0] != 0x2F {
                    return None;
                }
                let bits = u32_at(&l, 1, true)?;
                coded = Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1));
            }
            b"EXIF" if exif.is_none() => {
                exif = Some(vouched(ifd0(r, body, size).as_ref()));
            }
            _ => {}
        }
        // RIFF chunks are padded to an even length.
        pos = body.checked_add(size)?.checked_add(size & 1)?;
    }
    // A walk that hit its cap never saw every chunk: the size it read stands,
    // but it has no business vouching that no EXIF followed.
    let orientation = if done { exif.unwrap_or(Some(1)) } else { None };
    Some(Head { coded: coded?, orientation })
}

/// TIFF: the file IS the TIFF structure, so IFD0 carries the size too.
fn tiff<R: Read + Seek>(r: &mut R) -> Option<Head> {
    let len = r.seek(SeekFrom::End(0)).ok()?;
    let i = ifd0(r, 0, len)?;
    Some(Head { coded: (i.width?, i.height?), orientation: vouched(Some(&i)) })
}

/// BMP: no orientation to speak of — no EXIF, and ffmpeg's decoder attaches
/// no display matrix — so always 1, and the size from the DIB header: 16-bit
/// at 18/20 in the 12-byte OS/2 core header, signed 32-bit at 18/22 in every
/// later one, where a negative height is top-down row order, not a smaller
/// picture. Answered rather than left `None` so a BMP never costs a frame
/// probe (~120 ms on import, for a turn it cannot have) and the load-time
/// repair settles it on first sight instead of re-reading it on every load.
fn bmp<R: Read + Seek>(r: &mut R) -> Option<Sniff> {
    let mut dib = [0u8; 12];
    read_at(r, 14, &mut dib)?;
    let coded = match u32_at(&dib, 0, true)? {
        12 => (u32::from(u16_at(&dib, 4, true)?), u32::from(u16_at(&dib, 6, true)?)),
        n if n >= 16 => {
            // Reinterpreted, not converted: these two fields are signed.
            let w = u32_at(&dib, 4, true)? as i32;
            let h = u32_at(&dib, 8, true)? as i32;
            (u32::try_from(w).ok()?, h.unsigned_abs())
        }
        _ => return None,
    };
    Some(Sniff { orientation: 1, coded })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A TIFF block whose IFD0 holds one SHORT Orientation entry — the exact
    /// layout a camera writes, in either byte order.
    pub(crate) fn tiff_orientation(o: u16, le: bool) -> Vec<u8> {
        let w16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut b = Vec::new();
        b.extend_from_slice(if le { b"II" } else { b"MM" });
        b.extend_from_slice(&w16(42));
        b.extend_from_slice(&w32(8));
        b.extend_from_slice(&w16(1));
        b.extend_from_slice(&w16(0x0112));
        b.extend_from_slice(&w16(3));
        b.extend_from_slice(&w32(1));
        b.extend_from_slice(&w16(o));
        b.extend_from_slice(&w16(0));
        b.extend_from_slice(&w32(0));
        b
    }

    /// A big-endian TIFF block whose IFD0 holds `entries` — (tag, type, count,
    /// value) — in the order given, followed by `tail` (a sub-IFD, say, at
    /// offset `10 + 12 * entries.len() + 4`). A count-1 SHORT is written
    /// left-justified, as a camera does; everything else writes `value` as the
    /// whole 4-byte field, which is how an out-of-line OFFSET is spelled. The
    /// shapes ffmpeg was measured to drop whole are built from this.
    pub(crate) fn tiff_entries(entries: &[(u16, u16, u32, u32)], tail: &[u8]) -> Vec<u8> {
        tiff_entries_in(false, entries, tail)
    }

    /// `tiff_entries` in either byte order (`tail` is written as given).
    pub(crate) fn tiff_entries_in(le: bool, entries: &[(u16, u16, u32, u32)], tail: &[u8]) -> Vec<u8> {
        let w16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut b = if le { b"II".to_vec() } else { b"MM".to_vec() };
        b.extend_from_slice(&w16(42));
        b.extend_from_slice(&w32(8));
        b.extend_from_slice(&w16(entries.len() as u16));
        for &(tag, ty, count, value) in entries {
            b.extend_from_slice(&w16(tag));
            b.extend_from_slice(&w16(ty));
            b.extend_from_slice(&w32(count));
            if ty == 3 && count == 1 {
                b.extend_from_slice(&w16(value as u16));
                b.extend_from_slice(&[0, 0]);
            } else {
                b.extend_from_slice(&w32(value));
            }
        }
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(tail);
        b
    }

    /// JPEGs on `base` whose orientation is ffmpeg's to decide, not this
    /// reader's — so the sniff must say `None` and hand them to the frame
    /// probe: `(name, jpeg, ffmpeg turns it)`, every verdict measured on the
    /// bundled ffmpeg. Each "turns" row used to sniff as orientation 1, which
    /// skipped the frame probe and stored the portrait photo squashed:
    /// - a count-3 SHORT orientation held out of line (6,6,6 at offset 26), in
    ///   both byte orders, and the same ahead of a readable count-1 entry of 1;
    /// - an IFD0 of 300 entries, orientation 6 first (past the entry cap);
    /// - two Exif APP1s, the first holding 1 in a block ffmpeg drops (its IFD0
    ///   claims 5 entries and holds 1; or a Make of count 1000 points past
    ///   it), the second holding 6 — and the same with the second block
    ///   written after the SOF, which a walk that stopped once it had an SOF
    ///   and an orientation never reached.
    ///
    /// Plus the row that says why two blocks are `None` rather than "take the
    /// first one readable": a first block that parses with NO orientation
    /// wins, and the second block's 6 is never applied.
    pub(crate) fn exif_left_to_ffmpeg(base: &[u8]) -> Vec<(&'static str, Vec<u8>, bool)> {
        let o = |v: u32| (0x0112u16, 3u16, 1u32, v);
        // One entry's table ends at 8 + 2 + 12 + 4 = 26; two entries' at 38.
        let c3_be = tiff_entries_in(false, &[(0x0112, 3, 3, 26)], &[0, 6, 0, 6, 0, 6]);
        let c3_le = tiff_entries_in(true, &[(0x0112, 3, 3, 26)], &[6, 0, 6, 0, 6, 0]);
        let c3_then_1 = tiff_entries(&[(0x0112, 3, 3, 38), o(1)], &[0, 6, 0, 6, 0, 6]);
        let mut many = vec![o(6)];
        many.extend((0..299u16).map(|i| (0xC000 + i, 3, 1, 0)));
        let many = tiff_entries(&many, &[]);
        let mut overrun_1 = tiff_entries(&[o(1)], &[]);
        overrun_1[9] = 5; // the entry count, big-endian low byte
        let badmake_1 = tiff_entries(&[(0x010F, 2, 1000, 50_000), o(1)], &[]);
        let make_only = tiff_entries(&[(0x010F, 2, 4, u32::from_be_bytes(*b"abc\0"))], &[]);
        let then_6 = |first: &[u8]| jpeg_with_exif(&jpeg_with_exif(base, &tiff_orientation(6, false)), first);
        // The first block up front, the 6 spliced in just ahead of SOS.
        let sof_then_6 = |first: &[u8]| {
            let j = jpeg_with_exif(base, first);
            let sos = sos_at(&j);
            let mut out = j[..sos].to_vec();
            out.extend_from_slice(&jpeg_with_exif(&[0xFF, 0xD8], &tiff_orientation(6, false))[2..]);
            out.extend_from_slice(&j[sos..]);
            out
        };
        vec![
            ("c3_ool6_be", jpeg_with_exif(base, &c3_be), true),
            ("c3_ool6_le", jpeg_with_exif(base, &c3_le), true),
            ("c3ool6_short1", jpeg_with_exif(base, &c3_then_1), true),
            ("many_entries_6", jpeg_with_exif(base, &many), true),
            ("bad_then_6", then_6(&overrun_1), true),
            ("badmake1_then_6", then_6(&badmake_1), true),
            ("badmake1_sof_6", sof_then_6(&badmake_1), true),
            ("noorient_then_6", then_6(&make_only), false),
        ]
    }

    /// Where a JPEG's SOS marker sits, found by walking the segments (scan
    /// data never reached, so no stray FF DA in a table can fool it).
    fn sos_at(j: &[u8]) -> usize {
        let mut i = 2;
        while j[i + 1] != 0xDA {
            i += 2 + u16::from_be_bytes([j[i + 2], j[i + 3]]) as usize;
        }
        i
    }

    /// The PNG counterpart of `exif_left_to_ffmpeg`, on `base`: ffmpeg keeps
    /// the LAST eXIf's bytes and never checks a chunk CRC, so an early 1 with
    /// a late 6, two early chunks 1 then 6, and a lone late 6 whose CRC is
    /// wrong all TURN (measured) — and each used to sniff as 1. Same shape as
    /// the JPEG list, so the probe table can take both; every row here turns.
    pub(crate) fn png_exif_left_to_ffmpeg(base: &[u8]) -> Vec<(&'static str, Vec<u8>, bool)> {
        let (t1, t6) = (tiff_orientation(1, false), tiff_orientation(6, false));
        let mut bad_crc = png_with_exif(base, &t6, true);
        let at = bad_crc.windows(4).rposition(|w| w == b"eXIf").unwrap();
        bad_crc[at + 4 + t6.len()] ^= 0xFF;
        vec![
            ("png_1_then_late6", png_with_exif(&png_with_exif(base, &t1, false), &t6, true), true),
            ("png_two_early_1_6", png_with_exif(&png_with_exif(base, &t1, false), &t6, false), true),
            ("png_late6_badcrc", bad_crc, true),
        ]
    }

    /// The layouts a verifier found ffmpeg drops the WHOLE EXIF block for, each
    /// carrying a well-formed IFD0 orientation 6 that this reader still sees:
    /// an IFD0 ASCII value out of line past the block (before and after the
    /// orientation), an Exif-IFD pointer past the block, an Exif IFD that
    /// claims 50 entries, and a MakerNote in the Exif IFD whose value lies past
    /// the block. `(name, tiff block)`.
    pub(crate) fn ffmpeg_rejected_exif() -> Vec<(&'static str, Vec<u8>)> {
        let o6 = (0x0112, 3, 1, 6);
        let make = (0x010F, 2, 1000, 50_000);
        // Two IFD0 entries end at 8 + 2 + 24 + 4 = 38: the sub-IFD's offset.
        let exif_at_38 = (0x8769, 4, 1, 38);
        let mut maker = 1u16.to_be_bytes().to_vec();
        maker.extend_from_slice(&0x927Cu16.to_be_bytes());
        maker.extend_from_slice(&7u16.to_be_bytes());
        maker.extend_from_slice(&5000u32.to_be_bytes());
        maker.extend_from_slice(&70_000u32.to_be_bytes());
        maker.extend_from_slice(&[0; 4]);
        let mut trunc = 50u16.to_be_bytes().to_vec();
        trunc.extend_from_slice(&[0; 6]);
        vec![
            ("badmake_6", tiff_entries(&[make, o6], &[])),
            ("6_badmake", tiff_entries(&[o6, make], &[])),
            ("exififd_oob_6", tiff_entries(&[o6, (0x8769, 4, 1, 90_000)], &[])),
            ("exififd_trunc_6", tiff_entries(&[o6, exif_at_38], &trunc)),
            ("makernote_oob_6", tiff_entries(&[o6, exif_at_38], &maker)),
        ]
    }

    /// Splice an APP1 "Exif\0\0" segment carrying `tiff` right after SOI,
    /// dropping any JFIF APP0 — the layout a phone camera writes.
    pub(crate) fn jpeg_with_exif(src: &[u8], tiff: &[u8]) -> Vec<u8> {
        jpeg_with_exif_id(src, b"Exif\0\0", tiff)
    }

    /// `jpeg_with_exif` with an arbitrary 6-byte APP1 id.
    pub(crate) fn jpeg_with_exif_id(src: &[u8], id: &[u8; 6], tiff: &[u8]) -> Vec<u8> {
        assert_eq!(&src[..2], &[0xFF, 0xD8], "not a JPEG");
        let mut kept = Vec::new();
        let mut i = 2;
        while i < src.len() {
            assert_eq!(src[i], 0xFF, "bad marker at {i}");
            let m = src[i + 1];
            if m == 0xDA {
                kept.extend_from_slice(&src[i..]);
                break;
            }
            let len = u16::from_be_bytes([src[i + 2], src[i + 3]]) as usize;
            if m != 0xE0 {
                kept.extend_from_slice(&src[i..i + 2 + len]);
            }
            i += 2 + len;
        }
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&((6 + tiff.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(id);
        out.extend_from_slice(tiff);
        out.extend_from_slice(&kept);
        out
    }

    pub(crate) fn png_chunk(ty: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = (data.len() as u32).to_be_bytes().to_vec();
        let mut typed = ty.to_vec();
        typed.extend_from_slice(data);
        c.extend_from_slice(&typed);
        c.extend_from_slice(&crc32(&typed).to_be_bytes());
        c
    }

    /// Insert an eXIf chunk into a PNG, before the first IDAT (`late` =
    /// false) or just before IEND (`late` = true).
    pub(crate) fn png_with_exif(src: &[u8], tiff: &[u8], late: bool) -> Vec<u8> {
        let exif = png_chunk(b"eXIf", tiff);
        let mut out = src[..8].to_vec();
        let mut i = 8;
        let mut placed = false;
        while i < src.len() {
            let len = u32::from_be_bytes(src[i..i + 4].try_into().unwrap()) as usize;
            let ty = &src[i + 4..i + 8];
            let before = if late { ty == b"IEND" } else { ty == b"IDAT" };
            if before && !placed {
                out.extend_from_slice(&exif);
                placed = true;
            }
            out.extend_from_slice(&src[i..i + 12 + len]);
            i += 12 + len;
        }
        out
    }

    fn riff_chunk(ty: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = ty.to_vec();
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(data);
        if data.len() % 2 == 1 {
            c.push(0);
        }
        c
    }

    pub(crate) fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        for c in chunks {
            body.extend_from_slice(c);
        }
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    /// Wrap a simple WebP (one VP8/VP8L chunk) as an extended one: a VP8X
    /// canvas of (w, h), the original bitstream chunks, then an EXIF chunk.
    pub(crate) fn webp_with_exif(src: &[u8], w: u32, h: u32, tiff: &[u8]) -> Vec<u8> {
        assert!(&src[..4] == b"RIFF" && &src[8..12] == b"WEBP", "not a WebP");
        let mut vp8x = vec![0u8; 10];
        vp8x[0] = 0x08; // EXIF present
        vp8x[4..7].copy_from_slice(&(w - 1).to_le_bytes()[..3]);
        vp8x[7..10].copy_from_slice(&(h - 1).to_le_bytes()[..3]);
        let mut chunks = vec![riff_chunk(b"VP8X", &vp8x)];
        chunks.push(src[12..].to_vec()); // the original chunk(s), verbatim
        chunks.push(riff_chunk(b"EXIF", tiff));
        riff(&chunks)
    }

    /// The sniff alone, as `read_still` reads it — without the per-file
    /// rule's own PNG walk, so a sniff test never leans on it.
    pub(crate) fn sniff_bytes(b: &[u8]) -> Option<Sniff> {
        let mut r = Cursor::new(b);
        let (container, magic) = read_magic(&mut r)?;
        sniff_as(&mut r, container, &magic)
    }

    /// A minimal baseline JPEG header: SOI, JFIF APP0, DQT, SOF0 of (w, h),
    /// SOS. Never decoded — the sniffer only walks its segments.
    pub(crate) fn tiny_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8];
        b.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        b.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        b.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x43, 0x00]);
        b.extend_from_slice(&[1u8; 64]);
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        b.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x0C, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0]);
        b.extend_from_slice(&[0x12, 0x34, 0xFF, 0xD9]);
        b
    }

    /// A PNG header whose IHDR says (w, h), with one IDAT and IEND. Only the
    /// chunk framing matters to the sniffer.
    pub(crate) fn tiny_png(w: u32, h: u32) -> Vec<u8> {
        let mut ihdr = w.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut b = PNG_SIG.to_vec();
        b.extend(png_chunk(b"IHDR", &ihdr));
        b.extend(png_chunk(b"IDAT", &[0x78, 0x9C, 1, 2, 3, 4]));
        b.extend(png_chunk(b"IEND", &[]));
        b
    }

    /// A BMP header: the 14-byte file header and a 40-byte BITMAPINFOHEADER
    /// of (w, h) — signed, as the format has them. No pixels; the sniffer
    /// reads only the DIB header's size fields.
    pub(crate) fn tiny_bmp(w: i32, h: i32) -> Vec<u8> {
        let mut b = b"BM".to_vec();
        b.extend_from_slice(&54u32.to_le_bytes()); // the file size, never read
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&54u32.to_le_bytes()); // where the pixels would start
        b.extend_from_slice(&40u32.to_le_bytes());
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(&[0; 24]);
        b
    }

    /// A late eXIf the old tail search could not see, in the two shapes a
    /// verifier measured ffmpeg turning while that search said "no tag":
    /// `(name, png)` on `base`, each eXIf saying 6.
    /// - followed by a 70 KB tEXt, which pushes it out of the tail window;
    /// - a block of 65,527 bytes (orientation 6 up front, zeros after), whose
    ///   chunk no longer fits the window at all.
    pub(crate) fn png_exif_past_the_tail(base: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
        let t6 = tiff_orientation(6, false);
        let late = png_with_exif(base, &t6, true);
        let iend = late.len() - 12;
        let mut comment = b"Comment\0".to_vec();
        comment.extend(std::iter::repeat_n(b'x', 70_000));
        let then_text: Vec<u8> = [&late[..iend], &png_chunk(b"tEXt", &comment)[..], &late[iend..]].concat();
        let mut big = t6.clone();
        big.resize(65_527, 0);
        vec![("png_late6_then_70k_text", then_text), ("png_late6_65527_block", png_with_exif(base, &big, true))]
    }

    pub(crate) fn vp8l(w: u32, h: u32) -> Vec<u8> {
        let bits = (w - 1) | ((h - 1) << 14);
        let mut d = vec![0x2F];
        d.extend_from_slice(&bits.to_le_bytes());
        d.extend_from_slice(&[0, 0, 0]);
        riff_chunk(b"VP8L", &d)
    }

    fn vp8(w: u16, h: u16) -> Vec<u8> {
        let mut d = vec![0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A];
        d.extend_from_slice(&w.to_le_bytes());
        d.extend_from_slice(&h.to_le_bytes());
        d.extend_from_slice(&[0, 0]);
        riff_chunk(b"VP8 ", &d)
    }

    /// Every orientation, in both TIFF byte orders, reads back as written —
    /// and the coded size is the SOF's, whose width and height differ so a
    /// swapped read cannot pass.
    #[test]
    fn jpeg_every_orientation_in_both_byte_orders() {
        let base = tiny_jpeg(64, 36);
        for le in [false, true] {
            for o in 1..=8u16 {
                let s = sniff_bytes(&jpeg_with_exif(&base, &tiff_orientation(o, le))).unwrap();
                assert_eq!(s.orientation, o as u8, "o{o} le={le}");
                assert_eq!(s.coded, (64, 36), "o{o} le={le}");
                assert_eq!(s.transposes(), o >= 5, "o{o}");
            }
        }
        // No Exif at all: orientation 1, same size.
        assert_eq!(sniff_bytes(&base), Some(Sniff { orientation: 1, coded: (64, 36) }));
    }

    /// The Exif APP1 is found after the SOF too (ffmpeg honours it there), and
    /// after a large segment that is seeked past rather than read.
    #[test]
    fn jpeg_exif_after_the_sof_and_after_a_big_segment() {
        let base = tiny_jpeg(80, 30);
        let with = jpeg_with_exif(&base, &tiff_orientation(6, false));
        // Move the APP1 (bytes 2..app1_end) to just before SOS, behind a
        // 60 KB COM segment.
        let app1_len = u16::from_be_bytes([with[4], with[5]]) as usize + 2;
        let app1 = with[2..2 + app1_len].to_vec();
        let rest = &with[2 + app1_len..];
        let sos = rest.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap();
        let mut late = vec![0xFF, 0xD8];
        late.extend_from_slice(&rest[..sos]);
        late.extend_from_slice(&[0xFF, 0xFE, 0xEA, 0x62]); // COM, 60002 bytes
        late.extend(std::iter::repeat_n(0u8, 0xEA62 - 2));
        late.extend_from_slice(&app1);
        late.extend_from_slice(&rest[sos..]);
        assert_eq!(sniff_bytes(&late), Some(Sniff { orientation: 6, coded: (80, 30) }));
    }

    #[test]
    fn png_exif_before_and_after_the_image_data() {
        let base = tiny_png(50, 20);
        for o in [3u16, 6, 8] {
            for late in [false, true] {
                let s = sniff_bytes(&png_with_exif(&base, &tiff_orientation(o, false), late)).unwrap();
                assert_eq!(s, Sniff { orientation: o as u8, coded: (50, 20) }, "o{o} late={late}");
            }
        }
        assert_eq!(sniff_bytes(&base), Some(Sniff { orientation: 1, coded: (50, 20) }));
    }

    /// More than one eXIf, or a late one whose CRC fails: ffmpeg's call, each
    /// measured (`png_exif_left_to_ffmpeg`). This used to answer 1 for the
    /// three that turn — the early chunk was taken and the walk stopped, and a
    /// failed CRC was skipped as "not a chunk" though ffmpeg never checks one.
    #[test]
    fn a_png_with_two_exif_chunks_or_a_bad_tail_crc_is_left_to_ffmpeg() {
        let base = tiny_png(50, 20);
        for (name, png, _) in png_exif_left_to_ffmpeg(&base) {
            assert_eq!(sniff_bytes(&png), None, "{name}");
        }
        // A readable early 6 behind which sits an unreadable late block: two
        // blocks all the same (ffmpeg keeps the late bytes, and then fails the
        // whole decode on them — measured).
        let mut prefixed = b"Exif\0\0".to_vec();
        prefixed.extend(tiff_orientation(1, false));
        let early_6 = png_with_exif(&base, &tiff_orientation(6, false), false);
        assert_eq!(sniff_bytes(&png_with_exif(&early_6, &prefixed, true)), None);
    }

    /// The tail search spends at most ONE CRC: a candidate whose CRC fails
    /// ends it with `None`, however many more there are — so a tail crafted
    /// from thousands of near-miss candidates costs one pass, not seconds. Four
    /// bytes spelling "eXIf" whose length runs past the file are not a
    /// candidate at all, and are stepped over for free.
    #[test]
    fn the_png_tail_search_spends_at_most_one_crc() {
        let base = tiny_png(50, 20);
        let late = png_with_exif(&base, &tiff_orientation(6, false), true);
        let iend = late.len() - 12;
        let with_tail = |extra: &[u8]| {
            let mut out = late[..iend].to_vec();
            out.extend_from_slice(extra);
            out.extend_from_slice(&late[iend..]);
            out
        };
        let mut bad = png_chunk(b"eXIf", &tiff_orientation(3, false));
        let last = bad.len() - 1;
        bad[last] ^= 0xFF;
        assert_eq!(sniff_bytes(&with_tail(&bad)), None);
        assert_eq!(sniff_bytes(&with_tail(&bad.repeat(4_000))), None);

        let mut text = b"k\0".to_vec();
        text.extend_from_slice(&[0xFF; 4]);
        text.extend_from_slice(b"eXIf");
        let noise = png_chunk(b"tEXt", &text);
        assert_eq!(sniff_bytes(&with_tail(&noise)).map(|s| s.orientation), Some(6));
    }

    /// ffmpeg rejects an "Exif\0\0"-prefixed eXIf payload ("invalid TIFF
    /// header") — in a PNG by failing the whole decode (measured), so there is
    /// no turn to agree with. This reader cannot read it either, and does not
    /// vouch for "upright" over a block it could not read: `None`.
    #[test]
    fn a_prefixed_png_payload_is_not_vouched_for() {
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend(tiff_orientation(6, false));
        for late in [false, true] {
            assert_eq!(sniff_bytes(&png_with_exif(&tiny_png(50, 20), &payload, late)), None, "late={late}");
        }
    }

    /// An eXIf whose deciding orientation this reader does not read is `None`
    /// in PNG as in JPEG, before the image data or after it.
    #[test]
    fn a_png_or_webp_block_the_reader_cannot_read_is_none() {
        let c3 = tiff_entries(&[(0x0112, 3, 3, 26)], &[0, 6, 0, 6, 0, 6]);
        for late in [false, true] {
            assert_eq!(sniff_bytes(&png_with_exif(&tiny_png(50, 20), &c3, late)), None, "late={late}");
        }
        let simple = riff(&[vp8l(70, 40)]);
        assert_eq!(sniff_bytes(&webp_with_exif(&simple, 70, 40, &c3)), None);
        let mut huge = tiff_orientation(6, false);
        huge[8..10].copy_from_slice(&[0xFF, 0xFF]);
        assert_eq!(sniff_bytes(&webp_with_exif(&simple, 70, 40, &huge)), None);
    }

    #[test]
    fn webp_extended_with_exif_and_simple_without() {
        // Extended: canvas from VP8X, orientation from EXIF (either order).
        for (o, le) in [(6u16, false), (8, true), (2, false)] {
            let simple = riff(&[vp8l(70, 40)]);
            let s = sniff_bytes(&webp_with_exif(&simple, 70, 40, &tiff_orientation(o, le))).unwrap();
            assert_eq!(s, Sniff { orientation: o as u8, coded: (70, 40) }, "o{o}");
        }
        // Simple lossless and lossy: bitstream size, no orientation.
        assert_eq!(sniff_bytes(&riff(&[vp8l(70, 40)])), Some(Sniff { orientation: 1, coded: (70, 40) }));
        assert_eq!(sniff_bytes(&riff(&[vp8(90, 24)])), Some(Sniff { orientation: 1, coded: (90, 24) }));
        // ...but an EXIF chunk tacked onto a simple file still counts, because
        // ffmpeg honours it there too.
        let tacked = riff(&[vp8(90, 24), riff_chunk(b"EXIF", &tiff_orientation(5, false))]);
        assert_eq!(sniff_bytes(&tacked), Some(Sniff { orientation: 5, coded: (90, 24) }));

        // The FIRST EXIF chunk decides in WebP (measured: 1 then 6 does not
        // rotate), readable or not — an unreadable first block then 6 does not
        // rotate either, and is not this reader's call.
        let exif = |t: &[u8]| riff_chunk(b"EXIF", t);
        let (t1, t6) = (tiff_orientation(1, false), tiff_orientation(6, false));
        let two = riff(&[vp8(90, 24), exif(&t1), exif(&t6)]);
        assert_eq!(sniff_bytes(&two), Some(Sniff { orientation: 1, coded: (90, 24) }));
        let mut prefixed = b"Exif\0\0".to_vec();
        prefixed.extend_from_slice(&t1);
        assert_eq!(sniff_bytes(&riff(&[vp8(90, 24), exif(&prefixed), exif(&t6)])), None);
    }

    pub(crate) fn still_bytes(b: &[u8]) -> Still {
        still_reader(&mut Cursor::new(b))
    }

    /// A TIFF file whose IFD0 holds a width, a height and — unless `o` is 0
    /// — an orientation: the file IS the block.
    fn tiny_tiff(w: u32, h: u32, o: u16) -> Vec<u8> {
        let mut entries = vec![(0x0100u16, 4u16, 1u32, w), (0x0101, 4, 1, h)];
        if o != 0 {
            entries.push((0x0112, 3, 1, u32::from(o)));
        }
        tiff_entries_in(true, &entries, &[])
    }

    /// The per-FILE rule's table, row by row: `Some(coded)` is flagged with
    /// that coded size, `None` followed. The rows that matter most differ ONLY
    /// in where a PNG's eXIf sits, so a rule that decided by format fails
    /// here; and the flagged PNG rows include every tail a search could get
    /// wrong — none at all, a late 1, a late 6 past the window, a bad CRC — so
    /// a rule that decided by READING the tag fails too (the one this
    /// replaced left the verifier's two past-the-window files unflagged).
    ///
    /// A followed still's sniff is the plain sniff, never a second opinion; a
    /// flagged one's is never read. `read_flag` gives the same answer on
    /// every row, since the thumbnail jobs decide by it.
    #[test]
    fn the_per_file_rule_is_the_measured_table() {
        let (jpg, png, webp) = (tiny_jpeg(64, 36), tiny_png(50, 20), riff(&[vp8l(70, 40)]));
        let t = |o: u16| tiff_orientation(o, false);
        let c3 = tiff_entries(&[(0x0112, 3, 3, 26)], &[0, 6, 0, 6, 0, 6]);
        let mut prefixed = b"Exif\0\0".to_vec();
        prefixed.extend(t(6));
        // An eXIf past `MAX_CHUNKS` empty chunks ahead of IDAT: never reached.
        let far = {
            let idat = 33;
            let mut p = png[..idat].to_vec();
            for _ in 0..MAX_CHUNKS {
                p.extend(png_chunk(b"tEXt", &[]));
            }
            p.extend_from_slice(&png[idat..]);
            png_with_exif(&p, &t(6), true)
        };
        let late_rows = png_exif_left_to_ffmpeg(&png);
        let left = |name: &str| late_rows.iter().find(|r| r.0 == name).unwrap().1.clone();
        let past = png_exif_past_the_tail(&png);
        let past = |name: &str| past.iter().find(|r| r.0 == name).unwrap().1.clone();
        let iend_first: Vec<u8> = [&png[..33], &png_chunk(b"IEND", &[])[..]].concat();

        let (p, w, tf) = (Some((50, 20)), Some((70, 40)), Some((120, 48)));
        let rows: Vec<(&str, Vec<u8>, Option<(u32, u32)>)> = vec![
            // JPEG: the WebView turns it, so the app follows ffmpeg — tag or
            // no tag, readable or not.
            ("jpeg o6", jpeg_with_exif(&jpg, &t(6)), None),
            ("jpeg o3", jpeg_with_exif(&jpg, &t(3)), None),
            ("jpeg none", jpg.clone(), None),
            ("jpeg two blocks", jpeg_with_exif(&jpeg_with_exif(&jpg, &t(6)), &t(6)), None),
            // PNG: whether an eXIf comes before the first IDAT is the whole
            // question — never what one says, nor whether a late one exists.
            ("png early o6", png_with_exif(&png, &t(6), false), None),
            ("png early o3", png_with_exif(&png, &t(3), false), None),
            ("png early unreadable", png_with_exif(&png, &c3, false), None),
            ("png early prefixed", png_with_exif(&png, &prefixed, false), None),
            ("png early 1 late 6", left("png_1_then_late6"), None),
            ("png two early", left("png_two_early_1_6"), None),
            ("png late o6", png_with_exif(&png, &t(6), true), p),
            ("png late o8 le", png_with_exif(&png, &tiff_orientation(8, true), true), p),
            ("png late o3", png_with_exif(&png, &t(3), true), p),
            ("png late o1", png_with_exif(&png, &t(1), true), p),
            ("png late unreadable", png_with_exif(&png, &c3, true), p),
            ("png late prefixed", png_with_exif(&png, &prefixed, true), p),
            ("png late o6 bad crc", left("png_late6_badcrc"), p),
            ("png late o6 then 70 KB", past("png_late6_then_70k_text"), p),
            ("png late o6 65527-byte block", past("png_late6_65527_block"), p),
            ("png none", png.clone(), p),
            // A walk that never reaches IDAT cannot say.
            ("png late past the cap", far, None),
            ("png iend first", iend_first, None),
            ("png ihdr only", png[..33].to_vec(), None),
            // WebP and TIFF: never turned by the WebView, so always flagged —
            // an unreadable block's size is read all the same.
            ("webp o6", webp_with_exif(&webp, 70, 40, &t(6)), w),
            ("webp o2", webp_with_exif(&webp, 70, 40, &t(2)), w),
            ("webp o1", webp_with_exif(&webp, 70, 40, &t(1)), w),
            ("webp unreadable", webp_with_exif(&webp, 70, 40, &c3), w),
            ("webp none", webp.clone(), w),
            ("tiff o7", tiny_tiff(120, 48, 7), tf),
            ("tiff none", tiny_tiff(120, 48, 0), tf),
            // Nothing to turn by, or not a still this reader knows: never
            // flagged. A video above all.
            ("bmp", tiny_bmp(90, -30), None),
            ("gif", b"GIF89a\x40\0\x24\0\0\0\0\0".to_vec(), None),
            ("avi", b"RIFF\x24\0\0\0AVI LIST\0\0\0\0".to_vec(), None),
            ("mp4", b"\0\0\0\x18ftypmp42\0\0\0\0".to_vec(), None),
            ("mkv", vec![0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0], None),
            ("too short", vec![0xFF, 0xD8], None),
            ("empty", vec![], None),
        ];
        for (name, bytes, want) in rows {
            let still = still_bytes(&bytes);
            assert_eq!(still.no_autorotate, want.is_some(), "{name}");
            assert_eq!(still.coded, want, "{name}: coded");
            let sniff = if still.no_autorotate { None } else { sniff_bytes(&bytes) };
            assert_eq!(still.sniff, sniff, "{name}: the sniff is the sniff, and only a followed still's");
            let flag = flag_reader(&mut Cursor::new(&bytes));
            assert_eq!(flag, Flag { no_autorotate: still.no_autorotate, coded: still.coded }, "{name}: read_flag");
        }
    }

    /// A BMP has no orientation to turn by, and says so with its own size —
    /// so the probe's `Some(s) if !s.transposes()` spends no frame probe on
    /// it. Both DIB header shapes; a negative height is row order, not size;
    /// a negative or zero width, a header size it does not know and a
    /// truncated header are no answer at all.
    #[test]
    fn a_bmp_sniffs_as_upright_at_its_own_size() {
        assert_eq!(sniff_bytes(&tiny_bmp(90, 30)), Some(Sniff { orientation: 1, coded: (90, 30) }));
        assert_eq!(sniff_bytes(&tiny_bmp(90, -30)), Some(Sniff { orientation: 1, coded: (90, 30) }));
        let mut core = tiny_bmp(0, 0)[..14].to_vec();
        core.extend_from_slice(&12u32.to_le_bytes());
        core.extend_from_slice(&90u16.to_le_bytes());
        core.extend_from_slice(&30u16.to_le_bytes());
        core.extend_from_slice(&[1, 0, 24, 0]);
        assert_eq!(sniff_bytes(&core), Some(Sniff { orientation: 1, coded: (90, 30) }));
        // The one height with no positive i32: taken whole, never a panic.
        assert_eq!(sniff_bytes(&tiny_bmp(90, i32::MIN)).map(|s| s.coded), Some((90, 1 << 31)));
        let mut unknown = tiny_bmp(90, 30);
        unknown[14] = 13;
        for (name, bytes) in [
            ("negative width", tiny_bmp(-90, 30)),
            ("zero width", tiny_bmp(0, 30)),
            ("zero height", tiny_bmp(90, 0)),
            ("unknown header size", unknown),
            ("truncated", tiny_bmp(90, 30)[..20].to_vec()),
        ] {
            assert_eq!(sniff_bytes(&bytes), None, "{name}");
        }
    }

    /// `png_unturned` on its own, at its edges: the same late eXIf 6 flagged
    /// or not by nothing but a chunk before IDAT — an early eXIf of 1 (no
    /// turn), which the WebView reads and ffmpeg overrides with the late one —
    /// and a PNG flagged with no tag at all, or a late 1, because the rule
    /// never reads one. What follows IDAT is never looked at: the verifier's
    /// two past-the-window files are flagged on the chunk headers alone.
    #[test]
    fn a_png_is_flagged_by_where_its_exif_sits() {
        let png = tiny_png(50, 20);
        let t6 = tiff_orientation(6, false);
        let late = png_with_exif(&png, &t6, true);
        let unturned = |b: &[u8]| png_unturned(&mut Cursor::new(b));
        let early_1_then_late = png_with_exif(&png_with_exif(&png, &tiff_orientation(1, false), false), &t6, true);
        assert_eq!(unturned(&late), Some((50, 20)));
        assert_eq!(unturned(&png_with_exif(&png, &tiff_orientation(1, false), true)), Some((50, 20)));
        assert_eq!(unturned(&png), Some((50, 20)));
        for (name, bytes) in png_exif_past_the_tail(&png) {
            assert_eq!(unturned(&bytes), Some((50, 20)), "{name}");
        }
        assert_eq!(unturned(&early_1_then_late), None);
        assert_eq!(unturned(&png_with_exif(&png, &t6, false)), None);
        // A bad IHDR or no IDAT at all: the walk cannot say, so it does not.
        let mut bad_ihdr = late.clone();
        bad_ihdr[11] = 14;
        assert_eq!(unturned(&bad_ihdr), None);
        let iend_first: Vec<u8> = [&late[..33], &png_chunk(b"IEND", &[])[..]].concat();
        assert_eq!(unturned(&iend_first), None);
        // Every prefix of a flagged file: no panic, never the flag before the
        // walk has read IDAT's header, always the flag once it has — nothing
        // past that header takes part.
        for n in 0..late.len() {
            assert_eq!(still_bytes(&late[..n]).no_autorotate, n >= 33 + 8, "prefix {n}");
        }
    }

    /// Malformed PNGs the flag walk meets before any IDAT: IHDR and nothing
    /// else, a chunk whose length runs to `u32::MAX` (the next header would
    /// sit 4 GB past the end), and every IHDR field corrupted in turn. No
    /// panic, and never the flag — a walk that never reaches IDAT cannot say.
    #[test]
    fn a_malformed_png_is_never_flagged_and_never_panics() {
        let png = tiny_png(50, 20);
        let ihdr_only = png[..33].to_vec();
        let mut overflow: Vec<u8> = png[..33].to_vec();
        overflow.extend(png_chunk(b"tEXt", b"k\0v"));
        overflow[33..37].copy_from_slice(&[0xFF; 4]);
        overflow.extend_from_slice(&png[33..]);
        for (name, bytes) in [("ihdr only", ihdr_only), ("length overflow", overflow)] {
            let still = still_bytes(&bytes);
            assert!(!still.no_autorotate, "{name}");
            assert_eq!(still.coded, None, "{name}");
            assert_eq!(flag_reader(&mut Cursor::new(&bytes)), NOT_A_STILL, "{name}");
        }
        for i in 8..33 {
            let mut bad = png.clone();
            bad[i] ^= 0xA5;
            let _ = still_bytes(&bad);
            let _ = flag_reader(&mut Cursor::new(&bad));
        }
    }

    /// Through the file: behind the regular-file guard (`open_regular`), both
    /// entry points. A real late-eXIf PNG is flagged at its coded size, its
    /// sniff never read; an early one is followed and sniffed; a directory, a
    /// missing path and a file too short to name a format are nothing at all.
    #[test]
    fn read_still_is_behind_the_regular_file_guard() {
        let dir = std::env::temp_dir().join("taroting read still test");
        std::fs::create_dir_all(&dir).unwrap();
        let late = dir.join("late.png");
        std::fs::write(&late, png_with_exif(&tiny_png(50, 20), &tiff_orientation(6, false), true)).unwrap();
        assert_eq!(read_still(&late), Still { sniff: None, no_autorotate: true, coded: Some((50, 20)) });
        assert_eq!(read_flag(&late), Flag { no_autorotate: true, coded: Some((50, 20)) });
        let early = dir.join("early.png");
        std::fs::write(&early, png_with_exif(&tiny_png(50, 20), &tiff_orientation(6, false), false)).unwrap();
        let sniffed = Some(Sniff { orientation: 6, coded: (50, 20) });
        assert_eq!(read_still(&early), Still { sniff: sniffed, no_autorotate: false, coded: None });
        assert_eq!(read_flag(&early), NOT_A_STILL);
        let short = dir.join("short.jpg");
        std::fs::write(&short, [0xFF, 0xD8]).unwrap();
        let nothing = Still { sniff: None, no_autorotate: false, coded: None };
        for path in [short, dir.join("absent.webp"), dir.clone()] {
            assert_eq!(read_still(&path), nothing, "{path:?}");
            assert_eq!(read_flag(&path), NOT_A_STILL, "{path:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tiff_reads_its_own_ifd0() {
        // II TIFF: width 0x100 LONG 120, height 0x101 SHORT 48, orientation 7.
        let mut b = b"II*\0\x08\0\0\0".to_vec();
        b.extend_from_slice(&3u16.to_le_bytes());
        for (tag, ty, v) in [(0x100u16, 4u16, 120u32), (0x101, 3, 48), (0x112, 3, 7)] {
            b.extend_from_slice(&tag.to_le_bytes());
            b.extend_from_slice(&ty.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes());
            if ty == 3 {
                b.extend_from_slice(&(v as u16).to_le_bytes());
                b.extend_from_slice(&[0, 0]);
            } else {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(sniff_bytes(&b), Some(Sniff { orientation: 7, coded: (120, 48) }));

        // The same file with its orientation of count 3, out of line: the
        // size is readable, the turn is not this reader's to call.
        let count_at = 10 + 2 * 12 + 4; // the third entry's count
        b[count_at] = 3;
        assert_eq!(sniff_bytes(&b), None);
    }

    /// Orientation values the decoder does not act on, and a 0x0112 of the
    /// wrong type, report 1 — the answer that changes nothing.
    #[test]
    fn out_of_range_or_mistyped_orientation_is_one() {
        let base = tiny_jpeg(64, 36);
        for o in [0u16, 9, 0xFFFF] {
            let s = sniff_bytes(&jpeg_with_exif(&base, &tiff_orientation(o, false))).unwrap();
            assert_eq!(s.orientation, 1, "o{o}");
        }
        let mut long = tiff_orientation(6, false);
        long[13] = 4; // type LONG instead of SHORT
        assert_eq!(sniff_bytes(&jpeg_with_exif(&base, &long)).unwrap().orientation, 1);
    }

    /// WHICH 0x0112 entry decides, when IFD0 holds more than one — each row
    /// measured on the bundled ffmpeg: the first SHORT with a count of at
    /// least 1. Skipping a count-0 or mistyped entry matters in the dangerous
    /// direction: count 0 then 6 ROTATES, so stopping at the count-0 entry
    /// would say 1. And a deciding count-3 entry stays decisive (`None`) even
    /// ahead of a readable 1, which is also what ffmpeg rotates by.
    #[test]
    fn the_first_short_with_a_value_decides() {
        let base = tiny_jpeg(64, 36);
        let o = |v: u32| (0x0112u16, 3u16, 1u32, v);
        let rows: [(&str, Vec<(u16, u16, u32, u32)>, Option<u8>); 6] = [
            ("c0_short6", vec![(0x0112, 3, 0, 6), o(6)], Some(6)),
            ("long6_short1", vec![(0x0112, 4, 1, 6), o(1)], Some(1)),
            ("sshort6_short1", vec![(0x0112, 8, 1, 6), o(1)], Some(1)),
            ("short0_short6", vec![o(0), o(6)], Some(1)),
            ("duptag_1_6", vec![o(1), o(6)], Some(1)),
            ("duptag_6_1", vec![o(6), o(1)], Some(6)),
        ];
        for (name, entries, want) in rows {
            let s = sniff_bytes(&jpeg_with_exif(&base, &tiff_entries(&entries, &[])));
            assert_eq!(s.map(|s| s.orientation), want, "{name}");
        }
        let c3_then_1 = tiff_entries(&[(0x0112, 3, 3, 38), o(1)], &[0, 6, 0, 6, 0, 6]);
        assert_eq!(sniff_bytes(&jpeg_with_exif(&base, &c3_then_1)), None);
    }

    /// Every JPEG `exif_left_to_ffmpeg` builds is `None`: the four shapes a
    /// verifier found this reader settling on 1 while ffmpeg turned the frame,
    /// the second block after the SOF (the walk now runs to SOS), and the
    /// two-block row that fixes the rule's shape.
    #[test]
    fn a_jpeg_the_reader_cannot_vouch_for_is_left_to_ffmpeg() {
        for (name, jpeg, _) in exif_left_to_ffmpeg(&tiny_jpeg(64, 36)) {
            assert_eq!(sniff_bytes(&jpeg), None, "{name}");
        }
        // Two blocks that agree are still two blocks.
        let t6 = tiff_orientation(6, false);
        let twice = jpeg_with_exif(&jpeg_with_exif(&tiny_jpeg(64, 36), &t6), &t6);
        assert_eq!(sniff_bytes(&twice), None);
    }

    /// Counting Exif APP1s must not count the XMP APP1 a camera or an editor
    /// writes beside one ("http://ns.adobe.com/xap/1.0/"): one Exif block and
    /// an XMP packet, either order, still vouch.
    #[test]
    fn an_xmp_app1_is_not_a_second_exif_block() {
        let xmp_id = b"http:/";
        let xmp_rest = b"/ns.adobe.com/xap/1.0/\0<x/>";
        let t6 = tiff_orientation(6, false);
        let exif_then_xmp = jpeg_with_exif(&jpeg_with_exif_id(&tiny_jpeg(64, 36), xmp_id, xmp_rest), &t6);
        let xmp_then_exif = jpeg_with_exif_id(&jpeg_with_exif(&tiny_jpeg(64, 36), &t6), xmp_id, xmp_rest);
        for j in [exif_then_xmp, xmp_then_exif] {
            assert_eq!(sniff_bytes(&j), Some(Sniff { orientation: 6, coded: (64, 36) }));
        }
    }

    /// The entry cap, at its edge: a table of exactly `MAX_IFD_ENTRIES` is
    /// read; one more is unreadable, which is `None` — not the "no
    /// orientation" it used to be (ffmpeg reads 300 and rotates).
    #[test]
    fn the_ifd0_entry_cap_is_unknown_not_upright() {
        let table = |n: usize| {
            let mut e = vec![(0x0112u16, 3u16, 1u32, 6u32)];
            e.extend((1..n as u16).map(|i| (0xC000 + i, 3, 1, 0)));
            jpeg_with_exif(&tiny_jpeg(64, 36), &tiff_entries(&e, &[]))
        };
        assert_eq!(sniff_bytes(&table(MAX_IFD_ENTRIES)).map(|s| s.orientation), Some(6));
        assert_eq!(sniff_bytes(&table(MAX_IFD_ENTRIES + 1)), None);
    }

    /// An APP1 of just "Exif" or "Exif\0" holds no block. ffmpeg skips it,
    /// but it is still an Exif APP1 to count, and alone it is unreadable:
    /// `None`, without the `body_len - 6` that would underflow on it.
    #[test]
    fn an_exif_stub_is_counted_and_never_underflows() {
        let base = tiny_jpeg(64, 36);
        let with_stub = |body: &[u8], rest: &[u8]| {
            let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
            out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(&rest[2..]);
            out
        };
        for stub in [b"Exif".as_slice(), b"Exif\0"] {
            assert_eq!(sniff_bytes(&with_stub(stub, &base)), None, "{stub:?}");
            let then_6 = jpeg_with_exif(&base, &tiff_orientation(6, false));
            assert_eq!(sniff_bytes(&with_stub(stub, &then_6)), None, "{stub:?} then 6");
        }
    }

    /// ffmpeg matches an APP1 on "Exif" alone and skips the next two bytes,
    /// and honours a count-2 SHORT orientation on its first value — two places
    /// this reader was once STRICTER than ffmpeg, which is the dangerous
    /// direction: a sniff saying 1 where the decoder turns the frame is never
    /// re-checked, so the coded size would be stored.
    #[test]
    fn the_app1_id_is_four_bytes_and_a_count_two_orientation_counts() {
        let base = tiny_jpeg(64, 36);
        for id in [b"Exif\0\0", b"Exif\0\xFF", b"ExifXY"] {
            for le in [false, true] {
                let s = sniff_bytes(&jpeg_with_exif_id(&base, id, &tiff_orientation(6, le))).unwrap();
                assert_eq!(s, Sniff { orientation: 6, coded: (64, 36) }, "{id:?} le={le}");
            }
        }
        // Not "Exif" at all: some other APP1 (XMP, say), no orientation.
        let s = sniff_bytes(&jpeg_with_exif_id(&base, b"ExiX\0\0", &tiff_orientation(6, false))).unwrap();
        assert_eq!(s.orientation, 1);

        // Count 1 and 2 are read on their first value, in either byte order;
        // count 0 carries no value, and ffmpeg does not rotate by it. Count 3+
        // keeps its values out of line, where ffmpeg follows the offset — so
        // it is not this reader's call: `None`, never the 1 it used to be.
        for le in [false, true] {
            for (count, want) in [(0u8, Some(1u8)), (1, Some(6)), (2, Some(6)), (3, None), (0xFF, None)] {
                let mut t = tiff_orientation(6, le);
                let at = if le { 14 } else { 17 }; // low byte of the entry's count
                t[at] = count;
                let s = sniff_bytes(&jpeg_with_exif(&base, &t));
                assert_eq!(s.map(|s| s.orientation), want, "count {count} le={le}");
            }
        }
        // Width and height stay count-1 only: a count-2 SHORT width in a TIFF
        // is not a size.
        let mut b = b"II*\0\x08\0\0\0".to_vec();
        b.extend_from_slice(&2u16.to_le_bytes());
        for (tag, count) in [(0x100u16, 2u32), (0x101, 1)] {
            b.extend_from_slice(&tag.to_le_bytes());
            b.extend_from_slice(&3u16.to_le_bytes());
            b.extend_from_slice(&count.to_le_bytes());
            b.extend_from_slice(&[48, 0, 0, 0]);
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(sniff_bytes(&b), None, "a count-2 width must not be read as the width");
    }

    /// Knowingly LENIENT: on every layout ffmpeg was measured to drop the whole
    /// EXIF block for, this reader still reports the IFD0 orientation. That is
    /// the safe direction only because a 5..=8 answer is always confirmed by
    /// the frame probe (import and load-time repair alike) — pinned here so a
    /// later "fix" that starts imitating ffmpeg's rejections is a decision,
    /// not an accident.
    #[test]
    fn a_block_ffmpeg_rejects_is_still_sniffed_as_a_candidate() {
        let base = tiny_jpeg(64, 36);
        for (name, t) in ffmpeg_rejected_exif() {
            let s = sniff_bytes(&jpeg_with_exif(&base, &t)).unwrap();
            assert_eq!(s, Sniff { orientation: 6, coded: (64, 36) }, "{name}");
        }
    }

    /// Every prefix of every well-formed input, plus corrupted length fields:
    /// no panic, and never an invented transposition.
    #[test]
    fn truncated_and_malformed_input_never_panics() {
        let t6 = tiff_orientation(6, false);
        let inputs = [
            jpeg_with_exif(&tiny_jpeg(64, 36), &t6),
            png_with_exif(&tiny_png(50, 20), &t6, true),
            png_with_exif(&tiny_png(50, 20), &t6, false),
            webp_with_exif(&riff(&[vp8l(70, 40)]), 70, 40, &t6),
            riff(&[vp8(90, 24)]),
            tiny_tiff(120, 48, 6),
            tiny_bmp(90, -30),
        ];
        for full in &inputs {
            for n in 0..full.len() {
                if let Some(s) = sniff_bytes(&full[..n]) {
                    assert!(s.coded.0 > 0 && s.coded.1 > 0);
                }
                let still = still_bytes(&full[..n]);
                assert!(still.coded.is_none_or(|(w, h)| w > 0 && h > 0));
                let _ = flag_reader(&mut Cursor::new(&full[..n]));
            }
            // Flip every byte in turn: whatever comes back, it must not panic
            // — the sniff, nor the rule's own walks.
            for i in 0..full.len() {
                let mut bad = full.clone();
                bad[i] ^= 0xA5;
                let _ = sniff_bytes(&bad);
                let _ = still_bytes(&bad);
                let _ = flag_reader(&mut Cursor::new(&bad));
            }
        }

        // A JPEG segment length below 2, and one pointing far past EOF.
        let mut j = tiny_jpeg(64, 36);
        j[4..6].copy_from_slice(&[0, 1]);
        assert_eq!(sniff_bytes(&j), None);
        let mut j = tiny_jpeg(64, 36);
        j[4..6].copy_from_slice(&[0xFF, 0xFF]);
        assert_eq!(sniff_bytes(&j), None, "no SOF was ever reached");

        // An IFD0 claiming 65535 entries in a 26-byte block: unreadable, so
        // no orientation is vouched for — not even "none" (ffmpeg drops this
        // block; with a second one beside it, it honours that one instead).
        let mut huge = t6.clone();
        huge[8..10].copy_from_slice(&[0xFF, 0xFF]);
        assert_eq!(sniff_bytes(&jpeg_with_exif(&tiny_jpeg(64, 36), &huge)), None);

        // A chunk length at u32::MAX (PNG) and a RIFF size at u32::MAX (WebP).
        let mut p = tiny_png(50, 20);
        p[33..37].copy_from_slice(&[0xFF; 4]);
        let _ = sniff_bytes(&p);
        let mut w = riff(&[vp8(90, 24)]);
        w[4..8].copy_from_slice(&[0xFF; 4]);
        assert_eq!(sniff_bytes(&w).map(|s| s.coded), Some((90, 24)));

        // Zero sizes are not sizes.
        assert_eq!(sniff_bytes(&tiny_jpeg(0, 36)), None);
        assert_eq!(sniff_bytes(&tiny_png(50, 0)), None);

        // Not an image at all, and too short to tell.
        assert_eq!(sniff_bytes(b"GIF89a......"), None);
        assert_eq!(sniff_bytes(&[0xFF, 0xD8]), None);
        assert_eq!(sniff_bytes(&[]), None);
    }

    /// Ten thousand empty PNG chunks ahead of an eXIf: the walk stops at its
    /// cap without reading them all, and — having never reached IDAT — says it
    /// does not know rather than vouching for "no orientation".
    #[test]
    fn chunk_and_segment_walks_are_capped() {
        let mut p = tiny_png(50, 20);
        let idat = 33;
        let mut filler = Vec::new();
        for _ in 0..10_000 {
            filler.extend(png_chunk(b"tEXt", &[]));
        }
        let mut late = p[..idat].to_vec();
        late.extend(filler);
        late.extend(png_chunk(b"eXIf", &tiff_orientation(6, false)));
        late.extend_from_slice(&p[idat..]);
        p = late;
        assert_eq!(sniff_bytes(&p), None);

        // The SOF already read, then 200 COM segments ahead of an Exif APP1:
        // the JPEG walk gives up without vouching for orientation 1.
        let j = jpeg_with_exif(&tiny_jpeg(64, 36), &tiff_orientation(6, false));
        let app1_end = 4 + u16::from_be_bytes([j[4], j[5]]) as usize;
        let sos = j.windows(2).rposition(|w| w == [0xFF, 0xDA]).unwrap();
        let mut many = vec![0xFF, 0xD8];
        many.extend_from_slice(&j[app1_end..sos]); // APP0-less DQT + SOF
        for _ in 0..200 {
            many.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x02]);
        }
        many.extend_from_slice(&j[2..app1_end]); // the APP1
        many.extend_from_slice(&j[sos..]);
        assert_eq!(sniff_bytes(&many), None);

        // Same for a WebP: a bitstream, 100 unknown chunks, then EXIF.
        let mut chunks = vec![vp8l(70, 40)];
        chunks.extend(std::iter::repeat_n(riff_chunk(b"XTRA", &[]), 100));
        chunks.push(riff_chunk(b"EXIF", &tiff_orientation(6, false)));
        assert_eq!(sniff_bytes(&riff(&chunks)), None);
    }
}
