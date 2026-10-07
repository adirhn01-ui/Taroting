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

/// The input bitstream filter that removes every in-band H.264 SEI (NAL type
/// 6), SPS (7) and PPS (8) before the decoder sees them, so the parameter sets
/// in the file's header (`avcC`) are the only ones in force. An INPUT option:
/// it goes before the input's `-i`, and acts on the packets demuxed from it.
///
/// For a damaged recording whose garbage frames happen to parse as headers (a
/// real NVIDIA Instant Replay file: the first minute scrambled, NAL types
/// random), ffmpeg believes them. As parameter sets they re-size its decoder
/// to nonsense (16x32, 38x8, ...), and since the clean section never repeats a
/// real SPS every clean frame after them decodes wrong. As a
/// display-orientation SEI they put a display matrix on a frame, and ffmpeg's
/// autorotate turns the picture by it: the real file's repair copy came out
/// turned ~90 degrees and sheared ("display matrix changed", "Odd rotation
/// angle"). `-noautorotate` would also have kept it upright — and would have
/// stopped every phone video's legitimate turn, which lives in the container,
/// not in an SEI — so the SEI goes instead. An `avc1` stream needs none of the
/// three in-band: ISO/IEC 14496-15 puts its parameter sets in the sample
/// entry, and an SEI only describes. So it is applied where the header has the
/// parameter sets (`probe::h264_param_sets_in_header`) or the media entry says
/// so (`MediaRef.drop_inband_headers`). An `avc3`/Annex-B stream carries its
/// parameter sets ONLY in-band and would decode nothing without them.
///
/// One constant for the preview's repair copy and the export's input, so the
/// two can never filter differently.
pub const DROP_INBAND_HEADERS: [&str; 2] = ["-bsf:v", "filter_units=remove_types=6|7|8"];

/// 720p H.264 preview proxy for codecs the webview can't decode.
pub fn proxy_args(src: &Path, dst: &Path) -> Vec<OsString> {
    proxy_recipe(src, dst, &[])
}

/// The preview of a file the WebView REFUSED although `playability::decide`
/// calls it playable: Chromium stops a whole file at its first undecodable
/// frame, where ffmpeg conceals it and carries on. Byte-for-byte the proxy
/// recipe, so a repair copy is the same 720p H.264 a proxy is — plus, when
/// `drop_headers`, `DROP_INBAND_HEADERS` on the input. Without the filter
/// `repair_args` IS `proxy_args`; the caller still keeps the two in different
/// cache files (`playability::repair_target`).
pub fn repair_args(src: &Path, dst: &Path, drop_headers: bool) -> Vec<OsString> {
    let filter: &[&str] = if drop_headers { &DROP_INBAND_HEADERS } else { &[] };
    proxy_recipe(src, dst, filter)
}

/// The INSTANT preview of a recording whose first `video_from` seconds are
/// damaged (`damage::scan_damaged_prefix`): a lossless stream copy — under a
/// second where the full repair (`repair_args`) decodes the whole file. Its
/// video starts at the first clean keyframe and keeps the original timestamps
/// (`-copyts`), so a second of the copy is a second of the file; its audio is
/// whole, from 0, out of a second opening of the same file. The WebView plays
/// the sound from 0, holds the first clean picture until the video starts, and
/// nothing it decodes is damaged.
///
/// The seek is an INPUT option of the first opening only, 1 ms past the
/// keyframe: a stream copy starts at the sync sample at or before its target,
/// and a damaged part's `stss` flags garbage samples as sync too, so a target
/// that rounded below the keyframe could land on the garbage before it.
pub fn quick_repair_args(src: &Path, dst: &Path, video_from: f64) -> Vec<OsString> {
    let mut args = base_args();
    push(&mut args, &["-copyts", "-ss"]);
    args.push(format!("{:.6}", video_from + 0.001).into());
    push_input(&mut args, src);
    push_input(&mut args, src);
    push(
        &mut args,
        &[
            "-map", "0:v:0", "-map", "1:a:0?",
            "-c", "copy",
            "-movflags", "+faststart", "-f", "mp4",
        ],
    );
    args.push(dst.into());
    args
}

