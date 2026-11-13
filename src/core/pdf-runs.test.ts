// Style runs of a PDF text box (0.9.4): the canonical form, following text
// edits, styling a range / the whole box, and what the screen, the inspector
// and the font loader read from them.

import { describe, expect, it } from "vitest";
import {
  RUN_LINE_HEIGHT,
  applyRunStyle,
  clearRunFields,
  fontBoxOf,
  normalizeRuns,
  remapRuns,
  rowMetrics,
  runFontRequests,
  runsEqual,
  segmentsOf,
  styleSummary,
  type PdfRunBase,
} from "./pdf-runs";
import { PDF_TEXT_MAX_RUNS, type PdfTextRun } from "./types";
import { LINE_HEIGHT } from "../pdf/export/layout";
import { lineBaseline, textHeight } from "../pdf/editor/marks/geom";

/** Every field differs from what a default could fill in: bold ON, italic
 *  off, an odd size, a non-black colour, a non-default legacy font. */
const BASE: PdfRunBase = { font: "Georgia", size: 17, c: "#123456", bold: true, italic: false };
//            0123456789012345 6
const TEXT = "Hello brave world"; // 17
/** R1 = "llo" (colour), R2 = "ave " (size + italic): different fields, not
 *  touching each other or either end of the text. */
const R1: PdfTextRun = { s: 2, e: 5, c: "#aa0000" };
const R2: PdfTextRun = { s: 8, e: 12, size: 23, italic: true };
const RUNS = [R1, R2];

describe("normalizeRuns", () => {
  it("sorts", () => {
    expect(normalizeRuns(TEXT, BASE, [R2, R1])).toEqual([R1, R2]);
  });

  it("clips to the text (and drops what falls outside)", () => {
    expect(normalizeRuns(TEXT, BASE, [{ s: 14, e: 40, c: "#aa0000" }])).toEqual([{ s: 14, e: 17, c: "#aa0000" }]);
    expect(normalizeRuns(TEXT, BASE, [{ s: -3, e: 2, c: "#aa0000" }])).toEqual([{ s: 0, e: 2, c: "#aa0000" }]);
    expect(normalizeRuns(TEXT, BASE, [{ s: 20, e: 30, c: "#aa0000" }])).toBeUndefined();
  });

  it("merges identical neighbours, and only touching ones", () => {
    expect(normalizeRuns(TEXT, BASE, [R1, { s: 5, e: 9, c: "#aa0000" }])).toEqual([{ s: 2, e: 9, c: "#aa0000" }]);
    const apart = [R1, { s: 6, e: 9, c: "#aa0000" }];
    expect(normalizeRuns(TEXT, BASE, apart)).toEqual(apart);
  });

  it.each([
    ["size", { size: 17 }, { c: "#00bb00" }],
    ["c", { c: "#123456" }, { size: 29 }],
    ["bold", { bold: true }, { size: 29 }],
    ["italic", { italic: false }, { size: 29 }],
    ["font", { font: "Georgia" }, { size: 29 }],
  ] as const)("drops a field equal to the base (%s), keeping the run's other field", (_k, same, keep) => {
    expect(normalizeRuns(TEXT, BASE, [{ s: 3, e: 7, ...same, ...keep }])).toEqual([{ s: 3, e: 7, ...keep }]);
  });

  it("compares the font as a PAIR", () => {
    const base: PdfRunBase = { ...BASE, font: "Segoe UI", fontId: "lib:Inter" };
    // the legacy half equals the base, but the pair does not (no fontId = none)
    expect(normalizeRuns(TEXT, base, [{ s: 3, e: 7, font: "Segoe UI" }])).toEqual([{ s: 3, e: 7, font: "Segoe UI" }]);
    // the whole pair equals the base: dropped
    expect(normalizeRuns(TEXT, base, [{ s: 3, e: 7, font: "Segoe UI", fontId: "lib:Inter" }])).toBeUndefined();
    // a fontId without its font means nothing
    expect(normalizeRuns(TEXT, BASE, [{ s: 3, e: 7, fontId: "Consolas" }])).toBeUndefined();
  });

  it("an empty result is undefined (the key is deleted, never [])", () => {
    expect(normalizeRuns(TEXT, BASE, [{ s: 3, e: 7, c: "#123456" }])).toBeUndefined();
    expect(normalizeRuns(TEXT, BASE, [])).toBeUndefined();
    expect(normalizeRuns("", BASE, RUNS)).toBeUndefined();
  });

  it("never splits a surrogate pair: a start snaps down, an end up", () => {
    const t = "ab\u{1F600}cd"; // a0 b1 [2,4) c4 d5
    expect(normalizeRuns(t, BASE, [{ s: 3, e: 5, c: "#aa0000" }])).toEqual([{ s: 2, e: 5, c: "#aa0000" }]);
    expect(normalizeRuns(t, BASE, [{ s: 1, e: 3, c: "#aa0000" }])).toEqual([{ s: 1, e: 4, c: "#aa0000" }]);
  });

  it("where runs overlap, the later one wins field by field", () => {
    const out = normalizeRuns(TEXT, BASE, [
      { s: 2, e: 8, c: "#aa0000", size: 23 },
      { s: 5, e: 10, c: "#00bb00" },
    ]);
    expect(out).toEqual([
      { s: 2, e: 5, size: 23, c: "#aa0000" },
      { s: 5, e: 8, size: 23, c: "#00bb00" },
      { s: 8, e: 10, c: "#00bb00" },
    ]);
  });
});

