// The decision `PlaybackEngine.refresh()` makes before it re-activates the
// scheduler (see catchUpTime in engine.ts).
//
// The bug this guards: refresh() re-runs `scheduler.activate(this.t, playing)`,
// and activate's MASTER branch re-seeks the element whenever
// `|el.currentTime - srcT| > 0.01`. During playback `this.t` is a snapshot from
// the last rAF tick, so a refresh landing 12 ms later is already over that bar
// and backward-seeks the very element acting as the master clock — a dropped
// frame plus an audio glitch. Two callers make that common rather than rare:
// editor.ts subscribes refresh() to the stage's ResizeObserver (every frame of
// a window drag) and to `media.status` readiness-KIND changes (progress ticks
// are filtered out by statusChange in media/status-diff.ts before they reach
// refresh(), but a proxy finishing mid-playback still lands here). Neither
// says anything about where the playhead is.
//
// The other half is what these tests mostly cover: suppressing the seek must
// NOT suppress a LEGITIMATE one. refresh() exists for project edits — a clip
// moved, trimmed or re-sped under the playhead — and those change the
// clip↔source mapping, so the element genuinely has to be dragged back onto
// the playhead. The two cases are told apart by whether the master element is
// where the ELAPSED TIME says it should be.

import { describe, expect, it } from "vitest";
import { catchUpTime } from "./engine";

// Mirrors of the private constants in engine.ts. Duplicated deliberately: if
// either moves, these tests should be re-read rather than silently re-scaled.
const SLEW = 0.05;
const FRAME60 = 1 / 60;

/** A refresh landing `age` seconds after the last tick, on a healthy transport:
 *  the element and the engine's extrapolated clock agree, both `age` ahead of
 *  the tick's snapshot. */
function healthy(age: number, lastTick = 10, boundary = 30): number | null {
  return catchUpTime(lastTick + age, lastTick, lastTick + age, boundary);
}

describe("catchUpTime — the stale-refresh case", () => {
  it("adopts the master clock when the only difference is elapsed time", () => {
    // the measured case: a refresh 12 ms after a tick diverges by 0.012 s,
    // which is over activate's 0.01 s seek threshold.
    expect(healthy(0.012)).toBeCloseTo(10.012, 9);
  });

  it("adopts across a whole 60 Hz frame, and across a multi-frame hitch", () => {
    expect(healthy(FRAME60)).toBeCloseTo(10 + FRAME60, 9);
    expect(healthy(3 * FRAME60)).toBeCloseTo(10 + 3 * FRAME60, 9);
  });

  it("absorbs element jitter up to the slew bound, either direction", () => {
    // A refresh 100 ms after the tick: the extrapolated clock reads 10.1 and
    // the element is within the bound on either side of it — while still ahead
    // of the tick's snapshot, so the never-rewind guard is not what is being
    // measured here. Probed just INSIDE rather than exactly at the bound:
    // 10.1 + 0.05 is not representable, so an exact-boundary assertion would be
    // testing binary floating point rather than the rule.
    const inside = SLEW - 1e-4;
    expect(catchUpTime(10.1 + inside, 10, 10.1, 30)).toBeCloseTo(10.1 + inside, 9);
    expect(catchUpTime(10.1 - inside, 10, 10.1, 30)).toBeCloseTo(10.1 - inside, 9);
  });

  it("does nothing when no time has passed since the tick", () => {
    // equal, or a hair behind: there is nothing to catch up to, and the
    // playhead must never run backwards.
    expect(catchUpTime(10, 10, 10, 30)).toBeNull();
    expect(catchUpTime(9.995, 10, 10.01, 30)).toBeNull();
  });

  it("does nothing with no master video", () => {
    // stills and gaps do not seek, so a stale `t` cannot hurt them.
    expect(catchUpTime(null, 10, 10.012, 30)).toBeNull();
  });
});

describe("catchUpTime — a LEGITIMATE re-seek is still allowed through", () => {
  it("keeps the old time when a clip moved under the playhead", () => {
    // clip.timelineStart +5 while playing: timelineTime() now maps the
    // element's unchanged currentTime 5 s further along. Keeping `t` lets
    // activate() hard-seek the element back onto the playhead, as before.
    expect(catchUpTime(15.012, 10, 10.012, 30)).toBeNull();
  });

  it("keeps the old time when a trim shifted srcIn", () => {
    // srcIn -0.4 maps the same currentTime 0.4 s later on the timeline.
    expect(catchUpTime(10.412, 10, 10.012, 30)).toBeNull();
  });

  it("keeps the old time for any divergence past the slew bound", () => {
    // Both probes stay ahead of the tick snapshot, so it is the slew bound
    // rejecting them and not the never-rewind guard.
    const outside = SLEW + 1e-4;
    expect(catchUpTime(10.1 + outside, 10, 10.1, 30)).toBeNull();
    expect(catchUpTime(10.1 - outside, 10, 10.1, 30)).toBeNull();
  });

  it("keeps the old time when the element has stalled", () => {
    // buffering: the element stops while the wall clock runs on. The engine's
    // extrapolation races ahead of it, so we must not treat the element's
    // position as the playhead.
    expect(catchUpTime(10.001, 10, 10.4, 30)).toBeNull();
  });
});

describe("catchUpTime — the segment boundary belongs to the ticker", () => {
  it("never adopts a time at or past the current boundary", () => {
    // Crossing a cut is advanceBoundary() + the A/B slot swap. Adopting a time
    // past the segment end would make activate() resolve the NEXT clip and
    // assign its URL over the still-showing slot, throwing away the preload.
    expect(catchUpTime(12.001, 10, 12.001, 12)).toBeNull();
    expect(catchUpTime(12, 10, 12, 12)).toBeNull();
  });

  it("adopts a time that is still safely inside the segment", () => {
    expect(catchUpTime(11.9, 10, 11.9, 12)).toBeCloseTo(11.9, 9);
  });

  it("leaves a BOUNDARY_EPS guard band before the cut", () => {
    // BOUNDARY_EPS is 1/240; a time inside that band is treated as "at" the
    // boundary, matching how the ticker's own advance loop reads it.
    expect(catchUpTime(12 - 1 / 480, 10, 12 - 1 / 480, 12)).toBeNull();
  });

  it("handles an unbounded segment (no later clip on any layer)", () => {
    expect(catchUpTime(10.012, 10, 10.012, Infinity)).toBeCloseTo(10.012, 9);
  });
});
