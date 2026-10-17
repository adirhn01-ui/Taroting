// The one door to pdf.js. The library is dynamic-imported on first use so it
// lands in its own chunk and costs nothing until a PDF is opened; the worker
// script, the no-WASM image decoders, standard fonts, CMaps and ICC profiles
// are app-relative assets (vite.config.ts serves them in dev and copies them
// into dist/pdfjs/ at build).
//
// CSP facts this relies on (src-tauri/tauri.conf.json): `worker-src 'self'`
// for the worker, `script-src 'self'` for the *_nowasm_fallback.js decoders
// pdf.js dynamic-imports with `useWasm: false` (no 'wasm-unsafe-eval'), no
// eval anywhere (pdf.js 6 has none), no scripting (no sandbox is created).

import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createSharedResource } from "./lifecycle";

export type Pdfjs = typeof import("pdfjs-dist");
export type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;
export type PDFPageProxy = import("pdfjs-dist").PDFPageProxy;
export type PDFWorker = import("pdfjs-dist").PDFWorker;

let mod: Promise<Pdfjs> | null = null;
let loaded: Pdfjs | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  mod ??= import("pdfjs-dist").then((p) => {
    p.GlobalWorkerOptions.workerSrc = workerUrl;
    loaded = p;
    return p;
  });
  return mod;
}

/** The module once loadPdfjs has resolved (sync access for the view). */
export function pdfjsNow(): Pdfjs | null {
  return loaded;
}

function assetUrl(dir: string): string {
  return new URL(`${import.meta.env.BASE_URL}pdfjs/${dir}/`, location.href).href;
}

/** getDocument options every document is opened with. */
export function documentParams(): Record<string, unknown> {
  return {
    useWasm: false,
    wasmUrl: assetUrl("wasm"),
    standardFontDataUrl: assetUrl("standard_fonts"),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    iccUrl: assetUrl("iccs"),
    enableXfa: false,
    verbosity: import.meta.env.DEV ? 1 : 0,
  };
}

/** Grace after the last document closes before the worker is torn down:
 *  long enough to step to the next PDF in a folder without a respawn. */
export const WORKER_GRACE_MS = 2000;

/** The app's ONE pdf.js worker. Created by the first openPdf (pdf.js is
 *  loaded by then), destroyed WORKER_GRACE_MS after the last PdfDoc goes. */
export const sharedWorker = createSharedResource<PDFWorker>({
  create: () => {
    const p = pdfjsNow();
    if (!p) throw new Error("pdf.js is not loaded");
    // (the typings say name is null-only; any string works)
    return new p.PDFWorker({ name: "taroting-pdf" as unknown as null });
  },
  destroy: (w) => w.destroy(),
  graceMs: WORKER_GRACE_MS,
});
