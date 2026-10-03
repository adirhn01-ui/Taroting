// Dragging an adjustment slider over a big photo: the frames of a drag adjust
// a proxy about the stage's size, and the full level is adjusted once, when
// the drag goes quiet. createImageBitmap / fetch / OffscreenCanvas are
// stubbed (node has none of them); what is counted is how many pixels each
// frame adjusts, through the width and rows of every getImageData strip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipAdjust, ClipTransform, MediaRef } from "../../core/types";
import type { Layer } from "../layers";

vi.mock("../adjust/plan", () => ({
  buildAdjustPlan: () => ({}),
  applyAdjustPlan: () => {},
  isIdentityAdjust: (a: ClipAdjust | undefined) => a === undefined,
}));

import { ADJUST_DRAG_MS, PhotoCache } from "./photos";

/** every getImageData strip: [canvas width, strip width, rows] */
let strips: [number, number, number][] = [];
let canvases: FakeCanvas[] = [];

class FakeBitmap {
  closed = false;
  constructor(
    public width: number,
    public height: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}
class FakeCtx {
  imageSmoothingEnabled = false;
  imageSmoothingQuality = "low";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  constructor(readonly canvas: FakeCanvas) {}
  setTransform(): void {}
  drawImage(): void {}
  getImageData(_x: number, _y: number, w: number, rows: number): { data: Uint8ClampedArray } {
    strips.push([this.canvas.width, w, rows]);
    // Adjusting takes time: about 60 MP/s, so the 12 MP photo costs ~200 ms
    // and a stage-sized proxy ~35 ms. A frozen clock would let a drag
    // detector that measures from BEFORE the adjust pass by construction.
    now += (w * rows) / 60000;
    return { data: new Uint8ClampedArray(4) };
  }
  putImageData(): void {}
}
class FakeCanvas {
  private ctx = new FakeCtx(this);
  constructor(
    public width: number,
    public height: number,
  ) {
    canvases.push(this);
  }
  getContext(): FakeCtx {
    return this.ctx;
  }
}

let now = 0;
let emits = 0;

function t(): ClipTransform {
  return { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 };
}
/** A 4000 × 3000 photo: 12 MP, far more than a 1920 × 1080 stage shows. */
function media(over: Partial<MediaRef> = {}): MediaRef {
  return { id: "m1", path: "C:\\p\\big.jpg", size: 5, mtimeMs: 9, kind: "image", duration: 0, hasAudio: false, width: 4000, height: 3000, ...over };
}
/** A photo layer; no `adjust` = unadjusted (the plain decoded level). */
function photoLayer(m: MediaRef, adjust?: ClipAdjust): Layer {
  return {
    trackId: "t1",
    clipId: "c-t1",
    mediaId: m.id,
    kind: "photo",
    name: "big",
    hidden: false,
    index: 0,
    clip: { id: "c-t1", mediaId: m.id, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform: t(), audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false }, ...(adjust ? { adjust } : {}) },
    media: m,
    transform: t(),
  };
}
const brightness = (v: number): ClipAdjust => ({ exposure: 0, brightness: v, contrast: 0, highlights: 0, shadows: 0, saturation: 0, hue: 0, warmth: 0, tint: 0 });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
/** Pixels the strips since `from` adjusted, and the widths they ran at. */
function since(from: number): { px: number; widths: number[] } {
  const s = strips.slice(from);
  return { px: s.reduce((n, [, w, r]) => n + w * r, 0), widths: [...new Set(s.map(([, w]) => w))] };
}

/** One render frame `ms` after the last: the photo with `adjust`, at 100%. */
async function frame(cache: PhotoCache, m: MediaRef, adjust: ClipAdjust, ms: number) {
  now += ms;
  await flush(); // the previous pass is over: its one-adjust budget is back
  const from = strips.length;
  const src = cache.photo(photoLayer(m, adjust), 1) as unknown as FakeCanvas;
  return { src, ...since(from) };
}

