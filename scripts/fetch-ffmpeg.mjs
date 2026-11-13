#!/usr/bin/env node
// Installs the FFmpeg sidecars into src-tauri/binaries/: ffmpeg + ffprobe
// under Tauri's target-triple naming convention for external binaries, and
// beside them the FFmpeg libraries both exes link (avcodec-62.dll and the
// rest), each under its own name. Those filenames are load-bearing:
// bundle.externalBin in src-tauri/tauri.conf.json resolves a sidecar by the
// exact `-x86_64-pc-windows-msvc.exe` suffix, bundle.resources lists every
// library by name, and the Windows loader looks for each library in the
// folder of the exe it starts. Nothing here may rename or restructure the
// output.
//
// The build is PINNED in scripts/ffmpeg-pin.json (shared with the tests).
// Every byte that ships is decided there and checked against SHA-256 twice:
// once on the archive before anything is unpacked, once per extracted member
// before it is allowed near the output dir. Any mismatch is fatal and leaves
// whatever was already installed untouched. Only the final renames (a file
// held open by a running sidecar) or the last gate on the installed files can
// fail after something changed, and their messages say so.
//
// This deliberately never takes ffmpeg off PATH. "Whichever build the machine
// happened to have" is how two builds of Taroting end up behaving differently
// over a codec detail that nobody can reproduce months later.
//
// Usage:
//   node scripts/fetch-ffmpeg.mjs                    download the pinned archive
//   node scripts/fetch-ffmpeg.mjs --archive <zip>    install from a copy on disk
//   TAROTING_FFMPEG_ARCHIVE=<zip> node scripts/fetch-ffmpeg.mjs   (the same)
//   node scripts/fetch-ffmpeg.mjs --place <dir>      put the installed set beside
//                                                    a taroting.exe in <dir>
// An archive on disk is held to the same size and SHA-256 as a download.
// `--place` never downloads: it copies the verified files from
// src-tauri/binaries into <dir> as a release folder holds them (ffmpeg.exe,
// ffprobe.exe, every library), libraries first, each checked against the pin,
// then runs the gate there. A release taroting.exe runs the ffmpeg.exe beside
// it, so a folder with a new taroting.exe and an older FFmpeg tests the older
// one; scripts/tauri.mjs runs this on target/release after a release build.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/* --- the pin ---------------------------------------------------------------
   scripts/ffmpeg-pin.json. The build is gyan.dev's 8.1.1 "full_build-shared":
   the same source, compiler and configure line as the full static build
   Taroting carried before, linked as two small exes and seven libraries that
   both share, instead of two exes that each embedded every library.

   Source is the GitHub release asset rather than
   https://www.gyan.dev/ffmpeg/builds/packages/… — gyan.dev's own package
   directory is pruned as builds age, while a published release asset is
   immutable and stays reachable, so these digests keep meaning something
   years from now.

   The .zip is pinned in preference to the smaller .7z of the same build
   because zip is the format Windows can unpack two independent ways —
   tar.exe/libarchive and Expand-Archive — whereas reading the .7z needs a
   tar.exe built with liblzma.

   Moving to a newer FFmpeg means changing every field there together. The
   digests are the entire point of the file: never resolve a mismatch by
   pasting in the hash of whatever was just downloaded. */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pinFile = path.join(root, "scripts", "ffmpeg-pin.json");
const PIN = JSON.parse(fs.readFileSync(pinFile, "utf8"));
const pinName = path.relative(root, pinFile).replaceAll("\\", "/");

/** Every member, libraries first: they are renamed into place before the
 *  exes, so a half-finished install never has a new exe without its
 *  libraries. */
const MEMBERS = Object.entries(PIN.members)
  .map(([name, m]) => ({ name, ...m }))
  .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dll" ? -1 : 1));
const LIBRARIES = MEMBERS.filter((m) => m.kind === "dll");

