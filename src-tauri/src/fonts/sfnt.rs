//! A small, bounds-checked reader for the sfnt tables the font library needs:
//! the table directory (single fonts and `.ttc` collections), `head`, `hhea`,
//! `OS/2`, `name` and `cmap`, plus the extraction of one collection face into
//! a standalone file.
//!
//! The bytes are UNTRUSTED (an imported file, or any file Windows lists as a
//! font) and the app is built with `panic = "abort"`: every read goes through
//! `get`/`checked_*` and answers an error, never an index or a slice that can
//! panic, and every count read from the file is capped before it sizes a loop
//! or an allocation. Debug builds also panic on integer overflow, so offsets
//! are added with `checked_add` and glyph arithmetic that the spec defines as
//! modulo 65536 uses `wrapping_add`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use super::Embed;

/// Why a file is not usable. `Unsupported` = a real font container outside
/// policy (Type 1, WOFF); `NotAFont` = anything that does not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SfntError {
    NotAFont,
    Unsupported,
}

pub type SfntResult<T> = std::result::Result<T, SfntError>;

pub const TAG_TTCF: u32 = u32::from_be_bytes(*b"ttcf");
pub const VERSION_TRUETYPE: u32 = 0x0001_0000;
pub const VERSION_OTTO: u32 = u32::from_be_bytes(*b"OTTO");
const VERSION_APPLE_TRUE: u32 = u32::from_be_bytes(*b"true");
const VERSION_TYP1: u32 = u32::from_be_bytes(*b"typ1");
const TAG_WOFF: u32 = u32::from_be_bytes(*b"wOFF");
const TAG_WOFF2: u32 = u32::from_be_bytes(*b"wOF2");

/// Caps on counts read from the file (a real font is far below each).
const MAX_TABLES: u16 = 512;
const MAX_FACES: u32 = 1024;
const MAX_NAME_RECORDS: u16 = 4096;
const MAX_CMAP_RECORDS: u16 = 256;
/// The largest single table this reader will load.
const MAX_TABLE: u32 = 64 * 1024 * 1024;
/// The largest standalone face an extraction will build.
const MAX_EXTRACT: usize = 256 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Checked big-endian reads                                            */
/* ------------------------------------------------------------------ */

fn bytes_at(d: &[u8], off: usize, len: usize) -> Option<&[u8]> {
    d.get(off..off.checked_add(len)?)
}
pub fn u16_at(d: &[u8], off: usize) -> Option<u16> {
    let b = bytes_at(d, off, 2)?;
    Some(u16::from_be_bytes([b[0], b[1]]))
}
fn i16_at(d: &[u8], off: usize) -> Option<i16> {
    u16_at(d, off).map(|v| v as i16)
}
pub fn u32_at(d: &[u8], off: usize) -> Option<u32> {
    let b = bytes_at(d, off, 4)?;
    Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}
fn us(v: u32) -> Option<usize> {
    usize::try_from(v).ok()
}

/* ------------------------------------------------------------------ */
/* Where the bytes come from                                           */
/* ------------------------------------------------------------------ */

/// Random access to a font file: a buffer in memory (an import) or an open
/// file read piecewise (enumeration never reads a 20 MB collection whole).
pub trait Source {
    fn len(&self) -> u64;
    /// Exactly `len` bytes at `off`, or None (past the end, or an I/O error).
    fn read(&mut self, off: u64, len: usize) -> Option<Vec<u8>>;
}

impl Source for &[u8] {
    fn len(&self) -> u64 {
        <[u8]>::len(self) as u64
    }
    fn read(&mut self, off: u64, len: usize) -> Option<Vec<u8>> {
        bytes_at(self, usize::try_from(off).ok()?, len).map(<[u8]>::to_vec)
    }
}

pub struct FileSource {
    file: File,
    len: u64,
}

impl FileSource {
    pub fn open(path: &std::path::Path) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(FileSource { file, len })
    }
}

impl Source for FileSource {
    fn len(&self) -> u64 {
        self.len
    }
    fn read(&mut self, off: u64, len: usize) -> Option<Vec<u8>> {
        if off.checked_add(len as u64)? > self.len {
            return None;
        }
        self.file.seek(SeekFrom::Start(off)).ok()?;
        let mut buf = vec![0u8; len];
        self.file.read_exact(&mut buf).ok()?;
        Some(buf)
    }
}

