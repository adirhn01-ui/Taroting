import { describe, expect, it } from "vitest";
import { axisMatrix, type WindowHandle } from "../editor/preview/canvas-math";
import type { ClipCrop } from "../core/types";
import {
  applyAffine,
  cornerScale,
  cropHandleDrag,
  cropPan,
  moveWithSnap,
  normalizeCrop,
  scaleAboutPivot,
  snapThreshold,
  type Affine,
  type CropPose,
} from "./select-tool";

// Fixture (spec): canvas 641×361; a 200×100 layer at x=30, y=−10, scale 0.5.
// Every axis differs: odd canvas sides, a non-square source, an off-centre
// position with opposite signs, and a crop whose four numbers are distinct.
const W = 641;
const H = 361;
const SRC_W = 200;
const SRC_H = 100;

interface Pose {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  scale: number;
  x: number;
  y: number;
  crop: ClipCrop;
}

/** The native-pixel layer affine, written independently of the module under
 *  test: canvas = (W/2 + x, H/2 + y) + k·R·F·(p − cropCentre), in DOMMatrix
 *  order. (R·F is the preview's own composition, canvas-math `axisMatrix`.) */
function affine(p: Pose): Affine {
  const m = axisMatrix(p);
  const k = p.scale;
  const A = k * m.a;
  const C = k * m.b;
  const B = k * m.c;
  const D = k * m.d;
  const ccx = p.crop.x + p.crop.w / 2;
  const ccy = p.crop.y + p.crop.h / 2;
  return [A, B, C, D, W / 2 + p.x - (A * ccx + C * ccy), H / 2 + p.y - (B * ccx + D * ccy)];
}

function windowBox(p: Pose): { x0: number; y0: number; x1: number; y1: number } {
  const m = affine(p);
  const c = p.crop;
  const pts = [
    applyAffine(m, c.x, c.y),
    applyAffine(m, c.x + c.w, c.y),
    applyAffine(m, c.x + c.w, c.y + c.h),
    applyAffine(m, c.x, c.y + c.h),
  ];
  return {
    x0: Math.min(...pts.map((q) => q.x)),
    y0: Math.min(...pts.map((q) => q.y)),
    x1: Math.max(...pts.map((q) => q.x)),
    y1: Math.max(...pts.map((q) => q.y)),
  };
}

const ROTATIONS = [0, 90, 180, 270] as const;
const CONFIGS = ROTATIONS.flatMap((rotate) => [false, true].map((flipH) => ({ rotate, flipH })));
const START_CROP: ClipCrop = { x: 20, y: 10, w: 150, h: 70 };

function startPose(rotate: Pose["rotate"], flipH: boolean): Pose {
  return { rotate, flipH, flipV: false, scale: 0.5, x: 30, y: -10, crop: { ...START_CROP } };
}

