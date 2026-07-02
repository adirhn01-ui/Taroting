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

export class AudioGraph {
  private ctx: AudioContext;
  private master: GainNode;
  private voices: Voice[] = [];
  private videoGains = new Map<HTMLVideoElement, GainNode>();
  private lastT = -1;
  private lastPlaying = false;
  private lastProject: ProjectFile | null = null;
  private maxDrift = 0;

  constructor(
    private getProject: () => ProjectFile,
    private media: MediaManager,
    private scheduler: Scheduler,
  ) {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    for (const el of scheduler.videoElements()) {
      const gain = this.ctx.createGain();
      this.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.master);
      // gains own loudness from here on; the element stays neutral
      el.volume = 1;
      el.muted = false;
      this.videoGains.set(el, gain);
    }

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

  private syncVideoGain(
    t: number,
    project: ProjectFile,
    discontinuity: boolean,
    previewSpeed: number,
  ): void {
    const active = this.scheduler.activeVideoInfo();
    for (const [el, gain] of this.videoGains) {
      if (active && el === active.el) {
        const track = project.timeline.tracks[0]!;
        if (discontinuity) {
          this.scheduleEnvelope(gain, active.clip, track, t, previewSpeed);
        }
      } else {
        gain.gain.cancelScheduledValues(this.ctx.currentTime);
        gain.gain.setValueAtTime(0, this.ctx.currentTime);
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
