// The image editor's view: zoom and pan over the stage, the canvas backing
// store sized to the stage's device pixels, and the conversions between client
// (CSS) px and canvas px every tool goes through.
//
// Units, once, because every bug in this file would be a unit mix-up:
//   - canvas px  — the image's own pixels (timeline.width × height).
//   - device px  — the <canvas> backing store, = stage CSS px × devicePixelRatio.
//   - CSS/client px — what pointer events and layout report.
// `zoom` is device px per canvas px, and (panX, panY) is where canvas (0,0)
// lands in the backing store, in device px (render/index.ts `ViewXf`). So
// "100%" is one image pixel per SCREEN pixel, whatever the display scaling —
// the only definition under which a 1 px pen line is actually one pixel.
//
// The maths is pure and exported (the tests run under node, with no DOM);
// `createViewController` is a thin shell that owns the listeners. At idle:
// one ResizeObserver, one DPR media query, and listeners that only ever fire
// on input — no timer, no frame loop.

import { settingsStore } from "../core/session";
import {
  isTypingTarget,
  normalizeChord,
  resolveChord,
  shortcutsBlocked,
} from "../core/shortcuts";
import type { ActionId } from "../core/types";
import { Store } from "../core/store";
import type { ViewController, ViewState } from "./context";
import type { ViewXf } from "./render";

/** Upper zoom bound: 32 device px per canvas px — pixel-level work. */
export const ZOOM_MAX = 32;
/** The lower bound, unless the canvas is so large that fitting it needs less. */
export const ZOOM_FLOOR = 0.01;
/** Space left around the canvas by `fit()`, per side, in CSS px. */
export const FIT_MARGIN_CSS = 24;
/** However far the user pans, this much of the canvas (CSS px, or all of it
 *  when it is smaller) stays inside the stage: a canvas flung off-screen is a
 *  dead end with no visible way back but a shortcut the user may not know. */
export const PAN_KEEP_CSS = 48;

/* ------------------------------------------------------------------ */
/* Pure maths                                                          */
/* ------------------------------------------------------------------ */

/** The zoom at which the whole canvas fits the stage with the margin. Always
 *  finite and > 0, whatever the inputs (a 0×0 stage during layout, a crafted
 *  canvas size), because every other bound is derived from it. */
