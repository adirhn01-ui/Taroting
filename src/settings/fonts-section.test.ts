import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "../core/types";
import type { FontFamilyInfo, FontImportResult } from "../core/types";

// The Fonts section, mounted inside the real Settings screen against a fake
// DOM (vitest runs in node; no DOM library is a dependency) and a fake font
// runtime (`src/fonts`). The fake DOM is the same small model the Settings
// mount tests use: it parses the markup the screen writes, matches the simple
// selectors it queries with, detaches replaced nodes (focus falls to <body>),
// and does not deliver a click to a disabled button.

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
  removeCalls: [] as string[],
  /** When set, removeFont waits on it: a removal held in flight. */
  removeGate: null as Promise<void> | null,
  listeners: new Set<() => void>(),
  toasts: [] as Array<{ kind: string; message: string }>,
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
    removeFont: async (id: string) => {
      f.removeCalls.push(id);
      await f.removeGate;
      f.library = f.library.filter((x) => x.id !== id);
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
vi.mock("../core/nav", () => ({ navigate: () => {} }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (message: string) => void f.toasts.push({ kind: "info", message }),
    error: (message: string) => void f.toasts.push({ kind: "error", message }),
    refuse: (message: string) => void f.toasts.push({ kind: "refuse", message }),
  },
}));

/* ---------------- the fake DOM ---------------- */

type Handler = (e: unknown) => void;

const VOID = new Set(["input", "br", "img", "hr", "meta"]);

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

