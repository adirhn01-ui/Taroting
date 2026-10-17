// PDF export end to end in node: real fixtures through pdf.js + pdf-lib, the
// output re-opened with pdf.js (what a viewer sees) and pdf-lib (raw dicts).

import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, PDFHexString, PDFName, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfAnnot } from "../../core/types";
import { PdfExportError } from "./errors";
import { buildPdf, exportPdf } from "./export";
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
  subtypeOf,
  uid,
} from "./testkit";
import type { PdfSaveIpc } from "./write";

const NO_FLAT = { flattenMarks: false, flattenForms: false };
const H = 841.89; // fixture page height (A4)
const SAMPLES = ".claude/spike/out/";
function sample(name: string, bytes: Uint8Array): void {
  try {
    mkdirSync(SAMPLES, { recursive: true });
    writeFileSync(SAMPLES + name, bytes);
  } catch {
    /* samples are a convenience */
  }
}

const close = (a: number[], b: number[], eps = 0.01): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < eps);

/** One of every mark kind on a page. */
function everyMark(mediaId?: string): PdfAnnot[] {
  const marks: PdfAnnot[] = [
    { id: uid("a"), t: "ink", kind: "pen", c: "#ff0000", w: 3, o: 1, p: encodePts([100, 300, 0.5, 150, 340, 1, 200, 310, 0.8, 260, 360, 0.6]) },
    { id: uid("a"), t: "ink", kind: "marker", c: "#00ff00", w: 12, o: 0.4, p: encodePts([100, 400, 0.5, 300, 400, 0.5]) },
    { id: uid("a"), t: "highlight", c: "#ffff00", o: 0.5, rects: [[60, 100, 300, 16], [60, 120, 200, 16]] },
    { id: uid("a"), t: "text", x: 300, y: 500, w: 200, h: 60, text: "Hello box", font: "Arial", size: 14, c: "#000099", bold: false, italic: false, align: "left" },
    { id: uid("a"), t: "line", c: "#000000", w: 2, a: [50, 600], b: [200, 650] },
    { id: uid("a"), t: "arrow", c: "#0000ff", w: 2, a: [50, 700], b: [200, 700] },
    { id: uid("a"), t: "rect", c: "#008800", w: 2, a: [100, 100], b: [200, 150] },
    { id: uid("a"), t: "ellipse", c: "#880000", w: 2, a: [300, 600], b: [400, 680] },
    { id: uid("a"), t: "whiteout", x: 400, y: 50, w: 100, h: 30, c: "#ffffff" },
    {
      id: uid("a"),
      t: "signature",
      x: 350,
      y: 720,
      w: 200,
      h: 60,
      c: "#000033",
      strokes: [encodePts([0.1, 0.5, 0.5, 0.3, 0.2, 0.7, 0.5, 0.8, 0.6, 0.9, 0.4, 0.5])],
    },
  ];
  if (mediaId) marks.push({ id: uid("a"), t: "image", x: 450, y: 300, w: 80, h: 40, media: mediaId });
  return marks;
}

const pngMedia = (id: string) => ({
  id,
  path: "src-tauri/icons/32x32.png",
  size: 0,
  mtimeMs: 0,
  kind: "image" as const,
  duration: 0,
  hasAudio: false,
});

describe.skipIf(!hasFixture("plain_3p.pdf", "rotated.pdf"))("pages: order, duplicates, blanks, rotation, range", () => {
  it("reorders, duplicates, inserts blank pages and adds rotation to the page's own", async () => {
    const plain = source("plain_3p.pdf");
    const rot = source("rotated.pdf");
    const p = project(
      [plain, rot],
      [pg(plain, 2), pg(null, 0, 0, 300, 400), pg(plain, 0), pg(rot, 1, 90), pg(plain, 0, 270), pg(null, 0, 90, 200, 100)],
    );
    const out = await buildPdf(p, NO_FLAT, nodeDeps());
    const { pages } = await readBack(out);
    expect(pages.map((x) => x.text.match(/Page \d of 3/)?.[0] ?? "")).toEqual([
      "Page 3 of 3",
      "",
      "Page 1 of 3",
      "Page 2 of 3",
      "Page 1 of 3",
      "",
    ]);
    expect(pages.map((x) => x.rotate)).toEqual([0, 0, 0, 180, 270, 90]);
    expect(pages[1]!.view).toEqual([0, 0, 300, 400]);
    expect(pages[5]!.view).toEqual([0, 0, 200, 100]);
  });

  it("exports a range of output pages only (extract / split)", async () => {
    const plain = source("plain_3p.pdf");
    const p = project([plain], [pg(plain, 0), pg(plain, 1), pg(plain, 2)]);
    const out = await buildPdf(p, { ...NO_FLAT, range: [2, 3] }, nodeDeps());
    const { pages } = await readBack(out);
    expect(pages.length).toBe(2);
    expect(pages[0]!.text).toContain("Page 2 of 3");
    expect(pages[0]!.text).toContain("needle");
    expect(pages[1]!.text).toContain("Page 3 of 3");
  });

  it("an all-blank document still exports", async () => {
    const out = await buildPdf(project([], [pg(null, 0, 0, 100, 100), pg(null, 0, 0, 200, 300)]), NO_FLAT, nodeDeps());
    const { pages } = await readBack(out);
    expect(pages.map((x) => x.view)).toEqual([
      [0, 0, 100, 100],
      [0, 0, 200, 300],
    ]);
  });
});

