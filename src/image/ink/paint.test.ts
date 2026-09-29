import { describe, expect, it } from "vitest";
import type { Stroke } from "../../core/types";
import { encodePoints } from "../strokes";
import { ARROW_HEAD_DEG, ARROW_HEAD_WIDTHS, strokeBounds } from "./paint";

/** [x, y, pressure]* → the stored `p`. */
const pts = (...xyp: number[]): string => encodePoints(new Float32Array(xyp));

// Three points whose extremes come from different points on each axis:
// x 10..40, y -5..60.
const P = pts(10, 20, 0.5, 40, -5, 1, 25, 60, 0.25);

describe("strokeBounds", () => {
  it("pads an ink or erase stroke by half its width", () => {
    for (const s of [
      { t: "pen", c: "#112233", w: 6, o: 1, p: P },
      { t: "marker", c: "#ffd400", w: 6, o: 0.4, p: P },
      { t: "erase", w: 6, p: P },
    ] as Stroke[]) {
      expect(strokeBounds(s), s.t).toEqual({ x: 7, y: -8, w: 36, h: 71 });
    }
  });

  it("pads a pencil by its widest mark, 1.5 widths", () => {
    const s: Stroke = { t: "pencil", c: "#3a3a3a", w: 6, o: 0.65, p: P };
    expect(strokeBounds(s)).toEqual({ x: 5.5, y: -9.5, w: 39, h: 74 });
  });

  it("bounds a shape by its endpoints, whichever way it was drawn", () => {
    for (const t of ["line", "rect", "ellipse"] as const) {
      const s: Stroke = { t, c: "#e5484d", w: 4, a: [100, 50], b: [-20, 5] };
      expect(strokeBounds(s), t).toEqual({ x: -22, y: 3, w: 124, h: 49 });
    }
  });

  it("reaches both arrow-head wings, which can stick out past the endpoints", () => {
    // Pointing straight down the page: the shaft has no width in x, so only
    // the wings (and the half-width) give the box any.
    const w = 2;
    const s: Stroke = { t: "arrow", c: "#e5484d", w, a: [50, 100], b: [50, 0] };
    const head = ARROW_HEAD_WIDTHS * w;
    const rad = (ARROW_HEAD_DEG * Math.PI) / 180;
    const spread = head * Math.sin(rad);
    const b = strokeBounds(s);
    expect(b.x).toBeCloseTo(50 - spread - w / 2, 9);
    expect(b.w).toBeCloseTo(2 * spread + w, 9);
    expect(b.y).toBeCloseTo(0 - w / 2, 9);
    expect(b.h).toBeCloseTo(100 + w, 9);
    // The same arrow as a plain line is exactly the shaft.
    expect(strokeBounds({ ...s, t: "line" }).w).toBe(w);
  });

  it("caches per stroke object, and a stroke with nothing decodable is an empty box", () => {
    const s: Stroke = { t: "pen", c: "#112233", w: 6, o: 1, p: P };
    expect(strokeBounds(s)).toBe(strokeBounds(s));
    expect(strokeBounds({ t: "pen", c: "#112233", w: 6, o: 1, p: "not base64!" })).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});
