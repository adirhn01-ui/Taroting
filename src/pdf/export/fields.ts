// Appearances for form values pdf.js could not draw. pdf.js 6.4 writes a
// text or combo field's appearance with the field's own (usually standard,
// WinAnsi) font; a value that font cannot encode — Hebrew, Cyrillic, Greek,
// Arabic, CJK, most Latin beyond Western European — makes its SAVE path give
// up: the widget is written with NO /AP and the form gets /NeedAppearances
// (pdf.js worker, TextWidgetAnnotation._getAppearance: `encodingError &&
// intent & SAVE` → `{needAppearances: true}`; this is the same in the app's
// worker as in node). Flattening then had nothing to paint, and a viewer that
// ignores /NeedAppearances showed an empty box.
//
// So every text / choice widget with a value and no usable normal appearance
// gets one drawn here, with an embedded subset of a system font (Arial covers
// Latin, Greek, Cyrillic, Hebrew): the value laid out in the widget's box the
// way pdf.js lays out its own (2 pt / 1 pt padding, /DA size or auto-fit,
// /Q alignment, /DA colour, multi-line wrapping, comb cells, /MK rotation,
// /MK background and border), right-to-left text reordered with bidi.ts, and
// Arabic (needs shaping) or characters the font lacks drawn by the browser's
// canvas, as text boxes do (raster.ts). /V is left as it is.
//
// A LIST box is the one choice pdf.js always draws — with garbage glyphs when
// an option is not WinAnsi; such an appearance (only standard, non-embedded
// fonts in it) is replaced too.

import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import type { FontFamily } from "../../core/types";
import { firstStrongRtl, hasArabic, paragraphBidi, visualLine } from "./bidi";
import type { ExportDeps } from "./deps";
import { HIDDEN, hasValue, inherited, normalAppearance, numbers, widgetTurn } from "./flatten";
import { LINE_HEIGHT, rasterScale, wrapParagraph } from "./layout";
import { embedWithMetrics, encodeVisual, isSubtype, num, type EmbeddedFont } from "./marks";

/* ---------------- field flags and entries ---------------- */

const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_COMBO = 1 << 17;
const FF_COMB = 1 << 24;

/** pdf.js's padding inside a field's box, points. */
const H_PAD = 2;
const V_PAD = 1;
/** pdf.js's line height (its LINE_FACTOR), × font size: list-box lines
 *  and the auto size of a one-line field. */
const LIST_LINE = 1.35;
/** pdf.js's list-box selection colour. */
const LIST_SELECTED = "0.600006 0.756866 0.854904 rg";

/** Fonts tried for form text, in order. */
const FORM_FONTS: FontFamily[] = ["Arial", "Segoe UI", "Times New Roman", "Courier New"];

/** Characters a standard (WinAnsi) font can show. */
const WIN_ANSI = /^[\s\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;

function text(v: PDFObject | undefined): string | null {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
}

function numberOf(v: PDFObject | undefined): number | null {
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** /DA's font size and fill colour operator ("0 g", "1 0 0 rg", "… k"). */
export function parseDA(da: string): { size: number; colour: string; rgb: [number, number, number] } {
  const tokens = da.replace(/\([^)]*\)/g, " ").trim().split(/\s+/);
  let size = 0;
  let colour = "0 g";
  let rgb: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i];
    const n = (k: number): number[] | null => {
      if (i < k) return null;
      const v = tokens.slice(i - k, i).map(Number);
      return v.every((x) => Number.isFinite(x)) ? v.map((x) => Math.min(Math.max(x, 0), 1)) : null;
    };
    if (op === "Tf") {
      const s = Number(tokens[i - 1]);
      if (Number.isFinite(s) && s >= 0) size = s;
    } else if (op === "g") {
      const v = n(1);
      if (v) {
        colour = `${num(v[0]!)} g`;
        rgb = [v[0]!, v[0]!, v[0]!];
      }
    } else if (op === "rg") {
      const v = n(3);
      if (v) {
        colour = `${v.map(num).join(" ")} rg`;
        rgb = [v[0]!, v[1]!, v[2]!];
      }
    } else if (op === "k") {
      const v = n(4);
      if (v) {
        colour = `${v.map(num).join(" ")} k`;
        const [c, m, y, k] = v as [number, number, number, number];
        rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
      }
    }
  }
  // a huge size is a crafted file, not a form: auto-fit instead
  if (size > 1000) size = 0;
  return { size, colour, rgb };
}

