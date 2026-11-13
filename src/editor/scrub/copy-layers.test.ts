// The per-layer copies against fakes: <video> stand-ins with settable
// seeking / readyState / currentTime and an event list, crop boxes that
// record their children, a hand-run animation-frame queue and hand-run
// timers. Every real element is a FROZEN proxy whose set trap throws: the
// copies may read it, never write it. Positions, urls and files differ on
// every axis.

import { describe, expect, it } from "vitest";
import { ScrubCopyLayers, type SlotView } from "./copy-layers";
import { CATCHUP_MAX_MS, COPY_STALL_MS, IDLE_RELEASE_MS } from "./precheck";

interface FakeVideo {
  seeking: boolean;
  readyState: number;
  currentTime: number;
  error: { code: number } | null;
  style: Record<string, string>;
  parentElement: unknown;
  src: string;
  /** "t=…", "src=…", "load", "remove" in order. */
  log: string[];
  fire(type: string): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  load(): void;
  remove(): void;
  listeners(type: string): number;
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
    log: [] as string[],
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    addEventListener: (type: string, fn: () => void) => {
      const s = listeners.get(type) ?? new Set();
      s.add(fn);
      listeners.set(type, s);
    },
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    listeners: (type: string) => listeners.get(type)?.size ?? 0,
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    load: () => void v.log.push("load"),
    remove: () => {
      v.parentElement = null;
      v.log.push("remove");
    },
  } as unknown as FakeVideo;
  Object.defineProperty(v, "currentTime", {
    get: () => time,
    set: (t: number) => {
      time = t;
      v.log.push(`t=${t}`);
    },
  });
  Object.defineProperty(v, "src", {
    get: () => attrs.get("src") ?? "",
    set: (s: string) => {
      attrs.set("src", s);
      v.log.push(`src=${s}`);
    },
  });
  return v;
}

/** A real element as the copies see it: readable, never writable. */
function frozenMain(): { proxy: HTMLVideoElement; state: FakeVideo } {
  const state = fakeVideo();
  state.readyState = 4;
  state.style.width = "800px";
  state.style.height = "450px";
  state.style.transform = "translate(-40px, -16px)";
  state.style.display = "";
  const style = new Proxy(state.style, {
    set: () => {
      throw new Error("the copy wrote the real element's style");
    },
  });
  const proxy = new Proxy(state, {
    get: (t, k) => (k === "style" ? style : (t as unknown as Record<string | symbol, unknown>)[k]),
    set: (_t, k) => {
      throw new Error(`the copy wrote the real element's ${String(k)}`);
    },
  });
  return { proxy: proxy as unknown as HTMLVideoElement, state };
}

interface FakeSlot {
  slot: SlotView;
  main: FakeVideo;
  crop: { children: unknown[] };
}

function fakeSlot(): FakeSlot {
  const { proxy, state } = frozenMain();
  const crop = {
    children: [] as unknown[],
    appendChild(n: FakeVideo) {
      n.parentElement = crop;
      crop.children.push(n);
      return n;
    },
  };
  return { slot: { pos: { style: { display: "" } } as HTMLElement, crop: crop as unknown as HTMLElement, media: proxy }, main: state, crop };
}

function harness() {
  const made: FakeVideo[] = [];
  let rafs: Array<() => void> = [];
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const stalls: string[] = [];
  const errors: string[] = [];
  const layers = new ScrubCopyLayers({
    createVideo: () => {
      const v = fakeVideo();
      made.push(v);
      return v as unknown as HTMLVideoElement;
    },
    stalled: (f, r) => void stalls.push(`${f}: ${r}`),
    elementError: (f, d) => void errors.push(`${f}: ${d}`),
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
  });
  return {
    layers,
    made,
    stalls,
    errors,
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
    pending: () => timers.size,
  };
}

const URL_A = "asset://C:/cache/scrub/match.scrub2.mp4";
const URL_B = "asset://C:/cache/scrub/replay.scrub2.mp4";
const FILE_A = "D:\\rec\\match.mp4";
const FILE_B = "E:\\obs\\replay.mov";

/** Land the copy's pending seek: settled, readable, `seeked` fired. */
function land(v: FakeVideo): void {
  v.seeking = false;
  v.readyState = 4;
  v.fire("seeked");
}

