// Arabic text boxes export as REAL text (0.9.5): shaped by fontkit (joining
// forms, ligatures), drawn in visual order as glyph ids, with a ToUnicode
// map that gives the logical text back. The picture fallback stays only for
// a character a font has no glyph for. Real pdf-lib + fontkit + pdf.js in
// node, stock Windows fonts (Arial and Times New Roman carry Arabic, Georgia
// and Consolas do not).

import { existsSync, readFileSync } from "node:fs";
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, type PDFDocument, type PDFStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { FontEmbed, FontRequest, PdfAnnot, PdfTextRun, ResolvedFont } from "../../core/types";
import { PdfExportError } from "./errors";
import { buildPdf } from "./export";
import { drawnText } from "./bidi";
import { canShape, fkFontOf, shapeRtl, shapeRtlIn, type FkFont } from "./shape";
import { apStream, CONSOLAS, fontFile, hasFont, nodeDeps, pg, project, rawAnnots, readBack, textBox, type TestDeps } from "./testkit";

type Box = Extract<PdfAnnot, { t: "text" }>;
const KEPT = { flattenMarks: false, flattenForms: false };
const FLAT = { flattenMarks: true, flattenForms: false };
const ARIAL = fontFile("Arial", false, false);
const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);
const contents = (s: PDFStream): Uint8Array => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());

/** A box in Arial (it has Arabic), wide enough for one line unless told. */
const ar = (over: Partial<Box> = {}): Box => textBox({ font: "Arial", w: 300, h: 120, ...over });

/** fonts_resolve by id: each id's file and policy, or missing. */
function byId(map: Record<string, [string, FontEmbed]>) {
  return async (reqs: FontRequest[]): Promise<ResolvedFont[]> =>
    reqs.map((r) => {
      const f = map[r.id];
      return f
        ? { requested: r.id, found: true, bold: false, italic: false, path: f[0], lineHeightEm: 1.2, embed: f[1] }
        : { requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" };
    });
}

/** The box alone on a blank Letter page (nothing else to read back). */
async function exportBox(a: Box, deps: TestDeps = nodeDeps(), flat = false): Promise<Uint8Array> {
  const page = pg(null, 0, 0, 612, 792);
  return buildPdf(project([], [page], { [page.id]: [a] }), flat ? FLAT : KEPT, deps);
}

interface FontInfo {
  /** code (4 hex) → its unicode text */
  toUnicode: Map<string, string>;
  /** the embedded font program, when there is one */
  program: Uint8Array | null;
  /** /W widths by code */
  widths: Map<number, number>;
}

function fontInfo(doc: PDFDocument, type0: PDFDict): FontInfo {
  const tu = type0.lookup(PDFName.of("ToUnicode")) as PDFStream;
  const toUnicode = new Map<string, string>();
  for (const m of latin1(contents(tu)).matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]+)>/g)) {
    const units = m[2]!.match(/.{4}/g)!.map((h) => parseInt(h, 16));
    toUnicode.set(m[1]!.toUpperCase(), String.fromCharCode(...units));
  }
  const cid = (type0.lookup(PDFName.of("DescendantFonts"), PDFArray)).lookup(0, PDFDict);
  const desc = cid.lookup(PDFName.of("FontDescriptor"), PDFDict);
  const ff = desc.lookup(PDFName.of("FontFile2")) ?? desc.lookup(PDFName.of("FontFile3"));
  const program = ff ? contents(ff as PDFStream) : null;
  const widths = new Map<number, number>();
  const w = cid.lookup(PDFName.of("W"));
  if (w instanceof PDFArray) {
    for (let i = 0; i + 1 < w.size(); i += 2) {
      const first = Number(w.lookup(i)!.toString());
      const list = w.lookup(i + 1, PDFArray);
      for (let j = 0; j < list.size(); j++) widths.set(first + j, Number(list.lookup(j)!.toString()));
    }
  }
  void doc;
  return { toUnicode, program, widths };
}

interface Show {
  font: string;
  y: number;
  /** the glyph codes drawn, in content order (= visual order) */
  codes: string[];
  /** TJ arrays only: did it carry adjustments */
  tj: boolean;
}

/** Every text show of an appearance: Tj and TJ, with the font in force and
 *  the baseline of its Tm. */
function showsOf(ops: string): Show[] {
  const out: Show[] = [];
  let font = "";
  let y = NaN;
  const re = /(\/F\d+) [\d.]+ Tf|1 0 0 1 [-\d.]+ ([-\d.]+) Tm|<([0-9A-F]*)> Tj|\[((?:<[0-9A-F]*>|[-\d.]+|\s)*)\] TJ/g;
  for (const m of ops.matchAll(re)) {
    if (m[1]) font = m[1];
    else if (m[2]) y = Number(m[2]);
    else if (m[3] !== undefined) out.push({ font, y, codes: m[3].match(/.{4}/g) ?? [], tj: false });
    else if (m[4] !== undefined) {
      const codes = [...m[4].matchAll(/<([0-9A-F]*)>/g)].flatMap((x) => x[1]!.match(/.{4}/g) ?? []);
      out.push({ font, y, codes, tj: true });
    }
  }
  return out;
}

