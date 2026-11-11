// The heavy-clip seek pacer against a fake <video> and a hand-driven clock.
// Keyframes every 4.17 s (the owner's 69 Mbps OBS clip), so a keyframe time
// never equals a cursor time or an exact target in these tests.

import { describe, expect, it } from "vitest";
import type { KeyframeIndex } from "../core/ipc";
import { HEAVY_BITS_PER_S, HEAVY_GAP_S, MIN_SPEED_SPAN_MS, REST_MS, SeekPacer, heavyGap, nearestKeyframe } from "./seek-pacer";

const KEYS = [0, 4.17, 8.34, 12.51, 16.68];

/** A 69 Mbps, 4.17 s GOP index over `duration` seconds. */
function index(over: Partial<KeyframeIndex> = {}): KeyframeIndex {
  const duration = over.duration ?? 20.85;
  return { allSync: false, times: KEYS, duration, bytes: Math.round((duration * 69_000_000) / 8), ...over };
}

/** A <video> whose seeks go in flight on assignment (as Chromium's do) and
 *  land when the test says, plus a clock and timers the test moves. */
function rig() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  let time = 0;
  const el = {
    seeking: false,
    get currentTime() {
      return time;
    },
    set currentTime(v: number) {
      time = v;
      el.seeking = true;
      log.push(`t=${v}`);
    },
  };
  const pacer = new SeekPacer(el as unknown as HTMLVideoElement, {
    tolerance: 0.01,
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id) => {
        if (id !== undefined) timers.delete(id);
      },
      now: () => now,
    },
  });
  pacer.setIndex(index());
  /** Move the clock on, running the timers that come due. */
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  /** The seek in flight lands. */
  const land = (): void => {
    el.seeking = false;
    pacer.seeked();
  };
  /** Playback moves the element's time on: no seek, nothing logged. */
  const play = (t: number): void => {
    time = t;
  };
  return { pacer, el, log, advance, land, play, timers };
}

describe("which file is heavy", () => {
  it("a long keyframe gap at a high bit rate is heavy", () => {
    expect(heavyGap(index())).toBeCloseTo(4.17, 9);
  });

  it("the same gap at a low bit rate is light (direct_h264.mp4: 8.3 s gaps, a few Mbps)", () => {
    expect(heavyGap(index({ bytes: Math.round((20.85 * 3_000_000) / 8) }))).toBeNull();
  });

  it("a short gap at a high bit rate is light", () => {
    expect(heavyGap(index({ times: [0, 0.5, 1, 1.5, 2, 2.5] }))).toBeNull();
  });

  it("an all-keyframe file, a single keyframe, an unknown length or no index is light", () => {
    expect(heavyGap(index({ allSync: true }))).toBeNull();
    expect(heavyGap(index({ times: [0] }))).toBeNull();
    expect(heavyGap(index({ duration: 0 }))).toBeNull();
    expect(heavyGap(null)).toBeNull();
  });

  it("a median gap of exactly HEAVY_GAP_S is heavy", () => {
    expect(heavyGap(index({ times: [0, HEAVY_GAP_S, 2 * HEAVY_GAP_S] }))).toBe(HEAVY_GAP_S);
  });

  it("a median gap just under HEAVY_GAP_S is light", () => {
    const g = HEAVY_GAP_S - 0.01;
    expect(heavyGap(index({ times: [0, g, 2 * g] }))).toBeNull();
  });

  it("a bit rate of exactly HEAVY_BITS_PER_S is heavy", () => {
    // Over 16 s (a power of two) the rate comes back exact in floats.
    expect(heavyGap(index({ duration: 16, bytes: (HEAVY_BITS_PER_S * 16) / 8 }))).toBeCloseTo(4.17, 9);
  });

  it("a bit rate just under HEAVY_BITS_PER_S is light", () => {
    expect(heavyGap(index({ duration: 16, bytes: (HEAVY_BITS_PER_S * 16) / 8 - 1 }))).toBeNull();
  });

  it("the E2E's fixture, direct_h264.mp4, is light on its real numbers", () => {
    // 30 s, keyframes at 0, 8.33, 16.67 and 25 s, 10 740 200 bytes on disk
    // (tests/fixtures): ~2.9 Mbit/s. Its gap alone would call it heavy.
    expect(heavyGap({ allSync: false, times: [0, 8.33, 16.67, 25], duration: 30, bytes: 10_740_200 })).toBeNull();
  });

  it("finds the nearest keyframe on either side", () => {
    expect(nearestKeyframe(KEYS, 7.9)).toBe(8.34);
    expect(nearestKeyframe(KEYS, 5.0)).toBe(4.17);
    expect(nearestKeyframe(KEYS, 99)).toBe(16.68);
    expect(nearestKeyframe(KEYS, -1)).toBe(0);
  });
});

