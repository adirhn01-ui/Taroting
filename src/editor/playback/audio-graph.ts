// Web Audio mixing graph. Every audible element — the two preview video
// elements and a pool of hidden <audio> elements for audio-track clips —
// routes through a per-element GainNode into a master bus. Volume, mute,
// normalize gain and fades are gain envelopes (sample-accurate ramps);
// audio-track elements are drift-corrected against the engine clock.

import { clipEnd, locate, sourceTime, timelineTime } from "../../core/time";
import type { Clip, MediaRef, ProjectFile, Track } from "../../core/types";
import type { MediaManager } from "../media/media";
import { slaveRate, type Scheduler } from "./scheduler";

// Simultaneous audio-track voices. Every voice is an <audio> element + a
// MediaElementSource + a GainNode, all allocated EAGERLY in the constructor, so
// the pool is a permanent idle cost paid by every project — including one with
// no audio track at all. Raising it would tax the common case to buy headroom
// for a rare one, which the perf veto forbids. Instead the allocator is
// priority-ordered (see claimVoiceSlot): audible clips claim voices first,
// lookaheads only get what is left over, and an audible clip may reclaim a
// voice a lookahead is squatting on. The pool therefore degrades by dropping
// pre-roll smoothing, never by muting something the user can hear.
const POOL_SIZE = 6;
const LOOKAHEAD_SEC = 1.5;
// Voices are drift-corrected with the scheduler's own three-band test
// (slaveRate, HARD_RESYNC_SEC and NUDGE_SEC in scheduler.ts): one copy of the
// thresholds for every slaved element, video layer or audio voice.

// A video element's active gain envelope is re-armed once its real position
// drifts this far from where its currently-scheduled (time-absolute) envelope
// assumes it to be. Any manual seek / ruler scrub repositions the element off
// its playback trajectory; this catches jumps the 0.3s discontinuity heuristic
// misses. Kept just above HARD_RESYNC_SEC so a legitimately drift-corrected
// slaved layer (bounded to <=HARD_RESYNC_SEC) never triggers a spurious re-arm,
// i.e. zero extra work on healthy continuous playback.
const SEEK_REARM_SEC = 0.15;

/** What a currently-scheduled gain envelope assumes about the thing it is
 *  riding: which clip it was built for, and the (timeline time, AudioContext
 *  time) pair its breakpoints were baked from. Held per video element AND per
 *  audio voice — see envelopeStale. */
interface EnvAnchor {
  clipId: string;
  t0: number;
  ctx0: number;
}

/**
 * Has the playhead moved off the trajectory this envelope was scheduled for?
 *
 * `scheduleEnvelope` bakes its breakpoints into ABSOLUTE AudioContext times
 * from an anchor, so the schedule is only still valid while the thing it drives
 * is where continuous playback from `(t0, ctx0)` would put it. Any manual seek
 * or ruler scrub repositions it off that trajectory and the fade/hold/zero
 * breakpoints then fire at the wrong ctx time — audio that must stay at full
 * gain gets zeroed early and, because nothing re-anchors, stays that way for
 * the rest of the clip. That is the user-reported "scrub the playhead and it
 * goes mute" bug.
 *
 * `pos` is the observed timeline position of whatever the envelope rides: for a
 * video element that is its own currentTime mapped back to the timeline (the
 * element IS the master clock, so it is the truth); for an audio-track voice it
 * is the engine time `t` (the voice is drift-slaved to the engine, so the
 * engine clock is the truth, and reading it avoids catching a mid-nudge
 * element).
 *
 * This ALSO covers a preview-speed change, which the 0.3 s discontinuity test
 * cannot see: `at()` maps timeline seconds to ctx seconds through `speed`, so
 * every future breakpoint of an envelope scheduled at the old speed is at the
 * wrong ctx time, and the divergence this measures grows from the anchor at the
 * rate of the speed delta until it trips.
 *
 * Kept as one exported pure function precisely because the guard was previously
 * inlined at one of its two call sites and simply missing at the other.
 */
export function envelopeStale(
  env: { t0: number; ctx0: number },
  pos: number,
  ctxNow: number,
  previewSpeed: number,
): boolean {
  const speed = Math.max(0.25, previewSpeed);
  const expected = env.t0 + (ctxNow - env.ctx0) * speed;
  return Math.abs(pos - expected) > SEEK_REARM_SEC;
}

