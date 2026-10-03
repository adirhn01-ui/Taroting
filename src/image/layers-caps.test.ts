// The crafted-file stroke caps in validateImageProject — and the editor's own
// refusal to build a project past them (a stroke, a Duplicate) — exercised at
// small numbers: the real caps (2 000 000 strokes, 20 000 000 points) cannot
// be reached in a unit test without hundreds of MB of fixture. The two TOTAL
// caps and the per-stroke cap are shrunk for layers.ts only (strokes.ts keeps
// its own binding); strokes.test.ts pins the real values.

import { describe, expect, it, vi } from "vitest";

vi.mock("./strokes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./strokes")>()),
  MAX_TOTAL_STROKES: 5,
  MAX_TOTAL_POINTS: 9,
  // Below the point cap on purpose, so a stroke can break this cap alone.
  MAX_STROKE_POINTS: 6,
}));

import type { MediaRef, ProjectFile, Stroke, Track } from "../core/types";
import { createBlankImageProject } from "../core/image-project";
import {
  addDrawingLayer,
  appendStrokeTo,
  drawingTotals,
  duplicateLayer,
  duplicateRefusal,
  eraseStrokes,
  findLayer,
  layersOf,
  strokeRefusal,
  validateImageProject,
} from "./layers";
import { appendStroke, encodePoints, removeStrokes, strokeTotals } from "./strokes";

/** An ink stroke of `n` points. */
const ink = (n: number, x = 0): Stroke => ({
  t: "pen",
  c: "#223344",
  w: 2,
  o: 1,
  p: encodePoints(new Float32Array(Array.from({ length: n }, (_, i) => [x + i, i, 0.5]).flat())),
});
const shape = (x: number): Stroke => ({ t: "line", c: "#223344", w: 2, a: [x, 0], b: [x, 9] });
const chunksOf = (m: MediaRef): Stroke[][] => (m.generator as { chunks: Stroke[][] }).chunks;

/** A drawing layer holding `strokes`, built straight into the MediaRef — the
 *  shape a crafted or old file can arrive in, which the editor itself would
 *  refuse to build past the caps. */
function drawing(strokes: Stroke[]): { p: ProjectFile; trackId: string } {
  const d = addDrawingLayer(createBlankImageProject("Caps", 300, 200, "transparent"));
  let chunks: Stroke[][] = [];
  for (const s of strokes) chunks = appendStroke(chunks, s);
  const p: ProjectFile = {
    ...d.project,
    media: d.project.media.map((m) => ({ ...m, generator: { type: "drawing", chunks } })),
  };
  return { p, trackId: d.trackId };
}

/** What an old Duplicate made with no budget check: a second MediaRef
 *  sharing the drawing's chunks, on a track of its own above it. */
function craftedDuplicate(p: ProjectFile, trackId: string): ProjectFile {
  const l = findLayer(p, trackId)!;
  const media: MediaRef = { ...l.media, id: "dup-media" };
  const track: Track = { ...p.timeline.tracks[0]!, id: "dup-track", clips: [{ ...l.clip, id: "dup-clip", mediaId: media.id }] };
  return { ...p, media: [...p.media, media], timeline: { ...p.timeline, tracks: [track, ...p.timeline.tracks] } };
}

