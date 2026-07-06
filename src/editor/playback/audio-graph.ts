// Web Audio mixing graph. Every audible element — the two preview video
// elements and a pool of hidden <audio> elements for audio-track clips —
// routes through a per-element GainNode into a master bus. Volume, mute,
// normalize gain and fades are gain envelopes (sample-accurate ramps);
// audio-track elements are drift-corrected against the engine clock.

import { clipEnd, locate, sourceTime } from "../../core/time";
import type { Clip, ProjectFile, Track } from "../../core/types";
import type { MediaManager } from "../media/media";
import type { Scheduler } from "./scheduler";

const POOL_SIZE = 6;
const LOOKAHEAD_SEC = 1.5;
const HARD_RESYNC_SEC = 0.12;
const NUDGE_SEC = 0.04;

interface Voice {
  el: HTMLAudioElement;
  gain: GainNode;
  clipId: string | null;
  url: string | null;
}

function clipBaseGain(clip: Clip, track: Track): number {
  if (clip.audio.muted || clip.audio.detached || track.muted) return 0;
  return (
    Math.max(0, clip.audio.volume) * Math.pow(10, clip.audio.gainOffsetDb / 20)
  );
}

/** Pure state for the monitor-volume control shared by the transport and
 *  theater bars. `level` is the live 0..1 value; `lastNonZero` is what a mute
 *  toggle restores to (seeded to 1 so an un-mute from a fresh 0 still makes
 *  sound). Both UIs drive this identically; it holds no DOM/audio references. */
export interface MonitorVolumeState {
  level: number;
  lastNonZero: number;
}

// Total sanitizer: coerce anything (numeric string, NaN, null, boolean, …)
// with Number(); a non-finite result falls back to the safe default 1 (a
// corrupted persisted level must never blank the editor), then clamp to 0..1.
const clampVol = (v: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
};

/** Seed the state machine from a persisted level (clamped). */
export function makeMonitorVolume(initial: number): MonitorVolumeState {
  const level = clampVol(initial);
  return { level, lastNonZero: level > 0 ? level : 1 };
}

/** User dragged the slider to `v`. Clamps; a non-zero value becomes the new
 *  restore point. Returns the next state (does not mutate the input). */
export function setMonitorLevel(s: MonitorVolumeState, v: number): MonitorVolumeState {
  const level = clampVol(v);
  return { level, lastNonZero: level > 0 ? level : s.lastNonZero };
}

/** Speaker click: mute if audible, else restore the last non-zero level. */
export function toggleMonitorMute(s: MonitorVolumeState): MonitorVolumeState {
  if (s.level > 0) return { level: 0, lastNonZero: s.level };
  return { level: s.lastNonZero, lastNonZero: s.lastNonZero };
}

export class AudioGraph {
  private ctx: AudioContext;
  private master: GainNode;
  private voices: Voice[] = [];
  // video-element gains are attached LAZILY (createMediaElementSource is
  // one-shot per element; new layers appear over time). The WeakMap lets parked
  // elements be GC'd if a set is ever dropped.
  private videoGains = new WeakMap<HTMLVideoElement, GainNode>();
  private lastT = -1;
  private lastPlaying = false;
  private lastProject: ProjectFile | null = null;
  private maxDrift = 0;

  private monitor = 1;

