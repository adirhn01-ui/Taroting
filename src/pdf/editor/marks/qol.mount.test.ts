// The owner's review round on the PDF editor (0.9.3): text box fill and
// border, the inspector following the last thing touched, the Text tool that
// selects / moves / types, copy-paste-duplicate, remembered tool styles,
// Shift-straight ink and the Fill forms switch in the panel. The tools, the
// inspector and (where needed) the forms part are mounted together on the
// marks test kit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnot } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { decodePoints } from "../../../image/strokes";
import { pageAnnots } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, showPages, type Kit } from "./testkit.test-util";

const h = vi.hoisted(() => ({
  toasts: [] as string[],
}));
// the font runtime as a plain <select> of the six (these tests are about the inspector)
vi.mock("../../../fonts", async () => (await import("./fonts-stand-in.test-util")).fontsStandIn());
vi.mock("../../../ui/toast", () => ({
  toast: {
    error: (m: string) => h.toasts.push(`error:${m}`),
    refuse: (m: string) => h.toasts.push(`refuse:${m}`),
    info: (m: string) => h.toasts.push(`info:${m}`),
  },
}));
vi.mock("../../../core/session", async (orig) => {
  const real = await orig<typeof import("../../../core/session")>();
  return {
    ...real,
    updateSettings: vi.fn(async (patch: object) => {
      real.settingsStore.set({ ...real.settingsStore.get(), ...patch });
    }),
  };
});

const session = await import("../../../core/session");
const { settingsStore } = session;
const updateSettings = session.updateSettings as unknown as ReturnType<typeof vi.fn>;
const { toolsPart, STYLE_SAVE_MS } = await import("../tools");
const { inspectorPart, nextFocus } = await import("../inspector");
const { formsPart } = await import("../forms");
const { resetMarkClipboard, PASTE_STEP } = await import("./clipboard");

type Text = Extract<PdfAnnot, { t: "text" }>;
const text = (id: string, x: number, y: number, extra: Partial<Text> = {}): PdfAnnot => ({
  id, t: "text", x, y, w: 120, h: 30, text: "hello", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left", ...extra,
});
const white = (id: string, x: number, y: number, w = 50, hh = 40): PdfAnnot => ({ id, t: "whiteout", x, y, w, h: hh, c: "#ffffff" });
const rect = (id: string): PdfAnnot => ({ id, t: "rect", c: "#e5484d", w: 4, a: [300, 300], b: [400, 380] });

let kit: Kit;
let parts: { dispose(): void }[] = [];

async function mount(p = project(), opts: { forms?: boolean } = {}): Promise<void> {
  kit = makeKit(p);
  parts = [toolsPart(kit.ctx, kit.hosts), inspectorPart(kit.ctx, kit.hosts)];
  if (opts.forms) parts.push(formsPart(kit.ctx, kit.hosts));
  showPages(kit);
  await kit.flush();
}
const marks = (key = "P1"): readonly PdfAnnot[] => pageAnnots(kit.session.project, key);
const insp = (): FakeElement => kit.hosts.inspector as unknown as FakeElement;
const title = (): string => insp().querySelector(".insp-header__name")?.textContent ?? "";
const setTool = async (tool: Parameters<Kit["ctx"]["tools"]["set"]>[0]["tool"]): Promise<void> => {
  kit.ctx.tools.update((s) => ({ ...s, tool }));
  await kit.flush();
};
const overlay = (key = "P1"): FakeElement => kit.view.overlay(key) as unknown as FakeElement;
const editorDiv = (): FakeElement | null => overlay().querySelector(".pdfmk-text-edit");
const toolButton = (label: string): FakeElement =>
  (kit.hosts.toolbar as unknown as FakeElement).querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label)!;
const group = (label: string): FakeElement => insp().querySelectorAll(".pdfmk-swatches").find((g) => g.getAttribute("aria-label") === label)!;
const swatch = (label: string, title: string): FakeElement => group(label).querySelectorAll("button").find((b) => b.title === title)!;
function drag(points: [number, number][], extra: Record<string, unknown> = {}, target?: FakeElement): void {
  const [first, ...rest] = points;
  kit.pointer("pointerdown", first![0], first![1], extra, target);
  for (const [x, y] of rest.slice(0, -1)) kit.pointer("pointermove", x, y, extra);
  const last = rest[rest.length - 1] ?? first!;
  kit.pointer("pointerup", last[0], last[1], extra);
}

