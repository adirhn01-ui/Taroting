#!/usr/bin/env node
// Generates synthetic test media into tests/fixtures/ (gitignored) using the
// ffmpeg sidecar. Everything is lavfi-based — no binary assets in the repo.
//
//   node scripts/make-fixtures.mjs          # standard set (small, fast)
//   node scripts/make-fixtures.mjs --soak   # + 30-min A/V sync soak file
//   node scripts/make-fixtures.mjs --big    # + ~4GB Range-seek stress file

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ffmpeg = path.join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
const ffprobe = path.join(root, "src-tauri", "binaries", "ffprobe-x86_64-pc-windows-msvc.exe");
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

/* --- a damaged recording in miniature: the shape of a real NVIDIA Instant
   Replay file whose first minute is scrambled. H.264 'avc1' in MP4 with its
   parameter sets ONLY in the avcC header, AAC audio intact; the first 60
   samples keep their 4-byte length prefixes but carry garbage (forced
   nal_unit_type 1, xorshift payload) and stay flagged sync; from sample 60
   (2.0 s) the stream is clean, an IDR every 30 frames, no in-band SPS/PPS.
   One garbage sample (10) instead holds a VALID SPS and PPS taken from a
   16x32 encode's avcC, padded out with a filler NAL: the parameter-set trap.
   ffmpeg believes them, so every clean slice after them (they all name PPS 0)
   decodes as 16x32. Both are needed: ffmpeg 8 binds a PPS to the SPS it was
   parsed against, so an SPS alone re-sizes nothing (measured: no trap).
   512x384, not smaller: Chromium picks its first H.264 decoder by height.
   Under 360 lines it tries FFmpegVideoDecoder first and falls back to D3D11,
   which swallowed the garbage silently (0 frames, NO error: a preview that
   never learns the file is broken, so nothing to repair); from 360 up it tries
   D3D11 first, which fails reconfiguring for the 16x32 SPS, falls back to
   FFmpegVideoDecoder, and that rejects packet #2 — PIPELINE_ERROR_DECODE,
   MediaError 3, the real file's exact sequence (Chrome 154, measured).
   Rewritten IN PLACE (no sample changes size, so stsz/stco stay true) from
   one fixed seed. Both x264 encodes run with ONE thread: x264's output follows
   its thread count, and the default follows the core count (measured: 8 and
   2 cores gave different bytes and a different trap tally), so another
   machine would get video Chromium was never measured on. Single-threaded,
   with the ffmpeg build fetch-ffmpeg pins, the video samples came out the
   same at x264's SSE4.2, AVX2 and AVX-512 levels (measured on one AMD CPU).
   The AAC packets do not: they differ on a CPU without AVX2/FMA3 (measured
   by masking them off), so there the file differs while its video does not.
   So the E2E's refusal guard, not the sha256 this prints, is what proves a
   regenerated fixture still reproduces.
   One more garbage sample (43) opens with a well-formed SEI carrying a
   display-orientation message (payload 47: 90 degrees anticlockwise,
   repeating), the real file's second trap: ffmpeg attaches the display matrix
   to the frame that slice conceals and to EVERY frame after it, and its
   autorotate turns them all, so a repair that keeps in-band SEI comes out
   sideways (the owner's copy came out turned and sheared; from this fixture
   ffmpeg scales the turned frames back into 512x384, so the size of the
   repair alone never shows it — measured).
   The SEI must sit in front of a slice in the same sample: alone in a sample,
   or beside the donor's SPS/PPS, it turned nothing (measured, ffmpeg 8.1).
   The slice keeps the random bytes the sample had, and the generator draws
   exactly as many as before, so every other sample is byte-for-byte the
   previous fixture's — the first 43, which Chromium refuses, included.
   Checked on creation and refused unless (a) x264's own options SEI says
   both encodes ran single-threaded, (b) a plain decode falls into the
   parameter-set trap, (c) a decode through filter_units=remove_types=7|8
   (SPS/PPS gone, the SEI kept) gives every one of the 60 clean-tail frames
   turned, 384x512, and (d) the repair decode — remove_types=6|7|8 — gives
   every frame at 512x384 and all 60 frames of the clean tail. */
