import { describe, expect, it } from "vitest";
import "../core/pdf-sanitize"; // registers the PDF rules sanitizeProject dispatches to
import { checkInvariants, sanitizeProject } from "../core/project";
import { createPdfProject } from "../core/pdf-project";
import { picturePageLayout } from "../core/picture-page";
import type { MediaInfo, PdfAnnot, ProjectFile } from "../core/types";
import { PDF_MAX_PAGES } from "../core/types";
import {
  deletePages,
  drawOrder,
  duplicatePages,
  insertPicturePages,
  isPagePicture,
  pageAnnots,
  reorderPages,
  rotatePages,
} from "./model";

// Pictures as pages (0.9.5): the model's insert, the page picture's rules in
// the model (draw order, page operations), and its load / save shape.

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** 2 pages (P1, P2) of source "src"; frozen. */
function doc(): ProjectFile {
  let n = 0;
  const p = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 2 }, {
    id: () => ["src", "P1", "P2", "proj", "trk"][n++]!,
  });
  return deepFreeze(p);
}

const still = (path: string, w: number, h: number, patch: Partial<MediaInfo> = {}): MediaInfo => ({
  path,
  size: path.length * 7,
  mtimeMs: 1_700_000_000_000 + path.length,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
  ...patch,
});

/** a deterministic id source: i1, i2, … */
function seq(): () => string {
  let n = 0;
  return () => `i${++n}`;
}

const pageIds = (p: ProjectFile): string[] => p.pdf!.pages.map((pg) => pg.id);

