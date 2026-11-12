// The viewer shell against a fake DOM: what the arrows and the folder listing
// do, what a refused <video> hands the loader and how the loader's answer is
// painted — a damaged file's pill, seek shade, cover and copy swap included —
// driven through the real mountViewer. vite.config pins `environment:
// "node"`, so every element is a small fake (attributes, hidden, disabled,
// text) and everything the viewer reaches outside itself is mocked — the
// loader, IPC, fullscreen, the monitor volume and the shortcut manager, whose
// handlers the tests call directly as a key press would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiblingWindow } from "../core/ipc";
import type { Damage, LoadState } from "./loader";

const m = vi.hoisted(() => ({
  listSiblings: vi.fn(),
  forgetSiblingOrder: vi.fn(),
  keyframeTimes: vi.fn(),
  planScrub: vi.fn(),
  cancelJob: vi.fn(),
  /** The job-event handlers the viewer subscribed (the scrub copy's). */
  jobHandlers: [] as { onDone?: (e: { id: number; output: Record<string, unknown> }) => void; onFailed?: (e: { id: number; message: string }) => void }[],
  navigate: vi.fn(),
  /** The items of the last menu the viewer opened. */
  menu: [] as { label: string; onSelect: () => void }[],
  /** Where the last menu was opened (client x, y). */
  menuAt: null as [number, number] | null,
  keys: new Map<string, (e: { repeat: boolean; shiftKey?: boolean }) => void>(),
  /** window keydown listeners the viewer added (its own, besides the manager's) */
  winKeys: [] as ((e: unknown) => void)[],
  /** The viewer's state callback, so a test can play the loader's part. */
  onState: null as null | ((p: string, s: LoadState) => void),
  prepare: vi.fn(),
  playbackFailed: vi.fn(),
  load: vi.fn(),
  openMedia: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  fsRequest: vi.fn(),
  /** ./pdf-mode was imported (its factory ran): the lazy chunk was fetched. */
  pdfImported: false,
  pdfMounts: [] as { host: Record<string, unknown>; memory: Record<string, unknown> }[],
  pdfMode: null as null | {
    open: ReturnType<typeof vi.fn>;
    goPage: ReturnType<typeof vi.fn>;
    scrollPage: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    zoom: ReturnType<typeof vi.fn>;
    owns: ReturnType<typeof vi.fn>;
    retitle: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("./loader", () => ({
  DIRECT_TIMEOUT_MS: 4000,
  createSourceLoader: (onState: (p: string, s: LoadState) => void) => {
    m.onState = onState;
    return {
      load: m.load,
      prepare: m.prepare,
      playbackFailed: m.playbackFailed,
      handOff: async () => {},
      debug: () => ({ loads: 0, lastClass: null, jobId: null }),
      dispose: () => {},
    };
  },
}));
vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      listSiblings: m.listSiblings,
      forgetSiblingOrder: m.forgetSiblingOrder,
      keyframeTimes: m.keyframeTimes,
      planScrub: m.planScrub,
      cancelJob: m.cancelJob,
    },
    onJobEvents: async (h: (typeof m.jobHandlers)[number]) => {
      m.jobHandlers.push(h);
      return () => {
        m.jobHandlers = m.jobHandlers.filter((x) => x !== h);
      };
    },
    mediaUrl: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
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
  elementFullscreen: () => ({ request: m.fsRequest, release: () => {}, holds: () => false, dispose: () => {} }),
}));
vi.mock("./pdf-mode", () => {
  m.pdfImported = true;
  return {
    mountPdfMode: (host: Record<string, unknown>, memory: Record<string, unknown>) => {
      m.pdfMounts.push({ host, memory });
      return m.pdfMode;
    },
  };
});
vi.mock("../core/shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/shortcuts")>()),
  ShortcutManager: class {
    on(action: string, h: (e: { repeat: boolean }) => void): void {
      m.keys.set(action, h);
    }
    off(action: string): void {
      m.keys.delete(action);
    }
    setSuppressed(): void {}
    setBindings(): void {}
    attach(): void {}
    detach(): void {}
  },
}));
vi.mock("../core/app-close", () => ({ registerCloseTask: () => () => {} }));
vi.mock("../ui/menu", () => ({
  showMenu: (x: number, y: number, items: { label: string; onSelect: () => void }[]) => {
    m.menu = items;
    m.menuAt = [x, y];
  },
  closeMenu: () => {},
}));
vi.mock("../ui/toast", () => ({
  toast: { error: (...a: unknown[]) => m.toastError(...a), info: (...a: unknown[]) => m.toastInfo(...a) },
}));
vi.mock("../core/nav", () => ({ navigate: m.navigate }));
vi.mock("../core/open-media", async (importOriginal) => ({
  // The real class: the viewer tells a protected PDF apart by instanceof.
  PdfProtectedError: (await importOriginal<typeof import("../core/open-media")>()).PdfProtectedError,
  openMediaAsProject: (p: string) => m.openMedia(p),
  runOnOpenChain: (task: () => Promise<void>) => task(),
}));

import { REST_MS } from "./seek-pacer";
import { WINDOW_RADIUS } from "./stepper";
import { INDEX_DWELL_MS, mountViewer, type ViewerHandle } from "./viewer";

/* ---------------- a fake DOM, just enough for the viewer ---------------- */

interface FakeEl {
  hidden: boolean;
  disabled: boolean;
  title: string;
  textContent: string;
  [k: string]: unknown;
  querySelector(sel: string): FakeEl;
  fire(type: string, event?: unknown): void;
  /** Every `src` and `currentTime` assignment, in order ("src=…", "t=…"). */
  log: string[];
  /** The inline style properties set through style.setProperty. */
  styles: Map<string, string>;
}

