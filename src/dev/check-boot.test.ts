// Guard: what the app loads at start-up, and for the viewer, stays small.
// `npm run build` ends with scripts/check-boot.mjs, which reads the BUILT
// chunks: a library can land on the start-up path through the bundler's own
// chunking with every source import correct (0.9.5: pdf-lib rode in with a
// helper the bundler had filed beside it). These tests pin the script's
// reading of a chunk and its verdicts; the build runs it on the real output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CheckBoot {
  BOOT_BUDGET: number;
  VIEWER_BUDGET: number;
  CHUNK_LIMIT: number;
  staticImports(code: string): string[];
  closure(start: string[], read: (f: string) => string): Set<string>;
  problems(label: string, files: Set<string>, size: (f: string) => number, budget: number, except?: Set<string>): string[];
}
const modulePath: string = new URL("../../scripts/check-boot.mjs", import.meta.url).href;
const { BOOT_BUDGET, VIEWER_BUDGET, CHUNK_LIMIT, staticImports, closure, problems } = (await import(
  /* @vite-ignore */ modulePath
)) as CheckBoot;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("staticImports", () => {
  it("reads minified and spaced static imports, in both quote styles", () => {
    const code = `import{a as b}from"./one-AbC1.js";import"./two.js";import x from './three-9.js';export{y}from "./four.js";`;
    expect(staticImports(code).sort()).toEqual(["four.js", "one-AbC1.js", "three-9.js", "two.js"]);
  });

  it("does not count a dynamic import: that chunk is fetched later", () => {
    const code = `const p=()=>import("./lazy-1.js");const q=()=>import('./lazy-2.js');import{z}from"./now.js";`;
    expect(staticImports(code)).toEqual(["now.js"]);
  });

  it("names each file once", () => {
    expect(staticImports(`import{a}from"./x.js";import{b}from"./x.js";`)).toEqual(["x.js"]);
  });
});

describe("closure", () => {
  // entry -> a -> b ; a -> (dynamic) lazy -> huge ; b -> a (a cycle)
  const files: Record<string, string> = {
    "entry.js": `import"./a.js";`,
    "a.js": `import{x}from"./b.js";const l=()=>import("./lazy.js");`,
    "b.js": `import{y}from"./a.js";`,
    "lazy.js": `import"./huge.js";`,
    "huge.js": ``,
  };
  const read = (f: string): string => files[f]!;

  it("follows static imports through a cycle and stops at a dynamic one", () => {
    expect([...closure(["entry.js"], read)].sort()).toEqual(["a.js", "b.js", "entry.js"]);
  });

  it("starts from every file it is given", () => {
    expect([...closure(["lazy.js", "b.js"], read)].sort()).toEqual(["a.js", "b.js", "huge.js", "lazy.js"]);
  });
});

describe("problems", () => {
  const sizes: Record<string, number> = { "e.js": 60_000, "s.js": 30_000, "v.js": 20_000, "lib.js": 420_000 };
  const size = (f: string): number => sizes[f]!;

  it("passes a closure inside its budget", () => {
    expect(problems("Start-up", new Set(["e.js", "s.js"]), size, 100_000)).toEqual([]);
  });

  it("names the files when the total passes the budget", () => {
    const out = problems("Start-up", new Set(["e.js", "s.js"]), size, 80_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("90000 bytes");
    expect(out[0]).toContain("e.js (60000)");
    expect(out[0]).toContain("s.js (30000)");
  });

  it("refuses one oversized chunk even inside a generous budget", () => {
    const out = problems("The viewer", new Set(["v.js", "lib.js"]), size, 10_000_000);
    expect(out).toEqual([expect.stringContaining("lib.js (420000 bytes)")]);
  });

  it("counts only what a screen adds to the start-up files", () => {
    // v.js alone is inside 25 kB; with e.js counted again it would not be.
    expect(problems("The viewer", new Set(["e.js", "v.js"]), size, 25_000, new Set(["e.js"]))).toEqual([]);
    expect(problems("The viewer", new Set(["e.js", "v.js"]), size, 25_000)).toHaveLength(1);
  });

  it("the 0.9.5 mistake is caught twice over: by size and by total", () => {
    const out = problems("Start-up", new Set(["e.js", "s.js", "lib.js"]), size, BOOT_BUDGET);
    expect(out).toHaveLength(2);
  });
});

describe("the wiring", () => {
  it("npm run build ends with the check, so a release cannot skip it", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build"]).toMatch(/vite build && node scripts\/check-boot\.mjs$/);
    const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8")) as {
      build: { beforeBuildCommand: string };
    };
    expect(conf.build.beforeBuildCommand).toBe("npm run build");
  });

  it("pdf-lib has a chunk of its own in the build configuration", () => {
    const cfg = readFileSync(resolve(root, "vite.config.ts"), "utf8");
    expect(cfg).toMatch(/codeSplitting:\s*\{/);
    expect(cfg).toMatch(/name:\s*"pdf-lib"/);
  });

  it("the budgets are tighter than the mistake they exist for", () => {
    // 0.9.5 added a 420 kB chunk to both closures.
    expect(BOOT_BUDGET).toBeLessThan(200_000);
    expect(VIEWER_BUDGET).toBeLessThan(200_000);
    expect(CHUNK_LIMIT).toBeLessThan(420_000);
  });
});
