import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSession } from "../../core/session";
import type { MediaRef, ProjectFile } from "../../core/types";
import { DEFAULT_EXPORT_PRESET } from "../../core/types";
import { installFakeDom, settle, type FakeDocument, type FakeElement } from "./dialog-fake-dom";

// The video export dialog mounted against the fake DOM in ./dialog-fake-dom,
// with the backend (export-ipc, core/ipc) and settings replaced by recorders.
// These are the behaviours that live inside the dialog's closure: what it
// renders from a crafted preset, what it persists (and when), where focus
// lands, and what the result views say.

const h = vi.hoisted(() => ({
  toasts: [] as { kind: string; message: string }[],
  settingsWrites: [] as Record<string, unknown>[],
  estimates: [] as Record<string, unknown>[],
  /** Paths `pathExists` answers true for. */
  onDisk: new Set<string>(),
  jobs: null as null | {
    onDone?: (e: { id: number; kind: string; output: Record<string, unknown> }) => void;
  },
  settings: { lastExportDir: null as string | null, defaultExportDir: null as string | null, hardwareAccel: true },
}));

vi.mock("./export-ipc", () => ({
  detectEncoders: () => Promise.resolve({ h264: "h264_nvenc", hevc: "hevc_nvenc", av1: "libsvtav1", detail: [] }),
  estimateExport: (input: Record<string, unknown>) => {
    h.estimates.push(input);
    return Promise.resolve({ bytes: 1000, exact: false });
  },
  pathExists: (p: string) => Promise.resolve(h.onDisk.has(p)),
  saveFileDialog: () => Promise.resolve(null),
  startExport: () => Promise.resolve(7),
  cancelJob: () => Promise.resolve(true),
  revealInExplorer: () => Promise.resolve(),
  setTaskbarProgress: () => Promise.resolve(),
  clearTaskbarProgress: () => Promise.resolve(),
}));
vi.mock("../../core/ipc", () => ({
  appVersion: () => Promise.resolve("0.0.0"),
  describeError: (e: unknown) => String(e),
  errorDetail: (e: unknown) => ({ code: "", message: String(e) }),
  ipc: { exportFailureReport: () => Promise.reject(new Error("n/a")), saveDiagnosticReport: () => Promise.resolve("") },
  onJobEvents: (handlers: typeof h.jobs) => {
    h.jobs = handlers;
    return Promise.resolve(() => {});
  },
}));
vi.mock("../../core/session", () => ({
  settingsStore: { get: () => h.settings },
  updateSettings: (patch: Record<string, unknown>) => {
    h.settingsWrites.push(patch);
    return Promise.resolve();
  },
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

const { openExportDialog, HW_FALLBACK_NOTE, MISSING_FOLDER } = await import("./export-dialog");

let doc: FakeDocument;
let uninstall: () => void;
let closer: (() => void) | null = null;

beforeEach(() => {
  ({ doc, uninstall } = installFakeDom());
  h.toasts = [];
  h.settingsWrites = [];
  h.estimates = [];
  h.onDisk = new Set();
  h.jobs = null;
  h.settings = { lastExportDir: null, defaultExportDir: null, hardwareAccel: true };
});
afterEach(() => {
  closer?.();
  closer = null;
  uninstall();
});

const video = (id: string, hasAudio: boolean): MediaRef => ({
  id,
  path: `D:\\Footage\\${id}.mp4`,
  size: 1,
  mtimeMs: 1,
  kind: "video",
  duration: 10,
  hasAudio,
  width: 1280,
  height: 720,
});
const textMedia = (id: string, text: string): MediaRef => ({
  id,
  path: "Text",
  size: 0,
  mtimeMs: 0,
  kind: "image",
  duration: 5,
  hasAudio: false,
  width: 400,
  height: 90,
  generator: { type: "text", text, fontFamily: "Arial", sizePx: 64, color: "#ffffff", bold: false, italic: false },
});

function project(over: { export?: unknown; media?: MediaRef[]; mediaId?: string } = {}): ProjectFile {
  const media = over.media ?? [video("clip", false)];
  return {
    schema: 2,
    app: "taroting",
    id: "p1",
    name: "Harbour cut",
    createdAt: "",
    modifiedAt: "",
    media,
    timeline: {
      fps: { num: 30, den: 1 },
      width: 1280,
      height: 720,
      tracks: [
        {
          id: "v1",
          kind: "video",
          name: "V1",
          muted: false,
          clips: [
            {
              id: "c1",
              mediaId: over.mediaId ?? media[0]!.id,
              timelineStart: 0,
              srcIn: 0,
              srcOut: 4,
              speed: 1,
              audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
            },
          ],
        },
      ],
    },
    export: ("export" in over ? over.export : { ...DEFAULT_EXPORT_PRESET }) as ProjectFile["export"],
  } as ProjectFile;
}

interface FakeSession {
  project: ProjectFile;
  blockLeave: string | null;
  replaced: number;
  replace(p: ProjectFile): void;
}

function open(p: ProjectFile = project()): { s: FakeSession; $: (sel: string) => FakeElement } {
  const s: FakeSession = {
    project: p,
    blockLeave: null,
    replaced: 0,
    replace(next) {
      this.project = next;
      this.replaced++;
    },
  };
  closer = openExportDialog({ session: s as unknown as ProjectSession });
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

/** Destination field + Export click, then let the async flow run. */
async function exportTo(d: ReturnType<typeof open>, folder: string): Promise<void> {
  d.$("#ex-folder").typeText(folder);
  d.$("#ex-run").click();
  await settle();
}

describe("export dialog: a crafted preset (C115)", () => {
  it("renders a crafted preset as plain values, adding no markup of its own", () => {
    const d = open(
      project({
        export: {
          format: "mp4",
          vcodec: "h264",
          resolution: { w: '640" onfocus="x', h: 360 },
          fps: '30" autofocus data-pwn="1',
          videoBitrate: '8000"><img src=x>',
          audioBitrate: '<b id="injected">',
          useHardware: true,
        },
      }),
    );
    const all = doc.body.querySelectorAll("*");
    for (const el of all) {
      for (const a of el.attributeNames()) expect(["onfocus", "autofocus", "data-pwn"], a).not.toContain(a);
    }
    expect(doc.body.querySelectorAll("img")).toHaveLength(0);
    expect(doc.body.querySelector("#injected")).toBeNull();
    // The form is all there, on its defaults for the fields that were garbage.
    expect(d.$("#ex-res").value).toBe("original");
    expect(d.$("#ex-fps").value).toBe("original");
    expect(d.$("#ex-vbr-mode").value).toBe("auto");
  });

  it("opens on defaults for a null preset and a null resolution instead of throwing or painting nothing", () => {
    const a = open(project({ export: null }));
    expect(a.$("#ex-name").value).toBe("Harbour cut");
    closer!();
    const b = open(project({ export: { ...DEFAULT_EXPORT_PRESET, resolution: null } }));
    expect(b.$("#ex-res").value).toBe("original");
    expect(b.$("#ex-run")).toBeTruthy();
  });
});

describe("export dialog: the destination (C116)", () => {
  it("refuses a folder that is not a full path, and remembers nothing", async () => {
    const d = open();
    await exportTo(d, "Videos");
    expect(h.toasts).toEqual([{ kind: "refuse", message: "Enter a full folder path, like C:\\Videos, or choose one." }]);
    expect(h.settingsWrites).toEqual([]);
    expect(d.s.replaced).toBe(0);
    expect(h.jobs).toBeNull();
  });

  it("refuses a full path to a folder that does not exist, and remembers nothing", async () => {
    const d = open();
    await exportTo(d, "E:\\Nowhere");
    expect(h.toasts).toEqual([{ kind: "refuse", message: MISSING_FOLDER }]);
    expect(h.settingsWrites).toEqual([]);
    expect(d.s.replaced).toBe(0);
  });

  it("remembers a folder that exists, then exports into it", async () => {
    h.onDisk.add("E:\\Out");
    const d = open();
    await exportTo(d, "E:\\Out");
    expect(h.toasts).toEqual([]);
    expect(h.settingsWrites).toEqual([{ lastExportDir: "E:\\Out" }]);
    expect(d.s.replaced).toBe(1);
    expect(d.$("#ex-cancel")).toBeTruthy();
  });

  it("refuses an empty file name as a refusal, not a recorded error", async () => {
    h.onDisk.add("E:\\Out");
    const d = open();
    d.$("#ex-name").typeText("");
    await exportTo(d, "E:\\Out");
    expect(h.toasts).toEqual([{ kind: "refuse", message: "Please enter a file name." }]);
  });
});

describe("export dialog: the overwrite strip keeps focus inside (C118)", () => {
  it("Cancel on the strip puts focus on Export, not on <body>", async () => {
    h.onDisk.add("E:\\Out");
    h.onDisk.add("E:\\Out\\Harbour cut.mp4");
    const d = open();
    await exportTo(d, "E:\\Out");
    const cancel = d.$('[data-w="cancel"]');
    cancel.focus();
    cancel.click();
    expect(doc.body.querySelector('[data-w="cancel"]')).toBeNull();
    expect(doc.activeElement.id).toBe("ex-run");
  });

  it("Rename with no free name left keeps focus inside and writes nothing", async () => {
    h.onDisk.add("E:\\Out");
    h.onDisk.add("E:\\Out\\Harbour cut.mp4");
    const d = open();
    await exportTo(d, "E:\\Out");
    // Every numbered candidate is taken too.
    const real = h.onDisk;
    h.onDisk = { has: (p: string) => p.startsWith("E:\\Out") } as unknown as Set<string>;
    const rename = d.$('[data-w="rename"]');
    rename.focus();
    rename.click();
    await settle(40);
    h.onDisk = real;
    expect(h.toasts.map((t) => t.message)).toContain("Couldn't find a free file name.");
    expect(doc.activeElement.id).toBe("ex-run");
    expect(h.jobs).toBeNull();
  });
});

describe("export dialog: the running and finished views", () => {
  async function run(d: ReturnType<typeof open>): Promise<void> {
    h.onDisk.add("E:\\Out");
    await exportTo(d, "E:\\Out");
  }

  it("progress Cancel is a plain button, not destructive red (C119)", async () => {
    const d = open();
    await run(d);
    const cancel = d.$("#ex-cancel");
    expect(cancel.className.split(" ")).toContain("btn");
    expect(cancel.className).not.toContain("btn--danger");
    expect(doc.activeElement.id).toBe("ex-cancel");
  });

  it("says so, calmly, when the backend redid a hardware export in software (C120)", async () => {
    const d = open();
    await run(d);
    h.jobs!.onDone!({ id: 7, kind: "export", output: { path: "E:\\Out\\Harbour cut.mp4", hwFallback: true } });
    expect(d.$("#ex-hw-fallback").textContent).toBe(HW_FALLBACK_NOTE);
    // A note, not a choice: Reveal and Close are the only buttons.
    expect(d.$("#ex-footer").querySelectorAll("button").map((b) => b.textContent)).toEqual(["Reveal in Explorer", "Close"]);
  });

  it("says nothing extra after an ordinary export", async () => {
    const d = open();
    await run(d);
    h.jobs!.onDone!({ id: 7, kind: "export", output: { path: "E:\\Out\\Harbour cut.mp4" } });
    expect(doc.body.querySelector("#ex-hw-fallback")).toBeNull();
    expect(doc.body.querySelector(".export-result__title")!.textContent).toBe("Exported");
  });
});

describe("export dialog: the estimate is told about silence (C121)", () => {
  it("sends hasAudio false for a project with no audible clip, and true once one is", async () => {
    open(project({ media: [video("clip", false)] }));
    await new Promise((r) => setTimeout(r, 350));
    expect(h.estimates.at(-1)!.hasAudio).toBe(false);
    closer!();
    open(project({ media: [video("clip", true)] }));
    await new Promise((r) => setTimeout(r, 350));
    expect(h.estimates.at(-1)!.hasAudio).toBe(true);
  });
});

describe("export dialog: text the export font cannot draw (C122)", () => {
  it("shows a note quoting the characters, and leaves Export alone", () => {
    const d = open(project({ media: [textMedia("t", "Party 🎉 time")] }));
    const note = d.$("#ex-glyph-note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("🎉");
    expect(d.$("#ex-run").disabled).toBe(false);
  });

  it("stays hidden for text the font draws", () => {
    const d = open(project({ media: [textMedia("t", "Party time — Ωmega")] }));
    expect(d.$("#ex-glyph-note").hidden).toBe(true);
  });
});