export function fitZoom(canvasW: number, canvasH: number, stageW: number, stageH: number, dpr: number): number {
  const m = 2 * FIT_MARGIN_CSS * dpr;
  const aw = Math.max(1, stageW - m);
  const ah = Math.max(1, stageH - m);
  const z = Math.min(aw / Math.max(1, canvasW), ah / Math.max(1, canvasH));
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Zoom bounds for a view whose fit zoom is `fit`: [min(fit, 0.01), 32]. */
export function zoomBounds(fit: number): { min: number; max: number } {
  return { min: Math.min(fit, ZOOM_FLOOR), max: ZOOM_MAX };
}

export function clampZoom(z: number, fit: number): number {
  const { min, max } = zoomBounds(fit);
  return Math.min(max, Math.max(min, z));
}

/** Whole canvas visible and centred (device px throughout). */
export function fitView(canvasW: number, canvasH: number, stageW: number, stageH: number, dpr: number): ViewXf {
  const zoom = fitZoom(canvasW, canvasH, stageW, stageH, dpr);
  return centred(zoom, canvasW, canvasH, stageW, stageH);
}

/** `zoom` with the canvas centred in the stage. */
export function centred(zoom: number, canvasW: number, canvasH: number, stageW: number, stageH: number): ViewXf {
  return { zoom, panX: (stageW - canvasW * zoom) / 2, panY: (stageH - canvasH * zoom) / 2 };
}

/** Zoom by `factor` about the device point (dx, dy), clamped to [min, max]:
 *  the canvas point under (dx, dy) stays under it. The pan follows from the
 *  zoom actually applied, so a clamped zoom still keeps the point fixed. */
export function zoomAbout(v: ViewXf, factor: number, dx: number, dy: number, min: number, max: number): ViewXf {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const zoom = Math.min(max, Math.max(min, v.zoom * f));
  const cx = (dx - v.panX) / v.zoom;
  const cy = (dy - v.panY) / v.zoom;
  return { zoom, panX: dx - cx * zoom, panY: dy - cy * zoom };
}

/** Client (CSS) px relative to the stage's top-left → canvas px. */
export function stageCssToCanvas(v: ViewXf, dpr: number, cssX: number, cssY: number): { x: number; y: number } {
  return { x: (cssX * dpr - v.panX) / v.zoom, y: (cssY * dpr - v.panY) / v.zoom };
}

/** Canvas px → client (CSS) px relative to the stage's top-left. */
export function canvasToStageCss(v: ViewXf, dpr: number, x: number, y: number): { x: number; y: number } {
  return { x: (x * v.zoom + v.panX) / dpr, y: (y * v.zoom + v.panY) / dpr };
}

/** Keep at least `keep` device px of the canvas (or all of it when it is
 *  smaller) inside the stage on each axis. Same reference when nothing moved. */
export function clampPan(
  v: ViewXf,
  canvasW: number,
  canvasH: number,
  stageW: number,
  stageH: number,
  keep: number,
): ViewXf {
  const axis = (pan: number, size: number, stage: number): number => {
    const k = Math.min(keep, size, stage);
    return Math.min(stage - k, Math.max(k - size, pan));
  };
  const panX = axis(v.panX, canvasW * v.zoom, stageW);
  const panY = axis(v.panY, canvasH * v.zoom, stageH);
  return panX === v.panX && panY === v.panY ? v : { zoom: v.zoom, panX, panY };
}

/** Ctrl+wheel zoom factor: 2^(−deltaY/300) — one notch (≈100 px) is ×0.79/×1.26. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.pow(2, -deltaY / 300);
}

/** A wheel delta in CSS px, whatever unit the device reported it in. */
export function wheelPixels(delta: number, deltaMode: number, pagePx: number): number {
  if (deltaMode === 1) return delta * 16; // lines
  if (deltaMode === 2) return delta * pagePx; // pages
  return delta;
}

/** The zoom levels the buttons and Ctrl+= / Ctrl+- step through: round
 *  percentages a user can name, so a few presses always land back on 100%. */
export const ZOOM_STEPS: readonly number[] = [
  0.01, 0.02, 0.03, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8,
  12, 16, 24, 32,
];

/** The next step above (dir 1) or below (dir −1) `z`, or `z` itself at the
 *  end of the ladder. A zoom already ON a step moves to its neighbour; one
 *  between steps (after a wheel or a pinch) moves to the nearest in that
 *  direction. */
export function zoomStep(z: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) {
    for (const s of ZOOM_STEPS) if (s > z * (1 + eps)) return s;
    return z;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i]!;
    if (s < z * (1 - eps)) return s;
  }
  return z;
}

/** Re-express a view for a new devicePixelRatio: the same canvas stays at the
 *  same place and the same apparent (CSS) size. */