/** A /MK colour array as a fill or stroke operator, or "" (none / transparent). */
function colourOp(v: PDFObject | undefined, fill: boolean): string {
  if (!(v instanceof PDFArray)) return "";
  const c: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const x = v.lookup(i);
    if (!(x instanceof PDFNumber)) return "";
    c.push(Math.min(Math.max(x.asNumber(), 0), 1));
  }
  const ops = { 1: fill ? "g" : "G", 3: fill ? "rg" : "RG", 4: fill ? "k" : "K" } as Record<number, string>;
  const op = ops[c.length];
  return op ? `${c.map(num).join(" ")} ${op}` : "";
}

/** One /Opt entry: [export value, display text]. */
function options(field: PDFDict): [string, string][] {
  const opt = inherited(field, "Opt");
  const out: [string, string][] = [];
  if (!(opt instanceof PDFArray)) return out;
  for (let i = 0; i < opt.size(); i++) {
    const o = opt.lookup(i);
    if (o instanceof PDFArray && o.size() >= 2) {
      const e = text(o.lookup(0));
      const d = text(o.lookup(1));
      if (e !== null) out.push([e, d ?? e]);
    } else {
      const t = text(o);
      if (t !== null) out.push([t, t]);
    }
  }
  return out;
}

function values(v: PDFObject | undefined): string[] {
  if (v instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0; i < v.size(); i++) {
      const t = text(v.lookup(i));
      if (t !== null) out.push(t);
    }
    return out;
  }
  const t = text(v);
  if (t !== null) return [t];
  return v instanceof PDFName ? [v.decodeText()] : [];
}

/** True when every font of the appearance is a non-embedded simple font —
 *  one that can only show WinAnsi characters. */
function standardFontsOnly(doc: PDFDocument, ref: PDFRef): boolean {
  const s = doc.context.lookup(ref);
  if (!(s instanceof PDFStream)) return true;
  const res = s.dict.lookup(PDFName.of("Resources"));
  const fonts = res instanceof PDFDict ? res.lookup(PDFName.of("Font")) : undefined;
  if (!(fonts instanceof PDFDict)) return true;
  for (const [, v] of fonts.entries()) {
    const f = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (!(f instanceof PDFDict)) continue;
    const sub = f.lookup(PDFName.of("Subtype"));
    if (sub instanceof PDFName && sub.asString() === "/Type0") return false;
    const fd = f.lookup(PDFName.of("FontDescriptor"));
    if (fd instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some((k) => fd.has(PDFName.of(k)))) return false;
  }
  return true;
}

/* ---------------- the font ---------------- */

interface Face {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  hasGlyphForCodePoint(cp: number): boolean;
  layout(s: string): { advanceWidth: number };
}

interface FormFont {
  family: FontFamily;
  face: Face;
  /** em */
  ascent: number;
  descent: number;
  width(s: string, size: number): number;
  /** every non-space character has a glyph */
  covers(s: string): boolean;
  embed(): Promise<EmbeddedFont>;
}

async function loadFormFont(doc: PDFDocument, deps: ExportDeps): Promise<FormFont | null> {
  for (const family of FORM_FONTS) {
    const bytes = await deps.fontBytes(family, false, false).catch(() => null);
    if (!bytes) continue;
    let face: Face;
    try {
      face = fontkit.create(bytes) as unknown as Face;
    } catch {
      continue;
    }
    const upm = face.unitsPerEm > 0 ? face.unitsPerEm : 1000;
    let embedded: Promise<EmbeddedFont> | null = null;
    return {
      family,
      face,
      ascent: Math.abs(face.ascent) / upm,
      descent: Math.abs(face.descent) / upm,
      width: (s, size) => (s ? (face.layout(s).advanceWidth / upm) * size : 0),
      covers(s) {
        for (const ch of s) {
          if (/\s/.test(ch)) continue;
          if (!face.hasGlyphForCodePoint(ch.codePointAt(0)!)) return false;
        }
        return true;
      },
      embed: () => (embedded ??= embedWithMetrics(doc, bytes)),
    };
  }
  return null;
}

/* ---------------- one widget ---------------- */

interface Widget {
  dict: PDFDict;
  /** unrotated box, user space */
  w: number;
  h: number;
  turn: number;
  kind: "text" | "combo" | "list";
  flags: number;
  /** what is drawn: the value (display text for a combo) */
  value: string;
  /** list box: every option's display text, and which are selected */
  list?: { display: string[]; selected: number[]; top: number };
  da: ReturnType<typeof parseDA>;
  q: 0 | 1 | 2;
  maxLen: number;
}

