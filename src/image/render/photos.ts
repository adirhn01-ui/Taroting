// Photo pixels for the image editor's preview: fetch once, keep the
// compressed file in memory, decode at WORKING resolution (what the stage can
// actually show), and keep an adjusted copy beside it.
//
// Memory is the point. A 48 MP photo is 192 MB decoded; shown fitted on a
// 1920×1080 stage it needs ~8 MB. A photo whose MediaRef records its size
// (every imported one — that size is authoritative, see ORIENTATION) is
// decoded STRAIGHT at the working level,
// `min(natural, ceil(natural × layer scale × zoom))`, and re-decoded
// (debounced) only when the zoom asks for more; opening a project of five
// 48 MP photos never holds five full decodes at once. Only a zoom ≥ 100%, or a
// MediaRef with no size to go by, decodes the whole photo. At most two levels
// live per photo.
//
// ORIENTATION. The backend decides per file which way the WebView draws a
// still (`exif::read_still`, `MediaRef.noAutorotate`) and records that size on
// the MediaRef. The compositor always draws a photo INTO that recorded box, so
// preview, export and the stored project can never disagree about geometry —
// the decoder is never trusted over the MediaRef. `stillFit` classifies what
// the decoder produced; anything but "match" is a runtime drift (a WebView2
// update turning a file it did not turn before) and is surfaced on the layer,
// never silently adopted. `onMediaDims` fires only when a MediaRef has NO
// usable size to begin with (a crafted file): then the decoded size is all
// there is. `decodeStill` is exported so the E2E drift alarm drives the very
// decode this module uses.
//
// SHARING. Pixels are keyed by the FILE (path + size + mtime), not the layer:
// a duplicated layer is a new MediaRef over the same file and must not fetch,
// hold and decode it again. Only the adjusted copy is per layer.
//
// DRAGGING AN ADJUSTMENT. Zoomed in on a big photo the working level IS the
// photo, and re-adjusting 24 MP every frame of a slider drag is hundreds of
// milliseconds a frame. A change that lands within ADJUST_DRAG_MS of the last
// one is a drag: it adjusts a proxy of about the stage's pixel count instead
// (drawn into the same recorded box, so only sharpness differs), and the full
// level is adjusted once, when the drag has been quiet for ADJUST_DRAG_MS. A
// single change, and any level already near the stage's size, takes the
// sharp path directly: nothing here runs unless a big photo is being dragged.

import { mediaUrl } from "../../core/ipc";
import type { ClipAdjust, MediaRef } from "../../core/types";
import { RENDER_MAX_AREA, RENDER_MAX_SIDE } from "../../core/types";
import { applyAdjustPlan, buildAdjustPlan, isIdentityAdjust, type AdjustPlan } from "../adjust/plan";
import type { Layer } from "../layers";

/** Rows per getImageData/putImageData strip when adjusting. */
export const ADJUST_STRIP_ROWS = 256;
/** Quiet time after the last zoom/scale change before a sharper level is decoded. */
export const LEVEL_DEBOUNCE_MS = 200;
/** Levels kept per photo. */
const MAX_LEVELS = 2;
/** An adjustment change this soon after the previous one is a drag (a slider,
 *  a held key); the same quiet time ends it. */
export const ADJUST_DRAG_MS = 150;
/** The stage's device-pixel count until the stage says otherwise. */
const DEFAULT_STAGE_AREA = 1920 * 1080;

/** How a decoded still relates to the size its MediaRef recorded:
 *  - match: the same size (the only healthy answer);
 *  - transposed: width and height swapped — the decoder turned (or did not
 *    turn) a file the other way from what the backend measured;
 *  - different: any other size (the file changed under the project);
 *  - unrecorded: the MediaRef carries no usable size. */
export type StillFit = "match" | "transposed" | "different" | "unrecorded";

