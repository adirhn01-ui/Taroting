// PDF export against the files and projects that broke it: owner-password
// PDFs, forms whose values have no appearance, the same form merged twice,
// hostile or odd ids in a `.trt`, page indices past the end, cancelling, the
// Arabic fallback's canvas size, and turned (r) box marks.

import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfAnnot } from "../../core/types";
import { abortError } from "./cancel";
import { PdfExportError } from "./errors";
import { buildPdf } from "./export";
import { CANVAS_MAX_AREA, CANVAS_MAX_SIDE } from "../view/math";
import {
  apStream,
  encodePts,
  hasFixture,
  hasFont,
  nodeDeps,
  nums,
  pg,
  project,
  rawAnnots,
  readBack,
  source,
  uid,
} from "./testkit";

const NO_FLAT = { flattenMarks: false, flattenForms: false };
const FLAT_FORMS = { flattenMarks: false, flattenForms: true };

/** A source served from memory (path "mem:<name>"). */
function memDeps(files: Record<string, Uint8Array>) {
  const base = nodeDeps();
  return nodeDeps({
    fileStat: async (path) => (path in files ? { size: files[path]!.length, mtimeMs: 1000 } : base.fileStat(path)),
    readBytes: async (path) => (path in files ? files[path]! : base.readBytes(path)),
  });
}

describe.skipIf(!hasFixture("owner_only.pdf", "owner_form.pdf"))("a source with only an owner password", () => {
  it("exports on its own as a plain file pdf-lib reads, every page and its title kept", async () => {
    const own = source("owner_only.pdf");
    const out = await buildPdf(project([own], [pg(own, 0), pg(own, 1), pg(own, 2)]), NO_FLAT, nodeDeps());
    const lib = await PDFDocument.load(out, { updateMetadata: false }); // throws on an encrypted file
    expect(lib.isEncrypted).toBe(false);
    expect(lib.getPageCount()).toBe(3); // the sentinel page is gone
    expect(lib.getTitle()).toBe("Owner only");
    const { pages } = await readBack(out);
    expect(pages.map((p) => p.text.match(/Page \d of 3/)?.[0])).toEqual(["Page 1 of 3", "Page 2 of 3", "Page 3 of 3"]);
  });

  it("with a blank page, turned, and as a range", async () => {
    const own = source("owner_only.pdf");
    const p = project([own], [pg(own, 2), pg(null, 0, 0, 300, 400), pg(own, 0, 90), pg(own, 1)]);
    const all = await readBack(await buildPdf(p, NO_FLAT, nodeDeps()));
    expect(all.pages.map((x) => x.text.match(/Page \d of 3/)?.[0] ?? "")).toEqual(["Page 3 of 3", "", "Page 1 of 3", "Page 2 of 3"]);
    expect(all.pages[1]!.view).toEqual([0, 0, 300, 400]);
    expect(all.pages[2]!.rotate).toBe(90);
    const range = await readBack(await buildPdf(p, { ...NO_FLAT, range: [2, 3] }, nodeDeps()));
    expect(range.pages.length).toBe(2);
    expect(range.pages[0]!.view).toEqual([0, 0, 300, 400]);
    expect(range.pages[1]!.text).toContain("Page 1 of 3");
  });

  it("with its form filled in, kept fillable or flattened", async () => {
    const form = source("owner_form.pdf");
    const values = { "9R": "Owner filled", "13R": true };
    const p = project([form], [pg(form, 0)], {}, { [form.id]: values });
    const kept = await buildPdf(p, NO_FLAT, nodeDeps());
    const { pages } = await readBack(kept);
    const byName = Object.fromEntries(pages[0]!.annots.map((a) => [a.fieldName, a]));
    expect(byName["name"]!.fieldValue).toBe("Owner filled");
    expect(byName["agree"]!.fieldValue).not.toBe("Off");
    const flat = await buildPdf(p, FLAT_FORMS, nodeDeps());
    const back = await readBack(flat);
    expect(back.fields).toBeNull();
    expect(back.pages.length).toBe(1);
    expect(back.pages[0]!.text).toContain("Owner filled");
  });
});