function fakeEl(): FakeEl {
  const attrs = new Map<string, string>();
  const kids = new Map<string, FakeEl>();
  // Every listener per type, in order: the viewer and its seek pacer both
  // listen for `seeked` on the one <video>.
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const styles = new Map<string, string>();
  const classes = new Set<string>();
  const log: string[] = [];
  const el: FakeEl = {
    log,
    styles,
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
    readyState: 0,
    muted: false,
    volume: 1,
    style: { setProperty: (k: string, v: string) => void styles.set(k, v), display: "" },
    classes,
    classList: {
      toggle: (c: string, on?: boolean) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute: (k: string, v: unknown) => void attrs.set(k, String(v)),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    addEventListener: (type: string, fn: (e?: unknown) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: () => {},
    /** Run the listeners the viewer added for `type` (the tests' click). */
    fire: (type: string, event?: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    appendChild: (c: unknown) => c,
    insertBefore: (c: unknown, ref: unknown) => {
      log.push(`insertBefore`);
      (el as { inserted?: unknown[] }).inserted = [c, ref];
      return c;
    },
    remove: () => {},
    blur: () => {},
    focus: () => {},
    contains: () => false,
    pause: () => {},
    load: () => {},
    play: () => Promise.resolve(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    // Memoized per selector: the viewer looks each element up once, and the
    // tests look up the same one afterwards. A :hover / :focus-visible query
    // is a question about the pointer and focus instead: it answers from
    // `held`, which a test sets.
    querySelector(sel: string): FakeEl {
      if (/:hover|:focus-visible/.test(sel)) return (el.held === true ? el : null) as FakeEl;
      let k = kids.get(sel);
      if (!k) {
        k = fakeEl();
        kids.set(sel, k);
      }
      return k;
    },
  };
  // The `src` property reflects the attribute, as on a real media element:
  // the viewer sets the property and its error guard reads the attribute.
  // Setting it runs the media load algorithm synchronously (HTML), which
  // pauses the element and forgets the old resource's readiness and length —
  // so whatever the viewer wants to carry over to a new src (is it playing?
  // how long was it?) must be read BEFORE the assignment, here as in Chromium.
  Object.defineProperty(el, "src", {
    get: () => attrs.get("src") ?? "",
    set: (v: unknown) => {
      attrs.set("src", String(v));
      log.push(`src=${String(v)}`);
      el.paused = true;
      el.readyState = 0;
      el.duration = Number.NaN;
    },
    enumerable: true,
  });
  let time = 0;
  Object.defineProperty(el, "currentTime", {
    get: () => time,
    set: (v: number) => {
      time = v;
      log.push(`t=${v}`);
    },
    enumerable: true,
  });
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
  m.winKeys = [];
  m.menu = [];
  m.menuAt = null;
  m.onState = null;
  m.prepare.mockReset();
  m.playbackFailed.mockReset();
  m.load.mockReset();
  m.openMedia.mockReset().mockResolvedValue("C:\\temp\\Quick view.trt");
  m.navigate.mockReset();
  m.toastInfo.mockReset();
  m.toastError.mockReset();
  m.fsRequest.mockReset();
  m.pdfMounts = [];
  m.pdfMode = {
    open: vi.fn(async () => {}),
    goPage: vi.fn(),
    scrollPage: vi.fn(),
    find: vi.fn(),
    zoom: vi.fn(),
    owns: vi.fn(() => false),
    retitle: vi.fn(),
    dispose: vi.fn(),
  };
  m.forgetSiblingOrder.mockReset().mockResolvedValue(undefined);
  m.keyframeTimes.mockReset().mockResolvedValue(null);
  m.planScrub.mockReset().mockResolvedValue({ mode: "unavailable", reason: "test default" });
  m.cancelJob.mockReset().mockResolvedValue(true);
  m.jobHandlers = [];
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
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "keydown") m.winKeys.push(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "keydown") m.winKeys = m.winKeys.filter((f) => f !== fn);
    },
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

/* ---------------- a right-click on the stage ---------------- */

describe("a right-click on the stage", () => {
  const F2 = "D:\\clips\\";
  /** A contextmenu event at (x, y) on `target`. */
  function rightClick(x: number, y: number, target: unknown = {}, answered = false) {
    return { clientX: x, clientY: y, target, defaultPrevented: answered, preventDefault: vi.fn() };
  }
  const labels = (): string[] => m.menu.map((i) => i.label);

  it("opens the More button's own rows, at the pointer", () => {
    const root = mount(`${F2}a.mp4`);
    root.querySelector("#vw-more").fire("click");
    const fromButton = labels();
    expect(fromButton).toEqual(["Open as project", "Show in folder"]);
    m.menu = [];
    // x and y differ, so a swapped pair cannot pass.
    const e = rightClick(321, 87);
    root.querySelector("#vw-stage").fire("contextmenu", e);
    expect(labels()).toEqual(fromButton);
    expect(m.menuAt).toEqual([321, 87]);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("its Open as project is the button's", async () => {
    const root = mount(`${F2}a.mp4`);
    root.querySelector("#vw-stage").fire("contextmenu", rightClick(10, 20));
    m.menu.find((i) => i.label === "Open as project")!.onSelect();
    await flush();
    expect(m.openMedia).toHaveBeenCalledWith(`${F2}a.mp4`);
  });

  it("leaves a menu that something further in already opened alone", () => {
    const root = mount(`${F2}a.pdf`);
    const e = rightClick(5, 6, {}, true);
    root.querySelector("#vw-stage").fire("contextmenu", e);
    expect(m.menuAt).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves an editable field its native menu", () => {
    const root = mount(`${F2}a.pdf`);
    for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "DIV", isContentEditable: true }]) {
      const e = rightClick(5, 6, target);
      root.querySelector("#vw-stage").fire("contextmenu", e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(m.menuAt).toBeNull();
    // An ordinary element is not mistaken for one.
    root.querySelector("#vw-stage").fire("contextmenu", rightClick(5, 6, { tagName: "DIV", isContentEditable: false }));
    expect(m.menuAt).toEqual([5, 6]);
  });

  it("offers Copy first for text selected on the stage, and copies exactly that text", async () => {
    const root = mount(`${F2}a.pdf`);
    const stage = root.querySelector("#vw-stage");
    const node = {};
    stage.contains = (n: unknown) => n === node;
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    let picked = "  two words ";
    (window as unknown as { getSelection: () => unknown }).getSelection = () => ({ anchorNode: node, toString: () => picked });
    stage.fire("contextmenu", rightClick(40, 50));
    expect(labels()).toEqual(["Copy", "Open as project", "Show in folder"]);
    // The selection changing after the click does not change what is copied.
    picked = "something else";
    m.menu[0]!.onSelect();
    await flush();
    expect(writeText).toHaveBeenCalledWith("  two words ");
    expect(m.toastError).not.toHaveBeenCalled();
  });

  it("offers no Copy for a selection elsewhere, or for one that is only spaces", () => {
    const root = mount(`${F2}a.pdf`);
    const stage = root.querySelector("#vw-stage");
    const inside = {};
    stage.contains = (n: unknown) => n === inside;
    const w = window as unknown as { getSelection: () => unknown };
    w.getSelection = () => ({ anchorNode: {}, toString: () => "text in the top bar" });
    stage.fire("contextmenu", rightClick(1, 2));
    expect(labels()).toEqual(["Open as project", "Show in folder"]);
    w.getSelection = () => ({ anchorNode: inside, toString: () => "   " });
    stage.fire("contextmenu", rightClick(1, 2));
    expect(labels()).toEqual(["Open as project", "Show in folder"]);
  });

  it("says so when the text could not be copied", async () => {
    const root = mount(`${F2}a.pdf`);
    const stage = root.querySelector("#vw-stage");
    const node = {};
    stage.contains = (n: unknown) => n === node;
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    (window as unknown as { getSelection: () => unknown }).getSelection = () => ({ anchorNode: node, toString: () => "abc" });
    stage.fire("contextmenu", rightClick(1, 2));
    m.menu[0]!.onSelect();
    await flush();
    expect(m.toastError).toHaveBeenCalledWith("Couldn't copy the text");
  });
});

/* ---------------- a refused video ---------------- */

describe("a video the WebView refuses", () => {
  const CLIP = "D:\\clips\\Replay 2026.10.04 - 21.14.33.02.mp4";
  const SRC = "asset://localhost/D%3A%5Cclips%5CReplay.mp4";
  const prepareBtn = (): FakeEl | undefined => created.find((e) => e.id === "vw-prepare");
  const ready = (tryingDirect: boolean): LoadState => ({
    state: "ready",
    element: "video",
    url: SRC,
    kind: "video",
    tryingDirect,
  });

  it("hands the element's MediaError code to the loader and paints nothing itself", () => {
    const root = mount(CLIP);
    m.onState!(CLIP, ready(false));
    const video = root.querySelector("#vw-video");
    video.error = { code: 3 };
    video.fire("error");
    expect(m.playbackFailed.mock.calls).toEqual([[3]]);
    // What the refusal earns is the loader's call, painted through onState.
    expect(root.querySelector(".viewer__status-text").textContent).toBe("");
  });

  it("does not report an error from a src it already let go of", () => {
    const root = mount(CLIP);
    m.onState!(CLIP, ready(false));
    m.onState!(CLIP, { state: "preparing", ratio: null });
    const video = root.querySelector("#vw-video");
    video.error = { code: 4 };
    video.fire("error");
    expect(m.playbackFailed).not.toHaveBeenCalled();
  });

  it("reports a container-only attempt's refusal once: its code, and no timeout after it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1 });
    const root = mount(CLIP);
    m.onState!(CLIP, ready(true));
    const video = root.querySelector("#vw-video");
    video.error = { code: 4 };
    video.fire("error");
    await vi.advanceTimersByTimeAsync(4000);
    expect(m.playbackFailed.mock.calls).toEqual([[4]]);
  });

  it("reports a container-only attempt that never reached its metadata as null", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1 });
    mount(CLIP);
    m.onState!(CLIP, ready(true));
    await vi.advanceTimersByTimeAsync(3999);
    expect(m.playbackFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.playbackFailed.mock.calls).toEqual([[null]]);
  });

  it("keeps the Prepare preview offer for a file that only needs a preview copy", () => {
    const root = mount(CLIP);
    m.onState!(CLIP, { state: "needsPrepare" });
    expect(root.querySelector(".viewer__status-text").textContent).toBe("This video needs a preview copy");
    const btn = prepareBtn();
    expect(btn?.textContent).toBe("Prepare preview");
    btn!.fire("click");
    expect(m.prepare).toHaveBeenCalledTimes(1);
  });

  it("says a repair is running for a damaged file, and a plain preparation as before", () => {
    const root = mount(CLIP);
    const text = (): string => root.querySelector(".viewer__status-text").textContent;
    const got: string[] = [];
    for (const s of [
      { state: "preparing", ratio: null, damaged: true },
      { state: "preparing", ratio: 0.404, damaged: true },
      // The instant copy being made. A ratio here (the loader never sends
      // one) would still not be shown: it is not the repair's percent.
      { state: "preparing", ratio: 0.87, damaged: true, quick: true },
      { state: "preparing", ratio: null },
      { state: "preparing", ratio: 0.34 },
    ] as LoadState[]) {
      m.onState!(CLIP, s);
      got.push(text());
    }
    expect(got).toEqual([
      "Damaged video · preparing",
      "Damaged video · repairing 40%",
      "Damaged video · preparing",
      "Preparing preview",
      "Preparing preview 34%",
    ]);
    // No offer to press: the repair is already running.
    expect(prepareBtn()).toBeUndefined();
  });
});

/* ---------------- seeking ---------------- */

