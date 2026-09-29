// The image export dialog: format, quality and size, the source-file guard,
// then render → save with progress and cancel.
//
// Not implemented yet (opens nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "./context";

/** Where the project's first photo came from, for the default name
 *  (`<stem> (edited)`) and format. `ext` null = no photo, or one whose format
 *  the export does not write (then PNG). */
export interface ExportSourceHint {
  stem: string;
  ext: "png" | "jpg" | "webp" | null;
}

/** Opens the dialog (closing one already open first) and returns its closer.
 *  The closer aborts a running export, so the editor registers it with
 *  `ctx.registerOverlay` and dispose() can never leave an export running. */
export function openImageExportDialog(ctx: ImageEditorCtx, sourceHint: ExportSourceHint): () => void;
export function openImageExportDialog(): () => void {
  return () => {};
}
