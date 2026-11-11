// The REAL text editor (marks/text.ts) and the REAL inspector panel on one
// project store (0.9.4 runs): whole-box writes while a styled box is open
// (D1: the editor's other uncommitted styles survive, the cleared field
// comes back with the editor's undo), a project undo while the editor is open
// (D4: the mark's restored runs win), a range style through the panel's own
// button, and Ctrl+B on a library font with no bold face (D5). Only the font
// runtime is a stand-in; Selection / Range are small fakes (the fake DOM has
// none).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontId, PdfAnnot } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { pageAnnots } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./testkit.test-util";

const faces = vi.hoisted(() => new Map<string, { bold: boolean; italic: boolean }[]>());
vi.mock("../../../fonts", async () => {
  const base = (await import("./fonts-stand-in.test-util")).fontsStandIn();
  return { ...base, facesOf: (id: string) => faces.get(id) ?? null };
});
vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {}, notice: () => {} } }));
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
const { toolsPart } = await import("../tools");
const { inspectorPart } = await import("../inspector");
const { writeSelection, editorText } = await import("./text");

type Text = Extract<PdfAnnot, { t: "text" }>;
const ID_A = "f-0123456789abcdef" as FontId;
const box = (extra: Partial<Text> = {}): PdfAnnot => ({
  id: "t", t: "text", x: 100, y: 100, w: 200, h: 30, text: "Hello world", font: "Georgia", size: 12, c: "#000000", bold: false, italic: false, align: "left", ...extra,
});

/* ---------- a fake Selection / Range (as text-runs.mount.test.ts) ---------- */

class FakeRange {
  startContainer: any = null;
  startOffset = 0;
  endContainer: any = null;
  endOffset = 0;
  setStart(n: any, o: number): void {
    this.startContainer = n;
    this.startOffset = o;
  }
  setEnd(n: any, o: number): void {
    this.endContainer = n;
    this.endOffset = o;
  }
  selectNodeContents(n: any): void {
    this.setStart(n, 0);
    this.setEnd(n, n.childNodes.length);
  }
  collapse(toStart: boolean): void {
    if (toStart) this.setEnd(this.startContainer, this.startOffset);
    else this.setStart(this.endContainer, this.endOffset);
  }
}
class FakeSelection {
  anchorNode: any = null;
  anchorOffset = 0;
  focusNode: any = null;
  focusOffset = 0;
  get rangeCount(): number {
    return this.anchorNode ? 1 : 0;
  }
  get isCollapsed(): boolean {
    return this.anchorNode === this.focusNode && this.anchorOffset === this.focusOffset;
  }
  setBaseAndExtent(a: any, ao: number, f: any, fo: number): void {
    this.anchorNode = a;
    this.anchorOffset = ao;
    this.focusNode = f;
    this.focusOffset = fo;
  }
  collapse(n: any, o: number): void {
    this.setBaseAndExtent(n, o, n, o);
  }
  removeAllRanges(): void {
    this.anchorNode = this.focusNode = null;
  }
  addRange(r: FakeRange): void {
    this.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
  }
}

let kit: Kit;
let parts: { dispose(): void }[] = [];
let fsel: FakeSelection;
let div: FakeElement;

async function mount(annots: PdfAnnot[]): Promise<void> {
  kit = makeKit(project({ P1: annots }));
  fsel = new FakeSelection();
  (window as any).getSelection = () => fsel;
  (kit.doc as any).createRange = () => new FakeRange();
  parts = [toolsPart(kit.ctx, kit.hosts), inspectorPart(kit.ctx, kit.hosts)];
  await kit.flush();
}
/** open the editor on "t" (double-click with Select) */
async function open(): Promise<void> {
  kit.pointer("dblclick", 110, 110);
  div = (kit.view.overlay("P1") as unknown as FakeElement).querySelector(".pdfmk-text-edit")!;
  expect(div).not.toBeNull();
  await kit.flush();
}
const mark = (): Text => pageAnnots(kit.session.project, "P1").find((a) => a.id === "t") as Text;
const insp = (): FakeElement => kit.hosts.inspector as unknown as FakeElement;
const swatch = (hex: string): FakeElement =>
  insp()
    .querySelectorAll(".pdfmk-swatches")
    .find((g) => g.getAttribute("aria-label") === "Mark color")!
    .querySelectorAll("button")
    .find((b) => b.title === hex)!;
