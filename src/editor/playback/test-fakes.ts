// Test doubles for the playback core. The vitest environment is "node" (no
// DOM), so the scheduler and engine are driven against these: a <video> whose
// clock really advances at its playbackRate, the stage's layer-set pool, and
// the slice of MediaManager the scheduler reads. Imported only by
// *.test.ts files beside it; nothing in the app references this module.

import { Store } from "../../core/store";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";
import type { DamageState, MediaManager, MediaState } from "../media/media";
import type { LayerSet, Stage } from "../preview/preview";
import type { KeyframeIndex } from "../../core/ipc";
import type { PacingDeps, SeekCause } from "./seek-pacing";

type Listener = () => void;

/** A <video> stand-in with exactly the surface the scheduler and engine read.
 *  Writes to currentTime, playbackRate and src are COUNTED (a seek, a rate
 *  change and a load are the observable effects every test asserts on);
 *  `advance` and `jump` move the clock without counting, the way decoding does. */
export class FakeVideo {
  /** the transform tower writes geometry here */
  style: Record<string, string> = {};
  readyState = 4;
  seeking = false;
  ended = false;
  error: { code: number } | null = null;
  paused = true;
  /** Source time at which playback ends (a file shorter than its probe). */
  endAt = Infinity;
  seeks = 0;
  rateWrites = 0;
  srcWrites = 0;
  /** every src assignment, with performance.now() at the time */
  srcLog: Array<{ url: string; at: number }> = [];
  /** performance.now() at every seek */
  seekLog: number[] = [];
  /**
   * Wall seconds a seek takes. 0 (the default) settles instantly. Otherwise a
   * write to currentTime behaves the way a real element does: currentTime
   * reads back the target at once, but `seeking` is true, readyState drops to
   * HAVE_METADATA and the clock stays frozen until `advance` has consumed the
   * latency; the rest of that advance then decodes normally. A plain field, so
   * a test can make later seeks faster or slower than the first.
   */
  seekLatency = 0;
  /**
   * Model the media element LOAD algorithm on a src write, the way Chromium
   * runs it: the position goes back to 0, readyState to HAVE_NOTHING, the
   * element pauses and its rate returns to the default (1); the next
   * `advance` finishes the load (HAVE_ENOUGH_DATA) without decoding. Off by
   * default — most tests count loads and never look past them — but a test
   * about what happens AFTER a src change must turn it on, or an element
   * that kept its old position and rate would pass for one that was put back.
   */
  resetOnLoad = false;
  /** Every write to the element, in order: `t:<v>`, `rate:<v>`, `src:<v>`,
   *  `play`, `pause`, `muted:<v>`, `vol:<v>` (the identity tests compare it). */
  writes: string[] = [];
  /** When set, the latency of a seek to `t` (seconds), in place of
   *  `seekLatency`: a seek ON a keyframe is fast, one late in a GOP slow. */
  latencyFor: ((t: number) => number) | null = null;
  private loading = false;
  private seekLeft = 0;
  private ct = 0;
  private rate = 1;
  private src_ = "";
  private muted_ = false;
  private volume_ = 1;
  private listeners = new Map<string, Set<Listener>>();

  get muted(): boolean {
    return this.muted_;
  }
  set muted(v: boolean) {
    this.muted_ = v;
    this.writes.push(`muted:${v}`);
  }
  get volume(): number {
    return this.volume_;
  }
  set volume(v: number) {
    this.volume_ = v;
    this.writes.push(`vol:${v}`);
  }

  get currentTime(): number {
    return this.ct;
  }
  set currentTime(v: number) {
    this.ct = v;
    this.seeks++;
    this.seekLog.push(performance.now());
    this.writes.push(`t:${v}`);
    if (this.latencyFor !== null) this.seekLatency = this.latencyFor(v);
    if (this.seekLatency > 0) {
      this.seeking = true;
      this.readyState = 1;
      this.seekLeft = this.seekLatency;
    }
  }
  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(v: number) {
    this.rate = v;
    this.rateWrites++;
    this.writes.push(`rate:${v}`);
  }
  get src(): string {
    return this.src_;
  }
  set src(v: string) {
    this.src_ = v;
    this.srcWrites++;
    this.srcLog.push({ url: v, at: performance.now() });
    this.writes.push(`src:${v}`);
    if (this.resetOnLoad) {
      this.ct = 0;
      this.rate = 1;
      this.readyState = 0;
      this.paused = true;
      this.seeking = false;
      this.seekLeft = 0;
      this.ended = false;
      this.error = null;
      this.loading = true;
    }
  }

