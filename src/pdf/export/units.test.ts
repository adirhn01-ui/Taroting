// Pure parts of PDF export: the extract plan, line breaking, bidi, EXIF
// orientation, widget placement, the chunked writer.

import { describe, expect, it } from "vitest";
import type { PdfPage } from "../../core/types";
import { firstStrongRtl, hasArabic, paragraphBidi, visualLine } from "./bidi";
import { PdfExportError } from "./errors";
import { flattenForms, widgetPlacement } from "./flatten";
import { displayedOf, exifOrientation } from "./images";
import { wrapParagraph } from "./layout";
import { embedWithMetrics, encodeVisual, hexRgb, imageMatrix, num } from "./marks";
import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName } from "pdf-lib";
import { fontFile, hasFont } from "./testkit";
import { planExtract } from "./plan";
import { PDF_CHUNK_BYTES, writePdf, type PdfSaveIpc } from "./write";

const P = (src: string | null, page: number): PdfPage => ({ id: `${src}:${page}:${Math.random()}`, src, page, rotate: 0 });

describe("planExtract", () => {
  it("reorders one source with ONE entry: sorted includes, slots carried along", () => {
    const plan = planExtract([P("a", 2), P("a", 0), P("a", 1)]);
    expect(plan.primary).toBe("a");
    expect(plan.entries).toEqual([{ src: "a", includePages: [0, 1, 2], pageIndices: [1, 2, 0] }]);
  });

  it("a page used twice goes into a second entry", () => {
    const plan = planExtract([P("a", 0), P("a", 1), P("a", 0)]);
    expect(plan.entries).toEqual([
      { src: "a", includePages: [0, 1], pageIndices: [0, 1] },
      { src: "a", includePages: [0], pageIndices: [2] },
    ]);
  });

  it("leaves blank pages out of the dense slot numbering", () => {
    const plan = planExtract([P(null, 0), P("b", 3), P(null, 0), P("a", 1)]);
    expect(plan.primary).toBe("b");
    expect(plan.slotOf).toEqual([-1, 0, -1, 1]);
    expect(plan.entries).toEqual([
      { src: "b", includePages: [3], pageIndices: [0] },
      { src: "a", includePages: [1], pageIndices: [1] },
    ]);
  });

  it("applies the range before planning; the primary is the first source IN the range", () => {
    const plan = planExtract([P("a", 0), P("b", 0), P("b", 1)], [2, 3]);
    expect(plan.pages.map((p) => p.src)).toEqual(["b", "b"]);
    expect(plan.primary).toBe("b");
    expect(plan.entries).toEqual([{ src: "b", includePages: [0, 1], pageIndices: [0, 1] }]);
  });

  it("refuses a bad range and an empty document", () => {
    for (const r of [[0, 1], [2, 1], [1, 4], [1.5, 2]] as [number, number][]) {
      expect(() => planExtract([P("a", 0), P("a", 1), P("a", 2)], r)).toThrow(PdfExportError);
    }
    expect(() => planExtract([])).toThrow(/no pages/);
  });

  it("an all-blank output has no primary and no entries", () => {
    const plan = planExtract([P(null, 0)]);
    expect(plan.primary).toBeNull();
    expect(plan.entries).toEqual([]);
  });
});

