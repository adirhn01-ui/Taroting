// The 0.9.3 review findings on the PDF mark tools, one test each (each fails
// without its fix): turned pages (`r`), the inspector's per-kind patches and
// start-snapshot sliders, the keyboard guards, the layer's node reuse, the
// per-frame move writes, unedited cancels, full pages, Impact, signature
// fit, the text editor's newlines, Fill forms mode, the pad's stroke cap.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, PdfAnnot, PdfSignature, ProjectFile } from "../../../core/types";
import { DEFAULT_SETTINGS, PDF_MAX_ANNOTS_PER_PAGE } from "../../../core/types";
import { encodePoints } from "../../../image/strokes";
import { pageAnnots, rotatePages } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./testkit.test-util";

const toasts = vi.hoisted(() => [] as string[]);
// the font runtime as a plain <select> of the six (these tests are about the inspector)
vi.mock("../../../fonts", async () => (await import("./fonts-stand-in.test-util")).fontsStandIn());
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
const { inspectorPart } = await import("../inspector");
const { insertPicture } = await import("./picture");
const { signatureBox } = await import("./controller");
const { SIGNATURE_STROKES_MAX, PAD_FULL_NOTE } = await import("./signature");

type Text = Extract<PdfAnnot, { t: "text" }>;
const white = (id: string, x: number, y: number, w: number, h: number): PdfAnnot => ({ id, t: "whiteout", x, y, w, h, c: "#ffffff" });
const ink: PdfAnnot = { id: "i", t: "ink", kind: "pen", c: "#000000", w: 4, o: 1, p: encodePoints(new Float32Array([0, 0, 1, 50, 50, 1])) };
const text = (extra: Partial<Text> = {}): Text => ({
  id: "t", t: "text", x: 10, y: 10, w: 200, h: 15, text: "hello world", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left", ...extra,
});
const sig: PdfSignature = { strokes: [encodePoints(new Float32Array([0, 0, 1, 1, 1, 1]))], aspect: 2 };

let kit: Kit;
const parts: { dispose(): void }[] = [];

async function mount(p: ProjectFile = project(), withInspector = false): Promise<void> {
  kit = makeKit(p);
  parts.push(toolsPart(kit.ctx, kit.hosts));
  if (withInspector) parts.push(inspectorPart(kit.ctx, kit.hosts));
  await kit.flush();
}
/** P1 shown turned 90° clockwise (a /Rotate 90 scan reads the same way). */
const turned = (annots: Record<string, PdfAnnot[]> = {}): ProjectFile => rotatePages(project(annots), ["P1"], 90);
const marks = (key = "P1"): readonly PdfAnnot[] => pageAnnots(kit.session.project, key);
const toolbarButtons = (): FakeElement[] => (kit.hosts.toolbar as unknown as FakeElement).querySelectorAll("button");
const svgOf = (key: string): FakeElement => (kit.view.overlay(key) as unknown as FakeElement).querySelector("svg")!;
const inspector = (): FakeElement => kit.hosts.inspector as unknown as FakeElement;
const byLabel = (tag: string, label: string): FakeElement => inspector().querySelectorAll(tag).find((e) => e.getAttribute("aria-label") === label)!;
const fire = (el: FakeElement, type: string): void => {
  el.dispatchEvent(new FakeEvent(type, { detail: 1 }));
};
const select = async (...ids: string[]): Promise<void> => {
  kit.ctx.selection.set(ids.map((id) => ({ key: "P1", id })));
  await kit.flush();
};

beforeEach(() => {
  toasts.length = 0;
  settingsStore.set({ ...DEFAULT_SETTINGS, pdfSignatures: [], inkColors: [] });
});
afterEach(() => {
  for (const p of parts.splice(0)) p.dispose();
  vi.unstubAllGlobals();
});

