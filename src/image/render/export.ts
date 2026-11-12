// Full-resolution image export on the main thread: an OffscreenCanvas,
// strip-wise adjustments that yield to the UI between strips, then
// convertToBlob. ffmpeg is never involved for image projects, and there is no
// Worker (the CSP forbids one), so every long step yields.
//
// It draws with the compositor's own primitives (render/composite.ts), one
// layer at a time: decode that layer's photo at the density the output needs,
// adjust it, draw it, close it — so the peak is the output + ONE source + one
// layer scratch, never every photo at once. A drawing layer's scratch covers
// only the box its strokes reach (see `openDrawingLayer`), not the output.

import type { ImageExportFormat, ImageExportPreset, MediaRef, ProjectFile } from "../../core/types";
import { RENDER_MAX_AREA, RENDER_MAX_SIDE, WEBP_MAX_SIDE } from "../../core/types";
import { buildAdjustPlan, isIdentityAdjust } from "../adjust/plan";
import { createScratch, type ReleasableScratch } from "../ink/paint";
import { layersOf, opacityOf, type Layer } from "../layers";
import {
  clearTarget,
  drawBackground,
  drawLayer,
  drawUnderlay,
  openDrawingLayer,
  textFontRequests,
  type ScaledView,
} from "./composite";
import { ensureFonts } from "../../fonts";
import type { RenderResources } from "./index";
import { ADJUST_STRIP_ROWS, adjustStrip, decodeStill, fetchPhoto, fitRenderLimits, workingWidth } from "./photos";

export interface ExportRenderOpts {
  /** "pdf" renders the picture as `pdfPictureFormat(quality)` and wraps it in
   *  a one-page PDF (the builder is fetched only then). */
  format: ImageExportFormat;
  /** 1..100 */
  quality: number;
  /** integers ≥1, ≤ RENDER limits, WebP ≤ WEBP_MAX_SIDE */
  outW: number;
  outH: number;
}

/** Photo files the caller already holds in memory, looked up before a render
 *  reads one through the asset protocol. */
export interface RenderSources {
  /** The compressed file behind a photo layer, or null to read it from disk.
   *  The open editor passes `(m) => res.blobFor(m)` (PreviewResources): its
   *  photos are already in memory, and reading each again is a copy through
   *  the asset handler for nothing. */
  blobFor?: (m: MediaRef) => Blob | null;
}

/** `renderThumbnail`'s options. */
export interface ThumbnailOpts extends RenderSources {
  /** Stops the render: it rejects with an AbortError and encodes nothing
   *  (a newer render of the same card has taken over). */
  signal?: AbortSignal;
}

/** MIME type per export format — also what `blob.type` must come back as. */
export const EXPORT_MIME: Readonly<Record<ImageExportFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** The picture a PDF page embeds: lossless at 100 ("png": no PNG is encoded,
 *  the canvas's pixels are deflated in strips with the alpha as a soft mask;
 *  a PDF page is white underneath), else a JPEG at that quality — flattened
 *  onto white exactly as a JPEG export is. */
export function pdfPictureFormat(quality: number): "png" | "jpeg" {
  return Number.isFinite(quality) && Math.round(quality) >= 100 ? "png" : "jpeg";
}

/** The PDF builder (pdf-lib), fetched on the first PDF export only: nothing
 *  else in the image editor loads it. */
function loadPdfBuilder(): Promise<typeof import("./export-pdf")> {
  return import("./export-pdf");
}

/** Largest output that fits Chromium's canvas limits at the canvas aspect. */
export function maxRenderSize(w: number, h: number): { w: number; h: number; reduced: boolean } {
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  return fitRenderLimits(cw, ch);
}

/** The output size a preset asks for: a percentage of the canvas (rounded,
 *  at least 1 px a side), or an explicit size (whole px, ≥ 1). */
export function outputSize(size: ImageExportPreset["size"], canvasW: number, canvasH: number): { w: number; h: number } {
  if (typeof size === "object") {
    return { w: Math.max(1, Math.round(size.w)), h: Math.max(1, Math.round(size.h)) };
  }
  return {
    w: Math.max(1, Math.round((canvasW * size) / 100)),
    h: Math.max(1, Math.round((canvasH * size) / 100)),
  };
}

/** WebP's bitstream stores each side in 14 bits. */
export function webpFits(w: number, h: number): boolean {
  return w <= WEBP_MAX_SIDE && h <= WEBP_MAX_SIDE;
}

/** convertToBlob's quality for a 1..100 preset. PNG takes none; WebP at 100
 *  becomes exactly 1.0, which Chromium encodes LOSSLESSLY (VP8L — measured on
 *  WebView2 152; the chunk sits after VP8X and an ICC profile, past the first
 *  few dozen bytes, which is what once made it look lossy). */
