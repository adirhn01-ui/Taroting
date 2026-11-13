// Logical → visual order for one laid-out line (pdf-lib draws glyphs in the
// order given and has no bidi of its own: logical-order Hebrew came out
// reversed in the spike). bidi-js runs the Unicode Bidirectional Algorithm on
// the whole paragraph — so a line's levels see its neighbours, as the UBA
// wants — and reorders + mirrors one line of it.

import bidiFactory from "bidi-js";

type Bidi = ReturnType<typeof bidiFactory>;
let bidi: Bidi | null = null;
function lib(): Bidi {
  bidi ??= bidiFactory();
  return bidi;
}

/** Characters that need contextual shaping (joining) to read correctly:
 *  Arabic, Arabic Supplement, Arabic Extended-A, and the presentation forms.
 *  A text box containing any of these is shaped by fontkit (shape.ts) when
 *  its fonts can draw every character, else drawn by the browser (raster.ts). */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function hasArabic(s: string): boolean {
  return ARABIC.test(s);
}

const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LETTER = /\p{L}/u;

/** Is the paragraph right-to-left by its first strong character (UBA rule
 *  P2/P3, the "auto" direction)? */
export function firstStrongRtl(s: string): boolean {
  for (const ch of s) {
    if (STRONG_RTL.test(ch)) return true;
    if (LETTER.test(ch)) return false;
  }
  return false;
}

export interface ParagraphBidi {
  text: string;
  levels: ReturnType<Bidi["getEmbeddingLevels"]>;
}

export function paragraphBidi(text: string): ParagraphBidi {
  return { text, levels: lib().getEmbeddingLevels(text, "auto") };
}

/** The visual-order string of `text[start, end)` within its paragraph. */
export function visualLine(p: ParagraphBidi, start: number, end: number): string {
  if (end <= start) return "";
  const slice = p.text.slice(start, end);
  // Pure left-to-right text (the common case) has nothing to reorder.
  if (!STRONG_RTL.test(slice) && !p.levels.levels.slice(start, end).some((l) => l & 1)) return slice;
  // getReorderedString answers the WHOLE paragraph with only [start, end - 1]
  // reordered in place (code unit for code unit), so cut the line back out.
  const out = lib().getReorderedString(p.text, p.levels, start, end - 1);
  return fixSurrogates(out.slice(start, end));
}

/** One piece of a laid-out line in a box with style runs (0.9.4): a maximal
 *  stretch of consecutive VISUAL positions in one segment whose characters
 *  are also contiguous in LOGICAL order (all ascending, or all descending).
 *  `[s, e)` is its logical range in the paragraph; `rtl` = drawn reversed;
 *  `text` its visual-order string (mirrored, surrogate pairs kept whole), for
 *  pdf-lib. The canvas draws `para.slice(s, e)` with `rtl` as its direction
 *  instead, so it can shape joining scripts. */
export interface VisualGroup {
  seg: number;
  s: number;
  e: number;
  rtl: boolean;
  text: string;
}

/** `p.text[start, end)` as visual groups, left to right; `segOf(i)` names the
 *  segment of paragraph offset `i`. Unlike `visualLine` it reorders only the
 *  line (the paragraph's other lines are not part of the answer). */
export function visualGroups(p: ParagraphBidi, start: number, end: number, segOf: (i: number) => number): VisualGroup[] {
  if (end <= start) return [];
  const lv = p.levels.levels;
  let order: number[];
  if (!STRONG_RTL.test(p.text.slice(start, end)) && !lv.slice(start, end).some((l) => l & 1)) {
    order = [];
    for (let i = start; i < end; i++) order.push(i);
  } else {
    order = lib().getReorderedIndices(p.text, p.levels, start, end - 1).slice(start, end);
  }
  const out: VisualGroup[] = [];
  let k = 0;
  while (k < order.length) {
    const first = order[k]!;
    const seg = segOf(first);
    let dir = 0;
    let last = first;
    let j = k + 1;
    for (; j < order.length; j++) {
      const i = order[j]!;
      if (segOf(i) !== seg) break;
      const d = i - last;
      if (dir === 0 ? d !== 1 && d !== -1 : d !== dir) break;
      dir = d;
      last = i;
    }
    let text = "";
    for (let m = k; m < j; m++) {
      const i = order[m]!;
      const ch = p.text[i]!;
      text += (lv[i]! & 1 ? lib().getMirroredCharacter(ch) : null) ?? ch;
    }
    out.push({
      seg,
      s: Math.min(first, last),
      e: Math.max(first, last) + 1,
      rtl: dir === -1 || (dir === 0 && (lv[first]! & 1) === 1),
      text: fixSurrogates(text),
    });
    k = j;
  }
  return out;
}

/** A whole box's text with each paragraph mirrored at its right-to-left
 *  levels (`logicalMirrored`), line breaks kept: the characters as they are
 *  DRAWN, in logical order, offset for offset (a mirrored character is one
 *  code unit, as its pair). */
export function drawnText(text: string): string {
  let out = "";
  // split with a capture group: the separators sit at the odd indices
  text.split(/(\r\n|\r|\n)/).forEach((part, i) => {
    out += i % 2 === 1 ? part : logicalMirrored(paragraphBidi(part), 0, part.length);
  });
  return out;
}

/** `p.text[start, end)` in LOGICAL order with every character at a right-to-
 *  left (odd) level mirrored: the input of a shaper that reverses the run
 *  itself (shape.ts), so brackets read as `visualGroups` draws them. */
export function logicalMirrored(p: ParagraphBidi, start: number, end: number): string {
  const lv = p.levels.levels;
  let out = "";
  for (let i = start; i < end; i++) {
    const ch = p.text[i]!;
    out += (lv[i]! & 1 ? lib().getMirroredCharacter(ch) : null) ?? ch;
  }
  return out;
}

/** Reversing a run reverses UTF-16 code units, so a supplementary character
 *  inside a right-to-left run comes out as low+high; swap such pairs back. */
function fixSurrogates(s: string): string {
  if (!/[\uDC00-\uDFFF][\uD800-\uDBFF]/.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    if (a >= 0xdc00 && a <= 0xdfff && b >= 0xd800 && b <= 0xdbff) {
      out += s[i + 1]! + s[i]!;
      i++;
    } else {
      out += s[i]!;
    }
  }
  return out;
}
