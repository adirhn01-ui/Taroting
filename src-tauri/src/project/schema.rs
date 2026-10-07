//! Typed mirror of the .trt project schema (TypeScript is the source of
//! truth) plus the migration chain for older schema versions.
//!
//! serde ignores unknown fields by default — newer files opened by older
//! builds degrade gracefully instead of failing to parse.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

pub const CURRENT_SCHEMA: u32 = 2;

/// The schema an IMAGE project is stamped with, and only an image project.
/// CURRENT_SCHEMA stays 2: bumping it would make `migrate()` reject every
/// schema-2 file and stamp schema-1 VIDEO files as 3. A video project never
/// carries `kind`, stays 2, and is byte-identical on disk.
pub const IMAGE_SCHEMA: u32 = 3;
/// Highest schema this build opens.
pub const MAX_ACCEPTED_SCHEMA: u32 = 3;

/// The first schema version whose `media[].width`/`height` are rotation-aware.
///
/// A `.trt` written below this stored the CODED dimensions ffprobe reports, so
/// a portrait phone recording — coded landscape plus a 90° Display Matrix —
/// was recorded landscape, and `timeline.width`/`height`, adopted from the
/// first visual media on an empty timeline, inherited the same mistake. The
/// clip has been letterboxed into a sideways canvas ever since.
///
/// The correction cannot be made in `migrate`. Nothing in the file records the
/// rotation, so a genuinely-landscape 1920x1080 clip and a portrait one stored
/// pre-swap are the same bytes; only the file on disk can tell them apart.
/// `store::load_project` therefore re-probes, gated on this constant, and the
/// version stamp this migration writes is what records that it has done so —
/// which is why the 1 → 2 step below changes nothing else.
pub const ROTATION_REPAIR_SCHEMA: u32 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    pub id: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub kind: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<Rational>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pix_fmt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    pub has_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator: Option<Generator>,
    /// Stills only: the WebView draws this file UNTURNED although it carries
    /// an orientation tag the bundled ffmpeg would turn it by (a WebP's EXIF,
    /// a PNG eXIf after the image data, a TIFF's IFD0), so the export opens it
    /// `-noautorotate` and `width`/`height` are the coded size. Decided per
    /// FILE from its header (`media::exif::read_still`) by the probe and the
    /// load-time repair; the export builder only reads the stored answer.
    ///
    /// Only a literal `true` is the flag. Anything else a hand-edited `.trt`
    /// puts here reads as absent rather than failing the whole project's
    /// parse: 0.8.1 ignored this key as unknown, and a value it would have
    /// opened must not become "invalid project file" now.
    #[serde(
        default,
        deserialize_with = "true_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub no_autorotate: Option<bool>,
    /// Video only: this file's H.264 stream carries in-band headers that must
    /// not be believed — a damaged recording whose garbage frames happen to
    /// parse as parameter sets (SPS/PPS: they re-size ffmpeg's decoder and
    /// wreck every clean frame after them) or as SEI (a display-orientation
    /// SEI turns every frame it rides on). Every ffmpeg decode of the file for
    /// EXPORT then removes the in-band SPS/PPS/SEI (the input bitstream filter
    /// `prepare::DROP_INBAND_HEADERS`), so the header's (`avcC`) parameter
    /// sets are the only ones in force — what the MP4 spec says an `avc1`
    /// stream carries anyway. Stamped by the editor only, when the preview's
    /// repair plan reports `repair.dropsHeaders` (`playability::RepairNote`);
    /// planning then goes straight to the repair on later opens. The export
    /// builder applies it only to an H.264 video input.
    ///
    /// Only a literal `true` is the flag, read by the same lenient rule as
    /// `no_autorotate`: 0.9.1 ignored this key as unknown, and a value it would
    /// have opened must not become "invalid project file" now.
    #[serde(
        default,
        deserialize_with = "true_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub drop_inband_headers: Option<bool>,
}

/// `Some(true)` for a JSON `true`, `None` for anything else — a flag that is
/// only ever written as `true` (`MediaRef.noAutorotate?: true`,
/// `MediaRef.dropInbandHeaders?: true`).
fn true_or_none<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<bool>, D::Error> {
    Ok((Value::deserialize(d)? == Value::Bool(true)).then_some(true))
}

/// `Some("image")` for a JSON `"image"`, `None` for anything else: the only
/// kind a project (`ProjectFile.kind?: "image"`) or a recents entry
/// (`RecentItem.kind?: "image"`) carries. Same reasoning as `true_or_none`:
/// 0.8.1 ignored `kind` as unknown, so a value there it would have opened must
/// not turn the file into "invalid project file" now — and `migrate()` reads
/// the kind by exactly this rule, so the two can never disagree.
pub(crate) fn image_kind_or_none<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    Ok((Value::deserialize(d)? == Value::from("image")).then(|| "image".to_string()))
}

/// `tempEdited` as written by the app: exactly `true`, else false. Lenient for
/// the same reason as `image_kind_or_none` — a hand-edited or damaged value
/// must not make the whole project unreadable; it only means "not known to be
/// edited", which at worst lets the startup sweep clear an orphan sooner.
pub(crate) fn true_or_false<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<bool, D::Error> {
    Ok(Value::deserialize(d)? == Value::Bool(true))
}

