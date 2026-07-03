import { describe, expect, it } from "vitest";
import {
  type Axis,
  type PoseState,
  type WindowHandle,
  axisMatrix,
  clampCrop,
  CROP_MIN,
  displayRect,
  fit,
  ghostDrag,
  ghostResize,
  invApply,
  SCALE_MAX,
  snapToCenter,
  windowHandleDrag,
} from "./canvas-math";
import { computeTransform } from "./transforms";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SRC_W = 1920;
const SRC_H = 1080;
const PROJ_W = 1280;
const PROJ_H = 720;

const ROTATES: (0 | 90 | 180 | 270)[] = [0, 90, 180, 270];
const FLIPS: [boolean, boolean][] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

/** All 16 rotate x flip axes. */
function allAxes(): Axis[] {
  const out: Axis[] = [];
  for (const rotate of ROTATES) {
    for (const [flipH, flipV] of FLIPS) out.push({ rotate, flipH, flipV });
  }
  return out;
}

function kOf(pose: PoseState, axis: Axis): number {
  return fit(pose.crop.w, pose.crop.h, axis.rotate, PROJ_W, PROJ_H) * pose.scale;
}

/** Screen-space rect of the GHOST (full uncropped frame) for a pose: its center
 *  on screen and its on-screen size at k. */
function ghostScreenRect(
  pose: PoseState,
  axis: Axis,
): { cx: number; cy: number; w: number; h: number } {
  const m = axisMatrix(axis);
  const k = kOf(pose, axis);
  const winCx = PROJ_W / 2 + pose.x;
  const winCy = PROJ_H / 2 + pose.y;
  // ghost center = window center + M*(frameCenter - cropCenter)*k
  const offx = SRC_W / 2 - (pose.crop.x + pose.crop.w / 2);
  const offy = SRC_H / 2 - (pose.crop.y + pose.crop.h / 2);
  const cx = winCx + (m.a * offx + m.b * offy) * k;
  const cy = winCy + (m.c * offx + m.d * offy) * k;
  const rotated = axis.rotate === 90 || axis.rotate === 270;
  const w = (rotated ? SRC_H : SRC_W) * k;
  const h = (rotated ? SRC_W : SRC_H) * k;
  return { cx, cy, w, h };
}

/** Screen-space rect of the WINDOW (crop region) for a pose. */
function windowScreenRect(
  pose: PoseState,
  axis: Axis,
): { cx: number; cy: number; w: number; h: number } {
  const k = kOf(pose, axis);
  const rotated = axis.rotate === 90 || axis.rotate === 270;
  return {
    cx: PROJ_W / 2 + pose.x,
    cy: PROJ_H / 2 + pose.y,
    w: (rotated ? pose.crop.h : pose.crop.w) * k,
    h: (rotated ? pose.crop.w : pose.crop.h) * k,
  };
}

const basePose = (): PoseState => ({
  crop: { x: 0, y: 0, w: SRC_W, h: SRC_H },
  scale: 1,
  x: 0,
  y: 0,
});

/** A pose already cropped a bit, so windows/ghosts differ. */
const croppedPose = (): PoseState => ({
  crop: { x: 200, y: 150, w: 1200, h: 700 },
  scale: 1,
  x: 40,
  y: -30,
});

const EPS = 1e-6;

/* ------------------------------------------------------------------ */
/* fit() cross-check + axis matrix                                     */
/* ------------------------------------------------------------------ */

describe("fit matches transforms.ts", () => {
  it("equals computeTransform's implied fit for various crops/rotations", () => {
    const cases: { crop: { x: number; y: number; w: number; h: number }; rotate: 0 | 90 | 180 | 270 }[] = [
      { crop: { x: 0, y: 0, w: SRC_W, h: SRC_H }, rotate: 0 },
      { crop: { x: 100, y: 50, w: 800, h: 600 }, rotate: 0 },
      { crop: { x: 100, y: 50, w: 800, h: 600 }, rotate: 90 },
      { crop: { x: 0, y: 0, w: 400, h: 900 }, rotate: 270 },
    ];
    for (const c of cases) {
      const t = {
        crop: c.crop, rotate: c.rotate, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1,
      };
      const ct = computeTransform(t, { width: SRC_W, height: SRC_H }, { width: PROJ_W, height: PROJ_H });
      // computeTransform stores cropW = clampedCrop.w * k with scale 1 -> k = fit
      const cropW = Math.min(c.crop.w, SRC_W - c.crop.x);
      const cropH = Math.min(c.crop.h, SRC_H - c.crop.y);
      const impliedFit = ct.cropW / cropW;
      const myFit = fit(cropW, cropH, c.rotate, PROJ_W, PROJ_H);
      expect(myFit).toBeCloseTo(impliedFit, 6);
    }
  });
});

