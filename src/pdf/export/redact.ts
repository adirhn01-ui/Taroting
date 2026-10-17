// "Edit text" at export: REMOVE the original glyphs an edited text box
// replaces from the page's content, so the exported page carries only the new
// text (selectable, searchable, no old words hidden under a white box).
//
//   1. the page's content streams are decoded and joined (pdf-lib decodes
//      Flate/LZW/ASCII85/…), then cut into operators by a small tokenizer
//      that records every operator's byte range (`parseContent`);
//   2. an interpreter follows the graphics and text state (q/Q, cm, BT/ET,
//      Tm/Td/TD/T*, TL/Tc/Tw/Tz/Ts/Tf/Tr) and places every glyph of Tj, TJ,
//      ' and " in page space from its font's widths (`redactContent`);
//   3. a glyph whose box centre falls inside an edit rect (grown 0.5 pt) is
//      cut out of its string and replaced by a TJ number equal to its
//      advance, so every glyph after it stays exactly where it was;
//   4. the output is the ORIGINAL bytes with only the rewritten text-showing
//      operators spliced in — everything else is copied verbatim.
//
// Where a glyph inside a rect cannot be removed (an unknown font or width, a
// clipping text mode, text inside a Form XObject, a page that does not parse)
// the rect is reported unresolved and export.ts paints the edit's cover colour
// over it instead, so old and new text never overlap. A rect in which nothing
// was removed at all is unresolved too (its text came from somewhere we did
// not see), and so is invisible text (render mode 3: an OCR layer over a scan
// — the picture still shows the old words).
//
// Only pages that carry an edited text box are ever parsed.

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFontEmbedder,
  StandardFonts,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import type { PageGeom } from "./marks";

/** [x, y, w, h] in page space (PDF points of the unrotated page, origin the
 *  crop box's top-left, y down). */
export type PageRect = [number, number, number, number];
/** [a, b, c, d, e, f] — a PDF matrix (row-vector convention). */
export type Matrix = [number, number, number, number, number, number];

/** How far outside a rect a glyph centre may sit and still be "inside". */
export const EDIT_SLOP = 0.5;
/** Edit rects on one page beyond which the page is not parsed and every rect
 *  is covered instead: each glyph is tested against every rect, and a crafted
 *  project can carry far more rects than any real edit (one is <= 2000). */
export const PAGE_MAX_EDIT_RECTS = 5000;
/** Where a glyph's centre sits, in em above its baseline (between a typical
 *  descent of 0.2 and ascent of 0.8). */
const CENTRE_EM = 0.3;

/* ======================== tokenizer ======================== */

export class ContentParseError extends Error {}

export type Tok =
  | { k: "num"; v: number; s: number; e: number }
  | { k: "str"; b: Uint8Array; s: number; e: number }
  | { k: "name"; v: string; s: number; e: number }
  | { k: "arr"; items: Tok[]; s: number; e: number }
  | { k: "dict"; items: Tok[]; s: number; e: number }
  /** true / false / null (operands, not operators) */
  | { k: "kw"; v: string; s: number; e: number };

/** One operator with its operands. [s, e) = its bytes in the source, first
 *  operand to the end of the operator (an inline image: BI … EI). */
export interface Op {
  op: string;
  args: Tok[];
  s: number;
  e: number;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

class Lexer {
  i = 0;
  constructor(readonly src: Uint8Array) {}

  skipWs(): void {
    const s = this.src;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (WS[c]) this.i++;
      else if (c === 37) {
        // % comment to the end of the line
        while (this.i < s.length && s[this.i] !== 10 && s[this.i] !== 13) this.i++;
      } else break;
    }
  }

  /** The next token, an operator name (as a "kw"-less string), or null at the end. */
  next(): Tok | { k: "op"; v: string; s: number; e: number } | { k: "close"; c: number; s: number } | null {
    this.skipWs();
    const s = this.src;
    if (this.i >= s.length) return null;
    const start = this.i;
    const c = s[this.i]!;
    if (c === 40) return this.literal();
    if (c === 60) {
      if (s[this.i + 1] === 60) {
        this.i += 2;
        return this.collect("dict", start, 62);
      }
      return this.hex();
    }
    if (c === 91) {
      this.i++;
      return this.collect("arr", start, 93);
    }
    if (c === 93) {
      this.i++;
      return { k: "close", c: 93, s: start };
    }
    if (c === 62) {
      if (s[this.i + 1] !== 62) throw new ContentParseError("stray >");
      this.i += 2;
      return { k: "close", c: 62, s: start };
    }
    if (c === 47) return this.name();
    if (c === 123 || c === 125 || c === 41) throw new ContentParseError(`unexpected ${String.fromCharCode(c)}`);
    // a regular token: number, keyword operand or operator
    while (this.i < s.length && !WS[s[this.i]!] && !DELIM[s[this.i]!]) this.i++;
    let word = "";
    for (let j = start; j < this.i; j++) word += String.fromCharCode(s[j]!);
    if (NUM_RE.test(word)) return { k: "num", v: Number(word), s: start, e: this.i };
    if (word === "true" || word === "false" || word === "null") return { k: "kw", v: word, s: start, e: this.i };
    return { k: "op", v: word, s: start, e: this.i };
  }

