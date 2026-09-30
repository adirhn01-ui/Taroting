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
//! **Why the save check reads the RAW value.** The typed parse
//! (`schema::strokes_that_parse`) skips any stroke that does not have the typed
//! shape, so "it deserialized" proves nothing about the strokes any more. The
//! raw JSON is what `save_project` writes, so the raw JSON is what is checked:
//! every stroke must deserialize as `schema::Stroke` (which proves every field
//! present has the right type) AND then meet the value rules below.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::schema::{Generator, ProjectFile, Stroke, IMAGE_SCHEMA};
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

/// Refuse a drawing layer anywhere but an image project.
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
pub fn check_schema_kind(p: &ProjectFile) -> Result<()> {
    let image = p.kind.as_deref() == Some("image");
    if image && p.schema != IMAGE_SCHEMA {
        return Err(AppError::BadInput(format!(
            "an image project must be schema {IMAGE_SCHEMA}, not {}",
            p.schema
        )));
    }
    if !image && p.schema >= IMAGE_SCHEMA {
        return Err(AppError::BadInput(format!(
            "schema {} is only valid for an image project",
            p.schema
        )));
    }
    Ok(())
}

/// Everything an image project must be before it is written. A no-op for a
/// video project. `raw` is the value `save_project` is about to write and
/// `typed` its (lenient) parse; the stroke rules read `raw`, see the module
/// comment.
pub fn validate_image_project(raw: &Value, typed: &ProjectFile) -> Result<()> {
    validate_with(raw, typed, CAPS)
}

fn validate_with(raw: &Value, typed: &ProjectFile, caps: Caps) -> Result<()> {
    if typed.kind.as_deref() != Some("image") {
        return Ok(());
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

    let mut totals = Totals::default();
    let Some(media) = raw.get("media").and_then(Value::as_array) else {
        return Ok(()); // the typed parse already proved `media` is a list
    };
    for m in media {
        let Some(gen) = m.get("generator") else { continue };
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
    let class = match s.t.as_str() {
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
    if matches!(class, Class::Ink | Class::Shape) && !is_hex_colour(s.c.as_deref()) {
        return Err("color is not #rrggbb".into());
    }
    match class {
        Class::Ink | Class::Erase => {
            let p = s.p.as_deref().ok_or("points are missing")?;
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
}
