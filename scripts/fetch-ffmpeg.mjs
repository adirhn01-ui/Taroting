#!/usr/bin/env node
// Installs ffmpeg + ffprobe into src-tauri/binaries/ under Tauri's target-triple
// naming convention for external binaries (sidecars). Those filenames are
// load-bearing: bundle.externalBin in src-tauri/tauri.conf.json resolves a
// sidecar by the exact `-x86_64-pc-windows-msvc.exe` suffix, so nothing here
// may rename or restructure the output.
//
// The build is PINNED. Every byte that ships is decided by the PIN block below
// and checked against SHA-256 twice — once on the archive before anything is
// unpacked, once per extracted binary before it is allowed near the output dir.
// Any mismatch is fatal and leaves whatever was already installed untouched.
//
// This deliberately no longer takes ffmpeg off PATH. "Whichever build the
// machine happened to have" is how two builds of Taroting end up behaving
// differently over a codec detail that nobody can reproduce months later.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/* --- the pin ---------------------------------------------------------------
   Source is the GitHub release asset rather than
   https://www.gyan.dev/ffmpeg/builds/packages/… — gyan.dev's own package
   directory is pruned as builds age, while a published release asset is
   immutable and stays reachable, so these digests keep meaning something
   years from now.

   The .zip is pinned in preference to the (90 MB smaller) .7z of the same
   build because zip is the format Windows can unpack two independent ways —
   tar.exe/libarchive and Expand-Archive — whereas reading the .7z needs a
   tar.exe built with liblzma. It also unpacks in well under a second: the .7z
   is a single solid LZMA stream, so pulling two files out of it costs a full
   decompress of the archive.

   Moving to a newer FFmpeg means changing every field here together. The
   digests are the entire point of this file: never resolve a mismatch by
   pasting in the hash of whatever was just downloaded. */
const PIN = {
  version: "8.1.1-full_build-www.gyan.dev",
  built: "2026-05-04", // gcc 15.2.0 (MSYS2), static GPL build
  url: "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build.zip",
  archiveBytes: 252194496,
  archiveSha256: "49b28c5f16addd40239a66949973458769b7056fb7752c30ac0d53389d09a552",
  members: {
    ffmpeg: {
      path: "ffmpeg-8.1.1-full_build/bin/ffmpeg.exe",
      bytes: 227398656,
      sha256: "09948d4cdd0650da6ff5a87577469f2a218dc2615ae379f8f734d24c49de0f73",
    },
    ffprobe: {
      path: "ffmpeg-8.1.1-full_build/bin/ffprobe.exe",
      bytes: 227193344,
      sha256: "a6618e99bb58869ded3c6f37b53aa1a8d701c3591dbb7b5b317d47369c112be2",
    },
  },
};

const TRIPLE = "x86_64-pc-windows-msvc";
const NAMES = ["ffmpeg", "ffprobe"];

/* The encoders every export path in the app can reach for. A build missing one
   of them fails deep inside an export, potentially hours into someone's work,
   so it is a hard gate here rather than a warning.

   Derived from the code, not from the format list a user sees:
     libx264 / libx265 / libsvtav1  the three software video codecs offered by
                                    the export dialog (h264 / hevc / av1)
     gif                            the GIF container's own encoder
     aac / libopus / libmp3lame     ALL THREE audio branches of push_audio_codec
                                    in src-tauri/src/export/builder.rs — webm
                                    takes libopus and avi takes libmp3lame, so
                                    checking only aac would pass a build that
                                    cannot finish either of those exports
     libvpx-vp9                     NOT an export codec: nothing in the dialog
                                    offers VP9. It is here because
                                    scripts/make-fixtures.mjs encodes
                                    web_vp9.webm with it, so a build without it
                                    breaks the test fixtures instead. Keep it. */
const REQUIRED_ENCODERS = [
  "libx264",
  "libx265",
  "libsvtav1",
  "libvpx-vp9",
  "aac",
  "libopus",
  "libmp3lame",
  "gif",
];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "src-tauri", "binaries");
const self = path.relative(root, fileURLToPath(import.meta.url)).replaceAll("\\", "/");

/* bsdtar has shipped in Windows since 1803 and reads zip natively, which is
   what keeps this script free of any dependency. Resolved absolutely instead
   of as a bare "tar": a Git-for-Windows or MSYS GNU tar earlier on PATH would
   win the lookup, and GNU tar cannot read zip at all. */
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

