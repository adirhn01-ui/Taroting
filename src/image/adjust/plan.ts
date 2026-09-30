// Photo-layer adjustments: the value rules and the pixel pipeline — a
// per-channel tone LUT plus one 3×3 colour matrix, applied to unpremultiplied
// RGBA with a single clamp at the very end.
//
// Per 8-bit channel value c, in this order:
//   1. L = srgbToLinear(c / 255)
//   2. L *= 2^(exposure/50) · g_ch — exposure is ±2 EV; the white balance is
//      log-symmetric (gR = 2^(KW·w), gB = 2^(−KW·w), gG = 2^(−KT·t)) and then
//      NORMALIZED so 0.2126·gR + 0.7152·gG + 0.0722·gB = 1: warmth and tint
//      tilt the colour without brightening or darkening a grey.
//   3. s = linearToSrgb(L), unclamped (exposure may push it past 1)
//   4. shadows / highlights: two smooth bumps, s·(1−s)² peaking at 1/3 and
//      s²·(1−s) peaking at 2/3, evaluated on s clamped into [0, 1] and scaled
//      by TONE_BUMP·slider, capped at the fold on each bump's steep side
//      (see TONE_BUMP)
//   5. brightness: s = sign(s)·|s|^(2^(−brightness/100)) — a midtone gamma, so
//      black and white stay put; ±100 → gamma 0.5 / 2
//   6. contrast: s = (s − 0.5)·2^(contrast/50) + 0.5 — slope 0.25..4 about
//      mid-grey
//   7. per pixel: M = Hue(θ)·Saturate(1 + saturation/100), the Filter Effects
//      §9.6 (feColorMatrix) coefficients verbatim, θ in degrees
//   8. ONE clamp + round, by the Uint8ClampedArray store itself.
// Steps 1-6 depend only on the channel and its value, so they bake into a
// 3×256 table once per adjustment; a pixel then costs three lookups and, when
// hue or saturation is in play, nine multiply-adds.
//
// Why a single clamp: exposure can take a bright sky past white, and a
// following contrast cut pulls it back into range with its gradation intact.
// Clamping after each step would flatten it to one grey first.

import type { ClipAdjust } from "../../core/types";

type AdjustKey = keyof ClipAdjust;

/** Every field, in the order the inspector lists them, with its legal range.
 *  Hue is in degrees; everything else is a -100..100 slider. */
const RANGES: Readonly<Record<AdjustKey, number>> = {
  exposure: 100,
  brightness: 100,
  contrast: 100,
  highlights: 100,
  shadows: 100,
  saturation: 100,
  hue: 180,
  warmth: 100,
  tint: 100,
};
const KEYS = Object.keys(RANGES) as AdjustKey[];

/** All zeros: the adjustment that changes nothing. Frozen, so no caller can
 *  turn the shared identity into something else. */
export const ADJUST_IDENTITY: Readonly<ClipAdjust> = Object.freeze({
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  saturation: 0,
  hue: 0,
  warmth: 0,
  tint: 0,
});

/** True when `a` changes nothing: absent, or every field exactly 0. Meant for
 *  values that went through `sanitizeAdjust` (which never returns an identity
 *  object — it returns undefined), so a stored all-zero object also counts. */
export function isIdentityAdjust(a: ClipAdjust | undefined): boolean {
  if (a === undefined) return true;
  for (const k of KEYS) if (a[k] !== 0) return false;
  return true;
}

/** An untrusted `Clip.adjust` (a `.trt` is plain JSON, and the Rust side keeps
 *  this field opaque) as a clean ClipAdjust, or undefined for identity.
 *
 *  Total, never throws. Non-object → undefined. Each field: a finite number,
 *  rounded to an integer and clamped to its range (hue ±180, the rest ±100);
 *  anything else — a string, NaN, a missing key — counts as 0. Always a FRESH
 *  object with exactly the nine keys, so an unknown extra key never survives
 *  into a save. -0 is normalised to 0. */
export function sanitizeAdjust(raw: unknown): ClipAdjust | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out = { ...ADJUST_IDENTITY };
  let identity = true;
  for (const k of KEYS) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const r = RANGES[k];
    const n = Math.min(Math.max(Math.round(v), -r), r) || 0;
    out[k] = n;
    if (n !== 0) identity = false;
  }
  return identity ? undefined : out;
}

export interface AdjustPlan {
  /** 3×256 per-channel tone curve, UNCLAMPED floats in 0..1 scale (exposure,
   *  WB, sRGB re-encode, highlights/shadows, brightness, contrast) */
  lut: Float32Array;
  /** 3×3 row-major Hue(θ)·Saturate(s), Filter Effects §9.6 coefficients verbatim */
  m: Float32Array;
  matrixIsIdentity: boolean;
}

/** White-balance calibration: log2 gain per unit of warmth (red up, blue
 *  down) and of tint (green down = magenta). Tuned by eye against the owner's
 *  photos (TESTING.md Pass I); changing them is a constants-only edit plus the
 *  per-axis fixture in plan.test.ts. */
const KW = 0.35;
const KT = 0.25;

