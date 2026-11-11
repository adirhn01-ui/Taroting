// The export form's glyph note for text in a font from the library or this PC
// (0.9.4). The six keep the coverage table (export-dialog.test.ts pins it);
// any other font is checked against its real file through
// `fonts_missing_glyphs`, and a font missing on this PC is named, with its
// text checked against the table of the legacy font the export falls back to.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FontFamily, Generator, ProjectFile } from "../../core/types";
import { fontsState } from "../media/fonts-fake.test-util";

vi.mock("../../fonts", async () => (await import("../media/fonts-fake.test-util")).fakeFonts);
const glyphs = vi.hoisted(() => ({ calls: [] as unknown[], answer: [] as number[][] }));
vi.mock("../../core/ipc", async (orig) => {
  const real = await orig<typeof import("../../core/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      fontsMissingGlyphs: async (items: unknown) => {
        glyphs.calls.push(items);
        return glyphs.answer;
      },
    },
  };
});

const { libraryFontTextCheck, missingFontExportNote, unsupportedTextSamples } = await import("./export-dialog");

type P = Pick<ProjectFile, "media" | "timeline">;
type TextGen = Extract<Generator, { type: "text" }>;

const text = (id: string, t: string, over: Partial<TextGen> = {}) =>
  ({
    id,
    path: "Text",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 5,
    hasAudio: false,
    generator: { type: "text", text: t, fontFamily: "Arial" as FontFamily, sizePx: 64, color: "#ffffff", bold: false, italic: true, ...over },
  }) as P["media"][number];

const placed = (...ids: string[]): P["timeline"] => ({
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

beforeEach(() => {
  fontsState.reset();
  glyphs.calls = [];
  glyphs.answer = [];
});

describe("the glyph check for library and installed fonts", () => {
  it("makes no font call and no IPC for a project using only the six", async () => {
    const p = { media: [text("a", "中文 ok")], timeline: placed("a") };
    expect(await libraryFontTextCheck(p)).toBeNull();
    expect(glyphs.calls).toEqual([]);
    expect(fontsState.ensureCalls).toEqual([]);
    // ...and the table still judges it exactly as before.
    expect(unsupportedTextSamples(p)).toEqual(["中", "文"]);
  });

  it("asks Rust about a non-legacy font, and quotes what its file lacks", async () => {
    // "中" is U+4E2D; the font's file lacks it, and has the Latin letters.
    glyphs.answer = [[0x4e2d]];
    const p = { media: [text("a", "Hi 中 文", { fontFamily: "Segoe UI", fontId: "Consolas" })], timeline: placed("a") };
    // The table no longer speaks for this text: "文" would be in its answer.
    expect(unsupportedTextSamples(p)).toEqual([]);
    const check = await libraryFontTextCheck(p);
    expect(glyphs.calls).toEqual([[{ id: "Consolas", bold: false, italic: true, text: "Hi 中 文" }]]);
    expect(check).toEqual({ samples: ["中"], missing: [], fallback: "Segoe UI" });
  });

  it("names a font missing on this PC and checks its text with the fallback's table", async () => {
    fontsState.missing.add("lib:Gone");
    glyphs.answer = [[]];
    const p = {
      media: [
        text("here", "fine", { fontFamily: "Segoe UI", fontId: "Consolas" }),
        text("gone", "שלום", { fontFamily: "Georgia", fontId: "lib:Gone" }),
      ],
      timeline: placed("here", "gone"),
    };
    const check = await libraryFontTextCheck(p);
    // Only the font that is here is asked about: the missing one has no file.
    expect(glyphs.calls).toEqual([[{ id: "Consolas", bold: false, italic: true, text: "fine" }]]);
    // Georgia (the missing font's own fallback) has no Hebrew; Segoe UI would.
    expect(check).toEqual({ samples: ["ש", "ל", "ו"], missing: ["lib:Gone"], fallback: "Georgia" });
  });

  it("ignores text that only sits in the bin", async () => {
    const p = { media: [text("a", "x", { fontId: "Consolas" })], timeline: placed() };
    expect(await libraryFontTextCheck(p)).toBeNull();
  });
});

describe("missingFontExportNote", () => {
  it("is null with nothing missing", () => {
    expect(missingFontExportNote([], "Segoe UI")).toBeNull();
  });
  it("names one font, without its lib: prefix", () => {
    expect(missingFontExportNote(["lib:Inter"], "Segoe UI")).toBe(
      "Font Inter isn't on this PC, so the export uses Segoe UI in its place.",
    );
  });
  it("names a font once when a library copy and an installed one share its name", () => {
    expect(missingFontExportNote(["lib:Inter", "Inter"], "Segoe UI")).toBe(
      "Font Inter isn't on this PC, so the export uses Segoe UI in its place.",
    );
  });
  it("names several", () => {
    expect(missingFontExportNote(["lib:Inter", "Consolas", "Bahnschrift"], "Arial")).toBe(
      "Fonts Inter, Consolas and Bahnschrift aren't on this PC, so the export uses Arial in their place.",
    );
  });
});
