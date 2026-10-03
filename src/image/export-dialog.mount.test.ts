import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSession } from "../core/session";
import type { ProjectFile } from "../core/types";
import { DEFAULT_EXPORT_PRESET } from "../core/types";
import { installFakeDom, settle, type FakeDocument, type FakeElement } from "../editor/export/dialog-fake-dom";
import type { ImageEditorCtx } from "./context";

// The image export dialog mounted against the video dialog's fake DOM, with
// the render, the save and the settings replaced by recorders. A 641×361
// canvas, so a percentage, a typed side and its aspect-locked partner are
// three different numbers.

const h = vi.hoisted(() => ({
  toasts: [] as { kind: string; message: string }[],
  settingsWrites: [] as Record<string, unknown>[],
  onDisk: new Set<string>(),
  renders: 0,
  settings: { lastExportDir: null as string | null, defaultExportDir: null as string | null },
}));

vi.mock("../editor/export/export-ipc", () => ({
  pathExists: (p: string) => Promise.resolve(h.onDisk.has(p)),
  saveFileDialog: () => Promise.resolve(null),
  revealInExplorer: () => Promise.resolve(),
  setTaskbarProgress: () => Promise.resolve(),
  clearTaskbarProgress: () => Promise.resolve(),
}));
vi.mock("./render/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./render/export")>()),
  // Never finishes on its own: the progress view stays up until aborted.
  renderImageExport: (_d: unknown, _o: unknown, signal: AbortSignal) => {
    h.renders++;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  },
}));
vi.mock("./save", () => ({ saveBlob: () => Promise.resolve({ path: "" }) }));
vi.mock("../core/ipc", () => ({
  appVersion: () => Promise.resolve("0.0.0"),
  describeError: (e: unknown) => String(e),
  errorDetail: (e: unknown) => ({ code: "", message: String(e) }),
  ipc: {},
  onJobEvents: () => Promise.resolve(() => {}),
}));
vi.mock("../core/session", () => ({
  settingsStore: { get: () => h.settings },
  updateSettings: (patch: Record<string, unknown>) => {
    h.settingsWrites.push(patch);
    return Promise.resolve();
  },
  ProjectSession: class {},
}));
vi.mock("../core/app-close", () => ({ registerCloseTask: () => () => {} }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../ui/errors", () => ({
  detailPane: () => (globalThis as unknown as { document: FakeDocument }).document.createElement("div"),
  recentErrors: () => [],
  recordError: () => {},
}));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (message: string) => void h.toasts.push({ kind: "info", message }),
    error: (message: string) => void h.toasts.push({ kind: "error", message }),
    refuse: (message: string) => void h.toasts.push({ kind: "refuse", message }),
  },
}));

const { openImageExportDialog, SIZE_INVALID } = await import("./export-dialog");
const { MISSING_FOLDER } = await import("../editor/export/export-dialog");

let doc: FakeDocument;
let uninstall: () => void;
let closer: (() => void) | null = null;

beforeEach(() => {
  ({ doc, uninstall } = installFakeDom());
  h.toasts = [];
  h.settingsWrites = [];
  h.onDisk = new Set();
  h.renders = 0;
  h.settings = { lastExportDir: null, defaultExportDir: null };
});
afterEach(() => {
  closer?.();
  closer = null;
  uninstall();
});

function project(): ProjectFile {
  return {
    schema: 3,
    kind: "image",
    app: "taroting",
    id: "p1",
    name: "Harbour at dusk",
    createdAt: "",
    modifiedAt: "",
    media: [],
    timeline: { fps: { num: 30, den: 1 }, width: 641, height: 361, tracks: [] },
    export: DEFAULT_EXPORT_PRESET,
    image: { background: "transparent" },
  };
}

