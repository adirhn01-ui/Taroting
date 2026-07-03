import { describe, expect, it } from "vitest";
import { MIN_CLIP_DUR } from "../../core/project";
import { clampSrcWindow } from "./relink";

/** clampSrcWindow keeps the clip's source window inside a (possibly shorter)
 *  source, never collapsing it to zero length. Guards the relink-to-shorter-file
 *  regression where srcIn beyond the new EOF produced an invisible clip. */
describe("clampSrcWindow", () => {
  it("returns null (no-op) for a longer or equal-length source", () => {
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 1 }, 60)).toBeNull();
    expect(clampSrcWindow({ srcIn: 0, srcOut: 10, speed: 1 }, 10)).toBeNull();
  });

  it("lowers only srcOut when srcIn still fits", () => {
    // srcIn (2) < new dur (5) < srcOut (8) → clamp srcOut to EOF, keep srcIn
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 1 }, 5)).toEqual({
      srcIn: 2,
      srcOut: 5,
    });
  });

  it("pulls srcIn back when it lands beyond the new EOF", () => {
    // srcIn (30) >= new dur (10): naive clamp would collapse to [10,10].
    // Instead srcIn is pulled back so a min-length window survives.
    const w = clampSrcWindow({ srcIn: 30, srcOut: 50, speed: 1 }, 10)!;
    expect(w.srcOut).toBe(10);
    expect(w.srcIn).toBeCloseTo(10 - MIN_CLIP_DUR, 12);
    expect(w.srcOut - w.srcIn).toBeGreaterThanOrEqual(MIN_CLIP_DUR - 1e-12);
  });

  it("never produces a zero-length clip (srcIn < srcOut, source length >= floor)", () => {
    for (const speed of [0.25, 1, 4]) {
      const w = clampSrcWindow({ srcIn: 100, srcOut: 120, speed }, 3)!;
      expect(w.srcIn).toBeGreaterThanOrEqual(0);
      expect(w.srcOut).toBeLessThanOrEqual(3);
      expect(w.srcOut).toBeGreaterThan(w.srcIn);
      // timeline duration = (srcOut - srcIn) / speed stays >= the min floor
      expect((w.srcOut - w.srcIn) / speed).toBeGreaterThanOrEqual(MIN_CLIP_DUR - 1e-12);
    }
  });

  it("scales the source floor with speed so timeline duration meets the min", () => {
    // At 4x, one min-length timeline clip needs 4 * MIN_CLIP_DUR source-seconds.
    const w = clampSrcWindow({ srcIn: 100, srcOut: 120, speed: 4 }, 10)!;
    expect(w.srcOut - w.srcIn).toBeCloseTo(4 * MIN_CLIP_DUR, 12);
  });

  it("clamps into [0, dur] best-effort when the source is shorter than one frame", () => {
    // dur (0.001s) < minSrcLen: cannot satisfy the floor; keep it in-bounds.
    const w = clampSrcWindow({ srcIn: 5, srcOut: 9, speed: 1 }, 0.001)!;
    expect(w.srcIn).toBe(0);
    expect(w.srcOut).toBe(0.001);
  });
});
