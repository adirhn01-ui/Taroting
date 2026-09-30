// The viewer shell against a fake DOM: what the arrows and the folder listing
// do, driven through the real mountViewer. vite.config pins `environment:
// "node"`, so every element is a small fake (attributes, hidden, disabled,
// text) and everything the viewer reaches outside itself is mocked — the
// loader, IPC, fullscreen, the monitor volume and the shortcut manager, whose
// handlers the tests call directly as a key press would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiblingWindow } from "../core/ipc";

const m = vi.hoisted(() => ({
  listSiblings: vi.fn(),
  forgetSiblingOrder: vi.fn(),
  navigate: vi.fn(),
  /** The items of the last menu the viewer opened. */
  menu: [] as { label: string; onSelect: () => void }[],
  keys: new Map<string, (e: { repeat: boolean }) => void>(),
}));

vi.mock("./loader", () => ({
  DIRECT_TIMEOUT_MS: 4000,
  createSourceLoader: () => ({
    load: () => {},
    prepare: () => {},
    directFailed: () => {},
    handOff: async () => {},
    debug: () => ({ loads: 0, lastClass: null, jobId: null }),
    dispose: () => {},
  }),
}));
vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...real,
    ipc: { ...real.ipc, listSiblings: m.listSiblings, forgetSiblingOrder: m.forgetSiblingOrder },
    setWindowTitle: async () => {},
    revealInFolder: async () => {},
  };
});
vi.mock("../core/monitor-volume", () => ({
  createMonitorVolume: () => ({
    get: () => ({ level: 1, muted: false }),
    setLevel: () => {},
    toggleMute: () => {},
    subscribe: () => () => {},
    flush: () => {},
    dispose: () => {},
  }),
}));
vi.mock("../ui/fullscreen", () => ({
  elementFullscreen: () => ({ request: () => {}, release: () => {}, holds: () => false, dispose: () => {} }),
}));
vi.mock("../core/shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/shortcuts")>()),
  ShortcutManager: class {
    on(action: string, h: (e: { repeat: boolean }) => void): void {
      m.keys.set(action, h);
    }
    setSuppressed(): void {}
    setBindings(): void {}
    attach(): void {}
    detach(): void {}
  },
}));
vi.mock("../core/app-close", () => ({ registerCloseTask: () => () => {} }));
vi.mock("../ui/menu", () => ({
  showMenu: (_x: number, _y: number, items: { label: string; onSelect: () => void }[]) => {
    m.menu = items;
  },
  closeMenu: () => {},
}));
vi.mock("../ui/toast", () => ({ toast: { error: () => {}, info: () => {} } }));
vi.mock("../core/nav", () => ({ navigate: m.navigate }));
vi.mock("../core/open-media", () => ({
  openMediaAsProject: async () => "C:\\temp\\Quick view.trt",
  runOnOpenChain: (task: () => Promise<void>) => task(),
}));

import { WINDOW_RADIUS } from "./stepper";
import { mountViewer, type ViewerHandle } from "./viewer";

/* ---------------- a fake DOM, just enough for the viewer ---------------- */

interface FakeEl {
  hidden: boolean;
  disabled: boolean;
  title: string;
  textContent: string;
  [k: string]: unknown;
  querySelector(sel: string): FakeEl;
  fire(type: string): void;
}

