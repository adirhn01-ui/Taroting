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
/// depends on none of it. The payload is now a few hundred bytes whatever the
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
    /// Whether the export will carry an audio stream: some clip is audible
    /// (the builder's `clip_audible`). A project with none is written with
    /// `-an`, so its estimate has no audio term. Absent means true — the
    /// estimate every caller got before the field existed.
    #[serde(default = "audio_unless_told_otherwise")]
    pub has_audio: bool,
}

fn audio_unless_told_otherwise() -> bool {
    true
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

/// `30` for a whole rate, `30000/1001` otherwise: the spelling `fps=` and
/// `color=...:r=` take.
pub fn format_rate((num, den): (u64, u64)) -> String {
    if den <= 1 {
        format!("{num}")
    } else {
        format!("{num}/{den}")
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
    /// `timeline_w/h` are the project canvas size. A named preset keeps the
    /// project aspect ratio and names its SHORT side, the way people say
    /// "1080p" of a phone video: the height of a landscape or square canvas,
    /// the width of a portrait one. (Taken as the height everywhere, it turned
    /// a 1080x1920 phone project exported at "1080p" into 606x1080.)
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
                let short = match name.as_str() {
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
                if th > tw {
                    // Portrait: the preset is the width. `short * th / tw`
                    // rather than `short / aspect`: the product of two whole
                    // numbers is exact, so a height that comes out whole is
                    // whole here too. Dividing by the already-rounded ratio can
                    // land a hair under it (a 432x612 canvas at 720p:
                    // 720 / (432/612) = 1019.9999999999999, not 1020), and the
                    // round-down would then take 2 px off.
                    return (round_down_even(short), round_down_even(short * th / tw));
                }
                // Landscape and square: the preset is the height, computed
                // exactly as it always was.
                let height = short;
                let width = aspect * height;
                (round_down_even(width), round_down_even(height))
            }
        }
    }

    /// The output rate as an exact rational `(num, den)` with `den >= 1`
    /// (`format_rate` spells it for `fps=` and `r=`). `"original"` mirrors the
    /// timeline rational (e.g. NTSC `30000/1001`); a custom value becomes
    /// `N/1000` for fractional rates or `N/1` for integers. The builder places
    /// every frame boundary with THIS pair: a float parsed back out of
    /// "30000/1001" is not the rate ffmpeg runs at, and frame indices taken
    /// from it drift off ffmpeg's grid.
    ///
    /// A Custom value outside the range `build` accepts still maps to
    /// something here (a negative becomes 0); `build` refuses it before the
    /// pair is ever used.
    pub fn output_rate(&self, timeline: &Timeline) -> (u64, u64) {
        match &self.fps {
            FpsPreset::Original(_) => {
                let r = timeline.fps;
                (u64::from(r.num), u64::from(r.den.max(1)))
            }
            FpsPreset::Custom(f) => {
                if (f.fract()).abs() < 1e-9 {
                    (f.round().max(0.0) as u64, 1)
                } else {
                    // Represent to 3 decimal places as an exact rational.
                    ((f * 1000.0).round().max(0.0) as u64, 1000)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(resolution: ResolutionPreset) -> ExportPreset {
        ExportPreset {
            format: "mp4".into(),
            vcodec: "h264".into(),
            resolution,
            fps: FpsPreset::Original("original".into()),
            video_bitrate: BitratePreset::Auto(AutoTag::Auto),
            audio_bitrate: BitratePreset::Auto(AutoTag::Auto),
            use_hardware: false,
        }
    }

    fn named(name: &str) -> ExportPreset {
        at(ResolutionPreset::Named(name.into()))
    }

    const NAMED: [&str; 6] = ["4320p", "2160p", "1440p", "1080p", "720p", "480p"];

    /// A named preset is the WIDTH of a portrait canvas, and the height follows
    /// its aspect. Each row's old answer (the preset as the height) is in the
    /// comment: every one of them differs from the new answer on both axes.
    #[test]
    fn a_named_preset_is_the_width_of_a_portrait_canvas() {
        for (canvas, name, want) in [
            // A phone clip's own canvas at "1080p": was 606x1080.
            ((1080, 1920), "1080p", (1080, 1920)),
            // was 404x720
            ((1080, 1920), "720p", (720, 1280)),
            // 4:5: was 576x720
            ((1080, 1350), "720p", (720, 900)),
            // was 1214x2160
            ((1080, 1920), "2160p", (2160, 3840)),
            // 480 * 1334 / 750 = 853.76: rounded down to even. Was 268x480.
            ((750, 1334), "480p", (480, 852)),
            // The float trap: 720 / (432/612) is 1019.9999999999999, which
            // would round down to 1018. Was 508x720.
            ((432, 612), "720p", (720, 1020)),
            // An upscale far past the canvas. Was 1996x4320.
            ((1170, 2532), "4320p", (4320, 9348)),
        ] {
            assert_eq!(
                named(name).output_dims(canvas.0, canvas.1),
                want,
                "{}x{} at {name}",
                canvas.0,
                canvas.1
            );
        }
    }

    /// Landscape and square canvases keep the preset as the HEIGHT, exactly as
    /// before: the old formula, copied here as the oracle, must agree with
    /// `output_dims` on every named preset over a grid of canvases wider than
    /// tall or square (including the degenerate sizes `max(2)` lifts), so no
    /// existing landscape export changes by a pixel.
    #[test]
    fn landscape_and_square_canvases_are_unchanged() {
        fn before(name: &str, timeline_w: u32, timeline_h: u32) -> (u32, u32) {
            let tw = timeline_w.max(2) as f64;
            let th = timeline_h.max(2) as f64;
            let height = match name {
                "4320p" => 4320.0,
                "2160p" => 2160.0,
                "1440p" => 1440.0,
                "1080p" => 1080.0,
                "720p" => 720.0,
                _ => 480.0,
            };
            (round_down_even(tw / th * height), round_down_even(height))
        }
        let mut checked = 0u32;
        let mut canvases: Vec<(u32, u32)> = vec![
            (1920, 1080), (1280, 720), (3840, 2160), (1080, 1080), (1922, 806),
            (1918, 802), (1276, 718), (854, 482), (398, 398), (0, 0), (1, 0), (3, 1),
        ];
        for w in (0..=4100u32).step_by(17) {
            for h in (0..=w).step_by(13) {
                canvases.push((w, h));
            }
        }
        for (w, h) in canvases {
            assert!(w.max(2) >= h.max(2), "{w}x{h} is not landscape or square");
            for name in NAMED {
                assert_eq!(named(name).output_dims(w, h), before(name, w, h), "{w}x{h} at {name}");
                checked += 1;
            }
        }
        assert!(checked > 100_000, "only {checked} landscape checks");
        // The shipped goldens by value, so a change to the oracle cannot
        // carry both sides along with it.
        assert_eq!(named("720p").output_dims(1920, 1080), (1280, 720));
        assert_eq!(named("2160p").output_dims(1920, 1080), (3840, 2160));
        assert_eq!(named("480p").output_dims(1280, 1024), (600, 480));
        assert_eq!(named("720p").output_dims(1080, 1080), (720, 720));
    }

    /// "Original", an unknown name and a Custom size never read the preset
    /// table, so orientation cannot touch them.
    #[test]
    fn original_unknown_and_custom_ignore_orientation() {
        for (w, h) in [(1080u32, 1920u32), (1920, 1080), (751, 1335)] {
            let canvas = (round_down_even(w as f64), round_down_even(h as f64));
            assert_eq!(named("original").output_dims(w, h), canvas);
            assert_eq!(named("5k").output_dims(w, h), canvas);
            assert_eq!(
                at(ResolutionPreset::Custom { w: 641, h: 363 }).output_dims(w, h),
                (640, 362)
            );
        }
    }
}
