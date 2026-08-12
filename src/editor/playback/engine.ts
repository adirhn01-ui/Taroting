// Playback engine: the master clock. While a ready video clip is under the
// playhead on some layer, the topmost such element IS the clock (mapped to
// timeline time); across gaps and stills a wall-clock advances at the preview
// speed. The scheduler composites the whole video-track stack; the engine only
// tracks the nearest segment boundary across all layers.

import { frameCenter, frameOf, timelineDuration } from "../../core/time";
import type { ProjectFile, Rational } from "../../core/types";
import { Scheduler } from "./scheduler";

const BOUNDARY_EPS = 1 / 240;

/**
 * How far the master video may sit from the engine's own extrapolated clock and
 * still count as "nothing has happened here except time passing" — the test
 * `catchUpTime` uses to tell a stale refresh from a real edit.
 *
 * The floor: the divergence a healthy refresh has to absorb is exactly the age
 * of the last rAF tick, ~17 ms at 60 Hz and a multiple of that through a hitch,
 * plus whatever jitter the element's clock carries. The ceiling: anything the
 * bound absorbs is a mapping change that moves the PLAYHEAD by that much
 * instead of re-seeking the element, and 50 ms is well under what a user could
 * spot in a preview while still covering three dropped frames.
 */
const REFRESH_SLEW_SEC = 0.05;

export type TickListener = (time: number, playing: boolean) => void;

/**
 * Should `refresh()` adopt the master video's position as the playhead instead
 * of re-activating at the last tick's (stale) time? Returns the time to adopt,
 * or null to keep the current one. Pure, so the whole decision is testable.
 *
 * WHY THIS EXISTS. `refresh()` re-runs `scheduler.activate(t, playing)`, and
 * activate's master branch re-seeks the element whenever `|el.currentTime -
 * srcT| > 0.01`. During playback `t` is a snapshot from the last rAF tick, so
 * a refresh landing 12 ms later is ALREADY over that bar: it backward-seeks the
 * very element that is acting as the master clock — a dropped frame plus an
 * audio glitch. That is not a rare event either. editor.ts subscribes refresh()
 * to `media.status` (a running proxy/remux job republishes that object ~10x/s,
 * so 3-4 seeks a second while media prepares) and to the stage's
 * ResizeObserver (every frame of a window drag). Neither has anything to say
 * about where the playhead is.
 *
 * The guards are what keep a LEGITIMATE re-seek working, and each rules out one
 * way the element's position can differ from the clock for a reason other than
 * elapsed time:
 *
 *  - `masterTime === null`: no master video, so activate() seeks nothing that
 *    a stale `t` could hurt (stills and gaps do not seek).
 *  - `<= lastTick`: never rewind the playhead. In steady state the element only
 *    moves forward from the value the last tick already read off it.
 *  - past the boundary: crossing a cut is the ticker's job (advanceBoundary +
 *    the A/B slot swap). Adopting a time past the segment end would make
 *    activate() load the NEXT clip's URL over the still-showing slot and throw
 *    away the preloaded buffer.
 *  - beyond REFRESH_SLEW_SEC of the extrapolated clock: the clip↔source mapping
 *    changed under the playhead (a clip moved, trimmed or re-sped — which is
 *    exactly what refresh() is FOR), or the element stalled. Keep the old `t`
 *    and let activate() hard-seek the element back onto it, precisely as before
 *    this guard existed.
 */
export function catchUpTime(
  masterTime: number | null,
  lastTick: number,
  extrapolated: number,
  boundary: number,
): number | null {
  if (masterTime === null) return null;
  if (masterTime <= lastTick) return null;
  if (masterTime >= boundary - BOUNDARY_EPS) return null;
  if (Math.abs(masterTime - extrapolated) > REFRESH_SLEW_SEC) return null;
  return masterTime;
}

export class PlaybackEngine {
  loop = false;
  private t = 0;
  private playing_ = false;
  private previewSpeed_ = 1;
  private boundary = Infinity;
  private raf = 0;
  private anchorWall = 0;
  private anchorT = 0;
  private listeners = new Set<TickListener>();
  // frame-step chaining: the last COMMANDED frame, so rapid stepping (with no
  // waits for the video element to settle) lands exactly. Reset whenever the
  // playhead moves for any non-step reason.
  private steppedFrame: number | null = null;

  constructor(
    private getProject: () => ProjectFile,
    private scheduler: Scheduler,
  ) {}

  /* ---------------- public state ---------------- */

  get time(): number {
    return this.t;
  }
  get playing(): boolean {
    return this.playing_;
  }
  get previewSpeed(): number {
    return this.previewSpeed_;
  }

  fps(): Rational {
    return this.getProject().timeline.fps;
  }
  duration(): number {
    return timelineDuration(this.getProject().timeline);
  }