/* ------------------------------------------------------------------ */
/* Table directory                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableRecord {
    pub tag: u32,
    pub offset: u32,
    pub length: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directory {
    pub sfnt_version: u32,
    pub tables: Vec<TableRecord>,
}

impl Directory {
    pub fn find(&self, tag: &[u8; 4]) -> Option<TableRecord> {
        let t = u32::from_be_bytes(*tag);
        self.tables.iter().copied().find(|r| r.tag == t)
    }
}

/// The face offsets of a file: one (offset 0) for a single font, one per face
/// for a `ttcf` collection. Anything else is classified as an error.
pub fn face_offsets(src: &mut dyn Source) -> SfntResult<Vec<u32>> {
    let head = src.read(0, 4).ok_or(SfntError::NotAFont)?;
    let magic = u32_at(&head, 0).ok_or(SfntError::NotAFont)?;
    match magic {
        TAG_TTCF => {
            let h = src.read(0, 12).ok_or(SfntError::NotAFont)?;
            let n = u32_at(&h, 8).ok_or(SfntError::NotAFont)?;
            if n == 0 || n > MAX_FACES {
                return Err(SfntError::NotAFont);
            }
            let table = src.read(12, us(n * 4).ok_or(SfntError::NotAFont)?).ok_or(SfntError::NotAFont)?;
            (0..us(n).ok_or(SfntError::NotAFont)?)
                .map(|i| u32_at(&table, i * 4).ok_or(SfntError::NotAFont))
                .collect()
        }
        VERSION_TRUETYPE | VERSION_OTTO | VERSION_APPLE_TRUE => Ok(vec![0]),
        VERSION_TYP1 | TAG_WOFF | TAG_WOFF2 => Err(SfntError::Unsupported),
        _ => Err(SfntError::NotAFont),
    }
}

/// The table directory at `at`. Every record must lie inside the file, so a
/// truncated font fails here rather than at the table that is cut off.
pub fn directory_at(src: &mut dyn Source, at: u32) -> SfntResult<Directory> {
    let at = u64::from(at);
    let h = src.read(at, 12).ok_or(SfntError::NotAFont)?;
    let sfnt_version = u32_at(&h, 0).ok_or(SfntError::NotAFont)?;
    if !matches!(sfnt_version, VERSION_TRUETYPE | VERSION_OTTO | VERSION_APPLE_TRUE) {
        return Err(SfntError::NotAFont);
    }
    let n = u16_at(&h, 4).ok_or(SfntError::NotAFont)?;
    if n == 0 || n > MAX_TABLES {
        return Err(SfntError::NotAFont);
    }
    let recs = src.read(at + 12, usize::from(n) * 16).ok_or(SfntError::NotAFont)?;
    let file_len = src.len();
    let mut tables = Vec::with_capacity(usize::from(n));
    for i in 0..usize::from(n) {
        let base = i * 16;
        let rec = TableRecord {
            tag: u32_at(&recs, base).ok_or(SfntError::NotAFont)?,
            offset: u32_at(&recs, base + 8).ok_or(SfntError::NotAFont)?,
            length: u32_at(&recs, base + 12).ok_or(SfntError::NotAFont)?,
        };
        let end = u64::from(rec.offset)
            .checked_add(u64::from(rec.length))
            .ok_or(SfntError::NotAFont)?;
        if end > file_len {
            return Err(SfntError::NotAFont);
        }
        tables.push(rec);
    }
    Ok(Directory { sfnt_version, tables })
}

fn load_table(src: &mut dyn Source, dir: &Directory, tag: &[u8; 4]) -> SfntResult<Option<Vec<u8>>> {
    let Some(rec) = dir.find(tag) else { return Ok(None) };
    if rec.length > MAX_TABLE {
        return Err(SfntError::NotAFont);
    }
    let len = us(rec.length).ok_or(SfntError::NotAFont)?;
    src.read(u64::from(rec.offset), len).map(Some).ok_or(SfntError::NotAFont)
}

/* ------------------------------------------------------------------ */
/* One face                                                            */
/* ------------------------------------------------------------------ */

/// The raw tables of one face that the library reads.
#[derive(Debug, Clone, Default)]
pub struct FaceTables {
    pub sfnt_version: u32,
    pub head: Vec<u8>,
    pub hhea: Vec<u8>,
    pub os2: Option<Vec<u8>>,
    pub name: Option<Vec<u8>>,
    pub cmap: Option<Vec<u8>>,
}

