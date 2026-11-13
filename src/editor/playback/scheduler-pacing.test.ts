// The seek pacing wired into the real Scheduler and PlaybackEngine, over the
// fakes in test-fakes.ts. What each drag seek is caused by comes from the
// fake pacing deps (`kind`), the way a pointerdown / pointermove being
// dispatched says it in the app.
//
// The heavy fixture: clip A on the timeline [3, 13] (srcIn 1.5, speed 2, so a
// timeline second is two source seconds and the source and timeline times
// never coincide), keyframes every 2.5 s, an exact seek 0.8 s and a seek onto
// a keyframe 4 ms. Clip B (a different media) follows on [13, 27].

import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyframeIndex } from "../../core/ipc";
import { sourceTime } from "../../core/time";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";
import type { MediaState } from "../media/media";
import { AudioGraph } from "./audio-graph";
import { PlaybackEngine } from "./engine";
import { Scheduler } from "./scheduler";
import { HOLD_SETTLE_MS, REST_MS, type PacingDev } from "./seek-pacing";
import {
  clipOf,
  fakeMedia,
  fakePacingDeps,
  fakeStage,
  FakeVideo,
  manualFrames,
  projectOf,
  readyStatus,
  type FakePacing,
} from "./test-fakes";

const KEYS = Array.from({ length: 17 }, (_, i) => i * 2.5);
const HEAVY_IX: KeyframeIndex = { allSync: false, times: KEYS, duration: 40, bytes: 150_000_000 };
const LIGHT_IX: KeyframeIndex = { ...HEAVY_IX, bytes: 1_000_000 };
/** 30 Mbit/s over 40 s: a candidate by bit rate. */
const BIG = 150_000_000;
/** 1 Mbit/s: light by bit rate, never indexed. */
const SMALL = 5_000_000;
const EXACT_S = 0.8;
const KEY_S = 0.004;

const onKey = (t: number): boolean => KEYS.some((k) => Math.abs(k - t) < 1e-9);
const latency = (t: number): number => (onKey(t) ? KEY_S : EXACT_S);

let nextName = 0;
function vid(name: string, size: number): MediaRef {
  return {
    id: `pm-${name}-${nextName++}`,
    path: `C:\\media\\${name}.mp4`,
    kind: "video",
    duration: 40,
    size,
    width: 640,
    height: 360,
    hasAudio: false,
  } as MediaRef;
}

function statuses(...media: MediaRef[]): Record<string, MediaState> {
  const out: Record<string, MediaState> = {};
  for (const m of media) out[m.id] = readyStatus(m);
  return out;
}

interface Rig {
  frames: ReturnType<typeof manualFrames>;
  pd: FakePacing;
  stage: ReturnType<typeof fakeStage>;
  media: ReturnType<typeof fakeMedia>;
  sched: Scheduler;
  engine: PlaybackEngine;
  holder: { p: ProjectFile };
  emits: Array<[number, boolean]>;
  dev: PacingDev;
  lat: (t: number) => number;
  graph: AudioGraph | null;
}

const open: Rig[] = [];

function rig(
  project: ProjectFile,
  st: Record<string, MediaState>,
  opts: { disabled?: boolean; forceOnly?: string; lat?: (t: number) => number; audio?: boolean } = {},
): Rig {
  const frames = manualFrames();
  const pd = fakePacingDeps(() => frames.now());
  const stage = fakeStage();
  const media = fakeMedia(st);
  const holder = { p: project };
  const sched = new Scheduler(stage, () => holder.p, media, pd.deps);
  const graph = opts.audio ? new AudioGraph(() => holder.p, media, sched) : null;
  const engine = new PlaybackEngine(() => holder.p, sched);
  const emits: Array<[number, boolean]> = [];
  engine.onTick((t, p) => {
    emits.push([t, p]);
    graph?.tick(t, p, engine.previewSpeed);
  });
  const dev = sched.pacingDev();
  dev.disabled = opts.disabled ?? false;
  if (opts.forceOnly !== undefined) {
    dev.forceHeavy = true;
    dev.forceOnly = opts.forceOnly;
  }
  const r: Rig = { frames, pd, stage, media, sched, engine, holder, emits, dev, lat: opts.lat ?? latency, graph };
  for (const e of els(r)) e.latencyFor = r.lat;
  open.push(r);
  return r;
}

function done(r: Rig): void {
  const i = open.indexOf(r);
  if (i < 0) return;
  open.splice(i, 1);
  r.engine.dispose();
  r.graph?.dispose();
  r.frames.restore();
}

afterEach(() => {
  for (const r of [...open]) done(r);
  vi.unstubAllGlobals();
});

function els(r: Rig): FakeVideo[] {
  return r.stage.sets.flatMap((s) => [s.a, s.b]);
}

/** `ms` of wall time: every element decodes (a seek may land and fire
 *  `seeked`), the engine ticks if it plays, then due timers run. */
function tick(r: Rig, ms: number): void {
  for (const e of els(r)) e.latencyFor ??= r.lat;
  r.frames.frame(ms / 1000, (d) => {
    for (const e of els(r)) e.advance(d);
  });
  r.pd.runDue();
}

