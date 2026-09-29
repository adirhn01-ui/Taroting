import { describe, expect, it } from "vitest";
import type { ClipAdjust } from "../../core/types";
import { ADJUST_IDENTITY, isIdentityAdjust, sanitizeAdjust } from "./plan";

const KEYS = Object.keys(ADJUST_IDENTITY) as (keyof ClipAdjust)[];

describe("sanitizeAdjust", () => {
  it("rounds each field and clamps it to its OWN range: hue ±180, the rest ±100", () => {
    // Every value differs, and each out-of-range one sits between the two
    // ranges, so hue clamped to 100 (or brightness to 180) fails here.
    expect(
      sanitizeAdjust({
        exposure: 12.4,
        brightness: 150,
        contrast: 100.5,
        highlights: -37.6,
        shadows: 33,
        saturation: -99.5,
        hue: 200,
        warmth: -7,
        tint: -140,
      }),
    ).toEqual({
      exposure: 12,
      brightness: 100,
      contrast: 100,
      highlights: -38,
      shadows: 33,
      saturation: -99,
      hue: 180,
      warmth: -7,
      tint: -100,
    });
    expect(sanitizeAdjust({ hue: -150 })?.hue).toBe(-150);
    expect(sanitizeAdjust({ hue: -181 })?.hue).toBe(-180);
  });

  it("returns undefined for identity, however it is spelled", () => {
    expect(sanitizeAdjust({})).toBeUndefined();
    expect(sanitizeAdjust({ ...ADJUST_IDENTITY })).toBeUndefined();
    expect(sanitizeAdjust({ exposure: 0.4, hue: -0.49 })).toBeUndefined(); // rounds to zeros
    for (const raw of [undefined, null, 0, 12, "exposure", true, [12, 5]]) {
      expect(sanitizeAdjust(raw), String(raw)).toBeUndefined();
    }
  });

  it("reads anything that is not a finite number as 0 and never lets -0 through", () => {
    const out = sanitizeAdjust({
      exposure: "50",
      brightness: Number.NaN,
      contrast: Number.POSITIVE_INFINITY,
      highlights: null,
      shadows: 20,
      saturation: -0.3,
    })!;
    expect(out).toEqual({ ...ADJUST_IDENTITY, shadows: 20 });
    expect(Object.is(out.saturation, 0)).toBe(true);
  });

  it("returns a fresh object with exactly the nine keys", () => {
    const raw = { tint: 9, evil: "<script>", constructor: 1 };
    const out = sanitizeAdjust(raw)!;
    expect(Object.keys(out).sort()).toEqual([...KEYS].sort());
    expect(out).not.toBe(raw);
    expect(out).not.toBe(ADJUST_IDENTITY);
    expect(Object.isFrozen(ADJUST_IDENTITY)).toBe(true);
  });
});

describe("isIdentityAdjust", () => {
  it("is true only when every field is 0", () => {
    expect(isIdentityAdjust(undefined)).toBe(true);
    expect(isIdentityAdjust(ADJUST_IDENTITY)).toBe(true);
    // One key at a time, so a key the check forgets is caught by name.
    for (const k of KEYS) {
      expect(isIdentityAdjust({ ...ADJUST_IDENTITY, [k]: -1 }), k).toBe(false);
    }
  });
});
