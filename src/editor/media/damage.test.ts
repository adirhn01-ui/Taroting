// The words the editor uses for a damaged video, and the bin's repaint
// decision for a damage publication. Every fixture range ends at a fraction of
// a second that floors and rounds to DIFFERENT whole seconds (60.6 → "1:00"
// floored, "1:01" rounded), so the end's rounding rule is pinned, not assumed.

import { describe, expect, it } from "vitest";
import { damageChange, damageNotice, damageRange, damageStageText, damageTooltip } from "./damage";
import type { DamageState } from "./media";

const REPAIRING: DamageState = { until: 60.6, phase: "repairing", ratio: 0.404 };

describe("damageRange", () => {
  it("floors the end to the whole second a player shows there", () => {
    expect(damageRange(60.6)).toBe("0:00-1:00");
    expect(damageRange(59.4)).toBe("0:00-0:59");
  });

  it("reads hours past the hour", () => {
    expect(damageRange(3725.9)).toBe("0:00-1:02:05");
  });
});

describe("damageTooltip — the bin's Damaged row", () => {
  it("says the range and the repair's progress", () => {
    expect(damageTooltip(REPAIRING)).toBe("0:00-1:00 couldn't be read · repairing 40%");
  });

  it("says repairing without a number before the first report", () => {
    expect(damageTooltip({ until: 60.6, phase: "repairing", ratio: null })).toBe(
      "0:00-1:00 couldn't be read · repairing",
    );
  });

  it("says how it ended", () => {
    expect(damageTooltip({ until: 60.6, phase: "recovered", ratio: null })).toBe(
      "0:00-1:00 couldn't be read · recovered",
    );
    expect(damageTooltip({ until: 60.6, phase: "unrecovered", ratio: null })).toBe(
      "0:00-1:00 couldn't be read · couldn't be recovered",
    );
  });

  it("has no range part, in sentence case, when the range is unknown", () => {
    expect(damageTooltip({ until: null, phase: "repairing", ratio: 0.7 })).toBe("Repairing 70%");
    expect(damageTooltip({ until: null, phase: "unrecovered", ratio: null })).toBe("Couldn't be recovered");
  });
});

describe("damageStageText — the stage inside the range", () => {
  it("covers the instant copy with the repair's progress", () => {
    expect(damageStageText(REPAIRING)).toBe("Damaged section · repairing 40%");
    expect(damageStageText({ until: 60.6, phase: "repairing", ratio: null })).toBe("Damaged section · repairing");
    expect(damageStageText({ until: 60.6, phase: "unrecovered", ratio: null })).toBe(
      "Damaged section · couldn't be recovered",
    );
  });

  it("is the bare label once the recovered copy plays", () => {
    expect(damageStageText({ until: 60.6, phase: "recovered", ratio: null })).toBe("Damaged section");
  });
});

describe("damageNotice — the notice", () => {
  it("names the range and says the rest plays now behind an instant copy", () => {
    expect(damageNotice(REPAIRING, true)).toEqual({
      message: "This video is damaged",
      detail: "0:00-1:00 can't be read. The rest plays now; Taroting repairs the damaged part in the background.",
    });
  });

  it("without a range, only says it is being repaired", () => {
    expect(damageNotice({ until: null, phase: "repairing", ratio: null }, false)?.detail).toBe(
      "Taroting is repairing it in the background.",
    );
  });

  it("never claims the rest plays when no instant copy does", () => {
    // A full repair running in the open: nothing plays until it lands.
    expect(damageNotice(REPAIRING, false)?.detail).toBe(
      "0:00-1:00 can't be read. Taroting is repairing it in the background.",
    );
  });

  it("says nothing when the recovered copy is already there: a reopen is not news", () => {
    expect(damageNotice({ until: 60.6, phase: "recovered", ratio: null }, false)).toBeNull();
  });

  it("says nothing for a damage no repair is running for", () => {
    expect(damageNotice({ until: 60.6, phase: "unrecovered", ratio: null }, true)).toBeNull();
  });
});

describe("damageChange — what a damage publication owes the bin", () => {
  const A: DamageState = { until: 60.6, phase: "repairing", ratio: 0.2 };

  it("a record appearing or leaving is structural", () => {
    expect(damageChange({}, { a: A })).toBe("structural");
    expect(damageChange({ a: A }, {})).toBe("structural");
  });

  it("a phase or range change is structural", () => {
    expect(damageChange({ a: A }, { a: { ...A, phase: "recovered", ratio: null } })).toBe("structural");
    expect(damageChange({ a: A }, { a: { ...A, until: 12.25 } })).toBe("structural");
  });

  it("only a ratio moving is progress", () => {
    expect(damageChange({ a: A }, { a: { ...A, ratio: 0.35 } })).toBe("progress");
    expect(damageChange({ a: { ...A, ratio: null } }, { a: A })).toBe("progress");
  });

  it("a fresh object saying the same thing is nothing", () => {
    expect(damageChange({ a: A }, { a: { ...A } })).toBe("none");
  });

  it("progress on one record never hides a structural change on another", () => {
    const B: DamageState = { until: null, phase: "repairing", ratio: 0.5 };
    expect(damageChange({ a: A, b: B }, { a: { ...A, ratio: 0.3 }, b: { ...B, phase: "unrecovered" } })).toBe(
      "structural",
    );
  });
});