/** A held drag with a loaded copy on layer 0 that has shown `t1`. */
function shownAt(t1: number) {
  const h = harness();
  const s = fakeSlot();
  h.layers.press(false);
  h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
  const c = h.made[0]!;
  c.readyState = 2;
  c.fire("loadeddata");
  land(c);
  h.frames();
  h.layers.setMoved();
  h.layers.follow(0, s.slot, URL_A, FILE_A, t1);
  land(c);
  h.frames();
  return { h, s, c };
}

describe("placement and mirroring", () => {
  it("goes into the SHOWN slot's crop, after the real element, and moves when A flips to B", () => {
    const h = harness();
    const a = fakeSlot();
    const b = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, a.slot, URL_A, FILE_A, 1);
    const c = h.made[0]!;
    expect(c.parentElement).toBe(a.crop);
    h.layers.follow(0, b.slot, URL_A, FILE_A, 1.2);
    expect(c.parentElement).toBe(b.crop);
    expect(h.made).toHaveLength(1);
  });

  it("mirrors the real element's size and offset, writing only on change", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 1);
    const c = h.made[0]!;
    expect([c.style.width, c.style.height, c.style.transform]).toEqual(["800px", "450px", "translate(-40px, -16px)"]);
    let writes = 0;
    const style = c.style;
    c.style = new Proxy(style, {
      set: (t, k, v) => {
        if (k !== "display") writes++;
        t[k as string] = v as string;
        return true;
      },
    });
    h.layers.follow(0, s.slot, URL_A, FILE_A, 1.3);
    expect(writes).toBe(0);
    s.main.style.width = "960px";
    h.layers.follow(0, s.slot, URL_A, FILE_A, 1.6);
    expect(writes).toBe(1);
    expect(c.style.width).toBe("960px");
  });
});

describe("seeks", () => {
  it("waits for the copy to load, then one seek in flight with the newest waiting", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    expect(c.log).toEqual([`src=${URL_A}`]);
    c.readyState = 2;
    c.fire("loadeddata");
    expect(c.log).toEqual([`src=${URL_A}`, "t=2.5"]);
    c.seeking = true;
    h.layers.follow(0, s.slot, URL_A, FILE_A, 3.1);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 4.7);
    expect(c.log.filter((l) => l.startsWith("t="))).toEqual(["t=2.5"]);
    land(c);
    expect(c.log.filter((l) => l.startsWith("t="))).toEqual(["t=2.5", "t=4.7"]);
  });

  it("makes no seek within 0.01 s of where the copy is", () => {
    const { h, s, c } = shownAt(3.3);
    const before = c.log.length;
    h.layers.follow(0, s.slot, URL_A, FILE_A, 3.305);
    expect(c.log.length).toBe(before);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 3.32);
    expect(c.log[c.log.length - 1]).toBe("t=3.32");
  });

  it("a seek that does not land in 3000 ms fails the file", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    c.readyState = 2;
    c.fire("loadeddata");
    h.advance(COPY_STALL_MS - 1);
    expect(h.stalls).toEqual([]);
    h.advance(1);
    expect(h.stalls).toEqual([`${FILE_A}: a seek of the copy did not land (decode stall)`]);
    expect(c.hasAttribute("src")).toBe(false);
  });

  it("an element error is reported once with its file and unloads the copy", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.follow(0, s.slot, URL_B, FILE_B, 1);
    const c = h.made[0]!;
    c.error = { code: 4 };
    c.fire("error");
    c.fire("error");
    expect(h.errors).toEqual([`${FILE_B}: media error 4`]);
    expect(c.hasAttribute("src")).toBe(false);
  });
});

