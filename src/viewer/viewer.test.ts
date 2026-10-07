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
  navigate: vi.fn(),
  /** The items of the last menu the viewer opened. */
  menu: [] as { label: string; onSelect: () => void }[],
  keys: new Map<string, (e: { repeat: boolean }) => void>(),
  /** The viewer's state callback, so a test can play the loader's part. */
  onState: null as null | ((p: string, s: LoadState) => void),
  prepare: vi.fn(),
  playbackFailed: vi.fn(),
  load: vi.fn(),
  openMedia: vi.fn(),
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
  openMediaAsProject: (p: string) => m.openMedia(p),
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
  /** Every `src` and `currentTime` assignment, in order ("src=…", "t=…"). */
  log: string[];
  /** The inline style properties set through style.setProperty. */
  styles: Map<string, string>;
}

function fakeEl(): FakeEl {
  const attrs = new Map<string, string>();
  const kids = new Map<string, FakeEl>();
  const listeners = new Map<string, () => void>();
  const styles = new Map<string, string>();
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
  m.menu = [];
  m.onState = null;
  m.prepare.mockReset();
  m.playbackFailed.mockReset();
  m.load.mockReset();
  m.openMedia.mockReset().mockResolvedValue("C:\\temp\\Quick view.trt");
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