describe("axisMatrix", () => {
  it("is orthonormal with det ±1 for all 16 axes", () => {
    for (const axis of allAxes()) {
      const m = axisMatrix(axis);
      const det = m.a * m.d - m.b * m.c;
      expect(Math.abs(det)).toBeCloseTo(1, 9);
    }
  });
  it("invApply round-trips M", () => {
    for (const axis of allAxes()) {
      const d = { x: 3, y: -7 };
      const m = axisMatrix(axis);
      const screen = { x: m.a * d.x + m.b * d.y, y: m.c * d.x + m.d * d.y };
      const back = invApply(axis, screen);
      expect(back.x).toBeCloseTo(d.x, 9);
      expect(back.y).toBeCloseTo(d.y, 9);
    }
  });

  // Hand-computed expected matrices for M = R * F (the preview's `rotate() scale()`
  // CSS maps a source point flip-then-rotate). These are NOT derived from
  // axisMatrix, so they pin the composition independently of the code under test.
  // Anchors + all 4 contested axes (rot 90/270 x exactly one flip) where R*F != F*R.
  it("equals hand-computed R*F matrices (anchors + 4 contested axes)", () => {
    const cases: { axis: Axis; a: number; b: number; c: number; d: number }[] = [
      // identity
      { axis: { rotate: 0, flipH: false, flipV: false }, a: 1, b: 0, c: 0, d: 1 },
      // flipH, no rotate
      { axis: { rotate: 0, flipH: true, flipV: false }, a: -1, b: 0, c: 0, d: 1 },
      // rot90, no flip
      { axis: { rotate: 90, flipH: false, flipV: false }, a: 0, b: -1, c: 1, d: 0 },
      // --- contested: rot90 + single flip ---
      // rot90 + flipH: browser ground truth src +x -> (0,-1), src +y -> (-1,0)
      { axis: { rotate: 90, flipH: true, flipV: false }, a: 0, b: -1, c: -1, d: 0 },
      // rot90 + flipV
      { axis: { rotate: 90, flipH: false, flipV: true }, a: 0, b: 1, c: 1, d: 0 },
      // --- contested: rot270 + single flip ---
      { axis: { rotate: 270, flipH: true, flipV: false }, a: 0, b: 1, c: 1, d: 0 },
      { axis: { rotate: 270, flipH: false, flipV: true }, a: 0, b: -1, c: -1, d: 0 },
    ];
    for (const c of cases) {
      const m = axisMatrix(c.axis);
      const tag = `rot=${c.axis.rotate} fh=${c.axis.flipH} fv=${c.axis.flipV}`;
      // `+ 0` normalizes JS signed zero (-0 -> 0) so exact integer compares hold.
      expect(m.a + 0, `a ${tag}`).toBe(c.a);
      expect(m.b + 0, `b ${tag}`).toBe(c.b);
      expect(m.c + 0, `c ${tag}`).toBe(c.c);
      expect(m.d + 0, `d ${tag}`).toBe(c.d);
    }
  });

  // Direct check of the browser-measured ground truth for rot90 + flipH:
  // a source +x offset must land at screen (0,-1); source +y at (-1,0).
  it("maps rot90+flipH source basis to browser-measured screen (R*F)", () => {
    const axis: Axis = { rotate: 90, flipH: true, flipV: false };
    const m = axisMatrix(axis);
    // screen image of source +x is column (a, c); of source +y is (b, d).
    // `+ 0` normalizes JS signed zero (-0 -> 0).
    expect({ x: m.a + 0, y: m.c + 0 }).toEqual({ x: 0, y: -1 });
    expect({ x: m.b + 0, y: m.d + 0 }).toEqual({ x: -1, y: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* Op 1 — window handle drag: ghost pinned in screen space              */
/* ------------------------------------------------------------------ */

describe("op1 windowHandleDrag — ghost pinned (16-axis matrix)", () => {
  const handles: WindowHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  for (const axis of allAxes()) {
    for (const handle of handles) {
      it(`ghost unchanged: rotate=${axis.rotate} fh=${axis.flipH} fv=${axis.flipV} h=${handle}`, () => {
        const start = croppedPose();
        const k = kOf(start, axis);
        const before = ghostScreenRect(start, axis);
        const delta = { x: 24, y: 18 };
        const next = windowHandleDrag(start, SRC_W, SRC_H, PROJ_W, PROJ_H, axis, delta, handle, k);
        const after = ghostScreenRect(next, axis);
        // ghost rect fixed in screen space (its size may only change if clamps
        // hit; with this modest delta on a mid crop, nothing clamps)
        expect(after.cx).toBeCloseTo(before.cx, 4);
        expect(after.cy).toBeCloseTo(before.cy, 4);
        expect(after.w).toBeCloseTo(before.w, 4);
        expect(after.h).toBeCloseTo(before.h, 4);
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* Op 2 — ghost drag: window unchanged in screen space                  */
/* ------------------------------------------------------------------ */

describe("op2 ghostDrag — window pinned (16-axis matrix)", () => {
  for (const axis of allAxes()) {
    it(`window unchanged: rotate=${axis.rotate} fh=${axis.flipH} fv=${axis.flipV}`, () => {
      const start = croppedPose();
      const k = kOf(start, axis);
      const before = windowScreenRect(start, axis);
      const delta = { x: 20, y: -15 };
      const next = ghostDrag(start, SRC_W, SRC_H, axis, delta, k);
      const after = windowScreenRect(next, axis);
      expect(after.cx).toBeCloseTo(before.cx, 6);
      expect(after.cy).toBeCloseTo(before.cy, 6);
      expect(after.w).toBeCloseTo(before.w, 6);
      expect(after.h).toBeCloseTo(before.h, 6);
      // and it actually repanned (crop moved) — pull the delta into source space
      const sd = invApply(axis, { x: delta.x / k, y: delta.y / k });
      expect(next.crop.x).toBeCloseTo(start.crop.x - sd.x, 6);
      expect(next.crop.y).toBeCloseTo(start.crop.y - sd.y, 6);
    });
  }
});

/* ------------------------------------------------------------------ */
/* Op 3 — ghost resize: window unchanged + k scales by g                */
/* ------------------------------------------------------------------ */

describe("op3 ghostResize — window pinned, k scales by g (16-axis matrix)", () => {
  for (const axis of allAxes()) {
    for (const g of [1.5, 0.75]) {
      it(`window fixed, k*=g: rotate=${axis.rotate} fh=${axis.flipH} fv=${axis.flipV} g=${g}`, () => {
        const start = croppedPose();
        const k = kOf(start, axis);
        const before = windowScreenRect(start, axis);
        const next = ghostResize(start, SRC_W, SRC_H, PROJ_W, PROJ_H, axis, g, k);
        const after = windowScreenRect(next, axis);
        // window fixed in screen space
        expect(after.cx).toBeCloseTo(before.cx, 5);
        expect(after.cy).toBeCloseTo(before.cy, 5);
        expect(after.w).toBeCloseTo(before.w, 5);
        expect(after.h).toBeCloseTo(before.h, 5);
        // k scaled by g
        const kAfter = kOf(next, axis);
        expect(kAfter).toBeCloseTo(k * g, 4);
        // source center preserved
        expect(next.crop.x + next.crop.w / 2).toBeCloseTo(start.crop.x + start.crop.w / 2, 4);
        expect(next.crop.y + next.crop.h / 2).toBeCloseTo(start.crop.y + start.crop.h / 2, 4);
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* Clamp cases                                                          */
/* ------------------------------------------------------------------ */

describe("clamps", () => {
  it("clampCrop keeps >= CROP_MIN and inside the source", () => {
    const c = clampCrop({ x: -50, y: -20, w: 4, h: 3 }, SRC_W, SRC_H);
    expect(c.w).toBeGreaterThanOrEqual(CROP_MIN);
    expect(c.h).toBeGreaterThanOrEqual(CROP_MIN);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(SRC_W + EPS);
    expect(c.y + c.h).toBeLessThanOrEqual(SRC_H + EPS);
  });

  it("clampCrop clamps an oversized crop to the source", () => {
    const c = clampCrop({ x: 100, y: 100, w: 5000, h: 5000 }, SRC_W, SRC_H);
    expect(c.x + c.w).toBeLessThanOrEqual(SRC_W + EPS);
    expect(c.y + c.h).toBeLessThanOrEqual(SRC_H + EPS);
  });

  it("op3 never exceeds SCALE_MAX", () => {
    const axis: Axis = { rotate: 0, flipH: false, flipV: false };
    const start = basePose();
    const k = kOf(start, axis);
    // an extreme zoom-in
    const next = ghostResize(start, SRC_W, SRC_H, PROJ_W, PROJ_H, axis, 100, k);
    expect(next.scale).toBeLessThanOrEqual(SCALE_MAX + EPS);
    expect(next.crop.w).toBeGreaterThanOrEqual(CROP_MIN);
  });

  it("op1 corner drag inward shrinks the crop but keeps it valid", () => {
    const axis: Axis = { rotate: 0, flipH: false, flipV: false };
    const start = basePose();
    const k = kOf(start, axis);
    const next = windowHandleDrag(start, SRC_W, SRC_H, PROJ_W, PROJ_H, axis, { x: 100, y: 60 }, "nw", k);
    expect(next.crop.w).toBeLessThan(start.crop.w);
    expect(next.crop.h).toBeLessThan(start.crop.h);
    expect(next.crop.x).toBeGreaterThanOrEqual(0);
    expect(next.crop.y).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */
/* Center snap — snapToCenter                                           */
/* ------------------------------------------------------------------ */

describe("snapToCenter", () => {
  it("snaps both axes to 0 when both are within threshold", () => {
    const r = snapToCenter(4, -3, 8);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.snappedX).toBe(true);
    expect(r.snappedY).toBe(true);
  });

  it("snaps only the in-threshold axis, passing the other through", () => {
    const r = snapToCenter(5, 40, 8);
    expect(r.x).toBe(0);
    expect(r.snappedX).toBe(true);
    // y is outside the threshold: unchanged, not snapped
    expect(r.y).toBe(40);
    expect(r.snappedY).toBe(false);
  });

  it("snaps the y axis independently of x", () => {
    const r = snapToCenter(-50, 2, 8);
    expect(r.x).toBe(-50);
    expect(r.snappedX).toBe(false);
    expect(r.y).toBe(0);
    expect(r.snappedY).toBe(true);
  });

  it("does not snap when both axes are outside the threshold", () => {
    const r = snapToCenter(20, -30, 8);
    expect(r.x).toBe(20);
    expect(r.y).toBe(-30);
    expect(r.snappedX).toBe(false);
    expect(r.snappedY).toBe(false);
  });

  it("snaps at exactly the threshold (inclusive boundary)", () => {
    const r = snapToCenter(8, -8, 8);
    expect(r.snappedX).toBe(true);
    expect(r.snappedY).toBe(true);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("scales the zone with the threshold (a wider threshold catches farther offsets)", () => {
    // offset of 15 project px: outside an 8px zone, inside a 40px zone.
    // The overlay derives the threshold as screenBudget / stageScale, so a
    // smaller stage scale (zoomed-out canvas) yields a larger project-px zone.
    const tight = snapToCenter(15, 15, 8);
    expect(tight.snappedX).toBe(false);
    expect(tight.snappedY).toBe(false);
    const wide = snapToCenter(15, 15, 40);
    expect(wide.snappedX).toBe(true);
    expect(wide.snappedY).toBe(true);
    expect(wide.x).toBe(0);
    expect(wide.y).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Cross-check: canvas-math state -> display rect == computeTransform    */
/* ------------------------------------------------------------------ */

describe("display rect matches computeTransform", () => {
  const states: { pose: PoseState; axis: Axis }[] = [
    { pose: basePose(), axis: { rotate: 0, flipH: false, flipV: false } },
    { pose: croppedPose(), axis: { rotate: 0, flipH: false, flipV: false } },
    { pose: croppedPose(), axis: { rotate: 90, flipH: false, flipV: false } },
    { pose: { crop: { x: 300, y: 100, w: 900, h: 800 }, scale: 1.4, x: -20, y: 60 }, axis: { rotate: 180, flipH: true, flipV: false } },
    { pose: { crop: { x: 50, y: 50, w: 600, h: 500 }, scale: 0.8, x: 10, y: 10 }, axis: { rotate: 270, flipH: false, flipV: true } },
  ];
  for (const { pose, axis } of states) {
    it(`rotate=${axis.rotate} fh=${axis.flipH} fv=${axis.flipV}`, () => {
      const t = {
        crop: pose.crop, rotate: axis.rotate, flipH: axis.flipH, flipV: axis.flipV,
        scale: pose.scale, x: pose.x, y: pose.y, opacity: 1,
      };
      const ct = computeTransform(t, { width: SRC_W, height: SRC_H }, { width: PROJ_W, height: PROJ_H });
      const dr = displayRect(pose, SRC_W, SRC_H, PROJ_W, PROJ_H, axis.rotate);
      // computeTransform: box size cropW/cropH (pre-rotation), centered at (W/2+x, H/2+y)
      // displayRect returns the axis-aligned screen box (w/h swapped for 90/270).
      const rotated = axis.rotate === 90 || axis.rotate === 270;
      const boxW = rotated ? ct.cropH : ct.cropW;
      const boxH = rotated ? ct.cropW : ct.cropH;
      expect(dr.w).toBeCloseTo(boxW, 4);
      expect(dr.h).toBeCloseTo(boxH, 4);
      expect(dr.cx).toBeCloseTo(PROJ_W / 2 + pose.x, 6);
      expect(dr.cy).toBeCloseTo(PROJ_H / 2 + pose.y, 6);
    });
  }
});
