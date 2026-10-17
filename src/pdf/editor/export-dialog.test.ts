import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom, settle, type FakeDocument, type FakeElement } from "../../editor/export/dialog-fake-dom";
import { Store } from "../../core/store";
import type { ProjectFile } from "../../core/types";
import { EXPORT_RUNNING_REASON } from "../../core/export-hold";
import { PdfExportError } from "../export/errors";
import type { PdfDoc, PdfEditorCtx } from "../types";

// The PDF export dialog on the export dialogs' fake DOM. The export pipeline,
// the page renderer, the chunked save and the backend are recorders; the
// dialog's own logic (validation, presets, the run hold, the result views)
// is real.

const h = vi.hoisted(() => ({
  toasts: [] as { kind: string; message: string }[],
  settingsWrites: [] as Record<string, unknown>[],
  onDisk: new Set<string>(),
  settings: { lastExportDir: null as string | null, defaultExportDir: null as string | null },
  exportCalls: [] as unknown[][],
  exportImpl: null as null | ((...a: unknown[]) => Promise<unknown>),
  renders: [] as { page: number; w: number; h: number; type: string; quality: number }[],
  saves: [] as { dest: unknown; format: string }[],
  navigations: [] as unknown[],
  created: [] as { name: string; info: unknown }[],
  savedProjects: [] as string[],
  begins: 0,
}));

vi.mock("../../editor/export/export-ipc", () => ({
  pathExists: (p: string) => Promise.resolve(h.onDisk.has(p)),
  saveFileDialog: () => Promise.resolve(null),
  revealInExplorer: () => Promise.resolve(),
  setTaskbarProgress: () => Promise.resolve(),
  clearTaskbarProgress: () => Promise.resolve(),
}));
vi.mock("../export/export", () => ({
  exportPdf: (...args: unknown[]) => {
    h.exportCalls.push(args);
    if (h.exportImpl) return h.exportImpl(...args);
    return Promise.resolve({ path: args[2] as string, pages: 1, bytes: 10 });
  },
}));
vi.mock("./page-image", () => ({
  renderPageImage: (_p: unknown, req: { page: number; w: number; h: number; type: string; quality: number }) => {
    h.renders.push(req);
    return Promise.resolve({ size: 4 });
  },
  saveImageBlob: (dest: { kind: string; path?: string }, format: string) => {
    h.saves.push({ dest, format });
    return Promise.resolve({ path: dest.kind === "user" ? dest.path : "C:\Docs\Taroting\Pasted images\Lease 1.png" });
  },
}));
vi.mock("../../core/ipc", () => ({
  appVersion: () => Promise.resolve("0.0.0"),
  describeError: (e: unknown) => String(e),
  errorDetail: (e: unknown) => {
    const o = e as { code?: unknown; message?: unknown } | null;
    return { code: typeof o?.code === "string" ? o.code : "", message: typeof o?.message === "string" ? o.message : String(e) };
  },
  onJobEvents: () => Promise.resolve(() => {}),
  ipc: {
    pdfSaveBegin: () => {
      h.begins++;
      return Promise.resolve({ token: 1, path: "x" });
    },
    probeMedia: (path: string) => Promise.resolve({ path, kind: "image", width: 816, height: 1056 }),
    newProjectPath: (name: string) => Promise.resolve(`C:\\Docs\\Taroting\\${name}.trt`),
    saveProject: (path: string) => {
      h.savedProjects.push(path);
      return Promise.resolve({ modifiedAt: "" });
    },
  },
}));
vi.mock("../../core/image-project", () => ({
  createPhotoImageProject: (name: string, info: unknown) => {
    h.created.push({ name, info });
    return { name };
  },
}));
vi.mock("../../core/nav", () => ({ navigate: (r: unknown) => void h.navigations.push(r) }));
vi.mock("../../core/session", () => ({
  settingsStore: { get: () => h.settings },
  updateSettings: (patch: Record<string, unknown>) => {
    h.settingsWrites.push(patch);
    return Promise.resolve();
  },
  normalizeHexColor: (v: unknown, fb: string) => (typeof v === "string" ? v : fb),
  ProjectSession: class {},
}));
vi.mock("../../core/app-close", () => ({ registerCloseTask: () => () => {} }));
vi.mock("../../ui/icons", () => ({ icon: () => "" }));
vi.mock("../../ui/errors", () => ({
  detailPane: () => (globalThis as unknown as { document: FakeDocument }).document.createElement("div"),
  recentErrors: () => [],
  recordError: () => {},
}));
vi.mock("../../ui/toast", () => ({
  toast: {
    info: (message: string) => void h.toasts.push({ kind: "info", message }),
    error: (message: string) => void h.toasts.push({ kind: "error", message }),
    refuse: (message: string) => void h.toasts.push({ kind: "refuse", message }),
  },
}));

