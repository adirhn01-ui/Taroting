// PDF export of text boxes with style runs (0.9.4): each piece in its own
// face, size and colour, wrapped by the sum of its pieces, rows by
// `rowMetrics`, lines as visual groups. Real pdf-lib + fontkit in node, stock
// Windows font files as stand-ins (Consolas / Calibri for library fonts);
// nothing is installed.

import { existsSync, readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { fontBoxOf, rowMetrics } from "../../core/pdf-runs";
import { fkFontOf, fontBoxTables } from "./shape";
import type { FontEmbed, FontRequest, PdfAnnot, PdfTextRun, ResolvedFont } from "../../core/types";
import { paragraphBidi, visualGroups } from "./bidi";
import { PdfExportError } from "./errors";
import { buildPdf } from "./export";
import { appear, CONSOLAS, consolas, fontFile, hasFixture, hasFont, nodeDeps, pg, project, readBack, source, textBox } from "./testkit";

const CALIBRI = "C:/Windows/Fonts/calibri.ttf";
type Box = Extract<PdfAnnot, { t: "text" }>;

/** The text-showing operations of an appearance, each with the font and
 *  colour in force. */
function shows(ops: string): { font: string; color: string; x: number; y: number; glyphs: number }[] {
  const out: { font: string; color: string; x: number; y: number; glyphs: number }[] = [];
  const bt = ops.slice(ops.indexOf(" BT "));
  const re = /(\/F\d+ [\d.]+ Tf)|([-\d.]+ [-\d.]+ [-\d.]+) rg|1 0 0 1 ([-\d.]+) ([-\d.]+) Tm <([0-9A-F]*)> Tj/g;
  let font = "";
  let color = "";
  for (const m of bt.matchAll(re)) {
    if (m[1]) font = m[1];
    else if (m[2]) color = m[2];
    else out.push({ font, color, x: Number(m[3]), y: Number(m[4]), glyphs: m[5]!.length / 4 });
  }
  return out;
}

const fontNames = (res: unknown): string[] => Object.keys((res as { Font?: Record<string, string> }).Font ?? {});

/** Every /BaseFont the output names. */
async function baseFonts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Type"))?.toString() !== "/Font") continue;
    const b = obj.get(PDFName.of("BaseFont"));
    if (b) out.push(b.toString());
  }
  return out;
}

async function exportOne(a: PdfAnnot, deps = nodeDeps(), flattenMarks = false): Promise<Uint8Array> {
  const plain = source("plain_3p.pdf");
  const page = pg(plain, 0);
  return buildPdf(project([plain], [page], { [page.id]: [a] }), { flattenMarks, flattenForms: false }, deps);
}