describe("showing", () => {
  it("a press alone never shows", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    c.readyState = 2;
    c.fire("loadeddata");
    land(c);
    h.frames();
    expect(c.style.display).toBe("none");
  });

  it("needs seeked AND two animation frames", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    c.readyState = 2;
    c.fire("loadeddata");
    h.layers.setMoved();
    h.layers.follow(0, s.slot, URL_A, FILE_A, 5.9);
    expect(c.style.display).toBe("none");
    land(c);
    expect(c.style.display).toBe("none");
    h.frames(1);
    expect(c.style.display).toBe("none");
    h.frames(1);
    expect(c.style.display).toBe("block");
  });

  it("a frame from an older drag never shows", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    c.readyState = 2;
    c.fire("loadeddata");
    land(c);
    h.layers.setMoved();
    h.layers.follow(0, s.slot, URL_A, FILE_A, 6.4);
    // A new press before the frame landed: its frame belongs to the old drag.
    h.layers.press(false);
    h.layers.setMoved();
    land(c);
    h.frames();
    expect(c.style.display).toBe("none");
  });

  it("a frame from an older src never shows", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(false);
    h.layers.setMoved();
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    c.readyState = 2;
    c.fire("loadeddata");
    // URL_A's frame lands; its two animation frames have not passed yet.
    land(c);
    // The layer switches to another file's copy, which loads at once (its
    // first seek is still out) before URL_A's frame is counted.
    h.layers.follow(0, s.slot, URL_B, FILE_B, 7.1);
    c.readyState = 4;
    c.fire("loadeddata");
    expect(c.log[c.log.length - 1]).toBe("t=7.1");
    h.frames();
    expect(c.style.display).toBe("none");
  });

  it("a tick the pointer did not cause hides at once", () => {
    const { h, c } = shownAt(4.4);
    expect(c.style.display).toBe("block");
    h.layers.interrupt();
    expect(c.style.display).toBe("none");
  });

  it("a drag that began while playing never shows", () => {
    const h = harness();
    const s = fakeSlot();
    h.layers.press(true);
    h.layers.follow(0, s.slot, URL_A, FILE_A, 2.5);
    const c = h.made[0]!;
    c.readyState = 2;
    c.fire("loadeddata");
    h.layers.setMoved();
    h.layers.follow(0, s.slot, URL_A, FILE_A, 3.9);
    land(c);
    h.frames();
    expect(c.style.display).toBe("none");
    expect(c.log.filter((l) => l.startsWith("t="))).toEqual([]);
  });

  it("hide() takes only that layer down", () => {
    const h = harness();
    const s0 = fakeSlot();
    const s1 = fakeSlot();
    h.layers.press(false);
    h.layers.follow(0, s0.slot, URL_A, FILE_A, 1);
    h.layers.follow(1, s1.slot, URL_B, FILE_B, 2);
    for (const c of h.made) {
      c.readyState = 2;
      c.fire("loadeddata");
      land(c);
    }
    h.layers.setMoved();
    h.layers.follow(0, s0.slot, URL_A, FILE_A, 1.5);
    h.layers.follow(1, s1.slot, URL_B, FILE_B, 2.5);
    for (const c of h.made) land(c);
    h.frames();
    expect(h.made.map((c) => c.style.display)).toEqual(["block", "block"]);
    h.layers.hide(1);
    expect(h.made.map((c) => c.style.display)).toEqual(["block", "none"]);
  });
});

