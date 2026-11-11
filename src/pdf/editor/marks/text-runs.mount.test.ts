// The PDF text box editor with style runs (0.9.4): one DOM walker for the
// text and its offsets, the selection kept as offsets through span rebuilds
// and trips to the panel, typing and deleting across runs (the model wins),
// range styling (`range` / `applyRange` / `styleOf`), Ctrl+B / Ctrl+I, the
// editor's own undo once runs are in play (and the browser's otherwise, R1),
// IME, the commit in one history step, the kept highlight, and nothing left
// behind on every close path. The fake DOM has no Selection, Range or CSS
// highlights: this file adds small fakes of them.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnot, PdfTextRun } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { pageAnnots, setTextRuns, updateAnnot } from "../../model";
import { FakeText } from "../fake-dom.test-util";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./testkit.test-util";

vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {} } }));
vi.mock("../../../core/session", async (orig) => {
  const real = await orig<typeof import("../../../core/session")>();
  return { ...real, updateSettings: vi.fn(async () => {}) };
});

const { settingsStore } = await import("../../../core/session");
const { toolsPart } = await import("../tools");
const { editorText, offsetOf, pointAt, writeSelection, readSelection, KEPT_HIGHLIGHT } = await import("./text");

type Text = Extract<PdfAnnot, { t: "text" }>;
const BOLD_RUN: PdfTextRun = { s: 6, e: 11, bold: true, c: "#aa0000" };
const text = (extra: Partial<Text> = {}): PdfAnnot => ({
  id: "t", t: "text", x: 100, y: 100, w: 120, h: 30, text: "Hello world", font: "Georgia", size: 12, c: "#112233", bold: false, italic: false, align: "left", ...extra,
});

/* ---------- a fake Selection / Range / highlight registry ---------- */

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
  cloneRange(): FakeRange {
    return Object.assign(new FakeRange(), this);
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
  getRangeAt(): FakeRange {
    const r = new FakeRange();
    r.setStart(this.anchorNode, this.anchorOffset);
    r.setEnd(this.focusNode, this.focusOffset);
    return r;
  }
  toString(): string {
    return "";
  }
}
class FakeHighlight {
  constructor(public range: FakeRange) {}
}

let kit: Kit;
let part: { dispose(): void } | null = null;
let fsel: FakeSelection;
let highlights: Map<string, FakeHighlight>;
let div: FakeElement;

function install(): void {
  fsel = new FakeSelection();
  (window as any).getSelection = () => fsel;
  (kit.doc as any).createRange = () => new FakeRange();
  highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", FakeHighlight);
}
async function mount(annots: PdfAnnot[] = []): Promise<void> {
  kit = makeKit(project({ P1: annots }));
  install();
  part = toolsPart(kit.ctx, kit.hosts);
  await kit.flush();
}
const editorDiv = (): FakeElement | null => (kit.view.overlay("P1") as unknown as FakeElement).querySelector(".pdfmk-text-edit");
/** open the editor on the mark "t" (double-click with Select) */
async function open(a: PdfAnnot = text({ runs: [BOLD_RUN] })): Promise<FakeElement> {
  await mount([a]);
  kit.pointer("dblclick", 110, 110);
  div = editorDiv()!;
  expect(div).not.toBeNull();
  // the real offsetHeight: the tallest line height among the spans (the
  // box's own one when there are none)
  Object.defineProperty(div, "offsetHeight", {
    configurable: true,
    get: () => Math.max(15, ...div.children.map((c) => parseFloat(c.style.lineHeight ?? "") || 0)),
  });
  return div;
}
const mark = (): Text => pageAnnots(kit.session.project, "P1").find((a) => a.id === "t") as Text;
const edit = () => kit.ctx.textEdit.get()!;
const spans = (): { text: string; bold: boolean; size: string; color: string }[] =>
  div.children
    .filter((c) => c.tagName === "SPAN")
    .map((c) => ({ text: c.textContent, bold: c.style.fontWeight === "bold", size: c.style.fontSize!, color: c.style.color! }));
