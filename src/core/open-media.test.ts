import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, ProjectFile } from "./types";

// open-media keeps module state (the chain, the cached temp-dir lookup), so
// every test gets a FRESH copy of it — and of the `ipc` object it calls, which
// a reset module graph re-creates, so the spies must go on that same copy.
async function fresh(): Promise<{
  om: typeof import("./open-media");
  ipc: typeof import("./ipc")["ipc"];
}> {
  vi.resetModules();
  const om = await import("./open-media");
  const { ipc } = await import("./ipc");
  return { om, ipc };
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

/** Let every queued continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOnOpenChain", () => {
  it("starts a task only after every earlier one has settled", async () => {
    const { om } = await fresh();
    const log: string[] = [];
    const gate = deferred<void>();
    const first = om.runOnOpenChain(async () => {
      log.push("first start");
      await gate.promise;
      log.push("first end");
      return 1;
    });
    const second = om.runOnOpenChain(async () => {
      log.push("second start");
      return 2;
    });
    await settle();
    // The second open is queued, not running beside the first.
    expect(log).toEqual(["first start"]);
    gate.resolve();
    expect(await second).toBe(2);
    expect(await first).toBe(1);
    expect(log).toEqual(["first start", "first end", "second start"]);
  });

  it("keeps going after a task fails, and still hands the failure to its own caller", async () => {
    const { om } = await fresh();
    const gate = deferred<void>();
    const failing = om.runOnOpenChain(async () => {
      await gate.promise;
      throw new Error("probe failed");
    });
    const next = om.runOnOpenChain(async () => "opened");
    gate.resolve();
    await expect(failing).rejects.toThrow("probe failed");
    // A chain that kept the rejection would hand it to every open queued
    // behind it: one unreadable file would refuse every later one this run.
    await expect(next).resolves.toBe("opened");
    await expect(om.runOnOpenChain(async () => "still open")).resolves.toBe("still open");
  });
});

describe("createTeardowns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Watch a promise without awaiting it: a mutant whose wait never ends must
   *  FAIL an assertion here, not hang until the test times out. */
  function watch<T>(p: Promise<T>): { value: T | undefined; done: boolean } {
    const box: { value: T | undefined; done: boolean } = { value: undefined, done: false };
    void p.then((v) => {
      box.value = v;
      box.done = true;
    });
    return box;
  }

  it("gives up on a teardown that never finishes, at exactly the bound", async () => {
    vi.useFakeTimers();
    const { om } = await fresh();
    const t = om.createTeardowns(() => {});
    // A final save hung on an unreachable disk: this promise never settles.
    t.track(() => new Promise<void>(() => {}));
    const bounded = watch(t.settledWithin(3000));
    const unbounded = watch(t.settled());
    await vi.advanceTimersByTimeAsync(2999);
    expect(bounded.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(bounded).toEqual({ value: false, done: true });
    // The close gate's wait is NOT bounded: the save is still owed.
    expect(unbounded.done).toBe(false);
  });

  it("charges a hung teardown to ONE navigation, not to every later one", async () => {
    vi.useFakeTimers();
    const { om } = await fresh();
    const t = om.createTeardowns(() => {});
    t.track(() => new Promise<void>(() => {})); // hung for good
    const first = watch(t.settledWithin(3000));
    await vi.advanceTimersByTimeAsync(3000);
    expect(first).toEqual({ value: false, done: true });
    // The next navigation, with nothing new closing, must not sit out another
    // three seconds behind the same dead save: it proceeds without any timer.
    const second = watch(t.settledWithin(3000));
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ value: true, done: true });
    // A teardown tracked after the give-up is still waited for normally.
    const later = deferred<void>();
    t.track(() => later.promise);
    const third = watch(t.settledWithin(3000));
    await vi.advanceTimersByTimeAsync(100);
    expect(third.done).toBe(false);
    later.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toEqual({ value: true, done: true });
    // …while the close gate still owes the hung save.
    expect(watch(t.settled()).done).toBe(false);
  });

  it("still waits for a slow teardown that finishes inside the bound, and no longer", async () => {
    vi.useFakeTimers();
    const { om } = await fresh();
    const t = om.createTeardowns(() => {});
    const flushed = deferred<void>();
    t.track(() => flushed.promise);
    const bounded = watch(t.settledWithin(3000));
    await vi.advanceTimersByTimeAsync(500);
    // The ordering the wait exists for: nothing mounts before the flush lands.
    expect(bounded.done).toBe(false);
    flushed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(bounded).toEqual({ value: true, done: true });
    // And the three-second timer went with it rather than lingering.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for EVERY teardown in flight, not just the latest", async () => {
    const { om } = await fresh();
    const t = om.createTeardowns(() => {});
    const editor = deferred<void>();
    t.track(() => editor.promise); // an editor mid-final-save
    t.track(() => {}); // the settings screen closing right behind it
    const all = watch(t.settled());
    await settle();
    expect(all.done).toBe(false);
    editor.resolve();
    await settle();
    expect(all.done).toBe(true);
  });

  it("hands a throwing or rejecting teardown to onError and keeps going", async () => {
    const { om } = await fresh();
    const seen: unknown[] = [];
    const t = om.createTeardowns((e) => seen.push(e));
    const sync = new Error("timeline dispose threw");
    const async_ = new Error("stage dispose rejected");
    t.track(() => {
      throw sync;
    });
    t.track(async () => {
      throw async_;
    });
    await expect(t.settledWithin(3000)).resolves.toBe(true);
    expect(seen).toEqual([sync, async_]);
  });

  it("stays settled when the reporter itself throws", async () => {
    const { om } = await fresh();
    const t = om.createTeardowns(() => {
      throw new Error("no toast host");
    });
    t.track(() => {
      throw new Error("dispose broke");
    });
    await expect(t.settled()).resolves.toBeUndefined();
  });
});

