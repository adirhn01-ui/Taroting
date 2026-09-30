// Committed shapes: the range guard that keeps one out-of-range arrow from
// blocking every later save.

import { describe, expect, it } from "vitest";
import { validateStroke } from "../strokes";
import { SHAPE_MAX_COORD, shapeEndsInRange, shapeStroke, type Pt } from "./shapes";

describe("shapeStroke range", () => {
  it("commits a shape whose ends sit exactly on the bound, on every axis and sign", () => {
    const M = SHAPE_MAX_COORD;
    for (const [a, b] of [
      [[-M, 0], [M, 0]],
      [[0, -M], [0, M]],
      [[3, 4], [M, -M]],
    ] as [Pt, Pt][]) {
      const s = shapeStroke("arrow", "#ff0000", 4, a, b, 1);
      expect(s).not.toBeNull();
      // …and the loader keeps exactly what was committed
      expect(validateStroke(s)).toEqual(s);
    }
  });

  it("refuses a shape with any one end coordinate past the bound (what the loader and the save refuse)", () => {
    const over = SHAPE_MAX_COORD * 1.0000001;
    const inside: Pt = [120, 80];
    const cases: [Pt, Pt][] = [
      [[over, 80], [240, 160]],
      [[120, -over], [240, 160]],
      [inside, [-over, 160]],
      [inside, [240, over]],
    ];
    for (const kind of ["line", "arrow", "rect", "ellipse"] as const) {
      for (const [a, b] of cases) {
        expect(shapeStroke(kind, "#ff0000", 4, a, b, 1)).toBeNull();
        // the loader agrees: such a stroke could never be read back
        expect(validateStroke({ t: kind, c: "#ff0000", w: 4, a, b })).toBeNull();
      }
    }
  });

  it("an arrow drawn on a layer scaled to 0.05% (5000 canvas px → 1e7+ layer px) is not committed", () => {
    const scale = 0.0005;
    const a: Pt = [0, 0];
    const b: Pt = [5001 / scale, 0];
    expect(shapeEndsInRange(a, b)).toBe(false);
    expect(shapeStroke("arrow", "#000000", 2 / scale, a, b, 1 / scale)).toBeNull();
    // the same drag on the layer at 100% is an ordinary arrow
    expect(shapeStroke("arrow", "#000000", 2, a, [5001, 0], 1)).not.toBeNull();
  });

  it("still refuses a non-finite end", () => {
    expect(shapeEndsInRange([Number.NaN, 0], [1, 1])).toBe(false);
    expect(shapeStroke("line", "#000000", 2, [0, 0], [Infinity, 0], 1)).toBeNull();
  });
});