describe("marks placed on a turned page read upright (r)", () => {
  it("a text box: r = the page's turn, w/h swapped, left edge at the click on screen; its editor turns too", async () => {
    await mount(turned());
    kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
    await kit.flush();
    kit.pointer("pointerdown", 100, 400);
    const fo = svgOf("P1").querySelector(".pdfmk-live foreignObject")!;
    expect(fo.getAttribute("transform")).toBe("rotate(-90 100 300)");
    expect(fo.getAttribute("width")).toBe("200");
    const ed = fo.querySelector(".pdfmk-text-edit")!;
    ed.textContent = "Hello";
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(marks()[0]).toMatchObject({ t: "text", text: "Hello", r: 90, x: 88, y: 200, w: 24, h: 200 });
  });

  it("an unturned page's text box carries no r at all", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
    await kit.flush();
    kit.pointer("pointerdown", 100, 100);
    const ed = svgOf("P1").querySelector(".pdfmk-text-edit")!;
    ed.textContent = "Hi";
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect("r" in marks()[0]!).toBe(false);
    await kit.flush();
    expect(svgOf("P1").querySelector("foreignObject")!.getAttribute("transform")).toBeNull();
  });

  it("a signature: SIGNATURE_W wide ON SCREEN, so its page box is tall", async () => {
    settingsStore.set({ ...settingsStore.get(), pdfSignatures: [sig] });
    await mount(turned());
    toolbarButtons().find((b) => b.getAttribute("aria-label") === "Signature")!.click();
    kit.doc.body.querySelector(".pdfmk-sigmenu__pick")!.click();
    await kit.flush();
    kit.pointer("pointerdown", 300, 300);
    expect(marks()[0]).toMatchObject({ t: "signature", r: 90, x: 260, y: 220, w: 80, h: 160 });
  });

  it("a picture: fits half the page AS SHOWN, upright", async () => {
    await mount(turned());
    const info: MediaInfo = { path: "C:\\p.png", size: 5, mtimeMs: 6, kind: "image", duration: 0, width: 400, height: 200, hasAudio: false };
    const ok = await insertPicture(kit.ctx, { infoAsync: async () => ({ w: 600, h: 800, rot: 90 }) } as never, () => "P1", () => true, {
      pick: async () => "C:\\p.png",
      probe: async () => info,
    });
    expect(ok).toBe(true);
    expect(marks()[0]).toMatchObject({ t: "image", r: 90, x: 200, y: 200, w: 200, h: 400 });
  });

  it("a growing text box on a turned page grows its page w (down on screen), wrapping to its h", async () => {
    await mount(turned({ P1: [text({ x: 100, y: 100, w: 15, h: 200, r: 90, text: "hi" })] }));
    kit.pointer("dblclick", 105, 150);
    const ed = svgOf("P1").querySelector(".pdfmk-text-edit")!;
    ed.textContent = "one\ntwo";
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    // two lines of 12 pt = 30 pt down the screen = page +x on a 90° page
    expect(marks()[0]).toMatchObject({ text: "one\ntwo", x: 100, y: 100, w: 30, h: 200 });
  });
});

