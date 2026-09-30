// The pen's (and the pencil's) variable-width mark: ONE closed outline around
// the points, filled nonzero.
//
// Why an outline and not `ctx.stroke()` per segment: a stroked polyline has
// one lineWidth, so pressure could only vary by stroking every segment on its
// own — and at any opacity below 1 each overlap (every joint, every place a
// loop crosses itself) would paint twice and show as a darker bead. One filled
// polygon paints every covered pixel exactly once, whatever the stroke does to
// itself: nonzero, not evenodd, because a loop's self-overlap winds twice in the
// same direction and evenodd would punch a hole there.
//
// Shape: a left and a right chain offset by the half-width along the normal
// (centred differences, so a point's normal is the average of the segments on
// either side), joined by 8-segment round caps. Sharp turns also get a round
// join disk — a centred-difference normal cuts the outer corner of a hairpin
// and pinches the mark there. The disks are wound the SAME way as the ribbon
// (see `JOIN_ANTICLOCKWISE`): an opposite winding would cancel to zero under
// nonzero and leave a hole in the ink.
//
// The geometry is computed as plain numbers (`outlinePolygon`) so it can be
// measured in a test; `outlinePath` turns it into the Path2D the painter fills.

/** Round caps are built from this many segments (the spec's 8). */
export const CAP_SEGMENTS = 8;
/** A turn sharper than this (radians between successive segments) gets a
 *  round join disk. ~35°: below it the ribbon's own corner is indistinguishable
 *  from round at any width a pen makes. */
const JOIN_TURN = 0.6;
/** The ribbon is wound with a NEGATIVE shoelace area in raw canvas coordinates
 *  (left chain forward along the stroke, right chain back, with the normal the
 *  tangent turned +90°). `arc(..., anticlockwise = true)` winds the same way, so
 *  under nonzero a join disk unions with the ribbon instead of cancelling it. */
const JOIN_ANTICLOCKWISE = true;
/** A whole circle drawn anticlockwise from angle 0. NEGATIVE on purpose: with
 *  anticlockwise set, canvas treats the arc as the full circumference only when
 *  start − end ≥ 2π; `0 → +2π` would be read as a zero-length arc and draw no
 *  disk at all. */
const FULL_TURN = -Math.PI * 2;

/** Half the mark's width at a given pressure (0..1). */
export type HalfWidth = (pressure: number) => number;

/** Pen: full width at full pressure, a quarter at none — h = w·(0.25+0.75p)/2. */
export function penHalfWidth(w: number): HalfWidth {
  return (p) => (w * (0.25 + 0.75 * p)) / 2;
}

/** Pencil: from 0.75w at no pressure to 1.5w at full (PENCIL_MAX_WIDTHS in
 *  paint.ts is that upper bound, which strokeBounds pads by). */
export function pencilHalfWidth(w: number): HalfWidth {
  return (p) => (w * (0.75 + 0.75 * p)) / 2;
}

export interface Outline {
  /** The closed ribbon + caps, flat [x0, y0, x1, y1, …]. */
  ring: number[];
  /** Index (in POINTS, not values) where the right chain starts in `ring`:
   *  ring[0 .. n) is the left chain, then the end cap, then the right chain
   *  (reversed), then the start cap. Exposed for the width test. */
  leftCount: number;
  rightStart: number;
  /** Round joins at sharp turns: flat [x, y, r]*. */
  joins: number[];
  /** A single point (or a stroke whose points all coincide): a dot. */
  dot: { x: number; y: number; r: number } | null;
}

/**
 * The outline of `count` points of `pts` ([x, y, pressure]*).
 *
 * Allocates one result per call and nothing per point beyond the output arrays,
 * so painting a live stroke is O(points) per frame and a committed stroke's
 * path is built once (the painter caches it per stroke object).
 */
