// "Edit text" end to end: an edited text box over a word of real page text →
// the export no longer holds that word, every other glyph stays where it was,
// and the new text is there. Expected geometry comes from the fixture script
// (tests/fixtures/pdf/edit_text.json), computed from the font data it wrote.

import { readFileSync } from "node:fs";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { PdfAnnot } from "../../core/types";
import { buildPdf } from "./export";
import * as redact from "./redact";
import { apStream, fixture, hasFixture, hasFont, nodeDeps, pg, project, rawAnnots, source, uid } from "./testkit";

interface Item {
  str: string;
  x: number;
  y: number;
}
interface Case {
  name: string;
  rect: [number, number, number, number];
  gone: string;
  keep: string[];
  head?: { str: string; x: number; y: number };
  tail?: { str: string; x: number; y: number };
  formText?: boolean;
}

const READY = hasFixture("edit_text.pdf", "edit_text.json") && hasFont();
const CASES: Case[] = READY ? (JSON.parse(readFileSync(fixture("edit_text.json"), "utf8")) as { pages: Case[] }).pages : [];
const FLAT = { flattenMarks: true, flattenForms: false };
const ANNOT = { flattenMarks: false, flattenForms: false };
const NEW = "Swapped";

async function items(bytes: Uint8Array, pageIndex: number): Promise<Item[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  try {
    const tc = await (await doc.getPage(pageIndex + 1)).getTextContent();
    return (tc.items as { str?: string; transform?: number[] }[])
      .filter((i) => typeof i.str === "string" && i.str.trim() !== "")
      .map((i) => ({ str: i.str!, x: i.transform![4]!, y: i.transform![5]! }));
  } finally {
    await task.destroy();
  }
}

type TextBox = Extract<PdfAnnot, { t: "text" }>;
const editBox = (c: Case, cover = "#fefefe"): TextBox => ({
  id: uid("e"),
  t: "text",
  x: c.rect[0],
  y: c.rect[1] - 4,
  w: Math.max(c.rect[2], 80),
  h: c.rect[3] + 8,
  text: NEW,
  font: "Arial",
  size: 10,
  c: "#000000",
  bold: false,
  italic: false,
  align: "left",
  edit: { rects: [c.rect], cover, orig: c.gone },
});

function exportCase(i: number, box: PdfAnnot, opts = FLAT): Promise<Uint8Array> {
  const src = source("edit_text.pdf");
  const page = pg(src, i);
  return buildPdf(project([src], [page], { [page.id]: [box] }), opts, nodeDeps());
}

/** The decoded page content (all streams joined). */
async function contentOf(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const c = doc.getPage(pageIndex).node.Contents()!;
  const refs = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, i) => c.get(i)) : [c];
  let out = "";
  for (const r of refs) {
    const s = doc.context.lookup(r) as PDFStream;
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    out += new TextDecoder("latin1").decode(bytes) + "\n";
  }
  return out;
}

const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) <= eps;