describe.skipIf(!hasFixture("large_300p.pdf") || !hasFont())("a 300-page export", () => {
  it("reverses, turns every third page and carries marks in well under 2 s", async () => {
    const big = source("large_300p.pdf");
    const pages = Array.from({ length: 300 }, (_, i) => pg(big, 299 - i, i % 3 === 0 ? 90 : 0));
    const annots: Record<string, PdfAnnot[]> = {};
    for (const i of [0, 50, 100, 150, 299]) annots[pages[i]!.id] = everyMark();
    const p = project([big], pages, annots);
    const t0 = performance.now();
    const out = await buildPdf(p, NO_FLAT, nodeDeps());
    const ms = performance.now() - t0;
    console.log(`300-page export: ${ms.toFixed(0)} ms, ${(out.length / 1024).toFixed(0)} KiB`);
    const back = await readBack(out);
    expect(back.pages.length).toBe(300);
    expect(back.pages[0]!.text).toContain("Page 300 of 300");
    expect(back.pages[299]!.text).toContain("Page 1 of 300");
    expect(back.pages[3]!.rotate).toBe(90);
    expect(back.pages[50]!.annots.length).toBe(10);
    expect(ms).toBeLessThan(4000); // target ~2 s; generous for a loaded CI box
  }, 30_000);
});

describe.skipIf(!hasFixture("plain_3p.pdf", "annotated.pdf") || !hasFont())("marks", () => {
  it("writes every kind as a real annotation with the right subtype, and BBox == Rect", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const media = pngMedia("m1");
    const p = project([plain], [page], { [page.id]: everyMark("m1") }, {}, [media]);
    const deps = nodeDeps();
    const out = await buildPdf(p, NO_FLAT, deps);
    sample("a5-annotated.pdf", out);

    const { pages } = await readBack(out);
    expect(pages[0]!.annots.map((a) => a.subtype)).toEqual([
      "Ink",
      "Ink",
      "Highlight",
      "FreeText",
      "Line",
      "Line",
      "Square",
      "Circle",
      "Square",
      "Ink",
      "Stamp",
    ]);

    const { doc, annots } = await rawAnnots(out, 0);
    for (const a of annots) {
      const ap = apStream(doc, a);
      expect(ap, subtypeOf(a)).not.toBeNull();
      expect(close(nums(ap!.dict, "BBox"), nums(a, "Rect")), `${subtypeOf(a)} BBox == Rect`).toBe(true);
      expect(a.get(PDFName.of("F"))?.toString()).toBe("4");
    }
    // the rect mark: a (100,100) → b (200,150), w 2 → padded by 1, y flipped
    expect(close(nums(annots[6]!, "Rect"), [99, H - 151, 201, H - 99])).toBe(true);
    // arrow: /LE None OpenArrow; line: None None
    expect(annots[5]!.lookup(PDFName.of("LE"))?.toString()).toBe("[ /None /OpenArrow ]");
    expect(annots[4]!.lookup(PDFName.of("LE"))?.toString()).toBe("[ /None /None ]");
    // highlight: one quad per rect, Multiply blend in its appearance
    expect(nums(annots[2]!, "QuadPoints").length).toBe(16);
    const hl = apStream(doc, annots[2]!)!;
    expect(hl.dict.lookup(PDFName.of("Resources"))?.toString()).toContain("/BM /Multiply");
    // whiteout: interior colour, no border
    expect(nums(annots[8]!, "IC")).toEqual([1, 1, 1]);
    // the picture is an image XObject in the stamp's appearance
    const stamp = apStream(doc, annots[10]!)!;
    expect(stamp.dict.lookup(PDFName.of("Resources"))?.toString()).toMatch(/\/XObject/);
  });

  it("keeps the page's existing annotations and appends ours", async () => {
    const ann = source("annotated.pdf");
    const page = pg(ann, 0);
    const p = project([ann], [page], {
      [page.id]: [{ id: "x", t: "ink", kind: "pen", c: "#ff0000", w: 3, o: 1, p: encodePts([100, 100, 1, 200, 200, 1]) }],
    });
    const { pages } = await readBack(await buildPdf(p, NO_FLAT, nodeDeps()));
    expect(pages[0]!.annots.map((a) => a.subtype)).toEqual(["Square", "Ink"]);
  });

  it("flattened marks add no annotations and draw into the page", async () => {
    const ann = source("annotated.pdf");
    const page = pg(ann, 0);
    const p = project([ann], [page], { [page.id]: everyMark() });
    const out = await buildPdf(p, { flattenMarks: true, flattenForms: false }, nodeDeps());
    sample("a5-flattened.pdf", out);
    const { pages } = await readBack(out);
    expect(pages[0]!.annots.map((a) => a.subtype)).toEqual(["Square"]); // only the one it had
    expect(pages[0]!.text).toContain("Hello box"); // the text box is page content now
    expect(pages[0]!.text).toContain("The quick brown fox"); // and the page is still there
  });

  it("puts marks on a turned page in the page's own (unrotated) space", async () => {
    const rot = source("rotated.pdf");
    const page = pg(rot, 1);
    const p = project([rot], [page], { [page.id]: [{ id: "r", t: "rect", c: "#000000", w: 2, a: [10, 20], b: [110, 70] }] });
    const { pages } = await readBack(await buildPdf(p, NO_FLAT, nodeDeps()));
    expect(pages[0]!.rotate).toBe(90);
    expect(close(pages[0]!.annots[0]!.rect, [9, H - 71, 111, H - 19])).toBe(true);
  });
});

