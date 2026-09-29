import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JobEventHandlers,
  PlaybackClass,
  PlaybackClassInfo,
  PlaybackPlan,
} from "../core/ipc";
import { ipc } from "../core/ipc";
import { settingsStore } from "../core/session";
import { DEFAULT_SETTINGS, type MediaInfo } from "../core/types";
import { createSourceLoader, type LoadState } from "./loader";

/**
 * WHAT THIS FILE IS ABOUT: which ipc calls the viewer's loader makes for a
 * file, which preparation jobs it starts, and which it cancels.
 *
 *  - Stills never touch ipc. Video/audio: probe → classify → direct / a
 *    container-only direct attempt / an automatic remux / "Prepare preview".
 *  - A job the loader started is canceled when the user moves on, exactly
 *    once. Only dispose() spares a job handOff() promised to the editor.
 *  - A foreign cancel of the current job earns ONE re-plan.
 *
 * Fixtures differ on every axis the code could confuse: every plan answers
 * with its own job id, the probed size/mtime are distinct numbers that must
 * reach enforceCacheLimit's key, the job output differs from the source path,
 * and the viewer's classify (forceProxyLarge false) disagrees with the
 * editor's (proxyMedia true) only where the hand-off test needs it to.
 */

// `onJobEvents` is a standalone export that a spy on `ipc` cannot reach, so it
// is replaced here and hands its handlers to the test. `subscribeGate` lets a
// test hold the registration open (it is async in the real app).
let handlers: JobEventHandlers = {};
let subscribeGate: Promise<void> | null = null;
let subscribeFails = false;
let unlistened = 0;
vi.mock("../core/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...actual,
    onJobEvents: async (h: JobEventHandlers) => {
      if (subscribeGate) await subscribeGate;
      if (subscribeFails) throw new Error("listen refused");
      handlers = h;
      return () => {
        unlistened++;
        handlers = {};
      };
    },
  };
});

const MOV = "D:\\clips\\holiday.mov";
const MP3 = "D:\\clips\\song.mp3";
const WMV = "D:\\clips\\old.wmv";
const MTS = "D:\\clips\\cam.mts";
const IMG = "D:\\photos\\IMG_7.JPG";
const IMG_READY: LoadState = { state: "ready", element: "img", url: IMG, kind: "image", tryingDirect: false };