const mb = (bytes) => (bytes / 1e6).toFixed(1);

function fail(msg) {
  throw new Error(msg);
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
        `  nothing was installed. If this is a deliberate FFmpeg upgrade, update the PIN\n` +
        `  block in ${self} — do not paste the actual digest over the expected one.`,
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

// Asserts the binaries about to be installed really are the pinned build and
// really can encode what the exporter asks of them. Runs against the staged
// copies, before anything is moved into place.
function gate(ffmpeg, ffprobe) {
  for (const [name, exe] of [
    ["ffmpeg", ffmpeg],
    ["ffprobe", ffprobe],
  ]) {
    const banner = execFileSync(exe, ["-version"], { encoding: "utf8" }).split(/\r?\n/)[0] ?? "";
    if (!banner.includes(PIN.version)) {
      fail(`${name} reports "${banner.trim()}" but the pin is ${PIN.version} — refusing to install it.`);
    }
  }

  const encoders = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  const missing = REQUIRED_ENCODERS.filter((e) => !encoders.includes(e));
  if (missing.length) {
    fail(`this ffmpeg build lacks: ${missing.join(", ")} — exports using them would fail at runtime.`);
  }
  console.log(`encoder check OK (${REQUIRED_ENCODERS.join(", ")})`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const dest = Object.fromEntries(NAMES.map((n) => [n, path.join(outDir, `${n}-${TRIPLE}.exe`)]));

  /* Fast path. `npm run fetch-ffmpeg` is part of the documented fresh-machine
     restore recipe and gets run reflexively, so never pull 250 MB across the
     wire to arrive at bytes that are already on disk. The digest check is the
     same one the download path applies, so skipping is not a weaker guarantee. */
  let installed = true;
  for (const name of NAMES) {
    const file = dest[name];
    if (!fs.existsSync(file) || (await sha256File(file)) !== PIN.members[name].sha256) {
      installed = false;
      break;
    }
  }
  if (installed) {
    gate(dest.ffmpeg, dest.ffprobe);
    console.log(`up to date: ${PIN.version} already in ${path.relative(root, outDir)} — download skipped`);
    return;
  }

  if (!fs.existsSync(TAR)) {
    fail(`${TAR} not found — Windows' bundled bsdtar is required to unpack the archive.`);
  }

  /* Everything is staged inside outDir so the final move is a same-volume
     rename (the system temp dir can easily be on another drive, where rename
     fails with EXDEV). outDir is gitignored in full, so the staging dir is
     invisible to git, and the finally below removes it either way. */
  const staging = fs.mkdtempSync(path.join(outDir, ".fetch-"));
  try {
    const archive = path.join(staging, path.posix.basename(new URL(PIN.url).pathname));

    console.log(`download ${PIN.url}`);
    const bytes = await download(PIN.url, archive);
    if (bytes !== PIN.archiveBytes) {
      fail(`archive is ${bytes} bytes, the pin says ${PIN.archiveBytes} — refusing to unpack it.`);
    }
    await verifySha(archive, PIN.archiveSha256, "the downloaded archive");
    console.log(`archive verified (${mb(bytes)} MB)`);

    // Only the two members are unpacked; the full build expands to well over a
    // gigabyte and everything else in it is dead weight here.
    execFileSync(TAR, ["-xf", archive, "-C", staging, PIN.members.ffmpeg.path, PIN.members.ffprobe.path], {
      stdio: ["ignore", "inherit", "inherit"],
    });

    const staged = {};
    for (const name of NAMES) {
      const member = PIN.members[name];
      const file = path.join(staging, ...member.path.split("/"));
      if (!fs.existsSync(file)) fail(`${member.path} is missing from the archive.`);
      const size = fs.statSync(file).size;
      if (size !== member.bytes) {
        fail(`${member.path} is ${size} bytes, the pin says ${member.bytes}.`);
      }
      await verifySha(file, member.sha256, member.path);
      staged[name] = file;
    }

    gate(staged.ffmpeg, staged.ffprobe);

    // Verified end to end — only now does anything reach its final name.
    for (const name of NAMES) {
      fs.renameSync(staged[name], dest[name]);
      console.log(`${name}: ${path.relative(root, dest[name])} (${mb(PIN.members[name].bytes)} MB)`);
    }
    console.log(`installed ${PIN.version}, built ${PIN.built}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
