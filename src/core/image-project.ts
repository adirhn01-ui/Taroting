// Image projects at the edges of the app: creating one (Home's "New image
// project" dialog, Home's "Open as" with pictures, a photo opened from File
// Explorer or the viewer) and telling one apart.
//
// NOT at boot: open-media fetches it only when a photo is opened as a project,
// and Home only through its lazy "New image project" and "Open as" dialogs.
// Keep it that way (no static import from main, Home or open-media) — nothing
// on the home screen needs it. It must still stay tiny and must NEVER import
// anything under src/image/: every one of those paths reaches it before the
// image editor is wanted, and a single such import would drag the whole image
// editor in with it. The image editor itself is a separate lazy chunk that
// nothing prefetches.

import type { Clip, MediaInfo, MediaRef, ProjectFile, Track } from "./types";
import { DEFAULT_EXPORT_PRESET } from "./types";
import { clampImageCanvas, defaultAudio, defaultTransform, uid } from "./project";
import { normalizeHexColor } from "./session";
import { fileStem } from "./format";

export interface CanvasPreset {
  label: string;
  w: number;
  h: number;
}

/** The sizes "New image project" offers before Custom. */
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
 *  empty video track).
 *
 *  The canvas goes through `clampImageCanvas` (any integer >= 1 — never
 *  even-rounded, never capped at 8192); a side that is not a number is 1. A
 *  background that is neither "transparent" nor a readable colour becomes
 *  "transparent". The video `export` preset is still carried: the file shape
 *  is shared, and the Rust loader types that field. */
export function createBlankImageProject(
  name: string,
  w: number,
  h: number,
  background: ImageBackground,
): ProjectFile {
  const now = new Date().toISOString();
  const side = (v: number): number => (Number.isFinite(v) ? clampImageCanvas(v) : 1);
  const bg = background === "transparent" ? background : normalizeHexColor(background, "");
  return {
    // 3 marks an image project and nothing else: the Rust `migrate()` refuses
    // 3 without `kind: "image"` and `kind: "image"` on anything but 3.
    schema: 3,
    kind: "image",
    app: "taroting",
    id: uid(),
    name,
    createdAt: now,
    modifiedAt: now,
    media: [],
    timeline: {
      // An image has no time; the rate only satisfies the shared shape.
      fps: { num: 30, den: 1 },
      width: side(w),
      height: side(h),
      tracks: [{ id: uid(), kind: "video", name: "Layer", muted: false, clips: [] }],
    },
    export: { ...DEFAULT_EXPORT_PRESET },
    image: { background: bg || "transparent" },
  };
}

/** schema 3, kind "image", background "transparent", canvas = info.width ×
 *  info.height (integers, never rounded/capped), one layer: the photo at scale
 *  1, centred. Throws if info.kind !== "image" || info.generator || !info.width
 *  || !info.height. The one-picture case of createPhotosImageProject. */
export function createPhotoImageProject(name: string, info: MediaInfo): ProjectFile {
  return createPhotosImageProject(name, [info]);
}

/** schema 3, kind "image", background "transparent", canvas = the FIRST
 *  picture's size; one photo layer per picture, the first at the bottom and
 *  each later one above it (Home's "Open as" hands them over in natural name
 *  order). Every picture sits at its own pixel size, centred (on whole pixels),
 *  scaled down only when it is larger than the canvas: scale = min(1, W / w,
 *  H / h) — the rule the image editor's addPhotoLayer applies to a picture
 *  added later. Throws
 *  on an empty list or on any entry that is not a still with a size; the
 *  caller drops those first and names them.
 *
 *  Built here rather than through the image editor's `addPhotoLayer` because
 *  this module must not import src/image/** (see the header). The shape is
 *  the same one that function makes: one video track per layer named after
 *  its file, one clip pinned to 0..1 at speed 1, the TOP layer first in
 *  `tracks` (the image editor's layer order). */
export function createPhotosImageProject(name: string, infos: readonly MediaInfo[]): ProjectFile {
  const first = infos[0];
  if (!first) throw new Error("an image project needs at least one picture");
  for (const info of infos) {
    if (info.kind !== "image" || info.generator || !info.width || !info.height) {
      throw new Error("an image project can only be made from a still image");
    }
  }
  const base = createBlankImageProject(name, first.width!, first.height!, "transparent");
  const W = base.timeline.width;
  const H = base.timeline.height;
  const media: MediaRef[] = [];
  const tracks: Track[] = [];
  for (const info of infos) {
    const ref: MediaRef = { id: uid(), ...info };
    const scale = Math.min(1, W / info.width!, H / info.height!);
    // At 100%, centred on whole pixels: a picture whose side has the other
    // parity from the canvas's would start half a pixel in and export soft.
    const x = scale === 1 ? wholePixelNudge(W, info.width!) : 0;
    const y = scale === 1 ? wholePixelNudge(H, info.height!) : 0;
    const clip: Clip = {
      id: uid(),
      mediaId: ref.id,
      timelineStart: 0,
      srcIn: 0,
      srcOut: 1,
      speed: 1,
      transform: { ...defaultTransform(), scale, x, y },
      audio: defaultAudio(),
    };
    media.push(ref);
    // Top first: each later picture goes in above the ones before it.
    tracks.unshift({ id: uid(), kind: "video", name: fileStem(info.path), muted: false, clips: [clip] });
  }
  return { ...base, media, timeline: { ...base.timeline, tracks } };
}

/** The centre offset (0 or ½) that puts an upright, uncropped layer `side`
 *  px long, drawn at 100%, onto whole pixels of a canvas `canvas` px long:
 *  its edge sits at (canvas − side) / 2 + offset. The image editor's
 *  `alignToPixels` (src/image/layers.ts) gives the same number for this case;
 *  it is repeated here because this module must not import src/image/**. */
function wholePixelNudge(canvas: number, side: number): number {
  const edge = (canvas - side) / 2;
  return Math.round(edge) - edge;
}

/** The one test for "is this an image project". */
export function isImageProject(p: ProjectFile): boolean {
  return p.kind === "image";
}
