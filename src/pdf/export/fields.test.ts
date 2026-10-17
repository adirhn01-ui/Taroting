// Form values pdf.js cannot draw (a script its standard font cannot encode)
// get an appearance of ours (fields.ts): kept forms show them in every
// viewer, flattened forms keep them on the page.

import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfSource } from "../../core/types";
import { buildPdf } from "./export";
import { parseDA } from "./fields";
import { apStream, hasFixture, hasFont, nodeDeps, nums, pg, project, rawAnnots, readBack, source } from "./testkit";

/** Output for opening in a real viewer (the export tests' sample folder). */
function sample(name: string, bytes: Uint8Array): void {
  try {
    mkdirSync(".claude/spike/out/", { recursive: true });
    writeFileSync(".claude/spike/out/" + name, bytes);
  } catch {
    /* samples are a convenience */
  }
}

const KEPT = { flattenMarks: false, flattenForms: false };
const FLAT = { flattenMarks: false, flattenForms: true };

const HEBREW = "Adir שלום";
const CYRILLIC = "Иван Петров";

async function build(src: PdfSource, values: Record<string, string | string[]>, flatten: boolean, deps = nodeDeps()): Promise<Uint8Array> {
  return buildPdf(project([src], [pg(src, 0)], {}, { [src.id]: values }), flatten ? FLAT : KEPT, deps);
}

/** The decoded content of a widget's normal appearance, and its stream. */
async function widgetAppearance(bytes: Uint8Array, fieldName: string): Promise<{ text: string; stream: PDFStream; widget: PDFDict } | null> {
  const { doc, annots } = await rawAnnots(bytes, 0);
  for (const w of annots) {
    const parent = w.lookup(PDFName.of("Parent"));
    const t = (parent instanceof PDFDict ? parent : w).lookup(PDFName.of("T"));
    if (!t || !("decodeText" in t) || (t as { decodeText(): string }).decodeText() !== fieldName) continue;
    const s = apStream(doc, w);
    if (!s) return null;
    const raw = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    return { text: new TextDecoder("latin1").decode(raw), stream: s, widget: w };
  }
  return null;
}

/** The text pdf.js reads from each widget's appearance, by field name. */
async function appearanceText(bytes: Uint8Array): Promise<Record<string, string>> {
  const { pages } = await readBack(bytes);
  return Object.fromEntries(pages[0]!.annots.map((a) => [a.fieldName ?? a.id, (a.textContent ?? []).join("\n")]));
}

const fontSize = (ops: string): number => Number(/\/F0 ([\d.]+) Tf/.exec(ops)?.[1] ?? NaN);

describe("parseDA", () => {
  it("reads the size and the last colour", () => {
    expect(parseDA("/Helv 0 Tf 0 g")).toMatchObject({ size: 0, colour: "0 g" });
    expect(parseDA("0 0 1 rg /Helv 14 Tf")).toMatchObject({ size: 14, colour: "0 0 1 rg", rgb: [0, 0, 1] });
    expect(parseDA("0 0 0 1 k /F1 9.5 Tf")).toMatchObject({ size: 9.5, rgb: [0, 0, 0] });
    expect(parseDA("")).toMatchObject({ size: 0, colour: "0 g" });
  });
});

describe.skipIf(!hasFixture("form_acro.pdf") || !hasFont("Arial"))("a value pdf.js cannot draw (form_acro.pdf)", () => {
  it("kept: the widget gets an appearance that reads back as the Hebrew value, and the form no longer asks the viewer to draw", async () => {
    const out = await build(source("form_acro.pdf"), { "9R": HEBREW }, false);
    sample("a5-forms-hebrew-kept.pdf", out);
    const app = await widgetAppearance(out, "name");
    expect(app).not.toBeNull();
    expect(app!.text).toContain("/F0");
    const lib = await PDFDocument.load(out);
    expect(lib.catalog.lookup(PDFName.of("AcroForm"), PDFDict).has(PDFName.of("NeedAppearances"))).toBe(false);
    // pdf.js reads the appearance's glyphs back with the Hebrew word in
    // logical order (which side of "Adir" it lands on is pdf.js's own guess at
    // the line's direction: it counts the right-to-left characters)
    const read = (await appearanceText(out))["name"]!;
    expect(read).toContain("שלום");
    expect(read).not.toContain("םולש");
    expect(read).toContain("Adir");
    // one shown string: the line is drawn already reordered, nothing left to the viewer
    expect(app!.text.match(/<[0-9A-F]+>/g)!.length).toBe(1);
    // an all-Hebrew value reads back exactly
    const he = "אדיר שלום";
    expect((await appearanceText(await build(source("form_acro.pdf"), { "9R": he }, false)))["name"]).toBe(he);
    const { pages } = await readBack(out);
    expect(pages[0]!.annots.find((a) => a.fieldName === "name")!.fieldValue).toBe(HEBREW); // /V untouched
  });

  it("flattened: no widgets are left and the Hebrew value is on the page", async () => {
    const out = await build(source("form_acro.pdf"), { "9R": HEBREW }, true);
    sample("a5-forms-hebrew-flat.pdf", out);
    const { pages, fields } = await readBack(out);
    expect(fields).toBeNull();
    expect(pages[0]!.annots).toEqual([]);
    expect(pages[0]!.text).toContain("שלום");
    expect(pages[0]!.text).toContain("Adir");
  });

  it("a Cyrillic value, kept and flattened", async () => {
    const src = source("form_acro.pdf");
    expect((await appearanceText(await build(src, { "9R": CYRILLIC }, false)))["name"]).toBe(CYRILLIC);
    const { pages } = await readBack(await build(src, { "9R": CYRILLIC }, true));
    expect(pages[0]!.annots).toEqual([]);
    expect(pages[0]!.text).toContain("Петров");
  });

  it("a combo box showing a value pdf.js cannot draw", async () => {
    const src = source("form_acro.pdf");
    const { pages } = await readBack(await build(src, { "30R": "Зелёный" }, true));
    expect(pages[0]!.text).toContain("Зелёный");
  });

  it("an Arabic value is drawn by the browser's canvas into the appearance", async () => {
    const deps = nodeDeps();
    const out = await build(source("form_acro.pdf"), { "9R": "مرحبا" }, false, deps);
    expect(deps.rasterCalls.length).toBe(1);
    expect(deps.rasterCalls[0]!.text).toBe("مرحبا");
    expect((await widgetAppearance(out, "name"))!.text).toContain("/Im0 Do");
  });

  it("a Latin-only value keeps pdf.js's own appearance", async () => {
    const out = await build(source("form_acro.pdf"), { "9R": "Adir Latin" }, false);
    const app = await widgetAppearance(out, "name");
    expect(app).not.toBeNull();
    expect(app!.text).not.toContain("/F0");
    expect(app!.text).toContain("(Adir Latin) Tj");
    const flat = await readBack(await build(source("form_acro.pdf"), { "9R": "Adir Latin" }, true));
    expect(flat.pages[0]!.text).toContain("Adir Latin");
  });
});

