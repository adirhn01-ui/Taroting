import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "../core/types";
import type { FontFamilyInfo, FontImportResult } from "../core/types";
import { El, body, doc, fakeWindow, flush, focusState, until } from "./markup-dom.test-util";

// The Fonts section, mounted inside the real Settings screen against a fake
// DOM (markup-dom.test-util.ts: vitest runs in node, no DOM library is a
// dependency) and a fake font runtime (`src/fonts`). Since 0.9.4 the section
// is ONE row however big the library is: the count, View (the Fonts page,
// tested in fonts-page.test.ts) and Import fonts.

const f = vi.hoisted(() => ({
  /** Set by the fake runtime's factory: true once `src/fonts` was imported. */
  runtimeLoaded: false,
  library: [] as FontFamilyInfo[],
  catalogCalls: 0,
  picks: [] as string[],
  pickCalls: 0,
  importCalls: [] as Array<{ paths: string[]; replace: boolean | undefined }>,
  importImpl: (paths: string[], _replace: boolean | undefined): FontImportResult[] =>
    paths.map((path) => ({ path, ok: true })),
  listeners: new Set<() => void>(),
  toasts: [] as Array<{ kind: string; message: string }>,
  navigations: [] as unknown[],
}));

vi.mock("../fonts", () => {
  f.runtimeLoaded = true;
  return {
    fontCatalog: async () => {
      f.catalogCalls++;
      return { library: f.library.map((x) => ({ ...x })), installed: [] };
    },
    importFonts: async (paths: string[], replace?: boolean) => {
      f.importCalls.push({ paths: [...paths], replace });
      return f.importImpl(paths, replace);
    },
    removeFont: async () => {
      throw new Error("Settings no longer removes fonts");
    },
    onFontsChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => void f.listeners.delete(cb);
    },
  };
});
vi.mock("../core/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/session")>();
  return {
    ...real,
    updateSettings: async (patch: Record<string, unknown>) => {
      real.settingsStore.set({ ...real.settingsStore.get(), ...patch });
    },
  };
});
vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...real,
    appVersion: async () => "0.9.4",
    pickFontFiles: async () => {
      f.pickCalls++;
      return [...f.picks];
    },
    ipc: {
      ...real.ipc,
      cacheStats: async () => ({ totalBytes: 0, byKind: {} }),
      enforceCacheLimit: async () => 0,
      clearCache: async () => 0,
      detectEncoders: async () => null,
    },
  };
});
vi.mock("../core/nav", () => ({ navigate: (route: unknown) => void f.navigations.push(route) }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (message: string) => void f.toasts.push({ kind: "info", message }),
    error: (message: string) => void f.toasts.push({ kind: "error", message }),
    refuse: (message: string) => void f.toasts.push({ kind: "refuse", message }),
  },
}));

vi.stubGlobal("document", doc);
vi.stubGlobal("window", fakeWindow);

const { settingsStore } = await import("../core/session");
const { mountSettings } = await import("./settings");
const { importErrorSentence } = await import("./fonts-section");

/* ---------------- helpers ---------------- */

let root: El;
let view: { dispose(): void } | null = null;

function mount(): void {
  root = new El("div");
  body.appendChild(root);
  view = mountSettings(root as unknown as HTMLElement);
}

const inner = (): El => root.querySelector("#settings-inner")!;
const section = (): El => {
  const el = inner().querySelector("#settings-fonts");
  if (!el) throw new Error("no Fonts section");
  return el;
};
const importBtn = (): El => section().querySelector("#settings-fonts-import")!;
const viewBtn = (): El => section().querySelector("#settings-fonts-view")!;
const countLine = (): string => section().querySelector("#settings-fonts-count")!.textContent;
const errorLines = (): string[] => section().querySelectorAll(".settings__font-error").map((e) => e.textContent);
const backdrops = (): El[] => body.children.filter((c) => c.className === "modal-backdrop");

const NOTE = "Fonts installed on this PC are already in every font list.";

const face = (style: string, bold = false, italic = false) => ({
  bold,
  italic,
  weight: bold ? 700 : 400,
  style,
  embed: "full" as const,
});
const fam = (name: string): FontFamilyInfo => ({
  id: `lib:${name}`,
  name,
  source: "library",
  faces: [face("Regular")],
  addedMs: 1_700_000_000_000,
  bytes: 1000,
});

