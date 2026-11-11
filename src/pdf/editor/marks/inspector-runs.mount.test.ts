// The PDF inspector with per-range text styles (0.9.4 runs): routing a per-run
// control to the editor's selected part, what the controls show, and the
// whole-box rule (a whole-box write takes that property off every run, in the
// same history step). The `textEdit` store is faked here: these tests are
// about the panel, not the editor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { styleSummary, type PdfRunField, type PdfRunPatch } from "../../../core/pdf-runs";
import type { FontId, PdfAnnot, PdfTextRun, ProjectFile } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { pageAnnots, updateAnnot } from "../../model";
import type { PdfTextEditing } from "../../types";
import { frameOf, textHeight, withFrameH } from "./geom";
import { textLines } from "./render";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./testkit.test-util";

const faces = new Map<string, { bold: boolean; italic: boolean }[]>();
vi.mock("../../../fonts", async () => {
  const base = (await import("./fonts-stand-in.test-util")).fontsStandIn();
  return { ...base, facesOf: (id: string) => faces.get(id) ?? null };
});
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
const { inspectorPart, runPatchOf, fontPatch } = await import("../inspector");

type Text = Extract<PdfAnnot, { t: "text" }>;
const box = (over: Partial<Text> = {}): Text => ({
  id: "t",
  t: "text",
  x: 10,
  y: 10,
  w: 300,
  h: 15,
  text: "hello world",
  font: "Arial",
  size: 12,
  c: "#000000",
  bold: false,
  italic: false,
  align: "left",
  ...over,
});

let kit: Kit;
let part: { dispose(): void };
let calls: PdfRunPatch[];
let cleared: PdfRunField[][];
let refocus: number;
const host = (): FakeElement => kit.hosts.inspector as unknown as FakeElement;

async function mount(annots: PdfAnnot[]): Promise<void> {
  kit = makeKit(project({ P1: annots }));
  part = inspectorPart(kit.ctx, kit.hosts);
  await kit.flush();
}
const mark = (): Text => pageAnnots(kit.session.project, "P1").find((a) => a.id === "t") as Text;

/** the text box open for typing, with `range` selected (null = a caret);
 *  `draft` = a new box not yet in the project */
async function edit(range: { s: number; e: number } | null, draft: Text | null = null): Promise<void> {
  kit.ctx.selection.set(draft ? [] : [{ key: "P1", id: "t" }]);
  const e: PdfTextEditing = {
    key: "P1",
    id: "t",
    draft,
    commit: () => {},
    discard: () => {},
    refocus: () => {
      refocus++;
    },
    range,
    applyRange: (p) => {
      calls.push(p);
    },
    clearFields: (f) => {
      cleared.push([...f]);
    },
    styleOf: () => {
      const a = kit.ctx.textEdit.get()?.draft ?? mark();
      return styleSummary(a.text, a, a.runs, kit.ctx.textEdit.get()?.range ?? null);
    },
  };
  kit.ctx.textEdit.set(e);
  await kit.flush();
}
/** the editor publishing a new selection */
async function select(range: { s: number; e: number } | null): Promise<void> {
  kit.ctx.textEdit.set({ ...kit.ctx.textEdit.get()!, range });
  await kit.flush();
}
async function selectBox(): Promise<void> {
  kit.ctx.selection.set([{ key: "P1", id: "t" }]);
  await kit.flush();
}

const byLabel = (tag: string, label: string): FakeElement => host().querySelectorAll(tag).find((e) => e.getAttribute("aria-label") === label)!;
const btn = (label: string): FakeElement => byLabel("button", label);
const fire = (el: FakeElement, type: string): void => {
  el.dispatchEvent(new FakeEvent(type, { detail: 1 }));
};
const swatch = (hex: string): FakeElement => host().querySelectorAll(".pdfmk-swatch").find((b) => b.title === hex)!;
const pickFont = (f: string): void => {
  const s = byLabel("select", "Font");
  s.value = f;
  fire(s, "change");
};
const dragSize = (...vs: number[]): void => {
  const r = byLabel("input", "Font size in points");
  fire(r, "pointerdown");
  for (const v of vs) {
    r.value = String(v);
    fire(r, "input");
  }
  fire(r, "pointerup");
  fire(r, "change");
};
const pressed = (el: FakeElement): boolean => el.getAttribute("aria-pressed") === "true";

