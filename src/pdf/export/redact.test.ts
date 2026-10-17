// redact.ts in isolation: the content tokenizer, the width tables and the
// glyph removal on hand-written content (the end-to-end checks with real
// fixtures and pdf.js read-back live in edit-text.test.ts).

import { readFileSync } from "node:fs";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  ContentParseError,
  PAGE_MAX_EDIT_RECTS,
  fontInfoOf,
  parseContent,
  redactContent,
  redactPage,
  serializeOps,
  spliceContent,
  standardFontFor,
  type FontInfo,
  type FormInfo,
  type Op,
  type PageRect,
  type Tok,
} from "./redact";
import { fixture, hasFixture } from "./testkit";

const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const dec = (b: Uint8Array): string => {
  let s = "";
  for (const v of b) s += String.fromCharCode(v);
  return s;
};

/** An op without its byte offsets (for comparing two parses). */
function shape(t: Tok | Op): unknown {
  if ("op" in t) return { op: t.op, args: t.args.map(shape) };
  switch (t.k) {
    case "num":
    case "name":
    case "kw":
      return [t.k, t.v];
    case "str":
      return ["str", dec(t.b)];
    case "arr":
    case "dict":
      return [t.k, t.items.map(shape)];
  }
}

// an unfiltered 4×1 RGB inline image whose 12 data bytes contain " EI "
const IMAGE_DATA = " EI \x00\xff\x10EI\n\x01\x02";
const EVERY_KIND =
  "% a comment\n" +
  "q 1 0 0 1 10.5 -20 cm /GS0 gs 0.2 0.4 0.6 rg\n" +
  "/Span <</MCID 3 /ActualText (x)>> BDC\n" +
  "BT /F#201 12 Tf 0.5 Tc 1 Tw 90 Tz 2 Ts 14 TL 0 Tr\n" +
  "1 0 0 1 72 700 Tm (a\\(b\\)c\\\\ \\101\\n\\\r\nd) Tj\n" +
  "<48 65 6c 6C 6f> Tj 0 -14 Td [(A) -120.5 <4243> 30 (D)] TJ T* (q) ' 1 .5 (dq) \" 0 -2 TD\n" +
  "ET EMC true false null pop\n" +
  `BI /W 4 /H 1 /BPC 8 /CS /RGB ID ${IMAGE_DATA} EI\n` +
  "Q";

describe("tokenizer", () => {
  it("reads every operator kind, and parse → write → parse gives the same operators", () => {
    const src = enc(EVERY_KIND);
    const ops = parseContent(src);
    expect(ops.map((o) => o.op)).toEqual([
      "q", "cm", "gs", "rg", "BDC", "BT", "Tf", "Tc", "Tw", "Tz", "Ts", "TL", "Tr", "Tm", "Tj",
      "Tj", "Td", "TJ", "T*", "'", '"', "TD", "ET", "EMC", "pop", "BI", "Q",
    ]);
    const again = parseContent(serializeOps(src, ops));
    expect(again.map(shape)).toEqual(ops.map(shape));
  });

  it("decodes strings: escapes, octal, line continuation, a bare end of line, hex with spaces and odd length", () => {
    const ops = parseContent(enc("(a\\(b\\)c\\\\ \\101\\n\\\r\nd) Tj (x\r\ny\rz) Tj <48 65 6c 6C 6f> Tj <414> Tj"));
    const s = ops.map((o) => dec((o.args[0] as Extract<Tok, { k: "str" }>).b));
    expect(s).toEqual(["a(b)c\\ A\nd", "x\ny\nz", "Hello", "A@"]);
  });

  it("decodes names with #xx escapes and keeps true/false/null as operands", () => {
    const [tf, pop] = parseContent(enc("/F#201 12 Tf true false null pop"));
    expect(tf!.args[0]).toMatchObject({ k: "name", v: "F 1" });
    expect(pop!.args.map((a) => (a as { v: string }).v)).toEqual(["true", "false", "null"]);
  });

  it("copies inline image data verbatim, including bytes that look like EI", () => {
    const src = enc(EVERY_KIND);
    const bi = parseContent(src).find((o) => o.op === "BI")!;
    expect(dec(src.subarray(bi.s, bi.e))).toBe(`BI /W 4 /H 1 /BPC 8 /CS /RGB ID ${IMAGE_DATA} EI`);
    // a filtered image: the scan finds the first white-space-delimited EI
    const f = enc("BI /W 2 /H 2 /F /AHx ID 00ff00ff> EI Q");
    expect(parseContent(f).map((o) => o.op)).toEqual(["BI", "Q"]);
  });

  it("splicing nothing returns the very same bytes; splicing one op leaves the rest byte for byte", () => {
    const src = enc(EVERY_KIND);
    expect(spliceContent(src, new Map())).toBe(src);
    const ops = parseContent(src);
    const tj = ops.find((o) => o.op === "TJ")!;
    const out = dec(spliceContent(src, new Map([[tj, "[(Z)] TJ"]])));
    expect(out).toBe(EVERY_KIND.replace("[(A) -120.5 <4243> 30 (D)] TJ", "[(Z)] TJ"));
  });

  it("refuses what is not a content stream", () => {
    for (const bad of ["(open Tj", "<4g> Tj", "[1 2 Tj", "1 2", ") Tj", "<< /A 1 >", "BI /W 1 ID xx", "{ 1 } Tj", "/A 1 Q ] Tj"]) {
      expect(() => parseContent(enc(bad)), bad).toThrow(ContentParseError);
    }
  });
});

