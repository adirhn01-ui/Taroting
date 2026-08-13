// The decision that keeps a running proxy job from rebuilding the media bin ten
// times a second (see status-diff.ts). Every fixture below is built from fresh
// objects, so a verdict can only come from comparing FIELDS — a diff that
// secretly leaned on reference identity would call every one of these
// structural.
//
// Values differ on every axis the predicate could confuse: ids never overlap,
// the two ratios differ from each other and from the 0.05 stub the bar falls
// back to, job ids sit nowhere near the ratio scale, and each snapshot mixes
// kinds so a verdict cannot come from "this map contains a preparing entry".

import { describe, expect, it } from "vitest";
import type { MediaState } from "./media";
import { statusChange } from "./status-diff";

const preparing = (jobId: number, ratio: number | null): MediaState => ({
  state: "preparing",
  ratio,
  jobId,
});
const ready = (url: string, sourcePath: string): MediaState => ({ state: "ready", url, sourcePath });
const failed = (message: string): MediaState => ({ state: "failed", message });
const checking = (): MediaState => ({ state: "checking" });

const CACHE_A = "cache/9f2ac1.mp4";
const CACHE_B = "cache/3b70de.mp4";

describe("statusChange — nothing to redraw", () => {
  it("reads a fresh map that says the same thing as none", () => {
    // What the store publishes on a repeated ffmpeg ratio: a brand-new object,
    // brand-new entries, identical values, across three different kinds.
    const prev = {
      "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A),
      "med-voice-2": preparing(41, 0.17),
      "med-still-9": checking(),
    };
    const next = {
      "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A),
      "med-voice-2": preparing(41, 0.17),
      "med-still-9": checking(),
    };
    expect(statusChange(prev, next)).toBe("none");
  });

  it("reads the very same snapshot as none", () => {
    const snap = { "med-voice-2": preparing(87, 0.62), "med-reel-4": failed("No decoder") };
    expect(statusChange(snap, snap)).toBe("none");
  });

  it("reads empty → empty as none", () => {
    expect(statusChange({}, {})).toBe("none");
  });
});

describe("statusChange — only the number moved", () => {
  it("calls a moving ratio progress", () => {
    // The untouched neighbour is a different KIND, so a verdict of "progress"
    // cannot have come from the map merely containing a preparing entry.
    const prev = {
      "med-voice-2": preparing(41, 0.17),
      "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A),
    };
    const next = {
      "med-voice-2": preparing(41, 0.62),
      "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A),
    };
    expect(statusChange(prev, next)).toBe("progress");
  });

  it("calls the first ratio arriving under a planned job progress", () => {
    // plan_playback publishes ratio null; the job's first event fills it in.
    expect(
      statusChange({ "med-voice-2": preparing(41, null) }, { "med-voice-2": preparing(41, 0.31) }),
    ).toBe("progress");
  });
});

describe("statusChange — the bin's markup is wrong", () => {
  it("calls a kind flip structural", () => {
    // The case the refresh exists for: the proxy finished, so the current frame
    // may have just become playable.
    expect(
      statusChange(
        { "med-voice-2": preparing(41, 0.62) },
        { "med-voice-2": ready(`asset://${CACHE_B}`, CACHE_B) },
      ),
    ).toBe("structural");
  });

  it("calls a media that has appeared structural", () => {
    const prev = { "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A) };
    const next = {
      "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A),
      "med-voice-2": checking(),
    };
    expect(statusChange(prev, next)).toBe("structural");
  });

  it("calls a media that has gone away structural", () => {
    const prev = {
      "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A),
      "med-voice-2": preparing(41, 0.17),
    };
    const next = { "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A) };
    expect(statusChange(prev, next)).toBe("structural");
  });

  it("calls a new job id under an unchanged preparing structural", () => {
    // The ratio is deliberately IDENTICAL on both sides, so the only thing this
    // can be reading is the job: a re-plan after a relink, not progress.
    expect(
      statusChange({ "med-voice-2": preparing(41, 0.62) }, { "med-voice-2": preparing(87, 0.62) }),
    ).toBe("structural");
  });

  it("calls a relinked ready media structural", () => {
    expect(
      statusChange(
        { "med-reel-4": ready(`asset://${CACHE_A}`, CACHE_A) },
        { "med-reel-4": ready(`asset://${CACHE_B}`, CACHE_B) },
      ),
    ).toBe("structural");
  });

  it("calls a changed failure message structural", () => {
    // It is rendered into the row's title attribute.
    expect(
      statusChange(
        { "med-reel-4": failed("Unsupported codec") },
        { "med-reel-4": failed("File was moved or deleted") },
      ),
    ).toBe("structural");
  });

  it("lets structural win over progress whichever order the ids arrive in", () => {
    // One media progresses while another finishes, in one publication. The
    // finish must be seen no matter which entry the walk reaches first.
    const before = { "med-voice-2": preparing(41, 0.17), "med-reel-4": preparing(87, 0.44) };
    const after = {
      "med-voice-2": preparing(41, 0.62),
      "med-reel-4": ready(`asset://${CACHE_B}`, CACHE_B),
    };
    expect(statusChange(before, after)).toBe("structural");

    const beforeSwapped = { "med-reel-4": preparing(87, 0.44), "med-voice-2": preparing(41, 0.17) };
    const afterSwapped = {
      "med-reel-4": ready(`asset://${CACHE_B}`, CACHE_B),
      "med-voice-2": preparing(41, 0.62),
    };
    expect(statusChange(beforeSwapped, afterSwapped)).toBe("structural");
  });
});
