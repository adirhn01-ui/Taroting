// The image-project compositor: one Canvas2D code path for the stage AND for
// export, so what the user sees is what the file gets.
//
// It is split into primitives (clear, underlay, background, one layer) that
// `renderComposite` strings together synchronously for the preview, and that
// the exporter drives ONE LAYER AT A TIME with awaits in between — export has
// to decode, adjust and release each photo before the next one exists, or a
// project of five 48 MP photos would hold all five at once. Same primitives,
// same pixels.
//
// Geometry: a layer is drawn through M = V · L, where L = `layerToCanvas`
// (layer-local source px → canvas px, native-pixel: k = transform.scale) and V
// = the view (canvas px → target device px). The MediaRef's width/height is
// the layer box every source is drawn into, whatever size the pixels behind it
// were decoded at: a working-resolution photo simply scales into it, and the
// recorded size always wins over the decoder (see photos.ts).

import { fontString } from "../../editor/media/generators";
import { normalizeHexColor } from "../../core/session";
import type { ClipTransform, Generator, ProjectFile, Stroke } from "../../core/types";
import { layerToCanvas } from "../geom";
import { layersOf, type Layer } from "../layers";
import { createScratch, paintStroke, type ReleasableScratch, type Scratch } from "../ink/paint";
import { fillChecker } from "./checker";
import type { Ctx2D, LiveInk, RenderOpts, RenderResources, Underlay, ViewXf } from "./index";

/** The export's view: the output may be scaled by a slightly different factor
 *  on each axis (25% of 641×361 is 160×90, and 160/641 ≠ 90/361). A single
 *  zoom would leave a fractional, half-covered last row or column. The
 *  preview never sets `zoomY`. */
export interface ScaledView extends ViewXf {
  zoomY?: number;
}

const zoomYOf = (view: ViewXf): number => (view as ScaledView).zoomY ?? view.zoom;

/** Line height of text generators, in font sizes — the value the stage's CSS
 *  (`line-height: 1.25`) and `measureText` use. */
const TEXT_LINE_HEIGHT = 1.25;

/* ------------------------------------------------------------------ */
/* Matrices                                                            */
/* ------------------------------------------------------------------ */

type Affine = [number, number, number, number, number, number];

interface CachedMatrix {
  sw: number;
  sh: number;
  cw: number;
  ch: number;
  m: Affine;
}
/** Transforms are immutable project values, so L can be cached on the
 *  transform object itself: a steady frame computes (and allocates) nothing. */
const matrices = new WeakMap<ClipTransform, CachedMatrix>();

/** L for a transform and box, cached on the transform: the drawing rasters
 *  use it too, so no frame recomputes it. Never mutate the result. */
export function layerMatrix(t: ClipTransform, sw: number, sh: number, cw: number, ch: number): Affine {
  const hit = matrices.get(t);
  if (hit && hit.sw === sw && hit.sh === sh && hit.cw === cw && hit.ch === ch) return hit.m;
  const m = layerToCanvas(t, sw, sh, cw, ch);
  matrices.set(t, { sw, sh, cw, ch, m });
  return m;
}

/** ctx.setTransform(V · L). */
function applyLayerTransform(ctx: Ctx2D, view: ViewXf, m: Affine): void {
  const zx = view.zoom;
  const zy = zoomYOf(view);
  ctx.setTransform(zx * m[0], zy * m[1], zx * m[2], zy * m[3], zx * m[4] + view.panX, zy * m[5] + view.panY);
}

/** ctx.setTransform(V): canvas px → target. */
function applyView(ctx: Ctx2D, view: ViewXf): void {
  ctx.setTransform(view.zoom, 0, 0, zoomYOf(view), view.panX, view.panY);
}

/** Recorded boxes, cached on the (immutable) MediaRef so a steady frame
 *  allocates none. */
const boxes = new WeakMap<object, { readonly w: number; readonly h: number }>();

