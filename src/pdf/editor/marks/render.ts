// Saved marks → SVG nodes in page space. One node per mark, built once per
// mark object (marks are immutable; the layer repaints a page only when its
// mark list changes). The geometry is the PDF export's, so what the page shows
// is what the exported file shows:
//   - pen / pencil: the image editor's filled variable-width outline
//     (`outlinePolygon`), nonzero, one path;
//   - marker: a constant-width polyline, round caps and joins, at its opacity,
//     multiplied over the page (the export's Multiply ExtGState);
//   - highlight: its rects filled at its opacity, multiplied;
//   - line / arrow / rect / ellipse: stroked, round caps and joins, the same
//     arrow wings;
//   - whiteout: a filled box; image: the picture stretched into its box;
//   - signature: pen outlines of its normalised strokes scaled into its box,
//     width SIGNATURE_WIDTH_FRACTION of the box's smaller side;
//   - text: one div per laid-out line (export's breaks and line height), in a
//     foreignObject clipped to the box.
//
// Every colour reaching an attribute goes through the hex normaliser (a .trt
// is untrusted); nothing here reads the DOM back.

import type { MediaRef, PdfAnnot } from "../../../core/types";
import { normalizeHexColor } from "../../../core/session";
import { decodePoints } from "../../../image/strokes";
import { outlinePolygon, penHalfWidth, pencilHalfWidth, type HalfWidth } from "../../../image/ink/outline";
import { arrowWings } from "../../../image/ink/shapes";
import { LINE_HEIGHT, cssFont, inkPoints, layoutText, signatureWidth } from "./geom";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Numbers in path data: two decimals of a point (1/7200 in). */
export function n2(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 100) / 100;
  return r === 0 ? "0" : String(r);
}

/** Filled outline rings of [x, y, p]* points as path data (empty for nothing). */
export function outlineD(pts: ArrayLike<number>, count: number, half: HalfWidth): string {
  const o = outlinePolygon(pts, count, half);
  if (o.dot) {
    const { x, y, r } = o.dot;
    if (!(r > 0)) return "";
    return circleD(x, y, r);
  }
  let d = "";
  let from = 0;
  for (const to of o.ends) {
    if (to - from >= 3) {
      d += `M${n2(o.ring[from * 2]!)} ${n2(o.ring[from * 2 + 1]!)}`;
      for (let i = from + 1; i < to; i++) d += `L${n2(o.ring[i * 2]!)} ${n2(o.ring[i * 2 + 1]!)}`;
      d += "Z";
    }
    from = to;
  }
  return d;
}

/** A full circle as two arcs (path data). */
export function circleD(cx: number, cy: number, r: number): string {
  return `M${n2(cx + r)} ${n2(cy)}A${n2(r)} ${n2(r)} 0 1 0 ${n2(cx - r)} ${n2(cy)}A${n2(r)} ${n2(r)} 0 1 0 ${n2(cx + r)} ${n2(cy)}Z`;
}

/** A polyline of [x, y, p]* points (the marker's centre line). */
export function polylineD(pts: ArrayLike<number>, count: number): string {
  let d = "";
  for (let i = 0; i < count; i++) d += `${i ? "L" : "M"}${n2(pts[i * 3]!)} ${n2(pts[i * 3 + 1]!)}`;
  return d;
}

/** True when every point sits in one place (a tap). */
function isDot(pts: ArrayLike<number>, count: number): boolean {
  for (let i = 1; i < count; i++) if (pts[i * 3] !== pts[0] || pts[i * 3 + 1] !== pts[1]) return false;
  return true;
}

/** Path data of an ink mark; `marker` is a centre line (stroked), the rest a
 *  filled outline. */
export function inkD(kind: "pen" | "pencil" | "marker", w: number, pts: ArrayLike<number>, count: number): string {
  if (count < 1) return "";
  if (kind === "marker") return isDot(pts, count) ? circleD(pts[0]!, pts[1]!, w / 2) : polylineD(pts, count);
  return outlineD(pts, count, kind === "pencil" ? pencilHalfWidth(w) : penHalfWidth(w));
}

