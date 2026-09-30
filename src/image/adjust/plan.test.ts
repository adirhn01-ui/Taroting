import { describe, expect, it } from "vitest";
import type { ClipAdjust } from "../../core/types";
import {
  ADJUST_IDENTITY,
  applyAdjustPlan,
  buildAdjustPlan,
  isIdentityAdjust,
  sanitizeAdjust,
} from "./plan";

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

/* ---------------- the pixel pipeline ---------------- */

// Written here from IEC 61966-2-1, independently of plan.ts, so a slip in the
// module's transfer functions cannot also be in the expectation.
const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (l: number): number => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);

const adj = (patch: Partial<ClipAdjust>): ClipAdjust => ({ ...ADJUST_IDENTITY, ...patch });

/** One pixel through the whole pipeline; returns [r, g, b, a]. */
function run(a: ClipAdjust, r: number, g: number, b: number, alpha = 255): number[] {
  const px = new Uint8ClampedArray([r, g, b, alpha]);
  applyAdjustPlan(px, buildAdjustPlan(a));
  return [...px];
}

/** A grey ramp 0..255 through one plan; returns the red channel. */
function ramp(a: ClipAdjust): number[] {
  const px = new Uint8ClampedArray(256 * 4);
  for (let c = 0; c < 256; c++) px[c * 4] = px[c * 4 + 1] = px[c * 4 + 2] = c;
  applyAdjustPlan(px, buildAdjustPlan(a));
  return Array.from({ length: 256 }, (_, c) => px[c * 4]!);
}

