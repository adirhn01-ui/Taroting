// The crop ghost's text paint (select-tool.ts paintTextGhost), through a
// call-recording Canvas2D double. A text with styled parts must draw exactly
// what the compositor draws for it (same fonts, colours, positions, clips);
// a text without them keeps the calls it always made.
//
// Fixture: "Hello\nworld" in Georgia 30 px #abcdef; [6, 11) "world" carries
// a 64 px run in #ff3300, so a unit drawn in the base size, a colour from
// the base, or a baseline from the plain 1.25 step each moves a call.

import { describe, expect, it, vi } from "vitest";

vi.mock("../fonts", async () => (await import("../editor/media/fonts-fake.test-util")).fakeFonts);

const pxOf = (font: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
const fakeMeasurer = {
  width: (font: string, text: string) => text.length * 0.55 * pxOf(font),
  metrics: (font: string) => ({ asc: 0.93 * pxOf(font), desc: 0.23 * pxOf(font), mid: 0.29 * pxOf(font) }),
};
vi.mock("../editor/media/styled-text", async (orig) => {
  const real = await orig<typeof import("../editor/media/styled-text")>();
  return { ...real, textMeasurer: () => fakeMeasurer };
});

const { paintTextGhost } = await import("./select-tool");
const { drawLayer } = await import("./render/composite");
const { addGeneratorLayer, layersOf } = await import("./layers");
const { createBlankImageProject } = await import("../core/image-project");
const { fontString } = await import("../editor/media/generators");
import type { Generator, PdfTextRun } from "../core/types";

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

const RUN: PdfTextRun = { s: 6, e: 11, size: 64, c: "#ff3300" };
const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Hello\nworld",
  fontFamily: "Georgia",
  sizePx: 30,
  color: "#abcdef",
  bold: false,
  italic: false,
  ...over,
});

function ghost(g: TextGen): string[] {
  const r = new Rec();
  paintTextGhost(r as never, g);
  return r.log;
}

/** What the compositor draws for `g`, its crop clip (the first rect and
 *  clip) and its own transform / alpha left out. */
function composited(g: TextGen): string[] {
  const blank = createBlankImageProject("S", 640, 360, "transparent");
  const p = addGeneratorLayer(blank, g, 211, 157, "Text").project;
  const r = new Rec();
  drawLayer(r as never, p, layersOf(p)[0]!, {} as never, { zoom: 1, panX: 0, panY: 0 });
  const log = r.log.filter((x) => /^(font=|fillStyle=|fillText|rect|clip|textBaseline=|textAlign=|save|restore|beginPath)/.test(x));
  const cut = log.indexOf("clip()");
  // the crop clip and the save that wraps the whole layer
  return log.slice(cut + 1).filter((x, i, a) => !(x === "restore()" && i === a.length - 1));
}

describe("the crop ghost of a text layer", () => {
  it("a text without runs keeps its calls exactly: base font, middle baseline, one fillText per line", () => {
    const g = gen();
    expect(ghost(g)).toEqual([
      `font=${JSON.stringify(fontString(g))}`,
      'fillStyle="#abcdef"',
      'textBaseline="middle"',
      'fillText("Hello",0,18.75)',
      'fillText("world",0,56.25)',
    ]);
  });

  it("a text with runs draws what the compositor draws for it", () => {
    const g = gen({ runs: [RUN] });
    const log = ghost(g);
    expect(log).toEqual(composited(g));
    // the run's own size and colour reach the canvas
    expect(log).toContain('fillStyle="#ff3300"');
    expect(log.some((x) => x.startsWith("font=") && x.includes("64px"))).toBe(true);
    expect(log).not.toContain('textBaseline="middle"');
  });

  it("a colour-only run is clipped side by side, as on the canvas", () => {
    const g = gen({ text: "ab cd", runs: [{ s: 3, e: 5, c: "#00ff00" }] });
    const log = ghost(g);
    expect(log).toEqual(composited(g));
    expect(log.filter((x) => x.startsWith("fillText"))).toHaveLength(2);
  });

  it("a right-to-left text with runs is drawn plain, as the compositor draws it", () => {
    const g = gen({ text: "Hello\nwאrld", runs: [RUN] });
    expect(ghost(g)).toEqual([
      `font=${JSON.stringify(fontString(g))}`,
      'fillStyle="#abcdef"',
      'textBaseline="middle"',
      'fillText("Hello",0,18.75)',
      'fillText("wאrld",0,56.25)',
    ]);
  });
});
