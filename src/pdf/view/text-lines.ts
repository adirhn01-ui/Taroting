// PDF page text as LINES — the pure half of the editor's "Edit text" pick.
// pdf.js text items (one per glyph run) are grouped into lines in page space
// (unrotated page box, origin top-left, y down — see ../types.ts), a point or
// a dragged rect picks lines, picked lines become one paragraph, pdf.js font
// info maps onto the text-box whitelist, and a patch of rendered pixels gives
// the paper and ink colours. No DOM, no pdf.js, nothing touched at module load.

import type { FontFamily, PdfRotation } from "../../core/types";
import { boxSize, itemSliceRect, pageRectToBox, type FontStyleLite, type Rect4, type TextItemLite } from "./math";

/** One glyph run on a line. */
export interface LineItem {
  item: TextItemLite;
  /** page-space box of the run (ascent..descent tall) */
  rect: Rect4;
  /** font size in points */
  size: number;
  /** start / end along the line's direction, user space */
  p0: number;
  p1: number;
}

export interface TextLine {
  /** union of the runs' rects, page space */
  rect: Rect4;
  /** runs in READING order (right to left for an rtl line) */
  items: LineItem[];
  /** the line's text, logical order */
  text: string;
  rtl: boolean;
  /** median run size, points */
  size: number;
  /** baseline position along the line's "up" vector, user space (bigger = higher) */
  q: number;
  /** text direction, whole degrees (0 = left to right on the page) */
  angle: number;
  /** extent along the direction, user space */
  p0: number;
  p1: number;
}

/** Runs whose baselines sit within this share of the larger size share a line
 *  (super/subscripts stay on it). */
const BASELINE_TOL = 0.45;
/** A gap along the baseline wider than this many sizes starts a new line
 *  (two columns on one baseline are two lines). */
