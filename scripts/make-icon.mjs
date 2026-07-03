#!/usr/bin/env node
// Generates the Taroting app icon: an accent-blue (#6c7cff, matches the
// "New project" button / --accent token) rounded square with a bold white "T",
// 1024x1024, using the ffmpeg sidecar only (no new deps).
//
//   node scripts/make-icon.mjs
//
// Output: src-tauri/icon-src-1024.png (source PNG for `npx tauri icon`).
//
// Pipeline (single ffmpeg -filter_complex, verified on the bundled ffmpeg 8.1.1):
//   1. accent-blue canvas + bold white centred "T" (drawtext, cwd=C:\Windows\Fonts
//      so the fontfile needs no filter-path escaping — same trick as
//      make-fixtures.mjs). format=gbrp so alphamerge can attach an alpha plane.
//   2. a separate gray alpha mask via geq: transparent (0) outside a radius-180
//      rounded rectangle, opaque (255) inside. The corner test is
//      hypot(dx,dy) > R, where dx/dy measure how far past the R-inset box a
//      pixel sits. NOTE: geq's expression parser rejects a 3-arg max() nested
//      inside another call, so each 3-way max is written as max(max(a,b),c).
//   3. alphamerge → rounded-corner RGBA icon.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ffmpeg = path.join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
const out = path.join(root, "src-tauri", "icon-src-1024.png");

const S = 1024; // canvas size
const R = 180; // corner radius
const FAR = S - 1 - R; // 843: inner edge past which corner rounding begins
const ACCENT = "0x6C7CFF"; // matches --accent (#6c7cff), the "New project" button color

// geq alpha: dx = distance past the [R, S-1-R] box on X (0 inside), dy likewise.
// Written with nested 2-arg max() — geq chokes on 3-arg max inside hypot().
const dx = `max(max(0\\,${R}-X)\\,X-${FAR})`;
const dy = `max(max(0\\,${R}-Y)\\,Y-${FAR})`;
const alpha = `if(gt(hypot(${dx}\\,${dy})\\,${R})\\,0\\,255)`;

const filter = [
  `[0:v]drawtext=fontfile=segoeuib.ttf:text='T':fontsize=660:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-30,format=gbrp[rgb]`,
  `color=c=black:s=${S}x${S}:d=1:r=1,format=gray,geq=lum='${alpha}'[mask]`,
  `[rgb][mask]alphamerge`,
].join(";");

console.log("create", path.relative(root, out));
execFileSync(
  ffmpeg,
  [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${ACCENT}:s=${S}x${S}:d=1:r=1`,
    "-filter_complex", filter,
    "-frames:v", "1",
    out,
  ],
  { cwd: "C:\\Windows\\Fonts", stdio: ["ignore", "inherit", "inherit"] },
);

console.log("icon source ready:", out);
console.log("next: npx tauri icon", out);
