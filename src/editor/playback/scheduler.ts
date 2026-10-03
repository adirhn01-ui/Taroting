// Scheduler: composites the video-track stack under the playhead onto the
// preview stage. One LayerScheduler per video track drives its own layer set
// (A/B <video> double-buffer + <img> + generated-media <div>); the orchestrating
// Scheduler fans out to every layer, elects the master clock, and reports the
// nearest segment boundary so the engine knows when to re-activate.
//
// Performance: a single video track costs exactly what it did before (one live
// A/B pair, one <img>, the gen <div> is display:none and untouched). Keyframe
// evaluation is zero-alloc (module-level scratch + per-prop cursors) and is
// skipped entirely on one branch when clip.keyframes is undefined.

import { mediaUrl } from "../../core/ipc";
import { KfCursor } from "../../core/anim";
import { clipEnd, sourceTime, timelineTime } from "../../core/time";
import type { Clip, Generator, MediaRef, ProjectFile, Track } from "../../core/types";
import { cssFont } from "../media/generators";
import type { MediaManager } from "../media/media";
import { setOverlay, type LayerSet, type Stage } from "../preview/preview";
import {
  applyIntrinsicScale,
  applyTransform,
  computeTransformInto,
  type ComputedTransform,
} from "../preview/transforms";

const PRELOAD_AHEAD_SEC = 1.5;

// Drift thresholds for every element slaved to a clock it does not own — the
// non-master video layers here and the audio-track voices in audio-graph.ts:
// <=40ms ignore, 40-120ms ±2% nudge, >120ms hard reseek. One copy, shared
// through slaveRate below, so the two mixers cannot drift apart.
export const NUDGE_SEC = 0.04;
export const HARD_RESYNC_SEC = 0.12;

/** The most a slave's hard seek aims ahead of its target, in source seconds. */
const SEEK_LEAD_MAX = 0.5;

/**
 * The three-band drift decision for a slaved element: the playbackRate it should
 * run at, or null when it is too far off to nudge back and must be re-seeked
 * (and then run at `rate`). `drift` is element position minus where it should
 * be, in source seconds; `rate` is its intended rate (clip speed x preview speed).
 *
 * A ±2% nudge is inaudible and invisible, and it is only ever a temporary state:
 * the caller re-asks every tick, and once the drift is back inside NUDGE_SEC the
 * answer is the base rate again. A nudge applied once and never revisited is
 * what let a slaved layer overshoot its correction and run off the other way.
 */
export function slaveRate(drift: number, rate: number): number | null {
  const off = Math.abs(drift);
  if (off > HARD_RESYNC_SEC) return null;
  if (off > NUDGE_SEC) return rate * (drift > 0 ? 0.98 : 1.02);
  return rate;
}

/** What a pooled preview <video> reports to the media manager when it cannot
 *  play a file the manager said was ready. The overlay shows it after
 *  "Preview unavailable: " and the bin shows it as the Failed tooltip, so it
 *  has to read well in both places. */
const PLAYBACK_FAILED = "This file couldn't be played";

/** MediaError.MEDIA_ERR_ABORTED: the load was abandoned (the src was
 *  re-pointed, or the element was torn down), which says nothing about the
 *  file. Spelled out because the node test environment has no MediaError. */
const MEDIA_ERR_ABORTED = 1;

export type Segment =
  | { type: "video"; clip: Clip; media: MediaRef; ready: boolean }
  | { type: "image"; clip: Clip; media: MediaRef }
  | { type: "gen"; clip: Clip; media: MediaRef }
  | { type: "gap"; until: number }
  | { type: "end" };

export function segmentEnd(seg: Segment): number {
  switch (seg.type) {
    case "video":
    case "image":
    case "gen":
      return clipEnd(seg.clip);
    case "gap":
      return seg.until;
    case "end":
      return Infinity;
  }
}

type Slot = "A" | "B";

// one scratch transform reused across every layer/tick — never escapes.
const SCRATCH: ComputedTransform = {
  posX: 0, posY: 0, rotate: 0, flipH: false, flipV: false,
  cropW: 0, cropH: 0, mediaW: 0, mediaH: 0, offX: 0, offY: 0, opacity: 1, k: 1,
};

/** Overrides object reused per layer to feed keyframe poses into the transform
 *  without allocating each frame. */
interface Overrides { x?: number; y?: number; scale?: number; opacity?: number }

/* ------------------------------------------------------------------ */
/* LayerScheduler — one video track                                    */
/* ------------------------------------------------------------------ */

