import { describe, expect, it } from "vitest";
import {
  clampedBreakpoints,
  EPS_KF,
  evalKfs,
  kfNear,
  KfCursor,
  removeKfNear,
  upsertKf,
} from "./anim";
import {
  addMedia,
  checkInvariants,
  createProject,
  insertClip,
  makeClip,
  updateClip,
} from "./project";
import { rat } from "./time";
import type { Keyframe, MediaInfo } from "./types";

const kfs = (...pairs: [number, number][]): Keyframe[] =>
  pairs.map(([t, v]) => ({ t, v }));

describe("evalKfs", () => {
  it("throws on an empty array", () => {
    expect(() => evalKfs([], 0)).toThrow();
  });

  it("is constant for a single keyframe", () => {
    const k = kfs([5, 7]);
    expect(evalKfs(k, 0)).toBe(7);
    expect(evalKfs(k, 5)).toBe(7);
    expect(evalKfs(k, 100)).toBe(7);
  });

  it("clamps before first and after last", () => {
    const k = kfs([2, 10], [4, 20]);
    expect(evalKfs(k, -1)).toBe(10);
    expect(evalKfs(k, 2)).toBe(10);
    expect(evalKfs(k, 4)).toBe(20);
    expect(evalKfs(k, 99)).toBe(20);
  });

  it("interpolates linearly between", () => {
    const k = kfs([0, 0], [10, 100]);
    expect(evalKfs(k, 5)).toBeCloseTo(50, 12);
    expect(evalKfs(k, 2.5)).toBeCloseTo(25, 12);
  });

  it("interpolates across multiple segments exactly", () => {
    const k = kfs([0, 0], [1, 10], [3, 10], [4, 0]);
    expect(evalKfs(k, 0.5)).toBeCloseTo(5, 12);
    expect(evalKfs(k, 2)).toBeCloseTo(10, 12); // flat middle
    expect(evalKfs(k, 3.5)).toBeCloseTo(5, 12);
  });
});

describe("KfCursor", () => {
  const k = kfs([0, 0], [1, 10], [2, 5], [5, 25], [9, -3]);

  it("matches evalKfs over a monotone sweep", () => {
    const cur = new KfCursor();
    for (let s = -2; s <= 11; s += 0.017) {
      expect(cur.eval(k, s)).toBeCloseTo(evalKfs(k, s), 12);
    }
  });

  it("matches evalKfs over a random-access sequence", () => {
    const cur = new KfCursor();
    const samples = [3.2, -1, 8.9, 0.5, 5, 2.1, 10, 0, 1.5, 4.4, 9, 6.6];
    for (const s of samples) {
      expect(cur.eval(k, s)).toBeCloseTo(evalKfs(k, s), 12);
    }
  });

  it("matches evalKfs after swapping the kfs array identity", () => {
    const cur = new KfCursor();
    const a = kfs([0, 0], [10, 100]);
    const b = kfs([0, 100], [10, 0]);
    expect(cur.eval(a, 5)).toBeCloseTo(50, 12);
    expect(cur.eval(b, 5)).toBeCloseTo(50, 12); // identity change → re-seek
    expect(cur.eval(a, 2)).toBeCloseTo(20, 12);
    expect(cur.eval(b, 2)).toBeCloseTo(80, 12);
  });

  it("throws on an empty array", () => {
    expect(() => new KfCursor().eval([], 0)).toThrow();
  });
});

