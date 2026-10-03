import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../core/types";
import { Store } from "../core/store";
import { createPhotoImageProject } from "../core/image-project";
import type { Stroke } from "../core/types";
import { addDrawingLayer, addGeneratorLayer, appendStrokeTo, layersOf, setLayerAdjust, setLayerTransform } from "./layers";

// The Layers panel mounted against a small fake DOM (vitest runs in node):
// what it asks the preview resources for, the generator dialog's overlay
// entry, and a row drag that loses the window.

const menu = vi.hoisted(() => ({ items: [] as { label: string; onSelect: () => void }[] }));
const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[], refuse: [] as string[] }));
/** The picker and the probe, held open by the test (a slow PC's window). */
const io = vi.hoisted(() => ({
  pick: null as null | (() => Promise<string | null>),
  probe: null as null | ((path: string) => Promise<unknown>),
}));
const gen = vi.hoisted(() => ({
  opts: null as null | {
    onCreate: (g: unknown, w: number, h: number, label: string) => void;
    onClose?: () => void;
  },
  closer: () => {},
}));
vi.mock("../ui/menu", () => ({
  showMenu: (_x: number, _y: number, items: { label: string; onSelect: () => void }[]) => {
    menu.items = items;
  },
  closeMenu: () => {},
}));
vi.mock("../editor/media/generators", () => ({
  openGeneratorDialog: (_kind: string, opts: typeof gen.opts) => {
    gen.opts = opts;
    return gen.closer;
  },
}));
vi.mock("../ui/toast", () => ({
  toast: {
    error: (m: string) => void toasts.error.push(m),
    info: (m: string) => void toasts.info.push(m),
    refuse: (m: string) => void toasts.refuse.push(m),
  },
}));
vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...real,
    pickImageFile: () => (io.pick ? io.pick() : Promise.resolve(null)),
    ipc: { ...real.ipc, probeMedia: (path: string) => (io.probe ? io.probe(path) : Promise.reject(new Error("no probe"))) },
  };
});
// The drawing caps, shrunk so Duplicate can be refused with a few strokes
// (strokes.test.ts pins the real numbers).
vi.mock("./strokes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./strokes")>()),
  MAX_TOTAL_STROKES: 3,
}));
vi.mock("./icons", () => ({ imgIcon: (n: string) => `<svg data-i="${n}"></svg>` }));
vi.mock("../ui/icons", () => ({ icon: (n: string) => `<svg data-i="${n}"></svg>` }));
vi.mock("./render/export", () => ({ maxRenderSize: (w: number, h: number) => ({ w, h, reduced: false }) }));

const { mountLayersPanel } = await import("./layers-panel");

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
}

