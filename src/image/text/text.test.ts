// The image Text tool's rules that need no DOM: the load-time text rules
// (cleanTextGen and validateImageProject), the box re-anchoring every typed
// character goes through (setTextGen), where a click puts a new text
// (addTextLayer), the tool's defaults and style patches, which layer a Text
// press types into, and the editor's CSS matrix.
//
// Fixture values differ on every axis the code could confuse: an odd canvas
// (301 × 203), a box that is not square, a size that is not the default, a
// colour that is not black.

import { describe, expect, it } from "vitest";
import { createBlankImageProject } from "../../core/image-project";
import type { Generator, ProjectFile } from "../../core/types";
import { layerToCanvas } from "../geom";
import {
  addGeneratorLayer,
  addTextLayer,
  cleanTextGen,
  clampTextSize,
  cutText,
  findLayer,
  layersOf,
  setLayerHidden,
  setLayerTransform,
  setTextGen,
  shortenedTextNote,
  TEXT_MAX_CHARS,
  TEXT_SIZE_FALLBACK,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  validateImageProject,
} from "../layers";
import { DEFAULT_TOOL_STATE } from "../tool-state";
import { editMatrix } from "./text-edit";
import { applyTextStyle, newTextGen, readText, uiTextSize } from "./text-style";
import { textLayerAt } from "./text-tool";

type TextGen = Extract<Generator, { type: "text" }>;
const gen = (over: Record<string, unknown> = {}): TextGen =>
  ({ type: "text", text: "Hi", fontFamily: "Georgia", sizePx: 30, color: "#abcdef", bold: true, italic: false, ...over }) as TextGen;

function project(...gens: TextGen[]): ProjectFile {
  let p = createBlankImageProject("Card", 301, 203, "#ffffff");
  for (const g of gens) p = addGeneratorLayer(p, g, 100, 40, "Text").project;
  return p;
}

/* ------------------------------------------------------------------ */

describe("cleanTextGen", () => {
  it("hands back the very object when nothing needs fixing", () => {
    const g = gen({ fontId: "lib:Inter", color: "#ABCDEF", sizePx: 12.5 });
    expect(cleanTextGen(g)).toEqual({ gen: g, shortened: false });
    expect(cleanTextGen(g).gen).toBe(g);
  });

  it.each([
    ["a text that is not a string", { text: 5 }, { text: "" }],
    ["CRLF and CR line ends", { text: "a\r\nb\rc" }, { text: "a\nb\nc" }],
    ["a tab", { text: "a\tb" }, { text: "a b" }],
    ["an unknown font", { fontFamily: "Comic Sans MS" }, { fontFamily: "Segoe UI" }],
    ["a size below the range", { sizePx: 0.25 }, { sizePx: TEXT_SIZE_MIN }],
    ["a size above the range", { sizePx: 4000 }, { sizePx: TEXT_SIZE_MAX }],
    ["a size that is not a number", { sizePx: "big" }, { sizePx: TEXT_SIZE_FALLBACK }],
    ["a short colour", { color: "#AbC" }, { color: "#aabbcc" }],
    ["an unreadable colour", { color: "red" }, { color: "#000000" }],
    ["a bold that is not true", { bold: "yes" }, { bold: false }],
    ["an italic that is not a boolean", { italic: 1 }, { italic: false }],
  ])("repairs %s, and only that", (_label, bad, want) => {
    const out = cleanTextGen(gen(bad));
    expect(out.gen).toEqual(gen(want));
    expect(out.shortened).toBe(false);
  });

  it("drops an ill-shaped font id and keeps a good one", () => {
    expect("fontId" in cleanTextGen(gen({ fontId: "lib:" })).gen).toBe(false);
    expect(cleanTextGen(gen({ fontId: "Consolas" })).gen.fontId).toBe("Consolas");
  });

  it("cuts a text over the cap, says so, and never leaves half a surrogate pair", () => {
    const long = "a".repeat(TEXT_MAX_CHARS + 3);
    const out = cleanTextGen(gen({ text: long }));
    expect(out.shortened).toBe(true);
    expect(out.gen.text).toHaveLength(TEXT_MAX_CHARS);
    // An astral character straddling the cap goes whole.
    const straddle = "b".repeat(TEXT_MAX_CHARS - 1) + "😀";
    expect(cutText(straddle)).toBe("b".repeat(TEXT_MAX_CHARS - 1));
    // Exactly the cap is kept as it is.
    const at = "c".repeat(TEXT_MAX_CHARS);
    expect(cleanTextGen(gen({ text: at })).shortened).toBe(false);
  });

  it("clampTextSize keeps a fractional in-range size", () => {
    expect(clampTextSize(37.5)).toBe(37.5);
    expect(clampTextSize(Number.NaN)).toBe(TEXT_SIZE_FALLBACK);
  });
});

