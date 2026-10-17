// Copy / paste / duplicate of marks. The clipboard is in memory and
// module-level: it survives switching projects within one app run (a mark
// copied in one PDF project pastes into another), and is never written
// anywhere. A copied picture carries its MediaRef, so it pastes into a
// project that does not have it yet (model.ts pasteAnnots adds it).
//
// Paste lands on the CURRENT page (the one under the viewport centre), each
// repeated paste of the same copy offset by another PASTE_STEP on screen;
// duplicate pastes the selection on its own page(s), PASTE_STEP from where it
// is. Either is ONE history step and leaves the new marks selected.

import type { MediaRef, PdfAnnot } from "../../../core/types";
import { toast } from "../../../ui/toast";
import { pasteAnnots } from "../../model";
import type { PdfEditorCtx } from "../../types";
import { PAGE_FULL } from "./draw";
import { screenToPageDelta } from "./geom";
import type { MarkLayer } from "./layer";
import { selectedMarks } from "./select";

/** How far a paste lands from the last one (and a duplicate from its
 *  original), points, down-right on screen. */
export const PASTE_STEP = 10;

interface Clip {
  marks: PdfAnnot[];
  media: MediaRef[];
  /** pastes made from this copy so far */
  pastes: number;
}

let clip: Clip | null = null;

/** Test hook: forget the clipboard. */
export function resetMarkClipboard(): void {
  clip = null;
}

/** Whether there is anything to paste. */
export function hasClip(): boolean {
  return clip !== null && clip.marks.length > 0;
}

/** Copy the selected marks; false when nothing is selected. */
export function copyMarks(ctx: PdfEditorCtx): boolean {
  const p = ctx.session.project;
  const marks = selectedMarks(p, ctx.selection.get()).map((m) => m.a);
  if (marks.length === 0) return false;
  const used = new Set(marks.flatMap((a) => (a.t === "image" ? [a.media] : [])));
  clip = { marks, media: p.media.filter((m) => used.has(m.id)), pastes: 0 };
  return true;
}

/** Put `marks` on `key` moved by a screen step of `k`·PASTE_STEP, one step,
 *  selected. True when they landed. */
function land(ctx: PdfEditorCtx, layer: MarkLayer, key: string, marks: readonly PdfAnnot[], media: readonly MediaRef[], k: number): string[] | null {
  const d = screenToPageDelta(PASTE_STEP * k, PASTE_STEP * k, layer.info(key)?.rot ?? 0);
  const before = ctx.session.project;
  const out = pasteAnnots(before, key, marks, d.x, d.y, media);
  if (out.project === before) {
    toast.refuse(PAGE_FULL);
    return null;
  }
  ctx.session.commit(() => out.project);
  return out.ids;
}

/** Paste the clipboard onto page `key`; false when there was nothing to paste
 *  or it did not fit. */
export function pasteMarks(ctx: PdfEditorCtx, layer: MarkLayer, key: string | null): boolean {
  if (!clip || clip.marks.length === 0 || !key) return false;
  const ids = land(ctx, layer, key, clip.marks, clip.media, clip.pastes + 1);
  if (!ids) return false;
  clip.pastes++;
  ctx.selection.set(ids.map((id) => ({ key, id })));
  return true;
}

/** Duplicate the selection beside itself, on its own page(s): ONE step. */
export function duplicateMarks(ctx: PdfEditorCtx, layer: MarkLayer): boolean {
  const p = ctx.session.project;
  const marks = selectedMarks(p, ctx.selection.get());
  if (marks.length === 0) return false;
  const byPage = new Map<string, PdfAnnot[]>();
  for (const m of marks) {
    const l = byPage.get(m.key) ?? [];
    l.push(m.a);
    byPage.set(m.key, l);
  }
  let next = p;
  const sel: { key: string; id: string }[] = [];
  for (const [key, list] of byPage) {
    const d = screenToPageDelta(PASTE_STEP, PASTE_STEP, layer.info(key)?.rot ?? 0);
    const out = pasteAnnots(next, key, list, d.x, d.y, p.media);
    if (out.project === next) {
      toast.refuse(PAGE_FULL);
      return false;
    }
    next = out.project;
    for (const id of out.ids) sel.push({ key, id });
  }
  ctx.session.commit(() => next);
  ctx.selection.set(sel);
  return true;
}
