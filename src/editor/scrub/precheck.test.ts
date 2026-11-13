// The scrub copy's pure half: the free bit-rate pre-check and the per-layer
// target under the playhead. Fixture values differ on every axis the code
// could confuse (clip start, trim, speed, the played file against the
// recorded path), so each expectation fails for one reason.

import { describe, expect, it } from "vitest";
import { HEAVY_BITS_PER_S } from "../../core/heavy-clip";
import type { Clip, MediaRef, ProjectFile, Track } from "../../core/types";
import type { DamageState, MediaState } from "../media/media";
import type { VisibleClip } from "../playback/scheduler";
import { COPY_BYTES_PER_S, SAME_POSITION_S, copyBudgetBytes, copyFits, isCandidate, layerTargets, liveFiles, restTolerance } from "./precheck";

const MBIT = 1_000_000;

/** A video MediaRef of `mbps` Mbit/s over `duration` s. */
function video(id: string, mbps: number, duration = 65, path = `D:\\clips\\${id}.mp4`): MediaRef {
  return {
    id,
    path,
    size: Math.round((mbps * MBIT * duration) / 8),
    mtimeMs: 1,
    kind: "video",
    duration,
    hasAudio: true,
  };
}

const clip = (id: string, mediaId: string, timelineStart: number, srcIn: number, speed: number): Clip => ({
  id,
  mediaId,
  timelineStart,
  srcIn,
  srcOut: srcIn + 30,
  speed,
  audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
});

const track = (id: string, clips: Clip[]): Track => ({ id, kind: "video", name: id, muted: false, clips });

function project(media: MediaRef[], tracks: Track[]): ProjectFile {
  return {
    schema: 2,
    name: "p",
    media,
    timeline: { width: 1600, height: 900, fps: { num: 30, den: 1 }, tracks, markers: [] },
  } as unknown as ProjectFile;
}

const ready = (sourcePath: string): MediaState => ({ state: "ready", url: `asset://${sourcePath}`, sourcePath });

describe("isCandidate", () => {
  const rows: Array<[string, MediaRef, boolean, boolean]> = [
    ["63 Mbit/s 65 s video", video("a", 63), false, true],
    ["19.9 Mbit/s video", video("b", 19.9), false, false],
    ["63 Mbit/s audio", { ...video("c", 63), kind: "audio" }, false, false],
    ["generator", { ...video("d", 63), generator: { type: "solid", color: "#ff0000" } } as MediaRef, false, false],
    ["duration 0", { ...video("e", 63), duration: 0 }, false, false],
    ["forceHeavy at 1 Mbit/s", video("f", 1), true, true],
  ];
  for (const [name, m, force, want] of rows) {
    it(name, () => {
      expect(isCandidate(m, force)).toBe(want);
    });
  }

  it("sits exactly at the shared threshold", () => {
    const at: MediaRef = { ...video("g", 1), size: HEAVY_BITS_PER_S / 8, duration: 1 };
    expect(isCandidate(at, false)).toBe(true);
    expect(isCandidate({ ...at, size: at.size - 1 }, false)).toBe(false);
  });

  it("force never makes audio or a still a candidate", () => {
    expect(isCandidate({ ...video("h", 1), kind: "audio" }, true)).toBe(false);
    expect(isCandidate({ ...video("i", 1), kind: "image" }, true)).toBe(false);
  });
});

