// How a picture becomes a PDF page: the page's size and where the picture
// sits on it. One rule for every way in (pictures added to a PDF project as
// pages, pictures opened from Home as a PDF project, an image project
// exported as a PDF), so the same picture always makes the same page.
//
// Pure, no imports: Home, the PDF editor and the image editor's export all
// reach it without pulling one another's chunk.
//
// Units: PDF points, origin at the page's top-left, y down (the PDF project's
// page space).

/** CSS pixels to PDF points (96 px per inch, 72 pt per inch). The inverse of
 *  the PDF editor's "Export page as image" at 100 %, so a page exported as a
 *  picture and brought back as a page is the size it started. */
export const PX_TO_PT = 0.75;

/** The largest page side a PDF allows (points); the PDF project's own cap. */
export const PAGE_MAX_PT = 14400;

/** `picture`: the page takes the picture's own shape. `a4` / `letter`: a
 *  sheet of that paper, turned to the picture's orientation, the picture
 *  fitted inside it and centred. */
export type PicturePageSizing = "picture" | "a4" | "letter";

export const PICTURE_PAGE_SIZINGS: readonly PicturePageSizing[] = ["picture", "a4", "letter"];

/** Portrait sheet sizes in points (ISO 216 A4, US Letter). */
export const PAPER_PT: Readonly<Record<"a4" | "letter", { w: number; h: number }>> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};

export interface PicturePageLayout {
  /** the page, points */
  pageW: number;
  pageH: number;
  /** the picture's box on the page, points, from the top-left corner */
  x: number;
  y: number;
  w: number;
  h: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The page for a picture of `pxW` × `pxH` pixels (its DISPLAYED size: after
 *  any EXIF turn). A size that is not a positive finite number counts as 1 px,
 *  so the answer is always a page a PDF can hold. */
export function picturePageLayout(pxW: number, pxH: number, sizing: PicturePageSizing): PicturePageLayout {
  const pw = Number.isFinite(pxW) && pxW > 0 ? pxW : 1;
  const ph = Number.isFinite(pxH) && pxH > 0 ? pxH : 1;
  if (sizing === "picture") {
    let w = pw * PX_TO_PT;
    let h = ph * PX_TO_PT;
    // Too large for a PDF page: shrink both sides alike.
    const over = Math.max(w, h) / PAGE_MAX_PT;
    if (over > 1) {
      w /= over;
      h /= over;
    }
    // A sliver thinner than a point still gets a page that exists.
    w = Math.min(PAGE_MAX_PT, Math.max(1, round2(w)));
    h = Math.min(PAGE_MAX_PT, Math.max(1, round2(h)));
    return { pageW: w, pageH: h, x: 0, y: 0, w, h };
  }
  const paper = PAPER_PT[sizing];
  const landscape = pw > ph;
  const pageW = landscape ? paper.h : paper.w;
  const pageH = landscape ? paper.w : paper.h;
  // Fitted whole inside the sheet (enlarged when smaller), centred.
  const k = Math.min(pageW / pw, pageH / ph);
  const w = round2(pw * k);
  const h = round2(ph * k);
  return { pageW, pageH, x: round2((pageW - w) / 2), y: round2((pageH - h) / 2), w, h };
}
