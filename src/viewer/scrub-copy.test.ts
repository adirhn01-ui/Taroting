// The scrub copy's state machine against fakes: two <video> stand-ins that log
// every src and currentTime assignment, fake timers, a hand-run animation
// frame queue, and an IPC whose answers the test gives. One describe per rule
// of scrub-copy.ts's header; fixture values differ on every axis (the file,
// the copy's path, every pointer position, the job id).

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ScrubPlan } from "../core/ipc";
import { COPY_STALL_MS, SCRUB_DWELL_MS, ScrubCopy, type ScrubJobHandlers } from "./scrub-copy";
import { REST_MS } from "./seek-pacer";

interface FakeVideo {
  paused: boolean;
  seeking: boolean;
  readyState: number;
  currentTime: number;
  hidden: boolean;
  error: { code: number } | null;
  src: string;
  /** "src=…", "t=…", "pause", "play", "load" in order. */
  log: string[];
  fire(type: string): void;
  addEventListener(type: string, fn: () => void): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  pause(): void;
  play(): Promise<void>;
  load(): void;
}

function fakeVideo(): FakeVideo {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, (() => void)[]>();
  let time = 0;
  const v = {
    paused: true,
    seeking: false,
    readyState: 4,
    hidden: false,
    error: null,
    log: [] as string[],
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    pause: () => {
      v.paused = true;
      v.log.push("pause");
    },
    play: () => {
      v.paused = false;
      v.log.push("play");
      return Promise.resolve();
    },
    load: () => void v.log.push("load"),
  } as unknown as FakeVideo;
  Object.defineProperty(v, "src", {
    get: () => attrs.get("src") ?? "",
    set: (s: string) => {
      attrs.set("src", s);
      v.log.push(`src=${s}`);
      v.readyState = 0;
    },
  });
  Object.defineProperty(v, "currentTime", {
    get: () => time,
    set: (t: number) => {
      time = t;
      v.log.push(`t=${t}`);
    },
  });
  return v;
}

const FILE = "D:\\clips\\Replay 2026-10-01 21-09-07.mp4";
const OTHER = "D:\\clips\\Replay 2026-10-02 18-44-51.mp4";
const COPY = "C:\\cache\\scrub\\9a1f07c3e2b4d5a6.scrub1.mp4";
const JOB = 41;

let main: FakeVideo;
let copies: FakeVideo[];
let rafQ: (() => void)[];
let seekMain: Mock<(t: number) => void>;
let plan: Mock<(file: string) => Promise<ScrubPlan>>;
let cancel: Mock<(id: number) => void>;
let listen: Mock<(h: ScrubJobHandlers) => Promise<() => void>>;
let unlisten: Mock<() => void>;
let handlers: ScrubJobHandlers | null;
let s: ScrubCopy;

/** Run `n` rounds of animation frames (callbacks queued during a round wait
 *  for the next). */
