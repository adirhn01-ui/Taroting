// Ink input: pen, pencil, marker, eraser and shapes on the stage, the live
// mark, the brush cursor and the ruler. One gesture = one undo step.
//
// ZERO COST AT REST. The pointer surface exists only while an ink tool is
// active (the select tool gets the stage to itself), nothing here ever calls
// requestAnimationFrame, and the only per-frame work is what a move asks for:
// `ctx.requestRender()`, which the shell coalesces into one frame. Hovering
// moves a DOM circle (no canvas repaint at all).
//
// WHERE A MARK GOES. The target is decided by `drawingTarget` (the nearest
// visible drawing layer at or above the selection, else a new one directly
// above it) when the pointer lands — that is the layer the live mark is shown
// on — and DECIDED AGAIN inside the commit, against the project as it is then:
// an undo mid-gesture can delete the layer the mark started on. Points are kept
// in CANVAS px for exactly that reason and mapped into the final target's own
// space (`canvasToLayer`) at commit, so a rotated, flipped or scaled layer gets
// the ink under the cursor, and a layer that has to be created is created in
// the same commit as the stroke (one undo step, not two).
//
// THE ERASERS. The live mark is painted into the target layer's OWN scratch
// (the renderer copies the layer's raster there first), so the pixel eraser
// previews exactly like any other mark: its destination-out cuts that layer
// and nothing under it, and a marker's destination-over goes under the
// layer's ink while it is being drawn, just as it will once committed.
// The stroke eraser can touch several layers at once, and one live mark
// belongs to one layer, so it previews through the project instead: each
// stroke is removed the moment the eraser touches it (session.replace, no
// history) and ONE history step is committed on release (session.commitFrom)
// — the slider-drag pattern. A stroke-erase gesture that finds the project
// changed under it by something else (an undo with the pen still down) steps
// aside without writing: the other change wins.

import type { ClipTransform, InkKind, ProjectFile, ShapeKind, Stroke } from "../../core/types";
import { defaultTransform } from "../../core/project";
import { isTypingTarget, shortcutsBlocked } from "../../core/shortcuts";
import { normalizeHexColor } from "../../core/session";
import { toast } from "../../ui/toast";
import type { ImageEditorCtx } from "../context";
import { canvasToLayer } from "../geom";
import { addDrawingLayer, appendStrokeTo, drawingTarget, eraseStrokes, findLayer, layersOf } from "../layers";
import { encodePoints } from "../strokes";
import { cssToSource, type ToolId } from "../tool-state";
import { collectStrokeHits } from "./eraser";
import {
  EMA_OTHER,
  EMA_PEN,
  MIN_SPACING_CSS,
  PalmFilter,
  SIMPLIFY_CSS,
  StrokeSampler,
  collectPoints,
  pressureOf,
  simplifyStroke,
} from "./input";
import "./ink.css";
import { PENCIL_MAX_WIDTHS, createScratch, paintLiveMark, paintLiveShape, strokeBounds } from "./paint";
import { mountRuler } from "./ruler";
import { constrainShape, shapeEndsInRange, shapeLongEnough, shapeStroke, type Pt } from "./shapes";

const INK_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["pen", "pencil", "marker", "eraser", "shape"]);
/** The marker's fixed opacity; the pencil's is 0.3 + 0.7 × mean pressure. */
export const MARKER_OPACITY = 0.4;
/** Has nothing but bookkeeping changed between two project states? An
 *  autosave pass re-stamps `modifiedAt` by pushing a new top-level object with
 *  the same content, and that must not read as "someone else edited it". */
function unchanged(a: ProjectFile, b: ProjectFile): boolean {
  return a === b || (a.timeline === b.timeline && a.media === b.media && a.image === b.image);
}

/** Stroke widths the project validator accepts (A2 / Rust: (0, 65535]). */
const W_MAX = 65535;
/** A shape shorter than this on screen (css px) is a stray tap, not a shape. */
const SHAPE_MIN_CSS = 1;

