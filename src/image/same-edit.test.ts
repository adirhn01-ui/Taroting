import { describe, expect, it } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import { touchModified } from "../core/project";
import type { ProjectFile } from "../core/types";
import { sameEdit } from "./same-edit";
import { setBackground } from "./layers";

describe("sameEdit", () => {
  const p = createBlankImageProject("Card", 640, 360, "#ffffff");

  it("reads a save's restamp as the same edit, however many times it happens", () => {
    const once = touchModified(p);
    const twice = { ...once, modifiedAt: "2099-01-01T00:00:00.000Z" };
    expect(once).not.toBe(p);
    expect(sameEdit(once, p)).toBe(true);
    expect(sameEdit(p, twice)).toBe(true);
  });

  it("reads any other changed field as someone else's edit, a rename included", () => {
    expect(sameEdit(setBackground(p, "#000000"), p)).toBe(false);
    expect(sameEdit({ ...p, name: "Renamed" }, p)).toBe(false);
    // Same content, new reference: still a different edit (a clone is a write).
    expect(sameEdit({ ...p, timeline: { ...p.timeline } }, p)).toBe(false);
  });

  it("a field only one side has is a difference, in either direction", () => {
    const extra = { ...p, extra: 1 } as unknown as ProjectFile;
    expect(sameEdit(extra, p)).toBe(false);
    expect(sameEdit(p, extra)).toBe(false);
  });
});