describe("validateImageProject: text layers", () => {
  it("leaves a project with clean text untouched, same reference, no note", () => {
    const p = project(gen(), gen({ text: "Two\nlines", fontFamily: "Impact" }));
    const out = validateImageProject(p);
    expect(out.project).toBe(p);
    expect(out.shortenedTexts).toBeUndefined();
    expect(out.notes).toEqual([]);
  });

  it("repairs the damaged layer only, and counts the cut ones", () => {
    const p = project(gen({ text: "x".repeat(TEXT_MAX_CHARS + 1) }), gen({ sizePx: 9000 }), gen({ text: "ok" }));
    const out = validateImageProject(p);
    expect(out.shortenedTexts).toBe(1);
    expect((out.project.media[0]!.generator as TextGen).text).toHaveLength(TEXT_MAX_CHARS);
    expect((out.project.media[1]!.generator as TextGen).sizePx).toBe(TEXT_SIZE_MAX);
    expect(out.project.media[2]).toBe(p.media[2]);
    // Not drawing damage: the drawing notice stays quiet.
    expect(out.notes).toEqual([]);
    expect(out.droppedStrokes).toBe(0);
  });

  it("words the note for one and for many", () => {
    expect(shortenedTextNote(1)).toBe("Shortened a text layer over the length limit.");
    expect(shortenedTextNote(3)).toBe("Shortened 3 text layers over the length limit.");
  });
});

/* ------------------------------------------------------------------ */

describe("setTextGen", () => {
  const origin = (p: ProjectFile, id: string): [number, number] => {
    const l = findLayer(p, id)!;
    const m = layerToCanvas(l.transform, l.media.width!, l.media.height!, p.timeline.width, p.timeline.height);
    return [m[4], m[5]];
  };

  it("keeps the box's top-left where it is on the canvas as the box grows", () => {
    const p0 = project(gen());
    const id = layersOf(p0)[0]!.trackId;
    const before = origin(p0, id);
    const next = gen({ text: "Hi there\nsecond" });
    const p1 = setTextGen(p0, id, next, 164, 76);
    const l = findLayer(p1, id)!;
    expect(l.media.generator).toBe(next);
    expect([l.media.width, l.media.height]).toEqual([164, 76]);
    expect(origin(p1, id)).toEqual(before);
    // The label follows the text.
    expect(l.media.path).toBe("Text — Hi there second");
  });

  it("keeps it for a scaled, turned and flipped layer too", () => {
    let p = project(gen());
    const id = layersOf(p)[0]!.trackId;
    p = setLayerTransform(p, id, { scale: 2.5, rotate: 90, flipH: true, x: -17, y: 9 });
    const before = origin(p, id);
    const after = origin(setTextGen(p, id, gen({ text: "Longer text" }), 210, 52), id);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });

  it("returns the same project when nothing changes, and for a layer that is not text", () => {
    const p = project(gen());
    const l = layersOf(p)[0]!;
    expect(setTextGen(p, l.trackId, l.media.generator as TextGen, 100, 40)).toBe(p);
    const solid = addGeneratorLayer(p, { type: "solid", color: "#123456" }, 50, 60, "Solid");
    expect(setTextGen(solid.project, solid.trackId, gen(), 10, 10)).toBe(solid.project);
    expect(setTextGen(p, "nope", gen(), 10, 10)).toBe(p);
  });
});