/** select [s, e) by offsets and let the document report it */
function select(s: number, e: number, backward = false): void {
  writeSelection(div as any, { s, e, backward });
  kit.doc.dispatchEvent(new FakeEvent("selectionchange"));
}
/** what a browser does for typed text: into the focus's text node (or a new
 *  one at an element point), the caret after it, beforeinput / input around */
function type(str: string, extra: Record<string, unknown> = {}): void {
  const node = fsel.focusNode;
  const off = fsel.focusOffset;
  div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "insertText", data: str, ...extra }));
  if (node.nodeType === 3) {
    node.data = node.data.slice(0, off) + str + node.data.slice(off);
    fsel.collapse(node, off + str.length);
  } else {
    const t = new FakeText(str);
    node.insertBefore(t, node.childNodes[off] ?? null);
    fsel.collapse(t, str.length);
  }
  div.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: str, ...extra }));
}
const ctrl = (k: string, extra: Record<string, unknown> = {}): FakeEvent => kit.keydown(k, { ctrlKey: true, ...extra });
/** an element in the panel (or the font picker) holding a focusable input */
function panelInput(cls: string): FakeElement {
  const host = new FakeElement("div");
  host.className = cls;
  const input = new FakeElement("input");
  host.appendChild(input);
  kit.doc.body.appendChild(host);
  return input;
}

let clock = 1_000_000;
beforeEach(() => {
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [], pdfToolStyle: {} });
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  part?.dispose();
  part = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the walker", () => {
  it("maps every offset to a DOM point and back across spans, <br> and the placeholder <br>", async () => {
    await mount();
    const root = new FakeElement("div");
    const sp = (s: string): FakeElement => {
      const e = new FakeElement("span");
      e.textContent = s;
      return e;
    };
    // "ab" | "c\nd" | <br> | "e" | <br> (Chromium's placeholder: no character)
    const placeholder = new FakeElement("br");
    root.append(sp("ab"), sp("c\nd"), new FakeElement("br"), sp("e"), placeholder);
    expect(editorText(root as any)).toBe("abc\nd\ne");
    for (let i = 0; i <= 7; i++) {
      const p = pointAt(root as any, i);
      expect(offsetOf(root as any, p.node, p.offset)).toBe(i);
    }
    // element points: before the placeholder and after everything are the end
    expect(offsetOf(root as any, root as any, 4)).toBe(7);
    expect(offsetOf(root as any, root as any, 5)).toBe(7);
    // the end of the first span wins over the start of the next one
    expect(pointAt(root as any, 2).node).toBe(root.children[0]!.firstChild);
    // a <br> in the middle is a newline: offset 6 sits before "e"
    expect(pointAt(root as any, 6).node).toBe(root.children[3]!.firstChild);
    // a point outside the root is no offset
    expect(offsetOf(root as any, new FakeElement("p") as any, 0)).toBeNull();
  });
});

describe("opening a box with runs", () => {
  it("builds styled spans; a box without runs holds its plain text exactly as before (R1)", async () => {
    await open();
    expect(spans()).toEqual([
      { text: "Hello ", bold: false, size: "12px", color: "#112233" },
      { text: "world", bold: true, size: "12px", color: "#aa0000" },
    ]);
    part!.dispose();
    await open(text());
    expect(div.childNodes).toHaveLength(1);
    expect(div.childNodes[0]).toBeInstanceOf(FakeText);
    expect(div.textContent).toBe("Hello world");
  });
});

