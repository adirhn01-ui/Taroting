// Drawing rasters: incremental on append, replay otherwise, warp-then-replay
// for a heavy drawing during a gesture. The painter is mocked (it is another
// module's), so what is counted is WHICH strokes get painted, and when.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipTransform, MediaRef, ProjectFile, Stroke } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import type { Layer } from "../layers";

const painted: string[] = [];
let paintCost = 0;
let now = 0;

const geom = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../geom", () => ({
  layerToCanvas: (t: ClipTransform) => {
    geom.calls++;
    return [t.scale, 0, 0, t.scale, t.x, t.y];
  },
}));
vi.mock("../ink/paint", () => ({
  createScratch: () => ({ get: () => null }),
  paintStroke: (_ctx: unknown, s: Stroke) => {
    painted.push((s as { c: string }).c);
    now += paintCost;
  },
  strokeBounds: (s: Stroke) => {
    const x = Number((s as { c: string }).c.slice(1, 3)) * 10;
    return { x, y: 0, w: 4, h: 4 };
  },
}));
vi.mock("../layers", () => ({ layersOf: () => [] }));

import { appendedFrom, DrawingRasters, REPLAY_SETTLE_MS } from "./drawings";

class FakeCtx {
  setTransform(): void {}
  clearRect(): void {}
  drawImage(): void {}
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
}
class FakeCanvas {
  private ctx = new FakeCtx();
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): FakeCtx {
    return this.ctx;
  }
}

/** A pen stroke whose colour doubles as its id; `#0x…` puts its box at x = 10·x. */
const s = (id: string): Stroke => ({ t: "pen", c: id, w: 2, o: 1, p: "AAAAAAAAAAAAAAAA" });

function t(over: Partial<ClipTransform> = {}): ClipTransform {
  return { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1, ...over };
}

function layerOf(chunks: Stroke[][], transform = t()): Layer {
  const media: MediaRef = {
    id: "m",
    path: "Drawing",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 0,
    hasAudio: false,
    width: 200,
    height: 100,
    generator: { type: "drawing", chunks },
  };
  return {
    trackId: "d",
    clipId: "c",
    mediaId: "m",
    kind: "drawing",
    name: "Drawing 1",
    hidden: false,
    index: 0,
    clip: { id: "c", mediaId: "m", timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform, audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false } },
    media,
    transform,
  };
}

const doc: ProjectFile = {
  schema: 3,
  kind: "image",
  app: "taroting",
  id: "p",
  name: "p",
  createdAt: "",
  modifiedAt: "",
  media: [],
  timeline: { fps: { num: 30, den: 1 }, width: 200, height: 100, tracks: [] },
  export: DEFAULT_EXPORT_PRESET,
  image: { background: "transparent" },
};

const view = { zoom: 1, panX: 0, panY: 0 };