/** Path data of a shape (stroked). */
export function shapeD(t: "line" | "arrow" | "rect", a: [number, number], b: [number, number], w: number): string {
  const [ax, ay] = a;
  const [bx, by] = b;
  if (t === "rect") return `M${n2(ax)} ${n2(ay)}L${n2(bx)} ${n2(ay)}L${n2(bx)} ${n2(by)}L${n2(ax)} ${n2(by)}Z`;
  let d = `M${n2(ax)} ${n2(ay)}L${n2(bx)} ${n2(by)}`;
  if (t === "arrow") {
    const wings = arrowWings(a, b, w);
    if (wings) d += `M${n2(wings[0][0])} ${n2(wings[0][1])}L${n2(bx)} ${n2(by)}L${n2(wings[1][0])} ${n2(wings[1][1])}`;
  }
  return d;
}

/** Path data of a signature's strokes drawn into its box. */
export function signatureD(a: Extract<PdfAnnot, { t: "signature" }>): string {
  const half = penHalfWidth(signatureWidth(a.w, a.h));
  let d = "";
  for (const s of a.strokes) {
    const norm = decodePoints(s);
    if (!norm) continue;
    const pts = new Float32Array(norm.length);
    for (let i = 0; i + 2 < norm.length; i += 3) {
      pts[i] = a.x + norm[i]! * a.w;
      pts[i + 1] = a.y + norm[i + 1]! * a.h;
      pts[i + 2] = norm[i + 2]!;
    }
    d += outlineD(pts, pts.length / 3, half);
  }
  return d;
}

