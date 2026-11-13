//! The rules an IMAGE project must meet before it is written, and the two
//! guards every project read passes through.
//!
//! **Where each rule runs.** `read_capped` sits under every raw `.trt` read, so
//! a crafted multi-gigabyte file is refused before a byte is allocated for it.
//! `refuse_misplaced_drawings` runs on load AND on save: a drawing is an image
//! project's layer, and a video project holding one would hand the video
//! pipeline something it cannot render (the exporter's own pre-check refuses
//! it too — three independent guards, one per entry). `validate_image_project`
//! runs on save only. Load stays lenient on purpose: a damaged stroke must not
//! make a project unopenable (the image editor drops it with a notice), but the
//! app must never WRITE a stroke that the lenient loader would then skip.
//!
//! **Why the save check reads the RAW value.** The typed parse only counts a
//! drawing's entries (`schema::count_strokes`) — it never looks inside one —
//! so "it deserialized" proves nothing about the strokes. The raw JSON is what
//! `save_project` writes, so the raw JSON is what is checked, one stroke at a
//! time: every stroke must deserialize as `schema::Stroke` (which proves every
//! field present has the right type, and borrows rather than copies its
//! points) AND then meet the value rules below.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::schema::{Generator, ProjectFile, Stroke, CURRENT_SCHEMA, IMAGE_SCHEMA, PDF_SCHEMA};
use crate::error::{AppError, Result};

/// Largest `.trt` any read accepts. A real project — even an image project
/// with a very heavy drawing — is a few megabytes; this only stops a crafted
/// or damaged file from being read whole into memory.
pub const MAX_TRT_BYTES: u64 = 512 * 1024 * 1024;

/// Largest image canvas side a saved project may carry (TS
/// `IMAGE_CANVAS_MAX_SIDE`).
pub const IMAGE_CANVAS_MAX_SIDE: u32 = 65_535;

/// Crafted-file caps on a drawing. The SAME three numbers are
/// `MAX_STROKE_POINTS`, `MAX_TOTAL_POINTS` and `MAX_TOTAL_STROKES` in
/// src/image/strokes.ts — change them together or not at all: a cap only
/// this side enforces refuses a save the editor happily built, and one only
/// the editor enforces lets the app write a file it will trim on the next
/// open.
pub const MAX_POINTS_PER_STROKE: u64 = 1_000_000;
pub const MAX_POINTS_TOTAL: u64 = 20_000_000;
pub const MAX_STROKES_TOTAL: u64 = 2_000_000;

/// The three caps as one value, so the tests can prove each one with a
/// drawing of a few strokes instead of hundreds of megabytes of JSON.
#[derive(Clone, Copy)]
struct Caps {
    points_per_stroke: u64,
    points_total: u64,
    strokes_total: u64,
}

const CAPS: Caps = Caps {
    points_per_stroke: MAX_POINTS_PER_STROKE,
    points_total: MAX_POINTS_TOTAL,
    strokes_total: MAX_STROKES_TOTAL,
};

/// Largest stroke width, in source px (TS `validateStroke`: `(0, 65535]`).
const MAX_STROKE_WIDTH: f64 = 65_535.0;

/// Largest shape endpoint coordinate, either sign, in source px — the SAME
/// number as `MAX_COORD` in src/image/strokes.ts, whose loader drops a shape
/// beyond it. Change them together: a bound only the loader enforces lets the
/// app write a shape that vanishes on the next open.
const MAX_SHAPE_COORD: f64 = 1e7;

/// Base64 characters per point: one point is three little-endian Float32s,
/// 12 bytes, which is exactly 16 characters with no padding.
const POINT_CHARS: usize = 16;

/// Read a whole project file, refusing one larger than `MAX_TRT_BYTES`.
///
/// The size is taken from the OPENED handle, before anything is allocated, and
/// the read itself is bounded too, so a file that grows between the stat and
/// the read still cannot push past the cap. Oversize is `InvalidData`; every
/// other error keeps its own kind (the `.bak` recovery keys on `NotFound`).
pub fn read_capped(path: &Path) -> std::io::Result<Vec<u8>> {
    read_capped_with(path, MAX_TRT_BYTES)
}

fn read_capped_with(path: &Path, cap: u64) -> std::io::Result<Vec<u8>> {
    const MB: u64 = 1024 * 1024;
    let too_big = || {
        let limit = if cap >= MB && cap % MB == 0 {
            format!("{} MB", cap / MB)
        } else {
            format!("{cap} bytes")
        };
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("project file is larger than {limit}"),
        )
    };
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len > cap {
        return Err(too_big());
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "project file grew past the size limit while it was being read",
        ));
    }
    Ok(bytes)
}

/// Refuse a drawing layer anywhere but an image project — a video project
/// and a PDF project alike (a PDF project's `media` holds only the pictures
/// its image marks use).
pub fn refuse_misplaced_drawings(p: &ProjectFile) -> Result<()> {
    if p.kind.as_deref() == Some("image") {
        return Ok(());
    }
    if p.media.iter().any(|m| matches!(m.generator, Some(Generator::Drawing { .. }))) {
        return Err(AppError::BadInput(
            "this project contains drawing layers, which only image projects can hold".into(),
        ));
    }
    Ok(())
}

