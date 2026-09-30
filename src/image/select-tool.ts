// The select/move tool: oriented hit testing, the selection box, move (with
// the centre snap), uniform corner scale, arrow-key nudge and per-layer crop.
// Active only while the tool is "select" and the stage mode is idle (crop
// mode is this tool's own "crop-layer").
//
// Native-pixel geometry throughout: a layer's on-canvas size is its source
// size × transform.scale, with no fit-to-canvas and no 0.1-4 clamp — the only
// bound on scale is IMAGE_SCALE_GUARD, a crafted-file guard. Everything that
// maps source px to canvas px goes through geom.ts's `layerToCanvas`, the SAME
// affine the renderer draws with, so the chrome, the hit test and the crop
// maths cannot disagree with the pixels about which way a rotated or flipped
// layer faces.
//
// Zero idle cost. The chrome is a handful of DOM nodes written only when their
// geometry signature changes, driven by store subscriptions (which the Store
// already batches to one microtask) — never a requestAnimationFrame. The
// overlay does not take pointer events at all outside crop mode (only the four
// corner handles do): the canvas underneath stays the hit target, and a
// pointerdown is read by ONE delegated listener on the stage.
//
// Live edits use the slider pattern: `session.replace()` while the pointer is
// down (no history), ONE `commitFrom(before)` on release, with the baseline
// captured only once the drag leaves a 4 px dead zone — a click that selects
// never writes history. Escape, pointercancel, a window blur and dispose all
// REVERT a drag in flight (the video overlay's ruling: a half-drag nobody
// finished must not land in the project with nothing for Ctrl+Z to reach).

import "./layers-panel.css";
import type { ClipCrop, Generator, ProjectFile } from "../core/types";
import { normalizeHexColor, settingsStore } from "../core/session";
import { blockShortcuts, isTypingTarget, shortcutsBlocked } from "../core/shortcuts";
import { snapToCenter, type WindowHandle } from "../editor/preview/canvas-math";
import { fontString } from "../editor/media/generators";
import type { ImageEditorCtx } from "./context";
import { IMAGE_SCALE_GUARD, canvasToLayer, hitLayer, layerCorners, layerToCanvas } from "./geom";
import { findLayer, layersOf, setLayerTransform, type Layer } from "./layers";
import { strokeBounds } from "./ink/paint";

/* ------------------------------------------------------------------ */
/* Pure geometry (exported for the unit tests)                          */
/* ------------------------------------------------------------------ */

/** DOMMatrix order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [number, number, number, number, number, number];
export interface Vec2 {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Centre-snap catch radius in SCREEN (CSS) px — the video overlay's number. */
export const SNAP_SCREEN_PX = 8;
/** Drag dead zone in client px (Manhattan), the video overlay's number. */
export const MOVE_THRESHOLD_PX = 4;
/** Smallest crop, in source px. The video editor's 8 px floor (CROP_MIN) is a
 *  video rule; an image layer may legitimately be a few pixels wide. */
export const CROP_MIN_SRC = 1;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** The snap radius in CANVAS px: 8 screen px at `zoom` device px per canvas px
 *  and `dpr` device px per CSS px, i.e. 8 / (zoom / dpr). A constant on-screen
 *  distance at every zoom. */
export function snapThreshold(zoom: number, dpr: number): number {
  return (SNAP_SCREEN_PX * dpr) / zoom;
}

export function applyAffine(m: Affine, x: number, y: number): Vec2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** The inverse of the LINEAR part of `m` applied to a vector (a delta). */
function linInv(m: Affine, v: Vec2): Vec2 {
  const det = m[0] * m[3] - m[2] * m[1];
  return { x: (m[3] * v.x - m[2] * v.y) / det, y: (-m[1] * v.x + m[0] * v.y) / det };
}

/** Canvas point → source point through the full inverse of `m`. */
export function invAffine(m: Affine, x: number, y: number): Vec2 {
  return linInv(m, { x: x - m[4], y: y - m[5] });
}

/** The crafted-file guard, and nothing else: no 0.1-4 clamp in image mode. */
export function guardScale(s: number): number {
  if (!Number.isFinite(s)) return IMAGE_SCALE_GUARD.min;
  return clamp(s, IMAGE_SCALE_GUARD.min, IMAGE_SCALE_GUARD.max);
}

/** Corner-drag scale: start × dist / startDist, uniform. The ABSOLUTE distance
 *  from the pivot, so a drag that crosses the pivot grows again instead of
 *  going negative; the guard is the only bound. A degenerate start (the
 *  pointer went down on the pivot itself) keeps the start scale. */
export function cornerScale(startScale: number, startDist: number, dist: number): number {
  if (!(startDist > 1e-6) || !Number.isFinite(dist)) return startScale;
  return guardScale(startScale * (Math.abs(dist) / startDist));
}

/** Layer offset after scaling by `r` about the canvas point `pivot`, where
 *  `centre` is the layer centre (W/2 + x, H/2 + y) at the start. Every canvas
 *  point of a layer is centre + L·(p − cropCentre); scaling L by r keeps
 *  `pivot` fixed when centre' = pivot − r·(pivot − centre). A pivot AT the
 *  centre (photo, text, solid) leaves x/y exactly unchanged. */
export function scaleAboutPivot(
  startX: number,
  startY: number,
  centre: Vec2,
  pivot: Vec2,
  r: number,
): Vec2 {
  return {
    x: startX + (1 - r) * (pivot.x - centre.x),
    y: startY + (1 - r) * (pivot.y - centre.y),
  };
}