/** The layer box in source px: the MediaRef's recorded size, else (a crafted
 *  or pre-probe file) the pixels' own size. Never mutate the result. */
export function layerBox(l: Layer, src?: CanvasImageSource | null): { readonly w: number; readonly h: number } {
  const mw = l.media.width;
  const mh = l.media.height;
  if (typeof mw === "number" && typeof mh === "number" && mw > 0 && mh > 0 && Number.isFinite(mw) && Number.isFinite(mh)) {
    const hit = boxes.get(l.media);
    if (hit && hit.w === mw && hit.h === mh) return hit;
    const box = { w: mw, h: mh };
    boxes.set(l.media, box);
    return box;
  }
  const s = src as { width?: unknown; height?: unknown } | null | undefined;
  const w = typeof s?.width === "number" && s.width > 0 ? s.width : 1;
  const h = typeof s?.height === "number" && s.height > 0 ? s.height : 1;
  return { w, h };
}

function matrixOf(doc: ProjectFile, l: Layer, box: { w: number; h: number }): Affine {
  return layerMatrix(l.transform, box.w, box.h, doc.timeline.width, doc.timeline.height);
}

/** A layer's effective opacity, clamped to 0..1; a non-finite value (a
 *  crafted file) counts as 1. Preview and export both filter with this, so
 *  they can never disagree about which layers exist. */
export function opacityOf(l: Layer): number {
  const o = l.transform.opacity;
  return Number.isFinite(o) ? Math.min(Math.max(o, 0), 1) : 1;
}

/* ------------------------------------------------------------------ */
/* Scratch surfaces                                                    */
/* ------------------------------------------------------------------ */

let layerCanvas: OffscreenCanvas | null = null;
let strokeScratch: ReleasableScratch | null = null;

/** The preview's ONE reused layer scratch (group opacity and live ink need a
 *  layer of their own before it is composited), cleared, at least w×h. Only
 *  ever used synchronously within one render: the exporter, which awaits
 *  between chunks, brings its own (see `openDrawingLayer`). */
function layerScratch(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
  if (!layerCanvas || layerCanvas.width < w || layerCanvas.height < h) {
    if (layerCanvas) {
      layerCanvas.width = Math.max(layerCanvas.width, w);
      layerCanvas.height = Math.max(layerCanvas.height, h);
    } else {
      layerCanvas = new OffscreenCanvas(w, h);
    }
  }
  return clearedScratch(layerCanvas, w, h);
}

function clearedScratch(canvas: OffscreenCanvas, w: number, h: number): OffscreenCanvasRenderingContext2D | null {
  const c = canvas.getContext("2d");
  if (!c) return null;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, w, h);
  return c;
}

function previewStrokes(): Scratch {
  strokeScratch ??= createScratch();
  return strokeScratch;
}

/** Give the preview's scratch surfaces back: called when an editor unmounts
 *  (`PreviewResources.dispose`). */