export function outlinePolygon(pts: ArrayLike<number>, count: number, half: HalfWidth): Outline {
  const n = Math.min(count, Math.floor(pts.length / 3));
  const out: Outline = { ring: [], leftCount: 0, rightStart: 0, joins: [], dot: null };
  if (n <= 0) return out;

  // Collapse runs of coincident points: a zero-length segment has no direction.
  const idx: number[] = [0];
  for (let i = 1; i < n; i++) {
    const j = idx[idx.length - 1]!;
    if (pts[i * 3] !== pts[j * 3] || pts[i * 3 + 1] !== pts[j * 3 + 1]) idx.push(i);
  }
  const m = idx.length;
  if (m === 1) {
    // Every point in one place: a dot at the widest pressure seen there.
    let p = 0;
    for (let i = 0; i < n; i++) p = Math.max(p, pts[i * 3 + 2]!);
    out.dot = { x: pts[0]!, y: pts[1]!, r: half(p) };
    return out;
  }

  const X = (k: number): number => pts[idx[k]! * 3]!;
  const Y = (k: number): number => pts[idx[k]! * 3 + 1]!;
  const P = (k: number): number => pts[idx[k]! * 3 + 2]!;

  const nx = new Float64Array(m);
  const ny = new Float64Array(m);
  const h = new Float64Array(m);
  let lastX = 0;
  let lastY = 1;
  for (let k = 0; k < m; k++) {
    const a = k === 0 ? 0 : k - 1;
    const b = k === m - 1 ? m - 1 : k + 1;
    let tx = X(b) - X(a);
    let ty = Y(b) - Y(a);
    const len = Math.hypot(tx, ty);
    if (len > 0) {
      tx /= len;
      ty /= len;
      // normal = tangent turned +90°
      lastX = -ty;
      lastY = tx;
    }
    // A hairpin whose neighbours cancel keeps the previous normal.
    nx[k] = lastX;
    ny[k] = lastY;
    h[k] = half(P(k));
  }

  const ring = out.ring;
  // left chain, forward
  for (let k = 0; k < m; k++) ring.push(X(k) + nx[k]! * h[k]!, Y(k) + ny[k]! * h[k]!);
  out.leftCount = m;
  // end cap: from +n round the front (+t) to −n
  capAround(ring, X(m - 1), Y(m - 1), nx[m - 1]!, ny[m - 1]!, h[m - 1]!);
  out.rightStart = ring.length / 2;
  // right chain, backward
  for (let k = m - 1; k >= 0; k--) ring.push(X(k) - nx[k]! * h[k]!, Y(k) - ny[k]! * h[k]!);
  // start cap: from −n round the back (−t) to +n
  capAround(ring, X(0), Y(0), -nx[0]!, -ny[0]!, h[0]!);

  // Round joins where the path turns sharply.
  for (let k = 1; k < m - 1; k++) {
    const ax = X(k) - X(k - 1);
    const ay = Y(k) - Y(k - 1);
    const bx = X(k + 1) - X(k);
    const by = Y(k + 1) - Y(k);
    const turn = Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
    if (turn > JOIN_TURN) out.joins.push(X(k), Y(k), h[k]!);
  }
  return out;
}

/** The 7 intermediate points of an 8-segment half circle around (cx, cy),
 *  starting at the direction (sx, sy) and turning −90° per 4 segments (i.e.
 *  through the direction (sx, sy) turned −90°), radius r. The endpoints are the
 *  chains' own points, so they are not repeated. */
function capAround(ring: number[], cx: number, cy: number, sx: number, sy: number, r: number): void {
  const start = Math.atan2(sy, sx);
  for (let k = 1; k < CAP_SEGMENTS; k++) {
    const a = start - (Math.PI * k) / CAP_SEGMENTS;
    ring.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

/** The minimal path surface both Path2D and a test recorder provide. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, anticlockwise?: boolean): void;
  closePath(): void;
}

/** Emit an outline into a path: the ring as one closed subpath, then each join
 *  disk (and the dot) as its own closed subpath wound like the ring. */
export function emitOutline(o: Outline, path: PathSink): void {
  if (o.dot) {
    if (o.dot.r > 0) {
      path.moveTo(o.dot.x + o.dot.r, o.dot.y);
      path.arc(o.dot.x, o.dot.y, o.dot.r, 0, FULL_TURN, JOIN_ANTICLOCKWISE);
      path.closePath();
    }
    return;
  }
  const r = o.ring;
  if (r.length < 6) return;
  path.moveTo(r[0]!, r[1]!);
  for (let i = 2; i < r.length; i += 2) path.lineTo(r[i]!, r[i + 1]!);
  path.closePath();
  const j = o.joins;
  for (let i = 0; i < j.length; i += 3) {
    const rad = j[i + 2]!;
    if (!(rad > 0)) continue;
    path.moveTo(j[i]! + rad, j[i + 1]!);
    path.arc(j[i]!, j[i + 1]!, rad, 0, FULL_TURN, JOIN_ANTICLOCKWISE);
    path.closePath();
  }
}

/** A fresh Path2D of the outline. */
export function outlinePath(pts: ArrayLike<number>, count: number, half: HalfWidth): Path2D {
  const path = new Path2D();
  emitOutline(outlinePolygon(pts, count, half), path);
  return path;
}
