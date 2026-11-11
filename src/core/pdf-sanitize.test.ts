// A PDF text mark's optional `fontId` (0.9.4 font library) through load-time
// sanitation: kept when well-shaped, removed alone when not, never invented;
// the rule on the legacy `font` is unchanged.

import { describe, expect, it } from "vitest";
import { createPdfProject } from "./pdf-project";
import { checkPdfInvariants, sanitizePdfAnnot } from "./pdf-sanitize";
import type { PdfAnnot } from "./types";
import { PDF_TEXT_MAX_RUNS } from "./types";

/** A 0.9.3 text mark: every field differs from the defaults a sanitizer
 *  could fill in. */
const mark = (): Record<string, unknown> => ({
  id: "t1",
  t: "text",
  x: 11,
  y: 22,
  w: 133,
  h: 44,
  text: "Hello",
  font: "Georgia",
  size: 17,
  c: "#123456",
  bold: true,
  italic: false,
  align: "center",
});
const clean = (raw: Record<string, unknown>): PdfAnnot | null => sanitizePdfAnnot(raw, new Set());

describe("a text mark's fontId on load", () => {
  it("keeps a well-shaped fontId (installed and library) beside the legacy font", () => {
    expect(clean({ ...mark(), fontId: "Consolas" })).toStrictEqual({ ...mark(), fontId: "Consolas" });
    expect(clean({ ...mark(), fontId: "lib:Inter" })).toMatchObject({ font: "Georgia", fontId: "lib:Inter" });
  });

  it.each([
    ["empty", ""],
    ["bare lib:", "lib:"],
    ["leading space", " Consolas"],
    ["control character", "Cons\u0007olas"],
    ["too long", "x".repeat(97)],
    ["a number", 42],
    ["null", null],
    ["an object", { id: "Consolas" }],
  ])("removes an ill-shaped fontId (%s) and keeps the mark with its legacy font", (_why, bad) => {
    const out = clean({ ...mark(), fontId: bad });
    expect(out).toStrictEqual(mark());
    expect("fontId" in out!).toBe(false);
  });

  it("an absent fontId stays absent: a 0.9.3 mark comes back unchanged", () => {
    const out = clean(mark());
    expect(out).toStrictEqual(mark());
    expect("fontId" in out!).toBe(false);
  });

  it("a mark whose legacy font is unknown is still dropped, whatever its fontId", () => {
    expect(clean({ ...mark(), font: "Consolas", fontId: "Consolas" })).toBeNull();
  });

  it("checkPdfInvariants reports a fontId the sanitizer would remove, and passes a good one", () => {
    const p = createPdfProject("x", { path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: 1 });
    const id = p.pdf!.pages[0]!.id;
    const withMark = (a: Record<string, unknown>) => ({ ...p, pdf: { ...p.pdf!, annots: { [id]: [a as unknown as PdfAnnot] } } });
    expect(checkPdfInvariants(withMark({ ...mark(), fontId: "lib:" }))).toContain("mark t1: invalid fontId");
    expect(checkPdfInvariants(withMark({ ...mark(), fontId: "lib:Inter" }))).toEqual([]);
  });
});