function press(r: Rig, t: number): void {
  r.pd.kind = "press";
  r.engine.seek(t);
  r.pd.kind = "none";
}

function move(r: Rig, t: number): void {
  r.pd.kind = "move";
  r.engine.seek(t);
  r.pd.kind = "none";
}

/** Clip A (heavy fixture) on [3, 13], clip B on [13, 27] on one track. */
function cutProject(a: MediaRef, b: MediaRef, extraTracks: Clip[][] = [], audio: Clip[][] = []): {
  project: ProjectFile;
  ca: Clip;
  cb: Clip;
} {
  const ca = clipOf(a, 3, 1.5, 21.5, 2);
  const cb = clipOf(b, 13, 0.7, 14.7, 1);
  return { project: projectOf([a, b], [[ca, cb], ...extraTracks], audio), ca, cb };
}

/** The shown element of the layer `i` (A or B slot). */
function shown(r: Rig, i = 0): FakeVideo {
  const s = r.stage.sets[i]!;
  return s.set.videoB.pos.style.display === "" ? s.b : s.a;
}

/* ------------------------------------------------------------------ */
/* Unpaced media: the same writes with the pacing on and off          */
/* ------------------------------------------------------------------ */

/** One long scripted session: every kind of seek the editor makes. */
async function session(r: Rig, short = false): Promise<void> {
  const e = r.engine;
  e.seek(0); // the mount's seek
  await r.pd.flush();
  // a paused drag: press, 40 moves 8 ms apart, rest, release
  press(r, 4.0);
  await r.pd.flush();
  for (let i = 1; i <= 40; i++) {
    tick(r, 8);
    move(r, 4.0 + i * 0.13);
  }
  tick(r, REST_MS + 20);
  r.pd.end();
  tick(r, 900);
  // a click on the ruler, five frame steps, a jump
  e.seek(5.55);
  tick(r, 900);
  for (let i = 0; i < 5; i++) e.stepFrames(1);
  e.jumpSeconds(1);
  tick(r, 900);
  // play, then a drag while playing, a refresh in the middle of it
  e.play();
  for (let i = 0; i < 5; i++) tick(r, 16);
  press(r, e.time + 0.4);
  for (let i = 1; i <= 20; i++) {
    tick(r, 8);
    move(r, 7.1 + i * 0.047); // never onto a keyframe: today's element must not land
    if (i === 10) e.refresh();
  }
  // short: stop at the end of the playing drag's moves. Past it the engine
  // follows the heavy element as its clock, which is where the pacing puts it
  // (today's lands late and steps the playhead back): engine time and what
  // follows it differ from there on by design.
  if (short) return;
  for (let i = 0; i < 6; i++) tick(r, 16);
  r.pd.end();
  for (let i = 0; i < 60; i++) tick(r, 16);
  // a paused drag across the cut into a clip of another media
  e.pause();
  await r.pd.flush();
  press(r, 12.2);
  for (let i = 1; i <= 12; i++) {
    tick(r, 8);
    move(r, 12.2 + i * 0.13);
  }
  r.pd.end();
  tick(r, 900);
  // the project replaced under a drag, then refreshed
  press(r, 5.0);
  for (let i = 1; i <= 5; i++) {
    tick(r, 8);
    move(r, 5.0 + i * 0.2);
  }
  r.holder.p = { ...r.holder.p, timeline: { ...r.holder.p.timeline } };
  e.refresh();
  r.pd.end();
  tick(r, 900);
  // a loop restart
  e.loop = true;
  e.seek(e.duration() - 0.2);
  tick(r, 900);
  e.play();
  for (let i = 0; i < 40; i++) tick(r, 16);
  e.pause();
  await r.pd.flush();
}

async function writesOf(
  build: () => { project: ProjectFile; st: Record<string, MediaState> },
  answer: (pd: FakePacing) => void,
  disabled: boolean,
  opts: { forceOnly?: string; audio?: boolean; short?: boolean } = {},
): Promise<{ writes: string[][]; calls: string[]; emits: Array<[number, boolean]>; voices: string[][]; keyAimed: number }> {
  if (opts.audio) {
    voiceAll.length = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("Audio", FakeVoice);
  }
  const { project, st } = build();
  const r = rig(project, st, { disabled, forceOnly: opts.forceOnly, audio: opts.audio });
  answer(r.pd);
  await session(r, opts.short ?? false);
  const out = {
    writes: els(r).map((e) => [...e.writes]),
    calls: [...r.pd.calls],
    emits: [...r.emits],
    voices: voiceAll.map((v) => [...v.writes]),
    keyAimed: r.dev.counters.keyAimed,
  };
  done(r);
  return out;
}