/// `proxy_args`' recipe with `input_opts` before the source's `-i`. One body
/// for both, so a change to the proxy reaches the repair copy too; the
/// proxy's own argv is unchanged by it (it keys the cache — see
/// `cache::RECIPE_VERSION`).
fn proxy_recipe(src: &Path, dst: &Path, input_opts: &[&str]) -> Vec<OsString> {
    let mut args = base_args();
    push(&mut args, input_opts);
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

    /// The proxy's argv, whole and literal. Its output is cached under a key
    /// that says nothing about the recipe beyond `RECIPE_VERSION`, so ANY
    /// change here re-serves every user's old proxies as if they were new
    /// ones; sharing its body with the repair recipe must leave it exactly
    /// this.
    #[test]
    fn proxy_args_are_byte_for_byte_the_shipped_recipe() {
        let args = s(&proxy_args(Path::new(r"C:\in\a b.mov"), Path::new(r"C:\c\p.mp4")));
        assert_eq!(
            args,
            [
                "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
                "-protocol_whitelist", "file", "-i", r"C:\in\a b.mov",
                "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", "scale=-2:'min(720,trunc(ih/2)*2)'",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart", "-f", "mp4",
                r"C:\c\p.mp4",
            ]
        );
    }

    /// The repair copy is the proxy recipe; dropping the in-band headers adds
    /// exactly the two filter arguments, as INPUT options — right before the
    /// source's `-protocol_whitelist file -i`, where ffmpeg applies them to
    /// the packets it demuxes (after the `-i` they would be output options,
    /// filtering the ENCODER's stream, and the decode would be as broken as
    /// before). They appear nowhere else, and they name SEI (6) as well as
    /// SPS (7) and PPS (8): a garbage display-orientation SEI turns the
    /// picture (the e2e proof below).
    #[test]
    fn repair_is_the_proxy_recipe_with_the_filter_on_its_input() {
        let (src, dst) = (Path::new(r"C:\rec\Replay 2026.mp4"), Path::new(r"C:\c\r.mp4"));
        assert_eq!(repair_args(src, dst, false), proxy_args(src, dst));

        let plain = s(&proxy_args(src, dst));
        let fixed = s(&repair_args(src, dst, true));
        let input = plain.iter().position(|a| a == "-protocol_whitelist").unwrap();
        let mut want = plain.clone();
        want.splice(input..input, ["-bsf:v".to_string(), "filter_units=remove_types=6|7|8".to_string()]);
        assert_eq!(fixed, want);
        let bsf = fixed.iter().position(|a| a == "-bsf:v").unwrap();
        assert_eq!(&fixed[bsf..bsf + 5], ["-bsf:v", "filter_units=remove_types=6|7|8", "-protocol_whitelist", "file", "-i"]);
        assert_eq!(fixed.iter().filter(|a| a.starts_with("-bsf")).count(), 1);
        assert!(!plain.iter().any(|a| a.starts_with("-bsf")), "the proxy never filters");
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
            ("repair", repair_args(src, dst, false)),
            ("repair, headers dropped", repair_args(src, dst, true)),
            ("audio remux", audio_remux_args(src, dst)),
            ("gif proxy", gif_proxy_args(src, dst)),
        ] {
            assert_eq!(args.iter().filter(|a| *a == "-i").count(), 1, "{name}");
            crate::media::source::assert_inputs_whitelisted(&args);
        }
        // The instant copy opens the source twice; both openings are files.
        let quick = quick_repair_args(src, dst, 60.499);
        assert_eq!(quick.iter().filter(|a| *a == "-i").count(), 2);
        crate::media::source::assert_inputs_whitelisted(&quick);
    }

    /// The instant copy's argv, whole and literal: the seek 1 ms past the
    /// keyframe as an input option of the FIRST opening only (the one the
    /// video is mapped from), original timestamps kept, audio mapped from the
    /// second opening, every stream copied. On the second opening the seek
    /// would cut the sound instead of the picture; after the inputs it would
    /// be an output option, trimming the audio as well.
    #[test]
    fn the_instant_copy_seeks_only_the_video_and_copies_every_stream() {
        let args = s(&quick_repair_args(Path::new(r"C:\rec\Replay 2026.mp4"), Path::new(r"C:\c\q.mp4"), 60.499));
        assert_eq!(
            args,
            [
                "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
                "-copyts", "-ss", "60.500000",
                "-protocol_whitelist", "file", "-i", r"C:\rec\Replay 2026.mp4",
                "-protocol_whitelist", "file", "-i", r"C:\rec\Replay 2026.mp4",
                "-map", "0:v:0", "-map", "1:a:0?",
                "-c", "copy",
                "-movflags", "+faststart", "-f", "mp4",
                r"C:\c\q.mp4",
            ]
        );
        // The target is formatted from the exact time: 1 ms past a keyframe
        // at 1/3 s is 0.334333.
        let third = s(&quick_repair_args(Path::new("a.mp4"), Path::new("b.mp4"), 1.0 / 3.0));
        assert_eq!(third[9], "0.334333");
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

    /* ---- a damaged recording, made on purpose ---- */

    /// Each box in `buf[start..end]`: its type, where its body starts, where
    /// it ends.
    fn boxes(buf: &[u8], start: usize, end: usize) -> Vec<([u8; 4], usize, usize)> {
        let mut out = Vec::new();
        let mut i = start;
        while i + 8 <= end {
            let typ: [u8; 4] = buf[i + 4..i + 8].try_into().unwrap();
            let (header, size) = match be32(buf, i) {
                1 => (16, u64::from_be_bytes(buf[i + 8..i + 16].try_into().unwrap()) as usize),
                0 => (8, end - i),
                n => (8, n as usize),
            };
            out.push((typ, i + header, i + size));
            i += size;
        }
        out
    }

    /// The body of the first box along `path` inside `within`.
    fn child(buf: &[u8], within: (usize, usize), path: &[&[u8; 4]]) -> Option<(usize, usize)> {
        let (first, rest) = path.split_first()?;
        let (_, s, e) = boxes(buf, within.0, within.1).into_iter().find(|(t, _, _)| t == *first)?;
        if rest.is_empty() {
            Some((s, e))
        } else {
            child(buf, (s, e), rest)
        }
    }

    fn be32(buf: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(buf[at..at + 4].try_into().unwrap())
    }

    /// The video track's sample table.
    fn video_stbl(buf: &[u8]) -> (usize, usize) {
        let moov = child(buf, (0, buf.len()), &[b"moov"]).expect("moov");
        boxes(buf, moov.0, moov.1)
            .into_iter()
            .filter(|(t, _, _)| t == b"trak")
            .find_map(|(_, s, e)| {
                // hdlr: version/flags, pre_defined, then the handler type
                let hdlr = child(buf, (s, e), &[b"mdia", b"hdlr"])?;
                if &buf[hdlr.0 + 8..hdlr.0 + 12] != b"vide" {
                    return None;
                }
                child(buf, (s, e), &[b"mdia", b"minf", b"stbl"])
            })
            .expect("a video track")
    }

    /// The `avcC` record of the track's `avc1` sample entry.
    fn avcc(buf: &[u8], stbl: (usize, usize)) -> &[u8] {
        let stsd = child(buf, stbl, &[b"stsd"]).unwrap();
        let entry = stsd.0 + 8; // past version/flags and the entry count
        assert_eq!(&buf[entry + 4..entry + 8], b"avc1", "fixture: an avc1 entry");
        // A visual sample entry's box header and 78 bytes of fields come
        // before its child boxes.
        let rec = child(buf, (entry + 8 + 78, entry + be32(buf, entry) as usize), &[b"avcC"]).unwrap();
        &buf[rec.0..rec.1]
    }

    /// The first SPS and the first PPS of an `avcC` record.
    fn param_sets(rec: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut i = 6;
        let take = |count: usize, i: &mut usize| {
            let mut first = None;
            for _ in 0..count {
                let len = u16::from_be_bytes([rec[*i], rec[*i + 1]]) as usize;
                first.get_or_insert_with(|| rec[*i + 2..*i + 2 + len].to_vec());
                *i += 2 + len;
            }
            first.expect("fixture: a parameter set")
        };
        let sps = take((rec[5] & 0x1f) as usize, &mut i);
        let pps_count = rec[i] as usize;
        i += 1;
        let pps = take(pps_count, &mut i);
        (sps, pps)
    }

    /// Every video sample's (file offset, size): `stsz` for the sizes,
    /// `stco`/`co64` for where each chunk starts, `stsc` for how many samples
    /// each chunk holds.
    fn sample_spans(buf: &[u8], stbl: (usize, usize)) -> Vec<(usize, usize)> {
        let stsz = child(buf, stbl, &[b"stsz"]).unwrap().0;
        let (fixed, count) = (be32(buf, stsz + 4) as usize, be32(buf, stsz + 8) as usize);
        let size = |k: usize| if fixed != 0 { fixed } else { be32(buf, stsz + 12 + 4 * k) as usize };
        let (table, wide) = match child(buf, stbl, &[b"stco"]) {
            Some(b) => (b.0, false),
            None => (child(buf, stbl, &[b"co64"]).unwrap().0, true),
        };
        let chunk_at = |c: usize| {
            if wide {
                u64::from_be_bytes(buf[table + 8 + 8 * c..table + 16 + 8 * c].try_into().unwrap()) as usize
            } else {
                be32(buf, table + 8 + 4 * c) as usize
            }
        };
        let stsc = child(buf, stbl, &[b"stsc"]).unwrap().0;
        let runs: Vec<(usize, usize)> = (0..be32(buf, stsc + 4) as usize)
            .map(|k| (be32(buf, stsc + 8 + 12 * k) as usize, be32(buf, stsc + 12 + 12 * k) as usize))
            .collect();
        let mut spans = Vec::new();
        for c in 0..be32(buf, table + 4) as usize {
            let per = runs.iter().rev().find(|(first, _)| *first <= c + 1).unwrap().1;
            let mut at = chunk_at(c);
            for _ in 0..per {
                let len = size(spans.len());
                spans.push((at, len));
                at += len;
            }
        }
        assert_eq!(spans.len(), count, "fixture: every sample placed");
        spans
    }

    /// The NAL unit types of one sample (4-byte length prefixes).
    fn nal_types(sample: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 4 < sample.len() {
            types.push(sample[i + 4] & 0x1f);
            i += 4 + be32(sample, i) as usize;
        }
        types
    }

    /// Every decoded frame of `path`'s video: (seconds, width, height).
    fn decoded_frames(path: &Path) -> Vec<(f64, u64, u64)> {
        let out = ffmpeg::run("ffprobe", &[
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pts_time,width,height", "-of", "json",
            path.to_str().unwrap(),
        ])
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        json["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                let pts = f["pts_time"].as_str().and_then(|t| t.parse().ok()).unwrap_or(f64::NAN);
                (pts, f["width"].as_u64().unwrap(), f["height"].as_u64().unwrap())
            })
            .collect()
    }

    /// The NAL units of `path`'s first video sample (4-byte length prefixes).
    fn first_sample_nals(path: &Path) -> Vec<Vec<u8>> {
        let buf = std::fs::read(path).unwrap();
        let (at, len) = sample_spans(&buf, video_stbl(&buf))[0];
        let sample = &buf[at..at + len];
        let mut nals = Vec::new();
        let mut i = 0;
        while i + 4 <= sample.len() {
            let n = be32(sample, i) as usize;
            nals.push(sample[i + 4..i + 4 + n].to_vec());
            i += 4 + n;
        }
        nals
    }

    /// `path`'s packets of `stream` ("v:0", "a:0"): (pts seconds, keyframe).
    fn packets(path: &Path, stream: &str) -> Vec<(f64, bool)> {
        let out = ffmpeg::run("ffprobe", &[
            "-v", "error", "-select_streams", stream,
            "-show_entries", "packet=pts_time,flags", "-of", "json",
            path.to_str().unwrap(),
        ])
        .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        json["packets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let pts = p["pts_time"].as_str().and_then(|t| t.parse().ok()).unwrap_or(f64::NAN);
                (pts, p["flags"].as_str().unwrap_or("").contains('K'))
            })
            .collect()
    }

    /// A display-orientation SEI turning the picture 90 degrees: NAL header
    /// (type 6), payloadType 47, payloadSize 3, then cancel 0, hor_flip 0,
    /// ver_flip 0, anticlockwise_rotation 0x4000 (90 degrees), repetition
    /// period ue(1), extension flag 0 and the payload's stop bit
    /// (08 00 09), then rbsp trailing bits.
    const TURN_90_SEI: [u8; 7] = [0x06, 0x2f, 0x03, 0x08, 0x00, 0x09, 0x80];

    /// THE proof of the repair recipes, on a recording damaged the way a real
    /// one was: an NVIDIA Instant Replay file whose first minute is scrambled
    /// (intact length prefixes, garbage NAL contents) and whose clean section
    /// carries no parameter sets of its own — it relies on the `avcC` header.
    ///
    /// Built deterministically: a clean 320x240 30 fps clip with a sound
    /// track, an IDR every 30 frames, whose parameter sets live ONLY in
    /// `avcC` (checked); then its first 60 samples rewritten in place, sizes
    /// unchanged. Sample 20 carries a 16x32 donor clip's SPS and PPS (what a
    /// garbage NAL that happens to be type 7/8 amounts to). Sample 30 carries
    /// a garbage display-orientation SEI (90 degrees), a junk NAL of an
    /// unspecified type, and an IDR slice of a flat 320x240 frame made with the
    /// same encoder settings — so the header's parameter sets decode it, and
    /// ffmpeg outputs a picture carrying the SEI's display matrix, as on the
    /// real file (an SEI in an access unit that decodes no picture reaches no
    /// frame; measured). The rest are PRNG bytes behind a slice NAL header.
    /// Sample 60 is the clean section's first IDR, at 2.0 s.
    ///
    /// Measured on the bundled ffmpeg (8.1): the plain proxy decodes every
    /// frame at the donor's 16x32; dropping only SPS/PPS gives every frame
    /// TURNED to 240x320 (the first picture's matrix sets the encoder's size);
    /// the repair recipe, which drops the SEI too, gives every frame upright
    /// at 320x240 with the clean section whole. The scan finds the clean IDR
    /// at exactly 2.0 s, and the instant copy starts its video there on a
    /// keyframe with the sound whole, and decodes with no error at all.
    #[test]
    fn a_damaged_recording_decodes_whole_only_without_its_inband_headers() {
        const DAMAGED: usize = 60;
        const DONOR_AT: usize = 20;
        const TURN_AT: usize = 30;
        const CLEAN_FRAMES: usize = 60;
        let dir = std::env::temp_dir().join(format!("taroting repair proof {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = |name: &str| dir.join(name);
        let s = |p: &PathBuf| p.to_str().unwrap().to_string();
        // One encoder setting for the clip and the flat frame, so the flat
        // frame's IDR slice decodes under the clip's own parameter sets.
        const X264: [&str; 10] = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p"];

        let clean = path("clean.mp4");
        let mut args = vec![
            "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        ];
        args.extend(X264);
        let clean_s = s(&clean);
        args.extend(["-c:a", "aac", "-shortest", &clean_s]);
        ffmpeg_ok(&args);
        let donor = path("donor 16x32.mp4");
        ffmpeg_ok(&[
            "-y", "-f", "lavfi", "-i", "testsrc2=size=16x32:rate=30:duration=0.1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", &s(&donor),
        ]);
        let flat = path("flat frame.mp4");
        let mut args = vec!["-y", "-f", "lavfi", "-i", "color=c=0x3366cc:size=320x240:rate=30", "-frames:v", "1"];
        args.extend(X264);
        let flat_s = s(&flat);
        args.push(&flat_s);
        ffmpeg_ok(&args);

        let mut buf = std::fs::read(&clean).unwrap();
        let stbl = video_stbl(&buf);
        let rec = avcc(&buf, stbl);
        assert_eq!(rec[4] & 3, 3, "fixture: 4-byte NAL lengths");
        assert!(rec[5] & 0x1f >= 1, "fixture: the header carries an SPS");
        let spans = sample_spans(&buf, stbl);
        assert_eq!(spans.len(), 120, "fixture: 4 s at 30 fps");
        assert!(
            spans.iter().all(|&(at, len)| nal_types(&buf[at..at + len]).iter().all(|t| *t != 7 && *t != 8)),
            "fixture: no in-band parameter sets anywhere — the header's are the only ones"
        );
        // x264 writes its settings as an SEI in the first sample only, which
        // the damage overwrites: the clean section carries none.
        assert!(
            spans[DAMAGED..].iter().all(|&(at, len)| !nal_types(&buf[at..at + len]).contains(&6)),
            "fixture: no SEI in the clean section"
        );
        assert!(nal_types(&buf[spans[DAMAGED].0..spans[DAMAGED].0 + spans[DAMAGED].1]).contains(&5), "fixture: the clean section opens on an IDR");
        let flat_buf = std::fs::read(&flat).unwrap();
        assert_eq!(param_sets(avcc(&flat_buf, video_stbl(&flat_buf))), param_sets(rec), "fixture: the flat frame shares the clip's parameter sets");
        let flat_idr = first_sample_nals(&flat).into_iter().find(|n| n[0] & 0x1f == 5).expect("fixture: the flat frame's IDR slice");

        let donor_buf = std::fs::read(&donor).unwrap();
        let (sps, pps) = param_sets(avcc(&donor_buf, video_stbl(&donor_buf)));
        let mut rng: u64 = 0x2545_f491_4f6c_dd1d;
        let mut random = |n: usize| {
            (0..n)
                .map(|_| {
                    rng ^= rng << 13;
                    rng ^= rng >> 7;
                    rng ^= rng << 17;
                    rng as u8
                })
                .collect::<Vec<u8>>()
        };
        for (k, &(at, len)) in spans.iter().take(DAMAGED).enumerate() {
            let mut sample = Vec::with_capacity(len);
            let nal = |sample: &mut Vec<u8>, bytes: &[u8]| {
                sample.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                sample.extend_from_slice(bytes);
            };
            if k == DONOR_AT || k == TURN_AT {
                if k == DONOR_AT {
                    nal(&mut sample, &sps);
                    nal(&mut sample, &pps);
                } else {
                    nal(&mut sample, &TURN_90_SEI);
                    // Type 30 is unspecified: decoders skip it, the scan does not.
                    nal(&mut sample, &[&[0x1e][..], &random(16)].concat());
                    nal(&mut sample, &flat_idr);
                }
                let fill = len - sample.len() - 4;
                assert!(fill >= 1, "fixture: sample {k} is big enough");
                sample.extend_from_slice(&(fill as u32).to_be_bytes());
                sample.push(12); // filler data NAL
                sample.resize(len, 0xff);
            } else {
                sample.extend_from_slice(&(len as u32 - 4).to_be_bytes());
                sample.push(0x41); // nal_ref_idc 2, a non-IDR slice
                sample.extend(random(len - 5));
            }
            buf[at..at + len].copy_from_slice(&sample);
        }
        let damaged = path("Replay damaged.mp4");
        std::fs::write(&damaged, &buf).unwrap();
        assert_eq!(sample_spans(&buf, video_stbl(&buf)), spans, "fixture: nothing moved");
        let at = |k: usize| &buf[spans[k].0..spans[k].0 + spans[k].1];
        assert_eq!(nal_types(at(DONOR_AT)), [7, 8, 12], "fixture: the donor's parameter sets in-band");
        assert_eq!(nal_types(at(TURN_AT)), [6, 30, 5, 12], "fixture: the turning SEI on a decodable picture");

        // The header says the filter is safe for it, and not for a stream
        // whose parameter sets are in-band only, nor for one outside an avc1
        // sample entry.
        assert!(probe::h264_param_sets_in_header(&damaged));
        let raw = path("raw stream.h264");
        ffmpeg_ok(&["-y", "-i", &s(&clean), "-map", "0:v", "-c", "copy", "-f", "h264", &s(&raw)]);
        let mkv = path("same stream.mkv");
        ffmpeg_ok(&["-y", "-i", &s(&clean), "-c", "copy", &s(&mkv)]);
        assert!(!probe::h264_param_sets_in_header(&raw), "annex b");
        assert!(!probe::h264_param_sets_in_header(&mkv), "matroska");

        let in_clean_section = |f: &&(f64, u64, u64)| f.0 >= 2.0 - 1.0 / 60.0;
        let sizes = |frames: &[(f64, u64, u64)]| {
            let mut seen: Vec<(u64, u64)> = frames.iter().map(|f| (f.1, f.2)).collect();
            seen.dedup();
            seen
        };

        // (e) The parameter-set trap: the plain proxy believes the donor's
        // SPS, and the clean section comes out at its 16x32 — not one frame
        // at the recording's own size.
        let proxied = path("proxy.mp4");
        run_args(&proxy_args(&damaged, &proxied));
        let frames = decoded_frames(&proxied);
        assert!(frames.iter().any(|f| in_clean_section(&f)), "the trap: the clean section still decodes {frames:?}");
        assert_eq!(sizes(&frames), [(16, 32)], "the trap: every frame at the donor's size");

        // (a) The rotation trap: without the SPS/PPS but with the SEI, the
        // picture it rides on carries a 90-degree display matrix, autorotate
        // turns it, and every frame comes out 240x320 — the clean section
        // whole, but turned.
        let turned = path("repair 7 8.mp4");
        run_args(&proxy_recipe(&damaged, &turned, &["-bsf:v", "filter_units=remove_types=7|8"]));
        let frames = decoded_frames(&turned);
        assert_eq!(frames.iter().filter(in_clean_section).count(), CLEAN_FRAMES, "the trap: decoded {frames:?}");
        assert_eq!(sizes(&frames), [(240, 320)], "the trap: every frame turned");

        // (b) The repair: every frame upright at 320x240, the clean section
        // whole.
        let repaired = path("repair.mp4");
        run_args(&repair_args(&damaged, &repaired, true));
        let frames = decoded_frames(&repaired);
        assert_eq!(sizes(&frames), [(320, 240)], "repaired sizes {frames:?}");
        assert_eq!(frames.iter().filter(in_clean_section).count(), CLEAN_FRAMES, "repaired clean section {frames:?}");

        // (c) The scan finds the clean IDR from the bytes alone: sample 60,
        // 60 * 512 / 15360 s.
        assert_eq!(crate::media::damage::scan_damaged_prefix(&damaged), Some(2.0));
        assert_eq!(crate::media::damage::scan_damaged_prefix(&clean), None, "the clean clip has no damaged prefix");

        // (d) The instant copy from that time: video from 2.0 s on a
        // keyframe, the clean section whole and nothing before it; the sound
        // from 0 to the end; and not one decode error in it.
        let quick = path("quick.mp4");
        run_args(&quick_repair_args(&damaged, &quick, 2.0));
        let video = packets(&quick, "v:0");
        assert_eq!(video.first(), Some(&(2.0, true)), "video starts on the clean keyframe");
        assert_eq!(video.len(), CLEAN_FRAMES, "the clean section, nothing before it");
        let audio = packets(&quick, "a:0");
        let source_audio = packets(&damaged, "a:0");
        assert_eq!(audio.len(), source_audio.len(), "every audio packet");
        assert_eq!(audio.first().map(|a| a.0), source_audio.first().map(|a| a.0), "the sound from its own start");
        assert!(audio.first().is_some_and(|a| a.0 <= 0.0), "the sound from 0: {:?}", audio.first());
        let decode = ffmpeg::command("ffmpeg")
            .unwrap()
            .args(["-hide_banner", "-v", "error", "-i", &s(&quick), "-f", "null", "-"])
            .output()
            .unwrap();
        assert!(decode.status.success());
        assert_eq!(String::from_utf8_lossy(&decode.stderr), "", "the instant copy decodes cleanly");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The scan's time is ffmpeg's time, on a stream whose decode and
    /// presentation times differ: with B-frames the encoder writes composition
    /// offsets (`ctts`) and an edit list shifting them back, so the clean IDR's
    /// offset without the edit, or the edit without its offset, each give a
    /// different number (checked below). The answer must equal the pts
    /// ffprobe reports for that very packet. (Here the IDR's offset equals the
    /// edit, so dropping BOTH terms cancels; the unit tests' fixtures make
    /// every term move the answer.)
    #[test]
    fn the_scan_reads_presentation_time_as_ffmpeg_does() {
        const DAMAGED: usize = 25;
        let dir = std::env::temp_dir().join(format!("taroting scan bframes {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let clean = dir.join("clean bframes.mp4");
        ffmpeg_ok(&[
            "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3",
            "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "25", "-sc_threshold", "0",
            "-pix_fmt", "yuv420p", clean.to_str().unwrap(),
        ]);
        let mut buf = std::fs::read(&clean).unwrap();
        let spans = sample_spans(&buf, video_stbl(&buf));
        let truth = packets(&clean, "v:0");
        // Packets come out in decode order, as samples are stored.
        let (pts, key) = truth[DAMAGED];
        assert!(key && nal_types(&buf[spans[DAMAGED].0..spans[DAMAGED].0 + spans[DAMAGED].1]).contains(&5), "fixture: sample 25 is the second IDR");
        let ctts = child(&buf, video_stbl(&buf), &[b"ctts"]).expect("fixture: B-frames write composition offsets");
        let moov = child(&buf, (0, buf.len()), &[b"moov"]).unwrap();
        let trak = boxes(&buf, moov.0, moov.1).into_iter().find(|(t, _, _)| t == b"trak").unwrap();
        let elst = child(&buf, (trak.1, trak.2), &[b"edts", b"elst"]).expect("fixture: an edit list");
        let media_time = be32(&buf, elst.0 + 12) as i64; // v0: after count and segment_duration
        let timescale = {
            let mdhd = child(&buf, (trak.1, trak.2), &[b"mdia", b"mdhd"]).unwrap();
            be32(&buf, mdhd.0 + 12) as f64
        };
        let dts = 25.0 * 512.0; // stts: one run of 512 ticks (25 fps at 12800)
        let offset = {
            // The IDR's own ctts entry: walk the runs to sample 25.
            let (mut covered, mut i) = (0usize, ctts.0 + 8);
            loop {
                covered += be32(&buf, i) as usize;
                if covered > DAMAGED {
                    break be32(&buf, i + 4) as f64;
                }
                i += 8;
            }
        };
        assert_eq!(timescale, 12800.0, "fixture: the timescale the dts above assumes");
        assert!(media_time > 0 && offset > 0.0, "fixture: both terms present");
        for wrong in [dts + offset, dts - media_time as f64] {
            assert_ne!(wrong / timescale, pts, "fixture: a dropped term would show");
        }

        scramble(&mut buf, &spans[..DAMAGED]);
        let damaged = dir.join("damaged bframes.mp4");
        std::fs::write(&damaged, &buf).unwrap();
        assert_eq!(crate::media::damage::scan_damaged_prefix(&damaged), Some(pts));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `spans`' samples (4-byte NAL lengths) scrambled in place, sizes kept:
    /// sample 0 certainly damaged (the forbidden bit), the rest random bytes
    /// behind a non-IDR slice header. The same bytes for the same spans.
    fn scramble(buf: &mut [u8], spans: &[(usize, usize)]) {
        let mut rng: u64 = 0x9e37_79b9_7f4a_7c15;
        for (k, &(at, len)) in spans.iter().enumerate() {
            buf[at + 4] = if k == 0 { 0xc1 } else { 0x41 };
            for b in &mut buf[at + 5..at + len] {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                *b = rng as u8;
            }
        }
    }

    /// A start offset is an EMPTY edit (media_time -1) at the head of the
    /// edit list, and ffmpeg adds its duration to every pts — which the scan
    /// does not read, so such a file is not answered: it gets the full repair
    /// alone. Before that rule the scan answered 2.0 here, where ffmpeg puts
    /// the clean IDR at 2.5, and the instant copy's seek landed on garbage.
    /// The same clip without the offset, damaged byte for byte the same way,
    /// IS answered — exactly ffprobe's pts — so the empty edit is the only
    /// reason for the `None`.
    #[test]
    fn a_recording_with_a_start_offset_is_not_answered() {
        const DAMAGED: usize = 60;
        let dir = std::env::temp_dir().join(format!("taroting scan offset {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = |p: &PathBuf| p.to_str().unwrap().to_string();
        let clean = dir.join("clean.mp4");
        ffmpeg_ok(&[
            "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0",
            "-pix_fmt", "yuv420p", &s(&clean),
        ]);
        let offset = dir.join("offset.mp4");
        ffmpeg_ok(&["-y", "-itsoffset", "0.5", "-i", &s(&clean), "-c", "copy", &s(&offset)]);

        // (name, file, ffprobe's pts for the clean IDR, whether its edit list
        // holds an empty edit)
        let mut damaged = Vec::new();
        for (name, file, pts, empty_edit) in [("no offset", &clean, 2.0, false), ("offset", &offset, 2.5, true)] {
            let mut buf = std::fs::read(file).unwrap();
            let spans = sample_spans(&buf, video_stbl(&buf));
            assert_eq!(packets(file, "v:0")[DAMAGED], (pts, true), "fixture, {name}: the clean IDR where ffmpeg puts it");
            let moov = child(&buf, (0, buf.len()), &[b"moov"]).unwrap();
            let trak = boxes(&buf, moov.0, moov.1).into_iter().find(|(t, _, _)| t == b"trak").unwrap();
            let edits: Vec<i32> = child(&buf, (trak.1, trak.2), &[b"edts", b"elst"]).map_or(Vec::new(), |elst| {
                assert_eq!(buf[elst.0], 0, "fixture, {name}: elst v0");
                // v0 entries after version/flags and the count: duration,
                // media_time, rate — 12 bytes each.
                (0..be32(&buf, elst.0 + 4) as usize).map(|k| be32(&buf, elst.0 + 8 + 12 * k + 4) as i32).collect()
            });
            assert_eq!(edits.contains(&-1), empty_edit, "fixture, {name}: edits {edits:?}");
            scramble(&mut buf, &spans[..DAMAGED]);
            let out = dir.join(format!("damaged {name}.mp4"));
            std::fs::write(&out, &buf).unwrap();
            damaged.push(out);
        }
        assert_eq!(crate::media::damage::scan_damaged_prefix(&damaged[0]), Some(2.0), "no offset: answered");
        assert_eq!(crate::media::damage::scan_damaged_prefix(&damaged[1]), None, "a start offset: not answered");
        let _ = std::fs::remove_dir_all(&dir);
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
