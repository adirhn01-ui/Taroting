// What a drawing layer costs in canvas memory: an empty one holds no raster
// and composites nothing, and an export paints a drawing on a scratch the size
// of its strokes, not of the output.
//
// The export cases run through a canvas double that keeps PIXELS (a sparse
// map of coverage per pixel), so a bounded scratch is checked for what it
// produces, not for which calls it made: a stroke is sampled along its centre
// line through the context's own transform and clipped to that context's
// canvas, drawImage copies a source rectangle at globalAlpha (source-over),
// clearRect empties a rectangle. A scratch shifted the wrong way, composited at
// the wrong corner or cut too small shows up as pixels in the wrong place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipTransform, MediaRef, ProjectFile, Stroke } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import type { Layer } from "../layers";

/* ---------------- the pixel double ---------------- */

/** every canvas made, in order */
let canvases: PixCanvas[] = [];
/** the output's pixels as they were handed to the encoder */
let encodedPixels: Map<string, number> | null = null;

type M = [number, number, number, number, number, number];

class PixCtx {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle: unknown = "#000000";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  font = "";
  textAlign = "start";
  textBaseline = "alphabetic";
  m: M = [1, 0, 0, 1, 0, 0];
  draws = 0;
  constructor(readonly canvas: PixCanvas) {}
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.m = [a, b, c, d, e, f];
  }
  getTransform(): DOMMatrix {
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f } as DOMMatrix;
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    expect(this.m).toEqual([1, 0, 0, 1, 0, 0]);
    for (const k of [...this.canvas.pix.keys()]) {
      const [px, py] = k.split(",").map(Number) as [number, number];
      if (px >= x && px < x + w && py >= y && py < y + h) this.canvas.pix.delete(k);
    }
  }
  fillRect(): void {}
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  /** Cover one pixel (clipped to this canvas), source-over. */
  plot(x: number, y: number, v: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return;
    const k = `${px},${py}`;
    const d = this.canvas.pix.get(k) ?? 0;
    this.canvas.pix.set(k, v + d * (1 - v));
  }
  drawImage(src: PixCanvas, ...a: number[]): void {
    this.draws++;
    expect(this.m).toEqual([1, 0, 0, 1, 0, 0]);
    let [sx, sy, sw, sh, dx, dy] = [0, 0, src.width, src.height, 0, 0];
    if (a.length === 2) [dx, dy] = a as [number, number];
    else if (a.length === 8) {
      [sx, sy, sw, sh, dx, dy] = a as [number, number, number, number, number, number];
      expect([a[6], a[7]]).toEqual([sw, sh]); // never scaled
    }
    for (const [k, v] of src.pix) {
      const [px, py] = k.split(",").map(Number) as [number, number];
      if (px < sx || py < sy || px >= sx + sw || py >= sy + sh) continue;
      this.plot(px - sx + dx, py - sy + dy, v * this.globalAlpha);
    }
  }
}

class PixCanvas {
  pix = new Map<string, number>();
  /** the largest size this canvas reached while it lived (a canvas given
   *  back is set to 0 × 0, so the live size has to be watched) */
  peak: { w: number; h: number };
  private w: number;
  private h: number;
  private ctx: PixCtx | null = null;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.peak = { w, h };
    canvases.push(this);
  }
  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = v;
    // resizing a canvas clears it
    this.pix.clear();
    this.peak.w = Math.max(this.peak.w, v);
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = v;
    this.pix.clear();
    this.peak.h = Math.max(this.peak.h, v);
  }
  getContext(): PixCtx {
    this.ctx ??= new PixCtx(this);
    return this.ctx;
  }
  async convertToBlob(opts: { type: string }): Promise<Blob> {
    encodedPixels = new Map(this.pix);
    return new Blob([new Uint8Array(3)], { type: opts.type });
  }
}

/** Centre-line samples per stroke: dense enough that every pixel the line
 *  crosses is hit at these scales. */
const SAMPLES = 400;

/** The points a mocked stroke paints, in its layer's own px. */
function samples(s: Stroke): [number, number][] {
  const sh = s as { a: [number, number]; b: [number, number] };
  const out: [number, number][] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    out.push([sh.a[0] + (sh.b[0] - sh.a[0]) * t, sh.a[1] + (sh.b[1] - sh.a[1]) * t]);
  }
  return out;
}

/* ---------------- mocks at the locked seams ---------------- */

