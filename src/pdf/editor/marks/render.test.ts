import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef, PdfAnnot } from "../../../core/types";
import { encodePoints } from "../../../image/strokes";
import { outlinePolygon, penHalfWidth } from "../../../image/ink/outline";
import { LINE_HEIGHT } from "../../export/layout";
import { FakeElement, installFakeDom } from "../fake-dom.test-util";
import { circleD, inkD, markNode, n2, setTextMeasurer, signatureD, textLines } from "./render";

beforeEach(() => {
  const { doc } = installFakeDom((n, v) => vi.stubGlobal(n, v));
  (doc as unknown as { createElementNS: unknown }).createElementNS = (_ns: string, tag: string) => new FakeElement(tag);
  setTextMeasurer({ width: (_f, s) => [...s].length * 6 });
});
afterEach(() => {
  setTextMeasurer(null);
  vi.unstubAllGlobals();
});

const node = (a: PdfAnnot, media: MediaRef[] = []): FakeElement => markNode(a, media, (p) => `asset://${p}`) as unknown as FakeElement;
const pts = [10, 10, 1, 60, 20, 0.5, 120, 10, 1];

describe("saved marks as SVG", () => {
  it("pen and pencil: the image editor's filled outline", () => {
    const d = inkD("pen", 4, pts, 3);
    const o = outlinePolygon(pts, 3, penHalfWidth(4));
    expect(d.startsWith(`M${n2(o.ring[0]!)} ${n2(o.ring[1]!)}`)).toBe(true);
    expect((d.match(/Z/g) ?? []).length).toBe(o.ends.length);
    const a: PdfAnnot = { id: "i", t: "ink", kind: "pen", c: "#112233", w: 4, o: 1, p: encodePoints(new Float32Array(pts)) };
    const n = node(a);
    expect(n.tagName).toBe("PATH");
    expect(n.getAttribute("fill")).toBe("#112233");
    expect(n.getAttribute("data-id")).toBe("i");
  });

  it("marker: a round-capped centre line at its opacity, multiplied", () => {
    const a: PdfAnnot = { id: "m", t: "ink", kind: "marker", c: "#ffd400", w: 18, o: 0.4, p: encodePoints(new Float32Array(pts)) };
    const n = node(a);
    expect(n.getAttribute("d")).toBe("M10 10L60 20L120 10");
    expect(n.getAttribute("stroke-width")).toBe("18");
    expect(n.getAttribute("stroke-linecap")).toBe("round");
    expect(n.getAttribute("opacity")).toBe("0.4");
    expect(n.classList.contains("pdfmk-mark--multiply")).toBe(true);
  });

  it("a tap is a dot", () => {
    expect(inkD("marker", 10, [5, 5, 1], 1)).toBe(circleD(5, 5, 5));
  });

  it("highlight: its rects, multiplied at its opacity", () => {
    const n = node({ id: "h", t: "highlight", c: "#ffd400", o: 0.5, rects: [[1, 2, 30, 10]] });
    expect(n.getAttribute("d")).toBe("M1 2h30v10h-30Z");
    expect(n.getAttribute("opacity")).toBe("0.5");
    expect(n.classList.contains("pdfmk-mark--multiply")).toBe(true);
  });

  it("an arrow carries the shared wings; an ellipse is an ellipse", () => {
    const arrow = node({ id: "a", t: "arrow", c: "#000000", w: 2, a: [0, 0], b: [100, 0] });
    expect((arrow.getAttribute("d")!.match(/M/g) ?? []).length).toBe(2);
    const el = node({ id: "e", t: "ellipse", c: "#000000", w: 2, a: [0, 0], b: [100, 50] });
    expect(el.tagName).toBe("ELLIPSE");
    expect([el.getAttribute("cx"), el.getAttribute("ry")]).toEqual(["50", "25"]);
  });

  it("an untrusted colour never reaches an attribute", () => {
    const n = node({ id: "w", t: "whiteout", x: 0, y: 0, w: 5, h: 5, c: 'red" onload="x' });
    expect(n.getAttribute("fill")).toBe("#ffffff");
  });

  it("a picture comes from its media file; a missing one shows where it was", () => {
    const m = { id: "m1", path: "C:\\p.png" } as MediaRef;
    const img = node({ id: "p", t: "image", x: 1, y: 2, w: 3, h: 4, media: "m1" }, [m]);
    expect(img.tagName).toBe("IMAGE");
    expect(img.getAttribute("href")).toBe("asset://C:\\p.png");
    expect(img.getAttribute("preserveAspectRatio")).toBe("none");
    const gone = node({ id: "p", t: "image", x: 1, y: 2, w: 3, h: 4, media: "nope" });
    expect(gone.classList.contains("pdfmk-mark--missing")).toBe(true);
  });

  it("a signature's strokes are drawn into its box", () => {
    const a: PdfAnnot = { id: "s", t: "signature", x: 100, y: 200, w: 200, h: 100, c: "#000000", strokes: [encodePoints(new Float32Array([0, 0, 1, 1, 1, 1]))] };
    const d = signatureD(a);
    const xs = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(95);
    expect(Math.max(...xs)).toBeLessThan(305);
  });

  it("a text box: one line div per laid-out row, the export's line height, dir=auto", () => {
    const a: PdfAnnot = {
      id: "t",
      t: "text",
      x: 10,
      y: 20,
      w: 60,
      h: 40,
      text: "שלום עולם\nhello world",
      font: "Georgia",
      size: 10,
      c: "#123456",
      bold: true,
      italic: false,
      align: "right",
    };
    const fo = node(a);
    expect(fo.tagName).toBe("FOREIGNOBJECT");
    expect([fo.getAttribute("x"), fo.getAttribute("width")]).toEqual(["10", "60"]);
    const box = fo.children[0]!;
    expect(box.style.lineHeight).toBe(`${10 * LINE_HEIGHT}px`);
    expect(box.style.fontFamily).toBe('"Georgia"');
    expect(box.style.textAlign).toBe("right");
    expect(box.style.fontWeight).toBe("bold");
    const lines = box.children;
    expect(lines.map((l) => l.textContent)).toEqual(textLines(a as Extract<PdfAnnot, { t: "text" }>).map((l) => l.text));
    expect(lines.map((l) => l.textContent)).toEqual(["שלום עולם", "hello", "world"]);
    expect(lines.every((l) => l.getAttribute("dir") === "auto")).toBe(true);
    expect(lines[2]!.style.top).toBe(`${2 * 10 * LINE_HEIGHT}px`);
  });
});