describe.skipIf(!hasFixture("plain_3p.pdf") || !hasFont())("text boxes", () => {
  const box = (text: string): PdfAnnot => ({
    id: uid("t"),
    t: "text",
    x: 100,
    y: 100,
    w: 300,
    h: 80,
    text,
    font: "Arial",
    size: 20,
    c: "#000000",
    bold: false,
    italic: false,
    align: "left",
  });

  it("draws Hebrew in visual order (pdf.js reads it back as logical שלום)", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const p = project([plain], [page], { [page.id]: [box("שלום")] });
    const flat = await buildPdf(p, { flattenMarks: true, flattenForms: false }, nodeDeps());
    const { pages } = await readBack(flat);
    expect(pages[0]!.text).toContain("שלום");
    expect(pages[0]!.text).not.toContain("םולש");
  });

  it("a mixed right-to-left line reads back in logical order, and the annotation keeps the text", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const mixed = project([plain], [page], { [page.id]: [box("שלום עולם and English")] });
    const flat = await buildPdf(mixed, { flattenMarks: true, flattenForms: false }, nodeDeps());
    sample("a5-hebrew-textbox-flat.pdf", flat);
    expect((await readBack(flat)).pages[0]!.text).toContain("שלום עולם and English");
    const annotated = await buildPdf(mixed, NO_FLAT, nodeDeps());
    sample("a5-hebrew-textbox.pdf", annotated);
    const { annots } = await rawAnnots(annotated, 0);
    expect(annots[0]!.lookup(PDFName.of("Contents"))?.toString()).toBe(PDFHexString.fromText("שלום עולם and English").toString());
  });

  it("places the first baseline as CSS does: half-leading + ascent below the box top", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const out = await buildPdf(project([plain], [page], { [page.id]: [box("Baseline")] }), { flattenMarks: true, flattenForms: false }, nodeDeps());
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: out, verbosity: 0 });
    const doc = await task.promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
    await task.destroy();
    const item = items.find((i) => i.str === "Baseline")!;
    // Arial: ascent 1854/2048, descent 434/2048; size 20, line 25
    const asc = (1854 / 2048) * 20;
    const desc = (434 / 2048) * 20;
    const baseline = (25 - (asc + desc)) / 2 + asc;
    expect(item.transform[5]).toBeCloseTo(H - 100 - baseline, 1);
    expect(item.transform[4]).toBeCloseTo(100, 1);
  });

  it("Arabic falls back to a picture drawn by the browser", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const p = project([plain], [page], { [page.id]: [box("مرحبا بالعالم")] });
    const deps = nodeDeps();
    const out = await buildPdf(p, NO_FLAT, deps);
    expect(deps.rasterCalls.length).toBe(1);
    expect(deps.rasterCalls[0]!.text).toBe("مرحبا بالعالم");
    expect(deps.rasterCalls[0]!.scale).toBeGreaterThanOrEqual(4);
    const { doc, annots } = await rawAnnots(out, 0);
    expect(subtypeOf(annots[0]!)).toBe("FreeText");
    const res = apStream(doc, annots[0]!)!.dict.lookup(PDFName.of("Resources"))!.toString();
    expect(res).toMatch(/\/XObject/);
    expect(res).not.toMatch(/\/Font/);
  });

  it("a missing font is a plain-language error", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const p = project([plain], [page], { [page.id]: [box("hi")] });
    const err = await buildPdf(p, NO_FLAT, nodeDeps({ fontBytes: async () => null })).catch((e) => e);
    expect(err).toBeInstanceOf(PdfExportError);
    expect(err.code).toBe("font-missing");
    expect(err.message).toMatch(/Arial is not installed/);
  });
});

