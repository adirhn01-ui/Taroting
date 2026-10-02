//! The gate a media path passes before it reaches a sidecar's `-i`.
//!
//! Every `MediaRef.path` the sidecars decode comes out of a `.trt`, and a
//! `.trt` is the file people share — so it is untrusted text. The bundled
//! ffmpeg has its network protocols built in (http, https, tcp, udp, rtmp,
//! ftp, sftp, srt), and handed `https://host/x.mp4` as an input it simply
//! connects: opening a crafted project would contact any server it names
//! before the relink dialog had even appeared, and feed whatever came back to
//! the demuxers. A `\\.\pipe\` name would wedge a lane forever.
//!
//! Two layers, used together at each sink:
//! - [`source_file`]: the path names an existing FILE on a drive or a share,
//!   spelled in full. Checked before any argv is built.
//! - [`INPUT_PROTOCOL_ARGS`]: placed right before each file `-i`, so even a
//!   path that slipped past the check can only ever be opened as a file.
//!
//! Network shares (`\\server\share\clip.mp4`) stay allowed: media on a NAS is
//! ordinary, and to ffmpeg a share is a file like any other.

use std::path::Path;

use crate::error::{AppError, Result};

/// The input option that limits ffmpeg to plain files for the input after it.
/// Goes immediately before each file `-i` (not before a lavfi `color` or
/// `anullsrc` input, which opens no protocol at all).
// Not referenced yet: the media and export argv builders adopt it in this
// same release. Drop the allow when they do.
#[allow(dead_code)]
pub const INPUT_PROTOCOL_ARGS: [&str; 2] = ["-protocol_whitelist", "file"];

/// `path` as a `Path`, when it names an existing file a sidecar may open:
/// spelled in full, on a drive or a share, not a device, and a file rather
/// than a folder. Anything else is `BadInput`, with no ffmpeg started.
// Not called yet: the media and export sinks adopt it in this same release.
// Drop the allow when they do.
#[allow(dead_code)]
pub fn source_file(path: &str) -> Result<&Path> {
    if path.is_empty() {
        return refuse("No media file was given.");
    }
    if path.contains('\0') {
        return refuse("This media path is not valid.");
    }
    if is_device_path(path) {
        return refuse("A device path is not a media file.");
    }
    let p = Path::new(path);
    // A relative path would resolve against the app's working directory —
    // the install folder, or System32 — and a URL is not a path at all
    // (`https://…` has no drive or share, so it lands here too).
    if !p.is_absolute() {
        return refuse("This media path is not a full path to a file.");
    }
    if !is_file_namespace(p) {
        return refuse("A device path is not a media file.");
    }
    match std::fs::metadata(p) {
        Ok(meta) if meta.is_file() => Ok(p),
        Ok(_) => refuse("This media path is a folder, not a file."),
        Err(_) => refuse("This media file is missing or can't be read."),
    }
}

fn refuse<T>(message: &str) -> Result<T> {
    Err(AppError::BadInput(message.into()))
}

/// `\\.\` names a device (a volume, a pipe, COM1), not a file. Rust's own
/// prefix parser accepts either separator there, so `//./` is the same thing
/// in disguise and is refused the same way.
pub(crate) fn is_device_path(path: &str) -> bool {
    path.chars()
        .take(4)
        .map(|c| if c == '/' { '\\' } else { c })
        .eq(r"\\.\".chars())
}

/// Whether an absolute path lives on a drive or a share — the only places a
/// media file does. `\\?\` is a door into the whole object namespace, not
/// just into files: `\\?\pipe\` lists the machine's named pipes and
/// `\\?\GLOBALROOT\` reaches raw devices, and nothing here has any business
/// opening either. So the prefix is allow-listed (`C:\`, `\\server\share\`
/// and their `\\?\` spellings) rather than the bad ones deny-listed.
#[cfg(windows)]
pub(crate) fn is_file_namespace(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(p)) => matches!(
            p.kind(),
            Prefix::Disk(_) | Prefix::UNC(..) | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..)
        ),
        _ => false,
    }
}