  private collect(k: "arr" | "dict", start: number, close: number): Tok {
    const items: Tok[] = [];
    for (;;) {
      const t = this.next();
      if (!t) throw new ContentParseError(`unterminated ${k}`);
      if (t.k === "close") {
        if (t.c !== close) throw new ContentParseError(`mismatched close in ${k}`);
        return { k, items, s: start, e: this.i } as Tok;
      }
      if (t.k === "op") throw new ContentParseError(`operator ${t.v} inside ${k}`);
      items.push(t);
    }
  }

  private literal(): Tok {
    const s = this.src;
    const start = this.i++;
    const out: number[] = [];
    let depth = 1;
    while (this.i < s.length) {
      const c = s[this.i++]!;
      if (c === 92) {
        if (this.i >= s.length) break;
        const d = s[this.i++]!;
        switch (d) {
          case 110: out.push(10); break;
          case 114: out.push(13); break;
          case 116: out.push(9); break;
          case 98: out.push(8); break;
          case 102: out.push(12); break;
          case 13:
            if (s[this.i] === 10) this.i++;
            break; // line continuation
          case 10:
            break;
          default:
            if (d >= 48 && d <= 55) {
              let v = d - 48;
              for (let n = 0; n < 2 && s[this.i]! >= 48 && s[this.i]! <= 55; n++) v = v * 8 + (s[this.i++]! - 48);
              out.push(v & 255);
            } else out.push(d); // \( \) \\ and any other: the character itself
        }
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) return { k: "str", b: Uint8Array.from(out), s: start, e: this.i };
        out.push(c);
      } else if (c === 13) {
        // an end of line in a literal string reads as \n
        if (s[this.i] === 10) this.i++;
        out.push(10);
      } else out.push(c);
    }
    throw new ContentParseError("unterminated string");
  }

  private hex(): Tok {
    const s = this.src;
    const start = this.i++;
    const out: number[] = [];
    let hi = -1;
    while (this.i < s.length) {
      const c = s[this.i++]!;
      if (c === 62) {
        if (hi >= 0) out.push(hi << 4);
        return { k: "str", b: Uint8Array.from(out), s: start, e: this.i };
      }
      if (WS[c]) continue;
      const v = hexVal(c);
      if (v < 0) throw new ContentParseError("bad hex string");
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    throw new ContentParseError("unterminated hex string");
  }

  private name(): Tok {
    const s = this.src;
    const start = this.i++;
    let v = "";
    while (this.i < s.length && !WS[s[this.i]!] && !DELIM[s[this.i]!]) {
      const c = s[this.i++]!;
      if (c === 35 && this.i + 1 < s.length && hexVal(s[this.i]!) >= 0 && hexVal(s[this.i + 1]!) >= 0) {
        v += String.fromCharCode((hexVal(s[this.i]!) << 4) | hexVal(s[this.i + 1]!));
        this.i += 2;
      } else v += String.fromCharCode(c);
    }
    return { k: "name", v, s: start, e: this.i };
  }

  /** Skip an inline image's data after ID; the index after EI. */
  inlineImageEnd(dict: Tok[]): number {
    const s = this.src;
    // exactly one white-space byte follows ID
    let i = this.i + 1;
    const known = unfilteredImageLength(dict);
    if (known !== null) {
      i += known;
      // then (optional white space) EI
      while (i < s.length && WS[s[i]!]) i++;
      if (s[i] === 69 && s[i + 1] === 73 && (i + 2 >= s.length || WS[s[i + 2]!] || DELIM[s[i + 2]!])) return i + 2;
      i = this.i + 1; // the dictionary lied: fall back to the scan
    }
    for (; i + 1 < s.length; i++) {
      if (s[i] === 69 && s[i + 1] === 73 && WS[s[i - 1]!] && (i + 2 >= s.length || WS[s[i + 2]!])) return i + 2;
    }
    throw new ContentParseError("inline image without EI");
  }
}

