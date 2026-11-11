//! The font library (0.9.4): fonts the user imported into the library folder
//! and fonts installed on this PC, named by id only (`src/core/font-id.ts`).
//! The six legacy fonts never come through here: they keep
//! `export::system_font_path` and the builder's own table.
//!
//! An id is never joined into a path. Rust maps it to a file it located itself
//! (a library file, an installed font's file, or a face extracted into the
//! cache).
//!
//! The wire shapes below are the contract (`src/core/types.ts` and the
//! `fonts*` wrappers in `src/core/ipc.ts` mirror them, field for field). Each
//! command does its work in `spawn_blocking`.
//!
//! - Installed fonts: DirectWrite lists the faces (`dwrite.rs`), on the first
//!   need only, then they are held in memory until a `refresh`.
//! - Library: `data_dir()/fonts/<xxh3_64 of the bytes>.ttf|.otf`. No manifest:
//!   the folder is scanned on first need and held until an import or removal.
//! - Every face's style bits, weight, metrics and fsType come from its file
//!   through `sfnt.rs`, a bounds-checked reader (untrusted bytes under
//!   `panic = "abort"`).
//! - A face inside a collection is extracted into
//!   `cache_dir()/fonts/<hash>-<index>.ttf` so every consumer (drawtext,
//!   pdf-lib, the WebView's FontFace) gets a standalone file.

mod sfnt;
#[cfg(windows)]
mod dwrite;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use xxhash_rust::xxh3::xxh3_64;

use crate::error::{AppError, Result};
use sfnt::{FileSource, SfntError, Source, Want};

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

/// How a face may be embedded in a PDF, from `OS/2.fsType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Embed {
    Full,
    NoSubset,
    /// Restricted licence: PDF export refuses the font.
    None,
}

/// Where a family comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FontSource {
    Library,
    Installed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFaceInfo {
    pub bold: bool,
    pub italic: bool,
    pub weight: u16,
    pub style: String,
    pub embed: Embed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamilyInfo {
    pub id: String,
    pub name: String,
    pub source: FontSource,
    pub faces: Vec<FontFaceInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCatalog {
    pub library: Vec<FontFamilyInfo>,
    pub installed: Vec<FontFamilyInfo>,
}

/// One face asked for.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRequest {
    pub id: String,
    pub bold: bool,
    pub italic: bool,
}

/// `found: false` = not on this PC: the other fields are empty and the
/// caller uses the object's legacy font. `bold`/`italic` are the face actually
/// used (no faux styles).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFont {
    pub requested: String,
    pub found: bool,
    pub bold: bool,
    pub italic: bool,
    pub path: String,
    pub line_height_em: f64,
    pub embed: Embed,
}

impl ResolvedFont {
    /// The answer for a font that is not on this PC.
    pub fn not_found(requested: String) -> Self {
        ResolvedFont {
            requested,
            found: false,
            bold: false,
            italic: false,
            path: String::new(),
            line_height_em: 0.0,
            embed: Embed::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FontImportError {
    Extension,
    TooLarge,
    NotAFont,
    NoUnicode,
    Unsupported,
    Exists,
    Io,
}

/// One imported file's outcome. The optional fields are omitted, not `null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontImportResult {
    pub path: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FontImportError>,
}

impl FontImportResult {
    pub fn failed(path: String, error: FontImportError) -> Self {
        FontImportResult { path, ok: false, id: None, family: None, style: None, error: Some(error) }
    }
}

/// One item of `fonts_missing_glyphs`: `FontRequest & { text }` on the TS side.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphCheck {
    pub id: String,
    pub bold: bool,
    pub italic: bool,
    pub text: String,
}

/* ------------------------------------------------------------------ */
/* Ids                                                                 */
/* ------------------------------------------------------------------ */

const LIB_PREFIX: &str = "lib:";
const MAX_ID_UNITS: usize = 96;
/// The largest file `fonts_import` copies into the library.
const MAX_IMPORT: u64 = 64 * 1024 * 1024;

/// `isFontId` of `src/core/font-id.ts`: 1..96 UTF-16 units, no control
/// characters, no leading or trailing whitespace, `lib:` followed by at least
/// one character. Shape only.
fn is_font_id(id: &str) -> bool {
    let units = id.encode_utf16().count();
    // JS `\s` is Unicode White_Space plus U+FEFF.
    let space = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    (1..=MAX_ID_UNITS).contains(&units)
        && !id.chars().any(|c| c <= '\u{1F}' || c == '\u{7F}')
        && !id.starts_with(space)
        && !id.ends_with(space)
        && id != LIB_PREFIX
}

/* ------------------------------------------------------------------ */
/* Faces                                                               */
/* ------------------------------------------------------------------ */

/// One real (never simulated) face Rust located itself.
#[derive(Debug, Clone, PartialEq)]
struct Face {
    family: String,
    style: String,
    bold: bool,
    italic: bool,
    weight: u16,
    embed: Embed,
    line_height_em: f64,
    /// The file DirectWrite or the library scan found; for a collection, the
    /// `.ttc` itself (the standalone copy is made on resolve).
    path: PathBuf,
    index: u32,
}

impl Face {
    fn from_tables(family: String, style: String, path: PathBuf, index: u32, t: &sfnt::FaceTables) -> Option<Face> {
        let line_height_em = sfnt::line_height_em(&t.head, &t.hhea, t.os2.as_deref()).ok()?;
        let bits = sfnt::style_bits(&t.head, t.os2.as_deref());
        // The Win32 subfamily is the RIBBI slot Windows files the face under
        // (DirectWrite's WIN32_SUBFAMILY, or name ID 2): it decides bold and
        // italic. "Yu Gothic UI Semibold" sets fsSelection's bold bit but is
        // its family's Regular. Any other subfamily falls back to the bits.
        let (bold, italic) = ribbi_of(&style).unwrap_or((bits.bold, bits.italic));
        Some(Face {
            family,
            style: shown_style(style, bold, italic),
            bold,
            italic,
            weight: bits.weight,
            embed: bits.embed,
            line_height_em,
            path,
            index,
        })
    }

    fn info(&self) -> FontFaceInfo {
        FontFaceInfo { bold: self.bold, italic: self.italic, weight: self.weight, style: self.style.clone(), embed: self.embed }
    }
}

/// The longest subfamily name passed to the UI as it is.
const MAX_STYLE_CHARS: usize = 64;

/// A face's style name as the UI gets it: the file's own (name ID 2, which a
/// hostile file can make ~32K characters of anything), unless it is empty, has
/// a control character or is longer than `MAX_STYLE_CHARS`; then the plain
/// label of the face's bold/italic.
fn shown_style(style: String, bold: bool, italic: bool) -> String {
    if !style.is_empty() && !style.chars().any(char::is_control) && style.chars().count() <= MAX_STYLE_CHARS {
        return style;
    }
    match (bold, italic) {
        (false, false) => "Regular",
        (true, false) => "Bold",
        (false, true) => "Italic",
        (true, true) => "Bold Italic",
    }
    .to_owned()
}

/// (bold, italic) of a Win32 subfamily name, when it is one of the four.
fn ribbi_of(style: &str) -> Option<(bool, bool)> {
    match style {
        "Regular" => Some((false, false)),
        "Bold" => Some((true, false)),
        "Italic" | "Oblique" => Some((false, true)),
        "Bold Italic" | "Bold Oblique" => Some((true, true)),
        _ => None,
    }
}

/// The face to use for a request, in the seam's order: the exact (bold,
/// italic); else the same italic at another weight; else the regular face;
/// else the family's first face. Within a step, the weight nearest the one
/// asked for (700 bold, 400 otherwise) wins, then list order.
fn choose<'a>(faces: &[&'a Face], bold: bool, italic: bool) -> Option<&'a Face> {
    let nearest = |pred: &dyn Fn(&Face) -> bool, target: i32| {
        faces.iter().copied().filter(|f| pred(f)).min_by_key(|f| (i32::from(f.weight) - target).abs())
    };
    let target = if bold { 700 } else { 400 };
    nearest(&|f| f.bold == bold && f.italic == italic, target)
        .or_else(|| nearest(&|f| f.italic == italic, target))
        .or_else(|| nearest(&|f| !f.bold && !f.italic, 400))
        .or_else(|| faces.first().copied())
}

