// Fails the build when a screen that must open at once would load code it
// has no use for. Run after `vite build` (see package.json `build`).
//
// WHY: the bundler decides which file a shared piece of code lives in. In
// 0.9.5 it put its own module-namespace helper into the same file as pdf-lib,
// and every chunk that needed the helper (the start-up ones and the viewer's
// included) then loaded 420 kB of PDF writer: +9 MB on Home, +16 MB and
// +16 ms in the viewer. No source import was wrong, so no source-level test
// could see it. This looks at what was actually built.
//
// It follows STATIC imports only (`from "./x.js"`, `import "./x.js"`): a
// dynamic `import()` is a chunk fetched later, when its screen is opened.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "dist", "assets");

/** Most the start-up closure may weigh (bytes of minified JS). Measured
 *  2026-11-12: 106 kB in 11 files. Raise it only with a start-up and memory
 *  measurement (docs/PERFORMANCE.md) that shows the growth is free. */
export const BOOT_BUDGET = 135_000;
/** Most the viewer's own closure may add on top of start-up. Measured
 *  2026-11-12: 40 kB. */
export const VIEWER_BUDGET = 60_000;
/** No single chunk a must-be-instant screen loads may be this large: a
 *  library that size belongs behind a dynamic import. */
export const CHUNK_LIMIT = 150_000;

/** Every `./name.js` a chunk imports statically. */
export function staticImports(code) {
  const out = new Set();
  // Minified ESM: `from"./x.js"`, `import"./x.js"`, and the same with spaces
  // or single quotes. `import("./x.js")` (dynamic) has a parenthesis first.
  const re = /(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g;
  for (let m; (m = re.exec(code)); ) out.add(m[1]);
  return [...out];
}

/** The files reached from `start` through static imports, `start` included. */
export function closure(start, read) {
  const seen = new Set();
  const todo = [...start];
  while (todo.length > 0) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of staticImports(read(f))) todo.push(dep);
  }
  return seen;
}

/** The problems of one closure, as sentences. */
export function problems(label, files, size, budget, except = new Set()) {
  const own = [...files].filter((f) => !except.has(f));
  const total = own.reduce((s, f) => s + size(f), 0);
  const out = [];
  if (total > budget) {
    out.push(`${label} loads ${total} bytes of JS at once, over its budget of ${budget}: ${own.map((f) => `${f} (${size(f)})`).join(", ")}`);
  }
  for (const f of own) {
    if (size(f) > CHUNK_LIMIT) out.push(`${label} loads ${f} (${size(f)} bytes) at once: a chunk that size belongs behind a dynamic import`);
  }
  return out;
}

function main() {
  if (!existsSync(assets)) {
    console.error("check-boot: dist/assets is missing; run vite build first");
    process.exit(1);
  }
  const read = (f) => readFileSync(join(assets, f), "utf8");
  const size = (f) => statSync(join(assets, f)).size;
  const html = readFileSync(join(root, "dist", "index.html"), "utf8");
  const entry = [...html.matchAll(/<script[^>]+src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  if (entry.length !== 1) {
    console.error(`check-boot: expected one entry script in dist/index.html, found ${entry.length}`);
    process.exit(1);
  }
  const boot = closure(entry, read);
  const viewerChunk = readdirSync(assets).filter((f) => /^viewer-[^.]+\.js$/.test(f));
  if (viewerChunk.length !== 1) {
    console.error(`check-boot: expected one viewer chunk, found ${viewerChunk.length} (${viewerChunk.join(", ")})`);
    process.exit(1);
  }
  const viewer = closure(viewerChunk, read);
  const bad = [...problems("Start-up", boot, size, BOOT_BUDGET), ...problems("The viewer", viewer, size, VIEWER_BUDGET, boot)];
  const sum = (set, except = new Set()) => [...set].filter((f) => !except.has(f)).reduce((s, f) => s + size(f), 0);
  console.log(`check-boot: start-up ${sum(boot)} bytes in ${boot.size} files (budget ${BOOT_BUDGET}); the viewer adds ${sum(viewer, boot)} bytes (budget ${VIEWER_BUDGET})`);
  if (bad.length > 0) {
    for (const b of bad) console.error(`check-boot: ${b}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