describe("seeking", () => {
  const CLIP = "D:\\clips\\Replay 2026-10-01 21-09-07.mp4";
  const SRC = "asset://localhost/D%3A%5Cclips%5CReplay%202026-10-01%2021-09-07.mp4";
  const ready = (tryingDirect = false): LoadState => ({ state: "ready", element: "video", url: SRC, kind: "video", tryingDirect });

  /** A video on screen, 61 s long, at 0. */
  function mounted() {
    const root = mount(CLIP);
    m.onState!(CLIP, ready());
    const video = root.querySelector("#vw-video");
    video.duration = 61;
    video.seeking = false;
    video.log.length = 0;
    return { root, video, knob: root.querySelector(".theater-bar__seek-knob"), time: root.querySelector("#vw-time") };
  }

  /** The knob's left, as paintReadout writes it for `sec` of 61. */
  const at = (sec: number): string => `${Math.round((sec / 61) * 1000) / 10}%`;

  it("shows the asked position on the bar and the clock at once, with no event from the element", () => {
    // The editor's fullscreen bar paints its engine time the moment it seeks;
    // the viewer painted only on `seeked`/`timeupdate`, so mid-drag the knob
    // trailed the cursor. No event is fired here at all.
    const { video, knob, time } = mounted();
    m.keys.get("seekFwd")!({ repeat: false });
    expect(video.log).toEqual(["t=5"]);
    expect(knob.styles.get("left")).toBe(at(5));
    expect(time.textContent).toBe("0:05 / 1:01");
  });

  it("asks for every new position while a seek decodes, as the editor's fullscreen bar does", () => {
    const { video, knob, time } = mounted();
    m.keys.get("seekFwd")!({ repeat: false });
    video.seeking = true;
    m.keys.get("seekFwd")!({ repeat: true });
    m.keys.get("seekFwd")!({ repeat: true });
    expect(video.log).toEqual(["t=5", "t=10", "t=15"]);
    expect(knob.styles.get("left")).toBe(at(15));
    expect(time.textContent).toBe("0:15 / 1:01");
    // It lands: the element's own time is the position again. Playback moves
    // the element on to 15.6, a time nothing asked for, and the bar follows it.
    video.seeking = false;
    video.fire("seeked");
    (video as unknown as { currentTime: number }).currentTime = 15.6;
    video.fire("timeupdate");
    expect(knob.styles.get("left")).toBe(at(15.6));
    expect(video.log).toEqual(["t=5", "t=10", "t=15", "t=15.6"]);
  });

  it("keeps the asked position on the bar while the element still reports the old one", () => {
    // Chromium reads the target back at once, but a time not yet asked of it
    // (a swap holding the old copy's length, a reload) must not pull the knob.
    const { video, knob } = mounted();
    m.keys.get("seekFwd")!({ repeat: false });
    video.seeking = true;
    // The element is made to read something else mid-seek.
    (video as unknown as { currentTime: number }).currentTime = 2;
    video.log.length = 0;
    m.keys.get("seekFwd")!({ repeat: false });
    // playhead() is the ASKED 5 + 5, not the element's 2 + 5.
    expect(video.log).toEqual(["t=10"]);
    expect(knob.styles.get("left")).toBe(at(10));
  });

  it("asks nothing for a position within 10 ms of the element's, and asks one 20 ms away", () => {
    const { root, video } = mounted();
    const bar = root.querySelector("#vw-seek");
    // 6100 px for 61 s: 1 px = 10 ms, so the moves below land exactly.
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, right: 6100, bottom: 10, width: 6100, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: sec * 100, preventDefault: () => {} });
    bar.fire("pointerdown", ptr(5));
    video.fire("seeked");
    bar.fire("pointermove", ptr(5.005));
    bar.fire("pointermove", ptr(5.02));
    expect(video.log.map((e) => Math.round(Number(e.slice(2)) * 1000) / 1000)).toEqual([5, 5.02]);
  });

  it("drags like the editor's fullscreen bar: a seek per move, the knob under the hand", () => {
    const { root, video, knob } = mounted();
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    bar.fire("pointerdown", ptr(10));
    video.seeking = true;
    for (const sec of [12, 14, 16]) {
      bar.fire("pointermove", ptr(sec));
      expect(knob.styles.get("left")).toBe(at(sec));
    }
    expect(video.log.map((e) => Math.round(Number(e.slice(2)) * 1000) / 1000)).toEqual([10, 12, 14, 16]);
    bar.fire("pointerup", ptr(16));
    video.seeking = false;
    video.fire("seeked");
    expect(video.log).toHaveLength(4);
  });

  it("lets go of a held bar when the file changes: the next video is never dragged by it", () => {
    const { root, video } = mounted();
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    bar.fire("pointerdown", ptr(10));
    expect(video.log).toHaveLength(1);
    // stepped on while the button is still down
    const NEXT = String.raw`D:\clips\next.mp4`;
    views[0]!.show(NEXT);
    m.onState!(NEXT, { state: "ready", element: "video", url: "asset://localhost/next", kind: "video", tryingDirect: false });
    video.duration = 61;
    video.seeking = false;
    video.log.length = 0;
    bar.fire("pointermove", ptr(30));
    bar.fire("pointerup", ptr(30));
    expect(video.log).toEqual([]);
  });

  it("seeks straight away when nothing is decoding", () => {
    const { video } = mounted();
    m.keys.get("seekFwd")!({ repeat: false });
    m.keys.get("seekFwd")!({ repeat: false });
    m.keys.get("goStart")!({ repeat: false });
    expect(video.log).toEqual(["t=5", "t=10", "t=0"]);
  });

  it("reloads the same source where the user was after a read error, twice, then tells the loader", () => {
    const { video } = mounted();
    m.keys.get("seekFwd")!({ repeat: false });
    video.seeking = true;
    m.keys.get("seekFwd")!({ repeat: false });
    // The element reads an older position than the one asked for (10).
    (video as unknown as { currentTime: number }).currentTime = 5;
    video.log.length = 0;
    // Chromium's demuxer lost its place under a burst of seeks: MEDIA_ERR_NETWORK.
    video.error = { code: 2 };
    video.fire("error");
    // The position the user asked for (10 s), not the one that was decoding.
    expect(video.log).toEqual([`src=${SRC}`, "t=10"]);
    expect(m.playbackFailed).not.toHaveBeenCalled();
    video.duration = 61;
    video.fire("error");
    expect(m.playbackFailed).not.toHaveBeenCalled();
    video.duration = 61;
    video.fire("error");
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
  });

  it("reports a reload that fails the way a missing file does as the read failure it is", () => {
    // A file deleted while it plays: the next read fails (2), the reload's
    // first request gets a 404, which Chromium reports as 4 before the
    // metadata. Told 4, the loader would start a repair of a missing file
    // and call it damaged; it must hear the read failure.
    const { video } = mounted();
    video.error = { code: 2 };
    video.fire("error"); // reload 1
    video.error = { code: 4 };
    video.fire("error"); // reload 1 failed like a missing file: reload 2
    expect(m.playbackFailed).not.toHaveBeenCalled();
    video.fire("error"); // reload 2 failed too
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
  });

  it("hears a real refusal after a reload that reached its metadata", () => {
    const { video } = mounted();
    video.error = { code: 2 };
    video.fire("error"); // reload
    video.duration = 61;
    video.fire("loadedmetadata"); // it reads again
    video.error = { code: 3 };
    video.fire("error");
    expect(m.playbackFailed.mock.calls).toEqual([[3]]);
  });

  it("refills the reload allowance after a quiet spell, not during a failure that persists", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    const { video } = mounted();
    video.error = { code: 2 };
    video.fire("error"); // reload 1
    video.duration = 61;
    video.fire("loadedmetadata");
    video.fire("error"); // reload 2, 0 s later: the same failure going on
    video.duration = 61;
    video.fire("loadedmetadata");
    // 11 s later a fresh hiccup of a long scrub session: reloaded again.
    await vi.advanceTimersByTimeAsync(11_000);
    video.fire("error");
    expect(m.playbackFailed).not.toHaveBeenCalled();
    video.duration = 61;
    video.fire("loadedmetadata");
    video.fire("error"); // and again at once: 2 within the window
    video.duration = 61;
    video.fire("loadedmetadata");
    video.fire("error"); // a third within the window: the loader hears it
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
  });

  it("a new source starts with its retries back", () => {
    const { root, video } = mounted();
    video.error = { code: 2 };
    video.fire("error");
    video.duration = 61;
    video.fire("error");
    m.onState!(CLIP, ready());
    const again = root.querySelector("#vw-video");
    again.duration = 61;
    again.log.length = 0;
    again.fire("error");
    expect(again.log[0]).toBe(`src=${SRC}`);
    expect(m.playbackFailed).not.toHaveBeenCalled();
  });

  /* The owner's 0.9.4 report: a fast drag while playing, and the element
   * reported the END (time = duration, paused) on the clip's first frame;
   * from then on no seek took. Three parts, each with its own test. */

  /** The engine puts the element at its end: time = duration, ended, paused. */
  function engineEnds(video: ReturnType<typeof mounted>["video"]): void {
    (video as unknown as { currentTime: number }).currentTime = 61;
    video.ended = true;
    video.paused = true;
    video.seeking = false;
  }

  it("reloads after a read error where the user last was, not at an end nobody asked for", () => {
    const { video } = mounted();
    m.keys.get("seekFwd")!({ repeat: false }); // asks 5
    video.fire("seeked"); // lands: 5 is the user's position
    engineEnds(video); // no `ended` event yet: only the read error follows
    video.log.length = 0;
    video.error = { code: 2 };
    video.fire("error");
    expect(video.log).toEqual([`src=${SRC}`, "t=5"]);
  });

  it("never opens a reload at the end: it loads from the start and seeks there after its metadata", () => {
    const { video } = mounted();
    m.keys.get("goEnd")!({ repeat: false }); // the user asks for the end
    video.fire("seeked");
    engineEnds(video);
    video.log.length = 0;
    video.error = { code: 2 };
    video.fire("error");
    // No start position given up front ...
    expect(video.log).toEqual([`src=${SRC}`]);
    // ... the fresh load reads 0, and gets its seek once it knows its length.
    (video as unknown as { currentTime: number }).currentTime = 0;
    video.ended = false;
    video.duration = 61;
    video.log.length = 0;
    video.fire("loadedmetadata");
    expect(video.log).toEqual(["t=61"]);
  });

  it("takes an end the user did not cause in a drag for a failed seek: reloaded where the hand is, still playing", () => {
    const { root, video } = mounted();
    const play = vi.fn(() => Promise.resolve());
    video.play = play;
    video.paused = false;
    video.fire("play");
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    bar.fire("pointerdown", ptr(9));
    video.seeking = true;
    for (const sec of [31, 51, 54]) bar.fire("pointermove", ptr(sec));
    engineEnds(video);
    video.log.length = 0;
    play.mockClear();
    video.fire("pause");
    video.fire("ended");
    expect(video.log).toEqual([`src=${SRC}`, "t=54"]);
    expect(play).toHaveBeenCalledTimes(1);
    expect(m.playbackFailed).not.toHaveBeenCalled();
  });

  it("lets an end stand that the user went to, or that playback ran into", () => {
    const { video } = mounted();
    m.keys.get("goEnd")!({ repeat: false });
    video.fire("seeked");
    engineEnds(video);
    video.log.length = 0;
    video.fire("ended");
    expect(video.log).toEqual([]);
    // Playback running out: the last timeupdate before the end was 60.8 s.
    m.keys.get("goStart")!({ repeat: false });
    video.ended = false;
    video.fire("seeked");
    (video as unknown as { currentTime: number }).currentTime = 60.8;
    video.fire("timeupdate");
    engineEnds(video);
    video.log.length = 0;
    video.fire("ended");
    expect(video.log).toEqual([]);
  });

  it("recovers a spurious end twice in a row at most, then lets it stand", () => {
    const { video } = mounted();
    const reloads = (): number => video.log.filter((e) => e.startsWith("src=")).length;
    m.keys.get("seekFwd")!({ repeat: false });
    video.fire("seeked");
    video.log.length = 0;
    for (let i = 0; i < 3; i++) {
      engineEnds(video);
      video.fire("ended");
      video.duration = 61;
      video.fire("loadedmetadata"); // each reload reads again
    }
    expect(reloads()).toBe(2);
  });

  /* Round 3: a reread's recovery is complete. Run 6 on the owner's file: an
   * engine error mid-sweep while playing, the reread restored a stale 12.19 s
   * (the user was asking 49.74) and stayed paused. */

  /** The reread's metadata, then its first frame where it starts. */
  function rereadShows(video: ReturnType<typeof mounted>["video"]): void {
    video.duration = 61;
    video.readyState = 1;
    video.fire("loadedmetadata");
    video.readyState = 2;
    video.fire("canplay");
  }

  it("keeps a position asked while a reread loads, and the reload goes to the latest one", () => {
    const { root, video, knob } = mounted();
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    video.error = { code: 2 };
    video.fire("error"); // reread at 0; no length until its metadata
    // The drag goes on, and lets go, while the reload loads.
    bar.fire("pointerdown", ptr(20));
    bar.fire("pointermove", ptr(41));
    bar.fire("pointermove", ptr(30));
    bar.fire("pointerup", ptr(30));
    expect(knob.styles.get("left")).toBe(at(30));
    video.log.length = 0;
    video.duration = 61;
    video.readyState = 1;
    video.fire("loadedmetadata");
    expect(video.log.map((e) => Math.round(Number(e.slice(2)) * 100) / 100)).toEqual([30]);
    expect(knob.styles.get("left")).toBe(at(30));
  });

  it("resumes playing after a reread when the user was playing, though the error paused the element", () => {
    const { video } = mounted();
    const play = vi.fn(() => Promise.resolve());
    video.play = play;
    video.paused = false;
    video.fire("play");
    // Chromium stops the element with the error.
    video.error = { code: 2 };
    video.paused = true;
    video.fire("pause");
    play.mockClear();
    video.fire("error");
    expect(video.log[0]).toBe(`src=${SRC}`);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stays paused after a reread when the user had paused", () => {
    const { video } = mounted();
    const play = vi.fn(() => Promise.resolve());
    video.play = play;
    video.paused = false;
    video.fire("play");
    video.paused = true;
    video.fire("pause"); // the user's
    video.error = { code: 2 };
    video.fire("error");
    expect(play).not.toHaveBeenCalled();
  });

  it("recovers every seek-burst read error whose reread shows its frame: five in a row, none reaches the loader", () => {
    const { video } = mounted();
    for (let i = 0; i < 5; i++) {
      (video as unknown as { currentTime: number }).currentTime = 5 + 10 * i;
      // The user's seek that provokes it (a burst of them in the real app).
      m.keys.get("seekFwd")!({ repeat: false });
      video.error = { code: 2 };
      video.fire("error");
      rereadShows(video);
    }
    expect(video.log.filter((e) => e.startsWith("src=")).length).toBe(5);
    expect(m.playbackFailed).not.toHaveBeenCalled();
  });

  it("recovers the same sweep repeated five times, each erroring and reloaded at the same spot: none reaches the loader", () => {
    // The owner's run: the same sweep 5 s -> 49.7 s three times, each erroring
    // on the way; every reload went back to 49.7, and the third reached the
    // loader ("Can't show this file" on a healthy file).
    const { root, video } = mounted();
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    const targets: number[] = [];
    for (let i = 0; i < 5; i++) {
      (video as unknown as { currentTime: number }).currentTime = 5;
      bar.fire("pointerdown", ptr(5));
      bar.fire("pointermove", ptr(30));
      bar.fire("pointermove", ptr(49.7));
      bar.fire("pointerup", ptr(49.7));
      video.seeking = true;
      video.log.length = 0;
      video.error = { code: 2 };
      video.fire("error");
      expect(video.log[0]).toBe(`src=${SRC}`);
      targets.push(Math.round(Number((video.log[1] ?? "").slice(2)) * 10) / 10);
      video.seeking = false;
      rereadShows(video);
    }
    expect(targets).toEqual([49.7, 49.7, 49.7, 49.7, 49.7]);
    expect(m.playbackFailed).not.toHaveBeenCalled();
  });

  it("does not loop on a spot that fails again right after each recovery with no seek in between: the loader hears it", () => {
    const { video } = mounted();
    let errors = 0;
    while (m.playbackFailed.mock.calls.length === 0 && errors < 10) {
      // Playback alone reaches the bad spot again: nothing asked in between.
      (video as unknown as { currentTime: number }).currentTime = 12;
      video.error = { code: 2 };
      video.fire("error");
      errors++;
      if (m.playbackFailed.mock.calls.length === 0) rereadShows(video);
    }
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
    // The allowance (two reloads), then the loader: the reloads' successes
    // refilled nothing.
    expect(errors).toBe(3);
    expect(video.log.filter((e) => e.startsWith("src=")).length).toBe(2);
  });

  it("does not count a reread that errors after its metadata but before its frame as a success", () => {
    const { video } = mounted();
    for (let i = 0; i < 3; i++) {
      (video as unknown as { currentTime: number }).currentTime = 5 + 10 * i;
      video.error = { code: 2 };
      video.fire("error");
      video.duration = 61;
      video.readyState = 1;
      video.fire("loadedmetadata"); // reads again, shows nothing yet
    }
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
  });

  it("records, for the E2E, the error it handled as it was before the reload", () => {
    const { video } = mounted();
    m.keys.get("seekFwd")!({ repeat: false }); // asks 5
    video.seeking = true;
    (video as unknown as { currentTime: number }).currentTime = 3;
    video.error = { code: 2, message: "PIPELINE_ERROR_READ: demuxer seek failed" };
    video.fire("error");
    const hook = (window as unknown as { __tarotingViewerDev?: { lastError(): unknown; counts(): Record<string, number> } })
      .__tarotingViewerDev!;
    expect(hook.lastError()).toEqual({
      code: 2,
      message: "PIPELINE_ERROR_READ: demuxer seek failed",
      at: 3,
      asked: 5,
      ended: false,
      duringReload: false,
    });
    expect(hook.counts()).toMatchObject({ rereads: 1, rereadFailures: 0 });
  });

  it("leaves a read error before the length is known, or on a container-only attempt, to the loader", () => {
    const root = mount(CLIP);
    m.onState!(CLIP, ready());
    const video = root.querySelector("#vw-video");
    video.error = { code: 2 };
    video.fire("error");
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
    m.playbackFailed.mockReset();
    m.onState!(CLIP, ready(true));
    video.duration = 61;
    video.fire("error");
    expect(m.playbackFailed.mock.calls).toEqual([[2]]);
  });
});