/// The catalogue's order: families by name (case-folded, then exact), faces
/// upright before italic, regular before bold, lighter first.
fn sort_faces(faces: &mut [Face]) {
    faces.sort_by(|a, b| {
        (a.family.to_lowercase(), &a.family, a.italic, a.bold, a.weight, &a.style)
            .cmp(&(b.family.to_lowercase(), &b.family, b.italic, b.bold, b.weight, &b.style))
    });
}

fn families(faces: &[Face], source: FontSource) -> Vec<FontFamilyInfo> {
    let mut out: Vec<FontFamilyInfo> = Vec::new();
    for f in faces {
        let id = match source {
            FontSource::Library => format!("{LIB_PREFIX}{}", f.family),
            FontSource::Installed => f.family.clone(),
        };
        match out.last_mut() {
            Some(last) if last.id == id => last.faces.push(f.info()),
            _ => out.push(FontFamilyInfo { id, name: f.family.clone(), source, faces: vec![f.info()] }),
        }
    }
    out
}

/* ------------------------------------------------------------------ */
/* Installed fonts                                                     */
/* ------------------------------------------------------------------ */

/// Installed faces, enumerated on the first need and held until a refresh.
/// One per process: the system collection is the same for every caller.
static INSTALLED: Mutex<Option<Arc<Vec<Face>>>> = Mutex::new(None);

fn installed(refresh: bool) -> Arc<Vec<Face>> {
    let mut held = INSTALLED.lock().unwrap_or_else(|e| e.into_inner());
    if let (false, Some(faces)) = (refresh, held.as_ref()) {
        return faces.clone();
    }
    match enumerate_installed(refresh) {
        Some(faces) => {
            let faces = Arc::new(faces);
            *held = Some(faces.clone());
            faces
        }
        // A failed enumeration is not remembered: the next need tries again.
        None => Arc::new(Vec::new()),
    }
}

#[cfg(windows)]
fn enumerate_installed(check_updates: bool) -> Option<Vec<Face>> {
    let listed = dwrite::list_installed(check_updates).ok()?;
    // Group by file face. A variable font's named instances all sit at the
    // same (file, index) and every consumer draws its DEFAULT instance, so
    // only the listing whose names are the file's own (name IDs 1 and 2)
    // stays; "Bahnschrift SemiBold" would otherwise draw as Regular.
    let mut groups: HashMap<(String, u32), Vec<dwrite::ListedFace>> = HashMap::new();
    let mut order: Vec<(String, u32)> = Vec::new();
    for l in listed {
        if !is_font_id(&l.family) {
            continue;
        }
        let key = (l.path.to_string_lossy().to_lowercase(), l.index);
        let g = groups.entry(key.clone()).or_default();
        if g.is_empty() {
            order.push(key);
        }
        g.push(l);
    }
    let mut files: HashMap<String, Option<FileSource>> = HashMap::new();
    let mut faces = Vec::new();
    for key in order {
        let Some(group) = groups.remove(&key) else { continue };
        let Some(first) = group.first() else { continue };
        let src = files.entry(key.0.clone()).or_insert_with(|| FileSource::open(&first.path).ok());
        let Some(src) = src.as_mut() else { continue };
        let want = Want { name: group.len() > 1, cmap: false };
        let Ok(tables) = sfnt::load_face(src, key.1, want) else { continue };
        let (family, style) = if group.len() > 1 {
            let own = tables.name.as_deref().map(|n| (sfnt::name_string(n, 1), sfnt::name_string(n, 2)));
            let matching = group
                .iter()
                .find(|l| own.as_ref().is_some_and(|(f, s)| f.as_deref() == Some(&l.family) && s.as_deref() == Some(&l.style)));
            match (matching, own) {
                (Some(l), _) => (l.family.clone(), l.style.clone()),
                // No listing carries the file's own names (Segoe UI Variable
                // lists only "Small Light" and the like): the default instance
                // is what draws, so it is listed under the file's own names.
                (None, Some((Some(f), s))) if is_font_id(&f) => (f, s.unwrap_or_else(|| "Regular".to_owned())),
                (None, _) => (first.family.clone(), first.style.clone()),
            }
        } else {
            (first.family.clone(), first.style.clone())
        };
        if let Some(face) = Face::from_tables(family, style, first.path.clone(), first.index, &tables) {
            faces.push(face);
        }
    }
    sort_faces(&mut faces);
    Some(faces)
}

#[cfg(not(windows))]
fn enumerate_installed(_check_updates: bool) -> Option<Vec<Face>> {
    Some(Vec::new())
}

/* ------------------------------------------------------------------ */
/* The service: library + resolution                                   */
/* ------------------------------------------------------------------ */

/// What a validated font file is, before it enters the library.
struct Checked {
    family: String,
    style: String,
    tables: sfnt::FaceTables,
    ext: &'static str,
}

/// The library policy: one TrueType- or CFF-flavoured face (no collections,
/// no Apple `true`, no WOFF), every table inside the file, `head`/`hhea`
/// sane, a family name, a Unicode `cmap`, and a family that makes a valid id.
fn check_font(bytes: &[u8]) -> std::result::Result<Checked, FontImportError> {
    let map = |e: SfntError| match e {
        SfntError::NotAFont => FontImportError::NotAFont,
        SfntError::Unsupported => FontImportError::Unsupported,
    };
    let mut src: &[u8] = bytes;
    let offsets = sfnt::face_offsets(&mut src).map_err(map)?;
    if sfnt::u32_at(bytes, 0) == Some(sfnt::TAG_TTCF) || offsets.len() != 1 {
        return Err(FontImportError::Unsupported);
    }
    let tables = sfnt::load_face(&mut src, 0, Want { name: true, cmap: true }).map_err(map)?;
    let ext = match tables.sfnt_version {
        sfnt::VERSION_TRUETYPE => "ttf",
        sfnt::VERSION_OTTO => "otf",
        _ => return Err(FontImportError::Unsupported),
    };
    sfnt::line_height_em(&tables.head, &tables.hhea, tables.os2.as_deref()).map_err(map)?;
    let name = tables.name.as_deref().ok_or(FontImportError::NotAFont)?;
    let family = sfnt::name_string(name, 1).ok_or(FontImportError::NotAFont)?;
    let style = sfnt::name_string(name, 2).unwrap_or_else(|| "Regular".to_owned());
    if tables.cmap.as_deref().and_then(sfnt::unicode_subtable).is_none() {
        return Err(FontImportError::NoUnicode);
    }
    if !is_font_id(&format!("{LIB_PREFIX}{family}")) {
        return Err(FontImportError::Unsupported);
    }
    Ok(Checked { family, style, tables, ext })
}

/// A library file name: 16 lowercase hex digits, `.ttf` or `.otf`.
fn is_library_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else { return false };
    stem.len() == 16 && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && matches!(ext, "ttf" | "otf")
}

struct Library {
    dir: PathBuf,
    faces: Vec<Face>,
}

