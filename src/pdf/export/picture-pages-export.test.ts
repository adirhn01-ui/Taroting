// Picture pages (0.9.5) in the exported PDF: a page picture (`bg`) is ALWAYS
// page content — first, under the page's other marks — whichever way the
// marks are written (annotations or drawn in); every other mark keeps its
// mode. Blank pages, so no PDF fixture is needed; the picture is a PNG in the
// repo.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { MediaRef, PdfAnnot } from "../../core/types";
import { PdfExportError, buildPdf } from "./export";
import { encodePts, hasFixture, nodeDeps, pg, project, readBack, source, uid } from "./testkit";

const media: MediaRef = {
  id: "m1",
  path: "src-tauri/icons/32x32.png",
  size: 0,
  mtimeMs: 0,
  kind: "image",
  duration: 0,
  hasAudio: false,
};

/** One page's /Contents streams, decoded, in order. */
async function contents(bytes: Uint8Array, i: number): Promise<{ doc: PDFDocument; streams: string[]; xobjects: PDFDict | null }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(i);
  const c = page.node.get(PDFName.of("Contents"));
  const refs: PDFRef[] = [];
  const arr = c instanceof PDFRef ? doc.context.lookup(c) : c;
  if (arr instanceof PDFArray) for (let k = 0; k < arr.size(); k++) refs.push(arr.get(k) as PDFRef);
  else if (c instanceof PDFRef) refs.push(c);
  const streams = refs.map((r) => {
    const s = doc.context.lookup(r) as PDFStream;
    const raw = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as unknown as { getContents(): Uint8Array }).getContents();
    return new TextDecoder().decode(raw);
  });
  const res = page.node.Resources();
  const xo = res?.lookup(PDFName.of("XObject"));
  return { doc, streams, xobjects: xo instanceof PDFDict ? xo : null };
}

/** The form XObject a `/Name Do` names on the page, and whether it paints an image XObject. */
function paintsImage(doc: PDFDocument, xobjects: PDFDict, name: string): boolean {
  const form = xobjects.lookup(PDFName.of(name));
  if (!(form instanceof PDFStream)) return false;
  const inner = form.dict.lookup(PDFName.of("Resources"));
  const xo = inner instanceof PDFDict ? inner.lookup(PDFName.of("XObject")) : null;
  if (!(xo instanceof PDFDict)) return false;
  return xo.values().some((v) => {
    const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
    return s instanceof PDFStream && s.dict.get(PDFName.of("Subtype"))?.toString() === "/Image";
  });
}

function pictureProject(extra: PdfAnnot[] = []) {
  const page = pg(null, 0, 0, 450, 300);
  const marks: PdfAnnot[] = [
    // listed AFTER another mark on purpose: drawing order is the flag's, not the list's
    ...extra,
    { id: uid("bg"), t: "image", x: 0, y: 0, w: 450, h: 300, media: "m1", bg: true },
  ];
  return { page, p: project([], [page], { [page.id]: marks }, {}, [media]) };
}

const ink: PdfAnnot = { id: "ink1", t: "ink", kind: "pen", c: "#ff0000", w: 3, o: 1, p: encodePts([100, 100, 1, 200, 150, 1]) };

