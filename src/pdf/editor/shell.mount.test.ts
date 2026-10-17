// The PDF editor shell mounted against a fake DOM (fake-dom.test-util.ts),
// with the page view, pdf.js, the disk and the other builders' parts mocked:
// what is under test is the shell's own wiring — the SHELL CONTRACT (stale
// mounts, currentSession, the Temporary badge, exits, never rejecting, the
// dispose order), the page panel's operations, form typing as one undo step,
// the find bar, zoom keys, the Home card and the source dialog. The session,
// the project model and the stores are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfProject } from "../../core/pdf-project";
import type { ProjectFile } from "../../core/types";
import { FakeElement, FakeEvent, installFakeDom, key } from "./fake-dom.test-util";
import type { FakeDocument, FakeWindow } from "./fake-dom.test-util";

/* ---------------- mocks ---------------- */

interface FakeDoc {
  id: string;
  path: string;
  numPages: number;
  doc: object;
  destroyed: number;
  pageInfo(i: number): Promise<{ w: number; h: number; rotate: 0 | 90 | 180 | 270 }>;
  destroy(): Promise<void>;
}
type FakeViewPage = { key: string; doc: FakeDoc | null; index: number; rotate: number; w?: number; h?: number };

const h = vi.hoisted(() => ({
  log: [] as string[],
  toasts: [] as string[],
  navigations: [] as unknown[],
  menus: [] as { label: string; disabled?: boolean; onSelect(): void }[][],
  closeTasks: new Set<() => unknown>(),
  stats: new Map<string, { size: number; mtimeMs: number } | null>(),
  files: new Map<string, { pages: number; password?: boolean; w?: number; h?: number }>(),
  docs: [] as FakeDoc[],
  picks: [] as string[][],
  saves: [] as { dest: { kind: string; projectPath?: string }; size: number }[],
  covers: [] as { docId: string | null; index: number; rotate: number; max: number; type: string }[],
  recents: [] as { path: string; thumb?: string }[],
  exports: [] as unknown[],
  parts: [] as string[],
  partThrows: "",
  partHook: null as null | (() => void),
  ctx: null as null | Record<string, unknown>,
  hosts: null as null | Record<string, unknown>,
  view: null as null | Record<string, any>,
  rail: null as null | Record<string, any>,
  search: null as null | { queries: string[]; cancels: number; hits: unknown[] },
  savedProjects: 0,
}));

