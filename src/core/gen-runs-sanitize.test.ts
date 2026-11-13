// The load-time check of text style runs (0.9.5): a structural fault drops
// the whole list, a bad field only that field, a clean list keeps its
// reference. Each bad input differs from the clean one on one thing.

import { describe, expect, it } from "vitest";
import { sanitizeGenRuns } from "./gen-runs-sanitize";
import { sanitizeMediaRef } from "./project";
import type { Generator, MediaRef, PdfTextRun } from "./types";
import { PDF_TEXT_MAX_RUNS } from "./types";

type TextGen = Extract<Generator, { type: "text" }>;

const TEXT = "A\u{1F600}bc de\nFég hij";
const clean = (): PdfTextRun[] => [
  { s: 1, e: 5, size: 64, c: "#aa5500" },
  { s: 9, e: 13, font: "Georgia", fontId: "lib:Test Sans", bold: true },
];
const gen = (runs: unknown): TextGen =>
  ({ type: "text", text: TEXT, fontFamily: "Arial", sizePx: 40, color: "#112233", bold: false, italic: true, runs }) as TextGen;

describe("sanitizeGenRuns", () => {
  it("keeps a clean list and a text without runs as they are", () => {
    const g = gen(clean());
    expect(sanitizeGenRuns(g)).toBe(g);
    const { runs: _r, ...plain } = g;
    void _r;
    const p = plain as TextGen;
    expect(sanitizeGenRuns(p)).toBe(p);
  });

  it.each([
    ["unsorted", [clean()[1], clean()[0]]],
    ["overlapping", [{ s: 1, e: 6, c: "#aa5500" }, { s: 5, e: 7, c: "#000001" }]],
    ["e past the text", [{ s: 1, e: 17, c: "#aa5500" }]],
    ["s == e", [{ s: 4, e: 4, c: "#aa5500" }]],
    ["a split surrogate", [{ s: 2, e: 5, c: "#aa5500" }]],
    ["not integers", [{ s: 1.5, e: 5, c: "#aa5500" }]],
    ["not an array", { s: 1, e: 5 }],
    ["2001 runs", Array.from({ length: PDF_TEXT_MAX_RUNS + 1 }, () => ({ s: 0, e: 1, c: "#000000" }))],
  ])("drops the whole list: %s", (_why, runs) => {
    const out = sanitizeGenRuns(gen(runs));
    expect("runs" in out).toBe(false);
    expect(out.text).toBe(TEXT);
    expect(out.fontFamily).toBe("Arial");
  });

  it.each([
    ["colour 'red'", { c: "red" }, "c"],
    ["font with markup", { font: "Arial;}<img>" }, "font"],
    // isFontId's shape (a name: no control characters, no edge spaces)
    ["an ill-shaped font id", { font: "Arial", fontId: " Inter\u0007" }, "fontId"],
    ["a NaN size", { size: Number.NaN }, "size"],
    ["a string bold", { bold: "yes" }, "bold"],
  ])("drops one field: %s", (_why, bad, field) => {
    const runs = clean();
    runs[0] = { ...runs[0]!, ...(bad as object) } as PdfTextRun;
    const out = sanitizeGenRuns(gen(runs));
    expect(out.runs).toHaveLength(2);
    expect(field in out.runs![0]!).toBe(false);
    expect(out.runs![1]).toEqual(clean()[1]);
  });

  it("a bad font takes its font id with it; a font id alone is dropped", () => {
    const out = sanitizeGenRuns(gen([{ s: 1, e: 5, font: "Comic", fontId: "lib:Ok", c: "#aa5500" }]));
    expect(out.runs).toEqual([{ s: 1, e: 5, c: "#aa5500" }]);
    const alone = sanitizeGenRuns(gen([{ s: 1, e: 5, fontId: "lib:Ok", c: "#aa5500" }]));
    expect(alone.runs).toEqual([{ s: 1, e: 5, c: "#aa5500" }]);
  });

  it("clamps sizes, normalizes colours, copies no other key, drops a run left empty", () => {
    const out = sanitizeGenRuns(
      gen([
        { s: 0, e: 1, size: 4000, c: "#ABC", evil: 1 },
        { s: 1, e: 3, c: "nope" },
      ]),
    );
    expect(out.runs).toEqual([{ s: 0, e: 1, size: 2048, c: "#aabbcc" }]);
    expect("runs" in sanitizeGenRuns(gen([]))).toBe(false);
  });

  it("is what sanitizeMediaRef runs, and only on a text with runs", () => {
    const m = (g: Generator): MediaRef => ({ id: "m", path: "Text", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 4, height: 4, generator: g });
    const ok = m(gen(clean()));
    expect(sanitizeMediaRef(ok)).toBe(ok);
    const bad = sanitizeMediaRef(m(gen([{ s: 4, e: 2 }])));
    expect("runs" in (bad.generator as TextGen)).toBe(false);
  });
});