export function encodeQuality(format: ImageExportFormat, quality: number): number | undefined {
  if (format === "png") return undefined;
  const q = Math.min(100, Math.max(1, Math.round(Number.isFinite(quality) ? quality : 92)));
  return q / 100;
}

/** What goes under the layers: JPEG has no alpha, so a transparent image
 *  is flattened onto white (the viewer's expectation), not onto black. */
export function exportUnderlay(format: ImageExportFormat, background: string | undefined): "white" | "none" {
  const transparent = background === undefined || background === "transparent";
  return format === "jpeg" && transparent ? "white" : "none";
}

function abortError(): DOMException {
  return new DOMException("The export was canceled.", "AbortError");
}

/** Hand the UI thread a turn: `scheduler.yield()` where the engine has it (it
 *  keeps this task's priority), else a macrotask. */
export function yieldToUi(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s && typeof s.yield === "function") return s.yield();
  return new Promise((r) => setTimeout(r, 0));
}

/** `p`, or settled as soon as `signal` aborts, whichever comes first: a
 *  cancel never waits on a slow font load. */
function untilAborted(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done);
    p.then(done, (e: unknown) => {
      signal.removeEventListener("abort", done);
      reject(e);
    });
  });
}

/** One photo layer's pixels, prepared for export: decoded at the density the
 *  output needs, adjusted in yielding strips. Caller closes it. Null only
 *  when the file is missing and `skipMissing` says to draw the rest anyway
 *  (a Home thumbnail); an export or a copy names the file and fails. The file
 *  comes from `blobFor` when the caller holds it, else from disk. */
async function preparePhoto(
  l: Layer,
  needScale: number,
  signal: AbortSignal,
  onStrip: (ratio: number) => void,
  skipMissing: boolean,
  blobFor: RenderSources["blobFor"],
): Promise<{ source: CanvasImageSource; release(): void } | null> {
  const blob = blobFor?.(l.media) ?? (await fetchPhoto(l.media.path));
  if (signal.aborted) throw abortError();
  if (!blob) {
    if (skipMissing) return null;
    throw new Error(`Couldn't read "${l.name || l.media.path}". Relink it and try again.`);
  }

  // Decode straight at the size the output needs when the photo's recorded
  // size says it is smaller than the file (a thumbnail of a 48 MP photo never
  // holds 192 MB); otherwise at full size, with the canvas-limit retry the
  // preview uses. Either way the result is drawn INTO the recorded box.
  const rw = l.media.width;
  const rh = l.media.height;
  const recorded = typeof rw === "number" && typeof rh === "number" && rw > 0 && rh > 0 && Number.isFinite(rw) && Number.isFinite(rh);
  let bmp: ImageBitmap | null = null;
  const want = recorded ? workingWidth(rw, needScale) : 0;
  if (recorded && want < rw) {
    // A photo recorded past the canvas limits, enlarged by its layer scale,
    // can ask for a size the engine refuses: retry fitted to the limits, and
    // failing that take the full-decode path below. The raw DOMException
    // never becomes the export's error message.
    const wantH = Math.max(1, Math.round((want * rh) / rw));
    try {
      bmp = await decodeStill(blob, { w: want, h: wantH });
    } catch {
      // A cancel is a cancel, not a reason to spend another decode.
      if (signal.aborted) throw abortError();
      const fit = fitRenderLimits(want, wantH);
      if (fit.reduced) {
        try {
          bmp = await decodeStill(blob, fit);
        } catch {
          bmp = null;
        }
      }
    }
    if (signal.aborted) {
      bmp?.close();
      throw abortError();
    }
  }
  if (!bmp) {
    const undecodable = (): Error => new Error(`Couldn't decode "${l.name || l.media.path}".`);
    try {
      bmp = await decodeStill(blob);
    } catch {
      if (signal.aborted) throw abortError();
      if (!recorded) throw undecodable();
      const fit = fitRenderLimits(rw, rh);
      try {
        bmp = await decodeStill(blob, fit.reduced ? fit : { w: Math.ceil(rw / 2), h: Math.ceil(rh / 2) });
      } catch {
        throw undecodable();
      }
    }
  }
  if (signal.aborted) {
    bmp.close();
    throw abortError();
  }

  const adjust = l.clip.adjust;
  if (adjust === undefined || isIdentityAdjust(adjust)) {
    const b = bmp;
    return { source: b, release: () => b.close() };
  }

  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) {
    bmp.close();
    throw new Error("Couldn't prepare the image for export.");
  }
  c.drawImage(bmp, 0, 0);
  const w = bmp.width;
  const h = bmp.height;
  bmp.close();
  const plan = buildAdjustPlan(adjust);
  try {
    for (let y = 0; y < h; y += ADJUST_STRIP_ROWS) {
      adjustStrip(c, w, y, Math.min(ADJUST_STRIP_ROWS, h - y), plan);
      onStrip(Math.min(1, (y + ADJUST_STRIP_ROWS) / h));
      await yieldToUi();
      if (signal.aborted) throw abortError();
    }
  } catch (e) {
    canvas.width = 0;
    throw e;
  }
  return {
    source: canvas,
    release: () => {
      canvas.width = 0;
    },
  };
}

