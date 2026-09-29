// Pure folder-stepping state for the viewer. No DOM, no IPC: the viewer drives
// it, vitest pins it. A `StepState` is the window of neighbours the backend
// returned (`ipc.listSiblings`) plus where the shown file sits in it.

import type { SiblingWindow } from "../core/ipc";
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

export function fromWindow(_current: string, _w: SiblingWindow): StepState {
  throw new Error("not implemented");
}

/** false at an ABSOLUTE end of the folder */
export function canStep(_s: StepState, _dir: -1 | 1): boolean {
  throw new Error("not implemented");
}

/** null = the window's edge (not the folder's): refill first */
export function step(_s: StepState, _dir: -1 | 1): StepState | null {
  throw new Error("not implemented");
}

export function nearEdge(_s: StepState, _dir: -1 | 1, _margin: number): boolean {
  throw new Error("not implemented");
}

/** "3 / 12"; "– / 12" if the index is unknown; "" if total ≤ 1 */
export function counterText(_s: StepState): string {
  throw new Error("not implemented");
}

/** image + gif → img; video + audio → video; anything else → null.
 *  `ext` is already lowercased (fileExt). */
export function elementFor(_ext: string): ViewElement | null {
  throw new Error("not implemented");
}
