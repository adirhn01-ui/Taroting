// An image project exported as a PDF: ONE page holding the rendered picture.
//
// Reached only through the dynamic import in render/export.ts, so pdf-lib is
// fetched the first time a PDF export runs and never otherwise (the image
// chunk boundary test pins that). The page comes from the shared
// picture-page rule (core/picture-page.ts), the same one every other way a
// picture becomes a PDF page uses, so the same picture always makes the same
// page.
//
// Two ways in:
// - below 100 the picture is a JPEG, embedded as it is (pdf-lib reads only
//   its frame header), never re-encoded;
// - at 100 ("Lossless") the pixels are STREAMED out of the rendered canvas in
//   bounded strips, split into RGB and alpha and deflated by the engine's own
//   CompressionStream, yielding between strips. Nothing ever holds the whole
//   picture raw (pdf-lib's embedPng would decode a whole PNG to RGBA in
//   JavaScript, split it and deflate it again, synchronously, on the UI
//   thread: seconds of frozen window and gigabytes of copies on a large
//   export). The image XObject and its soft mask are written as raw streams.
//
// Nothing in the file names the user or the machine: no author, no title, no
// dates; producer and creator say "Taroting".

import { concatTransformationMatrix, drawObject, PDFDocument, popGraphicsState, pushGraphicsState, type PDFPage, type PDFRef } from "pdf-lib";
import { picturePageLayout } from "../../core/picture-page";

/** A new document that names nobody. updateMetadata false: pdf-lib would
 *  otherwise stamp its own producer and the creation / modification dates. */
async function newDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer("Taroting");
  doc.setCreator("Taroting");
  return doc;
}

/** One page of the picture-page layout for `pxW` × `pxH` pixels. */
function layoutPage(doc: PDFDocument, pxW: number, pxH: number): { page: PDFPage; x: number; y: number; w: number; h: number } {
  const box = picturePageLayout(pxW, pxH, "picture");
  const page = doc.addPage([box.pageW, box.pageH]);
  // The layout is y-down from the top-left; PDF user space is y-up.
  return { page, x: box.x, y: box.pageH - box.y - box.h, w: box.w, h: box.h };
}

async function finish(doc: PDFDocument): Promise<Blob> {
  const out = await doc.save();
  return new Blob([out as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}

/** A JPEG of `pxW` × `pxH` pixels as a one-page PDF; the bytes are embedded
 *  as they are. */
export async function buildJpegPicturePdf(jpeg: Blob, pxW: number, pxH: number): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const doc = await newDoc();
  const image = await doc.embedJpg(bytes);
  const at = layoutPage(doc, pxW, pxH);
  at.page.drawImage(image, { x: at.x, y: at.y, width: at.w, height: at.h });
  return finish(doc);
}

/* ---------------- lossless: streamed strips ---------------- */

/** Raw RGBA bytes one strip may hold. 4 MiB: big enough that the per-strip
 *  overhead (one canvas readback, two stream writes, one UI-thread yield) is
 *  small next to the work, small enough that a strip's split + deflate stays
 *  well inside one frame budget's order of magnitude and the peak is a few
 *  MB however large the picture is. */
export const LOSSLESS_STRIP_BYTES = 4 * 1024 * 1024;

/** Rows per strip for a picture `w` px wide: as many as fit
 *  `LOSSLESS_STRIP_BYTES` of RGBA, at least one. */
export function losslessStripRows(w: number, budget: number = LOSSLESS_STRIP_BYTES): number {
  return Math.max(1, Math.floor(budget / (Math.max(1, w) * 4)));
}

/** `rows` rows of the picture starting at row `y`, as straight
 *  (non-premultiplied) RGBA, `w * rows * 4` bytes — a canvas 2D getImageData. */
export type PixelStripReader = (y: number, rows: number) => Uint8ClampedArray;

export interface LosslessPdfOpts {
  signal: AbortSignal;
  /** 0..1 as strips are read and deflated */
  onProgress?: (ratio: number) => void;
  /** Called once, right after the LAST strip was read: the caller frees its
   *  canvas here, before the deflate finishes and the page is built. */
  onPixelsRead?: () => void;
  /** Rows per strip; defaults to `losslessStripRows(pxW)`. */
  stripRows?: number;
}

function abortError(): DOMException {
  return new DOMException("The export was canceled.", "AbortError");
}

/** A turn for the UI thread: `scheduler.yield()` where the engine has it,
 *  else a macrotask (the same rule as render/export.ts's, kept here so this
 *  module imports nothing from the image chunk). */
function yieldToUi(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s && typeof s.yield === "function") return s.yield();
  return new Promise((r) => setTimeout(r, 0));
}