describe("addTextLayer", () => {
  it("puts the box's left edge at the click and the first line's middle on it, on whole pixels", () => {
    const p = createBlankImageProject("Card", 301, 203, "#ffffff");
    const g = gen({ sizePx: 40, text: "" });
    // 40 px text: one line is 50 px high.
    const r = addTextLayer(p, g, 2, 50, { x: 120.3, y: 77 }, { above: null });
    const l = findLayer(r.project, r.trackId)!;
    expect(l.name).toBe("Text");
    expect(l.kind).toBe("text");
    const m = layerToCanvas(l.transform, 2, 50, 301, 203);
    // Left edge at x (to the whole pixel), top = y − 25.
    expect(m[4]).toBe(120);
    expect(m[5]).toBe(52);
    expect(Number.isInteger(m[4]) && Number.isInteger(m[5])).toBe(true);
    expect(l.transform.scale).toBe(1);
    expect(l.transform.rotate).toBe(0);
  });

  it("goes directly above the given layer, and centres when there is no point", () => {
    let p = project(gen({ text: "A" }), gen({ text: "B" }));
    const [top, bottom] = layersOf(p).map((l) => l.trackId);
    const r = addTextLayer(p, gen({ text: "" }), 2, 38, null, { above: bottom });
    p = r.project;
    expect(layersOf(p).map((l) => l.trackId)).toEqual([top, r.trackId, bottom]);
    const l = findLayer(p, r.trackId)!;
    const m = layerToCanvas(l.transform, 2, 38, 301, 203);
    // Centred, nudged onto whole pixels (an even box on an odd canvas).
    expect(Math.abs(m[4] + 1 - 150.5)).toBeLessThanOrEqual(0.5);
    expect(Number.isInteger(m[4]) && Number.isInteger(m[5])).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("the tool's defaults and style patches", () => {
  it("a new text is the tool's size on screen in source px, its colour and font", () => {
    const tools = {
      ...DEFAULT_TOOL_STATE,
      colors: { ...DEFAULT_TOOL_STATE.colors, text: "#E5484D" },
      sizes: { ...DEFAULT_TOOL_STATE.sizes, text: 30 },
      font: { legacy: "Segoe UI" as const, fontId: "lib:Inter" },
    };
    // 30 css px at dpr 1.5 and zoom 0.5 = 90 source px.
    const g = newTextGen(tools, 1.5, 0.5);
    expect(g).toEqual({ type: "text", text: "", fontFamily: "Segoe UI", fontId: "lib:Inter", sizePx: 90, color: "#e5484d", bold: false, italic: false });
    // A legacy font: no fontId key at all.
    expect("fontId" in newTextGen(DEFAULT_TOOL_STATE, 1, 1)).toBe(false);
    expect(newTextGen(DEFAULT_TOOL_STATE, 1, 1).sizePx).toBe(DEFAULT_TOOL_STATE.sizes.text);
    // Clamped into the layer range at an extreme zoom.
    expect(newTextGen(tools, 1, 0.001).sizePx).toBe(TEXT_SIZE_MAX);
  });

  it("uiTextSize rounds and clamps", () => {
    expect(uiTextSize(12.6)).toBe(13);
    expect(uiTextSize(0)).toBe(TEXT_SIZE_MIN);
    expect(uiTextSize(1e9)).toBe(TEXT_SIZE_MAX);
  });

  it("applyTextStyle changes only what the patch names, and is the same object for no change", () => {
    const g = gen({ bold: false });
    expect(applyTextStyle(g, {})).toBe(g);
    expect(applyTextStyle(g, { sizePx: 30, color: "#ABCDEF", bold: false })).toBe(g);
    expect(applyTextStyle(g, { sizePx: 64 })).toEqual(gen({ bold: false, sizePx: 64 }));
    expect(applyTextStyle(g, { color: "#00FF00" })).toEqual(gen({ bold: false, color: "#00ff00" }));
    expect(applyTextStyle(g, { italic: true })).toEqual(gen({ bold: false, italic: true }));
    expect(applyTextStyle(g, { font: { legacy: "Arial" } })).toEqual(gen({ bold: false, fontFamily: "Arial" }));
    // An unreadable colour is ignored rather than stored.
    expect(applyTextStyle(g, { color: "nope" })).toBe(g);
  });

  it("Impact has no bold or italic face: both go off", () => {
    const out = applyTextStyle(gen({ bold: true, italic: true }), { font: { legacy: "Impact" } });
    expect(out).toEqual(gen({ fontFamily: "Impact", bold: false, italic: false }));
    expect(applyTextStyle(gen({ fontFamily: "Impact", bold: false }), { bold: true }).bold).toBe(false);
  });

  it("readText drops only Chromium's placeholder <br>, and turns tabs into spaces", () => {
    const el = (innerText: string, lastTag?: string) =>
      ({ innerText, textContent: innerText, lastChild: lastTag ? { tagName: lastTag } : { nodeType: 3 } }) as unknown as HTMLElement;
    expect(readText(el("a\nb\n", "BR"))).toBe("a\nb");
    expect(readText(el("a\nb\n"))).toBe("a\nb\n");
    expect(readText(el("a\tb\r\nc"))).toBe("a b\nc");
    expect(readText(el("z".repeat(TEXT_MAX_CHARS + 5)))).toHaveLength(TEXT_MAX_CHARS);
  });
});

/* ------------------------------------------------------------------ */

describe("textLayerAt", () => {
  it("finds the topmost visible text layer under the point, skipping hidden and 0% ones", () => {
    let p = project(gen({ text: "low" }), gen({ text: "high" }));
    const [high, low] = layersOf(p).map((l) => l.trackId);
    // Both 100×40 boxes are centred on the 301×203 canvas.
    const W = 301;
    const H = 203;
    expect(textLayerAt(layersOf(p), W, H, 150, 101)?.trackId).toBe(high);
    expect(textLayerAt(layersOf(p), W, H, 10, 10)).toBeNull();
    p = setLayerHidden(p, high!, true);
    expect(textLayerAt(layersOf(p), W, H, 150, 101)?.trackId).toBe(low);
    p = setLayerTransform(p, low!, { opacity: 0 });
    expect(textLayerAt(layersOf(p), W, H, 150, 101)).toBeNull();
  });

  it("reads each layer's own pose, not only the list order", () => {
    let p = project(gen({ text: "low" }), gen({ text: "high" }));
    const [high, low] = layersOf(p).map((l) => l.trackId);
    const W = 301;
    const H = 203;
    // The top box moved 60 px right and scaled ×0.5 (50×20 around x 210):
    // a point under the bottom box only, one under both, one under neither.
    p = setLayerTransform(p, high!, { x: 60, scale: 0.5 });
    const xs = layerToCanvas(findLayer(p, high!)!.transform, 100, 40, W, H);
    const left = xs[4];
    expect(left).toBeGreaterThan(150);
    expect(textLayerAt(layersOf(p), W, H, 120, 101)?.trackId).toBe(low);
    expect(textLayerAt(layersOf(p), W, H, left + 5, 101)?.trackId).toBe(high);
    expect(textLayerAt(layersOf(p), W, H, left + 5, 101 + 15)?.trackId).toBe(low);
    expect(textLayerAt(layersOf(p), W, H, left + 45, 101)?.trackId).toBe(high);
    expect(textLayerAt(layersOf(p), W, H, left + 55, 101)).toBeNull();
  });

  it("never picks a layer that is not text", () => {
    const p = addGeneratorLayer(project(), { type: "solid", color: "#123456" }, 301, 203, "Solid").project;
    expect(textLayerAt(layersOf(p), 301, 203, 150, 101)).toBeNull();
  });
});

describe("editMatrix", () => {
  it("is the view's scale and offset applied to the layer matrix", () => {
    const out = editMatrix([0, 2, -2, 0, 30, 40], { ox: 5, oy: 7, sx: 0.5, sy: 0.25 });
    // a = sx·0, b = sy·2, c = sx·−2, d = sy·0, e = 5 + 0.5·30, f = 7 + 0.25·40
    expect(out.css).toBe("matrix(0, 0.5, -1, 0, 20, 17)");
    expect(out.px).toBeCloseTo(0.5, 12);
  });
});
