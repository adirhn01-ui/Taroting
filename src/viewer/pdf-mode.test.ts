// The folder viewer's PDF mode against a small fake DOM and a fake page view:
// what it puts on screen, what each control asks of the view, the password
// prompt, the failure lines, stale opens, and that dispose() leaves nothing
// behind. src/pdf/view is mocked whole — its own tests cover the strip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../core/store";
import type { PdfDoc, PdfSearchHit, PdfViewPage, PdfViewState } from "../pdf/types";

/* ---------------- a fake DOM ---------------- */

type Fn = (e: unknown) => void;

class FakeEl {
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  value = "";
  hidden = false;
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<Fn>>();
  styles = new Map<string, string>();
  focused = 0;
  clientHeight = 800;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  style = { setProperty: (k: string, v: string) => void this.styles.set(k, v) };
  classes = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
    if (k === "id") this.id = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, fn: Fn): void {
    let s = this.listeners.get(type);
    if (!s) this.listeners.set(type, (s = new Set()));
    s.add(fn);
  }
  removeEventListener(type: string, fn: Fn): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, e: Record<string, unknown> = {}): Record<string, unknown> {
    const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn(), target: this, ...e };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    return ev;
  }
  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl {
    c.remove();
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  get nextSibling(): FakeEl | null {
    if (!this.parent) return null;
    const sib = this.parent.children;
    return sib[sib.indexOf(this) + 1] ?? null;
  }
  remove(): void {
    if (!this.parent) return;
    const sib = this.parent.children;
    sib.splice(sib.indexOf(this), 1);
    this.parent = null;
  }
  contains(n: unknown): boolean {
    if (n === this) return true;
    return this.children.some((c) => c.contains(n));
  }
  /** Depth-first search by id. */
  find(id: string): FakeEl | null {
    if (this.id === id) return this;
    for (const c of this.children) {
      const f = c.find(id);
      if (f) return f;
    }
    return null;
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  focus(): void {
    this.focused++;
  }
  blur(): void {}
  select(): void {}
  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

let made: FakeEl[] = [];

/* ---------------- fakes for the page view ---------------- */

const h = vi.hoisted(() => ({
  view: null as null | ReturnType<typeof makeViewShape>,
  viewOpts: null as unknown,
  rail: null as null | {
    el: unknown;
    setPages: ReturnType<typeof vi.fn>;
    setCurrent: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
  railOpts: null as null | { onPick(slot: number): void },
  search: null as null | { find: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> },
  searchPages: null as null | (() => unknown[]),
  openPdf: vi.fn(),
  menu: [] as { label: string; onSelect: () => void }[],
}));

// A type-only helper for the hoisted object's shape.
function makeViewShape() {
  return {
    el: null as unknown as FakeEl,
    state: null as unknown as Store<PdfViewState>,
    setPages: vi.fn(),
    scrollToPage: vi.fn(),
    reveal: vi.fn(),
    setSearchHits: vi.fn(),
    setZoom: vi.fn(),
    fit: vi.fn(),
    dispose: vi.fn(),
  };
}

vi.mock("../pdf/view", () => ({
  createPdfView: (opts: unknown) => {
    h.viewOpts = opts;
    const v = makeViewShape();
    v.el = new FakeEl("div");
    made.push(v.el);
    v.state = new Store<PdfViewState>({ zoom: 1, fit: "width", current: 0, count: 0 });
    v.setPages.mockImplementation((p: PdfViewPage[]) =>
      v.state.set({ ...v.state.get(), count: p.length, current: Math.min(v.state.get().current, Math.max(0, p.length - 1)) }),
    );
    v.setZoom.mockImplementation((z: number) => v.state.set({ ...v.state.get(), zoom: z, fit: null }));
    v.fit.mockImplementation((f: "width" | "page") => v.state.set({ ...v.state.get(), fit: f }));
    // the strip lands where it was sent (the real one reports it after a scroll)
    v.scrollToPage.mockImplementation((slot: number) => v.state.set({ ...v.state.get(), current: slot }));
    h.view = v;
    return v;
  },
  createThumbRail: (o: { onPick(slot: number): void }) => {
    h.railOpts = o;
    const el = new FakeEl("div");
    made.push(el);
    h.rail = { el, setPages: vi.fn(), setCurrent: vi.fn(), dispose: vi.fn() };
    return h.rail;
  },
  createSearch: (pages: () => unknown[]) => {
    h.searchPages = pages;
    h.search = { find: vi.fn(), cancel: vi.fn() };
    return h.search;
  },
  openPdf: (...a: unknown[]) => h.openPdf(...a),
  isPdfOpenError: (e: unknown) => typeof (e as { kind?: unknown } | null)?.kind === "string",
}));
vi.mock("../ui/menu", () => ({
  showMenu: (_x: number, _y: number, items: { label: string; onSelect: () => void }[]) => {
    h.menu = items;
  },
  closeMenu: () => {},
}));

import { mountPdfMode, nextZoomStop, pageAtRatio, ratioOfPage, PX_PER_PT_100, type PdfMemory, type PdfMode } from "./pdf-mode";

/* ---------------- harness ---------------- */

function fakeDoc(n: number, name = "doc"): PdfDoc & { destroy: ReturnType<typeof vi.fn> } {
  return {
    id: name,
    path: name,
    doc: {},
    numPages: n,
    pageInfo: async () => ({ w: 612, h: 792, rotate: 0 }),
    destroy: vi.fn(async () => {}),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)));
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let root: FakeEl;
let stage: FakeEl;
let top: FakeEl;
let nameEl: FakeEl;
let status: { text: string | null; detail?: string }[];
let modes: PdfMode[];
let innerWidth = 1280;

function mount(memory: PdfMemory = { fit: "width", zoom: 1, railOpen: null }): PdfMode {
  const mode = mountPdfMode(
    {
      root: root as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      top: top as unknown as HTMLElement,
      nameEl: nameEl as unknown as HTMLElement,
      setStatus: (text, opts) => void status.push({ text, detail: opts?.detail }),
      withChord: (label) => `${label} (Ctrl+F)`,
    },
    memory,
  );
  modes.push(mode);
  return mode;
}

const byId = (id: string): FakeEl => {
  const f = root.find(id);
  if (!f) throw new Error(`no #${id}`);
  return f;
};

const pwError = (retry = false): Error & { kind: string; retry: boolean } =>
  Object.assign(new Error("Password required"), { kind: "password", retry });

beforeEach(() => {
  made = [];
  status = [];
  modes = [];
  h.menu = [];
  h.openPdf.mockReset();
  innerWidth = 1280;
  root = new FakeEl("div");
  stage = root.appendChild(new FakeEl("div"));
  top = root.appendChild(new FakeEl("div"));
  top.appendChild(new FakeEl("button")).id = "vw-back";
  nameEl = top.appendChild(new FakeEl("div"));
  nameEl.id = "vw-name";
  top.appendChild(new FakeEl("div")).id = "vw-count";
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      const e = new FakeEl(tag);
      made.push(e);
      return e;
    },
  });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t?: ReturnType<typeof setTimeout>) => clearTimeout(t),
    get innerWidth() {
      return innerWidth;
    },
  });
});