const COLUMN_GAP = 2.5;
/** A gap wider than this share of the size reads as a word space. */
const SPACE_GAP = 0.2;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function union(rects: readonly Rect4[]): Rect4 {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[0] + r[2]);
    y1 = Math.max(y1, r[1] + r[3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

function lineOf(items: LineItem[], rtl: boolean, q: number, angle: number): TextLine {
  const ordered = rtl ? [...items].sort((a, b) => b.p0 - a.p0) : items;
  let text = "";
  let prev: LineItem | null = null;
  for (const it of ordered) {
    if (prev) {
      const gap = rtl ? prev.p0 - it.p1 : it.p0 - prev.p1;
      if (gap > SPACE_GAP * Math.max(prev.size, it.size) && !isSpace(text.at(-1)) && !isSpace(it.item.str[0])) text += " ";
    }
    text += it.item.str;
    prev = it;
  }
  return {
    rect: union(items.map((i) => i.rect)),
    items: ordered,
    text: text.replace(/\s+$/u, "").replace(/^\s+/u, ""),
    rtl,
    size: median(items.map((i) => i.size)),
    q,
    angle,
    p0: Math.min(...items.map((i) => i.p0)),
    p1: Math.max(...items.map((i) => i.p1)),
  };
}

/**
 * Group a page's text items into lines. `view` is the crop box in user space
 * (as pdf.js's page.view). Empty and whitespace-only runs carry no glyphs and
 * are dropped (word spaces come back from the gaps). Lines come out in
 * reading order: per direction, top to bottom, then along the line.
 */
export function buildLines(
  items: readonly TextItemLite[],
  view: readonly number[],
  styles?: Readonly<Record<string, FontStyleLite>>,
): TextLine[] {
  interface Entry extends LineItem {
    angle: number;
    q: number;
    rtl: boolean;
  }
  const entries: Entry[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.trim() === "" || !(item.width > 0)) continue;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    const sx = Math.hypot(a, b);
    if (!(sx > 0)) continue;
    const ux = a / sx;
    const uy = b / sx;
    const size = Math.hypot(c, d) || sx;
    const p0 = e * ux + f * uy;
    entries.push({
      item,
      rect: itemSliceRect(item, 0, 1, view, item.fontName ? styles?.[item.fontName] : undefined),
      size,
      p0,
      p1: p0 + item.width,
      angle: Math.round((Math.atan2(uy, ux) * 180) / Math.PI),
      q: e * -uy + f * ux,
      rtl: item.dir === "rtl",
    });
  }
  entries.sort((x, y) => x.angle - y.angle || y.q - x.q || x.p0 - y.p0);

  const lines: TextLine[] = [];
  const flush = (group: Entry[]): void => {
    if (group.length === 0) return;
    group.sort((x, y) => x.p0 - y.p0);
    let run: Entry[] = [group[0]!];
    let end = group[0]!.p1;
    const close = (): void => {
      let rtlChars = 0;
      let ltrChars = 0;
      for (const r of run) {
        if (r.rtl) rtlChars += r.item.str.length;
        else ltrChars += r.item.str.length;
      }
      lines.push(lineOf(run, rtlChars > ltrChars, median(run.map((r) => r.q)), run[0]!.angle));
    };
    for (let k = 1; k < group.length; k++) {
      const g = group[k]!;
      if (g.p0 - end > COLUMN_GAP * Math.max(g.size, run[run.length - 1]!.size)) {
        close();
        run = [g];
      } else run.push(g);
      end = Math.max(end, g.p1);
    }
    close();
  };
  let group: Entry[] = [];
  for (const en of entries) {
    const head = group[0];
    if (head && (en.angle !== head.angle || head.q - en.q > BASELINE_TOL * Math.max(head.size, en.size))) {
      flush(group);
      group = [];
    }
    group.push(en);
  }
  flush(group);
  return lines;
}

function distToRect(r: Rect4, x: number, y: number): number {
  const dx = Math.max(r[0] - x, 0, x - (r[0] + r[2]));
  const dy = Math.max(r[1] - y, 0, y - (r[1] + r[3]));
  return Math.hypot(dx, dy);
}

/** The line whose box contains (x, y), else the nearest within `tol` points,
 *  else null. Inside several (overlapping lines): the smallest box. */
export function lineAt(lines: readonly TextLine[], x: number, y: number, tol = 3): TextLine | null {
  let best: TextLine | null = null;
  let bestD = Infinity;
  let bestA = Infinity;
  for (const l of lines) {
    const d = distToRect(l.rect, x, y);
    if (d > tol) continue;
    const area = l.rect[2] * l.rect[3];
    if (d < bestD || (d === bestD && area < bestA)) {
      best = l;
      bestD = d;
      bestA = area;
    }
  }
  return best;
}

/** Every line whose box overlaps `rect` (page space), in reading order. */
export function linesIn(lines: readonly TextLine[], rect: Rect4): TextLine[] {
  const x0 = Math.min(rect[0], rect[0] + rect[2]);
  const x1 = Math.max(rect[0], rect[0] + rect[2]);
  const y0 = Math.min(rect[1], rect[1] + rect[3]);
  const y1 = Math.max(rect[1], rect[1] + rect[3]);
  return lines.filter((l) => l.rect[0] < x1 && l.rect[0] + l.rect[2] > x0 && l.rect[1] < y1 && l.rect[1] + l.rect[3] > y0);
}

/** Paragraph pick: sizes within this share of the clicked line's. */
const PARA_SIZE_TOL = 0.15;
/** …each baseline gap at most this many sizes … */
const PARA_MAX_GAP = 1.6;
/** …and within this share of the first gap found. */
const PARA_GAP_TOL = 0.35;
/** Left edges this close (points) count as one column even without overlap. */
const PARA_EDGE_TOL = 2;

const overlaps = (a: TextLine, b: TextLine): boolean =>
  Math.min(a.p1, b.p1) > Math.max(a.p0, b.p0) || Math.abs(a.p0 - b.p0) <= PARA_EDGE_TOL;

/**
 * The paragraph around `line`: walks up and down through the NEXT line of the
 * same column (same direction, overlapping extent), while it has a similar
 * size (±15%) and the baseline gap stays paragraph-like (≤ 1.6× the median
 * size, within ±35% of the first gap). Stops at a blank-line gap, a size
 * change or a column change — the line in between is never skipped. Reading
 * order (top first).
 */
export function paragraphAround(lines: readonly TextLine[], line: TextLine): TextLine[] {
  const col = lines.filter((l) => l === line || (l.angle === line.angle && overlaps(l, line))).sort((a, b) => b.q - a.q);
  const at = col.indexOf(line);
  if (at < 0) return [line];
  const out = [line];
  const sizes = [line.size];
  let firstGap = 0;
  const fits = (l: TextLine, gap: number): boolean => {
    if (Math.abs(l.size - line.size) > PARA_SIZE_TOL * line.size) return false;
    if (!(gap > 0) || gap > PARA_MAX_GAP * median([...sizes, l.size])) return false;
    if (firstGap > 0 && Math.abs(gap - firstGap) > PARA_GAP_TOL * firstGap) return false;
    return true;
  };
  for (const dir of [1, -1]) {
    let prev = line;
    for (let k = at + dir; k >= 0 && k < col.length; k += dir) {
      const l = col[k]!;
      const gap = Math.abs(prev.q - l.q);
      if (!fits(l, gap)) break;
      if (firstGap === 0) firstGap = gap;
      if (dir > 0) out.push(l);
      else out.unshift(l);
      sizes.push(l.size);
      prev = l;
    }
  }
  return out;
}

/** A line ending short of this share of the widest one, followed by a line
 *  starting a sentence, is a HARD break in a paragraph pick. */
const HARD_BREAK_WIDTH = 0.7;
const STARTS_SENTENCE = /^[\p{Lu}\p{Nd}]/u;

export interface Paragraph {
  /** lines joined with "\n" */
  text: string;
  /** one per glyph run, page space */
  rects: Rect4[];
  /** the runs' union padded by 1 pt */
  box: Rect4;
  /** median run size, points (one decimal) */
  size: number;
  rtl: boolean;
  /** the pdf.js font of most characters, or undefined */
  fontName: string | undefined;
}

/** Picked lines (reading order) → one paragraph. null when there are none.
 *  Lines join with "\n"; with `soft` (a paragraph pick) wrapped lines join
 *  with a space and "\n" is kept only at a hard break. */
export function paragraphOf(lines: readonly TextLine[], opts?: { soft?: boolean }): Paragraph | null {
  if (lines.length === 0) return null;
  const rects: Rect4[] = [];
  const sizes: number[] = [];
  const fontChars = new Map<string, number>();
  let rtlLines = 0;
  for (const l of lines) {
    if (l.rtl) rtlLines++;
    for (const it of l.items) {
      if (it.rect[2] > 0 && it.rect[3] > 0) rects.push(it.rect);
      sizes.push(it.size);
      const fn = it.item.fontName;
      if (fn) fontChars.set(fn, (fontChars.get(fn) ?? 0) + it.item.str.length);
    }
  }
  if (rects.length === 0) return null;
  let fontName: string | undefined;
  let most = -1;
  for (const [k, n] of fontChars) {
    if (n > most) {
      most = n;
      fontName = k;
    }
  }
  const u = union(rects);
  return {
    text: opts?.soft ? softJoin(lines) : lines.map((l) => l.text).join("\n"),
    rects,
    box: [u[0] - 1, u[1] - 1, u[2] + 2, u[3] + 2],
    size: Math.round(median(sizes) * 10) / 10,
    rtl: rtlLines * 2 > lines.length,
    fontName,
  };
}

function softJoin(lines: readonly TextLine[]): string {
  const widest = Math.max(...lines.map((l) => l.p1 - l.p0));
  let text = lines[0]!.text;
  for (let k = 1; k < lines.length; k++) {
    const prev = lines[k - 1]!;
    const next = lines[k]!;
    const hard = prev.p1 - prev.p0 < HARD_BREAK_WIDTH * widest && STARTS_SENTENCE.test(next.text);
    text += (hard ? "\n" : " ") + next.text;
  }
  return text;
}

/* ------------------------------ fonts ------------------------------ */

/** What pdf.js tells the main thread about a font (all optional). */
export interface FontInfoLite {
  /** textContent.styles[fontName].fontFamily: "serif" | "sans-serif" | "monospace" */
  family?: string;
  /** any font names known (the loaded name of a standard font, a system
   *  substitution's base name); pdf.js's opaque ids are ignored */
  names?: (string | undefined)[];
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  /** CSS weight ("bold", "600") */
  weight?: string | number;
  /** CSS style ("italic", "oblique") */
  style?: string;
}

const OPAQUE_ID = /^g_d\d+_f\d+$/;

/** The closest whitelisted look for a PDF font. */
export function mapFont(info: FontInfoLite): { font: FontFamily; bold: boolean; italic: boolean } {
  const names = (info.names ?? []).filter((n): n is string => typeof n === "string" && n !== "" && !OPAQUE_ID.test(n));
  const name = names.join(" ");
  let font: FontFamily;
  if (/georgia/i.test(name)) font = "Georgia";
  else if (/impact/i.test(name)) font = "Impact";
  else if (/courier|mono|consolas/i.test(name)) font = "Courier New";
  else if (/sans|arial|helvetica|calibri/i.test(name)) font = "Arial";
  else if (/times|serif|roman|garamond|cambria|book/i.test(name)) font = "Times New Roman";
  else if (info.family === "serif") font = "Times New Roman";
  else if (info.family === "monospace") font = "Courier New";
  else font = "Arial";
  const w = typeof info.weight === "number" ? info.weight : info.weight === "bold" ? 700 : Number.parseInt(info.weight ?? "", 10);
  const bold = info.bold === true || info.black === true || (Number.isFinite(w) && w >= 600) || /bold|black|heavy|semibold|demi/i.test(name);
  const italic = info.italic === true || /italic|oblique/i.test(info.style ?? "") || /italic|oblique/i.test(name);
  return { font, bold, italic };
}

/* ------------------------------ colours ------------------------------ */

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
export const toHex = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** Samples read at most (a page-wide drag must not walk a megapixel). */
const MAX_SAMPLES = 20_000;
/** Below this distance (sum of channel differences) a pixel is paper. */
const INK_MIN_DIST = 60;

/**
 * Paper and ink colours of a w×h RGBA patch whose INNER rect [x0, y0, x1, y1)
 * (px, patch coords) holds the text and whose remaining border is the ring
 * around it. Paper = the most common colour of the ring (5 bits/channel bins,
 * the winning bin's mean); the whole patch when there is no ring. Ink = the
 * per-channel median of the inner pixels farthest from paper (≥ 60% of the
 * largest distance — antialiased glyph edges would pull a plain median toward
 * paper); #000000 when nothing inside differs from paper.
 */
export function paperAndInk(
  data: ArrayLike<number>,
  w: number,
  h: number,
  inner: readonly [number, number, number, number],
): { paper: string; ink: string } {
  const [ix0, iy0, ix1, iy1] = inner;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
  const bins = new Map<number, [number, number, number, number]>();
  const allBins = new Map<number, [number, number, number, number]>();
  const add = (m: Map<number, [number, number, number, number]>, r: number, g: number, b: number): void => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const e = m.get(key);
    if (e) {
      e[0]++;
      e[1] += r;
      e[2] += g;
      e[3] += b;
    } else m.set(key, [1, r, g, b]);
  };
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      add(allBins, r, g, b);
      if (x < ix0 || x >= ix1 || y < iy0 || y >= iy1) add(bins, r, g, b);
    }
  }
  const pick = bins.size > 0 ? bins : allBins;
  let best: [number, number, number, number] | null = null;
  for (const e of pick.values()) if (!best || e[0] > best[0]) best = e;
  if (!best) return { paper: "#ffffff", ink: "#000000" };
  const pr = best[1] / best[0];
  const pg = best[2] / best[0];
  const pb = best[3] / best[0];
  const paper = toHex(pr, pg, pb);

  const istep = Math.max(1, Math.ceil(Math.sqrt(((ix1 - ix0) * (iy1 - iy0)) / MAX_SAMPLES)));
  const px: number[] = [];
  let maxD = 0;
  for (let y = Math.max(0, iy0); y < Math.min(h, iy1); y += istep) {
    for (let x = Math.max(0, ix0); x < Math.min(w, ix1); x += istep) {
      const o = (y * w + x) * 4;
      const d = Math.abs(data[o]! - pr) + Math.abs(data[o + 1]! - pg) + Math.abs(data[o + 2]! - pb);
      if (d > maxD) maxD = d;
      px.push(o);
    }
  }
  if (maxD < INK_MIN_DIST) return { paper, ink: "#000000" };
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const o of px) {
    const d = Math.abs(data[o]! - pr) + Math.abs(data[o + 1]! - pg) + Math.abs(data[o + 2]! - pb);
    if (d >= 0.6 * maxD) {
      rs.push(data[o]!);
      gs.push(data[o + 1]!);
      bs.push(data[o + 2]!);
    }
  }
  return { paper, ink: toHex(median(rs), median(gs), median(bs)) };
}

