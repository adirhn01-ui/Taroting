// Line breaking for text boxes, shared by the vector path and the canvas
// fallback: break after whitespace, a word wider than the box breaks between
// characters, trailing spaces never count toward a line's width. Works in
// LOGICAL order on string offsets so bidi can then reorder each line.

import { CANVAS_MAX_AREA, CANVAS_MAX_SIDE } from "../view/math";

/** Line height as a multiple of the font size (the editor's CSS uses the same). */
export const LINE_HEIGHT = 1.25;

/** How many canvas px per point the Arabic fallback draws at, at most. */
export const RASTER_SCALE = 4;

/** The fallback's px per point for a w×h pt box: RASTER_SCALE, lowered so the
 *  canvas (each side rounded UP) stays within the WebView's canvas limits —
 *  a 4000 pt box at 4× would ask for a 16000² canvas. */
export function rasterScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return RASTER_SCALE;
  const bySide = (CANVAS_MAX_SIDE - 1) / Math.max(w, h);
  // (w·s + 1)(h·s + 1) <= area once w·h·s² <= area − 2·side − 1
  const byArea = Math.sqrt((CANVAS_MAX_AREA - 2 * CANVAS_MAX_SIDE - 1) / (w * h));
  return Math.min(RASTER_SCALE, bySide, byArea);
}

/** [start, end) ranges of `para`'s lines; an empty paragraph is one empty line.
 *
 *  Measured INCREMENTALLY: each word, each run of spaces after it and each
 *  character of a word that has to be broken is measured once (repeats come
 *  from a cache) and a line's width is their sum — re-measuring the whole
 *  line for every word made a 4000-character box take seconds. Kerning
 *  across a word boundary is ignored; that is far below a pixel. */
export function wrapParagraph(para: string, width: number, measure: (s: string) => number): [number, number][] {
  const lines: [number, number][] = [];
  if (para.length === 0) return [[0, 0]];
  const cache = new Map<string, number>();
  const m = (t: string): number => {
    let v = cache.get(t);
    if (v === undefined) {
      v = measure(t);
      if (cache.size < 8192) cache.set(t, v);
    }
    return v;
  };
  const trimEnd = (a: number, b: number): number => {
    while (b > a && /\s/.test(para[b - 1]!)) b--;
    return b;
  };
  // word tokens: [start, end) including their trailing whitespace; leading
  // whitespace of the paragraph belongs to the first word
  const words: [number, number][] = [];
  const re = /\S+\s*/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(para)) !== null) words.push([words.length === 0 ? 0 : mt.index, mt.index + mt[0].length]);
  if (words.length === 0) return [[0, 0]];

  // the open line is para[s, e); `full` is its width, trailing spaces included
  let s = words[0]![0];
  let e = s;
  let full = 0;
  for (const [ws, we] of words) {
    const wt = trimEnd(ws, we);
    const cw = m(para.slice(ws, wt));
    const tw = wt < we ? m(para.slice(wt, we)) : 0;
    if ((e > s ? full : 0) + cw <= width) {
      full = (e > s ? full : 0) + cw + tw;
      e = we;
      continue;
    }
    if (e > s) {
      lines.push([s, trimEnd(s, e)]);
      s = ws;
      e = ws;
      full = 0;
      if (cw <= width) {
        full = cw + tw;
        e = we;
        continue;
      }
    }
    // a word wider than the box on its own: break it between characters
    let i = s;
    const end = wt;
    while (i < end) {
      let j = i;
      let last = i;
      let acc = 0;
      while (j < end) {
        const cp = para.codePointAt(j)!;
        const next = j + (cp > 0xffff ? 2 : 1);
        const w = m(para.slice(j, next));
        if (last > i && acc + w > width) break;
        acc += w;
        last = next;
        j = next;
      }
      if (last >= end) {
        s = i;
        e = we;
        full = acc + tw;
        break;
      }
      lines.push([i, last]);
      i = last;
      s = i;
      e = i;
      full = 0;
    }
  }
  if (e > s || lines.length === 0) lines.push([s, trimEnd(s, e)]);
  return lines;
}
