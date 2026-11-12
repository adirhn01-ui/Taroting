import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef, PdfAnnot, ProjectFile } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { encodePoints } from "../../../image/strokes";
import { pageAnnots, rotatePages } from "../../model";
import { FakeElement, makeKit, project, type Kit } from "./testkit.test-util";

// A page picture (0.9.5, `bg`) in the editor: painted under every other mark
// whatever its place in the list, and never hit by Select (click, marquee) or
// the eraser — it is the page.

vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {} } }));

const { settingsStore } = await import("../../../core/session");
const { toolsPart } = await import("../tools");

const media: MediaRef = { id: "m1", path: "C:\\p\\scan.jpg", size: 1, mtimeMs: 2, kind: "image", duration: 0, width: 600, height: 400, hasAudio: false };
/** The page picture covers the whole of P1 (612 × 792). */
const bg: PdfAnnot = { id: "bg", t: "image", x: 0, y: 0, w: 612, h: 792, media: "m1", bg: true };
const white = (id: string, x: number, y: number, w: number, h: number): PdfAnnot => ({ id, t: "whiteout", x, y, w, h, c: "#ffffff" });
const ink = (id: string, pts: number[]): PdfAnnot => ({ id, t: "ink", kind: "pen", c: "#000000", w: 4, o: 1, p: encodePoints(new Float32Array(pts)) });

let kit: Kit;
let part: { dispose(): void };

async function mount(marks: PdfAnnot[]): Promise<void> {
  const p: ProjectFile = { ...project({ P1: marks }), media: [media] };
  kit = makeKit(p);
  part = toolsPart(kit.ctx, kit.hosts);
  await kit.flush();
}
const marks = (): readonly PdfAnnot[] => pageAnnots(kit.session.project, "P1");
const svgOf = (key: string): FakeElement | null => (kit.view.overlay(key) as unknown as FakeElement).querySelector("svg");

beforeEach(() => {
  settingsStore.set({ ...DEFAULT_SETTINGS, pdfSignatures: [] });
});
afterEach(() => {
  part?.dispose();
  vi.unstubAllGlobals();
});

describe("a page picture in the editor", () => {
  it("is painted first, under a mark listed before it", async () => {
    // listed LAST: the list order would put it on top
    await mount([white("w", 100, 100, 50, 50), bg]);
    const drawn = svgOf("P1")!.querySelectorAll("[data-id]").map((n) => n.getAttribute("data-id"));
    expect(drawn).toEqual(["bg", "w"]);
    expect(svgOf("P1")!.querySelector("image[data-id]")!.getAttribute("width")).toBe("612");
  });

  it("a Select click on it selects nothing; on a mark over it, that mark", async () => {
    await mount([bg, white("w", 100, 100, 50, 50)]);
    kit.pointer("pointerdown", 400, 500);
    kit.pointer("pointerup", 400, 500);
    expect(kit.ctx.selection.get()).toEqual([]);
    kit.pointer("pointerdown", 120, 120);
    kit.pointer("pointerup", 120, 120);
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "w" }]);
    expect(kit.session.steps).toBe(0);
  });

  it("on a page turned 90°: still painted first, inside the turned group; a Select click passes through it to the mark over it", async () => {
    // a picture NOT the whole page, listed last, on P1 shown turned right
    const part2: PdfAnnot = { ...bg, x: 30, y: 60, w: 500, h: 300 };
    const p0: ProjectFile = { ...project({ P1: [white("w", 100, 300, 50, 50), part2] }), media: [media] };
    kit = makeKit(rotatePages(p0, ["P1"], 90));
    part = toolsPart(kit.ctx, kit.hosts);
    await kit.flush();
    const svg = svgOf("P1")!;
    const g = svg.querySelector("g")!;
    expect(g.getAttribute("transform")).toBe("matrix(0 1 -1 0 792 0)");
    expect(g.querySelectorAll("[data-id]").map((n) => n.getAttribute("data-id"))).toEqual(["bg", "w"]);
    const img = g.querySelector("image[data-id]")!;
    expect([img.getAttribute("x"), img.getAttribute("y"), img.getAttribute("width"), img.getAttribute("height")]).toEqual(["30", "60", "500", "300"]);
    // (the test view hands the layer page points: the real view unturns the
    // screen point before the layer sees it)
    // on the picture only → nothing
    kit.pointer("pointerdown", 300, 200);
    kit.pointer("pointerup", 300, 200);
    expect(kit.ctx.selection.get()).toEqual([]);
    // on the whiteout over it → the whiteout
    kit.pointer("pointerdown", 120, 320);
    kit.pointer("pointerup", 120, 320);
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "w" }]);
    expect(kit.session.steps).toBe(0);
  });

  it("a marquee across it selects only the marks on it", async () => {
    await mount([bg, white("w", 100, 100, 50, 50)]);
    kit.pointer("pointerdown", 50, 50);
    kit.pointer("pointermove", 250, 250);
    kit.pointer("pointerup", 300, 300);
    expect(kit.ctx.selection.get()).toEqual([{ key: "P1", id: "w" }]);
  });

  it("the eraser passes over it and takes the ink", async () => {
    await mount([bg, ink("a", [100, 100, 1, 200, 100, 1])]);
    kit.ctx.tools.update((s) => ({ ...s, tool: "eraser" }));
    await kit.flush();
    kit.pointer("pointerdown", 150, 80);
    kit.pointer("pointermove", 150, 120);
    kit.pointer("pointerup", 150, 130);
    expect(marks().map((a) => a.id)).toEqual(["bg"]);
    expect(kit.session.steps).toBe(1);
  });
});