beforeEach(() => {
  f.library = [];
  f.catalogCalls = 0;
  f.picks = [];
  f.pickCalls = 0;
  f.importCalls.length = 0;
  f.importImpl = (paths) => paths.map((path) => ({ path, ok: true }));
  f.listeners.clear();
  f.toasts.length = 0;
  f.navigations.length = 0;
  focusState.el = null;
  settingsStore.set({ ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } });
});

afterEach(() => {
  view?.dispose();
  view = null;
  for (const c of [...body.children]) c.remove();
});

/* ---------------- tests ---------------- */

// FIRST on purpose: whether the runtime module was ever imported is process
// state the later tests cannot undo.
describe("nothing before Settings opens", () => {
  it("neither loads the font runtime nor reads the catalogue until mount", async () => {
    // The Settings module (and with it the Fonts section) is already imported.
    await flush();
    expect(f.runtimeLoaded).toBe(false);
    expect(f.catalogCalls).toBe(0);
    mount();
    await until(() => f.catalogCalls > 0, "the catalogue read");
    expect(f.runtimeLoaded).toBe(true);
    expect(f.catalogCalls).toBe(1);
  });
});

describe("the row", () => {
  it.each([
    [0, "No fonts imported yet."],
    [1, "1 imported font."],
    [12, "12 imported fonts."],
  ])("says how many fonts are imported (%i), whatever the size of the library, in one row", async (n, sentence) => {
    f.library = Array.from({ length: n }, (_, i) => fam(`Family ${i}`));
    mount();
    await until(() => countLine() !== `Reading fonts ${NOTE}`, "the count");
    expect(countLine()).toBe(`${sentence} ${NOTE}`);
    // One row, and no per-family rows or Remove buttons in Settings.
    expect(section().querySelectorAll(".settings__row")).toHaveLength(1);
    expect(section().querySelectorAll("[data-font-remove]")).toHaveLength(0);
    expect(section().querySelector(".settings__row-label")!.textContent).toBe("Font library");
    expect(viewBtn().textContent).toBe("View");
    expect(importBtn().textContent).toBe("Import fonts");
    // The row sits directly in the card, as in every other section.
    expect(section().querySelector(".settings__row")!.parentNode).toBe(section());
  });

  it("View opens the Fonts page", async () => {
    f.library = [fam("Inter")];
    mount();
    await until(() => countLine().startsWith("1 imported font."), "the count");
    viewBtn().click();
    expect(f.navigations).toEqual([{ view: "fonts" }]);
  });

  it("follows a change made elsewhere (onFontsChanged)", async () => {
    f.library = [fam("Inter")];
    mount();
    await until(() => countLine().startsWith("1 imported font.") && f.listeners.size === 1, "the count and the subscription");
    f.library = [fam("Inter"), fam("Fira Code")];
    for (const cb of f.listeners) cb();
    await until(() => countLine().startsWith("2 imported fonts."), "the new count");
  });
});

