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

import type { InkKind, ShapeKind, Stroke } from "../core/types";
import { STROKE_CHUNK } from "../core/types";
import { normalizeHexColor } from "../core/session";
export { STROKE_CHUNK };

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

/** Append one stroke. Copies only the chunk index and the last chunk
 *  (O(STROKE_CHUNK + chunks.length)): every other chunk array is shared with
 *  the previous snapshot, which is what keeps unlimited undo linear. A full
 *  last chunk is left untouched and a fresh one-stroke chunk is started. */
export function appendStroke(chunks: readonly Stroke[][], s: Stroke): Stroke[][] {
  const n = chunks.length;
  const last = n > 0 ? chunks[n - 1]! : null;
  let out: Stroke[][];
  if (last !== null && last.length < STROKE_CHUNK) {
    out = chunks.slice(0, n - 1);
    out.push(sealed([...last, s]));
  } else {
    out = chunks.slice();
    out.push(sealed([s]));
  }
  // Carry the running totals forward (one stroke more) rather than leave the
  // next budget check to rescan the whole drawing.
  const prev = totalsMemo.get(chunks);
  if (prev) totalsMemo.set(out, { strokes: prev.strokes + 1, points: prev.points + pointsIn(s) });
  return out;
}

/** Remove every stroke in `doomed`. Copies only the chunks that lose a stroke
 *  and drops chunks that become empty; untouched chunks are shared. Returns
 *  `chunks` itself (same reference) when nothing was removed, so an eraser
 *  pass that hit nothing records no undo step. */
export function removeStrokes(chunks: readonly Stroke[][], doomed: ReadonlySet<Stroke>): Stroke[][] {
  if (doomed.size === 0) return chunks as Stroke[][];
  let out: Stroke[][] | null = null;
  let goneStrokes = 0;
  let gonePoints = 0;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    let hit = false;
    for (const s of chunk) {
      if (doomed.has(s)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      out?.push(chunk);
      continue;
    }
    out ??= chunks.slice(0, c);
    const kept: Stroke[] = [];
    for (const s of chunk) {
      if (!doomed.has(s)) {
        kept.push(s);
        continue;
      }
      goneStrokes++;
      gonePoints += pointsIn(s);
    }
    if (kept.length > 0) out.push(sealed(kept));
  }
  if (out === null) return chunks as Stroke[][];
  const prev = totalsMemo.get(chunks);
  if (prev) totalsMemo.set(out, { strokes: prev.strokes - goneStrokes, points: prev.points - gonePoints });
  return out;
}

/** In a dev build, freeze each chunk this module creates, so a caller that
 *  mutates one in place — rewriting every history snapshot that shares it —
 *  throws in the tests instead of silently corrupting undo. A production build
 *  pays nothing. */
function sealed(chunk: Stroke[]): Stroke[] {
  return import.meta.env.DEV ? (Object.freeze(chunk) as Stroke[]) : chunk;
}

/** Strokes and points in one drawing: the two numbers the save check
 *  (`image_rules.rs`) sums over every drawing MediaRef and holds to
 *  MAX_TOTAL_STROKES / MAX_TOTAL_POINTS. */
export interface StrokeTotals {
  readonly strokes: number;
  readonly points: number;
}

/** Totals per chunks array. Chunk arrays are immutable snapshots, so an
 *  entry never goes stale; `appendStroke` and `removeStrokes` derive the new
 *  array's entry from the old one, so a stroke commit never rescans. */
const totalsMemo = new WeakMap<object, StrokeTotals>();

/** Points a stroke holds as the save check counts them: an ink or erase
 *  stroke's encoded points, none for a shape. */
function pointsIn(s: Stroke): number {
  return "p" in s ? pointCountOf(s.p) : 0;
}

/** `chunks`' totals: memoized by array identity, counted once for an array
 *  with no known parent (a loaded drawing), then carried forward by every
 *  append and erase. */