describe.skipIf(!hasFixture("form_text_kinds.pdf") || !hasFont("Arial"))("field layouts (form_text_kinds.pdf)", () => {
  // pdf.js ids of the fixture's widgets
  const ID = { notes: "9R", fixed: "13R", auto: "16R", code: "19R", turned: "22R", pick: "25R" };

  it("a multi-line field: each line drawn, wrapped inside the box, auto-sized", async () => {
    const src = source("form_text_kinds.pdf");
    const value = "שורה ראשונה\nSecond line Привет";
    const out = await build(src, { [ID.notes]: value }, false);
    const app = (await widgetAppearance(out, "notes"))!;
    expect(app).not.toBeNull();
    expect(app.text.match(/ Tm /g)!.length).toBeGreaterThanOrEqual(2);
    expect(fontSize(app.text)).toBeLessThanOrEqual(12);
    expect((await appearanceText(out))["notes"]).toBe(value);
    const flat = await readBack(await build(src, { [ID.notes]: value }, true));
    for (const part of ["ראשונה", "Second line", "Привет"]) expect(flat.pages[0]!.text).toContain(part);
  });

  it("an auto-size (DA size 0) field fits its box", async () => {
    const src = source("form_text_kinds.pdf");
    const out = await build(src, { [ID.auto]: "Ελληνικά" }, false);
    const app = (await widgetAppearance(out, "auto"))!;
    expect(app).not.toBeNull();
    const size = fontSize(app.text);
    // the box is 31 pt tall: pdf.js's rule, (31 − 2) / 1.35
    expect(size).toBeGreaterThan(15);
    expect(size).toBeLessThanOrEqual(29 / 1.35 + 0.01);
    expect((await appearanceText(out))["auto"]).toBe("Ελληνικά");
  });

  it("a fixed size, colour and right alignment come from /DA and /Q", async () => {
    const src = source("form_text_kinds.pdf");
    const out = await build(src, { [ID.fixed]: "Право" }, false);
    const app = (await widgetAppearance(out, "fixed"))!;
    expect(fontSize(app.text)).toBe(14);
    expect(app.text).toContain("0 0 1 rg");
    const x = Number(/1 0 0 1 ([\d.]+) [\d.]+ Tm/.exec(app.text)![1]);
    expect(x).toBeGreaterThan(200); // right-aligned in a 301 pt box
  });

  it("a comb field puts one character in each cell", async () => {
    const src = source("form_text_kinds.pdf");
    const out = await build(src, { [ID.code]: "АБВ123" }, false);
    const app = (await widgetAppearance(out, "code"))!;
    const xs = [...app.text.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(6);
    const cell = 181 / 6;
    xs.forEach((x, i) => {
      expect(x).toBeGreaterThan(i * cell);
      expect(x).toBeLessThan((i + 1) * cell);
    });
  });

  it("a turned (/MK /R 90) field: pdf.js's BBox and Matrix, and the value on a flattened page", async () => {
    const src = source("form_text_kinds.pdf");
    const out = await build(src, { [ID.turned]: "Сбоку" }, false);
    const app = (await widgetAppearance(out, "turned"))!;
    expect(nums(app.stream.dict, "BBox")).toEqual([0, 0, 141, 25]);
    expect(nums(app.stream.dict, "Matrix")).toEqual([0, 1, -1, 0, 25, 0]);
    const flat = await readBack(await build(src, { [ID.turned]: "Сбоку" }, true));
    expect(flat.pages[0]!.text).toContain("Сбоку");
  });

  it("a list box whose options pdf.js draws as garbage is redrawn with the selection", async () => {
    const src = source("form_text_kinds.pdf");
    const out = await build(src, { [ID.pick]: ["אדום"] }, false);
    const app = (await widgetAppearance(out, "pick"))!;
    expect(app.text).toContain("/F0");
    expect(app.text).toContain("0.600006 0.756866 0.854904 rg");
    const flat = await readBack(await build(src, { [ID.pick]: ["אדום"] }, true));
    for (const o of ["Red", "אדום", "Синий"]) expect(flat.pages[0]!.text).toContain(o);
  });
});
