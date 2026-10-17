import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom, settle, type FakeDocument, type FakeElement } from "../../editor/export/dialog-fake-dom";
import { Store } from "../../core/store";
import type { ActionId, PdfFormValue, ProjectFile } from "../../core/types";
import type { PdfDoc, PdfEditorCtx, PdfEditorHosts, PdfToolState } from "../types";

// The Fill forms part mounted on the export dialogs' fake DOM, with a fake
// view, session and documents. Detection runs on a timer here (node has no
// requestIdleCallback), after the view's first `pagerendered`.

const h = vi.hoisted(() => ({
  toasts: [] as string[],
  shortcuts: { pdfFillForms: "F" } as Record<string, string>,
}));

vi.mock("../../core/session", () => ({
  settingsStore: { get: () => ({ shortcuts: h.shortcuts }), subscribe: () => () => {} },
  normalizeHexColor: (v: unknown, fb: string) => (typeof v === "string" ? v : fb),
}));
vi.mock("../../ui/toast", () => ({
  toast: {
    info: (m: string) => void h.toasts.push(m),
    error: (m: string) => void h.toasts.push(m),
    refuse: (m: string) => void h.toasts.push(m),
  },
}));
vi.mock("../../image/icons", () => ({ imgIcon: () => "" }));

const forms = await import("./forms");
const { formsPart, FORMS_HINT, XFA_TOAST, clearAllFormValues, detectForms, resetFormsSessionState } = forms;

let doc: FakeDocument;
let uninstall: () => void;

beforeEach(() => {
  ({ doc, uninstall } = installFakeDom());
  h.toasts = [];
  resetFormsSessionState();
});
afterEach(() => uninstall());

function project(forms: Record<string, Record<string, PdfFormValue>> = {}): ProjectFile {
  return {
    schema: 4,
    kind: "pdf",
    app: "taroting",
    id: "p",
    name: "Lease",
    createdAt: "",
    modifiedAt: "",
    media: [],
    timeline: { fps: { num: 30, den: 1 }, width: 1, height: 1, tracks: [] },
    export: {} as ProjectFile["export"],
    pdf: {
      sources: [{ id: "s1", path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: 2 }],
      pages: [
        { id: "pg1", src: "s1", page: 0, rotate: 0 },
        { id: "pg2", src: "s1", page: 1, rotate: 0 },
      ],
      annots: {},
      forms,
    },
  } as ProjectFile;
}

function fakeDoc(id: string, proxy: object): PdfDoc {
  return { id, path: `C:\\${id}.pdf`, doc: proxy, numPages: 2, pageInfo: async () => ({ w: 1, h: 1, rotate: 0 }), destroy: async () => {} };
}

function setup(opts: { docs?: PdfDoc[]; hasForms?: boolean; mode?: "annotate" | "forms"; forms?: Record<string, Record<string, PdfFormValue>> } = {}) {
  const store = new Store<ProjectFile>(project(opts.forms));
  let commits = 0;
  const session = {
    store,
    get project() {
      return store.get();
    },
    commit(fn: (p: ProjectFile) => ProjectFile) {
      const next = fn(store.get());
      if (next === store.get()) return;
      commits++;
      store.set(next);
    },
  };
  const rendered = new Set<(e: unknown) => void>();
  const view = {
    setFormsLayer: vi.fn(),
    invalidate: vi.fn(),
    on: (type: string, fn: (e: unknown) => void) => {
      if (type !== "pagerendered") return () => {};
      rendered.add(fn);
      return () => rendered.delete(fn);
    },
  };
  const keys = new Map<ActionId, (e: KeyboardEvent) => void>();
  let typing = false;
  const ctx = {
    session,
    view,
    docs: new Map((opts.docs ?? []).map((d) => [d.id, d])),
    tools: new Store<PdfToolState>({ tool: "pen" } as PdfToolState),
    selection: new Store([{ key: "pg1", id: "a1" }]),
    pageSelection: new Store<number[]>([]),
    mode: new Store<"annotate" | "forms">(opts.mode ?? "annotate"),
    hasForms: new Store(opts.hasForms ?? false),
    holdAutosave: () => () => {},
    registerOverlay: () => () => {},
    bindKey: (a: ActionId, fn: (e: KeyboardEvent) => void) => {
      keys.set(a, fn);
      return () => keys.delete(a);
    },
    isTyping: () => typing,
  } as unknown as PdfEditorCtx;
  const topbar = doc.createElement("div");
  doc.body.appendChild(topbar);
  const hosts = { toolbar: doc.createElement("div"), inspector: doc.createElement("div"), topbar } as unknown as PdfEditorHosts;
  const part = formsPart(ctx, hosts);
  const $ = (sel: string): FakeElement => {
    const el = topbar.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    return el;
  };
  return {
    ctx,
    view,
    part,
    keys,
    $,
    topbar,
    commits: () => commits,
    setTyping: (v: boolean) => (typing = v),
    paint: () => {
      for (const fn of [...rendered]) fn({ key: "pg1" });
    },
    wrap: () => topbar.querySelector(".pdfed-forms")!,
  };
}

