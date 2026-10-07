import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEventHandlers, PlaybackPlan, WaveformResult } from "../../core/ipc";
import { ipc } from "../../core/ipc";
import type { MediaInfo, MediaRef, ProjectFile } from "../../core/types";
import { createProject, findMedia, updateMedia } from "../../core/project";
import { ProjectSession } from "../../core/session";
import { recentErrors } from "../../ui/errors";
import { MediaManager, type WaveformData } from "./media";
import { applyRelink } from "./relink";

// `onJobEvents` is a standalone export a spy on `ipc` cannot reach, so it is
// replaced here and hands its handlers to the test (the pattern
// media-cancel.test.ts uses). The `ipc` object itself stays the real one, so
// `vi.spyOn(ipc, …)` still lands where media.ts calls it. Only the repair
// tests call `init()`; for every other block this changes nothing.
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

/**
 * WHAT THESE TWO BLOCKS ARE ABOUT: a `plan_playback` answer that arrives for a
 * media entry which is no longer the entry that asked for it.
 *
 * `ensure` awaits the backend. In between, the media it was called for can be
 * RELINKED (the file behind the id changed) or REMOVED (the id left the project
 * altogether). The answer that then lands describes a file nothing references,
 * and until the generation counter it was published anyway — over the top of
 * whatever the fresh state had become.
 *
 * Every fixture below therefore differs on every axis the code could confuse:
 * two media ids, two file paths, two job ids, two plan MODES (a pending job vs
 * a direct play), and a resolve order that is the reverse of the call order. A
 * fixture where the old and the new plan looked alike would pass whether or not
 * the stale one won.
 */

const OLD_FILE: MediaRef = {
  id: "m-relink",
  path: "D:\\shoot\\take-1.mov",
  size: 40_000_000,
  mtimeMs: 1_700_000_000_000,
  kind: "video",
  duration: 42,
  hasAudio: false,
  width: 1920,
  height: 1080,
};

/** The SAME id after a relink: a different file, different identity triple. */
const NEW_FILE: MediaRef = {
  ...OLD_FILE,
  path: "D:\\rescued\\take-2.mov",
  size: 51_000_000,
  mtimeMs: 1_800_000_000_000,
};

/** A second entry that is never touched, so every assertion below proves the
 *  named media was withdrawn rather than the map being cleared. */
const BYSTANDER: MediaRef = {
  id: "m-keep",
  path: "D:\\shoot\\b-roll.mp4",
  size: 7_000_000,
  mtimeMs: 1_650_000_000_000,
  kind: "video",
  duration: 9,
  hasAudio: false,
  width: 1280,
  height: 720,
};

function projectWith(...media: MediaRef[]): ProjectFile {
  return { ...createProject("Relink"), media };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask run. A macrotask hop rather than a
 *  counted number of `Promise.resolve()`s, which would rot the moment another
 *  `then` joined the chain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A thumbnail lane that never answers, for the tests that are about the
 *  playback lane. `ensure` fires it for every visual media. */
function silentThumbnails(): void {
  vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {}));
}

afterEach(() => {
  vi.restoreAllMocks();
  handlers = {};
});

describe("a backend answer that outlives the media it was asked for", () => {
  it("does not publish the old file's job while the relink is still preparing", async () => {
    const first = deferred<PlaybackPlan>();
    const second = deferred<PlaybackPlan>();
    const plans = [first, second];
    let call = 0;
    vi.spyOn(ipc, "planPlayback").mockImplementation(() => plans[call++]!.promise);
    silentThumbnails();

    let project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    await settle();
    expect(media.status.get()["m-relink"]).toEqual({ state: "checking" });

    // The relink, exactly as relink.ts performs it: the project is committed
    // first, then the manager is told.
    project = projectWith(NEW_FILE);
    media.retrack("m-relink");

    // Now the OLD plan answers. Its job belongs to a file this media no longer
    // points at, so nothing about it may reach the UI.
    first.resolve({ mode: "pending", jobId: 11, output: "C:\\cache\\proxy\\take-1.mp4" });
    await settle();
    expect(media.status.get()["m-relink"]).toEqual({ state: "checking" });

    second.resolve({ mode: "direct", path: NEW_FILE.path });
    await settle();
    expect(media.status.get()["m-relink"]).toEqual({
      state: "ready",
      url: NEW_FILE.path,
      sourcePath: NEW_FILE.path,
    });
  });

  it("cannot drag a relinked media back to Preparing after it is ready", async () => {
    // The harmful ordering, and the reason the counter is not merely tidy: the
    // fresh plan resolves FIRST and the stale one lands on top of it. The job
    // it registers is one the old file started, so nothing will ever finish it
    // for this media — the clip sits on "Preparing" for the rest of the session.
    const first = deferred<PlaybackPlan>();
    const second = deferred<PlaybackPlan>();
    const plans = [first, second];
    let call = 0;
    vi.spyOn(ipc, "planPlayback").mockImplementation(() => plans[call++]!.promise);
    silentThumbnails();

    let project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    project = projectWith(NEW_FILE);
    media.retrack("m-relink");

    second.resolve({ mode: "direct", path: NEW_FILE.path });
    await settle();
    const ready = { state: "ready", url: NEW_FILE.path, sourcePath: NEW_FILE.path };
    expect(media.status.get()["m-relink"]).toEqual(ready);

    first.resolve({ mode: "pending", jobId: 11, output: "C:\\cache\\proxy\\take-1.mp4" });
    await settle();
    expect(media.status.get()["m-relink"]).toEqual(ready);
  });

  it("does not report the old file's failure against the relinked media", async () => {
    const first = deferred<PlaybackPlan>();
    const second = deferred<PlaybackPlan>();
    const plans = [first, second];
    let call = 0;
    vi.spyOn(ipc, "planPlayback").mockImplementation(() => plans[call++]!.promise);
    silentThumbnails();

    let project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    project = projectWith(NEW_FILE);
    media.retrack("m-relink");

    second.resolve({ mode: "direct", path: NEW_FILE.path });
    await settle();
    // The old file is gone from the disk — that is WHY it was relinked — so its
    // plan is as likely to reject as to answer.
    first.reject(new Error("the system cannot find the file specified"));
    await settle();

    expect(media.status.get()["m-relink"]).toEqual({
      state: "ready",
      url: NEW_FILE.path,
      sourcePath: NEW_FILE.path,
    });
  });

  it("keeps a thumbnail of the file the media points at now", async () => {
    const thumb = deferred<string>();
    vi.spyOn(ipc, "getThumbnail")
      .mockReturnValueOnce(thumb.promise)
      .mockReturnValue(new Promise<string>(() => {}));
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise<PlaybackPlan>(() => {}));

    let project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    project = projectWith(NEW_FILE);
    media.retrack("m-relink");

    // A frame from the file that was just replaced is not a stale detail — it
    // is the bin row telling the user the relink did not take.
    thumb.resolve("C:\\cache\\thumbs\\take-1.jpg");
    await settle();
    expect(media.thumbs.get()).toEqual({});
  });

  it("publishes normally when nothing overtook the plan", async () => {
    // The control. A guard that fired unconditionally would satisfy every test
    // above and leave the manager unable to prepare anything at all.
    const plan = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(plan.promise);
    silentThumbnails();

    const project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    plan.resolve({ mode: "pending", jobId: 11, output: "C:\\cache\\proxy\\take-1.mp4" });
    await settle();

    expect(media.status.get()["m-relink"]).toEqual({ state: "preparing", ratio: null, jobId: 11 });
  });
});

/**
 * `untrack` — the half of `retrack` that was missing.
 *
 * Removing media from the bin dropped it from the project but not from here, so
 * its id stayed tracked and published for the rest of the session: a status for
 * something nothing can render, a thumbnail path, and — the part that is
 * actually large — the waveform's peak arrays, all pinned behind an id no clip
 * references.
 */
