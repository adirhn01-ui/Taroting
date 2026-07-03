// Pure crop-mode geometry — NO DOM. All three Slides-style crop gestures from
// the plan (D3) as closed-form functions over plain numbers, so they are
// trivially unit-testable and identical to what the export/preview affine chain
// produces.
//
// Two coordinate spaces:
//   source px  — pixels of the original frame (srcW x srcH); crop lives here.
//   screen px  — project-canvas pixels after crop -> rotate/flip -> scale-fit x
//                userScale -> position. This is the space the overlay draws in
//                (before the extra stage.scale that only maps project px -> CSS
//                px on screen; canvas-math never sees stage.scale).
//
// The mapping between the two is k = fit(crop) * scale for magnitude, plus an
// axis matrix M(rotate, flipH, flipV) for direction. A screen-space delta d is
// pulled back into source space by (M^-1 d) / k.

/** rotate is one of the four quantized values; flips are axis mirrors. */
export interface Axis {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The animatable pose fields canvas-math reads/writes. */
export interface PoseState {
  crop: CropRect;
  scale: number;
  x: number;
  y: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const CROP_MIN = 8; // minimum crop extent, in source px, each dimension
export const SCALE_MIN = 0.1;
export const SCALE_MAX = 4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/* ------------------------------------------------------------------ */
/* fit — MUST match transforms.ts computeTransformInto exactly          */
/* ------------------------------------------------------------------ */

/** Scale-to-fit factor for a cropped, possibly-rotated region into the project
 *  canvas. Mirrors the 4-line fit in transforms.ts (verified by the cross-check
 *  test in canvas-math.test.ts). cropW/cropH are the (already clamped) crop
 *  extents in source px. */
export function fit(
  cropW: number,
  cropH: number,
  rotate: number,
  projW: number,
  projH: number,
): number {
  const rotated = rotate === 90 || rotate === 270;
  const fitW = rotated ? cropH : cropW;
  const fitH = rotated ? cropW : cropH;
  return Math.min(projW / fitW, projH / fitH);
}

/* ------------------------------------------------------------------ */
/* Axis matrix M — source-delta -> screen-delta direction (unit scale)  */
/* ------------------------------------------------------------------ */

// The preview tower's CSS is `rotate(θ) scale(fh, fv)` (transforms.ts). CSS
// applies a transform list to a point RIGHT-TO-LEFT: the source point is first
// flipped, then rotated, so the source->screen map is M = R * F (NOT F * R).
// R*F differs from F*R (a full mirror) for rotate in {90,270} with exactly one
// flip, so M MUST be R*F to keep the crop ghost/handles aligned with the media
// the user sees. M encodes that linear map (columns are the screen images of the
// source basis vectors). Rotation is quantized and flips are ±1, so M has
// integer entries and det = ±1, making M^-1 closed-form and lossless.

interface Mat2 {
  a: number; b: number; // first row  [a b]
  c: number; d: number; // second row [c d]
}

/** M: source-delta -> screen-delta (unit magnitude; screen y is DOWN, same as
 *  CSS). Composition is M = R * F to match the preview's `rotate() scale()` CSS,
 *  which applies flip-then-rotate to a point (CSS transform lists compose
 *  right-to-left). */
export function axisMatrix(axis: Axis): Mat2 {
  // rotation (CSS clockwise, screen-y down): R = [[cos, -sin], [sin, cos]]
  const rad = (axis.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const fh = axis.flipH ? -1 : 1;
  const fv = axis.flipV ? -1 : 1;
  // R = [[cos, -sin], [sin, cos]];  F = [[fh,0],[0,fv]];  M = R*F:
  //   [[cos*fh, -sin*fv], [sin*fh, cos*fv]]
  return {
    a: fh * cos, b: -fv * sin,
    c: fh * sin, d: fv * cos,
  };
}

/** Apply the inverse of M to a screen-space delta, giving a source-space delta.
 *  det(M) = ±1 so the inverse is exact. */
export function invApply(axis: Axis, d: Vec2): Vec2 {
  const m = axisMatrix(axis);
  const det = m.a * m.d - m.b * m.c; // ±1
  // inverse of [[a,b],[c,d]] is (1/det)[[d,-b],[-c,a]]
  return {
    x: (m.d * d.x - m.b * d.y) / det,
    y: (-m.c * d.x + m.a * d.y) / det,
  };
}

/* ------------------------------------------------------------------ */
/* Clamp helpers                                                        */
/* ------------------------------------------------------------------ */

/** Clamp a crop rect to stay >= CROP_MIN in each dim and fully inside the
 *  source frame. Adjusts x/y first (so a shifted crop stays in-bounds), then
 *  shrinks w/h if they would overhang. */
export function clampCrop(crop: CropRect, srcW: number, srcH: number): CropRect {
  let w = clamp(crop.w, CROP_MIN, srcW);
  let h = clamp(crop.h, CROP_MIN, srcH);
  const x = clamp(crop.x, 0, srcW - w);
  const y = clamp(crop.y, 0, srcH - h);
  // (w/h already <= src; x/y clamped so x+w <= srcW). Re-derive w/h defensively
  // in case the input x forced a smaller window than requested.
  w = Math.min(w, srcW - x);
  h = Math.min(h, srcH - y);
  return { x, y, w, h };
}

/* ------------------------------------------------------------------ */
/* Op 1 — window-handle drag (crop the frame, ghost pinned)             */
/* ------------------------------------------------------------------ */

/** Which window handle is being dragged. Corners move two edges; edges one. */
export type WindowHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_DX: Record<WindowHandle, -1 | 0 | 1> = {
  nw: -1, n: 0, ne: 1, e: 1, se: 1, s: 0, sw: -1, w: -1,
};
const HANDLE_DY: Record<WindowHandle, -1 | 0 | 1> = {
  nw: -1, n: -1, ne: -1, e: 0, se: 1, s: 1, sw: 1, w: 0,
};

/** Op 1: dragging a window handle re-crops the frame while the ghost (the full
 *  uncropped frame) stays pinned in screen space. The moved window edge(s) shift
 *  by the screen delta; the crop rect changes by M^-1 * delta / k on the dragged
 *  edges; scale' = k / fit(crop') keeps the ghost's on-screen size fixed; the
 *  new window's center maps back to x'/y'.
 *
 *  Inputs: the pose at gesture start (`start`), the source dims, the project
 *  dims, the axis, the gesture's total screen delta (project px), the handle,
 *  and the pre-gesture k (= fit(startCrop)*startScale). Returns the new pose. */
export function windowHandleDrag(
  start: PoseState,
  srcW: number,
  srcH: number,
  projW: number,
  projH: number,
  axis: Axis,
  screenDelta: Vec2,
  handle: WindowHandle,
  k: number,
): PoseState {
  // pull the screen delta into source space
  const sd = invApply(axis, { x: screenDelta.x / k, y: screenDelta.y / k });
  const dirX = HANDLE_DX[handle];
  const dirY = HANDLE_DY[handle];

  // The handle's screen direction maps to a source edge via M^-1. A corner/edge
  // in screen space corresponds to a (possibly swapped/mirrored) source edge; we
  // fold the source-space delta onto whichever source edges the moved screen
  // edges touch. Compute the source-space handle direction from the screen dir.
  const srcDir = invApply(axis, { x: dirX, y: dirY });
  const moveX = Math.abs(srcDir.x) > 0.5; // this handle moves a vertical source edge
  const moveY = Math.abs(srcDir.y) > 0.5; // this handle moves a horizontal source edge
  const signX = Math.sign(srcDir.x);
  const signY = Math.sign(srcDir.y);

  let { x, y, w, h } = start.crop;
  if (moveX) {
    if (signX < 0) {
      // moving the left source edge: x and w change, x+w (right edge) fixed
      const nx = x + sd.x;
      w = w + (x - nx);
      x = nx;
    } else {
      // moving the right source edge: w changes, x fixed
      w = w + sd.x;
    }
  }
  if (moveY) {
    if (signY < 0) {
      const ny = y + sd.y;
      h = h + (y - ny);
      y = ny;
    } else {
      h = h + sd.y;
    }
  }

  const crop = clampCrop({ x, y, w, h }, srcW, srcH);
  const scale = clamp(k / fit(crop.w, crop.h, axis.rotate, projW, projH), SCALE_MIN, SCALE_MAX);

  // Pin the ghost: the ghost's top-left in screen space is fixed. Equivalent
  // condition — keep the ghost's CENTER (the full-frame center) fixed on screen.
  // The full-frame center in source space is (srcW/2, srcH/2); the crop center is
  // (x+w/2, y+h/2). The window center in screen space = ghostCenter + M*(cropCenter
  // - frameCenter)*k. Since ghostCenter is pinned, the new x'/y' follow from the
  // new crop center at the new k.
  const kNew = fit(crop.w, crop.h, axis.rotate, projW, projH) * scale;
  const pos = windowPosFromGhostPin(start, srcW, srcH, projW, projH, axis, crop, kNew, k);
  return { crop, scale, x: pos.x, y: pos.y };
}

/** Given the ghost pinned in screen space at its start position, compute the
 *  window position (x/y) so the ghost stays put. The ghost center on screen at
 *  start is: startWindowCenter + M*(frameCenter - startCropCenter)*kStart, where
 *  startWindowCenter = (projW/2 + start.x, projH/2 + start.y). Keeping that fixed
 *  and solving for the new window center at the new crop/k. */
function windowPosFromGhostPin(
  start: PoseState,
  srcW: number,
  srcH: number,
  projW: number,
  projH: number,
  axis: Axis,
  crop: CropRect,
  kNew: number,
  kStart: number,
): Vec2 {
  const m = axisMatrix(axis);
  const startWinCx = projW / 2 + start.x;
  const startWinCy = projH / 2 + start.y;
  // ghost center on screen (pinned)
  const fcx = srcW / 2;
  const fcy = srcH / 2;
  const s0cx = start.crop.x + start.crop.w / 2;
  const s0cy = start.crop.y + start.crop.h / 2;
  const off0x = fcx - s0cx;
  const off0y = fcy - s0cy;
  const ghostCx = startWinCx + (m.a * off0x + m.b * off0y) * kStart;
  const ghostCy = startWinCy + (m.c * off0x + m.d * off0y) * kStart;
  // new crop center offset from frame center
  const ncx = crop.x + crop.w / 2;
  const ncy = crop.y + crop.h / 2;
  const offNx = fcx - ncx;
  const offNy = fcy - ncy;
  // new window center = ghostCenter - M*(frameCenter - newCropCenter)*kNew
  const winCx = ghostCx - (m.a * offNx + m.b * offNy) * kNew;
  const winCy = ghostCy - (m.c * offNx + m.d * offNy) * kNew;
  return { x: winCx - projW / 2, y: winCy - projH / 2 };
}

/* ------------------------------------------------------------------ */
/* Op 2 — ghost drag (repan the source; window fixed)                   */
/* ------------------------------------------------------------------ */

/** Op 2: dragging the ghost repans — the crop's x/y move by -M^-1*delta/k so the
 *  same window shows a different part of the frame. Nothing else changes; the
 *  window stays fixed in screen space (x/y/scale untouched). Crop is clamped to
 *  stay inside the source. */
export function ghostDrag(
  start: PoseState,
  srcW: number,
  srcH: number,
  axis: Axis,
  screenDelta: Vec2,
  k: number,
): PoseState {
  const sd = invApply(axis, { x: screenDelta.x / k, y: screenDelta.y / k });
  const crop = clampCrop(
    { x: start.crop.x - sd.x, y: start.crop.y - sd.y, w: start.crop.w, h: start.crop.h },
    srcW,
    srcH,
  );
  return { crop, scale: start.scale, x: start.x, y: start.y };
}

/* ------------------------------------------------------------------ */
/* Op 3 — ghost corner resize (zoom the source; window fixed)           */
/* ------------------------------------------------------------------ */

/** Op 3: resizing the ghost by a factor g zooms the source into the same window.
 *  crop' = crop / g about the crop's source center (source center preserved),
 *  scale' = k * g / fit(crop') keeps the WINDOW fixed while k scales by g.
 *  g > 1 zooms in (smaller crop); g < 1 zooms out. Clamped so crop stays >=
 *  CROP_MIN and inside the source and scale stays in range. */
export function ghostResize(
  start: PoseState,
  srcW: number,
  srcH: number,
  projW: number,
  projH: number,
  axis: Axis,
  g: number,
  k: number,
): PoseState {
  const cx = start.crop.x + start.crop.w / 2;
  const cy = start.crop.y + start.crop.h / 2;
  const w = start.crop.w / g;
  const h = start.crop.h / g;
  const crop = clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, srcW, srcH);
  // effective g after clamping (window must stay fixed, so recompute from the
  // realized crop extent rather than the requested g)
  const gEff = start.crop.w / crop.w;
  const scale = clamp(
    (k * gEff) / fit(crop.w, crop.h, axis.rotate, projW, projH),
    SCALE_MIN,
    SCALE_MAX,
  );
  return { crop, scale, x: start.x, y: start.y };
}

/* ------------------------------------------------------------------ */
/* Display-rect derivation (cross-check against computeTransform)       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Center snap — drag-time "snap to canvas center" (Slides-style)       */
/* ------------------------------------------------------------------ */

/** Result of snapping a dragged clip toward the project center. `x`/`y` are the
 *  (possibly snapped) center-relative offsets; `snappedX`/`snappedY` say whether
 *  each axis snapped (drives the guide lines). */
export interface CenterSnap {
  x: number;
  y: number;
  snappedX: boolean;
  snappedY: boolean;
}

/** Snap a dragged clip's center-relative offset toward the project center
 *  (0,0 = centered, per ClipTransform.x/y). Each axis snaps INDEPENDENTLY when
 *  its offset is within `threshold` project px of center; otherwise it passes
 *  through unchanged. The threshold is expressed in PROJECT px — callers derive
 *  it from a fixed SCREEN px budget divided by the stage scale, so the snap zone
 *  is a constant on-screen distance regardless of zoom. */
export function snapToCenter(x: number, y: number, threshold: number): CenterSnap {
  const snappedX = Math.abs(x) <= threshold;
  const snappedY = Math.abs(y) <= threshold;
  return {
    x: snappedX ? 0 : x,
    y: snappedY ? 0 : y,
    snappedX,
    snappedY,
  };
}

/** The on-screen (project-px) display rect of a pose, matching
 *  computeTransform's (cropW*k, cropH*k) centered at (W/2+x, H/2+y). Returned as
 *  the AXIS-ALIGNED bounding box on screen (w/h swap under 90/270 rotation).
 *  Used by both the cross-check test and (conceptually) the overlay. */
export function displayRect(
  pose: PoseState,
  srcW: number,
  srcH: number,
  projW: number,
  projH: number,
  rotate: number,
): { cx: number; cy: number; w: number; h: number } {
  const cropW = clamp2(pose.crop.w, 1, srcW - pose.crop.x);
  const cropH = clamp2(pose.crop.h, 1, srcH - pose.crop.y);
  const k = fit(cropW, cropH, rotate, projW, projH) * pose.scale;
  const rotated = rotate === 90 || rotate === 270;
  const w = (rotated ? cropH : cropW) * k;
  const h = (rotated ? cropW : cropH) * k;
  return { cx: projW / 2 + pose.x, cy: projH / 2 + pose.y, w, h };
}

const clamp2 = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