/* ---------------- a heavy clip's drag ---------------- */

describe("a heavy clip's drag", () => {
  const CLIP = "D:\\clips\\Replay 2026-10-01 21-09-07.mp4";
  const SRC = "asset://localhost/D%3A%5Cclips%5CReplay%202026-10-01%2021-09-07.mp4";
  const OTHER = "D:\\clips\\Replay 2026-10-02 18-44-51.mp4";
  /** Keyframes every 4.17 s at 69 Mbps over 61 s: heavy. */
  const HEAVY = {
    allSync: false,
    times: Array.from({ length: 15 }, (_, i) => Math.round(i * 4.17 * 100) / 100),
    duration: 61,
    bytes: Math.round((61 * 69_000_000) / 8),
  };
  const ready = (file: string, url = SRC): LoadState => ({
    state: "ready",
    element: "video",
    url,
    file,
    kind: "video",
    tryingDirect: false,
  });
  /** The knob's left, as paintReadout writes it for `sec` of 61. */
  const at = (sec: number): string => `${Math.round((sec / 61) * 1000) / 10}%`;

  /** A 61 s video on screen, at 0, its seek bar 610 px wide from x = 100. */
  function mounted() {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    const root = mount(CLIP);
    m.onState!(CLIP, ready(CLIP));
    const video = root.querySelector("#vw-video");
    video.duration = 61;
    video.seeking = false;
    video.log.length = 0;
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    const seeks = () => video.log.map((e) => (e.startsWith("t=") ? Math.round(Number(e.slice(2)) * 1000) / 1000 : e));
    return { root, video, bar, ptr, seeks, knob: root.querySelector(".theater-bar__seek-knob") };
  }

  /** Press at `sec`, let the index answer, and land the press's exact seek. */
  async function pressHeavy(v: ReturnType<typeof mounted>, sec: number): Promise<void> {
    m.keyframeTimes.mockResolvedValue(HEAVY);
    v.bar.fire("pointerdown", v.ptr(sec));
    await flush();
    v.video.seeking = false;
    v.video.fire("seeked");
    v.video.log.length = 0;
  }

  it("asks for the index once the video has stayed a moment, never at load or for a file stepped past", async () => {
    const v = mounted();
    await flush();
    expect(m.keyframeTimes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INDEX_DWELL_MS - 1);
    expect(m.keyframeTimes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP]]);
    // A scrub afterwards does not ask again.
    v.bar.fire("pointerdown", v.ptr(3));
    v.bar.fire("pointerup", v.ptr(3));
    await flush();
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP]]);
    // Stepped onto, and past before its moment is up: never read.
    views[0]!.show(OTHER);
    m.onState!(OTHER, ready(OTHER, "asset://localhost/other"));
    await vi.advanceTimersByTimeAsync(INDEX_DWELL_MS - 1);
    views[0]!.show(CLIP);
    m.onState!(CLIP, ready(CLIP));
    // The file stepped past left no timer behind: the new one is not read
    // at the old one's moment, only at its own.
    await vi.advanceTimersByTimeAsync(2);
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP]]);
    await vi.advanceTimersByTimeAsync(INDEX_DWELL_MS);
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP], [CLIP]]);
    await vi.advanceTimersByTimeAsync(INDEX_DWELL_MS * 3);
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP], [CLIP]]);
  });

  it("asks for the index on a scrub that comes first, once per source, and the moment adds no second ask", async () => {
    const v = mounted();
    await flush();
    expect(m.keyframeTimes).not.toHaveBeenCalled();
    v.bar.fire("pointerdown", v.ptr(3));
    v.bar.fire("pointerup", v.ptr(3));
    v.bar.fire("pointerdown", v.ptr(5));
    v.bar.fire("pointerup", v.ptr(5));
    await flush();
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP]]);
    views[0]!.show(OTHER);
    m.onState!(OTHER, ready(OTHER, "asset://localhost/other"));
    v.video.duration = 61;
    v.bar.fire("pointerdown", v.ptr(7));
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP], [OTHER]]);
    await vi.advanceTimersByTimeAsync(INDEX_DWELL_MS * 3);
    expect(m.keyframeTimes.mock.calls).toEqual([[CLIP], [OTHER]]);
  });

  it("never asks for an audio file's index", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    const root = mount(CLIP);
    m.onState!(CLIP, { state: "ready", element: "video", url: SRC, file: CLIP, kind: "audio", tryingDirect: false });
    const bar = root.querySelector("#vw-seek");
    root.querySelector("#vw-video").duration = 61;
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    bar.fire("pointerdown", { button: 0, pointerId: 1, clientX: 200, preventDefault: () => {} });
    await flush();
    expect(m.keyframeTimes).not.toHaveBeenCalled();
    // Nor when it has stayed on screen.
    await vi.advanceTimersByTimeAsync(INDEX_DWELL_MS * 3);
    expect(m.keyframeTimes).not.toHaveBeenCalled();
  });

  it("drops an index that answers for a source no longer shown", async () => {
    const v = mounted();
    let answer!: (ix: typeof HEAVY) => void;
    m.keyframeTimes.mockReturnValue(new Promise((r) => (answer = r)));
    v.bar.fire("pointerdown", v.ptr(1));
    // The read error's reload is a new source before the answer lands.
    v.video.error = { code: 2 };
    v.video.fire("error");
    v.video.duration = 61;
    answer(HEAVY);
    await flush();
    v.video.log.length = 0;
    vi.advanceTimersByTime(20);
    v.bar.fire("pointermove", v.ptr(7.9));
    vi.advanceTimersByTime(20);
    v.bar.fire("pointermove", v.ptr(12.3));
    // Light: a fast move asks the exact cursor time, not keyframe 12.51.
    expect(v.seeks()).toEqual([7.9, 12.3]);
  });

  it("asks the nearest keyframe on a fast move, and the knob stays on the cursor when it lands", async () => {
    const v = mounted();
    await pressHeavy(v, 1);
    vi.advanceTimersByTime(40);
    v.bar.fire("pointermove", v.ptr(7.9));
    expect(v.seeks()).toEqual([8.34]);
    expect(v.knob.styles.get("left")).toBe(at(7.9));
    v.video.seeking = false;
    v.video.fire("seeked");
    expect(v.knob.styles.get("left")).toBe(at(7.9));
  });

  it("a release gives one exact seek to where the pointer let go, and the element's time after it lands", async () => {
    const v = mounted();
    await pressHeavy(v, 1);
    vi.advanceTimersByTime(40);
    v.bar.fire("pointermove", v.ptr(7.9));
    v.video.seeking = true;
    vi.advanceTimersByTime(20);
    v.bar.fire("pointermove", v.ptr(11));
    v.bar.fire("pointerup", v.ptr(11));
    v.video.seeking = false;
    v.video.fire("seeked");
    expect(v.seeks()).toEqual([8.34, 11]);
    // Playback moves on from there: the bar follows the element again.
    v.video.currentTime = 11.6;
    v.video.fire("timeupdate");
    expect(v.knob.styles.get("left")).toBe(at(11.6));
  });

  it("a 1 px wobble right after the press seeks exactly; the same motion kept up lands on a keyframe", async () => {
    // 1 px of 610 is 0.1 s of 61: every 8 ms that reads 12.5 s/s, three
    // keyframe gaps a second — fast, once it has lasted MIN_SPEED_SPAN_MS.
    const v = mounted();
    await pressHeavy(v, 1);
    for (const sec of [1.1, 1.2, 1.3, 1.4]) {
      vi.advanceTimersByTime(8);
      v.bar.fire("pointermove", v.ptr(sec));
    }
    expect(v.seeks()).toEqual([1.1, 1.2, 1.3, 0]);
  });

  it("held still on a heavy file, once its exact frame has landed the knob follows playback", async () => {
    const v = mounted();
    await pressHeavy(v, 1);
    vi.advanceTimersByTime(40);
    v.bar.fire("pointermove", v.ptr(7.9));
    v.video.seeking = false;
    v.video.fire("seeked");
    // The rest's exact seek, then it lands.
    vi.advanceTimersByTime(REST_MS);
    expect(v.seeks()).toEqual([8.34, 7.9]);
    v.video.seeking = false;
    v.video.fire("seeked");
    // Playing on from the cursor's frame.
    v.video.currentTime = 8.6;
    v.video.fire("timeupdate");
    expect(v.knob.styles.get("left")).toBe(at(8.6));
  });

  it("a keyframe waiting when the source is reloaded never reaches the new source", async () => {
    const v = mounted();
    await pressHeavy(v, 1);
    vi.advanceTimersByTime(40);
    v.bar.fire("pointermove", v.ptr(4));
    v.video.seeking = true;
    vi.advanceTimersByTime(20);
    v.bar.fire("pointermove", v.ptr(12.3));
    expect(v.seeks()).toEqual([4.17]);
    // A read error reloads the source (swapVideo) where the user was.
    v.video.error = { code: 2 };
    v.video.fire("error");
    v.video.seeking = false;
    v.video.fire("seeked");
    vi.advanceTimersByTime(1000);
    expect(v.seeks()).toEqual([4.17, `src=${SRC}`, 12.3]);
  });
});

