// The one Canvas2D renderer for image projects, preview AND export (WYSIWYG):
// `renderComposite` draws a ProjectFile through a `RenderResources` provider.
// The preview hands it working-resolution resources sized to the stage's
// device pixels (`PreviewResources`); export hands it full-resolution ones on
// an OffscreenCanvas (render/export.ts). No Web Worker anywhere (the CSP says
// `worker-src 'none'`).
//
// Nothing here runs until an image project is open: this module is only
// reachable through the lazily loaded image chunk, and it allocates no canvas
// or bitmap at import time.

import type { MediaRef, ProjectFile } from "../../core/types";
import { layersOf, type Layer } from "../layers";
import { pickCheckerPalette } from "./checker";
import { releaseRenderScratch } from "./composite";
import { DrawingRasters } from "./drawings";
import { PhotoCache } from "./photos";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** device px per canvas px, and the device-px position of canvas (0,0) in the target */
export interface ViewXf {
  zoom: number;
  panX: number;
  panY: number;
}

export type Underlay = "checker" | "none" | "white";

export interface LiveInk {
  /** drawing layer being drawn on; null = a layer about to be created directly above `above` */
  trackId: string | null;
  above: string | null;
  /** paint the in-progress mark; ctx transform is already layer-local → target */
  paint(ctx: Ctx2D): void;
}

export interface RenderOpts {
  underlay: Underlay;
  /** canvas-px sub-rectangle (export strips); default = whole canvas */
  region?: { x: number; y: number; w: number; h: number };
  live?: LiveInk | null;
  /** layers not to draw (e.g. the one being cropped shows as a ghost instead) */
  skip?: ReadonlySet<string>;
}

export interface RenderResources {
  /** adjusted pixels of a photo layer at ≥ `needScale` source-px density, or null while loading/failed */
  photo(l: Layer, needScale: number): CanvasImageSource | null;
  /** raster of a drawing layer in the CURRENT view, or null → renderer paints strokes directly */
  drawingRaster(l: Layer, view: ViewXf): CanvasImageSource | null;
}

export { renderComposite } from "./composite";

/** Preview resources: working bitmaps sized to stage device px, adjusted
 *  caches, per-drawing-layer rasters for the current view; invalidated by
 *  identity. */
export class PreviewResources implements RenderResources {
  private readonly photos: PhotoCache;
  private readonly drawings: DrawingRasters;
  private readonly changeListeners = new Set<() => void>();
  private disposed = false;
  private pruneQueued = false;

  constructor(private readonly getDoc: () => ProjectFile) {
    const emit = (): void => this.emitChange();
    this.photos = new PhotoCache(emit);
    this.drawings = new DrawingRasters(emit);
    // The checker palette follows the app theme once per mount (content, not
    // chrome: it never re-themes under the user mid-edit).
    pickCheckerPalette();
  }

  photo(l: Layer, needScale: number): CanvasImageSource | null {
    this.queuePrune();
    return this.photos.photo(l, needScale);
  }

  drawingRaster(l: Layer, view: ViewXf): CanvasImageSource | null {
    this.queuePrune();
    return this.drawings.raster(this.getDoc(), l, view);
  }

  /** The photo file already held for `m`, or null (see `PhotoCache.blobFor`):
   *  the `blobFor` an export, a copy or a thumbnail render takes. */
  blobFor(m: MediaRef): Blob | null {
    return this.photos.blobFor(m);
  }

  /** tell the cache the current zoom/stage so it picks working sizes (debounced re-decode) */
  setView(view: ViewXf, stageDevice: { w: number; h: number }): void {
    void view;
    this.drawings.setStage(stageDevice.w, stageDevice.h);
  }

  /** fires when an async decode/adjust finishes → caller requests a render */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** per-layer status for the Layers panel */
  status(trackId: string): {
    state: "loading" | "ready" | "failed";
    message?: string;
    natural?: { w: number; h: number };
  } {
    const l = layersOf(this.getDoc()).find((x) => x.trackId === trackId);
    if (l && l.media.generator) return { state: "ready" };
    return this.photos.status(l?.media);
  }

  /** drop cached pixels for one layer (relink, adjust reset) or all */
  invalidate(trackId?: string): void {
    if (trackId === undefined) {
      this.photos.invalidate();
      this.drawings.invalidate();
      return;
    }
    this.drawings.invalidate(trackId);
    const l = layersOf(this.getDoc()).find((x) => x.trackId === trackId);
    if (l) this.photos.invalidate(l.media.id);
  }

  /** The decoded size of a photo whose MediaRef has NO usable size (a crafted
   *  or pre-probe file) → the caller records it via
   *  session.replace(updateMedia(...), { edit: false }). A recorded size is
   *  never overridden by the decoder (see photos.ts): the photo is drawn into
   *  it whatever the engine decoded. */
  onMediaDims(fn: (mediaId: string, w: number, h: number) => void): () => void {
    return this.photos.onMediaDims(fn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.photos.dispose();
    this.drawings.dispose();
    this.changeListeners.clear();
    releaseRenderScratch();
  }

  private emitChange(): void {
    if (this.disposed) return;
    for (const fn of this.changeListeners) fn();
  }

  /** Once per render pass: let go of pixels for layers that were deleted, and
   *  of drawing rasters for layers that are hidden (they hold none). */
  private queuePrune(): void {
    if (this.pruneQueued) return;
    this.pruneQueued = true;
    queueMicrotask(() => {
      this.pruneQueued = false;
      if (this.disposed) return;
      const layers = layersOf(this.getDoc());
      const media = new Set<string>();
      const visible = new Set<string>();
      for (const l of layers) {
        media.add(l.media.id);
        if (!l.hidden) visible.add(l.trackId);
      }
      this.photos.retain(media);
      this.drawings.retain(visible);
    });
  }
}
