import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnot } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { encodePoints } from "../../../image/strokes";
import { pageAnnots } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./testkit.test-util";

// the font runtime as a plain <select> of the six (these tests are about the inspector)
vi.mock("../../../fonts", async () => (await import("./fonts-stand-in.test-util")).fontsStandIn());
vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {} } }));
vi.mock("../../../core/session", async (orig) => {
  const real = await orig<typeof import("../../../core/session")>();
  return {
    ...real,
    updateSettings: vi.fn(async (patch: object) => {
      real.settingsStore.set({ ...real.settingsStore.get(), ...patch });
    }),
  };
});

const { settingsStore } = await import("../../../core/session");
const { inspectorPart, inkPresets, withRecent, patchFor } = await import("../inspector");

const ink: PdfAnnot = { id: "i", t: "ink", kind: "pen", c: "#000000", w: 4, o: 1, p: encodePoints(new Float32Array([0, 0, 1, 50, 50, 1])) };
const text: PdfAnnot = { id: "t", t: "text", x: 10, y: 10, w: 60, h: 15, text: "hello world", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left" };

let kit: Kit;
let part: { dispose(): void };
const host = (): FakeElement => kit.hosts.inspector as unknown as FakeElement;

async function mount(annots: PdfAnnot[] = [ink, text]): Promise<void> {
  kit = makeKit(project({ P1: annots }));
  part = inspectorPart(kit.ctx, kit.hosts);
  await kit.flush();
}
const marks = (): readonly PdfAnnot[] => pageAnnots(kit.session.project, "P1");
const title = (): string => host().querySelector(".insp-header__name")?.textContent ?? "";
const byLabel = (tag: string, label: string): FakeElement => host().querySelectorAll(tag).find((e) => e.getAttribute("aria-label") === label)!;
const fire = (el: FakeElement, type: string): void => {
  el.dispatchEvent(new FakeEvent(type, { detail: 1 }));
};

beforeEach(() => {
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [] });
});
afterEach(() => {
  part?.dispose();
  vi.unstubAllGlobals();
});

describe("pure rules", () => {
  it("presets: recents first, then the base shelf, twelve", () => {
    const p = inkPresets(["#123456", "#000000"]);
    expect(p[0]).toBe("#123456");
    expect(p[1]).toBe("#000000");
    expect(p).toHaveLength(12);
    expect(withRecent(["#000000"], "#000000")).toBeNull();
    expect(withRecent(["#000000"], "#ABCDEF")).toEqual(["#abcdef", "#000000"]);
  });
  it("a text box grows to keep its lines when its size grows", async () => {
    await mount();
    const patch = patchFor(text, { size: 24 }) as { h?: number };
    expect(patch.h).toBeGreaterThan(15);
  });
});

describe("panels", () => {
  it("nothing selected: the active tool's style (tool state only, no history)", async () => {
    await mount();
    expect(title()).toBe("Select");
    kit.ctx.tools.update((s) => ({ ...s, tool: "pen" }));
    await kit.flush();
    expect(title()).toBe("Pen");
    const range = byLabel("input", "Size in pixels");
    range.value = "12";
    fire(range, "input");
    fire(range, "change");
    expect(kit.ctx.tools.get().sizes.pen).toBe(12);
    host().querySelectorAll(".pdfmk-swatch").find((b) => b.title === "#e5484d")!.click();
    expect(kit.ctx.tools.get().colors.pen).toBe("#e5484d");
    await kit.flush();
    expect(settingsStore.get().inkColors[0]).toBe("#e5484d");
    expect(kit.session.steps).toBe(0);
  });

  it("text tool: font and size", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
    await kit.flush();
    const font = byLabel("select", "Font");
    font.value = "Georgia";
    fire(font, "change");
    expect(kit.ctx.tools.get().font).toBe("Georgia");
  });

  it("a selected mark: a slider drag is ONE history step, autosave held while dragging", async () => {
    await mount();
    kit.ctx.selection.set([{ key: "P1", id: "i" }]);
    await kit.flush();
    expect(title()).toBe("Ink");
    const range = byLabel("input", "Width in points");
    fire(range, "pointerdown");
    for (const v of ["6", "8", "10"]) {
      range.value = v;
      fire(range, "input");
    }
    expect(kit.session.steps).toBe(0);
    expect((marks()[0] as Extract<PdfAnnot, { t: "ink" }>).w).toBe(10);
    fire(range, "pointerup");
    fire(range, "change");
    expect(kit.session.steps).toBe(1);
    expect(kit.session.history[0]!.pdf!.annots.P1![0]).toBe(ink);
    expect(kit.session.holds).toBe(1);
    expect(kit.session.released).toBe(1);
  });

  it("a colour swatch on selected marks is one step", async () => {
    await mount();
    kit.ctx.selection.set([
      { key: "P1", id: "i" },
      { key: "P1", id: "t" },
    ]);
    await kit.flush();
    expect(title()).toBe("2 marks");
    host().querySelectorAll(".pdfmk-swatch").find((b) => b.title === "#0090ff")!.click();
    expect(kit.session.steps).toBe(1);
    expect(marks().map((a) => ("c" in a ? a.c : null))).toEqual(["#0090ff", "#0090ff"]);
  });

  it("text style toggles and Delete are one step each", async () => {
    await mount();
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    host().querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Bold")!.click();
    expect(kit.session.steps).toBe(1);
    expect((marks()[1] as Extract<PdfAnnot, { t: "text" }>).bold).toBe(true);
    host().querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Align center")!.click();
    expect((marks()[1] as Extract<PdfAnnot, { t: "text" }>).align).toBe("center");
    host().querySelectorAll("button").find((b) => b.innerHTML === "Delete")!.click();
    expect(kit.session.steps).toBe(3);
    expect(marks().map((a) => a.id)).toEqual(["i"]);
    expect(kit.ctx.selection.get()).toEqual([]);
  });

  it("only pages selected: turn and delete them", async () => {
    await mount();
    kit.ctx.pageSelection.set([1]);
    await kit.flush();
    expect(title()).toBe("1 page selected");
    host().querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Rotate right")!.click();
    expect(kit.session.steps).toBe(1);
    expect(kit.session.project.pdf!.pages[1]!.rotate).toBe(90);
    host().querySelectorAll("button").find((b) => b.innerHTML === "Delete pages")!.click();
    expect(kit.session.project.pdf!.pages.map((p) => p.id)).toEqual(["P1"]);
  });

  it("Fill forms mode shows a note", async () => {
    await mount();
    kit.ctx.mode.set("forms");
    await kit.flush();
    // the Document section, whatever the tool (no fields here: disabled, says why)
    expect(title()).toBe("Fill forms");
    expect(host().querySelector(".insp-note")!.textContent).toBe("This PDF has no fillable fields.");
  });

  it("dispose removes the panel", async () => {
    await mount();
    part.dispose();
    expect(host().children).toHaveLength(0);
    kit.ctx.tools.update((s) => ({ ...s, tool: "pen" }));
    await kit.flush();
    expect(host().children).toHaveLength(0);
  });
});