describe("upsertKf / removeKfNear / kfNear", () => {
  it("inserts in sorted order", () => {
    let k = upsertKf(undefined, 5, 1, EPS_KF);
    k = upsertKf(k, 1, 2, EPS_KF);
    k = upsertKf(k, 3, 3, EPS_KF);
    expect(k.map((x) => x.t)).toEqual([1, 3, 5]);
  });

  it("replaces a keyframe within eps (dedupe)", () => {
    const k0 = kfs([1, 10], [2, 20]);
    const k = upsertKf(k0, 1 + EPS_KF / 2, 99, EPS_KF);
    expect(k).toHaveLength(2);
    expect(k[0]!.v).toBe(99);
    expect(k0[0]!.v).toBe(10); // original untouched (new array)
  });

  it("inserts a distinct keyframe just outside eps", () => {
    const k = upsertKf(kfs([1, 10]), 1 + EPS_KF * 2, 20, EPS_KF);
    expect(k).toHaveLength(2);
  });

  it("removeKfNear drops within eps only", () => {
    const k = kfs([1, 1], [2, 2], [3, 3]);
    expect(removeKfNear(k, 2 + EPS_KF / 2, EPS_KF).map((x) => x.t)).toEqual([1, 3]);
    expect(removeKfNear(k, 2.5, EPS_KF)).toHaveLength(3);
  });

  it("kfNear returns the nearest within eps or null", () => {
    const k = kfs([1, 1], [2, 2]);
    expect(kfNear(k, 2 + EPS_KF / 2, EPS_KF)!.v).toBe(2);
    expect(kfNear(k, 2.5, EPS_KF)).toBeNull();
    expect(kfNear(undefined, 0, EPS_KF)).toBeNull();
  });
});

/** The strictly-ascending invariant that floorIndex / KfCursor binary-search on
 *  and clampedBreakpoints emits from. upsertKf used to break it by overwriting
 *  the FIRST match within eps in place: eps is half a source frame at 60fps,
 *  but adjacent frames are only `frameDuration * speed` apart in SOURCE
 *  seconds, so at the Speed dropdown's 0.25 and 0.5 the new t could land past
 *  the successor it was written in front of. */
describe("upsertKf keeps keyframes strictly ascending", () => {
  /** SOURCE time of timeline frame `n` for a clip trimmed from 0 at `speed`. */
  const srcT = (n: number, fps: number, speed: number): number => (n / fps) * speed;

  const isAscending = (k: Keyframe[]): boolean =>
    k.every((x, i) => i === 0 || x.t > k[i - 1]!.t);

  it("survives the frame 0 → 3 → 2 → 4 sequence at 60fps / speed 0.25", () => {
    // At 0.25x, 60fps frames are 1/240 s apart in source time while EPS_KF is
    // 1/120 — two frames fit inside the replace window, which is what let the
    // in-place overwrite cross its neighbour (captured trace: a descending
    // [0.01875, 0.0145833] pair).
    let k: Keyframe[] = [];
    let v = 1;
    for (const frame of [0, 3, 2, 4]) {
      k = upsertKf(k, srcT(frame, 60, 0.25), (v += 0.1), EPS_KF);
      expect(isAscending(k)).toBe(true);
    }
    expect(k[k.length - 1]!.t).toBeCloseTo(srcT(4, 60, 0.25), 12);
  });

  it("stays ascending over a dense random walk at every offered speed", () => {
    for (const speed of [0.25, 0.5, 1, 2, 4]) {
      let k: Keyframe[] = [];
      // deterministic pseudo-random frame order, revisiting the same few frames
      let seed = 7;
      for (let i = 0; i < 200; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const frame = seed % 12;
        k = upsertKf(k, srcT(frame, 60, speed), i, EPS_KF);
        expect(isAscending(k)).toBe(true);
      }
    }
  });

  it("replaces the NEAREST keyframe within eps, not the first one seen", () => {
    // t sits eps away from k[0] but only eps/4 away from k[1]: k[1] is the one
    // the user meant, and replacing k[0] would push it past k[1].
    const k0: Keyframe[] = [
      { t: 0, v: 0 },
      { t: EPS_KF * 0.75, v: 10 },
    ];
    const k = upsertKf(k0, EPS_KF, 99, EPS_KF);
    expect(k.map((x) => x.t)).toEqual([0, EPS_KF]);
    expect(k[1]!.v).toBe(99);
    expect(isAscending(k)).toBe(true);
  });

  it("leaves evalKfs interpolating (a descending pair clamped to the wrong end)", () => {
    let k: Keyframe[] = [];
    for (const [frame, value] of [
      [0, 1],
      [3, 4],
      [2, 3],
      [4, 5],
    ] as [number, number][]) {
      k = upsertKf(k, srcT(frame, 60, 0.25), value, EPS_KF);
    }
    const mid = (k[0]!.t + k[k.length - 1]!.t) / 2;
    const got = evalKfs(k, mid);
    const lo = Math.min(...k.map((x) => x.v));
    const hi = Math.max(...k.map((x) => x.v));
    expect(got).toBeGreaterThanOrEqual(lo);
    expect(got).toBeLessThanOrEqual(hi);
  });
});

