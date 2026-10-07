//! Where a damaged H.264 recording becomes readable again — read straight
//! from the MP4/MOV structure, no ffmpeg, so the answer costs a fraction of a
//! second where a decode costs the whole file.
//!
//! The shape it looks for is a real one: an NVIDIA Instant Replay file whose
//! first minute was scrambled at save time. The 4-byte AVCC length prefixes
//! survived, so every sample still splits into NAL units; their CONTENTS are
//! random (reserved types, the forbidden bit set, slice headers naming
//! parameter sets that do not exist). A run of sound P-frames that reference
//! the garbage follows, then the first clean IDR, and every sample after it
//! is sound. The `stss` box flags hundreds of the garbage samples as sync
//! samples too, so the container's own keyframe table cannot find the clean
//! start: only the bytes can.
//!
//! The answer is the presentation time of that first clean IDR. The preview
//! uses it to make an instant stream copy whose video starts there (lossless,
//! no decode; `prepare::quick_repair_args`), while the full repair decodes
//! the whole file behind it.
//!
//! Everything here reads an untrusted file and runs in a release build with
//! `panic = "abort"`: every size is checked against its parent and the file,
//! every table's entry count against the box that holds it, every index
//! through `get`, every sum checked. Anything that does not add up is `None`
//! — "no damaged prefix found" — which only means the preview waits for the
//! full repair.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// The largest `moov` read into memory. Its sample tables grow with the
/// recording (~16 bytes per sample): 64 MiB is a day of 60 fps video, and a
/// crafted size beyond it is refused before anything is allocated.
const MAX_MOOV: u64 = 64 << 20;

/// The most samples one scan visits — one small read each. Far above any
/// recording (19 hours at 60 fps); a crafted table that claims more is
/// answered `None` at once rather than walked.
const MAX_SAMPLES: u64 = 1 << 22;

/// Top-level boxes looked at while finding `moov`. A real file has a handful
/// (`ftyp`, `mdat`, `moov`, maybe `free`); this bounds a crafted file made of
/// millions of empty boxes.
const MAX_TOP_BOXES: usize = 1024;

/// Bytes of a NAL unit read past its length prefix: the 1-byte header and
/// enough of a slice header for `first_mb_in_slice`, `slice_type` and
/// `pic_parameter_set_id` — at most 31 + 9 + 17 bits as Exp-Golomb codes,
/// plus room for emulation-prevention bytes.
const NAL_HEAD: usize = 16;

/// Bytes fetched per read. One read usually covers a sample's length prefix
/// and its first NAL's header; the next sample is ~10-200 KB further on, so a
/// bigger window would only copy video data nobody looks at.
const WINDOW: usize = 512;

/// The presentation time, in seconds from 0, of the first clean IDR of
/// `path`'s video when the file opens on a damaged PREFIX — `None` for a
/// clean file, for damage anywhere else, for a prefix with no clean IDR after
/// it, and for anything this does not read (not an `avc1` H.264 track in an
/// MP4/MOV, a fragmented file, an unreadable or crafted one).
///
/// Per sample (in decode order), a sample is SOUND when its NAL length
/// prefixes tile it exactly; every NAL has forbidden_zero_bit 0 and a type
/// in {1, 5, 6, 7, 8, 9, 10, 11, 12}; it holds at least one slice (type 1 or
/// 5) and all its slices share one type; each slice header parses
/// (`first_mb_in_slice`, `slice_type` <= 9, `pic_parameter_set_id` among the
/// `avcC` record's PPS ids); the first slice starts the picture
/// (`first_mb_in_slice` 0); and an IDR slice is a reference (nal_ref_idc != 0)
/// of an I/SI type, as the standard requires of every IDR.
///
/// The answer is the first sound IDR after which every sample to the end is
/// sound — and only when the damage is a PREFIX: no sound IDR comes before the
/// first unsound sample. A file that opens on a sound keyframe and breaks
/// later is not answered (the damage is "elsewhere"): an instant copy from
/// the clean IDR would hide its good opening. Garbage samples that happen to
/// pass (a few in thousands do) change nothing, since the answer is taken
/// after the LAST unsound sample. The IDR must also be a sync sample in
/// `stss` (when the box exists): the instant copy seeks to it, and a seek
/// lands on the sync sample at or before its target.
///
/// pts = (dts + composition offset - the edit list's media_time) / timescale,
/// for an edit list of one edit at most; an empty edit (a start offset) or a
/// splice is not read, and not answered (`single_edit_media_time`).
/// Reads the sample tables and then, per sample, only its NAL length prefixes
/// and the first bytes of each NAL, in file order.
pub fn scan_damaged_prefix(path: &Path) -> Option<f64> {
    let file = open_forward(path).ok()?;
    let len = file.metadata().ok()?.len();
    scan(file, len)
}

/// `path` opened for reading, telling Windows the reads only move forward
/// (`FILE_FLAG_SEQUENTIAL_SCAN`), so its cache reads ahead in large runs.
/// The scan touches every sample's first bytes — one small read every ~60 KB
/// — and from a cold cache each became its own disk read. Measured on the
/// three-minute 622 MB recording, NVMe, cold (an unbuffered copy): 560 ms
/// without the hint, 272 ms with it; warm, 19 ms either way. The price: a
/// cold scan pulls the whole file through the (evictable) cache. When the
/// scan starts the repair, the copies that follow read the file whole anyway
/// and find it there; when a finished repair only asks how long the damage
/// runs (`playability::plan_repair`, the first plan of a repaired file in a
/// run — later ones answer from `playability::ScanMemo`), nothing else reads
/// it.
fn open_forward(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
        options.custom_flags(FILE_FLAG_SEQUENTIAL_SCAN);
    }
    options.open(path)
}

/// `scan_damaged_prefix` over any seekable bytes of length `len`, so the
/// tests run it on files built in memory.
fn scan<R: Read + Seek>(source: R, len: u64) -> Option<f64> {
    let mut reader = Reader::new(source, len);
    let moov = read_moov(&mut reader)?;
    let track = VideoTrack::parse(&moov)?;
    let first_clean = find_first_clean(&mut reader, &track)?;
    track.pts_seconds(first_clean)
}

/* ------------------------------------------------------------------ */
/* bytes                                                               */
/* ------------------------------------------------------------------ */

fn be16(buf: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(buf.get(at..at.checked_add(2)?)?.try_into().ok()?))
}