vi.mock("../../ui/toast", () => ({
  toast: {
    info: (m: string) => void h.toasts.push(`info:${m}`),
    error: (m: string) => void h.toasts.push(`error:${m}`),
    refuse: (m: string) => void h.toasts.push(`refuse:${m}`),
  },
}));
vi.mock("../../core/ipc", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ipc: {
    fileStat: async (p: string) => (h.stats.has(p) ? h.stats.get(p)! : { size: 100, mtimeMs: 5 }),
    listRecents: async () => ({ items: h.recents }),
    pathExists: async () => true,
    saveProject: async () => {
      h.savedProjects++;
      h.log.push("saveProject");
      return { modifiedAt: "x" };
    },
    imageSaveBegin: async (dest: { kind: string; projectPath?: string }, _f: string, size: number) => {
      h.saves.push({ dest, size });
      h.log.push("cover");
      return { token: 7, path: "card.jpg" };
    },
    imageSaveChunk: async () => {},
    imageSaveCommit: async () => ({ token: 7, path: "card.jpg" }),
    imageSaveAbort: async () => {},
  },
  pickPdfFiles: async () => h.picks.shift() ?? [],
}));
vi.mock("../../core/nav", () => ({
  exitDest: (route: { returnTo?: string }) => (route.returnTo ? { view: "viewer", path: route.returnTo } : { view: "home" }),
  navigate: (r: unknown) => void h.navigations.push(r),
}));
vi.mock("../../core/app-close", () => ({
  registerBeforeClose: () => () => {},
  registerCloseTask: (t: () => unknown) => {
    h.closeTasks.add(t);
    return () => void h.closeTasks.delete(t);
  },
}));
vi.mock("../../ui/temp-project", () => ({
  createTempLeaveGate: () => ({}),
  createTempExits: (session: { temp: { set(v: boolean): void } }) => ({
    confirm: async () => true,
    confirmLeave: (dest: () => void) => {
      h.log.push("confirmLeave");
      dest();
    },
    keep: async () => {
      session.temp.set(false);
      return "kept";
    },
  }),
}));
vi.mock("../../ui/menu", () => ({
  closeMenu: () => {},
  showMenu: (_x: number, _y: number, items: { label: string; onSelect(): void }[]) => void h.menus.push(items),
}));
vi.mock("../../ui/focus", () => ({ focusFirst: () => true, trapTab: () => () => {} }));
vi.mock("./tools", () => ({
  toolsPart: (ctx: Record<string, unknown>, hosts: Record<string, unknown>) => {
    h.ctx = ctx;
    h.hosts = hosts;
    h.parts.push("tools");
    h.partHook?.();
    if (h.partThrows === "tools") throw new Error("The tools could not start.");
    return { dispose: () => void h.log.push("tools.dispose") };
  },
}));
vi.mock("./inspector", () => ({
  inspectorPart: () => {
    h.parts.push("inspector");
    return { dispose: () => void h.log.push("inspector.dispose") };
  },
}));
vi.mock("./forms", () => ({
  formsPart: () => {
    h.parts.push("forms");
    return { dispose: () => void h.log.push("forms.dispose") };
  },
}));
vi.mock("./export-dialog", () => ({ openPdfExportDialog: (_ctx: unknown, opts?: unknown) => void h.exports.push(opts ?? null) }));
vi.mock("../view", async () => {
  const { Store } = await import("../../core/store");
  const fail = (kind: string): Error => Object.assign(new Error(kind), { kind, retry: false });
  return {
    isPdfOpenError: (e: unknown) => typeof (e as { kind?: unknown })?.kind === "string",
    openPdf: async (id: string, path: string) => {
      const f = h.files.get(path);
      if (!f) throw fail("missing");
      if (f.password) throw fail("password");
      const d: FakeDoc = {
        id,
        path,
        numPages: f.pages,
        doc: {},
        destroyed: 0,
        pageInfo: async () => ({ w: f.w ?? 612, h: f.h ?? 792, rotate: 0 }),
        destroy: async () => {
          d.destroyed++;
          h.log.push(`destroy:${path}`);
        },
      };
      h.docs.push(d);
      return d;
    },
    countPages: async (path: string) => h.files.get(path)?.pages ?? 0,
    renderPageToBlob: async (doc: FakeDoc, index: number, rotate: number, max: number, type: string) => {
      h.covers.push({ docId: doc.id, index, rotate, max, type });
      return new Blob([new Uint8Array(3)], { type });
    },
    createSearch: () => {
      const s = { queries: [] as string[], cancels: 0, hits: [] as unknown[] };
      h.search = s;
      return {
        find: async (q: string) => {
          s.queries.push(q);
          return s.hits;
        },
        cancel: () => void s.cancels++,
      };
    },
    createThumbRail: (opts: Record<string, unknown>) => {
      const r = {
        el: document.createElement("div"),
        opts,
        pages: [] as unknown[],
        current: -1,
        disposed: false,
        setPages(p: unknown[]) {
          r.pages = p;
        },
        setCurrent(s: number) {
          r.current = s;
        },
        dispose() {
          r.disposed = true;
        },
      };
      h.rail = r;
      return r;
    },
    createPdfView: (opts: Record<string, unknown>) => {
      const state = new Store({ zoom: 1, fit: "width" as string | null, current: 0, count: 0 });
      const v = {
        el: document.createElement("div"),
        state,
        opts,
        pages: [] as FakeViewPage[],
        setPagesCalls: 0,
        scrolls: [] as number[],
        zooms: [] as { z: number; anchor?: unknown }[],
        fits: [] as string[],
        hits: [] as { hits: unknown[]; active: number }[],
        reveals: [] as unknown[],
        disposed: false,
        setPages(p: FakeViewPage[]) {
          v.pages = p;
          v.setPagesCalls++;
          state.update((s) => ({ ...s, count: p.length }));
        },
        scrollToPage(s: number) {
          v.scrolls.push(s);
          state.update((x) => ({ ...x, current: s }));
        },
        reveal(k: string, r: unknown) {
          v.reveals.push([k, r]);
        },
        setSearchHits(hits: unknown[], active: number) {
          v.hits.push({ hits, active });
        },
        setZoom(z: number, anchor?: unknown) {
          v.zooms.push({ z, anchor });
          state.update((s) => ({ ...s, zoom: z, fit: null }));
        },
        fit(m: string) {
          v.fits.push(m);
        },
        on: () => () => {},
        overlay: () => null,
        invalidated: [] as string[],
        invalidate(k: string) {
          v.invalidated.push(k);
        },
        setTextLayer: () => {},
        setFormsLayer: () => {},
        dispose() {
          v.disposed = true;
          h.log.push("view.dispose");
        },
      };
      h.view = v;
      return v;
    },
  };
});

const { mountPdfEditor } = await import("./shell");
const { currentSession } = await import("../../core/session");

/* ---------------- harness ---------------- */

let win: FakeWindow;
let doc: FakeDocument;

