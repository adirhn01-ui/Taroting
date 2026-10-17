// "Edit text" picking against the real fixtures (pdf.js legacy build), through
// a minimal Env whose `pt` converts client px with the view's own maths.

import { describe, expect, it, vi } from "vitest";
import type { PdfRotation } from "../../../core/types";
import type { PageRect, PdfDoc } from "../../types";
import { boxToPage, pageToBox } from "../../view/math";
import { fixture, hasFixtures, testLoader } from "../../view/fixtures.test-util";
import type { Env } from "./env";
import { pickTextAt, pickTextIn } from "./edit-text";

const PAGE_H = 841.89;
const PAGE_W = 595.28;
const ZOOM = 1.5;

interface Opts {
  rot?: PdfRotation;
  sample?: ((key: string, rect: PageRect) => { ink: string; paper: string } | null) | null;
}

/** One page `key` = source page `index`; client px = box px at ZOOM turned by rot. */
function envFor(doc: PdfDoc, index: number, o: Opts = {}) {
  const rot = o.rot ?? 0;
  const sample = vi.fn(o.sample === undefined ? () => ({ ink: "#112233", paper: "#fefefe" }) : (o.sample ?? (() => null)));
  const env = {
    ctx: {
      session: { project: { pdf: { pages: [{ id: "K", src: "S", page: index, rotate: 0 }, { id: "B", src: null, page: 0, rotate: 0, w: 100, h: 100 }] } } },
      docs: new Map([["S", doc]]),
      view: { samplePage: o.sample === null ? undefined : sample },
    },
    pt: (key: string, e: { clientX: number; clientY: number }) => (key === "K" ? boxToPage(e.clientX, e.clientY, PAGE_W, PAGE_H, rot, ZOOM) : null),
  } as unknown as Env;
  /** the client point over page point (x, y) */
  const at = (x: number, y: number) => pageToBox(x, y, PAGE_W, PAGE_H, rot, ZOOM);
  return { env, sample, at };
}

