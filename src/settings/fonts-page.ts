// The Fonts page: every family in the font library, with search, sort, a
// sample drawn in each font, and Remove (one, or many from select mode). Its
// own route (`{ view: "fonts" }`), reached from Settings → Fonts → View, and
// its own lazy chunk: nothing of it loads until it is opened.
//
// Built from the app's existing pieces so it looks native: the Settings
// header and column, Home's search field, sort control, select mode and its
// "N selected" bar, and the same confirm and import flow Settings uses
// (fonts-actions.ts — one implementation for both screens).
//
// Samples: a library family's face is loaded only when its row comes near the
// viewport (IntersectionObserver), through the font runtime's ensureFonts, so a
// library of 500 fonts never loads 500 files at once. A face that cannot load
// leaves the sample in the UI font. Nothing here unregisters a face: the
// runtime owns them, and documents open elsewhere may be drawing with them.
//
// Zero overhead when closed: dispose() removes every listener and the
// observer, and closes a confirm that is up.

import "./settings.css";
import "./fonts-page.css";
import { escapeHtml, formatBytes } from "../core/format";
import { navigate } from "../core/nav";
import { chordOf, physicalChordOf } from "../core/shortcuts";
import type { FontFamilyInfo, FontId } from "../core/types";
import { icon } from "../ui/icons";
import {
  confirmRemove,
  createConfirmHost,
  importFlow,
  removeFamilies,
  stylesOf,
  type FlowDeps,
  type FontsRuntime,
} from "./fonts-actions";

/* ---------------- sorting and filtering (pure) ---------------- */

export type FontSort = "name" | "nameDesc" | "newest" | "oldest" | "largest" | "smallest";

export const FONT_SORT_LABELS: Record<FontSort, string> = {
  name: "Name, A to Z",
  nameDesc: "Name, Z to A",
  newest: "Date added, newest first",
  oldest: "Date added, oldest first",
  largest: "Size, largest first",
  smallest: "Size, smallest first",
};

const isFontSort = (v: unknown): v is FontSort => typeof v === "string" && Object.hasOwn(FONT_SORT_LABELS, v);

/** The sort chosen on this page, kept for the rest of the session (not a
 *  setting): the page opens on it again. */
let sortMemory: FontSort = "name";

