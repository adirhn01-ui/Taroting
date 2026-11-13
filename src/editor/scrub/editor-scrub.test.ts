// The editor wiring against fakes: an engine whose seek emits its tick
// synchronously (as engine.seek does), a window whose dispatch runs the
// capture listeners, then the "target" handler (the timeline's seek) with
// eventPhase 2, then sets it back to 0 — exactly what tells a drag's tick from
// a key's. The stage's real elements are FROZEN proxies. Clip trims, speeds,
// files and times differ on every axis.

import { describe, expect, it } from "vitest";
import type { KeyframeIndex, ScrubPlan } from "../../core/ipc";
import { Store } from "../../core/store";
import { locate } from "../../core/time";
import type { Clip, MediaRef, ProjectFile, Track } from "../../core/types";
import type { DamageState, MediaState } from "../media/media";
import type { VisibleClip } from "../playback/scheduler";
import type { SlotView } from "./copy-layers";
import { mountEditorScrub, type PointerTarget } from "./editor-scrub";
import { CATCHUP_MAX_MS, DWELL_MS, REST_MS } from "./precheck";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/* ---------------- fakes ---------------- */

interface FakeVideo {
  seeking: boolean;
  readyState: number;
  currentTime: number;
  error: { code: number } | null;
  style: Record<string, string>;
  parentElement: unknown;
  src: string;
  tLog: number[];
  fire(type: string): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  load(): void;
  remove(): void;
}

function fakeVideo(): FakeVideo {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  let time = 0;
  const v = {
    seeking: false,
    readyState: 0,
    error: null,
    style: { width: "", height: "", transform: "", display: "none" } as Record<string, string>,
    parentElement: null as unknown,
    tLog: [] as number[],
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    addEventListener: (type: string, fn: () => void) => {
      const s = listeners.get(type) ?? new Set();
      s.add(fn);
      listeners.set(type, s);
    },
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    load: () => {},
    remove: () => {
      v.parentElement = null;
    },
  } as unknown as FakeVideo;
  Object.defineProperty(v, "currentTime", {
    get: () => time,
    set: (t: number) => {
      time = t;
      v.tLog.push(t);
    },
  });
  Object.defineProperty(v, "src", {
    get: () => attrs.get("src") ?? "",
    set: (s: string) => void attrs.set("src", s),
  });
  return v;
}