beforeEach(() => {
  painted.length = 0;
  paintCost = 0;
  now = 0;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("performance", { now: () => now });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("appendedFrom", () => {
  const a = s("#01");
  const b = s("#02");
  const c = s("#03");
  const d = s("#04");
  const chunk0 = [a, b];

  it("finds the new strokes when the last chunk was copied to take one", () => {
    expect(appendedFrom([chunk0], 2, [[a, b, c]])).toEqual({ chunk: 0, index: 2 });
  });
  it("finds them in a new chunk when the last one was full", () => {
    expect(appendedFrom([chunk0], 2, [chunk0, [c]])).toEqual({ chunk: 1, index: 0 });
  });
  it("refuses an earlier chunk that changed, a removal, and a reorder", () => {
    expect(appendedFrom([chunk0, [c]], 3, [[a], [c, d]])).toBeNull();
    expect(appendedFrom([[a, b, c]], 3, [[a, c]])).toBeNull();
    expect(appendedFrom([[a, b]], 2, [[b, a, c]])).toBeNull();
    // a stroke inserted into an EARLIER chunk is not an append, even though
    // every old stroke is still there
    expect(appendedFrom([chunk0, [c]], 3, [[a, b, d], [c]])).toBeNull();
  });
});

describe("DrawingRasters", () => {
  it("paints only the appended stroke, and replays after anything else", () => {
    const r = new DrawingRasters(() => {});
    r.setStage(400, 300);
    const a = s("#01");
    const b = s("#02");
    const c = s("#03");
    expect(r.raster(doc, layerOf([[a, b]]), view)).not.toBeNull();
    expect(painted).toEqual(["#01", "#02"]);

    painted.length = 0;
    r.raster(doc, layerOf([[a, b, c]]), view);
    expect(painted).toEqual(["#03"]);

    painted.length = 0;
    r.raster(doc, layerOf([[a, c]]), view); // b erased by stroke
    expect(painted).toEqual(["#01", "#03"]);

    painted.length = 0;
    r.raster(doc, layerOf([[a, c]]), view); // new chunk arrays, same strokes → append of nothing
    expect(painted).toEqual([]);
  });

  it("replays at once on a view change when the drawing is cheap", () => {
    const r = new DrawingRasters(() => {});
    r.setStage(400, 300);
    const chunks = [[s("#01"), s("#02")]];
    const l = layerOf(chunks);
    r.raster(doc, l, view);
    painted.length = 0;
    r.raster(doc, l, { zoom: 2, panX: 0, panY: 0 });
    expect(painted).toEqual(["#01", "#02"]);
  });

  it("culls strokes the view has scrolled off the raster", () => {
    const r = new DrawingRasters(() => {});
    r.setStage(100, 100);
    // boxes at x = 10 and x = 500
    r.raster(doc, layerOf([[s("#01"), s("#50")]]), view);
    expect(painted).toEqual(["#01"]);
  });

  it("warps a heavy drawing during a gesture and replays once it settles", () => {
    const emits: number[] = [];
    const r = new DrawingRasters(() => emits.push(1));
    r.setStage(400, 300);
    paintCost = 5; // two strokes → a 10 ms replay: heavy
    const chunks = [[s("#01"), s("#02")]];
    const l = layerOf(chunks);
    const first = r.raster(doc, l, view);
    painted.length = 0;

    const warped = r.raster(doc, l, { zoom: 1.5, panX: 4, panY: 0 });
    expect(painted).toEqual([]);
    expect(warped).not.toBe(first);
    r.raster(doc, l, { zoom: 1.7, panX: 4, panY: 0 });
    expect(painted).toEqual([]);

    vi.advanceTimersByTime(REPLAY_SETTLE_MS - 1);
    expect(emits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emits).toEqual([1]);

    const settled = r.raster(doc, l, { zoom: 1.7, panX: 4, panY: 0 });
    expect(painted).toEqual(["#01", "#02"]);
    expect(settled).toBe(first);
  });

  it("a stage resize under a heavy drawing warps the old raster and rebuilds once it settles", () => {
    const emits: number[] = [];
    const r = new DrawingRasters(() => emits.push(1));
    r.setStage(400, 300);
    paintCost = 5; // a 10 ms replay: heavy
    const l = layerOf([[s("#01"), s("#02")]]);
    const first = r.raster(doc, l, view);
    painted.length = 0;

    // dragging the window edge: a render on every step, none of them replays
    r.setStage(500, 300);
    const step1 = r.raster(doc, l, { zoom: 1.2, panX: 3, panY: 0 }) as unknown as FakeCanvas;
    r.setStage(520, 310);
    const step2 = r.raster(doc, l, { zoom: 1.25, panX: 3, panY: 0 }) as unknown as FakeCanvas;
    expect(painted).toEqual([]);
    expect(step1).not.toBe(first);
    expect([step2.width, step2.height]).toEqual([520, 310]);

    vi.advanceTimersByTime(REPLAY_SETTLE_MS);
    expect(emits).toEqual([1]);
    const rebuilt = r.raster(doc, l, { zoom: 1.25, panX: 3, panY: 0 }) as unknown as FakeCanvas;
    expect(painted).toEqual(["#01", "#02"]);
    expect([rebuilt.width, rebuilt.height]).toEqual([520, 310]);
  });

  it("a cheap drawing is simply rebuilt at the new stage size", () => {
    const r = new DrawingRasters(() => {});
    r.setStage(400, 300);
    const l = layerOf([[s("#01")]]);
    r.raster(doc, l, view);
    painted.length = 0;
    r.setStage(500, 300);
    const c = r.raster(doc, l, view) as unknown as FakeCanvas;
    expect(painted).toEqual(["#01"]);
    expect(c.width).toBe(500);
  });

  it("a steady frame recomputes no layer matrix", () => {
    const r = new DrawingRasters(() => {});
    r.setStage(400, 300);
    const l = layerOf([[s("#01")]], t({ scale: 1.5, x: 7 }));
    geom.calls = 0;
    for (let i = 0; i < 4; i++) r.raster(doc, l, { zoom: 1 + i, panX: 0, panY: 0 });
    expect(geom.calls).toBe(1);
  });

  it("drops the rasters of layers that are gone or hidden", () => {
    const r = new DrawingRasters(() => {});
    r.setStage(400, 300);
    const l = layerOf([[s("#01")]]);
    const canvas = r.raster(doc, l, view) as unknown as FakeCanvas;
    r.retain(new Set());
    expect(canvas.width).toBe(0);
    painted.length = 0;
    r.raster(doc, l, view);
    expect(painted).toEqual(["#01"]);
  });
});
