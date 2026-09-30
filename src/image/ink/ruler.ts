// The ruler: a straight edge laid over the stage, Windows Ink style. Ink that
// STARTS within EDGE_CATCH_CSS of either long edge follows that edge for the
// whole gesture, so a pen draws a dead-straight line along it at any angle.
//
// Transient: it lives in the tool state (canvas px, degrees), is never saved in
// the project and never exported. The widget exists in the DOM only while the
// ruler is shown, and does work only when the ruler or the view changes — no
// timers, no frames.
//
// Controls: drag the body to move; wheel rotates 1° (Shift: 15°); two fingers
// that start on it rotate (and carry) it; focused, arrows nudge 1 px (Shift:
// 10) and Ctrl+arrows rotate 1° (Ctrl+Shift: 15°). Angles within 1.5° of a
// multiple of 15° snap to it — measured on the RAW angle the gesture has
// accumulated, so a 1° wheel step can always climb back out of a snap.

import { shortcutsBlocked } from "../../core/shortcuts";
import type { ImageEditorCtx } from "../context";
import type { RulerState } from "../tool-state";

/** The ruler's thickness on screen, css px. */
export const RULER_THICKNESS_CSS = 64;
/** Ink that starts this close (screen css px) to an edge follows it. */
export const EDGE_CATCH_CSS = 24;
export const SNAP_STEP_DEG = 15;
export const SNAP_WITHIN_DEG = 1.5;
/** The ruler's tooltip: a drag only moves it, so it says how a mouse turns it. */
const RULER_TITLE = "Drag to move · scroll to rotate (Shift: 15°)";
/** Minor ticks are 10 canvas px apart — thinned (×5, ×2, …) until they are at
 *  least this far apart on screen. */
const TICK_CANVAS_PX = 10;
const TICK_MIN_CSS = 6;
const MAJOR_EVERY = 10;

/** An angle in (−180, 180]. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

/** Snap to the nearest multiple of 15° when within 1.5° of it. */
export function snapAngle(a: number): number {
  const m = Math.round(a / SNAP_STEP_DEG) * SNAP_STEP_DEG;
  return normalizeAngle(Math.abs(a - m) <= SNAP_WITHIN_DEG ? m : a);
}

/** The ruler's unit axis `u` (along) and normal `n` (across; +n is the
 *  element's "bottom" edge — CSS rotate turns local +x to u and +y to n). */
export function rulerAxes(angleDeg: number): { ux: number; uy: number; nx: number; ny: number } {
  const r = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(r);
  const uy = Math.sin(r);
  return { ux, uy, nx: -uy, ny: ux };
}

/**
 * Which edge a point is close enough to follow: +1 (the +n edge), −1 (the −n
 * edge) or 0. `half` is half the ruler's thickness, `reach` the catch distance
 * and `halfLen` half its length, all in canvas px.
 */
export function edgeNear(r: RulerState, px: number, py: number, half: number, reach: number, halfLen: number): 1 | -1 | 0 {
  const { ux, uy, nx, ny } = rulerAxes(r.angle);
  const dx = px - r.cx;
  const dy = py - r.cy;
  const along = dx * ux + dy * uy;
  if (Math.abs(along) > halfLen) return 0;
  const across = dx * nx + dy * ny;
  if (Math.abs(Math.abs(across) - half) > reach) return 0;
  return across >= 0 ? 1 : -1;
}

/**
 * Project a point onto the line `offset` from the ruler's centre line on
 * `side`: the ink's centre line when the mark's edge is to touch the ruler's
 * edge (offset = half thickness + half the mark's width). Every projected point
 * has the same (x, y)·n — which is what "straight along the edge" means.
 */
export function projectToEdge(r: RulerState, side: 1 | -1, offset: number, px: number, py: number): [number, number] {
  const { nx, ny } = rulerAxes(r.angle);
  const across = (px - r.cx) * nx + (py - r.cy) * ny;
  const shift = across - side * offset;
  return [px - nx * shift, py - ny * shift];
}

/** Tick spacing on screen, css px: 10 canvas px, thinned ×5 then ×2 in turn
 *  until at least TICK_MIN_CSS apart. */
export function tickSpacingCss(cssPerCanvas: number): number {
  let s = TICK_CANVAS_PX * cssPerCanvas;
  if (!(s > 0) || !Number.isFinite(s)) return TICK_MIN_CSS;
  let k = 0;
  while (s < TICK_MIN_CSS && k < 40) {
    s *= k % 2 === 0 ? 5 : 2;
    k++;
  }
  return s;
}

/** A ruler for the current view: centred on the visible stage, level. */
export function defaultRuler(ctx: ImageEditorCtx): RulerState {
  const rect = ctx.stage.getBoundingClientRect();
  const c = ctx.view.clientToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return { cx: c.x, cy: c.y, angle: 0 };
}

/** Show the ruler (centred on what is visible) or hide it. The toolbar button
 *  and the imgRuler shortcut both mean exactly this. */
export function toggleRuler(ctx: ImageEditorCtx): void {
  const s = ctx.tools.get();
  ctx.tools.set({ ...s, ruler: s.ruler ? null : defaultRuler(ctx) });
}