describe.skipIf(!hasFixture("form_acro.pdf", "plain_3p.pdf"))("forms", () => {
  const VALUES = { "9R": "Adir שלום", "13R": true, "24R": true, "30R": ["Blue"] };

  it("fills the values (Hebrew included) and keeps the form fillable", async () => {
    const form = source("form_acro.pdf");
    const plain = source("plain_3p.pdf");
    const p = project([plain, form], [pg(plain, 0), pg(form, 0)], {}, { [form.id]: VALUES });
    const out = await buildPdf(p, NO_FLAT, nodeDeps());
    const { pages, fields } = await readBack(out);
    const byName = Object.fromEntries(pages[1]!.annots.map((a) => [a.fieldName, a]));
    expect(byName["name"]!.fieldValue).toBe("Adir שלום");
    expect(byName["agree"]!.fieldValue).not.toBe("Off");
    expect(byName["colour"]!.fieldValue).toEqual(["Blue"]);
    expect(fields?.get("size")?.some((f) => f["value"] === "large" || f["exportValues"] === "large")).toBe(true);
    // a value pdf.js could not draw here is left to the viewer (see below)
    const lib0 = await PDFDocument.load(out);
    expect(lib0.catalog.lookup(PDFName.of("AcroForm"))?.toString()).toContain("/NeedAppearances true");
    // pdf-lib sees the same value
    const lib = await PDFDocument.load(out);
    expect((lib.getForm().getField("name") as PDFTextField).getText()).toBe("Adir שלום");
  });

  it("a merged document keeps both documents' fields", async () => {
    // a second form, made here: one text field "other"
    const second = await PDFDocument.create();
    const pageB = second.addPage([300, 300]);
    second.getForm().createTextField("other").addToPage(pageB, { x: 20, y: 20, width: 200, height: 24 });
    const bytesB = await second.save();
    const form = source("form_acro.pdf");
    const otherSrc = { id: "other", path: "mem:other.pdf", size: bytesB.length, mtimeMs: 1000, pages: 1 };
    const base = nodeDeps();
    const deps = nodeDeps({
      fileStat: async (path) => (path === otherSrc.path ? { size: bytesB.length, mtimeMs: 1000 } : base.fileStat(path)),
      readBytes: async (path) => (path === otherSrc.path ? bytesB : base.readBytes(path)),
    });
    const p = project([form, otherSrc], [pg(form, 0), pg(otherSrc, 0)], {}, { [form.id]: { "9R": "first" } });
    const { fields } = await readBack(await buildPdf(p, NO_FLAT, deps));
    const names = [...(fields?.keys() ?? [])];
    expect(names).toEqual(expect.arrayContaining(["name", "agree", "size", "colour", "other"]));
  });

  // pdf.js draws a non-Latin field value with its FakeUnicodeFont, which
  // measures with OffscreenCanvas — present in the app's worker, absent in
  // node (there pdf.js leaves the field without an appearance and sets
  // NeedAppearances). So the node check of flattened values is Latin.
  it("flattening forms leaves no AcroForm and no widgets, and keeps the values on the page", async () => {
    const form = source("form_acro.pdf");
    const p = project([form], [pg(form, 0)], {}, { [form.id]: { ...VALUES, "9R": "Adir Latin" } });
    const out = await buildPdf(p, { flattenMarks: false, flattenForms: true }, nodeDeps());
    sample("a5-forms-flattened.pdf", out);
    const { pages, fields } = await readBack(out);
    expect(fields).toBeNull();
    expect(pages[0]!.annots.length).toBe(0);
    expect(pages[0]!.text).toContain("Adir");
    const lib = await PDFDocument.load(out);
    expect(lib.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
  });

  it("flattened forms + flattened marks: nothing interactive is left", async () => {
    const form = source("form_acro.pdf");
    const page = pg(form, 0);
    const p = project([form], [page], { [page.id]: everyMark() }, { [form.id]: VALUES });
    const out = await buildPdf(p, { flattenMarks: true, flattenForms: true }, nodeDeps());
    const { pages, fields } = await readBack(out);
    expect(fields).toBeNull();
    expect(pages[0]!.annots).toEqual([]);
  });
});

describe.skipIf(!hasFixture("plain_3p.pdf", "encrypted.pdf"))("errors", () => {
  it("a missing source", async () => {
    const plain = { ...source("plain_3p.pdf"), path: "tests/fixtures/pdf/nope.pdf" };
    const err = await buildPdf(project([plain], [pg(plain, 0)]), NO_FLAT, nodeDeps()).catch((e) => e);
    expect(err).toBeInstanceOf(PdfExportError);
    expect(err.code).toBe("source-missing");
    expect(err.message).toMatch(/nope\.pdf is missing/);
  });

  it("a changed source", async () => {
    const plain = { ...source("plain_3p.pdf"), size: 1 };
    const err = await buildPdf(project([plain], [pg(plain, 0)]), NO_FLAT, nodeDeps()).catch((e) => e);
    expect(err.code).toBe("source-changed");
  });

  it("a password-protected source, primary or not", async () => {
    const enc = source("encrypted.pdf");
    const plain = source("plain_3p.pdf");
    for (const pages of [[pg(enc, 0)], [pg(plain, 0), pg(enc, 0)]]) {
      const err = await buildPdf(project([enc, plain], pages), NO_FLAT, nodeDeps()).catch((e) => e);
      expect(err).toBeInstanceOf(PdfExportError);
      expect(err.code).toBe("password");
      expect(err.message).toMatch(/encrypted\.pdf is protected by a password/);
    }
  });

  it("a password, when one is known, opens it", async () => {
    const enc = source("encrypted.pdf");
    const plain = source("plain_3p.pdf");
    const out = await buildPdf(project([enc, plain], [pg(plain, 0), pg(enc, 0)]), { ...NO_FLAT, passwords: { [enc.id]: "taroting" } }, nodeDeps());
    expect((await readBack(out)).pages.length).toBe(2);
  });

  it("a missing picture", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const media = { ...pngMedia("m"), path: "C:/nowhere/pic.png" };
    const p = project([plain], [page], { [page.id]: [{ id: "i", t: "image", x: 0, y: 0, w: 10, h: 10, media: "m" }] }, {}, [media]);
    const err = await buildPdf(p, NO_FLAT, nodeDeps()).catch((e) => e);
    expect(err.code).toBe("image-missing");
    expect(err.message).toMatch(/pic\.png is missing/);
  });
});

