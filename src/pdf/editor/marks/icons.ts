// The PDF editor's own tool glyphs (the ones the image editor has no use
// for). The wrapper is character-identical to `imgIcon` / `icon()` — 24-unit
// viewBox, stroke-width 2, round caps and joins, currentColor, aria-hidden —
// so these sit beside the image editor's glyphs at the same weight.

export type PdfIconName = "highlight" | "whiteout" | "signature";

export const PDF_ICON_PATHS: Readonly<Record<PdfIconName, string>> = {
  // a highlighter tip over a bar of marked text
  highlight: '<path d="m9 11-4 4v3h5l3-3"/><path d="m21 7-6 6-4-4 6-6z"/><path d="M3 21h18"/>',
  // a cover box over two lines of text
  whiteout: '<rect x="3" y="5" width="18" height="10" rx="1"/><path d="M6 19h12M6 10h12"/>',
  // a written stroke on a signing line
  signature: '<path d="M3 17c3-1 4-8 6-8s-1 7 1 7 3-5 5-5-1 4 1 4 3-2 4-2"/><path d="M3 21h18"/>',
};

export function pdfIcon(name: PdfIconName, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PDF_ICON_PATHS[name] ?? ""}</svg>`;
}
