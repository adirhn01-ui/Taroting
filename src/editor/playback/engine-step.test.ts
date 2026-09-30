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
import { PlaybackEngine } from "./engine";
import type { Scheduler } from "./scheduler";

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