let layers: Layer[] = [];
vi.mock("../layers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layers")>()),
  layersOf: () => layers,
}));
// L = scale about the origin, then translate by (x, y).
vi.mock("../geom", () => ({
  layerToCanvas: (t: ClipTransform) => [t.scale, 0, 0, t.scale, t.x, t.y],
}));
vi.mock("../ink/paint", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ink/paint")>();
  return {
    // the REAL bounds: the box the scratch is cut to must hold what is painted
    strokeBounds: real.strokeBounds,
    createScratch: () => ({ get: () => null, release: () => {} }),
    paintStroke: (ctx: PixCtx, s: Stroke) => {
      const [a, b, c, d, e, f] = ctx.m;
      for (const [u, v] of samples(s)) ctx.plot(a * u + c * v + e, b * u + d * v + f, 1);
    },
  };
});
vi.mock("../../editor/media/generators", () => ({ fontString: () => "normal normal 20px Arial" }));

import { releaseRenderScratch, renderComposite } from "./composite";
import { DrawingRasters } from "./drawings";
import { renderImageExport } from "./export";
import type { RenderResources } from "./index";

/* ---------------- fixtures ---------------- */

function transform(over: Partial<ClipTransform> = {}): ClipTransform {
  return { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1, ...over };
}

function drawing(trackId: string, chunks: Stroke[][], t: ClipTransform, w: number, h: number): Layer {
  const media: MediaRef = {
    id: `m-${trackId}`,
    path: "Drawing",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 0,
    hasAudio: false,
    width: w,
    height: h,
    generator: { type: "drawing", chunks },
  };
  return {
    trackId,
    clipId: `c-${trackId}`,
    mediaId: media.id,
    kind: "drawing",
    name: trackId,
    hidden: false,
    index: 0,
    clip: { id: `c-${trackId}`, mediaId: media.id, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform: t, audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false } },
    media,
    transform: t,
  };
}

function doc(w: number, h: number): ProjectFile {
  return {
    schema: 3,
    kind: "image",
    app: "taroting",
    id: "p",
    name: "p",
    createdAt: "",
    modifiedAt: "",
    media: [],
    timeline: { fps: { num: 30, den: 1 }, width: w, height: h, tracks: [] },
    export: DEFAULT_EXPORT_PRESET,
    image: { background: "transparent" },
  };
}

const line = (a: [number, number], b: [number, number], w = 4): Stroke => ({ t: "line", c: "#123456", w, a, b });
const erase = (): Stroke => ({ t: "erase", w: 30, p: "AAAAAAAAAAAAAAAA" });
const never = (): AbortSignal => new AbortController().signal;
const pixelsOf = (pts: [number, number][]): Set<string> => new Set(pts.map(([x, y]) => `${Math.floor(x)},${Math.floor(y)}`));

