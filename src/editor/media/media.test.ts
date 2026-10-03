import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackPlan } from "../../core/ipc";
import { ipc } from "../../core/ipc";
import type { MediaRef, ProjectFile } from "../../core/types";
import { createProject } from "../../core/project";
import { recentErrors } from "../../ui/errors";
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
