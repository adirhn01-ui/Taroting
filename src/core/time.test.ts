import { describe, expect, it } from "vitest";
import {
  clipDuration,
  clipEnd,
  frameCenter,
  frameOf,
  frameStart,
  locate,
  rat,
  snapToFrame,
  sourceTime,
  timelineDuration,
  timelineTime,
} from "./time";
import type { Clip, Timeline, Track } from "./types";

const clip = (partial: Partial<Clip>): Clip => ({
  id: partial.id ?? "c1",
  mediaId: "m1",
  timelineStart: 0,
  srcIn: 0,
  srcOut: 10,
  speed: 1,
  audio: {
    volume: 1,
    muted: false,
    fadeInSec: 0,
    fadeOutSec: 0,
    gainOffsetDb: 0,
    detached: false,
  },
  ...partial,
});

describe("frame math", () => {
  it("round-trips frame indices through frameCenter (integer fps)", () => {
    const fps = rat(30);
    for (let n = 0; n < 10_000; n += 7) {
      expect(frameOf(frameCenter(n, fps), fps)).toBe(n);
    }
  });

  it("round-trips at NTSC 29.97 (30000/1001)", () => {
    const fps = rat(30000, 1001);
    for (let n = 0; n < 100_000; n += 997) {
      expect(frameOf(frameCenter(n, fps), fps)).toBe(n);
    }
  });

  it("round-trips at 23.976 and 59.94", () => {
    for (const fps of [rat(24000, 1001), rat(60000, 1001)]) {
      for (let n = 0; n < 50_000; n += 501) {
        expect(frameOf(frameCenter(n, fps), fps)).toBe(n);
      }
    }
  });

  it("frame boundaries land on the correct side", () => {
    const fps = rat(30);
    // t exactly at a frame start belongs to that frame
    expect(frameOf(frameStart(10, fps), fps)).toBe(10);
    // one microsecond earlier belongs to the previous frame
    expect(frameOf(frameStart(10, fps) - 1e-4, fps)).toBe(9);
  });

  it("snapToFrame is idempotent", () => {
    const fps = rat(24000, 1001);
    const t = 12.3456;
    const snapped = snapToFrame(t, fps);
    expect(snapToFrame(snapped, fps)).toBeCloseTo(snapped, 12);
  });
});

describe("clip time mapping", () => {
  it("maps clip-local to source and back (speed 1)", () => {
    const c = clip({ timelineStart: 5, srcIn: 2, srcOut: 12 });
    expect(clipDuration(c)).toBe(10);
    expect(clipEnd(c)).toBe(15);
    expect(sourceTime(c, 3)).toBe(5);
    expect(timelineTime(c, 5)).toBe(8);
  });

  it("maps with speed != 1", () => {
    const c = clip({ timelineStart: 10, srcIn: 4, srcOut: 12, speed: 2 });
    expect(clipDuration(c)).toBe(4); // 8s of source at 2x
    // 1s into the clip on the timeline = 2s into the source
    expect(sourceTime(c, 1)).toBe(6);
    expect(timelineTime(c, 6)).toBe(11);
  });

  it("timelineTime is the inverse of sourceTime (property)", () => {
    const c = clip({ timelineStart: 3.3, srcIn: 1.7, srcOut: 9.4, speed: 1.5 });
    for (let local = 0; local <= clipDuration(c); local += 0.37) {
      const src = sourceTime(c, local);
      expect(timelineTime(c, src)).toBeCloseTo(c.timelineStart + local, 9);
    }
  });
});

describe("locate", () => {
  const track: Track = {
    id: "t1",
    kind: "video",
    name: "Video",
    muted: false,
    clips: [
      clip({ id: "a", timelineStart: 0, srcIn: 0, srcOut: 5 }),
      clip({ id: "b", timelineStart: 8, srcIn: 0, srcOut: 4 }),
    ],
  };

  it("finds the clip under t", () => {
    const r = locate(track, 2);
    expect(r.kind).toBe("clip");
    if (r.kind === "clip") {
      expect(r.clip.id).toBe("a");
      expect(r.clipLocal).toBe(2);
    }
  });

  it("clip start is inclusive, end is exclusive", () => {
    const atStart = locate(track, 8);
    expect(atStart.kind === "clip" && atStart.clip.id === "b").toBe(true);
    const atEnd = locate(track, 5);
    expect(atEnd.kind).toBe("gap");
  });

  it("reports gaps with the next clip start", () => {
    const r = locate(track, 6);
    expect(r).toEqual({ kind: "gap", nextIndex: 1, nextClipStart: 8 });
  });

  it("reports after-the-end", () => {
    expect(locate(track, 100).kind).toBe("after");
    expect(locate({ ...track, clips: [] }, 0).kind).toBe("after");
  });
});

describe("timelineDuration", () => {
  it("takes the max end across tracks", () => {
    const timeline: Timeline = {
      fps: rat(30),
      width: 1920,
      height: 1080,
      tracks: [
        {
          id: "v",
          kind: "video",
          name: "V",
          muted: false,
          clips: [clip({ timelineStart: 0, srcOut: 5 })],
        },
        {
          id: "a",
          kind: "audio",
          name: "A",
          muted: false,
          clips: [clip({ id: "x", timelineStart: 3, srcOut: 9 })],
        },
      ],
    };
    expect(timelineDuration(timeline)).toBe(12);
  });
});