/** An empty keyframe array can only arrive from outside: writeKeyframes strips
 *  them, but schema.rs types each track Option<Vec<Keyframe>> and deserializes
 *  `[]` happily — and `[]` is TRUTHY, so every consumer gate passes it to
 *  evalKfs, which throws and kills the editor mount. checkInvariants must
 *  refuse it. */
describe("empty keyframe arrays are an invariant violation", () => {
  const videoInfo: MediaInfo = {
    path: "C:\\media\\clip.mp4",
    size: 4096,
    mtimeMs: 11,
    kind: "video",
    duration: 30,
    fps: rat(30),
    width: 1280,
    height: 720,
    hasAudio: false,
  };

  it("checkInvariants flags a clip whose keyframe track is []", () => {
    let p = createProject("Shared");
    const added = addMedia(p, videoInfo);
    p = added.project;
    const clip = makeClip(added.media, 0);
    p = insertClip(p, p.timeline.tracks[0]!.id, clip);
    expect(checkInvariants(p)).toEqual([]);

    const empty = updateClip(p, clip.id, (c) => ({ ...c, keyframes: { opacity: [] } }));
    expect(checkInvariants(empty).some((e) => e.includes("empty array"))).toBe(true);

    // the paired x/y case too: both empty, both reported
    const emptyXY = updateClip(p, clip.id, (c) => ({ ...c, keyframes: { x: [], y: [] } }));
    expect(checkInvariants(emptyXY).filter((e) => e.includes("empty array"))).toHaveLength(2);
  });

  it("still accepts a populated keyframe track", () => {
    let p = createProject("Fine");
    const added = addMedia(p, videoInfo);
    p = added.project;
    const clip = makeClip(added.media, 0);
    p = insertClip(p, p.timeline.tracks[0]!.id, clip);
    const animated = updateClip(p, clip.id, (c) => ({
      ...c,
      keyframes: { opacity: [{ t: 0, v: 1 }, { t: 2, v: 0 }] },
    }));
    expect(checkInvariants(animated)).toEqual([]);
  });
});

describe("clampedBreakpoints", () => {
  it("always includes endpoints at tl=0 and tl=dur", () => {
    const k = kfs([0, 0], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 1);
    expect(bp[0]).toEqual({ tl: 0, v: 0 });
    expect(bp[bp.length - 1]).toEqual({ tl: 10, v: 100 });
  });

  it("ghost keyframes anchor endpoint values (clamped range)", () => {
    // range [2,8) inside a 0..10 ramp: endpoints interpolate to 20 and 80
    const k = kfs([0, 0], [10, 100]);
    const bp = clampedBreakpoints(k, 2, 8, 1);
    expect(bp[0]!.v).toBeCloseTo(20, 12);
    expect(bp[bp.length - 1]!.v).toBeCloseTo(80, 12);
  });

  it("maps interior keyframes to timeline-local time", () => {
    const k = kfs([0, 0], [5, 50], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 1);
    // endpoints + one interior at t=5 → tl=5
    expect(bp.map((b) => b.tl)).toEqual([0, 5, 10]);
    expect(bp[1]!.v).toBe(50);
  });

  it("halves tl at speed 2", () => {
    const k = kfs([0, 0], [5, 50], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 2); // dur = 5
    expect(bp.map((b) => b.tl)).toEqual([0, 2.5, 5]);
  });

  it("drops interior keyframes coincident with an endpoint", () => {
    // a keyframe exactly at srcIn/srcOut is excluded (endpoints cover it)
    const k = kfs([0, 0], [10, 100]);
    const bp = clampedBreakpoints(k, 0, 10, 1);
    expect(bp).toHaveLength(2);
    // an interior keyframe within 1e-9 of the start maps away
    const k2 = kfs([0, 0], [1e-10, 5], [10, 100]);
    const bp2 = clampedBreakpoints(k2, 0, 10, 1);
    expect(bp2).toHaveLength(2);
  });
});