/// The font service. The app uses `APP`, whose folders come from `paths` at
/// call time; tests build their own over private folders, so they never touch
/// the owner's data and never mutate process-wide environment variables.
struct Service {
    data_root: Option<PathBuf>,
    cache_root: Option<PathBuf>,
    library: Mutex<Option<Library>>,
}

static APP: Service = Service { data_root: None, cache_root: None, library: Mutex::new(None) };

impl Service {
    #[cfg(test)]
    fn at(data_root: PathBuf, cache_root: PathBuf) -> Service {
        Service { data_root: Some(data_root), cache_root: Some(cache_root), library: Mutex::new(None) }
    }

    fn library_dir(&self) -> Result<PathBuf> {
        let root = match &self.data_root {
            Some(r) => r.clone(),
            None => crate::paths::data_dir()?,
        };
        Ok(root.join("fonts"))
    }

    fn extract_dir(&self) -> Result<PathBuf> {
        let root = match &self.cache_root {
            Some(r) => r.clone(),
            None => crate::paths::cache_dir()?,
        };
        // The cache's own kind folder, so its size, trim and Clear cache cover it.
        Ok(root.join(crate::cache::CacheKind::Fonts.dir_name()))
    }

    /// Run `f` on the library, scanning the folder on first need (or after
    /// a failed write left the memo dropped).
    fn with_library<T>(&self, f: impl FnOnce(&mut Library) -> T) -> Result<T> {
        let dir = self.library_dir()?;
        let mut held = self.library.lock().unwrap_or_else(|e| e.into_inner());
        if held.as_ref().is_none_or(|l| l.dir != dir) {
            *held = Some(Library { faces: scan_library(&dir), dir });
        }
        let lib = held.as_mut().ok_or_else(|| AppError::Io(std::io::Error::other("font library unavailable")))?;
        Ok(f(lib))
    }

    fn forget_library(&self) {
        *self.library.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn list(&self, refresh: bool) -> FontCatalog {
        if refresh {
            self.forget_library();
        }
        let library = self.with_library(|l| families(&l.faces, FontSource::Library)).unwrap_or_default();
        FontCatalog { library, installed: families(&installed(refresh), FontSource::Installed) }
    }

    /// The face an id names, by exact lookup in the faces Rust listed: an id
    /// is never joined into a path.
    fn find_face(&self, id: &str, bold: bool, italic: bool) -> Option<Face> {
        if !is_font_id(id) {
            return None;
        }
        if let Some(family) = id.strip_prefix(LIB_PREFIX) {
            return self
                .with_library(|l| {
                    let faces: Vec<&Face> = l.faces.iter().filter(|f| f.family == family).collect();
                    choose(&faces, bold, italic).cloned()
                })
                .ok()
                .flatten();
        }
        let all = installed(false);
        let faces: Vec<&Face> = all.iter().filter(|f| f.family == id).collect();
        choose(&faces, bold, italic).cloned()
    }

    fn resolve(&self, id: &str, bold: bool, italic: bool) -> Option<ResolvedFace> {
        let face = self.find_face(id, bold, italic)?;
        let path = self.standalone(&face)?;
        Some(ResolvedFace { path, line_height_em: face.line_height_em, bold: face.bold, italic: face.italic, embed: face.embed })
    }

    /// The face as a standalone sfnt file: the file itself, or for a face of
    /// a collection a copy extracted into the cache (made once per file
    /// version: the name hashes the collection's path, size and mtime).
    fn standalone(&self, face: &Face) -> Option<PathBuf> {
        let mut src = FileSource::open(&face.path).ok()?;
        let magic = src.read(0, 4)?;
        if sfnt::u32_at(&magic, 0) != Some(sfnt::TAG_TTCF) {
            return (face.index == 0).then(|| face.path.clone());
        }
        let meta = std::fs::metadata(&face.path).ok()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        let ident = format!("{}|{}|{}", face.path.to_string_lossy(), meta.len(), mtime);
        let dir = self.extract_dir().ok()?;
        let out = dir.join(format!("{:016x}-{}.ttf", xxh3_64(ident.as_bytes()), face.index));
        if std::fs::metadata(&out).is_ok_and(|m| m.is_file() && m.len() > 0) {
            return Some(out);
        }
        let bytes = std::fs::read(&face.path).ok()?;
        let extracted = sfnt::extract_face(&bytes, face.index).ok()?;
        // Only a face that reads back is ever answered.
        let mut check: &[u8] = &extracted;
        sfnt::load_face(&mut check, 0, Want { name: false, cmap: false }).ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        write_atomic(&out, &extracted).ok()?;
        Some(out)
    }

    fn import(&self, paths: Vec<String>, replace: bool, cap: u64) -> Vec<FontImportResult> {
        let Ok(dir) = self.library_dir() else {
            return paths.into_iter().map(|p| FontImportResult::failed(p, FontImportError::Io)).collect();
        };
        paths
            .into_iter()
            .map(|p| match self.import_one(&dir, Path::new(&p), replace, cap) {
                Ok((id, family, style)) => {
                    FontImportResult { path: p, ok: true, id: Some(id), family: Some(family), style: Some(style), error: None }
                }
                Err(e) => FontImportResult::failed(p, e),
            })
            .collect()
    }

    fn import_one(
        &self,
        dir: &Path,
        src: &Path,
        replace: bool,
        cap: u64,
    ) -> std::result::Result<(String, String, String), FontImportError> {
        let ext = src.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        if !matches!(ext.as_deref(), Some("ttf" | "otf")) {
            return Err(FontImportError::Extension);
        }
        let meta = std::fs::metadata(src).map_err(|_| FontImportError::Io)?;
        if !meta.is_file() {
            return Err(FontImportError::Io);
        }
        if meta.len() > cap {
            return Err(FontImportError::TooLarge);
        }
        let bytes = std::fs::read(src).map_err(|_| FontImportError::Io)?;
        if bytes.len() as u64 > cap {
            return Err(FontImportError::TooLarge);
        }
        let checked = check_font(&bytes)?;
        let target = dir.join(format!("{:016x}.{}", xxh3_64(&bytes), checked.ext));
        let id = format!("{LIB_PREFIX}{}", checked.family);
        // The face's own style (`shown_style`) is what the library compares
        // and what the result reports: the same name a rescan lists it under.
        let face = Face::from_tables(checked.family.clone(), checked.style, target.clone(), 0, &checked.tables)
            .ok_or(FontImportError::NotAFont)?;
        let style = face.style.clone();
        let outcome = self.with_library(|lib| {
            let same: Vec<PathBuf> = lib
                .faces
                .iter()
                .filter(|f| f.family == checked.family && f.style == style)
                .map(|f| f.path.clone())
                .collect();
            if !same.is_empty() && !replace {
                return Err(FontImportError::Exists);
            }
            if !same.contains(&target) {
                std::fs::create_dir_all(dir).map_err(|_| FontImportError::Io)?;
                write_atomic(&target, &bytes).map_err(|_| FontImportError::Io)?;
            }
            // The new file is in; now the face it replaces goes.
            for old in same.iter().filter(|p| **p != target) {
                if let Err(e) = std::fs::remove_file(old) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        return Err(FontImportError::Io);
                    }
                }
            }
            lib.faces.retain(|f| !(f.family == checked.family && f.style == style));
            lib.faces.push(face);
            sort_faces(&mut lib.faces);
            Ok(())
        });
        match outcome {
            Ok(Ok(())) => Ok((id, checked.family, style)),
            Ok(Err(e)) => {
                // A half-done write: rescan on the next need.
                if e == FontImportError::Io {
                    self.forget_library();
                }
                Err(e)
            }
            Err(_) => Err(FontImportError::Io),
        }
    }

    fn remove(&self, id: &str) -> Result<()> {
        let family = id
            .strip_prefix(LIB_PREFIX)
            .filter(|_| is_font_id(id))
            .ok_or_else(|| AppError::BadInput("only a library font can be removed".into()))?;
        let failed = self.with_library(|lib| {
            let mut failed = None;
            lib.faces.retain(|f| {
                if f.family != family {
                    return true;
                }
                match std::fs::remove_file(&f.path) {
                    Ok(()) => false,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                    Err(e) => {
                        failed.get_or_insert(e);
                        true
                    }
                }
            });
            failed
        })?;
        match failed {
            Some(e) => {
                self.forget_library();
                Err(AppError::Io(e))
            }
            None => Ok(()),
        }
    }

    /// Per item, the code points of its text the face cannot draw: unique,
    /// first-seen order, at most `MAX_MISSING`. Empty when that cannot be
    /// judged: the font is not on this PC (the caller draws the legacy font
    /// and checks that instead), its file does not read, or it has no Unicode
    /// `cmap` (a symbol font such as Wingdings, where every character would
    /// otherwise count as missing).
    fn missing_glyphs(&self, items: &[GlyphCheck]) -> Vec<Vec<u32>> {
        // One `cmap` read per face, however many pieces of text use it.
        let mut cmaps: HashMap<(PathBuf, u32), Option<Vec<u8>>> = HashMap::new();
        items
            .iter()
            .map(|item| {
                let Some(face) = self.find_face(&item.id, item.bold, item.italic) else { return Vec::new() };
                let cmap = cmaps.entry((face.path, face.index)).or_insert_with_key(|(path, index)| {
                    let mut src = FileSource::open(path).ok()?;
                    sfnt::load_face(&mut src, *index, Want { name: false, cmap: true }).ok()?.cmap
                });
                let Some(sub) = cmap.as_deref().and_then(sfnt::unicode_subtable) else { return Vec::new() };
                missing_in(&item.text, |cp| sfnt::has_glyph(sub, cp))
            })
            .collect()
    }
}