function fakeEl(): FakeEl {
  const attrs = new Map<string, string>();
  const kids = new Map<string, FakeEl>();
  const listeners = new Map<string, () => void>();
  const el: FakeEl = {
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    value: "",
    innerHTML: "",
    className: "",
    id: "",
    alt: "",
    paused: true,
    duration: Number.NaN,
    currentTime: 0,
    readyState: 0,
    muted: false,
    volume: 1,
    style: { setProperty: () => {}, display: "" },
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    setAttribute: (k: string, v: unknown) => void attrs.set(k, String(v)),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    removeEventListener: () => {},
    /** Run the listener the viewer added for `type` (the tests' click). */
    fire: (type: string) => listeners.get(type)?.(),
    appendChild: (c: unknown) => c,
    remove: () => {},
    blur: () => {},
    focus: () => {},
    contains: () => false,
    pause: () => {},
    load: () => {},
    play: () => Promise.resolve(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    // Memoized per selector: the viewer looks each element up once, and the
    // tests look up the same one afterwards.
    querySelector(sel: string): FakeEl {
      let k = kids.get(sel);
      if (!k) {
        k = fakeEl();
        kids.set(sel, k);
      }
      return k;
    },
  };
  return el;
}

let created: FakeEl[] = [];
let views: ViewerHandle[] = [];
/** Each listSiblings call, in order, answered by the test. */
let calls: { path: string; resolve: (w: SiblingWindow) => void }[] = [];

beforeEach(() => {
  created = [];
  calls = [];
  m.keys.clear();
  m.menu = [];
  m.navigate.mockReset();
  m.forgetSiblingOrder.mockReset().mockResolvedValue(undefined);
  m.listSiblings.mockReset().mockImplementation(
    (path: string) => new Promise<SiblingWindow>((resolve) => calls.push({ path, resolve })),
  );
  vi.stubGlobal("document", {
    createElement: () => {
      const e = fakeEl();
      created.push(e);
      return e;
    },
    querySelector: () => null,
    activeElement: null,
  });
  // Timers are looked up at call time, so vi.useFakeTimers() reaches them.
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t?: ReturnType<typeof setTimeout>) => clearTimeout(t),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

afterEach(() => {
  for (const v of views) v.dispose();
  views = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(path: string): FakeEl {
  views.push(mountViewer(fakeEl() as unknown as HTMLElement, path));
  // The viewer's own root is the first element it creates.
  return created[0]!;
}

/** Dispose the one mounted viewer now (afterEach would, too late to assert). */
function unmount(): void {
  for (const v of views) v.dispose();
  views = [];
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const F = "C:\\photos\\";
const names = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, k) => `${F}${String(from + k).padStart(3, "0")}.jpg`);

/* ---------------- arrows ---------------- */

describe("the arrows and counter", () => {
  // The file on screen is hidden (or was deleted), so the backend does not
  // count it and gives no index: its one visible neighbour makes total 1. The
  // keyboard can still step there, so the mouse must be able to as well.
  it("stay up for an uncounted file with one neighbour, which ←/→ can still reach", async () => {
    const root = mount(`${F}.hidden.jpg`);
    calls[0]!.resolve({ before: [`${F}a.jpg`], after: [], index: null, total: 1, family: "visual" });
    await flush();
    const prev = root.querySelector("#vw-prev");
    const next = root.querySelector("#vw-next");
    expect(prev.hidden).toBe(false);
    expect(next.hidden).toBe(false);
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    // The count stays blank: there is no "n of 1" to show for an uncounted file.
    expect(root.querySelector("#vw-count").textContent).toBe("");
  });

  it("hide for a file alone in its folder", async () => {
    const root = mount(`${F}only.jpg`);
    calls[0]!.resolve({ before: [], after: [], index: 1, total: 1, family: "visual" });
    await flush();
    expect(root.querySelector("#vw-prev").hidden).toBe(true);
    expect(root.querySelector("#vw-next").hidden).toBe(true);
  });
});

/* ---------------- folder listing ---------------- */

describe("the folder listing", () => {
  // A held key steps near the window's edge, which starts an early refill;
  // its dwell then ends while that refill is still reading the folder, and
  // settle() queues a re-list of the same file. The refill that lands IS that
  // listing, so the folder is not read a third time — only the position is
  // announced from it.
  it("never reads the same folder twice in a row for one file", async () => {
    vi.useFakeTimers();
    const all = names(1, 100);
    const root = mount(all[0]!);
    calls[0]!.resolve({ before: [], after: all.slice(1, 5), index: 1, total: 100, family: "visual" });
    await flush();
    expect(m.listSiblings).toHaveBeenCalledTimes(1);

    // A held → (repeat): two steps from the window's edge, so a refill starts.
    // Only the opened file's listing asked Explorer for the order (fresh);
    // the refill steps in the order that listing captured.
    m.keys.get("nextFile")!({ repeat: true });
    expect(m.listSiblings).toHaveBeenCalledTimes(2);
    expect(m.listSiblings).toHaveBeenNthCalledWith(1, all[0], WINDOW_RADIUS, true);
    expect(m.listSiblings).toHaveBeenNthCalledWith(2, all[1], WINDOW_RADIUS, false);

    // The key is released; the repeat dwell ends while the refill is in flight.
    await vi.advanceTimersByTimeAsync(150);
    expect(m.listSiblings).toHaveBeenCalledTimes(2);

    // The refill lands, centred on the file on screen.
    calls[1]!.resolve({ before: all.slice(0, 1), after: all.slice(2, 18), index: 2, total: 100, family: "visual" });
    await flush();
    expect(m.listSiblings).toHaveBeenCalledTimes(2);
    expect(root.querySelector("#vw-live").textContent).toBe("002.jpg, 2 of 100");
  });

  it("still runs a queued listing for a file the user has since moved to", async () => {
    vi.useFakeTimers();
    const all = names(1, 100);
    mount(all[0]!);
    calls[0]!.resolve({ before: [], after: all.slice(1, 5), index: 1, total: 100, family: "visual" });
    await flush();
    const next = m.keys.get("nextFile")!;
    next({ repeat: true }); // → 002, the refill starts
    await vi.advanceTimersByTimeAsync(150); // settle on 002 queues its re-list
    next({ repeat: true }); // → 003 before the refill lands
    calls[1]!.resolve({ before: all.slice(0, 1), after: all.slice(2, 18), index: 2, total: 100, family: "visual" });
    await flush();
    // The queued request names 002, but 003 is on screen: it is listed again.
    expect(m.listSiblings).toHaveBeenCalledTimes(3);
  });
});

/* ---------------- Explorer's order ---------------- */

describe("the folder order", () => {
  // Every file the viewer is SENT to reads File Explorer's order afresh — the
  // user may have re-sorted the folder since — and nothing else does: a
  // settle, a refill or a step never asks Explorer again.
  it("is read afresh for a file sent to the viewer, and only then", async () => {
    vi.useFakeTimers();
    const all = names(1, 10);
    mount(all[0]!);
    calls[0]!.resolve({ before: [], after: all.slice(1), index: 1, total: 10, family: "visual" });
    await flush();
    m.keys.get("nextFile")!({ repeat: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.listSiblings).toHaveBeenCalledTimes(2);
    expect(m.listSiblings).toHaveBeenLastCalledWith(all[1], WINDOW_RADIUS, false);
    calls[1]!.resolve({ before: all.slice(0, 1), after: all.slice(2), index: 2, total: 10, family: "visual" });
    await flush();

    // A second Explorer open while the viewer is up.
    const other = "C:\\clips\\b.mp4";
    views[0]!.show(other);
    expect(m.listSiblings).toHaveBeenCalledTimes(3);
    expect(m.listSiblings).toHaveBeenLastCalledWith(other, WINDOW_RADIUS, true);
  });

  it("is dropped when the viewer is left", async () => {
    mount(`${F}a.jpg`);
    calls[0]!.resolve({ before: [], after: [], index: 1, total: 1, family: "visual" });
    await flush();
    expect(m.forgetSiblingOrder).not.toHaveBeenCalled();
    unmount();
    expect(m.forgetSiblingOrder).toHaveBeenCalledTimes(1);
  });

  // "Open as project" leaves for an editor whose exit comes straight back to
  // this file: stepping must resume in the same order even if Explorer has
  // been closed meanwhile, so the order is kept for that round trip.
  it("is kept across Open as project", async () => {
    const root = mount(`${F}a.jpg`);
    calls[0]!.resolve({ before: [], after: [`${F}b.jpg`], index: 1, total: 2, family: "visual" });
    await flush();
    root.querySelector("#vw-more").fire("click");
    m.menu.find((i) => i.label === "Open as project")!.onSelect();
    await flush();
    expect(m.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ view: "editor", returnTo: `${F}a.jpg` }),
    );
    unmount();
    expect(m.forgetSiblingOrder).not.toHaveBeenCalled();
  });
});
