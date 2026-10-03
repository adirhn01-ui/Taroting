// The theater's blank cursor, read straight from editor.css.
//
// During fullscreen playback the idle theater blanks the cursor on its
// container, and every menu, toast and error dialog raised then is placed
// INSIDE that container (errors.ts placeOverlay), so it inherited the blank
// cursor: the pointer disappeared over a dialog until the mouse moved. Each of
// those surfaces must take the ordinary cursor back under the hidden theater.
//
// What this cannot prove: what Chromium actually draws. That needs a real
// fullscreen theater, which the E2E cannot reach (no user activation).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "editor.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every rule as [selector list, declarations]. Flat CSS only — editor.css
 *  has no @media or other nested block (the first test guards that). */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim()),
  body: m[2]!,
}));

const HIDDEN = ".editor__preview.theater.theater--hidden";

/** The cursor declared for exactly this selector, if any rule declares one. */
function cursorFor(selector: string): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (!r.selectors.includes(selector)) continue;
    const m = /(?:^|;)\s*cursor\s*:\s*([^;]+)/.exec(r.body);
    if (m) found = m[1]!.trim();
  }
  return found;
}

describe("the hidden theater's cursor", () => {
  it("parses flat rules and still blanks the theater itself (guards against a vacuous pass)", () => {
    expect(css).not.toMatch(/@media|@supports|@container/);
    expect(cursorFor(HIDDEN)).toBe("none");
  });

  it("gives every surface placed inside the theater its cursor back", () => {
    for (const surface of [".modal-backdrop", ".toast-host", ".ctx-menu"]) {
      expect(cursorFor(`${HIDDEN} ${surface}`), surface).toBe("auto");
    }
  });
});