const dlg = await import("./export-dialog");
const {
  openPdfExportDialog,
  checkPageRange,
  pageImageSize,
  describeExportFailure,
  PDF_EXPORT_MESSAGES,
  RANGE_REVERSED,
  RANGE_NOT_NUMBERS,
  rangeOutside,
  PAGE_IMAGE_MAX_SIDE,
  defaultPdfFolder,
} = dlg;

let doc: FakeDocument;
let uninstall: () => void;

beforeEach(() => {
  ({ doc, uninstall } = installFakeDom());
  h.toasts = [];
  h.settingsWrites = [];
  h.onDisk = new Set(["E:\\Out"]);
  h.settings = { lastExportDir: "E:\\Out", defaultExportDir: null };
  h.exportCalls = [];
  h.exportImpl = null;
  h.renders = [];
  h.saves = [];
  h.navigations = [];
  h.created = [];
  h.savedProjects = [];
  h.begins = 0;
});
afterEach(() => {
  // closes a dialog a test left open (opening one closes the last)
  for (const c of [...doc.body.children]) c.remove();
  uninstall();
});

function project(): ProjectFile {
  return {
    schema: 4,
    kind: "pdf",
    app: "taroting",
    id: "p",
    name: "Lease",
    createdAt: "",
    modifiedAt: "",
    media: [{ id: "m1", kind: "image", path: "C:\\pics\\sig.png" }],
    timeline: { fps: { num: 30, den: 1 }, width: 1, height: 1, tracks: [] },
    export: {} as ProjectFile["export"],
    pdf: {
      sources: [{ id: "s1", path: "C:\\docs\\lease.pdf", size: 1, mtimeMs: 1, pages: 3 }],
      pages: [
        { id: "pg1", src: "s1", page: 0, rotate: 0 },
        { id: "pg2", src: "s1", page: 1, rotate: 90 },
        { id: "pg3", src: null, page: 0, rotate: 0, w: 300, h: 600 },
      ],
      annots: {},
      forms: {},
    },
  } as unknown as ProjectFile;
}

interface Opened {
  s: { project: ProjectFile; replaced: number; blockLeave: string | null; edits: boolean[] };
  $: (sel: string) => FakeElement;
  has: (sel: string) => boolean;
  overlays: (() => void)[];
}

function open(opts?: { pageSlot?: number; tab?: "pdf" | "image" }, hasForms = true): Opened {
  const s = {
    project: project(),
    blockLeave: null as string | null,
    replaced: 0,
    edits: [] as boolean[],
    replace(next: ProjectFile, o?: { edit?: boolean }) {
      this.project = next;
      this.replaced++;
      this.edits.push(o?.edit !== false);
    },
  };
  const docs = new Map<string, PdfDoc>([
    [
      "s1",
      {
        id: "s1",
        path: "C:\\docs\\lease.pdf",
        doc: {},
        numPages: 2,
        pageInfo: async () => ({ w: 612, h: 792, rotate: 0 }),
        destroy: async () => {},
      },
    ],
  ]);
  const overlays: (() => void)[] = [];
  const ctx = {
    session: s,
    view: { state: new Store({ zoom: 1, fit: null, current: 1, count: 3 }) },
    docs,
    hasForms: new Store(hasForms),
    registerOverlay: (c: () => void) => {
      overlays.push(c);
      return () => {
        const i = overlays.indexOf(c);
        if (i >= 0) overlays.splice(i, 1);
      };
    },
  } as unknown as PdfEditorCtx;
  openPdfExportDialog(ctx, opts);
  const backdrop = doc.body.children[doc.body.children.length - 1]!;
  return {
    s,
    overlays,
    has: (sel) => !!backdrop.querySelector(sel),
    $: (sel) => {
      const el = backdrop.querySelector(sel);
      if (!el) throw new Error(`no ${sel}`);
      return el;
    },
  };
}

