// The image editor's icons, in its own chunk (not in src/ui/icons.ts, which
// ships in the main chunk and would make every user pay for glyphs only an
// image project shows). The SVG wrapper is character-identical to `icon()` in
// src/ui/icons.ts — 24-unit viewBox, stroke-width 2, round caps and joins,
// currentColor, aria-hidden — so a tool button here and a transport button in
// the video editor are the same drawing at the same weight. icons.test.ts pins
// the wrapper against `icon()` itself, so the two cannot drift.

export type ImgIconName =
  | "select"
  | "pen"
  | "pencil"
  | "marker"
  | "eraser"
  | "shapes"
  | "ruler"
  | "undo"
  | "redo"
  | "copy"
  | "eye"
  | "eyeOff"
  | "layers"
  | "crop"
  | "canvas"
  | "rotateLeft"
  | "rotateRight"
  | "flipH"
  | "flipV"
  | "fit"
  | "drawing"
  | "image"
  | "text"
  | "solid";

/** A Record over the union, so the compiler demands a path for every name the
 *  panels and tools may ask for: a missing glyph would render as an empty,
 *  invisible button. Exported for the test only. */
export const IMG_ICON_PATHS: Readonly<Record<ImgIconName, string>> = {
  select: '<path d="M5 3.5 18.5 10l-6 1.5L9.5 18z"/><path d="m12.5 11.5 5 5"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  pencil: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="m15 5 4 4"/><path d="m4 16 4 4"/>',
  marker: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser:
    '<path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  shapes: '<path d="m12 3 5 8H7z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
  ruler:
    '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.4"/><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  // The whole picture as an artboard: a frame whose edges run past its
  // corners. Deliberately NOT the crop glyph — the canvas controls crop,
  // resize, turn and flip, and a crop icon read as "crop the selected layer".
  canvas: '<path d="M3 7h18M3 17h18M7 3v18M17 3v18"/>',
  rotateLeft: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotateRight: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  flipH: '<path d="M12 3v18"/><path d="M8 7 3 17h5z"/><path d="m16 7 5 10h-5z"/>',
  flipV: '<path d="M3 12h18"/><path d="M7 8 17 3v5z"/><path d="m7 16 10 5v-5z"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  drawing: '<path d="M3 16c2-5 4-7 6-4s3 6 6 2 4-7 6-6"/>',
  // The same picture as Home's 'Image project' choice (New project menu, Open
  // as dialog; src/ui/icons.ts), so a photo layer and an image project read as
  // one thing.
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  solid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 14 14 4M4 20 20 4M10 20 20 10"/>',
};

/** `size` defaults to 16, as `icon()` does. */
export function imgIcon(name: ImgIconName, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IMG_ICON_PATHS[name] ?? ""}</svg>`;
}
