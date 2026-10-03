// The timeline canvas's wheel: Ctrl zooms, a plain notch pans, Shift pans three
// times as far. Driven through the REAL attachInteractions handler against the
// smallest canvas and window it needs (vite.config pins `environment: "node"`).
//
// WebView2 turns Shift+wheel into a HORIZONTAL wheel — deltaX set, deltaY 0 —
// which ink.test.ts pins for the image editor's canvas. A handler that read only
// deltaY therefore panned by 0 on every Shift notch and every sideways trackpad
// swipe. Fixture deltas differ on both axes, and from each other, so a handler
// that read the wrong axis, or dropped the Shift factor, lands on a different t0.

import { afterEach, describe, expect, it } from "vitest";
import { attachInteractions } from "./interactions";
import type { TimelineController } from "./timeline";

type AnyFn = (e: unknown) => void;

const PPS = 10;

function harness(): {
  wheel(e: Partial<WheelEvent>): void;
  view: { t0: number; pxPerSec: number };
  pans: number[];
  zooms: number;
  detach(): void;
} {
  const listeners = new Map<string, AnyFn[]>();
  const add = (t: string, fn: AnyFn): void => void listeners.set(t, [...(listeners.get(t) ?? []), fn]);
  const canvas = {
    style: { cursor: "" },
    addEventListener: add,
    removeEventListener: (): void => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 231 }),
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  const view = { t0: 20, pxPerSec: PPS, width: 700, height: 231 };
  const pans: number[] = [];
  let zooms = 0;
  const tl = {
    canvas,
    view,
    // TimelineController.panBy, verbatim in effect.
    panBy(px: number) {
      pans.push(px);
      view.t0 = Math.max(0, view.t0 + px / view.pxPerSec);
    },
    zoomAt() {
      zooms++;
    },
    requestRender() {},
  };
  const detach = attachInteractions(tl as unknown as TimelineController);
  return {
    wheel(e) {
      const ev = { deltaX: 0, deltaY: 0, shiftKey: false, ctrlKey: false, clientX: 0, clientY: 0, preventDefault() {}, ...e };
      for (const fn of listeners.get("wheel") ?? []) fn(ev);
    },
    view,
    pans,
    get zooms() {
      return zooms;
    },
    detach,
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("timeline wheel pan", () => {
  it("Shift+wheel as WebView2 delivers it (deltaX only) fast-pans three times the notch", () => {
    const h = harness();
    h.wheel({ deltaX: 100, deltaY: 0, shiftKey: true });
    expect(h.pans).toEqual([300]);
    expect(h.view.t0).toBe(20 + 300 / PPS);
    h.detach();
  });

  it("a sideways trackpad swipe (deltaX, no Shift) pans by its own amount", () => {
    const h = harness();
    h.wheel({ deltaX: -70, deltaY: 0 });
    expect(h.pans).toEqual([-70]);
    expect(h.view.t0).toBe(20 - 70 / PPS);
    h.detach();
  });

  it("a plain vertical notch still pans by deltaY, and wins over a stray deltaX", () => {
    const h = harness();
    h.wheel({ deltaX: 0, deltaY: 40 });
    h.wheel({ deltaX: 9, deltaY: -25 });
    expect(h.pans).toEqual([40, -25]);
    h.detach();
  });

  it("a wheel event with no movement on either axis pans nothing", () => {
    const h = harness();
    h.wheel({ deltaX: 0, deltaY: 0, shiftKey: true });
    expect(h.pans).toEqual([]);
    expect(h.view.t0).toBe(20);
    h.detach();
  });

  it("Ctrl+wheel still zooms and never pans", () => {
    const h = harness();
    h.wheel({ deltaY: -120, ctrlKey: true });
    expect(h.zooms).toBe(1);
    expect(h.pans).toEqual([]);
    h.detach();
  });
});
