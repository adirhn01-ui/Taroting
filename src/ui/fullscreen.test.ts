import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { elementFullscreen } from "./fullscreen";

/**
 * elementFullscreen is the theater's (and next the viewer's) one path to
 * element fullscreen. The in-app E2E cannot pin it: an off-screen window has
 * no user activation, so every real `requestFullscreen` rejects and none of
 * the branches below ever runs there. A stubbed `document` drives them all.
 *
 * Each case is built so it fails for one reason: a second listener shows up
 * as a count, a release that exits ANY fullscreen shows up as an exit while a
 * different element holds the screen, and the late-resolve hand-back is
 * checked both ways (stood down → handed back; still wanted → kept).
 */

let listeners: Array<() => void>;
let doc: { fullscreenElement: unknown; exits: number };

function makeEl() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const el = {
    requests: 0,
    requestFullscreen: () => {
      el.requests++;
      return new Promise<void>((r, j) => {
        resolve = r;
        reject = j;
      });
    },
  };
  return { el, resolve: () => resolve(), reject: (e: unknown) => reject(e) };
}

beforeEach(() => {
  listeners = [];
  doc = { fullscreenElement: null, exits: 0 };
  vi.stubGlobal("document", {
    get fullscreenElement() {
      return doc.fullscreenElement;
    },
    addEventListener: (t: string, fn: () => void) => {
      if (t === "fullscreenchange") listeners.push(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      if (t === "fullscreenchange") listeners = listeners.filter((f) => f !== fn);
    },
    exitFullscreen: async () => {
      doc.exits++;
      doc.fullscreenElement = null;
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const fire = (): void => listeners.forEach((f) => f());

it("binds one listener however often it is asked, and routes lost vs change", () => {
  const { el } = makeEl();
  let wanted = true;
  const lost = vi.fn();
  const change = vi.fn();
  const fs = elementFullscreen(el as unknown as HTMLElement, {
    stillWanted: () => wanted,
    onLost: lost,
    onChange: change,
  });
  // Nothing registered until asked: an unused surface carries no listener.
  expect(listeners.length).toBe(0);
  fs.request();
  fs.request();
  expect(listeners.length).toBe(1);
  // Our element takes the screen: a refit, not a loss.
  doc.fullscreenElement = el;
  fire();
  expect(change).toHaveBeenCalledTimes(1);
  expect(lost).not.toHaveBeenCalled();
  expect(fs.holds()).toBe(true);
  // OS Esc: the screen is gone while still wanted.
  doc.fullscreenElement = null;
  fire();
  expect(lost).toHaveBeenCalledTimes(1);
  // ANOTHER element takes the screen while wanted: also a departure.
  doc.fullscreenElement = {};
  fire();
  expect(lost).toHaveBeenCalledTimes(2);
  // Not wanted any more: whatever happens is only a refit.
  wanted = false;
  fire();
  expect(change).toHaveBeenCalledTimes(2);
  expect(lost).toHaveBeenCalledTimes(2);
});

it("hands fullscreen back when the request resolves after a stand-down, keeps it when still wanted", async () => {
  const a = makeEl();
  let wanted = true;
  const fs = elementFullscreen(a.el as unknown as HTMLElement, {
    stillWanted: () => wanted,
    onLost() {},
  });
  // F then Esc faster than the OS transition: release() finds nothing to exit
  // yet and has already detached.
  fs.request();
  wanted = false;
  fs.release();
  expect(doc.exits).toBe(0);
  expect(listeners.length).toBe(0);
  doc.fullscreenElement = a.el;
  a.resolve();
  await tick();
  expect(doc.exits).toBe(1);

  const b = makeEl();
  wanted = true;
  const fs2 = elementFullscreen(b.el as unknown as HTMLElement, {
    stillWanted: () => wanted,
    onLost() {},
  });
  fs2.request();
  doc.fullscreenElement = b.el;
  b.resolve();
  await tick();
  expect(doc.exits).toBe(1);
});

it("swallows a rejected request, exits only what it holds, and disposes idempotently", async () => {
  const a = makeEl();
  const other = {};
  const fs = elementFullscreen(a.el as unknown as HTMLElement, {
    stillWanted: () => true,
    onLost() {},
  });
  fs.request();
  a.reject(new Error("no user activation"));
  await tick();
  // Someone else holds the screen: release must not pull it out from under them.
  doc.fullscreenElement = other;
  fs.release();
  expect(doc.exits).toBe(0);
  fs.request();
  doc.fullscreenElement = a.el;
  fs.dispose();
  fs.dispose();
  expect(doc.exits).toBe(1);
  expect(listeners.length).toBe(0);
});