/* ---------------- a heavy clip's scrub copy ---------------- */

describe("a heavy clip's scrub copy", () => {
  const CLIP = "D:\\clips\\Replay 2026-10-03 19-55-12.mp4";
  const PLAYED = "C:\\cache\\remux\\4c0ffee5d00dfeed.mp4";
  const SRC = "asset://localhost/C%3A%5Ccache%5Cremux%5C4c0ffee5d00dfeed.mp4";
  const NEXT = "D:\\clips\\Replay 2026-10-04 08-12-40.mp4";
  const COPY = "C:\\cache\\scrub\\77aa31d2c09e5b14.scrub1.mp4";
  const JOB = 23;
  /** Keyframes every 4.17 s at 69 Mbps over 61 s: heavy. */
  const HEAVY = {
    allSync: false,
    times: Array.from({ length: 15 }, (_, i) => Math.round(i * 4.17 * 100) / 100),
    duration: 61,
    bytes: Math.round((61 * 69_000_000) / 8),
  };
  /** Keyframes every 0.5 s: light. */
  const LIGHT = { allSync: false, times: Array.from({ length: 122 }, (_, i) => i / 2), duration: 61, bytes: 61 * 400_000 };
  const at = (sec: number): string => `${Math.round((sec / 61) * 1000) / 10}%`;
  let rafQ: (() => void)[] = [];
  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) {
      const q = rafQ;
      rafQ = [];
      for (const f of q) f();
    }
  };

  /** A 61 s video on screen (played from PLAYED), its bar 610 px from x = 100. */
  function mounted(kind: "video" | "audio" = "video") {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    rafQ = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => rafQ.push(fn));
    const root = mount(CLIP);
    m.onState!(CLIP, { state: "ready", element: "video", url: SRC, file: PLAYED, kind, tryingDirect: false });
    const video = root.querySelector("#vw-video");
    video.duration = 61;
    video.seeking = false;
    video.readyState = 4;
    video.log.length = 0;
    const bar = root.querySelector("#vw-seek");
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, right: 710, bottom: 10, width: 610, height: 10 });
    const ptr = (sec: number) => ({ button: 0, pointerId: 1, clientX: 100 + (sec / 61) * 610, preventDefault: () => {} });
    const seeks = () =>
      video.log.filter((e) => e.startsWith("t=")).map((e) => Math.round(Number(e.slice(2)) * 1000) / 1000);
    return { root, video, bar, ptr, seeks, knob: root.querySelector(".theater-bar__seek-knob") };
  }
  const copyEl = (): FakeEl | undefined => created.find((e) => e.className === "viewer__scrub-copy");

  /** A press and release on the bar (the index answers heavy), and the ready
   *  copy loaded. */
  async function withCopy(v: ReturnType<typeof mounted>): Promise<FakeEl> {
    m.keyframeTimes.mockResolvedValue(HEAVY);
    m.planScrub.mockResolvedValue({ mode: "ready", path: COPY });
    v.bar.fire("pointerdown", v.ptr(2.2));
    v.bar.fire("pointerup", v.ptr(2.2));
    await flush();
    const c = copyEl()!;
    expect(c).toBeDefined();
    c.readyState = 4;
    c.seeking = false;
    c.fire("loadeddata");
    v.video.seeking = false;
    v.video.fire("seeked");
    v.video.log.length = 0;
    return c;
  }

  it("costs a light clip nothing: no command, no element, no timer", async () => {
    const v = mounted();
    m.keyframeTimes.mockResolvedValue(LIGHT);
    v.bar.fire("pointerdown", v.ptr(3));
    await flush();
    vi.advanceTimersByTime(20);
    v.bar.fire("pointermove", v.ptr(9.5));
    v.bar.fire("pointerup", v.ptr(9.5));
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.planScrub).not.toHaveBeenCalled();
    expect(m.jobHandlers).toHaveLength(0);
    expect(copyEl()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    // Its drag is exactly today's: a seek per move.
    expect(v.seeks()).toEqual([3, 9.5]);
  });

  it("never asks for an audio file", async () => {
    const v = mounted("audio");
    m.keyframeTimes.mockResolvedValue(HEAVY);
    v.bar.fire("pointerdown", v.ptr(3));
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.planScrub).not.toHaveBeenCalled();
  });

  it("asks for the copy of the PLAYED file at the first press, and a step cancels its job", async () => {
    const v = mounted();
    m.keyframeTimes.mockResolvedValue(HEAVY);
    m.planScrub.mockResolvedValue({ mode: "pending", jobId: JOB });
    v.bar.fire("pointerdown", v.ptr(4));
    await flush();
    expect(m.planScrub.mock.calls).toEqual([[PLAYED]]);
    views[0]!.show(NEXT);
    expect(m.cancelJob.mock.calls).toEqual([[JOB]]);
    expect(m.jobHandlers).toHaveLength(0);
  });

  it("leaving the viewer cancels its job", async () => {
    const v = mounted();
    m.keyframeTimes.mockResolvedValue(HEAVY);
    m.planScrub.mockResolvedValue({ mode: "pending", jobId: JOB });
    v.bar.fire("pointerdown", v.ptr(4));
    await flush();
    unmount();
    expect(m.cancelJob.mock.calls).toEqual([[JOB]]);
  });

  it("drags on the copy: the main video is not seeked while moving, the knob is on the pointer, one exact seek on release", async () => {
    const v = mounted();
    const c = await withCopy(v);
    v.bar.fire("pointerdown", v.ptr(5.5));
    v.video.seeking = true;
    c.seeking = true;
    for (const sec of [14.25, 27.5, 33.75]) {
      vi.advanceTimersByTime(16);
      v.bar.fire("pointermove", v.ptr(sec));
      expect(v.knob.styles.get("left")).toBe(at(sec));
    }
    // Only the press asked the main video; the copy got the first move, the
    // newest waits behind it.
    expect(v.seeks()).toEqual([5.5]);
    expect(c.log.filter((e) => e.startsWith("t=")).map((e) => Math.round(Number(e.slice(2)) * 1000) / 1000)).toEqual([14.25]);
    // The press's seek landing mid-drag must not pull the knob off the pointer.
    v.video.seeking = false;
    v.video.fire("seeked");
    expect(v.knob.styles.get("left")).toBe(at(33.75));
    v.bar.fire("pointerup", v.ptr(33.75));
    expect(v.seeks()).toEqual([5.5, 33.75]);
  });

  it("a playing video pauses for the drag and keeps the wish to play through it", async () => {
    const v = mounted();
    await withCopy(v);
    const play = vi.fn(() => Promise.resolve());
    v.video.play = play;
    v.video.paused = false;
    v.video.fire("play");
    v.video.pause = () => {
      v.video.paused = true;
      v.video.fire("pause");
    };
    v.bar.fire("pointerdown", v.ptr(6.1));
    vi.advanceTimersByTime(16);
    v.bar.fire("pointermove", v.ptr(18.4));
    expect(v.video.paused).toBe(true);
    // A read error now reloads the source: it resumes playing only if the
    // drag's pause kept the wish to play.
    v.video.error = { code: 2 };
    v.video.fire("error");
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("is laid over the picture, under the cover, and never a pointer target", async () => {
    const v = mounted();
    const c = await withCopy(v);
    const stage = v.root.querySelector("#vw-stage") as FakeEl & { inserted?: unknown[] };
    expect(stage.inserted).toEqual([c, v.root.querySelector("#vw-cover")]);
    expect(c.muted).toBe(true);
    expect(c.hidden).toBe(true);
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const css = readFileSync(fileURLToPath(new URL("./viewer.css", import.meta.url)), "utf8");
    const rule = /\.viewer__scrub-copy\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/inset:\s*0/);
    expect(rule).toMatch(/object-fit:\s*contain/);
  });

  it("publishes its state and seek counts on the dev hook", async () => {
    const v = mounted();
    const c = await withCopy(v);
    const dev = (window as unknown as {
      __tarotingViewerDev: { scrub(): unknown; scrubSeeks(): { copy: number; main: number } };
    }).__tarotingViewerDev;
    expect(dev.scrub()).toEqual({ state: "ready", shown: false, file: PLAYED });
    v.bar.fire("pointerdown", v.ptr(7));
    vi.advanceTimersByTime(16);
    v.bar.fire("pointermove", v.ptr(12.5));
    c.seeking = false;
    c.fire("seeked");
    frames(2);
    expect(dev.scrub()).toEqual({ state: "ready", shown: true, file: PLAYED });
    expect(c.hidden).toBe(false);
    expect(dev.scrubSeeks().copy).toBe(1);
  });
});

