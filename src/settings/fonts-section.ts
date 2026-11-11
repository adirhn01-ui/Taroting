// Settings: the Fonts section. Imports font files into the library, lists the
// library's families and removes them.
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

// The one direct IPC this section makes is the file picker; everything else
// goes through the font runtime.
import { describeError, pickFontFiles } from "../core/ipc";
import { escapeHtml, fileName } from "../core/format";
import type { FontFamilyInfo, FontId, FontImportError, FontImportResult } from "../core/types";
import { focusFirst, trapTab } from "../ui/focus";
import { toast } from "../ui/toast";

type FontsRuntime = typeof import("../fonts");

/** The plain sentence for one file that could not be imported. Every sentence
 *  names the file, so a batch of several failures stays readable. */
export function importErrorSentence(path: string, error: FontImportError | undefined): string {
  const f = fileName(path);
  switch (error) {
    case "extension":
      return `${f} isn't a .ttf or .otf file.`;
    case "notAFont":
      return `${f} isn't a font file.`;
    case "tooLarge":
      return `${f} is too large. A font file can be up to 64 MB.`;
    case "noUnicode":
    case "unsupported":
      return `${f} isn't a supported kind of font.`;
    case "io":
      return `${f} couldn't be read.`;
    case "exists":
      return `${f} is already in the library.`;
    default:
      return `${f} couldn't be imported.`;
  }
}

/** "Inter Bold" when the import told us the family and style, else the file name. */
function describeResult(r: FontImportResult): string {
  if (r.family) return r.style && r.style !== "Regular" ? `${r.family} ${r.style}` : r.family;
  return fileName(r.path);
}