/// Which optional tables to load (enumeration skips `cmap`, coverage skips
/// `name`).
#[derive(Debug, Clone, Copy)]
pub struct Want {
    pub name: bool,
    pub cmap: bool,
}

/// Load face `index` of a file. `head` and `hhea` are required.
pub fn load_face(src: &mut dyn Source, index: u32, want: Want) -> SfntResult<FaceTables> {
    let offsets = face_offsets(src)?;
    let at = *offsets.get(us(index).ok_or(SfntError::NotAFont)?).ok_or(SfntError::NotAFont)?;
    let dir = directory_at(src, at)?;
    let head = load_table(src, &dir, b"head")?.ok_or(SfntError::NotAFont)?;
    let hhea = load_table(src, &dir, b"hhea")?.ok_or(SfntError::NotAFont)?;
    let os2 = load_table(src, &dir, b"OS/2")?;
    let name = if want.name { load_table(src, &dir, b"name")? } else { None };
    let cmap = if want.cmap { load_table(src, &dir, b"cmap")? } else { None };
    Ok(FaceTables { sfnt_version: dir.sfnt_version, head, hhea, os2, name, cmap })
}

/// `head.unitsPerEm`, refused outside the spec's 16..=16384 (a 0 would divide
/// by zero below).
pub fn units_per_em(head: &[u8]) -> SfntResult<u16> {
    if head.len() < 54 || u32_at(head, 12) != Some(0x5F0F_3CF5) {
        return Err(SfntError::NotAFont);
    }
    let upem = u16_at(head, 18).ok_or(SfntError::NotAFont)?;
    if !(16..=16384).contains(&upem) {
        return Err(SfntError::NotAFont);
    }
    Ok(upem)
}

/// FreeType's `size->metrics.height` in em, the pitch drawtext steps lines by,
/// in `sfnt_load_face` (`sfobjs.c`) order:
/// 1. an OS/2 table (any version FreeType loads, i.e. at least the 78-byte v0
///    layout) with `fsSelection` bit 7 (USE_TYPO_METRICS) set: the typo
///    metrics, `(sTypoAscender - sTypoDescender + sTypoLineGap) / unitsPerEm`;
/// 2. otherwise `(hhea.ascender - hhea.descender + hhea.lineGap) / unitsPerEm`;
/// 3. when those hhea ascender and descender are both 0: the OS/2 typo
///    metrics if either is set, else the win metrics (no line gap).
/// Rule 1 was measured on the bundled ffmpeg, OS/2 versions 1, 3 and 4 alike.
pub fn line_height_em(head: &[u8], hhea: &[u8], os2: Option<&[u8]>) -> SfntResult<f64> {
    let upem = units_per_em(head)?;
    let asc = i16_at(hhea, 4).ok_or(SfntError::NotAFont)?;
    let desc = i16_at(hhea, 6).ok_or(SfntError::NotAFont)?;
    let gap = i16_at(hhea, 8).ok_or(SfntError::NotAFont)?;
    let mut height = i32::from(asc) - i32::from(desc) + i32::from(gap);
    // A loadable OS/2 (78 bytes covers every field read here) with bit 7 set.
    let typo_os2 = os2.filter(|t| t.len() >= 78 && u16_at(t, 62).is_some_and(|fs| fs & 0x80 != 0));
    if let Some(t) = typo_os2 {
        if let (Some(ta), Some(td), Some(tg)) = (i16_at(t, 68), i16_at(t, 70), i16_at(t, 72)) {
            height = i32::from(ta) - i32::from(td) + i32::from(tg);
        }
    } else if asc == 0 && desc == 0 {
        if let Some(os2) = os2 {
            let typo = (i16_at(os2, 68), i16_at(os2, 70), i16_at(os2, 72));
            match typo {
                (Some(ta), Some(td), Some(tg)) if ta != 0 || td != 0 => {
                    height = i32::from(ta) - i32::from(td) + i32::from(tg);
                }
                _ => {
                    let wa = u16_at(os2, 74).map(|v| v as i16);
                    let wd = u16_at(os2, 76).map(|v| v as i16);
                    if let (Some(wa), Some(wd)) = (wa, wd) {
                        height = i32::from(wa) + i32::from(wd);
                    }
                }
            }
        }
    }
    if height <= 0 {
        return Err(SfntError::NotAFont);
    }
    Ok(f64::from(height) / f64::from(upem))
}

