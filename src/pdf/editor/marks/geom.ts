// The PDF editor's mark geometry — the PURE half of the marks: page-space
// SVG framing for each display rotation, tool-size conversions, hit testing
// (click, eraser sweep, marquee), the resize handles, the image fit, signature
// normalisation, the ruler's edge snap and the text box's line layout. No DOM,
// nothing at module load, so every rule is pinned by a node test.
//
// Units: PAGE SPACE (src/pdf/types.ts) — points of the UNROTATED page, origin
// at its crop box's top-left, y down. `zoom` = CSS px per point.

import type { PdfAnnot, PdfRotation } from "../../../core/types";
import { annotBounds, type Box } from "../../model";
import { decodePoints, encodePoints } from "../../../image/strokes";
import { segSegDistance } from "../../../image/ink/eraser";
import { arrowWings } from "../../../image/ink/shapes";
import { LINE_HEIGHT, wrapParagraph, wrapRanges, type MeasureRange } from "../../export/layout";
import { simplifyStroke } from "../../../image/ink/input";

/* ------------------------------------------------------------------ */
/* Framing: page space inside the page's on-screen box                 */
/* ------------------------------------------------------------------ */

/** The page's on-screen box in POINTS (its turned size at zoom 1): the SVG's
 *  viewBox, so zoom only changes the SVG's CSS size and never its content. */
export function boxPoints(w: number, h: number, rot: PdfRotation): { W: number; H: number } {
  return rot === 90 || rot === 270 ? { W: h, H: w } : { W: w, H: h };
}

/** The SVG transform taking page space into the box (in points): the same
 *  clockwise turn as the view's `pageToBox` (src/pdf/view/math.ts). */
export function pageTransform(w: number, h: number, rot: PdfRotation): string {
  switch (rot) {
    case 90:
      return `matrix(0 1 -1 0 ${h} 0)`;
    case 180:
      return `matrix(-1 0 0 -1 ${w} ${h})`;
    case 270:
      return `matrix(0 -1 1 0 0 ${w})`;
    default:
      return "";
  }
}

/** Apply `pageTransform`'s matrix to a point (what the SVG does; the tests
 *  compare it with the view's own conversion). */
export function applyPageTransform(x: number, y: number, w: number, h: number, rot: PdfRotation): { x: number; y: number } {
  switch (rot) {
    case 90:
      return { x: -y + h, y: x };
    case 180:
      return { x: -x + w, y: -y + h };
    case 270:
      return { x: y, y: -x + w };
    default:
      return { x, y };
  }
}

/** A display rotation from any multiple of 90 (normalised to 0..270). */
export function normRot(deg: number): PdfRotation {
  return ((((Math.round((Number.isFinite(deg) ? deg : 0) / 90) % 4) + 4) % 4) * 90) as PdfRotation;
}

/** A SCREEN-direction vector (dx right, dy down) on a page shown turned by
 *  `rot`, in page space: the inverse turn of `applyPageTransform`'s linear
 *  part (arrow-key nudges, placing a box beside the click). */
export function screenToPageDelta(dx: number, dy: number, rot: PdfRotation): { x: number; y: number } {
  switch (rot) {
    case 90:
      return { x: dy, y: -dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: -dy, y: dx };
    default:
      return { x: dx, y: dy };
  }
}

/* ------------------------------------------------------------------ */
/* Upright content in a page-space box (`r` on text, image, signature) */
/* ------------------------------------------------------------------ */
//
// THE CONVENTION (shared with the export, src/pdf/export/**): a box mark's
// x/y/w/h stay in page space; its content is drawn in a W×H FRAME where
// (W, H) = (w, h) for r ∈ {0, 180} and (h, w) for r ∈ {90, 270}. The frame's
// top-left sits at (x + w/2 − W/2, y + h/2 − H/2) and the frame is turned by
// −r degrees (clockwise-positive, like /Rotate) about the box centre
// (x + w/2, y + h/2). The page's own turn (+r) then shows it upright. Text
// wraps to W, aligns within W, its rows descend H; a text box grows along the
// frame's DOWN direction (page h for 0/180, page w for 90/270), keeping the
// frame's top edge where it is.