beforeEach(() => {
  ({ win, doc } = installFakeDom(vi.stubGlobal));
  h.log.length = 0;
  h.toasts.length = 0;
  h.navigations.length = 0;
  h.menus.length = 0;
  h.closeTasks.clear();
  h.stats.clear();
  h.files.clear();
  h.files.set("C:/docs/report.pdf", { pages: 3 });
  h.docs.length = 0;
  h.picks.length = 0;
  h.saves.length = 0;
  h.covers.length = 0;
  h.recents = [];
  h.exports.length = 0;
  h.parts.length = 0;
  h.partThrows = "";
  h.partHook = null;
  h.ctx = null;
  h.hosts = null;
  h.view = null;
  h.rail = null;
  h.search = null;
  h.savedProjects = 0;
});
afterEach(() => {
  currentSession.set(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const PROJECT_PATH = "C:/Users/Ana/Documents/Taroting/Report.trt";

function project(): ProjectFile {
  let n = 0;
  return createPdfProject(
    "Report",
    { path: "C:/docs/report.pdf", size: 100, mtimeMs: 5, pages: 3 },
    { id: () => `id${n++}` },
  );
}

type Route = { view: "editor"; projectPath: string; temp?: true; returnTo?: string };

async function mount(p: ProjectFile = project(), route: Partial<Route> = {}, stale: () => boolean = () => false) {
  const root = document.createElement("div") as unknown as FakeElement;
  doc.body.appendChild(root);
  const handle = await mountPdfEditor(
    root as unknown as HTMLElement,
    { view: "editor", projectPath: PROJECT_PATH, ...route } as never,
    stale,
    { project: p, missing: [], recovered: false },
  );
  await flush();
  const $ = (sel: string): FakeElement => doc.querySelector(sel)!;
  const session = currentSession.get()!;
  const ctx = h.ctx as any;
  return { root, handle, $, session, ctx, view: h.view!, rail: h.rail! };
}

const pageIds = (p: ProjectFile): string[] => p.pdf!.pages.map((pg) => pg.id);
const ctrl = (k: string) => key(win, k, { ctrlKey: true });

/* ---------------- the shell contract ---------------- */

describe("the shell contract", () => {
  it("a mount superseded before it starts touches nothing", async () => {
    const root = document.createElement("div");
    const handle = await mountPdfEditor(root as never, { view: "editor", projectPath: PROJECT_PATH }, () => true, {
      project: project(),
      missing: [],
      recovered: false,
    });
    await handle.dispose();
    expect(currentSession.get()).toBeNull();
    expect(h.docs).toHaveLength(0);
    expect((root as unknown as FakeElement).childNodes).toHaveLength(0);
  });

  it("a mount superseded while its documents open gives them back and touches nothing", async () => {
    let stale = false;
    h.files.set("C:/docs/report.pdf", { pages: 3 });
    const root = document.createElement("div");
    const pending = mountPdfEditor(root as never, { view: "editor", projectPath: PROJECT_PATH }, () => stale, {
      project: project(),
      missing: [],
      recovered: false,
    });
    stale = true;
    await pending;
    await flush();
    expect(currentSession.get()).toBeNull();
    expect(h.docs).toHaveLength(1);
    expect(h.docs[0]!.destroyed).toBe(1);
    expect((root as unknown as FakeElement).childNodes).toHaveLength(0);
    expect(h.toasts).toEqual([]);
    expect(h.navigations).toEqual([]);
  });

  it("publishes its session and releases it on dispose only while it is still its own", async () => {
    const a = await mount();
    expect(currentSession.get()).toBe(a.session);
    await a.handle.dispose();
    expect(currentSession.get()).toBeNull();

    const b = await mount();
    const newer = { other: true } as never;
    currentSession.set(newer);
    await b.handle.dispose();
    expect(currentSession.get()).toBe(newer);
  });

  it("never rejects: a project that isn't a PDF project toasts and routes out", async () => {
    const p = { ...project(), kind: "image" } as ProjectFile;
    const root = document.createElement("div");
    const handle = await mountPdfEditor(root as never, { view: "editor", projectPath: PROJECT_PATH, returnTo: "D:/v/a.pdf" }, () => false, {
      project: p,
      missing: [],
      recovered: false,
    });
    expect(typeof handle.dispose).toBe("function");
    expect(h.toasts.some((t) => t.startsWith("error:Couldn't open this PDF project"))).toBe(true);
    expect(h.navigations).toEqual([{ view: "viewer", path: "D:/v/a.pdf" }]);
    expect(currentSession.get()).toBeNull();
  });

  it("never rejects: a part that throws takes the half-built mount apart", async () => {
    h.partThrows = "tools";
    const root = document.createElement("div") as unknown as FakeElement;
    doc.body.appendChild(root);
    const handle = await mountPdfEditor(root as never, { view: "editor", projectPath: PROJECT_PATH }, () => false, {
      project: project(),
      missing: [],
      recovered: false,
    });
    await flush();
    expect(typeof handle.dispose).toBe("function");
    expect(currentSession.get()).toBeNull();
    expect(h.view!.disposed).toBe(true);
    expect(h.rail!.disposed).toBe(true);
    expect(h.docs[0]!.destroyed).toBe(1);
    expect(root.childNodes).toHaveLength(0);
    expect(h.navigations).toEqual([{ view: "home" }]);
    expect(h.toasts.some((t) => t.includes("The tools could not start."))).toBe(true);
  });

  it("dispose: parts and the view go, every document is destroyed, the session saves LAST", async () => {
    const m = await mount();
    m.session.commit((p) => ({ ...p, name: "Renamed" }));
    await m.handle.dispose();
    expect(h.log).toContain("tools.dispose");
    expect(h.log).toContain("inspector.dispose");
    expect(h.log).toContain("forms.dispose");
    const order = h.log.filter((l) => l === "view.dispose" || l.startsWith("destroy:") || l === "saveProject");
    expect(order).toEqual(["view.dispose", "destroy:C:/docs/report.pdf", "saveProject"]);
    expect((m.ctx.docs as Map<string, unknown>).size).toBe(0);
  });

  it("mounts the three parts with the hosts and the ctx contract", async () => {
    const m = await mount();
    expect(h.parts).toEqual(["tools", "inspector", "forms"]);
    expect(h.hosts!.toolbar).toBe(m.$("#pdfed-tools"));
    expect(h.hosts!.inspector).toBe(m.$("#pdfed-inspector"));
    expect(h.hosts!.topbar).toBe(m.$("#pdfed-topbar"));
    expect(m.ctx.session).toBe(m.session);
    expect(m.ctx.tools.get().tool).toBe("select");
    expect(m.ctx.tools.get().colors.highlight).toBe("#ffd400");
    expect(m.ctx.mode.get()).toBe("annotate");
    expect(m.ctx.hasForms.get()).toBe(false);
    expect(m.ctx.docs.get(m.session.project.pdf!.sources[0]!.id)).toBe(h.docs[0]);
    // the strip shows the project's pages, keyed by page id, with the doc
    expect(m.view.pages.map((p: { key: string }) => p.key)).toEqual(pageIds(m.session.project));
    expect(m.view.pages[1].doc).toBe(h.docs[0]);
    expect(m.view.pages[1].index).toBe(1);
    expect(m.rail.pages).toBe(m.view.pages);
    await m.handle.dispose();
  });
});

describe("bindKey and isTyping", () => {
  it("the later handler wins until it is removed", async () => {
    const m = await mount();
    const calls: string[] = [];
    const offA = m.ctx.bindKey("imgPen", () => calls.push("a"));
    const offB = m.ctx.bindKey("imgPen", () => calls.push("b"));
    key(win, "P");
    offB();
    key(win, "P");
    offA();
    key(win, "P");
    expect(calls).toEqual(["b", "a"]);
    await m.handle.dispose();
  });

  it("form widgets in the annotation layer are typing targets; the strip itself is not", async () => {
    const m = await mount();
    const layer = document.createElement("div") as unknown as FakeElement;
    layer.className = "annotationLayer";
    const box = document.createElement("input") as unknown as FakeElement;
    box.type = "checkbox";
    layer.appendChild(box);
    m.view.el.appendChild(layer);
    expect(m.ctx.isTyping(box)).toBe(true);
    expect(m.ctx.isTyping(m.view.el)).toBe(false);
    await m.handle.dispose();
  });
});

/* ---------------- top bar: temp, Keep, exits ---------------- */

describe("temporary projects and exits", () => {
  it("a temp project reads Temporary with a Keep button; Keep makes it permanent and writes the card", async () => {
    const m = await mount(project(), { temp: true });
    expect(m.$("#ed-save").textContent).toBe("Temporary");
    expect(m.session.leaveGuard).not.toBeNull();
    const keep = m.$("#ed-keep");
    expect(keep).not.toBeNull();
    keep.click();
    await flush();
    await flush();
    expect(m.session.temp.get()).toBe(false);
    expect(doc.querySelector("#ed-keep")).toBeNull();
    expect(m.session.leaveGuard).toBeNull();
    expect(h.saves.map((s) => s.dest)).toEqual([{ kind: "projectThumb", projectPath: PROJECT_PATH, projectId: m.session.project.id }]);
    expect(h.covers[0]).toMatchObject({ index: 0, rotate: 0, max: 512, type: "image/jpeg" });
    await m.handle.dispose();
  });

  it("a temp project never writes a card, even when edited", async () => {
    const m = await mount(project(), { temp: true });
    m.session.commit((p) => ({ ...p, pdf: { ...p.pdf!, pages: [...p.pdf!.pages].reverse() } }));
    await m.handle.dispose();
    for (const t of h.closeTasks) await t();
    expect(h.saves).toEqual([]);
  });

  it("Back reads 'Back to viewer' and returns to the viewer's file when opened from it", async () => {
    const m = await mount(project(), { returnTo: "D:/v/report.pdf" });
    expect(m.$("#ed-home").title).toBe("Back to viewer");
    m.$("#ed-home").click();
    expect(h.navigations).toEqual([{ view: "viewer", path: "D:/v/report.pdf" }]);
    ctrl("W");
    expect(h.navigations[1]).toEqual({ view: "viewer", path: "D:/v/report.pdf" });
    await m.handle.dispose();
  });

  it("Back reads 'Back to projects' otherwise; the gear goes to Settings; there is no Copy image", async () => {
    const m = await mount();
    expect(m.$("#ed-home").title).toBe("Back to projects");
    m.$("#ed-home").click();
    m.$("#ed-settings").click();
    expect(h.navigations).toEqual([{ view: "home" }, { view: "settings" }]);
    expect(doc.querySelector("#imged-copy")).toBeNull();
    m.$("#ed-export").click();
    expect(h.exports).toEqual([null]);
    await m.handle.dispose();
  });

  it("Rename edits the project name as one step", async () => {
    const m = await mount();
    m.$("#ed-name").click();
    const input = m.$("#ed-name").querySelector("input")!;
    input.value = "Contract";
    key(input, "Enter");
    expect(m.session.project.name).toBe("Contract");
    expect(m.session.history.canUndo).toBe(true);
    await m.handle.dispose();
  });
});

/* ---------------- undo / redo ---------------- */

describe("undo and redo", () => {
  it("the buttons follow history and the chords undo and redo", async () => {
    const m = await mount();
    const undoBtn = m.$("#pdfed-undo");
    const redoBtn = m.$("#pdfed-redo");
    expect(undoBtn.disabled).toBe(true);
    const before = pageIds(m.session.project);
    m.rail.opts.onReorder([...before].reverse());
    await flush();
    expect(undoBtn.disabled).toBe(false);
    ctrl("Z");
    await flush();
    expect(pageIds(m.session.project)).toEqual(before);
    expect(redoBtn.disabled).toBe(false);
    redoBtn.click();
    await flush();
    expect(pageIds(m.session.project)).toEqual([...before].reverse());
    await m.handle.dispose();
  });
});

/* ---------------- page panel ---------------- */

describe("the page panel", () => {
  it("reorder through the rail is one step and the strip follows", async () => {
    const m = await mount();
    const ids = pageIds(m.session.project);
    m.rail.opts.onReorder([ids[2], ids[0], ids[1]]);
    await flush();
    expect(pageIds(m.session.project)).toEqual([ids[2], ids[0], ids[1]]);
    expect(m.view.pages.map((p: { key: string }) => p.key)).toEqual([ids[2], ids[0], ids[1]]);
    expect(m.rail.pages).toBe(m.view.pages);
    await m.handle.dispose();
  });

  it("picking a thumbnail scrolls the strip; the rail follows the current page", async () => {
    const m = await mount();
    m.rail.opts.onPick(2);
    await flush();
    expect(m.view.scrolls).toEqual([2]);
    expect(m.rail.current).toBe(2);
    expect(m.$("#pdfed-page").value).toBe("3");
    expect(m.$("#pdfed-page-count").textContent).toBe("/ 3");
    await m.handle.dispose();
  });

  it("the context menu rotates, duplicates and refuses to delete every page", async () => {
    const m = await mount();
    m.rail.opts.onContextMenu([1], { clientX: 5, clientY: 5 });
    const items = h.menus.pop()!;
    items.find((i) => i.label === "Rotate right")!.onSelect();
    expect(m.session.project.pdf!.pages[1]!.rotate).toBe(90);

    m.rail.opts.onContextMenu([0, 1, 2], { clientX: 5, clientY: 5 });
    const all = h.menus.pop()!;
    const del = all.find((i) => i.label === "Delete pages")!;
    expect(del.disabled).toBe(true);
    del.onSelect();
    expect(m.session.project.pdf!.pages).toHaveLength(3);
    expect(h.toasts).toContain("refuse:A document keeps at least one page.");

    m.rail.opts.onContextMenu([0], { clientX: 5, clientY: 5 });
    h.menus.pop()!.find((i) => i.label === "Duplicate page")!.onSelect();
    expect(m.session.project.pdf!.pages).toHaveLength(4);
    expect(m.session.project.pdf!.pages[1]!.src).toBe(m.session.project.pdf!.pages[0]!.src);
    await m.handle.dispose();
  });

  it("Delete with the rail focused deletes the selected pages, and never reaches the mark tools", async () => {
    const m = await mount();
    const marks: string[] = [];
    m.ctx.bindKey("delete", () => marks.push("marks"));
    const ids = pageIds(m.session.project);
    m.ctx.pageSelection.set([1]);
    key(m.rail.el, "Delete");
    expect(pageIds(m.session.project)).toEqual([ids[0], ids[2]]);
    expect(marks).toEqual([]);
    m.ctx.pageSelection.set([0, 1]);
    key(m.rail.el, "Delete");
    expect(pageIds(m.session.project)).toHaveLength(2);
    await m.handle.dispose();
  });

  it("Insert blank page after takes the size of the page it follows", async () => {
    h.files.set("C:/docs/report.pdf", { pages: 3, w: 400, h: 300 });
    const m = await mount();
    m.rail.opts.onContextMenu([0], { clientX: 5, clientY: 5 });
    h.menus.pop()!.find((i) => i.label === "Insert blank page after")!.onSelect();
    await flush();
    const pg = m.session.project.pdf!.pages[1]!;
    expect(pg.src).toBeNull();
    expect([pg.w, pg.h]).toEqual([400, 300]);
    expect(m.ctx.pageSelection.get()).toEqual([1]);
    await flush();
    expect(m.view.pages[1]).toMatchObject({ doc: null, w: 400, h: 300 });
    await m.handle.dispose();
  });

  it("the footer's Insert menu adds a blank A4 page after a blank page of unknown size", async () => {
    const m = await mount();
    m.$("#pdfed-insert").click();
    h.menus.pop()!.find((i) => i.label === "Blank page")!.onSelect();
    await flush();
    expect(m.session.project.pdf!.pages).toHaveLength(4);
    expect(m.session.project.pdf!.pages[1]!.src).toBeNull();
    await m.handle.dispose();
  });

  it("Insert pages from PDF adds the picked files' pages as one step; protected PDFs are refused", async () => {
    h.files.set("C:/docs/extra.pdf", { pages: 2 });
    h.files.set("C:/docs/locked.pdf", { pages: 4, password: true });
    h.picks.push(["C:/docs/extra.pdf", "C:/docs/locked.pdf"]);
    const m = await mount();
    const steps = () => m.session.history;
    m.ctx.pageSelection.set([0]);
    m.rail.opts.onContextMenu([0], { clientX: 5, clientY: 5 });
    h.menus.pop()!.find((i) => i.label === "Insert pages from PDF")!.onSelect();
    await flush();
    await flush();
    const pdf = m.session.project.pdf!;
    expect(pdf.pages).toHaveLength(5);
    expect(pdf.sources).toHaveLength(2);
    const extra = pdf.sources[1]!;
    expect(extra).toMatchObject({ path: "C:/docs/extra.pdf", pages: 2 });
    expect(pdf.pages.slice(1, 3).map((p) => [p.src, p.page])).toEqual([
      [extra.id, 0],
      [extra.id, 1],
    ]);
    expect(h.toasts).toContain("refuse:Protected PDFs can't be added.");
    // the new document is open and shown
    expect(m.ctx.docs.get(extra.id)).toBeDefined();
    await flush();
    expect(m.view.pages[1].doc).toBe(m.ctx.docs.get(extra.id));
    // one undo takes the whole pick back
    m.session.undo();
    expect(m.session.project.pdf!.pages).toHaveLength(3);
    expect(steps().canUndo).toBe(false);
    await m.handle.dispose();
    expect(h.docs.every((d) => d.destroyed === 1)).toBe(true);
  });

  it("the rail can be collapsed from the tool row", async () => {
    const m = await mount();
    const panel = m.$("#pdfed-pages");
    expect(panel.classList.contains("pdfed-pages--collapsed")).toBe(false);
    m.$("#pdfed-rail-toggle").click();
    expect(panel.classList.contains("pdfed-pages--collapsed")).toBe(true);
    m.$("#pdfed-rail-toggle").click();
    expect(panel.classList.contains("pdfed-pages--collapsed")).toBe(false);
    await m.handle.dispose();
  });

  it("Extract pages and Export page as image open the export dialog on that page", async () => {
    const m = await mount();
    m.rail.opts.onContextMenu([2], { clientX: 5, clientY: 5 });
    const items = h.menus.pop()!;
    items.find((i) => i.label === "Extract pages")!.onSelect();
    items.find((i) => i.label === "Export page as image")!.onSelect();
    expect(h.exports).toEqual([
      { pageSlot: 2, tab: "pdf" },
      { pageSlot: 2, tab: "image" },
    ]);
    await m.handle.dispose();
  });
});

/* ---------------- forms ---------------- */

describe("form typing", () => {
  it("rapid typing in one field is ONE undo step, taken after 1 s idle", async () => {
    vi.useFakeTimers();
    const m = await mount();
    const src = m.session.project.pdf!.sources[0]!.id;
    const forms = m.view.opts.forms;
    forms.set(src, "12R", "J");
    forms.set(src, "12R", "Jo");
    forms.set(src, "12R", "Joe");
    expect(forms.get(src, "12R")).toBe("Joe");
    expect(m.session.history.canUndo).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(m.session.history.canUndo).toBe(true);
    m.session.undo();
    expect(forms.get(src, "12R")).toBeUndefined();
    expect(m.session.history.canUndo).toBe(false);
    vi.useRealTimers();
    await m.handle.dispose();
  });

  it("another field, a blur or an undo ends the step first", async () => {
    vi.useFakeTimers();
    const m = await mount();
    const src = m.session.project.pdf!.sources[0]!.id;
    const forms = m.view.opts.forms;
    forms.set(src, "1R", "a");
    forms.set(src, "2R", "b");
    // field 1 is a step of its own; field 2 still typing
    m.view.el.dispatchEvent(new FakeEvent("focusout"));
    m.session.undo();
    expect(forms.get(src, "2R")).toBeUndefined();
    expect(forms.get(src, "1R")).toBe("a");
    m.session.undo();
    expect(forms.get(src, "1R")).toBeUndefined();
    forms.set(src, "3R", true);
    m.session.undo(); // closes the typing step, then undoes it
    expect(forms.get(src, "3R")).toBeUndefined();
    vi.useRealTimers();
    await m.handle.dispose();
  });
});

/* ---------------- find ---------------- */

describe("the find bar", () => {
  it("Ctrl+F opens it; typing searches after a pause; Enter steps; Esc clears", async () => {
    vi.useFakeTimers();
    const m = await mount();
    const ids = pageIds(m.session.project);
    h.search!.hits = [
      { key: ids[0], rects: [[1, 2, 3, 4]] },
      { key: ids[2], rects: [[5, 6, 7, 8]] },
    ];
    const box = m.$(".pdfed-find");
    expect(box.hidden).toBe(true);
    ctrl("F");
    expect(box.hidden).toBe(false);
    const input = box.querySelector("input")!;
    expect(doc.activeElement).toBe(input);
    input.value = "lease";
    input.dispatchEvent(new FakeEvent("input"));
    input.value = "leases";
    input.dispatchEvent(new FakeEvent("input"));
    await vi.advanceTimersByTimeAsync(199);
    expect(h.search!.queries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.search!.queries).toEqual(["leases"]);
    expect(m.view.hits.at(-1)).toEqual({ hits: h.search!.hits, active: 0 });
    expect(m.view.reveals.at(-1)).toEqual([ids[0], [1, 2, 3, 4]]);
    expect(box.querySelector(".pdfed-find__count")!.textContent).toBe("1 of 2");
    key(input, "Enter");
    expect(m.view.hits.at(-1)!.active).toBe(1);
    expect(box.querySelector(".pdfed-find__count")!.textContent).toBe("2 of 2");
    key(input, "Enter", { shiftKey: true });
    expect(m.view.hits.at(-1)!.active).toBe(0);
    const esc = key(input, "Escape");
    expect(esc.stopped).toBe(true);
    expect(box.hidden).toBe(true);
    expect(m.view.hits.at(-1)).toEqual({ hits: [], active: -1 });
    vi.useRealTimers();
    await m.handle.dispose();
  });
});

/* ---------------- zoom, keys, pan ---------------- */

describe("zoom and the strip's keys", () => {
  it("zoom chords step the ladder, fit width, and show 100%", async () => {
    const m = await mount();
    m.view.state.set({ ...m.view.state.get(), zoom: 96 / 72 });
    ctrl("=");
    expect(m.view.zooms.at(-1).z).toBeCloseTo((110 / 100) * (96 / 72));
    ctrl("-");
    expect(m.view.zooms.at(-1).z).toBeCloseTo(96 / 72);
    ctrl("0");
    expect(m.view.fits).toEqual(["width"]);
    ctrl("1");
    expect(m.view.zooms.at(-1).z).toBeCloseTo(96 / 72);
    await flush();
    expect(m.$("#pdfed-zoom").textContent).toBe("100%");
    await m.handle.dispose();
  });

  it("the zoom readout opens Fit width / Fit page / 100% / 200%", async () => {
    const m = await mount();
    m.$("#pdfed-zoom").click();
    const items = h.menus.pop()!;
    expect(items.map((i) => i.label)).toEqual(["Fit width", "Fit page", "100%", "200%"]);
    items[1]!.onSelect();
    items[3]!.onSelect();
    expect(m.view.fits).toEqual(["page"]);
    expect(m.view.zooms.at(-1).z).toBeCloseTo((2 * 96) / 72);
    await m.handle.dispose();
  });

  it("Ctrl+wheel zooms at the cursor; a plain wheel scrolls", async () => {
    const m = await mount();
    const plain = new FakeEvent("wheel", { deltaY: 100, deltaMode: 0, ctrlKey: false, clientX: 50, clientY: 60 });
    m.view.el.dispatchEvent(plain);
    expect(m.view.zooms).toEqual([]);
    const wheel = new FakeEvent("wheel", { deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: 50, clientY: 60 });
    m.view.el.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(m.view.zooms[0].z).toBeGreaterThan(1);
    expect(m.view.zooms[0].anchor).toEqual({ clientX: 50, clientY: 60 });
    await m.handle.dispose();
  });

  it("PageDown / PageUp / End / Home step whole pages", async () => {
    const m = await mount();
    key(m.view.el, "PageDown");
    expect(m.view.scrolls).toEqual([1]);
    key(m.view.el, "End");
    key(m.view.el, "PageUp");
    key(m.view.el, "Home");
    expect(m.view.scrolls).toEqual([1, 2, 1, 0]);
    await m.handle.dispose();
  });

  it("the page box jumps to a typed page", async () => {
    const m = await mount();
    const input = m.$("#pdfed-page");
    input.value = "3";
    key(input, "Enter");
    expect(m.view.scrolls).toEqual([2]);
    input.value = "9";
    key(input, "Enter");
    expect(m.view.scrolls).toEqual([2]);
    await m.handle.dispose();
  });

  it("held Space pans the strip ahead of every tool; typing keeps its Space", async () => {
    const m = await mount();
    const tool: string[] = [];
    const overlay = document.createElement("div") as unknown as FakeElement;
    m.view.el.appendChild(overlay);
    overlay.addEventListener("pointerdown", () => tool.push("down"));
    key(win, " ");
    expect(m.view.el.classList.contains("pdfed-pan")).toBe(true);
    m.view.el.scrollTop = 100;
    overlay.dispatchEvent(new FakeEvent("pointerdown", { pointerId: 1, button: 0, clientX: 10, clientY: 50 }));
    overlay.dispatchEvent(new FakeEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 20 }));
    expect(m.view.el.scrollTop).toBe(130);
    expect(tool).toEqual([]);
    overlay.dispatchEvent(new FakeEvent("pointerup", { pointerId: 1 }));
    key(win, " ", {}, "keyup");
    expect(m.view.el.classList.contains("pdfed-pan")).toBe(false);
    overlay.dispatchEvent(new FakeEvent("pointerdown", { pointerId: 2, button: 0 }));
    expect(tool).toEqual(["down"]);
    const input = document.createElement("input") as unknown as FakeElement;
    input.type = "text";
    doc.body.appendChild(input);
    key(input, " ");
    expect(m.view.el.classList.contains("pdfed-pan")).toBe(false);
    await m.handle.dispose();
  });
});

/* ---------------- Home card ---------------- */

describe("the Home card", () => {
  it("is written on leave when the first page changed, from the new first page", async () => {
    const m = await mount();
    const ids = pageIds(m.session.project);
    m.rail.opts.onReorder([ids[2], ids[0], ids[1]]);
    await m.handle.dispose();
    expect(h.covers).toEqual([{ docId: m.session.project.pdf!.sources[0]!.id, index: 2, rotate: 0, max: 512, type: "image/jpeg" }]);
    expect(h.saves).toHaveLength(1);
    // the cover lands before the documents go and before the final save
    expect(h.log.indexOf("cover")).toBeLessThan(h.log.indexOf("destroy:C:/docs/report.pdf"));
  });

  it("is not rewritten for an unchanged project that already has a card", async () => {
    h.recents = [{ path: PROJECT_PATH, thumb: "C:/cache/t.jpg" }];
    const m = await mount();
    await m.handle.dispose();
    expect(h.saves).toEqual([]);
  });

  it("is written for an unchanged project whose card is missing", async () => {
    h.recents = [{ path: PROJECT_PATH }];
    const m = await mount();
    await m.handle.dispose();
    expect(h.saves).toHaveLength(1);
  });

  it("a blank first page gives a white cover of its shape; the window close writes it too", async () => {
    const m = await mount();
    m.ctx.pageSelection.set([0]);
    m.rail.opts.onContextMenu([0], { clientX: 1, clientY: 1 });
    h.menus.pop()!.find((i) => i.label === "Insert blank page after")!.onSelect();
    await flush();
    const ids = pageIds(m.session.project);
    m.rail.opts.onReorder([ids[1], ids[0], ...ids.slice(2)]);
    for (const t of h.closeTasks) await t();
    expect(h.covers).toEqual([]);
    expect(h.saves).toHaveLength(1);
    await m.handle.dispose();
  });
});

/* ---------------- sources ---------------- */

describe("source documents", () => {
  it("a missing source opens the dialog; Locate relinks it and its pages show", async () => {
    h.stats.set("C:/docs/report.pdf", null);
    h.files.set("D:/moved/report.pdf", { pages: 3 });
    h.stats.set("D:/moved/report.pdf", { size: 120, mtimeMs: 9 });
    const m = await mount();
    expect(m.view.pages[0].doc).toBeNull();
    const dialog = doc.body.querySelector(".pdfed-sources")!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector(".relink-row__status")!.textContent).toBe("Missing");
    h.picks.push(["D:/moved/report.pdf"]);
    dialog.querySelector("[data-locate]")!.click();
    await flush();
    await flush();
    expect(m.session.project.pdf!.sources[0]).toMatchObject({ path: "D:/moved/report.pdf", size: 120, mtimeMs: 9, pages: 3 });
    expect(m.view.pages[0].doc?.path).toBe("D:/moved/report.pdf");
    // every row found: the dialog closed itself
    expect(doc.body.querySelector(".pdfed-sources")).toBeNull();
    await m.handle.dispose();
  });

  it("a replacement with too few pages is refused in the row", async () => {
    h.stats.set("C:/docs/report.pdf", null);
    h.files.set("D:/short.pdf", { pages: 1 });
    const m = await mount();
    h.picks.push(["D:/short.pdf"]);
    doc.body.querySelector("[data-locate]")!.click();
    await flush();
    await flush();
    expect(m.session.project.pdf!.sources[0]!.path).toBe("C:/docs/report.pdf");
    expect(doc.body.querySelector(".relink-row__status")!.textContent).toBe("That PDF has 1 page; this project uses 3");
    await m.handle.dispose();
    expect(doc.body.querySelector(".pdfed-sources")).toBeNull();
  });

  it("a password-protected source is listed; Close project leaves through the exits", async () => {
    h.files.set("C:/docs/report.pdf", { pages: 3, password: true });
    const m = await mount(project(), { returnTo: "D:/v/x.pdf" });
    const dialog = doc.body.querySelector(".pdfed-sources")!;
    expect(dialog.querySelector(".relink-row__status")!.textContent).toBe("Protected with a password");
    dialog.querySelector("[data-close-project]")!.click();
    expect(h.navigations).toEqual([{ view: "viewer", path: "D:/v/x.pdf" }]);
    await m.handle.dispose();
  });

  it("a changed source still shows its pages and is listed", async () => {
    h.stats.set("C:/docs/report.pdf", { size: 101, mtimeMs: 5 });
    const m = await mount();
    expect(m.view.pages[0].doc).toBe(h.docs[0]);
    expect(doc.body.querySelector(".relink-row__status")!.textContent).toBe("Changed since it was added");
    await m.handle.dispose();
  });
});

