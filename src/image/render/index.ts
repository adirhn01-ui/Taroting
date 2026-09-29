// The one Canvas2D renderer for image projects, preview AND export (WYSIWYG):
// `renderComposite` draws a ProjectFile through a `RenderResources` provider.
// The preview hands it working-resolution resources sized to the stage's
// device pixels; export hands it full-resolution ones on an OffscreenCanvas.
// No Web Worker anywhere (the CSP says `worker-src 'none'`).
//
// Not implemented yet: the declarations below are the contract the rest of the
// image editor compiles against. The stubs are INERT rather than throwing,
// because the editor shell constructs `PreviewResources` and renders on mount.

import type { ProjectFile } from "../../core/types";
import type { Layer } from "../layers";

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

export function renderComposite(
  ctx: Ctx2D,
  doc: ProjectFile,
  res: RenderResources,
  view: ViewXf,
  opts: RenderOpts,
): void;
export function renderComposite(): void {
  // inert until implemented
}

/** Preview resources: working bitmaps sized to stage device px, adjusted
 *  caches, per-drawing-layer rasters for the current view; invalidated by
 *  identity. */
export class PreviewResources implements RenderResources {
  constructor(getDoc: () => ProjectFile);
  constructor() {
    // inert until implemented
  }

  photo(l: Layer, needScale: number): CanvasImageSource | null;
  photo(): null {
    return null;
  }

  drawingRaster(l: Layer, view: ViewXf): CanvasImageSource | null;
  drawingRaster(): null {
    return null;
  }

  /** tell the cache the current zoom/stage so it picks working sizes (debounced re-decode) */
  setView(view: ViewXf, stageDevice: { w: number; h: number }): void;
  setView(): void {
    // inert until implemented
  }

  /** fires when an async decode/adjust finishes → caller requests a render */
  onChange(fn: () => void): () => void;
  onChange(): () => void {
    return () => {};
  }

  /** per-layer status for the Layers panel */
  status(trackId: string): {
    state: "loading" | "ready" | "failed";
    message?: string;
    natural?: { w: number; h: number };
  };
  status(): { state: "loading" } {
    return { state: "loading" };
  }

  /** drop cached pixels for one layer (relink, adjust reset) or all */
  invalidate(trackId?: string): void;
  invalidate(): void {
    // inert until implemented
  }

  /** decoded (EXIF-applied) dims disagree with MediaRef width/height → caller
   *  repairs via session.replace(updateMedia(...), { edit: false }) */
  onMediaDims(fn: (mediaId: string, w: number, h: number) => void): () => void;
  onMediaDims(): () => void {
    return () => {};
  }

  dispose(): void {
    // inert until implemented
  }
}