describe("remapRuns", () => {
  it("typing inside a run grows it and shifts the runs after it", () => {
    expect(remapRuns(RUNS, TEXT, "HelXYlo brave world")).toEqual([
      { ...R1, e: 7 },
      { ...R2, s: 10, e: 14 },
    ]);
  });

  it("typing at a run's END extends it (the character before is in it)", () => {
    expect(remapRuns(RUNS, TEXT, "HelloZ brave world")).toEqual([
      { ...R1, e: 6 },
      { ...R2, s: 9, e: 13 },
    ]);
  });

  it("typing at a run's START does not join it (the character before is not in it)", () => {
    expect(remapRuns(RUNS, TEXT, "Hello brZave world")).toEqual([R1, { ...R2, s: 9, e: 13 }]);
  });

  it("at offset 0 the insertion takes the NEXT character's style", () => {
    const at0: PdfTextRun = { s: 0, e: 3, bold: false };
    expect(remapRuns([at0, R2], TEXT, "QHello brave world")).toEqual([
      { ...at0, e: 4 },
      { ...R2, s: 9, e: 13 },
    ]);
    // the next character is in no run: the insertion is in the base style
    expect(remapRuns(RUNS, TEXT, "QHello brave world")).toEqual([
      { ...R1, s: 3, e: 6 },
      { ...R2, s: 9, e: 13 },
    ]);
  });

  it("deleting across two runs cuts both", () => {
    // remove [4, 10) "o brav" -> "Helle world"
    expect(remapRuns(RUNS, TEXT, "Helle world")).toEqual([
      { ...R1, e: 4 },
      { ...R2, s: 4, e: 6 },
    ]);
  });

  it("deleting the gap between two identical runs merges them", () => {
    const a: PdfTextRun = { s: 2, e: 5, c: "#aa0000" };
    const b: PdfTextRun = { s: 8, e: 12, c: "#aa0000" };
    // remove [5, 8) " br" -> "Helloave world"
    expect(remapRuns([a, b], TEXT, "Helloave world")).toEqual([{ s: 2, e: 9, c: "#aa0000" }]);
  });

  it("a paste that replaces a range takes the style of the character before it", () => {
    // "ve" [9, 11) -> "XYZ"; the character before ("a", 8) is in R2
    expect(remapRuns(RUNS, TEXT, "Hello braXYZ world")).toEqual([R1, { ...R2, e: 13 }]);
  });

  it("a newline is text like any other", () => {
    // after "brave" (10, in R2)
    expect(remapRuns(RUNS, TEXT, "Hello brave\n world")).toEqual([R1, { ...R2, e: 13 }]);
  });

  it("a full replace leaves no runs", () => {
    expect(remapRuns(RUNS, TEXT, "Totally new")).toBeUndefined();
  });

  it("answers sorted runs whatever order they came in", () => {
    expect(remapRuns([R2, R1], TEXT, "HelXYlo brave world")).toEqual([
      { ...R1, e: 7 },
      { ...R2, s: 10, e: 14 },
    ]);
  });

  it("no change is the same runs; none in, none out", () => {
    expect(remapRuns(RUNS, TEXT, TEXT)).toEqual(RUNS);
    expect(remapRuns(undefined, TEXT, "x")).toBeUndefined();
  });

  it("a common prefix ending on a high surrogate is cut before it", () => {
    // U+1F600 -> U+1F601: same high surrogate, different low; the whole
    // character is replaced and the new one keeps the replaced one's style (D6)
    const run: PdfTextRun = { s: 2, e: 4, bold: false };
    expect(remapRuns([run], "ab\u{1F600}cd", "ab\u{1F601}cd")).toEqual([run]);
  });

  it("a common suffix starting on a low surrogate is cut after it", () => {
    // U+1F600 (D83D DE00) -> U+1FA00 (D83E DE00): same low, different high
    const run: PdfTextRun = { s: 1, e: 3, bold: false };
    expect(remapRuns([run], "a\u{1F600}", "a\u{1FA00}")).toEqual([run]);
  });
});