/** The widget's drawing data, or null when there is nothing to draw. */
function readWidget(acro: PDFDict, a: PDFDict): Widget | null {
  const ft = inherited(a, "FT");
  if (!(ft instanceof PDFName)) return null;
  const isText = ft.asString() === "/Tx";
  if (!isText && ft.asString() !== "/Ch") return null;
  const v = inherited(a, "V");
  if (!hasValue(v)) return null;
  const rect = numbers(a.lookup(PDFName.of("Rect")), 4);
  if (!rect) return null;
  const w = Math.abs(rect[2]! - rect[0]!);
  const h = Math.abs(rect[3]! - rect[1]!);
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w * h)) return null;
  const flags = numberOf(inherited(a, "Ff")) ?? 0;
  if (isText && flags & FF_PASSWORD) return null; // pdf.js shows no value either
  const daRaw = text(inherited(a, "DA")) ?? text(acro.lookup(PDFName.of("DA"))) ?? "";
  const qRaw = numberOf(inherited(a, "Q")) ?? numberOf(acro.lookup(PDFName.of("Q"))) ?? 0;
  const q = qRaw === 1 || qRaw === 2 ? qRaw : 0;
  const base = {
    dict: a,
    w,
    h,
    turn: widgetTurn(a),
    flags,
    da: parseDA(daRaw),
    q,
    maxLen: Math.trunc(numberOf(inherited(a, "MaxLen")) ?? 0),
  } as const;
  const vals = values(v);
  if (isText) {
    const value = vals[0];
    if (!value?.trim()) return null;
    return { ...base, kind: "text", value };
  }
  const opts = options(a);
  if (flags & FF_COMBO) {
    const value = vals[0];
    if (!value?.trim()) return null;
    const display = opts.find(([e]) => e === value)?.[1] ?? value;
    return { ...base, kind: "combo", value: display };
  }
  const display = opts.length ? opts.map(([, d]) => d) : vals;
  const selected: number[] = [];
  (opts.length ? opts.map(([e]) => e) : vals).forEach((e, i) => {
    if (vals.includes(e)) selected.push(i);
  });
  const top = Math.max(0, Math.trunc(numberOf(inherited(a, "TI")) ?? 0));
  return { ...base, kind: "list", value: display.join("\n"), list: { display, selected, top } };
}