describe("the selection as offsets", () => {
  it("survives a span rebuild and focus trips to .inspector and .fontpk (backward kept)", async () => {
    await open();
    select(2, 8, true);
    expect(edit().range).toEqual({ s: 2, e: 8 });
    // into the panel: the selection is kept as offsets
    panelInput("inspector").focus();
    expect(kit.ctx.textEdit.get()).not.toBeNull();
    fsel.removeAllRanges();
    // a range style rebuilds every span while focus is away
    const before = div.children[0];
    edit().applyRange({ size: 20 });
    expect(div.children[0]).not.toBe(before);
    edit().refocus();
    expect(kit.doc.activeElement).toBe(div);
    expect(readSelection(div as any)).toEqual({ s: 2, e: 8, backward: true });
    // the font picker's search field (on <body>) keeps it the same way
    panelInput("fontpk fontpk__pop").focus();
    expect(kit.ctx.textEdit.get()).not.toBeNull();
    fsel.removeAllRanges();
    edit().applyRange({ c: "#00ff00" });
    edit().refocus();
    expect(readSelection(div as any)).toEqual({ s: 2, e: 8, backward: true });
  });

  it("publishes `range` as a fresh object only on a real change; a selection outside the box keeps it", async () => {
    await open();
    const seen: unknown[] = [];
    kit.ctx.textEdit.subscribe((e) => seen.push(e?.range));
    const first = edit();
    select(1, 4);
    const second = edit();
    expect(second).not.toBe(first);
    expect(second.range).toEqual({ s: 1, e: 4 });
    select(1, 4);
    expect(edit()).toBe(second);
    // the selection moves into an input of the panel: the range stays
    const input = panelInput("inspector");
    fsel.collapse(input, 0);
    kit.doc.dispatchEvent(new FakeEvent("selectionchange"));
    expect(edit().range).toEqual({ s: 1, e: 4 });
    // a collapsed caret inside the box: no range
    fsel.collapse(div.children[0]!.firstChild, 3);
    kit.doc.dispatchEvent(new FakeEvent("selectionchange"));
    expect(edit().range).toBeNull();
    await kit.flush();
    expect(seen.at(-1)).toBeNull();
  });
});

describe("typing and deleting with runs", () => {
  it("typing inside a run keeps its style and the caret, without rebuilding the spans", async () => {
    await open();
    const boldSpan = div.children[1]!;
    fsel.collapse(boldSpan.firstChild, 2); // offset 8
    type("XY");
    expect(div.children[1]).toBe(boldSpan);
    expect(spans()[1]).toMatchObject({ text: "woXYrld", bold: true });
    expect(readSelection(div as any)).toEqual({ s: 10, e: 10, backward: false });
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "Hello woXYrld", runs: [{ s: 6, e: 13, bold: true, c: "#aa0000" }] });
  });

  it("text the browser put in the wrong span is moved by the model (caret kept by offset)", async () => {
    await open();
    // the browser types at the START of the bold span; the character before
    // the caret is plain, so the new text is plain
    fsel.collapse(div.children[1]!.firstChild, 0);
    type("Z");
    expect(spans().map((s) => [s.text, s.bold])).toEqual([
      ["Hello Z", false],
      ["world", true],
    ]);
    expect(readSelection(div as any)).toEqual({ s: 7, e: 7, backward: false });
  });

  it("deleting across two runs", async () => {
    await open();
    // "Hello world" minus [4, 8) = "o wo": the browser trims both text nodes
    div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "deleteContentBackward" }));
    const a = div.children[0]!.firstChild as any;
    const b = div.children[1]!.firstChild as any;
    a.data = "Hell";
    b.data = "rld";
    fsel.collapse(a, 4);
    div.dispatchEvent(new FakeEvent("input", { inputType: "deleteContentBackward" }));
    expect(spans().map((s) => [s.text, s.bold])).toEqual([
      ["Hell", false],
      ["rld", true],
    ]);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "Hellrld", runs: [{ s: 4, e: 7, bold: true, c: "#aa0000" }] });
  });
});

