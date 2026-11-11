// The font library's actions, shared by Settings → Fonts (fonts-section.ts)
// and the Fonts page (fonts-page.ts): the import flow (picker, the "already in
// the library" question, the per-file error sentences), the Remove confirm and
// its wording, and the removal itself. One implementation, so the two screens
// can never word or behave differently.
//
// Everything goes through the font runtime (`src/fonts`: importFonts /
// removeFont), which refreshes its catalogue, forgets the faces it held and
// fires onFontsChanged, so open pickers and documents react exactly as they
// always have. The runtime is reached by the caller's dynamic import: nothing
// here imports it, and nothing here runs at module evaluation.

import { describeError, pickFontFiles } from "../core/ipc";
import { escapeHtml, fileName } from "../core/format";
import type { FontFamilyInfo, FontId, FontImportError, FontImportResult } from "../core/types";
import { focusFirst, trapTab } from "../ui/focus";
import { toast } from "../ui/toast";

export type FontsRuntime = typeof import("../fonts");

/** The sentence under "Font library" that every count shares. */
export const INSTALLED_NOTE = "Fonts installed on this PC are already in every font list.";

/** "No fonts imported yet." / "1 imported font." / "12 imported fonts." */
export function countSentence(n: number): string {
  if (n <= 0) return "No fonts imported yet.";
  return n === 1 ? "1 imported font." : `${n} imported fonts.`;
}

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
export function stylesOf(f: FontFamilyInfo): string {
  return [...new Set(f.faces.map((face) => face.style).filter(Boolean))].join(", ");
}

/* ---------------- confirm ---------------- */

/** One screen's confirm dialogs: at most one up at a time, and `close()`
 *  (teardown) answers the one that is up with false. */
export interface ConfirmHost {
  /** The app's normal confirm: .modal-backdrop + trapTab, focus on Cancel, the
   *  action a plain primary button (removing a font is not destructive red).
   *  Escape, the backdrop and Cancel answer false. */
  ask(title: string, text: string, confirmLabel: string): Promise<boolean>;
  /** Close the dialog that is up, if any (answers false). */
  close(): void;
}

export function createConfirmHost(): ConfirmHost {
  let closeOpen: (() => void) | null = null;
  return {
    close: () => closeOpen?.(),
    ask(title, text, confirmLabel) {
      return new Promise<boolean>((resolve) => {
        closeOpen?.();
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
          if (closeOpen === cancel) closeOpen = null;
          document.removeEventListener("keydown", onKey, true);
          releaseTrap();
          backdrop.remove();
          resolve(answer);
        };
        const cancel = (): void => close(false);
        closeOpen = cancel;
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
    },
  };
}

/* ---------------- import ---------------- */

export interface FlowDeps {
  fonts(): Promise<FontsRuntime>;
  confirm: ConfirmHost;
  /** False once the screen that started the flow is gone. */
  alive(): boolean;
}

/** Pick font files and import them, asking once about the files whose family
 *  and style the library already has (Replace imports those again with
 *  `replace`). Answers the sentences for the files that did not make it
 *  ([] when nothing was picked or everything went in). A failure of the whole
 *  call is a toast. */
export async function importFlow(deps: FlowDeps): Promise<string[]> {
  let errors: string[] = [];
  try {
    const paths = await pickFontFiles();
    if (!deps.alive() || paths.length === 0) return [];
    const mod = await deps.fonts();
    const results = await mod.importFonts(paths);
    if (!deps.alive()) return [];
    const exists = results.filter((r) => !r.ok && r.error === "exists");
    const failed = results.filter((r) => !r.ok && r.error !== "exists");
    errors = failed.map((r) => importErrorSentence(r.path, r.error));
    if (exists.length > 0) {
      const replace = await deps.confirm.ask(
        exists.length === 1 ? "Replace font?" : `Replace ${exists.length} fonts?`,
        exists.length === 1
          ? `${describeResult(exists[0]!)} is already in the library. Replace it with ${fileName(exists[0]!.path)}?`
          : `${exists.map(describeResult).join(", ")} are already in the library. Replace them with the new files?`,
        "Replace",
      );
      if (!deps.alive()) return [];
      if (replace) {
        const again = await mod.importFonts(
          exists.map((r) => r.path),
          true,
        );
        if (!deps.alive()) return [];
        errors = errors.concat(again.filter((r) => !r.ok).map((r) => importErrorSentence(r.path, r.error)));
      }
    }
  } catch (e) {
    if (deps.alive()) toast.error("Couldn't import fonts.", { detail: describeError(e), op: "Settings", title: "Fonts" });
  }
  return errors;
}

/* ---------------- remove ---------------- */

/** Ask whether to remove `fams` (one family: by name; several: by count). */
export function confirmRemove(confirm: ConfirmHost, fams: readonly FontFamilyInfo[]): Promise<boolean> {
  if (fams.length === 1) {
    return confirm.ask(
      `Remove ${fams[0]!.name}?`,
      "Projects that use it show Segoe UI until you import it again. The file you imported it from is not touched.",
      "Remove",
    );
  }
  return confirm.ask(
    `Remove ${fams.length} fonts?`,
    "Projects that use them show Segoe UI until you import them again. The files you imported them from are not touched.",
    "Remove",
  );
}

/** Remove `fams` one after another through the runtime. Answers the ids that
 *  went; a failure is a toast (by name for one family, by count for several). */
export async function removeFamilies(deps: FlowDeps, fams: readonly FontFamilyInfo[]): Promise<FontId[]> {
  const removed: FontId[] = [];
  let failed = 0;
  let detail = "";
  try {
    const mod = await deps.fonts();
    for (const fam of fams) {
      try {
        await mod.removeFont(fam.id);
        removed.push(fam.id);
      } catch (e) {
        failed++;
        detail ||= describeError(e);
      }
    }
  } catch (e) {
    failed = fams.length - removed.length;
    detail = describeError(e);
  }
  if (failed > 0 && deps.alive()) {
    const message =
      fams.length === 1 ? `Couldn't remove ${fams[0]!.name}.` : `${failed} of ${fams.length} fonts couldn't be removed.`;
    toast.error(message, { detail, op: "Settings", title: "Fonts" });
  }
  return removed;
}
