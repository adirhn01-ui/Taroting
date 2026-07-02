import { describe, expect, it } from "vitest";
import {
  clampedBreakpoints,
  EPS_KF,
  evalKfs,
  kfNear,
  KfCursor,
  removeKfNear,
  upsertKf,
} from "./anim";
import type { Keyframe } from "./types";

const kfs = (...pairs: [number, number][]): Keyframe[] =>
  pairs.map(([t, v]) => ({ t, v }));

describe("evalKfs", () => {
  it("throws on an empty array", () => {
    expect(() => evalKfs([], 0)).toThrow();
  });

  it("is constant for a single keyframe", () => {
    const k = kfs([5, 7]);
    expect(evalKfs(k, 0)).toBe(7);
    expect(evalKfs(k, 5)).toBe(7);
    expect(evalKfs(k, 100)).toBe(7);
  });

  it("clamps before first and after last", () => {
    const k = kfs([2, 10], [4, 20]);
    expect(evalKfs(k, -1)).toBe(10);
    expect(evalKfs(k, 2)).toBe(10);
    expect(evalKfs(k, 4)).toBe(20);
    expect(evalKfs(k, 99)).toBe(20);
  });

  it("interpolates linearly between", () => {
    const k = kfs([0, 0], [10, 100]);
    expect(evalKfs(k, 5)).toBeCloseTo(50, 12);
    expect(evalKfs(k, 2.5)).toBeCloseTo(25, 12);
  });

  it("interpolates across multiple segments exactly", () => {
    const k = kfs([0, 0], [1, 10], [3, 10], [4, 0]);
    expect(evalKfs(k, 0.5)).toBeCloseTo(5, 12);
    expect(evalKfs(k, 2)).toBeCloseTo(10, 12); // flat middle
    expect(evalKfs(k, 3.5)).toBeCloseTo(5, 12);
  });
});

describe("KfCursor", () => {
  const k = kfs([0, 0], [1, 10], [2, 5], [5, 25], [9, -3]);

  it("matches evalKfs over a monotone sweep", () => {
    const cur = new KfCursor();
    for (let s = -2; s <= 11; s += 0.017) {
      expect(cur.eval(k, s)).toBeCloseTo(evalKfs(k, s), 12);
    }
  });

  it("matches evalKfs over a random-access sequence", () => {
    const cur = new KfCursor();
    const samples = [3.2, -1, 8.9, 0.5, 5, 2.1, 10, 0, 1.5, 4.4, 9, 6.6];
    for (const s of samples) {
      expect(cur.eval(k, s)).toBeCloseTo(evalKfs(k, s), 12);
    }
  });

  it("matches evalKfs after swapping the kfs array identity", () => {
    const cur = new KfCursor();
    const a = kfs([0, 0], [10, 100]);
    const b = kfs([0, 100], [10, 0]);
    expect(cur.eval(a, 5)).toBeCloseTo(50, 12);
    expect(cur.eval(b, 5)).toBeCloseTo(50, 12); // identity change → re-seek
    expect(cur.eval(a, 2)).toBeCloseTo(20, 12);
    expect(cur.eval(b, 2)).toBeCloseTo(80, 12);
  });

  it("throws on an empty array", () => {
    expect(() => new KfCursor().eval([], 0)).toThrow();
  });
});

describe("upsertKf / removeKfNear / kfNear", () => {
  it("inserts in sorted order", () => {
    let k = upsertKf(undefined, 5, 1, EPS_KF);
    k = upsertKf(k, 1, 2, EPS_KF);
    k = upsertKf(k, 3, 3, EPS_KF);
    expect(k.map((x) => x.t)).toEqual([1, 3, 5]);
  });

  it("replaces a keyframe within eps (dedupe)", () => {
    const k0 = kfs([1, 10], [2, 20]);
    const k = upsertKf(k0, 1 + EPS_KF / 2, 99, EPS_KF);
    expect(k).toHaveLength(2);
    expect(k[0]!.v).toBe(99);
    expect(k0[0]!.v).toBe(10); // original untouched (new array)
  });

  it("inserts a distinct keyframe just outside eps", () => {
    const k = upsertKf(kfs([1, 10]), 1 + EPS_KF * 2, 20, EPS_KF);
    expect(k).toHaveLength(2);
  });

  it("removeKfNear drops within eps only", () => {
    const k = kfs([1, 1], [2, 2], [3, 3]);
    expect(removeKfNear(k, 2 + EPS_KF / 2, EPS_KF).map((x) => x.t)).toEqual([1, 3]);
    expect(removeKfNear(k, 2.5, EPS_KF)).toHaveLength(3);
  });

  it("kfNear returns the nearest within eps or null", () => {
    const k = kfs([1, 1], [2, 2]);
    expect(kfNear(k, 2 + EPS_KF / 2, EPS_KF)!.v).toBe(2);
    expect(kfNear(k, 2.5, EPS_KF)).toBeNull();
    expect(kfNear(undefined, 0, EPS_KF)).toBeNull();
  });
});

describe("clampedBreakpoints", () => {
  it("always includes endpoints at tl=0 and tl=dur", () => {
    const k = kfs([0, 0], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 1);
    expect(bp[0]).toEqual({ tl: 0, v: 0 });
    expect(bp[bp.length - 1]).toEqual({ tl: 10, v: 100 });
  });

  it("ghost keyframes anchor endpoint values (clamped range)", () => {
    // range [2,8) inside a 0..10 ramp: endpoints interpolate to 20 and 80
    const k = kfs([0, 0], [10, 100]);
    const bp = clampedBreakpoints(k, 2, 8, 1);
    expect(bp[0]!.v).toBeCloseTo(20, 12);
    expect(bp[bp.length - 1]!.v).toBeCloseTo(80, 12);
  });

  it("maps interior keyframes to timeline-local time", () => {
    const k = kfs([0, 0], [5, 50], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 1);
    // endpoints + one interior at t=5 → tl=5
    expect(bp.map((b) => b.tl)).toEqual([0, 5, 10]);
    expect(bp[1]!.v).toBe(50);
  });

  it("halves tl at speed 2", () => {
    const k = kfs([0, 0], [5, 50], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 2); // dur = 5
    expect(bp.map((b) => b.tl)).toEqual([0, 2.5, 5]);
  });

  it("drops interior keyframes coincident with an endpoint", () => {
    // a keyframe exactly at srcIn/srcOut is excluded (endpoints cover it)
    const k = kfs([0, 0], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 1);
    expect(bp).toHaveLength(2);
    // an interior keyframe within 1e-9 of the start maps away
    const k2 = kfs([0, 0], [1e-10, 5], [10, 100]);
    const bp2 = clampedBreakpoints(k2, 0, 10, 1);
    expect(bp2).toHaveLength(2);
  });
});
