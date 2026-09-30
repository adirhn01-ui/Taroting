import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../core/store";
import { createBlankImageProject } from "../core/image-project";
import type { ProjectFile } from "../core/types";

// The canvas crop mounted against a small fake DOM (vitest runs in node):
// what its bar says, and that a drag inside the window moves it. The view is
// 1:1 (client px == canvas px) on a 641×361 canvas, so a drag's numbers are
// the crop's numbers.

const layers = vi.hoisted(() => ({ cropped: [] as unknown[] }));
vi.mock("./layers", () => ({
  cropImage: (p: unknown, r: unknown) => {
    layers.cropped.push(r);
    return p;
  },
}));

const { startImageCrop, cancelImageCrop } = await import("./crop-image");

type Handler = (e: unknown) => void;

class El {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  value = "";
  tabIndex = 0;
  offsetWidth = 200;
  offsetHeight = 34;
  private listeners = new Map<string, Set<Handler>>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e);
  }
  setAttribute(): void {}
  appendChild(c: El): El {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    if (!this.parentNode) return;
    const s = this.parentNode.children;
    s.splice(s.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  focus(): void {}
  setPointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  releasePointerCapture(): void {}
  find(pred: (e: El) => boolean): El | undefined {
    for (const c of this.children) {
      if (pred(c)) return c;
      const d = c.find(pred);
      if (d) return d;
    }
    return undefined;
  }
}

beforeEach(() => {
  layers.cropped = [];
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("document", {
    createElement: (t: string) => new El(t),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  cancelImageCrop();
  vi.unstubAllGlobals();
});

function open() {
  const store = new Store<ProjectFile>(createBlankImageProject("c", 641, 361, "#ffffff"));
  const commits: ProjectFile[] = [];
  const stage = new El("div");
  const ctx = {
    stage,
    mode: new Store<"idle" | "crop-image" | "crop-layer">("idle"),
    view: { store: new Store({ zoom: 1, panX: 0, panY: 0, dpr: 1, stageW: 800, stageH: 600 }) },
    session: {
      store,
      get project() {
        return store.get();
      },
      commit(fn: (p: ProjectFile) => ProjectFile) {
        commits.push(store.get());
        store.set(fn(store.get()));
      },
    },
    registerOverlay: () => () => {},
  };
  startImageCrop(ctx as never);
  const overlay = stage.find((e) => e.className.includes("imged-crop"))!;
  const bar = stage.find((e) => e.className === "imged-cropbar")!;
  const win = stage.find((e) => e.dataset.cropgrip === "move")!;
  const grip = (g: string) => stage.find((e) => e.dataset.cropgrip === g)!;
  const aspect = bar.find((e) => e.tagName === "SELECT")!;
  const apply = bar.find((e) => e.textContent === "Apply")!;
  let id = 0;
  /** Press `target`, move by (dx, dy) client px, release. */
  const drag = (target: El, x: number, y: number, dx: number, dy: number) => {
    const pointerId = ++id;
    overlay.fire("pointerdown", { target, button: 0, pointerId, clientX: x, clientY: y, preventDefault() {} });
    overlay.fire("pointermove", { pointerId, clientX: x + dx, clientY: y + dy });
    overlay.fire("pointerup", { pointerId });
  };
  const box = () => ({
    x: parseFloat(win.style.left!),
    y: parseFloat(win.style.top!),
    w: parseFloat(win.style.width!),
    h: parseFloat(win.style.height!),
  });
  return { ctx, commits, bar, win, grip, aspect, apply, drag, box };
}

describe("the canvas crop", () => {
  it("says on its bar that it crops the canvas", () => {
    const t = open();
    expect(t.ctx.mode.get()).toBe("crop-image");
    const label = t.bar.children[0]!;
    expect(label.className).toBe("imged-cropbar__label");
    expect(label.textContent).toBe("Crop canvas");
  });

  it("Free: a drag inside the window moves it, clamped to the canvas, and Apply crops there", () => {
    const t = open();
    expect(t.box()).toEqual({ x: 0, y: 0, w: 641, h: 361 });
    // Made smaller from the south-east corner first: a whole-canvas window
    // has nowhere to go.
    t.drag(t.grip("se"), 641, 361, -341, -161);
    expect(t.box()).toEqual({ x: 0, y: 0, w: 300, h: 200 });
    t.drag(t.win, 150, 100, 37, 23);
    expect(t.box()).toEqual({ x: 37, y: 23, w: 300, h: 200 });
    t.drag(t.win, 150, 100, 5000, 5000);
    expect(t.box()).toEqual({ x: 341, y: 161, w: 300, h: 200 });
    t.apply.fire("click", {});
    expect(layers.cropped).toEqual([{ x: 341, y: 161, w: 300, h: 200 }]);
    expect(t.commits).toHaveLength(1);
    expect(t.ctx.mode.get()).toBe("idle");
  });

  it("with a ratio: the centred window moves along its free axis, keeping its size", () => {
    const t = open();
    t.aspect.value = "1:1";
    t.aspect.fire("change", {});
    expect(t.box()).toEqual({ x: 140, y: 0, w: 361, h: 361 });
    t.drag(t.win, 300, 180, -95, 40);
    expect(t.box()).toEqual({ x: 45, y: 0, w: 361, h: 361 });
    t.drag(t.win, 300, 180, 9999, 0);
    expect(t.box()).toEqual({ x: 280, y: 0, w: 361, h: 361 });
  });
});
