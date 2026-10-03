//! ffmpeg argument builders for preview-preparation jobs (remux, proxy,
//! audio remux, gif→mp4). Pure functions over paths — unit-tested, never
//! interpolated through a shell.

use std::ffi::OsString;
use std::path::Path;

use crate::media::source::INPUT_PROTOCOL_ARGS;

fn base_args() -> Vec<OsString> {
    ["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"]
        .into_iter()
        .map(OsString::from)
        .collect()
}

fn push(args: &mut Vec<OsString>, items: &[&str]) {
    args.extend(items.iter().map(OsString::from));
}

/// The source input, limited to plain files (`media::source`): the path came
/// out of a `.trt`, and the bundled ffmpeg would otherwise open a URL here.
fn push_input(args: &mut Vec<OsString>, src: &Path) {
    push(args, &INPUT_PROTOCOL_ARGS);
    push(args, &["-i"]);
    args.push(src.into());
}

/// Lossless container swap → faststart MP4. Video stream copied; audio
/// copied when MP4-compatible, else transcoded to AAC.
pub fn remux_args(src: &Path, dst: &Path, audio_copy_ok: bool) -> Vec<OsString> {
    let mut args = base_args();
    push_input(&mut args, src);
    push(&mut args, &["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"]);
    if audio_copy_ok {
        push(&mut args, &["-c:a", "copy"]);
    } else {
        push(&mut args, &["-c:a", "aac", "-b:a", "192k"]);
    }
    push(&mut args, &["-movflags", "+faststart", "-f", "mp4"]);
    args.push(dst.into());
    args
}

/// The proxy's scale: at most 720 lines, and an EVEN number of them. `-2`
/// evens only the width; libx264 refuses an odd height in yuv420p, so a
/// 608x253 rip or a 1001x587 4:4:4 capture never got a proxy at all — and so
/// never previewed. `trunc(ih/2)*2` is `ih` for every even height, so the
/// sources that already worked get byte-identical proxies (no cache goes
/// stale), and odd ones lose their last line.
const PROXY_SCALE: &str = "scale=-2:'min(720,trunc(ih/2)*2)'";

/// 720p H.264 preview proxy for codecs the webview can't decode.
pub fn proxy_args(src: &Path, dst: &Path) -> Vec<OsString> {
    let mut args = base_args();
    push_input(&mut args, src);
    push(
        &mut args,
        &[
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", PROXY_SCALE,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", "-f", "mp4",
        ],
    );
    args.push(dst.into());
    args
}

/// Audio-only remux/transcode → .m4a (AAC), for codecs `<audio>` can't play.
pub fn audio_remux_args(src: &Path, dst: &Path) -> Vec<OsString> {
    let mut args = base_args();
    push_input(&mut args, src);
    push(
        &mut args,
        &["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-f", "mp4"],
    );
    args.push(dst.into());
    args
}

