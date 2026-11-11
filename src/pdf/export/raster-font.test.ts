// The Arabic raster fallback with a non-legacy font (0.9.4): the font is
// loaded through the runtime BEFORE the canvas draws, and the canvas names
// its alias first with the legacy font after it. The runtime is faked.

import { describe, expect, it, vi } from "vitest";
import type { RasterTextSpec } from "./deps";

const f = vi.hoisted(() => ({ log: [] as string[], missing: false }));
vi.mock("../../fonts", () => ({
  ensureFonts: async (reqs: { id: string }[]) => void f.log.push(`ensure:${reqs.map((r) => r.id).join(",")}`),
  fontFace: (legacy: string, id: string) => {
    f.log.push(`face:${id}`);
    return f.missing ? { family: legacy, bold: false, italic: false, missing: true } : { family: "tf-alias", bold: false, italic: false, missing: false };
  },
}));

const { rasterAlias, rasterAliases } = await import("./deps");
const { layoutCanvasLines } = await import("./raster");

const spec: RasterTextSpec = {
  text: "مرحبا", font: "Georgia", fontId: "lib:Amiri", bold: false, italic: false, size: 12, color: "#000000",
  align: "right", w: 100, h: 20, scale: 2, lineHeight: 15,
};

interface Draw {
  t: string;
  x: number;
  y: number;
  font: string;
  fill: string;
  dir: string;
  align: string;
}
const draws: Draw[] = [];

/** A canvas that records the fonts it was given and what it drew; a font's
 *  height is its px size (ascent 3/4, descent 1/4), a character 10 px wide. */
function fakeCanvas(fonts: string[]): void {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        let font = "";
        const g = {
          set font(v: string) {
            font = v;
            fonts.push(v);
          },
          get font() {
            return font;
          },
          fillStyle: "",
          textBaseline: "",
          textAlign: "",
          direction: "",
          measureText: (t: string) => {
            const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 24);
            return { width: t.length * 10, fontBoundingBoxAscent: px * 0.75, fontBoundingBoxDescent: px * 0.25 };
          },
          fillText(t: string, x: number, y: number) {
            draws.push({ t, x, y, font, fill: g.fillStyle, dir: g.direction, align: g.textAlign });
          },
        };
        return g;
      }
    },
  );
}

describe("the raster fallback's font", () => {
  it("loads the font first, then names its alias", async () => {
    f.log.length = 0;
    expect(await rasterAlias(spec)).toBe("tf-alias");
    expect(f.log).toEqual(["ensure:lib:Amiri", "face:lib:Amiri"]);
  });

  it("a font that did not load draws in the legacy font", async () => {
    f.missing = true;
    expect(await rasterAlias(spec)).toBeUndefined();
    f.missing = false;
  });

  it("the canvas font: alias first, legacy after; without one exactly the 0.9.3 string", async () => {
    const fonts: string[] = [];
    fakeCanvas(fonts);
    const png = async () => new Uint8Array([1]);
    await layoutCanvasLines(spec, png, "tf-alias");
    await layoutCanvasLines(spec, png);
    expect(fonts).toEqual(['24px tf-alias, "Georgia"', '24px "Georgia"']);
    vi.unstubAllGlobals();
  });
});

describe("the raster fallback with style runs", () => {
  const png = async () => new Uint8Array([1]);
  const runSpec: RasterTextSpec = {
    text: "Hello world", font: "Georgia", bold: false, italic: false, size: 12, color: "#000000",
    align: "left", w: 200, h: 40, scale: 2, lineHeight: 15,
    runs: [
      { s: 0, e: 6, font: "Georgia", bold: false, italic: false, size: 12, color: "#000000" },
      { s: 6, e: 11, font: "Arial", fontId: "lib:Amiri", bold: true, italic: false, size: 24, color: "#ff0000" },
    ],
  };

  it("draws one piece per visual group, each in its own face, size and colour, on one baseline", async () => {
    draws.length = 0;
    fakeCanvas([]);
    await layoutCanvasLines(runSpec, png, undefined, [undefined, "tf-alias"]);
    vi.unstubAllGlobals();
    // 5 pt a character; the row's baseline is the 24 pt piece's A:
    // (30 - (18 + 6)) / 2 + 18 = 21 pt = 42 px
    expect(draws).toEqual([
      { t: "Hello ", x: 0, y: 42, font: '24px "Georgia"', fill: "#000000", dir: "ltr", align: "left" },
      { t: "world", x: 60, y: 42, font: 'bold 48px tf-alias, "Arial"', fill: "#ff0000", dir: "ltr", align: "left" },
    ]);
  });

  it("a right-to-left group is drawn as LOGICAL text with direction rtl, groups placed left to right", async () => {
    draws.length = 0;
    fakeCanvas([]);
    const text = "مرحبا بك";
    await layoutCanvasLines(
      {
        ...runSpec,
        text,
        align: "right",
        runs: [
          { s: 0, e: 6, font: "Georgia", bold: false, italic: false, size: 12, color: "#000000" },
          { s: 6, e: 8, font: "Georgia", bold: false, italic: false, size: 12, color: "#00ff00" },
        ],
      },
      png,
    );
    vi.unstubAllGlobals();
    // visual left to right: "بك" (the later word) first, then "مرحبا ";
    // 40 pt right-aligned in 200 pt: from 160 pt = 320 px
    expect(draws.map((d) => [d.t, d.dir, d.fill, d.x])).toEqual([
      ["بك", "rtl", "#00ff00", 320],
      ["مرحبا ", "rtl", "#000000", 340],
    ]);
  });

  it("loads every non-legacy face in one runtime call, then names each alias", async () => {
    f.log.length = 0;
    const al = await rasterAliases({ ...runSpec, fontId: "lib:Base" });
    expect(f.log).toEqual(["ensure:lib:Base,lib:Amiri", "face:lib:Base", "face:lib:Amiri"]);
    expect(al).toEqual({ base: "tf-alias", runs: [undefined, "tf-alias"] });
    f.log.length = 0;
    expect(await rasterAliases({ ...runSpec, runs: [runSpec.runs![0]!] })).toEqual({ runs: [undefined] });
    expect(f.log).toEqual([]);
  });
});
