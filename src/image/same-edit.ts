// "Is this still the project I last wrote?" for the image editor's live edits
// (the inspector's gestures, the per-layer crop, the nudge run).
//
// Reference equality is the wrong question: every save — the debounced
// autosave, Ctrl+S, the Temporary badge's Keep — puts a new top-level object in
// the store that differs ONLY in `modifiedAt` (core/project.ts touchModified).
// Read as a foreign edit, that restamp dropped a pending undo step, or re-based
// it onto a half-typed value.
//
// Every other top-level key is compared, not just the timeline, media and
// image: a rename landing in between IS someone else's edit, and must keep its
// own undo step.

import type { ProjectFile } from "../core/types";

/** True when `a` and `b` are the same edit: the same object, or two objects
 *  whose top-level fields are the same references apart from `modifiedAt`. */
export function sameEdit(a: ProjectFile, b: ProjectFile): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (!Object.prototype.hasOwnProperty.call(ra, k) || k === "modifiedAt") continue;
    if (!Object.prototype.hasOwnProperty.call(rb, k) || ra[k] !== rb[k]) return false;
    n++;
  }
  for (const k in rb) {
    if (Object.prototype.hasOwnProperty.call(rb, k) && k !== "modifiedAt") n--;
  }
  return n === 0;
}