function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    const q = rafQ;
    rafQ = [];
    for (const f of q) f();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  main = fakeVideo();
  copies = [];
  rafQ = [];
  handlers = null;
  seekMain = vi.fn((t: number) => {
    main.currentTime = t;
    main.seeking = true;
  });
  plan = vi.fn(async (_file: string): Promise<ScrubPlan> => ({ mode: "pending", jobId: JOB }));
  cancel = vi.fn((_id: number) => {});
  unlisten = vi.fn(() => {});
  listen = vi.fn(async (h: ScrubJobHandlers) => {
    handlers = h;
    return unlisten;
  });
  s = new ScrubCopy({
    main: main as unknown as HTMLVideoElement,
    createCopy: () => {
      const c = fakeVideo();
      c.hidden = true;
      copies.push(c);
      return c as unknown as HTMLVideoElement;
    },
    seekMain,
    plan,
    cancel,
    listen,
    url: (p) => `asset://localhost/${encodeURIComponent(p)}`,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
      now: () => Date.now(),
    },
    raf: (fn) => void rafQ.push(fn),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const copyUrl = `asset://localhost/${encodeURIComponent(COPY)}`;

/** A heavy source whose copy is loaded and ready. */
async function readyCopy(): Promise<FakeVideo> {
  plan.mockResolvedValueOnce({ mode: "ready", path: COPY });
  s.indexed(FILE, true);
  vi.advanceTimersByTime(SCRUB_DWELL_MS);
  await flush();
  const c = copies[0]!;
  c.readyState = 4;
  c.fire("loadeddata");
  expect(s.snapshot().state).toBe("ready");
  c.log.length = 0;
  main.log.length = 0;
  seekMain.mockClear();
  return c;
}

/** Land the copy's seek in flight and present it (two frames). */
function landCopy(c: FakeVideo): void {
  c.seeking = false;
  c.fire("seeked");
  frames(2);
}

describe("1. a light video", () => {
  it("costs nothing: no plan, no listener, no element, no timer, and every move is the viewer's", async () => {
    // The index answering after the press, and before the next one.
    s.press(4.2);
    s.indexed(FILE, false);
    expect(s.move(7.7)).toBe(false);
    s.release();
    s.press(5.9);
    expect(s.move(8.1)).toBe(false);
    s.release();
    vi.advanceTimersByTime(SCRUB_DWELL_MS * 2);
    await flush();
    expect(plan).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(copies).toHaveLength(0);
    expect(seekMain).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.snapshot()).toEqual({ state: "none", shown: false, file: FILE });
  });
});

