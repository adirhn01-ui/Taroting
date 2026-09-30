// The crafted-file stroke caps in validateImageProject, exercised at small
// numbers: the real caps (2 000 000 strokes, 20 000 000 points) cannot be
// reached in a unit test without hundreds of MB of fixture. Only the two
// TOTAL caps are shrunk; strokes.test.ts pins the real values.

import { describe, expect, it, vi } from "vitest";

vi.mock("./strokes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./strokes")>()),
  MAX_TOTAL_STROKES: 5,
  MAX_TOTAL_POINTS: 9,
}));

import type { MediaRef, ProjectFile, Stroke } from "../core/types";
import { createBlankImageProject } from "../core/image-project";
import { addDrawingLayer, appendStrokeTo, duplicateLayer, layersOf, validateImageProject } from "./layers";
import { encodePoints } from "./strokes";

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

function drawing(strokes: Stroke[]): { p: ProjectFile; trackId: string } {
  const d = addDrawingLayer(createBlankImageProject("Caps", 300, 200, "transparent"));
  let p = d.project;
  for (const s of strokes) p = appendStrokeTo(p, d.trackId, s);
  return { p, trackId: d.trackId };
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
    const dup = duplicateLayer(p, trackId).project; // 3 + 3 shared strokes = 6 > 5
    const out = validateImageProject(dup);
    const counts = out.project.media.map((m) => chunksOf(m).flat().length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(out.droppedStrokes).toBe(1);
    expect(layersOf(out.project)).toHaveLength(2);
  });
});
