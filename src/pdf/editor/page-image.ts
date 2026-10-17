// One page of a PDF project as a picture, marks and filled fields included —
// the export dialog's Image tab and its "Open as image project".
//
// The faithful way to get exactly what the PDF export would print: build a
// ONE-PAGE PDF in memory with marks and form fields flattened (the export's
// own pipeline, so a mark looks the same in both), then let pdf.js paint that
// page on white at the chosen size. Everything heavy (pdf-lib, pdf.js) is
// reached through dynamic imports: this module costs nothing until the user
// exports a page.

import { ipc, type ImageSaveDest } from "../../core/ipc";
import type { ImageExportFormat, ProjectFile } from "../../core/types";

export interface PageImageRequest {
  /** 1-based, in the document's current page order */
  page: number;
  /** output size in px (already fitted to the canvas limits) */
  w: number;
  h: number;
  type: "image/png" | "image/jpeg";
  /** 1..100, JPEG only */
  quality: number;
}

function abortError(): DOMException {
  return new DOMException("The export was canceled.", "AbortError");
}

interface PageLike {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvas: HTMLCanvasElement; viewport: unknown; background?: string }): { promise: Promise<void> };
  cleanup(): void;
}

export async function renderPageImage(project: ProjectFile, req: PageImageRequest, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw abortError();
  const [{ buildPdf }, { appDeps }, pdfjsMod] = await Promise.all([
    import("../export/export"),
    import("../export/deps"),
    import("../view/pdfjs"),
  ]);
  const bytes = await buildPdf(project, { flattenMarks: true, flattenForms: true, range: [req.page, req.page] }, await appDeps());
  if (signal?.aborted) throw abortError();

  const pdfjs = await pdfjsMod.loadPdfjs();
  const worker = pdfjsMod.sharedWorker.acquire();
  const task = pdfjs.getDocument({ ...pdfjsMod.documentParams(), data: bytes, worker });
  const canvas = document.createElement("canvas");
  try {
    const doc = await task.promise;
    if (signal?.aborted) throw abortError();
    const page = (await doc.getPage(1)) as unknown as PageLike;
    try {
      const vp1 = page.getViewport({ scale: 1 });
      const scale = req.w / Math.max(1, vp1.width);
      const vp = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.min(req.w, Math.round(vp.width)));
      canvas.height = Math.max(1, Math.min(req.h, Math.round(vp.height)));
      await page.render({ canvas, viewport: vp, background: "#ffffff" }).promise;
      if (signal?.aborted) throw abortError();
      const q = Math.min(100, Math.max(1, req.quality)) / 100;
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("The page could not be encoded."))),
          req.type,
          req.type === "image/jpeg" ? q : undefined,
        );
      });
    } finally {
      page.cleanup();
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await task.destroy().catch(() => {});
    pdfjsMod.sharedWorker.release();
  }
}

/** One slice per `image_save_chunk` call — the backend's MAX_CHUNK_BYTES. */
const SAVE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * The client half of the chunked image save: begin (JSON, carries the
 * destination) → 8 MiB raw chunks → commit, and an abort on any error or
 * signal so no partial file is left behind. Resolves the final path.
 *
 * COPIED from src/image/save.ts `saveBlob` (the image editor's save path):
 * the PDF chunk may import only the shared ink primitives from src/image
 * (src/dev/image-chunk-boundary.test.ts). Keep the two in step.
 */
export async function saveImageBlob(
  dest: ImageSaveDest,
  format: ImageExportFormat,
  blob: Blob,
  signal?: AbortSignal,
  onProgress?: (r: number) => void,
): Promise<{ path: string }> {
  if (signal?.aborted) throw abortError();
  const total = blob.size;
  const begun = await ipc.imageSaveBegin(dest, format, total);
  const token = begun.token;
  try {
    if (signal?.aborted) throw abortError();
    let written = 0;
    onProgress?.(0);
    while (written < total) {
      const end = Math.min(written + SAVE_CHUNK_BYTES, total);
      const buf = await blob.slice(written, end).arrayBuffer();
      if (signal?.aborted) throw abortError();
      await ipc.imageSaveChunk(token, new Uint8Array(buf));
      if (signal?.aborted) throw abortError();
      written = end;
      onProgress?.(written / total);
    }
    const done = await ipc.imageSaveCommit(token);
    return { path: done.path };
  } catch (e) {
    await ipc.imageSaveAbort(token).catch(() => {});
    throw e;
  }
}
