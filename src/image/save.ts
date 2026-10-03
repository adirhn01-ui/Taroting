// The client half of the chunked image-save protocol (src-tauri/src/image_save.rs):
// begin (JSON, carries the destination) → 8 MiB raw chunks → commit, and an
// abort on any error or signal so no `<target>.taroting-part` file is left
// behind.
//
// Why chunks at all: a 60-100 MB PNG handed to one invoke would be copied whole
// on the UI thread (wry reads a body in 1 KiB steps) and held twice in memory.
// 8 MiB slices keep one slice in flight, and the backend's per-chunk cap is
// the same number, so a slice this module cuts can never be refused for size.

import { ipc, type ImageSaveDest } from "../core/ipc";
import type { ImageExportFormat } from "../core/types";

/** One slice of the blob per `image_save_chunk` call — equal to the backend's
 *  MAX_CHUNK_BYTES, never larger. */
export const SAVE_CHUNK_BYTES = 8 * 1024 * 1024;

function abortError(): DOMException {
  return new DOMException("The save was canceled.", "AbortError");
}

/** Begins, streams 8 MiB `Uint8Array` chunks, then commits. Aborts
 *  (`imageSaveAbort`) on any error or signal. Resolves the final path.
 *
 *  A failure is rethrown AS IT CAME — the backend's `{ code, message }` object,
 *  not a wrapper — so a caller can still tell `bad_input` (the target is one of
 *  the project's originals) from an I/O failure. */
export async function saveBlob(
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
      // One slice materialized at a time: the blob itself stays the only full
      // copy in memory.
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
    // Drop the partial file. Its own failure is not the story — the error that
    // got us here is — so it is swallowed.
    await ipc.imageSaveAbort(token).catch(() => {});
    throw e;
  }
}
