// Arabic as real text (0.9.5): a right-to-left run with Arabic in it is
// shaped by fontkit's own OpenType layout (GSUB joining forms and ligatures,
// GPOS marks and kerning) and its glyphs are handed to pdf-lib as they are,
// in visual order, so the PDF holds selectable text whose ToUnicode maps each
// shaped glyph back to its logical characters (a ligature to all of them).
//
// pdf-lib can only encode a STRING (its encodeText runs fontkit's layout
// itself, with no script or direction): `encodeGlyphs` lends it the glyphs a
// layout of ours produced, through the embedder's own encodeText, so the
// subset, the /W widths and the ToUnicode CMap are built by pdf-lib exactly
// as for any other text. A font embedded whole (licence "noSubset") lists
// only its cmap glyphs for /W and ToUnicode: the shaped forms (not in the
// cmap) are added to that list.

import fontkit from "@pdf-lib/fontkit";
import type { PDFFont } from "pdf-lib";
import type { FontBoxTables } from "../../core/pdf-runs";

export interface FkGlyph {
  id: number;
  advanceWidth: number;
  codePoints: number[];
}

export interface FkPosition {
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

export interface FkRun {
  glyphs: FkGlyph[];
  positions: FkPosition[];
}

/** The slice of a fontkit font shaping and the font box read. */
export interface FkFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  hasGlyphForCodePoint(cp: number): boolean;
  layout(text: string, features?: string[], script?: string, language?: string, direction?: "ltr" | "rtl"): FkRun;
  "OS/2"?: {
    winAscent?: number;
    winDescent?: number;
    typoAscender?: number;
    typoDescender?: number;
    fsSelection?: { useTypoMetrics?: boolean };
  };
}

export function fkFontOf(bytes: Uint8Array): FkFont {
  return fontkit.create(bytes) as unknown as FkFont;
}

/** The tables `fontBoxOf` reads; a face without a usable OS/2 table answers
 *  its hhea ascent / descent there. */
export function fontBoxTables(f: FkFont): FontBoxTables {
  const upm = f.unitsPerEm > 0 ? f.unitsPerEm : 1000;
  const o = f["OS/2"];
  const hA = Math.abs(f.ascent) || 0.8 * upm;
  const hD = Math.abs(f.descent) || 0.2 * upm;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const winOk = o !== undefined && ok(o.winAscent) && ok(o.winDescent) && o.winAscent + o.winDescent > 0;
  const typoOk = o !== undefined && ok(o.typoAscender) && ok(o.typoDescender) && o.typoAscender - o.typoDescender > 0;
  return {
    unitsPerEm: upm,
    winAscent: winOk ? o!.winAscent! : hA,
    winDescent: winOk ? o!.winDescent! : hD,
    typoAscender: typoOk ? o!.typoAscender! : hA,
    typoDescender: typoOk ? o!.typoDescender! : -hD,
    useTypoMetrics: typoOk && o!.fsSelection?.useTypoMetrics === true,
  };
}

/** Characters a box may hold that need no glyph of their own: white space,
 *  controls and the default-ignorable format characters (joiners, bidi
 *  marks, soft hyphen, BOM); fontkit draws them as nothing or as a space. */
const NO_GLYPH = /[\s\p{Cc}\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/u;

/** Can `f` draw `text` (the characters as they will be DRAWN: mirrored where
 *  a right-to-left level mirrors them) as real text? Every character that
 *  needs a glyph has one in the font's cmap, and shaping (as `shapeRtlIn`
 *  does it, default-ignorables dropped) produces no .notdef. Checked per
 *  paragraph: shaping never crosses a newline. White space the font does not
 *  map (a tab, a no-break space) shapes to .notdef and so refuses. */
export function canShape(f: FkFont, text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (f.hasGlyphForCodePoint(cp)) continue;
    if (!NO_GLYPH.test(ch)) return false;
  }
  for (const para of text.split(/\r\n|\r|\n/)) {
    if (para && shapeRtlIn(f, para, para, 0, para.length).glyphs.some((g) => g.id === 0)) return false;
  }
  return true;
}

/** A LOGICAL-order right-to-left run (mirrored already) shaped as Arabic:
 *  glyphs and positions in VISUAL order, left to right (fontkit reverses a
 *  right-to-left run itself). Hebrew letters in the same run pass through
 *  unshaped, as they should. fontkit's own answer, nothing dropped. */
export function shapeRtl(f: FkFont, logical: string): FkRun {
  return f.layout(logical, [], "arab", undefined, "rtl");
}

interface GlyphSource {
  getGlyph(id: number, codePoints?: number[]): FkGlyph | null;
}