interface Voice {
  el: HTMLAudioElement;
  gain: GainNode;
  clipId: string | null;
  url: string | null;
  /** What this voice's scheduled envelope assumes; null when it has none (a
   *  parked voice is zeroed outright). Same role as `videoEnv` below. */
  env: EnvAnchor | null;
}

/** One clip the mixer wants a voice for on this tick. `active` = it is audible
 *  right now; `false` = it is only pre-rolled lookahead. */
interface WantedClip {
  clip: Clip;
  track: Track;
  active: boolean;
}

/** One step of a gain envelope, in TIMELINE seconds: `set` jumps to `value` at
 *  `at`; `ramp` moves linearly to `value`, arriving at `at`, from wherever the
 *  previous step left off — exactly AudioParam's setValueAtTime and
 *  linearRampToValueAtTime, which scheduleEnvelope maps them onto. */
export interface EnvelopeStep {
  kind: "set" | "ramp";
  at: number;
  value: number;
}

/**
 * A clip's gain envelope from timeline time `t` onwards: its volume `base`
 * shaped by the fade-in and fade-out, then silence at the clip's end. Pure, in
 * timeline time; scheduleEnvelope maps it into AudioContext time.
 *
 * The first step is always the value at `t` itself. Everything after it is
 * built so the AudioParam's piecewise-linear output IS the fade curve the
 * export renders:
 *
 *  - The clip starts at `start` INCLUSIVE. Treating `t == start` as outside
 *    silenced a clip with a fade-out but no fade-in until its fade-out began —
 *    reached by every play from a clip's first frame, every cut and the right
 *    half of every split.
 *  - Armed early (a lookahead, `t < start`), the envelope first steps to its
 *    start value AT `start`. Without that step the first ramp ran from `t`, so
 *    a fade-in began up to 1.5 s before the clip did.
 *  - Every interior breakpoint is a ramp to the true curve value there. The
 *    old schedule jumped to the full volume where the fade-out begins, which
 *    is a step whenever the two fades overlap and the fade-in is still short
 *    of full there; in an overlap the curve's peak (the midpoint of the clip,
 *    when it falls inside the overlap) is sampled too, so the ramps rise to it
 *    and fall away from it.
 *  - At the end, a fade-out ramps to 0; with no fade-out the volume holds and
 *    then steps to 0. Ramping to 0 there would turn the last stretch of every
 *    unfaded clip into a fade.
 */
export function envelopeBreakpoints(clip: Clip, base: number, t: number): EnvelopeStep[] {
  const start = clip.timelineStart;
  const end = clipEnd(clip);
  const fadeIn = Math.max(0, Math.min(clip.audio.fadeInSec, end - start));
  const fadeOut = Math.max(0, Math.min(clip.audio.fadeOutSec, end - start));
  const inEnd = start + fadeIn;
  const outStart = end - fadeOut;

  const valueAt = (x: number): number => {
    if (x < start || x >= end) return 0;
    let v = base;
    if (fadeIn > 0 && x < inEnd) v *= (x - start) / fadeIn;
    if (fadeOut > 0 && x > outStart) v *= (end - x) / fadeOut;
    return v;
  };

  const steps: EnvelopeStep[] = [{ kind: "set", at: t, value: valueAt(t) }];
  if (t >= end) return steps;
  if (t < start) steps.push({ kind: "set", at: start, value: valueAt(start) });

  const points: number[] = [];
  if (fadeIn > 0) points.push(inEnd);
  if (fadeOut > 0) points.push(outStart);
  if (fadeIn > 0 && fadeOut > 0 && outStart < inEnd) {
    // In the overlap the gain is base·(x-start)/fadeIn·(end-x)/fadeOut, a
    // parabola peaking at the clip's midpoint. When the midpoint falls outside
    // the overlap the curve is monotonic across it, and the overlap's two ends
    // (already breakpoints) describe it.
    const peak = (start + end) / 2;
    if (peak > outStart && peak < inEnd) points.push(peak);
  }
  points.sort((a, b) => a - b);
  let last = Math.max(t, start);
  for (const p of points) {
    // strictly inside (last, end): skips the past, the end and duplicates
    if (p <= last || p >= end) continue;
    steps.push({ kind: "ramp", at: p, value: valueAt(p) });
    last = p;
  }

  if (fadeOut > 0) {
    steps.push({ kind: "ramp", at: end, value: 0 });
  } else {
    // A fade-in spanning the whole clip has no interior breakpoint (its end IS
    // the clip's end), so its ramp to full volume goes here, before the step.
    if (fadeIn > 0 && inEnd >= end) steps.push({ kind: "ramp", at: end, value: base });
    steps.push({ kind: "set", at: end, value: 0 });
  }
  return steps;
}

