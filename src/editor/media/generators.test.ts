// Text generators must never produce a media box the export cannot synthesize.
//
// THE BUG. `measureText` rounds the intrinsic box UP (evenUp) with no upper
// bound, and both call sites — the creation dialog and the inspector's
// generated-media editor — wrote that straight into `addGeneratedMedia`, which
// does not clamp either. Its three siblings all clamp to 16..8192 (evenDim in
// the solid dialog, evenDim in inspector/generated.ts, clampCanvas in
// core/project.ts); the text path was the one that skipped it. A long enough
// paste therefore produced a text element tens of thousands of pixels wide,
// and the export either aborted in alphamerge ("First input link top
// parameters (size 16384x120) do not match ... (size 25000x120)", because
// builder.rs clamps the synthesized frame to 16384 while the fit math uses the
// unclamped dims) or, without an opacity keyframe, silently rendered different
// lines than the preview.
//
// THE FIX IS NOT A CLAMP ON ITS OWN. The box has to EQUAL the natural text
// extent, because the preview top-flows the lines in an overflow-hidden div
// while drawtext CENTRES them in `boxh` — a box smaller than its text shows the
// preview's first lines and the export's middle ones. So the font size is what
// gives, and these tests pin both halves: the box lands inside the limit, AND
// it stays a true measurement of the generator that is committed with it.
//
// The environment is "node" (vite.config.ts), so `measureText` takes its
// documented no-2D-context path and estimates advance widths. Every EXACT
// number asserted below is on the height axis, which is `lines * sizePx * 1.25`
// and involves no font metrics at all — identical in node and in the webview.
// The width axis is asserted by property only, and each width case first
// asserts that the natural box really does overflow, so a metric change makes
// the test fail rather than pass vacuously.

import { describe, expect, it } from "vitest";
import type { Generator } from "../../core/types";
import { MAX_DIM, fitText, fitTextSize, measureText } from "./generators";

const MIN_SIZE = 8;

const text = (
  body: string,
  sizePx = 96,
): Extract<Generator, { type: "text" }> => ({
  type: "text",
  text: body,
  fontFamily: "Segoe UI",
  sizePx,
  color: "#ffffff",
  bold: false,
  italic: false,
});

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `LINE ${i + 1}`).join("\n");

describe("MAX_DIM", () => {
  it("is the same 8192 its siblings clamp to", () => {
    // A silent widening here would re-open the gap between the text path and
    // evenDim / clampCanvas, which is the shape of the original bug.
    expect(MAX_DIM).toBe(8192);
  });
});

describe("fitTextSize (pure)", () => {
  it("leaves a box that already fits completely alone", () => {
    expect(fitTextSize({ width: 1200, height: 240 }, 96)).toEqual({
      sizePx: 96,
      fits: true,
    });
    // exactly on the limit is still fitting
    expect(fitTextSize({ width: MAX_DIM, height: MAX_DIM }, 96)).toEqual({
      sizePx: 96,
      fits: true,
    });
  });

  it("scales the size down by the overflow ratio, on whichever axis binds", () => {
    // The reported trigger, with the shipped Segoe UI metrics that produced it:
    // 391 characters on one line at 96 px measures 42.0 px/char = 16422 px.
    // 8192/16422 = 0.4988 -> 47 px.
    expect(fitTextSize({ width: 16422, height: 120 }, 96)).toEqual({
      sizePx: 47,
      fits: true,
    });
    // the same ratio on the other axis must give the same answer
    expect(fitTextSize({ width: 120, height: 16422 }, 96)).toEqual({
      sizePx: 47,
      fits: true,
    });
  });

  it("floors rather than rounds, so the result is never still over", () => {
    // 8192/8200 * 96 = 95.906: rounding would return 96 and change nothing.
    expect(fitTextSize({ width: 8200, height: 120 }, 96).sizePx).toBe(95);
  });

  it("always makes progress while the box overflows", () => {
    for (const w of [8194, 9000, 12345, 40000, 250000]) {
      for (const size of [9, 16, 96, 512]) {
        const r = fitTextSize({ width: w, height: 10 }, size);
        if (r.fits) expect(r.sizePx).toBeLessThan(size);
      }
    }
  });

  it("reports fits=false when the size needed is below the minimum", () => {
    // 96 * 8192/120000 = 6.55 -> below MIN_SIZE, so no allowed size fits.
    const r = fitTextSize({ width: 120000, height: 120 }, 96);
    expect(r.fits).toBe(false);
    expect(r.sizePx).toBe(MIN_SIZE);
  });
});