describe("a text mark's style runs on load (0.9.4)", () => {
  // mark(): text "Hello", Georgia 17 #123456, bold ON, italic off
  const R1 = { s: 1, e: 3, c: "#aa0000" };
  const R2 = { s: 3, e: 5, size: 23, italic: true };
  const runsOf = (raw: Record<string, unknown>): unknown => {
    const out = clean(raw) as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    return out!.runs;
  };

  it("keeps good runs", () => {
    expect(runsOf({ ...mark(), runs: [R1, R2] })).toEqual([R1, R2]);
  });

  it("a 0.9.3 mark (no runs key) comes back exactly as before", () => {
    const out = clean(mark());
    expect(out).toStrictEqual(mark());
    expect("runs" in out!).toBe(false);
  });

  it.each([
    ["not an array", { s: 1, e: 3 }],
    // each beside a good run, so "the WHOLE array" is what is checked
    ["non-integer s", [{ ...R1, s: 1.5 }, R2]],
    ["negative s", [{ ...R1, s: -1 }, R2]],
    ["e past the text", [R1, { ...R2, e: 6 }]],
    ["empty range", [{ ...R1, e: 1 }, R2]],
    ["unsorted", [R2, R1]],
    ["overlapping", [{ ...R1, e: 4 }, R2]],
    ["not a record", [R1, "x"]],
  ])("a structural fault (%s) drops the whole array and keeps the box", (_why, runs) => {
    const out = clean({ ...mark(), runs });
    expect(out).toStrictEqual(mark());
  });

  it("a split surrogate pair drops the whole array", () => {
    const m = { ...mark(), text: "a\u{1F600}b" }; // pair at [1, 3)
    expect(clean({ ...m, runs: [{ s: 2, e: 4, c: "#aa0000" }] })).toStrictEqual(m);
    expect(clean({ ...m, runs: [{ s: 0, e: 2, c: "#aa0000" }] })).toStrictEqual(m);
    expect(runsOf({ ...m, runs: [{ s: 1, e: 3, c: "#aa0000" }] })).toEqual([{ s: 1, e: 3, c: "#aa0000" }]);
  });

  it(`more than ${PDF_TEXT_MAX_RUNS} runs drops the whole array`, () => {
    const text = "x".repeat(2 * PDF_TEXT_MAX_RUNS + 4);
    const many = Array.from({ length: PDF_TEXT_MAX_RUNS + 1 }, (_, k) => ({ s: 2 * k, e: 2 * k + 1, bold: false }));
    expect(runsOf({ ...mark(), text, runs: many })).toBeUndefined();
    expect(runsOf({ ...mark(), text, runs: many.slice(1) })).toHaveLength(PDF_TEXT_MAX_RUNS);
  });

  it.each([
    ["font off the whitelist", { font: "Comic Sans" }],
    ["size too small", { size: 3 }],
    ["size too big", { size: 289 }],
    ["size not a number", { size: "20" }],
    ["unreadable colour", { c: "red" }],
    ["bold not a boolean", { bold: 1 }],
    ["italic not a boolean", { italic: "yes" }],
  ])("a bad field (%s) drops that field only", (_why, bad) => {
    // every field set, none equal to the box's own style
    const full: Record<string, unknown> = { s: 1, e: 4, font: "Arial", size: 23, c: "#aa0000", bold: false, italic: true };
    const want = { ...full };
    delete want[Object.keys(bad)[0]!];
    expect(runsOf({ ...mark(), runs: [{ ...full, ...bad }] })).toEqual([want]);
  });

  it("a fontId is kept only well-shaped AND beside a valid font", () => {
    expect(runsOf({ ...mark(), runs: [{ s: 1, e: 3, font: "Segoe UI", fontId: "Consolas" }] })).toEqual([
      { s: 1, e: 3, font: "Segoe UI", fontId: "Consolas" },
    ]);
    expect(runsOf({ ...mark(), runs: [{ s: 1, e: 3, font: "Segoe UI", fontId: " Consolas" }] })).toEqual([
      { s: 1, e: 3, font: "Segoe UI" },
    ]);
    // no font: the fontId goes, and the run with it (nothing left)
    expect(runsOf({ ...mark(), runs: [{ s: 1, e: 3, fontId: "Consolas" }, R2] })).toEqual([R2]);
  });

  it("a colour is stored lowercase #rrggbb; unknown keys are not copied", () => {
    expect(runsOf({ ...mark(), runs: [{ s: 1, e: 3, c: "#ABC", evil: 1 }] })).toEqual([{ s: 1, e: 3, c: "#aabbcc" }]);
  });

  it("a run left empty is dropped; none left = no key", () => {
    expect(runsOf({ ...mark(), runs: [{ s: 1, e: 3, c: "nope" }, R2] })).toEqual([R2]);
    const out = clean({ ...mark(), runs: [{ s: 1, e: 3, c: "nope" }] });
    expect("runs" in out!).toBe(false);
  });

  it("then the canonical form: a field equal to the box's style goes, neighbours merge", () => {
    // size 17 and bold true are the box's own
    expect(runsOf({ ...mark(), runs: [{ s: 1, e: 2, size: 17, c: "#aa0000" }, { s: 2, e: 3, bold: true, c: "#aa0000" }] })).toEqual([R1]);
    expect("runs" in clean({ ...mark(), runs: [{ s: 1, e: 3, size: 17 }] })!).toBe(false);
  });

  it("checkPdfInvariants reports runs the sanitizer would remove, and passes good ones", () => {
    const p = createPdfProject("x", { path: "C:\a.pdf", size: 1, mtimeMs: 1, pages: 1 });
    const id = p.pdf!.pages[0]!.id;
    const withMark = (a: Record<string, unknown>) => ({ ...p, pdf: { ...p.pdf!, annots: { [id]: [a as unknown as PdfAnnot] } } });
    expect(checkPdfInvariants(withMark({ ...mark(), runs: [R2, R1] }))).toContain("mark t1: invalid runs");
    expect(checkPdfInvariants(withMark({ ...mark(), runs: [R1, R2] }))).toEqual([]);
  });
});
