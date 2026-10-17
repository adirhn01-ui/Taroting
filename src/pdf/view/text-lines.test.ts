import { describe, expect, it } from "vitest";
import { buildLines, canvasPatch, lineAt, linesIn, mapFont, paperAndInk, paragraphAround, paragraphOf } from "./text-lines";
import type { TextItemLite } from "./math";

const VIEW = [0, 0, 600, 800];
const STYLES = { f1: { ascent: 0.75, descent: -0.25 }, f2: { ascent: 0.8, descent: -0.2 } };
const item = (str: string, size: number, x: number, baseline: number, width: number, o: Partial<TextItemLite> = {}): TextItemLite => ({
  str,
  transform: [size, 0, 0, size, x, baseline],
  width,
  fontName: "f1",
  dir: "ltr",
  ...o,
});

describe("buildLines", () => {
  it("groups runs on one baseline into a line, in x order, with word spaces from the gaps", () => {
    // content order scrambled; two different sizes, x and baselines that differ
    const lines = buildLines(
      [item("world", 10, 105, 700, 30), item("Hello", 14, 60, 701, 40), item("", 12, 60, 700, 0), item(" ", 12, 100, 700, 5)],
      VIEW,
      STYLES,
    );
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    expect(l.text).toBe("Hello world");
    expect(l.items.map((i) => i.item.str)).toEqual(["Hello", "world"]);
    expect(l.size).toBe(12); // median of 14 and 10
    // union: x 60..135; top = 800-701-0.75*14 = 88.5; bottom = 800-700+0.25*10 = 102.5
    expect(l.rect[0]).toBeCloseTo(60, 6);
    expect(l.rect[0] + l.rect[2]).toBeCloseTo(135, 6);
    expect(l.rect[1]).toBeCloseTo(88.5, 6);
    expect(l.rect[1] + l.rect[3]).toBeCloseTo(102.5, 6);
  });

  it("does not insert a space between touching runs", () => {
    const [l] = buildLines([item("Tar", 12, 60, 700, 20), item("oting", 12, 80.5, 700, 30)], VIEW, STYLES);
    expect(l!.text).toBe("Taroting");
  });

  it("splits lines by baseline and two columns on one baseline", () => {
    const lines = buildLines(
      [item("Left top", 12, 50, 700, 60), item("Right top", 12, 350, 700, 60), item("Left next", 12, 50, 685, 60)],
      VIEW,
      STYLES,
    );
    expect(lines.map((l) => l.text)).toEqual(["Left top", "Right top", "Left next"]);
  });

  it("keeps a superscript on its line", () => {
    const lines = buildLines([item("E = mc", 12, 50, 700, 40), item("2", 7, 90, 704, 4)], VIEW, STYLES);
    expect(lines).toHaveLength(1);
  });

  it("an rtl line reads right to left (logical order)", () => {
    const lines = buildLines(
      [item("שלום", 12, 200, 700, 30, { dir: "rtl" }), item("עולם", 12, 160, 700, 30, { dir: "rtl" })],
      VIEW,
      STYLES,
    );
    expect(lines[0]!.rtl).toBe(true);
    expect(lines[0]!.text).toBe("שלום עולם");
  });

  it("groups text turned 90 degrees along its own baseline", () => {
    // reads bottom to top: direction (0,1); two runs on the same vertical baseline x=100
    const up = (str: string, y: number, w: number): TextItemLite => ({ str, transform: [0, 12, -12, 0, 100, y], width: w, fontName: "f1" });
    const lines = buildLines([up("two", 340, 20), up("one", 300, 25)], VIEW, STYLES);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("one two");
    // the box is tall and narrow
    expect(lines[0]!.rect[3]).toBeGreaterThan(lines[0]!.rect[2]);
  });
});

