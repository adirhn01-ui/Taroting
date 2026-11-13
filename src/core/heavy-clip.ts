// Which clips are HEAVY to seek in: one rule for the viewer's seek pacer and
// its scrub copy, so the two can never disagree about a file. Pure: only the
// keyframe index's shape.
//
// MEASURED (WebView2, 2026-10-07, a 69 Mbps screen recording, one keyframe
// every 4.17 s, B-frames): the player decodes every seek from the keyframe
// before its target, so an exact seek late in a GOP took 593-1364 ms and a
// seek that lands ON a keyframe 3-48 ms.
//
// The two thresholds are tuned by the OWNER'S HANDS-ON FEEL on real clips, not
// by synthetic probes: change them only on what the owner says.

import type { KeyframeIndex } from "./ipc";

/** A file whose median keyframe gap is shorter than this is light (s). */
export const HEAVY_GAP_S = 2.0;
/** A file whose overall bit rate (bytes * 8 / duration) is below this is
 *  light, whatever its gap (bits per second): a low-rate long-GOP file
 *  decodes a GOP fast enough to seek exactly. */
export const HEAVY_BITS_PER_S = 20_000_000;

/** The median gap between consecutive keyframes; null with fewer than two. */
export function medianGap(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/** The median keyframe gap when `index` makes the file HEAVY, else null:
 *  read, not every frame a keyframe, a gap of at least HEAVY_GAP_S AND a bit
 *  rate of at least HEAVY_BITS_PER_S. `force` (DEV seam only) skips the two
 *  thresholds, not the index's own sanity. */
export function heavyGap(index: KeyframeIndex | null, force = false): number | null {
  if (index === null || index.allSync) return null;
  const gap = medianGap(index.times);
  if (gap === null || !(gap > 0)) return null;
  if (force) return gap;
  if (gap < HEAVY_GAP_S) return null;
  if (!Number.isFinite(index.duration) || index.duration <= 0) return null;
  return (index.bytes * 8) / index.duration >= HEAVY_BITS_PER_S ? gap : null;
}
