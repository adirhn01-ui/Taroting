import { describe, expect, it } from "vitest";
import "../core/pdf-sanitize"; // registers the PDF rules sanitizeProject dispatches to
import {
  addAnnot,
  annotBounds,
  canAddAnnots,
  canAddPages,
  clearFormValue,
  deletePages,
  dropUnusedSources,
  duplicatePages,
  formValue,
  formValues,
  insertBlankPage,
  insertSourcePages,
  moveAnnot,
  movePages,
  newId,
  pageAnnots,
  removeAnnots,
  reorderPages,
  rotatePages,
  scaleAnnot,
  setExportPreset,
  setFormValue,
  translateAnnot,
  updateAnnot,
} from "./model";
import { createPdfProject } from "../core/pdf-project";
import { checkInvariants, createProject, sanitizeProject } from "../core/project";
import { decodePoints, encodePoints } from "../image/strokes";
import type { PdfAnnot, PdfSource, ProjectFile } from "../core/types";
import { PDF_MAX_ANNOTS_PER_PAGE, PDF_MAX_PAGES } from "../core/types";

/* ---------------- fixtures ---------------- */

/** Freeze everything reachable: any write to an input then throws (ESM is
 *  strict mode), so an operation that mutates its input fails its test. */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const ink = (id: string, ...pts: number[]): PdfAnnot => ({
  id,
  t: "ink",
  kind: "pen",
  c: "#000000",
  w: 2,
  o: 1,
  p: encodePoints(new Float32Array(pts)),
});
const box = (id: string, x = 10, y = 20, w = 30, h = 40): PdfAnnot => ({ id, t: "whiteout", x, y, w, h, c: "#ffffff" });

/** 3 pages (P1..P3) of source "src" (5 pages long), marks m1+m2 on P1, m3 on
 *  P2, one form value; frozen. */
function doc(): ProjectFile {
  let n = 0;
  const p = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 5 }, {
    id: () => ["src", "P1", "P2", "P3", "P4", "P5", "proj", "trk"][n++]!,
  });
  const pdf = p.pdf!;
  const annots = Object.create(null) as Record<string, PdfAnnot[]>;
  annots.P1 = [box("m1"), ink("m2", 0, 0, 1, 10, 10, 1)];
  annots.P2 = [box("m3")];
  const forms = Object.create(null) as Record<string, Record<string, string>>;
  forms.src = Object.assign(Object.create(null) as Record<string, string>, { "1R": "Dana" });
  return deepFreeze({ ...p, pdf: { ...pdf, pages: pdf.pages.slice(0, 3), annots, forms } });
}

const pageIds = (p: ProjectFile) => p.pdf!.pages.map((pg) => pg.id);
const clean = (p: ProjectFile) => expect(checkInvariants(p)).toEqual([]);

/* ---------------- tests ---------------- */

describe("fixture", () => {
  it("is a valid PDF project", () => {
    clean(doc());
  });
});

describe("refusals return the input itself", () => {
  it("on a project that is not a PDF project", () => {
    const v = deepFreeze(createProject("v"));
    expect(addAnnot(v, "P1", box("x"))).toBe(v);
    expect(rotatePages(v, ["P1"], 90)).toBe(v);
    expect(insertBlankPage(v, 0, 100, 100)).toBe(v);
    expect(setExportPreset(v, { flattenMarks: true })).toBe(v);
    expect(dropUnusedSources(v)).toBe(v);
  });
});

