// The image project's layer model: pure operations over the ordinary project
// shape, constrained. One video track is one layer (tracks[0] topmost), each
// non-empty track holds exactly one clip at timelineStart 0, srcIn 0, srcOut 1,
// speed 1 with no keyframes, and every layer owns its MediaRef 1:1. No DOM.
//
// Every operation is pure and returns the SAME reference when it changes
// nothing, so `session.commit` records no empty undo step.
//
// An empty video track exists only while the project has no layers at all
// (the timeline invariant wants >= 1 video track): adding a layer drops it,
// and removing the last layer leaves that layer's track behind, empty.
// `validateImageProject` restores the same shape on load, so a layer's index
// in `layersOf` is also its video track's index.

import type {
  Clip,
  ClipAdjust,
  ClipCrop,
  ClipTransform,
  Generator,
  ImageExportPreset,
  ImageMeta,
  MediaInfo,
  MediaRef,
  ProjectFile,
  Stroke,
  Track,
} from "../core/types";
import { STROKE_CHUNK } from "../core/types";
import { clampImageCanvas, defaultAudio, defaultTransform, uid } from "../core/project";
import { normalizeHexColor } from "../core/session";
import { fileStem } from "../core/format";
import { sanitizeAdjust } from "./adjust/plan";
import {
  appendStroke,
  MAX_STROKE_POINTS,
  MAX_TOTAL_POINTS,
  MAX_TOTAL_STROKES,
  pointCountOf,
  removeStrokes,
  strokeTotals,
  validateStroke,
  type StrokeTotals,
} from "./strokes";
import { IMAGE_SCALE_GUARD, layerToCanvas } from "./geom";

export type LayerKind = "photo" | "drawing" | "text" | "solid";

/** What the UI calls each kind, in sentence case: the Layers panel's row
 *  label, the inspector's badge and the Add layer menu all read this, so a
 *  photo layer is a "Photo" wherever it is named. ("Image" is the whole
 *  picture: Copy image, Export image, an image project.) */
export const KIND_LABEL: Readonly<Record<LayerKind, string>> = {
  photo: "Photo",
  drawing: "Drawing",
  text: "Text",
  solid: "Solid color",
};

export interface Layer {
  trackId: string;
  clipId: string;
  mediaId: string;
  kind: LayerKind;
  name: string;
  hidden: boolean;
  /** 0 = topmost */
  index: number;
  clip: Clip;
  media: MediaRef;
  transform: ClipTransform;
}

type DrawingGen = Extract<Generator, { type: "drawing" }>;

