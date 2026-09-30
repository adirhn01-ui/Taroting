// Image projects at the edges of the app: creating one (Home's "New image", a
// photo opened from File Explorer or the viewer) and telling one apart.
//
// NOT at boot: open-media fetches it only when a photo is opened as a project,
// and Home only through the lazy "New image" dialog. Keep it that way (no static
// import from main, Home or open-media) — nothing on the home screen needs it.
// It must still stay tiny and must NEVER import anything under src/image/:
// both of those paths reach it before the image editor is wanted, and a single
// such import would drag the whole image editor in with it. The image editor
// itself is a separate lazy chunk that nothing prefetches.

import type { Clip, MediaInfo, MediaRef, ProjectFile } from "./types";
import { DEFAULT_EXPORT_PRESET } from "./types";
import { clampImageCanvas, defaultAudio, defaultTransform, uid } from "./project";
import { normalizeHexColor } from "./session";
import { fileStem } from "./format";

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
 *  || !info.height.
 *
 *  Built here rather than through the image editor's `addPhotoLayer` because
 *  this module must not import src/image/** (see the header). The shape is
 *  the same one that function makes: one video track named after the file,
 *  one clip pinned to 0..1 at speed 1. */
export function createPhotoImageProject(name: string, info: MediaInfo): ProjectFile {
  if (info.kind !== "image" || info.generator || !info.width || !info.height) {
    throw new Error("an image project can only be made from a still image");
  }
  const base = createBlankImageProject(name, info.width, info.height, "transparent");
  const media: MediaRef = { id: uid(), ...info };
  const clip: Clip = {
    id: uid(),
    mediaId: media.id,
    timelineStart: 0,
    srcIn: 0,
    srcOut: 1,
    speed: 1,
    transform: defaultTransform(),
    audio: defaultAudio(),
  };
  return {
    ...base,
    media: [media],
    timeline: {
      ...base.timeline,
      tracks: [
        { id: uid(), kind: "video", name: fileStem(info.path), muted: false, clips: [clip] },
      ],
    },
  };
}

/** The one test for "is this an image project". */
export function isImageProject(p: ProjectFile): boolean {
  return p.kind === "image";
}
