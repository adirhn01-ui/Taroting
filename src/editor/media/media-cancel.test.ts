import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEventHandlers, JobFailed, PlaybackPlan, WaveformResult } from "../../core/ipc";
import { ipc } from "../../core/ipc";
import { createProject } from "../../core/project";
import type { MediaRef, ProjectFile } from "../../core/types";
import { MediaManager } from "./media";

/**
 * WHAT THIS FILE IS ABOUT: which preparation jobs a MediaManager cancels, and
 * what it does when somebody ELSE cancels a job it joined.
 *
 *  - On dispose (and for a "pending" answer that lands after it) only WAVEFORM
 *    jobs are canceled. Remuxes and proxies run on into the cache, so leaving
 *    an editor and coming back rejoins or finds them instead of restarting a
 *    long transcode from zero.
 *  - The backend shares one job per output path, so a job a live manager is
 *    waiting on can be canceled by another consumer. A canceled failure used
 *    to be ignored outright, stranding the media on "Preparing" (or without a
 *    waveform) for the session; now the manager asks again.
 *
 * Fixtures differ on every axis the code could confuse: playback and waveform
 * job ids never coincide, the re-plan answers in a different MODE than the
 * first plan, and each media has its own path.
 */

// `onJobEvents` is a standalone export, which a spy on the `ipc` object cannot
// reach, so it is replaced here and hands its handlers to the test. The `ipc`
// object itself is the real one, so `vi.spyOn(ipc, …)` still lands where
// media.ts calls it.
let handlers: JobEventHandlers = {};
vi.mock("../../core/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/ipc")>();
  return {
    ...actual,
    onJobEvents: async (h: JobEventHandlers) => {
      handlers = h;
      return () => {
        handlers = {};
      };
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  handlers = {};
});

const media = (id: string, hasAudio = true): MediaRef => ({
  id,
  path: `D:\\${id}.mov`,
  size: 10 + id.length,
  mtimeMs: 5,
  kind: "video",
  duration: 3,
  hasAudio,
  width: 640,
  height: 360,
});

function projectOf(...m: MediaRef[]): ProjectFile {
  return { ...createProject("x"), media: m };
}

/** Let every queued continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function failed(id: number, canceled: boolean): JobFailed {
  return { id, kind: "remux", canceled, message: canceled ? "canceled" : "moov atom not found", logTail: [] };
}

describe("MediaManager cancel at dispose", () => {
  it("cancels its waveform jobs and leaves playback preparation running", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m) => ({ mode: "pending", jobId: m.id === "a" ? 41 : 42, output: "o" }) as PlaybackPlan,
    );
    vi.spyOn(ipc, "ensureWaveform").mockImplementation(
      async (k) => ({ state: "pending", jobId: k.path.includes("a.mov") ? 51 : 52, output: "w" }) as WaveformResult,
    );
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const p = projectOf(media("a"), media("b"));
    const m = new MediaManager(() => p);
    m.ensureAll(p);
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    m.dispose();
    // 41 and 42 are proxies the next open of this project rejoins.
    expect(cancel.mock.calls.map((c) => c[0]).sort()).toEqual([51, 52]);
  });

  it("cancels a waveform answering after dispose, but not a pending plan", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    let rp!: (v: PlaybackPlan) => void;
    let rw!: (v: WaveformResult) => void;
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise((r) => (rp = r)));
    vi.spyOn(ipc, "ensureWaveform").mockReturnValue(new Promise((r) => (rw = r)));
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const p = projectOf(media("a"));
    const m = new MediaManager(() => p);
    m.ensureAll(p);
    await settle();
    m.dispose();
    expect(cancel).not.toHaveBeenCalled();
    rp({ mode: "pending", jobId: 77, output: "o" });
    rw({ state: "pending", jobId: 78, output: "w" });
    await settle();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([78]);
  });

  it("cancels nothing for a direct plan after dispose, and swallows a rejecting cancel", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    let rp!: (v: PlaybackPlan) => void;
    let rw!: (v: WaveformResult) => void;
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise((r) => (rp = r)));
    vi.spyOn(ipc, "ensureWaveform").mockReturnValue(new Promise((r) => (rw = r)));
    const cancel = vi.spyOn(ipc, "cancelJob").mockRejectedValue(new Error("gone"));
    const p = projectOf(media("a"));
    const m = new MediaManager(() => p);
    m.ensureAll(p);
    await settle();
    m.dispose();
    rp({ mode: "direct", path: "D:\\a.mov" });
    rw({ state: "none" });
    await settle();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("MediaManager when another consumer cancels a joined job", () => {
  it("re-plans a playback job canceled under it instead of sticking on Preparing", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValueOnce({ mode: "pending", jobId: 41, output: "C:\\cache\\a.mp4" })
      .mockResolvedValueOnce({ mode: "ready", path: "C:\\cache\\a-fresh.mp4" });
    const p = projectOf(media("a", false));
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();
    expect(m.status.get()["a"]).toEqual({ state: "preparing", ratio: null, jobId: 41 });
    handlers.onFailed!(failed(41, true));
    await settle();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(m.status.get()["a"]).toEqual({
      state: "ready",
      url: "C:\\cache\\a-fresh.mp4",
      sourcePath: "C:\\cache\\a-fresh.mp4",
    });
    m.dispose();
  });

  it("still stamps a real failure as failed, and does not re-plan it", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValue({ mode: "pending", jobId: 41, output: "C:\\cache\\a.mp4" });
    const p = projectOf(media("a", false));
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();
    handlers.onFailed!(failed(41, false));
    await settle();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(m.status.get()["a"]).toEqual({ state: "failed", message: "moov atom not found" });
    m.dispose();
  });

  it("re-asks for just the waveform when a joined waveform job is canceled", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    // loadWaveform fetches the peaks file; nothing here needs it to succeed.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no asset protocol in a unit test")));
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockResolvedValue({ mode: "direct", path: "D:\\a.mov" });
    const wave = vi
      .spyOn(ipc, "ensureWaveform")
      .mockResolvedValueOnce({ state: "pending", jobId: 51, output: "C:\\cache\\a.pk" })
      .mockResolvedValueOnce({ state: "pending", jobId: 53, output: "C:\\cache\\a.pk" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const p = projectOf(media("a"));
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();
    handlers.onFailed!(failed(51, true));
    await settle();
    expect(wave).toHaveBeenCalledTimes(2);
    // The playback side was fine and is left alone: no re-plan, no flash back
    // to "checking".
    expect(plan).toHaveBeenCalledTimes(1);
    expect(m.status.get()["a"]).toEqual({ state: "ready", url: "D:\\a.mov", sourcePath: "D:\\a.mov" });
    // And the fresh job is really registered: dispose cancels 53, not the
    // dead 51.
    m.dispose();
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([53]);
  });
});