  onTick(fn: TickListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.t, this.playing_);
  }

  /* ---------------- transport ---------------- */

  /** Internal seek that does NOT clear the step chain (used by stepFrames). */
  private seekInternal(time: number, fromStep: boolean): void {
    if (!fromStep) this.steppedFrame = null;
    const dur = this.duration();
    this.t = Math.min(Math.max(0, time), dur);
    this.anchor(this.t);
    this.boundary = this.scheduler.activate(this.t, this.playing_).boundary;
    this.scheduler.animate(this.t);
    this.emit();
  }

  seek(time: number): void {
    this.seekInternal(time, false);
  }

  play(): void {
    if (this.playing_) return;
    const dur = this.duration();
    if (dur <= 0) return;
    this.steppedFrame = null;
    if (this.t >= dur - BOUNDARY_EPS) this.t = 0;
    this.playing_ = true;
    this.anchor(this.t);
    this.boundary = this.scheduler.activate(this.t, true).boundary;
    this.scheduler.animate(this.t);
    this.startTicker();
    this.emit();
  }

  pause(): void {
    if (!this.playing_) return;
    this.playing_ = false;
    // pause is synchronous and always wins: stop the ticker + every element
    // immediately, then re-activate paused so the exact current frame shows.
    cancelAnimationFrame(this.raf);
    this.scheduler.pauseAll();
    this.boundary = this.scheduler.activate(this.t, false).boundary;
    this.scheduler.animate(this.t);
    this.emit();
  }

  toggle(): void {
    if (this.playing_) this.pause();
    else this.play();
  }

  stop(): void {
    this.playing_ = false;
    cancelAnimationFrame(this.raf);
    this.scheduler.pauseAll();
    this.seek(0);
  }

  stepFrames(n: number): void {
    if (this.playing_) this.pause();
    const fps = this.fps();
    const base = this.steppedFrame ?? frameOf(this.t, fps);
    const target = base + n;
    this.steppedFrame = target;
    this.seekInternal(frameCenter(target, fps), true);
  }

  jumpSeconds(s: number): void {
    this.seek(this.t + s);
  }

  setPreviewSpeed(speed: number): void {
    this.previewSpeed_ = speed;
    this.scheduler.previewSpeed = speed;
    // re-anchor so the virtual clock doesn't jump
    this.anchor(this.t);
    if (this.playing_) this.boundary = this.scheduler.activate(this.t, true).boundary;
  }

  /** Re-resolve after project edits (clips moved/trimmed under the playhead). */
  refresh(): void {
    this.steppedFrame = null;
    // Catch the playhead up to the running transport FIRST, so the activate()
    // below computes a source time the master element already has and nothing
    // seeks. Paused, `t` is exactly where the user put it and must not move.
    // See catchUpTime for why each guard is there.
    if (this.playing_) {
      const adopt = catchUpTime(
        this.scheduler.masterClockTime(),
        this.t,
        this.virtualNow(),
        this.boundary,
      );
      if (adopt !== null) {
        this.t = adopt;
        // re-anchor exactly as the ticker does on a master-clock reading, so
        // the virtual clock stays a seamless continuation at the next handoff
        this.anchor(adopt);
      }
    }
    this.boundary = this.scheduler.activate(this.t, this.playing_).boundary;
    this.scheduler.animate(this.t);
    this.emit();
  }

  /* ---------------- clock ---------------- */

  private anchor(t: number): void {
    this.anchorWall = performance.now();
    this.anchorT = t;
  }

  private virtualNow(): number {
    return this.anchorT + ((performance.now() - this.anchorWall) / 1000) * this.previewSpeed_;
  }

  private startTicker(): void {
    cancelAnimationFrame(this.raf);
    const tick = (): void => {
      if (!this.playing_) return;
      const dur = this.duration();

      // current time from the appropriate clock
      let now: number;
      const videoTime = this.scheduler.masterClockTime();
      if (videoTime !== null) {
        now = videoTime;
        // keep the virtual clock anchored for a seamless handoff at clip end
        this.anchor(now);
      } else {
        now = this.virtualNow();
      }

      // advance across the nearest boundary across all layers
      let guard = 0;
      while (now >= this.boundary - BOUNDARY_EPS && guard++ < 16) {
        const boundary = this.boundary;
        if (!Number.isFinite(boundary)) break;
        this.scheduler.advanceBoundary(boundary);
        this.anchor(boundary);
        now = boundary;
        this.boundary = this.scheduler.activate(boundary, true).boundary;
        if (!Number.isFinite(this.boundary) && boundary >= dur - BOUNDARY_EPS) break;
      }

      // end of timeline
      if (now >= dur - BOUNDARY_EPS) {
        if (this.loop && dur > 0) {
          this.t = 0;
          this.anchor(0);
          this.boundary = this.scheduler.activate(0, true).boundary;
          // no animate(0) here: this branch falls through to the shared
          // animate(this.t) below, with this.t already 0.
        } else {
          this.t = dur;
          this.playing_ = false;
          this.scheduler.pauseAll();
          this.scheduler.activate(this.t, false);
          this.scheduler.animate(this.t);
          this.emit();
          return;
        }
      } else {
        this.t = now;
      }

      this.scheduler.animate(this.t);
      this.scheduler.preload(this.t);
      this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    this.playing_ = false;
    cancelAnimationFrame(this.raf);
    this.scheduler.dispose();
    this.listeners.clear();
  }
}