beforeEach(() => {
  h.toasts.length = 0;
  updateSettings.mockClear();
  resetMarkClipboard();
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [], pdfToolStyle: {} });
});
afterEach(() => {
  for (const p of parts.splice(0)) p.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* 1. Text box fill and border                                         */
/* ------------------------------------------------------------------ */

describe("text box fill and border", () => {
  it("a selected text box: Fill / Border swatches are one step each, None removes them", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    swatch("Text box fill", "#ffd400").click();
    expect(marks()[0]).toMatchObject({ bg: "#ffd400" });
    expect(kit.session.steps).toBe(1);
    swatch("Text box border", "#0090ff").click();
    expect(marks()[0]).toMatchObject({ border: "#0090ff" });
    expect(kit.session.steps).toBe(2);
    await kit.flush();
    expect(swatch("Text box fill", "None").getAttribute("aria-pressed")).toBe("false");
    swatch("Text box fill", "None").click();
    expect("bg" in marks()[0]!).toBe(false);
    expect(kit.session.steps).toBe(3);
    await kit.flush();
    expect(swatch("Text box fill", "None").getAttribute("aria-pressed")).toBe("true");
    // drawn: the saved box shows its border
    const box = overlay().querySelector("foreignObject[data-id]")!.children[0]!;
    expect(box.style.boxShadow).toBe("inset 0 0 0 1px #0090ff");
  });

  it("the Text tool's Fill / Border are the next box's (tool state only), and the live editor wears them", async () => {
    await mount();
    await setTool("text");
    expect(swatch("Text box fill", "None").getAttribute("aria-pressed")).toBe("true");
    swatch("Text box fill", "#ffffff").click();
    swatch("Text box border", "#000000").click();
    expect([kit.ctx.tools.get().textBg, kit.ctx.tools.get().textBorder]).toEqual(["#ffffff", "#000000"]);
    expect(kit.session.steps).toBe(0);
    kit.pointer("pointerdown", 100, 100);
    const ed = editorDiv()!;
    expect(ed.style.backgroundColor).toBe("#ffffff");
    expect(ed.style.boxShadow).toBe("inset 0 0 0 1px #000000");
    ed.textContent = "boxed";
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(marks()[0]).toMatchObject({ text: "boxed", bg: "#ffffff", border: "#000000" });
  });
});

describe("the panel while a box is being typed in", () => {
  it("a NEW box: the panel is that box; a Fill swatch fills it live, keeps the editor and the caret, Esc lands it selected (one step)", async () => {
    await mount();
    await setTool("text");
    kit.pointer("pointerdown", 100, 100);
    const ed = editorDiv()!;
    expect(kit.doc.activeElement).toBe(ed);
    ed.textContent = "typed";
    await kit.flush();
    // the box's own panel (Text section, Delete), not the tool's defaults
    expect(title()).toBe("Text");
    expect(insp().querySelectorAll(".insp-section__title").map((t) => t.textContent)).toContain("Mark");
    const sw = swatch("Text box fill", "#ffd400");
    // a press on a panel button never takes focus from the text
    const down = new FakeEvent("mousedown", { button: 0 });
    sw.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    sw.click();
    await kit.flush();
    expect(editorDiv()).toBe(ed);
    expect(kit.doc.activeElement).toBe(ed);
    expect(ed.style.backgroundColor).toBe("#ffd400");
    expect(kit.ctx.textEdit.get()?.draft).toMatchObject({ bg: "#ffd400" });
    // nothing landed yet; the Text tool's default follows, for the next box
    expect(kit.session.steps).toBe(0);
    expect(kit.ctx.tools.get().textBg).toBe("#ffd400");
    // Esc with focus momentarily in the panel still commits
    const font = insp().querySelectorAll("select").find((x) => x.getAttribute("aria-label") === "Font")!;
    font.focus();
    expect(editorDiv()).toBe(ed);
    kit.keydown("Escape");
    expect(editorDiv()).toBeNull();
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ text: "typed", bg: "#ffd400" });
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: marks()[0]!.id }]);
    expect(kit.ctx.textEdit.get()).toBeNull();
    // one undo step takes the whole box away
    expect(pageAnnots(kit.session.history.at(-1)!, "P1")).toHaveLength(0);
  });

  it("an EXISTING box: panel edits land on it (one step each) and the tool default follows; Delete closes and removes it", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    kit.pointer("pointerdown", 110, 110);
    kit.pointer("pointerup", 110, 110);
    await kit.flush();
    const font = insp().querySelectorAll("select").find((x) => x.getAttribute("aria-label") === "Font")!;
    font.focus();
    expect(editorDiv()).not.toBeNull();
    font.value = "Georgia";
    font.dispatchEvent(new FakeEvent("change"));
    expect(marks()[0]).toMatchObject({ font: "Georgia" });
    expect(kit.session.steps).toBe(1);
    expect(kit.ctx.tools.get().font).toBe("Georgia");
    expect(kit.doc.activeElement).toBe(editorDiv());
    await kit.flush();
    insp().querySelectorAll("button").find((b) => b.innerHTML === "Delete")!.click();
    expect(editorDiv()).toBeNull();
    expect(marks()).toHaveLength(0);
    expect(kit.session.steps).toBe(2);
  });

  it("a new box: Delete in the panel drops it, nothing lands", async () => {
    await mount();
    await setTool("text");
    kit.pointer("pointerdown", 100, 100);
    editorDiv()!.textContent = "gone";
    await kit.flush();
    insp().querySelectorAll("button").find((b) => b.innerHTML === "Delete")!.click();
    expect(editorDiv()).toBeNull();
    expect(marks()).toHaveLength(0);
    expect(kit.session.steps).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The inspector follows the last thing touched                     */
/* ------------------------------------------------------------------ */

describe("the inspector shows what was touched last", () => {
  it("nextFocus: a tool pick wins; a selection that empties falls back to the tool", () => {
    expect(nextFocus("pages", { tool: true })).toBe("tool");
    expect(nextFocus("tool", { marks: 2 })).toBe("marks");
    expect(nextFocus("marks", { marks: 0 })).toBe("tool");
    expect(nextFocus("pages", { marks: 0 })).toBe("pages");
    expect(nextFocus("marks", { pages: 1 })).toBe("pages");
    expect(nextFocus("pages", { pages: 0 })).toBe("tool");
  });

  it("thumbnail → pages; picking a tool (button or shortcut) → that tool, the page selection let go", async () => {
    await mount();
    kit.ctx.pageSelection.set([1]);
    await kit.flush();
    expect(title()).toBe("1 page selected");
    toolButton("Pen").click();
    await kit.flush();
    expect(title()).toBe("Pen");
    expect(kit.ctx.pageSelection.get()).toEqual([]);
    kit.ctx.pageSelection.set([0, 1]);
    await kit.flush();
    expect(title()).toBe("2 pages selected");
    // the SAME tool again still brings its panel back
    kit.action("imgPen");
    await kit.flush();
    expect(title()).toBe("Pen");
    expect(kit.ctx.pageSelection.get()).toEqual([]);
  });

  it("re-picking the active tool with a mark selected shows the tool again", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    expect(title()).toBe("Text");
    expect(insp().querySelector(".insp-section__title")?.textContent).toBe("Style");
    toolButton("Text").click();
    await kit.flush();
    expect(kit.ctx.selection.get()).toEqual([]);
    // the tool's panel: its Fill / Border are the tool's (None pressed), not the mark's
    expect(swatch("Text box fill", "None").getAttribute("aria-pressed")).toBe("true");
    expect(insp().querySelectorAll(".insp-section__title").map((t) => t.textContent)).not.toContain("Mark");
  });

  it("handles show only where a press on them resizes (not under Pen)", async () => {
    await mount(project({ P1: [white("w", 100, 100)] }));
    await setTool("pen");
    kit.ctx.selection.set([{ key: "P1", id: "w" }]);
    await kit.flush();
    const chrome = overlay().querySelector(".pdfmk-chrome")!;
    expect(chrome.querySelectorAll(".pdfmk-sel")).toHaveLength(1);
    expect(chrome.querySelectorAll(".pdfmk-handle")).toHaveLength(0);
  });

  it("a press on the pages lets the page selection go; marks then pages then marks, whichever was last", async () => {
    await mount(project({ P1: [white("w", 100, 100)] }));
    kit.ctx.pageSelection.set([0]);
    await kit.flush();
    kit.pointer("pointerdown", 500, 600);
    kit.pointer("pointerup", 500, 600);
    await kit.flush();
    expect(kit.ctx.pageSelection.get()).toEqual([]);
    expect(title()).toBe("Select");
    kit.ctx.selection.set([{ key: "P1", id: "w" }]);
    await kit.flush();
    expect(title()).toBe("Whiteout");
    kit.ctx.pageSelection.set([1]);
    await kit.flush();
    expect(title()).toBe("1 page selected");
    // a re-map with the same pages (after a page op) is not a new touch
    kit.ctx.selection.set([]);
    await kit.flush();
    kit.ctx.selection.set([{ key: "P1", id: "w" }]);
    await kit.flush();
    expect(title()).toBe("Whiteout");
    kit.ctx.pageSelection.set([1]);
    await kit.flush();
    expect(title()).toBe("Whiteout");
  });
});

/* ------------------------------------------------------------------ */
/* 3. The Text tool selects, moves and types                           */
/* ------------------------------------------------------------------ */

describe("the Text tool", () => {
  it("a click on a box selects it and types in it — the editor wears the selection's frame and eight handles", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    kit.pointer("pointerdown", 110, 110);
    kit.pointer("pointerup", 110, 110);
    const ed = editorDiv()!;
    expect(ed.textContent).toBe("hello");
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "t" }]);
    expect(title()).toBe("Text");
    const chrome = overlay().querySelector(".pdfmk-edit-chrome")!;
    expect(chrome.querySelectorAll(".pdfmk-sel")).toHaveLength(1);
    expect(chrome.querySelectorAll(".pdfmk-handle")).toHaveLength(8);
    // the page chrome does not draw a second frame for the box being typed in
    expect(overlay().querySelector(".pdfmk-chrome")!.querySelectorAll(".pdfmk-sel")).toHaveLength(0);
    expect(kit.session.steps).toBe(0);
  });

  it("a drag on a box moves it in one step and opens no editor", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    drag([
      [110, 110],
      [150, 140],
      [160, 150],
    ]);
    expect(editorDiv()).toBeNull();
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ x: 150, y: 140 });
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "t" }]);
    // its handles show in the Text tool too
    await kit.flush();
    expect(overlay().querySelector(".pdfmk-chrome")!.querySelectorAll(".pdfmk-handle")).toHaveLength(8);
  });

  it("Escape and Ctrl+Enter commit and leave the box selected; a click on empty page starts the next box", async () => {
    await mount();
    await setTool("text");
    kit.pointer("pointerdown", 100, 100);
    editorDiv()!.textContent = "one";
    editorDiv()!.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    const one = marks()[0]!;
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: one.id }]);
    kit.pointer("pointerdown", 100, 400);
    expect(kit.ctx.selection.get()).toEqual([]);
    editorDiv()!.textContent = "two";
    editorDiv()!.dispatchEvent(new FakeEvent("keydown", { key: "Enter", ctrlKey: true }));
    expect(editorDiv()).toBeNull();
    expect(marks().map((a) => (a as Text).text)).toEqual(["one", "two"]);
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: marks()[1]!.id }]);
    // plain Enter is a new line, not a commit
    kit.pointer("pointerdown", 100, 600);
    const e = new FakeEvent("keydown", { key: "Enter" });
    editorDiv()!.dispatchEvent(e);
    expect(editorDiv()).not.toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it("while typing, the frame edge moves the box (the text lands first, then one move step)", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    kit.pointer("pointerdown", 110, 110);
    kit.pointer("pointerup", 110, 110);
    const ed = editorDiv()!;
    ed.textContent = "changed";
    // a press on the text near its top line is for the caret: the editor stays
    kit.pointer("pointerdown", 130, 103, {}, ed);
    kit.pointer("pointerup", 130, 103, {}, ed);
    expect(editorDiv()).not.toBeNull();
    expect(kit.session.steps).toBe(0);
    // just outside the top edge (y = 100, between its handles) grabs the frame
    drag([
      [130, 97],
      [160, 127],
      [170, 137],
    ]);
    expect(editorDiv()).toBeNull();
    expect(kit.session.steps).toBe(2);
    expect(marks()[0]).toMatchObject({ text: "changed", x: 140, y: 140 });
  });

  it("focus moving into the inspector keeps the editor open (the user is styling the box)", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    kit.pointer("pointerdown", 110, 110);
    kit.pointer("pointerup", 110, 110);
    await kit.flush();
    const font = insp().querySelectorAll("select").find((s) => s.getAttribute("aria-label") === "Font")!;
    font.focus();
    expect(editorDiv()).not.toBeNull();
    font.value = "Georgia";
    font.dispatchEvent(new FakeEvent("change"));
    await kit.flush();
    // the open editor follows the mark's new font
    expect(editorDiv()!.style.fontFamily).toBe('"Georgia"');
  });

  it("Shapes and Whiteout act on a mark of their own kind; a drag on empty page still draws", async () => {
    await mount(project({ P1: [rect("r"), white("w", 50, 600)] }));
    await setTool("shape");
    drag([
      [300, 340],
      [320, 360],
    ]);
    expect(marks().length).toBe(2);
    expect(marks()[0]).toMatchObject({ a: [320, 320], b: [420, 400] });
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "r" }]);
    // a whiteout is not a shape: the Shapes tool draws over it
    drag([
      [60, 610],
      [120, 680],
    ]);
    expect(marks().length).toBe(3);
    expect(kit.ctx.selection.get()).toEqual([]);
    await setTool("whiteout");
    drag([
      [60, 610],
      [70, 620],
    ]);
    expect(marks().length).toBe(3);
    expect(marks().find((a) => a.id === "w")).toMatchObject({ x: 60, y: 610 });
  });
});