function validDim(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export function stillFit(decoded: { w: number; h: number }, stored: Pick<MediaRef, "width" | "height">): StillFit {
  if (!validDim(stored.width) || !validDim(stored.height)) return "unrecorded";
  if (decoded.w === stored.width && decoded.h === stored.height) return "match";
  if (decoded.w === stored.height && decoded.h === stored.width) return "transposed";
  return "different";
}

/** The largest size ≤ the Chromium canvas limits at w×h's aspect (floor, ≥ 1). */
export function fitRenderLimits(w: number, h: number): { w: number; h: number; reduced: boolean } {
  const s = Math.min(1, RENDER_MAX_SIDE / w, RENDER_MAX_SIDE / h, Math.sqrt(RENDER_MAX_AREA / (w * h)));
  if (s >= 1) return { w, h, reduced: false };
  let ow = Math.max(1, Math.min(RENDER_MAX_SIDE, Math.floor(w * s + 1e-6)));
  let oh = Math.max(1, Math.min(RENDER_MAX_SIDE, Math.floor(h * s + 1e-6)));
  // Floating error at the limiting side can land one pixel over the area cap.
  while (ow * oh > RENDER_MAX_AREA) {
    if (ow >= oh) ow--;
    else oh--;
  }
  return { w: ow, h: oh, reduced: true };
}

/** Decode a still exactly as the image editor does: EXIF orientation applied
 *  by the engine (`from-image`), optionally resized with high quality. */
export function decodeStill(blob: Blob, resize?: { w: number; h: number }): Promise<ImageBitmap> {
  const opts: ImageBitmapOptions = { imageOrientation: "from-image" };
  if (resize) {
    opts.resizeWidth = Math.max(1, Math.round(resize.w));
    opts.resizeHeight = Math.max(1, Math.round(resize.h));
    opts.resizeQuality = "high";
  }
  return createImageBitmap(blob, opts);
}

/** Read a photo's file through the asset protocol. Resolves null when it is
 *  missing: the asset handler answers a missing or refused file with an EMPTY
 *  403/404, which `fetch` happily resolves — `res.ok` is the only signal. */
export async function fetchPhoto(path: string): Promise<Blob | null> {
  try {
    const res = await fetch(mediaUrl(path));
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/** Width of the working level a layer needs: device px per source px is
 *  `needScale`, never more than the photo has. */
export function workingWidth(fullW: number, needScale: number): number {
  const s = Number.isFinite(needScale) && needScale > 0 ? needScale : 1;
  return Math.max(1, Math.min(fullW, Math.ceil(fullW * s)));
}

/** Adjust rows [y, y + rows) of a canvas in place. getImageData is taken a
 *  strip at a time so its transient copy stays bounded (256 rows of a 8000 px
 *  photo is 8 MB, not the photo's full 256 MB). */
export function adjustStrip(c: OffscreenCanvasRenderingContext2D, w: number, y: number, rows: number, plan: AdjustPlan): void {
  const img = c.getImageData(0, y, w, rows);
  applyAdjustPlan(img.data, plan);
  c.putImageData(img, 0, y);
}

/** Adjust a whole w×h canvas, strip by strip, synchronously (the preview's
 *  working level; export yields between strips instead). */
export function adjustInStrips(c: OffscreenCanvasRenderingContext2D, w: number, h: number, adjust: ClipAdjust): void {
  const plan = buildAdjustPlan(adjust);
  for (let y = 0; y < h; y += ADJUST_STRIP_ROWS) adjustStrip(c, w, y, Math.min(ADJUST_STRIP_ROWS, h - y), plan);
}

interface Level {
  w: number;
  h: number;
  bmp: ImageBitmap;
}

interface Adjusted {
  level: Level;
  adjust: ClipAdjust;
  canvas: OffscreenCanvas;
  /** made from a drag proxy, not from `level` itself */
  proxy: boolean;
}

/** What a drag adjusts instead of a big level: the smallest level when it is
 *  near the stage's size already, else a downscale of the level made once
 *  (`canvas`, owned here; null when a level is used as it is). */
interface ProxyBase {
  /** the level bitmap it stands for */
  of: ImageBitmap;
  canvas: OffscreenCanvas | null;
  w: number;
  h: number;
}

/** One FILE's pixels, shared by every layer that shows it (a duplicated
 *  layer gets a new MediaRef id but the same file): one fetch, one resident
 *  blob, one set of decoded levels. */
interface FileEntry {
  /** keyOf(media); "" once dropped */
  key: string;
  state: "loading" | "ready" | "failed";
  /** a failure, or "Shown at …" for a photo reduced to the canvas limits */
  message?: string;
  blob: Blob | null;
  /** size of the photo as decoded (the status report) */
  natural: { w: number; h: number } | null;
  /** largest level this photo can be decoded at (natural, or fitted to the
   *  canvas limits for a photo bigger than they allow) */
  full: { w: number; h: number } | null;
  /** the size a whole, unreduced decode produced — what each layer's
   *  recorded size is checked against (null on the working-level path) */
  exact: { w: number; h: number } | null;
  levels: Level[];
  wantW: number;
  timer: number | undefined;
  decoding: number;
  /** ids of the MediaRefs (layers) showing this file */
  refs: Set<string>;
}

/** One layer's view of a file: its own adjusted copy (adjustments are per
 *  layer) and the scale it last asked for. */
interface LayerEntry {
  file: FileEntry;
  media: MediaRef;
  adjusted: Adjusted | null;
  lastNeed: number;
  /** when the adjust object last changed (performance.now) */
  adjustAt: number;
  /** a drag's settle timer: when it fires, the sharp level is adjusted */
  settle: number | undefined;
  proxy: ProxyBase | null;
}

function keyOf(m: MediaRef): string {
  return `${m.path}|${m.size}|${m.mtimeMs}`;
}

/** A need as `workingWidth` reads it: a bad value means 1. */
function needOf(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The photo half of `PreviewResources`. Knows nothing about drawings, the
 * stage or the DOM; `emit` is how it says "pixels changed, render again".
 * Pixels are cached per FILE (path + size + mtime), adjusted copies per layer.
 */
export class PhotoCache {
  private readonly files = new Map<string, FileEntry>();
  private readonly layers = new Map<string, LayerEntry>();
  private readonly dimsListeners = new Set<(mediaId: string, w: number, h: number) => void>();
  private readonly dimsReported = new Set<string>();
  private disposed = false;
  /** at most one re-adjust per synchronous render pass */
  private adjustSpent = false;
  /** device pixels of the stage: the size a drag proxy is capped to */
  private stageArea = DEFAULT_STAGE_AREA;

  constructor(private readonly emit: () => void) {}

  onMediaDims(fn: (mediaId: string, w: number, h: number) => void): () => void {
    this.dimsListeners.add(fn);
    return () => this.dimsListeners.delete(fn);
  }

  /** The stage's size in device px: a drag proxy never holds more pixels
   *  than the stage can show. */
  setStage(w: number, h: number): void {
    const a = Math.floor(w) * Math.floor(h);
    this.stageArea = Number.isFinite(a) && a > 0 ? a : DEFAULT_STAGE_AREA;
  }

  status(media: MediaRef | undefined): {
    state: "loading" | "ready" | "failed";
    message?: string;
    natural?: { w: number; h: number };
  } {
    if (!media) return { state: "failed", message: "Layer not found" };
    const le = this.layers.get(media.id);
    if (!le || le.file.key !== keyOf(media)) return { state: "loading" };
    const fe = le.file;
    const out: { state: "loading" | "ready" | "failed"; message?: string; natural?: { w: number; h: number } } = {
      state: fe.state,
    };
    if (fe.message !== undefined) out.message = fe.message;
    else if (fe.exact) {
      // Drawn into the recorded box regardless (composite.ts); say so, so a
      // runtime that changed its mind about orientation is visible. Per layer:
      // it is THIS MediaRef's recorded size that disagrees.
      const fit = stillFit(fe.exact, media);
      if (fit === "transposed" || fit === "different") {
        out.message = `Decodes at ${fe.exact.w} × ${fe.exact.h}, recorded as ${media.width} × ${media.height}`;
      }
    }
    if (fe.natural) out.natural = { ...fe.natural };
    return out;
  }

  photo(l: Layer, needScale: number): CanvasImageSource | null {
    if (this.disposed || l.media.generator) return null;
    let le = this.layers.get(l.media.id);
    if (!le || le.file.key !== keyOf(l.media)) {
      if (le) this.detach(l.media.id, le);
      le = this.attach(l.media, needScale);
    }
    le.media = l.media;
    le.lastNeed = needScale;
    const fe = le.file;
    if (fe.state !== "ready" || !fe.full || fe.levels.length === 0) return null;

    const level = pickLevel(fe.levels, workingWidth(fe.full.w, needScale));
    // Sharper pixels are needed (zoomed in), or the level in hand is far
    // bigger than the stage can show (zoomed out): ask for the right one once
    // things are quiet. 1.25× headroom so a small zoom does not re-decode.
    // Asked for the whole FILE — the sharpest any of its layers needs — so
    // two layers of one photo at different scales never fight over it.
    const want = workingWidth(fe.full.w, this.fileNeed(fe));
    const top = pickLevel(fe.levels, want);
    if (top.w < want || top.w > want * 2.5) {
      this.requestLevel(fe, Math.min(fe.full.w, Math.ceil(want * 1.25)));
    }

    const adjust = l.clip.adjust;
    if (adjust === undefined || isIdentityAdjust(adjust)) return level.bmp;
    return this.adjusted(le, level, adjust);
  }

  /** The compressed file this cache already holds for `m` — so an export, a
   *  copy or a Home thumbnail can skip reading it through the asset protocol
   *  again. Null for anything but a loaded file: one still loading has no blob
   *  yet, and a FAILED entry is no answer either — null sends the caller to
   *  read the file itself, so a file restored since the failure is found
   *  instead of being reported missing on the cache's stale say-so. Keyed by
   *  the file (path + size + mtime), like everything here, so another layer of
   *  the same photo gets the same blob. */
  blobFor(m: MediaRef): Blob | null {
    if (this.disposed) return null;
    const fe = this.files.get(keyOf(m));
    return fe !== undefined && fe.state === "ready" ? fe.blob : null;
  }

  /** Forget cached pixels: one layer's (relink, a file that changed) or all.
   *  A file other layers still show keeps its pixels — unless it FAILED: then
   *  every layer lets go of it, so the next render fetches it again. Another
   *  layer's hold would otherwise keep the failed record, and a relink or a
   *  file restored in place (the Recycle Bin keeps its path, size and mtime)
   *  would find it by the same key and join the old failure. */
  invalidate(mediaId?: string): void {
    if (mediaId === undefined) {
      for (const le of this.layers.values()) freeAdjusted(le);
      for (const fe of this.files.values()) this.drop(fe);
      this.layers.clear();
      this.files.clear();
      return;
    }
    const le = this.layers.get(mediaId);
    if (!le) return;
    const fe = le.file;
    if (fe.state !== "failed") {
      this.detach(mediaId, le);
      return;
    }
    for (const id of [...fe.refs]) {
      const other = this.layers.get(id);
      if (other && other.file === fe) this.detach(id, other);
    }
  }

  /** Drop entries whose media is gone from the project. */
  retain(ids: ReadonlySet<string>): void {
    for (const [id, le] of this.layers) {
      if (!ids.has(id)) this.detach(id, le);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.dimsListeners.clear();
  }

  /* ---------------- internals ---------------- */

  private attach(media: MediaRef, needScale: number): LayerEntry {
    const key = keyOf(media);
    let fe = this.files.get(key);
    const fresh = fe === undefined;
    if (!fe) {
      fe = {
        key,
        state: "loading",
        blob: null,
        natural: null,
        full: null,
        exact: null,
        levels: [],
        wantW: 0,
        timer: undefined,
        decoding: 0,
        refs: new Set(),
      };
      this.files.set(key, fe);
    }
    fe.refs.add(media.id);
    const le: LayerEntry = { file: fe, media, adjusted: null, lastNeed: needScale, adjustAt: -Infinity, settle: undefined, proxy: null };
    this.layers.set(media.id, le);
    if (fresh) void this.loadInto(fe, media);
    else if (fe.state === "ready") {
      // A layer joining pixels already decoded may need its size recorded
      // too — not from inside the render pass that asked (the listener edits
      // the project).
      const f = fe;
      queueMicrotask(() => {
        if (this.live(f)) this.reportDims(f);
      });
    }
    return le;
  }

  /** One layer lets go of its file; the file goes when no layer shows it. */
  private detach(mediaId: string, le: LayerEntry): void {
    freeAdjusted(le);
    if (this.layers.get(mediaId) === le) this.layers.delete(mediaId);
    const fe = le.file;
    fe.refs.delete(mediaId);
    if (fe.refs.size === 0) {
      if (this.files.get(fe.key) === fe) this.files.delete(fe.key);
      this.drop(fe);
    }
  }

  /** The sharpest need among the layers showing a file. */
  private fileNeed(fe: FileEntry): number {
    let n = 0;
    for (const id of fe.refs) {
      const le = this.layers.get(id);
      if (le) n = Math.max(n, needOf(le.lastNeed));
    }
    return n > 0 ? n : 1;
  }

  /** Record the decoded size for every layer of this file whose MediaRef has
   *  none — once per MediaRef. */
  private reportDims(fe: FileEntry): void {
    const size = fe.natural;
    if (!size) return;
    for (const id of fe.refs) {
      const le = this.layers.get(id);
      if (!le || this.dimsReported.has(id) || stillFit(size, le.media) !== "unrecorded") continue;
      this.dimsReported.add(id);
      for (const fn of this.dimsListeners) fn(id, size.w, size.h);
    }
  }

  private drop(fe: FileEntry): void {
    clearTimeout(fe.timer);
    fe.timer = undefined;
    for (const lv of fe.levels) lv.bmp.close();
    fe.levels = [];
    fe.blob = null;
    // A decode still in flight sees the entry is no longer the live one and
    // closes what it made.
    fe.key = "";
  }

  private live(fe: FileEntry): boolean {
    return !this.disposed && fe.key !== "" && this.files.get(fe.key) === fe;
  }

  private fail(fe: FileEntry, message: string): void {
    if (!this.live(fe)) return;
    fe.state = "failed";
    fe.message = message;
    this.emit();
  }

  private async loadInto(fe: FileEntry, media: MediaRef): Promise<void> {
    const blob = await fetchPhoto(media.path);
    if (!this.live(fe)) return;
    if (!blob) {
      this.fail(fe, "File not found — relink it");
      return;
    }
    fe.blob = blob;

    // The recorded size is known: decode straight at the level the stage
    // needs when that is smaller than the photo. Drift between the decoder
    // and the recorded size is invisible on this path (a resize forces the
    // size), and so is every later zoom, which re-decodes at a forced size
    // too — only a photo LOADED at about 80% zoom or more takes the full
    // decode below. The E2E orientation alarm is the drift check.
    const rw = media.width;
    const rh = media.height;
    if (validDim(rw) && validDim(rh)) {
      const lw = Math.min(rw, Math.ceil(workingWidth(rw, this.fileNeed(fe)) * 1.25));
      if (lw < rw) {
        const lh = Math.max(1, Math.round((lw * rh) / rw));
        let small: ImageBitmap | null = null;
        try {
          small = await decodeStill(blob, { w: lw, h: lh });
        } catch {
          small = null; // take the full-decode path, with its own retries
        }
        if (small) {
          if (!this.live(fe)) {
            small.close();
            return;
          }
          const fit = fitRenderLimits(rw, rh);
          fe.full = { w: fit.w, h: fit.h };
          fe.natural = { w: rw, h: rh };
          if (fit.reduced) fe.message = `Shown at ${fit.w} × ${fit.h}`;
          fe.levels = [{ w: small.width, h: small.height, bmp: small }];
          this.reportDims(fe);
          fe.state = "ready";
          this.emit();
          return;
        }
        if (!this.live(fe)) return;
      }
    }

    let bmp: ImageBitmap | null = null;
    let reduced = false;
    try {
      bmp = await decodeStill(blob);
    } catch {
      // Over Chromium's canvas limits (or out of memory for a huge one):
      // retry fitted to the limits at the RECORDED size's aspect.
      const w = media.width;
      const h = media.height;
      if (validDim(w) && validDim(h)) {
        const fit = fitRenderLimits(w, h);
        const target = fit.reduced ? fit : { w: Math.ceil(w / 2), h: Math.ceil(h / 2) };
        try {
          bmp = await decodeStill(blob, target);
          reduced = true;
        } catch {
          bmp = null;
        }
      }
      if (!bmp) {
        const tooBig = validDim(w) && validDim(h) && fitRenderLimits(w, h).reduced;
        this.fail(fe, tooBig ? "This image is too large to open here." : "This image couldn't be read.");
        return;
      }
    }
    if (!this.live(fe)) {
      bmp.close();
      return;
    }

    const decoded = { w: bmp.width, h: bmp.height };
    fe.full = decoded;
    fe.natural = reduced && validDim(media.width) && validDim(media.height) ? { w: media.width, h: media.height } : decoded;
    if (!reduced) {
      fe.exact = decoded;
      const fit = stillFit(decoded, media);
      if (import.meta.env.DEV && fit !== "match" && fit !== "unrecorded") {
        console.warn(`[image] still size drift (${fit}): decodes at ${decoded.w} × ${decoded.h}, recorded as ${media.width} × ${media.height}`);
      }
      this.reportDims(fe);
    } else {
      fe.message = `Shown at ${decoded.w} × ${decoded.h}`;
    }

    // Keep the full decode only if the stage actually needs it; otherwise
    // derive the working level from it right away and let it go.
    const want = workingWidth(decoded.w, this.fileNeed(fe));
    if (want < decoded.w / 1.25) {
      const lw = Math.min(decoded.w, Math.ceil(want * 1.25));
      const lh = Math.max(1, Math.round((lw * decoded.h) / decoded.w));
      try {
        const small = await createImageBitmap(bmp, { resizeWidth: lw, resizeHeight: lh, resizeQuality: "high" });
        bmp.close();
        if (!this.live(fe)) {
          small.close();
          return;
        }
        fe.levels = [{ w: small.width, h: small.height, bmp: small }];
      } catch {
        if (!this.live(fe)) {
          bmp.close();
          return;
        }
        fe.levels = [{ w: decoded.w, h: decoded.h, bmp }];
      }
    } else {
      fe.levels = [{ w: decoded.w, h: decoded.h, bmp }];
    }
    fe.state = "ready";
    this.emit();
  }

  private requestLevel(fe: FileEntry, w: number): void {
    if (fe.wantW === w && (fe.timer !== undefined || fe.decoding === w)) return;
    fe.wantW = w;
    clearTimeout(fe.timer);
    fe.timer = setTimeout(() => {
      fe.timer = undefined;
      void this.decodeLevel(fe, w);
    }, LEVEL_DEBOUNCE_MS);
  }

  private async decodeLevel(fe: FileEntry, w: number): Promise<void> {
    if (!this.live(fe) || !fe.blob || !fe.full) return;
    if (fe.levels.some((lv) => lv.w === w)) return;
    const h = Math.max(1, Math.round((w * fe.full.h) / fe.full.w));
    fe.decoding = w;
    let bmp: ImageBitmap;
    try {
      bmp = await decodeStill(fe.blob, { w, h });
    } catch {
      if (fe.decoding === w) fe.decoding = 0;
      return; // keep showing what we have
    }
    if (fe.decoding === w) fe.decoding = 0;
    if (!this.live(fe)) {
      bmp.close();
      return;
    }
    const level: Level = { w: bmp.width, h: bmp.height, bmp };
    // Keep the new level and the closest other one (smooth zoom back), but
    // never a level far bigger than what is wanted — that is the full decode
    // a fitted stage does not need.
    const others = fe.levels
      .filter((lv) => lv.w <= fe.wantW * 2.5)
      .sort((a, b) => Math.abs(Math.log(a.w / fe.wantW)) - Math.abs(Math.log(b.w / fe.wantW)));
    const keep = [level, ...others.slice(0, MAX_LEVELS - 1)];
    for (const lv of fe.levels) if (!keep.includes(lv)) lv.bmp.close();
    fe.levels = keep;
    // An adjusted copy made from a level just closed keeps its own pixels and
    // is still shown until the new level has been adjusted (see adjusted()).
    this.emit();
  }

  private adjusted(le: LayerEntry, level: Level, adjust: ClipAdjust): CanvasImageSource {
    const a = le.adjusted;
    const changed = a === null || a.adjust !== adjust;
    if (!changed && !a.proxy && a.level.bmp === level.bmp) return a.canvas;
    // Mid-drag and nothing new: the proxy stands until the drag goes quiet.
    if (!changed && a.proxy && le.settle !== undefined) return a.canvas;
    if (this.adjustSpent) {
      // One re-adjust per render pass: show the last adjusted pixels (or the
      // plain level) now, and ask for another pass.
      queueMicrotask(() => this.emit());
      return a ? a.canvas : level.bmp;
    }
    this.adjustSpent = true;
    queueMicrotask(() => {
      this.adjustSpent = false;
    });
    // Measured from the END of the previous adjust, not its start: a sharp
    // adjust of a 12-24 MP level takes a few hundred milliseconds itself, so
    // a stamp taken before it would put every next frame of a drag outside
    // the window and the drag would never be seen.
    const dragging = changed && a !== null && performance.now() - le.adjustAt < ADJUST_DRAG_MS;
    if (dragging && level.w * level.h > 2 * this.stageArea) {
      const proxied = this.adjustProxy(le, level, adjust);
      if (proxied) return proxied;
    }

    clearTimeout(le.settle);
    le.settle = undefined;
    freeProxy(le);
    const canvas = a && !a.proxy && a.canvas.width === level.w && a.canvas.height === level.h ? a.canvas : new OffscreenCanvas(level.w, level.h);
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) return level.bmp;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "copy";
    c.drawImage(level.bmp, 0, 0);
    c.globalCompositeOperation = "source-over";
    adjustInStrips(c, level.w, level.h, adjust);
    if (a && a.canvas !== canvas) a.canvas.width = 0;
    le.adjusted = { level, adjust, canvas, proxy: false };
    // The settle's own sharp adjust restarts the window too: a change right
    // after it is the same drag resuming.
    le.adjustAt = performance.now();
    return canvas;
  }

  /** A drag's frame: adjust a proxy of about the stage's pixel count, and
   *  (re)arm the settle that adjusts the sharp level once the drag stops.
   *  Null when no proxy could be made (the caller adjusts the level). */
  private adjustProxy(le: LayerEntry, level: Level, adjust: ClipAdjust): OffscreenCanvas | null {
    const base = this.proxyBase(le, level);
    if (!base) return null;
    const a = le.adjusted;
    const canvas = a && a.proxy && a.canvas.width === base.w && a.canvas.height === base.h ? a.canvas : new OffscreenCanvas(base.w, base.h);
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) return null;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "copy";
    c.drawImage(base.canvas ?? base.of, 0, 0);
    c.globalCompositeOperation = "source-over";
    adjustInStrips(c, base.w, base.h, adjust);
    // The sharp copy goes too: it is stale from the first drag frame on, and
    // on a big photo it is the largest thing this layer holds.
    if (a && a.canvas !== canvas) a.canvas.width = 0;
    le.adjusted = { level, adjust, canvas, proxy: true };
    clearTimeout(le.settle);
    le.settle = setTimeout(() => {
      le.settle = undefined;
      if (!this.disposed && this.layers.get(le.media.id) === le) this.emit();
    }, ADJUST_DRAG_MS);
    le.adjustAt = performance.now();
    return canvas;
  }

  /** What a drag adjusts for `level`: the file's smallest level when that is
   *  near the stage's size already, else a downscale of `level`, made once per
   *  drag (and per level) and kept until the drag ends. "Near" both ways: the
   *  fitted level a zoom-in leaves behind can be a few hundred px wide, and
   *  stretched over a zoomed-in stage it would show the drag as a blur. */
  private proxyBase(le: LayerEntry, level: Level): ProxyBase | null {
    const cap = this.stageArea;
    const small = pickLevel(le.file.levels, 0);
    const smallArea = small.w * small.h;
    if (smallArea <= 2 * cap && smallArea >= cap / 4) {
      freeProxy(le);
      le.proxy = { of: small.bmp, canvas: null, w: small.w, h: small.h };
      return le.proxy;
    }
    const p = le.proxy;
    if (p && p.of === level.bmp && p.canvas) return p;
    freeProxy(le);
    const k = Math.sqrt(cap / (level.w * level.h));
    const w = Math.max(1, Math.round(level.w * k));
    const h = Math.max(1, Math.round(level.h * k));
    const canvas = new OffscreenCanvas(w, h);
    // Drawn once, read on every frame of the drag (copied into the adjusted
    // proxy, itself a CPU canvas): keep it on the CPU side too.
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) {
      canvas.width = 0;
      return null;
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(level.bmp, 0, 0, w, h);
    le.proxy = { of: level.bmp, canvas, w, h };
    return le.proxy;
  }
}

function freeAdjusted(le: LayerEntry): void {
  clearTimeout(le.settle);
  le.settle = undefined;
  freeProxy(le);
  if (le.adjusted) {
    le.adjusted.canvas.width = 0;
    le.adjusted = null;
  }
}

/** Give back a drag proxy's own downscale (a level used as the base is the
 *  file's, not ours to close). */
function freeProxy(le: LayerEntry): void {
  if (le.proxy?.canvas) le.proxy.canvas.width = 0;
  le.proxy = null;
}

/** The smallest level at least `want` wide, else the largest there is. */
function pickLevel(levels: readonly Level[], want: number): Level {
  let best: Level | null = null;
  let largest = levels[0]!;
  for (const lv of levels) {
    if (lv.w > largest.w) largest = lv;
    if (lv.w >= want && (!best || lv.w < best.w)) best = lv;
  }
  return best ?? largest;
}
