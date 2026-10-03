import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "../core/types";

// The Settings screen mounted against a small fake DOM (vitest runs in node).
// The screen is built from markup strings, so the fake parses the markup it is
// handed — only the shapes this screen writes: tags, quoted and boolean
// attributes, void <input>, text — and matches the simple selectors it queries
// with (tag, #id, .class, [attr], [attr="v"], :not(…), comma lists).
//
// What it models of a real engine, because the behaviour under test depends on
// it: replacing markup detaches the focused node and focus falls to <body>; a
// disabled control cannot hold focus; a click on a disabled button is not
// delivered; `focus.ts`'s reachability test (`offsetParent`) is "attached".

const m = vi.hoisted(() => ({
  writes: [] as unknown[],
  toasts: [] as Array<{ kind: string; message: string }>,
  uninstall: [] as Array<{ resolve: () => void; reject: (e: unknown) => void }>,
  saves: [] as Array<{ resolve: (p: string) => void; reject: (e: unknown) => void }>,
  reveals: [] as string[],
}));

vi.mock("../core/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/session")>();
  return {
    ...real,
    updateSettings: async (patch: Record<string, unknown>) => {
      m.writes.push(patch);
      real.settingsStore.set({ ...real.settingsStore.get(), ...patch });
    },
  };
});
vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...real,
    appVersion: async () => "0.9.1",
    ipc: {
      ...real.ipc,
      cacheStats: async () => ({ totalBytes: 0, byKind: {} }),
      enforceCacheLimit: async () => 0,
      clearCache: async () => 0,
      detectEncoders: async () => null,
      uninstallApp: () =>
        new Promise<void>((resolve, reject) => void m.uninstall.push({ resolve, reject })),
      saveDiagnosticReport: () =>
        new Promise<string>((resolve, reject) => void m.saves.push({ resolve, reject })),
    },
  };
});
vi.mock("../core/nav", () => ({ navigate: () => {} }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (message: string) => void m.toasts.push({ kind: "info", message }),
    error: (message: string) => void m.toasts.push({ kind: "error", message }),
    refuse: (message: string) => void m.toasts.push({ kind: "refuse", message }),
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: async (p: string) => void m.reveals.push(p),
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
    const ev = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev);
  }
  /** A click as the engine delivers it: nothing at all on a disabled control. */
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
      // A closing tag pops back to its opener.
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

// Focus as an engine reports it: a node that left the document, or one that is
// disabled, does not keep focus — `activeElement` is <body> then.
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

/* ---------------- helpers ---------------- */

let root: El;
let view: { dispose(): void } | null = null;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function mount(): void {
  root = new El("div");
  body.appendChild(root);
  view = mountSettings(root as unknown as HTMLElement);
}

const inner = (): El => root.querySelector("#settings-inner")!;
const q = (sel: string): El => {
  const el = inner().querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
const backdrops = (): El[] => body.children.filter((c) => c.className === "modal-backdrop");

beforeEach(() => {
  m.writes.length = 0;
  m.toasts.length = 0;
  m.uninstall.length = 0;
  m.saves.length = 0;
  m.reveals.length = 0;
  focusState.el = null;
  settingsStore.set({ ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } });
});

afterEach(() => {
  view?.dispose();
  view = null;
  for (const c of [...body.children]) c.remove();
  vi.useRealTimers();
});

/* ---------------- focus survives a re-render ---------------- */

describe("keyboard focus across a re-render", () => {
  it("stays on the theme choice the user just pressed, on the NEW node", async () => {
    mount();
    await flush();
    const light = q('[data-theme-opt="light"]');
    light.focus();
    light.click(); // persists → store notifies (a microtask) → the screen re-renders
    await flush();
    const now = q('[data-theme-opt="light"]');
    expect(now).not.toBe(light); // genuinely rebuilt, so this is not a no-op
    expect(doc.activeElement).toBe(now);
  });

  it("lets a keyboard user reach 'Really clear?': focus follows the armed button", async () => {
    mount();
    await flush();
    q("#settings-clear-cache").focus();
    q("#settings-clear-cache").click();
    expect(doc.activeElement).toBe(q("#settings-clear-cache"));
    expect(q("#settings-clear-cache").textContent).toBe("Really clear?");
  });

  it("falls back to Choose when Clear disables itself", async () => {
    settingsStore.set({ ...settingsStore.get(), defaultExportDir: "D:\\Exports" });
    mount();
    await flush();
    q("#settings-clear-dir").focus();
    q("#settings-clear-dir").click();
    await flush();
    expect(q("#settings-clear-dir").disabled).toBe(true);
    expect(doc.activeElement).toBe(q("#settings-choose-dir"));
  });

  it("never takes focus from outside the screen's content", async () => {
    mount();
    await flush();
    // A control in a dialog over the screen, carrying a key that ALSO exists
    // inside it, so only the "is focus inside the content" check keeps focus
    // where the user put it.
    const elsewhere = new El("button");
    elsewhere.setAttribute("data-theme-opt", "light");
    body.appendChild(elsewhere);
    elsewhere.focus();
    const before = q('[data-theme-opt="light"]');
    settingsStore.set({ ...settingsStore.get(), theme: "light" });
    await flush();
    expect(q('[data-theme-opt="light"]')).not.toBe(before); // it did re-render
    expect(doc.activeElement).toBe(elsewhere);
  });
});