function pressF(t: ReturnType<typeof setup>): void {
  const fn = t.keys.get("pdfFillForms");
  if (!fn) throw new Error("pdfFillForms not bound");
  fn({ target: null, preventDefault() {} } as unknown as KeyboardEvent);
}

function flipSwitch(t: ReturnType<typeof setup>, on: boolean): void {
  const sw = t.$("#pdfed-fill-forms");
  sw.checked = on;
  sw.dispatch("change");
}

const withFields = (): object => ({ getFieldObjects: async () => new Map([["name", [{ id: "12R" }]]]) });
const noFields = (): object => ({ getFieldObjects: async () => null, getMetadata: async () => ({ info: {} }) });
const xfaOnly = (): object => ({ getFieldObjects: async () => null, getMetadata: async () => ({ info: { IsXFAPresent: true } }) });

describe("Fill forms switch: visibility", () => {
  it("is hidden while no document has fields and shown when hasForms turns true", async () => {
    const t = setup();
    expect(t.wrap().hidden).toBe(true);
    t.ctx.hasForms.set(true);
    await settle();
    expect(t.wrap().hidden).toBe(false);
    expect(t.$(".pdfed-forms__switch").title).toBe("Fill forms (F)");
    t.part.dispose();
  });

  it("detects fillable fields after the first page paints, not before", async () => {
    const t = setup({ docs: [fakeDoc("s1", withFields())] });
    await settle();
    expect(t.ctx.hasForms.get()).toBe(false);
    t.paint();
    await settle();
    expect(t.ctx.hasForms.get()).toBe(true);
    expect(t.wrap().hidden).toBe(false);
    t.part.dispose();
  });

  it("a document without fields leaves the switch hidden", async () => {
    const t = setup({ docs: [fakeDoc("s1", noFields())] });
    t.paint();
    await settle();
    expect(t.ctx.hasForms.get()).toBe(false);
    expect(t.wrap().hidden).toBe(true);
    expect(h.toasts).toEqual([]);
    t.part.dispose();
  });

  it("an XFA-only document is not counted and says so once, even across remounts", async () => {
    const proxy = xfaOnly();
    const a = setup({ docs: [fakeDoc("s1", proxy)] });
    a.paint();
    await settle();
    expect(a.ctx.hasForms.get()).toBe(false);
    expect(h.toasts).toEqual([XFA_TOAST]);
    a.part.dispose();
    const b = setup({ docs: [fakeDoc("s1", proxy)] });
    b.paint();
    await settle();
    expect(h.toasts).toEqual([XFA_TOAST]);
    b.part.dispose();
  });

  it("a source added later is asked too", async () => {
    const t = setup({ docs: [fakeDoc("s1", noFields())] });
    t.paint();
    await settle();
    expect(t.ctx.hasForms.get()).toBe(false);
    (t.ctx.docs as Map<string, PdfDoc>).set("s2", fakeDoc("s2", withFields()));
    const p = t.ctx.session.project;
    t.ctx.session.store.set({ ...p, pdf: { ...p.pdf!, sources: [...p.pdf!.sources] } });
    await settle();
    expect(t.ctx.hasForms.get()).toBe(true);
    t.part.dispose();
  });
});