describe("insertPicturePages", () => {
  // Sizes differ on every axis: a landscape, a portrait and a square, none of
  // them the A4 / Letter shape, so a swapped width/height, a lost turn to the
  // paper's orientation or a shared layout shows.
  const land = still("C:\\p\\land.jpg", 800, 600);
  const port = still("C:\\p\\port.png", 300, 900);
  const square = still("C:\\p\\sq.webp", 500, 500);

  it("puts one picture page per picture at the gap, in the order given, as one new project", () => {
    const p = doc();
    const out = insertPicturePages(p, 1, [land, port, square], "picture", seq());
    expect(out).not.toBe(p);
    // between P1 and P2, in the given order (the caller sorts)
    expect(pageIds(out)).toEqual(["P1", "i2", "i5", "i8", "P2"]);
    const pages = out.pdf!.pages;
    expect(pages.slice(1, 4).map((pg) => [pg.src, pg.w, pg.h, pg.rotate])).toEqual([
      [null, 600, 450, 0],
      [null, 225, 675, 0],
      [null, 375, 375, 0],
    ]);
    // each page carries exactly ONE page picture at the layout's box
    expect(pageAnnots(out, "i2")).toEqual([{ id: "i3", t: "image", x: 0, y: 0, w: 600, h: 450, media: "i1", bg: true }]);
    expect(pageAnnots(out, "i5")).toEqual([{ id: "i6", t: "image", x: 0, y: 0, w: 225, h: 675, media: "i4", bg: true }]);
    // the media list gains the three pictures, under the ids the marks name
    expect(out.media.map((m) => [m.id, m.path])).toEqual([
      ["i1", land.path],
      ["i4", port.path],
      ["i7", square.path],
    ]);
    // untouched parts are shared, and the result is a valid project
    expect(out.pdf!.sources).toBe(p.pdf!.sources);
    expect(pages[0]).toBe(p.pdf!.pages[0]);
    expect(checkInvariants(out)).toEqual([]);
  });

  it("uses picturePageLayout for every sizing: A4 and Letter turn to the picture and centre it", () => {
    for (const sizing of ["a4", "letter"] as const) {
      const out = insertPicturePages(doc(), 2, [land, port], sizing, seq());
      const [a, b] = out.pdf!.pages.slice(2);
      const la = picturePageLayout(800, 600, sizing);
      const lb = picturePageLayout(300, 900, sizing);
      expect([a!.w, a!.h]).toEqual([la.pageW, la.pageH]);
      expect([b!.w, b!.h]).toEqual([lb.pageW, lb.pageH]);
      // landscape picture → landscape sheet; portrait → portrait
      expect(a!.w! > a!.h!).toBe(true);
      expect(b!.w! < b!.h!).toBe(true);
      const ma = pageAnnots(out, a!.id)[0] as Extract<PdfAnnot, { t: "image" }>;
      expect([ma.x, ma.y, ma.w, ma.h]).toEqual([la.x, la.y, la.w, la.h]);
      // centred on one axis only (the picture's aspect is not the paper's)
      expect(ma.x === 0 || ma.y === 0).toBe(true);
      expect(ma.x > 0 || ma.y > 0).toBe(true);
    }
  });

  it("reuses the project's MediaRef of the same file, and adds one per new file", () => {
    const p = insertPicturePages(doc(), 0, [land], "picture", seq());
    const again = insertPicturePages(p, 0, [land, land], "picture", () => `j${Math.random().toString(36).slice(2, 8)}`);
    expect(again.media).toBe(p.media);
    const ids = pageIds(again).slice(0, 2).map((id) => (pageAnnots(again, id)[0] as Extract<PdfAnnot, { t: "image" }>).media);
    expect(ids).toEqual(["i1", "i1"]);
    // a changed file (another mtime) is another picture
    const changed = insertPicturePages(p, 0, [{ ...land, mtimeMs: land.mtimeMs + 5 }], "picture", seq());
    expect(changed.media).toHaveLength(2);
  });

  it("refuses whole: not a PDF project, nothing given, a non-still, a still without a size, over the page limit", () => {
    const p = doc();
    expect(insertPicturePages({ ...p, kind: undefined }, 0, [land], "picture")).toEqual({ ...p, kind: undefined });
    expect(insertPicturePages(p, 0, [], "picture")).toBe(p);
    expect(insertPicturePages(p, 0, [land, still("C:\\v.mp4", 10, 10, { kind: "video" })], "picture")).toBe(p);
    expect(insertPicturePages(p, 0, [land, still("C:\\z.png", 0, 10)], "picture")).toBe(p);
    expect(insertPicturePages(p, 0, [land, still("C:\\n.png", Number.NaN, 10)], "picture")).toBe(p);
    expect(insertPicturePages(p, Number.NaN, [land], "picture")).toBe(p);
    // two pages + (max - 2) fits; one more does not
    const fits = Array.from({ length: PDF_MAX_PAGES - 2 }, () => land);
    expect(insertPicturePages(p, 0, fits, "picture")).not.toBe(p);
    expect(insertPicturePages(p, 0, [...fits, land], "picture")).toBe(p);
  });
});

