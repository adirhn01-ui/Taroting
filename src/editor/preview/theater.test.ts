import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Element fullscreen needs a user activation and a real document; theater's
// in-window stage is the whole mode without it (see ui/fullscreen.ts).
vi.mock("../../ui/fullscreen", () => ({
  elementFullscreen: () => ({ request: () => {}, release: () => {}, holds: () => false, dispose: () => {} }),
}));

import type { MonitorVolumeController } from "../../core/monitor-volume";
import type { PlaybackEngine } from "../playback/engine";
import { mountTheater } from "./theater";

/*
 * What entering theater does to a canvas drag in flight. The canvas turns
 * view-only (the overlay is display:none under .theater), so a move or scale
 * drag that survived the switch went on editing the project out of sight and
 * committed on its eventual pointerup. Entering must drop it first — through
 * the overlay's cancelGesture, which reverts and KEEPS the selection — and
 * never by an Escape outside crop mode, which would clear the selection.
 *
 * vite.config pins `environment: "node"`: the DOM below is a small fake that
 * records only what this file asserts on (the order of calls, and which
 * events reached the overlay).
 */

interface FakeEl {
  className: string;
  innerHTML: string;
  style: Record<string, string>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  querySelector(sel: string): FakeEl | null;
  appendChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: unknown): void;
  removeEventListener(type: string, fn: unknown): void;
  dispatchEvent(e: { type: string; key?: string }): boolean;
  setAttribute(k: string, v: string): void;
  remove(): void;
  blur(): void;
  value: string;
  textContent: string;
}

function fakeEl(kids: Map<string, FakeEl | null> = new Map()): FakeEl {
  const classes = new Set<string>();
  const el: FakeEl = {
    className: "",
    innerHTML: "",
    style: {},
    value: "",
    textContent: "",
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      toggle: (c, on) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    // Memoized per selector, so the bar's buttons are stable objects; a
    // selector mapped to null is "not in the container".
    querySelector(sel: string): FakeEl | null {
      if (kids.has(sel)) return kids.get(sel)!;
      const k = fakeEl();
      kids.set(sel, k);
      return k;
    },
    appendChild: (c) => c,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setAttribute: () => {},
    remove: () => {},
    blur: () => {},
  };
  return el;
}

/** Every call the test cares about, in order. */
let log: string[] = [];

/** A container holding a mounted canvas overlay; `cropOpen` is whether the
 *  crop window currently renders (crop mode). */
function container(cropOpen: boolean): FakeEl {
  const overlay = fakeEl();
  overlay.dispatchEvent = (e) => {
    log.push(`overlay:${e.type}:${e.key ?? ""}`);
    return true;
  };
  const win = fakeEl();
  win.style.display = cropOpen ? "block" : "none";
  return fakeEl(new Map<string, FakeEl | null>([
    [".stage-overlay", overlay],
    [".stage-overlay__window", win],
  ]));
}

function mount(cropOpen: boolean, withCancel = true) {
  const engine = {
    playing: false,
    time: 2,
    fps: () => 30,
    duration: () => 10,
    onTick: () => () => {},
    seek: () => {},
    toggle: () => {},
  } as unknown as PlaybackEngine;
  const volume = {
    get: () => ({ level: 1, muted: false }),
    subscribe: () => () => {},
    setLevel: () => {},
    toggleMute: () => {},
  } as unknown as MonitorVolumeController;
  const c = container(cropOpen);
  const theater = mountTheater({
    engine,
    container: c as unknown as HTMLElement,
    volume,
    onChange: (on) => log.push(`onChange:${on}`),
    cancelGesture: withCancel ? () => log.push("cancelGesture") : undefined,
  });
  return { theater, c };
}

beforeEach(() => {
  log = [];
  vi.stubGlobal("document", {
    createElement: () => fakeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    activeElement: null,
  });
  vi.stubGlobal("window", {
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
  vi.stubGlobal("getComputedStyle", (el: FakeEl) => ({ display: el.style.display ?? "" }));
  vi.stubGlobal(
    "KeyboardEvent",
    class {
      type: string;
      key: string;
      constructor(type: string, init: { key: string }) {
        this.type = type;
        this.key = init.key;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("entering theater with a canvas drag in flight", () => {
  it("cancels the drag through the overlay, before anything else happens", () => {
    const { theater } = mount(false);
    theater.enter();
    expect(theater.isActive()).toBe(true);
    // First, and exactly once — and outside crop mode, no Escape at all: an
    // Escape on the idle overlay clears the selection.
    expect(log).toEqual(["cancelGesture", "onChange:true"]);
  });

  it("cancels the drag BEFORE leaving crop mode, which still goes by Escape", () => {
    const { theater } = mount(true);
    theater.enter();
    expect(log).toEqual(["cancelGesture", "overlay:keydown:Escape", "onChange:true"]);
  });

  it("asks once per entry, not on exit, and again on the next entry", () => {
    const { theater } = mount(false);
    theater.enter();
    theater.enter(); // already active: a no-op
    theater.exit();
    theater.toggle();
    expect(log.filter((l) => l === "cancelGesture")).toHaveLength(2);
  });

  it("still enters when no canceller is wired", () => {
    const { theater } = mount(true, false);
    theater.enter();
    expect(theater.isActive()).toBe(true);
    expect(log).toEqual(["overlay:keydown:Escape", "onChange:true"]);
  });
});
