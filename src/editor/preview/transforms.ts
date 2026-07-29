// Clip transform → CSS mapping for the preview stage.
//
// The layer DOM is three nested boxes so the math composes exactly like the
// export filter chain (crop → rotate/flip → scale-to-fit × userScale →
// position → opacity):
//
//   pos  — a zero-size anchor at canvas center, translated by (x, y)
//   rot  — rotate + flip around the anchor, carries opacity
//   crop — the cropped region box, centered on the anchor, overflow hidden
//   media — full frame, shifted so the crop window shows
//
// All sizes are computed in project-canvas pixels, then multiplied by the
// stage scale (how large the canvas is rendered on screen).

import type { ClipTransform } from "../../core/types";
import { defaultTransform } from "../../core/project";

export interface LayerBoxes {
  pos: HTMLElement;
  rot: HTMLElement;
  crop: HTMLElement;
  media: HTMLElement; // <video> or <img>
}

export interface ComputedTransform {
  posX: number;
  posY: number;
  rotate: number;
  flipH: boolean;
  flipV: boolean;
  cropW: number;
  cropH: number;
  mediaW: number;
  mediaH: number;
  offX: number;
  offY: number;
  opacity: number;
  /** The composite magnitude factor fit * userScale, in project px per source
   *  px. cropW/mediaW already bake it in; it is exposed for layers that must be
   *  SCALED rather than resized (see applyIntrinsicScale). */
  k: number;
}

/** Alloc-free core: writes the computed transform into a caller-owned scratch
 *  object. `overrides` (when provided) replace the static x / y / scale /
 *  opacity — this is how keyframe playback injects the interpolated pose
 *  without touching the clip. Everything is project-canvas px, pre stage
 *  scaling. */
export function computeTransformInto(
  out: ComputedTransform,
  transform: ClipTransform | undefined,
  media: { width?: number; height?: number },
  project: { width: number; height: number },
  overrides?: { x?: number; y?: number; scale?: number; opacity?: number },
): void {
  const t = transform ?? defaultTransform();
  const srcW = Math.max(1, media.width ?? project.width);
  const srcH = Math.max(1, media.height ?? project.height);

  const x = overrides?.x ?? t.x;
  const y = overrides?.y ?? t.y;
  const scale = overrides?.scale ?? t.scale;
  const opacity = overrides?.opacity ?? t.opacity;

  const crop = t.crop ?? { x: 0, y: 0, w: srcW, h: srcH };
  const cropW = Math.max(1, Math.min(crop.w, srcW - crop.x));
  const cropH = Math.max(1, Math.min(crop.h, srcH - crop.y));

  // fit the cropped (and possibly rotated) region into the project canvas
  const rotated = t.rotate === 90 || t.rotate === 270;
  const fitW = rotated ? cropH : cropW;
  const fitH = rotated ? cropW : cropH;
  const fit = Math.min(project.width / fitW, project.height / fitH);
  const k = fit * scale;

  out.posX = x;
  out.posY = y;
  out.rotate = t.rotate;
  out.flipH = t.flipH;
  out.flipV = t.flipV;
  out.cropW = cropW * k;
  out.cropH = cropH * k;
  out.mediaW = srcW * k;
  out.mediaH = srcH * k;
  out.offX = 0 - crop.x * k;
  out.offY = 0 - crop.y * k;
  out.opacity = opacity;
  out.k = k;
}

/** Pure math: everything in project-canvas px, pre stage scaling. */
export function computeTransform(
  transform: ClipTransform | undefined,
  media: { width?: number; height?: number },
  project: { width: number; height: number },
): ComputedTransform {
  const out: ComputedTransform = {
    posX: 0, posY: 0, rotate: 0, flipH: false, flipV: false,
    cropW: 0, cropH: 0, mediaW: 0, mediaH: 0, offX: 0, offY: 0, opacity: 1, k: 1,
  };
  computeTransformInto(out, transform, media, project);
  return out;
}

/** Apply a computed transform to a layer at the given stage scale. */
export function applyTransform(layer: LayerBoxes, c: ComputedTransform, stageScale: number): void {
  const s = stageScale;
  layer.pos.style.transform = `translate(${c.posX * s}px, ${c.posY * s}px)`;

  const flip = `scale(${c.flipH ? -1 : 1}, ${c.flipV ? -1 : 1})`;
  layer.rot.style.transform = `rotate(${c.rotate}deg) ${flip}`;
  layer.rot.style.opacity = String(c.opacity);

  layer.crop.style.width = `${c.cropW * s}px`;
  layer.crop.style.height = `${c.cropH * s}px`;
  layer.crop.style.transform = "translate(-50%, -50%)";

  layer.media.style.width = `${c.mediaW * s}px`;
  layer.media.style.height = `${c.mediaH * s}px`;
  layer.media.style.transform = `translate(${c.offX * s}px, ${c.offY * s}px)`;
}

/** Generated media renders at intrinsic px, so it must be SCALED, not resized:
 *  keep the box at source size and apply k * stageScale.
 *
 *  Resizing works for <video>/<img> because the raster content stretches with
 *  the box, but a <div>'s width says nothing about its glyphs — a text
 *  generator resized to mediaW*s keeps drawing sizePx-tall letters inside a
 *  correctly-sized box. Composing translate() with scale() (transform-origin
 *  0 0, see .stage-layer__gen) reproduces applyTransform's exact geometry —
 *  top-left at (offX*s, offY*s), extent srcW*k*s — while actually scaling the
 *  content. Call it AFTER applyTransform: it deliberately overwrites the
 *  width/height/transform that applyTransform just wrote. */
export function applyIntrinsicScale(
  el: HTMLElement, c: ComputedTransform, srcW: number, srcH: number, s: number,
): void {
  el.style.width = `${srcW}px`;
  el.style.height = `${srcH}px`;
  el.style.transform = `translate(${c.offX * s}px, ${c.offY * s}px) scale(${c.k * s})`;
}
