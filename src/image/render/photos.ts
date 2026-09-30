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
}

interface Entry {
  key: string;
  mediaId: string;
  state: "loading" | "ready" | "failed";
  message?: string;
  blob: Blob | null;
  /** size of the photo as decoded (the status report) */
  natural: { w: number; h: number } | null;
  /** largest level this photo can be decoded at (natural, or fitted to the
   *  canvas limits for a photo bigger than they allow) */
  full: { w: number; h: number } | null;
  levels: Level[];
  wantW: number;
  timer: number | undefined;
  decoding: number;
  adjusted: Adjusted | null;
  /** the scale most recently asked for, before the load finished */
  lastNeed: number;
}

function keyOf(m: MediaRef): string {
  return `${m.path}|${m.size}|${m.mtimeMs}`;
}

/**
 * The photo half of `PreviewResources`. Knows nothing about drawings, the
 * stage or the DOM; `emit` is how it says "pixels changed, render again".
 */
export class PhotoCache {
  private readonly entries = new Map<string, Entry>();
  private readonly dimsListeners = new Set<(mediaId: string, w: number, h: number) => void>();
  private readonly dimsReported = new Set<string>();
  private disposed = false;
  /** at most one re-adjust per synchronous render pass */
  private adjustSpent = false;

  constructor(private readonly emit: () => void) {}

  onMediaDims(fn: (mediaId: string, w: number, h: number) => void): () => void {
    this.dimsListeners.add(fn);
    return () => this.dimsListeners.delete(fn);
  }

  status(media: MediaRef | undefined): {
    state: "loading" | "ready" | "failed";
    message?: string;
    natural?: { w: number; h: number };
  } {
    if (!media) return { state: "failed", message: "Layer not found" };
    const e = this.entries.get(media.id);
    if (!e || e.key !== keyOf(media)) return { state: "loading" };
    const out: { state: "loading" | "ready" | "failed"; message?: string; natural?: { w: number; h: number } } = {
      state: e.state,
    };
    if (e.message !== undefined) out.message = e.message;
    if (e.natural) out.natural = { ...e.natural };
    return out;
  }

  photo(l: Layer, needScale: number): CanvasImageSource | null {
    if (this.disposed || l.media.generator) return null;
    let e = this.entries.get(l.media.id);
    if (!e || e.key !== keyOf(l.media)) {
      if (e) this.drop(e);
      e = this.load(l.media, needScale);
    }
    e.lastNeed = needScale;
    if (e.state !== "ready" || !e.full || e.levels.length === 0) return null;

    const want = workingWidth(e.full.w, needScale);
    const level = pickLevel(e.levels, want);
    // Sharper pixels are needed (zoomed in), or the level in hand is far
    // bigger than the stage can show (zoomed out): ask for the right one once
    // things are quiet. 1.25× headroom so a small zoom does not re-decode.
    if (level.w < want || level.w > want * 2.5) {
      this.requestLevel(e, Math.min(e.full.w, Math.ceil(want * 1.25)));
    }

    const adjust = l.clip.adjust;
    if (adjust === undefined || isIdentityAdjust(adjust)) return level.bmp;
    return this.adjusted(e, level, adjust);
  }

  /** Forget cached pixels: one photo's (relink, a file that changed) or all. */
  invalidate(mediaId?: string): void {
    if (mediaId === undefined) {
      for (const e of this.entries.values()) this.drop(e);
      this.entries.clear();
      return;
    }
    const e = this.entries.get(mediaId);
    if (e) {
      this.drop(e);
      this.entries.delete(mediaId);
    }
  }