describe("lineAt / linesIn / paragraphOf", () => {
  const lines = buildLines([item("First line", 12, 50, 700, 80), item("Second line", 12, 50, 680, 90), item("Far", 12, 400, 400, 20)], VIEW, STYLES);
  // first: y 91..103, second: y 111..123

  it("picks the line containing the point, the nearest within 3 pt, nothing beyond", () => {
    expect(lineAt(lines, 60, 95)?.text).toBe("First line");
    expect(lineAt(lines, 60, 105)?.text).toBe("First line"); // 2 pt below
    expect(lineAt(lines, 60, 109.5)?.text).toBe("Second line"); // 1.5 pt above
    expect(lineAt(lines, 60, 80)).toBeNull(); // 11 pt above
    expect(lineAt(lines, 200, 95)).toBeNull(); // right of the line by 70 pt
  });

  it("a rect picks every line it overlaps; the paragraph joins them with newlines", () => {
    const picked = linesIn(lines, [40, 100, 30, 15]);
    expect(picked.map((l) => l.text)).toEqual(["First line", "Second line"]);
    const p = paragraphOf(picked)!;
    expect(p.text).toBe("First line\nSecond line");
    expect(p.rects).toHaveLength(2);
    expect(p.box[0]).toBeCloseTo(49, 6);
    expect(p.box[1]).toBeCloseTo(90, 6);
    expect(p.box[0] + p.box[2]).toBeCloseTo(141, 6);
    expect(p.box[1] + p.box[3]).toBeCloseTo(124, 6);
    expect(p.fontName).toBe("f1");
    expect(p.rtl).toBe(false);
    // a negative-size drag (right to left, bottom to top) picks the same
    expect(linesIn(lines, [70, 115, -30, -15]).length).toBe(2);
  });

  it("paragraph size is the median run size; the font is the one of most characters", () => {
    const ls = buildLines([item("ab", 10, 50, 700, 10), item("cdefgh", 20, 70, 700, 60, { fontName: "f2" }), item("ij", 11, 140, 700, 10)], VIEW, STYLES);
    const p = paragraphOf(ls)!;
    expect(p.size).toBe(11);
    expect(p.fontName).toBe("f2");
    expect(paragraphOf([])).toBeNull();
  });
});

describe("mapFont", () => {
  it.each([
    [{ names: ["Helvetica"] }, "Arial", false, false],
    [{ names: ["Times-Bold"] }, "Times New Roman", true, false],
    [{ names: ["Courier-Oblique"] }, "Courier New", false, true],
    [{ names: ["Georgia-BoldItalic"] }, "Georgia", true, true],
    [{ names: ["Impact"] }, "Impact", false, false],
    [{ names: ["MicrosoftSansSerif"] }, "Arial", false, false],
    [{ names: ["Garamond-Semibold"] }, "Times New Roman", true, false],
    [{ names: ["Consolas"] }, "Courier New", false, false],
    [{ names: ["g_d0_f1"], family: "serif" }, "Times New Roman", false, false],
    [{ names: ["g_d0_f2"], family: "monospace", bold: true }, "Courier New", true, false],
    [{ family: "sans-serif", italic: true }, "Arial", false, true],
    [{ names: ["Calibri"], weight: "bold", style: "italic" }, "Arial", true, true],
    [{ names: ["Segoe"], weight: 600 }, "Arial", true, false],
    [{}, "Arial", false, false],
  ] as const)("%j → %s bold=%s italic=%s", (info, font, bold, italic) => {
    expect(mapFont(info as never)).toEqual({ font, bold, italic });
  });
});

describe("paperAndInk", () => {
  /** w×h RGBA patch, filled by fn(x, y) → [r, g, b] */
  const patch = (w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, g, b] = fn(x, y);
        d.set([r, g, b, 255], (y * w + x) * 4);
      }
    return d;
  };

  it("paper from the ring, ink from the strongest inner pixels (antialiased edges ignored)", () => {
    // cream paper, dark-blue glyph cores, MANY lighter antialias pixels around them
    const paper: [number, number, number] = [250, 244, 230];
    const core: [number, number, number] = [20, 30, 120];
    const edge = (t: number): [number, number, number] => [0, 1, 2].map((i) => paper[i]! + (core[i]! - paper[i]!) * t) as [number, number, number];
    const d = patch(40, 20, (x, y) => {
      if (x < 4 || x >= 36 || y < 4 || y >= 16) return paper;
      if (x % 4 === 0) return core;
      if (x % 4 === 1 || x % 4 === 3) return edge(0.4);
      return edge(0.2);
    });
    const r = paperAndInk(d, 40, 20, [4, 4, 36, 16]);
    expect(r.paper).toBe("#faf4e6");
    expect(r.ink).toBe("#141e78");
  });

  it("the ring's most common colour wins over a neighbouring line's descenders", () => {
    const d = patch(30, 20, (x, y) => (y < 2 && x < 8 ? [0, 0, 0] : y >= 5 && y < 15 && x >= 5 && x < 25 && x % 3 === 0 ? [200, 0, 0] : [255, 255, 255]));
    const r = paperAndInk(d, 30, 20, [5, 5, 25, 15]);
    expect(r.paper).toBe("#ffffff");
    expect(r.ink).toBe("#c80000");
  });

  it("no text standing out → black ink; no ring → paper from the whole patch", () => {
    const flat = patch(10, 10, () => [240, 240, 240]);
    expect(paperAndInk(flat, 10, 10, [2, 2, 8, 8])).toEqual({ paper: "#f0f0f0", ink: "#000000" });
    expect(paperAndInk(flat, 10, 10, [0, 0, 10, 10]).paper).toBe("#f0f0f0");
  });
});