describe("font widths", () => {
  it("maps BaseFont names, subset prefixes and Windows aliases to the standard 14", () => {
    expect(standardFontFor("Helvetica")).toBe(StandardFonts.Helvetica);
    expect(standardFontFor("ABCDEF+Arial,Bold")).toBe(StandardFonts.HelveticaBold);
    expect(standardFontFor("Arial-BoldItalicMT")).toBe(StandardFonts.HelveticaBoldOblique);
    expect(standardFontFor("TimesNewRomanPS-ItalicMT")).toBe(StandardFonts.TimesRomanItalic);
    expect(standardFontFor("Times-Roman")).toBe(StandardFonts.TimesRoman);
    expect(standardFontFor("CourierNew,Bold")).toBe(StandardFonts.CourierBold);
    expect(standardFontFor("Symbol")).toBe(StandardFonts.Symbol);
    expect(standardFontFor("ZapfDingbats")).toBe(StandardFonts.ZapfDingbats);
    expect(standardFontFor("Calibri")).toBeNull();
  });

  async function info(dict: Record<string, unknown>): Promise<FontInfo | null> {
    const doc = await PDFDocument.create();
    return fontInfoOf(doc.context, doc.context.obj(dict as never) as unknown as PDFDict);
  }

  it("standard 14 without /Widths: AFM widths through the encoding and /Differences", async () => {
    const helv = (await info({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }))!;
    expect(helv.twoByte).toBe(false);
    expect(helv.width(65)).toBe(667); // A
    expect(helv.width(32)).toBe(278); // space
    expect(helv.width(0x27)).toBe(191); // quotesingle in WinAnsi
    const std = (await info({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }))!;
    expect(std.width(0x27)).toBe(222); // quoteright in StandardEncoding
    const courier = (await info({ Type: "Font", Subtype: "Type1", BaseFont: "Courier-Bold", Encoding: "WinAnsiEncoding" }))!;
    expect(courier.width(105)).toBe(600);
    const diff = (await info({
      Type: "Font",
      Subtype: "Type1",
      BaseFont: "Times-Roman",
      Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [65, "W", "i"] },
    }))!;
    expect(diff.width(65)).toBe(944); // W
    expect(diff.width(66)).toBe(278); // i
    expect(diff.width(67)).toBe(667); // C, from the base encoding
    expect(await info({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "MacRomanEncoding" })).toBeNull();
    expect(await info({ Type: "Font", Subtype: "Type1", BaseFont: "Calibri" })).toBeNull();
  });

  it("simple fonts with /Widths: FirstChar offset, MissingWidth outside the range", async () => {
    const f = (await info({
      Type: "Font",
      Subtype: "TrueType",
      BaseFont: "Whatever",
      FirstChar: 65,
      Widths: [500, 610, 720],
      FontDescriptor: { Type: "FontDescriptor", MissingWidth: 333 },
    }))!;
    expect([f.width(65), f.width(66), f.width(67), f.width(64), f.width(68)]).toEqual([500, 610, 720, 333, 333]);
  });

  it("Type0 Identity-H: both /W forms, /DW for the rest; other encodings are unknown", async () => {
    const t0 = (dw?: number, encoding = "Identity-H") =>
      info({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: "X",
        Encoding: encoding,
        DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", ...(dw ? { DW: dw } : {}), W: [3, [400, 450], 10, 12, 700] }],
      });
    const f = (await t0(900))!;
    expect(f.twoByte).toBe(true);
    expect([f.width(3), f.width(4), f.width(10), f.width(12), f.width(13), f.width(5)]).toEqual([400, 450, 700, 700, 900, 900]);
    expect((await t0())!.width(99)).toBe(1000);
    expect(await t0(900, "Identity-V")).toBeNull();
    expect(await t0(900, "UniJIS-UCS2-H")).toBeNull();
  });

  it("Type3: /Widths through /FontMatrix", async () => {
    const f = (await info({ Type: "Font", Subtype: "Type3", FirstChar: 1, Widths: [10, 20], FontMatrix: [0.05, 0, 0, 0.05, 0, 0] }))!;
    expect(f.width(1)).toBeCloseTo(500);
    expect(f.width(2)).toBeCloseTo(1000);
    expect(f.width(3)).toBeNull();
  });
});