/* ---------------- two-step confirms ---------------- */

describe("Reset to defaults", () => {
  const custom = () => ({ ...DEFAULT_SHORTCUTS, split: "Ctrl+K" });

  it("asks first: one click changes nothing, the second restores the defaults", async () => {
    settingsStore.set({ ...settingsStore.get(), shortcuts: custom() });
    mount();
    await flush();
    q("#settings-reset-shortcuts").click();
    expect(m.writes).toEqual([]);
    expect(settingsStore.get().shortcuts.split).toBe("Ctrl+K");
    const armed = q("#settings-reset-shortcuts");
    expect(armed.textContent).toBe("Really reset?");
    expect(armed.classes).not.toContain("btn--danger");
    armed.click();
    expect(m.writes).toEqual([{ shortcuts: { ...DEFAULT_SHORTCUTS } }]);
    await flush();
    expect(q("#settings-reset-shortcuts").disabled).toBe(true);
  });

  it("disarms after three seconds, and a later click only arms again", async () => {
    vi.useFakeTimers();
    settingsStore.set({ ...settingsStore.get(), shortcuts: custom() });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    q("#settings-reset-shortcuts").click();
    vi.advanceTimersByTime(3000);
    expect(q("#settings-reset-shortcuts").textContent).toBe("Reset to defaults");
    q("#settings-reset-shortcuts").click();
    expect(m.writes).toEqual([]);
  });

  it("is disabled when every shortcut already is the default", async () => {
    mount();
    await flush();
    expect(q("#settings-reset-shortcuts").disabled).toBe(true);
  });

  it("moves focus to the first shortcut once the confirming click disables it", async () => {
    settingsStore.set({ ...settingsStore.get(), shortcuts: custom() });
    mount();
    await flush();
    q("#settings-reset-shortcuts").focus();
    q("#settings-reset-shortcuts").click();
    expect(doc.activeElement).toBe(q("#settings-reset-shortcuts"));
    q("#settings-reset-shortcuts").click();
    await flush();
    expect(doc.activeElement).toBe(q('[data-action="playPause"]'));
  });
});

describe("Clear cache, armed", () => {
  it("is not painted destructive red", async () => {
    mount();
    await flush();
    q("#settings-clear-cache").click();
    expect(q("#settings-clear-cache").textContent).toBe("Really clear?");
    expect(q("#settings-clear-cache").classes).not.toContain("btn--danger");
  });
});

/* ---------------- the Uninstall confirm ---------------- */