function pickRange(d: Opened, from: string, to: string): void {
  d.$('[data-range="range"]').click();
  d.$("#px-from").typeText(from);
  d.$("#px-to").typeText(to);
}

/* ---------------- pure helpers ---------------- */

describe("checkPageRange", () => {
  it("accepts an inside range, and a full one as the whole document", () => {
    expect(checkPageRange("2", "3", 5)).toEqual({ ok: true, range: [2, 3] });
    expect(checkPageRange(" 4 ", "4", 5)).toEqual({ ok: true, range: [4, 4] });
    expect(checkPageRange("1", "5", 5)).toEqual({ ok: true, range: undefined });
  });
  it("refuses pages outside the document, reversed ranges and non-numbers", () => {
    expect(checkPageRange("0", "2", 5)).toEqual({ ok: false, error: rangeOutside(5) });
    expect(checkPageRange("2", "6", 5)).toEqual({ ok: false, error: rangeOutside(5) });
    expect(checkPageRange("4", "2", 5)).toEqual({ ok: false, error: RANGE_REVERSED });
    for (const bad of ["", "1.5", "-1", "1e2", "x"]) {
      expect(checkPageRange(bad, "2", 5)).toEqual({ ok: false, error: RANGE_NOT_NUMBERS });
    }
    expect(rangeOutside(1)).toBe("This document has only 1 page.");
  });
});

describe("pageImageSize", () => {
  it("is the page at 96 dpi times the scale, turned by the rotation", () => {
    expect(pageImageSize(612, 792, 0, 100)).toEqual({ w: 816, h: 1056, reduced: false });
    expect(pageImageSize(612, 792, 0, 200)).toEqual({ w: 1632, h: 2112, reduced: false });
    expect(pageImageSize(612, 792, 90, 100)).toEqual({ w: 1056, h: 816, reduced: false });
    expect(pageImageSize(612, 792, 450, 100)).toEqual({ w: 1056, h: 816, reduced: false });
  });
  it("caps the long side at 8000 px", () => {
    const s = pageImageSize(14400, 200, 0, 300);
    expect(s.reduced).toBe(true);
    expect(s.w).toBeLessThanOrEqual(PAGE_IMAGE_MAX_SIDE);
    expect(s.w).toBeGreaterThan(PAGE_IMAGE_MAX_SIDE - 2);
    expect(Math.abs(s.w / s.h - 14400 / 200)).toBeLessThan(1);
  });
  it("caps the area at the canvas limit (16 777 216 px)", () => {
    const s = pageImageSize(2000, 2000, 0, 300);
    expect(s.reduced).toBe(true);
    expect(s.w * s.h).toBeLessThanOrEqual(16_777_216);
    expect(s.w).toBe(s.h);
  });
});

