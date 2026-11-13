// The layout of a text generator with styled parts (0.9.5): ONE layout for
// measuring the box, for the image canvas, the image export, and the DOM
// spans. Only texts whose runs are active (core/gen-text-runs `activeRuns`)
// ever come here; a plain text keeps the code it always had.
//
// A row is the text between two line breaks, cut by style. Neighbours drawn
// in the same font (a colour-only run) stay ONE unit, measured and drawn with
// one call so the shaping inside it is never broken; their colours are paints
// clipped side by side. Row heights follow the CSS inline model with the
// base style as a strut (core/pdf-runs `rowMetrics`), from the canvas's own
// font-box metrics, so DOM spans and the canvas agree.

import { normalizeHexColor } from "../../core/session";
import { activeRuns, genSegments, styleGen, type TextGen } from "../../core/gen-text-runs";
import { rowMetrics } from "../../core/pdf-runs";
import { cssFont, fontString } from "./generators";

/** What layout asks of the text engine. Widths and metrics in px. */
export interface TextMeasurer {
  width(font: string, text: string): number;
  /** The font box above (`asc`) and below (`desc`) the alphabetic baseline,
   *  and how far the alphabetic baseline sits below the em box's middle
   *  (`mid`, positive downwards). */
  metrics(font: string): { asc: number; desc: number; mid: number };
}

export interface StyledPaint {
  /** layer px, absolute in the row */
  x0: number;
  x1: number;
  color: string;
  /** Set only on a unit past STYLED_SPLIT_WORK: this paint's own slice of
   *  the unit's text, drawn by itself at x0 with no clip. */
  text?: string;
}
export interface StyledUnit {
  x: number;
  w: number;
  size: number;
  font: string;
  text: string;
  paints: StyledPaint[];
}
export interface StyledRow {
  top: number;
  height: number;
  /** below the row's top */
  baseline: number;
  width: number;
  units: StyledUnit[];
}
export interface StyledLayout {
  width: number;
  height: number;
  rows: StyledRow[];
}

/** Round UP to the next even integer, min 2 (generators.ts measureText). */
const evenUp = (v: number): number => Math.max(2, Math.ceil(v / 2) * 2);

/* ------------------------------------------------------------------ */
/* The real measurer                                                   */
/* ------------------------------------------------------------------ */

let mctx: CanvasRenderingContext2D | null = null;
let metricCache = new Map<string, { asc: number; desc: number; mid: number }>();

const pxOf = (font: string): number => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 16;
};

function measureContext(): CanvasRenderingContext2D | null {
  if (mctx) return mctx;
  if (typeof document === "undefined") return null;
  mctx = document.createElement("canvas").getContext("2d");
  return mctx;
}

const realMeasurer: TextMeasurer = {
  width(font, text) {
    const c = measureContext();
    if (!c) return text.length * pxOf(font) * 0.6;
    c.font = font;
    return c.measureText(text).width;
  },
  metrics(font) {
    const hit = metricCache.get(font);
    if (hit) return hit;
    const c = measureContext();
    let out: { asc: number; desc: number; mid: number };
    if (!c) {
      const px = pxOf(font);
      out = { asc: 0.9 * px, desc: 0.22 * px, mid: 0.34 * px };
    } else {
      c.font = font;
      c.textBaseline = "alphabetic";
      const a = c.measureText("Hg");
      c.textBaseline = "middle";
      const m = c.measureText("Hg");
      c.textBaseline = "alphabetic";
      // fontBoundingBoxAscent is the distance UP from the line textBaseline
      // names to the top of the font box: the same top for both, so the
      // difference is how far the alphabetic line sits below the middle one.
      out = { asc: a.fontBoundingBoxAscent, desc: a.fontBoundingBoxDescent, mid: a.fontBoundingBoxAscent - m.fontBoundingBoxAscent };
    }
    if (metricCache.size > 256) metricCache = new Map();
    metricCache.set(font, out);
    return out;
  },
};

/** The measurer every caller in the app uses (canvas metrics). */
export function textMeasurer(): TextMeasurer {
  return realMeasurer;
}