/** Path data of a highlight's rects. */
export function rectsD(rects: readonly [number, number, number, number][]): string {
  let d = "";
  for (const [x, y, w, h] of rects) {
    if (!(w > 0) || !(h > 0)) continue;
    d += `M${n2(x)} ${n2(y)}h${n2(w)}v${n2(h)}h${n2(-w)}Z`;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Text measuring (the browser's own metrics, as raster.ts reads them) */
/* ------------------------------------------------------------------ */

export interface TextMeasurer {
  /** width of `s` in points at `font` (a CSS font shorthand, px = points) */
  width(font: string, s: string): number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const canvasMeasurer: TextMeasurer = {
  width(font, s) {
    if (!measureCtx) {
      const c = document.createElement("canvas");
      c.width = 0;
      c.height = 0;
      measureCtx = c.getContext("2d");
    }
    if (!measureCtx) return s.length * 0.5 * (parseFloat(font.replace(/^[^\d]*/, "")) || 12);
    if (measureCtx.font !== font) measureCtx.font = font;
    return measureCtx.measureText(s).width;
  },
};
let measurer: TextMeasurer = canvasMeasurer;
/** Tests hand in their own (node has no canvas). */
export function setTextMeasurer(m: TextMeasurer | null): void {
  measurer = m ?? canvasMeasurer;
}
export function textMeasurer(): TextMeasurer {
  return measurer;
}

/** The lines a text mark shows (export's breaks). */
export function textLines(a: Extract<PdfAnnot, { t: "text" }>): ReturnType<typeof layoutText> {
  const font = cssFont(a.font, a.size, a.bold, a.italic);
  const m = measurer;
  return layoutText(a.text, a.w, (s) => m.width(font, s));
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  return e;
}

const col = (c: string, fb = "#000000"): string => normalizeHexColor(c, fb);
const op = (o: number): string => String(Number.isFinite(o) ? Math.min(Math.max(o, 0), 1) : 1);

/** Style a text box's content element like the final text: the export's line
 *  height, the whitelisted font, no padding. Shared with the in-place editor. */
export function styleTextBox(el: HTMLElement, a: Pick<Extract<PdfAnnot, { t: "text" }>, "font" | "size" | "bold" | "italic" | "c" | "align">): void {
  const s = el.style;
  s.fontFamily = `"${a.font}"`;
  s.fontSize = `${a.size}px`;
  s.fontWeight = a.bold ? "bold" : "normal";
  s.fontStyle = a.italic ? "italic" : "normal";
  s.lineHeight = `${a.size * LINE_HEIGHT}px`;
  s.color = col(a.c);
  s.textAlign = a.align;
}

/** One saved mark as an SVG node in page space (null: nothing to draw). */
export function markNode(a: PdfAnnot, media: readonly MediaRef[], urlOf: (path: string) => string): SVGElement | null {
  let node: SVGElement | null = null;
  switch (a.t) {
    case "ink": {
      const pts = inkPoints(a);
      const count = pts.length / 3;
      const d = inkD(a.kind, a.w, pts, count);
      if (!d) return null;
      const c = col(a.c);
      if (a.kind === "marker" && !isDot(pts, count)) {
        node = svg("path", { d, fill: "none", stroke: c, "stroke-width": n2(a.w), "stroke-linecap": "round", "stroke-linejoin": "round", opacity: op(a.o) });
      } else {
        node = svg("path", { d, fill: c, "fill-rule": "nonzero", opacity: op(a.o) });
      }
      if (a.kind === "marker") node.setAttribute("class", "pdfmk-mark--multiply");
      break;
    }
    case "highlight": {
      const d = rectsD(a.rects);
      if (!d) return null;
      node = svg("path", { d, fill: col(a.c, "#ffd400"), opacity: op(a.o), class: "pdfmk-mark--multiply" });
      break;
    }
    case "line":
    case "arrow":
    case "rect": {
      node = svg("path", {
        d: shapeD(a.t, a.a, a.b, a.w),
        fill: "none",
        stroke: col(a.c),
        "stroke-width": n2(a.w),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      break;
    }
    case "ellipse": {
      node = svg("ellipse", {
        cx: n2((a.a[0] + a.b[0]) / 2),
        cy: n2((a.a[1] + a.b[1]) / 2),
        rx: n2(Math.abs(a.b[0] - a.a[0]) / 2),
        ry: n2(Math.abs(a.b[1] - a.a[1]) / 2),
        fill: "none",
        stroke: col(a.c),
        "stroke-width": n2(a.w),
      });
      break;
    }
    case "whiteout":
      node = svg("rect", { x: n2(a.x), y: n2(a.y), width: n2(a.w), height: n2(a.h), fill: col(a.c, "#ffffff") });
      break;
    case "image": {
      const m = media.find((x) => x.id === a.media);
      if (!m) {
        // A missing picture shows where it sits (export refuses it by name).
        node = svg("rect", { x: n2(a.x), y: n2(a.y), width: n2(a.w), height: n2(a.h), class: "pdfmk-mark--missing" });
        break;
      }
      node = svg("image", { x: n2(a.x), y: n2(a.y), width: n2(a.w), height: n2(a.h), preserveAspectRatio: "none", href: urlOf(m.path) });
      break;
    }
    case "signature": {
      const d = signatureD(a);
      if (!d) return null;
      node = svg("path", { d, fill: col(a.c), "fill-rule": "nonzero" });
      break;
    }
    case "text":
      node = textNode(a);
      break;
  }
  if (node) node.setAttribute("data-id", a.id);
  return node;
}

/** A text mark: a foreignObject clipped to its box, one div per laid-out line. */
export function textNode(a: Extract<PdfAnnot, { t: "text" }>): SVGElement {
  const fo = svg("foreignObject", { x: n2(a.x), y: n2(a.y), width: n2(Math.max(a.w, 0)), height: n2(Math.max(a.h, 0)) });
  const box = document.createElement("div");
  box.className = "pdfmk-text";
  styleTextBox(box, a);
  const lh = a.size * LINE_HEIGHT;
  for (const line of textLines(a)) {
    const div = document.createElement("div");
    div.className = "pdfmk-text__line";
    div.setAttribute("dir", "auto");
    div.style.top = `${line.row * lh}px`;
    div.style.height = `${lh}px`;
    div.textContent = line.text;
    box.appendChild(div);
  }
  fo.appendChild(box);
  return fo;
}