/** The pencil's opacity from the mean pressure of its points. */
export function pencilOpacity(meanPressure: number): number {
  const p = Number.isFinite(meanPressure) ? Math.min(Math.max(meanPressure, 0), 1) : 1;
  return 0.3 + 0.7 * p;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The canvas-px box of `pts` ([x, y, p]*), grown by `pad` on every side. */
function pointsBox(pts: Float32Array, pad: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]!);
    minY = Math.min(minY, pts[i + 1]!);
    maxX = Math.max(maxX, pts[i]!);
    maxY = Math.max(maxY, pts[i + 1]!);
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

/** Does a canvas-px box lie wholly outside the W×H canvas? The preview is
 *  clipped to the canvas, so a mark out there would never be seen: it is not
 *  kept (no stroke, no new drawing layer, no undo step). A mark that crosses
 *  the edge is kept whole. NaN reads as outside. */
function missesCanvas(b: Box, W: number, H: number): boolean {
  return !(b.x + b.w > 0 && b.y + b.h > 0 && b.x < W && b.y < H);
}

/** Where a gesture's mark goes, and how to get there from canvas px. */
interface Target {
  /** null = a drawing layer to be created directly above `above` */
  trackId: string | null;
  above: string | null;
  t: ClipTransform;
  srcW: number;
  srcH: number;
}

/** Resolve the drawing target in `p` for the selection `sel`. */
export function resolveTarget(p: ProjectFile, sel: string | null): Target {
  const W = p.timeline.width;
  const H = p.timeline.height;
  const dt = drawingTarget(p, sel);
  if ("trackId" in dt) {
    const l = findLayer(p, dt.trackId);
    const w = l?.media.width;
    const h = l?.media.height;
    if (l && w && h && w > 0 && h > 0) return { trackId: l.trackId, above: null, t: l.transform, srcW: w, srcH: h };
    return { trackId: null, above: sel, t: defaultTransform(), srcW: W, srcH: H };
  }
  // A layer about to be created: the canvas box at scale 1, centred — the
  // shape addDrawingLayer gives it, so local px == canvas px.
  return { trackId: null, above: dt.create.above, t: defaultTransform(), srcW: W, srcH: H };
}

/** Map `count` canvas-px points ([x, y, p]*) into a target's local space. */
export function toLocal(p: ProjectFile, t: Target, pts: Float32Array, count: number, into?: Float32Array): Float32Array {
  const out = into && into.length >= count * 3 ? into : new Float32Array(count * 3);
  const W = p.timeline.width;
  const H = p.timeline.height;
  for (let i = 0; i < count; i++) {
    const q = canvasToLayer(t.t, t.srcW, t.srcH, W, H, pts[i * 3]!, pts[i * 3 + 1]!);
    out[i * 3] = q.x;
    out[i * 3 + 1] = q.y;
    out[i * 3 + 2] = pts[i * 3 + 2]!;
  }
  return out;
}

/** Stroke width in a layer's source px for a SCREEN size, clamped to what the
 *  validators accept. */
function widthFor(sizeCss: number, dpr: number, zoom: number, k: number): number {
  const w = cssToSource(sizeCss, dpr, zoom, k > 0 ? k : 1);
  return Number.isFinite(w) && w > 0 ? Math.min(w, W_MAX) : 1;
}

/* ---------------- gestures ---------------- */

interface GestureBase {
  pointerId: number;
  pointerType: string;
  /** releases the autosave hold (idempotent) */
  release: () => void;
  /** view at pointer-down: the size stays what it was when the pen landed */
  dpr: number;
  zoom: number;
}

interface InkGesture extends GestureBase {
  kind: "ink";
  /** "erase" = the pixel eraser: a mark like any other, cutting its layer */
  tool: InkKind | "erase";
  color: string;
  sizeCss: number;
  sampler: StrokeSampler;
  target: Target;
  /** live points in the target's local space */
  local: Float32Array;
  localCount: number;
  /** ruler edge being followed (0 = none) */
  edge: 1 | -1 | 0;
  edgeHalf: number;
}

interface ShapeGesture extends GestureBase {
  kind: "shape";
  shape: ShapeKind;
  color: string;
  sizeCss: number;
  target: Target;
  a: Pt;
  b: Pt;
}

interface EraseStrokeGesture extends GestureBase {
  kind: "erase-stroke";
  sizeCss: number;
  before: ProjectFile;
  /** what the project should be if nobody else has touched it */
  expected: ProjectFile;
  hits: Map<string, Set<Stroke>>;
  last: Pt;
}

