//! Writing an image project's output — an export the user named, the Home card
//! thumbnail, a pasted image — through one chunked save protocol.
//!
//! **The protocol.** `image_save_begin` (JSON: the destination, the format, the
//! declared byte count) opens `<target>.part` and returns a token plus the
//! final path. `image_save_chunk` carries the bytes as a RAW request body (the
//! token in the `x-taroting-save` header, because the body IS the bytes), any
//! number of times. `image_save_commit` checks the declared total and the
//! format's magic bytes, syncs, and renames the `.part` over the target;
//! `image_save_abort` removes the `.part` and forgets the token. Any failure
//! removes the `.part` too, so nothing half-written is ever left beside the
//! user's files.
//!
//! **Why not `atomic_write`.** It keeps the previous file as a `.bak`, which is
//! right for a project and wrong for an exported picture: the user would find a
//! stray copy of their old export next to the new one. `.part` + rename gives
//! the same all-or-nothing replace without it.
//!
//! **Why the path travels only in the begin call.** It is the one input that
//! decides where bytes land, so it is checked once, as JSON, against the rules
//! below — an absolute path whose extension matches the format, never a source
//! file of the project (`path_identity`, not case folding: the filesystem
//! decides) — and every later call can only name a token.
//!
//! **Zero cost when unused.** The managed state is an empty map: no thread, no
//! timer, nothing resident until a save begins.
//!
//! The wire shapes below are the frozen part (src/core/ipc.ts mirrors them, and
//! the tests at the bottom pin both directions). Tauri `State` parameters are
//! not part of the wire.

// Signatures only until the protocol is implemented: the pending-save shape
// and the limits are declared, nothing reads them yet. This allow goes with the
// implementation, so dead code in the finished module is reported again.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// Where a save lands. `kind`-tagged with camelCase fields, exactly as
/// `ImageSaveDest` in src/core/ipc.ts sends it. `rename_all_fields` is not
/// optional here: `rename_all` on an enum renames only the variant TAGS, so
/// `project_path` would silently stay snake_case on the wire and every
/// thumbnail save would fail to deserialize (the PlaybackPlan `jobId` bug).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ImageSaveDest {
    /// An export the user named. `sources` = every non-generator media path of
    /// the IN-MEMORY project, so a layer added since the last save is covered:
    /// the target may be none of them.
    #[serde(rename = "user")]
    User { path: String, sources: Vec<String> },
    /// The Home card of an image project: a rendered JPEG in the cache's
    /// thumbnail dir, named from `project_id` (never from a path the frontend
    /// chose). Recorded on the project's recents entry unless it is temporary.
    #[serde(rename = "projectThumb")]
    ProjectThumb { project_path: String, project_id: String },
    /// A pasted image, written where the user can see and relink it
    /// (Documents\Taroting\Pasted images) under a name the backend picks.
    #[serde(rename = "pasted")]
    Pasted { project_name: String },
}

/// The output format, as TS `ImageExportFormat` names it.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

/// A save's token and the path it lands at (begin) or landed at (commit).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBegun {
    pub token: u64,
    pub path: String,
}

/// Largest file one save may declare.
pub const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
/// Largest Home card thumbnail.
pub const MAX_THUMB_BYTES: u64 = 1024 * 1024;
/// Largest single chunk body.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// Saves that may be open at once; a begin beyond this is refused.
pub const MAX_PENDING: usize = 4;

/// The open saves. Managed as `Arc<ImageSaves>` (main.rs).
#[derive(Default)]
pub struct ImageSaves {
    /// Open saves by token; empty whenever nothing is being saved.
    pending: Mutex<HashMap<u64, Pending>>,
    /// The next token to hand out; never reused within a run.
    next: AtomicU64,
}

/// One open save.
struct Pending {
    /// The open `.part` file.
    file: std::fs::File,
    part: PathBuf,
    target: PathBuf,
    format: ImageFormat,
    /// The byte count begin declared; commit requires exactly this many.
    declared: u64,
    written: u64,
    /// The first bytes written, kept for the magic check at commit.
    head: [u8; 12],
    head_len: usize,
    /// The recents entry a ProjectThumb commit stamps (None for a temp project
    /// and for every other destination).
    thumb_recent: Option<String>,
}

fn not_implemented() -> AppError {
    AppError::BadInput("not implemented".into())
}

