//! ffmpeg argument builders for preview-preparation jobs (remux, proxy,
//! audio remux, gif→mp4). Pure functions over paths — unit-tested, never
//! interpolated through a shell.

use std::ffi::OsString;
use std::path::Path;

fn base_args() -> Vec<OsString> {
    ["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"]
        .into_iter()
        .map(OsString::from)
        .collect()
}

fn push(args: &mut Vec<OsString>, items: &[&str]) {
    args.extend(items.iter().map(OsString::from));
}

/// Lossless container swap → faststart MP4. Video stream copied; audio
/// copied when MP4-compatible, else transcoded to AAC.
pub fn remux_args(src: &Path, dst: &Path, audio_copy_ok: bool) -> Vec<OsString> {
    let mut args = base_args();
    push(&mut args, &["-i"]);
    args.push(src.into());
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

/// 720p H.264 preview proxy for codecs the webview can't decode.
pub fn proxy_args(src: &Path, dst: &Path) -> Vec<OsString> {
    let mut args = base_args();
    push(&mut args, &["-i"]);
    args.push(src.into());
    push(
        &mut args,
        &[
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=-2:'min(720,ih)'",
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
    push(&mut args, &["-i"]);
    args.push(src.into());
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
    push(&mut args, &["-i"]);
    args.push(src.into());
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
        assert!(args.windows(2).any(|w| w[0] == "-vf" && w[1].contains("min(720,ih)")));
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(args.contains(&"-progress".to_string()));
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
    use std::path::PathBuf;

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
        if !mkv.exists() {
            ffmpeg_ok(&[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest",
                mkv.to_str().unwrap(),
            ]);
        }
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
        if !hevc.exists() {
            ffmpeg_ok(&[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=1",
                "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-tag:v", "hvc1",
                hevc.to_str().unwrap(),
            ]);
        }
        let out = dir.join("proxied.mp4");
        run_args(&proxy_args(&hevc, &out));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.vcodec.as_deref(), Some("h264"));
        assert!(info.height.unwrap_or(0) <= 720);
        assert_eq!(info.pix_fmt.as_deref(), Some("yuv420p"));
    }

    #[test]
    fn gif_becomes_seekable_even_dimension_mp4() {
        let dir = fixtures_dir();
        let gif = dir.join("anim.gif");
        if !gif.exists() {
            // odd dimensions on purpose: 321x181 must pad down to even
            ffmpeg_ok(&[
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=321x181:rate=12:duration=1",
                gif.to_str().unwrap(),
            ]);
        }
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
        if !ac3.exists() {
            ffmpeg_ok(&[
                "-y",
                "-f", "lavfi", "-i", "sine=frequency=330:duration=1",
                "-c:a", "ac3",
                ac3.to_str().unwrap(),
            ]);
        }
        let out = dir.join("audio remux.m4a");
        run_args(&audio_remux_args(&ac3, &out));

        let info = probe::probe_sync(out.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "audio");
        assert_eq!(info.acodec.as_deref(), Some("aac"));
    }
}
