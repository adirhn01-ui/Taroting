// Guard: the z-index ladder in tokens.css is authoritative. Every stacking
// layer in every stylesheet names a `--z-*` token, so the order of the whole
// app can be read in one place — and a bare number dropped into some file
// (two had crept into the timeline: 5 and 6) cannot quietly outrank, or fall
// under, a layer it never knew about. Sweeps the tree rather than a list, so a
// new stylesheet is covered the day it is added.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

function stylesheets(): string[] {
  return readdirSync(resolve(root, "src"), { recursive: true })
    .map((p) => `src/${p.replace(/\\/g, "/")}`)
    .filter((p) => p.endsWith(".css"));
}

/** CSS with comments blanked out (newlines kept, so line numbers still line
 *  up), so a comment that MENTIONS a z-index is never read as a declaration. */
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

/** Every `z-index:` declaration in a stylesheet, with its line number. */
function zDeclarations(rel: string): { line: number; value: string }[] {
  const out: { line: number; value: string }[] = [];
  code(read(rel))
    .split("\n")
    .forEach((l, i) => {
      for (const m of l.matchAll(/(?<![\w-])z-index\s*:\s*([^;}]+)/g)) {
        out.push({ line: i + 1, value: m[1]!.trim() });
      }
    });
  return out;
}

describe("the z-index ladder", () => {
  it("sweeps a real tree (guards against a vacuous pass)", () => {
    const sheets = stylesheets();
    expect(sheets).toContain("src/style/tokens.css");
    expect(sheets).toContain("src/editor/editor.css");
    expect(sheets.flatMap(zDeclarations).length).toBeGreaterThan(5);
  });

  it("every z-index in every stylesheet is a --z-* token (or auto)", () => {
    const adHoc: string[] = [];
    for (const rel of stylesheets()) {
      for (const d of zDeclarations(rel)) {
        if (d.value === "auto") continue;
        if (/^var\(--z-[a-z0-9-]+\)$/.test(d.value)) continue;
        adHoc.push(`${rel}:${d.line}  z-index: ${d.value}`);
      }
    }
    expect(adHoc).toEqual([]);
  });

  it("every --z-* token a stylesheet names is declared in tokens.css", () => {
    const declared = new Set(
      [...code(read("src/style/tokens.css")).matchAll(/(--z-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
    );
    const missing: string[] = [];
    for (const rel of stylesheets()) {
      for (const m of code(read(rel)).matchAll(/var\((--z-[a-z0-9-]+)\)/g)) {
        if (!declared.has(m[1]!)) missing.push(`${rel}  ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the timeline scrollbar above the timeline drop guide, and both under the UI layers", () => {
    // The pair the bare numbers used to encode: the scrollbar must stay
    // grabbable while an external drag paints the drop guide over the lanes.
    const tokens = code(read("src/style/tokens.css"));
    const value = (name: string): number => Number(new RegExp(`${name}\\s*:\\s*(\\d+)`).exec(tokens)?.[1]);
    expect(value("--z-tl-vscroll")).toBeGreaterThan(value("--z-tl-drop-guide"));
    expect(value("--z-tl-vscroll")).toBeLessThan(value("--z-stage-overlay"));
  });
});
