// Style runs of a PDF text box (0.9.4): sparse overrides on parts of the text
// over the box's own style. PURE: no DOM, no fonts runtime, no pdf.js.
//
// It lives under src/core (not src/pdf) because core/pdf-sanitize uses it, and
// that module is what ipc.loadProject imports for a PDF project: it must never
// pull src/pdf/** in. The editor, the screen and the export import it from
// here too, so there is ONE implementation of the canonical form.
//
// Offsets are UTF-16 units of the box's `text`; a run is [s, e). A run never
// splits a surrogate pair: every function here snaps a boundary that would.
//
// The font is a PAIR: a run (or a patch) carrying `font` sets both `font` and
// `fontId` (no `fontId` = none, the legacy font); `fontId` without `font` means
// nothing and is ignored.

import type { FontFamily, FontId, FontRequest, PdfTextRun, PdfTextStyle } from "./types";
import { PDF_TEXT_MAX_RUNS } from "./types";
import { fontRequestOf } from "./font-id";

/** The run-able part of a box's style: what a run may override. */
export type PdfRunBase = Pick<PdfTextStyle, "font" | "fontId" | "size" | "c" | "bold" | "italic">;

/** One character's (or segment's) style in force: the base with the runs
 *  applied. `fontId` is ABSENT (not undefined) when the legacy font is in force. */
export interface PdfResolvedStyle {
  font: FontFamily;
  fontId?: FontId;
  size: number;
  c: string;
  bold: boolean;
  italic: boolean;
}

/** What to set on a range: any subset of the run fields. `font` sets the
 *  pair (`fontId` beside it, absent = none); `fontId` alone is ignored. */
export type PdfRunPatch = Omit<PdfTextRun, "s" | "e">;

/** A per-run property, as a whole-box write names it ("font" = the pair). */
export type PdfRunField = "font" | "size" | "c" | "bold" | "italic";

/** A piece of a row for `rowMetrics`: its font size and its font's ascent and
 *  descent AT that size, in points, both positive. */
export interface RowPiece {
  size: number;
  asc: number;
  desc: number;
}

/** Mirrors `LINE_HEIGHT` in src/pdf/export/layout.ts (core never imports
 *  src/pdf); a test pins the two. */
export const RUN_LINE_HEIGHT = 1.25;

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** True when offset `i` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, i: number): boolean {
  return i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}

/** Clamp to [0, len], integer; snap a pair-splitting offset DOWN (`up`
 *  false) or UP (`up` true) to the character's edge. */
function snap(text: string, v: number, up: boolean): number {
  let i = Number.isFinite(v) ? Math.trunc(v) : v > 0 ? text.length : 0;
  i = Math.min(Math.max(i, 0), text.length);
  if (splitsPair(text, i)) i += up ? 1 : -1;
  return i;
}

/** The override fields of a run (no s/e), in the canonical key order. */
type Fields = Omit<PdfTextRun, "s" | "e">;

/** Paint `src`'s fields over `dst` (the font as a pair). */
function paint(dst: Fields, src: Fields): void {
  if (src.font !== undefined) {
    dst.font = src.font;
    if (src.fontId !== undefined) dst.fontId = src.fontId;
    else delete dst.fontId;
  }
  if (src.size !== undefined) dst.size = src.size;
  if (src.c !== undefined) dst.c = src.c;
  if (src.bold !== undefined) dst.bold = src.bold;
  if (src.italic !== undefined) dst.italic = src.italic;
}

/** `f` with every field equal to the base dropped (the font as a pair), in
 *  canonical key order: font, fontId, size, c, bold, italic. */
function strip(f: Fields, base: PdfRunBase): Fields {
  const out: Fields = {};
  if (f.font !== undefined && !(f.font === base.font && f.fontId === base.fontId)) {
    out.font = f.font;
    if (f.fontId !== undefined) out.fontId = f.fontId;
  }
  if (f.size !== undefined && f.size !== base.size) out.size = f.size;
  if (f.c !== undefined && f.c !== base.c) out.c = f.c;
  if (f.bold !== undefined && f.bold !== base.bold) out.bold = f.bold;
  if (f.italic !== undefined && f.italic !== base.italic) out.italic = f.italic;
  return out;
}

function sameFields(a: Fields, b: Fields): boolean {
  return (
    a.font === b.font &&
    a.fontId === b.fontId &&
    a.size === b.size &&
    a.c === b.c &&
    a.bold === b.bold &&
    a.italic === b.italic
  );
}

const isEmpty = (f: Fields): boolean => Object.keys(f).length === 0;