/// GIF (or other frame-based visual) → seekable MP4 proxy. Preserves frame
/// rate; pads odd dimensions (yuv420p needs even sizes).
pub fn gif_proxy_args(src: &Path, dst: &Path) -> Vec<OsString> {
    let mut args = base_args();
    push_input(&mut args, src);
    push(
        &mut args,
        &[
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-an",
            "-movflags", "+faststart", "-f", "mp4",
        ],
    );
    args.push(dst.into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn s(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn remux_copies_video_and_handles_paths_with_spaces() {
        let src = PathBuf::from(r"C:\media\my long recording.mkv");
        let dst = PathBuf::from(r"C:\cache\remux\abc.mp4");
        let args = s(&remux_args(&src, &dst, true));
        // path is a single standalone argv entry — no quoting needed ever
        assert!(args.contains(&r"C:\media\my long recording.mkv".to_string()));
        let cv = args.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(args[cv + 1], "copy");
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "copy"));
        assert_eq!(args.last().unwrap(), &r"C:\cache\remux\abc.mp4");
    }

    #[test]
    fn remux_transcodes_incompatible_audio() {
        let args = s(&remux_args(Path::new("a.mkv"), Path::new("b.mp4"), false));
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
    }

    #[test]
    fn proxy_scales_to_720_and_encodes_h264(){
        let args = s(&proxy_args(Path::new("in.mov"), Path::new("out.mp4")));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-vf" && w[1] == "scale=-2:'min(720,trunc(ih/2)*2)'"));
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(args.contains(&"-progress".to_string()));
    }

    /// Every recipe's source input is limited to plain files, right before its
    /// `-i`: a `.trt` names the path, and a URL there would make ffmpeg go
    /// online. Removing the whitelist from any one builder fails its row.
    #[test]
    fn every_recipe_opens_its_source_as_a_file_only() {
        let (src, dst) = (Path::new(r"C:\media\clip.mkv"), Path::new(r"C:\cache\out.mp4"));
        for (name, args) in [
            ("remux", remux_args(src, dst, true)),
            ("remux + aac", remux_args(src, dst, false)),
            ("proxy", proxy_args(src, dst)),
            ("audio remux", audio_remux_args(src, dst)),
            ("gif proxy", gif_proxy_args(src, dst)),
        ] {
            assert_eq!(args.iter().filter(|a| *a == "-i").count(), 1, "{name}");
            crate::media::source::assert_inputs_whitelisted(&args);
        }
    }

    #[test]
    fn gif_proxy_pads_to_even_dimensions() {
        let args = s(&gif_proxy_args(Path::new("a.gif"), Path::new("a.mp4")));
        assert!(args.windows(2).any(|w| w[0] == "-vf" && w[1].contains("trunc(iw/2)*2")));
        assert!(args.contains(&"-an".to_string()));
    }
}

