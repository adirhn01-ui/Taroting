import { describe, expect, it } from "vitest";
import { PAGE_MAX_PT, PAPER_PT, PICTURE_PAGE_SIZINGS, PX_TO_PT, picturePageLayout } from "./picture-page";

describe("picturePageLayout: the picture's own shape", () => {
  it("is 0.75 pt per pixel, the picture filling the page", () => {
    // Width and height differ, so a swapped axis cannot pass.
    expect(picturePageLayout(1600, 900, "picture")).toEqual({ pageW: 1200, pageH: 675, x: 0, y: 0, w: 1200, h: 675 });
    expect(picturePageLayout(816, 1056, "picture")).toEqual({ pageW: 612, pageH: 792, x: 0, y: 0, w: 612, h: 792 });
  });

  it("rounds to hundredths of a point", () => {
    const l = picturePageLayout(333, 101, "picture");
    expect(l.pageW).toBe(249.75);
    expect(l.pageH).toBe(75.75);
  });

  it("shrinks a picture too large for a PDF page, keeping its shape", () => {
    // 40000 px wide = 30000 pt: over the cap by 30000 / 14400.
    const l = picturePageLayout(40000, 10000, "picture");
    expect(l.pageW).toBe(PAGE_MAX_PT);
    expect(l.pageH).toBe(3600);
    expect(l.w).toBe(l.pageW);
    expect(l.h).toBe(l.pageH);
    const tall = picturePageLayout(5000, 80000, "picture");
    expect(tall.pageH).toBe(PAGE_MAX_PT);
    expect(tall.pageW).toBe(900);
  });

  it("never makes a page thinner than a point", () => {
    expect(picturePageLayout(1, 4000, "picture")).toMatchObject({ pageW: 1, pageH: 3000 });
    // A sliver shrunk by the cap as well.
    expect(picturePageLayout(2, 40000, "picture")).toMatchObject({ pageW: 1, pageH: PAGE_MAX_PT });
  });

  it("treats a size that is not a positive number as one pixel", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const l = picturePageLayout(bad, 400, "picture");
      expect(l.pageW).toBe(1);
      expect(l.pageH).toBe(300);
    }
  });
});

describe("picturePageLayout: on paper", () => {
  it("keeps a portrait picture on a portrait sheet, fitted and centred", () => {
    // 1000 x 2000 on A4: the height binds (841.89 / 2000 < 595.28 / 1000).
    const l = picturePageLayout(1000, 2000, "a4");
    expect(l.pageW).toBe(PAPER_PT.a4.w);
    expect(l.pageH).toBe(PAPER_PT.a4.h);
    expect(l.h).toBe(841.89);
    expect(l.w).toBe(420.95);
    expect(l.y).toBe(0);
    expect(l.x).toBe(87.17);
  });

  it("turns the sheet for a landscape picture", () => {
    // 3000 x 1000 on Letter turned: 792 x 612, the width binds.
    const l = picturePageLayout(3000, 1000, "letter");
    expect(l.pageW).toBe(792);
    expect(l.pageH).toBe(612);
    expect(l.w).toBe(792);
    expect(l.h).toBe(264);
    expect(l.x).toBe(0);
    expect(l.y).toBe(174);
  });

  it("enlarges a small picture to fit the sheet", () => {
    const l = picturePageLayout(100, 100, "letter");
    // Square: not wider than tall, so the sheet stays portrait.
    expect(l).toEqual({ pageW: 612, pageH: 792, x: 0, y: 90, w: 612, h: 612 });
  });

  it("A4 and Letter differ on both sides", () => {
    const a = picturePageLayout(500, 700, "a4");
    const b = picturePageLayout(500, 700, "letter");
    expect(a.pageW).not.toBe(b.pageW);
    expect(a.pageH).not.toBe(b.pageH);
  });
});

it("names every sizing once, and the constants are the documented ones", () => {
  expect([...PICTURE_PAGE_SIZINGS]).toEqual(["picture", "a4", "letter"]);
  expect(PX_TO_PT).toBe(0.75);
  expect(PAGE_MAX_PT).toBe(14400);
});