  /** Drop entries whose media is gone from the project. */
  retain(ids: ReadonlySet<string>): void {
    for (const [id, e] of this.entries) {
      if (!ids.has(id)) {
        this.drop(e);
        this.entries.delete(id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.dimsListeners.clear();
  }

  /* ---------------- internals ---------------- */

  private drop(e: Entry): void {
    clearTimeout(e.timer);
    e.timer = undefined;
    for (const lv of e.levels) lv.bmp.close();
    e.levels = [];
    if (e.adjusted) {
      e.adjusted.canvas.width = 0;
      e.adjusted = null;
    }
    e.blob = null;
    // A decode still in flight sees the entry is no longer the live one and
    // closes what it made.
    e.key = "";
  }

  private live(e: Entry): boolean {
    return !this.disposed && e.key !== "" && this.entries.get(e.mediaId) === e;
  }

  private load(media: MediaRef, needScale: number): Entry {
    const e: Entry = {
      key: keyOf(media),
      mediaId: media.id,
      state: "loading",
      blob: null,
      natural: null,
      full: null,
      levels: [],
      wantW: 0,
      timer: undefined,
      decoding: 0,
      adjusted: null,
      lastNeed: needScale,
    };
    this.entries.set(media.id, e);
    void this.loadInto(e, media);
    return e;
  }

  private fail(e: Entry, message: string): void {
    if (!this.live(e)) return;
    e.state = "failed";
    e.message = message;
    this.emit();
  }

  private async loadInto(e: Entry, media: MediaRef): Promise<void> {
    const blob = await fetchPhoto(media.path);
    if (!this.live(e)) return;
    if (!blob) {
      this.fail(e, "File not found — relink it");
      return;
    }
    e.blob = blob;

    // The recorded size is known: decode straight at the level the stage
    // needs when that is smaller than the photo. Drift between the decoder
    // and the recorded size is invisible on this path (a resize forces the
    // size), and so is every later zoom, which re-decodes at a forced size
    // too — only a photo LOADED at about 80% zoom or more takes the full
    // decode below. The E2E orientation alarm is the drift check.
    const rw = media.width;
    const rh = media.height;
    if (validDim(rw) && validDim(rh)) {
      const lw = Math.min(rw, Math.ceil(workingWidth(rw, e.lastNeed) * 1.25));
      if (lw < rw) {
        const lh = Math.max(1, Math.round((lw * rh) / rw));
        let small: ImageBitmap | null = null;
        try {
          small = await decodeStill(blob, { w: lw, h: lh });
        } catch {
          small = null; // take the full-decode path, with its own retries
        }
        if (small) {
          if (!this.live(e)) {
            small.close();
            return;
          }
          const fit = fitRenderLimits(rw, rh);
          e.full = { w: fit.w, h: fit.h };
          e.natural = { w: rw, h: rh };
          if (fit.reduced) e.message = `Shown at ${fit.w} × ${fit.h}`;
          e.levels = [{ w: small.width, h: small.height, bmp: small }];
          e.state = "ready";
          this.emit();
          return;
        }
        if (!this.live(e)) return;
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
        this.fail(e, tooBig ? "This image is too large to open here." : "This image couldn't be read.");
        return;
      }
    }
    if (!this.live(e)) {
      bmp.close();
      return;
    }

    const decoded = { w: bmp.width, h: bmp.height };
    e.full = decoded;
    e.natural = reduced && validDim(media.width) && validDim(media.height) ? { w: media.width, h: media.height } : decoded;
    if (!reduced) {
      const fit = stillFit(decoded, media);
      if (fit === "unrecorded") {
        if (!this.dimsReported.has(media.id)) {
          this.dimsReported.add(media.id);
          for (const fn of this.dimsListeners) fn(media.id, decoded.w, decoded.h);
        }
      } else if (fit !== "match") {
        // Drawn into the recorded box regardless (composite.ts); say so, so a
        // runtime that changed its mind about orientation is visible.
        e.message = `Decodes at ${decoded.w} × ${decoded.h}, recorded as ${media.width} × ${media.height}`;
        if (import.meta.env.DEV) console.warn(`[image] still size drift (${fit}): ${e.message}`);
      }
    } else {
      e.message = `Shown at ${decoded.w} × ${decoded.h}`;
    }

    // Keep the full decode only if the stage actually needs it; otherwise
    // derive the working level from it right away and let it go.
    const want = workingWidth(decoded.w, e.lastNeed);
    if (want < decoded.w / 1.25) {
      const lw = Math.min(decoded.w, Math.ceil(want * 1.25));
      const lh = Math.max(1, Math.round((lw * decoded.h) / decoded.w));
      try {
        const small = await createImageBitmap(bmp, { resizeWidth: lw, resizeHeight: lh, resizeQuality: "high" });
        bmp.close();
        if (!this.live(e)) {
          small.close();
          return;
        }
        e.levels = [{ w: small.width, h: small.height, bmp: small }];
      } catch {
        if (!this.live(e)) {
          bmp.close();
          return;
        }
        e.levels = [{ w: decoded.w, h: decoded.h, bmp }];
      }
    } else {
      e.levels = [{ w: decoded.w, h: decoded.h, bmp }];
    }
    e.state = "ready";
    this.emit();
  }

  private requestLevel(e: Entry, w: number): void {
    if (e.wantW === w && (e.timer !== undefined || e.decoding === w)) return;
    e.wantW = w;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = undefined;
      void this.decodeLevel(e, w);
    }, LEVEL_DEBOUNCE_MS);
  }

  private async decodeLevel(e: Entry, w: number): Promise<void> {
    if (!this.live(e) || !e.blob || !e.full) return;
    if (e.levels.some((lv) => lv.w === w)) return;
    const h = Math.max(1, Math.round((w * e.full.h) / e.full.w));
    e.decoding = w;
    let bmp: ImageBitmap;
    try {
      bmp = await decodeStill(e.blob, { w, h });
    } catch {
      if (e.decoding === w) e.decoding = 0;
      return; // keep showing what we have
    }
    if (e.decoding === w) e.decoding = 0;
    if (!this.live(e)) {
      bmp.close();
      return;
    }
    const level: Level = { w: bmp.width, h: bmp.height, bmp };
    // Keep the new level and the closest other one (smooth zoom back), but
    // never a level far bigger than what is wanted — that is the full decode
    // a fitted stage does not need.
    const others = e.levels
      .filter((lv) => lv.w <= e.wantW * 2.5)
      .sort((a, b) => Math.abs(Math.log(a.w / e.wantW)) - Math.abs(Math.log(b.w / e.wantW)));
    const keep = [level, ...others.slice(0, MAX_LEVELS - 1)];
    for (const lv of e.levels) if (!keep.includes(lv)) lv.bmp.close();
    e.levels = keep;
    // An adjusted copy made from a level just closed keeps its own pixels and
    // is still shown until the new level has been adjusted (see adjusted()).
    this.emit();
  }

  private adjusted(e: Entry, level: Level, adjust: ClipAdjust): CanvasImageSource {
    const a = e.adjusted;
    if (a && a.level.bmp === level.bmp && a.adjust === adjust) return a.canvas;
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
    const canvas = a && a.canvas.width === level.w && a.canvas.height === level.h ? a.canvas : new OffscreenCanvas(level.w, level.h);
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) return level.bmp;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "copy";
    c.drawImage(level.bmp, 0, 0);
    c.globalCompositeOperation = "source-over";
    adjustInStrips(c, level.w, level.h, adjust);
    if (a && a.canvas !== canvas) a.canvas.width = 0;
    e.adjusted = { level, adjust, canvas };
    return canvas;
  }
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
