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

/* --- the same photo as a WebP, which pins whether the webview turns a WebP
   by its EXIF too (ffmpeg does: measured 36x64 on decode). The EXIF chunk
   holds the RAW TIFF block, no "Exif\0\0" prefix — with one, ffmpeg refuses
   the block and does NOT turn the frame. A simple lossy WebP has no room for
   metadata, so its VP8 chunk is rewrapped as an extended file: VP8X (flag
   0x08 = EXIF present, canvas = the coded size) → VP8 verbatim → EXIF, the
   order the container spec gives. The coded size is read back from the VP8
   frame header rather than assumed, so the canvas can never disagree with
   the bitstream. */
function riffChunk(tag, data) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  // RIFF chunks are padded to an even length.
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}
function webpWithOrientation(src, o) {
  if (src.toString("ascii", 0, 4) !== "RIFF" || src.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("not a WebP");
  }
  if (src.toString("ascii", 12, 16) !== "VP8 ") throw new Error("expected a simple lossy WebP");
  const len = src.readUInt32LE(16);
  const vp8 = src.subarray(20, 20 + len);
  // VP8 key frame: 3-byte frame tag, start code 9d 01 2a, then 14-bit sizes.
  if (vp8[3] !== 0x9d || vp8[4] !== 0x01 || vp8[5] !== 0x2a) throw new Error("bad VP8 start code");
  const w = vp8.readUInt16LE(6) & 0x3fff;
  const h = vp8.readUInt16LE(8) & 0x3fff;
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08;
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    riffChunk("VP8X", vp8x),
    riffChunk("VP8 ", vp8),
    riffChunk("EXIF", tiffOrientation(o)),
  ]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
const turnedWebp = path.join(outDir, "photo_o6.webp");
if (!fs.existsSync(turnedWebp)) {
  console.log("create photo_o6.webp");
  const plain = path.join(outDir, "photo_o6.plain.webp");
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x36", "-frames:v", "1",
    "-c:v", "libwebp", "-pix_fmt", "yuv420p", plain,
  ]);
  fs.writeFileSync(turnedWebp, webpWithOrientation(fs.readFileSync(plain), 6));
  fs.rmSync(plain);
}

/* --- the same photo as a PNG, twice: eXIf BEFORE the image data (early, where
   the spec puts it) and AFTER it (late, just before IEND, where some tools
   append it). ffmpeg turns both; WebView2 turns only the early one (measured).
   The exif-orientation-png-* blocks pin that, and exif::read_still in
   src-tauri/src/media/exif.rs decides per file from it. The chunk holds the RAW
   TIFF block — with an "Exif\0\0" prefix ffmpeg fails the whole decode. */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngWithOrientation(src, o, late) {
  if (!src.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("not a PNG");
  }
  const data = tiffOrientation(o);
  const typed = Buffer.concat([Buffer.from("eXIf", "ascii"), data]);
  const exif = Buffer.alloc(12 + data.length);
  exif.writeUInt32BE(data.length, 0);
  typed.copy(exif, 4);
  exif.writeUInt32BE(crc32(typed), 8 + data.length);
  const out = [src.subarray(0, 8)];
  let placed = false;
  for (let i = 8; i < src.length; ) {
    const len = src.readUInt32BE(i);
    const type = src.toString("ascii", i + 4, i + 8);
    if (!placed && type === (late ? "IEND" : "IDAT")) {
      out.push(exif);
      placed = true;
    }
    out.push(src.subarray(i, i + 12 + len));
    i += 12 + len;
  }
  if (!placed) throw new Error("no IDAT/IEND to place the eXIf before");
  return Buffer.concat(out);
}
/* What ffmpeg's autorotate decodes a file to: one frame as a BMP on stdout
   (BMP carries no EXIF of its own), width and height little-endian at 18/22. */
function decodedSize(file) {
  const bmp = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "bmp", "pipe:1",
  ]);
  return [Math.abs(bmp.readInt32LE(18)), Math.abs(bmp.readInt32LE(22))];
}
for (const [name, late] of [["photo_o6_early.png", false], ["photo_o6_late.png", true]]) {
  const target = path.join(outDir, name);
  if (fs.existsSync(target)) {
    console.log(`skip   ${name}`);
    continue;
  }
  console.log(`create ${name}`);
  const plain = path.join(outDir, name.replace(".png", ".plain.png"));
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x36", "-frames:v", "1", plain,
  ]);
  fs.writeFileSync(target, pngWithOrientation(fs.readFileSync(plain), 6, late));
  fs.rmSync(plain);
  // A chunk ffmpeg does not read would leave both the probe and the webview
  // at 64x36, and the E2E block would go green having measured nothing.
  const [w, h] = decodedSize(target);
  if (w !== 36 || h !== 64) {
    fs.rmSync(target);
    throw new Error(`${name}: ffmpeg decodes it ${w}x${h}, not 36x64 — its eXIf is not being read`);
  }
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

