// The PDF an image project exports, parsed back with pdf-lib: one page whose
// MediaBox is the shared picture-page layout, one image XObject at the
// exported pixel size, a JPEG below 100 and, at 100, pixels streamed in
// strips into a /FlateDecode image (+ a soft mask when anything is not
// opaque), and nothing that names the user.
//
// The JPEG is a frame header (pdf-lib reads only that and embeds the bytes as
// they are). The lossless pixels come from an injected strip reader (vitest
// runs in Node: no canvas) over a known picture whose every byte differs per
// channel, row and column, and the streams are inflated back with the
// engine's DecompressionStream and compared byte for byte.

import { describe, expect, it } from "vitest";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";
import { picturePageLayout } from "../../core/picture-page";
import { buildJpegPicturePdf, buildLosslessPicturePdf, LOSSLESS_STRIP_BYTES, losslessStripRows } from "./export-pdf";

/* ---------------- inputs ---------------- */

/** A baseline JPEG's frame header (SOI, SOF0, EOI): all pdf-lib reads. */
function jpegHeader(w: number, h: number): Blob {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 8, h >>> 8, h & 255, w >>> 8, w & 255, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
  return new Blob([bytes], { type: "image/jpeg" });
}

/* ---------------- reading the result ---------------- */

async function parse(pdf: Blob): Promise<{ doc: PDFDocument; bytes: Uint8Array; images: PDFRawStream[] }> {
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const images: PDFRawStream[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) images.push(obj);
  }
  return { doc, bytes, images };
}
const num = (d: PDFDict, key: string): number => (d.get(PDFName.of(key)) as PDFNumber).asNumber();

// 1600×900 at 50 % → 800×450 px → 600×337.5 pt: width and height differ, so a
// swapped axis cannot pass.
const PX_W = 800;
const PX_H = 450;

describe("buildJpegPicturePdf", () => {
  it("writes one page whose MediaBox is the picture-page layout, the picture filling it", async () => {
    const { doc, bytes } = await parse(await buildJpegPicturePdf(jpegHeader(PX_W, PX_H), PX_W, PX_H));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(doc.getPageCount()).toBe(1);
    const layout = picturePageLayout(PX_W, PX_H, "picture");
    expect([layout.pageW, layout.pageH]).toEqual([600, 337.5]);
    const box = doc.getPage(0).getMediaBox();
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 600, 337.5]);
    // …and the picture is drawn across all of it
    const raw = doc.context.lookup(doc.getPage(0).node.get(PDFName.of("Contents")));
    const streams = raw instanceof PDFArray ? raw.asArray().map((r) => doc.context.lookup(r)) : [raw];
    const ops = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st as PDFRawStream).decode())).join("\n");
    expect(ops).toMatch(/^600 0 0 337\.5 0 0 cm$/m);
  });

  it("below 100 embeds the JPEG as it is: one DCT image of the exported pixel size, no soft mask", async () => {
    const { images } = await parse(await buildJpegPicturePdf(jpegHeader(PX_W, PX_H), PX_W, PX_H));
    expect(images).toHaveLength(1);
    const d = images[0]!.dict;
    expect([num(d, "Width"), num(d, "Height")]).toEqual([PX_W, PX_H]);
    expect(d.get(PDFName.of("Filter"))).toBe(PDFName.of("DCTDecode"));
    expect(d.get(PDFName.of("SMask"))).toBeUndefined();
  });

  it("names nobody: no author, no dates; producer and creator say Taroting", async () => {
    const { doc } = await parse(await buildJpegPicturePdf(jpegHeader(PX_W, PX_H), PX_W, PX_H));
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
    expect(doc.getProducer()).toBe("Taroting");
    expect(doc.getCreator()).toBe("Taroting");
  });

  it("shrinks a picture too large for a PDF page to the layout's capped box", async () => {
    // 30000 px wide = 22500 pt, past the 14400 pt cap: drawn at the capped box
    const { doc } = await parse(await buildJpegPicturePdf(jpegHeader(30000, 300), 30000, 300));
    const layout = picturePageLayout(30000, 300, "picture");
    const box = doc.getPage(0).getMediaBox();
    expect([box.width, box.height]).toEqual([layout.pageW, layout.pageH]);
    expect(box.width).toBe(14400);
  });
});

