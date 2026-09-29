// Copy image: the whole composite to the clipboard as PNG.
//
// Not implemented yet: the declaration below is the contract the rest of the
// image editor compiles against.

import type { ProjectFile } from "../core/types";

/** MUST be called synchronously inside the user gesture: the clipboard write
 *  is started there with a Promise-valued ClipboardItem, and the render fills
 *  it in. Toasts on rejection. */
export function copyImage(doc: ProjectFile): void;
export function copyImage(): never {
  throw new Error("not implemented");
}