/** Full-resolution render on the main thread (OffscreenCanvas), strip-wise
 *  adjustments with a yield between strips, then convertToBlob. Rejects on
 *  abort; verifies blob.type. `sources.blobFor` hands over photo files the
 *  caller already holds; any it does not hold are read from disk. */
export async function renderImageExport(
  doc: ProjectFile,
  opts: ExportRenderOpts,
  signal: AbortSignal,
  onProgress: (ratio: number) => void,
  sources?: RenderSources,
): Promise<Blob> {
  if (opts.format !== "pdf") return render(doc, opts, signal, onProgress, false, sources?.blobFor);
  const outW = Math.round(opts.outW);
  const outH = Math.round(opts.outH);
  if (pdfPictureFormat(opts.quality) === "png") {
    // Lossless: no PNG at all. The page is built straight from the rendered
    // canvas, read in bounded strips that are deflated as they come (see
    // export-pdf.ts), so the raw picture is never held twice and the UI
    // thread gets a turn every strip. The builder is fetched BEFORE the render
    // so the canvas is never held across the import; the canvas is freed the
    // moment its last strip is read.
    const { buildLosslessPicturePdf } = await loadPdfBuilder();
    if (signal.aborted) throw abortError();
    return render(doc, { ...opts, format: "png" }, signal, onProgress, false, sources?.blobFor, {
      share: LOSSLESS_PDF_SHARE,
      encode: (canvas, ctx, onEncode) =>
        buildLosslessPicturePdf((y, rows) => ctx.getImageData(0, y, outW, rows).data, outW, outH, {
          signal,
          onProgress: onEncode,
          onPixelsRead: () => {
            canvas.width = 0;
            canvas.height = 0;
          },
        }),
    });
  }
  // Below 100: a JPEG first (its canvas freed before the page is built), then
  // one page around it, sized by the shared picture-page rule.
  const PICTURE_SHARE = 0.95;
  const blob = await render(doc, { ...opts, format: "jpeg" }, signal, (r) => onProgress(r * PICTURE_SHARE), false, sources?.blobFor);
  const { buildJpegPicturePdf } = await loadPdfBuilder();
  if (signal.aborted) throw abortError();
  const pdf = await buildJpegPicturePdf(blob, outW, outH);
  if (signal.aborted) throw abortError();
  onProgress(1);
  return pdf;
}

/** The share of a lossless PDF export's progress bar the strip deflate takes
 *  (the layers take the rest): on a large picture it is the longest step. */
export const LOSSLESS_PDF_SHARE = 0.5;

/** How `render` turns the finished canvas into the file, when not by
 *  convertToBlob: `encode` gets the canvas, its context and a 0..1 progress
 *  callback mapped onto the last `share` of the bar. */
interface RenderEncoder {
  share: number;
  encode(canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D, onProgress: (ratio: number) => void): Promise<Blob>;
}

