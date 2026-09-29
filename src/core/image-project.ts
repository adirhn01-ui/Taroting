// Image projects at the edges of the app: creating one (Home's "New image", a
// photo opened from File Explorer or the viewer) and telling one apart.
//
// IN THE MAIN CHUNK, so it must stay tiny and must NEVER import anything under
// src/image/: Home and open-media reach it at boot, and a single such import
// would pull the whole image editor into startup. The image editor itself is a
// separate lazy chunk that nothing prefetches.

import type { MediaInfo, ProjectFile } from "./types";

export interface CanvasPreset {
  label: string;
  w: number;
  h: number;
}

/** The sizes "New image" offers before Custom. */
export const IMAGE_BLANK_PRESETS: CanvasPreset[] = [
  { label: "1920 × 1080 (16:9)", w: 1920, h: 1080 },
  { label: "1080 × 1080 (1:1)", w: 1080, h: 1080 },
  { label: "1080 × 1920 (9:16)", w: 1080, h: 1920 },
  { label: "3840 × 2160 (4K)", w: 3840, h: 2160 },
  { label: "2480 × 3508 (A4, 300 dpi)", w: 2480, h: 3508 },
  { label: "1280 × 720", w: 1280, h: 720 },
];

/** "transparent" or a `#rrggbb` string. */
export type ImageBackground = "transparent" | string;

/** schema 3, kind "image", background as given (normalized), NO layers (one
 *  empty video track). */
export function createBlankImageProject(
  name: string,
  w: number,
  h: number,
  background: ImageBackground,
): ProjectFile;
export function createBlankImageProject(): never {
  throw new Error("not implemented");
}

/** schema 3, kind "image", background "transparent", canvas = info.width ×
 *  info.height (integers, never rounded/capped), one layer: the photo at scale
 *  1, centred. Throws if info.kind !== "image" || info.generator || !info.width
 *  || !info.height. */
export function createPhotoImageProject(name: string, info: MediaInfo): ProjectFile;
export function createPhotoImageProject(): never {
  throw new Error("not implemented");
}

/** The one test for "is this an image project". */
export function isImageProject(p: ProjectFile): boolean {
  return p.kind === "image";
}