describe("untrack", () => {
  const WAVE_GONE: WaveformData = {
    pairsPerSec: 200,
    mins: new Int8Array([-9, -4]),
    maxs: new Int8Array([7, 3]),
  };
  const WAVE_KEEP: WaveformData = {
    pairsPerSec: 100,
    mins: new Int8Array([-2]),
    maxs: new Int8Array([5]),
  };

  it("forgets the named media in every map, and only the named media", async () => {
    vi.spyOn(ipc, "planPlayback").mockImplementation(async (m) => ({
      mode: "direct" as const,
      path: m.path,
    }));
    vi.spyOn(ipc, "getThumbnail").mockImplementation(async (key) => `C:\\cache\\thumbs\\${key.size}.jpg`);

    const project = projectWith(OLD_FILE, BYSTANDER);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();
    // Peaks arrive on their own lane; seed both the way a finished job would.
    media.waveforms.update(() => ({ "m-relink": WAVE_GONE, "m-keep": WAVE_KEEP }));

    expect(Object.keys(media.status.get()).sort()).toEqual(["m-keep", "m-relink"]);

    media.untrack("m-relink");
    await settle();

    expect(Object.keys(media.status.get())).toEqual(["m-keep"]);
    expect(Object.keys(media.thumbs.get())).toEqual(["m-keep"]);
    expect(Object.keys(media.waveforms.get())).toEqual(["m-keep"]);
    // The survivor keeps its OWN values, not a shifted neighbour's.
    expect(media.status.get()["m-keep"]).toEqual({
      state: "ready",
      url: BYSTANDER.path,
      sourcePath: BYSTANDER.path,
    });
    expect(media.thumbs.get()["m-keep"]).toBe(`C:\\cache\\thumbs\\${BYSTANDER.size}.jpg`);
    expect(media.waveforms.get()["m-keep"]).toBe(WAVE_KEEP);
  });

  it("leaves an ensure that was still in flight with nothing to publish", async () => {
    const plan = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(plan.promise);
    silentThumbnails();

    const project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    await settle();
    expect(media.status.get()["m-relink"]).toEqual({ state: "checking" });

    media.untrack("m-relink");
    plan.resolve({ mode: "pending", jobId: 42, output: "C:\\cache\\proxy\\take-1.mp4" });
    await settle();

    // Not "preparing", not "failed" — absent. A media that left the project has
    // no state to be in.
    expect("m-relink" in media.status.get()).toBe(false);
  });

  it("leaves nothing behind when the in-flight plan fails instead", async () => {
    const plan = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(plan.promise);
    silentThumbnails();

    const project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    media.untrack("m-relink");
    plan.reject(new Error("the system cannot find the file specified"));
    await settle();

    expect(media.status.get()).toEqual({});
  });

  it("notifies nobody about media it was never tracking", async () => {
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise<PlaybackPlan>(() => {}));
    silentThumbnails();

    const project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    const before = media.status.get();
    let notifications = 0;
    media.status.subscribe(() => notifications++);

    media.untrack("m-never-imported");
    await settle();

    // The same object, so `Store.set` early-outs and no subscriber re-renders.
    // Removing the last import of a project would otherwise repaint everything
    // three times over for nothing.
    expect(media.status.get()).toBe(before);
    expect(notifications).toBe(0);
  });
});

/**
 * `retrack(id, fileChanged)` — a relink onto a different file.
 *
 * The re-ensure a retrack runs only ever ADDS display data. So a relink onto a
 * file with no audio never asked for a waveform and the OLD file's peaks went on
 * being drawn on every clip for the session; a relinked file whose thumbnail
 * failed kept the old picture. The fixture's old file has audio and the new one
 * has none, and the new file's thumbnail never answers, so nothing the
 * re-ensure does can stand in for the drop.
 */
describe("retrack after a relink", () => {
  const OLD_WAVE: WaveformData = { pairsPerSec: 200, mins: new Int8Array([-9, -4]), maxs: new Int8Array([7, 3]) };
  const KEEP_WAVE: WaveformData = { pairsPerSec: 100, mins: new Int8Array([-2]), maxs: new Int8Array([5]) };
  const OLD_WITH_AUDIO: MediaRef = { ...OLD_FILE, hasAudio: true };
  const NEW_SILENT: MediaRef = { ...NEW_FILE, hasAudio: false };

  /** Both media ready, both with a waveform and a thumbnail of their own. */
  async function seeded(): Promise<{ media: MediaManager; relinkTo: (m: MediaRef) => void }> {
    vi.spyOn(ipc, "planPlayback").mockImplementation(async (m) => ({ mode: "direct" as const, path: m.path }));
    vi.spyOn(ipc, "ensureWaveform").mockReturnValue(new Promise(() => {}));
    // The first two thumbnails answer (the old file's and the bystander's);
    // the relinked file's never does.
    vi.spyOn(ipc, "getThumbnail")
      .mockResolvedValueOnce("C:\\cache\\thumbs\\take-1.jpg")
      .mockResolvedValueOnce("C:\\cache\\thumbs\\b-roll.jpg")
      .mockReturnValue(new Promise<string>(() => {}));
    let project = projectWith(OLD_WITH_AUDIO, BYSTANDER);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();
    media.waveforms.update(() => ({ "m-relink": OLD_WAVE, "m-keep": KEEP_WAVE }));
    return {
      media,
      relinkTo: (m) => {
        project = projectWith(m, BYSTANDER);
      },
    };
  }

  it("drops the old file's waveform and thumbnail when the file changed", async () => {
    const { media, relinkTo } = await seeded();
    expect(media.thumbs.get()["m-relink"]).toBe("C:\\cache\\thumbs\\take-1.jpg");

    relinkTo(NEW_SILENT);
    media.retrack("m-relink", true);
    await settle();

    expect("m-relink" in media.waveforms.get()).toBe(false);
    expect("m-relink" in media.thumbs.get()).toBe(false);
    // The bystander keeps its own, and the relinked media is re-planned.
    expect(media.waveforms.get()["m-keep"]).toBe(KEEP_WAVE);
    expect(media.thumbs.get()["m-keep"]).toBe("C:\\cache\\thumbs\\b-roll.jpg");
    expect(media.status.get()["m-relink"]).toEqual({
      state: "ready",
      url: NEW_SILENT.path,
      sourcePath: NEW_SILENT.path,
    });
  });

  it("keeps them by default — the same file asked about again must not flash", async () => {
    const { media } = await seeded();
    const waves = media.waveforms.get();
    const thumbs = media.thumbs.get();

    media.retrack("m-relink");
    await settle();

    expect(media.waveforms.get()).toBe(waves);
    expect(media.thumbs.get()).toBe(thumbs);
  });
});

/**
 * `markFailed` — the preview's own <video> saying it cannot play what the
 * manager published as ready. Every fixture keeps a second, healthy media so a
 * stamp that landed on the wrong entry (or cleared the map) shows.
 */
describe("markFailed", () => {
  function directPlans(): void {
    vi.spyOn(ipc, "planPlayback").mockImplementation(async (m) => ({ mode: "direct" as const, path: m.path }));
    silentThumbnails();
  }

  it("stamps a ready media failed, and only that media", async () => {
    directPlans();
    const project = projectWith(OLD_FILE, BYSTANDER);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();

    media.markFailed("m-relink", "This file couldn't be played in the preview");

    expect(media.status.get()["m-relink"]).toEqual({
      state: "failed",
      message: "This file couldn't be played in the preview",
    });
    expect(media.status.get()["m-keep"]).toEqual({ state: "ready", url: BYSTANDER.path, sourcePath: BYSTANDER.path });
  });

  it("sticks: a plan already in flight cannot paint 'ready' back over it", async () => {
    // The shape of the bug this API exists for: the backend answers Direct for
    // a path that is not there, and that answer lands after the failure.
    const plan = deferred<PlaybackPlan>();
    vi.spyOn(ipc, "planPlayback").mockReturnValue(plan.promise);
    silentThumbnails();
    const project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    void media.ensure(OLD_FILE);
    await settle();

    media.markFailed("m-relink", "File not found");
    plan.resolve({ mode: "direct", path: OLD_FILE.path });
    await settle();

    expect(media.status.get()["m-relink"]).toEqual({ state: "failed", message: "File not found" });
  });

  it("is cleared by a retrack, which plans the media afresh", async () => {
    directPlans();
    let project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();
    media.markFailed("m-relink", "File not found");

    project = projectWith(NEW_FILE);
    media.retrack("m-relink", true);
    await settle();

    expect(media.status.get()["m-relink"]).toEqual({ state: "ready", url: NEW_FILE.path, sourcePath: NEW_FILE.path });
  });

  it("is cleared when the same file comes up ready under another id (a re-import, Replace media)", async () => {
    // Nothing else could clear it mid-session: retrack is only reached from the
    // relink dialog, which opens at load. A transient element error (a file
    // still being copied) failed the media until the project was reopened.
    directPlans();
    let project = projectWith(OLD_FILE, BYSTANDER);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();
    media.markFailed("m-relink", "This file couldn't be played");
    // A failed entry for a DIFFERENT file must stay failed.
    media.markFailed("m-keep", "This file couldn't be played");

    const reimported: MediaRef = { ...OLD_FILE, id: "m-reimported" };
    project = projectWith(OLD_FILE, BYSTANDER, reimported);
    media.ensureAll(project);
    await settle();

    const ready = { state: "ready", url: OLD_FILE.path, sourcePath: OLD_FILE.path };
    expect(media.status.get()["m-reimported"]).toEqual(ready);
    expect(media.status.get()["m-relink"]).toEqual(ready);
    expect(media.status.get()["m-keep"]).toEqual({ state: "failed", message: "This file couldn't be played" });
  });

  it("heals a sibling once, not in a loop, when the file really cannot be played", async () => {
    // Two entries for one file the preview's element cannot decode, both on
    // stage: the element fails each one shortly after it goes ready. Each
    // ready plan used to retrack the other (already failed by then), whose
    // ready plan retracked the first again — a plan, a thumbnail and a bin
    // re-render per round, for ever. The plan and the element answer on
    // different clocks (5 ms, 1 ms) so neither order hides the other.
    let plans = 0;
    vi.spyOn(ipc, "planPlayback").mockImplementation(async (m) => {
      plans++;
      await new Promise((r) => setTimeout(r, 5));
      return { mode: "direct" as const, path: m.path };
    });
    silentThumbnails();
    const sameFile: MediaRef = { ...OLD_FILE, id: "m-second-layer" };
    let project = projectWith(OLD_FILE, BYSTANDER);
    const media = new MediaManager(() => project);
    // The element: any entry for the undecodable path that goes ready fails.
    let was: Record<string, string> = {};
    media.status.subscribe((s) => {
      for (const [id, st] of Object.entries(s)) {
        if (st.state === "ready" && was[id] !== "ready" && project.media.find((m) => m.id === id)?.path === OLD_FILE.path) {
          setTimeout(() => media.markFailed(id, "This file couldn't be played"), 1);
        }
      }
      was = Object.fromEntries(Object.entries(s).map(([id, st]) => [id, st.state]));
    });
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    media.ensureAll(project);
    await wait(40);
    expect(media.status.get()["m-relink"]?.state).toBe("failed");
    expect(plans).toBe(2); // m-relink + the bystander

    // The second layer's entry comes up: it heals the first once.
    project = projectWith(OLD_FILE, BYSTANDER, sameFile);
    media.ensureAll(project);
    await wait(100);
    expect(plans).toBe(4); // + m-second-layer + one heal of m-relink
    expect(media.status.get()["m-relink"]?.state).toBe("failed");
    expect(media.status.get()["m-second-layer"]?.state).toBe("failed");
    await wait(100);
    expect(plans).toBe(4); // and then silence

    // A later re-import is a fresh try for both, once each, and stops again:
    // the mark is spent by one heal, it does not switch healing off.
    const third: MediaRef = { ...OLD_FILE, id: "m-reimported" };
    project = projectWith(OLD_FILE, BYSTANDER, sameFile, third);
    media.ensureAll(project);
    await wait(100);
    expect(plans).toBe(7); // + m-reimported + one heal each of the other two
    await wait(100);
    expect(plans).toBe(7);
    expect(media.status.get()["m-keep"]?.state).toBe("ready");
    media.dispose();
  });

  it("leaves media it does not track alone: never ensured, or removed since", async () => {
    directPlans();
    const project = projectWith(OLD_FILE, BYSTANDER);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();
    media.untrack("m-relink");
    await settle();
    const before = media.status.get();
    let notifications = 0;
    media.status.subscribe(() => notifications++);

    media.markFailed("m-relink", "late error from a removed clip");
    media.markFailed("m-never-imported", "error for an id nobody ensured");
    await settle();

    // Not "failed" — absent, and nobody re-rendered for it.
    expect(media.status.get()).toBe(before);
    expect(notifications).toBe(0);
  });

  it("does nothing once the manager is disposed", async () => {
    directPlans();
    const project = projectWith(OLD_FILE);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();
    const before = media.status.get();
    media.dispose();

    media.markFailed("m-relink", "error during teardown");

    expect(media.status.get()).toBe(before);
  });
});