/* What the app asks of FFmpeg, derived from the code. A build missing one of
   these fails deep inside an export, a proxy or an import, potentially hours
   into someone's work, so each is a hard gate here rather than a warning.

     libx264 / libx265 / libsvtav1  the three software video codecs offered by
                                    the export dialog (h264 / hevc / av1);
                                    libx264 also makes proxies and scrub copies
     gif / png / mjpeg              the GIF container's encoder, its palette
                                    pass, thumbnails
     aac / libopus / libmp3lame     ALL THREE audio branches of push_audio_codec
                                    in src-tauri/src/export/builder.rs
     pcm_s16le                      the waveform decode
     libvpx-vp9                     NOT an export codec. scripts/make-fixtures.mjs
                                    encodes web_vp9.webm with it, so a build
                                    without it breaks the test fixtures. Keep it.
     *_nvenc / *_qsv / *_amf        the hardware encoders hw.rs probes; only
                                    their presence in the build is checked */
const REQUIRED = {
  encoders: [
    "libx264", "libx265", "libsvtav1", "libvpx-vp9", "aac", "libopus", "libmp3lame",
    "gif", "png", "mjpeg", "pcm_s16le",
    "h264_nvenc", "h264_qsv", "h264_amf", "hevc_nvenc", "hevc_qsv", "hevc_amf",
    "av1_nvenc", "av1_qsv", "av1_amf",
  ],
  decoders: ["libdav1d", "h264", "hevc", "vp9", "png"],
  filters: [
    "drawtext", "setparams", "palettegen", "paletteuse", "alphaextract", "alphamerge",
    "blend", "geq", "tpad", "overlay", "concat", "colorchannelmixer", "volumedetect",
    "testsrc2", "amix", "atempo", "afade", "adelay", "anullsrc", "scale", "fps",
    "color", "setpts", "trim", "crop", "format", "setsar", "transpose", "atrim",
  ],
  bsfs: ["filter_units"],
  hwaccels: ["d3d11va"],
  muxers: ["mp4", "mov", "webm", "avi", "gif", "image2", "s16le", "null"],
  protocols: ["file", "pipe"],
  drawtextOptions: ["textfile", "expansion", "text_shaping", "text_align", "boxw", "boxh", "line_spacing"],
};

const outDir = path.join(root, "src-tauri", "binaries");
const self = path.relative(root, fileURLToPath(import.meta.url)).replaceAll("\\", "/");

const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";

/* bsdtar has shipped in Windows since 1803 and reads zip natively, which is
   what keeps this script free of any dependency. Resolved absolutely instead
   of as a bare "tar": a Git-for-Windows or MSYS GNU tar earlier on PATH would
   win the lookup, and GNU tar cannot read zip at all. */
const TAR = path.join(SYSTEM_ROOT, "System32", "tar.exe");

/* The gate runs the exes with PATH cut down to Windows' own folders, so a
   library found elsewhere on this machine (another FFmpeg on PATH, say) can
   never stand in for one that is missing from the folder: users' PCs will
   not have it. */
const GATE_ENV = { ...process.env, PATH: `${path.join(SYSTEM_ROOT, "System32")};${SYSTEM_ROOT}` };

/* The Windows loader's exit codes for a process that could not load its
   libraries, as node reports them (unsigned) and as a signed int. */
const LOADER_FAILURES = new Map([
  [0xc0000135, "a library it links was not found (STATUS_DLL_NOT_FOUND)"],
  [0xc000007b, "a library it links is not a 64-bit Windows library (STATUS_INVALID_IMAGE_FORMAT)"],
  [0xc0000139, "a library it links is another version (STATUS_ENTRYPOINT_NOT_FOUND)"],
]);

const mb = (bytes) => (bytes / 1e6).toFixed(1);

function fail(msg) {
  throw new Error(msg);
}

/** The value of `--<flag> <value>` or `--<flag>=<value>`, or null. */
function flagValue(argv, flag, what) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      if (!argv[i + 1]) fail(`${flag} needs ${what}`);
      return argv[i + 1];
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return null;
}

function archiveArg(argv) {
  return flagValue(argv, "--archive", "a path to the pinned archive") ?? (process.env.TAROTING_FFMPEG_ARCHIVE || null);
}

/** Whether `file` is the pinned member: its size first (cheap), then SHA-256. */
async function matchesPin(file, member) {
  if (!fs.existsSync(file) || fs.statSync(file).size !== member.bytes) return false;
  return (await sha256File(file)) === member.sha256;
}

