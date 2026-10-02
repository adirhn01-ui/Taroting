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

describe("PhotoCache.blobFor", () => {
  it("hands over the file it loaded, for any MediaRef of that file, and only once it is ready", async () => {
    const file = new Blob([new Uint8Array(11)]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => file })));
    // The decode is held back, so the file is fetched (the blob is in hand)
    // while the entry is still loading.
    let decoded!: (b: FakeBitmap) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<FakeBitmap>((r) => (decoded = r))));
    const cache = new PhotoCache(() => {});
    const m = media();
    expect(cache.blobFor(m)).toBeNull(); // never asked for

    cache.photo(photoLayer(m), 1);
    await flush();
    expect(cache.status(m).state).toBe("loading");
    expect(cache.blobFor(m)).toBeNull(); // fetched, not yet ready

    decoded(new FakeBitmap(400, 200));
    await flush();
    expect(cache.status(m).state).toBe("ready");
    expect(cache.blobFor(m)).toBe(file);
    // A duplicated layer is a new MediaRef over the same file: the same blob.
    expect(cache.blobFor({ ...m, id: "m2" })).toBe(file);
    // The same path changed on disk since is a different file.
    expect(cache.blobFor({ ...m, mtimeMs: m.mtimeMs + 1 })).toBeNull();
    expect(cache.blobFor({ ...m, size: m.size + 1 })).toBeNull();

    cache.dispose();
    expect(cache.blobFor(m)).toBeNull();
  });

  it("has nothing for a file it could not decode, so the caller reads it itself", async () => {
    // Fetched fine (so the entry holds a blob), then the decode fails.
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new DOMException("bad", "InvalidStateError"))));
    const cache = new PhotoCache(() => {});
    const m = media({ width: undefined, height: undefined });
    cache.photo(photoLayer(m), 1);
    await flush();
    expect(cache.status(m)).toEqual({ state: "failed", message: "This image couldn't be read." });
    expect(cache.blobFor(m)).toBeNull();
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
    // the file is shared, but the drift is a property of each MediaRef's own recorded size
    expect(cache.status(bare).message).toBeUndefined();
    expect(cache.status(recorded).message).toBe("Decodes at 64 × 36, recorded as 36 × 64");
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

describe("PhotoCache: one decode per FILE, not per layer", () => {
  const fetches = (): number => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  // Two MediaRefs over one file, as `duplicateLayer` makes them: new id, same path/size/mtime.
  const a = (): MediaRef => media({ id: "dup-a" });
  const b = (): MediaRef => media({ id: "dup-b" });

  it("a duplicated layer shares the original's fetch, blob and decoded level", async () => {
    const cache = new PhotoCache(() => {});
    cache.photo(photoLayer(a(), undefined, "ta"), 0.25);
    cache.photo(photoLayer(b(), undefined, "tb"), 0.25);
    await flush();
    expect(fetches()).toBe(1);
    expect(decodes).toEqual([{ w: 125, h: 63, from: "blob" }]);
    const pa = cache.photo(photoLayer(a(), undefined, "ta"), 0.25);
    expect(pa).toBeInstanceOf(FakeBitmap);
    expect(cache.photo(photoLayer(b(), undefined, "tb"), 0.25)).toBe(pa);
    expect(cache.status(b())).toEqual({ state: "ready", natural: { w: 400, h: 200 } });
  });

  it("adjusted copies stay per layer, and letting one layer go keeps the other's pixels", async () => {
    const adj: ClipAdjust = { exposure: 0, brightness: 30, contrast: 0, highlights: 0, shadows: 0, saturation: 0, hue: 0, warmth: 0, tint: 0 };
    const cache = new PhotoCache(() => {});
    cache.photo(photoLayer(a(), adj, "ta"), 1);
    cache.photo(photoLayer(b(), undefined, "tb"), 1);
    await flush();
    const pa = cache.photo(photoLayer(a(), adj, "ta"), 1) as unknown as FakeCanvas;
    const pb = cache.photo(photoLayer(b(), undefined, "tb"), 1) as unknown as FakeBitmap;
    expect(pa).toBeInstanceOf(FakeCanvas);
    expect(pb).toBeInstanceOf(FakeBitmap);

    // the adjusted layer is deleted: its copy goes, the shared decode stays
    cache.retain(new Set(["dup-b"]));
    expect(pa.width).toBe(0);
    expect(pb.closed).toBe(false);
    expect(cache.photo(photoLayer(b(), undefined, "tb"), 1)).toBe(pb);
    // a relink of one layer drops only that layer's hold
    cache.photo(photoLayer(a(), undefined, "ta"), 1);
    cache.invalidate("dup-a");
    expect(pb.closed).toBe(false);
    expect(fetches()).toBe(1);

    // the last layer showing the file goes: so does the file
    cache.retain(new Set());
    expect(pb.closed).toBe(true);
  });

  it("a FAILED file shared by two layers is fetched again after one layer's relink", async () => {
    // Both layers open while the file is missing; the user restores it in
    // place (same path, size and mtime) and relinks one row.
    fileOk = false;
    const cache = new PhotoCache(() => {});
    cache.photo(photoLayer(a(), undefined, "ta"), 1);
    cache.photo(photoLayer(b(), undefined, "tb"), 1);
    await flush();
    expect(fetches()).toBe(1);
    expect(cache.status(a()).state).toBe("failed");
    expect(cache.status(b()).state).toBe("failed");

    fileOk = true;
    cache.invalidate("dup-a");
    cache.photo(photoLayer(a(), undefined, "ta"), 1);
    cache.photo(photoLayer(b(), undefined, "tb"), 1);
    await flush();
    expect(fetches()).toBe(2);
    expect(cache.status(a())).toEqual({ state: "ready", natural: { w: 400, h: 200 } });
    expect(cache.status(b())).toEqual({ state: "ready", natural: { w: 400, h: 200 } });
    // one record again, shared: a third render fetches nothing
    cache.photo(photoLayer(a(), undefined, "ta"), 1);
    cache.photo(photoLayer(b(), undefined, "tb"), 1);
    await flush();
    expect(fetches()).toBe(2);
  });

  it("two layers of one photo at different scales settle on one level instead of fighting over it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cache = new PhotoCache(() => {});
      const pass = (): void => {
        cache.photo(photoLayer(a(), undefined, "ta"), 0.25);
        cache.photo(photoLayer(b(), undefined, "tb"), 1);
      };
      pass();
      await flush();
      // loaded for the sharpest of the two (100%): one whole decode
      expect(decodes).toEqual([{ w: undefined, h: undefined, from: "blob" }]);
      for (let i = 0; i < 4; i++) {
        pass();
        vi.advanceTimersByTime(1000);
        await flush();
      }
      expect(decodes.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a duplicate with no recorded size joining a decoded file still gets its size recorded, once", async () => {
    const dims: string[] = [];
    const cache = new PhotoCache(() => {});
    cache.onMediaDims((id, w, h) => dims.push(`${id}:${w}x${h}`));
    cache.photo(photoLayer(a(), undefined, "ta"), 1);
    await flush();
    expect(dims).toEqual([]);

    const bare = media({ id: "dup-bare", width: undefined, height: undefined });
    cache.photo(photoLayer(bare, undefined, "tb"), 1);
    expect(dims).toEqual([]); // never from inside the render pass
    await flush();
    expect(dims).toEqual(["dup-bare:400x200"]);
    cache.photo(photoLayer(bare, undefined, "tb"), 1);
    await flush();
    expect(dims).toEqual(["dup-bare:400x200"]);
    expect(fetches()).toBe(1);
  });
});