export function strokeTotals(chunks: readonly Stroke[][]): StrokeTotals {
  let t = totalsMemo.get(chunks);
  if (t === undefined) {
    let strokes = 0;
    let points = 0;
    for (const chunk of chunks) {
      strokes += chunk.length;
      for (const s of chunk) points += pointsIn(s);
    }
    t = { strokes, points };
    totalsMemo.set(chunks, t);
  }
  return t;
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

/* ------------------------------------------------------------------ */
/* Validation of untrusted strokes                                     */
/* ------------------------------------------------------------------ */

/** Crafted-file caps. The SAME three numbers are enforced on save by
 *  `validate_image_project` in src-tauri/src/project/image_rules.rs — change
 *  them together, or a project the editor accepts could never be saved. A
 *  hand-drawn stroke is a few hundred points and a heavy drawing a few hundred
 *  thousand, so none of these is a limit a person can reach by drawing. */
export const MAX_STROKE_POINTS = 1_000_000;
export const MAX_TOTAL_POINTS = 20_000_000;
export const MAX_TOTAL_STROKES = 2_000_000;

/** Widest nominal stroke accepted, in source px (the Rust rule too). */
const MAX_WIDTH = 65535;
/** Shape endpoints further than this from the layer origin are not a mark
 *  anyone drew: they are a crafted value on its way into a canvas path. */
const MAX_COORD = 1e7;

const INK: ReadonlySet<string> = new Set(["pen", "pencil", "marker"]);
const SHAPES: ReadonlySet<string> = new Set(["line", "rect", "ellipse", "arrow"]);

/** Points held by a `p` of this length, without decoding it. */
export function pointCountOf(p: string): number {
  return Math.floor(p.length / POINT_CHARS);
}

function validWidth(w: unknown): w is number {
  return typeof w === "number" && Number.isFinite(w) && w > 0 && w <= MAX_WIDTH;
}

function validPair(v: unknown): v is [number, number] {
  if (!Array.isArray(v) || v.length !== 2) return false;
  const x: unknown = v[0];
  const y: unknown = v[1];
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x) <= MAX_COORD &&
    Math.abs(y) <= MAX_COORD
  );
}

/** The opacity an ink stroke is drawn at when its own is missing or not a
 *  number: what the tool would have given it (pen 1, marker 0.4, pencil from
 *  its mean pressure). A bad `o` must not reach `globalAlpha` as-is — the
 *  canvas IGNORES a non-finite or out-of-range assignment and silently keeps
 *  whatever the previous stroke used. */
function defaultOpacity(t: string, pts: Float32Array): number {
  if (t === "pen") return 1;
  if (t === "marker") return 0.4;
  const n = pts.length / 3;
  let sum = 0;
  for (let i = 2; i < pts.length; i += 3) sum += pts[i]!;
  return 0.3 + 0.7 * (n > 0 ? sum / n : 1);
}

/** Decode a `p` for validation, refusing an oversized one BEFORE decoding it:
 *  the length alone says how many points it holds. */
function checkedPoints(p: unknown): Float32Array | null {
  if (typeof p !== "string" || pointCountOf(p) > MAX_STROKE_POINTS) return null;
  return decodePoints(p);
}

/** Structural + value validation of an untrusted stroke (a `.trt` is plain
 *  JSON, and the loader hands the image editor the raw value). Returns a clean
 *  Stroke, or null when it cannot be one. Total: never throws.
 *
 *  - `t` must be one of the eight kinds.
 *  - `c` (ink and shapes) goes through `normalizeHexColor`; an unreadable
 *    colour rejects the stroke.
 *  - `w` must be finite and in (0, 65535].
 *  - `o` (ink) is clamped into [0, 1]; a missing or non-numeric one takes the
 *    tool's own default.
 *  - `p` (ink and erase) must decode (`decodePoints`) and hold at most
 *    MAX_STROKE_POINTS points.
 *  - `a` / `b` (shapes) must be finite pairs within ±1e7.
 *
 *  Returns `raw` ITSELF when it is already exactly clean (nothing repaired, no
 *  extra key), so a healthy project keeps every stroke's identity — and with
 *  it every chunk's, which is what lets `validateImageProject` hand back the
 *  same project. The points decoded here are given to `pointsOf`'s cache for
 *  the object returned, so a load decodes each stroke once, not once here and
 *  again at the first render. */
export function validateStroke(raw: unknown): Stroke | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const t = o.t;
  if (typeof t !== "string" || !validWidth(o.w)) return null;
  const w = o.w;
  const keys = Object.keys(o).length;

  if (t === "erase") {
    const pts = checkedPoints(o.p);
    if (!pts) return null;
    const clean: Stroke = keys === 3 ? (raw as Stroke) : { t: "erase", w, p: o.p as string };
    decoded.set(clean, pts);
    return clean;
  }

  const c = normalizeHexColor(o.c, "");
  if (c === "") return null;

  if (INK.has(t)) {
    const pts = checkedPoints(o.p);
    if (!pts) return null;
    const rawO = o.o;
    const op =
      typeof rawO === "number" && Number.isFinite(rawO)
        ? Math.min(Math.max(rawO, 0), 1)
        : defaultOpacity(t, pts);
    const clean: Stroke =
      keys === 5 && c === o.c && op === rawO
        ? (raw as Stroke)
        : { t: t as InkKind, c, w, o: op, p: o.p as string };
    decoded.set(clean, pts);
    return clean;
  }

  if (SHAPES.has(t)) {
    const a = o.a;
    const b = o.b;
    if (!validPair(a) || !validPair(b)) return null;
    if (keys === 5 && c === o.c) return raw as Stroke;
    return { t: t as ShapeKind, c, w, a: [a[0], a[1]], b: [b[0], b[1]] };
  }

  return null;
}