describe.skipIf(!hasFixtures)("pickTextAt / pickTextIn on the fixtures", () => {
  it("clicking the 'Page 2 of 3' heading returns that line, box, size 24, Arial, not bold", async () => {
    const doc = await testLoader().openPdf("p3", fixture("plain_3p.pdf"));
    // render-equivalent: the page's fonts reach commonObjs, as after a paint
    await (doc.doc as { getPage(n: number): Promise<{ getOperatorList(): Promise<unknown> }> }).getPage(2).then((p) => p.getOperatorList());
    const { env, sample, at } = envFor(doc, 1);
    const c0 = at(100, 65);
    const c = (await pickTextAt(env, "K", c0.x, c0.y))!;
    expect(c).not.toBeNull();
    expect(c.key).toBe("K");
    expect(c.text).toBe("Page 2 of 3");
    expect(c.edit.orig).toBe("Page 2 of 3");
    expect(c.size).toBeCloseTo(24, 6);
    expect(c.font).toBe("Arial");
    expect(c.bold).toBe(false);
    expect(c.italic).toBe(false);
    expect(c.align).toBe("left");
    expect(c.color).toBe("#112233");
    expect(c.edit.cover).toBe("#fefefe");
    // glyph rect: x 60..182.76, ascent .718 / descent -.207 of 24 around baseline y = h-770
    expect(c.edit.rects).toHaveLength(1);
    const [x, y, w, h] = c.edit.rects[0]!;
    expect(x).toBeCloseTo(60, 3);
    expect(x + w).toBeCloseTo(182.76, 2);
    expect(y).toBeCloseTo(PAGE_H - 770 - 0.718 * 24, 3);
    expect(y + h).toBeCloseTo(PAGE_H - 770 + 0.207 * 24, 3);
    expect(c.box).toEqual([x - 1, y - 1, w + 2, h + 2]);
    // colours were sampled over the box
    expect(sample).toHaveBeenCalledWith("K", c.box);
    // 1.5 pt below the glyph box still picks it (the 3 pt tolerance) …
    const below = at(100, y + h + 1.5);
    expect((await pickTextAt(env, "K", below.x, below.y))?.text).toBe("Page 2 of 3");
    // … 13 pt below does not, and neither does empty space
    const gap = at(100, 90);
    expect(await pickTextAt(env, "K", gap.x, gap.y)).toBeNull();
    const empty = at(300, 400);
    expect(await pickTextAt(env, "K", empty.x, empty.y)).toBeNull();
    await doc.destroy();
  });

  it("a body-line click picks its whole paragraph (soft wraps joined by a space); Alt (line) picks one line", async () => {
    const doc = await testLoader().openPdf("p3b", fixture("plain_3p.pdf"));
    const { env, at } = envFor(doc, 0);
    // click the SECOND body line: the walk must go up as well as down
    const p = at(300, PAGE_H - 712 - 3);
    const c = (await pickTextAt(env, "K", p.x, p.y))!;
    expect(c.text).toBe(
      "The quick brown fox jumps over the lazy dog. Taroting reads this page so the search, the text layer and the copy path have real words to find.",
    );
    expect(c.edit.orig).toBe(c.text);
    expect(c.text).not.toContain("Page 1");
    expect(c.size).toBeCloseTo(12, 6);
    expect(c.edit.rects).toHaveLength(2);
    // the box covers both lines, the widest one's width, and not the heading (baseline 770)
    const [r1, r2] = c.edit.rects as [number, number, number, number][];
    expect(c.box[1]).toBeLessThan(r1![1]);
    expect(c.box[1] + c.box[3]).toBeGreaterThan(r2![1] + r2![3]);
    expect(c.box[2]).toBeCloseTo(Math.max(r1![2], r2![2]) + 2, 6);
    expect(c.box[1]).toBeGreaterThan(PAGE_H - 770);
    // Alt+click: just the clicked line
    const one = (await pickTextAt(env, "K", p.x, p.y, { line: true }))!;
    expect(one.text).toBe("search, the text layer and the copy path have real words to find.");
    expect(one.edit.rects).toHaveLength(1);
    // the heading stays its own paragraph (another size)
    const h = at(100, 65);
    expect((await pickTextAt(env, "K", h.x, h.y))!.text).toBe("Page 1 of 3");
    await doc.destroy();
  });

  it("a drag over the two body lines returns both, joined with a newline, one rect each", async () => {
    const doc = await testLoader().openPdf("p3c", fixture("plain_3p.pdf"));
    const { env } = envFor(doc, 1);
    const c = (await pickTextIn(env, "K", [80, 100, 50, 30]))!;
    expect(c.text).toBe(
      "The quick brown fox jumps over the lazy dog. Taroting reads this page so the\nsearch, the text layer and the copy path have real words to find. needle",
    );
    expect(c.edit.rects).toHaveLength(2);
    expect(c.edit.rects[0]![1]).toBeLessThan(c.edit.rects[1]![1]);
    // the box covers both lines
    expect(c.box[1]).toBeLessThan(c.edit.rects[0]![1]);
    expect(c.box[1] + c.box[3]).toBeGreaterThan(c.edit.rects[1]![1] + c.edit.rects[1]![3]);
    // the heading is not in it, and a drag over nothing picks nothing
    expect(c.text).not.toContain("Page 2");
    expect(await pickTextIn(env, "K", [300, 300, 50, 50])).toBeNull();
    await doc.destroy();
  });

  it("a /Rotate 90 page: the click goes through the turned box and the rects stay in page space", async () => {
    const doc = await testLoader().openPdf("rot", fixture("rotated.pdf"));
    const upright = envFor(doc, 0);
    const turned = envFor(doc, 1, { rot: 90 });
    const pa = upright.at(100, 65);
    const pb = turned.at(100, 65);
    // the client points really differ: the turn is exercised, not bypassed
    expect(Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y)).toBeGreaterThan(100);
    const a = (await pickTextAt(upright.env, "K", pa.x, pa.y))!;
    const b = (await pickTextAt(turned.env, "K", pb.x, pb.y))!;
    expect(a.text).toBe("Page 1 of 3");
    expect(b.text).toBe("Page 2 of 3");
    // same text geometry on both pages (the turn is display only)
    expect(b.edit.rects).toEqual(a.edit.rects);
    expect(b.edit.rects[0]![0]).toBeCloseTo(60, 3);
    // the upright client point fed to the turned page lands elsewhere: nothing there
    expect(await pickTextAt(turned.env, "K", pa.x, pa.y)).toBeNull();
    await doc.destroy();
  });

  it("Hebrew: logical order and right alignment", async () => {
    const doc = await testLoader().openPdf("he", fixture("hebrew.pdf"));
    const { env, at } = envFor(doc, 0);
    const p = at(120, PAGE_H - 760 - 6);
    const c = (await pickTextAt(env, "K", p.x, p.y))!;
    expect(c.text.startsWith("שלום")).toBe(true);
    expect(c.text).not.toContain("םולש");
    expect(c.align).toBe("right");
    await doc.destroy();
  });

  it("null when the page is not rendered, on a blank page and off the page", async () => {
    const doc = await testLoader().openPdf("p3d", fixture("plain_3p.pdf"));
    const notRendered = envFor(doc, 1, { sample: () => null });
    const p = notRendered.at(100, 65);
    expect(await pickTextAt(notRendered.env, "K", p.x, p.y)).toBeNull();
    expect(await pickTextIn(notRendered.env, "K", [80, 100, 50, 30])).toBeNull();
    const noSampler = envFor(doc, 1, { sample: null });
    expect(await pickTextAt(noSampler.env, "K", p.x, p.y)).toBeNull();
    const ok = envFor(doc, 1);
    expect(await pickTextAt(ok.env, "B", 10, 10)).toBeNull();
    expect(await pickTextIn(ok.env, "B", [0, 0, 100, 100])).toBeNull();
    expect(await pickTextAt(ok.env, "nope", p.x, p.y)).toBeNull();
    await doc.destroy();
  });

  it("hovering the same line again reuses its sampled colours; a miss samples nothing", async () => {
    const doc = await testLoader().openPdf("p3e", fixture("plain_3p.pdf"));
    const { env, sample, at } = envFor(doc, 1);
    const p = at(100, 65);
    await pickTextAt(env, "K", p.x, p.y);
    const q = at(150, 70);
    await pickTextAt(env, "K", q.x, q.y);
    expect(sample).toHaveBeenCalledTimes(1);
    const miss = at(300, 400);
    await pickTextAt(env, "K", miss.x, miss.y);
    expect(sample).toHaveBeenCalledTimes(1);
    await doc.destroy();
  });
});