const byLabel = (tag: string, label: string): FakeElement => insp().querySelectorAll(tag).find((e) => e.getAttribute("aria-label") === label)!;
const fire = (el: FakeElement, type: string): void => {
  el.dispatchEvent(new FakeEvent(type, { detail: 1 }));
};
async function dragSize(v: number): Promise<void> {
  const r = byLabel("input", "Font size in points");
  fire(r, "pointerdown");
  r.value = String(v);
  fire(r, "input");
  fire(r, "pointerup");
  fire(r, "change");
  await kit.flush();
}
async function select(s: number, e: number): Promise<void> {
  writeSelection(div as any, { s, e, backward: false });
  kit.doc.dispatchEvent(new FakeEvent("selectionchange"));
  await kit.flush();
}
async function caret(at: number): Promise<void> {
  await select(at, at);
}
const spans = (): [string, string, string][] =>
  div.children.filter((c) => c.tagName === "SPAN").map((c) => [c.textContent, c.style.color!, c.style.fontSize!]);
const ctrl = (k: string): FakeEvent => kit.keydown(k, { ctrlKey: true });

beforeEach(() => {
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [], pdfToolStyle: {} });
  faces.clear();
});
afterEach(() => {
  for (const p of parts.splice(0)) p.dispose();
  vi.unstubAllGlobals();
});