/** The project media with this id. A plain loop rather than `find`: it runs
 *  for every wanted audio clip on every playing tick, and a predicate closure
 *  per call is garbage per frame. */
function mediaById(project: ProjectFile, id: string): MediaRef | undefined {
  const media = project.media;
  for (let i = 0; i < media.length; i++) {
    if (media[i]!.id === id) return media[i];
  }
  return undefined;
}

/**
 * Pick the pool slot a clip should play through — the whole voice-allocation
 * policy, kept pure and DOM-free (it only reads `clipId`s) so it is testable
 * without an AudioContext.
 *
 * Order of preference:
 *  1. the slot already holding this clip (keeps playback continuous);
 *  2. any free slot;
 *  3. **only for an audible clip**, a slot a lookahead is squatting on.
 *
 * Rule 3 is not optional. Voice ownership persists across ticks, so with more
 * audio tracks than half the pool an earlier track's LOOKAHEAD could take the
 * last slot and keep it — and a clip that became audible under it afterwards
 * would stay silent for its entire duration (preview only; export is built
 * from the project, not from this pool, so the bug reads as "preview audio
 * randomly missing"). Sacrificing pre-roll for something the user can hear is
 * always the right trade.
 *
 * Returns null when every slot is already carrying audible audio — at that
 * point there is genuinely nothing to give up.
 */
export function claimVoiceSlot<V extends { clipId: string | null }>(
  voices: readonly V[],
  clipId: string,
  active: boolean,
  isLookahead: (heldClipId: string) => boolean,
): V | null {
  let free: V | null = null;
  let squatter: V | null = null;
  for (const v of voices) {
    if (v.clipId === clipId) return v;
    if (v.clipId === null) {
      free ??= v;
    } else if (active && squatter === null && isLookahead(v.clipId)) {
      squatter = v;
    }
  }
  return free ?? squatter;
}

function clipBaseGain(clip: Clip, track: Track): number {
  if (clip.audio.muted || clip.audio.detached || track.muted) return 0;
  return (
    Math.max(0, clip.audio.volume) * Math.pow(10, clip.audio.gainOffsetDb / 20)
  );
}

// The monitor-volume state machine lives in core (the viewer drives it too,
// and must not import the editor). Re-exported so this module's existing
// importers — and src/editor/playback/monitor-volume.test.ts — stay unchanged.
export { makeMonitorVolume, setMonitorLevel, toggleMonitorMute } from "../../core/monitor-volume";
export type { MonitorVolumeState } from "../../core/monitor-volume";
// The same total sanitizer, applied independently by setMonitorVolume below.
import { clampMonitorLevel as clampVol } from "../../core/monitor-volume";

/**
 * True only while the in-app E2E harness is driving the app. The flag is
 * stamped on `window` by a webview initialization script that the Rust side
 * registers ONLY when `TAROTING_AUTOTEST=1` (see `autotest_flag_plugin` in
 * `src-tauri/src/main.rs`); it runs before any module of ours, so this is a
 * synchronous property read — no IPC, nothing async, nothing in a hot path.
 *
 * `import.meta.env.DEV` is checked first so the whole branch is dead code a
 * production bundle drops: a shipped build can never reach the `window` read,
 * let alone skip the destination connection. The `typeof window` guard keeps
 * the module importable from the node-environment unit tests.
 */
function autotestSilentOutput(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    (window as unknown as { __tarotingAutotest?: boolean }).__tarotingAutotest === true
  );
}