export interface RulerHandle {
  /** The edge (±1) a gesture starting at this canvas point should follow, or 0. */
  catchEdge(x: number, y: number): 1 | -1 | 0;
  /** Constrain a canvas point to `side`, `markHalf` (canvas px) off the edge. */
  constrain(side: 1 | -1, markHalf: number, x: number, y: number): [number, number];
  /** Light the edge ink is following (0 = none). */
  light(side: 1 | -1 | 0): void;
  /** The widget element while shown (the ink surface stacks under it). */
  readonly el: HTMLElement | null;
  dispose(): void;
}

/** Canvas px per screen css px at the current view. */
function canvasPerCss(ctx: ImageEditorCtx): number {
  const v = ctx.view.store.get();
  return v.zoom > 0 ? v.dpr / v.zoom : 1;
}

export function mountRuler(ctx: ImageEditorCtx, onShow?: (el: HTMLElement | null) => void): RulerHandle {
  let el: HTMLElement | null = null;
  let readout: HTMLElement | null = null;
  /** The angle the gesture/keys have accumulated before snapping. */
  let raw = 0;
  let lengthCss = 0;
  let lit: 1 | -1 | 0 = 0;
  // Last written values: every DOM write below happens only on a change.
  let shownAngle = NaN;
  let shownTransform = "";
  let shownLen = -1;
  let shownMinor = -1;

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: {
    cx: number;
    cy: number;
    angle: number;
    startMid: { x: number; y: number };
    startTwist: number | null;
  } | null = null;

  const setRuler = (next: RulerState): void => {
    const s = ctx.tools.get();
    const cur = s.ruler;
    if (cur && cur.cx === next.cx && cur.cy === next.cy && cur.angle === next.angle) return;
    ctx.tools.set({ ...s, ruler: next });
  };

  const syncRaw = (r: RulerState): void => {
    if (snapAngle(raw) !== r.angle) raw = r.angle;
  };

  const place = (): void => {
    const r = ctx.tools.get().ruler;
    if (!el || !r) return;
    const stageRect = ctx.stage.getBoundingClientRect();
    const c = ctx.view.canvasToClient(r.cx, r.cy);
    const x = c.x - stageRect.left - ctx.stage.clientLeft;
    const y = c.y - stageRect.top - ctx.stage.clientTop;
    const cssPer = 1 / canvasPerCss(ctx);
    const minor = tickSpacingCss(cssPer);
    const major = minor * MAJOR_EVERY;
    // Long enough to cross the stage at any angle, and a whole number of major
    // ticks either side of the centre so a tick always sits under the readout.
    const diag = Math.hypot(stageRect.width, stageRect.height) * 2;
    const len = Math.max(2 * major, Math.ceil(diag / (2 * major)) * 2 * major);
    lengthCss = len;
    if (len !== shownLen) {
      shownLen = len;
      el.style.width = `${len}px`;
    }
    if (minor !== shownMinor) {
      shownMinor = minor;
      el.style.setProperty("--imged-ruler-minor", `${minor}px`);
      el.style.setProperty("--imged-ruler-major", `${major}px`);
    }
    const t = `translate(${x}px, ${y}px) rotate(${r.angle}deg) translate(-50%, -50%)`;
    if (t !== shownTransform) {
      shownTransform = t;
      el.style.transform = t;
    }
    if (r.angle !== shownAngle) {
      shownAngle = r.angle;
      const deg = Math.round(r.angle * 10) / 10;
      readout!.textContent = `${deg}°`;
      el.setAttribute("aria-valuenow", String(deg));
      el.setAttribute("aria-valuetext", `${deg}°`);
    }
  };

  /* ---------- gestures on the ruler ---------- */

  const onPointerDown = (e: PointerEvent): void => {
    if (!el) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const r = ctx.tools.get().ruler;
    if (!r) return;
    // The ruler owns this pointer: the stage must not start a pan or a pinch
    // under it, and the ink surface beneath must not start a mark.
    e.stopPropagation();
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer ids throw */
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    beginDrag(r);
  };

  const beginDrag = (r: RulerState): void => {
    syncRaw(r);
    const pts = [...pointers.values()];
    const mid = midpoint(pts);
    drag = {
      cx: r.cx,
      cy: r.cy,
      angle: raw,
      startMid: mid,
      startTwist: pts.length >= 2 ? twist(pts[0]!, pts[1]!) : null,
    };
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || !pointers.has(e.pointerId)) return;
    e.stopPropagation();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.values()];
    const mid = midpoint(pts);
    const a = ctx.view.clientToCanvas(drag.startMid.x, drag.startMid.y);
    const b = ctx.view.clientToCanvas(mid.x, mid.y);
    let angle = ctx.tools.get().ruler?.angle ?? 0;
    if (drag.startTwist !== null && pts.length >= 2) {
      raw = drag.angle + (twist(pts[0]!, pts[1]!) - drag.startTwist);
      angle = snapAngle(raw);
    }
    setRuler({ cx: drag.cx + (b.x - a.x), cy: drag.cy + (b.y - a.y), angle });
  };

  const onPointerEnd = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    e.stopPropagation();
    const r = ctx.tools.get().ruler;
    // A finger lifting from a two-finger twist restarts a plain drag from
    // where the ruler now is, so the remaining finger does not jump it.
    if (pointers.size > 0 && r) beginDrag(r);
    else drag = null;
  };

  const onWheel = (e: WheelEvent): void => {
    // Ctrl+wheel is the view's zoom, everywhere on the stage.
    if (e.ctrlKey) return;
    const r = ctx.tools.get().ruler;
    // Chromium delivers Shift+wheel as a HORIZONTAL wheel (deltaY 0, deltaX
    // set): reading deltaY alone let the 15° step fall through to the view,
    // which panned the canvas instead. `!d` also drops a NaN delta.
    const d = e.deltaY || e.deltaX;
    if (!r || !d) return;
    e.preventDefault();
    e.stopPropagation();
    rotateBy((d > 0 ? 1 : -1) * (e.shiftKey ? SNAP_STEP_DEG : 1));
  };

  const rotateBy = (deg: number): void => {
    const r = ctx.tools.get().ruler;
    if (!r) return;
    syncRaw(r);
    raw = normalizeAngle(raw + deg);
    setRuler({ ...r, angle: snapAngle(raw) });
  };

  const onKey = (e: KeyboardEvent): void => {
    if (shortcutsBlocked() || document.querySelector(".modal-backdrop")) return;
    const dir =
      e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : null;
    if (!dir || e.altKey) return;
    const r = ctx.tools.get().ruler;
    if (!r) return;
    e.preventDefault();
    // The select tool nudges the selected layer on bare arrows; while the ruler
    // has focus the arrows are the ruler's.
    e.stopPropagation();
    if (e.ctrlKey) {
      const sign = dir[0]! + -dir[1]!;
      rotateBy(sign * (e.shiftKey ? SNAP_STEP_DEG : 1));
      return;
    }
    const step = (e.shiftKey ? 10 : 1) * canvasPerCss(ctx);
    setRuler({ ...r, cx: r.cx + dir[0]! * step, cy: r.cy + dir[1]! * step });
  };

  /* ---------- show / hide ---------- */

  const show = (): void => {
    if (el) return;
    el = document.createElement("div");
    el.className = "imged-ruler";
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", "Ruler angle");
    el.setAttribute("aria-valuemin", "-179");
    el.setAttribute("aria-valuemax", "180");
    el.title = RULER_TITLE;
    el.style.height = `${RULER_THICKNESS_CSS}px`;
    readout = document.createElement("span");
    readout.className = "imged-ruler__readout mono";
    el.appendChild(readout);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerEnd);
    el.addEventListener("pointercancel", onPointerEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", onKey);
    shownAngle = NaN;
    shownTransform = "";
    shownLen = -1;
    shownMinor = -1;
    ctx.stage.appendChild(el);
    lit = 0;
    onShow?.(el);
  };

  const hide = (): void => {
    if (!el) return;
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerEnd);
    el.removeEventListener("pointercancel", onPointerEnd);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("keydown", onKey);
    el.remove();
    el = null;
    readout = null;
    pointers.clear();
    drag = null;
    onShow?.(null);
  };

  const sync = (): void => {
    const r = ctx.tools.get().ruler;
    if (!r) {
      hide();
      return;
    }
    show();
    place();
  };

  let lastRuler = ctx.tools.get().ruler;
  const unTools = ctx.tools.subscribe((s) => {
    if (s.ruler === lastRuler) return;
    lastRuler = s.ruler;
    sync();
  });
  const unView = ctx.view.store.subscribe(() => {
    if (el) place();
  });
  sync();

  return {
    catchEdge(x: number, y: number): 1 | -1 | 0 {
      const r = ctx.tools.get().ruler;
      if (!r || !el) return 0;
      const k = canvasPerCss(ctx);
      return edgeNear(r, x, y, (RULER_THICKNESS_CSS / 2) * k, EDGE_CATCH_CSS * k, (lengthCss / 2) * k);
    },
    constrain(side: 1 | -1, markHalf: number, x: number, y: number): [number, number] {
      const r = ctx.tools.get().ruler;
      if (!r) return [x, y];
      return projectToEdge(r, side, (RULER_THICKNESS_CSS / 2) * canvasPerCss(ctx) + markHalf, x, y);
    },
    light(side: 1 | -1 | 0): void {
      if (side === lit || !el) {
        lit = side;
        return;
      }
      lit = side;
      el.classList.toggle("imged-ruler--edge-top", side === -1);
      el.classList.toggle("imged-ruler--edge-bottom", side === 1);
    },
    get el(): HTMLElement | null {
      return el;
    },
    dispose(): void {
      unTools();
      unView();
      hide();
    },
  };
}

function midpoint(pts: { x: number; y: number }[]): { x: number; y: number } {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0]!;
  return { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 };
}

/** Direction of the line through two fingers, degrees. */
function twist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}
