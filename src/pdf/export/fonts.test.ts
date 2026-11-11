// PDF export of text boxes with a non-legacy font (0.9.4 font library): the
// legacy path untouched and resolve-free (I1), the resolved file embedded by
// its embedding policy, a missing font falling back to the legacy one.
// Consolas stands in for a library / installed font (the seam's E2E choice):
// its file is read from C:/Windows/Fonts, nothing is installed.

import { existsSync, readFileSync } from "node:fs";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { FontEmbed, FontRequest, PdfAnnot, ResolvedFont } from "../../core/types";
import { PdfExportError } from "./errors";
import { buildPdf } from "./export";
import { hasFixture, hasFont, nodeDeps, pg, project, source, uid } from "./testkit";

const NO_FLAT = { flattenMarks: false, flattenForms: false };
const CONSOLAS = "C:/Windows/Fonts/consola.ttf";

const box = (over: Partial<Extract<PdfAnnot, { t: "text" }>> = {}): PdfAnnot => ({
  id: uid("t"),
  t: "text",
  x: 100,
  y: 100,
  w: 240,
  h: 40,
  text: "Hello there",
  font: "Georgia",
  size: 13,
  c: "#102030",
  bold: false,
  italic: false,
  align: "left",
  ...over,
});

/** A fonts_resolve stand-in: every id resolves to Consolas' regular file
 *  with `embed`, or (found: false) to nothing. */
function resolver(embed: FontEmbed | "missing") {
  return async (reqs: FontRequest[]): Promise<ResolvedFont[]> =>
    reqs.map((r) =>
      embed === "missing"
        ? { requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" }
        : { requested: r.id, found: true, bold: false, italic: false, path: CONSOLAS, lineHeightEm: 1.17, embed },
    );
}

/** Every /BaseFont the output names. */
async function baseFonts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("Type"))?.toString() !== "/Font") continue;
    const b = obj.get(PDFName.of("BaseFont"));
    if (b) out.push(b.toString());
  }
  return out;
}

async function exportOne(a: PdfAnnot, deps = nodeDeps()): Promise<Uint8Array> {
  const plain = source("plain_3p.pdf");
  const page = pg(plain, 0);
  return buildPdf(project([plain], [page], { [page.id]: [a] }), NO_FLAT, deps);
}

describe.skipIf(!hasFixture("plain_3p.pdf") || !hasFont("Georgia") || !existsSync(CONSOLAS))("text box fonts", () => {
  it("a legacy-font box exports through the legacy path with no fonts_resolve call (I1)", async () => {
    const deps = nodeDeps({ resolveFonts: resolver("full") });
    const fonts = await baseFonts(await exportOne(box(), deps));
    expect(deps.resolveCalls).toEqual([]);
    expect(fonts.some((f) => f.includes("Georgia"))).toBe(true);
    expect(fonts.some((f) => f.includes("Consolas"))).toBe(false);
  });

  it("a non-legacy box embeds the resolved file, subset (full policy)", async () => {
    const deps = nodeDeps({ resolveFonts: resolver("full") });
    const out = await exportOne(box({ fontId: "lib:Consolas", bold: true }), deps);
    const fonts = await baseFonts(out);
    expect(deps.resolveCalls).toEqual([[{ id: "lib:Consolas", bold: true, italic: false }]]);
    expect(fonts.some((f) => f.includes("Consolas"))).toBe(true);
    expect(fonts.some((f) => f.includes("Georgia"))).toBe(false);
    // a subset of a few glyphs: far smaller than the font file
    expect(out.length).toBeLessThan(readFileSync(CONSOLAS).length * 0.2);
  });

  it("noSubset embeds the whole file, not a subset", async () => {
    const deps = nodeDeps({ resolveFonts: resolver("noSubset") });
    const out = await exportOne(box({ fontId: "Consolas" }), deps);
    expect((await baseFonts(out)).some((f) => f.includes("Consolas"))).toBe(true);
    // every glyph of the file is in the output (compressed, still most of it)
    expect(out.length).toBeGreaterThan(readFileSync(CONSOLAS).length * 0.3);
  });

  it("none refuses the export with a message naming the font", async () => {
    const deps = nodeDeps({ resolveFonts: resolver("none") });
    const err = await exportOne(box({ fontId: "lib:Consolas" }), deps).catch((e) => e);
    expect(err).toBeInstanceOf(PdfExportError);
    expect(err.code).toBe("font-restricted");
    expect(err.message).toBe("The font Consolas can't go in a PDF because its license doesn't allow it, so pick another font for the text that uses it.");
  });

  it("a font missing on this PC exports in the legacy font and succeeds", async () => {
    const deps = nodeDeps({ resolveFonts: resolver("missing") });
    const fonts = await baseFonts(await exportOne(box({ fontId: "lib:Consolas" }), deps));
    expect(deps.resolveCalls).toHaveLength(1);
    expect(fonts.some((f) => f.includes("Georgia"))).toBe(true);
    expect(fonts.some((f) => f.includes("Consolas"))).toBe(false);
  });

  it("the Arabic raster path names the resolved font only when it resolved", async () => {
    const found = nodeDeps({ resolveFonts: resolver("full") });
    await exportOne(box({ text: "مرحبا", fontId: "lib:Consolas", italic: true }), found);
    expect(found.rasterCalls[0]).toMatchObject({ font: "Georgia", fontId: "lib:Consolas", italic: false });
    const missing = nodeDeps({ resolveFonts: resolver("missing") });
    await exportOne(box({ text: "مرحبا", fontId: "lib:Consolas", italic: true }), missing);
    expect("fontId" in missing.rasterCalls[0]!).toBe(false);
    expect(missing.rasterCalls[0]).toMatchObject({ font: "Georgia", italic: true });
  });
});
