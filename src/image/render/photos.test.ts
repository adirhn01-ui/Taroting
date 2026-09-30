// The preview's photo cache: missing files, the recorded-size rule, working
// levels and the one-adjust-per-pass budget. createImageBitmap / fetch /
// OffscreenCanvas are stubbed (node has none of them).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipAdjust, ClipTransform, MediaRef } from "../../core/types";
import type { Layer } from "../layers";

const adjustCalls: number[] = [];
vi.mock("../adjust/plan", () => ({
  buildAdjustPlan: () => ({}),
  applyAdjustPlan: (px: Uint8ClampedArray) => adjustCalls.push(px.length),
  isIdentityAdjust: (a: ClipAdjust | undefined) => a === undefined,
}));

import { PhotoCache, stillFit, workingWidth } from "./photos";

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
  constructor(readonly canvas: FakeCanvas) {}
  setTransform(): void {}
  drawImage(): void {}
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  getImageData(_x: number, _y: number, w: number, rows: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(w * rows * 4) };
  }
  putImageData(): void {}
}
class FakeCanvas {
  private ctx = new FakeCtx(this);
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): FakeCtx {
    return this.ctx;
  }
}

/** Bitmap size the "file" decodes at when no resize is asked for. */
let decodesAt = { w: 400, h: 200 };
let fileOk = true;
/** the engine refuses a resized decode straight from the file */
let refuseResize = false;
const decodes: { w?: number; h?: number; from: string }[] = [];

function t(): ClipTransform {
  return { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 };
}
function media(over: Partial<MediaRef> = {}): MediaRef {
  return { id: "m1", path: "C:\\p\\a.jpg", size: 5, mtimeMs: 9, kind: "image", duration: 0, hasAudio: false, width: 400, height: 200, ...over };
}
function photoLayer(m: MediaRef, adjust?: ClipAdjust, trackId = "t1"): Layer {
  return {
    trackId,
    clipId: `c-${trackId}`,
    mediaId: m.id,
    kind: "photo",
    name: "a",
    hidden: false,
    index: 0,
    clip: { id: `c-${trackId}`, mediaId: m.id, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform: t(), audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false }, ...(adjust ? { adjust } : {}) },
    media: m,
    transform: t(),
  };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  decodesAt = { w: 400, h: 200 };
  fileOk = true;
  refuseResize = false;
  decodes.length = 0;
  adjustCalls.length = 0;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal(
    "fetch",
    // a refused/missing asset still has a body here, so only `ok` can tell
    vi.fn(async () => ({ ok: fileOk, blob: async () => new Blob([new Uint8Array(fileOk ? 7 : 3)]) })),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (src: unknown, opts?: ImageBitmapOptions) => {
      const from = src instanceof FakeBitmap ? "bitmap" : "blob";
      decodes.push({ w: opts?.resizeWidth, h: opts?.resizeHeight, from });
      if (refuseResize && from === "blob" && opts?.resizeWidth) throw new DOMException("refused", "InvalidStateError");
      if (opts?.resizeWidth) return new FakeBitmap(opts.resizeWidth, opts.resizeHeight ?? 1);
      return new FakeBitmap(decodesAt.w, decodesAt.h);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stillFit", () => {
  it("classifies decoded vs recorded sizes", () => {
    expect(stillFit({ w: 36, h: 64 }, { width: 36, height: 64 })).toBe("match");
    expect(stillFit({ w: 64, h: 36 }, { width: 36, height: 64 })).toBe("transposed");
    expect(stillFit({ w: 60, h: 36 }, { width: 36, height: 64 })).toBe("different");
    expect(stillFit({ w: 64, h: 36 }, {})).toBe("unrecorded");
    expect(stillFit({ w: 64, h: 36 }, { width: 0, height: 36 })).toBe("unrecorded");
  });
  it("working width follows scale × zoom, never above the photo", () => {
    expect(workingWidth(4000, 0.25)).toBe(1000);
    expect(workingWidth(4000, 3)).toBe(4000);
    expect(workingWidth(4001, 0.1)).toBe(401);
  });
});