describe("range styling", () => {
  it("applyRange styles only the range of a box without runs, regrows the box, and lands with the text", async () => {
    await open(text());
    const outline = (): FakeElement => (kit.view.overlay("P1") as unknown as FakeElement).querySelector(".pdfmk-edit-chrome .pdfmk-sel")!;
    expect(outline().getAttribute("height")).toBe("30");
    select(0, 5);
    expect(edit().range).toEqual({ s: 0, e: 5 });
    edit().applyRange({ size: 40 });
    expect(spans()).toEqual([
      { text: "Hello", bold: false, size: "40px", color: "#112233" },
      { text: " world", bold: false, size: "12px", color: "#112233" },
    ]);
    expect(outline().getAttribute("height")).toBe("50");
    kit.keydown("Escape");
    expect(mark().runs).toEqual([{ s: 0, e: 5, size: 40 }]);
    expect(mark().h).toBeGreaterThan(30);
    expect(kit.session.steps).toBe(1);
  });

  it("styleOf: the range's summary, or the whole box's with no range", async () => {
    await open();
    select(6, 11);
    expect(edit().styleOf()).toMatchObject({ bold: true, c: "#aa0000", size: 12, font: "Georgia" });
    select(3, 3);
    // the whole box: the first character's colour, bold only if all is bold
    expect(edit().styleOf()).toMatchObject({ bold: false, c: "#112233" });
  });

  it("a whole-box write while editing (the panel's routing) keeps the editor's other uncommitted styles; a genuine outside write still wins", async () => {
    await open(text({ runs: [{ s: 0, e: 5, c: "#00ff00" }] }));
    // an in-session style the mark does not have yet
    select(6, 11);
    edit().applyRange({ size: 30 });
    fsel.collapse(div.children[0]!.firstChild, 2);
    kit.doc.dispatchEvent(new FakeEvent("selectionchange"));
    // the panel's whole-box colour: the editor first, then the project write
    // (base colour + the colour taken off the stored runs, as patchSelected does)
    edit().clearFields(["c"]);
    kit.session.commit((p) => setTextRuns(updateAnnot(p, "P1", "t", { c: "#0000ff" }), "P1", "t", undefined));
    await kit.flush();
    expect(spans().map((s) => [s.text, s.color, s.size])).toEqual([
      ["Hello ", "#0000ff", "12px"],
      ["world", "#0000ff", "30px"],
    ]);
    // a genuine outside runs-only write (nothing routed) wins over the live runs
    await new Promise((r) => setTimeout(r, 0));
    kit.session.commit((p) => setTextRuns(p, "P1", "t", [{ s: 0, e: 5, italic: true }]));
    await kit.flush();
    expect(spans().map((s) => s.text)).toEqual(["Hello", " world"]);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ c: "#0000ff", runs: [{ s: 0, e: 5, italic: true }] });
  });

  it("Ctrl+B on a partly bold range makes all of it bold, a second press clears it; a caret does nothing", async () => {
    await open(text({ runs: [{ s: 6, e: 11, bold: true }] }));
    fsel.collapse(div.children[0]!.firstChild, 2);
    const caret = ctrl("b");
    expect(caret.defaultPrevented).toBe(false);
    select(3, 8);
    expect(ctrl("b").defaultPrevented).toBe(true);
    expect(edit().styleOf().bold).toBe(true);
    expect(spans().map((s) => [s.text, s.bold])).toEqual([
      ["Hel", false],
      ["lo world", true],
    ]);
    ctrl("b");
    expect(spans().map((s) => [s.text, s.bold])).toEqual([
      ["Hello wo", false],
      ["rld", true],
    ]);
    ctrl("i");
    kit.keydown("Escape");
    expect(mark().runs).toEqual([
      { s: 3, e: 8, italic: true },
      { s: 8, e: 11, bold: true },
    ]);
  });

  it("a streamed applyRange (slider / colour preview) is one undo step until refocus; another field is its own", async () => {
    await open();
    select(0, 5);
    edit().applyRange({ size: 14 });
    edit().applyRange({ size: 18 });
    edit().applyRange({ size: 22 });
    edit().refocus();
    edit().applyRange({ size: 30 });
    edit().applyRange({ c: "#0000ff" });
    ctrl("z");
    expect(spans()[0]).toMatchObject({ text: "Hello", size: "30px", color: "#112233" });
    ctrl("z");
    expect(spans()[0]).toMatchObject({ size: "22px" });
    ctrl("z");
    expect(spans()[0]).toMatchObject({ text: "Hello ", size: "12px" });
  });
});