describe("the real panel and the real editor on one store", () => {
  it("a range style through the panel's swatch lands with the text in one step", async () => {
    await mount([box()]);
    await open();
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "t" }]);
    await select(6, 11);
    swatch("#e5484d").click();
    await kit.flush();
    expect(spans()).toEqual([
      ["Hello ", "#000000", "12px"],
      ["world", "#e5484d", "12px"],
    ]);
    // the project and the tool defaults are untouched until the box closes
    expect(kit.session.steps).toBe(0);
    expect(mark().c).toBe("#000000");
    kit.keydown("Escape");
    expect(kit.session.steps).toBe(1);
    expect(mark()).toMatchObject({ c: "#000000", runs: [{ s: 6, e: 11, c: "#e5484d" }] });
  });

  it("D1 case A: the swatch equal to the base colour makes the whole box that colour", async () => {
    await mount([box()]);
    await open();
    await select(6, 11);
    swatch("#e5484d").click();
    await caret(3);
    expect(kit.ctx.textEdit.get()!.range).toBeNull();
    swatch("#000000").click();
    await kit.flush();
    expect(spans().map((s) => s[1])).toEqual(["#000000"]);
    kit.keydown("Escape");
    expect("runs" in mark()).toBe(false);
    expect(mark().c).toBe("#000000");
  });

  it("D1 case B: a whole-box colour keeps the editor's uncommitted size; one editor undo brings the red back", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, c: "#e5484d" }] })]);
    await open();
    await select(6, 11);
    await dragSize(30);
    expect(spans()).toEqual([
      ["Hello", "#e5484d", "12px"],
      [" ", "#000000", "12px"],
      ["world", "#000000", "30px"],
    ]);
    await caret(2);
    swatch("#000000").click();
    await kit.flush();
    // the red is gone (live and stored), the size-30 word stays
    expect(spans()).toEqual([
      ["Hello ", "#000000", "12px"],
      ["world", "#000000", "30px"],
    ]);
    expect("runs" in mark()).toBe(false);
    // the editor's own undo: the colour clearing was one step
    ctrl("z");
    expect(spans()).toEqual([
      ["Hello", "#e5484d", "12px"],
      [" ", "#000000", "12px"],
      ["world", "#000000", "30px"],
    ]);
    // ...and the stack's current state is the cleared one again
    ctrl("y");
    expect(spans()).toEqual([
      ["Hello ", "#000000", "12px"],
      ["world", "#000000", "30px"],
    ]);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ c: "#000000", runs: [{ s: 6, e: 11, size: 30 }] });
  });

  it("D1, a streamed whole-box write (the size slider with a caret): the in-session size leaves the live runs, one editor step", async () => {
    await mount([box()]);
    await open();
    await select(6, 11);
    await dragSize(30);
    await caret(2);
    const r = byLabel("input", "Font size in points");
    fire(r, "pointerdown");
    for (const v of ["14", "15", "16"]) {
      r.value = v;
      fire(r, "input");
      await kit.flush();
    }
    fire(r, "pointerup");
    fire(r, "change");
    await kit.flush();
    expect(mark().size).toBe(16);
    expect(spans()).toEqual([["Hello world", "#000000", "16px"]]);
    ctrl("z");
    expect(spans()).toEqual([
      ["Hello ", "#000000", "16px"],
      ["world", "#000000", "30px"],
    ]);
  });

  it("D4: a project undo while the box is open (base AND runs) is taken whole, onto the text typed since", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, size: 20 }, { s: 6, e: 11, bold: true }] })]);
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    // the whole-box size (no editor open): base 14, the size-20 run gone
    await dragSize(14);
    expect(mark()).toMatchObject({ size: 14, runs: [{ s: 6, e: 11, bold: true }] });
    const before = kit.session.history.at(-1)!;
    await open();
    // type "!" at the end (the caret is there): the bold run takes it
    const last = div.children[1]!.firstChild as any;
    fsel.collapse(last, last.data.length);
    div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "insertText", data: "!" }));
    last.data += "!";
    fsel.collapse(last, last.data.length);
    div.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: "!" }));
    expect(editorText(div as any)).toBe("Hello world!");
    // a project undo while the editor is open
    kit.session.store.set(before);
    await kit.flush();
    expect(spans().map((s) => [s[0], s[2]])).toEqual([
      ["Hello", "20px"],
      [" ", "12px"],
      ["world!", "12px"],
    ]);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ size: 12, text: "Hello world!", runs: [{ s: 0, e: 5, size: 20 }, { s: 6, e: 12, bold: true }] });
  });

  it("D4, plain editor: runs a project undo brings back turn the box styled, onto the text typed since", async () => {
    await mount([box({ runs: [{ s: 0, e: 5, size: 20 }] })]);
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    await dragSize(14);
    expect("runs" in mark()).toBe(false);
    const before = kit.session.history.at(-1)!;
    await open();
    // plain mode: the browser's own text node
    expect(div.children).toHaveLength(0);
    const t = div.childNodes[0] as any;
    t.data += "!";
    div.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: "!" }));
    kit.session.store.set(before);
    await kit.flush();
    expect(spans().map((s) => [s[0], s[2]])).toEqual([
      ["Hello", "20px"],
      [" world!", "12px"],
    ]);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ size: 12, text: "Hello world!", runs: [{ s: 0, e: 5, size: 20 }] });
  });

  it("D5: Ctrl+B on a library font with no bold face stores nothing, as the panel's disabled button", async () => {
    faces.set(ID_A, [{ bold: false, italic: true }]);
    await mount([box({ font: "Arial", fontId: ID_A, runs: [{ s: 0, e: 5, c: "#e5484d" }] })]);
    await open();
    await select(6, 11);
    expect(byLabel("button", "Bold").disabled).toBe(true);
    ctrl("b");
    ctrl("i");
    kit.keydown("Escape");
    expect(mark().runs).toEqual([
      { s: 0, e: 5, c: "#e5484d" },
      { s: 6, e: 11, italic: true },
    ]);
  });
});
