// A PDF in the folder viewer: the page strip on the stage, the thumbnail rail
// on its left, "Page 2 of 9" in the top bar, and a bottom bar that trades the
// player's controls for a page scrubber, zoom and Find.
//
// LAZY: viewer.ts reaches this module only through `import("./pdf-mode")` on
// the first PDF it shows, and this module is the only one in src/viewer that
// imports src/pdf/view (pdf.js comes behind that, on first open) — a viewer
// session without a PDF loads none of it.
//
// One mount serves every PDF the user steps through in a row (the strip, the
// rail and the bars stay, only the document is swapped); stepping to anything
// else disposes it, and dispose() removes every element and listener it
// added. Nothing runs at rest: the strip and rail are idle until scrolled, the
// only timers are the find box's typing pause and the page announcement's
// trailing write, each armed only by a change.
//
// Reading only: the text layer is on (select and copy), the forms layer is
// never offered (no `forms` option) — editing is "Open as project".

import type { ActionId } from "../core/types";
import { icon } from "../ui/icons";
import { showMenu } from "../ui/menu";
import type { PdfDoc, PdfFit, PdfSearchHit, PdfViewPage } from "../pdf/types";
import { createPdfView, createSearch, createThumbRail, isPdfOpenError, openPdf } from "../pdf/view";
import { bindScrub } from "./scrub";

/** What the viewer lends the PDF mode. */
export interface PdfHost {
  /** the .viewer root: the bottom bar and the find box go here */
  root: HTMLElement;
  /** the stage: the strip and the rail go here */
  stage: HTMLElement;
  /** the top bar, and the name inside it (the rail toggle goes before the
   *  name, the page indicator after it) */
  top: HTMLElement;
  nameEl: HTMLElement;
  /** the viewer's status card ("Can't show this file" + a detail line) */
  setStatus(text: string | null, opts?: { detail?: string }): void;
  /** "Find (Ctrl+F)": a label with the action's current chord */
  withChord(label: string, action: ActionId): string;
}

/** Remembered by the viewer for its whole session, across PDF mounts. */
export interface PdfMemory {
  /** the fit the strip follows, or null for an explicit zoom */
  fit: PdfFit | null;
  /** CSS px per point (used when `fit` is null) */
  zoom: number;
  /** the rail's toggle; null until the first PDF decides from the width */
  railOpen: boolean | null;
}

export interface PdfMode {
  /** Show `path` (replacing the PDF on screen once it opens). `live` says
   *  whether the viewer still wants this file; a stale open is destroyed. */
  open(path: string, live: () => boolean): Promise<void>;
  /** Home / End */
  goPage(which: "first" | "last"): void;
  /** Ctrl+F: open (or refocus) the find box */
  find(): void;
  /** the zoom shortcuts (imgZoomIn/Out/Fit/100, shared with the editors) */
  zoom(step: "in" | "out" | "fit" | "100"): void;
  /** the strip, rail, bar or a prompt contains this node (dblclick guard) */
  owns(target: Node | null): boolean;
  /** the shortcuts changed: rewrite the tooltips that name a chord */
  retitle(): void;
  dispose(): void;
}

/** UI zoom is "100%" at 96/72 CSS px per point: a page shows at its printed
 *  size (src/pdf/types.ts). */
export const PX_PER_PT_100 = 96 / 72;

/** The zoom buttons' stops, in UI percent. */
export const ZOOM_STOPS: readonly number[] = [10, 25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600];

/** The next stop from `pct` in `dir` (the nearest strictly beyond it). */
export function nextZoomStop(pct: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STOPS.find((s) => s > pct + 0.5) ?? ZOOM_STOPS[ZOOM_STOPS.length - 1]!;
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) if (ZOOM_STOPS[i]! < pct - 0.5) return ZOOM_STOPS[i]!;
  return ZOOM_STOPS[0]!;
}

/** The scrubber: the page at a fraction of the track (0-based), and back. */
export function pageAtRatio(r: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(r * (count - 1))));
}
export function ratioOfPage(page: number, count: number): number {
  return count <= 1 ? 0 : Math.min(1, Math.max(0, page / (count - 1)));
}

