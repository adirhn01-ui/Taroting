#!/usr/bin/env node
// Generates synthetic test media into tests/fixtures/ (gitignored) using the
// ffmpeg sidecar. Everything is lavfi-based — no binary assets in the repo.
//
//   node scripts/make-fixtures.mjs          # standard set (small, fast)
//   node scripts/make-fixtures.mjs --soak   # + 30-min A/V sync soak file
//   node scripts/make-fixtures.mjs --big    # + ~4GB Range-seek stress file

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ffmpeg = path.join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
const outDir = path.join(root, "tests", "fixtures");
fs.mkdirSync(outDir, { recursive: true });

const soak = process.argv.includes("--soak");
const big = process.argv.includes("--big");

function run(name, args, opts = {}) {
  const target = path.join(outDir, name);
  if (fs.existsSync(target)) {
    console.log(`skip   ${name}`);
    return target;
  }
  console.log(`create ${name}`);
  execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args, target], {
    stdio: ["ignore", "inherit", "inherit"],
    ...opts,
  });
  return target;
}

/* --- frame accuracy: burnt-in frame counter, 60s @ 30fps ---
   explicit fontfile bypasses fontconfig (which crashes in relocated gyan
   builds); cwd = fonts dir so the path needs no filter-escaping */
run(
  "counter_h264.mp4",
  [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=60",
    "-vf", "drawtext=fontfile=consola.ttf:text='%{frame_num}':fontsize=120:x=40:y=40:fontcolor=white:box=1:boxcolor=black@0.8",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "30",
  ],
  { cwd: "C:\\Windows\\Fonts" },
);

/* --- embedded-video audio: the same burnt-in counter WITH a muxed AAC tone
   track, 20s @ 30fps. counter_h264.mp4 is deliberately video-only, so this is
   the ONLY fixture exercising the embedded-video-audio path (plain H.264 + AAC,
   Decision::Direct — the exact shape of the user's file). Same explicit-fontfile
   gotcha as above; input 1 is a 440Hz sine auto-selected as the audio stream. */
run(
  "counter_audio_h264.mp4",
  [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
    "-vf", "drawtext=fontfile=consola.ttf:text='%{frame_num}':fontsize=120:x=40:y=40:fontcolor=white:box=1:boxcolor=black@0.8",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "30",
    "-c:a", "aac", "-shortest",
  ],
  { cwd: "C:\\Windows\\Fonts" },
);

/* --- playback decision matrix --- */
const direct = run("direct_h264.mp4", [
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=30",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-shortest",
]);

if (!fs.existsSync(path.join(outDir, "remux_h264.mkv"))) {
  console.log("create remux_h264.mkv");
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", direct, "-c", "copy", path.join(outDir, "remux_h264.mkv"),
  ]);
}

run("proxy_hevc.mkv", [
  "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=15",
  "-f", "lavfi", "-i", "sine=frequency=550:duration=15",
  "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-shortest",
]);

run("legacy_xvid.avi", [
  "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=10",
  "-c:v", "mpeg4", "-q:v", "5",
]);

run("web_vp9.webm", [
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=10",
  "-f", "lavfi", "-i", "sine=frequency=660:duration=10",
  "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M",
  "-c:a", "libopus", "-shortest",
]);

run("anim.gif", [
  "-f", "lavfi", "-i", "testsrc2=size=480x270:rate=12:duration=5",
]);

/* --- audio --- */
run("tone.mp3", ["-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:a", "libmp3lame", "-q:a", "4"]);
run("tone.flac", ["-f", "lavfi", "-i", "sine=frequency=523:duration=30", "-c:a", "flac"]);
run("tone.wav", ["-f", "lavfi", "-i", "sine=frequency=349:duration=30", "-c:a", "pcm_s16le"]);
run("tone.aac", ["-f", "lavfi", "-i", "sine=frequency=392:duration=30", "-c:a", "aac"]);

/* --- stills + sequence --- */
run("photo.png", ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1:duration=1", "-frames:v", "1"]);

/* --- EXIF orientation: a portrait phone photo in miniature. CODED 64x36
   landscape, tagged orientation 6 (turn 90° clockwise), which ffmpeg's
   autorotate and the webview both show as 36x64 — pins probe ↔ decoder ↔ <img>
   parity for turned stills. ffmpeg will not write the tag itself, so the frame
   is encoded plain and an APP1 "Exif" segment is spliced in right after SOI,
   dropping the JFIF APP0: the exact layout a camera writes. */
function tiffOrientation(o) {
  // Big-endian TIFF header + IFD0 holding one SHORT entry, 0x0112 = o.
  const b = Buffer.alloc(26);
  b.write("MM", 0, "ascii");
  b.writeUInt16BE(42, 2);
  b.writeUInt32BE(8, 4);
  b.writeUInt16BE(1, 8);
  b.writeUInt16BE(0x0112, 10);
  b.writeUInt16BE(3, 12);
  b.writeUInt32BE(1, 14);
  b.writeUInt16BE(o, 18);
  b.writeUInt32BE(0, 22);
  return b;
}
function jpegWithOrientation(src, o) {
  if (src[0] !== 0xff || src[1] !== 0xd8) throw new Error("not a JPEG");
  const kept = [];
  let i = 2;
  while (i < src.length) {
    if (src[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`);
    const m = src[i + 1];
    if (m === 0xda) {
      kept.push(src.subarray(i)); // SOS: the rest verbatim
      break;
    }
    const len = src.readUInt16BE(i + 2);
    if (m !== 0xe0) kept.push(src.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiffOrientation(o)]);
  const app1 = Buffer.from([0xff, 0xe1, 0, 0]);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, ...kept]);
}
const turned = path.join(outDir, "photo_o6.jpg");
if (!fs.existsSync(turned)) {
  console.log("create photo_o6.jpg");
  const plain = path.join(outDir, "photo_o6.plain.jpg");
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x36", "-frames:v", "1", plain,
  ]);
  fs.writeFileSync(turned, jpegWithOrientation(fs.readFileSync(plain), 6));
  fs.rmSync(plain);
}
const seqDir = path.join(outDir, "png_sequence");
if (!fs.existsSync(seqDir)) {
  console.log("create png_sequence/ (90 frames)");
  fs.mkdirSync(seqDir, { recursive: true });
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
    path.join(seqDir, "frame_%04d.png"),
  ]);
}

/* --- A/V sync soak: white flash + beep every 10s --- */
if (soak) {
  run("sync_soak_30min.mp4", [
    "-f", "lavfi", "-i",
    "testsrc2=size=640x360:rate=30:duration=1800,drawbox=enable='lt(mod(t\\,10)\\,0.1)':color=white:t=fill",
    "-f", "lavfi", "-i",
    "sine=frequency=1000:duration=1800",
    "-af", "volume=enable='gte(mod(t\\,10)\\,0.1)':volume=0",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
  ]);
}

/* --- ~4GB Range-seek stress file (H264, ~35 min at high bitrate) --- */
if (big) {
  run("big_range_test.mp4", [
    "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30:duration=1200",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "26M", "-pix_fmt", "yuv420p",
  ]);
}

console.log("fixtures ready at", outDir);
