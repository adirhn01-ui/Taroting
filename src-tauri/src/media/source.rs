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
//! Network shares (`\\server\share\clip.mp4`) stay allowed when they are on the
//! local network: media on a NAS is ordinary, and to ffmpeg a share is a file
//! like any other. A share on any OTHER machine is a network connection the
//! moment anything so much as reads its metadata — SMB, which hands that
//! machine the user's Windows sign-in (NTLM) unasked, or WebDAV over HTTPS
//! (`\\host@SSL\…`) — so a path whose server could be on the internet is
//! never touched at all ([`may_touch`]), by any code that reads a path a
//! `.trt` gave.

use std::path::Path;
use std::time::Duration;

use crate::error::{AppError, Result};

/// The input option that limits ffmpeg to plain files for the input after it.
/// Goes immediately before each file `-i` (not before a lavfi `color` or
/// `anullsrc` input, which opens no protocol at all).
pub const INPUT_PROTOCOL_ARGS: [&str; 2] = ["-protocol_whitelist", "file"];

/// `path` as a `Path`, when it names an existing file a sidecar may open:
/// spelled in full, on a drive or a share, not a device, and a file rather
/// than a folder. Anything else is `BadInput`, with no ffmpeg started.
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
    if !may_touch(p) {
        return refuse(OFF_THE_LOCAL_NETWORK);
    }
    match std::fs::metadata(p) {
        Ok(meta) if meta.is_file() => Ok(p),
        Ok(_) => refuse("This media path is a folder, not a file."),
        Err(_) => refuse("This media file is missing or can't be read."),
    }
}

/// The refusal for a share [`may_touch`] turns down.
pub(crate) const OFF_THE_LOCAL_NETWORK: &str =
    "This file is on a network share outside the local network, which Taroting doesn't open.";

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

/// Whether anything may read `path` at all — its metadata included — as far
/// as WHERE it is goes: a drive, or a share on the local network. Asked
/// before the first stat of any path a `.trt` gave (the missing-media scan,
/// a Home card, the orientation repair, every sidecar, the asset handler,
/// the export's and the image save's source checks).
///
/// A share's server must be a name the local network answers for: a
/// computer name with no dot (NetBIOS, how Windows names a NAS), a `.local`
/// name (answered only on the local link), or a private, link-local or
/// loopback IPv4 address. A dotted name or a public address can be any
/// machine on the internet; `@` (`\\host@SSL\`, `\\host@8080\`) and the
/// `DavWWWRoot` share force WebDAV, which is HTTP; `:` and `%` are IPv6 and
/// port spellings. All of those are refused. This is a choice about WHERE,
/// never about whether the file exists: a refused path is simply treated as
/// one Taroting cannot reach.
///
/// FAIL CLOSED: only the two shapes the rule can judge pass — a drive
/// (`C:\`, `\\?\C:\`) and a share whose server it can read. Every other
/// spelling is refused, because several of them still reach SMB while
/// hiding the server from a prefix check: `\\.\UNC\host\share` (a device
/// namespace prefix), `\\?\GLOBALROOT\Device\Mup\host\share` and
/// `\\.\GLOBALROOT\…` (verbatim/device prefixes), and the NT form
/// `\??\UNC\host\share`, which Rust reads as a rooted path with NO prefix.
/// A path with no prefix at all (relative, or rooted on the current drive)
/// is no path a `.trt` should name either.
pub(crate) fn may_touch(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(p)) => match p.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => true,
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => is_local_share(server, share),
                Prefix::DeviceNS(_) | Prefix::Verbatim(_) => false,
            },
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_local_share(server: &std::ffi::OsStr, share: &std::ffi::OsStr) -> bool {
    let (Some(server), Some(share)) = (server.to_str(), share.to_str()) else {
        return false;
    };
    !share.eq_ignore_ascii_case("DavWWWRoot") && is_local_server(server)
}

/// The server half of [`may_touch`]'s rule.
///
/// ASCII only: a name spelled with a full-width or ideographic dot (U+FF0E,
/// U+3002, U+FF61) has no ASCII dot for the dotted-name rule to see, yet name
/// resolution may fold it to one — a dotted internet name in disguise.
///
/// And a dotless name is a computer name only when it is not a NUMBER:
/// Windows' resolver reads a bare decimal or `0x` hex number as an IPv4
/// address (`2130706433` and `0x7f000001` both reach 127.0.0.1), so
/// `\\134744072\` is 8.8.8.8 with no dot in it. Every such number is refused
/// rather than decoded — a NAS is not named by one.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_local_server(server: &str) -> bool {
    if server.is_empty() || !server.is_ascii() || server.contains(['@', ':', '%']) {
        return false;
    }
    if let Ok(ip) = server.parse::<std::net::Ipv4Addr>() {
        return ip.is_private() || ip.is_loopback() || ip.is_link_local();
    }
    if !server.contains('.') {
        return !is_bare_number(server);
    }
    server.len() > ".local".len()
        && server.is_char_boundary(server.len() - ".local".len())
        && server[server.len() - ".local".len()..].eq_ignore_ascii_case(".local")
}

