import { describe, expect, it } from "vitest";
import type { ClipTransform } from "../core/types";
import { canvasToLayer, hitLayer, layerCorners, layerToCanvas } from "./geom";

const W = 641;
const H = 361;

const xf = (patch: Partial<ClipTransform>): ClipTransform => ({
  rotate: 0,
  flipH: false,
  flipV: false,
  scale: 1,
  x: 0,
  y: 0,
  opacity: 1,
  ...patch,
});

const apply = (m: number[], x: number, y: number): [number, number] => [
  m[0]! * x + m[2]! * y + m[4]!,
  m[1]! * x + m[3]! * y + m[5]!,
];

describe("layerToCanvas / canvasToLayer", () => {
  it("round-trip for every rotation × flip, with a crop and a non-unit scale", () => {
    // Values that differ on every axis the maths could confuse: a 200×100
    // photo cropped off-centre, scale 0.73, an offset in both directions.
    const probes: [number, number][] = [
      [10, 5],
      [159, 84],
      [73.25, 41.5],
    ];
    for (const rotate of [0, 90, 180, 270] as const) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          const t = xf({ rotate, flipH, flipV, scale: 0.73, x: 37, y: -19, crop: { x: 10, y: 5, w: 150, h: 80 } });
          const m = layerToCanvas(t, 200, 100, W, H);
          for (const [lx, ly] of probes) {
            const [cx, cy] = apply(m, lx, ly);
            const back = canvasToLayer(t, 200, 100, W, H, cx, cy);
            const tag = `${rotate} ${flipH} ${flipV} (${lx},${ly})`;
            expect(back.x, tag).toBeCloseTo(lx, 9);
            expect(back.y, tag).toBeCloseTo(ly, 9);
          }
          // The crop window's centre lands on (W/2 + x, H/2 + y) whatever the pose.
          const [ccx, ccy] = apply(m, 10 + 75, 5 + 40);
          expect(ccx).toBeCloseTo(W / 2 + 37, 9);
          expect(ccy).toBeCloseTo(H / 2 - 19, 9);
        }
      }
    }
  });

  it("is native-pixel: scale 1, no rotation, maps one source px to one canvas px", () => {
    const m = layerToCanvas(xf({ x: 12, y: -7 }), 100, 60, W, H);
    // Top-left of the media box sits at centre - half size + offset.
    expect(m).toEqual([1, 0, 0, 1, W / 2 - 50 + 12, H / 2 - 30 - 7]);
  });

  it("uses exact quarter-turn coefficients (no 6e-17 residue)", () => {
    const m = layerToCanvas(xf({ rotate: 90, scale: 2 }), 100, 60, W, H);
    expect(Math.abs(m[0])).toBe(0);
    expect(Math.abs(m[3])).toBe(0);
    expect(m[1]).toBe(2);
    expect(m[2]).toBe(-2);
  });

  it("maps an unusable scale as 1 instead of producing NaN", () => {
    for (const scale of [0, -3, NaN, Infinity]) {
      const p = canvasToLayer(xf({ scale }), 100, 60, W, H, W / 2, H / 2);
      expect(p, String(scale)).toEqual({ x: 50, y: 30 });
    }
  });
});

describe("layerCorners", () => {
  it("a 200×100 photo at x=30, y=−10, scale 0.5, rotated 90° on 641×361", () => {
    // Centre (350.5, 170.5); the half-extents (50, 25) turn clockwise to
    // (−25, 50)-style offsets: TL (−50,−25) → (25,−50), TR (50,−25) → (25,50),
    // BR (50,25) → (−25,50), BL (−50,25) → (−25,−50).
    const c = layerCorners(xf({ x: 30, y: -10, scale: 0.5, rotate: 90 }), 200, 100, W, H);
    const want = [
      [375.5, 120.5],
      [375.5, 220.5],
      [325.5, 220.5],
      [325.5, 120.5],
    ];
    c.forEach(([x, y], i) => {
      expect(x, `corner ${i} x`).toBeCloseTo(want[i]![0]!, 9);
      expect(y, `corner ${i} y`).toBeCloseTo(want[i]![1]!, 9);
    });
  });

  it("bounds the crop clamped into the media box, as the video preview does", () => {
    // The crop asks for 500 px from x=150 of a 200 px photo: 50 px are there.
    const c = layerCorners(xf({ crop: { x: 150, y: 20, w: 500, h: 30 } }), 200, 100, W, H);
    expect(c[1]![0] - c[0]![0]).toBeCloseTo(50, 9);
    expect(c[3]![1] - c[0]![1]).toBeCloseTo(30, 9);
  });
});

describe("hitLayer", () => {
  it("tests the rotated outline, not an axis-aligned box", () => {
    // 200×100 turned 90°: 100 wide and 200 tall on the canvas.
    const t = xf({ rotate: 90 });
    const cx = W / 2;
    const cy = H / 2;
    expect(hitLayer(t, 200, 100, W, H, cx + 80, cy)).toBe(false);
    expect(hitLayer(t, 200, 100, W, H, cx, cy + 80)).toBe(true);
    expect(hitLayer(t, 200, 100, W, H, cx + 49, cy - 99)).toBe(true);
    expect(hitLayer(t, 200, 100, W, H, cx + 51, cy)).toBe(false);
  });

  it("only the cropped window is hit", () => {
    const t = xf({ crop: { x: 0, y: 0, w: 100, h: 100 } });
    // The window (100×100) is centred on the canvas; the rest of the photo is not there.
    expect(hitLayer(t, 200, 100, W, H, W / 2 + 49, H / 2)).toBe(true);
    expect(hitLayer(t, 200, 100, W, H, W / 2 + 60, H / 2)).toBe(false);
  });
});
