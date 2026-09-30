// Pointer input for ink: turning a gesture's pointer events into the points of
// one stroke. Pure (no DOM, no project) so each rule can be pinned by a test.
//
//   collectPoints — every sample of a move, including the ones the browser
//                   coalesced into it (a pen reports at 240 Hz; one pointermove
//                   per frame would throw three of every four samples away and
//                   turn curves into polygons).
//   StrokeSampler — EMA smoothing + a minimum spacing, in CANVAS px.
//   simplifyStroke — Ramer–Douglas–Peucker on release, keeping the ends and the
//                   pressure extremes (a pen's width comes from pressure: a
//                   point that looks redundant in x/y can still be the widest
//                   place in the mark).
//   PalmFilter    — the pen-and-touch rules: a palm resting while you write must
//                   not draw.

/** The part of a PointerEvent the sampler reads. */
export interface PointerSample {
  clientX: number;
  clientY: number;
  pressure: number;
  pointerType: string;
}

/** EMA weight of the NEW sample: a pen's own samples are clean and dense, so it
 *  follows closely; a mouse or a finger jitters and is smoothed harder. */
export const EMA_PEN = 0.5;
export const EMA_OTHER = 0.35;
/** Samples closer than this (SCREEN css px) to the previous kept point are
 *  dropped: they add nothing a viewer could see and cost outline vertices. */
export const MIN_SPACING_CSS = 0.5;
/** RDP tolerance on release, in SCREEN css px. */
export const SIMPLIFY_CSS = 0.25;
/** A pressure change of this much counts like one tolerance of distance in
 *  RDP's error, so a swell in the middle of a straight line is kept. */
const PRESSURE_TOLERANCE = 0.04;

/**
 * Every sample of one pointermove, oldest first. Coalesced samples when the
 * browser provides them — but NEVER an empty list: synthetic events, some
 * drivers and an event the browser did not coalesce all return `[]`, and a move
 * that yields nothing would silently drop the whole gesture after its first
 * point.
 */
export function collectPoints<E extends PointerSample & { getCoalescedEvents?: () => E[] }>(e: E): E[] {
  let list: E[] | undefined;
  try {
    list = e.getCoalescedEvents?.();
  } catch {
    list = undefined;
  }
  return list && list.length > 0 ? list : [e];
}

/** Pen pressure, or full pressure for anything that has none worth reading (a
 *  mouse reports a constant 0.5 while pressed; a finger 0 or 0.5 by driver). */
export function pressureOf(e: Pick<PointerSample, "pressure" | "pointerType">): number {
  if (e.pointerType !== "pen") return 1;
  const p = e.pressure;
  return Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : 1;
}

/**
 * Accumulates one stroke's points ([x, y, pressure]* in canvas px) as they
 * arrive. Smoothing is an exponential moving average on all three channels; the
 * first sample is taken as-is so the mark starts exactly where the pen landed.
 * Storage doubles as needed — no allocation per sample.
 */
export class StrokeSampler {
  private buf = new Float32Array(3 * 64);
  private n = 0;
  private sx = 0;
  private sy = 0;
  private sp = 0;
  private started = false;

  /**
   * @param alpha EMA weight of each new sample (0..1]
   * @param minSpacing drop a sample closer than this to the last kept point
   */
  constructor(
    private readonly alpha: number,
    private readonly minSpacing: number,
  ) {}

  get count(): number {
    return this.n;
  }

  /** The live buffer: only the first `count` triples are valid. */
  get points(): Float32Array {
    return this.buf;
  }

  /** Smooth and (maybe) keep one sample. True when a point was added. */
  push(x: number, y: number, p: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const pr = Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : 1;
    if (!this.started) {
      this.started = true;
      this.sx = x;
      this.sy = y;
      this.sp = pr;
      this.append(x, y, pr);
      return true;
    }
    const a = this.alpha;
    this.sx += a * (x - this.sx);
    this.sy += a * (y - this.sy);
    this.sp += a * (pr - this.sp);
    return this.keep(this.sx, this.sy, this.sp);
  }

