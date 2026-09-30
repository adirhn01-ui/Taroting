import { describe, expect, it } from "vitest";
import type { Clip, ClipTransform, MediaInfo, MediaRef, ProjectFile, Stroke, Track } from "../core/types";
import { createBlankImageProject, createPhotoImageProject } from "../core/image-project";
import { checkInvariants, defaultAudio } from "../core/project";
import { encodePoints, strokeCount } from "./strokes";
import { layerCorners } from "./geom";
import {
  addDrawingLayer,
  addGeneratorLayer,
  addPhotoLayer,
  appendStrokeTo,
  cropImage,
  drawingTarget,
  duplicateLayer,
  eraseStrokes,
  findLayer,
  flipImage,
  layersOf,
  moveLayer,
  removeLayer,
  renameLayer,
  resizeCanvas,
  rotateImage,
  setBackground,
  setLayerAdjust,
  setLayerHidden,
  setLayerTransform,
  validateImageProject,
  type Layer,
} from "./layers";

const W = 641;
const H = 361;

const photo = (w = 200, h = 100, path = "C:\\pics\\Cat on mat.jpg"): MediaInfo => ({
  path,
  size: 4321,
  mtimeMs: 7,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
  oriented: true,
});

const blank = (w = W, h = H): ProjectFile => createBlankImageProject("Img", w, h, "#ffffff");
const clean = (p: ProjectFile): void => expect(checkInvariants(p)).toEqual([]);
const pen = (x: number, y: number, c = "#112233"): Stroke => ({
  t: "pen",
  c,
  w: 5,
  o: 1,
  p: encodePoints(new Float32Array([x, y, 0.5, x + 3, y + 4, 0.75])),
});
const ids = (p: ProjectFile): string[] => layersOf(p).map((l) => l.name);
const drawingChunks = (l: Layer): Stroke[][] =>
  (l.media.generator as Extract<MediaRef["generator"], { type: "drawing" }>).chunks;

/** Photo (cropped, rotated, flipped) under a drawing layer with its own pose:
 *  every axis of the image-level maths gets a different number. */
function posed(): { p: ProjectFile; photoId: string; drawId: string } {
  let p = blank();
  const a = addPhotoLayer(p, photo());
  p = setLayerTransform(a.project, a.trackId, {
    x: 37,
    y: -19,
    scale: 0.73,
    rotate: 90,
    flipH: true,
    crop: { x: 10, y: 5, w: 150, h: 80 },
  });
  const d = addDrawingLayer(p);
  p = setLayerTransform(d.project, d.trackId, { x: -50, y: 22, rotate: 180, flipV: true, scale: 1.3 });
  return { p, photoId: a.trackId, drawId: d.trackId };
}

const transformOf = (p: ProjectFile, trackId: string): ClipTransform => findLayer(p, trackId)!.transform;

describe("layersOf", () => {
  it("lists one-clip video tracks top first, with kind and name, skipping the empty placeholder", () => {
    let p = blank();
    expect(layersOf(p)).toEqual([]);
    p = addPhotoLayer(p, photo()).project;
    p = addGeneratorLayer(p, { type: "solid", color: "#336699" }, W, H, "Solid #336699").project;
    p = addDrawingLayer(p).project;
    const layers = layersOf(p);
    expect(layers.map((l) => [l.index, l.kind, l.name])).toEqual([
      [0, "drawing", "Drawing 1"],
      [1, "solid", "Solid"],
      [2, "photo", "Cat on mat"],
    ]);
    expect(p.timeline.tracks).toHaveLength(3); // the placeholder is gone
    clean(p);
  });

  it("is memoized on (timeline, media) identity, and a stroke replaces it", () => {
    const { p, drawId } = posed();
    expect(layersOf(p)).toBe(layersOf(p));
    expect(layersOf({ ...p })).toBe(layersOf(p)); // same timeline + media
    const q = appendStrokeTo(p, drawId, pen(1, 2));
    expect(q.timeline).toBe(p.timeline);
    expect(layersOf(q)).not.toBe(layersOf(p));
  });
});

