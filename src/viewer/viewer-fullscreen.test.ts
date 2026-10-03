import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The "…" menu in real element fullscreen. Element fullscreen puts .viewer in
 * the top layer, above everything else in the document, so a menu hosted on
 * document.body used to open there unseen. ui/menu.ts now attaches its host
 * inside `document.fullscreenElement` on every open (ui/menu.test.ts pins
 * that), and the menu paints above the viewer's chrome. The viewer used
 * to answer the same bug by hiding its More button in true fullscreen; with
 * the menu fixed, that hide only took "Open as project" and "Show in folder"
 * away, so it is gone and must not come back.
 *
 * Neither vitest (node, no CSSOM) nor the in-app E2E (no user activation, so
 * requestFullscreen is always refused) can enter a real :fullscreen state, so
 * this is a STRUCTURAL pin — weaker than a rendered check, and said so.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "viewer.css"), "utf8");

/** Every `selector { body }` rule in a flat stylesheet, comments stripped. */
function rules(sheet: string): { selector: string; body: string }[] {
  const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]!.trim() });
  }
  return out;
}

/** Rules that could take the More button out of a fullscreen viewer. */
function hidingMore(selectorPart: string): { selector: string; body: string }[] {
  return rules(css).filter(
    (r) =>
      r.selector.split(",").some((s) => s.includes(selectorPart) && s.includes("vw-more")) &&
      /(^|;)\s*(display:\s*none|visibility:\s*hidden)\s*(;|$)/.test(r.body),
  );
}

describe("the viewer's More button in element fullscreen", () => {
  it("stays visible while .viewer holds true fullscreen", () => {
    expect(hidingMore(":fullscreen")).toEqual([]);
  });

  it("stays visible in the in-window fallback too", () => {
    // .viewer--fullscreen alone is the refused-request layout: no top layer,
    // and the menu on body paints above it.
    expect(hidingMore("viewer--fullscreen")).toEqual([]);
  });
});
