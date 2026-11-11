// Paces the viewer's seeks while the user drags the seek bar of a HEAVY clip.
//
// MEASURED (WebView2, 2026-10-07, a 69 Mbps OBS clip, one keyframe every
// 4.17 s, B-frames): Chromium decodes every seek from the keyframe before its
// target, so an exact seek late in a GOP took 593-1364 ms, and a seek that
// lands ON a keyframe 3-48 ms. A big jump across such a file waited a second
// or more for every picture ("you have to go slowly with your cursor").
//
// So, on a heavy file only (classified from the file's keyframe index, below):
//  - a FAST drag seeks to the keyframe NEAREST the cursor — a picture of
//    about where the user is, at once. One keyframe seek in flight at a time;
//    the newest target waits, a stale waiting one is dropped.
//  - a SLOW drag, or a pointer resting REST_MS, seeks exactly, as a light file
//    does; a keyframe target never waits behind such a seek (assigning
//    currentTime supersedes the one in flight in Chromium).
//  - the release seeks exactly to where the pointer let go, once.
//  - once the cursor's exact frame has landed and the pointer has not moved
//    since, the drag lets go of the position: held still, it is a light
//    file's (the knob follows playback, the release asks nothing) until the
//    next move.
//  - a drag is not fast until its speed spans MIN_SPEED_SPAN_MS: a wobble
//    right after the press seeks exactly.
// The knob and the clock never show a keyframe's time: the viewer keeps the
// cursor's position (`asked`) and only asks holding() whether it may let go.
//
// Light files never reach this: the viewer seeks on every move as before (the
// owner called that feel perfect). Idle cost: nothing — no listener of its
// own (the viewer forwards `seeked`), and the one rest timer runs only while a
// heavy drag is held. Lives wholly under src/viewer/: nothing in src/editor/
// may import it (the editor's scrubbing is the owner's reference, untouched).

import type { KeyframeIndex } from "../core/ipc";

// The four thresholds below are tuned by the OWNER'S HANDS-ON FEEL on real
// clips, not by synthetic probes: change them only on what the owner says.

/** A file whose median keyframe gap is shorter than this is light (s). */
export const HEAVY_GAP_S = 2.0;
/** A file whose overall bit rate (bytes * 8 / duration) is below this is
 *  light, whatever its gap (bits per second): a low-rate long-GOP file
 *  decodes a GOP fast enough to seek exactly. */
export const HEAVY_BITS_PER_S = 20_000_000;
/** A drag at or above this many median keyframe gaps of video per second of
 *  wall time is FAST and lands on keyframes; slower is exact. */
export const FAST_GOPS_PER_S = 1.0;
/** A held pointer still for this long gets its exact frame (ms). */
export const REST_MS = 150;

/** The pointer's speed is measured over about this much wall time (ms). */
export const SPEED_WINDOW_MS = 100;
/** A drag is not FAST until its speed samples span at least this much wall
 *  time (ms): one event interval right after the press (~8 ms) turns a 1 px
 *  wobble into a "fast" drag and flashes a keyframe up to a GOP away. Until
 *  then every move is SLOW (exact). */
export const MIN_SPEED_SPAN_MS = 30;

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

/** The keyframe in ascending `times` nearest `t` (the earlier on a tie). */
export function nearestKeyframe(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  // times[lo] is the first at or after t (or the last); its predecessor may be nearer.
  if (lo > 0 && t - times[lo - 1]! <= times[lo]! - t) return times[lo - 1]!;
  return times[lo]!;
}

export interface PacerTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
  now(): number;
}

// Looked up at call time, so a test's fake timers reach them.
const browserTimers: PacerTimers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  now: () => performance.now(),
};

export interface SeekPacerOptions {
  /** An exact seek to within this of the element's position is not made
   *  (seconds): the light path's own margin, so the two seek alike. */
  tolerance: number;
  timers?: PacerTimers;
  /** Every seek the pacer assigns (DEV: the E2E reads them). */
  onIssue?: (t: number, keyframe: boolean) => void;
}

type Flight = "none" | "key" | "exact";

export class SeekPacer {
  private readonly timers: PacerTimers;
  private readonly tolerance: number;
  private readonly onIssue: ((t: number, keyframe: boolean) => void) | undefined;
  /** This source's keyframes and median gap while it is heavy; null: light. */
  private times: readonly number[] | null = null;
  private gap = 0;
  /** A heavy drag is held. */
  private dragging = false;
  /** Where the pointer is (seconds). */
  private cursor = 0;
  /** Recent pointer positions, oldest first, for the speed. */
  private samples: { t: number; at: number }[] = [];
  /** What the pacer last assigned and has not seen land. */
  private flight: Flight = "none";
  /** The keyframe in flight, as sent (the element may read it back rounded). */
  private flightKey = Number.NaN;
  /** The exact time in flight, as sent (always the cursor when sent). */
  private flightExact = Number.NaN;
  /** The keyframe a landed keyframe seek put on screen; NaN when the picture
   *  is (or is about to be) an exact frame. */
  private shownKey = Number.NaN;
  /** ONE keyframe waiting for the keyframe seek in flight (latest wins). */
  private want: number | null = null;
  private restTimer: number | undefined;
  /** The rest timer's callback: one for the pacer's life, not one per move. */
  private readonly rested = (): void => {
    this.restTimer = undefined;
    if (this.dragging) this.exact(this.cursor);
  };

  constructor(
    private readonly el: HTMLVideoElement,
    opts: SeekPacerOptions,
  ) {
    this.timers = opts.timers ?? browserTimers;
    this.tolerance = opts.tolerance;
    this.onIssue = opts.onIssue;
  }