function info(path: string, extra: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path,
    size: 7340,
    mtimeMs: 1690,
    kind: "video",
    duration: 12,
    width: 1280,
    height: 720,
    hasAudio: true,
    ...extra,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let every queued continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A loader whose every emitted state is recorded as [path, state]. */
function recorded() {
  const states: Array<[string, LoadState]> = [];
  const loader = createSourceLoader((p, s) => states.push([p, s]));
  const last = (): LoadState | undefined => states[states.length - 1]?.[1];
  return { loader, states, last };
}

function classifyAs(byPath: Record<string, PlaybackClass>, prepared = false) {
  return vi
    .spyOn(ipc, "classifyPlayback")
    .mockImplementation(async (m) => ({ class: byPath[m.path]!, prepared }) as PlaybackClassInfo);
}

function probeAll(extra: Record<string, Partial<MediaInfo>> = {}) {
  return vi.spyOn(ipc, "probeMedia").mockImplementation(async (p) => info(p, extra[p]));
}

let savedSettings = settingsStore.get();
beforeEach(() => {
  savedSettings = settingsStore.get();
  settingsStore.set({ ...DEFAULT_SETTINGS, proxyMedia: true, cacheLimitMB: 777 });
});

afterEach(() => {
  vi.restoreAllMocks();
  settingsStore.set(savedSettings);
  handlers = {};
  subscribeGate = null;
  subscribeFails = false;
  unlistened = 0;
  delete (globalThis as { __tarotingViewerDev?: unknown }).__tarotingViewerDev;
});

describe("stills", () => {
  it("show a jpg and a gif in the <img> with no ipc call at all", async () => {
    const probe = vi.spyOn(ipc, "probeMedia");
    const classify = vi.spyOn(ipc, "classifyPlayback");
    const plan = vi.spyOn(ipc, "planPlayback");
    const cancel = vi.spyOn(ipc, "cancelJob");
    const { loader, states } = recorded();
    loader.load("D:\\photos\\IMG_7.JPG");
    loader.load("D:\\photos\\spin.gif");
    await settle();
    expect(states).toEqual([
      ["D:\\photos\\IMG_7.JPG", { state: "loading" }],
      [
        "D:\\photos\\IMG_7.JPG",
        { state: "ready", element: "img", url: "D:\\photos\\IMG_7.JPG", kind: "image", tryingDirect: false },
      ],
      ["D:\\photos\\spin.gif", { state: "loading" }],
      [
        "D:\\photos\\spin.gif",
        { state: "ready", element: "img", url: "D:\\photos\\spin.gif", kind: "image", tryingDirect: false },
      ],
    ]);
    expect(probe).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(loader.debug()).toEqual({ loads: 2, lastClass: null, jobId: null });
  });

  it("refuses an extension outside the media table without asking the backend", async () => {
    const probe = vi.spyOn(ipc, "probeMedia");
    const { loader, last } = recorded();
    loader.load("D:\\docs\\notes.txt");
    await settle();
    // No detail line: the viewer's heading already says it can't be shown.
    expect(last()).toEqual({ state: "failed", message: "" });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("classification", () => {
  it("plays a direct file as-is, with the probe's kind, and plans nothing", async () => {
    probeAll({ [MP3]: { kind: "audio", width: undefined, height: undefined } });
    const classify = classifyAs({ [MOV]: "direct", [MP3]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback");
    const { loader, last } = recorded();
    loader.load(MP3);
    await settle();
    expect(last()).toEqual({ state: "ready", element: "video", url: MP3, kind: "audio", tryingDirect: false });
    // The viewer never forces a proxy (4K plays direct here).
    expect(classify.mock.calls[0]![2]).toBe(false);
    expect(classify.mock.calls[0]![0]).toMatchObject({ id: "viewer", path: MP3, size: 7340, mtimeMs: 1690 });
    expect(plan).not.toHaveBeenCalled();
    expect(loader.debug().lastClass).toBe("direct");
  });

  it("proxy class waits for Prepare preview; nothing is planned before it", async () => {
    probeAll();
    classifyAs({ [WMV]: "proxy" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValue({ mode: "pending", jobId: 41, output: "C:\\cache\\p41.mp4" });
    const { loader, last } = recorded();
    loader.load(WMV);
    await settle();
    expect(last()).toEqual({ state: "needsPrepare" });
    expect(plan).not.toHaveBeenCalled();
    expect(loader.debug()).toEqual({ loads: 1, lastClass: "proxy", jobId: null });
    loader.prepare();
    loader.prepare(); // a double press starts nothing more
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]![2]).toBe(false);
    expect(last()).toEqual({ state: "preparing", ratio: null });
    expect(loader.debug().jobId).toBe(41);
  });

  it("container-only tries the file directly, then remuxes once when that fails", async () => {
    probeAll();
    classifyAs({ [MOV]: "containerOnly" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValue({ mode: "pending", jobId: 52, output: "C:\\cache\\r52.mp4" });
    const { loader, last } = recorded();
    loader.load(MOV);
    await settle();
    expect(last()).toEqual({ state: "ready", element: "video", url: MOV, kind: "video", tryingDirect: true });
    expect(plan).not.toHaveBeenCalled();
    loader.prepare(); // wrong state: not a proxy file
    await settle();
    expect(plan).not.toHaveBeenCalled();
    loader.directFailed();
    loader.directFailed();
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ state: "preparing", ratio: null });
  });

  it("remux class plans at once, but only after the job listener exists", async () => {
    const gate = deferred<void>();
    subscribeGate = gate.promise;
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValue({ mode: "pending", jobId: 63, output: "C:\\cache\\r63.mp4" });
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    expect(plan).not.toHaveBeenCalled();
    gate.resolve();
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(loader.debug().jobId).toBe(63);
  });

  it("a cached preparation plans straight away, unless the DEV knob hides it", async () => {
    probeAll();
    classifyAs({ [WMV]: "proxy" }, true);
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "ready", path: "C:\\cache\\p9.mp4" });
    const a = recorded();
    a.loader.load(WMV);
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(a.last()).toEqual({
      state: "ready",
      element: "video",
      url: "C:\\cache\\p9.mp4",
      kind: "video",
      tryingDirect: false,
    });
    (globalThis as { __tarotingViewerDev?: unknown }).__tarotingViewerDev = { forceUnprepared: true };
    const b = recorded();
    b.loader.load(WMV);
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(b.last()).toEqual({ state: "needsPrepare" });
  });

  it("a probe failure is reported with the backend's message", async () => {
    vi.spyOn(ipc, "probeMedia").mockRejectedValue({ code: "ffprobe", message: "Invalid data found" });
    const classify = vi.spyOn(ipc, "classifyPlayback");
    const { loader, last } = recorded();
    loader.load(MOV);
    await settle();
    expect(last()).toEqual({ state: "failed", message: "Invalid data found" });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("answers arriving after the user moved on", () => {
  it("a late classify puts nothing on the file now shown", async () => {
    probeAll();
    const answer = deferred<PlaybackClassInfo>();
    vi.spyOn(ipc, "classifyPlayback").mockReturnValueOnce(answer.promise);
    const { loader, states, last } = recorded();
    loader.load(MOV);
    await settle();
    loader.load(IMG);
    const before = states.length;
    // "proxy", not "remux": a remux answer would reach plan(), whose own
    // re-check would hide a missing one here.
    answer.resolve({ class: "proxy", prepared: false } as PlaybackClassInfo);
    await settle();
    expect(states.length).toBe(before);
    expect(last()).toEqual(IMG_READY);
    expect(loader.debug().lastClass).toBeNull();
  });

  it("a late probe does not become the shown file", async () => {
    const mts = deferred<MediaInfo>();
    const mov = deferred<MediaInfo>();
    vi.spyOn(ipc, "probeMedia").mockImplementation((p) => (p === MTS ? mts : mov).promise);
    const classify = classifyAs({ [MTS]: "remux", [MOV]: "remux" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 57, output: "C:\\cache\\r57.mp4" });
    const trim = vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    const { loader, last } = recorded();
    loader.load(MTS);
    loader.load(MOV);
    mov.resolve(info(MOV, { size: 9120, mtimeMs: 2204 }));
    await settle();
    expect(loader.debug().jobId).toBe(57);
    // The file left behind answers last, and as audio: a kind, a size and a
    // path that all differ from what is on screen.
    mts.resolve(info(MTS, { kind: "audio" }));
    await settle();
    await loader.handOff();
    expect(classify.mock.calls.map((c) => c[0].path)).toEqual([MOV, MOV]);
    handlers.onDone!({ id: 57, kind: "remux", output: { path: "C:\\cache\\r57.mp4" } });
    expect(last()).toEqual({
      state: "ready",
      element: "video",
      url: "C:\\cache\\r57.mp4",
      kind: "video",
      tryingDirect: false,
    });
    expect(trim.mock.calls[0]).toEqual([777, [{ path: MOV, size: 9120, mtimeMs: 2204 }]]);
  });

  it("a load superseded while the job listener registers plans nothing", async () => {
    const gate = deferred<void>();
    subscribeGate = gate.promise;
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 63, output: "o" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle(); // probed and classified, waiting on the listener
    loader.load(IMG);
    gate.resolve();
    await settle();
    expect(plan).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(last()).toEqual(IMG_READY);
  });
});

describe("jobs", () => {
  it("a second load cancels the first pending job exactly once", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux", [WMV]: "proxy" });
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m) =>
        ({ mode: "pending", jobId: m.path === MTS ? 41 : 57, output: "o" }) as PlaybackPlan,
    );
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    expect(loader.debug().jobId).toBe(41);
    loader.load(WMV);
    loader.load("D:\\photos\\IMG_7.JPG");
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([41]);
    expect(loader.debug().jobId).toBeNull();
  });

  it("a plan answering after the user moved on cancels the job it started", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const answer = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(answer.promise);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, states } = recorded();
    loader.load(MTS);
    await settle();
    loader.load("D:\\photos\\IMG_7.JPG");
    const before = states.length;
    answer.resolve({ mode: "pending", jobId: 63, output: "o" });
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([63]);
    expect(states.length).toBe(before);
    expect(loader.debug().jobId).toBeNull();
  });

  it("done → ready from the job's output, and the cache is trimmed keeping this file", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "C:\\cache\\r41.mp4" });
    const trim = vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    handlers.onProgress!({ id: 41, kind: "remux", ratio: 0.34, outTimeMs: 1, fps: 1, speed: 1, etaSec: 2 });
    expect(last()).toEqual({ state: "preparing", ratio: 0.34 });
    expect(trim).not.toHaveBeenCalled();
    handlers.onDone!({ id: 41, kind: "remux", output: { path: "C:\\cache\\r41-final.mp4" } });
    expect(last()).toEqual({
      state: "ready",
      element: "video",
      url: "C:\\cache\\r41-final.mp4",
      kind: "video",
      tryingDirect: false,
    });
    expect(trim).toHaveBeenCalledTimes(1);
    expect(trim.mock.calls[0]).toEqual([777, [{ path: MTS, size: 7340, mtimeMs: 1690 }]]);
    expect(loader.debug().jobId).toBeNull();
  });

  it("events for a job the viewer moved past are ignored", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux", [WMV]: "proxy" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const trim = vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    const { loader, states, last } = recorded();
    loader.load(MTS);
    await settle();
    loader.load(WMV);
    await settle();
    expect(last()).toEqual({ state: "needsPrepare" });
    const before = states.length;
    handlers.onProgress!({ id: 41, kind: "remux", ratio: 0.5, outTimeMs: 1, fps: 1, speed: 1, etaSec: 1 });
    handlers.onDone!({ id: 41, kind: "remux", output: { path: "C:\\cache\\r41.mp4" } });
    handlers.onFailed!({ id: 41, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    expect(states.length).toBe(before);
    expect(trim).not.toHaveBeenCalled();
  });

  it("a job that finishes before its plan answers still lands", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const answer = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(answer.promise);
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    handlers.onDone!({ id: 88, kind: "remux", output: { path: "C:\\cache\\r88.mp4" } });
    answer.resolve({ mode: "pending", jobId: 88, output: "C:\\cache\\r88.mp4" });
    await settle();
    expect(last()).toEqual({
      state: "ready",
      element: "video",
      url: "C:\\cache\\r88.mp4",
      kind: "video",
      tryingDirect: false,
    });
    expect(loader.debug().jobId).toBeNull();
  });

  it("a foreign cancel of the current job re-plans once; a second one fails", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValueOnce({ mode: "pending", jobId: 41, output: "o41" })
      .mockResolvedValueOnce({ mode: "pending", jobId: 57, output: "o57" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    handlers.onFailed!({ id: 41, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(loader.debug().jobId).toBe(57);
    expect(last()).toEqual({ state: "preparing", ratio: null });
    handlers.onFailed!({ id: 57, kind: "remux", canceled: true, message: "Canceled again", logTail: [] });
    await settle();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(last()).toEqual({ state: "failed", message: "Canceled again" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("the one re-plan belongs to a file: the next file's foreign cancel re-plans too", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux", [MOV]: "remux" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValueOnce({ mode: "pending", jobId: 41, output: "o41" })
      .mockResolvedValueOnce({ mode: "pending", jobId: 57, output: "o57" })
      .mockResolvedValueOnce({ mode: "pending", jobId: 63, output: "o63" })
      .mockResolvedValueOnce({ mode: "pending", jobId: 88, output: "o88" });
    vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    handlers.onFailed!({ id: 41, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(loader.debug().jobId).toBe(57); // MTS spent its re-plan
    loader.load(MOV);
    await settle();
    expect(loader.debug().jobId).toBe(63);
    handlers.onFailed!({ id: 63, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(plan).toHaveBeenCalledTimes(4);
    expect(loader.debug().jobId).toBe(88);
    expect(last()).toEqual({ state: "preparing", ratio: null });
  });

  it("a job that could never be followed is canceled and reported", async () => {
    subscribeFails = true;
    probeAll();
    classifyAs({ [MTS]: "remux", [MP3]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 63, output: "o" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(MP3);
    await settle();
    // A direct file still plays without job events.
    expect(last()).toEqual({ state: "ready", element: "video", url: MP3, kind: "video", tryingDirect: false });
    loader.load(MTS);
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([63]);
    expect(last()).toEqual({ state: "failed", message: "Couldn't follow the preview preparation" });
    expect(loader.debug().jobId).toBeNull();
  });

  it("a real job failure is reported, not retried", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    handlers.onFailed!({ id: 41, kind: "remux", canceled: false, message: "moov atom not found", logTail: [] });
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ state: "failed", message: "moov atom not found" });
  });
});

describe("hand-off to the editor", () => {
  const BIG = "D:\\clips\\drone.mts";

  it("keeps the job when the editor would prepare the same thing", async () => {
    probeAll();
    const classify = classifyAs({ [MTS]: "remux" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    await loader.handOff();
    await loader.handOff(); // idempotent
    // The editor's question is asked with ITS proxy setting.
    expect(classify.mock.calls.slice(1).map((c) => c[2])).toEqual([true]);
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels the job when the editor would prepare something else, and says nothing", async () => {
    probeAll({ [BIG]: { width: 3840, height: 2160 } });
    // The backend's answer for a 4K file: the viewer (forceProxyLarge false)
    // remuxes it, the editor (proxyMedia true) proxies it.
    vi.spyOn(ipc, "classifyPlayback").mockImplementation(
      async (_m, _h, force) => ({ class: force ? "proxy" : "remux", prepared: false }) as PlaybackClassInfo,
    );
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o41" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, states } = recorded();
    loader.load(BIG);
    await settle();
    const before = states.length;
    await loader.handOff();
    await loader.handOff();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([41]);
    expect(loader.debug().jobId).toBeNull();
    // The project is opening: no "Prepare preview" flashing up under it.
    expect(states.length).toBe(before);
    // Our own cancel coming back is not a foreign one: no re-plan, no state.
    handlers.onFailed!({ id: 41, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(states.length).toBe(before);
  });

  it("a hand-off answering after the user moved on leaves the next file's job alone", async () => {
    probeAll();
    const editor = deferred<PlaybackClassInfo>();
    vi.spyOn(ipc, "classifyPlayback").mockImplementation((_m, _h, force) =>
      force ? editor.promise : Promise.resolve({ class: "remux", prepared: false } as PlaybackClassInfo),
    );
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m) => ({ mode: "pending", jobId: m.path === MTS ? 41 : 57, output: "o" }) as PlaybackPlan,
    );
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    const handed = loader.handOff();
    await settle(); // the editor's classify is in flight
    loader.load(MOV);
    await settle();
    expect(loader.debug().jobId).toBe(57);
    editor.resolve({ class: "proxy", prepared: false } as PlaybackClassInfo); // a mismatch
    await handed;
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([41]); // the load's, nothing more
    expect(loader.debug().jobId).toBe(57);
  });

  it("a job started after the hand-off agreed goes to the editor too", async () => {
    probeAll();
    const classify = classifyAs({ [MOV]: "containerOnly" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 52, output: "o52" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MOV);
    await settle();
    await loader.handOff(); // no job yet: the direct attempt is still running
    await loader.handOff();
    expect(classify).toHaveBeenCalledTimes(2); // the viewer's, and ONE for the editor
    loader.directFailed(); // the 4 s timeout, firing while the project opens
    await settle();
    expect(loader.debug().jobId).toBe(52);
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a job whose plan answered during the hand-off's classify goes to the editor too", async () => {
    probeAll();
    const editor = deferred<PlaybackClassInfo>();
    vi.spyOn(ipc, "classifyPlayback").mockImplementation((_m, _h, force) =>
      force ? editor.promise : Promise.resolve({ class: "containerOnly", prepared: false } as PlaybackClassInfo),
    );
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 52, output: "o52" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MOV);
    await settle();
    const handed = loader.handOff();
    await settle();
    loader.directFailed();
    await settle();
    expect(loader.debug().jobId).toBe(52);
    editor.resolve({ class: "containerOnly", prepared: false } as PlaybackClassInfo);
    await handed;
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a job started after the hand-off disagreed is still canceled on close", async () => {
    probeAll();
    vi.spyOn(ipc, "classifyPlayback").mockImplementation(
      async (_m, _h, force) => ({ class: force ? "proxy" : "containerOnly", prepared: false }) as PlaybackClassInfo,
    );
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 52, output: "o52" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MOV);
    await settle();
    await loader.handOff();
    loader.directFailed();
    await settle();
    loader.dispose();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([52]);
  });

  it("a plan answering after the viewer closed into the editor keeps the editor's job", async () => {
    probeAll();
    classifyAs({ [MOV]: "containerOnly" });
    const answer = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(answer.promise);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MOV);
    await settle();
    await loader.handOff();
    loader.directFailed();
    await settle();
    loader.dispose();
    answer.resolve({ mode: "pending", jobId: 52, output: "o52" });
    await settle();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a plan answering after the viewer moved on, then closed, is still canceled", async () => {
    probeAll();
    classifyAs({ [MOV]: "containerOnly" });
    const answer = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(answer.promise);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MOV);
    await settle();
    await loader.handOff();
    loader.directFailed();
    await settle();
    loader.load(IMG);
    loader.dispose();
    answer.resolve({ mode: "pending", jobId: 52, output: "o52" });
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([52]);
  });

  it("asks with the user's proxy setting, not a constant: proxies off → the 4K job is kept", async () => {
    // Same backend answer as above, but this user turned proxies OFF, so the
    // editor would remux too — the one case telling the stored setting apart
    // from a hardcoded `true` (which is also the default).
    settingsStore.set({ ...settingsStore.get(), proxyMedia: false });
    probeAll({ [BIG]: { width: 3840, height: 2160 } });
    vi.spyOn(ipc, "classifyPlayback").mockImplementation(
      async (_m, _h, force) => ({ class: force ? "proxy" : "remux", prepared: false }) as PlaybackClassInfo,
    );
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o41" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(BIG);
    await settle();
    await loader.handOff();
    expect(last()).toEqual({ state: "preparing", ratio: null });
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("waits for a plan still in flight before deciding", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const answer = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(answer.promise);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    const handed = loader.handOff();
    answer.resolve({ mode: "pending", jobId: 88, output: "o" });
    await handed;
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a load after the hand-off cancels the job: the editor never got it", async () => {
    // Only dispose() closes the viewer into the editor. A load on a live
    // loader means the open failed or an Explorer open superseded it.
    probeAll();
    classifyAs({ [MTS]: "remux", [WMV]: "proxy" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    await loader.handOff();
    loader.load(WMV);
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([41]);
  });

  it("a hand-off promise ends with the load it was made for", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux", [WMV]: "proxy" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(MTS);
    await settle();
    await loader.handOff();
    loader.load(WMV);
    await settle();
    loader.load(MTS); // back again: the backend answers with the same job id
    await settle();
    expect(loader.debug().jobId).toBe(41);
    loader.dispose(); // no hand-off on THIS visit: the job is ours to cancel
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([41, 41]);
  });
});

describe("dispose", () => {
  it("cancels the pending job and unlistens", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, states } = recorded();
    loader.load(MTS);
    await settle();
    loader.dispose();
    loader.dispose();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([41]);
    expect(unlistened).toBe(1);
    const before = states.length;
    loader.load(WMV);
    await settle();
    expect(states.length).toBe(before);
  });

  it("unlistens at once when the subscription resolves after dispose", async () => {
    const gate = deferred<void>();
    subscribeGate = gate.promise;
    const { loader } = recorded();
    loader.dispose();
    expect(unlistened).toBe(0);
    gate.resolve();
    await settle();
    expect(unlistened).toBe(1);
  });
});