export class AudioGraph {
  private ctx: AudioContext;
  private master: GainNode;
  private voices: Voice[] = [];
  // video-element gains are attached LAZILY (createMediaElementSource is
  // one-shot per element; new layers appear over time). The WeakMap lets parked
  // elements be GC'd if a set is ever dropped.
  private videoGains = new WeakMap<HTMLVideoElement, GainNode>();
  // Per video element: what its CURRENTLY-scheduled gain envelope assumes.
  //  - clipId: which clip the envelope is for. Cleared (map entry deleted) when
  //    the element is zeroed (goes inactive) so its NEXT activation always
  //    re-arms — even on a tick with no discontinuity (fresh file load whose
  //    element becomes ready a few ticks after play, a post-buffering readyState
  //    blip, or an A/B double-buffer swap crossing a cut boundary).
  //  - t0/ctx0: the timeline time and AudioContext time at which the envelope
  //    was scheduled. The envelope is time-ABSOLUTE (breakpoints baked into ctx
  //    time from that anchor), so it is only still valid while the element is
  //    where continuous playback from (t0, ctx0) would put it. After ANY manual
  //    seek / ruler scrub (even a sub-0.3s jump that is NOT a discontinuity, and
  //    even one that keeps the element "ready" so it never drops out) the
  //    element's real position diverges from that trajectory → stale envelope
  //    (its fade/hold/zero breakpoints fire at the wrong ctx time, muting audio
  //    that must stay full). syncVideoGain re-arms when that divergence exceeds
  //    SEEK_REARM_SEC, catching every seek size the discontinuity heuristic and
  //    the drop-out/re-enter dance miss. See syncVideoGain and envelopeStale.
  private videoEnv = new WeakMap<HTMLVideoElement, EnvAnchor>();
  // Per-tick scratch, reused rather than reallocated on every frame: the set
  // of elements active this tick, and the clips wanted this tick (the map plus
  // a pool of its records).
  private activeEls = new Set<HTMLVideoElement>();
  private wanted = new Map<string, WantedClip>();
  private wantedPool: WantedClip[] = [];
  /** claimVoiceSlot's lookahead test against this tick's `wanted`; one
   *  closure for the graph's lifetime instead of one per tick. */
  private readonly isLookahead = (heldClipId: string): boolean =>
    this.wanted.get(heldClipId)?.active === false;
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
    // Under the in-app E2E harness the master bus is deliberately left
    // UNCONNECTED from ctx.destination, so a test run is silent on the
    // developer's speakers while it plays fixtures.
    //
    // This is lossless for every audio assertion, and the reason is subtle
    // enough to be worth spelling out so nobody "fixes" it back: the harness
    // measures audio through devMasterAnalyser()/devMasterRms(), which do
    // `this.master.connect(analyser)` — a SEPARATE fan-out off `master`, not a
    // tap on `destination`. A Web Audio node feeds every one of its outputs
    // independently, so the analyser sees the identical signal whether or not
    // the speakers are also connected. The `embedded-audio` block therefore
    // measures exactly what it measured before.
    //
    // Note this is the ONLY lossless way to silence the run: `master.gain` IS
    // the monitor volume and the analyser taps POST that gain, so muting the
    // monitor instead would zero the measurement and quietly gut the block.
    //
    // A release build never evaluates the flag (see autotestSilentOutput) and
    // connects to the destination exactly as it always has.
    if (!autotestSilentOutput()) this.master.connect(this.ctx.destination);

