import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDone, JobEventHandlers, JobFailed, PlaybackPlan, WaveformResult } from "../../core/ipc";
import { ipc } from "../../core/ipc";
import { createProject } from "../../core/project";
import type { MediaRef, ProjectFile } from "../../core/types";
import { ABANDON_GRACE_MS, abandonsPlayback, MediaManager, ORPHAN_KEEP } from "./media";

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
  // Fire any grace timer a test left pending BEFORE the spies go: the
  // abandoned-job map is module state, and an entry left behind would make a
  // later test's abandon of the same id a silent no-op.
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
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

  it("abandons its playback jobs when the project was discarded: canceled after the grace window", async () => {
    // A discarded temporary project is deleted right after this dispose. Its
    // proxies are not canceled on the spot (the next editor may want them) but
    // once nobody has joined them in ABANDON_GRACE_MS. Waveforms go at once.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    m.dispose({ abandonPlayback: true });
    expect(cancel.mock.calls.map((c) => c[0]).sort()).toEqual([51, 52]);
    vi.advanceTimersByTime(ABANDON_GRACE_MS - 1);
    expect(cancel.mock.calls.map((c) => c[0]).sort()).toEqual([51, 52]);
    vi.advanceTimersByTime(1);
    expect(cancel.mock.calls.map((c) => c[0]).sort()).toEqual([41, 42, 51, 52]);
  });

  it("an untouched quick view reopened on the same file keeps its proxy: the next editor claims it", async () => {
    // The 0.9.1 regression: an untouched temporary project is discarded
    // without a question, and canceling its proxy at dispose restarted the
    // transcode the very next editor — showing the same file — was about to
    // join. Here the second manager joins job 41; job 42 (a file the second
    // project does not have) is still canceled when the window ends.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m) => ({ mode: "pending", jobId: m.path.includes("a.mov") ? 41 : 42, output: "o" }) as PlaybackPlan,
    );
    vi.spyOn(ipc, "ensureWaveform").mockResolvedValue({ state: "none" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const first = projectOf(media("a"), media("b"));
    const m1 = new MediaManager(() => first);
    m1.ensureAll(first);
    await settle();
    m1.dispose({ abandonPlayback: true });

    // A new project (new media ids) on the same file, partway into the window.
    vi.advanceTimersByTime(ABANDON_GRACE_MS / 2);
    const again: MediaRef = { ...media("a"), id: "a-again" };
    const second = projectOf(again);
    const m2 = new MediaManager(() => second);
    m2.ensureAll(second);
    await settle();
    expect(m2.status.get()["a-again"]).toEqual({ state: "preparing", ratio: null, jobId: 41 });

    vi.advanceTimersByTime(ABANDON_GRACE_MS);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([42]);
    m2.dispose();
  });

  it("an explicit abandonPlayback: false is the ordinary dispose", async () => {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "pending", jobId: 41, output: "o" });
    vi.spyOn(ipc, "ensureWaveform").mockResolvedValue({ state: "pending", jobId: 51, output: "w" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const p = projectOf(media("a"));
    const m = new MediaManager(() => p);
    m.ensureAll(p);
    await settle();
    m.dispose({ abandonPlayback: false });
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([51]);
  });

  it("after a discarding dispose, abandons a pending plan that answers late — but not a direct one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    let ra!: (v: PlaybackPlan) => void;
    let rb!: (v: PlaybackPlan) => void;
    vi.spyOn(ipc, "planPlayback").mockImplementation((m) => new Promise((r) => (m.id === "a" ? (ra = r) : (rb = r))));
    vi.spyOn(ipc, "ensureWaveform").mockResolvedValue({ state: "none" });
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(true);
    const p = projectOf(media("a"), media("b"));
    const m = new MediaManager(() => p);
    m.ensureAll(p);
    await settle();
    m.dispose({ abandonPlayback: true });
    expect(cancel).not.toHaveBeenCalled();
    ra({ mode: "pending", jobId: 77, output: "o" });
    rb({ mode: "direct", path: "D:\\b.mov" });
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ABANDON_GRACE_MS);
    // The pending one was started for this project and is registered nowhere:
    // this is the only chance to stop it. A direct play has no job at all.
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([77]);
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

/**
 * A job's terminal event can reach the manager BEFORE the answer that names
 * the job: Tauri events and invoke answers travel separate channels, so a short
 * remux, or a job the plan joined as it finished, reports first. Dropped, the
 * media sat on "Preparing" (or without a waveform) for the whole session.
 *
 * Fixtures: the done event's output path differs from the path the plan
 * answer predicted, so "ready" can only have come from the replayed event;
 * playback and waveform job ids never coincide; each test fires its event
 * strictly before resolving the answer.
 */
describe("MediaManager when a job's end arrives before the plan names it", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function done(id: number, path: string): JobDone {
    return { id, kind: "remux", output: { path } };
  }

  async function started(plan: Promise<PlaybackPlan>, ...extra: Promise<PlaybackPlan>[]) {
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    const spy = vi.spyOn(ipc, "planPlayback").mockReturnValueOnce(plan);
    for (const p of extra) spy.mockReturnValueOnce(p);
    const p = projectOf(media("a", false));
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();
    return { m, plan: spy };
  }

  it("reaches ready from a done that beat the pending answer", async () => {
    const answer = deferred<PlaybackPlan>();
    const { m } = await started(answer.promise);
    handlers.onDone!(done(41, "C:\\cache\\remux\\a-final.mp4"));
    answer.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\a-predicted.mp4" });
    await settle();
    expect(m.status.get()["a"]).toEqual({
      state: "ready",
      url: "C:\\cache\\remux\\a-final.mp4",
      sourcePath: "C:\\cache\\remux\\a-final.mp4",
    });
    m.dispose();
  });

  it("reaches failed from a failure that beat the pending answer", async () => {
    const answer = deferred<PlaybackPlan>();
    const { m, plan } = await started(answer.promise);
    handlers.onFailed!(failed(41, false));
    answer.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\a.mp4" });
    await settle();
    expect(m.status.get()["a"]).toEqual({ state: "failed", message: "moov atom not found" });
    expect(plan).toHaveBeenCalledTimes(1);
    m.dispose();
  });

  it("re-plans after a foreign cancel that beat the pending answer", async () => {
    const answer = deferred<PlaybackPlan>();
    const fresh = Promise.resolve<PlaybackPlan>({ mode: "ready", path: "C:\\cache\\remux\\a-again.mp4" });
    const { m, plan } = await started(answer.promise, fresh);
    handlers.onFailed!(failed(41, true));
    answer.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\a.mp4" });
    await settle();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(m.status.get()["a"]).toEqual({
      state: "ready",
      url: "C:\\cache\\remux\\a-again.mp4",
      sourcePath: "C:\\cache\\remux\\a-again.mp4",
    });
    m.dispose();
  });

  it("does not take another job's early end for its own", async () => {
    const answer = deferred<PlaybackPlan>();
    const { m } = await started(answer.promise);
    handlers.onDone!(done(77, "C:\\cache\\remux\\someone-else.mp4"));
    answer.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\a.mp4" });
    await settle();
    expect(m.status.get()["a"]).toEqual({ state: "preparing", ratio: null, jobId: 41 });
    m.dispose();
  });

  it("keeps only a bounded number of early events", async () => {
    // ORPHAN_KEEP unrelated ends after ours push it out: the ring must not
    // grow without limit on a long session's foreign traffic.
    const answer = deferred<PlaybackPlan>();
    const { m } = await started(answer.promise);
    handlers.onDone!(done(41, "C:\\cache\\remux\\a-final.mp4"));
    for (let id = 100; id < 100 + ORPHAN_KEEP; id++) {
      handlers.onDone!(done(id, `C:\\cache\\remux\\other-${id}.mp4`));
    }
    answer.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\a.mp4" });
    await settle();
    expect(m.status.get()["a"]).toEqual({ state: "preparing", ratio: null, jobId: 41 });
    m.dispose();
  });

  it("loads the waveform from a done that beat the waveform answer", async () => {
    // A real TPK1 body: 2 pairs at 50 pairs/s.
    const pk = new Uint8Array([0x54, 0x50, 0x4b, 0x31, 50, 0, 0, 0, 2, 0, 0, 0, 0xf6, 0x08, 0xfd, 0x03]);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(url);
      return Promise.resolve(new Response(pk));
    });
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    vi.spyOn(ipc, "planPlayback").mockResolvedValue({ mode: "direct", path: "D:\\a.mov" });
    const answer = deferred<WaveformResult>();
    vi.spyOn(ipc, "ensureWaveform").mockReturnValue(answer.promise);
    const p = projectOf(media("a"));
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();

    handlers.onDone!({ id: 52, kind: "waveform", output: { path: "C:\\cache\\peaks\\a-final.pk" } });
    answer.resolve({ state: "pending", jobId: 52, output: "C:\\cache\\peaks\\a-predicted.pk" });
    await settle();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetched).toEqual(["C:\\cache\\peaks\\a-final.pk"]);
    const wf = m.waveforms.get()["a"];
    expect(wf?.pairsPerSec).toBe(50);
    expect(Array.from(wf!.mins)).toEqual([-10, -3]);
    expect(Array.from(wf!.maxs)).toEqual([8, 3]);
    m.dispose();
  });

  it("replays one early end to BOTH entries that share the job", async () => {
    // The same file imported twice: two ids, one identity, so the backend
    // hands both plans the same job. Its end lands before either answer, and
    // the answers land one after the other. Taking the event out of the ring
    // on the first claim left the second entry on "Preparing".
    const first: MediaRef = { ...media("a", false), path: "D:\\shared\\clip.mov", size: 900, mtimeMs: 7 };
    const second: MediaRef = { ...first, id: "b" };
    const answerA = deferred<PlaybackPlan>();
    const answerB = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    vi.spyOn(ipc, "planPlayback").mockReturnValueOnce(answerA.promise).mockReturnValueOnce(answerB.promise);
    const p = projectOf(first, second);
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();

    handlers.onDone!(done(41, "C:\\cache\\remux\\clip-final.mp4"));
    answerA.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\clip.mp4" });
    await settle();
    answerB.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\clip.mp4" });
    await settle();

    const ready = { state: "ready", url: "C:\\cache\\remux\\clip-final.mp4", sourcePath: "C:\\cache\\remux\\clip-final.mp4" };
    expect(m.status.get()["a"]).toEqual(ready);
    expect(m.status.get()["b"]).toEqual(ready);
    m.dispose();
  });

  it("gives a shared job's end to the second entry when it lands between the answers", async () => {
    // The same file imported twice again, but this time the first answer is
    // already registered when the end arrives, so the end MATCHES a waiter.
    // Keeping only unmatched ends resolved the first entry and forgot the
    // event, and the second answer then waited on "Preparing" for good.
    const first: MediaRef = { ...media("a", false), path: "D:\\shared\\take.mov", size: 1200, mtimeMs: 9 };
    const second: MediaRef = { ...first, id: "b" };
    const answerA = deferred<PlaybackPlan>();
    const answerB = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    vi.spyOn(ipc, "planPlayback").mockReturnValueOnce(answerA.promise).mockReturnValueOnce(answerB.promise);
    const p = projectOf(first, second);
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();

    answerA.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\take.mp4" });
    await settle();
    expect(m.status.get()["a"]).toEqual({ state: "preparing", ratio: null, jobId: 41 });
    handlers.onDone!(done(41, "C:\\cache\\remux\\take-final.mp4"));
    answerB.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\take.mp4" });
    await settle();

    const ready = { state: "ready", url: "C:\\cache\\remux\\take-final.mp4", sourcePath: "C:\\cache\\remux\\take-final.mp4" };
    expect(m.status.get()["a"]).toEqual(ready);
    expect(m.status.get()["b"]).toEqual(ready);
    m.dispose();
  });

  it("spends one ring slot per job, however many answers claim it", async () => {
    // c's end arrives first, then a's; a's answer claims 41; then exactly
    // enough unrelated ends to fill the ring to ORPHAN_KEEP. If the claim put
    // 41 in a second time, the ring would overflow by one and evict c's end.
    const a = media("a", false);
    const c: MediaRef = { ...media("c", false), path: "E:\\other\\c.mkv", size: 77, mtimeMs: 13 };
    const answerA = deferred<PlaybackPlan>();
    const answerC = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    vi.spyOn(ipc, "planPlayback").mockReturnValueOnce(answerA.promise).mockReturnValueOnce(answerC.promise);
    const p = projectOf(a, c);
    const m = new MediaManager(() => p);
    await m.init();
    m.ensureAll(p);
    await settle();

    handlers.onDone!(done(60, "C:\\cache\\remux\\c-final.mp4"));
    handlers.onDone!(done(41, "C:\\cache\\remux\\a-final.mp4"));
    answerA.resolve({ mode: "pending", jobId: 41, output: "C:\\cache\\remux\\a.mp4" });
    await settle();
    for (let id = 200; id < 200 + ORPHAN_KEEP - 2; id++) {
      handlers.onDone!(done(id, `C:\\cache\\remux\\other-${id}.mp4`));
    }
    answerC.resolve({ mode: "pending", jobId: 60, output: "C:\\cache\\remux\\c.mp4" });
    await settle();

    expect(m.status.get()["a"]).toEqual({
      state: "ready",
      url: "C:\\cache\\remux\\a-final.mp4",
      sourcePath: "C:\\cache\\remux\\a-final.mp4",
    });
    expect(m.status.get()["c"]).toEqual({
      state: "ready",
      url: "C:\\cache\\remux\\c-final.mp4",
      sourcePath: "C:\\cache\\remux\\c-final.mp4",
    });
    m.dispose();
  });
});

describe("abandonsPlayback", () => {
  it("abandons only a discarded project that is not going back to the viewer", () => {
    expect(abandonsPlayback(true, false)).toBe(true);
    // Viewer → Edit → Back: the viewer re-shows the file on the same job and
    // cannot claim it from the grace timer.
    expect(abandonsPlayback(true, true)).toBe(false);
    expect(abandonsPlayback(false, false)).toBe(false);
    expect(abandonsPlayback(false, true)).toBe(false);
  });
});