  /** `dt` seconds of wall time pass: a playing element decodes dt*rate. */
  advance(dt: number): void {
    if (this.loading) {
      // the load takes this frame; decoding starts on the next
      this.loading = false;
      this.readyState = 4;
      return;
    }
    if (this.seeking && this.seekLeft > 0) {
      // the seek is still in flight: wall time passes, the clock does not
      const spent = Math.min(dt, this.seekLeft);
      this.seekLeft -= spent;
      dt -= spent;
      if (this.seekLeft > 1e-12) return;
      this.seekLeft = 0;
      this.seeking = false;
      this.readyState = 4;
      // a real element announces the landing of the seek that was not superseded
      this.fire("seeked");
    }
    if (this.paused || this.ended) return;
    this.ct += dt * this.rate;
    if (this.ct >= this.endAt) {
      this.ct = this.endAt;
      this.ended = true;
      this.paused = true;
    }
  }

  /** Move the clock by `dx` source seconds without it counting as a seek. */
  jump(dx: number): void {
    this.ct += dx;
  }

  play(): Promise<void> {
    this.paused = false;
    this.writes.push("play");
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.writes.push("pause");
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

/**
 * A style object for the generated-media <div> that models the one CSS rule
 * the text layer depends on: assigning the `font` shorthand resets
 * line-height — to the value inside the shorthand ("…16px/1.25 …"), or to
 * `normal` when it carries none. A plain object would accept a lineHeight
 * written before `font` and keep it, which is exactly what a browser does not.
 */
export class ShorthandStyle {
  [prop: string]: unknown;
  lineHeight = "";
  private font_ = "";
  get font(): string {
    return this.font_;
  }
  set font(v: string) {
    this.font_ = v;
    if (v === "") return;
    const m = /\d(?:px|pt|em|rem|%)\/(\S+)/.exec(v);
    this.lineHeight = m ? m[1]! : "normal";
  }
}

function boxes<M>(media: M): { pos: HTMLElement; rot: HTMLElement; crop: HTMLElement; media: M } {
  const box = (): HTMLElement => ({ style: {} }) as unknown as HTMLElement;
  return { pos: box(), rot: box(), crop: box(), media };
}

export interface FakeSet {
  set: LayerSet;
  a: FakeVideo;
  b: FakeVideo;
  gen: { style: ShorthandStyle; textContent: string };
}

function fakeSet(): FakeSet {
  const a = new FakeVideo();
  const b = new FakeVideo();
  const gen = { style: new ShorthandStyle(), textContent: "" };
  const set = {
    el: { style: {} },
    videoA: boxes(a),
    videoB: boxes(b),
    image: boxes({ style: {}, src: "" }),
    gen: boxes(gen),
  } as unknown as LayerSet;
  return { set, a, b, gen };
}

/**
 * The stage's status overlay: the text and classes `setOverlay` and the
 * scheduler write, with every text read and WRITE and every class toggle
 * counted — the zero-overhead tests assert that a playing tick touches none
 * of them.
 */
export class FakeOverlay {
  textReads = 0;
  textWrites = 0;
  toggles = 0;
  readonly classes = new Set<string>();
  private text_ = "";
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      this.toggles++;
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
    contains: (name: string): boolean => this.classes.has(name),
  };
  get textContent(): string {
    this.textReads++;
    return this.text_;
  }
  set textContent(v: string) {
    this.text_ = v;
    this.textWrites++;
  }
  /** What a user sees: the text while the overlay is active, else null.
   *  Not counted as a read. */
  shown(): string | null {
    return this.classes.has("active") ? this.text_ : null;
  }
}

/** The stage's pooled layer sets: index i is always the same set object. */
export function fakeStage(): Stage & { sets: FakeSet[]; fakeOverlay: FakeOverlay } {
  const sets: FakeSet[] = [];
  const fakeOverlay = new FakeOverlay();
  const stage = {
    root: {} as HTMLElement,
    canvas: {} as HTMLElement,
    layers: [] as LayerSet[],
    overlay: fakeOverlay as unknown as HTMLElement,
    fakeOverlay,
    scale: 1,
    sets,
    syncLayerCount(n: number): void {
      while (sets.length < n) sets.push(fakeSet());
      stage.layers = sets.slice(0, n).map((s) => s.set);
    },
    refit(): void {},
    dispose(): void {},
  };
  return stage;
}

/** Which element of a set is on screen (the scheduler shows one at a time). */
export function shownVideo(s: FakeSet): FakeVideo | null {
  const shown = (b: { pos: HTMLElement }): boolean => b.pos.style.display === "";
  if (shown(s.set.videoA)) return s.a;
  if (shown(s.set.videoB)) return s.b;
  return null;
}

/** The MediaManager surface the scheduler and audio graph read: the status
 *  store, the damage store (a real Store, so its notifications are
 *  microtask-batched exactly as the manager's are; `damageReads` counts its
 *  `get` calls), and playbackFailed (recorded as [id, url, code, message]). */
export function fakeMedia(
  statuses: Record<string, MediaState>,
  damage: Record<string, DamageState> = {},
): MediaManager & {
  failed: Array<[string, string, number, string]>;
  statuses: Record<string, MediaState>;
  damage: Store<Record<string, DamageState>>;
  damageReads: () => number;
} {
  const failed: Array<[string, string, number, string]> = [];
  const store = new Store<Record<string, DamageState>>(damage);
  let reads = 0;
  const get = store.get.bind(store);
  store.get = () => {
    reads++;
    return get();
  };
  const m = {
    statuses,
    failed,
    status: { get: () => m.statuses },
    damage: store,
    damageReads: () => reads,
    playbackFailed(id: string, url: string, code: number, message: string): void {
      failed.push([id, url, code, message]);
    },
  };
  return m as unknown as MediaManager & typeof m;
}

let nextId = 0;

/** A video MediaRef whose ready url is `url:<name>`. */
export function videoMedia(name: string, duration: number): MediaRef {
  return {
    id: `m-${name}-${nextId++}`,
    path: `C:\\media\\${name}.mp4`,
    kind: "video",
    duration,
    width: 640,
    height: 360,
    hasAudio: false,
  } as MediaRef;
}

export function readyStatus(media: MediaRef): MediaState {
  return { state: "ready", url: `url:${media.path}`, sourcePath: media.path };
}

/** A clip of `media` with every mapping field set explicitly. */
export function clipOf(
  media: MediaRef,
  timelineStart: number,
  srcIn: number,
  srcOut: number,
  speed = 1,
  audio: Partial<Clip["audio"]> = {},
): Clip {
  return {
    id: `c-${nextId++}`,
    mediaId: media.id,
    timelineStart,
    srcIn,
    srcOut,
    speed,
    transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
    audio: {
      volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false,
      ...audio,
    },
  };
}

/** A project whose video tracks are given topmost first, each a clip list. */
export function projectOf(media: MediaRef[], videoTracks: Clip[][], audioTracks: Clip[][] = []): ProjectFile {
  return {
    schema: 2,
    name: "Playback test",
    media,
    markers: [],
    timeline: {
      fps: { num: 30, den: 1 },
      width: 1280,
      height: 720,
      tracks: [
        ...videoTracks.map((clips, i) => ({ id: `v${i}`, kind: "video", name: `Video ${i + 1}`, muted: false, clips })),
        ...audioTracks.map((clips, i) => ({ id: `a${i}`, kind: "audio", name: `Audio ${i + 1}`, muted: false, clips })),
      ],
    },
  } as unknown as ProjectFile;
}

/** A manual requestAnimationFrame queue and a controllable performance.now,
 *  installed on globalThis; `restore` puts the originals back. */
export function manualFrames(): {
  now: () => number;
  /** let `dtSec` of wall time pass WITHOUT a frame being delivered */
  idle: (dtSec: number) => void;
  frame: (dtSec: number, before?: (dtSec: number) => void) => void;
  pending: () => number;
  restore: () => void;
} {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const savedRaf = g.requestAnimationFrame;
  const savedCaf = g.cancelAnimationFrame;
  const savedNow = performance.now;
  let clock = 1000;
  let queue = new Map<number, () => void>();
  let id = 0;
  g.requestAnimationFrame = (cb) => {
    queue.set(++id, cb);
    return id;
  };
  g.cancelAnimationFrame = (n) => {
    queue.delete(n);
  };
  performance.now = () => clock;
  return {
    now: () => clock,
    idle(dtSec) {
      clock += dtSec * 1000;
    },
    frame(dtSec, before) {
      clock += dtSec * 1000;
      before?.(dtSec);
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) cb();
    },
    pending: () => queue.size,
    restore() {
      g.requestAnimationFrame = savedRaf;
      g.cancelAnimationFrame = savedCaf;
      performance.now = savedNow;
    },
  };
}