/** The mark's content turn (0 when absent or invalid). */
export function markRot(a: { r?: unknown }): PdfRotation {
  return typeof a.r === "number" ? normRot(a.r) : 0;
}

/** The upright frame size of a box mark (see the convention above). */
export function frameOf(a: { w: number; h: number; r?: unknown }): { W: number; H: number } {
  const r = markRot(a);
  return r === 90 || r === 270 ? { W: a.h, H: a.w } : { W: a.w, H: a.h };
}

/** The frame's page-space rect before its turn, [x, y, W, H] (= the box when r = 0). */
export function frameRect(a: { x: number; y: number; w: number; h: number; r?: unknown }): Box {
  const { W, H } = frameOf(a);
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  return [cx - W / 2, cy - H / 2, W, H];
}

/** The SVG transform turning the frame into the box ("" for r = 0). */
export function frameTransform(a: { x: number; y: number; w: number; h: number; r?: unknown }): string {
  const r = markRot(a);
  if (r === 0) return "";
  const n = (v: number): string => String(Math.round(v * 100) / 100);
  return `rotate(${-r} ${n(a.x + a.w / 2)} ${n(a.y + a.h / 2)})`;
}

/** A page-space box for an upright W×H frame at display turn `rot`. */
export function boxForFrame(W: number, H: number, rot: PdfRotation): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: H, h: W } : { w: W, h: H };
}

/** The geometry patch that makes a box mark's frame `H` tall, growing along
 *  the frame's down direction (its top edge stays put on screen). */
export function withFrameH(a: { x: number; y: number; w: number; h: number; r?: unknown }, H: number): { x: number; y: number; w: number; h: number } {
  const r = markRot(a);
  switch (r) {
    case 90:
      return { x: a.x, y: a.y, w: H, h: a.h };
    case 180:
      return { x: a.x, y: a.y + a.h - H, w: a.w, h: H };
    case 270:
      return { x: a.x + a.w - H, y: a.y, w: H, h: a.h };
    default:
      return { x: a.x, y: a.y, w: a.w, h: H };
  }
}

/** How far the frame of a box mark may extend DOWN (on screen) before it
 *  leaves a pw×ph page: the in-place text editor's room to grow. */
export function frameRoom(a: { x: number; y: number; w: number; h: number; r?: unknown }, pw: number, ph: number): number {
  switch (markRot(a)) {
    case 90:
      return pw - a.x;
    case 180:
      return a.y + a.h;
    case 270:
      return a.x + a.w;
    default:
      return ph - a.y;
  }
}

/** `{ r }` for a mark placed on a page shown turned by `rot`; `{}` at 0, so
 *  an unturned mark carries no key at all. */
export function rotField(rot: PdfRotation): { r?: PdfRotation } {
  const r = normRot(rot);
  return r === 0 ? {} : { r };
}

/* ------------------------------------------------------------------ */
/* Sizes                                                               */
/* ------------------------------------------------------------------ */

/** Tool sizes (ink, eraser, shapes) are CSS px at the current zoom; marks
 *  store points. */
export function cssToPt(css: number, zoom: number): number {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return css / z;
}

/** Stored widths the loader accepts: (0, 1000] points. */
export const WIDTH_MAX_PT = 1000;
export function clampWidthPt(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 0.1;
  return Math.min(Math.max(w, 0.05), WIDTH_MAX_PT);
}

/** The tool size bounds (CSS px) — the image editor's SIZE_MIN/SIZE_MAX
 *  (src/image/tool-state.ts, not importable from the PDF chunk). */
export const SIZE_MIN = 1;
export const SIZE_MAX = 200;
export function clampSize(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), SIZE_MIN), SIZE_MAX) : SIZE_MIN;
}
/** `[` / `]`: one px at a time while small, then ±20 %. */
export function stepSize(v: number, up: boolean): number {
  const s = clampSize(v);
  if (up) return clampSize(s < 10 ? s + 1 : Math.max(s + 1, Math.round(s * 1.2)));
  return clampSize(s <= 10 ? s - 1 : Math.min(s - 1, Math.round(s / 1.2)));
}
export const FONT_MIN = 4;
export const FONT_MAX = 288;
export function clampFont(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(Math.round(v * 2) / 2, FONT_MIN), FONT_MAX) : 12;
}

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

