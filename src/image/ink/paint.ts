// Painting committed strokes onto a drawing layer's raster, painting the live
// mark while a pointer is down, and the bounds of a stroke (hit testing and the
// renderer's dirty rects need them whatever the painting looks like).
//
// One painter for the preview raster, the live mark and the export, so a stroke
// looks the same in all three:
//   pen    — one filled variable-width outline (outline.ts) at globalAlpha o.
//   pencil — the same outline with a wider pressure range, filled OPAQUE into a
//            bbox-sized scratch, cut through the paper grain (destination-in),
//            then composited at o. The scratch is what keeps the grain from
//            eating earlier ink: destination-in on the raster itself would.
//   marker — one constant-width stroke at o (0.4) with destination-over, so the
//            highlighter sits UNDER the ink already on the layer. A single
//            stroke() call covers its whole area once, so a marker that crosses
//            itself never darkens where it overlaps.
//   erase  — one constant-width stroke with destination-out.
//   shapes — stroked at lineWidth w with round joins and caps.
//
// Every mark multiplies the context's own globalAlpha rather than replacing it,
// saves and restores the context around itself, and leaves no state behind.
// Colours are re-normalized at the sink: an invalid fillStyle string is
// silently ignored by canvas, which would paint the stroke in whatever colour
// the previous one used.

import type { InkKind, Stroke } from "../../core/types";
import { normalizeHexColor } from "../../core/session";
import { pointsOf } from "../strokes";
import type { Ctx2D } from "../render";
import { grainPattern } from "./grain";
import { outlinePath, penHalfWidth, pencilHalfWidth } from "./outline";
import { ARROW_HEAD_DEG, ARROW_HEAD_WIDTHS, arrowWings, emitShape } from "./shapes";

export { ARROW_HEAD_DEG, ARROW_HEAD_WIDTHS };
/** The pencil's widest mark, in stroke widths (its width follows pressure over
 *  [0.75w, 1.5w]). Every other mark is at most w wide. */
export const PENCIL_MAX_WIDTHS = 1.5;

/** Reusable bbox-sized offscreen scratch (willReadFrequently NOT set). */
export interface Scratch {
  get(w: number, h: number): OffscreenCanvasRenderingContext2D;
}

/** A scratch that can also give its pixels back. `release()` is optional to
 *  call: an export that paints thousands of pencil strokes wants the backing
 *  store gone the moment it is done, the preview keeps one for its lifetime. */
export interface ReleasableScratch extends Scratch {
  release(): void;
}

/**
 * One grow-only OffscreenCanvas, handed out cleared, with an identity
 * transform, full alpha and source-over. Grow-only because a pencil drawing is
 * a run of similar-sized strokes: reallocating per stroke would churn the GPU
 * for nothing. It is never larger than the largest stroke box it was asked for,
 * and that box is already clipped to the target by the painter.
 *
 * `get` throws only when the browser refuses to create a 2D context at all (a
 * box beyond its canvas limits); the painter catches that and paints the mark
 * without grain rather than dropping it.
 */
