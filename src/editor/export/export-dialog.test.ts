import { describe, expect, it } from "vitest";
import { joinPath, renameWithSuffix, sanitizeFileName, splitPath } from "./export-dialog";

describe("sanitizeFileName", () => {
  it("strips characters Windows forbids", () => {
    expect(sanitizeFileName('my<vid>:e"o/\\|?*')).toBe("myvideo");
  });
  it("collapses whitespace and trims", () => {
    expect(sanitizeFileName("  a   b  ")).toBe("a b");
  });
  it("falls back to a default when empty", () => {
    expect(sanitizeFileName('///')).toBe("export");
    expect(sanitizeFileName("   ")).toBe("export");
  });
  it("keeps ordinary names intact", () => {
    expect(sanitizeFileName("Holiday Cut 1")).toBe("Holiday Cut 1");
  });
});

describe("renameWithSuffix", () => {
  it("appends (2) when the base is taken", () => {
    expect(renameWithSuffix("clip", (c) => c === "clip")).toBe("clip (2)");
  });
  it("skips forward until a free name is found", () => {
    const taken = new Set(["clip (2)", "clip (3)"]);
    expect(renameWithSuffix("clip", (c) => taken.has(c))).toBe("clip (4)");
  });
  it("continues numbering from an existing suffix", () => {
    // "clip (2)" already ends in (2); next attempt is (3)
    const taken = new Set(["clip (3)"]);
    expect(renameWithSuffix("clip (2)", (c) => taken.has(c))).toBe("clip (4)");
  });
  it("returns (2) when nothing is taken", () => {
    expect(renameWithSuffix("clip", () => false)).toBe("clip (2)");
  });
});

describe("joinPath", () => {
  it("joins with a backslash on Windows-style dirs", () => {
    expect(joinPath("C:\\Users\\me\\Videos", "out.mp4")).toBe("C:\\Users\\me\\Videos\\out.mp4");
  });
  it("does not double the separator", () => {
    expect(joinPath("C:\\Users\\me\\", "out.mp4")).toBe("C:\\Users\\me\\out.mp4");
  });
  it("uses a forward slash for posix dirs", () => {
    expect(joinPath("/home/me/videos", "out.mp4")).toBe("/home/me/videos/out.mp4");
  });
  it("returns the file when the dir is empty", () => {
    expect(joinPath("", "out.mp4")).toBe("out.mp4");
  });
});

describe("splitPath", () => {
  it("splits a Windows path", () => {
    expect(splitPath("C:\\Users\\me\\out.mp4")).toEqual({ dir: "C:\\Users\\me", file: "out.mp4" });
  });
  it("splits a posix path", () => {
    expect(splitPath("/home/me/out.mp4")).toEqual({ dir: "/home/me", file: "out.mp4" });
  });
  it("handles a bare file name", () => {
    expect(splitPath("out.mp4")).toEqual({ dir: "", file: "out.mp4" });
  });
});