class LayerScheduler {
  private slotSrc: Record<Slot, string | null> = { A: null, B: null };
  /** Which media each slot's src was assigned for — the preload slot's too, so
   *  an error from a preloaded file is attributed to the right entry. */
  private slotMedia: Record<Slot, string | null> = { A: null, B: null };
  private activeSlot: Slot = "A";
  private shown: "A" | "B" | "image" | "gen" | "none" = "none";
  /** the active VIDEO clip (null for image/gen/gap/end) — drives the clock. */
  private activeClip: Clip | null = null;
  /** the active still (image / gen) clip + its media, for keyframe re-eval. */
  private stillClip: Clip | null = null;
  private stillMedia: MediaRef | null = null;
  private lastGenKey: string | null = null;

  /**
   * How far ahead of "where it should be now" a slave's hard seek aims, in
   * source seconds. A seek is not instant: the element's clock stands still
   * while it decodes to the target and the engine's runs on, so it lands
   * behind by the seek's latency x its rate. Past the 120 ms band (a 65 ms
   * seek at 2x preview — ordinary for long-GOP H.264/HEVC) that landing asks
   * for another seek, which lands just as far behind, on every settled tick,
   * forever. Learned from the first settled reading after each hard seek;
   * belongs to one clip's file, so it starts at 0 for each.
   */
  private seekLead = 0;
  /** The lead a hard seek still in flight was aimed with; null when the next
   *  settled reading is not the landing of one of ours. */
  private seekAimed: number | null = null;
  private leadClipId: string | null = null;
  private leadUrl: string | null = null;

  // per-prop keyframe cursors (amortized O(1) monotone playback)
  private curX = new KfCursor();
  private curY = new KfCursor();
  private curScale = new KfCursor();
  private curOpacity = new KfCursor();
  private ov: Overrides = {};

  constructor(
    private set: LayerSet,
    private getTrack: () => Track,
    private getProject: () => ProjectFile,
    private media: MediaManager,
    private stage: Stage,
    private previewSpeed: () => number,
    /** the orchestrator's CURRENT desired transport state (play-race guard).
     *  A play() promise that resolves after the intent flipped to paused — or
     *  after this element stopped being the shown active slot — must pause back. */
    private desiredPlaying: () => boolean,
  ) {
    this.listen(set);
  }

  /** Rebind to a layer set; true when it was a different one. */
  setLayerSet(set: LayerSet): boolean {
    if (set === this.set) return false;
    this.unlisten(this.set);
    this.set = set;
    this.listen(set);
    return true;
  }

  /* ---------------- element errors ---------------- */

  // One idle listener per pooled <video>: nothing runs until an element
  // actually fails. Without it MEDIA_ERR never reached the media manager, so a
  // missing or undecodable file the backend classified as directly playable
  // sat behind a "Ready" badge over a black stage — remux and proxy media
  // failed visibly only because their failure comes from the job instead.
  private readonly onErrorA = (): void => this.reportError("A");
  private readonly onErrorB = (): void => this.reportError("B");

  private listen(set: LayerSet): void {
    set.videoA.media.addEventListener("error", this.onErrorA);
    set.videoB.media.addEventListener("error", this.onErrorB);
  }

  private unlisten(set: LayerSet): void {
    set.videoA.media.removeEventListener("error", this.onErrorA);
    set.videoB.media.removeEventListener("error", this.onErrorB);
  }

  /** Stamp the slot's media failed — but only while the error still describes
   *  what the media manager currently calls ready. A slot re-pointed since (a
   *  relink, a different clip) or a media already marked otherwise is not this
   *  error's business; markFailed itself ignores an id it does not track. */
  private reportError(slot: Slot): void {
    const err = this.video(slot).error;
    if (err === null || err.code === MEDIA_ERR_ABORTED) return;
    const id = this.slotMedia[slot];
    const url = this.slotSrc[slot];
    // Forget what the slot holds: an errored element stays errored until its
    // src is set again, and `assign` sets it only when the URL differs. The
    // natural recovery — remove the Failed media and re-import the same file,
    // or Replace media with it — comes back as a new id with the SAME url,
    // and used to be shown "Ready" over the dead element, black, with no new
    // error to report it. Cleared, the next assign of any url loads afresh.
    // No reload loop: a later assign needs the media ready again, and a ready
    // media whose element fails is stamped below and stops being assigned.
    this.slotSrc[slot] = null;
    if (id === null || url === null) return;
    const st = this.media.status.get()[id];
    if (st?.state !== "ready" || st.url !== url) return;
    this.media.markFailed(id, PLAYBACK_FAILED);
  }

  /** Drop the element listeners. The pooled elements outlive this scheduler
   *  (the stage parks them), so they must not keep it reachable. */
  dispose(): void {
    this.unlisten(this.set);
  }

  /** The clip's media. A plain loop rather than `find`: preload asks this on
   *  every playing tick, and a predicate closure per call is garbage per frame. */
  private mediaOf(clip: Clip): MediaRef | undefined {
    const media = this.getProject().media;
    for (let i = 0; i < media.length; i++) {
      if (media[i]!.id === clip.mediaId) return media[i];
    }
    return undefined;
  }