describe("adding layers", () => {
  it("a drawing layer covers the canvas at scale 1, and names count up", () => {
    const a = addDrawingLayer(blank());
    const l = findLayer(a.project, a.trackId)!;
    expect(l.media).toMatchObject({ kind: "image", path: "Drawing", width: W, height: H });
    expect(l.media.generator).toEqual({ type: "drawing", chunks: [] });
    expect(l.transform).toMatchObject({ scale: 1, x: 0, y: 0, rotate: 0 });
    expect(l.clip).toMatchObject({ timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1 });
    const b = addDrawingLayer(renameLayer(a.project, a.trackId, "Drawing 2"));
    expect(findLayer(b.project, b.trackId)!.name).toBe("Drawing 3");
    clean(b.project);
  });

  it("inserts directly above `above`, and at the top without one", () => {
    let p = blank();
    const bottom = addPhotoLayer(p, photo(10, 10, "C:\\a\\bottom.png"));
    const top = addPhotoLayer(bottom.project, photo(10, 10, "C:\\a\\top.png"));
    const mid = addDrawingLayer(top.project, { above: bottom.trackId });
    expect(ids(mid.project)).toEqual(["top", "Drawing 1", "bottom"]);
    const up = addDrawingLayer(mid.project, { above: "no such track" });
    expect(ids(up.project)[0]).toBe("Drawing 2");
    p = up.project;
    clean(p);
  });

  it("a photo sits at native pixels, scaled down only to fit, never up", () => {
    const big = addPhotoLayer(blank(), photo(1282, 300));
    expect(findLayer(big.project, big.trackId)!.transform.scale).toBe(0.5);
    const tall = addPhotoLayer(blank(), photo(100, 1444));
    expect(findLayer(tall.project, tall.trackId)!.transform.scale).toBe(0.25);
    const small = addPhotoLayer(blank(), photo(36, 64));
    const l = findLayer(small.project, small.trackId)!;
    expect(l.transform.scale).toBe(1);
    expect(l.media).toMatchObject({ width: 36, height: 64, oriented: true, path: "C:\\pics\\Cat on mat.jpg" });
    expect(l.media.id).not.toBe("");
  });

  it("refuses anything that is not a still", () => {
    expect(() => addPhotoLayer(blank(), { ...photo(), kind: "video" })).toThrow();
    expect(() => addPhotoLayer(blank(), { ...photo(), generator: { type: "solid", color: "#000000" } })).toThrow();
  });

  it("text and solid layers keep their box and label, named for their kind", () => {
    const gen = { type: "text", text: "Hi", fontFamily: "Arial", sizePx: 40, color: "#ffffff", bold: false, italic: true } as const;
    const t = addGeneratorLayer(blank(), gen, 94, 50, "Text — Hi");
    const l = findLayer(t.project, t.trackId)!;
    expect([l.kind, l.name, l.media.path, l.media.width, l.media.height]).toEqual(["text", "Text", "Text — Hi", 94, 50]);
    const s = addGeneratorLayer(blank(), { type: "solid", color: "#123456" }, 0, NaN, "Solid #123456");
    expect(findLayer(s.project, s.trackId)!.media).toMatchObject({ width: W, height: H });
  });
});