/* ------------------------------------------------------------------ */
/* 4. Copy / paste / duplicate / delete                                */
/* ------------------------------------------------------------------ */

describe("copy, paste, duplicate, delete", () => {
  it("paste lands on the current page, each repeat another step further, new ids selected, one step each", async () => {
    await mount(project({ P1: [white("w", 100, 100)] }));
    kit.ctx.selection.set([{ key: "P1", id: "w" }]);
    kit.action("copy");
    kit.view.state.set({ ...kit.view.state.get(), current: 1 });
    kit.action("paste");
    expect(kit.session.steps).toBe(1);
    const a = marks("P2")[0]!;
    expect(a).toMatchObject({ t: "whiteout", x: 100 + PASTE_STEP, y: 100 + PASTE_STEP });
    expect(a.id).not.toBe("w");
    expect(kit.ctx.selection.get()).toEqual([{ key: "P2", id: a.id }]);
    kit.action("paste");
    expect(kit.session.steps).toBe(2);
    expect(marks("P2")[1]).toMatchObject({ x: 100 + 2 * PASTE_STEP });
    expect(marks("P1")).toHaveLength(1);
  });

  it("duplicate: beside the original on its own page, selected; Delete removes the selection in any tool", async () => {
    await mount(project({ P1: [white("w", 100, 100)] }));
    kit.ctx.selection.set([{ key: "P1", id: "w" }]);
    kit.action("duplicate");
    expect(kit.session.steps).toBe(1);
    expect(marks()).toHaveLength(2);
    expect(marks()[1]).toMatchObject({ x: 110, y: 110 });
    const dup = marks()[1]!.id;
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: dup }]);
    // the Whiteout tool has the duplicate selected (its own kind): Delete works
    await setTool("whiteout");
    kit.ctx.selection.set([{ key: "P1", id: dup }]);
    kit.action("delete");
    expect(marks().map((m) => m.id)).toEqual(["w"]);
  });

  it("the clipboard outlives the editor: a mark copied in one project pastes into the next", async () => {
    await mount(project({ P1: [white("w", 100, 100)] }));
    kit.ctx.selection.set([{ key: "P1", id: "w" }]);
    kit.action("copy");
    for (const p of parts.splice(0)) p.dispose();
    vi.unstubAllGlobals();
    await mount(project());
    kit.action("paste");
    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toMatchObject({ t: "whiteout", x: 110 });
  });

  it("copy / paste / delete do nothing to marks while a box is being typed in", async () => {
    await mount(project({ P1: [text("t", 100, 100)] }));
    await setTool("text");
    kit.pointer("pointerdown", 110, 110);
    kit.pointer("pointerup", 110, 110);
    kit.action("delete");
    kit.action("duplicate");
    expect(marks()).toHaveLength(1);
    expect(kit.session.steps).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Remembered tool styles                                           */
/* ------------------------------------------------------------------ */

describe("remembered tool styles", () => {
  it("a style change is written to Settings once, STYLE_SAVE_MS after the last change; a tool switch alone is not", async () => {
    vi.useFakeTimers();
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "pen" }));
    await kit.flush();
    vi.advanceTimersByTime(STYLE_SAVE_MS * 2);
    expect(updateSettings).not.toHaveBeenCalled();
    kit.ctx.tools.update((s) => ({ ...s, colors: { ...s.colors, pen: "#e5484d" } }));
    await kit.flush();
    kit.ctx.tools.update((s) => ({ ...s, sizes: { ...s.sizes, pen: 9 } }));
    await kit.flush();
    vi.advanceTimersByTime(STYLE_SAVE_MS - 1);
    expect(updateSettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const style = (updateSettings.mock.calls[0]![0] as { pdfToolStyle: { colors: Record<string, string>; sizes: Record<string, number> } }).pdfToolStyle;
    expect(style.colors.pen).toBe("#e5484d");
    expect(style.sizes.pen).toBe(9);
  });

  it("a change still waiting when the editor closes is written then", async () => {
    vi.useFakeTimers();
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, shape: "ellipse", textBg: "#ffffff" }));
    for (const p of parts.splice(0)) p.dispose();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsStore.get().pdfToolStyle).toMatchObject({ shape: "ellipse", textBg: "#ffffff" });
  });
});