/// `OS/2.fsType` to the PDF embedding policy. The usage bits (0-3) are
/// exclusive in the spec, and when a file sets several the least restrictive
/// wins, so "restricted" is bit 1 alone among them.
pub fn embed_from_fs_type(fs_type: u16) -> Embed {
    let usage = fs_type & 0x000F;
    let restricted = usage & 0x0002 != 0 && usage & 0x000C == 0;
    match () {
        _ if restricted || fs_type & 0x0200 != 0 => Embed::None,
        _ if fs_type & 0x0100 != 0 => Embed::NoSubset,
        _ => Embed::Full,
    }
}

/// The face's style bits and weight: OS/2 `fsSelection` (bit 5 bold, bit 0
/// italic, bit 9 oblique) and `usWeightClass`, else `head.macStyle`. The
/// weight is clamped to 100..=900 (legacy 1..9 values scale by 100).
pub struct StyleBits {
    pub bold: bool,
    pub italic: bool,
    pub weight: u16,
    pub embed: Embed,
}

pub fn style_bits(head: &[u8], os2: Option<&[u8]>) -> StyleBits {
    let mac = u16_at(head, 44).unwrap_or(0);
    let sel = os2.and_then(|t| u16_at(t, 62));
    let (bold, italic) = match sel {
        Some(s) => (s & 0x0020 != 0, s & 0x0201 != 0),
        None => (mac & 0x0001 != 0, mac & 0x0002 != 0),
    };
    let raw = os2.and_then(|t| u16_at(t, 4)).unwrap_or(if bold { 700 } else { 400 });
    let weight = match raw {
        1..=9 => raw * 100,
        _ => raw.clamp(100, 900),
    };
    let embed = embed_from_fs_type(os2.and_then(|t| u16_at(t, 8)).unwrap_or(0));
    StyleBits { bold, italic, weight, embed }
}

/* ------------------------------------------------------------------ */
/* name                                                                */
/* ------------------------------------------------------------------ */

/// The string for `name_id`, as Windows (and DirectWrite's en-us Win32 names)
/// reads it: platform 3 en-us first, then any platform-3 entry, then a
/// Macintosh Roman entry if it is plain ASCII.
pub fn name_string(name: &[u8], name_id: u16) -> Option<String> {
    let count = u16_at(name, 2)?.min(MAX_NAME_RECORDS);
    let strings = usize::from(u16_at(name, 4)?);
    let mut win_any: Option<String> = None;
    let mut mac: Option<String> = None;
    for i in 0..usize::from(count) {
        let r = 6 + i * 12;
        let (plat, enc, lang, id) = (u16_at(name, r)?, u16_at(name, r + 2)?, u16_at(name, r + 4)?, u16_at(name, r + 6)?);
        if id != name_id {
            continue;
        }
        let len = usize::from(u16_at(name, r + 8)?);
        let off = strings.checked_add(usize::from(u16_at(name, r + 10)?))?;
        let Some(raw) = bytes_at(name, off, len) else { continue };
        match (plat, enc) {
            (3, 0 | 1 | 10) => {
                let units = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]]));
                let s: String = char::decode_utf16(units).map(|c| c.unwrap_or('\u{FFFD}')).collect();
                if lang == 0x0409 {
                    return Some(s);
                }
                win_any.get_or_insert(s);
            }
            (1, 0) if raw.is_ascii() => {
                mac.get_or_insert_with(|| raw.iter().map(|&b| char::from(b)).collect());
            }
            _ => {}
        }
    }
    win_any.or(mac)
}

/* ------------------------------------------------------------------ */
/* cmap                                                                */
/* ------------------------------------------------------------------ */

/// The Unicode subtable FreeType would pick: the full-repertoire ones first.
const UNICODE_PREFERENCE: [(u16, u16); 8] = [(3, 10), (0, 6), (0, 4), (3, 1), (0, 3), (0, 2), (0, 1), (0, 0)];
const SUPPORTED_FORMATS: [u16; 5] = [0, 4, 6, 12, 13];

