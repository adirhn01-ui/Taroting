// Native-pixel layer geometry for image projects. Pure.
//
// A layer's on-canvas magnitude is k = transform.scale, in canvas px per
// source px: no fit-to-canvas, and no 0.1-4 clamp (IMAGE_SCALE_GUARD is only a
// crafted-file guard). x/y are the layer centre's offset from the canvas
// centre, in canvas px — the video editor's own convention.
//
// Not implemented yet: the declarations below are the contract the rest of the
// image editor compiles against.

import type { ClipTransform } from "../core/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Layer-local source px → canvas px, native-pixel (k = transform.scale).
 *  Returns [a,b,c,d,e,f] (DOMMatrix order). Crop window centred on (W/2+x, H/2+y). */
export function layerToCanvas(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): [number, number, number, number, number, number];
export function layerToCanvas(): never {
  throw new Error("not implemented");
}

export function canvasToLayer(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
): { x: number; y: number };
export function canvasToLayer(): never {
  throw new Error("not implemented");
}

/** Oriented hit test: is canvas point inside the layer's visible (cropped) box? */
export function hitLayer(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
): boolean;
export function hitLayer(): never {
  throw new Error("not implemented");
}

/** The four corners (canvas px) of the layer's visible box, clockwise from top-left. */
export function layerCorners(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): [number, number][];
export function layerCorners(): never {
  throw new Error("not implemented");
}

/** Crafted-file guard only: a scale outside this is repaired on load. */
export const IMAGE_SCALE_GUARD = { min: 1e-4, max: 1e4 } as const;
