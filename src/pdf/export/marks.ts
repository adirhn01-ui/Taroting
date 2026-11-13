// Marks (PdfAnnot) → PDF. Every mark becomes ONE appearance: a Form XObject
// whose /BBox is the mark's rectangle in the page's user space, drawn with an
// identity /Matrix. Then either
//   - written as a real annotation (/AP /N = that form, /Rect = /BBox — the
//     spike found a BBox larger than the Rect gets SCALED into it by
//     Chromium/PDFium), with the subtype a viewer lists and lets the user
//     delete; or
//   - flattened: the same form painted into the page with `Do`, so both modes
//     share one geometry.
//
// Geometry is converted point by point (page space is y-down from the crop
// box's top-left; user space y-up from the origin), never with a mirroring
// `cm`, which would flip glyphs and pictures. Page space is the UNROTATED
// page, so marks need nothing extra on a turned page: they turn with it.
//
// A text, image or signature mark with a turn `r` (core/types.ts) is laid out
// as the editor does (src/pdf/editor/marks/geom.ts frameOf/frameRect): in an
// upright W×H frame centred on its box — (W, H) = (w, h) for 0/180, (h, w)
// for 90/270 — then turned counter-clockwise by r about the box centre, so
// it reads upright on a page displayed turned clockwise by r. Text and
// pictures get that turn as a `cm` inside the appearance stream (BBox and
// Rect stay the box); signature points are turned numerically, so their
// InkList is where the ink is.
//
// Ink shares the image editor's geometry: the same `outlinePolygon` (pen and
// pencil are one filled variable-width outline) and the same arrow wings.

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { FontFamily, FontRequest, MediaRef, PdfAnnot, PdfTextStyle, ProjectFile, ResolvedFont } from "../../core/types";
import { fontDisplayName, fontRequestOf } from "../../core/font-id";
import { decodePoints } from "../../image/strokes";
import { outlinePolygon, penHalfWidth, pencilHalfWidth, type HalfWidth } from "../../image/ink/outline";
import { arrowWings } from "../../image/ink/shapes";
import { fontBoxOf, normalizeRuns, rowMetrics, segmentsOf, type PdfResolvedStyle, type RowPiece } from "../../core/pdf-runs";
import { drawnText, hasArabic, logicalMirrored, paragraphBidi, visualGroups, visualLine, type VisualGroup } from "./bidi";
import type { ExportDeps, RasterTextRun } from "./deps";
import { canShape, encodeGlyphs, fkFontOf, fontBoxTables, rtlToUnicodeOrder, runWidth, shapeRtlIn, shapedWidth, type FkFont, type FkRun } from "./shape";
import { PdfExportError, baseName, own } from "./errors";
import { displayedOf, prepareImage, type Orientation } from "./images";
import { LINE_HEIGHT, rangeMeasurer, rasterScale, wrapRanges, type MeasurePiece } from "./layout";

export { RASTER_SCALE } from "./layout";

/* ---------------- numbers, colours, boxes ---------------- */

/** A content-stream number: at most 3 decimals, never exponent notation, never "-0". */
export function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 1000) / 1000;
  if (r === 0) return "0";
  return r.toFixed(3).replace(/\.?0+$/, "");
}