/**
 * `playbackFailed` — the preview's <video> refusing a file the backend called
 * playable, and the ONE repair attempt that earns.
 *
 * The real case: an NVIDIA Instant Replay recording whose first minute is
 * scrambled. The WebView's decoder gives up on the whole file at the first bad
 * frame (MediaError 3); a copy ffmpeg decoded plays. Fixture values differ on
 * every axis the code could confuse: the original and the repair copy live on
 * different drives under different names, the repair job id (73) matches
 * nothing else, the element's message and the backend's detail are different
 * strings, and the `repair` flag of every plan call is asserted in order.
 */
describe("playbackFailed — one repair attempt for a file the WebView refuses", () => {
  const REPLAY: MediaRef = {
    id: "m-replay",
    path: "D:\\captures\\Replay 2026-10-02.mp4",
    size: 88_000_000,
    mtimeMs: 1_759_000_000_000,
    kind: "video",
    duration: 95,
    hasAudio: false,
    width: 1920,
    height: 1080,
  };
  const FLAGGED: MediaRef = { ...REPLAY, dropInbandHeaders: true };
  /** The same id relinked onto a healthy file elsewhere. */
  const RELINKED: MediaRef = { ...REPLAY, path: "E:\\rescued\\replay.mp4", size: 61_000_000, duration: 94 };
  const COPY = "C:\\cache\\repair\\5f3a91.mp4";
  const PROXY = "C:\\cache\\proxy\\0c77e2.mp4";
  const ELEMENT = "This file couldn't be played";
  const READY_ORIGINAL = { state: "ready", url: REPLAY.path, sourcePath: REPLAY.path };
  const READY_COPY = { state: "ready", url: COPY, sourcePath: COPY };

  /**
   * A manager whose `media` has been ensured. The backend answers an ordinary
   * plan "direct" on the file itself, and a repair plan with `repairAnswer`.
   * `stamped` records every `onDropHeaders` call; the project is NOT
   * stamped by it, so a second call would show.
   */
  async function setup(repairAnswer: () => Promise<PlaybackPlan>, ...media: MediaRef[]) {
    if (media.length === 0) media = [REPLAY];
    silentThumbnails();
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockImplementation((m, _hints, _proxy, repair) =>
        repair ? repairAnswer() : Promise.resolve({ mode: "direct" as const, path: m.path }),
      );
    let project = projectWith(...media);
    const stamped: string[] = [];
    const manager = new MediaManager(() => project, { onDropHeaders: (id) => stamped.push(id) });
    await manager.init();
    for (const m of media) void manager.ensure(m);
    await settle();
    return {
      plan,
      manager,
      stamped,
      /** The `repair` argument of every plan call so far, in order. */
      flags: () => plan.mock.calls.map((c) => c[3]),
      status: (id = REPLAY.id) => manager.status.get()[id],
      relinkTo: (m: MediaRef) => {
        project = projectWith(m);
      },
      /** Make the project hold exactly `m` (an import adds to the bin), and
       *  hand it back for `ensureAll`. */
      use: (...m: MediaRef[]) => (project = projectWith(...m)),
    };
  }

  it.each([3, 4])("code %i: plans the repair copy, shows Preparing, then plays the copy", async (code) => {
    const answer = deferred<PlaybackPlan>();
    const { manager, flags, status } = await setup(() => answer.promise);
    expect(status()).toEqual(READY_ORIGINAL);

    manager.playbackFailed(REPLAY.id, REPLAY.path, code, ELEMENT);
    // Out of "ready" at once: the scheduler would reload the dead file while
    // the plan is asked for.
    expect(status()).toEqual({ state: "preparing", ratio: null, jobId: null });
    expect(flags()).toEqual([false, true]);

    answer.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: false } });
    await settle();
    expect(status()).toEqual(READY_COPY);
  });

  it("code 2 (network) fails the file as before, and plans no repair", async () => {
    const { manager, flags, status } = await setup(() => Promise.reject(new Error("unexpected repair plan")));
    manager.playbackFailed(REPLAY.id, REPLAY.path, 2, ELEMENT);
    await settle();
    expect(flags()).toEqual([false]);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("a failure on the repair copy is final: no second plan", async () => {
    const { manager, flags, status } = await setup(() =>
      Promise.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: true } }),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()).toEqual(READY_COPY);

    manager.playbackFailed(REPLAY.id, COPY, 3, ELEMENT);
    await settle();
    expect(flags()).toEqual([false, true]);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("a failure on a copy the file was planned straight onto is final, with no attempt spent", async () => {
    // The flagged media's very first plan is the repair: nothing has used the
    // id's one attempt, so only knowing the url IS a copy stops another plan.
    const { manager, flags, status } = await setup(
      () => Promise.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: true } }),
      FLAGGED,
    );
    expect(status()).toEqual(READY_COPY);

    manager.playbackFailed(REPLAY.id, COPY, 3, ELEMENT);
    await settle();
    expect(flags()).toEqual([true]);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("one attempt per session: an answer that is not a repair copy earns no second", async () => {
    // The backend may answer the repair with an ordinary proxy (no note), so
    // the url is not a known copy — only the spent attempt stops a third plan.
    const { manager, flags, status } = await setup(() => Promise.resolve({ mode: "ready", path: PROXY }));
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()).toEqual({ state: "ready", url: PROXY, sourcePath: PROXY });

    manager.playbackFailed(REPLAY.id, PROXY, 3, ELEMENT);
    await settle();
    expect(flags()).toEqual([false, true]);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("a repair answering pending waits on its job, then plays the copy and tells the project once", async () => {
    const { manager, stamped, status } = await setup(() =>
      Promise.resolve({ mode: "pending", jobId: 73, output: COPY, repair: { dropsHeaders: true } }),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()).toEqual({ state: "preparing", ratio: null, jobId: 73 });
    // Not before the copy exists: the job could still fail.
    expect(stamped).toEqual([]);

    handlers.onDone!({ id: 73, kind: "proxy", output: { path: COPY } });
    expect(status()).toEqual(READY_COPY);
    expect(stamped).toEqual([REPLAY.id]);
  });

  it("a ready copy decoded without the in-band headers tells the project", async () => {
    const { manager, stamped } = await setup(() =>
      Promise.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: true } }),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 4, ELEMENT);
    await settle();
    expect(stamped).toEqual([REPLAY.id]);
  });

  it("a copy that kept the in-band headers tells the project nothing", async () => {
    const { manager, stamped, status } = await setup(() =>
      Promise.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: false } }),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()).toEqual(READY_COPY); // the repair did run
    expect(stamped).toEqual([]);
  });

  it("a flagged media plans its repair copy from the start, and the project is not told again", async () => {
    const { flags, stamped, status } = await setup(
      () => Promise.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: true } }),
      FLAGGED,
    );
    expect(flags()).toEqual([true]);
    expect(status()).toEqual(READY_COPY);
    expect(stamped).toEqual([]);
  });

  it("drops a repair answer that a relink overtook", async () => {
    const stale = deferred<PlaybackPlan>();
    const { manager, flags, stamped, status, relinkTo } = await setup(() => stale.promise);
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);

    // The relink, as relink.ts performs it: commit, then retrack.
    relinkTo(RELINKED);
    manager.retrack(REPLAY.id, true);
    await settle();
    expect(status()).toEqual({ state: "ready", url: RELINKED.path, sourcePath: RELINKED.path });

    // The old file's repair copy finishes afterwards: it describes a file the
    // media no longer points at.
    stale.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: true } });
    await settle();
    expect(flags()).toEqual([false, true, false]);
    expect(status()).toEqual({ state: "ready", url: RELINKED.path, sourcePath: RELINKED.path });
    expect(stamped).toEqual([]);
  });

  it("a relinked file gets an attempt of its own", async () => {
    const { manager, plan, flags, status, relinkTo } = await setup(() =>
      Promise.reject(new Error("Not a video file")),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()?.state).toBe("failed");

    relinkTo(RELINKED);
    manager.retrack(REPLAY.id, true);
    await settle();
    manager.playbackFailed(REPLAY.id, RELINKED.path, 3, ELEMENT);
    await settle();
    expect(flags()).toEqual([false, true, false, true]);
    expect(plan.mock.calls[3]![0].path).toBe(RELINKED.path);
  });

  it("a repair plan the backend refuses is reported in the element's words, detail after", async () => {
    const { manager, status } = await setup(() => Promise.reject(new Error("Not a video file")));
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()).toEqual({ state: "failed", message: `${ELEMENT}: Not a video file` });
  });

  it("a repair job that fails is reported the same way", async () => {
    const { manager, status } = await setup(() =>
      Promise.resolve({ mode: "pending", jobId: 73, output: COPY, repair: { dropsHeaders: true } }),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    handlers.onFailed!({ id: 73, kind: "proxy", canceled: false, message: "ffmpeg exited with code 1", logTail: [] });
    expect(status()).toEqual({ state: "failed", message: `${ELEMENT}: ffmpeg exited with code 1` });
  });

  /*
   * A failed repair is still the element's failure, so a re-import of the
   * file (or Replace media with it) heals the entry, as it heals one
   * `markFailed` stamped. Code 4 is what Chromium reports for ANY error before
   * metadata — a file missing for a moment, one still being copied — so this
   * is the path that transient case takes, and the repair plan of a file that
   * is not there is refused. Left unhealed, the entry and its audio-track
   * clips stayed Failed for the session.
   */
  const REIMPORTED: MediaRef = { ...REPLAY, id: "m-replay-reimported" };

  it("an entry whose repair plan was refused is healed by a re-import of the file", async () => {
    const { manager, flags, status, use } = await setup(() => Promise.reject(new Error("Not a video file")));
    manager.playbackFailed(REPLAY.id, REPLAY.path, 4, ELEMENT);
    await settle();
    expect(status()).toEqual({ state: "failed", message: `${ELEMENT}: Not a video file` });

    manager.ensureAll(use(REPLAY, REIMPORTED));
    await settle();
    expect(status(REIMPORTED.id)).toEqual(READY_ORIGINAL);
    expect(status()).toEqual(READY_ORIGINAL);
    // The re-import's own plan, then the heal's re-plan of the old entry.
    expect(flags()).toEqual([false, true, false, false]);
  });

  it("an entry whose repair job failed is healed by a re-import of the file", async () => {
    const { manager, flags, status, use } = await setup(() =>
      Promise.resolve({ mode: "pending", jobId: 73, output: COPY, repair: { dropsHeaders: true } }),
    );
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    handlers.onFailed!({ id: 73, kind: "proxy", canceled: false, message: "ffmpeg exited with code 1", logTail: [] });
    expect(status()).toEqual({ state: "failed", message: `${ELEMENT}: ffmpeg exited with code 1` });

    manager.ensureAll(use(REPLAY, REIMPORTED));
    await settle();
    expect(status()).toEqual(READY_ORIGINAL);
    expect(flags()).toEqual([false, true, false, false]);
  });

  it("an ordinary plan failure is not the element's, so a re-import does not re-plan it", async () => {
    // No repair is ever attempted here: the file's own plan is refused. Only a
    // failure the element (or this id's repair) reported is healed by a
    // sibling coming up ready; widening that to every failure would re-plan a
    // file the backend already refused, once per re-import.
    silentThumbnails();
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockImplementation((m) =>
        m.id === REPLAY.id
          ? Promise.reject(new Error("Can't read the file"))
          : Promise.resolve({ mode: "direct" as const, path: m.path }),
      );
    let project = projectWith(REPLAY);
    const manager = new MediaManager(() => project);
    await manager.init();
    void manager.ensure(REPLAY);
    await settle();
    expect(manager.status.get()[REPLAY.id]).toEqual({ state: "failed", message: "Can't read the file" });

    project = projectWith(REPLAY, REIMPORTED);
    manager.ensureAll(project);
    await settle();
    expect(manager.status.get()[REIMPORTED.id]).toEqual(READY_ORIGINAL);
    expect(manager.status.get()[REPLAY.id]).toEqual({ state: "failed", message: "Can't read the file" });
    // The old entry's own plan, then the re-import's: no heal re-plan.
    expect(plan.mock.calls.map((c) => c[0].id)).toEqual([REPLAY.id, REIMPORTED.id]);
  });

  it("a file whose repair keeps failing is healed once per re-import, not in a loop", async () => {
    // `markFailed`'s loop test, on the repair path: the element refuses every
    // entry that goes ready on the file (code 4) and every repair of it is
    // refused too, so each heal spends one more repair attempt (the retrack
    // gives the healed entry its attempt back). The plan and the element
    // answer on different clocks (5 ms, 1 ms) so neither order hides the other.
    let plans = 0;
    vi.spyOn(ipc, "planPlayback").mockImplementation(async (m, _hints, _proxy, repair) => {
      plans++;
      await new Promise((r) => setTimeout(r, 5));
      if (repair) throw new Error("Not a video file");
      return { mode: "direct" as const, path: m.path };
    });
    silentThumbnails();
    let project = projectWith(REPLAY);
    const manager = new MediaManager(() => project);
    let was: Record<string, string> = {};
    manager.status.subscribe((s) => {
      for (const [id, st] of Object.entries(s)) {
        if (st.state === "ready" && was[id] !== "ready" && st.url === REPLAY.path) {
          setTimeout(() => manager.playbackFailed(id, REPLAY.path, 4, ELEMENT), 1);
        }
      }
      was = Object.fromEntries(Object.entries(s).map(([id, st]) => [id, st.state]));
    });
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    manager.ensureAll(project);
    await wait(40);
    expect(plans).toBe(2); // the plan, the refused repair
    expect(manager.status.get()[REPLAY.id]?.state).toBe("failed");

    project = projectWith(REPLAY, REIMPORTED);
    manager.ensureAll(project);
    await wait(100);
    // The re-import's plan and repair, the heal's re-plan and repair.
    expect(plans).toBe(6);
    expect(manager.status.get()[REPLAY.id]?.state).toBe("failed");
    expect(manager.status.get()[REIMPORTED.id]?.state).toBe("failed");
    await wait(100);
    expect(plans).toBe(6); // and then silence
    manager.dispose();
  });

  /*
   * The repair is planned under the generation it found. The thumbnail and the
   * waveform the ensure asked for describe this very file, and a cold
   * thumbnail (ffmpeg on the original) takes seconds where the element refuses
   * the file within a fraction of one — dropping them left the repaired file
   * with no bin picture for the session. A relink during the repair still
   * drops the repair's answer: see "drops a repair answer that a relink
   * overtook", which retrack's own bump keeps green.
   */
  it("a thumbnail that answers after the repair started still shows", async () => {
    const thumb = deferred<string>();
    vi.spyOn(ipc, "getThumbnail").mockReturnValueOnce(thumb.promise);
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m, _hints, _proxy, repair): Promise<PlaybackPlan> =>
        repair ? { mode: "ready", path: COPY, repair: { dropsHeaders: false } } : { mode: "direct", path: m.path },
    );
    const project = projectWith(REPLAY);
    const manager = new MediaManager(() => project);
    void manager.ensure(REPLAY);
    await settle();
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(manager.status.get()[REPLAY.id]).toEqual(READY_COPY);

    thumb.resolve("C:\\cache\\thumbs\\replay-0.5.jpg");
    await settle();
    expect(manager.thumbs.get()[REPLAY.id]).toBe("C:\\cache\\thumbs\\replay-0.5.jpg");
  });

  it("a waveform that answers after the repair started still draws", async () => {
    const SOUND: MediaRef = { ...REPLAY, hasAudio: true };
    const PEAKS = "C:\\cache\\peaks\\replay.pk";
    const wave = deferred<WaveformResult>();
    vi.spyOn(ipc, "ensureWaveform").mockReturnValueOnce(wave.promise);
    silentThumbnails();
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m, _hints, _proxy, repair): Promise<PlaybackPlan> =>
        repair ? { mode: "ready", path: COPY, repair: { dropsHeaders: false } } : { mode: "direct", path: m.path },
    );
    // A real TPK1 peaks file: 150 pairs a second, two pairs.
    const peaks = new DataView(new ArrayBuffer(16));
    [..."TPK1"].forEach((c, i) => peaks.setUint8(i, c.charCodeAt(0)));
    peaks.setUint32(4, 150, true);
    peaks.setUint32(8, 2, true);
    [-7, 6, -3, 2].forEach((v, i) => peaks.setInt8(12 + i, v));
    vi.stubGlobal("fetch", async () => ({ arrayBuffer: async () => peaks.buffer }));
    try {
      const project = projectWith(SOUND);
      const manager = new MediaManager(() => project);
      void manager.ensure(SOUND);
      await settle();
      manager.playbackFailed(SOUND.id, SOUND.path, 3, ELEMENT);
      await settle();
      expect(manager.status.get()[SOUND.id]).toEqual(READY_COPY);

      wave.resolve({ state: "ready", path: PEAKS });
      await settle();
      const drawn = manager.waveforms.get()[SOUND.id];
      expect(drawn?.pairsPerSec).toBe(150);
      expect([...drawn!.mins]).toEqual([-7, -3]);
      expect([...drawn!.maxs]).toEqual([6, 2]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a repair answer heals no sibling the element failed", async () => {
    // A second entry for the same file, failed by a network error. A repair
    // answer says the file could NOT be played as it is, so it must not
    // retrack the sibling — two such entries would retrack each other.
    const sibling: MediaRef = { ...REPLAY, id: "m-replay-layer-2" };
    const { manager, flags, status } = await setup(
      () => Promise.resolve({ mode: "ready", path: COPY, repair: { dropsHeaders: false } }),
      REPLAY,
      sibling,
    );
    manager.playbackFailed(sibling.id, REPLAY.path, 2, ELEMENT);
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(status()).toEqual(READY_COPY);
    expect(flags()).toEqual([false, false, true]);
    expect(status(sibling.id)).toEqual({ state: "failed", message: ELEMENT });
  });

  it("ignores an error from a url the media no longer plays", async () => {
    const { manager, flags, status } = await setup(() => Promise.reject(new Error("unexpected repair plan")));
    manager.playbackFailed(REPLAY.id, "D:\\captures\\Replay before rename.mp4", 3, ELEMENT);
    await settle();
    expect(flags()).toEqual([false]);
    expect(status()).toEqual(READY_ORIGINAL);
  });

  it("does nothing once the manager is disposed", async () => {
    const { manager, flags, status } = await setup(() => Promise.reject(new Error("unexpected repair plan")));
    manager.dispose();
    manager.playbackFailed(REPLAY.id, REPLAY.path, 3, ELEMENT);
    await settle();
    expect(flags()).toEqual([false]);
    expect(status()).toEqual(READY_ORIGINAL);
  });
});

