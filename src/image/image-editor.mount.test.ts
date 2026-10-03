import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import { blockShortcuts } from "../core/shortcuts";
import type { MediaInfo, MediaRef, ProjectFile } from "../core/types";
import { addPhotoLayer, layersOf } from "./layers";

// The image editor shell mounted against a small fake DOM (vitest runs in
// node), with its panels, tools, renderer and the disk faked: what is under
// test is the shell's own wiring — what its top-bar buttons refuse, where the
// Delete key leaves the selection, what a failed mount takes down, and which
// photo files a Home-card render is handed. Plus `writeProjectThumb`, the
// card writer itself, driven directly.

const h = vi.hoisted(() => ({
  toasts: [] as string[],
  exports: 0,
  copies: [] as { doc: unknown; blobFor?: (m: MediaRef) => Blob | null }[],
  navigations: [] as unknown[],
  /** ctx handed to the children, captured from the layers panel's mount */
  ctx: null as null | Record<string, unknown>,
  /** set to make the ink tool throw while mounting */
  inkThrows: false,
  /** set to make the layers panel park an overlay on mount */
  panelOverlay: false,
  overlayClosed: 0,
  /** renderThumbnail calls: the opts it was handed, and how to finish it */
  thumbs: [] as { doc: unknown; opts?: { signal?: AbortSignal; blobFor?: (m: MediaRef) => Blob | null }; resolve: (b: Blob) => void; reject: (e: unknown) => void }[],
  /** saveBlob calls, and how to finish each */
  saves: [] as { dest: { projectPath?: string }; blob: Blob; resolve: () => void }[],
  /** what PreviewResources.blobFor hands over while the preview is alive */
  held: new Map<string, Blob>(),
  sessions: [] as { disposed: number }[],
  recents: [] as { path: string; thumb?: string }[],
  /** the options the shell handed the view */
  viewOpts: null as null | { panThroughBlock?: () => boolean },
  /** the drop handlers the shell registered */
  drop: null as null | { onDrop(paths: string[]): void },
}));