/// The schema a project claims must be one the loader will accept for its
/// kind. `save_project` writes without migrating, so without this a video
/// project stamped 3 (or an image project stamped 2) would save fine and then
/// refuse to open — exactly the "never persist something we can't read back"
/// rule the save path exists to keep.
///
/// Per kind, exactly `migrate()`'s pairs: an image project is
/// `IMAGE_SCHEMA`, a PDF project `PDF_SCHEMA`, and a video project (no kind)
/// at most `CURRENT_SCHEMA`.
pub fn check_schema_kind(p: &ProjectFile) -> Result<()> {
    match p.kind.as_deref() {
        Some("image") if p.schema != IMAGE_SCHEMA => Err(AppError::BadInput(format!(
            "an image project must be schema {IMAGE_SCHEMA}, not {}",
            p.schema
        ))),
        Some("pdf") if p.schema != PDF_SCHEMA => Err(AppError::BadInput(format!(
            "a PDF project must be schema {PDF_SCHEMA}, not {}",
            p.schema
        ))),
        // Worded as `migrate()` words the same refusal on load.
        None if p.schema > CURRENT_SCHEMA => Err(AppError::BadInput(match p.schema {
            IMAGE_SCHEMA => format!("schema {IMAGE_SCHEMA} is only valid for an image project"),
            PDF_SCHEMA => format!("schema {PDF_SCHEMA} is only valid for a PDF project"),
            n => format!("schema {n} is not one this build writes"),
        })),
        _ => Ok(()),
    }
}

/// What a PDF project must be before it is written: its `pdf` object present
/// (as an object — its contents are the PDF editor's to sanitize), and a
/// timeline with no clips (TS: "the empty one every project carries"), so no
/// clip of one can ever reach the video pipeline. Cheap: no walk of `pdf`.
fn validate_pdf_project(typed: &ProjectFile) -> Result<()> {
    check_schema_kind(typed)?;
    if !typed.pdf.as_ref().is_some_and(Value::is_object) {
        return Err(AppError::BadInput("a PDF project must carry its pdf object".into()));
    }
    if typed.timeline.tracks.iter().any(|t| !t.clips.is_empty()) {
        return Err(AppError::BadInput("a PDF project has no timeline clips".into()));
    }
    Ok(())
}

/// Everything an image project must be before it is written — or a PDF
/// project (`validate_pdf_project`). A no-op for a video project. `raw` is the value `save_project` is about to write and
/// `typed` its (lenient) parse; the stroke rules read `raw`, see the module
/// comment.
pub fn validate_image_project(raw: &Value, typed: &ProjectFile) -> Result<()> {
    validate_with(raw, typed, CAPS)
}

fn validate_with(raw: &Value, typed: &ProjectFile, caps: Caps) -> Result<()> {
    match typed.kind.as_deref() {
        Some("image") => {}
        Some("pdf") => return validate_pdf_project(typed),
        _ => return Ok(()),
    }
    check_schema_kind(typed)?;
    let (w, h) = (typed.timeline.width, typed.timeline.height);
    if !(1..=IMAGE_CANVAS_MAX_SIDE).contains(&w) || !(1..=IMAGE_CANVAS_MAX_SIDE).contains(&h) {
        return Err(AppError::BadInput(format!(
            "the canvas is {w} × {h}; each side must be 1 to {IMAGE_CANVAS_MAX_SIDE} px"
        )));
    }
    for t in &typed.timeline.tracks {
        if t.kind != "video" {
            return Err(AppError::BadInput(format!(
                "an image project has no {} tracks (track '{}')",
                t.kind, t.name
            )));
        }
        if t.clips.len() > 1 {
            return Err(AppError::BadInput(format!(
                "layer '{}' holds {} items; a layer holds at most one",
                t.name,
                t.clips.len()
            )));
        }
    }

    for m in &typed.media {
        if let Some(Generator::Text { text, font_family, font_id, size_px, color, .. }) = &m.generator {
            check_text(text, font_family, font_id.as_deref(), *size_px, color)
                .map_err(|why| AppError::BadInput(format!("text layer '{}': {why}", layer_name(typed, &m.id))))?;
        }
    }

    let mut totals = Totals::default();
    let Some(media) = raw.get("media").and_then(Value::as_array) else {
        return Ok(()); // the typed parse already proved `media` is a list
    };
    for m in media {
        let Some(gen) = m.get("generator") else { continue };
        if gen.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(runs) = gen.get("runs") {
                let text = gen.get("text").and_then(Value::as_str).unwrap_or_default();
                check_text_runs(runs, text).map_err(|why| {
                    let id = m.get("id").and_then(Value::as_str).unwrap_or_default();
                    AppError::BadInput(format!("text layer '{}': {why}", layer_name(typed, id)))
                })?;
            }
            continue;
        }
        if gen.get("type").and_then(Value::as_str) != Some("drawing") {
            continue;
        }
        let id = m.get("id").and_then(Value::as_str).unwrap_or_default();
        let layer = layer_name(typed, id);
        validate_drawing(gen.get("chunks"), &layer, caps, &mut totals)?;
    }
    Ok(())
}

/// The name the user sees for the layer showing media `id`: its track's name,
/// else the media id (a drawing no track uses is still validated — it is
/// still written).
fn layer_name(typed: &ProjectFile, media_id: &str) -> String {
    typed
        .timeline
        .tracks
        .iter()
        .find(|t| t.clips.iter().any(|c| c.media_id == media_id))
        .map(|t| t.name.clone())
        .unwrap_or_else(|| media_id.to_string())
}

#[derive(Default)]
struct Totals {
    strokes: u64,
    points: u64,
}

fn validate_drawing(chunks: Option<&Value>, layer: &str, caps: Caps, totals: &mut Totals) -> Result<()> {
    let bad = |what: String| AppError::BadInput(format!("layer '{layer}': {what}"));
    let Some(Value::Array(chunks)) = chunks else {
        return Err(bad("the drawing's strokes are not a list".into()));
    };
    let mut n = 0u64;
    for (ci, chunk) in chunks.iter().enumerate() {
        let Value::Array(strokes) = chunk else {
            return Err(bad(format!("stroke group {} is not a list", ci + 1)));
        };
        for raw in strokes {
            n += 1;
            totals.strokes += 1;
            if totals.strokes > caps.strokes_total {
                return Err(AppError::BadInput(format!(
                    "the drawings hold more than {} strokes",
                    caps.strokes_total
                )));
            }
            let points = check_stroke(raw, caps.points_per_stroke).map_err(|why| {
                AppError::BadInput(format!("stroke {n} of layer '{layer}': {why}"))
            })?;
            totals.points += points;
            if totals.points > caps.points_total {
                return Err(AppError::BadInput(format!(
                    "the drawings hold more than {} points",
                    caps.points_total
                )));
            }
        }
    }
    Ok(())
}