export function releaseRenderScratch(): void {
  if (layerCanvas) {
    layerCanvas.width = 0;
    layerCanvas.height = 0;
  }
  layerCanvas = null;
  // Its backing store too, not just the reference: a pencil stroke grows it
  // to the stroke's box, and it would otherwise wait for a collection.
  strokeScratch?.release();
  strokeScratch = null;
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** The canvas rectangle in target device px. */
export function canvasRect(doc: ProjectFile, view: ViewXf): { x: number; y: number; w: number; h: number } {
  return {
    x: view.panX,
    y: view.panY,
    w: doc.timeline.width * view.zoom,
    h: doc.timeline.height * zoomYOf(view),
  };
}

/** Clear the target (or just the region's pixels) — the stage canvas is
 *  transparent outside the image, so the app surface shows around it. */
export function clearTarget(ctx: Ctx2D, view: ViewXf, region?: RenderOpts["region"]): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (region) {
    const zy = zoomYOf(view);
    ctx.clearRect(view.panX + region.x * view.zoom, view.panY + region.y * zy, region.w * view.zoom, region.h * zy);
  } else {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
}

// The underlay and background compute the canvas rectangle inline rather
// than through `canvasRect`: they run every frame, and a steady frame
// allocates nothing.
export function drawUnderlay(ctx: Ctx2D, doc: ProjectFile, view: ViewXf, underlay: Underlay): void {
  if (underlay === "none") return;
  const w = doc.timeline.width * view.zoom;
  const h = doc.timeline.height * zoomYOf(view);
  if (underlay === "checker") {
    fillChecker(ctx, view.panX, view.panY, w, h);
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(view.panX, view.panY, w, h);
}

/** The project's background colour, unless transparent. Re-validated here:
 *  an invalid string assigned to fillStyle is silently ignored and the
 *  previous fill would paint instead. */
export function drawBackground(ctx: Ctx2D, doc: ProjectFile, view: ViewXf): void {
  const bg = doc.image?.background;
  if (bg === undefined || bg === "transparent") return;
  const color = normalizeHexColor(bg, "");
  if (color === "") return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillRect(view.panX, view.panY, doc.timeline.width * view.zoom, doc.timeline.height * zoomYOf(view));
}

interface TextLook {
  font: string;
  color: string;
  lines: string[];
  step: number;
}
const textLooks = new WeakMap<object, TextLook>();
function textLook(g: Extract<Generator, { type: "text" }>): TextLook {
  let t = textLooks.get(g);
  if (!t) {
    const size = Number.isFinite(g.sizePx) && g.sizePx > 0 ? g.sizePx : 1;
    t = { font: fontString(g), color: normalizeHexColor(g.color, ""), lines: g.text.split("\n"), step: size * TEXT_LINE_HEIGHT };
    textLooks.set(g, t);
  }
  return t;
}

/** Clip to the layer's crop window (default: the whole media box), in
 *  layer-local px — the current transform must already be M. */
function clipToCrop(ctx: Ctx2D, t: ClipTransform, box: { w: number; h: number }): void {
  const c = t.crop;
  ctx.beginPath();
  if (c) ctx.rect(c.x, c.y, c.w, c.h);
  else ctx.rect(0, 0, box.w, box.h);
  ctx.clip();
}

/** Paint the strokes of chunks [fromChunk, toChunk) onto `target`, whose
 *  transform must already be M, in strict stroke order. The exporter calls it
 *  a chunk (≤ STROKE_CHUNK strokes) at a time with a yield in between, with
 *  its own pencil scratch (`scratch`); the preview uses its shared one. */
export function paintDrawingStrokes(
  target: Ctx2D,
  chunks: readonly Stroke[][],
  fromChunk: number,
  toChunk: number,
  scratch: Scratch = previewStrokes(),
): void {
  const end = Math.min(toChunk, chunks.length);
  for (let c = Math.max(0, fromChunk); c < end; c++) {
    const chunk = chunks[c];
    if (!Array.isArray(chunk)) continue;
    for (let i = 0; i < chunk.length; i++) paintStroke(target, chunk[i]!, scratch);
  }
}

/** A drawing layer's stroke chunks (none for anything else). */
export function chunksOf(l: Layer): readonly Stroke[][] {
  const g = l.media.generator;
  return g?.type === "drawing" && Array.isArray(g.chunks) ? g.chunks : [];
}

/** Composite the layer scratch's w×h into ctx at `alpha`. */
function compositeScratch(ctx: Ctx2D, scratch: OffscreenCanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(scratch.canvas, 0, 0, w, h, 0, 0, w, h);
  ctx.globalAlpha = 1;
}

/**
 * Draw one layer. `live` is the in-progress mark when this layer is its
 * target: it is painted INSIDE the layer (so a pixel-erase stroke erases this
 * layer only, a marker sits under this layer's ink, and the layer's opacity
 * applies to it too), and a hidden target shows the mark alone.
 */
export function drawLayer(
  ctx: Ctx2D,
  doc: ProjectFile,
  l: Layer,
  res: RenderResources,
  view: ViewXf,
  live: LiveInk | null = null,
  hidden = false,
): void {
  const alpha = opacityOf(l);
  if (alpha <= 0) return;
  const g = l.media.generator;

  if (g?.type === "drawing") {
    drawDrawingLayer(ctx, doc, l, res, view, alpha, live, hidden);
    return;
  }
  if (hidden) return;

  if (g === undefined) {
    // photo
    const zoom = Math.max(view.zoom, zoomYOf(view));
    const k = Number.isFinite(l.transform.scale) && l.transform.scale > 0 ? l.transform.scale : 1;
    const src = res.photo(l, k * zoom);
    if (!src) return;
    const box = layerBox(l, src);
    const m = matrixOf(doc, l, box);
    ctx.save();
    applyLayerTransform(ctx, view, m);
    clipToCrop(ctx, l.transform, box);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, box.w, box.h);
    ctx.restore();
    return;
  }

  const box = layerBox(l);
  const m = matrixOf(doc, l, box);
  if (g.type === "solid") {
    const color = normalizeHexColor(g.color, "");
    if (color === "") return;
    ctx.save();
    applyLayerTransform(ctx, view, m);
    clipToCrop(ctx, l.transform, box);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, box.w, box.h);
    ctx.restore();
    return;
  }
  if (g.type === "text") {
    const look = textLook(g);
    if (look.color === "") return;
    ctx.save();
    applyLayerTransform(ctx, view, m);
    clipToCrop(ctx, l.transform, box);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = look.color;
    ctx.font = look.font;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i < look.lines.length; i++) ctx.fillText(look.lines[i]!, 0, (i + 0.5) * look.step);
    ctx.restore();
  }
}