/// A dotless server name the resolver would read as an IPv4 address: all
/// decimal digits (octal's leading-zero spelling is digits too), or `0x`
/// followed by hex digits only.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_bare_number(server: &str) -> bool {
    let hex = server.strip_prefix("0x").or_else(|| server.strip_prefix("0X"));
    match hex {
        Some(digits) => digits.bytes().all(|b| b.is_ascii_hexdigit()),
        None => server.bytes().all(|b| b.is_ascii_digit()),
    }
}

/* ------------------------------------------------------------------ */
/* Cloud placeholders                                                  */
/* ------------------------------------------------------------------ */

/// Windows attributes marking a cloud placeholder — a file whose bytes are not
/// on this machine (OneDrive "online-only", and any sync provider built on the
/// same Cloud Files API). Reading even a header from one downloads it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
#[cfg_attr(not(windows), allow(dead_code))]
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x4_0000;
#[cfg_attr(not(windows), allow(dead_code))]
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;

/// Whether a file with these attributes is a cloud placeholder. Pure, so the
/// three bits are pinned by a test rather than by a OneDrive account.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_placeholder_attributes(attributes: u32) -> bool {
    attributes
        & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
        != 0
}

/// Whether reading `path` would download it. Metadata alone never does, so
/// this is asked BEFORE anything opens the file. Unreadable metadata counts as
/// a placeholder: every caller uses this to skip optional work (the load-time
/// repair, a Home card), and a surprise download is worse than skipping it.
#[cfg(windows)]
pub(crate) fn is_cloud_placeholder(path: &Path) -> bool {
    !may_touch(path) || std::fs::metadata(path).map_or(true, |m| is_placeholder_attributes(attributes_of(&m)))
}

#[cfg(not(windows))]
pub(crate) fn is_cloud_placeholder(_path: &Path) -> bool {
    false
}

#[cfg(windows)]
fn attributes_of(meta: &std::fs::Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes()
}

#[cfg(not(windows))]
fn attributes_of(_meta: &std::fs::Metadata) -> u32 {
    0
}

/// The speed a placeholder's bytes are assumed to arrive at while a sidecar
/// waits for them: 2 Mbit/s, a slow but ordinary connection.
const HYDRATE_BYTES_PER_SEC: u64 = 256 * 1024;

/// The longest any sidecar waits for a placeholder, however large.
const MAX_HYDRATE_WAIT: Duration = Duration::from_secs(30 * 60);

/// How long a sidecar reading this file may run, given the bound `base` it
/// has for a file that is on this machine.
///
/// The fixed bounds exist for a source that never answers. A cloud
/// placeholder that is still DOWNLOADING looks the same from outside — the
/// read just blocks — and on a provider that fetches the whole file before
/// the first read returns, a 30 s bound refused every online-only video
/// larger than a slow connection moves in 30 s. So a placeholder gets its
/// bound plus the time its bytes take at [`HYDRATE_BYTES_PER_SEC`], up to
/// [`MAX_HYDRATE_WAIT`] (never below `base`). A local file keeps `base`
/// exactly, and so does a file that has finished downloading: the provider
/// clears the bits then.
pub(crate) fn deadline_for(base: Duration, meta: &std::fs::Metadata) -> Duration {
    deadline_for_attributes(base, attributes_of(meta), meta.len())
}

/// [`deadline_for`] on the two facts it reads, so a test can pin every row
/// without a sync provider.
fn deadline_for_attributes(base: Duration, attributes: u32, len: u64) -> Duration {
    if !is_placeholder_attributes(attributes) {
        return base;
    }
    let download = Duration::from_secs(len / HYDRATE_BYTES_PER_SEC);
    base.saturating_add(download).min(MAX_HYDRATE_WAIT.max(base))
}

/// [`deadline_for`] for a path whose metadata the caller has not read. One
/// stat; a file whose metadata cannot be read keeps `base`.
pub(crate) fn deadline_for_path(base: Duration, path: &Path) -> Duration {
    if !may_touch(path) {
        return base;
    }
    std::fs::metadata(path).map_or(base, |m| deadline_for(base, &m))
}

