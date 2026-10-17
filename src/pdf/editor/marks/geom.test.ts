import { describe, expect, it } from "vitest";
import type { PdfAnnot, PdfRotation } from "../../../core/types";
import { decodePoints, encodePoints } from "../../../image/strokes";
import { pageToBox, boxSize } from "../../view/math";
import { LINE_HEIGHT as EXPORT_LINE_HEIGHT, wrapParagraph } from "../../export/layout";
import { SIGNATURE_WIDTH_FRACTION as EXPORT_SIG_FRACTION } from "../../export/marks";
import { annotBounds, scaleAnnot } from "../../model";
import {
  LINE_HEIGHT,
  RULER_THICK,
  SIGNATURE_WIDTH_FRACTION,
  applyPageTransform,
  boxPoints,
  clampSize,
  cssToPt,
  fitCentered,
  handleAt,
  layoutText,
  lineBaseline,
  marqueeHits,
  normalizeSignature,
  pageTransform,
  resizeBox,
  rulerEdge,
  snapToRuler,
  stepSize,
  sweepHit,
  topmostAt,
  unionBounds,
} from "./geom";
import { eraserHits } from "./draw";

const ink = (id: string, pts: number[], w = 2, kind: "pen" | "pencil" | "marker" = "pen"): PdfAnnot => ({
  id,
  t: "ink",
  kind,
  c: "#000000",
  w,
  o: 1,
  p: encodePoints(new Float32Array(pts)),
});
const white = (id: string, x: number, y: number, w: number, h: number): PdfAnnot => ({ id, t: "whiteout", x, y, w, h, c: "#ffffff" });

describe("page-space framing", () => {
  const W = 612;
  const H = 792;
  for (const rot of [0, 90, 180, 270] as PdfRotation[]) {
    it(`the SVG transform turns page space exactly like the view at ${rot}°`, () => {
      for (const [x, y] of [
        [0, 0],
        [W, 0],
        [0, H],
        [100, 250],
        [W, H],
      ] as const) {
        const v = pageToBox(x, y, W, H, rot, 1);
        const s = applyPageTransform(x, y, W, H, rot);
        expect(s.x).toBeCloseTo(v.x, 9);
        expect(s.y).toBeCloseTo(v.y, 9);
      }
      const b = boxPoints(W, H, rot);
      const v = boxSize(W, H, rot, 1);
      expect([b.W, b.H]).toEqual([v.W, v.H]);
    });
  }

  it("writes the matrix the point map describes", () => {
    expect(pageTransform(612, 792, 0)).toBe("");
    expect(pageTransform(612, 792, 90)).toBe("matrix(0 1 -1 0 792 0)");
    expect(pageTransform(612, 792, 180)).toBe("matrix(-1 0 0 -1 612 792)");
    expect(pageTransform(612, 792, 270)).toBe("matrix(0 -1 1 0 0 612)");
  });
});

describe("sizes", () => {
  it("tool sizes are css px at the zoom; marks store points", () => {
    expect(cssToPt(4, 2)).toBe(2);
    expect(cssToPt(4, 0.5)).toBe(8);
    expect(cssToPt(4, 0)).toBe(4);
  });
  it("[ and ] step a px while small, then by a fifth", () => {
    expect(stepSize(4, true)).toBe(5);
    expect(stepSize(4, false)).toBe(3);
    expect(stepSize(50, true)).toBe(60);
    expect(stepSize(60, false)).toBe(50);
    expect(stepSize(1, false)).toBe(1);
    expect(stepSize(200, true)).toBe(200);
    expect(clampSize(NaN)).toBe(1);
  });
});

