// Style runs on a text GENERATOR (video and image text, 0.9.5): the PDF text
// box's run model (core/pdf-runs.ts) applied to `Generator` text, whose base
// style is the generator's own fields and whose sizes are px.
//
// PURE: imports types, font-id and pdf-runs only. Never imported by
// core/project.ts or any start-up module (the load sanitizer is the small
// gen-runs-sanitize.ts); the editor and image chunks reach it.
//
// The ONE writer of `runs`: withRunsKey (and the three functions built on it,
// withGenText / styleGenRange / styleGenWhole). A text with no styles carries
// no `runs` key at all.

import type { FontFamily, FontId, FontRequest, Generator, PdfTextRun } from "./types";
import {
  applyRunStyle,
  clearRunFields,
  normalizeRuns,
  remapRuns,
  runFontRequests,
  runsEqual,
  segmentsOf,
  styleSummary,
  type PdfResolvedStyle,
  type PdfRunBase,
  type PdfRunField,
  type PdfRunPatch,
} from "./pdf-runs";

export type TextGen = Extract<Generator, { type: "text" }>;

/** The run-able base of a text generator: its own style. `fontId` only when
 *  the generator has the key. */
export function genRunBase(g: TextGen): PdfRunBase {
  const base: PdfRunBase = { font: g.fontFamily, size: g.sizePx, c: g.color, bold: g.bold, italic: g.italic };
  if ("fontId" in g) base.fontId = g.fontId;
  return base;
}

/** `g` carrying `runs` (undefined or empty: no key). The same reference when
 *  nothing changes. The only place a generator's `runs` key is written. */
export function withRunsKey(g: TextGen, runs: readonly PdfTextRun[] | undefined): TextGen {
  if (!runs || runs.length === 0) {
    if (!("runs" in g)) return g;
    const next = { ...g };
    delete next.runs;
    return next;
  }
  if (g.runs === runs) return g;
  return { ...g, runs: runs as PdfTextRun[] };
}

/** The canonical runs `g` carries (undefined: none). */
export function genRuns(g: TextGen): PdfTextRun[] | undefined {
  return Array.isArray(g.runs) && g.runs.length > 0 ? normalizeRuns(g.text, genRunBase(g), g.runs) : undefined;
}

/**
 * `g` with its text replaced by `text`, its runs following the edit
 * (remapRuns: typed text takes the style of the character before it; text
 * typed over a selection takes the first replaced character's). `hint` = the
 * old [s, e) the edit replaced, when the caller knows it. A text without runs
 * is `{ ...g, text }`, exactly as before runs existed.
 */
export function withGenText(g: TextGen, text: string, hint?: { s: number; e: number }): TextGen {
  if (text === g.text) return g;
  if (!Array.isArray(g.runs) || g.runs.length === 0) return { ...g, text };
  const base = genRunBase(g);
  const moved = remapRuns(normalizeRuns(g.text, base, g.runs), g.text, text, hint);
  return withRunsKey({ ...g, text }, normalizeRuns(text, base, moved));
}

/** Does every character of `range` already carry `patch`? */
function patchIsNoop(g: TextGen, range: { s: number; e: number }, patch: PdfRunPatch): boolean {
  const s = Math.min(range.s, range.e);
  const e = Math.max(range.s, range.e);
  for (const seg of segmentsOf(g.text, genRunBase(g), g.runs)) {
    if (seg.e <= s || seg.s >= e) continue;
    const st = seg.style;
    if (patch.font !== undefined && (st.font !== patch.font || st.fontId !== patch.fontId)) return false;
    if (patch.size !== undefined && st.size !== patch.size) return false;
    if (patch.c !== undefined && st.c !== patch.c) return false;
    if (patch.bold !== undefined && st.bold !== patch.bold) return false;
    if (patch.italic !== undefined && st.italic !== patch.italic) return false;
  }
  return true;
}

/**
 * `patch` on the characters of `range`. `gen` is `g` itself when nothing
 * changes; `refused` says it did not change because the text would need more
 * than PDF_TEXT_MAX_RUNS runs (the caller says so once).
 */
export function styleGenRangeChecked(
  g: TextGen,
  range: { s: number; e: number },
  patch: PdfRunPatch,
): { gen: TextGen; refused: boolean } {
  const base = genRunBase(g);
  const before = normalizeRuns(g.text, base, g.runs);
  const next = applyRunStyle(g.text, base, before, range, patch);
  if (!runsEqual(next, before)) return { gen: withRunsKey(g, next), refused: false };
  const refused = Math.max(range.s, range.e) > Math.min(range.s, range.e) && !patchIsNoop(g, range, patch);
  // a run list that was not canonical is stored canonical even on a no-op
  return { gen: g, refused };
}

/** `patch` on `range`: `g` itself on a no-op or a refusal. */
export function styleGenRange(g: TextGen, range: { s: number; e: number }, patch: PdfRunPatch): TextGen {
  return styleGenRangeChecked(g, range, patch).gen;
}

/** The per-run fields whose BASE value differs between `a` and `b`. */
export function changedRunFields(a: TextGen, b: TextGen): PdfRunField[] {
  const out: PdfRunField[] = [];
  if (a.fontFamily !== b.fontFamily || a.fontId !== b.fontId) out.push("font");
  if (a.sizePx !== b.sizePx) out.push("size");
  if (a.color !== b.color) out.push("c");
  if (a.bold !== b.bold) out.push("bold");
  if (a.italic !== b.italic) out.push("italic");
  return out;
}