describe("wrapParagraph", () => {
  const mono = (s: string): number => s.length; // 1 unit per char
  const lines = (s: string, w: number): string[] => wrapParagraph(s, w, mono).map(([a, b]) => s.slice(a, b));

  it("breaks after whitespace and drops trailing spaces from the line", () => {
    expect(lines("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(lines("aaa bbb ccc", 100)).toEqual(["aaa bbb ccc"]);
  });

  it("breaks a word wider than the box between characters", () => {
    expect(lines("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(lines("xx abcdefgh y", 3)).toEqual(["xx", "abc", "def", "gh", "y"]);
  });

  it("an empty paragraph is one empty line", () => {
    expect(wrapParagraph("", 10, mono)).toEqual([[0, 0]]);
  });
});

describe("bidi", () => {
  const vis = (s: string): string => visualLine(paragraphBidi(s), 0, s.length);

  it("reverses a Hebrew word into visual order", () => {
    expect(vis("שלום")).toBe("םולש");
  });

  it("keeps Latin runs in place inside a left-to-right paragraph", () => {
    expect(vis("abc שלום def")).toBe("abc םולש def");
  });

  it("puts a Latin run on the left end of a right-to-left paragraph's reading start", () => {
    // RTL paragraph: "שלום abc" reads right to left, so visually abc comes first (left)
    expect(vis("שלום abc")).toBe("abc םולש");
  });

  it("mirrors brackets in a right-to-left run", () => {
    expect(vis("(שלום)")).toBe("(םולש)");
  });

  it("leaves pure Latin untouched", () => {
    expect(vis("Hello (world)")).toBe("Hello (world)");
  });

  it("detects direction and Arabic", () => {
    expect(firstStrongRtl("123 שלום abc")).toBe(true);
    expect(firstStrongRtl("abc שלום")).toBe(false);
    expect(hasArabic("Hi مرحبا")).toBe(true);
    expect(hasArabic("שלום Hello")).toBe(false);
  });
});

describe("EXIF orientation", () => {
  function jpegWithOrientation(o: number, le: boolean): Uint8Array {
    const tiff = le
      ? [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0]
      : [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = app1.length + 2;
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xda, 0, 2]);
  }

  it("reads the tag from a JPEG's APP1 in either byte order", () => {
    expect(exifOrientation(jpegWithOrientation(6, true))).toBe(6);
    expect(exifOrientation(jpegWithOrientation(8, false))).toBe(8);
    expect(exifOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda]))).toBe(1);
    expect(exifOrientation(new Uint8Array(3))).toBe(1);
  });

  it("orientation 6 (turned 90° clockwise) maps the image's top-left to the box's top-right", () => {
    // image space (u, v up): top-left is (0, 1)
    expect(displayedOf(6, 0, 1)).toEqual([1, 0]);
    expect(displayedOf(1, 0, 1)).toEqual([0, 0]);
    // the matrix for a 100x50 box at (10,20)-(110,70): unit square corner
    // (0,0) (image bottom-left) lands at the box's top-left under 6
    expect(imageMatrix([10, 20, 110, 70], 6)).toBe("0 -50 100 0 10 70");
    expect(imageMatrix([10, 20, 110, 70], 1)).toBe("100 0 0 50 10 20");
  });
});

describe("widgetPlacement (ISO 32000 12.5.5)", () => {
  it("maps the BBox straight onto the Rect without a Matrix", () => {
    expect(widgetPlacement([100, 200, 300, 220], [0, 0, 200, 20], null)).toEqual([1, 0, 0, 1, 100, 200]);
    expect(widgetPlacement([100, 200, 300, 220], [0, 0, 100, 10], null)).toEqual([2, 0, 0, 2, 100, 200]);
  });

  it("honours a rotating Matrix: the transformed box, not the raw BBox, maps to the Rect", () => {
    // a 90° widget (/MK /R 90): BBox 200×20, Matrix [0 1 -1 0 20 0] turns it to 20×200
    const cm = widgetPlacement([50, 100, 70, 300], [0, 0, 200, 20], [0, 1, -1, 0, 20, 0])!;
    // the transformed box is (0,0)-(20,200): identity scale, moved to (50,100)
    expect(cm).toEqual([1, 0, 0, 1, 50, 100]);
  });

  it("no area → nothing to draw", () => {
    expect(widgetPlacement([0, 0, 0, 10], [0, 0, 10, 10], null)).toBeNull();
  });
});

describe("flattenForms", () => {
  it("paints visible widgets, skips hidden ones, drops every widget and the AcroForm", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const shown = form.createTextField("shown");
    shown.setText("visible");
    shown.addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    const hidden = form.createTextField("hidden");
    hidden.setText("secret");
    hidden.addToPage(page, { x: 10, y: 50, width: 100, height: 20, hidden: true });
    form.updateFieldAppearances();
    const painted = flattenForms(doc);
    expect(painted).toBe(1);
    expect(page.node.Annots()).toBeUndefined();
    expect(doc.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
  });
});