describe("catching up", () => {
  it("hides once the real element is settled at the target and two frames passed", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.seeking = true;
    s.main.currentTime = 4.4;
    h.layers.release();
    h.frames();
    expect(c.style.display).toBe("block");
    s.main.seeking = false;
    s.main.fire("seeked");
    h.frames(1);
    expect(c.style.display).toBe("block");
    h.frames(1);
    expect(c.style.display).toBe("none");
    expect(s.main.listeners("seeked")).toBe(0);
  });

  it("a real element settled elsewhere does not count", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.currentTime = 1.0;
    h.layers.release();
    s.main.fire("seeked");
    h.frames();
    expect(c.style.display).toBe("block");
  });

  it("a move to a new position during the catch-up keeps the copy up", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.seeking = true;
    h.layers.rest();
    h.layers.follow(0, s.slot, URL_A, FILE_A, 6.2);
    s.main.seeking = false;
    s.main.currentTime = 4.4;
    s.main.fire("seeked");
    h.frames();
    expect(c.style.display).toBe("block");
  });

  it("a move that keeps the position does not stop the catch-up", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.seeking = true;
    h.layers.rest();
    // The pointer moved along the ruler without changing the time.
    h.layers.follow(0, s.slot, URL_A, FILE_A, 4.405);
    s.main.seeking = false;
    s.main.currentTime = 4.4;
    s.main.fire("seeked");
    h.frames();
    expect(c.style.display).toBe("none");
  });

  it("the catch-up looks for the real element at the latest target", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.seeking = true;
    h.layers.rest();
    // Within SAME_POSITION_S of 4.4 (no cancel), but the element lands
    // farther than that from 4.4 and within it of 4.408.
    h.layers.follow(0, s.slot, URL_A, FILE_A, 4.408);
    s.main.seeking = false;
    s.main.currentTime = 4.416;
    s.main.fire("seeked");
    h.frames();
    expect(c.style.display).toBe("none");
  });

  it("a caught-up copy stays hidden on a move that does not restart the rest", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.currentTime = 4.4;
    h.layers.rest();
    h.frames();
    expect(c.style.display).toBe("none");
    h.layers.follow(0, s.slot, URL_A, FILE_A, 4.43, false);
    land(c);
    h.frames();
    expect(c.style.display).toBe("none");
  });

  it("a caught-up copy does not cover the exact frame again on a move that keeps the position", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.currentTime = 4.4;
    h.layers.rest();
    h.frames();
    expect(c.style.display).toBe("none");
    h.layers.follow(0, s.slot, URL_A, FILE_A, 4.4);
    h.frames();
    expect(c.style.display).toBe("none");
    // A new position shows it again (its own frame first).
    h.layers.follow(0, s.slot, URL_A, FILE_A, 7.9);
    land(c);
    h.frames();
    expect(c.style.display).toBe("block");
  });

  it("a real element that never settles is hidden at 4000 ms", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.seeking = true;
    h.layers.release();
    h.advance(CATCHUP_MAX_MS - 1);
    expect(c.style.display).toBe("block");
    h.advance(1);
    expect(c.style.display).toBe("none");
  });
});

describe("letting go", () => {
  it("unloads every copy 30 s after the last one hid", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.currentTime = 4.4;
    h.layers.release();
    h.frames();
    expect(c.style.display).toBe("none");
    h.advance(IDLE_RELEASE_MS - 1);
    expect(c.hasAttribute("src")).toBe(true);
    h.advance(1);
    expect(c.hasAttribute("src")).toBe(false);
  });

  it("a press before then keeps the copy loaded", () => {
    const { h, s, c } = shownAt(4.4);
    s.main.currentTime = 4.4;
    h.layers.release();
    h.frames();
    h.advance(IDLE_RELEASE_MS - 10);
    h.layers.press(false);
    h.advance(IDLE_RELEASE_MS);
    expect(c.hasAttribute("src")).toBe(true);
  });

  it("a playing tick unloads at once", () => {
    const { h, c } = shownAt(4.4);
    h.layers.setPlaying(true);
    expect(c.style.display).toBe("none");
    expect(c.hasAttribute("src")).toBe(false);
    expect(c.log[c.log.length - 1]).toBe("load");
  });

  it("dispose removes the elements and leaves no timer", () => {
    const { h, c } = shownAt(4.4);
    h.layers.dispose();
    expect(c.log.slice(-2)).toEqual(["load", "remove"]);
    expect(h.pending()).toBe(0);
  });
});

describe("I2: the real element is never written", () => {
  it("a full press / move / rest / release / step / play sequence leaves the frozen element alone", () => {
    const h = harness();
    const s = fakeSlot();
    expect(() => {
      h.layers.press(false);
      h.layers.follow(0, s.slot, URL_A, FILE_A, 1);
      const c = h.made[0]!;
      c.readyState = 2;
      c.fire("loadeddata");
      land(c);
      h.layers.setMoved();
      for (const t of [1.4, 2.9, 2.2]) {
        h.layers.follow(0, s.slot, URL_A, FILE_A, t);
        land(c);
        h.frames();
      }
      h.layers.rest();
      s.main.fire("seeked");
      h.frames();
      h.layers.release();
      h.layers.interrupt();
      h.layers.setPlaying(true);
      h.advance(CATCHUP_MAX_MS + IDLE_RELEASE_MS);
      h.layers.dispose();
    }).not.toThrow();
  });
});