/** Strength of the shadows / highlights bumps at ±100: 0.25·27/4, a 0.25
 *  peak shift (about 64 levels). The bumps are s·(1−s)² and s²·(1−s); the
 *  curve s + k·bump stays monotone only while its slope 1 + k·bump′ ≥ 0, and
 *  the bumps' slopes run over [−1/3, 1] and [−1, 1/3]. So each is free up to
 *  3 on one side and folds past 1 on the other: at the full 1.6875, shadows
 *  −100 pushed everything under ~23 % grey below black, and highlights +100
 *  lifted near-white ABOVE white — and a following contrast cut then drew a
 *  darker input brighter than a lighter one. Hence the one-sided caps below:
 *  full strength where the bump cannot fold (lifting shadows, pulling
 *  highlights — the common directions), 1 where its far-end slope is −1. */
const TONE_BUMP = 1.6875;

/** IEC 61966-2-1 transfer functions. `linearToSrgb` extends the power segment
 *  past 1 on purpose: exposure may overshoot, and the one clamp is at the end. */
function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(l: number): number {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
}

/** The pixel program for one adjustment. Pure; built once per adjustment
 *  change (768 table entries), never per pixel. The value is re-sanitized, so
 *  a hand-edited or not-yet-validated `adjust` can never put NaN in a table. */
export function buildAdjustPlan(raw: ClipAdjust): AdjustPlan {
  const a = sanitizeAdjust(raw) ?? ADJUST_IDENTITY;

  // Step 2's gains, normalized so a neutral grey keeps its luminance.
  const w = a.warmth / 100;
  const t = a.tint / 100;
  const gR = 2 ** (KW * w);
  const gG = 2 ** (-KT * t);
  const gB = 2 ** (-KW * w);
  const norm = 0.2126 * gR + 0.7152 * gG + 0.0722 * gB;
  const ev = 2 ** (a.exposure / 50);
  const gains = [(ev * gR) / norm, (ev * gG) / norm, (ev * gB) / norm];

  const sh = Math.max((TONE_BUMP * a.shadows) / 100, -1);
  const hl = Math.min((TONE_BUMP * a.highlights) / 100, 1);
  const gamma = 2 ** (-a.brightness / 100);
  const slope = 2 ** (a.contrast / 50);

  const lut = new Float32Array(768);
  for (let ch = 0; ch < 3; ch++) {
    const g = gains[ch]!;
    for (let c = 0; c < 256; c++) {
      let s = linearToSrgb(srgbToLinear(c / 255) * g);
      // Outside [0, 1] both bumps are 0 (they vanish at the ends), so an
      // overshoot passes through untouched instead of being bent by a cubic
      // that grows without bound out there.
      const u = s < 0 ? 0 : s > 1 ? 1 : s;
      const v = 1 - u;
      s += sh * u * v * v + hl * u * u * v;
      s = Math.sign(s) * Math.abs(s) ** gamma;
      s = (s - 0.5) * slope + 0.5;
      lut[ch * 256 + c] = s;
    }
  }

  const m = new Float32Array(9);
  const matrixIsIdentity = a.hue === 0 && a.saturation === 0;
  if (matrixIsIdentity) {
    // Written, not computed: 0.213 + 0.787 is not exactly 1 in floating point.
    m[0] = 1;
    m[4] = 1;
    m[8] = 1;
  } else {
    // Saturate(s) and Hue(θ), Filter Effects 1 §9.6 — coefficients verbatim.
    const s = 1 + a.saturation / 100;
    const S = [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ];
    const th = (a.hue * Math.PI) / 180;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const H = [
      0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
    ];
    // M = H·S: saturate first, then turn the hue.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        m[r * 3 + c] = H[r * 3]! * S[c]! + H[r * 3 + 1]! * S[3 + c]! + H[r * 3 + 2]! * S[6 + c]!;
      }
    }
  }
  return { lut, m, matrixIsIdentity };
}

/** In place on unpremultiplied RGBA (getImageData order). Alpha untouched. One
 *  clamp+round at the end (Uint8ClampedArray write).
 *
 *  Hot path (a working-size photo is millions of pixels per slider frame):
 *  the table and the nine coefficients live in locals, the 255 scale is folded
 *  into the coefficients, and the loop allocates nothing. A trailing partial
 *  pixel (length not a multiple of 4) is left alone. */
export function applyAdjustPlan(px: Uint8ClampedArray, plan: AdjustPlan): void {
  const lut = plan.lut;
  const n = px.length - (px.length % 4);
  if (plan.matrixIsIdentity) {
    for (let i = 0; i < n; i += 4) {
      px[i] = lut[px[i]!]! * 255;
      px[i + 1] = lut[256 + px[i + 1]!]! * 255;
      px[i + 2] = lut[512 + px[i + 2]!]! * 255;
    }
    return;
  }
  const m = plan.m;
  const m0 = m[0]! * 255;
  const m1 = m[1]! * 255;
  const m2 = m[2]! * 255;
  const m3 = m[3]! * 255;
  const m4 = m[4]! * 255;
  const m5 = m[5]! * 255;
  const m6 = m[6]! * 255;
  const m7 = m[7]! * 255;
  const m8 = m[8]! * 255;
  for (let i = 0; i < n; i += 4) {
    const r = lut[px[i]!]!;
    const g = lut[256 + px[i + 1]!]!;
    const b = lut[512 + px[i + 2]!]!;
    px[i] = m0 * r + m1 * g + m2 * b;
    px[i + 1] = m3 * r + m4 * g + m5 * b;
    px[i + 2] = m6 * r + m7 * g + m8 * b;
  }
}
