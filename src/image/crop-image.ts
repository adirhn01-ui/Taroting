// Crop image: the whole-canvas crop (stage mode "crop-image"). A window over
// the stage in canvas px, eight handles, an aspect choice, Cancel and Apply —
// built from the video editor's own crop chrome (.stage-overlay, __veil,
// __window, __handle--*), so it looks like the crop the app already has.
//
// Everything is in CANVAS px, integers ≥ 1, clamped inside the canvas: this
// crops, it never grows (Canvas size does that). Apply is one commit of
// `cropImage`; the shell refits the view when the canvas size changes. While
// open it holds the keyboard (`blockShortcuts`) — a stray Delete or Ctrl+Z
// behind the crop would edit the image the user is framing — and answers Enter
// (apply) and Escape (cancel) itself, since the shell's own Escape handler
// respects that same block.

import { blockShortcuts, isTypingTarget } from "../core/shortcuts";
import type { ImageEditorCtx } from "./context";
import { cropImage } from "./layers";
import { canvasToStageCss } from "./view";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type CropGrip = CropHandle | "move";

const HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The aspect choices, in menu order. `null` = free; "original" = the canvas's own. */
export const CROP_ASPECTS: readonly { id: string; label: string; ratio: number | "original" | null }[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

/* ------------------------------------------------------------------ */
/* Pure maths                                                          */
/* ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Round a float rect to whole canvas px, at least 1×1, inside W×H. */
export function roundCrop(r: CropRect, W: number, H: number): CropRect {
  const w = clamp(Math.round(r.w), 1, W);
  const h = clamp(Math.round(r.h), 1, H);
  const x = clamp(Math.round(r.x), 0, W - w);
  const y = clamp(Math.round(r.y), 0, H - h);
  return { x, y, w, h };
}

/** The largest rect of `ratio` (w/h) inside W×H, centred. */
export function aspectRect(ratio: number, W: number, H: number): CropRect {
  let w = W;
  let h = W / ratio;
  if (h > H) {
    h = H;
    w = H * ratio;
  }
  return roundCrop({ x: (W - w) / 2, y: (H - h) / 2, w, h }, W, H);
}

/**
 * The crop after dragging `grip` by (dx, dy) canvas px from `start`, inside
 * W×H, never below 1×1 and never turned inside out (an edge dragged past its
 * opposite stops there). With `ratio` (w/h) the shape is kept: a corner pins
 * the opposite corner, an edge grows the other axis about the centre line.
 * Float result; `roundCrop` makes it whole.
 */
export function dragCrop(
  start: CropRect,
  grip: CropGrip,
  dx: number,
  dy: number,
  ratio: number | null,
  W: number,
  H: number,
): CropRect {
  if (grip === "move") {
    return {
      x: clamp(start.x + dx, 0, W - start.w),
      y: clamp(start.y + dy, 0, H - start.h),
      w: start.w,
      h: start.h,
    };
  }
  const west = grip.includes("w");
  const east = grip.includes("e");
  const north = grip.startsWith("n");
  const south = grip.startsWith("s");
  const left = start.x;
  const top = start.y;
  const right = start.x + start.w;
  const bottom = start.y + start.h;

  if (ratio === null) {
    const l = west ? clamp(left + dx, 0, right - 1) : left;
    const r = east ? clamp(right + dx, left + 1, W) : right;
    const t = north ? clamp(top + dy, 0, bottom - 1) : top;
    const b = south ? clamp(bottom + dy, top + 1, H) : bottom;
    return { x: l, y: t, w: r - l, h: b - t };
  }

  if ((west || east) && (north || south)) {
    // Corner: the opposite corner is the anchor.
    const ax = west ? right : left;
    const ay = north ? bottom : top;
    const px = (west ? left : right) + dx;
    const py = (north ? top : bottom) + dy;
    const roomW = west ? ax : W - ax;
    const roomH = north ? ay : H - ay;
    let w = Math.max(west ? ax - px : px - ax, (north ? ay - py : py - ay) * ratio, 1);
    w = Math.min(w, roomW, roomH * ratio);
    const h = w / ratio;
    return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
  }

  if (west || east) {
    // Side edge: width follows the pointer, height follows the ratio about
    // the horizontal centre line.
    const cy = top + start.h / 2;
    const roomW = west ? right : W - left;
    const maxH = 2 * Math.min(cy, H - cy);
    let w = west ? right - (left + dx) : right + dx - left;
    w = Math.max(1, Math.min(w, roomW, maxH * ratio));
    const h = w / ratio;
    return { x: west ? right - w : left, y: cy - h / 2, w, h };
  }

  // Top/bottom edge.
  const cx = left + start.w / 2;
  const roomH = north ? bottom : H - top;
  const maxW = 2 * Math.min(cx, W - cx);
  let h = north ? bottom - (top + dy) : bottom + dy - top;
  h = Math.max(1, Math.min(h, roomH, maxW / ratio));
  const w = h * ratio;
  return { x: cx - w / 2, y: north ? bottom - h : top, w, h };
}

/* ------------------------------------------------------------------ */
/* Mode                                                                */
/* ------------------------------------------------------------------ */

let active: (() => void) | null = null;

/** The shared context menu is showing (ui/menu.ts keeps one host and toggles
 *  its display) — the same predicate select-tool.ts uses. */
const menuOpen = (): boolean => {
  const m = document.querySelector<HTMLElement>(".ctx-menu");
  return m !== null && m.style.display === "block";
};

/** Enter crop mode. Returns the cancel (also registered with the shell's
 *  overlay registry, so dispose() closes it). A second call while open is a
 *  no-op that returns the open one's cancel. */
export function startImageCrop(ctx: ImageEditorCtx): () => void {
  if (active) return active;
  if (ctx.mode.get() !== "idle") return () => {};
  const { stage, view, session } = ctx;

  const dims = (): { W: number; H: number } => ({
    W: Math.max(1, session.project.timeline.width),
    H: Math.max(1, session.project.timeline.height),
  });
  let { W, H } = dims();
  let rect: CropRect = { x: 0, y: 0, w: W, h: H };
  let ratio: number | null = null;

  const overlay = document.createElement("div");
  overlay.className = "stage-overlay imged-crop";
  overlay.tabIndex = -1;
  const veil = document.createElement("div");
  veil.className = "stage-overlay__veil";
  const win = document.createElement("div");
  win.className = "stage-overlay__window";
  win.dataset.cropgrip = "move";
  for (const h of HANDLES) {
    const el = document.createElement("div");
    el.className = `stage-overlay__handle stage-overlay__handle--${h}`;
    el.dataset.cropgrip = h;
    win.appendChild(el);
  }

  const bar = document.createElement("div");
  bar.className = "imged-cropbar";
  const aspect = document.createElement("select");
  aspect.className = "select select--sm";
  aspect.title = "Aspect ratio";
  aspect.setAttribute("aria-label", "Aspect ratio");
  for (const a of CROP_ASPECTS) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = a.label;
    aspect.appendChild(o);
  }
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--sm";
  cancelBtn.textContent = "Cancel";
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn--primary btn--sm";
  applyBtn.textContent = "Apply";
  bar.append(aspect, cancelBtn, applyBtn);

  overlay.append(veil, win, bar);
  stage.appendChild(overlay);

  // Measured once: the bar's size does not change while it is open, and
  // reading it per placement would be a layout read after every write.
  const barW = bar.offsetWidth;
  const barH = bar.offsetHeight;

  const place = (): void => {
    const v = view.store.get();
    const a = canvasToStageCss(v, v.dpr, rect.x, rect.y);
    const b = canvasToStageCss(v, v.dpr, rect.x + rect.w, rect.y + rect.h);
    win.style.left = `${a.x}px`;
    win.style.top = `${a.y}px`;
    win.style.width = `${Math.max(1, b.x - a.x)}px`;
    win.style.height = `${Math.max(1, b.y - a.y)}px`;
    // The bar hangs under the window's bottom edge, or sits just inside it
    // when that edge is at the bottom of the stage; always fully on stage.
    const stageW = v.stageW / v.dpr;
    const stageH = v.stageH / v.dpr;
    const gap = 8;
    let top = b.y + gap;
    if (top + barH > stageH - gap) top = Math.max(gap, Math.min(b.y, stageH) - barH - gap);
    const left = Math.min(Math.max(gap, (a.x + b.x) / 2 - barW / 2), Math.max(gap, stageW - barW - gap));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  };
  place();

  const unView = view.store.subscribe(place);
  // The canvas can only change under an open crop through something that is
  // not blocked by it (none today): keep the window inside whatever it is now.
  const unDoc = session.store.subscribe((p, prev) => {
    if (p.timeline.width === prev.timeline.width && p.timeline.height === prev.timeline.height) return;
    ({ W, H } = dims());
    rect = roundCrop(rect, W, H);
    place();
  });

  const setAspect = (id: string): void => {
    const a = CROP_ASPECTS.find((x) => x.id === id);
    const r = a?.ratio ?? null;
    ratio = r === "original" ? W / H : r;
    if (ratio !== null) rect = aspectRect(ratio, W, H);
    place();
  };
  aspect.addEventListener("change", () => setAspect(aspect.value));

  /* ---------------- dragging ---------------- */

  let drag: { id: number; grip: CropGrip; x: number; y: number; start: CropRect } | null = null;
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || drag) return;
    const grip = (e.target as HTMLElement).dataset?.cropgrip as CropGrip | undefined;
    if (!grip) return;
    e.preventDefault();
    drag = { id: e.pointerId, grip, x: e.clientX, y: e.clientY, start: rect };
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer ids are not capturable */
    }
  };
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const v = view.store.get();
    const k = v.dpr / v.zoom; // canvas px per CSS px
    const next = dragCrop(drag.start, drag.grip, (e.clientX - drag.x) * k, (e.clientY - drag.y) * k, ratio, W, H);
    const r = roundCrop(next, W, H);
    if (r.x === rect.x && r.y === rect.y && r.w === rect.w && r.h === rect.h) return;
    rect = r;
    place();
  };
  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    try {
      if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    drag = null;
  };
  overlay.addEventListener("pointerdown", onDown);
  overlay.addEventListener("pointermove", onMove);
  overlay.addEventListener("pointerup", onUp);
  overlay.addEventListener("pointercancel", onUp);

  /* ---------------- keys ---------------- */

  const onKey = (e: KeyboardEvent): void => {
    // A dialog over the crop owns its own keys.
    if (document.querySelector(".modal-backdrop")) return;
    // So does a text field outside the crop (the project-name rename is
    // reachable while framing): its Enter/Escape are the field's. The crop's
    // own aspect list stays ours, so Escape there still cancels.
    if (isTypingTarget(e.target) && !overlay.contains(e.target as Node)) return;
    // And an open context menu (the Image menu stays clickable here): its
    // listener sits on the same target after this one, where stopPropagation
    // cannot reach, so one Escape would close the menu AND drop the crop.
    if (menuOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === "Enter") {
      // A focused button or the aspect list answers Enter itself.
      const t = e.target;
      if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };
  document.addEventListener("keydown", onKey, true);

  const releaseKeys = blockShortcuts();
  ctx.mode.set("crop-image");

  let done = false;
  let unregister: () => void = () => {};
  function close(apply: boolean): void {
    if (done) return;
    done = true;
    active = null;
    unregister();
    releaseKeys();
    document.removeEventListener("keydown", onKey, true);
    unView();
    unDoc();
    drag = null;
    overlay.remove();
    if (ctx.mode.get() === "crop-image") ctx.mode.set("idle");
    if (apply && (rect.x !== 0 || rect.y !== 0 || rect.w !== W || rect.h !== H)) {
      const r = rect;
      session.commit((p) => cropImage(p, r));
    }
  }
  cancelBtn.addEventListener("click", () => close(false));
  applyBtn.addEventListener("click", () => close(true));

  const cancel = (): void => close(false);
  unregister = ctx.registerOverlay(cancel);
  active = cancel;
  // Focus the crop so Enter/Escape are unambiguous and a focused toolbar
  // button cannot take the next Space.
  overlay.focus({ preventScroll: true });
  return cancel;
}