/** A frozen real element showing `url`: readable, never writable. */
function frozen(url: string | null): HTMLVideoElement {
  const state = {
    seeking: false,
    readyState: 4,
    currentTime: 0,
    style: { width: "640px", height: "360px", transform: "translate(0px, 0px)" },
    getAttribute: (k: string) => (k === "src" ? url : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const style = new Proxy(state.style, {
    set: () => {
      throw new Error("wrote a real element's style");
    },
  });
  return new Proxy(state, {
    get: (t, k) => (k === "style" ? style : (t as unknown as Record<string | symbol, unknown>)[k]),
    set: (_t, k) => {
      throw new Error(`wrote a real element's ${String(k)}`);
    },
  }) as unknown as HTMLVideoElement;
}

function slot(url: string | null, display: string): SlotView {
  const crop = {
    appendChild(n: FakeVideo) {
      n.parentElement = crop;
      return n;
    },
  };
  return { pos: { style: { display } } as HTMLElement, crop: crop as unknown as HTMLElement, media: frozen(url) };
}

interface PEvent {
  type: string;
  button: number;
  eventPhase: number;
}

class FakeWindow implements PointerTarget {
  readonly capture = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void, capture: boolean): void {
    expect(capture).toBe(true);
    const s = this.capture.get(type) ?? new Set();
    s.add(fn);
    this.capture.set(type, s);
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.capture.get(type)?.delete(fn);
  }
  count(): number {
    let n = 0;
    for (const s of this.capture.values()) n += s.size;
    return n;
  }
  /** Capture listeners first, then the target's handler, inside the dispatch. */
  dispatch(type: string, during: () => void, button = 0): void {
    const e: PEvent = { type, button, eventPhase: 1 };
    for (const fn of [...(this.capture.get(type) ?? [])]) fn(e as unknown as Event);
    e.eventPhase = 2;
    during();
    e.eventPhase = 0;
  }
}

class FakeEngine {
  time = 0;
  playing = false;
  subs = new Set<(t: number, p: boolean) => void>();
  onTick(fn: (t: number, p: boolean) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  seek(t: number): void {
    this.time = t;
    for (const fn of [...this.subs]) fn(this.time, this.playing);
  }
  tickPlaying(): void {
    this.playing = true;
    for (const fn of [...this.subs]) fn(this.time, true);
  }
}

/* ---------------- the project ---------------- */

const HEAVY = "D:\\rec\\match.mp4";
const LIGHT = "E:\\cam\\walk.mp4";
const urlOf = (f: string): string => `asset://play/${f}`;

const heavyMedia: MediaRef = { id: "mh", path: HEAVY, size: Math.round((63e6 * 65) / 8), mtimeMs: 3, kind: "video", duration: 65, hasAudio: true };
const lightMedia: MediaRef = { id: "ml", path: LIGHT, size: Math.round((4e6 * 40) / 8), mtimeMs: 4, kind: "video", duration: 40, hasAudio: true };

const clip = (id: string, mediaId: string, timelineStart: number, srcIn: number, speed: number, len = 20): Clip => ({
  id,
  mediaId,
  timelineStart,
  srcIn,
  srcOut: srcIn + len,
  speed,
  audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
});
const track = (id: string, clips: Clip[]): Track => ({ id, kind: "video", name: id, muted: false, clips });

function makeProject(media: MediaRef[], tracks: Track[]): ProjectFile {
  return {
    schema: 2,
    name: "p",
    media,
    timeline: { width: 1600, height: 900, fps: { num: 30, den: 1 }, tracks, markers: [] },
  } as unknown as ProjectFile;
}

const heavyIndex: KeyframeIndex = { allSync: false, times: [0, 4.17, 8.34, 12.51, 16.68], duration: 65, bytes: heavyMedia.size };

function harness(project: ProjectFile, opts: { plan?: ScrubPlan; index?: KeyframeIndex; cacheLimitMB?: number } = {}) {
  const store = new Store<ProjectFile>(project);
  const status = new Store<Record<string, MediaState>>({
    mh: { state: "ready", url: urlOf(HEAVY), sourcePath: HEAVY },
    ml: { state: "ready", url: urlOf(LIGHT), sourcePath: LIGHT },
  });
  const damage = new Store<Record<string, DamageState>>({});
  const engine = new FakeEngine();
  const win = new FakeWindow();
  const calls = { index: 0, plan: 0, cancel: 0, playbackFailed: 0 };
  // One layer set per video track; the shown slot is A and loads the clip's file.
  const stage = { layers: [] as { videoA: SlotView; videoB: SlotView }[] };
  const syncStage = (): void => {
    const vt = store.get().timeline.tracks.filter((t) => t.kind === "video");
    stage.layers = vt.map((tr) => {
      const c = tr.clips[0];
      const m = c ? store.get().media.find((x) => x.id === c.mediaId) : undefined;
      return { videoA: slot(m ? urlOf(m.path) : null, ""), videoB: slot(null, "none") };
    });
  };
  syncStage();
  const visibleClipsAt = (t: number): VisibleClip[] => {
    const out: VisibleClip[] = [];
    for (const tr of store.get().timeline.tracks) {
      if (tr.kind !== "video") continue;
      const l = locate(tr, t);
      if (l.kind !== "clip") continue;
      const m = store.get().media.find((x) => x.id === l.clip.mediaId)!;
      out.push({ clip: l.clip, track: tr, media: m });
    }
    return out;
  };
  const videoElements = (): HTMLVideoElement[] => stage.layers.flatMap((l) => [l.videoA.media, l.videoB.media]);
  const copies: FakeVideo[] = [];
  let rafs: Array<() => void> = [];
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scrub = mountEditorScrub({
    engine,
    clips: { visibleClipsAt },
    stage,
    media: { status, damage },
    getProject: () => store.get(),
    subscribeProject: (fn) => store.subscribe(() => fn()),
    ipc: {
      keyframeTimes: async () => {
        calls.index++;
        return opts.index ?? heavyIndex;
      },
      planScrub: async () => {
        calls.plan++;
        return opts.plan ?? { mode: "ready", path: "C:\\cache\\scrub\\match.scrub2.mp4" };
      },
      cancelJob: async () => {
        calls.cancel++;
        return true;
      },
      onJobEvents: async () => () => {},
      mediaUrl: (p) => `asset://cache/${p}`,
    },
    cacheLimitMB: () => opts.cacheLimitMB ?? 2048,
    win,
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id) => {
        if (id !== undefined) timers.delete(id);
      },
    },
    raf: (fn) => void rafs.push(fn),
    createVideo: () => {
      const v = fakeVideo();
      copies.push(v);
      return v as unknown as HTMLVideoElement;
    },
  });
  return {
    scrub,
    store,
    status,
    damage,
    engine,
    win,
    calls,
    copies,
    stage,
    syncStage,
    videoElements,
    /** The media manager's failure path, which the module must never reach. */
    playbackFailed: () => calls.playbackFailed,
    frames(n = 2): void {
      for (let i = 0; i < n; i++) {
        const q = rafs;
        rafs = [];
        for (const fn of q) fn();
      }
    },
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= until && (next === null || e[1].at < next[1].at)) next = e;
        if (next === null) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    timerCount: () => timers.size,
    press(t: number): void {
      win.dispatch("pointerdown", () => engine.seek(t));
    },
    move(t: number): void {
      win.dispatch("pointermove", () => engine.seek(t));
    },
    up(): void {
      win.dispatch("pointerup", () => {});
    },
    /** Every copy loaded and its pending seek landed. */
    settleCopies(): void {
      for (const c of copies) {
        if (c.readyState < 2) {
          c.readyState = 2;
          c.fire("loadeddata");
        }
        c.seeking = false;
        c.readyState = 4;
        c.fire("seeked");
      }
    },
  };
}