/** Sorted, merged, non-empty runs → the array, or undefined when none. */
function finish(list: PdfTextRun[]): PdfTextRun[] | undefined {
  const out: PdfTextRun[] = [];
  for (const r of list) {
    if (r.e <= r.s || isEmpty(fieldsOf(r))) continue;
    const prev = out[out.length - 1];
    if (prev && prev.e === r.s && sameFields(fieldsOf(prev), fieldsOf(r))) {
      out[out.length - 1] = { ...prev, e: r.e };
      continue;
    }
    out.push(r);
  }
  return out.length > 0 ? out : undefined;
}

function fieldsOf(r: Fields): Fields {
  const f: Fields = {};
  paint(f, r);
  return f;
}

function runOf(s: number, e: number, f: Fields): PdfTextRun {
  return { s, e, ...f };
}

/**
 * Paint `layers` (in order: a later one wins, field by field) over the text
 * and cut the result at every boundary. Boundaries are clamped into the text
 * and snapped OUT of surrogate pairs (start down, end up), so a run always
 * covers whole characters. Fields equal to the base are dropped, empty pieces
 * dropped, identical neighbours merged.
 */
function paintRuns(text: string, base: PdfRunBase, layers: readonly PdfTextRun[]): PdfTextRun[] | undefined {
  const spans: { s: number; e: number; f: Fields }[] = [];
  const cuts = new Set<number>();
  for (const r of layers) {
    const s = snap(text, r.s, false);
    const e = snap(text, r.e, true);
    if (!(e > s)) continue;
    const f = fieldsOf(r);
    if (isEmpty(f)) continue;
    spans.push({ s, e, f });
    cuts.add(s);
    cuts.add(e);
  }
  if (spans.length === 0) return undefined;
  const at = [...cuts].sort((a, b) => a - b);
  const cells: Fields[] = at.map(() => ({}));
  const index = (v: number): number => {
    let lo = 0;
    let hi = at.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const sp of spans) {
    for (let k = index(sp.s), end = index(sp.e); k < end; k++) paint(cells[k]!, sp.f);
  }
  const out: PdfTextRun[] = [];
  for (let k = 0; k + 1 < at.length; k++) out.push(runOf(at[k]!, at[k + 1]!, strip(cells[k]!, base)));
  return finish(out);
}

/* ------------------------------------------------------------------ */
/* The canonical form                                                  */
/* ------------------------------------------------------------------ */

/**
 * The canonical form of `runs` for `text` over `base`: sorted, non-overlapping
 * (where input runs overlap, a LATER run wins field by field), clipped to the
 * text, never splitting a surrogate pair (a run's start snaps down, its end up),
 * every run carrying at least one field, no field equal to the base (the font
 * compared as the pair `font` + `fontId`), adjacent identical runs merged.
 * Returns `undefined` when nothing is left: the caller DELETES the `runs` key
 * (never stores `[]`). Fresh objects; the input is not mutated.
 */
export function normalizeRuns(
  text: string,
  base: PdfRunBase,
  runs: readonly PdfTextRun[] | undefined,
): PdfTextRun[] | undefined {
  if (!runs || runs.length === 0 || text.length === 0) return undefined;
  return paintRuns(text, base, runs);
}

/** Deep equality of two run lists in canonical form (`undefined` == none). */
export function runsEqual(a: readonly PdfTextRun[] | undefined, b: readonly PdfTextRun[] | undefined): boolean {
  const la = a ?? [];
  const lb = b ?? [];
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) {
    const x = la[i]!;
    const y = lb[i]!;
    if (x.s !== y.s || x.e !== y.e) return false;
    if (!sameFields(fieldsOf(x), fieldsOf(y))) return false;
  }
  return true;
}

/** Is `hint` (old [s, e) replaced) an exact description of the edit
 *  `oldText` → `newText`? */
function hintFits(oldText: string, newText: string, hint: { s: number; e: number }): boolean {
  const { s, e } = hint;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s || e > oldText.length) return false;
  const ins = newText.length - oldText.length + (e - s);
  if (ins < 0) return false;
  if (splitsPair(oldText, s) || splitsPair(oldText, e)) return false;
  return newText.startsWith(oldText.slice(0, s)) && newText.endsWith(oldText.slice(e)) && s + ins + (oldText.length - e) === newText.length;
}

/**
 * Follow a text edit: `runs` were for `oldText`, the box now holds `newText`.
 * `hint` = the range of `oldText` the edit replaced (collapsed for a pure
 * insertion), as the editor knows it from the selection before the input:
 * when it describes the edit exactly, the edit is located there; otherwise
 * (or without it) the edit is found as common prefix + common suffix (never
 * splitting a surrogate pair). Runs are cut where text was removed. Inserted
 * text takes, for a pure insertion, the style of the character BEFORE the
 * insertion point (at offset 0: the one after it; none: the base style); text
 * that REPLACES removed text takes the style of the first replaced character
 * (retyping a red word keeps it red). Covers typing, deleting across runs,
 * paste, newline, IME and undo, without reading the DOM. Returns sorted,
 * non-overlapping, merged runs, or `undefined` for none. The runs' fields are
 * kept as they are (no base here): pass canonical runs in.
 */