describe("Uninstall", () => {
  it("opens with focus on Cancel, inside the dialog", async () => {
    mount();
    await flush();
    q("#settings-uninstall").focus();
    q("#settings-uninstall").click();
    expect(backdrops()).toHaveLength(1);
    const cancel = backdrops()[0]!.querySelector("[data-cancel]")!;
    expect(doc.activeElement).toBe(cancel);
  });

  it("never stacks a second dialog", async () => {
    mount();
    await flush();
    q("#settings-uninstall").click();
    q("#settings-uninstall").click();
    expect(backdrops()).toHaveLength(1);
  });

  it("starts one uninstaller however often Uninstall is clicked", async () => {
    mount();
    await flush();
    q("#settings-uninstall").click();
    const confirm = backdrops()[0]!.querySelector("[data-confirm]")!;
    confirm.click();
    confirm.click();
    confirm.fire("click"); // even a click the engine did deliver
    expect(m.uninstall).toHaveLength(1);
    expect(confirm.disabled).toBe(true);
  });

  it("cannot be left or reopened while a confirmed uninstall is under way", async () => {
    mount();
    await flush();
    q("#settings-uninstall").click();
    const dialog = backdrops()[0]!;
    dialog.querySelector("[data-confirm]")!.click();
    // Every way out of the dialog is inert until the backend answers: on
    // success the app exits, and a fresh dialog's Confirm would start a
    // second uninstaller in the meantime.
    pressKey("Escape");
    dialog.fire("mousedown", { target: dialog });
    dialog.querySelector("[data-cancel]")!.fire("click");
    expect(backdrops()).toEqual([dialog]);
    expect(dialog.querySelector("[data-cancel]")!.disabled).toBe(true);
    q("#settings-uninstall").click();
    expect(backdrops()).toEqual([dialog]);
    expect(m.uninstall).toHaveLength(1);
    // A failure lets go: the dialog closes and a retry can open it again.
    m.uninstall[0]!.reject({ code: "bad_input", message: "uninstall task failed: panicked" });
    await flush();
    expect(backdrops()).toHaveLength(0);
    q("#settings-uninstall").click();
    expect(backdrops()).toHaveLength(1);
  });

  it("Escape closes it and hands focus back to the Uninstall button", async () => {
    mount();
    await flush();
    q("#settings-uninstall").click();
    pressKey("Escape");
    expect(backdrops()).toHaveLength(0);
    expect(doc.activeElement).toBe(q("#settings-uninstall"));
  });

  it("a portable copy is told how to remove itself, not shown a bare failure", async () => {
    mount();
    await flush();
    q("#settings-uninstall").click();
    backdrops()[0]!.querySelector("[data-confirm]")!.click();
    m.uninstall[0]!.reject({ code: "bad_input", message: "not installed" });
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(m.toasts).toEqual([
      { kind: "refuse", message: "This is a portable copy. To remove it, delete its folder." },
    ]);
  });

  it("any other failure — the same code included — is still an error", async () => {
    mount();
    await flush();
    q("#settings-uninstall").click();
    backdrops()[0]!.querySelector("[data-confirm]")!.click();
    m.uninstall[0]!.reject({ code: "bad_input", message: "uninstall task failed: panicked" });
    await flush();
    expect(m.toasts).toEqual([{ kind: "error", message: "Couldn't uninstall Taroting." }]);
    // And the dialog can be opened again for a retry.
    q("#settings-uninstall").click();
    expect(backdrops()).toHaveLength(1);
  });

  it("does not promise to remove settings: the uninstaller's checkbox decides", async () => {
    mount();
    await flush();
    const card = inner().querySelector(".settings__card--danger")!.textContent;
    expect(card).toContain("The uninstaller asks whether to remove your settings and caches too.");
    expect(card).not.toMatch(/Removes the app, its settings/);
  });
});

/* ---------------- Save report ---------------- */

describe("Save report", () => {
  it("saves once per click, stays disabled across a re-render, and comes back", async () => {
    mount();
    await flush();
    q("#settings-save-report").click();
    q("#settings-save-report").click();
    await flush();
    expect(m.saves).toHaveLength(1);
    expect(q("#settings-save-report").disabled).toBe(true);
    // Anything that re-renders mid-save must not hand back a live button.
    const before = q("#settings-save-report");
    settingsStore.set({ ...settingsStore.get(), theme: "light" });
    await flush();
    expect(q("#settings-save-report")).not.toBe(before); // it did re-render
    expect(q("#settings-save-report").disabled).toBe(true);
    q("#settings-save-report").fire("click"); // and a delivered click still does nothing
    await flush();
    expect(m.saves).toHaveLength(1);

    m.saves[0]!.resolve("C:\\Users\\x\\Desktop\\report.txt");
    await flush();
    expect(q("#settings-save-report").disabled).toBe(false);
    expect(m.reveals).toEqual(["C:\\Users\\x\\Desktop\\report.txt"]);
    expect(m.toasts).toEqual([{ kind: "info", message: "Report saved" }]);
  });

  it("re-enables after a failed write too", async () => {
    mount();
    await flush();
    q("#settings-save-report").click();
    await flush();
    m.saves[0]!.reject({ code: "io", message: "disk full" });
    await flush();
    expect(q("#settings-save-report").disabled).toBe(false);
    expect(m.toasts.map((t) => t.kind)).toEqual(["error"]);
  });
});