async function render(
  doc: ProjectFile,
  opts: ExportRenderOpts,
  signal: AbortSignal,
  onProgress: (ratio: number) => void,
  skipMissing: boolean,
  blobFor: RenderSources["blobFor"],
  encoder?: RenderEncoder,
): Promise<Blob> {
  const outW = Math.round(opts.outW);
  const outH = Math.round(opts.outH);
  if (!(outW >= 1 && outH >= 1) || outW > RENDER_MAX_SIDE || outH > RENDER_MAX_SIDE || outW * outH > RENDER_MAX_AREA) {
    throw new Error(`An image of ${outW} × ${outH} can't be rendered here.`);
  }
  if (opts.format === "webp" && !webpFits(outW, outH)) {
    throw new Error(`WebP can't be larger than ${WEBP_MAX_SIDE} px on a side.`);
  }
  if (signal.aborted) throw abortError();

  // What is drawn, by the preview's own opacity rule: a crafted non-finite
  // opacity draws at 1 in both, never shown on screen yet missing from the file.
  const visible = layersOf(doc).filter((l) => !l.hidden && opacityOf(l) > 0);

  // The one font barrier for export, Copy image and the Home card: canvas text
  // does not update by itself, so every non-legacy font a visible text layer
  // uses is made ready (or known missing, which draws its legacy font) before
  // the first layer is drawn. A project that uses only the six legacy fonts
  // asks nothing (I1). A failure to load is not a failure to render: that
  // text draws with its legacy font, as a missing font does.
  const reqs = textFontRequests(visible);
  if (reqs.length > 0) {
    try {
      await untilAborted(ensureFonts(reqs), signal);
    } catch (e) {
      console.warn("Fonts for the image could not be loaded; drawing with the fallback", e);
    }
    if (signal.aborted) throw abortError();
  }

  const W = doc.timeline.width;
  const H = doc.timeline.height;
  const view: ScaledView = { zoom: outW / W, zoomY: outH / H, panX: 0, panY: 0 };
  const canvas = new OffscreenCanvas(outW, outH);
  /** this run's own drawing-layer scratch, made for the first drawing layer
   *  with ink to paint; `openDrawingLayer` grows it to each layer's stroke box.
   *  Typed through the initializer: it is assigned inside a callback, which
   *  the compiler's narrowing does not follow. */
  let scratch = null as OffscreenCanvas | null;
  /** this run's own pencil scratch (see `openDrawingLayer`), likewise */
  let ink: ReleasableScratch | null = null;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't create an image of this size — try a smaller size.");
    clearTarget(ctx, view);
    drawUnderlay(ctx, doc, view, exportUnderlay(opts.format, doc.image?.background));
    drawBackground(ctx, doc, view);

    const layers = visible.reverse(); // bottom → top
    const total = Math.max(1, layers.length);
    const LAYERS_SHARE = encoder ? 1 - encoder.share : 0.9;
    const report = (done: number, within: number): void => onProgress(((done + within) / total) * LAYERS_SHARE);
    report(0, 0);

    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]!;
      const g = l.media.generator;
      if (g === undefined) {
        const k = Number.isFinite(l.transform.scale) && l.transform.scale > 0 ? l.transform.scale : 1;
        const prepared = await preparePhoto(l, k * Math.max(view.zoom, view.zoomY ?? view.zoom), signal, (r) => report(i, r), skipMissing, blobFor);
        if (prepared === null) {
          report(i + 1, 0);
          continue;
        }
        try {
          const one: RenderResources = { photo: () => prepared.source, drawingRaster: () => null };
          drawLayer(ctx, doc, l, one, view);
        } finally {
          prepared.release();
        }
      } else if (g.type === "drawing") {
        ink ??= createScratch();
        const layer = openDrawingLayer(ctx, doc, l, view, () => (scratch ??= new OffscreenCanvas(1, 1)), ink);
        if (layer) {
          for (let c = 0; c < layer.chunkCount; c++) {
            layer.paint(c, c + 1);
            report(i, (c + 1) / layer.chunkCount);
            await yieldToUi();
            if (signal.aborted) throw abortError();
          }
          layer.close();
        }
      } else {
        const none: RenderResources = { photo: () => null, drawingRaster: () => null };
        drawLayer(ctx, doc, l, none, view);
      }
      report(i + 1, 0);
      if (signal.aborted) throw abortError();
    }
    // The drawing scratches can still be large (a drawing across the whole
    // output); give them back before the encoder needs its own buffer.
    if (scratch) {
      scratch.width = 0;
      scratch = null;
    }
    if (ink) {
      ink.release();
      ink = null;
    }
    await yieldToUi();
    if (signal.aborted) throw abortError();

    if (encoder) {
      const out = await encoder.encode(canvas, ctx, (r) => onProgress(LAYERS_SHARE + Math.min(1, Math.max(0, r)) * encoder.share));
      if (signal.aborted) throw abortError();
      onProgress(1);
      return out;
    }
    const type = EXPORT_MIME[opts.format];
    const quality = encodeQuality(opts.format, opts.quality);
    const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    if (signal.aborted) throw abortError();
    // An engine that cannot encode a type silently hands back a PNG instead.
    if (blob.type !== type || blob.size <= 0) throw new Error("This format could not be encoded.");
    onProgress(1);
    return blob;
  } finally {
    if (scratch) scratch.width = 0;
    ink?.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Longest side of a Home card thumbnail. */
export const THUMB_MAX_SIDE = 320;

/** The thumbnail size for a W×H canvas: longest side ≤ 320, never upscaled. */
export function thumbnailSize(w: number, h: number): { w: number; h: number } {
  const s = Math.min(1, THUMB_MAX_SIDE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** ≤320 px JPEG q0.85 for the Home card, composited over white where the
 *  image is transparent (the same flattening a JPEG export gets). A photo
 *  whose file is missing is left out rather than failing the whole card: one
 *  offline photo must not blank a project's thumbnail. `opts.signal` stops it
 *  (rejecting with an AbortError); `opts.blobFor` as for `renderImageExport`. */
export function renderThumbnail(doc: ProjectFile, opts?: ThumbnailOpts): Promise<Blob> {
  const { w, h } = thumbnailSize(doc.timeline.width, doc.timeline.height);
  const signal = opts?.signal ?? new AbortController().signal;
  return render(doc, { format: "jpeg", quality: 85, outW: w, outH: h }, signal, () => {}, true, opts?.blobFor);
}