/** Forget cached font metrics (the font runtime changed). */
export function forgetTextMetrics(): void {
  metricCache = new Map();
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

interface Piece {
  font: string;
  size: number;
  text: string;
  /** colour boundaries: [offset in text, colour] */
  colours: [number, string][];
}

/**
 * A unit with N colour boundaries over L UTF-16 units is measured as N
 * prefixes and drawn as N + 1 clipped copies of the whole unit: about N x L
 * of shaping work. Past this much, the unit is measured and drawn slice by
 * slice instead (each colour's own text at its own x): linear in L, at the
 * price of shaping across a colour boundary. Ordinary texts never get near it.
 */
export const STYLED_SPLIT_WORK = 200_000;

/** The styled layout of `g` (its runs active or not: without, one style). */
export function layoutStyledText(g: TextGen, m: TextMeasurer = textMeasurer()): StyledLayout {
  const baseFont = fontString(g);
  const bm = m.metrics(baseFont);
  const strut = { size: g.sizePx, asc: bm.asc, desc: bm.desc };
  const segs = activeRuns(g)
    ? genSegments(g)
    : g.text.length > 0
      ? [{ s: 0, e: g.text.length, style: { font: g.fontFamily, ...(g.fontId !== undefined ? { fontId: g.fontId } : {}), size: g.sizePx, c: g.color, bold: g.bold, italic: g.italic } }]
      : [];
  const fonts = new Map<string, string>();
  const fontOf = (st: (typeof segs)[number]["style"]): string => {
    const k = `${st.font}\u0000${st.fontId ?? ""}\u0000${st.size}\u0000${st.bold}\u0000${st.italic}`;
    let f = fonts.get(k);
    if (f === undefined) {
      f = fontString(styleGen(st));
      fonts.set(k, f);
    }
    return f;
  };
  const rows: StyledRow[] = [];
  let top = 0;
  let maxW = 0;
  let ls = 0;
  let si = 0;
  const text = g.text;
  while (ls <= text.length) {
    let le = text.indexOf("\n", ls);
    if (le < 0) le = text.length;
    const pieces: Piece[] = [];
    while (si < segs.length && segs[si]!.e <= ls) si++;
    for (let k = si; k < segs.length && segs[k]!.s < le; k++) {
      const sg = segs[k]!;
      const s = Math.max(sg.s, ls);
      const e = Math.min(sg.e, le);
      if (e <= s) continue;
      const font = fontOf(sg.style);
      const color = sg.style.c;
      const last = pieces[pieces.length - 1];
      if (last && last.font === font) {
        if (last.colours[last.colours.length - 1]![1] !== color) last.colours.push([last.text.length, color]);
        last.text += text.slice(s, e);
      } else {
        pieces.push({ font, size: sg.style.size, text: text.slice(s, e), colours: [[0, color]] });
      }
    }
    const units: StyledUnit[] = [];
    let x = 0;
    for (const p of pieces) {
      const w = m.width(p.font, p.text);
      const paints: StyledPaint[] = [];
      let x0 = x;
      if ((p.colours.length - 1) * p.text.length > STYLED_SPLIT_WORK) {
        // each colour's slice measured (and later drawn) on its own
        for (let i = 0; i < p.colours.length; i++) {
          const from = p.colours[i]![0];
          const next = p.colours[i + 1];
          const slice = p.text.slice(from, next ? next[0] : p.text.length);
          const x1 = x0 + m.width(p.font, slice);
          paints.push({ x0, x1, color: p.colours[i]![1], text: slice });
          x0 = x1;
        }
      } else {
        // each inner colour boundary measured once, as the prefix before it
        for (let i = 0; i < p.colours.length; i++) {
          const next = p.colours[i + 1];
          const x1 = next ? x + m.width(p.font, p.text.slice(0, next[0])) : x + w;
          paints.push({ x0, x1, color: p.colours[i]![1] });
          x0 = x1;
        }
      }
      units.push({ x, w, size: p.size, font: p.font, text: p.text, paints });
      x += w;
    }
    const rm = rowMetrics(
      units.map((u) => {
        const mm = m.metrics(u.font);
        return { size: u.size, asc: mm.asc, desc: mm.desc };
      }),
      strut,
    );
    rows.push({ top, height: rm.height, baseline: rm.baseline, width: x, units });
    top += rm.height;
    if (x > maxW) maxW = x;
    ls = le + 1;
  }
  return { width: evenUp(maxW), height: evenUp(top), rows };
}

/** The media box of a styled text (what `measureText` answers for one). */
export function measureStyledText(g: TextGen, m: TextMeasurer = textMeasurer()): { width: number; height: number } {
  const l = layoutStyledText(g, m);
  return { width: l.width, height: l.height };
}

/**
 * How far the styled layout's baselines must move so a row in the base style
 * lands exactly where the plain renderer draws it (`fillText` at the middle
 * of a 1.25 line under textBaseline "middle"): the plain alphabetic baseline
 * of row 0 minus the strut row's baseline.
 */
export function plainDelta(g: TextGen, m: TextMeasurer = textMeasurer()): number {
  const bm = m.metrics(fontString(g));
  const lh = g.sizePx * 1.25;
  const plain = 0.5 * lh + bm.mid;
  return plain - rowMetrics([], { size: g.sizePx, asc: bm.asc, desc: bm.desc }).baseline;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/** Far enough left / right of any row that a clip never cuts a glyph's
 *  overhang at the unit's outer edges. */
const OUTSIDE = 1e6;

type Paintable = Pick<
  CanvasRenderingContext2D,
  "font" | "fillStyle" | "textAlign" | "textBaseline" | "fillText" | "save" | "restore" | "beginPath" | "rect" | "clip"
>;

/** Paint a layout in layer px (the context's transform already set),
 *  baselines moved by `delta`. A unit of one colour is one fillText; one of
 *  several is the same fillText once per colour, each clipped to its part
 *  (past STYLED_SPLIT_WORK: each colour's own slice, unclipped). */
export function paintStyledText(ctx: Paintable, layout: StyledLayout, delta: number): void {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const row of layout.rows) {
    const y = row.top + row.baseline + delta;
    for (const u of row.units) {
      ctx.font = u.font;
      if (u.paints.length === 1) {
        const c = normalizeHexColor(u.paints[0]!.color, "");
        if (c === "") continue;
        ctx.fillStyle = c;
        ctx.fillText(u.text, u.x, y);
        continue;
      }
      for (let i = 0; i < u.paints.length; i++) {
        const p = u.paints[i]!;
        const c = normalizeHexColor(p.color, "");
        if (c === "") continue;
        if (p.text !== undefined) {
          // a unit split for its size: each slice by itself, no clip
          ctx.fillStyle = c;
          ctx.fillText(p.text, p.x0, y);
          continue;
        }
        const x0 = i === 0 ? p.x0 - OUTSIDE : p.x0;
        const x1 = i === u.paints.length - 1 ? p.x1 + OUTSIDE : p.x1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, row.top - row.height, x1 - x0, row.height * 3);
        ctx.clip();
        ctx.fillStyle = c;
        ctx.fillText(u.text, u.x, y);
        ctx.restore();
      }
    }
  }
}