fn be32(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(buf.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn be64(buf: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(buf.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

/// The file, read forward in small windows. Positioned reads of what is
/// needed and nothing else: a large buffered reader would drag the whole
/// recording through memory (a 256 KiB refill per ~60 KB sample), where this
/// reads ~512 bytes per sample.
struct Reader<R> {
    source: R,
    len: u64,
    buf: Vec<u8>,
    /// File offset of `buf[0]`; `buf` holds exactly the bytes read there.
    start: u64,
}

impl<R: Read + Seek> Reader<R> {
    fn new(source: R, len: u64) -> Self {
        Reader { source, len, buf: Vec::with_capacity(WINDOW), start: 0 }
    }

    /// `n` bytes at `pos`, or `None` when they are not all in the file or
    /// cannot be read. Served from the last window when it holds them.
    fn bytes(&mut self, pos: u64, n: usize) -> Option<&[u8]> {
        let end = pos.checked_add(n as u64)?;
        if end > self.len {
            return None;
        }
        let buffered_end = self.start.checked_add(self.buf.len() as u64)?;
        if pos < self.start || end > buffered_end {
            // Never past the end of the file: a window there would fail the
            // whole read.
            let want = usize::try_from((self.len - pos).min(n.max(WINDOW) as u64)).ok()?;
            self.buf.resize(want, 0);
            self.source.seek(SeekFrom::Start(pos)).ok()?;
            self.source.read_exact(&mut self.buf).ok()?;
            self.start = pos;
        }
        let from = usize::try_from(pos - self.start).ok()?;
        self.buf.get(from..from.checked_add(n)?)
    }

    /// The whole of `len` bytes at `pos` as an owned buffer (the `moov`).
    fn owned(&mut self, pos: u64, len: u64) -> Option<Vec<u8>> {
        if pos.checked_add(len)? > self.len {
            return None;
        }
        let mut out = vec![0; usize::try_from(len).ok()?];
        self.source.seek(SeekFrom::Start(pos)).ok()?;
        self.source.read_exact(&mut out).ok()?;
        Some(out)
    }
}

/* ------------------------------------------------------------------ */
/* boxes                                                               */
/* ------------------------------------------------------------------ */

/// A box header at `at` inside a parent ending at `end`: (type, header size,
/// whole size). `None` when the size is smaller than its own header or runs
/// past the parent. Size 0 means "to the end of the parent", size 1 a 64-bit
/// size after the type.
fn box_header(head: &[u8], at: u64, end: u64) -> Option<([u8; 4], u64, u64)> {
    let typ: [u8; 4] = head.get(4..8)?.try_into().ok()?;
    let (header, size) = match be32(head, 0)? {
        0 => (8, end.checked_sub(at)?),
        1 => (16, be64(head, 8)?),
        n => (8, u64::from(n)),
    };
    if size < header || at.checked_add(size)? > end {
        return None;
    }
    Some((typ, header, size))
}

/// The children of a box body, as (type, body). `None` when any child is
/// malformed — a table that does not add up is not worth guessing at. A tail
/// shorter than a box header is ignored (some writers pad).
fn children(body: &[u8]) -> Option<Vec<([u8; 4], &[u8])>> {
    let end = body.len() as u64;
    let mut out = Vec::new();
    let mut at = 0u64;
    while end - at >= 8 {
        let start = usize::try_from(at).ok()?;
        let (typ, header, size) = box_header(body.get(start..)?, at, end)?;
        let from = usize::try_from(at + header).ok()?;
        let to = usize::try_from(at + size).ok()?;
        out.push((typ, body.get(from..to)?));
        at += size;
    }
    Some(out)
}

/// The body of the first child of type `typ`; `None` if there is none or the
/// children do not parse.
fn child<'a>(body: &'a [u8], typ: &[u8; 4]) -> Option<&'a [u8]> {
    children(body)?.into_iter().find(|(t, _)| t == typ).map(|(_, b)| b)
}

/// `child` along a path of types.
fn descend<'a>(body: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
    path.iter().try_fold(body, |b, typ| child(b, typ))
}

/// The top-level `moov` box's body, read whole (bounded by `MAX_MOOV`).
/// Found by walking the top-level box headers, so a recording whose `moov`
/// sits after a 600 MB `mdat` costs a few seeks, not a read of the `mdat`.
fn read_moov<R: Read + Seek>(r: &mut Reader<R>) -> Option<Vec<u8>> {
    let mut at = 0u64;
    for _ in 0..MAX_TOP_BOXES {
        if r.len - at < 8 {
            return None;
        }
        let head = r.bytes(at, (r.len - at).min(16) as usize)?.to_vec();
        let (typ, header, size) = box_header(&head, at, r.len)?;
        if &typ == b"moov" {
            let body = size - header;
            if body > MAX_MOOV {
                return None;
            }
            return r.owned(at + header, body);
        }
        at += size;
    }
    None
}

/* ------------------------------------------------------------------ */
/* the video track                                                     */
/* ------------------------------------------------------------------ */

/// What the scan needs of the first video track, every table checked
/// against the box that holds it.
struct VideoTrack<'a> {
    timescale: u32,
    /// Bytes in each NAL length prefix: 1, 2 or 4.
    length_size: usize,
    /// The `pic_parameter_set_id`s of the `avcC` record's PPS NAL units.
    pps_ids: Vec<u32>,
    sample_count: u32,
    /// `stsz`'s uniform size, or 0 with one size per sample in `sizes`.
    uniform_size: u32,
    sizes: &'a [u8],
    /// Chunk offsets, 4 or 8 bytes each (`stco`/`co64`).
    chunks: &'a [u8],
    chunk_width: usize,
    /// `stsc` runs: (first chunk, 1-based; samples per chunk).
    runs: Vec<(u32, u32)>,
    /// `stts` entries, 8 bytes each: (count, delta).
    stts: &'a [u8],
    /// `ctts` entries, 8 bytes each, and whether offsets are signed (v1).
    ctts: Option<(&'a [u8], bool)>,
    /// The single edit's media_time (0 without an edit list).
    media_time: i64,
    /// `stss` sample numbers (1-based, ascending), 4 bytes each; `None`
    /// when the box is absent, i.e. every sample is a sync sample.
    sync: Option<&'a [u8]>,
}

/// A full box's table: the entries after version/flags and an entry count,
/// `width` bytes each, all inside the body. Returns (version, count, entries).
fn table(body: &[u8], width: usize) -> Option<(u8, u32, &[u8])> {
    let version = *body.first()?;
    let count = be32(body, 4)?;
    let bytes = usize::try_from(count).ok()?.checked_mul(width)?;
    Some((version, count, body.get(8..8usize.checked_add(bytes)?)?))
}

/// The total of the count column of an (count, value) table, 8 bytes per
/// entry — what `stts` and `ctts` must sum to.
fn counted(entries: &[u8]) -> Option<u64> {
    entries.chunks_exact(8).try_fold(0u64, |sum, e| sum.checked_add(u64::from(be32(e, 0)?)))
}

impl<'a> VideoTrack<'a> {
    fn parse(moov: &'a [u8]) -> Option<Self> {
        let top = children(moov)?;
        // A fragmented file's samples live in `moof` boxes this does not read.
        if top.iter().any(|(t, _)| t == b"mvex") {
            return None;
        }
        // The FIRST video track, as ffmpeg's `0:v:0` (the stream the instant
        // copy maps) — and if it is not avc1 H.264, no answer.
        let trak = top.into_iter().filter(|(t, _)| t == b"trak").map(|(_, b)| b).find(|trak| {
            descend(trak, &[b"mdia", b"hdlr"]).and_then(|h| h.get(8..12)) == Some(b"vide".as_slice())
        })?;
        let mdia = child(trak, b"mdia")?;
        let mdhd = child(mdia, b"mdhd")?;
        let timescale = match mdhd.first()? {
            0 => be32(mdhd, 12)?,
            1 => be32(mdhd, 20)?,
            _ => return None,
        };
        if timescale == 0 {
            return None;
        }
        let stbl = descend(mdia, &[b"minf", b"stbl"])?;
        let (length_size, pps_ids) = avc1_config(child(stbl, b"stsd")?)?;

        let stsz = child(stbl, b"stsz")?;
        let uniform_size = be32(stsz, 4)?;
        let sample_count = be32(stsz, 8)?;
        if u64::from(sample_count) > MAX_SAMPLES || sample_count == 0 {
            return None;
        }
        let sizes = if uniform_size == 0 {
            let bytes = usize::try_from(sample_count).ok()?.checked_mul(4)?;
            stsz.get(12..12usize.checked_add(bytes)?)?
        } else {
            &[]
        };

        let (chunks, chunk_width) = match (child(stbl, b"stco"), child(stbl, b"co64")) {
            (Some(b), None) => (table(b, 4)?.2, 4),
            (None, Some(b)) => (table(b, 8)?.2, 8),
            _ => return None,
        };
        let (_, _, stsc) = table(child(stbl, b"stsc")?, 12)?;
        let runs: Vec<(u32, u32)> =
            stsc.chunks_exact(12).map(|e| Some((be32(e, 0)?, be32(e, 4)?))).collect::<Option<_>>()?;
        // Every sample placed in a chunk, exactly: runs start at chunk 1 and
        // only ever move forward, and together hold `sample_count` samples.
        let chunk_count = (chunks.len() / chunk_width) as u64;
        if runs.first().map(|r| r.0) != Some(1) {
            return None;
        }
        let mut placed = 0u64;
        for (k, &(first, per)) in runs.iter().enumerate() {
            let next = runs.get(k + 1).map_or(Some(chunk_count + 1), |n| Some(u64::from(n.0)))?;
            if u64::from(first) >= next || next > chunk_count + 1 {
                return None;
            }
            placed = placed.checked_add((next - u64::from(first)).checked_mul(u64::from(per))?)?;
        }
        if placed != u64::from(sample_count) {
            return None;
        }

        let (_, _, stts) = table(child(stbl, b"stts")?, 8)?;
        if counted(stts)? != u64::from(sample_count) {
            return None;
        }
        let ctts = match child(stbl, b"ctts") {
            None => None,
            Some(b) => {
                let (version, _, entries) = table(b, 8)?;
                if counted(entries)? != u64::from(sample_count) {
                    return None;
                }
                Some((entries, version >= 1))
            }
        };
        let sync = match child(stbl, b"stss") {
            None => None,
            Some(b) => Some(table(b, 4)?.2),
        };
        let media_time = match descend(trak, &[b"edts", b"elst"]) {
            None => 0,
            Some(elst) => single_edit_media_time(elst)?,
        };

        Some(VideoTrack {
            timescale,
            length_size,
            pps_ids,
            sample_count,
            uniform_size,
            sizes,
            chunks,
            chunk_width,
            runs,
            stts,
            ctts,
            media_time,
            sync,
        })
    }


    /// Sample `k`'s size.
    fn size_of(&self, k: u32) -> Option<u32> {
        if self.uniform_size != 0 {
            return Some(self.uniform_size);
        }
        be32(self.sizes, usize::try_from(k).ok()?.checked_mul(4)?)
    }

    /// Chunk `c`'s file offset.
    fn chunk_offset(&self, c: usize) -> Option<u64> {
        if self.chunk_width == 8 {
            be64(self.chunks, c.checked_mul(8)?)
        } else {
            be32(self.chunks, c.checked_mul(4)?).map(u64::from)
        }
    }

    /// Whether sample `k` (0-based) is a sync sample.
    fn is_sync(&self, k: u32) -> bool {
        let Some(table) = self.sync else {
            return true;
        };
        let Some(number) = k.checked_add(1) else {
            return false;
        };
        // Ascending by the standard; a table that is not may miss it, which
        // only costs the answer.
        let entries: Vec<u32> = table.chunks_exact(4).filter_map(|e| be32(e, 0)).collect();
        entries.binary_search(&number).is_ok()
    }

    /// Sample `k`'s presentation time in seconds: its decode time from
    /// `stts`, plus its `ctts` offset, minus the edit's media_time. Only a
    /// positive, finite time is an answer.
    fn pts_seconds(&self, k: u32) -> Option<f64> {
        let k = u64::from(k);
        let mut dts = 0u64;
        let mut before = 0u64;
        for e in self.stts.chunks_exact(8) {
            if before == k {
                break;
            }
            let (count, delta) = (u64::from(be32(e, 0)?), u64::from(be32(e, 4)?));
            let here = count.min(k - before);
            dts = dts.checked_add(here.checked_mul(delta)?)?;
            before += here;
        }
        let mut offset = 0i64;
        if let Some((entries, signed)) = self.ctts {
            let mut covered = 0u64;
            for e in entries.chunks_exact(8) {
                covered = covered.checked_add(u64::from(be32(e, 0)?))?;
                if covered > k {
                    let raw = be32(e, 4)?;
                    // v0 is unsigned by the standard, but ffmpeg — whose
                    // seek the answer feeds — reads every version signed.
                    // Past i32 the two disagree, and no real offset is
                    // that large (13 hours at 90 kHz): no answer.
                    if !signed && raw > i32::MAX as u32 {
                        return None;
                    }
                    offset = i64::from(raw as i32);
                    break;
                }
            }
        }
        let pts = i64::try_from(dts).ok()?.checked_add(offset)?.checked_sub(self.media_time)?;
        let seconds = pts as f64 / f64::from(self.timescale);
        (seconds.is_finite() && seconds > 0.0).then_some(seconds)
    }
}

/// The `avc1` sample entry's NAL length size and PPS ids, from the only
/// entry of `stsd`. Anything else — `avc3` (its parameter sets travel
/// in-band, so a slice's PPS id cannot be checked against the header),
/// `hvc1`, more than one entry — is `None`.
fn avc1_config(stsd: &[u8]) -> Option<(usize, Vec<u32>)> {
    if be32(stsd, 4)? != 1 {
        return None;
    }
    let entries = children(stsd.get(8..)?)?;
    let (typ, entry) = entries.first()?;
    if typ != b"avc1" {
        return None;
    }
    // A visual sample entry: 78 bytes of fields before its child boxes.
    let rec = child(entry.get(78..)?, b"avcC")?;
    if *rec.first()? != 1 {
        return None;
    }
    let length_size = match rec.get(4)? & 3 {
        0 => 1,
        1 => 2,
        3 => 4,
        _ => return None, // 2 is reserved: AVC has no 3-byte prefixes
    };
    let mut at = 6usize;
    for _ in 0..(rec.get(5)? & 0x1f) {
        at = at.checked_add(2)?.checked_add(usize::from(be16(rec, at)?))?;
    }
    let pps_count = *rec.get(at)?;
    at += 1;
    let mut pps_ids = Vec::new();
    for _ in 0..pps_count {
        let len = usize::from(be16(rec, at)?);
        let nal = rec.get(at.checked_add(2)?..at.checked_add(2)?.checked_add(len)?)?;
        // pic_parameter_set_id is the first field after the NAL header.
        let mut rbsp = [0u8; NAL_HEAD];
        let n = unescape(nal.get(1..)?, &mut rbsp);
        pps_ids.push(Bits::new(&rbsp[..n]).ue()?);
        at += 2 + len;
    }
    (!pps_ids.is_empty()).then_some((length_size, pps_ids))
}

/// The edit list's media_time to subtract: that of its single edit, 0 for a
/// list with none. More than one non-empty edit splices the presentation, and
/// one time cannot describe it: `None`.
///
/// An EMPTY edit (media_time -1) is `None` too. It is not nothing to ffmpeg,
/// whose seek the answer feeds: it adds the empty edit's duration (in the
/// movie's timescale) to every pts. A recording muxed with a start offset
/// (`-itsoffset 0.5` writes [(500, -1), (4000, 0)]) has its clean IDR at 2.5 s
/// where these tables alone say 2.0 — and the instant copy's seek to 2.0
/// landed on a garbage sample `stss` flags as sync. Reading the offset would
/// mean the `mvhd` timescale and each empty edit's place in the list; a file
/// with one is rare enough to get the full repair alone.
fn single_edit_media_time(elst: &[u8]) -> Option<i64> {
    let version = *elst.first()?;
    let width = if version == 1 { 20 } else { 12 };
    let (_, _, entries) = table(elst, width)?;
    let mut found = None;
    for e in entries.chunks_exact(width) {
        let media_time = if version == 1 {
            i64::from_be_bytes(e.get(8..16)?.try_into().ok()?)
        } else {
            i64::from(be32(e, 4)? as i32)
        };
        if media_time == -1 || found.replace(media_time).is_some() {
            return None;
        }
    }
    Some(found.unwrap_or(0))
}

/* ------------------------------------------------------------------ */
/* samples                                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// Not a sound H.264 access unit.
    Unsound,
    /// Sound, and an IDR picture.
    Idr,
    /// Sound, any other picture.
    Picture,
}

/// The first sound IDR after the last unsound sample, when the damage is a
/// prefix (see `scan_damaged_prefix`).
fn find_first_clean<R: Read + Seek>(r: &mut Reader<R>, track: &VideoTrack) -> Option<u32> {
    let mut damaged = false;
    let mut first_clean: Option<u32> = None;
    let mut k = 0u32;
    let mut run = 0usize;
    for c in 0..track.chunks.len() / track.chunk_width {
        // `parse` proved the runs start at chunk 1 and only move forward.
        while track.runs.get(run + 1).is_some_and(|next| u64::from(next.0) <= c as u64 + 1) {
            run += 1;
        }
        let per = track.runs.get(run)?.1;
        let mut at = track.chunk_offset(c)?;
        for _ in 0..per {
            if k >= track.sample_count {
                return None; // more placed than counted: `parse` refuses this
            }
            let size = track.size_of(k)?;
            match verdict(r, at, size, track.length_size, &track.pps_ids)? {
                Verdict::Unsound => {
                    damaged = true;
                    first_clean = None;
                }
                // A sound keyframe before any damage: the file opens fine.
                Verdict::Idr if !damaged => return None,
                Verdict::Idr => {
                    first_clean.get_or_insert(k);
                }
                Verdict::Picture => {}
            }
            at = at.checked_add(u64::from(size))?;
            k += 1;
        }
    }
    let first_clean = first_clean?;
    track.is_sync(first_clean).then_some(first_clean)
}

/// The `size` bytes at `at` as one sample: sound, and of which kind. `None`
/// only when the file cannot be read at all (an I/O error, not damage) — a
/// sample running past the end of the file is unsound.
fn verdict<R: Read + Seek>(
    r: &mut Reader<R>,
    at: u64,
    size: u32,
    length_size: usize,
    pps_ids: &[u32],
) -> Option<Verdict> {
    let Some(end) = at.checked_add(u64::from(size)).filter(|&e| e <= r.len) else {
        return Some(Verdict::Unsound);
    };
    let mut pos = at;
    let mut slices: Option<u8> = None;
    while pos < end {
        // A length prefix and at least the NAL header.
        if end - pos <= length_size as u64 {
            return Some(Verdict::Unsound);
        }
        let want = usize::try_from((end - pos).min((length_size + NAL_HEAD) as u64)).ok()?;
        let head = r.bytes(pos, want)?;
        let len = head.get(..length_size)?.iter().fold(0u64, |n, b| n << 8 | u64::from(*b));
        let Some(nal_end) = pos.checked_add(length_size as u64).and_then(|p| p.checked_add(len)) else {
            return Some(Verdict::Unsound);
        };
        if len == 0 || nal_end > end {
            return Some(Verdict::Unsound);
        }
        let header = *head.get(length_size)?;
        let nal_type = header & 0x1f;
        if header & 0x80 != 0 || !matches!(nal_type, 1 | 5..=12) {
            return Some(Verdict::Unsound);
        }
        if matches!(nal_type, 1 | 5) {
            if slices.is_some_and(|t| t != nal_type) {
                return Some(Verdict::Unsound);
            }
            let first = slices.is_none();
            slices = Some(nal_type);
            // The slice header: what of the NAL past its header was read.
            let body = head.get(length_size + 1..).unwrap_or(&[]);
            let body = body.get(..body.len().min(usize::try_from(len - 1).unwrap_or(usize::MAX))).unwrap_or(&[]);
            if !slice_is_sound(header, body, first, pps_ids) {
                return Some(Verdict::Unsound);
            }
        }
        pos = nal_end;
    }
    Some(match slices {
        None => Verdict::Unsound,
        Some(5) => Verdict::Idr,
        Some(_) => Verdict::Picture,
    })
}

/// One slice NAL's header: `first_mb_in_slice` (0 for the picture's first
/// slice), `slice_type` <= 9, `pic_parameter_set_id` among the header's —
/// and, for an IDR, what the standard demands of every IDR slice: a
/// reference picture (nal_ref_idc != 0) of an I or SI type.
fn slice_is_sound(header: u8, body: &[u8], first: bool, pps_ids: &[u32]) -> bool {
    let mut rbsp = [0u8; NAL_HEAD];
    let n = unescape(body, &mut rbsp);
    let mut bits = Bits::new(&rbsp[..n]);
    let (Some(first_mb), Some(slice_type), Some(pps_id)) = (bits.ue(), bits.ue(), bits.ue()) else {
        return false;
    };
    let idr = header & 0x1f == 5;
    slice_type <= 9
        && pps_ids.contains(&pps_id)
        && (!first || first_mb == 0)
        && (!idr || (header & 0x60 != 0 && matches!(slice_type % 5, 2 | 4)))
}

/// `nal` with its emulation-prevention bytes (the 03 of every 00 00 03)
/// removed, into `out`; returns how many bytes were written. Only the first
/// bytes of a NAL are ever parsed, so `out` is a small fixed buffer.
fn unescape(nal: &[u8], out: &mut [u8]) -> usize {
    let mut n = 0;
    let mut zeros = 0;
    for &b in nal {
        if n == out.len() {
            break;
        }
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out[n] = b;
        n += 1;
    }
    n
}

/// A big-endian bit reader for Exp-Golomb codes.
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Bits { data, pos: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.pos / 8)?;
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(u32::from(bit))
    }

    /// ue(v); `None` past the data, or for a code longer than 32 bits.
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0u32;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        let mut rest = 0u64;
        for _ in 0..zeros {
            rest = rest << 1 | u64::from(self.bit()?);
        }
        u32::try_from((1u64 << zeros) - 1 + rest).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /* ---- building MP4s in memory ---- */

    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = u32::try_from(body.len() + 8).unwrap().to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    fn fullbox(typ: &[u8; 4], version: u8, body: &[u8]) -> Vec<u8> {
        bx(typ, &[&[version, 0, 0, 0], body].concat())
    }

    fn u32s(values: impl IntoIterator<Item = u32>) -> Vec<u8> {
        values.into_iter().flat_map(u32::to_be_bytes).collect()
    }

    #[derive(Default)]
    struct BitWriter {
        bytes: Vec<u8>,
        used: u32,
    }

    impl BitWriter {
        fn bit(&mut self, b: u64) {
            if self.used % 8 == 0 {
                self.bytes.push(0);
            }
            if b != 0 {
                *self.bytes.last_mut().unwrap() |= 0x80 >> (self.used % 8);
            }
            self.used += 1;
        }
        fn bits(&mut self, v: u64, n: u32) {
            for i in (0..n).rev() {
                self.bit((v >> i) & 1);
            }
        }
        fn ue(&mut self, v: u32) {
            let x = u64::from(v) + 1;
            let len = 64 - x.leading_zeros();
            self.bits(0, len - 1);
            self.bits(x, len);
        }
        /// rbsp_trailing_bits: a 1, then zeros to the byte boundary.
        fn finish(mut self) -> Vec<u8> {
            self.bit(1);
            while self.used % 8 != 0 {
                self.bit(0);
            }
            self.bytes
        }
    }

    /// Emulation prevention, as an encoder writes it: a 03 before any byte
    /// <= 03 that follows two zero bytes.
    fn escape(rbsp: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut zeros = 0;
        for &b in rbsp {
            if zeros >= 2 && b <= 3 {
                out.push(3);
                zeros = 0;
            }
            zeros = if b == 0 { zeros + 1 } else { 0 };
            out.push(b);
        }
        out
    }

    /// A slice NAL: its header byte, then a slice header that opens with
    /// `first_mb_in_slice`, `slice_type`, `pic_parameter_set_id`, then some
    /// macroblock bits.
    fn slice(nal_type: u8, ref_idc: u8, first_mb: u32, slice_type: u32, pps: u32) -> Vec<u8> {
        let mut w = BitWriter::default();
        w.ue(first_mb);
        w.ue(slice_type);
        w.ue(pps);
        w.bits(0x5a5a_5a5a, 32);
        [vec![ref_idc << 5 | nal_type], escape(&w.finish())].concat()
    }

    /// An IDR picture's slice (I, all slices I: type 7).
    fn idr() -> Vec<u8> {
        slice(5, 3, 0, 7, 0)
    }

    /// A P picture's slice (type 5: all slices P).
    fn p() -> Vec<u8> {
        slice(1, 2, 0, 5, 0)
    }

    /// What the damaged minute holds: a NAL whose header has the forbidden
    /// bit set, random bytes after it.
    fn garbage(seed: u8) -> Vec<u8> {
        let mut nal: Vec<u8> = (0..40u8).map(|i| i.wrapping_mul(37).wrapping_add(seed)).collect();
        nal[0] = 0x80 | (seed & 0x7f);
        nal
    }

    /// One access unit: `nals` behind `length_size`-byte length prefixes.
    fn frame(nals: &[Vec<u8>], length_size: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nals {
            out.extend_from_slice(&nal.len().to_be_bytes()[8 - length_size..]);
            out.extend_from_slice(nal);
        }
        out
    }

    /// A recording to build: every field one axis of what the scan reads.
    #[derive(Clone)]
    struct Mp4 {
        samples: Vec<Vec<Vec<u8>>>,
        entry: [u8; 4],
        length_size: usize,
        /// Written into avcC's lengthSizeMinusOne instead of the real value.
        length_bits: Option<u8>,
        pps_ids: Vec<u32>,
        timescale: u32,
        mdhd_version: u8,
        /// `stts` is two runs: samples 0-2 last `delta` ticks each, every
        /// later one `late_delta`. The two differ, so a walk that applies one
        /// run's delta to another moves the answer (the real recording has
        /// thousands of runs, no two neighbours alike).
        delta: u32,
        late_delta: u32,
        /// (version, one offset per sample)
        ctts: Option<(u8, Vec<i64>)>,
        /// (version, media_time per edit)
        elst: Option<(u8, Vec<i64>)>,
        stss: Option<Vec<u32>>,
        co64: bool,
        per_chunk: usize,
        moov_first: bool,
        /// Every sample padded to this size (its last NAL grows), and `stsz`
        /// written with one uniform size.
        uniform: Option<usize>,
    }

    /// The damaged recording every variant starts from. Sample 1 is garbage
    /// that happens to look like a sound IDR (the real file has a dozen);
    /// sample 3 a sound P-frame whose references are garbage; sample 4 the
    /// first clean IDR; after it everything is sound. Its time is
    /// (3*512 + 640 + 1536 - 1024) / 12800 = 0.21 s (`CLEAN_AT`), and every
    /// term matters: without the ctts offset it is 0.09, without the edit
    /// 0.29, with the first run's delta for every sample 0.2, with the last
    /// run's 0.24, as sample 1 0.04, as sample 7 0.36.
    fn damaged() -> Mp4 {
        Mp4 {
            samples: vec![
                vec![garbage(1)],
                vec![idr()],
                vec![garbage(2), garbage(3)],
                vec![p()],
                vec![idr()],
                vec![p()],
                vec![p()],
                vec![idr()],
                vec![p()],
            ],
            entry: *b"avc1",
            length_size: 4,
            length_bits: None,
            pps_ids: vec![0],
            timescale: 12800,
            mdhd_version: 0,
            delta: 512,
            late_delta: 640,
            ctts: Some((0, vec![512, 1024, 0, 512, 1536, 2048, 512, 1536, 512])),
            elst: Some((0, vec![1024])),
            stss: None,
            co64: false,
            per_chunk: 2,
            moov_first: false,
            uniform: None,
        }
    }

    impl Mp4 {
        fn build(&self) -> Vec<u8> {
            let ftyp = bx(b"ftyp", b"isom\0\0\x02\0isomavc1");
            let data: Vec<Vec<u8>> = self
                .samples
                .iter()
                .map(|nals| {
                    let mut f = frame(nals, self.length_size);
                    if let Some(size) = self.uniform {
                        // Grow the last NAL: its length prefix and its bytes.
                        let grow = size - f.len();
                        let last = f.len() - nals.last().unwrap().len() - self.length_size;
                        let len = nals.last().unwrap().len() + grow;
                        f[last..last + self.length_size].copy_from_slice(&len.to_be_bytes()[8 - self.length_size..]);
                        f.resize(size, 0x5a);
                    }
                    f
                })
                .collect();
            // Chunks of `per_chunk` samples, each followed by another track's
            // bytes, so a chunk's offset is not just where the last ended.
            let mut payload = Vec::new();
            let mut chunk_at = Vec::new();
            for chunk in data.chunks(self.per_chunk) {
                chunk_at.push(payload.len());
                for s in chunk {
                    payload.extend_from_slice(s);
                }
                payload.extend_from_slice(&[0xa5; 7]);
            }
            let moov_len = self.moov(&chunk_at, 0, &data).len();
            let base = ftyp.len() + 8 + if self.moov_first { moov_len } else { 0 };
            let moov = self.moov(&chunk_at, base, &data);
            let mdat = bx(b"mdat", &payload);
            if self.moov_first {
                [ftyp, moov, mdat].concat()
            } else {
                [ftyp, mdat, moov].concat()
            }
        }

        fn moov(&self, chunk_at: &[usize], base: usize, data: &[Vec<u8>]) -> Vec<u8> {
            let n = u32::try_from(data.len()).unwrap();
            let bits = self.length_bits.unwrap_or(self.length_size as u8 - 1);
            let mut avcc = vec![1, 66, 0, 30, 0xfc | bits, 0xe1];
            let sps = [0x67, 66, 0, 30, 0xf4];
            avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
            avcc.extend_from_slice(&sps);
            avcc.push(self.pps_ids.len() as u8);
            for &id in &self.pps_ids {
                let mut w = BitWriter::default();
                w.ue(id);
                w.ue(0);
                let pps = [vec![0x68], escape(&w.finish())].concat();
                avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
                avcc.extend_from_slice(&pps);
            }
            let mut entry = vec![0u8; 78];
            entry[7] = 1; // data_reference_index
            entry.extend(bx(b"avcC", &avcc));
            let stsd = fullbox(b"stsd", 0, &[u32s([1]), bx(&self.entry, &entry)].concat());
            // Two runs of different deltas: the walk must cross an entry, and
            // read each run's own delta.
            let stts = fullbox(b"stts", 0, &u32s([2, 3, self.delta, n - 3, self.late_delta]));
            let stsz = match self.uniform {
                Some(size) => fullbox(b"stsz", 0, &u32s([size as u32, n])),
                None => fullbox(b"stsz", 0, &[u32s([0, n]), u32s(data.iter().map(|s| s.len() as u32))].concat()),
            };
            let per = self.per_chunk as u32;
            let chunks = chunk_at.len() as u32;
            let last = n - per * (chunks - 1);
            let runs = if chunks == 1 {
                vec![(1, n)]
            } else if last == per {
                vec![(1, per)]
            } else {
                vec![(1, per), (chunks, last)]
            };
            let stsc = fullbox(
                b"stsc",
                0,
                &[u32s([runs.len() as u32]), runs.iter().flat_map(|&(f, p)| u32s([f, p, 1])).collect()].concat(),
            );
            let offsets = chunk_at.iter().map(|&c| (base + c) as u64);
            let stco = if self.co64 {
                fullbox(b"co64", 0, &[u32s([chunks]), offsets.flat_map(u64::to_be_bytes).collect()].concat())
            } else {
                fullbox(b"stco", 0, &[u32s([chunks]), u32s(offsets.map(|o| o as u32))].concat())
            };
            let mut stbl = [stsd, stts, stsz, stsc, stco].concat();
            if let Some((version, offsets)) = &self.ctts {
                let body: Vec<u8> = offsets.iter().flat_map(|&o| u32s([1, o as u32])).collect();
                stbl.extend(fullbox(b"ctts", *version, &[u32s([n]), body].concat()));
            }
            if let Some(sync) = &self.stss {
                stbl.extend(fullbox(b"stss", 0, &[u32s([sync.len() as u32]), u32s(sync.iter().copied())].concat()));
            }
            let mdhd = if self.mdhd_version == 1 {
                let body = [vec![0; 16], u32s([self.timescale]), vec![0; 8], vec![0x55, 0xc4, 0, 0]].concat();
                fullbox(b"mdhd", 1, &body)
            } else {
                let duration = 3 * self.delta + (n - 3) * self.late_delta;
                fullbox(b"mdhd", 0, &[u32s([0, 0, self.timescale, duration]), vec![0x55, 0xc4, 0, 0]].concat())
            };
            let hdlr = |kind: &[u8; 4]| fullbox(b"hdlr", 0, &[u32s([0]), kind.to_vec(), vec![0; 12], b"x\0".to_vec()].concat());
            let mdia = bx(b"mdia", &[mdhd, hdlr(b"vide"), bx(b"minf", &bx(b"stbl", &stbl))].concat());
            let mut trak = fullbox(b"tkhd", 0, &[0; 80]);
            if let Some((version, times)) = &self.elst {
                let body: Vec<u8> = times
                    .iter()
                    .flat_map(|&t| {
                        if *version == 1 {
                            [1000u64.to_be_bytes().to_vec(), t.to_be_bytes().to_vec(), vec![0, 1, 0, 0]].concat()
                        } else {
                            [u32s([1000, t as i32 as u32]), vec![0, 1, 0, 0]].concat()
                        }
                    })
                    .collect();
                let elst = fullbox(b"elst", *version, &[u32s([times.len() as u32]), body].concat());
                trak.extend(bx(b"edts", &elst));
            }
            trak.extend(mdia);
            // A sound track FIRST: the first video track is not the first track.
            let soun = bx(b"trak", &bx(b"mdia", &hdlr(b"soun")));
            bx(b"moov", &[fullbox(b"mvhd", 0, &[0; 96]), soun, bx(b"trak", &trak)].concat())
        }
    }

    /// `damaged()`'s answer: sample 4, (3*512 + 640 + 1536 - 1024) / 12800.
    const CLEAN_AT: f64 = 2688.0 / 12800.0;

    fn scan_bytes(file: &[u8]) -> Option<f64> {
        scan(Cursor::new(file), file.len() as u64)
    }

    fn scan_of(m: &Mp4) -> Option<f64> {
        scan_bytes(&m.build())
    }

    /* ---- the answer ---- */

    /// The base case and every way of writing its timing: each row moves the
    /// answer (or must leave it), so dropping any term of
    /// (dts + ctts - media_time) / timescale, or misreading any table's
    /// layout, fails a row of its own.
    #[test]
    fn a_damaged_prefix_answers_its_first_clean_idr_in_presentation_seconds() {
        let with = |f: &dyn Fn(&mut Mp4)| {
            let mut m = damaged();
            f(&mut m);
            m
        };
        let rows: Vec<(&str, Mp4, Option<f64>)> = vec![
            ("ctts v0 and one edit", damaged(), Some(CLEAN_AT)),
            ("no ctts, no edit list", with(&|m| (m.ctts, m.elst) = (None, None)), Some(2176.0 / 12800.0)),
            ("ctts v1, negative offsets", with(&|m| {
                m.ctts = Some((1, vec![-512, 0, -512, -1024, -1024, 0, -512, 0, 0]));
                m.elst = None;
            }), Some(1152.0 / 12800.0)),
            // ffmpeg adds an empty edit's duration to every pts; the scan does
            // not read it (`single_edit_media_time`), so it does not answer.
            ("an empty edit, then the edit", with(&|m| m.elst = Some((0, vec![-1, 1024]))), None),
            ("the edit, then an empty edit", with(&|m| m.elst = Some((0, vec![1024, -1]))), None),
            ("an empty edit, elst v1", with(&|m| m.elst = Some((1, vec![-1, 1024]))), None),
            ("elst v1", with(&|m| m.elst = Some((1, vec![1024]))), Some(CLEAN_AT)),
            ("two non-empty edits splice the presentation", with(&|m| m.elst = Some((0, vec![1024, 0]))), None),
            ("mdhd v1, another timescale", with(&|m| (m.mdhd_version, m.timescale) = (1, 15360)), Some(2688.0 / 15360.0)),
            ("co64 chunk offsets", with(&|m| m.co64 = true), Some(CLEAN_AT)),
            ("moov before mdat", with(&|m| m.moov_first = true), Some(CLEAN_AT)),
            ("one sample per chunk", with(&|m| m.per_chunk = 1), Some(CLEAN_AT)),
            ("a partial last chunk", with(&|m| m.per_chunk = 4), Some(CLEAN_AT)),
            ("all in one chunk", with(&|m| m.per_chunk = 9), Some(CLEAN_AT)),
            ("uniform sample size", with(&|m| m.uniform = Some(96)), Some(CLEAN_AT)),
            ("1-byte NAL lengths", with(&|m| m.length_size = 1), Some(CLEAN_AT)),
            ("2-byte NAL lengths", with(&|m| m.length_size = 2), Some(CLEAN_AT)),
            ("stss lists the clean IDR", with(&|m| m.stss = Some(vec![1, 2, 3, 5, 8])), Some(CLEAN_AT)),
            // A seek to it would land on garbage sample 3.
            ("stss misses the clean IDR", with(&|m| m.stss = Some(vec![1, 2, 3, 8])), None),
            // (2176 + 1536 - 3712) / 12800 = 0: the IDR is the very start.
            ("an edit at the IDR", with(&|m| m.elst = Some((0, vec![3712]))), None),
        ];
        for (name, m, want) in rows {
            assert_eq!(scan_of(&m), want, "{name}");
        }
    }

    /// Damage that is not a prefix is not answered: a clean file, a file that
    /// opens on a sound keyframe and breaks later (the fixture differs from
    /// `damaged()` in sample 0 alone), damage at the very end, and damage
    /// with no clean IDR after it.
    #[test]
    fn only_a_damaged_prefix_is_answered() {
        let with_samples = |samples: Vec<Vec<Vec<u8>>>| {
            let mut m = damaged();
            (m.ctts, m.elst) = (None, None);
            m.samples = samples;
            m
        };
        let clean = with_samples(vec![vec![idr()], vec![p()], vec![p()], vec![idr()], vec![p()]]);
        assert_eq!(scan_of(&clean), None, "a clean file");

        let mut middle = damaged();
        middle.samples[0] = vec![idr()];
        assert_eq!(scan_of(&middle), None, "opens on a sound keyframe, damaged after it");

        let at_end = with_samples(vec![vec![garbage(1)], vec![idr()], vec![p()], vec![garbage(9)]]);
        assert_eq!(scan_of(&at_end), None, "the last sample is damaged");

        let no_idr = with_samples(vec![vec![garbage(1)], vec![p()], vec![p()], vec![p()]]);
        assert_eq!(scan_of(&no_idr), None, "no clean keyframe after the damage");

        // Sound P-frames before the first damaged sample are no keyframe: the
        // prefix still counts (nothing before it could be shown).
        let p_first = with_samples(vec![vec![p()], vec![garbage(1)], vec![p()], vec![idr()], vec![p()]]);
        assert_eq!(scan_of(&p_first), Some(1536.0 / 12800.0));
    }

    /// Only an `avc1` sample entry is read, and only a single one; avcC's
    /// reserved length size is refused.
    #[test]
    fn only_avc1_with_a_valid_length_size_is_read() {
        for entry in [*b"avc3", *b"hvc1", *b"mp4v"] {
            let mut m = damaged();
            m.entry = entry;
            assert_eq!(scan_of(&m), None, "{}", String::from_utf8_lossy(&entry));
        }
        let mut reserved = damaged();
        reserved.length_bits = Some(2);
        assert_eq!(scan_of(&reserved), None, "lengthSizeMinusOne 2 is reserved");
        // Not a scan of the wrong track: with the sound track's hdlr turned
        // to video the FIRST video track has no sample table, so no answer.
        let mut file = damaged().build();
        let soun = file.windows(4).position(|w| w == b"soun").unwrap();
        file[soun..soun + 4].copy_from_slice(b"vide");
        assert_eq!(scan_bytes(&file), None, "the first video track is the one read");
    }

    /// A slice header naming a PPS the header does not carry is garbage; one
    /// it does carry is sound — with several PPS ids in avcC, not only 0.
    #[test]
    fn slices_must_name_a_pps_of_the_header() {
        let mut m = damaged();
        m.pps_ids = vec![0, 3];
        m.samples[5] = vec![slice(1, 2, 0, 5, 3)];
        assert_eq!(scan_of(&m), Some(CLEAN_AT), "PPS 3 is in the header");
        m.samples[5] = vec![slice(1, 2, 0, 5, 2)];
        assert_eq!(scan_of(&m), Some(4608.0 / 12800.0), "PPS 2 is not: sample 5 is damaged, the clean start moves to sample 7");
    }

    /* ---- the per-sample rule ---- */

    fn verdict_of(nals: &[Vec<u8>], length_size: usize, pps: &[u32]) -> Option<Verdict> {
        let bytes = frame(nals, length_size);
        verdict(&mut Reader::new(Cursor::new(&bytes), bytes.len() as u64), 0, bytes.len() as u32, length_size, pps)
    }

    /// Each row breaks one clause of the rule (or keeps to it), in a sample of
    /// its own.
    #[test]
    fn a_sample_is_sound_only_when_every_clause_holds() {
        use Verdict::*;
        let sei = vec![0x06, 0x05, 0x01, 0xaa, 0x80];
        let aud = vec![0x09, 0xf0];
        let sps = vec![0x67, 66, 0, 30, 0xf4];
        let pps = vec![0x68, 0xce];
        // A second slice whose header needs emulation prevention: 22 zero
        // bits of first_mb_in_slice put 00 00 02 in the RBSP, escaped to
        // 00 00 03 02. Read without unescaping, its PPS id comes out wrong.
        let escaped = slice(5, 3, (1 << 22) + 1, 7, 0);
        assert!(escaped.windows(4).any(|w| w == [0, 0, 3, 2]), "fixture: an escaped header {escaped:02x?}");
        let rows: Vec<(&str, Vec<Vec<u8>>, Option<Verdict>)> = vec![
            ("an IDR", vec![idr()], Some(Idr)),
            ("a P", vec![p()], Some(Picture)),
            ("AUD + SEI + IDR", vec![aud.clone(), sei.clone(), idr()], Some(Idr)),
            ("in-band SPS + PPS + IDR", vec![sps.clone(), pps.clone(), idr()], Some(Idr)),
            ("two IDR slices", vec![idr(), slice(5, 3, 120, 7, 0)], Some(Idr)),
            ("an escaped second slice header", vec![idr(), escaped], Some(Idr)),
            ("filler and end-of-sequence types", vec![p(), vec![0x0a], vec![0x0c, 0xff]], Some(Picture)),
            ("an IDR and a P slice mixed", vec![idr(), slice(1, 2, 120, 5, 0)], Some(Unsound)),
            ("the first slice does not start the picture", vec![slice(5, 3, 8, 7, 0)], Some(Unsound)),
            ("the forbidden bit", vec![[vec![0x80 | 0x41], p()[1..].to_vec()].concat()], Some(Unsound)),
            ("a reserved type (14)", vec![vec![0x0e, 0x80], idr()], Some(Unsound)),
            ("unspecified type 0", vec![vec![0x00, 0x80], idr()], Some(Unsound)),
            ("a data partition (2)", vec![slice(2, 2, 0, 5, 0)], Some(Unsound)),
            ("no slice at all", vec![sei.clone(), aud.clone()], Some(Unsound)),
            ("slice_type 10", vec![slice(1, 2, 0, 10, 0)], Some(Unsound)),
            ("a PPS the header lacks", vec![slice(1, 2, 0, 5, 1)], Some(Unsound)),
            ("an IDR that is not a reference", vec![slice(5, 0, 0, 7, 0)], Some(Unsound)),
            ("an IDR made of P slices", vec![slice(5, 3, 0, 5, 0)], Some(Unsound)),
            ("an SI IDR", vec![slice(5, 1, 0, 9, 0)], Some(Idr)),
            ("a slice that is only a header byte", vec![vec![0x65]], Some(Unsound)),
            ("a slice header cut short", vec![vec![0x65, 0x00]], Some(Unsound)),
        ];
        for (name, nals, want) in rows {
            assert_eq!(verdict_of(&nals, 4, &[0]), want, "{name}");
        }

        // The length prefixes must tile the sample exactly.
        let mut over = frame(&[idr()], 4);
        over[3] += 1; // one byte longer than the sample
        let mut under = frame(&[idr()], 4);
        under.push(0x00); // one byte no NAL claims
        // A zero-length NAL after a P slice, then a byte that reads as another
        // P slice's header: nothing but the zero length is wrong (and without
        // its check the slice-header bound `len - 1` would underflow).
        let mut empty = frame(&[p()], 4);
        empty.extend_from_slice(&[0, 0, 0, 0, 0x41]);
        let mut tail = frame(&[idr()], 4);
        tail.extend_from_slice(&[0, 0, 0, 9, 0x41]); // a NAL running off the end
        for (name, bytes) in [("overrun", over), ("one stray byte", under), ("a zero length", empty), ("a NAL past the end", tail)] {
            let got = verdict(&mut Reader::new(Cursor::new(&bytes), bytes.len() as u64), 0, bytes.len() as u32, 4, &[0]);
            assert_eq!(got, Some(Unsound), "{name}");
        }
        // A sample running past the end of the file is damaged, not an error.
        let bytes = frame(&[idr()], 4);
        let got = verdict(&mut Reader::new(Cursor::new(&bytes), bytes.len() as u64), 0, bytes.len() as u32 + 1, 4, &[0]);
        assert_eq!(got, Some(Unsound));
    }

    #[test]
    fn exp_golomb_and_unescaping() {
        let mut w = BitWriter::default();
        for v in [0, 1, 2, 7, 255, 65_535, u32::MAX - 1] {
            w.ue(v);
        }
        let bytes = w.finish();
        let mut bits = Bits::new(&bytes);
        for v in [0, 1, 2, 7, 255, 65_535, u32::MAX - 1] {
            assert_eq!(bits.ue(), Some(v));
        }
        // 32 leading zeros: beyond any 32-bit value.
        assert_eq!(Bits::new(&[0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff]).ue(), None);
        assert_eq!(Bits::new(&[0x00]).ue(), None, "runs out of bits");

        let mut out = [0u8; 8];
        let n = unescape(&[0x11, 0, 0, 3, 1, 0, 0, 3, 0, 3], &mut out);
        assert_eq!(&out[..n], [0x11, 0, 0, 1, 0, 0, 0, 3], "the 03 after 00 00 goes, the next 00 00 starts afresh");
        assert_eq!(unescape(&[1; 20], &mut out), 8, "bounded by the buffer");
    }

    /* ---- hostile input ---- */

    /// A file cut anywhere, and every byte of a real one set to each of a few
    /// hostile values, is answered without a panic (release builds abort on
    /// one). A cut before the end of the moov loses it: never an answer.
    #[test]
    fn a_truncated_or_crafted_file_never_panics() {
        let mut m = damaged();
        m.moov_first = true;
        for file in [damaged().build(), m.build()] {
            for cut in 0..file.len() {
                let got = scan_bytes(&file[..cut]);
                assert!(got.is_none() || got == Some(CLEAN_AT), "cut at {cut}: {got:?}");
            }
            for at in 0..file.len() {
                for value in [0x00, 0x01, 0x07, 0x08, 0x7f, 0x80, 0xff] {
                    let mut crafted = file.clone();
                    crafted[at] = value;
                    let _ = scan_bytes(&crafted);
                }
            }
        }
        let original = damaged().build();
        // The cut that keeps everything but the moov's last byte.
        assert_eq!(scan_bytes(&original[..original.len() - 1]), None);
        assert_eq!(scan_bytes(&original), Some(CLEAN_AT));
    }

    /// Sizes that lie: a box shorter than its own header, a 64-bit size past
    /// the file, a count of entries no box could hold, chunks that do not
    /// hold the samples counted — each `None`, and at once. Every row is the
    /// answered file below with one field changed.
    #[test]
    fn lying_sizes_and_counts_are_refused() {
        let file = damaged().build();
        assert_eq!(scan_bytes(&file), Some(CLEAN_AT), "fixture: the file each row changes is answered");
        let at = |typ: &[u8; 4]| file.windows(4).position(|w| w == typ).unwrap() - 4;
        let set = |offset: usize, bytes: &[u8]| {
            let mut f = file.clone();
            f[offset..offset + bytes.len()].copy_from_slice(bytes);
            f
        };
        let started = std::time::Instant::now();
        for (name, crafted) in [
            ("moov smaller than its header", set(at(b"moov"), &4u32.to_be_bytes())),
            ("mdat with a 64-bit size past the file", set(at(b"mdat"), &[0, 0, 0, 1])),
            ("stbl past its parent", set(at(b"stbl"), &0x7fff_ffffu32.to_be_bytes())),
            ("stsz counting 2^32-1 samples", set(at(b"stsz") + 16, &u32::MAX.to_be_bytes())),
            ("stco counting 2^32-1 chunks", set(at(b"stco") + 12, &u32::MAX.to_be_bytes())),
            ("stts counting 2^32-1 entries", set(at(b"stts") + 12, &u32::MAX.to_be_bytes())),
            ("stsc starting at chunk 0", set(at(b"stsc") + 16, &0u32.to_be_bytes())),
            // stsc is [(chunk 1, 2 samples each), (chunk 5, 1)]: the second
            // run's count, 1 -> 0, places 8 samples where stsz counts 9. Only
            // the placement check sees it: a walk over what IS placed finds
            // the clean IDR and everything after it sound, never having
            // looked at the last sample — damage there would go unseen. (A
            // table placing MORE than counted is refused by the walk itself.)
            ("stsc placing a sample fewer than stsz counts", set(at(b"stsc") + 32, &0u32.to_be_bytes())),
            // The last chunk: its sample comes after the clean IDR.
            ("a chunk offset past the file", set(at(b"stco") + 32, &u32::MAX.to_be_bytes())),
        ] {
            assert_eq!(scan_bytes(&crafted), None, "{name}");
        }
        // A v0 composition offset past i32 is neither a sane unsigned offset
        // nor ffmpeg's signed reading of it.
        let mut odd = damaged();
        odd.ctts = Some((0, vec![0, 0, 0, 0, i64::from(u32::MAX), 0, 0, 0, 0]));
        assert_eq!(scan_of(&odd), None, "v0 offset 2^32-1");
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    }

    /// The sample cap is a refusal of its own: a track whose tables all agree
    /// on `MAX_SAMPLES + 1` samples — stsz's count, stts's runs, stsc's
    /// placement, in one chunk of a uniform size, so the moov stays a few
    /// hundred bytes — is refused by the parse, while the same layout at
    /// exactly `MAX_SAMPLES` parses. Nothing else in the parse can tell the
    /// two apart, so the cap is the only reason for the `None`.
    #[test]
    fn a_consistent_table_past_the_sample_cap_is_refused() {
        let moov_with = |count: u32| {
            let mut m = damaged();
            // One chunk, one size, no per-sample ctts: three counts to change.
            (m.uniform, m.per_chunk, m.ctts) = (Some(96), 9, None);
            let mut f = m.build();
            let at = |f: &[u8], typ: &[u8; 4]| f.windows(4).position(|w| w == typ).unwrap() - 4;
            let stsz = at(&f, b"stsz"); // size, type, version/flags, uniform size, COUNT
            f[stsz + 16..stsz + 20].copy_from_slice(&count.to_be_bytes());
            let stsc = at(&f, b"stsc"); // ..., entry count, (first chunk 1, PER CHUNK, desc)
            f[stsc + 20..stsc + 24].copy_from_slice(&count.to_be_bytes());
            let stts = at(&f, b"stts"); // ..., entry count, (3, 512), (COUNT, 640)
            f[stts + 24..stts + 28].copy_from_slice(&(count - 3).to_be_bytes());
            read_moov(&mut Reader::new(Cursor::new(&f), f.len() as u64)).expect("fixture: a moov")
        };
        let cap = u32::try_from(MAX_SAMPLES).unwrap();
        let at_cap = moov_with(cap);
        assert_eq!(
            VideoTrack::parse(&at_cap).map(|t| t.sample_count),
            Some(cap),
            "fixture: the layout parses at the cap, so the refusal below is the cap's"
        );
        assert!(VideoTrack::parse(&moov_with(cap + 1)).is_none(), "one sample past the cap");
    }

    /// The path entry point reads the same answer from disk, and a path that
    /// is not there answers `None`.
    #[test]
    fn the_path_entry_point_reads_the_file() {
        let dir = std::env::temp_dir().join(format!("taroting-damage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Replay 2026.mp4");
        std::fs::write(&path, damaged().build()).unwrap();
        assert_eq!(scan_damaged_prefix(&path), Some(CLEAN_AT));
        assert_eq!(scan_damaged_prefix(&dir.join("gone.mp4")), None);
        assert_eq!(scan_damaged_prefix(&dir), None, "a folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real recording this was built for, by hand (it is the owner's, not
    /// a fixture): `TAROTING_DAMAGED_SAMPLE=<path> cargo test -- --ignored
    /// damaged_sample`. Prints the answer and how long the scan took.
    #[test]
    #[ignore]
    fn damaged_sample() {
        let Ok(path) = std::env::var("TAROTING_DAMAGED_SAMPLE") else {
            panic!("set TAROTING_DAMAGED_SAMPLE to the recording's path");
        };
        for run in 0..3 {
            let started = std::time::Instant::now();
            let got = scan_damaged_prefix(Path::new(&path));
            eprintln!("run {run}: {got:?} in {:?}", started.elapsed());
        }
    }
}