/** Ctrl+wheel: the image editor's factor (src/image/view.ts wheelZoomFactor
 *  and wheelPixels, copied: importing it would pull the image chunk). */
function wheelFactor(e: WheelEvent, pagePx: number): number {
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * pagePx : e.deltaY;
  return Math.pow(2, -dy / 300);
}

/** The page indicator's screen-reader line is written this long after the
 *  last page change (a scroll through 40 pages is one announcement). */
const ANNOUNCE_MS = 700;
/** Typing pause before the find box searches. */
const FIND_DEBOUNCE_MS = 200;

// Glyphs this screen alone uses, in icon()'s exact wrapper (src/ui/icons.ts).
const svg = (body: string, size = 16): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const RAIL_ICON = svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>');
const FIND_ICON = icon("search");
const UP_ICON = svg('<path d="m18 15-6-6-6 6"/>', 14);
const DOWN_ICON = svg('<path d="m6 9 6 6 6-6"/>', 14);

const PASSWORD_HEADING = "This PDF is password-protected";
const PASSWORD_WRONG = "That password didn't work";
const CANT_SHOW = "Can't show this file";
const DETAIL_INVALID = "This PDF is damaged or isn't really a PDF.";
const DETAIL_MISSING = "This PDF is missing or can't be read.";

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs?: Record<string, string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function button(cls: string, label: string, html: string): HTMLButtonElement {
  const b = make("button", `btn btn--ghost ${cls}`, { type: "button", "aria-label": label });
  b.title = label;
  b.innerHTML = html;
  return b;
}