describe("newId", () => {
  it("is a fresh, valid id each call", () => {
    const a = newId();
    expect(a).not.toBe(newId());
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("reads", () => {
  it("pageAnnots / formValues / formValue read own entries only", () => {
    const p = doc();
    expect(pageAnnots(p, "P1").map((a) => a.id)).toEqual(["m1", "m2"]);
    expect(pageAnnots(p, "P3")).toEqual([]);
    expect(pageAnnots(p, "constructor")).toEqual([]);
    expect(pageAnnots(p, "__proto__")).toEqual([]);
    expect(formValue(p, "src", "1R")).toBe("Dana");
    expect(formValue(p, "src", "toString")).toBeUndefined();
    expect(formValues(p, "hasOwnProperty")).toBeUndefined();
  });

  it("works on a plain-object record too (a project built elsewhere)", () => {
    const p = doc();
    const q = { ...p, pdf: { ...p.pdf!, annots: { P1: p.pdf!.annots.P1! } } };
    expect(pageAnnots(q, "constructor")).toEqual([]);
    expect(pageAnnots(q, "P1")).toHaveLength(2);
  });

  it("canAddPages / canAddAnnots say whether an add would fit", () => {
    const p = doc();
    expect(canAddPages(p, PDF_MAX_PAGES - 3)).toBe(true);
    expect(canAddPages(p, PDF_MAX_PAGES - 2)).toBe(false);
    expect(canAddAnnots(p, "P1", PDF_MAX_ANNOTS_PER_PAGE - 2)).toBe(true);
    expect(canAddAnnots(p, "P1", PDF_MAX_ANNOTS_PER_PAGE - 1)).toBe(false);
    expect(canAddAnnots(p, "nope", 1)).toBe(false);
  });
});

describe("addAnnot", () => {
  it("puts the mark on top of the page and shares everything else", () => {
    const p = doc();
    const a = box("new");
    const out = addAnnot(p, "P1", a);
    expect(pageAnnots(out, "P1").map((x) => x.id)).toEqual(["m1", "m2", "new"]);
    expect(pageAnnots(out, "P1")[2]).toBe(a);
    expect(pageAnnots(out, "P1")[0]).toBe(pageAnnots(p, "P1")[0]);
    expect(out.pdf!.annots.P2).toBe(p.pdf!.annots.P2);
    expect(out.pdf!.pages).toBe(p.pdf!.pages);
    expect(out.pdf!.forms).toBe(p.pdf!.forms);
    expect(out.timeline).toBe(p.timeline);
    expect(out.media).toBe(p.media);
    expect(Object.getPrototypeOf(out.pdf!.annots)).toBeNull();
    clean(out);
  });

  it("starts a list on a page with none", () => {
    const out = addAnnot(doc(), "P3", box("new"));
    expect(pageAnnots(out, "P3").map((x) => x.id)).toEqual(["new"]);
  });

  it("refuses an unknown page, a repeated id, and a full page", () => {
    const p = doc();
    expect(addAnnot(p, "nope", box("x"))).toBe(p);
    expect(addAnnot(p, "__proto__", box("x"))).toBe(p);
    expect(addAnnot(p, "P1", box("m1"))).toBe(p);
    const full = Object.create(null) as Record<string, PdfAnnot[]>;
    full.P1 = Array.from({ length: PDF_MAX_ANNOTS_PER_PAGE }, (_, i) => box(`f${i}`));
    const q = { ...p, pdf: { ...p.pdf!, annots: full } };
    expect(addAnnot(q, "P1", box("x"))).toBe(q);
  });
});

describe("updateAnnot", () => {
  it("merges the patch into a new mark, leaving the old one alone", () => {
    const p = doc();
    const out = updateAnnot(p, "P1", "m1", { x: 99, c: "#ff0000" });
    expect(pageAnnots(out, "P1")[0]).toEqual({ ...box("m1"), x: 99, c: "#ff0000" });
    expect(pageAnnots(p, "P1")[0]).toEqual(box("m1"));
    expect(pageAnnots(out, "P1")[1]).toBe(pageAnnots(p, "P1")[1]);
    expect(out.pdf!.annots.P2).toBe(p.pdf!.annots.P2);
  });

  it("never changes id or kind, and never adds another kind's fields", () => {
    const p = doc();
    const out = updateAnnot(p, "P1", "m1", { id: "z", t: "ink", text: "x", x: 1 } as never);
    expect(pageAnnots(out, "P1")[0]).toEqual({ ...box("m1"), x: 1 });
  });

  it("refuses an unknown page or mark, and a patch that changes nothing", () => {
    const p = doc();
    expect(updateAnnot(p, "P1", "nope", { x: 1 })).toBe(p);
    expect(updateAnnot(p, "P3", "m1", { x: 1 })).toBe(p);
    expect(updateAnnot(p, "P1", "m1", { x: 10 })).toBe(p);
    expect(updateAnnot(p, "P1", "m1", { text: "x" } as never)).toBe(p);
  });
});

describe("removeAnnots", () => {
  it("removes across pages and drops a page's entry once it is empty", () => {
    const p = doc();
    const out = removeAnnots(p, [
      { pageId: "P1", id: "m2" },
      { pageId: "P2", id: "m3" },
      { pageId: "P2", id: "nope" },
    ]);
    expect(pageAnnots(out, "P1").map((a) => a.id)).toEqual(["m1"]);
    expect(Object.keys(out.pdf!.annots)).toEqual(["P1"]);
    expect(pageAnnots(out, "P1")[0]).toBe(pageAnnots(p, "P1")[0]);
    clean(out);
  });

  it("refuses when nothing matched", () => {
    const p = doc();
    expect(removeAnnots(p, [])).toBe(p);
    expect(removeAnnots(p, [{ pageId: "P1", id: "m3" }])).toBe(p);
    expect(removeAnnots(p, [{ pageId: "__proto__", id: "m1" }])).toBe(p);
  });
});

describe("moveAnnot", () => {
  it("moves the same mark object to the top of another page", () => {
    const p = doc();
    const m = pageAnnots(p, "P1")[0]!;
    const out = moveAnnot(p, { pageId: "P1", id: "m1" }, "P2");
    expect(pageAnnots(out, "P1").map((a) => a.id)).toEqual(["m2"]);
    expect(pageAnnots(out, "P2").map((a) => a.id)).toEqual(["m3", "m1"]);
    expect(pageAnnots(out, "P2")[1]).toBe(m);
    clean(out);
  });

  it("drops the source page's entry when it empties", () => {
    const out = moveAnnot(doc(), { pageId: "P2", id: "m3" }, "P3");
    expect(Object.keys(out.pdf!.annots).sort()).toEqual(["P1", "P3"]);
  });

  it("refuses the same page, an unknown page or mark, and a full target", () => {
    const p = doc();
    expect(moveAnnot(p, { pageId: "P1", id: "m1" }, "P1")).toBe(p);
    expect(moveAnnot(p, { pageId: "P1", id: "m1" }, "nope")).toBe(p);
    expect(moveAnnot(p, { pageId: "P1", id: "zz" }, "P2")).toBe(p);
    const annots = Object.create(null) as Record<string, PdfAnnot[]>;
    annots.P1 = [box("m1")];
    annots.P2 = Array.from({ length: PDF_MAX_ANNOTS_PER_PAGE }, (_, i) => box(`f${i}`));
    const q = { ...p, pdf: { ...p.pdf!, annots } };
    expect(moveAnnot(q, { pageId: "P1", id: "m1" }, "P2")).toBe(q);
  });
});

describe("reorderPages", () => {
  it("applies a permutation, sharing the page objects and the marks", () => {
    const p = doc();
    const out = reorderPages(p, ["P3", "P1", "P2"]);
    expect(pageIds(out)).toEqual(["P3", "P1", "P2"]);
    expect(out.pdf!.pages[1]).toBe(p.pdf!.pages[0]);
    expect(out.pdf!.annots).toBe(p.pdf!.annots);
    clean(out);
  });

  it("refuses anything that is not a permutation, and the same order", () => {
    const p = doc();
    expect(reorderPages(p, ["P1", "P2"])).toBe(p);
    expect(reorderPages(p, ["P1", "P1", "P2"])).toBe(p);
    expect(reorderPages(p, ["P1", "P2", "P9"])).toBe(p);
    expect(reorderPages(p, ["P1", "P2", "P3", "P3"])).toBe(p);
    expect(reorderPages(p, ["P1", "P2", "P3"])).toBe(p);
  });
});

describe("movePages", () => {
  it("moves a block to a gap of the current list, keeping document order", () => {
    const p = doc();
    expect(pageIds(movePages(p, ["P3", "P1"], 0))).toEqual(["P1", "P3", "P2"]);
    expect(pageIds(movePages(p, ["P1"], 3))).toEqual(["P2", "P3", "P1"]);
    expect(pageIds(movePages(p, ["P1"], 2))).toEqual(["P2", "P1", "P3"]);
    expect(pageIds(movePages(p, ["P3"], 1))).toEqual(["P1", "P3", "P2"]);
    expect(pageIds(movePages(p, ["P1"], 99))).toEqual(["P2", "P3", "P1"]);
  });

  it("refuses unknown ids, a non-number gap, and a move that changes nothing", () => {
    const p = doc();
    expect(movePages(p, ["nope"], 0)).toBe(p);
    expect(movePages(p, ["P1"], NaN)).toBe(p);
    expect(movePages(p, ["P1"], 0)).toBe(p);
    expect(movePages(p, ["P1"], 1)).toBe(p);
    expect(movePages(p, ["P2", "P3"], 3)).toBe(p);
  });
});

describe("rotatePages", () => {
  it("turns the named pages mod 360, sharing the rest", () => {
    const p = doc();
    const out = rotatePages(p, ["P1", "P3"], -90);
    expect(out.pdf!.pages.map((pg) => pg.rotate)).toEqual([270, 0, 270]);
    expect(out.pdf!.pages[1]).toBe(p.pdf!.pages[1]);
    expect(out.pdf!.annots).toBe(p.pdf!.annots);
    const twice = rotatePages(rotatePages(out, ["P1"], 180), ["P1"], 90);
    expect(twice.pdf!.pages[0]!.rotate).toBe(180);
    expect(rotatePages(p, ["P2"], 90).pdf!.pages[1]!.rotate).toBe(90);
    clean(out);
  });

  it("refuses unknown ids and a delta that is not a quarter turn", () => {
    const p = doc();
    expect(rotatePages(p, ["nope"], 90)).toBe(p);
    expect(rotatePages(p, ["P1"], 45 as never)).toBe(p);
    expect(rotatePages(p, ["P1"], 0 as never)).toBe(p);
  });
});

describe("deletePages", () => {
  it("removes the pages and their marks, keeping the sources", () => {
    const p = doc();
    const out = deletePages(p, ["P1", "nope"]);
    expect(pageIds(out)).toEqual(["P2", "P3"]);
    expect(Object.keys(out.pdf!.annots)).toEqual(["P2"]);
    expect(out.pdf!.annots.P2).toBe(p.pdf!.annots.P2);
    expect(out.pdf!.sources).toBe(p.pdf!.sources);
    clean(out);
  });

  it("shares the marks record when the deleted page had none", () => {
    const p = doc();
    expect(deletePages(p, ["P3"]).pdf!.annots).toBe(p.pdf!.annots);
  });

  it("refuses deleting every page, and deleting nothing", () => {
    const p = doc();
    expect(deletePages(p, ["P1", "P2", "P3"])).toBe(p);
    expect(deletePages(p, ["nope"])).toBe(p);
  });
});

describe("duplicatePages", () => {
  it("puts each copy after its original with fresh page and mark ids", () => {
    const p = doc();
    const out = duplicatePages(p, ["P1", "P3"]);
    const ids = pageIds(out);
    expect(ids).toHaveLength(5);
    expect([ids[0], ids[2], ids[3]]).toEqual(["P1", "P2", "P3"]);
    const copy = out.pdf!.pages[1]!;
    expect(copy).toEqual({ ...p.pdf!.pages[0]!, id: copy.id });
    expect(copy.id).not.toBe("P1");
    const marks = pageAnnots(out, copy.id);
    expect(marks.map((a) => a.t)).toEqual(["whiteout", "ink"]);
    expect(marks.map((a) => a.id)).not.toContain("m1");
    expect(marks[1]).toEqual({ ...pageAnnots(p, "P1")[1]!, id: marks[1]!.id });
    expect(pageAnnots(out, ids[4]!)).toEqual([]);
    expect(pageAnnots(out, "P1")).toBe(pageAnnots(p, "P1"));
    clean(out);
  });

  it("refuses unknown ids and going over PDF_MAX_PAGES", () => {
    const p = doc();
    expect(duplicatePages(p, ["nope"])).toBe(p);
    const big = createPdfProject("big", { path: "C:\\b.pdf", size: 1, mtimeMs: 1, pages: PDF_MAX_PAGES });
    expect(duplicatePages(big, [big.pdf!.pages[0]!.id])).toBe(big);
  });
});

describe("insertBlankPage", () => {
  it("inserts a blank page of the given size at the gap", () => {
    const p = doc();
    const out = insertBlankPage(p, 1, 612, 792);
    const pg = out.pdf!.pages[1]!;
    expect(pg).toEqual({ id: pg.id, src: null, page: 0, rotate: 0, w: 612, h: 792 });
    expect(pageIds(out).filter((x) => x !== pg.id)).toEqual(["P1", "P2", "P3"]);
    expect(out.pdf!.pages[0]).toBe(p.pdf!.pages[0]);
    clean(out);
    expect(insertBlankPage(p, -5, 1, 1).pdf!.pages[0]!.src).toBeNull();
    expect(insertBlankPage(p, 99, 1, 14400).pdf!.pages[3]!.src).toBeNull();
  });

  it("refuses a side outside 1..14400, a bad gap and a full document", () => {
    const p = doc();
    for (const [w, h] of [[0, 1], [1, 14401], [NaN, 5], [Infinity, 5]]) {
      expect(insertBlankPage(p, 0, w!, h!)).toBe(p);
    }
    expect(insertBlankPage(p, NaN, 10, 10)).toBe(p);
    const big = createPdfProject("big", { path: "C:\\b.pdf", size: 1, mtimeMs: 1, pages: PDF_MAX_PAGES });
    expect(insertBlankPage(big, 0, 10, 10)).toBe(big);
  });
});

describe("insertSourcePages", () => {
  const other: PdfSource = { id: "other", path: "C:\\b.pdf", size: 7, mtimeMs: 8, pages: 3 };

  it("adds a new source and its pages at the gap (all pages by default)", () => {
    const p = doc();
    const out = insertSourcePages(p, 1, other);
    expect(out.pdf!.sources.map((s) => s.id)).toEqual(["src", "other"]);
    const added = out.pdf!.pages.slice(1, 4);
    expect(added.map((pg) => [pg.src, pg.page, pg.rotate])).toEqual([
      ["other", 0, 0],
      ["other", 1, 0],
      ["other", 2, 0],
    ]);
    expect(out.pdf!.sources[0]).toBe(p.pdf!.sources[0]);
    clean(out);
  });

  it("inserts only the chosen pages, in the order given", () => {
    const out = insertSourcePages(doc(), 3, other, [2, 0]);
    expect(out.pdf!.pages.slice(3).map((pg) => pg.page)).toEqual([2, 0]);
  });

  it("reuses a source already in the project (same path, size and mtime)", () => {
    const p = doc();
    const same: PdfSource = { id: "whatever", path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 5 };
    const out = insertSourcePages(p, 0, same, [4]);
    expect(out.pdf!.sources).toBe(p.pdf!.sources);
    expect(out.pdf!.pages[0]).toMatchObject({ src: "src", page: 4 });
    clean(out);
  });

  it("treats a changed file at the same path as a new source with a fresh id on clash", () => {
    const p = doc();
    const changed: PdfSource = { id: "src", path: "C:\\a.pdf", size: 11, mtimeMs: 20, pages: 2 };
    const out = insertSourcePages(p, 0, changed);
    expect(out.pdf!.sources).toHaveLength(2);
    expect(out.pdf!.sources[1]!.id).not.toBe("src");
    expect(out.pdf!.pages[0]!.src).toBe(out.pdf!.sources[1]!.id);
    clean(out);
    const reserved = insertSourcePages(p, 0, { ...other, id: "__proto__" });
    expect(reserved.pdf!.sources[1]!.id).not.toBe("__proto__");
  });

  it("refuses an invalid source, an index outside it, an empty list and overflow", () => {
    const p = doc();
    expect(insertSourcePages(p, 0, other, [3])).toBe(p);
    expect(insertSourcePages(p, 0, other, [0, -1])).toBe(p);
    expect(insertSourcePages(p, 0, other, [0.5])).toBe(p);
    expect(insertSourcePages(p, 0, other, [])).toBe(p);
    expect(insertSourcePages(p, 0, { ...other, path: "http://x/b.pdf" })).toBe(p);
    expect(insertSourcePages(p, 0, { ...other, pages: 0 })).toBe(p);
    expect(insertSourcePages(p, 0, { ...other, size: -1 })).toBe(p);
    expect(insertSourcePages(p, NaN, other)).toBe(p);
    const big = createPdfProject("big", { path: "C:\\b.pdf", size: 1, mtimeMs: 1, pages: PDF_MAX_PAGES });
    expect(insertSourcePages(big, 0, other, [0])).toBe(big);
  });
});

describe("dropUnusedSources", () => {
  it("drops sources no page uses, with their form values", () => {
    const p = insertSourcePages(doc(), 0, { id: "other", path: "C:\\b.pdf", size: 7, mtimeMs: 8, pages: 1 });
    const withForm = setFormValue(p, "other", "9R", "x");
    const gone = deletePages(withForm, [withForm.pdf!.pages[0]!.id]);
    const out = dropUnusedSources(gone);
    expect(out.pdf!.sources.map((s) => s.id)).toEqual(["src"]);
    expect(Object.keys(out.pdf!.forms)).toEqual(["src"]);
    expect(out.pdf!.forms.src).toBe(gone.pdf!.forms.src);
    clean(out);
  });

  it("refuses when every source is used", () => {
    const p = doc();
    expect(dropUnusedSources(p)).toBe(p);
  });
});

describe("form values", () => {
  it("sets a value as a copy in fresh records, sharing other sources", () => {
    const p = doc();
    const list = ["a", "b"];
    const out = setFormValue(p, "src", "2R", list);
    expect(formValue(out, "src", "2R")).toEqual(["a", "b"]);
    expect(formValue(out, "src", "2R")).not.toBe(list);
    expect(formValue(out, "src", "1R")).toBe("Dana");
    expect(Object.getPrototypeOf(out.pdf!.forms)).toBeNull();
    expect(Object.getPrototypeOf(out.pdf!.forms.src)).toBeNull();
    expect(formValue(p, "src", "2R")).toBeUndefined();
    clean(out);
  });

  it("refuses an unknown source, a bad field id or value, and the same value", () => {
    const p = doc();
    expect(setFormValue(p, "nope", "1R", "x")).toBe(p);
    expect(setFormValue(p, "src", "__proto__", "x")).toBe(p);
    expect(setFormValue(p, "src", "a b", "x")).toBe(p);
    expect(setFormValue(p, "src", "1R", "x".repeat(20_001))).toBe(p);
    expect(setFormValue(p, "src", "1R", 5 as never)).toBe(p);
    expect(setFormValue(p, "src", "1R", Array(501).fill("a"))).toBe(p);
    expect(setFormValue(p, "src", "1R", "Dana")).toBe(p);
    const listed = setFormValue(p, "src", "3R", ["a"]);
    expect(setFormValue(listed, "src", "3R", ["a"])).toBe(listed);
  });

  it("clears a value, dropping a source's record once empty", () => {
    const p = doc();
    const out = clearFormValue(p, "src", "1R");
    expect(Object.keys(out.pdf!.forms)).toEqual([]);
    expect(formValue(p, "src", "1R")).toBe("Dana");
    const two = setFormValue(p, "src", "2R", true);
    expect(Object.keys(clearFormValue(two, "src", "1R").pdf!.forms.src!)).toEqual(["2R"]);
    expect(clearFormValue(p, "src", "9R")).toBe(p);
    expect(clearFormValue(p, "nope", "1R")).toBe(p);
    expect(clearFormValue(p, "src", "toString")).toBe(p);
  });
});

describe("setExportPreset", () => {
  it("merges flags (false when never set) and refuses a no-op", () => {
    const p = doc();
    const out = setExportPreset(p, { flattenForms: true });
    expect(out.pdf!.export).toEqual({ flattenMarks: false, flattenForms: true });
    expect(setExportPreset(out, { flattenForms: true })).toBe(out);
    expect(setExportPreset(p, { flattenMarks: false })).toBe(p);
    expect(setExportPreset(out, { flattenMarks: true }).pdf!.export).toEqual({ flattenMarks: true, flattenForms: true });
  });
});

describe("every operation leaves a project that reloads unchanged", () => {
  it("survives sanitizeProject after a chain of edits", () => {
    let p = doc();
    p = addAnnot(p, "P3", ink("n1", 5, 5, 0.5, 6, 6, 0.5));
    p = rotatePages(p, ["P2"], 180);
    p = insertBlankPage(p, 0, 595, 842);
    p = duplicatePages(p, ["P1"]);
    p = setFormValue(p, "src", "5R", false);
    p = setExportPreset(p, { flattenMarks: true });
    clean(p);
    expect(sanitizeProject(JSON.parse(JSON.stringify(p)) as ProjectFile).pdf).toEqual(p.pdf);
  });
});

/* ---------------- geometry ---------------- */

describe("annotBounds", () => {
  it("ink: its points padded by half the width", () => {
    expect(annotBounds(ink("i", 10, 20, 1, 30, 5, 1))).toEqual([9, 4, 22, 17]);
    const broken = { ...ink("i", 0, 0, 1), p: "AAAA" } as PdfAnnot;
    expect(annotBounds(broken)).toEqual([0, 0, 0, 0]);
    expect(translateAnnot(broken, 5, 5)).toBe(broken);
  });

  it("highlight: the union of its rects", () => {
    const h: PdfAnnot = { id: "h", t: "highlight", c: "#ffff00", o: 0.4, rects: [[10, 10, 5, 5], [0, 30, 2, 2]] };
    expect(annotBounds(h)).toEqual([0, 10, 15, 22]);
  });

  it("shapes: both ends padded by half the width, whatever their order", () => {
    const s: PdfAnnot = { id: "s", t: "arrow", c: "#000000", w: 4, a: [50, 10], b: [10, 30] };
    expect(annotBounds(s)).toEqual([8, 8, 44, 24]);
  });

  it("box marks: their own box", () => {
    expect(annotBounds(box("b", 1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
    const sig: PdfAnnot = { id: "g", t: "signature", x: 5, y: 6, w: 7, h: 8, c: "#000000", strokes: [] };
    expect(annotBounds(sig)).toEqual([5, 6, 7, 8]);
  });
});

describe("translateAnnot", () => {
  it("moves every kind and keeps the id; the input is untouched", () => {
    const i = deepFreeze(ink("i", 10, 20, 0.5));
    const moved = translateAnnot(i, 5, -5);
    expect(moved.id).toBe("i");
    expect(Array.from(decodePoints((moved as { p: string }).p)!)).toEqual([15, 15, 0.5]);
    expect(translateAnnot(box("b", 1, 2, 3, 4), 1, 1)).toEqual(box("b", 2, 3, 3, 4));
    const s: PdfAnnot = { id: "s", t: "line", c: "#000000", w: 1, a: [0, 0], b: [1, 1] };
    expect(translateAnnot(s, 2, 3)).toMatchObject({ a: [2, 3], b: [3, 4] });
    const h: PdfAnnot = { id: "h", t: "highlight", c: "#ffff00", o: 1, rects: [[0, 0, 5, 5]] };
    expect(translateAnnot(h, 1, 2)).toMatchObject({ rects: [[1, 2, 5, 5]] });
    expect(translateAnnot(i, 0, 0)).toBe(i);
  });

  it("clamps into page-space bounds so the result always reloads", () => {
    expect(translateAnnot(box("b", 0, 0, 1, 1), 5e6, -5e6)).toMatchObject({ x: 1e6, y: -1e6 });
    const far = translateAnnot(ink("i", 0, 0, 1), 9e6, 0) as { p: string };
    expect(Array.from(decodePoints(far.p)!)).toEqual([1e6, 0, 1]);
  });
});

describe("scaleAnnot", () => {
  it("scales ink points by the box map, keeping width and pressure", () => {
    const i = ink("i", 10, 10, 0.25, 20, 30, 1);
    const out = scaleAnnot(i, [10, 10, 10, 20], [0, 0, 20, 10]) as Extract<PdfAnnot, { t: "ink" }>;
    expect(Array.from(decodePoints(out.p)!)).toEqual([0, 0, 0.25, 20, 10, 1]);
    expect(out.w).toBe(2);
  });

  it("changes a text box's w/h but never its font size", () => {
    const t: PdfAnnot = {
      id: "t",
      t: "text",
      x: 0,
      y: 0,
      w: 100,
      h: 20,
      text: "hi",
      font: "Arial",
      size: 12,
      c: "#000000",
      bold: false,
      italic: false,
      align: "left",
    };
    expect(scaleAnnot(t, [0, 0, 100, 20], [10, 10, 200, 60])).toMatchObject({ x: 10, y: 10, w: 200, h: 60, size: 12 });
  });

  it("normalises a flipped box and maps shape ends and highlight rects", () => {
    expect(scaleAnnot(box("b", 0, 0, 10, 10), [0, 0, 10, 10], [10, 0, -10, 10])).toMatchObject({ x: 0, w: 10 });
    const s: PdfAnnot = { id: "s", t: "rect", c: "#000000", w: 3, a: [0, 0], b: [10, 10] };
    expect(scaleAnnot(s, [0, 0, 10, 10], [0, 0, 20, 5])).toMatchObject({ a: [0, 0], b: [20, 5], w: 3 });
    const h: PdfAnnot = { id: "h", t: "highlight", c: "#ffff00", o: 1, rects: [[0, 0, 10, 10]] };
    expect(scaleAnnot(h, [0, 0, 10, 10], [0, 0, 5, 5])).toMatchObject({ rects: [[0, 0, 5, 5]] });
  });

  it("maps a zero-sized axis with scale 1, and a signature by its box only", () => {
    const s: PdfAnnot = { id: "s", t: "line", c: "#000000", w: 1, a: [5, 0], b: [5, 10] };
    expect(scaleAnnot(s, [5, 0, 0, 10], [7, 0, 30, 20])).toMatchObject({ a: [7, 0], b: [7, 20] });
    const strokes = [encodePoints(new Float32Array([0.5, 0.5, 1]))];
    const sig: PdfAnnot = { id: "g", t: "signature", x: 0, y: 0, w: 10, h: 10, c: "#000000", strokes };
    const out = scaleAnnot(sig, [0, 0, 10, 10], [0, 0, 20, 20]) as Extract<PdfAnnot, { t: "signature" }>;
    expect(out.strokes).toBe(strokes);
    expect([out.w, out.h]).toEqual([20, 20]);
  });
});