vi.mock("../ui/toast", () => ({
  toast: {
    info: (m: string) => void h.toasts.push(`info:${m}`),
    error: (m: string) => void h.toasts.push(`error:${m}`),
    refuse: (m: string) => void h.toasts.push(`refuse:${m}`),
  },
}));
vi.mock("../core/ipc", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ipc: {
    listRecents: async () => ({ items: h.recents }),
    pathExists: async () => true,
    probeMedia: async () => {
      throw new Error("not in these tests");
    },
  },
  onDragDrop: async (handlers: { onDrop(paths: string[]): void }) => {
    h.drop = handlers;
    return () => {};
  },
}));
vi.mock("../core/nav", () => ({
  exitDest: (route: { returnTo?: unknown }) => route.returnTo ?? { view: "home" },
  navigate: (r: unknown) => void h.navigations.push(r),
}));
vi.mock("../core/app-close", () => ({
  registerBeforeClose: () => () => {},
  registerCloseTask: () => () => {},
}));
vi.mock("../ui/temp-project", () => ({
  createTempLeaveGate: () => ({}),
  createTempExits: () => ({
    confirm: async () => true,
    confirmLeave: (dest: () => void) => dest(),
    keep: async () => "kept",
  }),
}));
vi.mock("../ui/menu", () => ({ closeMenu: () => {} }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../editor/media/relink", () => ({
  openRelinkDialog: () => () => {},
  isStillInfo: () => true,
}));
vi.mock("./copy", () => ({
  copyImage: (doc: unknown, blobFor?: (m: MediaRef) => Blob | null) => void h.copies.push({ doc, blobFor }),
}));
vi.mock("./export-dialog", () => ({
  openImageExportDialog: () => {
    h.exports++;
  },
}));
vi.mock("./image-menu", () => ({ openImageMenu: () => {} }));
vi.mock("./crop-image", () => ({ cancelImageCrop: () => {} }));
vi.mock("./layers-panel", () => ({
  mountLayersPanel: (_el: unknown, ctx: Record<string, unknown>) => {
    h.ctx = ctx;
    if (h.panelOverlay) {
      (ctx.registerOverlay as (c: () => void) => () => void)(() => {
        h.overlayClosed++;
      });
    }
    return { dispose: () => {} };
  },
}));
vi.mock("./toolbar", () => ({ mountToolbar: () => ({ dispose: () => {} }) }));
vi.mock("./inspector", () => ({
  mountImageInspector: () => ({ dispose: () => {}, dropPreview: () => {} }),
}));
vi.mock("./select-tool", () => ({
  mountSelectTool: () => ({ dispose: () => {}, cropLayer: () => {}, revertCrop: () => {} }),
}));
vi.mock("./ink/ink", () => ({
  mountInk: () => {
    if (h.inkThrows) throw new Error("The ink layer could not be created.");
    return { dispose: () => {} };
  },
}));
vi.mock("./view", async () => {
  const { Store } = await import("../core/store");
  return {
    zoomStep: (z: number) => z,
    createViewController: (_s: unknown, _c: unknown, _size: unknown, opts?: { panThroughBlock?: () => boolean }) => {
      h.viewOpts = opts ?? null;
      return {
      store: new Store({ zoom: 1, panX: 0, panY: 0, dpr: 1, stageW: 900, stageH: 500 }),
      fit: () => {},
      actual: () => {},
      zoomAt: () => {},
      panBy: () => {},
      clientToCanvas: (x: number, y: number) => ({ x, y }),
      canvasToClient: (x: number, y: number) => ({ x, y }),
      panning: false,
      dispose: () => {},
      };
    },
  };
});
vi.mock("./render", () => ({
  renderComposite: () => {},
  PreviewResources: class {
    private disposed = false;
    setView(): void {}
    onChange(): () => void {
      return () => {};
    }
    onMediaDims(): () => void {
      return () => {};
    }
    invalidate(): void {}
    // As the real PhotoCache: nothing once disposed.
    blobFor(m: MediaRef): Blob | null {
      return this.disposed ? null : (h.held.get(m.id) ?? null);
    }
    dispose(): void {
      this.disposed = true;
    }
  },
}));
vi.mock("./render/export", () => ({
  renderThumbnail: (doc: unknown, opts?: { signal?: AbortSignal; blobFor?: (m: MediaRef) => Blob | null }) =>
    new Promise<Blob>((resolve, reject) => {
      h.thumbs.push({ doc, opts, resolve, reject });
      opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
}));
vi.mock("./save", () => ({
  saveBlob: (dest: { projectPath?: string }, _fmt: string, blob: Blob) =>
    new Promise<{ path: string }>((resolve) => {
      h.saves.push({ dest, blob, resolve: () => resolve({ path: "card.jpg" }) });
    }),
}));
// The session is the real one's shape with no disk behind it: undo history,
// autosave and the save badge are not what these tests are about.
vi.mock("../core/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/session")>();
  const { Store } = await import("../core/store");
  class FakeSession {
    readonly store: InstanceType<typeof Store<ProjectFile>>;
    readonly temp: InstanceType<typeof Store<boolean>>;
    readonly saveState = new Store<string>("saved");
    readonly history = { canUndo: false, canRedo: false };
    leaveGuard: unknown = null;
    blockLeave: unknown = null;
    disposed = 0;
    constructor(
      readonly path: string,
      initial: ProjectFile,
      opts?: { temp?: boolean },
    ) {
      this.store = new Store(initial);
      this.temp = new Store(opts?.temp === true);
      h.sessions.push(this);
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
    async dispose(): Promise<void> {
      this.disposed++;
    }
  }
  return { ...real, ProjectSession: FakeSession };
});

const { mountImageEditor, writeProjectThumb } = await import("./image-editor");
const { currentSession } = await import("../core/session");

/* ---------------- fake DOM ---------------- */

type Handler = (e: unknown) => void;

class Target {
  private listeners = new Map<string, Set<Handler>>();
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
}

class FakeElement extends Target {}

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
  classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  after(): void {}
  remove(): void {}
  blur(): void {}
  focus(): void {}
  select(): void {}
  getContext(): unknown {
    return { setTransform: () => {}, clearRect: () => {} };
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 900, height: 500 };
  }
  click(): void {
    this.fire("click", { detail: 1 });
  }
}

