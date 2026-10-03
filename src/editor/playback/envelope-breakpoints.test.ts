// The preview's audio fade envelope (envelopeBreakpoints in audio-graph.ts).
//
// The bugs this guards, all preview-only (the export renders fades itself):
//  - a clip with a fade-out and no fade-in, reached exactly at its first frame
//    (play from a clip's start, every cut, the right half of every split), was
//    SILENT until its fade-out began — the start bound was inclusive, and the
//    "hold the volume" step existed only for clips without a fade-out;
//  - a clip armed early by the lookahead got its fade-in ramp anchored at the
//    moment of arming, so the fade began up to 1.5 s before the clip did;
//  - when the two fades overlap, the schedule jumped to full volume where the
//    fade-out begins, a step in the middle of the fade-in.
//
// Each case is judged by EVALUATING the steps with AudioParam's own rules (a
// set jumps; a ramp runs linearly from the previous step's time and value; the
// last value holds) and comparing with the gain the export applies. Fixture
// values deliberately differ on every axis: the clip starts at 2.5 (not 0),
// srcIn is 1.25 and speed 1.5 (so clipEnd is not srcOut), and the volume is
// 0.6 (so "full" is not 1).

import { describe, expect, it } from "vitest";
import { clipEnd } from "../../core/time";
import { envelopeBreakpoints, type EnvelopeStep } from "./audio-graph";
import { clipOf, videoMedia } from "./test-fakes";

const BASE = 0.6;
const MEDIA = videoMedia("fades", 60);

/** A clip on [2.5, 6.5]: srcIn 1.25, srcOut 7.25, speed 1.5. */
function clip(fadeInSec: number, fadeOutSec: number) {
  return clipOf(MEDIA, 2.5, 1.25, 7.25, 1.5, { fadeInSec, fadeOutSec });
}
const START = 2.5;
const END = 6.5;

/** The AudioParam output these steps describe, at timeline time x. */
function evaluate(steps: EnvelopeStep[], x: number): number {
  let prevT = -Infinity;
  let prevV = 0;
  for (const s of steps) {
    if (s.at <= x) {
      prevT = s.at;
      prevV = s.value;
      continue;
    }
    if (s.kind === "set") return prevV;
    return prevV + ((s.value - prevV) * (x - prevT)) / (s.at - prevT);
  }
  return prevV;
}

/** The gain the export applies at timeline time x. */
function exportGain(fadeIn: number, fadeOut: number, x: number): number {
  if (x < START || x >= END) return 0;
  let v = BASE;
  if (fadeIn > 0 && x < START + fadeIn) v *= (x - START) / fadeIn;
  if (fadeOut > 0 && x > END - fadeOut) v *= (END - x) / fadeOut;
  return v;
}

/** AudioParam requires a schedule that never goes back in time. */
function expectOrdered(steps: EnvelopeStep[]): void {
  for (let i = 1; i < steps.length; i++) {
    expect(steps[i]!.at).toBeGreaterThanOrEqual(steps[i - 1]!.at);
  }
}

describe("envelopeBreakpoints — fixture sanity", () => {
  it("the clip really spans [2.5, 6.5]", () => {
    expect(clipEnd(clip(0, 0))).toBeCloseTo(END, 12);
  });
});

describe("envelopeBreakpoints — a fade-out-only clip reached at its first frame", () => {
  const steps = envelopeBreakpoints(clip(0, 1), BASE, START);

  it("plays at full volume from the start, not from the fade-out", () => {
    expectOrdered(steps);
    expect(evaluate(steps, START)).toBeCloseTo(BASE, 9);
    expect(evaluate(steps, START + 0.01)).toBeCloseTo(BASE, 9);
    expect(evaluate(steps, 5.0)).toBeCloseTo(BASE, 9);
  });

  it("still fades out over its last second, to silence at the end", () => {
    expect(evaluate(steps, 6.0)).toBeCloseTo(BASE * 0.5, 9);
    expect(evaluate(steps, END)).toBe(0);
    expect(evaluate(steps, END + 1)).toBe(0);
  });
});

