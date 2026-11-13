import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeElement } from "../editor/fake-dom.test-util";
import type { PdfViewPage, PdfViewPicture } from "../types";
import { installEnv, until, type Env } from "./dom.test-util";

vi.mock("./pdfjs", async () => (await import("./dom.test-util")).pdfjsModule());

const { createThumbRail } = await import("./thumbs");

// The rail's picture pages (0.9.5): the small cached thumbnail, not the
// original file; the original only when the thumbnail fails; and a rebuild
// (every page op calls setPages) keeps an unchanged picture as it is.

let env: Env;
beforeEach(() => {
  env = installEnv();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const picture = (file: string, thumb?: () => Promise<string>, patch: Partial<PdfViewPicture> = {}): PdfViewPicture => ({
  file,
  url: `asset://${file}`,
  ...(thumb ? { thumb } : {}),
  x: 0.1,
  y: 0.2,
  w: 0.5,
  h: 0.3,
  ...patch,
});

const blank = (key: string, pic?: PdfViewPicture, rotate: 0 | 90 = 0): PdfViewPage => ({
  key,
  doc: null,
  index: 0,
  rotate,
  w: 600,
  h: 300,
  ...(pic ? { picture: pic } : {}),
});

function mount(pages: PdfViewPage[]) {
  const rail = createThumbRail({ onPick: () => {} });
  env.doc.body.appendChild(rail.el as unknown as FakeElement);
  const el = rail.el as unknown as FakeElement;
  const set = (p: PdfViewPage[]): void => rail.setPages(p);
  const rows = (): FakeElement[] => el.querySelectorAll(".pdfv-thumb");
  const near = (...slots: number[]): void => {
    const r = rows();
    env.io[env.io.length - 1]!.cb(slots.map((i) => ({ target: r[i]!, isIntersecting: true })));
  };
  const img = (slot: number): (FakeElement & { src?: string; onerror?: (() => void) | null }) | null =>
    (rows()[slot]!.querySelector(".pdfv-thumb__pic img") as (FakeElement & { src?: string }) | null) ?? null;
  set(pages);
  return { rail, set, rows, near, img };
}

describe("the rail's page pictures", () => {
  it("shows the cached thumbnail, asked only when the item comes near", async () => {
    const thumb = vi.fn(async () => "asset://cache/thumbs/abc_0.jpg");
    const m = mount([blank("a", picture("C:/scan-01.jpg", thumb)), blank("b")]);
    expect(thumb).not.toHaveBeenCalled();
    expect(m.img(0)).toBeNull();
    m.near(0, 1);
    await until(() => m.img(0)?.src !== undefined);
    expect(m.img(0)!.src).toBe("asset://cache/thumbs/abc_0.jpg");
    expect(thumb).toHaveBeenCalledTimes(1);
    // a blank page without a picture gets none
    expect(m.img(1)).toBeNull();
    m.rail.dispose();
  });

  it("falls back to the original when the thumbnail is refused or does not load", async () => {
    const m = mount([
      blank("a", picture("C:/a.jpg", async () => Promise.reject(new Error("ffmpeg")))),
      blank("b", picture("C:/b.jpg", async () => "asset://cache/broken.jpg")),
    ]);
    m.near(0, 1);
    await until(() => m.img(0)?.src !== undefined && m.img(1)?.src !== undefined);
    expect(m.img(0)!.src).toBe("asset://C:/a.jpg");
    expect(m.img(1)!.src).toBe("asset://cache/broken.jpg");
    m.img(1)!.onerror!();
    expect(m.img(1)!.src).toBe("asset://C:/b.jpg");
    m.rail.dispose();
  });

  it("a rebuild keeps an unchanged picture's element (no new request, no new decode); a changed one is made anew", async () => {
    const thumb = vi.fn(async () => "asset://cache/t.jpg");
    const pages = [blank("x"), blank("a", picture("C:/a.jpg", thumb)), blank("b", picture("C:/b.jpg", thumb))];
    const m = mount(pages);
    m.near(0, 1, 2);
    await until(() => m.img(1)?.src !== undefined && m.img(2)?.src !== undefined);
    const shownA = m.img(1)!;
    const shownB = m.img(2)!;
    expect(thumb).toHaveBeenCalledTimes(2);
    // a page op: "x" deleted, "b" turned; every item is rebuilt from fresh objects
    m.set([blank("a", picture("C:/a.jpg", thumb)), blank("b", picture("C:/b.jpg", thumb), 90)]);
    // "a" shows at once, the very element, before it is even near again
    expect(m.img(0)).toBe(shownA);
    m.near(0, 1);
    await until(() => m.img(1)?.src !== undefined);
    expect(m.img(0)).toBe(shownA);
    expect(m.img(1)).not.toBe(shownB);
    // only the turned page asked again
    expect(thumb).toHaveBeenCalledTimes(3);
    m.rail.dispose();
  });

  it("a missing picture (0.9.5): its box as a placeholder, nothing asked; a page with one is marked", async () => {
    const thumb = vi.fn(async () => "asset://cache/t.jpg");
    const m = mount([
      { ...blank("a", picture("C:/gone.jpg", thumb, { missing: true })), missingPicture: true },
      blank("b", picture("C:/here.jpg", thumb)),
    ]);
    m.near(0, 1);
    await until(() => m.img(1)?.src !== undefined);
    const holder = m.rows()[0]!.querySelector(".pdfv-thumb__pic")!;
    expect(holder.classList.contains("pdfv-thumb__pic--missing")).toBe(true);
    expect(String(holder.style.cssText)).toContain("left:10%");
    expect(m.img(0)).toBeNull();
    expect(thumb).toHaveBeenCalledTimes(1);
    expect(m.rows()[0]!.querySelector(".pdfv-thumb__badge")).not.toBeNull();
    expect(m.rows()[0]!.getAttribute("aria-label")).toBe("Page 1, picture missing");
    expect(m.rows()[1]!.querySelector(".pdfv-thumb__badge")).toBeNull();
    // found again (a rebuild with the picture present): the picture is asked for
    m.set([blank("a", picture("C:/gone.jpg", thumb)), blank("b", picture("C:/here.jpg", thumb))]);
    m.near(0, 1);
    await until(() => m.img(0)?.src !== undefined);
    expect(m.rows()[0]!.querySelector(".pdfv-thumb__badge")).toBeNull();
    m.rail.dispose();
  });
});