/** fonts_resolve by id: each id's file and policy, or missing. */
function byId(map: Record<string, [string, FontEmbed] | null>) {
  return async (reqs: FontRequest[]): Promise<ResolvedFont[]> =>
    reqs.map((r) => {
      const f = map[r.id];
      return f
        ? { requested: r.id, found: true, bold: false, italic: false, path: f[0], lineHeightEm: 1.2, embed: f[1] }
        : { requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" };
    });
}

/** A face's width of `s` at `size` and its ascent/descent in em, from the file. */
function face(path: string) {
  const f = fontkit.create(readFileSync(path)) as unknown as {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    layout(s: string): { advanceWidth: number };
  };
  return {
    width: (s: string, size: number) => (f.layout(s).advanceWidth / f.unitsPerEm) * size,
    asc: Math.abs(f.ascent) / f.unitsPerEm,
    desc: Math.abs(f.descent) / f.unitsPerEm,
  };
}

const withRuns = (over: Partial<Box>, runs: PdfTextRun[]): Box => textBox({ ...over, runs });

describe.skipIf(!hasFixture("plain_3p.pdf") || !hasFont("Georgia") || !hasFont("Arial") || !hasFont("Times New Roman") || !hasFont("Courier New") || !existsSync(CONSOLAS) || !existsSync(CALIBRI))("text box style runs in export", () => {
  it("a bold run and a run in another font: three faces, selected in order; plain Contents and base DA", async () => {
    const a = withRuns({ text: "Hello bold world" }, [{ s: 6, e: 10, bold: true }, { s: 11, e: 16, font: "Times New Roman" }]);
    const out = (await appear(a))!;
    expect(fontNames(out.resources)).toEqual(["F0", "F1", "F2"]);
    const sh = shows(out.ops);
    expect(sh.map((x) => x.font)).toEqual(["/F0 13 Tf", "/F1 13 Tf", "/F0 13 Tf", "/F2 13 Tf"]);
    expect(sh.map((x) => x.glyphs)).toEqual([6, 4, 1, 5]);
    // one baseline, left to right
    expect(new Set(sh.map((x) => x.y)).size).toBe(1);
    expect(sh.every((x, i) => i === 0 || x.x > sh[i - 1]!.x)).toBe(true);
    expect((out.annot as Record<string, string>)["DA"]).toBe("str (0.063 0.125 0.188 rg /Helv 13 Tf)");

    const bytes = await exportOne(a);
    const fonts = await baseFonts(bytes);
    expect(fonts.some((f) => /Georgia-Bold|Georgia,Bold|GeorgiaBold/i.test(f))).toBe(true);
    expect(fonts.some((f) => f.includes("Times"))).toBe(true);
    const flat = await readBack(await exportOne(a, nodeDeps(), true));
    expect(flat.pages[0]!.text.replace(/\s+/g, "")).toContain("Helloboldworld");
    const { annots } = await (await import("./testkit")).rawAnnots(bytes, 0);
    expect(annots[0]!.lookup(PDFName.of("Contents"))?.toString()).toBe(`<${"FEFF" + [..."Hello bold world"].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()).join("")}>`);
  });

  it("a coloured run emits its colour and the base colour resumes after it", async () => {
    const out = (await appear(withRuns({ text: "red then base" }, [{ s: 0, e: 3, c: "#ff0000" }])))!;
    const sh = shows(out.ops);
    expect(sh.map((x) => x.color)).toEqual(["1 0 0", "0.063 0.125 0.188"]);
    expect(sh.map((x) => x.font)).toEqual(["/F0 13 Tf", "/F0 13 Tf"]);
    expect(out.ops.match(/ rg/g)).toHaveLength(2);
  });

  it("a larger run makes its row taller and shares one baseline with the rest", async () => {
    const text = "small big\nnext";
    const a = withRuns({ text, size: 10, h: 200 }, [{ s: 6, e: 9, size: 30 }]);
    const sh = shows((await appear(a))!.ops);
    expect(sh.map((x) => x.font)).toEqual(["/F0 10 Tf", "/F0 30 Tf", "/F0 10 Tf"]);
    const [p0, p1, p2] = sh;
    expect(p0!.y).toBe(p1!.y);
    // rows by the font box the screen reads (fontBoxOf), not hhea: Georgia's
    // 1878/449 per 2048 rounded at 10 px is 9/2, at 30 px 28/7
    const t = fontBoxTables(fkFontOf(readFileSync(fontFile("Georgia", false, false))));
    const strut = { size: 10, ...fontBoxOf(t, 10) };
    expect(strut).toEqual({ size: 10, asc: 9, desc: 2 });
    const r1 = rowMetrics([strut, { size: 30, ...fontBoxOf(t, 30) }], strut);
    const r2 = rowMetrics([strut], strut);
    const top = 792 - 90; // the frame's top, user space
    expect(p0!.y).toBeCloseTo(top - r1.baseline, 3);
    expect(p2!.y).toBeCloseTo(top - (r1.height + r2.baseline), 3);
    // the run-less box: rows of 12.5 pt
    const plain = shows((await appear(textBox({ text, size: 10, h: 200 })))!.ops);
    expect(plain[0]!.y - plain[1]!.y).toBeCloseTo(12.5, 3);
    expect(p0!.y - p2!.y).toBeGreaterThan(12.5 + 5);
  });

  it("a word spanning two faces wraps by the sum of its pieces' widths", async () => {
    const text = "going abciiiiiiiiii";
    const t = face(fontFile("Times New Roman", false, false));
    const cr = face(fontFile("Courier New", false, false));
    const single = t.width(text, 12);
    const summed = t.width("going abc", 12) + cr.width("iiiiiiiiii", 12);
    const word = t.width("abc", 12) + cr.width("iiiiiiiiii", 12);
    const w = (single + summed) / 2;
    expect(word).toBeLessThan(w); // the word fits alone on the next line
    const box = { text, font: "Times New Roman" as const, size: 12, w, h: 200 };
    const runs = shows((await appear(withRuns(box, [{ s: 9, e: 19, font: "Courier New" }])))!.ops);
    expect(runs.map((x) => x.glyphs)).toEqual([5, 3, 10]);
    expect(runs[1]!.y).toBeLessThan(runs[0]!.y); // "abc…" moved to line 2 …
    expect(runs[2]!.y).toBe(runs[1]!.y); // … with its Courier part
    // measured with one face, the same text fits on one line
    const plain = shows((await appear(textBox(box)))!.ops);
    expect(plain).toHaveLength(1);
  });

  it("a mixed-direction line with a run inside the right-to-left part: groups in visual order", async () => {
    const text = "abc שלום def";
    const p = paragraphBidi(text);
    const segOf = (i: number): number => (i < 4 ? 0 : i < 6 ? 1 : 2);
    expect(visualGroups(p, 0, text.length, segOf).map((g) => [g.seg, g.text, g.rtl])).toEqual([
      [0, "abc ", false],
      [2, "םו", true],
      [1, "לש", true],
      [2, " def", false],
    ]);
    const sh = shows((await appear(withRuns({ text, font: "Arial", w: 300 }, [{ s: 4, e: 6, bold: true }])))!.ops);
    expect(sh.map((x) => [x.font, x.glyphs])).toEqual([
      ["/F0 13 Tf", 4],
      ["/F0 13 Tf", 2],
      ["/F1 13 Tf", 2],
      ["/F0 13 Tf", 4],
    ]);
    expect(sh.every((x, i) => i === 0 || x.x > sh[i - 1]!.x)).toBe(true);
  });

  it("a wrapped right-to-left line with runs holds only that line's characters", async () => {
    const text = "שלום עולם זה טקסט";
    const p = paragraphBidi(text);
    const g = visualGroups(p, 10, 17, () => 0);
    expect(g.map((x) => x.text)).toEqual(["טסקט הז"]);
    expect(g[0]).toMatchObject({ s: 10, e: 17, rtl: true });
  });

  it("a licence refusal names the run's font, not the box's", async () => {
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Calibri": [CALIBRI, "full"], "lib:Consolas": [CONSOLAS, "none"] }) });
    const a = withRuns({ fontId: "lib:Calibri" }, [{ s: 0, e: 5, font: "Arial", fontId: "lib:Consolas" }]);
    const err = await exportOne(a, deps).catch((e) => e);
    expect(err).toBeInstanceOf(PdfExportError);
    expect(err.code).toBe("font-restricted");
    expect(err.message).toBe("The font Consolas can't go in a PDF because its license doesn't allow it, so pick another font for the text that uses it.");
  });

  it("noSubset on a run's face embeds that file whole", async () => {
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Consolas": [CONSOLAS, "noSubset"] }) });
    const out = await exportOne(withRuns({}, [{ s: 0, e: 5, font: "Arial", fontId: "lib:Consolas" }]), deps);
    expect((await baseFonts(out)).some((f) => f.includes("Consolas"))).toBe(true);
    expect(out.length).toBeGreaterThan(readFileSync(CONSOLAS).length * 0.3);
    const subset = await exportOne(withRuns({}, [{ s: 0, e: 5, font: "Arial", fontId: "lib:Consolas" }]), nodeDeps({ resolveFonts: consolas("full") }));
    expect(subset.length).toBeLessThan(readFileSync(CONSOLAS).length * 0.2);
  });

  it("a run whose library font is not on this PC exports in the run's legacy font", async () => {
    const deps = nodeDeps({ resolveFonts: consolas("missing") });
    const out = await exportOne(withRuns({}, [{ s: 6, e: 11, font: "Courier New", fontId: "lib:Nope" }]), deps);
    expect(deps.resolveCalls).toEqual([[{ id: "lib:Nope", bold: false, italic: false }]]);
    const fonts = await baseFonts(out);
    expect(fonts.some((f) => f.includes("CourierNew"))).toBe(true);
    expect(fonts.some((f) => f.includes("Georgia"))).toBe(true);
  });

  it("two runs in the same face embed it once", async () => {
    const out = (await appear(withRuns({ text: "ab cd ef" }, [{ s: 0, e: 2, bold: true }, { s: 6, e: 8, bold: true }])))!;
    expect(fontNames(out.resources)).toEqual(["F0", "F1"]);
    expect(shows(out.ops).map((x) => x.font)).toEqual(["/F1 13 Tf", "/F0 13 Tf", "/F1 13 Tf"]);
  });

  it("the raster spec carries runs only when the box has them", async () => {
    const plain = nodeDeps();
    await appear(textBox({ text: "مرحبا بك" }), plain);
    expect("runs" in plain.rasterCalls[0]!).toBe(false);
    // runs that say nothing (equal to the base) are no runs
    const noop = nodeDeps();
    await appear(withRuns({ text: "مرحبا بك" }, [{ s: 0, e: 2, size: 13 }]), noop);
    expect("runs" in noop.rasterCalls[0]!).toBe(false);
    const styled = nodeDeps({ resolveFonts: consolas("full") });
    await appear(withRuns({ text: "مرحبا بك", italic: true }, [{ s: 6, e: 8, c: "#00ff00", size: 20, font: "Arial", fontId: "lib:Consolas" }]), styled);
    expect(styled.rasterCalls[0]!.runs).toEqual([
      { s: 0, e: 6, font: "Georgia", bold: false, italic: true, size: 13, color: "#102030" },
      { s: 6, e: 8, font: "Arial", fontId: "lib:Consolas", bold: false, italic: false, size: 20, color: "#00ff00" },
    ]);
  });
});
