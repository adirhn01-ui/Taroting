// The page thumbnail rail (PdfThumbRail, ../types.ts). A vertical listbox of
// small page images with the page number under each. Images render lazily
// and at LOW priority: only items near the rail's own viewport (an
// IntersectionObserver), one at a time, each started from an idle callback, so
// the strip's pages — which share the worker — never wait behind a flick
// through the rail. Rendered images are cached (a few dozen small canvases,
// LRU) so scrolling back and forth or a setPages after a page op re-uses them.
// Editor-only extras: Ctrl/Shift multi-select through the selection store,
// drag to reorder with a drop line, a context-menu callback.

import type { PdfRotation } from "../../core/types";
import type { PdfDoc, PdfThumbRail, PdfThumbRailOptions, PdfViewPage } from "../types";
import { boxSize, displayRotation, nextSelection, reorderKeys, DEFAULT_PAGE_H, DEFAULT_PAGE_W } from "./math";
import { loadPdfjs, pdfjsNow } from "./pdfjs";

/** CSS px width a thumbnail is painted at. */
export const THUMB_W = 120;
/** Thumbnails paint at most 2 device px per CSS px. */
const THUMB_MAX_DPR = 2;
/** Cached thumbnail canvases (each ≤ 240×~340 px). */
const THUMB_CACHE = 80;
/** Pointer travel beyond which a press on a thumbnail is a drag. */
const DRAG_SLOP = 6;

interface Item {
  page: PdfViewPage;
  el: HTMLDivElement;
  img: HTMLDivElement;
  near: boolean;
  /** the cache key of the image it shows ("" = none) */
  shows: string;
  /** its page size has been asked for (lazily, once it comes near) */
  measured: boolean;
}

const docIds = new WeakMap<PdfDoc, number>();
let nextDocId = 1;
const cacheKey = (p: PdfViewPage): string => {
  if (!p.doc) return "";
  let id = docIds.get(p.doc);
  if (id === undefined) docIds.set(p.doc, (id = nextDocId++));
  return `${id}:${p.index}@${p.rotate}`;
};