/* ------------------------------------------------------------------ */
/* 6. Shift = straight line                                            */
/* ------------------------------------------------------------------ */

describe("Shift draws a straight line with pen, pencil and marker", () => {
  it("the committed ink is just the two ends, snapped to 15° steps", async () => {
    await mount();
    await setTool("marker");
    drag(
      [
        [100, 100],
        [130, 160],
        [170, 90],
        [200, 127],
      ],
      { shiftKey: true },
    );
    expect(kit.session.steps).toBe(1);
    const a = marks()[0] as Extract<PdfAnnot, { t: "ink" }>;
    const pts = decodePoints(a.p)!;
    expect(pts.length).toBe(6);
    expect([pts[0], pts[1]]).toEqual([100, 100]);
    expect((Math.atan2(pts[4]! - 100, pts[3]! - 100) * 180) / Math.PI).toBeCloseTo(15, 3);
  });

  it("without Shift the stroke keeps its path", async () => {
    await mount();
    await setTool("pen");
    drag([
      [100, 100],
      [130, 160],
      [170, 90],
      [200, 127],
    ]);
    expect(decodePoints((marks()[0] as Extract<PdfAnnot, { t: "ink" }>).p)!.length).toBeGreaterThan(6);
  });
});

/* ------------------------------------------------------------------ */
/* 7. The Fill forms switch lives in the panel                         */
/* ------------------------------------------------------------------ */

