// PDF page view — the PURE half. Every number the strip, the rail and search
// compute lives here so it can be unit tested under Node: the page-space ↔ box
// conversions for the four rotations, the strip's layout, the zoom anchor and
// fit maths, which slots are in the render window, which canvases give way
// under the pixel budget, the slot that owns the centre line, selection/search
// rect merging and the text-item → page-space rect mapping. No DOM, no pdf.js,
// nothing touched at module load.
//
// Units (see ../types.ts): page space = unrotated crop box, origin top-left,
// y DOWN, points. A slot's BOX is the page turned by its display rotation and
// scaled by zoom (CSS px per point); box px have their origin at the box's
// top-left. CONTENT px are the strip's scroll coordinates.

import type { PdfRotation } from "../../core/types";

/** [x, y, w, h] in page space (points), y down. */
export type Rect4 = [number, number, number, number];

/** CSS px per point. 0.1 = a 300-page overview, 8 = a magnifier. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** US Letter: the size a page is assumed to have until it is measured. */
export const DEFAULT_PAGE_W = 612;
export const DEFAULT_PAGE_H = 792;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Any angle → one of the four quarter turns (clockwise, like /Rotate). */
export function normRotation(deg: number): PdfRotation {
  if (!Number.isFinite(deg)) return 0;
  const q = Math.round(deg / 90);
  return ((((q % 4) + 4) % 4) * 90) as PdfRotation;
}

/** The turn a page is shown at: its own /Rotate plus the slot's. */
export function displayRotation(source: number, extra: number): PdfRotation {
  return normRotation(source + extra);
}

/** The on-screen box of a w×h-point page turned by `rot`, at `zoom`. */
export function boxSize(w: number, h: number, rot: PdfRotation, zoom: number): { W: number; H: number } {
  return rot === 90 || rot === 270 ? { W: h * zoom, H: w * zoom } : { W: w * zoom, H: h * zoom };
}

/** Page space → box px (clockwise turn: at 90° the page's top-left corner
 *  lands at the box's top-right). */
export function pageToBox(
  x: number,
  y: number,
  w: number,
  h: number,
  rot: PdfRotation,
  zoom: number,
): { x: number; y: number } {
  switch (rot) {
    case 90:
      return { x: (h - y) * zoom, y: x * zoom };
    case 180:
      return { x: (w - x) * zoom, y: (h - y) * zoom };
    case 270:
      return { x: y * zoom, y: (w - x) * zoom };
    default:
      return { x: x * zoom, y: y * zoom };
  }
}

/** Box px → page space: the exact inverse of pageToBox. */
export function boxToPage(
  X: number,
  Y: number,
  w: number,
  h: number,
  rot: PdfRotation,
  zoom: number,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1;
  const bx = X / z;
  const by = Y / z;
  switch (rot) {
    case 90:
      return { x: by, y: h - bx };
    case 180:
      return { x: w - bx, y: h - by };
    case 270:
      return { x: w - by, y: bx };
    default:
      return { x: bx, y: by };
  }
}

/** A page-space rect → its box-px rect (axis-aligned either way). */
export function pageRectToBox(r: Rect4, w: number, h: number, rot: PdfRotation, zoom: number): Rect4 {
  const a = pageToBox(r[0], r[1], w, h, rot, zoom);
  const b = pageToBox(r[0] + r[2], r[1] + r[3], w, h, rot, zoom);
  return normRect(a.x, a.y, b.x, b.y);
}