  /** What's under time t on THIS track. */
  resolve(t: number): Segment {
    const clips = this.getTrack().clips;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]!;
      if (t < c.timelineStart) return { type: "gap", until: c.timelineStart };
      if (t < clipEnd(c)) {
        const media = this.mediaOf(c);
        if (!media) return { type: "gap", until: clipEnd(c) };
        if (media.generator) return { type: "gen", clip: c, media };
        if (media.kind === "image") return { type: "image", clip: c, media };
        const status = this.media.status.get()[media.id];
        return { type: "video", clip: c, media, ready: status?.state === "ready" };
      }
    }
    return { type: "end" };
  }

  private nextVideoClipAfter(t: number): Clip | null {
    for (const c of this.getTrack().clips) {
      if (c.timelineStart > t) {
        const media = this.mediaOf(c);
        if (media && !media.generator && media.kind !== "image") return c;
      }
    }
    return null;
  }

  /* ---------------- elements ---------------- */

  elements(): HTMLVideoElement[] {
    return [this.set.videoA.media, this.set.videoB.media];
  }

  private video(slot: Slot): HTMLVideoElement {
    return (slot === "A" ? this.set.videoA : this.set.videoB).media;
  }

  private boxes(slot: Slot) {
    return slot === "A" ? this.set.videoA : this.set.videoB;
  }

  private otherSlot(): Slot {
    return this.activeSlot === "A" ? "B" : "A";
  }

  private urlFor(media: MediaRef): string | null {
    const s = this.media.status.get()[media.id];
    return s?.state === "ready" ? s.url : null;
  }

  private assign(slot: Slot, url: string, mediaId: string): HTMLVideoElement {
    const el = this.video(slot);
    this.slotMedia[slot] = mediaId;
    if (this.slotSrc[slot] !== url) {
      this.slotSrc[slot] = url;
      el.src = url;
    }
    return el;
  }

  private show(which: "A" | "B" | "image" | "gen" | "none"): void {
    if (this.shown === which) return;
    this.shown = which;
    this.set.videoA.pos.style.display = which === "A" ? "" : "none";
    this.set.videoB.pos.style.display = which === "B" ? "" : "none";
    this.set.image.pos.style.display = which === "image" ? "" : "none";
    this.set.gen.pos.style.display = which === "gen" ? "" : "none";
  }

  /** True when the active segment is a video whose element is ready to play. */
  hasReadyVideo(): boolean {
    if (this.shown !== "A" && this.shown !== "B") return false;
    return this.video(this.activeSlot).readyState >= 2;
  }

  activeVideo(): { el: HTMLVideoElement; clip: Clip } | null {
    const el = this.activeElement();
    return el === null ? null : { el, clip: this.activeClip! };
  }

  /** activeVideo()'s element alone, without the record (the per-tick path). */
  activeElement(): HTMLVideoElement | null {
    if (this.shown !== "A" && this.shown !== "B") return null;
    if (!this.activeClip) return null;
    return this.video(this.activeSlot);
  }

  activeClipRef(): Clip | null {
    return this.activeClip;
  }

  /** Timeline time from THIS layer's active video element, or null. */
  clockTime(): number | null {
    if (this.shown !== "A" && this.shown !== "B") return null;
    if (!this.activeClip) return null;
    const el = this.video(this.activeSlot);
    if (el.readyState < 2) return null;
    // An ended or errored element keeps a frozen currentTime and a readyState
    // that still says "have data". Trusting it re-anchored the engine to the
    // same instant every frame, so a file shorter than its probed duration (a
    // remux or proxy output can be) or a read error mid-clip never reached the
    // out-point: the transport sat "playing" on a still frame forever. Saying
    // "no clock" hands timing to the next layer's element, or else to the
    // engine's wall clock from the last good reading, which carries on
    // seamlessly to the boundary.
    // hasReadyVideo() deliberately keeps its own meaning: the audio graph and
    // the dev hooks ask whether a frame is ON SCREEN, not whether it ticks.
    if (el.ended || el.error !== null) return null;
    return timelineTime(this.activeClip, el.currentTime);
  }

  /* ---------------- transform + keyframes ---------------- */

  /** Compute the pose for `clip` at timeline time t (using keyframes when the
   *  clip animates) and apply it to `boxes`. Zero-alloc; the keyframe branch is
   *  skipped entirely when clip.keyframes is undefined. */
  private applyPose(
    boxes: { pos: HTMLElement; rot: HTMLElement; crop: HTMLElement; media: HTMLElement },
    clip: Clip,
    media: MediaRef,
    t: number,
  ): void {
    const project = this.getProject().timeline;
    const kfs = clip.keyframes;
    if (kfs === undefined) {
      computeTransformInto(SCRATCH, clip.transform, media, project);
    } else {
      const s = sourceTime(clip, t - clip.timelineStart);
      const base = clip.transform;
      const ov = this.ov;
      // Length-based gates, NOT truthiness: schema.rs types keyframes as
      // Option<Vec<Keyframe>>, so a shared .trt can legally carry "x": [] — and
      // [] is truthy while evalKfs/KfCursor.eval throw on an empty array. An
      // empty track means "not animated", exactly like undefined.
      ov.x = kfs.x?.length ? this.curX.eval(kfs.x, s) : undefined;
      ov.y = kfs.y?.length ? this.curY.eval(kfs.y, s) : undefined;
      ov.scale = kfs.scale?.length ? this.curScale.eval(kfs.scale, s) : undefined;
      ov.opacity = kfs.opacity?.length ? this.curOpacity.eval(kfs.opacity, s) : undefined;
      computeTransformInto(SCRATCH, base, media, project, ov);
    }
    applyTransform(boxes, SCRATCH, this.stage.scale);
  }

  /** Render generated media (solid / text) into the gen <div>, sized to
   *  media.width/height and styled per the generator. Cheap; only touched when a
   *  gen clip is active. */
  private applyGen(clip: Clip, media: MediaRef, t: number): void {
    const g = media.generator!;
    const el = this.set.gen.media;
    const key = generatorKey(media.id, g);
    if (key !== this.lastGenKey) {
      this.lastGenKey = key;
      styleGen(el, g, media.width ?? 0, media.height ?? 0);
    }
    // geometry (position/scale/rotate/crop/opacity, incl. keyframes) rides the
    // same tower as any other layer.
    this.applyGenPose(clip, media, t);
  }

  /** applyPose for the gen <div>, then re-express the media box as a SCALE.
   *  applyTransform sizes the box to mediaW*s, which moves nothing inside a
   *  <div>; applyIntrinsicScale restores the intrinsic box and scales it
   *  instead, producing identical geometry with correctly-sized glyphs. Every
   *  path that poses the gen layer must go through here — a bare applyPose
   *  (e.g. from animate()) would silently drop the scale again. */
  private applyGenPose(clip: Clip, media: MediaRef, t: number): void {
    this.applyPose(this.set.gen, clip, media, t);
    applyIntrinsicScale(
      this.set.gen.media, SCRATCH, media.width ?? 0, media.height ?? 0, this.stage.scale,
    );
  }

  /** Show/seek/play THIS layer for time t. Returns its segment (for boundary
   *  computation). `isMaster` layers own their clock; others drift-slave. */
  activate(t: number, playing: boolean, isMaster: boolean): Segment {
    const segment = this.resolve(t);
    switch (segment.type) {
      case "video": {
        const { clip, media } = segment;
        const url = this.urlFor(media);
        if (!url) {
          this.activeClip = null;
          this.stillClip = null;
          this.stillMedia = null;
          this.show("none");
          this.pauseAll();
          return segment;
        }
        // The preload went into the slot that was inactive at the time, and
        // advanceBoundary only swaps after a VIDEO segment. After a still, a
        // generated clip, a gap longer than the preload window or a loop
        // restart, the preloaded element is therefore sitting in the OTHER
        // slot — and assigning the URL to the active one threw it away for a
        // fresh load: a black flash, a re-seek and two decoders for one file.
        // Adopt the warm element instead. Never the one currently on screen:
        // that is a different clip's frame, still showing.
        if (
          this.slotSrc[this.activeSlot] !== url &&
          this.slotSrc[this.otherSlot()] === url &&
          this.shown !== this.otherSlot()
        ) {
          this.swapSlots();
        }
        const el = this.assign(this.activeSlot, url, media.id);
        if (clip.id !== this.leadClipId || url !== this.leadUrl) {
          this.leadClipId = clip.id;
          this.leadUrl = url;
          this.seekLead = 0;
          this.seekAimed = null;
        }
        this.applyPose(this.boxes(this.activeSlot), clip, media, t);
        this.activeClip = clip;
        this.stillClip = null;
        this.stillMedia = null;
        this.show(this.activeSlot);
        const rate = clip.speed * this.previewSpeed();
        const srcT = sourceTime(clip, t - clip.timelineStart);
        if (playing && !isMaster && el.readyState >= 2) {
          // slave: correct drift against engine time instead of hard-seeking
          this.holdToClock(el, srcT, rate);
        } else {
          // An exact seek (paused, the clock layer, or not decodable yet): its
          // landing says nothing about the lead, so it must not be learned from.
          this.seekAimed = null;
          if (Math.abs(el.currentTime - srcT) > 0.01) el.currentTime = srcT;
          el.playbackRate = rate;
        }
        if (playing) this.playGuarded(el);
        else el.pause();
        this.video(this.otherSlot()).pause();
        return segment;
      }
      case "image": {
        this.activeClip = null;
        this.stillClip = segment.clip;
        this.stillMedia = segment.media;
        const img = this.set.image.media;
        const url = mediaUrl(segment.media.path);
        if (img.src !== url) img.src = url;
        this.applyPose(this.set.image, segment.clip, segment.media, t);
        this.show("image");
        this.pauseAll();
        return segment;
      }
      case "gen": {
        this.activeClip = null;
        this.stillClip = segment.clip;
        this.stillMedia = segment.media;
        this.applyGen(segment.clip, segment.media, t);
        this.show("gen");
        this.pauseAll();
        return segment;
      }
      default: {
        this.activeClip = null;
        this.stillClip = null;
        this.stillMedia = null;
        this.show("none");
        this.pauseAll();
        return segment;
      }
    }
  }

  /** Re-evaluate keyframes for the active clip at time t. Called every engine
   *  tick. Clips without keyframes take one branch and do zero work (the static
   *  pose was already applied on activate). Covers video, image and gen. */
  animate(t: number): void {
    if (this.shown === "A" || this.shown === "B") {
      const clip = this.activeClip;
      if (!clip || clip.keyframes === undefined) return;
      const media = this.mediaOf(clip);
      if (media) this.applyPose(this.boxes(this.activeSlot), clip, media, t);
    } else if (this.shown === "image") {
      const clip = this.stillClip;
      if (!clip || clip.keyframes === undefined) return;
      const media = this.stillMedia;
      if (media) this.applyPose(this.set.image, clip, media, t);
    } else if (this.shown === "gen") {
      const clip = this.stillClip;
      if (!clip || clip.keyframes === undefined) return;
      const media = this.stillMedia;
      if (media) this.applyGenPose(clip, media, t);
    }
  }

  /** Per-tick drift correction for a layer that is NOT the clock: the same
   *  three-band test activate() runs, against engine time `t`. Writes only on
   *  change, so a layer in sync costs a few property reads. An element that is
   *  still seeking, paused, ended, errored or not yet decodable is left alone —
   *  its position means nothing until it settles, and a seek issued on top of
   *  a seek only restarts it. */
  syncAsSlave(t: number): void {
    if (this.shown !== "A" && this.shown !== "B") return;
    const clip = this.activeClip;
    if (!clip) return;
    const el = this.video(this.activeSlot);
    if (el.readyState < 2 || el.seeking || el.paused || el.ended || el.error !== null) return;
    const rate = clip.speed * this.previewSpeed();
    this.holdToClock(el, sourceTime(clip, t - clip.timelineStart), rate);
  }

  /**
   * The slave drift test, shared by activate() and syncAsSlave() so the two
   * hard-seek sites cannot learn or aim differently. `srcT` is where the
   * element should be now, `rate` its intended rate.
   *
   * Learn, then decide, in the same reading: the first settled reading after
   * one of our hard seeks shows how far that seek missed, and the lead becomes
   * the aim that would have landed on time — so the next seek, if one is still
   * needed, already uses it and a slow-seeking layer settles in two seeks.
   * The correction runs both ways: seek latency is not constant (a cold
   * long-GOP seek is slow, a later one into decoded data is fast), and a lead
   * that could only grow would land ahead by more than 120 ms and loop the
   * other way. Inside the dead band the lead is left alone.
   */
  private holdToClock(el: HTMLVideoElement, srcT: number, rate: number): void {
    const drift = el.currentTime - srcT;
    if (this.seekAimed !== null && !el.seeking) {
      if (Math.abs(drift) > NUDGE_SEC) {
        this.seekLead = Math.min(SEEK_LEAD_MAX, Math.max(0, this.seekAimed - drift));
      }
      this.seekAimed = null;
    }
    const next = slaveRate(drift, rate);
    if (next === null) {
      el.currentTime = srcT + this.seekLead;
      this.seekAimed = this.seekLead;
      if (el.playbackRate !== rate) el.playbackRate = rate;
    } else if (el.playbackRate !== next) {
      el.playbackRate = next;
    }
  }

  /** Guarded play: by the time the play() promise resolves the transport may
   *  have paused, or this slot may no longer be the shown active video (a swap
   *  or a switch to image/gen/gap synchronously paused it). In either case pause
   *  it back so a stale in-flight play() can never keep a should-be-stopped
   *  element running. pause() is synchronous and always wins.
   *
   *  Crucially this checks the LIVE desired state, not a generation token: a
   *  benign re-activation of the SAME playing clip (seek within a clip, or two
   *  sub-frame boundaries in one rAF) must NOT pause — the intent is still
   *  "play this element", so an older promise resolving here is a no-op. */
  private playGuarded(el: HTMLVideoElement): void {
    const p = el.play();
    if (p && typeof p.then === "function") {
      p.then(
        () => {
          const stillWanted =
            this.desiredPlaying() &&
            (this.shown === "A" || this.shown === "B") &&
            el === this.video(this.activeSlot);
          if (!stillWanted) el.pause();
        },
        () => {},
      );
    }
  }

  /** Advance into the preloaded clip: swap A/B slots. */
  swapSlots(): void {
    this.activeSlot = this.otherSlot();
  }

  /** Preload the next real video clip into the inactive slot. With `loopEnd`
   *  (the timeline duration, while looping) the clip after the LAST one is
   *  this track's first video clip, reached by wrapping through the restart —
   *  without that, every loop restart loaded clip 1 from cold. */
  preload(t: number, loopEnd: number | null): void {
    const speed = Math.max(0.25, this.previewSpeed());
    let next = this.nextVideoClipAfter(t);
    let timeUntil = 0;
    if (next) {
      timeUntil = (next.timelineStart - t) / speed;
    } else if (loopEnd !== null) {
      next = this.nextVideoClipAfter(-Infinity);
      if (!next) return;
      timeUntil = (loopEnd - t + next.timelineStart) / speed;
    } else {
      return;
    }
    if (timeUntil > PRELOAD_AHEAD_SEC) return;
    const media = this.mediaOf(next);
    if (!media) return;
    const url = this.urlFor(media);
    if (!url) return;
    const slot = this.otherSlot();
    const el = this.assign(slot, url, media.id);
    const target = next.srcIn;
    if (el.readyState >= 1 && Math.abs(el.currentTime - target) > 0.05 && !el.seeking) {
      el.currentTime = target;
    }
  }

  pauseAll(): void {
    // A seek still in flight here lands while nothing is playing: by the next
    // reading (a loop restart into the same clip, say) its position says
    // nothing about how far a seek misses.
    this.seekAimed = null;
    this.video("A").pause();
    this.video("B").pause();
  }
}

