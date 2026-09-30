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

  it("splits a hairpin into two capped sub-rings, with no disk at the turn", () => {
    // out along +x, then (almost) straight back: a ~179° turn at point 1
    const pts = new Float32Array([0, 0, 1, 40, 0, 1, 0, 1, 1]);
    const o = outlinePolygon(pts, 3, penHalfWidth(6));
    // each run is 2 points: 2 chain points per side + two 7-point caps. The
    // two caps meeting at the turn are its round join: nothing else is drawn
    // there (a disk there was the dot at each turn of a ruler line).
    const run = 2 * 2 + 2 * (CAP_SEGMENTS - 1);
    expect(o.ends).toEqual([run, 2 * run]);
    expect(o.ring.length / 2).toBe(2 * run);
  });

  it("splits every sharp turn, 90° and 60° alike, but not a gentle bend", () => {
    const run = 2 * 2 + 2 * (CAP_SEGMENTS - 1);
    const square = outlinePolygon(new Float32Array([0, 0, 1, 40, 0, 1, 40, 25, 1]), 3, penHalfWidth(6));
    expect(square.ends).toEqual([run, 2 * run]);
    const sixty = new Float32Array([0, 0, 1, 40, 0, 1, 40 + 30 * Math.cos(Math.PI / 3), 30 * Math.sin(Math.PI / 3), 1]);
    expect(outlinePolygon(sixty, 3, penHalfWidth(6)).ends).toEqual([run, 2 * run]);
    // ~8.5°: one ring, the bend inside it
    const gentle = new Float32Array([0, 0, 1, 40, 0, 1, 80, 6, 1]);
    expect(outlinePolygon(gentle, 3, penHalfWidth(6)).ends).toEqual([2 * 3 + 2 * (CAP_SEGMENTS - 1)]);
  });

  it("winds every sub-ring the same way, so nonzero unions them", () => {
    // Winding: each ring's shoelace area is NEGATIVE — a straight run, and both
    // halves of a split 60° bend.
    const areas = (o: ReturnType<typeof outlinePolygon>): number[] => {
      const out: number[] = [];
      let from = 0;
      for (const to of o.ends) {
        let area = 0;
        for (let i = from; i < to; i++) {
          const j = i + 1 < to ? i + 1 : from;
          area += o.ring[i * 2]! * o.ring[j * 2 + 1]! - o.ring[j * 2]! * o.ring[i * 2 + 1]!;
        }
        out.push(area);
        from = to;
      }
      return out;
    };
    for (const a of areas(outlinePolygon(diagonal(4, 1), 4, penHalfWidth(6)))) expect(a).toBeLessThan(0);
    const sixty = new Float32Array([0, 0, 1, 40, 0, 1, 40 + 30 * Math.cos(Math.PI / 3), 30 * Math.sin(Math.PI / 3), 1]);
    const bent = areas(outlinePolygon(sixty, 3, penHalfWidth(6)));
    expect(bent).toHaveLength(2);
    for (const a of bent) expect(a).toBeLessThan(0);

    // A dot is a whole circle, anticlockwise like the rings.
    const calls: { kind: string; args: number[]; ccw?: boolean }[] = [];
    const sink: PathSink = {
      moveTo: (x, y) => calls.push({ kind: "M", args: [x, y] }),
      lineTo: (x, y) => calls.push({ kind: "L", args: [x, y] }),
      arc: (x, y, r, a0, a1, ccw) => calls.push({ kind: "A", args: [x, y, r, a0, a1], ccw }),
      closePath: () => calls.push({ kind: "Z", args: [] }),
    };
    emitOutline(outlinePolygon(new Float32Array([5, 9, 1]), 1, penHalfWidth(6)), sink);
    const disk = calls.find((c) => c.kind === "A")!;
    expect(disk.ccw).toBe(true);
    // a whole turn the canvas reads as one: start − end ≥ 2π when anticlockwise
    expect(disk.args[3]! - disk.args[4]!).toBeGreaterThanOrEqual(Math.PI * 2);
    // and a stroke emits no arcs at all: its joins are its caps
    calls.length = 0;
    emitOutline(outlinePolygon(sixty, 3, penHalfWidth(6)), sink);
    expect(calls.filter((c) => c.kind === "A")).toEqual([]);
  });
});

/* ---------------- coverage, measured by winding number ---------------- */

/** The emitted path as closed polygons (arcs flattened in their own
 *  direction), so a point's winding can be counted the way canvas fills it. */
