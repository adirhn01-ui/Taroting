// Photo-layer adjustments: the value rules (written here) and the pixel
// pipeline (a per-channel tone LUT plus one 3×3 colour matrix, applied to
// unpremultiplied RGBA with a single clamp at the end).
//
// `buildAdjustPlan` / `applyAdjustPlan` are not implemented yet: their
// declarations are the contract the renderer compiles against.

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

export function buildAdjustPlan(a: ClipAdjust): AdjustPlan;
export function buildAdjustPlan(): never {
  throw new Error("not implemented");
}

/** In place on unpremultiplied RGBA (getImageData order). Alpha untouched. One
 *  clamp+round at the end (Uint8ClampedArray write). */
export function applyAdjustPlan(px: Uint8ClampedArray, plan: AdjustPlan): void;
export function applyAdjustPlan(): never {
  throw new Error("not implemented");
}