describe("the editor's own undo", () => {
  it("restores text, runs and selection; a burst merges; it stops at the opening state", async () => {
    await open();
    expect(readSelection(div as any)).toEqual({ s: 11, e: 11, backward: false });
    type("A");
    clock += 200;
    type("B");
    clock += 600; // a pause: a new step
    type("C");
    expect(editorText(div as any)).toBe("Hello worldABC");
    ctrl("z");
    expect(editorText(div as any)).toBe("Hello worldAB");
    expect(readSelection(div as any)).toEqual({ s: 13, e: 13, backward: false });
    expect(spans()[1]).toMatchObject({ text: "worldAB", bold: true });
    ctrl("z");
    expect(editorText(div as any)).toBe("Hello world");
    expect(readSelection(div as any)).toEqual({ s: 11, e: 11, backward: false });
    const atOpen = ctrl("z");
    expect(atOpen.defaultPrevented).toBe(true);
    expect(editorText(div as any)).toBe("Hello world");
    ctrl("y");
    expect(editorText(div as any)).toBe("Hello worldAB");
    ctrl("z", { shiftKey: true });
    expect(editorText(div as any)).toBe("Hello worldABC");
    // a range style is its own step and its undo brings the selection back
    select(0, 5);
    edit().applyRange({ italic: true });
    fsel.collapse(div.children[0]!.firstChild, 1);
    const undo = new FakeEvent("beforeinput", { inputType: "historyUndo" });
    div.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(spans().some((s) => s.text.includes("Hello") && div.children.find((c) => c.textContent === s.text)!.style.fontStyle === "italic")).toBe(false);
    expect(readSelection(div as any)).toEqual({ s: 14, e: 14, backward: false });
    div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "historyRedo" }));
    expect(div.children[0]!.style.fontStyle).toBe("italic");
    expect(readSelection(div as any)).toEqual({ s: 0, e: 5, backward: false });
    expect(edit().range).toEqual({ s: 0, e: 5 });
  });

  it("a box without runs and no range style keeps the browser's undo, plain DOM and no rich listeners (R1)", async () => {
    await open(text());
    fsel.collapse(div.childNodes[0], 5);
    type("!");
    expect(div.childNodes).toHaveLength(1);
    expect(div.textContent).toBe("Hello! world");
    expect(ctrl("z").defaultPrevented).toBe(false);
    expect(ctrl("y").defaultPrevented).toBe(false);
    expect(div.listenerCount("beforeinput")).toBe(0);
    expect(div.listenerCount("compositionstart")).toBe(0);
    // the range is still published for the panel
    select(0, 5);
    expect(edit().range).toEqual({ s: 0, e: 5 });
    kit.keydown("Escape");
    expect("runs" in mark()).toBe(false);
    expect(mark().text).toBe("Hello! world");
  });
});

describe("IME", () => {
  it("nothing is rebuilt during a composition; it is reconciled once at its end", async () => {
    await open();
    const plain = div.children[0]!;
    const bold = div.children[1]!;
    div.dispatchEvent(new FakeEvent("compositionstart"));
    fsel.collapse(bold.firstChild, 0);
    type("Z", { inputType: "insertCompositionText", isComposing: true });
    type("Q", { inputType: "insertCompositionText", isComposing: true });
    expect(div.children[0]).toBe(plain);
    expect(div.children[1]).toBe(bold);
    expect(bold.textContent).toBe("ZQworld");
    div.dispatchEvent(new FakeEvent("compositionend"));
    expect(spans().map((s) => [s.text, s.bold])).toEqual([
      ["Hello ZQ", false],
      ["world", true],
    ]);
    expect(readSelection(div as any)).toEqual({ s: 8, e: 8, backward: false });
  });
});