/* ---------------- the chrome's auto-hide ---------------- */

describe("the chrome's auto-hide", () => {
  const CLIP = "D:\\clips\\Replay 2026-10-07 03-29-10.mp4";
  const SRC = "asset://localhost/D%3A%5Cclips%5CReplay.mp4";

  function playing() {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    const root = mount(CLIP);
    m.onState!(CLIP, { state: "ready", element: "video", url: SRC, kind: "video", tryingDirect: false });
    const video = root.querySelector("#vw-video");
    video.duration = 61;
    video.paused = false;
    video.fire("play");
    const time = root.querySelector("#vw-time");
    /** The readout repaints on timeupdate only while the chrome shows. */
    const showing = (at: number): boolean => {
      video.currentTime = at;
      video.fire("timeupdate");
      return time.textContent === `0:${String(at).padStart(2, "0")} / 1:01`;
    };
    return { root, showing };
  }

  it("fades after 1 s of a still mouse while a video plays", async () => {
    const { showing } = playing();
    await vi.advanceTimersByTimeAsync(999);
    expect(showing(10)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(showing(20)).toBe(false);
  });

  it("never fades from under a pointer resting on it, and fades once it leaves", async () => {
    // Faded, the chrome goes pointer-events: none, so a click on the button
    // under a still pointer lands on the video and pauses it instead.
    const { root, showing } = playing();
    root.held = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(showing(30)).toBe(true);
    root.held = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(showing(40)).toBe(false);
  });
});

/* ---------------- stepping through videos ---------------- */

describe("stepping through videos", () => {
  const V = "D:\\clips\\";
  const clips = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, k) => `${V}${String(from + k).padStart(3, "0")}.mp4`);
  const loaded = (): string[] => m.load.mock.calls.map((c) => String(c[0]));

  it("loads a single press at once, and only the file a burst of presses stops on", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    const all = clips(1, 10);
    mount(all[0]!);
    calls[0]!.resolve({ before: [], after: all.slice(1), index: 1, total: 10, family: "visual" });
    await flush();
    const next = m.keys.get("nextFile")!;
    await vi.advanceTimersByTimeAsync(1000);
    m.load.mockClear();
    // One press after a rest: at once, no settle.
    next({ repeat: false });
    expect(loaded()).toEqual([all[1]]);
    // Three more, 60 ms apart (clicks or taps, not a held key): nothing for
    // the files passed over, then the one the burst stopped on.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60);
      next({ repeat: false });
    }
    await vi.advanceTimersByTimeAsync(249);
    expect(loaded()).toEqual([all[1]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(loaded()).toEqual([all[1], all[4]]);
    // After a rest, a single press is at once again.
    await vi.advanceTimersByTimeAsync(1000);
    next({ repeat: false });
    expect(loaded()).toEqual([all[1], all[4], all[5]]);
  });
});

/* ---------------- a damaged video ---------------- */