describe("a page picture in the exported PDF", () => {
  for (const flattenMarks of [false, true]) {
    it(`is page content, first, under the rest — marks ${flattenMarks ? "drawn in" : "as annotations"}`, async () => {
      const { p } = pictureProject([ink]);
      const out = await buildPdf(p, { flattenMarks, flattenForms: false }, nodeDeps());
      const back = await readBack(out);
      expect(back.pages[0]!.view).toEqual([0, 0, 450, 300]);
      // never an annotation: only the ink is one, and only when marks are
      expect(back.pages[0]!.annots.map((a) => a.subtype)).toEqual(flattenMarks ? [] : ["Ink"]);
      const { doc, streams, xobjects } = await contents(out, 0);
      // the FIRST thing the page paints is the page picture, which paints an
      // image (drawn-in marks wrap what was there in q … Q and come after)
      const all = streams.join("\n");
      const first = /\/(\S+) Do/.exec(all);
      expect(first, all).not.toBeNull();
      expect(first![1]).toMatch(/^TrtPage/);
      expect(paintsImage(doc, xobjects!, first![1]!)).toBe(true);
      if (flattenMarks) expect(all.indexOf("TrtMark")).toBeGreaterThan(all.indexOf("TrtPage"));
      else expect(all).not.toContain("TrtMark");
    });
  }

  it.skipIf(!hasFixture("plain_3p.pdf"))("goes under a page's own content too (a page picture on a source page)", async () => {
    const plain = source("plain_3p.pdf");
    const page = pg(plain, 0);
    const p = project([plain], [page], { [page.id]: [{ id: "b", t: "image", x: 0, y: 0, w: 595, h: 842, media: "m1", bg: true }] }, {}, [media]);
    const out = await buildPdf(p, { flattenMarks: false, flattenForms: false }, nodeDeps());
    const { streams } = await contents(out, 0);
    // first the page picture, then the source page's own drawing
    expect(streams[0]).toMatch(/\/TrtPage\S* Do/);
    expect(streams.slice(1).join("\n")).not.toContain("TrtPage");
    expect(streams.length).toBeGreaterThan(1);
  });

  it("an ordinary picture mark stays an annotation (Stamp) beside it", async () => {
    const { p } = pictureProject([{ id: "pic", t: "image", x: 10, y: 10, w: 20, h: 20, media: "m1" }]);
    const back = await readBack(await buildPdf(p, { flattenMarks: false, flattenForms: false }, nodeDeps()));
    expect(back.pages[0]!.annots.map((a) => a.subtype)).toEqual(["Stamp"]);
  });

  // A4 sizing: the picture box is offset inside the page and is not square,
  // and the page is turned — so a box equal to the page, or a turn applied
  // twice (the page's /Rotate AND the drawing), would show here.
  const A4W = 595.28;
  const A4H = 841.89;
  const offsetBox = { x: 40, y: 120, w: 500, h: 300 };

  /** The page-picture form a page paints first: its /BBox and its own drawing. */
  function underlay(doc: PDFDocument, streams: string[], xobjects: PDFDict): { bbox: number[]; ops: string } {
    const name = /\/(TrtPage\S*) Do/.exec(streams.join("\n"))![1]!;
    const form = xobjects.lookup(PDFName.of(name)) as PDFStream;
    const bbox = (form.dict.lookup(PDFName.of("BBox")) as PDFArray).asArray().map((n) => Number(n.toString()));
    const raw = form instanceof PDFRawStream ? decodePDFRawStream(form).decode() : (form as unknown as { getContents(): Uint8Array }).getContents();
    void doc;
    return { bbox, ops: new TextDecoder().decode(raw) };
  }

  it("on a page turned 90°: the box keeps its place on the unturned page, the page carries the turn", async () => {
    const page = pg(null, 0, 90, A4W, A4H);
    const b = offsetBox;
    const p = project([], [page], { [page.id]: [{ id: uid("bg"), t: "image", ...b, media: "m1", bg: true }] }, {}, [media]);
    const out = await buildPdf(p, { flattenMarks: false, flattenForms: false }, nodeDeps());
    const { doc, streams, xobjects } = await contents(out, 0);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(0).getMediaBox()).toMatchObject({ x: 0, y: 0, width: A4W, height: A4H });
    // PDF user space is y up: top 120 → the box spans y 421.89..721.89
    const top = A4H - b.y;
    const { bbox, ops } = underlay(doc, streams, xobjects!);
    expect(bbox).toEqual([40, Math.round((top - b.h) * 1000) / 1000, 540, top]);
    // the image's unit square scaled to the box, upright inside it (the page's
    // /Rotate turns it on screen — never a second turn in the drawing)
    expect(ops).toContain(`500 0 0 300 40 ${Math.round((top - b.h) * 1000) / 1000} cm /Im0 Do`);
  });

  it("a page range holding a picture page exports it with its picture, first", async () => {
    const before = pg(null, 0, 0, 300, 300);
    const picPage = pg(null, 0, 0, A4W, A4H);
    const after = pg(null, 0, 0, 300, 300);
    const p = project([], [before, picPage, after], { [picPage.id]: [{ id: uid("bg"), t: "image", ...offsetBox, media: "m1", bg: true }] }, {}, [media]);
    const out = await buildPdf(p, { flattenMarks: false, flattenForms: false, range: [2, 2] }, nodeDeps());
    const back = await readBack(out);
    expect(back.pages.map((x) => x.view)).toEqual([[0, 0, A4W, A4H]]);
    const { doc, streams, xobjects } = await contents(out, 0);
    const first = /\/(\S+) Do/.exec(streams.join("\n"));
    expect(first![1]).toMatch(/^TrtPage/);
    expect(paintsImage(doc, xobjects!, first![1]!)).toBe(true);
    expect(underlay(doc, streams, xobjects!).bbox).toEqual([40, 421.89, 540, 721.89]);
  });
});

describe("a missing picture file", () => {
  const gone: MediaRef = { ...media, id: "m2", path: "C:\\nowhere\\scans\\scan-03.jpg" };
  const threePages = (marks: PdfAnnot[]) => {
    const pages = [pg(null, 0, 0, 300, 300), pg(null, 0, 0, 300, 300), pg(null, 0, 0, 300, 300)];
    return project([], pages, { [pages[2]!.id]: marks }, {}, [media, gone]);
  };
  const failure = async (p: ReturnType<typeof project>, range?: [number, number]): Promise<PdfExportError> => {
    const e = await buildPdf(p, { flattenMarks: false, flattenForms: false, ...(range ? { range } : {}) }, nodeDeps()).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PdfExportError);
    return e as PdfExportError;
  };

  it("on a picture page: names the page as the user counts it and the two remedies that exist", async () => {
    const p = threePages([{ id: uid("bg"), t: "image", x: 0, y: 0, w: 300, h: 300, media: "m2", bg: true }]);
    for (const range of [undefined, [3, 3] as [number, number]]) {
      const e = await failure(p, range);
      expect(e.code).toBe("image-missing");
      // the project's page number even when only page 3 is exported
      expect(e.message).toBe("Page 3's picture scan-03.jpg is missing. Relink it from the page's menu, put the file back where it was, or delete the page.");
      expect(e.path).toBe(gone.path);
    }
  });

  it("an ordinary picture mark keeps its message", async () => {
    const e = await failure(threePages([{ id: uid("pic"), t: "image", x: 10, y: 10, w: 20, h: 20, media: "m2" }]));
    expect(e.code).toBe("image-missing");
    expect(e.message).toBe("The picture scan-03.jpg is missing. Relink it or remove it from the page, then export again.");
  });
});