/// One stroke against every rule; the point count on success, the reason
/// (naming the field) on failure.
fn check_stroke(raw: &Value, max_points: u64) -> std::result::Result<u64, String> {
    // Proves every field present has the typed shape — the exact test the
    // lenient loader applies, so nothing that passes here is skipped there.
    let s = Stroke::deserialize(raw).map_err(|e| format!("malformed ({e})"))?;
    enum Class {
        Ink,
        Erase,
        Shape,
    }
    let class = match s.t {
        "pen" | "pencil" | "marker" => Class::Ink,
        "erase" => Class::Erase,
        "line" | "rect" | "ellipse" | "arrow" => Class::Shape,
        other => {
            // Bounded: a crafted type string must not balloon the message.
            let shown: String = other.chars().take(24).collect();
            return Err(format!("unknown kind '{shown}'"));
        }
    };
    if !(s.w.is_finite() && s.w > 0.0 && s.w <= MAX_STROKE_WIDTH) {
        return Err(format!("width must be above 0 and at most {MAX_STROKE_WIDTH}"));
    }
    if let Some(o) = s.o {
        if !(o.is_finite() && (0.0..=1.0).contains(&o)) {
            return Err("opacity must be 0 to 1".into());
        }
    }
    if matches!(class, Class::Ink | Class::Shape) && !is_hex_colour(s.c) {
        return Err("color is not #rrggbb".into());
    }
    match class {
        Class::Ink | Class::Erase => {
            let p = s.p.ok_or("points are missing")?;
            if p.is_empty() || p.len() % POINT_CHARS != 0 {
                return Err("points are not whole [x, y, pressure] triples".into());
            }
            if !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
                return Err("points are not base64".into());
            }
            let points = (p.len() / POINT_CHARS) as u64;
            if points > max_points {
                return Err(format!("more than {max_points} points"));
            }
            Ok(points)
        }
        Class::Shape => {
            // `abs() <= MAX` is false for NaN, so this is the finite check too.
            let in_range =
                |v: Option<[f64; 2]>| v.is_some_and(|[x, y]| x.abs() <= MAX_SHAPE_COORD && y.abs() <= MAX_SHAPE_COORD);
            if !in_range(s.a) || !in_range(s.b) {
                return Err(format!("shape ends are missing or beyond ±{MAX_SHAPE_COORD} px"));
            }
            Ok(0)
        }
    }
}

/// A text layer's caps: the SAME numbers as `TEXT_MAX_CHARS`,
/// `TEXT_SIZE_MIN` and `TEXT_SIZE_MAX` in src/image/layers.ts, which cleans a
/// loaded project to them — change them together or not at all.
pub const MAX_TEXT_UNITS: usize = 20_000;
pub const TEXT_SIZE_MIN: f64 = 1.0;
pub const TEXT_SIZE_MAX: f64 = 2048.0;
/// The six fonts every Taroting has (src/core/font-id.ts `LEGACY_FONTS`).
const LEGACY_FONTS: [&str; 6] = ["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact"];

/// `isFontId` of src/core/font-id.ts (fonts/mod.rs keeps its own copy for the
/// resolver): 1..96 UTF-16 units, no control characters, no leading or
/// trailing whitespace, `lib:` followed by at least one character. Shape only.
fn is_font_id_shape(id: &str) -> bool {
    let units = id.encode_utf16().count();
    // JavaScript's `\s`, exactly: Unicode White_Space plus U+FEFF, minus
    // U+0085 (NEL), which `\s` leaves out. An id the loader keeps must save.
    let space = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}';
    (1..=96).contains(&units)
        && !id.chars().any(|c| c <= '\u{1F}' || c == '\u{7F}')
        && !id.starts_with(space)
        && !id.ends_with(space)
        && id != "lib:"
}

/// One text layer against the image editor's rules (image projects only: a
/// video project's text is the video editor's, and stays unchecked). The
/// length is counted in UTF-16 units, as the editor counts it.
fn check_text(text: &str, family: &str, font_id: Option<&str>, size: f64, color: &str) -> std::result::Result<(), String> {
    if text.encode_utf16().count() > MAX_TEXT_UNITS {
        return Err(format!("the text is longer than {MAX_TEXT_UNITS} characters"));
    }
    if !(size.is_finite() && (TEXT_SIZE_MIN..=TEXT_SIZE_MAX).contains(&size)) {
        return Err(format!("the size must be {TEXT_SIZE_MIN} to {TEXT_SIZE_MAX} px"));
    }
    if !is_hex_colour(Some(color)) {
        return Err("color is not #rrggbb".into());
    }
    if !LEGACY_FONTS.contains(&family) {
        return Err("the font is not one of the six built-in fonts".into());
    }
    if font_id.is_some_and(|id| !is_font_id_shape(id)) {
        return Err("the font id is not a font name".into());
    }
    Ok(())
}

/// The most style runs one text holds: `PDF_TEXT_MAX_RUNS` in
/// src/core/types.ts, which the loader (core/gen-runs-sanitize.ts) enforces.
pub const MAX_TEXT_RUNS: usize = 2_000;