describe("validateImageProject crafted-file caps", () => {
  it("keeps strokes up to the point cap and drops every stroke from the first one over it", () => {
    // 4 + 5 points is exactly the cap (9) and fits; one more point is over.
    // The shape after it has no points, but nothing after the cut is kept.
    const kept = [ink(4), ink(5, 50)];
    const { p } = drawing([...kept, ink(1, 90), shape(5)]);
    const out = validateImageProject(p);
    expect(chunksOf(out.project.media[0]!)).toEqual([kept]);
    expect(out.droppedStrokes).toBe(2);
    expect(out.notes).toEqual(["Skipped 2 strokes over the drawing size limit."]);
  });

  it("holds the stroke count to its cap, and a within-cap drawing is untouched", () => {
    const shapes = [1, 2, 3, 4, 5, 6, 7].map(shape);
    const out = validateImageProject(drawing(shapes).p);
    expect(chunksOf(out.project.media[0]!)).toEqual([shapes.slice(0, 5)]);
    expect(out.droppedStrokes).toBe(2);
    const fits = drawing(shapes.slice(0, 5)).p;
    expect(validateImageProject(fits).project).toBe(fits);
  });

  it("counts a duplicated drawing again, as the save check does", () => {
    const { p, trackId } = drawing([shape(1), shape(2), shape(3)]);
    const dup = craftedDuplicate(p, trackId); // 3 + 3 shared strokes = 6 > 5
    const out = validateImageProject(dup);
    const counts = out.project.media.map((m) => chunksOf(m).flat().length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(out.droppedStrokes).toBe(1);
    expect(layersOf(out.project)).toHaveLength(2);
  });
});

describe("the editor never builds a project the save check refuses", () => {
  // Rust refuses EVERY save of a project past the caps (autosave included)
  // with only "Save failed", so the editor refuses the edit instead.

  it("a stroke that would cross the stroke cap is not appended, and says why", () => {
    const { p, trackId } = drawing([shape(1), shape(2), shape(3), shape(4)]);
    const fifth = appendStrokeTo(p, trackId, shape(5)); // 5 == cap: fits
    expect(fifth).not.toBe(p);
    expect(strokeRefusal(fifth, shape(6))).toBe(
      "The drawings in this image are at their size limit, so the stroke wasn't added.",
    );
    expect(appendStrokeTo(fifth, trackId, shape(6))).toBe(fifth);
    expect(validateImageProject(fifth).droppedStrokes).toBe(0);
  });

  it("a stroke that would cross the point cap is refused even under the stroke cap", () => {
    // 4 + 5 = 9 points is the cap; 2 strokes is far under the stroke cap.
    const { p, trackId } = drawing([ink(4)]);
    const at = appendStrokeTo(p, trackId, ink(5, 40));
    expect(drawingTotals(at)).toEqual({ strokes: 2, points: 9 });
    // A shape holds no points: it still fits.
    expect(strokeRefusal(at, shape(1))).toBeNull();
    expect(appendStrokeTo(at, trackId, ink(1, 80))).toBe(at);
  });

  it("a stroke longer than one stroke may be is refused on its own, with room left in the drawing", () => {
    // 7 points: over the per-stroke cap (6), under the project point cap (9)
    // on an empty drawing — so only the per-stroke check can refuse it.
    const { p, trackId } = drawing([]);
    expect(drawingTotals(p)).toEqual({ strokes: 0, points: 0 });
    expect(strokeRefusal(p, ink(7))).toBe("This stroke is too long to keep. Draw it in shorter pieces.");
    expect(appendStrokeTo(p, trackId, ink(7))).toBe(p);
    // At the cap exactly, the same drawing takes it.
    expect(strokeRefusal(p, ink(6))).toBeNull();
    expect(drawingTotals(appendStrokeTo(p, trackId, ink(6)))).toEqual({ strokes: 1, points: 6 });
  });

  it("the caps are project-wide: a stroke on one drawing counts another's strokes", () => {
    const { p } = drawing([shape(1), shape(2), shape(3)]);
    const second = addDrawingLayer(p);
    let q = appendStrokeTo(second.project, second.trackId, shape(4));
    q = appendStrokeTo(q, second.trackId, shape(5));
    expect(drawingTotals(q).strokes).toBe(5);
    expect(appendStrokeTo(q, second.trackId, shape(6))).toBe(q);
  });

  it("Duplicate refuses a drawing whose copy would cross a cap, and allows one that fits", () => {
    const small = drawing([shape(1), shape(2)]);
    expect(duplicateRefusal(small.p, small.trackId)).toBeNull();
    const two = duplicateLayer(small.p, small.trackId);
    expect(layersOf(two.project)).toHaveLength(2);
    expect(drawingTotals(two.project).strokes).toBe(4); // the shared array counts twice
    const big = drawing([shape(1), shape(2), shape(3)]);
    expect(duplicateRefusal(big.p, big.trackId)).toBe("This drawing is too large to duplicate.");
    const refused = duplicateLayer(big.p, big.trackId);
    expect(refused.project).toBe(big.p);
    expect(refused.trackId).toBe(big.trackId);
  });

  it("the totals follow appends and erases without rescanning, and match a fresh count", () => {
    const { p, trackId } = drawing([ink(2), shape(1)]);
    const chunks0 = (findLayer(p, trackId)!.media.generator as { chunks: Stroke[][] }).chunks;
    expect(strokeTotals(chunks0)).toEqual({ strokes: 2, points: 2 });
    const a = appendStrokeTo(p, trackId, ink(3, 20));
    const chunks1 = (findLayer(a, trackId)!.media.generator as { chunks: Stroke[][] }).chunks;
    // Carried forward from the parent's entry: equal to a count from scratch.
    expect(strokeTotals(chunks1)).toEqual({ strokes: 3, points: 5 });
    const fresh = chunks1.map((c) => c.slice());
    expect(strokeTotals(fresh)).toEqual(strokeTotals(chunks1));
    const doomed = chunks1[0]![0]!; // the 2-point ink
    const e = eraseStrokes(a, new Map([[trackId, new Set([doomed])]]));
    const chunks2 = (findLayer(e, trackId)!.media.generator as { chunks: Stroke[][] }).chunks;
    expect(strokeTotals(chunks2)).toEqual({ strokes: 2, points: 3 });
  });
});

describe("stroke totals are carried, not recounted", () => {
  /** An ink stroke whose `p` counts its reads: a rescan reads every stroke. */
  function counted(n: number, reads: { n: number }): Stroke {
    const p = (ink(n) as Extract<Stroke, { p: string }>).p;
    const s = { t: "pen", c: "#223344", w: 2, o: 1 } as Stroke;
    Object.defineProperty(s, "p", { enumerable: true, get: () => (reads.n++, p) });
    return s;
  }

  it("an append and an erase derive the new totals from the old ones", () => {
    const reads = { n: 0 };
    const old = [counted(2, reads), counted(3, reads), counted(4, reads)];
    let chunks: Stroke[][] = [];
    for (const s of old) chunks = appendStroke(chunks, s);
    expect(strokeTotals(chunks)).toEqual({ strokes: 3, points: 9 }); // the one full count
    reads.n = 0;
    const next = appendStroke(chunks, ink(1));
    expect(strokeTotals(next)).toEqual({ strokes: 4, points: 10 });
    expect(reads.n).toBe(0); // no earlier stroke was read again
    const erased = removeStrokes(next, new Set([old[1]!]));
    expect(strokeTotals(erased)).toEqual({ strokes: 3, points: 7 });
    expect(reads.n).toBe(1); // only the erased stroke itself
  });
});