  /** The current source's keyframe index (null: unknown, so light). `force`:
   *  the DEV seam, heavy whatever the thresholds say. */
  setIndex(index: KeyframeIndex | null, force = false): void {
    const gap = heavyGap(index, force);
    this.times = gap === null || index === null ? null : index.times;
    this.gap = gap ?? 0;
  }

  /** The current source drags on keyframes when fast. */
  heavy(): boolean {
    return this.times !== null;
  }

  /** A heavy drag is held: the viewer's `asked` (the cursor) owns the
   *  position, and a seek landing must not hand it to the element. False
   *  again once the cursor's own exact frame has landed and the pointer has
   *  not moved since: a pointer held still is then a light file's (the knob
   *  follows playback, the release asks nothing) until it moves again. */
  holding(): boolean {
    return this.dragging;
  }

  /** A press on the bar: the viewer already asked `t` exactly. Remembered on
   *  any file, so a drag whose index answers after its press still measures
   *  its first move's speed from the press. Not yet a drag: a press held
   *  still, or a click, stays exactly the light path's (the knob follows
   *  playback once its seek lands, and the release asks nothing more). */
  begin(t: number): void {
    this.dragging = false;
    this.cursor = t;
    this.samples = [{ t, at: this.timers.now() }];
    // The press's own seek (the viewer's) supersedes whatever was in flight.
    this.flight = "none";
    this.shownKey = Number.NaN;
    this.want = null;
  }

  /** The held pointer moved to `t` (seconds). */
  move(t: number): void {
    const times = this.times;
    if (times === null) return;
    const now = this.timers.now();
    // Heavy learned mid-drag: the press (begin) is the history.
    this.dragging = true;
    this.cursor = t;
    const s = this.samples;
    s.push({ t, at: now });
    while (s.length > 2 && s[0]!.at < now - SPEED_WINDOW_MS) s.shift();
    this.armRest();
    if (this.speed() >= FAST_GOPS_PER_S * this.gap) this.key(nearestKeyframe(times, t));
    else this.exact(t);
  }

  /** The pointer let go: exactly one exact seek to where it was (none when
   *  the element is already within the tolerance of it, and none once the
   *  cursor's exact frame has landed with the pointer still since — the
   *  picture may have played on from there, as on a light file). */
  release(): void {
    const held = this.dragging;
    this.dragging = false;
    this.samples = [];
    this.timers.clearTimeout(this.restTimer);
    this.restTimer = undefined;
    // exact() drops a waiting keyframe; without a drag none can wait (seeked()
    // sends one only while dragging).
    if (held) this.exact(this.cursor);
  }

  /** The viewer's `seeked`: what was in flight has landed, unless a newer
   *  seek is still decoding. A keyframe waiting goes out now. */
  seeked(): void {
    if (this.el.seeking || this.flight === "none") return;
    // Only the pacer's own keyframe counts as shown: a seek it did not issue
    // (a key, a press) may have superseded it and landed elsewhere.
    const onKey = this.flight === "key" && Math.abs(this.el.currentTime - this.flightKey) <= this.tolerance;
    this.shownKey = onKey ? this.flightKey : Number.NaN;
    // The cursor's exact frame is on screen and the pointer has not moved
    // since: held still, it lets go of the position (holding() false).
    if (this.flight === "exact" && Math.abs(this.cursor - this.flightExact) <= this.tolerance) this.dragging = false;
    this.flight = "none";
    const w = this.want;
    this.want = null;
    if (w !== null && this.dragging) this.key(w);
  }

  /** The element gets a new source: everything known is about the old one. */
  reset(): void {
    this.times = null;
    this.gap = 0;
    this.dragging = false;
    this.samples = [];
    this.flight = "none";
    this.flightKey = Number.NaN;
    this.shownKey = Number.NaN;
    this.want = null;
    this.timers.clearTimeout(this.restTimer);
    this.restTimer = undefined;
  }

  /** Seconds of video per second of wall time over the recent samples. */
  private speed(): number {
    const s = this.samples;
    if (s.length < 2) return 0;
    const a = s[0]!;
    const b = s[s.length - 1]!;
    const dist = Math.abs(b.t - a.t);
    const dt = b.at - a.at;
    // Too short a span to tell a drag from a wobble: slow, so exact.
    if (dt < MIN_SPEED_SPAN_MS) return 0;
    return (dist * 1000) / dt;
  }

  private armRest(): void {
    this.timers.clearTimeout(this.restTimer);
    this.restTimer = this.timers.setTimeout(this.rested, REST_MS);
  }

  private key(k: number): void {
    // Already on its way, or already on screen: nothing new to show.
    if (this.flight === "key" && k === this.flightKey) {
      this.want = null;
      return;
    }
    if (this.flight === "none" && k === this.shownKey) {
      this.want = null;
      return;
    }
    // At most one keyframe seek in flight. Never behind an exact one: the
    // assignment supersedes it.
    if (this.flight === "key") {
      this.want = k;
      return;
    }
    this.want = null;
    this.flight = "key";
    this.flightKey = k;
    this.el.currentTime = k;
    this.onIssue?.(k, true);
  }

  private exact(t: number): void {
    this.want = null;
    // The light path's rule: a position already there is not asked again.
    if (Math.abs(this.el.currentTime - t) <= this.tolerance) return;
    this.flight = "exact";
    this.flightExact = t;
    this.shownKey = Number.NaN;
    this.el.currentTime = t;
    this.onIssue?.(t, false);
  }
}
