import { describe, expect, it } from "vitest";
import {
  PALM_WINDOW_MS,
  PalmFilter,
  StrokeSampler,
  collectPoints,
  pressureOf,
  simplifyStroke,
  type PointerSample,
} from "./input";

type Ev = PointerSample & { getCoalescedEvents?: () => Ev[] };
const ev = (x: number, y: number, extra: Partial<Ev> = {}): Ev => ({
  clientX: x,
  clientY: y,
  pressure: 0.8,
  pointerType: "pen",
  ...extra,
});

describe("collectPoints", () => {
  it("falls back to the event itself when the browser coalesced nothing", () => {
    // Synthetic events and some drivers return [] — a move must still count.
    const e = ev(11, 17, { getCoalescedEvents: () => [] });
    expect(collectPoints(e)).toEqual([e]);
    const bare = ev(3, 4);
    expect(collectPoints(bare)).toEqual([bare]);
    const throws = ev(5, 6, {
      getCoalescedEvents: () => {
        throw new Error("no");
      },
    });
    expect(collectPoints(throws)).toEqual([throws]);
  });

  it("yields every coalesced sample when there are some", () => {
    const a = ev(1, 2);
    const b = ev(3, 5);
    const e = ev(3, 5, { getCoalescedEvents: () => [a, b] });
    expect(collectPoints(e)).toEqual([a, b]);
  });

  it("gives one sampler point per synthetic move (the E2E's premise)", () => {
    const s = new StrokeSampler(0.5, 0.5);
    s.push(0, 0, 0.8);
    for (let i = 1; i <= 6; i++) {
      for (const m of collectPoints(ev(i * 20, (i % 2) * 15, { getCoalescedEvents: () => [] }))) {
        s.push(m.clientX, m.clientY, pressureOf(m));
      }
    }
    expect(s.count).toBe(7);
  });
});

describe("pressureOf", () => {
  it("reads a pen's pressure and gives everything else full pressure", () => {
    expect(pressureOf({ pointerType: "pen", pressure: 0.3 })).toBe(0.3);
    expect(pressureOf({ pointerType: "pen", pressure: 1.7 })).toBe(1);
    expect(pressureOf({ pointerType: "mouse", pressure: 0.5 })).toBe(1);
    expect(pressureOf({ pointerType: "touch", pressure: 0 })).toBe(1);
  });
});

describe("StrokeSampler", () => {
  it("starts exactly where the pointer landed, then smooths", () => {
    const s = new StrokeSampler(0.5, 0.1);
    s.push(10, 20, 0.2);
    s.push(30, 60, 1);
    const p = s.points;
    expect([p[0], p[1], p[2]]).toEqual([10, 20, Math.fround(0.2)]);
    // EMA at 0.5: halfway on every channel
    expect([p[3], p[4]]).toEqual([20, 40]);
    expect(p[5]).toBeCloseTo(0.6, 6);
  });

  it("drops samples closer than the spacing, keeping the stronger pressure", () => {
    const s = new StrokeSampler(1, 2);
    s.push(0, 0, 0.3);
    expect(s.push(1, 1, 0.9)).toBe(false);
    expect(s.count).toBe(1);
    expect(s.points[2]).toBeCloseTo(0.9, 6);
    expect(s.push(3, 0, 0.5)).toBe(true);
    expect(s.count).toBe(2);
  });

  it("finish lands on the real last position, not the trailing average", () => {
    const s = new StrokeSampler(0.35, 0.5);
    s.push(0, 0, 1);
    s.push(100, 0, 1);
    s.finish(100, 0, Number.NaN);
    const n = s.count;
    expect(s.points[(n - 1) * 3]).toBe(100);
  });

  it("grows past its initial buffer without losing points", () => {
    const s = new StrokeSampler(1, 0);
    for (let i = 0; i < 500; i++) s.push(i * 2, -i, 0.5);
    expect(s.count).toBe(500);
    expect(s.points[499 * 3]).toBe(998);
    expect(s.points[499 * 3 + 1]).toBe(-499);
  });
});

