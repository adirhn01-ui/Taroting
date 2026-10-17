// The find bar: a small box floating at the top right of the page strip
// (Ctrl+F). Typing searches every page after a short pause; Enter / Shift+
// Enter step through the hits, Escape closes the bar and clears them. A
// newer query cancels the one still running, so a stale result never lands.
// Nothing runs while the bar is closed.

import { icon } from "../../ui/icons";
import type { PdfEditorCtx, PdfSearch, PdfSearchHit } from "../types";
import { button, el } from "./el";

export const FIND_DEBOUNCE_MS = 200;

export interface FindBar {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** the pages changed: a query that is showing is run again */
  refresh(): void;
  dispose(): void;
}

/** The hit to start on: the first one on or after the current page. */
export function firstHitFrom(hits: readonly PdfSearchHit[], keys: readonly string[], current: number): number {
  if (hits.length === 0) return -1;
  const slot = new Map(keys.map((k, i) => [k, i] as const));
  const at = hits.findIndex((h) => (slot.get(h.key) ?? -1) >= current);
  return at >= 0 ? at : 0;
}

/** "3 of 12", "No results", or "" while there is no query. */
export function countText(query: string, hits: number, active: number): string {
  if (!query.trim()) return "";
  if (hits === 0) return "No results";
  return `${active + 1} of ${hits}`;
}

export function mountFind(
  host: HTMLElement,
  ctx: PdfEditorCtx,
  search: PdfSearch,
  pageKeys: () => string[],
): FindBar {
  const input = el("input", { className: "input pdfed-find__input", attrs: { "aria-label": "Find in document", placeholder: "Find" } });
  input.type = "text";
  input.spellcheck = false;
  const count = el("span", { className: "pdfed-find__count", attrs: { "aria-live": "polite" } });
  const prev = button("btn--ghost btn--icon btn--sm pdfed-find__prev", { title: "Previous (Shift+Enter)", label: "Previous match", icon: icon("chevronLeft", 14) });
  const next = button("btn--ghost btn--icon btn--sm pdfed-find__next", { title: "Next (Enter)", label: "Next match", icon: icon("chevronRight", 14) });
  const close = button("btn--ghost btn--icon btn--sm", { title: "Close (Esc)", label: "Close find", icon: icon("x", 14) });
  const box = el("div", { className: "pdfed-find", attrs: { role: "search" } }, [input, count, prev, next, close]);
  box.hidden = true;
  host.appendChild(box);

  let isOpen = false;
  let timer = 0;
  let gen = 0;
  let hits: PdfSearchHit[] = [];
  let active = -1;
  let shownQuery = "";

  const paint = (): void => {
    const text = countText(shownQuery, hits.length, active);
    if (count.textContent !== text) count.textContent = text;
    const none = hits.length === 0;
    prev.disabled = none;
    next.disabled = none;
  };

  const show = (i: number): void => {
    active = i;
    ctx.view.setSearchHits(hits, active);
    const h = hits[active];
    if (h && h.rects[0]) ctx.view.reveal(h.key, h.rects[0]);
    paint();
  };

  const run = async (): Promise<void> => {
    timer = 0;
    const my = ++gen;
    const q = input.value;
    search.cancel();
    if (!q.trim()) {
      hits = [];
      active = -1;
      shownQuery = "";
      ctx.view.setSearchHits([], -1);
      paint();
      return;
    }
    const found = await search.find(q);
    if (my !== gen || !isOpen) return;
    hits = found;
    shownQuery = q;
    if (hits.length === 0) {
      active = -1;
      ctx.view.setSearchHits([], -1);
      paint();
      return;
    }
    show(firstHitFrom(hits, pageKeys(), ctx.view.state.get().current));
  };

  const schedule = (): void => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), FIND_DEBOUNCE_MS);
  };

  const step = (dir: 1 | -1): void => {
    if (timer) {
      // Enter before the pause ran out: search now, land on the first hit.
      window.clearTimeout(timer);
      void run();
      return;
    }
    if (hits.length === 0) return;
    show((active + dir + hits.length) % hits.length);
  };

  input.addEventListener("input", schedule);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      // the bar's own: no tool or selection behind it hears this Escape
      e.preventDefault();
      e.stopPropagation();
      api.close();
    }
  });
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  close.addEventListener("click", () => api.close());

  const api: FindBar = {
    open() {
      if (!isOpen) {
        isOpen = true;
        box.hidden = false;
      }
      input.focus();
      input.select();
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      box.hidden = true;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      gen++;
      search.cancel();
      hits = [];
      active = -1;
      shownQuery = "";
      input.value = "";
      ctx.view.setSearchHits([], -1);
      paint();
      if (document.activeElement === input) ctx.view.el.focus();
    },
    get isOpen() {
      return isOpen;
    },
    refresh() {
      if (isOpen && input.value.trim()) schedule();
    },
    dispose() {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      gen++;
      search.cancel();
      box.remove();
    },
  };
  paint();
  return api;
}
