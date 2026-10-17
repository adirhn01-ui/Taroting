import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, PdfAnnot, PdfSignature } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { decodePoints, encodePoints } from "../../../image/strokes";
import { pageAnnots } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./testkit.test-util";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../../ui/toast", () => ({
  toast: {
    error: (m: string) => toasts.push(`error:${m}`),
    refuse: (m: string) => toasts.push(`refuse:${m}`),
    info: (m: string) => toasts.push(`info:${m}`),
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

const { settingsStore } = await import("../../../core/session");
const { toolsPart } = await import("../tools");
const { insertPicture, withPicture } = await import("./picture");
const { withSignature, withoutSignature } = await import("./signature");

const white = (id: string, x: number, y: number, w: number, h: number): PdfAnnot => ({ id, t: "whiteout", x, y, w, h, c: "#ffffff" });
const ink = (id: string, pts: number[]): PdfAnnot => ({ id, t: "ink", kind: "pen", c: "#000000", w: 4, o: 1, p: encodePoints(new Float32Array(pts)) });
const sig = (n: number): PdfSignature => ({ strokes: [encodePoints(new Float32Array([0, 0, 1, n / 10, 1, 1]))], aspect: 2 });

let kit: Kit;
let part: { dispose(): void };

async function mount(p = project()): Promise<void> {
  kit = makeKit(p);
  part = toolsPart(kit.ctx, kit.hosts);
  await kit.flush();
}
const marks = (key = "P1"): readonly PdfAnnot[] => pageAnnots(kit.session.project, key);
const setTool = async (tool: Parameters<Kit["ctx"]["tools"]["set"]>[0]["tool"]): Promise<void> => {
  kit.ctx.tools.update((s) => ({ ...s, tool }));
  await kit.flush();
};
function drag(points: [number, number][], extra: Record<string, unknown> = {}, target?: FakeElement): void {
  const [first, ...rest] = points;
  kit.pointer("pointerdown", first![0], first![1], extra, target);
  for (const [x, y] of rest.slice(0, -1)) kit.pointer("pointermove", x, y, extra);
  const last = rest[rest.length - 1] ?? first!;
  kit.pointer("pointerup", last[0], last[1], extra);
}
const toolbarButtons = (): FakeElement[] => (kit.hosts.toolbar as unknown as FakeElement).querySelectorAll("button");
const svgOf = (key: string): FakeElement | null => (kit.view.overlay(key) as unknown as FakeElement).querySelector("svg");

beforeEach(() => {
  toasts.length = 0;
  settingsStore.set({ ...DEFAULT_SETTINGS, pdfSignatures: [] });
});
afterEach(() => {
  part?.dispose();
  vi.unstubAllGlobals();
});

describe("mounting", () => {
  it("puts the tool row in the toolbar host and removes everything on dispose", async () => {
    await mount(project({ P1: [white("w", 10, 10, 50, 50)] }));
    const row = (kit.hosts.toolbar as unknown as FakeElement).querySelector(".pdfmk-toolbar")!;
    expect(row).not.toBeNull();
    expect(toolbarButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Select", "Highlight", "Pen", "Pencil", "Marker", "Eraser", "Shapes", "Text", "Whiteout", "Image", "Signature", "Ruler",
    ]);
    expect(svgOf("P1")).not.toBeNull();
    expect(kit.view.el.listenerCount("pointerdown")).toBe(1);
    expect(kit.doc.body.querySelector(".pdfmk-brush")).not.toBeNull();
    const bound = [...kit.keys.values()].reduce((n, l) => n + l.length, 0);
    expect(bound).toBeGreaterThanOrEqual(13);

    part.dispose();
    expect((kit.hosts.toolbar as unknown as FakeElement).querySelector(".pdfmk-toolbar")).toBeNull();
    expect(svgOf("P1")).toBeNull();
    expect(svgOf("P2")).toBeNull();
    expect(kit.view.el.listenerCount("pointerdown")).toBe(0);
    expect(kit.view.el.listenerCount("pointermove")).toBe(0);
    expect(kit.doc.listenerCount("keydown")).toBe(0);
    expect(kit.doc.listenerCount("pointerup")).toBe(0);
    expect(kit.doc.body.querySelector(".pdfmk-brush")).toBeNull();
    expect([...kit.keys.values()].reduce((n, l) => n + l.length, 0)).toBe(0);
    expect(kit.view.listeners("pagevisible")).toBe(0);
    expect(kit.view.listeners("layout")).toBe(0);
  });

  it("registers every tool chord through ctx.bindKey", async () => {
    await mount();
    for (const a of ["imgSelect", "imgPen", "imgPencil", "imgMarker", "imgEraser", "imgShape", "imgRuler", "imgSizeDown", "imgSizeUp", "pdfHighlight", "pdfText", "pdfWhiteout", "delete"] as const) {
      expect(kit.keys.get(a)?.length, a).toBe(1);
    }
    kit.action("imgPen");
    expect(kit.ctx.tools.get().tool).toBe("pen");
    kit.action("imgSizeUp");
    expect(kit.ctx.tools.get().sizes.pen).toBe(5);
    kit.action("pdfWhiteout");
    expect(kit.ctx.tools.get().tool).toBe("whiteout");
    kit.action("imgRuler");
    expect(kit.ctx.tools.get().ruler).toEqual({ key: "P1", cx: 306, cy: 396, angle: 0 });
    kit.action("imgRuler");
    expect(kit.ctx.tools.get().ruler).toBeNull();
  });
});

describe("the mark layer", () => {
  it("draws saved marks in page space and repaints only the page that changed", async () => {
    await mount(project({ P1: [white("w", 10, 20, 50, 60)], P2: [white("v", 1, 1, 5, 5)] }));
    const svg = svgOf("P1")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 612 792");
    const rect1 = svg.querySelector("rect[data-id]")!;
    expect(rect1.getAttribute("x")).toBe("10");
    expect(rect1.getAttribute("height")).toBe("60");
    const p2rect = svgOf("P2")!.querySelector("rect[data-id]")!;

    kit.session.commit((p) => ({ ...p, pdf: { ...p.pdf!, annots: Object.assign(Object.create(null), p.pdf!.annots, { P2: [white("v", 2, 2, 5, 5)] }) } }));
    await kit.flush();
    expect(svgOf("P1")!.querySelector("rect[data-id]")).toBe(rect1);
    expect(svgOf("P2")!.querySelector("rect[data-id]")).not.toBe(p2rect);
  });

  it("turns the page group with the page's rotation", async () => {
    const p = project();
    const turned = { ...p, pdf: { ...p.pdf!, pages: p.pdf!.pages.map((pg) => (pg.id === "P1" ? { ...pg, rotate: 90 as const } : pg)) } };
    await mount(turned);
    const svg = svgOf("P1")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 792 612");
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe("matrix(0 1 -1 0 792 0)");
  });
});

describe("drawing tools commit one history step each", () => {
  it("pen: one ink mark in page space, width = size / zoom", async () => {
    await mount();
    await setTool("pen");
    kit.view.setZoom(2);
    drag([
      [200, 200],
      [260, 230],
      [300, 260],
      [400, 300],
    ]);
    expect(kit.session.steps).toBe(1);
    const a = marks()[0] as Extract<PdfAnnot, { t: "ink" }>;
    expect(a).toMatchObject({ t: "ink", kind: "pen", c: "#000000", w: 2, o: 1 });
    const pts = decodePoints(a.p)!;
    expect(pts[0]).toBeCloseTo(100, 3);
    expect(pts[1]).toBeCloseTo(100, 3);
    expect(pts[pts.length - 3]).toBeCloseTo(200, 3);
    // autosave held for the gesture and released
    expect(kit.session.holds).toBe(1);
    expect(kit.session.released).toBe(1);
  });

  it("marker and pencil take the image editor's opacities", async () => {
    await mount();
    await setTool("marker");
    drag([
      [10, 10],
      [50, 10],
    ]);
    await setTool("pencil");
    drag(
      [
        [10, 50],
        [50, 50],
      ],
      { pointerType: "pen", pressure: 0.5 },
    );
    const [m, p] = marks() as Extract<PdfAnnot, { t: "ink" }>[];
    expect(m!.kind).toBe("marker");
    expect(m!.o).toBe(0.4);
    expect(p!.kind).toBe("pencil");
    expect(p!.o).toBeGreaterThan(0.3);
    expect(p!.o).toBeLessThan(1);
    expect(kit.session.steps).toBe(2);
  });

  it("a press someone ahead of us took (hold-to-pan) starts nothing", async () => {
    await mount();
    await setTool("pen");
    // the shell's pan listener ran first (capture phase, same element) and took it
    const first = kit.view.el;
    const taken = new FakeEvent("pointerdown", { clientX: 100, clientY: 100, pointerId: 3, pointerType: "mouse", button: 0, pressure: 0.5 });
    taken.preventDefault();
    kit.view.page.get("P1")!.dispatchEvent(taken);
    kit.pointer("pointermove", 150, 150, { pointerId: 3 });
    kit.pointer("pointerup", 200, 200, { pointerId: 3 });
    expect(kit.session.steps).toBe(0);
    expect(first.captured.size).toBe(0);
  });

  it("a pen stroke near the ruler snaps to its edge", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "pen", ruler: { key: "P1", cx: 300, cy: 300, angle: 0 } }));
    await kit.flush();
    drag([
      [200, 330],
      [250, 340],
      [300, 325],
    ]);
    const pts = decodePoints((marks()[0] as Extract<PdfAnnot, { t: "ink" }>).p)!;
    for (let i = 1; i < pts.length; i += 3) expect(pts[i]).toBeCloseTo(300 + 22 + 2, 3);
  });

  it("shapes: a drag is one shape of the chosen kind; Shift squares it", async () => {
    await mount();
    await setTool("shape");
    drag(
      [
        [100, 100],
        [180, 140],
      ],
      { shiftKey: true },
    );
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ t: "rect", c: "#e5484d", w: 4, a: [100, 100], b: [180, 180] });
    // a click is not a shape
    drag([[300, 300]]);
    expect(kit.session.steps).toBe(1);
  });

  it("no live preview survives a finished gesture (a frame queued by the last move)", async () => {
    // Found on screen: an arrow drawn, then a second copy left behind — the
    // preview frame the final move queued ran after the release and redrew it.
    await mount();
    for (const tool of ["shape", "pen", "whiteout"] as const) {
      await setTool(tool);
      drag([
        [100, 100],
        [180, 140],
        [220, 160],
      ]);
      kit.runFrames();
      const live = svgOf("P1")!.querySelector(".pdfmk-live")!;
      expect(live.children.length, tool).toBe(0);
    }
  });

  it("whiteout: a dragged white box; a click adds nothing", async () => {
    await mount();
    await setTool("whiteout");
    drag([
      [100, 100],
      [150, 120],
    ]);
    expect(marks()).toEqual([expect.objectContaining({ t: "whiteout", x: 100, y: 100, w: 50, h: 20, c: "#ffffff" })]);
    drag([[300, 300]]);
    expect(kit.session.steps).toBe(1);
  });

  it("eraser: previews removal live, then lands ONE step", async () => {
    await mount(project({ P1: [ink("a", [100, 100, 1, 200, 100, 1]), ink("b", [100, 300, 1, 200, 300, 1])] }));
    await setTool("eraser");
    kit.pointer("pointerdown", 150, 80);
    kit.pointer("pointermove", 150, 120);
    expect(kit.session.steps).toBe(0);
    expect(marks().map((a) => a.id)).toEqual(["b"]);
    kit.pointer("pointerup", 150, 130);
    expect(kit.session.steps).toBe(1);
    expect(kit.session.history[0]!.pdf!.annots.P1!.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("eraser cancelled: the preview is undone, nothing is written", async () => {
    await mount(project({ P1: [ink("a", [100, 100, 1, 200, 100, 1])] }));
    await setTool("eraser");
    kit.pointer("pointerdown", 150, 80);
    kit.pointer("pointermove", 150, 120);
    expect(marks()).toHaveLength(0);
    kit.pointer("pointercancel", 150, 120);
    expect(marks()).toHaveLength(1);
    expect(kit.session.steps).toBe(0);
  });
});

describe("highlight", () => {
  it("turns the text selection into one highlight per page, in one step", async () => {
    await mount();
    await setTool("highlight");
    const down = kit.pointer("pointerdown", 20, 20, {}, kit.view.span("P1"));
    expect(down.defaultPrevented).toBe(false); // the browser selects the text
    kit.view.selection = [
      { key: "P1", rects: [[10, 10, 80, 12]] },
      { key: "P2", rects: [[10, 10, 40, 12], [10, 30, 40, 12]] },
    ];
    kit.pointer("pointerup", 400, 900, {}, kit.view.span("P2"));
    expect(kit.session.steps).toBe(1);
    expect(marks("P1")).toEqual([expect.objectContaining({ t: "highlight", c: "#ffd400", rects: [[10, 10, 80, 12]] })]);
    expect((marks("P2")[0] as Extract<PdfAnnot, { t: "highlight" }>).rects).toHaveLength(2);
  });

  it("a drag off the text is a free highlight rectangle", async () => {
    await mount();
    await setTool("highlight");
    drag([
      [100, 400],
      [200, 420],
    ]);
    expect(marks()).toEqual([expect.objectContaining({ t: "highlight", rects: [[100, 400, 100, 20]] })]);
    expect(kit.session.steps).toBe(1);
  });
});

describe("text boxes", () => {
  const editorDiv = (): FakeElement | null => (kit.view.overlay("P1") as unknown as FakeElement).querySelector(".pdfmk-text-edit");

  it("a click opens an editor; Escape commits one text mark", async () => {
    await mount();
    await setTool("text");
    kit.pointer("pointerdown", 100, 100);
    const ed = editorDiv()!;
    expect(ed).not.toBeNull();
    expect(ed.getAttribute("contenteditable")).toBe("plaintext-only");
    expect(kit.ctx.isTyping(ed as unknown as EventTarget)).toBe(true);
    ed.textContent = "Hello there";
    const esc = new FakeEvent("keydown", { key: "Escape" });
    ed.dispatchEvent(esc);
    expect(editorDiv()).toBeNull();
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ t: "text", text: "Hello there", font: "Segoe UI", size: 14, w: 200, align: "left", c: "#000000" });
  });

  it("a double-click on a text mark with Select edits it", async () => {
    await mount(project({ P1: [{ id: "t", t: "text", x: 100, y: 100, w: 100, h: 20, text: "hi", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left" }] }));
    kit.pointer("dblclick", 110, 110);
    const ed = editorDiv()!;
    expect(ed).not.toBeNull();
    expect(ed.textContent).toBe("hi");
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "t" }]);
    ed.textContent = "hello";
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ text: "hello" });
  });

  it("empty text adds nothing; emptying an existing box deletes it", async () => {
    await mount();
    await setTool("text");
    kit.pointer("pointerdown", 100, 100);
    editorDiv()!.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(kit.session.steps).toBe(0);

    kit.pointer("pointerdown", 100, 100);
    editorDiv()!.textContent = "x";
    // a click away commits
    kit.pointer("pointerdown", 400, 600);
    expect(kit.session.steps).toBe(1);
    const id = marks()[0]!.id;
    await kit.flush();
    // click the box again: edits it
    const a = marks()[0] as Extract<PdfAnnot, { t: "text" }>;
    kit.pointer("pointerdown", a.x + 5, a.y + 5);
    const ed = editorDiv()!;
    expect(ed.textContent).toBe("x");
    ed.textContent = "  ";
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(kit.session.steps).toBe(2);
    expect(marks().some((m) => m.id === id)).toBe(false);
  });
});

