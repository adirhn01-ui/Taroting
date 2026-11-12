// "Insert → Pictures": the small question asked between the picker and the
// insert — which page size the pictures' pages take. The app's modal pattern,
// whole: .modal-backdrop + .modal, trapTab and the shortcut block released on
// EVERY close path (Escape, the backdrop, X, Cancel, Add, the editor going
// away through registerOverlay), focus seated on Add.
//
// The choice is remembered for the app session (not saved), so a second
// batch of scans asks with the size the first one took.

import { PICTURE_PAGE_SIZINGS, type PicturePageSizing } from "../../core/picture-page";
import { blockShortcuts } from "../../core/shortcuts";
import { focusFirst, trapTab } from "../../ui/focus";
import { icon } from "../../ui/icons";

/** The Page size select's labels (the same three Home's "Open as" offers). */
export const PICTURE_SIZING_LABELS: Readonly<Record<PicturePageSizing, string>> = {
  picture: "Picture size",
  a4: "A4",
  letter: "Letter",
};

/** "Add 3 pictures as pages" / "Add 1 picture as a page". */
export function picturePagesTitle(n: number): string {
  return n === 1 ? "Add 1 picture as a page" : `Add ${n} pictures as pages`;
}

/** The size picked last in this app session (the select's default). */
let lastSizing: PicturePageSizing = "picture";

/** Test seam: forget the remembered size. */
export function resetPicturePagesSizing(): void {
  lastSizing = "picture";
}

export interface PicturePagesDialogHost {
  /** the editor's overlay registry: it closes the dialog when the editor goes */
  registerOverlay(close: () => void): () => void;
}

/** Ask for the page size of `count` pictures. Resolves the size (Add) or null
 *  (every other way out). */
export function askPicturePagesSizing(host: PicturePagesDialogHost, count: number): Promise<PicturePageSizing | null> {
  return new Promise((resolve) => {
    const title = picturePagesTitle(count);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal pdfed-picpages";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "pdfed-picpages-title");

    const header = document.createElement("div");
    header.className = "modal__header";
    const heading = document.createElement("span");
    heading.id = "pdfed-picpages-title";
    heading.textContent = title;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "btn btn--ghost btn--icon btn--sm";
    x.title = "Close";
    x.setAttribute("aria-label", "Close");
    x.innerHTML = icon("x", 14);
    header.append(heading, x);

    const body = document.createElement("div");
    body.className = "modal__body";
    const row = document.createElement("div");
    row.className = "field";
    const label = document.createElement("label");
    label.htmlFor = "pdfed-picpages-size";
    label.textContent = "Page size";
    const select = document.createElement("select");
    select.className = "select";
    select.id = "pdfed-picpages-size";
    for (const s of PICTURE_PAGE_SIZINGS) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = PICTURE_SIZING_LABELS[s];
      select.appendChild(opt);
    }
    select.value = lastSizing;
    row.append(label, select);
    body.append(row);

    const footer = document.createElement("div");
    footer.className = "modal__footer";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn--primary";
    add.textContent = "Add";
    footer.append(cancel, add);
    modal.append(header, body, footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const releaseTrap = trapTab(backdrop);
    const releaseKeys = blockShortcuts();
    let unregister: () => void = () => {};
    let closed = false;
    const close = (answer: PicturePageSizing | null): void => {
      if (closed) return;
      closed = true;
      unregister();
      releaseTrap();
      releaseKeys();
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(answer);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(null);
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close(null);
    });
    x.addEventListener("click", () => close(null));
    cancel.addEventListener("click", () => close(null));
    add.addEventListener("click", () => {
      const v = select.value as PicturePageSizing;
      const sizing = PICTURE_PAGE_SIZINGS.includes(v) ? v : "picture";
      lastSizing = sizing;
      close(sizing);
    });
    unregister = host.registerOverlay(() => close(null));
    focusFirst(backdrop, ".btn--primary");
  });
}
