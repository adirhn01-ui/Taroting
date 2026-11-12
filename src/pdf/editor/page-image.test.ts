import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../../core/types";

// page-image's two renderers against recorders for the PDF build, pdf.js and
// the shared worker: the one-page path builds a one-page PDF per call; the
// several-pages path builds ONE PDF for the chosen span, opens it once and
// frees it exactly once whatever happens.

const h = vi.hoisted(() => ({
  builds: [] as { range: unknown; signal: unknown }[],
  buildImpl: null as null | ((signal?: AbortSignal) => Promise<Uint8Array>),
  opens: 0,
  openImpl: null as null | (() => Promise<unknown>),
  destroys: 0,
  acquires: 0,
  releases: 0,
  getPages: [] as number[],
  cleanups: 0,
  renderImpl: null as null | ((n: number) => Promise<void>),
  canvases: [] as { width: number; height: number }[],
}));

vi.mock("../../core/ipc", () => ({ ipc: {} }));
vi.mock("../export/deps", () => ({ appDeps: () => Promise.resolve({}) }));
vi.mock("../export/export", () => ({
  buildPdf: (_p: unknown, opts: { range: unknown; signal?: AbortSignal }) => {
    h.builds.push({ range: opts.range, signal: opts.signal });
    return h.buildImpl ? h.buildImpl(opts.signal) : Promise.resolve(new Uint8Array([1]));
  },
}));
vi.mock("../view/pdfjs", () => ({
  documentParams: () => ({}),
  sharedWorker: {
    acquire: () => {
      h.acquires++;
      return {};
    },
    release: () => void h.releases++,
  },
  loadPdfjs: () =>
    Promise.resolve({
      getDocument: () => {
        h.opens++;
        const doc = {
          getPage: (n: number) => {
            h.getPages.push(n);
            return Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
              render: () => ({ promise: h.renderImpl ? h.renderImpl(n) : Promise.resolve() }),
              cleanup: () => void h.cleanups++,
            });
          },
        };
        return {
          promise: h.openImpl ? h.openImpl().then(() => doc) : Promise.resolve(doc),
          destroy: () => {
            h.destroys++;
            return Promise.resolve();
          },
        };
      },
    }),
}));

const { openPageImages, renderPageImage } = await import("./page-image");

const project = {} as ProjectFile;
const req = (page: number) => ({ page, w: 50, h: 100, type: "image/png" as const, quality: 92 });

beforeEach(() => {
  h.builds = [];
  h.buildImpl = null;
  h.opens = 0;
  h.openImpl = null;
  h.destroys = 0;
  h.acquires = 0;
  h.releases = 0;
  h.getPages = [];
  h.cleanups = 0;
  h.renderImpl = null;
  h.canvases = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const c = {
        width: 0,
        height: 0,
        toBlob: (cb: (b: unknown) => void) => cb({ size: 1, w: c.width, h: c.height }),
      };
      h.canvases.push(c);
      return c;
    },
  };
});
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe("renderPageImage (This page)", () => {
  it("builds a one-page PDF per call, as before", async () => {
    await renderPageImage(project, req(2));
    await renderPageImage(project, req(3));
    expect(h.builds.map((b) => b.range)).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(h.getPages).toEqual([1, 1]);
    expect([h.destroys, h.releases]).toEqual([2, 2]);
  });
});

describe("openPageImages (several pages)", () => {
  it("builds and opens ONE PDF for the chosen span and renders every page from it", async () => {
    const ac = new AbortController();
    const images = await openPageImages(project, [4, 5, 6, 7], ac.signal);
    const blobs = [];
    for (const n of [4, 5, 6, 7]) blobs.push(await images.render(req(n)));
    await images.close();
    expect(h.builds).toEqual([{ range: [4, 7], signal: ac.signal }]);
    expect(h.opens).toBe(1);
    // output page k of the span is document page first + k - 1
    expect(h.getPages).toEqual([1, 2, 3, 4]);
    expect(blobs).toEqual([1, 2, 3, 4].map(() => ({ size: 1, w: 50, h: 100 })));
    // every page let go, every canvas emptied
    expect(h.cleanups).toBe(4);
    expect(h.canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
  });

  it("frees the document and the worker share exactly once, close after close", async () => {
    const images = await openPageImages(project, [1, 2]);
    expect([h.acquires, h.releases, h.destroys]).toEqual([1, 0, 0]);
    await images.close();
    await images.close();
    expect([h.acquires, h.releases, h.destroys]).toEqual([1, 1, 1]);
    await expect(images.render(req(1))).rejects.toThrow();
    expect(h.getPages).toEqual([]);
  });

  it("a page that fails to render leaves the document open for close() to free", async () => {
    h.renderImpl = (n) => (n === 2 ? Promise.reject(new Error("bad page")) : Promise.resolve());
    const images = await openPageImages(project, [1, 2, 3]);
    await images.render(req(1));
    await expect(images.render(req(2))).rejects.toThrow("bad page");
    expect(h.cleanups).toBe(2);
    expect(h.destroys).toBe(0);
    await images.close();
    expect([h.releases, h.destroys]).toEqual([1, 1]);
  });

  it("refuses a page outside the prepared span", async () => {
    const images = await openPageImages(project, [2, 3]);
    await expect(images.render(req(1))).rejects.toThrow(RangeError);
    await expect(images.render(req(4))).rejects.toThrow(RangeError);
    await images.close();
  });

  it("a cancel during the build takes no worker; a cancel during the open frees it", async () => {
    const ac = new AbortController();
    h.buildImpl = (signal) =>
      new Promise((_r, reject) => signal!.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))));
    const p = openPageImages(project, [1, 2], ac.signal);
    for (let i = 0; i < 10 && h.builds.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.builds).toHaveLength(1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect([h.acquires, h.opens]).toEqual([0, 0]);

    h.buildImpl = null;
    const ac2 = new AbortController();
    let opened: () => void = () => {};
    h.openImpl = () => new Promise<void>((r) => (opened = r));
    const p2 = openPageImages(project, [1, 2], ac2.signal);
    for (let i = 0; i < 10 && h.opens === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.opens).toBe(1);
    ac2.abort();
    opened();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect([h.acquires, h.releases, h.destroys]).toEqual([1, 1, 1]);
  });

  it("a document that fails to open is freed before the error is thrown", async () => {
    h.openImpl = () => Promise.reject(new Error("broken"));
    await expect(openPageImages(project, [1])).rejects.toThrow("broken");
    expect([h.acquires, h.releases, h.destroys]).toEqual([1, 1, 1]);
  });
});