afterEach(() => {
  for (const md of modes) md.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openDoc(mode: PdfMode, n: number, path = "C:\\docs\\a.pdf"): Promise<ReturnType<typeof fakeDoc>> {
  const d = fakeDoc(n, path);
  h.openPdf.mockResolvedValueOnce(d);
  await mode.open(path, () => true);
  await flush();
  return d;
}

/* ---------------- pure maps ---------------- */

describe("the scrubber's map and the zoom stops", () => {
  it("maps a track position to a page and back", () => {
    expect(pageAtRatio(0, 9)).toBe(0);
    expect(pageAtRatio(1, 9)).toBe(8);
    expect(pageAtRatio(0.5, 9)).toBe(4);
    expect(pageAtRatio(0.06, 9)).toBe(0);
    expect(pageAtRatio(0.07, 9)).toBe(1);
    expect(pageAtRatio(2, 9)).toBe(8);
    expect(pageAtRatio(0.7, 1)).toBe(0);
    expect(ratioOfPage(4, 9)).toBe(0.5);
    expect(ratioOfPage(8, 9)).toBe(1);
    expect(ratioOfPage(0, 1)).toBe(0);
    for (let p = 0; p < 12; p++) expect(pageAtRatio(ratioOfPage(p, 12), 12)).toBe(p);
  });

  it("steps to the next round percentage either way", () => {
    expect(nextZoomStop(100, 1)).toBe(110);
    expect(nextZoomStop(100, -1)).toBe(90);
    expect(nextZoomStop(93, 1)).toBe(100);
    expect(nextZoomStop(93, -1)).toBe(90);
    expect(nextZoomStop(600, 1)).toBe(600);
    expect(nextZoomStop(10, -1)).toBe(10);
  });
});

/* ---------------- opening ---------------- */

describe("a PDF on the stage", () => {
  it("shows every page in the strip and the rail, with text selection on and no forms", async () => {
    const mode = mount();
    const d = await openDoc(mode, 9);
    expect(h.openPdf).toHaveBeenCalledWith("C:\\docs\\a.pdf", "C:\\docs\\a.pdf", undefined);
    const pages = h.view!.setPages.mock.calls.at(-1)![0] as PdfViewPage[];
    expect(pages).toHaveLength(9);
    expect(pages[3]).toEqual({ key: "p3", doc: d, index: 3, rotate: 0 });
    expect(h.rail!.setPages).toHaveBeenLastCalledWith(pages);
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(0);
    expect(h.viewOpts).toEqual({ textLayer: true });
    expect(byId("vw-pdf").hidden).toBe(false);
    expect(byId("vw-pdf-bar").hidden).toBe(false);
    expect(stage.contains(byId("vw-pdf"))).toBe(true);
    expect(root.classes.has("viewer--pdf")).toBe(true);
  });

  it("names the page beside the file name, and announces it once the pages stop changing", async () => {
    vi.useFakeTimers();
    const mode = mount();
    await openDoc(mode, 9);
    const page = byId("vw-pdf-page");
    // after the name in the top bar
    expect(top.children.indexOf(page)).toBe(top.children.indexOf(nameEl) + 1);
    expect(page.textContent).toBe("Page 1 of 9");
    const live = byId("vw-pdf-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    h.view!.state.set({ ...h.view!.state.get(), current: 1 });
    await flush();
    h.view!.state.set({ ...h.view!.state.get(), current: 4 });
    await flush();
    expect(page.textContent).toBe("Page 5 of 9");
    expect(h.rail!.setCurrent).toHaveBeenLastCalledWith(4);
    // throttled: nothing said while scrolling
    expect(live.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(700);
    expect(live.textContent).toBe("Page 5 of 9");
    expect(byId("vw-pdf-scrub").getAttribute("aria-valuenow")).toBe("5");
    expect(byId("vw-pdf-scrub").getAttribute("aria-valuemax")).toBe("9");
  });

  it("a rail pick scrolls the strip to that page", async () => {
    const mode = mount();
    await openDoc(mode, 9);
    h.railOpts!.onPick(6);
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(6);
  });
});

describe("the page scrubber", () => {
  it("drags through pages with the pointer", async () => {
    const mode = mount();
    await openDoc(mode, 9);
    const scrub = byId("vw-pdf-scrub");
    scrub.rect = { left: 100, top: 0, right: 500, bottom: 14, width: 400, height: 14 };
    scrub.fire("pointerdown", { button: 0, clientX: 300, pointerId: 1 });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(4);
    expect(byId("vw-pdf-page").textContent).toBe("Page 5 of 9");
    expect(scrub.children[1]!.styles.get("left")).toBe("50%");
    expect(scrub.children[0]!.styles.get("width")).toBe("50%");
    scrub.fire("pointermove", { clientX: 500, pointerId: 1 });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(8);
    scrub.fire("pointerup", { pointerId: 1 });
    await flush();
    // the rail follows the drag, and the label the strip once it is let go
    expect(h.rail!.setCurrent).toHaveBeenLastCalledWith(8);
    expect(byId("vw-pdf-page").textContent).toBe("Page 9 of 9");
    const calls = h.view!.scrollToPage.mock.calls.length;
    scrub.fire("pointermove", { clientX: 100, pointerId: 1 });
    expect(h.view!.scrollToPage.mock.calls.length).toBe(calls);
  });

  it("answers PageUp / PageDown / Home / End", async () => {
    const mode = mount();
    await openDoc(mode, 9);
    const scrub = byId("vw-pdf-scrub");
    h.view!.state.set({ ...h.view!.state.get(), current: 3 });
    await flush();
    scrub.fire("keydown", { key: "PageDown" });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(4);
    scrub.fire("keydown", { key: "PageUp" });
    scrub.fire("keydown", { key: "PageUp" });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(2);
    const ev = scrub.fire("keydown", { key: "End" });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(8);
    expect(ev.stopPropagation).toHaveBeenCalled();
    scrub.fire("keydown", { key: "Home" });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(0);
  });

  it("answers the arrows a page at a time, and keeps them from the viewer's file stepping", async () => {
    const mode = mount();
    await openDoc(mode, 9);
    const scrub = byId("vw-pdf-scrub");
    for (const [key, to] of [
      ["ArrowRight", 4],
      ["ArrowDown", 4],
      ["ArrowLeft", 2],
      ["ArrowUp", 2],
    ] as const) {
      // the fake strip lands where it is sent: back to page 4 each time
      h.view!.state.set({ ...h.view!.state.get(), current: 3 });
      const ev = scrub.fire("keydown", { key });
      expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(to);
      // never on to the viewer's ShortcutManager (prevFile / nextFile)
      expect(ev.stopPropagation).toHaveBeenCalled();
      expect(ev.preventDefault).toHaveBeenCalled();
    }
    // at the last page an arrow still stays here: the end of the slider,
    // not the next file
    h.view!.state.set({ ...h.view!.state.get(), current: 8 });
    await flush();
    const atEnd = scrub.fire("keydown", { key: "ArrowRight" });
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(8);
    expect(atEnd.stopPropagation).toHaveBeenCalled();
    // a modified arrow is someone else's chord
    const calls = h.view!.scrollToPage.mock.calls.length;
    const ctrl = scrub.fire("keydown", { key: "ArrowRight", ctrlKey: true });
    expect(ctrl.stopPropagation).not.toHaveBeenCalled();
    expect(h.view!.scrollToPage.mock.calls.length).toBe(calls);
  });

  it("Space / Shift+Space page the strip a screen at a time", async () => {
    const mode = mount();
    mode.scrollPage(1); // nothing open: nothing to scroll
    expect((h.view!.el as unknown as { scrollTop?: number }).scrollTop).toBeUndefined();
    await openDoc(mode, 9);
    const el = h.view!.el as unknown as { scrollTop: number; clientHeight: number };
    el.scrollTop = 1000;
    el.clientHeight = 800;
    mode.scrollPage(1);
    expect(el.scrollTop).toBe(1700);
    mode.scrollPage(-1);
    mode.scrollPage(-1);
    expect(el.scrollTop).toBe(300);
  });

  it("Home / End from the viewer's chords go to the first and last page", async () => {
    const mode = mount();
    await openDoc(mode, 12);
    mode.goPage("last");
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(11);
    mode.goPage("first");
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(0);
  });
});

describe("zoom", () => {
  it("the buttons step the round percentages, the menu fits or sets 100% / 200%", async () => {
    const mode = mount();
    await openDoc(mode, 3);
    h.view!.state.set({ ...h.view!.state.get(), zoom: PX_PER_PT_100 });
    await flush();
    expect(byId("vw-pdf-zoom").textContent).toBe("100%");
    byId("vw-pdf-zoomin").fire("click");
    expect(h.view!.setZoom).toHaveBeenLastCalledWith(1.1 * PX_PER_PT_100, undefined);
    await flush();
    expect(byId("vw-pdf-zoom").textContent).toBe("110%");
    byId("vw-pdf-zoomout").fire("click");
    expect(h.view!.setZoom.mock.calls.at(-1)![0]).toBeCloseTo(PX_PER_PT_100);
    byId("vw-pdf-zoom").fire("click");
    expect(h.menu.map((i) => i.label)).toEqual(["Fit width", "Fit page", "100%", "200%"]);
    h.menu[1]!.onSelect();
    expect(h.view!.fit).toHaveBeenLastCalledWith("page");
    h.menu[0]!.onSelect();
    expect(h.view!.fit).toHaveBeenLastCalledWith("width");
    h.menu[3]!.onSelect();
    expect(h.view!.setZoom.mock.calls.at(-1)![0]).toBeCloseTo(2 * PX_PER_PT_100);
  });

  it("Ctrl+wheel zooms at the cursor; a plain wheel is left to scroll", async () => {
    const mode = mount();
    await openDoc(mode, 3);
    const wrap = byId("vw-pdf");
    const plain = wrap.fire("wheel", { ctrlKey: false, deltaY: 100, deltaMode: 0, clientX: 5, clientY: 6 });
    expect(h.view!.setZoom).not.toHaveBeenCalled();
    expect(plain.preventDefault).not.toHaveBeenCalled();
    const ev = wrap.fire("wheel", { ctrlKey: true, deltaY: -300, deltaMode: 0, clientX: 40, clientY: 50 });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(h.view!.setZoom).toHaveBeenLastCalledWith(2, { clientX: 40, clientY: 50 });
  });

  it("is remembered across mounts in one viewer session", async () => {
    const memory: PdfMemory = { fit: "width", zoom: 1, railOpen: null };
    const a = mount(memory);
    await openDoc(a, 3);
    h.view!.setZoom(1.5);
    await flush();
    expect(memory).toMatchObject({ fit: null, zoom: 1.5 });
    a.dispose();
    mount(memory);
    expect(h.view!.setZoom).toHaveBeenCalledWith(1.5);
    expect(h.view!.fit).not.toHaveBeenCalled();
    // and a fit mode is restored as a fit
    const memo2: PdfMemory = { fit: "page", zoom: 3, railOpen: true };
    mount(memo2);
    expect(h.view!.fit).toHaveBeenCalledWith("page");
    expect(h.view!.setZoom).not.toHaveBeenCalled();
  });
});

describe("the rail", () => {
  it("is open by default, toggles from the top bar, and the toggle is remembered", async () => {
    const memory: PdfMemory = { fit: "width", zoom: 1, railOpen: null };
    const mode = mount(memory);
    await openDoc(mode, 3);
    const btn = byId("vw-pdf-railbtn");
    expect(top.children.indexOf(btn)).toBe(top.children.indexOf(nameEl) - 1);
    expect(byId("vw-pdf-rail").hidden).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.fire("click");
    expect(byId("vw-pdf-rail").hidden).toBe(true);
    expect(memory.railOpen).toBe(false);
    expect(root.classes.has("viewer--pdf-rail")).toBe(false);
    mode.dispose();
    mount(memory);
    expect(byId("vw-pdf-rail").hidden).toBe(true);
  });

  it("starts closed in a narrow window", () => {
    innerWidth = 700;
    mount();
    expect(byId("vw-pdf-rail").hidden).toBe(true);
  });
});

describe("find", () => {
  const hits: PdfSearchHit[] = [
    { key: "p0", rects: [[1, 2, 3, 4]] },
    { key: "p2", rects: [[5, 6, 7, 8]] },
    { key: "p5", rects: [[9, 10, 11, 12]] },
  ];

  it("searches as the user types, steps with Enter / Shift+Enter, closes with Esc", async () => {
    vi.useFakeTimers();
    const mode = mount();
    await openDoc(mode, 9);
    h.search!.find.mockResolvedValue(hits);
    mode.find();
    const input = byId("vw-pdf-find-input");
    expect(input.focused).toBe(1);
    input.value = "taro";
    input.fire("input");
    expect(h.search!.find).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.search!.find).toHaveBeenCalledWith("taro");
    // the search reads this document's pages
    expect(h.searchPages!()).toHaveLength(9);
    await flush();
    expect(h.view!.setSearchHits).toHaveBeenLastCalledWith(hits, 0);
    expect(h.view!.reveal).toHaveBeenLastCalledWith("p0", [1, 2, 3, 4]);
    expect(byId("vw-pdf-find-count").textContent).toBe("1 of 3");
    input.fire("keydown", { key: "Enter" });
    expect(h.view!.setSearchHits).toHaveBeenLastCalledWith(hits, 1);
    expect(h.view!.reveal).toHaveBeenLastCalledWith("p2", [5, 6, 7, 8]);
    expect(byId("vw-pdf-find-count").textContent).toBe("2 of 3");
    input.fire("keydown", { key: "Enter", shiftKey: true });
    input.fire("keydown", { key: "Enter", shiftKey: true });
    expect(byId("vw-pdf-find-count").textContent).toBe("3 of 3");
    expect(h.view!.reveal).toHaveBeenLastCalledWith("p5", [9, 10, 11, 12]);
    const esc = input.fire("keydown", { key: "Escape" });
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(root.find("vw-pdf-find")).toBeNull();
    expect(h.view!.setSearchHits).toHaveBeenLastCalledWith([], -1);
    expect(input.listenerCount()).toBe(0);
  });

  it("says when nothing matched, and Ctrl+F again refocuses the open box", async () => {
    vi.useFakeTimers();
    const mode = mount();
    await openDoc(mode, 2);
    h.search!.find.mockResolvedValue([]);
    byId("vw-pdf-findbtn").fire("click");
    const input = byId("vw-pdf-find-input");
    input.value = "nothing";
    input.fire("keydown", { key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(h.search!.find).toHaveBeenCalledTimes(0);
    input.fire("input");
    input.fire("keydown", { key: "Enter" });
    await flush();
    expect(h.search!.find).toHaveBeenCalledTimes(1);
    expect(byId("vw-pdf-find-count").textContent).toBe("No results");
    mode.find();
    expect(input.focused).toBe(2);
    expect(root.all().filter((e) => e.id === "vw-pdf-find")).toHaveLength(1);
  });

  it("names its shortcut on the Find button", () => {
    mount();
    expect(byId("vw-pdf-findbtn").title).toBe("Find (Ctrl+F)");
  });
});

describe("a password-protected PDF", () => {
  it("asks on the stage, says when a password was wrong, opens with the right one", async () => {
    const mode = mount();
    const d = fakeDoc(4);
    h.openPdf.mockRejectedValueOnce(pwError()).mockRejectedValueOnce(pwError(true)).mockResolvedValueOnce(d);
    const done = mode.open("C:\\docs\\locked.pdf", () => true);
    await flush();
    const lock = byId("vw-pdf-lock");
    expect(stage.contains(lock)).toBe(true);
    expect(lock.find("vw-pdf-lock-error")).toBeNull();
    const input = byId("vw-pdf-password");
    expect(input.getAttribute("type")).toBe("password");
    input.value = "nope";
    byId("vw-pdf-open").fire("click");
    await flush();
    expect(h.openPdf).toHaveBeenLastCalledWith("C:\\docs\\locked.pdf", "C:\\docs\\locked.pdf", { password: "nope" });
    expect(byId("vw-pdf-lock-error").textContent).toBe("That password didn't work");
    const again = byId("vw-pdf-password");
    again.value = "tarot";
    again.fire("keydown", { key: "Enter" });
    await done;
    expect(h.openPdf).toHaveBeenLastCalledWith("C:\\docs\\locked.pdf", "C:\\docs\\locked.pdf", { password: "tarot" });
    expect(root.find("vw-pdf-lock")).toBeNull();
    expect((h.view!.setPages.mock.calls.at(-1)![0] as PdfViewPage[]).length).toBe(4);
    expect(byId("vw-pdf").hidden).toBe(false);
  });

  it("Cancel leaves the 'can't show this file' card naming the protection", async () => {
    const mode = mount();
    h.openPdf.mockRejectedValueOnce(pwError());
    const done = mode.open("C:\\docs\\locked.pdf", () => true);
    await flush();
    byId("vw-pdf-cancel").fire("click");
    await done;
    expect(root.find("vw-pdf-lock")).toBeNull();
    expect(status.at(-1)).toEqual({ text: "Can't show this file", detail: "This PDF is password-protected." });
    expect(byId("vw-pdf").hidden).toBe(true);
    expect(h.openPdf).toHaveBeenCalledTimes(1);
  });

  it("never shows the previous PDF behind its prompt", async () => {
    const mode = mount();
    const first = await openDoc(mode, 5);
    h.openPdf.mockRejectedValueOnce(pwError());
    void mode.open("C:\\docs\\locked.pdf", () => true);
    await flush();
    expect(first.destroy).toHaveBeenCalled();
    expect(byId("vw-pdf").hidden).toBe(true);
    expect(h.view!.setPages).toHaveBeenLastCalledWith([]);
  });
});

describe("a PDF that can't be shown", () => {
  it.each([
    [{ kind: "invalid" }, "This PDF is damaged or isn't really a PDF."],
    [{ kind: "missing" }, "This PDF is missing or can't be read."],
    [{ kind: "other", message: "Bad XRef" }, "Bad XRef"],
  ])("%o → the status card with a PDF line", async (err, detail) => {
    const mode = mount();
    h.openPdf.mockRejectedValueOnce(Object.assign(new Error("x"), err));
    await mode.open("C:\\docs\\bad.pdf", () => true);
    expect(status.at(-1)).toEqual({ text: "Can't show this file", detail });
    expect(byId("vw-pdf").hidden).toBe(true);
    expect(byId("vw-pdf-bar").hidden).toBe(true);
  });
});

describe("stale opens and stepping", () => {
  it("an open the viewer no longer wants is destroyed, never painted", async () => {
    const mode = mount();
    const slow = deferred<PdfDoc>();
    const a = fakeDoc(3, "a");
    const b = fakeDoc(7, "b");
    h.openPdf.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(b);
    const first = mode.open("a.pdf", () => true);
    await mode.open("b.pdf", () => true);
    slow.resolve(a);
    await first;
    expect(a.destroy).toHaveBeenCalled();
    expect(h.view!.setPages.mock.calls.some((c) => (c[0] as PdfViewPage[]).some((p) => p.doc === a))).toBe(false);
    expect((h.view!.setPages.mock.calls.at(-1)![0] as PdfViewPage[])[0]!.doc).toBe(b);
  });

  it("an open whose file the viewer has left (live false) is destroyed", async () => {
    const mode = mount();
    const a = fakeDoc(3, "a");
    h.openPdf.mockResolvedValueOnce(a);
    await mode.open("a.pdf", () => false);
    expect(a.destroy).toHaveBeenCalled();
    expect(h.view!.setPages).not.toHaveBeenCalled();
  });

  it("shows the strip before the pages go in, so it never lays them out in a 0×0 box", async () => {
    const mode = mount();
    const wrapHidden: boolean[] = [];
    h.view!.setPages.mockImplementation(() => void wrapHidden.push(byId("vw-pdf").hidden));
    await openDoc(mode, 4);
    expect(wrapHidden).toEqual([false, false]);
    expect(byId("vw-pdf-bar").hidden).toBe(false);
  });

  it("PDF → PDF swaps the document in place, page 1 first, and lets the old one go after", async () => {
    const mode = mount();
    const a = await openDoc(mode, 3, "a.pdf");
    h.view!.state.set({ ...h.view!.state.get(), current: 2 });
    await flush();
    const viewBefore = h.view;
    const b = fakeDoc(8, "b.pdf");
    h.openPdf.mockResolvedValueOnce(b);
    a.destroy.mockImplementation(async () => {
      // the new document is already on the strip when the old one goes
      expect((h.view!.setPages.mock.calls.at(-1)![0] as PdfViewPage[])[0]!.doc).toBe(b);
    });
    await mode.open("b.pdf", () => true);
    expect(h.view).toBe(viewBefore);
    expect(a.destroy).toHaveBeenCalledTimes(1);
    // through an empty strip, then scrolled to the top
    const calls = h.view!.setPages.mock.calls.map((c) => (c[0] as PdfViewPage[]).length);
    expect(calls.slice(-2)).toEqual([0, 8]);
    expect(h.view!.scrollToPage).toHaveBeenLastCalledWith(0);
  });
});

describe("dispose", () => {
  it("removes everything it added and lets the document go", async () => {
    vi.useFakeTimers();
    const before = root.all().length;
    const topBefore = top.children.length;
    const mode = mount();
    const d = await openDoc(mode, 4);
    h.search!.find.mockResolvedValue([]);
    mode.find();
    byId("vw-pdf-find-input").value = "x";
    byId("vw-pdf-find-input").fire("input");
    const added = made.slice();
    mode.dispose();
    expect(root.all().length).toBe(before);
    expect(top.children.length).toBe(topBefore);
    expect(root.classes.size).toBe(0);
    expect(d.destroy).toHaveBeenCalled();
    expect(h.view!.dispose).toHaveBeenCalled();
    expect(h.rail!.dispose).toHaveBeenCalled();
    // no listener survives on anything it made
    expect(added.reduce((n, e) => n + e.listenerCount(), 0)).toBe(0);
    // no timer either: the find pause would have searched
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.search!.find).not.toHaveBeenCalled();
  });

  it("a password prompt open at dispose goes too, and its open ends quietly", async () => {
    const mode = mount();
    h.openPdf.mockRejectedValueOnce(pwError());
    const done = mode.open("C:\\docs\\locked.pdf", () => true);
    await flush();
    mode.dispose();
    await done;
    expect(root.find("vw-pdf-lock")).toBeNull();
    expect(status.filter((s) => s.text !== null)).toEqual([]);
  });
});
