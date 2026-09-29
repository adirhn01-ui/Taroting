// Ink input: pen, pencil, marker, eraser and shapes on the stage, the live
// stroke, and the ruler. Commits one stroke (one undo step) per gesture.
//
// Not implemented yet (mounts nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "../context";

export function mountInk(ctx: ImageEditorCtx): { dispose(): void };
export function mountInk(): { dispose(): void } {
  return { dispose() {} };
}