/**
 * The whole-text rule: `next` is `old` with some base fields set; every field
 * whose base value changed leaves every run (`clearRunFields`), so the whole
 * text shows it. Fields left alone keep their runs. `next` itself when it has
 * no runs or no field changed.
 */
export function styleGenWhole(next: TextGen, old: TextGen): TextGen {
  if (!Array.isArray(next.runs) || next.runs.length === 0) return next;
  const fields = changedRunFields(old, next);
  if (fields.length === 0) return next;
  const base = genRunBase(next);
  return withRunsKey(next, clearRunFields(base, normalizeRuns(next.text, genRunBase(old), next.runs), fields));
}

/* ------------------------------------------------------------------ */
/* Right-to-left text                                                   */
/* ------------------------------------------------------------------ */

/** Is code point `c` in a right-to-left script block (Hebrew, Arabic,
 *  Syriac, Thaana, NKo and their presentation forms; the historic RTL
 *  planes)? U+FEFF, the byte-order mark at the end of the Arabic
 *  presentation forms, is not a letter: a pasted text that starts with one
 *  keeps its styles. */
export function isRtlCodePoint(c: number): boolean {
  return (
    (c >= 0x0590 && c <= 0x08ff) ||
    (c >= 0xfb1d && c <= 0xfdff) ||
    (c >= 0xfe70 && c <= 0xfefe) ||
    (c >= 0x10800 && c <= 0x10fff) ||
    (c >= 0x1e800 && c <= 0x1efff)
  );
}

/** Does `text` hold a right-to-left letter? */
export function hasStrongRtl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    if (u < 0x0590) continue;
    let c = u;
    if (u >= 0xd800 && u <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = (u - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (isRtlCodePoint(c)) return true;
  }
  return false;
}

/**
 * THE predicate for "draw this text styled": its runs when it has some and
 * holds no right-to-left letter, else undefined. A text without active runs
 * takes the plain path everywhere; a right-to-left one keeps its runs but is
 * drawn, measured and exported in its base style.
 */
export function activeRuns(g: TextGen): PdfTextRun[] | undefined {
  const r = g.runs;
  if (!Array.isArray(r) || r.length === 0) return undefined;
  return hasStrongRtl(g.text) ? undefined : r;
}

/* ------------------------------------------------------------------ */
/* Reading                                                              */
/* ------------------------------------------------------------------ */

/** The text cut into one-style segments (normalized first). */
export function genSegments(g: TextGen): { s: number; e: number; style: PdfResolvedStyle }[] {
  return segmentsOf(g.text, genRunBase(g), g.runs);
}

/** What the inspector shows for `range` (null / collapsed: the whole text). */
export function genSummary(g: TextGen, range: { s: number; e: number } | null): PdfResolvedStyle {
  return styleSummary(g.text, genRunBase(g), g.runs, range);
}

/** Every font the text's base and runs need (legacy fonts need none). */
export function genFontRequests(g: TextGen): FontRequest[] {
  return runFontRequests(genRunBase(g), Array.isArray(g.runs) ? g.runs : undefined);
}

/** A text generator drawn in one resolved style: what `fontString` /
 *  `cssFont` take for a segment. */
export function styleGen(st: PdfResolvedStyle): TextGen {
  const g: TextGen = { type: "text", text: "", fontFamily: st.font, sizePx: st.size, color: st.c, bold: st.bold, italic: st.italic };
  if (st.fontId !== undefined) g.fontId = st.fontId;
  return g;
}

/**
 * Per run: a Bold or Italic the run's resolved font has no face for is
 * turned off (`can` answers for a font pair: generators.ts
 * styleAvailability), then the runs are normalized. `g` itself when nothing
 * changes.
 */
export function honourRunFaces(
  g: TextGen,
  can: (font: FontFamily, fontId: FontId | undefined) => { bold: boolean; italic: boolean },
): TextGen {
  const runs = g.runs;
  if (!Array.isArray(runs) || runs.length === 0) return g;
  let changed = false;
  const out = runs.map((r) => {
    const font = r.font !== undefined ? r.font : g.fontFamily;
    const fontId = r.font !== undefined ? r.fontId : g.fontId;
    const bold = r.bold ?? g.bold;
    const italic = r.italic ?? g.italic;
    if (!bold && !italic) return r;
    const ok = can(font, fontId);
    if ((bold && !ok.bold) || (italic && !ok.italic)) {
      changed = true;
      const n = { ...r };
      if (bold && !ok.bold) n.bold = false;
      if (italic && !ok.italic) n.italic = false;
      return n;
    }
    return r;
  });
  if (!changed) return g;
  const next = normalizeRuns(g.text, genRunBase(g), out);
  return runsEqual(next, g.runs) ? g : withRunsKey(g, next);
}

const keys = new WeakMap<readonly PdfTextRun[], string>();

/** A compact key of a run list (s, e and its fields), memoised on the array. */
export function runsKey(runs: readonly PdfTextRun[]): string {
  const hit = keys.get(runs);
  if (hit !== undefined) return hit;
  let k = "";
  for (const r of runs) {
    k += `${r.s},${r.e}`;
    if (r.font !== undefined) k += `,f${r.font}\u0001${r.fontId ?? ""}`;
    if (r.size !== undefined) k += `,s${r.size}`;
    if (r.c !== undefined) k += `,c${r.c}`;
    if (r.bold !== undefined) k += `,b${r.bold ? 1 : 0}`;
    if (r.italic !== undefined) k += `,i${r.italic ? 1 : 0}`;
    k += ";";
  }
  keys.set(runs, k);
  return k;
}