describe("select", () => {
  const P = (): ReturnType<typeof project> => project({ P1: [white("a", 100, 100, 100, 50), white("b", 400, 400, 20, 20)] });

  it("click selects the topmost mark; drag moves it in one step", async () => {
    await mount(P());
    kit.pointer("pointerdown", 150, 120);
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "a" }]);
    kit.pointer("pointermove", 170, 130);
    kit.pointer("pointermove", 180, 140);
    expect(kit.session.steps).toBe(0);
    kit.pointer("pointerup", 180, 140);
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ x: 130, y: 120 });
  });

  it("drag dropped on another page moves the mark there", async () => {
    await mount(P());
    kit.pointer("pointerdown", 150, 120);
    kit.pointer("pointermove", 150, 500);
    kit.pointer("pointerup", 150, 900);
    expect(kit.session.steps).toBe(1);
    expect(marks("P1").map((a) => a.id)).toEqual(["b"]);
    expect(marks("P2")[0]).toMatchObject({ id: "a", x: 100, y: 100 + (900 - 792 - 120) });
    expect(kit.ctx.selection.get()).toEqual([{ key: "P2", id: "a" }]);
  });

  it("Shift-click adds, a marquee selects, Escape clears", async () => {
    await mount(P());
    kit.pointer("pointerdown", 150, 120);
    kit.pointer("pointerup", 150, 120);
    kit.pointer("pointerdown", 410, 410, { shiftKey: true });
    expect(kit.ctx.selection.get()).toHaveLength(2);
    kit.keydown("Escape");
    expect(kit.ctx.selection.get()).toEqual([]);
    drag([
      [50, 50],
      [300, 300],
    ]);
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "a" }]);
    expect(kit.session.steps).toBe(0);
  });

  it("a handle resizes in one step; Delete removes; arrows nudge", async () => {
    await mount(P());
    kit.ctx.selection.set([{ key: "P1", id: "a" }]);
    await kit.flush();
    // the se handle sits at (200, 150)
    drag([
      [200, 150],
      [250, 200],
      [300, 250],
    ]);
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ x: 100, y: 100, w: 200, h: 150 });
    kit.keydown("ArrowRight");
    kit.keydown("ArrowDown", { shiftKey: true });
    expect(kit.session.steps).toBe(3);
    expect(marks()[0]).toMatchObject({ x: 101, y: 110 });
    kit.action("delete");
    expect(kit.session.steps).toBe(4);
    expect(marks().map((a) => a.id)).toEqual(["b"]);
    expect(kit.ctx.selection.get()).toEqual([]);
  });

  it("draws an outline and eight handles for the selection", async () => {
    await mount(P());
    kit.ctx.selection.set([{ key: "P1", id: "a" }]);
    await kit.flush();
    const chrome = svgOf("P1")!.querySelector(".pdfmk-chrome")!;
    expect(chrome.querySelectorAll(".pdfmk-sel")).toHaveLength(1);
    expect(chrome.querySelectorAll(".pdfmk-handle")).toHaveLength(8);
  });
});

