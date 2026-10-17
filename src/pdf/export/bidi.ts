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
 *  Export does not shape; a text box containing any of these is drawn by the
 *  browser instead (see raster.ts). */
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
  const out = lib().getReorderedString(p.text, p.levels, start, end - 1);
  return fixSurrogates(out);
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