const DAMAGED_W = 512;
const DAMAGED_H = 384;
const DAMAGED_SAMPLES = 60;
const DAMAGED_DONOR_AT = 10;
const DAMAGED_SEI_AT = 43;
/** An H.264 SEI NAL (type 6, nal_ref_idc 0) holding one display_orientation
 *  message (payloadType 47, payloadSize 3): cancel 0, hor_flip 0, ver_flip 0,
 *  anticlockwise_rotation 0x4000 (90 degrees), repetition_period ue(1) = 010,
 *  extension 0, then the payload's alignment 1-bit — 0x08 0x00 0x09 — and the
 *  rbsp stop bit. No emulation-prevention byte is needed (no 00 00 0x run). */
const ORIENTATION_SEI = Buffer.from([0x06, 0x2f, 0x03, 0x08, 0x00, 0x09, 0x80]);

/** The ISO-BMFF boxes directly inside [start, end) of `buf`. */
function mp4Boxes(buf, start, end) {
  const out = [];
  for (let i = start; i + 8 <= end; ) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    let head = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(i + 8));
      head = 16;
    } else if (size === 0) size = end - i;
    if (size < head || i + size > end) throw new Error(`bad ${type} box at ${i}`);
    out.push({ type, body: i + head, end: i + size });
    i += size;
  }
  return out;
}
function mp4Child(buf, box, type) {
  const b = mp4Boxes(buf, box.body, box.end).find((c) => c.type === type);
  if (!b) throw new Error(`no ${type} box inside ${box.type}`);
  return b;
}
/** The video track of an MP4 in `buf`: its avcC parameter sets and NAL length
 *  size, and every sample's file offset and size (stsz + stco/co64 + stsc). */