const decoded = new WeakMap<object, Float32Array>();
const NONE = new Float32Array(0);
/** Decoded points of an ink mark, cached per (immutable) mark object. */
export function inkPoints(a: Extract<PdfAnnot, { t: "ink" }>): Float32Array {
  let pts = decoded.get(a);
  if (!pts) {
    pts = decodePoints(a.p) ?? NONE;
    decoded.set(a, pts);
  }
  return pts;
}

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

/** Distance from segment AB to the rectangle [x, y, w, h] (0 when they touch). */
export function segRectDistance(ax: number, ay: number, bx: number, by: number, r: Box): number {
  const [x, y, w, h] = r;
  const x1 = x + w;
  const y1 = y + h;
  const inside = (px: number, py: number): boolean => px >= x && px <= x1 && py >= y && py <= y1;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  return Math.min(
    segSegDistance(ax, ay, bx, by, x, y, x1, y),
    segSegDistance(ax, ay, bx, by, x1, y, x1, y1),
    segSegDistance(ax, ay, bx, by, x1, y1, x, y1),
    segSegDistance(ax, ay, bx, by, x, y1, x, y),
  );
}

/** Polylines of a shape mark, flat [x0, y0, x1, y1, …] each (the image
 *  editor's shapePolylines, over a PdfAnnot). */
export function shapeLines(a: Extract<PdfAnnot, { a: [number, number] }>): number[][] {
  const [ax, ay] = a.a;
  const [bx, by] = a.b;
  switch (a.t) {
    case "line":
      return [[ax, ay, bx, by]];
    case "arrow": {
      const wings = arrowWings(a.a, a.b, a.w);
      const out = [[ax, ay, bx, by]];
      if (wings) out.push([wings[0][0], wings[0][1], bx, by, wings[1][0], wings[1][1]]);
      return out;
    }
    case "rect":
      return [[ax, ay, bx, ay, bx, by, ax, by, ax, ay]];
    default: {
      const rx = Math.abs(bx - ax) / 2;
      const ry = Math.abs(by - ay) / 2;
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      const line: number[] = [];
      for (let k = 0; k <= 48; k++) {
        const t = (Math.PI * 2 * k) / 48;
        line.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      }
      return [line];
    }
  }
}

/** The pencil paints up to 1.5 × its width (PENCIL_MAX_WIDTHS, paint.ts). */
const PENCIL_REACH = 1.5;

/**
 * Does a disk of radius `r` swept from A to B touch the mark? The eraser's
 * test (one move = one segment) and, with A = B, the click test. Ink and
 * shapes are hit along their lines (within half their width); every box mark
 * and a highlight anywhere inside.
 */
export function sweepHit(a: PdfAnnot, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const box = annotBounds(a);
  if (box[2] <= 0 && box[3] <= 0 && a.t !== "ink") return false;
  // bbox reject (the bounds already include half the width)
  const pad = r + (a.t === "ink" && a.kind === "pencil" ? a.w : 0);
  if (Math.max(ax, bx) + pad < box[0] || Math.min(ax, bx) - pad > box[0] + box[2]) return false;
  if (Math.max(ay, by) + pad < box[1] || Math.min(ay, by) - pad > box[1] + box[3]) return false;
  switch (a.t) {
    case "ink": {
      const pts = inkPoints(a);
      const n = pts.length / 3;
      if (n === 0) return false;
      const reach = r + ((a.kind === "pencil" ? PENCIL_REACH : 1) * a.w) / 2;
      if (n === 1) return Math.sqrt(distSqPointSeg(pts[0]!, pts[1]!, ax, ay, bx, by)) <= reach;
      for (let i = 1; i < n; i++) {
        const d = segSegDistance(pts[(i - 1) * 3]!, pts[(i - 1) * 3 + 1]!, pts[i * 3]!, pts[i * 3 + 1]!, ax, ay, bx, by);
        if (d <= reach) return true;
      }
      return false;
    }
    case "line":
    case "arrow":
    case "rect":
    case "ellipse": {
      const reach = r + a.w / 2;
      for (const line of shapeLines(a)) {
        for (let i = 2; i + 1 < line.length; i += 2) {
          if (segSegDistance(line[i - 2]!, line[i - 1]!, line[i]!, line[i + 1]!, ax, ay, bx, by) <= reach) return true;
        }
      }
      return false;
    }
    case "highlight":
      return a.rects.some((rc) => segRectDistance(ax, ay, bx, by, rc) <= r);
    default:
      return segRectDistance(ax, ay, bx, by, [a.x, a.y, a.w, a.h]) <= r;
  }
}