/**
 * Lay a styled text out as DOM: one block per row at the row's height (the
 * base font as its strut), one span per style. Text goes in through
 * `textContent` only.
 */
export function renderStyledDom(el: HTMLElement, g: TextGen, m: TextMeasurer = textMeasurer()): void {
  el.replaceChildren();
  const layout = layoutStyledText(g, m);
  const segs = activeRuns(g) ? genSegments(g) : [];
  const base = cssFont(g);
  let ls = 0;
  for (const row of layout.rows) {
    let le = g.text.indexOf("\n", ls);
    if (le < 0) le = g.text.length;
    const div = document.createElement("div");
    div.style.display = "block";
    div.style.height = `${row.height}px`;
    div.style.whiteSpace = "pre";
    div.style.font = base;
    for (const sg of segs) {
      const s = Math.max(sg.s, ls);
      const e = Math.min(sg.e, le);
      if (e <= s) continue;
      const span = document.createElement("span");
      span.style.font = cssFont(styleGen(sg.style));
      span.style.color = normalizeHexColor(sg.style.c, "#000000");
      span.textContent = g.text.slice(s, e);
      div.appendChild(span);
    }
    el.appendChild(div);
    ls = le + 1;
  }
}

/** Larger than this on a side, or in area, a styled text is not rastered. */
export const RASTER_MAX_SIDE = 16_384;
export const RASTER_MAX_AREA = 32_000_000;

/** The refusal a too-large styled text gives. */
export const RASTER_TOO_LARGE = "A styled text is too large to export. Make it smaller, or remove the styles from part of it.";

/** A PNG of a styled text at exactly its media box (`w` x `h`), painted by
 *  the same layout as the preview. Rejects with RASTER_TOO_LARGE past the
 *  limits. */
export function rasterStyledText(g: TextGen, w: number, h: number, m: TextMeasurer = textMeasurer()): Promise<Blob> {
  if (!(w >= 1 && h >= 1) || w > RASTER_MAX_SIDE || h > RASTER_MAX_SIDE || w * h > RASTER_MAX_AREA) {
    return Promise.reject(new Error(RASTER_TOO_LARGE));
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("No 2D canvas for the styled text."));
  paintStyledText(ctx, layoutStyledText(g, m), 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The styled text could not be encoded."))), "image/png");
  });
}