describe("a damaged video", () => {
  // The owner's recording: 60.499 s unreadable, 170 s long. The instant copy
  // and the full repair have their own urls; the playhead, the length and the
  // damaged range all differ from each other.
  const CLIP = "D:\\clips\\Genshin Impact 2026.09.30 - 14.18.37.02.mp4.mp4";
  const QUICK = "asset://localhost/C%3A%5Ccache%5Cg5.quick.mp4";
  const FULL = "asset://localhost/C%3A%5Ccache%5Cg5.repairps.mp4";
  const UNTIL = 60.499;
  const damage = (phase: Damage["phase"], ratio: number | null = null, until: number | null = UNTIL): Damage => ({
    until,
    phase,
    ratio,
  });
  const ready = (url: string, d?: Damage): LoadState =>
    d === undefined
      ? { state: "ready", element: "video", url, kind: "video", tryingDirect: false }
      : { state: "ready", element: "video", url, kind: "video", tryingDirect: false, damage: d };

  function mounted() {
    const root = mount(CLIP);
    // What the template's `hidden` attributes say; the fake does not parse it.
    for (const sel of ["#vw-damage", "#vw-cover", "#vw-seek-damage", "#vw-status"]) root.querySelector(sel).hidden = true;
    const video = root.querySelector("#vw-video");
    const play = vi.fn(() => Promise.resolve());
    video.play = play;
    return {
      root,
      video,
      play,
      pill: root.querySelector("#vw-damage"),
      cover: root.querySelector("#vw-cover"),
      shade: root.querySelector("#vw-seek-damage"),
      status: root.querySelector("#vw-status"),
      statusText: (): string => root.querySelector(".viewer__status-text").textContent,
    };
  }

  it("says so in the top bar in every phase, naming the range it couldn't read", () => {
    const v = mounted();
    const got: Array<[string, boolean, string]> = [];
    for (const d of [
      damage("repairing"),
      damage("repairing", 0.404),
      damage("recovered"),
      damage("unrecovered"),
      damage("recovered", null, null),
    ]) {
      m.onState!(CLIP, ready(QUICK, d));
      got.push([v.pill.textContent, v.pill.hidden, v.pill.title]);
    }
    expect(got).toEqual([
      ["Damaged video · repairing", false, "0:00-1:00 couldn't be read"],
      ["Damaged video · repairing 40%", false, "0:00-1:00 couldn't be read"],
      ["Damaged video · recovered", false, "0:00-1:00 couldn't be read"],
      // The editor's words for a full repair that could not be made.
      ["Damaged video · couldn't be recovered", false, "0:00-1:00 couldn't be read"],
      ["Damaged video · recovered", false, "Part of this video couldn't be read"],
    ]);
  });

  // 60.499 s (the owner's file) reads 1:00 rounded or floored alike; 60.6 s
  // does not. The editor floors (damageRange): the clock still shows 1:00
  // there, and 1:01 is a second that plays.
  it("ends the range it couldn't read on the second the clock shows, as the editor does", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing", null, 60.6)));
    expect(v.pill.title).toBe("0:00-1:00 couldn't be read");
  });

  it("shows no pill for a healthy video, and drops it with the damaged one", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing", 0.2)));
    expect(v.pill.hidden).toBe(false);
    m.onState!(CLIP, { state: "failed", message: "" });
    expect([v.pill.hidden, v.pill.textContent]).toEqual([true, ""]);
    m.onState!(CLIP, ready("asset://localhost/D%3A%5Cclips%5Cok.mp4"));
    expect([v.pill.hidden, v.pill.textContent]).toEqual([true, ""]);
  });

  it("shades the damaged range on the seek track once the length is known", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing")));
    // No metadata yet: nothing to measure the range against.
    expect(v.shade.hidden).toBe(true);
    v.video.duration = 170;
    v.video.fire("loadedmetadata");
    // 60.499 of 170 s, to a tenth of a percent.
    expect(v.shade.styles.get("width")).toBe("35.6%");
    expect(v.shade.hidden).toBe(false);
    m.onState!(CLIP, { state: "failed", message: "" });
    expect(v.shade.hidden).toBe(true);
  });

  it("covers the instant copy while the playhead is in the part it couldn't read", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing", 0.4)));
    expect(v.cover.hidden).toBe(false);
    expect(v.statusText()).toBe("Damaged section · repairing 40%");
    expect(v.status.hidden).toBe(false);
    // Playback crosses the first sound frame.
    v.video.currentTime = 60.6;
    v.video.fire("timeupdate");
    expect(v.cover.hidden).toBe(true);
    expect(v.status.hidden).toBe(true);
    // Seeking back into it covers it again.
    v.video.currentTime = 12;
    v.video.fire("seeked");
    expect(v.cover.hidden).toBe(false);
    // A copy the full repair will not replace keeps the cover, labelled as the
    // editor's stage labels it.
    m.onState!(CLIP, ready(QUICK, damage("unrecovered")));
    expect(v.statusText()).toBe("Damaged section · couldn't be recovered");
    expect(v.cover.hidden).toBe(false);
  });

  it("never covers the full repair: its damaged part is the recovered picture", () => {
    const v = mounted();
    m.onState!(CLIP, ready(FULL, damage("recovered")));
    expect(v.video.currentTime).toBe(0);
    expect(v.cover.hidden).toBe(true);
    expect(v.statusText()).toBe("");
  });

  it("keeps the cover with the playhead while the player bar is hidden", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    const v = mounted();
    const time = v.root.querySelector("#vw-time");
    m.onState!(CLIP, ready(QUICK, damage("repairing")));
    v.video.paused = false;
    v.video.fire("play");
    await vi.advanceTimersByTimeAsync(3000); // the chrome fades out
    const readout = time.textContent;
    v.video.currentTime = 61;
    v.video.fire("timeupdate");
    // The bar really is hidden: its readout waits for the reveal...
    expect(time.textContent).toBe(readout);
    // ...and the cover did not.
    expect(v.cover.hidden).toBe(true);
  });

  it("repaints only what the user is told when the same copy reports progress", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing", 0.4)));
    v.video.currentTime = 75;
    v.play.mockClear();
    v.video.log.length = 0;
    m.onState!(CLIP, ready(QUICK, damage("repairing", 0.41)));
    expect(v.pill.textContent).toBe("Damaged video · repairing 41%");
    // The element was left alone: no new src, no seek, no play.
    expect(v.video.log).toEqual([]);
    expect(v.play).not.toHaveBeenCalled();
  });

  it("swaps the full repair in where playback was, still playing, with nothing in between", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing", 0.9)));
    v.video.duration = 170;
    v.video.fire("loadedmetadata");
    v.video.currentTime = 75;
    v.video.paused = false;
    v.play.mockClear();
    v.video.log.length = 0;
    const bar = v.root.querySelector("#vw-bar");
    m.onState!(CLIP, ready(FULL, damage("recovered")));
    // The new src, THEN the position (the new copy's start position), then play.
    expect(v.video.log).toEqual([`src=${FULL}`, "t=75"]);
    expect(v.play).toHaveBeenCalledTimes(1);
    expect([v.video.hidden, bar.hidden]).toEqual([false, false]);
    expect(v.pill.textContent).toBe("Damaged video · recovered");
    // Never a status card on the way: not "Preparing", not "Can't show this file".
    expect(v.status.hidden).toBe(true);
    expect(v.statusText()).toBe("");
  });

  it("gives the full repair its own read-error reloads when it swaps in", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing")));
    v.video.duration = 170;
    v.video.error = { code: 2 };
    for (let i = 0; i < 2; i++) {
      v.video.fire("error"); // both of the instant copy's reloads, spent
      v.video.duration = 170;
      v.video.fire("loadedmetadata");
    }
    m.onState!(CLIP, ready(FULL, damage("recovered")));
    v.video.duration = 170;
    v.video.fire("loadedmetadata");
    v.video.log.length = 0;
    v.video.fire("error");
    expect(m.playbackFailed).not.toHaveBeenCalled();
    expect(v.video.log[0]).toBe(`src=${FULL}`);
  });

  it("a swap keeps a paused video paused", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing")));
    v.video.currentTime = 90;
    v.video.paused = true;
    v.play.mockClear();
    m.onState!(CLIP, ready(FULL, damage("recovered")));
    expect(v.video.currentTime).toBe(90);
    expect(v.play).not.toHaveBeenCalled();
  });

  it("a swap holds the readout until the new copy knows its length, then makes sure of the position and lets go", () => {
    const v = mounted();
    const time = v.root.querySelector("#vw-time");
    m.onState!(CLIP, ready(QUICK, damage("repairing")));
    v.video.duration = 170;
    v.video.currentTime = 75;
    v.video.fire("timeupdate");
    expect(time.textContent).toBe("1:15 / 2:50");
    m.onState!(CLIP, ready(FULL, damage("recovered")));
    // The new copy has no length yet and, in an engine that ignored the early
    // position, reads 0.
    v.video.duration = Number.NaN;
    v.video.currentTime = 0;
    v.video.fire("durationchange");
    v.video.fire("timeupdate");
    expect(time.textContent).toBe("1:15 / 2:50");
    v.video.duration = 170;
    v.video.log.length = 0;
    v.video.fire("loadedmetadata");
    expect(v.video.log).toEqual(["t=75"]);
    // The hold is over: the readout follows the new copy's own playhead (a
    // hold kept would freeze it, and the seek knob, at 1:15 for good).
    v.video.currentTime = 80;
    v.video.fire("timeupdate");
    expect(time.textContent).toBe("1:20 / 2:50");
  });

  it("a refusal of the swapped-in copy is the new copy's to report", () => {
    const v = mounted();
    m.onState!(CLIP, ready(QUICK, damage("repairing")));
    m.onState!(CLIP, ready(FULL, damage("recovered")));
    v.video.error = { code: 3 };
    v.video.fire("error");
    expect(m.playbackFailed.mock.calls).toEqual([[3]]);
  });

  it("a failed open restarts the load while a full repair still runs behind the instant copy, not after", async () => {
    const got: number[] = [];
    for (const d of [damage("repairing", 0.3), damage("recovered")]) {
      const root = mount(CLIP);
      m.onState!(CLIP, ready(QUICK, d));
      m.load.mockClear();
      m.openMedia.mockRejectedValueOnce(new Error("disk full"));
      root.querySelector("#vw-more").fire("click");
      m.menu.find((i) => i.label === "Open as project")!.onSelect();
      await flush();
      got.push(m.load.mock.calls.length);
      unmount();
      created = [];
    }
    expect(got).toEqual([1, 0]);
  });
});

/* ---------------- a PDF ---------------- */

