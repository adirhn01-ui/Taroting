// The image editor's Layers panel: one row per layer, top first, with the eye
// toggle, rename, duplicate, reorder and delete.
//
// Not implemented yet (mounts nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "./context";

export function mountLayersPanel(host: HTMLElement, ctx: ImageEditorCtx): { dispose(): void };
export function mountLayersPanel(): { dispose(): void } {
  return { dispose() {} };
}
