import { describe, expect, it } from "vitest";
import { formatTimecode } from "./format";
import { rat } from "./time";

/**
 * Below 1.5 fps the rounded rate is 0 or 1, and the old arithmetic divided by
 * it: NaN under 0.5 fps, and at 0.5 fps a readout running at half speed (1/2
 * rounds to 1, so frame 6 read as six seconds). Each row is chosen so the
 * seconds and the frame count differ, so a readout that counted frames as
 * seconds fails on its own.
 */
describe("formatTimecode", () => {
  it.each<{ why: string; fps: [number, number]; t: number; out: string }>([
    { why: "0.2 fps at the start", fps: [1, 5], t: 0, out: "00:00:00" },
    { why: "0.2 fps at 12 s (frame 2 starts at 10 s)", fps: [1, 5], t: 12, out: "00:10:00" },
    { why: "0.5 fps at 13 s (frame 6 starts at 12 s)", fps: [1, 2], t: 13, out: "00:12:00" },
    { why: "1 fps at 7.5 s", fps: [1, 1], t: 7.5, out: "00:07:00" },
    { why: "0.2 fps past an hour", fps: [1, 5], t: 3725, out: "1:02:05:00" },
    // The ordinary path is untouched.
    { why: "30 fps", fps: [30, 1], t: 61.5, out: "01:01:15" },
    { why: "NTSC 29.97", fps: [30000, 1001], t: 10, out: "00:09:29" },
    { why: "2 fps (the first rate with a frame field)", fps: [2, 1], t: 13.6, out: "00:13:01" },
  ])("$why", ({ fps, t, out }) => {
    expect(formatTimecode(t, rat(fps[0], fps[1]))).toBe(out);
  });

  it("never prints NaN or Infinity, whatever the rate", () => {
    for (const fps of [rat(1, 3), rat(1, 1000), rat(2, 3), rat(1, 2)]) {
      expect(formatTimecode(42, fps)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });
});