describe("cursor feedback", () => {
  it("ink tools show a brush circle of the tool size; boxes get a crosshair", async () => {
    await mount();
    await setTool("pen");
    const brush = kit.doc.body.querySelector(".pdfmk-brush")!;
    kit.pointer("pointermove", 100, 100);
    expect(brush.hidden).toBe(false);
    expect(brush.style.width).toBe("4px");
    expect(brush.style.transform).toBe("translate(98px, 98px)");
    expect(kit.view.el.classList.contains("pdfmk-cur-brush")).toBe(true);
    await setTool("whiteout");
    expect(brush.hidden).toBe(true);
    expect(kit.view.el.classList.contains("pdfmk-cur-cross")).toBe(true);
    expect(kit.view.el.classList.contains("pdfmk-cur-brush")).toBe(false);
    await setTool("text");
    expect(kit.view.el.classList.contains("pdfmk-cur-text")).toBe(true);
  });
});

describe("modes and the text layer", () => {
  it("text layer: on for select and highlight, off for every pointer-owning tool", async () => {
    await mount();
    expect(kit.view.textLayer.at(-1)).toBe(true);
    for (const t of ["pen", "pencil", "marker", "eraser", "shape", "text", "whiteout", "signature"] as const) {
      await setTool(t);
      expect(kit.view.textLayer.at(-1), t).toBe(false);
    }
    await setTool("highlight");
    expect(kit.view.textLayer.at(-1)).toBe(true);
  });

  it("Fill forms mode disables every tool", async () => {
    await mount();
    await setTool("pen");
    kit.ctx.mode.set("forms");
    await kit.flush();
    expect(toolbarButtons().every((b) => b.disabled)).toBe(true);
    expect(kit.view.textLayer.at(-1)).toBe(true);
    drag([
      [100, 100],
      [200, 200],
    ]);
    kit.action("imgEraser");
    expect(kit.ctx.tools.get().tool).toBe("pen");
    expect(kit.session.steps).toBe(0);
    kit.ctx.mode.set("annotate");
    await kit.flush();
    expect(toolbarButtons().some((b) => b.disabled)).toBe(false);
  });
});