/** Byte length of an unfiltered inline image from its dictionary, or null. */
function unfilteredImageLength(items: Tok[]): number | null {
  const get = (...keys: string[]): Tok | undefined => {
    for (let i = 0; i + 1 < items.length; i += 2) {
      const k = items[i]!;
      if (k.k === "name" && keys.includes(k.v)) return items[i + 1];
    }
    return undefined;
  };
  if (get("F", "Filter")) return null;
  const w = get("W", "Width");
  const h = get("H", "Height");
  if (w?.k !== "num" || h?.k !== "num") return null;
  const mask = get("IM", "ImageMask");
  let bpc = 8;
  let comps = 1;
  if (mask?.k === "kw" && mask.v === "true") bpc = 1;
  else {
    const b = get("BPC", "BitsPerComponent");
    if (b?.k === "num") bpc = b.v;
    const cs = get("CS", "ColorSpace");
    if (cs?.k !== "name") return null; // indexed / named resource: let the scan decide
    const n: Record<string, number> = { G: 1, DeviceGray: 1, CalGray: 1, I: 1, Indexed: 1, RGB: 3, DeviceRGB: 3, CalRGB: 3, CMYK: 4, DeviceCMYK: 4 };
    if (!(cs.v in n)) return null;
    comps = n[cs.v]!;
  }
  return Math.ceil((w.v * comps * bpc) / 8) * h.v;
}

/** Every operator of a content stream. Throws ContentParseError when it is
 *  not one. Comments and white space between operators are not represented
 *  (the splice copies them from the source untouched). */
export function parseContent(src: Uint8Array): Op[] {
  const lx = new Lexer(src);
  const ops: Op[] = [];
  let args: Tok[] = [];
  let start = -1;
  for (;;) {
    const t = lx.next();
    if (!t) break;
    if (t.k === "close") throw new ContentParseError("stray close");
    if (t.k !== "op") {
      if (start < 0) start = t.s;
      args.push(t);
      continue;
    }
    if (t.v === "BI") {
      // the inline image dictionary up to ID, then its data up to EI
      const s0 = start < 0 ? t.s : start;
      const dict: Tok[] = [];
      for (;;) {
        const d = lx.next();
        if (!d) throw new ContentParseError("inline image without ID");
        if (d.k === "op") {
          if (d.v !== "ID") throw new ContentParseError(`${d.v} inside an inline image`);
          break;
        }
        if (d.k === "close") throw new ContentParseError("stray close");
        dict.push(d);
      }
      const end = lx.inlineImageEnd(dict);
      lx.i = end;
      ops.push({ op: "BI", args: dict, s: s0, e: end });
    } else {
      ops.push({ op: t.v, args, s: start < 0 ? t.s : start, e: t.e });
    }
    args = [];
    start = -1;
  }
  if (args.length) throw new ContentParseError("operands without an operator");
  return ops;
}

/** The source with each op in `replace` swapped for its text; everything else
 *  — operators, comments, white space — copied byte for byte. */
export function spliceContent(src: Uint8Array, replace: Map<Op, string>): Uint8Array {
  if (!replace.size) return src;
  const sorted = [...replace.entries()].sort((a, b) => a[0].s - b[0].s);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const [op, text] of sorted) {
    parts.push(src.subarray(at, op.s));
    parts.push(latin1(text));
    at = op.e;
  }
  parts.push(src.subarray(at));
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

/** Write a token back out (canonical form; used for synthesized operators). */
export function serializeTok(t: Tok): string {
  switch (t.k) {
    case "num":
      return fmt(t.v);
    case "kw":
      return t.v;
    case "name": {
      let s = "/";
      for (const ch of t.v) {
        const c = ch.charCodeAt(0);
        s += c < 33 || c > 126 || DELIM[c] || c === 35 ? `#${c.toString(16).padStart(2, "0")}` : ch;
      }
      return s;
    }
    case "str":
      return hexOf(t.b);
    case "arr":
      return `[${t.items.map(serializeTok).join(" ")}]`;
    case "dict":
      return `<<${t.items.map(serializeTok).join(" ")}>>`;
  }
}

/** Every op written canonically, one per line (inline images copied raw). */
export function serializeOps(src: Uint8Array, ops: Op[]): Uint8Array {
  const parts: string[] = [];
  for (const op of ops) {
    if (op.op === "BI") {
      let raw = "";
      for (let i = op.s; i < op.e; i++) raw += String.fromCharCode(src[i]!);
      parts.push(raw);
    } else parts.push([...op.args.map(serializeTok), op.op].join(" "));
  }
  return latin1(parts.join("\n"));
}

function hexOf(b: Uint8Array): string {
  let s = "<";
  for (const v of b) s += v.toString(16).padStart(2, "0").toUpperCase();
  return s + ">";
}

/** A content-stream number with up to 4 decimals, never exponent, never -0. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 10000) / 10000;
  if (r === 0) return "0";
  return r.toFixed(4).replace(/\.?0+$/, "");
}

/* ======================== fonts ======================== */

