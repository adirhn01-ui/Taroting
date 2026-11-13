// The image editor's text rules that need no DOM: a new text layer's
// generator from the tool state, a style patch applied to a generator, and
// the text a contenteditable holds. Shared by the in-place editor, the Text
// tool and the inspector's text section.

import { styleAvailability, withFont } from "../../editor/media/generators";
import { normalizeHexColor } from "../../core/session";
import type { Generator } from "../../core/types";
import { styleGenWhole } from "../../core/gen-text-runs";
import type { PdfRunPatch } from "../../core/pdf-runs";
import type { TextStylePatch } from "../context";
import { clampTextSize, cutText, TEXT_SIZE_MAX, TEXT_SIZE_MIN } from "../layers";
import { cssToSource, type ToolState } from "../tool-state";

export type TextGen = Extract<Generator, { type: "text" }>;

/** A size typed or picked in the UI: a whole number of source px inside the
 *  layer range. */
export function uiTextSize(v: number): number {
  if (!Number.isFinite(v)) return TEXT_SIZE_MIN;
  return Math.min(Math.max(Math.round(v), TEXT_SIZE_MIN), TEXT_SIZE_MAX);
}

/**
 * The generator of a NEW text layer: empty, in the Text tool's font and
 * colour, its size the tool's size on screen turned into source px at the
 * zoom it is placed at (as an ink stroke's width is), so text appears on
 * screen at the size the tool row shows. Never bold or italic.
 */
export function newTextGen(tools: ToolState, dpr: number, zoom: number): TextGen {
  const size = uiTextSize(cssToSource(tools.sizes.text, dpr, zoom > 0 ? zoom : 1, 1));
  const base: TextGen = {
    type: "text",
    text: "",
    fontFamily: tools.font.legacy,
    sizePx: size,
    color: normalizeHexColor(tools.colors.text, "#000000"),
    bold: false,
    italic: false,
  };
  return withFont(base, tools.font);
}

/** `g` restyled by `patch`. A Bold or Italic the font has no face for is
 *  off (the Impact rule, and a library font's real faces once known). The
 *  same reference when the patch changes nothing. */
export function applyTextStyle(g: TextGen, patch: TextStylePatch): TextGen {
  let next: TextGen = g;
  if (patch.font && (patch.font.legacy !== g.fontFamily || patch.font.fontId !== g.fontId)) {
    next = withFont(next, patch.font);
  }
  if (patch.sizePx !== undefined) {
    const s = clampTextSize(patch.sizePx);
    if (s !== next.sizePx) next = { ...next, sizePx: s };
  }
  if (patch.color !== undefined) {
    const c = normalizeHexColor(patch.color, "");
    if (c !== "" && c !== next.color) next = { ...next, color: c };
  }
  if (patch.bold !== undefined && patch.bold !== next.bold) next = { ...next, bold: patch.bold };
  if (patch.italic !== undefined && patch.italic !== next.italic) next = { ...next, italic: patch.italic };
  const can = styleAvailability(next.fontFamily, next.fontId);
  if ((next.bold && !can.bold) || (next.italic && !can.italic)) {
    next = { ...next, bold: next.bold && can.bold, italic: next.italic && can.italic };
  }
  // With nothing selected a style is the whole text's: a styled part loses
  // the property that changed (a text without styles is `next` as is).
  return next === g ? g : styleGenWhole(next, g);
}

/** A control's patch as a run style for a selected part: sizes whole px in
 *  the layer range, colours lowercase `#rrggbb`. Empty when nothing in it is
 *  usable. */
export function runPatchOf(patch: TextStylePatch): PdfRunPatch {
  const out: PdfRunPatch = {};
  if (patch.font) {
    out.font = patch.font.legacy;
    if (patch.font.fontId !== undefined) out.fontId = patch.font.fontId;
  }
  if (patch.sizePx !== undefined) out.size = clampTextSize(patch.sizePx);
  if (patch.color !== undefined) {
    const c = normalizeHexColor(patch.color, "");
    if (c !== "") out.c = c;
  }
  if (patch.bold !== undefined) out.bold = patch.bold;
  if (patch.italic !== undefined) out.italic = patch.italic;
  return out;
}

/** The text a contenteditable holds, cut to the layer cap. Chromium keeps a
 *  placeholder <br> after a last empty line, which innerText reads as one
 *  extra newline: only THAT is dropped, so opening and closing an editor
 *  never changes the text. Tabs become spaces (a canvas draws a tab as
 *  nothing), as the loader makes them. */
export function readText(el: HTMLElement): string {
  return cutText(readRawText(el));
}

/** What `readText` reads before the cap: a paste past the cap is longer. */
export function readRawText(el: HTMLElement): string {
  const raw = (typeof el.innerText === "string" ? el.innerText : (el.textContent ?? "")).replace(/\r\n?/g, "\n");
  const last = el.lastChild as (Node & { tagName?: string }) | null;
  const placeholder = !!last && typeof last.tagName === "string" && last.tagName.toUpperCase() === "BR";
  const text = placeholder ? raw.replace(/\n$/, "") : raw;
  return text.includes("\t") ? text.replace(/\t/g, " ") : text;
}
