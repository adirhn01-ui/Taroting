import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackPlan } from "../../core/ipc";
import { ipc } from "../../core/ipc";
import type { MediaRef, ProjectFile } from "../../core/types";
import { createProject } from "../../core/project";
import { MediaManager, type WaveformData } from "./media";

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
