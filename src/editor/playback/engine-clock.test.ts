// The engine's clock across real ticks: the real PlaybackEngine and Scheduler
// against the fakes in test-fakes.ts, with requestAnimationFrame and
// performance.now under the test's control and every fake <video> decoding at
// its own playbackRate between frames.
//
// Covered here:
//  - a master element that ends short of its clip's out-point no longer
//    freezes the transport (C98);
//  - a preview-speed change mid-playback no longer seeks the master backwards
//    to the last tick's time (C99);
//  - a preloaded element is actually used after a still, after a long gap,
//    and across a loop restart (C97).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaRef } from "../../core/types";
import type { MediaState } from "../media/media";
import { PlaybackEngine } from "./engine";
import { Scheduler } from "./scheduler";
import {
  clipOf,
  fakeMedia,
  fakeStage,
  manualFrames,
  projectOf,
  readyStatus,
  shownVideo,
  videoMedia,
  type FakeVideo,
} from "./test-fakes";

const FRAME = 1 / 60;

let frames: ReturnType<typeof manualFrames>;
beforeEach(() => {
  frames = manualFrames();
});
afterEach(() => {
  frames.restore();
});

function ready(...media: MediaRef[]): Record<string, MediaState> {
  const out: Record<string, MediaState> = {};
  for (const m of media) out[m.id] = readyStatus(m);
  return out;
}

function solid(id: string): MediaRef {
  return {
    id, path: "", size: 0, mtimeMs: 0, kind: "image", duration: 5,
    width: 1280, height: 720, hasAudio: false, generator: { type: "solid", color: "#204060" },
  };
}

function rig(project: ReturnType<typeof projectOf>, statuses: Record<string, MediaState>) {
  const stage = fakeStage();
  const sched = new Scheduler(stage, () => project, fakeMedia(statuses));
  const engine = new PlaybackEngine(() => project, sched);
  const elements = (): FakeVideo[] => stage.sets.flatMap((s) => [s.a, s.b]);
  /** Deliver frames for `seconds`, every element decoding in between. */
  const run = (seconds: number, each?: () => void): void => {
    const n = Math.round(seconds / FRAME);
    for (let i = 0; i < n; i++) {
      frames.frame(FRAME, (dt) => {
        for (const el of elements()) el.advance(dt);
      });
      each?.();
    }
  };
  return { stage, sched, engine, elements, run };
}

/** How many times `url` was assigned to any element. */
function loads(elements: FakeVideo[], url: string): number {
  return elements.reduce((n, el) => n + el.srcLog.filter((e) => e.url === url).length, 0);
}

/* ------------------------------------------------------------------ */
/* C98                                                                */
/* ------------------------------------------------------------------ */

describe("a master element that ends before its clip's out-point", () => {
  it("does not freeze the transport: the wall clock carries it to the cut", () => {
    // V1 on [0, 3] reads source [1, 4] — but its file really ends at 3.5 (a
    // remux shorter than the probed duration), half a second short of srcOut.
    const a = videoMedia("short", 4);
    const b = videoMedia("after", 20);
    const v1 = clipOf(a, 0, 1, 4, 1);
    const v2 = clipOf(b, 3, 6, 8, 1);
    const { stage, engine, run } = rig(projectOf([a, b], [[v1, v2]]), ready(a, b));
    stage.syncLayerCount(1);
    stage.sets[0]!.a.endAt = 3.5;
    engine.seek(2);
    engine.play();
    run(1.5);
    expect(stage.sets[0]!.a.ended).toBe(true);
    expect(engine.playing).toBe(true);
    // past the cut, playing V2
    expect(engine.time).toBeGreaterThan(3.2);
    expect(shownVideo(stage.sets[0]!)?.src).toBe(`url:${b.path}`);
  });

  it("does not freeze at the end of the timeline either", () => {
    const a = videoMedia("last", 4);
    const v1 = clipOf(a, 0.5, 0.25, 3.25, 1.5);
    const { stage, engine, run } = rig(projectOf([a], [[v1]]), ready(a));
    stage.syncLayerCount(1);
    stage.sets[0]!.a.endAt = 2.8;
    engine.seek(1.5);
    engine.play();
    run(2);
    expect(engine.playing).toBe(false);
    expect(engine.time).toBeCloseTo(engine.duration(), 9);
  });
});

/* ------------------------------------------------------------------ */
/* C99                                                                */
/* ------------------------------------------------------------------ */