beforeEach(() => {
  canvases = [];
  encodedPixels = null;
  layers = [];
  vi.stubGlobal("OffscreenCanvas", PixCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- export: a scratch the size of the strokes ---------------- */

describe("export of a drawing layer", () => {
  it("a small doodle on an 8000 × 6000 export gets a doodle-sized scratch, not an output-sized one", async () => {
    // Line (5000,1000)→(5040,1030), width 4: bounds 4998..5042 × 998..1032,
    // plus one pixel of margin each way → 4997..5043 × 997..1033 = 46 × 36.
    const doodle = line([5000, 1000], [5040, 1030]);
    layers = [drawing("d", [[doodle]], transform(), 8000, 6000)];
    await renderImageExport(doc(8000, 6000), { format: "png", quality: 100, outW: 8000, outH: 6000 }, never(), () => {});
    expect(canvases).toHaveLength(2); // the output and ONE drawing scratch
    expect(canvases[0]!.peak).toEqual({ w: 8000, h: 6000 });
    expect(canvases[1]!.peak).toEqual({ w: 46, h: 36 });
    // given back before the encode, like before
    expect(canvases[1]!.width).toBe(0);
    // and what reached the file is exactly the line
    expect(new Set(encodedPixels!.keys())).toEqual(pixelsOf(samples(doodle)));
  });

  it("an off-centre stroke at 60% opacity lands exactly where an output-sized scratch puts it, cut at the output's edge", async () => {
    // Every axis differs: output 500×290 of a 641×361 canvas (zoomX ≠ zoomY),
    // a layer at half scale moved by (−37, 23), one stroke well inside and one
    // running off the right edge of the output.
    const t = transform({ scale: 0.5, x: -37, y: 23, opacity: 0.6 });
    const inside = line([300, 120], [520, 260], 6);
    const offEdge = line([900, 400], [1700, 90], 3);
    layers = [drawing("d", [[inside], [offEdge]], t, 1282, 722)];
    const outW = 500;
    const outH = 290;
    await renderImageExport(doc(641, 361), { format: "png", quality: 100, outW, outH }, never(), () => {});

    // Where V · L puts every sample, worked out here independently.
    const zx = outW / 641;
    const zy = outH / 361;
    const device = ([u, v]: [number, number]): [number, number] => [zx * (0.5 * u - 37), zy * (0.5 * v + 23)];
    const want = new Set(
      [...pixelsOf([...samples(inside), ...samples(offEdge)].map(device))].filter((k) => {
        const [x, y] = k.split(",").map(Number) as [number, number];
        return x >= 0 && y >= 0 && x < outW && y < outH;
      }),
    );
    expect(want.size).toBeGreaterThan(100);
    // the edge stroke really does leave the output, so the cut is exercised
    expect(device([1700, 90])[0]).toBeGreaterThan(outW);
    expect(new Set(encodedPixels!.keys())).toEqual(want);
    for (const v of encodedPixels!.values()) expect(v).toBeCloseTo(0.6, 9); // group opacity, once
    // and the scratch covered only the strokes' reach, not the output
    const peak = canvases[1]!.peak;
    expect(peak.w * peak.h).toBeLessThan(outW * outH);
  });

  it("makes no scratch at all for a drawing with no ink, only erases, or ink wholly off the output", async () => {
    layers = [
      drawing("empty", [], transform(), 641, 361),
      drawing("erased", [[erase()]], transform(), 641, 361),
      drawing("off", [[line([900, 50], [950, 80])]], transform(), 641, 361),
    ];
    await renderImageExport(doc(641, 361), { format: "png", quality: 100, outW: 641, outH: 361 }, never(), () => {});
    expect(canvases).toHaveLength(1); // the output alone
    expect(encodedPixels!.size).toBe(0);
  });
});

/* ---------------- preview: nothing held, nothing composited ---------------- */

describe("an empty drawing layer in the preview", () => {
  const view = { zoom: 1, panX: 0, panY: 0 };

  it("holds no raster: one erased clean gives its canvas back, and a new one never makes one", () => {
    const rasters = new DrawingRasters(() => {});
    rasters.setStage(300, 200);
    const d = doc(300, 200);
    const t = transform();
    const drawn = rasters.raster(d, drawing("d", [[line([10, 10], [60, 40])]], t, 300, 200), view) as PixCanvas | null;
    expect(drawn).toBeInstanceOf(PixCanvas);
    expect(drawn!.width).toBe(300);

    for (const chunks of [[], [[]]] as Stroke[][][]) {
      expect(rasters.raster(d, drawing("d", chunks, t, 300, 200), view)).toBeNull();
    }
    expect([drawn!.width, drawn!.height]).toEqual([0, 0]);

    const before = canvases.length;
    expect(rasters.raster(d, drawing("fresh", [], t, 300, 200), view)).toBeNull();
    expect(canvases.length).toBe(before);
    rasters.dispose();
  });

  it("composites nothing: no layer scratch is made or cleared, nothing is drawn on the stage", () => {
    releaseRenderScratch();
    layers = [drawing("d", [[]], transform(), 300, 200)];
    const stage = new PixCanvas(300, 200);
    const ctx = stage.getContext();
    let asked = 0;
    const res: RenderResources = { photo: () => null, drawingRaster: () => (asked++, null) };
    canvases = [];
    renderComposite(ctx as unknown as CanvasRenderingContext2D, doc(300, 200), res, view, { underlay: "none" });
    // the raster was still asked for (that is how one erased clean is freed)…
    expect(asked).toBe(1);
    // …but no scratch exists and the stage took no drawImage
    expect(canvases).toEqual([]);
    expect(ctx.draws).toBe(0);

    // control: a live mark on that same empty layer does use the scratch
    const live = { trackId: "d", above: null, paint: (c: unknown) => (c as PixCtx).plot(5, 5, 1) };
    renderComposite(ctx as unknown as CanvasRenderingContext2D, doc(300, 200), res, view, { underlay: "none", live });
    expect(canvases).toHaveLength(1);
    expect(ctx.draws).toBe(1);
    expect(stage.pix.get("5,5")).toBe(1);
    releaseRenderScratch();
  });
});
