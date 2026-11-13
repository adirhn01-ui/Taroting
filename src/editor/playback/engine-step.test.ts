// Frame-step chaining at the timeline's ends (PlaybackEngine.stepFrames).
//
// stepFrames remembers the last COMMANDED frame so rapid stepping lands
// exactly, and seekInternal clamps the playhead to [0, duration]. The bug: the
// remembered frame kept counting past either end while the playhead stayed
// pinned, so the opposite arrow key then did nothing for as many presses as
// the user had over-stepped. A clamped step now re-bases the chain onto the
// frame the playhead actually sits on.

import { describe, expect, it } from "vitest";
import { addMedia, createProject, insertClip, makeClip } from "../../core/project";
import { frameCenter, frameOf, rat } from "../../core/time";
import type { MediaInfo, ProjectFile } from "../../core/types";
import type { MediaRef } from "../../core/types";
import { PlaybackEngine } from "./engine";
import { Scheduler } from "./scheduler";
import { clipOf, fakeMedia, fakePacingDeps, fakeStage, manualFrames, projectOf, readyStatus, videoMedia } from "./test-fakes";

/** 1 s clip at 30 fps: frames 0..29, duration exactly 1. */
function project(): ProjectFile {
  const info: MediaInfo = {
    path: "C:\\media\\clip.mp4",
    size: 1,
    mtimeMs: 1,
    kind: "video",
    duration: 1,
    fps: rat(30),
    width: 640,
    height: 360,
    hasAudio: false,
  };
  let p = createProject("Step");
  const added = addMedia(p, info);
  p = added.project;
  return insertClip(p, p.timeline.tracks[0]!.id, makeClip(added.media, 0));
}

/** The engine only needs activate() and animate() for a paused seek. */
function engine(): PlaybackEngine {
  const p = project();
  const scheduler = {
    activate: () => ({ boundary: Infinity }),
    animate: () => {},
  } as unknown as Scheduler;
  return new PlaybackEngine(() => p, scheduler);
}

const FPS = rat(30);

describe("stepFrames — the chain re-bases when a step is clamped", () => {
  it("the first step back after over-stepping the end moves the playhead", () => {
    const e = engine();
    const dur = e.duration();
    expect(dur).toBeCloseTo(1, 9);
    e.seek(dur);
    for (let i = 0; i < 5; i++) e.stepFrames(1);
    expect(e.time).toBe(dur);
    e.stepFrames(-1);
    // one frame back from the end: the last real frame's centre
    expect(e.time).toBeCloseTo(frameCenter(frameOf(dur, FPS) - 1, FPS), 9);
    expect(e.time).toBeLessThan(dur);
  });

  it("the first step forward after over-stepping the start moves the playhead", () => {
    const e = engine();
    e.seek(0);
    for (let i = 0; i < 5; i++) e.stepFrames(-1);
    expect(e.time).toBe(0);
    e.stepFrames(1);
    expect(e.time).toBeCloseTo(frameCenter(1, FPS), 9);
  });

  // A guard, not a pin of the boundary fix: in-range stepping must stay exact.
  it("in-range steps still chain exactly on the commanded frame", () => {
    const e = engine();
    e.seek(0);
    e.stepFrames(3);
    e.stepFrames(4);
    e.stepFrames(-2);
    expect(e.time).toBeCloseTo(frameCenter(5, FPS), 9);
  });
});

/* ------------------------------------------------------------------ */
/* which seeks the scheduler may pace                                  */
/* ------------------------------------------------------------------ */

describe("activate's seek flag: only a non-step seek may be paced", () => {
  function spy(): { e: PlaybackEngine; flags: Array<boolean | undefined>; frames: ReturnType<typeof manualFrames> } {
    const p = project();
    const flags: Array<boolean | undefined> = [];
    const scheduler = {
      activate: (_t: number, _playing: boolean, seek?: boolean) => {
        flags.push(seek);
        return { boundary: 0.5 };
      },
      animate: () => {},
      pauseAll: () => {},
      masterClockTime: () => null,
      advanceBoundary: () => {},
      syncSlaves: () => {},
      preload: () => {},
      dispose: () => {},
      previewSpeed: 1,
    } as unknown as Scheduler;
    const frames = manualFrames();
    return { e: new PlaybackEngine(() => p, scheduler), flags, frames };
  }

  it("seek, jumpSeconds and stop pass true; stepFrames false; the rest nothing", () => {
    const { e, flags, frames } = spy();
    try {
      e.seek(0.2);
      expect(flags.splice(0)).toEqual([true]);
      e.jumpSeconds(0.1);
      expect(flags.splice(0)).toEqual([true]);
      e.stepFrames(1);
      expect(flags.splice(0)).toEqual([false]);
      e.refresh();
      e.setPreviewSpeed(2);
      expect(flags.splice(0)).toEqual([undefined]);
      e.play();
      expect(flags.splice(0)).toEqual([undefined]);
      e.setPreviewSpeed(1);
      // the ticker: a boundary at 0.5, then the end of the timeline
      frames.frame(0.3);
      frames.frame(0.3);
      frames.frame(0.6);
      expect(flags.length).toBeGreaterThan(0);
      expect(flags.every((f) => f === undefined)).toBe(true);
      flags.length = 0;
      e.loop = true;
      e.play();
      frames.frame(2);
      e.pause();
      expect(flags.every((f) => f === undefined)).toBe(true);
      flags.length = 0;
      e.stop();
      expect(flags).toEqual([true]);
    } finally {
      e.dispose();
      frames.restore();
    }
  });

  it("a frame-step burst under a pointer move writes what it writes with pacing off", async () => {
    const run = async (disabled: boolean): Promise<string[]> => {
      const frames = manualFrames();
      const a = { ...videoMedia("heavy", 40), size: 150_000_000 } as MediaRef;
      const project = projectOf([a], [[clipOf(a, 0, 1.5, 21.5, 2)]]);
      const stage = fakeStage();
      const pd = fakePacingDeps(() => frames.now());
      const sched = new Scheduler(stage, () => project, fakeMedia({ [a.id]: readyStatus(a) }), pd.deps);
      // every seek stays in flight, so a paced step would queue instead of writing
      for (const v of [stage.sets[0]!.a, stage.sets[0]!.b]) v.latencyFor = () => 0.8;
      const dev = sched.pacingDev();
      dev.disabled = disabled;
      dev.forceHeavy = true;
      pd.answers.set(a.path, { allSync: false, times: [0, 2.5, 5, 7.5, 10], duration: 40, bytes: 150_000_000 });
      const e = new PlaybackEngine(() => project, sched);
      try {
        e.seek(1);
        pd.kind = "press";
        e.seek(1);
        await pd.flush();
        pd.kind = "move";
        for (let i = 0; i < 12; i++) e.stepFrames(1);
        pd.kind = "none";
        return [...stage.sets[0]!.a.writes];
      } finally {
        e.dispose();
        frames.restore();
      }
    };
    const off = await run(true);
    const on = await run(false);
    expect(on.filter((w) => w.startsWith("t:")).length).toBeGreaterThan(10);
    expect(on).toEqual(off);
  });
});