/**
 * THE INSTANT COPY AND THE FULL REPAIR BEHIND IT. The owner's real file: a
 * recording whose first minute is garbage. A full repair decodes the whole
 * file (30 s on a fast PC, far longer on a slow one), so the repair plan
 * answers with an INSTANT copy — a lossless stream copy from the first clean
 * keyframe, ready in under a second — and names the full repair as its
 * `upgrade`, which swaps in when it lands.
 *
 * Fixture values differ on every axis the code could confuse: the instant
 * copy and the full copy live in different cache folders under different
 * names; the instant copy's own job (377), the upgrade (412) and a
 * replacement upgrade (413) are distinct ids; the damaged range (60.5 s)
 * matches no ratio, duration or size; and every progress ratio is distinct.
 */
describe("an instant copy now, the full repair behind it", () => {
  const CLIP: MediaRef = {
    id: "m-genshin",
    path: "C:\\Users\\someone\\Downloads\\testing files\\Genshin 2026.09.30.mp4",
    size: 410_000_000,
    mtimeMs: 1_759_234_000_000,
    kind: "video",
    duration: 170.12,
    hasAudio: false,
    width: 2560,
    height: 1440,
  };
  const FLAGGED: MediaRef = { ...CLIP, dropInbandHeaders: true };
  /** The same file imported a second time. */
  const TWIN: MediaRef = { ...CLIP, id: "m-genshin-twin" };
  /** A different, also damaged, recording the id is relinked onto. */
  const OTHER: MediaRef = { ...CLIP, path: "E:\\replays\\Genshin 2026.10.01.mp4", size: 233_000_000 };
  const QUICK = "C:\\cache\\remux\\a17f.quick.mp4";
  const FULL = "C:\\cache\\proxy\\a17f.repairh.mp4";
  const UNTIL = 60.5;
  const QUICK_NOTE = { dropsHeaders: true, damagedUntil: UNTIL, quick: true as const };
  const UPGRADE = { jobId: 412, output: FULL };
  const ELEMENT = "This file couldn't be played";
  const READY_QUICK = { state: "ready", url: QUICK, sourcePath: QUICK };
  const READY_FULL = { state: "ready", url: FULL, sourcePath: FULL };
  const INSTANT: PlaybackPlan = { mode: "ready", path: QUICK, repair: QUICK_NOTE, upgrade: UPGRADE };

  /**
   * A manager whose `media` have been ensured, wired the way the editor
   * wires it. An ordinary plan answers "direct" on the file itself; each
   * repair plan takes the next of `answers` (the last one repeats).
   * `stamped` records every `onDropHeaders`, `damaged` every `onDamaged`.
   */
  async function setup(answers: PlaybackPlan[], ...media: MediaRef[]) {
    if (media.length === 0) media = [CLIP];
    silentThumbnails();
    let next = 0;
    const plan = vi
      .spyOn(ipc, "planPlayback")
      .mockImplementation(async (m, _hints, _proxy, repair) =>
        repair ? answers[Math.min(next++, answers.length - 1)]! : { mode: "direct" as const, path: m.path },
      );
    let project = projectWith(...media);
    const stamped: string[] = [];
    const damaged: Array<[string, unknown, boolean]> = [];
    const manager = new MediaManager(() => project, {
      onDropHeaders: (id) => stamped.push(id),
      onDamaged: (id, state, quick) => damaged.push([id, state, quick]),
    });
    await manager.init();
    for (const m of media) void manager.ensure(m);
    await settle();
    return {
      manager,
      stamped,
      damaged,
      flags: () => plan.mock.calls.map((c) => c[3]),
      status: (id = CLIP.id) => manager.status.get()[id],
      damage: (id = CLIP.id) => manager.damage.get()[id],
      use: (...m: MediaRef[]) => (project = projectWith(...m)),
      /** The element refuses the file it plays, as the scheduler reports it. */
      refuse: async (url: string, id = CLIP.id, code = 3) => {
        manager.playbackFailed(id, url, code, ELEMENT);
        await settle();
      },
    };
  }

  const progress = (id: number, ratio: number) =>
    handlers.onProgress!({ id, kind: "proxy", ratio, outTimeMs: 0, fps: 0, speed: 0, etaSec: null });
  const done = (id: number, path: string) => handlers.onDone!({ id, kind: "proxy", output: { path } });
  const failed = (id: number, message: string, canceled = false) =>
    handlers.onFailed!({ id, kind: "proxy", canceled, message, logTail: [] });

  it("plays the instant copy at once, damaged up to the scanned keyframe, repairing", async () => {
    const { status, damage, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    expect(status()).toEqual(READY_QUICK);
    expect(damage()).toEqual({ until: UNTIL, phase: "repairing", ratio: null });
  });

  it("records the headers rule as soon as the instant copy plays, so an export meanwhile decodes it the same way", async () => {
    const { status, refuse, stamped, use } = await setup([INSTANT]);
    await refuse(CLIP.path);
    // The full repair (412) is still running: nothing has landed but the
    // instant copy, whose note says what the full one will.
    expect(stamped).toEqual([CLIP.id]);
    // The editor recorded it; the swap then finds it there and asks nothing.
    use(FLAGGED);
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    expect(stamped).toEqual([CLIP.id]);
  });

  it("the full repair's progress moves the damage record, never the playing status", async () => {
    const { status, damage, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    progress(412, 0.37);
    expect(damage()).toEqual({ until: UNTIL, phase: "repairing", ratio: 0.37 });
    expect(status()).toEqual(READY_QUICK);
  });

  it("the full repair's end swaps the full copy in", async () => {
    const { status, damage, refuse, use } = await setup([INSTANT]);
    await refuse(CLIP.path);
    use(FLAGGED); // as the editor records it when the instant copy plays
    progress(412, 0.91);
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    expect(damage()).toEqual({ until: UNTIL, phase: "recovered", ratio: null });
  });

  it("the full copy refused in the element after the swap is final, not a wait on the repair that just ended", async () => {
    const { status, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    // Job 412 has ended and will never report again: waiting on it would
    // leave the media on "Preparing" for the rest of the session.
    await refuse(FULL);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("an instant copy still being made: its own progress is not the repair's", async () => {
    const { status, damage, refuse, stamped } = await setup([
      { mode: "pending", jobId: 377, output: QUICK, repair: QUICK_NOTE, upgrade: UPGRADE },
    ]);
    await refuse(CLIP.path);
    expect(status()).toEqual({ state: "preparing", ratio: null, jobId: 377 });
    progress(377, 0.52);
    expect(status()).toEqual({ state: "preparing", ratio: 0.52, jobId: 377 });
    expect(damage()?.ratio).toBeNull();
    // Nothing plays yet, so nothing is recorded yet: the instant copy's own
    // job publishes it, and records the headers rule as it does.
    expect(stamped).toEqual([]);
    done(377, QUICK);
    expect(status()).toEqual(READY_QUICK);
    expect(damage()?.phase).toBe("repairing");
    expect(stamped).toEqual([CLIP.id]);
  });

  it("an instant copy whose own remux failed is no longer failed once the full copy lands: a re-import does not re-plan it", async () => {
    // The one way the id is marked failed by the element (`planFailed`, the
    // repair attempt's job failing) while its full repair still runs.
    const { status, refuse, flags, use, manager } = await setup([
      { mode: "pending", jobId: 377, output: QUICK, repair: QUICK_NOTE, upgrade: UPGRADE },
    ]);
    await refuse(CLIP.path);
    failed(377, "ffmpeg exited with code 1");
    expect(status()).toEqual({ state: "failed", message: `${ELEMENT}: ffmpeg exited with code 1` });
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    // The same file imported again: its plain plan comes up ready and gives
    // failed siblings another try. CLIP is not failed any more.
    use(FLAGGED, TWIN);
    void manager.ensure(TWIN);
    await settle();
    expect(status(TWIN.id)).toEqual({ state: "ready", url: CLIP.path, sourcePath: CLIP.path });
    expect(status()).toEqual(READY_FULL);
    expect(flags()).toEqual([false, true, false]);
  });

  it("a full repair that lands before its instant copy's own job is never undone by it", async () => {
    // Possible only when the plan joined a full repair about to finish.
    const { status, refuse } = await setup([
      { mode: "pending", jobId: 377, output: QUICK, repair: QUICK_NOTE, upgrade: UPGRADE },
    ]);
    await refuse(CLIP.path);
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    progress(377, 0.64);
    expect(status()).toEqual(READY_FULL);
    done(377, QUICK);
    expect(status()).toEqual(READY_FULL);
  });

  it("a full repair that fails keeps the instant copy playing; the damage stays unrecovered", async () => {
    const { status, damage, refuse, stamped } = await setup([INSTANT]);
    await refuse(CLIP.path);
    progress(412, 0.18);
    failed(412, "ffmpeg exited with code 1");
    expect(status()).toEqual(READY_QUICK);
    expect(damage()).toEqual({ until: UNTIL, phase: "unrecovered", ratio: null });
    // Recorded when the instant copy played, and still true: the stream is
    // the same damaged H.264 whether or not the full repair finished.
    expect(stamped).toEqual([CLIP.id]);
    // With no repair left behind it, the instant copy's own failure is final.
    await refuse(QUICK);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("the instant copy refused while its repair runs waits on that repair, with no new plan", async () => {
    const { status, refuse, flags } = await setup([INSTANT]);
    await refuse(CLIP.path);
    progress(412, 0.25);
    await refuse(QUICK, CLIP.id, 4);
    expect(status()).toEqual({ state: "preparing", ratio: 0.25, jobId: 412 });
    expect(flags()).toEqual([false, true]);
    progress(412, 0.71);
    expect(status()).toEqual({ state: "preparing", ratio: 0.71, jobId: 412 });
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
  });

  it("…and fails in the element's words, the job's detail after, if that repair fails too", async () => {
    const { status, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    await refuse(QUICK);
    failed(412, "ffmpeg exited with code 1");
    expect(status()).toEqual({ state: "failed", message: `${ELEMENT}: ffmpeg exited with code 1` });
  });

  it("any other element error on the instant copy is final, and the repair's end does not paint over it", async () => {
    const { status, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    await refuse(QUICK, CLIP.id, 2);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
    done(412, FULL);
    expect(status()).toEqual({ state: "failed", message: ELEMENT });
  });

  it("someone else canceling the full repair asks for it again; the instant copy plays on", async () => {
    const { status, refuse, flags } = await setup([INSTANT, { ...INSTANT, upgrade: { jobId: 413, output: FULL } }]);
    await refuse(CLIP.path);
    failed(412, "canceled", true);
    await settle();
    expect(flags()).toEqual([false, true, true]);
    expect(status()).toEqual(READY_QUICK);
    done(413, FULL);
    expect(status()).toEqual(READY_FULL);
  });

  it("a full repair with no instant copy in front reports its progress in the record too", async () => {
    const { status, damage, refuse } = await setup([
      { mode: "pending", jobId: 412, output: FULL, repair: { dropsHeaders: true } },
    ]);
    await refuse(CLIP.path);
    expect(damage()).toEqual({ until: null, phase: "repairing", ratio: null });
    progress(412, 0.33);
    expect(status()).toEqual({ state: "preparing", ratio: 0.33, jobId: 412 });
    expect(damage()).toEqual({ until: null, phase: "repairing", ratio: 0.33 });
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    expect(damage()).toEqual({ until: null, phase: "recovered", ratio: null });
  });

  it("a flagged media plans straight onto the instant copy and its repair", async () => {
    const { flags, status, damage } = await setup([INSTANT], FLAGGED);
    expect(flags()).toEqual([true]);
    expect(status()).toEqual(READY_QUICK);
    expect(damage()?.phase).toBe("repairing");
  });

  it("a flagged media whose full copy is cached is recovered at once", async () => {
    const { status, damage, damaged } = await setup(
      [{ mode: "ready", path: FULL, repair: { dropsHeaders: true, damagedUntil: UNTIL } }],
      FLAGGED,
    );
    expect(status()).toEqual(READY_FULL);
    expect(damage()).toEqual({ until: UNTIL, phase: "recovered", ratio: null });
    expect(damaged).toEqual([[CLIP.id, { until: UNTIL, phase: "recovered", ratio: null }, false]]);
  });

  it("two entries for one file both swap when the repair they share lands", async () => {
    const { status, refuse } = await setup([INSTANT], CLIP, TWIN);
    await refuse(CLIP.path);
    await refuse(CLIP.path, TWIN.id);
    expect(status(TWIN.id)).toEqual(READY_QUICK);
    done(412, FULL);
    expect(status()).toEqual(READY_FULL);
    expect(status(TWIN.id)).toEqual(READY_FULL);
  });

  it("a damaged range that is not a positive number of seconds is no range", async () => {
    const { damage, refuse } = await setup([{ ...INSTANT, repair: { ...QUICK_NOTE, damagedUntil: -3 } }]);
    await refuse(CLIP.path);
    expect(damage()?.until).toBeNull();
  });

  it("untrack forgets the record", async () => {
    const { manager, damage, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    manager.untrack(CLIP.id);
    expect(damage()).toBeUndefined();
    // Nor does the full repair's end bring anything back for it.
    done(412, FULL);
    expect(manager.status.get()[CLIP.id]).toBeUndefined();
  });

  it("a relink onto another file forgets the record; the same file asked again keeps it", async () => {
    const { manager, damage, refuse, use } = await setup([INSTANT]);
    await refuse(CLIP.path);
    progress(412, 0.44);
    manager.retrack(CLIP.id);
    await settle();
    expect(damage()).toEqual({ until: UNTIL, phase: "repairing", ratio: 0.44 });

    use(OTHER);
    manager.retrack(CLIP.id, true);
    await settle();
    expect(damage()).toBeUndefined();
  });

  it("healthy media never write the record: its subscribers are never called", async () => {
    silentThumbnails();
    vi.spyOn(ipc, "planPlayback").mockImplementation(async (m) =>
      m.id === TWIN.id
        ? { mode: "pending" as const, jobId: 9, output: "C:\\cache\\remux\\twin.mp4" }
        : { mode: "direct" as const, path: m.path },
    );
    const manager = new MediaManager(() => projectWith(CLIP, TWIN));
    await manager.init();
    const empty = manager.damage.get();
    let notified = 0;
    manager.damage.subscribe(() => notified++);
    manager.ensureAll(projectWith(CLIP, TWIN));
    await settle();
    progress(9, 0.5);
    done(9, "C:\\cache\\remux\\twin.mp4");
    manager.playbackFailed(CLIP.id, CLIP.path, 2, ELEMENT);
    await settle();
    expect(manager.status.get()[TWIN.id]?.state).toBe("ready");
    expect(manager.damage.get()).toBe(empty);
    expect(notified).toBe(0);
  });

  it("tells the user once per media per session, and again only for a different file", async () => {
    const { manager, damaged, refuse, use } = await setup([
      INSTANT,
      { ...INSTANT, upgrade: { jobId: 413, output: FULL } },
    ]);
    await refuse(CLIP.path);
    expect(damaged).toEqual([[CLIP.id, { until: UNTIL, phase: "repairing", ratio: null }, true]]);

    // A foreign cancel re-plans the repair; a same-file retrack repairs it
    // all over again. Neither is news.
    failed(412, "canceled", true);
    await settle();
    manager.retrack(CLIP.id);
    await settle();
    await refuse(CLIP.path);
    expect(damaged).toHaveLength(1);

    // Relinked onto another damaged recording: that file is news.
    use(OTHER);
    manager.retrack(CLIP.id, true);
    await settle();
    await refuse(OTHER.path);
    expect(damaged).toHaveLength(2);
    expect(damaged[1]![0]).toBe(CLIP.id);
  });

  it("dispose leaves the full repair running into the cache", async () => {
    const cancel = vi.spyOn(ipc, "cancelJob").mockResolvedValue(undefined as never);
    const { manager, refuse } = await setup([INSTANT]);
    await refuse(CLIP.path);
    manager.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });
});

/**
 * `dropInbandHeaders` is recorded outside history (`replace`, edit:false),
 * so anything that puts back a project from before the record — an undo, a
 * cancelled canvas drag — took it away, and the export then decoded the
 * damaged file raw: the garbage frame sizes the repair exists to avoid. The
 * manager remembers what it learned and records it again. These run a REAL
 * session (its autosave timers inert, so nothing is written) wired the way
 * the editor wires its manager; the repair copy is always ready at once.
 */
describe("the record of a damaged stream outlives an undo", () => {
  const DAMAGED: MediaRef = {
    id: "m-damaged",
    path: "E:\\instant replay\\Replay 2026-10-04.mp4",
    size: 64_000_000,
    mtimeMs: 1_759_500_000_000,
    kind: "video",
    duration: 61,
    hasAudio: false,
    width: 2560,
    height: 1440,
  };
  /** A healthy file elsewhere, for the relink. */
  const HEALTHY: MediaInfo = {
    path: "F:\\backup\\Replay 2026-10-04 (fixed).mp4",
    size: 63_000_000,
    mtimeMs: 1_759_600_000_000,
    kind: "video",
    duration: 60,
    hasAudio: false,
    width: 1920,
    height: 1080,
  };
  const COPY = "C:\\cache\\repair\\9be04d.repairh.mp4";

  async function wired() {
    vi.stubGlobal("window", {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    });
    silentThumbnails();
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m, _hints, _proxy, repair): Promise<PlaybackPlan> =>
        repair ? { mode: "ready", path: COPY, repair: { dropsHeaders: true } } : { mode: "direct", path: m.path },
    );
    const session = new ProjectSession("C:\\Users\\someone\\Documents\\Taroting\\cut.trt", projectWith(DAMAGED));
    /** Every time the manager asked for the record. */
    const asks: string[] = [];
    // The editor's two hooks, as editor.ts passes them.
    const manager = new MediaManager(() => session.project, {
      onDropHeaders: (mediaId) => {
        asks.push(mediaId);
        const m = findMedia(session.project, mediaId);
        if (m === undefined || m.dropInbandHeaders === true) return;
        session.replace(updateMedia(session.project, mediaId, { dropInbandHeaders: true }), { edit: false });
      },
      watchProject: (onChange) => session.store.subscribe(onChange),
    });
    void manager.ensure(DAMAGED);
    await settle();
    return {
      session,
      manager,
      asks,
      recorded: () => findMedia(session.project, DAMAGED.id)?.dropInbandHeaders,
      repair: async () => {
        manager.playbackFailed(DAMAGED.id, DAMAGED.path, 3, "This file couldn't be played");
        await settle();
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an undo to a project from before the record gets it back, once", async () => {
    const { session, asks, recorded, repair } = await wired();
    const name = session.project.name;
    // An edit made while the repair ran: its undo snapshot has no record.
    session.commit((p) => ({ ...p, name: "Replay, trimmed" }));
    await repair();
    expect(recorded()).toBe(true);
    expect(asks).toEqual([DAMAGED.id]);

    let publishes = 0;
    session.store.subscribe(() => publishes++);
    session.undo();
    await settle();
    expect(session.project.name).toBe(name); // the undo took
    expect(recorded()).toBe(true); // and the record is back
    expect(asks).toEqual([DAMAGED.id, DAMAGED.id]);
    // The undo's publish, the record's own, then quiet: it does not loop.
    expect(publishes).toBe(2);
  });

  it("a relink onto another file forgets it: no record lands on the new file", async () => {
    const { session, manager, asks, recorded, repair } = await wired();
    await repair();
    expect(recorded()).toBe(true);

    // The relink, as relink.ts performs it: commit, then retrack.
    session.commit((p) => applyRelink(p, DAMAGED.id, HEALTHY.path, HEALTHY));
    manager.retrack(DAMAGED.id, true);
    await settle();
    expect(findMedia(session.project, DAMAGED.id)?.path).toBe(HEALTHY.path);
    expect(recorded()).toBeUndefined();
    expect(asks).toEqual([DAMAGED.id]);
    expect(manager.status.get()[DAMAGED.id]).toEqual({ state: "ready", url: HEALTHY.path, sourcePath: HEALTHY.path });
  });

  it("an undo that brings back the file from before a relink never puts the record on it", async () => {
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} });
    silentThumbnails();
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m, _hints, _proxy, repair): Promise<PlaybackPlan> =>
        repair ? { mode: "ready", path: COPY, repair: { dropsHeaders: true } } : { mode: "direct", path: m.path },
    );
    // The entry starts on the healthy file, and is relinked onto the damaged
    // recording, which the WebView then refuses.
    const BEFORE: MediaRef = { ...HEALTHY, id: DAMAGED.id };
    const DAMAGED_FILE: MediaInfo = {
      path: DAMAGED.path,
      size: DAMAGED.size,
      mtimeMs: DAMAGED.mtimeMs,
      kind: "video",
      duration: DAMAGED.duration,
      hasAudio: false,
      width: DAMAGED.width,
      height: DAMAGED.height,
    };
    const session = new ProjectSession("C:\\Users\\someone\\Documents\\Taroting\\cut.trt", projectWith(BEFORE));
    const asks: string[] = [];
    const manager = new MediaManager(() => session.project, {
      onDropHeaders: (mediaId) => {
        asks.push(mediaId);
        session.replace(updateMedia(session.project, mediaId, { dropInbandHeaders: true }), { edit: false });
      },
      watchProject: (onChange) => session.store.subscribe(onChange),
    });
    const entry = () => findMedia(session.project, DAMAGED.id);
    void manager.ensure(BEFORE);
    await settle();

    session.commit((p) => applyRelink(p, DAMAGED.id, DAMAGED.path, DAMAGED_FILE));
    manager.retrack(DAMAGED.id, true);
    await settle();
    manager.playbackFailed(DAMAGED.id, DAMAGED.path, 3, "This file couldn't be played");
    await settle();
    expect(entry()?.dropInbandHeaders).toBe(true);
    expect(asks).toEqual([DAMAGED.id]);

    // Undo past the relink: the same id points at the healthy file again,
    // with no retrack. The record was learned for the damaged file only.
    session.undo();
    await settle();
    expect(entry()?.path).toBe(HEALTHY.path);
    expect(entry()?.dropInbandHeaders).toBeUndefined();
    expect(asks).toEqual([DAMAGED.id]);

    // Redo: the damaged file is back under the id, and so is its record.
    session.redo();
    await settle();
    expect(entry()?.path).toBe(DAMAGED.path);
    expect(entry()?.dropInbandHeaders).toBe(true);
  });

  it("a repair job that finishes after an undo moved the id off the file never records it there", async () => {
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} });
    silentThumbnails();
    vi.spyOn(ipc, "planPlayback").mockImplementation(
      async (m, _hints, _proxy, repair): Promise<PlaybackPlan> =>
        repair
          ? { mode: "pending", jobId: 91, output: COPY, repair: { dropsHeaders: true } }
          : { mode: "direct", path: m.path },
    );
    const BEFORE: MediaRef = { ...HEALTHY, id: DAMAGED.id };
    const DAMAGED_FILE: MediaInfo = {
      path: DAMAGED.path, size: DAMAGED.size, mtimeMs: DAMAGED.mtimeMs, kind: "video",
      duration: DAMAGED.duration, hasAudio: false, width: DAMAGED.width, height: DAMAGED.height,
    };
    const session = new ProjectSession("C:\\Users\\someone\\Documents\\Taroting\\cut.trt", projectWith(BEFORE));
    const asks: string[] = [];
    const manager = new MediaManager(() => session.project, {
      onDropHeaders: (mediaId) => {
        asks.push(mediaId);
        session.replace(updateMedia(session.project, mediaId, { dropInbandHeaders: true }), { edit: false });
      },
      watchProject: (onChange) => session.store.subscribe(onChange),
    });
    await manager.init();
    const entry = () => findMedia(session.project, DAMAGED.id);
    void manager.ensure(BEFORE);
    await settle();
    session.commit((p) => applyRelink(p, DAMAGED.id, DAMAGED.path, DAMAGED_FILE));
    manager.retrack(DAMAGED.id, true);
    await settle();
    manager.playbackFailed(DAMAGED.id, DAMAGED.path, 3, "This file couldn't be played");
    await settle();
    expect(manager.status.get()[DAMAGED.id]).toEqual({ state: "preparing", ratio: null, jobId: 91 });

    // Undo past the relink while the repair transcode still runs: no retrack.
    session.undo();
    await settle();
    expect(entry()?.path).toBe(HEALTHY.path);

    handlers.onDone!({ id: 91, kind: "proxy", output: { path: COPY } });
    await settle();
    expect(entry()?.dropInbandHeaders).toBeUndefined();
    expect(asks).toEqual([]);

    // Redo: the damaged file is back WITHOUT the record in its snapshot, so
    // only the manager's restamp can put it there.
    session.redo();
    await settle();
    expect(entry()?.path).toBe(DAMAGED.path);
    expect(entry()?.dropInbandHeaders).toBe(true);
    expect(asks).toEqual([DAMAGED.id]);
  });

  it("holds its project subscription from construction until dispose", () => {
    let live = 0;
    const manager = new MediaManager(() => projectWith(), {
      watchProject: () => {
        live++;
        return () => {
          live--;
        };
      },
    });
    expect(live).toBe(1);
    manager.dispose();
    expect(live).toBe(0);
  });
});

/**
 * Media `load_project` reported missing or changed. An ABSENT file must end
 * "failed" without a single backend request made for it: the plan mock below
 * answers "direct" for every path exactly as the backend does for a path that
 * is not there, so a manager that skipped the existence check publishes
 * "ready" and these tests see it. A CHANGED file (present, new mtime) previews
 * as before. The bystander is never reported, and proves the check costs
 * nothing for intact media.
 */
describe("media the load reported missing", () => {
  const GONE: MediaRef = { ...OLD_FILE, hasAudio: true };

  function spies() {
    return {
      plan: vi.spyOn(ipc, "planPlayback").mockImplementation(async (m) => ({ mode: "direct" as const, path: m.path })),
      thumb: vi.spyOn(ipc, "getThumbnail").mockReturnValue(new Promise<string>(() => {})),
      wave: vi.spyOn(ipc, "ensureWaveform").mockReturnValue(new Promise(() => {})),
    };
  }

  it("marks an absent file 'File not found' and asks the backend nothing for it", async () => {
    const { plan, thumb, wave } = spies();
    const exists = vi.spyOn(ipc, "pathExists").mockResolvedValue(false);
    const project = projectWith(GONE, BYSTANDER);
    const media = new MediaManager(() => project);
    media.ensureAll(project, ["m-relink"]);
    await settle();

    expect(media.status.get()["m-relink"]).toEqual({ state: "failed", message: "File not found" });
    expect(exists.mock.calls).toEqual([[GONE.path]]);
    // Nothing went out for the gone path; the bystander was ensured normally.
    expect(plan.mock.calls.map((c) => c[0].id)).toEqual(["m-keep"]);
    expect(thumb.mock.calls.map((c) => c[0].path)).toEqual([BYSTANDER.path]);
    expect(wave).not.toHaveBeenCalled();
    expect(media.status.get()["m-keep"]).toEqual({ state: "ready", url: BYSTANDER.path, sourcePath: BYSTANDER.path });
  });

  it("previews a file that is present but changed, exactly as before", async () => {
    const { plan, wave } = spies();
    vi.spyOn(ipc, "pathExists").mockResolvedValue(true);
    const project = projectWith(GONE);
    const media = new MediaManager(() => project);
    media.ensureAll(project, ["m-relink"]);
    await settle();

    expect(plan).toHaveBeenCalledTimes(1);
    expect(wave).toHaveBeenCalledTimes(1);
    expect(media.status.get()["m-relink"]).toEqual({ state: "ready", url: GONE.path, sourcePath: GONE.path });
  });

  it("stays failed through a later ensureAll, and plans afresh once relinked", async () => {
    const { plan } = spies();
    const exists = vi.spyOn(ipc, "pathExists").mockResolvedValue(false);
    let project = projectWith(GONE);
    const media = new MediaManager(() => project);
    media.ensureAll(project, ["m-relink"]);
    await settle();

    // An import calls ensureAll again without the list: nothing changes.
    media.ensureAll(project);
    await settle();
    expect(media.status.get()["m-relink"]).toEqual({ state: "failed", message: "File not found" });
    expect(plan).not.toHaveBeenCalled();

    // The relink dialog commits the new file, then retracks.
    project = projectWith(NEW_FILE);
    media.retrack("m-relink", true);
    await settle();
    expect(media.status.get()["m-relink"]).toEqual({ state: "ready", url: NEW_FILE.path, sourcePath: NEW_FILE.path });
    // The relinked file is not stat'd again: it came from a fresh probe.
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it("drops an existence answer that a relink overtook", async () => {
    spies();
    const answer = deferred<boolean>();
    vi.spyOn(ipc, "pathExists").mockReturnValue(answer.promise);
    let project = projectWith(GONE);
    const media = new MediaManager(() => project);
    media.ensureAll(project, ["m-relink"]);
    await settle();

    project = projectWith(NEW_FILE);
    media.retrack("m-relink", true);
    await settle();
    answer.resolve(false);
    await settle();

    expect(media.status.get()["m-relink"]).toEqual({ state: "ready", url: NEW_FILE.path, sourcePath: NEW_FILE.path });
  });

  it("does not declare a file gone when the question itself fails", async () => {
    const { plan } = spies();
    vi.spyOn(ipc, "pathExists").mockRejectedValue(new Error("ipc down"));
    const project = projectWith(GONE);
    const media = new MediaManager(() => project);
    media.ensureAll(project, ["m-relink"]);
    await settle();

    expect(plan).toHaveBeenCalledTimes(1);
    expect(media.status.get()["m-relink"]).toEqual({ state: "ready", url: GONE.path, sourcePath: GONE.path });
  });
});

/**
 * Soft failures recorded for diagnostics name every whole path they mention,
 * so the redactor can replace each one whole. The paths contain spaces on
 * purpose: those are what free-text path hunting cuts short.
 */
describe("soft failure diagnostics carry their paths", () => {
  const SPACED: MediaRef = {
    ...OLD_FILE,
    id: "m-spaced",
    path: "D:\\Family Videos\\beach day.mov",
    hasAudio: true,
  };
  const PEAKS = "C:\\Users\\Some One\\AppData\\Local\\Taroting\\cache\\peaks\\ab12.pk";

  function lastEntry(op: string) {
    const all = recentErrors().filter((e) => e.op === op);
    return all[all.length - 1];
  }

  it("a failed thumbnail names the media path", async () => {
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise(() => {}));
    vi.spyOn(ipc, "ensureWaveform").mockReturnValue(new Promise(() => {}));
    vi.spyOn(ipc, "getThumbnail").mockRejectedValue(new Error("ffmpeg exited with 1"));
    const project = projectWith(SPACED);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();

    expect(lastEntry("Thumbnail")?.paths).toEqual([SPACED.path]);
  });

  it("a failed waveform request names the media path", async () => {
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise(() => {}));
    silentThumbnails();
    vi.spyOn(ipc, "ensureWaveform").mockRejectedValue(new Error("no audio stream"));
    const project = projectWith(SPACED);
    const media = new MediaManager(() => project);
    media.ensureAll(project);
    await settle();

    const e = lastEntry("Waveform");
    expect(e?.message).toContain("Couldn't build the audio waveform");
    expect(e?.paths).toEqual([SPACED.path]);
  });

  it("a peaks file that cannot be loaded names the media AND the cache file", async () => {
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise(() => {}));
    silentThumbnails();
    vi.spyOn(ipc, "ensureWaveform").mockResolvedValue({ state: "ready", path: PEAKS });
    vi.stubGlobal("fetch", () => Promise.reject(new Error("asset protocol refused")));
    try {
      const project = projectWith(SPACED);
      const media = new MediaManager(() => project);
      media.ensureAll(project);
      await settle();

      const e = lastEntry("Waveform");
      expect(e?.message).toContain("Couldn't load the audio waveform");
      expect(e?.paths).toEqual([SPACED.path, PEAKS]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unreadable peaks for media that has left the project name only the cache file", async () => {
    vi.spyOn(ipc, "planPlayback").mockReturnValue(new Promise(() => {}));
    silentThumbnails();
    vi.spyOn(ipc, "ensureWaveform").mockResolvedValue({ state: "ready", path: PEAKS });
    // A body that is not TPK1 peaks.
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    try {
      // The project no longer lists the media the ensure was started for.
      const project = projectWith(BYSTANDER);
      const media = new MediaManager(() => project);
      void media.ensure(SPACED);
      await settle();

      const e = lastEntry("Waveform");
      expect(e?.message).toBe(`Waveform data for ${PEAKS} couldn't be read`);
      expect(e?.paths).toEqual([PEAKS]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