class El extends Listeners {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  cls = new Set<string>();
  attrs = new Map<string, string>();
  innerHTML = "";
  textContent = "";
  title = "";
  hidden = false;
  inert = false;
  tabIndex = -1;
  id = "";
  type = "";
  width = 0;
  height = 0;
  scrollTop = 0;
  isContentEditable = false;
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
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]): void {
    for (const c of cs) this.appendChild(c);
  }
  insertBefore(c: El, ref: El | null): El {
    c.remove();
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  replaceChildren(...cs: El[]): void {
    for (const c of [...this.children]) c.remove();
    this.append(...cs);
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
    return this.tagName === sel.toUpperCase();
  }
  closest(sel: string): El | null {
    const parts = sel.split(",").map((s) => s.trim());
    for (let n: El | null = this; n; n = n.parentNode) if (parts.some((p) => n!.matches(p))) return n;
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  scrollIntoView(): void {}
  focus(): void {}
  blur(): void {}
  /** Each call is one thumbnail redraw attempt (drawPhotoThumb asks for its
   *  context first); null keeps the draw itself out of the node env. */
  contextCalls = 0;
  getContext(): null {
    this.contextCalls++;
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

let win: Listeners;

beforeEach(() => {
  win = new Listeners();
  menu.items = [];
  gen.opts = null;
  toasts.info = [];
  toasts.error = [];
  toasts.refuse = [];
  io.pick = null;
  io.probe = null;
  vi.stubGlobal("Element", El);
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("document", {
    createElement: (t: string) => new El(t),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("window", {
    addEventListener: (t: string, fn: Handler) => win.addEventListener(t, fn),
    removeEventListener: (t: string, fn: Handler) => win.removeEventListener(t, fn),
    devicePixelRatio: 1,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const ADJUST = {
  exposure: 20, brightness: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, hue: 0, warmth: 0, tint: 0,
};

function mount(zoom: number) {
  let p = createPhotoImageProject("p", {
    path: "C:/p.png", size: 1, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 1000, height: 500,
  });
  const photoId = layersOf(p)[0]!.trackId;
  // Scale 0.5 at zoom `zoom`: the stage composite asks for 0.5·zoom. The old
  // thumbnail density (56/1000 at dpr 1) differs from it.
  p = setLayerTransform(p, photoId, { scale: 0.5 });
  const second = addGeneratorLayer(p, { type: "solid", color: "#00ff00" }, 50, 50, "Solid");
  p = second.project;
  const store = new Store<ProjectFile>(p);
  const session = {
    store,
    get project() {
      return store.get();
    },
    commit(fn: (p: ProjectFile) => ProjectFile) {
      store.set(fn(store.get()));
    },
  };
  const photoCalls: number[] = [];
  // ONE object for every call, as the real cache returns: it rewrites an
  // adjusted canvas in place, so identity says nothing about the pixels.
  const cachedPixels = { bitmap: true };
  let resChanged: () => void = () => {};
  const unregister = vi.fn();
  const selection = new Store<string | null>(null);
  const ctx = {
    session,
    selection,
    mode: new Store<"idle" | "crop-image" | "crop-layer">("idle"),
    view: { store: new Store({ zoom, panX: 0, panY: 0, dpr: 1, stageW: 800, stageH: 600 }) },
    res: {
      photo: (_l: unknown, density: number) => {
        photoCalls.push(density);
        return cachedPixels;
      },
      status: () => ({ state: "ready" }),
      onChange: (fn: () => void) => {
        resChanged = fn;
        return () => {};
      },
    },
    requestRender: () => {},
    registerOverlay: vi.fn(() => unregister),
  };
  const host = new El("div");
  const handle = mountLayersPanel(host as never, ctx as never);
  const list = host.find((e) => e.cls.has("imged-layer-list"))!;
  const row = (id: string) => list.find((e) => e.dataset.track === id)!;
  return {
    store, photoId, solidId: second.trackId, photoCalls, selection, ctx, unregister, host, list, row, handle,
    resChanged: () => resChanged(),
  };
}

describe("layers panel: photo thumbnails", () => {
  it("asks for the composite's density, and only when the thumbnail's inputs change", async () => {
    const t = mount(0.37);
    expect(t.photoCalls).toEqual([0.5 * 0.37]);

    // Every pointermove of a move or scale drag: the thumbnail does not
    // depend on x/y/scale, so the photo cache is not touched at all.
    t.store.set(setLayerTransform(t.store.get(), t.photoId, { x: 30, y: -4 }));
    await flush();
    t.store.set(setLayerTransform(t.store.get(), t.photoId, { scale: 0.6 }));
    await flush();
    t.store.set(setLayerTransform(t.store.get(), t.solidId, { x: 9 }));
    await flush();
    expect(t.photoCalls.length).toBe(1);

    // A decode or an adjustment landed: ask again (now at scale 0.6).
    t.resChanged();
    expect(t.photoCalls.length).toBe(2);
    expect(t.photoCalls[1]).toBeCloseTo(0.6 * 0.37, 12);

    // The thumbnail's own inputs: a crop, then an adjustment.
    t.store.set(setLayerTransform(t.store.get(), t.photoId, { crop: { x: 0, y: 0, w: 500, h: 500 } }));
    await flush();
    expect(t.photoCalls.length).toBe(3);
    t.store.set(setLayerAdjust(t.store.get(), t.photoId, ADJUST));
    await flush();
    expect(t.photoCalls.length).toBe(4);
    t.handle.dispose();
  });
});

describe("layers panel: adjusted photo thumbnails", () => {
  it("redraw on every adjustment even when the cache hands back the same canvas", async () => {
    // The photo cache rewrites its adjusted canvas IN PLACE while the level
    // size holds, so the panel keeps getting the SAME object with new pixels.
    // The fake cache returns one stable object, exactly that shape.
    const t = mount(0.37);
    const thumb = t.host.find((e) => e.cls.has("imged-layer__thumb"))!;
    const drawn = () => thumb.contextCalls;
    const before = drawn();
    t.store.set(setLayerAdjust(t.store.get(), t.photoId, ADJUST));
    await flush();
    const afterFirst = drawn();
    t.store.set(setLayerAdjust(t.store.get(), t.photoId, { ...ADJUST, brightness: 35 }));
    await flush();
    const afterSecond = drawn();
    t.resChanged();
    const afterRepaint = drawn();
    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(afterRepaint).toBeGreaterThan(afterSecond);
    t.handle.dispose();
  });
});

describe("layers panel: generator dialog", () => {
  // The dialog calls onCreate and THEN onClose on a create, and only onClose
  // on every other exit — so the overlay entry is dropped by onClose alone.
  it("drops the dialog's overlay entry when it creates", async () => {
    const t = mount(1);
    t.host.find((e) => e.id === "imged-add-layer")!.fire("click", {});
    menu.items.find((i) => i.label === "Solid color")!.onSelect();
    expect(t.ctx.registerOverlay).toHaveBeenCalledTimes(1);
    expect(t.unregister).not.toHaveBeenCalled();
    gen.opts!.onCreate({ type: "solid", color: "#123456" }, 40, 30, "Solid");
    expect(layersOf(t.store.get()).length).toBe(3);
    gen.opts!.onClose!();
    expect(t.unregister).toHaveBeenCalledTimes(1);
    t.handle.dispose();
  });

  it("drops the dialog's overlay entry when it is cancelled", async () => {
    const t = mount(1);
    t.host.find((e) => e.id === "imged-add-layer")!.fire("click", {});
    menu.items.find((i) => i.label === "Text")!.onSelect();
    expect(t.ctx.registerOverlay).toHaveBeenCalledTimes(1);
    gen.opts!.onClose!();
    expect(t.unregister).toHaveBeenCalledTimes(1);
    expect(layersOf(t.store.get()).length).toBe(2);
    t.handle.dispose();
  });
});

describe("layers panel: row drag", () => {
  it("a window blur ends the drag, so the next press is taken", async () => {
    const t = mount(1);
    const down = (id: string) =>
      t.list.fire("pointerdown", { button: 0, target: t.row(id), pointerId: 1, clientY: 0 });
    down(t.photoId);
    expect(t.selection.get()).toBe(t.photoId);
    win.fire("blur", {}); // Alt-Tab: no pointerup will ever come
    down(t.solidId);
    expect(t.selection.get()).toBe(t.solidId);
    t.handle.dispose();
  });
});

describe("layers panel: Add layer > Photo", () => {
  const still = {
    path: "C:/pics/later.png", size: 9, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 300, height: 201,
  };

  /** Opens Add layer > Photo with the probe held open; returns its release. */
  async function addWithProbeHeld(t: ReturnType<typeof mount>) {
    let release: (info: unknown) => void = () => {};
    io.pick = () => Promise.resolve("C:/pics/later.png");
    io.probe = () => new Promise((r) => (release = r));
    t.host.find((e) => e.id === "imged-add-layer")!.fire("click", {});
    const item = menu.items.find((i) => i.label === "Photo");
    expect(item, "the Add layer menu names photo layers Photo, as their rows do").toBeDefined();
    expect(menu.items.find((i) => i.label === "Image")).toBeUndefined();
    item!.onSelect();
    await flush();
    return (info: unknown) => release(info);
  }

  it("adds the photo above the selection when nothing opened meanwhile", async () => {
    const t = mount(1);
    const release = await addWithProbeHeld(t);
    release(still);
    await flush();
    expect(layersOf(t.store.get())).toHaveLength(3);
    expect(layersOf(t.store.get())[0]!.name).toBe("later");
    expect([toasts.info, toasts.refuse, toasts.error]).toEqual([[], [], []]);
    t.handle.dispose();
  });

  it("a crop begun during the probe refuses the add, and says what to finish", async () => {
    const t = mount(1);
    const release = await addWithProbeHeld(t);
    t.ctx.mode.set("crop-layer"); // the user started a crop while it probed
    const before = t.store.get();
    release(still);
    await flush();
    expect(t.store.get()).toBe(before);
    expect(toasts.info).toEqual(["Finish the crop first, then add the photo again."]);
    t.handle.dispose();
  });

  it("a probe that is not a still is refused, not recorded as a failure", async () => {
    const t = mount(1);
    const release = await addWithProbeHeld(t);
    release({ ...still, kind: "video", duration: 3 });
    await flush();
    expect(layersOf(t.store.get())).toHaveLength(2);
    expect(toasts.refuse).toEqual(["This isn't a still image."]);
    expect(toasts.error).toEqual([]);
    t.handle.dispose();
  });
});

describe("layers panel: Duplicate", () => {
  const pen = (x: number): Stroke => ({ t: "line", c: "#112233", w: 3, a: [x, 1], b: [x + 5, 9] });

  it("duplicates a layer in one step, selecting the copy", async () => {
    const t = mount(1);
    let p = t.store.get();
    const d = addDrawingLayer(p);
    p = appendStrokeTo(d.project, d.trackId, pen(4));
    t.store.set(p);
    await flush();
    t.list.fire("contextmenu", { target: t.row(d.trackId), clientX: 5, clientY: 5, preventDefault() {} });
    const dup = menu.items.find((i) => i.label === "Duplicate");
    expect(dup).toBeDefined();
    dup!.onSelect();
    expect(layersOf(t.store.get())).toHaveLength(4);
    expect(layersOf(t.store.get())[0]!.name).toBe("Drawing 1 copy");
    expect(toasts.refuse).toEqual([]);
    t.handle.dispose();
  });

  it("refuses out loud a drawing whose copy would pass the caps every save checks", async () => {
    const t = mount(1);
    const d = addDrawingLayer(t.store.get());
    const p = appendStrokeTo(appendStrokeTo(d.project, d.trackId, pen(4)), d.trackId, pen(20)); // 2 strokes; a copy makes 4 > 3
    t.store.set(p);
    await flush();
    t.list.fire("contextmenu", { target: t.row(d.trackId), clientX: 5, clientY: 5, preventDefault() {} });
    menu.items.find((i) => i.label === "Duplicate")!.onSelect();
    expect(t.store.get()).toBe(p);
    expect(toasts.refuse).toEqual(["This drawing is too large to duplicate."]);
    t.handle.dispose();
  });
});
