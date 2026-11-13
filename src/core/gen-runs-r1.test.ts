// R1 for style runs on text generators (0.9.5): a text WITHOUT runs is
// measured, drawn, cleaned and sanitized exactly as before runs existed, with
// no new work. The literals below were captured from the code BEFORE runs
// were added, and must only change for a deliberate fix of a plain-text bug.
//
// The fake canvas measures every character differently and folds the whole
// font string into the width, so a changed font string, a changed line split
// or a changed rounding each moves a number.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../fonts", async () => (await import("../editor/media/fonts-fake.test-util")).fakeFonts);
// No plain text may reach the styled layout (added with runs).
const styled = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../editor/media/styled-text", async (orig) => {
  const real = await orig<Record<string, (...a: unknown[]) => unknown>>();
  const count =
    (f: (...a: unknown[]) => unknown) =>
    (...a: unknown[]) => {
      styled.calls++;
      return f(...a);
    };
  return { ...real, layoutStyledText: count(real.layoutStyledText!), measureStyledText: count(real.measureStyledText!), plainDelta: count(real.plainDelta!) };
});

/* ---------------- a canvas that measures by font and text ---------------- */

const widthOf = (font: string, text: string): number => {
  let fw = 0;
  for (let i = 0; i < font.length; i++) fw += font.charCodeAt(i) % 5;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += (text.charCodeAt(i) % 7) + 3.25;
  return w * (1 + fw / 400);
};

class Rec {
  log: string[] = [];
  canvas = { width: 640, height: 360 };
  private props: Record<string, unknown> = {};
  constructor() {
    return new Proxy(this, {
      get: (t, k: string) => {
        if (k === "log" || k === "canvas") return t[k as "log" | "canvas"];
        if (k === "measureText") return (s: string) => ({ width: widthOf(String(t.props.font ?? ""), s) });
        if (k in t.props) return t.props[k];
        return (...a: unknown[]) => {
          t.log.push(`${k}(${a.map((x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : JSON.stringify(x))).join(",")})`);
        };
      },
      set: (t, k: string, v: unknown) => {
        t.props[k] = v;
        t.log.push(`${k}=${JSON.stringify(v)}`);
        return true;
      },
    });
  }
}

const measureCtx = { font: "", measureText(s: string) { return { width: widthOf(this.font, s) }; } };
vi.stubGlobal("document", {
  createElement: () => ({ getContext: () => measureCtx }),
});

const { measureText, textFontRequests: videoFontRequests } = await import("../editor/media/generators");
const { drawLayer, textFontRequests: imageFontRequests } = await import("../image/render/composite");
const { addGeneratorLayer, cleanTextGen, layersOf } = await import("../image/layers");
const { createBlankImageProject } = await import("./image-project");
const { sanitizeMediaRef } = await import("./project");
import type { FontFamily, Generator, MediaRef } from "./types";

type TextGen = Extract<Generator, { type: "text" }>;

const FONTS: FontFamily[] = ["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact"];
const TEXTS = ["Title", "two\nlines é", "A\u{1F600}b\n\nend "];

const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Ab",
  fontFamily: "Georgia",
  sizePx: 37,
  color: "#123456",
  bold: false,
  italic: true,
  ...over,
});

describe("R1: a text without runs is untouched", () => {
  // Each test on its own: no plain text reaches the styled layout.
  beforeEach(() => {
    styled.calls = 0;
  });
  afterEach(() => {
    expect(styled.calls).toBe(0);
  });

  it("measureText answers what it answered before runs (6 fonts x 3 texts)", () => {
    const out = FONTS.flatMap((f, i) =>
      TEXTS.map((t, j) => {
        const b = measureText(gen({ fontFamily: f, text: t, sizePx: 20 + i * 7 + j, bold: (i + j) % 2 === 0, italic: j === 1 }));
        return `${f}|${j}|${b.width}x${b.height}`;
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      [
        "Segoe UI|0|30x26",
        "Segoe UI|1|50x54",
        "Segoe UI|2|30x84",
        "Arial|0|30x34",
        "Arial|1|48x70",
        "Arial|2|32x110",
        "Georgia|0|30x44",
        "Georgia|1|48x88",
        "Georgia|2|32x136",
        "Times New Roman|0|32x52",
        "Times New Roman|1|50x106",
        "Times New Roman|2|32x162",
        "Courier New|0|30x60",
        "Courier New|1|50x124",
        "Courier New|2|32x188",
        "Impact|0|32x70",
        "Impact|1|48x140",
        "Impact|2|32x214",
      ]
    `);
  });

  it("the image renderer draws a plain text with the same calls as before", () => {
    const blank = createBlankImageProject("R1", 640, 360, "transparent");
    const p = addGeneratorLayer(blank, gen({ text: "One\ntwo", fontFamily: "Arial", sizePx: 33 }), 120, 84, "Text").project;
    const l = layersOf(p)[0]!;
    const ctx = new Rec();
    drawLayer(ctx as never, p, l, {} as never, { zoom: 1.5, panX: 7, panY: 11 });
    expect(ctx.log).toMatchInlineSnapshot(`
      [
        "save()",
        "setTransform(1.5,0,0,1.5,397,218)",
        "beginPath()",
        "rect(0,0,120,84)",
        "clip()",
        "globalAlpha=1",
        "fillStyle="#123456"",
        "font="italic normal 33px Arial"",
        "textAlign="left"",
        "textBaseline="middle"",
        "fillText("One",0,20.625)",
        "fillText("two",0,61.875)",
        "restore()",
      ]
    `);
  });

  it("cleanTextGen keeps a clean text's reference", () => {
    const g = gen({ text: "x\ny" });
    expect(cleanTextGen(g).gen).toBe(g);
  });

  it("sanitizeMediaRef keeps a 0.9.4 text's reference, with and without a font id", () => {
    for (const g of [gen(), gen({ fontId: "lib:Test Sans" })]) {
      const m: MediaRef = { id: "m", path: "Text", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 40, height: 50, generator: g };
      expect(sanitizeMediaRef(m)).toBe(m);
    }
  });

  it("a project with only the six fonts asks for no font", () => {
    const media = FONTS.map((f) => ({ generator: gen({ fontFamily: f }) as Generator }));
    expect(videoFontRequests(media)).toEqual([]);
    const blank = createBlankImageProject("R1", 640, 360, "transparent");
    let p = blank;
    for (const f of FONTS) p = addGeneratorLayer(p, gen({ fontFamily: f }), 40, 50, "Text").project;
    expect(imageFontRequests(layersOf(p))).toEqual([]);
  });

});

describe("a video text carries its styled parts unused", () => {
  it("asks only for its base font: a font only a styled part names is neither loaded nor reported", () => {
    const g = gen({ fontFamily: "Arial", runs: [{ s: 0, e: 1, font: "Georgia", fontId: "lib:Gone" }] });
    expect(videoFontRequests([{ generator: g }])).toEqual([]);
    const lib = gen({ fontFamily: "Arial", fontId: "lib:Base Sans", runs: [{ s: 0, e: 1, font: "Georgia", fontId: "lib:Gone" }] });
    expect(videoFontRequests([{ generator: lib }]).map((r) => r.id)).toEqual(["lib:Base Sans"]);
  });
});