/// Without Windows' prefixes, an absolute path is a filesystem path.
#[cfg(not(windows))]
pub(crate) fn is_file_namespace(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(path: &str) -> String {
        match source_file(path) {
            Err(AppError::BadInput(m)) => m,
            other => panic!("{path:?} must be refused as bad input, got {other:?}"),
        }
    }

    /// A real file is accepted, as itself, in its plain and (on Windows) its
    /// `\\?\` spelling; a folder, a missing file, a relative name for a file
    /// that exists, and every non-file form are refused with `BadInput`.
    #[test]
    fn only_an_existing_file_spelled_in_full_is_a_source() {
        let dir = std::env::temp_dir().join(format!(
            "taroting source-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip one.mp4");
        std::fs::write(&file, b"not decoded here").unwrap();
        let file_str = file.to_str().unwrap();

        assert_eq!(source_file(file_str).unwrap(), file.as_path());
        #[cfg(windows)]
        {
            let verbatim = format!(r"\\?\{file_str}");
            assert_eq!(source_file(&verbatim).unwrap(), Path::new(&verbatim));
        }

        assert!(refused(dir.to_str().unwrap()).contains("folder"));
        assert!(refused(dir.join("gone.mp4").to_str().unwrap()).contains("missing"));
        // A relative name resolves against the working directory, never the
        // project's folder, so even one that exists there is refused.
        let cwd = std::env::current_dir().unwrap();
        let here = std::fs::read_dir(&cwd)
            .unwrap()
            .flatten()
            .find(|e| e.path().is_file())
            .expect("the working directory holds a file");
        let relative = here.file_name().into_string().unwrap();
        assert!(Path::new(&relative).exists(), "the relative name does resolve");
        assert!(refused(&relative).contains("full path"), "{relative}");
        assert!(refused(r"media\clip.mp4").contains("full path"));
        // Drive-relative and root-relative: they name a drive or a root, but
        // resolve against a working directory all the same.
        assert!(refused(r"C:clip.mp4").contains("full path"));
        assert!(refused(r"\clip.mp4").contains("full path"));

        for url in ["http://example.com/clip.mp4", "https://example.com/clip.mp4", "rtmp://example.com/live"] {
            assert!(refused(url).contains("full path"), "{url}");
        }
        assert!(refused("").contains("No media"));
        assert!(refused("C:\\clip\0.mp4").contains("not valid"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Device and object-namespace doors are refused before anything touches
    /// the disk: `\\.\` in either separator, and every `\\?\` form that is not
    /// a drive or a share.
    #[cfg(windows)]
    #[test]
    fn device_and_object_namespace_paths_are_refused() {
        for p in [
            r"\\.\pipe\clip.mp4",
            "//./pipe/clip.mp4",
            r"\\.\C:\clip.mp4",
            r"\\.\COM1",
            r"\\?\pipe\clip.mp4",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\clip.mp4",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\clip.mp4",
        ] {
            assert!(refused(p).contains("device"), "{p}");
        }
    }

    /// Drives and shares are the file namespace, in both spellings — a UNC
    /// path stays allowed by design. Pinned here rather than through
    /// `source_file`, whose file check would reach the network for a share.
    #[cfg(windows)]
    #[test]
    fn drives_and_shares_are_the_file_namespace() {
        for p in [
            r"C:\clip.mp4",
            r"\\server\share\clip.mp4",
            r"\\?\C:\clip.mp4",
            r"\\?\UNC\server\share\clip.mp4",
        ] {
            assert!(is_file_namespace(Path::new(p)), "{p}");
            assert!(!is_device_path(p), "{p}");
        }
        for p in [r"\\.\C:\clip.mp4", r"\\?\pipe\clip.mp4", r"\clip.mp4", "clip.mp4"] {
            assert!(!is_file_namespace(Path::new(p)), "{p}");
        }
    }

    /// Pinned by value: the argv tests compare against this constant, so only
    /// this notices the constant itself being widened (`file,http`).
    #[test]
    fn the_input_whitelist_allows_files_only() {
        assert_eq!(INPUT_PROTOCOL_ARGS, ["-protocol_whitelist", "file"]);
    }
}