function drawDrawingLayer(
  ctx: Ctx2D,
  doc: ProjectFile,
  l: Layer,
  res: RenderResources,
  view: ViewXf,
  alpha: number,
  live: LiveInk | null,
  hidden: boolean,
): void {
  const raster = hidden ? null : res.drawingRaster(l, view);
  const tw = ctx.canvas.width;
  const th = ctx.canvas.height;
  if (raster && !live) {
    // The raster is already in target space for this view.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(raster, 0, 0);
    ctx.globalAlpha = 1;
    return;
  }
  // Group opacity: the strokes (and the live mark) go onto ONE layer scratch,
  // which is composited once at the layer's opacity — a translucent layer
  // looks translucent as a whole, overlaps included.
  const scratch = layerScratch(tw, th);
  if (!scratch) return;
  const box = layerBox(l);
  const m = matrixOf(doc, l, box);
  if (raster) {
    scratch.drawImage(raster, 0, 0);
  } else if (!hidden) {
    applyLayerTransform(scratch, view, m);
    const chunks = chunksOf(l);
    paintDrawingStrokes(scratch, chunks, 0, chunks.length);
  }
  if (live) {
    applyLayerTransform(scratch, view, m);
    scratch.globalAlpha = 1;
    scratch.globalCompositeOperation = "source-over";
    live.paint(scratch);
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.globalAlpha = 1;
    scratch.globalCompositeOperation = "source-over";
  }
  compositeScratch(ctx, scratch, tw, th, alpha);
}

/** The exporter's drawing path: the same stroke painting and single
 *  group-opacity composite as `drawLayer`, opened so the strokes can be
 *  painted one chunk at a time with a yield between chunks. `own` is the
 *  export run's OWN output-sized scratch — never the preview's, which a stage
 *  render during one of those yields (the user still drawing while Copy image
 *  renders, a resize behind the export dialog) would clear under it.
 *  `inkScratch` is the run's own pencil scratch too: the painter clips it to
 *  the target, which in export is the whole output, so a pencil stroke across
 *  a 48 MP canvas grows it to ~192 MB — the run must be able to give that back
 *  when it ends, which the preview's shared one never does. Null
 *  when the layer draws nothing (opacity 0) or no scratch could be made. */
