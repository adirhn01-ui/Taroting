// Snapping: collect interesting times (clip edges, playhead, origin) and
// pull dragged values onto them when within a pixel threshold.

import { clipEnd, timelineTime } from "../../core/time";
import type { AnimProp, Clip, ProjectFile } from "../../core/types";

export const SNAP_THRESHOLD_PX = 8;

export interface SnapResult {
  t: number;
  /** the candidate that was snapped to (for drawing a guide), or null */
  guide: number | null;
}

const KF_PROPS: AnimProp[] = ["x", "y", "scale", "opacity"];

/** All snap-worthy times, excluding a clip being dragged. When a selected clip
 *  is passed and it has keyframes, its in-range keyframe timeline-times join the
 *  candidates (so dragging snaps to its diamonds). */
export function collectCandidates(
  project: ProjectFile,
  excludeClipId: string | null,
  playhead: number,
  selectedClip?: Clip | null,
): number[] {
  const out: number[] = [0, playhead];
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      out.push(clip.timelineStart, clipEnd(clip));
    }
  }
  for (const marker of project.timeline.markers ?? []) out.push(marker.t);
  if (selectedClip?.keyframes) {
    for (const prop of KF_PROPS) {
      const arr = selectedClip.keyframes[prop];
      if (!arr) continue;
      for (const kf of arr) {
        if (kf.t < selectedClip.srcIn - 1e-6 || kf.t > selectedClip.srcOut + 1e-6) continue;
        out.push(timelineTime(selectedClip, kf.t));
      }
    }
  }
  return out;
}

/** Snap a single time value. */
export function snapTime(
  t: number,
  candidates: number[],
  pxPerSec: number,
  enabled: boolean,
): SnapResult {
  if (!enabled || pxPerSec <= 0) return { t, guide: null };
  const threshold = SNAP_THRESHOLD_PX / pxPerSec;
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best === null ? { t, guide: null } : { t: best, guide: best };
}

/** Snap a clip being moved: both its start and end edges compete. */
export function snapMove(
  start: number,
  duration: number,
  candidates: number[],
  pxPerSec: number,
  enabled: boolean,
): SnapResult {
  if (!enabled || pxPerSec <= 0) return { t: start, guide: null };
  const byStart = snapTime(start, candidates, pxPerSec, true);
  const byEnd = snapTime(start + duration, candidates, pxPerSec, true);
  const startDist = byStart.guide === null ? Infinity : Math.abs(byStart.t - start);
  const endDist = byEnd.guide === null ? Infinity : Math.abs(byEnd.t - (start + duration));
  if (startDist === Infinity && endDist === Infinity) return { t: start, guide: null };
  if (startDist <= endDist) return byStart;
  return { t: byEnd.t - duration, guide: byEnd.guide };
}