function mp4VideoSamples(buf) {
  const moov = mp4Boxes(buf, 0, buf.length).find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov box");
  for (const trak of mp4Boxes(buf, moov.body, moov.end).filter((b) => b.type === "trak")) {
    const mdia = mp4Child(buf, trak, "mdia");
    const hdlr = mp4Child(buf, mdia, "hdlr");
    if (buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide") continue;
    const stbl = mp4Child(buf, mp4Child(buf, mdia, "minf"), "stbl");
    const stsd = mp4Child(buf, stbl, "stsd");
    // The repair is spec-safe only for avc1 (parameter sets in avcC); an avc3
    // stream carries them in-band only, so this fixture must be avc1.
    const entry = mp4Boxes(buf, stsd.body + 8, stsd.end)[0];
    if (entry?.type !== "avc1") throw new Error(`sample entry ${entry?.type}, not avc1`);
    // A VisualSampleEntry's fixed fields take 78 bytes before its child boxes.
    const avcC = mp4Boxes(buf, entry.body + 78, entry.end).find((b) => b.type === "avcC");
    if (!avcC) throw new Error("no avcC box");
    const c = buf.subarray(avcC.body, avcC.end);
    let p = 6;
    const sets = (n) =>
      Array.from({ length: n }, () => {
        const len = c.readUInt16BE(p);
        const unit = Buffer.from(c.subarray(p + 2, p + 2 + len));
        p += 2 + len;
        return unit;
      });
    const sps = sets(c[5] & 0x1f);
    const pps = sets(c[p++]);
    const stsz = mp4Child(buf, stbl, "stsz");
    const fixed = buf.readUInt32BE(stsz.body + 4);
    const count = buf.readUInt32BE(stsz.body + 8);
    const sizes = Array.from({ length: count }, (_, i) => fixed || buf.readUInt32BE(stsz.body + 12 + 4 * i));
    const stco = mp4Boxes(buf, stbl.body, stbl.end).find((b) => b.type === "stco" || b.type === "co64");
    if (!stco) throw new Error("no stco/co64 box");
    const chunkAt = (i) =>
      stco.type === "stco" ? buf.readUInt32BE(stco.body + 8 + 4 * i) : Number(buf.readBigUInt64BE(stco.body + 8 + 8 * i));
    const stsc = mp4Child(buf, stbl, "stsc");
    const runs = Array.from({ length: buf.readUInt32BE(stsc.body + 4) }, (_, i) => ({
      first: buf.readUInt32BE(stsc.body + 8 + 12 * i),
      per: buf.readUInt32BE(stsc.body + 12 + 12 * i),
    }));
    const offsets = [];
    const chunks = buf.readUInt32BE(stco.body + 4);
    for (let chunk = 1, r = 0; chunk <= chunks; chunk++) {
      while (r + 1 < runs.length && runs[r + 1].first <= chunk) r++;
      let at = chunkAt(chunk - 1);
      for (let k = 0; k < runs[r].per && offsets.length < count; k++) {
        offsets.push(at);
        at += sizes[offsets.length - 1];
      }
    }
    if (offsets.length !== count) throw new Error(`${offsets.length} sample offsets for ${count} samples`);
    return { lengthSize: (c[4] & 3) + 1, sps, pps, sizes, offsets };
  }
  throw new Error("no video track");
}
/** Every decoded video frame of `file` (showinfo), optionally through input
 *  bitstream filters given BEFORE -i, the way the repair decode applies them. */
function decodedFrames(file, inputBsf) {
  const r = spawnSync(
    ffmpeg,
    [
      "-hide_banner", "-nostats",
      ...(inputBsf ? ["-bsf:v", inputBsf] : []),
      "-i", file, "-map", "0:v", "-vf", "showinfo", "-f", "null", "-",
    ],
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.stderr.slice(-400)}`);
  return Array.from(r.stderr.matchAll(/pts_time:\s*([\d.]+).*? s:(\d+)x(\d+)/g), (m) => ({
    t: Number(m[1]),
    size: `${m[2]}x${m[3]}`,
  }));
}
/** The thread count a libx264 encode in `buf` actually ran with, read from the
 *  options string x264 writes into its first access unit; null without one. */
function x264Threads(buf) {
  const m = buf.toString("latin1").match(/ threads=(\d+) lookahead_threads=\d+ /);
  return m ? Number(m[1]) : null;
}
const damaged = path.join(outDir, "damaged_h264.mp4");
if (fs.existsSync(damaged)) {
  console.log("skip   damaged_h264.mp4");
} else {
  console.log("create damaged_h264.mp4");
  const clean = path.join(outDir, "damaged_h264.clean.mp4");
  const donorFile = path.join(outDir, "damaged_h264.donor.mp4");
  try {
    // -g/-keyint_min/-sc_threshold pin an IDR at every 30th sample, so 60 is
    // one; -bf 0 keeps decode order == display order, so "the tail from
    // 2.0 s" is exactly samples 60-119.
    execFileSync(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=${DAMAGED_W}x${DAMAGED_H}:rate=30:duration=4`,
      "-f", "lavfi", "-i", "sine=frequency=587:duration=4",
      "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0",
      "-c:a", "aac", "-shortest", clean,
    ]);
    // x264's default already runs a frame only 32 lines tall on one thread
    // (measured); the flag keeps that true if the donor ever grows.
    execFileSync(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=16x32:rate=30:duration=0.2",
      "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "30", "-bf", "0",
      donorFile,
    ]);
    const donorBuf = fs.readFileSync(donorFile);
    const donor = mp4VideoSamples(donorBuf);
    const buf = fs.readFileSync(clean);
    // Read before the rewrite below: sample 0, which carries x264's options
    // string, is one of the samples it overwrites.
    for (const [which, b] of [["clean", buf], ["donor", donorBuf]]) {
      const threads = x264Threads(b);
      if (threads !== 1) {
        throw new Error(`damaged_h264.mp4: the ${which} encode ran x264 with threads=${threads ?? "?"}, not 1, so its bytes follow this machine's core count`);
      }
    }
    const track = mp4VideoSamples(buf);
    const L = track.lengthSize;
    let seed = 0x7a2f;
    const nextByte = () => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed & 0xff;
    };
    for (let i = 0; i < DAMAGED_SAMPLES; i++) {
      const at = track.offsets[i];
      const end = at + track.sizes[i];
      if (i === DAMAGED_DONOR_AT) {
        let p = at;
        for (const unit of [donor.sps[0], donor.pps[0]]) {
          buf.writeUIntBE(unit.length, p, L);
          unit.copy(buf, p + L);
          p += L + unit.length;
        }
        // Filler data (type 12): 0xff bytes and the rbsp stop bit.
        const fill = end - p - L;
        if (fill < 2) throw new Error(`sample ${i} is too small to carry the donor parameter sets`);
        buf.writeUIntBE(fill, p, L);
        buf[p + L] = 0x0c;
        buf.fill(0xff, p + L + 1, end - 1);
        buf[end - 1] = 0x80;
        continue;
      }
      for (let p = at, first = true; p < end; first = false) {
        const len = buf.readUIntBE(p, L);
        if (len < 1 || p + L + len > end) throw new Error(`sample ${i}: NAL length ${len} overruns the sample`);
        // Drawn whole even where fewer are written, so the generator stays in
        // step and every later sample keeps the previous fixture's bytes.
        const noise = Array.from({ length: len - 1 }, nextByte);
        let slice = p;
        let sliceLen = len;
        if (i === DAMAGED_SEI_AT && first) {
          // The SEI first, then the slice it rides on in the rest of the
          // NAL's space: the SEI turns frames only when a slice follows it.
          sliceLen = len - L - ORIENTATION_SEI.length;
          if (sliceLen < 2) throw new Error(`sample ${i}: its first NAL is too small to carry the orientation SEI`);
          buf.writeUIntBE(ORIENTATION_SEI.length, p, L);
          ORIENTATION_SEI.copy(buf, p + L);
          slice = p + L + ORIENTATION_SEI.length;
          buf.writeUIntBE(sliceLen, slice, L);
        }
        buf[slice + L] = 0x41; // forbidden 0, nal_ref_idc 2, nal_unit_type 1
        for (let k = 1; k < sliceLen; k++) buf[slice + L + k] = noise[k - 1];
        p += L + len;
      }
    }
    fs.writeFileSync(damaged, buf);
    const want = `${DAMAGED_W}x${DAMAGED_H}`;
    const turned = `${DAMAGED_H}x${DAMAGED_W}`;
    // The clean tail is samples 60-119: 2.0 s on, one frame each.
    const tailAt = (frames, size) => frames.filter((f) => f.t >= 2 - 1e-3 && f.size === size).length;
    const tally = (frames) => {
      const by = {};
      for (const f of frames) by[f.size] = (by[f.size] ?? 0) + 1;
      return Object.entries(by).map(([s, n]) => `${n} at ${s}`).join(", ");
    };
    const plain = decodedFrames(damaged, null);
    const keptSei = decodedFrames(damaged, "filter_units=remove_types=7|8");
    const repaired = decodedFrames(damaged, "filter_units=remove_types=6|7|8");
    const problems = [];
    if (!plain.some((f) => f.size !== want) || tailAt(plain, want) >= 60) {
      problems.push(`a plain decode does not fall into the parameter-set trap (${tally(plain)}; ${tailAt(plain, want)} tail frames at ${want})`);
    }
    if (tailAt(keptSei, turned) !== 60) {
      problems.push(`a decode that keeps the SEI does not turn the clean tail (${tally(keptSei)}; ${tailAt(keptSei, turned)} of 60 tail frames at ${turned})`);
    }
    if (repaired.some((f) => f.size !== want) || tailAt(repaired, want) !== 60) {
      problems.push(`the repair decode is not whole and upright (${tally(repaired)}; ${tailAt(repaired, want)} of 60 tail frames at ${want})`);
    }
    // The first clean IDR, read back from the container: the time the backend's
    // damage scan must answer and the instant copy's video starts from.
    const packets = execFileSync(ffprobe, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", damaged,
      // stderr captured, not inherited: ffprobe's stream probe decodes the
      // garbage and would print a screen of decoder complaints on every create.
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/);
    const [idrPts, idrFlags] = (packets[DAMAGED_SAMPLES] ?? "").split(",");
    if (!idrFlags?.startsWith("K")) {
      problems.push(`packet ${DAMAGED_SAMPLES} is "${packets[DAMAGED_SAMPLES] ?? "missing"}", not the keyframe the clean tail starts with`);
    }
    if (problems.length) {
      fs.rmSync(damaged);
      throw new Error(`damaged_h264.mp4: ${problems.join("; ")}`);
    }
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    console.log(`       plain decode: ${tally(plain)}, ${tailAt(plain, want)}/60 tail frames at ${want}`);
    console.log(`       SEI kept (7|8): ${tally(keptSei)}, ${tailAt(keptSei, turned)}/60 tail frames turned to ${turned}`);
    console.log(`       repaired (6|7|8): ${tally(repaired)}, ${tailAt(repaired, want)}/60 tail frames at ${want}`);
    console.log(`       first clean IDR: packet ${DAMAGED_SAMPLES}, pts ${idrPts} s; sha256 ${sha256}`);
  } finally {
    fs.rmSync(clean, { force: true });
    fs.rmSync(donorFile, { force: true });
  }
}

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