const MAX_MISSING: usize = 32;

/// Characters no font is expected to draw: controls (line breaks among
/// them), the line and paragraph separators, ZWNJ/ZWJ, the BOM and the
/// variation selectors.
fn ignorable(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{2028}' | '\u{2029}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' | '\u{FE00}'..='\u{FE0F}' | '\u{E0100}'..='\u{E01EF}')
}

fn missing_in(text: &str, has: impl Fn(u32) -> bool) -> Vec<u32> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for c in text.chars().filter(|&c| !ignorable(c)) {
        let cp = u32::from(c);
        if seen.insert(cp) && !has(cp) {
            out.push(cp);
            if out.len() == MAX_MISSING {
                break;
            }
        }
    }
    out
}

/// Every library file that parses, as faces.
fn scan_library(dir: &Path) -> Vec<Face> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut faces = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(is_library_name) {
            continue;
        }
        let path = entry.path();
        let Ok(mut src) = FileSource::open(&path) else { continue };
        if src.len() > MAX_IMPORT {
            continue;
        }
        let Ok(t) = sfnt::load_face(&mut src, 0, Want { name: true, cmap: false }) else { continue };
        let Some(n) = t.name.as_deref() else { continue };
        let Some(family) = sfnt::name_string(n, 1).filter(|f| is_font_id(&format!("{LIB_PREFIX}{f}"))) else { continue };
        let style = sfnt::name_string(n, 2).unwrap_or_else(|| "Regular".to_owned());
        if let Some(face) = Face::from_tables(family, style, path, 0, &t) {
            faces.push(face);
        }
    }
    sort_faces(&mut faces);
    faces
}