/** The topmost mark under a point (marks draw bottom first), or null. */
export function topmostAt(list: readonly PdfAnnot[], x: number, y: number, tol: number): PdfAnnot | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]!;
    if (sweepHit(a, x, y, x, y, tol)) return a;
  }
  return null;
}

/** Two boxes overlap (touching counts). */
export function boxesTouch(a: Box, b: Box): boolean {
  return a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3];
}

/** A box from two corners. */
export function boxFrom(x0: number, y0: number, x1: number, y1: number): Box {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

/** The marks a marquee touches (by their bounds), bottom first. */
export function marqueeHits(list: readonly PdfAnnot[], m: Box): PdfAnnot[] {
  return list.filter((a) => {
    const b = annotBounds(a);
    return (b[2] > 0 || b[3] > 0) && boxesTouch(b, m);
  });
}

/** The union of the marks' bounds ([0,0,0,0] for none). */
export function unionBounds(list: readonly PdfAnnot[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of list) {
    const [x, y, w, h] = annotBounds(a);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return x1 >= x0 && y1 >= y0 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0];
}

/* ------------------------------------------------------------------ */
/* Resize handles                                                      */
/* ------------------------------------------------------------------ */

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Where each handle sits on a box. */
export function handlePoint(box: Box, h: Handle): [number, number] {
  const [x, y, w, hh] = box;
  const cx = x + w / 2;
  const cy = y + hh / 2;
  switch (h) {
    case "nw":
      return [x, y];
    case "n":
      return [cx, y];
    case "ne":
      return [x + w, y];
    case "e":
      return [x + w, cy];
    case "se":
      return [x + w, y + hh];
    case "s":
      return [cx, y + hh];
    case "sw":
      return [x, y + hh];
    default:
      return [x, cy];
  }
}

/** The handle within `tol` of a point, or null. */
export function handleAt(box: Box, x: number, y: number, tol: number): Handle | null {
  for (const h of HANDLES) {
    const [hx, hy] = handlePoint(box, h);
    if (Math.abs(hx - x) <= tol && Math.abs(hy - y) <= tol) return h;
  }
  return null;
}

/** Smallest side a resize leaves, points. */
export const RESIZE_MIN = 2;

/**
 * The box `from` with handle `h` dragged to (x, y): the opposite edge or
 * corner stays put, a side never shrinks under RESIZE_MIN (no flipping
 * through). `keepAspect` (Shift, or a picture/signature corner) keeps the
 * shape, scaled by the larger of the two axis changes.
 */
export function resizeBox(from: Box, h: Handle, x: number, y: number, keepAspect: boolean): Box {
  const [fx, fy, fw, fh] = from;
  let x0 = fx;
  let y0 = fy;
  let x1 = fx + fw;
  let y1 = fy + fh;
  const west = h === "nw" || h === "w" || h === "sw";
  const east = h === "ne" || h === "e" || h === "se";
  const north = h === "nw" || h === "n" || h === "ne";
  const south = h === "sw" || h === "s" || h === "se";
  if (west) x0 = Math.min(x, x1 - RESIZE_MIN);
  if (east) x1 = Math.max(x, x0 + RESIZE_MIN);
  if (north) y0 = Math.min(y, y1 - RESIZE_MIN);
  if (south) y1 = Math.max(y, y0 + RESIZE_MIN);
  const corner = (west || east) && (north || south);
  if (keepAspect && corner && fw > 0 && fh > 0) {
    const k = Math.max((x1 - x0) / fw, (y1 - y0) / fh);
    const nw = fw * k;
    const nh = fh * k;
    if (west) x0 = x1 - nw;
    else x1 = x0 + nw;
    if (north) y0 = y1 - nh;
    else y1 = y0 + nh;
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/* ------------------------------------------------------------------ */
/* Pictures and signatures                                             */
/* ------------------------------------------------------------------ */

/** A box of aspect `aspect` (w/h) fitting `frac` of a w×h page, centred. */
export function fitCentered(pageW: number, pageH: number, aspect: number, frac: number): Box {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const maxW = pageW * frac;
  const maxH = pageH * frac;
  let w = maxW;
  let h = w / a;
  if (h > maxH) {
    h = maxH;
    w = h * a;
  }
  return [(pageW - w) / 2, (pageH - h) / 2, w, h];
}

/** Aspect bounds of a saved signature (asPdfSignatures in core/session.ts). */
export const SIG_ASPECT_MIN = 0.1;
export const SIG_ASPECT_MAX = 20;

/**
 * Pad strokes ([x, y, pressure]* in pad px) → a saved signature: every
 * stroke simplified (tolerance `tol` pad px), then normalised into the 0..1
 * box of the strokes' own bounds. An aspect outside 0.1..20 widens the
 * narrow side around its centre so the strokes keep their shape. Null when
 * nothing was drawn.
 */
export function normalizeSignature(strokes: readonly Float32Array[], tol: number): { strokes: string[]; aspect: number } | null {
  const kept = strokes.filter((s) => s.length >= 3).map((s) => simplifyStroke(s, s.length / 3, tol));
  if (kept.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of kept) {
    for (let i = 0; i + 2 < s.length; i += 3) {
      x0 = Math.min(x0, s[i]!);
      x1 = Math.max(x1, s[i]!);
      y0 = Math.min(y0, s[i + 1]!);
      y1 = Math.max(y1, s[i + 1]!);
    }
  }
  let w = Math.max(x1 - x0, 1);
  let h = Math.max(y1 - y0, 1);
  const aspect = Math.min(Math.max(w / h, SIG_ASPECT_MIN), SIG_ASPECT_MAX);
  // widen the narrow side about its centre
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (w / h < aspect) w = h * aspect;
  else if (w / h > aspect) h = w / aspect;
  const ox = cx - w / 2;
  const oy = cy - h / 2;
  const out = kept.map((s) => {
    const n = new Float32Array(s.length);
    for (let i = 0; i + 2 < s.length; i += 3) {
      n[i] = (s[i]! - ox) / w;
      n[i + 1] = (s[i + 1]! - oy) / h;
      n[i + 2] = Math.min(Math.max(s[i + 2]!, 0), 1);
    }
    return encodePoints(n);
  });
  return { strokes: out, aspect };
}

/** Signature strokes are a pen of this fraction of the box's smaller side
 *  (min 0.5 pt). MIRRORS `SIGNATURE_WIDTH_FRACTION` in src/pdf/export/marks.ts
 *  — importing it would pull pdf-lib into the editor; a test pins the two. */
export const SIGNATURE_WIDTH_FRACTION = 0.03;
export function signatureWidth(w: number, h: number): number {
  return Math.max(0.5, Math.min(w, h) * SIGNATURE_WIDTH_FRACTION);
}

/** The image editor's marker opacity (MARKER_OPACITY in src/image/ink/ink.ts,
 *  which the PDF chunk may not import). */
export const MARKER_OPACITY = 0.4;
/** The pencil's opacity from its mean pressure (pencilOpacity, ink.ts). */
export function pencilOpacity(meanPressure: number): number {
  const p = Number.isFinite(meanPressure) ? Math.min(Math.max(meanPressure, 0), 1) : 1;
  return 0.3 + 0.7 * p;
}

/* ------------------------------------------------------------------ */
/* Ruler                                                               */
/* ------------------------------------------------------------------ */

export interface RulerPose {
  cx: number;
  cy: number;
  /** radians, clockwise in page space (y down) */
  angle: number;
}
/** The ruler's size on the page, points. */
export const RULER_LEN = 400;
export const RULER_THICK = 44;

/** A point in the ruler's own frame: u along it, v across it (0 = centre). */
export function rulerLocal(r: RulerPose, x: number, y: number): { u: number; v: number } {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const dx = x - r.cx;
  const dy = y - r.cy;
  return { u: dx * c + dy * s, v: -dx * s + dy * c };
}

/** Is a point on the ruler's body? */
export function onRuler(r: RulerPose, x: number, y: number): boolean {
  const { u, v } = rulerLocal(r, x, y);
  return Math.abs(u) <= RULER_LEN / 2 && Math.abs(v) <= RULER_THICK / 2;
}

/** Is a point on the ruler's rotate knob (its right end)? */
export function onRulerKnob(r: RulerPose, x: number, y: number, tol: number): boolean {
  const { u, v } = rulerLocal(r, x, y);
  return Math.abs(u - RULER_LEN / 2) <= Math.max(tol, 10) && Math.abs(v) <= RULER_THICK / 2;
}

/** Which edge a pen landing at (x, y) follows: +1 / -1 (the side), or 0 when
 *  it landed farther than `tol` points outside both. */
export function rulerEdge(r: RulerPose, x: number, y: number, tol: number): 1 | -1 | 0 {
  const { u, v } = rulerLocal(r, x, y);
  if (Math.abs(u) > RULER_LEN / 2 + tol) return 0;
  const out = Math.abs(v) - RULER_THICK / 2;
  if (out < 0 || out > tol) return 0;
  return v > 0 ? 1 : -1;
}

/** A point snapped onto the line `half` points outside the given edge. */
export function snapToRuler(r: RulerPose, edge: 1 | -1, half: number, x: number, y: number): [number, number] {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const { u } = rulerLocal(r, x, y);
  const v = edge * (RULER_THICK / 2 + half);
  return [r.cx + u * c - v * s, r.cy + u * s + v * c];
}

/* ------------------------------------------------------------------ */
/* Text boxes                                                          */
/* ------------------------------------------------------------------ */

export { LINE_HEIGHT };

/** One laid-out line: its text (logical order), its row, and its
 *  PARAGRAPH's direction (the export decides per paragraph, not per line). */
export interface TextLine {
  text: string;
  row: number;
  rtl: boolean;
  /** where the line sits in the box's whole text: `text === whole.slice(s, e)`
   *  (0.9.4 style runs) */
  s: number;
  e: number;
}

/** The paragraphs of a box's text with their offsets: exactly
 *  `text.split(/\r\n|\r|\n/)`, each with where it starts in `text`. */
export function paragraphsOf(text: string): { start: number; para: string }[] {
  const out: { start: number; para: string }[] = [];
  const re = /\r\n|\r|\n/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: at, para: text.slice(at, m.index) });
    at = m.index + m[0].length;
  }
  out.push({ start: at, para: text.slice(at) });
  return out;
}

