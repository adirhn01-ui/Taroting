// The font picker's open list: a popover with a search field and two groups,
// "Your fonts" (the library) then "Installed" (the six legacy fonts among
// them). Loaded by dynamic import on the first open of any font picker
// (src/fonts/index.ts, mountFontPicker); nothing here runs while it is closed.
//
// Built with createElement and textContent only: font names come from font
// files and are never markup. Every per-row font goes through the CSSOM (the
// packaged CSP refuses style attributes).
//
// Keyboard: focus sits in the search field the whole time; arrows / PageUp /
// PageDown move the active row (aria-activedescendant), Enter picks it, typing
// filters, Escape closes and hands focus back to the control. It holds
// `blockShortcuts` while open, like the colour picker, and its root carries
// `fontpk` so editors read a press inside it as "still editing".

import "./picker.css";
import { LEGACY_FONTS } from "../core/font-id";
import { blockShortcuts } from "../core/shortcuts";
import type { FontCatalog, FontFamilyInfo, FontId } from "../core/types";
import { trapTab } from "../ui/focus";

export interface FontListOptions {
  /** The closed control. A press on it is not "outside": it toggles. */
  anchor: HTMLElement;
  /** The id in force, marked selected and scrolled to. */
  current: FontId;
  /** What the search field starts with (type-to-search from the control). */
  query: string;
  catalog(): Promise<FontCatalog>;
  /** A CSS family to preview a LIBRARY family with, when it is already
   *  loaded; null draws no sample (library files are not loaded to draw the
   *  list). */
  previewFamily(id: FontId): string | null;
  onPick(id: FontId): void;
  /** After the list is gone, on every close path. `restoreFocus`: the user
   *  closed it from the keyboard or by picking, so focus goes back to the
   *  control. */
  onClose(restoreFocus: boolean): void;
}

/** The families the list shows: both groups sorted by name, and the six
 *  legacy fonts always among Installed (outside the desktop app, or if the
 *  enumeration missed one, the picker never offers fewer than 0.9.3 did). */
export function pickerGroups(c: FontCatalog): { library: FontFamilyInfo[]; installed: FontFamilyInfo[] } {
  const byName = (a: FontFamilyInfo, b: FontFamilyInfo): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const ok = (f: FontFamilyInfo | null | undefined): f is FontFamilyInfo =>
    !!f && typeof f.id === "string" && typeof f.name === "string";
  const library = (c.library ?? []).filter(ok).sort(byName);
  const installed = (c.installed ?? []).filter(ok);
  const have = new Set(installed.map((f) => f.id));
  for (const id of LEGACY_FONTS) {
    if (!have.has(id)) installed.push({ id, name: id, source: "installed", faces: [] });
  }
  installed.sort(byName);
  return { library, installed };
}

/** A CSS string literal for a family name. */
const quoted = (name: string): string => `"${name.replace(/["\\]/g, "\\$&")}"`;

const SAMPLE = "Aa";
const PAGE = 8;

let seq = 0;
/** Only one list is ever open. */
let active: { close(restoreFocus: boolean): void } | null = null;

