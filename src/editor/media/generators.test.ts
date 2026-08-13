// A text element's media box is whatever the text actually measures — full
// stop. No clamp, no shrink-to-fit, no refusal.
//
// WHAT THESE TESTS REPLACED, AND WHY. An earlier revision decided an oversized
// text box was a bug and added a fit layer: `fitTextSize`, `fitText`, a
// shrink-the-font loop, and a toast that refused the edit outright when even
// 8 px overflowed. The tests here asserted all of it. The owner ruled the whole
// idea out — long text must not auto-adjust, because a box far larger than the
// canvas is a thing people author on purpose: a title that starts enormous and
// animates down into frame is exactly that, and shrinking it silently takes the
// effect away. (Same ruling that removed contrast clamping from the theme
// system. It is a do-not-reintroduce.)
//
// The premise was false too. `placement()` in src-tauri/src/export/builder.rs
// computes `fit = (cw / fit_w).min(ch / fit_h)`, so media larger than the
// canvas is already scaled DOWN, automatically, in the preview and the export
// alike: a 16440-px-tall text box on a 1080-tall canvas draws the whole text,
// small and complete. The clip's own transform scale then multiplies it. The
// one genuine defect was two derivations of a single number disagreeing inside
// builder.rs, and it was fixed there.
//
// So these tests pin the opposite of what they used to: the natural box comes
// out of `measureText` untouched at the size the user asked for, and lands in
// the project exactly as measured. The parity invariant is unchanged and is
// still the point — the committed width/height must BE `measureText(gen)`,
// because the preview sizes a div to media.width/height while the export pins
// drawtext's layout box to the same pair. Those describe one picture only while
// the numbers match.
//
// The environment is "node" (vite.config.ts), so `measureText` takes its
// documented no-2D-context path and estimates advance widths. Every EXACT
// number asserted below is therefore on the height axis, which is
// `lines * sizePx * 1.25` and involves no font metrics at all — identical in
// node and in the webview. Widths are asserted by parity and by inequality, so
// a metric change makes a test fail rather than pass vacuously.

import { describe, expect, it } from "vitest";
import { addGeneratedMedia, createProject } from "../../core/project";
import type { Generator } from "../../core/types";
import { measureText, textLabel } from "./generators";

/** The caps this path used to be subjected to, kept only so the cases below can
 *  say "and this is comfortably past the number that used to trigger a shrink".
 *  Nothing in src/ compares against them any more. */
const FORMER_TEXT_CAP = 8192;
const FORMER_SYNTH_CAP = 16384;

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

/** What both call sites do: measure, then hand the measurement straight to
 *  addGeneratedMedia (the dialog) / updateMedia (the inspector) with no
 *  inspection in between. Returns the MediaRef that ends up in the project. */
const commit = (g: Extract<Generator, { type: "text" }>) => {
  const { width, height } = measureText(g);
  return addGeneratedMedia(createProject("t"), g, width, height, textLabel(g.text)).media;
};

describe("measureText", () => {
  it("returns the natural box, at the size asked for, for ordinary text", () => {
    const g = text("Title\nSecond line");
    expect(measureText(g).height).toBe(240); // 2 lines * 96 * 1.25
  });

  it("does not shrink a 400-character single line", () => {
    const body = "A quote pasted as one long line. ".repeat(13).slice(0, 400);
    const g = text(body);
    const box = measureText(g);

    // The case is real: this is far past every cap this path used to have.
    expect(box.width).toBeGreaterThan(FORMER_TEXT_CAP);
    expect(box.width).toBeGreaterThan(FORMER_SYNTH_CAP);
    // One line at 96 px is 120 px tall and stays 120 px tall — the old fit layer
    // would have dropped the font to ~47 px and this to ~60.
    expect(box.height).toBe(120);
  });

  it("does not shrink a 137-line block (the owner's own example)", () => {
    const g = text(lines(137));
    // 137 * 96 * 1.25 = 16440: over twice the old cap, committed as measured.
    expect(measureText(g).height).toBe(16440);
  });

  it("stays linear in sizePx, so nothing is silently capped", () => {
    // If any bound were still being applied, doubling the font size would stop
    // doubling the box at whatever that bound is.
    const at96 = measureText(text(lines(137), 96));
    const at192 = measureText(text(lines(137), 192));
    expect(at96.height).toBe(16440);
    expect(at192.height).toBe(32880);
    expect(at192.width).toBeGreaterThan(at96.width);
  });

  it("has no floor either — 8 px text keeps its own small box", () => {
    expect(measureText(text("Title", 8)).height).toBe(10); // 1 * 8 * 1.25
  });
});

