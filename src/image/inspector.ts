// The image editor's inspector: the selected layer's opacity and adjustments,
// or the text/solid generator controls, or the project's background.
//
// Not implemented yet (mounts nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "./context";

export function mountImageInspector(host: HTMLElement, ctx: ImageEditorCtx): { dispose(): void };
export function mountImageInspector(): { dispose(): void } {
  return { dispose() {} };
}
