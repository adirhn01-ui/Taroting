import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import { Store } from "../core/store";
import type { MediaInfo, ProjectFile } from "../core/types";

// The paste's own flow, with the disk, the probe and the toasts faked: what is
// under test is which of them it waits for and what it re-checks after.
const saved = vi.hoisted(() => ({ resolve: null as null | ((v: { path: string }) => void) }));
const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[], refuse: [] as string[] }));
/** what the probe says the saved file is */
const probe = vi.hoisted(() => ({ kind: "image" }));
vi.mock("./save", () => ({
  saveBlob: () =>
    new Promise<{ path: string }>((r) => {
      saved.resolve = r;
    }),
}));
vi.mock("../core/ipc", () => ({
  describeError: (e: unknown) => String(e),
  ipc: {
    probeMedia: async (path: string): Promise<MediaInfo> => ({
      path,
      size: 1,
      mtimeMs: 1,
      kind: probe.kind as MediaInfo["kind"],
      duration: 0,
      width: 320,
      height: 180,
      hasAudio: false,
      oriented: true,
    }),
  },
}));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (m: string) => void toasts.info.push(m),
    error: (m: string) => void toasts.error.push(m),
    refuse: (m: string) => void toasts.refuse.push(m),
  },
}));
vi.mock("../editor/media/relink", () => ({
  isStillInfo: (i: MediaInfo) => i.kind === "image",
}));

const { firstImageItem, installPaste } = await import("./paste");
const { blockShortcuts } = await import("../core/shortcuts");

const item = (kind: string, type: string): { kind: string; type: string } => ({ kind, type });

describe("firstImageItem", () => {
  it("picks the first FILE whose type is an image", () => {
    // Decoys before it: an image type carried as a string (a browser's HTML
    // snippet naming one), and a file that is not an image.
    const items = [
      item("string", "image/png"),
      item("file", "text/plain"),
      item("file", "image/jpeg"),
      item("file", "image/png"),
    ];
    expect(firstImageItem(items)).toBe(2);
  });

  it("returns −1 when nothing on the clipboard is an image file", () => {
    expect(firstImageItem([])).toBe(-1);
    expect(firstImageItem([item("string", "text/html"), item("file", "application/pdf")])).toBe(-1);
    expect(firstImageItem([item("string", "image/png")])).toBe(-1);
  });

  it("reads an array-like, as a DataTransferItemList is", () => {
    const list = { length: 2, 0: item("string", "text/plain"), 1: item("file", "image/bmp") };
    expect(firstImageItem(list)).toBe(1);
  });
});