/// The best Unicode subtable of a `cmap`, as a slice from its start.
pub fn unicode_subtable(cmap: &[u8]) -> Option<&[u8]> {
    let n = u16_at(cmap, 2)?.min(MAX_CMAP_RECORDS);
    let mut found: Vec<((u16, u16), &[u8])> = Vec::new();
    for i in 0..usize::from(n) {
        let r = 4 + i * 8;
        let (plat, enc) = (u16_at(cmap, r)?, u16_at(cmap, r + 2)?);
        let off = us(u32_at(cmap, r + 4)?)?;
        let Some(sub) = cmap.get(off..) else { continue };
        let Some(format) = u16_at(sub, 0) else { continue };
        if SUPPORTED_FORMATS.contains(&format) {
            found.push(((plat, enc), sub));
        }
    }
    UNICODE_PREFERENCE.iter().find_map(|key| found.iter().find(|(k, _)| k == key).map(|(_, s)| *s))
}

/// Whether the subtable maps `cp` to a real glyph (not glyph 0).
pub fn has_glyph(sub: &[u8], cp: u32) -> bool {
    glyph_of(sub, cp).is_some_and(|g| g != 0)
}

fn glyph_of(sub: &[u8], cp: u32) -> Option<u32> {
    match u16_at(sub, 0)? {
        0 => {
            let i = usize::try_from(cp).ok().filter(|&i| i < 256)?;
            sub.get(6 + i).map(|&g| u32::from(g))
        }
        4 => format4(sub, cp),
        6 => {
            let first = u32::from(u16_at(sub, 6)?);
            let count = u32::from(u16_at(sub, 8)?);
            let i = cp.checked_sub(first).filter(|&i| i < count)?;
            u16_at(sub, 10 + us(i)? * 2).map(u32::from)
        }
        12 | 13 => {
            let n = u32_at(sub, 12)?;
            let n = n.min(u32::try_from(sub.len() / 12).unwrap_or(u32::MAX));
            for g in 0..us(n)? {
                let base = 16usize.checked_add(g.checked_mul(12)?)?;
                let (start, end, glyph) = (u32_at(sub, base)?, u32_at(sub, base + 4)?, u32_at(sub, base + 8)?);
                if (start..=end).contains(&cp) {
                    let is12 = u16_at(sub, 0)? == 12;
                    return Some(if is12 { glyph.wrapping_add(cp - start) } else { glyph });
                }
            }
            None
        }
        _ => None,
    }
}

fn format4(sub: &[u8], cp: u32) -> Option<u32> {
    let cp = u16::try_from(cp).ok()?;
    let seg_x2 = usize::from(u16_at(sub, 6)?);
    let seg = seg_x2 / 2;
    let ends = 14;
    let starts = ends + seg_x2 + 2;
    let deltas = starts + seg_x2;
    let ranges = deltas + seg_x2;
    for i in 0..seg {
        let end = u16_at(sub, ends + i * 2)?;
        if cp > end {
            continue;
        }
        let start = u16_at(sub, starts + i * 2)?;
        if cp < start {
            return Some(0);
        }
        let delta = u16_at(sub, deltas + i * 2)?;
        let range_at = ranges + i * 2;
        let range = usize::from(u16_at(sub, range_at)?);
        if range == 0 {
            return Some(u32::from(cp.wrapping_add(delta)));
        }
        let at = range_at.checked_add(range)?.checked_add(usize::from(cp - start) * 2)?;
        let g = u16_at(sub, at)?;
        return Some(if g == 0 { 0 } else { u32::from(g.wrapping_add(delta)) });
    }
    Some(0)
}

/* ------------------------------------------------------------------ */
/* Collection face extraction                                          */
/* ------------------------------------------------------------------ */

/// The sfnt checksum: the big-endian u32 words summed (a short tail padded
/// with zeros). A whole valid file sums to 0xB1B0AFBA.
pub fn checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0u32, |sum, c| {
        let mut w = [0u8; 4];
        w[..c.len()].copy_from_slice(c);
        sum.wrapping_add(u32::from_be_bytes(w))
    })
}

