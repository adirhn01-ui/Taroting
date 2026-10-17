// Signatures: the saved-signature menu (Settings.pdfSignatures, newest first,
// at most PDF_SIGNATURES_MAX) and the New signature pad.
//   - menu: the app's context-menu look (.ctx-menu), one row per saved
//     signature (a drawn preview; × deletes it from Settings) and
//     "New signature". Holds the keyboard while open; Escape, a press
//     outside or the editor closing shuts it.
//   - pad: the app's modal (.modal-backdrop/.modal, trapTab released on every
//     close path). Drawn with the ink input (sampler + palm rules), saved
//     normalised to a 0..1 box with its aspect; Save puts it FIRST and drops
//     the oldest beyond the limit, then arms it for placing.

import type { PdfSignature } from "../../../core/types";
import { PDF_SIGNATURES_MAX } from "../../../core/types";
import { describeError } from "../../../core/ipc";
import { settingsStore, updateSettings } from "../../../core/session";
import { blockShortcuts } from "../../../core/shortcuts";
import { focusFirst, trapTab } from "../../../ui/focus";
import { icon } from "../../../ui/icons";
import { toast } from "../../../ui/toast";
import { EMA_OTHER, EMA_PEN, PalmFilter, StrokeSampler, collectPoints, pressureOf } from "../../../image/ink/input";
import type { PdfEditorCtx } from "../../types";
import { normalizeSignature } from "./geom";
import { SVG_NS, outlineD, signatureD } from "./render";
import { penHalfWidth } from "../../../image/ink/outline";

/** `sig` saved first; the oldest beyond the limit drops. Pure. */
export function withSignature(list: readonly PdfSignature[], sig: PdfSignature): PdfSignature[] {
  return [sig, ...list].slice(0, PDF_SIGNATURES_MAX);
}
/** The list without entry `i`. Pure. */
export function withoutSignature(list: readonly PdfSignature[], i: number): PdfSignature[] {
  return list.filter((_, k) => k !== i);
}

function saveList(list: PdfSignature[]): void {
  void updateSettings({ pdfSignatures: list }).catch((e: unknown) => {
    toast.error("Couldn't save your signatures.", { detail: describeError(e), op: "Settings", title: "Save" });
  });
}