describe("describeExportFailure", () => {
  it("keeps a PdfExportError's own message and falls back to the code's when it has none", () => {
    expect(describeExportFailure(new PdfExportError("source-missing", "lease.pdf is missing."))).toEqual({
      message: "lease.pdf is missing.",
      code: "source-missing",
    });
    for (const code of Object.keys(PDF_EXPORT_MESSAGES) as (keyof typeof PDF_EXPORT_MESSAGES)[]) {
      expect(describeExportFailure(new PdfExportError(code, ""))).toEqual({ message: PDF_EXPORT_MESSAGES[code], code });
    }
  });
  it("says the backend's write refusals plainly", () => {
    expect(describeExportFailure({ code: "bad_input", message: "refused" }).message).toMatch(/project's own files/);
    expect(describeExportFailure({ code: "other", message: "Disk full" }).message).toBe("Disk full");
  });
});

describe("defaultPdfFolder", () => {
  it("last export folder, else the default, else the first source's folder", () => {
    const p = project();
    expect(defaultPdfFolder({ lastExportDir: "E:\\A", defaultExportDir: "E:\\B" }, p)).toBe("E:\\A");
    expect(defaultPdfFolder({ lastExportDir: null, defaultExportDir: "E:\\B" } as never, p)).toBe("E:\\B");
    expect(defaultPdfFolder({ lastExportDir: null, defaultExportDir: null } as never, p)).toBe("C:\\docs");
  });
});

/* ---------------- the dialog: PDF ---------------- */

describe("PDF export", () => {
  it("exports all pages with the flags, through exportPdf, and remembers the folder", async () => {
    const d = open();
    expect(d.$("#px-name").value).toBe("Lease");
    d.$("#px-run").click();
    await settle();
    expect(h.exportCalls).toHaveLength(1);
    const [proj, opts, target, deps, io, onProgress] = h.exportCalls[0]!;
    expect(proj).toBe(d.s.project);
    expect(opts).toEqual({ flattenMarks: false, flattenForms: false, range: undefined });
    expect(target).toBe("E:\\Out\\Lease.pdf");
    expect(deps).toBeUndefined();
    expect(typeof (io as { pdfSaveBegin?: unknown }).pdfSaveBegin).toBe("function");
    expect(typeof onProgress).toBe("function");
    expect(h.settingsWrites).toEqual([{ lastExportDir: "E:\\Out" }]);
    expect(d.has(".export-result__icon--ok")).toBe(true);
    // unchanged flags: nothing written to the project
    expect(d.s.replaced).toBe(0);
  });

  it("a range goes to exportPdf as 1-based [from, to]", async () => {
    const d = open();
    pickRange(d, "2", "3");
    d.$("#px-run").click();
    await settle();
    expect((h.exportCalls[0]![1] as { range: unknown }).range).toEqual([2, 3]);
  });

  it("an invalid range disables Export and says why", () => {
    const d = open();
    pickRange(d, "3", "2");
    expect(d.$("#px-run").disabled).toBe(true);
    expect(d.$("#px-note-range").hidden).toBe(false);
    expect(d.$("#px-note-range").textContent).toBe(RANGE_REVERSED);
    d.$("#px-to").typeText("9");
    expect(d.$("#px-note-range").textContent).toBe(rangeOutside(3));
    d.$("#px-to").typeText("3");
    expect(d.$("#px-run").disabled).toBe(false);
    expect(d.$("#px-note-range").hidden).toBe(true);
  });

  it("opened with a page slot preselects that one page", async () => {
    const d = open({ pageSlot: 1 });
    expect(d.$("#px-from").value).toBe("2");
    expect(d.$("#px-to").value).toBe("2");
    expect(d.$("#px-range-row").classList.contains("export-row--hidden")).toBe(false);
    d.$("#px-run").click();
    await settle();
    expect((h.exportCalls[0]![1] as { range: unknown }).range).toEqual([2, 2]);
  });

  it("changed flags are stored on the project once, as a non-edit", async () => {
    const d = open();
    const fm = d.$("#px-flat-marks");
    fm.checked = true;
    fm.dispatch("change");
    const ff = d.$("#px-flat-forms");
    ff.checked = true;
    ff.dispatch("change");
    d.$("#px-run").click();
    await settle();
    expect(d.s.replaced).toBe(1);
    expect(d.s.edits).toEqual([false]);
    expect(d.s.project.pdf!.export).toEqual({ flattenMarks: true, flattenForms: true });
    expect(h.exportCalls[0]![1]).toEqual({ flattenMarks: true, flattenForms: true, range: undefined });

  });

  it("the flags open on the project's remembered ones", () => {
    const d = open();
    d.$("[data-close]").click();
    // a project that remembers flattenMarks
    const s = {
      project: { ...project(), pdf: { ...project().pdf!, export: { flattenMarks: true, flattenForms: false } } },
      blockLeave: null,
      replace() {},
    };
    openPdfExportDialog(
      {
        session: s,
        view: { state: new Store({ current: 0 }) },
        docs: new Map(),
        hasForms: new Store(true),
        registerOverlay: () => () => {},
      } as unknown as PdfEditorCtx,
    );
    const bd = doc.body.children[doc.body.children.length - 1]!;
    expect(bd.querySelector("#px-flat-marks")!.checked).toBe(true);
    expect(bd.querySelector("#px-flat-forms")!.checked).toBe(false);
  });

  it("Flatten form fields is offered only when the document has forms", () => {
    expect(open(undefined, false).has("#px-flat-forms")).toBe(false);
    expect(open(undefined, true).has("#px-flat-forms")).toBe(true);
  });

  it("holds the leave block while running and releases it on success", async () => {
    let finish: (v: unknown) => void = () => {};
    h.exportImpl = () => new Promise((r) => (finish = r));
    const d = open();
    d.$("#px-run").click();
    await settle();
    expect(d.s.blockLeave).toBe(EXPORT_RUNNING_REASON);
    // Esc is refused while the run is on
    doc.key("Escape");
    expect(d.has("#px-cancel")).toBe(true);
    finish({ path: "E:\\Out\\Lease.pdf", pages: 3, bytes: 1 });
    await settle();
    expect(d.s.blockLeave).toBeNull();
    expect(d.has(".export-result__icon--ok")).toBe(true);
  });

  it("releases the leave block on failure and shows the plain-language message", async () => {
    h.exportImpl = () => Promise.reject(new PdfExportError("font-missing", ""));
    const d = open();
    d.$("#px-run").click();
    await settle();
    expect(d.s.blockLeave).toBeNull();
    expect(d.$(".export-result__msg").textContent).toBe(PDF_EXPORT_MESSAGES["font-missing"]);
  });

  it("Cancel aborts the write: the save IPC refuses once canceled", async () => {
    let release: () => void = () => {};
    h.exportImpl = async (...args: unknown[]) => {
      await new Promise<void>((r) => (release = r));
      const io = args[4] as { pdfSaveBegin(d: unknown, n: number): Promise<unknown> };
      await io.pdfSaveBegin({}, 1);
      return { path: "x" };
    };
    const d = open();
    d.$("#px-run").click();
    await settle();
    d.$("#px-cancel").click();
    expect(d.s.blockLeave).toBe(EXPORT_RUNNING_REASON);
    release();
    await settle();
    expect(d.s.blockLeave).toBeNull();
    expect(h.begins).toBe(0);
    expect(h.toasts).toContainEqual({ kind: "info", message: "Export canceled" });
    expect(d.has("#px-run")).toBe(true);
  });

  it("refuses to write over a source and offers no Replace", async () => {
    h.settings.lastExportDir = "C:\\docs";
    h.onDisk.add("C:\\docs");
    h.onDisk.add("C:\\docs\\lease.pdf");
    const d = open();
    d.$("#px-name").typeText("lease");
    d.$("#px-run").click();
    await settle();
    expect(h.exportCalls).toHaveLength(0);
    expect(d.has('[data-w="rename"]')).toBe(true);
    expect(d.has('[data-w="replace"]')).toBe(false);
  });

  it("Enter runs Export when focus is not in a text field; Esc closes", async () => {
    const d = open();
    doc.focused = null;
    doc.key("Enter");
    await settle();
    expect(h.exportCalls).toHaveLength(1);
    d.$("[data-close-btn]");
    doc.key("Escape");
    expect(doc.body.querySelector(".modal-backdrop")).toBeNull();
  });

  it("Enter in the file name field does not export", async () => {
    const d = open();
    d.$("#px-name").focus();
    doc.key("Enter");
    await settle();
    expect(h.exportCalls).toHaveLength(0);
  });

  it("registers with the editor's overlays; dispose closes it", () => {
    const d = open();
    expect(d.overlays).toHaveLength(1);
    d.overlays[0]!();
    expect(doc.body.querySelector(".modal-backdrop")).toBeNull();
    expect(d.overlays).toHaveLength(0);
  });
});

/* ---------------- the dialog: Image ---------------- */

describe("Image export", () => {
  it("defaults to the current page and shows its pixel size", async () => {
    const d = open({ tab: "image" });
    await settle();
    expect(d.$("#px-page").value).toBe("2"); // view.current = slot 1
    // page 2 is turned 90°: 792 × 612 pt at 96 dpi
    expect(d.$("#px-px").textContent).toBe("1056 × 816 px");
    d.$('[data-scale="300"]').click();
    expect(d.$("#px-px").textContent).toBe("3168 × 2448 px");
  });

  it("pageSlot preselects the page; a blank page uses its own size", async () => {
    const d = open({ tab: "image", pageSlot: 2 });
    await settle();
    expect(d.$("#px-page").value).toBe("3");
    expect(d.$("#px-px").textContent).toBe("400 × 800 px");
    expect(d.$("#px-name").value).toBe("Lease - page 3");
  });

  it("switching tabs from PDF reaches the image form", async () => {
    const d = open();
    d.$('[data-tab="image"]').click();
    await settle();
    expect(d.has("#px-page")).toBe(true);
    expect(d.$("#px-ext").textContent).toBe(".png");
  });

  it("JPEG shows quality and exports with it; the save names every source", async () => {
    const d = open({ tab: "image", pageSlot: 0 });
    await settle();
    expect(d.$("#px-quality-row").classList.contains("export-row--hidden")).toBe(true);
    d.$('[data-format="jpeg"]').click();
    expect(d.$("#px-quality-row").classList.contains("export-row--hidden")).toBe(false);
    expect(d.$("#px-ext").textContent).toBe(".jpg");
    d.$("#px-quality").typeText("70");
    d.$('[data-scale="200"]').click();
    d.$("#px-run").click();
    await settle();
    expect(h.renders).toEqual([{ page: 1, w: 1632, h: 2112, type: "image/jpeg", quality: 70 }]);
    expect(h.saves).toEqual([
      {
        dest: { kind: "user", path: "E:\\Out\\Lease - page 1.jpg", sources: ["C:\\docs\\lease.pdf", "C:\\pics\\sig.png"] },
        format: "jpeg",
      },
    ]);
    expect(h.exportCalls).toHaveLength(0);
    expect(d.has(".export-result__icon--ok")).toBe(true);
  });

  it("a page number outside the document disables Export", async () => {
    const d = open({ tab: "image" });
    await settle();
    d.$("#px-page").typeText("7");
    expect(d.$("#px-run").disabled).toBe(true);
    expect(d.$("#px-note-page").hidden).toBe(false);
  });

  it("Open as image project saves a PNG, makes a permanent project and opens it", async () => {
    const d = open({ tab: "image", pageSlot: 0 });
    await settle();
    d.$("#px-open-image").click();
    await settle();
    expect(h.renders[0]).toMatchObject({ page: 1, type: "image/png" });
    expect(h.saves[0]).toEqual({ dest: { kind: "pasted", projectName: "Lease" }, format: "png" });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.name).toBe("Lease - page 1");
    expect(h.created[0]!.info).toMatchObject({ kind: "image", width: 816 });
    expect(h.savedProjects).toEqual(["C:\\Docs\\Taroting\\Lease - page 1.trt"]);
    expect(h.navigations).toEqual([{ view: "editor", projectPath: "C:\\Docs\\Taroting\\Lease - page 1.trt" }]);
    expect(doc.body.querySelector(".modal-backdrop")).toBeNull();
    expect(d.s.blockLeave).toBeNull();
  });
});

describe("the default export name never names a source", () => {
  it("adds (edited) when folder/name.pdf is a file the project reads", async () => {
    const { nameClearOf } = await import("./export-dialog");
    expect(nameClearOf("form", "C:/fx", [String.raw`C:\fx\form.pdf`])).toBe("form (edited)");
    expect(nameClearOf("form", "C:/fx", ["c:/FX/form.pdf", "C:/fx/form (edited).pdf"])).toBe("form (edited 2)");
    expect(nameClearOf("form", "D:/out", ["C:/fx/form.pdf"])).toBe("form");
  });
});
