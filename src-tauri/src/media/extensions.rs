//! The media-extension table, read from the SAME file the frontend imports
//! (`src/core/media-extensions.json`), so the two sides can never disagree
//! about what counts as media: what the picker offers, what drop and
//! open-with accept, and what the viewer steps through in a folder.
//!
//! Parsed once, on the first lookup — which is the first `list_siblings`,
//! never app start: nothing on the boot path asks what a file is.

use std::collections::BTreeMap;
use std::sync::OnceLock;

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

const TABLE_JSON: &str = include_str!("../../../src/core/media-extensions.json");

/// The family keys in the precedence `mediaFamilyOf` (src/core/types.ts)
/// checks them in. The JSON forbids an extension in two families, but should
/// one ever slip in, both sides must resolve it to the SAME family — so the
/// table is built in this order and the first family to claim an extension
/// keeps it. Iterating the parsed map instead would go alphabetically
/// (audio first) and quietly disagree with the frontend.
const KEYS: [(&str, Family); 4] = [
    ("video", Family::Video),
    ("gif", Family::Gif),
    ("image", Family::Image),
    ("audio", Family::Audio),
];

/// Build the table from `json`. Unknown keys are ignored; entries are
/// ASCII-lowercased, empties and repeats dropped. Anything unparseable yields
/// an EMPTY table: every lookup then answers "not media", which refuses a
/// file rather than killing the process (release is `panic = "abort"`).
fn parse(json: &str) -> Vec<(String, Family)> {
    let Ok(map) = serde_json::from_str::<BTreeMap<String, Vec<String>>>(json) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Family)> = Vec::new();
    for (key, family) in KEYS {
        for ext in map.get(key).into_iter().flatten() {
            let ext = ext.to_ascii_lowercase();
            if !ext.is_empty() && !out.iter().any(|(e, _)| *e == ext) {
                out.push((ext, family));
            }
        }
    }
    out
}

/// `ext` without the dot, compared ASCII-case-insensitively. The table is parsed ONCE
/// (std::sync::OnceLock) from include_str!("../../../src/core/media-extensions.json"). A parse
/// failure yields an EMPTY table (every lookup None), never a panic (release is panic = "abort").
///
/// ASCII folding only, like the frontend's `fileExt`: a full-Unicode fold
/// would let a lookalike such as "ＭＰ４" pass as media on this side alone.
pub fn family_of_ext(ext: &str) -> Option<Family> {
    all()
        .iter()
        .find(|(e, _)| e.eq_ignore_ascii_case(ext))
        .map(|(_, f)| *f)
}

/// Audio steps only through audio; everything with a picture steps together.
pub fn step_family(f: Family) -> StepFamily {
    match f {
        Family::Audio => StepFamily::Audio,
        Family::Video | Family::Gif | Family::Image => StepFamily::Visual,
    }
}

/// Every `(extension, family)` in the table, lowercase: family by family in
/// `mediaFamilyOf`'s order (video, gif, image, audio), each family's
/// extensions in file order.
pub fn all() -> &'static [(String, Family)] {
    static TABLE: OnceLock<Vec<(String, Family)>> = OnceLock::new();
    TABLE.get_or_init(|| parse(TABLE_JSON))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_json_parses_and_every_family_is_non_empty() {
        let table = all();
        for (key, family) in KEYS {
            assert!(
                table.iter().any(|(_, f)| *f == family),
                "the shipped table has no {key} extensions — did it fail to parse?"
            );
        }
        // Lowercase, dot-free and unique: the shape both sides rely on.
        for (i, (ext, _)) in table.iter().enumerate() {
            assert_eq!(*ext, ext.to_ascii_lowercase(), "{ext} is not lowercase");
            assert!(!ext.contains('.'), "{ext} carries a dot");
            assert!(
                table[..i].iter().all(|(e, _)| e != ext),
                "{ext} listed twice"
            );
        }
        // The project file is never media, whatever the table grows into.
        assert!(table.iter().all(|(e, _)| e != "trt"));
    }

    #[test]
    fn family_lookup_is_ascii_case_insensitive() {
        // Each row lands in a different family, so an off-by-one family
        // mapping cannot pass on a coincidence.
        assert_eq!(family_of_ext("JPG"), Some(Family::Image));
        assert_eq!(family_of_ext("Mp4"), Some(Family::Video));
        assert_eq!(family_of_ext("gIF"), Some(Family::Gif));
        assert_eq!(family_of_ext("FLAC"), Some(Family::Audio));
        assert_eq!(family_of_ext("trt"), None);
        assert_eq!(family_of_ext(""), None);
        assert_eq!(
            family_of_ext(".mp4"),
            None,
            "the dot is the caller's to strip"
        );
        // Fullwidth "ＭＰ４" folds to "mp4" under Unicode rules; ASCII must not.
        assert_eq!(family_of_ext("\u{FF2D}\u{FF30}\u{FF14}"), None);
        assert_eq!(step_family(Family::Gif), StepFamily::Visual);
        assert_eq!(step_family(Family::Image), StepFamily::Visual);
        assert_eq!(step_family(Family::Audio), StepFamily::Audio);
    }

    #[test]
    fn a_broken_table_degrades_to_empty_and_keeps_first_claim() {
        assert!(parse("not json").is_empty());
        assert!(
            parse(r#"{"video": "mp4"}"#).is_empty(),
            "wrong shape is a parse failure"
        );
        assert!(parse("").is_empty());
        // Unknown keys ignored; entries folded; the first family in
        // mediaFamilyOf's order keeps a repeated extension, even when the
        // JSON lists the losing family first.
        let t = parse(
            r#"{"audio": ["OGG", "", "ogg"], "stickers": ["apng"], "video": ["ogg", "MKV"]}"#,
        );
        assert_eq!(
            t,
            vec![
                ("ogg".to_string(), Family::Video),
                ("mkv".to_string(), Family::Video)
            ]
        );
    }
}