describe("setPreviewSpeed during playback", () => {
  it("does not seek the master back to the last tick's time", () => {
    // V1 on [1.5, 9.5], srcIn 4, speed 1.5: 12 ms of timeline is 18 ms of
    // source, over activate()'s 10 ms seek threshold.
    const a = videoMedia("speedy", 40);
    const v1 = clipOf(a, 1.5, 4, 16, 1.5);
    const { stage, engine } = rig(projectOf([a], [[v1]]), ready(a));
    engine.seek(3);
    engine.play();
    const el = stage.sets[0]!.a;
    expect(el.currentTime).toBeCloseTo(6.25, 9);
    const seeks = el.seeks;
    // 12 ms pass before the next frame, and the user changes speed then
    frames.idle(0.012);
    el.advance(0.012);
    engine.setPreviewSpeed(2);
    expect(el.seeks).toBe(seeks);
    expect(engine.time).toBeCloseTo(3.012, 9);
    expect(el.playbackRate).toBeCloseTo(3, 12);
  });

  it("carries the wall clock forward when no video is the clock", () => {
    // a gap until 4: the engine's own clock is the time, and the stale tick
    // snapshot must not rewind it on re-anchoring
    const a = videoMedia("later", 40);
    const { engine } = rig(projectOf([a], [[clipOf(a, 4, 0, 4, 1)]]), ready(a));
    engine.seek(1);
    engine.play();
    frames.idle(0.012);
    engine.setPreviewSpeed(2);
    expect(engine.time).toBeCloseTo(1.012, 9);
  });

  it("leaves a paused playhead exactly where it is", () => {
    const a = videoMedia("paused", 40);
    const { engine } = rig(projectOf([a], [[clipOf(a, 1.5, 4, 16, 1.5)]]), ready(a));
    engine.seek(3);
    frames.idle(0.5);
    engine.setPreviewSpeed(2);
    expect(engine.time).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* C97                                                                */
/* ------------------------------------------------------------------ */

describe("the A/B preload is used, not thrown away", () => {
  /** Play until the playhead first reaches `at`; returns the clock at that
   *  frame — the one on which the clip starting at `at` was activated. */
  function playTo(engine: PlaybackEngine, run: (s: number, each?: () => void) => void, at: number): number {
    let reached = -1;
    run(at + 0.25, () => {
      if (reached < 0 && engine.time >= at) reached = frames.now();
    });
    expect(reached).toBeGreaterThan(0);
    return reached;
  }

  /** On frame `when` nothing was loaded and nothing was seeked. */
  function expectNothingAt(elements: FakeVideo[], when: number): void {
    for (const el of elements) {
      expect(el.srcLog.filter((e) => e.at === when)).toEqual([]);
      expect(el.seekLog.filter((at) => at === when)).toEqual([]);
    }
  }

  it("after a still: the next video plays from the element preloaded for it", () => {
    const a = videoMedia("first", 10);
    const b = videoMedia("second", 10);
    const s = solid("m-solid");
    const project = projectOf([a, b, s], [[clipOf(a, 0, 0.5, 2.5, 1), clipOf(s, 2, 0, 5, 1), clipOf(b, 7, 3, 5, 1)]]);
    const { stage, engine, elements, run } = rig(project, ready(a, b));
    engine.play();
    const started = playTo(engine, run, 7);
    expect(shownVideo(stage.sets[0]!)!.src).toBe(`url:${b.path}`);
    // loaded once, by the preload; the frame the clip started on neither
    // reloaded nor re-seeked anything
    expect(loads(elements(), `url:${b.path}`)).toBe(1);
    expectNothingAt(elements(), started);
  });

  it("after a gap longer than the preload window", () => {
    const a = videoMedia("first", 10);
    const b = videoMedia("second", 10);
    const project = projectOf([a, b], [[clipOf(a, 0, 0.5, 2.5, 1), clipOf(b, 5, 3, 5, 1)]]);
    const { stage, engine, elements, run } = rig(project, ready(a, b));
    engine.play();
    const started = playTo(engine, run, 5);
    expect(shownVideo(stage.sets[0]!)!.src).toBe(`url:${b.path}`);
    expect(loads(elements(), `url:${b.path}`)).toBe(1);
    expectNothingAt(elements(), started);
  });

  /** Play a looping project until the playhead wraps; returns the clock at
   *  the frame the restart happened on. */
  function playToWrap(engine: PlaybackEngine, run: (s: number, each?: () => void) => void): number {
    let wrapAt = -1;
    let last = engine.time;
    run(engine.duration() + 0.5, () => {
      if (wrapAt < 0 && engine.time < last) wrapAt = frames.now();
      last = engine.time;
    });
    expect(wrapAt).toBeGreaterThan(0);
    return wrapAt;
  }

  it("across a loop restart of a one-clip timeline", () => {
    const a = videoMedia("only", 10);
    const v1 = clipOf(a, 0, 1, 3, 1);
    const { stage, engine, elements, run } = rig(projectOf([a], [[v1]]), ready(a));
    engine.loop = true;
    engine.play();
    const wrapAt = playToWrap(engine, run);
    expect(shownVideo(stage.sets[0]!)!.src).toBe(`url:${a.path}`);
    // the element that plays clip 1 again was loaded and parked on srcIn
    // ahead of time
    expectNothingAt(elements(), wrapAt);
    // the A/B pair: one load per slot, never a third
    expect(loads(elements(), `url:${a.path}`)).toBe(2);
  });

  it("across a loop restart of a three-clip timeline", () => {
    const a = videoMedia("one", 10);
    const b = videoMedia("two", 10);
    const c = videoMedia("three", 10);
    const project = projectOf(
      [a, b, c],
      [[clipOf(a, 0, 1, 3, 1), clipOf(b, 2, 0.5, 2.5, 1), clipOf(c, 4, 2, 4, 1)]],
    );
    const { stage, engine, elements, run } = rig(project, ready(a, b, c));
    engine.loop = true;
    engine.play();
    const wrapAt = playToWrap(engine, run);
    expect(shownVideo(stage.sets[0]!)!.src).toBe(`url:${a.path}`);
    // the element that plays clip 1 again was loaded and parked on srcIn
    // ahead of time
    expectNothingAt(elements(), wrapAt);
  });
});