    for (let i = 0; i < POOL_SIZE; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      this.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.master);
      this.voices.push({ el, gain, clipId: null, url: null, env: null });
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
    const infos = this.scheduler.activeVideoScratch();
    const active = this.activeEls;
    active.clear();
    for (const info of infos) active.add(info.el);
    const elements = this.scheduler.videoElements();
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      if (active.has(el)) continue;
      // No envelope means already zeroed (or never attached, which is silent
      // already with no source to make): an element only gains an envelope by
      // being armed below, and loses it right here, as it is zeroed. Zeroing it
      // again on every tick it stays inactive rewrote its AudioParam timeline
      // once a frame for nothing.
      if (!this.videoEnv.has(el)) continue;
      const gain = this.videoGains.get(el);
      if (!gain) continue;
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.setValueAtTime(0, this.ctx.currentTime);
      // it went inactive — force its next activation to re-arm the envelope.
      this.videoEnv.delete(el);
    }
    for (const info of infos) {
      const gain = this.videoGain(info.el);
      // Re-arm the envelope when it is not provably current for this element's
      // ACTUAL state:
      //  (1) discontinuity — seek >0.3s / pause↔play / project change;
      //  (2) the scheduled envelope is for a DIFFERENT clip (or none yet) — the
      //      element just became active/ready, or an A/B swap crossed a cut;
      //  (3) the element's real position has diverged from where its scheduled
      //      (time-absolute) envelope assumes it to be — i.e. a manual seek /
      //      ruler scrub of ANY size (including sub-0.3s jumps that are not a
      //      discontinuity and that keep the element "ready" so it never drops
      //      out and re-enters). Without (3) a stale envelope's hold/zero/fade
      //      breakpoints fire at the wrong ctx time and the audio mutes — the
      //      user-reported "scrub the playhead and it goes mute" bug.
      const env = this.videoEnv.get(info.el);
      let rearm = discontinuity || !env || env.clipId !== info.clip.id;
      if (!rearm && env) {
        // where the element actually is (derived from currentTime) vs. where
        // continuous playback from the schedule anchor would put it.
        const actual = timelineTime(info.clip, info.el.currentTime);
        if (envelopeStale(env, actual, this.ctx.currentTime, previewSpeed)) rearm = true;
      }
      if (rearm) {
        this.scheduleEnvelope(gain, info.clip, info.track, t, previewSpeed);
        this.videoEnv.set(info.el, {
          clipId: info.clip.id,
          t0: t,
          ctx0: this.ctx.currentTime,
        });
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
    const wanted = this.wanted;
    wanted.clear();
    let used = 0;
    const tracks = project.timeline.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!;
      if (track.kind !== "audio") continue;
      const here = locate(track, t);
      if (here.kind === "clip") this.want(used++, here.clip, track, true);
      const ahead = locate(track, t + lookahead);
      if (ahead.kind === "clip" && !wanted.has(ahead.clip.id)) {
        this.want(used++, ahead.clip, track, false);
      }
    }

    // release voices whose clip is no longer relevant
    for (const voice of this.voices) {
      if (voice.clipId && !wanted.has(voice.clipId)) this.parkVoice(voice);
    }

    // Allocate in TWO passes, audible clips first. `wanted` is filled in track
    // order with up to two entries per track (the playing clip AND its
    // lookahead), so a single ordered pass let track 1's pre-roll take the slot
    // track 4's PLAYING clip needed. The lookahead test is the instance's
    // `isLookahead`, which reads this same map.
    for (let pass = 0; pass < 2; pass++) {
      const wantActive = pass === 0;
      for (const { clip, track, active } of wanted.values()) {
        if (active !== wantActive) continue;
        const media = mediaById(project, clip.mediaId);
        if (!media) continue;
        const status = this.media.status.get()[media.id];
        if (status?.state !== "ready") continue;

        const voice = claimVoiceSlot(this.voices, clip.id, active, this.isLookahead);
        if (!voice) continue; // pool exhausted — every slot is already audible
        const fresh = voice.clipId !== clip.id;
        // Reclaimed from a lookahead: stop it and drop its envelope before
        // this clip takes over the element.
        if (fresh && voice.clipId !== null) this.parkVoice(voice);

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
          // A fresh voice is always seeked. Otherwise the shared three-band
          // test: re-seek past HARD_RESYNC_SEC, an inaudible ±2% nudge until
          // converged, the base rate once in sync.
          const next = fresh ? null : slaveRate(drift, rate);
          if (next === null) {
            voice.el.currentTime = expected;
            voice.el.playbackRate = rate;
          } else {
            voice.el.playbackRate = next;
          }
          if (voice.el.paused) void voice.el.play().catch(() => {});
        } else {
          if (!voice.el.paused) voice.el.pause();
          if (fresh || Math.abs(voice.el.currentTime - expected) > 0.05) {
            voice.el.currentTime = expected;
          }
        }

        // Re-arm on exactly the conditions the video path uses — this is the
        // SAME guard, and it was missing here. `fresh || discontinuity` alone
        // leaves a band wide open: a ruler scrub during playback (timeline.seek
        // → engine.seek, which does not pause) steps 0.12-0.3 s at a time,
        // which is past HARD_RESYNC_SEC above — so the element jumps — but
        // under the 0.3 s discontinuity bar, so the time-absolute envelope
        // stayed anchored to the pre-scrub trajectory and fired its zero/fade
        // breakpoints early. Scrubbing backwards therefore silenced the clip
        // for the rest of its run, and nothing self-corrected until a >0.3 s
        // jump, a pause or a project edit. The divergence accumulates across
        // ticks (the anchor is only moved by a re-arm), so even a run of steps
        // individually under the bar trips it within a few frames.
        const env = voice.env;
        let rearm = fresh || discontinuity || env === null || env.clipId !== clip.id;
        // Only worth asking while the transport runs: paused, the element is
        // paused and inaudible whatever its gain says, and the resume is a
        // playing-flag discontinuity that re-arms everything anyway. Skipping
        // it keeps a paused refresh (media.status fires ~10x/s during a job)
        // from rescheduling six envelopes for nothing.
        if (!rearm && playing && env !== null) {
          rearm = envelopeStale(env, t, this.ctx.currentTime, previewSpeed);
        }
        if (rearm) {
          this.scheduleEnvelope(voice.gain, clip, track, t, previewSpeed);
          voice.env = { clipId: clip.id, t0: t, ctx0: this.ctx.currentTime };
        }
      }
    }
  }

  /** Record one wanted clip for this tick in pooled record `slot`. */
  private want(slot: number, clip: Clip, track: Track, active: boolean): void {
    let rec = this.wantedPool[slot];
    if (rec === undefined) {
      rec = { clip, track, active };
      this.wantedPool.push(rec);
    } else {
      rec.clip = clip;
      rec.track = track;
      rec.active = active;
    }
    this.wanted.set(clip.id, rec);
  }

  /** Park a voice: stop its element, forget its clip and zero its gain now. */
  private parkVoice(voice: Voice): void {
    voice.el.pause();
    voice.clipId = null;
    // The envelope is gone with it, so the voice's next claim always re-arms —
    // mirroring `videoEnv.delete(el)` when an element goes inactive.
    voice.env = null;
    voice.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    voice.gain.gain.setValueAtTime(0, this.ctx.currentTime);
  }

  /* ---------------- gain envelopes (volume + fades) ---------------- */

  /** Schedule the clip's gain from timeline time `t` forward: the envelope
   *  envelopeBreakpoints describes, mapped into AudioContext time. Runs only
   *  when an envelope is (re-)armed, never per tick. */
  private scheduleEnvelope(
    gain: GainNode,
    clip: Clip,
    track: Track,
    t: number,
    previewSpeed: number,
  ): void {
    const now = this.ctx.currentTime;
    const speed = Math.max(0.25, previewSpeed);
    const g = gain.gain;
    g.cancelScheduledValues(now);
    for (const step of envelopeBreakpoints(clip, clipBaseGain(clip, track), t)) {
      const at = now + Math.max(0, (step.at - t) / speed);
      if (step.kind === "set") g.setValueAtTime(step.value, at);
      else g.linearRampToValueAtTime(step.value, at);
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

  /* ---------------- dev/E2E-only measurement hooks ---------------- */
  // These allocate nothing and are never referenced by production code paths;
  // the analyser is created lazily on first harness call, so a shipped build
  // that never calls them pays exactly zero cost.

  private devTap: AnalyserNode | null = null;

  /** DEV ONLY: an AnalyserNode tapping the master bus (post monitor gain), so a
   *  test can measure REAL output energy at the point that feeds the speakers.
   *  Fan-out only (never wired to destination) — it cannot alter audible output. */
  devMasterAnalyser(): AnalyserNode {
    if (!this.devTap) {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      this.master.connect(a);
      this.devTap = a;
    }
    return this.devTap;
  }

  /** DEV ONLY: root-mean-square amplitude of the current master-bus quantum
   *  (0 when silent). Requires the AudioContext to be running. */
  devMasterRms(): number {
    const a = this.devMasterAnalyser();
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    return Math.sqrt(sum / buf.length);
  }

  /** DEV ONLY: resume the AudioContext and report whether it actually runs
   *  (headless harnesses may lack the user activation autoplay needs). */
  async devEnsureRunning(): Promise<boolean> {
    // ctx.state is a live getter (resume() can flip it), so read it through a
    // helper to keep TS from narrowing "running" out of later checks.
    const running = (): boolean => String(this.ctx.state) === "running";
    for (let i = 0; i < 20; i++) {
      if (running()) return true;
      try {
        await this.ctx.resume();
      } catch {
        /* no user activation — fall through */
      }
      if (running()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return running();
  }

  /** DEV ONLY: is this video element routed through the WebAudio graph (its
   *  embedded audio goes through a per-element GainNode, NOT the default output)? */
  devVideoWired(el: HTMLVideoElement): boolean {
    return this.videoGains.has(el);
  }

  /** DEV ONLY: the live scheduled gain value on a wired video element (the
   *  envelope output feeding the master bus); 0 if the element is not wired. */
  devVideoGainValue(el: HTMLVideoElement): number {
    return this.videoGains.get(el)?.gain.value ?? 0;
  }

  dispose(): void {
    for (const v of this.voices) {
      v.el.pause();
      v.el.src = "";
    }
    void this.ctx.close();
  }
}
