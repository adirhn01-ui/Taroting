// The compositor and the export engine, driven through a call-recording
// Canvas2D double (vitest runs in node: there is no canvas). The layer model,
// the geometry, the stroke painter and the adjust maths belong to other
// modules and are mocked at their locked signatures.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipTransform, MediaRef, ProjectFile, Stroke } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import type { Layer } from "../layers";

/* ---------------- the recording double ---------------- */

let log: string[] = [];
let ctxSeq = 0;

class RecCtx {
  readonly name: string;
  private alpha = 1;
  private fill: unknown = "#000000";
  globalCompositeOperation = "source-over";
  font = "";
  textAlign = "start";
  textBaseline = "alphabetic";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  constructor(readonly canvas: FakeCanvas) {
    this.name = canvas.name;
  }
  private rec(s: string): void {
    log.push(`${this.name}|${s}`);
  }
  get globalAlpha(): number {
    return this.alpha;
  }
  set globalAlpha(v: number) {
    this.alpha = v;
    this.rec(`alpha=${v}`);
  }
  get fillStyle(): unknown {
    return this.fill;
  }
  set fillStyle(v: unknown) {
    this.fill = v;
    this.rec(`fillStyle=${typeof v === "string" ? v : "pattern"}`);
  }
  setTransform(...a: number[]): void {
    this.rec(`T(${a.map((n) => +n.toFixed(6)).join(",")})`);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec(`fillRect(${[x, y, w, h].map((n) => +n.toFixed(6)).join(",")})`);
  }
  clearRect(): void {
    this.rec("clear");
  }
  drawImage(src: { name?: string }): void {
    this.rec(`draw:${src?.name ?? "?"}`);
  }
  fillText(t: string, x: number, y: number): void {
    this.rec(`text:${t}@${x},${y}`);
  }
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {
    this.rec("clip");
  }
  createPattern(): object {
    return {};
  }
  getImageData(_x: number, y: number, w: number, rows: number): { data: Uint8ClampedArray } {
    this.rec(`get(${y},${rows})`);
    return { data: new Uint8ClampedArray(w * rows * 4) };
  }
  putImageData(): void {
    this.rec("put");
  }
}

let forceBlobType: string | null = null;
const encoded: unknown[] = [];

class FakeCanvas {
  readonly name: string;
  private ctx: RecCtx | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.name = `c${ctxSeq++}`;
  }
  getContext(): RecCtx {
    this.ctx ??= new RecCtx(this);
    return this.ctx;
  }
  async convertToBlob(opts: { type: string; quality?: number }): Promise<Blob> {
    encoded.push(opts);
    log.push(`${this.name}|encode`);
    return new Blob([new Uint8Array(3)], { type: forceBlobType ?? opts.type });
  }
}

class FakeBitmap {
  readonly name: string;
  closed = false;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.name = `bmp${width}x${height}`;
  }
  close(): void {
    this.closed = true;
    log.push(`${this.name}|close`);
  }
}

/* ---------------- mocks at the locked seams ---------------- */

let layers: Layer[] = [];

vi.mock("../layers", () => ({ layersOf: () => layers }));
// L = scale about the origin, then translate by (x, y): enough to see which
// transform a layer was drawn with.
vi.mock("../geom", () => ({
  layerToCanvas: (t: ClipTransform) => [t.scale, 0, 0, t.scale, t.x, t.y],
}));
/** which pencil scratch each stroke was painted with, in order */
const strokeScratches: string[] = [];
let scratchSeq = 0;
vi.mock("../ink/paint", () => ({
  createScratch: () => {
    const id = `ink${scratchSeq++}`;
    return { id, get: () => null, release: () => log.push(`${id}|release`) };
  },
  paintStroke: (ctx: RecCtx, s: Stroke, scratch: { id: string }) => {
    strokeScratches.push(scratch.id);
    log.push(`${ctx.name}|stroke:${(s as { c?: string }).c ?? "erase"}`);
  },
  strokeBounds: () => ({ x: 0, y: 0, w: 1, h: 1 }),
}));
vi.mock("../../editor/media/generators", () => ({ fontString: () => "normal normal 20px Arial" }));
vi.mock("../adjust/plan", () => ({
  buildAdjustPlan: () => ({}),
  applyAdjustPlan: () => {},
  isIdentityAdjust: (a: unknown) => a === undefined,
}));