/** A project of one heavy clip on one track (start 2.0, in 3.0, speed 1.5). */
const oneHeavy = (): ProjectFile => makeProject([heavyMedia], [track("t1", [clip("c1", "mh", 2.0, 3.0, 1.5)])]);

/** Mounted, the heavy file weighed and its copy ready, the playhead on it. */
async function readyHarness(project = oneHeavy()) {
  const h = harness(project);
  h.engine.time = 2.4;
  h.advance(DWELL_MS);
  await flush();
  expect(h.scrub.dev.snapshot().files.map((f) => f.state)).toEqual(["ready"]);
  return h;
}

/** Press, then move to `t`, every copy settled and two frames run. */
function dragTo(h: ReturnType<typeof harness>, t: number): void {
  h.press(2.6);
  h.settleCopies();
  h.move(t);
  h.settleCopies();
  h.frames();
}

/* ---------------- the gate ---------------- */

describe("zero work without a candidate (I4)", () => {
  it("a light project holds no listener, no tick, no timer, no element and calls nothing", async () => {
    const light = makeProject([lightMedia], [track("t1", [clip("c1", "ml", 0, 0, 1)])]);
    const h = harness(light);
    h.press(1);
    h.move(2);
    h.up();
    h.advance(DWELL_MS * 3);
    await flush();
    const s = h.scrub.dev.snapshot();
    expect([s.listening, s.ticking, s.indexCalls, s.planCalls, s.cancels]).toEqual([false, false, 0, 0, 0]);
    expect(h.win.count()).toBe(0);
    expect(h.engine.subs.size).toBe(0);
    expect(h.timerCount()).toBe(0);
    expect(h.copies).toHaveLength(0);
  });

  it("adding a candidate media subscribes; removing it unsubscribes", async () => {
    const light = makeProject([lightMedia], [track("t1", [clip("c1", "ml", 0, 0, 1)])]);
    const h = harness(light);
    expect(h.engine.subs.size).toBe(0);
    h.store.set({ ...light, media: [lightMedia, heavyMedia] });
    await flush();
    expect(h.engine.subs.size).toBe(1);
    expect(h.win.count()).toBe(1);
    h.store.set({ ...light, media: [lightMedia] });
    await flush();
    expect(h.engine.subs.size).toBe(0);
    expect(h.win.count()).toBe(0);
    expect(h.timerCount()).toBe(0);
  });
});

