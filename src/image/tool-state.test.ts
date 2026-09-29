import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_STATE, createToolStore, cssToSource } from "./tool-state";

describe("createToolStore", () => {
  it("starts from the defaults without sharing their nested objects", () => {
    const a = createToolStore();
    const b = createToolStore();
    expect(a.get()).toEqual(DEFAULT_TOOL_STATE);
    expect(a.get().colors).not.toBe(DEFAULT_TOOL_STATE.colors);
    expect(a.get().sizes).not.toBe(DEFAULT_TOOL_STATE.sizes);
    expect(a.get().colors).not.toBe(b.get().colors);
    a.get().sizes.pen = 99;
    expect(DEFAULT_TOOL_STATE.sizes.pen).toBe(4);
    expect(b.get().sizes.pen).toBe(4);
  });
});

describe("cssToSource", () => {
  it("scales screen px by device px, then back through zoom and layer scale", () => {
    // Every factor distinct, so a swapped or dropped one lands elsewhere.
    expect(cssToSource(4, 1.5, 0.5, 0.25)).toBe(48);
    expect(cssToSource(10, 2, 4, 0.5)).toBe(10);
  });
});