describe("canvasPatch", () => {
  it("maps a page rect to backing px with the paper ring, at the canvas's own scale", () => {
    // 600x800 page, canvas painted at 2 px per point (zoom 1, dpr 2)
    const p = canvasPatch([100, 200, 50, 10], 600, 800, 0, 1200, 1600)!;
    expect(p).toEqual({ x: 196, y: 396, w: 108, h: 28, inner: [4, 4, 104, 24] });
  });

  it("turned 90 degrees: the page's top-left lands at the canvas's top-right", () => {
    // box is 800 wide, 600 tall; canvas at 1 px/pt
    const p = canvasPatch([0, 0, 10, 20], 600, 800, 90, 800, 600, 0)!;
    // page x 0..10 → box y 0..10; page y 0..20 → box x 780..800
    expect(p).toEqual({ x: 780, y: 0, w: 20, h: 10, inner: [0, 0, 20, 10] });
  });

  it("clamps to the canvas; null when the rect is off it", () => {
    const p = canvasPatch([-5, -5, 10, 10], 600, 800, 0, 600, 800)!;
    expect([p.x, p.y]).toEqual([0, 0]);
    expect(canvasPatch([700, 900, 10, 10], 600, 800, 0, 600, 800)).toBeNull();
  });
});

describe("paragraphAround", () => {
  // Column at x=50, 11 pt text, 14 pt leading; a blank-line gap (28) between
  // the paragraphs, a heading above, a second column to the right, and a
  // smaller footnote right under the last paragraph line.
  const L = (str: string, base: number, w = 300, x = 50, size = 11) => item(str, size, x, base, w);
  const lines = buildLines(
    [
      L("Heading", 760, 120, 50, 20),
      L("First para line one", 720),
      L("first para line two", 706),
      L("first para end.", 692, 150),
      L("Second para line one", 664),
      L("second para line two", 650),
      L("tiny footnote", 636, 300, 50, 7),
      L("Other column text", 706, 150, 420),
    ],
    VIEW,
    STYLES,
  );
  const byText = (t: string) => lines.find((l) => l.text === t)!;
  const texts = (ls: { text: string }[]) => ls.map((l) => l.text);

  it("walks up and down through one paragraph, stopping at the blank-line gap", () => {
    expect(texts(paragraphAround(lines, byText("first para line two")))).toEqual(["First para line one", "first para line two", "first para end."]);
    expect(texts(paragraphAround(lines, byText("First para line one")))).toEqual(["First para line one", "first para line two", "first para end."]);
  });

  it("stops at a size change (footnote below, heading above) and never takes the other column", () => {
    expect(texts(paragraphAround(lines, byText("Second para line one")))).toEqual(["Second para line one", "second para line two"]);
    expect(texts(paragraphAround(lines, byText("Heading")))).toEqual(["Heading"]);
    expect(texts(paragraphAround(lines, byText("Other column text")))).toEqual(["Other column text"]);
  });

  it("a one-line paragraph: the blank-line gap (> 1.6x the size) is never the first gap", () => {
    const ls = buildLines([L("Lone line", 720), L("Next para", 692), L("goes on", 678)], VIEW, STYLES);
    expect(texts(paragraphAround(ls, ls[0]!))).toEqual(["Lone line"]);
    expect(texts(paragraphAround(ls, ls[1]!))).toEqual(["Next para", "goes on"]);
  });

  it("an uneven gap (> 35% off the first one) ends the paragraph", () => {
    const ls = buildLines([L("a one", 720), L("b two", 708), L("c three", 691.5)], VIEW, STYLES);
    // 12 then 16.5 (+37.5%, still under 1.6 x 11): stop
    expect(texts(paragraphAround(ls, ls[0]!))).toEqual(["a one", "b two"]);
  });

  it("soft join: wraps become spaces; a short line before a capital stays a hard break", () => {
    const ls = buildLines([L("Para one wraps", 720), L("onto here.", 706, 100), L("Then a new one", 692), L("and more", 678)], VIEW, STYLES);
    const all = paragraphAround(ls, ls[1]!);
    expect(all).toHaveLength(4);
    expect(paragraphOf(all, { soft: true })!.text).toBe("Para one wraps onto here.\nThen a new one and more");
    // without soft: every line break kept
    expect(paragraphOf(all)!.text).toBe("Para one wraps\nonto here.\nThen a new one\nand more");
    // a short line followed by lower case is still a soft wrap
    const ls2 = buildLines([L("Short", 720, 100), L("continues here", 706)], VIEW, STYLES);
    expect(paragraphOf(paragraphAround(ls2, ls2[0]!), { soft: true })!.text).toBe("Short continues here");
  });
});