/** What the interpreter needs of a font. */
export interface FontInfo {
  /** 2-byte codes (Type0 Identity-H/V) */
  twoByte: boolean;
  /** advance of `code` in thousandths of text space, or null when unknown */
  width(code: number): number | null;
}

type Std = (typeof StandardFonts)[keyof typeof StandardFonts];

/** A standard-14 font for a BaseFont name (subset prefix and the common
 *  Windows aliases allowed), or null. */
export function standardFontFor(baseFont: string): Std | null {
  const name = baseFont.replace(/^[A-Z]{6}\+/, "");
  const n = name.toLowerCase().replace(/[\s,_-]/g, "");
  const bold = /bold|black|heavy/.test(n);
  const italic = /italic|oblique/.test(n);
  const pick = (r: Std, b: Std, i: Std, bi: Std): Std => (bold && italic ? bi : bold ? b : italic ? i : r);
  if (/^(helvetica|arial)/.test(n)) {
    return pick(StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique);
  }
  if (/^times/.test(n)) {
    return pick(StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic);
  }
  if (/^courier/.test(n)) {
    return pick(StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique);
  }
  if (n === "symbol") return StandardFonts.Symbol;
  if (n === "zapfdingbats") return StandardFonts.ZapfDingbats;
  return null;
}

interface StdMetrics {
  width(glyph: string): number | null;
  /** the font's built-in encoding: code → glyph name */
  builtin: Map<number, string>;
}
const stdCache = new Map<Std, StdMetrics>();
let winAnsi: Map<number, string> | null = null;

function invert(enc: { supportedCodePoints: number[]; encodeUnicodeCodePoint(cp: number): { code: number; name: string } }): Map<number, string> {
  const m = new Map<number, string>();
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    if (!m.has(code)) m.set(code, name);
  }
  return m;
}