/** The styles of a family, once each, in the catalogue's order. */
function stylesOf(f: FontFamilyInfo): string {
  return [...new Set(f.faces.map((face) => face.style).filter(Boolean))].join(", ");
}

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
  /** null until the catalogue has been read. Library families only. */
  let library: FontFamilyInfo[] | null = null;
  let loadError = false;
  let importing = false;
  /** A removal is under way: one at a time, so every Remove is disabled. */
  let removing = false;
  /** The sentences from the last import, one per file that did not make it. */
  let errors: string[] = [];
  let disposed = false;
  let inner: HTMLElement | null = null;
  let runtime: Promise<FontsRuntime> | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Closes the confirm that is up, if any (teardown and a second confirm). */
  let closeConfirm: (() => void) | null = null;

  /** One import() for the section's life: every caller shares its promise. */
  const fonts = (): Promise<FontsRuntime> => (runtime ??= import("../fonts"));

  /* ---------------- markup ---------------- */

  function listHtml(): string {
    if (loadError) return `<div class="settings__hint">Couldn't read the font library.</div>`;
    if (library === null) return `<div class="settings__hint">Reading fonts</div>`;
    if (library.length === 0) return `<div class="settings__hint">No fonts imported yet.</div>`;
    return library
      .map((f) => {
        const styles = stylesOf(f);
        return `
          <div class="settings__row">
            <div class="settings__row-text">
              <div class="settings__row-label">${escapeHtml(f.name)}</div>
              ${styles ? `<div class="settings__hint">${escapeHtml(styles)}</div>` : ""}
            </div>
            <button class="btn btn--sm btn--ghost" data-font-remove="${escapeHtml(f.id)}" aria-label="${escapeHtml(`Remove ${f.name}`)}" ${removing ? "disabled" : ""}>Remove</button>
          </div>`;
      })
      .join("");
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
          <div class="settings__hint">Fonts installed on this PC are already in every font list.</div>
        </div>
        <button class="btn btn--sm" id="settings-fonts-import" ${importing ? "disabled" : ""}>Import fonts</button>
      </div>
      ${errs}
      ${listHtml()}`;
  }

  function html(): string {
    return `<section class="card settings__card" id="settings-fonts">${cardHtml()}</section>`;
  }

  /* ---------------- painting ---------------- */

  function wire(): void {
    if (!inner) return;
    inner
      .querySelector<HTMLButtonElement>("#settings-fonts-import")
      ?.addEventListener("click", () => void importFlow());
    inner.querySelectorAll<HTMLButtonElement>("[data-font-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-font-remove");
        const fam = library?.find((f) => f.id === id);
        if (fam) void removeFlow(fam);
      });
    });
  }

  function paint(next: HTMLElement): void {
    inner = next;
    wire();
  }

  /** Seat focus on the family's Remove button, or on Import fonts when that
   *  row is gone or disabled (or no family was asked for). Never scrolls. */
  function seat(removeKey: string | null): void {
    if (!inner) return;
    let target: HTMLButtonElement | null = null;
    if (removeKey !== null) {
      // Compared by value: an id is never built into a selector.
      for (const b of inner.querySelectorAll<HTMLButtonElement>("[data-font-remove]")) {
        if (b.getAttribute("data-font-remove") === removeKey) target = b;
      }
    }
    if (!target || target.disabled) target = inner.querySelector<HTMLButtonElement>("#settings-fonts-import");
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  /** Rebuild this section's card in place after its own state changed. Focus
   *  inside the card is carried to the same control on the new markup. */
  function repaint(): void {
    if (disposed || !inner) return;
    const host = inner.querySelector<HTMLElement>("#settings-fonts");
    if (!host) return;
    const active = document.activeElement;
    const had = !!active && active !== host && host.contains(active);
    const removeKey = had ? active!.getAttribute("data-font-remove") : null;
    host.innerHTML = cardHtml();
    wire();
    if (had) seat(removeKey);
  }

  /** After a flow that took focus away (a confirm, a button that disabled
   *  itself): when focus has fallen to <body>, seat it back in the section.
   *  Focus the user has since put somewhere else is left alone. */
  function refocusIfLost(removeKey: FontId | null): void {
    if (disposed) return;
    const a = document.activeElement;
    if (!a || a === document.body) seat(removeKey);
  }

  /* ---------------- catalogue ---------------- */

  async function reload(): Promise<void> {
    try {
      const mod = await fonts();
      const cat = await mod.fontCatalog();
      if (disposed) return;
      library = cat.library;
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
        // catalogue from memory: cheap, and the list is never stale.
        if (!disposed) unsubscribe = mod.onFontsChanged(() => void reload());
      },
      () => {}, // reload() already shows that the runtime would not load
    );
  }

  /* ---------------- confirm ---------------- */

  /** The app's normal confirm: .modal-backdrop + trapTab, focus on Cancel, the
   *  action a plain primary button (removing a font is not destructive red).
   *  Escape, the backdrop and Cancel answer false. */
  function confirm(title: string, text: string, confirmLabel: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (disposed) {
        resolve(false);
        return;
      }
      closeConfirm?.();
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="modal__header"><span>${escapeHtml(title)}</span></div>
          <div class="modal__body">
            <div class="modal__text">${escapeHtml(text)}</div>
          </div>
          <div class="modal__footer">
            <button class="btn btn--sm" data-cancel>Cancel</button>
            <button class="btn btn--sm btn--primary" data-confirm>${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const releaseTrap = trapTab(backdrop);
      focusFirst(backdrop, "[data-cancel]");
      let closed = false;
      const close = (answer: boolean): void => {
        if (closed) return;
        closed = true;
        if (closeConfirm === cancel) closeConfirm = null;
        document.removeEventListener("keydown", onKey, true);
        releaseTrap();
        backdrop.remove();
        resolve(answer);
      };
      const cancel = (): void => close(false);
      closeConfirm = cancel;
      function onKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        }
      }
      document.addEventListener("keydown", onKey, true);
      backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) close(false);
      });
      backdrop.querySelector("[data-cancel]")!.addEventListener("click", cancel);
      backdrop.querySelector("[data-confirm]")!.addEventListener("click", () => close(true));
    });
  }

  /* ---------------- import ---------------- */

  async function importFlow(): Promise<void> {
    if (disposed || importing) return;
    importing = true;
    errors = [];
    repaint();
    try {
      const paths = await pickFontFiles();
      if (disposed || paths.length === 0) return;
      const mod = await fonts();
      const results = await mod.importFonts(paths);
      if (disposed) return;
      const exists = results.filter((r) => !r.ok && r.error === "exists");
      const failed = results.filter((r) => !r.ok && r.error !== "exists");
      errors = failed.map((r) => importErrorSentence(r.path, r.error));
      if (exists.length > 0) {
        const replace = await confirm(
          exists.length === 1 ? "Replace font?" : `Replace ${exists.length} fonts?`,
          exists.length === 1
            ? `${describeResult(exists[0]!)} is already in the library. Replace it with ${fileName(exists[0]!.path)}?`
            : `${exists.map(describeResult).join(", ")} are already in the library. Replace them with the new files?`,
          "Replace",
        );
        if (disposed) return;
        if (replace) {
          const again = await mod.importFonts(
            exists.map((r) => r.path),
            true,
          );
          if (disposed) return;
          errors = errors.concat(again.filter((r) => !r.ok).map((r) => importErrorSentence(r.path, r.error)));
        }
      }
    } catch (e) {
      if (disposed) return;
      toast.error("Couldn't import fonts.", { detail: describeError(e), op: "Settings", title: "Fonts" });
    } finally {
      if (!disposed) {
        importing = false;
        // The runtime refreshed its catalogue and fired onFontsChanged; this
        // reads the result from memory and repaints, so the list is right even
        // if this screen subscribed after that notification went out.
        await reload();
        refocusIfLost(null);
      }
    }
  }

  /* ---------------- remove ---------------- */

  async function removeFlow(fam: FontFamilyInfo): Promise<void> {
    if (disposed || removing) return;
    const ok = await confirm(
      `Remove ${fam.name}?`,
      "Projects that use it show Segoe UI until you import it again. The file you imported it from is not touched.",
      "Remove",
    );
    if (disposed) return;
    if (!ok) {
      refocusIfLost(fam.id);
      return;
    }
    removing = true;
    repaint();
    try {
      const mod = await fonts();
      await mod.removeFont(fam.id);
    } catch (e) {
      if (disposed) return;
      toast.error(`Couldn't remove ${fam.name}.`, { detail: describeError(e), op: "Settings", title: "Fonts" });
    } finally {
      if (!disposed) {
        removing = false;
        await reload();
        refocusIfLost(fam.id);
      }
    }
  }

  return {
    html,
    paint,
    start,
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      closeConfirm?.();
      inner = null;
    },
  };
}
