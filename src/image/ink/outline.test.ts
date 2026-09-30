import { describe, expect, it } from "vitest";
import { CAP_SEGMENTS, emitOutline, outlinePolygon, penHalfWidth, pencilHalfWidth, type PathSink } from "./outline";

/** Points along a straight diagonal, so no axis is special: [x, y, p]*. */
function diagonal(n: number, p: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = 13 + 7 * i;
    out[i * 3 + 1] = -4 + 3 * i;
    out[i * 3 + 2] = p;
  }
  return out;
}

/** Width between the left chain's point k and the right chain's point k. */
function widthAt(pts: Float32Array, n: number, k: number, half: (p: number) => number): number {
  const o = outlinePolygon(pts, n, half);
  const lx = o.ring[k * 2]!;
  const ly = o.ring[k * 2 + 1]!;
  // right chain is stored reversed: its point for k is at rightStart + (m-1-k)
  const ri = (o.rightStart + (o.leftCount - 1 - k)) * 2;
  return Math.hypot(lx - o.ring[ri]!, ly - o.ring[ri + 1]!);
}

describe("pen outline", () => {
  it("is w wide at full pressure, 0.625w at half, a quarter at none", () => {
    const w = 10;
    const cases: [number, number][] = [
      [1, 10],
      [0.5, 6.25],
      [0, 2.5],
    ];
    for (const [p, want] of cases) {
      const pts = diagonal(5, p);
      // an interior point: its normal comes from both neighbours
      expect(widthAt(pts, 5, 2, penHalfWidth(w)), `p=${p}`).toBeCloseTo(want, 5);
    }
  });

  it("puts the chains on the normal, not along the stroke", () => {
    const pts = diagonal(4, 1);
    const o = outlinePolygon(pts, 4, penHalfWidth(10));
    // left point 1 minus the centre point 1 must be perpendicular to (7, 3)
    const dx = o.ring[2]! - pts[3]!;
    const dy = o.ring[3]! - pts[4]!;
    expect(dx * 7 + dy * 3).toBeCloseTo(0, 5);
    expect(Math.hypot(dx, dy)).toBeCloseTo(5, 5);
  });

  it("closes with two 8-segment round caps (7 new points each)", () => {
    const n = 6;
    const o = outlinePolygon(diagonal(n, 1), n, penHalfWidth(4));
    expect(o.leftCount).toBe(n);
    expect(o.rightStart).toBe(n + (CAP_SEGMENTS - 1));
    expect(o.ring.length / 2).toBe(2 * n + 2 * (CAP_SEGMENTS - 1));
    // The end cap's middle point sits half a width PAST the last point, along
    // the stroke — a round end, not a square one.
    const mid = (n + 3) * 2;
    const last = (n - 1) * 3;
    const along = ((o.ring[mid]! - diagonal(n, 1)[last]!) * 7 + (o.ring[mid + 1]! - diagonal(n, 1)[last + 1]!) * 3) / Math.hypot(7, 3);
    expect(along).toBeCloseTo(2, 1);
  });

  it("the pencil's width runs 0.75w to 1.5w with pressure", () => {
    expect(widthAt(diagonal(5, 0), 5, 2, pencilHalfWidth(8))).toBeCloseTo(6, 5);
    expect(widthAt(diagonal(5, 1), 5, 2, pencilHalfWidth(8))).toBeCloseTo(12, 5);
  });

  it("a single point (or all points in one place) is a dot of radius h", () => {
    const one = new Float32Array([5, 9, 0.5]);
    expect(outlinePolygon(one, 1, penHalfWidth(10)).dot).toEqual({ x: 5, y: 9, r: 3.125 });
    const same = new Float32Array([5, 9, 0.2, 5, 9, 1, 5, 9, 0.4]);
    // the widest pressure seen there wins
    expect(outlinePolygon(same, 3, penHalfWidth(10)).dot).toEqual({ x: 5, y: 9, r: 5 });
  });

  it("gives a hairpin a round join, wound like the ribbon", () => {
    // out along +x, then straight back: a 180° turn at point 1
    const pts = new Float32Array([0, 0, 1, 40, 0, 1, 0, 1, 1]);
    const o = outlinePolygon(pts, 3, penHalfWidth(6));
    expect(o.joins).toEqual([40, 0, 3]);
    // a gentle bend gets none
    const gentle = new Float32Array([0, 0, 1, 40, 0, 1, 80, 6, 1]);
    expect(outlinePolygon(gentle, 3, penHalfWidth(6)).joins).toEqual([]);

    // Winding: the ring's shoelace area is NEGATIVE, and each disk is emitted
    // anticlockwise (also negative), so nonzero unions them.
    const calls: { kind: string; args: number[]; ccw?: boolean }[] = [];
    const sink: PathSink = {
      moveTo: (x, y) => calls.push({ kind: "M", args: [x, y] }),
      lineTo: (x, y) => calls.push({ kind: "L", args: [x, y] }),
      arc: (x, y, r, a0, a1, ccw) => calls.push({ kind: "A", args: [x, y, r, a0, a1], ccw }),
      closePath: () => calls.push({ kind: "Z", args: [] }),
    };
    emitOutline(outlinePolygon(diagonal(4, 1), 4, penHalfWidth(6)), sink);
    const ring = calls.filter((c) => c.kind === "M" || c.kind === "L").map((c) => c.args);
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      area += x0! * y1! - x1! * y0!;
    }
    expect(area).toBeLessThan(0);
    calls.length = 0;
    emitOutline(o, sink);
    const disk = calls.find((c) => c.kind === "A")!;
    expect(disk.ccw).toBe(true);
    // a whole turn the canvas reads as one: start − end ≥ 2π when anticlockwise
    expect(disk.args[3]! - disk.args[4]!).toBeGreaterThanOrEqual(Math.PI * 2);
  });
});
