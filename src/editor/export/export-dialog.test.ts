import { describe, expect, it } from "vitest";
import type { ExportPreset } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import {
  joinPath,
  mergeExportPreset,
  renameWithSuffix,
  sanitizeFileName,
  splitPath,
  type PresetEdits,
} from "./export-dialog";

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

describe("mergeExportPreset", () => {
  /* Deliberately different from DEFAULT_EXPORT_PRESET on EVERY axis, so a field
     that silently kept its old value cannot hide behind a coincidence. */
  const edits: PresetEdits = {
    format: "mov",
    vcodec: "hevc",
    resolution: "1080p",
    fps: 60,
    videoBitrate: 12000,
    audioBitrate: 256,
    useHardware: false,
  };

  it("writes every field the dialog owns", () => {
    expect(mergeExportPreset(DEFAULT_EXPORT_PRESET, edits)).toEqual(edits);
  });

  it("preserves unknown keys written by a newer build (.trt is additive-only)", () => {
    const base = {
      ...DEFAULT_EXPORT_PRESET,
      twoPass: true,
      colorSpace: "bt2020nc",
    } as unknown as ExportPreset;
    const out = mergeExportPreset(base, edits) as unknown as Record<string, unknown>;
    expect(out.twoPass).toBe(true);
    expect(out.colorSpace).toBe("bt2020nc");
    // …and the owned fields still won
    expect(out.format).toBe("mov");
    expect(out.useHardware).toBe(false);
  });

  it("an unknown key survives repeated save round-trips", () => {
    let stored = { ...DEFAULT_EXPORT_PRESET, futureKnob: 7 } as unknown as ExportPreset;
    for (let i = 0; i < 4; i++) stored = mergeExportPreset(stored, edits);
    expect((stored as unknown as Record<string, unknown>).futureKnob).toBe(7);
  });

  it("never resurrects a stale value for a field the dialog owns", () => {
    // Includes the falsy / "auto" values a `??`- or truthiness-based merge
    // would silently drop back to the persisted value.
    const base: ExportPreset = {
      format: "gif",
      vcodec: "av1",
      resolution: "480p",
      fps: "original",
      videoBitrate: 500,
      audioBitrate: 64,
      useHardware: true,
    };
    const owned: PresetEdits = {
      format: "mp4",
      vcodec: "h264",
      resolution: "original",
      fps: 24,
      videoBitrate: "auto",
      audioBitrate: "auto",
      useHardware: false,
    };
    expect(mergeExportPreset(base, owned)).toEqual(owned);
  });

  it("carries a custom resolution object through unchanged", () => {
    const out = mergeExportPreset(DEFAULT_EXPORT_PRESET, {
      ...edits,
      resolution: { w: 1234, h: 566 },
    });
    expect(out.resolution).toEqual({ w: 1234, h: 566 });
  });

  it("does not mutate the persisted preset", () => {
    const base = Object.freeze({ ...DEFAULT_EXPORT_PRESET }) as ExportPreset;
    const out = mergeExportPreset(base, edits);
    expect(base).toEqual(DEFAULT_EXPORT_PRESET);
    expect(out).not.toBe(base);
  });

  it("works when a project carries no preset at all", () => {
    expect(mergeExportPreset(undefined, edits)).toEqual(edits);
    expect(mergeExportPreset(null, edits)).toEqual(edits);
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