/** Explorer's name order: numbers by value, case ignored. Built on first use. */
let collator: Intl.Collator | null = null;
function compareNames(a: FontFamilyInfo, b: FontFamilyInfo): number {
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** `list` in the order `key` names; ties (and a family missing the field) by
 *  name, A to Z. Never mutates `list`. */
export function sortFamilies(list: readonly FontFamilyInfo[], key: FontSort): FontFamilyInfo[] {
  const out = list.slice();
  const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  switch (key) {
    case "name":
      out.sort(compareNames);
      break;
    case "nameDesc":
      out.sort((a, b) => compareNames(b, a));
      break;
    case "newest":
      out.sort((a, b) => num(b.addedMs) - num(a.addedMs) || compareNames(a, b));
      break;
    case "oldest":
      out.sort((a, b) => num(a.addedMs) - num(b.addedMs) || compareNames(a, b));
      break;
    case "largest":
      out.sort((a, b) => num(b.bytes) - num(a.bytes) || compareNames(a, b));
      break;
    case "smallest":
      out.sort((a, b) => num(a.bytes) - num(b.bytes) || compareNames(a, b));
      break;
  }
  return out;
}

/** The families whose name contains `query` (trimmed, case ignored). */
export function filterFamilies(list: readonly FontFamilyInfo[], query: string): FontFamilyInfo[] {
  const q = query.trim().toLocaleLowerCase();
  return q ? list.filter((f) => f.name.toLocaleLowerCase().includes(q)) : list.slice();
}

/** "Regular, Bold · Added 3 Nov 2026 · 412 KB" (each part only when known). */
export function metaLine(f: FontFamilyInfo): string {
  const parts: string[] = [];
  const styles = stylesOf(f);
  if (styles) parts.push(styles);
  if (typeof f.addedMs === "number" && f.addedMs > 0) {
    const d = new Date(f.addedMs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    parts.push(`Added ${d}`);
  }
  if (typeof f.bytes === "number" && f.bytes >= 0) parts.push(formatBytes(f.bytes));
  return parts.join(" · ");
}

/** "Remove 3 fonts" (the select bar's action). */
export function removeLabel(n: number): string {
  if (n <= 0) return "Remove fonts";
  return n === 1 ? "Remove 1 font" : `Remove ${n} fonts`;
}

/** What a sample row shows, drawn in the family itself. */
const SAMPLE = "The quick brown fox jumps over the lazy dog";

/* Check mark for a selected row (same glyph as Home's selection badge;
   ui/icons has none and isn't ours to edit). */
const CHECK_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 12.5 10 17.5 19 6.5"/></svg>';

/* ---------------- the page ---------------- */

export function mountFontsPage(root: HTMLElement): { dispose(): void } {
  root.innerHTML = `
    <div class="settings fontlib">
      <header class="settings__header">
        <button class="btn btn--icon btn--ghost" id="fontlib-back" title="Back to settings" aria-label="Back to settings">${icon("chevronLeft")}</button>
        <div class="settings__title">Fonts</div>
        <div class="fontlib__head-actions">
          <button class="btn btn--sm" id="fontlib-import">Import fonts</button>
        </div>
      </header>
      <main class="settings__main" id="fontlib-main">
        <div class="settings__inner fontlib__inner">
          <div class="home__toolbar fontlib__toolbar" id="fontlib-toolbar" hidden>
            <input class="input home__search" id="fontlib-search" placeholder="Search fonts" aria-label="Search fonts" spellcheck="false" />
            <select class="select select--sm home__sort" id="fontlib-sort" title="Sort by" aria-label="Sort by">
              ${(Object.keys(FONT_SORT_LABELS) as FontSort[])
                .map((k) => `<option value="${k}">${escapeHtml(FONT_SORT_LABELS[k])}</option>`)
                .join("")}
            </select>
            <div class="fontlib__spacer"></div>
            <button class="btn btn--sm btn--ghost" id="fontlib-select" title="Select fonts">Select</button>
            <div class="row fontlib__select-bar" id="fontlib-select-bar" hidden>
              <span class="home__select-count" id="fontlib-select-count">0 selected</span>
              <button class="btn btn--sm" id="fontlib-select-remove" disabled>${removeLabel(0)}</button>
              <button class="btn btn--sm btn--ghost" id="fontlib-select-all" title="Select all fonts matching the current search">Select all</button>
              <button class="btn btn--sm btn--ghost" id="fontlib-select-cancel" title="Leave select mode">Cancel</button>
            </div>
          </div>
          <div class="fontlib__errors" id="fontlib-errors"></div>
          <div class="fontlib__list" id="fontlib-list" role="list" aria-label="Imported fonts"></div>
        </div>
      </main>
    </div>
  `;

  const $ = <E extends HTMLElement>(sel: string): E => root.querySelector<E>(sel)!;
  const main = $<HTMLElement>("#fontlib-main");
  const list = $<HTMLElement>("#fontlib-list");
  const toolbar = $<HTMLElement>("#fontlib-toolbar");
  const search = $<HTMLInputElement>("#fontlib-search");
  const sortSelect = $<HTMLSelectElement>("#fontlib-sort");
  const importBtn = $<HTMLButtonElement>("#fontlib-import");
  const errorsEl = $<HTMLElement>("#fontlib-errors");
  const selectBtn = $<HTMLButtonElement>("#fontlib-select");
  const selectBar = $<HTMLElement>("#fontlib-select-bar");
  const selectCount = $<HTMLElement>("#fontlib-select-count");
  const selectRemoveBtn = $<HTMLButtonElement>("#fontlib-select-remove");
  const selectAllBtn = $<HTMLButtonElement>("#fontlib-select-all");
  const selectCancelBtn = $<HTMLButtonElement>("#fontlib-select-cancel");

  /** null until the catalogue has been read. Library families only. */
  let library: FontFamilyInfo[] | null = null;
  /** What the shown list was built from, so a notification that changed
   *  nothing in the library (a face finishing its load) repaints nothing. */
  let shownKey = "";
  let loadError = false;
  let importing = false;
  /** A removal is under way: one at a time, every Remove disabled. */
  let busy = false;
  let selectMode = false;
  const selection = new Set<FontId>();
  let disposed = false;
  let sort: FontSort = sortMemory;
  sortSelect.value = sort;

  let runtime: Promise<FontsRuntime> | null = null;
  /** The runtime once it has loaded: lets a re-render style a sample whose
   *  face is already in without waiting a tick. */
  let runtimeMod: FontsRuntime | null = null;
  const fonts = (): Promise<FontsRuntime> =>
    (runtime ??= import("../fonts").then((m) => {
      runtimeMod = m;
      return m;
    }));
  let unsubscribe: (() => void) | null = null;
  const confirm = createConfirmHost();
  const deps: FlowDeps = { fonts, confirm, alive: () => !disposed };

  /* ---------------- listeners (all removed by dispose) ---------------- */

  const bound: Array<[EventTarget, string, EventListener, boolean]> = [];
  function on<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, capture = false): void {
    target.addEventListener(type, fn as EventListener, capture);
    bound.push([target, type, fn as EventListener, capture]);
  }

  /* ---------------- previews ---------------- */

  const observer: IntersectionObserver | null =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              observer?.unobserve(e.target);
              void loadPreview(e.target as HTMLElement);
            }
          },
          { root: main, rootMargin: "300px 0px" },
        )
      : null;

  /** Draw a sample in its family when the family is loaded. True when done. */
  function applyPreview(el: HTMLElement, mod: FontsRuntime): boolean {
    const id = el.getAttribute("data-sample");
    if (id === null) return true;
    const req = [{ id, bold: false, italic: false }];
    if (!mod.fontsReady(req)) return false;
    const f = mod.fontFace("Segoe UI", id, false, false);
    // A face that would not load: the sample stays in the UI font.
    if (!f.missing) el.style.fontFamily = `${f.family}, var(--font-ui)`;
    return true;
  }

  async function loadPreview(el: HTMLElement): Promise<void> {
    const id = el.getAttribute("data-sample");
    if (id === null) return;
    try {
      const mod = await fonts();
      await mod.ensureFonts([{ id, bold: false, italic: false }]);
      if (disposed || !el.isConnected) return;
      if (!applyPreview(el, mod)) {
        // Still loading after the runtime's bound: name the alias anyway; the
        // text swaps in by itself when the face lands.
        const f = mod.fontFace("Segoe UI", id, false, false);
        if (!f.missing) el.style.fontFamily = `${f.family}, var(--font-ui)`;
      }
    } catch {
      /* the sample stays in the UI font */
    }
  }

  function watchSamples(): void {
    observer?.disconnect();
    for (const el of list.querySelectorAll<HTMLElement>("[data-sample]")) {
      if (runtimeMod && applyPreview(el, runtimeMod)) continue;
      observer?.observe(el);
    }
  }

  /* ---------------- markup ---------------- */

  function visible(): FontFamilyInfo[] {
    return sortFamilies(filterFamilies(library ?? [], search.value), sort);
  }

  function rowHtml(f: FontFamilyInfo): string {
    const id = escapeHtml(f.id);
    const name = escapeHtml(f.name);
    const meta = escapeHtml(metaLine(f));
    const text = `
        <div class="fontlib__text">
          <div class="fontlib__name">${name}</div>
          <div class="fontlib__sample" data-sample="${id}" aria-hidden="true">${SAMPLE}</div>
          ${meta ? `<div class="fontlib__meta">${meta}</div>` : ""}
        </div>`;
    if (selectMode) {
      const on = selection.has(f.id);
      return `
      <div class="fontlib__row fontlib__row--select${on ? " is-selected" : ""}" data-font="${id}" role="checkbox" tabindex="0" aria-checked="${on ? "true" : "false"}" aria-label="${name}">
        <span class="fontlib__check" aria-hidden="true">${on ? CHECK_SVG : ""}</span>
        ${text}
      </div>`;
    }
    return `
      <div class="fontlib__row" data-font="${id}" role="listitem">
        ${text}
        <button class="btn btn--sm btn--ghost" data-font-remove="${id}" aria-label="${escapeHtml(`Remove ${f.name}`)}" ${busy ? "disabled" : ""}>Remove</button>
      </div>`;
  }

  function emptyHtml(): string {
    if (loadError) {
      return `<div class="empty-state fontlib__empty"><div>Couldn't read the font library.</div></div>`;
    }
    if (library === null) return `<div class="empty-state fontlib__empty"><div>Reading fonts</div></div>`;
    if (library.length === 0) {
      return `
        <div class="empty-state fontlib__empty">
          <div>No fonts imported yet.</div>
          <button class="btn" id="fontlib-empty-import" ${importing ? "disabled" : ""}>Import fonts</button>
        </div>`;
    }
    return `<div class="empty-state fontlib__empty"><div>${escapeHtml(`No fonts match "${search.value.trim()}"`)}</div></div>`;
  }

  /** The control focus is on inside the list, by what it is for, so a
   *  re-render can seat focus on the same control in the new markup. */
  function focusKey(): { remove?: string; row?: string; emptyImport?: true } | null {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !list.contains(a)) return null;
    const remove = a.getAttribute("data-font-remove");
    if (remove !== null) return { remove };
    const row = a.getAttribute("data-font");
    if (row !== null) return { row };
    if (a.id === "fontlib-empty-import") return { emptyImport: true };
    return null;
  }

  /** The element in the list for `key` (compared by value: an id is never
   *  built into a selector). */
  function findIn(attr: string, value: string): HTMLElement | null {
    for (const el of list.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      if (el.getAttribute(attr) === value) return el;
    }
    return null;
  }

  function renderList(): void {
    const key = focusKey();
    const items = library && library.length > 0 ? visible() : [];
    list.classList.toggle("fontlib__list--select", selectMode);
    list.setAttribute("role", items.length > 0 && selectMode ? "group" : "list");
    list.innerHTML = items.length > 0 ? items.map(rowHtml).join("") : emptyHtml();
    watchSamples();
    if (key) {
      const target =
        (key.remove !== undefined && findIn("data-font-remove", key.remove)) ||
        (key.row !== undefined && findIn("data-font", key.row)) ||
        (key.emptyImport ? list.querySelector<HTMLElement>("#fontlib-empty-import") : null);
      if (target && !(target as HTMLButtonElement).disabled) target.focus({ preventScroll: true });
    }
  }

  function renderErrors(errors: string[]): void {
    errorsEl.innerHTML = errors
      .map((e) => `<div class="settings__hint settings__font-error">${escapeHtml(e)}</div>`)
      .join("");
  }

  function renderChrome(): void {
    const has = library !== null && library.length > 0;
    toolbar.hidden = !has;
    importBtn.disabled = importing;
    selectBtn.hidden = selectMode;
    selectBtn.disabled = busy;
    selectBar.hidden = !selectMode;
    const n = selection.size;
    selectCount.textContent = `${n} selected`;
    selectRemoveBtn.textContent = removeLabel(n);
    selectRemoveBtn.disabled = n === 0 || busy;
    selectAllBtn.disabled = busy;
    selectCancelBtn.disabled = busy;
  }

  function render(): void {
    renderChrome();
    renderList();
  }

  /* ---------------- catalogue ---------------- */

  const keyOf = (lib: readonly FontFamilyInfo[]): string =>
    JSON.stringify(lib.map((f) => [f.id, f.name, f.addedMs, f.bytes, f.faces.map((x) => x.style)]));

  async function reload(): Promise<void> {
    try {
      const mod = await fonts();
      const cat = await mod.fontCatalog();
      if (disposed) return;
      const next = cat.library;
      const k = keyOf(next);
      const changed = library === null || loadError || k !== shownKey;
      library = next;
      loadError = false;
      shownKey = k;
      const ids = new Set(next.map((f) => f.id));
      for (const id of [...selection]) if (!ids.has(id)) selection.delete(id);
      if (next.length === 0) {
        // Nothing left to search or select.
        search.value = "";
        if (selectMode) selectMode = false;
      }
      if (changed) render();
      else renderChrome();
    } catch {
      if (disposed) return;
      loadError = true;
      render();
    }
  }

  /* ---------------- select mode ---------------- */

  function enterSelectMode(): void {
    if (selectMode || busy || !library || library.length === 0) return;
    selectMode = true;
    selection.clear();
    render();
    selectCancelBtn.focus();
  }

  function leaveSelectMode(focusSelect = true): void {
    if (!selectMode || busy) return;
    selectMode = false;
    selection.clear();
    render();
    if (focusSelect && !selectBtn.hidden && !selectBtn.disabled) selectBtn.focus();
  }

  function toggle(id: FontId): void {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    const row = findIn("data-font", id);
    if (row) {
      const on = selection.has(id);
      row.classList.toggle("is-selected", on);
      row.setAttribute("aria-checked", on ? "true" : "false");
      const check = row.querySelector<HTMLElement>(".fontlib__check");
      if (check) check.innerHTML = on ? CHECK_SVG : "";
    }
    renderChrome();
  }

  function selectAllVisible(): void {
    for (const f of visible()) selection.add(f.id);
    render();
  }

  /* ---------------- import ---------------- */

  async function runImport(): Promise<void> {
    if (disposed || importing) return;
    importing = true;
    renderErrors([]);
    render();
    const errors = await importFlow(deps);
    if (disposed) return;
    importing = false;
    renderErrors(errors);
    await reload();
    if (disposed) return;
    renderChrome();
    const empty = list.querySelector<HTMLButtonElement>("#fontlib-empty-import");
    if (empty) empty.disabled = false;
    const a = document.activeElement;
    if (!a || a === document.body) importBtn.focus();
  }

  /* ---------------- remove ---------------- */

  /** After a removal: the row now where the first removed one was (or the
   *  last row), else the empty state's Import fonts, else the search field
   *  (nothing matches any more), else the header's Import fonts. */
  function focusAfterRemoval(at: number): void {
    const removes = [...list.querySelectorAll<HTMLButtonElement>("[data-font-remove]")];
    const target =
      removes[Math.min(Math.max(at, 0), removes.length - 1)] ??
      list.querySelector<HTMLButtonElement>("#fontlib-empty-import") ??
      (toolbar.hidden ? null : search);
    (target ?? importBtn).focus({ preventScroll: true });
  }

  async function removeFlow(fams: FontFamilyInfo[], from: HTMLElement | null): Promise<void> {
    if (disposed || busy || fams.length === 0) return;
    const ok = await confirmRemove(confirm, fams);
    if (disposed) return;
    if (!ok) {
      // Focus fell to <body> with the dialog: back to the control it came from.
      // (A repaint while the dialog was up rebuilt the row: find it again.)
      const a = document.activeElement;
      const target = from?.isConnected
        ? from
        : from?.hasAttribute("data-font-remove")
          ? findIn("data-font-remove", fams[0]!.id)
          : selectRemoveBtn;
      if ((!a || a === document.body) && target && !(target as HTMLButtonElement).disabled) {
        target.focus({ preventScroll: true });
      }
      return;
    }
    const order = visible().map((f) => f.id);
    const at = Math.min(...fams.map((f) => order.indexOf(f.id)).filter((i) => i >= 0), order.length);
    busy = true;
    render();
    const removed = await removeFamilies(deps, fams);
    if (disposed) return;
    busy = false;
    for (const id of removed) selection.delete(id);
    if (selectMode) {
      selectMode = false;
      selection.clear();
    }
    await reload();
    if (disposed) return;
    render();
    focusAfterRemoval(at);
  }

  /* ---------------- wiring ---------------- */

  const back = (): void => navigate({ view: "settings" });
  on($<HTMLButtonElement>("#fontlib-back"), "click", back);
  on(importBtn, "click", () => void runImport());
  on(search, "input", renderList);
  on(sortSelect, "change", () => {
    const v = sortSelect.value;
    if (!isFontSort(v)) return;
    sort = v;
    sortMemory = v;
    renderList();
  });
  on(selectBtn, "click", enterSelectMode);
  on(selectCancelBtn, "click", () => leaveSelectMode());
  on(selectAllBtn, "click", selectAllVisible);
  on(selectRemoveBtn, "click", () => {
    const fams = (library ?? []).filter((f) => selection.has(f.id));
    void removeFlow(fams, selectRemoveBtn);
  });

  on<MouseEvent>(list, "click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#fontlib-empty-import")) {
      void runImport();
      return;
    }
    const removeBtn = t.closest<HTMLButtonElement>("[data-font-remove]");
    if (removeBtn) {
      const id = removeBtn.getAttribute("data-font-remove");
      const fam = library?.find((f) => f.id === id);
      if (fam) void removeFlow([fam], removeBtn);
      return;
    }
    if (!selectMode || busy) return;
    const row = t.closest<HTMLElement>("[data-font]");
    const id = row?.getAttribute("data-font");
    if (id != null) toggle(id);
  });
  on<KeyboardEvent>(list, "keydown", (e) => {
    if (!selectMode || busy || (e.key !== "Enter" && e.key !== " ")) return;
    const t = e.target as HTMLElement;
    const id = t.getAttribute?.("data-font");
    if (id == null) return;
    e.preventDefault();
    toggle(id);
  });

  // Escape, in order: a dialog or menu that is up owns it; then it leaves
  // select mode; then it clears the search; then it goes back to Settings.
  // Ctrl+F goes to the search field, as on Home.
  on<KeyboardEvent>(document, "keydown", (e) => {
    if (e.defaultPrevented) return;
    if (document.querySelector(".modal-backdrop")) return;
    if (document.querySelector<HTMLElement>(".ctx-menu")?.style.display === "block") return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (selectMode) leaveSelectMode();
      else if (search.value !== "") {
        search.value = "";
        renderList();
        search.focus();
      } else back();
      return;
    }
    if ((chordOf(e) === "Ctrl+F" || physicalChordOf(e) === "Ctrl+F") && !toolbar.hidden) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  render();
  void reload();
  void fonts().then(
    (mod) => {
      // An import or removal made anywhere (an open picker, Settings) re-reads
      // the catalogue from memory; a change that leaves the library as it was
      // repaints nothing.
      if (!disposed) unsubscribe = mod.onFontsChanged(() => void reload());
    },
    () => {}, // reload() already shows that the runtime would not load
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      unsubscribe?.();
      unsubscribe = null;
      for (const [t, type, fn, capture] of bound) t.removeEventListener(type, fn, capture);
      bound.length = 0;
      // The confirm lives on document.body, outside what the router clears.
      confirm.close();
    },
  };
}
