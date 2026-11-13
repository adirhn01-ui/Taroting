// Guard: the editor's scrub copy cannot drive playback and does not pull the
// viewer's chunk. Its sources (tests excluded) import nothing from
// src/viewer/** at all and only types from src/editor/playback/**, and never
// call a transport method — so the real elements are seeked, played and
// paused by the scheduler exactly as without it. The engine and scheduler it
// is handed are typed as read-only views (EditorScrubDeps), which tsc checks;
// this test checks the source text for what a cast could slip past.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ name: f, text: readFileSync(resolve(here, f), "utf8") }));

/** Source text without comments (a comment may name what the code avoids). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every import / export-from statement: [isTypeOnly, specifier]. */
function imports(text: string): Array<[boolean, string]> {
  const out: Array<[boolean, string]> = [];
  for (const m of code(text).matchAll(/^\s*(import|export)\s+(type\s+)?[^;"']*?from\s+["']([^"']+)["']/gm)) {
    out.push([m[2] !== undefined, m[3]!]);
  }
  for (const m of code(text).matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push([false, m[1]!]);
  for (const m of code(text).matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push([false, m[1]!]);
  return out;
}

describe("the editor scrub copy's boundary", () => {
  it("has the four module files", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["copy-layers.ts", "copy-registry.ts", "editor-scrub.ts", "precheck.ts"]);
  });

  for (const { name, text } of sources) {
    it(`${name} imports nothing from src/viewer`, () => {
      const bad = imports(text).filter(([, spec]) => /(^|\/)viewer(\/|$)/.test(spec));
      expect(bad).toEqual([]);
    });

    it(`${name} imports only types from src/editor/playback`, () => {
      const bad = imports(text).filter(([typeOnly, spec]) => /(^|\/)playback(\/|$)/.test(spec) && !typeOnly);
      expect(bad).toEqual([]);
    });

    it(`${name} calls no transport method`, () => {
      const bad = code(text).match(/\.(seek|play|pause|refresh)\s*\(|stepFrames/g) ?? [];
      expect(bad).toEqual([]);
    });

    it(`${name} cannot reach the media manager's failure paths (I12)`, () => {
      const bad = code(text).match(/playbackFailed|markFailed|reportError/g) ?? [];
      expect(bad).toEqual([]);
    });
  }

  it("the copy is fitted like the real element: object-fit contain, which the stage's media never overrides", () => {
    const es = sources.find((s) => s.name === "editor-scrub.ts")!;
    const fits = code(es.text).match(/object-fit:\s*([a-z-]+)/g) ?? [];
    expect(fits).toEqual(["object-fit:contain"]);
    const css = readFileSync(resolve(here, "../editor.css"), "utf8");
    const rule = /\.stage-layer__media\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toMatch(/object-fit/);
  });
});