/** The voice elements AudioGraph builds, as FakeVideos (their writes logged). */
const voiceAll: FakeVoice[] = [];
class FakeVoice extends FakeVideo {
  preload = "";
  crossOrigin = "";
  constructor() {
    super();
    voiceAll.push(this);
  }
}
class FakeAudioContext {
  currentTime = 50;
  state = "running";
  destination = {};
  createGain(): unknown {
    return { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {} };
  }
  createMediaElementSource(): unknown {
    return { connect() {} };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("C1: everything that is not a heavy drag writes exactly what it did", () => {
  const cases: Array<{
    name: string;
    sizes: [number, number];
    answer: (pd: FakePacing) => void;
    calls: number;
  }> = [
    { name: "(a) a light video by bit rate", sizes: [SMALL, SMALL], answer: () => {}, calls: 0 },
    {
      name: "(b) a candidate whose index answers light",
      sizes: [BIG, SMALL],
      answer: (pd) => pd.answers.set("C:\\media\\ca.mp4", LIGHT_IX),
      calls: 1,
    },
    {
      name: "(c) a candidate whose index answers null",
      sizes: [BIG, SMALL],
      answer: (pd) => pd.answers.set("C:\\media\\ca.mp4", null),
      calls: 1,
    },
    { name: "(d) a candidate whose index never answers", sizes: [BIG, SMALL], answer: () => {}, calls: 1 },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const build = () => {
        const a = vid("ca", c.sizes[0]);
        const b = vid("cb", c.sizes[1]);
        const { project } = cutProject(a, b);
        return { project, st: statuses(a, b) };
      };
      const off = await writesOf(build, c.answer, true);
      const on = await writesOf(build, c.answer, false);
      expect(off.calls).toEqual([]);
      expect(on.calls.length).toBe(c.calls);
      expect(on.writes.some((w) => w.length > 20)).toBe(true);
      expect(on.writes).toEqual(off.writes);
      expect(on.emits).toEqual(off.emits);
    });
  }

  it("(e) images and generated clips: no index asked, the same writes", async () => {
    const build = () => {
      const img = { id: "pimg", path: "C:\\media\\still.png", kind: "image", duration: 40, size: BIG, width: 64, height: 64 } as MediaRef;
      const gen = {
        id: "pgen", path: "", kind: "video", duration: 40, size: BIG, width: 64, height: 64,
        generator: { type: "solid", color: "#123456" },
      } as unknown as MediaRef;
      const project = projectOf([img, gen], [[clipOf(img, 0, 0, 13, 1), clipOf(gen, 13, 0, 14, 1)]]);
      return { project, st: {} };
    };
    const off = await writesOf(build, () => {}, true);
    const on = await writesOf(build, () => {}, false);
    expect(on.calls).toEqual([]);
    expect(on.writes).toEqual(off.writes);
  });

  it("(f) an audio track's voices write the same through AudioGraph", async () => {
    const build = () => {
      const a = vid("ca", BIG);
      const b = vid("cb", SMALL);
      const snd = { id: "psnd", path: "C:\\media\\snd.wav", kind: "audio", duration: 40, size: 1, hasAudio: true } as MediaRef;
      const { project: p0 } = cutProject(a, b, [], [[clipOf(snd, 1, 0.25, 30, 1)]]);
      const project = { ...p0, media: [...p0.media, snd] };
      return { project, st: statuses(a, b, snd) };
    };
    const answer = (pd: FakePacing) => pd.answers.set("C:\\media\\ca.mp4", LIGHT_IX);
    const off = await writesOf(build, answer, true, { audio: true });
    const on = await writesOf(build, answer, false, { audio: true });
    expect(on.voices.length).toBeGreaterThan(0);
    expect(on.voices.some((v) => v.length > 0)).toBe(true);
    expect(on.voices).toEqual(off.voices);
    expect(on.writes).toEqual(off.writes);
  });

  it("(g) a HEAVY video with sound: the voices and every element's muted/volume writes are the same", async () => {
    const build = () => {
      const a = { ...vid("ca", BIG), hasAudio: true } as MediaRef;
      const b = vid("cb", SMALL);
      const snd = { id: "psnd", path: "C:\\media\\snd.wav", kind: "audio", duration: 40, size: 1, hasAudio: true } as MediaRef;
      const { project: p0 } = cutProject(a, b, [], [[clipOf(snd, 1, 0.25, 30, 1)]]);
      const project = { ...p0, media: [...p0.media, snd] };
      return { project, st: statuses(a, b, snd) };
    };
    const answer = (pd: FakePacing) => pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
    // through the paused drag, the clicks, play and the playing drag's moves
    const off = await writesOf(build, answer, true, { audio: true, short: true });
    const on = await writesOf(build, answer, false, { audio: true, short: true });
    expect(on.keyAimed).toBeGreaterThan(0);
    expect(on.voices.some((v) => v.length > 0)).toBe(true);
    expect(on.voices).toEqual(off.voices);
    const sound = (w: string[][]) => w.map((x) => x.filter((s) => s.startsWith("muted:") || s.startsWith("vol:")));
    expect(sound(on.writes)).toEqual(sound(off.writes));
    expect(on.emits).toEqual(off.emits);
  });
});

