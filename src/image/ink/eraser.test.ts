import { describe, expect, it } from "vitest";
import type { Stroke } from "../../core/types";
import { encodePoints } from "../strokes";
import { collectStrokeHits, segSegDistance, strokeHit } from "./eraser";

const pts = (...xyp: number[]): string => encodePoints(new Float32Array(xyp));

describe("segSegDistance", () => {
  it("is 0 for crossing segments and the nearest gap otherwise", () => {
    expect(segSegDistance(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0);
    // parallel, 3 apart
    expect(segSegDistance(0, 0, 10, 0, 2, 3, 8, 3)).toBeCloseTo(3, 12);
    // end to end: (10,0) to (13,4) = 5
    expect(segSegDistance(0, 0, 10, 0, 13, 4, 20, 4)).toBeCloseTo(5, 12);
    // a degenerate eraser segment (a tap) is a point
    expect(segSegDistance(0, 0, 10, 0, 5, -7, 5, -7)).toBeCloseTo(7, 12);
  });
});

describe("strokeHit", () => {
  // A pen stroke along y = 40 from x 10 to 90, 6 wide (half-width 3).
  const pen: Stroke = { t: "pen", c: "#112233", w: 6, o: 1, p: pts(10, 40, 1, 90, 40, 1) };

  it("reaches exactly r + w/2 from the centre line", () => {
    // eraser radius 5 → hits up to 8 away
    expect(strokeHit(pen, 50, 48, 50, 48, 5)).toBe(true);
    expect(strokeHit(pen, 50, 48.01, 50, 48.01, 5)).toBe(false);
    // a swept eraser crossing the stroke between two samples still hits
    expect(strokeHit(pen, 30, 20, 70, 60, 1)).toBe(true);
  });

  it("reaches a pencil mark's full painted width, a pen only its own", () => {
    // Same 6-wide line; a mouse pencil paints a half-width of 0.75w = 4.5, so
    // a point 0.7w = 4.2 from the centre sits on grey the pen never paints.
    const pencil: Stroke = { ...pen, t: "pencil" };
    expect(strokeHit(pencil, 50, 44.2, 50, 44.2, 0)).toBe(true);
    expect(strokeHit(pen, 50, 44.2, 50, 44.2, 0)).toBe(false);
    expect(strokeHit(pencil, 50, 44.51, 50, 44.51, 0)).toBe(false);
  });

  it("hits a shape by its outline, not its inside", () => {
    const rect: Stroke = { t: "rect", c: "#e5484d", w: 2, a: [0, 0], b: [100, 60] };
    expect(strokeHit(rect, 50, 30, 50, 30, 4)).toBe(false);
    expect(strokeHit(rect, 50, 4, 50, 4, 4)).toBe(true);
    // an arrow's wing reaches past its shaft
    const arrow: Stroke = { t: "arrow", c: "#e5484d", w: 5, a: [0, 0], b: [100, 0] };
    // wing tip ≈ (100 − 20cos28°, ±20sin28°) = (82.3, ±9.4)
    expect(strokeHit(arrow, 83, 9, 83, 9, 1)).toBe(true);
    expect(strokeHit({ ...arrow, t: "line" }, 83, 9, 83, 9, 1)).toBe(false);
  });

  it("never picks an erase stroke (removing one would bring back what it cut)", () => {
    const erase: Stroke = { t: "erase", w: 20, p: pts(10, 40, 1, 90, 40, 1) };
    expect(strokeHit(erase, 50, 40, 50, 40, 5)).toBe(false);
  });

  it("a one-point stroke is a dot", () => {
    const dot: Stroke = { t: "marker", c: "#ffd400", w: 10, o: 0.4, p: pts(5, 5, 1) };
    expect(strokeHit(dot, 5, 14, 5, 14, 4)).toBe(true);
    expect(strokeHit(dot, 5, 15, 5, 15, 4)).toBe(false);
  });
});

describe("collectStrokeHits", () => {
  it("adds each touched stroke once and reports only the new ones", () => {
    const a: Stroke = { t: "pen", c: "#112233", w: 2, o: 1, p: pts(0, 0, 1, 10, 0, 1) };
    const b: Stroke = { t: "pen", c: "#112233", w: 2, o: 1, p: pts(0, 30, 1, 10, 30, 1) };
    const c: Stroke = { t: "pen", c: "#112233", w: 2, o: 1, p: pts(0, 60, 1, 10, 60, 1) };
    const chunks = [[a, b], [c]];
    const set = new Set<Stroke>();
    expect(collectStrokeHits(chunks, 5, -2, 5, 31, 1, set)).toBe(2);
    expect([...set]).toEqual([a, b]);
    expect(collectStrokeHits(chunks, 5, 25, 5, 62, 1, set)).toBe(1);
    expect(set.has(c)).toBe(true);
  });
});