describe("removing, moving, hiding, renaming, duplicating", () => {
  it("removeLayer drops the clip and its media; the last one leaves an empty track", () => {
    const { p, photoId, drawId } = posed();
    const one = removeLayer(p, drawId);
    expect(ids(one)).toEqual(["Cat on mat"]);
    expect(one.media).toHaveLength(1);
    const none = removeLayer(setLayerHidden(one, photoId, true), photoId);
    expect(none.media).toEqual([]);
    expect(none.timeline.tracks).toEqual([{ id: photoId, kind: "video", name: "Cat on mat", muted: false, clips: [] }]);
    clean(none);
    expect(removeLayer(none, photoId)).toBe(none);
    expect(removeLayer(p, "nope")).toBe(p);
  });

  it("moveLayer reorders by layer index, clamps, and is a no-op in place", () => {
    let p = blank();
    for (const n of ["c", "b", "a"]) p = addPhotoLayer(p, photo(10, 10, `C:\\x\\${n}.png`)).project;
    const [a, b, c] = layersOf(p).map((l) => l.trackId);
    expect(ids(p)).toEqual(["a", "b", "c"]);
    expect(moveLayer(p, b!, 1)).toBe(p);
    expect(moveLayer(p, "nope", 0)).toBe(p);
    expect(ids(moveLayer(p, a!, 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveLayer(p, c!, 0))).toEqual(["c", "a", "b"]);
    expect(ids(moveLayer(p, a!, 99))).toEqual(["b", "c", "a"]);
    expect(ids(moveLayer(p, c!, -5))).toEqual(["c", "a", "b"]);
    clean(moveLayer(p, a!, 2));
  });

  it("hidden is written as true and DELETED when shown again, never false", () => {
    const { p, photoId } = posed();
    const hid = setLayerHidden(p, photoId, true);
    expect(findLayer(hid, photoId)!.hidden).toBe(true);
    expect(hid.timeline.tracks.find((t) => t.id === photoId)!.hidden).toBe(true);
    expect(setLayerHidden(hid, photoId, true)).toBe(hid);
    const shown = setLayerHidden(hid, photoId, false);
    expect("hidden" in shown.timeline.tracks.find((t) => t.id === photoId)!).toBe(false);
    expect(setLayerHidden(p, photoId, false)).toBe(p);
  });

  it("renameLayer trims and refuses empty or unchanged names", () => {
    const { p, photoId } = posed();
    expect(ids(renameLayer(p, photoId, "  Sky  "))).toContain("Sky");
    expect(renameLayer(p, photoId, "   ")).toBe(p);
    expect(renameLayer(p, photoId, "Cat on mat")).toBe(p);
  });

  it("duplicateLayer makes new track, clip and media ids, directly above, sharing strokes", () => {
    const { p: base, drawId } = posed();
    const p = appendStrokeTo(base, drawId, pen(4, 5));
    const d = duplicateLayer(p, drawId);
    const src = findLayer(d.project, drawId)!;
    const dup = findLayer(d.project, d.trackId)!;
    expect(dup.index).toBe(src.index - 1);
    expect(dup.name).toBe("Drawing 1 copy");
    expect(new Set([dup.trackId, dup.clipId, dup.mediaId]).has(src.trackId)).toBe(false);
    expect(dup.clipId).not.toBe(src.clipId);
    expect(dup.mediaId).not.toBe(src.mediaId);
    expect(drawingChunks(dup)).toBe(drawingChunks(src));
    expect(dup.transform).toEqual(src.transform);
    clean(d.project);

    const only = createPhotoImageProject("One", photo());
    const [l] = layersOf(only);
    const two = duplicateLayer(only, l!.trackId);
    expect(layersOf(two.project)).toHaveLength(2);
    expect(two.project.media).toHaveLength(2);
    expect(duplicateLayer(only, "nope").project).toBe(only);
  });
});

describe("transform and adjustments", () => {
  it("setLayerTransform patches, removes a crop on `crop: undefined`, and is a no-op when equal", () => {
    const { p, photoId } = posed();
    expect(setLayerTransform(p, photoId, { x: 37, crop: { x: 10, y: 5, w: 150, h: 80 } })).toBe(p);
    const moved = setLayerTransform(p, photoId, { x: 38 });
    expect(transformOf(moved, photoId)).toMatchObject({ x: 38, y: -19, scale: 0.73 });
    const uncropped = setLayerTransform(p, photoId, { crop: undefined });
    expect("crop" in transformOf(uncropped, photoId)).toBe(false);
    expect(setLayerTransform(p, "nope", { x: 1 })).toBe(p);
  });

  it("setLayerAdjust is photo-only, sanitized, and identity deletes the field", () => {
    const { p, photoId, drawId } = posed();
    const adj = { exposure: 0, brightness: 12.6, contrast: -300, highlights: 0, shadows: 0, saturation: 0, hue: 0, warmth: 0, tint: 0 };
    const a = setLayerAdjust(p, photoId, adj);
    expect(findLayer(a, photoId)!.clip.adjust).toMatchObject({ brightness: 13, contrast: -100 });
    expect(setLayerAdjust(a, photoId, { ...adj })).toBe(a);
    const back = setLayerAdjust(a, photoId, { ...adj, brightness: 0, contrast: 0 });
    expect("adjust" in findLayer(back, photoId)!.clip).toBe(false);
    expect(setLayerAdjust(p, photoId, undefined)).toBe(p);
    expect(setLayerAdjust(p, drawId, adj)).toBe(p);
  });
});

describe("strokes on layers", () => {
  it("appendStrokeTo grows a drawing layer and leaves the old snapshot alone", () => {
    const { p, photoId, drawId } = posed();
    const s = pen(10, 20);
    const q = appendStrokeTo(p, drawId, s);
    expect(drawingChunks(findLayer(q, drawId)!)).toEqual([[s]]);
    expect(drawingChunks(findLayer(p, drawId)!)).toEqual([]);
    expect(appendStrokeTo(p, photoId, s)).toBe(p);
    expect(appendStrokeTo(p, "nope", s)).toBe(p);
    clean(q);
  });

  it("eraseStrokes removes across layers in one mutation, and nothing hit is a no-op", () => {
    let { p } = posed();
    const second = addDrawingLayer(p);
    p = second.project;
    const first = layersOf(p).find((l) => l.name === "Drawing 1")!.trackId;
    const s1 = pen(1, 1);
    const s2 = pen(2, 2);
    const s3 = pen(3, 3);
    p = appendStrokeTo(appendStrokeTo(p, first, s1), first, s2);
    p = appendStrokeTo(p, second.trackId, s3);
    const q = eraseStrokes(p, new Map([[first, new Set([s1])], [second.trackId, new Set([s3])]]));
    expect(drawingChunks(findLayer(q, first)!)).toEqual([[s2]]);
    expect(drawingChunks(findLayer(q, second.trackId)!)).toEqual([]);
    expect(eraseStrokes(p, new Map([[first, new Set([pen(1, 1)])]]))).toBe(p);
    expect(eraseStrokes(p, new Map())).toBe(p);
  });
});

describe("whole-image operations", () => {
  /** Every layer's corners after an operation must be the corners before it,
   *  carried through the same operation applied to canvas points by hand —
   *  so a consistently wrong sign cannot pass the way an undo/redo pair can. */
  function expectCorners(
    before: ProjectFile,
    after: ProjectFile,
    map: (x: number, y: number) => [number, number],
  ): void {
    for (const l of layersOf(before)) {
      const w = l.media.width!;
      const h = l.media.height!;
      const from = layerCorners(l.transform, w, h, before.timeline.width, before.timeline.height);
      const to = layerCorners(transformOf(after, l.trackId), w, h, after.timeline.width, after.timeline.height);
      from.forEach(([x, y], i) => {
        const [ex, ey] = map(x, y);
        expect(to[i]![0], `${l.name} corner ${i} x`).toBeCloseTo(ex, 9);
        expect(to[i]![1], `${l.name} corner ${i} y`).toBeCloseTo(ey, 9);
      });
    }
  }

  it("rotate +90 turns the picture clockwise and swaps the canvas (641×361 → 361×641)", () => {
    const { p, photoId } = posed();
    const r = rotateImage(p, 90);
    expect([r.timeline.width, r.timeline.height]).toEqual([H, W]);
    expect(transformOf(r, photoId)).toMatchObject({ rotate: 180, x: 19, y: 37, flipH: true });
    expectCorners(p, r, (x, y) => [H - y, x]);
    clean(r);
  });

  it("rotate −90 turns it anticlockwise", () => {
    const { p, photoId } = posed();
    const r = rotateImage(p, -90);
    expect(transformOf(r, photoId)).toMatchObject({ rotate: 0, x: -19, y: -37 });
    expectCorners(p, r, (x, y) => [y, W - x]);
  });

  it("+90 then −90, four +90s, and each flip twice all come back exactly", () => {
    const { p } = posed();
    const same = (q: ProjectFile): void => {
      expect(q.timeline.width).toBe(W);
      expect(q.timeline.height).toBe(H);
      expect(q.timeline.tracks).toEqual(p.timeline.tracks);
    };
    same(rotateImage(rotateImage(p, 90), -90));
    same(rotateImage(rotateImage(rotateImage(rotateImage(p, 90), 90), 90), 90));
    same(flipImage(flipImage(p, "h"), "h"));
    same(flipImage(flipImage(p, "v"), "v"));
  });

  it("flips mirror every layer about the canvas centre", () => {
    const { p, photoId, drawId } = posed();
    const h = flipImage(p, "h");
    // 90° + flipH: the angle reverses (270) as the flip toggles off.
    expect(transformOf(h, photoId)).toMatchObject({ rotate: 270, flipH: false, flipV: false, x: -37, y: -19 });
    expect(transformOf(h, drawId)).toMatchObject({ rotate: 180, flipH: true, flipV: true, x: 50, y: 22 });
    expectCorners(p, h, (x, y) => [W - x, y]);
    const v = flipImage(p, "v");
    expect(transformOf(v, photoId)).toMatchObject({ rotate: 270, flipH: true, flipV: true, x: 37, y: 19 });
    expectCorners(p, v, (x, y) => [x, H - y]);
  });

  it("crop re-centres layers on the new canvas and keeps their scale", () => {
    const { p, photoId } = posed();
    const c = cropImage(p, { x: 100, y: 40, w: 301, h: 211 });
    expect([c.timeline.width, c.timeline.height]).toEqual([301, 211]);
    // x = 37 − (100 + 150.5 − 320.5), y = −19 − (40 + 105.5 − 180.5)
    expect(transformOf(c, photoId)).toMatchObject({ x: 107, y: 16, scale: 0.73, rotate: 90 });
    expectCorners(p, c, (x, y) => [x - 100, y - 40]);
    clean(c);
  });

  it("crop clamps a rect that hangs off the canvas, rounds it, and ignores the whole canvas", () => {
    const { p } = posed();
    const c = cropImage(p, { x: -20.4, y: 300.6, w: 100, h: 500 });
    expect([c.timeline.width, c.timeline.height]).toEqual([80, 60]);
    expectCorners(p, c, (x, y) => [x, y - 301]);
    expect(cropImage(p, { x: 0, y: 0, w: W, h: H })).toBe(p);
    expect(cropImage(p, { x: -5, y: -5, w: W + 10, h: H + 10 })).toBe(p);
    expect(cropImage(p, { x: NaN, y: 0, w: 10, h: 10 })).toBe(p);
    // Never below 1 × 1.
    const tiny = cropImage(p, { x: 700, y: 400, w: 5, h: 5 });
    expect([tiny.timeline.width, tiny.timeline.height]).toEqual([1, 1]);
  });

  it("resizeCanvas anchors at the centre and keeps any integer side", () => {
    const { p, photoId } = posed();
    const r = resizeCanvas(p, 1000.4, 99);
    expect([r.timeline.width, r.timeline.height]).toEqual([1000, 99]);
    expect(transformOf(r, photoId)).toBe(transformOf(p, photoId));
    expectCorners(p, r, (x, y) => [x + (1000 - W) / 2, y + (99 - H) / 2]);
    expect(resizeCanvas(p, W, H)).toBe(p);
    expect(resizeCanvas(p, NaN, 5)).toBe(p);
    expect(resizeCanvas(p, 70000, 0).timeline).toMatchObject({ width: 65535, height: 1 });
  });

  it("with no layers: a square canvas has nothing to turn; others still swap", () => {
    const sq = blank(500, 500);
    expect(rotateImage(sq, 90)).toBe(sq);
    expect(flipImage(sq, "h")).toBe(sq);
    const wide = rotateImage(blank(), -90);
    expect([wide.timeline.width, wide.timeline.height]).toEqual([H, W]);
  });
});

describe("setBackground", () => {
  it("stores transparent or a normalized colour; unreadable or unchanged is a no-op", () => {
    const p = blank();
    expect(setBackground(p, "#ABC").image).toEqual({ background: "#aabbcc" });
    expect(setBackground(p, "transparent").image).toEqual({ background: "transparent" });
    expect(setBackground(p, "red")).toBe(p);
    expect(setBackground(p, "#FFFFFF")).toBe(p);
  });
});

describe("drawingTarget", () => {
  /** Top → bottom: D1 (drawing), T (text), D2 (HIDDEN drawing), P (photo). */
  function stack(): { p: ProjectFile; d1: string; t: string; d2: string; ph: string } {
    let p = blank();
    const ph = addPhotoLayer(p, photo());
    const d2 = addDrawingLayer(ph.project);
    const t = addGeneratorLayer(d2.project, { type: "solid", color: "#000000" }, 10, 10, "Solid");
    const d1 = addDrawingLayer(t.project);
    p = setLayerHidden(d1.project, d2.trackId, true);
    return { p, d1: d1.trackId, t: t.trackId, d2: d2.trackId, ph: ph.trackId };
  }

  it("skips a hidden drawing above the selection and finds the nearest visible one", () => {
    const { p, d1, d2, ph } = stack();
    expect(drawingTarget(p, ph)).toEqual({ trackId: d1 });
    expect(drawingTarget(p, d2)).toEqual({ trackId: d1 });
    expect(drawingTarget(p, d1)).toEqual({ trackId: d1 });
    expect(drawingTarget(p, null)).toEqual({ trackId: d1 });
    expect(drawingTarget(p, "not a layer")).toEqual({ trackId: d1 });
  });

  it("returns the selection itself when it is a visible drawing, even with another above", () => {
    const { p, d1, d2 } = stack();
    const shown = setLayerHidden(p, d2, false);
    expect(drawingTarget(shown, d2)).toEqual({ trackId: d2 });
    expect(drawingTarget(shown, null)).toEqual({ trackId: d1 });
  });

  it("creates one directly above the selection (top without one) when none is drawable", () => {
    const { p, d1, ph } = stack();
    const none = setLayerHidden(p, d1, true);
    expect(drawingTarget(none, ph)).toEqual({ create: { above: ph } });
    expect(drawingTarget(none, null)).toEqual({ create: { above: null } });
    expect(drawingTarget(blank(), null)).toEqual({ create: { above: null } });
  });
});

describe("validateImageProject", () => {
  const P = encodePoints(new Float32Array([5, 6, 0.4, 9, 12, 0.9]));
  const s1: Stroke = { t: "pen", c: "#aa0011", w: 3, o: 1, p: P };
  const bad = { t: "pen", c: "#aa0011", w: 3, o: 1, p: "@@@@@@@@@@@@@@@@" };
  const s3: Stroke = { t: "rect", c: "#00ff88", w: 2, a: [1, 2], b: [40, 30] };
  const tf = (patch: Partial<ClipTransform> = {}): ClipTransform => ({
    rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1, ...patch,
  });
  const clip = (id: string, mediaId: string, patch: Partial<Clip> = {}): Clip => ({
    id, mediaId, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform: tf(), audio: defaultAudio(), ...patch,
  });
  const track = (id: string, name: string, clips: Clip[], kind: Track["kind"] = "video"): Track => ({
    id, kind, name, muted: false, clips,
  });
  const photoRef: MediaRef = { id: "m-photo", ...photo() };
  const drawRef = (chunks: unknown): MediaRef =>
    ({ id: "m-draw", path: "Drawing", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: W, height: H, generator: { type: "drawing", chunks } }) as MediaRef;
  const project = (media: MediaRef[], tracks: Track[], image: unknown = { background: "#ffffff" }): ProjectFile =>
    ({ ...blank(), media, timeline: { ...blank().timeline, tracks }, image }) as ProjectFile;

  it("puts a crafted file into the layer model, dropping exactly one bad stroke", () => {
    const audioRef: MediaRef = { id: "m-aud", path: "C:\\a\\x.mp3", size: 1, mtimeMs: 1, kind: "audio", duration: 9, hasAudio: true };
    const input = project(
      [photoRef, drawRef([[s1, bad, s3]]), audioRef],
      [
        track("t1", "Cat", [
          clip("c1", "m-photo", { timelineStart: 3, srcIn: 1, srcOut: 5, speed: 2, transform: tf({ scale: 0, x: 4 }), keyframes: { opacity: [{ t: 0, v: 1 }] } }),
          clip("c2", "m-photo", { timelineStart: 9 }),
        ]),
        track("t2", "Cat again", [clip("c3", "m-photo", { transform: tf({ y: -8 }) })]),
        track("t3", "Ink", [clip("c4", "m-draw")]),
        track("ta", "Audio", [clip("c5", "m-aud")], "audio"),
      ],
      { background: "red" },
    );
    const out = validateImageProject(input);
    expect(out.droppedStrokes).toBe(1);
    const copyId = out.project.timeline.tracks[1]!.clips[0]!.mediaId;
    expect(copyId).not.toBe("m-photo");
    expect(out.project.media).toEqual([photoRef, drawRef([[s1, s3]]), { ...photoRef, id: copyId }]);
    expect(out.project.timeline.tracks).toEqual([
      track("t1", "Cat", [clip("c1", "m-photo", { transform: tf({ x: 4 }) })]),
      track("t2", "Cat again", [clip("c3", copyId, { transform: tf({ y: -8 }) })]),
      track("t3", "Ink", [clip("c4", "m-draw")]),
    ]);
    expect(out.project.image).toEqual({ background: "transparent" });
    expect(out.notes).toEqual([
      "Removed 1 audio track.",
      "Removed 1 extra clip.",
      "Skipped 1 damaged stroke.",
    ]);
    expect(input.media).toHaveLength(3); // the input is not touched
    clean(out.project);
  });

  it("hands a clean project back as the same reference, also after a JSON round trip", () => {
    const { p: posedP, photoId, drawId } = posed();
    let p = appendStrokeTo(posedP, drawId, pen(3, 4, "#abcdef"));
    p = setLayerAdjust(p, photoId, { exposure: 0, brightness: 20, contrast: 0, highlights: 0, shadows: 0, saturation: -30, hue: 45, warmth: 0, tint: 0 });
    p = setLayerHidden(p, photoId, true);
    p = setBackground(p, "#101010");
    p = { ...p, image: { ...p.image!, export: { format: "webp", quality: 80, size: { w: 300, h: 200 } } } };
    const r = validateImageProject(p);
    expect(r.project).toBe(p);
    expect(r).toMatchObject({ droppedStrokes: 0, notes: [] });
    const raw = JSON.parse(JSON.stringify(p)) as ProjectFile;
    expect(validateImageProject(raw).project).toBe(raw);
    const photoOnly = createPhotoImageProject("Ph", photo(36, 64));
    expect(validateImageProject(photoOnly).project).toBe(photoOnly);
    const empty = blank();
    expect(validateImageProject(empty).project).toBe(empty);
  });

  it("drops layers that are not stills or have no media, and media no layer uses", () => {
    const vid: MediaRef = { id: "m-vid", path: "C:\\v.mp4", size: 1, mtimeMs: 1, kind: "video", duration: 3, hasAudio: false, width: 64, height: 36 };
    const orphan = { ...drawRef([[bad]]), id: "m-orphan" };
    const out = validateImageProject(
      project([photoRef, vid, orphan], [
        track("t1", "Vid", [clip("c1", "m-vid")]),
        track("t2", "Ghost", [clip("c2", "m-gone")]),
        track("t3", "Cat", [clip("c3", "m-photo")]),
      ]),
    );
    expect(out.project.media).toEqual([photoRef]);
    expect(out.project.timeline.tracks.map((t) => t.id)).toEqual(["t3"]);
    expect(out.notes).toEqual(["Removed 2 layers that are not an image."]);
    expect(out.droppedStrokes).toBe(0); // the orphan was dropped whole, not read
  });

  it("repairs a layer's transform into something a canvas can draw", () => {
    const t = tf({ opacity: 1.5, rotate: 45 as 0, scale: 1e9, x: NaN, crop: { x: -1, y: 0, w: 5, h: 5 } });
    const out = validateImageProject(project([photoRef], [track("t1", "Cat", [clip("c1", "m-photo", { transform: t })])]));
    expect(out.project.timeline.tracks[0]!.clips[0]!.transform).toEqual(tf({ opacity: 1, rotate: 0, scale: 1e4, x: 0 }));
    expect(out.notes).toEqual([]); // repairs, not removals
    const low = validateImageProject(project([photoRef], [track("t1", "Cat", [clip("c1", "m-photo", { transform: tf({ scale: 1e-9, opacity: -2 }) })])]));
    expect(low.project.timeline.tracks[0]!.clips[0]!.transform).toMatchObject({ scale: 1e-4, opacity: 0 });
    const none = validateImageProject(project([photoRef], [track("t1", "Cat", [clip("c1", "m-photo", { transform: undefined })])]));
    expect(none.project.timeline.tracks[0]!.clips[0]!.transform).toEqual(tf());
  });

  it("reads malformed new fields as absent", () => {
    const hid = { ...track("t1", "Cat", [clip("c1", "m-photo", { adjust: 5 as never })]), hidden: "yes" } as unknown as Track;
    const ink = track("t2", "Ink", [clip("c2", "m-draw", { adjust: { brightness: 50 } as never })]);
    const out = validateImageProject(project([photoRef, drawRef([])], [ink, hid], null));
    const [t2, t1] = out.project.timeline.tracks;
    expect("hidden" in t1!).toBe(false);
    expect("adjust" in t1!.clips[0]!).toBe(false);
    expect("adjust" in t2!.clips[0]!).toBe(false); // adjustments are for photos only
    expect(out.project.image).toEqual({ background: "transparent" });

    const adj = validateImageProject(
      project([photoRef], [track("t1", "Cat", [clip("c1", "m-photo", { adjust: { brightness: 20.4, hue: 999, junk: 1 } as never })])]),
    );
    expect(adj.project.timeline.tracks[0]!.clips[0]!.adjust).toEqual({
      exposure: 0, brightness: 20, contrast: 0, highlights: 0, shadows: 0, saturation: 0, hue: 180, warmth: 0, tint: 0,
    });
  });

  it("re-chunks damaged drawing data: non-arrays, empty and oversized chunks", () => {
    const many = Array.from({ length: 300 }, (_, i) => pen(i, i));
    const out = validateImageProject(project([drawRef([[], "junk", many, [s1]])], [track("t1", "Ink", [clip("c1", "m-draw")])]));
    const chunks = (out.project.media[0]!.generator as { chunks: Stroke[][] }).chunks;
    expect(chunks.map((c) => c.length)).toEqual([256, 44, 1]);
    expect(chunks[2]).toEqual([s1]);
    expect(strokeCount(chunks)).toBe(301);
    expect(out.notes).toEqual(["Skipped damaged drawing data."]);
    const notArray = validateImageProject(project([drawRef("x")], [track("t1", "Ink", [clip("c1", "m-draw")])]));
    expect((notArray.project.media[0]!.generator as { chunks: Stroke[][] }).chunks).toEqual([]);
    expect(notArray.notes).toEqual(["Skipped damaged drawing data."]);
  });

  it("normalizes the image block and the canvas silently", () => {
    const out = validateImageProject({
      ...project([], [track("t0", "Layer", [])], {
        background: "#ABC",
        export: { format: "jpeg", quality: 250.7, size: { w: 300.4, h: 0 } },
        keep: 1,
      }),
      timeline: { ...blank().timeline, width: 641.6, height: 0, tracks: [track("t0", "Layer", []), track("t9", "Spare", [])] },
    });
    expect(out.project.image).toEqual({ background: "#aabbcc", export: { format: "jpeg", quality: 100, size: { w: 300, h: 1 } }, keep: 1 });
    expect([out.project.timeline.width, out.project.timeline.height]).toEqual([642, 1]);
    expect(out.project.timeline.tracks.map((t) => t.id)).toEqual(["t0"]);
    expect(out.notes).toEqual([]);
    const badFormat = validateImageProject(project([], [track("t0", "Layer", [])], { background: "transparent", export: { format: "gif", quality: 5, size: 50 } }));
    expect(badFormat.project.image).toEqual({ background: "transparent" });
  });

  it("gives a generator an unusable box the canvas size, and drops an empty placeholder once layers exist", () => {
    const solid: MediaRef = { id: "m-s", path: "Solid", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 0, generator: { type: "solid", color: "#000000" } };
    const out = validateImageProject(project([solid], [track("t0", "Layer", []), track("t1", "Solid", [clip("c1", "m-s")])]));
    expect(out.project.media[0]).toMatchObject({ width: W, height: H });
    expect(out.project.timeline.tracks.map((t) => t.id)).toEqual(["t1"]);
  });
});