/// The argv check every sink's tests share: each `-i` in `args` comes right
/// after [`INPUT_PROTOCOL_ARGS`], and there is at least one `-i` (an argv with
/// none would pass vacuously). Panics with the argv on a miss.
#[cfg(test)]
pub(crate) fn assert_inputs_whitelisted<S: AsRef<std::ffi::OsStr>>(args: &[S]) {
    let args: Vec<String> = args.iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect();
    let inputs: Vec<usize> = (0..args.len()).filter(|&i| args[i] == "-i").collect();
    assert!(!inputs.is_empty(), "no -i in {args:?}");
    for i in inputs {
        assert!(
            i >= 2 && args[i - 2..i] == INPUT_PROTOCOL_ARGS,
            "the -i at {i} is not limited to files: {args:?}"
        );
    }
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

    /// Where a share may be. Every refused row differs from an allowed one on
    /// the one axis the rule reads; none of them is ever stat-ed (this is the
    /// predicate alone), so the test cannot reach any network.
    #[cfg(windows)]
    #[test]
    fn only_a_share_on_the_local_network_may_be_touched() {
        let rows: [(&str, bool, &str); 37] = [
            // Spellings that reach SMB with the server hidden from a UNC
            // prefix check: the gate must refuse them without reading them.
            (r"\\.\UNC\files.example.com\media\clip.mp4", false, "UNC through the device namespace"),
            (r"\\?\GLOBALROOT\Device\Mup\files.example.com\media\clip.mp4", false, "the MUP device, verbatim"),
            (r"\\.\GLOBALROOT\Device\Mup\files.example.com\media\clip.mp4", false, "the MUP device, device namespace"),
            (r"\??\UNC\files.example.com\media\clip.mp4", false, "the NT object path (no Rust prefix)"),
            (r"\\.\UNC\nas\media\clip.mp4", false, "even a LAN share, through the device namespace"),
            (r"\media\clip.mp4", false, "rooted on the current drive, no prefix"),
            ("clip.mp4", false, "relative"),
            (r"C:\media\clip.mp4", true, "a drive"),
            (r"\\?\C:\media\clip.mp4", true, "a drive, verbatim"),
            (r"\\nas\media\clip.mp4", true, "a NAS by its computer name"),
            (r"\\NAS\media\clip.mp4", true, "the same, upper case"),
            (r"\\DISKSTATION\media\clip.mp4", true, "a NAS's factory name"),
            (r"\\my-nas\media\clip.mp4", true, "a computer name with a hyphen"),
            (r"\\nas2\media\clip.mp4", true, "a computer name ending in a digit"),
            (r"\\0xnas\media\clip.mp4", true, "a 0x name that is not all hex"),
            (r"\\134744072\media\clip.mp4", false, "8.8.8.8 as one decimal number"),
            (r"\\0x08080808\media\clip.mp4", false, "8.8.8.8 as one hex number"),
            (r"\\0X08080808\media\clip.mp4", false, "the same, upper-case prefix"),
            (r"\\2130706433\media\clip.mp4", false, "even this machine, spelled as a number"),
            ("\\\\files\u{FF0E}example\u{FF0E}com\\media\\clip.mp4", false, "a full-width-dotted name"),
            ("\\\\files\u{3002}example\u{3002}com\\media\\clip.mp4", false, "an ideographic-dotted name"),
            (r"\\?\UNC\nas\media\clip.mp4", true, "the same, verbatim"),
            ("//nas/media/clip.mp4", true, "the same, forward slashes"),
            (r"\\DiskStation.local\media\clip.mp4", true, "an mDNS name"),
            (r"\\192.168.1.10\media\clip.mp4", true, "a home network address"),
            (r"\\10.0.0.5\media\clip.mp4", true, "a private address"),
            (r"\\169.254.3.4\media\clip.mp4", true, "a link-local address"),
            (r"\\127.0.0.1\media\clip.mp4", true, "this machine"),
            (r"\\files.example.com\media\clip.mp4", false, "a dotted name: any machine"),
            ("//files.example.com/media/clip.mp4", false, "the same, forward slashes"),
            (r"\\?\UNC\files.example.com\media\clip.mp4", false, "the same, verbatim"),
            (r"\\8.8.8.8\media\clip.mp4", false, "a public address"),
            (r"\\127.0.0.1@SSL\media\clip.mp4", false, "WebDAV over HTTPS, even to this machine"),
            (r"\\nas@8080\media\clip.mp4", false, "WebDAV on a port"),
            (r"\\nas\DavWWWRoot\clip.mp4", false, "the share that forces WebDAV"),
            (r"\\fe80--1.ipv6-literal.net\media\clip.mp4", false, "an IPv6 spelling"),
            (r"\\local\media\clip.mp4", true, "a computer named local"),
        ];
        for (path, want, why) in rows {
            assert_eq!(may_touch(Path::new(path)), want, "{why}: {path}");
        }
        assert!(!is_local_server("evil.local.example.com"), ".local only as the last label");
    }

    /// `source_file` asks before its stat, with its own words.
    #[cfg(windows)]
    #[test]
    fn a_share_off_the_local_network_is_refused_before_any_stat() {
        assert_eq!(refused(r"\\127.0.0.1@SSL\share\clip.mp4"), OFF_THE_LOCAL_NETWORK);
        assert!(is_cloud_placeholder(Path::new(r"\\127.0.0.1@SSL\share\clip.mp4")), "never stat-ed");
    }

    /// The three bits that mean "the bytes are in the cloud", and neighbours
    /// that do not: ARCHIVE and NORMAL are on every ordinary file, PINNED and
    /// UNPINNED describe a sync policy, not where the bytes are.
    #[test]
    fn only_offline_and_recall_bits_mark_a_placeholder() {
        for local in [0u32, 0x20, 0x80, 0x2000, 0x8_0000, 0x10_0000, 0x20 | 0x10_0000] {
            assert!(!is_placeholder_attributes(local), "{local:#x}");
        }
        for cloud in [0x1000u32, 0x4_0000, 0x40_0000, 0x20 | 0x40_0000, 0x10_0000 | 0x40_0000 | 0x1000] {
            assert!(is_placeholder_attributes(cloud), "{cloud:#x}");
        }
    }

    /// A placeholder's bound grows with its size; a local file's never does,
    /// whatever its size. Each row differs from its neighbour on one axis.
    #[test]
    fn a_placeholder_gets_time_to_download_and_a_local_file_does_not() {
        const MB: u64 = 1024 * 1024;
        let base = Duration::from_secs(30);
        let rows: [(u32, u64, u64, &str); 7] = [
            (0x20, 300 * MB, 30, "a local file of the same size keeps its bound"),
            (0x40_0000, 300 * MB, 30 + 1200, "online-only: 300 MB at 256 KiB/s"),
            (0x4_0000, 300 * MB, 30 + 1200, "recall on open counts the same"),
            (0x1000, 60 * MB, 30 + 240, "offline, a smaller file"),
            (0x40_0000, 0, 30, "an empty placeholder keeps its bound"),
            (0x40_0000, 64 * 1024 * MB, 30 * 60, "a huge one is capped"),
            (0x10_0000, 64 * 1024 * MB, 30, "pinned (local) is not a placeholder"),
        ];
        for (attributes, len, secs, why) in rows {
            assert_eq!(deadline_for_attributes(base, attributes, len), Duration::from_secs(secs), "{why}");
        }
        // A bound already past the cap is never shortened by it.
        let long = Duration::from_secs(3 * 3600);
        assert_eq!(deadline_for_attributes(long, 0x40_0000, 600 * MB), long);
    }

    /// The same rule read off a real file's metadata: the offline bit set on
    /// an otherwise identical file is what lengthens the bound.
    #[cfg(windows)]
    #[test]
    fn the_bound_is_read_off_the_files_own_attributes() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("taroting source-cloud-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = vec![7u8; 3 * 256 * 1024];
        let local = dir.join("local.mp4");
        std::fs::write(&local, &bytes).unwrap();
        let cloud = dir.join("cloud.mp4");
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .attributes(FILE_ATTRIBUTE_OFFLINE)
            .open(&cloud)
            .and_then(|mut f| f.write_all(&bytes))
            .unwrap();
        assert!(is_cloud_placeholder(&cloud) && !is_cloud_placeholder(&local), "fixture");
        let base = Duration::from_secs(15);
        assert_eq!(deadline_for_path(base, &local), base);
        assert_eq!(deadline_for_path(base, &cloud), Duration::from_secs(18));
        assert_eq!(deadline_for_path(base, &dir.join("gone.mp4")), base);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pinned by value: the argv tests compare against this constant, so only
    /// this notices the constant itself being widened (`file,http`).
    #[test]
    fn the_input_whitelist_allows_files_only() {
        assert_eq!(INPUT_PROTOCOL_ARGS, ["-protocol_whitelist", "file"]);
    }
}