/// A text layer's style runs (0.9.5), read from the raw value (the typed
/// generator does not carry them): a list of at most MAX_TEXT_RUNS records,
/// each `s < e` whole numbers inside the text's UTF-16 length, sorted and not
/// overlapping, and every field present well-formed: a built-in font, a
/// font-id shape, a size inside the text size range, a `#rrggbb` colour,
/// booleans for bold and italic. The editor only ever writes that.
fn check_text_runs(runs: &Value, text: &str) -> std::result::Result<(), String> {
    let Value::Array(list) = runs else {
        return Err("the styles are not a list".into());
    };
    if list.len() > MAX_TEXT_RUNS {
        return Err(format!("the text has more than {MAX_TEXT_RUNS} styled parts"));
    }
    let len = text.encode_utf16().count() as u64;
    let mut at = 0u64;
    for (i, r) in list.iter().enumerate() {
        let n = i + 1;
        let Value::Object(o) = r else {
            return Err(format!("style {n} is not a record"));
        };
        let (Some(s), Some(e)) = (o.get("s").and_then(Value::as_u64), o.get("e").and_then(Value::as_u64)) else {
            return Err(format!("style {n} has no whole-number range"));
        };
        if s >= e || e > len || s < at {
            return Err(format!("style {n} covers no part of the text in order"));
        }
        at = e;
        if let Some(f) = o.get("font") {
            if !f.as_str().is_some_and(|f| LEGACY_FONTS.contains(&f)) {
                return Err(format!("style {n}'s font is not one of the six built-in fonts"));
            }
        }
        if let Some(id) = o.get("fontId") {
            if !id.as_str().is_some_and(is_font_id_shape) {
                return Err(format!("style {n}'s font id is not a font name"));
            }
        }
        if let Some(sz) = o.get("size") {
            if !sz.as_f64().is_some_and(|v| v.is_finite() && (TEXT_SIZE_MIN..=TEXT_SIZE_MAX).contains(&v)) {
                return Err(format!("style {n}'s size must be {TEXT_SIZE_MIN} to {TEXT_SIZE_MAX} px"));
            }
        }
        if let Some(c) = o.get("c") {
            if !is_hex_colour(c.as_str()) {
                return Err(format!("style {n}'s color is not #rrggbb"));
            }
        }
        for k in ["bold", "italic"] {
            if o.get(k).is_some_and(|v| !v.is_boolean()) {
                return Err(format!("style {n}'s {k} is not on or off"));
            }
        }
    }
    Ok(())
}