describe("the inspector", () => {
  it("Width changes stroke widths only: a selected text box keeps its box width", async () => {
    await mount(project({ P1: [ink, text()] }), true);
    await select("i", "t");
    const range = byLabel("input", "Width in points");
    range.value = "10";
    fire(range, "input");
    fire(range, "change");
    expect((marks()[0] as Extract<PdfAnnot, { t: "ink" }>).w).toBe(10);
    expect((marks()[1] as Text).w).toBe(200);
  });

  it("a font-size drag up and back down leaves the box as tall as the final size needs", async () => {
    await mount(project({ P1: [text()] }), true);
    await select("t");
    const range = byLabel("input", "Font size in points");
    fire(range, "pointerdown");
    range.value = "40";
    fire(range, "input");
    expect((marks()[0] as Text).h).toBe(50);
    range.value = "12";
    fire(range, "input");
    fire(range, "pointerup");
    fire(range, "change");
    expect(marks()[0]).toMatchObject({ size: 12, h: 15 });
  });

  it("Impact: Bold and Italic are off and disabled (the export has only its regular face)", async () => {
    await mount(project({ P1: [text({ font: "Impact", bold: true })] }), true);
    await select("t");
    const b = inspector().querySelectorAll("button").find((x) => x.getAttribute("aria-label") === "Bold")!;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-pressed")).toBe("false");
    const font = byLabel("select", "Font");
    font.value = "Arial";
    fire(font, "change");
    await kit.flush();
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the keyboard", () => {
  it("arrows on a focused slider (or any form control) leave the selection where it is", async () => {
    await mount(project({ P1: [white("a", 100, 100, 50, 50)] }));
    await select("a");
    const range = new FakeElement("input");
    range.type = "range";
    kit.doc.body.appendChild(range);
    range.focus();
    kit.keydown("ArrowRight");
    const btn = new FakeElement("button");
    kit.doc.body.appendChild(btn);
    btn.focus();
    kit.keydown("ArrowDown");
    expect(marks()[0]).toMatchObject({ x: 100, y: 100 });
    expect(kit.session.steps).toBe(0);
  });

  it("arrows do nothing to marks while a modal dialog is open", async () => {
    await mount(project({ P1: [white("a", 100, 100, 50, 50)] }));
    await select("a");
    const backdrop = new FakeElement("div");
    backdrop.className = "modal-backdrop";
    kit.doc.body.appendChild(backdrop);
    kit.keydown("ArrowLeft");
    expect(kit.session.steps).toBe(0);
    backdrop.remove();
    kit.keydown("ArrowLeft");
    expect(marks()[0]).toMatchObject({ x: 99, y: 100 });
  });

  it("arrows move the selection in SCREEN directions on a turned page", async () => {
    await mount(turned({ P1: [white("a", 100, 100, 50, 50)] }));
    await select("a");
    // right on screen = page −y on a page turned 90° clockwise
    kit.keydown("ArrowRight");
    expect(marks()[0]).toMatchObject({ x: 100, y: 99 });
    // down on screen = page +x
    kit.keydown("ArrowDown");
    expect(marks()[0]).toMatchObject({ x: 101, y: 99 });
  });
});

describe("select: moves and resizes", () => {
  it("a move writes the project at most once per frame, and the release lands the last position", async () => {
    await mount(project({ P1: [white("a", 100, 100, 100, 50)] }));
    kit.pointer("pointerdown", 150, 120);
    const r0 = kit.session.replaces;
    for (const x of [160, 170, 180, 190]) kit.pointer("pointermove", x, 120);
    expect(kit.session.replaces - r0).toBe(0);
    kit.runFrames();
    expect(kit.session.replaces - r0).toBe(1);
    expect(marks()[0]).toMatchObject({ x: 140 });
    kit.pointer("pointermove", 200, 130);
    kit.pointer("pointerup", 210, 140);
    kit.runFrames();
    expect(marks()[0]).toMatchObject({ x: 160, y: 120 });
    expect(kit.session.steps).toBe(1);
  });

  it("a cancelled move or resize leaves the project unedited", async () => {
    await mount(project({ P1: [white("a", 100, 100, 100, 50)] }));
    kit.pointer("pointerdown", 150, 120);
    kit.pointer("pointermove", 180, 140);
    kit.runFrames();
    expect(marks()[0]).toMatchObject({ x: 130 });
    kit.pointer("pointercancel", 180, 140);
    expect(marks()[0]).toMatchObject({ x: 100, y: 100 });
    // the se handle sits at (200, 150)
    kit.pointer("pointerdown", 200, 150);
    kit.pointer("pointermove", 260, 200);
    kit.runFrames();
    expect(marks()[0]).toMatchObject({ w: 160 });
    kit.pointer("pointercancel", 260, 200);
    expect(marks()[0]).toMatchObject({ w: 100, h: 50 });
    expect(kit.session.steps).toBe(0);
    expect(kit.session.edited).toBe(false);
  });

  it("the layer keeps a mark's node while only other marks change", async () => {
    await mount(project({ P1: [white("a", 10, 10, 20, 20), white("b", 50, 50, 20, 20)] }));
    const nodeOf = (id: string): FakeElement => svgOf("P1").querySelectorAll("[data-id]").find((n) => n.getAttribute("data-id") === id)!;
    const a = nodeOf("a");
    const b = nodeOf("b");
    await select("b");
    kit.keydown("ArrowRight");
    await kit.flush();
    expect(nodeOf("a")).toBe(a);
    expect(nodeOf("b")).not.toBe(b);
    expect(nodeOf("b").getAttribute("x")).toBe("51");
    expect(svgOf("P1").querySelectorAll("[data-id]").map((n) => n.getAttribute("data-id"))).toEqual(["a", "b"]);
  });
});

describe("refusals and limits", () => {
  it("a full page refuses a new stroke, shape or box with a message", async () => {
    const full = Array.from({ length: PDF_MAX_ANNOTS_PER_PAGE }, (_, i) => white(`w${i}`, 1, 1, 1, 1));
    await mount(project({ P1: full }));
    for (const tool of ["pen", "shape", "whiteout"] as const) {
      kit.ctx.tools.update((s) => ({ ...s, tool }));
      await kit.flush();
      kit.pointer("pointerdown", 300, 300);
      kit.pointer("pointermove", 400, 400);
      kit.pointer("pointerup", 400, 400);
    }
    expect(kit.session.steps).toBe(0);
    expect(toasts).toEqual(Array(3).fill("refuse:This page has the most marks a page can hold."));
  });

  it("a tall signature is scaled down (aspect kept) to fit the page and kept on it", () => {
    const page = { w: 612, h: 792, rot: 0 as const };
    const b = signatureBox(page, 600, 10, 0.1);
    expect(b.h).toBeCloseTo(792, 6);
    expect(b.w / b.h).toBeCloseTo(0.1, 6);
    expect(b.y).toBe(0);
    expect(b.x + b.w).toBeLessThanOrEqual(612);
    expect("r" in b).toBe(false);
    // on a turned page the fit is against the page AS SHOWN (792 wide on screen)
    const t = signatureBox({ ...page, rot: 90 }, 300, 300, 20);
    expect(t).toMatchObject({ w: 8, h: 160, r: 90 });
  });

  it("the signature pad stops taking strokes at the most Settings keeps", async () => {
    await mount();
    toolbarButtons().find((b) => b.getAttribute("aria-label") === "Signature")!.click();
    kit.doc.body.querySelector(".pdfmk-sigmenu")!.querySelectorAll("button").find((b) => b.textContent === "New signature")!.click();
    const modal = kit.doc.body.querySelector(".modal")!;
    const pad = modal.querySelector(".pdfmk-sigpad")!;
    const ev = (type: string, x: number): void => {
      pad.dispatchEvent(new FakeEvent(type, { clientX: x, clientY: 30, pointerId: 7, pointerType: "mouse", button: 0, pressure: 0.5, timeStamp: 0 }));
    };
    for (let i = 0; i <= SIGNATURE_STROKES_MAX; i++) {
      ev("pointerdown", 20);
      ev("pointerup", 40);
    }
    expect(pad.querySelector("g")!.children).toHaveLength(SIGNATURE_STROKES_MAX);
    expect(modal.querySelector(".pdfmk-sigpad__note")!.textContent).toBe(PAD_FULL_NOTE);
    modal.querySelectorAll("button").find((b) => b.textContent === "Cancel")!.click();
  });
});

describe("the text editor", () => {
  it("opening and closing an editor keeps a text's own trailing newline and adds no step", async () => {
    await mount(project({ P1: [text({ text: "hi\n", h: 30 })] }));
    kit.pointer("dblclick", 15, 15);
    const ed = svgOf("P1").querySelector(".pdfmk-text-edit")!;
    ed.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(kit.session.steps).toBe(0);
    expect((marks()[0] as Text).text).toBe("hi\n");
  });
});

describe("Fill forms mode", () => {
  it("hides the ruler while it lasts and shows it again after", async () => {
    await mount();
    kit.action("imgRuler");
    await kit.flush();
    expect(svgOf("P1").querySelector(".pdfmk-ruler")).not.toBeNull();
    kit.ctx.mode.set("forms");
    await kit.flush();
    expect(svgOf("P1").querySelector(".pdfmk-ruler")).toBeNull();
    expect(kit.ctx.tools.get().ruler).not.toBeNull();
    kit.ctx.mode.set("annotate");
    await kit.flush();
    expect(svgOf("P1").querySelector(".pdfmk-ruler")).not.toBeNull();
  });

  it("a picture chosen after Fill forms mode came on lands nothing", async () => {
    await mount();
    let choose: (p: string) => void = () => {};
    const job = insertPicture(kit.ctx, { infoAsync: async () => ({ w: 600, h: 800, rot: 0 }) } as never, () => "P1", () => true, {
      pick: () => new Promise((r) => (choose = r)),
      probe: async () => ({ path: "C:\\p.png", size: 5, mtimeMs: 6, kind: "image", duration: 0, width: 400, height: 200, hasAudio: false }),
    });
    kit.ctx.mode.set("forms");
    choose("C:\\p.png");
    expect(await job).toBe(false);
    expect(kit.session.steps).toBe(0);
    expect(marks()).toHaveLength(0);
  });
});
