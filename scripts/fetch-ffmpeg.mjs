#!/usr/bin/env node
// Copies ffmpeg + ffprobe into src-tauri/binaries/ using Tauri's
// target-triple naming convention for external binaries (sidecars).
// Dev mode: takes them from PATH. A pinned-download mode for CI is added
// in the release milestone.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRIPLE = "x86_64-pc-windows-msvc";
const REQUIRED_ENCODERS = ["libx264", "libx265", "libsvtav1", "libvpx-vp9", "aac", "gif"];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "src-tauri", "binaries");
fs.mkdirSync(outDir, { recursive: true });

function findOnPath(name) {
  try {
    const out = execFileSync("where.exe", [name], { encoding: "utf8" });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  } catch {
    /* not found */
  }
  return null;
}

for (const name of ["ffmpeg", "ffprobe"]) {
  const src = findOnPath(name);
  if (!src) {
    console.error(
      `error: ${name} not found on PATH. Install it (e.g. \`winget install Gyan.FFmpeg\`) and retry.`,
    );
    process.exit(1);
  }
  const dest = path.join(outDir, `${name}-${TRIPLE}.exe`);
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / 1e6).toFixed(1);
  console.log(`${name}: ${src} -> ${path.relative(root, dest)} (${mb} MB)`);
}

// Sanity-check encoder coverage of the copied ffmpeg.
const ff = path.join(outDir, `ffmpeg-${TRIPLE}.exe`);
const encoders = execFileSync(ff, ["-hide_banner", "-encoders"], { encoding: "utf8" });
const missing = REQUIRED_ENCODERS.filter((e) => !encoders.includes(e));
if (missing.length) {
  console.warn(
    `warning: this ffmpeg build lacks: ${missing.join(", ")} — exports using them will fail.`,
  );
} else {
  console.log(`encoder check OK (${REQUIRED_ENCODERS.join(", ")})`);
}