describe("fitText", () => {
  it("does not touch text that already fits", () => {
    const g = text("Title\nSecond line");
    const fit = fitText(g);
    expect(fit.tooLarge).toBe(false);
    expect(fit.shrunkFrom).toBeNull();
    expect(fit.gen).toBe(g); // the same object: no gratuitous rewrite of sizePx
    expect(fit.height).toBe(240); // 2 lines * 96 * 1.25
  });

  /* ---- the two real triggers ---- */

  it("shrinks a single line that is too wide, and keeps every character", () => {
    const body = "A quote pasted as one long line. ".repeat(13).slice(0, 400);
    const g = text(body);
    // the trigger is real: the natural box genuinely overflows
    expect(measureText(g).width).toBeGreaterThan(MAX_DIM);

    const fit = fitText(g);
    expect(fit.tooLarge).toBe(false);
    expect(fit.shrunkFrom).toBe(96);
    expect(fit.gen.sizePx).toBeLessThan(96);
    expect(fit.gen.sizePx).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(fit.width).toBeLessThanOrEqual(MAX_DIM);
    expect(fit.height).toBeLessThanOrEqual(MAX_DIM);
    // nothing is dropped or ellipsised — only the size moved
    expect(fit.gen.text).toBe(body);
    expect({ ...fit.gen, sizePx: 96 }).toEqual(g);
  });

  it("shrinks a line count that is too tall (137 lines at 96 px)", () => {
    const g = text(lines(137));
    // 137 * 96 * 1.25 = 16440, over twice the limit
    expect(measureText(g).height).toBe(16440);

    const fit = fitText(g);
    expect(fit.tooLarge).toBe(false);
    expect(fit.shrunkFrom).toBe(96);
    // 96 * 8192/16440 = 47.83 -> 47; 137 * 47 * 1.25 = 8048.75 -> 8050 even.
    expect(fit.gen.sizePx).toBe(47);
    expect(fit.height).toBe(8050);
    expect(fit.width).toBeLessThanOrEqual(MAX_DIM);
  });

  /* ---- the floor, where shrinking runs out ---- */

  it("still fits at the smallest size when it just barely can (819 lines)", () => {
    const fit = fitText(text(lines(819)));
    expect(fit.tooLarge).toBe(false);
    expect(fit.gen.sizePx).toBe(MIN_SIZE);
    expect(fit.height).toBe(8190); // 819 * 8 * 1.25, two px under the limit
    expect(fit.shrunkFrom).toBe(96);
  });

  it("refuses one line further, instead of committing a crop (820 lines)", () => {
    const fit = fitText(text(lines(820)));
    expect(fit.tooLarge).toBe(true);
    expect(fit.shrunkFrom).toBeNull();
    // the reported box is the one at MIN_SIZE — the smallest this text can be —
    // so the refusal can say by how much it misses
    expect(fit.gen.sizePx).toBe(MIN_SIZE);
    expect(fit.height).toBe(8200); // 820 * 8 * 1.25
    expect(fit.height).toBeGreaterThan(MAX_DIM);
  });

  /* ---- the invariant the bug actually broke ---- */

  it("returns dims that are a true measurement of the generator it returns", () => {
    // This is the preview/export agreement in one line. The preview sizes a div
    // to media.width/height and lets the glyphs flow from the top; the export
    // synthesizes a w*h frame and centres the same glyphs in boxw/boxh. They
    // describe the same picture only while the box equals the text — so the
    // committed dims must be measureText(committed generator), exactly.
    for (const g of [
      text("Title"),
      text(lines(3)),
      text(lines(137)),
      text(lines(819)),
      text("x".repeat(400)),
      text("x".repeat(400), 512),
      text("word ".repeat(200), 12),
      text("", 8),
    ]) {
      const fit = fitText(g);
      expect(measureText(fit.gen), `re-measure of ${fit.gen.sizePx}px`).toEqual({
        width: fit.width,
        height: fit.height,
      });
      if (!fit.tooLarge) {
        expect(fit.width, "fitted width").toBeLessThanOrEqual(MAX_DIM);
        expect(fit.height, "fitted height").toBeLessThanOrEqual(MAX_DIM);
      }
    }
  });

  it("never commits an over-size box across a sweep of shapes and sizes", () => {
    for (const size of [8, 12, 96, 200, 512]) {
      for (const chars of [1, 40, 400, 4000]) {
        for (const n of [1, 5, 200, 900]) {
          const body = Array.from({ length: n }, () => "x".repeat(chars)).join("\n");
          const g = text(body, size);
          const fit = fitText(g);
          const label = `${n} lines x ${chars} chars @ ${size}px`;
          if (fit.tooLarge) {
            // a refusal must be justified: the smallest allowed size overflows
            expect(fit.gen.sizePx, label).toBe(MIN_SIZE);
            expect(Math.max(fit.width, fit.height), label).toBeGreaterThan(MAX_DIM);
          } else {
            expect(fit.width, label).toBeLessThanOrEqual(MAX_DIM);
            expect(fit.height, label).toBeLessThanOrEqual(MAX_DIM);
            expect(fit.gen.sizePx, label).toBeLessThanOrEqual(size);
            expect(fit.gen.sizePx, label).toBeGreaterThanOrEqual(MIN_SIZE);
          }
        }
      }
    }
  });
});
