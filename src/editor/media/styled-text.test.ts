// The styled-text layout (0.9.5) with an injected measurer whose widths and
// font boxes differ per font, so a unit measured in the wrong font, a row
// height taken from the wrong piece or a paint boundary off by one character
// each moves a number:
//   Arial      0.5 x size per UTF-16 unit, ascent 0.91, descent 0.21
//   Georgia    0.62,                       0.89,        0.25
//   library    0.7,                        0.93,        0.22  (alias "tf-…")

import { describe, expect, it, vi } from "vitest";

vi.mock("../../fonts", async () => (await import("./fonts-fake.test-util")).fakeFonts);

const { layoutStyledText, measureStyledText, paintStyledText, plainDelta } = await import("./styled-text");
import type { TextMeasurer } from "./styled-text";
import type { Generator, PdfTextRun } from "../../core/types";

type TextGen = Extract<Generator, { type: "text" }>;

const specOf = (font: string): { k: number; asc: number; desc: number } => {
  if (font.includes("tf-")) return { k: 0.7, asc: 0.93, desc: 0.22 };
  if (font.includes("Georgia")) return { k: 0.62, asc: 0.89, desc: 0.25 };
  return { k: 0.5, asc: 0.91, desc: 0.21 };
};
const pxOf = (font: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);

function measurer(): TextMeasurer & { widthCalls: [string, string][] } {
  const widthCalls: [string, string][] = [];
  return {
    widthCalls,
    width(font, text) {
      widthCalls.push([font, text]);
      return text.length * specOf(font).k * pxOf(font);
    },
    metrics(font) {
      const s = specOf(font);
      const px = pxOf(font);
      return { asc: s.asc * px, desc: s.desc * px, mid: 0.31 * px };
    },
  };
}

const TEXT = "A\u{1F600}bc de\nFég hij";
const RUN1: PdfTextRun = { s: 1, e: 5, size: 64, c: "#aa5500" };
const RUN2: PdfTextRun = { s: 9, e: 13, font: "Georgia", fontId: "lib:Test Sans", bold: true };
const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: TEXT,
  fontFamily: "Arial",
  sizePx: 40,
  color: "#112233",
  bold: false,
  italic: true,
  runs: [RUN1, RUN2],
  ...over,
});

describe("layoutStyledText", () => {
  it("groups units by font, places them, and sizes rows by rowMetrics", () => {
    const l = layoutStyledText(gen(), measurer());
    expect(l.rows).toHaveLength(2);
    const [r1, r2] = l.rows;
    expect(r1!.units.map((u) => [u.text, u.x, u.w, u.size])).toEqual([
      ["A", 0, 20, 40],
      ["\u{1F600}bc", 20, 128, 64],
      [" de", 148, 60, 40],
    ]);
    expect(r1!.units[1]!.paints).toEqual([{ x0: 20, x1: 148, color: "#aa5500" }]);
    // the 64 px piece decides both extremes: its own 1.25 line
    expect(r1!.height).toBe(80);
    expect(r1!.height).not.toBe(40 * 1.25);
    expect(r1!.baseline).toBeCloseTo(62.4, 9);
    expect(r2!.top).toBe(80);
    expect(r2!.units.map((u) => [u.text, u.x, u.w])).toEqual([
      ["Fég ", 0, 112],
      ["hij", 112, 60],
    ]);
    // the library piece's ascent (39.2) over the strut's descent (11)
    expect(r2!.height).toBeCloseTo(50.2, 9);
    expect(r2!.baseline).toBeCloseTo(39.2, 9);
    expect(l.width).toBe(208);
    expect(l.height).toBe(132);
    expect(measureStyledText(gen(), measurer())).toEqual({ width: 208, height: 132 });
  });

  it("a colour-only run is one unit with two paints and the plain row height", () => {
    const g = gen({ text: "Hello world", runs: [{ s: 6, e: 11, c: "#ff0000" }] });
    const l = layoutStyledText(g, measurer());
    expect(l.rows[0]!.units).toHaveLength(1);
    expect(l.rows[0]!.units[0]!.paints).toEqual([
      { x0: 0, x1: 120, color: "#112233" },
      { x0: 120, x1: 220, color: "#ff0000" },
    ]);
    expect(l.rows[0]!.height).toBe(50);
  });

  it("an empty row has the strut's height", () => {
    const l = layoutStyledText(gen({ text: "a\n\nb", runs: [{ s: 0, e: 1, size: 80 }] }), measurer());
    expect(l.rows.map((r) => r.height)).toEqual([100, 50, 50]);
    expect(l.rows[1]!.units).toEqual([]);
  });

  it("measures a merged unit with ONE width call", () => {
    const m = measurer();
    layoutStyledText(gen({ text: "AV", runs: [{ s: 1, e: 2, c: "#00ff00" }] }), m);
    expect(m.widthCalls.filter(([, t]) => t === "AV")).toHaveLength(1);
    expect(m.widthCalls.filter(([, t]) => t === "A")).toHaveLength(1);
  });
});