describe("signatures", () => {
  it("save puts it first and drops the oldest; delete removes one", () => {
    const list = [sig(1), sig(2), sig(3)];
    const next = withSignature(list, sig(4));
    expect(next).toEqual([sig(4), sig(1), sig(2)]);
    expect(withoutSignature(next, 1)).toEqual([sig(4), sig(2)]);
  });

  it("the menu lists saved signatures; × deletes from Settings; a pick arms a one-step placement", async () => {
    settingsStore.set({ ...settingsStore.get(), pdfSignatures: [sig(1), sig(2)] });
    await mount();
    const sigBtn = toolbarButtons().find((b) => b.getAttribute("aria-label") === "Signature")!;
    sigBtn.click();
    const menu = kit.doc.body.querySelector(".pdfmk-sigmenu")!;
    expect(menu.querySelectorAll(".pdfmk-sigmenu__pick")).toHaveLength(2);
    menu.querySelectorAll(".pdfmk-sigmenu__del")[0]!.click();
    await kit.flush();
    expect(settingsStore.get().pdfSignatures).toEqual([sig(2)]);
    expect(menu.querySelectorAll(".pdfmk-sigmenu__pick")).toHaveLength(1);
    menu.querySelector(".pdfmk-sigmenu__pick")!.click();
    expect(kit.doc.body.querySelector(".pdfmk-sigmenu")).toBeNull();
    await kit.flush();
    expect(kit.ctx.tools.get().tool).toBe("signature");
    kit.pointer("pointerdown", 300, 300);
    expect(kit.session.steps).toBe(1);
    expect(marks()[0]).toMatchObject({ t: "signature", x: 220, y: 260, w: 160, h: 80, c: "#000000", strokes: sig(2).strokes });
    await kit.flush();
    expect(kit.ctx.tools.get().tool).toBe("select");
  });

  it("the pad saves a drawn signature first in Settings (max 3) and arms it", async () => {
    settingsStore.set({ ...settingsStore.get(), pdfSignatures: [sig(1), sig(2), sig(3)] });
    await mount();
    toolbarButtons().find((b) => b.getAttribute("aria-label") === "Signature")!.click();
    const items = kit.doc.body.querySelector(".pdfmk-sigmenu")!.querySelectorAll("button");
    items.find((b) => b.textContent === "New signature")!.click();
    const modal = kit.doc.body.querySelector(".modal")!;
    const pad = modal.querySelector(".pdfmk-sigpad")!;
    const save = modal.querySelectorAll("button").find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(true);
    const ev = (type: string, x: number, y: number): void => {
      pad.dispatchEvent(new FakeEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType: "mouse", button: 0, pressure: 0.5, timeStamp: 0 }));
    };
    ev("pointerdown", 20, 25);
    ev("pointermove", 60, 30);
    ev("pointerup", 100, 40);
    expect(save.disabled).toBe(false);
    save.click();
    await kit.flush();
    expect(kit.doc.body.querySelector(".modal-backdrop")).toBeNull();
    const saved = settingsStore.get().pdfSignatures;
    expect(saved).toHaveLength(3);
    expect(saved[0]).not.toEqual(sig(1));
    expect(saved.slice(1)).toEqual([sig(1), sig(2)]);
    expect(kit.ctx.tools.get().tool).toBe("signature");
  });
});