describe("Fill forms in the inspector", () => {
  const sw = (): FakeElement | null => insp().querySelector("#pdfed-fill-forms");

  it("Select with nothing selected: a Document section with one Fill forms field holding the switch; disabled without fields", async () => {
    await mount(project(), { forms: true });
    expect((kit.hosts.topbar as unknown as FakeElement).children).toHaveLength(0);
    const s = sw()!;
    expect(s.classList.contains("switch")).toBe(true);
    // one field: its label, then the switch itself (no nested row or sublabel),
    // straight inside the Document section like every other field
    const f = s.parentNode as unknown as FakeElement;
    expect(f.classList.contains("insp-field")).toBe(true);
    expect(f.querySelectorAll("label").map((l) => l.textContent)).toEqual(["Fill forms"]);
    expect(f.querySelector("label")!.getAttribute("for")).toBe("pdfed-fill-forms");
    expect((f.parentNode as unknown as FakeElement).classList.contains("insp-section")).toBe(true);
    expect(s.disabled).toBe(true);
    expect(insp().querySelectorAll(".insp-note").map((n) => n.textContent)).toContain("This PDF has no fillable fields.");
    // another tool: no Document section
    await setTool("pen");
    expect(sw()).toBeNull();
  });

  it("with fields: the switch turns the mode on, shows Clear form and the tip, and stays shown whatever happens", async () => {
    const p = project();
    const withValues = { ...p, pdf: { ...p.pdf!, forms: Object.assign(Object.create(null), { src: { "1R": "Ada" } }) } };
    await mount(withValues, { forms: true });
    kit.ctx.hasForms.set(true);
    await kit.flush();
    const s = sw()!;
    expect(s.disabled).toBe(false);
    s.checked = true;
    s.dispatchEvent(new FakeEvent("change"));
    await kit.flush();
    expect(kit.ctx.mode.get()).toBe("forms");
    expect(sw()!.checked).toBe(true);
    expect(insp().querySelectorAll(".insp-note").map((n) => n.textContent)).toContain("Click a field to type. Tab moves to the next one.");
    insp().querySelector("#pdfed-clear-form")!.click();
    expect(kit.session.steps).toBe(1);
    expect(Object.keys(kit.session.project.pdf!.forms)).toEqual([]);
    sw()!.checked = false;
    sw()!.dispatchEvent(new FakeEvent("change"));
    await kit.flush();
    expect(kit.ctx.mode.get()).toBe("annotate");
    expect(insp().querySelector("#pdfed-clear-form")).toBeNull();
  });
});