import { RENDER_MAX_AREA, RENDER_MAX_SIDE } from "../../core/types";
import { fillChecker } from "./checker";
import { layerBox, renderComposite } from "./composite";
import type { LiveInk, RenderResources } from "./index";
import { encodeQuality, maxRenderSize, outputSize, renderImageExport, renderThumbnail, thumbnailSize } from "./export";

/* ---------------- fixtures ---------------- */

function transform(over: Partial<ClipTransform> = {}): ClipTransform {
  return { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1, ...over };
}

function mediaRef(id: string, over: Partial<MediaRef> = {}): MediaRef {
  return { id, path: `${id}.png`, size: 1, mtimeMs: 1, kind: "image", duration: 0, hasAudio: false, width: 40, height: 30, ...over };
}

function layer(trackId: string, media: MediaRef, over: Partial<Layer> = {}): Layer {
  const t = over.transform ?? transform();
  const kind = media.generator ? (media.generator.type as Layer["kind"]) : "photo";
  return {
    trackId,
    clipId: `c-${trackId}`,
    mediaId: media.id,
    kind,
    name: trackId,
    hidden: false,
    index: 0,
    clip: { id: `c-${trackId}`, mediaId: media.id, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform: t, audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false } },
    media,
    transform: t,
    ...over,
  };
}

function solid(trackId: string, color: string, over: Partial<Layer> = {}): Layer {
  return layer(trackId, mediaRef(`m-${trackId}`, { generator: { type: "solid", color } }), over);
}

function drawing(trackId: string, chunks: Stroke[][], over: Partial<Layer> = {}): Layer {
  return layer(trackId, mediaRef(`m-${trackId}`, { generator: { type: "drawing", chunks } }), over);
}

function doc(background = "transparent", w = 641, h = 361): ProjectFile {
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
    image: { background },
  };
}

const noRes: RenderResources = { photo: () => null, drawingRaster: () => null };
const ink = (c: string): Stroke => ({ t: "pen", c, w: 3, o: 1, p: "AAAAAAAAAAAAAAAA" });

function mainLog(name: string): string[] {
  return log.filter((l) => l.startsWith(`${name}|`)).map((l) => l.slice(name.length + 1));
}