describe("isTempProjectPath", () => {
  const DIR = "C:\\Users\\Ana\\AppData\\Local\\Taroting\\tmp-projects";

  it("matches the temp dir regardless of case or slash direction", async () => {
    const { om, ipc } = await fresh();
    vi.spyOn(ipc, "tempProjectsDir").mockResolvedValue(DIR);
    expect(await om.isTempProjectPath(`${DIR}\\clip.trt`)).toBe(true);
    expect(await om.isTempProjectPath("c:/users/ana/appdata/local/taroting/TMP-PROJECTS/clip.trt")).toBe(
      true,
    );
    expect(await om.isTempProjectPath("C:\\Users\\Ana\\Documents\\Taroting\\clip.trt")).toBe(false);
  });

  it("stops at a folder boundary", async () => {
    const { om, ipc } = await fresh();
    vi.spyOn(ipc, "tempProjectsDir").mockResolvedValue(DIR);
    // A sibling folder that merely starts with the same name is not inside it.
    expect(await om.isTempProjectPath(`${DIR}-old\\clip.trt`)).toBe(false);
    expect(await om.isTempProjectPath(`${DIR}\\clip.trt`)).toBe(true);
  });

  it("matches the same way when the dir comes back with a trailing separator", async () => {
    const { om, ipc } = await fresh();
    vi.spyOn(ipc, "tempProjectsDir").mockResolvedValue(`${DIR}\\`);
    expect(await om.isTempProjectPath(`${DIR}\\clip.trt`)).toBe(true);
    expect(await om.isTempProjectPath(`${DIR}-old\\clip.trt`)).toBe(false);
  });

  it("is always false where there is no temp dir (a plain browser)", async () => {
    const { om, ipc } = await fresh();
    vi.spyOn(ipc, "tempProjectsDir").mockResolvedValue("");
    expect(await om.isTempProjectPath(`${DIR}\\clip.trt`)).toBe(false);
    expect(await om.isTempProjectPath("")).toBe(false);
  });

  it("asks the backend once per run, however many opens ask", async () => {
    const { om, ipc } = await fresh();
    const spy = vi.spyOn(ipc, "tempProjectsDir").mockResolvedValue(DIR);
    const answers = await Promise.all([
      om.isTempProjectPath(`${DIR}\\a.trt`),
      om.isTempProjectPath("D:\\b.trt"),
    ]);
    expect(await om.isTempProjectPath(`${DIR}\\c.trt`)).toBe(true);
    expect(answers).toEqual([true, false]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failed lookup for the rest of the run", async () => {
    const { om, ipc } = await fresh();
    const spy = vi
      .spyOn(ipc, "tempProjectsDir")
      .mockRejectedValueOnce(new Error("paths unavailable"))
      .mockResolvedValue(DIR);
    // Unknown opens as the ordinary project it looks like...
    expect(await om.isTempProjectPath(`${DIR}\\clip.trt`)).toBe(false);
    // ...but the next open asks again, so a scratch file still gets its gate.
    expect(await om.isTempProjectPath(`${DIR}\\clip.trt`)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("openMediaAsProject", () => {
  const TMP = "C:\\Users\\Ana\\AppData\\Local\\Taroting\\tmp-projects";

  function mediaInfo(over: Partial<MediaInfo>): MediaInfo {
    return {
      path: "D:\\Pictures\\harbour.jpg",
      size: 5_242_880,
      mtimeMs: 1_726_000_000_000,
      kind: "image",
      duration: 0,
      hasAudio: false,
      ...over,
    };
  }

  async function harness(info: MediaInfo | Error) {
    const { om, ipc } = await fresh();
    const calls: string[] = [];
    const saved: Array<{ path: string; project: ProjectFile }> = [];
    vi.spyOn(ipc, "tempProjectPath").mockImplementation(async (name) => {
      calls.push(`tempProjectPath:${name}`);
      return `${TMP}\\${name} (2).trt`;
    });
    vi.spyOn(ipc, "probeMedia").mockImplementation(async (p) => {
      calls.push(`probeMedia:${p}`);
      if (info instanceof Error) throw info;
      return info;
    });
    const save = vi.spyOn(ipc, "saveProject").mockImplementation(async (path, project) => {
      calls.push(`saveProject:${path}`);
      saved.push({ path, project });
      return { modifiedAt: new Date().toISOString() };
    });
    const del = vi.spyOn(ipc, "deleteProject").mockImplementation(async (p) => {
      calls.push(`deleteProject:${p}`);
    });
    return { om, calls, saved, save, del };
  }

  it("makes a photo an IMAGE project whose canvas is the photo, in the temp dir", async () => {
    // ODD sides on purpose: the video canvas rule rounds to even (642x362), so
    // a still that slipped down the video path, or an image canvas that picked
    // up the video clamp, fails here rather than passing by coincidence.
    const h = await harness(mediaInfo({ path: "D:\\Pictures\\harbour.jpg", width: 641, height: 361 }));
    const out = await h.om.openMediaAsProject("D:\\Pictures\\harbour.jpg");
    expect(out).toBe(`${TMP}\\harbour (2).trt`);
    expect(h.calls).toEqual([
      "tempProjectPath:harbour",
      "probeMedia:D:\\Pictures\\harbour.jpg",
      `saveProject:${TMP}\\harbour (2).trt`,
    ]);
    const p = h.saved[0]!.project;
    expect(p.kind).toBe("image");
    expect(p.schema).toBe(3);
    expect([p.timeline.width, p.timeline.height]).toEqual([641, 361]);
    // A photo project starts with just the photo, over transparency.
    expect(p.image).toEqual({ background: "transparent" });
    expect(p.name).toBe("harbour (2)");
    expect(p.media).toHaveLength(1);
    expect(p.media[0]!.path).toBe("D:\\Pictures\\harbour.jpg");
    const clips = p.timeline.tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(1);
    // Native pixels: one photo pixel per canvas pixel, centred.
    expect(clips[0]!.transform).toMatchObject({ x: 0, y: 0, scale: 1 });
    expect(clips[0]!.mediaId).toBe(p.media[0]!.id);
  });

  it("never caps or rounds a big photo's canvas", async () => {
    // Past the video canvas cap (8192) on the long side and odd on both: the
    // image canvas is the photo, pixel for pixel.
    const h = await harness(mediaInfo({ width: 12001, height: 3001 }));
    await h.om.openMediaAsProject("D:\\Pictures\\harbour.jpg");
    const p = h.saved[0]!.project;
    expect([p.timeline.width, p.timeline.height]).toEqual([12001, 3001]);
    expect(p.kind).toBe("image");
  });

  it("keeps a video a VIDEO project, shaped exactly as before", async () => {
    // OVERSIZED on purpose: the import clamps each side on its own (8192x3000),
    // while an image project would take 12000x3000 whole — so a video that
    // wandered into the photo branch fails here even before the kind check.
    const h = await harness(
      mediaInfo({ path: "D:\\Clips\\dive.mp4", kind: "video", width: 12000, height: 3000, duration: 12 }),
    );
    await h.om.openMediaAsProject("D:\\Clips\\dive.mp4");
    const p = h.saved[0]!.project;
    expect([p.timeline.width, p.timeline.height]).toEqual([8192, 3000]);
    expect(p.schema).toBe(2);
    // Absent, not undefined: a video .trt must stay byte-identical on disk.
    expect("kind" in p).toBe(false);
    expect("image" in p).toBe(false);
    expect(p.timeline.tracks.flatMap((t) => t.clips)).toHaveLength(1);
  });

  it("keeps an animated GIF a video project", async () => {
    // A GIF is a moving picture: only the still family becomes an image project.
    const h = await harness(
      mediaInfo({ path: "D:\\Clips\\wave.gif", kind: "gif", width: 641, height: 361, duration: 3 }),
    );
    await h.om.openMediaAsProject("D:\\Clips\\wave.gif");
    const p = h.saved[0]!.project;
    expect("kind" in p).toBe(false);
    expect(p.schema).toBe(2);
  });

  it("never makes an image project of a generator, even one tagged as an image", async () => {
    // A probe never returns one; the guard is the same one every other
    // `kind === "image"` test in the tree carries, and it is pinned here.
    const h = await harness(
      mediaInfo({ width: 641, height: 361, generator: { type: "solid", color: "#204080" } }),
    );
    await h.om.openMediaAsProject("D:\\Pictures\\harbour.jpg");
    const p = h.saved[0]!.project;
    expect("kind" in p).toBe(false);
    expect(p.schema).toBe(2);
  });

  it("refuses a photo the probe could not size, and writes nothing", async () => {
    // Its canvas IS the photo: there is no honest size to make one at, and it
    // must not quietly become a video project instead.
    const h = await harness(mediaInfo({ width: undefined, height: 361 }));
    await expect(h.om.openMediaAsProject("D:\\Pictures\\harbour.jpg")).rejects.toThrow(
      "Couldn't read the size of harbour.",
    );
    expect(h.save).not.toHaveBeenCalled();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("writes nothing and deletes nothing when the probe fails", async () => {
    const h = await harness(new Error("not a media file"));
    await expect(h.om.openMediaAsProject("D:\\Pictures\\harbour.jpg")).rejects.toThrow("not a media file");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("rethrows a failed save without deleting a file it never wrote", async () => {
    const h = await harness(mediaInfo({ width: 800, height: 600 }));
    h.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.om.openMediaAsProject("D:\\Pictures\\harbour.jpg")).rejects.toThrow("disk full");
    expect(h.del).not.toHaveBeenCalled();
  });
});

describe("stillSizeProblem", () => {
  // The one size check both ways in share (openMediaAsProject above, Home's
  // "New image" dialog through its photoProblem) — pinned here, at its home.
  function still(over: Partial<MediaInfo>): MediaInfo {
    return {
      path: "D:\\Pictures\\harbour.jpg",
      size: 5_242_880,
      mtimeMs: 1_726_000_000_000,
      kind: "image",
      duration: 0,
      hasAudio: false,
      width: 641,
      height: 361,
      ...over,
    };
  }

  it("passes a sized still", async () => {
    const { om } = await fresh();
    expect(om.stillSizeProblem(still({}))).toBeNull();
    expect(om.stillSizeProblem(still({ width: 1, height: 1 }))).toBeNull();
  });

  // One row per way a side can be unusable, each on ONE side only, so a check
  // that looked at the width alone (or the height alone) fails a row.
  const bad: Array<[label: string, over: Partial<MediaInfo>]> = [
    ["missing width", { width: undefined }],
    ["missing height", { height: undefined }],
    ["zero height", { height: 0 }],
    ["negative width", { width: -641 }],
    ["NaN width", { width: Number.NaN }],
    ["infinite height", { height: Number.POSITIVE_INFINITY }],
  ];
  it.each(bad)("names the photo when the %s", async (_label, over) => {
    const { om } = await fresh();
    expect(om.stillSizeProblem(still(over))).toBe("Couldn't read the size of harbour.");
  });
});
