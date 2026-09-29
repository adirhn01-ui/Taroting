// Painting committed strokes onto a drawing layer's raster, and the bounds of
// a stroke (written here: hit testing and the renderer's dirty rects need them
// whatever the painting looks like).
//
// `createScratch` / `paintStroke` are not implemented yet: their declarations
// are the contract the renderer compiles against.

import type { Stroke } from "../../core/types";
import { pointsOf } from "../strokes";
import type { Ctx2D } from "../render";

/** Arrow head: its length in stroke widths, and the half-angle of each wing
 *  from the shaft. Exported so the painter and `strokeBounds` can never
 *  disagree about where the head reaches. */
export const ARROW_HEAD_WIDTHS = 4;
export const ARROW_HEAD_DEG = 28;
/** The pencil's widest mark, in stroke widths (its width follows pressure over
 *  [0.75w, 1.5w]). Every other mark is at most w wide. */
export const PENCIL_MAX_WIDTHS = 1.5;

/** Reusable bbox-sized offscreen scratch (willReadFrequently NOT set). */
export interface Scratch {
  get(w: number, h: number): OffscreenCanvasRenderingContext2D;
}

export function createScratch(): Scratch;
export function createScratch(): never {
  throw new Error("not implemented");
}

/** Paint one committed stroke. ctx transform = layer-local → target; ctx is
 *  the drawing layer's own raster (strict stroke order; erase =
 *  destination-out; marker = destination-over of an opaque scratch at o = 0.4,
 *  so highlighter sits under ink; pencil = opaque scratch → grain
 *  destination-in → composite at o). */
export function paintStroke(ctx: Ctx2D, s: Stroke, scratch: Scratch): void;
export function paintStroke(): never {
  throw new Error("not implemented");
}

type Box = { x: number; y: number; w: number; h: number };

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
    const pts = pointsOf(s);
    for (let i = 0; i + 2 < pts.length; i += 3) add(pts[i]!, pts[i + 1]!);
    pad = ((s.t === "pencil" ? PENCIL_MAX_WIDTHS : 1) * w) / 2;
  } else {
    const [ax, ay] = s.a;
    const [bx, by] = s.b;
    add(ax, ay);
    add(bx, by);
    if (s.t === "arrow") {
      // The head sits at `b`, its wings swept back toward `a`.
      const dx = ax - bx;
      const dy = ay - by;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const ux = dx / len;
        const uy = dy / len;
        const head = ARROW_HEAD_WIDTHS * w;
        const rad = (ARROW_HEAD_DEG * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        add(bx + head * (ux * cos - uy * sin), by + head * (ux * sin + uy * cos));
        add(bx + head * (ux * cos + uy * sin), by + head * (-ux * sin + uy * cos));
      }
    }
    pad = w / 2;
  }

  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}