/** The shell's root: its markup is not parsed, each selector gets its own
 *  element, the same one every time it is asked for. */
class Root extends El {
  readonly found = new Map<string, El>();
  innerHTML = "";
  querySelector(sel: string): El | null {
    if (sel === "#ed-keep") return null;
    let el = this.found.get(sel);
    if (!el) {
      el = new El(sel === "#imged-canvas" ? "canvas" : "div");
      this.found.set(sel, el);
    }
    return el;
  }
}

let win: Target;
let modal = false;

beforeEach(() => {
  h.toasts.length = 0;
  h.exports = 0;
  h.copies.length = 0;
  h.navigations.length = 0;
  h.ctx = null;
  h.inkThrows = false;
  h.panelOverlay = false;
  h.overlayClosed = 0;
  h.thumbs.length = 0;
  h.saves.length = 0;
  h.held.clear();
  h.sessions.length = 0;
  h.recents = [];
  h.viewOpts = null;
  h.drop = null;
  modal = false;
  win = Object.assign(new Target(), {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal(
    "document",
    Object.assign(new Target(), {
      activeElement: null,
      querySelector: (s: string) => (modal && s === ".modal-backdrop" ? {} : null),
      createElement: (tag: string) => new El(tag),
    }),
  );
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
});
afterEach(() => {
  currentSession.set(null);
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const photo = (path: string): MediaInfo => ({
  path,
  size: 1234,
  mtimeMs: 9,
  kind: "image",
  duration: 0,
  width: 320,
  height: 180,
  hasAudio: false,
  oriented: true,
});

/** Photos added in order, each above the last: the FIRST is bottom-most. */
function withPhotos(...paths: string[]): ProjectFile {
  let p = createBlankImageProject("Holiday card", 641, 361, "#ffffff");
  let top: string | null = null;
  for (const path of paths) {
    const r = addPhotoLayer(p, photo(path), { above: top });
    p = r.project;
    top = r.trackId;
  }
  return p;
}

async function mount(project: ProjectFile) {
  const root = new Root();
  const handle = await mountImageEditor(
    root as unknown as HTMLElement,
    { view: "editor", projectPath: "C:/Users/Ana/Documents/Taroting/Holiday card.trt" } as never,
    () => false,
    { project, missing: [], recovered: false },
  );
  const ctx = h.ctx as unknown as {
    mode: { get(): string; set(m: string): void };
    selection: { get(): string | null; set(id: string | null): void };
    session: { project: ProjectFile; commit(fn: (p: ProjectFile) => ProjectFile): void };
  };
  const $ = (sel: string): El => root.querySelector(sel)!;
  const key = (k: string, extra: Record<string, unknown> = {}): void =>
    win.fire("keydown", {
      key: k,
      code: k === "Delete" ? "Delete" : k,
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
  return { root, handle, ctx, $, key };
}

/** Leave the editor, finishing any Home-card render it starts on the way. */
async function leave(m: { handle: { dispose(): Promise<void> } }): Promise<void> {
  const left = m.handle.dispose();
  for (let i = 0; i < 4; i++) {
    await flush();
    for (const t of h.thumbs) t.resolve(new Blob([new Uint8Array(2)], { type: "image/jpeg" }));
    await flush();
    for (const s of h.saves) s.resolve();
  }
  await left;
}

/* ---------------- C125: Export and Copy image during a crop ---------------- */

describe("Export and Copy image refuse while a crop, dialog, menu or picker is open", () => {
  it("during a layer crop: no dialog, no copy, the crop stays, and the buttons are greyed", async () => {
    const m = await mount(withPhotos("C:/p/harbour.jpg"));
    m.ctx.mode.set("crop-layer");
    await flush();
    expect(m.$("#ed-export").disabled).toBe(true);
    expect(m.$("#imged-copy").disabled).toBe(true);
    // A click that reaches them anyway (the button greys on the store's
    // microtask) is still refused.
    m.$("#ed-export").click();
    m.$("#imged-copy").click();
    expect(h.exports).toBe(0);
    expect(h.copies).toEqual([]);
    expect(m.ctx.mode.get()).toBe("crop-layer");
    expect(h.toasts).toEqual([
      "info:Finish the crop first, then export.",
      "info:Finish the crop first, then copy the image.",
    ]);
    m.ctx.mode.set("idle");
    await flush();
    expect(m.$("#ed-export").disabled).toBe(false);
    expect(m.$("#imged-copy").disabled).toBe(false);
    await m.handle.dispose();
  });

  it("behind an open menu or picker (a keyboard hold) and behind a dialog", async () => {
    const m = await mount(withPhotos("C:/p/harbour.jpg"));
    const release = blockShortcuts();
    try {
      m.$("#ed-export").click();
      m.$("#imged-copy").click();
    } finally {
      release();
    }
    modal = true;
    m.$("#ed-export").click();
    modal = false;
    expect(h.exports).toBe(0);
    expect(h.copies).toEqual([]);
    expect(h.toasts).toEqual([
      "info:Close the open menu or picker first, then export.",
      "info:Close the open menu or picker first, then copy the image.",
      "info:Close the dialog first, then export.",
    ]);
    await m.handle.dispose();
  });

  it("control: with nothing open, Export opens its dialog and Copy copies with the held photos", async () => {
    const p = withPhotos("C:/p/harbour.jpg");
    const media = layersOf(p)[0]!.media;
    const held = new Blob([new Uint8Array(5)], { type: "image/jpeg" });
    h.held.set(media.id, held);
    const m = await mount(p);
    m.$("#ed-export").click();
    m.$("#imged-copy").click();
    expect(h.exports).toBe(1);
    expect(h.copies).toHaveLength(1);
    // C130: the copy is handed the preview's own photo files.
    expect(h.copies[0]!.blobFor?.(media)).toBe(held);
    expect(h.toasts).toEqual([]);
    await m.handle.dispose();
  });
});

/* ---------------- C129: Space on the project name ---------------- */

describe("Space on the focused project name", () => {
  it("starts the rename and goes no further (no hold to pan behind it)", async () => {
    const m = await mount(withPhotos("C:/p/harbour.jpg"));
    let stopped = 0;
    let prevented = 0;
    const name = m.$("#ed-name");
    name.fire("keydown", {
      key: " ",
      preventDefault: () => {
        prevented++;
      },
      stopPropagation: () => {
        stopped++;
      },
    });
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
    // The rename field is in.
    expect(name.children.map((c) => c.tagName)).toEqual(["INPUT"]);
    await m.handle.dispose();
  });
});

/* ---------------- C132: the Delete key and the selection ---------------- */

describe("the Delete key", () => {
  it("selects the neighbour, as the layer menu's Delete does", async () => {
    // Three photos: layersOf lists top first, so [top, middle, bottom].
    const p = withPhotos("C:/p/bottom.jpg", "C:/p/middle.jpg", "C:/p/top.jpg");
    const [top, middle, bottom] = layersOf(p).map((l) => l.trackId) as [string, string, string];
    const m = await mount(p);
    m.ctx.selection.set(middle);
    m.key("Delete");
    await flush();
    // The one below takes its place…
    expect(layersOf(m.ctx.session.project).map((l) => l.trackId)).toEqual([top, bottom]);
    expect(m.ctx.selection.get()).toBe(bottom);
    // …and with nothing below, the one above.
    m.key("Delete");
    await flush();
    expect(layersOf(m.ctx.session.project).map((l) => l.trackId)).toEqual([top]);
    expect(m.ctx.selection.get()).toBe(top);
    // The last layer leaves nothing to select.
    m.key("Delete");
    await flush();
    expect(layersOf(m.ctx.session.project)).toEqual([]);
    expect(m.ctx.selection.get()).toBe(null);
    await leave(m);
  });

  it("does nothing during a crop", async () => {
    const p = withPhotos("C:/p/bottom.jpg", "C:/p/top.jpg");
    const ids = layersOf(p).map((l) => l.trackId);
    const m = await mount(p);
    m.ctx.selection.set(ids[0]!);
    m.ctx.mode.set("crop-layer");
    m.key("Delete");
    await flush();
    expect(layersOf(m.ctx.session.project).map((l) => l.trackId)).toEqual(ids);
    expect(m.ctx.selection.get()).toBe(ids[0]);
    await m.handle.dispose();
  });
});

/* ---------------- C126: hold to pan inside a crop ---------------- */

describe("the view's keyboard-hold pass-through", () => {
  it("is open exactly while either crop is", async () => {
    const m = await mount(withPhotos("C:/p/harbour.jpg"));
    const through = h.viewOpts?.panThroughBlock;
    expect(through?.()).toBe(false);
    m.ctx.mode.set("crop-image");
    expect(through?.()).toBe(true);
    m.ctx.mode.set("crop-layer");
    expect(through?.()).toBe(true);
    m.ctx.mode.set("idle");
    expect(through?.()).toBe(false);
    await m.handle.dispose();
  });
});

/* ---------------- toast.refuse: a refused file is not a failure ---------------- */

describe("a dropped file that is not an image", () => {
  it("is refused without being recorded as a failure", async () => {
    const m = await mount(withPhotos("C:/p/harbour.jpg"));
    h.drop!.onDrop(["C:/v/clip.mp4"]);
    await flush();
    expect(h.toasts).toEqual(["refuse:Only images can be added to an image project."]);
    await m.handle.dispose();
  });
});

/* ---------------- C131: a mount that throws half-way ---------------- */

describe("a mount whose body throws after the session is published", () => {
  it("closes what it parked, releases the session and routes out with one toast", async () => {
    h.inkThrows = true;
    h.panelOverlay = true;
    const m = await mount(withPhotos("C:/p/harbour.jpg"));
    // The overlay parked before the throw is closed, not left on the page.
    expect(h.overlayClosed).toBe(1);
    expect(currentSession.get()).toBe(null);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(1);
    expect(h.toasts).toEqual(["error:Couldn't open this image project: The ink layer could not be created."]);
    expect(h.navigations).toEqual([{ view: "home" }]);
    expect(m.root.textContent).toBe("");
    // The handle it returns is a no-op.
    await m.handle.dispose();
    expect(h.sessions[0]!.disposed).toBe(1);
  });
});

/* ---------------- C130: the card render on leave ---------------- */

describe("the Home card rendered on leave", () => {
  it("is handed the photo files the preview held, though the preview is gone by then", async () => {
    const p = withPhotos("C:/p/bottom.jpg", "C:/p/top.jpg");
    const [topMedia, bottomMedia] = layersOf(p).map((l) => l.media) as [MediaRef, MediaRef];
    const held = new Blob([new Uint8Array(7)], { type: "image/jpeg" });
    // Only one of the two decoded so far: the other is still read from disk.
    h.held.set(bottomMedia.id, held);
    const m = await mount(p);
    // A pixel change, so the card is owed.
    m.ctx.session.commit((d) => ({ ...d, image: { ...d.image! } }));
    await flush();
    const left = m.handle.dispose();
    await flush();
    expect(h.thumbs).toHaveLength(1);
    const blobFor = h.thumbs[0]!.opts?.blobFor;
    expect(blobFor?.(bottomMedia)).toBe(held);
    expect(blobFor?.(topMedia)).toBe(null);
    h.thumbs[0]!.resolve(new Blob([new Uint8Array(2)], { type: "image/jpeg" }));
    await flush();
    h.saves[0]!.resolve();
    await left;
    expect(h.saves).toHaveLength(1);
  });
});

/* ---------------- C130: writeProjectThumb ---------------- */

describe("writeProjectThumb", () => {
  const doc = (id: string): ProjectFile => ({ id, name: id }) as unknown as ProjectFile;
  const jpeg = (n: number): Blob => new Blob([new Uint8Array(n)], { type: "image/jpeg" });
  const far = (): number => Date.now() + 60_000;

  it("a newer render of the same project aborts the older one, which saves nothing", async () => {
    const a = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    const b = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    expect(h.thumbs).toHaveLength(2);
    expect(h.thumbs[0]!.opts?.signal?.aborted).toBe(true);
    expect(h.thumbs[1]!.opts?.signal?.aborted).toBe(false);
    const newer = jpeg(9);
    h.thumbs[1]!.resolve(newer);
    await flush();
    expect(h.saves.map((s) => s.blob)).toEqual([newer]);
    h.saves[0]!.resolve();
    await Promise.all([a, b]);
    expect(h.saves).toHaveLength(1);
  });

  it("renders of different projects leave each other alone", async () => {
    const a = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    const b = writeProjectThumb(doc("p2"), "C:/B.trt", far());
    expect(h.thumbs.map((t) => t.opts?.signal?.aborted)).toEqual([false, false]);
    h.thumbs[0]!.resolve(jpeg(3));
    h.thumbs[1]!.resolve(jpeg(4));
    await flush();
    expect(h.saves.map((s) => s.dest.projectPath).sort()).toEqual(["C:/A.trt", "C:/B.trt"]);
    for (const s of h.saves) s.resolve();
    await Promise.all([a, b]);
  });

  it("the deadline stops the waiting, never the render: a late render still saves its card", async () => {
    await writeProjectThumb(doc("p1"), "C:/A.trt", Date.now() + 5);
    // Returned on the deadline with the render still running, not aborted.
    expect(h.thumbs).toHaveLength(1);
    expect(h.thumbs[0]!.opts?.signal?.aborted).toBe(false);
    const late = jpeg(6);
    h.thumbs[0]!.resolve(late);
    await flush();
    expect(h.saves.map((s) => s.blob)).toEqual([late]);
    h.saves[0]!.resolve();
  });

  it("an older render already saving finishes before the newer one writes, never over it", async () => {
    const a = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    const older = jpeg(3);
    h.thumbs[0]!.resolve(older);
    await flush();
    // The older one is mid-save when the newer one starts.
    expect(h.saves.map((s) => s.blob)).toEqual([older]);
    const b = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    const newer = jpeg(8);
    h.thumbs[1]!.resolve(newer);
    await flush();
    // Queued behind the save in flight.
    expect(h.saves.map((s) => s.blob)).toEqual([older]);
    h.saves[0]!.resolve();
    await flush();
    expect(h.saves.map((s) => s.blob)).toEqual([older, newer]);
    h.saves[1]!.resolve();
    await Promise.all([a, b]);
  });

  it("a render queued behind a save is dropped when a newer one starts", async () => {
    const a = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    const first = jpeg(3);
    h.thumbs[0]!.resolve(first);
    await flush();
    // The second finishes drawing while the first is still saving: it waits.
    const b = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    h.thumbs[1]!.resolve(jpeg(4));
    await flush();
    // A third starts before the second's turn came: the second is superseded.
    const c = writeProjectThumb(doc("p1"), "C:/A.trt", far());
    const third = jpeg(5);
    h.thumbs[2]!.resolve(third);
    h.saves[0]!.resolve();
    await flush();
    expect(h.saves.map((s) => s.blob)).toEqual([first, third]);
    h.saves[1]!.resolve();
    await Promise.all([a, b, c]);
  });

  it("hands the render the photo files the caller holds", async () => {
    const held = jpeg(5);
    const blobFor = (m: MediaRef): Blob | null => (m.id === "m1" ? held : null);
    void writeProjectThumb(doc("p1"), "C:/C.trt", Date.now());
    void writeProjectThumb(doc("p1"), "C:/D.trt", Date.now(), blobFor);
    expect(h.thumbs[1]!.opts?.blobFor?.({ id: "m1" } as MediaRef)).toBe(held);
    h.thumbs[0]!.reject(new Error("offline"));
    h.thumbs[1]!.reject(new Error("offline"));
    await flush();
    expect(h.saves).toEqual([]);
  });
});