describe.skipIf(!hasFixture("need_appearances.pdf"))("flattening values that have no appearance", () => {
  it("draws the values of a /NeedAppearances form into the page", async () => {
    const na = source("need_appearances.pdf");
    const out = await buildPdf(project([na], [pg(na, 0)]), FLAT_FORMS, nodeDeps());
    const { pages, fields } = await readBack(out);
    expect(fields).toBeNull();
    expect(pages[0]!.annots).toEqual([]);
    for (const v of ["Filled elsewhere", "Line one", "Line two", "Green"]) expect(pages[0]!.text).toContain(v);
  });

  it("draws a value with no appearance even without the flag, and the user's own value", async () => {
    const lib = await PDFDocument.load(await nodeDeps().readBytes("tests/fixtures/pdf/need_appearances.pdf"));
    lib.catalog.lookup(PDFName.of("AcroForm"), PDFDict).delete(PDFName.of("NeedAppearances"));
    const bytes = await lib.save({ updateFieldAppearances: false });
    const src = { id: "na", path: "mem:na.pdf", size: bytes.length, mtimeMs: 1000, pages: 1 };
    const p = project([src], [pg(src, 0)], {}, { na: { "13R": "Typed here" } });
    const { pages } = await readBack(await buildPdf(p, FLAT_FORMS, memDeps({ [src.path]: bytes })));
    for (const v of ["Filled elsewhere", "Typed here", "Green"]) expect(pages[0]!.text).toContain(v);
    expect(pages[0]!.text).not.toContain("Line one");
  });

  it("leaves a kept (unflattened) form as it was", async () => {
    const na = source("need_appearances.pdf");
    const { pages } = await readBack(await buildPdf(project([na], [pg(na, 0)]), NO_FLAT, nodeDeps()));
    expect(pages[0]!.annots.map((a) => a.fieldValue)).toEqual(["Filled elsewhere", "Line one\nLine two", ["Green"]]);
  });
});

describe.skipIf(!hasFixture("form_acro.pdf"))("the same form twice in one export", () => {
  it("keeps each copy's values under its own name", async () => {
    const a = source("form_acro.pdf");
    const b = source("form_acro.pdf");
    const p = project([a, b], [pg(a, 0), pg(b, 0)], {}, { [a.id]: { "9R": "first" }, [b.id]: { "9R": "second" } });
    const { pages, fields } = await readBack(await buildPdf(p, NO_FLAT, nodeDeps()));
    expect(pages[0]!.annots.find((x) => x.fieldName === "name")?.fieldValue).toBe("first");
    expect(pages[1]!.annots.find((x) => x.fieldName === "name_2")?.fieldValue).toBe("second");
    expect([...(fields?.keys() ?? [])]).toEqual(expect.arrayContaining(["name", "name_2", "agree", "agree_2", "colour_2"]));
  });
});

describe.skipIf(!hasFixture("plain_3p.pdf", "form_acro.pdf"))("ids from a crafted .trt", () => {
  it("a form key that is not a widget id is ignored, not handed to pdf.js", async () => {
    const form = source("form_acro.pdf");
    const p = project([form], [pg(form, 0)], {}, { [form.id]: { pdfjs_internal_editor_0: "x", "9R": "kept" } });
    const { pages } = await readBack(await buildPdf(p, NO_FLAT, nodeDeps()));
    expect(pages[0]!.annots.find((x) => x.fieldName === "name")?.fieldValue).toBe("kept");
  });

  it("built-in property names as source and page ids export like any other", async () => {
    for (const id of ["toString", "valueOf", "hasOwnProperty", "__defineGetter__"]) {
      const plain = source("plain_3p.pdf", id);
      const page = { ...pg(plain, 1), id: "constructor" === id ? "x" : id };
      // a plain {} for the passwords, as a caller may hand over
      const out = await buildPdf(project([plain], [page]), { ...NO_FLAT, passwords: {} }, nodeDeps());
      expect((await readBack(out)).pages[0]!.text, id).toContain("Page 2 of 3");
    }
  });

  it("a page past the end of its source is a plain-language error, primary or not", async () => {
    const plain = source("plain_3p.pdf");
    const form = source("form_acro.pdf");
    const cases: [ReturnType<typeof project>, string][] = [
      [project([plain], [pg(plain, 0), pg(plain, 5)]), "page 6 of plain_3p.pdf, which has only 3 pages"],
      [project([plain, form], [pg(plain, 0), pg(form, 2)]), "page 3 of form_acro.pdf, which has only 1 page."],
    ];
    for (const [p, msg] of cases) {
      const err = await buildPdf(p, NO_FLAT, nodeDeps()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PdfExportError);
      expect((err as PdfExportError).code).toBe("source-invalid");
      expect((err as Error).message).toContain(`This project refers to ${msg}`);
    }
  });
});

