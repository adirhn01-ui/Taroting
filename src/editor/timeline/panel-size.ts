// Geometry for the timeline panel's drag divider. Pure and allocation-free, so
// the height a drag produces can be tested without a live editor — and so the
// drag and the settings sanitizer clamp against the same rules. Both read the
// bounds from core/types.ts; neither may re-type the numbers.

import { TIMELINE_HEIGHT_MAX, TIMELINE_HEIGHT_MIN } from "../../core/types";

/** Stage the panel may never take, in px. The panel is free to reach
 *  TIMELINE_HEIGHT_MAX only while the editor is tall enough to keep this much
 *  preview above it: at the 600px minimum window there is no room for both, and
 *  a panel that took the difference would push the transport off the bottom
 *  edge. The same number is written onto .editor__preview at mount, so the flex
 *  layout stops the panel exactly where the drag does. */
export const PREVIEW_MIN_H = 120;

/** The largest legal panel height inside an .editor__main of `mainH` px.
 *
 *  Measured ONCE per gesture rather than per move — the window cannot be
 *  resized while a pointer is captured on the divider, so this cannot go stale
 *  mid-drag, and the drag costs no layout reads after its first.
 *
 *  Never returns less than TIMELINE_HEIGHT_MIN: a window too short for both
 *  bands still gets a usable timeline rather than a sliver. */
export function maxPanelHeight(mainH: number): number {
  if (!Number.isFinite(mainH)) return TIMELINE_HEIGHT_MIN;
  return Math.max(TIMELINE_HEIGHT_MIN, Math.min(TIMELINE_HEIGHT_MAX, mainH - PREVIEW_MIN_H));
}

/** Snap `px` to a whole pixel inside [TIMELINE_HEIGHT_MIN, maxH].
 *
 *  A non-finite input resolves to the minimum instead of reaching a style
 *  write: `px` comes from pointer arithmetic during a drag and from a
 *  hand-editable settings file at mount, and "NaNpx" would silently drop the
 *  declaration and leave the panel at whatever the stylesheet last said. */
export function clampPanelHeight(px: number, maxH: number): number {
  if (!Number.isFinite(px)) return TIMELINE_HEIGHT_MIN;
  const hi = Math.max(TIMELINE_HEIGHT_MIN, maxH);
  return Math.round(Math.min(Math.max(px, TIMELINE_HEIGHT_MIN), hi));
}