export function openDrawingLayer(
  ctx: Ctx2D,
  doc: ProjectFile,
  l: Layer,
  view: ViewXf,
  own: OffscreenCanvas,
  inkScratch: Scratch,
): { chunkCount: number; paint(fromChunk: number, toChunk: number): void; close(): void } | null {
  const alpha = opacityOf(l);
  if (alpha <= 0) return null;
  const tw = ctx.canvas.width;
  const th = ctx.canvas.height;
  if (own.width < tw) own.width = tw;
  if (own.height < th) own.height = th;
  const scratch = clearedScratch(own, tw, th);
  if (!scratch) return null;
  const m = matrixOf(doc, l, layerBox(l));
  const chunks = chunksOf(l);
  return {
    chunkCount: chunks.length,
    paint(fromChunk, toChunk) {
      applyLayerTransform(scratch, view, m);
      paintDrawingStrokes(scratch, chunks, fromChunk, toChunk, inkScratch);
    },
    close() {
      compositeScratch(ctx, scratch, tw, th, alpha);
    },
  };
}

/** A mark on a drawing layer that does not exist yet: `addDrawingLayer` will
 *  give it a canvas-sized box at the identity transform, so layer-local px ARE
 *  canvas px and the view alone maps it. */
function drawPendingLive(ctx: Ctx2D, view: ViewXf, live: LiveInk): void {
  const tw = ctx.canvas.width;
  const th = ctx.canvas.height;
  const scratch = layerScratch(tw, th);
  if (!scratch) return;
  applyView(scratch, view);
  live.paint(scratch);
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalAlpha = 1;
  scratch.globalCompositeOperation = "source-over";
  compositeScratch(ctx, scratch, tw, th, 1);
}

/* ------------------------------------------------------------------ */
/* The composite                                                       */
/* ------------------------------------------------------------------ */

export function renderComposite(ctx: Ctx2D, doc: ProjectFile, res: RenderResources, view: ViewXf, opts: RenderOpts): void {
  clearTarget(ctx, view, opts.region);
  ctx.save();
  if (opts.region) {
    applyView(ctx, view);
    ctx.beginPath();
    ctx.rect(opts.region.x, opts.region.y, opts.region.w, opts.region.h);
    ctx.clip();
  }
  drawUnderlay(ctx, doc, view, opts.underlay);
  drawBackground(ctx, doc, view);
  // Nothing outside the canvas is part of the image, so nothing outside it is
  // shown: a layer (or ink) hanging past the edge is cut there, exactly as the
  // export cuts it, and a cropped canvas shows only what it kept. Clips
  // intersect, so this stays inside the region above. After the underlay and
  // background on purpose: those fill exactly this rectangle already, and a
  // clip edge on a fractional device pixel is anti-aliased — under it their
  // edge pixels would be attenuated twice.
  applyView(ctx, view);
  ctx.beginPath();
  ctx.rect(0, 0, doc.timeline.width, doc.timeline.height);
  ctx.clip();

  const live = opts.live ?? null;
  const skip = opts.skip;
  const layers = layersOf(doc);
  // A mark for a layer that does not exist yet sits directly above `above`
  // (on top of everything when `above` is null); one whose target vanished
  // (undone mid-gesture) sits on top too, so the stroke never disappears
  // under the pen.
  let liveDone = live === null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    const isTarget = live !== null && live.trackId !== null && live.trackId === l.trackId;
    const skipped = skip?.has(l.trackId) === true;
    if (isTarget && !skipped) {
      drawLayer(ctx, doc, l, res, view, live, l.hidden);
      liveDone = true;
    } else if (!l.hidden && !skipped) {
      drawLayer(ctx, doc, l, res, view);
    }
    if (live && !liveDone && live.trackId === null && live.above === l.trackId) {
      drawPendingLive(ctx, view, live);
      liveDone = true;
    }
  }
  if (live && !liveDone) drawPendingLive(ctx, view, live);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}