  constructor(
    private getProject: () => ProjectFile,
    private media: MediaManager,
    private scheduler: Scheduler,
  ) {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    for (let i = 0; i < POOL_SIZE; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      this.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.master);
      this.voices.push({ el, gain, clipId: null, url: null });
    }
  }

  /* ---------------- monitor (preview listening) volume ---------------- */

  // The master bus scales EVERYTHING (per-element gains → master → destination),
  // so this is a pure monitor level: it never touches per-clip audio, the
  // project, or exports. Only written on user input — no per-frame cost.

  /** Preview listening level, 0..1. */
  get monitorVolume(): number {
    return this.monitor;
  }

  /** Set the preview listening level (clamped 0..1). A short setTargetAtTime
   *  ramp avoids the zipper noise a step change to master.gain would produce. */
  setMonitorVolume(v: number): void {
    // Independent guard: even if a non-finite value reaches this path, never
    // let it through to setTargetAtTime (it would throw synchronously).
    this.monitor = clampVol(v);
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this.monitor, now, 0.015);
  }

  /** Main sync entry — called from the engine on every tick/seek/pause. */
  tick(t: number, playing: boolean, previewSpeed: number): void {
    if (playing && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    const project = this.getProject();
    const discontinuity =
      Math.abs(t - this.lastT) > 0.3 ||
      playing !== this.lastPlaying ||
      project !== this.lastProject;
    this.lastT = t;
    this.lastPlaying = playing;
    this.lastProject = project;

    this.syncVideoGain(t, project, discontinuity, previewSpeed);
    this.syncAudioTracks(t, playing, previewSpeed, project, discontinuity);
  }

  /* ---------------- video embedded audio ---------------- */

  /** The gain node for a preview video element, created (and wired) on first
   *  use. createMediaElementSource is one-shot per element, so this must be the
   *  only place a source is created for `el`. */
  private videoGain(el: HTMLVideoElement): GainNode {
    let gain = this.videoGains.get(el);
    if (!gain) {
      gain = this.ctx.createGain();
      gain.gain.value = 0;
      this.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.master);
      // gains own loudness from here on; the element stays neutral
      el.volume = 1;
      el.muted = false;
      this.videoGains.set(el, gain);
    }
    return gain;
  }

  private syncVideoGain(
    t: number,
    _project: ProjectFile,
    discontinuity: boolean,
    previewSpeed: number,
  ): void {
    // Embedded audio from EVERY active video layer mixes (matching export).
    // Zero every element we've touched, then schedule the active ones with
    // their own track's envelope.
    const infos = this.scheduler.activeVideoInfos();
    const active = new Set(infos.map((i) => i.el));
    for (const el of this.scheduler.videoElements()) {
      if (active.has(el)) continue;
      const gain = this.videoGains.get(el);
      if (!gain) continue; // never attached → silent already, no source to make
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
    for (const info of infos) {
      const gain = this.videoGain(info.el);
      if (discontinuity) {
        this.scheduleEnvelope(gain, info.clip, info.track, t, previewSpeed);
      }
    }
  }

  /* ---------------- audio-track clips ---------------- */

  private syncAudioTracks(
    t: number,
    playing: boolean,
    previewSpeed: number,
    project: ProjectFile,
    discontinuity: boolean,
  ): void {
    const lookahead = LOOKAHEAD_SEC * Math.max(0.25, previewSpeed);
    const wanted = new Map<string, { clip: Clip; track: Track; active: boolean }>();

    for (const track of project.timeline.tracks) {
      if (track.kind !== "audio") continue;
      const here = locate(track, t);
      if (here.kind === "clip") {
        wanted.set(here.clip.id, { clip: here.clip, track, active: true });
      }
      const ahead = locate(track, t + lookahead);
      if (ahead.kind === "clip" && !wanted.has(ahead.clip.id)) {
        wanted.set(ahead.clip.id, { clip: ahead.clip, track, active: false });
      }
    }

    // release voices whose clip is no longer relevant
    for (const voice of this.voices) {
      if (voice.clipId && !wanted.has(voice.clipId)) {
        voice.el.pause();
        voice.clipId = null;
        voice.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        voice.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
    }

    for (const { clip, track, active } of wanted.values()) {
      const media = project.media.find((m) => m.id === clip.mediaId);
      if (!media) continue;
      const status = this.media.status.get()[media.id];
      if (status?.state !== "ready") continue;

      let voice = this.voices.find((v) => v.clipId === clip.id) ?? null;
      const fresh = voice === null;
      if (!voice) voice = this.voices.find((v) => v.clipId === null) ?? null;
      if (!voice) continue; // pool exhausted — more than 6 simultaneous clips

      voice.clipId = clip.id;
      if (voice.url !== status.url) {
        voice.url = status.url;
        voice.el.src = status.url;
      }

      const rate = clip.speed * previewSpeed;
      const expected = active
        ? sourceTime(clip, t - clip.timelineStart)
        : clip.srcIn;

      if (active && playing) {
        const drift = voice.el.currentTime - expected;
        // observe drift on already-running voices (a fresh voice hasn't been
        // seeked to `expected` yet, so its "drift" is not meaningful)
        if (!fresh) this.maxDrift = Math.max(this.maxDrift, Math.abs(drift));
        if (fresh || Math.abs(drift) > HARD_RESYNC_SEC) {
          voice.el.currentTime = expected;
          voice.el.playbackRate = rate;
        } else if (Math.abs(drift) > NUDGE_SEC) {
          // inaudible ±2% nudge until converged
          voice.el.playbackRate = rate * (drift > 0 ? 0.98 : 1.02);
        } else {
          voice.el.playbackRate = rate;
        }
        if (voice.el.paused) void voice.el.play().catch(() => {});
      } else {
        if (!voice.el.paused) voice.el.pause();
        if (fresh || Math.abs(voice.el.currentTime - expected) > 0.05) {
          voice.el.currentTime = expected;
        }
      }

      if (fresh || discontinuity) {
        this.scheduleEnvelope(voice.gain, clip, track, t, previewSpeed);
      }
    }
  }

  /* ---------------- gain envelopes (volume + fades) ---------------- */

  /** Schedule the clip's gain from timeline time `t` forward: current value
   *  now, then the fade-in/fade-out ramps mapped into AudioContext time. */
  private scheduleEnvelope(
    gain: GainNode,
    clip: Clip,
    track: Track,
    t: number,
    previewSpeed: number,
  ): void {
    const base = clipBaseGain(clip, track);
    const now = this.ctx.currentTime;
    const start = clip.timelineStart;
    const end = clipEnd(clip);
    const fadeIn = Math.min(clip.audio.fadeInSec, end - start);
    const fadeOut = Math.min(clip.audio.fadeOutSec, end - start);
    const speed = Math.max(0.25, previewSpeed);
    const at = (timelineT: number): number => now + Math.max(0, (timelineT - t) / speed);

    const valueAt = (timelineT: number): number => {
      if (timelineT <= start || timelineT >= end) return 0;
      let v = base;
      if (fadeIn > 0 && timelineT < start + fadeIn) {
        v *= (timelineT - start) / fadeIn;
      }
      if (fadeOut > 0 && timelineT > end - fadeOut) {
        v *= (end - timelineT) / fadeOut;
      }
      return v;
    };

    const g = gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(valueAt(t), now);
    // future breakpoints from t: end of fade-in, start of fade-out, end
    if (fadeIn > 0 && t < start + fadeIn) {
      g.linearRampToValueAtTime(base, at(start + fadeIn));
    }
    if (fadeOut > 0 && end - fadeOut > t) {
      g.setValueAtTime(base, at(end - fadeOut));
    }
    if (fadeOut > 0 && t < end) {
      g.linearRampToValueAtTime(0, at(end));
    } else if (t < end) {
      g.setValueAtTime(base, at(Math.max(t, start + fadeIn)));
      g.setValueAtTime(0, at(end));
    }
  }

  /* ---------------- drift instrumentation (dev/soak tests) ---------------- */

  /** Largest absolute A/V drift (seconds) observed on active playing voices
   *  since the last reset — measured before any correction is applied. */
  maxObservedDriftSec(): number {
    return this.maxDrift;
  }

  /** Reset the drift high-water mark (call at the start of a soak test). */
  resetDriftStats(): void {
    this.maxDrift = 0;
  }

  dispose(): void {
    for (const v of this.voices) {
      v.el.pause();
      v.el.src = "";
    }
    void this.ctx.close();
  }
}