describe("the commit", () => {
  it("text then runs in ONE history step; a runs-only change lands; nothing changed lands nothing", async () => {
    await open();
    kit.keydown("Escape");
    expect(kit.session.steps).toBe(0);
    kit.pointer("dblclick", 110, 110);
    div = editorDiv()!;
    select(0, 2);
    edit().applyRange({ italic: true });
    kit.keydown("Escape");
    expect(kit.session.steps).toBe(1);
    expect(mark()).toMatchObject({ text: "Hello world", runs: [{ s: 0, e: 2, italic: true }, BOLD_RUN] });
    kit.pointer("dblclick", 110, 110);
    div = editorDiv()!;
    fsel.collapse(div.children[0]!.firstChild, 2);
    type("--");
    kit.keydown("Escape");
    expect(kit.session.steps).toBe(2);
    expect(mark()).toMatchObject({ text: "He--llo world", runs: [{ s: 0, e: 4, italic: true }, { ...BOLD_RUN, s: 8, e: 13 }] });
    // one undo of the project takes both the text and its runs back
    expect(kit.session.history.at(-1)!).not.toBe(kit.session.project);
    const prev = pageAnnots(kit.session.history.at(-1)!, "P1")[0] as Text;
    expect(prev).toMatchObject({ text: "Hello world", runs: [{ s: 0, e: 2, italic: true }, BOLD_RUN] });
  });

  it("a new box lands with its runs", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
    await kit.flush();
    kit.pointer("pointerdown", 300, 300);
    div = kit.doc.activeElement;
    div.textContent = "Brand new";
    select(0, 5);
    ctrl("b");
    kit.keydown("Escape");
    const m = pageAnnots(kit.session.project, "P1")[0] as Text;
    expect(m).toMatchObject({ text: "Brand new", runs: [{ s: 0, e: 5, bold: true }] });
    expect(kit.session.steps).toBe(1);
  });
});

describe("the kept highlight and cleanup", () => {
  it("paints the kept range while focus is in the panel, clears on refocus", async () => {
    await open();
    select(1, 4);
    expect(highlights.has(KEPT_HIGHLIGHT)).toBe(false);
    panelInput("inspector").focus();
    const h = highlights.get(KEPT_HIGHLIGHT)!;
    expect(h).toBeInstanceOf(FakeHighlight);
    expect(offsetOf(div as any, h.range.startContainer, h.range.startOffset)).toBe(1);
    expect(offsetOf(div as any, h.range.endContainer, h.range.endOffset)).toBe(4);
    edit().refocus();
    expect(highlights.has(KEPT_HIGHLIGHT)).toBe(false);
  });

  for (const how of ["escape", "discard", "teardown", "click away"] as const) {
    it(`leaves no listener and no highlight after ${how}`, async () => {
      await open();
      select(1, 4);
      ctrl("b"); // rich: every listener is in
      panelInput("inspector").focus();
      expect(highlights.has(KEPT_HIGHLIGHT)).toBe(true);
      expect(kit.doc.listenerCount("selectionchange")).toBe(1);
      const ed = div;
      if (how === "escape") kit.keydown("Escape");
      else if (how === "discard") edit().discard();
      else if (how === "teardown") {
        part!.dispose();
        part = null;
      } else {
        ed.focus();
        const away = new FakeElement("div");
        kit.doc.body.appendChild(away);
        away.dispatchEvent(new FakeEvent("pointerdown", { button: 0 }));
        away.dispatchEvent(new FakeEvent("mousedown", { button: 0 }));
        ed.blur();
      }
      expect(kit.ctx.textEdit.get()).toBeNull();
      expect(highlights.size).toBe(0);
      expect(kit.doc.listenerCount("selectionchange")).toBe(0);
      for (const t of ["beforeinput", "input", "compositionstart", "compositionend", "keydown", "focus", "focusout"]) expect(ed.listenerCount(t)).toBe(0);
    });
  }
});

