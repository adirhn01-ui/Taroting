// The gain-envelope staleness test shared by both mixer paths (see
// envelopeStale in audio-graph.ts).
//
// The bug this guards: `scheduleEnvelope` bakes its breakpoints into ABSOLUTE
// AudioContext times from an anchor, so a schedule is only still valid while
// the thing it drives sits where continuous playback from that anchor would put
// it. The video path already re-armed on divergence — with a comment naming the
// user-reported "scrub the playhead and it goes mute" bug it fixes — but
// `syncAudioTracks` re-armed only on `fresh || discontinuity`, and that leaves a
// band wide open:
//
//   a ruler scrub during playback (timeline.seek → engine.seek, which does NOT
//   pause) steps 0.12-0.3 s per pointermove. Over HARD_RESYNC_SEC, so the voice
//   element is hard-reseeked and jumps; under the 0.3 s `discontinuity` bar, so
//   the envelope stayed anchored to the pre-scrub trajectory and fired its
//   fade/zero breakpoints at the wrong ctx time. Scrubbing backwards therefore
//   silenced the clip for the rest of its run, and nothing self-corrected until
//   a >0.3 s jump, a pause or a project edit.
//
// A preview-speed change is the same shape by a different route: `at()` maps
// timeline seconds into ctx seconds THROUGH the speed, so every future
// breakpoint of an envelope scheduled at the old speed is at the wrong ctx time.
// The 0.3 s test cannot see it at all — the playhead is still advancing
// smoothly.

import { describe, expect, it } from "vitest";
import { envelopeStale } from "./audio-graph";

// Mirrors of the private constants in audio-graph.ts.
const SEEK_REARM = 0.15;
const HARD_RESYNC = 0.12;
const FRAME60 = 1 / 60;

/** An envelope scheduled for timeline time 5 at AudioContext time 100. */
const ANCHOR = { t0: 5, ctx0: 100 };

/** Where healthy playback at `speed` puts the playhead after `elapsed` seconds
 *  of AudioContext time. */
const onTrack = (elapsed: number, speed = 1): number => ANCHOR.t0 + elapsed * speed;

describe("envelopeStale — healthy playback never re-arms", () => {
  it("is false frame after frame at 1x", () => {
    for (let i = 1; i <= 120; i++) {
      const elapsed = i * FRAME60;
      expect(envelopeStale(ANCHOR, onTrack(elapsed), 100 + elapsed, 1)).toBe(false);
    }
  });

  it("is false at a preview speed the envelope was scheduled with", () => {
    for (const speed of [0.5, 2, 4]) {
      const elapsed = 0.75;
      expect(envelopeStale(ANCHOR, onTrack(elapsed, speed), 100 + elapsed, speed)).toBe(false);
    }
  });

  it("tolerates drift up to the re-arm bound", () => {
    // A drift-corrected voice is bounded to HARD_RESYNC_SEC, and the bar sits
    // just above it precisely so a healthy correction never trips a re-arm.
    // Probed just either side of the bar rather than exactly on it: 6 + 0.15 is
    // not representable, so an exact-boundary assertion would be testing binary
    // floating point rather than the rule.
    expect(envelopeStale(ANCHOR, onTrack(1) + HARD_RESYNC, 101, 1)).toBe(false);
    expect(envelopeStale(ANCHOR, onTrack(1) + SEEK_REARM - 1e-4, 101, 1)).toBe(false);
    expect(envelopeStale(ANCHOR, onTrack(1) + SEEK_REARM + 1e-4, 101, 1)).toBe(true);
  });
});

describe("envelopeStale — trigger 1: a ruler scrub during playback", () => {
  it("catches a backward scrub the 0.3s discontinuity test misses", () => {
    // one pointermove: the playhead jumps back 0.2 s while ctx advances a frame
    const elapsed = 1 + FRAME60;
    expect(envelopeStale(ANCHOR, onTrack(elapsed) - 0.2, 100 + elapsed, 1)).toBe(true);
  });

  it("catches a forward scrub of the same size", () => {
    const elapsed = 1 + FRAME60;
    expect(envelopeStale(ANCHOR, onTrack(elapsed) + 0.2, 100 + elapsed, 1)).toBe(true);
  });

  it("accumulates: steps individually under the bar still trip it", () => {
    // The anchor only moves on a re-arm, so a run of sub-bar steps keeps adding
    // up rather than being forgiven one at a time. Three 0.13 s steps: the
    // first is under the bar, the second is already over.
    const step = 0.13;
    let elapsed = 0;
    let pos = ANCHOR.t0;
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      elapsed += FRAME60;
      pos = pos + FRAME60 - step; // a frame of playback, then a scrub step back
      seen.push(envelopeStale(ANCHOR, pos, 100 + elapsed, 1));
    }
    expect(seen).toEqual([false, true, true]);
  });

  it("does not fire on a scrub small enough that nothing reseeks either", () => {
    // Under HARD_RESYNC_SEC the element is only nudged, not moved, so the
    // envelope is still (near enough) correct — and one 0.05 s step must not
    // cost a reschedule.
    const elapsed = 1 + FRAME60;
    expect(envelopeStale(ANCHOR, onTrack(elapsed) - 0.05, 100 + elapsed, 1)).toBe(false);
  });
});

describe("envelopeStale — trigger 2: a preview-speed change mid-playback", () => {
  it("catches a 1x -> 2x change the discontinuity test cannot see", () => {
    // half a second at 1x from the anchor, then the speed doubles: the playhead
    // advances at 2x from there, but the SCHEDULE still maps ctx→timeline at 1x
    // for the first half second. The test runs at the new speed, so the two
    // trajectories separate.
    const atChange = 0.5;
    const since = 0.4;
    const pos = ANCHOR.t0 + atChange * 1 + since * 2;
    expect(envelopeStale(ANCHOR, pos, 100 + atChange + since, 2)).toBe(true);
  });

  it("catches a 1x -> 0.5x change too", () => {
    const atChange = 0.5;
    const since = 0.8;
    const pos = ANCHOR.t0 + atChange * 1 + since * 0.5;
    expect(envelopeStale(ANCHOR, pos, 100 + atChange + since, 0.5)).toBe(true);
  });

  it("needs no discontinuity-sized jump to fire", () => {
    // the whole point: the playhead never moves more than a frame at a time
    // here, so |t - lastT| stays far under 0.3 s throughout.
    const atChange = 0.5;
    const since = 0.4;
    const pos = ANCHOR.t0 + atChange + since * 2;
    expect(Math.abs(2 * FRAME60)).toBeLessThan(0.3);
    expect(envelopeStale(ANCHOR, pos, 100 + atChange + since, 2)).toBe(true);
  });
});

describe("envelopeStale — speed clamp", () => {
  it("floors the speed at 0.25, matching scheduleEnvelope's own mapping", () => {
    // scheduleEnvelope maps breakpoints with Math.max(0.25, previewSpeed); the
    // staleness test has to use the SAME floor or a very low preview speed
    // would read as permanently diverged.
    const elapsed = 1;
    const pos = ANCHOR.t0 + elapsed * 0.25;
    expect(envelopeStale(ANCHOR, pos, 100 + elapsed, 0.1)).toBe(false);
    expect(envelopeStale(ANCHOR, pos, 100 + elapsed, 0)).toBe(false);
  });
});
