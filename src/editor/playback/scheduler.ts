// Scheduler: resolves what's under the playhead on the video track and
// drives the preview stage — element visibility, source seeking through the
// time mapping, A/B preloading across cuts, transforms, and volume.

import { mediaUrl } from "../../core/ipc";
import { clipEnd, sourceTime, timelineTime } from "../../core/time";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";
import type { MediaManager } from "../media/media";
import { setOverlay, type Stage } from "../preview/preview";
import { styleLayer } from "../preview/transforms";

const PRELOAD_AHEAD_SEC = 1.5;

export type Segment =
  | { type: "video"; clip: Clip; media: MediaRef; ready: boolean }
  | { type: "image"; clip: Clip; media: MediaRef }
  | { type: "gap"; until: number }
  | { type: "end" };

export function segmentEnd(seg: Segment): number {
  switch (seg.type) {
    case "video":
    case "image":
      return clipEnd(seg.clip);
    case "gap":
      return seg.until;
    case "end":
      return Infinity;
  }
}

type Slot = "A" | "B";

export class Scheduler {
  previewSpeed = 1;
  private slotSrc: Record<Slot, string | null> = { A: null, B: null };
  private activeSlot: Slot = "A";
  private shown: "A" | "B" | "image" | "none" = "none";

  constructor(
    private stage: Stage,
    private getProject: () => ProjectFile,
    private media: MediaManager,
  ) {}

  /* ---------------- resolution ---------------- */

  private videoTrack() {
    return this.getProject().timeline.tracks[0]!;
  }

  private mediaOf(clip: Clip): MediaRef | undefined {
    return this.getProject().media.find((m) => m.id === clip.mediaId);
  }

  resolve(t: number): Segment {
    const track = this.videoTrack();
    const clips = track.clips;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]!;
      if (t < c.timelineStart) return { type: "gap", until: c.timelineStart };
      if (t < clipEnd(c)) {
        const media = this.mediaOf(c);
        if (!media) return { type: "gap", until: clipEnd(c) };
        if (media.kind === "image") return { type: "image", clip: c, media };
        const status = this.media.status.get()[media.id];
        return {
          type: "video",
          clip: c,
          media,
          ready: status?.state === "ready",
        };
      }
    }
    return { type: "end" };
  }

  private nextVideoClipAfter(t: number): Clip | null {
    for (const c of this.videoTrack().clips) {
      if (c.timelineStart > t) {
        const media = this.mediaOf(c);
        if (media && media.kind !== "image") return c;
      }
    }
    return null;
  }

  /* ---------------- element management ---------------- */

  private video(slot: Slot): HTMLVideoElement {
    return (slot === "A" ? this.stage.videoA : this.stage.videoB).media;
  }

  private layer(slot: Slot) {
    return slot === "A" ? this.stage.videoA : this.stage.videoB;
  }

  private urlFor(media: MediaRef): string | null {
    const s = this.media.status.get()[media.id];
    return s?.state === "ready" ? s.url : null;
  }

  private assign(slot: Slot, url: string): HTMLVideoElement {
    const el = this.video(slot);
    if (this.slotSrc[slot] !== url) {
      this.slotSrc[slot] = url;
      el.src = url;
    }
    return el;
  }

  private show(which: "A" | "B" | "image" | "none"): void {
    if (this.shown === which) return;
    this.shown = which;
    this.stage.videoA.pos.style.display = which === "A" ? "" : "none";
    this.stage.videoB.pos.style.display = which === "B" ? "" : "none";
    this.stage.image.pos.style.display = which === "image" ? "" : "none";
  }

  private applyClipStyle(slot: Slot | "image", clip: Clip, media: MediaRef): void {
    const project = this.getProject();
    const layer = slot === "image" ? this.stage.image : this.layer(slot);
    styleLayer(layer, clip.transform, media, project.timeline, this.stage.scale);
    if (slot !== "image") {
      const el = this.video(slot);
      const track = this.videoTrack();
      el.muted = clip.audio.muted || track.muted;
      el.volume = Math.min(1, Math.max(0, clip.audio.volume));
    }
  }

  /** Re-apply styling after project edits or stage resize. */
  restyle(segment: Segment): void {
    if (segment.type === "video") this.applyClipStyle(this.activeSlot, segment.clip, segment.media);
    else if (segment.type === "image") this.applyClipStyle("image", segment.clip, segment.media);
  }

  /* ---------------- display + playback ---------------- */

  /** Show the frame for time t; play if requested. Returns the segment. */
  activate(t: number, playing: boolean): Segment {
    const segment = this.resolve(t);
    switch (segment.type) {
      case "video": {
        const { clip, media } = segment;
        const url = this.urlFor(media);
        if (!url) {
          this.show("none");
          const st = this.media.status.get()[media.id];
          setOverlay(
            this.stage,
            st?.state === "failed" ? `Preview unavailable: ${st.message}` : "Preparing preview…",
          );
          this.pauseAll();
          return segment;
        }
        setOverlay(this.stage, null);
        const el = this.assign(this.activeSlot, url);
        this.applyClipStyle(this.activeSlot, clip, media);
        const srcT = sourceTime(clip, t - clip.timelineStart);
        if (Math.abs(el.currentTime - srcT) > 0.01) {
          el.currentTime = srcT;
        }
        el.playbackRate = clip.speed * this.previewSpeed;
        this.show(this.activeSlot);
        if (playing) {
          void el.play().catch(() => {});
        } else {
          el.pause();
        }
        this.video(this.otherSlot()).pause();
        return segment;
      }
      case "image": {
        setOverlay(this.stage, null);
        const img = this.stage.image.media;
        const url = mediaUrl(segment.media.path);
        if (img.src !== url) img.src = url;
        this.applyClipStyle("image", segment.clip, segment.media);
        this.show("image");
        this.pauseAll();
        return segment;
      }
      default: {
        setOverlay(this.stage, null);
        this.show("none");
        this.pauseAll();
        return segment;
      }
    }
  }

  /** Swap active/back slots (called when advancing into a preloaded clip). */
  private otherSlot(): Slot {
    return this.activeSlot === "A" ? "B" : "A";
  }

  swapSlots(): void {
    this.activeSlot = this.otherSlot();
  }

  /** Timeline time derived from the active video element (master clock). */
  videoClockTime(segment: Segment): number | null {
    if (segment.type !== "video") return null;
    const el = this.video(this.activeSlot);
    if (el.readyState < 2) return null;
    return timelineTime(segment.clip, el.currentTime);
  }

  /** Preload the next video clip into the inactive slot. */
  preload(t: number): void {
    const next = this.nextVideoClipAfter(t);
    if (!next) return;
    const timeUntil = (next.timelineStart - t) / Math.max(0.25, this.previewSpeed);
    if (timeUntil > PRELOAD_AHEAD_SEC) return;
    const media = this.mediaOf(next);
    if (!media) return;
    const url = this.urlFor(media);
    if (!url) return;
    const slot = this.otherSlot();
    const el = this.assign(slot, url);
    const target = next.srcIn;
    if (el.readyState >= 1 && Math.abs(el.currentTime - target) > 0.05 && !el.seeking) {
      el.currentTime = target;
    }
  }

  pauseAll(): void {
    this.video("A").pause();
    this.video("B").pause();
  }

  dispose(): void {
    this.pauseAll();
  }
}