/* --- image projects (src/dev/autotest-image.ts). Written byte by byte, not
   through lavfi: the colour source and drawbox work in YUV 4:2:0, and that
   round trip at odd sizes moves a flat colour by a unit or two, while the E2E
   compares decoded pixels at ±1. Sizes and colours differ on every axis
   (641 ≠ 361, 97 ≠ 61; no quadrant shares its colour with a neighbour), so a
   transposed canvas, a swapped quadrant or a dropped alpha channel cannot land
   on a matching number. Each file is decoded back through ffmpeg on creation
   and refused if a pixel is not what the blocks expect. */
const { deflateSync } = await import("node:zlib");
function pngOf(w, h, channels, pixelAt) {
  const rowLen = 1 + w * channels;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const px = pixelAt(x, y);
      for (let c = 0; c < channels; c++) raw[y * rowLen + 1 + x * channels + c] = px[c];
    }
  }
  const chunk = (type, data) => {
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc32(typed), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // RGBA : RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** ffmpeg's own decode of `file` as RGBA, and a pixel reader over it. */
function rgbaOf(file, w) {
  const buf = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  return (x, y) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
}
function imageFixture(name, w, h, channels, pixelAt, checks) {
  const target = path.join(outDir, name);
  if (fs.existsSync(target)) {
    console.log(`skip   ${name}`);
    return;
  }
  console.log(`create ${name}`);
  fs.writeFileSync(target, pngOf(w, h, channels, pixelAt));
  const at = rgbaOf(target, w);
  for (const [x, y, want] of checks) {
    const got = at(x, y);
    if (got.some((v, i) => v !== want[i])) {
      fs.rmSync(target);
      throw new Error(`${name}: ffmpeg decodes (${x},${y}) as ${got.join(",")}, not ${want.join(",")}`);
    }
  }
}
// 641x361: TL 320x180 (224,64,32), BR 321x181 (32,192,96), TR and BL the
// background (32,64,128).
const GRID_TL = [224, 64, 32];
const GRID_BR = [32, 192, 96];
const GRID_BG = [32, 64, 128];
imageFixture(
  "image_grid_641x361.png", 641, 361, 3,
  (x, y) => (x < 320 && y < 180 ? GRID_TL : x >= 320 && y >= 180 ? GRID_BR : GRID_BG),
  [
    [0, 0, [...GRID_TL, 255]], [319, 179, [...GRID_TL, 255]],
    [320, 180, [...GRID_BR, 255]], [640, 360, [...GRID_BR, 255]],
    [640, 0, [...GRID_BG, 255]], [0, 360, [...GRID_BG, 255]],
  ],
);
// 97x61, one colour (48,80,160); columns 0-39 fully transparent. The
// transparent pixels keep the SAME blue, so a path that drops the alpha shows
// blue there, never the white a JPEG flattens transparency onto.
const ALPHA_RGB = [48, 80, 160];
imageFixture(
  "image_alpha_97x61.png", 97, 61, 4,
  (x) => [...ALPHA_RGB, x < 40 ? 0 : 255],
  [
    [0, 0, [...ALPHA_RGB, 0]], [39, 60, [...ALPHA_RGB, 0]],
    [40, 0, [...ALPHA_RGB, 255]], [96, 60, [...ALPHA_RGB, 255]],
  ],
);

console.log("fixtures ready at", outDir);