describe("2. asking for the copy", () => {
  it("asks SCRUB_DWELL_MS after a heavy index answers with no press", async () => {
    s.indexed(FILE, true);
    vi.advanceTimersByTime(SCRUB_DWELL_MS - 1);
    await flush();
    expect(plan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(plan.mock.calls).toEqual([[FILE]]);
    expect(s.snapshot().state).toBe("making");
  });

  it("asks at once when a press came first", async () => {
    s.press(12.5);
    s.indexed(FILE, true);
    await flush();
    expect(plan.mock.calls).toEqual([[FILE]]);
    // Listening started before the plan was asked.
    expect(listen.mock.invocationCallOrder[0]!).toBeLessThan(plan.mock.invocationCallOrder[0]!);
  });

  it("a new source within the dwell asks nothing", async () => {
    s.indexed(FILE, true);
    vi.advanceTimersByTime(SCRUB_DWELL_MS - 200);
    s.reset();
    vi.advanceTimersByTime(SCRUB_DWELL_MS);
    await flush();
    expect(plan).not.toHaveBeenCalled();
  });

  it("a new source cancels the job still running and ignores its end", async () => {
    s.press(1);
    s.indexed(FILE, true);
    await flush();
    const h = handlers!;
    s.reset();
    expect(cancel.mock.calls).toEqual([[JOB]]);
    expect(unlisten).toHaveBeenCalledTimes(1);
    h.done(JOB, COPY);
    expect(copies).toHaveLength(0);
    expect(s.snapshot().state).toBe("none");
  });

  it("a job that ended before the plan named it is still taken", async () => {
    let answer!: (p: ScrubPlan) => void;
    plan.mockReturnValueOnce(new Promise<ScrubPlan>((r) => (answer = r)));
    s.press(1);
    s.indexed(FILE, true);
    await flush();
    handlers!.done(JOB + 6, "C:\\cache\\scrub\\someone else's.mp4");
    handlers!.done(JOB, COPY);
    answer({ mode: "pending", jobId: JOB });
    await flush();
    expect(copies).toHaveLength(1);
    expect(copies[0]!.src).toBe(copyUrl);
  });
});

describe("3. until the copy is ready", () => {
  it("every move is the viewer's own (the pacer's)", async () => {
    s.press(2.25);
    s.indexed(FILE, true);
    await flush();
    expect(s.snapshot().state).toBe("making");
    expect(s.move(9.75)).toBe(false);
    handlers!.done(JOB, COPY);
    // Loaded, not yet decodable: still the viewer's.
    expect(s.move(11.5)).toBe(false);
    expect(copies[0]!.log).toEqual([`src=${copyUrl}`]);
  });
});

describe("4. the ready copy", () => {
  it("is one hidden element holding the copy, made once", async () => {
    const c = await readyCopy();
    expect(copies).toHaveLength(1);
    expect(c.hidden).toBe(true);
    expect(c.src).toBe(copyUrl);
    expect(s.snapshot()).toEqual({ state: "ready", shown: false, file: FILE });
  });
});

describe("5. a drag with the copy ready", () => {
  it("never seeks the main video while moving; the copy has one seek in flight and the newest waits", async () => {
    const c = await readyCopy();
    s.press(5.5);
    expect(s.move(10.25)).toBe(true);
    c.seeking = true;
    expect(s.move(12.75)).toBe(true);
    expect(s.move(14.5)).toBe(true);
    expect(c.log).toEqual(["t=10.25"]);
    c.seeking = false;
    c.fire("seeked");
    // 12.75 was dropped: only the newest went out.
    expect(c.log).toEqual(["t=10.25", "t=14.5"]);
    expect(seekMain).not.toHaveBeenCalled();
    expect(main.log).toEqual([]);
    expect(s.holding()).toBe(true);
  });

  it("pauses a playing main video for the drag and resumes it on release", async () => {
    const c = await readyCopy();
    main.paused = false;
    s.press(6.6);
    s.move(8.8);
    expect(main.log).toEqual(["pause"]);
    expect(s.pausing()).toBe(true);
    landCopy(c);
    s.release();
    // The release's exact seek, then playing on from there.
    expect(main.log).toEqual(["pause", "t=8.8", "play"]);
    expect(s.pausing()).toBe(false);
  });

  it("shows the copy only once a frame of THIS drag is presented", async () => {
    const c = await readyCopy();
    s.press(1.5);
    s.move(20.5);
    c.seeking = true;
    expect(c.hidden).toBe(true);
    c.seeking = false;
    c.fire("seeked");
    frames(1);
    expect(c.hidden).toBe(true);
    frames(1);
    expect(c.hidden).toBe(false);
    expect(s.snapshot().shown).toBe(true);
    s.release();
    // The next drag: the copy still holds the old drag's frame, so it stays
    // hidden until its own seek lands and is presented.
    main.seeking = false;
    s.mainSeeked();
    frames(2);
    expect(c.hidden).toBe(true);
    s.press(31.5);
    s.move(40.75);
    c.seeking = true;
    expect(c.hidden).toBe(true);
    c.seeking = false;
    c.fire("seeked");
    frames(2);
    expect(c.hidden).toBe(false);
  });

  it("a frame presented for an earlier drag never counts for the next", async () => {
    const c = await readyCopy();
    s.press(2.5);
    s.move(7.25);
    c.seeking = false;
    c.fire("seeked");
    frames(1);
    // A new drag before that frame's second animation frame.
    s.release();
    s.press(9.5);
    s.move(15.25);
    c.seeking = true;
    frames(2);
    expect(c.hidden).toBe(true);
  });
});

describe("6. rest and release", () => {
  it("resting REST_MS sends ONE exact seek; the copy hides once the main video presents it", async () => {
    const c = await readyCopy();
    s.press(4.4);
    s.move(17.3);
    landCopy(c);
    expect(c.hidden).toBe(false);
    vi.advanceTimersByTime(REST_MS - 1);
    expect(seekMain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(seekMain.mock.calls).toEqual([[17.3]]);
    // Still decoding: the copy stays up.
    frames(4);
    expect(c.hidden).toBe(false);
    main.seeking = false;
    main.readyState = 2;
    s.mainSeeked();
    frames(1);
    expect(c.hidden).toBe(false);
    frames(1);
    expect(c.hidden).toBe(true);
    // The release after a rest asks nothing more.
    s.release();
    expect(seekMain).toHaveBeenCalledTimes(1);
  });

  it("the release sends one exact seek, and a move before the main frame shows keeps the copy up", async () => {
    const c = await readyCopy();
    s.press(3.1);
    s.move(25.9);
    landCopy(c);
    s.release();
    expect(seekMain.mock.calls).toEqual([[25.9]]);
    main.seeking = false;
    s.mainSeeked();
    frames(2);
    expect(c.hidden).toBe(true);

    // Held still at rest, then a move before the main video's frame shows.
    s.press(26);
    s.move(33.3);
    landCopy(c);
    vi.advanceTimersByTime(REST_MS);
    expect(seekMain.mock.calls).toEqual([[25.9], [33.3]]);
    main.seeking = false;
    s.mainSeeked();
    frames(1);
    s.move(35.7);
    frames(3);
    expect(c.hidden).toBe(false);
    // The rest's seek landing late (canplay) changes nothing while moving.
    s.mainSeeked();
    frames(2);
    expect(c.hidden).toBe(false);
    expect(s.holding()).toBe(true);
  });
});

describe("7. a click", () => {
  it("never shows the copy, seeks it, or seeks the main video", async () => {
    const c = await readyCopy();
    s.press(44.4);
    s.release();
    frames(3);
    expect(c.hidden).toBe(true);
    expect(c.log).toEqual([]);
    expect(seekMain).not.toHaveBeenCalled();
    expect(s.copySeeks).toBe(0);
  });
});

describe("8. failures fall back for the rest of the session", () => {
  it("a failed job: failed with its reason, every move the viewer's, the file never asked again", async () => {
    s.press(1);
    s.indexed(FILE, true);
    await flush();
    handlers!.failed(JOB, "ffmpeg exited with exit code: 1");
    expect(s.snapshot()).toEqual({ state: "failed", shown: false, file: FILE, reason: "the copy job failed: ffmpeg exited with exit code: 1" });
    expect(s.move(5)).toBe(false);
    // Stepping away and back to the same file: not asked again.
    s.reset();
    s.indexed(OTHER, true);
    vi.advanceTimersByTime(SCRUB_DWELL_MS);
    await flush();
    s.reset();
    s.press(2);
    s.indexed(FILE, true);
    await flush();
    expect(plan.mock.calls).toEqual([[FILE], [OTHER]]);
    expect(s.snapshot().state).toBe("failed");
  });

  it("the copy element's error: failed, its src dropped, the job not touched", async () => {
    const c = await readyCopy();
    c.error = { code: 3 };
    c.fire("error");
    expect(s.snapshot().state).toBe("failed");
    expect(s.snapshot().reason).toBe("the copy would not play (media error 3)");
    expect(c.hasAttribute("src")).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a stalled copy seek mid-drag: failed, and the main video goes to the pointer once", async () => {
    const c = await readyCopy();
    s.press(8.5);
    s.move(21.75);
    c.seeking = true;
    // The hand keeps moving (never resting), and the copy's seek never lands.
    let at = 21.75;
    for (let waited = 0; waited < COPY_STALL_MS; waited += REST_MS - 10) {
      vi.advanceTimersByTime(REST_MS - 10);
      if (s.snapshot().state !== "ready") break;
      at += 0.37;
      s.move(at);
    }
    expect(s.snapshot().state).toBe("failed");
    expect(seekMain.mock.calls).toEqual([[at]]);
    expect(c.hidden).toBe(true);
    expect(s.move(23)).toBe(false);
    s.release();
    expect(seekMain).toHaveBeenCalledTimes(1);
  });

  it("no copy for the file (unavailable): failed with the backend's reason", async () => {
    plan.mockResolvedValueOnce({ mode: "unavailable", reason: "not a video (audio)" });
    s.press(1);
    s.indexed(FILE, true);
    await flush();
    expect(s.snapshot()).toEqual({ state: "failed", shown: false, file: FILE, reason: "no copy: not a video (audio)" });
    expect(copies).toHaveLength(0);
  });
});