/** A move, in whole canvas px (a raster layer dragged by a fractional amount
 *  resamples soft; rounding the DELTA keeps whatever grid alignment the layer
 *  started with). `boxOff` is the chrome box centre's offset from the canvas
 *  centre at the start — for a photo that IS x/y; for a drawing it is where
 *  its strokes sit — and the snap brings that centre, not the media box's, onto
 *  the canvas centre. `threshold` null = snapping off. */
export function moveWithSnap(
  startX: number,
  startY: number,
  boxOff: Vec2,
  dx: number,
  dy: number,
  threshold: number | null,
): { x: number; y: number; snappedX: boolean; snappedY: boolean } {
  let bx = boxOff.x + Math.round(dx);
  let by = boxOff.y + Math.round(dy);
  let snappedX = false;
  let snappedY = false;
  if (threshold !== null) {
    const s = snapToCenter(bx, by, threshold);
    bx = s.x;
    by = s.y;
    snappedX = s.snappedX;
    snappedY = s.snappedY;
  }
  return { x: startX + (bx - boxOff.x), y: startY + (by - boxOff.y), snappedX, snappedY };
}

/** Crop + position of one layer during a crop gesture. */
export interface CropPose {
  crop: ClipCrop;
  x: number;
  y: number;
}

const HANDLE_DX: Record<WindowHandle, -1 | 0 | 1> = {
  nw: -1, n: 0, ne: 1, e: 1, se: 1, s: 0, sw: -1, w: -1,
};
const HANDLE_DY: Record<WindowHandle, -1 | 0 | 1> = {
  nw: -1, n: -1, ne: -1, e: 0, se: 1, s: 1, sw: 1, w: 0,
};

/** Keep the SOURCE pinned on the canvas while the crop changes: every canvas
 *  point is C + L·(p − cc) (C = layer centre, cc = crop centre), so the source
 *  stays put when C' = C + L·(cc' − cc). Scale is untouched (native pixels). */
function pinSource(start: CropPose, crop: ClipCrop, m: Affine): CropPose {
  const dcx = crop.x + crop.w / 2 - (start.crop.x + start.crop.w / 2);
  const dcy = crop.y + crop.h / 2 - (start.crop.y + start.crop.h / 2);
  return { crop, x: start.x + m[0] * dcx + m[2] * dcy, y: start.y + m[1] * dcx + m[3] * dcy };
}

/** A crop-window handle dragged by `delta` CANVAS px. The screen-side handle
 *  is pulled back into source space through the inverse of the layer's linear
 *  map (so a rotated or flipped layer moves the source edge that is actually
 *  under the handle), the moved edges follow by L⁻¹·delta in whole source px,
 *  the fixed edges do not move at all, and x/y shift so the source (the ghost)
 *  stays exactly where it was. `m` = layerToCanvas at the gesture start. */
export function cropHandleDrag(
  start: CropPose,
  srcW: number,
  srcH: number,
  m: Affine,
  handle: WindowHandle,
  delta: Vec2,
): CropPose {
  const sd = linInv(m, delta);
  const dir = linInv(m, { x: HANDLE_DX[handle], y: HANDLE_DY[handle] });
  const mag = Math.max(Math.abs(dir.x), Math.abs(dir.y));
  // Rotation is quantized, so each component is 0 or ±1/k (plus float dust
  // from a computed cos/sin): a relative test separates them exactly.
  const moveX = Math.abs(dir.x) > mag * 0.5;
  const moveY = Math.abs(dir.y) > mag * 0.5;
  let left = start.crop.x;
  let right = start.crop.x + start.crop.w;
  let top = start.crop.y;
  let bottom = start.crop.y + start.crop.h;
  if (moveX) {
    if (dir.x < 0) left = clamp(Math.round(left + sd.x), 0, Math.max(0, right - CROP_MIN_SRC));
    else right = clamp(Math.round(right + sd.x), Math.min(srcW, left + CROP_MIN_SRC), srcW);
  }
  if (moveY) {
    if (dir.y < 0) top = clamp(Math.round(top + sd.y), 0, Math.max(0, bottom - CROP_MIN_SRC));
    else bottom = clamp(Math.round(bottom + sd.y), Math.min(srcH, top + CROP_MIN_SRC), srcH);
  }
  return pinSource(start, { x: left, y: top, w: right - left, h: bottom - top }, m);
}

/** Dragging the ghost by `delta` canvas px: the source slides under a window
 *  that stays put (x/y unchanged), the crop moving by −L⁻¹·delta in whole
 *  source px and clamped inside the source. */
export function cropPan(
  start: CropPose,
  srcW: number,
  srcH: number,
  m: Affine,
  delta: Vec2,
): CropPose {
  const sd = linInv(m, delta);
  const { w, h } = start.crop;
  return {
    crop: {
      x: clamp(Math.round(start.crop.x - sd.x), 0, Math.max(0, srcW - w)),
      y: clamp(Math.round(start.crop.y - sd.y), 0, Math.max(0, srcH - h)),
      w,
      h,
    },
    x: start.x,
    y: start.y,
  };
}

/** A crop covering the whole source is no crop: stored as absent, so a crop
 *  dragged back out to the edges leaves the transform as it was. */
export function normalizeCrop(c: ClipCrop, srcW: number, srcH: number): ClipCrop | undefined {
  return c.x === 0 && c.y === 0 && c.w === srcW && c.h === srcH ? undefined : c;
}