/** The canvas patch to read for a page-space rect: the rect padded by `pad`
 *  points (the paper ring), in backing px of a canvas painted for a w×h-point
 *  page turned by `rot` (its pixel size says the scale, so a canvas still
 *  CSS-stretched mid-zoom maps right), clamped to the canvas. `inner` = the
 *  rect itself in patch coords. null when nothing of it lies on the canvas. */
export function canvasPatch(
  rect: Rect4,
  w: number,
  h: number,
  rot: PdfRotation,
  canvasW: number,
  canvasH: number,
  pad = 2,
): { x: number; y: number; w: number; h: number; inner: [number, number, number, number] } | null {
  const full = boxSize(w, h, rot, 1);
  if (!(full.W > 0) || !(full.H > 0) || !(canvasW > 0) || !(canvasH > 0)) return null;
  const kx = canvasW / full.W;
  const ky = canvasH / full.H;
  const toPx = (r: Rect4): [number, number, number, number] => {
    const b = pageRectToBox(r, w, h, rot, 1);
    return [b[0] * kx, b[1] * ky, (b[0] + b[2]) * kx, (b[1] + b[3]) * ky];
  };
  const o = toPx([rect[0] - pad, rect[1] - pad, rect[2] + 2 * pad, rect[3] + 2 * pad]);
  const x0 = Math.max(0, Math.floor(o[0]));
  const y0 = Math.max(0, Math.floor(o[1]));
  const x1 = Math.min(canvasW, Math.ceil(o[2]));
  const y1 = Math.min(canvasH, Math.ceil(o[3]));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const i = toPx(rect);
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    inner: [Math.floor(i[0]) - x0, Math.floor(i[1]) - y0, Math.ceil(i[2]) - x0, Math.ceil(i[3]) - y0],
  };
}
