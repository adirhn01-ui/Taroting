// Vertical lane targeting for clip moves. A drag retargets lanes only after the
// pointer travels meaningfully into a neighboring lane (hysteresis), so pointer
// jitter near a lane boundary does not flip-flop the destination. Only lanes of
// the same kind as the dragged clip are valid targets (matches moveClip's guard
// in core/project.ts). Pure + allocation-free in the steady state.

import type { LaneRect } from "./render";

/** Fraction of a lane's height the pointer must clear past a boundary before the
 *  target switches to the neighbor. 0.4 = travel 40% into the next lane. */
export const LANE_HYSTERESIS_FRAC = 0.4;

/** Resolve which track a vertical move should target.
 *
 *  `lanes` is the full lane layout; only lanes whose track.kind === `kind` are
 *  eligible. `currentId` is the drag's current target (kept as a sticky anchor);
 *  `sourceId` is the clip's origin track (the fallback when the pointer is off
 *  every eligible lane). Returns the id of the track that should receive the clip.
 *
 *  Rule: the current target holds while the pointer stays within its band
 *  extended by `frac` of a lane height past each of its own edges. Retargeting to
 *  an eligible lane L happens only once the pointer is inside L's *core* — L's
 *  band shrunk by `frac` from each edge — i.e. `frac` into L past the boundary.
 *  Between those zones (the boundary dead-band) the current target is retained. */
export function laneTargetForMove(
  y: number,
  lanes: LaneRect[],
  kind: "video" | "audio",
  currentId: string,
  sourceId: string,
  frac = LANE_HYSTERESIS_FRAC,
): string {
  // Sticky: if the pointer is still within the current lane's edges extended by
  // the margin, keep it — this is the hysteresis that kills boundary flicker.
  for (const lane of lanes) {
    if (lane.track.id !== currentId) continue;
    if (lane.track.kind !== kind) break; // current became invalid; fall through
    const margin = lane.h * frac;
    if (y >= lane.y - margin && y <= lane.y + lane.h + margin) return currentId;
    break;
  }

  // Otherwise retarget only to an eligible lane whose core (inset by margin)
  // contains the pointer — requires travelling `frac` past the boundary.
  for (const lane of lanes) {
    if (lane.track.kind !== kind) continue;
    const margin = lane.h * frac;
    if (y >= lane.y + margin && y <= lane.y + lane.h - margin) return lane.track.id;
  }

  // Pointer is in a dead-band between eligible lanes (or off all of them): hold
  // the current target if it is still an eligible lane, else fall back to source.
  for (const lane of lanes) {
    if (lane.track.id === currentId && lane.track.kind === kind) return currentId;
  }
  return sourceId;
}