describe("layerTargets", () => {
  const top = video("top", 63, 65, "D:\\clips\\top.mp4");
  const bottom = video("bottom", 70, 90, "D:\\clips\\bottom.mov");
  const topClip = clip("c-top", "top", 0.7, 1.3, 1.5);
  const bottomClip = clip("c-bottom", "bottom", 0, 0.4, 1);
  const tTop = track("t-top", [topClip]);
  const tBottom = track("t-bottom", [bottomClip]);
  const p = project([top, bottom], [tTop, { id: "t-audio", kind: "audio", name: "a", muted: false, clips: [] }, tBottom]);
  const visible: VisibleClip[] = [
    { clip: topClip, track: tTop, media: top },
    { clip: bottomClip, track: tBottom, media: bottom },
  ];
  // The played file of the bottom media is a re-packed copy, not its path.
  const statuses: Record<string, MediaState> = {
    top: ready("D:\\clips\\top.mp4"),
    bottom: ready("C:\\cache\\remux\\bottom.emux1.mp4"),
  };

  it("maps each visible clip to its layer with the scheduler's source time and the PLAYED file", () => {
    const out = layerTargets(p, statuses, {}, visible, 2.0, false);
    expect(out).toHaveLength(2);
    expect(out[0]!.layer).toBe(0);
    expect(out[0]!.srcT).toBeCloseTo(3.25, 9);
    expect(out[0]!.file).toBe("D:\\clips\\top.mp4");
    expect(out[1]!.layer).toBe(1);
    expect(out[1]!.srcT).toBeCloseTo(2.4, 9);
    expect(out[1]!.file).toBe("C:\\cache\\remux\\bottom.emux1.mp4");
    expect(out[1]!.url).toBe("asset://C:\\cache\\remux\\bottom.emux1.mp4");
  });

  it("I8: srcIn 3.2, start 5.0, speed 1.5 at t 7.0 is 6.2 (not t, t - start or t * speed)", () => {
    const a = clip("c-a", "top", 5.0, 3.2, 1.5);
    const b = clip("c-b", "bottom", 1.1, 0.4, 0.5);
    const pa = project([top, bottom], [track("ta", [a]), track("tb", [b])]);
    const out = layerTargets(
      pa,
      statuses,
      {},
      [
        { clip: a, track: pa.timeline.tracks[0]!, media: top },
        { clip: b, track: pa.timeline.tracks[1]!, media: bottom },
      ],
      7.0,
      false,
    );
    expect(out[0]!.srcT).toBeCloseTo(6.2, 9);
    expect(out[1]!.srcT).toBeCloseTo(3.35, 9);
  });

  it("leaves out a damaged-not-recovered media and a media not ready", () => {
    const repairing: Record<string, DamageState> = { top: { until: 3, phase: "repairing", ratio: 0.4 } };
    const out = layerTargets(p, statuses, repairing, visible, 2.0, false);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
    const recovered: Record<string, DamageState> = { top: { until: 3, phase: "recovered", ratio: null } };
    expect(layerTargets(p, statuses, recovered, visible, 2.0, false)[0]).not.toBeNull();
    const notReady = { ...statuses, bottom: { state: "preparing", ratio: 0.2, jobId: 4 } as MediaState };
    const out2 = layerTargets(p, notReady, {}, visible, 2.0, false);
    expect(out2[0]).not.toBeNull();
    expect(out2[1]).toBeNull();
  });

  it("leaves out a light media unless forced", () => {
    const light = video("light", 5);
    const lc = clip("c-l", "light", 0, 0, 1);
    const pl = project([light], [track("tl", [lc])]);
    const vis: VisibleClip[] = [{ clip: lc, track: pl.timeline.tracks[0]!, media: light }];
    const st = { light: ready("D:\\light.mp4") };
    expect(layerTargets(pl, st, {}, vis, 1, false)[0]).toBeNull();
    expect(layerTargets(pl, st, {}, vis, 1, true)[0]).not.toBeNull();
  });
});

describe("liveFiles", () => {
  it("is the played file of every ready media", () => {
    const a = video("a", 63);
    const b = video("b", 63);
    const c = video("c", 63);
    const p = project([a, b, c], []);
    const live = liveFiles(p, { a: ready("X:\\a.mp4"), b: { state: "checking" }, c: ready("Y:\\c-copy.mp4") });
    expect([...live].sort()).toEqual(["X:\\a.mp4", "Y:\\c-copy.mp4"]);
  });
});

describe("restTolerance", () => {
  it("is one frame of the timebase", () => {
    expect(restTolerance({ num: 30, den: 1 })).toBeCloseTo(1 / 30, 12);
    expect(restTolerance({ num: 60000, den: 1001 })).toBeCloseTo(1001 / 60000, 12);
  });
  it("never drops below SAME_POSITION_S", () => {
    expect(restTolerance({ num: 240, den: 1 })).toBe(SAME_POSITION_S);
  });
  it("falls back to SAME_POSITION_S for a missing or broken timebase", () => {
    expect(restTolerance(undefined)).toBe(SAME_POSITION_S);
    expect(restTolerance({ num: 0, den: 1 })).toBe(SAME_POSITION_S);
    expect(restTolerance({ num: 30, den: -1 })).toBe(SAME_POSITION_S);
    expect(restTolerance({ num: Number.NaN, den: 1 })).toBe(SAME_POSITION_S);
  });
});

describe("the copy budget", () => {
  it("is a quarter of the cache limit, in the backend's 1024 * 1024 byte MB, and nothing for a bad limit", () => {
    expect(copyBudgetBytes(2048)).toBe(512 * 1024 * 1024);
    expect(copyBudgetBytes(0)).toBe(0);
    expect(copyBudgetBytes(Number.NaN)).toBe(0);
  });

  it("a source fits when its estimated copy is at most the budget; an unknown length never fits", () => {
    const budget = copyBudgetBytes(2048);
    const cap = budget / COPY_BYTES_PER_S; // about 17.9 minutes
    expect(copyFits(65, budget)).toBe(true);
    expect(copyFits(cap, budget)).toBe(true);
    expect(copyFits(cap + 1, budget)).toBe(false);
    expect(copyFits(7200, budget)).toBe(false);
    expect(copyFits(Number.NaN, budget)).toBe(false);
    expect(copyFits(0, budget)).toBe(false);
  });
});
