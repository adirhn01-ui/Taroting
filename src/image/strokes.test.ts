import { describe, expect, it } from "vitest";
import type { Stroke } from "../core/types";
import {
  appendStroke,
  decodePoints,
  encodePoints,
  forEachStroke,
  MAX_STROKE_POINTS,
  MAX_TOTAL_POINTS,
  MAX_TOTAL_STROKES,
  pointCountOf,
  pointsOf,
  removeStrokes,
  STROKE_CHUNK,
  strokeCount,
  validateStroke,
} from "./strokes";

const pts = (...xyp: number[]): string => encodePoints(new Float32Array(xyp));

/** Base64 of raw little-endian Float32s, bypassing encodePoints's checks, so
 *  a test can hand the decoder values the encoder refuses to write. */
function rawB64(...vals: number[]): string {
  const bytes = new Uint8Array(vals.length * 4);
  const dv = new DataView(bytes.buffer);
  vals.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

const pen = (i: number): Stroke => ({ t: "pen", c: "#112233", w: 3 + i, o: 1, p: pts(i, -i, 0.5) });

/** n appended strokes, plus every intermediate snapshot's chunks. */
function build(n: number): Stroke[][] {
  let chunks: Stroke[][] = [];
  for (let i = 0; i < n; i++) chunks = appendStroke(chunks, pen(i));
  return chunks;
}

describe("point codec", () => {
  it("round-trips values that differ in sign, magnitude and pressure", () => {
    const src = [1.5, -2.25, 0.5, 1e6, 3, 1];
    const p = pts(...src);
    expect(p).toHaveLength(32);
    expect(p).not.toContain("=");
    expect(Array.from(decodePoints(p)!)).toEqual(src);
  });

  it("refuses short, padded, off-alphabet, NaN and out-of-range-pressure input", () => {
    expect(decodePoints("AAAA")).toBeNull();
    expect(decodePoints("AAAAAAAAAAAAAAA=")).toBeNull();
    expect(decodePoints("@")).toBeNull();
    expect(decodePoints("")).toBeNull();
    const nan = rawB64(1, NaN, 0.5);
    expect(nan).toHaveLength(16);
    expect(decodePoints(nan)).toBeNull();
    const hot = rawB64(1, 2, 1.5);
    expect(decodePoints(hot)).toBeNull();
    // The same shape with a legal pressure decodes — so the two above fail for
    // the value, not the framing.
    expect(decodePoints(rawB64(1, 2, 1))).not.toBeNull();
  });

  it("the encoder refuses what could never be decoded, and clamps pressure", () => {
    expect(() => encodePoints(new Float32Array([1, 2]))).toThrow(RangeError);
    expect(() => encodePoints(new Float32Array([]))).toThrow(RangeError);
    expect(() => encodePoints(new Float32Array([1, NaN, 0]))).toThrow(RangeError);
    expect(Array.from(decodePoints(pts(4, 5, 7))!)).toEqual([4, 5, 1]);
    expect(pointCountOf(pts(1, 2, 0, 3, 4, 1, 5, 6, 0.5))).toBe(3);
  });
});

describe("chunked strokes", () => {
  it("600 appends make chunks of 256, 256 and 88", () => {
    expect(STROKE_CHUNK).toBe(256);
    const chunks = build(600);
    expect(chunks.map((c) => c.length)).toEqual([256, 256, 88]);
    expect(strokeCount(chunks)).toBe(600);
  });

  it("an append shares every chunk but the last with the previous snapshot (linear undo)", () => {
    const before = build(600);
    const after = appendStroke(before, pen(600));
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[2]).toHaveLength(89);
    expect(before[2]).toHaveLength(88); // the old snapshot is untouched
  });

  it("a full last chunk is kept whole and a new one started", () => {
    const full = build(256);
    const next = appendStroke(full, pen(999));
    expect(next.map((c) => c.length)).toEqual([256, 1]);
    expect(next[0]).toBe(full[0]);
  });

  it("chunks it builds are frozen in a dev build, so in-place mutation throws", () => {
    const chunks = build(3);
    expect(Object.isFrozen(chunks[0])).toBe(true);
    expect(() => (chunks[0] as Stroke[]).push(pen(9))).toThrow(TypeError);
  });

  it("removeStrokes copies only the chunk that loses a stroke", () => {
    const chunks = build(600);
    const doomed = chunks[1]![7]!;
    const out = removeStrokes(chunks, new Set([doomed]));
    expect(out[0]).toBe(chunks[0]);
    expect(out[2]).toBe(chunks[2]);
    expect(out[1]).not.toBe(chunks[1]);
    expect(out[1]).toHaveLength(255);
    expect(out[1]).not.toContain(doomed);
    expect(strokeCount(out)).toBe(599);
  });

  it("removeStrokes drops a chunk that empties, and is the same reference when nothing goes", () => {
    const chunks = build(300); // 256 + 44
    const out = removeStrokes(chunks, new Set(chunks[1]));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(chunks[0]);
    expect(removeStrokes(chunks, new Set([pen(1)]))).toBe(chunks); // equal but not the same object
    expect(removeStrokes(chunks, new Set())).toBe(chunks);
  });

  it("forEachStroke visits in paint order with chunk and index", () => {
    const chunks = build(258);
    const seen: string[] = [];
    forEachStroke(chunks, (s, c, i) => {
      if (i === 0 || i === 255 || c === 1) seen.push(`${c}:${i}:${s.w}`);
    });
    expect(seen).toEqual(["0:0:3", "0:255:258", "1:0:259", "1:1:260"]);
  });
});

