// Style runs on text generators (0.9.5): the base mapping, the one setter,
// typing that follows the runs, range and whole-text styling, the
// right-to-left rule, the face rule and the run key.
//
// Fixture: base Arial 40 px #112233, not bold, italic. The text's UTF-16
// length (16) differs from its code-point count (15): the emoji is a pair.
// run1 [1,5) = size 64 + #aa5500 (the emoji and "bc"); run2 [9,13) = Georgia
// with a library font, bold ("Fég "), on the second row.

import { describe, expect, it } from "vitest";
import {
  activeRuns,
  changedRunFields,
  genFontRequests,
  genRunBase,
  genSegments,
  genSummary,
  hasStrongRtl,
  honourRunFaces,
  isRtlCodePoint,
  runsKey,
  styleGenRange,
  styleGenRangeChecked,
  styleGenWhole,
  withGenText,
  withRunsKey,
  type TextGen,
} from "./gen-text-runs";
import { PDF_TEXT_MAX_RUNS, type PdfTextRun } from "./types";

const TEXT = "A\u{1F600}bc de\nFég hij";
const RUN1: PdfTextRun = { s: 1, e: 5, size: 64, c: "#aa5500" };
const RUN2: PdfTextRun = { s: 9, e: 13, font: "Georgia", fontId: "lib:Test Sans", bold: true };

const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: TEXT,
  fontFamily: "Arial",
  sizePx: 40,
  color: "#112233",
  bold: false,
  italic: true,
  runs: [RUN1, RUN2],
  ...over,
});

describe("genRunBase", () => {
  it("maps each field of the generator", () => {
    expect(TEXT.length).toBe(16);
    expect(genRunBase(gen())).toEqual({ font: "Arial", size: 40, c: "#112233", bold: false, italic: true });
    expect(genRunBase(gen({ fontFamily: "Impact" })).font).toBe("Impact");
    expect(genRunBase(gen({ sizePx: 41 })).size).toBe(41);
    expect(genRunBase(gen({ color: "#445566" })).c).toBe("#445566");
    expect(genRunBase(gen({ bold: true })).bold).toBe(true);
    expect(genRunBase(gen({ italic: false })).italic).toBe(false);
    expect(genRunBase(gen({ fontId: "lib:X" })).fontId).toBe("lib:X");
    expect("fontId" in genRunBase(gen())).toBe(false);
  });
});

describe("withRunsKey", () => {
  it("deletes the key for none, keeps the reference when unchanged", () => {
    const g = gen();
    const none = withRunsKey(g, undefined);
    expect("runs" in none).toBe(false);
    expect("runs" in withRunsKey(g, [])).toBe(false);
    expect(withRunsKey(none, undefined)).toBe(none);
    expect(withRunsKey(g, g.runs)).toBe(g);
  });
});

describe("withGenText", () => {
  it("a text without runs is { ...g, text }", () => {
    const g = withRunsKey(gen(), undefined);
    const n = withGenText(g, "xy");
    expect(n).toEqual({ ...g, text: "xy" });
    expect(Object.keys(n)).toEqual(Object.keys(g));
    expect(withGenText(g, g.text)).toBe(g);
  });

  it("typing inside run1 widens it", () => {
    // "A😀b|c": insert "Z" at 4
    const t = TEXT.slice(0, 4) + "Z" + TEXT.slice(4);
    const n = withGenText(gen(), t, { s: 4, e: 4 });
    expect(n.runs![0]).toEqual({ s: 1, e: 6, size: 64, c: "#aa5500" });
    expect(n.runs![1]).toEqual({ ...RUN2, s: 10, e: 14 });
  });

  it("deleting across run1 and run2 cuts both", () => {
    // remove [3, 10): "bc de\nF"
    const t = TEXT.slice(0, 3) + TEXT.slice(10);
    const n = withGenText(gen(), t, { s: 3, e: 10 });
    expect(n.text).toBe("A\u{1F600}ég hij");
    expect(n.runs).toEqual([
      { s: 1, e: 3, size: 64, c: "#aa5500" },
      { s: 3, e: 6, font: "Georgia", fontId: "lib:Test Sans", bold: true },
    ]);
  });

  it("replacing the emoji keeps the pair whole", () => {
    const t = "A" + "Q" + TEXT.slice(3);
    const n = withGenText(gen(), t);
    expect(n.runs![0]).toEqual({ s: 1, e: 4, size: 64, c: "#aa5500" });
  });
});

describe("styleGenRange", () => {
  it("styles a range and is the same object on a no-op", () => {
    const g = gen();
    const n = styleGenRange(g, { s: 13, e: 16 }, { c: "#00ff00" });
    expect(n.runs![2]).toEqual({ s: 13, e: 16, c: "#00ff00" });
    expect(styleGenRange(g, { s: 1, e: 5 }, { size: 64 })).toBe(g);
    expect(styleGenRange(g, { s: 3, e: 3 }, { size: 9 })).toBe(g);
  });

  it("is refused past the run cap, and says so", () => {
    const text = "ab".repeat(PDF_TEXT_MAX_RUNS);
    const runs: PdfTextRun[] = [];
    for (let i = 0; i < PDF_TEXT_MAX_RUNS; i++) runs.push({ s: i * 2, e: i * 2 + 1, c: i % 2 ? "#010101" : "#020202" });
    const g = gen({ text, runs });
    const r = styleGenRangeChecked(g, { s: text.length - 1, e: text.length }, { c: "#030303" });
    expect(r.gen).toBe(g);
    expect(r.refused).toBe(true);
    // a no-op is not a refusal
    expect(styleGenRangeChecked(g, { s: 0, e: 1 }, { c: "#020202" }).refused).toBe(false);
  });
});