beforeEach(() => {
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [] });
  calls = [];
  cleared = [];
  refocus = 0;
  faces.clear();
});
afterEach(() => {
  part?.dispose();
});

describe("runPatchOf", () => {
  it("keeps a font pick's pair: legacy = { font }, library = { font, fontId }", () => {
    expect(runPatchOf(fontPatch({ legacy: "Georgia" }))).toEqual({ font: "Georgia" });
    expect(runPatchOf(fontPatch({ legacy: "Segoe UI", fontId: "lib:Lato" as FontId }))).toEqual({ font: "Segoe UI", fontId: "lib:Lato" });
    expect(runPatchOf({ size: 20 })).toEqual({ size: 20 });
    expect(runPatchOf({ c: "#ff0000" })).toEqual({ c: "#ff0000" });
    expect(runPatchOf({ bold: true })).toEqual({ bold: true });
    expect(runPatchOf({ italic: false })).toEqual({ italic: false });
  });
  it("refuses what a run cannot take", () => {
    expect(runPatchOf({})).toBeNull();
    expect(runPatchOf({ align: "center" })).toBeNull();
    expect(runPatchOf({ c: "#ff0000", align: "center" })).toBeNull();
    expect(runPatchOf({ fontId: "lib:Lato" })).toBeNull();
  });
});

describe("a range selected in the open box", () => {
  it("font, size, colour, Bold and Italic go to applyRange; the project and the tool defaults stay", async () => {
    await mount([box()]);
    await edit({ s: 0, e: 5 });
    const p0 = kit.session.project;
    const tools0 = kit.ctx.tools.get();
    pickFont("Georgia");
    dragSize(14, 20);
    swatch("#e5484d").click();
    btn("Bold").click();
    btn("Italic").click();
    expect(calls).toEqual([{ font: "Georgia" }, { size: 14 }, { size: 20 }, { c: "#e5484d" }, { bold: true }, { italic: true }]);
    expect(kit.session.project).toBe(p0);
    expect(kit.session.steps).toBe(0);
    expect(kit.session.replaces).toBe(0);
    expect(kit.ctx.tools.get()).toBe(tools0);
    // the caret goes back to the text after each finished edit
    expect(refocus).toBeGreaterThanOrEqual(5);
  });

  it("Bold toggles to off when the whole range is bold already", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, bold: true }] })]);
    await edit({ s: 1, e: 4 });
    btn("Bold").click();
    expect(calls).toEqual([{ bold: false }]);
  });

  it("a new box's draft: the range takes the write, the draft stays", async () => {
    await mount([]);
    const d = box();
    await edit({ s: 0, e: 5 }, d);
    swatch("#0090ff").click();
    expect(calls).toEqual([{ c: "#0090ff" }]);
    expect(kit.ctx.textEdit.get()!.draft).toBe(d);
  });

  it("alignment and the box look still apply to the box", async () => {
    await mount([box()]);
    await edit({ s: 0, e: 5 });
    btn("Align center").click();
    expect(calls).toEqual([]);
    expect(mark().align).toBe("center");
    expect(kit.session.steps).toBe(1);
  });
});

