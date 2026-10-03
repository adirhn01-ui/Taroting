// The context menu's disabled rows, read straight from components.css.
//
// A disabled row's `title` is the only place a menu says WHY it can't be
// chosen ("Finish the crop first."). `pointer-events: none` on the disabled
// row suppressed the native tooltip, so that sentence was never shown. The
// fix keeps the row hit-testable and instead makes the hover rule skip it, so
// it still never lights up.
//
// What this cannot prove: that Chromium actually renders the tooltip. That
// needs a hit test in the real page (elementFromPoint at a disabled, titled
// row returning the button) — an E2E check, not a vitest one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "components.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every rule as [selector list, declarations]. Flat CSS only — which is all
 *  components.css is. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim()),
  body: m[2]!,
}));

describe("context menu disabled rows", () => {
  it("parses the menu rules (guards against a vacuous pass)", () => {
    expect(rules.some((r) => r.selectors.includes(".ctx-menu__item:disabled"))).toBe(true);
    expect(rules.some((r) => r.selectors.some((s) => s.startsWith(".ctx-menu__item") && s.includes(":hover")))).toBe(true);
  });

  it("never takes a disabled row out of hit-testing, so its tooltip can show", () => {
    const offenders = rules.filter(
      (r) =>
        r.selectors.some((s) => s.includes(".ctx-menu__item") && s.includes(":disabled") && !s.includes(":not(:disabled)")) &&
        /pointer-events\s*:\s*none/.test(r.body),
    );
    expect(offenders.map((r) => r.selectors.join(", "))).toEqual([]);
  });

  it("does not light a disabled row up on hover", () => {
    const hover = rules
      .flatMap((r) => r.selectors)
      .filter((s) => /^\.ctx-menu__item\b/.test(s) && s.includes(":hover"));
    expect(hover.length).toBeGreaterThan(0);
    for (const s of hover) expect(s).toContain(":not(:disabled)");
  });
});