/** MIRRORS `firstStrongRtl` in src/pdf/export/bidi.ts (which imports bidi-js,
 *  reachable only from the lazy export chunk); a test pins the two. Is the
 *  paragraph right-to-left by its first strong character (UBA P2/P3)? */
const STRONG_RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LETTER = /\p{L}/u;
export function firstStrongRtl(s: string): boolean {
  for (const ch of s) {
    if (STRONG_RTL.test(ch)) return true;
    if (LETTER.test(ch)) return false;
  }
  return false;
}

/** Fonts the export embeds with a regular face only (bold / italic fall back
 *  to it — src-tauri export/builder.rs font_file): the editor shows them
 *  plain too, so the screen is the file. */
export function plainOnly(font: string): boolean {
  return font === "Impact";
}

/**
 * The text box's lines — the export's rule exactly (src/pdf/export/marks.ts
 * textAppearance + layout.ts): paragraphs split on any newline, each wrapped
 * to `w` by `wrapParagraph` with `measure` (width at the box's font and
 * size), one row per line.
 */
export function layoutText(text: string, w: number, measure: (s: string) => number): TextLine[] {
  const out: TextLine[] = [];
  let row = 0;
  for (const { start, para } of paragraphsOf(text)) {
    const rtl = firstStrongRtl(para);
    for (const [s, e] of wrapParagraph(para, w, measure)) out.push({ text: para.slice(s, e), row: row++, rtl, s: start + s, e: start + e });
  }
  return out;
}