function open(): { s: { project: ProjectFile; replaced: number }; $: (sel: string) => FakeElement } {
  const s = {
    project: project(),
    blockLeave: null as string | null,
    replaced: 0,
    replace(next: ProjectFile) {
      this.project = next;
      this.replaced++;
    },
  };
  const ctx = { session: s as unknown as ProjectSession, registerOverlay: () => () => {} } as unknown as ImageEditorCtx;
  closer = openImageExportDialog(ctx, { stem: "IMG_0042", ext: "png" });
  const backdrop = doc.body.children[doc.body.children.length - 1]!;
  return {
    s,
    $: (sel) => {
      const el = backdrop.querySelector(sel);
      if (!el) throw new Error(`no ${sel}`);
      return el;
    },
  };
}

function chooseCustom(d: ReturnType<typeof open>): void {
  const sel = d.$("#ix-size");
  sel.value = "custom";
  sel.dispatch("change");
}

describe("image export: a custom size box that does not hold whole pixels (C123)", () => {
  it("a cleared Width disables Export and leaves the other box and the size alone", () => {
    const d = open();
    chooseCustom(d);
    expect(d.$("#ix-w").value).toBe("641");
    d.$("#ix-w").typeText("");
    expect(d.$("#ix-w").getAttribute("aria-invalid")).toBe("true");
    expect(d.$("#ix-h").value).toBe("361");
    expect(d.$("#ix-run").disabled).toBe(true);
    expect(d.$("#ix-note-size").hidden).toBe(false);
    expect(d.$("#ix-note-size").textContent).toBe(SIZE_INVALID);
    // A click on the disabled button does nothing, and nothing is saved.
    d.$("#ix-run").click();
    expect(d.s.replaced).toBe(0);
  });

  it("refuses fractions and signs the same way, and recovers when the box parses again", () => {
    const d = open();
    chooseCustom(d);
    for (const bad of ["12.5", "-3", "1e4", "abc"]) {
      d.$("#ix-h").typeText(bad);
      expect(d.$("#ix-run").disabled, bad).toBe(true);
      expect(d.$("#ix-w").value, bad).toBe("641");
    }
    d.$("#ix-h").typeText("722");
    expect(d.$("#ix-h").hasAttribute("aria-invalid")).toBe(false);
    expect(d.$("#ix-w").value).toBe("1282");
    expect(d.$("#ix-run").disabled).toBe(false);
    expect(d.$("#ix-note-size").hidden).toBe(true);
  });
});

describe("image export: the destination (C116)", () => {
  it("refuses a relative folder and a missing one before saving anything", async () => {
    const d = open();
    d.$("#ix-folder").typeText("exports");
    d.$("#ix-run").click();
    await settle();
    d.$("#ix-folder").typeText("E:\\Nowhere");
    d.$("#ix-run").click();
    await settle();
    expect(h.toasts).toEqual([
      { kind: "refuse", message: "Enter a full folder path, like C:\\Videos, or choose one." },
      { kind: "refuse", message: MISSING_FOLDER },
    ]);
    expect(h.settingsWrites).toEqual([]);
    expect(d.s.replaced).toBe(0);
    expect(h.renders).toBe(0);
  });
});

describe("image export: focus and the progress view", () => {
  it("Cancel on the overwrite strip puts focus on Export (C118)", async () => {
    h.onDisk.add("E:\\Out");
    h.onDisk.add("E:\\Out\\IMG_0042 (edited).png");
    const d = open();
    d.$("#ix-folder").typeText("E:\\Out");
    d.$("#ix-run").click();
    await settle();
    const cancel = d.$('[data-w="cancel"]');
    cancel.focus();
    cancel.click();
    expect(doc.activeElement.id).toBe("ix-run");
  });

  it("progress Cancel is a plain button, not destructive red (C119)", async () => {
    h.onDisk.add("E:\\Out");
    const d = open();
    d.$("#ix-folder").typeText("E:\\Out");
    d.$("#ix-run").click();
    await settle();
    expect(h.renders).toBe(1);
    const cancel = d.$("#ix-cancel");
    expect(cancel.className).toBe("btn");
    expect(h.settingsWrites).toEqual([{ lastExportDir: "E:\\Out" }]);
  });
});