type Gesture = InkGesture | ShapeGesture | EraseStrokeGesture;

export function mountInk(ctx: ImageEditorCtx): { dispose(): void } {
  const scratch = createScratch();
  const palm = new PalmFilter();
  const touches = new Set<number>();
  let surface: HTMLElement | null = null;
  let cursor: HTMLElement | null = null;
  let surfaceRect: DOMRect | null = null;
  let cursorSize = -1;
  let cursorShown = false;
  /** Where the circle was last put (client px), and whether a pen's eraser
   *  end put it there: a size change re-places it without a pointer move. */
  let cursorX = 0;
  let cursorY = 0;
  let cursorPenEraser = false;
  let g: Gesture | null = null;
  let disposed = false;

  const ruler = mountRuler(ctx, (el) => {
    // The ruler must stay above the ink surface: both sit at the stage-overlay
    // level, so DOM order decides — keep the surface before the ruler. Only
    // MOVE it when it is not already there: re-inserting a node that holds
    // pointer capture drops the capture (lostpointercapture → cancel), so
    // showing the ruler with the pen down would throw the mark away.
    if (el && surface && !(surface.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      ctx.stage.insertBefore(surface, el);
    }
  });

  const now = (): number => performance.now();
  const inkOpacity = (gi: InkGesture): number =>
    gi.tool === "marker" ? MARKER_OPACITY : gi.tool === "pencil" ? pencilOpacity(gi.sampler.meanPressure()) : 1;
  const view = (): { dpr: number; zoom: number } => {
    const v = ctx.view.store.get();
    return { dpr: v.dpr > 0 ? v.dpr : 1, zoom: v.zoom > 0 ? v.zoom : 1 };
  };
  const canvasPerCss = (dpr: number, zoom: number): number => dpr / zoom;

  /* ---------- ending a gesture ---------- */

  const clearLive = (): void => {
    ctx.setLive(null);
    ctx.requestRender();
  };

  const releaseCapture = (id: number): void => {
    try {
      if (surface?.hasPointerCapture?.(id)) surface.releasePointerCapture(id);
    } catch {
      /* synthetic ids throw */
    }
  };

  /** Drop the gesture, writing nothing — and undoing whatever an eraser showed,
   *  provided the project is still the one it made. */
  const cancel = (): void => {
    const cur = g;
    if (!cur) return;
    g = null;
    if (cur.kind === "erase-stroke" && unchanged(ctx.session.project, cur.expected)) {
      // Not an edit: it puts back what the gesture's own previews took away.
      ctx.session.replace(cur.before, { edit: false });
    }
    ruler.light(0);
    releaseCapture(cur.pointerId);
    cur.release();
    clearLive();
  };

  /* ---------- starting ---------- */

  const startInk = (e: PointerEvent, tool: InkKind | "erase", base: GestureBase, target: Target): void => {
    const s = ctx.tools.get();
    const color = tool === "erase" ? "#000000" : normalizeHexColor(s.colors[tool], "#000000");
    const sizeCss = tool === "erase" ? s.sizes.eraser : s.sizes[tool];
    const k = canvasPerCss(base.dpr, base.zoom);
    const sampler = new StrokeSampler(e.pointerType === "pen" ? EMA_PEN : EMA_OTHER, MIN_SPACING_CSS * k);
    const start = ctx.view.clientToCanvas(e.clientX, e.clientY);
    // The ruler guides ink; an eraser goes where the hand goes.
    const edge = tool === "erase" ? 0 : ruler.catchEdge(start.x, start.y);
    const gesture: InkGesture = {
      ...base,
      kind: "ink",
      tool,
      color,
      sizeCss,
      sampler,
      target,
      local: new Float32Array(3 * 64),
      localCount: 0,
      edge,
      edgeHalf: (sizeCss * k) / 2,
    };
    g = gesture;
    ruler.light(edge);
    addInkSample(gesture, start.x, start.y, tool === "erase" ? 1 : pressureOf(e));
    showInk(gesture);
  };

  /** Hand the renderer the mark as it now stands. A NEW LiveInk every time:
   *  the shell may skip a render whose inputs are all the same objects. */
  const showInk = (gi: InkGesture): void => {
    const w = widthFor(gi.sizeCss, gi.dpr, gi.zoom, gi.target.t.scale);
    const mark = { t: gi.tool, c: gi.color, w, o: inkOpacity(gi), pts: gi.local, count: gi.localCount };
    ctx.setLive({
      trackId: gi.target.trackId,
      above: gi.target.above,
      paint: (c2d) => paintLiveMark(c2d, mark, scratch),
    });
    ctx.requestRender();
  };

  const addInkSample = (gi: InkGesture, x: number, y: number, p: number): void => {
    let px = x;
    let py = y;
    if (gi.edge !== 0) [px, py] = ruler.constrain(gi.edge, gi.edgeHalf, x, y);
    gi.sampler.push(px, py, p);
    syncLocal(gi);
  };

  /** Map the sampler's new points into the live target's space. */
  const syncLocal = (gi: InkGesture): void => {
    const n = gi.sampler.count;
    if (n <= gi.localCount) return;
    if (gi.local.length < n * 3) {
      const next = new Float32Array(Math.max(n * 3, gi.local.length * 2));
      next.set(gi.local.subarray(0, gi.localCount * 3));
      gi.local = next;
    }
    const p = ctx.session.project;
    const W = p.timeline.width;
    const H = p.timeline.height;
    const src = gi.sampler.points;
    for (let i = gi.localCount; i < n; i++) {
      const q = canvasToLayer(gi.target.t, gi.target.srcW, gi.target.srcH, W, H, src[i * 3]!, src[i * 3 + 1]!);
      gi.local[i * 3] = q.x;
      gi.local[i * 3 + 1] = q.y;
      gi.local[i * 3 + 2] = src[i * 3 + 2]!;
    }
    gi.localCount = n;
  };

  const startShape = (e: PointerEvent, base: GestureBase): void => {
    const s = ctx.tools.get();
    const color = normalizeHexColor(s.colors.shape, "#000000");
    const target = resolveTarget(ctx.session.project, ctx.selection.get());
    const a = ctx.view.clientToCanvas(e.clientX, e.clientY);
    const gesture: ShapeGesture = {
      ...base,
      kind: "shape",
      shape: s.shape,
      color,
      sizeCss: s.sizes.shape,
      target,
      a: [a.x, a.y],
      b: [a.x, a.y],
    };
    g = gesture;
    showShape(gesture);
  };

  const showShape = (gs: ShapeGesture): void => {
    const t = gs.target;
    const p = ctx.session.project;
    const W = p.timeline.width;
    const H = p.timeline.height;
    const la = canvasToLayer(t.t, t.srcW, t.srcH, W, H, gs.a[0], gs.a[1]);
    const lb = canvasToLayer(t.t, t.srcW, t.srcH, W, H, gs.b[0], gs.b[1]);
    const shape = {
      t: gs.shape,
      c: gs.color,
      w: widthFor(gs.sizeCss, gs.dpr, gs.zoom, t.t.scale),
      a: [la.x, la.y] as [number, number],
      b: [lb.x, lb.y] as [number, number],
    };
    ctx.setLive({ trackId: t.trackId, above: t.above, paint: (c2d) => paintLiveShape(c2d, shape) });
    ctx.requestRender();
  };

  const startEraseStroke = (e: PointerEvent, base: GestureBase): void => {
    const before = ctx.session.project;
    const at = ctx.view.clientToCanvas(e.clientX, e.clientY);
    const gesture: EraseStrokeGesture = {
      ...base,
      kind: "erase-stroke",
      sizeCss: ctx.tools.get().sizes.eraser,
      before,
      expected: before,
      hits: new Map(),
      last: [at.x, at.y],
    };
    g = gesture;
    eraseAlong(gesture, at.x, at.y);
  };

  /* ---------- growing ---------- */

  /** The project changed under the stroke eraser: the other change wins; the
   *  gesture steps aside without touching it. */
  const stale = (ge: EraseStrokeGesture): boolean => {
    if (unchanged(ctx.session.project, ge.expected)) return false;
    g = null;
    releaseCapture(ge.pointerId);
    ge.release();
    return true;
  };

  const eraseAlong = (ge: EraseStrokeGesture, x: number, y: number): void => {
    if (stale(ge)) return;
    const p = ge.before;
    const W = p.timeline.width;
    const H = p.timeline.height;
    let added = 0;
    for (const l of layersOf(p)) {
      if (l.hidden || l.kind !== "drawing") continue;
      const gen = l.media.generator;
      if (!gen || gen.type !== "drawing") continue;
      const mw = l.media.width;
      const mh = l.media.height;
      if (!mw || !mh) continue;
      const a = canvasToLayer(l.transform, mw, mh, W, H, ge.last[0], ge.last[1]);
      const b = canvasToLayer(l.transform, mw, mh, W, H, x, y);
      const r = cssToSource(ge.sizeCss / 2, ge.dpr, ge.zoom, l.transform.scale > 0 ? l.transform.scale : 1);
      let set = ge.hits.get(l.trackId);
      if (!set) {
        set = new Set();
        ge.hits.set(l.trackId, set);
      }
      added += collectStrokeHits(gen.chunks, a.x, a.y, b.x, b.y, r, set);
    }
    ge.last = [x, y];
    if (added > 0) {
      const next = eraseStrokes(ge.before, ge.hits);
      ge.expected = next;
      // A live preview, not yet the user's edit: an erase that is cancelled
      // or nets nothing must not make closing a temporary project ask about
      // it. The release's commitFrom is what marks the project edited.
      ctx.session.replace(next, { edit: false });
      ctx.requestRender();
    }
  };

  /* ---------- finishing ---------- */

  const finishInk = (gi: InkGesture, e: PointerEvent): void => {
    const at = ctx.view.clientToCanvas(e.clientX, e.clientY);
    let [x, y] = [at.x, at.y];
    if (gi.edge !== 0) [x, y] = ruler.constrain(gi.edge, gi.edgeHalf, x, y);
    // A lifting pen reports pressure 0: the last point keeps the pressure the
    // mark had, rather than pinching the end to a hairline.
    gi.sampler.finish(x, y, Number.NaN);
    const k = canvasPerCss(gi.dpr, gi.zoom);
    const pts = simplifyStroke(gi.sampler.points, gi.sampler.count, SIMPLIFY_CSS * k);
    const o = inkOpacity(gi);
    const tool = gi.tool;
    // What the mark can paint, in canvas px (the pencil up to its full width).
    const box = pointsBox(pts, (gi.sizeCss * k * (tool === "pencil" ? PENCIL_MAX_WIDTHS : 1)) / 2);
    commitMark(
      (p, t) => {
        if (missesCanvas(box, p.timeline.width, p.timeline.height)) return null;
        const local = encodePoints(toLocal(p, t, pts, pts.length / 3));
        const w = widthFor(gi.sizeCss, gi.dpr, gi.zoom, t.t.scale);
        return tool === "erase" ? { t: "erase", w, p: local } : { t: tool, c: gi.color, w, o, p: local };
      },
      // An erase whose layer is gone by the time it lands erases nothing: it
      // must not conjure an empty drawing layer to hold itself.
      tool !== "erase",
    );
  };

  const finishShape = (gs: ShapeGesture): void => {
    const k = canvasPerCss(gs.dpr, gs.zoom);
    let tooFar = false;
    commitMark((p, t) => {
      const W = p.timeline.width;
      const H = p.timeline.height;
      // Wholly off the canvas: nothing to see, nothing kept, nothing said. The
      // same shape in canvas px gives its painted box (an arrow's wings too).
      const drawn: Stroke = { t: gs.shape, c: gs.color, w: gs.sizeCss * k, a: gs.a, b: gs.b };
      if (missesCanvas(strokeBounds(drawn), W, H)) return null;
      const la = canvasToLayer(t.t, t.srcW, t.srcH, W, H, gs.a[0], gs.a[1]);
      const lb = canvasToLayer(t.t, t.srcW, t.srcH, W, H, gs.b[0], gs.b[1]);
      const a: Pt = [la.x, la.y];
      const b: Pt = [lb.x, lb.y];
      const scale = t.t.scale > 0 ? t.t.scale : 1;
      const minLen = (SHAPE_MIN_CSS * k) / scale;
      // Length first: a stray tap is no shape wherever it lands, and says
      // nothing.
      if (!shapeLongEnough(gs.shape, a, b, minLen)) return null;
      // A real drag whose ends the loader would refuse (a drawing layer scaled
      // down to a sliver divides the offset by its scale): not kept, and said
      // so — a shape that silently vanishes reads as broken.
      if (!shapeEndsInRange(a, b)) {
        tooFar = true;
        return null;
      }
      return shapeStroke(gs.shape, gs.color, widthFor(gs.sizeCss, gs.dpr, gs.zoom, scale), a, b, minLen);
    });
    // Outside the commit: the mutator stays free of side effects.
    if (tooFar) toast.info("That shape reaches too far outside the layer to keep.");
  };

  /**
   * ONE commit: re-resolve the target against the project as it is now,
   * create the drawing layer if there is none (in the same step), append the
   * mark built for that layer's space. The layer that received the ink becomes
   * the selection, so the Layers panel shows where it went.
   */
  const commitMark = (build: (p: ProjectFile, t: Target) => Stroke | null, create = true): void => {
    let landed: string | null = null;
    ctx.session.commit((p) => {
      let t = resolveTarget(p, ctx.selection.get());
      let q = p;
      let id = t.trackId;
      if (id === null) {
        if (!create) return p;
        let made: { project: ProjectFile; trackId: string };
        try {
          made = addDrawingLayer(p, { above: t.above });
        } catch {
          return p;
        }
        q = made.project;
        id = made.trackId;
        const l = findLayer(q, id);
        if (!l) return p;
        t = { trackId: id, above: null, t: l.transform, srcW: l.media.width || q.timeline.width, srcH: l.media.height || q.timeline.height };
      }
      let s: Stroke | null;
      try {
        s = build(q, t);
      } catch {
        // A point that could not be encoded (NaN from a degenerate view) must
        // never become a stroke the loader would refuse; drop the mark.
        s = null;
      }
      if (!s) return p;
      const out = appendStrokeTo(q, id, s);
      // Not appendable after all: leave no empty layer behind either.
      if (out === q) return p;
      landed = id;
      return out;
    });
    // SAME TICK as the commit, before any store notification is delivered: the
    // Layers panel repairs a selection whose layer it cannot find, and must
    // already see the new layer selected when it first sees the new layer.
    if (landed !== null && ctx.selection.get() !== landed) ctx.selection.set(landed);
  };

  const finish = (e: PointerEvent): void => {
    const cur = g;
    if (!cur || e.pointerId !== cur.pointerId) return;
    g = null;
    ruler.light(0);
    releaseCapture(cur.pointerId);
    try {
      if (cur.kind === "ink") finishInk(cur, e);
      else if (cur.kind === "shape") {
        const b = ctx.view.clientToCanvas(e.clientX, e.clientY);
        cur.b = constrainShape(cur.shape, cur.a, [b.x, b.y], e.shiftKey);
        finishShape(cur);
      } else if (cur.kind === "erase-stroke") {
        // Nothing touched → no history step (even if an autosave re-stamped
        // the project object meanwhile).
        if (cur.expected !== cur.before && unchanged(ctx.session.project, cur.expected)) {
          ctx.session.commitFrom(cur.before);
        }
      }
    } finally {
      cur.release();
      clearLive();
    }
  };

  /* ---------- pointer routing ---------- */

  const onPointerDown = (e: PointerEvent): void => {
    const t = now();
    palm.note(e.pointerType, t);
    if (e.pointerType === "touch") {
      touches.add(e.pointerId);
      // A second finger is a pinch: hand the stage to the view.
      if (touches.size > 1) {
        if (g && g.pointerType === "touch") cancel();
        return;
      }
    }
    if (g) return; // one mark at a time; a second pen or mouse is ignored
    if (ctx.view.panning || ctx.mode.get() !== "idle") return;
    const penEraser = e.pointerType === "pen" && ((e.buttons & 32) !== 0 || e.button === 5);
    if (!penEraser && e.button !== 0) return; // right and middle never draw
    if (!palm.mayDraw(e.pointerType, t)) return;
    const s = ctx.tools.get();
    const tool: ToolId = penEraser ? "eraser" : s.tool;
    if (tool === "select" || !INK_TOOLS.has(tool)) return;

    const v = view();
    const base: GestureBase = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      release: () => {},
      dpr: v.dpr,
      zoom: v.zoom,
    };
    if (tool === "eraser" && s.eraserMode === "pixel") {
      // Pixel erasing only ever cuts a DRAWING layer; with none to cut there is
      // nothing to do (the tool row says so).
      const target = resolveTarget(ctx.session.project, ctx.selection.get());
      if (target.trackId === null) return;
      base.release = ctx.holdAutosave();
      startInk(e, "erase", base, target);
    } else {
      base.release = ctx.holdAutosave();
      if (tool === "eraser") startEraseStroke(e, base);
      else if (tool === "shape") startShape(e, base);
      else startInk(e, tool, base, resolveTarget(ctx.session.project, ctx.selection.get()));
    }
    try {
      surface?.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer ids throw */
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    palm.note(e.pointerType, now());
    moveCursor(e);
    const cur = g;
    if (!cur || e.pointerId !== cur.pointerId) return;
    // A pan that took the pointer over (Space held, or the view decided this
    // is a pan) ends the mark: nothing is written.
    if (ctx.view.panning || ctx.mode.get() !== "idle") {
      cancel();
      return;
    }
    if (cur.kind === "ink") {
      for (const ev of collectPoints(e)) {
        const c = ctx.view.clientToCanvas(ev.clientX, ev.clientY);
        addInkSample(cur, c.x, c.y, cur.tool === "erase" ? 1 : pressureOf(ev));
      }
      showInk(cur);
    } else if (cur.kind === "shape") {
      const b = ctx.view.clientToCanvas(e.clientX, e.clientY);
      cur.b = constrainShape(cur.shape, cur.a, [b.x, b.y], e.shiftKey);
      showShape(cur);
    } else if (cur.kind === "erase-stroke") {
      for (const ev of collectPoints(e)) {
        const c = ctx.view.clientToCanvas(ev.clientX, ev.clientY);
        eraseAlong(cur, c.x, c.y);
        if (g !== cur) return;
      }
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
    finish(e);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
    if (g && g.pointerId === e.pointerId) cancel();
  };

  const onLostCapture = (e: PointerEvent): void => {
    // The view taking a finger over for a pinch is a capture loss too: that
    // finger's up will go to the view, never to this surface.
    touches.delete(e.pointerId);
    if (g && g.pointerId === e.pointerId) cancel();
  };

  /** Every finger that lifts ANYWHERE leaves the count. The view claims both
   *  fingers of a pinch in its capture phase, so their ups never reach this
   *  surface; a finger left behind in `touches` would read every later single
   *  touch as "a second finger" and finger drawing would stay dead until blur.
   *  Window CAPTURE, mirroring the view's own pointer bookkeeping. */
  const onWindowPointerEnd = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
  };

  /** Ctrl+wheel mid-mark would zoom under the pen and change what "this size"
   *  means halfway through a stroke: ignored while a pointer is down. */
  const onWheel = (e: WheelEvent): void => {
    if (!g || !e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /* ---------- the brush cursor ---------- */

  const cursorDiameter = (): number => {
    const s = ctx.tools.get();
    switch (s.tool) {
      case "pen":
      case "pencil":
      case "marker":
      case "eraser":
      case "shape":
        return s.sizes[s.tool];
      default:
        return 0;
    }
  };

  const hideCursor = (): void => {
    if (cursor && cursorShown) {
      cursorShown = false;
      cursor.hidden = true;
    }
  };

  const moveCursor = (e: PointerEvent): void => {
    if (!cursor || !surface) return;
    if (e.pointerType === "touch") {
      hideCursor();
      return;
    }
    // A pen's eraser end shows the eraser's size.
    cursorPenEraser = e.pointerType === "pen" && (e.buttons & 32) !== 0;
    cursorX = e.clientX;
    cursorY = e.clientY;
    placeCursor();
  };

  const placeCursor = (): void => {
    if (!cursor || !surface) return;
    const d = cursorPenEraser ? ctx.tools.get().sizes.eraser : cursorDiameter();
    if (!(d > 0)) {
      hideCursor();
      return;
    }
    if (!surfaceRect) surfaceRect = surface.getBoundingClientRect();
    if (d !== cursorSize) {
      cursorSize = d;
      cursor.style.width = `${d}px`;
      cursor.style.height = `${d}px`;
    }
    cursor.style.transform = `translate(${cursorX - surfaceRect.left - d / 2}px, ${cursorY - surfaceRect.top - d / 2}px)`;
    if (!cursorShown) {
      cursorShown = true;
      cursor.hidden = false;
    }
  };

  const onPointerEnter = (): void => {
    surfaceRect = null;
  };
  const onPointerLeave = (): void => {
    hideCursor();
  };

  /* ---------- keys and focus ---------- */

  /** Esc cancels the mark in progress. Window CAPTURE, so it runs before the
   *  shell's own Esc (which would switch the tool back to select) and stops it:
   *  one Esc, one meaning. Every guard the shortcut system applies is applied. */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !g) return;
    if (e.repeat || isTypingTarget(e.target) || shortcutsBlocked()) return;
    if (document.querySelector(".modal-backdrop")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };
  const onBlur = (): void => {
    touches.clear();
    cancel();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") onBlur();
  };

  /* ---------- the surface, only while an ink tool is active ---------- */

  const mountSurface = (): void => {
    if (surface) return;
    surface = document.createElement("div");
    surface.className = "imged-ink";
    cursor = document.createElement("div");
    cursor.className = "imged-ink__cursor";
    cursor.hidden = true;
    cursorShown = false;
    cursorSize = -1;
    surface.appendChild(cursor);
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("lostpointercapture", onLostCapture);
    surface.addEventListener("pointerenter", onPointerEnter);
    surface.addEventListener("pointerleave", onPointerLeave);
    surface.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const r = ruler.el;
    if (r && r.parentNode === ctx.stage) ctx.stage.insertBefore(surface, r);
    else ctx.stage.appendChild(surface);
    surfaceRect = null;
  };

  const unmountSurface = (): void => {
    if (!surface) return;
    cancel();
    surface.removeEventListener("pointerdown", onPointerDown);
    surface.removeEventListener("pointermove", onPointerMove);
    surface.removeEventListener("pointerup", onPointerUp);
    surface.removeEventListener("pointercancel", onPointerCancel);
    surface.removeEventListener("lostpointercapture", onLostCapture);
    surface.removeEventListener("pointerenter", onPointerEnter);
    surface.removeEventListener("pointerleave", onPointerLeave);
    surface.removeEventListener("wheel", onWheel, { capture: true });
    surface.remove();
    surface = null;
    cursor = null;
    surfaceRect = null;
    touches.clear();
  };

  const syncSurface = (): void => {
    if (disposed) return;
    const want = INK_TOOLS.has(ctx.tools.get().tool) && ctx.mode.get() === "idle";
    if (want) mountSurface();
    else unmountSurface();
    // The brush circle follows the tool's size as soon as it changes ([ / ]
    // with the pointer resting): re-placed around the same centre. Nothing
    // is written unless the size actually differs.
    if (cursor && cursorShown) {
      const d = cursorPenEraser ? ctx.tools.get().sizes.eraser : cursorDiameter();
      if (d !== cursorSize) placeCursor();
    }
  };

  const unTools = ctx.tools.subscribe(syncSurface);
  const unMode = ctx.mode.subscribe(syncSurface);
  const unView = ctx.view.store.subscribe(() => {
    surfaceRect = null;
    // A second finger turns a touch mark into a pinch: the view claims both
    // pointers in its capture phase, so this surface may never see the second
    // pointerdown or the first one's pointerup. The view moving under a touch
    // mark is that hand-off; the mark is dropped, not committed.
    if (g && g.pointerType === "touch" && ctx.view.panning) cancel();
  });
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerup", onWindowPointerEnd, true);
  window.addEventListener("pointercancel", onWindowPointerEnd, true);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  syncSurface();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unTools();
      unMode();
      unView();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerup", onWindowPointerEnd, true);
      window.removeEventListener("pointercancel", onWindowPointerEnd, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      unmountSurface();
      cancel();
      ruler.dispose();
      scratch.release();
    },
  };
}
