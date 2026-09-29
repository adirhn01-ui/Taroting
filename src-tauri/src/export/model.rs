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

/// The input to `estimate_export` — everything the size estimate reads, and
/// nothing else.
///
/// This used to be a whole `ExportSpec`: the entire media list plus every clip
/// on every track, for a command that touches four scalars and the preset. The
/// dialog re-estimates on a 300 ms debounce after every control change, so a
/// 1600-clip project was serializing 783 KB of JSON on the UI thread (1.5 ms of
/// `JSON.stringify`) and parsing all of it here, to compute a number that
/// depends on none of it. The payload is now a fixed 213 bytes whatever the
/// project holds, so this command's parse is constant too.
///
/// `durationSec` is the timeline duration (latest clip end across all tracks)
/// and `fps` is the timeline's frame rate as a plain number — both derived on
/// the frontend by the same arithmetic `Timeline::duration()` and
/// `Rational` do here, so the answer is byte-identical either way. The
/// `#[cfg(test)]` adapter in `estimate.rs` keeps the full-spec path exercised
/// so that equivalence stays proven.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateInput {
    pub duration_sec: f64,
    /// Project canvas width/height (the `output_dims` inputs).
    pub width: u32,
    pub height: u32,
    /// Timeline frame rate, already reduced to `num / den`.
    pub fps: f64,
    pub preset: ExportPreset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    /// mp4 | mov | webm | avi | gif — anything else is refused by `container()`.
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

/// The containers the exporter writes: the ONE whitelist every format decision
/// in the builder is taken from.
///
/// `format` stays a plain `String` on the wire (the TypeScript union is the
/// contract, and the project persists it), so nothing stops a crafted `.trt` —
/// or a project saved by a newer build that knows a format this one does not —
/// from carrying any string at all. The muxer choice used to end in
/// `_ => -f mp4`, which quietly wrote MP4 bytes under whatever extension the user
/// picked: a file named `.mkv` that is not one. Parsing into this enum up front
/// makes an unknown format an error before anything is spawned, and every later
/// `match` is exhaustive, so there is no fallback arm left to land in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mp4,
    Mov,
    Webm,
    Avi,
    Gif,
}

impl Container {
    /// Exact, case-sensitive: the frontend only ever sends these spellings, so
    /// anything else ("MP4", "mp4 ") was not written by it.
    pub fn from_format(format: &str) -> Option<Self> {
        match format {
            "mp4" => Some(Self::Mp4),
            "mov" => Some(Self::Mov),
            "webm" => Some(Self::Webm),
            "avi" => Some(Self::Avi),
            "gif" => Some(Self::Gif),
            _ => None,
        }
    }

    /// ISOBMFF (the mp4/mov family): the containers where `-movflags` and the
    /// `hvc1` sample-entry tag mean anything.
    pub fn is_isobmff(self) -> bool {
        matches!(self, Self::Mp4 | Self::Mov)
    }
}

fn round_down_even(v: f64) -> u32 {
    let n = v.floor().max(2.0) as u32;
    n - (n % 2)
}

impl ExportPreset {
    /// The whitelisted container for `format`, or `None` for a format this
    /// build does not write.
    pub fn container(&self) -> Option<Container> {
        Container::from_format(&self.format)
    }

    /// Whether `vcodec` is one of the codecs this build writes. Exact and
    /// case-sensitive, like `Container::from_format`: the frontend only sends
    /// these three spellings, and the encoder lookups downstream default an
    /// unknown one to libx264, so it has to be stopped before them.
    pub fn vcodec_is_known(&self) -> bool {
        matches!(self.vcodec.as_str(), "h264" | "hevc" | "av1")
    }

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

    /// Numeric output fps used by the size estimator, given the timeline's own
    /// frame rate as a number. Takes the scalar rather than a `&Timeline` so the
    /// estimator can answer from `EstimateInput` without a project attached.
    pub fn fps_value(&self, timeline_fps: f64) -> f64 {
        match &self.fps {
            FpsPreset::Original(_) => timeline_fps,
            FpsPreset::Custom(f) => *f,
        }
    }
}
