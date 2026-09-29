//! The media-extension table, read from the SAME file the frontend imports
//! (`src/core/media-extensions.json`), so the two sides can never disagree
//! about what counts as media: what the picker offers, what drop and
//! open-with accept, and what the viewer steps through in a folder.
//!
//! SIGNATURE STUB: until the implementation lands, the lookups answer as the
//! documented degraded state (an empty table, every lookup `None`). The
//! `allow(dead_code)` belongs to the stub and goes with it.
#![allow(dead_code)]

/// A media family, one per key of media-extensions.json.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Video,
    Gif,
    Image,
    Audio,
}

/// What the viewer steps through together: video + gif + image, or audio alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepFamily {
    Visual,
    Audio,
}

/// `ext` without the dot, compared ASCII-case-insensitively. The table is parsed ONCE
/// (std::sync::OnceLock) from include_str!("../../../src/core/media-extensions.json"). A parse
/// failure yields an EMPTY table (every lookup None), never a panic (release is panic = "abort").
pub fn family_of_ext(ext: &str) -> Option<Family> {
    let _ = ext;
    None
}

/// Audio steps only through audio; everything with a picture steps together.
pub fn step_family(f: Family) -> StepFamily {
    match f {
        Family::Audio => StepFamily::Audio,
        Family::Video | Family::Gif | Family::Image => StepFamily::Visual,
    }
}

/// Every `(extension, family)` in the table, lowercase, in file order.
pub fn all() -> &'static [(String, Family)] {
    &[]
}
