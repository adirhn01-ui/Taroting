// The load-time check of a text generator's style runs (0.9.5). Small on
// purpose: core/project.ts calls it for every loaded text that HAS a `runs`
// key, so it sits in the start-up chunk. It never imports pdf-runs: the
// canonical form is restored lazily by the editor-side consumers
// (segmentsOf normalizes; every writer calls normalizeRuns).
//
// Structural faults drop the whole list; a bad field drops only that field.
// A clean list keeps its reference, and so does the generator.

import { isFontId, isLegacyFont } from "./font-id";
import type { Generator, PdfTextRun } from "./types";
import { PDF_TEXT_MAX_RUNS } from "./types";

type TextGen = Extract<Generator, { type: "text" }>;

const RUN_SIZE_MIN = 1;
const RUN_SIZE_MAX = 2048;
const HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** A colour as lowercase `#rrggbb`, or "" when it is not one. */
function hex(v: unknown): string {
  if (typeof v !== "string" || v.length > 7) return "";
  const s = v.toLowerCase();
  if (!HEX.test(s)) return "";
  const b = s.startsWith("#") ? s.slice(1) : s;
  return b.length === 3 ? `#${b[0]}${b[0]}${b[1]}${b[1]}${b[2]}${b[2]}` : `#${b}`;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const splits = (t: string, i: number): boolean => i > 0 && i < t.length && isHigh(t.charCodeAt(i - 1)) && isLow(t.charCodeAt(i));

const RUN_KEYS = new Set(["s", "e", "font", "fontId", "size", "c", "bold", "italic"]);

/** One run's fields, cleaned; `same` = nothing needed changing. */
function cleanRun(raw: Record<string, unknown>): { run: PdfTextRun; same: boolean } {
  let same = true;
  for (const k of Object.keys(raw)) if (!RUN_KEYS.has(k)) same = false;
  const run: PdfTextRun = { s: raw.s as number, e: raw.e as number };
  if ("font" in raw) {
    if (isLegacyFont(raw.font)) {
      run.font = raw.font;
      if ("fontId" in raw) {
        if (isFontId(raw.fontId)) run.fontId = raw.fontId;
        else same = false;
      }
    } else same = false; // its fontId goes with it
  } else if ("fontId" in raw) same = false; // a fontId without a font means nothing
  if ("size" in raw) {
    const v = raw.size;
    if (typeof v === "number" && Number.isFinite(v)) {
      const c = Math.min(Math.max(v, RUN_SIZE_MIN), RUN_SIZE_MAX);
      run.size = c;
      if (c !== v) same = false;
    } else same = false;
  }
  if ("c" in raw) {
    const c = hex(raw.c);
    if (c !== "") run.c = c;
    if (c !== raw.c) same = false;
  }
  if ("bold" in raw) {
    if (typeof raw.bold === "boolean") run.bold = raw.bold;
    else same = false;
  }
  if ("italic" in raw) {
    if (typeof raw.italic === "boolean") run.italic = raw.italic;
    else same = false;
  }
  return { run, same };
}

/** The runs of a loaded text, or undefined when the list as a whole is
 *  unusable; `same` = the input list was already clean. */
function cleanRuns(text: unknown, runs: unknown): { runs: PdfTextRun[] | undefined; same: boolean } {
  if (typeof text !== "string" || !Array.isArray(runs) || runs.length > PDF_TEXT_MAX_RUNS) return { runs: undefined, same: false };
  const out: PdfTextRun[] = [];
  let same = true;
  let at = 0;
  for (const r of runs as unknown[]) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return { runs: undefined, same: false };
    const raw = r as Record<string, unknown>;
    const s = raw.s;
    const e = raw.e;
    if (!Number.isInteger(s) || !Number.isInteger(e)) return { runs: undefined, same: false };
    const si = s as number;
    const ei = e as number;
    if (si < 0 || si >= ei || ei > text.length || si < at) return { runs: undefined, same: false };
    if (splits(text, si) || splits(text, ei)) return { runs: undefined, same: false };
    at = ei;
    const c = cleanRun(raw);
    if (!c.same) same = false;
    if (Object.keys(c.run).length === 2) {
      same = false;
      continue;
    }
    out.push(c.run);
  }
  return { runs: out.length > 0 ? out : undefined, same: same && out.length > 0 };
}

/**
 * A loaded text generator's `runs`, checked: `g` itself when it has no
 * `runs` key or the list is already clean; otherwise a copy with the cleaned
 * list, or without the key when nothing is left. The base fields are never
 * touched (an older Taroting reads them alone).
 */
export function sanitizeGenRuns(g: TextGen): TextGen {
  if (!("runs" in g)) return g;
  const res = cleanRuns(g.text, g.runs);
  if (res.same) return g;
  const next = { ...g };
  if (res.runs) next.runs = res.runs;
  else delete next.runs;
  return next;
}
