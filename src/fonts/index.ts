// The font runtime: makes library and installed fonts usable by CSS and canvas,
// and the one shared font picker. LAZY: never imported by the boot chunk; each
// consumer reaches it by dynamic import or from its own lazy chunk (the guard
// is src/dev/fonts-chunk-boundary.test.ts).
//
// Import-time cost is nil: no catalogue fetch, no listener, no DOM. The one
// import-time effect is ./fonts.css (the closed control's few rules), which
// Vite bundles with whichever lazy chunk pulls this module in. The list UI is
// ./picker.ts, loaded by dynamic import on the first open.
//
// HOW A NON-LEGACY FONT IS DRAWN. Every font id has a deterministic alias (an
// unquoted CSS identifier derived from the id alone), so a consumer can name it
// in a font string before anything has loaded: `<alias>, "Segoe UI"` shows the
// legacy fallback until the face is registered, then swaps in by itself.
// `ensureFonts` resolves the four style slots (400/700 x normal/italic) of each
// id in ONE IPC batch and registers a FontFace per slot, each from the file
// Rust chose for that slot (its face-choice order), so CSS and canvas can never
// fake a bold or an italic: a family with one face has that file in all four.
//
// The six legacy fonts never enter any of this (I1): no IPC, no FontFace.

import "./fonts.css";
import { chosenFont, fontChoice, fontDisplayName, isFontId, isLegacyFont } from "../core/font-id";
import { ipc, mediaUrl } from "../core/ipc";
import type {
  FontCatalog,
  FontFaceInfo,
  FontFamily,
  FontId,
  FontImportResult,
  FontRequest,
  ResolvedFont,
} from "../core/types";

/* ---------------- state ---------------- */

/** How long `ensureFonts` waits on a face before calling it not ready. A
 *  later load still fires `onFontsChanged`. */
const LOAD_BOUND_MS = 5000;

/** The four style slots, in the order they are requested and stored. */
const SLOTS: readonly { bold: boolean; italic: boolean }[] = [
  { bold: false, italic: false },
  { bold: true, italic: false },
  { bold: false, italic: true },
  { bold: true, italic: true },
];
const slotIndex = (bold: boolean, italic: boolean): number => (bold ? 1 : 0) + (italic ? 2 : 0);

interface Slot {
  /** What Rust answered for this slot's request. */
  res: ResolvedFont;
  /** The registered face; null when there is none to wait on (Rust found
   *  nothing for the slot, or its file would not load). */
  face: FontFace | null;
  /** The face finished loading (successfully). */
  loaded: boolean;
  /** Settles (never rejects) when the face's load has finished either way. */
  done: Promise<void>;
}

interface Family {
  /** `resolving`: the IPC is out. `resolved`: faces registered (loading or
   *  loaded). `missing`: not on this PC, or nothing of it could be loaded. */
  status: "resolving" | "resolved" | "missing";
  slots: Slot[];
  /** Settles when this family has nothing left to do (all loads finished). */
  settled: Promise<void>;
}

const families = new Map<FontId, Family>();
const listeners = new Set<() => void>();
let catalog: Promise<FontCatalog> | null = null;
let catalogValue: FontCatalog | null = null;

/** A request the runtime acts on: a well-shaped, non-legacy id. */
const isRuntimeId = (id: unknown): id is FontId => isFontId(id) && !isLegacyFont(id);

/* ---------------- alias ---------------- */

/** The CSS family name the runtime registers an id under. Deterministic and
 *  injective, and a plain identifier, so it needs no quoting in CSS or in a
 *  canvas font string: a-z and 0-9 stand as they are, every other UTF-16 unit
 *  is `-` and its four hex digits (capitals too: CSS matches family names
 *  without regard to case, ids do not). */