/* ---------------- lossless: streamed strips ---------------- */

/** A `w` × `h` straight-RGBA picture where every channel of every pixel has
 *  its own value (a swapped channel, row or column cannot match); `opaque`
 *  sets every alpha to 255, else alphas vary and include 0 and 255. */
function picture(w: number, h: number, opaque: boolean): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = (x * 3 + y * 41 + 1) & 255;
      px[i + 1] = (x * 5 + y * 17 + 90) & 255;
      px[i + 2] = (x * 11 + y * 29 + 170) & 255;
      // column 0 fully clear, column 1 opaque, the rest graded
      px[i + 3] = opaque ? 255 : x === 0 ? 0 : x === 1 ? 255 : (x * 19 + y * 7) & 255;
    }
  }
  return px;
}

/** A strip reader over `px`, recording every call. */
function reader(px: Uint8ClampedArray, w: number, onCall?: (n: number) => void): { read: (y: number, rows: number) => Uint8ClampedArray; calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    read: (y, rows) => {
      calls.push([y, rows]);
      onCall?.(calls.length);
      return px.slice(y * w * 4, (y + rows) * w * 4);
    },
  };
}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate")));
  return new Uint8Array(await out.arrayBuffer());
}

const never = (): AbortSignal => new AbortController().signal;
// 13 × 7: width and height differ, and 7 rows in strips of 3 leave a short last strip.
const LW = 13;
const LH = 7;

