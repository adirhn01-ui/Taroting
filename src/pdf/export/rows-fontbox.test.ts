// Rows of a text box with style runs in several FONTS (0.9.5): the export
// lays each row out with the same font box the screen reads (`fontBoxOf`, or
// the browser's own answer through `deps.fontBox`), not the font file's hhea
// ascent / descent, so every baseline lands where the editor shows it and a
// box sized to its text on screen holds its last line in the PDF.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fontBoxOf, rowMetrics, type RowPiece } from "../../core/pdf-runs";
import type { FontEmbed, FontRequest, PdfAnnot, PdfTextRun, ResolvedFont } from "../../core/types";
import type { FontBoxSpec } from "./deps";
import { fkFontOf, fontBoxTables } from "./shape";
import { appear, CONSOLAS, fontFile, hasFont, nodeDeps, textBox } from "./testkit";

type Box = Extract<PdfAnnot, { t: "text" }>;

function byId(map: Record<string, [string, FontEmbed]>) {
  return async (reqs: FontRequest[]): Promise<ResolvedFont[]> =>
    reqs.map((r) => {
      const f = map[r.id];
      return f
        ? { requested: r.id, found: true, bold: false, italic: false, path: f[0], lineHeightEm: 1.2, embed: f[1] }
        : { requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" };
    });
}

/** Baselines (user space y) of every text show, top line first, one per row. */
function baselines(ops: string): number[] {
  const ys = [...ops.matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)].map((m) => Number(m[1]));
  return [...new Set(ys)].sort((a, b) => b - a);
}

const box = (path: string, size: number): RowPiece => ({ size, ...fontBoxOf(fontBoxTables(fkFontOf(readFileSync(path))), size) });
const hhea = (path: string, size: number): RowPiece => {
  const f = fkFontOf(readFileSync(path));
  return { size, asc: (Math.abs(f.ascent) / f.unitsPerEm) * size, desc: (Math.abs(f.descent) / f.unitsPerEm) * size };
};

/** The screen's rows for lines whose pieces are `rows`: tops and baselines. */
function screenRows(rows: RowPiece[][], strut: RowPiece): { baselines: number[]; height: number } {
  let top = 0;
  const out: number[] = [];
  for (const on of rows) {
    const m = rowMetrics(on, strut);
    out.push(top + m.baseline);
    top += m.height;
  }
  return { baselines: out, height: top };
}

const TOP = 792 - 90; // textBox's frame top, user space
const ARIAL = fontFile("Arial", false, false);
const TIMES = fontFile("Times New Roman", false, false);
const IMPACT = fontFile("Impact", false, false);

describe.skipIf(!hasFont("Arial") || !hasFont("Times New Roman") || !hasFont("Impact"))("rows of a box with runs in several fonts", () => {
  // three lines; the middle one holds a run in another font (and size)
  const text = "first line\nsecond CODE here\nthird";
  const S = 18;
  const E = 22;

  it("Arial with a Consolas run: every baseline where the screen puts it, the box holds the last line", async () => {
    const runs: PdfTextRun[] = [{ s: S, e: E, font: "Arial", fontId: "lib:Consolas" }];
    const strut = box(ARIAL, 12);
    const want = screenRows([[], [strut, box(CONSOLAS, 12)], []], strut);
    // the editor sizes the box to its rows: exactly that height
    const a: Box = textBox({ text, font: "Arial", size: 12, w: 300, h: want.height, runs });
    const out = (await appear(a, nodeDeps({ resolveFonts: byId({ "lib:Consolas": [CONSOLAS, "full"] }) })))!;
    const got = baselines(out.ops).map((y) => TOP - y);
    expect(got).toHaveLength(3);
    got.forEach((b, i) => expect(Math.abs(b - want.baselines[i]!)).toBeLessThan(0.0015));
    // the last line's descent ends inside the box
    expect(got[2]! + strut.desc).toBeLessThanOrEqual(want.height + 1e-9);
    // what the file's hhea metrics would have done: the last baseline more
    // than a point lower, its descent past the box
    const old = screenRows([[], [hhea(ARIAL, 12), hhea(CONSOLAS, 12)], []], hhea(ARIAL, 12));
    expect(old.baselines[2]! - want.baselines[2]!).toBeGreaterThan(1);
  });

  it("Times with a 24 pt Impact run: baselines follow the font box at both sizes", async () => {
    const runs: PdfTextRun[] = [{ s: S, e: E, font: "Impact", size: 24 }];
    const strut = box(TIMES, 11);
    const want = screenRows([[], [strut, box(IMPACT, 24)], []], strut);
    const a: Box = textBox({ text, font: "Times New Roman", size: 11, w: 300, h: want.height, runs });
    const got = baselines((await appear(a))!.ops).map((y) => TOP - y);
    expect(got).toHaveLength(3);
    got.forEach((b, i) => expect(Math.abs(b - want.baselines[i]!)).toBeLessThan(0.0015));
  });

  it("the browser's answer (deps.fontBox) wins over the rule, asked per style with the style's own font", async () => {
    const asked: FontBoxSpec[] = [];
    // numbers no font file gives, different per size, so a baseline can only
    // match if they were used
    const fontBox = async (spec: FontBoxSpec) => {
      asked.push(spec);
      return { asc: spec.size * 0.7 + (spec.fontId ? 2 : 0.5), desc: spec.size * 0.35 };
    };
    const runs: PdfTextRun[] = [{ s: S, e: E, font: "Arial", fontId: "lib:Consolas", size: 20 }];
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Consolas": [CONSOLAS, "full"] }), fontBox });
    const a: Box = textBox({ text, font: "Arial", size: 12, w: 300, h: 300, runs });
    const got = baselines((await appear(a, deps))!.ops).map((y) => TOP - y);
    const strut = { size: 12, asc: 12 * 0.7 + 0.5, desc: 12 * 0.35 };
    const want = screenRows([[], [strut, { size: 20, asc: 20 * 0.7 + 2, desc: 20 * 0.35 }], []], strut);
    got.forEach((b, i) => expect(Math.abs(b - want.baselines[i]!)).toBeLessThan(0.0015));
    expect(asked).toContainEqual({ font: "Arial", bold: false, italic: false, size: 12 });
    expect(asked).toContainEqual({ font: "Arial", fontId: "lib:Consolas", bold: false, italic: false, size: 20 });
  });

  it("a box without runs never asks for a font box and keeps its fixed pitch (R1)", async () => {
    const asked: FontBoxSpec[] = [];
    const deps = nodeDeps({
      fontBox: async (spec) => {
        asked.push(spec);
        return { asc: 1, desc: 1 };
      },
    });
    const got = baselines((await appear(textBox({ text, font: "Arial", size: 12, w: 300, h: 300 }), deps))!.ops);
    expect(asked).toEqual([]);
    expect(got[0]! - got[1]!).toBeCloseTo(15, 3);
    expect(got[1]! - got[2]!).toBeCloseTo(15, 3);
  });
});