describe("applyRunStyle", () => {
  it("styles only the range, keeping each character's other fields", () => {
    expect(applyRunStyle(TEXT, BASE, RUNS, { s: 4, e: 10 }, { bold: false })).toEqual([
      { s: 2, e: 4, c: "#aa0000" },
      { s: 4, e: 5, c: "#aa0000", bold: false },
      { s: 5, e: 8, bold: false },
      { s: 8, e: 10, size: 23, bold: false, italic: true },
      { s: 10, e: 12, size: 23, italic: true },
    ]);
  });

  it("a value equal to the base takes the field off", () => {
    expect(applyRunStyle(TEXT, BASE, RUNS, { s: 2, e: 5 }, { c: "#123456" })).toEqual([R2]);
  });

  it("a font sets the PAIR: no fontId in the patch = none", () => {
    const base: PdfRunBase = { ...BASE, fontId: "lib:Inter" };
    expect(applyRunStyle(TEXT, base, undefined, { s: 6, e: 11 }, { font: "Arial" })).toEqual([{ s: 6, e: 11, font: "Arial" }]);
    const lib = applyRunStyle(TEXT, BASE, undefined, { s: 6, e: 11 }, { font: "Segoe UI", fontId: "Consolas" });
    expect(lib).toEqual([{ s: 6, e: 11, font: "Segoe UI", fontId: "Consolas" }]);
    // a later legacy pick over it removes its fontId
    expect(applyRunStyle(TEXT, BASE, lib, { s: 6, e: 11 }, { font: "Arial" })).toEqual([{ s: 6, e: 11, font: "Arial" }]);
  });

  it("a reversed range is the same range", () => {
    expect(applyRunStyle(TEXT, BASE, undefined, { s: 11, e: 6 }, { c: "#00bb00" })).toEqual([{ s: 6, e: 11, c: "#00bb00" }]);
  });

  it(`refuses a style that would take the box over ${PDF_TEXT_MAX_RUNS} runs`, () => {
    const text = "x".repeat(5000);
    const many: PdfTextRun[] = Array.from({ length: PDF_TEXT_MAX_RUNS }, (_, k) => ({ s: 2 * k, e: 2 * k + 1, bold: false }));
    const out = applyRunStyle(text, BASE, many, { s: 4500, e: 4501 }, { italic: true });
    expect(runsEqual(out, many)).toBe(true);
    // one under the cap: accepted
    const fewer = many.slice(1);
    expect(applyRunStyle(text, BASE, fewer, { s: 4500, e: 4501 }, { italic: true })).toHaveLength(PDF_TEXT_MAX_RUNS);
  });
});