/** A small drawing of a saved signature (menu preview), `w`×`h` css px. */
export function signaturePreview(sig: PdfSignature, w: number, h: number): SVGSVGElement {
  // fit the signature's box into w×h at its aspect
  let bw = w;
  let bh = w / sig.aspect;
  if (bh > h) {
    bh = h;
    bw = h * sig.aspect;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    signatureD({ id: "preview", t: "signature", x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh, c: "#000000", strokes: sig.strokes }),
  );
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

/* ------------------------------------------------------------------ */
/* The menu                                                            */
/* ------------------------------------------------------------------ */

export interface SignatureMenuHooks {
  arm(sig: PdfSignature): void;
}

let closeMenuNow: (() => void) | null = null;

/** Open the signature menu over `anchor` (closes an open one instead). */
export function toggleSignatureMenu(ctx: PdfEditorCtx, anchor: HTMLElement, hooks: SignatureMenuHooks): void {
  if (closeMenuNow) {
    closeMenuNow();
    return;
  }
  const host = document.createElement("div");
  host.className = "ctx-menu pdfmk-sigmenu";
  host.setAttribute("role", "menu");
  host.setAttribute("aria-label", "Signatures");
  host.style.display = "block";

  const releaseKeys = blockShortcuts();
  let unregister: () => void = () => {};
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (closeMenuNow === close) closeMenuNow = null;
    releaseKeys();
    unregister();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    host.remove();
  };
  const onOutside = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (host.contains(t) || anchor.contains(t))) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const render = (): void => {
    while (host.firstChild) host.removeChild(host.firstChild);
    const list = settingsStore.get().pdfSignatures;
    list.forEach((sig, i) => {
      const row = document.createElement("div");
      row.className = "pdfmk-sigmenu__row";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "ctx-menu__item pdfmk-sigmenu__pick";
      pick.setAttribute("role", "menuitem");
      pick.setAttribute("aria-label", `Place signature ${i + 1}`);
      pick.title = "Place on the page";
      pick.appendChild(signaturePreview(sig, 140, 40));
      pick.addEventListener("click", () => {
        close();
        hooks.arm(sig);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn--ghost btn--icon btn--sm pdfmk-sigmenu__del";
      del.setAttribute("aria-label", `Delete signature ${i + 1}`);
      del.title = "Delete signature";
      del.innerHTML = icon("x", 14);
      del.addEventListener("click", () => {
        const now = settingsStore.get().pdfSignatures;
        if (now[i] !== sig) return;
        saveList(withoutSignature(now, i));
        render();
      });
      row.append(pick, del);
      host.appendChild(row);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ctx-menu__item";
    add.setAttribute("role", "menuitem");
    add.textContent = "New signature";
    add.addEventListener("click", () => {
      close();
      openSignaturePad(ctx, hooks);
    });
    host.appendChild(add);
  };
  render();
  document.body.appendChild(host);
  // above the button (the tool row sits under the pages), else below it
  const r = anchor.getBoundingClientRect();
  const h = host.offsetHeight;
  const top = r.top - h - 4 >= 8 ? r.top - h - 4 : r.bottom + 4;
  host.style.left = `${Math.max(8, r.left)}px`;
  host.style.top = `${Math.max(8, top)}px`;
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  unregister = ctx.registerOverlay(close);
  closeMenuNow = close;
}

/* ------------------------------------------------------------------ */
/* The pad                                                             */
/* ------------------------------------------------------------------ */

/** The pad's drawing size, css px, and its pen width. */
export const PAD_W = 480;
export const PAD_H = 180;
const PAD_PEN = 3;

export const SIGNATURE_PAD_TITLE = "New signature";

/** The most strokes one signature keeps. MIRRORS the `> 500` in
 *  asPdfSignatures (src/core/session.ts), which drops a longer signature
 *  whole on the next launch — so the pad stops taking strokes there. */
export const SIGNATURE_STROKES_MAX = 500;
const PAD_NOTE = "Draw with a pen, a mouse or a finger. Saved signatures stay on this PC.";
export const PAD_FULL_NOTE = "That's as many strokes as a signature can keep. Save it, or Clear to start again.";

let closePadNow: (() => void) | null = null;

export function openSignaturePad(ctx: PdfEditorCtx, hooks: SignatureMenuHooks): void {
  closePadNow?.();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", SIGNATURE_PAD_TITLE);
  const header = document.createElement("div");
  header.className = "modal__header";
  const title = document.createElement("span");
  title.textContent = SIGNATURE_PAD_TITLE;
  const x = document.createElement("button");
  x.type = "button";
  x.className = "btn btn--ghost btn--icon btn--sm";
  x.title = "Cancel";
  x.setAttribute("aria-label", "Cancel");
  x.innerHTML = icon("x", 14);
  header.append(title, x);

  const body = document.createElement("div");
  body.className = "modal__body";
  const pad = document.createElementNS(SVG_NS, "svg");
  pad.setAttribute("class", "pdfmk-sigpad");
  pad.setAttribute("width", String(PAD_W));
  pad.setAttribute("height", String(PAD_H));
  pad.setAttribute("viewBox", `0 0 ${PAD_W} ${PAD_H}`);
  pad.setAttribute("role", "img");
  pad.setAttribute("aria-label", "Signature pad: draw your signature");
  const baseline = document.createElementNS(SVG_NS, "path");
  baseline.setAttribute("class", "pdfmk-sigpad__line");
  baseline.setAttribute("d", `M24 ${PAD_H - 40}H${PAD_W - 24}`);
  const ink = document.createElementNS(SVG_NS, "g");
  pad.append(baseline, ink);
  const note = document.createElement("div");
  note.className = "pdfmk-sigpad__note";
  note.textContent = PAD_NOTE;
  body.append(pad, note);

  const footer = document.createElement("div");
  footer.className = "modal__footer";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.textContent = "Clear";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn--primary";
  save.textContent = "Save";
  save.disabled = true;
  footer.append(clear, cancel, save);
  modal.append(header, body, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  /* drawing */
  const strokes: Float32Array[] = [];
  const palm = new PalmFilter();
  const half = penHalfWidth(PAD_PEN);
  let cur: { id: number; sampler: StrokeSampler; path: SVGPathElement } | null = null;
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = pad.getBoundingClientRect();
    const kx = r.width > 0 ? PAD_W / r.width : 1;
    const ky = r.height > 0 ? PAD_H / r.height : 1;
    return [(e.clientX - r.left) * kx, (e.clientY - r.top) * ky];
  };
  const paint = (): void => {
    if (cur) cur.path.setAttribute("d", outlineD(cur.sampler.points, cur.sampler.count, half));
  };
  const onDown = (e: PointerEvent): void => {
    palm.note(e.pointerType, e.timeStamp);
    if (cur || e.button !== 0 || e.defaultPrevented || !palm.mayDraw(e.pointerType, e.timeStamp)) return;
    if (strokes.length >= SIGNATURE_STROKES_MAX) {
      // quietly full: what is saved must survive the next launch
      note.textContent = PAD_FULL_NOTE;
      return;
    }
    e.preventDefault();
    const sampler = new StrokeSampler(e.pointerType === "pen" ? EMA_PEN : EMA_OTHER, 0.5);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "currentColor");
    ink.appendChild(path);
    const [px, py] = local(e);
    sampler.push(px, py, pressureOf(e));
    cur = { id: e.pointerId, sampler, path };
    try {
      pad.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic */
    }
    paint();
  };
  const onMove = (e: PointerEvent): void => {
    if (!cur || e.pointerId !== cur.id) return;
    for (const s of collectPoints(e)) {
      const [px, py] = local(s);
      cur.sampler.push(px, py, pressureOf(s));
    }
    paint();
  };
  const onUp = (e: PointerEvent): void => {
    if (!cur || e.pointerId !== cur.id) return;
    const [px, py] = local(e);
    cur.sampler.finish(px, py, Number.NaN);
    paint();
    strokes.push(cur.sampler.points.slice(0, cur.sampler.count * 3));
    cur = null;
    save.disabled = false;
  };
  const onCancelPtr = (e: PointerEvent): void => {
    if (!cur || e.pointerId !== cur.id) return;
    cur.path.remove();
    cur = null;
  };
  pad.addEventListener("pointerdown", onDown);
  pad.addEventListener("pointermove", onMove);
  pad.addEventListener("pointerup", onUp);
  pad.addEventListener("pointercancel", onCancelPtr);

  const releaseTrap = trapTab(backdrop);
  const releaseKeys = blockShortcuts();
  let unregister: () => void = () => {};
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (closePadNow === close) closePadNow = null;
    unregister();
    releaseTrap();
    releaseKeys();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  x.addEventListener("click", close);
  cancel.addEventListener("click", close);
  clear.addEventListener("click", () => {
    strokes.length = 0;
    while (ink.firstChild) ink.removeChild(ink.firstChild);
    save.disabled = true;
    note.textContent = PAD_NOTE;
  });
  save.addEventListener("click", () => {
    const sig = normalizeSignature(strokes, 0.5);
    if (!sig) return;
    close();
    saveList(withSignature(settingsStore.get().pdfSignatures, sig));
    hooks.arm(sig);
  });

  unregister = ctx.registerOverlay(close);
  closePadNow = close;
  focusFirst(backdrop, ".btn--primary:not([disabled]), .btn");
}
