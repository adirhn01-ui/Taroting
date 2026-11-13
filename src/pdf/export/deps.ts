// Everything PDF export reaches outside itself, injectable so the whole
// pipeline runs in node tests. `appDeps()` is the desktop app's wiring:
// files and fonts through the asset protocol, pictures decoded and text
// rasterized by the WebView's own canvas.

import { ipc, mediaUrl } from "../../core/ipc";
import type { FontFamily, FontId, FontRequest, ResolvedFont } from "../../core/types";

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
  /** `info.EncryptFilterName` is set when the file is encrypted */
  getMetadata(): Promise<{ info: unknown }>;
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
  /** a non-legacy font that resolved on this PC (absent: `font`, as 0.9.3);
   *  `bold` / `italic` are then the face it resolved */
  fontId?: FontId;
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
  /** a box with style runs (0.9.4) only: its pieces in order, covering
   *  `text` without gaps; each drawn in its own face, size and colour
   *  (`fontId`, `bold`, `italic` as for the box itself) */
  runs?: RasterTextRun[];
}

/** One piece of a raster text box with style runs: `text[s, e)`. */
export interface RasterTextRun {
  s: number;
  e: number;
  font: FontFamily;
  fontId?: FontId;
  bold: boolean;
  italic: boolean;
  /** points */
  size: number;
  color: string;
}

/** One text style at one size, as `fontBox` measures it: the style's font
 *  (`fontId` absent = the legacy font) and its own bold / italic, NOT the
 *  face it resolved, exactly as the editor styles a piece on screen. */
export interface FontBoxSpec {
  font: FontFamily;
  fontId?: FontId;
  bold: boolean;
  italic: boolean;
  /** points */
  size: number;
}