function stdMetrics(name: Std): StdMetrics {
  let m = stdCache.get(name);
  if (!m) {
    const emb = StandardFontEmbedder.for(name as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    const font = emb.font;
    const enc = invert(emb.encoding);
    if (name !== StandardFonts.Symbol && name !== StandardFonts.ZapfDingbats) winAnsi ??= enc;
    m = {
      width: (g) => {
        const w = font.getWidthOfGlyph(g);
        return typeof w === "number" ? w : null;
      },
      builtin: name === StandardFonts.Symbol || name === StandardFonts.ZapfDingbats ? enc : standardEncoding(enc),
    };
    stdCache.set(name, m);
  }
  return m;
}

/** StandardEncoding (a Type 1 font's built-in), for the codes it shares with
 *  WinAnsi below 128; its upper half is not used by real producers without
 *  a /Differences array, so it stays unknown (→ a cover). */
function standardEncoding(win: Map<number, string>): Map<number, string> {
  const m = new Map<number, string>();
  for (let c = 32; c < 127; c++) {
    const g = win.get(c);
    if (g) m.set(c, g);
  }
  m.set(0x27, "quoteright");
  m.set(0x60, "quoteleft");
  return m;
}

function winAnsiTable(): Map<number, string> {
  if (!winAnsi) stdMetrics(StandardFonts.Helvetica);
  return winAnsi!;
}

const lookup = (ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined => (o instanceof PDFRef ? ctx.lookup(o) : o);
const numOf = (ctx: PDFContext, o: PDFObject | undefined): number | null => {
  const v = lookup(ctx, o);
  return v instanceof PDFNumber ? v.asNumber() : null;
};
const nameOf = (ctx: PDFContext, o: PDFObject | undefined): string | null => {
  const v = lookup(ctx, o);
  return v instanceof PDFName ? v.decodeText() : null;
};
function numsOf(ctx: PDFContext, o: PDFObject | undefined): number[] | null {
  const a = lookup(ctx, o);
  if (!(a instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = numOf(ctx, a.get(i));
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** The FontInfo of a font dictionary, or null when its widths cannot be known. */
export function fontInfoOf(ctx: PDFContext, dict: PDFDict): FontInfo | null {
  const get = (k: string) => dict.get(PDFName.of(k));
  const subtype = nameOf(ctx, get("Subtype"));
  if (subtype === "Type0") {
    const enc = nameOf(ctx, get("Encoding"));
    if (enc !== "Identity-H") return null; // vertical or a CMap: code lengths unknown here
    const desc = lookup(ctx, get("DescendantFonts"));
    const cid = desc instanceof PDFArray ? lookup(ctx, desc.get(0)) : undefined;
    if (!(cid instanceof PDFDict)) return null;
    const dw = numOf(ctx, cid.get(PDFName.of("DW"))) ?? 1000;
    const widths = new Map<number, number>();
    const w = lookup(ctx, cid.get(PDFName.of("W")));
    if (w instanceof PDFArray) {
      let i = 0;
      while (i < w.size()) {
        const first = numOf(ctx, w.get(i));
        const second = lookup(ctx, w.get(i + 1));
        if (first === null || second === undefined) return null;
        if (second instanceof PDFArray) {
          const list = numsOf(ctx, second);
          if (!list) return null;
          list.forEach((v, j) => widths.set(first + j, v));
          i += 2;
        } else {
          const last = numOf(ctx, second);
          const v = numOf(ctx, w.get(i + 2));
          if (last === null || v === null || last - first > 65535) return null;
          for (let c = first; c <= last; c++) widths.set(c, v);
          i += 3;
        }
      }
    }
    // Identity-H: CID = code
    return { twoByte: true, width: (c) => widths.get(c) ?? dw };
  }
  const first = numOf(ctx, get("FirstChar")) ?? 0;
  const widths = numsOf(ctx, get("Widths"));
  if (subtype === "Type3") {
    const fm = numsOf(ctx, get("FontMatrix"));
    if (!widths || !fm || fm.length !== 6) return null;
    const sx = fm[0]! * 1000;
    return { twoByte: false, width: (c) => (c >= first && c < first + widths.length ? widths[c - first]! * sx : null) };
  }
  if (widths) {
    const fd = lookup(ctx, get("FontDescriptor"));
    const missing = fd instanceof PDFDict ? numOf(ctx, fd.get(PDFName.of("MissingWidth"))) ?? 0 : 0;
    return { twoByte: false, width: (c) => (c >= first && c < first + widths.length ? widths[c - first]! : missing) };
  }
  // a standard-14 font without /Widths: the AFM metrics, through the encoding
  const base = nameOf(ctx, get("BaseFont"));
  const std = base ? standardFontFor(base) : null;
  if (!std) return null;
  const metrics = stdMetrics(std);
  const symbolic = std === StandardFonts.Symbol || std === StandardFonts.ZapfDingbats;
  let table = metrics.builtin;
  const encObj = lookup(ctx, get("Encoding"));
  const baseTable = (n: string | null): Map<number, string> | null =>
    n === "WinAnsiEncoding" ? winAnsiTable() : n === "StandardEncoding" ? stdMetrics(StandardFonts.Helvetica).builtin : n === null ? metrics.builtin : null;
  if (encObj instanceof PDFName) {
    const t = symbolic ? metrics.builtin : baseTable(encObj.decodeText());
    if (!t) return null; // MacRoman / MacExpert: not tabled here
    table = t;
  } else if (encObj instanceof PDFDict) {
    const t = symbolic ? metrics.builtin : baseTable(nameOf(ctx, encObj.get(PDFName.of("BaseEncoding"))));
    if (!t) return null;
    table = new Map(t);
    const diff = lookup(ctx, encObj.get(PDFName.of("Differences")));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const v = lookup(ctx, diff.get(i));
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) table.set(code++, v.decodeText());
      }
    }
  }
  const t = table;
  return {
    twoByte: false,
    width: (c) => {
      const g = t.get(c);
      return g ? metrics.width(g) : null;
    },
  };
}

/* ======================== the interpreter ======================== */

export interface FormInfo {
  bbox: [number, number, number, number];
  matrix: Matrix;
  /** may draw text (has fonts, or inherits the page's) */
  text: boolean;
}

export interface RedactInput {
  content: Uint8Array;
  /** the edit rects of the page, page space */
  rects: PageRect[];
  geom: PageGeom;
  /** a font resource by name: FontInfo, or null when unknown / missing */
  font(name: string): FontInfo | null;
  /** a Form XObject resource by name, or null (image / missing) */
  form(name: string): FormInfo | null;
}

export interface RedactResult {
  /** the rewritten content, or null when nothing was removed */
  content: Uint8Array | null;
  /** per rect: true when the cover must be drawn there */
  unresolved: boolean[];
  /** glyphs removed in all */
  removed: number;
}

const ID: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

interface GState {
  ctm: Matrix;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  tfs: number;
  font: FontInfo | null;
  /** a Tf has been seen */
  fontSet: boolean;
  tr: number;
  ts: number;
}

const argNums = (op: Op, n: number): number[] | null => {
  if (op.args.length < n) return null;
  const out: number[] = [];
  for (const a of op.args.slice(op.args.length - n)) {
    if (a.k !== "num") return null;
    out.push(a.v);
  }
  return out;
};

/** Remove the glyphs inside `rects` from a page's content (see the header). */
export function redactContent(input: RedactInput): RedactResult {
  const { rects, geom } = input;
  const removedIn = rects.map(() => 0);
  const blocked = rects.map(() => false);
  let lost = false;
  /** positions on this line are guesses (an unknown advance came before) —
   *  cleared by the next absolute or line move */
  let guess = false;
  let removedAll = 0;
  let ops: Op[];
  try {
    ops = parseContent(input.content);
  } catch {
    return { content: null, unresolved: rects.map(() => true), removed: 0 };
  }

  const grown = rects.map(([x, y, w, h]) => [x - EDIT_SLOP, y - EDIT_SLOP, x + w + EDIT_SLOP, y + h + EDIT_SLOP] as const);
  const toPage = (ux: number, uy: number): [number, number] => [ux - geom.x, geom.y + geom.h - uy];
  const hits = (px: number, py: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < grown.length; i++) {
      const g = grown[i]!;
      if (px >= g[0] && px <= g[2] && py >= g[1] && py <= g[3]) out.push(i);
    }
    return out;
  };

  let gs: GState = { ctm: ID, tc: 0, tw: 0, th: 1, tl: 0, tfs: 0, font: null, fontSet: false, tr: 0, ts: 0 };
  const stack: GState[] = [];
  let tm: Matrix = ID;
  let tlm: Matrix = ID;
  const replace = new Map<Op, string>();
  const fonts = new Map<string, FontInfo | null>();

  const td = (tx: number, ty: number): void => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    guess = false;
  };

  /** Show one string; returns its TJ elements when a glyph was removed. */
  type El = { n: number } | { b: number[] };
  const show = (bytes: Uint8Array, out: El[]): boolean => {
    const f = gs.font;
    let changed = false;
    const keep = (b: number[]): void => {
      const last = out[out.length - 1];
      if (last && "b" in last) for (const v of b) last.b.push(v);
      else out.push({ b: b.slice() });
    };
    const adjust = (n: number): void => {
      const last = out[out.length - 1];
      if (last && "n" in last) last.n += n;
      else out.push({ n });
    };
    const step = f?.twoByte ? 2 : 1;
    if (!f || (f.twoByte && bytes.length % 2)) {
      if (bytes.length) {
        lost = true;
        guess = true;
      }
      keep(Array.from(bytes));
      return false;
    }
    // glyph positions along the string: text space x from where it starts,
    // through Tm × CTM once (Trm = [Tfs·Th 0 0 Tfs 0 Ts] × Tm × CTM)
    const m = mul(tm, gs.ctm);
    const cy = gs.ts + CENTRE_EM * gs.tfs;
    let tx = 0;
    for (let i = 0; i < bytes.length; i += step) {
      const code = step === 2 ? (bytes[i]! << 8) | bytes[i + 1]! : bytes[i]!;
      const w = f.width(code);
      const glyph = step === 2 ? [bytes[i]!, bytes[i + 1]!] : [bytes[i]!];
      if (w === null) {
        // its advance is unknown: every position after it is a guess
        lost = true;
        guess = true;
        keep(glyph);
        continue;
      }
      const space = step === 1 && code === 32 ? gs.tw : 0;
      const cx = tx + (w / 2000) * gs.tfs * gs.th;
      const [px, py] = toPage(cx * m[0] + cy * m[2] + m[4], cx * m[1] + cy * m[3] + m[5]);
      const inside = hits(px, py);
      const advance = ((w / 1000) * gs.tfs + gs.tc + space) * gs.th;
      if (inside.length) {
        // a clipping mode, or a zero font size a TJ number cannot stand in for
        const removable = gs.tr <= 3 && gs.tfs !== 0 && !guess;
        if (removable) {
          for (const r of inside) {
            removedIn[r]!++;
            if (gs.tr === 3) blocked[r] = true; // invisible text: the picture shows the old words
          }
          removedAll++;
          adjust(-(w + (1000 * (gs.tc + space)) / gs.tfs));
          changed = true;
        } else {
          if (gs.tr !== 7) for (const r of inside) blocked[r] = true;
          keep(glyph);
        }
      } else keep(glyph);
      tx += advance;
    }
    if (tx !== 0) tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + tx * tm[0], tm[5] + tx * tm[1]];
    return changed;
  };

  const emitTJ = (els: El[]): string =>
    `[${els.map((e) => ("n" in e ? fmt(e.n) : hexOf(Uint8Array.from(e.b)))).join(" ")}] TJ`;

  for (const op of ops) {
    switch (op.op) {
      case "q":
        stack.push(gs);
        break;
      case "Q":
        gs = stack.pop() ?? gs;
        break;
      case "cm": {
        const m = argNums(op, 6);
        if (m) gs = { ...gs, ctm: mul(m as Matrix, gs.ctm) };
        break;
      }
      case "BT":
        tm = ID;
        tlm = ID;
        guess = false;
        break;
      case "Tm": {
        const m = argNums(op, 6);
        if (m) {
          tm = m as Matrix;
          tlm = tm;
          guess = false;
        }
        break;
      }
      case "Td": {
        const m = argNums(op, 2);
        if (m) td(m[0]!, m[1]!);
        break;
      }
      case "TD": {
        const m = argNums(op, 2);
        if (m) {
          gs = { ...gs, tl: -m[1]! };
          td(m[0]!, m[1]!);
        }
        break;
      }
      case "T*":
        td(0, -gs.tl);
        break;
      case "TL":
      case "Tc":
      case "Tw":
      case "Tz":
      case "Ts":
      case "Tr": {
        const m = argNums(op, 1);
        if (!m) break;
        const v = m[0]!;
        gs = { ...gs };
        if (op.op === "TL") gs.tl = v;
        else if (op.op === "Tc") gs.tc = v;
        else if (op.op === "Tw") gs.tw = v;
        else if (op.op === "Tz") gs.th = v / 100;
        else if (op.op === "Ts") gs.ts = v;
        else gs.tr = v;
        break;
      }
      case "Tf": {
        const name = op.args[op.args.length - 2];
        const size = op.args[op.args.length - 1];
        if (name?.k !== "name" || size?.k !== "num") break;
        if (!fonts.has(name.v)) fonts.set(name.v, input.font(name.v));
        gs = { ...gs, font: fonts.get(name.v) ?? null, tfs: size.v, fontSet: true };
        break;
      }
      case "Tj":
      case "'":
      case '"': {
        let prefix = "";
        if (op.op === '"') {
          const aw = op.args[0];
          const ac = op.args[1];
          if (aw?.k === "num" && ac?.k === "num") {
            gs = { ...gs, tw: aw.v, tc: ac.v };
            prefix = `${fmt(aw.v)} Tw ${fmt(ac.v)} Tc `;
          }
        }
        if (op.op !== "Tj") {
          td(0, -gs.tl);
          prefix += "T* ";
        }
        const s = op.args[op.args.length - 1];
        if (s?.k !== "str") break;
        const els: El[] = [];
        if (show(s.b, els)) replace.set(op, prefix + emitTJ(els));
        break;
      }
      case "TJ": {
        const arr = op.args[op.args.length - 1];
        if (arr?.k !== "arr") break;
        const els: El[] = [];
        let changed = false;
        for (const it of arr.items) {
          if (it.k === "num") {
            const last = els[els.length - 1];
            if (last && "n" in last) last.n += it.v;
            else els.push({ n: it.v });
            tm = mul([1, 0, 0, 1, (-it.v / 1000) * gs.tfs * gs.th, 0], tm);
          } else if (it.k === "str") {
            if (show(it.b, els)) changed = true;
          }
        }
        if (changed) replace.set(op, emitTJ(els));
        break;
      }
      case "Do": {
        const name = op.args[op.args.length - 1];
        if (name?.k !== "name") break;
        const form = input.form(name.v);
        if (!form || !form.text) break;
        // its box on the page: any edit rect it meets may hide text we cannot rewrite
        const m = mul(form.matrix, gs.ctm);
        const [x0, y0, x1, y1] = form.bbox;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
          const [px, py] = toPage(...apply(m, x, y));
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
        grown.forEach((g, i) => {
          if (g[0] <= maxX && g[2] >= minX && g[1] <= maxY && g[3] >= minY) blocked[i] = true;
        });
        break;
      }
      default:
        break;
    }
  }

  const unresolved = rects.map((_, i) => lost || blocked[i]! || removedIn[i] === 0);
  return {
    content: replace.size ? spliceContent(input.content, replace) : null,
    unresolved,
    removed: removedAll,
  };
}