/// `#` + exactly six ASCII hex digits, checked on BYTES before anything reads
/// a position — validate before you slice (the v0.7.2 `parse_color` lesson).
/// Either case: the editor writes lowercase, and the renderer re-normalizes.
fn is_hex_colour(c: Option<&str>) -> bool {
    let Some(c) = c else { return false };
    let b = c.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A per-test scratch dir (pid + thread id): these tests never touch the
    /// process environment, so they cannot race the recents tests in store.rs.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taroting-rules-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_capped_refuses_one_byte_over_and_reads_the_cap_exactly() {
        let dir = scratch("cap");
        let at = dir.join("at.trt");
        let over = dir.join("over.trt");
        std::fs::write(&at, b"0123456789abcdef").unwrap(); // 16
        std::fs::write(&over, b"0123456789abcdefg").unwrap(); // 17
        assert_eq!(read_capped_with(&at, 16).unwrap(), b"0123456789abcdef");
        let err = read_capped_with(&over, 16).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        // Refused by the size check on the handle, before any read: the
        // message is the stat path's, not the bounded read's.
        assert_eq!(err.to_string(), "project file is larger than 16 bytes");
        // A missing file keeps NotFound — the `.bak` recovery keys on it.
        let gone = read_capped_with(&dir.join("gone.trt"), 16).unwrap_err();
        assert_eq!(gone.kind(), std::io::ErrorKind::NotFound);
        // A whole-megabyte cap is phrased in MB, as the user sees it.
        let mb = dir.join("mb.trt");
        std::fs::write(&mb, vec![b' '; 1024 * 1024 + 1]).unwrap();
        let err = read_capped_with(&mb, 1024 * 1024).unwrap_err();
        assert_eq!(err.to_string(), "project file is larger than 1 MB");
        // The real cap reads a small file whole.
        assert_eq!(read_capped(&over).unwrap().len(), 17);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole valid image project every refusal below departs from on
    /// exactly one field. Canvas, stroke widths, colours and coordinates all
    /// differ from one another so no check can pass by reading the wrong one.
    fn image_project() -> Value {
        json!({
            "schema": 3, "kind": "image", "app": "taroting", "id": "p-9",
            "name": "Card", "createdAt": "a", "modifiedAt": "b",
            "image": { "background": "transparent" },
            "media": [
                { "id": "ph", "path": "C:\\In\\sea.jpg", "size": 4, "mtimeMs": 5, "kind": "image",
                  "duration": 0.0, "hasAudio": false, "width": 801, "height": 603 },
                { "id": "d1", "path": "Drawing", "size": 0, "mtimeMs": 0, "kind": "image",
                  "duration": 0.0, "hasAudio": false, "width": 640, "height": 480,
                  "generator": { "type": "drawing", "chunks": [
                    [
                      { "t": "pen", "c": "#1a2b3c", "w": 4.5, "o": 1.0, "p": "AB+/AB+/AB+/AB+/" },
                      { "t": "erase", "w": 16.0, "p": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
                      { "t": "marker", "c": "#FFD400", "w": 18.0, "o": 0.4, "p": "AAAAAAAAAAAAAAAA" }
                    ],
                    [
                      { "t": "arrow", "c": "#e5484d", "w": 3.0, "a": [10.0, 20.0], "b": [300.0, -5.0] }
                    ]
                  ]}
                }
            ],
            "timeline": {
                "fps": { "num": 30, "den": 1 }, "width": 1001, "height": 707,
                "tracks": [
                    { "id": "t1", "kind": "video", "name": "Drawing 1", "muted": false, "clips": [clip("c1", "d1")] },
                    { "id": "t2", "kind": "video", "name": "Photo", "muted": false, "clips": [clip("c2", "ph")] }
                ]
            },
            "export": {}
        })
    }

    fn clip(id: &str, media: &str) -> Value {
        json!({ "id": id, "mediaId": media, "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 1.0, "speed": 1.0,
                "audio": { "volume": 1.0, "muted": false, "fadeInSec": 0.0, "fadeOutSec": 0.0,
                           "gainOffsetDb": 0.0, "detached": false } })
    }

    fn check(v: &Value) -> Result<()> {
        let typed: ProjectFile = serde_json::from_value(v.clone()).expect("typed parse");
        refuse_misplaced_drawings(&typed)?;
        validate_image_project(v, &typed)
    }

    fn refusal(v: &Value) -> String {
        match check(v) {
            Err(AppError::BadInput(m)) => m,
            other => panic!("expected BadInput, got {other:?}"),
        }
    }

    #[test]
    fn a_well_formed_image_project_is_accepted() {
        check(&image_project()).expect("the fixture is valid");
    }

    /// The fixture plus a text layer named "Caption" whose every field is
    /// valid and differs from the drawing's: size 37.5 (fractional, in
    /// range), colour #0a1B2c (mixed case), a library font id.
    fn with_text() -> Value {
        let mut p = image_project();
        p["media"].as_array_mut().unwrap().push(json!({
            "id": "tx", "path": "Text — Hi", "size": 0, "mtimeMs": 0, "kind": "image",
            "duration": 0.0, "hasAudio": false, "width": 94, "height": 48,
            "generator": { "type": "text", "text": "Hi\nthere", "fontFamily": "Georgia", "fontId": "lib:Inter",
                           "sizePx": 37.5, "color": "#0a1B2c", "bold": true, "italic": false }
        }));
        p["timeline"]["tracks"].as_array_mut().unwrap().insert(
            0,
            json!({ "id": "t0", "kind": "video", "name": "Caption", "muted": false, "clips": [clip("c0", "tx")] }),
        );
        p
    }

    /// Each bad text differs from the valid one on ONE field, and each
    /// refusal names the layer and that field.
    #[test]
    fn every_bad_text_layer_is_refused_by_name() {
        check(&with_text()).expect("a valid text layer is accepted");
        let at_cap = "é".repeat(MAX_TEXT_UNITS);
        let mut ok = with_text();
        ok["media"][2]["generator"]["text"] = json!(at_cap);
        check(&ok).expect("exactly the cap is accepted");
        for edge in [TEXT_SIZE_MIN, TEXT_SIZE_MAX] {
            let mut ok = with_text();
            ok["media"][2]["generator"]["sizePx"] = json!(edge);
            check(&ok).expect("the size range is inclusive");
        }
        let mut ok = with_text();
        ok["media"][2]["generator"].as_object_mut().unwrap().remove("fontId");
        check(&ok).expect("no font id is fine");

        let with = |field: &str, v: Value| {
            let mut p = with_text();
            p["media"][2]["generator"][field] = v;
            refusal(&p)
        };
        // One unit over, counted in UTF-16: an astral character is two.
        let over = format!("{}😀", "a".repeat(MAX_TEXT_UNITS - 1));
        let cases: [(&str, Value, &str); 8] = [
            ("text", json!(over), "longer than 20000"),
            ("sizePx", json!(0.5), "size must be"),
            ("sizePx", json!(2048.5), "size must be"),
            ("color", json!("#12345"), "color is not"),
            ("color", json!("red"), "color is not"),
            ("fontFamily", json!("Comic Sans MS"), "six built-in fonts"),
            ("fontId", json!(" Inter"), "font id"),
            ("fontId", json!("lib:"), "font id"),
        ];
        for (field, v, want) in cases {
            let m = with(field, v.clone());
            assert!(m.starts_with("text layer 'Caption': "), "{field}={v}: {m}");
            assert!(m.contains(want), "{field}={v}: {m}");
        }
    }

    /// The save check's font-id rule is the loader's `isFontId`, character
    /// for character: an id the loader keeps (a NEL at either end is not JS
    /// whitespace) must save, or that project could never be saved again.
    /// The characters both sides call whitespace stay refused.
    #[test]
    fn font_id_edges_match_the_loader() {
        for id in ["Inter\u{85}", "\u{85}Inter"] {
            let mut p = with_text();
            p["media"][2]["generator"]["fontId"] = json!(id);
            check(&p).unwrap_or_else(|e| panic!("{id:?} is kept by the loader, so it saves: {e}"));
        }
        for id in ["Inter\u{A0}", "\u{FEFF}Inter", "Inter\u{3000}", "Inter\t"] {
            let mut p = with_text();
            p["media"][2]["generator"]["fontId"] = json!(id);
            assert!(refusal(&p).contains("font id"), "{id:?}");
        }
    }

    /// A video project's text is not the image editor's: the same bad text
    /// in a video project is saved as before.
    #[test]
    fn a_video_project_text_stays_unchecked() {
        let mut p = with_text();
        p["schema"] = json!(2);
        p.as_object_mut().unwrap().remove("kind");
        p["media"].as_array_mut().unwrap().remove(1);
        p["timeline"]["tracks"].as_array_mut().unwrap().remove(1);
        p["media"][1]["generator"]["sizePx"] = json!(4096.0);
        p["media"][1]["generator"]["fontFamily"] = json!("Comic Sans MS");
        check(&p).expect("video projects are not held to the image rules");
    }

    /// `with_text` with style runs on "Hi\nthere" (8 UTF-16 units): two
    /// valid runs whose every field differs from the base and from each other.
    fn with_runs() -> Value {
        let mut p = with_text();
        p["media"][2]["generator"]["runs"] = json!([
            { "s": 0, "e": 2, "size": 61.5, "c": "#AA5500" },
            { "s": 3, "e": 8, "font": "Arial", "fontId": "lib:Test Sans", "bold": false, "italic": true }
        ]);
        p
    }

    #[test]
    fn text_runs_are_checked_in_image_projects_by_layer_name() {
        check(&with_runs()).expect("valid runs are accepted");
        let mut at_cap = with_text();
        at_cap["media"][2]["generator"]["text"] = json!("x".repeat(MAX_TEXT_RUNS));
        at_cap["media"][2]["generator"]["runs"] =
            json!((0..MAX_TEXT_RUNS).map(|i| json!({ "s": i, "e": i + 1, "bold": true })).collect::<Vec<_>>());
        check(&at_cap).expect("exactly the cap is accepted");
        let mut over = at_cap.clone();
        over["media"][2]["generator"]["text"] = json!("x".repeat(MAX_TEXT_RUNS + 1));
        over["media"][2]["generator"]["runs"] =
            json!((0..=MAX_TEXT_RUNS).map(|i| json!({ "s": i, "e": i + 1, "bold": true })).collect::<Vec<_>>());
        let m = refusal(&over);
        assert!(m.starts_with("text layer 'Caption': ") && m.contains("more than 2000"), "{m}");

        let run = |i: usize, field: &str, v: Value| {
            let mut p = with_runs();
            p["media"][2]["generator"]["runs"][i][field] = v;
            refusal(&p)
        };
        let cases: [(usize, &str, Value, &str); 9] = [
            (0, "e", json!(0), "in order"),
            (1, "e", json!(9), "in order"),
            (1, "s", json!(1), "in order"),
            (0, "s", json!(0.5), "whole-number"),
            (0, "c", json!("red"), "color is not"),
            (1, "font", json!("Comic Sans MS"), "six built-in fonts"),
            (1, "fontId", json!("lib:"), "font id"),
            (0, "size", json!(2049.0), "size must be"),
            (1, "bold", json!("yes"), "on or off"),
        ];
        for (i, field, v, want) in cases {
            let m = run(i, field, v.clone());
            assert!(m.starts_with("text layer 'Caption': "), "{field}={v}: {m}");
            assert!(m.contains(want), "{field}={v}: {m}");
        }
        let mut p = with_runs();
        p["media"][2]["generator"]["runs"] = json!({ "s": 0 });
        assert!(refusal(&p).contains("not a list"));
    }

    /// The typed generator ignores `runs`; the raw value keeps them whole.
    #[test]
    fn runs_travel_in_the_raw_value_and_video_projects_stay_unchecked() {
        let p = with_runs();
        let typed: ProjectFile = serde_json::from_value(p.clone()).expect("a runs-carrying text parses");
        assert!(matches!(typed.media[2].generator, Some(Generator::Text { .. })));
        let mut v = with_runs();
        v["schema"] = json!(2);
        v.as_object_mut().unwrap().remove("kind");
        v["media"].as_array_mut().unwrap().remove(1);
        v["timeline"]["tracks"].as_array_mut().unwrap().remove(1);
        v["media"][1]["generator"]["runs"][0]["c"] = json!("red");
        check(&v).expect("video projects are not held to the image rules");
    }

    /// Each bad stroke differs from the valid fixture on one field, and each
    /// refusal names the stroke, the layer and the field — so a check that
    /// fired for the wrong field cannot pass for the right one.
    #[test]
    fn every_bad_stroke_is_refused_by_name() {
        let with = |ci: usize, si: usize, field: &str, v: Value| {
            let mut p = image_project();
            p["media"][1]["generator"]["chunks"][ci][si][field] = v;
            refusal(&p)
        };
        let cases: [(usize, usize, &str, Value, &str); 13] = [
            (0, 0, "p", json!("@@@@@@@@@@@@@@@@"), "stroke 1 of layer 'Drawing 1': points are not base64"),
            // The URL-safe alphabet is a different encoder's output (`btoa`
            // writes `+` and `/`, which the valid fixture's first stroke uses).
            (0, 0, "p", json!("AB-_AB-_AB-_AB-_"), "stroke 1 of layer 'Drawing 1': points are not base64"),
            (0, 0, "p", json!("AAAAAAAAAAAAAAA"), "stroke 1 of layer 'Drawing 1': points are not whole"),
            (0, 0, "p", json!(""), "stroke 1 of layer 'Drawing 1': points are not whole"),
            (0, 2, "t", json!("brush"), "stroke 3 of layer 'Drawing 1': unknown kind 'brush'"),
            (0, 0, "c", json!("#12345g"), "stroke 1 of layer 'Drawing 1': color is not #rrggbb"),
            (1, 0, "c", json!("#e5484"), "stroke 4 of layer 'Drawing 1': color is not #rrggbb"),
            (0, 1, "w", json!(0), "stroke 2 of layer 'Drawing 1': width"),
            (0, 2, "o", json!(1.5), "stroke 3 of layer 'Drawing 1': opacity"),
            (1, 0, "b", json!([300.0]), "stroke 4 of layer 'Drawing 1': malformed"),
            // Finite but beyond MAX_COORD: the TS loader would drop it.
            (1, 0, "a", json!([10_000_001.0, 0.0]), "stroke 4 of layer 'Drawing 1': shape ends"),
            (1, 0, "b", json!([0.0, -10_000_001.0]), "stroke 4 of layer 'Drawing 1': shape ends"),
            // A field the per-kind rules never read still has to have its type:
            // the lenient loader would skip this pen stroke for it.
            (0, 0, "a", json!("x"), "stroke 1 of layer 'Drawing 1': malformed"),
        ];
        for (ci, si, field, v, want) in cases {
            let got = with(ci, si, field, v.clone());
            assert!(got.starts_with(want), "{field}={v}: got '{got}', want '{want}…'");
        }
        // A multi-byte colour of the right BYTE length is refused, not sliced.
        let got = with(0, 0, "c", json!("#aaaa\u{c0}a"));
        assert!(got.contains("color"), "{got}");
        // An ink stroke without points and a shape without an end.
        let mut p = image_project();
        p["media"][1]["generator"]["chunks"][0][0].as_object_mut().unwrap().remove("p");
        assert!(refusal(&p).contains("points are missing"));
        let mut p = image_project();
        p["media"][1]["generator"]["chunks"][1][0].as_object_mut().unwrap().remove("a");
        assert!(refusal(&p).contains("shape ends"));
        // Exactly at the bound, either sign, is a shape the loader keeps.
        let mut p = image_project();
        p["media"][1]["generator"]["chunks"][1][0]["a"] = json!([-10_000_000.0, 10_000_000.0]);
        check(&p).expect("±1e7 is inside the shape bound");
    }

    /// What the lenient loader reads as "no strokes" is refused on save: the
    /// app must never write a drawing it would open emptier than it saved.
    #[test]
    fn a_drawing_the_loader_would_trim_is_never_written() {
        let mut p = image_project();
        p["media"][1]["generator"]["chunks"] = json!({ "oops": true });
        assert!(refusal(&p).contains("not a list"));
        let mut p = image_project();
        p["media"][1]["generator"]["chunks"][1] = json!("not a chunk");
        assert!(refusal(&p).contains("stroke group 2 is not a list"));
        let mut p = image_project();
        p["media"][1]["generator"]["chunks"][1][0] = json!(7);
        assert!(refusal(&p).contains("stroke 4 of layer 'Drawing 1': malformed"));
    }

    #[test]
    fn project_shape_rules_name_what_is_wrong() {
        let mut p = image_project();
        p["schema"] = 2.into();
        assert!(refusal(&p).contains("must be schema 3"));
        let mut p = image_project();
        p["timeline"]["width"] = 65_536.into();
        assert!(refusal(&p).contains("the canvas is 65536 × 707"));
        let mut p = image_project();
        p["timeline"]["height"] = 0.into();
        assert!(refusal(&p).contains("1001 × 0"));
        let mut p = image_project();
        p["timeline"]["tracks"][1]["clips"] = json!([clip("c2", "ph"), clip("c3", "ph")]);
        assert!(refusal(&p).contains("layer 'Photo' holds 2 items"));
        let mut p = image_project();
        p["timeline"]["tracks"][1]["kind"] = "audio".into();
        assert!(refusal(&p).contains("no audio tracks"));
        // The largest legal canvas passes.
        let mut p = image_project();
        p["timeline"]["width"] = 65_535.into();
        p["timeline"]["height"] = 1.into();
        check(&p).expect("65535 × 1 is a legal image canvas");
    }

    #[test]
    fn a_drawing_outside_an_image_project_is_refused_and_video_is_untouched() {
        let mut p = image_project();
        p["schema"] = 2.into();
        p.as_object_mut().unwrap().remove("kind");
        assert!(refusal(&p).contains("drawing layers"));
        // The same project without the drawing is a plain video project: none
        // of the image rules apply, not even the one-clip-per-track rule.
        p["media"].as_array_mut().unwrap().remove(1);
        p["timeline"]["tracks"][1]["clips"] = json!([clip("c2", "ph"), clip("c3", "ph")]);
        check(&p).expect("a video project is not held to the image rules");
    }

    #[test]
    fn schema_and_kind_must_agree_on_save_too() {
        let typed = |v: Value| serde_json::from_value::<ProjectFile>(v).unwrap();
        let mut video = image_project();
        video.as_object_mut().unwrap().remove("kind");
        video["media"].as_array_mut().unwrap().remove(1);
        video["schema"] = 3.into();
        assert!(check_schema_kind(&typed(video.clone())).is_err(), "a video project stamped 3");
        video["schema"] = 4.into();
        assert!(
            check_schema_kind(&typed(video.clone())).unwrap_err().to_string().contains("only valid for a PDF project"),
            "a video project stamped 4"
        );
        video["schema"] = 2.into();
        check_schema_kind(&typed(video.clone())).unwrap();
        video["schema"] = 1.into();
        check_schema_kind(&typed(video)).unwrap();
    }

    /// Each crafted-file cap, proven at small numbers (the production values
    /// are the same code with `CAPS`): exactly at a cap passes, one over fails,
    /// and each failure names its own cap so one cannot pass for another. The
    /// fixture holds 4 strokes with 1 + 2 + 1 + 0 = 4 points.
    #[test]
    fn stroke_caps_are_enforced() {
        let p = image_project();
        let typed: ProjectFile = serde_json::from_value(p.clone()).unwrap();
        let caps = |per, points, strokes| Caps { points_per_stroke: per, points_total: points, strokes_total: strokes };
        let msg = |c: Caps| match validate_with(&p, &typed, c) {
            Err(AppError::BadInput(m)) => m,
            other => panic!("expected BadInput, got {other:?}"),
        };
        validate_with(&p, &typed, caps(2, 4, 4)).expect("exactly at every cap is legal");
        assert!(msg(caps(1, 4, 4)).starts_with("stroke 2 of layer 'Drawing 1': more than 1 points"));
        assert_eq!(msg(caps(2, 3, 4)), "the drawings hold more than 3 points");
        assert_eq!(msg(caps(2, 4, 3)), "the drawings hold more than 3 strokes");
        // The totals run across every drawing of the project, not per layer.
        let mut two = p.clone();
        let mut d2 = two["media"][1].clone();
        d2["id"] = "d2".into();
        two["media"].as_array_mut().unwrap().push(d2);
        let typed2: ProjectFile = serde_json::from_value(two.clone()).unwrap();
        validate_with(&two, &typed2, caps(2, 8, 8)).expect("two drawings at the cap");
        assert!(validate_with(&two, &typed2, caps(2, 7, 8)).is_err());
        assert!(validate_with(&two, &typed2, caps(2, 8, 7)).is_err());
        // The real caps are strokes.ts's MAX_STROKE_POINTS / MAX_TOTAL_POINTS /
        // MAX_TOTAL_STROKES.
        assert_eq!((MAX_POINTS_PER_STROKE, MAX_POINTS_TOTAL, MAX_STROKES_TOTAL), (1_000_000, 20_000_000, 2_000_000));
    }

    /// The exporter's own pre-check, reached the way a crafted `.trt` would
    /// reach it: an image project's JSON handed to the video export spec. It
    /// must come back as an Err, never a panic (`panic = "abort"`).
    #[test]
    fn the_video_exporter_refuses_an_image_project_without_panicking() {
        let p = image_project();
        let spec: crate::export::model::ExportSpec = serde_json::from_value(json!({
            "media": p["media"], "timeline": p["timeline"], "outPath": "C:\\o.mp4",
            "preset": { "format": "mp4", "vcodec": "h264", "resolution": "original", "fps": "original",
                        "videoBitrate": "auto", "audioBitrate": "auto", "useHardware": false }
        }))
        .expect("the spec parses");
        let enc = crate::hw::EncoderReport {
            h264: "libx264".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        };
        match crate::export::builder::build(&spec, &enc) {
            Err(AppError::BadInput(m)) => assert!(m.contains("image editor"), "{m}"),
            Err(e) => panic!("expected BadInput, got {e:?}"),
            Ok(_) => panic!("an image project reached the ffmpeg plan"),
        }
    }

    /// A valid PDF project: schema 4, kind pdf, an opaque `pdf` object, one
    /// picture in `media` (an image mark's), and the empty timeline.
    fn pdf_project() -> Value {
        json!({
            "schema": 4, "kind": "pdf", "app": "taroting", "id": "p-4",
            "name": "Lease", "createdAt": "a", "modifiedAt": "b",
            "media": [
                { "id": "sig", "path": "C:\\In\\stamp.png", "size": 4, "mtimeMs": 5, "kind": "image",
                  "duration": 0.0, "hasAudio": false, "width": 120, "height": 40 }
            ],
            "timeline": { "fps": { "num": 30, "den": 1 }, "width": 1920, "height": 1080, "tracks": [] },
            "export": {},
            "pdf": { "sources": [], "pages": [], "annots": {}, "forms": {} }
        })
    }

    #[test]
    fn a_well_formed_pdf_project_is_accepted_and_its_rules_name_what_is_wrong() {
        check(&pdf_project()).expect("the PDF fixture is valid");
        // An empty video track is still "no clips".
        let mut p = pdf_project();
        p["timeline"]["tracks"] = json!([{ "id": "t1", "kind": "video", "name": "V", "muted": false, "clips": [] }]);
        check(&p).expect("an empty track holds no clips");

        let mut p = pdf_project();
        p.as_object_mut().unwrap().remove("pdf");
        assert_eq!(refusal(&p), "a PDF project must carry its pdf object");
        for odd in [json!([]), json!("x"), json!(4), Value::Null] {
            let mut p = pdf_project();
            p["pdf"] = odd.clone();
            assert_eq!(refusal(&p), "a PDF project must carry its pdf object", "{odd}");
        }
        let mut p = pdf_project();
        p["timeline"]["tracks"] = json!([{ "id": "t1", "kind": "video", "name": "V", "muted": false,
                                           "clips": [clip("c1", "sig")] }]);
        assert_eq!(refusal(&p), "a PDF project has no timeline clips");
        let mut p = pdf_project();
        p["schema"] = 3.into();
        assert!(refusal(&p).contains("a PDF project must be schema 4, not 3"));
        // A drawing layer has no place in a PDF project either.
        let mut p = pdf_project();
        p["media"] = json!([image_project()["media"][1].clone()]);
        assert!(refusal(&p).contains("drawing layers"));
        // An image project is not mistaken for a PDF one: no `pdf` needed.
        check(&image_project()).expect("still valid");
    }

    #[test]
    fn schema_and_pdf_kind_must_agree_on_save_too() {
        let typed = |v: &Value| serde_json::from_value::<ProjectFile>(v.clone()).unwrap();
        let mut p = pdf_project();
        check_schema_kind(&typed(&p)).unwrap();
        for wrong in [1, 2, 3, 5] {
            p["schema"] = wrong.into();
            let err = check_schema_kind(&typed(&p)).unwrap_err().to_string();
            assert!(err.contains("a PDF project must be schema 4"), "{wrong}: {err}");
        }
        // An image project stamped 4 is refused as an image project.
        let mut i = image_project();
        i["schema"] = 4.into();
        assert!(check_schema_kind(&typed(&i)).unwrap_err().to_string().contains("an image project must be schema 3"));
    }

    /// The video exporter refuses a PDF project by its kind, before anything
    /// else (its empty timeline would otherwise answer for it) — reached the
    /// way the editor's export spec would carry it, with an Err, never a
    /// panic. Only the literal kind "pdf" does it.
    #[test]
    fn the_video_exporter_refuses_a_pdf_project_by_its_kind() {
        let p = pdf_project();
        let spec_of = |kind: Value, timeline: &Value| -> crate::export::model::ExportSpec {
            serde_json::from_value(json!({
                "media": p["media"], "timeline": timeline, "outPath": "C:\\o.mp4", "kind": kind,
                "preset": { "format": "mp4", "vcodec": "h264", "resolution": "original", "fps": "original",
                            "videoBitrate": "auto", "audioBitrate": "auto", "useHardware": false }
            }))
            .expect("the spec parses")
        };
        let enc = crate::hw::EncoderReport {
            h264: "libx264".into(),
            hevc: "libx265".into(),
            av1: "libsvtav1".into(),
            detail: vec![],
        };
        let refusal = |spec: crate::export::model::ExportSpec| match crate::export::builder::build(&spec, &enc) {
            Err(AppError::BadInput(m)) => m,
            Err(e) => panic!("expected BadInput, got {e:?}"),
            Ok(_) => panic!("a PDF project reached the ffmpeg plan"),
        };
        assert_eq!(refusal(spec_of("pdf".into(), &p["timeline"])), "PDF projects are exported from the PDF editor");
        // Even one holding a clip (a crafted file): the kind decides first.
        let mut with_clip = p["timeline"].clone();
        with_clip["tracks"] = json!([{ "id": "t1", "kind": "video", "name": "V", "muted": false,
                                       "clips": [clip("c1", "sig")] }]);
        assert_eq!(refusal(spec_of("pdf".into(), &with_clip)), "PDF projects are exported from the PDF editor");
        // Any other kind value is no kind: the ordinary rules answer.
        assert!(refusal(spec_of("PDF".into(), &p["timeline"])).contains("empty timeline"));
        assert!(spec_of(Value::Null, &p["timeline"]).kind.is_none());
    }
}