describe("committing a text element", () => {
  it("stores exactly the measured box, unmodified, for a 400-char line", () => {
    const body = "A quote pasted as one long line. ".repeat(13).slice(0, 400);
    const g = text(body);
    const natural = measureText(g);
    const media = commit(g);

    expect({ width: media.width, height: media.height }).toEqual(natural);
    expect(media.width).toBeGreaterThan(FORMER_SYNTH_CAP);
    expect(media.height).toBe(120);
    // and the generator stored beside it is the user's, at the size they typed:
    // no rewritten sizePx, no defensive copy with a lowered font.
    expect(media.generator).toBe(g);
    expect((media.generator as Extract<Generator, { type: "text" }>).sizePx).toBe(96);
    expect((media.generator as Extract<Generator, { type: "text" }>).text).toBe(body);
  });

  it("stores exactly the measured box, unmodified, for 137 lines", () => {
    const g = text(lines(137));
    const natural = measureText(g);
    const media = commit(g);

    expect({ width: media.width, height: media.height }).toEqual(natural);
    expect(media.height).toBe(16440);
    expect(media.height).toBeGreaterThan(FORMER_TEXT_CAP);
    expect((media.generator as Extract<Generator, { type: "text" }>).sizePx).toBe(96);
  });

  it("commits dims that are a true measurement of the generator beside them", () => {
    // THE invariant, and the only one this path has. The preview sizes a div to
    // media.width/height and lets the glyphs flow inside it; the export
    // synthesizes a w*h frame and gives drawtext the same boxw/boxh. They
    // describe the same picture exactly while the box equals the text — which
    // it does by construction now that nothing adjusts either one.
    for (const g of [
      text("Title"),
      text(lines(3)),
      text(lines(137)),
      text(lines(819)),
      text(lines(820)), // the old refusal boundary: now an ordinary element
      text("x".repeat(400)),
      text("x".repeat(400), 512),
      text("word ".repeat(200), 12),
      text("", 8),
    ]) {
      const media = commit(g);
      const label = `${g.text.split("\n").length} lines @ ${g.sizePx}px`;
      expect({ width: media.width, height: media.height }, label).toEqual(measureText(g));
      expect(media.generator, label).toBe(g);
    }
  });

  it("never reduces a dimension, at any shape or size", () => {
    for (const size of [8, 12, 96, 200, 512]) {
      for (const chars of [1, 40, 400, 4000]) {
        for (const n of [1, 5, 200, 900]) {
          const body = Array.from({ length: n }, () => "x".repeat(chars)).join("\n");
          const g = text(body, size);
          const media = commit(g);
          const label = `${n} lines x ${chars} chars @ ${size}px`;
          // height is pure arithmetic, so it can be pinned outright
          expect(media.height, label).toBe(Math.max(2, Math.ceil((n * size * 1.25) / 2) * 2));
          // width is never below the em-based estimate of the widest line
          expect(media.width, label).toBeGreaterThanOrEqual(chars * size * 0.6);
          expect((media.generator as Extract<Generator, { type: "text" }>).sizePx, label).toBe(size);
        }
      }
    }
  });
});

describe("the fit layer stays deleted", () => {
  it("exports no shrink-to-fit, no cap and no refusal for text", async () => {
    const mod = await import("./generators");
    const keys = Object.keys(mod);
    // MAX_DIM is still a module-private constant for the SOLID path, where the
    // box is a number the user types rather than one we measure. It must not
    // become reachable from the text path again.
    for (const gone of ["fitText", "fitTextSize", "textShrunkNote", "showTextTooLarge", "MAX_DIM"]) {
      expect(keys, `${gone} must stay deleted`).not.toContain(gone);
    }
  });
});
