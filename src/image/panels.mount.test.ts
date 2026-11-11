import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import { blockShortcuts } from "../core/shortcuts";
import type { ProjectFile } from "../core/types";

// The image editor's two side-panel toggles (0.9.4, the PDF editor's pair
// brought over): the shell mounted against a small fake DOM with its panels,
// tools, renderer and disk faked. Under test: the toggles' class / label /
// aria / title, the F4 / Shift+F4 bindings, the per-session memory across a
// remount, focus leaving a collapsing panel, an inspector popover put away on
// collapse, and nothing of it left behind by dispose.

const h = vi.hoisted(() => ({
  ctx: null as null | Record<string, unknown>,
  /** view.fit() calls: the shell must not add a fit path of its own */
  fits: 0,
}));

vi.mock("../fonts", () => ({
  ensureFonts: async () => {},
  fontsReady: () => true,
  missingFonts: () => [],
  onFontsChanged: () => () => {},
}));
vi.mock("../ui/toast", () => ({
  toast: { info: () => {}, notice: () => {}, error: () => {}, refuse: () => {} },
}));
vi.mock("../core/ipc", () => ({
  describeError: (e: unknown) => String(e),
  ipc: { listRecents: async () => ({ items: [] }), pathExists: async () => true, probeMedia: async () => ({}) },
  onDragDrop: async () => () => {},
}));
vi.mock("../core/nav", () => ({ exitDest: () => ({ view: "home" }), navigate: () => {} }));
vi.mock("../core/app-close", () => ({ registerBeforeClose: () => () => {}, registerCloseTask: () => () => {} }));
vi.mock("../ui/temp-project", () => ({
  createTempLeaveGate: () => ({}),
  createTempExits: () => ({ confirm: async () => true, confirmLeave: (d: () => void) => d(), keep: async () => "kept" }),
}));
vi.mock("../ui/menu", () => ({ closeMenu: () => {} }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../editor/media/relink", () => ({ openRelinkDialog: () => () => {}, isStillInfo: () => true }));
vi.mock("./copy", () => ({ copyImage: () => {} }));
vi.mock("./export-dialog", () => ({ openImageExportDialog: () => {} }));
vi.mock("./image-menu", () => ({ openImageMenu: () => {} }));
vi.mock("./crop-image", () => ({ cancelImageCrop: () => {} }));
vi.mock("./layers-panel", () => ({
  mountLayersPanel: (_el: unknown, ctx: Record<string, unknown>) => {
    h.ctx = ctx;
    return { dispose: () => {} };
  },
}));
vi.mock("./toolbar", () => ({ mountToolbar: () => ({ dispose: () => {} }) }));
vi.mock("./inspector", () => ({ mountImageInspector: () => ({ dispose: () => {}, dropPreview: () => {} }) }));
vi.mock("./select-tool", () => ({
  mountSelectTool: () => ({ dispose: () => {}, cropLayer: () => {}, revertCrop: () => {}, fontsChanged: () => {} }),
}));
vi.mock("./ink/ink", () => ({ mountInk: () => ({ dispose: () => {} }) }));
vi.mock("./view", async () => {
  const { Store } = await import("../core/store");
  return {
    zoomStep: (z: number) => z,
    createViewController: () => ({
      store: new Store({ zoom: 1, panX: 0, panY: 0, dpr: 1, stageW: 900, stageH: 500 }),
      fit: () => void h.fits++,
      actual: () => {},
      zoomAt: () => {},
      panBy: () => {},
      clientToCanvas: (x: number, y: number) => ({ x, y }),
      canvasToClient: (x: number, y: number) => ({ x, y }),
      panning: false,
      dispose: () => {},
    }),
  };
});
vi.mock("./render", () => ({
  renderComposite: () => {},
  PreviewResources: class {
    setView(): void {}
    onChange(): () => void {
      return () => {};
    }
    onMediaDims(): () => void {
      return () => {};
    }
    invalidate(): void {}
    blobFor(): null {
      return null;
    }
    dispose(): void {}
  },
}));
vi.mock("./render/export", () => ({ renderThumbnail: () => new Promise(() => {}) }));
vi.mock("./save", () => ({ saveBlob: async () => ({ path: "card.jpg" }) }));
vi.mock("../core/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/session")>();
  const { Store } = await import("../core/store");
  class FakeSession {
    readonly store: InstanceType<typeof Store<ProjectFile>>;
    readonly temp = new Store(false);
    readonly saveState = new Store<string>("saved");
    readonly history = { canUndo: false, canRedo: false };
    leaveGuard: unknown = null;
    blockLeave: unknown = null;
    constructor(
      readonly path: string,
      initial: ProjectFile,
    ) {
      this.store = new Store(initial);
    }
    get project(): ProjectFile {
      return this.store.get();
    }
    commit(fn: (p: ProjectFile) => ProjectFile): void {
      this.store.set(fn(this.store.get()));
    }
    commitFrom(): void {}
    replace(p: ProjectFile): void {
      this.store.set(p);
    }
    undo(): void {}
    redo(): void {}
    holdAutosave(): () => void {
      return () => {};
    }
    async save(): Promise<void> {}
    async dispose(): Promise<void> {}
  }
  return { ...real, ProjectSession: FakeSession };
});