describe("per-layer crop: a window handle keeps the source pinned", () => {
  // (−4, 3) canvas px at k = 0.5 is 8 and 6 whole source px on whichever axes
  // the rotation maps them to — inside the source on every side, so no clamp
  // hides a wrong edge.
  const delta = { x: -4, y: 3 };
  const probes: [number, number][] = [[0, 0], [SRC_W, SRC_H], [37, 61], [SRC_W, 0]];

  for (const { rotate, flipH } of CONFIGS) {
    it(`rotate ${rotate}${flipH ? " + flipH" : ""}: SW handle`, () => {
      const p0 = startPose(rotate, flipH);
      const m0 = affine(p0);
      const start: CropPose = { crop: p0.crop, x: p0.x, y: p0.y };
      // "sw" on SCREEN: the window's left and bottom edges follow the pointer.
      const out = cropHandleDrag(start, SRC_W, SRC_H, m0, "sw" as WindowHandle, delta);
      const p1: Pose = { ...p0, crop: out.crop, x: out.x, y: out.y };
      const m1 = affine(p1);

      // 1. The source (the ghost) did not move: every source point lands on
      //    the same canvas point before and after.
      for (const [sx, sy] of probes) {
        const a = applyAffine(m0, sx, sy);
        const b = applyAffine(m1, sx, sy);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
      }
      // 2. The opposite (top-right) corner of the window stayed put, and the
      //    dragged corner moved by exactly the pointer delta.
      const w0 = windowBox(p0);
      const w1 = windowBox(p1);
      expect(w1.x1).toBeCloseTo(w0.x1, 9);
      expect(w1.y0).toBeCloseTo(w0.y0, 9);
      expect(w1.x0).toBeCloseTo(w0.x0 + delta.x, 9);
      expect(w1.y1).toBeCloseTo(w0.y1 + delta.y, 9);
      // 3. Scale is native pixels and untouched; the crop is whole source px.
      for (const v of [out.crop.x, out.crop.y, out.crop.w, out.crop.h]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    });
  }

  it("clamps at the source edge and never below 1 source px", () => {
    const p0 = startPose(0, false);
    const m0 = affine(p0);
    const start: CropPose = { crop: p0.crop, x: p0.x, y: p0.y };
    // far past the left/top of the source
    const a = cropHandleDrag(start, SRC_W, SRC_H, m0, "nw", { x: -500, y: -500 });
    expect(a.crop).toEqual({ x: 0, y: 0, w: 170, h: 80 });
    // far past the right/bottom edge of the window's own left/top
    const b = cropHandleDrag(start, SRC_W, SRC_H, m0, "nw", { x: 500, y: 500 });
    expect(b.crop).toEqual({ x: 169, y: 79, w: 1, h: 1 });
  });

  it("a pan slides the source under a window that stays put", () => {
    const p0 = startPose(90, true);
    const m0 = affine(p0);
    const out = cropPan({ crop: p0.crop, x: p0.x, y: p0.y }, SRC_W, SRC_H, m0, { x: 4, y: -3 });
    const p1: Pose = { ...p0, crop: out.crop, x: out.x, y: out.y };
    expect(out.x).toBe(p0.x);
    expect(out.y).toBe(p0.y);
    expect(out.crop).not.toEqual(p0.crop);
    expect(windowBox(p1)).toEqual(windowBox(p0));
    // the source point under the pointer moved WITH the pointer
    const a = applyAffine(m0, 60, 40);
    const b = applyAffine(affine(p1), 60, 40);
    expect(b.x - a.x).toBeCloseTo(4, 9);
    expect(b.y - a.y).toBeCloseTo(-3, 9);
  });

  it("a crop covering the whole source is stored as no crop", () => {
    expect(normalizeCrop({ x: 0, y: 0, w: SRC_W, h: SRC_H }, SRC_W, SRC_H)).toBeUndefined();
    expect(normalizeCrop({ x: 0, y: 0, w: SRC_W, h: SRC_H - 1 }, SRC_W, SRC_H)).toEqual({
      x: 0, y: 0, w: SRC_W, h: SRC_H - 1,
    });
  });
});

describe("corner scale", () => {
  it("is start × dist / startDist, uniform, with only the crafted-file guard", () => {
    expect(cornerScale(0.5, 40, 100)).toBeCloseTo(1.25, 12);
    // far past the old 4× video clamp: native pixels have no such bound
    expect(cornerScale(0.5, 10, 170)).toBeCloseTo(8.5, 12);
    // below the old 0.1 floor
    expect(cornerScale(0.5, 100, 9)).toBeCloseTo(0.045, 12);
    // only IMAGE_SCALE_GUARD bounds it
    expect(cornerScale(0.5, 1, 1e9)).toBe(1e4);
    expect(cornerScale(0.5, 1e6, 0)).toBe(1e-4);
    // a drag that crosses the pivot uses the absolute distance
    expect(cornerScale(0.5, 40, -60)).toBeCloseTo(0.75, 12);
    // a press ON the pivot cannot scale (no division by ~0)
    expect(cornerScale(0.5, 0, 50)).toBe(0.5);
  });

  it("keeps the pivot fixed on the canvas (a drawing's strokes box)", () => {
    const p0: Pose = {
      rotate: 90, flipH: true, flipV: false, scale: 0.5, x: 30, y: -10,
      crop: { x: 0, y: 0, w: 641, h: 361 },
    };
    const m0 = affine(p0);
    const pivot = applyAffine(m0, 123, 45);
    const centre = { x: W / 2 + p0.x, y: H / 2 + p0.y };
    const s1 = 0.8;
    const xy = scaleAboutPivot(p0.x, p0.y, centre, pivot, s1 / p0.scale);
    const m1 = affine({ ...p0, scale: s1, x: xy.x, y: xy.y });
    const after = applyAffine(m1, 123, 45);
    expect(after.x).toBeCloseTo(pivot.x, 9);
    expect(after.y).toBeCloseTo(pivot.y, 9);
    // and a point away from the pivot moved away from it by the ratio
    const far0 = applyAffine(m0, 10, 300);
    const far1 = applyAffine(m1, 10, 300);
    expect(far1.x - pivot.x).toBeCloseTo((far0.x - pivot.x) * 1.6, 9);
    expect(far1.y - pivot.y).toBeCloseTo((far0.y - pivot.y) * 1.6, 9);
  });

  it("about the layer centre leaves x/y exactly unchanged", () => {
    const centre = { x: W / 2 + 30, y: H / 2 - 10 };
    expect(scaleAboutPivot(30, -10, centre, centre, 2.7)).toEqual({ x: 30, y: -10 });
  });
});

describe("move and the centre snap", () => {
  it("the snap radius is 8 screen px in canvas px: 8 / (zoom / dpr)", () => {
    expect(snapThreshold(1, 1)).toBe(8);
    expect(snapThreshold(0.37, 1.5)).toBeCloseTo(8 / (0.37 / 1.5), 12);
    expect(snapThreshold(2, 1.25)).toBeCloseTo(5, 12);
  });

  it("snaps the box centre within the radius and passes through outside it", () => {
    const t = snapThreshold(2, 1.25); // 5 canvas px
    // box centre at x=30: −26 lands 4 px from the centre → snaps
    const a = moveWithSnap(30, -10, { x: 30, y: -10 }, -26, 0, t);
    expect(a).toEqual({ x: 0, y: -10, snappedX: true, snappedY: false });
    // −24 lands 6 px away → no snap
    const b = moveWithSnap(30, -10, { x: 30, y: -10 }, -24, 0, t);
    expect(b).toEqual({ x: 6, y: -10, snappedX: false, snappedY: false });
    // snapping off: exact
    const c = moveWithSnap(30, -10, { x: 30, y: -10 }, -26, 7, null);
    expect(c).toEqual({ x: 4, y: -3, snappedX: false, snappedY: false });
  });

  it("snaps the STROKES' centre, not the media box's, for a drawing", () => {
    // media box centred (x=0), strokes' box centre 57 px right of centre:
    // a −55 drag brings the strokes 2 px from the centre → they snap to it.
    const m = moveWithSnap(0, 0, { x: 57, y: 12 }, -55, 0, 8);
    expect(m.snappedX).toBe(true);
    expect(m.x).toBe(-57);
    expect(m.y).toBe(0);
  });

  it("a centre snap keeps the move whole, so a layer on whole pixels stays on them", () => {
    // A 200×101 photo on the 641×361 canvas sits on whole pixels at x = 0.5,
    // y = 0 (and at every whole step from there). Dragged to 3.5 px right of
    // the centre it snaps — to x = 0.5, not to the exact (half-pixel) centre.
    const a = moveWithSnap(10.5, -7, { x: 10.5, y: -7 }, -7, -4, 8);
    expect(a).toEqual({ x: 0.5, y: -11, snappedX: true, snappedY: false });
    // A drawing whose strokes' centre is off the grid: the snap lands its
    // layer on a whole-pixel move too (the delta, not the centre, is kept whole).
    const d = moveWithSnap(4, 2, { x: 57.3, y: -12.6 }, -55, 10, 8);
    expect(d.snappedX && d.snappedY).toBe(true);
    expect([d.x - 4, d.y - 2]).toEqual([-57, 13]);
  });

  it("moves in whole canvas px: a (+40, +25) drag at zoom 1 is exactly that", () => {
    expect(moveWithSnap(30, -10, { x: 30, y: -10 }, 40, 25, 8)).toEqual({
      x: 70, y: 15, snappedX: false, snappedY: false,
    });
    expect(moveWithSnap(30, -10, { x: 30, y: -10 }, 40.4, 24.6, null)).toMatchObject({ x: 70, y: 15 });
  });
});