export function createScratch(): ReleasableScratch {
  let canvas: OffscreenCanvas | null = null;
  let g: OffscreenCanvasRenderingContext2D | null = null;
  return {
    get(w: number, h: number): OffscreenCanvasRenderingContext2D {
      const cw = Math.max(1, Math.ceil(w));
      const ch = Math.max(1, Math.ceil(h));
      if (!canvas || !g || canvas.width < cw || canvas.height < ch) {
        const nw = Math.max(cw, canvas?.width ?? 0);
        const nh = Math.max(ch, canvas?.height ?? 0);
        if (canvas) {
          canvas.width = nw;
          canvas.height = nh;
        } else {
          canvas = new OffscreenCanvas(nw, nh);
        }
        g = canvas.getContext("2d");
        if (!g) {
          canvas.width = 0;
          canvas.height = 0;
          canvas = null;
          throw new Error("the drawing scratch could not be created");
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      g.clearRect(0, 0, cw, ch);
      return g;
    },
    release(): void {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      canvas = null;
      g = null;
    },
  };
}

type Box = { x: number; y: number; w: number; h: number };
type Pt = [number, number];
type InkStroke = Extract<Stroke, { p: string }>;
type ShapeStroke = Extract<Stroke, { a: [number, number] }>;

/** A mark still being drawn: points in the target layer's local space, the
 *  first `count` triples of `pts` valid. Painted without any caching — it
 *  changes every frame. */
export interface LiveMark {
  /** "erase" = the pixel eraser's path, cut with destination-out */
  t: InkKind | "erase";
  /** already-validated #rrggbb */
  c: string;
  w: number;
  o: number;
  pts: Float32Array;
  count: number;
}

const paths = new WeakMap<object, Path2D>();

/** Paint one committed stroke. ctx transform = layer-local → target; ctx is
 *  the drawing layer's own raster (strict stroke order; erase =
 *  destination-out; marker = destination-over at o = 0.4, so highlighter sits
 *  under ink; pencil = opaque scratch → grain destination-in → composite at o). */
export function paintStroke(ctx: Ctx2D, s: Stroke, scratch: Scratch): void {
  if (!(s.w > 0) || !Number.isFinite(s.w)) return;
  if ("p" in s) {
    const pts = pointsOf(s);
    const count = pts.length / 3;
    if (count < 1) return;
    let path = paths.get(s);
    if (path === undefined) {
      path = inkPath(s.t, pts, count, s.w);
      paths.set(s, path);
    }
    const dot = dotOf(pts, count);
    if (s.t === "erase") {
      paintErase(ctx, path, s.w, dot);
      return;
    }
    const c = normalizeHexColor(s.c, "#000000");
    paintInk(ctx, s.t, path, c, s.w, clamp01(s.o), strokeBounds(s), dot, scratch);
    return;
  }
  let path = paths.get(s);
  if (path === undefined) {
    path = new Path2D();
    emitShape(s, path);
    paths.set(s, path);
  }
  paintShapePath(ctx, path, normalizeHexColor(s.c, "#000000"), s.w);
}

/** Paint the mark a pointer is still drawing. The renderer hands `ctx` over
 *  as the TARGET LAYER'S OWN scratch — the layer's pixels copied in, transform
 *  layer-local → target — and composites it once afterwards, so the live mark
 *  paints exactly as it will commit: a marker goes under the layer's ink, the
 *  pixel eraser cuts only that layer. */
export function paintLiveMark(ctx: Ctx2D, m: LiveMark, scratch: Scratch): void {
  const count = Math.min(m.count, Math.floor(m.pts.length / 3));
  if (count < 1 || !(m.w > 0)) return;
  const path = inkPath(m.t, m.pts, count, m.w);
  const dot = dotOf(m.pts, count);
  if (m.t === "erase") {
    paintErase(ctx, path, m.w, dot);
    return;
  }
  const pad = ((m.t === "pencil" ? PENCIL_MAX_WIDTHS : 1) * m.w) / 2;
  const box = pointsBox(m.pts, count, pad);
  paintInk(ctx, m.t, path, m.c, m.w, clamp01(m.o), box, dot, scratch);
}

/** Paint a shape that is still being dragged (same look as committed). */
export function paintLiveShape(ctx: Ctx2D, s: ShapeStroke): void {
  if (!(s.w > 0)) return;
  const path = new Path2D();
  emitShape(s, path);
  paintShapePath(ctx, path, normalizeHexColor(s.c, "#000000"), s.w);
}

/* ---------------- the marks ---------------- */

function inkPath(t: InkKind | "erase", pts: Float32Array, count: number, w: number): Path2D {
  if (t === "pen") return outlinePath(pts, count, penHalfWidth(w));
  if (t === "pencil") return outlinePath(pts, count, pencilHalfWidth(w));
  return polylinePath(pts, count);
}

/** A polyline for stroke(): moveTo the first point, lineTo the rest. A single
 *  point (or every point in one place) becomes a zero-area path the painter
 *  turns into a dot, because a zero-length line is dropped by canvas and would
 *  paint nothing — a tap with the marker or the eraser must still mark. */
function polylinePath(pts: Float32Array, count: number): Path2D {
  const path = new Path2D();
  path.moveTo(pts[0]!, pts[1]!);
  for (let i = 1; i < count; i++) path.lineTo(pts[i * 3]!, pts[i * 3 + 1]!);
  return path;
}

/** The point a tap left, when every point sits in one place; else null. */
function dotOf(pts: Float32Array, count: number): Pt | null {
  for (let i = 1; i < count; i++) {
    if (pts[i * 3] !== pts[0] || pts[i * 3 + 1] !== pts[1]) return null;
  }
  return [pts[0]!, pts[1]!];
}

function paintInk(
  ctx: Ctx2D,
  t: InkKind,
  path: Path2D,
  c: string,
  w: number,
  o: number,
  box: Box,
  dot: Pt | null,
  scratch: Scratch,
): void {
  if (o <= 0) return;
  const base = ctx.globalAlpha;
  if (t === "pencil") {
    paintPencil(ctx, path, c, base * o, box, scratch);
    return;
  }
  ctx.save();
  ctx.globalAlpha = base * o;
  if (t === "pen") {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = c;
    ctx.fill(path);
  } else {
    ctx.globalCompositeOperation = "destination-over";
    strokeOrDot(ctx, path, c, w, dot);
  }
  ctx.restore();
}

/** Stroke a polyline at width w with round caps and joins — or, for a tap
 *  (every point in one place), fill the dot it should leave. */
function strokeOrDot(ctx: Ctx2D, path: Path2D, c: string, w: number, dot: Pt | null): void {
  if (dot) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(dot[0], dot[1], w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
}

function paintErase(ctx: Ctx2D, path: Path2D, w: number, dot: Pt | null): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  // Erasing is all-or-nothing whatever alpha the caller left set.
  ctx.globalAlpha = 1;
  strokeOrDot(ctx, path, "#000000", w, dot);
  ctx.restore();
}

function paintShapePath(ctx: Ctx2D, path: Path2D, c: string, w: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

/**
 * Pencil: the outline filled opaque into a scratch sized to the stroke's box in
 * TARGET pixels (clipped to the target, so an off-screen stroke costs nothing),
 * cut through the grain, then drawn back at `alpha`. The grain is filled in
 * layer-local coordinates, so it is anchored to the drawing, not to the screen.
 */
function paintPencil(ctx: Ctx2D, path: Path2D, c: string, alpha: number, box: Box, scratch: Scratch): void {
  const dev = deviceBox(ctx, box);
  if (!dev) return;
  const m = ctx.getTransform();
  let sc: OffscreenCanvasRenderingContext2D | null = null;
  try {
    sc = scratch.get(dev.w, dev.h);
  } catch {
    sc = null;
  }
  if (!sc) {
    // No scratch to be had (a box past the browser's canvas limits): paint the
    // mark without grain rather than lose it.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = c;
    ctx.fill(path);
    ctx.restore();
    return;
  }
  sc.setTransform(m.a, m.b, m.c, m.d, m.e - dev.x, m.f - dev.y);
  sc.fillStyle = c;
  sc.fill(path);
  const grain = grainPattern(sc);
  if (grain) {
    sc.globalCompositeOperation = "destination-in";
    sc.fillStyle = grain;
    sc.fillRect(box.x, box.y, box.w, box.h);
    sc.globalCompositeOperation = "source-over";
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = alpha;
  ctx.drawImage(sc.canvas, 0, 0, dev.w, dev.h, dev.x, dev.y, dev.w, dev.h);
  ctx.restore();
}

/** A layer-local box → the integer target-pixel box it covers (one pixel of
 *  antialiasing margin), clipped to the target; null when nothing of it is on
 *  the target. */
export function deviceBox(ctx: Ctx2D, box: Box): Box | null {
  const m = ctx.getTransform();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const corners = [box.x, box.y, box.x + box.w, box.y, box.x, box.y + box.h, box.x + box.w, box.y + box.h];
  for (let i = 0; i < 8; i += 2) {
    const x = m.a * corners[i]! + m.c * corners[i + 1]! + m.e;
    const y = m.b * corners[i]! + m.d * corners[i + 1]! + m.f;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const bx = Math.max(0, Math.floor(x0) - 1);
  const by = Math.max(0, Math.floor(y0) - 1);
  const ex = Math.min(W, Math.ceil(x1) + 1);
  const ey = Math.min(H, Math.ceil(y1) + 1);
  if (!(ex > bx) || !(ey > by)) return null;
  return { x: bx, y: by, w: ex - bx, h: ey - by };
}

/** Box of the first `count` points, padded by `pad` on every side. */
export function pointsBox(pts: Float32Array, count: number, pad: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = pts[i * 3]!;
    const y = pts[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
}

/* ---------------- bounds ---------------- */

const bounds = new WeakMap<object, Box>();

/** Layer-local bounds of everything a stroke can paint, half-width included:
 *  the points' box for ink and erase strokes, the endpoints' box for shapes
 *  (plus both arrow-head wings for an arrow). Conservative, never short: a
 *  mark may paint less than this box, never more. Cached per stroke object —
 *  strokes are immutable. A stroke with nothing decodable is an empty box at
 *  the origin. */
export function strokeBounds(s: Stroke): Box {
  let b = bounds.get(s);
  if (b === undefined) {
    b = computeBounds(s);
    bounds.set(s, b);
  }
  return b;
}

function computeBounds(s: Stroke): Box {
  const w = Number.isFinite(s.w) && s.w > 0 ? s.w : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  let pad: number;
  if ("p" in s) {
    const pts = pointsOf(s as InkStroke);
    for (let i = 0; i + 2 < pts.length; i += 3) add(pts[i]!, pts[i + 1]!);
    pad = ((s.t === "pencil" ? PENCIL_MAX_WIDTHS : 1) * w) / 2;
  } else {
    add(s.a[0], s.a[1]);
    add(s.b[0], s.b[1]);
    if (s.t === "arrow") {
      const wings = arrowWings(s.a, s.b, w);
      if (wings) {
        add(wings[0][0], wings[0][1]);
        add(wings[1][0], wings[1][1]);
      }
    }
    pad = w / 2;
  }

  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}