/** A cache with the big photo loaded whole (need 1 → the full-decode path). */
async function loaded(): Promise<{ cache: PhotoCache; m: MediaRef }> {
  const cache = new PhotoCache(() => void emits++);
  const m = media();
  cache.photo(photoLayer(m), 1);
  await flush();
  return { cache, m };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  strips = [];
  canvases = [];
  now = 1000;
  emits = 0;
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(7)]) })));
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (_src: unknown, opts?: ImageBitmapOptions) =>
      opts?.resizeWidth ? new FakeBitmap(opts.resizeWidth, opts.resizeHeight ?? 1) : new FakeBitmap(4000, 3000),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PhotoCache: dragging an adjustment over a big photo", () => {
  const FULL = 4000 * 3000;
  // 1920 × 1080 px at the photo's aspect: √(2073600 / 12e6) × (4000, 3000)
  const PROXY = { w: 1663, h: 1247 };

  it("adjusts a stage-sized proxy while the slider moves, and the full photo once when it stops", async () => {
    const { cache, m } = await loaded();

    // a single change: the sharp path, at once
    const first = await frame(cache, m, brightness(10), 0);
    expect(first.px).toBe(FULL);
    expect([first.src.width, first.src.height]).toEqual([4000, 3000]);

    // the slider keeps moving: each frame adjusts the proxy only
    const second = await frame(cache, m, brightness(20), 16);
    expect(second.widths).toEqual([PROXY.w]);
    expect(second.px).toBe(PROXY.w * PROXY.h);
    expect([second.src.width, second.src.height]).toEqual([PROXY.w, PROXY.h]);
    // the stale sharp copy is let go of, not kept beside the proxy
    expect(first.src.width).toBe(0);

    const made = canvases.length;
    const last = brightness(30);
    const third = await frame(cache, m, last, 16);
    expect(third.px).toBe(PROXY.w * PROXY.h);
    expect(third.src).toBe(second.src); // same proxy canvas, same downscale
    expect(canvases.length).toBe(made);

    // quiet for ADJUST_DRAG_MS: one more render is asked for…
    const before = emits;
    vi.advanceTimersByTime(ADJUST_DRAG_MS - 1);
    expect(emits).toBe(before);
    vi.advanceTimersByTime(1);
    expect(emits).toBe(before + 1);

    // …and that render adjusts the full photo once (the SAME adjustment the
    // drag ended on, so nothing but the settle can be what asks), then holds it
    const sharp = await frame(cache, m, last, 16);
    expect(sharp.px).toBe(FULL);
    expect([sharp.src.width, sharp.src.height]).toEqual([4000, 3000]);
    expect(third.src.width).toBe(0); // the proxy canvases are given back
    expect(canvases.filter((c) => c.width > 0 && c !== sharp.src)).toEqual([]);
    const again = await frame(cache, m, last, 16);
    expect(again.px).toBe(0);
    expect(again.src).toBe(sharp.src);
    cache.dispose();
  });

  it("a long drag stays on the proxy: every proxy frame restarts the drag window", async () => {
    const { cache, m } = await loaded();
    await frame(cache, m, brightness(1), 0);
    // ~51 ms a frame (16 ms gap + ~35 ms proxy adjust): the last frames land
    // far past ADJUST_DRAG_MS after the drag's first sharp adjust ended.
    for (let v = 2; v <= 9; v++) {
      const f = await frame(cache, m, brightness(v), 16);
      expect(f.px).toBe(PROXY.w * PROXY.h);
    }
    cache.dispose();
  });

  it("a change just after the settle's sharp adjust resumes the drag on the proxy", async () => {
    const { cache, m } = await loaded();
    await frame(cache, m, brightness(10), 0);
    const last = brightness(20);
    await frame(cache, m, last, 16);
    vi.advanceTimersByTime(ADJUST_DRAG_MS);
    // the settle's render: the same adjustment, sharp (~200 ms of work)
    const sharp = await frame(cache, m, last, ADJUST_DRAG_MS);
    expect(sharp.px).toBe(FULL);
    // the slider moves again 16 ms after that pass ended
    const resumed = await frame(cache, m, brightness(30), 16);
    expect(resumed.px).toBe(PROXY.w * PROXY.h);
    cache.dispose();
  });

  it("a render mid-drag with the same adjustment shows the proxy without adjusting again", async () => {
    const { cache, m } = await loaded();
    await frame(cache, m, brightness(10), 0);
    const adj = brightness(20);
    const drag = await frame(cache, m, adj, 16);
    const repaint = await frame(cache, m, adj, 16);
    expect(repaint.px).toBe(0);
    expect(repaint.src).toBe(drag.src);
    cache.dispose();
  });

  it("changes spaced further apart than a drag are each adjusted sharp", async () => {
    const { cache, m } = await loaded();
    for (const v of [10, 20, 30]) {
      const f = await frame(cache, m, brightness(v), ADJUST_DRAG_MS + 50);
      expect(f.px).toBe(FULL);
    }
    expect(emits).toBe(1); // only the load's
    cache.dispose();
  });

  it("a photo no bigger than the stage needs is adjusted sharp on every frame of a drag (no proxy, no timer)", async () => {
    const { cache, m } = await loaded();
    // a 4K stage: 12 MP is under twice its area
    cache.setStage(3840, 2160);
    for (const v of [10, 20, 30]) {
      const f = await frame(cache, m, brightness(v), 16);
      expect(f.px).toBe(FULL);
    }
    vi.advanceTimersByTime(ADJUST_DRAG_MS * 2);
    expect(emits).toBe(1);
    cache.dispose();
  });

  it("the proxy follows the stage's size", async () => {
    const { cache, m } = await loaded();
    cache.setStage(1000, 600);
    await frame(cache, m, brightness(10), 0);
    const drag = await frame(cache, m, brightness(20), 16);
    // √(600000 / 12e6) × (4000, 3000)
    expect([drag.src.width, drag.src.height]).toEqual([894, 671]);
    cache.dispose();
  });

  it("drags over the smaller level a zoom-in left behind when it is near the stage's size, never over a tiny one", async () => {
    // Loaded fitted, then zoomed to 100%: the sharp level is decoded beside
    // the fitted one, and both are kept. (LEVEL_DEBOUNCE_MS = 200.)
    const zoomedFrom = async (need: number): Promise<{ cache: PhotoCache; m: MediaRef; small: number }> => {
      const cache = new PhotoCache(() => void emits++);
      const m = media();
      cache.photo(photoLayer(m), need);
      await flush();
      const small = (cache.photo(photoLayer(m), need) as unknown as FakeBitmap).width;
      cache.photo(photoLayer(m), 1);
      vi.advanceTimersByTime(200);
      await flush();
      return { cache, m, small };
    };

    // 2000 × 1500 (3 MP): close enough to a 2 MP stage to drag over as it is
    const near = await zoomedFrom(0.4);
    expect(near.small).toBe(2000);
    await frame(near.cache, near.m, brightness(10), 0);
    const made = canvases.length;
    const a = await frame(near.cache, near.m, brightness(20), 16);
    expect([a.src.width, a.src.height]).toEqual([2000, 1500]);
    expect(canvases.length).toBe(made + 1); // the adjusted copy only: no downscale
    near.cache.dispose();

    // 600 × 450: a quarter of the stage's pixels is too few — downscale instead
    const tiny = await zoomedFrom(0.12);
    expect(tiny.small).toBe(600);
    await frame(tiny.cache, tiny.m, brightness(10), 0);
    const b = await frame(tiny.cache, tiny.m, brightness(20), 16);
    expect([b.src.width, b.src.height]).toEqual([PROXY.w, PROXY.h]);
    tiny.cache.dispose();
  });

  it("a layer let go of mid-drag takes its settle with it: no render is asked for afterwards", async () => {
    const { cache, m } = await loaded();
    await frame(cache, m, brightness(10), 0);
    const drag = await frame(cache, m, brightness(20), 16);
    cache.retain(new Set());
    expect(drag.src.width).toBe(0);
    const before = emits;
    vi.advanceTimersByTime(ADJUST_DRAG_MS * 2);
    expect(emits).toBe(before);
    cache.dispose();
  });
});