export interface ExportDeps {
  pdfjs(): Promise<PdfjsLike>;
  /** extra getDocument options (worker-side font data, CSP-safe flags) */
  pdfjsOptions?: Record<string, unknown>;
  /** null when the file does not exist */
  fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  readBytes(path: string): Promise<Uint8Array>;
  /** the face's file bytes, or null when it is not installed (the six
   *  legacy fonts only: `system_font_path`) */
  fontBytes(family: FontFamily, bold: boolean, italic: boolean): Promise<Uint8Array | null>;
  /** non-legacy fonts (`fonts_resolve`): one answer per request, in order;
   *  the bytes are then read with `readBytes(path)`. Never asked for a mark
   *  without a `fontId` (I1). */
  resolveFonts(reqs: FontRequest[]): Promise<ResolvedFont[]>;
  /** decode a picture pdf-lib cannot embed directly (WebP, BMP, a PNG with an
   *  orientation tag the WebView honours…) into PNG, UNTURNED */
  decodeImage(bytes: Uint8Array, mime: string): Promise<Uint8Array>;
  /** PNG of a text box drawn by the browser (Arabic fallback) */
  rasterizeText(spec: RasterTextSpec): Promise<Uint8Array>;
  /** The font box (ascent and descent in points, both positive) a row of a
   *  text box with style runs is laid out with: what the editor reads for the
   *  same style on screen (canvas fontBoundingBoxAscent / Descent of the same
   *  CSS font). Absent or null: `fontBoxOf` on the face's file (node tests). */
  fontBox?(spec: FontBoxSpec): Promise<{ asc: number; desc: number } | null>;
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

/** The canvas alias of a raster spec's non-legacy font, loaded first (the
 *  font runtime, imported only when a text box names one); undefined when it
 *  did not load, so the box draws in its legacy font. */
export async function rasterAlias(spec: RasterTextSpec): Promise<string | undefined> {
  const fonts = await import("../../fonts");
  const req: FontRequest = { id: spec.fontId!, bold: spec.bold, italic: spec.italic };
  await fonts.ensureFonts([req]).catch(() => {});
  const f = fonts.fontFace(spec.font, spec.fontId, spec.bold, spec.italic);
  return f.missing ? undefined : f.family;
}

/** `rasterAlias` for a spec with style runs: every non-legacy face (the box's
 *  own and each run's) loaded in ONE runtime call first, then each alias;
 *  undefined where none or it did not load. */
export async function rasterAliases(spec: RasterTextSpec): Promise<{ base?: string; runs: (string | undefined)[] }> {
  const all = [spec, ...(spec.runs ?? [])];
  if (all.every((r) => r.fontId === undefined)) return { runs: (spec.runs ?? []).map(() => undefined) };
  const fonts = await import("../../fonts");
  const reqs: FontRequest[] = all.filter((r) => r.fontId !== undefined).map((r) => ({ id: r.fontId!, bold: r.bold, italic: r.italic }));
  await fonts.ensureFonts(reqs).catch(() => {});
  const alias = (r: { font: FontFamily; fontId?: FontId; bold: boolean; italic: boolean }): string | undefined => {
    if (r.fontId === undefined) return undefined;
    const f = fonts.fontFace(r.font, r.fontId, r.bold, r.italic);
    return f.missing ? undefined : f.family;
  };
  return { base: alias(spec), runs: (spec.runs ?? []).map(alias) };
}

let boxCtx: CanvasRenderingContext2D | null = null;

/** `ExportDeps.fontBox` in the app: the CSS font the editor gives a piece
 *  (src/pdf/editor/marks/render.ts screenCssFont: the runtime's alias with
 *  the legacy font after it and the face it resolved, or the legacy font
 *  quoted, Impact always plain), measured the way it reads a row's metrics
 *  (`measureText("x")`'s font box). The font runtime is reached only for a
 *  style with a `fontId`. */
export async function canvasFontBox(spec: FontBoxSpec): Promise<{ asc: number; desc: number } | null> {
  let family = `"${spec.font}"`;
  let bold = spec.bold;
  let italic = spec.italic;
  let alias = false;
  if (spec.fontId !== undefined) {
    const fonts = await import("../../fonts");
    const req: FontRequest = { id: spec.fontId, bold: spec.bold, italic: spec.italic };
    if (!fonts.fontsReady([req])) await fonts.ensureFonts([req]).catch(() => {});
    const f = fonts.fontFace(spec.font, spec.fontId, spec.bold, spec.italic);
    if (!f.missing) {
      family = `${f.family}, "${spec.font}"`;
      bold = f.bold;
      italic = f.italic;
      alias = true;
    }
  }
  // a regular-only font (Impact) is shown plain whatever the toggles say
  if (!alias && spec.font === "Impact") bold = italic = false;
  if (!boxCtx) {
    const c = document.createElement("canvas");
    c.width = 0;
    c.height = 0;
    boxCtx = c.getContext("2d");
  }
  if (!boxCtx) return null;
  const font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${spec.size}px ${family}`;
  if (boxCtx.font !== font) boxCtx.font = font;
  const m = boxCtx.measureText("x");
  const asc = m.fontBoundingBoxAscent;
  const desc = m.fontBoundingBoxDescent;
  return Number.isFinite(asc) && Number.isFinite(desc) ? { asc, desc } : null;
}

/** The desktop app's dependencies. Imported lazily with the export chunk;
 *  core/ipc is on the boot path already, so it is imported statically. */
export async function appDeps(): Promise<ExportDeps> {
  return {
    pdfjs: appPdfjs,
    fileStat: (path) => ipc.fileStat(path),
    readBytes: (path) => fetchBytes(mediaUrl(path)),
    async fontBytes(family, bold, italic) {
      const path = await ipc.systemFontPath(family, bold, italic);
      return path ? fetchBytes(mediaUrl(path)) : null;
    },
    resolveFonts: (reqs) => ipc.fontsResolve(reqs),
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
      if (spec.runs) {
        const al = await rasterAliases(spec);
        return layoutCanvasLines(spec, canvasToPng, al.base, al.runs);
      }
      return layoutCanvasLines(spec, canvasToPng, spec.fontId === undefined ? undefined : await rasterAlias(spec));
    },
    fontBox: canvasFontBox,
    now: () => new Date(),
  };
}
