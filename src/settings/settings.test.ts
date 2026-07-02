import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS } from "../core/types";
import type { ActionId } from "../core/types";
import { ACTION_LABELS } from "./settings";

describe("ACTION_LABELS", () => {
  it("has a label for every ActionId", () => {
    const actionIds = Object.keys(DEFAULT_SHORTCUTS) as ActionId[];
    for (const id of actionIds) {
      expect(ACTION_LABELS[id], `missing label for "${id}"`).toBeTruthy();
    }
  });

  it("has no extra keys beyond the ActionId set", () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(Object.keys(DEFAULT_SHORTCUTS).sort());
  });
});