/// Real end-to-end runs against the ffmpeg sidecar: encode a fixture,
/// run the exact argv our builders produce, probe the result.
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::jobs::ffmpeg;
    use crate::media::probe;
    use std::path::{Path, PathBuf};

    fn fixtures_dir() -> PathBuf {
        // space in the path on purpose — argv handling must never care
        let dir = std::env::temp_dir().join("taroting prepare e2e");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ffmpeg_ok(args: &[&str]) {
        let out = ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
        assert!(
            out.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The fixture at `path`, encoded by `encode` (ffmpeg arguments before the
    /// output) unless a file there already probes.
    ///
    /// Reused across runs, so it is written whole or not at all: ffmpeg
    /// encodes into a per-process `.part` name and only a finished encode is
    /// renamed into place. Writing straight to `path` left a run killed
    /// mid-encode with a truncated fixture that `exists()` then accepted
    /// forever, failing every later run for no reason in the code. An
    /// existing file that does not probe (such a leftover) is encoded again.
    fn fixture(path: &Path, encode: &[&str]) {
        if path.exists() && probe::probe_sync(path.to_str().unwrap()).is_ok() {
            return;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("fixture");
        let part = path.with_file_name(format!("{stem}.{}.part.{ext}", std::process::id()));
        let mut args = vec!["-y"];
        args.extend_from_slice(encode);
        args.push(part.to_str().unwrap());
        ffmpeg_ok(&args);
        // Another test process may have finished the same fixture first; its
        // copy is as good as ours.
        if std::fs::rename(&part, path).is_err() {
            let _ = std::fs::remove_file(&part);
        }
    }

    fn run_args(args: &[OsString]) {
        let out = ffmpeg::command("ffmpeg").unwrap().args(args).output().unwrap();
        assert!(
            out.status.success(),
            "prepared args failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn remux_h264_mkv_to_playable_mp4() {
        let dir = fixtures_dir();
        let mkv = dir.join("src video.mkv");
        fixture(&mkv, &[
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
        ]);
        let out = dir.join("remuxed.mp4");
        run_args(&remux_args(&mkv, &out, true));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert!(info.container.unwrap_or_default().contains("mp4"));
        assert!(info.has_audio);
        assert_eq!(info.acodec.as_deref(), Some("aac"));
    }

    #[test]
    fn proxy_hevc_to_h264() {
        let dir = fixtures_dir();
        let hevc = dir.join("src hevc.mp4");
        fixture(&hevc, &[
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=1",
            "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-tag:v", "hvc1",
        ]);
        let out = dir.join("proxied.mp4");
        run_args(&proxy_args(&hevc, &out));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert!(info.height.unwrap_or(0) <= 720);
        assert_eq!(info.pix_fmt.as_deref(), Some("yuv420p"));
    }

    /// A source with an ODD height under 720 lines, in a format the webview
    /// cannot play (4:4:4 H.264, so `decide` sends it to the proxy). The old
    /// `min(720,ih)` passed 181 straight to libx264's yuv420p, which refuses
    /// it: the proxy failed and the clip never previewed. 321 is odd too, so
    /// the width is checked as well; every axis differs from the 720 cap.
    #[test]
    fn proxy_of_an_odd_height_source_encodes_at_an_even_height() {
        let dir = fixtures_dir();
        let odd = dir.join("src odd 321x181 444.mkv");
        // `testsrc2` rounds its size down to even, so the odd size comes from
        // a scale after it.
        fixture(&odd, &[
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
            "-vf", "scale=321:181",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p",
        ]);
        let src = probe::probe_sync(odd.to_str().unwrap()).unwrap();
        assert_eq!((src.width, src.height), (Some(321), Some(181)), "fixture");
        assert_eq!(src.pix_fmt.as_deref(), Some("yuv444p"), "fixture");

        let out = dir.join("odd proxied.mp4");
        let _ = std::fs::remove_file(&out);
        run_args(&proxy_args(&odd, &out));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert_eq!(info.pix_fmt.as_deref(), Some("yuv420p"));
        assert_eq!(info.height, Some(180), "one line dropped to the even height below");
        assert_eq!(info.width.unwrap_or(1) % 2, 0);
    }

    /// The fixture helper regenerates a leftover that does not probe (the
    /// truncated file a killed run leaves behind) instead of trusting that
    /// it exists, and leaves no `.part` file beside it.
    #[test]
    fn a_truncated_fixture_is_encoded_again() {
        let dir = fixtures_dir().join(format!("refixture {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mkv");
        std::fs::write(&clip, b"\x1a\x45\xdf\xa3 cut short").unwrap();
        assert!(probe::probe_sync(clip.to_str().unwrap()).is_err(), "fixture: unreadable");

        fixture(&clip, &["-f", "lavfi", "-i", "testsrc2=size=96x54:rate=10:duration=1"]);
        let info = probe::probe_sync(clip.to_str().unwrap()).expect("re-encoded");
        assert_eq!((info.width, info.height), (Some(96), Some(54)));
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, [std::ffi::OsString::from("clip.mkv")], "only the fixture remains");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gif_becomes_seekable_even_dimension_mp4() {
        let dir = fixtures_dir();
        let gif = dir.join("anim 321x181.gif");
        // odd dimensions on purpose: 321x181 must pad down to even. From a
        // scale, because `testsrc2=size=321x181` quietly makes 320x180 — this
        // fixture was even all along, and the test could not fail.
        fixture(&gif, &[
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=1",
            "-vf", "scale=321:181",
        ]);
        let src = probe::probe_sync(gif.to_str().unwrap()).unwrap();
        assert_eq!((src.width, src.height), (Some(321), Some(181)), "fixture");
        let out = dir.join("anim proxy.mp4");
        run_args(&gif_proxy_args(&gif, &out));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert_eq!(info.width.unwrap_or(0) % 2, 0);
        assert_eq!(info.height.unwrap_or(0) % 2, 0);
        assert!(!info.has_audio);
    }

    #[test]
    fn audio_remux_produces_aac_m4a() {
        let dir = fixtures_dir();
        // simulate an "unplayable" audio source: ac3 in its own container
        let ac3 = dir.join("src audio.ac3");
        fixture(&ac3, &["-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-c:a", "ac3"]);
        let out = dir.join("audio remux.m4a");
        run_args(&audio_remux_args(&ac3, &out));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "audio");
        assert_eq!(info.acodec.as_deref(), Some("aac"));
    }
}
