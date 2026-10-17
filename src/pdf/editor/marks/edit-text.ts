// "Edit text": turn a run of the PAGE'S OWN text into an editable text box.
// The picking half: the page's pdf.js text (cached per document + page by the
// view's search, shared with the text layer) is grouped into lines once per
// page (view/text-lines.ts); a click picks one line, a drag every line it
// touches, merged into one paragraph. Font comes from what pdf.js tells the
// main thread, colours from the rendered canvas. Nothing here commits: the
// caller places the returned mark (one history step) and opens the editor.
// No work at rest; a hover miss costs one O(lines) hit test.

import type { FontFamily, PdfTextEdit } from "../../../core/types";
import type { PageRect, PdfDoc } from "../../types";
import { pageText } from "../../view/search";
import { buildLines, lineAt, linesIn, mapFont, paragraphAround, paragraphOf, type FontInfoLite, type TextLine } from "../../view/text-lines";
import type { Env } from "./env";

/** The text under a point (or inside a dragged box), ready to become a mark. */
export interface EditCandidate {
  /** page key (PdfPage.id) */
  key: string;
  /** the text, lines joined with "\n", in logical (reading) order */
  text: string;
  /** the box the new text mark gets, page space (covers every rect) */
  box: PageRect;
  /** what it replaces: glyph rects, sampled page colour behind them, original text */
  edit: PdfTextEdit;
  /** closest whitelisted look */
  font: FontFamily;
  /** points */
  size: number;
  bold: boolean;
  italic: boolean;
  /** sampled text colour, #rrggbb */
  color: string;
  align: "left" | "center" | "right";
}

interface PageLines {
  lines: TextLine[];
  styles: Record<string, { fontFamily?: string }>;
}

const lineCache = new WeakMap<PdfDoc, Map<number, Promise<PageLines>>>();
type Colours = { ink: string; paper: string };
/** a click's sampled colours by the clicked line, per pick mode (hover
 *  re-asks the same line often) */
const colourMemo = { line: new WeakMap<TextLine, Colours>(), para: new WeakMap<TextLine, Colours>() };

function pageLines(doc: PdfDoc, index: number): Promise<PageLines> {
  let perDoc = lineCache.get(doc);
  if (!perDoc) lineCache.set(doc, (perDoc = new Map()));
  let p = perDoc.get(index);
  if (!p) {
    const map = perDoc;
    p = pageText(doc, index).then((e) => ({
      lines: buildLines(e.items, e.view, e.content.styles),
      styles: e.content.styles as PageLines["styles"],
    }));
    p.catch(() => map.delete(index));
    map.set(index, p);
  }
  return p;
}

/** The source document page behind a page key, or null (blank page, gone). */
function sourceOf(env: Env, key: string): { doc: PdfDoc; index: number } | null {
  const page = env.ctx.session.project.pdf?.pages.find((p) => p.id === key);
  if (!page || page.src === null) return null;
  const doc = env.ctx.docs.get(page.src);
  return doc ? { doc, index: page.page } : null;
}

interface FontObjLite {
  loadedName?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  systemFontInfo?: { baseFontName?: string; style?: { style?: string; weight?: string | number } } | null;
}

/** What the main thread knows about a pdf.js font: the styles entry always;
 *  the loaded font object once the page has been rendered (commonObjs). */
async function fontInfo(doc: PdfDoc, index: number, fontName: string | undefined, styles: PageLines["styles"]): Promise<FontInfoLite> {
  const info: FontInfoLite = { family: fontName ? styles[fontName]?.fontFamily : undefined };
  if (!fontName) return info;
  try {
    const page = (await (doc.doc as { getPage(n: number): Promise<unknown> }).getPage(index + 1)) as {
      commonObjs?: { has(id: string): boolean; get(id: string): unknown };
    };
    const objs = page.commonObjs;
    if (objs?.has(fontName)) {
      const f = objs.get(fontName) as FontObjLite | null;
      if (f && typeof f === "object") {
        info.names = [f.loadedName, f.systemFontInfo?.baseFontName];
        info.bold = f.bold;
        info.black = f.black;
        info.italic = f.italic;
        info.weight = f.systemFontInfo?.style?.weight;
        info.style = f.systemFontInfo?.style?.style;
      }
    }
  } catch {
    /* the styles entry alone */
  }
  return info;
}

async function candidate(
  env: Env,
  key: string,
  src: { doc: PdfDoc; index: number },
  picked: TextLine[],
  styles: PageLines["styles"],
  memo?: { map: WeakMap<TextLine, Colours>; line: TextLine; soft: boolean },
): Promise<EditCandidate | null> {
  const para = paragraphOf(picked, { soft: memo?.soft === true });
  if (!para) return null;
  let colours = memo?.map.get(memo.line);
  if (!colours) {
    colours = env.ctx.view.samplePage?.(key, para.box) ?? undefined;
    if (!colours) return null;
    memo?.map.set(memo.line, colours);
  }
  const look = mapFont(await fontInfo(src.doc, src.index, para.fontName, styles));
  return {
    key,
    text: para.text,
    box: para.box,
    edit: { rects: para.rects, cover: colours.paper, orig: para.text },
    font: look.font,
    size: para.size,
    bold: look.bold,
    italic: look.italic,
    color: colours.ink,
    align: para.rtl ? "right" : "left",
  };
}

/** The PARAGRAPH of page text around the line under a client point (wrapped
 *  lines joined with a space, so the box reflows at the column width), or
 *  with `opts.line` (Alt+click) just that line; null when there is no text
 *  there or the page is not rendered. */
export async function pickTextAt(
  env: Env,
  key: string,
  clientX: number,
  clientY: number,
  opts?: { line?: boolean },
): Promise<EditCandidate | null> {
  const pt = env.pt(key, { clientX, clientY });
  const src = pt ? sourceOf(env, key) : null;
  if (!pt || !src) return null;
  const { lines, styles } = await pageLines(src.doc, src.index);
  const line = lineAt(lines, pt.x, pt.y);
  if (!line) return null;
  if (opts?.line) return candidate(env, key, src, [line], styles, { map: colourMemo.line, line, soft: false });
  return candidate(env, key, src, paragraphAround(lines, line), styles, { map: colourMemo.para, line, soft: true });
}

/** Every line of page text whose box intersects a page-space rect on `key`,
 *  merged into one paragraph candidate, or null. */
export async function pickTextIn(env: Env, key: string, rect: PageRect): Promise<EditCandidate | null> {
  const src = sourceOf(env, key);
  if (!src) return null;
  const { lines, styles } = await pageLines(src.doc, src.index);
  const picked = linesIn(lines, rect);
  return picked.length > 0 ? candidate(env, key, src, picked, styles) : null;
}