/* ------------------------------------------------------------------ */
/* Layer geometry helpers                                               */
/* ------------------------------------------------------------------ */

type Chunks = Extract<Generator, { type: "drawing" }>["chunks"];

/** Union of everything a drawing's strokes can paint, layer-local. Erase
 *  strokes only remove pixels, so they never widen it. null = no strokes (not
 *  hittable; select it from the Layers panel). Cached per chunks array — the
 *  chunks are immutable and replaced on every change. */
const drawingBoxes = new WeakMap<Chunks, Box | null>();
function drawingBounds(chunks: Chunks): Box | null {
  const cached = drawingBoxes.get(chunks);
  if (cached !== undefined) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const chunk of chunks) {
    for (const s of chunk) {
      if (s.t === "erase") continue;
      const b = strokeBounds(s);
      if (!(b.w > 0) && !(b.h > 0)) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
  }
  const box = minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  drawingBoxes.set(chunks, box);
  return box;
}

function srcDims(l: Layer): { w: number; h: number } | null {
  const w = l.media.width;
  const h = l.media.height;
  return w && h && w > 0 && h > 0 ? { w, h } : null;
}

/** The four canvas-px corners of what the selection box frames: the visible
 *  (cropped) box for a photo/text/solid, the strokes' box for a drawing. */
function chromeQuad(l: Layer, W: number, H: number): Vec2[] | null {
  const d = srcDims(l);
  if (!d) return null;
  const g = l.media.generator;
  if (g?.type === "drawing") {
    const b = drawingBounds(g.chunks);
    if (!b) return null;
    const m = layerToCanvas(l.transform, d.w, d.h, W, H);
    return [
      applyAffine(m, b.x, b.y),
      applyAffine(m, b.x + b.w, b.y),
      applyAffine(m, b.x + b.w, b.y + b.h),
      applyAffine(m, b.x, b.y + b.h),
    ];
  }
  return layerCorners(l.transform, d.w, d.h, W, H).map(([x, y]) => ({ x, y }));
}

function aabb(q: Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of q) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Oriented hit test of one layer. A hidden layer is never hit. A transparent
 *  corner of a PNG still counts (the box is the layer, not its alpha). */
function hits(l: Layer, W: number, H: number, px: number, py: number): boolean {
  if (l.hidden) return false;
  const d = srcDims(l);
  if (!d) return false;
  const g = l.media.generator;
  if (g?.type === "drawing") {
    const b = drawingBounds(g.chunks);
    if (!b) return false;
    const p = canvasToLayer(l.transform, d.w, d.h, W, H, px, py);
    return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  }
  return hitLayer(l.transform, d.w, d.h, W, H, px, py);
}

/** Topmost layer under a canvas point. */
function hitTest(p: ProjectFile, px: number, py: number): string | null {
  const { width: W, height: H } = p.timeline;
  for (const l of layersOf(p)) if (hits(l, W, H, px, py)) return l.trackId;
  return null;
}

const croppable = (l: Layer): boolean => l.kind === "photo" || l.kind === "text" || l.kind === "solid";

/* ------------------------------------------------------------------ */
/* Mount                                                                */
/* ------------------------------------------------------------------ */

const CORNERS: WindowHandle[] = ["nw", "ne", "se", "sw"];
const ALL_HANDLES: WindowHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const NUDGE_IDLE_MS = 400;

function div(cls: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}

const modalOpen = (): boolean => document.querySelector(".modal-backdrop") !== null;
const menuOpen = (): boolean => {
  const m = document.querySelector<HTMLElement>(".ctx-menu");
  return m !== null && m.style.display === "block";
};

