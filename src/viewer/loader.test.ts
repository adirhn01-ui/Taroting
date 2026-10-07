import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JobEventHandlers,
  PlaybackClass,
  PlaybackClassInfo,
  PlaybackPlan,
  RepairNote,
} from "../core/ipc";
import { ipc } from "../core/ipc";
import { settingsStore } from "../core/session";
import { DEFAULT_SETTINGS, type MediaInfo } from "../core/types";
import { createSourceLoader, type Damage, type LoadState } from "./loader";

/**
 * WHAT THIS FILE IS ABOUT: which ipc calls the viewer's loader makes for a
 * file, which preparation jobs it starts, and which it cancels.
 *
 *  - Stills never touch ipc. Video/audio: probe → classify → direct / a
 *    container-only direct attempt / an automatic remux / "Prepare preview".
 *  - A job the loader started is canceled when the user moves on, exactly
 *    once. Only dispose() spares a job handOff() promised to the editor.
 *  - A foreign cancel of the current job earns ONE re-plan.
 *  - A video the WebView refuses as undecodable (the file itself or its
 *    remux) is REPAIRED at once, once per load, and the user is told while it
 *    runs; a cached repair is used unasked. The refusal withdraws a hand-off
 *    made before it, so a repair started after a failed open is never kept
 *    for an editor that never came.
 *  - Where the backend names an INSTANT copy, it plays at once and the full
 *    repair behind it is followed: its progress (per whole percent), its end
 *    (the full copy replaces the instant one) and its failure (the instant
 *    copy stays, unrecovered). Both jobs are canceled, handed off and
 *    re-planned like any other.
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

function classifyAs(byPath: Record<string, PlaybackClass>, prepared = false, repaired = false) {
  return vi
    .spyOn(ipc, "classifyPlayback")
    .mockImplementation(async (m) => ({ class: byPath[m.path]!, prepared, repaired }) as PlaybackClassInfo);
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
    loader.playbackFailed(null);
    loader.playbackFailed(null);
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
    loader.playbackFailed(null); // the 4 s timeout, firing while the project opens
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
    loader.playbackFailed(null);
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
    loader.playbackFailed(null);
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
    loader.playbackFailed(null);
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
    loader.playbackFailed(null);
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

describe("a video the WebView refuses", () => {
  // An NVIDIA Instant Replay recording: probes as clean H.264 + AAC in MP4
  // (direct), and the WebView's decoder gives up on its first packets. The
  // repair copy's output differs from every source path and every remux/proxy
  // output, so a ready URL names the one plan it came from. These plans name
  // no damaged prefix (no instant copy): the repair is the one job.
  const NV = "D:\\clips\\Replay 2026.10.04 - 21.14.33.02.mp4";
  const REPAIR_OUT = "C:\\cache\\x77.repairps.mp4";
  const NOTE: RepairNote = { dropsHeaders: true };
  const REPAIRING: LoadState = { state: "preparing", ratio: null, damaged: true };
  const FAILED: LoadState = { state: "failed", message: "" };
  /** A full repair with no damaged prefix named: told, but no range. */
  const RECOVERED: Damage = { until: null, phase: "recovered", ratio: null };
  const shows = (url: string, damage?: Damage): LoadState =>
    damage === undefined
      ? { state: "ready", element: "video", url, kind: "video", tryingDirect: false }
      : { state: "ready", element: "video", url, kind: "video", tryingDirect: false, damage };

  it("a direct video it cannot decode is repaired at once, and the user is told while it runs", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const answer = deferred<PlaybackPlan>();
    const plan = vi.spyOn(ipc, "planPlayback").mockReturnValue(answer.promise);
    const { loader, states, last } = recorded();
    loader.load(NV);
    await settle();
    expect(last()).toEqual(shows(NV));
    loader.playbackFailed(3);
    // Before the backend answers: no offer, no press — a repair is coming.
    expect(last()).toEqual(REPAIRING);
    loader.playbackFailed(3); // the same refusal reported twice plans once
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    // Never forcing a proxy, asking for the REPAIR.
    expect(plan.mock.calls[0]!.slice(2)).toEqual([false, true]);
    answer.resolve({ mode: "pending", jobId: 77, output: REPAIR_OUT, repair: NOTE });
    await settle();
    expect(last()).toEqual(REPAIRING);
    expect(loader.debug().jobId).toBe(77);
    handlers.onProgress!({ id: 77, kind: "proxy", ratio: 0.3, outTimeMs: 1, fps: 1, speed: 1, etaSec: 9 });
    expect(last()).toEqual({ state: "preparing", ratio: 0.3, damaged: true });
    handlers.onDone!({ id: 77, kind: "proxy", output: { path: REPAIR_OUT } });
    expect(last()).toEqual(shows(REPAIR_OUT, RECOVERED));
    // Nothing ever asked for a press.
    expect(states.some(([, s]) => s.state === "needsPrepare")).toBe(false);
  });

  it("only a decode (3) or unsupported-source (4) refusal is repaired; the rest fail as before", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise<PlaybackPlan>(() => {}));
    const got: Array<[number | null, LoadState | undefined]> = [];
    for (const code of [3, 4, 2, 1, null]) {
      const { loader, last } = recorded();
      loader.load(NV);
      await settle();
      loader.playbackFailed(code);
      got.push([code, last()]);
      await settle(); // the repair's plan is asked once the listener is up
      loader.dispose();
    }
    expect(got).toEqual([
      [3, REPAIRING],
      [4, REPAIRING],
      [2, FAILED],
      [1, FAILED],
      [null, FAILED],
    ]);
    expect(plan.mock.calls.map((c) => c[3])).toEqual([true, true]);
  });

  it("a repair copy it refuses too is reported, never repaired again", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "ready", path: REPAIR_OUT, repair: NOTE });
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    expect(last()).toEqual(shows(REPAIR_OUT, RECOVERED));
    loader.playbackFailed(3);
    expect(last()).toEqual(FAILED);
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("a repair the backend answers with the file itself is not repaired a second time", async () => {
    // The answer names the source as `direct`, so only "a repair was already
    // tried for this load" tells this refusal from the first one.
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "direct", path: NV });
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    expect(plan.mock.calls[0]![3]).toBe(true);
    expect(last()).toEqual(shows(NV));
    loader.playbackFailed(3);
    expect(last()).toEqual(FAILED);
  });

  it("a plan that names a repair copy unasked is never repaired again, and says the file is damaged", async () => {
    // Asked plainly (repair false), answered with the note: the copy on screen
    // is already the repair, whatever was asked.
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "ready", path: REPAIR_OUT, repair: NOTE });
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    expect(plan.mock.calls[0]![3]).toBe(false);
    expect(last()).toEqual(shows(REPAIR_OUT, RECOVERED));
    loader.playbackFailed(3);
    expect(last()).toEqual(FAILED);
  });

  it("a proxy it refuses is reported, not repaired: the proxy is already ffmpeg's own encode", async () => {
    probeAll();
    classifyAs({ [WMV]: "proxy" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "ready", path: "C:\\cache\\p41.mp4" });
    const { loader, last } = recorded();
    loader.load(WMV);
    await settle();
    expect(last()).toEqual({ state: "needsPrepare" });
    loader.prepare();
    await settle();
    expect(last()).toEqual(shows("C:\\cache\\p41.mp4"));
    loader.playbackFailed(3);
    expect(last()).toEqual(FAILED);
  });

  it("a remux it cannot decode is repaired: a stream copy carries the damage over", async () => {
    probeAll();
    classifyAs({ [MTS]: "remux" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValueOnce({ mode: "pending", jobId: 63, output: "C:\\cache\\r63.mp4" })
      .mockResolvedValueOnce({ mode: "pending", jobId: 77, output: REPAIR_OUT, repair: NOTE });
    const { loader, last } = recorded();
    loader.load(MTS);
    await settle();
    handlers.onDone!({ id: 63, kind: "remux", output: { path: "C:\\cache\\r63.mp4" } });
    expect(last()).toEqual(shows("C:\\cache\\r63.mp4"));
    loader.playbackFailed(3);
    expect(last()).toEqual(REPAIRING);
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([false, true]);
    expect(loader.debug().jobId).toBe(77);
  });

  it("a refused container-only attempt still remuxes first, whatever the code; its remux refused is repaired", async () => {
    probeAll();
    classifyAs({ [MOV]: "containerOnly" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValueOnce({ mode: "ready", path: "C:\\cache\\r52.mp4" })
      .mockResolvedValueOnce({ mode: "ready", path: REPAIR_OUT, repair: NOTE });
    const { loader, last } = recorded();
    loader.load(MOV);
    await settle();
    expect(last()).toEqual({ state: "ready", element: "video", url: MOV, kind: "video", tryingDirect: true });
    loader.playbackFailed(3);
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([false]);
    expect(last()).toEqual(shows("C:\\cache\\r52.mp4"));
    loader.playbackFailed(3);
    expect(last()).toEqual(REPAIRING);
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([false, true]);
    expect(last()).toEqual(shows(REPAIR_OUT, RECOVERED));
  });

  it("a video whose repair copy is cached goes straight to it: no direct attempt, still told it is damaged", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" }, false, true);
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValue({ mode: "ready", path: REPAIR_OUT, repair: { dropsHeaders: true, damagedUntil: 60.499 } });
    const { loader, states } = recorded();
    loader.load(NV);
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]!.slice(2)).toEqual([false, true]);
    expect(states).toEqual([
      [NV, { state: "loading" }],
      [NV, shows(REPAIR_OUT, { until: 60.499, phase: "recovered", ratio: null })],
    ]);
  });

  it("a cached repair copy wins over a cached remux of the same container-only file", async () => {
    // The repair exists because that remux was refused.
    probeAll();
    classifyAs({ [MOV]: "containerOnly" }, true, true);
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "ready", path: REPAIR_OUT, repair: NOTE });
    const { loader, last } = recorded();
    loader.load(MOV);
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([true]);
    expect(last()).toEqual(shows(REPAIR_OUT, RECOVERED));
  });

  it("a remux-class file whose repair copy is cached goes straight to it, not to the remux it refused", async () => {
    // Both copies are cached (the repair exists because the remux was
    // refused); the backend answers each kind of plan with its own copy.
    probeAll();
    classifyAs({ [MTS]: "remux" }, true, true);
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockImplementation(async (_m, _h, _force, repair) =>
        repair
          ? { mode: "ready", path: REPAIR_OUT, repair: NOTE }
          : { mode: "ready", path: "C:\\cache\\r63.mp4" },
      );
    const { loader, states } = recorded();
    loader.load(MTS);
    await settle();
    expect(plan.mock.calls.map((c) => c.slice(2))).toEqual([[false, true]]);
    expect(states).toEqual([
      [MTS, { state: "loading" }],
      [MTS, shows(REPAIR_OUT, RECOVERED)],
    ]);
  });

  it("the DEV knob hides a cached repair copy as it hides a cached preview copy", async () => {
    (globalThis as { __tarotingViewerDev?: unknown }).__tarotingViewerDev = { forceUnprepared: true };
    probeAll();
    classifyAs({ [NV]: "direct" }, false, true);
    const plan = vi.spyOn(ipc, "planPlayback");
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    expect(plan).not.toHaveBeenCalled();
    expect(last()).toEqual(shows(NV));
  });

  it("a refusal reported after the user moved on to a file awaiting Prepare preview changes nothing", async () => {
    probeAll();
    classifyAs({ [NV]: "direct", [WMV]: "proxy" });
    const plan = vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "C:\\cache\\p41.mp4" });
    const { loader, states, last } = recorded();
    loader.load(NV);
    await settle();
    loader.load(WMV);
    await settle();
    expect(last()).toEqual({ state: "needsPrepare" });
    const before = states.length;
    loader.playbackFailed(3);
    await settle();
    expect(states.length).toBe(before);
    expect(plan).not.toHaveBeenCalled();
    // The press still plans the plain preview copy of the file now shown.
    loader.prepare();
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([false]);
  });

  it("a refusal reported while the next file is still probing changes nothing", async () => {
    const mts = deferred<MediaInfo>();
    vi.spyOn(ipc, "probeMedia").mockImplementation(async (p) => (p === MTS ? mts.promise : info(p)));
    classifyAs({ [NV]: "direct", [MTS]: "remux" });
    const plan = vi.spyOn(ipc, "planPlayback");
    const { loader, states } = recorded();
    loader.load(NV);
    await settle();
    loader.load(MTS);
    await settle();
    const before = states.length;
    loader.playbackFailed(3);
    await settle();
    expect(states.length).toBe(before);
    expect(plan).not.toHaveBeenCalled();
  });

  it("a second refusal under the failure card changes nothing", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const { loader, states, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(2);
    expect(last()).toEqual(FAILED);
    const before = states.length;
    loader.playbackFailed(3);
    expect(states.length).toBe(before);
  });

  it("an audio file it refuses is reported as before: the repair is a video recipe", async () => {
    probeAll({ [MP3]: { kind: "audio", width: undefined, height: undefined } });
    classifyAs({ [MP3]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback");
    const { loader, last } = recorded();
    loader.load(MP3);
    await settle();
    loader.playbackFailed(3);
    expect(last()).toEqual(FAILED);
    expect(plan).not.toHaveBeenCalled();
  });

  it("a repair job canceled under the viewer is planned again as a repair", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValueOnce({ mode: "pending", jobId: 77, output: REPAIR_OUT, repair: NOTE })
      .mockResolvedValueOnce({ mode: "pending", jobId: 88, output: REPAIR_OUT, repair: NOTE });
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 77, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([true, true]);
    expect(loader.debug().jobId).toBe(88);
    handlers.onDone!({ id: 88, kind: "proxy", output: { path: REPAIR_OUT } });
    expect(last()).toEqual(shows(REPAIR_OUT, RECOVERED));
  });

  it("a repair job is handed to the editor like any other", async () => {
    // The editor classifies the file `direct` too, hits the same refusal, and
    // its own repair plan joins this job by its output path.
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 77, output: REPAIR_OUT, repair: NOTE });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    await loader.handOff();
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a repair started by a refusal after a hand-off made while the file played is canceled on close", async () => {
    // The order a failed "Open as project" leaves behind: the hand-off agreed
    // while the video was playing (no job), the open failed and the viewer
    // kept the settled video's load, then the WebView refused the file and the
    // repair started by itself. No editor will ever join that job.
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 77, output: REPAIR_OUT, repair: NOTE });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(NV);
    await settle();
    await loader.handOff(); // the editor classifies it `direct` too: agreed
    loader.playbackFailed(3);
    await settle();
    expect(loader.debug().jobId).toBe(77);
    loader.dispose();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([77]);
  });

  it("an open asked for after the refusal still hands the repair it started to the editor", async () => {
    // The refusal withdrew the earlier hand-off's claim, not the editor's
    // right to a job: a second "Open as project" decides afresh, and the
    // repair running under it is the editor's to join. (Fails if the
    // withdrawal ever outlives a hand-off asked for after the refusal.)
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 77, output: REPAIR_OUT, repair: NOTE });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(NV);
    await settle();
    await loader.handOff();
    loader.playbackFailed(3);
    await loader.handOff();
    await settle();
    expect(loader.debug().jobId).toBe(77);
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("the instant copy of a damaged file", () => {
  // The owner's file: the first 60.499 s unreadable. The backend's plan names
  // the INSTANT copy (a stream copy from the first sound keyframe) and the full
  // repair behind it. Every id and path differs: the instant copy's job (88)
  // and output, the full repair's job (91) and output, a second full repair
  // job (92), and the source.
  const NV = "D:\\clips\\Genshin Impact 2026.09.30 - 14.18.37.02.mp4.mp4";
  const QUICK_OUT = "C:\\cache\\g5.quick.mp4";
  const FULL_OUT = "C:\\cache\\g5.repairps.mp4";
  const UNTIL = 60.499;
  const QUICK: RepairNote = { dropsHeaders: true, damagedUntil: UNTIL, quick: true };
  const UPGRADE = { jobId: 91, output: FULL_OUT };
  const READY_QUICK: PlaybackPlan = { mode: "ready", path: QUICK_OUT, repair: QUICK, upgrade: UPGRADE };
  const PENDING_QUICK: PlaybackPlan = {
    mode: "pending",
    jobId: 88,
    output: QUICK_OUT,
    repair: QUICK,
    upgrade: UPGRADE,
  };
  const damage = (phase: Damage["phase"], ratio: number | null = null): Damage => ({ until: UNTIL, phase, ratio });
  const shows = (url: string, d: Damage): LoadState => ({
    state: "ready",
    element: "video",
    url,
    kind: "video",
    tryingDirect: false,
    damage: d,
  });
  const progress = (id: number, ratio: number | null): void =>
    handlers.onProgress!({ id, kind: "proxy", ratio, outTimeMs: 1, fps: 1, speed: 1, etaSec: 5 });

  /** The file played direct and refused, the repair planned with `answer`. */
  async function refused(answer: PlaybackPlan | Promise<PlaybackPlan>) {
    probeAll({ [NV]: { size: 410_000_000, mtimeMs: 1_759_234_717 } });
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockImplementation(() => Promise.resolve(answer));
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const trim = vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    const r = recorded();
    r.loader.load(NV);
    await settle();
    r.loader.playbackFailed(3);
    await settle();
    return { ...r, plan, cancel, trim };
  }

  it("plays at once, and the full repair replaces it when its job is done", async () => {
    const { loader, states, last, trim } = await refused(READY_QUICK);
    expect(states.slice(-2)).toEqual([
      [NV, { state: "preparing", ratio: null, damaged: true }],
      [NV, shows(QUICK_OUT, damage("repairing"))],
    ]);
    // The full repair is what the load follows now.
    expect(loader.debug().jobId).toBe(91);
    expect(trim).not.toHaveBeenCalled();
    handlers.onDone!({ id: 91, kind: "proxy", output: { path: FULL_OUT } });
    expect(last()).toEqual(shows(FULL_OUT, damage("recovered")));
    expect(loader.debug().jobId).toBeNull();
    expect(trim.mock.calls[0]).toEqual([777, [{ path: NV, size: 410_000_000, mtimeMs: 1_759_234_717 }]]);
  });

  it("tells the full repair's progress only when the rounded percent changes", async () => {
    const { states } = await refused(READY_QUICK);
    const before = states.length;
    progress(91, 0.4);
    progress(91, 0.401); // still 40%
    progress(91, 0.404); // still 40%
    progress(91, 0.41);
    progress(91, 0.41);
    progress(91, null); // unknown again: reads differently
    expect(states.slice(before)).toEqual([
      [NV, shows(QUICK_OUT, damage("repairing", 0.4))],
      [NV, shows(QUICK_OUT, damage("repairing", 0.41))],
      [NV, shows(QUICK_OUT, damage("repairing", null))],
    ]);
  });

  it("a failed full repair keeps the instant copy playing, unrecovered", async () => {
    const { loader, states, last, plan } = await refused(READY_QUICK);
    progress(91, 0.5);
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: false, message: "Conversion failed", logTail: [] });
    await settle();
    expect(last()).toEqual(shows(QUICK_OUT, damage("unrecovered")));
    expect(states.some(([, s]) => s.state === "failed")).toBe(false);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(loader.debug().jobId).toBeNull();
  });

  it("a full repair canceled under it is asked for again once, with the instant copy left up", async () => {
    const answers: PlaybackPlan[] = [READY_QUICK, { ...READY_QUICK, upgrade: { jobId: 92, output: FULL_OUT } }];
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const { loader, states, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    progress(91, 0.3);
    const before = states.length;
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(plan.mock.calls.map((c) => c[3])).toEqual([true, true]);
    expect(loader.debug().jobId).toBe(92);
    // Never a "preparing", never another url: the copy on screen stays up,
    // only the progress it reports restarts with the new job.
    expect(states.slice(before)).toEqual([[NV, shows(QUICK_OUT, damage("repairing"))]]);
    handlers.onDone!({ id: 92, kind: "proxy", output: { path: FULL_OUT } });
    expect(last()).toEqual(shows(FULL_OUT, damage("recovered")));
  });

  it("a second cancel of the full repair leaves the instant copy unrecovered", async () => {
    const answers: PlaybackPlan[] = [READY_QUICK, { ...READY_QUICK, upgrade: { jobId: 92, output: FULL_OUT } }];
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    handlers.onFailed!({ id: 92, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(last()).toEqual(shows(QUICK_OUT, damage("unrecovered")));
  });

  it("a re-plan answering with the finished full repair swaps it in", async () => {
    const answers: PlaybackPlan[] = [
      READY_QUICK,
      { mode: "ready", path: FULL_OUT, repair: { dropsHeaders: true, damagedUntil: UNTIL } },
    ];
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(last()).toEqual(shows(FULL_OUT, damage("recovered")));
    expect(loader.debug().jobId).toBeNull();
  });

  /** The file refused, its repair answered by `answers` in order (a deferred
   *  one is awaited), with the instant copy up and its full repair (91)
   *  canceled under it by someone else. */
  async function canceledUnderIt(...answers: Array<PlaybackPlan | Promise<PlaybackPlan>>) {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const plan = vi.spyOn(ipc, "planPlayback").mockImplementation(() => Promise.resolve(answers.shift()!));
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const r = recorded();
    r.loader.load(NV);
    await settle();
    r.loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    return { ...r, plan, cancel };
  }

  it("an instant copy refused while its full repair is asked for again waits on the answer's full repair", async () => {
    const second = deferred<PlaybackPlan>();
    const { loader, states, last } = await canceledUnderIt(READY_QUICK, second.promise);
    loader.playbackFailed(3);
    expect(last()).toEqual({ state: "preparing", ratio: null, damaged: true });
    const before = states.length;
    second.resolve({ ...READY_QUICK, upgrade: { jobId: 92, output: FULL_OUT } });
    await settle();
    // The answer names the refused copy again: it is not shown.
    expect(states.slice(before)).toEqual([[NV, { state: "preparing", ratio: null, damaged: true }]]);
    expect(loader.debug().jobId).toBe(92);
    handlers.onDone!({ id: 92, kind: "proxy", output: { path: FULL_OUT } });
    expect(last()).toEqual(shows(FULL_OUT, damage("recovered")));
  });

  it("a quiet re-plan that finds the instant copy gone keeps the one on screen and follows the full repair", async () => {
    const evicted: PlaybackPlan = { ...PENDING_QUICK, jobId: 89, upgrade: { jobId: 92, output: FULL_OUT } };
    const { loader, states, cancel } = await canceledUnderIt(READY_QUICK, evicted);
    const before = states.length;
    await settle();
    // A second instant copy is not needed — one plays.
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([89]);
    expect(loader.debug().jobId).toBe(92);
    expect(states.slice(before).every(([, s]) => s.state === "ready" && s.url === QUICK_OUT)).toBe(true);
  });

  it("a quiet re-plan the backend fails leaves the instant copy playing, unrecovered", async () => {
    const refusal = Promise.reject(new Error("plan refused"));
    refusal.catch(() => {}); // handled where the loader awaits it; not an unhandled rejection meanwhile
    const { states, last } = await canceledUnderIt(READY_QUICK, refusal);
    await settle();
    expect(last()).toEqual(shows(QUICK_OUT, damage("unrecovered")));
    expect(states.some(([, s]) => s.state === "failed")).toBe(false);
  });

  it("a re-plan of a canceled instant copy lets go of a full repair the answer no longer names", async () => {
    const answers: PlaybackPlan[] = [
      PENDING_QUICK,
      { ...PENDING_QUICK, jobId: 89, upgrade: { jobId: 93, output: FULL_OUT } },
    ];
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 88, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([91]);
    expect(loader.debug().jobId).toBe(89);
    handlers.onDone!({ id: 89, kind: "remux", output: { path: QUICK_OUT } });
    expect(last()).toEqual(shows(QUICK_OUT, damage("repairing")));
    expect(loader.debug().jobId).toBe(93);
  });

  it("an instant copy still being made: 'preparing' (damaged), then the copy, then the full repair", async () => {
    const { loader, states, last } = await refused(PENDING_QUICK);
    // The instant copy's own job: preparing, with no percent to show.
    expect(last()).toEqual({ state: "preparing", ratio: null, damaged: true, quick: true });
    expect(loader.debug().jobId).toBe(88);
    const before = states.length;
    // Its progress is a stream copy's, not the repair's: once the copy plays
    // the repair's percent starts over, so showing this one would read as
    // going backwards. Nothing new to say, so nothing is emitted.
    progress(88, 0.5);
    // Nor is the full repair's progress before the copy lands a "preparing".
    progress(91, 0.02);
    expect(states.slice(before)).toEqual([]);
    handlers.onDone!({ id: 88, kind: "remux", output: { path: QUICK_OUT } });
    expect(last()).toEqual(shows(QUICK_OUT, damage("repairing")));
    expect(loader.debug().jobId).toBe(91);
    handlers.onDone!({ id: 91, kind: "proxy", output: { path: FULL_OUT } });
    expect(last()).toEqual(shows(FULL_OUT, damage("recovered")));
  });

  it("a full repair that ended before the instant copy's job reported lands right after the copy", async () => {
    const { loader, states } = await refused(PENDING_QUICK);
    handlers.onDone!({ id: 91, kind: "proxy", output: { path: FULL_OUT } });
    const before = states.length;
    handlers.onDone!({ id: 88, kind: "remux", output: { path: QUICK_OUT } });
    expect(states.slice(before)).toEqual([
      [NV, shows(QUICK_OUT, damage("repairing"))],
      [NV, shows(FULL_OUT, damage("recovered"))],
    ]);
    expect(loader.debug().jobId).toBeNull();
  });

  it("an instant copy that could not be made waits on the full repair behind it", async () => {
    const { loader, states, last } = await refused(PENDING_QUICK);
    handlers.onFailed!({ id: 88, kind: "remux", canceled: false, message: "moov atom not found", logTail: [] });
    expect(last()).toEqual({ state: "preparing", ratio: null, damaged: true });
    expect(loader.debug().jobId).toBe(91);
    progress(91, 0.6);
    expect(last()).toEqual({ state: "preparing", ratio: 0.6, damaged: true });
    handlers.onDone!({ id: 91, kind: "proxy", output: { path: FULL_OUT } });
    expect(last()).toEqual(shows(FULL_OUT, damage("recovered")));
    expect(states.some(([, s]) => s.state === "failed" || (s.state === "ready" && s.url === QUICK_OUT))).toBe(false);
  });

  it("an instant copy the WebView refuses waits on the full repair; without one it fails", async () => {
    const a = await refused(READY_QUICK);
    progress(91, 0.25);
    a.loader.playbackFailed(3);
    expect(a.last()).toEqual({ state: "preparing", ratio: 0.25, damaged: true });
    progress(91, 0.7);
    expect(a.last()).toEqual({ state: "preparing", ratio: 0.7, damaged: true });
    handlers.onDone!({ id: 91, kind: "proxy", output: { path: FULL_OUT } });
    expect(a.last()).toEqual(shows(FULL_OUT, damage("recovered")));
    // The full repair refused in turn is the end.
    a.loader.playbackFailed(3);
    expect(a.last()).toEqual({ state: "failed", message: "" });
    a.loader.dispose();
    vi.restoreAllMocks();

    const b = await refused({ mode: "ready", path: QUICK_OUT, repair: QUICK });
    expect(b.last()).toEqual(shows(QUICK_OUT, damage("unrecovered")));
    b.loader.playbackFailed(3);
    expect(b.last()).toEqual({ state: "failed", message: "" });
  });

  it("a full repair failing while the user waits on it is reported", async () => {
    const { loader, last } = await refused(READY_QUICK);
    // The instant copy refused: the full repair is all that is left to show.
    progress(91, 0.1);
    loader.playbackFailed(3);
    expect(last()).toEqual({ state: "preparing", ratio: 0.1, damaged: true });
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: false, message: "Conversion failed", logTail: [] });
    expect(last()).toEqual({ state: "failed", message: "Conversion failed" });
  });

  it("a re-plan the backend answers with the file itself drops what the instant copy's answer said", async () => {
    const answers: PlaybackPlan[] = [PENDING_QUICK, { mode: "direct", path: NV }];
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 88, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    // Nothing repaired is on screen, so no damage is reported for it, and the
    // full repair queued behind the canceled copy would run for nobody.
    expect(last()).toEqual({ state: "ready", element: "video", url: NV, kind: "video", tryingDirect: false });
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([91]);
  });

  it("an instant copy without a full repair behind it is unrecovered at once", async () => {
    const { loader, last } = await refused({ mode: "ready", path: QUICK_OUT, repair: QUICK });
    expect(last()).toEqual(shows(QUICK_OUT, damage("unrecovered")));
    expect(loader.debug().jobId).toBeNull();
  });

  it("names no range for a damaged prefix that is not a positive, finite number of seconds", async () => {
    const got: Array<number | null | undefined> = [];
    for (const u of [Number.NaN, -3, 0, Number.POSITIVE_INFINITY, 12.5]) {
      const { loader, last } = await refused({ ...READY_QUICK, repair: { ...QUICK, damagedUntil: u } });
      const s = last();
      got.push(s?.state === "ready" ? s.damage?.until : undefined);
      loader.dispose();
      vi.restoreAllMocks();
    }
    expect(got).toEqual([null, null, null, null, 12.5]);
  });

  it("the full repair is canceled with the file: stepping away, or closing", async () => {
    const a = await refused(READY_QUICK);
    a.loader.load(IMG);
    expect(a.cancel.mock.calls.map((c) => c[0])).toEqual([91]);
    a.loader.dispose();
    vi.restoreAllMocks();

    const b = await refused(READY_QUICK);
    b.loader.dispose();
    expect(b.cancel.mock.calls.map((c) => c[0])).toEqual([91]);
    vi.restoreAllMocks();

    // Still making the instant copy: both jobs go.
    const c = await refused(PENDING_QUICK);
    c.loader.load(IMG);
    expect(c.cancel.mock.calls.map((x) => x[0])).toEqual([88, 91]);
    // Their own cancels coming back change nothing.
    const before = c.states.length;
    handlers.onFailed!({ id: 88, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(c.states.length).toBe(before);
  });

  it("an answer for a file already left cancels the instant copy's job and the full repair", async () => {
    const answer = deferred<PlaybackPlan>();
    const { loader, cancel } = await refused(answer.promise);
    loader.load(IMG);
    answer.resolve(PENDING_QUICK);
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([88, 91]);

    vi.restoreAllMocks();
    const ready = deferred<PlaybackPlan>();
    const b = await refused(ready.promise);
    b.loader.load(IMG);
    ready.resolve(READY_QUICK);
    await settle();
    expect(b.cancel.mock.calls.map((c) => c[0])).toEqual([91]);
  });

  // A step away and straight back while the first visit's repair plan is
  // still out: the second visit's answer queues the full repair (91) behind
  // its instant copy's job (88), and the first answer, superseded, arrives
  // after it naming the same jobs (the backend shares one job per output).
  // Discarding it must spare both — the full repair is the one this load is
  // waiting to follow, canceled now it would restart from 0% on a re-plan.
  it("an answer for an earlier visit naming the full repair this visit queued leaves it running", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const stale = deferred<PlaybackPlan>();
    const answers: Array<Promise<PlaybackPlan>> = [stale.promise, Promise.resolve(PENDING_QUICK)];
    vi.spyOn(ipc, "planPlayback").mockImplementation(() => answers.shift()!);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    loader.load(IMG);
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    expect(loader.debug().jobId).toBe(88);
    stale.resolve(PENDING_QUICK);
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([]);
    // And it is still the full repair that follows the instant copy.
    handlers.onDone!({ id: 88, kind: "remux", output: { path: QUICK_OUT } });
    expect(loader.debug().jobId).toBe(91);
  });

  // The instant copy's job (88) is canceled under the load while the full
  // repair (91) waits queued behind it; the one re-plan it earns is refused by
  // the backend. The load fails — and a failed load reads nothing more, so the
  // full repair must go with it rather than run on for nobody until the next
  // file or the viewer's close.
  it("a re-plan the backend refuses while a full repair is queued fails the load and cancels that repair", async () => {
    probeAll();
    classifyAs({ [NV]: "direct" });
    const refusal = Promise.reject(new Error("plan refused"));
    refusal.catch(() => {}); // handled where the loader awaits it; not an unhandled rejection meanwhile
    const answers: Array<Promise<PlaybackPlan>> = [Promise.resolve(PENDING_QUICK), refusal];
    vi.spyOn(ipc, "planPlayback").mockImplementation(() => answers.shift()!);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, last } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    handlers.onFailed!({ id: 88, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(last()).toEqual({ state: "failed", message: "plan refused" });
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([91]);
  });

  it("goes to the editor with its full repair when the hand-off agrees, the job it adopts later too", async () => {
    const { loader, cancel } = await refused(PENDING_QUICK);
    await loader.handOff(); // the editor classifies the file `direct` too
    handlers.onDone!({ id: 88, kind: "remux", output: { path: QUICK_OUT } });
    expect(loader.debug().jobId).toBe(91);
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a full repair asked for again after the hand-off agreed goes to the editor too", async () => {
    const answers: PlaybackPlan[] = [READY_QUICK, { ...READY_QUICK, upgrade: { jobId: 92, output: FULL_OUT } }];
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    await loader.handOff();
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(loader.debug().jobId).toBe(92);
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("an instant copy asked for again after the hand-off agreed goes to the editor with its new full repair", async () => {
    const answers: PlaybackPlan[] = [
      PENDING_QUICK,
      { ...PENDING_QUICK, jobId: 89, upgrade: { jobId: 93, output: FULL_OUT } },
    ];
    probeAll();
    classifyAs({ [NV]: "direct" });
    vi.spyOn(ipc, "planPlayback").mockImplementation(async () => answers.shift()!);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    await loader.handOff(); // agreed: 88 and 91 are the editor's
    handlers.onFailed!({ id: 88, kind: "remux", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(loader.debug().jobId).toBe(89);
    loader.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a hand-off the editor disagrees with cancels the full repair, and says nothing", async () => {
    // A 4K recording: the viewer plays it direct, the editor would proxy it —
    // a different cache target, so the full repair would run for nobody.
    probeAll({ [NV]: { width: 3840, height: 2160 } });
    vi.spyOn(ipc, "classifyPlayback").mockImplementation(
      async (_m, _h, force) => ({ class: force ? "proxy" : "direct", prepared: false, repaired: false }) as PlaybackClassInfo,
    );
    vi.spyOn(ipc, "planPlayback").mockResolvedValue(READY_QUICK);
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const { loader, states } = recorded();
    loader.load(NV);
    await settle();
    loader.playbackFailed(3);
    await settle();
    const before = states.length;
    await loader.handOff();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([91]);
    expect(loader.debug().jobId).toBeNull();
    // Our own cancel coming back is not a foreign one: no re-plan, no state.
    handlers.onFailed!({ id: 91, kind: "proxy", canceled: true, message: "canceled", logTail: [] });
    await settle();
    expect(states.length).toBe(before);
  });

  it("a job that could never be followed: the instant copy plays unrecovered and the full repair is canceled", async () => {
    subscribeFails = true;
    const { loader, last, cancel } = await refused(READY_QUICK);
    expect(last()).toEqual(shows(QUICK_OUT, damage("unrecovered")));
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([91]);
    expect(loader.debug().jobId).toBeNull();
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
