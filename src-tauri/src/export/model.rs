//! Export request types. `ExportSpec` is the single payload the frontend
//! sends; the builder turns it into an ffmpeg argv vector. All enums are
//! `#[serde(untagged)]` so the JSON matches the TypeScript `ExportPreset`
//! union types exactly (e.g. `"1080p"` | `{ "w": 1920, "h": 1080 }`).

use serde::{Deserialize, Serialize};

use crate::project::schema::{MediaRef, Timeline};

/// The full export request from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub media: Vec<MediaRef>,
    pub timeline: Timeline,
    pub preset: ExportPreset,
    pub out_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    /// mp4 | mov | webm | avi | gif
    pub format: String,
    /// h264 | hevc | av1
    pub vcodec: String,
    pub resolution: ResolutionPreset,
    pub fps: FpsPreset,
    pub video_bitrate: BitratePreset,
    pub audio_bitrate: BitratePreset,
    pub use_hardware: bool,
}

/// `"original" | "4320p" | … | "480p"` or `{ "w": .., "h": .. }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResolutionPreset {
    Named(String),
    Custom { w: u32, h: u32 },
}

/// `"original"` or a numeric fps like `59.94`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FpsPreset {
    Original(String),
    Custom(f64),
}

/// `"auto"` (quality/CRF mode) or a target kbps.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BitratePreset {
    Auto(AutoTag),
    Kbps(u64),
}

/// The literal string `"auto"`. Kept as its own type so the untagged enum
/// can distinguish it from a number without ambiguity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum AutoTag {
    #[serde(rename = "auto")]
    Auto,
}

impl BitratePreset {
    pub fn kbps(&self) -> Option<u64> {
        match self {
            BitratePreset::Kbps(k) => Some(*k),
            BitratePreset::Auto(_) => None,
        }
    }
}

fn round_down_even(v: f64) -> u32 {
    let n = v.floor().max(2.0) as u32;
    n - (n % 2)
}

impl ExportPreset {
    /// Resolve the output video dimensions (already rounded DOWN to even).
    /// `timeline_w/h` are the project canvas size; named presets keep the
    /// project aspect ratio at the requested height.
    pub fn output_dims(&self, timeline_w: u32, timeline_h: u32) -> (u32, u32) {
        let tw = timeline_w.max(2) as f64;
        let th = timeline_h.max(2) as f64;
        let aspect = tw / th;
        match &self.resolution {
            ResolutionPreset::Custom { w, h } => (
                round_down_even((*w).max(2) as f64),
                round_down_even((*h).max(2) as f64),
            ),
            ResolutionPreset::Named(name) => {
                let height = match name.as_str() {
                    "original" => return (round_down_even(tw), round_down_even(th)),
                    "4320p" => 4320.0,
                    "2160p" => 2160.0,
                    "1440p" => 1440.0,
                    "1080p" => 1080.0,
                    "720p" => 720.0,
                    "480p" => 480.0,
                    // Unknown named preset falls back to original dimensions.
                    _ => return (round_down_even(tw), round_down_even(th)),
                };
                let width = aspect * height;
                (round_down_even(width), round_down_even(height))
            }
        }
    }

    /// Resolve output fps as a rational string suitable for `fps=` and
    /// `-r`. `"original"` mirrors the timeline rational (e.g. NTSC
    /// `30000/1001`); a custom value becomes `N/1000` for fractional rates
    /// or `N` for integers.
    pub fn output_fps(&self, timeline: &Timeline) -> String {
        match &self.fps {
            FpsPreset::Original(_) => {
                let r = timeline.fps;
                if r.den <= 1 {
                    format!("{}", r.num)
                } else {
                    format!("{}/{}", r.num, r.den)
                }
            }
            FpsPreset::Custom(f) => {
                if (f.fract()).abs() < 1e-9 {
                    format!("{}", f.round() as i64)
                } else {
                    // Represent to 3 decimal places as an exact rational.
                    let milli = (f * 1000.0).round() as i64;
                    format!("{milli}/1000")
                }
            }
        }
    }

    /// Numeric fps used by the size estimator.
    pub fn fps_value(&self, timeline: &Timeline) -> f64 {
        match &self.fps {
            FpsPreset::Original(_) => timeline.fps.num as f64 / timeline.fps.den.max(1) as f64,
            FpsPreset::Custom(f) => *f,
        }
    }
}