describe("the whole-box path", () => {
  it("a box selected but not edited, and a collapsed caret, write the project", async () => {
    await mount([box()]);
    await selectBox();
    swatch("#e5484d").click();
    expect(mark().c).toBe("#e5484d");
    expect(kit.session.steps).toBe(1);
    await edit(null);
    btn("Bold").click();
    dragSize(18);
    expect(calls).toEqual([]);
    expect(mark()).toMatchObject({ bold: true, size: 18 });
    expect(kit.session.steps).toBe(3);
    // while a box is open, a whole-box pick still sets the Text tool's defaults
    expect(kit.ctx.tools.get().sizes.text).toBe(18);
  });

  it("a whole-box colour takes only the colour off the runs, in ONE step that undoes both", async () => {
    const runs: PdfTextRun[] = [
      { s: 0, e: 5, c: "#ff0000" },
      { s: 6, e: 11, size: 20 },
    ];
    const a = box({ runs });
    await mount([a]);
    await selectBox();
    swatch("#0090ff").click();
    expect(mark().c).toBe("#0090ff");
    expect(mark().runs).toEqual([{ s: 6, e: 11, size: 20 }]);
    expect(kit.session.steps).toBe(1);
    expect(pageAnnots(kit.session.history[0]!, "P1")[0]).toBe(a);
  });

  it("a whole-box font pick takes the font pair off the runs and keeps the rest", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, font: "Georgia" }, { s: 6, e: 11, font: "Segoe UI", fontId: "lib:Lato" as FontId, c: "#ff0000" }] })]);
    await selectBox();
    pickFont("Courier New");
    expect(mark().font).toBe("Courier New");
    expect(mark().runs).toEqual([{ s: 6, e: 11, c: "#ff0000" }]);
    expect(kit.session.steps).toBe(1);
  });

  it("a whole-box size drag clears sized runs once, as one step", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, size: 30 }] })]);
    await selectBox();
    dragSize(14, 16);
    expect(mark().size).toBe(16);
    expect("runs" in mark()).toBe(false);
    // the box is measured as the write leaves it: no 30 pt run any more
    expect(mark().h).toBe(textHeight(1, 16));
    expect(kit.session.steps).toBe(1);
  });

  it("a new box's draft (caret only): its runs lose the written property", async () => {
    await mount([]);
    await edit(null, box({ runs: [{ s: 0, e: 5, c: "#ff0000", bold: true }] }));
    swatch("#0090ff").click();
    const d = kit.ctx.textEdit.get()!.draft!;
    expect(d.c).toBe("#0090ff");
    expect(d.runs).toEqual([{ s: 0, e: 5, bold: true }]);
    expect(calls).toEqual([]);
    expect(kit.session.steps).toBe(0);
  });

  it("R1: a box without runs writes exactly what 0.9.3 wrote", async () => {
    const a = box({ w: 60 });
    await mount([a]);
    await selectBox();
    const p0 = kit.session.project;
    // the 0.9.3 inspector's writes, rebuilt by hand
    const grown = (p: ProjectFile, size: number): ProjectFile => {
      const next = { ...a, size };
      const H = Math.max(frameOf(next).H, textHeight(textLines(next).length, size));
      return updateAnnot(p, "P1", "t", H === frameOf(a).H ? { size } : { size, ...withFrameH(a, H) });
    };
    let want = grown(p0, 24);
    dragSize(20, 24);
    expect(kit.session.project).toEqual(want);
    expect(kit.session.steps).toBe(1);
    want = updateAnnot(want, "P1", "t", { c: "#e5484d" });
    swatch("#e5484d").click();
    expect(kit.session.project).toEqual(want);
    want = updateAnnot(want, "P1", "t", { bold: true });
    btn("Bold").click();
    expect(kit.session.project).toEqual(want);
    want = updateAnnot(want, "P1", "t", { font: "Georgia" });
    pickFont("Georgia");
    expect(kit.session.project).toEqual(want);
    expect(kit.session.steps).toBe(4);
    expect("runs" in mark()).toBe(false);
  });
});

describe("what the controls show", () => {
  it("the range's summary, and the box's own style again when the range clears", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, font: "Georgia", size: 20, c: "#e5484d", bold: true }] })]);
    await edit({ s: 1, e: 3 });
    const size = byLabel("input", "Font size in points");
    expect(byLabel("select", "Font").value).toBe("Georgia");
    expect(size.value).toBe("20");
    expect(pressed(swatch("#e5484d"))).toBe(true);
    expect(pressed(btn("Bold"))).toBe(true);
    await select(null);
    expect(byLabel("select", "Font").value).toBe("Arial");
    expect(size.value).toBe("12");
    expect(pressed(swatch("#000000"))).toBe(true);
    expect(pressed(btn("Bold"))).toBe(false);
  });

  it("Bold shows pressed only when the whole range is bold", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, bold: true }] })]);
    await edit({ s: 0, e: 5 });
    expect(pressed(btn("Bold"))).toBe(true);
    await select({ s: 3, e: 8 });
    expect(pressed(btn("Bold"))).toBe(false);
  });

  it("Bold / Italic follow the faces of the range's font", async () => {
    faces.set("lib:Lato", [
      { bold: false, italic: false },
      { bold: false, italic: true },
    ]);
    await mount([box({ runs: [{ s: 0, e: 5, font: "Segoe UI", fontId: "lib:Lato" as FontId }] })]);
    await edit({ s: 0, e: 5 });
    expect(btn("Bold").disabled).toBe(true);
    expect(btn("Italic").disabled).toBe(false);
    btn("Bold").click();
    expect(calls).toEqual([]);
    await select({ s: 6, e: 11 });
    expect(btn("Bold").disabled).toBe(false);
  });
});