/**
 * `layoutText` for a box in several styles (0.9.4 runs): the same paragraphs
 * and the same breaking rule, each paragraph wrapped by `wrapRanges` over the
 * range measure `measureFor` gives for it (`start` = the paragraph's offset
 * in `text`; the ranges it is asked for are offsets INTO the paragraph), so a
 * word that spans two styles wraps by the sum of its pieces, as the export.
 */
export function layoutTextRanges(text: string, w: number, measureFor: (start: number, para: string) => MeasureRange): TextLine[] {
  const out: TextLine[] = [];
  let row = 0;
  for (const { start, para } of paragraphsOf(text)) {
    const rtl = firstStrongRtl(para);
    const m = measureFor(start, para);
    for (const [s, e] of wrapRanges(para, w, m)) out.push({ text: para.slice(s, e), row: row++, rtl, s: start + s, e: start + e });
  }
  return out;
}

/** A line's baseline below the box top: half-leading + ascent (the export's
 *  rule; `asc`/`desc` in points, positive). */
export function lineBaseline(row: number, size: number, asc: number, desc: number): number {
  const lh = size * LINE_HEIGHT;
  return row * lh + (lh - (asc + desc)) / 2 + asc;
}

/** The height a text box needs to show every line. */
export function textHeight(lines: number, size: number): number {
  return Math.max(1, lines) * size * LINE_HEIGHT;
}