describe("clearRunFields (apply to the whole box)", () => {
  const MIXED: PdfTextRun[] = [
    { s: 2, e: 5, font: "Arial", c: "#aa0000", size: 23 },
    { s: 8, e: 12, font: "Segoe UI", fontId: "Consolas", bold: false, italic: true },
  ];

  it.each([
    ["size", [{ s: 2, e: 5, font: "Arial", c: "#aa0000" }, MIXED[1]]],
    ["c", [{ s: 2, e: 5, font: "Arial", size: 23 }, MIXED[1]]],
    ["bold", [MIXED[0], { s: 8, e: 12, font: "Segoe UI", fontId: "Consolas", italic: true }]],
    ["italic", [MIXED[0], { s: 8, e: 12, font: "Segoe UI", fontId: "Consolas", bold: false }]],
    ["font", [{ s: 2, e: 5, c: "#aa0000", size: 23 }, { s: 8, e: 12, bold: false, italic: true }]],
  ] as const)("strips %s from every run (font: the pair)", (field, want) => {
    expect(clearRunFields(BASE, MIXED, [field])).toEqual(want);
  });

  it("an emptied run is dropped; nothing left is undefined", () => {
    expect(clearRunFields(BASE, RUNS, ["c"])).toEqual([R2]);
    expect(clearRunFields(BASE, RUNS, ["c", "size", "italic"])).toBeUndefined();
  });

  it("neighbours that become identical merge", () => {
    const runs: PdfTextRun[] = [
      { s: 2, e: 5, c: "#aa0000", size: 20 },
      { s: 5, e: 8, c: "#aa0000", size: 21 },
    ];
    expect(clearRunFields(BASE, runs, ["size"])).toEqual([{ s: 2, e: 8, c: "#aa0000" }]);
  });

  it("a field left equal to the NEW base is dropped too", () => {
    expect(clearRunFields({ ...BASE, italic: true }, RUNS, ["c"])).toEqual([{ s: 8, e: 12, size: 23 }]);
  });
});

describe("segmentsOf", () => {
  it("covers every character exactly once, gaps in the base style", () => {
    const segs = segmentsOf(TEXT, BASE, RUNS);
    expect(segs.map((g) => [g.s, g.e])).toEqual([
      [0, 2],
      [2, 5],
      [5, 8],
      [8, 12],
      [12, 17],
    ]);
    expect(segs[0]!.style).toStrictEqual({ font: "Georgia", size: 17, c: "#123456", bold: true, italic: false });
    expect(segs[1]!.style).toStrictEqual({ ...segs[0]!.style, c: "#aa0000" });
    expect(segs[3]!.style).toStrictEqual({ ...segs[0]!.style, size: 23, italic: true });
    expect(segs[4]!.style).toStrictEqual(segs[0]!.style);
  });

  it("resolves the font pair: a run's legacy font drops the base's fontId", () => {
    const base: PdfRunBase = { ...BASE, fontId: "lib:Inter" };
    const segs = segmentsOf(TEXT, base, [{ s: 3, e: 6, font: "Arial" }]);
    expect(segs[0]!.style.fontId).toBe("lib:Inter");
    expect("fontId" in segs[1]!.style).toBe(false);
    expect(segs[1]!.style.font).toBe("Arial");
  });

  it("no runs: one segment; empty text: none", () => {
    expect(segmentsOf(TEXT, BASE, undefined)).toHaveLength(1);
    expect(segmentsOf("", BASE, RUNS)).toEqual([]);
  });
});

describe("styleSummary", () => {
  it("a mixed range: the FIRST character's font, size and colour", () => {
    // [3, 10): "lo br" + "av"; the first character is in R1
    const s = styleSummary(TEXT, BASE, RUNS, { s: 3, e: 10 });
    expect(s.c).toBe("#aa0000");
    expect(s.size).toBe(17);
    // starting inside R2 instead
    expect(styleSummary(TEXT, BASE, RUNS, { s: 9, e: 14 }).size).toBe(23);
  });

  it("bold / italic are on only if EVERY character has them", () => {
    expect(styleSummary(TEXT, BASE, RUNS, { s: 3, e: 10 }).italic).toBe(false);
    expect(styleSummary(TEXT, BASE, RUNS, { s: 8, e: 12 }).italic).toBe(true);
    const off: PdfTextRun[] = [{ s: 9, e: 10, bold: false }];
    expect(styleSummary(TEXT, BASE, off, { s: 6, e: 12 }).bold).toBe(false);
    expect(styleSummary(TEXT, BASE, off, { s: 10, e: 12 }).bold).toBe(true);
  });

  it("null or a collapsed range = the whole box", () => {
    expect(styleSummary(TEXT, BASE, RUNS, null).c).toBe("#123456");
    expect(styleSummary(TEXT, BASE, RUNS, { s: 3, e: 3 }).c).toBe("#123456");
    expect(styleSummary(TEXT, BASE, RUNS, null).italic).toBe(false);
  });
});

