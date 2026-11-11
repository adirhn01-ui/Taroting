// A wrapped paragraph with right-to-left text: each laid-out line draws
// exactly its own characters, in visual order. bidi-js's getReorderedString
// returns the WHOLE paragraph with only the [start, end] line reordered in
// place, so before 0.9.4 every line of such a paragraph drew all of it
// (text boxes without style runs, and multi-line form fields).

import { decodePDFRawStream, PDFDict, PDFName, PDFRawStream, type PDFStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfAnnot } from "../../core/types";
import { paragraphBidi, visualGroups, visualLine } from "./bidi";
import { buildPdf } from "./export";
import { apStream, hasFixture, hasFont, nodeDeps, pg, project, rawAnnots, source, textBox } from "./testkit";

const KEPT = { flattenMarks: false, flattenForms: false };
const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);
const contents = (s: PDFStream): Uint8Array => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());

/** The characters each `Tm … Tj` of an appearance draws, decoded through
 *  its F0 font's ToUnicode map, grouped by baseline (top line first). */
function drawnLines(s: PDFStream): string[] {
  const fonts = s.dict.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("Font"), PDFDict);
  const tu = fonts.lookup(PDFName.of("F0"), PDFDict).lookup(PDFName.of("ToUnicode")) as PDFStream;
  const map = new Map<string, string>();
  for (const m of latin1(contents(tu)).matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]+)>/g)) {
    const units = m[2]!.match(/.{4}/g)!.map((h) => parseInt(h, 16));
    map.set(m[1]!.toUpperCase(), String.fromCharCode(...units));
  }
  const byY = new Map<number, string>();
  for (const m of latin1(contents(s)).matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm <([0-9A-F]*)> Tj/g)) {
    const y = Number(m[1]);
    const text = (m[2]!.match(/.{4}/g) ?? []).map((g) => map.get(g) ?? "?").join("");
    byY.set(y, (byY.get(y) ?? "") + text);
  }
  return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([, t]) => t);
}

async function boxLines(a: PdfAnnot): Promise<string[]> {
  const plain = source("plain_3p.pdf");
  const page = pg(plain, 0);
  const bytes = await buildPdf(project([plain], [page], { [page.id]: [a] }), KEPT, nodeDeps());
  const { doc, annots } = await rawAnnots(bytes, 0);
  return drawnLines(apStream(doc, annots[0]!)!);
}

// An RTL paragraph (first strong is Hebrew) with a Latin word in each half.
const MIXED = "שלום abc עולם def";

describe("visualLine on one line of a paragraph", () => {
  it("returns only that line's characters, in visual order", () => {
    const p = paragraphBidi(MIXED);
    expect(visualLine(p, 0, 9)).toBe(" abc םולש");
    expect(visualLine(p, 9, 17)).toBe("def םלוע");
    // the whole paragraph as one line is unchanged
    expect(visualLine(p, 0, 17)).toBe("def םלוע abc םולש");
  });

  it("mirrors brackets and keeps surrogate pairs whole at a line's edges", () => {
    const text = "א(ב) 😀ג דה";
    const p = paragraphBidi(text);
    expect(visualLine(p, 0, 5)).toBe(" (ב)א");
    expect(visualLine(p, 5, text.length)).toBe("הד ג😀");
  });

  it("a single-character line and a left-to-right line are their own slice", () => {
    const p = paragraphBidi(MIXED);
    expect(visualLine(p, 0, 1)).toBe("ש");
    const l = paragraphBidi("plain english words");
    expect(visualLine(l, 6, 13)).toBe("english");
  });
});

describe.skipIf(!hasFixture("plain_3p.pdf") || !hasFont("Arial"))("a wrapped right-to-left text box", () => {
  it("without runs: each line draws only its own characters", async () => {
    const lines = await boxLines(textBox({ text: MIXED, font: "Arial", w: 70, h: 200 }));
    expect(lines).toEqual(["abc םולש", "def םלוע"]);
  });

  it("with a colour run on one Latin word: the same characters on the same lines as without", async () => {
    const box = { text: MIXED, font: "Arial" as const, w: 70, h: 200 };
    const plain = await boxLines(textBox(box));
    const runs = await boxLines(textBox({ ...box, runs: [{ s: 14, e: 17, c: "#ff0000" }] }));
    expect(runs).toEqual(plain);
    // and visualGroups agrees with visualLine line by line
    const p = paragraphBidi(MIXED);
    for (const [s, e] of [[0, 9], [9, 17], [0, 17]] as const) {
      expect(visualGroups(p, s, e, (i) => (i >= 14 ? 1 : 0)).map((g) => g.text).join("")).toBe(visualLine(p, s, e));
    }
  });
});

describe.skipIf(!hasFixture("form_text_kinds.pdf") || !hasFont("Arial"))("a wrapped right-to-left multi-line form field", () => {
  it("each line draws only its own characters", async () => {
    const src = source("form_text_kinds.pdf");
    const words = ["אחת", "one", "שתיים", "two", "שלוש", "three", "ארבע", "four", "חמש", "five", "שש", "six", "שבע", "seven", "שמונה", "eight"];
    const value = words.join(" ");
    const bytes = await buildPdf(project([src], [pg(src, 0)], {}, { [src.id]: { "9R": value } }), KEPT, nodeDeps());
    const { doc, annots } = await rawAnnots(bytes, 0);
    const w = annots.find((a) => {
      const parent = a.lookup(PDFName.of("Parent"));
      const t = (parent instanceof PDFDict ? parent : a).lookup(PDFName.of("T")) as { decodeText?(): string } | undefined;
      return t?.decodeText?.() === "notes";
    })!;
    const lines = drawnLines(apStream(doc, w)!);
    expect(lines.length).toBeGreaterThanOrEqual(2); // it wraps
    // every word drawn exactly once across the lines, each whole on one line
    const drawn = lines.join(" ").split(/ +/).filter(Boolean);
    const flip = (x: string): string => [...x].reverse().join("");
    expect(drawn.map((x) => (/[א-ת]/.test(x) ? flip(x) : x)).sort()).toEqual([...words].sort());
    expect(lines.join("").replace(/ /g, "").length).toBe(value.replace(/ /g, "").length);
  });
});