/** The seek pacing's injected world, under the test's control. */
export interface FakePacing {
  deps: PacingDeps;
  /** What inputKind() answers. */
  kind: SeekCause;
  /** The timers' clock (ms). */
  now(): number;
  /** Own clock only: let `ms` pass, running every timer that falls due, in
   *  order, with the clock at its due time. */
  advance(ms: number): void;
  /** Run every timer due at the current clock (for an external clock). */
  runDue(): void;
  pending(): number;
  /** What keyframeTimes answers per path: an index, null, or an Error to
   *  reject with. A path without an entry stays unanswered. */
  answers: Map<string, KeyframeIndex | null | Error>;
  /** Every keyframeTimes call, in order. */
  calls: string[];
  /** Answer every call whose path has an answer, then let the promise
   *  callbacks run. */
  flush(): Promise<void>;
  /** Release listeners currently installed (listenEnd minus its removers). */
  endListeners(): number;
  /** A pointerup: every installed release listener runs. */
  end(): void;
}

/** A fake PacingDeps. With `clock`, the timers read that clock (ms) and
 *  `runDue` runs what is due; without it, the fake keeps its own. */
export function fakePacingDeps(clock?: () => number): FakePacing {
  let own = 0;
  const now = clock ?? ((): number => own);
  let nextId = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const waiting: Array<{ path: string; resolve: (v: KeyframeIndex | null) => void; reject: (e: Error) => void }> = [];
  const ends = new Set<() => void>();
  const runUntil = (limit: number, setClock: boolean): void => {
    for (;;) {
      let best: number | null = null;
      for (const [id, t] of tasks) {
        if (t.at <= limit && (best === null || t.at < tasks.get(best)!.at)) best = id;
      }
      if (best === null) break;
      const t = tasks.get(best)!;
      tasks.delete(best);
      if (setClock) own = Math.max(own, t.at);
      t.fn();
    }
  };
  const f: FakePacing = {
    kind: "none",
    answers: new Map(),
    calls: [],
    now,
    advance(ms) {
      if (clock !== undefined) throw new Error("advance() needs the fake's own clock");
      const target = own + ms;
      runUntil(target, true);
      own = target;
    },
    runDue() {
      runUntil(now(), false);
    },
    pending: () => tasks.size,
    async flush() {
      for (let i = waiting.length - 1; i >= 0; i--) {
        const w = waiting[i]!;
        if (!f.answers.has(w.path)) continue;
        waiting.splice(i, 1);
        const a = f.answers.get(w.path)!;
        if (a instanceof Error) w.reject(a);
        else w.resolve(a);
      }
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    endListeners: () => ends.size,
    end() {
      for (const fn of [...ends]) fn();
    },
    deps: {
      timers: {
        now: () => now(),
        setTimeout: (fn, ms) => {
          tasks.set(++nextId, { at: now() + ms, fn });
          return nextId;
        },
        clearTimeout: (id) => {
          if (id !== undefined) tasks.delete(id);
        },
      },
      inputKind: () => f.kind,
      keyframeTimes: (path) => {
        f.calls.push(path);
        return new Promise((resolve, reject) => waiting.push({ path, resolve, reject }));
      },
      listenEnd: (fn) => {
        const wrapped = (): void => fn();
        ends.add(wrapped);
        return () => {
          ends.delete(wrapped);
        };
      },
    },
  };
  return f;
}
