import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The "…" menu in real element fullscreen. Its host lives on document.body, and
 * the fullscreen .viewer sits in the top layer above all of it: the menu opened
 * unseen and, while open, blocked the viewer's shortcuts. The viewer's answer
 * is to show no More button in true fullscreen.
 *
 * Neither vitest (node, no CSSOM) nor the in-app E2E (no user activation, so
 * requestFullscreen is always refused) can enter a real :fullscreen state, so
 * this is a STRUCTURAL pin — weaker than a rendered check, and said so: it
 * proves the rule exists in the shape that matters, and that the button it
 * hides is still the only way the viewer opens a menu.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "viewer.css"), "utf8");
const ts = readFileSync(resolve(here, "viewer.ts"), "utf8");

/** Every `selector { body }` rule in a flat stylesheet, comments stripped. */
function rules(sheet: string): { selector: string; body: string }[] {
  const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]!.trim() });
  }
  return out;
}

describe("the viewer's More button in element fullscreen", () => {
  it("is hidden while .viewer holds true fullscreen", () => {
    const hits = rules(css).filter((r) =>
      r.selector.split(",").some((s) => s.trim() === ".viewer:fullscreen #vw-more"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toMatch(/(^|;)\s*display:\s*none\s*(;|$)/);
  });

  it("is not hidden by the in-window fallback, which has no top layer", () => {
    // .viewer--fullscreen alone is the refused-request layout: the menu's host
    // on body still paints above it, so the button must keep working there.
    const fallback = rules(css).filter(
      (r) => r.selector.includes("viewer--fullscreen") && r.selector.includes("vw-more"),
    );
    expect(fallback).toEqual([]);
  });

  it("is still the only control that opens a menu from the viewer", () => {
    // If another path to showMenu appears, it needs its own answer for
    // fullscreen; hiding this one button would no longer close the hole.
    const calls = ts.match(/\bshowMenu\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const listener = ts.indexOf('moreBtn.addEventListener("click"');
    const call = ts.indexOf("showMenu(");
    expect(listener).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(listener);
    // ...inside that listener, not merely somewhere after it.
    expect(ts.slice(listener, call)).not.toMatch(/\n {2}\}\);/);
  });
});
