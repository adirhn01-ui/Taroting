// What every pointer tool of the PDF editor is handed, and the shape of one
// gesture. The controller (controller.ts) owns the pointer: it captures it,
// holds autosave for the gesture, coalesces painting to one frame and routes
// move / up / cancel to the gesture a tool started.

import type { ProjectFile } from "../../../core/types";
import type { PdfEditorCtx } from "../../types";
import type { MarkLayer } from "./layer";

export interface Env {
  ctx: PdfEditorCtx;
  layer: MarkLayer;
  /** CSS px per point now */
  zoom(): number;
  /** a client point in the page space of `key` (drags may leave the page) */
  pt(key: string, e: { clientX: number; clientY: number }): { x: number; y: number } | null;
  /** run `fn` once on the next frame (coalesced per gesture) */
  frame(fn: () => void): void;
}

/** One pointer gesture a tool started. */
export interface Gesture {
  move(e: PointerEvent): void;
  up(e: PointerEvent): void;
  /** dropped (pointer cancelled, capture lost, tool disabled, dispose): undo
   *  any live preview, write nothing */
  cancel(): void;
}

/** Same project for an edit's purposes: an autosave's `modifiedAt` restamp is
 *  not someone else's edit (the image editor's sameEdit idea, for PDF). */
export function sameEdit(a: ProjectFile, b: ProjectFile): boolean {
  return a === b || (a.pdf === b.pdf && a.media === b.media);
}
