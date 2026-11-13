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

import type { FontId, MediaRef, PdfAnnot, PdfTextRun, PdfTextStyle } from "../../../core/types";
import { normalizeRuns, rowMetrics, runFontRequests, segmentsOf, type PdfResolvedStyle, type RowPiece } from "../../../core/pdf-runs";
import { rangeMeasurer, type MeasurePiece } from "../../export/layout";
import { fontRequestOf, isFontId } from "../../../core/font-id";
import { normalizeHexColor } from "../../../core/session";
import { ensureFonts, facesOf, fontFace, fontsReady } from "../../../fonts";
import { decodePoints } from "../../../image/strokes";
import { outlinePolygon, penHalfWidth, pencilHalfWidth, type HalfWidth } from "../../../image/ink/outline";
import { arrowWings } from "../../../image/ink/shapes";
import {
  LINE_HEIGHT,
  cssFamily,
  cssFont,
  frameOf,
  frameRect,
  frameTransform,
  inkPoints,
  layoutText,
  layoutTextRanges,
  lineBaseline,
  plainOnly,
  signatureWidth,
  textHeight,
  type TextLine,
} from "./geom";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Which of Bold / Italic a text style can show: a non-legacy font by its
 *  real faces (once the runtime knows them), else the legacy rule
 *  (`plainOnly`: Impact has neither). Shared by the inspector's toggles and
 *  the text editor's Ctrl+B / Ctrl+I (here so neither imports the other). */
export function textFaces(a: { font: string; fontId?: FontId } | undefined): { bold: boolean; italic: boolean } {
  if (!a) return { bold: true, italic: true };
  const faces = isFontId(a.fontId) ? facesOf(a.fontId) : null;
  if (faces === null || faces.length === 0) {
    const ok = !plainOnly(a.font);
    return { bold: ok, italic: ok };
  }
  return { bold: faces.some((f) => f.bold), italic: faces.some((f) => f.italic) };
}

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

/** Path data of a signature's strokes drawn into its upright frame (its box
 *  when it has no turn; the node then gets `frameTransform`). */