/// Face `index` of a `ttcf` collection as a standalone sfnt: a fresh table
/// directory (search fields recomputed, tables in tag order, each 4-byte
/// aligned with zero padding), every table checksum recomputed, and
/// `head.checkSumAdjustment` set so the whole file sums to 0xB1B0AFBA.
pub fn extract_face(bytes: &[u8], index: u32) -> SfntResult<Vec<u8>> {
    let mut src: &[u8] = bytes;
    let offsets = face_offsets(&mut src)?;
    if u32_at(bytes, 0) != Some(TAG_TTCF) {
        return Err(SfntError::NotAFont);
    }
    let at = *offsets.get(us(index).ok_or(SfntError::NotAFont)?).ok_or(SfntError::NotAFont)?;
    let mut dir = directory_at(&mut src, at)?;
    dir.tables.sort_by_key(|r| r.tag);
    dir.tables.dedup_by_key(|r| r.tag);
    let n = u16::try_from(dir.tables.len()).map_err(|_| SfntError::NotAFont)?;
    let pow = if n == 0 { 0 } else { 15 - n.leading_zeros() as u16 }; // floor(log2 n)
    let search = (1u16 << pow) * 16;

    let header_len = 12 + usize::from(n) * 16;
    let mut out = Vec::with_capacity(header_len);
    out.extend_from_slice(&dir.sfnt_version.to_be_bytes());
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(&search.to_be_bytes());
    out.extend_from_slice(&pow.to_be_bytes());
    out.extend_from_slice(&(n * 16 - search).to_be_bytes());
    out.resize(header_len, 0);

    let mut head_at: Option<usize> = None;
    for (i, rec) in dir.tables.iter().enumerate() {
        let data = bytes_at(bytes, us(rec.offset).ok_or(SfntError::NotAFont)?, us(rec.length).ok_or(SfntError::NotAFont)?)
            .ok_or(SfntError::NotAFont)?;
        let off = out.len();
        if off.checked_add(data.len()).is_none_or(|end| end > MAX_EXTRACT) {
            return Err(SfntError::NotAFont);
        }
        out.extend_from_slice(data);
        if rec.tag == u32::from_be_bytes(*b"head") {
            if data.len() < 12 {
                return Err(SfntError::NotAFont);
            }
            out[off + 8..off + 12].copy_from_slice(&[0; 4]);
            head_at = Some(off);
        }
        let sum = checksum(&out[off..]);
        while out.len() % 4 != 0 {
            out.push(0);
        }
        let r = 12 + i * 16;
        out[r..r + 4].copy_from_slice(&rec.tag.to_be_bytes());
        out[r + 4..r + 8].copy_from_slice(&sum.to_be_bytes());
        out[r + 8..r + 12].copy_from_slice(&u32::try_from(off).map_err(|_| SfntError::NotAFont)?.to_be_bytes());
        out[r + 12..r + 16].copy_from_slice(&rec.length.to_be_bytes());
    }
    let head_at = head_at.ok_or(SfntError::NotAFont)?;
    let adjust = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
    out[head_at + 8..head_at + 12].copy_from_slice(&adjust.to_be_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os2_with(fs_type: u16) -> Vec<u8> {
        let mut t = vec![0u8; 96];
        t[8..10].copy_from_slice(&fs_type.to_be_bytes());
        t
    }

    /// fsType on synthesized OS/2 tables, through the same reader the faces
    /// use (`style_bits`), one value per policy branch.
    #[test]
    fn fs_type_maps_to_the_seam_embedding() {
        let head = [0u8; 54];
        let cases = [
            (0x0000, Embed::Full),
            (0x0002, Embed::None),
            (0x0008, Embed::Full),
            (0x0100, Embed::NoSubset),
            (0x0200, Embed::None),
        ];
        for (fs, want) in cases {
            assert_eq!(style_bits(&head, Some(&os2_with(fs))).embed, want, "fsType {fs:#06x}");
        }
        // Several usage bits: the least restrictive (editable) wins.
        assert_eq!(embed_from_fs_type(0x000A), Embed::Full);
        // No OS/2 at all: nothing restricts it.
        assert_eq!(style_bits(&head, None).embed, Embed::Full);
    }

    fn head(upem: u16) -> Vec<u8> {
        let mut h = vec![0u8; 54];
        h[12..16].copy_from_slice(&0x5F0F_3CF5u32.to_be_bytes());
        h[18..20].copy_from_slice(&upem.to_be_bytes());
        h
    }
    fn hhea(asc: i16, desc: i16, gap: i16) -> Vec<u8> {
        let mut h = vec![0u8; 36];
        h[4..6].copy_from_slice(&asc.to_be_bytes());
        h[6..8].copy_from_slice(&desc.to_be_bytes());
        h[8..10].copy_from_slice(&gap.to_be_bytes());
        h
    }
    fn os2_metrics(typo: (i16, i16, i16), win: (u16, u16)) -> Vec<u8> {
        let mut t = vec![0u8; 96];
        t[68..70].copy_from_slice(&typo.0.to_be_bytes());
        t[70..72].copy_from_slice(&typo.1.to_be_bytes());
        t[72..74].copy_from_slice(&typo.2.to_be_bytes());
        t[74..76].copy_from_slice(&win.0.to_be_bytes());
        t[76..78].copy_from_slice(&win.1.to_be_bytes());
        t
    }

    /// The FreeType fallback, each branch with values that differ on every
    /// axis: hhea wins when set; typo when hhea is 0/0; win when typo is 0/0.
    #[test]
    fn line_height_follows_freetypes_fallback() {
        let os2 = os2_metrics((700, -300, 100), (900, 250));
        let h = head(1000);
        assert_eq!(line_height_em(&h, &hhea(800, -200, 50), Some(&os2)).unwrap(), 1.05);
        assert_eq!(line_height_em(&h, &hhea(0, 0, 50), Some(&os2)).unwrap(), 1.1);
        let no_typo = os2_metrics((0, 0, 100), (900, 250));
        assert_eq!(line_height_em(&h, &hhea(0, 0, 50), Some(&no_typo)).unwrap(), 1.15);
        // A zero or absurd unitsPerEm is refused, never divided by.
        assert_eq!(line_height_em(&head(0), &hhea(800, -200, 50), None), Err(SfntError::NotAFont));
    }

    fn with_fs_selection(mut os2: Vec<u8>, version: u16, fs_selection: u16) -> Vec<u8> {
        os2[0..2].copy_from_slice(&version.to_be_bytes());
        os2[62..64].copy_from_slice(&fs_selection.to_be_bytes());
        os2
    }

    /// USE_TYPO_METRICS (fsSelection bit 7): the bundled ffmpeg's FreeType
    /// steps lines by the typo metrics whenever the bit is set, whatever the
    /// OS/2 version (measured on v1, v3 and v4); with it clear, hhea as before.
    #[test]
    fn line_height_honours_use_typo_metrics() {
        let h = head(1000);
        let hh = hhea(800, -200, 50); // 1.05
        let typo = os2_metrics((700, -300, 100), (900, 250)); // typo 1.1
        for version in [1, 3, 4] {
            let set = with_fs_selection(typo.clone(), version, 0x0080 | 0x0040);
            assert_eq!(line_height_em(&h, &hh, Some(&set)).unwrap(), 1.1, "v{version} bit set");
            let clear = with_fs_selection(typo.clone(), version, 0x0040);
            assert_eq!(line_height_em(&h, &hh, Some(&clear)).unwrap(), 1.05, "v{version} bit clear");
        }
        // The bit wins over the zero-hhea fallback too (typo, never win).
        let set = with_fs_selection(typo.clone(), 4, 0x0080);
        assert_eq!(line_height_em(&h, &hhea(0, 0, 50), Some(&set)).unwrap(), 1.1);
        // An OS/2 shorter than FreeType's 78-byte minimum is not loaded: hhea.
        let short = with_fs_selection(typo, 4, 0x0080)[..77].to_vec();
        assert_eq!(line_height_em(&h, &hh, Some(&short)).unwrap(), 1.05);
    }

    /// A stock Windows font that sets the bit with typo != hhea: Liberation
    /// Sans Narrow (hhea 2350/2048 = 1.1475, typo 2191/2048 = 1.0698). The
    /// bundled ffmpeg drew it at 214 / 160 / 104 px pitch at 200 / 150 / 97 px,
    /// i.e. round(1.0698 * size). Skipped when the file is absent.
    #[test]
    fn liberation_sans_narrow_uses_its_typo_metrics() {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let path = std::path::Path::new(&root).join("Fonts").join("LiberationSansNarrow-Regular.ttf");
        let Ok(mut src) = FileSource::open(&path) else {
            eprintln!("skipped: {} absent", path.display());
            return;
        };
        let want = Want { name: false, cmap: false };
        let t = load_face(&mut src, 0, want).unwrap();
        let got = line_height_em(&t.head, &t.hhea, t.os2.as_deref()).unwrap();
        assert_eq!((got * 10_000.0).round() / 10_000.0, 1.0698);
        for (size, pitch) in [(200.0, 214.0), (150.0, 160.0), (97.0, 104.0)] {
            assert_eq!((got * size).round(), pitch, "size {size}");
        }
    }

    fn cmap4(segments: &[(u16, u16, i16)]) -> Vec<u8> {
        // Format 4 with idRangeOffset 0 everywhere, plus the 0xFFFF sentinel.
        let mut segs: Vec<(u16, u16, i16)> = segments.to_vec();
        segs.push((0xFFFF, 0xFFFF, 1));
        let n = segs.len();
        let mut t = vec![0u8; 14];
        t[0..2].copy_from_slice(&4u16.to_be_bytes());
        t[6..8].copy_from_slice(&((n * 2) as u16).to_be_bytes());
        for s in &segs {
            t.extend_from_slice(&s.1.to_be_bytes());
        }
        t.extend_from_slice(&[0, 0]);
        for s in &segs {
            t.extend_from_slice(&s.0.to_be_bytes());
        }
        for s in &segs {
            t.extend_from_slice(&s.2.to_be_bytes());
        }
        for _ in &segs {
            t.extend_from_slice(&[0, 0]);
        }
        let len = t.len() as u16;
        t[2..4].copy_from_slice(&len.to_be_bytes());
        let mut cmap = vec![0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12];
        cmap.extend_from_slice(&t);
        cmap
    }

    #[test]
    fn cmap_format4_maps_inside_segments_only() {
        // 'A'..'C' -> glyphs 1..3 (delta -64); nothing else.
        let cmap = cmap4(&[(0x41, 0x43, -64)]);
        let sub = unicode_subtable(&cmap).expect("a (3,1) subtable");
        assert!(has_glyph(sub, 0x42));
        assert!(!has_glyph(sub, 0x44));
        assert!(!has_glyph(sub, 0x6F22));
        assert!(!has_glyph(sub, 0x1F600));
    }

    /// Hostile bytes: every prefix of a valid-looking file and pseudo-random
    /// garbage go through every entry point without a panic.
    #[test]
    fn truncated_and_garbage_tables_never_panic() {
        let mut rng = 0x2545_F491_4F6C_DD1Du64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        let probe = |b: &[u8]| {
            let mut s: &[u8] = b;
            let _ = load_face(&mut s, 0, Want { name: true, cmap: true }).map(|t| {
                let _ = line_height_em(&t.head, &t.hhea, t.os2.as_deref());
                let _ = style_bits(&t.head, t.os2.as_deref());
                if let Some(n) = &t.name {
                    let _ = name_string(n, 1);
                }
                if let Some(sub) = t.cmap.as_deref().and_then(unicode_subtable) {
                    for cp in [0x41, 0xFFFF, 0x10FFFF] {
                        let _ = has_glyph(sub, cp);
                    }
                }
            });
            let _ = extract_face(b, 0);
            let _ = extract_face(b, 7);
            for t in [b, &b[b.len().min(6)..]] {
                let _ = name_string(t, 1);
                let _ = unicode_subtable(t).map(|s| has_glyph(s, 0x41));
                for f in [0u16, 4, 6, 12, 13] {
                    let mut x = f.to_be_bytes().to_vec();
                    x.extend_from_slice(t);
                    let _ = has_glyph(&x, 0x41);
                    let _ = has_glyph(&x, 0xFFFF);
                }
            }
        };
        // A minimal collection whose one face claims tables far past the end.
        let mut ttc = b"ttcf\0\x01\0\0\0\0\0\x01\0\0\0\x10".to_vec();
        ttc.extend_from_slice(&VERSION_TRUETYPE.to_be_bytes());
        ttc.extend_from_slice(&[0, 2, 0, 32, 0, 1, 0, 0]);
        ttc.extend_from_slice(b"head\0\0\0\0\xFF\xFF\xFF\xF0\0\0\0\x40");
        ttc.extend_from_slice(b"hhea\0\0\0\0\0\0\0\x10\xFF\xFF\xFF\xFF");
        for cut in 0..=ttc.len() {
            probe(&ttc[..cut]);
        }
        for len in [0usize, 3, 12, 64, 300, 4096] {
            for _ in 0..40 {
                let mut g: Vec<u8> = (0..len).map(|_| next() as u8).collect();
                // Make some of them look like a font so the deeper paths run.
                if len >= 12 && next() % 2 == 0 {
                    g[0..4].copy_from_slice(&VERSION_TRUETYPE.to_be_bytes());
                    g[4..6].copy_from_slice(&[0, 3]);
                }
                probe(&g);
            }
        }
    }
}