describe("simplifyStroke (RDP)", () => {
  it("keeps the endpoints and drops collinear points", () => {
    const pts = new Float32Array([0, 0, 1, 10, 5, 1, 20, 10, 1, 30, 15, 1, 40, 20, 1]);
    const out = simplifyStroke(pts, 5, 0.25);
    expect(Array.from(out)).toEqual([0, 0, 1, 40, 20, 1]);
  });

  it("keeps a corner that departs by more than the tolerance", () => {
    const pts = new Float32Array([0, 0, 1, 10, 0, 1, 20, 0, 1, 20, 10, 1, 20, 20, 1]);
    expect(Array.from(simplifyStroke(pts, 5, 0.25))).toEqual([0, 0, 1, 20, 0, 1, 20, 20, 1]);
  });

  it("keeps the pressure extremes even on a straight line", () => {
    // Collinear in x/y; the pressure swells at index 2 and dips at index 5.
    const p = [0.5, 0.55, 0.95, 0.6, 0.5, 0.15, 0.45, 0.5];
    const pts = new Float32Array(p.flatMap((pr, i) => [i * 6, i * 3, pr]));
    const out = simplifyStroke(pts, p.length, 0.25);
    const kept = [];
    for (let i = 0; i < out.length; i += 3) kept.push(out[i]! / 6);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(p.length - 1);
    expect(kept).toContain(2);
    expect(kept).toContain(5);
  });

  it("keeps a local pressure swell that is not the stroke's extreme", () => {
    // global max at 1, global min at 7; the swell at 4 is neither, but its
    // pressure departs 0.3 from the chord's — its width would be lost.
    const p = [0.5, 0.95, 0.5, 0.5, 0.8, 0.5, 0.5, 0.1, 0.5];
    const pts = new Float32Array(p.flatMap((pr, i) => [i * 5, -i * 2, pr]));
    const out = simplifyStroke(pts, p.length, 0.25);
    const kept = [];
    for (let i = 0; i < out.length; i += 3) kept.push(Math.round(out[i]! / 5));
    expect(kept).toContain(1);
    expect(kept).toContain(4);
    expect(kept).toContain(7);
  });

  it("keeps the extremes even when they barely depart from the chord", () => {
    // 0.52 is under the pressure tolerance of the chord: only the extreme rule keeps it
    const p = [0.5, 0.5, 0.52, 0.5, 0.5];
    const pts = new Float32Array(p.flatMap((pr, i) => [i * 4, i * 4, pr]));
    const out = simplifyStroke(pts, p.length, 0.25);
    const kept = [];
    for (let i = 0; i < out.length; i += 3) kept.push(out[i]! / 4);
    expect(kept).toEqual([0, 2, 4]);
  });

  it("returns short strokes whole", () => {
    const pts = new Float32Array([1, 2, 0.5, 3, 4, 0.5]);
    expect(Array.from(simplifyStroke(pts, 2, 0.25))).toEqual([1, 2, 0.5, 3, 4, 0.5]);
  });
});

describe("PalmFilter", () => {
  it("ignores a touch that lands within 800 ms of pen activity", () => {
    const f = new PalmFilter();
    expect(f.mayDraw("touch", 1000)).toBe(true);
    const g = new PalmFilter();
    g.note("pen", 5000);
    expect(g.mayDraw("touch", 5000 + PALM_WINDOW_MS - 1)).toBe(false);
  });

  it("never lets touch draw once a pen has been seen, but mouse and pen always may", () => {
    const f = new PalmFilter();
    f.note("pen", 0);
    expect(f.mayDraw("touch", 60_000)).toBe(false);
    expect(f.mayDraw("pen", 1)).toBe(true);
    expect(f.mayDraw("mouse", 1)).toBe(true);
    f.note("mouse", 2);
    f.note("touch", 3);
    expect(f.mayDraw("mouse", 4)).toBe(true);
  });
});