/* ------------------------------------------------------------------ */
/* Generated-media rendering                                           */
/* ------------------------------------------------------------------ */

// A drawing never reaches the video stage: load_project refuses one in a video
// project, and image projects never mount this scheduler. Its branches below
// exist only so the union stays exhaustive — an empty transparent box, never a
// "text" rendering of a shape that has no text.
function generatorKey(mediaId: string, g: Generator): string {
  return g.type === "solid"
    ? `${mediaId}|solid|${g.color}`
    : g.type === "text"
      ? `${mediaId}|text|${g.text}|${g.fontFamily}|${g.sizePx}|${g.color}|${g.bold}|${g.italic}`
      : `${mediaId}|drawing`;
}

/** Style the gen <div> so the DOM output matches the exported frame: solid uses
 *  a background color; text renders crisp DOM text at the media's intrinsic box
 *  size. Geometry is applied separately by the transform tower. */
function styleGen(el: HTMLElement, g: Generator, w: number, h: number): void {
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  if (g.type === "solid") {
    el.style.background = g.color;
    el.style.color = "";
    el.style.font = "";
    el.style.whiteSpace = "";
    el.style.lineHeight = "";
    el.textContent = "";
  } else if (g.type !== "text") {
    el.style.background = "transparent";
    el.style.color = "";
    el.style.font = "";
    el.style.whiteSpace = "";
    el.style.lineHeight = "";
    el.textContent = "";
  } else {
    el.style.background = "transparent";
    el.style.color = g.color;
    el.style.whiteSpace = "pre";
    // The line height rides INSIDE the shorthand (cssFont's "/1.25"): `font`
    // resets line-height to `normal`, so the separate lineHeight this used to
    // write first was silently wiped, and Segoe UI's ~1.33 `normal` spaced
    // lines wider than the export's 1.25 and clipped the last one.
    el.style.font = cssFont(g);
    el.textContent = g.text;
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler — orchestrator                                            */
/* ------------------------------------------------------------------ */

export interface VideoInfo {
  el: HTMLVideoElement;
  clip: Clip;
  track: Track;
}

export interface VisibleClip {
  clip: Clip;
  track: Track;
  media: MediaRef;
}

export class Scheduler {
  previewSpeed = 1;
  private layers: LayerScheduler[] = [];
  /** The current desired transport state, mirrored from the engine on every
   *  activate() and forced false by pauseAll(). The play-race guard reads this
   *  LIVE (not a captured token) so a benign re-activation of a still-playing
   *  clip never trips it, while a real pause (which sets this false) always
   *  wins over an in-flight play() promise. */
  private playing = false;

  constructor(
    private stage: Stage,
    private getProject: () => ProjectFile,
    private media: MediaManager,
  ) {
    this.syncLayers();
  }

  /** The video tracks, memoised on the identity of the project's `tracks`
   *  array. Every edit replaces that array (core/project.ts updates it with
   *  map/filter/spread, never in place), so an unchanged identity means an
   *  unchanged list — and the several calls a playback tick makes (the clock,
   *  animate, preload, each layer's getTrack) stop filtering a fresh copy each. */
  private tracksSrc: readonly Track[] | null = null;
  private tracksCache: Track[] = [];
  private videoTracks(): Track[] {
    const all = this.getProject().timeline.tracks;
    if (all !== this.tracksSrc) {
      this.tracksSrc = all;
      this.tracksCache = all.filter((t) => t.kind === "video");
    }
    return this.tracksCache;
  }

  /** Set by activate(), cleared by the next syncSlaves(): the tick activate
   *  just ran has already put every slave through the same drift test. */
  private slavesFresh = false;

  /** Reconcile the layer array against the current video tracks. Element pools
   *  are parked by the stage (never destroyed — MediaElementSource is one-shot),
   *  so this only ever adds/rebinds LayerScheduler wrappers. */
  syncLayers(): void {
    const tracks = this.videoTracks();
    this.stage.syncLayerCount(tracks.length);
    while (this.layers.length < tracks.length) {
      const idx = this.layers.length;
      const ls = new LayerScheduler(
        this.stage.layers[idx]!,
        () => this.videoTracks()[idx]!,
        this.getProject,
        this.media,
        this.stage,
        () => this.previewSpeed,
        () => this.playing,
      );
      this.layers.push(ls);
      this.elementsCache = null;
    }
    // Rebind each live layer to its (possibly new) layer set. Its track getter
    // needs no rebinding: it already reads index i of the live list, and
    // creating a fresh closure here on every activate() bought nothing.
    for (let i = 0; i < this.layers.length; i++) {
      const ls = this.layers[i]!;
      if (i < tracks.length) {
        if (ls.setLayerSet(this.stage.layers[i]!)) this.elementsCache = null;
      } else {
        ls.pauseAll();
      }
    }
  }

  /** The layers bound to a live video track, topmost first. Callers only
   *  iterate it; it is `this.layers` itself whenever no layer is parked. */
  private activeLayers(): readonly LayerScheduler[] {
    const n = this.videoTracks().length;
    return n >= this.layers.length ? this.layers : this.layers.slice(0, n);
  }

  /** Activate every layer for time t. Returns the nearest segment boundary
   *  (min over layers of each layer's active segment end). */
  activate(t: number, playing: boolean): { boundary: number } {
    this.playing = playing;
    this.slavesFresh = true;
    this.syncLayers();
    const layers = this.activeLayers();

    // elect master: the TOPMOST layer whose active segment is a ready video.
    // Resolve each layer once to decide, then activate.
    let masterIdx = -1;
    for (let i = 0; i < layers.length; i++) {
      const seg = layers[i]!.resolve(t);
      if (seg.type === "video" && seg.ready) {
        masterIdx = i;
        break;
      }
    }

    // Stays Infinity unless some layer reports a finite end, so no layer
    // reporting one leaves it Infinity on its own.
    let boundary = Infinity;
    for (let i = 0; i < layers.length; i++) {
      const seg = layers[i]!.activate(t, playing, i === masterIdx);
      const end = segmentEnd(seg);
      if (Number.isFinite(end)) boundary = Math.min(boundary, end);
      // gaps also bound (their `until` is finite when a later clip exists)
    }
    // manage the status overlay from the top layer's state
    this.updateOverlay(t);
    return { boundary };
  }

  private updateOverlay(t: number): void {
    // Show "preparing/failed" only when the topmost occupied layer is a video
    // whose media isn't ready yet (mirrors the old single-track behavior).
    for (const layer of this.activeLayers()) {
      const seg = layer.resolve(t);
      if (seg.type === "gap") continue;
      if (seg.type === "video" && !seg.ready) {
        const st = this.media.status.get()[seg.media.id];
        setOverlay(
          this.stage,
          st?.state === "failed" ? `Preview unavailable: ${st.message}` : "Preparing preview",
        );
        return;
      }
      break; // first occupied layer is fine
    }
    setOverlay(this.stage, null);
  }

  /** Re-evaluate keyframe poses on every layer for the given tick time. */
  animate(t: number): void {
    for (const layer of this.activeLayers()) layer.animate(t);
  }

  /** Master clock: timeline time from the topmost ready-video layer, or null. */
  masterClockTime(): number | null {
    for (const layer of this.activeLayers()) {
      if (layer.hasReadyVideo()) {
        const time = layer.clockTime();
        if (time !== null) return time;
      }
    }
    return null;
  }

  /** Advance every layer whose active segment ends exactly at `boundary` into
   *  its next clip (A/B swap). Called by the engine before re-activating. */
  advanceBoundary(boundary: number): void {
    for (const layer of this.activeLayers()) {
      const seg = layer.resolve(boundary - 1e-6);
      if (seg.type === "video" && Math.abs(segmentEnd(seg) - boundary) < 1e-6) {
        layer.swapSlots();
      }
    }
  }

  /**
   * Keep every slaved video layer on the clock, once per playing tick.
   *
   * activate() used to be the only place a slave was corrected, so between
   * activations its start offset was never revisited and a ±2% nudge applied
   * there stayed applied: two overlapping video layers drifted ~1.2 s a minute
   * apart and then jumped at the next cut. Called by the engine after
   * animate(), only while playing.
   *
   * The clock layer is picked HERE, per tick, by exactly masterClockTime()'s
   * rule (the topmost layer whose element is a live clock), not taken from
   * activate()'s election — the layer activate() elected may since have ended
   * or errored and stopped being the clock, and it then needs correcting like
   * any other. The clock layer itself is never written to.
   */
  syncSlaves(t: number): void {
    if (this.slavesFresh) {
      // activate() ran since the last tick and already applied this test.
      this.slavesFresh = false;
      return;
    }
    const layers = this.activeLayers();
    if (layers.length < 2) return;
    let clock = -1;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (layer.hasReadyVideo() && layer.clockTime() !== null) {
        clock = i;
        break;
      }
    }
    for (let i = 0; i < layers.length; i++) {
      if (i !== clock) layers[i]!.syncAsSlave(t);
    }
  }

  /** Preload each layer's next video clip. `loopEnd` is the timeline duration
   *  while looping (so the last clip preloads the first), otherwise null. */
  preload(t: number, loopEnd: number | null = null): void {
    for (const layer of this.activeLayers()) layer.preload(t, loopEnd);
  }

  /* ---------------- audio-graph / dev queries ---------------- */

  /** All A/B video elements across every layer (audio graph attaches lazily).
   *  The audio graph walks this on every tick, so the list is rebuilt only when
   *  a layer is added or rebound to a different element set; callers must
   *  treat it as read-only. */
  private elementsCache: HTMLVideoElement[] | null = null;
  videoElements(): readonly HTMLVideoElement[] {
    if (this.elementsCache === null) {
      const out: HTMLVideoElement[] = [];
      for (const layer of this.layers) out.push(...layer.elements());
      this.elementsCache = out;
    }
    return this.elementsCache;
  }

  /** activeVideoInfos() for the audio graph's tick: the same answer written
   *  into records reused from call to call, so a playing frame allocates
   *  nothing for it. Valid only until the next call — read it, never keep it. */
  private infosScratch: VideoInfo[] = [];
  private infosView: VideoInfo[] = [];
  activeVideoScratch(): readonly VideoInfo[] {
    const tracks = this.videoTracks();
    const layers = this.activeLayers();
    const view = this.infosView;
    view.length = 0;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      const av = layer.activeElement();
      if (av === null || !layer.hasReadyVideo()) continue;
      let rec = this.infosScratch[view.length];
      if (rec === undefined) {
        rec = { el: av, clip: layer.activeClipRef()!, track: tracks[i]! };
        this.infosScratch.push(rec);
      } else {
        rec.el = av;
        rec.clip = layer.activeClipRef()!;
        rec.track = tracks[i]!;
      }
      view.push(rec);
    }
    return view;
  }

  /** Every layer with an active ready video, TOPMOST-first, with its track. */
  activeVideoInfos(): VideoInfo[] {
    const out: VideoInfo[] = [];
    const tracks = this.videoTracks();
    const layers = this.activeLayers();
    for (let i = 0; i < layers.length; i++) {
      const av = layers[i]!.activeVideo();
      if (av && layers[i]!.hasReadyVideo()) {
        out.push({ el: av.el, clip: av.clip, track: tracks[i]! });
      }
    }
    return out;
  }

  /** Topmost active video element (dev hook). */
  activeVideo(): HTMLVideoElement | null {
    return this.activeVideoInfos()[0]?.el ?? null;
  }

  /** All visible clips under t, TOPMOST-first (for future canvas hit-testing). */
  visibleClipsAt(t: number): VisibleClip[] {
    const out: VisibleClip[] = [];
    const tracks = this.videoTracks();
    const layers = this.activeLayers();
    for (let i = 0; i < layers.length; i++) {
      const seg = layers[i]!.resolve(t);
      if (seg.type === "video" || seg.type === "image" || seg.type === "gen") {
        out.push({ clip: seg.clip, track: tracks[i]!, media: seg.media });
      }
    }
    return out;
  }

  pauseAll(): void {
    // A real pause: flip the desired state false BEFORE pausing so any in-flight
    // play() promise that resolves after this sees stillWanted === false and
    // pauses back (the v0.6 phase-3 "pause always wins" contract).
    this.playing = false;
    for (const layer of this.layers) layer.pauseAll();
  }

  dispose(): void {
    this.pauseAll();
    for (const layer of this.layers) layer.dispose();
  }
}
