// PdfView.samplePage through the real strip (fake DOM, fake pdf.js): it reads
// the painted canvas of the right slot, at the canvas's own scale.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeElement } from "../editor/fake-dom.test-util";
import { fakeDoc, installEnv, pagesOf, until, type Env } from "./dom.test-util";

vi.mock("./pdfjs", async () => (await import("./dom.test-util")).pdfjsModule());

const { createPdfView } = await import("./strip");

let env: Env;
beforeEach(() => {
  env = installEnv();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A canvas whose pixels are paper #f8f0e0 with a #102030 bar over page rect
 *  x 100..200, y 50..60 — at the canvas's px-per-point, whatever it is. */
function paint(canvas: FakeElement & { width: number; height: number }, pageW: number): { reads: number[][] } {
  const k = canvas.width / pageW;
  const reads: number[][] = [];
  (canvas as unknown as { getContext(): unknown }).getContext = () => ({
    getImageData(x: number, y: number, w: number, h: number) {
      reads.push([x, y, w, h]);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const px = (x + i + 0.5) / k;
          const py = (y + j + 0.5) / k;
          const ink = px >= 100 && px < 200 && py >= 50 && py < 60;
          data.set(ink ? [16, 32, 48, 255] : [248, 240, 224, 255], (j * w + i) * 4);
        }
      return { data };
    },
  });
  return { reads };
}

describe("samplePage", () => {
  it("returns the paper and ink of the painted page under a page-space rect", async () => {
    env.win.devicePixelRatio = 2;
    const doc = fakeDoc(3);
    const view = createPdfView({ textLayer: false });
    env.doc.body.appendChild(view.el as unknown as FakeElement);
    const rendered = new Set<string>();
    view.on("pagerendered", (e) => rendered.add(e.key));
    // nothing painted yet
    expect(view.samplePage!("p0", [100, 50, 100, 10])).toBeNull();
    view.setPages(pagesOf(doc));
    await until(() => rendered.has("p0"));
    const canvas = (view.el as unknown as FakeElement).querySelector(".pdfv-canvas") as FakeElement & { width: number; height: number };
    expect(canvas).not.toBeNull();
    const { reads } = paint(canvas, 612);
    expect(view.samplePage!("p0", [100, 50, 100, 10])).toEqual({ paper: "#f8f0e0", ink: "#102030" });
    // the patch is the rect + the 2 pt ring, in this canvas's px
    const k = canvas.width / 612;
    const [x, y, w, h] = reads[0]! as [number, number, number, number];
    expect(x).toBe(Math.floor(98 * k));
    expect(y).toBe(Math.floor(48 * k));
    expect(x + w).toBe(Math.ceil(202 * k));
    expect(y + h).toBe(Math.ceil(62 * k));
    // a rect of plain paper: no ink stands out
    expect(view.samplePage!("p0", [300, 300, 40, 10])).toEqual({ paper: "#f8f0e0", ink: "#000000" });
    // unknown key → null
    expect(view.samplePage!("zz", [100, 50, 100, 10])).toBeNull();
    view.dispose();
    expect(view.samplePage!("p0", [100, 50, 100, 10])).toBeNull();
  });
});