/** Where a member sits in a release folder: the exes under their plain name
 *  (Tauri drops the triple suffix there), the libraries under their own. */
const placedName = (m) => (m.kind === "exe" ? `${m.name}.exe` : m.dest);

/**
 * Copy the installed, verified set into `dir`, libraries first, each written
 * to a `.part` name, checked, then renamed over whatever was there (an older
 * build's ffmpeg.exe is replaced, never deleted first). A member already
 * matching the pin is left alone. Then the gate runs on the placed exes, so
 * the folder is known to start with nothing but itself and Windows.
 */
async function place(dir, installed) {
  const target = path.resolve(dir);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) fail(`--place: ${target} is not a folder`);
  for (const m of MEMBERS) {
    if (!(await matchesPin(installed[m.name], m))) {
      fail(`${path.relative(root, installed[m.name])} is missing or not the pinned file; run npm run fetch-ffmpeg first`);
    }
  }
  let copied = 0;
  for (const m of MEMBERS) {
    const to = path.join(target, placedName(m));
    if (await matchesPin(to, m)) continue;
    const part = `${to}.part`;
    try {
      fs.copyFileSync(installed[m.name], part);
      if (!(await matchesPin(part, m))) fail(`${placedName(m)} does not match the pin after copying`);
      fs.renameSync(part, to);
    } catch (err) {
      fs.rmSync(part, { force: true });
      fail(
        `could not place ${placedName(m)} in ${target}: ${err.message}\n` +
          (copied > 0
            ? `  the folder now holds a mix of builds; close anything running from it and run this again.`
            : `  nothing in the folder was changed.`),
      );
    }
    copied++;
    console.log(`placed ${placedName(m)} (${mb(m.bytes)} MB)`);
  }
  gate(path.join(target, "ffmpeg.exe"), path.join(target, "ffprobe.exe"));
  console.log(`${MEMBERS.length} FFmpeg files in ${target} match the pin (${copied} copied)`);
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifySha(file, expected, what) {
  const actual = await sha256File(file);
  if (actual !== expected) {
    fail(
      `SHA-256 mismatch for ${what}\n` +
        `  expected ${expected}\n` +
        `  actual   ${actual}\n` +
        `  nothing was installed. If this is a deliberate FFmpeg upgrade, update\n` +
        `  ${pinName}; do not paste the actual digest over the expected one.`,
    );
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  if (!res.body) fail(`download failed: empty response body for ${url}`);

  const total = Number(res.headers.get("content-length")) || 0;
  const live = Boolean(process.stdout.isTTY) && total > 0;
  let seen = 0;
  let shown = -1;

  await pipeline(
    Readable.fromWeb(res.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        seen += chunk.length;
        const pct = Math.floor((seen / total) * 100);
        if (live && pct !== shown) {
          shown = pct;
          process.stdout.write(`\r  ${pct}% (${mb(seen)} / ${mb(total)} MB)`);
        }
        yield chunk;
      }
    },
    fs.createWriteStream(dest),
  );

  if (live) process.stdout.write("\r".padEnd(40) + "\r");
  return seen;
}

/** Run one of the exes under test, with the gate's PATH. A loader failure is
 *  turned into a message naming what is missing from the exe's folder. */
function runExe(exe, args, options = {}) {
  try {
    return execFileSync(exe, args, {
      encoding: "utf8",
      env: GATE_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (err) {
    const code = typeof err.status === "number" ? err.status >>> 0 : null;
    const why = code === null ? null : LOADER_FAILURES.get(code);
    if (why) {
      const dir = path.dirname(exe);
      const absent = LIBRARIES.map((m) => m.dest).filter((d) => !fs.existsSync(path.join(dir, d)));
      fail(
        `${path.basename(exe)} could not start: ${why}.\n` +
          (absent.length
            ? `  missing beside it: ${absent.join(", ")}`
            : `  every pinned library is beside it, so it needs a library the pin does not list;\n` +
              `  read its import table and add that library to ${pinName}.`),
      );
    }
    const stderr = String(err.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n  ");
    fail(`${path.basename(exe)} ${args.join(" ")} failed (${err.message.split(/\r?\n/)[0]})${stderr ? `\n  ${stderr}` : ""}`);
  }
}

/** Names in an `ffmpeg -encoders` / `-decoders` / `-filters` / `-muxers`
 *  listing: the column after the flags (comma-separated for formats). */
function listedNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z.|]{1,6})\s+(\S+)/.exec(line);
    if (m) for (const n of m[2].split(",")) names.add(n);
  }
  return names;
}