const fontAlias = (id: FontId): string =>
  `tfont-${id.replace(/[^a-z0-9]/g, (c) => `-${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;

/** Each well-shaped id's alias, made once: `fontFace` runs while the stage is
 *  styled and text is measured, so a repeated call is one map read instead of
 *  `isFontId`'s tests and `fontAlias`'s replace. Forgotten with the id. */
const aliases = new Map<FontId, string>();

function aliasOf(id: FontId): string {
  let alias = aliases.get(id);
  if (alias === undefined) {
    alias = fontAlias(id);
    aliases.set(id, alias);
  }
  return alias;
}

/** `url("…")` for a FontFace source. The asset URL is percent-encoded already;
 *  the escape is belt and braces. */
const cssUrl = (u: string): string => `url("${u.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;

/* ---------------- change notifications ---------------- */

let firePending = false;
/** Several faces landing in the same tick make one notification. */
function fireSoon(): void {
  if (firePending) return;
  firePending = true;
  queueMicrotask(() => {
    firePending = false;
    fire();
  });
}

function fire(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.error("onFontsChanged listener failed", err);
    }
  }
}

/** Fires after an import, a removal, or a face finishing its load: repaint / re-measure. Returns the unsubscribe. */
export function onFontsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/* ---------------- loading ---------------- */

function fontSet(): FontFaceSet | null {
  return typeof document !== "undefined" && document.fonts ? document.fonts : null;
}

/** Register one slot's face and start its load. */
function registerSlot(alias: string, idx: number, res: ResolvedFont, onLoaded: () => void): Slot {
  const { bold, italic } = SLOTS[idx]!;
  const slot: Slot = { res, face: null, loaded: false, done: Promise.resolve() };
  const set = fontSet();
  if (!res.found || typeof FontFace === "undefined" || set === null) return slot;
  let face: FontFace;
  try {
    face = new FontFace(alias, cssUrl(mediaUrl(res.path)), {
      weight: bold ? "700" : "400",
      style: italic ? "italic" : "normal",
      // Show the fallback at once and swap the face in when it lands; the
      // default `auto` hides DOM text for up to 3 s while a face loads.
      display: "swap",
    });
    set.add(face);
  } catch {
    return slot;
  }
  slot.face = face;
  slot.done = face.load().then(
    () => {
      slot.loaded = true;
      onLoaded();
    },
    () => {
      // A file that will not load: nothing to wait on or keep, and this slot
      // draws with what the browser falls back to.
      slot.face = null;
      set.delete(face);
    },
  );
  return slot;
}

/** Resolve and register every id in `ids` (none of which has a family yet)
 *  with one IPC batch. */
function startFamilies(ids: FontId[]): void {
  const reqs: FontRequest[] = [];
  for (const id of ids) for (const s of SLOTS) reqs.push({ id, bold: s.bold, italic: s.italic });
  // A failed or ill-shaped answer reads as "not on this PC" (legacy fallback)
  // and is not asked again: a draw path that asks on every paint must not
  // turn one failure into a call per paint. Importing or removing that id
  // clears it.
  const resolved: Promise<ResolvedFont[] | null> = ipc.fontsResolve(reqs).then(
    (out) => (Array.isArray(out) && out.length === reqs.length ? out : null),
    () => null,
  );
  ids.forEach((id, n) => {
    const fam: Family = { status: "resolving", slots: [], settled: Promise.resolve() };
    fam.settled = resolved.then(async (all) => {
      if (families.get(id) !== fam) return; // cleared by an import or removal meanwhile
      const mine = all?.slice(n * 4, n * 4 + 4) ?? null;
      if (mine === null || !mine.some((r) => r.found)) {
        fam.status = "missing";
        return;
      }
      const alias = aliasOf(id);
      fam.slots = mine.map((res, idx) =>
        registerSlot(alias, idx, res, () => {
          if (families.get(id) === fam) fireSoon();
        }),
      );
      fam.status = "resolved";
      await Promise.all(fam.slots.map((s) => s.done));
      if (families.get(id) !== fam) return;
      // Nothing of it could be loaded: draw (and report) it as missing.
      if (!fam.slots.some((s) => s.loaded)) fam.status = "missing";
    });
    families.set(id, fam);
  });
}

/** Drop what the runtime holds for `id` (its faces leave document.fonts), so
 *  the next `ensureFonts` resolves it afresh. */
function forget(id: FontId): boolean {
  aliases.delete(id);
  const fam = families.get(id);
  if (!fam) return false;
  families.delete(id);
  const set = fontSet();
  for (const s of fam.slots) {
    if (s.face && set) {
      try {
        set.delete(s.face);
      } catch {
        /* already gone */
      }
    }
  }
  return true;
}

/** Distinct runtime ids of `reqs`, in first-seen order. */
function idsOf(reqs: FontRequest[]): FontId[] {
  const seen = new Set<FontId>();
  for (const r of reqs) if (r && isRuntimeId(r.id)) seen.add(r.id);
  return [...seen];
}

/** Make every non-legacy font in `reqs` usable by CSS and canvas, or known
 *  missing. Requests naming a legacy font, and an empty list, resolve at once
 *  with no IPC. Safe to call repeatedly; concurrent calls share work. */
export function ensureFonts(reqs: FontRequest[]): Promise<void> {
  const ids = idsOf(Array.isArray(reqs) ? reqs : []);
  if (ids.length === 0 || fontsReady(reqs)) return Promise.resolve();
  const fresh = ids.filter((id) => !families.has(id));
  if (fresh.length > 0) startFamilies(fresh);
  const all = Promise.all(ids.map((id) => families.get(id)!.settled)).then(() => undefined);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, LOAD_BOUND_MS);
    void all.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Sync. True when ensureFonts(reqs) has nothing left to do. */
export function fontsReady(reqs: FontRequest[]): boolean {
  for (const r of Array.isArray(reqs) ? reqs : []) {
    if (!r || !isRuntimeId(r.id)) continue;
    const fam = families.get(r.id);
    if (!fam || fam.status === "resolving") return false;
    if (fam.status === "missing") continue;
    const slot = fam.slots[slotIndex(r.bold === true, r.italic === true)];
    // A slot with no face (Rust found nothing for it) has nothing to wait on.
    if (slot && slot.face && !slot.loaded) return false;
  }
  return true;
}

/** Sync; call after ensureFonts. What to draw with:
 *  - no fontId, or the font is missing: { family: <the legacy name, exactly as 0.9.3 writes it>, bold, italic as asked, missing: fontId !== undefined }
 *  - otherwise: { family: <an alias that needs no quoting>, bold/italic: the real face, missing: false } */
export function fontFace(
  legacy: FontFamily,
  fontId: FontId | undefined,
  bold: boolean,
  italic: boolean,
): { family: string; bold: boolean; italic: boolean; missing: boolean } {
  if (fontId === undefined) return { family: legacy, bold, italic, missing: false };
  // A legacy name in fontId (never stored, but well-shaped): that font itself.
  if (isLegacyFont(fontId)) return { family: fontId, bold, italic, missing: false };
  // Memoized only once well-shaped, so a hit needs no isFontId.
  let alias = aliases.get(fontId);
  if (alias === undefined) {
    if (!isFontId(fontId)) return { family: legacy, bold, italic, missing: true };
    alias = aliasOf(fontId);
  }
  const fam = families.get(fontId);
  if (fam?.status === "missing") return { family: legacy, bold, italic, missing: true };
  if (fam?.status === "resolved") {
    const res = fam.slots[slotIndex(bold, italic)]?.res;
    if (res?.found) return { family: alias, bold: res.bold, italic: res.italic, missing: false };
  }
  // Not resolved yet: the alias, so DOM text swaps in by itself once it loads.
  return { family: alias, bold, italic, missing: false };
}

/** After ensureFonts: the ids among `reqs` that are not on this PC. */
export function missingFonts(reqs: FontRequest[]): FontId[] {
  return idsOf(Array.isArray(reqs) ? reqs : []).filter((id) => families.get(id)?.status === "missing");
}

/* ---------------- faces ---------------- */

const STYLE_LABEL = ["Regular", "Bold", "Italic", "Bold Italic"] as const;

/** The real faces of a font (to enable Bold / Italic), or null if not known yet. Generalizes the Impact rule. */
export function facesOf(id: FontId): FontFaceInfo[] | null {
  if (catalogValue) {
    const fam =
      catalogValue.library.find((f) => f.id === id) ?? catalogValue.installed.find((f) => f.id === id);
    if (fam) return fam.faces.map((f) => ({ ...f }));
  }
  // Without the catalogue: what the four slot resolutions say exists. Rust
  // answers the face actually used per slot, so the distinct answers are the
  // family's styles as far as Bold / Italic are concerned. A legacy id never
  // reaches the resolver (I1) and stays unknown here.
  const fam = families.get(id);
  if (!fam || fam.status !== "resolved") return null;
  const out: FontFaceInfo[] = [];
  const seen = new Set<number>();
  for (const s of fam.slots) {
    if (!s.res.found) continue;
    const k = slotIndex(s.res.bold, s.res.italic);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      bold: s.res.bold,
      italic: s.res.italic,
      weight: s.res.bold ? 700 : 400,
      style: STYLE_LABEL[k]!,
      embed: s.res.embed,
    });
  }
  return out;
}

/* ---------------- catalogue, import, removal ---------------- */

/** The catalogue (library + installed). The first call enumerates; later calls answer from memory unless `refresh`. */
export function fontCatalog(refresh?: boolean): Promise<FontCatalog> {
  if (catalog && refresh !== true) return catalog;
  const p = ipc.fontsList(refresh === true).then(
    (c) => {
      const clean: FontCatalog = {
        library: Array.isArray(c?.library) ? c.library : [],
        installed: Array.isArray(c?.installed) ? c.installed : [],
      };
      if (catalog === p) catalogValue = clean;
      return clean;
    },
    (err: unknown) => {
      // Not cached: the next call tries again.
      if (catalog === p) catalog = null;
      throw err;
    },
  );
  catalog = p;
  return p;
}

/** After the library changed: the catalogue is re-read (Rust rescans its
 *  library folder after an import or removal; the installed list is not
 *  re-enumerated), and the runtime forgets `ids` so a font that was missing
 *  heals and a replaced or removed one is not drawn from the old file. Ids
 *  some consumer had asked for are resolved again in the background. */
async function libraryChanged(ids: FontId[]): Promise<void> {
  catalog = null;
  catalogValue = null;
  const again = ids.filter((id) => forget(id));
  try {
    await fontCatalog();
  } catch {
    /* the picker and Settings ask again and report it themselves */
  }
  fire();
  if (again.length > 0) void ensureFonts(again.map((id) => ({ id, bold: false, italic: false })));
}

/** Import font files into the library (Settings calls this, never the IPC):
 *  one result per path, in order; then refreshes the catalogue and fires
 *  onFontsChanged. */
export async function importFonts(paths: string[], replace?: boolean): Promise<FontImportResult[]> {
  const results = await ipc.fontsImport(paths, replace === true);
  const ids = results.filter((r) => r.ok && isRuntimeId(r.id)).map((r) => r.id!);
  if (results.some((r) => r.ok)) await libraryChanged(ids);
  return results;
}

/** Remove a library family (Settings calls this, never the IPC); then
 *  refreshes the catalogue and fires onFontsChanged. */
export async function removeFont(id: FontId): Promise<void> {
  await ipc.fontsRemove(id);
  await libraryChanged([id]);
}

/* ---------------- the picker (closed control) ---------------- */

/** The one shared picker. Closed, it looks like the app's existing select control. */
export function mountFontPicker(
  host: HTMLElement,
  opts: {
    value(): { legacy: FontFamily; fontId?: FontId };
    onPick(v: { legacy: FontFamily; fontId?: FontId }): void;
    disabled?: boolean;
  },
): { refresh(): void; dispose(): void } {
  const btn = document.createElement("button");
  btn.type = "button";
  // `select select--sm`: the very classes of the <select> this replaces, so
  // border, height, chevron and type match; fonts.css adds only what a button
  // does differently (alignment, truncation).
  btn.className = "select select--sm fontpk fontpk__ctl";
  btn.setAttribute("aria-label", "Font");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.disabled = opts.disabled === true;

  let current: FontId = "Segoe UI";
  let handle: { close(restoreFocus: boolean): void } | null = null;
  let opening = false;
  let disposed = false;

  const refresh = (): void => {
    const v = opts.value();
    current = chosenFont(v.legacy, v.fontId);
    btn.textContent = fontDisplayName(current);
  };

  async function open(query: string): Promise<void> {
    if (handle || opening || disposed || btn.disabled) return;
    opening = true;
    try {
      const { openFontList } = await import("./picker");
      if (disposed) return;
      btn.setAttribute("aria-expanded", "true");
      handle = openFontList({
        anchor: btn,
        current,
        query,
        catalog: () => fontCatalog(),
        previewFamily: (id) => {
          const fam = families.get(id);
          return fam?.status === "resolved" && fam.slots.some((s) => s.loaded) ? aliasOf(id) : null;
        },
        onPick: (id) => {
          const choice = fontChoice(id);
          current = id;
          btn.textContent = fontDisplayName(id);
          opts.onPick(choice);
        },
        onClose: (restoreFocus) => {
          handle = null;
          btn.setAttribute("aria-expanded", "false");
          if (restoreFocus && !disposed) btn.focus();
        },
      });
    } catch (err) {
      console.error("font picker failed to open", err);
    } finally {
      opening = false;
    }
  }

  const onClick = (): void => {
    if (handle) handle.close(true);
    else void open("");
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key;
    // Tab moves on and Escape belongs to the dialog or screen around it,
    // exactly as with the <select>.
    if (k === "Tab" || k === "Escape") return;
    // The <select> this replaces is a typing target, so while it had focus
    // no screen shortcut fired (Delete never removed the selected mark, Space
    // never played). A button is not one: keep every other key here.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) return;
    let query: string | null = null;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " " || k === "F4") query = "";
    else if (!e.altKey && k.length === 1 && k.trim() !== "") query = k; // type-to-search
    if (query === null) return;
    e.preventDefault();
    void open(query);
  };
  btn.addEventListener("click", onClick);
  btn.addEventListener("keydown", onKeyDown);
  refresh();
  host.appendChild(btn);

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      handle?.close(false);
      handle = null;
      btn.removeEventListener("click", onClick);
      btn.removeEventListener("keydown", onKeyDown);
      btn.remove();
    },
  };
}

