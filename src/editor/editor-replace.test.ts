import { describe, expect, it } from "vitest";
import { evalKfs } from "../core/anim";
import { MIN_CLIP_DUR, defaultAudio, defaultTransform } from "../core/project";
import { sourceTime } from "../core/time";
import type { Clip, MediaInfo } from "../core/types";
import { closedImportMessage, retargetClip } from "./editor";

/**
 * Replace media points a clip at another file. The old code reset srcIn to 0
 * and clamped srcOut, and left everything that derives from the OLD file's
 * identity where it was: keyframes (source seconds) slid by the old srcIn, the
 * crop (source pixels) could hang outside a smaller frame, and a probe that
 * reported no length gave a zero-length clip.
 *
 * Fixtures differ on every axis the code could confuse: srcIn is not 0, speed
 * is not 1, no keyframe sits at srcIn or on a midpoint, x/y/opacity have
 * different times and values, and the old and new frames differ in both
 * dimensions.
 */

const SRC_IN = 3.5;
const SPEED = 1.5;

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    mediaId: "old",
    timelineStart: 11.25,
    srcIn: SRC_IN,
    srcOut: 9.5, // 6 source-seconds long
    speed: SPEED,
    audio: defaultAudio(),
    transform: { ...defaultTransform(), crop: { x: 1500, y: 900, w: 400, h: 160 } },
    keyframes: {
      x: [
        { t: 4.1, v: -120 },
        { t: 7.35, v: 260 },
      ],
      y: [
        { t: 4.1, v: 40 },
        { t: 7.35, v: -75 },
      ],
      opacity: [
        { t: 3.9, v: 1 },
        { t: 5.2, v: 0.35 },
        { t: 8.8, v: 0.9 },
      ],
    },
    ...over,
  };
}

function info(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "D:\\Footage\\take 2.mp4",
    size: 1,
    mtimeMs: 1,
    kind: "video",
    duration: 12.3,
    width: 1280,
    height: 720,
    hasAudio: true,
    ...over,
  };
}

describe("retargetClip (Replace media)", () => {
  it("restarts srcIn at 0, keeps the length, and points at the new media", () => {
    const next = retargetClip(clip(), "new", info());
    expect(next.mediaId).toBe("new");
    expect(next.srcIn).toBe(0);
    expect(next.srcOut).toBeCloseTo(6, 9);
    expect(next.timelineStart).toBe(11.25);
    expect(next.speed).toBe(SPEED);
  });

  it("shifts every keyframe by the old srcIn, so the animation plays at the same moment of the clip", () => {
    const before = clip();
    const next = retargetClip(before, "new", info());
    expect(next.keyframes!.x!.map((k) => k.t)).toEqual([4.1 - SRC_IN, 7.35 - SRC_IN]);
    expect(next.keyframes!.y!.map((k) => k.t)).toEqual([4.1 - SRC_IN, 7.35 - SRC_IN]);
    expect(next.keyframes!.opacity!.map((k) => k.t)).toEqual([3.9 - SRC_IN, 5.2 - SRC_IN, 8.8 - SRC_IN]);
    // Sampled through the real mapping at clip-local moments that are neither
    // a key nor a midpoint: the same moment of the clip shows the same value.
    for (const local of [0.37, 1.9, 2.95]) {
      for (const prop of ["x", "y", "opacity"] as const) {
        const was = evalKfs(before.keyframes![prop]!, sourceTime(before, local));
        const now = evalKfs(next.keyframes![prop]!, sourceTime(next, local));
        expect(now).toBeCloseTo(was, 9);
      }
    }
  });

  it("drops no key and keeps x/y paired, even where a key lands before 0", () => {
    const next = retargetClip(clip(), "new", info());
    expect(next.keyframes!.x!.length).toBe(2);
    expect(next.keyframes!.y!.length).toBe(2);
    expect(next.keyframes!.opacity!.length).toBe(3);
    expect(next.keyframes!.x!.map((k) => k.t)).toEqual(next.keyframes!.y!.map((k) => k.t));
    // values untouched
    expect(next.keyframes!.opacity!.map((k) => k.v)).toEqual([1, 0.35, 0.9]);
  });

  it("does not mutate the clip it was given", () => {
    const before = clip();
    const snapshot = JSON.stringify(before);
    retargetClip(before, "new", info({ width: 320, height: 180 }));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("clamps the crop into a smaller frame", () => {
    const next = retargetClip(clip(), "new", info());
    const crop = next.transform!.crop!;
    expect(crop.x + crop.w).toBeLessThanOrEqual(1280);
    expect(crop.y + crop.h).toBeLessThanOrEqual(720);
    expect(crop).toEqual({ x: 880, y: 560, w: 400, h: 160 });
    // the rest of the transform rides along
    expect(next.transform!.scale).toBe(clip().transform!.scale);
  });

  it("leaves a crop that fits alone", () => {
    const next = retargetClip(clip(), "new", info({ width: 3840, height: 2160 }));
    expect(next.transform!.crop).toEqual({ x: 1500, y: 900, w: 400, h: 160 });
  });

  it("clamps the length to a shorter file", () => {
    const next = retargetClip(clip(), "new", info({ duration: 2.2 }));
    expect(next.srcOut).toBe(2.2);
  });

  it("never makes a clip shorter than one minimum clip, in source seconds", () => {
    const next = retargetClip(clip(), "new", info({ duration: 0.001 }));
    expect(next.srcOut).toBeCloseTo(MIN_CLIP_DUR * SPEED, 12);
    expect((next.srcOut - next.srcIn) / next.speed).toBeGreaterThanOrEqual(MIN_CLIP_DUR - 1e-12);
  });

  it("a still keeps the clip's footprint (it has no duration to clamp to)", () => {
    const next = retargetClip(clip(), "new", info({ kind: "image", duration: 0, width: 640, height: 480 }));
    expect(next.srcIn).toBe(0);
    expect(next.srcOut).toBeCloseTo(6, 9);
    expect(next.keyframes!.x![0]!.t).toBeCloseTo(4.1 - SRC_IN, 12);
  });

  it("a clip already starting at srcIn 0 keeps its keyframes as they are", () => {
    const before = clip({ srcIn: 0, srcOut: 6 });
    const next = retargetClip(before, "new", info());
    expect(next.keyframes).toBe(before.keyframes);
  });
});

describe("closedImportMessage", () => {
  it("names a single file with its extension", () => {
    expect(closedImportMessage(["D:\\Clips\\beach.walk.mp4"])).toBe(
      "beach.walk.mp4 wasn't imported because the project was closed.",
    );
  });

  it("counts several files", () => {
    expect(closedImportMessage(["a.mp4", "b.mov", "c.wav"])).toBe(
      "3 files weren't imported because the project was closed.",
    );
  });
});