export function rescaleForDpr(v: ViewXf, ratio: number): ViewXf {
  return { zoom: v.zoom * ratio, panX: v.panX * ratio, panY: v.panY * ratio };
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

/** The chords that hold-to-pan, rebuilt from Settings (imgPanHold only). */
function panBindings(shortcuts: Record<ActionId, string>): Map<string, ActionId[]> {
  const m = new Map<string, ActionId[]>();
  const stored = shortcuts.imgPanHold;
  const chord = typeof stored === "string" ? normalizeChord(stored) : "";
  if (chord) m.set(chord, ["imgPanHold"]);
  return m;
}

const modalOpen = (): boolean => document.querySelector(".modal-backdrop") !== null;

/** One `ResizeObserver` on `stage` and one DPR listener; `fit()` on mount and
 *  on the first resize. `getCanvasSize` is read live (a crop or a canvas
 *  resize changes it). `dispose()` disconnects everything it attached. */
export function createViewController(
  stage: HTMLElement,
  canvas: HTMLCanvasElement,
  getCanvasSize: () => { w: number; h: number },
): ViewController & { dispose(): void } {
  let dpr = window.devicePixelRatio || 1;
  const rect0 = stage.getBoundingClientRect();
  const store = new Store<ViewState>({
    zoom: 1,
    panX: 0,
    panY: 0,
    dpr,
    stageW: Math.max(0, Math.round(rect0.width * dpr)),
    stageH: Math.max(0, Math.round(rect0.height * dpr)),
  });
  // True until the user zooms or pans: while it holds, a window resize or a
  // monitor change REFITS, so "the whole image" stays the whole image. Once
  // they have chosen a view, a resize keeps it (the point at the stage centre
  // stays put) — including mid-stroke.
  let fitted = true;
  let disposed = false;

  const canvasDims = (): { w: number; h: number } => {
    const c = getCanvasSize();
    return { w: Math.max(1, c.w), h: Math.max(1, c.h) };
  };
  const currentFit = (s: ViewState = store.get()): number => {
    const c = canvasDims();
    return fitZoom(c.w, c.h, s.stageW, s.stageH, s.dpr);
  };

  /** Publish a view, clamped so some of the canvas always stays in sight. */
  const publish = (v: ViewXf, base: ViewState = store.get()): void => {
    const c = canvasDims();
    const next = clampPan(v, c.w, c.h, base.stageW, base.stageH, PAN_KEEP_CSS * base.dpr);
    const s = store.get();
    if (
      next.zoom === s.zoom &&
      next.panX === s.panX &&
      next.panY === s.panY &&
      base.stageW === s.stageW &&
      base.stageH === s.stageH &&
      base.dpr === s.dpr
    ) {
      return;
    }
    store.set({ ...base, zoom: next.zoom, panX: next.panX, panY: next.panY });
  };

  const sizeBackingStore = (w: number, h: number): void => {
    // Only on a real change: assigning width/height clears the bitmap even
    // when the value is the same, which would blank the stage for a frame.
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };
  sizeBackingStore(store.get().stageW, store.get().stageH);

  const fit = (): void => {
    fitted = true;
    const s = store.get();
    const c = canvasDims();
    publish(fitView(c.w, c.h, s.stageW, s.stageH, s.dpr));
  };

  const actual = (): void => {
    fitted = false;
    const s = store.get();
    const c = canvasDims();
    publish(centred(clampZoom(1, currentFit()), c.w, c.h, s.stageW, s.stageH));
  };

  const zoomAt = (factor: number, clientX: number, clientY: number): void => {
    const s = store.get();
    const r = stage.getBoundingClientRect();
    const { min, max } = zoomBounds(currentFit());
    const next = zoomAbout(s, factor, (clientX - r.left) * s.dpr, (clientY - r.top) * s.dpr, min, max);
    if (next.zoom === s.zoom && next.panX === s.panX && next.panY === s.panY) return;
    fitted = false;
    publish(next);
  };

  const panBy = (dxCss: number, dyCss: number): void => {
    if (dxCss === 0 && dyCss === 0) return;
    const s = store.get();
    fitted = false;
    publish({ zoom: s.zoom, panX: s.panX + dxCss * s.dpr, panY: s.panY + dyCss * s.dpr });
  };

  const clientToCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const s = store.get();
    const r = stage.getBoundingClientRect();
    return stageCssToCanvas(s, s.dpr, clientX - r.left, clientY - r.top);
  };

  const canvasToClient = (x: number, y: number): { x: number; y: number } => {
    const s = store.get();
    const r = stage.getBoundingClientRect();
    const p = canvasToStageCss(s, s.dpr, x, y);
    return { x: p.x + r.left, y: p.y + r.top };
  };

  /* ---------------- stage size and DPR ---------------- */

  let firstResize = true;
  const onStageSize = (cssW: number, cssH: number): void => {
    if (disposed) return;
    const s = store.get();
    const w = Math.max(0, Math.round(cssW * dpr));
    const h = Math.max(0, Math.round(cssH * dpr));
    const dprChanged = s.dpr !== dpr;
    if (w === s.stageW && h === s.stageH && !dprChanged && !firstResize) return;
    const wasFirst = firstResize;
    firstResize = false;
    sizeBackingStore(w, h);
    const base: ViewState = { ...s, dpr, stageW: w, stageH: h };
    if (fitted || wasFirst) {
      const c = canvasDims();
      fitted = true;
      publish(fitView(c.w, c.h, w, h, dpr), base);
      return;
    }
    // Keep the user's view: the same apparent zoom, and the canvas point that
    // was at the stage centre stays at the centre.
    const v = dprChanged ? rescaleForDpr(s, dpr / s.dpr) : { zoom: s.zoom, panX: s.panX, panY: s.panY };
    const oldCx = dprChanged ? (s.stageW * dpr) / s.dpr / 2 : s.stageW / 2;
    const oldCy = dprChanged ? (s.stageH * dpr) / s.dpr / 2 : s.stageH / 2;
    publish({ zoom: v.zoom, panX: v.panX + (w / 2 - oldCx), panY: v.panY + (h / 2 - oldCy) }, base);
  };

  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    if (e) onStageSize(e.contentRect.width, e.contentRect.height);
  });
  ro.observe(stage);

  // A DPR change (the window dragged to a monitor with different scaling)
  // does not resize the stage in CSS px, so the observer never hears of it.
  // The query names the CURRENT ratio and is re-armed on every change.
  let dprQuery: MediaQueryList | null = null;
  const onDpr = (): void => {
    dprQuery?.removeEventListener("change", onDpr);
    dprQuery = null;
    if (disposed) return;
    dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    onStageSize(r.width, r.height);
    armDpr();
  };
  const armDpr = (): void => {
    if (typeof window.matchMedia !== "function") return;
    dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    dprQuery.addEventListener("change", onDpr);
  };
  armDpr();

  /* ---------------- wheel ---------------- */

  /** Pointers down on the stage that are NOT a pan (a stroke, a drag): a
   *  Ctrl+wheel then is ignored, so the image cannot slide under a pen. */
  const toolPointers = new Set<number>();

  const onWheel = (e: WheelEvent): void => {
    // A surface that consumed the wheel (the ruler rotates on it) marks it so.
    if (e.defaultPrevented) return;
    // Always prevented: an unhandled Ctrl+wheel zooms the whole WebView, and
    // a plain one would scroll nothing useful.
    e.preventDefault();
    const page = store.get().stageH / store.get().dpr || 600;
    const dy = wheelPixels(e.deltaY, e.deltaMode, page);
    const dx = wheelPixels(e.deltaX, e.deltaMode, page);
    if (e.ctrlKey) {
      if (toolPointers.size > 0) return;
      zoomAt(wheelZoomFactor(dy), e.clientX, e.clientY);
      return;
    }
    // Shift turns the wheel horizontal. Chromium may already have moved the
    // delta to X for a Shift+wheel; either way the larger one is the gesture.
    if (e.shiftKey) panBy(-(dx !== 0 ? dx : dy), 0);
    else panBy(-dx, -dy);
  };
  stage.addEventListener("wheel", onWheel, { passive: false });

  /* ---------------- hold to pan (Space by default) ---------------- */

  let bindings = panBindings(settingsStore.get().shortcuts);
  const unsubSettings = settingsStore.subscribe((s, prev) => {
    if (s.shortcuts !== prev.shortcuts) bindings = panBindings(s.shortcuts);
  });

  let holdCode: string | null = null;
  const paintPanClass = (): void => {
    stage.classList.toggle("imged-stage--pan", holdCode !== null || drag !== null || pinch !== null);
    stage.classList.toggle("imged-stage--panning", drag !== null || pinch !== null);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (holdCode !== null) {
      // The held key's own auto-repeat: keep it from scrolling or clicking a
      // focused button, and do nothing else.
      if (e.code === holdCode) e.preventDefault();
      return;
    }
    // The §2.8 guards, all of them: this is a key handler of its own, outside
    // the ShortcutManager, so it re-applies what the manager would.
    if (e.repeat || isTypingTarget(e.target) || shortcutsBlocked() || modalOpen()) return;
    if (resolveChord(e, bindings) !== "imgPanHold") return;
    e.preventDefault();
    holdCode = e.code || e.key;
    paintPanClass();
  };
  const releaseHold = (): void => {
    if (holdCode === null) return;
    holdCode = null;
    paintPanClass();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (holdCode !== null && (e.code || e.key) === holdCode) releaseHold();
  };
  const onBlur = (): void => {
    releaseHold();
    endDrag();
    endPinch();
    toolPointers.clear();
    pens.clear();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") onBlur();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  /* ---------------- pointer pans: middle drag, hold + drag, two fingers ---------------- */

  let drag: { id: number; x: number; y: number } | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let firstTouchOnRuler = false;
  let pinch: { a: number; b: number; dist: number; mx: number; my: number } | null = null;
  // Pens currently down. A palm resting on the screen while writing lands as
  // touches; two of them must not become a pinch that steals the stroke.
  const pens = new Set<number>();

  const capture = (id: number): void => {
    // Synthetic pointer ids (the E2E, some drivers) throw here.
    try {
      stage.setPointerCapture(id);
    } catch {
      /* not capturable */
    }
  };
  const release = (id: number): void => {
    try {
      if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    } catch {
      /* already gone */
    }
  };
  const endDrag = (): void => {
    if (!drag) return;
    release(drag.id);
    drag = null;
    paintPanClass();
  };
  const endPinch = (): void => {
    if (!pinch) return;
    release(pinch.a);
    release(pinch.b);
    pinch = null;
    paintPanClass();
  };
  const pinchGeometry = (): { dist: number; mx: number; my: number } | null => {
    if (!pinch) return null;
    const a = touches.get(pinch.a);
    const b = touches.get(pinch.b);
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  // CAPTURE phase on the stage: a pan must claim the pointer before any tool
  // surface inside the stage (ink, select, crop) sees the pointerdown.
  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      if (touches.size === 0) {
        firstTouchOnRuler = e.target instanceof Element && e.target.closest('[role="slider"]') !== null;
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Two fingers pan and pinch — unless the first finger is on the ruler,
      // where two fingers rotate the ruler instead (ink/ruler.ts owns that),
      // or a pen is down, where they are the writing hand's palm.
      if (touches.size === 2 && !firstTouchOnRuler && !pinch && !drag && pens.size === 0) {
        const [a, b] = [...touches.keys()] as [number, number];
        pinch = { a, b, dist: 0, mx: 0, my: 0 };
        const g = pinchGeometry()!;
        pinch.dist = g.dist;
        pinch.mx = g.mx;
        pinch.my = g.my;
        capture(a);
        capture(b);
        // Both fingers are the pinch's now, not a tool's.
        toolPointers.delete(a);
        toolPointers.delete(b);
        paintPanClass();
        e.stopPropagation();
        e.preventDefault();
      }
      if (pinch) e.stopPropagation();
      else toolPointers.add(e.pointerId);
      return;
    }
    const hold = holdCode !== null && e.button === 0;
    if (e.button === 1 || hold) {
      if (drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e.pointerId);
      paintPanClass();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (e.pointerType === "pen") pens.add(e.pointerId);
    toolPointers.add(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      panBy(dx, dy);
      e.stopPropagation();
      return;
    }
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || (e.pointerId !== pinch.a && e.pointerId !== pinch.b)) return;
    e.stopPropagation();
    const g = pinchGeometry();
    if (!g) return;
    if (pinch.dist > 0 && g.dist > 0) zoomAt(g.dist / pinch.dist, g.mx, g.my);
    panBy(g.mx - pinch.mx, g.my - pinch.my);
    pinch.dist = g.dist;
    pinch.mx = g.mx;
    pinch.my = g.my;
  };

  const onPointerEnd = (e: PointerEvent): void => {
    toolPointers.delete(e.pointerId);
    pens.delete(e.pointerId);
    if (drag && e.pointerId === drag.id) {
      endDrag();
      e.stopPropagation();
      return;
    }
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) {
      endPinch();
      e.stopPropagation();
    }
    if (touches.size === 0) firstTouchOnRuler = false;
  };

  stage.addEventListener("pointerdown", onPointerDown, true);
  stage.addEventListener("pointermove", onPointerMove, true);
  stage.addEventListener("pointerup", onPointerEnd, true);
  stage.addEventListener("pointercancel", onPointerEnd, true);
  // A tool pointer released outside the stage without capture never reaches
  // the stage: forget it here, or Ctrl+wheel would stay ignored.
  const onWindowPointerEnd = (e: PointerEvent): void => {
    toolPointers.delete(e.pointerId);
    pens.delete(e.pointerId);
  };
  window.addEventListener("pointerup", onWindowPointerEnd, true);
  window.addEventListener("pointercancel", onWindowPointerEnd, true);
  // A middle click must not start the WebView's autoscroll.
  const onAuxDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };
  stage.addEventListener("mousedown", onAuxDown);

  fit();

  return {
    store,
    canvasToClient,
    clientToCanvas,
    fit,
    actual,
    zoomAt,
    panBy,
    get panning(): boolean {
      return holdCode !== null || drag !== null || pinch !== null;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      dprQuery?.removeEventListener("change", onDpr);
      dprQuery = null;
      unsubSettings();
      stage.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      stage.removeEventListener("pointerdown", onPointerDown, true);
      stage.removeEventListener("pointermove", onPointerMove, true);
      stage.removeEventListener("pointerup", onPointerEnd, true);
      stage.removeEventListener("pointercancel", onPointerEnd, true);
      window.removeEventListener("pointerup", onWindowPointerEnd, true);
      window.removeEventListener("pointercancel", onWindowPointerEnd, true);
      stage.removeEventListener("mousedown", onAuxDown);
      endDrag();
      endPinch();
    },
  };
}