/** pdf.js's /Matrix for a widget turned by `turn` (its getRotationMatrix). */
function rotationMatrix(turn: number, w: number, h: number): number[] | null {
  switch (turn) {
    case 90:
      return [0, 1, -1, 0, w, 0];
    case 180:
      return [-1, 0, 0, -1, w, h];
    case 270:
      return [0, -1, 1, 0, 0, h];
    default:
      return null;
  }
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

interface Drawn {
  ops: string;
  resources: Record<string, unknown>;
}

/** The appearance content of `wd` in its upright W×H frame, or null. */
async function drawWidget(doc: PDFDocument, deps: ExportDeps, font: FormFont, wd: Widget): Promise<Drawn | null> {
  const [W, H] = wd.turn === 90 || wd.turn === 270 ? [wd.h, wd.w] : [wd.w, wd.h];
  const mk = wd.dict.lookup(PDFName.of("MK"));
  const bg = mk instanceof PDFDict ? colourOp(mk.lookup(PDFName.of("BG")), true) : "";
  const bc = mk instanceof PDFDict ? colourOp(mk.lookup(PDFName.of("BC")), false) : "";
  const bs = wd.dict.lookup(PDFName.of("BS"));
  const bwRaw = bs instanceof PDFDict ? numberOf(bs.lookup(PDFName.of("W"))) : null;
  const bw = bwRaw !== null && bwRaw >= 0 && bwRaw < Math.min(W, H) / 2 ? bwRaw : 1;
  let frame = "";
  if (bg) frame += `${bg} 0 0 ${num(W)} ${num(H)} re f `;
  if (bc && bw > 0) frame += `${num(bw)} w ${bc} ${num(bw / 2)} ${num(bw / 2)} ${num(W - bw)} ${num(H - bw)} re S `;

  const asc = font.ascent;
  const desc = font.descent;
  const innerW = Math.max(W - 2 * H_PAD, 1);
  const innerH = Math.max(H - 2 * V_PAD, 1);
  const multiline = wd.kind === "text" && !!(wd.flags & FF_MULTILINE);
  const value = multiline ? wd.value : wd.value.replace(/\r\n|\r|\n/g, " ");
  const comb =
    wd.kind === "text" && !!(wd.flags & FF_COMB) && !multiline && wd.maxLen > 0 && [...value].length <= wd.maxLen && !RTL.test(value);
  const raster = hasArabic(wd.value) || !font.covers(wd.value);

  // the font size
  let size = wd.da.size;
  let lines: { para: string; bidi: ReturnType<typeof paragraphBidi>; s: number; e: number }[] = [];
  const wrap = (sz: number): typeof lines => {
    const out: typeof lines = [];
    for (const para of value.split(/\r\n|\r|\n/)) {
      const bidi = paragraphBidi(para);
      for (const [s, e] of wrapParagraph(para, innerW, (t) => font.width(t, sz))) out.push({ para, bidi, s, e });
    }
    return out;
  };
  if (wd.kind === "list") {
    const n = Math.max(wd.list!.display.length, 1);
    if (!(size > 0)) {
      const widest = Math.max(...wd.list!.display.map((d) => font.width(d, 1)), 0);
      size = Math.min((H - V_PAD) / n / LIST_LINE, widest > 0 ? innerW / widest : Infinity);
    }
  } else if (comb) {
    if (!(size > 0)) {
      const cell = W / wd.maxLen;
      const widest = Math.max(...[...value].map((c) => font.width(c, 1)), 0);
      size = Math.min(innerH / LIST_LINE, widest > 0 ? (cell * 0.9) / widest : Infinity);
    }
  } else if (multiline) {
    if (!(size > 0)) {
      size = 12;
      while (size > 4 && wrap(size).length * size * LINE_HEIGHT > innerH) size -= 0.5;
    }
  } else if (!(size > 0)) {
    const tw = font.width(value, 1);
    size = Math.min(innerH / LIST_LINE, tw > 0 ? innerW / tw : Infinity);
  }
  if (!(size > 0) || !Number.isFinite(size)) return null;
  size = Math.max(Math.min(size, 1000), 0.5);

  const clip = `${num(1)} ${num(1)} ${num(Math.max(W - 2, 0.5))} ${num(Math.max(H - 2, 0.5))} re W n`;

  if (raster) {
    // Arabic needs shaping, and characters the font lacks need the browser's
    // fallback fonts: the canvas draws them (see raster.ts)
    const lh = size * LINE_HEIGHT;
    const boxH = multiline || wd.kind === "list" ? innerH : Math.min(lh, innerH);
    const rtl = firstStrongRtl(value);
    const align: "left" | "center" | "right" = wd.q === 1 ? "center" : wd.q === 2 ? "right" : rtl && wd.kind === "list" ? "right" : "left";
    const hex = `#${wd.da.rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    const png = await deps.rasterizeText({
      text: wd.kind === "list" ? wd.list!.display.join("\n") : value,
      font: font.family,
      bold: false,
      italic: false,
      size,
      color: hex,
      align,
      w: innerW,
      h: boxH,
      scale: rasterScale(innerW, boxH),
      lineHeight: lh,
    });
    const img = await doc.embedPng(png);
    const y0 = multiline || wd.kind === "list" ? H - V_PAD - boxH : (H - boxH) / 2;
    return {
      ops: `/Tx BMC q ${frame}${clip} ${num(innerW)} 0 0 ${num(boxH)} ${num(H_PAD)} ${num(y0)} cm /Im0 Do Q EMC`,
      resources: { XObject: { Im0: img.ref } },
    };
  }

  const emb = await font.embed();
  const f = emb.font;
  const shows: string[] = [];
  const show = (visual: string, x: number, y: number): void => {
    if (visual) shows.push(`1 0 0 1 ${num(x)} ${num(y)} Tm ${encodeVisual(f, visual)} Tj`);
  };
  const alignX = (lw: number, rtl: boolean): number => {
    if (wd.q === 1) return (W - lw) / 2;
    if (wd.q === 2) return W - H_PAD - lw;
    // a list box has no /Q of its own in practice: its RTL options read from the right
    return rtl && wd.kind === "list" ? W - H_PAD - lw : H_PAD;
  };
  let under = "";
  if (wd.kind === "list") {
    const { display, selected } = wd.list!;
    const lh = size * LIST_LINE;
    const visible = Math.max(1, Math.floor(H / lh));
    let first = Math.min(wd.list!.top, Math.max(display.length - 1, 0));
    if (selected.length) {
      const lo = Math.min(...selected);
      const hi = Math.max(...selected);
      first = Math.min(Math.max(hi - visible + 1, 0), lo);
    }
    const end = Math.min(first + visible + 1, display.length);
    const boxes = selected.filter((i) => i >= first && i < end).map((i) => `1 ${num(H - (i - first + 1) * lh)} ${num(W - 2)} ${num(lh)} re`);
    if (boxes.length) under = `${LIST_SELECTED} ${boxes.join(" ")} f `;
    for (let i = first; i < end; i++) {
      const d = display[i]!.replace(/\r\n|\r|\n/g, " ");
      const bidi = paragraphBidi(d);
      const visual = visualLine(bidi, 0, d.length);
      const base = H - (i - first) * lh - (lh - (asc + desc) * size) / 2 - asc * size;
      show(visual, alignX(font.width(visual, size), firstStrongRtl(d)), base);
    }
  } else if (comb) {
    const cell = W / wd.maxLen;
    const base = (H - (asc + desc) * size) / 2 + desc * size;
    // comb cells fill from the left (Acrobat and pdf.js ignore /Q here)
    [...value].forEach((ch, i) => show(ch, i * cell + (cell - font.width(ch, size)) / 2, base));
  } else if (multiline) {
    lines = wrap(size);
    const lh = size * LINE_HEIGHT;
    lines.forEach((ln, row) => {
      const base = H - V_PAD - row * lh - (lh - (asc + desc) * size) / 2 - asc * size;
      if (base + asc * size < 0) return; // below the box: clipped anyway
      const visual = visualLine(ln.bidi, ln.s, ln.e);
      show(visual, alignX(font.width(visual, size), false), base);
    });
  } else {
    const bidi = paragraphBidi(value);
    const visual = visualLine(bidi, 0, value.length);
    const base = (H - (asc + desc) * size) / 2 + desc * size;
    show(visual, alignX(font.width(visual, size), false), base);
  }
  if (!shows.length) return null;
  return {
    ops: `/Tx BMC q ${frame}${clip} ${under}BT /F0 ${num(size)} Tf ${wd.da.colour} ${shows.join(" ")} ET Q EMC`,
    resources: { Font: { F0: f.ref } },
  };
}

/* ---------------- the pass ---------------- */

/** Draw an appearance for every text / choice widget whose value has none
 *  (or, for a list box, only an undrawable one). Returns how many widgets
 *  still have a value and no appearance (no usable font was found). */
export async function drawMissingFieldAppearances(
  doc: PDFDocument,
  deps: ExportDeps,
  tick: () => Promise<void> = async () => {},
): Promise<{ drawn: number; left: number }> {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return { drawn: 0, left: 0 };
  const ctx = doc.context;
  let font: FormFont | null | undefined;
  let drawn = 0;
  let left = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const a = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (!(a instanceof PDFDict) || !isSubtype(a, "Widget")) continue;
      const flags = a.lookup(PDFName.of("F"));
      if (flags instanceof PDFNumber && flags.asNumber() & HIDDEN) continue;
      const wd = readWidget(acro, a);
      if (!wd) continue;
      const have = normalAppearance(doc, a);
      if (have) {
        const undrawable = wd.kind === "list" && !WIN_ANSI.test(wd.value) && standardFontsOnly(doc, have);
        if (!undrawable) continue;
      }
      await tick();
      if (font === undefined) font = await loadFormFont(doc, deps);
      const app = font ? await drawWidget(doc, deps, font, wd) : null;
      if (!app) {
        if (!have) left++;
        continue;
      }
      const [W, H] = wd.turn === 90 || wd.turn === 270 ? [wd.h, wd.w] : [wd.w, wd.h];
      const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Form", FormType: 1, BBox: [0, 0, W, H], Resources: app.resources };
      const m = rotationMatrix(wd.turn, wd.w, wd.h);
      if (m) dict["Matrix"] = m;
      const ref = ctx.register(ctx.flateStream(app.ops, dict as never));
      a.set(PDFName.of("AP"), ctx.obj({ N: ref }));
      drawn++;
    }
  }
  return { drawn, left };
}

/** Drop the form's /NeedAppearances once every widget has an appearance of
 *  its own (call after drawMissingFieldAppearances reported none left): the
 *  flag makes pdf.js — the app's own viewer included — and Acrobat redraw
 *  every field with their own fonts and ignore the drawn appearances. Kept
 *  while any visible widget, a button included, still has no /AP. */
export function clearNeedAppearances(doc: PDFDocument): boolean {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict) || !acro.has(PDFName.of("NeedAppearances"))) return false;
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const a = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (!(a instanceof PDFDict) || !isSubtype(a, "Widget")) continue;
      const flags = a.lookup(PDFName.of("F"));
      if (flags instanceof PDFNumber && flags.asNumber() & HIDDEN) continue;
      if (!(a.lookup(PDFName.of("AP")) instanceof PDFDict)) return false;
    }
  }
  acro.delete(PDFName.of("NeedAppearances"));
  return true;
}
