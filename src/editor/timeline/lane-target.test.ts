import { describe, expect, it } from "vitest";
import { LANE_HYSTERESIS_FRAC, laneTargetForMove } from "./lane-target";
import type { LaneRect } from "./render";
import type { Track } from "../../core/types";

function track(id: string, kind: "video" | "audio"): Track {
  return { id, kind, name: id, muted: false, clips: [] };
}

// Two video lanes stacked (h=60 each), then an audio lane, mirroring a real
// layout. Boundary between V-top and V-bottom is at y=60.
const lanes: LaneRect[] = [
  { track: track("v1", "video"), y: 0, h: 60 },
  { track: track("v2", "video"), y: 60, h: 60 },
  { track: track("a1", "audio"), y: 120, h: 42 },
];

const margin = 60 * LANE_HYSTERESIS_FRAC; // 24px

describe("laneTargetForMove", () => {
  it("keeps the source lane when the pointer stays inside it", () => {
    expect(laneTargetForMove(30, lanes, "video", "v1", "v1")).toBe("v1");
    expect(laneTargetForMove(0, lanes, "video", "v1", "v1")).toBe("v1");
    expect(laneTargetForMove(60, lanes, "video", "v1", "v1")).toBe("v1");
  });

  it("does not retarget while the pointer is still within the hysteresis margin past the boundary", () => {
    // just past the V1/V2 boundary (y=60) but within `margin` → still V1
    expect(laneTargetForMove(60 + margin - 1, lanes, "video", "v1", "v1")).toBe("v1");
  });

  it("retargets only once the pointer clears the margin into the neighbor's core", () => {
    // pointer must reach V2's core: y >= 60 + margin
    expect(laneTargetForMove(60 + margin - 1, lanes, "video", "v1", "v1")).toBe("v1");
    expect(laneTargetForMove(60 + margin + 1, lanes, "video", "v1", "v1")).toBe("v2");
  });

  it("holds the new target once switched (sticky), resisting flip-back at the boundary", () => {
    // now anchored on v2; nudging back toward the boundary within the margin keeps v2
    expect(laneTargetForMove(60 + 1, lanes, "video", "v2", "v1")).toBe("v2");
    // only crossing margin back into v1's core flips it back
    expect(laneTargetForMove(60 - margin - 1, lanes, "video", "v2", "v1")).toBe("v1");
  });

  it("never targets a lane of a different kind (audio lane is ineligible for a video clip)", () => {
    // pointer deep in the audio lane: video clip cannot land there → holds current
    expect(laneTargetForMove(140, lanes, "video", "v2", "v1")).toBe("v2");
  });

  it("falls back to the source lane when the current target is no longer eligible", () => {
    // current target "a1" is audio but the clip is video → ineligible; pointer is
    // off every video-core dead zone → fall back to source v1
    expect(laneTargetForMove(140, lanes, "video", "a1", "v1")).toBe("v1");
  });

  it("targets an audio clip's audio lane and ignores video lanes", () => {
    expect(laneTargetForMove(140, lanes, "audio", "a1", "a1")).toBe("a1");
    // an audio clip dragged up over the video lanes stays on its audio source
    expect(laneTargetForMove(30, lanes, "audio", "a1", "a1")).toBe("a1");
  });
});
