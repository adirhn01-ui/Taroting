//! Typed mirror of the .trt project schema (TypeScript is the source of
//! truth) plus the migration chain for older schema versions.
//!
//! serde ignores unknown fields by default — newer files opened by older
//! builds degrade gracefully instead of failing to parse.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

pub const CURRENT_SCHEMA: u32 = 1;

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
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub timeline_start: f64,
    pub src_in: f64,
    pub src_out: f64,
    pub speed: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<ClipTransform>,
    pub audio: ClipAudio,
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
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub fps: Rational,
    pub width: u32,
    pub height: u32,
    pub tracks: Vec<Track>,
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

/// Migrate a raw project JSON value to the current schema version.
pub fn migrate(value: Value) -> Result<Value> {
    let version = value
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::BadInput("not a Taroting project (missing schema)".into()))?;
    match version as u32 {
        CURRENT_SCHEMA => Ok(value),
        v if v > CURRENT_SCHEMA => Err(AppError::BadInput(format!(
            "project was created by a newer Taroting (schema {v}); please update the app"
        ))),
        v => Err(AppError::BadInput(format!("unknown project schema {v}"))),
    }
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
            }],
            "timeline": {
                "fps": {"num": 30, "den": 1},
                "width": 1920,
                "height": 1080,
                "tracks": [{
                    "id": "t1", "kind": "video", "name": "Video", "muted": false,
                    "clips": [{
                        "id": "c1", "mediaId": "m1",
                        "timelineStart": 0.0, "srcIn": 0.0, "srcOut": 60.0, "speed": 1.0,
                        "audio": {"volume": 1.0, "muted": false, "fadeInSec": 0.0,
                                   "fadeOutSec": 0.0, "gainOffsetDb": 0.0, "detached": false}
                    }]
                }]
            },
            "export": {"format": "mp4"},
            "unknownTopLevel": 42
        });
        let migrated = migrate(json).unwrap();
        let parsed: ProjectFile = serde_json::from_value(migrated).unwrap();
        assert_eq!(parsed.name, "Test");
        assert_eq!(parsed.timeline.duration(), 60.0);
        // serialize back — unknown fields are dropped, knowns survive
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out["media"][0]["mtimeMs"], 5);
        assert_eq!(out["timeline"]["tracks"][0]["clips"][0]["srcOut"], 60.0);
    }

    #[test]
    fn rejects_newer_schema() {
        let json = serde_json::json!({"schema": 999});
        assert!(migrate(json).is_err());
    }
}
