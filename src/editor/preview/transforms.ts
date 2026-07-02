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

import type { ClipTransform, MediaRef } from "../../core/types";
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
}

/** Pure math: everything in project-canvas px, pre stage scaling. */
export function computeTransform(
  transform: ClipTransform | undefined,
  media: { width?: number; height?: number },
  project: { width: number; height: number },
): ComputedTransform {
  const t = transform ?? defaultTransform();
  const srcW = Math.max(1, media.width ?? project.width);
  const srcH = Math.max(1, media.height ?? project.height);

  const crop = t.crop ?? { x: 0, y: 0, w: srcW, h: srcH };
  const cropW = Math.max(1, Math.min(crop.w, srcW - crop.x));
  const cropH = Math.max(1, Math.min(crop.h, srcH - crop.y));

  // fit the cropped (and possibly rotated) region into the project canvas
  const rotated = t.rotate === 90 || t.rotate === 270;
  const fitW = rotated ? cropH : cropW;
  const fitH = rotated ? cropW : cropH;
  const fit = Math.min(project.width / fitW, project.height / fitH);
  const k = fit * t.scale;

  return {
    posX: t.x,
    posY: t.y,
    rotate: t.rotate,
    flipH: t.flipH,
    flipV: t.flipV,
    cropW: cropW * k,
    cropH: cropH * k,
    mediaW: srcW * k,
    mediaH: srcH * k,
    offX: 0 - crop.x * k,
    offY: 0 - crop.y * k,
    opacity: t.opacity,
  };
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

/** Convenience: full pipeline for a clip's media on a stage. */
export function styleLayer(
  layer: LayerBoxes,
  transform: ClipTransform | undefined,
  media: MediaRef,
  project: { width: number; height: number },
  stageScale: number,
): void {
  applyTransform(layer, computeTransform(transform, media, project), stageScale);
}
