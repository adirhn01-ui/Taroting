// Hand finished PDF bytes to the backend's chunked save (the image editor's
// begin → chunk → commit protocol, format "pdf"): begin carries the target
// and every file the project reads, so the backend can refuse to write over a
// source; chunks stream in; commit moves the finished file into place. Any
// failure aborts so no partial file is left behind.

/** One slice per `image_save_chunk` call — half the backend's 8 MiB cap. */
export const PDF_CHUNK_BYTES = 4 * 1024 * 1024;

export interface PdfSaveIpc {
  pdfSaveBegin(dest: { kind: "user"; path: string; sources: string[] }, totalBytes: number): Promise<{ token: number; path: string }>;
  imageSaveChunk(token: number, bytes: Uint8Array): Promise<void>;
  imageSaveCommit(token: number): Promise<{ token: number; path: string }>;
  imageSaveAbort(token: number): Promise<void>;
}

export async function writePdf(
  io: PdfSaveIpc,
  target: string,
  sources: string[],
  bytes: Uint8Array,
  onProgress?: (r: number) => void,
): Promise<string> {
  const begun = await io.pdfSaveBegin({ kind: "user", path: target, sources }, bytes.length);
  const token = begun.token;
  try {
    for (let at = 0; at < bytes.length; at += PDF_CHUNK_BYTES) {
      // a copy, not a view: the raw-body invoke must not see the rest of the buffer
      await io.imageSaveChunk(token, bytes.slice(at, Math.min(at + PDF_CHUNK_BYTES, bytes.length)));
      onProgress?.(Math.min(at + PDF_CHUNK_BYTES, bytes.length) / bytes.length);
    }
    return (await io.imageSaveCommit(token)).path;
  } catch (e) {
    // the error that got us here is the story, not the abort's own
    await io.imageSaveAbort(token).catch(() => {});
    throw e;
  }
}