describe.skipIf(!hasFixture("plain_3p.pdf"))("cancelling the build", () => {
  /** Many long ink strokes: seconds of work without a turn of the loop. */
  function heavy() {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const pts: number[] = [];
    for (let i = 0; i < 4000; i++) pts.push(50 + (i % 500), 50 + i / 10, 0.5);
    const p = encodePts(pts);
    const marks: PdfAnnot[] = Array.from({ length: 60 }, () => ({ id: uid("k"), t: "ink", kind: "pen", c: "#000000", w: 2, o: 1, p }));
    return project([plain], [page], { [page.id]: marks });
  }

  it("an aborted signal refuses to start", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await buildPdf(heavy(), { ...NO_FLAT, signal: ac.signal }, nodeDeps()).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  it("the build gives the event loop a turn every few ms, so an abort lands at once", async () => {
    const full0 = performance.now();
    await buildPdf(heavy(), NO_FLAT, nodeDeps());
    const full = performance.now() - full0;
    const ac = new AbortController();
    let latency = -1;
    // deps.now() is asked right before the marks are built: from there on
    // only the build's own checkpoints let a timer run
    const deps = nodeDeps({
      now: () => {
        const t0 = performance.now();
        setTimeout(() => {
          latency = performance.now() - t0;
          ac.abort();
        }, 0);
        return new Date("2026-10-17T12:00:00Z");
      },
    });
    const t1 = performance.now();
    const err = await buildPdf(heavy(), { ...NO_FLAT, signal: ac.signal }, deps).catch((e: unknown) => e);
    const took = performance.now() - t1;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as Error).name).toBe(abortError().name);
    console.log(`heavy build ${full.toFixed(0)} ms; abort timer ran after ${latency.toFixed(0)} ms, build ended after ${took.toFixed(0)} ms`);
    expect(full).toBeGreaterThan(300); // there is real work to interrupt
    expect(latency).toBeLessThan(150);
    expect(took).toBeLessThan(full);
  }, 60_000);
});

describe.skipIf(!hasFixture("plain_3p.pdf") || !hasFont())("the Arabic fallback's canvas", () => {
  it("is held within the canvas limits for a huge box", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const box: PdfAnnot = {
      id: "ar",
      t: "text",
      x: 0,
      y: 0,
      w: 4000,
      h: 3000,
      text: "مرحبا",
      font: "Arial",
      size: 20,
      c: "#000000",
      bold: false,
      italic: false,
      align: "left",
    };
    const deps = nodeDeps();
    await buildPdf(project([plain], [page], { [page.id]: [box] }), NO_FLAT, deps);
    const spec = deps.rasterCalls[0]!;
    const cw = Math.ceil(spec.w * spec.scale);
    const ch = Math.ceil(spec.h * spec.scale);
    expect(Math.max(cw, ch)).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
    expect(cw * ch).toBeLessThanOrEqual(CANVAS_MAX_AREA);
    expect(spec.scale).toBeGreaterThan(0.5);
  });
});

