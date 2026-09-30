// Shapes: a line, rectangle, ellipse or arrow dragged from `a` to `b`.
//
// Pure geometry only — the Shift constraint, the path a shape paints, and the
// same outline as segments for the eraser's hit test. Painting lives in
// paint.ts and the gesture in ink.ts, so the committed shape, the live shape and
// the hit test all walk one definition and cannot disagree about where an arrow
// head is.

import type { ShapeKind, Stroke } from "../../core/types";

/** Arrow head: its length in stroke widths, and the half-angle of each wing
 *  from the shaft. `strokeBounds` (paint.ts) pads by exactly this. */
export const ARROW_HEAD_WIDTHS = 4;
export const ARROW_HEAD_DEG = 28;
/** Segments approximating an ellipse for hit testing. 48 keeps the chord error
 *  under 0.3% of the radius — far inside any eraser's reach. */
const ELLIPSE_HIT_SEGMENTS = 48;

export type Pt = [number, number];
type ShapeStroke = Extract<Stroke, { a: [number, number] }>;

/**
 * Shift held: a line snaps to the nearest 45° (keeping its projected length),
 * a rectangle or ellipse becomes a square or circle (the longer side wins, each
 * axis keeping the direction it was dragged in). An arrow snaps like a line.
 */
export function constrainShape(kind: ShapeKind, a: Pt, b: Pt, shift: boolean): Pt {
  if (!shift) return b;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (kind === "line" || kind === "arrow") {
    const len = Math.hypot(dx, dy);
    if (len === 0) return b;
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    // Project onto the snapped direction: the end stays under the pointer's
    // "reach" along that direction rather than jumping to the full length.
    const along = dx * ux + dy * uy;
    return [a[0] + clean(ux * along), a[1] + clean(uy * along)];
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [a[0] + (dx < 0 ? -side : side), a[1] + (dy < 0 ? -side : side)];
}

/** Kill the float dust cos(π/2) leaves behind, so a vertical line is exactly
 *  vertical. */
function clean(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : v;
}

/** The two wing tips of an arrow whose head sits at `b`, swept back toward `a`. */
export function arrowWings(a: Pt, b: Pt, w: number): [Pt, Pt] | null {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const head = ARROW_HEAD_WIDTHS * w;
  const rad = (ARROW_HEAD_DEG * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [b[0] + head * (ux * cos - uy * sin), b[1] + head * (ux * sin + uy * cos)],
    [b[0] + head * (ux * cos + uy * sin), b[1] + head * (-ux * sin + uy * cos)],
  ];
}

/** Path surface shared by Path2D and a test recorder. */
export interface ShapeSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
}

/** Emit a shape's outline into a path (stroked by the painter with round
 *  joins and caps at lineWidth w). */
export function emitShape(s: ShapeStroke, path: ShapeSink): void {
  const [ax, ay] = s.a;
  const [bx, by] = s.b;
  switch (s.t) {
    case "line":
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
      return;
    case "arrow": {
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
      const wings = arrowWings(s.a, s.b, s.w);
      if (wings) {
        path.moveTo(wings[0][0], wings[0][1]);
        path.lineTo(bx, by);
        path.lineTo(wings[1][0], wings[1][1]);
      }
      return;
    }
    case "rect":
      path.moveTo(ax, ay);
      path.lineTo(bx, ay);
      path.lineTo(bx, by);
      path.lineTo(ax, by);
      path.closePath();
      return;
    case "ellipse": {
      const rx = Math.abs(bx - ax) / 2;
      const ry = Math.abs(by - ay) / 2;
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      path.moveTo(cx + rx, cy);
      path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      path.closePath();
      return;
    }
  }
}

/** The shape as polylines for hit testing: flat [x0,y0,x1,y1,…] per polyline. */
export function shapePolylines(s: ShapeStroke): number[][] {
  const [ax, ay] = s.a;
  const [bx, by] = s.b;
  switch (s.t) {
    case "line":
      return [[ax, ay, bx, by]];
    case "arrow": {
      const wings = arrowWings(s.a, s.b, s.w);
      const out = [[ax, ay, bx, by]];
      if (wings) out.push([wings[0][0], wings[0][1], bx, by, wings[1][0], wings[1][1]]);
      return out;
    }
    case "rect":
      return [[ax, ay, bx, ay, bx, by, ax, by, ax, ay]];
    case "ellipse": {
      const rx = Math.abs(bx - ax) / 2;
      const ry = Math.abs(by - ay) / 2;
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      const line: number[] = [];
      for (let k = 0; k <= ELLIPSE_HIT_SEGMENTS; k++) {
        const t = (Math.PI * 2 * k) / ELLIPSE_HIT_SEGMENTS;
        line.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      }
      return [line];
    }
  }
}

/**
 * The committed shape, or null when the drag was too small to be a shape (a
 * click, or a flick shorter than `minLen` in the stroke's own units): a stray
 * tap must not leave a dot-sized rectangle behind. A line or arrow needs
 * length; a rectangle or ellipse needs both a width and a height.
 */
export function shapeStroke(kind: ShapeKind, c: string, w: number, a: Pt, b: Pt, minLen: number): Stroke | null {
  if (!(w > 0) || ![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return null;
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  if (kind === "line" || kind === "arrow") {
    if (Math.hypot(dx, dy) < minLen) return null;
  } else if (dx < minLen || dy < minLen) {
    return null;
  }
  return { t: kind, c, w, a: [a[0], a[1]], b: [b[0], b[1]] };
}
