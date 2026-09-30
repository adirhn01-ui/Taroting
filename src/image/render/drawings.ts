// Drawing-layer rasters for the preview: one stage-sized canvas per VISIBLE
// drawing layer, painted in the current view, so a frame composites a drawing
// with one drawImage however many strokes it holds.
//
// - Appending a stroke paints ONLY the new stroke: `appendStroke` keeps every
//   earlier chunk reference-equal, so "is the old drawing a prefix of the new
//   one?" is a handful of reference compares, and the pen stays O(new points).
// - Anything else (undo, erase-by-stroke, a relinked layer) replays the layer.
// - A view or layer-transform change (zoom, pan, dragging the layer) replays
//   too — immediately when the last replay was cheap, otherwise the old
//   raster is shown warped to the new view (one affine drawImage) and the
//   replay waits until the gesture has been quiet for REPLAY_SETTLE_MS.
//   A stage RESIZE is the same gesture (dragging the window edge renders on
//   every step): the old raster is warped into a stage-sized canvas and the
//   rebuild waits for the settle too.
// - A steady frame allocates nothing: L comes from the compositor's cache,
//   V·L is composed into one reused array, and each raster owns the copy of
//   the matrix it was painted with.
// - Hidden layers hold no raster; a layer that goes away takes its raster with
//   it (`retain`).
//
// Opacity is NOT baked in: the compositor applies it once, as group opacity.

import type { ProjectFile, Stroke } from "../../core/types";
import type { Layer } from "../layers";
import { createScratch, paintStroke, strokeBounds, type ReleasableScratch, type Scratch } from "../ink/paint";
import { chunksOf, layerBox, layerMatrix } from "./composite";
import type { ViewXf } from "./index";

/** A replay slower than this is deferred behind a warp during a gesture. */
export const WARP_ABOVE_MS = 6;
/** Quiet time after the last view change before a deferred replay runs. */
export const REPLAY_SETTLE_MS = 150;

type M6 = [number, number, number, number, number, number];

interface Raster {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** the V·L this raster was painted with */
  m: M6;
  chunks: readonly Stroke[][];
  count: number;
  replayMs: number;
  warp: OffscreenCanvas | null;
  settleTimer: number | undefined;
  /** a deferred replay has waited long enough: the next request replays */
  due: boolean;
}

/** out = V · L */
function composeView(view: ViewXf, l: readonly number[], out: M6): M6 {
  const z = view.zoom;
  out[0] = z * l[0]!;
  out[1] = z * l[1]!;
  out[2] = z * l[2]!;
  out[3] = z * l[3]!;
  out[4] = z * l[4]! + view.panX;
  out[5] = z * l[5]! + view.panY;
  return out;
}

function copyM(from: M6, to: M6): void {
  for (let i = 0; i < 6; i++) to[i] = from[i]!;
}