describe.skipIf(!hasFixture("rotated.pdf") || !hasFont())("turned box marks (r)", () => {
  const text = (r: 0 | 90 | 180 | 270): Extract<PdfAnnot, { t: "text" }> => ({
    id: uid("t"),
    t: "text",
    x: 100,
    y: 100,
    w: 60,
    h: 300,
    text: "Upright",
    font: "Arial",
    size: 20,
    c: "#000000",
    bold: false,
    italic: false,
    align: "left",
    r,
  });

  /** The text item's transform as it is DISPLAYED (viewport applied). */
  async function displayed(bytes: Uint8Array, str: string): Promise<number[]> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
      const item = items.find((i) => i.str === str)!;
      expect(item, str).toBeDefined();
      return pdfjs.Util.transform(page.getViewport({ scale: 1 }).transform, item.transform);
    } finally {
      await task.destroy();
    }
  }

  it("a text box with r=90 on a page shown turned 90° reads upright, inside its box", async () => {
    const rot = source("rotated.pdf");
    const page = pg(rot, 1); // /Rotate 90
    const a = text(90);
    const out = await buildPdf(project([rot], [page], { [page.id]: [a] }), { flattenMarks: true, flattenForms: false }, nodeDeps());
    const [m0, m1, m2, m3, m4, m5] = await displayed(out, "Upright");
    // the frame's top-left, turned by -r and then by the page's +r, is the
    // box's top-left ON SCREEN: the first line starts there (left aligned)
    const pdfjs0 = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const t0 = pdfjs0.getDocument({ data: out.slice(), verbosity: 0 });
    const vp = (await (await t0.promise).getPage(1)).getViewport({ scale: 1 });
    await t0.destroy();
    const H0 = 841.89;
    const corners = [
      [100, H0 - 100],
      [160, H0 - 100],
      [100, H0 - 400],
      [160, H0 - 400],
    ].map(([x, y]) => vp.convertToViewportPoint(x!, y!) as number[]);
    const left = Math.min(...corners.map((p) => p[0]!));
    const top = Math.min(...corners.map((p) => p[1]!));
    expect(m4).toBeCloseTo(left, 1);
    expect(m5! - top).toBeGreaterThan(10); // the baseline, one ascent below the top
    expect(m5! - top).toBeLessThan(25);
    // upright on screen: x right, y down (canvas space), no shear or turn
    expect(m0).toBeGreaterThan(0);
    expect(Math.abs(m1!)).toBeLessThan(1e-6);
    expect(Math.abs(m2!)).toBeLessThan(1e-6);
    expect(m3).toBeLessThan(0);
    // in user space it runs bottom to top: the turn is counter-clockwise
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: out.slice(), verbosity: 0 });
    const doc = await task.promise;
    const item = ((await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[]).find((i) => i.str === "Upright")!;
    await task.destroy();
    expect(item.transform[0]).toBeCloseTo(0, 6);
    expect(item.transform[1]).toBeCloseTo(20, 6);
    // within the box's user-space x range [100, 160]
    expect(item.transform[4]).toBeGreaterThan(100);
    expect(item.transform[4]).toBeLessThan(160);
  });

  it("the annotation keeps the box as Rect/BBox and turns its content in the stream", async () => {
    const rot = source("rotated.pdf");
    const page = pg(rot, 1);
    const out = await buildPdf(project([rot], [page], { [page.id]: [text(90)] }), NO_FLAT, nodeDeps());
    const { doc, annots } = await rawAnnots(out, 0);
    const H = 841.89;
    expect(nums(annots[0]!, "Rect").map((v) => Math.round(v * 100) / 100)).toEqual([100, Math.round((H - 400) * 100) / 100, 160, Math.round((H - 100) * 100) / 100]);
    const ap = apStream(doc, annots[0]!)!;
    const ops = new TextDecoder().decode(decodePDFRawStream(ap as PDFRawStream).decode());
    expect(ops).toMatch(/^q 0 1 -1 0 [\d.-]+ [\d.-]+ cm /);
  });

  it("draws Impact plain even when the mark asks for bold italic (no such face)", async () => {
    const rot = source("rotated.pdf");
    const p0 = pg(rot, 0);
    const asked: string[] = [];
    const base = nodeDeps();
    const deps = nodeDeps({
      fontBytes: async (f, b, i) => {
        asked.push(`${f}|${b}|${i}`);
        return base.fontBytes(f, b, i);
      },
    });
    const impact: PdfAnnot = { ...text(0), font: "Impact", bold: true, italic: true };
    const arabic: PdfAnnot = { ...impact, id: uid("t"), text: "مرحبا" };
    await buildPdf(project([rot], [p0], { [p0.id]: [impact, arabic] }), NO_FLAT, deps);
    expect(asked).toEqual(["Impact|false|false"]);
    expect(deps.rasterCalls[0]!.bold).toBe(false);
    expect(deps.rasterCalls[0]!.italic).toBe(false);
  });

  it("no turn draws exactly as before, and 180 turns the text upside down in user space", async () => {
    const rot = source("rotated.pdf");
    const p0 = pg(rot, 0);
    const out = await buildPdf(project([rot], [p0], { [p0.id]: [text(0), { ...text(180), text: "Flipped" }] }), { flattenMarks: true, flattenForms: false }, nodeDeps());
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: out.slice(), verbosity: 0 });
    const doc = await task.promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
    await task.destroy();
    const up = items.find((i) => i.str.startsWith("Upr"))!;
    expect(up.transform.slice(0, 4)).toEqual([20, 0, 0, 20]);
    const flipped = items.find((i) => i.str.startsWith("Fli"))!;
    expect(flipped.transform[0]).toBeCloseTo(-20, 6);
    expect(flipped.transform[3]).toBeCloseTo(-20, 6);
  });

  it("a turned signature's ink stays inside its box", async () => {
    const rot = source("rotated.pdf");
    const page = pg(rot, 1);
    const sig: PdfAnnot = {
      id: "sig",
      t: "signature",
      x: 100,
      y: 100,
      w: 40,
      h: 200,
      c: "#000000",
      strokes: [encodePts([0, 0.5, 1, 1, 0.5, 1])], // a horizontal line across the frame
      r: 90,
    };
    const out = await buildPdf(project([rot], [page], { [page.id]: [sig] }), NO_FLAT, nodeDeps());
    const { annots } = await rawAnnots(out, 0);
    const H = 841.89;
    const [x0, y0, x1, y1] = nums(annots[0]!, "Rect");
    // the frame's horizontal line becomes the box's vertical centre line
    expect(x0).toBeGreaterThan(100 - 3);
    expect(x1).toBeLessThan(140 + 3);
    expect(x1! - x0!).toBeLessThan(10);
    expect(y1! - y0!).toBeGreaterThan(190);
    expect(y0).toBeGreaterThan(H - 300 - 3);
  });
});