/* ---------------- asking ---------------- */

describe("when a file is asked (R3)", () => {
  it("after the paused playhead rests a second, re-armed by every paused tick", async () => {
    const h = harness(oneHeavy());
    h.engine.time = 2.4;
    h.advance(DWELL_MS - 100);
    h.engine.seek(2.5); // a paused tick re-arms
    h.advance(DWELL_MS - 100);
    await flush();
    expect(h.calls.index).toBe(0);
    h.advance(100);
    await flush();
    expect(h.calls.index).toBe(1);
  });

  it("a playing tick does not re-arm the dwell", async () => {
    const h = harness(oneHeavy());
    h.engine.time = 2.4;
    h.engine.tickPlaying();
    h.advance(DWELL_MS * 2);
    await flush();
    expect(h.calls.index).toBe(0);
  });

  it("a press asks at once, without the dwell", async () => {
    const h = harness(oneHeavy());
    h.engine.time = 3.0;
    h.press(3.0);
    await flush();
    expect(h.calls.index).toBe(1);
    expect(h.calls.plan).toBe(1);
  });
});

/* ---------------- following ---------------- */

describe("the drag (R7-R10)", () => {
  it("a tick inside a pointermove follows, and shows the frame under the playhead", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    // srcIn 3.0 + (7.0 - 2.0) * 1.5
    expect(c.currentTime).toBeCloseTo(10.5, 9);
    expect(c.style.display).toBe("block");
  });

  it("a tick outside a pointer dispatch (a frame step) hides every copy at once and needs a new frame", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    expect(c.style.display).toBe("block");
    h.engine.seek(7.0 + 1 / 30); // a keyboard step while held
    expect(c.style.display).toBe("none");
    // The next move lands within 0.01 s of where the copy is: the frame it
    // shows must be presented again (two frames) before it shows.
    h.move(7.0);
    expect(c.style.display).toBe("none");
    h.frames();
    expect(c.style.display).toBe("block");
  });

  it("a playing tick does nothing but let go of the copies", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    const seeks = c.tLog.length;
    h.engine.tickPlaying();
    expect(c.style.display).toBe("none");
    expect(c.hasAttribute("src")).toBe(false);
    h.win.dispatch("pointermove", () => h.engine.tickPlaying());
    expect(c.tLog.length).toBe(seeks);
  });

  it("a drag that starts while playing never shows, nor reloads a copy, after playback stops mid-drag", async () => {
    const h = await readyHarness();
    // The dwell preloaded the ready copy: there is an element to show.
    expect(h.copies).toHaveLength(1);
    expect(h.copies[0]!.hasAttribute("src")).toBe(true);
    h.engine.playing = true;
    h.press(2.6);
    // The playing press's tick let go of the copy.
    expect(h.copies[0]!.hasAttribute("src")).toBe(false);
    h.engine.playing = false;
    h.move(5.0);
    h.settleCopies();
    h.frames();
    h.move(6.0);
    h.settleCopies();
    h.frames();
    expect(h.copies).toHaveLength(1);
    expect(h.copies[0]!.style.display).toBe("none");
    // Nothing followed: the copy was not loaded again and nothing was seeked.
    expect(h.copies[0]!.hasAttribute("src")).toBe(false);
    expect(h.copies[0]!.tLog).toEqual([]);
  });

  it("a pointer move that keeps the time after a press does not show the copy", async () => {
    const h = await readyHarness();
    h.press(5.0);
    h.settleCopies();
    h.frames();
    // The pointer moves along the ruler: the same time, twice.
    h.move(5.0);
    h.settleCopies();
    h.frames();
    h.move(5.0);
    h.settleCopies();
    h.frames();
    expect(h.copies[0]!.style.display).toBe("none");
    h.move(6.0);
    h.settleCopies();
    h.frames();
    expect(h.copies[0]!.style.display).toBe("block");
  });

  it("an edit refreshed inside a pointer handler (an on-canvas move) is not a scrub: no copy shows", async () => {
    const h = await readyHarness();
    expect(h.copies[0]!.hasAttribute("src")).toBe(true);
    const at = h.engine.time;
    // Press on the stage: the overlay seeks nothing.
    h.win.dispatch("pointerdown", () => {});
    for (const x of [40, 95, 160]) {
      h.win.dispatch("pointermove", () => {
        const p = h.store.get();
        const [t0, ...rest] = p.timeline.tracks;
        const c0 = t0!.clips[0]!;
        const moved = { ...c0, transform: { x, y: -x / 2, scale: 1, rotate: 0, flipH: false, flipV: false, opacity: 1 } } as unknown as Clip;
        h.store.set({ ...p, timeline: { ...p.timeline, tracks: [{ ...t0!, clips: [moved] }, ...rest] } });
        h.engine.seek(at); // the overlay's refresh: the same time
      });
      h.settleCopies();
      h.frames();
      expect(h.copies[0]!.style.display).toBe("none");
    }
    expect(h.copies[0]!.tLog).toEqual([]);
    h.up();
  });

  it("an edit inside a drag hides the copy at once", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    expect(c.style.display).toBe("block");
    h.win.dispatch("pointermove", () => {
      const p = h.store.get();
      h.store.set({ ...p, timeline: { ...p.timeline, tracks: [...p.timeline.tracks] } });
      h.engine.seek(7.0);
    });
    expect(c.style.display).toBe("none");
  });

  it("a marker dropped on release (no picture changed, the playhead still) keeps the catch-up", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    expect(c.style.display).toBe("block");
    h.win.dispatch("pointerup", () => {
      const p = h.store.get();
      h.store.set({ ...p, timeline: { ...p.timeline, markers: [{ id: "m1", t: 7.0 }] } } as ProjectFile);
      h.engine.seek(7.0); // the commit's refresh
    });
    // Still up, waiting for the real element (frozen at 0, far from 10.5).
    expect(c.style.display).toBe("block");
  });

  it("an edit that changes the picture on release hides the copy", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    h.win.dispatch("pointerup", () => {
      const p = h.store.get();
      h.store.set({ ...p, timeline: { ...p.timeline, width: 1280, height: 720 } });
      h.engine.seek(7.0);
    });
    expect(c.style.display).toBe("none");
  });

  it("two layers on one heavy file at different trims: two copies, two targets, one read and one job (I5)", async () => {
    const p = makeProject(
      [heavyMedia],
      [track("top", [clip("a", "mh", 0.7, 1.3, 1.5)]), track("bottom", [clip("b", "mh", 0, 0.4, 1)])],
    );
    const h = await readyHarness(p);
    dragTo(h, 2.0);
    expect(h.copies).toHaveLength(2);
    expect(h.copies[0]!.currentTime).toBeCloseTo(3.25, 9);
    expect(h.copies[1]!.currentTime).toBeCloseTo(2.4, 9);
    expect(h.copies.map((c) => c.style.display)).toEqual(["block", "block"]);
    const s = h.scrub.dev.snapshot();
    expect([s.indexCalls, s.planCalls]).toEqual([1, 1]);
  });

  it("crossing into a light clip mid-drag hides only that layer", async () => {
    const p = makeProject(
      [heavyMedia, lightMedia],
      [track("top", [clip("a", "mh", 0, 1, 1, 20)]), track("bottom", [clip("b", "mh", 0, 0, 1, 5), clip("c", "ml", 5, 0, 1, 20)])],
    );
    const h = await readyHarness(p);
    dragTo(h, 3.0);
    expect(h.copies.map((c) => c.style.display)).toEqual(["block", "block"]);
    // The bottom layer's slot now loads the light file.
    h.stage.layers[1]!.videoA = slot(urlOf(LIGHT), "");
    h.move(6.0);
    h.settleCopies();
    h.frames();
    expect(h.copies.map((c) => c.style.display)).toEqual(["block", "none"]);
  });

  it("I12: the copies are never among the real elements, and a copy error reaches no playback failure", async () => {
    const h = await readyHarness();
    const before = h.videoElements();
    dragTo(h, 7.0);
    const after = h.videoElements();
    expect(after).toHaveLength(before.length);
    after.forEach((el, i) => expect(el).toBe(before[i]));
    const c = h.copies[0]!;
    c.error = { code: 3 };
    c.fire("error");
    expect(h.playbackFailed()).toBe(0);
  });

  it("I2: press / move / rest / release / step / play never writes a real element", async () => {
    const h = await readyHarness();
    expect(() => {
      dragTo(h, 7.0);
      h.move(8.2);
      h.settleCopies();
      h.frames();
      h.advance(200);
      h.up();
      h.frames();
      h.engine.seek(8.3);
      h.engine.tickPlaying();
      h.advance(40000);
      h.scrub.dispose();
    }).not.toThrow();
  });
});