function sameM(a: M6, b: M6): boolean {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** out = a · b⁻¹ — maps the old raster's pixels to where the new view puts
 *  them. Null when b cannot be inverted. */
function relative(a: M6, b: M6, out: M6): M6 | null {
  const det = b[0] * b[3] - b[1] * b[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const ia = b[3] / det;
  const ib = -b[1] / det;
  const ic = -b[2] / det;
  const id = b[0] / det;
  const ie = (b[2] * b[5] - b[3] * b[4]) / det;
  const iff = (b[1] * b[4] - b[0] * b[5]) / det;
  out[0] = a[0] * ia + a[2] * ib;
  out[1] = a[1] * ia + a[3] * ib;
  out[2] = a[0] * ic + a[2] * id;
  out[3] = a[1] * ic + a[3] * id;
  out[4] = a[0] * ie + a[2] * iff + a[4];
  out[5] = a[1] * ie + a[3] * iff + a[5];
  return out;
}

function countOf(chunks: readonly Stroke[][]): number {
  let n = 0;
  for (const c of chunks) n += c.length;
  return n;
}

/**
 * Where the strokes of `next` that `prev` did not have begin, when `prev`'s
 * strokes are exactly the first `prevCount` of `next`, in order (the append
 * case). Null otherwise — the layer must be replayed.
 */
export function appendedFrom(
  prev: readonly Stroke[][],
  prevCount: number,
  next: readonly Stroke[][],
): { chunk: number; index: number } | null {
  if (countOf(next) < prevCount) return null;
  let seen = 0;
  for (let c = 0; c < prev.length; c++) {
    const a = prev[c]!;
    const b = next[c];
    if (b === undefined) return null;
    if (a !== b) {
      // Only the LAST old chunk may have been copied (to take the new stroke);
      // its old strokes must lead the copy unchanged.
      if (c !== prev.length - 1 || b.length < a.length) return null;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return null;
    }
    seen += a.length;
  }
  if (seen !== prevCount) return null;
  const last = prev.length - 1;
  if (last >= 0 && next[last]!.length > prev[last]!.length) return { chunk: last, index: prev[last]!.length };
  return { chunk: prev.length, index: 0 };
}

export class DrawingRasters {
  private readonly rasters = new Map<string, Raster>();
  private stageW = 0;
  private stageH = 0;
  private scratch: ReleasableScratch | null = null;
  /** this frame's V·L, reused (a raster copies it into its own `m`) */
  private readonly cur: M6 = [1, 0, 0, 1, 0, 0];
  /** the warp's relative transform, reused */
  private readonly rel: M6 = [1, 0, 0, 1, 0, 0];

  constructor(private readonly emit: () => void) {}

  setStage(w: number, h: number): void {
    const nw = Math.max(0, Math.floor(w));
    const nh = Math.max(0, Math.floor(h));
    if (nw === this.stageW && nh === this.stageH) return;
    this.stageW = nw;
    this.stageH = nh;
  }

  /** The layer's raster for `view`, or null when there is no stage yet (the
   *  compositor then paints the strokes itself). */
  raster(doc: ProjectFile, l: Layer, view: ViewXf): CanvasImageSource | null {
    if (this.stageW < 1 || this.stageH < 1) return null;
    const box = layerBox(l);
    const m = composeView(view, layerMatrix(l.transform, box.w, box.h, doc.timeline.width, doc.timeline.height), this.cur);
    const chunks = chunksOf(l);
    let r = this.rasters.get(l.trackId);
    const resized = r !== undefined && (r.canvas.width !== this.stageW || r.canvas.height !== this.stageH);

    // The stage is being resized under a heavy drawing: show the old raster
    // stretched into the new stage and rebuild once the resize settles —
    // replaying on every resize step is exactly the stall the warp avoids.
    if (r && resized && r.chunks === chunks && r.replayMs > WARP_ABOVE_MS && !r.due) {
      const w = this.warped(r, m);
      if (w) {
        this.armSettle(r);
        return w;
      }
    }

    if (!r || resized) {
      if (r) this.free(r);
      const canvas = new OffscreenCanvas(this.stageW, this.stageH);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        this.rasters.delete(l.trackId);
        return null;
      }
      r = { canvas, ctx, m: [1, 0, 0, 1, 0, 0], chunks, count: 0, replayMs: 0, warp: null, settleTimer: undefined, due: false };
      this.rasters.set(l.trackId, r);
      this.replay(r, m, chunks);
      return r.canvas;
    }

    if (sameM(r.m, m)) {
      // Back where the raster was painted (or never left): nothing deferred.
      clearTimeout(r.settleTimer);
      r.settleTimer = undefined;
      r.due = false;
      if (r.chunks === chunks) return this.shown(r);
      const from = appendedFrom(r.chunks, r.count, chunks);
      if (from) this.paintFrom(r, chunks, from);
      else this.replay(r, m, chunks);
      return this.shown(r);
    }

    // The view or the layer moved. A heavy drawing is warped until the
    // gesture has been quiet for REPLAY_SETTLE_MS (`due`), then replayed once.
    if (r.chunks === chunks && r.replayMs > WARP_ABOVE_MS && !r.due) {
      const w = this.warped(r, m);
      if (w) {
        this.armSettle(r);
        return w;
      }
    }
    this.replay(r, m, chunks);
    return this.shown(r);
  }

  /** Drop rasters of layers that are gone or hidden. */
  retain(visible: ReadonlySet<string>): void {
    for (const [id, r] of this.rasters) {
      if (!visible.has(id)) {
        this.free(r);
        this.rasters.delete(id);
      }
    }
  }

  invalidate(trackId?: string): void {
    if (trackId === undefined) {
      for (const r of this.rasters.values()) this.free(r);
      this.rasters.clear();
      return;
    }
    const r = this.rasters.get(trackId);
    if (r) {
      this.free(r);
      this.rasters.delete(trackId);
    }
  }

  /** Give every canvas back: the rasters, their warps, and the stroke scratch
   *  (grown to the largest pencil box drawn — up to the whole stage). */
  dispose(): void {
    this.invalidate();
    this.scratch?.release();
    this.scratch = null;
  }

  /* ---------------- internals ---------------- */

  private shown(r: Raster): CanvasImageSource {
    if (r.warp) {
      r.warp.width = 0;
      r.warp = null;
    }
    return r.canvas;
  }

  private free(r: Raster): void {
    clearTimeout(r.settleTimer);
    r.canvas.width = 0;
    r.canvas.height = 0;
    if (r.warp) {
      r.warp.width = 0;
      r.warp.height = 0;
    }
    r.warp = null;
  }

  private armSettle(r: Raster): void {
    clearTimeout(r.settleTimer);
    r.settleTimer = setTimeout(() => {
      r.settleTimer = undefined;
      r.due = true;
      this.emit();
    }, REPLAY_SETTLE_MS);
  }

  private warped(r: Raster, m: M6): OffscreenCanvas | null {
    const rel = relative(m, r.m, this.rel);
    if (!rel) return null;
    if (!r.warp) r.warp = new OffscreenCanvas(this.stageW, this.stageH);
    else if (r.warp.width !== this.stageW || r.warp.height !== this.stageH) {
      // the stage was resized mid-gesture
      r.warp.width = this.stageW;
      r.warp.height = this.stageH;
    }
    const c = r.warp.getContext("2d");
    if (!c) return null;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.stageW, this.stageH);
    c.setTransform(rel[0], rel[1], rel[2], rel[3], rel[4], rel[5]);
    c.drawImage(r.canvas, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
    return r.warp;
  }

  private strokesScratch(): Scratch {
    this.scratch ??= createScratch();
    return this.scratch;
  }

  /** Is a stroke's box (layer px) anywhere on the raster under m? */
  private onStage(s: Stroke, m: M6): boolean {
    const b = strokeBounds(s);
    if (b.w <= 0 && b.h <= 0) return true;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < 4; k++) {
      const x = k & 1 ? b.x + b.w : b.x;
      const y = k & 2 ? b.y + b.h : b.y;
      const tx = m[0] * x + m[2] * y + m[4];
      const ty = m[1] * x + m[3] * y + m[5];
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
    return maxX >= 0 && maxY >= 0 && minX <= this.stageW && minY <= this.stageH;
  }

  private replay(r: Raster, m: M6, chunks: readonly Stroke[][]): void {
    const t0 = performance.now();
    const c = r.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, r.canvas.width, r.canvas.height);
    c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const scratch = this.strokesScratch();
    let n = 0;
    for (const chunk of chunks) {
      for (const s of chunk) {
        n++;
        if (this.onStage(s, m)) paintStroke(c, s, scratch);
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    copyM(m, r.m);
    r.chunks = chunks;
    r.count = n;
    r.replayMs = performance.now() - t0;
    r.due = false;
    clearTimeout(r.settleTimer);
    r.settleTimer = undefined;
  }

  private paintFrom(r: Raster, chunks: readonly Stroke[][], from: { chunk: number; index: number }): void {
    const c = r.ctx;
    const m = r.m;
    c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const scratch = this.strokesScratch();
    for (let ci = from.chunk; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      for (let i = ci === from.chunk ? from.index : 0; i < chunk.length; i++) {
        const s = chunk[i]!;
        if (this.onStage(s, m)) paintStroke(c, s, scratch);
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    r.chunks = chunks;
    r.count = countOf(chunks);
  }
}
