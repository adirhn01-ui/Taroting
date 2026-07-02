import { describe, expect, it } from "vitest";
import { snapMove, snapTime } from "./snap";

describe("snapTime", () => {
  const candidates = [0, 10, 20];

  it("snaps within the pixel threshold", () => {
    // 8px threshold at 10 px/sec = 0.8s
    expect(snapTime(10.5, candidates, 10, true)).toEqual({ t: 10, guide: 10 });
    expect(snapTime(9.3, candidates, 10, true)).toEqual({ t: 10, guide: 10 });
  });

  it("does not snap outside the threshold", () => {
    expect(snapTime(11.5, candidates, 10, true)).toEqual({ t: 11.5, guide: null });
  });

  it("threshold scales with zoom", () => {
    // at 100 px/sec the threshold is 0.08s
    expect(snapTime(10.5, candidates, 100, true).guide).toBeNull();
    expect(snapTime(10.05, candidates, 100, true).guide).toBe(10);
  });

  it("disabled → passthrough", () => {
    expect(snapTime(10.01, candidates, 100, false)).toEqual({ t: 10.01, guide: null });
  });
});

describe("snapMove", () => {
  it("snaps whichever edge is closer to a candidate", () => {
    const candidates = [50];
    // clip duration 10; start 40.5 → end 50.5 is 0.5s from 50 (within the
    // 0.8s threshold at 10 px/sec); the start edge is 9.5s away
    const r = snapMove(40.5, 10, candidates, 10, true);
    expect(r.guide).toBe(50);
    expect(r.t).toBeCloseTo(40, 9); // start moved so END sits at 50
  });

  it("prefers the start edge when it is nearer", () => {
    const r = snapMove(49.5, 10, [50], 10, true);
    expect(r.t).toBe(50);
  });

  it("no candidates in range → unchanged", () => {
    expect(snapMove(30, 5, [100], 10, true)).toEqual({ t: 30, guide: null });
  });
});