/** The kept export's one annotation: its appearance's operators, its
 *  resources' fonts and whether it paints a picture. */
async function appearanceOf(bytes: Uint8Array) {
  const { doc, annots } = await rawAnnots(bytes, 0);
  const s = apStream(doc, annots[0]!)!;
  const res = s.dict.lookup(PDFName.of("Resources"), PDFDict);
  const fontDict = res.lookup(PDFName.of("Font"));
  const fonts = new Map<string, FontInfo>();
  if (fontDict instanceof PDFDict) {
    for (const [k, v] of fontDict.entries()) {
      const d = v instanceof PDFRef ? (doc.context.lookup(v) as PDFDict) : (v as PDFDict);
      fonts.set(k.toString(), fontInfo(doc, d));
    }
  }
  return { ops: latin1(contents(s)), fonts, picture: res.has(PDFName.of("XObject")) };
}

/** A show's characters through its font's ToUnicode, in content order. */
const charsOf = (sh: Show, fonts: Map<string, FontInfo>): string => sh.codes.map((c) => fonts.get(sh.font)!.toUnicode.get(c) ?? "?").join("");
/** A right-to-left show read as a reader that reverses the run character by
 *  character reads it (pdf.js's bidi step): the glyphs' ToUnicode strings in
 *  content order, the whole string reversed by code point. */
const reverseGlyphs = (sh: Show, fonts: Map<string, FontInfo>): string => [...charsOf(sh, fonts)].reverse().join("");

/** Every /ActualText of an appearance, decoded (UTF-16BE with its BOM). */
const actualTexts = (ops: string): string[] =>
  [...ops.matchAll(/\/Span <<\/ActualText <([0-9A-Fa-f]*)>>> BDC/g)].map((m) => {
    const units = m[1]!.match(/.{4}/g)!.map((h) => parseInt(h, 16));
    expect(units[0]).toBe(0xfeff);
    return String.fromCharCode(...units.slice(1));
  });

/** pdf.js's text items of page 1 (non-blank), with their baselines. */
async function itemsOf(bytes: Uint8Array): Promise<{ str: string; y: number }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const doc = await task.promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    return tc.items.flatMap((x) => ("str" in x && x.str.trim() !== "" ? [{ str: x.str, y: x.transform[5] as number }] : []));
  } finally {
    await task.destroy();
  }
}

const ready = hasFont("Arial") && hasFont("Georgia") && hasFont("Times New Roman") && existsSync(CONSOLAS);