/* ---------------- resting ---------------- */

// The stage's real element is frozen at 0, far from every target here, so a
// copy that rests stays up waiting for it and hides only at CATCHUP_MAX_MS
// after the rest began: the hide time tells when the rest began.
describe("the rest wait follows the playhead's time, not the pointer's events", () => {
  it("moves that ask for the same time again do not restart it", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0); // the move to 7.0 starts the wait
    const c = h.copies[0]!;
    // A hand held still: a move every 10 ms for 230 ms, all at 7.0.
    for (let i = 0; i < 23; i++) {
      h.advance(10);
      h.move(7.0);
    }
    expect(c.style.display).toBe("block");
    // Rested at REST_MS after the move to 7.0: hidden CATCHUP_MAX_MS later.
    // (Restarted by the last held move, it would rest at 230 + REST_MS.)
    h.advance(REST_MS + CATCHUP_MAX_MS - 230 - 1);
    expect(c.style.display).toBe("block");
    h.advance(1);
    expect(c.style.display).toBe("none");
  });

  it("a tremor across sub-frame times (1 px at 80 px/s) does not restart it", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    // Each move differs from the one before (12.5 ms, under one 30 fps frame).
    for (let i = 0; i < 23; i++) {
      h.advance(10);
      h.move(i % 2 === 0 ? 7.0125 : 7.0);
      h.settleCopies();
    }
    expect(c.style.display).toBe("block");
    h.advance(REST_MS + CATCHUP_MAX_MS - 230 - 1);
    expect(c.style.display).toBe("block");
    h.advance(1);
    expect(c.style.display).toBe("none");
  });

  it("small steps that add up to more than a frame from where it started restart it", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    // 7.0125 and 7.025 stay within a frame (1/30 s) of 7.0; 7.0375 does not.
    for (const t of [7.0125, 7.025, 7.0375]) {
      h.advance(20);
      h.move(t);
      h.settleCopies();
    }
    // Rested at REST_MS after the move to 7.0375 (60 ms in).
    h.advance(REST_MS + CATCHUP_MAX_MS - 1);
    expect(c.style.display).toBe("block");
    h.advance(1);
    expect(c.style.display).toBe("none");
  });

  it("a move to a new time restarts it", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    h.advance(REST_MS - 40);
    h.move(7.3);
    h.settleCopies();
    h.frames();
    expect(c.style.display).toBe("block");
    // Rested at REST_MS after the move to 7.3, not after the one to 7.0.
    h.advance(REST_MS + CATCHUP_MAX_MS - 1);
    expect(c.style.display).toBe("block");
    h.advance(1);
    expect(c.style.display).toBe("none");
  });

  it("a release rests at once, whatever the wait still had to run", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    const c = h.copies[0]!;
    h.advance(REST_MS - 60);
    h.move(7.3);
    h.settleCopies();
    h.frames();
    h.advance(20);
    h.up();
    expect(c.style.display).toBe("block");
    h.advance(CATCHUP_MAX_MS - 1);
    expect(c.style.display).toBe("block");
    h.advance(1);
    expect(c.style.display).toBe("none");
  });
});