/** Names in a listing of one name per line (`-bsfs`, `-hwaccels`, `-protocols`). */
function bareNames(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith(":")),
  );
}

/** Option names in `-h filter=…`. */
function optionNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+([a-z_0-9]+)\s+<[a-z]+>/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

// Asserts the files about to be installed really are the pinned build, start
// with nothing but their own folder and Windows, and can do what the app asks
// of them. `dir` holds ffmpeg + ffprobe (named `exe`) and every library.
function gate(ffmpeg, ffprobe) {
  for (const [name, exe] of [
    ["ffmpeg", ffmpeg],
    ["ffprobe", ffprobe],
  ]) {
    const banner = runExe(exe, ["-version"]).split(/\r?\n/)[0] ?? "";
    if (!banner.includes(PIN.version)) {
      fail(`${name} reports "${banner.trim()}" but the pin is ${PIN.version}; refusing to install it.`);
    }
  }

  const checks = [
    ["encoders", listedNames(runExe(ffmpeg, ["-hide_banner", "-encoders"]))],
    ["decoders", listedNames(runExe(ffmpeg, ["-hide_banner", "-decoders"]))],
    ["filters", listedNames(runExe(ffmpeg, ["-hide_banner", "-filters"]))],
    ["muxers", listedNames(runExe(ffmpeg, ["-hide_banner", "-muxers"]))],
    ["bsfs", bareNames(runExe(ffmpeg, ["-hide_banner", "-bsfs"]))],
    ["hwaccels", bareNames(runExe(ffmpeg, ["-hide_banner", "-hwaccels"]))],
    ["protocols", bareNames(runExe(ffmpeg, ["-hide_banner", "-protocols"]))],
    ["drawtextOptions", optionNames(runExe(ffmpeg, ["-hide_banner", "-h", "filter=drawtext"]))],
  ];
  const missing = [];
  for (const [what, have] of checks) {
    for (const need of REQUIRED[what]) if (!have.has(need)) missing.push(`${what}: ${need}`);
  }
  if (missing.length) {
    fail(`this ffmpeg build lacks what the app uses:\n  ${missing.join("\n  ")}`);
  }

  // One real run through the libraries the app leans on hardest: lavfi's
  // test source, drawtext with FreeType and a system font (run from the Fonts
  // folder with a bare name, as exports do), libx264, the null muxer.
  runExe(
    ffmpeg,
    [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=64x64:d=0.1",
      "-vf", "drawtext=fontfile=segoeui.ttf:text=a:expansion=none",
      "-c:v", "libx264", "-f", "null", "-",
    ],
    { cwd: path.join(SYSTEM_ROOT, "Fonts") },
  );
  console.log(
    `gate OK: ${Object.values(REQUIRED).reduce((n, l) => n + l.length, 0)} capabilities, ` +
      `drawtext + libx264 run, PATH limited to Windows`,
  );
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const dest = Object.fromEntries(MEMBERS.map((m) => [m.name, path.join(outDir, m.dest)]));

  const placeDir = flagValue(process.argv.slice(2), "--place", "the folder that holds taroting.exe");
  if (placeDir !== null) {
    await place(placeDir, dest);
    return;
  }

  /* Fast path. `npm run fetch-ffmpeg` is part of the documented fresh-machine
     restore recipe and gets run reflexively, so never pull the archive across
     the wire to arrive at bytes that are already on disk. The digest check is
     the same one the install path applies, so skipping is not a weaker
     guarantee. */
  let installed = true;
  for (const m of MEMBERS) {
    const file = dest[m.name];
    if (!fs.existsSync(file) || (await sha256File(file)) !== m.sha256) {
      installed = false;
      break;
    }
  }
  if (installed) {
    gate(dest.ffmpeg, dest.ffprobe);
    console.log(`up to date: ${PIN.version} already in ${path.relative(root, outDir)}; nothing to fetch`);
    return;
  }

  if (!fs.existsSync(TAR)) {
    fail(`${TAR} not found; Windows' bundled bsdtar is required to unpack the archive.`);
  }

  const local = archiveArg(process.argv.slice(2));

  /* Everything is staged inside outDir so the final move is a same-volume
     rename (the system temp dir can easily be on another drive, where rename
     fails with EXDEV). outDir is gitignored in full, so the staging dir is
     invisible to git, and the finally below removes it either way. */
  const staging = fs.mkdtempSync(path.join(outDir, ".fetch-"));
  try {
    const archive = path.join(staging, path.posix.basename(new URL(PIN.url).pathname));

    if (local) {
      // Copied first, then checked: the bytes verified are the bytes unpacked.
      const from = path.resolve(local);
      if (!fs.existsSync(from)) fail(`archive not found: ${from}`);
      console.log(`archive from disk: ${from}`);
      fs.copyFileSync(from, archive);
    } else {
      console.log(`download ${PIN.url}`);
      await download(PIN.url, archive);
    }
    const bytes = fs.statSync(archive).size;
    if (bytes !== PIN.archiveBytes) {
      fail(`archive is ${bytes} bytes, the pin says ${PIN.archiveBytes}; refusing to unpack it.`);
    }
    await verifySha(archive, PIN.archiveSha256, "the archive");
    console.log(`archive verified (${mb(bytes)} MB)`);

    // Only the pinned members are unpacked; the rest of the build (ffplay,
    // headers, import libraries, docs) is dead weight here.
    execFileSync(TAR, ["-xf", archive, "-C", staging, ...MEMBERS.map((m) => m.path)], {
      stdio: ["ignore", "inherit", "inherit"],
    });

    let stagedDir = null;
    for (const m of MEMBERS) {
      const file = path.join(staging, ...m.path.split("/"));
      if (!fs.existsSync(file)) fail(`${m.path} is missing from the archive.`);
      const size = fs.statSync(file).size;
      if (size !== m.bytes) {
        fail(`${m.path} is ${size} bytes, the pin says ${m.bytes}.`);
      }
      await verifySha(file, m.sha256, m.path);
      const dir = path.dirname(file);
      if (stagedDir !== null && dir !== stagedDir) {
        fail(`${m.path} is not in the same folder as the other members; the exes would not find it.`);
      }
      stagedDir = dir;
    }

    // The archive keeps the exes beside the libraries, as they will sit once
    // installed, so the gate runs on exactly that layout.
    const staged = (name) => path.join(staging, ...PIN.members[name].path.split("/"));
    gate(staged("ffmpeg"), staged("ffprobe"));

    // Verified end to end; only now does anything reach its final name.
    // Libraries first (MEMBERS order), then the exes. A rename over an older
    // file replaces it: the previous build's exes are overwritten, never
    // deleted, and no other file in the folder is touched.
    let renamed = 0;
    for (const m of MEMBERS) {
      try {
        fs.renameSync(path.join(staging, ...m.path.split("/")), dest[m.name]);
      } catch (err) {
        fail(
          `could not install ${path.relative(root, dest[m.name])}: ${err.message}\n` +
            (renamed > 0
              ? `  install incomplete: ${path.relative(root, outDir)} now holds a mix of builds.\n` +
                `  Close anything using FFmpeg from it (a dev build of the app, cargo test) and run npm run fetch-ffmpeg again.`
              : `  nothing was installed. Close anything using FFmpeg from ${path.relative(root, outDir)} and run it again.`),
        );
      }
      renamed++;
      console.log(`${m.name}: ${path.relative(root, dest[m.name])} (${mb(m.bytes)} MB)`);
    }
    console.log(`installed ${PIN.version}, built ${PIN.built}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  // The same gate on the installed layout and names. The files are in place
  // by now, so a failure here says so.
  try {
    gate(dest.ffmpeg, dest.ffprobe);
  } catch (err) {
    fail(`${err.message}\n  the files above are installed but failed this check in ${path.relative(root, outDir)}.`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