type PageLike = {
  rotate: number;
  getViewport(o: { scale: number; rotation: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void>; cancel(): void };
  cleanup(): boolean;
};

export function createThumbRail(opts: PdfThumbRailOptions): PdfThumbRail {
  const el = document.createElement("div");
  el.className = "pdfv-rail";
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", "Pages");
  el.tabIndex = 0;
  if (opts.selection) el.setAttribute("aria-multiselectable", "true");
  const list = document.createElement("div");
  list.className = "pdfv-rail__list";
  el.appendChild(list);
  const dropLine = document.createElement("div");
  dropLine.className = "pdfv-rail__drop";

  let items: Item[] = [];
  let current = -1;
  let focus = 0;
  let anchor = -1;
  let disposed = false;
  const cache = new Map<string, HTMLCanvasElement>();
  const queue = new Set<Item>();
  let idle = 0;
  let idleIsTimeout = false;
  let running: { cancel(): void } | null = null;
  const railId = `pdfv-rail-${Math.random().toString(36).slice(2, 8)}`;

  /* ------------------------------ images ------------------------------ */

  const io = new IntersectionObserver(
    (entries) => {
      if (disposed) return;
      for (const e of entries) {
        const it = items[Number((e.target as HTMLElement).dataset.slot)];
        if (!it || it.el !== e.target) continue;
        it.near = e.isIntersecting;
        if (it.near) {
          measure(it);
          want(it);
        } else queue.delete(it);
      }
      schedule();
    },
    { root: el, rootMargin: "300px 0px" },
  );

  function want(it: Item): void {
    const k = cacheKey(it.page);
    if (!k || it.shows === k) return;
    const hit = cache.get(k);
    if (hit) {
      cache.delete(k);
      cache.set(k, hit); // LRU touch
      attach(it, hit, k);
      return;
    }
    queue.add(it);
  }

  function attach(it: Item, canvas: HTMLCanvasElement, k: string): void {
    // one canvas can only sit in one place: a page shown twice gets a copy
    let c = canvas;
    if (c.parentElement && c.parentElement !== it.img) {
      const copy = document.createElement("canvas");
      copy.width = c.width;
      copy.height = c.height;
      copy.getContext("2d")?.drawImage(c, 0, 0);
      c = copy;
    }
    c.className = "pdfv-thumb__canvas";
    it.img.textContent = "";
    it.img.appendChild(c);
    it.shows = k;
  }

  function schedule(): void {
    if (idle || running || queue.size === 0 || disposed) return;
    if (typeof requestIdleCallback === "function") {
      idleIsTimeout = false;
      idle = requestIdleCallback(runOne, { timeout: 300 });
    } else {
      idleIsTimeout = true;
      idle = window.setTimeout(runOne, 30);
    }
  }

  function runOne(): void {
    idle = 0;
    if (disposed) return;
    // nearest the current page first (the rail follows it)
    let best: Item | null = null;
    let bestD = Infinity;
    for (const it of queue) {
      const d = Math.abs(items.indexOf(it) - Math.max(0, current));
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    if (!best) return;
    queue.delete(best);
    void renderThumb(best).finally(() => {
      running = null;
      schedule();
    });
  }

  async function renderThumb(it: Item): Promise<void> {
    const doc = it.page.doc;
    const k = cacheKey(it.page);
    if (!doc || !k) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    running = {
      cancel(): void {
        cancelled = true;
        task?.cancel();
      },
    };
    let page: PageLike | null = null;
    try {
      const pdfjs = pdfjsNow() ?? (await loadPdfjs());
      page = (await (doc.doc as { getPage(n: number): Promise<PageLike> }).getPage(it.page.index + 1)) as PageLike;
      if (cancelled || disposed) return;
      const rotation = displayRotation(page.rotate, it.page.rotate);
      const vp1 = page.getViewport({ scale: 1, rotation });
      const dpr = Math.min(THUMB_MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
      const scale = vp1.width > 0 ? (THUMB_W * dpr) / vp1.width : 1;
      const vp = page.getViewport({ scale, rotation });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const t = page.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE });
      task = t;
      try {
        await t.promise;
      } catch {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      if (cancelled || disposed) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      cache.set(k, canvas);
      trimCache();
      if (items.includes(it) && cacheKey(it.page) === k) attach(it, canvas, k);
      // another item showing the same page (a duplicate) takes it too
      for (const o of items) if (o !== it && o.near && o.shows !== k && cacheKey(o.page) === k) want(o);
    } catch {
      it.el.classList.add("pdfv-thumb--error");
    } finally {
      // The thumbnail is a bitmap now: drop the page's operator list, fonts
      // and images. The proxy is the one the strip uses too; pdf.js defers
      // this while any render on it is still running.
      page?.cleanup();
    }
  }

  function trimCache(): void {
    while (cache.size > THUMB_CACHE) {
      const [k, c] = cache.entries().next().value as [string, HTMLCanvasElement];
      cache.delete(k);
      const holder = items.find((i) => i.shows === k && i.img.contains(c));
      if (holder?.near) {
        // still on screen: keep showing it, it just isn't cached any more
        continue;
      }
      c.remove();
      c.width = 0;
      c.height = 0;
      if (holder) holder.shows = "";
    }
  }

  /* ------------------------------ items ------------------------------ */

  function sizeItem(it: Item, w: number, h: number, rot: PdfRotation): void {
    const b = boxSize(w, h, rot, 1);
    it.img.style.aspectRatio = `${b.W} / ${b.H}`;
  }

  function measure(it: Item): void {
    const doc = it.page.doc;
    if (it.measured || !doc) return;
    it.measured = true;
    const rotate = it.page.rotate;
    void doc
      .pageInfo(it.page.index)
      .then((info) => {
        if (!disposed && items.includes(it)) sizeItem(it, info.w, info.h, displayRotation(info.rotate, rotate));
      })
      .catch(() => {
        it.measured = false;
      });
  }

  function build(pages: PdfViewPage[]): void {
    for (const it of items) io.unobserve(it.el);
    queue.clear();
    running?.cancel();
    list.textContent = "";
    const frag = document.createDocumentFragment();
    items = pages.map((p, i) => {
      const row = document.createElement("div");
      row.className = "pdfv-thumb";
      row.id = `${railId}-${i}`;
      row.dataset.slot = String(i);
      row.setAttribute("role", "option");
      row.setAttribute("aria-label", `Page ${i + 1}`);
      row.setAttribute("aria-selected", "false");
      const img = document.createElement("div");
      img.className = p.doc ? "pdfv-thumb__img" : "pdfv-thumb__img pdfv-thumb__img--blank";
      const num = document.createElement("div");
      num.className = "pdfv-thumb__num";
      num.textContent = String(i + 1);
      num.setAttribute("aria-hidden", "true");
      row.append(img, num);
      frag.appendChild(row);
      const it: Item = { page: p, el: row, img, near: false, shows: "", measured: false };
      if (p.doc) {
        // an estimate until the item comes near (measure): asking every page
        // up front would queue a GetPage per page ahead of the strip's first
        sizeItem(it, DEFAULT_PAGE_W, DEFAULT_PAGE_H, displayRotation(0, p.rotate));
      } else {
        sizeItem(it, p.w ?? DEFAULT_PAGE_W, p.h ?? DEFAULT_PAGE_H, p.rotate);
      }
      return it;
    });
    list.appendChild(frag);
    for (const it of items) io.observe(it.el);
    focus = Math.min(focus, Math.max(0, items.length - 1));
    paintSelection();
    paintCurrent(-1);
  }

  function paintCurrent(prev: number): void {
    items[prev]?.el.classList.remove("pdfv-thumb--current");
    const it = items[current];
    if (!it) return;
    it.el.classList.add("pdfv-thumb--current");
  }

  function paintSelection(): void {
    const sel = new Set(opts.selection?.get() ?? []);
    items.forEach((it, i) => {
      const on = opts.selection ? sel.has(i) : i === current;
      it.el.setAttribute("aria-selected", on ? "true" : "false");
      it.el.classList.toggle("pdfv-thumb--selected", opts.selection ? sel.has(i) && sel.size > 1 : false);
    });
    if (items[focus]) el.setAttribute("aria-activedescendant", items[focus]!.el.id);
  }

  const unsubSel = opts.selection?.subscribe(() => {
    if (!disposed) paintSelection();
  });

  /** Is item i fully inside the rail's viewport? */
  function inView(i: number): boolean {
    const it = items[i];
    if (!it) return false;
    const top = it.el.offsetTop - list.offsetTop;
    return top >= el.scrollTop && top + it.el.offsetHeight <= el.scrollTop + el.clientHeight;
  }

  function scrollIntoView(i: number): void {
    items[i]?.el.scrollIntoView({ block: "nearest" });
  }

  function setFocus(i: number): void {
    if (items.length === 0) return;
    focus = Math.max(0, Math.min(items.length - 1, i));
    for (const it of items) it.el.classList.remove("pdfv-thumb--focus");
    items[focus]!.el.classList.add("pdfv-thumb--focus");
    el.setAttribute("aria-activedescendant", items[focus]!.el.id);
    scrollIntoView(focus);
  }

  /* ------------------------------ input ------------------------------ */

  function slotOf(target: EventTarget | null): number {
    const row = (target as HTMLElement | null)?.closest?.<HTMLElement>(".pdfv-thumb");
    if (!row || !list.contains(row)) return -1;
    const i = Number(row.dataset.slot);
    return Number.isInteger(i) && items[i]?.el === row ? i : -1;
  }

  function click(i: number, mods: { ctrl: boolean; shift: boolean }): void {
    focus = i;
    if (opts.selection) {
      const next = nextSelection(opts.selection.get(), i, anchor, mods);
      if (!mods.shift) anchor = i;
      opts.selection.set(next);
      if (mods.ctrl || mods.shift) return;
    }
    opts.onPick(i);
  }

  /** The index (0..n) a pointer at clientY would insert before. */
  function dropIndexAt(clientY: number): number {
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop + list.offsetTop;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = items[mid]!.el;
      if (r.offsetTop + r.offsetHeight / 2 < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  let press: { i: number; x: number; y: number; id: number; drag: boolean; drop: number } | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const i = slotOf(e.target);
    if (i < 0) return;
    press = { i, x: e.clientX, y: e.clientY, id: e.pointerId, drag: false, drop: -1 };
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!press || e.pointerId !== press.id || !opts.onReorder) return;
    if (!press.drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_SLOP) return;
      press.drag = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add("pdfv-rail--dragging");
      list.appendChild(dropLine);
    }
    // nudge the rail when dragging past its edges (no timer: moves drive it)
    const r = el.getBoundingClientRect();
    if (e.clientY < r.top + 24) el.scrollTop -= 12;
    else if (e.clientY > r.bottom - 24) el.scrollTop += 12;
    const drop = dropIndexAt(e.clientY);
    press.drop = drop;
    const ref = items[drop]?.el;
    const last = items[items.length - 1]?.el;
    const y = ref ? ref.offsetTop - 4 : last ? last.offsetTop + last.offsetHeight + 4 : 0;
    dropLine.style.top = `${y - list.offsetTop}px`;
  };

  const endDrag = (): void => {
    el.classList.remove("pdfv-rail--dragging");
    dropLine.remove();
  };

  const onPointerUp = (e: PointerEvent): void => {
    const p = press;
    press = null;
    if (!p || e.pointerId !== p.id) return;
    if (p.drag) {
      endDrag();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      const sel = opts.selection?.get() ?? [];
      const moving = sel.includes(p.i) ? sel : [p.i];
      const keys = reorderKeys(
        items.map((it) => it.page.key),
        moving,
        p.drop,
      );
      if (keys) opts.onReorder?.(keys);
      return;
    }
    click(p.i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
  };

  const onPointerCancel = (): void => {
    if (press?.drag) endDrag();
    press = null;
  };

  function menu(i: number, at: { clientX: number; clientY: number }): void {
    if (!opts.onContextMenu) return;
    let slots = [i];
    if (opts.selection) {
      const sel = opts.selection.get();
      if (sel.includes(i)) slots = [...sel];
      else opts.selection.set([i]);
    }
    opts.onContextMenu(slots, at);
  }

  const onContextMenu = (e: MouseEvent): void => {
    const i = slotOf(e.target);
    if (i < 0 || !opts.onContextMenu) return;
    e.preventDefault();
    menu(i, { clientX: e.clientX, clientY: e.clientY });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (items.length === 0) return;
    if (e.key === "Escape" && press?.drag) {
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      press = null;
      return;
    }
    const step: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    // Keys the rail handles stop here: the viewer's shortcuts listen on the
    // window and ArrowLeft/ArrowRight there are previous/next file.
    if (e.key in step) {
      e.preventDefault();
      e.stopPropagation();
      const to = focus + step[e.key]!;
      setFocus(to);
      if (e.shiftKey && opts.selection) {
        opts.selection.set(nextSelection(opts.selection.get(), focus, anchor < 0 ? focus : anchor, { ctrl: false, shift: true }));
      }
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setFocus(e.key === "Home" ? 0 : items.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      click(focus, { ctrl: e.ctrlKey && e.key === " ", shift: false });
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const it = items[focus];
      if (!it || !opts.onContextMenu) return;
      e.preventDefault();
      e.stopPropagation();
      const r = it.el.getBoundingClientRect();
      menu(focus, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    }
  };

  const onFocus = (): void => {
    if (items[focus]) items[focus]!.el.classList.add("pdfv-thumb--focus");
  };
  const onBlur = (): void => {
    for (const it of items) it.el.classList.remove("pdfv-thumb--focus");
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("contextmenu", onContextMenu);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);

  return {
    el,
    setPages(pages: PdfViewPage[]): void {
      if (disposed) return;
      build(pages);
    },
    setCurrent(slot: number): void {
      if (disposed || slot === current) return;
      // follow the strip only while the rail isn't being browsed: when the
      // old current thumbnail was in view (or there was none)
      const follow = current < 0 || inView(current);
      const prev = current;
      current = slot;
      paintCurrent(prev);
      if (!opts.selection) {
        // single-select rail: the current page is the selected one; only the
        // old and new items change (a 2000-page rail is not walked per scroll)
        items[prev]?.el.setAttribute("aria-selected", "false");
        items[current]?.el.setAttribute("aria-selected", "true");
      }
      if (follow) scrollIntoView(slot);
      if (document.activeElement !== el) focus = Math.max(0, slot);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      io.disconnect();
      unsubSel?.();
      if (idle) {
        if (idleIsTimeout) clearTimeout(idle);
        else cancelIdleCallback(idle);
        idle = 0;
      }
      running?.cancel();
      running = null;
      queue.clear();
      for (const c of cache.values()) {
        c.width = 0;
        c.height = 0;
      }
      cache.clear();
      for (const it of items) {
        for (const c of it.img.querySelectorAll("canvas")) {
          c.width = 0;
          c.height = 0;
        }
      }
      items = [];
      el.remove();
    },
  };
}
