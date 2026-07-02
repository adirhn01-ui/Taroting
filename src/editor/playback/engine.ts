// Playback engine: the master clock. While a ready video clip is under the
// playhead on some layer, the topmost such element IS the clock (mapped to
// timeline time); across gaps and stills a wall-clock advances at the preview
// speed. The scheduler composites the whole video-track stack; the engine only
// tracks the nearest segment boundary across all layers.

import { frameCenter, frameOf, timelineDuration } from "../../core/time";
import type { ProjectFile, Rational } from "../../core/types";
import { Scheduler } from "./scheduler";

const BOUNDARY_EPS = 1 / 240;

export type TickListener = (time: number, playing: boolean) => void;

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
          this.scheduler.animate(0);
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