describe("envelopeBreakpoints — a fade-in armed early by the lookahead", () => {
  const steps = envelopeBreakpoints(clip(1, 0), BASE, START - 1.5);

  it("stays silent until the clip starts", () => {
    expectOrdered(steps);
    expect(evaluate(steps, START - 1.5)).toBe(0);
    expect(evaluate(steps, START - 0.5)).toBe(0);
    expect(evaluate(steps, START)).toBe(0);
  });

  it("ramps from the clip's start, reaching full volume one second in", () => {
    expect(evaluate(steps, START + 0.5)).toBeCloseTo(BASE * 0.5, 9);
    expect(evaluate(steps, START + 1)).toBeCloseTo(BASE, 9);
    expect(evaluate(steps, END - 0.01)).toBeCloseTo(BASE, 9);
    expect(evaluate(steps, END)).toBe(0);
  });
});

describe("envelopeBreakpoints — overlapping fades", () => {
  // fade-in 3 s and fade-out 2.5 s on a 4 s clip: they overlap on
  // [START+1.5, START+3], and the true curve peaks at the clip's midpoint.
  const fi = 3;
  const fo = 2.5;
  const t0 = START + 0.5;
  const steps = envelopeBreakpoints(clip(fi, fo), BASE, t0);

  it("rises without a step to the peak, then falls to silence", () => {
    expectOrdered(steps);
    const peakAt = (START + END) / 2;
    const dx = 0.001;
    let prev = evaluate(steps, t0);
    let maxJump = 0;
    for (let i = 1; t0 + i * dx < END; i++) {
      const x = t0 + i * dx;
      const v = evaluate(steps, x);
      // the one sample pair that straddles the peak is neither rising nor falling
      if (x <= peakAt) expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      else if (x - dx >= peakAt) expect(v).toBeLessThanOrEqual(prev + 1e-12);
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
    }
    // The steepest true slope here is BASE / 2.5 per second; a ramp between
    // samples of the curve can never be steeper than ~twice that. The old
    // schedule's jump to full volume at START+1.5 was ~0.3 in one sample.
    expect(maxJump).toBeLessThan((2 * BASE * dx) / 2.5);
  });

  it("tracks the export's curve, and reaches its true peak", () => {
    for (let x = t0; x < END; x += 0.01) {
      expect(Math.abs(evaluate(steps, x) - exportGain(fi, fo, x))).toBeLessThan(0.05 * BASE);
    }
    const peakAt = (START + END) / 2;
    expect(evaluate(steps, peakAt)).toBeCloseTo(exportGain(fi, fo, peakAt), 9);
  });
});

describe("envelopeBreakpoints — a fade-in that spans the whole clip", () => {
  it("still ramps all the way to full volume before the end", () => {
    // Its end IS the clip's end, so it has no interior breakpoint; the ramp
    // must still be emitted (a dropped ramp would hold at the start value).
    const steps = envelopeBreakpoints(clip(4, 0), BASE, START);
    expectOrdered(steps);
    expect(evaluate(steps, START + 2)).toBeCloseTo(BASE * 0.5, 9);
    expect(evaluate(steps, END - 0.001)).toBeCloseTo(BASE * (3.999 / 4), 6);
    expect(evaluate(steps, END)).toBe(0);
  });
});

// Regression guards rather than pins of the fix: the old schedule got these
// right too, and the rewrite must not change them.
describe("envelopeBreakpoints — no fades (guard)", () => {
  for (const t0 of [START - 1.2, START, 4.1]) {
    it(`holds full volume and steps to silence at the end (armed at ${t0})`, () => {
      const steps = envelopeBreakpoints(clip(0, 0), BASE, t0);
      expectOrdered(steps);
      expect(evaluate(steps, Math.max(t0, START))).toBeCloseTo(BASE, 9);
      expect(evaluate(steps, END - 0.001)).toBeCloseTo(BASE, 9);
      expect(evaluate(steps, END)).toBe(0);
      // no ramp to zero: the last stretch of an unfaded clip is not a fade
      expect(steps.some((s) => s.kind === "ramp" && s.value === 0)).toBe(false);
    });
  }

  it("is silent once the clip is over", () => {
    expect(envelopeBreakpoints(clip(1, 1), BASE, END)).toEqual([{ kind: "set", at: END, value: 0 }]);
  });

  it("follows the export's curve for separate fades armed mid-clip", () => {
    const steps = envelopeBreakpoints(clip(1, 1.5), BASE, START + 0.25);
    for (let x = START + 0.25; x < END + 0.5; x += 0.01) {
      expect(evaluate(steps, x)).toBeCloseTo(exportGain(1, 1.5, x), 9);
    }
  });
});
