// The divider drag writes ONE number onto the timeline panel, and that number
// has to satisfy three things at once: the shipped bounds, the stage floor on a
// window too short for those bounds, and "a style write never carries a
// non-number". These pin all three.
//
// Every fixture below is deliberately off every constant it could be confused
// with — 622 is not 640, 317 is not 280, 204 is not 200 — so an assertion that
// passes because two values happen to coincide cannot hide here.

import { describe, expect, it } from "vitest";
import { TIMELINE_HEIGHT_MAX, TIMELINE_HEIGHT_MIN } from "../../core/types";
import { PREVIEW_MIN_H, clampPanelHeight, maxPanelHeight } from "./panel-size";

describe("maxPanelHeight", () => {
  it("stops at the shipped maximum while the window is tall enough", () => {
    // 1000 - 120 = 880 of room, so the constant is what binds, not the window.
    expect(maxPanelHeight(1000)).toBe(TIMELINE_HEIGHT_MAX);
  });

  it("stops at the stage floor on a window too short for the maximum", () => {
    // A 768-tall screen: ~742px of .editor__main. 742 - 120 = 622, i.e. BELOW
    // the 640 maximum — reading the constant here instead of the window is
    // exactly the mistake that pushes the transport off the bottom edge.
    expect(maxPanelHeight(742)).toBe(622);
  });

  it("never returns less than the shipped minimum", () => {
    // 261 - 120 = 141, under the 160 floor: a shorter timeline is not an
    // improvement over a shorter stage.
    expect(maxPanelHeight(261)).toBe(TIMELINE_HEIGHT_MIN);
    expect(maxPanelHeight(0)).toBe(TIMELINE_HEIGHT_MIN);
    expect(maxPanelHeight(-40)).toBe(TIMELINE_HEIGHT_MIN);
    expect(maxPanelHeight(Number.NaN)).toBe(TIMELINE_HEIGHT_MIN);
  });

  it("leaves the stage its floor at every height that can fit both", () => {
    // The invariant the flex layout also enforces: the panel and the stage
    // together never exceed the container.
    for (const mainH of [280, 281, 419, 560, 742, 761, 900, 1440]) {
      const h = maxPanelHeight(mainH);
      expect(mainH - h).toBeGreaterThanOrEqual(PREVIEW_MIN_H);
      expect(h).toBeGreaterThanOrEqual(TIMELINE_HEIGHT_MIN);
      expect(h).toBeLessThanOrEqual(TIMELINE_HEIGHT_MAX);
    }
  });
});

describe("clampPanelHeight", () => {
  it("passes a height inside the band through untouched", () => {
    expect(clampPanelHeight(317, 622)).toBe(317);
  });

  it("clamps to the ceiling it is GIVEN, not to the constant", () => {
    // 622 is the window-derived ceiling; answering 640 here means the drag
    // ignored the short window and read TIMELINE_HEIGHT_MAX directly.
    expect(clampPanelHeight(900, 622)).toBe(622);
    expect(clampPanelHeight(900, TIMELINE_HEIGHT_MAX)).toBe(TIMELINE_HEIGHT_MAX);
  });

  it("clamps to the shipped minimum from below", () => {
    expect(clampPanelHeight(37, 622)).toBe(TIMELINE_HEIGHT_MIN);
    expect(clampPanelHeight(-50, 622)).toBe(TIMELINE_HEIGHT_MIN);
  });

  it("keeps the minimum when the ceiling is below it", () => {
    // An inverted band must not resolve to the ceiling: 90 would be a panel
    // with no lanes in it.
    expect(clampPanelHeight(300, 90)).toBe(TIMELINE_HEIGHT_MIN);
  });

  it("rounds to a whole pixel", () => {
    // Pointer arithmetic is fractional; a fractional height puts the canvas on
    // a half pixel for the whole session.
    expect(clampPanelHeight(203.6, 622)).toBe(204);
    expect(clampPanelHeight(203.4, 622)).toBe(203);
  });

  it("never lets a non-number reach the style write", () => {
    expect(clampPanelHeight(Number.NaN, 622)).toBe(TIMELINE_HEIGHT_MIN);
    expect(clampPanelHeight(Number.POSITIVE_INFINITY, 622)).toBe(TIMELINE_HEIGHT_MIN);
    expect(clampPanelHeight(Number.NEGATIVE_INFINITY, 622)).toBe(TIMELINE_HEIGHT_MIN);
  });
});