describe("buildAdjustPlan / applyAdjustPlan", () => {
  it("the identity plan returns every value of every channel unchanged", () => {
    const px = new Uint8ClampedArray(256 * 4);
    for (let c = 0; c < 256; c++) {
      // Each channel runs a different ramp, so a channel read through another
      // channel's table (or R and B swapped) cannot land on the same bytes.
      px[c * 4] = c;
      px[c * 4 + 1] = 255 - c;
      px[c * 4 + 2] = (c * 7) % 256;
      px[c * 4 + 3] = (c * 13) % 256;
    }
    const before = [...px];
    const plan = buildAdjustPlan(ADJUST_IDENTITY);
    expect(plan.matrixIsIdentity).toBe(true);
    applyAdjustPlan(px, plan);
    expect([...px]).toEqual(before);
  });

  it("warmth ±60 tilts a grey red↔blue in opposite directions and keeps its luminance", () => {
    const Y = (p: number[]): number =>
      0.2126 * lin(p[0]! / 255) + 0.7152 * lin(p[1]! / 255) + 0.0722 * lin(p[2]! / 255);
    const warm = run(adj({ warmth: 60 }), 128, 128, 128);
    const cool = run(adj({ warmth: -60 }), 128, 128, 128);
    expect(warm[0]).toBeGreaterThan(128);
    expect(warm[2]).toBeLessThan(128);
    expect(cool[0]).toBeLessThan(128);
    expect(cool[2]).toBeGreaterThan(128);
    // The normalization is what holds this: without it +60 lifts the grey by
    // about 2.3 % in linear light.
    expect(Math.abs(enc(Y(warm)) * 255 - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(enc(Y(cool)) * 255 - 128)).toBeLessThanOrEqual(1);
  });

  it("exposure +50 is exactly one stop, applied in linear light", () => {
    const want = Math.round(enc(2 * lin(64 / 255)) * 255);
    expect(want).toBe(90); // not 128: doubling the sRGB code value is not a stop
    expect(run(adj({ exposure: 50 }), 64, 64, 64).slice(0, 3)).toEqual([want, want, want]);
  });

  it("brightness is a midtone gamma: black and white stay put, the ramp stays monotone", () => {
    for (const brightness of [100, 60, -60, -100]) {
      const out = ramp(adj({ brightness }));
      expect(out[0], `${brightness}`).toBe(0);
      expect(out[255], `${brightness}`).toBe(255);
      for (let c = 1; c < 256; c++) expect(out[c]!).toBeGreaterThanOrEqual(out[c - 1]!);
      // ...and it moves the middle the right way: ±100 → gamma 0.5 / 2.
      const want = Math.round((128 / 255) ** 2 ** (-brightness / 100) * 255);
      expect(out[128], `${brightness}`).toBe(want);
    }
    expect(ramp(adj({ brightness: 100 }))[64]).toBe(Math.round(Math.sqrt(64 / 255) * 255)); // 128
  });

  it("contrast pivots on mid-grey; −100 is a quarter slope", () => {
    const plan = buildAdjustPlan(adj({ contrast: -100 }));
    for (const ch of [0, 1, 2]) {
      // The table itself (0..1 scale): slope 0.25 about 0.5 → 0.375 / 0.625.
      expect(plan.lut[ch * 256]!).toBeCloseTo(0.375, 6);
      expect(plan.lut[ch * 256 + 255]!).toBeCloseTo(0.625, 6);
    }
    for (const contrast of [-100, -37, 41, 100]) {
      const p = buildAdjustPlan(adj({ contrast }));
      // 0.5 lies halfway between entries 127 and 128; the curve is a line
      // through (0.5, 0.5), so their mean is the pivot whatever the slope.
      expect((p.lut[127]! + p.lut[128]!) / 2, `${contrast}`).toBeCloseTo(0.5, 5);
    }
    expect(buildAdjustPlan(adj({ contrast: 100 })).lut[0]!).toBeCloseTo(-1.5, 6); // slope 4, unclamped
  });

  it("the §9.6 hue matrix rows each sum to 1 at 73° (greys stay grey)", () => {
    const { m, matrixIsIdentity } = buildAdjustPlan(adj({ hue: 73 }));
    expect(matrixIsIdentity).toBe(false);
    for (let r = 0; r < 3; r++) {
      expect(m[r * 3]! + m[r * 3 + 1]! + m[r * 3 + 2]!, `row ${r}`).toBeCloseTo(1, 3);
    }
    // A real rotation, not the identity: pure red goes somewhere else.
    expect(run(adj({ hue: 73 }), 255, 0, 0).slice(0, 3)).not.toEqual([255, 0, 0]);
  });

  it("hue 180 on pure red is a dull teal (the §9.6 matrix is not an HSL rotation)", () => {
    // R' = 0.213 − 0.787 → below 0; G' = B' = 0.213 + 0.213 = 0.426 → 109.
    expect(run(adj({ hue: 180 }), 255, 0, 0).slice(0, 3)).toEqual([0, 109, 109]);
  });

  it("saturation −100 is the §9.6 luminance, taken on the sRGB values", () => {
    const want = Math.round(0.213 * 200 + 0.715 * 40 + 0.072 * 90); // 77.68 → 78
    expect(run(adj({ saturation: -100 }), 200, 40, 90).slice(0, 3)).toEqual([want, want, want]);
  });

  it("clamps ONCE, at the end: an overshoot survives a following contrast cut", () => {
    // Exposure +60 takes c=250 to s ≈ 1.409, past white; contrast −60 (slope
    // 2^−1.2) pulls it back to (1.409 − 0.5)·0.435 + 0.5 = 0.896 → 228.
    // Clamping after the exposure would give (1 − 0.5)·0.435 + 0.5 → 183.
    // (Brightness cannot show this: |s|^γ never leaves [0, 1].)
    const s = enc(lin(250 / 255) * 2 ** 1.2);
    expect(Math.round(((s - 0.5) * 2 ** -1.2 + 0.5) * 255)).toBe(228);
    expect(Math.round(((Math.min(1, s) - 0.5) * 2 ** -1.2 + 0.5) * 255)).toBe(183);
    expect(run(adj({ exposure: 60, contrast: -60 }), 250, 250, 250).slice(0, 3)).toEqual([228, 228, 228]);
  });

  it("shadows / highlights never fold the curve over, even past white", () => {
    // Every extreme pairing, with exposure pushing both ways, must keep each
    // channel's table non-decreasing — before the clamp, where a fold would
    // otherwise be hidden only to reappear under a contrast cut.
    for (const shadows of [-100, 100]) {
      for (const highlights of [-100, 100]) {
        for (const exposure of [-100, 0, 100]) {
          const { lut } = buildAdjustPlan(adj({ shadows, highlights, exposure, warmth: 40 }));
          for (let i = 1; i < 768; i++) {
            if (i % 256 === 0) continue;
            expect(lut[i]!, `${shadows}/${highlights}/${exposure} @${i}`).toBeGreaterThanOrEqual(lut[i - 1]!);
          }
        }
      }
    }
    // ...and they do their job, in the right place: shadows +100 lifts a dark
    // grey more than a light one; highlights −100 pulls a light one more.
    const liftDark = ramp(adj({ shadows: 100 }))[60]! - 60;
    const liftLight = ramp(adj({ shadows: 100 }))[200]! - 200;
    expect(liftDark).toBeGreaterThan(liftLight);
    expect(liftDark).toBeGreaterThan(20);
    const pullLight = 200 - ramp(adj({ highlights: -100 }))[200]!;
    const pullDark = 60 - ramp(adj({ highlights: -100 }))[60]!;
    expect(pullLight).toBeGreaterThan(pullDark);
    expect(pullLight).toBeGreaterThan(20);
  });

  it("lifting shadows and pulling highlights run at the full 0.25 peak shift", () => {
    // The caps apply only on each bump's steep side, so the common directions
    // keep the whole strength: 1.6875·(4/27) = 0.25 at the bump's peak — 85
    // (s = 1/3) lifts to 85 + 63.75 → 149, and 170 (s = 2/3) drops to
    // 106.25 → 106. A cap on both sides would give 123 and 132.
    expect(ramp(adj({ shadows: 100 }))[85]).toBe(149);
    expect(ramp(adj({ highlights: -100 }))[170]).toBe(106);
  });

  it("every slider at both extremes yields finite tables and never touches alpha", () => {
    for (const v of [-100, 100]) {
      const plan = buildAdjustPlan({
        exposure: v, brightness: v, contrast: v, highlights: v, shadows: v,
        saturation: v, hue: v * 1.8, warmth: v, tint: v,
      });
      expect(plan.lut.every(Number.isFinite)).toBe(true);
      expect(plan.m.every(Number.isFinite)).toBe(true);
      const px = new Uint8ClampedArray([0, 128, 255, 7, 255, 0, 64, 200, 13, 250, 90, 0, 1, 2]);
      applyAdjustPlan(px, plan);
      expect([px[3], px[7], px[11]]).toEqual([7, 200, 0]);
      expect([px[12], px[13]]).toEqual([1, 2]); // a trailing partial pixel is left alone
    }
  });

  it("a crafted, unsanitized adjust cannot put NaN in a table", () => {
    const evil = { ...ADJUST_IDENTITY, exposure: Number.NaN, brightness: 1e308, hue: "90" } as unknown as ClipAdjust;
    const plan = buildAdjustPlan(evil);
    expect(plan.lut.every(Number.isFinite)).toBe(true);
    expect(plan.matrixIsIdentity).toBe(true); // "90" is not a number → 0
  });

  // Hand-computed in float64 by a separate script written from the spec, not
  // from plan.ts. Fixture 1, pixel (180, 95, 30):
  //   tone (after step 6)  R 0.977013  G 0.366028  B −0.146165
  //   Saturate(1.57)       R 1.272116  G 0.312868  B −0.491275
  //   Hue(−71°), ×255      R 413.788   G 17.020    B 234.181  → (255, 17, 234)
  // Fixture 2, pixel (140, 110, 90), nothing clipped:
  //   tone                 R 0.589320  G 0.445357  B 0.338928
  //   M, ×255              R 172.860   G 105.056   B 104.174  → (173, 105, 104)
  // No channel sits within 0.15 of a rounding boundary, so the Float32 table
  // cannot flip one. Both fixtures lift shadows and pull highlights, the
  // uncapped directions, at full TONE_BUMP strength (1.6875); with a flat
  // strength of 1 the same inputs give (255, 5, 239) and (173, 100, 99).
  const FIX1 = adj({
    exposure: 17, brightness: -23, contrast: 41, highlights: -8, shadows: 33,
    saturation: 57, hue: -71, warmth: 29, tint: -13,
  });
  const FIX2 = adj({
    exposure: 9, brightness: -13, contrast: 20, highlights: -17, shadows: 29,
    saturation: 23, hue: -31, warmth: 19, tint: -11,
  });

  it("per-axis fixture 1 matches the hand computation, table entries included", () => {
    const plan = buildAdjustPlan(FIX1);
    expect(plan.lut[180]!).toBeCloseTo(0.977013, 5);
    expect(plan.lut[256 + 95]!).toBeCloseTo(0.366028, 5);
    expect(plan.lut[512 + 30]!).toBeCloseTo(-0.146165, 5); // unclamped below 0
    expect(run(FIX1, 180, 95, 30)).toEqual([255, 17, 234, 255]);
  });

  it("per-axis fixture 2 matches the hand computation with no channel clipped", () => {
    const plan = buildAdjustPlan(FIX2);
    expect(plan.lut[140]!).toBeCloseTo(0.589320, 5);
    expect(plan.lut[256 + 110]!).toBeCloseTo(0.445357, 5);
    expect(plan.lut[512 + 90]!).toBeCloseTo(0.338928, 5);
    expect(run(FIX2, 140, 110, 90)).toEqual([173, 105, 104, 255]);
  });

  it("every one of the nine axes takes part in both fixtures", () => {
    // Zeroing any single axis must change the result, so no axis can be
    // silently ignored by the pipeline and still pass the two tests above.
    const cases: [ClipAdjust, [number, number, number]][] = [
      [FIX1, [180, 95, 30]],
      [FIX2, [140, 110, 90]],
    ];
    for (const [fx, [r, g, b]] of cases) {
      const full = run(fx, r, g, b);
      for (const k of KEYS) expect(run({ ...fx, [k]: 0 }, r, g, b), k).not.toEqual(full);
    }
  });
});
