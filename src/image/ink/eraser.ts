// The stroke eraser's hit test: which committed strokes an eraser path touches.
//
// A stroke is hit when the eraser disk (radius r), swept along one move, comes
// within the stroke's half-width of the stroke's centre line — i.e. the
// distance between the eraser's segment and the stroke's polyline is at most
// r + w/2. Everything is measured in the LAYER'S OWN space: the caller maps the
// eraser segment into each drawing layer with that layer's transform and hands
// the radius in that layer's source px, so a rotated, flipped or scaled layer
// is hit exactly where it is drawn.
//
// Cost: a bbox reject per stroke (strokeBounds is cached per stroke object),
// then segment distances only for the strokes whose box the eraser reaches.

import type { Stroke } from "../../core/types";
import { forEachStroke, pointsOf } from "../strokes";
import { strokeBounds } from "./paint";
import { shapePolylines } from "./shapes";

/** Squared distance from P to segment AB. */
function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Distance between segments AB and CD (0 when they cross). */
export function segSegDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const d1 = orient(ax, ay, bx, by, cx, cy);
  const d2 = orient(ax, ay, bx, by, dx, dy);
  const d3 = orient(cx, cy, dx, dy, ax, ay);
  const d4 = orient(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.sqrt(
    Math.min(
      distSqPointSeg(ax, ay, cx, cy, dx, dy),
      distSqPointSeg(bx, by, cx, cy, dx, dy),
      distSqPointSeg(cx, cy, ax, ay, bx, by),
      distSqPointSeg(dx, dy, ax, ay, bx, by),
    ),
  );
}

/** Does the eraser, swept from (ax, ay) to (bx, by) with radius r (all in the
 *  stroke's layer space), touch this stroke? Erase strokes are never "hit": they
 *  are not marks, and deleting one would bring back what it erased. */
export function strokeHit(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  if (s.t === "erase") return false;
  const box = strokeBounds(s);
  if (box.w <= 0 && box.h <= 0) return false;
  // bbox reject: strokeBounds already includes the stroke's half-width.
  if (Math.max(ax, bx) + r < box.x || Math.min(ax, bx) - r > box.x + box.w) return false;
  if (Math.max(ay, by) + r < box.y || Math.min(ay, by) - r > box.y + box.h) return false;
  const reach = r + s.w / 2;
  if ("p" in s) {
    const pts = pointsOf(s);
    const n = pts.length / 3;
    if (n === 1) return Math.sqrt(distSqPointSeg(pts[0]!, pts[1]!, ax, ay, bx, by)) <= reach;
    for (let i = 1; i < n; i++) {
      const d = segSegDistance(pts[(i - 1) * 3]!, pts[(i - 1) * 3 + 1]!, pts[i * 3]!, pts[i * 3 + 1]!, ax, ay, bx, by);
      if (d <= reach) return true;
    }
    return false;
  }
  for (const line of shapePolylines(s)) {
    for (let i = 2; i + 1 < line.length; i += 2) {
      if (segSegDistance(line[i - 2]!, line[i - 1]!, line[i]!, line[i + 1]!, ax, ay, bx, by) <= reach) return true;
    }
  }
  return false;
}

/** Every stroke of `chunks` the swept eraser touches, added to `into` (strokes
 *  already in it are skipped). Returns how many were newly added. */
export function collectStrokeHits(
  chunks: readonly Stroke[][],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
  into: Set<Stroke>,
): number {
  let added = 0;
  forEachStroke(chunks, (s) => {
    if (into.has(s)) return;
    if (strokeHit(s, ax, ay, bx, by, r)) {
      into.add(s);
      added++;
    }
  });
  return added;
}