describe("C2: on a heavy clip only the heavy element's writes change", () => {
  it("the engine's emits are identical through the paused drag, the clicks, steps and the playing drag", async () => {
    // A shorter session: everything up to the end of a playing drag's moves.
    const run = async (disabled: boolean) => {
      const a = vid("ca", BIG);
      const b = vid("cb", SMALL);
      const { project } = cutProject(a, b);
      const r = rig(project, statuses(a, b), { disabled });
      r.pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
      const e = r.engine;
      const times: number[] = [];
      e.seek(0);
      press(r, 4.0);
      await r.pd.flush();
      for (let i = 1; i <= 40; i++) {
        tick(r, 8);
        move(r, 4.0 + i * 0.13);
        times.push(e.time);
      }
      tick(r, REST_MS + 20);
      r.pd.end();
      tick(r, 900);
      const heavy = els(r)[0]!;
      const m1 = heavy.writes.length;
      e.seek(5.55);
      tick(r, 900);
      for (let i = 0; i < 5; i++) e.stepFrames(1);
      e.jumpSeconds(1);
      tick(r, 900);
      const m2 = heavy.writes.length;
      e.play();
      for (let i = 0; i < 5; i++) tick(r, 16);
      const m3 = heavy.writes.length;
      press(r, e.time + 0.4);
      const m4 = heavy.writes.length;
      for (let i = 1; i <= 20; i++) {
        tick(r, 8);
        move(r, 7.1 + i * 0.047); // never onto a keyframe: today's element must not land
        times.push(e.time);
      }
      const out = {
        emits: [...r.emits],
        times,
        key: r.dev.counters.keyAimed,
        writes: els(r).map((x) => [...x.writes]),
        // the heavy element's writes for the click, steps and jump; for play;
        // for the press of the playing drag
        clicks: heavy.writes.slice(m1, m2),
        play: heavy.writes.slice(m2, m3),
        pressed: heavy.writes.slice(m3, m4),
      };
      done(r);
      return out;
    };
    const off = await run(true);
    const on = await run(false);
    expect(on.key).toBeGreaterThan(0);
    expect(off.key).toBe(0);
    const i = on.emits.findIndex((x, k) => x[0] !== off.emits[k]?.[0] || x[1] !== off.emits[k]?.[1]);
    expect(i, `first difference at emit ${i}: ${JSON.stringify(on.emits.slice(i - 2, i + 3))} vs ${JSON.stringify(off.emits.slice(i - 2, i + 3))}`).toBe(-1);
    expect(on.emits).toEqual(off.emits);
    expect(on.times).toEqual(off.times);
    // only the heavy element (layer 0, slot A) was written differently
    expect(on.writes[0]).not.toEqual(off.writes[0]);
    expect(on.writes.slice(1)).toEqual(off.writes.slice(1));
    // and on it, only during the drags: once a pacer exists, the click, the
    // frame steps, the jump, play and a press write exactly what they did
    expect(on.clicks.filter((w) => w.startsWith("t:")).length).toBeGreaterThanOrEqual(3);
    expect(on.clicks).toEqual(off.clicks);
    expect(on.play.length).toBeGreaterThan(0);
    expect(on.play).toEqual(off.play);
    expect(on.pressed).toEqual(off.pressed);
  });

  it("a click while a released drag's exact seek is still in flight is the last write", async () => {
    const { r, ca, el } = await heavyRig();
    for (let i = 1; i <= 20; i++) {
      tick(r, 8);
      move(r, 4.0 + i * 0.11);
    }
    r.pd.end(); // the release's exact seek: 0.8 s in flight
    expect(r.dev.snapshot().pacers[0]!.flight).toBe("exact");
    tick(r, 100);
    const n = el.writes.length;
    r.engine.seek(9.37); // a click on the ruler
    const want = sourceTime(ca, 9.37 - ca.timelineStart);
    for (let i = 0; i < 120; i++) tick(r, 16);
    expect(el.writes.slice(n).filter((w) => w.startsWith("t:"))).toEqual([`t:${want}`]);
    expect(el.currentTime).toBe(want);
    clean(r);
  });
});

/* ------------------------------------------------------------------ */
/* the heavy paused drag                                               */
/* ------------------------------------------------------------------ */

async function heavyRig(disabled = false): Promise<{ r: Rig; ca: Clip; el: FakeVideo }> {
  const a = vid("ca", BIG);
  const b = vid("cb", SMALL);
  const { project, ca } = cutProject(a, b);
  const r = rig(project, statuses(a, b), { disabled });
  r.pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
  r.engine.seek(4.0);
  tick(r, 900);
  press(r, 4.0);
  await r.pd.flush();
  return { r, ca, el: shown(r) };
}