describe("the page picture in the model", () => {
  const bg = (id: string, media = "m1"): PdfAnnot => ({ id, t: "image", x: 0, y: 0, w: 100, h: 50, media, bg: true });
  const plain = (id: string): PdfAnnot => ({ id, t: "image", x: 5, y: 5, w: 10, h: 10, media: "m1" });
  const white = (id: string): PdfAnnot => ({ id, t: "whiteout", x: 1, y: 2, w: 3, h: 4, c: "#ffffff" });

  it("isPagePicture: only an image mark with bg exactly true", () => {
    expect(isPagePicture(bg("a"))).toBe(true);
    expect(isPagePicture(plain("b"))).toBe(false);
    expect(isPagePicture(white("c"))).toBe(false);
    // a text box's `bg` is its fill colour, never a page picture
    expect(
      isPagePicture({ id: "t", t: "text", x: 0, y: 0, w: 1, h: 1, text: "", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left", bg: "#ffffff" }),
    ).toBe(false);
  });

  it("drawOrder: page pictures first wherever they sit, the rest in list order", () => {
    const list = [white("w1"), plain("p1"), bg("b1"), white("w2"), bg("b2")];
    expect(drawOrder(list).map((a) => a.id)).toEqual(["b1", "b2", "w1", "p1", "w2"]);
    // already in order, or none at all: the very list (no allocation)
    const ordered = [bg("b1"), white("w1")];
    expect(drawOrder(ordered)).toBe(ordered);
    const none = [white("w1"), plain("p1")];
    expect(drawOrder(none)).toBe(none);
  });

  it("travels with its page: duplicate copies it (flag kept, fresh id), rotate and reorder keep it, delete takes it", () => {
    let p = insertPicturePages(doc(), 1, [still("C:\\p\\a.jpg", 640, 480)], "picture", seq());
    const id = "i2";
    p = rotatePages(p, [id], 90);
    expect(p.pdf!.pages.find((pg) => pg.id === id)!.rotate).toBe(90);
    expect(pageAnnots(p, id)).toEqual([expect.objectContaining({ bg: true, x: 0, y: 0, w: 480, h: 360 })]);
    p = reorderPages(p, ["P2", id, "P1"]);
    expect(pageAnnots(p, id)[0]).toMatchObject({ bg: true });
    const dup = duplicatePages(p, [id]);
    const copy = dup.pdf!.pages[2]!;
    expect(copy.id).not.toBe(id);
    const copied = pageAnnots(dup, copy.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ t: "image", bg: true, media: "i1" });
    expect(copied[0]!.id).not.toBe("i3");
    const gone = deletePages(dup, [id]);
    expect(Object.keys(gone.pdf!.annots)).not.toContain(id);
  });
});

describe("the page picture on disk", () => {
  const media = [
    { id: "m1", path: "C:\\p\\a.jpg", size: 1, mtimeMs: 2, kind: "image" as const, duration: 0, width: 4, height: 3, hasAudio: false },
  ];
  /** A PDF project as JSON would bring it back, with `marks` on page P1. */
  function raw(marks: unknown[]): ProjectFile {
    const p = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 1 }, {
      id: (() => {
        let n = 0;
        return () => ["src", "P1", "proj", "trk"][n++]!;
      })(),
    });
    return JSON.parse(JSON.stringify({ ...p, media, pdf: { ...p.pdf!, annots: { P1: marks } } })) as ProjectFile;
  }
  const marksOf = (p: ProjectFile): PdfAnnot[] => [...pageAnnots(p, "P1")];

  it("keeps bg only when it is exactly true on a picture mark", () => {
    const base = { t: "image", x: 0, y: 0, w: 4, h: 3, media: "m1" };
    const out = marksOf(
      sanitizeProject(
        raw([
          { ...base, id: "a", bg: true },
          { ...base, id: "b", bg: false },
          { ...base, id: "c", bg: "true" },
          { ...base, id: "d", bg: 1 },
          { ...base, id: "e" },
          { id: "w", t: "whiteout", x: 0, y: 0, w: 1, h: 1, c: "#ffffff", bg: true },
        ]),
      ),
    );
    expect(out.map((a) => [a.id, "bg" in a ? (a as { bg: unknown }).bg : "absent"])).toEqual([
      ["a", true],
      ["b", "absent"],
      ["c", "absent"],
      ["d", "absent"],
      ["e", "absent"],
      ["w", "absent"],
    ]);
  });

  it("a project without a page picture comes back byte-identical", () => {
    const text = { id: "t", t: "text", x: 1, y: 2, w: 30, h: 40, text: "hi", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left", bg: "#ffeedd" };
    const p = raw([{ id: "a", t: "image", x: 0, y: 0, w: 4, h: 3, media: "m1", r: 90 }, text]);
    const json = JSON.stringify(p);
    expect(JSON.stringify(sanitizeProject(JSON.parse(json) as ProjectFile))).toBe(json);
    expect(json).not.toContain('"bg":true');
  });

  it("a project with one round-trips it", () => {
    const p = raw([{ id: "a", t: "image", x: 0, y: 0, w: 4, h: 3, media: "m1", bg: true }]);
    const json = JSON.stringify(p);
    const back = sanitizeProject(JSON.parse(json) as ProjectFile);
    expect(JSON.stringify(back)).toBe(json);
    expect(checkInvariants(back)).toEqual([]);
  });
});