/// Write via a temporary sibling and a rename, so a reader never sees half a
/// font. A rename that loses to a concurrent writer of the same content is
/// fine as long as the target is there.
fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = target.with_file_name(format!(
        ".{}.{}-{n}.tmp",
        target.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            if std::fs::metadata(target).is_ok_and(|m| m.len() == bytes.len() as u64) {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Resolution (for the video and PDF exporters)                        */
/* ------------------------------------------------------------------ */

/// A face Rust located itself: always a standalone sfnt file.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFace {
    pub path: PathBuf,
    pub line_height_em: f64,
    pub bold: bool,
    pub italic: bool,
    pub embed: Embed,
}

/// None = not on this PC. Blocking: call it off the UI thread (the video
/// export does, before it builds).
pub fn resolve_face(id: &str, bold: bool, italic: bool) -> Option<ResolvedFace> {
    APP.resolve(id, bold, italic)
}

fn resolved_font(requested: String, face: Option<ResolvedFace>) -> ResolvedFont {
    match face.and_then(|f| Some((f.path.to_str()?.to_owned(), f))) {
        Some((path, f)) => ResolvedFont {
            requested,
            found: true,
            bold: f.bold,
            italic: f.italic,
            path,
            line_height_em: f.line_height_em,
            embed: f.embed,
        },
        None => ResolvedFont::not_found(requested),
    }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/// Run a command's body on the blocking pool.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// Library + installed families. Enumerates on the first call only (never at
/// startup), then answers from memory unless `refresh`.
#[tauri::command]
pub async fn fonts_list(refresh: bool) -> Result<FontCatalog> {
    blocking(move || APP.list(refresh)).await
}

/// The face file to use per request, in request order.
#[tauri::command]
pub async fn fonts_resolve(requests: Vec<FontRequest>) -> Result<Vec<ResolvedFont>> {
    blocking(move || resolve_all(&APP, requests)).await
}

fn resolve_all(svc: &Service, requests: Vec<FontRequest>) -> Vec<ResolvedFont> {
    requests.into_iter().map(|r| {
        let face = svc.resolve(&r.id, r.bold, r.italic);
        resolved_font(r.id, face)
    }).collect()
}

/// Copy `.ttf` / `.otf` files into the library; one result per path, in order.
#[tauri::command]
pub async fn fonts_import(paths: Vec<String>, replace: bool) -> Result<Vec<FontImportResult>> {
    blocking(move || APP.import(paths, replace, MAX_IMPORT)).await
}

/// Remove a library family.
#[tauri::command]
pub async fn fonts_remove(id: String) -> Result<()> {
    blocking(move || APP.remove(&id)).await?
}

/// Per item, the code points of `text` the resolved face has no glyph for.
#[tauri::command]
pub async fn fonts_missing_glyphs(items: Vec<GlyphCheck>) -> Result<Vec<Vec<u32>>> {
    blocking(move || APP.missing_glyphs(&items)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn keys(v: &Value) -> Vec<&str> {
        let mut k: Vec<&str> = v.as_object().expect("an object").keys().map(String::as_str).collect();
        k.sort_unstable();
        k
    }

    /// The enums travel as the exact strings of `FontEmbed`,
    /// `FontFamilyInfo.source` and `FontImportError` in src/core/types.ts.
    #[test]
    fn enums_serialize_to_the_seam_strings() {
        let embed = [(Embed::Full, "full"), (Embed::NoSubset, "noSubset"), (Embed::None, "none")];
        for (e, s) in embed {
            assert_eq!(serde_json::to_value(e).unwrap(), json!(s));
        }
        let source = [(FontSource::Library, "library"), (FontSource::Installed, "installed")];
        for (e, s) in source {
            assert_eq!(serde_json::to_value(e).unwrap(), json!(s));
        }
        let errors = [
            (FontImportError::Extension, "extension"),
            (FontImportError::TooLarge, "tooLarge"),
            (FontImportError::NotAFont, "notAFont"),
            (FontImportError::NoUnicode, "noUnicode"),
            (FontImportError::Unsupported, "unsupported"),
            (FontImportError::Exists, "exists"),
            (FontImportError::Io, "io"),
        ];
        for (e, s) in errors {
            assert_eq!(serde_json::to_value(e).unwrap(), json!(s));
        }
    }

    /// Every result type, with the exact camelCase keys the TS types read.
    #[test]
    fn results_serialize_with_the_seam_keys() {
        let face = FontFaceInfo { bold: true, italic: false, weight: 700, style: "Bold".into(), embed: Embed::NoSubset };
        let fv = serde_json::to_value(&face).unwrap();
        assert_eq!(keys(&fv), ["bold", "embed", "italic", "style", "weight"]);
        assert_eq!(fv["embed"], "noSubset");

        let fam = FontFamilyInfo { id: "lib:Inter".into(), name: "Inter".into(), source: FontSource::Library, faces: vec![face] };
        let cat = FontCatalog { library: vec![fam], installed: vec![] };
        let cv = serde_json::to_value(&cat).unwrap();
        assert_eq!(keys(&cv), ["installed", "library"]);
        assert_eq!(keys(&cv["library"][0]), ["faces", "id", "name", "source"]);
        assert_eq!(cv["library"][0]["source"], "library");

        let found = ResolvedFont {
            requested: "Consolas".into(),
            found: true,
            bold: false,
            italic: true,
            path: "C:\\Windows\\Fonts\\consolai.ttf".into(),
            line_height_em: 1.17,
            embed: Embed::Full,
        };
        let rv = serde_json::to_value(&found).unwrap();
        assert_eq!(keys(&rv), ["bold", "embed", "found", "italic", "lineHeightEm", "path", "requested"]);
        assert_eq!(rv["lineHeightEm"], 1.17);

        let ok = FontImportResult {
            path: "a.ttf".into(),
            ok: true,
            id: Some("lib:Inter".into()),
            family: Some("Inter".into()),
            style: Some("Regular".into()),
            error: None,
        };
        assert_eq!(keys(&serde_json::to_value(&ok).unwrap()), ["family", "id", "ok", "path", "style"]);
        // Absent optionals are omitted, never `null`: TS reads them as `?:`.
        let bad = serde_json::to_value(FontImportResult::failed("b.otf".into(), FontImportError::TooLarge)).unwrap();
        assert_eq!(bad, json!({ "path": "b.otf", "ok": false, "error": "tooLarge" }));
    }

    /// The argument shapes the TS wrappers send.
    #[test]
    fn arguments_deserialize_from_the_seam_shapes() {
        let r: FontRequest = serde_json::from_value(json!({ "id": "lib:Inter", "bold": true, "italic": false })).unwrap();
        assert_eq!(r, FontRequest { id: "lib:Inter".into(), bold: true, italic: false });
        let g: GlyphCheck =
            serde_json::from_value(json!({ "id": "Consolas", "bold": false, "italic": true, "text": "Ab" })).unwrap();
        assert_eq!(g, GlyphCheck { id: "Consolas".into(), bold: false, italic: true, text: "Ab".into() });
    }

    /* -------------------------------------------------------------- */
    /* The service, over private folders                              */
    /* -------------------------------------------------------------- */

    /// A private data root and cache root under %TEMP%, removed on drop. The
    /// service is handed these folders directly: no test mutates the
    /// process-wide environment, so none can race the store's `with_isolated`
    /// tests, and none can reach the owner's real folders.
    struct Isolated {
        root: PathBuf,
        svc: Service,
    }

    impl Isolated {
        fn new(tag: &str) -> Isolated {
            let root = std::env::temp_dir().join(format!(
                "taroting-fonts-test-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("src")).unwrap();
            let svc = Service::at(root.join("appdata"), root.join("cache"));
            Isolated { root, svc }
        }
        fn lib_dir(&self) -> PathBuf {
            self.root.join("appdata").join("fonts")
        }
        /// A source file for an import, written into the private folder.
        fn file(&self, name: &str, bytes: &[u8]) -> String {
            let p = self.root.join("src").join(name);
            std::fs::write(&p, bytes).unwrap();
            p.to_string_lossy().into_owned()
        }
        fn import(&self, path: &str, replace: bool) -> FontImportResult {
            self.svc.import(vec![path.to_owned()], replace, MAX_IMPORT).remove(0)
        }
    }

    impl Drop for Isolated {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// `%SystemRoot%\Fonts\<name>` (read only).
    fn system_font(name: &str) -> PathBuf {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        root.join("Fonts").join(name)
    }

    fn read_font(name: &str) -> Vec<u8> {
        std::fs::read(system_font(name)).unwrap()
    }

    fn round4(v: f64) -> f64 {
        (v * 10_000.0).round() / 10_000.0
    }

    /// Ids for fonts that are not here answer the safe "nothing here" shape,
    /// one per input, in order. (Replaces the seam stub's test: the bodies are
    /// real now, so it runs against private folders and unknown ids.)
    #[test]
    fn unknown_ids_answer_the_safe_shape() {
        let iso = Isolated::new("unknown");
        assert!(iso.svc.list(false).library.is_empty());
        let reqs = vec![
            FontRequest { id: "lib:A".into(), bold: true, italic: true },
            FontRequest { id: "No Such Font 094".into(), bold: false, italic: false },
        ];
        let res = resolve_all(&iso.svc, reqs);
        assert_eq!(res.iter().map(|r| r.requested.as_str()).collect::<Vec<_>>(), ["lib:A", "No Such Font 094"]);
        assert!(res.iter().all(|r| !r.found && !r.bold && !r.italic && r.path.is_empty() && r.embed == Embed::None));
        let gone = iso.root.join("src").join("x.ttf").to_string_lossy().into_owned();
        assert_eq!(iso.svc.import(vec![gone.clone()], true, MAX_IMPORT), vec![FontImportResult::failed(gone, FontImportError::Io)]);
        assert!(iso.svc.remove("lib:A").is_ok());
        let items = [
            GlyphCheck { id: "lib:A".into(), bold: false, italic: false, text: "x".into() },
            GlyphCheck { id: "No Such Font 094".into(), bold: false, italic: false, text: "y".into() },
        ];
        assert_eq!(iso.svc.missing_glyphs(&items), vec![Vec::<u32>::new(); 2]);
        assert_eq!(iso.svc.resolve("lib:A", false, false), None);
    }

    #[test]
    fn font_id_shape_matches_font_id_ts() {
        for ok in ["Consolas", "Segoe UI Light", "lib:Inter", "l", &"x".repeat(96), "日本語"] {
            assert!(is_font_id(ok), "{ok:?}");
        }
        for bad in ["", "lib:", " Arial", "Arial ", "\u{FEFF}Arial", "Ari\u{7}al", "a\u{7F}", &"x".repeat(97)] {
            assert!(!is_font_id(bad), "{bad:?}");
        }
        // 48 astral characters are 96 UTF-16 units; one more is too many.
        assert!(is_font_id(&"😀".repeat(48)));
        assert!(!is_font_id(&"😀".repeat(49)));
    }

    /// The parser reproduces the builder's six legacy constants from the real
    /// files (the old table is the oracle), for a bold and an italic face too.
    #[test]
    fn parser_reproduces_the_six_legacy_ratios() {
        let cases = [
            ("segoeui.ttf", 1.3301),
            ("segoeuib.ttf", 1.3301),
            ("arial.ttf", 1.1499),
            ("arialbi.ttf", 1.1499),
            ("times.ttf", 1.1499),
            ("georgia.ttf", 1.1362),
            ("cour.ttf", 1.1328),
            ("impact.ttf", 1.2197),
        ];
        for (file, want) in cases {
            let mut src = FileSource::open(&system_font(file)).unwrap();
            let t = sfnt::load_face(&mut src, 0, Want { name: false, cmap: false }).unwrap();
            let got = sfnt::line_height_em(&t.head, &t.hhea, t.os2.as_deref()).unwrap();
            assert_eq!(round4(got), want, "{file}");
        }
    }

    fn ribbi(faces: &[FontFaceInfo]) -> Vec<(bool, bool)> {
        let mut v: Vec<(bool, bool)> = faces.iter().map(|f| (f.bold, f.italic)).collect();
        v.sort_unstable();
        v
    }

    /// DirectWrite lists the six legacy families with their real faces
    /// (Impact: regular only), names them as the files do, and lists at least
    /// one family beyond the six.
    #[cfg(windows)]
    #[test]
    fn installed_enumeration_has_the_legacy_families() {
        let iso = Isolated::new("installed");
        let cat = iso.svc.list(false);
        let fam = |id: &str| cat.installed.iter().find(|f| f.id == id).unwrap_or_else(|| panic!("{id} listed"));
        let four = vec![(false, false), (false, true), (true, false), (true, true)];
        for id in ["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New"] {
            let f = fam(id);
            assert_eq!(ribbi(&f.faces), four, "{id}");
            assert_eq!((f.name.as_str(), f.source), (id, FontSource::Installed));
        }
        assert_eq!(ribbi(&fam("Impact").faces), vec![(false, false)]);
        // A variable font is its default instance only, under its own names
        // (DirectWrite also lists "Bahnschrift SemiBold" and the like at the
        // same file and index, which would all draw as the default).
        let bahn = fam("Bahnschrift");
        assert_eq!((ribbi(&bahn.faces), bahn.faces[0].weight), (vec![(false, false)], 400));
        assert!(!cat.installed.iter().any(|f| f.id == "Bahnschrift SemiBold"));
        // A non-legacy family, under the same name the file itself carries
        // (so `Consolas` and an imported `lib:Consolas` agree).
        let consolas = fam("Consolas");
        let mut src = FileSource::open(&system_font("consola.ttf")).unwrap();
        let t = sfnt::load_face(&mut src, 0, Want { name: true, cmap: false }).unwrap();
        assert_eq!(sfnt::name_string(t.name.as_deref().unwrap(), 1).as_deref(), Some(consolas.name.as_str()));
        assert_eq!(consolas.faces.len(), 4);
        // An installed face resolves to its own file with the hhea ratio.
        let r = iso.svc.resolve("Arial", true, true).unwrap();
        assert_eq!(r.path.file_name().unwrap().to_string_lossy().to_lowercase(), "arialbi.ttf");
        assert_eq!((r.bold, r.italic, round4(r.line_height_em), r.embed), (true, true, 1.1499, Embed::Full));
        // Impact asked for bold italic draws its one real face.
        let i = iso.svc.resolve("Impact", true, true).unwrap();
        assert_eq!((i.bold, i.italic), (false, false));
    }

    /// An id is looked up, never joined into a path.
    #[test]
    fn path_like_ids_resolve_to_nothing() {
        let iso = Isolated::new("pathids");
        // Something IS in the library, so `lib:` lookups are not trivially empty.
        let ok = iso.import(&system_font("consola.ttf").to_string_lossy(), false);
        assert!(ok.ok, "{ok:?}");
        let arial = system_font("arial.ttf").to_string_lossy().into_owned();
        let lib_file = format!("lib:{}", iso.lib_dir().read_dir().unwrap().next().unwrap().unwrap().path().display());
        for id in [arial.as_str(), r"C:\Windows\Fonts\arial.ttf", r"..\x", r"lib:..\x", "lib:../Consolas", lib_file.as_str()] {
            assert_eq!(iso.svc.resolve(id, false, false), None, "{id}");
        }
        assert!(iso.svc.resolve("lib:Consolas", false, false).is_some());
    }

    /// Change the platform of every cmap encoding record to Macintosh Roman,
    /// so the file parses but carries no Unicode mapping.
    fn without_unicode_cmap(mut bytes: Vec<u8>) -> Vec<u8> {
        let mut src: &[u8] = &bytes;
        let dir = sfnt::directory_at(&mut src, 0).unwrap();
        let cmap = dir.find(b"cmap").unwrap().offset as usize;
        let n = sfnt::u16_at(&bytes, cmap + 2).unwrap() as usize;
        for i in 0..n {
            let r = cmap + 4 + i * 8;
            bytes[r..r + 4].copy_from_slice(&[0, 1, 0, 0]);
        }
        bytes
    }

    #[test]
    fn import_refuses_what_policy_does_not_allow() {
        let iso = Isolated::new("refuse");
        let arial = read_font("arial.ttf");
        let cases: Vec<(String, FontImportError)> = vec![
            (iso.file("arial.fnt", &arial), FontImportError::Extension),
            (iso.file("notes.ttf", b"this is not a font at all, only text"), FontImportError::NotAFont),
            (iso.file("half.ttf", &arial[..arial.len() / 2]), FontImportError::NotAFont),
            // Cut inside its last table only: every table the library reads is
            // whole, so only the directory's bounds check can refuse it.
            (iso.file("tail.ttf", &arial[..arial.len() - 64]), FontImportError::NotAFont),
            (iso.file("nouni.ttf", &without_unicode_cmap(arial.clone())), FontImportError::NoUnicode),
            (iso.file("cambria.ttf", &read_font("cambria.ttc")), FontImportError::Unsupported),
        ];
        for (path, want) in cases {
            assert_eq!(iso.import(&path, true), FontImportResult::failed(path.clone(), want), "{path}");
        }
        // One byte over the 64 MiB cap (a sparse file: no 64 MiB is written).
        let big = iso.root.join("src").join("big.otf");
        std::fs::File::create(&big).unwrap().set_len(MAX_IMPORT + 1).unwrap();
        let big = big.to_string_lossy().into_owned();
        assert_eq!(iso.import(&big, false), FontImportResult::failed(big.clone(), FontImportError::TooLarge));
        assert_eq!(MAX_IMPORT, 64 * 1024 * 1024);
        // Nothing was copied in.
        assert!(iso.svc.list(true).library.is_empty());
        assert!(!iso.lib_dir().exists() || iso.lib_dir().read_dir().unwrap().next().is_none());
    }

    #[test]
    fn import_lists_resolves_replaces_and_removes_a_real_font() {
        let iso = Isolated::new("accept");
        let src = system_font("consola.ttf").to_string_lossy().into_owned();
        let ok = iso.import(&src, false);
        assert_eq!(
            ok,
            FontImportResult {
                path: src.clone(),
                ok: true,
                id: Some("lib:Consolas".into()),
                family: Some("Consolas".into()),
                style: Some("Regular".into()),
                error: None
            }
        );
        let files = || -> Vec<PathBuf> {
            let mut v: Vec<PathBuf> = iso.lib_dir().read_dir().unwrap().map(|e| e.unwrap().path()).collect();
            v.sort();
            v
        };
        let bytes = read_font("consola.ttf");
        let named = iso.lib_dir().join(format!("{:016x}.ttf", xxh3_64(&bytes)));
        assert_eq!(files(), vec![named.clone()]);

        // The same family and style again: exists.
        assert_eq!(iso.import(&src, false), FontImportResult::failed(src.clone(), FontImportError::Exists));

        // Lists, from memory and from a fresh scan of the folder alike.
        let lib = iso.svc.list(false).library;
        assert_eq!(lib.len(), 1);
        assert_eq!((lib[0].id.as_str(), lib[0].name.as_str(), lib[0].source), ("lib:Consolas", "Consolas", FontSource::Library));
        assert_eq!(ribbi(&lib[0].faces), vec![(false, false)]);
        let fresh = Service::at(iso.root.join("appdata"), iso.root.join("cache"));
        assert_eq!(fresh.list(false).library, lib);

        // Resolves to the library file; bold is not faked.
        let r = iso.svc.resolve("lib:Consolas", true, false).unwrap();
        assert_eq!((r.path.clone(), r.bold, r.italic), (named.clone(), false, false));

        // A different file with the same family and style: exists, unless
        // replace, which swaps the file.
        let mut other = bytes.clone();
        other.extend_from_slice(&[0; 4]);
        let other_path = iso.file("consola-copy.ttf", &other);
        assert_eq!(iso.import(&other_path, false).error, Some(FontImportError::Exists));
        assert!(iso.import(&other_path, true).ok);
        let swapped = iso.lib_dir().join(format!("{:016x}.ttf", xxh3_64(&other)));
        assert_eq!(files(), vec![swapped.clone()]);
        assert_eq!(iso.svc.resolve("lib:Consolas", false, false).unwrap().path, swapped);

        // Only a library id can be removed; removal empties the folder.
        assert!(iso.svc.remove("Consolas").is_err());
        assert_eq!(files().len(), 1);
        iso.svc.remove("lib:Consolas").unwrap();
        assert!(files().is_empty());
        assert!(iso.svc.list(false).library.is_empty());
        assert_eq!(iso.svc.resolve("lib:Consolas", false, false), None);
    }

    /// The Win32 subfamily decides the RIBBI slot; fsSelection only when the
    /// subfamily is none of the four.
    #[test]
    fn subfamily_decides_bold_and_italic() {
        let mut head = vec![0u8; 54];
        head[12..16].copy_from_slice(&0x5F0F_3CF5u32.to_be_bytes());
        head[18..20].copy_from_slice(&2048u16.to_be_bytes());
        let mut hhea = vec![0u8; 36];
        hhea[4..6].copy_from_slice(&1800i16.to_be_bytes());
        hhea[6..8].copy_from_slice(&(-500i16).to_be_bytes());
        let mut os2 = vec![0u8; 96];
        os2[4..6].copy_from_slice(&600u16.to_be_bytes());
        os2[62..64].copy_from_slice(&0x0020u16.to_be_bytes()); // fsSelection: bold
        let t = sfnt::FaceTables { sfnt_version: sfnt::VERSION_TRUETYPE, head, hhea, os2: Some(os2), name: None, cmap: None };
        let at = |style: &str| {
            let f = Face::from_tables("F".into(), style.into(), PathBuf::from("f.ttf"), 0, &t).unwrap();
            (f.bold, f.italic, f.weight)
        };
        assert_eq!(at("Regular"), (false, false, 600));
        assert_eq!(at("Italic"), (false, true, 600));
        assert_eq!(at("Semibold"), (true, false, 600));
    }

    /// A style name the UI cannot use as it is (empty, a control character,
    /// over 64 characters) becomes the plain label of the face's own
    /// bold/italic; 64 characters of plain text stay as they are.
    #[test]
    fn an_unusable_style_name_becomes_the_plain_label() {
        let tables = |fs_selection: u16| {
            let mut head = vec![0u8; 54];
            head[12..16].copy_from_slice(&0x5F0F_3CF5u32.to_be_bytes());
            head[18..20].copy_from_slice(&1000u16.to_be_bytes());
            let mut hhea = vec![0u8; 36];
            hhea[4..6].copy_from_slice(&900i16.to_be_bytes());
            hhea[6..8].copy_from_slice(&(-300i16).to_be_bytes());
            let mut os2 = vec![0u8; 96];
            os2[4..6].copy_from_slice(&500u16.to_be_bytes());
            os2[62..64].copy_from_slice(&fs_selection.to_be_bytes());
            sfnt::FaceTables { sfnt_version: sfnt::VERSION_TRUETYPE, head, hhea, os2: Some(os2), name: None, cmap: None }
        };
        let bold_italic = tables(0x0021);
        let plain = tables(0x0040);
        let shown = |t: &sfnt::FaceTables, style: &str| {
            Face::from_tables("F".into(), style.into(), PathBuf::from("f.ttf"), 0, t).unwrap().info().style
        };
        let huge = "x".repeat(32_000);
        assert_eq!(shown(&bold_italic, &huge), "Bold Italic");
        assert_eq!(shown(&plain, &huge), "Regular");
        assert_eq!(shown(&bold_italic, ""), "Bold Italic");
        assert_eq!(shown(&bold_italic, "Semi\u{7}bold"), "Bold Italic");
        assert_eq!(shown(&plain, "Book\nCondensed"), "Regular");
        let at_cap = "\u{00E9}".repeat(64);
        assert_eq!(shown(&plain, &at_cap), at_cap, "64 characters (128 bytes) is not over the cap");
        assert_eq!(shown(&plain, &"\u{00E9}".repeat(65)), "Regular");
        assert_eq!(shown(&plain, "Condensed Light"), "Condensed Light");
    }

    /// `bytes` with its `name` table replaced by one carrying `family` (ID 1)
    /// and `style` (ID 2), Windows Unicode English, appended at the end.
    fn with_names(mut bytes: Vec<u8>, family: &str, style: &str) -> Vec<u8> {
        let utf16 = |s: &str| s.encode_utf16().flat_map(u16::to_be_bytes).collect::<Vec<u8>>();
        let (f, st) = (utf16(family), utf16(style));
        let mut name = Vec::new();
        for v in [0u16, 2, 30] {
            name.extend_from_slice(&v.to_be_bytes());
        }
        for (id, len, off) in [(1u16, f.len(), 0usize), (2, st.len(), f.len())] {
            for v in [3u16, 1, 0x0409, id, len as u16, off as u16] {
                name.extend_from_slice(&v.to_be_bytes());
            }
        }
        name.extend_from_slice(&f);
        name.extend_from_slice(&st);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        let at = bytes.len() as u32;
        let tables = sfnt::u16_at(&bytes, 4).unwrap() as usize;
        let rec = (0..tables).map(|i| 12 + i * 16).find(|&r| &bytes[r..r + 4] == b"name").unwrap();
        bytes[rec + 8..rec + 12].copy_from_slice(&at.to_be_bytes());
        bytes[rec + 12..rec + 16].copy_from_slice(&(name.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&name);
        bytes
    }

    /// An imported file whose subfamily is 30,000 characters reports, lists
    /// and rescans under the plain label of its face, and a second import of
    /// it is still recognised as the same face.
    #[test]
    fn a_hostile_style_name_never_reaches_the_ui() {
        let iso = Isolated::new("hostile-style");
        let bytes = with_names(read_font("consolab.ttf"), "Hostile Mono", &"\u{202E}y".repeat(15_000));
        let mut check: &[u8] = &bytes;
        let t = sfnt::load_face(&mut check, 0, Want { name: true, cmap: false }).unwrap();
        assert_eq!(sfnt::name_string(t.name.as_deref().unwrap(), 2).map(|s| s.chars().count()), Some(30_000), "fixture");
        let path = iso.file("hostile.ttf", &bytes);
        let r = iso.import(&path, false);
        assert_eq!((r.ok, r.family.as_deref(), r.style.as_deref()), (true, Some("Hostile Mono"), Some("Bold")), "{r:?}");
        let styles = |refresh: bool| -> Vec<String> {
            iso.svc.list(refresh).library.iter().flat_map(|f| f.faces.iter().map(|x| x.style.clone())).collect()
        };
        assert_eq!(styles(false), ["Bold"]);
        assert_eq!(styles(true), ["Bold"], "a rescan names it the same");
        assert_eq!(iso.import(&path, false).error, Some(FontImportError::Exists));
    }

    /// An extracted collection face lives in the cache's `fonts` kind folder:
    /// counted in its size, removed by Clear cache, and extracted again by the
    /// next resolve (which checks the file, never a remembered path).
    #[test]
    fn an_extracted_face_is_cache_and_comes_back_after_a_clear() {
        let iso = Isolated::new("ttc-cache");
        let ttc = system_font("cambria.ttc");
        let mut src = FileSource::open(&ttc).unwrap();
        let t = sfnt::load_face(&mut src, 1, Want { name: true, cmap: false }).unwrap();
        let family = sfnt::name_string(t.name.as_deref().unwrap(), 1).unwrap();
        let f = Face::from_tables(family, "Regular".into(), ttc, 1, &t).unwrap();
        let out = iso.svc.standalone(&f).unwrap();
        let size = std::fs::metadata(&out).unwrap().len();

        let cache = crate::cache::Cache::new_at(iso.root.join("cache"));
        let stats = cache.stats();
        assert_eq!((stats.total_bytes, stats.by_kind.get("fonts").copied()), (size, Some(size)));
        assert_eq!(cache.clear(&std::collections::HashSet::new()), size);
        assert!(!out.exists(), "Clear cache removes the extraction");
        assert_eq!(iso.svc.standalone(&f).unwrap(), out);
        assert_eq!(std::fs::metadata(&out).unwrap().len(), size, "extracted again, whole");
    }

    fn face(name: &str, bold: bool, italic: bool, weight: u16) -> Face {
        Face {
            family: "F".into(),
            style: name.into(),
            bold,
            italic,
            weight,
            embed: Embed::Full,
            line_height_em: 1.2,
            path: PathBuf::from(name),
            index: 0,
        }
    }

    fn pick(faces: &[Face], bold: bool, italic: bool) -> &str {
        let refs: Vec<&Face> = faces.iter().collect();
        choose(&refs, bold, italic).map(|f| f.style.as_str()).unwrap_or("none")
    }

    /// Each fallback step of the seam's face choice, on a family built so that
    /// only that step can answer.
    #[test]
    fn face_choice_follows_the_seam_order() {
        // 1. exact (bold, italic), even when another italic sits nearer 700.
        let exact = [face("Heavy Italic", false, true, 750), face("BI", true, true, 600)];
        assert_eq!(pick(&exact, true, true), "BI");
        // 2. same italic at another weight: no bold face; Medium is nearest 700.
        let no_bold = [face("R", false, false, 400), face("Medium", false, false, 500), face("I", false, true, 400)];
        assert_eq!(pick(&no_bold, true, false), "Medium");
        // 3. regular: no italic face at all, so bold italic gets the regular,
        //    not the bold.
        let upright = [face("B", true, false, 700), face("R", false, false, 400)];
        assert_eq!(pick(&upright, true, true), "R");
        // 4. the family's first face: only italics, asked for upright regular.
        let italics = [face("BI", true, true, 700), face("I", false, true, 400)];
        assert_eq!(pick(&italics, false, false), "BI");
        assert_eq!(pick(&[], false, false), "none");
    }

    /// A face of a real system collection is extracted into the cache as a
    /// standalone, checksummed sfnt carrying the same family, and reused.
    #[test]
    fn ttc_face_extracts_to_a_standalone_file() {
        let iso = Isolated::new("ttc");
        let ttc = system_font("cambria.ttc");
        let mut src = FileSource::open(&ttc).unwrap();
        let t = sfnt::load_face(&mut src, 1, Want { name: true, cmap: false }).unwrap();
        let family = sfnt::name_string(t.name.as_deref().unwrap(), 1).unwrap();
        let f = Face::from_tables(family.clone(), "Regular".into(), ttc.clone(), 1, &t).unwrap();

        let out = iso.svc.standalone(&f).unwrap();
        assert!(out.starts_with(iso.root.join("cache").join("fonts")), "{}", out.display());
        assert!(out.file_name().unwrap().to_string_lossy().ends_with("-1.ttf"));
        let bytes = std::fs::read(&out).unwrap();
        assert_ne!(sfnt::u32_at(&bytes, 0), Some(sfnt::TAG_TTCF));
        assert_eq!(sfnt::checksum(&bytes), 0xB1B0_AFBA);
        let mut one: &[u8] = &bytes;
        let e = sfnt::load_face(&mut one, 0, Want { name: true, cmap: true }).unwrap();
        assert_eq!(sfnt::name_string(e.name.as_deref().unwrap(), 1), Some(family));
        assert!(e.cmap.as_deref().and_then(sfnt::unicode_subtable).is_some());
        // Face 0 of the same collection is a different family.
        let mut s0 = FileSource::open(&ttc).unwrap();
        let t0 = sfnt::load_face(&mut s0, 0, Want { name: true, cmap: false }).unwrap();
        assert_ne!(sfnt::name_string(t0.name.as_deref().unwrap(), 1), sfnt::name_string(e.name.as_deref().unwrap(), 1));
        // Second time: the same file, not a second copy.
        assert_eq!(iso.svc.standalone(&f).unwrap(), out);
        assert_eq!(out.parent().unwrap().read_dir().unwrap().count(), 1);
    }

    /// A Latin font given CJK (and an emoji): those code points, deduplicated
    /// in first-seen order, with line breaks, controls and joiners ignored;
    /// at most 32.
    #[cfg(windows)]
    #[test]
    fn missing_glyphs_for_a_latin_font_given_cjk() {
        let iso = Isolated::new("glyphs");
        let check = |text: &str| {
            iso.svc.missing_glyphs(&[GlyphCheck { id: "Consolas".into(), bold: true, italic: false, text: text.into() }]).remove(0)
        };
        assert_eq!(check("Ab 日本\r\n日\t語\u{200D}😀\u{FE0F} z"), vec![0x65E5, 0x672C, 0x8A9E, 0x1F600]);
        assert_eq!(check("Hello, world"), Vec::<u32>::new());
        let many: String = (0x4E00u32..0x4E00 + 40).filter_map(char::from_u32).collect();
        let got = check(&many);
        assert_eq!(got, (0x4E00u32..0x4E00 + 32).collect::<Vec<_>>());
    }

    /// A symbol font (Wingdings: a (3,0) `cmap` only, no Unicode one) is not
    /// judged, rather than every character counting as missing; the answers
    /// stay one per item, in order, for the fonts beside it.
    #[cfg(windows)]
    #[test]
    fn symbol_font_is_not_judged_for_missing_glyphs() {
        let mut src = FileSource::open(&system_font("wingding.ttf")).unwrap();
        let t = sfnt::load_face(&mut src, 0, Want { name: false, cmap: true }).unwrap();
        assert!(t.cmap.as_deref().and_then(sfnt::unicode_subtable).is_none(), "Wingdings has no Unicode cmap");

        let iso = Isolated::new("symbol");
        let item = |id: &str, text: &str| GlyphCheck { id: id.into(), bold: false, italic: false, text: text.into() };
        let got = iso.svc.missing_glyphs(&[item("Consolas", "a日"), item("Wingdings", "Hello"), item("Consolas", "語b")]);
        assert_eq!(got, vec![vec![0x65E5], vec![], vec![0x8A9E]]);
    }
}