describe("the copy fits the cache", () => {
  // Two hours at the heavy clip's bit rate: about 3.6 GB of copy at the
  // measured rate, far over a quarter of the default 2048 MB cache.
  const longIndex: KeyframeIndex = { ...heavyIndex, duration: 7200, bytes: Math.round((63e6 * 7200) / 8) };

  it("a long heavy source is weighed but never planned, neither from the dwell nor from a press", async () => {
    const h = harness(oneHeavy(), { index: longIndex });
    h.engine.time = 2.4;
    h.advance(DWELL_MS);
    await flush();
    expect(h.calls.index).toBe(1);
    expect(h.calls.plan).toBe(0);
    expect(h.scrub.dev.snapshot().files[0]!.state).toBe("failed");
    h.press(2.4);
    await flush();
    expect(h.calls.index).toBe(1);
    expect(h.calls.plan).toBe(0);
    dragTo(h, 7.0);
    expect(h.copies).toHaveLength(0);
  });

  it("the cache limit setting is what bounds it: the 65 s clip is planned under 2048 MB, not under 40 MB", async () => {
    const roomy = harness(oneHeavy());
    roomy.engine.time = 2.4;
    roomy.advance(DWELL_MS);
    await flush();
    expect(roomy.calls.plan).toBe(1);
    const tight = harness(oneHeavy(), { cacheLimitMB: 40 });
    tight.engine.time = 2.4;
    tight.advance(DWELL_MS);
    await flush();
    expect(tight.calls.index).toBe(1);
    expect(tight.calls.plan).toBe(0);
  });
});