describe("a paused drag over the heavy clip", () => {
  const drag = (r: Rig, el: FakeVideo, n: number) => {
    let landings = 0;
    const count = (): void => {
      landings++;
    };
    el.addEventListener("seeked", count);
    const asked: number[] = [];
    const ca = r.holder.p.timeline.tracks[0]!.clips[0]!;
    for (let i = 1; i <= n; i++) {
      tick(r, 8);
      const t = 4.0 + i * 0.11; // source 3.5 + 0.22 i: never a keyframe
      move(r, t);
      asked.push(sourceTime(ca, t - ca.timelineStart));
      expect(r.engine.time).toBe(t);
    }
    el.removeEventListener("seeked", count);
    return { landings, asked };
  };

  it("without pacing, no seek lands until the pointer stops (the freeze)", async () => {
    const { r, el } = await heavyRig(true);
    const { landings } = drag(r, el, 40);
    expect(landings).toBe(0);
  });

  it("with pacing, real pictures land during the drag and the rest ends on the exact frame", async () => {
    const { r, ca, el } = await heavyRig();
    el.writes.length = 0;
    const { landings, asked } = drag(r, el, 40);
    expect(landings).toBeGreaterThanOrEqual(4);
    const seeks = el.writes.filter((w) => w.startsWith("t:")).map((w) => Number(w.slice(2)));
    expect(seeks.length).toBeGreaterThan(0);
    for (const s of seeks) expect(onKey(s) || asked.some((a) => Math.abs(a - s) < 1e-9)).toBe(true);
    expect(r.dev.counters.keyAimed).toBeGreaterThan(0);
    tick(r, REST_MS);
    for (let i = 0; i < 120; i++) tick(r, 8);
    expect(el.seeking).toBe(false);
    expect(Math.abs(el.currentTime - sourceTime(ca, r.engine.time - ca.timelineStart))).toBeLessThanOrEqual(0.01);
    r.pd.end();
    expect(r.pd.endListeners()).toBe(0);
    expect(el.listenerCount("seeked")).toBe(0);
    expect(r.pd.pending()).toBe(0);
  });

  it("a drag that leaves the clip into a gap lets go of everything (pauseAll cancels)", async () => {
    const a = vid("ca", BIG);
    const ca = clipOf(a, 3, 1.5, 21.5, 2);
    const project = projectOf([a], [[ca]]);
    const r = rig(project, statuses(a));
    r.pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
    r.engine.seek(12);
    tick(r, 900);
    press(r, 12);
    await r.pd.flush();
    for (let i = 1; i <= 6; i++) {
      tick(r, 8);
      move(r, 12 + i * 0.1);
    }
    const el = shown(r);
    expect(r.pd.endListeners()).toBe(1);
    // the duration is 13: past it the engine clamps; a gap needs a later clip,
    // so the timeline is extended with an image after a gap
    const img = { id: "pimg2", path: "C:\\media\\s.png", kind: "image", duration: 40, width: 4, height: 4 } as MediaRef;
    r.holder.p = projectOf([a, img], [[ca, clipOf(img, 15, 0, 5, 1)]]);
    move(r, 13.8); // into the gap, still dragging
    const n = el.writes.length;
    for (let i = 0; i < 60; i++) tick(r, 16);
    expect(el.writes.slice(n).filter((w) => w.startsWith("t:"))).toEqual([]);
    expect(el.listenerCount("seeked")).toBe(0);
    expect(r.pd.pending()).toBe(0);
    expect(r.pd.endListeners()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* the heavy playing drag                                              */
/* ------------------------------------------------------------------ */

describe("a playing drag over the heavy clip", () => {
  /** An exact seek that a learned lead can catch up with (0.06 s at speed 2). */
  const quick = (t: number): number => (onKey(t) ? KEY_S : 0.06);

  async function playingRig(lat = quick, disabled = false) {
    const a = vid("ca", BIG);
    const b = vid("cb", SMALL);
    const { project, ca } = cutProject(a, b);
    const r = rig(project, statuses(a, b), { lat, disabled });
    r.pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
    r.engine.seek(4.0);
    tick(r, 900);
    r.engine.play();
    for (let i = 0; i < 4; i++) tick(r, 16);
    press(r, r.engine.time);
    await r.pd.flush();
    return { r, ca, el: shown(r) };
  }

  it("is held: no clock from the element, the engine runs from the asked times, no write while seeking", async () => {
    const { r, el } = await playingRig();
    const seekingAtWrite: boolean[] = [];
    el.latencyFor = (t) => {
      seekingAtWrite.push(el.seeking);
      return quick(t);
    };
    for (let i = 1; i <= 20; i++) {
      tick(r, 8);
      const asked = 5 + i * 0.05;
      move(r, asked);
      expect(r.sched.masterClockTime()).toBeNull();
      tick(r, 4);
      expect(r.engine.time).toBeCloseTo(asked + 0.004, 9);
    }
    expect(r.dev.snapshot().holding).toBe(true);
    expect(seekingAtWrite.length).toBeGreaterThan(0);
    expect(seekingAtWrite.every((s) => !s)).toBe(true);
  });

  it("a held element is re-aimed at the CURRENT engine time once it lands (single layer)", async () => {
    const { r, ca, el } = await playingRig();
    for (let i = 1; i <= 5; i++) {
      tick(r, 8);
      move(r, 5 + i * 0.05);
    }
    // the pointer stops but is still within REST_MS: ticks alone re-aim
    const n = el.writes.length;
    tick(r, 16);
    tick(r, 16);
    tick(r, 16);
    tick(r, 16);
    const seeks = el.writes.slice(n).filter((w) => w.startsWith("t:"));
    expect(seeks.length).toBeGreaterThan(0);
    expect(r.dev.snapshot().holding).toBe(true);
    const last = Number(seeks.at(-1)!.slice(2));
    // aimed where the engine was at that tick (within a tick of drift)
    expect(Math.abs(last - sourceTime(ca, r.engine.time - ca.timelineStart))).toBeLessThan(0.1);
  });

  it("after the rest the element is the clock again and the playhead never steps back far", async () => {
    const { r } = await playingRig();
    for (let i = 1; i <= 12; i++) {
      tick(r, 8);
      move(r, 5 + i * 0.05);
    }
    let prev = r.engine.time;
    let worst = 0;
    let clockAt = -1;
    for (let i = 0; i < 60; i++) {
      tick(r, 16);
      worst = Math.max(worst, prev - r.engine.time);
      prev = r.engine.time;
      if (clockAt < 0 && r.sched.masterClockTime() !== null) clockAt = i;
    }
    expect(r.dev.snapshot().holding).toBe(false);
    expect(clockAt).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(0.12);
    expect(r.engine.playing).toBe(true);
    r.pd.end();
    expect(r.pd.endListeners()).toBe(0);
  });

  it("a release right after big moves never hands the clock to a seek the pointer left", async () => {
    const lat = (t: number): number => (onKey(t) ? KEY_S : 0.1);
    const { r } = await playingRig(lat);
    // The first move re-aims the element (a 0.1 s seek); nine more follow
    // inside that seek, so at the release it is still on its way to where the
    // pointer was 72 ms and 2.7 timeline s earlier.
    for (let i = 1; i <= 10; i++) {
      tick(r, 8);
      move(r, 5 + i * 0.3);
    }
    expect(shown(r).seeking).toBe(true);
    r.pd.end();
    let prev = r.engine.time;
    let worst = 0;
    for (let i = 0; i < 80; i++) {
      tick(r, 16);
      worst = Math.max(worst, prev - r.engine.time);
      prev = r.engine.time;
    }
    expect(r.dev.snapshot().holding).toBe(false);
    expect(r.sched.masterClockTime()).not.toBeNull();
    expect(worst).toBeLessThanOrEqual(0.12);
  });

  it("a hold that ends with the element in the nudge band leaves it at its own rate as the clock", async () => {
    const lat = (t: number): number => (onKey(t) ? KEY_S : 0.1);
    const { r, ca, el } = await playingRig(lat);
    for (let i = 1; i <= 10; i++) {
      tick(r, 8);
      move(r, 5 + i * 0.3);
    }
    expect(el.seeking).toBe(true);
    r.pd.end();
    // The seek lands 0.06 source s ahead of the clock: inside the nudge band
    // (more than NUDGE_SEC, less than HARD_RESYNC_SEC), so no re-seek.
    const orig = el.advance.bind(el);
    let armed = true;
    el.advance = (dt: number): void => {
      orig(dt);
      if (armed && !el.seeking) {
        armed = false;
        (el as unknown as { ct: number }).ct = sourceTime(ca, r.engine.time + dt - ca.timelineStart) + 0.06;
      }
    };
    for (let i = 0; i < 40; i++) tick(r, 16);
    expect(armed).toBe(false);
    expect(r.dev.snapshot().holding).toBe(false);
    expect(r.sched.masterClockTime()).not.toBeNull();
    expect(el.playbackRate).toBe(ca.speed * r.engine.previewSpeed);
  });

  it("a hold ended by the settle bound gives the clock element its own rate back", async () => {
    // seeks that settle at once, so the element is never mid-seek here
    const { r, ca, el } = await playingRig(() => 0);
    for (let i = 1; i <= 4; i++) {
      tick(r, 8);
      move(r, 5 + i * 0.05);
    }
    tick(r, 8);
    expect(el.seeking).toBe(false);
    expect(r.dev.snapshot().holding).toBe(true);
    // a slave's nudge on the held element, then it stalls (paused by the
    // engine of the browser, say): no tick checks it, so only the settle
    // bound ends the hold
    el.playbackRate = ca.speed * 0.98;
    el.paused = true;
    for (let i = 0; i < 80; i++) tick(r, 16);
    expect(r.dev.snapshot().holding).toBe(false);
    el.paused = false;
    const n0 = el.writes.length;
    for (let i = 0; i < 4; i++) tick(r, 16);
    expect(el.writes.slice(n0).filter((w) => w.startsWith("t:"))).toEqual([]);
    expect(r.sched.masterClockTime()).not.toBeNull();
    expect(el.playbackRate).toBe(ca.speed * r.engine.previewSpeed);
  });

  it("a release over a SLOW exact seek (0.8 s, speed 2): no further step back than today, the hold ends by the settle bound", async () => {
    const run = async (disabled: boolean) => {
      const { r } = await playingRig(latency, disabled);
      for (let i = 1; i <= 10; i++) {
        tick(r, 8);
        move(r, 5 + i * 0.3);
      }
      r.pd.end();
      let prev = r.engine.time;
      let worst = 0;
      let endedAt = -1;
      for (let i = 0; i < 100; i++) {
        tick(r, 16);
        worst = Math.max(worst, prev - r.engine.time);
        prev = r.engine.time;
        if (endedAt < 0 && !r.dev.snapshot().holding) endedAt = (i + 1) * 16;
      }
      const out = { worst, endedAt, held: r.dev.counters.heldMoves, playing: r.engine.playing, end: r.engine.time };
      done(r);
      return out;
    };
    const off = await run(true);
    const on = await run(false);
    expect(on.held).toBe(10);
    // today's element lands 0.8 s late at the last asked position; a held
    // element ends no further back than that
    expect(off.worst).toBeGreaterThan(0.5);
    expect(on.worst).toBeLessThanOrEqual(off.worst + 1e-9);
    expect(on.endedAt).toBeGreaterThan(0);
    expect(on.endedAt).toBeLessThanOrEqual(HOLD_SETTLE_MS + 16);
    expect(on.playing).toBe(true);
    expect(Math.abs(on.end - off.end)).toBeLessThanOrEqual(0.12);
  });

  it("learns no seek lead from a landing the pointer moved away from", async () => {
    const slow = (t: number): number => (onKey(t) ? KEY_S : 0.3);
    const { r } = await playingRig(slow);
    for (let i = 1; i <= 120; i++) {
      tick(r, 8);
      move(r, 5 + i * 0.03);
    }
    const layer = (r.sched as unknown as { layers: Array<{ seekLead: number }> }).layers[0]!;
    expect(layer.seekLead).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Several layers                                                      */
/* ------------------------------------------------------------------ */

describe("C5: each heavy element is paced on its own", () => {
  it("a light top layer writes exactly what it does without pacing", async () => {
    const run = async (disabled: boolean) => {
      const top = vid("top", SMALL);
      const a = vid("ca", BIG);
      const b = vid("cb", SMALL);
      const ct = clipOf(top, 2, 0.3, 30, 1);
      const { project } = cutProject(a, b, [[ct]]);
      // the top layer first
      const p = { ...project, timeline: { ...project.timeline, tracks: [project.timeline.tracks[1]!, project.timeline.tracks[0]!] } };
      const r = rig(p, statuses(top, a, b), { disabled });
      r.pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
      r.engine.seek(4);
      tick(r, 900);
      press(r, 4);
      await r.pd.flush();
      for (let i = 1; i <= 30; i++) {
        tick(r, 8);
        move(r, 4 + i * 0.1);
      }
      tick(r, REST_MS);
      r.pd.end();
      for (let i = 0; i < 100; i++) tick(r, 16);
      const out = { top: [...r.stage.sets[0]!.a.writes, ...r.stage.sets[0]!.b.writes], key: r.dev.counters.keyAimed, calls: [...r.pd.calls] };
      done(r);
      return out;
    };
    const off = await run(true);
    const on = await run(false);
    expect(on.top).toEqual(off.top);
    expect(on.key).toBeGreaterThan(0);
    expect(on.calls).toEqual(["C:\\media\\ca.mp4"]);
  });

  it("two heavy layers keep their own waiting target and timer", async () => {
    const a = vid("ca", BIG);
    const d = vid("cd", BIG);
    const ca = clipOf(a, 3, 1.5, 21.5, 2);
    const cd = clipOf(d, 2, 4.2, 30, 1);
    const project = projectOf([a, d], [[cd], [ca]]);
    const r = rig(project, statuses(a, d));
    r.pd.answers.set("C:\\media\\ca.mp4", HEAVY_IX);
    r.pd.answers.set("C:\\media\\cd.mp4", HEAVY_IX);
    r.engine.seek(4);
    tick(r, 900);
    press(r, 4);
    await r.pd.flush();
    press(r, 4.6);
    tick(r, 400);
    move(r, 4.7); // slow: each waits behind its own press
    const snap = r.dev.snapshot();
    expect(snap.pacers.length).toBe(2);
    expect(snap.pacers.map((p) => p.want)).toEqual([
      { kind: "exact", t: sourceTime(cd, 4.7 - 2) },
      { kind: "exact", t: sourceTime(ca, 4.7 - 3) },
    ]);
    expect(snap.pacers.every((p) => p.restArmed)).toBe(true);
    expect(snap.engaged).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Every guard leaves nothing behind                                   */
/* ------------------------------------------------------------------ */

function clean(r: Rig): void {
  for (const e of els(r)) expect(e.listenerCount("seeked")).toBe(0);
  expect(r.pd.pending()).toBe(0);
  expect(r.pd.endListeners()).toBe(0);
}

/** A paused heavy drag with a target waiting behind the seek in flight. */
async function midDrag(): Promise<{ r: Rig; ca: Clip; el: FakeVideo }> {
  const h = await heavyRig();
  press(h.r, 4.6); // an exact seek, 0.8 s in flight
  tick(h.r, 400);
  move(h.r, 4.7); // slow: waits behind the press's exact seek
  expect(h.r.dev.snapshot().pacers[0]!.want).not.toBeNull();
  return h;
}

/** Nothing is written to `el` from here on while time passes. */
function noLateWrites(r: Rig, el: FakeVideo): void {
  const n = el.writes.length;
  for (let i = 0; i < 80; i++) tick(r, 16);
  expect(el.writes.slice(n).filter((w) => w.startsWith("t:"))).toEqual([]);
}

describe("C3: guards", () => {
  it("a drag across a cut into another media drops the old element's pending seek", async () => {
    const { r, el } = await midDrag();
    for (let i = 1; i <= 10; i++) {
      tick(r, 8);
      move(r, 12.4 + i * 0.1); // past 13: clip B, light
    }
    expect(r.dev.snapshot().engaged).toBe(0);
    noLateWrites(r, el);
    r.pd.end();
    clean(r);
  });

  it("a source swap mid-drag (status change + refresh) drops the pending seek", async () => {
    const { r, el } = await midDrag();
    const a = r.holder.p.media[0]!;
    r.media.statuses = { ...r.media.statuses, [a.id]: { state: "ready", url: "url:C:\\proxy\\ca.mp4", sourcePath: "C:\\proxy\\ca.mp4" } };
    r.engine.refresh();
    expect(r.dev.snapshot().pacers[0]!.want).toBeNull();
    noLateWrites(r, el);
    clean(r);
  });

  it("a source swap reached by the next MOVE (no refresh) drops the pending seek and indexes the new file", async () => {
    const { r, ca, el } = await midDrag();
    const old = r.dev.snapshot().pacers[0]!.want!;
    const asks = r.dev.counters.indexAsks;
    const a = r.holder.p.media[0]!;
    r.media.statuses = { ...r.media.statuses, [a.id]: { state: "ready", url: "url:C:\\proxy\\ca.mp4", sourcePath: "C:\\proxy\\ca.mp4" } };
    const n = el.writes.length;
    move(r, 4.8); // the swap reaches the scheduler through a drag move
    expect(r.dev.snapshot().pacers[0]!.want).toBeNull();
    expect(r.dev.counters.indexAsks).toBe(asks + 1);
    expect(r.pd.calls.at(-1)).toBe("C:\\proxy\\ca.mp4");
    for (let i = 0; i < 80; i++) tick(r, 16);
    const seeks = el.writes.slice(n).filter((w) => w.startsWith("t:"));
    expect(seeks).not.toContain(`t:${old.t}`);
    // the new file's exact frame, as today for a file with no index yet
    expect(seeks.at(-1)).toBe(`t:${sourceTime(ca, 4.8 - ca.timelineStart)}`);
    // the new file answers heavy: the next drag move is paced on the new binding
    r.pd.answers.set("C:\\proxy\\ca.mp4", HEAVY_IX);
    await r.pd.flush();
    move(r, 5.6);
    const p = r.dev.snapshot().pacers[0]!;
    expect(p.bound).toBe(true);
    expect(p.dragging).toBe(true);
    // back to the original file (indexed already) mid-drag: the binding to
    // the proxy's element state is dropped before the next paced write
    const cancels = r.dev.counters.cancels;
    r.media.statuses = { ...r.media.statuses, [a.id]: readyStatus(a) };
    move(r, 5.9);
    expect(r.dev.counters.cancels).toBe(cancels + 1);
    expect(r.dev.counters.indexAsks).toBe(asks + 1);
    r.pd.end();
    for (let i = 0; i < 80; i++) tick(r, 16);
    clean(r);
  });

  it("an error on the bound element drops the pending seek", async () => {
    const { r, el } = await midDrag();
    el.error = { code: 3 };
    el.fire("error");
    noLateWrites(r, el);
    clean(r);
  });

  it("engine.pause() and engine.play() mid-drag cancel, then seek exactly as today", async () => {
    const { r, ca, el } = await midDrag();
    r.engine.play();
    expect(r.dev.snapshot().pacers[0]!.want).toBeNull();
    for (let i = 1; i <= 4; i++) {
      tick(r, 8);
      move(r, r.engine.time + 0.05);
    }
    expect(r.dev.snapshot().holding).toBe(true);
    const n = el.writes.length;
    r.engine.pause();
    expect(r.dev.snapshot().holding).toBe(false);
    const want = sourceTime(ca, r.engine.time - ca.timelineStart);
    // today's exact paused seek, once (the held element was off the clock)
    expect(el.writes.slice(n).filter((w) => w.startsWith("t:"))).toEqual([`t:${want}`]);
    for (let i = 0; i < 80; i++) tick(r, 16);
    clean(r);
  });

  it("a project replaced and refreshed mid-drag drops the pending seek", async () => {
    const { r, el } = await midDrag();
    r.holder.p = { ...r.holder.p, timeline: { ...r.holder.p.timeline } };
    r.engine.refresh();
    expect(r.dev.snapshot().pacers[0]!.want).toBeNull();
    noLateWrites(r, el);
    clean(r);
  });

  it("a layer rebound to another element set drops the pending seek", async () => {
    const { r, el } = await midDrag();
    const other = fakeStage();
    other.syncLayerCount(1);
    const layer = (r.sched as unknown as { layers: Array<{ setLayerSet(s: unknown): boolean }> }).layers[0]!;
    expect(layer.setLayerSet(other.sets[0]!.set)).toBe(true);
    noLateWrites(r, el);
    clean(r);
  });

  it("engine.dispose() mid-drag leaves nothing behind", async () => {
    const { r, el } = await midDrag();
    r.engine.dispose();
    const n = el.writes.length;
    for (let i = 0; i < 80; i++) {
      for (const e of els(r)) e.advance(0.016);
      r.frames.idle(0.016);
      r.pd.runDue();
    }
    expect(el.writes.slice(n).filter((w) => w.startsWith("t:"))).toEqual([]);
    clean(r);
  });
});
