// What a project stores for a font choice, and the shape check for a FontId.
// Pure and dependency-free (type imports only): it may sit in the boot chunk.
// The font runtime itself (src/fonts) is lazy and never imported from here.

import type { FontFamily, FontId, FontRequest } from "./types";

/** The font every legacy field falls back to when a `fontId` is in force. */
export const DEFAULT_FONT: FontFamily = "Segoe UI";

/** The six fonts every Taroting has always had, in the menus' order. */
export const LEGACY_FONTS: readonly FontFamily[] = Object.freeze([
  "Segoe UI",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Impact",
] as const);

export function isLegacyFont(v: unknown): v is FontFamily {
  return typeof v === "string" && (LEGACY_FONTS as readonly string[]).includes(v);
}

const MAX_ID = 96;
const LIB = "lib:";
const CONTROL = /[\u0000-\u001f\u007f]/;
const EDGE_SPACE = /^\s|\s$/;

/** Shape only: 1..96 UTF-16 units, no control characters, no leading or
 *  trailing whitespace, and `lib:` is followed by at least one character.
 *  Says nothing about whether the font is on this PC. */
export function isFontId(v: unknown): v is FontId {
  if (typeof v !== "string") return false;
  if (v.length < 1 || v.length > MAX_ID) return false;
  if (CONTROL.test(v) || EDGE_SPACE.test(v)) return false;
  if (v.startsWith(LIB) && v.length === LIB.length) return false;
  return true;
}

/** What to store for a pick: a legacy font -> { legacy } (no `fontId` key at
 *  all), anything else -> { legacy: DEFAULT_FONT, fontId }. */
export function fontChoice(id: FontId): { legacy: FontFamily; fontId?: FontId } {
  if (isLegacyFont(id)) return { legacy: id };
  return { legacy: DEFAULT_FONT, fontId: id };
}

/** The id in force for display in a picker: `fontId` if well-shaped, else the
 *  legacy font. */
export function chosenFont(legacy: FontFamily, fontId: FontId | undefined): FontId {
  return isFontId(fontId) ? fontId : legacy;
}

/** The runtime request for an object's font: null when `fontId` is absent or
 *  ill-shaped (the legacy font is in force and needs no request, I1),
 *  otherwise `{ id: fontId, bold, italic }`. `legacy` is the fallback and
 *  never part of a request. */
export function fontRequestOf(
  legacy: FontFamily,
  fontId: FontId | undefined,
  bold: boolean,
  italic: boolean,
): FontRequest | null {
  void legacy;
  return isFontId(fontId) ? { id: fontId, bold, italic } : null;
}

/** The name a person reads for a font: a library id without its `lib:`
 *  prefix, anything else as is. */
export function fontDisplayName(id: FontId): string {
  return id.startsWith(LIB) ? id.slice(LIB.length) : id;
}

/** The one notice a project open shows for its fonts that are not on this PC
 *  (the seam's wording), shared by the video, image and PDF editors. Each name
 *  once, in first-seen order; "A", "A and B", "A, B and C". An empty list
 *  answers "" (nothing to say). */
export function missingFontNotice(ids: readonly FontId[]): string {
  const names = [...new Set(ids.map(fontDisplayName))];
  if (names.length === 0) return "";
  if (names.length === 1) {
    return `Font ${names[0]} isn't on this PC. Showing Segoe UI. Import it in Settings, or pick another font.`;
  }
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Fonts ${list} aren't on this PC. Showing Segoe UI. Import them in Settings, or pick other fonts.`;
}
