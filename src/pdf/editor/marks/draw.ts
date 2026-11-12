// The drawing gestures: pen / pencil / marker ink, shapes, box drags
// (whiteout, a free highlight rectangle) and the stroke eraser. Each gesture
// lives on the page the pointer went down on, works in that page's space, and
// lands as ONE history step:
//   - ink, shapes, boxes: session.commit(addAnnot) on release;
//   - eraser: live previews through session.replace (not an edit yet), one
//     commitFrom(before) on release — the image editor's stroke-eraser rule.
// The live mark is drawn into the page frame's `live` group, at most once per
// frame.

import type { PdfAnnot, ShapeKind } from "../../../core/types";
import { normalizeHexColor } from "../../../core/session";
import { PDF_STROKE_MAX_POINTS } from "../../../core/pdf-sanitize";
import { encodePoints } from "../../../image/strokes";
import {
  EMA_OTHER,
  EMA_PEN,
  MIN_SPACING_CSS,
  SIMPLIFY_CSS,
  StrokeSampler,
  collectPoints,
  pressureOf,
  simplifyStroke,
} from "../../../image/ink/input";
import { constrainShape, shapeLongEnough, type Pt } from "../../../image/ink/shapes";
import { toast } from "../../../ui/toast";
import { addAnnot, canAddAnnots, isPagePicture, newId, pageAnnots, removeAnnots, type AnnotRef } from "../../model";
import type { Env, Gesture } from "./env";
import { sameEdit } from "./env";
import {
  MARKER_OPACITY,
  boxFrom,
  clampWidthPt,
  cssToPt,
  pencilOpacity,
  rulerEdge,
  snapStraight,
  snapToRuler,
  sweepHit,
  type RulerPose,
} from "./geom";
import { SVG_NS, inkD, markNode } from "./render";

/** Default highlight opacity (multiplied over the page like a real marker). */
export const HIGHLIGHT_OPACITY = 1;
/** A whiteout's default colour. */
export const WHITEOUT_COLOR = "#ffffff";
/** How near (screen px) outside a ruler edge a pen must land to follow it. */
export const RULER_CATCH_CSS = 16;

/** The page-full refusal (PDF_MAX_ANNOTS_PER_PAGE). */
export const PAGE_FULL = "This page has the most marks a page can hold.";

/** True when one more mark fits on page `key`; else says so (a gesture that
 *  could not land is never started). */
function roomFor(env: Env, key: string): boolean {
  if (canAddAnnots(env.ctx.session.project, key, 1)) return true;
  toast.refuse(PAGE_FULL);
  return false;
}

/** A stroke the project validator keeps (PDF_STROKE_MAX_POINTS): past the
 *  cap, every k-th point (and the last) — a stroke that long is minutes of
 *  continuous drawing, and dropping it whole on the next load would be worse. */
