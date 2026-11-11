// PDF text boxes and the font library, the integration gaps (0.9.4): an
// existing box gains and loses a library font through the inspector, the Text
// tool's new box keeps the tool's fontId, the open editor restyles on a
// fontId-only change and stays open while the shared font picker is used,
// and the mark layer re-lays fontId boxes when the library changes (and
// listens for nothing in a project without one: I1). The font runtime
// (src/fonts) is faked: it belongs to another package.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontFamily, FontId, PdfAnnot } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { pageAnnots } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, showPages, type Kit } from "./testkit.test-util";

type Pick = { legacy: FontFamily; fontId?: FontId };
const f = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  /** ids whose face has not landed yet */
  loading: new Set<string>(),
  subscribes: 0,
  faceCalls: 0,
  ensureCalls: 0,
  pickers: [] as { value(): Pick; onPick(v: Pick): void }[],
}));
vi.mock("../../../fonts", () => ({
  ensureFonts: async () => {
    f.ensureCalls++;
  },
  fontsReady: (reqs: { id: string }[]) => reqs.every((r) => !f.loading.has(r.id)),
  // a family named after the id, so a fontId-only change shows in the CSS
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
  mountFontPicker: (_host: unknown, opts: { value(): Pick; onPick(v: Pick): void }) => {
    f.pickers.push(opts);
    return { refresh() {}, dispose() {} };
  },
}));
vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {} } }));
vi.mock("../../../core/session", async (orig) => {
  const real = await orig<typeof import("../../../core/session")>();
  return { ...real, updateSettings: vi.fn(async () => {}) };
});

const { settingsStore } = await import("../../../core/session");
const { toolsPart } = await import("../tools");
const { inspectorPart } = await import("../inspector");
const { createMarkLayer } = await import("./layer");

type Text = Extract<PdfAnnot, { t: "text" }>;
const text = (id: string, extra: Partial<Text> = {}): PdfAnnot => ({
  id, t: "text", x: 100, y: 100, w: 120, h: 30, text: "hello", font: "Georgia", size: 12, c: "#112233", bold: false, italic: false, align: "left", ...extra,
});

let kit: Kit;
let parts: { dispose(): void }[] = [];
async function mount(p = project()): Promise<void> {
  kit = makeKit(p);
  parts = [toolsPart(kit.ctx, kit.hosts), inspectorPart(kit.ctx, kit.hosts)];
  showPages(kit);
  await kit.flush();
}
const marks = (): readonly PdfAnnot[] => pageAnnots(kit.session.project, "P1");
const picker = () => f.pickers[f.pickers.length - 1]!;
const fire = (): void => {
  for (const cb of [...f.listeners]) cb();
};
/** the saved node of mark `id` on page P1 */
const savedNode = (id: string): FakeElement | undefined => {
  const svg = (kit.view.overlay("P1") as unknown as FakeElement).querySelector("svg")!;
  const marksG = svg.children[0]!.children[0]!;
  return marksG.children.find((n) => n.getAttribute("data-id") === id);
};
/** open a new box with the Text tool; its editable div */
async function newBox(): Promise<FakeElement> {
  kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
  await kit.flush();
  kit.pointer("pointerdown", 300, 300);
  await kit.flush();
  expect(kit.ctx.textEdit.get()?.draft).toBeTruthy();
  return kit.doc.activeElement;
}

beforeEach(() => {
  f.listeners.clear();
  f.loading.clear();
  f.subscribes = 0;
  f.faceCalls = 0;
  f.ensureCalls = 0;
  f.pickers.length = 0;
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [], pdfToolStyle: {} });
});
afterEach(() => {
  for (const p of parts.splice(0)) p.dispose();
  vi.unstubAllGlobals();
});

describe("an existing box's font through the inspector", () => {
  it("a library pick on a legacy box writes both fields, a legacy pick takes fontId off: one step each", async () => {
    await mount(project({ P1: [text("t")] }));
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    picker().onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    expect(marks()[0]).toMatchObject({ font: "Segoe UI", fontId: "lib:Inter" });
    expect(kit.session.steps).toBe(1);
    picker().onPick({ legacy: "Courier New" });
    expect("fontId" in marks()[0]!).toBe(false);
    expect((marks()[0] as Text).font).toBe("Courier New");
    expect(kit.session.steps).toBe(2);
  });
});

