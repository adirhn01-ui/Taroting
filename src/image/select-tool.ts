// The select/move tool: oriented hit testing, the selection box, move, scale,
// rotate and per-layer crop. Active only while the tool is "select" and the
// stage mode is idle.
//
// Not implemented yet (mounts nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "./context";

export function mountSelectTool(ctx: ImageEditorCtx): { dispose(): void };
export function mountSelectTool(): { dispose(): void } {
  return { dispose() {} };
}