export function mountPdfMode(host: PdfHost, memory: PdfMemory): PdfMode {
  let disposed = false;
  /** bumped by every open() (and by dispose): an older open's answer is dropped */
  let openGen = 0;
  let doc: PdfDoc | null = null;
  let pages: PdfViewPage[] = [];
  const unbind: (() => void)[] = [];
  const timers = new Set<number>();
  const later = (fn: () => void, ms: number): number => {
    const t = window.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: number | undefined): void => {
    if (t === undefined) return;
    window.clearTimeout(t);
    timers.delete(t);
  };
  const listen = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions): void => {
    target.addEventListener(type, fn as EventListener, opts);
    unbind.push(() => target.removeEventListener(type, fn as EventListener, opts));
  };

  /* ---------------- the strip and the rail ---------------- */

  const view = createPdfView({ textLayer: true });
  const search = createSearch(() => pages);
  const rail = createThumbRail({ onPick: (slot) => view.scrollToPage(slot) });

  const wrap = make("div", "viewer__pdf", { id: "vw-pdf" });
  wrap.hidden = true;
  const railBox = make("div", "viewer__rail", { id: "vw-pdf-rail" });
  railBox.appendChild(rail.el);
  const stripBox = make("div", "viewer__pdf-strip");
  stripBox.appendChild(view.el);
  wrap.appendChild(railBox);
  wrap.appendChild(stripBox);
  host.stage.appendChild(wrap);
  host.root.classList.add("viewer--pdf");

  if (memory.fit) view.fit(memory.fit);
  else view.setZoom(memory.zoom);

  /* ---------------- top bar: rail toggle, page indicator ---------------- */

  const railBtn = button("btn--icon viewer__chrome-btn viewer__pdf-railbtn", "Pages", RAIL_ICON);
  railBtn.id = "vw-pdf-railbtn";
  host.top.insertBefore(railBtn, host.nameEl);
  const pageEl = make("span", "viewer__pdf-page", { id: "vw-pdf-page" });
  host.top.insertBefore(pageEl, host.nameEl.nextSibling);
  const pageLive = make("div", "viewer__live", { id: "vw-pdf-live", "aria-live": "polite" });
  host.root.appendChild(pageLive);

  // The rail starts closed in a narrow window, then follows the toggle.
  memory.railOpen ??= window.innerWidth >= 720;
  function paintRail(): void {
    const open = memory.railOpen === true;
    railBox.hidden = !open;
    host.root.classList.toggle("viewer--pdf-rail", open);
    railBtn.setAttribute("aria-pressed", String(open));
    railBtn.title = open ? "Hide pages" : "Show pages";
  }
  paintRail();
  listen(railBtn, "click", () => {
    railBtn.blur();
    memory.railOpen = !memory.railOpen;
    paintRail();
  });

  /* ---------------- bottom bar ---------------- */

  const bar = make("div", "theater-bar viewer__bar viewer__pdf-bar", { id: "vw-pdf-bar" });
  const scrub = make("div", "theater-bar__seek viewer__pdf-scrub", {
    id: "vw-pdf-scrub",
    role: "slider",
    "aria-label": "Page",
    "aria-valuemin": "1",
    "aria-valuemax": "1",
    "aria-valuenow": "1",
    tabindex: "0",
  });
  const fill = make("div", "theater-bar__seek-fill");
  const knob = make("div", "theater-bar__seek-knob");
  scrub.appendChild(fill);
  scrub.appendChild(knob);
  const zoomOut = button("btn--icon theater-bar__btn viewer__chrome-btn", "Zoom out", icon("zoomOut"));
  zoomOut.id = "vw-pdf-zoomout";
  const zoomBtn = make("button", "btn btn--ghost btn--sm mono viewer__pdf-zoom", {
    type: "button",
    id: "vw-pdf-zoom",
    "aria-haspopup": "menu",
    title: "Zoom",
  });
  const zoomIn = button("btn--icon theater-bar__btn viewer__chrome-btn", "Zoom in", icon("zoomIn"));
  zoomIn.id = "vw-pdf-zoomin";
  const findBtn = button("btn--icon theater-bar__btn viewer__chrome-btn", "Find", FIND_ICON);
  findBtn.id = "vw-pdf-findbtn";
  const sep = (): HTMLElement => make("span", "viewer__pdf-sep", { "aria-hidden": "true" });
  for (const c of [scrub, sep(), zoomOut, zoomBtn, zoomIn, sep(), findBtn]) bar.appendChild(c);
  bar.hidden = true;
  host.root.appendChild(bar);

  /* ---------------- state → chrome ---------------- */

  let shownPage = -1;
  /** the rail's current page, apart from the label: during a drag the label
   *  shows the dragged page, and the strip catching up must still reach it */
  let railShown = -1;
  let shownCount = -1;
  let shownPct = -1;
  let shownZoomText = "";
  let liveText = "";
  let liveTimer: number | undefined;
  /** the page the scrubber shows while it is dragged (null: the view's) */
  let dragPage: number | null = null;

  function paintPages(): void {
    const s = view.state.get();
    const count = doc ? s.count : 0;
    const page = dragPage ?? s.current;
    if (s.current !== railShown) {
      railShown = s.current;
      rail.setCurrent(s.current);
    }
    if (page !== shownPage || count !== shownCount) {
      shownPage = page;
      shownCount = count;
      const text = count > 0 ? `Page ${page + 1} of ${count}` : "";
      pageEl.textContent = text;
      pageEl.hidden = text === "";
      scrub.setAttribute("aria-valuemax", String(Math.max(1, count)));
      scrub.setAttribute("aria-valuenow", String(page + 1));
      scrub.setAttribute("aria-valuetext", text);
      const pct = Math.round(ratioOfPage(page, count) * 1000) / 10;
      if (pct !== shownPct) {
        shownPct = pct;
        fill.style.setProperty("width", `${pct}%`);
        knob.style.setProperty("left", `${pct}%`);
      }
      // Announced once the pages stop changing, never per page of a scroll.
      if (text !== liveText) {
        liveText = text;
        cancel(liveTimer);
        liveTimer = later(() => {
          liveTimer = undefined;
          pageLive.textContent = liveText;
        }, ANNOUNCE_MS);
      }
    }
  }

  function paintZoom(): void {
    const s = view.state.get();
    const text = `${Math.round((s.zoom / PX_PER_PT_100) * 100)}%`;
    if (text !== shownZoomText) {
      shownZoomText = text;
      zoomBtn.textContent = text;
      zoomBtn.setAttribute("aria-label", `Zoom ${text}`);
    }
  }

  unbind.push(
    view.state.subscribe((s) => {
      if (disposed) return;
      memory.fit = s.fit;
      memory.zoom = s.zoom;
      paintPages();
      paintZoom();
    }),
  );
  paintZoom();
  paintTitles();

  function paintTitles(): void {
    findBtn.title = host.withChord("Find", "find");
  }

  /* ---------------- the scrubber ---------------- */

  function goTo(page: number): void {
    if (!doc) return;
    view.scrollToPage(page);
  }

  unbind.push(
    bindScrub(scrub, {
      enabled: () => doc !== null,
      at: (r) => {
        const p = pageAtRatio(r, view.state.get().count);
        if (p === dragPage) return;
        dragPage = p;
        goTo(p);
        paintPages();
      },
      end: () => {
        dragPage = null;
        paintPages();
      },
    }),
  );
  listen<KeyboardEvent>(scrub, "keydown", (e) => {
    const s = view.state.get();
    let to: number | null = null;
    if (e.key === "PageDown") to = s.current + 1;
    else if (e.key === "PageUp") to = s.current - 1;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = s.count - 1;
    if (to === null) return;
    // Home/End are also the viewer's own chords: answered here, once.
    e.preventDefault();
    e.stopPropagation();
    goTo(Math.min(Math.max(to, 0), Math.max(0, s.count - 1)));
  });

  /* ---------------- zoom ---------------- */

  const uiPct = (): number => (view.state.get().zoom / PX_PER_PT_100) * 100;
  const zoomTo = (pct: number, at?: { clientX: number; clientY: number }): void =>
    view.setZoom((pct / 100) * PX_PER_PT_100, at);

  listen(zoomOut, "click", () => {
    zoomOut.blur();
    zoomTo(nextZoomStop(uiPct(), -1));
  });
  listen(zoomIn, "click", () => {
    zoomIn.blur();
    zoomTo(nextZoomStop(uiPct(), 1));
  });
  listen(zoomBtn, "click", () => {
    const r = zoomBtn.getBoundingClientRect();
    // Opens above the bar (it does not fit below), as native menus do.
    showMenu(r.left, r.bottom + 4, [
      { label: "Fit width", onSelect: () => view.fit("width") },
      { label: "Fit page", onSelect: () => view.fit("page") },
      { label: "100%", onSelect: () => zoomTo(100) },
      { label: "200%", onSelect: () => zoomTo(200) },
    ], r.top - 4);
    zoomBtn.blur();
  });
  // Ctrl+wheel zooms the strip at the cursor, over the rail too (always
  // prevented: an unhandled one zooms the whole WebView); a plain wheel
  // scrolls the strip or the rail natively.
  listen<WheelEvent>(
    wrap,
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!doc) return;
      view.setZoom(view.state.get().zoom * wheelFactor(e, view.el.clientHeight), { clientX: e.clientX, clientY: e.clientY });
    },
    { passive: false },
  );

  /* ---------------- find ---------------- */

  let findBox: HTMLElement | null = null;
  let findInput: HTMLInputElement | null = null;
  let findCount: HTMLElement | null = null;
  let findTimer: number | undefined;
  let findGen = 0;
  let hits: PdfSearchHit[] = [];
  let active = -1;
  const findUnbind: (() => void)[] = [];

  function paintFind(searching = false): void {
    if (!findCount) return;
    const q = findInput?.value.trim() ?? "";
    findCount.textContent = !q ? "" : searching ? "Searching" : hits.length === 0 ? "No results" : `${active + 1} of ${hits.length}`;
  }

  function showHit(): void {
    view.setSearchHits(hits, active);
    const h = hits[active];
    if (h && h.rects[0]) view.reveal(h.key, h.rects[0]);
    paintFind();
  }

  function runFind(): void {
    cancel(findTimer);
    findTimer = undefined;
    const my = ++findGen;
    const q = findInput?.value ?? "";
    hits = [];
    active = -1;
    view.setSearchHits([], -1);
    if (!q.trim() || !doc) {
      search.cancel();
      paintFind();
      return;
    }
    paintFind(true);
    void search.find(q).then(
      (found) => {
        if (disposed || my !== findGen || !findBox) return;
        hits = found;
        active = found.length > 0 ? 0 : -1;
        showHit();
      },
      () => {
        if (disposed || my !== findGen) return;
        paintFind();
      },
    );
  }

  function stepHit(dir: 1 | -1): void {
    if (findTimer !== undefined) {
      // Enter before the typing pause ran out: search now.
      runFind();
      return;
    }
    if (hits.length === 0) return;
    active = (active + dir + hits.length) % hits.length;
    showHit();
  }

  function closeFind(): void {
    if (!findBox) return;
    findGen++;
    search.cancel();
    cancel(findTimer);
    findTimer = undefined;
    for (const u of findUnbind.splice(0)) u();
    findBox.remove();
    findBox = findInput = findCount = null;
    hits = [];
    active = -1;
    view.setSearchHits([], -1);
    findBtn.setAttribute("aria-expanded", "false");
    view.el.focus({ preventScroll: true });
  }

  function openFind(): void {
    if (disposed) return;
    if (findBox && findInput) {
      findInput.focus();
      findInput.select();
      return;
    }
    const box = make("div", "viewer__pdf-find", { id: "vw-pdf-find", role: "search" });
    const input = make("input", "input viewer__pdf-find-input", {
      type: "text",
      id: "vw-pdf-find-input",
      "aria-label": "Find in this PDF",
      placeholder: "Find",
      spellcheck: "false",
    }) as HTMLInputElement;
    const count = make("span", "viewer__pdf-find-count mono", { id: "vw-pdf-find-count", "aria-live": "polite" });
    const prev = button("btn--icon btn--sm", "Previous match", UP_ICON);
    const next = button("btn--icon btn--sm", "Next match", DOWN_ICON);
    const close = button("btn--icon btn--sm", "Close", icon("x", 14));
    for (const c of [input, count, prev, next, close]) box.appendChild(c);
    const on = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void): void => {
      t.addEventListener(type, fn as EventListener);
      findUnbind.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(input, "input", () => {
      cancel(findTimer);
      findTimer = later(() => {
        findTimer = undefined;
        runFind();
      }, FIND_DEBOUNCE_MS);
    });
    on<KeyboardEvent>(input, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stepHit(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
      }
    });
    on(prev, "click", () => stepHit(-1));
    on(next, "click", () => stepHit(1));
    on(close, "click", () => closeFind());
    findBox = box;
    findInput = input;
    findCount = count;
    host.root.appendChild(box);
    findBtn.setAttribute("aria-expanded", "true");
    input.focus();
  }

  listen(findBtn, "click", () => {
    findBtn.blur();
    if (findBox) closeFind();
    else openFind();
  });

  /* ---------------- password prompt ---------------- */

  let lock: HTMLElement | null = null;
  const lockUnbind: (() => void)[] = [];

  function removeLock(): void {
    for (const u of lockUnbind.splice(0)) u();
    lock?.remove();
    lock = null;
  }

  /** The inline prompt on the stage (never a browser prompt()). Resolves
   *  with the password, or null on Cancel. */
  function askPassword(wrong: boolean): Promise<string | null> {
    removeLock();
    return new Promise((resolve) => {
      const card = make("div", "viewer__status viewer__pdf-lock", { id: "vw-pdf-lock", role: "group", "aria-label": PASSWORD_HEADING });
      const head = make("div", "viewer__status-text");
      head.textContent = PASSWORD_HEADING;
      card.appendChild(head);
      if (wrong) {
        const err = make("div", "viewer__status-detail viewer__pdf-lock-error", { id: "vw-pdf-lock-error", role: "alert" });
        err.textContent = PASSWORD_WRONG;
        card.appendChild(err);
      }
      const row = make("div", "viewer__pdf-lock-row");
      const input = make("input", "input viewer__pdf-lock-input", {
        type: "password",
        id: "vw-pdf-password",
        "aria-label": "Password",
        placeholder: "Password",
        autocomplete: "off",
      }) as HTMLInputElement;
      const ok = make("button", "btn btn--primary btn--sm", { type: "button", id: "vw-pdf-open" });
      ok.textContent = "Open";
      const no = make("button", "btn btn--ghost btn--sm", { type: "button", id: "vw-pdf-cancel" });
      no.textContent = "Cancel";
      row.appendChild(input);
      row.appendChild(ok);
      row.appendChild(no);
      card.appendChild(row);
      const on = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void): void => {
        t.addEventListener(type, fn as EventListener);
        lockUnbind.push(() => t.removeEventListener(type, fn as EventListener));
      };
      let done = false;
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        removeLock();
        resolve(v);
      };
      // Settled as "cancel" if the prompt goes another way (a step, dispose).
      lockUnbind.push(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
      on(ok, "click", () => finish(input.value));
      on(no, "click", () => finish(null));
      on<KeyboardEvent>(input, "keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      });
      lock = card;
      host.stage.appendChild(card);
      input.focus();
    });
  }

  /* ---------------- documents ---------------- */

  /** Nothing of the old document on screen (failure, prompt). */
  function clearDoc(): void {
    const old = doc;
    doc = null;
    pages = [];
    closeFind();
    view.setPages([]);
    rail.setPages([]);
    wrap.hidden = true;
    bar.hidden = true;
    paintPages();
    if (old) void old.destroy();
  }

  function attach(next: PdfDoc): void {
    const old = doc;
    doc = next;
    pages = Array.from({ length: next.numPages }, (_, i) => ({ key: `p${i}`, doc: next, index: i, rotate: 0 as const }));
    // Through an empty strip: the new file starts at page 1, never at the
    // old one's page under the same key.
    view.setPages([]);
    view.setPages(pages);
    rail.setPages(pages);
    railShown = -1;
    view.scrollToPage(0);
    wrap.hidden = false;
    bar.hidden = false;
    shownPage = -1;
    paintPages();
    // A find box left open searches the new file for the same words.
    if (findBox) runFind();
    // After the new one holds the worker: it never idles out in between.
    if (old) void old.destroy();
    view.el.focus({ preventScroll: true });
  }

  async function open(path: string, live: () => boolean): Promise<void> {
    if (disposed) return;
    const my = ++openGen;
    const current = (): boolean => !disposed && my === openGen && live();
    removeLock();
    host.setStatus(null);
    let password: string | undefined;
    for (;;) {
      let next: PdfDoc;
      try {
        next = await openPdf(path, path, password === undefined ? undefined : { password });
      } catch (e) {
        if (!current()) return;
        if (isPdfOpenError(e) && e.kind === "password") {
          // A protected file never shows the previous one behind its prompt.
          clearDoc();
          // Asked again after a password was tried: that one was wrong.
          const given = await askPassword(password !== undefined);
          if (!current()) return;
          if (given === null) {
            host.setStatus(CANT_SHOW, { detail: `${PASSWORD_HEADING}.` });
            return;
          }
          password = given;
          continue;
        }
        clearDoc();
        const detail = isPdfOpenError(e)
          ? e.kind === "missing"
            ? DETAIL_MISSING
            : e.kind === "invalid"
              ? DETAIL_INVALID
              : e.kind === "other"
                ? e.message || DETAIL_INVALID
                : DETAIL_INVALID
          : DETAIL_INVALID;
        host.setStatus(CANT_SHOW, { detail });
        return;
      }
      if (!current()) {
        void next.destroy();
        return;
      }
      attach(next);
      return;
    }
  }

  return {
    open,
    goPage(which): void {
      const n = view.state.get().count;
      if (doc && n > 0) goTo(which === "first" ? 0 : n - 1);
    },
    find: openFind,
    zoom(step): void {
      if (!doc) return;
      if (step === "fit") view.fit("width");
      else if (step === "100") zoomTo(100);
      else zoomTo(nextZoomStop(uiPct(), step === "in" ? 1 : -1));
    },
    retitle: paintTitles,
    owns(t): boolean {
      return t !== null && (wrap.contains(t) || bar.contains(t) || (lock?.contains(t) ?? false) || (findBox?.contains(t) ?? false));
    },
    dispose(): void {
      if (disposed) return;
      openGen++;
      closeFind();
      removeLock();
      disposed = true;
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
      for (const u of unbind.splice(0)) u();
      search.cancel();
      const old = doc;
      doc = null;
      pages = [];
      rail.dispose();
      view.dispose();
      wrap.remove();
      bar.remove();
      railBtn.remove();
      pageEl.remove();
      pageLive.remove();
      host.root.classList.remove("viewer--pdf", "viewer--pdf-rail");
      if (old) void old.destroy();
    },
  };
}