/* ---------------- fixes: leave, form values, selection, stale failure, short sources ---------------- */

describe("ctx.leave", () => {
  it("goes through the exits and carries the viewer's returnTo to another editor", async () => {
    const m = await mount(project(), { returnTo: "D:/v/report.pdf" });
    h.log.length = 0;
    m.ctx.leave({ view: "editor", projectPath: "C:/x/page.trt" });
    expect(h.log).toEqual(["confirmLeave"]);
    expect(h.navigations).toEqual([{ view: "editor", projectPath: "C:/x/page.trt", returnTo: "D:/v/report.pdf" }]);
    await m.handle.dispose();
  });
});

describe("form values on screen", () => {
  it("an undo, a redo or a cleared form re-renders the source's pages; typing never does", async () => {
    vi.useFakeTimers();
    const m = await mount();
    const src = m.session.project.pdf!.sources[0]!.id;
    const ids = pageIds(m.session.project);
    const forms = m.view.opts.forms;
    forms.set(src, "12R", "Jo");
    await flush();
    forms.set(src, "12R", "Joe");
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(m.view.invalidated).toEqual([]);
    m.session.undo();
    await flush();
    expect(forms.get(src, "12R")).toBeUndefined();
    expect(m.view.invalidated).toEqual(ids);
    m.view.invalidated.length = 0;
    m.session.redo();
    await flush();
    expect(m.view.invalidated).toEqual(ids);
    m.view.invalidated.length = 0;
    // Clear form: a commit that drops the source's values
    m.session.commit((p) => ({ ...p, pdf: { ...p.pdf!, forms: {} } }));
    await flush();
    expect(m.view.invalidated).toEqual(ids);
    vi.useRealTimers();
    await m.handle.dispose();
  });
});