/// How many entries a drawing's `chunks` lists, found WITHOUT building
/// anything: every chunk and every stroke is walked with `IgnoredAny`, so not
/// one point string is copied. Never fails on the contents. `load_project`
/// parses a project only to CHECK it and hands the raw JSON on, so a damaged
/// stroke must not make the whole image project "invalid project file"
/// (graceful failure on a corrupt `.trt`): the image editor drops the strokes
/// it cannot validate and says so. The strict per-stroke check belongs to
/// `save_project`, which validates the raw value (`image_rules`), so the app
/// can never WRITE a stroke the editor would drop.
///
/// Why only a count. Rust never draws, exports or rewrites a stroke — the
/// video exporter refuses a drawing by its variant alone — and the typed copy
/// of every stroke this used to build made each save and load (on the main
/// thread) allocate a second full copy of the drawing's point data, a cloned
/// JSON tree whose strings then moved into the parsed strokes, for nothing.
/// The count costs 8 bytes, whatever the drawing weighs.
///
/// The count is of entries LISTED in array chunks — a damaged stroke counts,
/// a chunk that is not an array contributes nothing, a `chunks` that is not an
/// array reads as 0 — because Rust has no use for "strokes that would pass".
fn count_strokes<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    d.deserialize_any(Entries { nested: true })
}

/// `count_strokes`' walker. `nested`: this level is the list of chunks, whose
/// array elements are counted one level down; otherwise this level is one
/// chunk, whose elements are the strokes counted. Anything that is not an
/// array is skipped whole and counts 0.
struct Entries {
    nested: bool,
}

impl<'de> serde::de::DeserializeSeed<'de> for Entries {
    type Value = u64;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> std::result::Result<u64, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> serde::de::Visitor<'de> for Entries {
    type Value = u64;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<u64, A::Error> {
        let mut n = 0u64;
        if self.nested {
            while let Some(k) = seq.next_element_seed(Entries { nested: false })? {
                n = n.saturating_add(k);
            }
        } else {
            while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                n = n.saturating_add(1);
            }
        }
        Ok(n)
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<u64, A::Error> {
        while map.next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?.is_some() {}
        Ok(0)
    }

    fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> std::result::Result<u64, D::Error> {
        serde::de::IgnoredAny::deserialize(d).map(|_| 0)
    }

    fn visit_none<E>(self) -> std::result::Result<u64, E> {
        Ok(0)
    }

    fn visit_unit<E>(self) -> std::result::Result<u64, E> {
        Ok(0)
    }

    fn visit_bool<E>(self, _: bool) -> std::result::Result<u64, E> {
        Ok(0)
    }

    fn visit_i64<E>(self, _: i64) -> std::result::Result<u64, E> {
        Ok(0)
    }

    fn visit_u64<E>(self, _: u64) -> std::result::Result<u64, E> {
        Ok(0)
    }

    fn visit_f64<E>(self, _: f64) -> std::result::Result<u64, E> {
        Ok(0)
    }

    fn visit_str<E>(self, _: &str) -> std::result::Result<u64, E> {
        Ok(0)
    }
}

/// A drawing is never written from its typed form: the typed model holds a
/// stroke COUNT, not the strokes, so a typed write would empty the drawing.
/// Every writer writes the raw JSON it was given (`save_project`, the load-time
/// repairs), and this makes any future typed write fail loudly instead of
/// quietly losing a picture.
fn never_written<S: serde::Serializer>(_: &u64, _: S) -> std::result::Result<S::Ok, S::Error> {
    Err(serde::ser::Error::custom(
        "a drawing layer is never written from its typed form; write the project's raw JSON",
    ))
}

/// A photo layer's adjustments, or `None` when the value is not an object of
/// numbers. Rust only carries these (the image editor sanitizes and renders
/// them), so a malformed one is no reason to refuse the file — least of all a
/// video project, where 0.8.1 ignored the key.
fn adjust_or_none<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<ClipAdjust>, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(d)?).ok())
}

/// A synthetic media source (solid color, styled text, or an image project's
/// drawing layer). Mirrors the TS `Generator` union: a `type`-tagged,
/// camelCase enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum Generator {
    #[serde(rename = "solid")]
    Solid { color: String },
    #[serde(rename = "text")]
    Text {
        text: String,
        font_family: String,
        size_px: f64,
        color: String,
        bold: bool,
        italic: bool,
    },
    /// A freehand/markup layer of an IMAGE project, and never valid anywhere
    /// else: `load_project` refuses one in a video project, `save_project`
    /// refuses one unless `kind` is "image", and the video exporter's `build()`
    /// pre-check refuses it before any input is registered. Strokes come in
    /// chunks of at most 256 (`STROKE_CHUNK` in src/core/types.ts).
    #[serde(rename = "drawing")]
    Drawing {
        /// How many entries the drawing's `chunks` lists (`count_strokes`).
        /// Required, as `chunks` always was: a drawing without it is not a
        /// drawing the app wrote. Production only needs the variant (every
        /// guard above matches `Drawing { .. }`); the count is what the
        /// tests read to prove the walk is lenient.
        #[serde(rename = "chunks", deserialize_with = "count_strokes", serialize_with = "never_written")]
        #[allow(dead_code)]
        strokes: u64,
    },
}

/// One committed mark on a drawing layer (TS `Stroke`), as `save_project`'s
/// check reads it straight out of the raw JSON. Never part of the typed
/// project (see `count_strokes`) and never serialized.
///
/// Borrowed from the raw value it is read from, so checking a stroke copies
/// none of it — a million-point `p` is 16 MB of text. That is safe here and
/// only here: the check holds the value immutably for the stroke's lifetime,
/// whereas the typed project must stay owned (`load_project` repairs its raw
/// value in place after parsing it).
///
/// Loose on purpose: which fields a stroke needs depends on `t` (ink and erase
/// strokes carry `p`, shapes carry `a`/`b`, an erase has no `c`), and that rule
/// — with the value checks — belongs to the save-time validation, not to
/// serde. `p` is unpadded standard base64 of little-endian Float32
/// `[x, y, pressure]` triples, 16 characters per point.
#[derive(Debug, Deserialize)]
pub struct Stroke<'a> {
    pub t: &'a str,
    #[serde(default, borrow)]
    pub c: Option<&'a str>,
    pub w: f64,
    #[serde(default)]
    pub o: Option<f64>,
    #[serde(default, borrow)]
    pub p: Option<&'a str>,
    #[serde(default)]
    pub a: Option<[f64; 2]>,
    #[serde(default)]
    pub b: Option<[f64; 2]>,
}

