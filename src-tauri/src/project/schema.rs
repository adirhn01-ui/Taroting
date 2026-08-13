//! Typed mirror of the .trt project schema (TypeScript is the source of
//! truth) plus the migration chain for older schema versions.
//!
//! serde ignores unknown fields by default — newer files opened by older
//! builds degrade gracefully instead of failing to parse.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

pub const CURRENT_SCHEMA: u32 = 2;

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
}

/// A synthetic media source (solid color or styled text). Mirrors the TS
/// `Generator` union: a `type`-tagged, camelCase enum.
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
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .filter_map(|t| t.clips.last().map(|c| c.end()))
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
    if version > CURRENT_SCHEMA as u64 {
        return Err(AppError::BadInput(format!(
            "project was created by a newer Taroting (schema {version}); please update the app"
        )));
    }
    let from = version as u32;
    match from {
        CURRENT_SCHEMA => {}
        // 1 → 2: nothing in the JSON changes, because nothing in the JSON CAN.
        // The stamp is the entire migration — see `ROTATION_REPAIR_SCHEMA` for
        // what it records and who acts on it.
        1 => {
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
}