describe("number and colour formatting", () => {
  it("never writes exponents or negative zero", () => {
    expect(num(1e-9)).toBe("0");
    expect(num(-0.0001)).toBe("0");
    expect(num(1234567.891)).toBe("1234567.891");
    expect(num(2.5)).toBe("2.5");
    expect(num(NaN)).toBe("0");
  });
  it("parses #rrggbb and falls back on anything else", () => {
    expect(hexRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexRgb("red", [0, 0, 1])).toEqual([0, 0, 1]);
  });
});

describe.skipIf(!hasFont())("encodeVisual", () => {
  it("keeps a visual-order Hebrew run in the order given (fontkit alone reverses it)", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(fontFile("Arial", false, false)), { subset: true });
    const one = (ch: string): string => font.encodeText(ch).toString().slice(1, -1);
    const visual = "םולש";
    expect(encodeVisual(font, visual)).toBe(`<${[...visual].map(one).join("")}>`);
    // the trap this avoids: whole-string encoding comes out reversed
    expect(font.encodeText(visual).toString()).toBe(`<${[...visual].reverse().map(one).join("")}>`);
    // a Latin line is encoded whole
    expect(encodeVisual(font, "abc")).toBe(font.encodeText("abc").toString());
  });
});

describe.skipIf(!hasFont())("font metrics", () => {
  it("reads ascent/descent in em from the face (Arial: 1854/2048 up, 434/2048 down)", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const m = await embedWithMetrics(doc, readFileSync(fontFile("Arial", false, false)));
    expect(m.ascent * 1000).toBeCloseTo(905.27, 1);
    expect(m.descent * 1000).toBeCloseTo(211.91, 1);
  });
});

describe("writePdf", () => {
  function fakeIpc(failChunk = -1) {
    const calls: string[] = [];
    const chunks: number[] = [];
    const io: PdfSaveIpc = {
      async pdfSaveBegin(dest, total) {
        calls.push(`begin ${dest.path} ${dest.sources.join("|")} ${total}`);
        return { token: 7, path: dest.path };
      },
      async imageSaveChunk(token, bytes) {
        if (chunks.length === failChunk) throw { code: "io", message: "disk full" };
        calls.push(`chunk ${token}`);
        chunks.push(bytes.length);
      },
      async imageSaveCommit(token) {
        calls.push(`commit ${token}`);
        return { token, path: "C:/out/final.pdf" };
      },
      async imageSaveAbort(token) {
        calls.push(`abort ${token}`);
      },
    };
    return { io, calls, chunks };
  }

  it("begins with the sources, streams 4 MiB chunks, commits", async () => {
    const f = fakeIpc();
    const bytes = new Uint8Array(PDF_CHUNK_BYTES * 2 + 5);
    const path = await writePdf(f.io, "C:/out/x.pdf", ["C:/a.pdf", "C:/b.png"], bytes);
    expect(path).toBe("C:/out/final.pdf");
    expect(f.calls[0]).toBe(`begin C:/out/x.pdf C:/a.pdf|C:/b.png ${bytes.length}`);
    expect(f.chunks).toEqual([PDF_CHUNK_BYTES, PDF_CHUNK_BYTES, 5]);
    expect(f.calls.at(-1)).toBe("commit 7");
    expect(f.calls).not.toContain("abort 7");
  });

  it("aborts on a failed chunk and rethrows the original error", async () => {
    const f = fakeIpc(1);
    await expect(writePdf(f.io, "C:/out/x.pdf", [], new Uint8Array(PDF_CHUNK_BYTES * 3))).rejects.toEqual({
      code: "io",
      message: "disk full",
    });
    expect(f.calls.at(-1)).toBe("abort 7");
    expect(f.calls).not.toContain("commit 7");
  });
});
