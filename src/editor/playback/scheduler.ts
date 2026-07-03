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
import type { MediaManager } from "../media/media";
import { setOverlay, type LayerSet, type Stage } from "../preview/preview";
import {
  applyTransform,
  computeTransformInto,
  type ComputedTransform,
} from "../preview/transforms";

const PRELOAD_AHEAD_SEC = 1.5;

// drift thresholds for slaved (non-master) video layers, matching the audio
// graph's proven values: <=40ms ignore, 40-120ms ±2% nudge, >120ms hard reseek.
const NUDGE_SEC = 0.04;
const HARD_RESYNC_SEC = 0.12;

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
  cropW: 0, cropH: 0, mediaW: 0, mediaH: 0, offX: 0, offY: 0, opacity: 1,
};

/** Overrides object reused per layer to feed keyframe poses into the transform
 *  without allocating each frame. */
interface Overrides { x?: number; y?: number; scale?: number; opacity?: number }

/* ------------------------------------------------------------------ */
/* LayerScheduler — one video track                                    */
/* ------------------------------------------------------------------ */

class LayerScheduler {
  private slotSrc: Record<Slot, string | null> = { A: null, B: null };
  private activeSlot: Slot = "A";
  private shown: "A" | "B" | "image" | "gen" | "none" = "none";
  /** the active VIDEO clip (null for image/gen/gap/end) — drives the clock. */
  private activeClip: Clip | null = null;
  /** the active still (image / gen) clip + its media, for keyframe re-eval. */
  private stillClip: Clip | null = null;
  private stillMedia: MediaRef | null = null;
  private lastGenKey: string | null = null;

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
  ) {}

  setLayerSet(set: LayerSet): void {
    this.set = set;
  }
  setTrack(getTrack: () => Track): void {
    this.getTrack = getTrack;
  }

  private mediaOf(clip: Clip): MediaRef | undefined {
    return this.getProject().media.find((m) => m.id === clip.mediaId);
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

  private assign(slot: Slot, url: string): HTMLVideoElement {
    const el = this.video(slot);
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
    if (this.shown !== "A" && this.shown !== "B") return null;
    if (!this.activeClip) return null;
    return { el: this.video(this.activeSlot), clip: this.activeClip };
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
      ov.x = kfs.x ? this.curX.eval(kfs.x, s) : undefined;
      ov.y = kfs.y ? this.curY.eval(kfs.y, s) : undefined;
      ov.scale = kfs.scale ? this.curScale.eval(kfs.scale, s) : undefined;
      ov.opacity = kfs.opacity ? this.curOpacity.eval(kfs.opacity, s) : undefined;
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
    this.applyPose(this.set.gen, clip, media, t);
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
        const el = this.assign(this.activeSlot, url);
        this.applyPose(this.boxes(this.activeSlot), clip, media, t);
        this.activeClip = clip;
        this.stillClip = null;
        this.stillMedia = null;
        this.show(this.activeSlot);
        const rate = clip.speed * this.previewSpeed();
        const srcT = sourceTime(clip, t - clip.timelineStart);
        if (playing && !isMaster && el.readyState >= 2) {
          // slave: correct drift against engine time instead of hard-seeking
          const drift = el.currentTime - srcT;
          if (Math.abs(drift) > HARD_RESYNC_SEC) {
            el.currentTime = srcT;
            el.playbackRate = rate;
          } else if (Math.abs(drift) > NUDGE_SEC) {
            el.playbackRate = rate * (drift > 0 ? 0.98 : 1.02);
          } else {
            el.playbackRate = rate;
          }
        } else {
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
    } else if (this.shown === "image" || this.shown === "gen") {
      const clip = this.stillClip;
      if (!clip || clip.keyframes === undefined) return;
      const media = this.stillMedia;
      if (media) this.applyPose(this.shown === "image" ? this.set.image : this.set.gen, clip, media, t);
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

  /** Preload the next real video clip into the inactive slot. */
  preload(t: number): void {
    const next = this.nextVideoClipAfter(t);
    if (!next) return;
    const timeUntil = (next.timelineStart - t) / Math.max(0.25, this.previewSpeed());
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
}

/* ------------------------------------------------------------------ */
/* Generated-media rendering                                           */
/* ------------------------------------------------------------------ */

function generatorKey(mediaId: string, g: Generator): string {
  return g.type === "solid"
    ? `${mediaId}|solid|${g.color}`
    : `${mediaId}|text|${g.text}|${g.fontFamily}|${g.sizePx}|${g.color}|${g.bold}|${g.italic}`;
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
  } else {
    el.style.background = "transparent";
    el.style.color = g.color;
    el.style.whiteSpace = "pre";
    el.style.lineHeight = "1.25";
    const style = g.italic ? "italic" : "normal";
    const weight = g.bold ? "bold" : "normal";
    el.style.font = `${style} ${weight} ${g.sizePx}px ${g.fontFamily}`;
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

  private videoTracks(): Track[] {
    return this.getProject().timeline.tracks.filter((t) => t.kind === "video");
  }

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
    }
    // rebind each live layer to its (possibly new) layer set + track index
    for (let i = 0; i < this.layers.length; i++) {
      const ls = this.layers[i]!;
      if (i < tracks.length) {
        ls.setLayerSet(this.stage.layers[i]!);
        const idx = i;
        ls.setTrack(() => this.videoTracks()[idx]!);
      } else {
        ls.pauseAll();
      }
    }
  }

  private activeLayers(): LayerScheduler[] {
    const n = this.videoTracks().length;
    return this.layers.slice(0, n);
  }

  /** Activate every layer for time t. Returns the nearest segment boundary
   *  (min over layers of each layer's active segment end). */
  activate(t: number, playing: boolean): { boundary: number } {
    this.playing = playing;
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

    let boundary = Infinity;
    let anyReal = false;
    for (let i = 0; i < layers.length; i++) {
      const seg = layers[i]!.activate(t, playing, i === masterIdx);
      const end = segmentEnd(seg);
      if (Number.isFinite(end)) {
        boundary = Math.min(boundary, end);
        anyReal = true;
      }
      // gaps also bound (their `until` is finite when a later clip exists)
    }
    if (!anyReal) boundary = Infinity;
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

  preload(t: number): void {
    for (const layer of this.activeLayers()) layer.preload(t);
  }

  /* ---------------- audio-graph / dev queries ---------------- */

  /** All A/B video elements across every layer (audio graph attaches lazily). */
  videoElements(): HTMLVideoElement[] {
    const out: HTMLVideoElement[] = [];
    for (const layer of this.layers) out.push(...layer.elements());
    return out;
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

  /** Compatibility shim: the topmost active-video info, or null. */
  activeVideoInfo(): VideoInfo | null {
    return this.activeVideoInfos()[0] ?? null;
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
  }
}
