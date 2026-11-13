import { describe, expect, it } from "vitest";
import "../core/pdf-sanitize"; // registers the PDF rules sanitizeProject dispatches to
import { sanitizeProject } from "../core/project";
import { createPdfProject } from "../core/pdf-project";
import { PAPER_PT, picturePageLayout } from "../core/picture-page";
import type { MediaInfo, MediaRef, PdfAnnot, ProjectFile } from "../core/types";
import { decodePoints, encodePoints } from "../image/strokes";
import {
  annotBounds,
  fitInBox,
  insertPicturePages,
  isPicturePage,
  missingPicturesOn,
  pageAnnots,
  picturePageSizingOf,
  refitAnnot,
  refitPagePictures,
  rotatePages,
  sameFileMedia,
  setPicturePageSizing,
} from "./model";
import { relinkPicture } from "./editor/picture-relink";

// Picture pages afterwards (0.9.5): a picture page's size changed from the
// page menu (the marks over the picture follow it), and a moved picture file
// relinked (every page and mark of that file at once, the page kept).

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const still = (path: string, w: number, h: number): MediaInfo => ({
  path,
  size: path.length * 7,
  mtimeMs: 1_700_000_000_000 + path.length,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
});

function seq(): () => string {
  let n = 0;
  return () => `i${++n}`;
}

/** A source page P1, then two picture pages (picture size): a landscape scan
 *  800×600 (page i2, picture i3, media i1) and a portrait 300×900 (page i5,
 *  picture i6, media i4); frozen. */
function doc(): ProjectFile {
  let n = 0;
  const base = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 1 }, {
    id: () => ["src", "P1", "proj", "trk"][n++]!,
  });
  return deepFreeze(insertPicturePages(base, 1, [still("C:\\p\\land.jpg", 800, 600), still("C:\\p\\port.png", 300, 900)], "picture", seq()));
}

const page = (p: ProjectFile, id: string) => p.pdf!.pages.find((pg) => pg.id === id)!;
const pic = (p: ProjectFile, id: string) => pageAnnots(p, id).find((a) => a.t === "image")! as Extract<PdfAnnot, { t: "image" }>;
const withMarks = (p: ProjectFile, pageId: string, extra: PdfAnnot[]): ProjectFile => {
  const annots = Object.create(null) as Record<string, PdfAnnot[]>;
  for (const k of Object.keys(p.pdf!.annots)) annots[k] = p.pdf!.annots[k]!;
  annots[pageId] = [...(annots[pageId] ?? []), ...extra];
  return deepFreeze({ ...p, pdf: { ...p.pdf!, annots } });
};

describe("which sizing a picture page is in", () => {
  it("reads it from the page and its box: picture, A4, Letter — and none for anything else", () => {
    const p = doc();
    expect(picturePageSizingOf(p, "i2")).toBe("picture");
    const a4 = setPicturePageSizing(p, ["i2"], "a4");
    expect(picturePageSizingOf(a4, "i2")).toBe("a4");
    const letter = setPicturePageSizing(p, ["i2"], "letter");
    expect(picturePageSizingOf(letter, "i2")).toBe("letter");
    // a page sized by hand (its picture box no longer the layout's)
    const hand = withMarks(p, "i5", []);
    const moved = { ...hand, pdf: { ...hand.pdf!, pages: hand.pdf!.pages.map((pg) => (pg.id === "i5" ? { ...pg, w: pg.w! + 3 } : pg)) } };
    expect(picturePageSizingOf(moved, "i5")).toBeNull();
    // a source page and an unknown page are not picture pages
    expect(picturePageSizingOf(p, "P1")).toBeNull();
    expect(isPicturePage(p, "P1")).toBe(false);
    expect(isPicturePage(p, "i5")).toBe(true);
    expect(picturePageSizingOf(p, "nope")).toBeNull();
  });

  it("allows a small rounding difference, not a large one", () => {
    const p = doc();
    const nudge = (d: number): ProjectFile => ({ ...p, pdf: { ...p.pdf!, pages: p.pdf!.pages.map((pg) => (pg.id === "i2" ? { ...pg, h: pg.h! + d } : pg)) } });
    expect(picturePageSizingOf(nudge(0.3), "i2")).toBe("picture");
    expect(picturePageSizingOf(nudge(0.8), "i2")).toBeNull();
  });
});