describe("the edit hint (D2): repeated characters at a run's edge", () => {
  const aab = (): PdfAnnot => text({ text: "aab", runs: [{ s: 0, e: 1, bold: true }] });
  const pairs = (): [string, boolean][] => spans().map((s) => [s.text, s.bold]);

  it("typing an \"a\" after the bold \"a\" of \"aab\" makes it bold (the DOM was right; the model follows it)", async () => {
    await open(aab());
    // offset 1: the end of the bold span (the earlier node wins)
    writeSelection(div as any, { s: 1, e: 1, backward: false });
    expect(fsel.focusNode).toBe(div.children[0]!.firstChild);
    type("a");
    expect(pairs()).toEqual([
      ["aa", true],
      ["ab", false],
    ]);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "aaab", runs: [{ s: 0, e: 2, bold: true }] });
  });

  it("Backspace after the bold \"a\" of \"aab\" removes the bold one", async () => {
    await open(aab());
    writeSelection(div as any, { s: 1, e: 1, backward: false });
    div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "deleteContentBackward" }));
    const t = div.children[0]!.firstChild as any;
    t.data = "";
    fsel.collapse(t, 0);
    div.dispatchEvent(new FakeEvent("input", { inputType: "deleteContentBackward" }));
    expect(pairs()).toEqual([["ab", false]]);
    kit.keydown("Escape");
    expect(mark().text).toBe("ab");
    expect("runs" in mark()).toBe(false);
  });

  it("typing over a selection keeps the style of its first character (D6)", async () => {
    await open(text({ runs: [{ s: 0, e: 6, bold: true }, { s: 6, e: 11, c: "#ff0000" }] }));
    select(6, 11);
    div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "insertText", data: "X" }));
    // the browser puts it at the end of the bold span (the selection's start)
    const b = div.children[0]!.firstChild as any;
    const r = div.children[1]!.firstChild as any;
    b.data = "Hello X";
    r.data = "";
    fsel.collapse(b, 7);
    div.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: "X" }));
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "Hello X", runs: [{ s: 0, e: 6, bold: true }, { s: 6, e: 7, c: "#ff0000" }] });
  });
});

describe("Ctrl+B / Ctrl+I follow the panel's face rule (D5)", () => {
  it("on Impact nothing is stored and no undo step is spent", async () => {
    await open(text({ font: "Impact", runs: [{ s: 0, e: 5, c: "#ff0000" }] }));
    select(6, 11);
    ctrl("b");
    ctrl("i");
    expect(spans().every((s) => !s.bold)).toBe(true);
    // the editor's undo has nothing of its own to take back
    expect(ctrl("z").defaultPrevented).toBe(true);
    expect(spans().map((s) => s.text)).toEqual(["Hello", " world"]);
    kit.keydown("Escape");
    expect(kit.session.steps).toBe(0);
    expect(mark().runs).toEqual([{ s: 0, e: 5, c: "#ff0000" }]);
  });
});

