// Full-resolution image export on the main thread: an OffscreenCanvas,
// strip-wise adjustments that yield to the UI between strips, then
// convertToBlob. ffmpeg is never involved for image projects.
//
// Not implemented yet: the declarations below are the contract the rest of the
// image editor compiles against.

import type { ImageExportFormat, ProjectFile } from "../../core/types";

export interface ExportRenderOpts {
  format: ImageExportFormat;
  /** 1..100 */
  quality: number;
  /** integers ≥1, ≤ RENDER limits, WebP ≤ WEBP_MAX_SIDE */
  outW: number;
  outH: number;
}

/** Full-resolution render on the main thread (OffscreenCanvas), strip-wise
 *  adjustments with a yield between strips, then convertToBlob. Rejects on
 *  abort; verifies blob.type. */
export function renderImageExport(
  doc: ProjectFile,
  opts: ExportRenderOpts,
  signal: AbortSignal,
  onProgress: (ratio: number) => void,
): Promise<Blob>;
export function renderImageExport(): Promise<never> {
  return Promise.reject(new Error("not implemented"));
}

/** Largest output that fits Chromium's canvas limits at the canvas aspect. */
export function maxRenderSize(w: number, h: number): { w: number; h: number; reduced: boolean };
export function maxRenderSize(): never {
  throw new Error("not implemented");
}

/** ≤320 px JPEG q0.85 for the Home card. */
export function renderThumbnail(doc: ProjectFile): Promise<Blob>;
export function renderThumbnail(): Promise<never> {
  return Promise.reject(new Error("not implemented"));
}