/** The CSS font shorthand of a text style (size in points = CSS px in page space).
 *  `alias` = the font runtime's alias of a non-legacy font that is loaded: it
 *  leads, the legacy font follows as the fallback, and bold / italic are the
 *  face the runtime resolved (its four slots hold real faces: no Impact rule).
 *  Without it, exactly the 0.9.3 string. */
export function cssFont(font: string, size: number, bold: boolean, italic: boolean, alias?: string): string {
  if (alias === undefined && plainOnly(font)) bold = italic = false;
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px ${cssFamily(font, alias)}`;
}

/** The CSS font-family of a text style: the legacy font quoted (0.9.3), or
 *  the runtime's alias (needs no quoting) with the legacy font after it. */
export function cssFamily(font: string, alias?: string): string {
  return alias === undefined ? `"${font}"` : `${alias}, "${font}"`;
}

/* ------------------------------------------------------------------ */
/* Moving marks                                                        */
/* ------------------------------------------------------------------ */

/** The geometry fields of a mark, as an updateAnnot patch: what a move or a
 *  resize changes. */
export function geometryPatch(a: PdfAnnot): Record<string, unknown> {
  switch (a.t) {
    case "ink":
      return { p: a.p };
    case "highlight":
      return { rects: a.rects };
    case "line":
    case "arrow":
    case "rect":
    case "ellipse":
      return { a: a.a, b: a.b };
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

/* ------------------------------------------------------------------ */
/* Straight strokes (Shift)                                            */
/* ------------------------------------------------------------------ */

/** The end of a straight stroke from `a` toward `b`, its direction snapped
 *  to 15° steps (the end kept at `b`'s reach along that direction). */
export function snapStraight(a: [number, number], b: [number, number], stepDeg = 15): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return [b[0], b[1]];
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const along = dx * ux + dy * uy;
  const clean = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : v);
  return [a[0] + clean(ux * along), a[1] + clean(uy * along)];
}

/** Is (x, y) on the frame edge of `box` — at most `outside` beyond its
 *  border or `inside` within it (the band a text box being typed in is
 *  grabbed by: wide outside, thin inside, so a click on the text itself
 *  still places the caret)? */
export function onBoxEdge(box: Box, x: number, y: number, outside: number, inside = outside): boolean {
  const [bx, by, bw, bh] = box;
  const inOuter = x >= bx - outside && x <= bx + bw + outside && y >= by - outside && y <= by + bh + outside;
  if (!inOuter) return false;
  const inInner = x > bx + inside && x < bx + bw - inside && y > by + inside && y < by + bh - inside;
  return !inInner;
}
