// Settings: the Fonts section. ONE compact row whatever the size of the
// library: "Font library", how many fonts are imported, a View button that
// opens the Fonts page (fonts-page.ts: search, sort, remove) and an Import
// fonts button. The per-family list lives on that page, so a big library never
// takes over Settings.
//
// Settings re-renders through `innerHTML`, so this section keeps its own async
// state here and hands Settings two things: `html()`, the whole card built
// synchronously from that state (so a full re-render never shows a stale or
// empty section), and `paint(inner)`, which wires the fresh controls after each
// render. When the section's own state changes (the catalogue lands, an import
// finishes) it repaints only its own card, never the whole screen.
//
// Zero cost until Settings is open: the font runtime (`src/fonts`) is reached
// by dynamic import from `start()`, which mountSettings calls on mount. Nothing
// here runs at module evaluation, and this module is only ever imported by the
// (already lazy) Settings chunk.

import { escapeHtml } from "../core/format";
import { navigate } from "../core/nav";
import {
  INSTALLED_NOTE,
  countSentence,
  createConfirmHost,
  importFlow,
  type FontsRuntime,
} from "./fonts-actions";

// The sentences are shared with the Fonts page; re-exported for the tests and
// any caller that still reaches them through this module.
export { importErrorSentence } from "./fonts-actions";

export interface FontsSection {
  /** The whole card, from this section's state. Synchronous. */
  html(): string;
  /** Wire the card's controls after Settings has rendered it. */
  paint(inner: HTMLElement): void;
  /** Load the runtime and the catalogue. Called once, on mount. */
  start(): void;
  dispose(): void;
}

export function createFontsSection(): FontsSection {
  /** null until the catalogue has been read. The number of library families. */
  let count: number | null = null;
  let loadError = false;
  let importing = false;
  /** The sentences from the last import, one per file that did not make it. */
  let errors: string[] = [];
  let disposed = false;
  let inner: HTMLElement | null = null;
  let runtime: Promise<FontsRuntime> | null = null;
  let unsubscribe: (() => void) | null = null;
  const confirm = createConfirmHost();

  /** One import() for the section's life: every caller shares its promise. */
  const fonts = (): Promise<FontsRuntime> => (runtime ??= import("../fonts"));

  /* ---------------- markup ---------------- */

  function countLine(): string {
    if (loadError) return "Couldn't read the font library.";
    if (count === null) return "Reading fonts";
    return countSentence(count);
  }

  /** The card's children. Direct children of the card, like every other
   *  section's rows, so the card's own spacing applies to them. */
  function cardHtml(): string {
    const errs = errors
      .map((e) => `<div class="settings__hint settings__font-error">${escapeHtml(e)}</div>`)
      .join("");
    return `
      <div class="settings__section-head">Fonts</div>
      <div class="settings__row">
        <div class="settings__row-text">
          <div class="settings__row-label">Font library</div>
          <div class="settings__hint" id="settings-fonts-count">${escapeHtml(`${countLine()} ${INSTALLED_NOTE}`)}</div>
        </div>
        <div class="settings__row-actions">
          <button class="btn btn--sm btn--ghost" id="settings-fonts-view">View</button>
          <button class="btn btn--sm" id="settings-fonts-import" ${importing ? "disabled" : ""}>Import fonts</button>
        </div>
      </div>
      ${errs}`;
  }

  function html(): string {
    return `<section class="card settings__card" id="settings-fonts">${cardHtml()}</section>`;
  }

  /* ---------------- painting ---------------- */

  function wire(): void {
    if (!inner) return;
    inner
      .querySelector<HTMLButtonElement>("#settings-fonts-import")
      ?.addEventListener("click", () => void runImport());
    inner
      .querySelector<HTMLButtonElement>("#settings-fonts-view")
      ?.addEventListener("click", () => navigate({ view: "fonts" }));
  }

  function paint(next: HTMLElement): void {
    inner = next;
    wire();
  }

  /** Rebuild this section's card in place after its own state changed. Focus
   *  inside the card is carried to the same control on the new markup (Import
   *  fonts when the control it was on is now disabled). */
  function repaint(): void {
    if (disposed || !inner) return;
    const host = inner.querySelector<HTMLElement>("#settings-fonts");
    if (!host) return;
    const active = document.activeElement;
    const had = !!active && active !== host && host.contains(active);
    const id = had ? active!.id : "";
    host.innerHTML = cardHtml();
    wire();
    if (had) seat(id);
  }

  function seat(id: string): void {
    if (!inner) return;
    let target = id ? inner.querySelector<HTMLButtonElement>(`#${id}`) : null;
    if (!target || target.disabled) target = inner.querySelector<HTMLButtonElement>("#settings-fonts-import");
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  /* ---------------- catalogue ---------------- */

  async function reload(): Promise<void> {
    try {
      const mod = await fonts();
      const cat = await mod.fontCatalog();
      if (disposed) return;
      count = cat.library.length;
      loadError = false;
    } catch {
      if (disposed) return;
      loadError = true;
    }
    repaint();
  }

  function start(): void {
    void reload();
    void fonts().then(
      (mod) => {
        // A change made elsewhere (or a face finishing its load) re-reads the
        // catalogue from memory: cheap, and the count is never stale.
        if (!disposed) unsubscribe = mod.onFontsChanged(() => void reload());
      },
      () => {}, // reload() already shows that the runtime would not load
    );
  }

  /* ---------------- import ---------------- */

  async function runImport(): Promise<void> {
    if (disposed || importing) return;
    importing = true;
    errors = [];
    repaint();
    const next = await importFlow({ fonts, confirm, alive: () => !disposed });
    if (disposed) return;
    errors = next;
    importing = false;
    // The runtime refreshed its catalogue and fired onFontsChanged; this reads
    // the result from memory and repaints, so the count is right even if this
    // screen subscribed after that notification went out.
    await reload();
    if (disposed) return;
    // A confirm or the button disabling itself took focus away: seat it back
    // on Import fonts, unless the user has since put it somewhere else.
    const a = document.activeElement;
    if (!a || a === document.body) seat("settings-fonts-import");
  }

  return {
    html,
    paint,
    start,
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      // The confirm lives on document.body, outside what the router clears.
      confirm.close();
      inner = null;
    },
  };
}