class El {
  readonly tagName: string;
  nodes: Array<El | string> = [];
  parentNode: El | null = null;
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  value = "";
  checked = false;
  private listeners = new Map<string, Set<Handler>>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get children(): El[] {
    return this.nodes.filter((n): n is El => typeof n !== "string");
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  get disabled(): boolean {
    return this.attrs.has("disabled");
  }
  set disabled(v: boolean) {
    if (v) this.attrs.set("disabled", "");
    else this.attrs.delete("disabled");
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) {
      if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return out;
  }
  get textContent(): string {
    return this.nodes.map((n) => (typeof n === "string" ? n : n.textContent)).join("");
  }
  set textContent(v: string) {
    this.detachAll();
    this.nodes = [v];
  }
  set innerHTML(html: string) {
    this.detachAll();
    parseInto(this, html);
  }
  get innerHTML(): string {
    return "";
  }
  get isConnected(): boolean {
    let n: El | null = this;
    while (n) {
      if (n === body) return true;
      n = n.parentNode;
    }
    return false;
  }
  get offsetParent(): El | null {
    return this.isConnected ? this.parentNode : null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  private detachAll(): void {
    for (const c of this.children) c.parentNode = null;
    this.nodes = [];
  }
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.nodes.push(c);
    return c;
  }
  remove(): void {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.nodes = p.nodes.filter((n) => n !== this);
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string, extra: Record<string, unknown> = {}): void {
    let stopped = false;
    const ev: Record<string, unknown> = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
      ...extra,
    };
    for (let n: El | null = this; n && !stopped; n = n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners.get(t) ?? [])]) fn(ev);
    }
  }
  click(): void {
    if (!this.disabled) this.fire("click");
  }
  focus(): void {
    focusState.el = this;
  }
  blur(): void {
    if (focusState.el === this) focusState.el = null;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchCompound(this, part.trim()));
  }
  all(): El[] {
    const out: El[] = [];
    const walk = (e: El): void => {
      for (const c of e.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(selector: string): El[] {
    return this.all().filter((e) => e.matches(selector));
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchCompound(el: El, sel: string): boolean {
  let rest = sel;
  while (rest.length > 0) {
    let mm: RegExpMatchArray | null;
    if ((mm = rest.match(/^:not\(([^)]*)\)/))) {
      if (matchCompound(el, mm[1]!)) return false;
    } else if ((mm = rest.match(/^#([\w-]+)/))) {
      if (el.id !== mm[1]) return false;
    } else if ((mm = rest.match(/^\.([\w-]+)/))) {
      if (!el.classes.includes(mm[1]!)) return false;
    } else if ((mm = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\]/))) {
      const v = el.getAttribute(mm[1]!);
      if (v === null || (mm[2] !== undefined && v !== mm[2])) return false;
    } else if ((mm = rest.match(/^[a-zA-Z][\w-]*/))) {
      if (el.tagName !== mm[0].toUpperCase()) return false;
    } else {
      throw new Error(`fake DOM: unsupported selector "${sel}"`);
    }
    rest = rest.slice(mm[0].length);
  }
  return true;
}

const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseInto(root: El, html: string): void {
  const stack: El[] = [root];
  for (const t of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (t[0].startsWith("<!--")) continue;
    if (t[1]) {
      const tag = t[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tagName === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (t[2]) {
      const el = new El(t[2]);
      for (const a of (t[3] ?? "").matchAll(ATTR)) {
        el.attrs.set(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
      }
      top.appendChild(el);
      if (!VOID.has(t[2].toLowerCase()) && !t[0].endsWith("/>")) stack.push(el);
    } else {
      top.nodes.push(decode(t[0]));
    }
  }
}

const focusState = { el: null as El | null };
const body = new El("body");
const docListeners = new Map<string, Set<Handler>>();
const doc = {
  body,
  get activeElement(): El {
    const el = focusState.el;
    return el && el.isConnected && !el.disabled ? el : body;
  },
  createElement: (tag: string) => new El(tag),
  addEventListener: (t: string, fn: Handler) => {
    if (!docListeners.has(t)) docListeners.set(t, new Set());
    docListeners.get(t)!.add(fn);
  },
  removeEventListener: (t: string, fn: Handler) => void docListeners.get(t)?.delete(fn),
};
function pressKey(key: string): void {
  const ev = { key, preventDefault() {}, stopPropagation() {} };
  for (const fn of [...(docListeners.get("keydown") ?? [])]) fn(ev);
}

vi.stubGlobal("document", doc);
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  addEventListener: () => {},
  removeEventListener: () => {},
});

const { settingsStore } = await import("../core/session");
const { mountSettings } = await import("./settings");
const { importErrorSentence } = await import("./fonts-section");

/* ---------------- helpers ---------------- */

let root: El;
let view: { dispose(): void } | null = null;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Flush until `cond` holds (bounded): a dynamic import can take more than
 *  one macrotask to land. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
const removeBtn = (id: string): El | undefined =>
  section()
    .querySelectorAll("[data-font-remove]")
    .find((b) => b.getAttribute("data-font-remove") === id);
const familyNames = (): string[] =>
  section()
    .querySelectorAll(".settings__row-label")
    .map((e) => e.textContent)
    .filter((t) => t !== "Font library");
const errorLines = (): string[] => section().querySelectorAll(".settings__font-error").map((e) => e.textContent);
const backdrops = (): El[] => body.children.filter((c) => c.className === "modal-backdrop");

const face = (style: string, bold = false, italic = false) => ({
  bold,
  italic,
  weight: bold ? 700 : 400,
  style,
  embed: "full" as const,
});
const INTER: FontFamilyInfo = {
  id: "lib:Inter",
  name: "Inter",
  source: "library",
  faces: [face("Regular"), face("Bold", true)],
};
const FIRA: FontFamilyInfo = {
  id: "lib:Fira Code",
  name: "Fira Code",
  source: "library",
  faces: [face("Light Italic", false, true)],
};

beforeEach(() => {
  f.library = [];
  f.catalogCalls = 0;
  f.picks = [];
  f.pickCalls = 0;
  f.importCalls.length = 0;
  f.importImpl = (paths) => paths.map((path) => ({ path, ok: true }));
  f.removeCalls.length = 0;
  f.removeGate = null;
  f.listeners.clear();
  f.toasts.length = 0;
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

describe("the list", () => {
  it("lists each library family with its styles and a Remove button", async () => {
    f.library = [INTER, FIRA];
    mount();
    await until(() => familyNames().length === 2, "the families");
    expect(familyNames()).toEqual(["Inter", "Fira Code"]);
    const hints = section()
      .querySelectorAll(".settings__hint")
      .map((e) => e.textContent);
    expect(hints).toEqual([
      "Fonts installed on this PC are already in every font list.",
      "Regular, Bold",
      "Light Italic",
    ]);
    expect(removeBtn("lib:Inter")?.textContent).toBe("Remove");
    expect(removeBtn("lib:Fira Code")?.textContent).toBe("Remove");
    // Rows sit directly in the card, as in every other section: the card's
    // spacing between rows comes from being their parent.
    for (const row of section().querySelectorAll(".settings__row")) expect(row.parentNode).toBe(section());
  });

  it("says so in one line when the library is empty", async () => {
    mount();
    await until(() => f.catalogCalls > 0, "the catalogue");
    await flush();
    const hints = section()
      .querySelectorAll(".settings__hint")
      .map((e) => e.textContent);
    expect(hints).toEqual(["Fonts installed on this PC are already in every font list.", "No fonts imported yet."]);
    expect(section().querySelectorAll("[data-font-remove]")).toHaveLength(0);
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

describe("remove", () => {
  it("asks first, and calls removeFont only on confirm", async () => {
    f.library = [INTER, FIRA];
    mount();
    await until(() => familyNames().length === 2, "the families");

    removeBtn("lib:Inter")!.click();
    await flush();
    expect(backdrops()).toHaveLength(1);
    let dlg = backdrops()[0]!;
    expect(dlg.querySelector(".modal__header")!.textContent).toBe("Remove Inter?");
    expect(dlg.querySelector(".modal__text")!.textContent).toBe(
      "Projects that use it show Segoe UI until you import it again. The file you imported it from is not touched.",
    );
    expect(doc.activeElement).toBe(dlg.querySelector("[data-cancel]"));
    expect(dlg.querySelector("[data-confirm]")!.classes).not.toContain("btn--danger");
    pressKey("Escape");
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(f.removeCalls).toEqual([]);
    expect(doc.activeElement).toBe(removeBtn("lib:Inter"));

    removeBtn("lib:Inter")!.click();
    await flush();
    dlg = backdrops()[0]!;
    dlg.querySelector("[data-confirm]")!.click();
    await until(() => familyNames().length === 1, "the list without Inter");
    expect(f.removeCalls).toEqual(["lib:Inter"]);
    expect(familyNames()).toEqual(["Fira Code"]);
    // Its row is gone: focus lands on Import fonts, not on <body>.
    await flush();
    expect(doc.activeElement).toBe(importBtn());
  });

  it("disables every Remove while a removal is under way", async () => {
    f.library = [INTER, FIRA];
    let release = (): void => {};
    f.removeGate = new Promise<void>((r) => (release = r));
    mount();
    await until(() => familyNames().length === 2, "the families");
    removeBtn("lib:Inter")!.click();
    await flush();
    backdrops()[0]!.querySelector("[data-confirm]")!.click();
    await until(() => f.removeCalls.length === 1, "the removal");
    expect(removeBtn("lib:Inter")!.disabled).toBe(true);
    expect(removeBtn("lib:Fira Code")!.disabled).toBe(true);
    release();
    await until(() => familyNames().length === 1, "the list without Inter");
    expect(removeBtn("lib:Fira Code")!.disabled).toBe(false);
  });
});

describe("closing Settings", () => {
  it("closes an open confirm, stops listening, and removes nothing", async () => {
    f.library = [INTER];
    mount();
    await until(() => familyNames().length === 1 && f.listeners.size === 1, "the family and the subscription");
    removeBtn("lib:Inter")!.click();
    await flush();
    expect(backdrops()).toHaveLength(1);
    view!.dispose();
    view = null;
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(f.listeners.size).toBe(0);
    expect(f.removeCalls).toEqual([]);
  });
});

describe("a re-render of Settings", () => {
  it("keeps the list and a working Import button", async () => {
    f.library = [INTER];
    mount();
    await until(() => familyNames().length === 1, "the family");
    const before = section();
    settingsStore.set({ ...settingsStore.get(), theme: "light" });
    await flush();
    expect(section()).not.toBe(before); // genuinely rebuilt
    expect(familyNames()).toEqual(["Inter"]);
    f.picks = ["C:\\x\\New.ttf"];
    importBtn().click();
    await until(() => f.importCalls.length === 1, "the import");
    expect(f.importCalls[0]).toEqual({ paths: ["C:\\x\\New.ttf"], replace: undefined });
  });
});
