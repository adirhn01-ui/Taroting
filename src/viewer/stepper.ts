// Pure folder-stepping state for the viewer. No DOM, no IPC: the viewer drives
// it, vitest pins it. A `StepState` is the window of neighbours the backend
// returned (`ipc.listSiblings`) plus where the shown file sits in it.
//
// The window is bounded (WINDOW_RADIUS each side) so a folder of thousands of
// photos never crosses the IPC boundary whole. Stepping inside it is a plain
// index move; stepping off its edge returns null and the viewer asks for a
// fresh window around the file it is on. Only `canStep` answers "is there
// anything further at all" — the window's edge and the folder's end are
// different things, and confusing them is either a dead arrow or a refill loop.

import type { SiblingWindow } from "../core/ipc";
import { mediaFamilyOf } from "../core/types";
import type { StepFamily } from "../core/types";

export interface StepState {
  /** before ++ [current] ++ after (current kept even if it vanished) */
  list: string[];
  /** index of the shown file in `list` */
  pos: number;
  /** absolute 1-based index of list[0]; null if unknown */
  firstIndex: number | null;
  total: number;
  family: StepFamily;
}

export type ViewElement = "img" | "video";

/** Neighbours requested on each side of the shown file. */
export const WINDOW_RADIUS = 16;

/** How long a step waits before it starts loading: a still loads at once, a
 *  video/audio file after a short settle, a held key's repeat after less. */
export const DWELL_MS = { image: 0, media: 250, repeat: 150 } as const;

export function fromWindow(current: string, w: SiblingWindow): StepState {
  // The current file goes in by the name the CALLER holds, not a backend copy:
  // it is what the viewer compares against, and when it has vanished the
  // backend has no copy to give. A vanished current keeps its slot at the
  // insertion point so stepping still leaves from where the user was.
  const before = w.before;
  return {
    list: [...before, current, ...w.after],
    pos: before.length,
    firstIndex: w.index === null ? null : w.index - before.length,
    total: w.total,
    family: w.family,
  };
}

/** Whether files exist beyond the window's edge in `dir`.
 *  Known index: exact. Unknown (the shown file vanished, so nothing in the
 *  window has an absolute position): the window holds the whole folder when it
 *  lists at least `total` real files besides the current slot — then its edges
 *  are the folder's. Otherwise assume more, and let a refill decide; the viewer
 *  drops the direction when the refill cannot move either, so this can cost
 *  one wasted listing, never a loop. */
function moreBeyond(s: StepState, dir: -1 | 1): boolean {
  if (s.firstIndex !== null) {
    return dir < 0 ? s.firstIndex > 1 : s.firstIndex + s.list.length - 1 < s.total;
  }
  return s.list.length - 1 < s.total;
}

/** false at an ABSOLUTE end of the folder */
export function canStep(s: StepState, dir: -1 | 1): boolean {
  const j = s.pos + dir;
  if (j >= 0 && j < s.list.length) return true;
  return moreBeyond(s, dir);
}

/** null = the window's edge (not the folder's): refill first */
export function step(s: StepState, dir: -1 | 1): StepState | null {
  const j = s.pos + dir;
  if (j < 0 || j >= s.list.length) return null;
  return { ...s, pos: j };
}

/** True when the window's edge is at most `margin` steps away in `dir` AND
 *  there is more folder beyond it — the moment to fetch the next window in the
 *  background, so a held key never stalls at the edge. */
export function nearEdge(s: StepState, dir: -1 | 1, margin: number): boolean {
  const remaining = dir > 0 ? s.list.length - 1 - s.pos : s.pos;
  return remaining <= margin && moreBeyond(s, dir);
}

/** "3 / 12"; "– / 12" if the index is unknown; "" if total ≤ 1 */
export function counterText(s: StepState): string {
  if (s.total <= 1) return "";
  if (s.firstIndex === null) return `– / ${s.total}`;
  return `${s.firstIndex + s.pos} / ${s.total}`;
}

/** image + gif → img; video + audio → video; anything else → null.
 *  `ext` is already lowercased (fileExt). */
export function elementFor(ext: string): ViewElement | null {
  // Through the one extension table (media-extensions.json), never a local
  // list: the viewer must refuse exactly what import and list_siblings refuse.
  const f = mediaFamilyOf(ext);
  if (f === null) return null;
  return f === "image" || f === "gif" ? "img" : "video";
}