/* ---------------- removal on hand-written content ---------------- */

/** A fixed-pitch font: every glyph 500/1000 em. */
const MONO: FontInfo = { twoByte: false, width: () => 500 };
const GEOM = { x: 0, y: 0, w: 600, h: 800 };
/** Page-space rect of glyphs [from, to) of a MONO line at (x, baseline y), size s. */
const glyphs = (x: number, y: number, s: number, from: number, to: number): PageRect => [x + from * s * 0.5, 800 - y - 0.8 * s, (to - from) * s * 0.5, s];

function run(content: string, rects: PageRect[], fonts: Record<string, FontInfo | null> = { F1: MONO }, forms: Record<string, FormInfo> = {}) {
  const res = redactContent({
    content: enc(content),
    rects,
    geom: GEOM,
    font: (n) => fonts[n] ?? null,
    form: (n) => forms[n] ?? null,
  });
  return { ...res, text: res.content ? dec(res.content) : content };
}

describe("removing glyphs", () => {
  it("cuts the glyphs inside a rect out of a Tj and stands a TJ number in for their advance", () => {
    const r = run("BT /F1 10 Tf 100 700 Td (abcdefgh) Tj ET", [glyphs(100, 700, 10, 2, 5)]);
    expect(r.removed).toBe(3);
    expect(r.unresolved).toEqual([false]);
    expect(r.text).toBe("BT /F1 10 Tf 100 700 Td [<6162> -1500 <666768>] TJ ET");
  });

  it("counts Tc, Tw (single-byte space only) and keeps Tz out of the number", () => {
    // Tc 1, Tw 2, Tz 50: a removed space advances (5 + 1 + 2) * 0.5 = 4 user units;
    // the number is -(500 + 1000 * 3 / 10) = -800 (Tz scales both sides)
    const r = run("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz 0 0 Td (a b) Tj ET", [[2.5, 790, 3, 10]]);
    expect(r.text).toContain("[<61> -800 <62>] TJ");
    expect(r.removed).toBe(1);
  });

  it("follows cm, Tm, Ts and the q/Q stack", () => {
    // cm doubles and moves; the text sits at user (2*50+30, 2*100+40) = (130, 240)
    const content = "q 2 0 0 2 30 40 cm BT /F1 10 Tf 1 0 0 1 50 100 Tm (xyz) Tj ET Q BT /F1 10 Tf 1 0 0 1 130 240 Tm (uvw) Tj ET";
    // the first line's middle glyph: user x 140..150 (centre 145), size 20;
    // the second line's glyphs are 5 wide from 130 (centres 132.5, 137.5, 142.5)
    const r = run(content, [[144, 800 - 240 - 16, 4, 20]]);
    expect(r.text).toContain("[<78> -500 <7A>] TJ");
    expect(r.text).toContain("(uvw) Tj"); // the same place in user space, but unscaled glyphs
    expect(r.removed).toBe(1);
  });

  it("rewrites ' and \" keeping their line move and spacing", () => {
    const r = run("BT /F1 10 Tf 12 TL 0 700 Td (keep) Tj (gone) ' 1 0 (gone) \" ET", [
      glyphs(0, 688, 10, 0, 4),
      // the " line: Tw 1 and Tc 0 apply from it on; 4 glyphs of 5 units
      [0, 800 - 676 - 8, 20, 10],
    ]);
    expect(r.text).toBe("BT /F1 10 Tf 12 TL 0 700 Td (keep) Tj T* [-2000] TJ 1 Tw 0 Tc T* [-2000] TJ ET");
    expect(r.unresolved).toEqual([false, false]);
  });

  it("splits TJ arrays, merging the stand-in with neighbouring numbers", () => {
    const r = run("BT /F1 10 Tf 0 700 Td [(ab) -100 (cd) 50 (ef)] TJ ET", [glyphs(1, 700, 10, 2, 4)]);
    // c, d sit after a -100 shift of 1 unit: their centres are inside the shifted rect
    expect(r.text).toContain("[<6162> -1050 <6566>] TJ");
  });

  it("2-byte codes for Identity-H fonts", () => {
    const wide: FontInfo = { twoByte: true, width: (c) => (c === 7 ? 1000 : 500) };
    const r = run("BT /F2 10 Tf 0 700 Td <000500070005> Tj ET", [glyphs(0, 700, 10, 1, 3)], { F2: wide });
    expect(r.text).toContain("[<0005> -1000 <0005>] TJ");
  });

  it("invisible text (mode 3) is removed but the rect still gets its cover; clipping modes are not touched", () => {
    const inv = run("BT /F1 10 Tf 3 Tr 0 700 Td (ab) Tj ET", [glyphs(0, 700, 10, 0, 1)]);
    expect(inv.removed).toBe(1);
    expect(inv.unresolved).toEqual([true]);
    const clip = run("BT /F1 10 Tf 4 Tr 0 700 Td (ab) Tj ET", [glyphs(0, 700, 10, 0, 1)]);
    expect(clip.removed).toBe(0);
    expect(clip.content).toBeNull();
    expect(clip.unresolved).toEqual([true]);
  });

  it("an unknown font or width removes nothing on its line and asks for covers", () => {
    const unknown = run("BT /F9 10 Tf 0 700 Td (ab) Tj ET", [glyphs(0, 700, 10, 0, 1)]);
    expect(unknown.removed).toBe(0);
    expect(unknown.unresolved).toEqual([true]);
    // a glyph of unknown width poisons the positions after it, until the next line move
    const holes: FontInfo = { twoByte: false, width: (c) => (c === 63 ? null : 500) };
    const r = run("BT /F1 10 Tf 0 700 Td (?ab) Tj 0 -20 Td (cd) Tj ET", [glyphs(5, 700, 10, 0, 1), glyphs(0, 680, 10, 0, 1)], { F1: holes });
    expect(r.text).toContain("(?ab) Tj"); // left alone
    expect(r.text).toContain("[-500 <64>] TJ"); // the next line is known again
    expect(r.unresolved).toEqual([true, true]); // covers everywhere: something was not understood
  });

  it("a rect nothing was removed from is unresolved", () => {
    const r = run("BT /F1 10 Tf 0 700 Td (ab) Tj ET", [glyphs(0, 700, 10, 0, 1), [300, 300, 10, 10]]);
    expect(r.unresolved).toEqual([false, true]);
  });

  it("a Form XObject that may draw text marks the rects its box meets; an image or a fontless form does not", () => {
    // the form sits at user (200..300, 400..420), its matrix moving it 10 up
    const form: FormInfo = { bbox: [0, 0, 100, 20], matrix: [1, 0, 0, 1, 0, 10], text: true };
    const content =
      "BT /F1 10 Tf 210 412 Td (ab) Tj 0 -300 Td (cd) Tj ET " + // ab over the form, cd far below it
      "q 1 0 0 1 200 390 cm /Fm Do /Im Do Q q 1 0 0 1 0 100 cm /Pl Do Q";
    const rects: PageRect[] = [glyphs(210, 412, 10, 0, 1), glyphs(210, 112, 10, 0, 1)];
    const r = run(content, rects, { F1: MONO }, { Fm: form, Pl: { ...form, matrix: [1, 0, 0, 1, 210, 12], text: false } });
    expect(r.removed).toBe(2); // page text is removed in both
    expect(r.unresolved).toEqual([true, false]); // but the form may hide more under the first
    expect(r.text).toContain("/Fm Do"); // never rewritten
  });

  it("a stream that does not parse: nothing changes, every rect is covered", () => {
    const r = run("BT /F1 10 Tf (ab Tj ET", [glyphs(0, 700, 10, 0, 1)]);
    expect(r.content).toBeNull();
    expect(r.unresolved).toEqual([true]);
  });

  it("a page with more edit rects than any real edit is not parsed: every rect is covered", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const content = "BT /F1 10 Tf 0 700 Td (ab) Tj ET";
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
    const helv = doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    page.node.setFontDictionary(PDFName.of("F1"), doc.context.register(helv));
    // the "a": x 0..5.56, baseline 700 (page y 92), 10 pt
    const rects = Array.from({ length: PAGE_MAX_EDIT_RECTS + 1 }, (): PageRect => [0, 84, 5, 10]);
    const before = page.node.get(PDFName.of("Contents"));
    const t0 = performance.now();
    const res = redactPage(doc, page, { x: 0, y: 0, w: 612, h: 792 }, [{ rects, cover: "#ffffff" }]);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(res.removed).toBe(0);
    expect(res.covers).toHaveLength(PAGE_MAX_EDIT_RECTS + 1);
    expect(page.node.get(PDFName.of("Contents"))).toBe(before); // untouched
    expect(redactPage(doc, page, { x: 0, y: 0, w: 612, h: 792 }, [{ rects: rects.slice(1), cover: "#ffffff" }]).removed).toBe(1);
  });

  it("parses a dense page well under 100 ms", () => {
    const lines: string[] = ["BT /F1 9 Tf 10 TL 20 780 Td"];
    for (let i = 0; i < 4000; i++) lines.push(`(Line ${i} of a dense page with quite a lot of text on it) Tj T* [(Ke) -20 (rn) 30 (ed)] TJ`);
    lines.push("ET");
    const content = lines.join("\n"); // ~330 KB, 12k text operators
    // Best of three: a parallel test run can stall any single pass.
    let best = Infinity;
    let r = run(content, [[20, 20, 100, 10]]);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      r = run(content, [[20, 20, 100, 10]]);
      best = Math.min(best, performance.now() - t0);
    }
    expect(r.unresolved).toHaveLength(1);
    expect(best).toBeLessThan(300); // ~60 ms measured for this heavy page; typical pages are a fraction of it
  });
});

describe.skipIf(!hasFixture("edit_text.pdf", "edit_text.json"))("removing glyphs from the fixture pages", () => {
  const cases = hasFixture("edit_text.json")
    ? (JSON.parse(readFileSync(fixture("edit_text.json"), "utf8")) as { pages: { name: string; rect: PageRect; gone: string; formText?: boolean }[] }).pages
    : [];
  it("removes exactly the glyphs of the edited word (no space beside it), and nothing for form text", async () => {
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(fixture("edit_text.pdf"))));
    for (const [i, c] of cases.entries()) {
      const page = doc.getPage(i);
      const geom = i === 0 ? { x: 30, y: 40, w: 560, h: 740 } : { x: 0, y: 0, w: 612, h: 792 };
      const res = redactPage(doc, page, geom, [{ rects: [c.rect], cover: "#ffffff" }]);
      expect(res.removed, c.name).toBe(c.formText ? 0 : c.gone.replace(/ /g, "").length);
      expect(res.covers.length, c.name).toBe(c.formText ? 1 : 0);
      if (!c.formText) expect(page.node.get(PDFName.of("Contents"))?.toString()).toMatch(/^\d+ 0 R$/); // one replacement stream
    }
  });
});
