// The pen's (and the pencil's) variable-width mark: closed outlines around the
// points, filled nonzero as ONE path.
//
// Why an outline and not `ctx.stroke()` per segment: a stroked polyline has
// one lineWidth, so pressure could only vary by stroking every segment on its
// own — and at any opacity below 1 each overlap (every joint, every place a
// loop crosses itself) would paint twice and show as a darker bead. One filled
// path paints every covered pixel exactly once, whatever the stroke does to
// itself: nonzero, not evenodd, because a loop's self-overlap winds twice in the
// same direction and evenodd would punch a hole there.
//
// Shape: a left and a right chain offset by the half-width along the normal
// (centred differences, so a point's normal is the average of the segments on
// either side), joined by 8-segment round caps.
//
// A SHARP turn (past JOIN_TURN) splits the outline into separate sub-rings,
// each with its own round caps; the two caps meeting at the turn are its round
// join. One ribbon cannot follow a sharp turn. Past 90° the centred tangent can
// point against one of the two segments, the ribbon twists (its chains swap
// sides), and the twisted piece winds the other way and cancels the ink under
// it: ink along the ruler doubles back on one line every time the hand goes
// back and forth, and once simplified each reversal is a single 180° cusp —
// one ribbon filled it as a thin line with wedge-shaped blanks. Between 35°
// and 90° the ribbon holds together but its corner normal is the bisector, so
// the offset there sits only h·cos(θ/2) off each segment and the mark visibly
// thins into the corner. Split, every run's end normal is its own segment's,
// so the mark keeps its full width right up to the round join. Every sub-ring
// is wound like the others (left chain forward, right chain back), so nonzero
// unions them. A gentle curve (every turn under JOIN_TURN) is one ring, exactly
// as before.
//
// The geometry is computed as plain numbers (`outlinePolygon`) so it can be
// measured in a test; `outlinePath` turns it into the Path2D the painter fills.

/** Round caps are built from this many segments (the spec's 8). */
export const CAP_SEGMENTS = 8;
/** A turn sharper than this (radians between successive segments) splits the
 *  outline. ~35°: below it the corner thins by under 5% of the width
 *  (1 − cos 17.5°), which no pen width makes visible. */
const JOIN_TURN = 0.6;
/** The rings are wound with a NEGATIVE shoelace area in raw canvas coordinates
 *  (left chain forward along the stroke, right chain back, with the normal the
 *  tangent turned +90°). A dot is drawn with `arc(..., anticlockwise = true)`,
 *  which winds the same way. */
const DOT_ANTICLOCKWISE = true;
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
  /** The closed sub-rings (ribbon + caps each), flat [x0, y0, x1, y1, …], one
   *  after another. */
  ring: number[];
  /** Where each sub-ring ends in `ring`, in POINTS (exclusive): one entry for
   *  a stroke without sharp turns, one more per sharp turn. */
  ends: number[];
  /** Index (in POINTS, not values) where the FIRST sub-ring's right chain
   *  starts in `ring`: ring[0 .. leftCount) is its left chain, then the end
   *  cap, then the right chain (reversed), then the start cap. Exposed for the
   *  width test. */
  leftCount: number;
  rightStart: number;
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
  const out: Outline = { ring: [], ends: [], leftCount: 0, rightStart: 0, dot: null };
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
  for (let k = 0; k < m; k++) h[k] = half(P(k));

  // One sub-ring per run [s .. e] between sharp turns. For the incoming
  // segment a and the outgoing b (lengths La, Lb, turn θ) the centred tangent
  // a·La + b·Lb points against b when La·cosθ + Lb < 0 and against a when
  // La + Lb·cosθ < 0: both need θ > 90°, and past 90° some ratio of La to Lb
  // always twists the ribbon (a long line that doubles back a little way). The
  // split happens earlier, at JOIN_TURN, for the thinning (see the header).
  const ring = out.ring;
  let s = 0;
  while (s < m - 1) {
    let e = s + 1;
    for (; e < m - 1; e++) {
      const ax = X(e) - X(e - 1);
      const ay = Y(e) - Y(e - 1);
      const bx = X(e + 1) - X(e);
      const by = Y(e + 1) - Y(e);
      if (Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) > JOIN_TURN) break;
    }

    // Normals with the neighbours clamped to the run: one-sided at its ends,
    // so a cap at a cusp faces its own segment.
    let lastX = 0;
    let lastY = 1;
    for (let k = s; k <= e; k++) {
      const a = k === s ? s : k - 1;
      const b = k === e ? e : k + 1;
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
      // Neighbours that cancel (a hairpin — split off above, so only a
      // defensive case here) keep the previous normal.
      nx[k] = lastX;
      ny[k] = lastY;
    }

    // left chain, forward
    for (let k = s; k <= e; k++) ring.push(X(k) + nx[k]! * h[k]!, Y(k) + ny[k]! * h[k]!);
    // end cap: from +n round the front (+t) to −n
    capAround(ring, X(e), Y(e), nx[e]!, ny[e]!, h[e]!);
    if (s === 0) {
      out.leftCount = e + 1;
      out.rightStart = ring.length / 2;
    }
    // right chain, backward
    for (let k = e; k >= s; k--) ring.push(X(k) - nx[k]! * h[k]!, Y(k) - ny[k]! * h[k]!);
    // start cap: from −n round the back (−t) to +n
    capAround(ring, X(s), Y(s), -nx[s]!, -ny[s]!, h[s]!);
    out.ends.push(ring.length / 2);
    s = e;
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

/** Emit an outline into a path: each sub-ring as one closed subpath, or the
 *  dot as its own. */
export function emitOutline(o: Outline, path: PathSink): void {
  if (o.dot) {
    if (o.dot.r > 0) {
      path.moveTo(o.dot.x + o.dot.r, o.dot.y);
      path.arc(o.dot.x, o.dot.y, o.dot.r, 0, FULL_TURN, DOT_ANTICLOCKWISE);
      path.closePath();
    }
    return;
  }
  const r = o.ring;
  let from = 0;
  for (let e = 0; e < o.ends.length; e++) {
    const to = o.ends[e]!;
    if (to - from >= 3) {
      path.moveTo(r[from * 2]!, r[from * 2 + 1]!);
      for (let i = from + 1; i < to; i++) path.lineTo(r[i * 2]!, r[i * 2 + 1]!);
      path.closePath();
    }
    from = to;
  }
}

/** A fresh Path2D of the outline. */
export function outlinePath(pts: ArrayLike<number>, count: number, half: HalfWidth): Path2D {
  const path = new Path2D();
  emitOutline(outlinePolygon(pts, count, half), path);
  return path;
}