describe("failures are silent and per file (I13)", () => {
  it("an unavailable plan fails the file and a further drag seeks no copy", async () => {
    const h = harness(oneHeavy(), { plan: { mode: "unavailable", reason: "no video stream" } });
    h.engine.time = 2.4;
    h.advance(DWELL_MS);
    await flush();
    expect(h.scrub.dev.snapshot().files[0]!.state).toBe("failed");
    dragTo(h, 7.0);
    expect(h.copies).toHaveLength(0);
  });
});

describe("leaving", () => {
  it("dispose drops every listener and timer", async () => {
    const h = await readyHarness();
    dragTo(h, 7.0);
    h.scrub.dispose();
    expect(h.win.count()).toBe(0);
    expect(h.engine.subs.size).toBe(0);
    expect(h.timerCount()).toBe(0);
    expect(h.copies[0]!.hasAttribute("src")).toBe(false);
  });

  it("removing the media while its copy is made cancels the job once", async () => {
    const h = harness(oneHeavy(), { plan: { mode: "pending", jobId: 31 } });
    h.engine.time = 2.4;
    h.advance(DWELL_MS);
    await flush();
    expect(h.scrub.dev.snapshot().files[0]!.state).toBe("making");
    h.store.set(makeProject([], []));
    await flush();
    expect(h.calls.cancel).toBe(1);
    expect(h.scrub.dev.snapshot().cancels).toBe(1);
  });
});

describe("the DEV force seams", () => {
  it("forceOnly forces the one file named (slashes and case aside) and leaves the other light video alone", async () => {
    const other: MediaRef = { ...lightMedia, id: "mo", path: "F:\clips\other.mp4" };
    const p = makeProject([lightMedia, other], [track("t1", [clip("c1", "ml", 0, 0, 1)]), track("t2", [clip("c2", "mo", 0, 0, 1)])]);
    const h = harness(p);
    h.status.set({ ...h.status.get(), mo: { state: "ready", url: urlOf(other.path), sourcePath: other.path } });
    await flush();
    expect(h.engine.subs.size).toBe(0);
    h.scrub.dev.forceOnly = "e:/CAM/walk.mp4";
    h.scrub.dev.forceHeavy = true;
    expect(h.engine.subs.size).toBe(1);
    h.press(1.0);
    await flush();
    expect(h.scrub.dev.snapshot().files.map((f) => [f.file, f.state])).toEqual([[LIGHT, "ready"]]);
    expect(h.calls.index).toBe(1);
  });
});