describe.skipIf(!READY)("Edit text: the replaced glyphs leave the page", () => {
  for (const [i, c] of CASES.entries()) {
    if (c.formText) continue;
    it(`${c.name}: the word is gone, everything else stays put, the new text is there`, async () => {
      const before = await items(new Uint8Array(readFileSync(fixture("edit_text.pdf"))), i);
      expect(before.map((x) => x.str).join(" ")).toContain(c.gone);
      const out = await exportCase(i, editBox(c));
      const after = await items(out, 0);
      const text = after.map((x) => x.str).join(" ");
      expect(text).not.toContain(c.gone);
      expect(text).toContain(NEW);
      // untouched lines: same string, same place
      for (const k of c.keep) {
        const b = before.find((x) => x.str.includes(k))!;
        const a = after.find((x) => x.str.includes(k));
        expect(a, k).toBeDefined();
        expect(near(a!.x, b.x) && near(a!.y, b.y), `${k}: ${a!.x},${a!.y} vs ${b.x},${b.y}`).toBe(true);
      }
      // the text before the word starts where it did; the text after it starts
      // exactly where it was drawn (the removed glyphs' advance kept)
      const head = after.find((x) => x.str.startsWith(c.head!.str))!;
      expect(head, c.head!.str).toBeDefined();
      expect(near(head.x, c.head!.x) && near(head.y, c.head!.y), `head ${head.x},${head.y}`).toBe(true);
      const tail = after.find((x) => x.str.trimStart().startsWith(c.tail!.str))!;
      expect(tail, `${c.tail!.str} in ${JSON.stringify(after)}`).toBeDefined();
      expect(near(tail.x, c.tail!.x) && near(tail.y, c.tail!.y), `tail ${tail.x},${tail.y} vs ${c.tail!.x}`).toBe(true);
      // and no cover was needed
      expect(await contentOf(out, 0)).not.toContain("0.9961 0.9961 0.9961 rg");
    });
  }

  it("works the same with the box kept as an annotation (the new text in its appearance)", async () => {
    const c = CASES[0]!;
    const out = await exportCase(0, editBox(c), ANNOT);
    const text = (await items(out, 0)).map((x) => x.str).join(" ");
    expect(text).not.toContain(c.gone);
    expect(text).toContain("Keep this");
    const { annots } = await rawAnnots(out, 0);
    expect(annots).toHaveLength(1);
  });

  it("text inside a Form XObject stays, under a cover in the edit's colour, with the new text on top", async () => {
    const i = CASES.findIndex((c) => c.formText);
    const c = CASES[i]!;
    const out = await exportCase(i, editBox(c, "#fefefe"));
    const text = (await items(out, 0)).map((x) => x.str).join(" ");
    expect(text).toContain(c.gone); // not rewritten…
    expect(text).toContain(NEW);
    expect(text).toContain("Outside text");
    const content = await contentOf(out, 0);
    // …but covered: the cover colour and its rect (page space → user space, padded 0.5)
    expect(content).toContain("0.9961 0.9961 0.9961 rg");
    const [x, y, w, h] = c.rect;
    const ux = x - 0.5;
    const uy = 792 - y - h - 0.5;
    expect(content).toContain(`${redact.fmt(ux)} ${redact.fmt(uy)} ${redact.fmt(w + 1)} ${redact.fmt(h + 1)} re f`);
    // the cover is painted before the flattened text box
    expect(content.indexOf("re f")).toBeLessThan(content.lastIndexOf("Do"));
  });

  it("a page whose content cannot be parsed gets covers for every edit, and keeps its content", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const broken = "BT /F1 12 Tf (never closed Tj ET";
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(broken)));
    const geom = { x: 0, y: 0, w: 612, h: 792 };
    const res = redact.redactPage(doc, page, geom, [
      { rects: [[10, 10, 50, 12], [10, 30, 50, 12]], cover: "#fefefe" },
      { rects: [[100, 100, 5, 5]], cover: "#000000" },
    ]);
    expect(res.removed).toBe(0);
    expect(res.covers.map((c) => c.cover)).toEqual(["#fefefe", "#fefefe", "#000000"]);
    expect(res.covers[0]!.rect).toEqual([9.5, 9.5, 51, 13]);
    redact.drawCovers(doc, page, geom, res.covers);
    const out = await doc.save();
    const content = await contentOf(out, 0);
    expect(content).toContain(broken); // untouched
    expect(content).toContain("0.9961 0.9961 0.9961 rg");
    expect(content).toContain("9.5 769.5 51 13 re f");
  });

  it("only pages with an edited box are parsed (a 300-page export without edits parses none)", async () => {
    const spy = vi.spyOn(redact, "redactPage");
    try {
      const big = source("large_300p.pdf");
      const pages = Array.from({ length: 300 }, (_, n) => pg(big, n));
      const c = CASES[0]!;
      const plain = { id: uid("t"), t: "text", x: 10, y: 10, w: 50, h: 20, text: "x", font: "Arial", size: 10, c: "#000000", bold: false, italic: false, align: "left" } as PdfAnnot;
      await buildPdf(project([big], pages, { [pages[5]!.id]: [plain] }), FLAT, nodeDeps());
      expect(spy).not.toHaveBeenCalled();
      const src = source("edit_text.pdf");
      const two = [pg(src, 0), pg(src, 1)];
      await buildPdf(project([src], two, { [two[1]!.id]: [editBox(c)] }), FLAT, nodeDeps());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

describe.skipIf(!READY)("Edit text: the box's fill and border", () => {
  const boxed = (): TextBox => ({ ...editBox(CASES[1]!), bg: "#ffee00", border: "#0000ff" });

  it("draws the fill and a 1 pt border behind the text, in the annotation's appearance", async () => {
    const out = await exportCase(1, boxed(), ANNOT);
    const { doc, annots } = await rawAnnots(out, 0);
    const ap = apStream(doc, annots[0]!)!;
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(ap as PDFRawStream).decode());
    expect(ops).toMatch(/1 0\.933 0 rg [-\d. ]+ re f/);
    expect(ops).toMatch(/0 0 1 RG 1 w .* re S/);
    expect(ops.indexOf("re f")).toBeLessThan(ops.indexOf("BT"));
    expect(ops.indexOf("re S")).toBeLessThan(ops.indexOf("BT"));
  });

  it("and in the flattened page", async () => {
    const out = await exportCase(1, boxed(), FLAT);
    // flattened: the mark form is painted with Do; its stream holds the ops
    const doc = await PDFDocument.load(out);
    let found = "";
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.toString().includes("/Form")) {
        const s = new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
        if (s.includes(NEW) || s.includes("re S")) found += s;
      }
    }
    expect(found).toMatch(/1 0\.933 0 rg [-\d. ]+ re f/);
    expect(found).toMatch(/0 0 1 RG 1 w .* re S/);
    expect((await items(out, 0)).map((x) => x.str).join(" ")).toContain(NEW);
  });

  it("a box with a fill and no text still draws its fill", async () => {
    const out = await exportCase(1, { ...boxed(), text: "" }, ANNOT);
    const { doc, annots } = await rawAnnots(out, 0);
    expect(annots).toHaveLength(1);
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(apStream(doc, annots[0]!) as PDFRawStream).decode());
    expect(ops).toMatch(/1 0\.933 0 rg [-\d. ]+ re f/);
    expect(ops).toContain("re S");
    expect(ops).not.toContain("BT");
  });
});