describe("hit testing", () => {
  const line = ink("i", [0, 0, 1, 100, 0, 1], 4);
  it("ink is hit along its line within half its width (+ reach)", () => {
    expect(sweepHit(line, 50, 1.9, 50, 1.9, 0)).toBe(true);
    expect(sweepHit(line, 50, 2.1, 50, 2.1, 0)).toBe(false);
    expect(sweepHit(line, 50, 5, 50, 5, 3.1)).toBe(true);
    // a sweep that crosses it between samples
    expect(sweepHit(line, 50, -20, 50, 20, 0)).toBe(true);
  });
  it("the pencil reaches 1.5 × its width", () => {
    const p = ink("p", [0, 0, 1, 100, 0, 1], 4, "pencil");
    expect(sweepHit(p, 50, 2.9, 50, 2.9, 0)).toBe(true);
    expect(sweepHit(p, 50, 3.1, 50, 3.1, 0)).toBe(false);
  });
  it("a rectangle shape is hit on its outline, not inside", () => {
    const r: PdfAnnot = { id: "r", t: "rect", c: "#000000", w: 2, a: [0, 0], b: [100, 100] };
    expect(sweepHit(r, 0.5, 50, 0.5, 50, 0)).toBe(true);
    expect(sweepHit(r, 50, 50, 50, 50, 1)).toBe(false);
  });
  it("box marks and highlights are hit anywhere inside", () => {
    expect(sweepHit(white("w", 10, 10, 20, 20), 20, 20, 20, 20, 0)).toBe(true);
    expect(sweepHit(white("w", 10, 10, 20, 20), 35, 20, 35, 20, 4)).toBe(false);
    expect(sweepHit(white("w", 10, 10, 20, 20), 35, 20, 35, 20, 5)).toBe(true);
    const h: PdfAnnot = { id: "h", t: "highlight", c: "#ffd400", o: 1, rects: [[0, 0, 10, 10], [50, 0, 10, 10]] };
    expect(sweepHit(h, 55, 5, 55, 5, 0)).toBe(true);
    expect(sweepHit(h, 30, 5, 30, 5, 0)).toBe(false);
  });
  it("a click takes the topmost mark (last drawn)", () => {
    const list = [white("under", 0, 0, 50, 50), white("over", 25, 25, 50, 50)];
    expect(topmostAt(list, 30, 30, 0)?.id).toBe("over");
    expect(topmostAt(list, 10, 10, 0)?.id).toBe("under");
    expect(topmostAt(list, 90, 90, 0)).toBeNull();
  });
  it("the eraser collects every mark its sweep touches, once", () => {
    const list = [line, white("w", 200, 200, 10, 10), ink("far", [0, 300, 1], 2)];
    const hits = new Set<string>();
    expect(eraserHits(list, 50, -10, 50, 10, 1, hits)).toBe(1);
    expect(eraserHits(list, 50, -10, 205, 205, 1, hits)).toBe(1);
    expect([...hits].sort()).toEqual(["i", "w"]);
  });
  it("a marquee selects the marks its box touches", () => {
    const list = [white("a", 0, 0, 10, 10), white("b", 100, 100, 10, 10)];
    expect(marqueeHits(list, [5, 5, 20, 20]).map((a) => a.id)).toEqual(["a"]);
    expect(marqueeHits(list, [0, 0, 200, 200]).map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("resize handles", () => {
  const from: [number, number, number, number] = [100, 100, 200, 100];
  it("finds a handle within its reach", () => {
    expect(handleAt(from, 300, 200, 3)).toBe("se");
    expect(handleAt(from, 200, 100, 3)).toBe("n");
    expect(handleAt(from, 200, 150, 3)).toBeNull();
  });
  it("drags an edge, keeps the opposite one, never flips", () => {
    expect(resizeBox(from, "e", 400, 999, false)).toEqual([100, 100, 300, 100]);
    expect(resizeBox(from, "w", 50, 0, false)).toEqual([50, 100, 250, 100]);
    expect(resizeBox(from, "n", 0, 500, false)).toEqual([100, 198, 200, 2]);
  });
  it("keeps the aspect on a corner when asked", () => {
    expect(resizeBox(from, "se", 500, 150, true)).toEqual([100, 100, 400, 200]);
    expect(resizeBox(from, "nw", 0, 100, true)).toEqual([0, 50, 300, 150]);
  });
  it("scales marks through scaleAnnot from the union box", () => {
    const a = white("a", 100, 100, 100, 50);
    const b = ink("b", [200, 150, 1, 300, 200, 1], 2);
    const u = unionBounds([a, b]);
    const to = resizeBox(u, "se", u[0] + u[2] * 2, u[1] + u[3] * 2, false);
    const sa = scaleAnnot(a, u, to);
    expect(annotBounds(sa)[2]).toBeCloseTo(200, 6);
    const sb = scaleAnnot(b, u, to) as Extract<PdfAnnot, { t: "ink" }>;
    const pts = decodePoints(sb.p)!;
    expect(pts[0]).toBeCloseTo(u[0] + (200 - u[0]) * 2, 3);
  });
});

describe("pictures and signatures", () => {
  it("fits half the page at the picture's aspect, centred", () => {
    expect(fitCentered(600, 800, 2, 0.5)).toEqual([150, 325, 300, 150]);
    expect(fitCentered(600, 800, 0.25, 0.5)).toEqual([250, 200, 100, 400]);
  });
  it("normalises pad strokes into a 0..1 box with their aspect", () => {
    const s = normalizeSignature([new Float32Array([10, 10, 1, 110, 60, 1]), new Float32Array([60, 35, 0.5])], 0.5)!;
    expect(s.aspect).toBeCloseTo(2, 6);
    expect(s.strokes).toHaveLength(2);
    for (const str of s.strokes) expect(str.length % 16).toBe(0);
    const a = decodePoints(s.strokes[0]!)!;
    expect([...a]).toEqual([0, 0, 1, 1, 1, 1]);
    const b = decodePoints(s.strokes[1]!)!;
    expect(b[0]).toBeCloseTo(0.5, 6);
    expect(b[1]).toBeCloseTo(0.5, 6);
  });
  it("clamps a thin signature's aspect and keeps its strokes in shape", () => {
    const s = normalizeSignature([new Float32Array([0, 0, 1, 1000, 1, 1])], 0.5)!;
    expect(s.aspect).toBe(20);
    const p = decodePoints(s.strokes[0]!)!;
    expect(p[1]).toBeGreaterThan(0.4);
    expect(p[1]).toBeLessThan(0.6);
  });
  it("nothing drawn saves nothing", () => {
    expect(normalizeSignature([], 0.5)).toBeNull();
  });
  it("the signature pen width matches the export's", () => {
    expect(SIGNATURE_WIDTH_FRACTION).toBe(EXPORT_SIG_FRACTION);
  });
});

describe("ruler", () => {
  const r = { cx: 300, cy: 300, angle: 0 };
  it("catches a pen landing just outside an edge", () => {
    expect(rulerEdge(r, 300, 300 + RULER_THICK / 2 + 5, 10)).toBe(1);
    expect(rulerEdge(r, 300, 300 - RULER_THICK / 2 - 5, 10)).toBe(-1);
    expect(rulerEdge(r, 300, 300 + RULER_THICK / 2 + 20, 10)).toBe(0);
    expect(rulerEdge(r, 300, 300, 10)).toBe(0);
  });
  it("snaps points onto the line a half-width outside the edge", () => {
    const [x, y] = snapToRuler(r, 1, 2, 350, 340);
    expect(x).toBeCloseTo(350, 6);
    expect(y).toBeCloseTo(300 + RULER_THICK / 2 + 2, 6);
    const turned = { cx: 0, cy: 0, angle: Math.PI / 2 };
    const [tx, ty] = snapToRuler(turned, 1, 0, 0, 50);
    expect(tx).toBeCloseTo(-RULER_THICK / 2, 6);
    expect(ty).toBeCloseTo(50, 6);
  });
});

describe("text layout matches the export", () => {
  // a fixed-advance measure: what matters is that both sides use one rule
  const measure = (s: string): number => [...s].length * 6;
  const exportLines = (text: string, w: number): string[] => {
    const out: string[] = [];
    for (const para of text.split(/\r\n|\r|\n/)) for (const [s, e] of wrapParagraph(para, w, measure)) out.push(para.slice(s, e));
    return out;
  };
  for (const text of [
    "Hello world, this is a box that wraps",
    "Line one\nLine two\r\nthree",
    "שלום עולם, זהו טקסט בעברית שנשבר לשורות",
    "averyveryverylongwordthatbreaksbetweencharacters",
    "",
  ]) {
    it(`breaks "${text.slice(0, 18)}…" exactly where the export does`, () => {
      const lines = layoutText(text, 90, measure);
      expect(lines.map((l) => l.text)).toEqual(exportLines(text, 90));
      expect(lines.map((l) => l.row)).toEqual(lines.map((_, i) => i));
    });
  }
  it("uses the export's line height and baseline rule", () => {
    expect(LINE_HEIGHT).toBe(EXPORT_LINE_HEIGHT);
    const size = 12;
    const asc = 0.905 * size;
    const desc = 0.212 * size;
    const lh = size * EXPORT_LINE_HEIGHT;
    for (const row of [0, 1, 5]) expect(lineBaseline(row, size, asc, desc)).toBeCloseTo(row * lh + (lh - (asc + desc)) / 2 + asc, 9);
  });
});