export function openFontList(opts: FontListOptions): { close(restoreFocus: boolean): void } {
  active?.close(false);
  const uid = `fontpk-${++seq}`;

  const root = document.createElement("div");
  root.className = "fontpk fontpk__pop";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Fonts");

  const search = document.createElement("input");
  search.className = "input fontpk__search";
  search.type = "text";
  search.placeholder = "Search fonts";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search fonts");
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-expanded", "true");
  search.setAttribute("aria-controls", `${uid}-list`);
  search.setAttribute("aria-autocomplete", "list");
  search.value = opts.query;

  const list = document.createElement("div");
  list.className = "fontpk__list";
  list.id = `${uid}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Fonts");

  const note = document.createElement("div");
  note.className = "fontpk__note";
  note.setAttribute("role", "status");
  note.textContent = "Loading fonts";

  root.appendChild(search);
  root.appendChild(list);
  root.appendChild(note);
  document.body.appendChild(root);

  interface Row {
    id: FontId;
    el: HTMLElement;
    /** The name as the search compares it. */
    key: string;
    /** Its place among the rows shown, -1 while filtered out. */
    pos: number;
  }
  /** Every family, built once when the catalogue arrives; a search only
   *  shows and hides. */
  const sections: { head: HTMLElement; rows: Row[] }[] = [];
  const rowOf = new Map<Node, Row>();
  /** The rows shown, in order. */
  let rows: Row[] = [];
  let activeIdx = -1;
  let closed = false;

  function setActive(i: number, scroll = true): void {
    if (rows.length === 0) {
      activeIdx = -1;
      search.removeAttribute("aria-activedescendant");
      return;
    }
    const next = Math.max(0, Math.min(rows.length - 1, i));
    rows[activeIdx]?.el.classList.remove("fontpk__row--active");
    activeIdx = next;
    const row = rows[next]!.el;
    row.classList.add("fontpk__row--active");
    search.setAttribute("aria-activedescendant", row.id);
    if (scroll) row.scrollIntoView?.({ block: "nearest" });
  }

  function rowFor(f: FontFamilyInfo, n: number, library: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "fontpk__row";
    row.id = `${uid}-o${n}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", f.id === opts.current ? "true" : "false");
    const name = document.createElement("span");
    name.className = "fontpk__name";
    name.textContent = f.name;
    row.appendChild(name);
    // Installed: naming the family in CSS is free. Library: only a family
    // already loaded for a project gets a sample.
    const family = library ? opts.previewFamily(f.id) : quoted(f.name);
    if (family !== null) {
      const sample = document.createElement("span");
      sample.className = "fontpk__sample";
      sample.setAttribute("aria-hidden", "true");
      sample.textContent = SAMPLE;
      sample.style.fontFamily = `${family}, var(--font-ui)`;
      row.appendChild(sample);
    }
    return row;
  }

  function build(groups: { library: FontFamilyInfo[]; installed: FontFamilyInfo[] }): void {
    let n = 0;
    const section = (title: string, fams: FontFamilyInfo[], library: boolean): void => {
      if (fams.length === 0) return;
      const head = document.createElement("div");
      head.className = "fontpk__group";
      head.setAttribute("role", "presentation");
      head.textContent = title;
      list.appendChild(head);
      const own = fams.map((f): Row => {
        const row = { id: f.id, el: rowFor(f, n++, library), key: f.name.toLocaleLowerCase(), pos: -1 };
        rowOf.set(row.el, row);
        list.appendChild(row.el);
        return row;
      });
      sections.push({ head, rows: own });
    };
    section("Your fonts", groups.library, true);
    section("Installed", groups.installed, false);
    filter();
  }

  function filter(): void {
    if (sections.length === 0) return; // the catalogue is still on its way
    const q = search.value.trim().toLocaleLowerCase();
    rows[activeIdx]?.el.classList.remove("fontpk__row--active");
    rows = [];
    activeIdx = -1;
    for (const s of sections) {
      const before = rows.length;
      for (const r of s.rows) {
        const show = q === "" || r.key.includes(q);
        r.el.hidden = !show;
        r.pos = show ? rows.push(r) - 1 : -1;
      }
      s.head.hidden = rows.length === before;
    }
    note.textContent = rows.length === 0 ? "No fonts match" : "";
    note.hidden = rows.length > 0;
    // Empty search: open on the font in force. A query: its first match.
    const cur = q === "" ? rows.findIndex((r) => r.id === opts.current) : -1;
    setActive(cur >= 0 ? cur : 0);
  }

  function pick(i: number): void {
    const row = rows[i];
    if (!row) return;
    const id = row.id;
    close(true);
    opts.onPick(id);
  }

  /** The place, among the rows shown, of the row a list event came from. */
  function rowIndexOf(t: EventTarget | null): number {
    for (let n = t as Node | null; n && n !== list; n = n.parentNode) {
      const row = rowOf.get(n);
      if (row) return row.pos;
    }
    return -1;
  }

  /* ---------------- events ---------------- */

  const onSearchKey = (e: KeyboardEvent): void => {
    let to: number | null = null;
    if (e.key === "ArrowDown") to = activeIdx + 1;
    else if (e.key === "ArrowUp") to = activeIdx - 1;
    else if (e.key === "PageDown") to = activeIdx + PAGE;
    else if (e.key === "PageUp") to = activeIdx - PAGE;
    else if (e.key === "Enter") {
      e.preventDefault();
      pick(activeIdx);
      return;
    } else return;
    e.preventDefault();
    setActive(to);
  };
  // Keep focus in the search field while the mouse picks.
  const onListDown = (e: Event): void => e.preventDefault();
  const onListClick = (e: Event): void => {
    const i = rowIndexOf(e.target);
    if (i >= 0) pick(i);
  };
  const onListMove = (e: Event): void => {
    const i = rowIndexOf(e.target);
    if (i >= 0 && i !== activeIdx) setActive(i, false); // under the pointer already
  };

  const onOutsideDown = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (root.contains(t) || opts.anchor.contains(t))) return;
    // A press on a dialog's own backdrop only puts the list away: without
    // this the backdrop's mousedown would close the whole dialog too.
    if (t && (t as Element).classList?.contains("modal-backdrop")) e.preventDefault();
    close(false);
  };
  // Window capture runs before every document-capture listener, so a dialog
  // that answers Escape on the document (the Add text dialog) never sees the
  // Escape that only closes this list.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };
  const onScroll = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && root.contains(t)) return; // the list's own scrolling
    close(false);
  };
  const onResize = (): void => close(false);

  search.addEventListener("input", filter);
  search.addEventListener("keydown", onSearchKey);
  list.addEventListener("mousedown", onListDown);
  list.addEventListener("click", onListClick);
  list.addEventListener("pointermove", onListMove);
  document.addEventListener("pointerdown", onOutsideDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  const releaseTrap = trapTab(root);
  const releaseKeys = blockShortcuts();

  function close(restoreFocus: boolean): void {
    if (closed) return;
    closed = true;
    if (active === handle) active = null;
    search.removeEventListener("input", filter);
    search.removeEventListener("keydown", onSearchKey);
    list.removeEventListener("mousedown", onListDown);
    list.removeEventListener("click", onListClick);
    list.removeEventListener("pointermove", onListMove);
    document.removeEventListener("pointerdown", onOutsideDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    releaseTrap();
    releaseKeys();
    root.remove();
    opts.onClose(restoreFocus);
  }

  const handle = { close };
  active = handle;

  place(root, opts.anchor);
  search.focus();

  opts.catalog().then(
    (c) => {
      if (closed) return;
      build(pickerGroups(c));
      place(root, opts.anchor);
    },
    () => {
      if (closed) return;
      // Still usable: the six every Taroting has always had.
      build(pickerGroups({ library: [], installed: [] }));
      note.textContent = "Couldn't list the fonts on this PC.";
      note.hidden = false;
      place(root, opts.anchor);
    },
  );

  return handle;
}

/** Under the control, flipped above when that would overflow, clamped into
 *  the viewport; at least as wide as the control. */
function place(el: HTMLElement, anchor: HTMLElement): void {
  if (typeof anchor.getBoundingClientRect !== "function") return;
  const a = anchor.getBoundingClientRect();
  el.style.minWidth = `${Math.round(a.width)}px`;
  const r = el.getBoundingClientRect();
  const pad = 8;
  const gap = 4;
  let top = a.bottom + gap;
  if (top + r.height > window.innerHeight - pad) {
    top = a.top - r.height - gap;
    if (top < pad) top = Math.max(pad, window.innerHeight - r.height - pad);
  }
  const left = Math.max(pad, Math.min(a.left, window.innerWidth - r.width - pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
