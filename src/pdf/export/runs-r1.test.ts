// Invariant R1 (0.9.4 style runs): a text box WITHOUT `runs` exports exactly
// as before the feature. The snapshot file was written by the 0.9.3/0.9.4
// pre-runs `textAppearance` and must never be updated to follow a change:
// a diff here means a run-less box changed.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PdfAnnot } from "../../core/types";
import { appear, CONSOLAS, consolas, hasFont, nodeDeps, textBox, type TestDeps } from "./testkit";

describe.skipIf(!hasFont("Georgia") || !hasFont("Arial") || !hasFont("Impact") || !existsSync(CONSOLAS))("R1: run-less text boxes", () => {
  const cases: [string, Partial<Extract<PdfAnnot, { t: "text" }>>, TestDeps?][] = [
    ["one line", {}],
    ["multi-line wrapped, newline, empty paragraph", { text: "The quick brown fox jumps over the lazy dog\n\nand away", w: 150, h: 200 }],
    ["a word wider than the box breaks between characters", { text: "Supercalifragilisticexpialidocious", w: 60 }],
    ["right-aligned, bold italic", { text: "Right side\nsecond", align: "right", bold: true, italic: true, c: "#a01020" }],
    ["centred, turned 90, fill and border", { text: "Turned box", align: "center", r: 90, bg: "#ffeecc", border: "#3366ff" }],
    ["an RTL paragraph", { text: "שלום עולם and English", font: "Arial", w: 300 }],
    ["a wrapped RTL paragraph", { text: "שלום עולם זה טקסט ארוך מאוד", font: "Arial", w: 70, h: 200 }],
    ["Impact bold draws plain", { text: "Impact", font: "Impact", bold: true }],
    ["clipped below the frame", { text: "a\nb\nc\nd\ne\nf\ng\nh", h: 40 }],
    ["empty text", { text: "" }],
    ["a library font", { text: "Library font text", fontId: "lib:Consolas", bold: true }],
    ["Arabic raster", { text: "مرحبا بالعالم", fontId: "lib:Consolas", italic: true }],
  ];
  for (const [name, over] of cases) {
    it(name, async () => {
      const deps = nodeDeps({ resolveFonts: consolas("full") });
      const out = await appear(textBox(over), deps);
      expect({ ...out, resolveCalls: deps.resolveCalls }).toMatchSnapshot();
    });
  }
});