export function hexRgb(c: string, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(typeof c === "string" ? c : "");
  if (!m) return fallback;
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const rgbOps = (c: [number, number, number], op: "rg" | "RG"): string => `${num(c[0])} ${num(c[1])} ${num(c[2])} ${op}`;

/** The page's crop box (intersected with its media box), user space. */
export interface PageGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(arr: PDFArray | undefined): PageGeom | null {
  if (!arr || arr.size() < 4) return null;
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = arr.lookup(i);
    if (!(n instanceof PDFNumber)) return null;
    v.push(n.asNumber());
  }
  const x0 = Math.min(v[0]!, v[2]!);
  const x1 = Math.max(v[0]!, v[2]!);
  const y0 = Math.min(v[1]!, v[3]!);
  const y1 = Math.max(v[1]!, v[3]!);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pageGeom(page: PDFPage): PageGeom {
  const media = boxOf(page.node.MediaBox()) ?? { x: 0, y: 0, w: 612, h: 792 };
  const crop = boxOf(page.node.CropBox());
  if (!crop) return media;
  const x0 = Math.max(crop.x, media.x);
  const y0 = Math.max(crop.y, media.y);
  const x1 = Math.min(crop.x + crop.w, media.x + media.w);
  const y1 = Math.min(crop.y + crop.h, media.y + media.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : media;
}

type Rect = [number, number, number, number];

class Bounds {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add(x: number, y: number): void {
    if (x < this.x0) this.x0 = x;
    if (x > this.x1) this.x1 = x;
    if (y < this.y0) this.y0 = y;
    if (y > this.y1) this.y1 = y;
  }
  rect(pad: number): Rect | null {
    if (!(this.x1 >= this.x0) || !(this.y1 >= this.y0)) return null;
    return [this.x0 - pad, this.y0 - pad, this.x1 + pad, this.y1 + pad];
  }
}

const finite = (...v: number[]): boolean => v.every((n) => typeof n === "number" && Number.isFinite(n));

/* ---------------- a box mark's turn ---------------- */

type Turn = 0 | 90 | 180 | 270;
const COS_SIN: Record<Turn, [number, number]> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

export function turnOf(a: { r?: unknown }): Turn {
  return a.r === 90 || a.r === 180 || a.r === 270 ? a.r : 0;
}

/** A turned box mark's upright frame, page space: [x, y, W, H]. */
export function frameOf(a: { x: number; y: number; w: number; h: number; r?: unknown }): [number, number, number, number] {
  const r = turnOf(a);
  const [W, H] = r === 90 || r === 270 ? [a.h, a.w] : [a.w, a.h];
  return [a.x + a.w / 2 - W / 2, a.y + a.h / 2 - H / 2, W, H];
}

/** A page picture's (`bg`, 0.9.5) missing file, said the way that works for
 *  it: it cannot be selected, so the page is named as the user counts it (the
 *  project's own order, not the exported range's) with the remedies there are
 *  (the page menu's "Relink picture" among them). Any other error, or a
 *  mark no page holds, keeps the ordinary picture message. */
function pagePictureError(e: unknown, markId: string, project: ProjectFile): unknown {
  if (!(e instanceof PdfExportError) || e.code !== "image-missing" || e.path === undefined) return e;
  const pdf = project.pdf;
  if (!pdf) return e;
  const i = pdf.pages.findIndex((pg) => {
    const list = own(pdf.annots, pg.id);
    return Array.isArray(list) && list.some((x) => x.id === markId);
  });
  if (i < 0) return e;
  return new PdfExportError(
    "image-missing",
    `Page ${i + 1}'s picture ${baseName(e.path)} is missing. Relink it from the page's menu, put the file back where it was, or delete the page.`,
    e.path,
  );
}

/** `cm` operands (with a trailing " cm ") turning user space counter-
 *  clockwise by `r` about (cx, cy); "" for no turn. */
export function turnCm(r: Turn, cx: number, cy: number): string {
  if (r === 0) return "";
  const [c, s] = COS_SIN[r];
  return `${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(cx - c * cx + s * cy)} ${num(cy - s * cx - c * cy)} cm `;
}

/** The same turn applied to one user-space point. */
function turnPoint(r: Turn, cx: number, cy: number): (p: [number, number]) => [number, number] {
  const [c, s] = COS_SIN[r];
  return ([x, y]) => [cx + c * (x - cx) - s * (y - cy), cy + s * (x - cx) + c * (y - cy)];
}

/* ---------------- the appearance a mark becomes ---------------- */

export interface Appearance {
  rect: Rect;
  ops: string;
  /** resources of the appearance form (pdf-lib literal) */
  resources: Record<string, unknown>;
  /** subtype-specific annotation entries (pdf-lib literal), Subtype included */
  annot: Record<string, unknown>;
}

/** An embedded face plus its vertical metrics in em (ascent up, descent
 *  down, both positive) — read from the font itself: pdf-lib's
 *  heightAtSize(…, {descender:false}) subtracts an UNSCALED descent and is
 *  ~0.22 em short for every 2048-unit font (Arial: 683 instead of 905). */
export interface EmbeddedFont {
  font: PDFFont;
  ascent: number;
  descent: number;
}

/** What building a mark may need from the document being written. */
export interface MarkCtx {
  doc: PDFDocument;
  project: ProjectFile;
  deps: ExportDeps;
  font(family: FontFamily, bold: boolean, italic: boolean): Promise<EmbeddedFont>;
  /** A non-legacy font (`fonts_resolve`, once per request): null when it is
   *  not on this PC; the box then exports in its legacy font. */
  resolveFont(req: FontRequest): Promise<ResolvedFont | null>;
  /** A resolved non-legacy face, embedded by its embedding policy ("full":
   *  subset; "noSubset": whole; "none": refused, naming the font). */
  fontFile(r: ResolvedFont): Promise<EmbeddedFont>;
  /** A face's file read by fontkit, WITHOUT embedding it (shaping and the
   *  font box), whatever its licence (nothing of it reaches the PDF from
   *  here); a file that cannot be read fails as for `font` / `fontFile`. */
  fontkitOf(f: Face): Promise<FkFont>;
  /** A style's font box at its size (`fontBoxOf`): the browser's answer when
   *  the dependencies can ask it (`deps.fontBox`), else the rule applied to
   *  the face's file. */
  fontBox(st: PdfResolvedStyle, f: Face): Promise<RowPiece>;
  image(mediaId: string): Promise<{ img: PDFImage; orientation: Orientation }>;
}

const KAPPA = 0.5522847498;

function ellipseOps(cx: number, cy: number, rx: number, ry: number): string {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return (
    `${num(cx + rx)} ${num(cy)} m ` +
    `${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c ` +
    `${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)} c ` +
    `${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c ` +
    `${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)} c h`
  );
}

function gs(o: number | undefined, multiply = false): { ops: string; res: Record<string, unknown> } {
  const a = o === undefined || !Number.isFinite(o) ? 1 : Math.min(Math.max(o, 0), 1);
  if (a >= 1 && !multiply) return { ops: "", res: {} };
  const g: Record<string, unknown> = { Type: "ExtGState", CA: a, ca: a };
  if (multiply) g["BM"] = "Multiply";
  return { ops: "/GS0 gs ", res: { ExtGState: { GS0: g } } };
}

/** Filled outline rings of points ([x, y, p]* in page space) as user-space ops. */
function outlineOps(pts: Float32Array, half: HalfWidth, U: (x: number, y: number) => [number, number], b: Bounds): string {
  const o = outlinePolygon(pts, pts.length / 3, half);
  if (o.dot) {
    if (!(o.dot.r > 0)) return "";
    const [x, y] = U(o.dot.x, o.dot.y);
    b.add(x - o.dot.r, y - o.dot.r);
    b.add(x + o.dot.r, y + o.dot.r);
    return ellipseOps(x, y, o.dot.r, o.dot.r) + " ";
  }
  const parts: string[] = [];
  let from = 0;
  for (const to of o.ends) {
    if (to - from >= 3) {
      for (let i = from; i < to; i++) {
        const [x, y] = U(o.ring[i * 2]!, o.ring[i * 2 + 1]!);
        b.add(x, y);
        parts.push(`${num(x)} ${num(y)} ${i === from ? "m" : "l"}`);
      }
      parts.push("h");
    }
    from = to;
  }
  return parts.length ? parts.join(" ") + " " : "";
}

function inkList(pts: Float32Array, U: (x: number, y: number) => [number, number]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const [x, y] = U(pts[i]!, pts[i + 1]!);
    out.push(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
  }
  return out;
}

/** Signature strokes are a pen of this fraction of the box's smaller side
 *  (min 0.5 pt). Must match the PDF editor's signature preview. */
export const SIGNATURE_WIDTH_FRACTION = 0.03;

export async function buildAppearance(a: PdfAnnot, geom: PageGeom, cx: MarkCtx): Promise<Appearance | null> {
  const U = (x: number, y: number): [number, number] => [geom.x + x, geom.y + geom.h - y];
  /** a page-space box → user-space Rect */
  const boxRect = (x: number, y: number, w: number, h: number): Rect => {
    const [x0, y1] = U(x, y);
    return [x0, y1 - h, x0 + w, y1];
  };
  switch (a.t) {
    case "ink": {
      const pts = decodePoints(a.p);
      if (!pts || pts.length < 3 || !finite(a.w, a.o) || !(a.w > 0)) return null;
      const c = hexRgb(a.c);
      const b = new Bounds();
      let ops: string;
      const marker = a.kind === "marker";
      const g = gs(a.o, marker);
      if (marker) {
        // constant width, round caps and joins — the editor strokes it so
        const pl = inkList(pts, U);
        const dot = pl.every((v, i) => v === pl[i % 2]);
        if (dot) {
          ops = `${g.ops}${rgbOps(c, "rg")} ${ellipseOps(pl[0]!, pl[1]!, a.w / 2, a.w / 2)} f`;
        } else {
          const path: string[] = [];
          for (let i = 0; i < pl.length; i += 2) path.push(`${num(pl[i]!)} ${num(pl[i + 1]!)} ${i ? "l" : "m"}`);
          ops = `${g.ops}${rgbOps(c, "RG")} ${num(a.w)} w 1 J 1 j ${path.join(" ")} S`;
        }
        for (let i = 0; i < pl.length; i += 2) b.add(pl[i]!, pl[i + 1]!);
        const rect = b.rect(a.w / 2 + 1);
        if (!rect) return null;
        return { rect, ops, resources: g.res, annot: { Subtype: "Ink", InkList: [pl], C: c, BS: { W: a.w } } };
      }
      const half = a.kind === "pencil" ? pencilHalfWidth(a.w) : penHalfWidth(a.w);
      const body = outlineOps(pts, half, U, b);
      if (!body) return null;
      ops = `${g.ops}${rgbOps(c, "rg")} ${body}f`;
      const rect = b.rect(1);
      if (!rect) return null;
      return { rect, ops, resources: g.res, annot: { Subtype: "Ink", InkList: [inkList(pts, U)], C: c, BS: { W: a.w } } };
    }
    case "highlight": {
      const c = hexRgb(a.c, [1, 1, 0]);
      const g = gs(a.o, true);
      const b = new Bounds();
      const quads: number[] = [];
      const body: string[] = [];
      for (const r of a.rects ?? []) {
        if (!Array.isArray(r) || !finite(...r) || !(r[2] > 0) || !(r[3] > 0)) continue;
        const [x0, y0, x1, y1] = boxRect(r[0], r[1], r[2], r[3]);
        b.add(x0, y0);
        b.add(x1, y1);
        quads.push(x0, y1, x1, y1, x0, y0, x1, y0);
        body.push(`${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re`);
      }
      const rect = b.rect(0);
      if (!rect || !body.length) return null;
      return {
        rect,
        ops: `${g.ops}${rgbOps(c, "rg")} ${body.join(" ")} f`,
        resources: g.res,
        annot: { Subtype: "Highlight", QuadPoints: quads, C: c },
      };
    }
    case "line":
    case "arrow":
    case "rect":
    case "ellipse": {
      if (!finite(a.w, ...a.a, ...a.b) || !(a.w > 0)) return null;
      const c = hexRgb(a.c);
      const [ax, ay] = U(a.a[0], a.a[1]);
      const [bx, by] = U(a.b[0], a.b[1]);
      const b = new Bounds();
      b.add(ax, ay);
      b.add(bx, by);
      const stroke = `${rgbOps(c, "RG")} ${num(a.w)} w 1 J 1 j `;
      if (a.t === "line" || a.t === "arrow") {
        let path = `${num(ax)} ${num(ay)} m ${num(bx)} ${num(by)} l`;
        if (a.t === "arrow") {
          const wings = arrowWings(a.a, a.b, a.w);
          if (wings) {
            const [w0x, w0y] = U(wings[0][0], wings[0][1]);
            const [w1x, w1y] = U(wings[1][0], wings[1][1]);
            b.add(w0x, w0y);
            b.add(w1x, w1y);
            path += ` ${num(w0x)} ${num(w0y)} m ${num(bx)} ${num(by)} l ${num(w1x)} ${num(w1y)} l`;
          }
        }
        const rect = b.rect(a.w / 2 + 1)!;
        return {
          rect,
          ops: `${stroke}${path} S`,
          resources: {},
          annot: {
            Subtype: "Line",
            L: [ax, ay, bx, by],
            LE: ["None", a.t === "arrow" ? "OpenArrow" : "None"],
            C: c,
            BS: { W: a.w },
          },
        };
      }
      const rect = b.rect(a.w / 2)!;
      const x0 = Math.min(ax, bx);
      const y0 = Math.min(ay, by);
      const w = Math.abs(bx - ax);
      const h = Math.abs(by - ay);
      const path =
        a.t === "rect" ? `${num(x0)} ${num(y0)} ${num(w)} ${num(h)} re` : ellipseOps(x0 + w / 2, y0 + h / 2, w / 2, h / 2);
      const inset = a.w / 2;
      return {
        rect,
        ops: `${stroke}${path} S`,
        resources: {},
        annot: { Subtype: a.t === "rect" ? "Square" : "Circle", C: c, BS: { W: a.w }, RD: [inset, inset, inset, inset] },
      };
    }
    case "whiteout": {
      if (!finite(a.x, a.y, a.w, a.h) || !(a.w > 0) || !(a.h > 0)) return null;
      const c = hexRgb(a.c, [1, 1, 1]);
      const rect = boxRect(a.x, a.y, a.w, a.h);
      return {
        rect,
        ops: `${rgbOps(c, "rg")} ${num(rect[0])} ${num(rect[1])} ${num(a.w)} ${num(a.h)} re f`,
        resources: {},
        annot: { Subtype: "Square", IC: c, BS: { W: 0 } },
      };
    }
    case "text":
      return textAppearance(a, boxRect, cx);
    case "image": {
      if (!finite(a.x, a.y, a.w, a.h) || !(a.w > 0) || !(a.h > 0)) return null;
      const { img, orientation } = await cx.image(a.media).catch((e: unknown) => {
        throw a.bg === true ? pagePictureError(e, a.id, cx.project) : e;
      });
      const rect = boxRect(a.x, a.y, a.w, a.h);
      const [fx, fy, fw, fh] = frameOf(a);
      const turn = turnCm(turnOf(a), (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2);
      return {
        rect,
        ops: `q ${turn}${imageMatrix(boxRect(fx, fy, fw, fh), orientation)} cm /Im0 Do Q`,
        resources: { XObject: { Im0: img.ref } },
        annot: { Subtype: "Stamp", Name: "Image" },
      };
    }
    case "signature": {
      if (!finite(a.x, a.y, a.w, a.h) || !(a.w > 0) || !(a.h > 0)) return null;
      const c = hexRgb(a.c);
      const width = Math.max(0.5, Math.min(a.w, a.h) * SIGNATURE_WIDTH_FRACTION);
      const half = penHalfWidth(width);
      const b = new Bounds();
      const lists: number[][] = [];
      let body = "";
      // drawn into the upright frame, then turned point by point
      const [fx, fy, fw, fh] = frameOf(a);
      const r = turnOf(a);
      const box = boxRect(a.x, a.y, a.w, a.h);
      const turnPt = turnPoint(r, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
      const UT = r === 0 ? U : (x: number, y: number): [number, number] => turnPt(U(x, y));
      for (const s of a.strokes ?? []) {
        const norm = decodePoints(s);
        if (!norm) continue;
        const pts = new Float32Array(norm.length);
        for (let i = 0; i + 2 < norm.length; i += 3) {
          pts[i] = fx + norm[i]! * fw;
          pts[i + 1] = fy + norm[i + 1]! * fh;
          pts[i + 2] = norm[i + 2]!;
        }
        body += outlineOps(pts, half, UT, b);
        lists.push(inkList(pts, UT));
      }
      const rect = b.rect(1);
      if (!rect || !body) return null;
      return { rect, ops: `${rgbOps(c, "rg")} ${body}f`, resources: {}, annot: { Subtype: "Ink", InkList: lists, C: c, BS: { W: width } } };
    }
  }
  return null;
}

/** `cm` operands mapping the image's unit square into `rect`, turned by `o`. */
export function imageMatrix(rect: Rect, o: Orientation): string {
  const [x0, y0, x1, y1] = rect;
  const P = (u: number, v: number): [number, number] => {
    const [X, Y] = displayedOf(o, u, v);
    return [x0 + X * (x1 - x0), y1 - Y * (y1 - y0)];
  };
  const [ex, ey] = P(0, 0);
  const [ax, ay] = P(1, 0);
  const [cx, cy] = P(0, 1);
  return `${num(ax - ex)} ${num(ay - ey)} ${num(cx - ex)} ${num(cy - ey)} ${num(ex)} ${num(ey)}`;
}

/* ---------------- text boxes ---------------- */

type TextAnnot = Extract<PdfAnnot, { t: "text" }>;

async function textAppearance(
  a: TextAnnot,
  boxRect: (x: number, y: number, w: number, h: number) => Rect,
  cx: MarkCtx,
): Promise<Appearance | null> {
  if (!finite(a.x, a.y, a.w, a.h, a.size) || !(a.w > 0) || !(a.h > 0) || !(a.size > 0)) return null;
  const text = typeof a.text === "string" ? a.text : "";
  const rect = boxRect(a.x, a.y, a.w, a.h);
  // laid out in the upright frame (= the box without a turn), then turned
  const [fx, fy, W, H] = frameOf(a);
  const frame = boxRect(fx, fy, W, H);
  const turn = turnCm(turnOf(a), (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2);
  const c = hexRgb(a.c);
  const size = a.size;
  const lh = size * LINE_HEIGHT;
  const baseStyle: PdfResolvedStyle = {
    font: a.font,
    ...(a.fontId !== undefined ? { fontId: a.fontId } : {}),
    size,
    c: a.c,
    bold: !!a.bold,
    italic: !!a.italic,
  };
  const base = await faceOf(baseStyle, cx);
  const { lib, bold, italic } = base;
  // Style runs (0.9.4): every piece of the text with its own style and face.
  // A box without runs (or whose runs say nothing) is ONE piece in the base
  // style, drawn exactly as before (invariant R1).
  const styled = normalizeRuns(text, a, a.runs) !== undefined;
  const segs = styled ? segmentsOf(text, a, a.runs) : text ? [{ s: 0, e: text.length, style: baseStyle }] : [];
  const segFaces: Face[] = [];
  for (const sg of segs) segFaces.push(styled ? await faceOf(sg.style, cx) : base);
  const clip = `${num(frame[0])} ${num(frame[1])} ${num(W)} ${num(H)} re W n`;
  const back = boxBackOps(a, rect);
  const annot: Record<string, unknown> = {
    Subtype: "FreeText",
    Contents: PDFHexString.fromText(text),
    DA: PDFString.of(`${rgbOps(c, "rg")} /Helv ${num(size)} Tf`),
    BS: { W: 0 },
  };

  // Arabic (0.9.5): shaped and drawn as real text when every piece's font
  // can draw every character of it (null: some cannot).
  const arabic = hasArabic(text);
  const shapers = arabic ? await shapingFaces(text, segs, segFaces, cx) : null;
  if (arabic && shapers === null) {
    // A character the font has no glyph for: the browser draws the box,
    // with its own font fallback (see raster.ts).
    const png = await cx.deps.rasterizeText({
      text,
      font: a.font,
      ...(lib ? { fontId: lib.requested } : {}),
      bold,
      italic,
      size,
      color: hexOf(c),
      align: a.align,
      w: W,
      h: H,
      scale: rasterScale(W, H),
      lineHeight: lh,
      ...(styled
        ? {
            runs: segs.map((sg, i): RasterTextRun => {
              const f = segFaces[i]!;
              return {
                s: sg.s,
                e: sg.e,
                font: sg.style.font,
                ...(f.lib ? { fontId: f.lib.requested } : {}),
                bold: f.bold,
                italic: f.italic,
                size: sg.style.size,
                color: hexOf(hexRgb(sg.style.c)),
              };
            }),
          }
        : {}),
    });
    const img = await cx.doc.embedPng(png);
    return {
      rect,
      ops: `${back}q ${turn}${clip} ${num(W)} 0 0 ${num(H)} ${num(frame[0])} ${num(frame[1])} cm /Im0 Do Q`,
      resources: { XObject: { Im0: img.ref } },
      annot,
    };
  }

  // Faces embedded once each, named F0 (the box's own) .. Fn in first use.
  const baseEmb = await embedFace(base, cx);
  const names = new Map<EmbeddedFont, string>([[baseEmb, "F0"]]);
  // `fk`: the face's fontkit font in a box that is shaped (Arabic) only.
  const pieces: { emb: EmbeddedFont; name: string; size: number; rg: string; row: RowPiece; fk?: FkFont }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const emb = styled ? await embedFace(segFaces[i]!, cx) : baseEmb;
    let name = names.get(emb);
    if (name === undefined) names.set(emb, (name = `F${names.size}`));
    const sz = segs[i]!.style.size;
    const rg = styled ? rgbOps(hexRgb(segs[i]!.style.c), "rg") : rgbOps(c, "rg");
    // Rows of a box with runs (0.9.5): each piece's font box as the screen
    // reads it (`fontBoxOf`), not the file's hhea ascent / descent, so every
    // baseline lands where the editor shows it. A box without runs keeps its
    // fixed pitch below (R1).
    const row = styled ? await cx.fontBox(segs[i]!.style, segFaces[i]!) : { size: sz, asc: emb.ascent * sz, desc: emb.descent * sz };
    pieces.push({ emb, name, size: sz, rg, row, ...(shapers ? { fk: shapers[i]! } : {}) });
  }
  // A shaped (Arabic) box without runs was a browser-drawn picture before
  // 0.9.5, placed by the browser's font box as the editor places it: as
  // real text it keeps that box (`fontBox`), not the file's hhea. Every
  // other box without runs keeps hhea (R1).
  const box0 = shapers && !styled ? await cx.fontBox(baseStyle, base) : null;
  const asc = box0 ? box0.asc : baseEmb.ascent * size;
  const desc = box0 ? box0.desc : baseEmb.descent * size;
  const strut: RowPiece = styled ? await cx.fontBox(baseStyle, base) : { size, asc, desc };
  const segAt = (i: number): number => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid]!.e <= i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const parts: string[] = [];
  let tf = "";
  let rg = "";
  let row = 0;
  let top = 0;
  let ps = 0;
  for (const para of text.split(/\r\n|\r|\n/)) {
    const bidi = paragraphBidi(para);
    // an Arabic box: the paragraph as drawn (mirrored at right-to-left
    // levels), the text a right-to-left group is shaped from in its word
    const mir = shapers ? logicalMirrored(bidi, 0, para.length) : para;
    // the paragraph's pieces, offsets into the paragraph
    const local: (MeasurePiece & { seg: number })[] = [];
    if (para) for (let k = segAt(ps); k < segs.length && segs[k]!.s < ps + para.length; k++) {
      local.push({ s: Math.max(segs[k]!.s, ps) - ps, e: Math.min(segs[k]!.e, ps + para.length) - ps, seg: k });
    }
    const measure = rangeMeasurer(local, (k, s, e) => {
      const p = pieces[local[k]!.seg]!;
      const t = para.slice(s, e);
      return p.fk && hasArabic(t) ? shapedWidth(p.fk, mir, para, s, e, p.size) : p.emb.font.widthOfTextAtSize(t, p.size);
    });
    for (const [s, e] of wrapRanges(para, W, measure)) {
      let baseline: number;
      if (!styled) {
        baseline = row * lh + (lh - (asc + desc)) / 2 + asc;
        row++;
        if (baseline - asc > H) break; // fully below the frame: clipped anyway
      } else {
        const on = local.filter((p) => p.s < e && p.e > s).map((p) => pieces[p.seg]!.row);
        const m = rowMetrics(on, strut);
        baseline = top + m.baseline;
        top += m.height;
        if (baseline - Math.max(strut.asc, ...on.map((p) => p.asc)) > H) break;
      }
      let groups: ({ seg: number; text: string } | VisualGroup)[];
      if (shapers) {
        // an Arabic box: groups with their logical ranges, so a right-to-
        // left group can be shaped from its logical text
        groups = visualGroups(bidi, s, e, styled ? (i) => segAt(ps + i) : () => 0);
      } else if (!styled) {
        const visual = visualLine(bidi, s, e);
        groups = visual ? [{ seg: 0, text: visual }] : [];
      } else {
        groups = visualGroups(bidi, s, e, (i) => segAt(ps + i));
      }
      if (!groups.length) continue;
      // a right-to-left group with Arabic in it, shaped (visual order)
      const shaped = groups.map((g): FkRun | null => {
        const p = pieces[g.seg]!;
        if (!p.fk || !("rtl" in g) || !g.rtl || !hasArabic(g.text)) return null;
        return shapeRtlIn(p.fk, mir, para, g.s, g.e, s, e);
      });
      const widths = groups.map((g, i) => {
        const p = pieces[g.seg]!;
        const run = shaped[i];
        return run ? runWidth(p.fk!, run, p.size) : p.emb.font.widthOfTextAtSize(g.text, p.size);
      });
      let x = alignX(a.align, W, widths.reduce((t, w) => t + w, 0));
      // A line with shaped Arabic in it is one marked-content span whose
      // /ActualText is the line's logical text: a reader that honours it
      // copies and searches that text instead of rebuilding it from the
      // glyphs. ONE span per line, not per group: pdf.js (which ignores
      // ActualText) ends a text item at every marked-content boundary, so a
      // span per group would cut a line into items in visual order and its
      // Find would no longer see the words whole.
      const span = shaped.some((r) => r !== null);
      if (span) parts.push(`/Span <</ActualText ${PDFHexString.fromText(para.slice(s, e)).toString()}>> BDC`);
      groups.forEach((g, i) => {
        const p = pieces[g.seg]!;
        const f = `/${p.name} ${num(p.size)} Tf`;
        if (f !== tf) parts.push((tf = f));
        if (p.rg !== rg) parts.push((rg = p.rg));
        const run = shaped[i];
        const show = run ? shapedShow(p.emb.font, p.fk!, run, p.size) : `${encodeVisual(p.emb.font, g.text)} Tj`;
        parts.push(`1 0 0 1 ${num(frame[0] + x)} ${num(frame[3] - baseline)} Tm ${show}`);
        x += widths[i]!;
      });
      if (span) parts.push("EMC");
    }
    ps += para.length + (text.startsWith("\r\n", ps + para.length) ? 2 : 1);
  }
  const ops = back + (parts.length ? `q ${turn}${clip} BT ${parts.join(" ")} ET Q` : "");
  const fonts: Record<string, PDFRef> = {};
  for (const [emb, name] of names) fonts[name] = emb.font.ref;
  return { rect, ops: ops.trimEnd(), resources: { Font: fonts }, annot };
}

/** The face one style draws with: a non-legacy font that is on this PC draws
 *  with the face it resolved; a style without one (or whose font is missing
 *  here) takes the legacy path, exactly as 0.9.3: no fonts_resolve call at
 *  all without a fontId (I1). */
export interface Face {
  font: FontFamily;
  lib: ResolvedFont | null;
  bold: boolean;
  italic: boolean;
}

async function faceOf(st: PdfResolvedStyle, cx: MarkCtx): Promise<Face> {
  const req = fontRequestOf(st.font, st.fontId, st.bold, st.italic);
  const lib = req === null ? null : await cx.resolveFont(req);
  // Impact has no bold or italic face: drawn plain, as the editor shows it
  const plain = lib === null && st.font === "Impact";
  return { font: st.font, lib, bold: lib ? lib.bold : !plain && st.bold, italic: lib ? lib.italic : !plain && st.italic };
}

/** Embedded once per document: `cx` caches by face, so equal faces are the
 *  same object. */
function embedFace(f: Face, cx: MarkCtx): Promise<EmbeddedFont> {
  return f.lib ? cx.fontFile(f.lib) : cx.font(f.font, f.bold, f.italic);
}

/** An Arabic box's fontkit font per segment (by index), when every segment's
 *  face can draw every character of it AS DRAWN (mirrored where a right-to-
 *  left level mirrors it) and shaping yields no .notdef; null when one
 *  cannot, and the box falls back to a picture, as every Arabic box did
 *  before 0.9.5. Reads the font files, embeds nothing: a box that falls back
 *  adds no font. The licence is NOT a reason to fall back: a font that may
 *  not be embedded but could draw the box fails when it is embedded, exactly
 *  as for any other text; one that could not draw it anyway, or whose file
 *  cannot be read, leaves the box a picture as before. */
async function shapingFaces(
  text: string,
  segs: readonly { s: number; e: number }[],
  faces: readonly Face[],
  cx: MarkCtx,
): Promise<FkFont[] | null> {
  const drawn = drawnText(text);
  const out: FkFont[] = [];
  for (let i = 0; i < segs.length; i++) {
    let fk: FkFont;
    try {
      fk = await cx.fontkitOf(faces[i]!);
    } catch (e) {
      if (e instanceof PdfExportError) return null;
      throw e;
    }
    if (!canShape(fk, drawn.slice(segs[i]!.s, segs[i]!.e))) return null;
    out.push(fk);
  }
  return out;
}

/** The operators showing a shaped run from the current text position: one
 *  `TJ` with each glyph's own advance (GPOS kerning, zero-width marks) as the
 *  adjustment against the font's /W width, a mark's offset as a shift before
 *  it and back after it, and its vertical offset as a text rise (`Ts`). */
function shapedShow(font: PDFFont, fk: FkFont, run: FkRun, size: number): string {
  const codes = encodeGlyphs(font, rtlToUnicodeOrder(run.glyphs));
  const upm = fk.unitsPerEm > 0 ? fk.unitsPerEm : 1000;
  const k = 1000 / upm;
  const ops: string[] = [];
  let arr: string[] = [];
  let pend = 0;
  let rise = 0;
  const flushNum = (): void => {
    if (Math.abs(pend) >= 0.0005) arr.push(num(pend));
    pend = 0;
  };
  const flush = (): void => {
    flushNum();
    if (arr.length) ops.push(`[${arr.join(" ")}] TJ`);
    arr = [];
  };
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i] ?? { xAdvance: g.advanceWidth, xOffset: 0, yOffset: 0 };
    const r = (p.yOffset * size) / upm;
    if (Math.abs(r - rise) >= 0.0005) {
      flush();
      ops.push(`${num(r)} Ts`);
      rise = r;
    }
    // TJ numbers move LEFT by n/1000 em: an offset to the right is negative
    pend -= p.xOffset * k;
    flushNum();
    arr.push(`<${codes[i]}>`);
    pend += (p.xOffset + g.advanceWidth - p.xAdvance) * k;
  });
  flush();
  if (rise !== 0) ops.push("0 Ts");
  return ops.join(" ");
}

