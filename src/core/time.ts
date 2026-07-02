// Rational-fps time math and the timeline ↔ clip ↔ source mapping.
// Pure functions; everything (playback, stepping, export) depends on these.

import type { Clip, Rational, Timeline, Track } from "./types";

export const rat = (num: number, den = 1): Rational => ({ num, den });

export const fpsValue = (r: Rational): number => r.num / r.den;

/** Frame index containing time t (guarded against float error at boundaries). */
export function frameOf(t: number, fps: Rational): number {
  return Math.floor((t * fps.num) / fps.den + 1e-9);
}

/** Center time of frame n — a seek target immune to rounding either way. */
export function frameCenter(n: number, fps: Rational): number {
  return ((n + 0.5) * fps.den) / fps.num;
}

/** Start time of frame n. */
export function frameStart(n: number, fps: Rational): number {
  return (n * fps.den) / fps.num;
}

/** Snap a time to the start of its frame. */
export function snapToFrame(t: number, fps: Rational): number {
  return frameStart(frameOf(t, fps), fps);
}

/** Duration the clip occupies on the timeline (speed-adjusted). */
export function clipDuration(clip: Clip): number {
  return (clip.srcOut - clip.srcIn) / clip.speed;
}

/** Exclusive end time of the clip on the timeline. */
export function clipEnd(clip: Clip): number {
  return clip.timelineStart + clipDuration(clip);
}

/** Map a clip-local time (0..clipDuration) to a time in the source file. */
export function sourceTime(clip: Clip, clipLocal: number): number {
  return clip.srcIn + clipLocal * clip.speed;
}

/** Map a source-file time to a timeline time (inverse of sourceTime). */
export function timelineTime(clip: Clip, srcT: number): number {
  return clip.timelineStart + (srcT - clip.srcIn) / clip.speed;
}

export type Located =
  | { kind: "clip"; clip: Clip; index: number; clipLocal: number }
  | { kind: "gap"; nextIndex: number; nextClipStart: number }
  | { kind: "after" };

/** Locate what's under time t on a track (clips sorted, non-overlapping). */
export function locate(track: Track, t: number): Located {
  const clips = track.clips;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid]!;
    if (t < c.timelineStart) {
      hi = mid - 1;
    } else if (t >= clipEnd(c)) {
      lo = mid + 1;
    } else {
      return { kind: "clip", clip: c, index: mid, clipLocal: t - c.timelineStart };
    }
  }
  if (lo < clips.length) {
    return { kind: "gap", nextIndex: lo, nextClipStart: clips[lo]!.timelineStart };
  }
  return { kind: "after" };
}

/** Total timeline duration = latest clip end across all tracks. */
export function timelineDuration(timeline: Timeline): number {
  let end = 0;
  for (const track of timeline.tracks) {
    const last = track.clips[track.clips.length - 1];
    if (last) end = Math.max(end, clipEnd(last));
  }
  return end;
}