describe("pictures", () => {
  const info: MediaInfo = { path: "C:\\p.png", size: 5, mtimeMs: 6, kind: "image", duration: 0, width: 400, height: 200, hasAudio: false };

  it("inserts the MediaRef and a centred, half-page mark in ONE commit, selected", async () => {
    await mount();
    const ok = await insertPicture(kit.ctx, { infoAsync: async () => ({ w: 600, h: 800, rot: 0 }) } as never, () => "P2", () => true, {
      pick: async () => "C:\\p.png",
      probe: async () => info,
    });
    expect(ok).toBe(true);
    expect(kit.session.steps).toBe(1);
    const p = kit.session.project;
    expect(p.media).toHaveLength(1);
    const a = marks("P2")[0] as Extract<PdfAnnot, { t: "image" }>;
    expect(a).toMatchObject({ t: "image", x: 150, y: 325, w: 300, h: 150, media: p.media[0]!.id });
    expect(kit.ctx.selection.get()).toEqual([{ key: "P2", id: a.id }]);
    // the same file again reuses its MediaRef
    const again = withPicture(p, "P1", info, [0, 0, 10, 10], "m2");
    expect(again.media).toHaveLength(1);
  });

  it("refuses a file that is not a still picture", async () => {
    await mount();
    const ok = await insertPicture(kit.ctx, { infoAsync: async () => ({ w: 600, h: 800, rot: 0 }) } as never, () => "P1", () => true, {
      pick: async () => "C:\\v.mp4",
      probe: async () => ({ ...info, kind: "video" }),
    });
    expect(ok).toBe(false);
    expect(kit.session.steps).toBe(0);
    expect(toasts[0]).toMatch(/^refuse:/);
  });
});