describe("a PDF", () => {
  const D = "C:\\docs\\";
  const DOC: LoadState = { state: "document" };

  /** Mount on `path`, list its folder, and let the loader call it a PDF. */
  async function shownPdf(path: string, after: string[] = []): Promise<FakeEl> {
    const root = mount(path);
    calls[0]!.resolve({ before: [], after, index: 1, total: 1 + after.length, family: "document" });
    await flush();
    m.onState!(path, DOC);
    await flush();
    return root;
  }

  /** Dispose the mounted viewer and start the fake DOM afresh. */
  function remount(): void {
    unmount();
    created = [];
    calls = [];
  }

  it("fetches the PDF mode only once a PDF is shown, and opens the file there", async () => {
    // FIRST in this describe, and no earlier test shows a PDF: the factory of
    // the mocked ./pdf-mode runs on the first import() of it.
    mount(`${F}001.jpg`);
    m.onState!(`${F}001.jpg`, { state: "ready", element: "img", url: "u", kind: "image", tryingDirect: false });
    await flush();
    expect(m.pdfImported).toBe(false);
    remount();

    const root = await shownPdf(`${D}a.pdf`);
    expect(m.load).toHaveBeenCalledWith(`${D}a.pdf`);
    expect(m.pdfImported).toBe(true);
    expect(m.pdfMounts).toHaveLength(1);
    const host = m.pdfMounts[0]!.host;
    expect(host.root).toBe(root);
    expect(host.stage).toBe(root.querySelector("#vw-stage"));
    expect(host.top).toBe(root.querySelector("#vw-top"));
    expect(host.nameEl).toBe(root.querySelector("#vw-name"));
    expect(m.pdfMounts[0]!.memory).toEqual({ fit: "width", zoom: 1, railOpen: null });
    expect(m.pdfMode!.open).toHaveBeenCalledTimes(1);
    const [path, live] = m.pdfMode!.open.mock.calls[0]! as [string, () => boolean];
    expect(path).toBe(`${D}a.pdf`);
    expect(live()).toBe(true);
    // no media element and no player bar under the strip
    expect(root.querySelector("#vw-img").hidden).toBe(true);
    expect(root.querySelector("#vw-video").hidden).toBe(true);
    expect(root.querySelector("#vw-bar").hidden).toBe(true);
  });

  it("steps PDF → PDF in the one mode, and anything else takes it down", async () => {
    await shownPdf(`${D}a.pdf`, [`${D}b.pdf`]);
    const firstLive = m.pdfMode!.open.mock.calls[0]![1] as () => boolean;
    m.load.mockClear();
    m.keys.get("nextFile")!({ repeat: false });
    expect(m.load).toHaveBeenCalledWith(`${D}b.pdf`);
    // the strip stays while the next PDF opens in place
    expect(m.pdfMode!.dispose).not.toHaveBeenCalled();
    expect(firstLive()).toBe(false);
    m.onState!(`${D}b.pdf`, DOC);
    await flush();
    expect(m.pdfMounts).toHaveLength(1);
    expect(m.pdfMode!.open).toHaveBeenLastCalledWith(`${D}b.pdf`, expect.any(Function));

    views[0]!.show("D:\\clips\\x.mp4");
    expect(m.pdfMode!.dispose).toHaveBeenCalledTimes(1);
    // back to a PDF: a fresh mount, the session's memory handed over again
    const memory = m.pdfMounts[0]!.memory;
    views[0]!.show(`${D}c.pdf`);
    m.onState!(`${D}c.pdf`, DOC);
    await flush();
    expect(m.pdfMounts).toHaveLength(2);
    expect(m.pdfMounts[1]!.memory).toBe(memory);
    unmount();
    expect(m.pdfMode!.dispose).toHaveBeenCalledTimes(2);
  });

  it("a PDF whose module lands after the user moved on mounts nothing", async () => {
    mount(`${D}a.pdf`);
    m.onState!(`${D}a.pdf`, DOC);
    views[0]!.show(`${F}001.jpg`);
    await flush();
    expect(m.pdfMounts).toHaveLength(0);
    expect(m.pdfMode!.open).not.toHaveBeenCalled();
  });

  it("a failure the loader reports takes the PDF mode down", async () => {
    await shownPdf(`${D}a.pdf`);
    m.onState!(`${D}a.pdf`, { state: "failed", message: "x" });
    expect(m.pdfMode!.dispose).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+F finds, Home / End go to the first and last page", async () => {
    mount(`${F}001.jpg`);
    // nothing to find without a PDF, and Home is still a seek
    expect(m.keys.has("find")).toBe(false);
    m.keys.get("goStart")!({ repeat: false });
    expect(m.pdfMode!.goPage).not.toHaveBeenCalled();
    remount();
    await shownPdf(`${D}a.pdf`);
    m.keys.get("find")!({ repeat: false });
    expect(m.pdfMode!.find).toHaveBeenCalledTimes(1);
    m.keys.get("goStart")!({ repeat: false });
    expect(m.pdfMode!.goPage).toHaveBeenLastCalledWith("first");
    m.keys.get("goEnd")!({ repeat: false });
    expect(m.pdfMode!.goPage).toHaveBeenLastCalledWith("last");
  });

  it("binds find and the zoom keys only while a PDF is shown, so elsewhere their chords fall through", async () => {
    const PDF_ONLY = ["find", "imgZoomIn", "imgZoomOut", "imgZoomFit", "imgZoom100"];
    mount(`${F}001.jpg`);
    m.onState!(`${F}001.jpg`, { state: "ready", element: "img", url: "u", kind: "image", tryingDirect: false });
    // ShortcutManager preventDefault()s any chord with a handler: none here
    for (const a of PDF_ONLY) expect(m.keys.has(a), a).toBe(false);
    remount();
    await shownPdf(`${D}a.pdf`);
    for (const a of PDF_ONLY) expect(m.keys.has(a), a).toBe(true);
    m.keys.get("imgZoomIn")!({ repeat: false });
    m.keys.get("imgZoom100")!({ repeat: false });
    expect(m.pdfMode!.zoom.mock.calls).toEqual([["in"], ["100"]]);
    // a video after it: the PDF mode goes, and its chords with it
    views[0]!.show("D:\\clips\\x.mp4");
    expect(m.pdfMode!.dispose).toHaveBeenCalledTimes(1);
    for (const a of PDF_ONLY) expect(m.keys.has(a), a).toBe(false);
  });

  it("Space pages the strip over a PDF (Shift+Space up), and plays a video again after", async () => {
    await shownPdf(`${D}a.pdf`, ["D:\\clips\\x.mp4"]);
    m.keys.get("playPause")!({ repeat: false, shiftKey: false });
    expect(m.pdfMode!.scrollPage).toHaveBeenLastCalledWith(1);
    // Shift+Space is no chord of Play / Pause: the viewer's own listener
    // (isTypingTarget asks `instanceof HTMLElement`; a null target is none)
    vi.stubGlobal("HTMLElement", class {});
    const shift = (over: Record<string, unknown> = {}) => {
      const ev = { key: " ", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false, defaultPrevented: false, target: null, preventDefault: vi.fn(), ...over };
      for (const fn of m.winKeys) fn(ev);
      return ev;
    };
    const ev = shift();
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(m.pdfMode!.scrollPage).toHaveBeenLastCalledWith(-1);
    expect(m.pdfMode!.scrollPage).toHaveBeenCalledTimes(2);
    // a binding the user gave Shift+Space already claimed it
    shift({ defaultPrevented: true });
    expect(m.pdfMode!.scrollPage).toHaveBeenCalledTimes(2);

    // a video: Space plays again, Shift+Space is left alone
    views[0]!.show("D:\\clips\\x.mp4");
    m.onState!("D:\\clips\\x.mp4", { state: "ready", element: "video", url: "v", kind: "video", tryingDirect: false });
    const root = created[0]!;
    const video = root.querySelector("#vw-video");
    video.duration = 10;
    m.keys.get("playPause")!({ repeat: false });
    expect(m.pdfMode!.scrollPage).toHaveBeenCalledTimes(2);
    expect(shift().preventDefault).not.toHaveBeenCalled();
  });

  it("a double-click on the pages selects a word, not fullscreen", async () => {
    const root = await shownPdf(`${D}a.pdf`);
    const page = { page: true };
    m.pdfMode!.owns.mockImplementation((t: unknown) => t === page);
    root.querySelector("#vw-stage").fire("dblclick", { target: page });
    expect(m.fsRequest).not.toHaveBeenCalled();
    root.querySelector("#vw-stage").fire("dblclick", { target: {} });
    expect(m.fsRequest).toHaveBeenCalledTimes(1);
  });

  it("never hides the chrome over a PDF, even in fullscreen", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => Date.now() });
    // control: a photo in fullscreen does fade
    const photo = mount(`${F}001.jpg`);
    m.keys.get("fullscreen")!({ repeat: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect((photo.classes as Set<string>).has("viewer--chrome-hidden")).toBe(true);
    remount();

    const root = mount(`${D}a.pdf`);
    m.onState!(`${D}a.pdf`, DOC);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.pdfMounts).toHaveLength(1);
    m.keys.get("fullscreen")!({ repeat: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect((root.classes as Set<string>).has("viewer--chrome-hidden")).toBe(false);
  });

  it("Open as project on a protected PDF says so as news, not as an error", async () => {
    const { PdfProtectedError } = await import("../core/open-media");
    const root = await shownPdf(`${D}locked.pdf`);
    m.load.mockClear();
    m.openMedia.mockRejectedValueOnce(new PdfProtectedError(`${D}locked.pdf`));
    root.querySelector("#vw-more").fire("click");
    m.menu.find((i) => i.label === "Open as project")!.onSelect();
    await flush();
    expect(m.openMedia).toHaveBeenCalledWith(`${D}locked.pdf`);
    expect(m.toastInfo).toHaveBeenCalledWith(new PdfProtectedError("x").message);
    expect(m.toastError).not.toHaveBeenCalled();
    // the PDF stays on screen: nothing reloaded, nothing taken down
    expect(m.load).not.toHaveBeenCalled();
    expect(m.pdfMode!.dispose).not.toHaveBeenCalled();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it("any other failed open is still an error", async () => {
    const root = await shownPdf(`${D}a.pdf`);
    m.openMedia.mockRejectedValueOnce(new Error("disk full"));
    root.querySelector("#vw-more").fire("click");
    m.menu.find((i) => i.label === "Open as project")!.onSelect();
    await flush();
    expect(m.toastError).toHaveBeenCalledTimes(1);
    expect(m.toastInfo).not.toHaveBeenCalled();
  });

  it("never imports src/pdf or ./pdf-mode statically", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./viewer.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/^import\s[^;]*from\s+"\.\.\/pdf\//m);
    const lines = src.match(/^import\s[^;]*"\.\/pdf-mode";/gm) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^import type /);
    expect(src).toContain('import("./pdf-mode")');
  });
});
