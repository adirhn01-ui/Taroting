// Playback engine: the master clock. While a video clip is under the
// playhead, its <video> element IS the clock (mapped to timeline time);
// across gaps and stills a wall-clock advances at the preview speed.

import { frameCenter, frameOf, timelineDuration } from "../../core/time";
import type { ProjectFile, Rational } from "../../core/types";
import { Scheduler, segmentEnd, type Segment } from "./scheduler";

const BOUNDARY_EPS = 1 / 240;

export type TickListener = (time: number, playing: boolean) => void;

export class PlaybackEngine {
  loop = false;
  private t = 0;
  private playing_ = false;
  private previewSpeed_ = 1;
  private segment: Segment = { type: "end" };
  private raf = 0;
  private anchorWall = 0;
  private anchorT = 0;
  private listeners = new Set<TickListener>();

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

  seek(time: number): void {
    const dur = this.duration();
    this.t = Math.min(Math.max(0, time), dur);
    this.anchor(this.t);
    this.segment = this.scheduler.activate(this.t, this.playing_);
    this.emit();
  }

  play(): void {
    if (this.playing_) return;
    const dur = this.duration();
    if (dur <= 0) return;
    if (this.t >= dur - BOUNDARY_EPS) this.t = 0;
    this.playing_ = true;
    this.anchor(this.t);
    this.segment = this.scheduler.activate(this.t, true);
    this.startTicker();
    this.emit();
  }

  pause(): void {
    if (!this.playing_) return;
    this.playing_ = false;
    this.scheduler.pauseAll();
    // freeze display on the exact current frame
    this.segment = this.scheduler.activate(this.t, false);
    this.emit();
  }

  toggle(): void {
    if (this.playing_) this.pause();
    else this.play();
  }

  stop(): void {
    this.playing_ = false;
    this.scheduler.pauseAll();
    this.seek(0);
  }

  stepFrames(n: number): void {
    if (this.playing_) this.pause();
    const fps = this.fps();
    const target = frameCenter(frameOf(this.t, fps) + n, fps);
    this.seek(target);
  }

  jumpSeconds(s: number): void {
    this.seek(this.t + s);
  }

  setPreviewSpeed(speed: number): void {
    this.previewSpeed_ = speed;
    this.scheduler.previewSpeed = speed;
    // re-anchor so the virtual clock doesn't jump
    this.anchor(this.t);
    if (this.playing_) this.segment = this.scheduler.activate(this.t, true);
  }

  /** Re-resolve after project edits (clips moved/trimmed under the playhead). */
  refresh(): void {
    this.segment = this.scheduler.activate(this.t, this.playing_);
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
      const videoTime = this.scheduler.videoClockTime(this.segment);
      if (videoTime !== null) {
        now = videoTime;
        // keep the virtual clock anchored for a seamless handoff at clip end
        this.anchor(now);
      } else {
        now = this.virtualNow();
      }

      // advance across segment boundaries
      let guard = 0;
      while (now >= segmentEnd(this.segment) - BOUNDARY_EPS && guard++ < 8) {
        const boundary = segmentEnd(this.segment);
        if (!Number.isFinite(boundary)) break;
        if (this.segment.type === "video") this.scheduler.swapSlots();
        this.anchor(boundary);
        now = boundary;
        this.segment = this.scheduler.activate(boundary, true);
        if (this.segment.type === "end") break;
      }

      // end of timeline
      if (now >= dur - BOUNDARY_EPS || this.segment.type === "end") {
        if (this.loop && dur > 0) {
          this.t = 0;
          this.anchor(0);
          this.segment = this.scheduler.activate(0, true);
        } else {
          this.t = dur;
          this.playing_ = false;
          this.scheduler.pauseAll();
          this.scheduler.activate(this.t, false);
          this.emit();
          return;
        }
      } else {
        this.t = now;
      }

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