describe("validateStroke", () => {
  const P = pts(10, 20, 0.2, 30, 40, 0.6);

  it("returns a clean stroke itself, for every kind", () => {
    const clean: Stroke[] = [
      { t: "pen", c: "#0a1b2c", w: 4, o: 1, p: P },
      { t: "pencil", c: "#3a3a3a", w: 2, o: 0.58, p: P },
      { t: "marker", c: "#ffd400", w: 18, o: 0.4, p: P },
      { t: "erase", w: 16, p: P },
      { t: "arrow", c: "#e5484d", w: 4, a: [-5, 7], b: [300, 12] },
    ];
    for (const s of clean) expect(validateStroke(s), s.t).toBe(s);
  });

  it("refuses each broken field on its own", () => {
    const ok = { t: "pen", c: "#0a1b2c", w: 4, o: 1, p: P };
    expect(validateStroke(ok)).toBe(ok);
    for (const [why, bad] of [
      ["kind", { ...ok, t: "brush" }],
      ["colour", { ...ok, c: "#12345g" }],
      ["no colour", { t: "pen", w: 4, o: 1, p: P }],
      ["width 0", { ...ok, w: 0 }],
      ["width NaN", { ...ok, w: NaN }],
      ["width too wide", { ...ok, w: 65536 }],
      ["width a string", { ...ok, w: "4" }],
      ["points", { ...ok, p: "@@@@@@@@@@@@@@@@" }],
      ["points length", { ...ok, p: P.slice(0, 15) }],
      ["erase without points", { t: "erase", w: 4 }],
      ["shape end", { t: "line", c: "#0a1b2c", w: 4, a: [0, 0], b: [0, Infinity] }],
      ["shape far", { t: "rect", c: "#0a1b2c", w: 4, a: [0, 0], b: [1e7 + 1, 0] }],
      ["shape pair", { t: "ellipse", c: "#0a1b2c", w: 4, a: [0, 0, 0], b: [1, 1] }],
      ["null", null],
      ["array", [ok]],
    ] as const) {
      expect(validateStroke(bad), why).toBeNull();
    }
    // The widest legal values pass, so the rejections above are the edges.
    expect(validateStroke({ ...ok, w: 65535 })).not.toBeNull();
    expect(validateStroke({ t: "rect", c: "#0a1b2c", w: 4, a: [0, 0], b: [1e7, -1e7] })).not.toBeNull();
  });

  it("repairs what has an honest reading, into a fresh object", () => {
    const upper = { t: "pen", c: "#ABC", w: 4, o: 1, p: P };
    const fixed = validateStroke(upper)!;
    expect(fixed).not.toBe(upper);
    expect(fixed).toEqual({ t: "pen", c: "#aabbcc", w: 4, o: 1, p: P });

    expect(validateStroke({ t: "marker", c: "#ffd400", w: 18, o: 1.5, p: P })).toMatchObject({ o: 1 });
    expect(validateStroke({ t: "marker", c: "#ffd400", w: 18, o: -2, p: P })).toMatchObject({ o: 0 });
    // A missing opacity takes the tool's own: pen 1, marker 0.4, pencil from
    // mean pressure (0.2 and 0.6 → 0.4 → 0.3 + 0.7·0.4).
    expect(validateStroke({ t: "pen", c: "#000000", w: 4, p: P })).toMatchObject({ o: 1 });
    expect(validateStroke({ t: "marker", c: "#000000", w: 4, o: "x", p: P })).toMatchObject({ o: 0.4 });
    expect((validateStroke({ t: "pencil", c: "#000000", w: 4, p: P }) as { o: number }).o).toBeCloseTo(0.58, 6);

    // Keys the stroke kind does not have are shed, not carried into a save.
    const erase = validateStroke({ t: "erase", w: 16, p: P, c: "#ffffff" });
    expect(erase).toEqual({ t: "erase", w: 16, p: P });
    const shape = validateStroke({ t: "line", c: "#0A1B2C", w: 4, a: [1, 2], b: [3, 4], extra: 1 });
    expect(shape).toEqual({ t: "line", c: "#0a1b2c", w: 4, a: [1, 2], b: [3, 4] });
  });

  it("primes pointsOf with the points it decoded", () => {
    const fixed = validateStroke({ t: "pen", c: "#ABC", w: 4, o: 1, p: P }) as Extract<Stroke, { p: string }>;
    const first = pointsOf(fixed);
    expect(Array.from(first)).toEqual(Array.from(decodePoints(P)!));
    expect(pointsOf(fixed)).toBe(first);
  });

  it("refuses a stroke over the per-stroke point cap without decoding it", () => {
    // MAX + 1 all-zero points: every one of them decodes, so only the cap can
    // refuse this.
    const p = "A".repeat((MAX_STROKE_POINTS + 1) * 16);
    const started = performance.now();
    expect(validateStroke({ t: "erase", w: 4, p })).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("keeps the crafted-file caps in step with image_rules.rs", () => {
    // Same three numbers as validate_image_project in
    // src-tauri/src/project/image_rules.rs: a mismatch lets the editor keep a
    // drawing that the save then refuses, forever.
    expect([MAX_STROKE_POINTS, MAX_TOTAL_POINTS, MAX_TOTAL_STROKES]).toEqual([
      1_000_000, 20_000_000, 2_000_000,
    ]);
  });
});