describe("setPicturePageSizing", () => {
  it("recomputes the page and its picture from the picture's displayed size", () => {
    const p = doc();
    const out = setPicturePageSizing(p, ["i2"], "a4");
    const l = picturePageLayout(800, 600, "a4");
    // landscape picture → the sheet turned landscape
    expect([page(out, "i2").w, page(out, "i2").h]).toEqual([PAPER_PT.a4.h, PAPER_PT.a4.w]);
    const b = pic(out, "i2");
    expect([b.x, b.y, b.w, b.h]).toEqual([l.x, l.y, l.w, l.h]);
    expect(b.bg).toBe(true);
    expect(b.id).toBe("i3");
    // the other picture page is shared untouched
    expect(page(out, "i5")).toBe(page(p, "i5"));
    expect(pageAnnots(out, "i5")).toBe(pageAnnots(p, "i5"));
  });

  it("carries every other mark from the old picture box to the new one, widths and sizes scaled alike", () => {
    // page i2 at picture size: picture box 0,0,600,450. A4 landscape box:
    // 841.89 wide, 631.42 high, at y 0 (fills the width) — scale 1.40315
    const base = doc();
    const marks: PdfAnnot[] = [
      { id: "ink", t: "ink", kind: "pen", c: "#000000", w: 4, o: 1, p: encodePoints(new Float32Array([100, 50, 1, 300, 200, 0.5])) },
      { id: "line", t: "line", c: "#ff0000", w: 2, a: [0, 450], b: [600, 0] },
      { id: "wo", t: "whiteout", x: 60, y: 90, w: 120, h: 30, c: "#ffffff" },
      { id: "txt", t: "text", x: 150, y: 300, w: 200, h: 40, text: "Hello there", font: "Segoe UI", size: 20, c: "#000000", bold: false, italic: false, align: "left", runs: [{ s: 6, e: 11, size: 30 }] },
    ];
    const p = withMarks(base, "i2", marks);
    const out = setPicturePageSizing(p, ["i2"], "a4");
    const l = picturePageLayout(800, 600, "a4");
    const sx = l.w / 600;
    const sy = l.h / 450;
    const k = Math.sqrt(sx * sy);
    const by = (id: string): PdfAnnot => pageAnnots(out, "i2").find((a) => a.id === id)!;
    // ink: points mapped through the box, pressure kept, width scaled
    const ink = by("ink") as Extract<PdfAnnot, { t: "ink" }>;
    const pts = Array.from(decodePoints(ink.p)!);
    expect(pts[0]).toBeCloseTo(l.x + 100 * sx, 2);
    expect(pts[1]).toBeCloseTo(l.y + 50 * sy, 2);
    expect(pts[2]).toBeCloseTo(1, 5);
    expect(pts[3]).toBeCloseTo(l.x + 300 * sx, 2);
    expect(pts[4]).toBeCloseTo(l.y + 200 * sy, 2);
    expect(pts[5]).toBeCloseTo(0.5, 5);
    expect(ink.w).toBeCloseTo(4 * k, 6);
    // a shape: its two ends and its width
    const line = by("line") as Extract<PdfAnnot, { a: [number, number] }>;
    expect(line.a[0]).toBeCloseTo(l.x, 6);
    expect(line.a[1]).toBeCloseTo(l.y + 450 * sy, 6);
    expect(line.b[0]).toBeCloseTo(l.x + 600 * sx, 6);
    expect(line.w).toBeCloseTo(2 * k, 6);
    // a box mark: position and size together
    const wo = by("wo") as Extract<PdfAnnot, { t: "whiteout" }>;
    expect([wo.x, wo.y, wo.w, wo.h].map((v) => Math.round(v * 100) / 100)).toEqual(
      [l.x + 60 * sx, l.y + 90 * sy, 120 * sx, 30 * sy].map((v) => Math.round(v * 100) / 100),
    );
    // text: its box, its size, and its runs' sizes by the same factor
    const txt = by("txt") as Extract<PdfAnnot, { t: "text" }>;
    expect(txt.x).toBeCloseTo(l.x + 150 * sx, 6);
    expect(txt.size).toBe(Math.round(20 * k * 100) / 100);
    expect(txt.runs).toEqual([{ s: 6, e: 11, size: Math.round(30 * k * 100) / 100 }]);
    // and the result still loads
    const saved = sanitizeProject(JSON.parse(JSON.stringify(out)) as ProjectFile);
    expect(pageAnnots(saved, "i2").map((a) => a.id)).toEqual(["i3", "ink", "line", "wo", "txt"]);
  });

  it("keeps marks drawn in a paper page's margins on the page when its size changes", () => {
    // a 3024×4032 phone photo on A4: the picture fills the width with a margin
    // above and below it
    let n = 0;
    const base = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 1 }, {
      id: () => ["src", "P1", "proj", "trk"][n++]!,
    });
    const a4 = deepFreeze(insertPicturePages(base, 1, [still("C:\\p\\phone.jpg", 3024, 4032)], "a4", seq()));
    const la4 = picturePageLayout(3024, 4032, "a4");
    expect(la4.y).toBeGreaterThan(20);
    const marks: PdfAnnot[] = [
      // top margin, bottom margin, and an ink stroke along the bottom margin
      { id: "top", t: "whiteout", x: 100, y: 4, w: 120, h: 14, c: "#ffffff" },
      { id: "bot", t: "text", x: 50, y: 820, w: 200, h: 18, text: "Signed", font: "Segoe UI", size: 12, c: "#000000", bold: false, italic: false, align: "left" },
      { id: "ink", t: "ink", kind: "pen", c: "#000000", w: 2, o: 1, p: encodePoints(new Float32Array([40, 835, 1, 500, 836, 1])) },
      // over the picture: must move exactly with it
      { id: "mid", t: "whiteout", x: 200, y: 400, w: 50, h: 20, c: "#ffffff" },
    ];
    const p = withMarks(a4, "i2", marks);
    for (const sizing of ["letter", "picture"] as const) {
      const out = setPicturePageSizing(p, ["i2"], sizing);
      const pg = page(out, "i2");
      for (const a of pageAnnots(out, "i2")) {
        // the geometry stays on the page (a stroke's half width may overhang)
        const [x, y, w, h] = annotBounds(a);
        const r = a.t === "ink" ? a.w / 2 : 0;
        expect(x + r, `${sizing} ${a.id} x`).toBeGreaterThanOrEqual(-0.01);
        expect(y + r, `${sizing} ${a.id} y`).toBeGreaterThanOrEqual(-0.01);
        expect(x + w - r, `${sizing} ${a.id} right`).toBeLessThanOrEqual(pg.w! + 0.01);
        expect(y + h - r, `${sizing} ${a.id} bottom`).toBeLessThanOrEqual(pg.h! + 0.01);
      }
      // a top-margin mark is moved just inside the top edge
      const top = pageAnnots(out, "i2").find((a) => a.id === "top") as Extract<PdfAnnot, { t: "whiteout" }>;
      expect(top.y).toBeCloseTo(0, 2);
      // a mark over the picture is carried by the picture's map alone
      const l = picturePageLayout(3024, 4032, sizing);
      const mid = pageAnnots(out, "i2").find((a) => a.id === "mid") as Extract<PdfAnnot, { t: "whiteout" }>;
      expect(mid.x).toBeCloseTo(l.x + (200 - la4.x) * (l.w / la4.w), 2);
      expect(mid.y).toBeCloseTo(l.y + (400 - la4.y) * (l.h / la4.h), 2);
    }
  });

  it("is one new project for several selected pages, skipping the pages that are not picture pages", () => {
    const p = doc();
    const out = setPicturePageSizing(p, ["P1", "i2", "i5", "nope"], "letter");
    expect(out).not.toBe(p);
    expect(page(out, "P1")).toBe(page(p, "P1"));
    expect(picturePageSizingOf(out, "i2")).toBe("letter");
    expect(picturePageSizingOf(out, "i5")).toBe("letter");
    // portrait stays portrait, landscape stays landscape
    expect([page(out, "i5").w, page(out, "i5").h]).toEqual([PAPER_PT.letter.w, PAPER_PT.letter.h]);
    expect([page(out, "i2").w, page(out, "i2").h]).toEqual([PAPER_PT.letter.h, PAPER_PT.letter.w]);
  });

  it("keeps the page's turn and id", () => {
    const p = deepFreeze(rotatePages(doc(), ["i2"], 90));
    const out = setPicturePageSizing(p, ["i2"], "a4");
    expect(page(out, "i2").rotate).toBe(90);
    expect(out.pdf!.pages.map((pg) => pg.id)).toEqual(p.pdf!.pages.map((pg) => pg.id));
  });

  it("refuses (returns p) when nothing changes: already in that sizing, or no picture page", () => {
    const p = doc();
    expect(setPicturePageSizing(p, ["i2", "i5"], "picture")).toBe(p);
    expect(setPicturePageSizing(p, ["P1"], "a4")).toBe(p);
    expect(setPicturePageSizing(p, [], "a4")).toBe(p);
    // and back: picture → A4 → picture is the same page again
    const back = setPicturePageSizing(setPicturePageSizing(p, ["i2"], "a4"), ["i2"], "picture");
    expect([page(back, "i2").w, page(back, "i2").h]).toEqual([page(p, "i2").w, page(p, "i2").h]);
  });

  it("refitAnnot maps from a box off the origin, each axis by its own scale", () => {
    // from [10,20,100,50] to [40,70,300,100]: sx 3, sy 2, sizes by sqrt(6)
    const from: [number, number, number, number] = [10, 20, 100, 50];
    const to: [number, number, number, number] = [40, 70, 300, 100];
    const wo = refitAnnot({ id: "w", t: "whiteout", x: 20, y: 30, w: 10, h: 5, c: "#ffffff" }, from, to) as Extract<PdfAnnot, { t: "whiteout" }>;
    expect(wo.x).toBeCloseTo(70, 2);
    expect(wo.y).toBeCloseTo(90, 2);
    expect(wo.w).toBeCloseTo(30, 2);
    expect(wo.h).toBeCloseTo(10, 2);
    const line = refitAnnot({ id: "l", t: "line", c: "#000000", w: 2, a: [10, 20], b: [60, 45] }, from, to) as Extract<PdfAnnot, { a: [number, number] }>;
    expect(line.a[0]).toBeCloseTo(40, 2);
    expect(line.a[1]).toBeCloseTo(70, 2);
    expect(line.b[0]).toBeCloseTo(190, 2);
    expect(line.b[1]).toBeCloseTo(120, 2);
    expect(line.w).toBeCloseTo(2 * Math.sqrt(6), 2);
  });

  it("refitAnnot keeps text sizes and widths inside what the loader accepts", () => {
    const t: PdfAnnot = { id: "t", t: "text", x: 0, y: 0, w: 10, h: 10, text: "a", font: "Segoe UI", size: 5, c: "#000000", bold: false, italic: false, align: "left" };
    const small = refitAnnot(t, [0, 0, 100, 100], [0, 0, 10, 10]) as Extract<PdfAnnot, { t: "text" }>;
    expect(small.size).toBe(4);
    const big = refitAnnot({ ...t, size: 200 }, [0, 0, 10, 10], [0, 0, 100, 100]) as Extract<PdfAnnot, { t: "text" }>;
    expect(big.size).toBe(288);
    const ink: PdfAnnot = { id: "i", t: "line", c: "#000000", w: 900, a: [0, 0], b: [1, 1] };
    expect((refitAnnot(ink, [0, 0, 10, 10], [0, 0, 100, 100]) as { w: number }).w).toBe(1000);
  });
});

