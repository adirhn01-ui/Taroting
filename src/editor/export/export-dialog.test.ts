import { describe, expect, it } from "vitest";
import type { ExportPreset } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import { addAudioTrack, addMedia, createProject, insertClip, makeClip } from "../../core/project";
import {
  createExportRunHold,
  EXPORT_RUNNING_REASON,
  codecsForFormat,
  destinationProblem,
  driveRootFolder,
  exportHasAudio,
  fontHasGlyph,
  HW_FALLBACK_NOTE,
  missingGlyphNote,
  sanitizeExportPreset,
  unsupportedTextSamples,
  usedSoftwareFallback,
  gateHardware,
  hardwareBlockedBy,
  isProjectSource,
  joinPath,
  mergeExportPreset,
  nothingToExport,
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
  it("strips control characters, which the OS refuses as an opaque invalid argument", () => {
    // U+0001, and U+001F at the top of the range: a filter that stopped short
    // at either end would leave one of them behind.
    expect(sanitizeFileName("Cut\u0001 one")).toBe("Cut one");
    expect(sanitizeFileName("a\u001fb")).toBe("ab");
    expect(sanitizeFileName("\u0000\u0007")).toBe("export");
    // A newline goes too, rather than surviving as a space.
    expect(sanitizeFileName("Line\none")).toBe("Lineone");
  });
});

