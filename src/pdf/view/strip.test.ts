import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEvent, type FakeElement } from "../editor/fake-dom.test-util";
import type { PdfFormValue } from "../../core/types";
import { annotRenders, fakeDoc, installEnv, pagesOf, until, type Env } from "./dom.test-util";

vi.mock("./pdfjs", async () => (await import("./dom.test-util")).pdfjsModule());

const { createPdfView } = await import("./strip");

let env: Env;
beforeEach(() => {
  env = installEnv();
  annotRenders.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(opts: Parameters<typeof createPdfView>[0] = { textLayer: false }) {
  const view = createPdfView(opts);
  env.doc.body.appendChild(view.el as unknown as FakeElement);
  const rendered = new Set<string>();
  const hidden = new Set<string>();
  view.on("pagerendered", (e) => rendered.add(e.key));
  view.on("pagehidden", (e) => hidden.add(e.key));
  return { view, el: view.el as unknown as FakeElement, rendered, hidden };
}

describe("pdf.js page memory", () => {
  it("a page scrolled out of the render window releases its pdf.js page data", async () => {
    const doc = fakeDoc(40);
    const { view, el, rendered, hidden } = mount();
    view.setPages(pagesOf(doc));
    await until(() => rendered.has("p0"));
    const p1 = doc.proxies.get(1)!;
    expect(p1.cleanup).not.toHaveBeenCalled();
    el.scrollTop = 30_000;
    el.dispatchEvent(new FakeEvent("scroll"));
    env.flushFrames();
    expect(hidden.has("p0")).toBe(true);
    expect(p1.cleanup).toHaveBeenCalled();
    view.dispose();
  });

  it("dispose releases every rendered page", async () => {
    const doc = fakeDoc(5);
    const { view, rendered } = mount();
    view.setPages(pagesOf(doc));
    await until(() => rendered.has("p0"));
    const rendered0 = [...doc.proxies.values()].filter((p) => p.render.mock.calls.length > 0);
    expect(rendered0.length).toBeGreaterThan(0);
    view.dispose();
    for (const p of rendered0) expect(p.cleanup).toHaveBeenCalled();
  });

  it("a canvas evicted under the pixel budget releases its page too (the slot stays)", async () => {
    // short wide pages at a huge device ratio: each canvas clamps to ~11M
    // backing px, so the render window overflows the 64M budget and the
    // off-screen canvases give way while their slots keep their DOM
    env.win.devicePixelRatio = 100;
    const doc = fakeDoc(40, { w: 612, h: 100 });
    const { view, rendered, hidden } = mount();
    view.setPages(pagesOf(doc));
    await until(() => rendered.size >= 8);
    const cleaned = [...doc.proxies.entries()].filter(([, p]) => p.cleanup.mock.calls.length > 0).map(([n]) => `p${n - 1}`);
    expect(cleaned.length).toBeGreaterThan(0);
    for (const k of cleaned) expect(hidden.has(k)).toBe(false);
    view.dispose();
  });
});

describe("links", () => {
  it("a middle click on an internal link does nothing (no new window)", async () => {
    const doc = fakeDoc(2, { annots: (i) => (i === 0 ? [{ id: "9R", subtype: "Link" }] : []) });
    const { view, el } = mount();
    view.setPages(pagesOf(doc));
    await until(() => el.querySelector("a") !== null);
    const a = el.querySelector("a")!;
    const middle = new FakeEvent("auxclick", { button: 1 });
    a.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    view.dispose();
  });
});

describe("form values on undo/redo", () => {
  // Characterisation: the shell refreshes widget values with invalidate(key).
  it("invalidate re-seeds the page's widgets from the project and rebuilds the forms layer", async () => {
    let value: PdfFormValue | undefined = "a";
    const forms = { get: () => value, set: vi.fn() };
    const doc = fakeDoc(1, { annots: () => [{ id: "7R", subtype: "Widget", fieldType: "Tx" }] });
    const { view } = mount({ textLayer: false, forms });
    view.setFormsLayer(true);
    view.setPages(pagesOf(doc));
    await until(() => annotRenders.length === 1);
    expect(doc.storage.getRawValue("7R")).toEqual({ value: "a" });
    value = "b"; // undo
    view.invalidate("p0");
    await until(() => annotRenders.length === 2);
    expect(doc.storage.getRawValue("7R")).toEqual({ value: "b" });
    value = undefined; // undo back past the first edit
    view.invalidate("p0");
    await until(() => annotRenders.length === 3);
    expect(doc.storage.getRawValue("7R")).toBeUndefined();
    expect(forms.set).not.toHaveBeenCalled();
    view.dispose();
  });
});