describe("a heavy file's drag", () => {
  it("a fast move asks the keyframe NEAREST the cursor, not the one before it", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(50);
    r.pacer.move(7.9);
    expect(r.log).toEqual(["t=8.34"]);
  });

  it("a slow move asks the exact time", () => {
    const r = rig();
    r.pacer.begin(2);
    r.advance(100);
    r.pacer.move(2.3);
    expect(r.log).toEqual(["t=2.3"]);
  });

  it("keeps one keyframe seek in flight: the newest waits, a stale waiting one is dropped", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(4.0);
    r.advance(20);
    r.pacer.move(8.0);
    r.advance(20);
    r.pacer.move(12.3);
    expect(r.log).toEqual(["t=4.17"]);
    r.land();
    expect(r.log).toEqual(["t=4.17", "t=12.51"]);
  });

  it("sends a keyframe at once while an exact seek is in flight", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(100);
    r.pacer.move(1.2);
    r.advance(40);
    r.pacer.move(9.0);
    expect(r.log).toEqual(["t=1.2", "t=8.34"]);
  });

  it("asks nothing for the keyframe already on screen", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(7.9);
    r.land();
    r.advance(20);
    r.pacer.move(9.1);
    expect(r.log).toEqual(["t=8.34"]);
  });

  it("gives a pointer that rests its exact frame", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(7.9);
    r.land();
    r.advance(REST_MS - 1);
    expect(r.log).toEqual(["t=8.34"]);
    r.advance(1);
    expect(r.log).toEqual(["t=8.34", "t=7.9"]);
  });

  it("a release seeks exactly to where the pointer let go, and a waiting keyframe never goes", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(7.9);
    r.advance(20);
    r.pacer.move(11.0);
    r.pacer.release();
    r.land();
    expect(r.log).toEqual(["t=8.34", "t=11"]);
    expect(r.pacer.holding()).toBe(false);
  });

  it("a release after the rest's exact seek asks nothing more", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(7.9);
    r.land();
    r.advance(REST_MS);
    r.pacer.release();
    expect(r.log).toEqual(["t=8.34", "t=7.9"]);
  });

  it("a reset forgets a waiting keyframe and the index, and stops the rest timer", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(4.0);
    r.advance(20);
    r.pacer.move(12.3);
    r.pacer.reset();
    expect(r.timers.size).toBe(0);
    r.land();
    r.advance(REST_MS * 2);
    expect(r.log).toEqual(["t=4.17"]);
    expect([r.pacer.heavy(), r.pacer.holding()]).toEqual([false, false]);
  });

  it("a wobble right after the press is exact; the same motion past MIN_SPEED_SPAN_MS lands on a keyframe", () => {
    // 0.1 s per 8 ms = 12.5 s/s, three times one 4.17 s gap per second.
    expect(MIN_SPEED_SPAN_MS).toBe(30);
    const r = rig();
    r.pacer.begin(1);
    for (const t of [1.1, 1.2, 1.3, 1.4]) {
      r.advance(8);
      r.pacer.move(t);
    }
    // 8, 16 and 24 ms of samples: exact. 32 ms: fast, keyframe 0.
    expect(r.log).toEqual(["t=1.1", "t=1.2", "t=1.3", "t=0"]);
  });

  it("a seek it did not issue landing over its keyframe leaves that keyframe to be asked again", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(4.0);
    // A key press's seek supersedes keyframe 4.17 and lands at 6.
    r.el.currentTime = 6;
    r.land();
    r.advance(20);
    r.pacer.move(4.3);
    expect(r.log).toEqual(["t=4.17", "t=6", "t=4.17"]);
  });

  it("a press forgets the keyframe still in flight from the drag before", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(4.17);
    // Released on the keyframe itself: no exact seek, keyframe 4.17 still in flight.
    r.pacer.release();
    // The next press: the viewer seeks to 9 itself.
    r.el.currentTime = 9;
    r.pacer.begin(9);
    r.advance(40);
    r.pacer.move(4.0);
    expect(r.log).toEqual(["t=4.17", "t=9", "t=4.17"]);
  });

  it("held still once its exact frame has landed, the drag lets go: playback moves on and the release asks nothing", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(7.9);
    r.land();
    r.advance(REST_MS);
    r.land();
    expect(r.pacer.holding()).toBe(false);
    r.play(8.65);
    r.pacer.release();
    expect(r.log).toEqual(["t=8.34", "t=7.9"]);
  });

  it("a move after the still pointer's exact frame landed is a drag again", () => {
    const r = rig();
    r.pacer.begin(1);
    r.advance(40);
    r.pacer.move(7.9);
    r.land();
    r.advance(REST_MS);
    r.land();
    r.advance(40);
    r.pacer.move(12.3);
    expect(r.pacer.holding()).toBe(true);
    expect(r.log).toEqual(["t=8.34", "t=7.9", "t=12.51"]);
  });
});

describe("the editor", () => {
  it("never imports the viewer's seek pacer", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../editor", import.meta.url));
    const files = readdirSync(root, { recursive: true })
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
      .map((f) => resolve(root, f));
    // The scan read a real tree, not an empty or missing folder.
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => /seek-pacer/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