describe("detectForms", () => {
  it("reads pdf.js 6's Map and an older plain object; a pure XFA flag; failures as none", async () => {
    expect(await detectForms(withFields())).toBe("fields");
    expect(await detectForms({ getFieldObjects: async () => ({ a: [{}] }) })).toBe("fields");
    expect(await detectForms({ getFieldObjects: async () => new Map() })).toBe("none");
    expect(await detectForms({ getFieldObjects: async () => null, isPureXfa: true })).toBe("xfa");
    expect(await detectForms(xfaOnly())).toBe("xfa");
    expect(await detectForms({ getFieldObjects: async () => Promise.reject(new Error("x")) })).toBe("none");
    expect(await detectForms(null)).toBe("none");
  });
});

describe("Fill forms mode", () => {
  it("opens off even when the store said forms", () => {
    const t = setup({ hasForms: true, mode: "forms" });
    expect(t.ctx.mode.get()).toBe("annotate");
    expect(t.$("#pdfed-fill-forms").checked).toBe(false);
    expect(t.view.setFormsLayer).toHaveBeenLastCalledWith(false);
    t.part.dispose();
  });

  it("the switch turns the forms layer on and off, ends selection and the active tool", () => {
    const t = setup({ hasForms: true });
    t.view.setFormsLayer.mockClear();
    flipSwitch(t, true);
    expect(t.ctx.mode.get()).toBe("forms");
    expect(t.view.setFormsLayer).toHaveBeenLastCalledWith(true);
    expect(t.ctx.selection.get()).toEqual([]);
    expect(t.ctx.tools.get().tool).toBe("select");
    expect(t.$("#pdfed-clear-form").hidden).toBe(false);
    flipSwitch(t, false);
    expect(t.ctx.mode.get()).toBe("annotate");
    expect(t.view.setFormsLayer).toHaveBeenLastCalledWith(false);
    expect(t.$("#pdfed-clear-form").hidden).toBe(true);
    t.part.dispose();
  });

  it("shows the hint once per session", () => {
    const t = setup({ hasForms: true });
    flipSwitch(t, true);
    flipSwitch(t, false);
    flipSwitch(t, true);
    expect(h.toasts.filter((m) => m === FORMS_HINT)).toHaveLength(1);
    t.part.dispose();
  });

  it("F toggles the mode through bindKey; does nothing without forms or while typing", () => {
    const t = setup({ hasForms: false });
    pressF(t);
    expect(t.ctx.mode.get()).toBe("annotate");
    t.ctx.hasForms.set(true);
    t.setTyping(true);
    pressF(t);
    expect(t.ctx.mode.get()).toBe("annotate");
    t.setTyping(false);
    pressF(t);
    expect(t.ctx.mode.get()).toBe("forms");
    expect(t.view.setFormsLayer).toHaveBeenLastCalledWith(true);
    pressF(t);
    expect(t.ctx.mode.get()).toBe("annotate");
    t.part.dispose();
    expect(t.keys.has("pdfFillForms")).toBe(false);
  });

  it("dispose turns the mode off and removes the switch", () => {
    const t = setup({ hasForms: true });
    flipSwitch(t, true);
    t.part.dispose();
    expect(t.ctx.mode.get()).toBe("annotate");
    expect(t.view.setFormsLayer).toHaveBeenLastCalledWith(false);
    expect(t.topbar.querySelector(".pdfed-forms")).toBeNull();
  });
});

describe("Clear form", () => {
  it("clears every value in ONE history step and re-renders the pages", () => {
    const t = setup({ hasForms: true, forms: { s1: { "12R": "Ada", "13R": true } } });
    flipSwitch(t, true);
    t.$("#pdfed-clear-form").click();
    expect(t.commits()).toBe(1);
    expect(Object.keys(t.ctx.session.project.pdf!.forms)).toEqual([]);
    expect(t.view.invalidate).toHaveBeenCalledWith("pg1");
    expect(t.view.invalidate).toHaveBeenCalledWith("pg2");
    // nothing left: no second step
    t.$("#pdfed-clear-form").click();
    expect(t.commits()).toBe(1);
    t.part.dispose();
  });

  it("clearAllFormValues returns the project itself when there is nothing to clear", () => {
    const p = project();
    expect(clearAllFormValues(p)).toBe(p);
    const q = project({ s1: { a: "x" } });
    const r = clearAllFormValues(q);
    expect(r).not.toBe(q);
    expect(r.pdf!.forms).toEqual({});
    expect(r.pdf!.pages).toBe(q.pdf!.pages);
  });
});