describe("PhotoCache", () => {
  it("a missing file (an empty 404) fails the layer with a relink hint", async () => {
    fileOk = false;
    const emits: number[] = [];
    const cache = new PhotoCache(() => emits.push(1));
    const m = media();
    expect(cache.photo(photoLayer(m), 1)).toBeNull();
    await flush();
    expect(cache.status(m)).toEqual({ state: "failed", message: "File not found — relink it" });
    expect(emits.length).toBe(1);
    expect(decodes).toEqual([]);
  });

  it("never adopts a decoded size over a recorded one; reports it only when none was recorded", async () => {
    decodesAt = { w: 64, h: 36 };
    const dims: string[] = [];
    const cache = new PhotoCache(() => {});
    cache.onMediaDims((id, w, h) => dims.push(`${id}:${w}x${h}`));

    const recorded = media({ id: "rec", width: 36, height: 64 });
    cache.photo(photoLayer(recorded), 1);
    await flush();
    expect(dims).toEqual([]);
    expect(cache.status(recorded).message).toBe("Decodes at 64 × 36, recorded as 36 × 64");

    const bare = media({ id: "bare", width: undefined, height: undefined });
    cache.photo(photoLayer(bare, undefined, "t2"), 1);
    await flush();
    // a reload before the caller recorded the size does not report it again
    cache.invalidate("bare");
    cache.photo(photoLayer(bare, undefined, "t2"), 1);
    await flush();
    expect(dims).toEqual(["bare:64x36"]);
  });

  it("decodes a recorded photo STRAIGHT at the working level for a zoomed-out stage", async () => {
    const cache = new PhotoCache(() => {});
    const m = media();
    cache.photo(photoLayer(m), 0.25);
    await flush();
    // one decode, at ceil(100 × 1.25) px: the full 400 px photo never exists
    expect(decodes).toEqual([{ w: 125, h: 63, from: "blob" }]);
    const src = cache.photo(photoLayer(m), 0.25) as unknown as FakeBitmap;
    expect(src.width).toBe(125);
    expect(cache.status(m)).toEqual({ state: "ready", natural: { w: 400, h: 200 } });
  });

  it("a photo with no recorded size is decoded whole first (its size is all there is)", async () => {
    const cache = new PhotoCache(() => {});
    const m = media({ width: undefined, height: undefined });
    cache.photo(photoLayer(m), 0.25);
    await flush();
    expect(decodes).toEqual([
      { w: undefined, h: undefined, from: "blob" },
      { w: 125, h: 63, from: "bitmap" },
    ]);
    expect(cache.status(m).state).toBe("ready");
  });

  it("a refused working-level decode falls back to the full decode", async () => {
    refuseResize = true;
    const cache = new PhotoCache(() => {});
    const m = media();
    cache.photo(photoLayer(m), 0.25);
    await flush();
    expect(decodes).toEqual([
      { w: 125, h: 63, from: "blob" },
      { w: undefined, h: undefined, from: "blob" },
      { w: 125, h: 63, from: "bitmap" },
    ]);
    expect(cache.status(m)).toEqual({ state: "ready", natural: { w: 400, h: 200 } });
  });

  it("adjusts at most one photo per render pass", async () => {
    const cache = new PhotoCache(() => {});
    const adj: ClipAdjust = { exposure: 0, brightness: 30, contrast: 0, highlights: 0, shadows: 0, saturation: 0, hue: 0, warmth: 0, tint: 0 };
    const a = media({ id: "a", path: "a.png" });
    const b = media({ id: "b", path: "b.png" });
    cache.photo(photoLayer(a, adj, "ta"), 1);
    cache.photo(photoLayer(b, adj, "tb"), 1);
    await flush();

    const first = cache.photo(photoLayer(a, adj, "ta"), 1);
    const second = cache.photo(photoLayer(b, adj, "tb"), 1);
    expect(first).toBeInstanceOf(FakeCanvas);
    expect(second).toBeInstanceOf(FakeBitmap); // shown unadjusted this pass
    expect(adjustCalls.length).toBe(1); // 200 rows: one strip

    await flush(); // the pass is over
    expect(cache.photo(photoLayer(a, adj, "ta"), 1)).toBe(first); // cached: no work
    expect(adjustCalls.length).toBe(1);
    expect(cache.photo(photoLayer(b, adj, "tb"), 1)).toBeInstanceOf(FakeCanvas);
    expect(adjustCalls.length).toBe(2);
  });

  it("dispose closes every bitmap", async () => {
    const cache = new PhotoCache(() => {});
    const m = media();
    cache.photo(photoLayer(m), 1);
    await flush();
    const bmp = cache.photo(photoLayer(m), 1) as unknown as FakeBitmap;
    cache.dispose();
    expect(bmp.closed).toBe(true);
  });
});