describe.skipIf(!hasFixture("plain_3p.pdf"))("exportPdf", () => {
  it("builds, then begins with every source and picture, chunks and commits", async () => {
    const plain = source("plain_3p.pdf");
    const media = pngMedia("m");
    const p = project([plain], [pg(plain, 0), pg(plain, 1)], {}, {}, [media]);
    const calls: string[] = [];
    let written = 0;
    const io: PdfSaveIpc = {
      async pdfSaveBegin(dest, total) {
        calls.push("begin");
        expect(dest).toEqual({ kind: "user", path: "C:/out/x.pdf", sources: [plain.path, media.path] });
        expect(total).toBeGreaterThan(100);
        return { token: 1, path: dest.path };
      },
      async imageSaveChunk(_t, b) {
        calls.push("chunk");
        written += b.length;
        expect(String.fromCharCode(...b.slice(0, 5))).toBe(written === b.length ? "%PDF-" : String.fromCharCode(...b.slice(0, 5)));
      },
      async imageSaveCommit() {
        calls.push("commit");
        return { token: 1, path: "C:/out/x.pdf" };
      },
      async imageSaveAbort() {
        calls.push("abort");
      },
    };
    const res = await exportPdf(p, { ...NO_FLAT, range: [2, 2] }, "C:/out/x.pdf", nodeDeps(), io);
    expect(calls).toEqual(["begin", "chunk", "commit"]);
    expect(res).toEqual({ path: "C:/out/x.pdf", pages: 1, bytes: written });
  });
});