const hexOf = (c: [number, number, number]): string =>
  `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;

/** A text box's fill and 1 pt border (each optional), behind its text: the
 *  page-space box itself — the same for every turn, as the box does not turn
 *  — with the border inset half its width so all of it stays inside the
 *  appearance's BBox. "" for neither; else ends in a space. */
export function boxBackOps(a: { bg?: string; border?: string }, rect: Rect): string {
  const [x0, y0, x1, y1] = rect;
  let out = "";
  if (typeof a.bg === "string" && /^#[0-9a-f]{6}$/i.test(a.bg)) {
    out += `q ${rgbOps(hexRgb(a.bg), "rg")} ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f Q `;
  }
  if (typeof a.border === "string" && /^#[0-9a-f]{6}$/i.test(a.border) && x1 - x0 > 1 && y1 - y0 > 1) {
    out += `q ${rgbOps(hexRgb(a.border), "RG")} 1 w 0 J 0 j ${num(x0 + 0.5)} ${num(y0 + 0.5)} ${num(x1 - x0 - 1)} ${num(y1 - y0 - 1)} re S Q `;
  }
  return out;
}

/** Right-to-left script characters: fontkit's layout (inside pdf-lib's
 *  encodeText) REVERSES the whole glyph run when a string's first
 *  script-bearing character is one of these (measured: "שלום" encodes as
 *  ם,ו,ל,ש), which would undo the bidi pass. */
const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Hex glyph string of an already-VISUAL-order string, in exactly that order:
 *  runs without right-to-left script letters are encoded whole (they keep
 *  their substitutions), right-to-left letters one at a time (a single glyph
 *  cannot be reversed). Hebrew needs no shaping, so nothing is lost. */
export function encodeVisual(font: PDFFont, visual: string): string {
  if (!RTL_SCRIPT.test(visual)) return font.encodeText(visual).toString();
  let hex = "";
  let run = "";
  const flush = (): void => {
    if (run) hex += font.encodeText(run).toString().slice(1, -1);
    run = "";
  };
  for (const ch of visual) {
    if (RTL_SCRIPT.test(ch)) {
      flush();
      hex += font.encodeText(ch).toString().slice(1, -1);
    } else {
      run += ch;
    }
  }
  flush();
  return `<${hex}>`;
}

function alignX(align: PdfTextStyle["align"], boxW: number, lineW: number): number {
  if (align === "center") return (boxW - lineW) / 2;
  if (align === "right") return boxW - lineW;
  return 0;
}

/* ---------------- writing them out ---------------- */

/** Write `apps` onto `page`: as annotations, or painted into its content. */
export function placeAppearances(
  doc: PDFDocument,
  page: PDFPage,
  items: { id: string; app: Appearance }[],
  flatten: boolean,
  now: Date,
): void {
  if (!items.length) return;
  const ctx = doc.context;
  const forms: PDFRef[] = [];
  for (const { app } of items) {
    const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Form", FormType: 1, BBox: app.rect };
    if (Object.keys(app.resources).length) dict["Resources"] = app.resources;
    forms.push(ctx.register(ctx.flateStream(app.ops, dict as never)));
  }
  if (flatten) {
    const ops: string[] = [];
    for (const ref of forms) {
      const name = page.node.newXObject("TrtMark", ref);
      ops.push(`q ${name.asString()} Do Q`);
    }
    // Wrap what is already there in q/Q so a content stream that leaves its
    // graphics state changed (an unbalanced cm) cannot move ours.
    const start = ctx.register(ctx.stream("q\n"));
    const end = ctx.register(ctx.stream("\nQ\n"));
    page.node.wrapContentStreams(start, end);
    page.node.addContentStream(ctx.register(ctx.flateStream(ops.join("\n"))));
    return;
  }
  const date = PDFString.fromDate(now);
  items.forEach(({ id, app }, i) => {
    const annot = ctx.obj({
      Type: "Annot",
      ...app.annot,
      Rect: app.rect,
      F: 4,
      M: date,
      NM: PDFHexString.fromText(`taroting-${id}`),
      P: page.ref,
      AP: { N: forms[i]! },
    } as never);
    page.node.addAnnot(ctx.register(annot));
  });
}

/** Paint page pictures (`bg` image marks, 0.9.5) into `page` as its FIRST
 *  content, under whatever the page already draws and whatever is added
 *  after: one balanced `q … Do Q` stream inserted at the head of /Contents.
 *  Always page content, whatever the marks' mode — a picture page must print
 *  and open everywhere as the page itself, never as an annotation a viewer
 *  lists or a reader deletes. */
export function placeUnderlay(doc: PDFDocument, page: PDFPage, items: { app: Appearance }[]): void {
  if (!items.length) return;
  const ctx = doc.context;
  const ops: string[] = [];
  for (const { app } of items) {
    const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Form", FormType: 1, BBox: app.rect };
    if (Object.keys(app.resources).length) dict["Resources"] = app.resources;
    const ref = ctx.register(ctx.flateStream(app.ops, dict as never));
    ops.push(`q ${page.node.newXObject("TrtPage", ref).asString()} Do Q`);
  }
  const under = ctx.register(ctx.flateStream(`${ops.join("\n")}\n`));
  // normalizedEntries turns a single /Contents stream into an array (and
  // wraps existing content in q/Q); a fresh blank page has none at all
  const { Contents } = page.node.normalizedEntries();
  if (Contents) Contents.insert(0, under);
  else page.node.set(PDFName.of("Contents"), ctx.obj([under]));
}

/** `subset: false` embeds the whole file (a font whose license allows
 *  embedding only unsubsetted). */
export async function embedWithMetrics(doc: PDFDocument, bytes: Uint8Array, subset = true): Promise<EmbeddedFont> {
  const face = fontkit.create(bytes) as unknown as { ascent: number; descent: number; unitsPerEm: number };
  const upm = face.unitsPerEm > 0 ? face.unitsPerEm : 1000;
  const font = await doc.embedFont(bytes, { subset });
  return { font, ascent: Math.abs(face.ascent) / upm, descent: Math.abs(face.descent) / upm };
}

/** Load, cache and embed fonts and pictures for one document. */
export function markContext(doc: PDFDocument, project: ProjectFile, deps: ExportDeps): MarkCtx {
  const fonts = new Map<string, Promise<EmbeddedFont>>();
  const resolved = new Map<string, Promise<ResolvedFont | null>>();
  const files = new Map<string, Promise<EmbeddedFont>>();
  const images = new Map<string, Promise<{ img: PDFImage; orientation: Orientation }>>();
  const style = (bold: boolean, italic: boolean): string =>
    bold && italic ? " (bold italic)" : bold ? " (bold)" : italic ? " (italic)" : "";
  // A face's file, read once whether it is embedded, shaped or measured.
  const legacyBytes = new Map<string, Promise<Uint8Array>>();
  const libBytes = new Map<string, Promise<Uint8Array>>();
  const fks = new Map<string, Promise<FkFont>>();
  const boxes = new Map<string, Promise<RowPiece>>();
  const bytesOfLegacy = (family: FontFamily, bold: boolean, italic: boolean): Promise<Uint8Array> => {
    const key = `${family}|${bold}|${italic}`;
    let p = legacyBytes.get(key);
    if (!p) {
      p = (async () => {
        const bytes = await deps.fontBytes(family, bold, italic).catch(() => null);
        if (!bytes) {
          throw new PdfExportError(
            "font-missing",
            `The font ${family}${style(bold, italic)} is not installed on this PC, so a text box that uses it cannot be exported. Pick another font for it and export again.`,
          );
        }
        return bytes;
      })();
      legacyBytes.set(key, p);
    }
    return p;
  };
  // a library file's bytes, read whatever its licence (`bytesOfLib` checks)
  const fileOfLib = (r: ResolvedFont): Promise<Uint8Array> => {
    let p = libBytes.get(r.path);
    if (!p) {
      p = (async () => {
        const bytes = await deps.readBytes(r.path).catch(() => null);
        if (!bytes) {
          throw new PdfExportError(
            "font-missing",
            `The font ${fontDisplayName(r.requested)} couldn't be read, so a text box that uses it cannot be exported. Pick another font for it and export again.`,
          );
        }
        return bytes;
      })();
      libBytes.set(r.path, p);
    }
    return p;
  };
  const bytesOfLib = async (r: ResolvedFont): Promise<Uint8Array> => {
    if (r.embed === "none") {
      throw new PdfExportError(
        "font-restricted",
        `The font ${fontDisplayName(r.requested)} can't go in a PDF because its license doesn't allow it, so pick another font for the text that uses it.`,
      );
    }
    return fileOfLib(r);
  };
  const fkOf = (f: Face): Promise<FkFont> => {
    const key = f.lib ? `lib|${f.lib.path}` : `${f.font}|${f.bold}|${f.italic}`;
    let p = fks.get(key);
    if (!p) {
      p = (f.lib ? fileOfLib(f.lib) : bytesOfLegacy(f.font, f.bold, f.italic)).then(fkFontOf);
      fks.set(key, p);
    }
    return p;
  };
  return {
    doc,
    project,
    deps,
    font(family, bold, italic) {
      const key = `${family}|${bold}|${italic}`;
      let p = fonts.get(key);
      if (!p) {
        p = bytesOfLegacy(family, bold, italic).then((bytes) => embedWithMetrics(doc, bytes));
        fonts.set(key, p);
      }
      return p;
    },
    fontkitOf: fkOf,
    fontBox(st, f) {
      const key = `${st.font}|${st.fontId ?? ""}|${st.bold}|${st.italic}|${st.size}|${f.lib ? f.lib.path : ""}`;
      let p = boxes.get(key);
      if (!p) {
        p = (async (): Promise<RowPiece> => {
          const spec = { font: st.font, ...(st.fontId !== undefined ? { fontId: st.fontId } : {}), bold: st.bold, italic: st.italic, size: st.size };
          const asked = deps.fontBox ? await deps.fontBox(spec).catch(() => null) : null;
          if (asked && Number.isFinite(asked.asc) && Number.isFinite(asked.desc) && asked.asc >= 0 && asked.desc >= 0) {
            return { size: st.size, asc: asked.asc, desc: asked.desc };
          }
          const fk = await fkOf(f);
          return { size: st.size, ...fontBoxOf(fontBoxTables(fk), st.size) };
        })();
        boxes.set(key, p);
      }
      return p;
    },
    resolveFont(req) {
      const key = `${req.id}|${req.bold}|${req.italic}`;
      let p = resolved.get(key);
      if (!p) {
        p = deps.resolveFonts([req]).then(
          (out) => {
            const r = out[0];
            // `found` first: a missing font's other fields are empty
            return r && r.found === true && typeof r.path === "string" && r.path !== "" ? r : null;
          },
          () => null,
        );
        resolved.set(key, p);
      }
      return p;
    },
    fontFile(r) {
      const key = `${r.path}|${r.embed}`;
      let p = files.get(key);
      if (!p) {
        p = bytesOfLib(r).then((bytes) => embedWithMetrics(doc, bytes, r.embed !== "noSubset"));
        files.set(key, p);
      }
      return p;
    },
    image(mediaId) {
      let p = images.get(mediaId);
      if (!p) {
        p = (async () => {
          const m: MediaRef | undefined = project.media.find((x) => x.id === mediaId);
          if (!m) throw new PdfExportError("image-missing", "A picture on a page is missing from the project.");
          const st = await deps.fileStat(m.path).catch(() => null);
          if (!st) {
            throw new PdfExportError("image-missing", `The picture ${baseName(m.path)} is missing. Relink it or remove it from the page, then export again.`, m.path);
          }
          let prepared;
          try {
            prepared = await prepareImage(m, await deps.readBytes(m.path), deps);
            const img = prepared.kind === "jpg" ? await doc.embedJpg(prepared.bytes) : await doc.embedPng(prepared.bytes);
            return { img, orientation: prepared.orientation };
          } catch (e) {
            if (e instanceof PdfExportError) throw e;
            throw new PdfExportError("image-invalid", `The picture ${baseName(m.path)} could not be read.`, m.path);
          }
        })();
        images.set(mediaId, p);
      }
      return p;
    },
  };
}

/** True when the dictionary is a widget annotation (used by flatten.ts too). */
export function isSubtype(d: PDFDict, subtype: string): boolean {
  const s = d.get(PDFName.of("Subtype"));
  return s instanceof PDFName && s.asString() === `/${subtype}`;
}