describe("runFontRequests", () => {
  it("none for a legacy-only mark", () => {
    expect(runFontRequests(BASE, [{ s: 1, e: 3, font: "Arial", bold: false }])).toEqual([]);
  });

  it("base first, each run resolved over the base, deduplicated", () => {
    const base: PdfRunBase = { ...BASE, fontId: "lib:Inter" };
    const runs: PdfTextRun[] = [
      { s: 1, e: 3, italic: true },
      { s: 4, e: 5, font: "Arial" },
      { s: 6, e: 7, font: "Segoe UI", fontId: "Consolas", bold: false },
      { s: 9, e: 11, c: "#00bb00", italic: true },
    ];
    expect(runFontRequests(base, runs)).toEqual([
      { id: "lib:Inter", bold: true, italic: false },
      { id: "lib:Inter", bold: true, italic: true },
      { id: "Consolas", bold: false, italic: false },
    ]);
  });
});

describe("rowMetrics", () => {
  it("mirrors the export's LINE_HEIGHT", () => {
    expect(RUN_LINE_HEIGHT).toBe(LINE_HEIGHT);
  });

  it.each([
    [12, 10.86, 2.54],
    [17, 15.3, 4.25],
    [9.5, 8.791, 2.3713],
    [288, 270.1, 61.7],
    // descent deeper than the ascent: here A + (lh - A) is NOT lh in floating point
    [48.62, 26.302, 50.431],
  ])("a single-font row equals lineBaseline / textHeight exactly (size %s)", (size, asc, desc) => {
    const p = { size, asc, desc };
    const r = rowMetrics([p, p], p);
    expect(r.baseline).toBe(lineBaseline(0, size, asc, desc));
    expect(r.height).toBe(textHeight(1, size));
  });

  it("a bigger piece grows the row; a smaller one never shrinks it", () => {
    const strut = { size: 12, asc: 10.8, desc: 2.4 };
    const big = { size: 30, asc: 27, desc: 6 };
    const small = { size: 6, asc: 5.4, desc: 1.2 };
    const lhB = 30 * 1.25;
    const aB = (lhB - 33) / 2 + 27;
    expect(rowMetrics([small, big], strut)).toEqual({ height: lhB, baseline: aB });
    expect(rowMetrics([small], strut)).toEqual(rowMetrics([], strut));
  });

  it("max A and max D can come from different pieces", () => {
    const strut = { size: 10, asc: 9, desc: 1 }; // lh 12.5: A 10.25, D 2.25
    const deep = { size: 10, asc: 4, desc: 6 }; // lh 12.5: A 5.25, D 7.25
    expect(rowMetrics([deep], strut)).toEqual({ height: 10.25 + 7.25, baseline: 10.25 });
  });
});