describe("the page selection", () => {
  it("stays on its pages through a reorder, an undo and a redo: Delete removes the page selected", async () => {
    const m = await mount();
    const ids = pageIds(m.session.project);
    m.ctx.pageSelection.set([0]);
    m.rail.opts.onReorder([ids[1], ids[2], ids[0]]);
    await flush();
    expect(m.ctx.pageSelection.get()).toEqual([2]);
    ctrl("Z");
    await flush();
    expect(m.ctx.pageSelection.get()).toEqual([0]);
    m.session.redo();
    await flush();
    expect(m.ctx.pageSelection.get()).toEqual([2]);
    key(m.rail.el, "Delete");
    expect(pageIds(m.session.project)).toEqual([ids[1], ids[2]]);
    await m.handle.dispose();
  });
});

describe("a failed mount", () => {
  it("superseded meanwhile leaves the newer screen's root alone", async () => {
    let stale = false;
    h.partThrows = "tools";
    const root = document.createElement("div") as unknown as FakeElement;
    doc.body.appendChild(root);
    const newer = document.createElement("div") as unknown as FakeElement;
    h.partHook = () => {
      root.textContent = "";
      root.appendChild(newer);
      stale = true;
    };
    await mountPdfEditor(root as never, { view: "editor", projectPath: PROJECT_PATH }, () => stale, {
      project: project(),
      missing: [],
      recovered: false,
    });
    await flush();
    expect(root.childNodes).toHaveLength(1);
    expect(root.childNodes[0]).toBe(newer);
    expect(h.toasts).toEqual([]);
    expect(h.navigations).toEqual([]);
    expect(currentSession.get()).toBeNull();
  });
});

