// Native-pixel layer geometry for image projects. Pure.
//
// A layer's on-canvas magnitude is k = transform.scale, in canvas px per
// source px: no fit-to-canvas, and no 0.1-4 clamp (IMAGE_SCALE_GUARD is only a
// crafted-file guard). x/y are the layer centre's offset from the canvas
// centre, in canvas px — the video editor's own convention.
//
// The matrix is the video preview's box stack (editor/preview/transforms.ts)
// with fit ≡ 1, written out as one affine map from LAYER-LOCAL source px
// (origin = the media box's top-left, the space ClipCrop and strokes live in)
// to canvas px (origin = the canvas's top-left):
//
//   M = T(W/2 + x, H/2 + y) · R(rotate) · F(flipH, flipV) · S(k) · T(−cx, −cy)
//
// where (cx, cy) is the centre of the crop window — the crop clamped into the
// media box exactly as `computeTransformInto` clamps it, defaulting to the
// whole box. R is CSS's clockwise rotation in a y-down space and it is applied
// OUTSIDE the flip (the preview writes `rotate(θ) scale(±1, ±1)`), which is
// what the whole-image rotate/flip formulas in layers.ts rely on.
//
// Rotation is one of four quarter turns, so the sines and cosines come from a
// table: exact zeros, never 6e-17, so a layer that should sit on whole pixels
// does.

import type { ClipTransform } from "../core/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Crafted-file guard only: a scale outside this is repaired on load. */
export const IMAGE_SCALE_GUARD = { min: 1e-4, max: 1e4 } as const;

type Affine = [number, number, number, number, number, number];

/** [cos, sin] of each legal quarter turn; anything else reads as 0°, the
 *  same rule `sanitizeTransform` applies on load. */
function turn(rotate: number): [number, number] {
  switch (rotate) {
    case 90:
      return [0, 1];
    case 180:
      return [-1, 0];
    case 270:
      return [0, -1];
    default:
      return [1, 0];
  }
}

/** The visible (cropped) box in layer-local source px: the crop clamped into
 *  the media box, never narrower than one px — `computeTransformInto`'s rule,
 *  so the image editor and the video preview agree about what a crop shows. */
export function visibleBox(t: ClipTransform, srcW: number, srcH: number): Rect {
  // `> 1 ? : 1`, not Math.max: a photo whose size is not known yet (NaN) must
  // map as a 1 px box, and Math.max(1, NaN) is NaN.
  const w = srcW > 1 ? srcW : 1;
  const h = srcH > 1 ? srcH : 1;
  const c = t.crop;
  if (!c) return { x: 0, y: 0, w, h };
  return {
    x: c.x,
    y: c.y,
    w: Math.max(1, Math.min(c.w, w - c.x)),
    h: Math.max(1, Math.min(c.h, h - c.y)),
  };
}

/** A usable magnitude: a scale that could not describe one (0, negative,
 *  non-finite) maps as 1 so the inverse always exists. validateImageProject
 *  repairs the stored value; this only keeps a render or hit test from
 *  producing NaN before that has run. */
function magnitude(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Layer-local source px → canvas px, native-pixel (k = transform.scale).
 *  Returns [a,b,c,d,e,f] (DOMMatrix order: x' = a·x + c·y + e,
 *  y' = b·x + d·y + f). Crop window centred on (W/2+x, H/2+y). */
export function layerToCanvas(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): Affine {
  const [cos, sin] = turn(t.rotate);
  const k = magnitude(t.scale);
  const fx = t.flipH ? -k : k;
  const fy = t.flipV ? -k : k;
  // `+ 0` turns a −0 (0 × −k) into 0, so equal poses compare equal.
  const a = cos * fx + 0;
  const b = sin * fx + 0;
  const c = -sin * fy + 0;
  const d = cos * fy + 0;
  const box = visibleBox(t, srcW, srcH);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return [a, b, c, d, canvasW / 2 + t.x - (a * cx + c * cy), canvasH / 2 + t.y - (b * cx + d * cy)];
}

/** Canvas px → layer-local source px: the exact inverse of `layerToCanvas`. */
export function canvasToLayer(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = layerToCanvas(t, srcW, srcH, canvasW, canvasH);
  // The linear part is ±k times a rotation or reflection: det = ±k², never 0.
  const det = a * d - b * c;
  const dx = px - e;
  const dy = py - f;
  return { x: (d * dx - c * dy) / det, y: (a * dy - b * dx) / det };
}

/** Oriented hit test: is canvas point inside the layer's visible (cropped)
 *  box? Maps the point into layer space and tests it against the crop rect, so
 *  a rotated or flipped layer is hit by its real outline, not an AABB. Edges
 *  count as inside. */
export function hitLayer(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
): boolean {
  const p = canvasToLayer(t, srcW, srcH, canvasW, canvasH, px, py);
  const box = visibleBox(t, srcW, srcH);
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

/** The four corners (canvas px) of the layer's visible box: its layer-local
 *  top-left, top-right, bottom-right, bottom-left, in that order (clockwise in
 *  layer space; a flipped layer's list runs anticlockwise on the canvas). */
export function layerCorners(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): [number, number][] {
  const [a, b, c, d, e, f] = layerToCanvas(t, srcW, srcH, canvasW, canvasH);
  const box = visibleBox(t, srcW, srcH);
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  const at = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
}