/** `run()` with every glyph fontkit hands out carrying the code points of
 *  THIS use: fontkit caches one glyph object per id with the code points it
 *  was first made with, so a glyph two letters share (Farsi and Arabic yeh's
 *  joining forms) would otherwise name the first letter ever shaped, and the
 *  joining analysis itself reads those code points. */
function tracked<T>(f: FkFont, run: () => T): T {
  const font = f as unknown as Partial<GlyphSource> & Record<string, unknown>;
  const prev = font.getGlyph;
  if (typeof prev !== "function") return run();
  const own = Object.prototype.hasOwnProperty.call(font, "getGlyph");
  font["getGlyph"] = function (this: unknown, id: number, codePoints?: number[]): FkGlyph | null {
    const g = prev.call(this, id, codePoints);
    return g ? (Object.create(g, { codePoints: { value: codePoints ? [...codePoints] : [], writable: true, enumerable: true } }) as FkGlyph) : g;
  };
  try {
    return run();
  } finally {
    if (own) font["getGlyph"] = prev;
    else delete font["getGlyph"];
  }
}

/** fontkit's stand-in for a default-ignorable character (a joiner, a bidi
 *  mark, a soft hyphen): the space glyph with no
 *  advance. Drawn it would copy out as a space, so it is not drawn at all. */
const hidden = (g: FkGlyph, p: FkPosition | undefined): boolean =>
  p !== undefined && p.xAdvance === 0 && g.codePoints.length === 1 && g.codePoints[0] === 0x20;

const SPACE = /\s/;

/** `mirrored[s, e)` shaped as Arabic WITH the joining context of its word:
 *  the letters of the same word on either side (inside `[lo, hi)`, the line)
 *  are shaped with it and then left out, so a style run that starts or ends
 *  inside a word keeps every letter's joining form, as the browser shows it.
 *  `logical` is the same text unmirrored (same length): each kept glyph maps
 *  to ITS characters there (a ligature to all of them; a mirrored bracket to
 *  the character typed), which is what ToUnicode gives back. Glyphs of
 *  default-ignorable characters are dropped (`hidden`). Visual order. */
