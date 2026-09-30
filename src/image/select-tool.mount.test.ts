import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../core/types";
import { Store } from "../core/store";
import { shortcutsBlocked } from "../core/shortcuts";
import { createBlankImageProject } from "../core/image-project";
import { addGeneratorLayer, findLayer } from "./layers";
import { createToolStore } from "./tool-state";

// The select tool's event handling, mounted against a small fake DOM (vitest
// runs in node). Canvas 640×360 with one 200×100 solid centred on it, and a
// view whose client px == canvas px, so a press at (320, 180) lands on the
// layer and one at (5, 5) lands outside it.

vi.mock("../editor/media/generators", () => ({ fontString: () => "12px sans-serif" }));

const { mountSelectTool } = await import("./select-tool");

type Handler = (e: unknown) => void;

class Listeners {
  private map = new Map<string, Set<Handler>>();
  addEventListener(t: string, fn: Handler): void {
    if (!this.map.has(t)) this.map.set(t, new Set());
    this.map.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.map.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown): void {
    for (const fn of [...(this.map.get(t) ?? [])]) fn(e);
  }
  count(t: string): number {
    return this.map.get(t)?.size ?? 0;
  }
}

class El extends Listeners {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  cls = new Set<string>();
  attrs = new Map<string, string>();
  type = "";
  textContent = "";
  isContentEditable = false;
  width = 0;
  height = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 800;
  clientHeight = 600;
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this.cls = new Set(v.split(" ").filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  classList = {
    add: (c: string) => void this.cls.add(c),
    remove: (c: string) => void this.cls.delete(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.cls.has(c);
      if (want) this.cls.add(c);
      else this.cls.delete(c);
      return want;
    },
    contains: (c: string) => this.cls.has(c),
  };
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
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
  private matches(sel: string): boolean {
    if (sel.startsWith(".")) return this.cls.has(sel.slice(1));
    const attr = /^\[(\w+)='([^']*)'\]$/.exec(sel);
    if (attr) return this.attrs.get(attr[1]!) === attr[2];
    return this.tagName === sel.toUpperCase();
  }
  closest(sel: string): El | null {
    const parts = sel.split(",").map((s) => s.trim());
    for (let n: El | null = this; n; n = n.parentNode) if (parts.some((p) => n!.matches(p))) return n;
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getContext(): null {
    return null;
  }
  find(pred: (e: El) => boolean): El | undefined {
    for (const c of this.children) {
      if (pred(c)) return c;
      const d = c.find(pred);
      if (d) return d;
    }
    return undefined;
  }
}
class CanvasEl extends El {}

let win: Listeners;
let doc: Listeners;
// Disposed after every test, pass or fail: the shortcut block is a module
// counter, and a drag left armed by a failed assertion would leak into the
// next test.
let mounted: { dispose(): void }[] = [];

beforeEach(() => {
  win = new Listeners();
  doc = new Listeners();
  vi.stubGlobal("Element", El);
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("HTMLCanvasElement", CanvasEl);
  vi.stubGlobal("document", {
    createElement: (t: string) => (t === "canvas" ? new CanvasEl(t) : new El(t)),
    querySelector: () => null,
    addEventListener: (t: string, fn: Handler) => doc.addEventListener(t, fn),
    removeEventListener: (t: string, fn: Handler) => doc.removeEventListener(t, fn),
  });
  vi.stubGlobal("window", {
    addEventListener: (t: string, fn: Handler) => win.addEventListener(t, fn),
    removeEventListener: (t: string, fn: Handler) => win.removeEventListener(t, fn),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    devicePixelRatio: 1,
  });
});
afterEach(() => {
  for (const h of mounted) h.dispose();
  mounted = [];
  vi.unstubAllGlobals();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mount() {
  const base = createBlankImageProject("t", 640, 360, "#ffffff");
  const added = addGeneratorLayer(base, { type: "solid", color: "#ff0000" }, 200, 100, "Solid");
  const id = added.trackId;
  const store = new Store<ProjectFile>(added.project);
  const commits: ProjectFile[] = [];
  const session = {
    store,
    get project() {
      return store.get();
    },
    replace(p: ProjectFile) {
      store.set(p);
    },
    commitFrom(before: ProjectFile) {
      commits.push(before);
    },
  };
  const tools = createToolStore();
  tools.set({ ...tools.get(), tool: "select" });
  const stage = new El("div");
  const canvas = new CanvasEl("canvas");
  stage.appendChild(canvas);
  const mode = new Store<"idle" | "crop-image" | "crop-layer">("idle");
  const ctx = {
    session,
    tools,
    selection: new Store<string | null>(id),
    mode,
    stage,
    view: {
      store: new Store({ zoom: 1, panX: 0, panY: 0, dpr: 1, stageW: 800, stageH: 600 }),
      canvasToClient: (x: number, y: number) => ({ x, y }),
      clientToCanvas: (x: number, y: number) => ({ x, y }),
      panning: false,
    },
    res: { photo: () => null, onChange: () => () => {} },
    requestRender: () => {},
    holdAutosave: () => () => {},
    registerOverlay: () => () => {},
  };
  const handle = mountSelectTool(ctx as never);
  mounted.push(handle);
  const overlay = stage.find((e) => e.cls.has("imged-select"))!;
  const bar = stage.find((e) => e.cls.has("imged-select__cropbar"))!;
  const cancelBtn = bar.find((e) => e.textContent === "Cancel")!;
  const x0 = () => findLayer(store.get(), id)!.transform.x;
  const press = (target: El, x: number, y: number) =>
    stage.fire("pointerdown", { target, button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
  const key = (k: string, target: unknown) => {
    const e = {
      key: k, target, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      defaultPrevented: false, preventDefault() {}, stopImmediatePropagation() {},
    };
    win.fire("keydown", e);
    doc.fire("keydown", e);
  };
  return { base: added.project, id, store, commits, mode, stage, canvas, overlay, bar, cancelBtn, x0, press, key, handle };
}

describe("select tool: a drag", () => {
  it("holds shortcuts from arming to release, and Escape still reverts it", async () => {
    const t = mount();
    t.press(t.canvas, 320, 180);
    expect(shortcutsBlocked()).toBe(false); // a plain press is not a drag yet
    win.fire("pointermove", { pointerId: 1, clientX: 360, clientY: 180 });
    // Armed: a Ctrl+Z now would be overwritten by the next move and then
    // recorded inside the drag's baseline.
    expect(shortcutsBlocked()).toBe(true);
    expect(t.x0()).toBe(40);
    t.key("Escape", t.stage);
    expect(shortcutsBlocked()).toBe(false);
    expect(t.store.get()).toBe(t.base);
    expect(t.commits).toEqual([]);

    t.press(t.canvas, 320, 180);
    win.fire("pointermove", { pointerId: 1, clientX: 330, clientY: 180 });
    expect(shortcutsBlocked()).toBe(true);
    win.fire("pointerup", { pointerId: 1 });
    expect(shortcutsBlocked()).toBe(false);
    expect(t.commits).toEqual([t.base]);
    t.handle.dispose();
  });
});

describe("select tool: nudge", () => {
  it("commits a nudge run still open before a press starts a drag", async () => {
    const t = mount();
    t.key("ArrowRight", t.stage); // held: no keyup
    const nudged = t.store.get();
    expect(t.x0()).toBe(1);
    t.press(t.canvas, 320, 180);
    win.fire("pointermove", { pointerId: 1, clientX: 330, clientY: 180 });
    await flush();
    win.fire("pointerup", { pointerId: 1 });
    // Two undo steps, in order: the nudge from the start, then the drag.
    expect(t.commits).toEqual([t.base, nudged]);
    t.handle.dispose();
  });

  it("a save's restamp mid-run keeps the run's undo step", async () => {
    // Ctrl+S (or the Temporary badge's Keep) while an arrow is held.
    const t = mount();
    t.key("ArrowRight", t.stage);
    t.store.set({ ...t.store.get(), modifiedAt: "2026-09-29T12:00:00.000Z" });
    await flush();
    t.key("ArrowRight", t.stage);
    doc.fire("keyup", { key: "ArrowRight" });
    expect(t.x0()).toBe(2);
    expect(t.commits).toEqual([t.base]);
    t.handle.dispose();
  });

  it("leaves arrows on a focused range input or anything in the inspector alone", () => {
    const t = mount();
    const range = new El("input");
    range.type = "range";
    t.key("ArrowRight", range);
    const inspector = new El("div");
    inspector.className = "inspector";
    const btn = new El("button");
    inspector.appendChild(btn);
    t.key("ArrowRight", btn);
    expect(t.store.get()).toBe(t.base);
    // Control: the same key on the stage does nudge.
    t.key("ArrowRight", t.stage);
    expect(t.x0()).toBe(1);
    t.handle.dispose();
  });
});

describe("select tool: per-layer crop", () => {
  function crop() {
    const t = mount();
    t.stage.fire("dblclick", { target: t.canvas, clientX: 320, clientY: 180 });
    expect(t.mode.get()).toBe("crop-layer");
    return t;
  }

  it("Enter on the focused Cancel button is the button's, not Apply", () => {
    const t = crop();
    t.key("Enter", t.cancelBtn);
    expect(t.mode.get()).toBe("crop-layer");
    expect(t.commits).toEqual([]);
    t.cancelBtn.fire("click", {});
    expect(t.mode.get()).toBe("idle");
    expect(t.commits).toEqual([]);
    // Control: Enter with nothing focused applies (a real crop: an untouched
    // one lands no step, as ProjectSession.commitFrom would not either).
    const u = crop();
    dragIn(u);
    u.key("Enter", u.stage);
    expect(u.mode.get()).toBe("idle");
    expect(u.commits).toEqual([u.base]);
    t.handle.dispose();
    u.handle.dispose();
  });

  it("a press from another stage widget (the ruler) never ends or pans the crop", () => {
    const t = crop();
    const ruler = new El("div");
    t.stage.appendChild(ruler);
    // (5, 5) is outside the whole source: from the crop chrome it applies.
    t.press(ruler, 5, 5);
    expect(t.mode.get()).toBe("crop-layer");
    expect(win.count("pointermove")).toBe(0);
    t.press(t.overlay, 5, 5);
    expect(t.mode.get()).toBe("idle");
    t.handle.dispose();
  });

  /** Drag the crop window's south-east handle 20×10 canvas px inward. */
  function dragIn(t: ReturnType<typeof crop>) {
    const se = t.stage.find((e) => e.dataset.crophandle === "se")!;
    t.press(se, 420, 230);
    win.fire("pointermove", { pointerId: 1, clientX: 400, clientY: 220 });
    win.fire("pointerup", { pointerId: 1 });
    const l = findLayer(t.store.get(), t.id)!;
    expect(l.transform.crop).toBeDefined(); // the drag really wrote a crop
    return t.store.get();
  }

  it("a save's restamp mid-crop is not someone else's edit: Apply is still one step", async () => {
    // Autosave, Ctrl+S, or Keep on the Temporary badge (no hold defers those).
    const t = crop();
    const cropped = dragIn(t);
    t.store.set({ ...cropped, modifiedAt: "2026-09-29T12:00:00.000Z" });
    await flush();
    expect(t.mode.get()).toBe("crop-layer");
    t.key("Enter", t.stage);
    expect(t.mode.get()).toBe("idle");
    expect(t.commits).toEqual([t.base]);
    t.handle.dispose();
  });

  it("a crop left untouched through a restamp applies as no step", async () => {
    const t = crop();
    t.store.set({ ...t.store.get(), modifiedAt: "2026-09-29T12:00:00.000Z" });
    await flush();
    t.key("Enter", t.stage);
    expect(t.mode.get()).toBe("idle");
    expect(t.commits).toEqual([]);
    t.handle.dispose();
  });

  it("revertCrop (the window is closing) puts the layer back at once, with no step", () => {
    const t = crop();
    dragIn(t);
    t.handle.revertCrop();
    // Synchronous: the close flow's save reads the store right after.
    expect(t.store.get()).toBe(t.base);
    expect(t.commits).toEqual([]);
    expect(shortcutsBlocked()).toBe(false);
    t.handle.dispose();
  });
});
