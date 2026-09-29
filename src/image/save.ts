// The client half of the chunked image-save protocol (src-tauri/src/image_save.rs):
// begin (JSON, carries the destination) → 8 MiB raw chunks → commit, and an
// abort on any error or signal so no `.part` file is left behind.
//
// Not implemented yet: the declaration below is the contract the rest of the
// image editor compiles against.

import type { ImageSaveDest } from "../core/ipc";
import type { ImageExportFormat } from "../core/types";

/** Begins, streams 8 MiB `Uint8Array` chunks, then commits. Aborts
 *  (`imageSaveAbort`) on any error or signal. Resolves the final path. */
export function saveBlob(
  dest: ImageSaveDest,
  format: ImageExportFormat,
  blob: Blob,
  signal?: AbortSignal,
  onProgress?: (r: number) => void,
): Promise<{ path: string }>;
export function saveBlob(): Promise<never> {
  return Promise.reject(new Error("not implemented"));
}
