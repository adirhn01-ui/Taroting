// Find in document. Walks every slot's text (pdf.js getTextContent, cached per
// document + page and shared with the strip's text layers), yields a macrotask
// between pages so a 300-page search never holds the UI thread, and turns each
// match into page-space rects through the same item maths the tests pin
// (math.ts matchRects). One hit per match, in display order.

import type { PdfDoc, PdfSearch, PdfSearchHit, PdfViewPage } from "../types";
import { buildPageText, findAll, matchRects, type FontStyleLite, type PageText, type TextItemLite } from "./math";

/** pdf.js TextContent, loosely (items also carry marked-content entries). */
export interface TextContentLite {
  items: unknown[];
  styles: Record<string, FontStyleLite>;
}

export interface PageTextEntry {
  /** what pdf.js returned — the strip's TextLayer renders from this */
  content: TextContentLite;
  items: TextItemLite[];
  text: PageText;
  /** the crop box, user space */
  view: number[];
}

interface PageProxyLike {
  view: number[];
  getTextContent(): Promise<TextContentLite>;
}

const cache = new WeakMap<PdfDoc, Map<number, Promise<PageTextEntry>>>();

/** One page's text, fetched once per document. */
export function pageText(doc: PdfDoc, index: number): Promise<PageTextEntry> {
  let perDoc = cache.get(doc);
  if (!perDoc) cache.set(doc, (perDoc = new Map()));
  let p = perDoc.get(index);
  if (!p) {
    const map = perDoc;
    p = (async (): Promise<PageTextEntry> => {
      const page = (await (doc.doc as { getPage(n: number): Promise<PageProxyLike> }).getPage(index + 1)) as PageProxyLike;
      const content = await page.getTextContent();
      const items = content.items.filter((it): it is TextItemLite => typeof (it as TextItemLite).str === "string");
      return { content, items, text: buildPageText(items), view: [...page.view] };
    })();
    p.catch(() => map.delete(index));
    map.set(index, p);
  }
  return p;
}

/** A macrotask turn without setTimeout's 4 ms clamp. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (): void => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** How many pages' text is requested ahead of the one being searched. */
const PREFETCH = 4;

export function createSearch(pages: () => PdfViewPage[]): PdfSearch {
  let gen = 0;

  async function find(query: string, opts?: { caseSensitive?: boolean }): Promise<PdfSearchHit[]> {
    const my = ++gen;
    const q = query.trim();
    const hits: PdfSearchHit[] = [];
    if (!q) return hits;
    const caseSensitive = opts?.caseSensitive === true;
    const slots = pages();
    const ahead = new Map<number, Promise<PageTextEntry> | null>();
    const want = (i: number): Promise<PageTextEntry> | null => {
      if (ahead.has(i)) return ahead.get(i)!;
      const s = slots[i];
      const p = s?.doc ? pageText(s.doc, s.index) : null;
      // a page that fails is skipped, never the whole search
      p?.catch(() => {});
      ahead.set(i, p);
      return p;
    };
    for (let i = 0; i < slots.length; i++) {
      for (let k = i; k < Math.min(slots.length, i + PREFETCH); k++) want(k);
      const p = want(i);
      ahead.delete(i);
      if (p) {
        let entry: PageTextEntry | null = null;
        try {
          entry = await p;
        } catch {
          entry = null;
        }
        if (my !== gen) return [];
        if (entry) {
          const key = slots[i]!.key;
          for (const [s, e] of findAll(entry.text, q, caseSensitive)) {
            const rects = matchRects(entry.items, entry.text, s, e, entry.view, entry.content.styles);
            if (rects.length > 0) hits.push({ key, rects });
          }
        }
      }
      await yieldTurn();
      if (my !== gen) return [];
    }
    return hits;
  }

  return {
    find,
    cancel(): void {
      gen++;
    },
  };
}
