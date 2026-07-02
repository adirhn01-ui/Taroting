// Pure keyframe interpolation. No side effects, no allocation on the hot path
// (KfCursor). All times are SOURCE seconds — the same domain as Keyframe.t.

import type { Keyframe } from "./types";

/** Half a source frame at 60fps — the tolerance for "same keyframe". */
export const EPS_KF = 1 / 120;

/** Index of the last keyframe whose t is <= s, via binary search.
 *  Returns -1 if s is before the first keyframe. Assumes kfs is non-empty and
 *  sorted strictly ascending. */
function floorIndex(kfs: Keyframe[], s: number): number {
  let lo = 0;
  let hi = kfs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid]!.t <= s) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Linear interpolation between two keyframes at source time s. */
function lerpSeg(a: Keyframe, b: Keyframe, s: number): number {
  const span = b.t - a.t;
  if (span <= 0) return a.v; // coincident guard (shouldn't happen: strictly ascending)
  const f = (s - a.t) / span;
  return a.v + (b.v - a.v) * f;
}

/** Evaluate a keyframe track at source time s. Clamps to the first/last value
 *  outside the range; linear between. Throws on an empty array (caller bug). */
export function evalKfs(kfs: Keyframe[], s: number): number {
  const n = kfs.length;
  if (n === 0) throw new Error("evalKfs: empty keyframe array");
  const first = kfs[0]!;
  if (s <= first.t) return first.v;
  const last = kfs[n - 1]!;
  if (s >= last.t) return last.v;
  const i = floorIndex(kfs, s); // in (0 .. n-2] because of the guards above
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  return lerpSeg(a, b, s);
}

/** Stateful evaluator that caches the last segment for monotone playback:
 *  O(1) amortized when s advances within/adjacent to the cached segment,
 *  falling back to binary search on random access or when the kfs identity
 *  changes. One cursor per animated prop per layer. */
export class KfCursor {
  private ref: Keyframe[] | null = null;
  private i = -1; // cached floor index

  eval(kfs: Keyframe[], s: number): number {
    const n = kfs.length;
    if (n === 0) throw new Error("KfCursor.eval: empty keyframe array");
    if (kfs !== this.ref) {
      this.ref = kfs;
      this.i = floorIndex(kfs, s);
    } else {
      // advance/retreat the cached index by walking neighbouring segments
      let i = this.i;
      if (i < 0 && s >= kfs[0]!.t) i = 0;
      while (i >= 0 && i + 1 < n && s >= kfs[i + 1]!.t) i++;
      while (i >= 0 && s < kfs[i]!.t) i--;
      // large jump: the linear walk above still lands correctly, but guard the
      // pathological random-access case with a binary search when far off.
      if (i >= 0 && i + 1 < n && s >= kfs[i + 1]!.t) i = floorIndex(kfs, s);
      this.i = i;
    }
    const i = this.i;
    if (i < 0) return kfs[0]!.v; // before first
    if (i >= n - 1) return kfs[n - 1]!.v; // at/after last
    return lerpSeg(kfs[i]!, kfs[i + 1]!, s);
  }
}

/** Return a NEW sorted array with a keyframe upserted at source time t:
 *  replaces any keyframe within eps of t, otherwise inserts in order. */
export function upsertKf(
  kfs: Keyframe[] | undefined,
  t: number,
  v: number,
  eps: number,
): Keyframe[] {
  const out: Keyframe[] = kfs ? [...kfs] : [];
  const kf: Keyframe = { t, v };
  // replace within eps
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i]!.t - t) <= eps) {
      out[i] = kf;
      return out;
    }
  }
  // insert keeping ascending order
  let idx = out.length;
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.t > t) {
      idx = i;
      break;
    }
  }
  out.splice(idx, 0, kf);
  return out;
}

/** Return a NEW array with the keyframe within eps of t removed (if any). */
export function removeKfNear(kfs: Keyframe[], t: number, eps: number): Keyframe[] {
  return kfs.filter((k) => Math.abs(k.t - t) > eps);
}

/** The keyframe within eps of t, or null. */
export function kfNear(
  kfs: Keyframe[] | undefined,
  t: number,
  eps: number,
): Keyframe | null {
  if (!kfs) return null;
  let best: Keyframe | null = null;
  let bestD = eps;
  for (const k of kfs) {
    const d = Math.abs(k.t - t);
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Timeline-LOCAL breakpoints for export. Maps source-domain keyframes to a
 *  clip's timeline-local time (tl in [0, dur]) given its trim and speed:
 *
 *    tl = (t - srcIn) / speed,   dur = (srcOut - srcIn) / speed
 *
 *  Always emits synthetic endpoints at tl=0 (value = evalKfs at srcIn) and
 *  tl=dur (value = evalKfs at srcOut) so the exported expression is well
 *  defined across the whole clip. Interior keyframes strictly inside
 *  (srcIn, srcOut) are included at their mapped tl; any interior point within
 *  1e-9 of an endpoint is dropped (the endpoints already cover it).
 *  Out-of-range "ghost" keyframes act purely as interpolation anchors via
 *  evalKfs and never appear as their own breakpoints. */
export function clampedBreakpoints(
  kfs: Keyframe[],
  srcIn: number,
  srcOut: number,
  speed: number,
): { tl: number; v: number }[] {
  const dur = (srcOut - srcIn) / speed;
  const out: { tl: number; v: number }[] = [
    { tl: 0, v: evalKfs(kfs, srcIn) },
  ];
  for (const k of kfs) {
    if (k.t <= srcIn || k.t >= srcOut) continue; // ghosts / on-endpoint
    const tl = (k.t - srcIn) / speed;
    if (tl <= 1e-9 || tl >= dur - 1e-9) continue; // within an endpoint
    out.push({ tl, v: k.v });
  }
  out.push({ tl: dur, v: evalKfs(kfs, srcOut) });
  return out;
}