  /** The pointer lifted here: land the stroke on the real last position rather
   *  than where the smoothing had got to (an EMA always trails). */
  finish(x: number, y: number, p: number): void {
    if (!this.started || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const pr = Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : this.sp;
    this.keep(x, y, pr);
  }

  /** Mean pressure of the kept points (the pencil's opacity reads it). */
  meanPressure(): number {
    if (this.n === 0) return 1;
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += this.buf[i * 3 + 2]!;
    return sum / this.n;
  }

  private keep(x: number, y: number, p: number): boolean {
    const i = (this.n - 1) * 3;
    const dx = x - this.buf[i]!;
    const dy = y - this.buf[i + 1]!;
    if (dx * dx + dy * dy < this.minSpacing * this.minSpacing) {
      // Too close to move the mark, but a pressure swing in place still
      // matters to its width: keep the strongest pressure seen there.
      if (p > this.buf[i + 2]!) this.buf[i + 2] = p;
      return false;
    }
    this.append(x, y, p);
    return true;
  }

  private append(x: number, y: number, p: number): void {
    if ((this.n + 1) * 3 > this.buf.length) {
      const next = new Float32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    const i = this.n * 3;
    this.buf[i] = x;
    this.buf[i + 1] = y;
    this.buf[i + 2] = p;
    this.n++;
  }
}

/**
 * Ramer–Douglas–Peucker over the first `count` points of `pts`, tolerance `tol`
 * (same units as x/y). Keeps both ends and the points of lowest and highest
 * pressure unconditionally, and measures each point's error as the larger of
 * its distance from the chord and its pressure's departure from the chord's
 * interpolated pressure (scaled so PRESSURE_TOLERANCE reads as one `tol`).
 * Iterative (an explicit stack), so a 20k-point stroke cannot overflow.
 */
export function simplifyStroke(pts: Float32Array, count: number, tol: number): Float32Array {
  const n = Math.min(count, Math.floor(pts.length / 3));
  if (n <= 2 || !(tol > 0)) return pts.slice(0, n * 3);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i * 3 + 2]! < pts[lo * 3 + 2]!) lo = i;
    if (pts[i * 3 + 2]! > pts[hi * 3 + 2]!) hi = i;
  }
  keep[lo] = 1;
  keep[hi] = 1;

  const pScale = tol / PRESSURE_TOLERANCE;
  const stack: number[] = [];
  // Seed the stack with the spans between the forced anchors.
  let prev = 0;
  for (let i = 1; i < n; i++) {
    if (keep[i]) {
      if (i - prev > 1) stack.push(prev, i);
      prev = i;
    }
  }
  while (stack.length > 0) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = pts[a * 3]!;
    const ay = pts[a * 3 + 1]!;
    const ap = pts[a * 3 + 2]!;
    const bx = pts[b * 3]!;
    const by = pts[b * 3 + 1]!;
    const bp = pts[b * 3 + 2]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstErr = tol;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 3]!;
      const py = pts[i * 3 + 1]!;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      const dist = Math.sqrt(ex * ex + ey * ey);
      const f = (i - a) / (b - a);
      const perr = Math.abs(pts[i * 3 + 2]! - (ap + f * (bp - ap))) * pScale;
      const err = dist > perr ? dist : perr;
      if (err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      if (worst - a > 1) stack.push(a, worst);
      if (b - worst > 1) stack.push(worst, b);
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i]!;
  const out = new Float32Array(m * 3);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[j++] = pts[i * 3]!;
    out[j++] = pts[i * 3 + 1]!;
    out[j++] = pts[i * 3 + 2]!;
  }
  return out;
}

/** Touch pointerdowns this soon after any pen activity are a palm. */
export const PALM_WINDOW_MS = 800;

/**
 * The pen-and-touch rules, for one editor session:
 *  - a touch pointerdown within PALM_WINDOW_MS of any pen activity (contact OR
 *    hover — a pen in range is exactly when a palm lands) is ignored;
 *  - once a pen has been seen, touch never draws again this session (a device
 *    with a pen is written on with the pen; the fingers pan and zoom);
 *  - mouse and pen always draw.
 */
export class PalmFilter {
  private lastPen = -Infinity;
  private penSeen = false;

  /** Feed EVERY pointer event the surface sees, hover included. */
  note(pointerType: string, now: number): void {
    if (pointerType === "pen") {
      this.penSeen = true;
      this.lastPen = now;
    }
  }

  /** May a pointerdown of this type start a mark? */
  mayDraw(pointerType: string, now: number): boolean {
    if (pointerType !== "touch") return true;
    if (this.penSeen) return false;
    return now - this.lastPen >= PALM_WINDOW_MS;
  }
}