describe("measureText", () => {
  it("measures a styled text by its layout, a plain one as before", async () => {
    const { measureText } = await import("./generators");
    const g = gen({ text: "ab\ncd", runs: [{ s: 0, e: 2, size: 64 }] });
    // no DOM here: both use their size-based estimate; the 64 px row is taller
    expect(measureText(g)).toEqual(measureStyledText(g));
    expect(measureText(g).height).toBe(80 + 50);
    const plain = { ...g };
    delete plain.runs;
    expect(measureText(plain).height).toBe(100);
  });
});

describe("plainDelta", () => {
  it("moves the strut baseline onto the plain middle-baseline row", () => {
    // plain: 0.5 * 50 + 0.31 * 40 = 37.4; strut baseline 39
    expect(plainDelta(gen(), measurer())).toBeCloseTo(37.4 - 39, 9);
  });
});

describe("paintStyledText", () => {
  it("one fillText per one-colour unit, clipped fills for a multi-colour one", () => {
    const log: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => void log.push(`${k}(${a.map((x) => (typeof x === "number" ? Math.round(x * 100) / 100 : String(x))).join(",")})`)),
      set: (t, k: string, v) => {
        t[k] = v;
        if (k === "fillStyle" || k === "font") log.push(`${k}=${String(v)}`);
        return true;
      },
    });
    const l = layoutStyledText(gen({ text: "Hi yo", runs: [{ s: 3, e: 5, c: "#ff0000" }] }), measurer());
    paintStyledText(ctx as never, l, -1.5);
    // baseline 39 + delta -1.5
    expect(log).toEqual([
      "font=italic normal 40px Arial",
      "save()",
      "beginPath()",
      "rect(-1000000,-50,1000060,150)",
      "clip()",
      "fillStyle=#112233",
      "fillText(Hi yo,0,37.5)",
      "restore()",
      "save()",
      "beginPath()",
      "rect(60,-50,1000040,150)",
      "clip()",
      "fillStyle=#ff0000",
      "fillText(Hi yo,0,37.5)",
      "restore()",
    ]);
  });

  it("a unit with very many colours is measured and drawn slice by slice, in linear work", () => {
    // 20000 units in one font, 2000 colour runs alternating with the base colour
    const runs: PdfTextRun[] = [];
    for (let i = 0; i < 2000; i++) runs.push({ s: i * 10, e: i * 10 + 5, c: "#ff0000" });
    const text = "x".repeat(20_000);
    const m = measurer();
    const l = layoutStyledText(gen({ text, italic: false, runs }), m);
    const u = l.rows[0]!.units;
    expect(u).toHaveLength(1);
    expect(u[0]!.paints).toHaveLength(4000);
    // the whole unit once, then each slice once: about twice the length
    expect(m.widthCalls.reduce((n, [, t]) => n + t.length, 0)).toBeLessThanOrEqual(2 * text.length + 4);
    expect(u[0]!.paints[1]).toEqual({ x0: 100, x1: 200, color: "#112233", text: "xxxxx" });
    let drawn = 0;
    let clips = 0;
    const ctx = {
      set font(_v: string) {},
      set fillStyle(_v: string) {},
      textAlign: "",
      textBaseline: "",
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {
        clips++;
      },
      fillText(t: string) {
        drawn += t.length;
      },
    };
    paintStyledText(ctx as never, l, 0);
    expect(drawn).toBe(text.length);
    expect(clips).toBe(0);
  });
});