describe("a source with fewer pages than the project shows", () => {
  it("is listed as changed; Continue drops the pages it lacks as ONE step, with a toast", async () => {
    h.files.set("C:/docs/report.pdf", { pages: 2 });
    const m = await mount();
    const ids = pageIds(m.session.project);
    expect(m.view.pages[0].doc).toBe(h.docs[0]);
    const dialog = doc.body.querySelector(".pdfed-sources")!;
    expect(dialog.querySelector(".relink-row__status")!.textContent).toMatch(/^Changed: it now has 2 pages; this project uses 3/);
    dialog.querySelector("[data-continue]")!.click();
    await flush();
    expect(pageIds(m.session.project)).toEqual([ids[0], ids[1]]);
    expect(h.toasts).toContain("info:1 page wasn't in the PDF any more and was removed.");
    m.session.undo();
    expect(pageIds(m.session.project)).toEqual(ids);
    expect(m.session.history.canUndo).toBe(false);
    await m.handle.dispose();
  });

  it("the X (like Esc or a click outside) only closes: no page is removed", async () => {
    h.files.set("C:/docs/report.pdf", { pages: 2 });
    const m = await mount();
    const dialog = doc.body.querySelector(".pdfed-sources")!;
    dialog.querySelector(".modal__header button")!.click();
    await flush();
    expect(m.session.project.pdf!.pages).toHaveLength(3);
    expect(m.session.history.canUndo).toBe(false);
    await m.handle.dispose();
  });

  it("Close project drops nothing", async () => {
    h.files.set("C:/docs/report.pdf", { pages: 2 });
    const m = await mount();
    doc.body.querySelector("[data-close-project]")!.click();
    expect(m.session.project.pdf!.pages).toHaveLength(3);
    expect(h.navigations).toEqual([{ view: "home" }]);
    await m.handle.dispose();
  });
});