function kindOf(m: MediaRef): LayerKind {
  const g = m.generator;
  if (!g) return "photo";
  return g.type === "drawing" ? "drawing" : g.type === "text" ? "text" : "solid";
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** Keyed on the timeline object; the media array it was built against is
 *  checked too, because appending a stroke replaces a MediaRef (and so the
 *  media array) without touching the timeline. */
const layerMemo = new WeakMap<object, { media: MediaRef[]; layers: readonly Layer[] }>();

/** Tracks with exactly one clip, top first. Memoized per (timeline, media)
 *  identity: the same project hands back the same array, so a panel can
 *  re-render on identity alone. A stroke commit replaces the media array, so
 *  the identity changes on every stroke by design. */
export function layersOf(p: ProjectFile): readonly Layer[] {
  const hit = layerMemo.get(p.timeline);
  if (hit && hit.media === p.media) return hit.layers;
  const byId = new Map<string, MediaRef>();
  for (const m of p.media) if (!byId.has(m.id)) byId.set(m.id, m);
  const out: Layer[] = [];
  for (const track of p.timeline.tracks) {
    if (track.kind !== "video" || track.clips.length !== 1) continue;
    const clip = track.clips[0]!;
    const media = byId.get(clip.mediaId);
    if (!media) continue;
    out.push({
      trackId: track.id,
      clipId: clip.id,
      mediaId: media.id,
      kind: kindOf(media),
      name: track.name,
      hidden: track.hidden === true,
      index: out.length,
      clip,
      media,
      transform: clip.transform ?? defaultTransform(),
    });
  }
  layerMemo.set(p.timeline, { media: p.media, layers: out });
  return out;
}

export function findLayer(p: ProjectFile, trackId: string): Layer | undefined {
  return layersOf(p).find((l) => l.trackId === trackId);
}

/** A layer's effective opacity, clamped to 0..1; a non-finite value (a
 *  crafted file) counts as 1. Preview and export both filter with this, so
 *  they can never disagree about which layers exist. Lives here rather than in
 *  the compositor so the layer rules (which layer ink may target, which strokes
 *  an eraser can reach) read the same number without importing the renderer,
 *  which itself imports this module. */
export function opacityOf(l: Layer): number {
  const o = l.transform.opacity;
  return Number.isFinite(o) ? Math.min(Math.max(o, 0), 1) : 1;
}

/** The layer that should be selected once `trackId` is removed: the one below
 *  it (it moves up into the freed row), else the one above, else none. Null
 *  for an id that is not a layer. Read BEFORE the removal is committed. */
export function nextSelectionAfterRemove(p: ProjectFile, trackId: string): string | null {
  const ls = layersOf(p);
  const i = ls.findIndex((l) => l.trackId === trackId);
  if (i < 0) return null;
  return (ls[i + 1] ?? ls[i - 1])?.trackId ?? null;
}

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

function withTracks(p: ProjectFile, tracks: Track[]): ProjectFile {
  return { ...p, timeline: { ...p.timeline, tracks } };
}

/** Replace one layer's track (by id). */
function withTrack(p: ProjectFile, trackId: string, next: Track): ProjectFile {
  return withTracks(
    p,
    p.timeline.tracks.map((t) => (t.id === trackId ? next : t)),
  );
}

/** Replace one layer's clip. */
function withClip(p: ProjectFile, l: Layer, clip: Clip): ProjectFile {
  const track = p.timeline.tracks.find((t) => t.id === l.trackId)!;
  return withTrack(p, l.trackId, { ...track, clips: [clip] });
}

function withMedia(p: ProjectFile, next: ReadonlyMap<string, MediaRef>): ProjectFile {
  return { ...p, media: p.media.map((m) => next.get(m.id) ?? m) };
}

/** A layer's one clip: pinned to 0..1 at speed 1 — an image project has no
 *  time, and these are the values every timeline helper accepts. */
function layerClip(mediaId: string, transform: ClipTransform): Clip {
  return {
    id: uid(),
    mediaId,
    timelineStart: 0,
    srcIn: 0,
    srcOut: 1,
    speed: 1,
    transform,
    audio: defaultAudio(),
  };
}

/** Insert a new layer (its track and its MediaRef) directly above the layer
 *  whose track is `above`, or at the top when `above` is null, absent or not
 *  a layer. Drops the placeholder empty video track, if any: once a layer
 *  exists, the timeline's ">= 1 video track" invariant is met by it. */
function insertLayer(
  p: ProjectFile,
  name: string,
  media: MediaRef,
  transform: ClipTransform,
  above: string | null | undefined,
): { project: ProjectFile; trackId: string } {
  const clip = layerClip(media.id, transform);
  const track: Track = { id: uid(), kind: "video", name, muted: false, clips: [clip] };
  const kept = p.timeline.tracks.filter((t) => !(t.kind === "video" && t.clips.length === 0));
  let at = 0;
  if (above) {
    const i = kept.findIndex((t) => t.id === above && t.kind === "video");
    if (i >= 0) at = i;
  }
  const tracks = [...kept.slice(0, at), track, ...kept.slice(at)];
  return {
    project: { ...p, media: [...p.media, media], timeline: { ...p.timeline, tracks } },
    trackId: track.id,
  };
}

/** "Drawing N" with the first N (from the drawing count + 1) no layer uses. */
function nextDrawingName(p: ProjectFile): string {
  const layers = layersOf(p);
  const names = new Set(layers.map((l) => l.name));
  let n = layers.filter((l) => l.kind === "drawing").length + 1;
  while (names.has(`Drawing ${n}`)) n++;
  return `Drawing ${n}`;
}

/** A usable side: finite and > 0, else the fallback. */
function side(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** `t` nudged (by at most half a pixel on each axis) so that a layer drawn at
 *  100% has its edges on whole canvas pixels; same reference when it already
 *  has, or when it is not at 100% (a scaled layer is resampled anyway).
 *
 *  A layer centred on the canvas sits on whole pixels only when the canvas
 *  side and the layer side have the same parity: a 200 px photo on a 641 px
 *  canvas starts at 220.5, and an export at 100% then filters every pixel
 *  between two source pixels — visibly soft for a screenshot or text. Read
 *  through `layerToCanvas`, so a rotation or a crop is accounted for. */
export function alignToPixels(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): ClipTransform {
  if (t.scale !== 1) return t;
  const m = layerToCanvas(t, srcW, srcH, canvasW, canvasH);
  const dx = Math.round(m[4]) - m[4];
  const dy = Math.round(m[5]) - m[5];
  if (dx === 0 && dy === 0) return t;
  return { ...t, x: t.x + dx, y: t.y + dy };
}

/* ------------------------------------------------------------------ */
/* Adding and removing layers                                          */
/* ------------------------------------------------------------------ */

/** A photo as a new layer, centred (on whole pixels: `alignToPixels`), at
 *  native pixels — scaled down only when it is larger than the canvas
 *  (`min(1, W/w, H/h)`: fit, never upscale).
 *  Throws for anything that is not a still (a probed video, a GIF, a
 *  generator): such a layer would be dropped again on the next load, so a
 *  caller must refuse the file rather than commit it. */
export function addPhotoLayer(
  p: ProjectFile,
  info: MediaInfo,
  opts?: { above?: string | null },
): { project: ProjectFile; trackId: string } {
  if (info.kind !== "image" || info.generator) {
    throw new Error("only a still image can be a photo layer");
  }
  const media: MediaRef = { id: uid(), ...info };
  const W = p.timeline.width;
  const H = p.timeline.height;
  const w = side(info.width, W);
  const h = side(info.height, H);
  const transform = alignToPixels({ ...defaultTransform(), scale: Math.min(1, W / w, H / h) }, w, h, W, H);
  return insertLayer(p, fileStem(info.path), media, transform, opts?.above);
}

/** An empty drawing layer covering the canvas: its media box is the canvas
 *  size at creation, at scale 1, centred — so layer-local px == canvas px
 *  until the image is rotated, cropped or resized. */
export function addDrawingLayer(
  p: ProjectFile,
  opts?: { above?: string | null },
): { project: ProjectFile; trackId: string } {
  const media: MediaRef = {
    id: uid(),
    path: "Drawing",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 0,
    hasAudio: false,
    width: p.timeline.width,
    height: p.timeline.height,
    generator: { type: "drawing", chunks: [] },
  };
  return insertLayer(p, nextDrawingName(p), media, defaultTransform(), opts?.above);
}

/** A text or solid generator as a new layer, at native pixels, centred on
 *  whole pixels (an even text box on an odd canvas would otherwise land on a
 *  half pixel and export soft).
 *  `w`/`h` are its intrinsic box (the measured text box, or the solid's
 *  size); `label` is the MediaRef's display label (the path field). */
export function addGeneratorLayer(
  p: ProjectFile,
  gen: Extract<Generator, { type: "solid" | "text" }>,
  w: number,
  h: number,
  label: string,
  opts?: { above?: string | null },
): { project: ProjectFile; trackId: string } {
  const media: MediaRef = {
    id: uid(),
    path: label,
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 0,
    hasAudio: false,
    width: side(w, p.timeline.width),
    height: side(h, p.timeline.height),
    generator: gen,
  };
  const name = gen.type === "text" ? "Text" : "Solid";
  const transform = alignToPixels(defaultTransform(), media.width!, media.height!, p.timeline.width, p.timeline.height);
  return insertLayer(p, name, media, transform, opts?.above);
}

/** Removes the layer's clip AND its MediaRef; drops the track unless it is
 *  the last video track (then leaves it empty — the ">= 1 video track"
 *  invariant). */
export function removeLayer(p: ProjectFile, trackId: string): ProjectFile {
  const track = p.timeline.tracks.find((t) => t.id === trackId && t.kind === "video");
  if (!track || track.clips.length === 0) return p;
  const doomed = new Set(track.clips.map((c) => c.mediaId));
  const others = p.timeline.tracks.filter((t) => t !== track);
  // Never strand a MediaRef another clip still uses (1:1 makes that moot on a
  // validated project; this keeps a hand-built one intact).
  for (const t of others) for (const c of t.clips) doomed.delete(c.mediaId);
  let tracks = others;
  if (!others.some((t) => t.kind === "video")) {
    const empty: Track = { ...track, clips: [] };
    delete empty.hidden;
    tracks = [empty, ...others];
  }
  return {
    ...p,
    media: doomed.size > 0 ? p.media.filter((m) => !doomed.has(m.id)) : p.media,
    timeline: { ...p.timeline, tracks },
  };
}

/** Move a layer to `toIndex` in `layersOf` order (0 = top; clamped). */
export function moveLayer(p: ProjectFile, trackId: string, toIndex: number): ProjectFile {
  const layers = layersOf(p);
  const from = layers.findIndex((l) => l.trackId === trackId);
  if (from < 0 || !Number.isFinite(toIndex)) return p;
  const to = Math.min(Math.max(Math.round(toIndex), 0), layers.length - 1);
  if (to === from) return p;
  const order = layers.map((l) => l.trackId);
  order.splice(from, 1);
  order.splice(to, 0, trackId);
  // Refill the slots the layer tracks occupy, in the new order: anything else
  // in the array (there is nothing else on a validated project) stays put.
  const byId = new Map(p.timeline.tracks.map((t) => [t.id, t]));
  const slots = new Set(order);
  let k = 0;
  return withTracks(
    p,
    p.timeline.tracks.map((t) => (slots.has(t.id) ? byId.get(order[k++]!)! : t)),
  );
}

export function setLayerHidden(p: ProjectFile, trackId: string, hidden: boolean): ProjectFile {
  const track = p.timeline.tracks.find((t) => t.id === trackId && t.kind === "video");
  if (!track || (track.hidden === true) === hidden) return p;
  const next: Track = { ...track };
  // The key is deleted, never written `false`: absent is the visible state on
  // disk, and a video-shaped track stays byte-identical to one never hidden.
  if (hidden) next.hidden = true;
  else delete next.hidden;
  return withTrack(p, trackId, next);
}

/** Trimmed; an empty name is refused (same reference). */
export function renameLayer(p: ProjectFile, trackId: string, name: string): ProjectFile {
  const track = p.timeline.tracks.find((t) => t.id === trackId && t.kind === "video");
  const clean = typeof name === "string" ? name.trim() : "";
  if (!track || clean === "" || clean === track.name) return p;
  return withTrack(p, trackId, { ...track, name: clean });
}

/* ------------------------------------------------------------------ */
/* The drawing budget                                                  */
/* ------------------------------------------------------------------ */

/** Strokes and points across every drawing MediaRef, counted the way the save
 *  check counts them: per MediaRef, so a duplicated drawing (which shares its
 *  chunks by reference) counts twice, exactly as it is written twice. O(media)
 *  per call — each drawing's own totals are memoized (`strokeTotals`). */
export function drawingTotals(p: ProjectFile): StrokeTotals {
  let strokes = 0;
  let points = 0;
  for (const m of p.media) {
    const g = m.generator;
    if (g?.type !== "drawing") continue;
    const t = strokeTotals(g.chunks);
    strokes += t.strokes;
    points += t.points;
  }
  return { strokes, points };
}

/** Would `more` on top of what the project already holds stay inside the
 *  caps `image_rules.rs` refuses a save beyond? Past them EVERY save fails —
 *  autosave included — so the edit is refused instead of committed. */
function fitsDrawingBudget(p: ProjectFile, more: StrokeTotals): boolean {
  const t = drawingTotals(p);
  return t.strokes + more.strokes <= MAX_TOTAL_STROKES && t.points + more.points <= MAX_TOTAL_POINTS;
}

/** Why this stroke cannot be added to the project, or null when it can: the
 *  stroke alone holds more points than one stroke may, or the drawings would
 *  cross the project-wide caps. `appendStrokeTo` refuses exactly these; a
 *  caller says this message so the stroke does not vanish unexplained. */
export function strokeRefusal(p: ProjectFile, s: Stroke): string | null {
  const points = "p" in s ? pointCountOf(s.p) : 0;
  if (points > MAX_STROKE_POINTS) return "This stroke is too long to keep. Draw it in shorter pieces.";
  if (!fitsDrawingBudget(p, { strokes: 1, points })) {
    return "The drawings in this image are at their size limit, so the stroke wasn't added.";
  }
  return null;
}

/** Why the layer cannot be duplicated, or null when it can: a drawing whose
 *  copy would carry the project past the caps (the copy is written out in
 *  full, though it shares its strokes in memory). Other kinds hold no strokes. */
export function duplicateRefusal(p: ProjectFile, trackId: string): string | null {
  const l = findLayer(p, trackId);
  if (!l || l.kind !== "drawing") return null;
  const gen = l.media.generator as DrawingGen;
  return fitsDrawingBudget(p, strokeTotals(gen.chunks)) ? null : "This drawing is too large to duplicate.";
}

/** New ids for the track, the clip AND the MediaRef, for EVERY kind (each
 *  layer owns its media 1:1), placed directly above the original and named
 *  "<name> copy". A drawing's chunks are shared by reference — strokes are
 *  immutable — so duplicating one is O(1) however much is drawn on it. A
 *  drawing too large to copy (`duplicateRefusal`) → same project. */
export function duplicateLayer(
  p: ProjectFile,
  trackId: string,
): { project: ProjectFile; trackId: string } {
  const l = findLayer(p, trackId);
  if (!l || duplicateRefusal(p, trackId) !== null) return { project: p, trackId };
  const media: MediaRef = { ...l.media, id: uid() };
  const clip: Clip = { ...l.clip, id: uid(), mediaId: media.id };
  const track: Track = {
    ...p.timeline.tracks.find((t) => t.id === trackId)!,
    id: uid(),
    name: `${l.name} copy`,
    clips: [clip],
  };
  const tracks = p.timeline.tracks.slice();
  tracks.splice(tracks.findIndex((t) => t.id === trackId), 0, track);
  return {
    project: { ...p, media: [...p.media, media], timeline: { ...p.timeline, tracks } },
    trackId: track.id,
  };
}

function sameCrop(a: ClipCrop | undefined, b: ClipCrop | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Patch a layer's transform. A `crop: undefined` in the patch removes the
 *  crop. Same reference when every patched value is already current. */
export function setLayerTransform(
  p: ProjectFile,
  trackId: string,
  patch: Partial<ClipTransform>,
): ProjectFile {
  const l = findLayer(p, trackId);
  if (!l) return p;
  const cur = l.transform;
  let changed = l.clip.transform === undefined;
  for (const key of Object.keys(patch) as (keyof ClipTransform)[]) {
    if (key === "crop" ? !sameCrop(patch.crop, cur.crop) : patch[key] !== cur[key]) {
      changed = true;
    }
  }
  if (!changed) return p;
  const next: ClipTransform = { ...cur, ...patch };
  if ("crop" in patch && patch.crop === undefined) delete next.crop;
  return withClip(p, l, { ...l.clip, transform: next });
}

function sameAdjust(a: ClipAdjust | undefined, b: ClipAdjust | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of Object.keys(b) as (keyof ClipAdjust)[]) if (a[k] !== b[k]) return false;
  return Object.keys(a).length === Object.keys(b).length;
}

/** Photo layers only. The value goes through `sanitizeAdjust` (integers,
 *  clamped); identity deletes the field. Same reference when unchanged. */
export function setLayerAdjust(
  p: ProjectFile,
  trackId: string,
  adj: ClipAdjust | undefined,
): ProjectFile {
  const l = findLayer(p, trackId);
  if (!l || l.kind !== "photo") return p;
  const clean = sanitizeAdjust(adj);
  if (sameAdjust(l.clip.adjust, clean)) return p;
  const clip: Clip = { ...l.clip };
  if (clean) clip.adjust = clean;
  else delete clip.adjust;
  return withClip(p, l, clip);
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/** Append a committed stroke to a drawing layer. Copies the layer's chunk
 *  index and last chunk only (see strokes.ts). Not a drawing layer, or a
 *  stroke the save check would refuse (`strokeRefusal`) → same reference. */
export function appendStrokeTo(p: ProjectFile, trackId: string, s: Stroke): ProjectFile {
  const l = findLayer(p, trackId);
  if (!l || l.kind !== "drawing" || strokeRefusal(p, s) !== null) return p;
  const gen = l.media.generator as DrawingGen;
  const media: MediaRef = {
    ...l.media,
    generator: { type: "drawing", chunks: appendStroke(gen.chunks, s) },
  };
  return withMedia(p, new Map([[media.id, media]]));
}

/** trackId → strokes to remove. One mutation across every layer, so an
 *  eraser pass is one undo step. Nothing removed → same reference. */
export function eraseStrokes(
  p: ProjectFile,
  hits: ReadonlyMap<string, ReadonlySet<Stroke>>,
): ProjectFile {
  const next = new Map<string, MediaRef>();
  for (const [trackId, doomed] of hits) {
    const l = findLayer(p, trackId);
    if (!l || l.kind !== "drawing") continue;
    const gen = l.media.generator as DrawingGen;
    const chunks = removeStrokes(gen.chunks, doomed);
    if (chunks === gen.chunks) continue;
    next.set(l.mediaId, { ...l.media, generator: { type: "drawing", chunks } });
  }
  return next.size > 0 ? withMedia(p, next) : p;
}

/* ------------------------------------------------------------------ */
/* Whole-image operations                                              */
/* ------------------------------------------------------------------ */

/** −v without producing −0 (which JSON writes as 0 anyway, but which makes a
 *  round trip compare unequal in memory). */
const neg = (v: number): number => (v === 0 ? 0 : -v);

/** Rewrite every layer's transform; same reference when none changed. */
function mapTransforms(
  p: ProjectFile,
  fn: (t: ClipTransform) => ClipTransform,
): Track[] | null {
  let changed = false;
  const tracks = p.timeline.tracks.map((track) => {
    if (track.kind !== "video" || track.clips.length === 0) return track;
    const clips = track.clips.map((c) => ({
      ...c,
      transform: fn(c.transform ?? defaultTransform()),
    }));
    changed = true;
    return { ...track, clips };
  });
  return changed ? tracks : null;
}

/** Rotate the whole image a quarter turn: +90 clockwise, −90 anticlockwise.
 *  The canvas swaps sides; each layer turns about the canvas centre —
 *  its own rotation advances and its centre offset turns with it. A layer's
 *  crop and strokes are layer-local, so they need nothing. */
export function rotateImage(p: ProjectFile, dir: 90 | -90): ProjectFile {
  const cw = dir === 90;
  const tracks = mapTransforms(p, (t) => ({
    ...t,
    rotate: ((t.rotate + (cw ? 90 : 270)) % 360) as ClipTransform["rotate"],
    x: cw ? neg(t.y) : t.y,
    y: cw ? t.x : neg(t.x),
  }));
  const { width, height } = p.timeline;
  if (!tracks && width === height) return p;
  return {
    ...p,
    timeline: { ...p.timeline, width: height, height: width, tracks: tracks ?? p.timeline.tracks },
  };
}

/** Mirror the whole image. The flip happens outside each layer's rotation, so
 *  a rotated layer's angle reverses as its own flip toggles (F·R(θ) = R(−θ)·F)
 *  and its centre offset mirrors. The canvas is unchanged. */
export function flipImage(p: ProjectFile, axis: "h" | "v"): ProjectFile {
  const h = axis === "h";
  const tracks = mapTransforms(p, (t) => ({
    ...t,
    rotate: ((360 - t.rotate) % 360) as ClipTransform["rotate"],
    flipH: h ? !t.flipH : t.flipH,
    flipV: h ? t.flipV : !t.flipV,
    x: h ? neg(t.x) : t.x,
    y: h ? t.y : neg(t.y),
  }));
  return tracks ? withTracks(p, tracks) : p;
}

/** Crop the canvas to `rect` (canvas px). The rect is clamped onto the canvas
 *  and rounded to whole px, at least 1 × 1; layers keep their place on the
 *  image (their offsets are re-expressed from the new centre) and their
 *  scale. The whole canvas, or a rect that is not a number → same reference. */
export function cropImage(
  p: ProjectFile,
  rect: { x: number; y: number; w: number; h: number },
): ProjectFile {
  const W = p.timeline.width;
  const H = p.timeline.height;
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return p;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const x0 = Math.round(clamp(rect.x, 0, W - 1));
  const y0 = Math.round(clamp(rect.y, 0, H - 1));
  const w = Math.max(1, Math.round(clamp(rect.x + rect.w, 0, W)) - x0);
  const h = Math.max(1, Math.round(clamp(rect.y + rect.h, 0, H)) - y0);
  if (x0 === 0 && y0 === 0 && w === W && h === H) return p;
  const dx = x0 + w / 2 - W / 2;
  const dy = y0 + h / 2 - H / 2;
  const tracks =
    dx === 0 && dy === 0
      ? null
      : mapTransforms(p, (t) => ({ ...t, x: t.x - dx, y: t.y - dy }));
  return {
    ...p,
    timeline: { ...p.timeline, width: w, height: h, tracks: tracks ?? p.timeline.tracks },
  };
}

/** New canvas size, anchored at the centre — to the whole pixel: the old
 *  picture lands `floor((new − old) / 2)` px in from the new edge. Layer x/y
 *  are offsets from the centre, so on an even change they stay as they are;
 *  an odd change moves the centre by half a pixel, and every layer shifts by
 *  that half pixel back, so a layer that sat on whole pixels still does (an
 *  exact-centre anchor would leave each one straddling two). Sides are
 *  `clampImageCanvas`ed (any integer >= 1). Unchanged or not a number → same
 *  reference. */
export function resizeCanvas(p: ProjectFile, w: number, h: number): ProjectFile {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return p;
  const width = clampImageCanvas(w);
  const height = clampImageCanvas(h);
  const { width: W, height: H } = p.timeline;
  if (width === W && height === H) return p;
  // 0 for an even change, −0.5 for an odd one (either sign of change).
  const sx = Math.floor((width - W) / 2) - (width - W) / 2;
  const sy = Math.floor((height - H) / 2) - (height - H) / 2;
  // Decided BEFORE mapTransforms, which reports a change for any non-empty
  // track whatever its function does.
  const tracks =
    sx === 0 && sy === 0 ? null : mapTransforms(p, (t) => ({ ...t, x: t.x + sx, y: t.y + sy }));
  return { ...p, timeline: { ...p.timeline, width, height, tracks: tracks ?? p.timeline.tracks } };
}

/** "transparent", or any colour `normalizeHexColor` reads (stored as
 *  lowercase #rrggbb). Unreadable or unchanged → same reference. */
export function setBackground(p: ProjectFile, bg: string): ProjectFile {
  const v = bg === "transparent" ? bg : normalizeHexColor(bg, "");
  if (v === "" || p.image?.background === v) return p;
  return { ...p, image: { ...p.image, background: v } };
}

export type DrawTarget = { trackId: string } | { create: { above: string | null } };

/** Nearest VISIBLE drawing layer at or above `selected` (or topmost visible
 *  drawing if selected is null); else create one directly above `selected`
 *  (top if null). A hidden or 0%-opacity drawing layer is never drawn on —
 *  ink nobody can see is worse than a new layer. A selection that is not a layer counts as
 *  null. */
export function drawingTarget(p: ProjectFile, selected: string | null): DrawTarget {
  const layers = layersOf(p);
  // A 0% layer is as invisible as a hidden one: the compositor skips it, the
  // live mark included, so ink on it would be committed and never seen.
  const drawable = (l: Layer): boolean => l.kind === "drawing" && !l.hidden && opacityOf(l) > 0;
  const at = selected === null ? -1 : layers.findIndex((l) => l.trackId === selected);
  if (at < 0) {
    // No selection: the topmost visible drawing (index 0 is the top).
    const top = layers.find(drawable);
    return top ? { trackId: top.trackId } : { create: { above: null } };
  }
  // The selection itself, then each layer above it, nearest first.
  for (let i = at; i >= 0; i--) {
    if (drawable(layers[i]!)) return { trackId: layers[i]!.trackId };
  }
  return { create: { above: selected } };
}

/* ------------------------------------------------------------------ */
/* Load-time validation                                                */
/* ------------------------------------------------------------------ */

export interface ImageValidation {
  project: ProjectFile;
  droppedStrokes: number;
  notes: string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A layer transform an image project can draw: a quarter-turn rotation, a
 *  scale inside IMAGE_SCALE_GUARD (a scale that is not one reads as 1),
 *  finite offsets, an opacity in [0, 1] — `globalAlpha` IGNORES an assignment
 *  outside that and keeps the previous layer's value — and a crop that
 *  describes a rectangle (else none). Same reference when clean. */
function cleanTransform(t: ClipTransform): ClipTransform {
  const r = t.rotate as number;
  const rotate: ClipTransform["rotate"] = r === 90 || r === 180 || r === 270 ? r : 0;
  const s = t.scale;
  const scale =
    typeof s === "number" && Number.isFinite(s) && s > 0
      ? Math.min(Math.max(s, IMAGE_SCALE_GUARD.min), IMAGE_SCALE_GUARD.max)
      : 1;
  const x = finiteOr(t.x, 0);
  const y = finiteOr(t.y, 0);
  const opacity = Math.min(Math.max(finiteOr(t.opacity, 1), 0), 1);
  const flipH = t.flipH === true;
  const flipV = t.flipV === true;
  const c = t.crop as unknown;
  let crop: ClipCrop | undefined = t.crop;
  if (c !== undefined) {
    const ok =
      isObject(c) &&
      [c.x, c.y, c.w, c.h].every((v) => typeof v === "number" && Number.isFinite(v)) &&
      (c.x as number) >= 0 &&
      (c.y as number) >= 0 &&
      (c.w as number) > 0 &&
      (c.h as number) > 0;
    if (!ok) crop = undefined;
  }
  if (
    rotate === t.rotate &&
    scale === t.scale &&
    x === t.x &&
    y === t.y &&
    opacity === t.opacity &&
    flipH === t.flipH &&
    flipV === t.flipV &&
    crop === t.crop
  ) {
    return t;
  }
  const out: ClipTransform = { ...t, rotate, scale, x, y, opacity, flipH, flipV };
  if (crop) out.crop = crop;
  else delete out.crop;
  return out;
}

/** The one clip of a layer: time pinned to 0..1 at speed 1, no keyframes, a
 *  clean transform, and adjustments only on a photo (sanitized; identity or
 *  garbage deletes the key). Same reference when clean. */
function cleanClip(c: Clip, photo: boolean): Clip {
  const transform = cleanTransform(c.transform ?? defaultTransform());
  const rawAdjust = (c as { adjust?: unknown }).adjust;
  let adjust: ClipAdjust | undefined;
  let adjustSame = rawAdjust === undefined;
  if (rawAdjust !== undefined && photo) {
    adjust = sanitizeAdjust(rawAdjust);
    adjustSame = isObject(rawAdjust) && sameAdjust(rawAdjust as unknown as ClipAdjust, adjust);
  }
  if (
    c.timelineStart === 0 &&
    c.srcIn === 0 &&
    c.srcOut === 1 &&
    c.speed === 1 &&
    c.keyframes === undefined &&
    transform === c.transform &&
    adjustSame
  ) {
    return c;
  }
  const out: Clip = { ...c, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform };
  delete out.keyframes;
  if (adjust) out.adjust = adjust;
  else delete out.adjust;
  return out;
}

/** Every stroke of a raw `chunks` value through `validateStroke`. Chunks that
 *  lost or repaired a stroke are rebuilt (split to STROKE_CHUNK if a crafted
 *  one is longer); untouched chunks are kept by reference; empty ones go.
 *  Returns the input itself when it was clean. */
function cleanChunks(raw: unknown): { chunks: Stroke[][]; dropped: number; damaged: boolean } {
  if (!Array.isArray(raw)) return { chunks: [], dropped: 0, damaged: raw !== undefined };
  let out: Stroke[][] | null = null;
  let dropped = 0;
  let damaged = false;
  for (let c = 0; c < raw.length; c++) {
    const chunk: unknown = raw[c];
    if (!Array.isArray(chunk)) {
      damaged = true;
      out ??= (raw as Stroke[][]).slice(0, c);
      continue;
    }
    let rebuilt: Stroke[] | null = chunk.length > STROKE_CHUNK || chunk.length === 0 ? [] : null;
    for (let i = 0; i < chunk.length; i++) {
      const s = validateStroke(chunk[i]);
      if (s === null) dropped++;
      if (rebuilt === null && s !== chunk[i]) rebuilt = (chunk as Stroke[]).slice(0, i);
      if (rebuilt !== null && s !== null) rebuilt.push(s);
    }
    if (rebuilt === null) {
      out?.push(chunk as Stroke[]);
      continue;
    }
    out ??= (raw as Stroke[][]).slice(0, c);
    for (let at = 0; at < rebuilt.length; at += STROKE_CHUNK) {
      out.push(rebuilt.slice(at, at + STROKE_CHUNK));
    }
  }
  return { chunks: out ?? (raw as Stroke[][]), dropped, damaged };
}

/** Keep strokes, oldest first, while the running totals stay within the
 *  crafted-file caps; drop every stroke from the first one that would cross
 *  either. Same reference when all fit. */
function withinBudget(
  chunks: Stroke[][],
  budget: { strokes: number; points: number },
): { chunks: Stroke[][]; dropped: number } {
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    for (let i = 0; i < chunk.length; i++) {
      const s = chunk[i]!;
      const pts = "p" in s ? pointCountOf(s.p) : 0;
      if (budget.strokes + 1 > MAX_TOTAL_STROKES || budget.points + pts > MAX_TOTAL_POINTS) {
        let dropped = chunk.length - i;
        for (let r = c + 1; r < chunks.length; r++) dropped += chunks[r]!.length;
        budget.strokes = MAX_TOTAL_STROKES;
        budget.points = MAX_TOTAL_POINTS;
        const kept = chunks.slice(0, c);
        if (i > 0) kept.push(chunk.slice(0, i));
        return { chunks: kept, dropped };
      }
      budget.strokes += 1;
      budget.points += pts;
    }
  }
  return { chunks, dropped: 0 };
}

/** A generator layer's media box must be a real size (the renderer and the
 *  geometry divide by it); an unusable side becomes the canvas's. */
function cleanGeneratorBox(m: MediaRef, W: number, H: number): MediaRef {
  const w = side(m.width, W);
  const h = side(m.height, H);
  return w === m.width && h === m.height ? m : { ...m, width: w, height: h };
}

function sameExport(a: Record<string, unknown>, b: ImageExportPreset): boolean {
  if (Object.keys(a).length !== 3 || a.format !== b.format || a.quality !== b.quality) return false;
  if (typeof b.size === "number") return a.size === b.size;
  const s = a.size;
  return isObject(s) && Object.keys(s).length === 2 && s.w === b.size.w && s.h === b.size.h;
}

/** `image.export`: a whitelisted format (else the preset is dropped and the
 *  dialog's defaults apply), quality an integer 1..100, size 100/50/25 or
 *  whole-px sides >= 1. */
function cleanExportPreset(raw: unknown): ImageExportPreset | undefined {
  if (!isObject(raw)) return undefined;
  const format = raw.format;
  if (format !== "png" && format !== "jpeg" && format !== "webp") return undefined;
  const quality = Math.min(Math.max(Math.round(finiteOr(raw.quality, 90)), 1), 100);
  const sz = raw.size;
  let size: ImageExportPreset["size"] = 100;
  if (sz === 100 || sz === 50 || sz === 25) size = sz;
  else if (isObject(sz) && typeof sz.w === "number" && typeof sz.h === "number") {
    if (Number.isFinite(sz.w) && Number.isFinite(sz.h)) {
      size = { w: clampImageCanvas(sz.w), h: clampImageCanvas(sz.h) };
    }
  }
  return { format, quality, size };
}

/** The `image` block: background normalized ("transparent" when unreadable —
 *  a repair, not damage worth a notice), the export preset cleaned. Unknown
 *  keys are kept (Rust stores the block opaque). Same reference when clean. */
function cleanImageMeta(raw: unknown): ImageMeta {
  const o = isObject(raw) ? raw : {};
  const bgRaw = o.background;
  const background = bgRaw === "transparent" ? bgRaw : normalizeHexColor(bgRaw, "") || "transparent";
  const expRaw = o.export;
  const exp = expRaw === undefined ? undefined : cleanExportPreset(expRaw);
  const expSame = expRaw === undefined || (exp !== undefined && isObject(expRaw) && sameExport(expRaw, exp));
  if (raw === o && background === bgRaw && expSame) return raw as unknown as ImageMeta;
  const out: ImageMeta = { ...(o as Partial<ImageMeta>), background };
  if (exp) out.export = exp;
  else delete out.export;
  return out;
}

/**
 * Runs in the image chunk right after dispatch. Total, never throws, same ref
 * when clean.
 *
 * `load_project` hands over the RAW JSON. Rust's typed parse has proven the
 * video-shaped skeleton (tracks, clips, media, timeline), but it reads the
 * image-only fields leniently — a stroke that does not parse is skipped there,
 * a malformed `hidden` / `adjust` / `image` reads as absent — so every one of
 * those arrives here as whatever the file said. This puts the project into
 * the layer model's shape:
 *
 * - audio tracks go; each video track keeps its FIRST clip only;
 * - a layer whose MediaRef is missing or not a still is dropped;
 * - empty video tracks go (one stays when nothing else does);
 * - every clip is pinned to 0..1 at speed 1 with no keyframes, its transform
 *   made drawable (`cleanTransform`), its adjustments sanitized (photos only);
 * - a MediaRef shared by more than one layer is copied (new id) so each layer
 *   owns its own, and a MediaRef no layer uses is dropped — Rust validates
 *   EVERY drawing on save, so an orphan with one bad stroke would otherwise
 *   make the project unsaveable while showing nothing wrong;
 * - every stroke goes through `validateStroke`, and the totals are held to the
 *   crafted-file caps (the numbers `image_rules.rs` refuses on save);
 * - `image.background` / `image.export` are normalized; the canvas is an
 *   integer in [1, 65535].
 *
 * `notes` lists only what a user could miss — content that was removed — and
 * is what makes the editor tell them; silent repairs (a colour spelled
 * `#ABC`, a clip time) are not noted.
 */
export function validateImageProject(p: ProjectFile): ImageValidation {
  const notes: string[] = [];
  let droppedStrokes = 0;
  let changed = false;

  const tl = p.timeline;
  const width = Number.isFinite(tl.width) ? clampImageCanvas(tl.width) : 1;
  const height = Number.isFinite(tl.height) ? clampImageCanvas(tl.height) : 1;
  if (width !== tl.width || height !== tl.height) changed = true;

  const mediaById = new Map<string, MediaRef>();
  let dupMedia = false;
  for (const m of p.media) {
    if (mediaById.has(m.id)) dupMedia = true;
    else mediaById.set(m.id, m);
  }

  // Pass 1: which tracks are layers.
  let audioGone = 0;
  let clipsGone = 0;
  let layersGone = 0;
  const layerTracks: Track[] = [];
  let firstEmpty: Track | null = null;
  for (const track of tl.tracks) {
    if (track.kind !== "video") {
      changed = true;
      if (track.clips.length > 0) audioGone++;
      continue;
    }
    if (track.clips.length === 0) {
      firstEmpty ??= track;
      continue;
    }
    if (track.clips.length > 1) {
      clipsGone += track.clips.length - 1;
      changed = true;
    }
    const media = mediaById.get(track.clips[0]!.mediaId);
    if (!media || media.kind !== "image") {
      layersGone++;
      changed = true;
      continue;
    }
    layerTracks.push(track);
  }

  // Pass 2: clean each layer; a second user of one MediaRef gets a copy.
  const cleanMedia = new Map<string, MediaRef>();
  const copies: MediaRef[] = [];
  const used = new Set<string>();
  const tracks: Track[] = [];
  for (const track of layerTracks) {
    const raw = track.clips[0]!;
    let media = cleanMedia.get(raw.mediaId);
    if (!media) {
      media = mediaById.get(raw.mediaId)!;
      const g = media.generator;
      if (g) {
        const boxed = cleanGeneratorBox(media, width, height);
        if (g.type === "drawing") {
          const res = cleanChunks((g as { chunks?: unknown }).chunks);
          droppedStrokes += res.dropped;
          if (res.damaged) notes.push("Skipped damaged drawing data.");
          media =
            res.chunks === g.chunks
              ? boxed
              : { ...boxed, generator: { type: "drawing", chunks: res.chunks } };
        } else {
          media = boxed;
        }
      }
      cleanMedia.set(raw.mediaId, media);
    }
    let clip = cleanClip(raw, !media.generator);
    if (used.has(raw.mediaId)) {
      const copy: MediaRef = { ...media, id: uid() };
      copies.push(copy);
      clip = { ...clip, mediaId: copy.id };
    }
    used.add(raw.mediaId);
    const hiddenRaw = (track as { hidden?: unknown }).hidden;
    if (clip === raw && track.clips.length === 1 && (hiddenRaw === undefined || hiddenRaw === true)) {
      tracks.push(track);
      continue;
    }
    const next: Track = { ...track, clips: [clip] };
    if (hiddenRaw !== true) delete next.hidden;
    tracks.push(next);
  }
  if (copies.length > 0) changed = true;

  if (tracks.length === 0) {
    // No layers: exactly one empty video track, the placeholder.
    let keep = firstEmpty;
    if (keep && (keep as { hidden?: unknown }).hidden !== undefined) {
      keep = { ...keep };
      delete keep.hidden;
    }
    tracks.push(keep ?? { id: uid(), kind: "video", name: "Layer", muted: false, clips: [] });
  }
  if (tracks.length !== tl.tracks.length || tracks.some((t, i) => t !== tl.tracks[i])) {
    changed = true;
  }

  // Media: the layers' own, in file order, then the copies; orphans dropped.
  const media: MediaRef[] = [];
  const seen = new Set<string>();
  for (const m of p.media) {
    if (seen.has(m.id) || !cleanMedia.has(m.id)) continue;
    seen.add(m.id);
    media.push(cleanMedia.get(m.id)!);
  }
  media.push(...copies);

  // Crafted-file caps over the final media list (a copy counts again: the
  // save check walks every MediaRef).
  const budget = { strokes: 0, points: 0 };
  let overBudget = 0;
  for (let i = 0; i < media.length; i++) {
    const g = media[i]!.generator;
    if (g?.type !== "drawing") continue;
    const res = withinBudget(g.chunks, budget);
    if (res.dropped === 0) continue;
    overBudget += res.dropped;
    media[i] = { ...media[i]!, generator: { type: "drawing", chunks: res.chunks } };
  }
  droppedStrokes += overBudget;

  if (
    dupMedia ||
    media.length !== p.media.length ||
    media.some((m, i) => m !== p.media[i])
  ) {
    changed = true;
  }

  const image = cleanImageMeta(p.image);
  if (image !== p.image) changed = true;

  if (audioGone > 0) notes.push(`Removed ${plural(audioGone, "audio track", "audio tracks")}.`);
  if (clipsGone > 0) notes.push(`Removed ${plural(clipsGone, "extra clip", "extra clips")}.`);
  if (layersGone > 0) {
    notes.push(`Removed ${plural(layersGone, "layer that is", "layers that are")} not an image.`);
  }
  if (droppedStrokes - overBudget > 0) {
    notes.push(`Skipped ${plural(droppedStrokes - overBudget, "damaged stroke", "damaged strokes")}.`);
  }
  if (overBudget > 0) {
    notes.push(`Skipped ${plural(overBudget, "stroke", "strokes")} over the drawing size limit.`);
  }

  if (!changed) return { project: p, droppedStrokes, notes };
  return {
    project: { ...p, media, image, timeline: { ...tl, width, height, tracks } },
    droppedStrokes,
    notes,
  };
}