describe.skipIf(!ready)("Arabic text boxes as real text", () => {
  it("draws text, not a picture, and pdf.js reads the logical string back", async () => {
    const text = "مرحبا بالعالم";
    const deps = nodeDeps();
    const bytes = await exportBox(ar({ text }), deps);
    expect(deps.rasterCalls).toHaveLength(0);
    const app = await appearanceOf(bytes);
    expect(app.picture).toBe(false);
    expect(app.ops).not.toMatch(/ Do /);
    const sh = showsOf(app.ops);
    expect(sh).toHaveLength(1);
    expect(sh[0]!.tj).toBe(true);
    // flattened, pdf.js extracts exactly the source text
    const read = await readBack(await exportBox(ar({ text }), nodeDeps(), true));
    expect(read.pages[0]!.text.trim()).toBe(text);
  });

  it("glyph ids are the shaped ones: a joined word draws initial / medial / final forms, not the isolated letters", async () => {
    // "بيت": beh initial, yeh medial, teh final — every letter changes form
    const word = "بيت";
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"] }) });
    // embedded whole: the codes in the content ARE the font's glyph ids
    const app = await appearanceOf(await exportBox(ar({ text: word, fontId: "lib:Arial" }), deps));
    const ids = showsOf(app.ops)[0]!.codes.map((c) => parseInt(c, 16));
    const fk = fkFontOf(readFileSync(ARIAL));
    const isolated = [...word].map((ch) => (fk as unknown as { glyphForCodePoint(cp: number): { id: number } }).glyphForCodePoint(ch.codePointAt(0)!).id);
    const expected = shapeRtl(fk, word).glyphs.map((g) => g.id);
    expect(ids).toEqual(expected);
    // visual order: the final teh first, the initial beh last; the medial
    // yeh and the initial beh are other glyphs than the isolated letters
    expect(ids).toHaveLength(3);
    expect(ids[1]).not.toBe(isolated[1]);
    expect(ids[2]).not.toBe(isolated[0]);
    // and each shaped glyph still copies as its own letter
    const f = app.fonts.get("/F0")!;
    expect(showsOf(app.ops)[0]!.codes.map((c) => f.toUnicode.get(c))).toEqual(["ت", "ي", "ب"]);
    // the whole-font /W lists the shaped forms (they are not in the cmap)
    for (const id of ids) expect(f.widths.has(id)).toBe(true);
  });

  it("a subset embeds the shaped glyphs: the program's glyphs match the original font's shaped outlines", async () => {
    const word = "بيت";
    const app = await appearanceOf(await exportBox(ar({ text: word })));
    const f = app.fonts.get("/F0")!;
    const sub = fkFontOf(f.program!) as unknown as { getGlyph(id: number): { path: { toSVG(): string } } };
    const orig = fkFontOf(readFileSync(ARIAL)) as unknown as { getGlyph(id: number): { path: { toSVG(): string } } };
    const want = shapeRtl(fkFontOf(readFileSync(ARIAL)), word).glyphs.map((g) => g.id);
    const codes = showsOf(app.ops)[0]!.codes.map((c) => parseInt(c, 16));
    expect(codes.map((c) => sub.getGlyph(c).path.toSVG())).toEqual(want.map((id) => orig.getGlyph(id).path.toSVG()));
  });

  it("the lam-alef ligature is ONE glyph mapped to both letters in reverse, so the right-to-left run reversed reads lam then alef", async () => {
    const app = await appearanceOf(await exportBox(ar({ text: "لا" })));
    const sh = showsOf(app.ops)[0]!;
    expect(sh.codes).toHaveLength(1);
    // the glyph's ToUnicode: alef, lam (visual order inside the glyph)
    expect(charsOf(sh, app.fonts)).toBe("ال");
    // a reader reversing the run character by character: lam, alef
    expect(reverseGlyphs(sh, app.fonts)).toBe("لا");
    // the span's ActualText is the logical text
    expect(actualTexts(app.ops)).toEqual(["لا"]);
  });

  it("the whole-font embed maps the final lam-alef glyph (also the cmap's U+FEFC) in reverse too", async () => {
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"] }) });
    const bytes = await exportBox(ar({ text: "سلام", fontId: "lib:Arial" }), deps);
    const app = await appearanceOf(bytes);
    const fk = fkFontOf(readFileSync(ARIAL)) as unknown as { glyphForCodePoint(cp: number): { id: number } };
    const lig = fk.glyphForCodePoint(0xfefc).id;
    const sh = showsOf(app.ops)[0]!;
    // the drawn ligature is the final lam-alef, U+FEFC's glyph
    expect(sh.codes.map((c) => parseInt(c, 16))).toContain(lig);
    expect(app.fonts.get("/F0")!.toUnicode.get(lig.toString(16).toUpperCase().padStart(4, "0"))).toBe("ال");
    expect((await itemsOf(await exportBox(ar({ text: "سلام", fontId: "lib:Arial" }), nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"] }) }), true))).map((i) => i.str)).toEqual(["سلام"]);
  });

  describe("lam-alef read back by pdf.js exactly as typed", () => {
    // each box alone on a flattened page; pdf.js's text content must be the
    // source text, item for item (one line = one item)
    const cases: [string, string, Partial<Box>][] = [
      ["at the start of a word", "لا أعرف", {}],
      ["in the middle of a word", "سلام عليكم", {}],
      ["at the end of a word", "قال كلا", {}],
      ["twice in one line (and lam with hamza-alef)", "الإسلام والسلام", {}],
      ["three letters in one word", "الله أكبر", {}],
      ["beside Latin and digits", "سلام Hello 2026 كلا", { w: 420 }],
      ["a colour run that IS the ligature", "سلام عليكم", { runs: [{ s: 1, e: 3, c: "#ff0000" }] }],
      ["a colour run starting between lam and alef", "سلام عليكم", { runs: [{ s: 2, e: 6, c: "#ff0000" }] }],
      ["right aligned at 24 pt", "سلام عليكم", { size: 24, align: "right" }],
    ];
    for (const [name, text, over] of cases) {
      it(name, async () => {
        const deps = nodeDeps();
        const bytes = await exportBox(ar({ text, ...over }), deps, true);
        expect(deps.rasterCalls).toHaveLength(0);
        expect((await itemsOf(bytes)).map((i) => i.str)).toEqual([text]);
      });
    }

    // pdf.js starts a new text item where the font or its size changes, so a
    // run in another face or size comes back as items of its own, in drawing
    // (visual) order; each item is still exactly its logical words
    const split: [string, string, Partial<Box>, string[]][] = [
      ["a bold run over a word with lam-alef", "كلمة سلام", { runs: [{ s: 5, e: 9, bold: true }] }, ["سلام", "كلمة"]],
      ["a larger run over a ligature beside Latin", "Hi سلام", { runs: [{ s: 3, e: 7, size: 20 }] }, ["Hi", "سلام"]],
    ];
    for (const [name, text, over, want] of split) {
      it(name, async () => {
        const deps = nodeDeps();
        const bytes = await exportBox(ar({ text, ...over }), deps, true);
        expect(deps.rasterCalls).toHaveLength(0);
        expect((await itemsOf(bytes)).map((i) => i.str.trim())).toEqual(want);
      });
    }

    it("a wrapped paragraph: one item and one ActualText per line, every lam-alef in order", async () => {
      const words = ["سلام", "كلا", "لا", "الإسلام", "ثلاثة", "والسلام"];
      const text = words.join(" ");
      const kept = await appearanceOf(await exportBox(ar({ text, w: 70, h: 400 })));
      const spans = actualTexts(kept.ops);
      expect(spans.length).toBeGreaterThanOrEqual(3);
      expect(spans.join(" ").split(/\s+/).filter(Boolean)).toEqual(words);
      const items = await itemsOf(await exportBox(ar({ text, w: 70, h: 400 }), nodeDeps(), true));
      expect(items.map((i) => i.str.trim())).toEqual(spans.map((s) => s.trim()));
    });

    it("the three boxes of the app's own check, on one page: each box reads back whole", async () => {
      const MIXED = "مرحبا بالعالم Hello 2026";
      const ARABIC = "سلام عليكم";
      const mixed = ar({ text: MIXED, x: 72, y: 90, w: 420, h: 40, size: 20 });
      const pure = ar({ text: ARABIC, x: 72, y: 200, w: 300, h: 40, size: 24, align: "right" });
      const joined = { ...pure, id: `${pure.id}-runs`, y: 300, runs: [{ s: 1, e: 3, c: "#010101" }] };
      const page = pg(null, 0, 0, 612, 792);
      const bytes = await buildPdf(project([], [page], { [page.id]: [mixed, pure, joined] }), FLAT, nodeDeps());
      const items = await itemsOf(bytes);
      // page space y up: the top box has the highest baseline
      const sorted = [...items].sort((p, q) => q.y - p.y).map((i) => i.str.trim());
      expect(sorted).toEqual([MIXED, ARABIC, ARABIC]);
    });
  });

  it("a box without Arabic carries no marked content", async () => {
    const app = await appearanceOf(await exportBox(ar({ text: "שלום abc" })));
    expect(app.ops).not.toContain("BDC");
    expect(app.ops).not.toContain("EMC");
  });

  it("ToUnicode in visual order, read back right to left, is the logical text", async () => {
    const text = "سلام عليكم";
    const app = await appearanceOf(await exportBox(ar({ text })));
    const sh = showsOf(app.ops);
    expect(sh).toHaveLength(1);
    expect(reverseGlyphs(sh[0]!, app.fonts)).toBe(text);
  });

  it("Arabic mixed with Latin, digits and Hebrew in one paragraph: one show per visual group, every word read back", async () => {
    const text = "مرحبا Hello 123 שלום عالم";
    const deps = nodeDeps();
    const app = await appearanceOf(await exportBox(ar({ text, w: 400 }), deps));
    expect(deps.rasterCalls).toHaveLength(0);
    const sh = showsOf(app.ops);
    expect(sh.length).toBeGreaterThanOrEqual(3);
    // one baseline, groups left to right
    expect(new Set(sh.map((x) => x.y)).size).toBe(1);
    const xs = [...app.ops.matchAll(/1 0 0 1 ([-\d.]+) [-\d.]+ Tm/g)].map((m) => Number(m[1]));
    expect(xs.every((x, i) => i === 0 || x > xs[i - 1]!)).toBe(true);
    const all = sh.map((s) => (s.tj ? reverseGlyphs(s, app.fonts) : charsOf(s, app.fonts))).join("|");
    for (const w of ["مرحبا", "عالم", "Hello", "123"]) expect(all).toContain(w);
    // pdf.js reads every word back in logical order
    const read = (await readBack(await exportBox(ar({ text, w: 400 }), nodeDeps(), true))).pages[0]!.text;
    for (const w of ["مرحبا", "عالم", "Hello", "123", "שלום"]) expect(read).toContain(w);
  });

  it("a wrapped Arabic paragraph: each line draws only its own words", async () => {
    const words = ["واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة"];
    const text = words.join(" ");
    const app = await appearanceOf(await exportBox(ar({ text, w: 60, h: 300 })));
    const sh = showsOf(app.ops);
    const ys = [...new Set(sh.map((s) => s.y))];
    expect(ys.length).toBeGreaterThanOrEqual(3);
    const lines = ys.map((y) => sh.filter((s) => s.y === y).map((s) => reverseGlyphs(s, app.fonts)).join("").trim());
    // every word exactly once, each line a run of whole words, in order
    expect(lines.join(" ").split(/\s+/)).toEqual(words);
  });

  it("runs inside Arabic: a bold word, a coloured word, a larger word and a second font", async () => {
    const text = "كلمة عريضة ملونة كبيرة أخرى";
    const runs: PdfTextRun[] = [
      { s: 5, e: 10, bold: true },
      { s: 11, e: 16, c: "#ff0000" },
      { s: 17, e: 22, size: 22 },
      { s: 23, e: 27, font: "Times New Roman" },
    ];
    const deps = nodeDeps();
    const app = await appearanceOf(await exportBox(ar({ text, w: 500, runs }), deps));
    expect(deps.rasterCalls).toHaveLength(0);
    expect(app.picture).toBe(false);
    // Arial, Arial bold, Times
    expect([...app.fonts.keys()].sort()).toEqual(["/F0", "/F1", "/F2"]);
    expect(app.ops).toContain("1 0 0 rg");
    expect(app.ops).toMatch(/\/F0 22 Tf/);
    const sh = showsOf(app.ops);
    const byFont = (f: string): string[] => sh.filter((s) => s.font === f).map((s) => reverseGlyphs(s, app.fonts).trim());
    expect(byFont("/F1")).toContain("عريضة");
    expect(byFont("/F2")).toContain("أخرى");
    // right-to-left base direction: groups are drawn left to right, so the
    // FIRST word comes last, rightmost
    const xs = [...app.ops.matchAll(/1 0 0 1 ([-\d.]+) [-\d.]+ Tm/g)].map((m) => Number(m[1]));
    expect(xs.every((x, i) => i === 0 || x > xs[i - 1]!)).toBe(true);
    const last = sh[sh.length - 1]!;
    expect(reverseGlyphs(last, app.fonts).trim()).toBe("كلمة");
  });

  it("every glyph is drawn where fontkit positions it: GPOS kerning, mark offsets and rises", async () => {
    // Calibri kerns this pair (an xOffset with a shorter advance); Arial
    // places the vowel marks with x AND y offsets
    const cases: [string, string, number][] = [
      ["lib:Calibri", "C:/Windows/Fonts/calibri.ttf", 16],
      ["lib:Arial", ARIAL, 20],
    ];
    const words = ["سلام عليكم", "مَرْحَبًا"];
    let checked = 0;
    for (const [id, file, size] of cases) {
      if (!existsSync(file)) continue;
      for (const text of words) {
        const deps = nodeDeps({ resolveFonts: byId({ [id]: [file, "full"] }) });
        const app = await appearanceOf(await exportBox(ar({ text, fontId: id, size }), deps));
        const f = app.fonts.get("/F0")!;
        // walk the operators after the Tm: TJ arrays and text rises
        const after = app.ops.slice(app.ops.indexOf(" Tm ") + 4, app.ops.lastIndexOf(" ET"));
        const drawn: { x: number; y: number }[] = [];
        let pen = 0;
        let rise = 0;
        for (const m of after.matchAll(/([-\d.]+) Ts|\[((?:<[0-9A-F]*>|[-\d.]+|\s)*)\] TJ/g)) {
          if (m[1] !== undefined) {
            rise = Number(m[1]);
            continue;
          }
          for (const t of m[2]!.matchAll(/<([0-9A-F]{4})>|([-\d.]+)/g)) {
            if (t[2] !== undefined) {
              pen -= (Number(t[2]) / 1000) * size;
            } else {
              drawn.push({ x: pen, y: rise });
              pen += (f.widths.get(parseInt(t[1]!, 16))! / 1000) * size;
            }
          }
        }
        const fk = fkFontOf(readFileSync(file));
        const run = shapeRtl(fk, text);
        const k = size / fk.unitsPerEm;
        let x = 0;
        const want = run.positions.map((p) => {
          const at = { x: (x + p.xOffset) * k, y: p.yOffset * k };
          x += p.xAdvance;
          return at;
        });
        expect(drawn).toHaveLength(want.length);
        drawn.forEach((d, i) => {
          expect(d.x).toBeCloseTo(want[i]!.x, 2);
          expect(d.y).toBeCloseTo(want[i]!.y, 2);
        });
        // the text position ends where the run's advance does
        expect(pen).toBeCloseTo(x * k, 2);
        checked += run.positions.filter((p) => p.xOffset !== 0 || p.yOffset !== 0).length;
      }
    }
    // the cases did exercise offsets
    expect(checked).toBeGreaterThan(0);
  });

  it("brackets in a right-to-left run are drawn mirrored but copy out as typed", async () => {
    const text = "(مرحبا)";
    const app = await appearanceOf(await exportBox(ar({ text })));
    const sh = showsOf(app.ops)[0]!;
    const chars = sh.codes.map((c) => app.fonts.get("/F0")!.toUnicode.get(c));
    // drawn left to right: the glyph of "(" stands for the logical CLOSING
    // bracket, so its ToUnicode is ")"; read right to left: as typed
    expect(chars[0]).toBe(")");
    expect(chars[chars.length - 1]).toBe("(");
    const fk = fkFontOf(readFileSync(ARIAL)) as unknown as { glyphForCodePoint(cp: number): { id: number } };
    // the drawn glyphs ARE the mirrored ones (the subset keeps the outlines)
    const sub = fkFontOf(app.fonts.get("/F0")!.program!) as unknown as { getGlyph(id: number): { path: { toSVG(): string } } };
    const orig = fkFontOf(readFileSync(ARIAL)) as unknown as { getGlyph(id: number): { path: { toSVG(): string } } };
    expect(sub.getGlyph(parseInt(sh.codes[0]!, 16)).path.toSVG()).toBe(orig.getGlyph(fk.glyphForCodePoint(0x28).id).path.toSVG());
    // pdf.js, which reorders without mirroring, reads the text as typed
    const read = await readBack(await exportBox(ar({ text }), nodeDeps(), true));
    expect(read.pages[0]!.text.trim()).toBe(text);
  });

  it("a whole-font embed keeps the cmap's ToUnicode for a bracket (LTR text with that glyph copies right)", async () => {
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"] }) });
    const app = await appearanceOf(await exportBox(ar({ text: "(مرحبا)", fontId: "lib:Arial" }), deps));
    const f = app.fonts.get("/F0")!;
    const fk = fkFontOf(readFileSync(ARIAL)) as unknown as { glyphForCodePoint(cp: number): { id: number } };
    const hex = (id: number): string => id.toString(16).toUpperCase().padStart(4, "0");
    expect(f.toUnicode.get(hex(fk.glyphForCodePoint(0x28).id))).toBe("(");
    expect(f.toUnicode.get(hex(fk.glyphForCodePoint(0x29).id))).toBe(")");
    // while a presentation-form entry IS replaced by the letter (beh initial)
    const init = shapeRtl(fkFontOf(readFileSync(ARIAL)), "بب").glyphs[1]!.id;
    const app2 = await appearanceOf(await exportBox(ar({ text: "بب", fontId: "lib:Arial" }), nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"] }) })));
    expect(app2.fonts.get("/F0")!.toUnicode.get(hex(init))).toBe("ب");
  });

  it("a style run that starts or ends inside a word keeps the word joined (colour, then a second font)", async () => {
    const word = "بيت";
    const TIMES = fontFile("Times New Roman", false, false);
    const deps = nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"], "lib:Times": [TIMES, "noSubset"] }) });
    const arialFk = fkFontOf(readFileSync(ARIAL));
    const joined = shapeRtl(arialFk, word).glyphs.map((g) => g.id);
    // the middle letter only, recoloured: three shows, the joined glyphs
    const colour = await appearanceOf(await exportBox(ar({ text: word, fontId: "lib:Arial", runs: [{ s: 1, e: 2, c: "#ff0000" }] }), deps));
    const shows = showsOf(colour.ops);
    expect(shows).toHaveLength(3);
    expect(shows.flatMap((s) => s.codes.map((c) => parseInt(c, 16)))).toEqual(joined);
    // every glyph still copies as its own letter
    expect(shows.flatMap((s) => s.codes.map((c) => colour.fonts.get(s.font)!.toUnicode.get(c)))).toEqual(["ت", "ي", "ب"]);
    // the middle letter in Times: Times's MEDIAL yeh, Arial's initial beh
    // and final teh around it
    const times = await appearanceOf(await exportBox(ar({ text: word, fontId: "lib:Arial", runs: [{ s: 1, e: 2, font: "Times New Roman", fontId: "lib:Times" }] }), deps));
    const ts = showsOf(times.ops);
    expect(ts).toHaveLength(3);
    const timesFk = fkFontOf(readFileSync(TIMES));
    const isoYeh = (timesFk as unknown as { glyphForCodePoint(cp: number): { id: number } }).glyphForCodePoint(0x64a).id;
    const medYeh = shapeRtl(timesFk, word).glyphs[1]!.id;
    expect(medYeh).not.toBe(isoYeh);
    expect(ts.map((s) => s.codes.map((c) => parseInt(c, 16)))).toEqual([[joined[0]], [medYeh], [joined[2]]]);
  });

  it("joining marks and bidi marks are not drawn: nothing copies out as a space inside a word", async () => {
    for (const text of ["می\u200cخواهم", "مرحبا\u200fبك", "ب\u200dب"]) {
      const app = await appearanceOf(await exportBox(ar({ text })));
      const sh = showsOf(app.ops);
      const chars = sh.flatMap((s) => s.codes.map((c) => app.fonts.get(s.font)!.toUnicode.get(c)));
      expect(chars, text).not.toContain(" ");
      expect(chars.join(""), text).not.toMatch(/\s/);
      // and the letters are all there
      const letters = [...text].filter((ch) => !/[\u200c-\u200f]/.test(ch));
      expect([...chars.join("")].sort(), text).toEqual(letters.sort());
    }
  });

  it("a glyph two letters share names the letter of THIS use, not the first one ever shaped", () => {
    // Arial: the medial forms of Arabic yeh (U+064A) and Farsi yeh (U+06CC)
    // are one glyph; fontkit caches it with the first letter it was made for
    const fk = fkFontOf(readFileSync(ARIAL));
    const a = shapeRtlIn(fk, "بيب", "بيب", 0, 3);
    const f = shapeRtlIn(fk, "بیب", "بیب", 0, 3);
    expect(a.glyphs[1]!.id).toBe(f.glyphs[1]!.id);
    expect(a.glyphs[1]!.codePoints).toEqual([0x64a]);
    expect(f.glyphs[1]!.codePoints).toEqual([0x6cc]);
  });

  it("a glyph fontkit first met as a presentation form still maps a ligature to both letters", () => {
    // Arial's lam-alef ligature is also the cmap glyph of U+FEFB; fontkit's
    // cached glyph object then names ONE code point, which would no longer
    // account for the two letters of "لا"
    const fk = fkFontOf(readFileSync(ARIAL));
    const viaCmap = (fk as unknown as { glyphForCodePoint(cp: number): { id: number; codePoints: number[] } }).glyphForCodePoint(0xfefb);
    const run = shapeRtlIn(fk, "لا", "لا", 0, 2);
    expect(run.glyphs).toHaveLength(1);
    expect(run.glyphs[0]!.id).toBe(viaCmap.id);
    expect(run.glyphs[0]!.codePoints).toEqual([0x644, 0x627]);
    // fontkit's own cached object is left as it was
    expect(viaCmap.codePoints).toEqual([0xfefb]);
  });

  it("an Arabic box without runs is placed by the font box, as the editor places it (not by hhea)", async () => {
    const asked: string[] = [];
    const deps = nodeDeps({
      fontBox: async (s) => {
        asked.push(`${s.font}|${s.size}`);
        return { asc: 30, desc: 2 };
      },
    });
    const app = await appearanceOf(await exportBox(ar({ text: "مرحبا", size: 20, h: 100 }), deps));
    expect(asked).toEqual(["Arial|20"]);
    // baseline = (lh - (asc + desc)) / 2 + asc below the frame top, lh = 25
    const y = Number(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/.exec(app.ops)![1]);
    const top = Math.max(...[...app.ops.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re W n/g)].map((m) => Number(m[2]) + Number(m[4])));
    expect(top - y).toBeCloseTo((25 - 32) / 2 + 30, 3);
    // R1: the same box in Hebrew (no shaping) never asks
    const asked2: string[] = [];
    await exportBox(ar({ text: "שלום", size: 20 }), nodeDeps({ fontBox: async () => (asked2.push("x"), { asc: 30, desc: 2 }) }));
    expect(asked2).toEqual([]);
  });

  it("an Arabic box without runs in Arial: its content stream is pinned", async () => {
    const app = await appearanceOf(await exportBox(ar({ text: "مرحبا بك", x: 72, y: 72 })));
    expect(app.ops).toMatchInlineSnapshot(`"q 72 600 300 120 re W n BT /Span <</ActualText <FEFF06450631062D06280627002006280643>>> BDC /F0 13 Tf 0.063 0.125 0.188 rg 1 0 0 1 72 707.375 Tm [<0001> <0002> <0003> <0004> <0002> <0005> <0006> <0007>] TJ EMC ET Q"`);
  });

  it("a font that could not draw the box anyway falls back to a picture whatever its licence or file", async () => {
    const GEORGIA = fontFile("Georgia", false, false);
    // licence refuses embedding, and the font has no Arabic: a picture, as 0.9.4
    const refused = nodeDeps({ resolveFonts: byId({ "lib:Georgia": [GEORGIA, "none"] }) });
    await exportBox(ar({ text: "مرحبا", fontId: "lib:Georgia" }), refused);
    expect(refused.rasterCalls).toHaveLength(1);
    // the library file cannot be read: a picture, as 0.9.4
    const gone = nodeDeps({ resolveFonts: byId({ "lib:Arial": ["C:/nowhere/missing-font.ttf", "full"] }) });
    await exportBox(ar({ text: "مرحبا", fontId: "lib:Arial" }), gone);
    expect(gone.rasterCalls).toHaveLength(1);
    // a refused font that CAN draw it still refuses, as any other text
    const can = await exportBox(ar({ text: "مرحبا", fontId: "lib:Arial" }), nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "none"] }) })).catch((e) => e);
    expect(can).toBeInstanceOf(PdfExportError);
  });

  it("drawnText mirrors right-to-left brackets offset for offset, line breaks kept", () => {
    const text = "(مرحبا)\r\nabc (x)\n[سلام]";
    const d = drawnText(text);
    expect(d).toHaveLength(text.length);
    expect(d).toBe(")مرحبا(\r\nabc (x)\n]سلام[");
  });

  it("a right-aligned Arabic box ends at the frame's right edge", async () => {
    const a = ar({ text: "مرحبا", align: "right", w: 300, x: 72 });
    const app = await appearanceOf(await exportBox(a));
    const x = Number(/1 0 0 1 ([-\d.]+) [-\d.]+ Tm/.exec(app.ops)![1]);
    const fk = fkFontOf(readFileSync(ARIAL));
    const run = shapeRtl(fk, "مرحبا");
    const w = (run.positions.reduce((t, p) => t + p.xAdvance, 0) * 13) / fk.unitsPerEm;
    expect(x + w).toBeCloseTo(72 + 300, 2);
  });

  it("the licence rules hold for Arabic: refused, whole, subset", async () => {
    const refused = await exportBox(ar({ text: "مرحبا", fontId: "lib:Arial" }), nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "none"] }) })).catch((e) => e);
    expect(refused).toBeInstanceOf(PdfExportError);
    expect(refused.code).toBe("font-restricted");
    const whole = await exportBox(ar({ text: "مرحبا", fontId: "lib:Arial" }), nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "noSubset"] }) }));
    const subset = await exportBox(ar({ text: "مرحبا", fontId: "lib:Arial" }), nodeDeps({ resolveFonts: byId({ "lib:Arial": [ARIAL, "full"] }) }));
    const size = readFileSync(ARIAL).length;
    expect(whole.length).toBeGreaterThan(size * 0.3);
    expect(subset.length).toBeLessThan(size * 0.1);
  });

  it("falls back to a picture only where real text cannot be right", async () => {
    // the box's font has no Arabic
    const georgia = nodeDeps();
    await exportBox(ar({ text: "مرحبا", font: "Georgia" }), georgia);
    expect(georgia.rasterCalls).toHaveLength(1);
    // a run in a font without Arabic over Arabic letters
    const run = nodeDeps();
    await exportBox(ar({ text: "مرحبا بك", runs: [{ s: 6, e: 8, font: "Georgia" }] }), run);
    expect(run.rasterCalls).toHaveLength(1);
    // a character Arial cannot draw anywhere in the box
    const emoji = nodeDeps();
    await exportBox(ar({ text: "مرحبا 😀" }), emoji);
    expect(emoji.rasterCalls).toHaveLength(1);
    // a run in a font without Arabic over LATIN text only: still real text
    const latin = nodeDeps();
    await exportBox(ar({ text: "مرحبا Hi", runs: [{ s: 6, e: 8, font: "Georgia" }] }), latin);
    expect(latin.rasterCalls).toHaveLength(0);
  });

  it("canShape: cmap coverage, ignorable characters, .notdef", () => {
    const arial = fkFontOf(readFileSync(ARIAL));
    const georgia = fkFontOf(readFileSync(fontFile("Georgia", false, false)));
    expect(canShape(arial, "مرحبا بالعالم")).toBe(true);
    expect(canShape(arial, "مرحبا\u200d\u200fبك")).toBe(true);
    expect(canShape(arial, "مرحبا 😀")).toBe(false);
    expect(canShape(georgia, "مرحبا")).toBe(false);
    expect(canShape(georgia, "Hello")).toBe(true);
  });

  it("canShape: each check on its own (a cmap gap with a clean layout, a full cmap whose shaping gives .notdef)", () => {
    const fake = (mapped: (cp: number) => boolean, ids: (s: string) => number[]): FkFont => ({
      unitsPerEm: 1000,
      ascent: 800,
      descent: -200,
      hasGlyphForCodePoint: mapped,
      layout: (s: string) => {
        const g = ids(s).map((id) => ({ id, advanceWidth: 500, codePoints: [] }));
        return { glyphs: g, positions: g.map(() => ({ xAdvance: 500, xOffset: 0, yOffset: 0 })) };
      },
    });
    const word = "مرحبا";
    // the cmap lacks one letter, the layout (wrongly) answers real glyphs
    expect(canShape(fake((cp) => cp !== 0x062d, (s) => [...s].map(() => 7)), word)).toBe(false);
    // every letter mapped, shaping substitutes a .notdef
    expect(canShape(fake(() => true, (s) => [...s].map((_, i) => (i === 2 ? 0 : 7))), word)).toBe(false);
    // both clean
    expect(canShape(fake(() => true, (s) => [...s].map(() => 7)), word)).toBe(true);
    // an unmapped joiner fontkit hides (its space glyph, no advance) is fine
    const hiding = (bad: (ch: string) => boolean): FkFont => ({
      unitsPerEm: 1000,
      ascent: 800,
      descent: -200,
      hasGlyphForCodePoint: (cp) => cp !== 0x200d && cp !== 0x0a && cp !== 0x09,
      layout: (s: string) => {
        const chars = [...s];
        return {
          glyphs: chars.map((ch) => (ch === "\u200d" ? { id: 3, advanceWidth: 250, codePoints: [0x20] } : { id: bad(ch) ? 0 : 7, advanceWidth: 500, codePoints: [ch.codePointAt(0)!] })),
          positions: chars.map((ch) => ({ xAdvance: ch === "\u200d" ? 0 : 500, xOffset: 0, yOffset: 0 })),
        };
      },
    });
    expect(canShape(hiding(() => false), "مر\u200dحبا")).toBe(true);
    // an unmapped character that is NOT hidden shapes to .notdef: refused,
    // even with an unmapped joiner or a line break elsewhere in the text
    expect(canShape(fake((cp) => cp !== 0x200f, (s) => [...s].map((ch) => (ch === "\u200f" ? 0 : 7))), "مر\u200fحبا")).toBe(false);
    expect(canShape(hiding((ch) => ch === "ح"), "مر\u200dبا\nحبا")).toBe(false);
    expect(canShape(hiding((ch) => ch === "\t"), "مرحبا\tبك")).toBe(false);
    expect(canShape(hiding(() => false), "مرحبا\nبك")).toBe(true);
  });

  it("canShape on real fonts: a multi-paragraph box still gets the .notdef check", () => {
    const arial = fkFontOf(readFileSync(ARIAL));
    expect(canShape(arial, "مرحبا\nبالعالم\nسلام")).toBe(true);
    // a tab Arial does not map shapes to .notdef: a picture, not a tofu box
    if (!arial.hasGlyphForCodePoint(9)) expect(canShape(arial, "مرحبا\nسلام\tعليكم")).toBe(false);
  });

  it("a box without Arabic is untouched by the shaping path (no fontkit read beyond embedding)", async () => {
    const asked: string[] = [];
    const base = nodeDeps();
    const deps = nodeDeps({
      fontBytes: async (f, b, i) => {
        asked.push(`${f}|${b}|${i}`);
        return base.fontBytes(f, b, i);
      },
    });
    const app = await appearanceOf(await exportBox(ar({ text: "שלום abc" }), deps));
    expect(asked).toEqual(["Arial|false|false"]);
    expect(showsOf(app.ops).every((s) => !s.tj)).toBe(true);
  });
});