/// Open a save: validate the destination, open `<target>.part`, return the
/// token and the final path.
#[tauri::command]
pub async fn image_save_begin(
    state: tauri::State<'_, Arc<ImageSaves>>,
    dest: ImageSaveDest,
    format: ImageFormat,
    total_bytes: u64,
) -> Result<SaveBegun> {
    let _ = (&state, &dest, format, total_bytes);
    Err(not_implemented())
}

/// Append one chunk. The body must be `InvokeBody::Raw` (a JSON body is
/// refused); the token rides in the `x-taroting-save` header as a decimal u64.
#[tauri::command]
pub async fn image_save_chunk(
    state: tauri::State<'_, Arc<ImageSaves>>,
    request: tauri::ipc::Request<'_>,
) -> Result<()> {
    let _ = (&state, &request);
    Err(not_implemented())
}

/// Verify (declared total, magic bytes), sync, and move the `.part` into
/// place. Returns the final path.
#[tauri::command]
pub async fn image_save_commit(
    state: tauri::State<'_, Arc<ImageSaves>>,
    token: u64,
) -> Result<SaveBegun> {
    let _ = (&state, token);
    Err(not_implemented())
}

/// Drop an open save and its `.part`. Idempotent.
#[tauri::command]
pub async fn image_save_abort(state: tauri::State<'_, Arc<ImageSaves>>, token: u64) -> Result<()> {
    let _ = (&state, token);
    Err(not_implemented())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// What the webview RECEIVES: `{ token, path }`, the shape ipc.ts types
    /// `imageSaveBegin` / `imageSaveCommit` as.
    #[test]
    fn save_begun_reaches_the_webview_in_camel_case() {
        let v = serde_json::to_value(SaveBegun { token: 41, path: r"C:\Out\pic (edited).png".into() })
            .expect("serializes");
        assert_eq!(v, json!({ "token": 41, "path": r"C:\Out\pic (edited).png" }));
    }

    /// What the webview SENDS: the three `ImageSaveDest` shapes exactly as the
    /// ipc.ts union writes them, field for field. The snake_case spelling of a
    /// struct-variant field must NOT deserialize — that is what proves
    /// `rename_all_fields` is on (with only `rename_all`, the snake_case one
    /// would be the one that parses and the camelCase one would fail).
    #[test]
    fn destinations_arrive_from_the_webview_in_camel_case() {
        let dest = |v: serde_json::Value| serde_json::from_value::<ImageSaveDest>(v);

        match dest(json!({ "kind": "user", "path": r"C:\Out\a.png", "sources": [r"C:\In\a.jpg", r"D:\b.webp"] }))
            .expect("user")
        {
            ImageSaveDest::User { path, sources } => {
                assert_eq!(path, r"C:\Out\a.png");
                assert_eq!(sources, [r"C:\In\a.jpg", r"D:\b.webp"]);
            }
            other => panic!("expected User, got {other:?}"),
        }
        match dest(json!({ "kind": "projectThumb", "projectPath": r"C:\P\Pic.trt", "projectId": "a1b2-c3" }))
            .expect("projectThumb")
        {
            ImageSaveDest::ProjectThumb { project_path, project_id } => {
                assert_eq!(project_path, r"C:\P\Pic.trt");
                assert_eq!(project_id, "a1b2-c3");
            }
            other => panic!("expected ProjectThumb, got {other:?}"),
        }
        match dest(json!({ "kind": "pasted", "projectName": "Holiday card" })).expect("pasted") {
            ImageSaveDest::Pasted { project_name } => assert_eq!(project_name, "Holiday card"),
            other => panic!("expected Pasted, got {other:?}"),
        }

        assert!(dest(json!({ "kind": "projectThumb", "project_path": "p", "project_id": "i" })).is_err());
        assert!(dest(json!({ "kind": "pasted", "project_name": "n" })).is_err());
        assert!(dest(json!({ "kind": "User", "path": "p", "sources": [] })).is_err(), "tags are exact");
        assert!(dest(json!({ "path": "p", "sources": [] })).is_err(), "the tag is required");
    }

    /// `ImageExportFormat` in TS: exactly "png" | "jpeg" | "webp".
    #[test]
    fn formats_arrive_by_their_ts_names_only() {
        let fmt = |s: &str| serde_json::from_value::<ImageFormat>(json!(s));
        assert_eq!(fmt("png").unwrap(), ImageFormat::Png);
        assert_eq!(fmt("jpeg").unwrap(), ImageFormat::Jpeg);
        assert_eq!(fmt("webp").unwrap(), ImageFormat::Webp);
        for odd in ["jpg", "PNG", "Webp", "gif", ""] {
            assert!(fmt(odd).is_err(), "{odd}");
        }
    }
}