describe("the Text tool and the open editor", () => {
  it("a new box lands with the tool's fontId", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, font: "Segoe UI", fontId: "Consolas" }));
    const div = await newBox();
    div.textContent = "typed";
    kit.keydown("Escape");
    expect(kit.ctx.textEdit.get()).toBeNull();
    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toMatchObject({ text: "typed", font: "Segoe UI", fontId: "Consolas" });
  });

  it("restyles on a fontId-only change", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, font: "Segoe UI", fontId: "lib:Inter" }));
    const div = await newBox();
    expect(div.style.fontFamily).toBe('fa-libInter, "Segoe UI"');
    const e = kit.ctx.textEdit.get()!;
    kit.ctx.textEdit.set({ ...e, draft: { ...e.draft!, fontId: "lib:Lato" } });
    await kit.flush();
    expect(div.style.fontFamily).toBe('fa-libLato, "Segoe UI"');
  });

  it("a press inside the font picker (.fontpk) keeps the editor open; a press elsewhere commits", async () => {
    await mount();
    const div = await newBox();
    div.textContent = "kept";
    // the picker's list lives on <body>, outside the inspector
    const pop = new FakeElement("div");
    pop.className = "fontpk fontpk__pop";
    const row = new FakeElement("div");
    pop.appendChild(row);
    kit.doc.body.appendChild(pop);
    row.dispatchEvent(new FakeEvent("pointerdown", { button: 0 }));
    row.dispatchEvent(new FakeEvent("mousedown", { button: 0 }));
    div.blur();
    expect(kit.ctx.textEdit.get()).not.toBeNull();
    expect(marks()).toHaveLength(0);
    // a press anywhere else still lands the box
    div.focus();
    const away = new FakeElement("div");
    kit.doc.body.appendChild(away);
    away.dispatchEvent(new FakeEvent("pointerdown", { button: 0 }));
    away.dispatchEvent(new FakeEvent("mousedown", { button: 0 }));
    div.blur();
    expect(kit.ctx.textEdit.get()).toBeNull();
    expect(marks()).toHaveLength(1);
  });

  it("the saved text stays hidden under the editor when the library change re-lays it", async () => {
    f.loading.add("lib:Inter");
    await mount(project({ P1: [text("t", { font: "Segoe UI", fontId: "lib:Inter" })] }));
    kit.pointer("dblclick", 110, 110);
    await kit.flush();
    expect(kit.ctx.textEdit.get()?.id).toBe("t");
    const before = savedNode("t")!;
    expect(before.style.visibility).toBe("hidden");
    f.loading.clear();
    fire();
    await kit.flush();
    const after = savedNode("t")!;
    expect(after).not.toBe(before);
    expect(after.style.visibility).toBe("hidden");
  });
});

describe("the mark layer and library changes", () => {
  it("re-lays only the boxes whose own font changed; unsubscribes on dispose", async () => {
    f.loading.add("lib:Inter");
    kit = makeKit(
      project({
        P1: [
          text("L"),
          text("F", { font: "Segoe UI", fontId: "lib:Inter", y: 300 }),
          text("G", { font: "Segoe UI", fontId: "lib:Lato", y: 500 }),
        ],
      }),
    );
    const layer = createMarkLayer(kit.ctx);
    showPages(kit);
    await kit.flush();
    const legacy = savedNode("L")!;
    const inter = savedNode("F")!;
    const lato = savedNode("G")!;
    expect(f.listeners.size).toBe(1);
    // Inter's face lands: its box is built again, the others keep their nodes
    f.loading.clear();
    fire();
    const relaid = savedNode("F")!;
    expect(relaid).toBeTruthy();
    expect(relaid).not.toBe(inter);
    expect(savedNode("L")).toBe(legacy);
    expect(savedNode("G")).toBe(lato);
    // a change that touches none of them builds nothing
    fire();
    expect(savedNode("F")).toBe(relaid);
    expect(savedNode("G")).toBe(lato);
    layer.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it("a project without a fontId adds no listener and makes no font call (I1)", async () => {
    kit = makeKit(project({ P1: [text("L"), text("M", { font: "Impact", y: 300 })] }));
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