describe("buildLosslessPicturePdf", () => {
  it("inflates back to exactly the source: RGB in the image, alpha in its /SMask", async () => {
    const src = picture(LW, LH, false);
    const r = reader(src, LW);
    const { doc, images } = await parse(await buildLosslessPicturePdf(r.read, LW, LH, { signal: never(), stripRows: 3 }));
    const main = images.find((s) => s.dict.has(PDFName.of("SMask")));
    expect(main, "the picture names a soft mask").toBeDefined();
    const d = main!.dict;
    expect([num(d, "Width"), num(d, "Height"), num(d, "BitsPerComponent")]).toEqual([LW, LH, 8]);
    expect(d.get(PDFName.of("ColorSpace"))).toBe(PDFName.of("DeviceRGB"));
    expect(d.get(PDFName.of("Filter"))).toBe(PDFName.of("FlateDecode"));
    expect(d.get(PDFName.of("Type"))).toBe(PDFName.of("XObject"));
    const rgb = await inflate(main!.contents);
    const wantRgb = new Uint8Array(LW * LH * 3);
    const wantA = new Uint8Array(LW * LH);
    for (let i = 0; i < LW * LH; i++) {
      wantRgb.set([src[i * 4]!, src[i * 4 + 1]!, src[i * 4 + 2]!], i * 3);
      wantA[i] = src[i * 4 + 3]!;
    }
    expect(Array.from(rgb)).toEqual(Array.from(wantRgb));

    const mask = doc.context.lookup(d.get(PDFName.of("SMask")) as PDFRef) as PDFRawStream;
    expect([num(mask.dict, "Width"), num(mask.dict, "Height"), num(mask.dict, "BitsPerComponent")]).toEqual([LW, LH, 8]);
    expect(mask.dict.get(PDFName.of("ColorSpace"))).toBe(PDFName.of("DeviceGray"));
    expect(mask.dict.get(PDFName.of("Filter"))).toBe(PDFName.of("FlateDecode"));
    expect(Array.from(await inflate(mask.contents))).toEqual(Array.from(wantA));
    // the fixture really is mixed: some clear, some opaque, some between
    expect(wantA.includes(0) && wantA.includes(255) && wantA.some((a) => a > 0 && a < 255)).toBe(true);
    expect(images).toHaveLength(2);
  });

  it("an all-opaque picture has no /SMask and no mask image", async () => {
    const src = picture(LW, LH, true);
    const { images } = await parse(await buildLosslessPicturePdf(reader(src, LW).read, LW, LH, { signal: never(), stripRows: 3 }));
    expect(images).toHaveLength(1);
    expect(images[0]!.dict.has(PDFName.of("SMask"))).toBe(false);
    expect((await inflate(images[0]!.contents)).length).toBe(LW * LH * 3);
  });

  it("one page whose box is the picture-page layout, the picture drawn across the layout's box", async () => {
    const { doc, bytes } = await parse(await buildLosslessPicturePdf(reader(picture(LW, LH, false), LW).read, LW, LH, { signal: never() }));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(doc.getPageCount()).toBe(1);
    const layout = picturePageLayout(LW, LH, "picture");
    const box = doc.getPage(0).getMediaBox();
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, layout.pageW, layout.pageH]);
    const raw = doc.context.lookup(doc.getPage(0).node.get(PDFName.of("Contents")));
    const streams = raw instanceof PDFArray ? raw.asArray().map((r) => doc.context.lookup(r)) : [raw];
    const ops = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st as PDFRawStream).decode())).join("\n");
    const y = layout.pageH - layout.y - layout.h;
    expect(ops).toContain(`${layout.w} 0 0 ${layout.h} ${layout.x} ${y} cm`);
    expect(ops).toMatch(/\/Image-\d+-\d+ Do|\/Image\S* Do/);
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getProducer()).toBe("Taroting");
    expect(doc.getCreator()).toBe("Taroting");
  });

  it("reads one strip at a time, top to bottom, the short last strip included, and reports progress per strip", async () => {
    const r = reader(picture(LW, LH, false), LW);
    const seen: number[] = [];
    let pixelsRead = 0;
    await buildLosslessPicturePdf(r.read, LW, LH, {
      signal: never(),
      stripRows: 3,
      onProgress: (x) => seen.push(x),
      onPixelsRead: () => (pixelsRead = r.calls.length),
    });
    expect(r.calls).toEqual([
      [0, 3],
      [3, 3],
      [6, 1],
    ]);
    expect(seen).toEqual([3 / 7, 6 / 7, 1]);
    // the canvas may be freed right after the LAST strip, never earlier
    expect(pixelsRead).toBe(3);
  });

  it("by default a strip holds at most LOSSLESS_STRIP_BYTES of RGBA", async () => {
    expect(losslessStripRows(1024)).toBe(1024);
    expect(losslessStripRows(16384)).toBe(64);
    expect(losslessStripRows(10_000_000)).toBe(1);
    const w = 2048;
    const h = 600;
    const r = reader(picture(w, h, true), w);
    await buildLosslessPicturePdf(r.read, w, h, { signal: never() });
    expect(r.calls).toEqual([
      [0, 512],
      [512, 88],
    ]);
    for (const [, rows] of r.calls) expect(rows * w * 4).toBeLessThanOrEqual(LOSSLESS_STRIP_BYTES);
  });

  it("hands the UI thread a macrotask turn between strips", async () => {
    let ticked = false;
    const tickedAt: boolean[] = [];
    setTimeout(() => (ticked = true), 0);
    const r = reader(picture(LW, LH, false), LW, () => tickedAt.push(ticked));
    await buildLosslessPicturePdf(r.read, LW, LH, { signal: never(), stripRows: 3 });
    expect(tickedAt).toEqual([false, true, true]);
  });

  it("a cancel mid-way rejects with an AbortError within one strip and builds nothing", async () => {
    const ac = new AbortController();
    let pixelsRead = false;
    const r = reader(picture(LW, LH, false), LW, (n) => {
      if (n === 2) ac.abort();
    });
    await expect(
      buildLosslessPicturePdf(r.read, LW, LH, { signal: ac.signal, stripRows: 3, onPixelsRead: () => (pixelsRead = true) }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(r.calls).toHaveLength(2);
    expect(pixelsRead).toBe(false);
  });
});
