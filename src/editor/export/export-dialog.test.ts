import { describe, expect, it } from "vitest";
import type { ExportPreset } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import {
  codecsForFormat,
  gateHardware,
  hardwareBlockedBy,
  isProjectSource,
  joinPath,
  mergeExportPreset,
  overwriteOffer,
  RENAME_ATTEMPT_LIMIT,
  renameWithSuffix,
  resolveCodec,
  sanitizeFileName,
  splitPath,
  whitelistCodec,
  whitelistFormat,
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

/* These drive the function production calls. There used to be a second,
   untested copy of this numbering inline in resolveRenameThenExport, so all
   four of these passed while the shipped path numbered differently AND could
   overwrite; the inline copy is gone. */
describe("renameWithSuffix", () => {
  it("appends (2) when the base is taken", async () => {
    expect(await renameWithSuffix("clip", (c) => c === "clip")).toBe("clip (2)");
  });
  it("skips forward until a free name is found", async () => {
    const taken = new Set(["clip (2)", "clip (3)"]);
    expect(await renameWithSuffix("clip", (c) => taken.has(c))).toBe("clip (4)");
  });
  it("continues numbering from an existing suffix", async () => {
    // "clip (2)" already ends in (2); next attempt is (3)
    const taken = new Set(["clip (3)"]);
    expect(await renameWithSuffix("clip (2)", (c) => taken.has(c))).toBe("clip (4)");
  });
  it("returns (2) when nothing is taken", async () => {
    expect(await renameWithSuffix("clip", () => false)).toBe("clip (2)");
  });

  it("returns null instead of a taken name when every candidate is taken", async () => {
    // The bug this replaces: the loop hit its guard, kept the last candidate —
    // which it had just been told was TAKEN — and exported over it with no
    // prompt. There is no free name here, and the only safe answer is "none".
    const out = await renameWithSuffix("clip", () => true, 5);
    expect(out).toBeNull();
  });

  it("gives up after exactly `limit` attempts and no more", async () => {
    const tried: string[] = [];
    await renameWithSuffix(
      "clip",
      (c) => {
        tried.push(c);
        return true;
      },
      4,
    );
    expect(tried).toEqual(["clip (2)", "clip (3)", "clip (4)", "clip (5)"]);
  });

  it("finds the free name on the very last allowed attempt", async () => {
    // Off-by-one guard: with limit 3 the candidates are (2), (3), (4).
    expect(await renameWithSuffix("clip", (c) => c !== "clip (4)", 3)).toBe("clip (4)");
    expect(await renameWithSuffix("clip", (c) => c !== "clip (5)", 3)).toBeNull();
  });

  it("drives an async predicate — the shipped path probes the filesystem", async () => {
    const onDisk = new Set(["clip (2).mp4", "clip (3).mp4"]);
    const pathExists = (p: string): Promise<boolean> =>
      Promise.resolve(onDisk.has(p));
    const free = await renameWithSuffix("clip", (c) => pathExists(`${c}.mp4`));
    expect(free).toBe("clip (4)");
  });

  it("defaults to a limit large enough that a real collision run never trips it", () => {
    expect(RENAME_ATTEMPT_LIMIT).toBeGreaterThanOrEqual(1000);
  });
});

/* Verified against the bundled ffmpeg (8.1.1), not against a spec:
     mp4  + h264 / hevc / av1   → header written
     avi  + h264 / hevc / av1   → header written
     mov  + h264 / hevc         → header written
     mov  + av1                 → "av1 only supported in MP4 and AVIF."
     webm + av1                 → header written
     webm + h264 / hevc         → "Only VP8 or VP9 or AV1 video … for WebM" */
describe("codecsForFormat", () => {
  it("does not offer AV1 in MOV — the mov muxer refuses the codec outright", () => {
    expect(codecsForFormat("mov")).not.toContain("av1");
    expect(codecsForFormat("mov")).toEqual(["h264", "hevc"]);
  });
  it("offers only AV1 in WebM", () => {
    expect(codecsForFormat("webm")).toEqual(["av1"]);
  });
  it("offers all three in MP4, which muxes every one of them", () => {
    expect(codecsForFormat("mp4")).toEqual(["h264", "hevc", "av1"]);
  });
  it("does not offer HEVC in AVI — ffmpeg exits 0 and writes an unplayable file", () => {
    // Worse than the mov+av1 case, which at least fails loudly. AVI has no
    // fourcc for HEVC, so ffmpeg reports success and writes a null tag;
    // ffprobe reads the result back as `rawvideo / [0][0][0][0]` and no
    // decoder can open it. Measured with the bundled 8.1.1.
    expect(codecsForFormat("avi")).not.toContain("hevc");
    expect(codecsForFormat("avi")).toEqual(["h264", "av1"]);
  });
  it("moves an AVI project already set to HEVC onto a codec that muxes", () => {
    // Same migration path as mov+av1: a project saved by an older build must
    // be corrected on open, not left pointing at a combination that produces
    // a corrupt file.
    const landed = resolveCodec("avi", "hevc");
    expect(landed).not.toBe("hevc");
    expect(codecsForFormat("avi")).toContain(landed);
  });
  it("keeps every codec on the GIF list so passing through GIF loses nothing", () => {
    // GIF hides the codec row entirely; a short list here would silently
    // rewrite the user's codec whenever they clicked GIF and back.
    for (const c of ["h264", "hevc", "av1"] as const) {
      expect(resolveCodec("gif", c)).toBe(c);
    }
  });
});

describe("resolveCodec", () => {
  it("leaves a codec the container can mux completely alone", () => {
    expect(resolveCodec("mp4", "av1")).toBe("av1");
    expect(resolveCodec("mov", "hevc")).toBe("hevc");
    expect(resolveCodec("avi", "av1")).toBe("av1");
    expect(resolveCodec("webm", "av1")).toBe("av1");
  });

  it("moves MOV+AV1 to HEVC, the nearest thing MOV can actually store", () => {
    // Not H.264: someone who picked AV1 picked it for efficiency, and H.264 is
    // the largest-file option of the three.
    expect(resolveCodec("mov", "av1")).toBe("hevc");
  });

  it("forces WebM onto AV1 whatever was asked for", () => {
    expect(resolveCodec("webm", "h264")).toBe("av1");
    expect(resolveCodec("webm", "hevc")).toBe("av1");
  });

  it("always lands on a codec the format actually offers", () => {
    const formats = ["mp4", "mov", "webm", "avi", "gif"] as const;
    const codecs = ["h264", "hevc", "av1"] as const;
    for (const f of formats) {
      for (const c of codecs) {
        expect(codecsForFormat(f)).toContain(resolveCodec(f, c));
      }
    }
  });

  it("is idempotent — resolving twice never drifts", () => {
    const formats = ["mp4", "mov", "webm", "avi", "gif"] as const;
    const codecs = ["h264", "hevc", "av1"] as const;
    for (const f of formats) {
      for (const c of codecs) {
        const once = resolveCodec(f, c);
        expect(resolveCodec(f, once)).toBe(once);
      }
    }
  });
});

describe("hardwareBlockedBy", () => {
  it("blocks on the global setting, and says which reason it was", () => {
    expect(hardwareBlockedBy({ globalEnabled: false, encoder: "h264_nvenc" })).toBe("setting");
  });
  it("blocks on a codec with no hardware encoder on this machine", () => {
    expect(hardwareBlockedBy({ globalEnabled: true, encoder: "libx264" })).toBe("codec");
    expect(hardwareBlockedBy({ globalEnabled: true, encoder: "libsvtav1" })).toBe("codec");
  });
  it("blocks on nothing when the setting is on and a hardware encoder exists", () => {
    for (const enc of ["h264_nvenc", "hevc_qsv", "av1_amf"]) {
      expect(hardwareBlockedBy({ globalEnabled: true, encoder: enc })).toBeNull();
    }
  });
  it("treats an unfinished probe as 'not blocked' rather than 'software only'", () => {
    expect(hardwareBlockedBy({ globalEnabled: true, encoder: null })).toBeNull();
  });
  it("reports the setting first when both reasons apply", () => {
    expect(hardwareBlockedBy({ globalEnabled: false, encoder: "libx264" })).toBe("setting");
  });
});

describe("gateHardware", () => {
  const wants: ExportPreset = { ...DEFAULT_EXPORT_PRESET, useHardware: true };

  it("turns hardware off for the run and leaves the source preset untouched", () => {
    const run = gateHardware(wants, "setting");
    expect(run.useHardware).toBe(false);
    // THE fix: the project's own answer is still yes.
    expect(wants.useHardware).toBe(true);
    expect(run).not.toBe(wants);
  });

  it("does the same for a software-only codec", () => {
    const run = gateHardware(wants, "codec");
    expect(run.useHardware).toBe(false);
    expect(wants.useHardware).toBe(true);
  });

  it("passes the preset through, as a copy, when nothing blocks", () => {
    const run = gateHardware(wants, null);
    expect(run).toEqual(wants);
    expect(run).not.toBe(wants);
  });

  it("never turns hardware ON for a project that did not ask for it", () => {
    const off: ExportPreset = { ...DEFAULT_EXPORT_PRESET, useHardware: false };
    expect(gateHardware(off, null).useHardware).toBe(false);
    expect(gateHardware(off, "setting").useHardware).toBe(false);
  });

  it("leaves every other field of the preset alone", () => {
    const p: ExportPreset = {
      format: "mov",
      vcodec: "hevc",
      resolution: { w: 1234, h: 566 },
      fps: 60,
      videoBitrate: 12000,
      audioBitrate: 256,
      useHardware: true,
    };
    expect(gateHardware(p, "setting")).toEqual({ ...p, useHardware: false });
  });

  it("survives the export round-trip: the project still asks for hardware afterwards", () => {
    // Exactly the sequence that used to destroy the preference — export with
    // the global setting off, then turn it back on.
    let stored: ExportPreset = { ...DEFAULT_EXPORT_PRESET, useHardware: true };
    const edits = (): PresetEdits => ({
      format: stored.format,
      vcodec: stored.vcodec,
      resolution: stored.resolution,
      fps: stored.fps,
      videoBitrate: stored.videoBitrate,
      audioBitrate: stored.audioBitrate,
      useHardware: stored.useHardware, // the dialog's copy of the PROJECT's ask
    });

    for (let i = 0; i < 3; i++) {
      const toPersist = mergeExportPreset(stored, edits());
      const toRun = gateHardware(toPersist, "setting");
      expect(toRun.useHardware).toBe(false); // the export ran in software…
      stored = toPersist; // …and this is what the project keeps
    }

    expect(stored.useHardware).toBe(true);
    // Setting back on ⇒ the project's choice is simply in force again.
    expect(gateHardware(stored, null).useHardware).toBe(true);
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

/* A `.trt` is hand-editable and shareable, and a newer build may know formats
   this one does not: the persisted preset is data, not a promise that it matches
   the ExportPreset type. */
describe("whitelistFormat", () => {
  it("keeps every format this build writes", () => {
    for (const f of ["mp4", "mov", "webm", "avi", "gif"]) expect(whitelistFormat(f)).toBe(f);
  });
  it("opens anything else as MP4, near-misses included", () => {
    for (const f of ["mkv", "MP4", "mp4 ", "", "__proto__", "toString", null, undefined, 4, {}]) {
      expect(whitelistFormat(f)).toBe("mp4");
    }
  });
});

describe("whitelistCodec", () => {
  it("keeps every codec this build knows, whatever the format", () => {
    for (const c of ["h264", "hevc", "av1"] as const) {
      expect(whitelistCodec(c, "mp4")).toBe(c);
      expect(whitelistCodec(c, "webm")).toBe(c); // resolveCodec, not this, moves it
    }
  });
  it("opens an unknown codec as the format's own first choice", () => {
    // Every format with a different answer, so a fixed fallback cannot pass.
    expect(whitelistCodec("vp9", "webm")).toBe("av1");
    expect(whitelistCodec("vp9", "mp4")).toBe("h264");
    expect(whitelistCodec("H264", "mov")).toBe("h264");
    expect(whitelistCodec("__proto__", "avi")).toBe("h264");
    expect(whitelistCodec(undefined, "webm")).toBe("av1");
  });
  it("hands resolveCodec only values it can index — an unknown one used to throw on open", () => {
    for (const format of ["mp4", "mov", "webm", "avi", "gif"] as const) {
      for (const raw of ["vp9", "", "constructor", null]) {
        const codec = whitelistCodec(raw, format);
        expect(() => resolveCodec(format, codec)).not.toThrow();
        // WebM + garbage lands on a pair the backend accepts, with no move to
        // report: the codec was never H.264 to begin with.
        expect(resolveCodec(format, codec)).toBe(codec);
      }
    }
  });
});

describe("isProjectSource", () => {
  const media = [
    { path: "C:\\Clips\\Intro.mov" },
    { path: "D:\\Footage\\Holiday Clip.mp4" },
    { path: "gen", generator: { type: "solid", color: "#123456" } },
  ];
  it("matches a source listed after an unrelated one", () => {
    expect(isProjectSource("D:\\Footage\\Holiday Clip.mp4", media)).toBe(true);
  });
  it("matches across case and separator spelling, as Windows names files", () => {
    expect(isProjectSource("d:\\footage\\HOLIDAY CLIP.MP4", media)).toBe(true);
    expect(isProjectSource("D:/Footage/Holiday Clip.mp4", media)).toBe(true);
  });
  it("does not match a different file in the same folder, or the same name elsewhere", () => {
    expect(isProjectSource("D:\\Footage\\Holiday Clip export.mp4", media)).toBe(false);
    expect(isProjectSource("E:\\Footage\\Holiday Clip.mp4", media)).toBe(false);
  });
  it("never matches a generated media's placeholder path", () => {
    expect(isProjectSource("gen", media)).toBe(false);
  });
  it("folds ASCII case only: pairs NTFS keeps as two files are not one source", () => {
    // Full-Unicode lower-casing calls both pairs equal; NTFS's own table does
    // not, so treating them as one would hide the Replace button for a file
    // the project never reads.
    for (const [source, other] of [
      ["Stra\u00DFe.mp4", "Stra\u1E9Ee.mp4"],
      ["Kelvin.mp4", "\u212Aelvin.mp4"],
    ] as const) {
      const at = (name: string) => "D:\\Footage\\" + name;
      expect(isProjectSource(at(source), [{ path: at(source) }])).toBe(true);
      expect(isProjectSource(at(other), [{ path: at(source) }])).toBe(false);
    }
  });
});

describe("overwriteOffer", () => {
  const media = [{ path: "D:\\Footage\\Holiday Clip.mp4" }];
  it("offers Replace for an existing file the project does not read", () => {
    expect(overwriteOffer("D:\\Footage\\Holiday Clip export.mp4", true, media)).toBe("replace");
  });
  it("never offers Replace for one of the project's own files", () => {
    expect(overwriteOffer("D:\\Footage\\Holiday Clip.mp4", true, media)).toBe("ownFile");
    expect(overwriteOffer("d:/footage/holiday clip.MP4", true, media)).toBe("ownFile");
  });
  it("decides each path on its own — a source after a replaceable file, and back", () => {
    // No confirmation carries over from one choice to the next.
    const seq = [
      ["D:\\Footage\\Holiday Clip export.mp4", "replace"],
      ["D:\\Footage\\Holiday Clip.mp4", "ownFile"],
      ["D:\\Footage\\Holiday Clip export.mp4", "replace"],
    ] as const;
    for (const [target, want] of seq) expect(overwriteOffer(target, true, media)).toBe(want);
  });
  it("writes a path that does not exist yet, even one spelled like a source", () => {
    // Nothing there to overwrite; the backend decides it the same way.
    expect(overwriteOffer("D:\\Footage\\Brand new.mp4", false, media)).toBe("free");
    expect(overwriteOffer("D:\\Footage\\Holiday Clip.mp4", false, media)).toBe("free");
  });
});
