// A text layer with styled parts on the image canvas (0.9.5), through a
// call-recording Canvas2D double and an injected measurer (Arial 0.5 x size
// per character, ascent 0.91, descent 0.21, alphabetic 0.31 x size below the
// middle). The plain path's calls are pinned in core/gen-runs-r1.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../fonts", async () => (await import("../../editor/media/fonts-fake.test-util")).fakeFonts);

const layouts = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../editor/media/styled-text", async (orig) => {
  const real = await orig<typeof import("../../editor/media/styled-text")>();
  const pxOf = (font: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
  const m = {
    width: (font: string, text: string) => text.length * 0.5 * pxOf(font),
    metrics: (font: string) => ({ asc: 0.91 * pxOf(font), desc: 0.21 * pxOf(font), mid: 0.31 * pxOf(font) }),
  };
  return {
    ...real,
    textMeasurer: () => m,
    layoutStyledText: (...a: Parameters<typeof real.layoutStyledText>) => {
      layouts.calls++;
      return real.layoutStyledText(...a);
    },
  };
});

const { drawLayer, textFontRequests } = await import("./composite");
const { addGeneratorLayer, layersOf } = await import("../layers");
const { createBlankImageProject } = await import("../../core/image-project");
import type { Generator, PdfTextRun } from "../../core/types";

type TextGen = Extract<Generator, { type: "text" }>;

class Rec {
  log: string[] = [];
  canvas = { width: 640, height: 360 };
  private props: Record<string, unknown> = {};
  constructor() {
    return new Proxy(this, {
      get: (t, k: string) => {
        if (k === "log" || k === "canvas") return t[k as "log" | "canvas"];
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

const gen = (text: string, runs: PdfTextRun[], over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text,
  fontFamily: "Arial",
  sizePx: 40,
  color: "#112233",
  bold: false,
  italic: false,
  runs,
  ...over,
});

function draw(g: TextGen): string[] {
  const blank = createBlankImageProject("S", 640, 360, "transparent");
  const p = addGeneratorLayer(blank, g, 200, 140, "Text").project;
  const ctx = new Rec();
  drawLayer(ctx as never, p, layersOf(p)[0]!, {} as never, { zoom: 1, panX: 0, panY: 0 });
  return ctx.log;
}

describe("a styled text on the canvas", () => {
  it("draws each unit at its layout position, baselines moved by delta", () => {
    // row 1: "ab" 40 px, "cd" 80 px; row 2: "e" 40 px.
    // strut baseline 39 (40 px), 80 px piece: A = (100 - 89.6) / 2 + 72.8 = 78
    // delta = 0.5 * 50 + 12.4 - 39 = -1.6
    const log = draw(gen("abcd\ne", [{ s: 2, e: 4, size: 80 }]));
    const text = log.filter((x) => /^(font=|fillStyle=|fillText|rect|clip)/.test(x));
    expect(text).toEqual([
      "rect(0,0,200,140)",
      "clip()",
      'font="normal normal 40px Arial"',
      'fillStyle="#112233"',
      'fillText("ab",0,76.4)',
      'font="normal normal 80px Arial"',
      'fillStyle="#112233"',
      'fillText("cd",40,76.4)',
      'font="normal normal 40px Arial"',
      'fillStyle="#112233"',
      'fillText("e",0,137.4)',
    ]);
    expect(log).toContain('textBaseline="alphabetic"');
  });

  it("clips only a unit of several colours", () => {
    const log = draw(gen("ab cd", [{ s: 3, e: 5, c: "#ff0000" }]));
    expect(log.filter((x) => x.startsWith("fillText"))).toEqual(['fillText("ab cd",0,37.4)', 'fillText("ab cd",0,37.4)']);
    expect(log.filter((x) => x.startsWith("rect"))).toEqual(["rect(0,0,200,140)", "rect(-1000000,-50,1000060,150)", "rect(60,-50,1000040,150)"]);
  });

  it("a right-to-left text keeps the plain path", () => {
    const log = draw(gen("ab א", [{ s: 0, e: 2, c: "#ff0000" }]));
    expect(log).toContain('textBaseline="middle"');
    expect(log.filter((x) => x.startsWith("fillText"))).toEqual(['fillText("ab א",0,25)']);
  });

  it("lays a generator out once, whatever the frames", () => {
    const g = gen("xy", [{ s: 0, e: 1, size: 60 }]);
    const blank = createBlankImageProject("S", 640, 360, "transparent");
    const p = addGeneratorLayer(blank, g, 200, 140, "Text").project;
    const before = layouts.calls;
    for (let i = 0; i < 3; i++) drawLayer(new Rec() as never, p, layersOf(p)[0]!, {} as never, { zoom: 1, panX: 0, panY: 0 });
    expect(layouts.calls - before).toBe(1);
  });

  it("asks for the run fonts", () => {
    const blank = createBlankImageProject("S", 640, 360, "transparent");
    const p = addGeneratorLayer(blank, gen("xy", [{ s: 0, e: 1, font: "Georgia", fontId: "lib:Run", italic: true }]), 20, 20, "Text").project;
    expect(textFontRequests(layersOf(p))).toEqual([{ id: "lib:Run", bold: false, italic: true }]);
  });
});
