// The image editor's icons, in its own chunk (not in src/ui/icons.ts, which
// ships in the main chunk). The SVG wrapper must be character-identical to
// `icon()` in src/ui/icons.ts: 24-unit viewBox, stroke-width 2, round caps and
// joins, aria-hidden.
//
// Not implemented yet (renders nothing): the names below are the contract.

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
  | "rotateLeft"
  | "rotateRight"
  | "flipH"
  | "flipV"
  | "fit"
  | "drawing"
  | "image"
  | "text"
  | "solid";

/** `size` defaults to 16, as `icon()` does. */
export function imgIcon(name: ImgIconName, size?: number): string;
export function imgIcon(): string {
  return "";
}
