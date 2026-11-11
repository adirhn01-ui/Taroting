// The mark layer and style runs' fonts (0.9.4): a box is re-laid when one of
// its RUN fonts changes state, boxes with other fonts keep their nodes, and a
// project with no fontId anywhere (base or run) adds no listener and makes no
// font call (I1). The font runtime (src/fonts) is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnot } from "../../../core/types";
import { FakeElement, makeKit, project, showPages, type Kit } from "./testkit.test-util";

const f = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  loading: new Set<string>(),
  subscribes: 0,
  faceCalls: 0,
  ensureCalls: 0,
}));
vi.mock("../../../fonts", () => ({
  ensureFonts: async () => {
    f.ensureCalls++;
  },
  fontsReady: (reqs: { id: string }[]) => reqs.every((r) => !f.loading.has(r.id)),
  fontFace: (legacy: string, id: string | undefined, bold: boolean, italic: boolean) => {
    f.faceCalls++;
    return id === undefined ? { family: legacy, bold, italic, missing: false } : { family: `fa-${id.replace(/\W/g, "")}`, bold, italic, missing: false };
  },
  facesOf: () => null,
  missingFonts: () => [],
  onFontsChanged: (cb: () => void) => {
    f.subscribes++;
    f.listeners.add(cb);
    return () => f.listeners.delete(cb);
  },
  mountFontPicker: () => ({ refresh() {}, dispose() {} }),
}));
vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {} } }));

const { createMarkLayer } = await import("./layer");

type Text = Extract<PdfAnnot, { t: "text" }>;
const text = (id: string, extra: Partial<Text> = {}): PdfAnnot => ({
  id, t: "text", x: 100, y: 100, w: 120, h: 30, text: "hello world", font: "Georgia", size: 12, c: "#112233", bold: false, italic: false, align: "left", ...extra,
});

let kit: Kit;
const fire = (): void => {
  for (const cb of [...f.listeners]) cb();
};
const savedNode = (id: string): FakeElement | undefined => {
  const svg = (kit.view.overlay("P1") as unknown as FakeElement).querySelector("svg")!;
  return svg.children[0]!.children[0]!.children.find((n) => n.getAttribute("data-id") === id);
};

beforeEach(() => {
  f.listeners.clear();
  f.loading.clear();
  f.subscribes = 0;
  f.faceCalls = 0;
  f.ensureCalls = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("the mark layer and run fonts", () => {
  it("re-lays a box when one of its RUN fonts changes state; boxes with other fonts keep their nodes", async () => {
    f.loading.add("lib:Lato");
    kit = makeKit(
      project({
        P1: [
          // legacy base, a library font only in a run
          text("R", { runs: [{ s: 6, e: 11, font: "Segoe UI", fontId: "lib:Lato" }] }),
          text("I", { font: "Segoe UI", fontId: "lib:Inter", y: 300 }),
          text("L", { y: 500 }),
        ],
      }),
    );
    const layer = createMarkLayer(kit.ctx);
    showPages(kit);
    await kit.flush();
    // the run's library font alone subscribes the layer
    expect(f.listeners.size).toBe(1);
    const run = savedNode("R")!;
    const inter = savedNode("I")!;
    const legacy = savedNode("L")!;
    f.loading.clear();
    fire();
    const relaid = savedNode("R")!;
    expect(relaid).toBeTruthy();
    expect(relaid).not.toBe(run);
    expect(savedNode("I")).toBe(inter);
    expect(savedNode("L")).toBe(legacy);
    // nothing changed since: nothing is built
    fire();
    expect(savedNode("R")).toBe(relaid);
    layer.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it("a project with runs but no fontId anywhere adds no listener and makes no font call (I1)", async () => {
    kit = makeKit(project({ P1: [text("L", { runs: [{ s: 0, e: 5, font: "Impact", size: 20, bold: true }] })] }));
    const layer = createMarkLayer(kit.ctx);
    showPages(kit);
    await kit.flush();
    expect(savedNode("L")).toBeTruthy();
    expect(f.subscribes).toBe(0);
    expect(f.faceCalls).toBe(0);
    expect(f.ensureCalls).toBe(0);
    layer.dispose();
  });
});
