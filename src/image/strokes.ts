// Drawing strokes: the point codec, and the chunked, immutable stroke lists
// that keep unlimited undo linear in memory.
//
// A drawing is `chunks: Stroke[][]` of at most STROKE_CHUNK strokes each.
// Strokes are never mutated once built: history snapshots share them (and
// every untouched chunk) by reference, so appending a stroke copies only the
// chunk index plus the last chunk — O(STROKE_CHUNK + chunks.length) — however
// long the drawing already is.
//
// Points travel as base64 of little-endian Float32 triples [x, y, pressure]*.
// One point is 12 bytes, which is exactly 16 base64 characters with no
// padding, so a valid `p` is always a positive multiple of 16 characters and
// the Rust side can check its shape without decoding it.

import type { Stroke } from "../core/types";
export { STROKE_CHUNK } from "../core/types";

/** Bytes per point: three little-endian Float32s. */
const POINT_BYTES = 12;
/** Base64 characters per point (12 bytes → 16 chars, never padded). */
const POINT_CHARS = 16;
/** Bytes handed to one `String.fromCharCode` call when encoding. A multiple of
 *  3, so every piece encodes without padding and the pieces concatenate into
 *  one valid unpadded string; small enough to stay far under the engine's
 *  argument-count limit. */
const ENCODE_SLICE = 3 * 10920;
const BASE64_BODY = /^[A-Za-z0-9+/]+$/;

/** Encode [x, y, pressure]* points as unpadded base64 of Float32LE.
 *
 *  Throws (RangeError) unless `pts.length` is a positive multiple of 3 and
 *  every value is finite: a caller that gets here with NaN has a bug, and a
 *  stroke that could never be decoded again must not be committed. Pressure
 *  is CLAMPED into [0, 1] rather than refused — it is advisory, and the result
 *  must always be something `decodePoints` accepts. */
export function encodePoints(pts: Float32Array): string {
  if (pts.length === 0 || pts.length % 3 !== 0) {
    throw new RangeError(`a stroke needs whole [x, y, pressure] points, got ${pts.length} values`);
  }
  const bytes = new Uint8Array(pts.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pts.length; i++) {
    let v = pts[i]!;
    if (!Number.isFinite(v)) throw new RangeError("a stroke point is not a finite number");
    if (i % 3 === 2) v = Math.min(Math.max(v, 0), 1);
    view.setFloat32(i * 4, v, true);
  }
  let out = "";
  for (let at = 0; at < bytes.length; at += ENCODE_SLICE) {
    const piece = bytes.subarray(at, Math.min(at + ENCODE_SLICE, bytes.length));
    out += btoa(String.fromCharCode(...piece));
  }
  // Whole points are a multiple of 3 bytes, so btoa never padded; strip
  // defensively anyway — the stored form is defined as unpadded.
  return out.replace(/=+$/, "");
}

/** Decode a stroke's `p`, or null when it is not one: an alphabet outside
 *  [A-Za-z0-9+/] (padding included), a length of 0 or not a multiple of 16,
 *  any non-finite value, or a pressure outside [0, 1]. Total: never throws. */
export function decodePoints(b64: string): Float32Array | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length % POINT_CHARS !== 0) return null;
  if (!BASE64_BODY.test(b64)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length % POINT_BYTES !== 0) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return null;
    if (i % 3 === 2 && (v < 0 || v > 1)) return null;
    out[i] = v;
  }
  return out;
}

const decoded = new WeakMap<object, Float32Array>();
const EMPTY = new Float32Array(0);

/** Decoded points of an ink/erase stroke, cached by the (immutable, shared)
 *  stroke object, so every render and hit test decodes it once. A `p` that does
 *  not decode yields an EMPTY array rather than throwing — strokes are
 *  validated on load, so that is only reachable by a bug, and it must not take
 *  a render down with it. */
export function pointsOf(s: Extract<Stroke, { p: string }>): Float32Array {
  let pts = decoded.get(s);
  if (pts === undefined) {
    pts = decodePoints(s.p) ?? EMPTY;
    decoded.set(s, pts);
  }
  return pts;
}

/** Copies only the chunk index and the last chunk (O(STROKE_CHUNK + chunks.length)). */
export function appendStroke(chunks: readonly Stroke[][], s: Stroke): Stroke[][];
export function appendStroke(): never {
  throw new Error("not implemented");
}

/** Copies only chunks that lose a stroke; drops chunks that become empty. Same
 *  ref if nothing removed. */
export function removeStrokes(chunks: readonly Stroke[][], doomed: ReadonlySet<Stroke>): Stroke[][];
export function removeStrokes(): never {
  throw new Error("not implemented");
}

/** Total strokes across every chunk. */
export function strokeCount(chunks: readonly Stroke[][]): number {
  let n = 0;
  for (const c of chunks) n += c.length;
  return n;
}

/** Every stroke in paint order (chunk by chunk, oldest first). */
export function forEachStroke(
  chunks: readonly Stroke[][],
  fn: (s: Stroke, chunk: number, i: number) => void,
): void {
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    for (let i = 0; i < chunk.length; i++) fn(chunk[i]!, c, i);
  }
}

/** Structural + value validation of an untrusted stroke. Returns a clean
 *  Stroke or null. */
export function validateStroke(raw: unknown): Stroke | null;
export function validateStroke(): never {
  throw new Error("not implemented");
}
