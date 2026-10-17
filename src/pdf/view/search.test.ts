import { describe, expect, it } from "vitest";
import type { PdfViewPage } from "../types";
import { boxToPage, pageToBox } from "./math";
import { createSearch } from "./search";
import { fixture, hasFixtures, legacyPdfjs, testLoader } from "./fixtures.test-util";

const slotsFor = (doc: Awaited<ReturnType<ReturnType<typeof testLoader>["openPdf"]>>, prefix = "p"): PdfViewPage[] =>
  Array.from({ length: doc.numPages }, (_, i) => ({ key: `${prefix}${i}`, doc, index: i, rotate: 0 as const }));

describe.skipIf(!hasFixtures)("search against the fixtures", () => {
  it("finds the one 'needle' on page 2, case-insensitively, with a rect on the word", async () => {
    const doc = await testLoader().openPdf("plain", fixture("plain_3p.pdf"));
    const s = createSearch(() => slotsFor(doc));
    const hits = await s.find("NEEDLE");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.key).toBe("p1");
    const [x, y, w, h] = hits[0]!.rects[0]!;
    expect(w).toBeGreaterThan(10);
    expect(h).toBeGreaterThan(4);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(595.28);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y + h).toBeLessThanOrEqual(841.89);
    expect(await s.find("needle", { caseSensitive: true })).toHaveLength(1);
    expect(await s.find("NEEDLE", { caseSensitive: true })).toHaveLength(0);
    expect(await s.find("   ")).toEqual([]);
    await doc.destroy();
  });

  it("the rect sits on the text where pdf.js's own viewport puts it", async () => {
    const doc = await testLoader().openPdf("plain2", fixture("plain_3p.pdf"));
    const hits = await createSearch(() => slotsFor(doc)).find("Page 2 of 3");
    expect(hits).toHaveLength(1);
    // the title item: transform [24,0,0,24,60,770] → page y of the baseline = h - 770
    const [x, y, , h] = hits[0]!.rects[0]!;
    expect(x).toBeCloseTo(60, 1);
    expect(y).toBeLessThan(841.89 - 770);
    expect(y + h).toBeGreaterThan(841.89 - 770);
    await doc.destroy();
  });

  it("finds right-to-left text", async () => {
    const doc = await testLoader().openPdf("he", fixture("hebrew.pdf"));
    const hits = await createSearch(() => slotsFor(doc)).find("שלום");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    await doc.destroy();
  });

  it("walks a 300-page document and can be cancelled midway", async () => {
    const doc = await testLoader().openPdf("big", fixture("large_300p.pdf"));
    expect(doc.numPages).toBe(300);
    const s = createSearch(() => slotsFor(doc));
    const pending = s.find("the");
    s.cancel();
    expect(await pending).toEqual([]);
    const all = await s.find("the");
    const pages = new Set(all.map((h) => h.key));
    expect(pages.size).toBeGreaterThan(100);
    await doc.destroy();
  }, 60_000);

  it("skips blank slots and shares hits across two slots of the same page", async () => {
    const doc = await testLoader().openPdf("dup", fixture("plain_3p.pdf"));
    const pages: PdfViewPage[] = [
      { key: "blank", doc: null, index: 0, rotate: 0, w: 100, h: 100 },
      { key: "a", doc, index: 1, rotate: 0 },
      { key: "b", doc, index: 1, rotate: 90 },
    ];
    const hits = await createSearch(() => pages).find("needle");
    expect(hits.map((h) => h.key)).toEqual(["a", "b"]);
    await doc.destroy();
  });
});

describe.skipIf(!hasFixtures)("our rotation convention matches pdf.js's renderer", () => {
  it("pageToBox == PageViewport.convertToViewportPoint for all four turns", async () => {
    const pdfjs = (await legacyPdfjs()) as unknown as {
      getDocument(o: object): { promise: Promise<{ getPage(n: number): Promise<PageLike> }>; destroy(): Promise<void> };
    };
    type PageLike = {
      view: number[];
      getViewport(o: { scale: number; rotation: number }): { convertToViewportPoint(x: number, y: number): number[] };
    };
    const { readFileSync } = await import("node:fs");
    const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(fixture("plain_3p.pdf"))), verbosity: 0 });
    const page = await (await task.promise).getPage(1);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const w = x1 - x0;
    const h = y1 - y0;
    for (const rot of [0, 90, 180, 270] as const) {
      const vp = page.getViewport({ scale: 1.5, rotation: rot });
      for (const [px, py] of [
        [0, 0],
        [100, 50],
        [w, h],
        [12, 700],
      ]) {
        // page space (y down, crop-box origin) → user space (y up)
        const [vx, vy] = vp.convertToViewportPoint(x0 + px!, y1 - py!) as [number, number];
        const b = pageToBox(px!, py!, w, h, rot, 1.5);
        expect(b.x).toBeCloseTo(vx, 6);
        expect(b.y).toBeCloseTo(vy, 6);
        const back = boxToPage(vx, vy, w, h, rot, 1.5);
        expect(back.x).toBeCloseTo(px!, 6);
        expect(back.y).toBeCloseTo(py!, 6);
      }
    }
    await task.destroy();
  });
});