describe("destinationProblem", () => {
  it("accepts a drive path with either separator, and a network share", () => {
    for (const ok of ["C:\\Videos", "d:/Out", "Z:\\", "\\\\server\\share\\clips"]) {
      expect(destinationProblem(ok), ok).toBeNull();
    }
  });
  it("refuses anything that is not a full path", () => {
    for (const bad of ["Videos", "./out", "..\\out", "C:Videos", "d:clips", "\\Videos", "\\\\", "/home/me"]) {
      expect(destinationProblem(bad), bad).toBe("Enter a full folder path, like C:\\Videos, or choose one.");
    }
  });
  it("takes a bare drive as that drive's root — the shape 0.9.0 remembered", () => {
    // A settings.lastExportDir of "D:" from 0.9.0 refused every export after
    // the upgrade. joinPath restores the separator the folder is missing.
    expect(destinationProblem("D:")).toBeNull();
    expect(joinPath("D:", "clip.mp4")).toBe("D:\\clip.mp4");
  });
  it("accepts the folder its own Save As hands back for a drive root", () => {
    // splitPath and the check had never met in a test: the dialog took a
    // picked "E:\holiday.mp4" apart into "E:" and then refused it. A different
    // drive and both separators, so this cannot pass on the bare-drive rule
    // above alone being right for "D:".
    for (const picked of ["E:\\holiday.mp4", "f:/holiday.webm"]) {
      const { dir, file } = splitPath(picked);
      expect(dir, picked).toMatch(/^[A-Za-z]:[\\/]$/);
      expect(destinationProblem(dir), picked).toBeNull();
      expect(joinPath(dir, file), picked).toBe(picked);
    }
  });
  it("asks for a folder when there is none", () => {
    expect(destinationProblem("")).toBe("Choose a folder for the export.");
    expect(destinationProblem("   ")).toBe("Choose a folder for the export.");
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

  it("takes nothing from a crafted base that is not an object", () => {
    // Spreading the string "mp4" would save keys "0", "1", "2" into the project.
    for (const base of ["mp4", 42, true, ["x", "y"]]) {
      expect(mergeExportPreset(base as unknown as ExportPreset, edits), String(base)).toEqual(edits);
    }
  });
});

/* A `.trt` preset is data: every row below is something a crafted or damaged
   project can carry, and the expected value is what the form and the backend
   (u32 sizes, u64 kbps) can actually take. */
describe("sanitizeExportPreset", () => {
  const DEFAULTS: PresetEdits = {
    format: "mp4",
    vcodec: "h264",
    resolution: "original",
    fps: "original",
    videoBitrate: "auto",
    audioBitrate: "auto",
    useHardware: false,
  };

  it("turns a missing, null or non-object preset into the controls' defaults", () => {
    for (const raw of [undefined, null, "mp4", 7, [], {}]) {
      expect(sanitizeExportPreset(raw), JSON.stringify(raw)).toEqual(DEFAULTS);
    }
  });

  it("keeps a clean preset exactly as it is", () => {
    const clean: PresetEdits = {
      format: "mov",
      vcodec: "hevc",
      resolution: { w: 1234, h: 566 },
      fps: 29.97,
      videoBitrate: 12000,
      audioBitrate: 256,
      useHardware: true,
    };
    expect(sanitizeExportPreset(clean)).toEqual(clean);
    expect(sanitizeExportPreset({ ...clean, resolution: "720p" }).resolution).toBe("720p");
  });

  it("never lets a string reach the form's markup", () => {
    const out = sanitizeExportPreset({
      format: "mp4",
      vcodec: "h264",
      resolution: { w: '1"><img src=x>', h: 720 },
      fps: '30" autofocus onfocus="x" data-x="',
      videoBitrate: '8000"><b>',
      audioBitrate: "192",
      useHardware: "true",
    });
    expect(out).toEqual(DEFAULTS);
  });

  it("falls back to Original for a null, unknown or 'custom' resolution", () => {
    for (const r of [null, "1080P", "custom", "__proto__", { w: 1920 }, { w: NaN, h: 1080 }, { w: "1920", h: "1080" }]) {
      expect(sanitizeExportPreset({ resolution: r }).resolution, JSON.stringify(r)).toBe("original");
    }
  });

  it("rounds and clamps a custom size into whole pixels the backend's u32 takes", () => {
    expect(sanitizeExportPreset({ resolution: { w: 1280.5, h: 719.4 } }).resolution).toEqual({ w: 1281, h: 719 });
    expect(sanitizeExportPreset({ resolution: { w: -5, h: 1e9 } }).resolution).toEqual({ w: 16, h: 16384 });
  });

  it("keeps a frame rate in range, caps GIF at 30, and drops anything else to Original", () => {
    expect(sanitizeExportPreset({ fps: 59.94 }).fps).toBe(59.94);
    expect(sanitizeExportPreset({ format: "gif", fps: 60 }).fps).toBe(30);
    expect(sanitizeExportPreset({ format: "gif", fps: 12 }).fps).toBe(12);
    for (const f of [0, 0.5, 241, -30, Infinity, NaN, "60", null]) {
      expect(sanitizeExportPreset({ fps: f }).fps, String(f)).toBe("original");
    }
  });

  it("rounds a bitrate to whole kbps inside the field's range, else Auto", () => {
    const at = (videoBitrate: unknown, audioBitrate: unknown) => {
      const o = sanitizeExportPreset({ videoBitrate, audioBitrate });
      return [o.videoBitrate, o.audioBitrate];
    };
    expect(at(8000.6, 191.5)).toEqual([8001, 192]);
    // Below the floor: the floor, the same as typing it into the field does.
    expect(at(5, 5)).toEqual([100, 32]);
    expect(at(1e30, 1e30)).toEqual([1_000_000, 3_000]);
    for (const bad of [0, -1, NaN, "8000", null, {}]) expect(at(bad, bad), String(bad)).toEqual(["auto", "auto"]);
  });

  it("asks for hardware only on a real true", () => {
    expect(sanitizeExportPreset({ useHardware: true }).useHardware).toBe(true);
    for (const v of ["true", 1, null, undefined]) expect(sanitizeExportPreset({ useHardware: v }).useHardware).toBe(false);
  });

  it("whitelists the format and codec through the existing rules", () => {
    expect(sanitizeExportPreset({ format: "mkv", vcodec: "vp9" })).toMatchObject({ format: "mp4", vcodec: "h264" });
    expect(sanitizeExportPreset({ format: "webm", vcodec: "vp9" })).toMatchObject({ format: "webm", vcodec: "av1" });
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
  it("keeps a drive root's separator", () => {
    expect(splitPath("D:\\video.mp4")).toEqual({ dir: "D:\\", file: "video.mp4" });
    expect(splitPath("e:/clip.mov")).toEqual({ dir: "e:/", file: "clip.mov" });
    // One level down is an ordinary cut.
    expect(splitPath("D:\\Out\\video.mp4")).toEqual({ dir: "D:\\Out", file: "video.mp4" });
  });
});

describe("driveRootFolder", () => {
  it("turns a bare drive into its root and leaves everything else alone", () => {
    expect(driveRootFolder("G:")).toBe("G:\\");
    for (const same of ["", "C:\\", "C:\\Videos", "D:Videos", "\\\\nas\\share"]) {
      expect(driveRootFolder(same), same).toBe(same);
    }
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

describe("nothingToExport", () => {
  // Media in the bin but no clip placed: the state every bin-first import
  // leaves a project in. The bin is deliberately non-empty, so a check that
  // looked at media instead of clips fails here.
  function binOnly() {
    const p = createProject("Empty");
    return addMedia(p, {
      path: "C:\\media\\song.mp3",
      size: 1,
      mtimeMs: 1,
      kind: "audio",
      duration: 5,
      hasAudio: true,
    });
  }
  it("says what to do on a timeline with no clips, even with media in the bin", () => {
    expect(nothingToExport(binOnly().project)).toBe("Add a clip to the timeline first.");
  });
  it("lets Export run once any layer holds a clip — not only the first one", () => {
    // The clip sits on a SECOND (audio) track, the first video track stays
    // empty, so a check reading tracks[0] alone fails here.
    const { project, media } = binOnly();
    const withTrack = addAudioTrack(project);
    const p = insertClip(withTrack.project, withTrack.trackId, makeClip(media, 0));
    expect(p.timeline.tracks[0]!.clips).toHaveLength(0);
    expect(nothingToExport(p)).toBeNull();
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

/**
 * What a running export holds on the rest of the app: `session.blockLeave`
 * (an OS open refuses instead of tearing the editor down under ffmpeg) and a
 * close task (the window close cancels the job). Every terminal path releases
 * both. A block left behind refuses every later open for the rest of the
 * session; a task left behind cancels a job id that is no longer this run's.
 */
describe("createExportRunHold", () => {
  function rig(): {
    session: { blockLeave: string | null };
    registered: Array<() => void | Promise<void>>;
    unregisters: number;
    cancel: () => void;
    cancels: number;
    register: (t: () => void | Promise<void>) => () => void;
  } {
    const r = {
      session: { blockLeave: null as string | null },
      registered: [] as Array<() => void | Promise<void>>,
      unregisters: 0,
      cancels: 0,
      cancel: () => {
        r.cancels++;
      },
      register: (t: () => void | Promise<void>) => {
        r.registered.push(t);
        return () => {
          r.unregisters++;
          r.registered.splice(r.registered.indexOf(t), 1);
        };
      },
    };
    return r;
  }

  it("hold blocks the session with the export's reason and registers the cancel as a close task", () => {
    const r = rig();
    const h = createExportRunHold(r.session, r.register, r.cancel);
    h.hold();
    expect(r.session.blockLeave).toBe("An export is running.");
    expect(EXPORT_RUNNING_REASON).toBe("An export is running.");
    expect(r.registered).toHaveLength(1);
    // the registered task IS the cancel path, not a copy that forgot something
    void r.registered[0]!();
    expect(r.cancels).toBe(1);
  });

  it("release clears the block and unregisters the task", () => {
    const r = rig();
    const h = createExportRunHold(r.session, r.register, r.cancel);
    h.hold();
    h.release();
    expect(r.session.blockLeave).toBeNull();
    expect(r.registered).toHaveLength(0);
    expect(r.unregisters).toBe(1);
  });

  it("a cancel releases twice (its own path + the canceled-failure event): the second is a no-op", () => {
    const r = rig();
    const h = createExportRunHold(r.session, r.register, r.cancel);
    h.hold();
    h.release();
    h.release();
    expect(r.unregisters).toBe(1);
    expect(r.session.blockLeave).toBeNull();
  });

  it("release never clobbers a reason something else set", () => {
    const r = rig();
    const h = createExportRunHold(r.session, r.register, r.cancel);
    h.hold();
    r.session.blockLeave = "A preview is being prepared.";
    h.release();
    expect(r.session.blockLeave).toBe("A preview is being prepared.");
    // ...but its own task still goes
    expect(r.registered).toHaveLength(0);
  });

  it("holding twice registers once; a second run after a release registers afresh", () => {
    const r = rig();
    const h = createExportRunHold(r.session, r.register, r.cancel);
    h.hold();
    h.hold();
    expect(r.registered).toHaveLength(1);
    h.release();
    h.hold();
    expect(r.registered).toHaveLength(1);
    expect(r.session.blockLeave).toBe(EXPORT_RUNNING_REASON);
    h.release();
    expect(r.unregisters).toBe(2);
    expect(r.session.blockLeave).toBeNull();
  });

  it("a release with no run in progress touches nothing", () => {
    const r = rig();
    r.session.blockLeave = "Something else.";
    createExportRunHold(r.session, r.register, r.cancel).release();
    expect(r.session.blockLeave).toBe("Something else.");
    expect(r.unregisters).toBe(0);
  });
});

/* ---------------- silent exports (the estimate's hasAudio) ---------------- */

describe("exportHasAudio", () => {
  type T = Parameters<typeof exportHasAudio>[0];
  const media = (id: string, hasAudio: boolean) =>
    ({ id, path: `C:\\m\\${id}.mp4`, size: 1, mtimeMs: 1, kind: "video", duration: 9, hasAudio }) as T["media"][number];
  const clip = (id: string, mediaId: string, audio: { muted?: boolean; detached?: boolean } = {}) =>
    ({
      id,
      mediaId,
      timelineStart: 0,
      srcIn: 0,
      srcOut: 1,
      speed: 1,
      audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false, ...audio },
    }) as T["timeline"]["tracks"][number]["clips"][number];
  const track = (id: string, clips: ReturnType<typeof clip>[], muted = false) =>
    ({ id, kind: "video", name: id, muted, clips }) as T["timeline"]["tracks"][number];
  const project = (tracks: ReturnType<typeof track>[], m = [media("loud", true), media("quiet", false)]): T => ({
    media: m,
    timeline: { fps: { num: 30, den: 1 }, width: 640, height: 360, tracks },
  });

  /* Four clips that each fail on exactly ONE condition, then the one audible
     clip last, on the last track: a check that skipped any one condition would
     answer true from a wrong clip, and the same fixture without the audible
     clip must say false. */
  const failing = [
    track("t1", [clip("silentMedia", "quiet"), clip("muted", "loud", { muted: true })]),
    track("t2", [clip("detached", "loud", { detached: true })]),
    track("t3", [clip("onMutedTrack", "loud")], true),
  ];

  it("is false when every clip fails on a different single rule", () => {
    expect(exportHasAudio(project(failing))).toBe(false);
  });
  it("is true once one clip passes every rule", () => {
    expect(exportHasAudio(project([...failing, track("t4", [clip("heard", "loud")])]))).toBe(true);
  });
  it("is false with no clips, and with clips of media that has no audio", () => {
    expect(exportHasAudio(project([track("t1", [])]))).toBe(false);
    expect(exportHasAudio(project([track("t1", [clip("a", "quiet")])]))).toBe(false);
  });
  it("ignores a clip whose media is not in the list", () => {
    expect(exportHasAudio(project([track("t1", [clip("ghost", "missing")])]))).toBe(false);
  });
});

/* ---------------- text the export font cannot draw ---------------- */

describe("fontHasGlyph", () => {
  it("draws Latin, Greek and Cyrillic in every face", () => {
    const families = ["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact"] as const;
    for (const f of families) {
      for (const ch of "Aé€—Ωж♥") expect(fontHasGlyph(f, ch.codePointAt(0)!), `${f} ${ch}`).toBe(true);
    }
  });
  it("knows Hebrew and Arabic are in Arial but not in Georgia or Impact", () => {
    for (const ch of "שم") {
      const cp = ch.codePointAt(0)!;
      expect(fontHasGlyph("Arial", cp)).toBe(true);
      expect(fontHasGlyph("Segoe UI", cp)).toBe(true);
      expect(fontHasGlyph("Georgia", cp)).toBe(false);
      expect(fontHasGlyph("Impact", cp)).toBe(false);
    }
  });
  it("knows Armenian is Segoe UI's alone", () => {
    const cp = "Ա".codePointAt(0)!;
    expect(fontHasGlyph("Segoe UI", cp)).toBe(true);
    expect(fontHasGlyph("Arial", cp)).toBe(false);
  });
  it("has no emoji, dingbats, CJK or Thai in any face, nor the emoji joiners", () => {
    for (const ch of ["😀", "🎉", "★", "✓", "中", "あ", "ก", "\u200d", "\ufe0f"]) {
      for (const f of ["Segoe UI", "Arial", "Impact"] as const) {
        expect(fontHasGlyph(f, ch.codePointAt(0)!), `${f} U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
      }
    }
  });
});

describe("unsupportedTextSamples", () => {
  type T = Parameters<typeof unsupportedTextSamples>[0];
  const text = (id: string, t: string, fontFamily: "Arial" | "Georgia" = "Arial") =>
    ({
      id,
      path: "Text",
      size: 0,
      mtimeMs: 0,
      kind: "image",
      duration: 5,
      hasAudio: false,
      generator: { type: "text", text: t, fontFamily, sizePx: 64, color: "#ffffff", bold: false, italic: false },
    }) as T["media"][number];
  const placed = (...ids: string[]): T["timeline"] => ({
    fps: { num: 30, den: 1 },
    width: 640,
    height: 360,
    tracks: [
      {
        id: "v",
        kind: "video",
        name: "V1",
        muted: false,
        clips: ids.map((mediaId, i) => ({
          id: `c${i}`,
          mediaId,
          timelineStart: i,
          srcIn: 0,
          srcOut: 1,
          speed: 1,
          audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
        })),
      },
    ],
  });

  it("is empty for text every face draws", () => {
    expect(unsupportedTextSamples({ media: [text("a", "Hello — Ωmega")], timeline: placed("a") })).toEqual([]);
  });
  it("quotes whole graphemes, once each, at most three", () => {
    // The family emoji is five code points joined by ZWJs; it comes back as one.
    const t = text("a", "Party 🎉 🎉 👨‍👩‍👧 ★ 中 文");
    expect(unsupportedTextSamples({ media: [t], timeline: placed("a") })).toEqual(["🎉", "👨‍👩‍👧", "★"]);
  });
  it("judges each text by its own font", () => {
    // The same Hebrew word is fine in Arial and missing from Georgia.
    const media = [text("arial", "שלום", "Arial"), text("georgia", "שלום", "Georgia")];
    expect(unsupportedTextSamples({ media, timeline: placed("arial") })).toEqual([]);
    expect(unsupportedTextSamples({ media, timeline: placed("georgia") })).toEqual(["ש", "ל", "ו"]);
  });
  it("ignores text that only sits in the bin", () => {
    const media = [text("bin", "🎉"), text("used", "plain")];
    expect(unsupportedTextSamples({ media, timeline: placed("used") })).toEqual([]);
  });
  it("words the note around the samples, and says nothing without them", () => {
    expect(missingGlyphNote([])).toBeNull();
    expect(missingGlyphNote(["🎉", "★"])).toBe(
      "Some characters in your text, like 🎉 ★, aren't in the text's font, so the export will show empty boxes in their place.",
    );
  });
});

describe("usedSoftwareFallback", () => {
  it("is true only for the backend's real flag", () => {
    expect(usedSoftwareFallback({ path: "C:\\o.mp4", hwFallback: true })).toBe(true);
    for (const v of [false, "true", 1, null, undefined]) {
      expect(usedSoftwareFallback({ path: "C:\\o.mp4", hwFallback: v }), String(v)).toBe(false);
    }
    expect(usedSoftwareFallback({})).toBe(false);
    expect(usedSoftwareFallback(null)).toBe(false);
  });
  it("words the note calmly, with no action to take", () => {
    expect(HW_FALLBACK_NOTE).toBe("Hardware encoding failed, so this export used the CPU instead.");
  });
});