describe("remapRuns with the editor's hint (D2) and replace-selection (D6)", () => {
  const B = (s: number, e: number): PdfTextRun => ({ s, e, bold: true });

  it("typing a repeated character at a run's edge: the hint puts it where the caret was", () => {
    // "aab", bold "a" [0,1), caret at 1, type "a": bold "aa" + plain "ab"
    expect(remapRuns([B(0, 1)], "aab", "aaab", { s: 1, e: 1 })).toEqual([B(0, 2)]);
    // without the hint the edit is guessed after the common prefix "aa"
    expect(remapRuns([B(0, 1)], "aab", "aaab")).toEqual([B(0, 1)]);
    // "aabb", bold "aa", caret at 2, type "b": bold "aab"
    expect(remapRuns([B(0, 2)], "aabb", "aabbb", { s: 2, e: 2 })).toEqual([B(0, 3)]);
    expect(remapRuns([B(0, 2)], "aabb", "aabbb")).toEqual([B(0, 2)]);
  });

  it("Backspace and forward Delete next to repeated characters remove the right one", () => {
    // Backspace at 1 in "aab" (bold [0,1)) removes the bold "a"
    expect(remapRuns([B(0, 1)], "aab", "ab", { s: 0, e: 1 })).toBeUndefined();
    expect(remapRuns([B(0, 1)], "aab", "ab")).toEqual([B(0, 1)]);
    // Delete at 2 in "aabb" (bold [2,3)) removes the bold "b"
    expect(remapRuns([B(2, 3)], "aabb", "aab", { s: 2, e: 3 })).toBeUndefined();
    expect(remapRuns([B(2, 3)], "aabb", "aab")).toEqual([B(2, 3)]);
  });

  it("a doubled space next to a styled word: the space typed after the styled one is styled", () => {
    // "word  b", bold "word " [0,5), caret at 5, type " "
    expect(remapRuns([B(0, 5)], "word  b", "word   b", { s: 5, e: 5 })).toEqual([B(0, 6)]);
    expect(remapRuns([B(0, 5)], "word  b", "word   b")).toEqual([B(0, 5)]);
    // caret at 4 (before the styled space), type " ": joins the bold "d"
    expect(remapRuns([B(0, 5)], "word  b", "word   b", { s: 4, e: 4 })).toEqual([B(0, 6)]);
  });

  it("text typed over a selection takes the style of the first replaced character, with and without the hint", () => {
    const runs: PdfTextRun[] = [B(0, 6), { s: 6, e: 11, c: "#ff0000" }];
    const out = [B(0, 6), { s: 6, e: 11, c: "#ff0000" }];
    expect(remapRuns(runs, "Hello world", "Hello there", { s: 6, e: 11 })).toEqual(out);
    expect(remapRuns(runs, "Hello world", "Hello there")).toEqual(out);
    // a pure insertion keeps the rule: the character before it (bold " ")
    expect(remapRuns(runs, "Hello world", "Hello Xworld", { s: 6, e: 6 })).toEqual([B(0, 7), { s: 7, e: 12, c: "#ff0000" }]);
    // at offset 0 a replacement takes the first replaced character too
    expect(remapRuns([{ s: 0, e: 2, c: "#ff0000" }], "abcd", "Xcd", { s: 0, e: 2 })).toEqual([{ s: 0, e: 1, c: "#ff0000" }]);
  });

  it("a hint that does not describe the edit is ignored (the guess)", () => {
    expect(remapRuns([B(0, 1)], "aab", "aaab", { s: 3, e: 3 })).toEqual(remapRuns([B(0, 1)], "aab", "aaab"));
    expect(remapRuns([B(0, 1)], "aab", "aaab", { s: 5, e: 5 })).toEqual(remapRuns([B(0, 1)], "aab", "aaab"));
  });
});

describe("fontBoxOf (the font box rows are laid out with)", () => {
  // Tables as the files state them (C:/Windows/Fonts, measured once).
  const ARIAL = { unitsPerEm: 2048, winAscent: 1854, winDescent: 434, typoAscender: 1491, typoDescender: -431, useTypoMetrics: false };
  const CALIBRI = { unitsPerEm: 2048, winAscent: 1950, winDescent: 550, typoAscender: 1536, typoDescender: -512, useTypoMetrics: false };
  const GABRIOLA = { unitsPerEm: 4096, winAscent: 4880, winDescent: 2660, typoAscender: 2800, typoDescender: -1296, useTypoMetrics: true };

  it("winAscent / winDescent rounded to whole px at the size", () => {
    // 10.86 → 11, 2.54 → 3
    expect(fontBoxOf(ARIAL, 12)).toEqual({ asc: 11, desc: 3 });
    // Calibri's box, not its hhea (1536 / 512): 12.38 → 12, 3.49 → 3
    expect(fontBoxOf(CALIBRI, 13)).toEqual({ asc: 12, desc: 3 });
  });

  it("the typo metrics when the font sets USE_TYPO_METRICS", () => {
    // 13.67 → 14, 6.33 → 6 (win would be 23.83 / 12.99)
    expect(fontBoxOf(GABRIOLA, 20)).toEqual({ asc: 14, desc: 6 });
  });

  it("a tiny face keeps the fraction", () => {
    const b = fontBoxOf(ARIAL, 2);
    expect(b.asc).toBeCloseTo((1854 / 2048) * 2, 9);
    expect(b.desc).toBeCloseTo((434 / 2048) * 2, 9);
  });
});