describe("line breaks in a styled box never depend on the browser's DOM (D8)", () => {
  it("Enter (insertParagraph / insertLineBreak) goes through the model: a newline, the caret after it, its own undo kind", async () => {
    await open();
    writeSelection(div as any, { s: 11, e: 11, backward: false });
    type("A");
    clock += 100;
    const enter = new FakeEvent("beforeinput", { inputType: "insertParagraph" });
    div.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    clock += 100;
    const br = new FakeEvent("beforeinput", { inputType: "insertLineBreak" });
    div.dispatchEvent(br);
    expect(br.defaultPrevented).toBe(true);
    expect(editorText(div as any)).toBe("Hello worldA\n\n");
    expect(readSelection(div as any)).toEqual({ s: 14, e: 14, backward: false });
    // no block the editor did not build
    expect(div.querySelectorAll("div")).toHaveLength(0);
    // the two breaks are one step; the typed "A" is another
    ctrl("z");
    expect(editorText(div as any)).toBe("Hello worldA");
    ctrl("z");
    expect(editorText(div as any)).toBe("Hello world");
    ctrl("y");
    ctrl("y");
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "Hello worldA\n\n", runs: [{ ...BOLD_RUN, e: 14 }] });
  });

  it("Enter over a selection replaces it; multi-line typed / pasted text goes through the model, CRLF and CR made LF", async () => {
    await open();
    select(5, 6);
    div.dispatchEvent(new FakeEvent("beforeinput", { inputType: "insertParagraph" }));
    expect(editorText(div as any)).toBe("Hello\nworld");
    const typed = new FakeEvent("beforeinput", { inputType: "insertText", data: "x\ny" });
    div.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(true);
    expect(editorText(div as any)).toBe("Hello\nx\nyworld");
    select(0, 5);
    const paste = new FakeEvent("beforeinput", {
      inputType: "insertFromPaste",
      data: null,
      dataTransfer: { getData: (t: string) => (t === "text/plain" ? "p\r\nq\rr" : "") },
    });
    div.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(editorText(div as any)).toBe("p\nq\nr\nx\nyworld");
    // a one-line paste is left to the browser
    const one = new FakeEvent("beforeinput", { inputType: "insertFromPaste", data: "zz" });
    div.dispatchEvent(one);
    expect(one.defaultPrevented).toBe(false);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "p\nq\nr\nx\nyworld", runs: [{ ...BOLD_RUN, s: 9, e: 14 }] });
  });

  it("a multi-line drop goes where the engine's target range says (not the selection); without one it is left to the engine", async () => {
    await open();
    select(0, 2);
    const at = (o: number): any => pointAt(div as any, o);
    const drop = new FakeEvent("beforeinput", {
      inputType: "insertFromDrop",
      data: null,
      dataTransfer: { getData: () => "1\n2" },
      getTargetRanges: () => [{ startContainer: at(8).node, startOffset: at(8).offset, endContainer: at(8).node, endOffset: at(8).offset }],
    });
    div.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(editorText(div as any)).toBe("Hello wo1\n2rld");
    const blind = new FakeEvent("beforeinput", { inputType: "insertFromDrop", data: null, dataTransfer: { getData: () => "3\n4" } });
    div.dispatchEvent(blind);
    expect(blind.defaultPrevented).toBe(false);
    kit.keydown("Escape");
    expect(mark()).toMatchObject({ text: "Hello wo1\n2rld", runs: [{ ...BOLD_RUN, e: 14 }] });
  });

  it("the walker reads blocks the browser made the way innerText does", async () => {
    await mount();
    const el = (tag: string, ...kids: (FakeElement | string)[]): FakeElement => {
      const e = new FakeElement(tag);
      for (const k of kids) e.appendChild(typeof k === "string" ? (new FakeText(k) as any) : k);
      return e;
    };
    const cases: [FakeElement, string][] = [
      [el("div", "text", el("div", "more")), "text\nmore"],
      [el("div", "text", el("div", el("br"))), "text\n"],
      [el("div", "a", el("div", "b"), el("div", "c")), "a\nb\nc"],
      [el("div", el("div", "a", el("br")), el("div", "b")), "a\nb"],
      [el("div", "a", el("div", el("br")), el("div", "b")), "a\n\nb"],
      [el("div", el("p", "a"), "b"), "a\nb"],
      [el("div", "a", el("div", el("div", "b")), "c"), "a\nb\nc"],
      [el("div", el("span", "a"), el("span", "b")), "ab"],
    ];
    for (const [root, want] of cases) {
      expect(editorText(root as any)).toBe(want);
      for (let i = 0; i <= want.length; i++) {
        const p = pointAt(root as any, i);
        expect(offsetOf(root as any, p.node, p.offset)).toBe(i);
      }
    }
    // a point before a block is before its line break; inside it, after
    const r = el("div", "text", el("div", "more"));
    expect(offsetOf(r as any, r as any, 1)).toBe(4);
    expect(offsetOf(r as any, r.children[0]! as any, 0)).toBe(5);
  });

  const withMore = (d: FakeElement): void => {
    const b = new FakeElement("div");
    b.textContent = "more";
    d.textContent = "text";
    d.appendChild(b);
  };
  const withEmptyLine = (d: FakeElement): void => {
    const b = new FakeElement("div");
    b.appendChild(new FakeElement("br"));
    d.textContent = "text";
    d.appendChild(b);
  };
  const plainCases: [string, (d: FakeElement) => void, string, [number, number]][] = [
    ["text<div>more</div>", withMore, "text\nmore", [5, 9]],
    ["text<div><br></div>", withEmptyLine, "text\n", [0, 4]],
  ];
  for (const [label, build, want, word] of plainCases) {
    it(`a plain box holding ${label} turns styled with its line break kept and no DIV left`, async () => {
      await open(text());
      build(div);
      select(word[0], word[1]);
      expect(edit().range).toEqual({ s: word[0], e: word[1] });
      edit().applyRange({ size: 30 });
      expect(editorText(div as any)).toBe(want);
      expect(div.querySelectorAll("div")).toHaveLength(0);
      expect(spans().find((s) => s.size === "30px")!.text).toBe(want.slice(word[0], word[1]));
      kit.keydown("Escape");
      expect(mark()).toMatchObject({ text: want, runs: [{ s: word[0], e: word[1], size: 30 }] });
    });
  }
});