describe("import", () => {
  const ALPHA = "C:\\Fonts in\\Alpha.ttf";
  const BETA = "D:\\other\\Beta.otf";

  function twoWithOneExisting(): void {
    f.picks = [ALPHA, BETA];
    f.importImpl = (paths, replace) =>
      paths.map((path) =>
        path === BETA && !replace
          ? { path, ok: false, error: "exists" as const, family: "Beta Sans", style: "Bold" }
          : { path, ok: true, id: `lib:${path === BETA ? "Beta Sans" : "Alpha"}` },
      );
  }

  it("asks once about the file that exists, and replaces only that file on confirm", async () => {
    twoWithOneExisting();
    mount();
    await until(() => f.catalogCalls > 0, "the catalogue");
    importBtn().click();
    await until(() => backdrops().length > 0, "the replace confirm");
    expect(backdrops()).toHaveLength(1);
    const dlg = backdrops()[0]!;
    expect(dlg.querySelector(".modal__header")!.textContent).toBe("Replace font?");
    expect(dlg.querySelector(".modal__text")!.textContent).toBe(
      "Beta Sans Bold is already in the library. Replace it with Beta.otf?",
    );
    expect(doc.activeElement).toBe(dlg.querySelector("[data-cancel]"));
    expect(dlg.querySelector("[data-confirm]")!.classes).not.toContain("btn--danger");
    expect(f.importCalls).toEqual([{ paths: [ALPHA, BETA], replace: undefined }]);
    dlg.querySelector("[data-confirm]")!.click();
    await until(() => f.importCalls.length === 2, "the replace import");
    expect(f.importCalls[1]).toEqual({ paths: [BETA], replace: true });
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(errorLines()).toEqual([]);
  });

  it("replaces nothing when the confirm is cancelled", async () => {
    twoWithOneExisting();
    mount();
    await until(() => f.catalogCalls > 0, "the catalogue");
    importBtn().click();
    await until(() => backdrops().length > 0, "the replace confirm");
    backdrops()[0]!.querySelector("[data-cancel]")!.click();
    await flush();
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(f.importCalls).toHaveLength(1);
    expect(errorLines()).toEqual([]);
  });

  it("shows one sentence per failed file, naming the file", async () => {
    f.picks = ["C:\\a\\One.woff", "C:\\a\\Two.ttf", "C:\\a\\Three.otf"];
    f.importImpl = (paths) =>
      paths.map((path, i) => ({ path, ok: false, error: (["extension", "tooLarge", "io"] as const)[i]! }));
    mount();
    await until(() => f.catalogCalls > 0, "the catalogue");
    importBtn().click();
    await until(() => errorLines().length > 0, "the error lines");
    expect(errorLines()).toEqual([
      "One.woff isn't a .ttf or .otf file.",
      "Two.ttf is too large. A font file can be up to 64 MB.",
      "Three.otf couldn't be read.",
    ]);
    expect(backdrops()).toHaveLength(0);
  });

  it("refreshes the count after an import and keeps focus on Import fonts", async () => {
    mount();
    await until(() => countLine().startsWith("No fonts imported yet."), "the zero count");
    f.picks = ["C:\\x\\New.ttf"];
    f.importImpl = (paths) => {
      f.library = [fam("New")];
      return paths.map((path) => ({ path, ok: true, id: "lib:New" }));
    };
    importBtn().focus();
    importBtn().click();
    await until(() => countLine().startsWith("1 imported font."), "the count after the import");
    expect(doc.activeElement).toBe(importBtn());
  });

  it("maps every error code to its own sentence", () => {
    const p = "C:\\x\\Face.ttf";
    expect(importErrorSentence(p, "extension")).toBe("Face.ttf isn't a .ttf or .otf file.");
    expect(importErrorSentence(p, "notAFont")).toBe("Face.ttf isn't a font file.");
    expect(importErrorSentence(p, "tooLarge")).toBe("Face.ttf is too large. A font file can be up to 64 MB.");
    expect(importErrorSentence(p, "noUnicode")).toBe("Face.ttf isn't a supported kind of font.");
    expect(importErrorSentence(p, "unsupported")).toBe("Face.ttf isn't a supported kind of font.");
    expect(importErrorSentence(p, "io")).toBe("Face.ttf couldn't be read.");
    expect(importErrorSentence(p, "exists")).toBe("Face.ttf is already in the library.");
    expect(importErrorSentence(p, undefined)).toBe("Face.ttf couldn't be imported.");
  });
});

describe("closing Settings", () => {
  it("closes an open confirm, stops listening, and imports nothing more", async () => {
    f.picks = ["D:\\other\\Beta.otf"];
    f.importImpl = (paths, replace) =>
      paths.map((path) => (replace ? { path, ok: true } : { path, ok: false, error: "exists" as const, family: "Beta" }));
    mount();
    await until(() => f.catalogCalls > 0 && f.listeners.size === 1, "the catalogue and the subscription");
    importBtn().click();
    await until(() => backdrops().length === 1, "the replace confirm");
    view!.dispose();
    view = null;
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(f.listeners.size).toBe(0);
    expect(f.importCalls).toHaveLength(1);
  });
});

describe("a re-render of Settings", () => {
  it("keeps the count and a working Import button", async () => {
    f.library = [fam("Inter")];
    mount();
    await until(() => countLine().startsWith("1 imported font."), "the count");
    const before = section();
    settingsStore.set({ ...settingsStore.get(), theme: "light" });
    await flush();
    expect(section()).not.toBe(before); // genuinely rebuilt
    expect(countLine()).toBe(`1 imported font. ${NOTE}`);
    f.picks = ["C:\\x\\New.ttf"];
    importBtn().click();
    await until(() => f.importCalls.length === 1, "the import");
    expect(f.importCalls[0]).toEqual({ paths: ["C:\\x\\New.ttf"], replace: undefined });
  });
});