describe("installPaste: something opened while the paste was being saved", () => {
  type Handler = (e: unknown) => void;
  let onPaste: Handler | null = null;
  /** a dialog's backdrop is on the page */
  let modal = false;

  beforeEach(() => {
    onPaste = null;
    modal = false;
    saved.resolve = null;
    toasts.info = [];
    toasts.error = [];
    toasts.refuse = [];
    probe.kind = "image";
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("document", {
      activeElement: null,
      querySelector: (sel: string) => (modal && sel === ".modal-backdrop" ? {} : null),
      addEventListener: (t: string, fn: Handler) => {
        if (t === "paste") onPaste = fn;
      },
      removeEventListener: () => {},
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function rig() {
    const store = new Store<ProjectFile>(createBlankImageProject("Card", 640, 360, "#ffffff"));
    const commits: ProjectFile[] = [];
    const mode = new Store<"idle" | "crop-image" | "crop-layer">("idle");
    const ctx = {
      session: {
        get project() {
          return store.get();
        },
        commit(fn: (p: ProjectFile) => ProjectFile) {
          commits.push(store.get());
          store.set(fn(store.get()));
        },
      },
      selection: new Store<string | null>(null),
      mode,
    };
    const remove = installPaste(ctx as never, () => false);
    const png = new Blob([new Uint8Array([1])], { type: "image/png" });
    let prevented = 0;
    const paste = (type = "image/png", kind = "file") =>
      onPaste!({
        target: null,
        preventDefault() {
          prevented++;
        },
        clipboardData: { items: [{ kind, type, getAsFile: () => png }] },
      });
    return { commits, mode, remove, paste, prevented: () => prevented };
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("lands nothing inside the crop, and says why", async () => {
    const t = rig();
    t.paste();
    await settle();
    // Still saving; the user double-clicks a layer to crop it.
    t.mode.set("crop-layer");
    saved.resolve!({ path: "C:/Pasted images/Pasted 1.png" });
    await settle();
    expect(t.commits).toEqual([]);
    expect(toasts.info).toEqual(["Finish the crop first, then paste the image again."]);
    t.remove();
  });

  it("lands nothing under a picker or menu opened meanwhile, and says why", async () => {
    const t = rig();
    t.paste();
    await settle();
    // Still saving; the user opens the background picker and previews a
    // colour. The picker holds a shortcut block, not a dialog.
    const release = blockShortcuts();
    try {
      saved.resolve!({ path: "C:/Pasted images/Pasted 1.png" });
      await settle();
    } finally {
      release();
    }
    expect(t.commits).toEqual([]);
    expect(toasts.info).toEqual(["Close the open menu or picker first, then paste the image again."]);
    t.remove();
  });

  it("lands nothing behind a dialog opened meanwhile, and says why", async () => {
    const t = rig();
    t.paste();
    await settle();
    modal = true;
    saved.resolve!({ path: "C:/Pasted images/Pasted 1.png" });
    await settle();
    expect(t.commits).toEqual([]);
    expect(toasts.info).toEqual(["Close the dialog first, then paste the image again."]);
    t.remove();
  });

  it("an image pasted while a crop, dialog, menu or picker is open says why, at once", async () => {
    const t = rig();
    t.mode.set("crop-image");
    t.paste();
    t.mode.set("idle");
    modal = true;
    t.paste();
    modal = false;
    const release = blockShortcuts();
    try {
      t.paste();
    } finally {
      release();
    }
    expect(saved.resolve).toBe(null);
    expect(toasts.info).toEqual([
      "Finish the crop first, then paste the image again.",
      "Close the dialog first, then paste the image again.",
      "Close the open menu or picker first, then paste the image again.",
    ]);
    expect(t.prevented()).toBe(3);
    await settle();
    expect(t.commits).toEqual([]);
    t.remove();
  });

  it("text pasted in the same states stays untouched and silent", () => {
    const t = rig();
    t.mode.set("crop-layer");
    t.paste("text/plain", "string");
    t.mode.set("idle");
    modal = true;
    t.paste("text/plain", "string");
    expect(toasts.info).toEqual([]);
    expect(t.prevented()).toBe(0);
    t.remove();
  });

  it("a second paste while the first is still saving says so, once, and the first still lands", async () => {
    const BUSY = "Still adding the last pasted image — paste again once it appears.";
    const t = rig();
    t.paste();
    await settle();
    // Still saving: two more Ctrl+V (a held key repeats) — one toast, not two.
    t.paste();
    t.paste();
    expect(toasts.info).toEqual([BUSY]);
    // Both were image pastes, so both were claimed from the page.
    expect(t.prevented()).toBe(3);
    saved.resolve!({ path: "C:/Pasted images/Pasted 1.png" });
    await settle();
    // Not queued: only the first paste was ever saved, and it lands once.
    expect(t.commits.length).toBe(1);
    // The next busy spell may say it again.
    saved.resolve = null;
    t.paste();
    await settle();
    expect(saved.resolve).not.toBe(null);
    t.paste();
    expect(toasts.info.filter((m) => m === BUSY)).toEqual([BUSY, BUSY]);
    t.remove();
  });

  it("a pasted file that probes as no still is refused, not recorded as a failure", async () => {
    probe.kind = "video";
    const t = rig();
    t.paste();
    await settle();
    saved.resolve!({ path: "C:/Pasted images/Pasted 1.png" });
    await settle();
    expect(t.commits).toEqual([]);
    expect(toasts.refuse).toEqual(["Only images can be added to an image project."]);
    expect(toasts.error).toEqual([]);
    t.remove();
  });

  it("control: with nothing opened, the same paste lands as one step", async () => {
    const t = rig();
    t.paste();
    await settle();
    saved.resolve!({ path: "C:/Pasted images/Pasted 1.png" });
    await settle();
    expect(t.commits.length).toBe(1);
    t.remove();
  });
});