describe("styleGenWhole", () => {
  it("clears only the changed field from the runs", () => {
    const old = gen({ runs: [{ s: 0, e: 5, size: 96 }, { s: 6, e: 11, c: "#ff3300" }] });
    const next = styleGenWhole({ ...old, sizePx: 50 }, old);
    expect(next.runs).toEqual([{ s: 6, e: 11, c: "#ff3300" }]);
    expect(next.sizePx).toBe(50);
    expect(changedRunFields(old, { ...old, sizePx: 50 })).toEqual(["size"]);
    const same = { ...old };
    expect(styleGenWhole(same, old)).toBe(same);
  });
});

describe("right-to-left", () => {
  it("pins the table edges", () => {
    expect(isRtlCodePoint(0x058f)).toBe(false);
    expect(isRtlCodePoint(0x0590)).toBe(true);
    expect(isRtlCodePoint(0x08ff)).toBe(true);
    expect(isRtlCodePoint(0x0900)).toBe(false);
    expect(isRtlCodePoint(0xfb1c)).toBe(false);
    expect(isRtlCodePoint(0xfb1d)).toBe(true);
    expect(isRtlCodePoint(0xfdff)).toBe(true);
    expect(isRtlCodePoint(0xfe6f)).toBe(false);
    expect(isRtlCodePoint(0xfe70)).toBe(true);
    expect(isRtlCodePoint(0xfefe)).toBe(true);
    expect(isRtlCodePoint(0xfeff)).toBe(false);
    expect(hasStrongRtl("﻿Hello")).toBe(false);
    expect(isRtlCodePoint(0x107ff)).toBe(false);
    expect(isRtlCodePoint(0x10800)).toBe(true);
    expect(isRtlCodePoint(0x10fff)).toBe(true);
    expect(isRtlCodePoint(0x1e7ff)).toBe(false);
    expect(isRtlCodePoint(0x1e800)).toBe(true);
    expect(isRtlCodePoint(0x1efff)).toBe(true);
    expect(isRtlCodePoint(0x1f000)).toBe(false);
    expect(hasStrongRtl("abc \u{1F600}")).toBe(false);
    expect(hasStrongRtl("ab\u{10900}")).toBe(true);
  });

  it("activeRuns: undefined for Hebrew and for []", () => {
    const g = gen();
    expect(activeRuns(g)).toBe(g.runs);
    expect(activeRuns(gen({ text: TEXT + "א" }))).toBeUndefined();
    expect(activeRuns(gen({ runs: [] }))).toBeUndefined();
    expect(activeRuns(withRunsKey(gen(), undefined))).toBeUndefined();
  });
});

describe("reading", () => {
  it("segments, summary and font requests", () => {
    const g = gen();
    const segs = genSegments(g);
    expect(segs.map((s) => [s.s, s.e])).toEqual([
      [0, 1],
      [1, 5],
      [5, 9],
      [9, 13],
      [13, 16],
    ]);
    expect(segs[1]!.style.size).toBe(64);
    expect(segs[3]!.style.font).toBe("Georgia");
    const sum = genSummary(g, { s: 9, e: 13 });
    expect(sum.bold).toBe(true);
    expect(sum.fontId).toBe("lib:Test Sans");
    expect(genSummary(g, { s: 8, e: 13 }).bold).toBe(false);
    expect(genFontRequests(g)).toEqual([{ id: "lib:Test Sans", bold: true, italic: true }]);
    expect(genFontRequests(withRunsKey(gen({ fontId: undefined }), [{ s: 0, e: 1, c: "#000000" }]))).toEqual([]);
  });

  it("honourRunFaces turns bold off on an Impact run, and keeps g otherwise", () => {
    const can = (font: string) => ({ bold: font !== "Impact", italic: font !== "Impact" });
    const g = gen({ italic: false, runs: [{ s: 0, e: 1, font: "Impact", bold: true }, RUN1] });
    const n = honourRunFaces(g, can);
    expect(n.runs).toEqual([{ s: 0, e: 1, font: "Impact" }, RUN1]);
    const ok = gen({ italic: false });
    expect(honourRunFaces(ok, can)).toBe(ok);
  });

  it("runsKey is memoised per array and differs per field", () => {
    const a = [RUN1];
    expect(runsKey(a)).toBe(runsKey(a));
    expect(runsKey([RUN1])).not.toBe(runsKey([{ ...RUN1, c: "#aa5501" }]));
    expect(runsKey([RUN1])).not.toBe(runsKey([{ ...RUN1, e: 4 }]));
  });
});