beforeEach(() => {
  log = [];
  strokeScratches.length = 0;
  layers = [];
  forceBlobType = null;
  encoded.length = 0;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- renderComposite ---------------- */

describe("renderComposite", () => {
  it("draws bottom → top and skips hidden layers, skipped layers and opacity 0", () => {
    layers = [
      solid("top", "#aa0001"),
      solid("hid", "#bb0002", { hidden: true }),
      solid("zero", "#cc0003", { transform: transform({ opacity: 0 }) }),
      solid("skipme", "#ee0005"),
      solid("bottom", "#dd0004"),
    ];
    const target = new FakeCanvas(300, 200);
    renderComposite(target.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, {
      underlay: "none",
      skip: new Set(["skipme"]),
    });
    const fills = mainLog(target.name).filter((l) => l.startsWith("fillStyle="));
    expect(fills).toEqual(["fillStyle=#dd0004", "fillStyle=#aa0001"]);
  });

  it("re-validates a solid's colour: an invalid one paints nothing", () => {
    layers = [solid("bad", "red; background: url(x)"), solid("ok", "#ABCDEF")];
    const target = new FakeCanvas(10, 10);
    renderComposite(target.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, { underlay: "none" });
    const fills = mainLog(target.name).filter((l) => l.startsWith("fillStyle="));
    expect(fills).toEqual(["fillStyle=#abcdef"]);
  });

  it("paints live ink INSIDE its target layer, at that layer's z", () => {
    const d = drawing("draw", [[ink("#010101")]]);
    layers = [solid("top", "#aa0001"), d, solid("bottom", "#dd0004")];
    const target = new FakeCanvas(64, 48);
    const painted: string[] = [];
    const live: LiveInk = {
      trackId: "draw",
      above: null,
      paint: (c) => painted.push((c as unknown as RecCtx).name),
    };
    renderComposite(target.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, { underlay: "none", live });
    const main = mainLog(target.name);
    const iBottom = main.indexOf("fillStyle=#dd0004");
    const iLayer = main.findIndex((l) => l.startsWith("draw:"));
    const iTop = main.indexOf("fillStyle=#aa0001");
    expect(iBottom).toBeGreaterThanOrEqual(0);
    expect(iLayer).toBeGreaterThan(iBottom);
    expect(iTop).toBeGreaterThan(iLayer);
    // on the layer's own scratch, never straight onto the composite
    expect(painted).toHaveLength(1);
    expect(painted[0]).not.toBe(target.name);
    expect(main.some((l) => l.startsWith("stroke:"))).toBe(false);
  });

  it("paints a mark for a layer not created yet directly above `above`", () => {
    layers = [solid("top", "#aa0001"), solid("bottom", "#dd0004")];
    const target = new FakeCanvas(64, 48);
    let at = -1;
    const live: LiveInk = { trackId: null, above: "bottom", paint: () => (at = log.length) };
    renderComposite(target.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, { underlay: "none", live });
    const iBottom = log.indexOf(`${target.name}|fillStyle=#dd0004`);
    const iTop = log.indexOf(`${target.name}|fillStyle=#aa0001`);
    expect(at).toBeGreaterThan(iBottom);
    expect(at).toBeLessThan(iTop);
  });

  it("gives a drawing layer GROUP opacity: one globalAlpha for the composite, none per stroke", () => {
    layers = [drawing("d", [[ink("#010101"), ink("#020202")], [ink("#030303")]], { transform: transform({ opacity: 0.35 }) })];
    const target = new FakeCanvas(64, 48);
    renderComposite(target.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, { underlay: "none" });
    const main = mainLog(target.name);
    expect(main.filter((l) => l === "alpha=0.35")).toHaveLength(1);
    const strokes = log.filter((l) => l.includes("|stroke:"));
    expect(strokes.map((l) => l.split("|stroke:")[1])).toEqual(["#010101", "#020202", "#030303"]);
    expect(strokes.every((l) => !l.startsWith(`${target.name}|`))).toBe(true);
    expect(log.some((l) => !l.startsWith(`${target.name}|`) && l.endsWith("alpha=0.35"))).toBe(false);
  });

  it("draws a photo INTO the recorded MediaRef box, whatever size its pixels are", () => {
    const bmp = new FakeBitmap(17, 9);
    layers = [layer("ph", mediaRef("m-ph", { width: 36, height: 64 }), { transform: transform({ scale: 0.5, x: 3, y: -2 }) })];
    const drawn: unknown[][] = [];
    const target = new FakeCanvas(64, 64);
    const ctx = target.getContext();
    ctx.drawImage = (...a: unknown[]): void => void drawn.push(a);
    let asked = 0;
    renderComposite(ctx as unknown as CanvasRenderingContext2D, doc(), { photo: (_l, s) => ((asked = s), bmp as unknown as ImageBitmap), drawingRaster: () => null }, { zoom: 2, panX: 5, panY: 7 }, { underlay: "none" });
    expect(drawn).toEqual([[bmp, 0, 0, 36, 64]]);
    // density asked for = layer scale × zoom
    expect(asked).toBe(1);
    // M = V · L: zoom 2 about pan (5, 7) over scale 0.5 + (3, -2)
    expect(mainLog(target.name)).toContain("T(1,0,0,1,11,3)");
  });
});

describe("layerBox", () => {
  it("hands back the same recorded box every frame (no per-frame allocation)", () => {
    const l = layer("ph", mediaRef("m-ph", { width: 36, height: 64 }));
    const box = layerBox(l);
    expect(box).toEqual({ w: 36, h: 64 });
    expect(layerBox(l)).toBe(box);
    // a different recorded size is a different box
    expect(layerBox(layer("ph", mediaRef("m-ph", { width: 64, height: 36 })))).toEqual({ w: 64, h: 36 });
  });
});

describe("checker", () => {
  it("anchors the squares on whole device px but still fills exactly the image", () => {
    const target = new FakeCanvas(64, 64);
    fillChecker(target.getContext() as unknown as CanvasRenderingContext2D, 10.4, 5.6, 30, 20);
    const main = mainLog(target.name);
    expect(main).toContain("T(1,0,0,1,10,6)");
    // (10.4, 5.6) in device px, relative to the rounded anchor
    expect(main).toContain("fillRect(0.4,-0.4,30,20)");
  });
});

/* ---------------- export ---------------- */

describe("export sizing", () => {
  it("maxRenderSize fits Chromium's limits at the canvas aspect", () => {
    expect(maxRenderSize(40000, 1000)).toEqual({ w: 32767, h: 819, reduced: true });
    const big = maxRenderSize(20000, 15000);
    expect(big.reduced).toBe(true);
    expect(big.w * big.h).toBeLessThanOrEqual(268_435_456);
    expect(Math.abs(big.h - (big.w * 15000) / 20000)).toBeLessThanOrEqual(1);
    expect(maxRenderSize(641, 361)).toEqual({ w: 641, h: 361, reduced: false });
  });

  it("outputSize: 50% → 321×181, 25% → 160×90, custom kept whole", () => {
    expect(outputSize(50, 641, 361)).toEqual({ w: 321, h: 181 });
    expect(outputSize(25, 641, 361)).toEqual({ w: 160, h: 90 });
    expect(outputSize(25, 1, 1)).toEqual({ w: 1, h: 1 });
    expect(outputSize({ w: 2000.4, h: 999.6 }, 641, 361)).toEqual({ w: 2000, h: 1000 });
  });

  it("thumbnail: longest side 320, never upscaled", () => {
    expect(thumbnailSize(641, 361)).toEqual({ w: 320, h: 180 });
    expect(thumbnailSize(361, 641)).toEqual({ w: 180, h: 320 });
    expect(thumbnailSize(97, 61)).toEqual({ w: 97, h: 61 });
  });

  it("encode quality: PNG none, JPEG q/100, WebP 100 → exactly 1 (lossless)", () => {
    expect(encodeQuality("png", 40)).toBeUndefined();
    expect(encodeQuality("jpeg", 85)).toBe(0.85);
    expect(encodeQuality("webp", 100)).toBe(1);
    expect(encodeQuality("webp", 99)).toBe(0.99);
  });
});

describe("renderImageExport", () => {
  const never = (): AbortSignal => new AbortController().signal;

  it("draws bottom → top: the lower layer's fill lands first", async () => {
    // layersOf lists top-first; export must reverse it, as the preview does
    layers = [solid("top", "#aa0001"), solid("bottom", "#dd0004")];
    await renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {});
    const fills = log.filter((l) => l.includes("|fillStyle=")).map((l) => l.split("|")[1]);
    expect(fills).toEqual(["fillStyle=#dd0004", "fillStyle=#aa0001"]);
  });

  it("exports a layer with a non-finite opacity at full opacity, as the preview shows it", async () => {
    layers = [solid("n", "#0f0e0d", { transform: transform({ opacity: Number.NaN }) })];
    await renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {});
    const out = log.filter((l) => l.includes("|fillStyle=") || l.includes("|alpha="));
    expect(out.map((l) => l.split("|")[1])).toEqual(["alpha=1", "alpha=1", "fillStyle=#0f0e0d"]);
  });

  it("paints drawings with its OWN pencil scratch and releases it once the run ends", async () => {
    // The preview's shared pencil scratch exists first…
    layers = [drawing("d", [[ink("#010101")]])];
    const stage = new FakeCanvas(300, 200);
    renderComposite(stage.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, { underlay: "none" });
    const preview = strokeScratches[0]!;
    strokeScratches.length = 0;

    layers = [drawing("d", [[ink("#010101")], [ink("#020202")]]), drawing("e", [[ink("#030303")]])];
    await renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {});
    // …and export never paints with it: one scratch of its own for the run
    expect(strokeScratches).toHaveLength(3);
    expect(new Set(strokeScratches).size).toBe(1);
    expect(strokeScratches[0]).not.toBe(preview);
    const releases = log.filter((l) => l.endsWith("|release"));
    expect(releases).toEqual([`${strokeScratches[0]}|release`]);
    // given back BEFORE the encoder needs its own buffer
    expect(log.indexOf(releases[0]!)).toBeLessThan(log.findIndex((l) => l.endsWith("|encode")));
  });

  it("flattens a transparent JPEG onto white FIRST, then the layers", async () => {
    layers = [solid("s", "#123456")];
    await renderImageExport(doc(), { format: "jpeg", quality: 85, outW: 641, outH: 361 }, never(), () => {});
    const out = log.filter((l) => l.startsWith("c")).map((l) => l.split("|")[1]!);
    const fills = out.filter((l) => l.startsWith("fillStyle="));
    expect(fills[0]).toBe("fillStyle=#ffffff");
    expect(fills[1]).toBe("fillStyle=#123456");
    expect(encoded).toEqual([{ type: "image/jpeg", quality: 0.85 }]);
  });

  it("adds no white under a PNG, nor under a JPEG with a black background", async () => {
    layers = [];
    await renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {});
    await renderImageExport(doc("#000000"), { format: "jpeg", quality: 50, outW: 64, outH: 36 }, never(), () => {});
    expect(log.some((l) => l.endsWith("fillStyle=#ffffff"))).toBe(false);
    expect(log.some((l) => l.endsWith("fillStyle=#000000"))).toBe(true);
    expect(encoded[0]).toEqual({ type: "image/png" });
  });

  it("scales each axis on its own: 25% of 641×361 fills exactly 160×90", async () => {
    layers = [];
    await renderImageExport(doc("#0a0b0c"), { format: "png", quality: 100, outW: 160, outH: 90 }, never(), () => {});
    expect(log.some((l) => l.endsWith("fillRect(0,0,160,90)"))).toBe(true);
  });

  it("WebP at 100 encodes with quality exactly 1", async () => {
    layers = [];
    await renderImageExport(doc(), { format: "webp", quality: 100, outW: 64, outH: 36 }, never(), () => {});
    expect(encoded).toEqual([{ type: "image/webp", quality: 1 }]);
  });

  it("refuses a blob of the wrong type (an engine that fell back to PNG)", async () => {
    layers = [];
    forceBlobType = "image/png";
    await expect(renderImageExport(doc(), { format: "webp", quality: 80, outW: 64, outH: 36 }, never(), () => {})).rejects.toThrow(
      "This format could not be encoded.",
    );
  });

  it("refuses WebP past 16383 px before drawing anything", async () => {
    layers = [];
    await expect(renderImageExport(doc("transparent", 20000, 10), { format: "webp", quality: 80, outW: 16384, outH: 8 }, never(), () => {})).rejects.toThrow(
      "16383",
    );
    expect(log).toEqual([]);
  });

  it("an abort lands between drawing chunks: the next chunk is never painted", async () => {
    layers = [drawing("d", [[ink("#010101")], [ink("#020202")]])];
    const ac = new AbortController();
    const p = renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, ac.signal, () => {
      if (log.some((l) => l.includes("|stroke:"))) ac.abort();
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(log.filter((l) => l.includes("|stroke:")).map((l) => l.split("|stroke:")[1])).toEqual(["#010101"]);
    expect(encoded).toEqual([]);
    // an aborted run gives its pencil scratch back too
    expect(log.filter((l) => l.endsWith("|release"))).toHaveLength(1);
  });

  it("keeps its own drawing scratch: a stage render during a yield cannot clear it", async () => {
    layers = [drawing("d", [[ink("#010101")], [ink("#020202")]])];
    const stage = new FakeCanvas(300, 200);
    let rendered = false;
    await renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {
      // The user keeps drawing while Copy image renders: the stage composites
      // (and uses ITS scratch) between the export's chunks.
      if (!rendered && log.some((l) => l.includes("|stroke:"))) {
        rendered = true;
        renderComposite(stage.getContext() as unknown as CanvasRenderingContext2D, doc(), noRes, { zoom: 1, panX: 0, panY: 0 }, { underlay: "none" });
      }
    });
    expect(rendered).toBe(true);
    // The canvas that took the export's first stroke (before the stage ran)…
    const exportScratch = log.find((l) => l.includes("|stroke:"))!.split("|")[0]!;
    const first = log.indexOf(`${exportScratch}|stroke:#010101`);
    const last = log.lastIndexOf(`${exportScratch}|stroke:#020202`);
    // …took its second chunk too, and nothing cleared it in between.
    expect(last).toBeGreaterThan(first);
    expect(log.slice(first, last).filter((l) => l === `${exportScratch}|clear`)).toEqual([]);
  });

  it("closes an unadjusted photo's bitmap once it is drawn", async () => {
    const bitmaps: FakeBitmap[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        const b = new FakeBitmap(64, 36);
        bitmaps.push(b);
        return b;
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(9)]) })));
    layers = [layer("ph", mediaRef("m-ph", { width: 64, height: 36 }))];
    await renderImageExport(doc("transparent", 64, 36), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {});
    expect(log.some((l) => l.endsWith("draw:bmp64x36"))).toBe(true);
    expect(bitmaps.map((b) => b.closed)).toEqual([true]);
  });

  it("paints a drawing chunk by chunk onto one scratch and composites it once", async () => {
    layers = [drawing("d", [[ink("#010101"), ink("#020202")], [ink("#030303")]], { transform: transform({ opacity: 0.6 }) })];
    const seen: number[] = [];
    await renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), (r) => seen.push(r));
    expect(log.filter((l) => l.includes("|stroke:")).map((l) => l.split("|stroke:")[1])).toEqual(["#010101", "#020202", "#030303"]);
    expect(log.filter((l) => l.endsWith("alpha=0.6"))).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe(1);
    // strictly increasing, never past 1
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it("decodes, adjusts in 256-row strips and closes a photo layer's bitmap", async () => {
    const bitmaps: FakeBitmap[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        const b = new FakeBitmap(40, 300);
        bitmaps.push(b);
        return b;
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(9)]) })),
    );
    const adjusted = layer("ph", mediaRef("m-ph", { width: 40, height: 300 }));
    adjusted.clip = { ...adjusted.clip, adjust: { exposure: 0, brightness: 12, contrast: 0, highlights: 0, shadows: 0, saturation: 0, hue: 0, warmth: 0, tint: 0 } };
    layers = [adjusted];
    await renderImageExport(doc("transparent", 40, 300), { format: "png", quality: 100, outW: 40, outH: 300 }, never(), () => {});
    expect(log.filter((l) => l.includes("|get(")).map((l) => l.split("|")[1])).toEqual(["get(0,256)", "get(256,44)"]);
    expect(bitmaps).toHaveLength(1);
    expect(bitmaps[0]!.closed).toBe(true);
  });

  it("decodes straight at the output density for a small output (never the full photo)", async () => {
    const opts: (ImageBitmapOptions | undefined)[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (_b: unknown, o?: ImageBitmapOptions) => {
        opts.push(o);
        return new FakeBitmap(o?.resizeWidth ?? 4000, o?.resizeHeight ?? 3000);
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(9)]) })));
    layers = [layer("ph", mediaRef("m-ph", { width: 4000, height: 3000 }))];
    await renderImageExport(doc("transparent", 4000, 3000), { format: "jpeg", quality: 85, outW: 320, outH: 240 }, never(), () => {});
    expect(opts).toEqual([{ imageOrientation: "from-image", resizeWidth: 320, resizeHeight: 240, resizeQuality: "high" }]);
  });

  it("a resized decode the engine refuses retries fitted to the limits, never surfacing the raw error", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (_b: unknown, o?: ImageBitmapOptions) => {
        // the "file" is 30000 × 30000: over the area limit unless resized to fit
        const w = o?.resizeWidth ?? 30000;
        const h = o?.resizeHeight ?? 30000;
        asked.push(o?.resizeWidth === undefined ? "full" : `${w}x${h}`);
        if (w > RENDER_MAX_SIDE || h > RENDER_MAX_SIDE || w * h > RENDER_MAX_AREA) throw new DOMException("too big", "InvalidStateError");
        return new FakeBitmap(w, h);
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(9)]) })));
    // output 0.8 of the canvas → the layer wants 24000 px of its 30000
    layers = [layer("ph", mediaRef("m-ph", { width: 30000, height: 30000 }))];
    await renderImageExport(doc("transparent", 20000, 20000), { format: "png", quality: 100, outW: 16000, outH: 16000 }, never(), () => {});
    expect(asked).toEqual(["24000x24000", "16384x16384"]);
    expect(log.some((l) => l.endsWith("draw:bmp16384x16384"))).toBe(true);
  });

  it("a Home thumbnail leaves out a missing photo and still draws the rest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, blob: async () => new Blob([new Uint8Array(3)]) })));
    layers = [solid("s", "#123456"), layer("ph", mediaRef("m-ph"), { name: "Harbour" })];
    const blob = await renderThumbnail(doc());
    expect(blob.type).toBe("image/jpeg");
    const fills = log.filter((l) => l.includes("|fillStyle=")).map((l) => l.split("|")[1]);
    expect(fills).toEqual(["fillStyle=#ffffff", "fillStyle=#123456"]);
    expect(encoded).toEqual([{ type: "image/jpeg", quality: 0.85 }]);
  });

  it("names a missing photo instead of exporting without it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) })));
    layers = [layer("ph", mediaRef("m-ph"), { name: "Harbour" })];
    await expect(renderImageExport(doc(), { format: "png", quality: 100, outW: 64, outH: 36 }, never(), () => {})).rejects.toThrow(
      'Couldn\'t read "Harbour"',
    );
  });
});