export function capPoints(pts: Float32Array): Float32Array {
  const n = Math.floor(pts.length / 3);
  if (n <= PDF_STROKE_MAX_POINTS) return pts;
  const k = Math.ceil(n / (PDF_STROKE_MAX_POINTS - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i += k) out.push(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
  const last = (n - 1) * 3;
  if ((n - 1) % k !== 0) out.push(pts[last]!, pts[last + 1]!, pts[last + 2]!);
  return Float32Array.from(out);
}

function liveNode(env: Env, key: string, node: SVGElement | null, prev: SVGElement | null): SVGElement | null {
  prev?.remove();
  const f = env.layer.frame(key);
  if (!node || !f) return null;
  f.live.appendChild(node);
  return node;
}

/** The ruler pose on `key`, or null. */
export function rulerOn(env: Env, key: string): RulerPose | null {
  const r = env.ctx.tools.get().ruler;
  return r && r.key === key ? { cx: r.cx, cy: r.cy, angle: (r.angle * Math.PI) / 180 } : null;
}

/* ------------------------------------------------------------------ */
/* Ink                                                                 */
/* ------------------------------------------------------------------ */

export function startInk(env: Env, e: PointerEvent, key: string, kind: "pen" | "pencil" | "marker"): Gesture | null {
  const { ctx } = env;
  const at = env.pt(key, e);
  if (!at || !roomFor(env, key)) return null;
  const s = ctx.tools.get();
  const zoom = env.zoom();
  const color = normalizeHexColor(s.colors[kind], "#000000");
  const w = clampWidthPt(cssToPt(s.sizes[kind], zoom));
  const sampler = new StrokeSampler(e.pointerType === "pen" ? EMA_PEN : EMA_OTHER, MIN_SPACING_CSS / zoom);
  const ruler = rulerOn(env, key);
  const edge = ruler ? rulerEdge(ruler, at.x, at.y, RULER_CATCH_CSS / zoom) : 0;
  let path: SVGElement | null = null;
  let queued = false;
  // A preview frame queued by the last move runs AFTER up/cancel; once the
  // gesture has ended it must not draw the live mark back.
  let ended = false;
  // Shift held: a straight segment from the stroke's start to the pointer,
  // snapped to 15° steps; letting go of Shift goes back to the freehand line
  // (its points were kept all along).
  const start: [number, number] = [at.x, at.y];
  const p0 = pressureOf(e);
  let straight = e.shiftKey;
  let end: [number, number] = [at.x, at.y];
  const straightPts = (): Float32Array => Float32Array.from([start[0], start[1], p0, end[0], end[1], p0]);

  const add = (x: number, y: number, p: number): void => {
    if (ruler && edge !== 0) [x, y] = snapToRuler(ruler, edge, w / 2, x, y);
    sampler.push(x, y, p);
  };
  const paint = (): void => {
    queued = false;
    if (ended) return;
    const d = straight ? inkD(kind, w, straightPts(), 2) : inkD(kind, w, sampler.points, sampler.count);
    if (!path || !path.isConnected) {
      const node = document.createElementNS(SVG_NS, "path");
      if (kind === "marker") {
        node.setAttribute("fill", "none");
        node.setAttribute("stroke", color);
        node.setAttribute("stroke-width", String(w));
        node.setAttribute("stroke-linecap", "round");
        node.setAttribute("stroke-linejoin", "round");
        node.setAttribute("opacity", String(MARKER_OPACITY));
        node.setAttribute("class", "pdfmk-mark--multiply");
      } else {
        node.setAttribute("fill", color);
      }
      path = liveNode(env, key, node, path);
    }
    path?.setAttribute("d", d);
    if (kind === "pencil") path?.setAttribute("opacity", String(pencilOpacity(straight ? p0 : sampler.meanPressure())));
  };
  const queue = (): void => {
    if (queued) return;
    queued = true;
    env.frame(paint);
  };

  add(at.x, at.y, pressureOf(e));
  queue();

  return {
    move(ev) {
      for (const smp of collectPoints(ev)) {
        const q = env.pt(key, smp);
        if (q) add(q.x, q.y, pressureOf(smp));
      }
      straight = ev.shiftKey;
      if (straight) {
        const q = env.pt(key, ev);
        if (q) end = snapStraight(start, [q.x, q.y]);
      }
      queue();
    },
    up(ev) {
      ended = true;
      const q = env.pt(key, ev);
      if (ev.shiftKey) {
        // the committed ink is just the segment's two ends
        if (q) end = snapStraight(start, [q.x, q.y]);
        path?.remove();
        path = null;
        const o = kind === "marker" ? MARKER_OPACITY : kind === "pencil" ? pencilOpacity(p0) : 1;
        const annot: PdfAnnot = { id: newId(), t: "ink", kind, c: color, w, o, p: encodePoints(straightPts()) };
        ctx.session.commit((p) => addAnnot(p, key, annot));
        return;
      }
      if (q) {
        let [x, y] = [q.x, q.y];
        if (ruler && edge !== 0) [x, y] = snapToRuler(ruler, edge, w / 2, x, y);
        // a lifting pen reports pressure 0: keep the mark's own
        sampler.finish(x, y, Number.NaN);
      }
      path?.remove();
      path = null;
      if (sampler.count < 1) return;
      const pts = capPoints(simplifyStroke(sampler.points, sampler.count, SIMPLIFY_CSS / zoom));
      const o = kind === "marker" ? MARKER_OPACITY : kind === "pencil" ? pencilOpacity(sampler.meanPressure()) : 1;
      const annot: PdfAnnot = { id: newId(), t: "ink", kind, c: color, w, o, p: encodePoints(pts) };
      ctx.session.commit((p) => addAnnot(p, key, annot));
    },
    cancel() {
      ended = true;
      path?.remove();
      path = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export function startShape(env: Env, e: PointerEvent, key: string): Gesture | null {
  const { ctx } = env;
  const at = env.pt(key, e);
  if (!at || !roomFor(env, key)) return null;
  const s = ctx.tools.get();
  const kind: ShapeKind = s.shape;
  const zoom = env.zoom();
  const color = normalizeHexColor(s.colors.shape, "#000000");
  const w = clampWidthPt(cssToPt(s.sizes.shape, zoom));
  const a: Pt = [at.x, at.y];
  let b: Pt = [at.x, at.y];
  let node: SVGElement | null = null;
  let queued = false;
  let ended = false; // see startInk
  const annot = (): PdfAnnot => ({ id: "live", t: kind, c: color, w, a, b: [b[0], b[1]] });
  const paint = (): void => {
    queued = false;
    if (ended) return;
    node = liveNode(env, key, markNode(annot(), [], (x) => x), node);
  };
  const track = (ev: PointerEvent): void => {
    const q = env.pt(key, ev);
    if (!q) return;
    b = constrainShape(kind, a, [q.x, q.y], ev.shiftKey);
    if (!queued) {
      queued = true;
      env.frame(paint);
    }
  };
  return {
    move: track,
    up(ev) {
      track(ev);
      ended = true;
      node?.remove();
      node = null;
      if (!shapeLongEnough(kind, a, b, 1 / zoom)) return;
      const mark: PdfAnnot = { id: newId(), t: kind, c: color, w, a: [a[0], a[1]], b: [b[0], b[1]] };
      ctx.session.commit((p) => addAnnot(p, key, mark));
    },
    cancel() {
      ended = true;
      node?.remove();
      node = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Box drags: whiteout, free highlight                                 */
/* ------------------------------------------------------------------ */

export function startBox(env: Env, e: PointerEvent, key: string, kind: "whiteout" | "highlight"): Gesture | null {
  const { ctx } = env;
  const at = env.pt(key, e);
  if (!at || !roomFor(env, key)) return null;
  const zoom = env.zoom();
  const s = ctx.tools.get();
  const color = kind === "whiteout" ? WHITEOUT_COLOR : normalizeHexColor(s.colors.highlight, "#ffd400");
  let box = boxFrom(at.x, at.y, at.x, at.y);
  let node: SVGElement | null = null;
  let queued = false;
  let ended = false; // see startInk
  const make = (id: string): PdfAnnot =>
    kind === "whiteout"
      ? { id, t: "whiteout", x: box[0], y: box[1], w: box[2], h: box[3], c: color }
      : { id, t: "highlight", c: color, o: HIGHLIGHT_OPACITY, rects: [[box[0], box[1], box[2], box[3]]] };
  const paint = (): void => {
    queued = false;
    if (ended) return;
    const n = box[2] > 0 && box[3] > 0 ? markNode(make("live"), [], (x) => x) : null;
    n?.classList.add("pdfmk-live-box");
    node = liveNode(env, key, n, node);
  };
  const track = (ev: PointerEvent): void => {
    const q = env.pt(key, ev);
    if (!q) return;
    box = boxFrom(at.x, at.y, q.x, q.y);
    if (!queued) {
      queued = true;
      env.frame(paint);
    }
  };
  return {
    move: track,
    up(ev) {
      track(ev);
      ended = true;
      node?.remove();
      node = null;
      // a click is not a box
      const min = 2 / zoom;
      if (box[2] < min || box[3] < min) return;
      const mark = make(newId());
      ctx.session.commit((p) => addAnnot(p, key, mark));
    },
    cancel() {
      ended = true;
      node?.remove();
      node = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Highlight from the text selection                                   */
/* ------------------------------------------------------------------ */

/** The selected text's rects → one highlight per page, one history step.
 *  True when something was committed. */
export function highlightSelection(env: Env): boolean {
  const { ctx } = env;
  const hits = ctx.view.selectionRects().filter((h) => h.rects.length > 0);
  if (hits.length === 0) return false;
  const color = normalizeHexColor(ctx.tools.get().colors.highlight, "#ffd400");
  const before = ctx.session.project;
  ctx.session.commit((p) => {
    let next = p;
    for (const h of hits) {
      const rects = h.rects.map((r) => [r[0], r[1], r[2], r[3]] as [number, number, number, number]);
      next = addAnnot(next, h.key, { id: newId(), t: "highlight", c: color, o: HIGHLIGHT_OPACITY, rects });
    }
    return next;
  });
  try {
    window.getSelection?.()?.removeAllRanges();
  } catch {
    /* no selection API */
  }
  return ctx.session.project !== before;
}

/* ------------------------------------------------------------------ */
/* Eraser                                                              */
/* ------------------------------------------------------------------ */

/** The marks of `list` a disk of radius r swept A→B touches (ids); never a
 *  page picture (it is the page). */
export function eraserHits(list: readonly PdfAnnot[], ax: number, ay: number, bx: number, by: number, r: number, into: Set<string>): number {
  let n = 0;
  for (const a of list) {
    if (into.has(a.id) || isPagePicture(a)) continue;
    if (sweepHit(a, ax, ay, bx, by, r)) {
      into.add(a.id);
      n++;
    }
  }
  return n;
}

export function startEraser(env: Env, e: PointerEvent, key: string): Gesture | null {
  const { ctx } = env;
  const at = env.pt(key, e);
  if (!at) return null;
  const session = ctx.session;
  const before = session.project;
  let expected = before;
  const r = cssToPt(ctx.tools.get().sizes.eraser, env.zoom()) / 2;
  const hits = new Set<string>();
  let last = at;
  let stale = false;

  const along = (x: number, y: number): void => {
    if (stale) return;
    if (!sameEdit(session.project, expected)) {
      // someone else changed the project: theirs wins, this gesture steps aside
      stale = true;
      return;
    }
    const added = eraserHits(pageAnnots(before, key), last.x, last.y, x, y, r, hits);
    last = { x, y };
    if (added > 0) {
      const refs: AnnotRef[] = [...hits].map((id) => ({ pageId: key, id }));
      const next = removeAnnots(before, refs);
      expected = next;
      // a preview, not yet the user's edit (the release commits it)
      session.replace(next, { edit: false });
    }
  };
  along(at.x, at.y);
  return {
    move(ev) {
      for (const smp of collectPoints(ev)) {
        const q = env.pt(key, smp);
        if (q) along(q.x, q.y);
      }
    },
    up(ev) {
      const q = env.pt(key, ev);
      if (q) along(q.x, q.y);
      if (!stale && hits.size > 0 && sameEdit(session.project, expected)) session.commitFrom(before);
    },
    cancel() {
      if (!stale && hits.size > 0 && sameEdit(session.project, expected)) session.replace(before, { edit: false });
    },
  };
}