export function remapRuns(
  runs: readonly PdfTextRun[] | undefined,
  oldText: string,
  newText: string,
  hint?: { s: number; e: number },
): PdfTextRun[] | undefined {
  if (!runs || runs.length === 0) return undefined;
  if (oldText === newText) return finish(runs.map((r) => runOf(r.s, r.e, fieldsOf(r))));
  const ol = oldText.length;
  const nl = newText.length;
  let p: number;
  let delEnd: number;
  if (hint && hintFits(oldText, newText, hint)) {
    p = hint.s;
    delEnd = hint.e;
  } else {
    const lim = Math.min(ol, nl);
    p = 0;
    while (p < lim && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
    // a high surrogate at the edge belongs to the character after it
    if (p > 0 && isHigh(oldText.charCodeAt(p - 1))) p--;
    let q = 0;
    while (q < lim - p && oldText.charCodeAt(ol - 1 - q) === newText.charCodeAt(nl - 1 - q)) q++;
    // a low surrogate at the suffix's edge belongs to the character before it
    if (q > 0 && isLow(oldText.charCodeAt(ol - q))) q--;
    delEnd = ol - q; // old [p, delEnd) removed
  }
  const shift = nl - ol; // = ins - del
  const ins = shift + (delEnd - p);
  // the old character whose style the inserted text takes (-1: none)
  const from = ins === 0 ? -1 : delEnd > p ? p : p > 0 ? p - 1 : p < ol ? p : -1;
  const out: PdfTextRun[] = [];
  for (const r of runs) {
    const f = fieldsOf(r);
    // the part before the edit, the part after it (shifted), and the
    // inserted text when this run covers its source character
    if (r.s < p) out.push(runOf(r.s, Math.min(r.e, p), f));
    if (r.e > delEnd) out.push(runOf(Math.max(r.s, delEnd) + shift, r.e + shift, f));
    if (from >= 0 && r.s <= from && from < r.e) out.push(runOf(p, p + ins, f));
  }
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return finish(out.map((r) => runOf(Math.min(Math.max(r.s, 0), nl), Math.min(Math.max(r.e, 0), nl), fieldsOf(r))));
}

/* ------------------------------------------------------------------ */
/* Styling a range / the whole box                                     */
/* ------------------------------------------------------------------ */

/**
 * Set `patch`'s fields on every character of `range` ([s, e), clipped to the
 * text and snapped out of surrogate pairs), keeping each character's other
 * fields; then the canonical form. `patch.font` sets the font PAIR.
 * A collapsed or empty range changes nothing. When the result would exceed
 * PDF_TEXT_MAX_RUNS the style is REFUSED and the canonical `runs` come back
 * unchanged (compare with `runsEqual` to tell). Bold / Italic: the caller
 * reads `styleSummary(...).bold` (on only when EVERY character of the range
 * has it) and passes `{ bold: !that }`.
 */
export function applyRunStyle(
  text: string,
  base: PdfRunBase,
  runs: readonly PdfTextRun[] | undefined,
  range: { s: number; e: number },
  patch: PdfRunPatch,
): PdfTextRun[] | undefined {
  const before = normalizeRuns(text, base, runs);
  const s = snap(text, Math.min(range.s, range.e), false);
  const e = snap(text, Math.max(range.s, range.e), true);
  const f = fieldsOf(patch);
  if (!(e > s) || isEmpty(f)) return before;
  const next = paintRuns(text, base, [...(before ?? []), runOf(s, e, f)]);
  if (next && next.length > PDF_TEXT_MAX_RUNS) return before;
  return next;
}

/**
 * The whole-box rule: the caller has set these fields on the BASE (`base` is
 * the new base); every run loses them (`"font"` = the pair), a run left with
 * nothing is dropped, then fields equal to the base are dropped and identical
 * neighbours merged. `undefined` = delete the `runs` key.
 */
export function clearRunFields(
  base: PdfRunBase,
  runs: readonly PdfTextRun[] | undefined,
  fields: readonly PdfRunField[],
): PdfTextRun[] | undefined {
  if (!runs || runs.length === 0) return undefined;
  const drop = new Set<PdfRunField>(fields);
  const out: PdfTextRun[] = [];
  for (const r of runs) {
    const f = fieldsOf(r);
    if (drop.has("font")) {
      delete f.font;
      delete f.fontId;
    }
    if (drop.has("size")) delete f.size;
    if (drop.has("c")) delete f.c;
    if (drop.has("bold")) delete f.bold;
    if (drop.has("italic")) delete f.italic;
    out.push(runOf(r.s, r.e, strip(f, base)));
  }
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return finish(out);
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function resolve(base: PdfRunBase, f: Fields): PdfResolvedStyle {
  const pair = f.font !== undefined ? { font: f.font, fontId: f.fontId } : { font: base.font, fontId: base.fontId };
  return {
    font: pair.font,
    ...(pair.fontId !== undefined ? { fontId: pair.fontId } : {}),
    size: f.size ?? base.size,
    c: f.c ?? base.c,
    bold: f.bold ?? base.bold,
    italic: f.italic ?? base.italic,
  };
}

/**
 * The text cut into segments of one style each, covering it fully: every
 * character belongs to exactly one segment, in order, each carrying its
 * resolved style; neighbours always differ. Empty text = no segments. The
 * runs are normalized first (so any input is safe).
 */
export function segmentsOf(
  text: string,
  base: PdfRunBase,
  runs: readonly PdfTextRun[] | undefined,
): { s: number; e: number; style: PdfResolvedStyle }[] {
  if (text.length === 0) return [];
  const list = normalizeRuns(text, base, runs) ?? [];
  const out: { s: number; e: number; style: PdfResolvedStyle }[] = [];
  let at = 0;
  for (const r of list) {
    if (r.s > at) out.push({ s: at, e: r.s, style: resolve(base, {}) });
    out.push({ s: r.s, e: r.e, style: resolve(base, fieldsOf(r)) });
    at = r.e;
  }
  if (at < text.length) out.push({ s: at, e: text.length, style: resolve(base, {}) });
  return out;
}

/**
 * What the inspector shows for `range` (null, or collapsed / empty after
 * clipping = the whole box): the FIRST character's font (pair), size and
 * colour; `bold` / `italic` true only when EVERY character in scope has it.
 * Empty text = the base.
 */
export function styleSummary(
  text: string,
  base: PdfRunBase,
  runs: readonly PdfTextRun[] | undefined,
  range: { s: number; e: number } | null,
): PdfResolvedStyle {
  let s = 0;
  let e = text.length;
  if (range) {
    const rs = snap(text, Math.min(range.s, range.e), false);
    const re = snap(text, Math.max(range.s, range.e), true);
    if (re > rs) {
      s = rs;
      e = re;
    }
  }
  const segs = segmentsOf(text, base, runs).filter((g) => g.e > s && g.s < e);
  const first = segs[0];
  if (!first) return resolve(base, {});
  return { ...first.style, bold: segs.every((g) => g.style.bold), italic: segs.every((g) => g.style.italic) };
}

/**
 * The distinct font requests of a mark (base first, then each run in order;
 * each resolved over the base, so a run that only turns bold on a library
 * font asks for that font's bold face). Legacy-font pieces need none, so a
 * mark using only the six legacy fonts answers `[]`.
 */
export function runFontRequests(base: PdfRunBase, runs: readonly PdfTextRun[] | undefined): FontRequest[] {
  const out: FontRequest[] = [];
  const seen = new Set<string>();
  const add = (st: PdfResolvedStyle): void => {
    const req = fontRequestOf(st.font, st.fontId, st.bold, st.italic);
    if (!req) return;
    const k = `${req.id}\u0000${req.bold}\u0000${req.italic}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(req);
  };
  add(resolve(base, {}));
  for (const r of runs ?? []) add(resolve(base, fieldsOf(r)));
  return out;
}

/* ------------------------------------------------------------------ */
/* Rows with mixed sizes                                               */
/* ------------------------------------------------------------------ */

/**
 * One row's height and baseline (below the row's top), by the CSS inline
 * model with the box's base style as a strut: per piece `lh = size * 1.25`,
 * `A = asc + (lh - asc - desc) / 2`, `D = lh - A`; the row is max A + max D
 * over the pieces AND the strut, its baseline at max A. A piece smaller than
 * the base never shrinks a row. For a row whose pieces all match the strut it
 * equals geom.ts exactly: `baseline === lineBaseline(0, size, asc, desc)` and
 * `height === textHeight(1, size)`. A box's height is the sum of its rows.
 */
export function rowMetrics(pieces: readonly RowPiece[], strut: RowPiece): { height: number; baseline: number } {
  let maxA = -Infinity;
  let maxD = -Infinity;
  const all = [strut, ...pieces];
  const parts = all.map((p) => {
    const lh = p.size * RUN_LINE_HEIGHT;
    // the same expression, in the same order, as geom.ts lineBaseline
    const A = (lh - (p.asc + p.desc)) / 2 + p.asc;
    const D = lh - A;
    if (A > maxA) maxA = A;
    if (D > maxD) maxD = D;
    return { lh, A, D };
  });
  // one piece reaching both extremes: its own line height, exactly (A + D
  // can differ from lh in the last bit)
  const whole = parts.find((x) => x.A === maxA && x.D === maxD);
  return { height: whole ? whole.lh : maxA + maxD, baseline: maxA };
}