export function mountSelectTool(ctx: ImageEditorCtx): { dispose(): void } {
  const { session, selection, view, tools, mode, stage, res } = ctx;
  let disposed = false;

  /* ---------------- chrome (built once, toggled) ---------------- */

  const overlay = div("stage-overlay imged-select");
  const selBox = div("stage-overlay__selbox");
  for (const h of CORNERS) {
    const el = div(`stage-overlay__handle stage-overlay__handle--${h}`);
    el.dataset.handle = h;
    selBox.appendChild(el);
  }
  const ghostCanvas = document.createElement("canvas");
  ghostCanvas.className = "imged-select__ghost";
  ghostCanvas.width = 0;
  ghostCanvas.height = 0;
  const ghostBox = div("stage-overlay__ghost");
  const win = div("stage-overlay__window");
  for (const h of ALL_HANDLES) {
    const el = div(`stage-overlay__handle stage-overlay__handle--${h}`);
    el.dataset.crophandle = h;
    win.appendChild(el);
  }
  const guideV = div("stage-overlay__guide stage-overlay__guide--v");
  const guideH = div("stage-overlay__guide stage-overlay__guide--h");
  // The canvas crop's bar (`imged-cropbar`) — one look for both crops.
  const bar = div("imged-cropbar imged-select__cropbar");
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn--sm";
  cancelBtn.textContent = "Cancel";
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "btn btn--primary btn--sm";
  applyBtn.textContent = "Apply";
  bar.append(cancelBtn, applyBtn);
  // z-order inside the overlay: ghost < ghost hit box < window < selbox < guides < bar
  overlay.append(ghostCanvas, ghostBox, win, selBox, guideV, guideH, bar);
  stage.appendChild(overlay);

  /** Stage-local CSS px of canvas px: css = o + s·canvas, plus the stage's
   *  CSS size. Read from the view (two mapped points) rather than re-derived
   *  from zoom/pan/dpr here, so it can never drift from where the canvas is
   *  actually drawn. Cached until the view changes (its store also carries the
   *  stage size), so a drag reads no layout per pointermove. */
  interface Screen { o: Vec2; s: number; sw: number; sh: number }
  let screenCache: Screen | null = null;
  function screen(): Screen {
    if (screenCache) return screenCache;
    const r = stage.getBoundingClientRect();
    const a = view.canvasToClient(0, 0);
    const b = view.canvasToClient(1, 0);
    screenCache = {
      o: { x: a.x - r.left - stage.clientLeft, y: a.y - r.top - stage.clientTop },
      s: b.x - a.x,
      sw: stage.clientWidth,
      sh: stage.clientHeight,
    };
    return screenCache;
  }

  function place(el: HTMLElement, b: Box, sc: Screen): string {
    const left = sc.o.x + b.x * sc.s;
    const top = sc.o.y + b.y * sc.s;
    const w = b.w * sc.s;
    const h = b.h * sc.s;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    return `${left}|${top}|${w}|${h}`;
  }

  let overlayShown = true;
  let selShown = false;
  let selSig = "";
  let cropSig = "";
  let ghostSig = "";
  let ghostSrc: CanvasImageSource | null = null;
  let guideVShown = false;
  let guideHShown = false;

  function setShown(el: HTMLElement, on: boolean, display = "block"): void {
    el.style.display = on ? display : "none";
  }

  function showGuides(v: boolean, h: boolean): void {
    if (v || h) {
      const p = session.project.timeline;
      const sc = screen();
      if (v) {
        guideV.style.left = `${sc.o.x + (p.width / 2) * sc.s}px`;
        guideV.style.top = `${sc.o.y}px`;
        guideV.style.bottom = "auto";
        guideV.style.height = `${p.height * sc.s}px`;
      }
      if (h) {
        guideH.style.top = `${sc.o.y + (p.height / 2) * sc.s}px`;
        guideH.style.left = `${sc.o.x}px`;
        guideH.style.right = "auto";
        guideH.style.width = `${p.width * sc.s}px`;
      }
    }
    if (v !== guideVShown) {
      setShown(guideV, v);
      guideVShown = v;
    }
    if (h !== guideHShown) {
      setShown(guideH, h);
      guideHShown = h;
    }
  }

  /* ---------------- paint (microtask-coalesced, signature-gated) ---------------- */

  let paintQueued = false;
  function schedulePaint(): void {
    if (paintQueued || disposed) return;
    paintQueued = true;
    queueMicrotask(() => {
      paintQueued = false;
      if (!disposed) paint();
    });
  }

  function paint(): void {
    const md = mode.get();
    const on = tools.get().tool === "select" && md !== "crop-image";
    if (on !== overlayShown) {
      setShown(overlay, on);
      overlayShown = on;
    }
    if (crop) {
      paintCrop(crop);
      return;
    }
    const id = on ? selection.get() : null;
    const l = id ? findLayer(session.project, id) : undefined;
    const quad = l && !l.hidden ? chromeQuad(l, session.project.timeline.width, session.project.timeline.height) : null;
    if (!quad) {
      if (selShown) {
        setShown(selBox, false);
        selShown = false;
        selSig = "";
      }
      return;
    }
    const sc = screen();
    const b = aabb(quad);
    const sig = `${sc.o.x + b.x * sc.s}|${sc.o.y + b.y * sc.s}|${b.w * sc.s}|${b.h * sc.s}`;
    if (!selShown) {
      setShown(selBox, true);
      selShown = true;
    }
    if (sig !== selSig) selSig = place(selBox, b, sc);
  }

  /* ---------------- move / scale gesture ---------------- */

  interface Gesture {
    kind: "move" | "scale";
    trackId: string;
    pointerId: number;
    startClient: Vec2;
    startCanvas: Vec2;
    startX: number;
    startY: number;
    startScale: number;
    /** chrome box centre − canvas centre, at the start */
    boxOff: Vec2;
    /** scale pivot (the chrome box centre) and the layer centre, canvas px */
    pivot: Vec2;
    centre: Vec2;
    startDist: number;
    before: ProjectFile | null;
    armed: boolean;
    release: () => void;
    /** held from arming to the end: a Ctrl+Z between two pointermoves would
     *  be overwritten by the next move and then recorded inside `before`, so
     *  the next undo would bring the undone step back */
    unblock: (() => void) | null;
  }
  let gesture: Gesture | null = null;

  function accepts(target: EventTarget | null): boolean {
    // The canvas (or the bare stage) and our own handles. Anything else on the
    // stage — the ruler, a status chip — is its own widget and keeps its drag.
    if (!(target instanceof Element)) return false;
    if (overlay.contains(target)) return target instanceof HTMLElement && !!target.dataset.handle;
    return target === stage || target instanceof HTMLCanvasElement;
  }

  function capture(pointerId: number): void {
    try { stage.setPointerCapture(pointerId); } catch { /* synthetic pointer */ }
  }
  function uncapture(pointerId: number): void {
    try { stage.releasePointerCapture(pointerId); } catch { /* not captured */ }
  }

  /** Move/up/cancel are read on `window` only while a gesture lives: a
   *  captured pointer (or a synthetic one that could not be captured) may
   *  report anywhere, and nothing listens when nothing is being dragged. */
  function listenWindow(on: boolean): void {
    if (on) {
      window.addEventListener("pointermove", onWindowMove);
      window.addEventListener("pointerup", onWindowUp);
      window.addEventListener("pointercancel", onWindowCancel);
    } else {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowCancel);
    }
  }

  function onStagePointerDown(e: PointerEvent): void {
    // A nudge run still open (arrow held) is a finished edit: record it before
    // any press starts one of its own — a drag, a crop, or another tool's
    // stroke — whose commit would otherwise drop the run's undo entry.
    commitNudge();
    if (disposed || tools.get().tool !== "select") return;
    // One fresh layout read per press, so a stage that moved on the page
    // without the view changing can never leave the chrome offset.
    screenCache = null;
    if (crop) {
      onCropDown(e);
      return;
    }
    if (mode.get() !== "idle" || e.button !== 0 || view.panning || gesture) return;
    if (!accepts(e.target)) return;
    const p = session.project;
    const W = p.timeline.width;
    const H = p.timeline.height;
    const pt = view.clientToCanvas(e.clientX, e.clientY);
    const handle = (e.target as HTMLElement).dataset?.handle as WindowHandle | undefined;
    let trackId: string | null;
    let kind: Gesture["kind"];
    if (handle && selection.get()) {
      trackId = selection.get();
      kind = "scale";
      e.preventDefault();
    } else {
      trackId = hitTest(p, pt.x, pt.y);
      if (trackId !== selection.get()) selection.set(trackId);
      kind = "move";
    }
    const l = trackId ? findLayer(p, trackId) : undefined;
    const quad = l ? chromeQuad(l, W, H) : null;
    if (!l || !quad) return;
    const b = aabb(quad);
    const pivot = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const t = l.transform;
    gesture = {
      kind,
      trackId: l.trackId,
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      startCanvas: pt,
      startX: t.x,
      startY: t.y,
      startScale: t.scale,
      boxOff: { x: pivot.x - W / 2, y: pivot.y - H / 2 },
      pivot,
      centre: { x: W / 2 + t.x, y: H / 2 + t.y },
      startDist: Math.hypot(pt.x - pivot.x, pt.y - pivot.y),
      before: null,
      armed: false,
      release: ctx.holdAutosave(),
      unblock: null,
    };
    capture(e.pointerId);
    listenWindow(true);
  }

  function onWindowMove(e: PointerEvent): void {
    if (crop) {
      onCropMove(e);
      return;
    }
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (view.panning) {
      // A second touch became a pinch: the view owns the pointers now.
      cancelGesture();
      return;
    }
    if (!g.armed) {
      const cdx = e.clientX - g.startClient.x;
      const cdy = e.clientY - g.startClient.y;
      if (Math.abs(cdx) + Math.abs(cdy) <= MOVE_THRESHOLD_PX) return;
      g.armed = true;
      g.before = session.project;
      g.unblock = blockShortcuts();
    }
    const cur = session.project;
    if (!findLayer(cur, g.trackId)) {
      // Removed underneath the drag: nothing left to move, nothing to revert.
      endGesture(false);
      return;
    }
    const pt = view.clientToCanvas(e.clientX, e.clientY);
    let next: ProjectFile;
    if (g.kind === "move") {
      const vs = view.store.get();
      const threshold = settingsStore.get().snapCenterGuides ? snapThreshold(vs.zoom, vs.dpr) : null;
      const m = moveWithSnap(g.startX, g.startY, g.boxOff, pt.x - g.startCanvas.x, pt.y - g.startCanvas.y, threshold);
      showGuides(m.snappedX, m.snappedY);
      next = setLayerTransform(cur, g.trackId, { x: m.x, y: m.y });
    } else {
      const s1 = cornerScale(g.startScale, g.startDist, Math.hypot(pt.x - g.pivot.x, pt.y - g.pivot.y));
      const xy = scaleAboutPivot(g.startX, g.startY, g.centre, g.pivot, s1 / g.startScale);
      next = setLayerTransform(cur, g.trackId, { scale: s1, x: xy.x, y: xy.y });
    }
    session.replace(next);
    ctx.requestRender();
  }

  function onWindowUp(e: PointerEvent): void {
    if (crop) {
      onCropUp(e);
      return;
    }
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    endGesture(true);
  }

  function onWindowCancel(e: PointerEvent): void {
    if (crop) {
      if (cropGesture && e.pointerId === cropGesture.pointerId) endCropGesture(true);
      return;
    }
    if (gesture && e.pointerId === gesture.pointerId) cancelGesture();
  }

  /** Finish the drag: commit ONE history step (only if it armed). */
  function endGesture(commit: boolean): void {
    const g = gesture;
    if (!g) return;
    gesture = null;
    listenWindow(false);
    uncapture(g.pointerId);
    showGuides(false, false);
    g.release();
    g.unblock?.();
    if (commit && g.armed && g.before && findLayer(session.project, g.trackId)) {
      session.commitFrom(g.before);
    }
  }

  /** Escape / pointercancel / blur / dispose: REVERT a drag in flight. Only
   *  while the layer is still there — restoring the whole snapshot after
   *  something removed it would resurrect what was just deleted. */
  function cancelGesture(): void {
    const g = gesture;
    if (!g) return;
    endGesture(false);
    if (g.armed && g.before && findLayer(session.project, g.trackId)) {
      session.replace(g.before);
      ctx.requestRender();
    }
  }

  /* ---------------- per-layer crop ("crop-layer" mode) ---------------- */

  interface CropSession {
    trackId: string;
    before: ProjectFile;
    /** the last project this mode wrote; anything else in the store is foreign */
    lastWritten: ProjectFile;
    unblock: () => void;
    release: () => void;
    unRes: () => void;
    barW: number;
    barH: number;
  }
  let crop: CropSession | null = null;

  interface CropGesture {
    kind: "window" | "pan";
    handle: WindowHandle | null;
    pointerId: number;
    start: CropPose;
    startCanvas: Vec2;
    srcW: number;
    srcH: number;
    m: Affine;
  }
  let cropGesture: CropGesture | null = null;

  function enterCrop(trackId: string): void {
    commitNudge();
    const l = findLayer(session.project, trackId);
    if (!l || l.hidden || !croppable(l) || !srcDims(l) || mode.get() !== "idle") return;
    // Shortcuts are held for the whole session: the crop's live edits carry no
    // history, so an undo in the middle would pop an unrelated step and leave
    // this mode holding a baseline that no longer exists.
    crop = {
      trackId,
      before: session.project,
      lastWritten: session.project,
      unblock: blockShortcuts(),
      release: ctx.holdAutosave(),
      unRes: res.onChange(() => {
        ghostSig = "";
        schedulePaint();
      }),
      barW: 0,
      barH: 0,
    };
    mode.set("crop-layer");
    overlay.classList.add("is-cropping");
    setShown(selBox, false);
    selShown = false;
    selSig = "";
    setShown(ghostBox, true);
    setShown(win, true);
    setShown(bar, true, "flex");
    // Measured once, before any geometry write, so paintCrop never reads layout.
    crop.barW = bar.offsetWidth;
    crop.barH = bar.offsetHeight;
    cropSig = "";
    ghostSig = "";
    paint();
  }

  function writeCrop(c: CropSession, pose: CropPose, srcW: number, srcH: number): void {
    const next = setLayerTransform(session.project, c.trackId, {
      crop: normalizeCrop(pose.crop, srcW, srcH),
      x: pose.x,
      y: pose.y,
    });
    session.replace(next);
    c.lastWritten = session.project;
    ctx.requestRender();
  }

  /** Leave crop mode. `commit`: one history step for the whole session;
   *  `revert`: back to the baseline. Neither when the project moved on under
   *  us (a foreign edit already recorded a snapshot holding the crop) or the
   *  layer is gone (reverting would resurrect it). */
  function exitCrop(how: "commit" | "revert" | "leave"): void {
    const c = crop;
    if (!c) return;
    endCropGesture(false);
    crop = null;
    const ours = session.project === c.lastWritten && !!findLayer(session.project, c.trackId);
    if (ours && how === "commit") session.commitFrom(c.before);
    else if (ours && how === "revert" && session.project !== c.before) {
      session.replace(c.before);
      ctx.requestRender();
    }
    c.unblock();
    c.release();
    c.unRes();
    overlay.classList.remove("is-cropping");
    setShown(ghostBox, false);
    setShown(win, false);
    setShown(bar, false);
    // Free the stage-sized ghost buffer; it is only alive while cropping.
    ghostCanvas.width = 0;
    ghostCanvas.height = 0;
    cropSig = "";
    ghostSig = "";
    if (mode.get() === "crop-layer") mode.set("idle");
    schedulePaint();
  }

  function cropContext(c: CropSession): { l: Layer; srcW: number; srcH: number; m: Affine; W: number; H: number } | null {
    const p = session.project;
    const l = findLayer(p, c.trackId);
    const d = l ? srcDims(l) : null;
    if (!l || !d) return null;
    const W = p.timeline.width;
    const H = p.timeline.height;
    return { l, srcW: d.w, srcH: d.h, m: layerToCanvas(l.transform, d.w, d.h, W, H), W, H };
  }

  function paintCrop(c: CropSession): void {
    const cc = cropContext(c);
    if (!cc) {
      exitCrop("leave");
      return;
    }
    const sc = screen();
    const winBox = aabb(layerCorners(cc.l.transform, cc.srcW, cc.srcH, cc.W, cc.H).map(([x, y]) => ({ x, y })));
    const ghost = aabb([
      applyAffine(cc.m, 0, 0),
      applyAffine(cc.m, cc.srcW, 0),
      applyAffine(cc.m, cc.srcW, cc.srcH),
      applyAffine(cc.m, 0, cc.srcH),
    ]);
    const sig = `${sc.o.x}|${sc.o.y}|${sc.s}|${winBox.x}|${winBox.y}|${winBox.w}|${winBox.h}|${ghost.x}|${ghost.y}|${ghost.w}|${ghost.h}`;
    if (sig !== cropSig) {
      cropSig = sig;
      place(win, winBox, sc);
      place(ghostBox, ghost, sc);
      // The bar sits under the window's bottom edge, kept inside the stage.
      const { sw, sh } = sc;
      const cx = sc.o.x + (winBox.x + winBox.w / 2) * sc.s;
      const bottom = sc.o.y + (winBox.y + winBox.h) * sc.s;
      bar.style.left = `${clamp(cx - c.barW / 2, 8, Math.max(8, sw - c.barW - 8))}px`;
      bar.style.top = `${clamp(bottom + 8, 8, Math.max(8, sh - c.barH - 8))}px`;
    }
    paintGhost(cc.l, cc.m, cc.srcW, cc.srcH, sc);
  }

  /** The full source at 40 %, drawn with the layer's own affine so it lines up
   *  with the cropped layer the renderer draws underneath. Redrawn only when
   *  the view or the source→canvas mapping changes — a window-handle drag
   *  keeps the source pinned, so it redraws nothing while it moves. */
  function paintGhost(l: Layer, m: Affine, srcW: number, srcH: number, sc: Screen): void {
    const dpr = view.store.get().dpr || 1;
    const bw = Math.max(0, Math.round(sc.sw * dpr));
    const bh = Math.max(0, Math.round(sc.sh * dpr));
    const k = Math.hypot(m[0], m[1]);
    const src = l.kind === "photo" ? res.photo(l, k * sc.s * dpr) : null;
    const sig = `${bw}|${bh}|${sc.o.x}|${sc.o.y}|${sc.s}|${m.map((v) => v.toFixed(6)).join(",")}`;
    if (sig === ghostSig && src === ghostSrc) return;
    ghostSig = sig;
    ghostSrc = src;
    if (ghostCanvas.width !== bw) ghostCanvas.width = bw;
    if (ghostCanvas.height !== bh) ghostCanvas.height = bh;
    const g = ghostCanvas.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);
    g.setTransform(dpr * sc.s, 0, 0, dpr * sc.s, dpr * sc.o.x, dpr * sc.o.y);
    g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const gen = l.media.generator;
    if (src) {
      // Whatever working size the preview holds, drawn over the full source box.
      g.drawImage(src, 0, 0, srcW, srcH);
    } else if (gen?.type === "solid") {
      g.fillStyle = normalizeHexColor(gen.color, "#000000");
      g.fillRect(0, 0, srcW, srcH);
    } else if (gen?.type === "text") {
      g.font = fontString(gen);
      g.fillStyle = normalizeHexColor(gen.color, "#ffffff");
      g.textBaseline = "middle";
      const lh = gen.sizePx * 1.25;
      gen.text.split("\n").forEach((line, i) => g.fillText(line, 0, (i + 0.5) * lh));
    }
  }
  function onCropDown(e: PointerEvent): void {
    const c = crop;
    if (!c || e.button !== 0 || view.panning || cropGesture) return;
    // Only presses on the crop chrome. The overlay covers the stage while
    // cropping, so anything else that reaches here bubbled from another
    // stage widget stacked above it (the ruler), which keeps its own drag.
    if (!(e.target instanceof Element) || !overlay.contains(e.target)) return;
    const target = e.target as HTMLElement;
    if (bar.contains(target)) return;
    const cc = cropContext(c);
    if (!cc) return;
    const handle = (target.dataset?.crophandle as WindowHandle | undefined) ?? null;
    const pt = view.clientToCanvas(e.clientX, e.clientY);
    const t = cc.l.transform;
    const start: CropPose = {
      crop: t.crop ?? { x: 0, y: 0, w: cc.srcW, h: cc.srcH },
      x: t.x,
      y: t.y,
    };
    let kind: CropGesture["kind"];
    if (handle) {
      kind = "window";
    } else {
      const sp = invAffine(cc.m, pt.x, pt.y);
      const cr = start.crop;
      if (sp.x >= cr.x && sp.x <= cr.x + cr.w && sp.y >= cr.y && sp.y <= cr.y + cr.h) {
        // Inside the window: keep the crop steady.
        e.preventDefault();
        return;
      }
      if (sp.x < 0 || sp.x > cc.srcW || sp.y < 0 || sp.y > cc.srcH) {
        // Outside the whole source: done cropping (keeps the result, as a
        // click outside the video editor's crop does).
        e.preventDefault();
        exitCrop("commit");
        return;
      }
      kind = "pan";
    }
    e.preventDefault();
    cropGesture = {
      kind,
      handle,
      pointerId: e.pointerId,
      start,
      startCanvas: pt,
      srcW: cc.srcW,
      srcH: cc.srcH,
      m: cc.m,
    };
    capture(e.pointerId);
    listenWindow(true);
  }

  function onCropMove(e: PointerEvent): void {
    const c = crop;
    const g = cropGesture;
    if (!c || !g || e.pointerId !== g.pointerId) return;
    if (view.panning) {
      endCropGesture(true);
      return;
    }
    if (!findLayer(session.project, c.trackId)) {
      exitCrop("leave");
      return;
    }
    const pt = view.clientToCanvas(e.clientX, e.clientY);
    const delta = { x: pt.x - g.startCanvas.x, y: pt.y - g.startCanvas.y };
    const pose =
      g.kind === "window"
        ? cropHandleDrag(g.start, g.srcW, g.srcH, g.m, g.handle!, delta)
        : cropPan(g.start, g.srcW, g.srcH, g.m, delta);
    writeCrop(c, pose, g.srcW, g.srcH);
  }

  function onCropUp(e: PointerEvent): void {
    if (cropGesture && e.pointerId === cropGesture.pointerId) endCropGesture(false);
  }

  /** End one handle/pan drag inside crop mode. The session commits once, on
   *  Apply; a cancelled drag (`revert`) goes back to where it started. */
  function endCropGesture(revert: boolean): void {
    const g = cropGesture;
    if (!g) return;
    cropGesture = null;
    listenWindow(false);
    uncapture(g.pointerId);
    const c = crop;
    if (revert && c && session.project === c.lastWritten && findLayer(session.project, c.trackId)) {
      writeCrop(c, g.start, g.srcW, g.srcH);
    }
  }

  cancelBtn.addEventListener("click", () => exitCrop("revert"));
  applyBtn.addEventListener("click", () => exitCrop("commit"));

  /* ---------------- double-click → crop ---------------- */

  function onDblClick(e: MouseEvent): void {
    if (disposed || crop || tools.get().tool !== "select" || mode.get() !== "idle") return;
    if (!accepts(e.target) || (e.target as HTMLElement).dataset?.handle) return;
    const pt = view.clientToCanvas(e.clientX, e.clientY);
    const id = hitTest(session.project, pt.x, pt.y);
    if (!id) return;
    const l = findLayer(session.project, id);
    if (!l || !croppable(l)) return;
    if (selection.get() !== id) selection.set(id);
    enterCrop(id);
  }

  /* ---------------- keys ---------------- */

  // Window CAPTURE, so it runs ahead of the shell's document-capture Escape:
  // cancelling the crop or the drag is the innermost thing Escape can mean.
  function onKeyCapture(e: KeyboardEvent): void {
    if (e.key !== "Escape" && e.key !== "Enter") return;
    if (!crop && !gesture) return;
    if (modalOpen() || menuOpen() || isTypingTarget(e.target)) return;
    // A focused control answers its own Enter (the bar's Cancel must cancel),
    // as the canvas crop's bar does.
    if (e.key === "Enter" && e.target instanceof Element && e.target.closest("button, select, input")) return;
    if (crop) {
      // Our own blockShortcuts() is what makes shortcutsBlocked() true here,
      // so it is deliberately not consulted for the crop's two keys.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") exitCrop("revert");
      else exitCrop("commit");
      return;
    }
    // An armed drag holds shortcuts itself, so its own block never stops
    // Escape from reverting it.
    if (e.key === "Escape" && gesture && (gesture.unblock !== null || !shortcutsBlocked())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelGesture();
    }
  }

  let nudgeBefore: ProjectFile | null = null;
  let nudgeWritten: ProjectFile | null = null;
  let nudgeTimer: number | undefined;

  function commitNudge(): void {
    window.clearTimeout(nudgeTimer);
    nudgeTimer = undefined;
    const before = nudgeBefore;
    nudgeBefore = null;
    if (before && session.project === nudgeWritten) session.commitFrom(before);
    nudgeWritten = null;
  }

  function onNudgeKey(e: KeyboardEvent): void {
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    if (disposed || crop || gesture || tools.get().tool !== "select" || mode.get() !== "idle") return;
    if (isTypingTarget(e.target) || shortcutsBlocked() || modalOpen()) return;
    // A focused widget that owns the arrows (the Layers list, a slider such as
    // the ruler, a native range or select, anything in the inspector) handles
    // them itself. `isTypingTarget` counts a range input as not typing, so it
    // is named here or one key press would move the slider AND the layer.
    if (
      e.target instanceof Element &&
      e.target.closest(".imged-layers, [role='slider'], [role='listbox'], input, select, textarea, .inspector")
    ) return;
    const id = selection.get();
    const l = id ? findLayer(session.project, id) : undefined;
    if (!l || l.hidden) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (!nudgeBefore || session.project !== nudgeWritten) nudgeBefore = session.project;
    const next = setLayerTransform(session.project, l.trackId, {
      x: l.transform.x + dx * step,
      y: l.transform.y + dy * step,
    });
    session.replace(next);
    nudgeWritten = session.project;
    ctx.requestRender();
    window.clearTimeout(nudgeTimer);
    nudgeTimer = window.setTimeout(commitNudge, NUDGE_IDLE_MS);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (nudgeBefore && e.key.startsWith("Arrow")) commitNudge();
  }

  function onBlur(): void {
    cancelGesture();
    if (crop) endCropGesture(true);
  }

  /* ---------------- wiring ---------------- */

  stage.addEventListener("pointerdown", onStagePointerDown);
  stage.addEventListener("dblclick", onDblClick);
  window.addEventListener("keydown", onKeyCapture, true);
  document.addEventListener("keydown", onNudgeKey);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  const unsubs = [
    selection.subscribe((id) => {
      if (crop && id !== crop.trackId) exitCrop("commit");
      if (gesture && id !== gesture.trackId) endGesture(true);
      schedulePaint();
    }),
    tools.subscribe((t) => {
      if (t.tool !== "select") {
        if (crop) exitCrop("commit");
        cancelGesture();
      }
      schedulePaint();
    }),
    mode.subscribe((md) => {
      // The shell's Escape (or anything else) took the stage out of our mode.
      if (crop && md !== "crop-layer") exitCrop("revert");
      schedulePaint();
    }),
    session.store.subscribe((p) => {
      if (crop && p !== crop.lastWritten) {
        // Something else edited the project mid-crop (an inspector control, an
        // undo button): whatever it did already holds our crop. Step out
        // without touching history.
        exitCrop("leave");
      }
      if (nudgeBefore && p !== nudgeWritten) {
        window.clearTimeout(nudgeTimer);
        nudgeBefore = null;
        nudgeWritten = null;
      }
      schedulePaint();
    }),
    view.store.subscribe(() => {
      screenCache = null;
      ghostSig = "";
      schedulePaint();
    }),
  ];

  paint();

  return {
    dispose(): void {
      if (disposed) return;
      // A drag in flight is reverted and an open crop cancelled (both went
      // through replace(): nothing for Ctrl+Z to reach). A nudge run is a
      // finished edit, so it is committed.
      cancelGesture();
      exitCrop("revert");
      commitNudge();
      disposed = true;
      for (const u of unsubs) u();
      stage.removeEventListener("pointerdown", onStagePointerDown);
      stage.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("keydown", onKeyCapture, true);
      document.removeEventListener("keydown", onNudgeKey);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      listenWindow(false);
      overlay.remove();
    },
  };
}