export function shapeRtlIn(f: FkFont, mirrored: string, logical: string, s: number, e: number, lo = 0, hi = mirrored.length): FkRun {
  let cs = s;
  let ce = e;
  while (cs > lo && !SPACE.test(mirrored[cs - 1]!)) cs--;
  while (ce < hi && !SPACE.test(mirrored[ce]!)) ce++;
  // the real neighbours are shaped, so fontkit's own joining state machine
  // decides how the edge letters join them
  const run = tracked(f, () => f.layout(mirrored.slice(cs, ce), [], "arab", undefined, "rtl"));
  // code unit offset (into `mirrored`) of each code point of the slice
  const starts: number[] = [];
  for (let i = cs; i < ce; i++) {
    starts.push(i);
    const c = mirrored.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < ce) {
      const d = mirrored.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  starts.push(ce);
  // glyphs in LOGICAL order consume their code points in turn
  const n = run.glyphs.length;
  const from: number[] = new Array<number>(n);
  const to: number[] = new Array<number>(n);
  let k = 0;
  let last = cs;
  for (let j = n - 1; j >= 0; j--) {
    const c = run.glyphs[j]!.codePoints.length;
    if (c === 0) {
      from[j] = last;
      to[j] = last;
      continue;
    }
    if (k + c > starts.length - 1) break;
    from[j] = last = starts[k]!;
    to[j] = starts[k + c]!;
    k += c;
  }
  if (k !== starts.length - 1) {
    // the glyphs do not account for the characters one to one (a font
    // decomposing a letter): shape the piece alone, as it is
    if (cs === s && ce === e) {
      const keep = run.glyphs.map((g, i) => !hidden(g, run.positions[i]));
      return { glyphs: run.glyphs.filter((_, i) => keep[i]), positions: run.positions.filter((_, i) => keep[i]) };
    }
    return shapeRtlIn(f, mirrored, logical, s, e, s, e);
  }
  const glyphs: FkGlyph[] = [];
  const positions: FkPosition[] = [];
  for (let j = 0; j < n; j++) {
    const g = run.glyphs[j]!;
    const p = run.positions[j]!;
    if (from[j]! < s || from[j]! >= e) continue;
    if (hidden(g, p)) continue;
    const cps: number[] = [];
    for (const ch of logical.slice(from[j], to[j])) cps.push(ch.codePointAt(0)!);
    glyphs.push(to[j]! > from[j]! ? withCodePoints(g, cps) : g);
    positions.push(p);
  }
  return { glyphs, positions };
}

/** `g` naming `cps`: a glyph of its own for this use (fontkit's shared one
 *  is never written). */
function withCodePoints(g: FkGlyph, cps: number[]): FkGlyph {
  return Object.create(g, { codePoints: { value: cps, writable: true, enumerable: true } }) as FkGlyph;
}

/** A right-to-left run's glyphs as its ToUnicode map names them: a glyph of
 *  several characters (a ligature such as lam-alef, a letter with a mark
 *  composed in) lists them in REVERSE logical order. The glyphs are drawn in
 *  visual order, so a reader rebuilds the logical text by reversing the
 *  right-to-left run character by character, the glyph's own characters
 *  included: pdf.js does exactly that (its text content joins each glyph's
 *  ToUnicode string in drawing order, then its bidi step reverses the
 *  right-to-left run code unit by code unit), so a lam-alef mapped to
 *  lam + alef came back as alef + lam. Mapped alef + lam it comes back as
 *  lam + alef. Single-character glyphs are unchanged. */
export function rtlToUnicodeOrder(glyphs: readonly FkGlyph[]): FkGlyph[] {
  return glyphs.map((g) => (g.codePoints.length > 1 ? withCodePoints(g, [...g.codePoints].reverse()) : g));
}

/** A run's advance, points. */
export function runWidth(f: FkFont, run: FkRun, size: number): number {
  let w = 0;
  for (const p of run.positions) w += p.xAdvance;
  return (w * size) / (f.unitsPerEm > 0 ? f.unitsPerEm : 1000);
}

/** The width of `mirrored[s, e)` of an Arabic paragraph at `size`, as the
 *  line breaker measures it: shaped as Arabic in its word (`shapeRtlIn`), so
 *  it is the width the line will draw. */
export function shapedWidth(f: FkFont, mirrored: string, logical: string, s: number, e: number, size: number): number {
  return runWidth(f, shapeRtlIn(f, mirrored, logical, s, e), size);
}

/* ---------------- lending glyphs to pdf-lib ---------------- */

interface GlyphCacheLike {
  access(): FkGlyph[];
  invalidate(): void;
}

interface EmbedderLike {
  font: Record<string, unknown>;
  subset?: unknown;
  glyphCache: GlyphCacheLike;
}

/** Arabic Presentation Forms-A and -B. */
const presentationForm = (cp: number): boolean => (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);

/** Shaped glyphs a whole-file embedder must list besides its cmap glyphs. */
const extras = new WeakMap<EmbedderLike, Map<number, FkGlyph>>();

function keepGlyphs(emb: EmbedderLike, glyphs: readonly FkGlyph[]): void {
  let extra = extras.get(emb);
  if (!extra) {
    const mine = new Map<number, FkGlyph>();
    extra = mine;
    extras.set(emb, mine);
    const base = emb.glyphCache;
    emb.glyphCache = {
      access() {
        const list = base.access();
        if (mine.size === 0) return list;
        // A shaped glyph replaces the cmap's entry for the same id when the
        // cmap names it by a presentation form (Arial: U+FE91 for the initial
        // beh), which would copy out as that form, not as the letter. A cmap
        // entry naming an ordinary character stays: the same glyph drawn as
        // left-to-right text copies as that character (a bracket mirrored in
        // a right-to-left run is the same glyph as the other bracket).
        const have = new Set(list.map((g) => g.id));
        const add = [...mine.values()].filter((g) => !have.has(g.id));
        const out = list.map((g) => {
          const m = mine.get(g.id);
          return m && g.codePoints.length > 0 && g.codePoints.every(presentationForm) ? m : g;
        });
        // computeWidths needs them sorted by id
        return add.length ? [...out, ...add].sort((a, b) => a.id - b.id) : out;
      },
      invalidate() {
        base.invalidate();
      },
    };
  }
  for (const g of glyphs) if (g.id !== 0 && !extra.has(g.id)) extra.set(g.id, g);
}

/** The 4-hex-digit codes of `glyphs` in `font` (a custom font pdf-lib
 *  embedded), in order, registered with the font for its subset, widths and
 *  ToUnicode exactly as `encodeText` registers the glyphs of a string. */
export function encodeGlyphs(font: PDFFont, glyphs: readonly FkGlyph[]): string[] {
  const emb = (font as unknown as { embedder?: EmbedderLike }).embedder;
  if (!emb || typeof emb.font !== "object" || !emb.glyphCache) throw new Error("not an embedded custom font");
  if (!emb.subset) keepGlyphs(emb, glyphs);
  const fk = emb.font;
  const had = Object.prototype.hasOwnProperty.call(fk, "layout");
  const prev = fk["layout"];
  fk["layout"] = () => ({ glyphs: [...glyphs], positions: [] });
  let hex: string;
  try {
    hex = font.encodeText("").toString();
  } finally {
    if (had) fk["layout"] = prev;
    else delete fk["layout"];
  }
  const body = hex.slice(1, -1);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 4) out.push(body.slice(i, i + 4));
  if (out.length !== glyphs.length) throw new Error("glyph codes do not line up");
  return out;
}