const { mountImageEditor } = await import("./image-editor");
const { currentSession, settingsStore } = await import("../core/session");

/* ---------------- fake DOM ---------------- */

type Handler = (e: unknown) => void;

class Target {
  readonly listeners = new Map<string, Set<Handler>>();
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
  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

class FakeElement extends Target {}

let win: Target;
let doc: Target & { activeElement: unknown };

class El extends FakeElement {
  readonly tagName: string;
  isContentEditable = false;
  id = "";
  className = "";
  title = "";
  value = "";
  spellcheck = true;
  disabled = false;
  textContent = "";
  children: El[] = [];
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  classList = {
    toggle: (c: string, on?: boolean): boolean => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
    add: (...cs: string[]): void => cs.forEach((c) => this.classes.add(c)),
    remove: (...cs: string[]): void => cs.forEach((c) => this.classes.delete(c)),
    contains: (c: string): boolean => this.classes.has(c),
  };
  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  contains(o: unknown): boolean {
    return o === this || this.children.some((c) => c.contains(o));
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  after(): void {}
  remove(): void {}
  focus(): void {
    doc.activeElement = this;
  }
  blur(): void {
    if (doc.activeElement === this) doc.activeElement = null;
  }
  select(): void {}
  getContext(): unknown {
    return { setTransform: () => {}, clearRect: () => {} };
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 900, height: 500 };
  }
  /** As the browser does for an event dispatched at an element: the window's
   *  capture listeners hear it first (a non-bubbling "scroll" included). */
  dispatchEvent(e: { type: string }): boolean {
    win.fire(e.type, { type: e.type, target: this });
    this.fire(e.type, { type: e.type, target: this });
    return true;
  }
  press(detail = 1): { prevented: boolean } {
    const md = { prevented: false, preventDefault: () => void (md.prevented = true) };
    this.fire("mousedown", md);
    // A press whose mousedown default ran would focus the button.
    if (!md.prevented) this.focus();
    this.fire("click", { detail });
    return md;
  }
}

class Root extends El {
  readonly found = new Map<string, El>();
  innerHTML = "";
  querySelector(sel: string): El | null {
    if (sel === "#ed-keep") return null;
    let el = this.found.get(sel);
    if (!el) {
      el = new El(sel === "#imged-canvas" ? "canvas" : sel.includes("toggle") ? "button" : "div");
      this.found.set(sel, el);
    }
    return el;
  }
}

beforeEach(() => {
  h.ctx = null;
  h.fits = 0;
  win = Object.assign(new Target(), {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
  });
  vi.stubGlobal("window", win);
  doc = Object.assign(new Target(), {
    activeElement: null as unknown,
    querySelector: () => null,
    createElement: (tag: string) => new El(tag),
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
});
afterEach(async () => {
  // The panels are remembered per app session (module state): put both back
  // open so no test leaks its collapse into the next one.
  const m = await mount();
  if (collapsed(m).layers) m.$("#imged-layers-toggle").press();
  if (collapsed(m).inspector) m.$("#imged-insp-toggle").press();
  expect(collapsed(m)).toEqual({ layers: false, inspector: false });
  await m.handle.dispose();
  currentSession.set(null);
  vi.unstubAllGlobals();
});

async function mount() {
  const root = new Root();
  const handle = await mountImageEditor(
    root as unknown as HTMLElement,
    { view: "editor", projectPath: "C:/p/Card.trt" } as never,
    () => false,
    { project: createBlankImageProject("Card", 641, 361, "#ffffff"), missing: [], recovered: false },
  );
  const $ = (sel: string): El => root.querySelector(sel)!;
  const key = (k: string, extra: Record<string, unknown> = {}): void =>
    win.fire("keydown", {
      key: k,
      code: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      target: null,
      defaultPrevented: false,
      preventDefault: () => {},
      ...extra,
    });
  return { root, handle, $, key };
}
type Mounted = Awaited<ReturnType<typeof mount>>;

const collapsed = (m: Mounted): { layers: boolean; inspector: boolean } => ({
  layers: m.$("#imged-layers").classes.has("imged-layers--collapsed"),
  inspector: m.$("#imged-inspector").classes.has("imged-inspector--collapsed"),
});
const face = (b: El): { pressed: string | null; label: string | null; title: string } => ({
  pressed: b.getAttribute("aria-pressed"),
  label: b.getAttribute("aria-label"),
  title: b.title,
});

describe("the image editor's panel toggles", () => {
  it("open on a fresh start, and flip class, aria-pressed, aria-label and title with the chord", async () => {
    const m = await mount();
    const lb = m.$("#imged-layers-toggle");
    const ib = m.$("#imged-insp-toggle");
    expect(collapsed(m)).toEqual({ layers: false, inspector: false });
    expect(face(lb)).toEqual({ pressed: "true", label: "Hide layers", title: "Hide layers (F4)" });
    expect(face(ib)).toEqual({ pressed: "true", label: "Hide properties", title: "Hide properties (Shift+F4)" });

    lb.press();
    expect(collapsed(m)).toEqual({ layers: true, inspector: false });
    expect(face(lb)).toEqual({ pressed: "false", label: "Show layers", title: "Show layers (F4)" });
    ib.press();
    expect(collapsed(m)).toEqual({ layers: true, inspector: true });
    expect(face(ib)).toEqual({ pressed: "false", label: "Show properties", title: "Show properties (Shift+F4)" });

    lb.press();
    ib.press();
    expect(collapsed(m)).toEqual({ layers: false, inspector: false });
    expect(face(lb).label).toBe("Hide layers");
    expect(face(ib).label).toBe("Hide properties");
    await m.handle.dispose();
  });

  it("a press never takes focus (mousedown's default is prevented) and never refits the view itself", async () => {
    const m = await mount();
    const field = new El("input");
    doc.activeElement = field; // e.g. the project name being renamed
    expect(m.$("#imged-layers-toggle").press().prevented).toBe(true);
    expect(m.$("#imged-insp-toggle").press().prevented).toBe(true);
    expect(doc.activeElement).toBe(field);
    // The stage takes the freed width through the view's ResizeObserver, the
    // window-resize path; the shell adds no fit of its own.
    expect(h.fits).toBe(0);
    await m.handle.dispose();
  });

  it("F4 and Shift+F4 toggle them; inert while something holds the keyboard; titles follow a rebinding", async () => {
    const m = await mount();
    m.key("F4");
    expect(collapsed(m)).toEqual({ layers: true, inspector: false });
    m.key("F4", { shiftKey: true });
    expect(collapsed(m)).toEqual({ layers: true, inspector: true });
    const release = blockShortcuts();
    try {
      m.key("F4");
      m.key("F4", { shiftKey: true });
    } finally {
      release();
    }
    expect(collapsed(m)).toEqual({ layers: true, inspector: true });
    m.key("F4");
    m.key("F4", { shiftKey: true });
    expect(collapsed(m)).toEqual({ layers: false, inspector: false });
    await m.handle.dispose();

    // Rebound in Settings: the next mount binds and names the user's chords.
    const before = settingsStore.get();
    settingsStore.set({ ...before, shortcuts: { ...before.shortcuts, imageLayers: "F6", imageProperties: "" } });
    try {
      const n = await mount();
      expect(n.$("#imged-layers-toggle").title).toBe("Hide layers (F6)");
      expect(n.$("#imged-insp-toggle").title).toBe("Hide properties");
      n.key("F4");
      expect(collapsed(n).layers).toBe(false);
      n.key("F6");
      expect(collapsed(n).layers).toBe(true);
      n.key("F6");
      await n.handle.dispose();
    } finally {
      settingsStore.set(before);
    }
  });

  it("are remembered per app session: a remount shows them as they were left", async () => {
    const a = await mount();
    a.$("#imged-insp-toggle").press();
    await a.handle.dispose();
    const b = await mount();
    expect(collapsed(b)).toEqual({ layers: false, inspector: true });
    expect(face(b.$("#imged-insp-toggle")).label).toBe("Show properties");
    b.$("#imged-insp-toggle").press();
    b.$("#imged-layers-toggle").press();
    await b.handle.dispose();
    const c = await mount();
    expect(collapsed(c)).toEqual({ layers: true, inspector: false });
    expect(face(c.$("#imged-layers-toggle"))).toEqual({ pressed: "false", label: "Show layers", title: "Show layers (F4)" });
    await c.handle.dispose();
  });

  it("focus inside a collapsing panel moves to that panel's toggle; focus elsewhere stays", async () => {
    const m = await mount();
    const inLayers = m.$("#imged-layers").appendChild(new El("button"));
    const inInspector = m.$("#imged-inspector").appendChild(new El("input"));
    inLayers.focus();
    m.key("F4");
    expect(doc.activeElement).toBe(m.$("#imged-layers-toggle"));
    inInspector.focus();
    // A pointer press on the toggle: its own click blurs it, then the
    // collapse hands focus to it, out of the vanishing panel.
    m.$("#imged-insp-toggle").press();
    expect(doc.activeElement).toBe(m.$("#imged-insp-toggle"));
    // Opening moves nothing.
    const outside = new El("button");
    outside.focus();
    m.key("F4");
    m.$("#imged-insp-toggle").press();
    expect(doc.activeElement).toBe(outside);
    // Collapsing with focus outside the panel leaves it there.
    m.key("F4");
    expect(doc.activeElement).toBe(outside);
    m.key("F4");
    await m.handle.dispose();
  });

  it("collapsing the properties puts an inspector popover away the way a scroll does; opening does not", async () => {
    const m = await mount();
    // What the colour picker and the font list listen with: a window capture
    // listener for "scroll" from anywhere outside them.
    const heard: unknown[] = [];
    win.addEventListener("scroll", (e) => heard.push((e as { target: unknown }).target));
    m.key("F4", { shiftKey: true });
    expect(heard).toEqual([m.$("#imged-inspector")]);
    m.key("F4", { shiftKey: true });
    expect(heard).toHaveLength(1);
    // The layers toggle sends nothing of the kind.
    m.key("F4");
    m.key("F4");
    expect(heard).toHaveLength(1);
    await m.handle.dispose();
  });

  it("a toggle mid layer crop leaves the crop as it is", async () => {
    const m = await mount();
    const ctx = h.ctx as unknown as { mode: { get(): string; set(v: string): void } };
    ctx.mode.set("crop-layer");
    m.key("F4", { shiftKey: true });
    m.key("F4");
    expect(ctx.mode.get()).toBe("crop-layer");
    expect(collapsed(m)).toEqual({ layers: true, inspector: true });
    m.key("F4", { shiftKey: true });
    m.key("F4");
    ctx.mode.set("idle");
    await m.handle.dispose();
  });

  it("dispose leaves no key listener behind, and a toggle after it does nothing", async () => {
    const baseline = win.count();
    const m = await mount();
    expect(win.count()).toBeGreaterThan(baseline);
    const lb = m.$("#imged-layers-toggle");
    await m.handle.dispose();
    expect(win.count()).toBe(baseline);
    // A click that reaches the old button after the screen went: no change to
    // the remembered state.
    lb.press();
    const n = await mount();
    expect(collapsed(n)).toEqual({ layers: false, inspector: false });
    await n.handle.dispose();
  });
});