/** A zlib ("deflate") stream fed chunk by chunk, its output collected as it
 *  comes (read concurrently, so the writer never stalls on backpressure).
 *  The zlib wrapper is exactly what PDF's /FlateDecode expects. */
class Deflater {
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly collected: Promise<Uint8Array>;
  constructor() {
    const cs = new CompressionStream("deflate");
    this.writer = cs.writable.getWriter();
    this.collected = collect(cs.readable);
    // A rejection seen only through `abort` must not surface as unhandled.
    this.collected.catch(() => {});
  }
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.writer.write(chunk);
  }
  async close(): Promise<Uint8Array> {
    await this.writer.close();
    return this.collected;
  }
  abort(): void {
    this.writer.abort().catch(() => {});
  }
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The picture of `pxW` × `pxH` pixels, read strip by strip through `read`,
 *  as a one-page PDF with a lossless /FlateDecode DeviceRGB image and, when
 *  any pixel is not fully opaque, a DeviceGray /SMask (the page is white
 *  underneath). The reader is asked for one strip at a time, top to bottom;
 *  the signal is checked every strip and a cancel rejects with an AbortError
 *  (nothing is returned, so nothing is written).
 *
 *  Straight alpha: a canvas 2D getImageData returns NON-premultiplied RGBA,
 *  which is what a PDF image + SMask means. A fully transparent pixel may come
 *  back with RGB 0 (the canvas stores it premultiplied); that colour is
 *  invisible under its zero mask. */
export async function buildLosslessPicturePdf(read: PixelStripReader, pxW: number, pxH: number, opts: LosslessPdfOpts): Promise<Blob> {
  const { signal } = opts;
  const w = Math.round(pxW);
  const h = Math.round(pxH);
  if (!(w >= 1 && h >= 1)) throw new Error(`An image of ${w} × ${h} can't be exported.`);
  const rowsPer = Math.max(1, Math.floor(opts.stripRows ?? losslessStripRows(w)));
  if (signal.aborted) throw abortError();

  const rgb = new Deflater();
  const alpha = new Deflater();
  let translucent = false;
  let rgbBytes: Uint8Array;
  let alphaBytes: Uint8Array;
  try {
    for (let y = 0; y < h; y += rowsPer) {
      const rows = Math.min(rowsPer, h - y);
      const px = read(y, rows);
      const n = w * rows;
      if (px.length < n * 4) throw new Error("The picture's pixels could not be read.");
      const c = new Uint8Array(n * 3);
      const a = new Uint8Array(n);
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
        c[k] = px[j]!;
        c[k + 1] = px[j + 1]!;
        c[k + 2] = px[j + 2]!;
        const v = px[j + 3]!;
        a[i] = v;
        if (v !== 255) translucent = true;
      }
      if (y + rows >= h) opts.onPixelsRead?.();
      await rgb.write(c);
      await alpha.write(a);
      opts.onProgress?.((y + rows) / h);
      await yieldToUi();
      if (signal.aborted) throw abortError();
    }
    rgbBytes = await rgb.close();
    alphaBytes = await alpha.close();
  } catch (e) {
    rgb.abort();
    alpha.abort();
    throw e;
  }
  if (signal.aborted) throw abortError();

  const doc = await newDoc();
  const ctx = doc.context;
  const image: Record<string, unknown> = {
    Type: "XObject",
    Subtype: "Image",
    Width: w,
    Height: h,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
  };
  if (translucent) {
    const mask = ctx.stream(alphaBytes, {
      Type: "XObject",
      Subtype: "Image",
      Width: w,
      Height: h,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
      Filter: "FlateDecode",
    });
    image.SMask = ctx.register(mask);
  }
  const ref: PDFRef = ctx.register(ctx.stream(rgbBytes, image as Parameters<typeof ctx.stream>[1]));
  const at = layoutPage(doc, w, h);
  const name = at.page.node.newXObject("Image", ref);
  at.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(at.w, 0, 0, at.h, at.x, at.y), drawObject(name), popGraphicsState());
  if (signal.aborted) throw abortError();
  return finish(doc);
}