/// An image project's colour/tone adjustments of one PHOTO layer (TS
/// `ClipAdjust`): integers on the TS side, 0 = identity, a missing field = 0.
/// Rust never acts on them — the image editor renders them — so they are
/// carried, not interpreted.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAdjust {
    #[serde(default)]
    pub exposure: f64,
    #[serde(default)]
    pub brightness: f64,
    #[serde(default)]
    pub contrast: f64,
    #[serde(default)]
    pub highlights: f64,
    #[serde(default)]
    pub shadows: f64,
    #[serde(default)]
    pub saturation: f64,
    #[serde(default)]
    pub hue: f64,
    #[serde(default)]
    pub warmth: f64,
    #[serde(default)]
    pub tint: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCrop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<ClipCrop>,
    pub rotate: u32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub opacity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAudio {
    pub volume: f64,
    pub muted: bool,
    pub fade_in_sec: f64,
    pub fade_out_sec: f64,
    pub gain_offset_db: f64,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe {
    pub t: f64,
    pub v: f64,
}

/// Per-prop animation tracks. Each is optional; empty ones are skipped on the
/// wire. `x`/`y` are kept paired by the frontend mutations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipKeyframes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<Vec<Keyframe>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<Vec<Keyframe>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<Vec<Keyframe>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<Vec<Keyframe>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub timeline_start: f64,
    pub src_in: f64,
    pub src_out: f64,
    #[serde(deserialize_with = "de_speed")]
    pub speed: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<ClipTransform>,
    pub audio: ClipAudio,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<ClipKeyframes>,
    /// Image projects, photo layers only.
    #[serde(
        default,
        deserialize_with = "adjust_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub adjust: Option<ClipAdjust>,
}

/// Speed is a DIVISOR everywhere it is used — `duration()` below, the video
/// chain's `setpts=(PTS-STARTPTS)/speed`, and the `atempo` decomposition — so a
/// zero, negative or non-finite value is not merely odd, it is unusable. It is
/// normalised here, at the deserialize boundary, rather than defended against at
/// each of those three sites.
///
/// Why this is not paranoia: `speed` is a bare `f64` in the schema with no
/// frontend runtime validation (`checkInvariants` in `src/core/project.ts` is
/// test-only), and this crate's own test suite writes and successfully loads a
/// `"speed": 0.0` project — so such a file opens in the editor today. Left
/// alone, `duration()` returns a non-finite value that reaches ffmpeg as a
/// literal `inf` in `-t`/`d=` strings, and `atempo_factors` looped until the
/// allocator failed, which under `panic = "abort"` takes the whole app down
/// mid-export along with any unsaved work.
///
/// 1.0 rather than a clamp into the editor's [0.25, 4.0]: a clamp would have to
/// reel in finite out-of-range speeds like 8.0 to be coherent, and those already
/// work and stay in step with the video chain. Normalising only the values that
/// have no honest meaning leaves every legal speed exactly as authored.
fn de_speed<'de, D>(d: D) -> std::result::Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = f64::deserialize(d)?;
    Ok(if v.is_finite() && v > 0.0 { v } else { 1.0 })
}