/* ======================== the page (pdf-lib) ======================== */

/** One edited box's share of a page. */
export interface PageEdit {
  rects: PageRect[];
  cover: string;
}

/** The decoded, joined content of a page; null when there is none, throws
 *  when a stream cannot be decoded. */
export function pageContent(ctx: PDFContext, page: PDFPage): Uint8Array | null {
  const c = page.node.Contents();
  if (!c) return null;
  const streams: PDFObject[] = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, i) => c.get(i)) : [c];
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    const st = lookup(ctx, s);
    if (st instanceof PDFRawStream) parts.push(decodePDFRawStream(st).decode());
    else if (st instanceof PDFStream) parts.push(st.getContents()); // made by pdf-lib, not compressed by it here
    else throw new ContentParseError("content is not a stream");
  }
  let n = 0;
  for (const p of parts) n += p.length + 1;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

function resourcesOf(page: PDFPage): PDFDict | undefined {
  return page.node.Resources();
}

/** The cover rects to paint (page space, padded), and whether the content
 *  was rewritten — the page itself is updated here. */
export function redactPage(doc: PDFDocument, page: PDFPage, geom: PageGeom, edits: PageEdit[]): { covers: { rect: PageRect; cover: string }[]; removed: number } {
  const ctx = doc.context;
  const rects: PageRect[] = [];
  const owner: number[] = [];
  edits.forEach((e, i) => {
    for (const r of e.rects) {
      rects.push(r);
      owner.push(i);
    }
  });
  if (!rects.length) return { covers: [], removed: 0 };
  const res = resourcesOf(page);
  const sub = (k: string): PDFDict | undefined => {
    const d = res ? lookup(ctx, res.get(PDFName.of(k))) : undefined;
    return d instanceof PDFDict ? d : undefined;
  };
  const fontDict = sub("Font");
  const xobjects = sub("XObject");

  let result: RedactResult;
  if (rects.length > PAGE_MAX_EDIT_RECTS) {
    result = { content: null, unresolved: rects.map(() => true), removed: 0 };
  } else try {
    const content = pageContent(ctx, page);
    result = content
      ? redactContent({
          content,
          rects,
          geom,
          font: (name) => {
            const d = fontDict ? lookup(ctx, fontDict.get(PDFName.of(name))) : undefined;
            return d instanceof PDFDict ? fontInfoOf(ctx, d) : null;
          },
          form: (name) => {
            const x = xobjects ? lookup(ctx, xobjects.get(PDFName.of(name))) : undefined;
            if (!(x instanceof PDFStream)) return null;
            if (nameOf(ctx, x.dict.get(PDFName.of("Subtype"))) !== "Form") return null;
            const bbox = numsOf(ctx, x.dict.get(PDFName.of("BBox")));
            if (!bbox || bbox.length !== 4) return { bbox: [-1e9, -1e9, 1e9, 1e9], matrix: ID, text: true };
            const m = numsOf(ctx, x.dict.get(PDFName.of("Matrix")));
            const r = lookup(ctx, x.dict.get(PDFName.of("Resources")));
            // a form with its own resources and no fonts draws no text
            const fonts = r instanceof PDFDict ? lookup(ctx, r.get(PDFName.of("Font"))) : undefined;
            const text = !(r instanceof PDFDict) || (fonts instanceof PDFDict && fonts.keys().length > 0);
            return {
              bbox: [Math.min(bbox[0]!, bbox[2]!), Math.min(bbox[1]!, bbox[3]!), Math.max(bbox[0]!, bbox[2]!), Math.max(bbox[1]!, bbox[3]!)],
              matrix: m && m.length === 6 ? (m as Matrix) : ID,
              text,
            };
          },
        })
      : { content: null, unresolved: rects.map(() => true), removed: 0 };
  } catch {
    result = { content: null, unresolved: rects.map(() => true), removed: 0 };
  }
  if (result.content) {
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(result.content)));
  }
  const covers: { rect: PageRect; cover: string }[] = [];
  result.unresolved.forEach((u, i) => {
    if (!u) return;
    const [x, y, w, h] = rects[i]!;
    covers.push({ rect: [x - EDIT_SLOP, y - EDIT_SLOP, w + 2 * EDIT_SLOP, h + 2 * EDIT_SLOP], cover: edits[owner[i]!]!.cover });
  });
  return { covers, removed: result.removed };
}

