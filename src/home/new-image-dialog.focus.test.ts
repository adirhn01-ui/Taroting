import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, ProjectFile } from "../core/types";

// The New image project dialog's focus while it is busy, against a stub DOM
// (vitest runs in node). The stub does what the engine does when a FOCUSED
// button is disabled — focus drops to <body> — because that is the bug: the
// Tab trap only hears keys from inside the dialog, so focus on <body> after a
// cancelled photo pick let Tab walk Home behind the backdrop.

const m = vi.hoisted(() => ({
  pick: null as null | (() => Promise<string | null>),
  probe: null as null | (() => Promise<MediaInfo>),
  save: null as null | (() => Promise<void>),
  errors: [] as string[],
  refusals: [] as string[],
}));

vi.mock("../core/ipc", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  pickImageFile: () => (m.pick ? m.pick() : Promise.resolve(null)),
  ipc: {
    probeMedia: () => (m.probe ? m.probe() : Promise.reject(new Error("no probe"))),
    newProjectPath: async (s?: string) => `C:\\Docs\\Taroting\\${s ?? "Untitled"}.trt`,
    saveProject: (_p: string, _project: ProjectFile) => (m.save ? m.save() : Promise.resolve()),
  },
}));
vi.mock("../core/open-media", () => ({ stillSizeProblem: () => null }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../ui/toast", () => ({
  toast: {
    error: (s: string) => void m.errors.push(s),
    info: () => {},
    refuse: (s: string) => void m.refusals.push(s),
  },
}));
vi.mock("../ui/focus", () => ({
  trapTab: () => () => {},
  // The real one seats focus on the selector's match when it is enabled, else
  // on the first enabled control.
  focusFirst: (container: Stub, selector?: string) => {
    const want = selector ? container.querySelector(selector) : null;
    const target = want && !want.disabled ? want : container.querySelector('[data-act="cancel"]#x');
    target.focus();
    return true;
  },
}));

type Handler = (e: unknown) => void;

class Stub {
  readonly sel: string;
  parent: Stub | null = null;
  private listeners = new Map<string, Set<Handler>>();
  private stubs = new Map<string, Stub>();
  private _disabled = false;
  hidden = false;
  value = "";
  innerHTML = "";
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private attrs = new Map<string, string>();
  private classes = new Set<string>();
  classList = {
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
  };
  constructor(sel: string, parent: Stub | null = null) {
    this.sel = sel;
    this.parent = parent;
  }
  get disabled(): boolean {
    return this._disabled;
  }
  /** As in the engine: disabling the focused control drops focus to <body>. */
  set disabled(v: boolean) {
    this._disabled = v;
    if (v && doc.activeElement === this) doc.activeElement = doc.body;
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e);
  }
  /** A click as the engine delivers it: none on a disabled button, and the
   *  pressed button takes focus first. */
  click(): void {
    if (this._disabled) return;
    this.focus();
    this.fire("click", { target: this });
  }
  focus(): void {
    if (this._disabled) return;
    doc.activeElement = this;
  }
  select(): void {}
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  querySelector(sel: string): Stub {
    if (!this.stubs.has(sel)) this.stubs.set(sel, new Stub(sel, this));
    return this.stubs.get(sel)!;
  }
  querySelectorAll(sel: string): Stub[] {
    if (sel === '[data-act="cancel"]') return [this.querySelector('[data-act="cancel"]#x'), this.querySelector("#nimg-cancel")];
    if (sel === "[data-bg]") {
      return ["transparent", "white", "black", "colour"].map((b) => {
        const s = this.querySelector(`[data-bg="${b}"]`);
        s.dataset.bg = b;
        return s;
      });
    }
    return [];
  }
  contains(node: unknown): boolean {
    for (let n = node as Stub | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  appendChild(c: Stub): Stub {
    c.parent = this;
    return c;
  }
  remove(): void {
    this.parent = null;
    doc.removed.push(this);
  }
}

const doc = {
  body: new Stub("body"),
  activeElement: null as unknown,
  removed: [] as Stub[],
  createElement: (tag: string) => new Stub(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
};
vi.stubGlobal("document", doc);

const { openNewImageDialog } = await import("./new-image-dialog");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function open() {
  const created: string[] = [];
  const close = openNewImageDialog({ onCreated: (p) => void created.push(p), isDisposed: () => false });
  // The dialog's backdrop is the last stub appended to <body>.
  const backdrop = (doc.activeElement as Stub).parent!;
  return { close, created, backdrop, el: (sel: string) => backdrop.querySelector(sel) };
}

beforeEach(() => {
  m.pick = null;
  m.probe = null;
  m.save = null;
  m.errors = [];
  m.refusals = [];
  doc.activeElement = doc.body;
});

describe("New image project: focus while busy", () => {
  it("opens on Create", () => {
    const d = open();
    expect(doc.activeElement).toBe(d.el('[data-act="create"]'));
    d.close();
  });

  it("keeps focus inside through a cancelled photo pick, and hands it back to From a photo", async () => {
    const pick = deferred<string | null>();
    m.pick = () => pick.promise;
    const d = open();
    const photo = d.el('[data-act="photo"]');
    photo.click();
    // Busy: both actions are off, and focus waits on Cancel, inside the trap.
    expect(photo.disabled).toBe(true);
    expect(doc.activeElement).toBe(d.el("#nimg-cancel"));
    expect(d.backdrop.contains(doc.activeElement)).toBe(true);
    pick.resolve(null);
    await flush();
    expect(photo.disabled).toBe(false);
    expect(doc.activeElement).toBe(photo);
    d.close();
  });

  it("does the same after a refused pick, which is a refusal and not a failure", async () => {
    m.pick = async () => "C:\\Users\\u\\notes.txt";
    const d = open();
    const photo = d.el('[data-act="photo"]');
    photo.click();
    await flush();
    expect(m.refusals).toEqual(["Pick a still image."]);
    expect(m.errors).toEqual([]);
    expect(doc.activeElement).toBe(photo);
    d.close();
  });

  it("refuses a picked file that probes as something other than a still", async () => {
    m.pick = async () => "C:\\Users\\u\\clip.png";
    m.probe = async () => ({ kind: "video", path: "C:\\Users\\u\\clip.png" }) as MediaInfo;
    const d = open();
    d.el('[data-act="photo"]').click();
    await flush();
    expect(m.refusals).toEqual(["Pick a still image."]);
    expect(m.errors).toEqual([]);
    d.close();
  });

  it("hands focus back to Create after a failed save", async () => {
    m.save = async () => {
      throw new Error("disk full");
    };
    const d = open();
    const create = d.el('[data-act="create"]');
    create.click();
    expect(doc.activeElement).toBe(d.el("#nimg-cancel"));
    await flush();
    expect(m.errors).toEqual(["disk full"]);
    expect(d.created).toEqual([]);
    expect(doc.activeElement).toBe(create);
    d.close();
  });

  it("closes on a successful Create without touching focus afterwards", async () => {
    const d = open();
    d.el('[data-act="create"]').click();
    await flush();
    expect(d.created).toEqual(["C:\\Docs\\Taroting\\Untitled image.trt"]);
    expect(doc.removed).toContain(d.backdrop);
  });
});
