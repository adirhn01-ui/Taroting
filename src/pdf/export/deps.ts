// Everything PDF export reaches outside itself, injectable so the whole
// pipeline runs in node tests. `appDeps()` is the desktop app's wiring:
// files and fonts through the asset protocol, pictures decoded and text
// rasterized by the WebView's own canvas.

import type { FontFamily } from "../../core/types";

/* ---------------- the slice of pdf.js export uses ---------------- */

export interface PdfjsExtractEntry {
  document: Uint8Array | null;
  password?: string;
  includePages: number[];
  pageIndices: number[];
}

export interface PdfjsDocLike {
  numPages: number;
  annotationStorage: { setValue(key: string, value: Record<string, unknown>): void };
  saveDocument(): Promise<Uint8Array>;
  extractPages(entries: PdfjsExtractEntry[]): Promise<Uint8Array | null>;
}

export interface PdfjsTaskLike {
  promise: Promise<PdfjsDocLike>;
  destroy(): Promise<void>;
}

export interface PdfjsLike {
  getDocument(src: { data: Uint8Array; password?: string; [k: string]: unknown }): PdfjsTaskLike;
}

/** A picture ready for pdf-lib: PNG or JPEG bytes. */
export interface EncodedImage {
  kind: "png" | "jpg";
  bytes: Uint8Array;
}

/** A text box the vector path cannot draw (Arabic needs shaping): drawn by a
 *  canvas at `scale` × its point size instead. */
export interface RasterTextSpec {
  text: string;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  /** points */
  size: number;
  color: string;
  align: "left" | "center" | "right";
  /** the box, points */
  w: number;
  h: number;
  /** canvas px per point */
  scale: number;
  /** line height in points */
  lineHeight: number;
}

export interface ExportDeps {
  pdfjs(): Promise<PdfjsLike>;
  /** extra getDocument options (worker-side font data, CSP-safe flags) */
  pdfjsOptions?: Record<string, unknown>;
  /** null when the file does not exist */
  fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  readBytes(path: string): Promise<Uint8Array>;
  /** the face's file bytes, or null when it is not installed */
  fontBytes(family: FontFamily, bold: boolean, italic: boolean): Promise<Uint8Array | null>;
  /** decode a picture pdf-lib cannot embed directly (WebP, BMP, a PNG with an
   *  orientation tag the WebView honours…) into PNG, UNTURNED */
  decodeImage(bytes: Uint8Array, mime: string): Promise<Uint8Array>;
  /** PNG of a text box drawn by the browser (Arabic fallback) */
  rasterizeText(spec: RasterTextSpec): Promise<Uint8Array>;
  now(): Date;
}

/* ---------------- the app's wiring ---------------- */

/** pdf.js through the app's one door (src/pdf/view/pdfjs.ts): its document
 *  params (font data, CMaps, no WASM) and its shared worker, held for as long
 *  as each document export opens is alive. */
async function appPdfjs(): Promise<PdfjsLike> {
  const { loadPdfjs, documentParams, sharedWorker } = await import("../view/pdfjs");
  const lib = await loadPdfjs();
  return {
    getDocument(src) {
      const worker = sharedWorker.acquire();
      let held = true;
      const release = (): void => {
        if (held) {
          held = false;
          sharedWorker.release();
        }
      };
      let task;
      try {
        task = lib.getDocument({ ...documentParams(), enableScripting: false, ...src, worker } as never);
      } catch (e) {
        release();
        throw e;
      }
      return {
        promise: task.promise as unknown as Promise<PdfjsDocLike>,
        async destroy() {
          try {
            await task.destroy();
          } finally {
            release();
          }
        },
      };
    },
  };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function canvasToPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return canvas.convertToBlob({ type: "image/png" }).then(async (b) => new Uint8Array(await b.arrayBuffer()));
}

/** The desktop app's dependencies. Imported lazily with the export chunk. */
export async function appDeps(): Promise<ExportDeps> {
  const { ipc, mediaUrl } = await import("../../core/ipc");
  return {
    pdfjs: appPdfjs,
    fileStat: (path) => ipc.fileStat(path),
    readBytes: (path) => fetchBytes(mediaUrl(path)),
    async fontBytes(family, bold, italic) {
      const path = await ipc.systemFontPath(family, bold, italic);
      return path ? fetchBytes(mediaUrl(path)) : null;
    },
    async decodeImage(bytes, mime) {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: "none" });
      try {
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        if (!g) throw new Error("no 2D canvas");
        g.drawImage(bmp, 0, 0);
        return await canvasToPng(c);
      } finally {
        bmp.close();
      }
    },
    async rasterizeText(spec) {
      const { layoutCanvasLines } = await import("./raster");
      return layoutCanvasLines(spec, canvasToPng);
    },
    now: () => new Date(),
  };
}