/** Paint `covers` (page space) over the page's content — the content wrapped
 *  in q/Q first, so a stream that leaves its state changed cannot move them. */
export function drawCovers(doc: PDFDocument, page: PDFPage, geom: PageGeom, covers: { rect: PageRect; cover: string }[]): void {
  if (!covers.length) return;
  const ctx = doc.context;
  const ops: string[] = ["q"];
  let last = "";
  for (const { rect, cover } of covers) {
    const m = /^#([0-9a-f]{6})$/i.exec(cover);
    const v = m ? parseInt(m[1]!, 16) : 0xffffff;
    const rg = `${fmt(((v >> 16) & 255) / 255)} ${fmt(((v >> 8) & 255) / 255)} ${fmt((v & 255) / 255)} rg`;
    if (rg !== last) ops.push(rg);
    last = rg;
    const [x, y, w, h] = rect;
    ops.push(`${fmt(geom.x + x)} ${fmt(geom.y + geom.h - y - h)} ${fmt(w)} ${fmt(h)} re f`);
  }
  ops.push("Q");
  page.node.wrapContentStreams(ctx.register(ctx.stream("q\n")), ctx.register(ctx.stream("\nQ\n")));
  page.node.addContentStream(ctx.register(ctx.flateStream(ops.join("\n"))));
}
