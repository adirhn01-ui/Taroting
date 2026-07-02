import { describe, expect, it } from "vitest";
import { chordOf, findConflicts, normalizeChord } from "./shortcuts";

const ev = (key: string, mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("chordOf", () => {
  it("normalizes keys and modifier order", () => {
    expect(chordOf(ev(" "))).toBe("Space");
    expect(chordOf(ev("z", { ctrl: true }))).toBe("Ctrl+Z");
    expect(chordOf(ev("Z", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+Z");
    expect(chordOf(ev("ArrowLeft"))).toBe("ArrowLeft");
    expect(chordOf(ev("Delete", { shift: true }))).toBe("Shift+Delete");
    expect(chordOf(ev("s", { meta: true }))).toBe("Ctrl+S"); // meta folds into Ctrl
  });

  it("modifier keys alone produce no chord", () => {
    expect(chordOf(ev("Control", { ctrl: true }))).toBeNull();
    expect(chordOf(ev("Shift", { shift: true }))).toBeNull();
  });
});

describe("normalizeChord", () => {
  it("cleans up user-entered chords", () => {
    expect(normalizeChord("ctrl + shift + z")).toBe("Ctrl+Shift+Z");
    expect(normalizeChord("SHIFT+delete")).toBe("Shift+Delete");
    expect(normalizeChord("cmd+s")).toBe("Ctrl+S");
    expect(normalizeChord("n")).toBe("N");
    expect(normalizeChord("")).toBe("");
  });
});

describe("findConflicts", () => {
  it("detects duplicate bindings", () => {
    expect(
      findConflicts({ a: "Ctrl+Z", b: "ctrl+z", c: "Space" }),
    ).toEqual(["Ctrl+Z"]);
    expect(findConflicts({ a: "Ctrl+Z", b: "Ctrl+Y" })).toEqual([]);
  });
});