describe("relinking a picture", () => {
  it("fitInBox fits another shape inside the box, centred; the same shape keeps the box", () => {
    expect(fitInBox([10, 20, 400, 300], 800, 600)).toEqual([10, 20, 400, 300]);
    // a portrait file in a landscape box: full height, centred across
    expect(fitInBox([10, 20, 400, 300], 300, 600)).toEqual([135, 20, 150, 300]);
    // a wide file: full width, centred down
    expect(fitInBox([0, 0, 400, 300], 800, 200)).toEqual([0, 100, 400, 100]);
  });

  it("refitPagePictures moves only PAGE pictures of those files", () => {
    const p = withMarks(doc(), "i2", [{ id: "mk", t: "image", x: 5, y: 6, w: 70, h: 80, media: "i1" }]);
    const out = refitPagePictures(p, new Set(["i1"]), 300, 600);
    const b = pic(out, "i2");
    expect([b.x, b.y, b.w, b.h]).toEqual([187.5, 0, 225, 450]);
    const mark = pageAnnots(out, "i2").find((a) => a.id === "mk")!;
    expect(mark).toBe(pageAnnots(p, "i2").find((a) => a.id === "mk"));
    expect(pageAnnots(out, "i5")).toBe(pageAnnots(p, "i5"));
    expect(refitPagePictures(p, new Set(["i1"]), 800, 600)).toBe(p);
  });

  it("relinkPicture fixes every MediaRef of the file at once and keeps the page", () => {
    // a second ref of the same file (same path, size and mtime), used by an
    // ordinary picture mark on the source page
    const base = doc();
    const twin: MediaRef = { ...base.media.find((m) => m.id === "i1")!, id: "twin" };
    const p0 = withMarks({ ...base, media: [...base.media, twin] }, "P1", [{ id: "mk", t: "image", x: 5, y: 6, w: 70, h: 80, media: "twin" }]);
    const moved = still("D:\\new\\land-moved.jpg", 300, 600);
    const out = relinkPicture(p0, "i1", moved.path, moved);
    for (const id of ["i1", "twin"]) {
      const m = out.media.find((x) => x.id === id)!;
      expect([m.path, m.size, m.width, m.height]).toEqual([moved.path, moved.size, 300, 600]);
    }
    // the other file is untouched
    expect(out.media.find((x) => x.id === "i4")).toBe(p0.media.find((x) => x.id === "i4"));
    // the page keeps its size; its picture is fitted inside the old box
    expect([page(out, "i2").w, page(out, "i2").h]).toEqual([600, 450]);
    const b = pic(out, "i2");
    expect([b.x, b.y, b.w, b.h]).toEqual([187.5, 0, 225, 450]);
    // the ordinary mark keeps its box
    const mk = pageAnnots(out, "P1").find((a) => a.id === "mk") as Extract<PdfAnnot, { t: "image" }>;
    expect([mk.x, mk.y, mk.w, mk.h]).toEqual([5, 6, 70, 80]);
    expect(relinkPicture(p0, "nope", moved.path, moved)).toBe(p0);
  });

  it("sameFileMedia and missingPicturesOn name one media id per file", () => {
    const base = doc();
    const twin: MediaRef = { ...base.media.find((m) => m.id === "i1")!, id: "twin" };
    const p = withMarks({ ...base, media: [...base.media, twin] }, "i2", [
      { id: "mk", t: "image", x: 5, y: 6, w: 70, h: 80, media: "twin" },
      { id: "mk2", t: "image", x: 5, y: 6, w: 70, h: 80, media: "i4" },
    ]);
    expect(sameFileMedia(p, "twin")).toEqual(["twin", "i1"]);
    expect(sameFileMedia(p, "i4")).toEqual(["i4"]);
    expect(sameFileMedia(p, "nope")).toEqual([]);
    const land = (r: MediaRef): boolean => r.path === "C:\\p\\land.jpg";
    expect(missingPicturesOn(p, "i2", land)).toEqual(["i1"]);
    expect(missingPicturesOn(p, "i2", () => true)).toEqual(["i1", "i4"]);
    expect(missingPicturesOn(p, "i5", land)).toEqual([]);
  });
});
