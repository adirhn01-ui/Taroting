// The image project's layer model: pure operations over the ordinary project
// shape, constrained. One video track is one layer (tracks[0] topmost), each
// non-empty track holds exactly one clip at timelineStart 0, srcIn 0, srcOut 1,
// speed 1 with no keyframes, and every layer owns its MediaRef 1:1. No DOM.
//
// Every operation is pure and returns the SAME reference when it changes
// nothing, so `session.commit` records no empty undo step.
//
// Not implemented yet: the declarations below are the contract the rest of the
// image editor compiles against.

import type {
  ClipAdjust,
  Clip,
  ClipTransform,
  Generator,
  MediaInfo,
  MediaRef,
  ProjectFile,
  Stroke,
} from "../core/types";

export type LayerKind = "photo" | "drawing" | "text" | "solid";

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

/** Tracks with exactly one clip, top first. Memoized per (timeline, media) identity. */
export function layersOf(p: ProjectFile): readonly Layer[];
export function layersOf(): never {
  throw new Error("not implemented");
}

export function findLayer(p: ProjectFile, trackId: string): Layer | undefined;
export function findLayer(): never {
  throw new Error("not implemented");
}

export function addPhotoLayer(
  p: ProjectFile,
  info: MediaInfo,
  opts?: { above?: string | null },
): { project: ProjectFile; trackId: string };
export function addPhotoLayer(): never {
  throw new Error("not implemented");
}

export function addDrawingLayer(
  p: ProjectFile,
  opts?: { above?: string | null },
): { project: ProjectFile; trackId: string };
export function addDrawingLayer(): never {
  throw new Error("not implemented");
}

export function addGeneratorLayer(
  p: ProjectFile,
  gen: Extract<Generator, { type: "solid" | "text" }>,
  w: number,
  h: number,
  label: string,
  opts?: { above?: string | null },
): { project: ProjectFile; trackId: string };
export function addGeneratorLayer(): never {
  throw new Error("not implemented");
}

/** Removes clip + media; drops the track unless it is the last video track
 *  (then leaves it empty). */
export function removeLayer(p: ProjectFile, trackId: string): ProjectFile;
export function removeLayer(): never {
  throw new Error("not implemented");
}

export function moveLayer(p: ProjectFile, trackId: string, toIndex: number): ProjectFile;
export function moveLayer(): never {
  throw new Error("not implemented");
}

export function setLayerHidden(p: ProjectFile, trackId: string, hidden: boolean): ProjectFile;
export function setLayerHidden(): never {
  throw new Error("not implemented");
}

export function renameLayer(p: ProjectFile, trackId: string, name: string): ProjectFile;
export function renameLayer(): never {
  throw new Error("not implemented");
}

/** New MediaRef id for EVERY kind; placed directly above. */
export function duplicateLayer(
  p: ProjectFile,
  trackId: string,
): { project: ProjectFile; trackId: string };
export function duplicateLayer(): never {
  throw new Error("not implemented");
}

export function setLayerTransform(
  p: ProjectFile,
  trackId: string,
  patch: Partial<ClipTransform>,
): ProjectFile;
export function setLayerTransform(): never {
  throw new Error("not implemented");
}

/** Photo layers only; identity → deletes the field. */
export function setLayerAdjust(
  p: ProjectFile,
  trackId: string,
  adj: ClipAdjust | undefined,
): ProjectFile;
export function setLayerAdjust(): never {
  throw new Error("not implemented");
}

export function appendStrokeTo(p: ProjectFile, trackId: string, s: Stroke): ProjectFile;
export function appendStrokeTo(): never {
  throw new Error("not implemented");
}

/** trackId → strokes to remove. One mutation across layers, so one undo step. */
export function eraseStrokes(
  p: ProjectFile,
  hits: ReadonlyMap<string, ReadonlySet<Stroke>>,
): ProjectFile;
export function eraseStrokes(): never {
  throw new Error("not implemented");
}

export function rotateImage(p: ProjectFile, dir: 90 | -90): ProjectFile;
export function rotateImage(): never {
  throw new Error("not implemented");
}

export function flipImage(p: ProjectFile, axis: "h" | "v"): ProjectFile;
export function flipImage(): never {
  throw new Error("not implemented");
}

/** Canvas px, rounded to ints, w/h ≥ 1. */
export function cropImage(
  p: ProjectFile,
  rect: { x: number; y: number; w: number; h: number },
): ProjectFile;
export function cropImage(): never {
  throw new Error("not implemented");
}

/** Anchor centre: layer x/y unchanged. */
export function resizeCanvas(p: ProjectFile, w: number, h: number): ProjectFile;
export function resizeCanvas(): never {
  throw new Error("not implemented");
}

/** "transparent" | normalizeHexColor */
export function setBackground(p: ProjectFile, bg: string): ProjectFile;
export function setBackground(): never {
  throw new Error("not implemented");
}

export type DrawTarget = { trackId: string } | { create: { above: string | null } };

/** Nearest VISIBLE drawing layer at or above `selected` (or topmost visible
 *  drawing if selected is null); else create one directly above `selected`
 *  (top if null). */
export function drawingTarget(p: ProjectFile, selected: string | null): DrawTarget;
export function drawingTarget(): never {
  throw new Error("not implemented");
}

export interface ImageValidation {
  project: ProjectFile;
  droppedStrokes: number;
  notes: string[];
}

/** Runs in the image chunk right after dispatch. Total, never throws, same ref
 *  when clean. */
export function validateImageProject(p: ProjectFile): ImageValidation;
export function validateImageProject(): never {
  throw new Error("not implemented");
}