impl Clip {
    pub fn duration(&self) -> f64 {
        (self.src_out - self.src_in) / self.speed
    }
    pub fn end(&self) -> f64 {
        self.timeline_start + self.duration()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub muted: bool,
    pub clips: Vec<Clip>,
    /// Image projects: the layer is hidden (the eye toggle). Absent = visible.
    /// TS only ever writes `true` (anything else reads as visible, never as a
    /// parse failure); the video exporter never reads it.
    #[serde(
        default,
        deserialize_with = "true_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    pub t: f64,
    pub color: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub fps: Rational,
    pub width: u32,
    pub height: u32,
    pub tracks: Vec<Track>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<Marker>,
}

impl Timeline {
    /// The timeline length: the latest end across EVERY clip on every track.
    ///
    /// Reads all of them rather than each track's last, because nothing on this
    /// side of the wire sorts or checks the order. The editor happens to keep
    /// `clips` in `timelineStart` order, but a `.trt` is plain JSON that is
    /// shared and hand-edited, and serde stores whatever order the file lists —
    /// so `clips.last()` is a trust, not a fact. Trusting it truncated the
    /// export to the last-LISTED clip's end: the longest clip written first
    /// simply vanished off the end of the rendered video, silently, since a
    /// short duration is a legal export.
    ///
    /// Even in file order `last()` is only right when the clips do not overlap;
    /// a clip that starts later but is shorter also ends earlier. O(n) over the
    /// clips is nothing next to the export it feeds.
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(Clip::end)
            .fold(0.0, f64::max)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub schema: u32,
    pub app: String,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub modified_at: String,
    pub media: Vec<MediaRef>,
    pub timeline: Timeline,
    pub export: Value, // opaque to Rust until the export milestone
    /// `Some("image")` → an image project (schema `IMAGE_SCHEMA`). Absent → a
    /// video project. `migrate()` refuses any other pairing of the two; any
    /// other value here reads as absent (`image_kind_or_none`).
    #[serde(
        default,
        deserialize_with = "image_kind_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<String>,
    /// Image projects only. Opaque to Rust: the image editor sanitizes
    /// `background` and `export` on read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<Value>,
    /// A TEMPORARY project (tmp-projects) the user has edited. Set by the
    /// frontend on the first save after a real edit and dropped when the user
    /// keeps the project, so it never reaches a permanent file. The startup
    /// sweep keeps an edited orphan (a crash or logoff skipped the
    /// keep/discard prompt) for Home to offer back, and clears untouched ones.
    #[serde(
        default,
        deserialize_with = "true_or_false",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub temp_edited: bool,
}

/// A project migrated to `CURRENT_SCHEMA`, plus the version it arrived as.
///
/// `from` is the load path's only way to tell a file that has already been
/// through a version-gated repair from one that has not: `value` carries the
/// current version either way. Returning it here, rather than leaving each
/// caller to re-read `schema` off the raw JSON before calling, is what makes
/// the gate impossible to forget.
#[derive(Debug)]
pub struct Migrated {
    pub value: Value,
    /// The version the file carried on disk, BEFORE migration.
    pub from: u32,
}

/// Migrate a raw project JSON value to the current schema version.
///
/// Pure JSON, deliberately: it is called from paths that have no business
/// touching the disk (`store::thumb_source_for` resolves a recents thumbnail
/// this way). A migration step that needs more than the file's own bytes — the
/// 1 → 2 dimension repair does, since the rotation exists only in the media
/// file — belongs on the load path, keyed off the returned `from`.
pub fn migrate(mut value: Value) -> Result<Migrated> {
    // Compared as u64 BEFORE narrowing: `schema: 4294967297` truncates to 1 in
    // a u32 cast, which would have run a v1 file's migrations over a document
    // claiming to be from the future. A crafted `.trt` is this app's main
    // threat surface, so the range check comes first and the cast happens only
    // once the value is known to fit.
    let version = value
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::BadInput("not a Taroting project (missing schema)".into()))?;
    if version > MAX_ACCEPTED_SCHEMA as u64 {
        return Err(AppError::BadInput(format!(
            "project was created by a newer Taroting (schema {version}); please update the app"
        )));
    }
    let from = version as u32;
    // Schema and kind must agree, both ways. A schema-3 file without the image
    // kind would reach the VIDEO pipeline holding whatever an image project
    // holds, and an image kind on a video schema would open a video project in
    // the image editor. No build writes either shape, so either one is a
    // crafted or damaged file: refused, never guessed at. Only the literal
    // string "image" is the kind; any other string there reads as "not an
    // image project" — refused at schema 3, a plain video project at 1 or 2.
    let is_image = value.get("kind").and_then(Value::as_str) == Some("image");
    match from {
        IMAGE_SCHEMA => {
            if !is_image {
                return Err(AppError::BadInput(
                    "schema 3 is only valid for an image project".into(),
                ));
            }
        }
        CURRENT_SCHEMA => {
            if is_image {
                return Err(AppError::BadInput("an image project must be schema 3".into()));
            }
        }
        // 1 → 2: nothing in the JSON changes, because nothing in the JSON CAN.
        // The stamp is the entire migration — see `ROTATION_REPAIR_SCHEMA` for
        // what it records and who acts on it. No image project was ever
        // schema 1, so one claiming to be is refused rather than stamped.
        1 => {
            if is_image {
                return Err(AppError::BadInput("an image project must be schema 3".into()));
            }
            if let Some(obj) = value.as_object_mut() {
                obj.insert("schema".into(), Value::from(CURRENT_SCHEMA));
            }
        }
        v => return Err(AppError::BadInput(format!("unknown project schema {v}"))),
    }
    Ok(Migrated { value, from })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tempEdited` crosses the wire as `"tempEdited": true` or not at all, and
    /// only a literal `true` counts: a damaged value reads as false instead of
    /// failing the whole load.
    #[test]
    fn temp_edited_is_written_only_when_set_and_read_leniently() {
        let base = serde_json::json!({
            "schema": 2, "app": "taroting", "id": "p", "name": "n",
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-02T00:00:00Z",
            "media": [], "timeline": {"fps": {"num": 30, "den": 1}, "width": 640, "height": 360, "tracks": [], "markers": []},
            "export": {}
        });
        let read = |v: Value| serde_json::from_value::<ProjectFile>(v).map(|p| p.temp_edited);
        assert!(!read(base.clone()).unwrap(), "absent");
        for (value, want) in [
            (Value::Bool(true), true),
            (Value::Bool(false), false),
            (Value::from("true"), false),
            (Value::from(1), false),
            (Value::Null, false),
        ] {
            let mut v = base.clone();
            v["tempEdited"] = value.clone();
            assert_eq!(read(v).unwrap(), want, "tempEdited = {value}");
        }
        let mut edited: ProjectFile = serde_json::from_value(base.clone()).unwrap();
        assert!(serde_json::to_value(&edited).unwrap().get("tempEdited").is_none(), "false is omitted");
        edited.temp_edited = true;
        assert_eq!(serde_json::to_value(&edited).unwrap()["tempEdited"], Value::Bool(true));
    }

    #[test]
    fn round_trips_and_tolerates_unknown_fields() {
        let json = serde_json::json!({
            "schema": 1,
            "app": "taroting",
            "id": "p1",
            "name": "Test",
            "createdAt": "2026-01-01T00:00:00Z",
            "modifiedAt": "2026-01-01T00:00:00Z",
            "media": [{
                "id": "m1",
                "path": "C:\\v.mp4",
                "size": 10,
                "mtimeMs": 5,
                "kind": "video",
                "duration": 60.0,
                "fps": {"num": 30, "den": 1},
                "hasAudio": true,
                "someFutureField": {"nested": true}
            }, {
                "id": "m2",
                "path": "Text: Hello",
                "size": 0,
                "mtimeMs": 0,
                "kind": "image",
                "duration": 0.0,
                "hasAudio": false,
                "width": 400, "height": 200,
                "generator": {
                    "type": "text",
                    "text": "Hello",
                    "fontFamily": "Georgia",
                    "sizePx": 96.0,
                    "color": "#ffffff",
                    "bold": true,
                    "italic": false
                }
            }],
            "timeline": {
                "fps": {"num": 30, "den": 1},
                "width": 1920,
                "height": 1080,
                "markers": [{"id": "mk1", "t": 12.5, "color": 3}],
                "tracks": [{
                    "id": "t1", "kind": "video", "name": "Video", "muted": false,
                    "clips": [{
                        "id": "c1", "mediaId": "m1",
                        "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 60.0, "speed": 1.0,
                        "keyframes": {
                            "x": [{"t": 0.0, "v": 0.0}, {"t": 30.0, "v": 100.0}],
                            "y": [{"t": 0.0, "v": 0.0}, {"t": 30.0, "v": -50.0}],
                            "opacity": [{"t": 0.0, "v": 0.0}, {"t": 2.0, "v": 1.0}]
                        },
                        "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                                   "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                    }]
                }]
            },
            "export": {"format": "mp4"},
            "unknownTopLevel": 42
        });
        let migrated = migrate(json).unwrap();
        assert_eq!(migrated.from, 1, "the file's ON-DISK version, not the current one");
        assert_eq!(migrated.value["schema"], CURRENT_SCHEMA);
        let parsed: ProjectFile = serde_json::from_value(migrated.value).unwrap();
        assert_eq!(parsed.name, "Test");
        assert_eq!(parsed.timeline.duration(), 60.0);
        // serialize back — unknown fields are dropped, knowns survive
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out["media"][0]["mtimeMs"], 5);
        assert_eq!(out["timeline"]["tracks"][0]["clips"][0]["srcOut"], 60.0);

        // markers survive
        assert_eq!(out["timeline"]["markers"][0]["t"], 12.5);
        assert_eq!(out["timeline"]["markers"][0]["color"], 3);

        // clip keyframes survive with exact values
        let kf = &out["timeline"]["tracks"][0]["clips"][0]["keyframes"];
        assert_eq!(kf["x"][1]["t"], 30.0);
        assert_eq!(kf["x"][1]["v"], 100.0);
        assert_eq!(kf["y"][1]["v"], -50.0);
        assert_eq!(kf["opacity"][1]["v"], 1.0);

        // text generator survives with camelCase field names on the wire
        let gen = &out["media"][1]["generator"];
        assert_eq!(gen["type"], "text");
        assert_eq!(gen["text"], "Hello");
        assert_eq!(gen["fontFamily"], "Georgia");
        assert_eq!(gen["sizePx"], 96.0);
        assert_eq!(gen["bold"], true);
    }

    /// `noAutorotate` is a flag only a literal `true` sets. Every other value
    /// a hand-edited `.trt` can hold reads as absent — never a parse failure,
    /// which would turn a file 0.8.1 opened (the key was unknown to it) into
    /// "invalid project file". Absent stays absent on the way back out, and
    /// the flag is written camelCase.
    #[test]
    fn no_autorotate_is_only_ever_a_literal_true() {
        let with = |v: Option<Value>| {
            let mut m = serde_json::json!({
                "id": "m1", "path": "C:\\p.webp", "size": 1, "mtimeMs": 1,
                "kind": "image", "duration": 0.0, "hasAudio": false
            });
            if let Some(v) = v {
                m["noAutorotate"] = v;
            }
            serde_json::from_value::<MediaRef>(m).map(|m| m.no_autorotate)
        };
        assert_eq!(with(Some(Value::Bool(true))).unwrap(), Some(true));
        assert_eq!(with(None).unwrap(), None);
        for odd in [
            Value::Bool(false),
            Value::from("yes"),
            Value::from(1),
            Value::Null,
            serde_json::json!({ "v": true }),
            serde_json::json!([true]),
        ] {
            assert_eq!(with(Some(odd.clone())).unwrap_or_else(|e| panic!("{odd}: {e}")), None, "{odd}");
        }

        let mut m: MediaRef = serde_json::from_value(serde_json::json!({
            "id": "m1", "path": "C:\\p.webp", "size": 1, "mtimeMs": 1,
            "kind": "image", "duration": 0.0, "hasAudio": false, "noAutorotate": true
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(&m).unwrap()["noAutorotate"], true);
        m.no_autorotate = None;
        assert!(serde_json::to_value(&m).unwrap().get("noAutorotate").is_none());
    }

    /// `dropInbandHeaders` by the same rule: only a literal `true` is the
    /// flag, every other value a hand-edited `.trt` can hold reads as absent
    /// rather than failing the project's parse, and it is written camelCase
    /// only while set. The fixture also carries `noAutorotate: true`, so a
    /// field wired to the wrong key reads the wrong answer in one direction.
    #[test]
    fn drop_inband_headers_is_only_ever_a_literal_true() {
        let with = |v: Option<Value>| {
            let mut m = serde_json::json!({
                "id": "m1", "path": "C:\\rec.mp4", "size": 7, "mtimeMs": 3,
                "kind": "video", "duration": 4.5, "hasAudio": true, "noAutorotate": true
            });
            if let Some(v) = v {
                m["dropInbandHeaders"] = v;
            }
            serde_json::from_value::<MediaRef>(m).map(|m| m.drop_inband_headers)
        };
        assert_eq!(with(Some(Value::Bool(true))).unwrap(), Some(true));
        assert_eq!(with(None).unwrap(), None);
        for odd in [
            Value::Bool(false),
            Value::from("yes"),
            Value::from("true"),
            Value::from(1),
            Value::Null,
            serde_json::json!({ "v": true }),
            serde_json::json!([true]),
        ] {
            assert_eq!(with(Some(odd.clone())).unwrap_or_else(|e| panic!("{odd}: {e}")), None, "{odd}");
        }

        let mut m: MediaRef = serde_json::from_value(serde_json::json!({
            "id": "m1", "path": "C:\\rec.mp4", "size": 7, "mtimeMs": 3,
            "kind": "video", "duration": 4.5, "hasAudio": true, "dropInbandHeaders": true
        }))
        .unwrap();
        assert_eq!(m.no_autorotate, None, "the other flag is untouched");
        let out = serde_json::to_value(&m).unwrap();
        assert_eq!(out["dropInbandHeaders"], true);
        assert!(out.get("drop_inband_headers").is_none(), "camelCase on the wire");
        m.drop_inband_headers = None;
        assert!(serde_json::to_value(&m).unwrap().get("dropInbandHeaders").is_none());
    }

    fn clip_at(id: &str, start: f64, src_in: f64, src_out: f64, speed: f64) -> Clip {
        Clip {
            id: id.into(),
            media_id: "m1".into(),
            timeline_start: start,
            src_in,
            src_out,
            speed,
            transform: None,
            audio: ClipAudio {
                volume: 1.0,
                muted: false,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                gain_offset_db: 0.0,
                detached: false,
            },
            keyframes: None,
            adjust: None,
        }
    }

    fn track_of(id: &str, clips: Vec<Clip>) -> Track {
        Track {
            id: id.into(),
            kind: "video".into(),
            name: "V".into(),
            muted: false,
            clips,
            hidden: None,
        }
    }

    /// A hand-edited `.trt` may list a track's clips in ANY order — nothing on
    /// this side sorts them — so the length must come from the latest end across
    /// all of them, not from whichever clip happens to be written last.
    ///
    /// Every number here is distinct across the whole fixture (starts 10 / 0.25 /
    /// 4 / 1.5, durations 8 / 2 / 3 / 1, ends 18 / 2.25 / 7 / 2.5) so a
    /// duration read as a start, an end read as a duration, or a speed divisor
    /// dropped all produce a value this assertion rejects.
    #[test]
    fn duration_spans_every_clip_however_the_file_orders_them() {
        let longest = clip_at("longest", 10.0, 1.0, 5.0, 0.5); // dur 8.0 → end 18.0
        let shortest = clip_at("early", 0.25, 0.5, 2.5, 1.0); // dur 2.0 → end 2.25
        let middle = clip_at("middle", 4.0, 3.0, 9.0, 2.0); // dur 3.0 → end 7.0

        // The clip that reaches furthest is written FIRST, which is exactly the
        // shape `clips.last()` could not see.
        let out_of_order = track_of("t1", vec![longest, shortest, middle]);
        assert_eq!(
            out_of_order.clips.last().unwrap().end(),
            7.0,
            "fixture guard: the last-LISTED clip must not be the longest, or this proves nothing"
        );

        let tl = Timeline {
            fps: Rational { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            tracks: vec![
                out_of_order,
                track_of("t2", vec![clip_at("other", 1.5, 0.0, 1.0, 1.0)]), // end 2.5
                track_of("empty", vec![]),
            ],
            markers: vec![],
        };
        assert_eq!(
            tl.duration(),
            18.0,
            "the export must span the furthest clip on any track"
        );

        // An empty timeline is still 0, and a single track still answers from its
        // own clips — the fold's identity must not leak in as a floor.
        let empty = Timeline {
            fps: Rational { num: 30, den: 1 },
            width: 640,
            height: 360,
            tracks: vec![track_of("only", vec![])],
            markers: vec![],
        };
        assert_eq!(empty.duration(), 0.0);
    }

    #[test]
    fn rejects_newer_schema() {
        let json = serde_json::json!({"schema": 999});
        assert!(migrate(json).is_err());

        // A version that TRUNCATES to a known one must still be rejected. As a
        // u32 cast this is 1, and a v1 file is migrated and re-probed; the
        // check has to happen in u64.
        let truncating = 1u64 + (1u64 << 32);
        assert_eq!(truncating as u32, 1, "the cast this guards against");
        assert!(migrate(serde_json::json!({"schema": truncating})).is_err());
    }

    /// The version gate the load-time repair hangs off. A file already at the
    /// current version reports itself as such, so the repair does not re-run;
    /// an older one reports the version it actually arrived as, whatever the
    /// migration then stamps into the value.
    #[test]
    fn migrate_reports_the_version_the_file_arrived_as() {
        let current = migrate(serde_json::json!({"schema": CURRENT_SCHEMA})).unwrap();
        assert_eq!(current.from, CURRENT_SCHEMA);
        assert!(
            current.from >= ROTATION_REPAIR_SCHEMA,
            "a current-schema file must not qualify for the rotation re-probe"
        );

        let old = migrate(serde_json::json!({"schema": 1, "name": "keep me"})).unwrap();
        assert!(
            old.from < ROTATION_REPAIR_SCHEMA,
            "a pre-repair file must qualify: from={}",
            old.from
        );
        // The stamp is the only edit: everything else survives untouched.
        assert_eq!(old.value["schema"], CURRENT_SCHEMA);
        assert_eq!(old.value["name"], "keep me");

        assert!(migrate(serde_json::json!({"schema": 0})).is_err());
        assert!(migrate(serde_json::json!({"name": "no schema"})).is_err());
    }

    /// A damaged stroke never makes an image project unopenable: the typed
    /// parse only COUNTS a drawing's entries (the raw JSON the editor receives
    /// still has every one, and it drops the damaged ones with a notice). The
    /// fixture's numbers all differ — 6 entries listed in array chunks, 5
    /// chunks, 2 array chunks, 2 strokes that would pass — so a walker that
    /// counted chunks, counted only arrays, or skipped damaged entries cannot
    /// pass.
    #[test]
    fn a_damaged_stroke_never_refuses_the_project() {
        let media = serde_json::json!({
            "id": "d1", "kind": "image", "path": "Drawing", "size": 0, "mtimeMs": 0,
            "duration": 1, "width": 640, "height": 360, "hasAudio": false,
            "generator": { "type": "drawing", "chunks": [
                [
                    { "t": "pen", "c": "#1a2b3c", "w": 4, "o": 1, "p": "AAAAAAAAAAAAAAAA" },
                    { "t": "pen", "c": "#1a2b3c", "o": 1, "p": "AAAAAAAAAAAAAAAA" },
                    { "t": "pen", "c": "#1a2b3c", "w": "wide", "o": 1, "p": "AAAAAAAAAAAAAAAA" }
                ],
                "not a chunk",
                { "t": "pen", "w": 2 },
                null,
                [ 7, { "t": "erase", "w": 9, "p": "AAAAAAAAAAAAAAAA", "x": [[1, {"y": [2]}]] }, "eight" ]
            ]}
        });
        let strokes = |m: MediaRef| match m.generator {
            Some(Generator::Drawing { strokes }) => strokes,
            other => panic!("expected a drawing, got {other:?}"),
        };
        // Borrowed (how `load_project` and `save_project` parse: from the raw
        // value they keep) and owned (the migrate-then-parse path) alike.
        let borrowed = MediaRef::deserialize(&media).expect("a damaged drawing still parses");
        assert_eq!(strokes(borrowed), 6, "3 + 3 listed; the string, object and null chunks add nothing");
        let owned: MediaRef = serde_json::from_value(media.clone()).expect("owned parse too");
        assert_eq!(strokes(owned), 6);

        // Not an array at all, or empty: no strokes, still no refusal.
        let with_chunks = |chunks: Value| {
            let mut m = media.clone();
            m["generator"]["chunks"] = chunks;
            MediaRef::deserialize(&m).map(strokes)
        };
        for odd in [serde_json::json!({ "oops": [1, 2] }), serde_json::json!("x"), serde_json::json!(3), Value::Null] {
            assert_eq!(with_chunks(odd.clone()).expect("a non-array chunks still parses"), 0, "{odd}");
        }
        assert_eq!(with_chunks(serde_json::json!([])).unwrap(), 0);
        assert_eq!(with_chunks(serde_json::json!([[], [1], []])).unwrap(), 1);
        // Missing altogether is not a drawing the app wrote: refused, exactly
        // as before the count replaced the strokes.
        let mut bare = media.clone();
        bare["generator"].as_object_mut().unwrap().remove("chunks");
        let err = MediaRef::deserialize(&bare).unwrap_err().to_string();
        assert!(err.contains("missing field `chunks`"), "{err}");
    }

    /// The typed drawing holds a count, so writing it would empty the
    /// picture: any typed write of a drawing fails loudly instead.
    #[test]
    fn a_drawing_is_never_written_from_its_typed_form() {
        let m: MediaRef = serde_json::from_value(serde_json::json!({
            "id": "d1", "kind": "image", "path": "Drawing", "size": 0, "mtimeMs": 0,
            "duration": 0, "width": 64, "height": 48, "hasAudio": false,
            "generator": { "type": "drawing", "chunks": [[{ "t": "pen", "c": "#1a2b3c", "w": 4, "p": "AAAAAAAAAAAAAAAA" }]] }
        }))
        .unwrap();
        let err = serde_json::to_value(&m).unwrap_err().to_string();
        assert!(err.contains("never written from its typed form"), "{err}");
        // Every other generator still writes as it always did.
        let solid = Generator::Solid { color: "#336699".into() };
        assert_eq!(serde_json::to_value(&solid).unwrap(), serde_json::json!({ "type": "solid", "color": "#336699" }));
    }

    /// Schema 3 and `kind: "image"` come as a pair or not at all. Each refusal
    /// is told apart by its message, so a check that fired for the wrong reason
    /// (the "newer Taroting" range check, say) cannot pass for the right one.
    #[test]
    fn schema_and_image_kind_must_agree() {
        let msg = |v: Value| match migrate(v) {
            Err(AppError::BadInput(m)) => m,
            other => panic!("expected BadInput, got {other:?}"),
        };

        // The one valid image shape: accepted as-is, reporting schema 3, so the
        // rotation re-probe (keyed on `from`) never runs on an image project.
        let ok = migrate(serde_json::json!({"schema": 3, "kind": "image", "name": "pic"})).unwrap();
        assert_eq!(ok.from, IMAGE_SCHEMA);
        assert!(ok.from >= ROTATION_REPAIR_SCHEMA);
        assert_eq!(ok.value["schema"], 3, "an image project is never re-stamped");
        assert_eq!(ok.value["kind"], "image");

        assert!(msg(serde_json::json!({"schema": 3})).contains("only valid for an image project"));
        // A kind that is not the literal string "image" is not the image kind.
        assert!(msg(serde_json::json!({"schema": 3, "kind": "Image"}))
            .contains("only valid for an image project"));
        assert!(msg(serde_json::json!({"schema": 3, "kind": true}))
            .contains("only valid for an image project"));
        assert!(msg(serde_json::json!({"schema": 2, "kind": "image"})).contains("must be schema 3"));
        assert!(msg(serde_json::json!({"schema": 1, "kind": "image"})).contains("must be schema 3"));
        assert!(msg(serde_json::json!({"schema": 4, "kind": "image"})).contains("newer Taroting"));

        // Video files are exactly what they were: 2 passes, 1 is stamped 2.
        let v2 = migrate(serde_json::json!({"schema": 2})).unwrap();
        assert_eq!((v2.from, v2.value["schema"].as_u64()), (2, Some(2)));
        let v1 = migrate(serde_json::json!({"schema": 1})).unwrap();
        assert_eq!((v1.from, v1.value["schema"].as_u64()), (1, Some(2)));
    }

    /// The image-project fields are additive and optional: a video project
    /// written by this build carries none of them, so its bytes are what they
    /// were; a value in them that no build writes reads as absent rather than
    /// refusing the file; and an image project's fields travel with their TS
    /// names.
    #[test]
    fn image_fields_are_absent_from_video_projects_and_camel_case_in_image_ones() {
        let video_shape = || serde_json::json!({
            "schema": 2, "app": "taroting", "id": "p1", "name": "Cut",
            "createdAt": "2026-01-01T00:00:00Z", "modifiedAt": "2026-01-02T00:00:00Z",
            "media": [],
            "timeline": {
                "fps": {"num": 25, "den": 1}, "width": 1280, "height": 720,
                "tracks": [{"id": "t1", "kind": "video", "name": "Video", "muted": false, "clips": [{
                    "id": "c1", "mediaId": "m1", "timelineStart": 0.5, "srcIn": 1.0,
                    "srcOut": 3.0, "speed": 1.0,
                    "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                              "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                }]}]
            },
            "export": {}
        });
        let video = video_shape();
        let typed: ProjectFile = serde_json::from_value(video.clone()).unwrap();
        assert!(typed.kind.is_none() && typed.image.is_none());
        assert_eq!(serde_json::to_value(&typed).unwrap(), video, "no new key appears on a video project");

        let mut image = video;
        image["schema"] = 3.into();
        image["kind"] = "image".into();
        image["image"] = serde_json::json!({"background": "#fafafa"});
        image["timeline"]["tracks"][0]["hidden"] = true.into();
        image["timeline"]["tracks"][0]["clips"][0]["adjust"] =
            serde_json::json!({"exposure": 12.0, "hue": -40.0});
        image["media"] = serde_json::json!([{
            "id": "d1", "path": "Drawing", "size": 0, "mtimeMs": 0, "kind": "image",
            "duration": 0.0, "hasAudio": false, "width": 641, "height": 361,
            "generator": {"type": "drawing", "chunks": [[
                {"t": "pen", "c": "#1a2b3c", "w": 4.5, "o": 1.0, "p": "AAAAAAAAAAAAAAAA"},
                {"t": "erase", "w": 16.0, "p": "AAAAAAAAAAAAAAAA"},
                {"t": "arrow", "c": "#e5484d", "w": 3.0, "a": [10.0, 20.0], "b": [300.0, -5.0]}
            ]]}
        }]);
        let typed: ProjectFile = serde_json::from_value(image.clone()).unwrap();
        assert_eq!(typed.kind.as_deref(), Some("image"));
        assert_eq!(typed.timeline.tracks[0].hidden, Some(true));
        let adj = typed.timeline.tracks[0].clips[0].adjust.as_ref().unwrap();
        assert_eq!((adj.exposure, adj.hue, adj.contrast), (12.0, -40.0, 0.0));
        match &typed.media[0].generator {
            Some(Generator::Drawing { strokes }) => assert_eq!(*strokes, 3),
            other => panic!("expected a drawing, got {other:?}"),
        }
        // A value no build writes, in any of the new keys, reads as absent —
        // never as a parse failure that would refuse a file 0.8.1 opened.
        let mut odd = video_shape();
        odd["kind"] = 5.into();
        odd["timeline"]["tracks"][0]["hidden"] = "yes".into();
        odd["timeline"]["tracks"][0]["clips"][0]["adjust"] = 5.into();
        let parsed: ProjectFile = serde_json::from_value(odd).expect("odd values must not refuse the file");
        assert!(parsed.kind.is_none());
        assert!(parsed.timeline.tracks[0].hidden.is_none());
        assert!(parsed.timeline.tracks[0].clips[0].adjust.is_none());
        let mut named = video_shape();
        named["kind"] = "video".into();
        named["timeline"]["tracks"][0]["hidden"] = false.into();
        named["timeline"]["tracks"][0]["clips"][0]["adjust"] = serde_json::json!({ "hue": "warm" });
        let parsed: ProjectFile = serde_json::from_value(named).unwrap();
        assert!(parsed.kind.is_none(), "only the literal \"image\" is the kind");
        assert!(parsed.timeline.tracks[0].hidden.is_none());
        assert!(parsed.timeline.tracks[0].clips[0].adjust.is_none());

        // Written back (by anything that ever does) under the TS names. The
        // drawing is the exception: it is never written from its typed form
        // (`a_drawing_is_never_written_from_its_typed_form`), so the write is
        // checked without it.
        assert!(serde_json::to_value(&typed).is_err(), "a typed drawing must not write");
        let mut typed = typed;
        typed.media.clear();
        let out = serde_json::to_value(&typed).unwrap();
        assert_eq!(out["kind"], "image");
        assert_eq!(out["image"], image["image"]);
        assert_eq!(out["timeline"]["tracks"][0]["hidden"], true);
        assert_eq!(out["timeline"]["tracks"][0]["clips"][0]["adjust"]["hue"], -40.0);
    }
}