function subpaths(o: ReturnType<typeof outlinePolygon>): number[][] {
  const polys: number[][] = [];
  let cur: number[] = [];
  const flush = (): void => {
    if (cur.length >= 6) polys.push(cur);
    cur = [];
  };
  emitOutline(o, {
    moveTo: (x, y) => {
      flush();
      cur.push(x, y);
    },
    lineTo: (x, y) => void cur.push(x, y),
    arc: (x, y, r, a0, a1, ccw) => {
      // canvas: a whole turn when the arc spans ≥ 2π in its own direction
      let sweep = a1 - a0;
      if (ccw && a0 - a1 >= Math.PI * 2) sweep = -Math.PI * 2;
      if (!ccw && a1 - a0 >= Math.PI * 2) sweep = Math.PI * 2;
      for (let i = 0; i <= 64; i++) {
        const a = a0 + (sweep * i) / 64;
        cur.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
    },
    closePath: flush,
  });
  flush();
  return polys;
}

/** Winding number of (px, py) over closed polygons (nonzero = painted). */
function winding(polys: number[][], px: number, py: number): number {
  let wn = 0;
  for (const p of polys) {
    const m = p.length / 2;
    for (let i = 0; i < m; i++) {
      const x0 = p[i * 2]!;
      const y0 = p[i * 2 + 1]!;
      const j = (i + 1) % m;
      const x1 = p[j * 2]!;
      const y1 = p[j * 2 + 1]!;
      const side = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
      if (y0 <= py) {
        if (y1 > py && side > 0) wn++;
      } else if (y1 <= py && side < 0) wn--;
    }
  }
  return wn;
}

/** Points at constant pressure 1: [x, y, 1]*. */
function at(...xy: number[]): Float32Array {
  const out = new Float32Array((xy.length / 2) * 3);
  for (let i = 0; i < xy.length / 2; i++) {
    out[i * 3] = xy[i * 2]!;
    out[i * 3 + 1] = xy[i * 2 + 1]!;
    out[i * 3 + 2] = 1;
  }
  return out;
}

/** Distance from (px, py) to the polyline through the points. */
function distance(pts: Float32Array, px: number, py: number): number {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length / 3; i++) {
    const ax = pts[i * 3]!;
    const ay = pts[i * 3 + 1]!;
    const dx = pts[i * 3 + 3]! - ax;
    const dy = pts[i * 3 + 4]! - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return d;
}

describe("pen outline coverage", () => {
  // the pen's half-width at full pressure for w = 14
  const W = 14;
  const H = 7;

  // Ink on the ruler, simplified: a line that doubles back on itself. One
  // ribbon filled the doubled-back part as a hairline with blank wedges.
  const reversals: [string, Float32Array][] = [
    ["out to 300, back to 200", at(0, 0, 300, 0, 200, 0)],
    ["out to 300, back to 100, out to 250", at(0, 0, 300, 0, 100, 0, 250, 0)],
  ];
  for (const [name, pts] of reversals) {
    it(`fills a ruler line that reverses (${name}) solid, with no join dots`, () => {
      const o = outlinePolygon(pts, pts.length / 3, penHalfWidth(W));
      const polys = subpaths(o);
      const holes: string[] = [];
      const spill: string[] = [];
      // off-grid steps, so no sample sits exactly on a vertex or an edge
      for (let x = 0.13; x <= 300; x += 1.7) {
        for (let y = -0.9 * H + 0.05; y < 0.9 * H; y += 0.61) {
          if (winding(polys, x, y) === 0) holes.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        }
        for (const y of [-3 * H, -2 * H, -1.1 * H - 0.01, 1.1 * H + 0.01, 2 * H, 3 * H]) {
          if (winding(polys, x, y) !== 0) spill.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        }
      }
      expect(holes).toEqual([]);
      expect(spill).toEqual([]);
    });
  }

  it("fills a freehand zigzag of sharp, lopsided turns with no holes and no spill", () => {
    // turns of ~150°, ~136°, ~164°, ~142°, each a long leg against a short
    // one (the ratio that twists a single ribbon)
    const pts = at(0, 0, 110, 0, 75.4, 20, 180, 45, 150, 62, 290, 80);
    const o = outlinePolygon(pts, 6, penHalfWidth(W));
    const polys = subpaths(o);
    let holes = 0;
    let spill = 0;
    for (let x = -20.13; x <= 310; x += 0.93) {
      for (let y = -20.07; y <= 100; y += 0.87) {
        const d = distance(pts, x, y);
        const wn = winding(polys, x, y);
        if (d < 0.9 * H && wn === 0) holes++;
        if (d > 1.1 * H && wn !== 0) spill++;
      }
    }
    expect(holes).toBe(0);
    expect(spill).toBe(0);
    expect(o.ends).toHaveLength(5);
  });

  it("keeps full width into 35°–90° corners: no thinning at a bend", () => {
    // headings 0°, 44°, −9°, 61°, −24°: turns of 44°, 53°, 70° and 85°, long
    // legs against short ones. One ribbon put the corner offset on the
    // bisector, only h·cos(θ/2) off each leg, so the band just inside the edge
    // went uncovered next to the corner.
    const pts = at(0, 0, 90, 0, 105.83, 15.28, 184.84, 2.77, 198.41, 27.26, 280.63, -9.35);
    const o = outlinePolygon(pts, 6, penHalfWidth(W));
    const polys = subpaths(o);
    let holes = 0;
    let spill = 0;
    for (let x = -20.13; x <= 300; x += 0.53) {
      for (let y = -30.07; y <= 50; y += 0.51) {
        const d = distance(pts, x, y);
        const wn = winding(polys, x, y);
        if (d < 0.97 * H && wn === 0) holes++;
        if (d > 1.1 * H && wn !== 0) spill++;
      }
    }
    expect(holes).toBe(0);
    expect(spill).toBe(0);
    expect(o.ends).toHaveLength(5);
  });

  it("keeps a stroke with no sharp turn one ring: no extra subpaths or points", () => {
    const n = 101;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pts[i * 3] = 3 * i;
      pts[i * 3 + 1] = 30 * Math.sin(i / 15);
      pts[i * 3 + 2] = 0.3 + (0.7 * ((i * 7) % 10)) / 10;
    }
    const o = outlinePolygon(pts, n, penHalfWidth(W));
    expect(o.ends).toEqual([2 * n + 2 * (CAP_SEGMENTS - 1)]);
    expect(o.ring.length / 2).toBe(2 * n + 2 * (CAP_SEGMENTS - 1));
    expect(subpaths(o)).toHaveLength(1);
  });
});