/* --- viewer folder: one folder the viewer steps through (src/dev/autotest-viewer.ts).
   Every media file has its OWN pixel size, so a block that reads the rendered
   element's natural size knows exactly which file is on screen — a stepper
   that skipped or repeated one cannot land on a matching number. The names
   pin natural order (clip2 < clip10), case-insensitivity (Clip11, IMG_7.JPG)
   and a space in a name; the last five entries must NEVER be stepped onto.
   Visual family in Explorer's order: clip2, clip10, Clip11, d, IMG_7, phone,
   w, z still (8). Audio family: a1, a2 (2). All tiny (< 200 KB together). */
const viewerDir = path.join(outDir, "viewer");
fs.mkdirSync(viewerDir, { recursive: true });
const vw = (name) => `viewer/${name}`;
// H.264 + AAC in MP4: plays directly. The only viewer file with an audio track
// in the visual family besides Clip11, so the autotest mute has something to mute.
run(vw("clip2.mp4"), [
  "-f", "lavfi", "-i", "testsrc2=size=96x54:rate=30:duration=1",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-shortest",
]);
run(vw("clip10.mp4"), [
  "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=30:duration=1",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
]);
// The same codecs in a QuickTime container: classify says containerOnly, so
// the viewer tries it directly first. Whether WebView2 plays it that way or
// falls back to a remux is recorded by the viewer-natural-order block.
run(vw("Clip11.mov"), [
  "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1",
  "-f", "lavfi", "-i", "sine=frequency=523:duration=1",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-shortest", "-f", "mov",
]);
run(vw("d.gif"), ["-f", "lavfi", "-i", "testsrc2=size=48x32:rate=12:duration=1"]);
// Upper-case extension on purpose; the muxer and codec are named because
// nothing should hang on ffmpeg matching ".JPG" by itself.
run(vw("IMG_7.JPG"), [
  "-f", "lavfi", "-i", "testsrc2=size=200x150", "-frames:v", "1",
  "-f", "image2", "-c:v", "mjpeg",
]);
// A portrait phone clip in miniature: CODED 80x44, display matrix 90°. The
// webview shows it upright, so its <video> natural size is portrait.
const phone = path.join(viewerDir, "phone.mp4");
if (!fs.existsSync(phone)) {
  console.log("create viewer/phone.mp4");
  // The intermediate lives OUTSIDE viewer/: a run that dies between the two
  // calls would otherwise leave a ninth playable clip in the folder, and every
  // counter the viewer blocks assert would be off by one.
  const plain = path.join(outDir, "viewer-phone.plain.mp4");
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=80x44:rate=30:duration=1",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", plain,
  ]);
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-display_rotation", "90", "-i", plain, "-c", "copy", phone,
  ]);
  fs.rmSync(plain);
}
// WMV2 has no web decoder: the proxy class, i.e. the "Prepare preview" button.
run(vw("w.wmv"), [
  "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=30:duration=1",
  "-c:v", "wmv2",
]);
// Smaller than any stage, so object-fit: scale-down leaves it at 30x20.
run(vw("z still.png"), ["-f", "lavfi", "-i", "testsrc2=size=30x20", "-frames:v", "1"]);
// Different durations, so a block can tell which of the two is loaded.
run(vw("a1.mp3"), ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-q:a", "4"]);
run(vw("a2.wav"), ["-f", "lavfi", "-i", "sine=frequency=349:duration=2", "-ar", "8000", "-c:a", "pcm_s16le"]);
// Everything below must be skipped by the sibling listing.
const notes = path.join(viewerDir, "notes.txt");
if (!fs.existsSync(notes)) fs.writeFileSync(notes, "not media\n");
const appleDouble = path.join(viewerDir, "._clip2.mp4");
if (!fs.existsSync(appleDouble)) fs.writeFileSync(appleDouble, Buffer.alloc(16, 0x5a));
fs.mkdirSync(path.join(viewerDir, "sub.mp4"), { recursive: true });
// A real, playable clip that only the Hidden attribute keeps out of the list —
// so a listing that ignored the attribute would step onto it and play it.
const hidden = path.join(viewerDir, "hidden.mp4");
if (!fs.existsSync(hidden)) {
  console.log("create viewer/hidden.mp4 (+h)");
  fs.copyFileSync(path.join(viewerDir, "clip2.mp4"), hidden);
}
// Every run, not only on creation: a copied or restored fixture folder can
// lose the attribute, and then every viewer counter reads "/ 9". Setting it
// on a file that already has it is a no-op.
if (process.platform === "win32") execFileSync("attrib", ["+h", hidden]);

console.log("fixtures ready at", outDir);