export function signatureD(a: Extract<PdfAnnot, { t: "signature" }>): string {
  const half = penHalfWidth(signatureWidth(a.w, a.h));
  const [fx, fy, fw, fh] = frameRect(a);
  let d = "";
  for (const s of a.strokes) {
    const norm = decodePoints(s);
    if (!norm) continue;
    const pts = new Float32Array(norm.length);
    for (let i = 0; i + 2 < norm.length; i += 3) {
      pts[i] = fx + norm[i]! * fw;
      pts[i + 1] = fy + norm[i + 1]! * fh;
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
  /** the font's ascent and descent in points at `font`'s size, both positive
   *  (only rows of a box with style runs ask; absent = 0.8 / 0.2 of the size) */
  vertical?(font: string): { asc: number; desc: number };
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D | null {
  if (!measureCtx) {
    const c = document.createElement("canvas");
    c.width = 0;
    c.height = 0;
    measureCtx = c.getContext("2d");
  }
  return measureCtx;
}
const sizeOfFont = (font: string): number => parseFloat(font.replace(/^[^\d]*/, "")) || 12;
const canvasMeasurer: TextMeasurer = {
  width(font, s) {
    const ctx = measureContext();
    if (!ctx) return s.length * 0.5 * sizeOfFont(font);
    if (ctx.font !== font) ctx.font = font;
    return ctx.measureText(s).width;
  },
  vertical(font) {
    // the font's own box (not the glyphs'): what CSS uses for an inline box
    const ctx = measureContext();
    if (ctx) {
      if (ctx.font !== font) ctx.font = font;
      const m = ctx.measureText("x");
      const asc = m.fontBoundingBoxAscent;
      const desc = m.fontBoundingBoxDescent;
      if (Number.isFinite(asc) && Number.isFinite(desc)) return { asc, desc };
    }
    const size = sizeOfFont(font);
    return { asc: size * 0.8, desc: size * 0.2 };
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

type FontStyle = Pick<PdfTextStyle, "font" | "fontId" | "bold" | "italic">;

/** What a text style draws with on screen when it names a non-legacy font
 *  (`fontId`) not known to be missing: the runtime's alias (always first in
 *  the family list, the legacy font after it as the fallback) and the face it
 *  resolved. While the font is still loading its load is started here, the
 *  fallback shows, and `textNode` re-lays its box out when the font lands.
 *  null = the legacy font, styled exactly as in 0.9.3: no `fontId` (no runtime
 *  call at all, I1) or the font is missing on this PC. */
export function screenFont(a: FontStyle): { family: string; bold: boolean; italic: boolean } | null {
  const req = fontRequestOf(a.font, a.fontId, a.bold, a.italic);
  if (req === null) return null;
  if (!fontsReady([req])) void ensureFonts([req]).catch(() => {});
  // The alias is deterministic, so it is named even before the face loads:
  // the legacy font after it in the same list shows until then.
  const f = fontFace(a.font, req.id, a.bold, a.italic);
  return f.missing ? null : { family: f.family, bold: f.bold, italic: f.italic };
}

/** How a non-legacy text style's font stands right now, as one string: it
 *  changes when the face it draws with lands, goes missing or is replaced by
 *  another. Starts no load. The mark layer keeps it per box to re-lay, on a
 *  font change, only the boxes that change touched. */
export function fontStateOf(a: FontStyle & { runs?: readonly PdfTextRun[] }): string {
  // the box's own font first (a box without runs: exactly the 0.9.3 answer),
  // then every run's that differs from it
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const st of fontStylesOf(a)) {
    const req = fontRequestOf(st.font, st.fontId, st.bold, st.italic);
    if (req === null) continue;
    const f = fontFace(st.font, req.id, st.bold, st.italic);
    const one = `${fontsReady([req])}|${f.family}|${f.bold}|${f.italic}`;
    if (seen.has(one)) continue;
    seen.add(one);
    parts.push(one);
  }
  return parts.join(";");
}

/** The font styles a box draws with: its own, then each run's resolved over
 *  it (the font as a pair). A box without runs: just its own. */
function fontStylesOf(a: FontStyle & { runs?: readonly PdfTextRun[] }): FontStyle[] {
  const out: FontStyle[] = [a];
  for (const r of a.runs ?? []) {
    const pair = r.font !== undefined ? { font: r.font, fontId: r.fontId } : { font: a.font, fontId: a.fontId };
    out.push({ font: pair.font, ...(pair.fontId !== undefined ? { fontId: pair.fontId } : {}), bold: r.bold ?? a.bold, italic: r.italic ?? a.italic });
  }
  return out;
}

/** Does a mark draw with a non-legacy font anywhere (its own or a run's)?
 *  False for a box using only the six legacy fonts: the layer then makes no
 *  font call and adds no listener for it (I1). */
export function needsFontRuntime(a: PdfAnnot): a is Extract<PdfAnnot, { t: "text" }> {
  if (a.t !== "text") return false;
  if (a.fontId !== undefined) return true;
  return a.runs !== undefined && a.runs.some((r) => r.fontId !== undefined);
}

type TextMark = Extract<PdfAnnot, { t: "text" }>;
type Segment = { s: number; e: number; style: PdfResolvedStyle };

/** A box's style segments when it has runs that change anything; null for a
 *  box without (it then takes the 0.9.3 path, byte for byte: R1). */
function runSegments(a: TextMark): Segment[] | null {
  if (!a.runs || a.runs.length === 0) return null;
  if (normalizeRuns(a.text, a, a.runs) === undefined) return null;
  return segmentsOf(a.text, a, a.runs);
}

/** The CSS font a style measures with on screen (its loaded alias, else the
 *  legacy font; starts the load like `screenFont`). */
function screenCssFont(st: Pick<PdfResolvedStyle, "font" | "fontId" | "size" | "bold" | "italic">): string {
  const f = screenFont(st);
  return f ? cssFont(st.font, st.size, f.bold, f.italic, f.family) : cssFont(st.font, st.size, st.bold, st.italic);
}

/** The lines a box with runs shows: each paragraph wrapped by the sum of its
 *  pieces, each piece measured in its own font (the export's rule). */
function runLines(a: TextMark, segs: readonly Segment[]): TextLine[] {
  const fonts = segs.map((g) => screenCssFont(g.style));
  const m = measurer;
  // paragraphs come in text order and segments are sorted: one forward walk
  let k = 0;
  return layoutTextRanges(a.text, frameOf(a).W, (start, para) => {
    const end = start + para.length;
    const pieces: MeasurePiece[] = [];
    const which: number[] = [];
    while (k < segs.length && segs[k]!.e <= start) k++;
    for (let i = k; i < segs.length; i++) {
      const g = segs[i]!;
      if (g.s >= end) break;
      if (g.e <= start) continue;
      pieces.push({ s: Math.max(g.s, start) - start, e: Math.min(g.e, end) - start });
      which.push(i);
    }
    return rangeMeasurer(pieces, (i, s, e) => m.width(fonts[which[i]!]!, para.slice(s, e)));
  });
}

/** One row of a box with runs: its top and height below the box top, and its
 *  baseline below the row's top. */
export interface TextRow {
  top: number;
  height: number;
  baseline: number;
}

/** A piece's row metrics: its size and its font's ascent / descent on screen. */
function rowPiece(st: PdfResolvedStyle): RowPiece {
  const font = screenCssFont(st);
  const v = measurer.vertical ? measurer.vertical(font) : { asc: st.size * 0.8, desc: st.size * 0.2 };
  return { size: st.size, asc: v.asc, desc: v.desc };
}

/** Rows of a box with runs, by the CSS inline model (`rowMetrics`): the
 *  pieces on each line plus the box's own style as the strut, stacked. */
function runRows(a: TextMark, segs: readonly Segment[], lines: readonly TextLine[]): TextRow[] {
  const strut = rowPiece({ font: a.font, ...(a.fontId !== undefined ? { fontId: a.fontId } : {}), size: a.size, c: a.c, bold: a.bold, italic: a.italic });
  const byStyle = new Map<PdfResolvedStyle, RowPiece>();
  const out: TextRow[] = [];
  let top = 0;
  // lines and segments are both in text order: one forward walk
  let k = 0;
  for (const line of lines) {
    const pieces: RowPiece[] = [];
    while (k < segs.length && segs[k]!.e <= line.s) k++;
    for (let i = k; i < segs.length; i++) {
      const g = segs[i]!;
      if (g.s >= line.e) break;
      if (g.e <= line.s) continue;
      let p = byStyle.get(g.style);
      if (!p) {
        p = rowPiece(g.style);
        byStyle.set(g.style, p);
      }
      pieces.push(p);
    }
    const { height, baseline } = rowMetrics(pieces, strut);
    out.push({ top, height, baseline });
    top += height;
  }
  return out;
}

/** The lines a text mark shows (export's breaks), wrapped to its upright
 *  frame's width (the box's h on a page turned 90 / 270). A box with style
 *  runs wraps by the sum of its pieces; each line carries its `s` / `e`. */
export function textLines(a: TextMark): TextLine[] {
  const segs = runSegments(a);
  if (segs) return runLines(a, segs);
  const f = screenFont(a);
  const font = f ? cssFont(a.font, a.size, f.bold, f.italic, f.family) : cssFont(a.font, a.size, a.bold, a.italic);
  const m = measurer;
  return layoutText(a.text, frameOf(a).W, (s) => m.width(font, s));
}

/** The rows of a box's lines: per `rowMetrics` for a box with runs; for a box
 *  without, the fixed `size × 1.25` pitch with the box's own baseline. */
export function textRows(a: TextMark): TextRow[] {
  const segs = runSegments(a);
  if (segs) return runRows(a, segs, runLines(a, segs));
  const lh = a.size * LINE_HEIGHT;
  const p = rowPiece({ font: a.font, ...(a.fontId !== undefined ? { fontId: a.fontId } : {}), size: a.size, c: a.c, bold: a.bold, italic: a.italic });
  return textLines(a).map((l) => ({ top: l.row * lh, height: lh, baseline: lineBaseline(0, a.size, p.asc, p.desc) }));
}

/** The height a text box needs to show all its lines, upright frame: the sum
 *  of its rows for a box with runs; for a box without, exactly
 *  `textHeight(lines, size)` as before (R1: a summed height can differ from
 *  it in the last bit). */
export function textBoxHeight(a: TextMark): number {
  const segs = runSegments(a);
  if (!segs) return textHeight(textLines(a).length, a.size);
  let h = 0;
  for (const r of runRows(a, segs, runLines(a, segs))) h += r.height;
  return h;
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
export function styleTextBox(el: HTMLElement, a: Pick<Extract<PdfAnnot, { t: "text" }>, "font" | "fontId" | "size" | "bold" | "italic" | "c" | "align">): void {
  const s = el.style;
  // a loaded non-legacy font: its alias, the legacy font after it, its real face
  const f = screenFont(a);
  s.fontFamily = cssFamily(a.font, f?.family);
  s.fontSize = `${a.size}px`;
  // a regular-only font (Impact) exports plain whatever the toggles say
  const plain = f === null && plainOnly(a.font);
  s.fontWeight = (f ? f.bold : a.bold && !plain) ? "bold" : "normal";
  s.fontStyle = (f ? f.italic : a.italic && !plain) ? "italic" : "normal";
  s.lineHeight = `${a.size * LINE_HEIGHT}px`;
  s.color = col(a.c);
  s.textAlign = a.align;
}

/** Style one piece of a text box with style runs (0.9.4): its own family
 *  (the runtime's alias with the legacy font after it, as `styleTextBox`),
 *  size, weight, style, colour and line height (size × 1.25), in the same
 *  units as the saved box's line divs (px = points in page space). Shared by
 *  the saved render and the in-place editor so both look identical. Starts
 *  the font's load when it is not ready (as `styleTextBox` does). */
export function styleRunSpan(span: HTMLElement, style: PdfResolvedStyle): void {
  const s = span.style;
  const f = screenFont(style);
  s.fontFamily = cssFamily(style.font, f?.family);
  s.fontSize = `${style.size}px`;
  const plain = f === null && plainOnly(style.font);
  s.fontWeight = (f ? f.bold : style.bold && !plain) ? "bold" : "normal";
  s.fontStyle = (f ? f.italic : style.italic && !plain) ? "italic" : "normal";
  s.lineHeight = `${style.size * LINE_HEIGHT}px`;
  s.color = col(style.c);
}

/** A text box's fill and 1 pt border (inside the box), on its content
 *  element: shared by the saved text and the in-place editor, so both look
 *  the same. Absent = transparent / none. */
export function styleBoxLook(el: HTMLElement, a: { bg?: string; border?: string }): void {
  const s = el.style;
  const bg = a.bg ? normalizeHexColor(a.bg, "") : "";
  const border = a.border ? normalizeHexColor(a.border, "") : "";
  s.backgroundColor = bg || "transparent";
  // an inset ring: inside the box, takes no layout room (1 px = 1 pt here)
  s.boxShadow = border ? `inset 0 0 0 1px ${border}` : "none";
}

/** One saved mark as an SVG node in page space (null: nothing to draw). */
export function markNode(
  a: PdfAnnot,
  media: readonly MediaRef[],
  urlOf: (path: string) => string,
  isMissing?: (ref: MediaRef) => boolean,
): SVGElement | null {
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
      if (!m || isMissing?.(m)) {
        // A missing picture shows where it sits (export refuses it by name):
        // its box, dashed and crossed, instead of an empty image.
        node = missingNode(a);
        break;
      }
      const [fx, fy, fw, fh] = frameRect(a);
      node = svg("image", { x: n2(fx), y: n2(fy), width: n2(fw), height: n2(fh), preserveAspectRatio: "none", href: urlOf(m.path) });
      turn(node, a);
      break;
    }
    case "signature": {
      const d = signatureD(a);
      if (!d) return null;
      node = svg("path", { d, fill: col(a.c), "fill-rule": "nonzero" });
      turn(node, a);
      break;
    }
    case "text":
      node = textNode(a);
      break;
  }
  if (node) node.setAttribute("data-id", a.id);
  return node;
}

/** A picture whose file is missing: its box, tinted, dashed and crossed. */
function missingNode(a: { x: number; y: number; w: number; h: number }): SVGElement {
  const g = svg("g", { class: "pdfmk-missing" });
  g.appendChild(svg("rect", { x: n2(a.x), y: n2(a.y), width: n2(a.w), height: n2(a.h), class: "pdfmk-mark--missing" }));
  const x0 = n2(a.x);
  const y0 = n2(a.y);
  const x1 = n2(a.x + a.w);
  const y1 = n2(a.y + a.h);
  g.appendChild(svg("path", { d: `M${x0} ${y0}L${x1} ${y1}M${x1} ${y0}L${x0} ${y1}`, class: "pdfmk-missing__x" }));
  return g;
}

/** Turn a box mark's frame-drawn node into its box (`r`; nothing at 0). */
function turn(node: SVGElement, a: { x: number; y: number; w: number; h: number; r?: unknown }): void {
  const t = frameTransform(a);
  if (t) node.setAttribute("transform", t);
}

/** A text mark: a foreignObject clipped to its upright frame and turned into
 *  its box, one div per laid-out line; every line takes its PARAGRAPH's
 *  direction (the export's per-paragraph bidi, not the line's own). */
export function textNode(a: Extract<PdfAnnot, { t: "text" }>): SVGElement {
  const [fx, fy, fw, fh] = frameRect(a);
  const fo = svg("foreignObject", { x: n2(fx), y: n2(fy), width: n2(Math.max(fw, 0)), height: n2(Math.max(fh, 0)) });
  turn(fo, a);
  const box = document.createElement("div");
  box.className = "pdfmk-text";
  fillTextBox(box, a);
  fo.appendChild(box);
  // A non-legacy font still loading: the box shows the legacy font for now
  // and is laid out again, in place, once the font is usable (or known
  // missing), unless the layer has replaced this node by then. A legacy font
  // never gets here (I1). A box with runs waits on every run font too.
  const reqs = runFontRequests(a, a.runs);
  if (reqs.length > 0 && !fontsReady(reqs)) {
    void ensureFonts(reqs)
      .catch(() => {})
      .then(() => {
        if (fo.parentNode) fillTextBox(box, a);
      });
  }
  return fo;
}

/** A text box's look and its laid-out lines (replacing any it had). */
function fillTextBox(box: HTMLElement, a: Extract<PdfAnnot, { t: "text" }>): void {
  while (box.firstChild) box.removeChild(box.firstChild);
  styleTextBox(box, a);
  styleBoxLook(box, a);
  const segs = runSegments(a);
  if (segs) {
    fillRunLines(box, a, segs);
    return;
  }
  const lh = a.size * LINE_HEIGHT;
  for (const line of textLines(a)) {
    const div = document.createElement("div");
    div.className = "pdfmk-text__line";
    div.setAttribute("dir", line.rtl ? "rtl" : "ltr");
    div.style.top = `${line.row * lh}px`;
    div.style.height = `${lh}px`;
    div.textContent = line.text;
    box.appendChild(div);
  }
}

/** A box with runs: one div per line at its row's top and height (the box
 *  keeps the base style, which is each line's strut), one span per piece of
 *  a segment on that line, styled like the editor's (`styleRunSpan`). Spans
 *  are plain inline boxes: no isolation, so the paragraph's bidi reorders
 *  across them as the export does. */
function fillRunLines(box: HTMLElement, a: TextMark, segs: readonly Segment[]): void {
  const lines = runLines(a, segs);
  const rows = runRows(a, segs, lines);
  // lines and segments are both in text order: one forward walk
  let k = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const row = rows[i]!;
    const div = document.createElement("div");
    div.className = "pdfmk-text__line";
    div.setAttribute("dir", line.rtl ? "rtl" : "ltr");
    div.style.top = `${row.top}px`;
    div.style.height = `${row.height}px`;
    while (k < segs.length && segs[k]!.e <= line.s) k++;
    for (let j = k; j < segs.length; j++) {
      const g = segs[j]!;
      if (g.s >= line.e) break;
      const s = Math.max(g.s, line.s);
      const e = Math.min(g.e, line.e);
      if (e <= s) continue;
      const span = document.createElement("span");
      styleRunSpan(span, g.style);
      span.textContent = a.text.slice(s, e);
      div.appendChild(span);
    }
    box.appendChild(div);
  }
}
