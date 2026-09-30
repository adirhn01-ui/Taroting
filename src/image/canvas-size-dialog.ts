// The Resize canvas dialog: width × height (integers 1-65535), keep aspect, and
// a note that it adds or trims space around the picture (layers keep their
// size) and that scaling the picture lives in Export. Apply is one commit of
// `resizeCanvas` (anchored at the centre, so every layer keeps its offset from
// it); the shell refits the view when the canvas size changes.
//
// The app's modal pattern, whole: .modal-backdrop + .modal, trapTab released
// on EVERY close path, Escape / backdrop / X cancel, focus seated on the
// primary action. Singleton — opening it again replaces the open one.

import "../editor/export/export.css";
import { IMAGE_CANVAS_MAX_SIDE } from "../core/types";
import { focusFirst, trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import type { ImageEditorCtx } from "./context";
import { resizeCanvas } from "./layers";

/** A typed side: an integer in [1, IMAGE_CANVAS_MAX_SIDE], else null. Pure;
 *  exported for the tests. "12.5", "0", "", "1e9" and "-3" are all refused —
 *  a canvas side is a pixel count, never rounded behind the user's back. */
export function parseSide(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= IMAGE_CANVAS_MAX_SIDE ? n : null;
}

/** The other side under a kept aspect, rounded, clamped into range. */
export function keptSide(changed: number, fromA: number, fromB: number): number {
  const v = Math.round((changed * fromB) / Math.max(1, fromA));
  return Math.min(IMAGE_CANVAS_MAX_SIDE, Math.max(1, v));
}

/** The dialog's title: named for what it does, the same words as the Canvas
 *  menu row and the inspector button that open it. */
export const CANVAS_SIZE_TITLE = "Resize canvas";

/** The dialog's markup; `closeIcon` is the X glyph. Exported for the test. */
export function canvasSizeMarkup(closeIcon: string): string {
  return `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${CANVAS_SIZE_TITLE}">
      <div class="modal__header"><span>${CANVAS_SIZE_TITLE}</span><button class="btn btn--ghost btn--icon btn--sm" data-act="cancel" title="Cancel" aria-label="Cancel">${closeIcon}</button></div>
      <div class="modal__body">
        <div class="export-form">
          <div class="export-row">
            <label for="imged-size-w">Width × height</label>
            <div class="export-row__control">
              <input class="input export-num" id="imged-size-w" type="number" min="1" max="${IMAGE_CANVAS_MAX_SIDE}" step="1" aria-label="Width" />
              <span class="export-dim-x" aria-hidden="true">×</span>
              <input class="input export-num" id="imged-size-h" type="number" min="1" max="${IMAGE_CANVAS_MAX_SIDE}" step="1" aria-label="Height" />
              <span class="export-dim-x">px</span>
            </div>
          </div>
          <div class="export-note" id="imged-size-error" hidden></div>
          <div class="export-row">
            <label for="imged-size-keep">Keep aspect</label>
            <div class="export-row__control">
              <input class="switch" id="imged-size-keep" type="checkbox" checked />
            </div>
          </div>
          <div class="export-note">Adds or trims space around the picture — layers keep their size. To make the picture smaller, pick a size in Export.</div>
        </div>
      </div>
      <div class="modal__footer">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn btn--primary" data-act="apply">Apply</button>
      </div>
    </div>`;
}

let closeOpen: (() => void) | null = null;

/** Registers its own closer through `ctx.registerOverlay`. */
export function openCanvasSizeDialog(ctx: ImageEditorCtx): void {
  closeOpen?.();
  const { session } = ctx;
  const W0 = session.project.timeline.width;
  const H0 = session.project.timeline.height;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  // The export dialogs' form classes, the same width × height pair the New
  // image dialog uses — one look for every "type a size" surface, and no
  // second set of rules to drift from it.
  backdrop.innerHTML = canvasSizeMarkup(icon("x", 14));
  document.body.appendChild(backdrop);

  const wIn = backdrop.querySelector<HTMLInputElement>("#imged-size-w")!;
  const hIn = backdrop.querySelector<HTMLInputElement>("#imged-size-h")!;
  const keep = backdrop.querySelector<HTMLInputElement>("#imged-size-keep")!;
  const err = backdrop.querySelector<HTMLElement>("#imged-size-error")!;
  const apply = backdrop.querySelector<HTMLButtonElement>('[data-act="apply"]')!;
  wIn.value = String(W0);
  hIn.value = String(H0);

  const validate = (): { w: number; h: number } | null => {
    const w = parseSide(wIn.value);
    const h = parseSide(hIn.value);
    const ok = w !== null && h !== null;
    // Written only on a flip, like every other idempotent control here.
    if (apply.disabled === ok) apply.disabled = !ok;
    const msg = ok ? "" : `Enter whole pixels from 1 to ${IMAGE_CANVAS_MAX_SIDE}.`;
    if (err.textContent !== msg) err.textContent = msg;
    if (err.hidden !== ok) err.hidden = ok;
    return ok ? { w: w!, h: h! } : null;
  };

  // Keep aspect follows the CURRENT canvas's shape, so typing a width gives
  // the height that shape needs, and vice versa.
  wIn.addEventListener("input", () => {
    const w = parseSide(wIn.value);
    if (keep.checked && w !== null) hIn.value = String(keptSide(w, W0, H0));
    validate();
  });
  hIn.addEventListener("input", () => {
    const h = parseSide(hIn.value);
    if (keep.checked && h !== null) wIn.value = String(keptSide(h, H0, W0));
    validate();
  });
  keep.addEventListener("change", () => {
    // Turning it back on re-derives the height from the width.
    const w = parseSide(wIn.value);
    if (keep.checked && w !== null) hIn.value = String(keptSide(w, W0, H0));
    validate();
  });

  const releaseTrap = trapTab(backdrop);
  let unregister: () => void = () => {};
  let closed = false;
  // One exit for every path — X, Cancel, Escape, the backdrop, Apply — so the
  // trap, the key listener and the registry entry are released on all of them.
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (closeOpen === close) closeOpen = null;
    unregister();
    releaseTrap();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const commit = (): void => {
    const dims = validate();
    if (!dims) return;
    close();
    if (dims.w !== W0 || dims.h !== H0) {
      session.commit((p) => resizeCanvas(p, dims.w, dims.h));
    }
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.target === wIn || e.target === hIn)) {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  for (const b of backdrop.querySelectorAll('[data-act="cancel"]')) b.addEventListener("click", close);
  apply.addEventListener("click", commit);

  unregister = ctx.registerOverlay(close);
  closeOpen = close;
  validate();
  // Synchronously, like every other modal: the backdrop is attached, and the
  // offsetParent read inside focusFirst forces the layout it needs. Deferring
  // it a frame left focus behind the backdrop, where the Tab trap sees nothing.
  focusFirst(backdrop, '[data-act="apply"]');
}
