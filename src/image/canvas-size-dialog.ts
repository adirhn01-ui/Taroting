// The Canvas size dialog: width × height (integers 1-65535), keep aspect, and
// the note that layers stay centred. Apply is one commit of `resizeCanvas`.
//
// Not implemented yet (opens nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "./context";

/** Registers its own closer through `ctx.registerOverlay`. */
export function openCanvasSizeDialog(ctx: ImageEditorCtx): void;
export function openCanvasSizeDialog(): void {
  // opens nothing until implemented
}
