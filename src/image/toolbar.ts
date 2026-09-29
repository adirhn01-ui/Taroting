// The image editor's tool row: the tools, their colour and size controls, and
// the ruler toggle. Writes `ctx.tools`; never touches the project.
//
// Not implemented yet (mounts nothing): the declaration below is the contract.

import type { ImageEditorCtx } from "./context";

export function mountToolbar(host: HTMLElement, ctx: ImageEditorCtx): { dispose(): void };
export function mountToolbar(): { dispose(): void } {
  return { dispose() {} };
}