/** A box-px rect → page space. */
export function boxRectToPage(r: Rect4, w: number, h: number, rot: PdfRotation, zoom: number): Rect4 {
  const a = boxToPage(r[0], r[1], w, h, rot, zoom);
  const b = boxToPage(r[0] + r[2], r[1] + r[3], w, h, rot, zoom);
  return normRect(a.x, a.y, b.x, b.y);
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect4 {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

/* ------------------------------ strip layout ------------------------------ */

/** One slot as the layout sees it: its unrotated size and display turn. */
export interface SlotDims {
  w: number;
  h: number;
  rot: PdfRotation;
}

export interface StripLayout {
  zoom: number;
  gap: number;
  /** content size (≥ the viewport's, so pages centre) */
  width: number;
  height: number;
  /** per slot, content px: box top-left and size */
  tops: number[];
  lefts: number[];
  W: number[];
  H: number[];
}

/**
 * Lay the slots out top to bottom, each centred, `gap` px around and between
 * them. Positions are whole px (a canvas on a half pixel is blurry); sizes are
 * exact so the conversions below stay exact inverses of the box.
 */
export function layoutStrip(slots: readonly SlotDims[], zoom: number, gap: number, viewW: number): StripLayout {
  const n = slots.length;
  const W: number[] = new Array(n);
  const H: number[] = new Array(n);
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    const s = boxSize(slots[i]!.w, slots[i]!.h, slots[i]!.rot, zoom);
    W[i] = s.W;
    H[i] = s.H;
    if (s.W > maxW) maxW = s.W;
  }
  const width = Math.max(Math.max(0, viewW), Math.ceil(maxW + 2 * gap));
  const tops: number[] = new Array(n);
  const lefts: number[] = new Array(n);
  let y = gap;
  for (let i = 0; i < n; i++) {
    tops[i] = Math.round(y);
    lefts[i] = Math.round((width - W[i]!) / 2);
    y = tops[i]! + H[i]! + gap;
  }
  const height = n > 0 ? Math.ceil(y) : 0;
  return { zoom, gap, width, height, tops, lefts, W, H };
}

/** First slot whose bottom is below `y` (binary search over sorted tops). */
function firstEndingAfter(L: StripLayout, y: number): number {
  let lo = 0;
  let hi = L.tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L.tops[mid]! + L.H[mid]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Slots intersecting content rows [from, to); [-1, -1] when none. */
export function slotsInRange(L: StripLayout, from: number, to: number): [number, number] {
  const n = L.tops.length;
  if (n === 0 || to <= from) return [-1, -1];
  const first = firstEndingAfter(L, from);
  if (first >= n || L.tops[first]! >= to) return [-1, -1];
  let last = first;
  while (last + 1 < n && L.tops[last + 1]! < to) last++;
  return [first, last];
}

/** The render window: the visible slots plus `margin` px above and below
 *  (the strip passes one viewport height). */
export function renderWindow(L: StripLayout, scrollTop: number, viewH: number, margin: number): [number, number] {
  return slotsInRange(L, scrollTop - margin, scrollTop + viewH + margin);
}

/** The slot that owns content row `y`: the one it lies in, or — in a gap or
 *  beyond the ends — the nearest one. -1 when there are no slots. */
export function slotAtY(L: StripLayout, y: number): number {
  const n = L.tops.length;
  if (n === 0) return -1;
  const i = firstEndingAfter(L, y);
  if (i >= n) return n - 1;
  if (y >= L.tops[i]!) return i;
  if (i === 0) return 0;
  // in the gap between i-1 and i: the closer edge wins
  const above = y - (L.tops[i - 1]! + L.H[i - 1]!);
  const below = L.tops[i]! - y;
  return above <= below ? i - 1 : i;
}

/** The current page: the slot owning the viewport's centre line. */
export function currentSlot(L: StripLayout, scrollTop: number, viewH: number): number {
  return slotAtY(L, scrollTop + Math.max(0, viewH) / 2);
}

/** Content px → page space of slot i (may fall outside the page: drags). */
export function contentToPage(
  L: StripLayout,
  slots: readonly SlotDims[],
  i: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const s = slots[i]!;
  return boxToPage(cx - L.lefts[i]!, cy - L.tops[i]!, s.w, s.h, s.rot, L.zoom);
}

/** Page space of slot i → content px. */
export function pageToContent(
  L: StripLayout,
  slots: readonly SlotDims[],
  i: number,
  x: number,
  y: number,
): { x: number; y: number } {
  const s = slots[i]!;
  const b = pageToBox(x, y, s.w, s.h, s.rot, L.zoom);
  return { x: L.lefts[i]! + b.x, y: L.tops[i]! + b.y };
}

/** The slot whose box contains content point (cx, cy), or -1 (gap/outside). */
export function slotAtPoint(L: StripLayout, cx: number, cy: number): number {
  const n = L.tops.length;
  if (n === 0) return -1;
  const i = firstEndingAfter(L, cy);
  if (i >= n || cy < L.tops[i]!) return -1;
  return cx >= L.lefts[i]! && cx < L.lefts[i]! + L.W[i]! ? i : -1;
}

/**
 * Where to scroll so a page point that sat at viewport offset (offX, offY)
 * sits there again after a re-layout (zoom with a cursor anchor, a resize, a
 * page measured to a different size). Clamped to the scrollable range.
 */
export function anchoredScroll(
  after: StripLayout,
  slots: readonly SlotDims[],
  anchor: { slot: number; x: number; y: number },
  offX: number,
  offY: number,
  viewW: number,
  viewH: number,
): { left: number; top: number } {
  if (anchor.slot < 0 || anchor.slot >= slots.length) return { left: 0, top: 0 };
  const c = pageToContent(after, slots, anchor.slot, anchor.x, anchor.y);
  const maxL = Math.max(0, after.width - viewW);
  const maxT = Math.max(0, after.height - viewH);
  return {
    left: Math.min(maxL, Math.max(0, Math.round(c.x - offX))),
    top: Math.min(maxT, Math.max(0, Math.round(c.y - offY))),
  };
}

/** The zoom that fits one page (display-turned w×h points) in the viewport,
 *  leaving the strip's gap on each side. */
export function fitZoom(mode: "width" | "page", dims: SlotDims, viewW: number, viewH: number, gap: number): number {
  const s = boxSize(dims.w, dims.h, dims.rot, 1);
  if (!(s.W > 0) || !(s.H > 0)) return 1;
  const zw = (viewW - 2 * gap) / s.W;
  const z = mode === "width" ? zw : Math.min(zw, (viewH - 2 * gap) / s.H);
  return clampZoom(z);
}

/* ------------------------------ rendering ------------------------------ */

/** Chromium's canvas limits, kept well inside: a side and an area. */
export const CANVAS_MAX_SIDE = 8192;
export const CANVAS_MAX_AREA = 16_777_216;

/** Backing-store size for a box of W×H CSS px at device ratio `dpr`, clamped
 *  per canvas (side and area). Never 0 (a 0×0 canvas has no context). */
export function backingSize(
  W: number,
  H: number,
  dpr: number,
  maxSide = CANVAS_MAX_SIDE,
  maxArea = CANVAS_MAX_AREA,
): { bw: number; bh: number; ratio: number } {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (!(W > 0) || !(H > 0)) return { bw: 1, bh: 1, ratio: d };
  let ratio = d;
  ratio = Math.min(ratio, maxSide / Math.max(W, H));
  ratio = Math.min(ratio, Math.sqrt(maxArea / (W * H)));
  return { bw: Math.max(1, Math.floor(W * ratio)), bh: Math.max(1, Math.floor(H * ratio)), ratio };
}

/** Total backing pixels the strip keeps alive (~256 MB of RGBA). */
export const PIXEL_BUDGET = 64_000_000;

/**
 * Which rendered canvases to drop so `incoming` more pixels fit the budget:
 * farthest from `centre` first, never one in `keep` (the visible slots).
 * May return fewer than needed when only kept slots remain — the visible
 * pages always render.
 */
export function pickEvictions(
  rendered: readonly { slot: number; px: number }[],
  incoming: number,
  budget: number,
  centre: number,
  keep: ReadonlySet<number>,
): number[] {
  let total = incoming;
  for (const r of rendered) total += r.px;
  if (total <= budget) return [];
  const order = rendered
    .filter((r) => !keep.has(r.slot))
    .sort((a, b) => Math.abs(b.slot - centre) - Math.abs(a.slot - centre) || b.slot - a.slot);
  const out: number[] = [];
  for (const r of order) {
    if (total <= budget) break;
    out.push(r.slot);
    total -= r.px;
  }
  return out;
}

/** Which pending slot renders next: visible ones first, each group nearest
 *  the centre slot first. -1 when nothing is pending. */
export function nextToRender(
  pending: Iterable<number>,
  visFirst: number,
  visLast: number,
  centre: number,
): number {
  let best = -1;
  let bestScore = Infinity;
  for (const s of pending) {
    const visible = s >= visFirst && s <= visLast;
    const score = (visible ? 0 : 1e9) + Math.abs(s - centre);
    if (score < bestScore || (score === bestScore && s < best)) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/* ------------------------------ rect merging ------------------------------ */

/** Two rects share a line when their vertical centres sit within ~40% of the
 *  taller one's height (line-height jitter between runs of different fonts). */
function sameLine(a: Rect4, b: Rect4): boolean {
  const ca = a[1] + a[3] / 2;
  const cb = b[1] + b[3] / 2;
  return Math.abs(ca - cb) <= Math.max(1, 0.4 * Math.max(a[3], b[3]));
}

function gapBetween(a: Rect4, b: Rect4): number {
  const aR = a[0] + a[2];
  const bR = b[0] + b[2];
  if (b[0] >= aR) return b[0] - aR;
  if (a[0] >= bR) return a[0] - bR;
  return 0;
}

/**
 * Merge rects (in reading order) that sit on one line and touch or nearly
 * touch, so a selection or a hit reads as one bar per line rather than a
 * picket fence of spans. A gap up to ~60% of the line height (a word space,
 * a kerned join) merges. Degenerate rects are dropped.
 */
export function mergeLineRects(rects: readonly Rect4[]): Rect4[] {
  const out: Rect4[] = [];
  for (const r of rects) {
    if (!(r[2] > 0) || !(r[3] > 0)) continue;
    let merged = false;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 3; k--) {
      const prev = out[k]!;
      if (sameLine(prev, r) && gapBetween(prev, r) <= Math.max(2, 0.6 * Math.max(prev[3], r[3]))) {
        const left = Math.min(prev[0], r[0]);
        const right = Math.max(prev[0] + prev[2], r[0] + r[2]);
        const top = Math.min(prev[1], r[1]);
        const bot = Math.max(prev[1] + prev[3], r[1] + r[3]);
        out[k] = [left, top, right - left, bot - top];
        merged = true;
        break;
      }
    }
    if (!merged) out.push([r[0], r[1], r[2], r[3]]);
  }
  return out;
}

/* ------------------------------ text items ------------------------------ */

/** What search needs of a pdf.js text item. */
export interface TextItemLite {
  str: string;
  /** PDF user-space text matrix [a, b, c, d, e, f] (baseline origin e, f) */
  transform: number[];
  /** advance along the text direction, user space */
  width: number;
  dir?: string;
  hasEOL?: boolean;
  fontName?: string;
}

/** A font's vertical metrics as pdf.js reports them (descent negative). */
export interface FontStyleLite {
  ascent?: number;
  descent?: number;
}

/** Line metrics as pdf.js's own text layer resolves them. */
export function fontMetrics(style: FontStyleLite | undefined): { ascent: number; descent: number } {
  let ascent = 0.8;
  if (style?.ascent) ascent = style.ascent;
  else if (style?.descent) ascent = 1 + style.descent;
  const descent = style?.descent && style.descent < 0 ? style.descent : ascent - 1;
  return { ascent, descent };
}

/**
 * Page-space bounding rect of the slice [f0, f1] (fractions of its advance)
 * of a text item. `view` is the page's crop box [x0, y0, x1, y1] in user space
 * (y up); page space is that box with y flipped. RTL items run right to left,
 * so their slice is mirrored. Handles items at any angle.
 */
export function itemSliceRect(
  item: TextItemLite,
  f0: number,
  f1: number,
  view: readonly number[],
  style?: FontStyleLite,
): Rect4 {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
  const scaleX = Math.hypot(a, b) || 1;
  const fh = Math.hypot(c, d) || scaleX;
  const ux = a / scaleX;
  const uy = b / scaleX;
  // the "up" vector, perpendicular to the baseline
  const vx = -uy;
  const vy = ux;
  let s0 = item.width * Math.max(0, Math.min(1, f0));
  let s1 = item.width * Math.max(0, Math.min(1, f1));
  if (item.dir === "rtl") {
    const t0 = item.width - s1;
    s1 = item.width - s0;
    s0 = t0;
  }
  const { ascent, descent } = fontMetrics(style);
  const t0 = descent * fh;
  const t1 = ascent * fh;
  const x0 = view[0] ?? 0;
  const top = view[3] ?? 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of [s0, s1]) {
    for (const t of [t0, t1]) {
      const px = e + ux * s + vx * t - x0;
      const py = top - (f + uy * s + vy * t);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** A page's searchable text: items joined, EOLs as spaces, with the char
 *  offset each item starts at. */
export interface PageText {
  text: string;
  /** lower-cased, same length as text (case-insensitive search) */
  lower: string;
  starts: number[];
}

/** Lower-case without changing length (a char whose lower form is longer,
 *  like "İ", keeps itself), so match offsets stay valid in `text`. */
export function lowerSameLength(s: string): string {
  const l = s.toLowerCase();
  if (l.length === s.length) return l;
  let out = "";
  for (const ch of s) {
    const lc = ch.toLowerCase();
    out += lc.length === ch.length ? lc : ch;
  }
  return out;
}

export function buildPageText(items: readonly { str: string; hasEOL?: boolean }[]): PageText {
  let text = "";
  const starts: number[] = [];
  for (const it of items) {
    starts.push(text.length);
    text += it.str;
    if (it.hasEOL && !text.endsWith(" ")) text += " ";
  }
  return { text, lower: lowerSameLength(text), starts };
}

/** Every non-overlapping occurrence of `query`, as [start, end) offsets. */
export function findAll(pt: PageText, query: string, caseSensitive: boolean): [number, number][] {
  const q = caseSensitive ? query : lowerSameLength(query);
  const hay = caseSensitive ? pt.text : pt.lower;
  const out: [number, number][] = [];
  if (!q) return out;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(q, from);
    if (at < 0) break;
    out.push([at, at + q.length]);
    from = at + q.length;
  }
  return out;
}

/** Page-space rects (merged per line) covering chars [start, end) of a page. */
export function matchRects(
  items: readonly TextItemLite[],
  pt: PageText,
  start: number,
  end: number,
  view: readonly number[],
  styles?: Readonly<Record<string, FontStyleLite>>,
): Rect4[] {
  const rects: Rect4[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const s = pt.starts[i]!;
    const e = s + it.str.length;
    const from = Math.max(s, start);
    const to = Math.min(e, end);
    if (to <= from || it.str.length === 0) continue;
    const len = it.str.length;
    rects.push(itemSliceRect(it, (from - s) / len, (to - s) / len, view, it.fontName ? styles?.[it.fontName] : undefined));
  }
  return mergeLineRects(rects);
}

/* ------------------------------ thumb rail ------------------------------ */

/**
 * The new key order after dragging the slots in `moving` to the insertion
 * point `drop` (0..n, an index into the ORIGINAL order: "before item drop").
 * The moved block keeps its relative order. Returns null when nothing moves.
 */
export function reorderKeys(keys: readonly string[], moving: readonly number[], drop: number): string[] | null {
  const set = new Set(moving.filter((i) => i >= 0 && i < keys.length));
  if (set.size === 0) return null;
  const d = Math.max(0, Math.min(keys.length, drop));
  const moved = keys.filter((_, i) => set.has(i));
  const rest: string[] = [];
  let insertAt = 0;
  keys.forEach((k, i) => {
    if (i === d) insertAt = rest.length;
    if (!set.has(i)) rest.push(k);
  });
  if (d === keys.length) insertAt = rest.length;
  const out = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
  return out.every((k, i) => k === keys[i]) ? null : out;
}

/** Ctrl/Shift click selection: the next selected slots. */
export function nextSelection(
  current: readonly number[],
  clicked: number,
  anchor: number,
  mods: { ctrl: boolean; shift: boolean },
): number[] {
  if (mods.shift && anchor >= 0) {
    const lo = Math.min(anchor, clicked);
    const hi = Math.max(anchor, clicked);
    const range: number[] = [];
    for (let i = lo; i <= hi; i++) range.push(i);
    if (!mods.ctrl) return range;
    return [...new Set([...current, ...range])].sort((a, b) => a - b);
  }
  if (mods.ctrl) {
    return current.includes(clicked)
      ? current.filter((s) => s !== clicked)
      : [...current, clicked].sort((a, b) => a - b);
  }
  return [clicked];
}
