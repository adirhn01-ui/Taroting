import { describe, expect, it, vi } from "vitest";
import { Store } from "../core/store";
import { createBlankImageProject } from "../core/image-project";
import type { ProjectFile } from "../core/types";

// The Canvas menu's rows: what they are called, that each is ONE commit of a
// whole-canvas operation, and that a crop in progress greys them all.
const crop = vi.hoisted(() => ({ starts: 0 }));
const dialog = vi.hoisted(() => ({ opens: 0 }));
const menu = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../ui/menu", () => ({
  showMenu: (...args: unknown[]) => void menu.calls.push(args),
}));
vi.mock("./crop-image", () => ({
  startImageCrop: () => {
    crop.starts++;
    return () => {};
  },
}));
vi.mock("./canvas-size-dialog", () => ({
  openCanvasSizeDialog: () => {
    dialog.opens++;
  },
}));

const { imageMenuItems, openImageMenu } = await import("./image-menu");

function ctxOn(mode: "idle" | "crop-image" | "crop-layer") {
  // 641×361: a rotate that did nothing (or turned the wrong way twice) cannot
  // land on the same numbers.
  let project: ProjectFile = createBlankImageProject("m", 641, 361, "#ffffff");
  const commits: ProjectFile[] = [];
  const ctx = {
    mode: new Store(mode),
    session: {
      get project() {
        return project;
      },
      commit(fn: (p: ProjectFile) => ProjectFile) {
        commits.push(project);
        project = fn(project);
      },
    },
  };
  return { ctx: ctx as never, commits, now: () => project };
}

describe("the Canvas menu", () => {
  it("names every row for the canvas it acts on", () => {
    const { ctx } = ctxOn("idle");
    expect(imageMenuItems(ctx).map((i) => i.label)).toEqual([
      "Crop canvas",
      "Resize canvas",
      "Rotate canvas left",
      "Rotate canvas right",
      "Flip canvas horizontally",
      "Flip canvas vertically",
    ]);
  });

  it("each row does its own thing, rotates and flips in ONE commit each", () => {
    const t = ctxOn("idle");
    const rows = new Map(imageMenuItems(t.ctx).map((i) => [i.label, i]));
    rows.get("Crop canvas")!.onSelect();
    expect(crop.starts).toBe(1);
    rows.get("Resize canvas")!.onSelect();
    expect(dialog.opens).toBe(1);
    expect(t.commits).toHaveLength(0);

    rows.get("Rotate canvas right")!.onSelect();
    expect(t.commits).toHaveLength(1);
    expect([t.now().timeline.width, t.now().timeline.height]).toEqual([361, 641]);
    rows.get("Rotate canvas left")!.onSelect();
    expect(t.commits).toHaveLength(2);
    expect([t.now().timeline.width, t.now().timeline.height]).toEqual([641, 361]);
    rows.get("Flip canvas horizontally")!.onSelect();
    rows.get("Flip canvas vertically")!.onSelect();
    expect(t.commits).toHaveLength(4);
  });

  it("greys every row while a crop is open, and says why", () => {
    for (const mode of ["crop-image", "crop-layer"] as const) {
      const items = imageMenuItems(ctxOn(mode).ctx);
      expect(items.every((i) => i.disabled === true && i.title === "Finish the crop first."), mode).toBe(true);
    }
    expect(imageMenuItems(ctxOn("idle").ctx).some((i) => i.disabled)).toBe(false);
  });
});

describe("opening the Canvas menu", () => {
  // The button sits at the window's bottom: the menu anchors under it, or
  // flips above its top. Numbers that differ on every axis.
  const anchor = { getBoundingClientRect: () => ({ left: 37, top: 590, bottom: 616 }) } as unknown as HTMLElement;

  it("a keyboard activation starts on the first row; a pointer one does not", () => {
    menu.calls = [];
    openImageMenu(anchor, ctxOn("idle").ctx, true);
    openImageMenu(anchor, ctxOn("idle").ctx, false);
    openImageMenu(anchor, ctxOn("idle").ctx);
    expect(menu.calls.map((c) => [c[0], c[1], c[3], c[4]])).toEqual([
      [37, 620, 586, true],
      [37, 620, 586, false],
      [37, 620, 586, false],
    ]);
    expect((menu.calls[0]![2] as { label: string }[]).map((i) => i.label)[0]).toBe("Crop canvas");
  });
});
