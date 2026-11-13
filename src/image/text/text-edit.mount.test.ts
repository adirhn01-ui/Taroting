// The in-place text editor and the inspector's text section, mounted against
// a small fake DOM (vitest runs in node) and a session with a real history:
// how an open edit lands when something else writes the project, what a new
// or blank layer leaves behind, Ctrl+Z inside the text, a paste past the
// cap, a font that arrives after the edit closed, and a style that waits for
// its font while the text moves on.
//
// Fixture values differ on every axis the code could confuse: the layer's
// x is moved by an earlier step, so a step that merged the text into it
// shows; the fallback and the real font measure to different widths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankImageProject } from "../../core/image-project";
import { Store } from "../../core/store";
import type { Generator, ProjectFile } from "../../core/types";
import { addGeneratorLayer, addTextLayer, findLayer, layersOf, setLayerHidden, setLayerTransform, setTextGen, TEXT_MAX_CHARS } from "../layers";
import { DEFAULT_TOOL_STATE } from "../tool-state";

type TextGen = Extract<Generator, { type: "text" }>;

/* ---------------- fonts: one that loads late ---------------- */

const fonts = vi.hoisted(() => ({
  /** font ids whose faces are still loading: their measure waits */
  slow: new Set<string>(),
  waiting: [] as (() => void)[],
  picks: [] as ((v: { legacy: string; fontId?: string }) => void)[],
}));

vi.mock("../../editor/media/generators", () => {
  const box = (g: TextGen, perChar: number) => {
    const lines = g.text.split("\n");
    return {
      width: Math.max(...lines.map((l) => l.length)) * perChar + 2,
      height: Math.round(lines.length * g.sizePx * 1.25),
    };
  };
  // The fallback measures 10 px a character, the real slow font 17.
  const real = (g: TextGen) => box(g, g.fontId !== undefined && g.fontId === "lib:Slow" ? 17 : 10);
  return {
    cssFont: (g: TextGen) => `${g.sizePx}px/1.25 ${g.fontFamily}`,
    measureText: (g: TextGen) => box(g, 10),
    measureTextWhenReady: (g: TextGen) => {
      if (g.fontId === undefined || !fonts.slow.has(g.fontId)) return { gen: g, ...real(g) };
      return new Promise((resolve) => {
        fonts.waiting.push(() => resolve({ gen: g, ...real(g) }));
      });
    },
    withFont: (g: TextGen, v: { legacy: TextGen["fontFamily"]; fontId?: string }) => {
      const { fontId: _drop, ...rest } = g;
      void _drop;
      return v.fontId === undefined ? { ...rest, fontFamily: v.legacy } : { ...rest, fontFamily: v.legacy, fontId: v.fontId };
    },
    styleAvailability: () => ({ bold: true, italic: true }),
  };
});
vi.mock("../../fonts", () => ({
  mountFontPicker: (_host: unknown, o: { onPick: (v: { legacy: string; fontId?: string }) => void }) => {
    fonts.picks.push(o.onPick);
    return { dispose() {}, refresh() {} };
  },
}));

/** The font has loaded: every measure waiting for it resolves. */
async function fontsArrive(): Promise<void> {
  fonts.slow.clear();
  for (const w of fonts.waiting.splice(0)) w();
  await settle();
}

/* ---------------- a fake DOM ---------------- */

type Handler = (e: Record<string, unknown>) => void;

class FNode {
  parentNode: FEl | null = null;
}

class FEl extends FNode {
  readonly tagName: string;
  className = "";
  children: FEl[] = [];
  textContent = "";
  title = "";
  type = "";
  value = "";
  min = "";
  max = "";
  step = "";
  checked = false;
  disabled = false;
  spellcheck = true;
  clientLeft = 0;
  clientTop = 0;
  dataset: Record<string, string> = {};
  style: Record<string, unknown> & { setProperty(k: string, v: string): void } = {
    setProperty(k: string, v: string) {
      (this as Record<string, unknown>)[k] = v;
    },
  };
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<Handler>>();
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get innerText(): string {
    return this.textContent;
  }
  get lastChild(): null {
    return null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  /** Dispatch to this element's own listeners; the event, for its flags. */
  fire(t: string, init: Record<string, unknown> = {}): Record<string, unknown> {
    const ev: Record<string, unknown> = {
      target: this,
      defaultPrevented: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
      stopPropagation() {},
      ...init,
    };
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev);
    return ev;
  }
  appendChild<T extends FEl>(c: T): T {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
    if (doc.activeElement === this) doc.activeElement = doc.body;
  }
  contains(n: unknown): boolean {
    for (let x = n as FNode | null; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  closest(sel: string): FEl | null {
    const want = sel.split(",").map((s) => s.trim().replace(/^\./, ""));
    for (let x: FEl | null = this; x; x = x.parentNode) {
      const cls = x.className.split(" ");
      if (want.some((w) => cls.includes(w))) return x;
    }
    return null;
  }
  focus(): void {
    doc.activeElement = this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  }
  find(pred: (e: FEl) => boolean): FEl | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const f = c.find(pred);
      if (f) return f;
    }
    return null;
  }
}

const docListeners = new Map<string, Set<Handler>>();
const doc = {
  body: new FEl("body"),
  activeElement: null as FEl | null,
  createElement: (t: string) => new FEl(t),
  querySelector: () => null,
  addEventListener(t: string, fn: Handler) {
    if (!docListeners.has(t)) docListeners.set(t, new Set());
    docListeners.get(t)!.add(fn);
  },
  removeEventListener(t: string, fn: Handler) {
    docListeners.get(t)?.delete(fn);
  },
};
/** A press anywhere on the page, as the document's capture listeners see it. */
function press(target: FEl): void {
  const ev = { target, button: 0 };
  for (const fn of [...(docListeners.get("pointerdown") ?? [])]) fn(ev);
}

beforeEach(() => {
  vi.stubGlobal("Node", FNode);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => "", removeAllRanges() {}, addRange() {} }),
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  });
  fonts.slow.clear();
  fonts.waiting.length = 0;
  fonts.picks.length = 0;
  docListeners.clear();
  doc.activeElement = doc.body;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const { openTextEditor } = await import("./text-edit");
const { buildTextSection } = await import("./text-section");

/* ---------------- a session with a real history ---------------- */

class FakeSession {
  readonly store: Store<ProjectFile>;
  past: ProjectFile[] = [];
  future: ProjectFile[] = [];
  edited = false;
  constructor(p: ProjectFile) {
    this.store = new Store(p);
  }
  get project(): ProjectFile {
    return this.store.get();
  }
  commit(m: (p: ProjectFile) => ProjectFile): void {
    const b = this.store.get();
    const a = m(b);
    if (a === b) return;
    this.past.push(b);
    this.future = [];
    this.store.set(a);
    this.edited = true;
  }
  commitFrom(before: ProjectFile): void {
    if (this.store.get() === before) return;
    this.past.push(before);
    this.future = [];
    this.edited = true;
  }
  replace(next: ProjectFile, opts?: { edit?: boolean }): void {
    if (next === this.store.get()) return;
    this.store.set(next);
    if (opts?.edit !== false) this.edited = true;
  }
  undo(): void {
    const p = this.past.pop();
    if (!p) return;
    this.future.push(this.store.get());
    this.store.set(p);
  }
  redo(): void {
    const p = this.future.pop();
    if (!p) return;
    this.past.push(this.store.get());
    this.store.set(p);
  }
}

/** Store notifications are batched to a microtask. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Hi",
  fontFamily: "Georgia",
  sizePx: 30,
  color: "#abcdef",
  bold: false,
  italic: false,
  ...over,
});

function setup(g: TextGen = gen()) {
  let p = createBlankImageProject("Card", 301, 203, "#ffffff");
  const other = addGeneratorLayer(p, { type: "solid", color: "#123456" }, 40, 30, "Solid");
  p = other.project;
  const made = addGeneratorLayer(p, g, 22, 38, "Text");
  p = made.project;
  const session = new FakeSession(p);
  const stage = new FEl("div");
  const inspector = new FEl("div");
  inspector.className = "inspector";
  const layerSection = inspector.appendChild(new FEl("div"));
  layerSection.className = "insp-section";
  const opacity = layerSection.appendChild(new FEl("input"));
  const ctx = {
    session,
    stage,
    tools: new Store(DEFAULT_TOOL_STATE),
    selection: new Store<string | null>(made.trackId),
    mode: new Store<"idle" | "crop-image" | "crop-layer">("idle"),
    view: {
      store: new Store({ zoom: 1, panX: 0, panY: 0, dpr: 1, stageW: 800, stageH: 600 }),
      canvasToClient: (x: number, y: number) => ({ x, y }),
      clientToCanvas: (x: number, y: number) => ({ x, y }),
      panning: false,
    },
    requestRender() {},
  };
  return { session, ctx, stage, opacity, trackId: made.trackId, otherId: other.trackId };
}
type Setup = ReturnType<typeof setup>;

function open(t: Setup, isNew = false, before = t.session.project, prevSelection: string | null = t.trackId) {
  const closes: string[] = [];
  const ed = openTextEditor({
    ctx: t.ctx as never,
    trackId: t.trackId,
    before,
    isNew,
    prevSelection,
    caret: "end",
    onClose: (how) => void closes.push(how),
  });
  if (!ed) throw new Error("not opened");
  const div = t.stage.children.find((c) => c.className === "imged-textedit")!;
  const type = (text: string) => {
    div.textContent = text;
    div.fire("input");
  };
  const key = (k: string, mods: Record<string, unknown> = {}) =>
    div.fire("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, isComposing: false, ...mods });
  return { ed, div, type, key, closes };
}

/** A NEW text placed the Text tool's way: not an edit, no step. */
function placeNew(t: Setup) {
  const before = t.session.project;
  const made = addTextLayer(before, gen({ text: "" }), 2, 38, { x: 50, y: 60 }, { above: null });
  t.session.replace(made.project, { edit: false });
  t.ctx.selection.set(made.trackId);
  return { before, trackId: made.trackId };
}

const textOf = (p: ProjectFile, id: string) => (findLayer(p, id)?.media.generator as TextGen | undefined)?.text;

/* ------------------------------------------------------------------ */

describe("another writer while a text is open", () => {
  it("a press on the layer controls lands the edit first, so its step sits on top of the text's", async () => {
    const t = setup();
    // Step A: an earlier, unrelated move.
    t.session.commit((p) => setLayerTransform(p, t.trackId, { x: 7 }));
    const e = open(t);
    e.type("Hey");
    // The opacity field is in the inspector, outside its text section.
    press(t.opacity);
    expect(e.ed.closed).toBe(true);
    t.session.commit((p) => setLayerTransform(p, t.trackId, { opacity: 0.5 }));
    await settle();
    expect(t.session.past).toHaveLength(3);
    t.session.undo();
    expect(textOf(t.session.project, t.trackId)).toBe("Hey");
    expect(findLayer(t.session.project, t.trackId)!.transform.opacity).toBe(1);
    t.session.undo();
    expect(textOf(t.session.project, t.trackId)).toBe("Hi");
    expect(findLayer(t.session.project, t.trackId)!.transform.x).toBe(7);
  });

  it("a history write with no press first (a drop) still lands the edit before its own step", async () => {
    const t = setup();
    t.session.commit((p) => setLayerTransform(p, t.trackId, { x: 7 }));
    const e = open(t);
    e.type("Hey");
    t.session.commit((p) => setLayerHidden(p, t.otherId, true));
    await settle();
    expect(e.ed.closed).toBe(true);
    expect(e.closes).toEqual(["other"]);
    expect(t.session.past).toHaveLength(3);
    t.session.undo();
    expect(findLayer(t.session.project, t.otherId)!.hidden).toBe(false);
    expect(textOf(t.session.project, t.trackId)).toBe("Hey");
    t.session.undo();
    expect(textOf(t.session.project, t.trackId)).toBe("Hi");
    expect(findLayer(t.session.project, t.trackId)!.transform.x).toBe(7);
    // The session's own methods are back once the edit is gone.
    expect(Object.prototype.hasOwnProperty.call(t.session, "commit")).toBe(false);
  });

  it("an undo that is not the editor's lands the edit first and then takes it back whole", async () => {
    const t = setup();
    t.session.commit((p) => setLayerTransform(p, t.trackId, { x: 7 }));
    const e = open(t);
    e.type("Hey");
    t.session.undo();
    await settle();
    expect(e.ed.closed).toBe(true);
    expect(textOf(t.session.project, t.trackId)).toBe("Hi");
    expect(findLayer(t.session.project, t.trackId)!.transform.x).toBe(7);
  });

  it("a write with no step of its own closes the edit WITH its step", async () => {
    const t = setup();
    const e = open(t);
    e.type("Hey");
    t.session.replace(setLayerHidden(t.session.project, t.otherId, true), { edit: false });
    await settle();
    expect(e.ed.closed).toBe(true);
    expect(t.session.past).toHaveLength(1);
    expect(textOf(t.session.past[0]!, t.trackId)).toBe("Hi");
  });

  it("a new text still empty is taken back whichever way the edit ends", async () => {
    // A press on the layer controls.
    let t = setup();
    let n = placeNew(t);
    t.trackId = n.trackId;
    let e = open(t, true, n.before, null);
    press(t.opacity);
    t.session.commit((p) => setLayerHidden(p, t.otherId, true));
    await settle();
    expect(findLayer(t.session.project, n.trackId)).toBeUndefined();
    expect(layersOf(t.session.project)).toHaveLength(2);
    expect(t.session.past).toHaveLength(1);
    // A fix-up with no step: the layer goes, the fix-up stays.
    t = setup();
    n = placeNew(t);
    t.trackId = n.trackId;
    e = open(t, true, n.before, null);
    t.session.replace(setLayerHidden(t.session.project, t.otherId, true), { edit: false });
    await settle();
    expect(e.ed.closed).toBe(true);
    expect(findLayer(t.session.project, n.trackId)).toBeUndefined();
    expect(findLayer(t.session.project, t.otherId)!.hidden).toBe(true);
    expect(t.session.past).toHaveLength(0);
    expect(t.session.edited).toBe(false);
  });

  it("a press in the text section or a font list keeps the text open", () => {
    const t = setup();
    const e = open(t);
    const section = new FEl("div");
    section.className = "insp-section imged-text-section";
    const bold = section.appendChild(new FEl("input"));
    press(bold);
    const list = new FEl("div");
    list.className = "fontpk";
    press(list.appendChild(new FEl("button")));
    expect(e.ed.closed).toBe(false);
  });
});

describe("what an edit leaves", () => {
  it("a layer that was blank to begin with, opened and closed, stays as it was", () => {
    const t = setup(gen({ text: " \n" }));
    const before = t.session.project;
    const e = open(t);
    e.key("Escape");
    expect(e.ed.closed).toBe(true);
    expect(t.session.project).toBe(before);
    expect(t.session.past).toHaveLength(0);
  });

  it("a layer the user emptied is removed in one step", () => {
    const t = setup();
    const e = open(t);
    e.type("");
    e.key("Escape");
    expect(findLayer(t.session.project, t.trackId)).toBeUndefined();
    expect(t.session.past).toHaveLength(1);
    t.session.undo();
    expect(textOf(t.session.project, t.trackId)).toBe("Hi");
  });

  it("a new text typed in and cleared again is not an edit", () => {
    const t = setup();
    const n = placeNew(t);
    t.trackId = n.trackId;
    const e = open(t, true, n.before, null);
    e.type("a");
    e.type("");
    e.key("Escape");
    expect(t.session.project).toBe(n.before);
    expect(t.session.past).toHaveLength(0);
    expect(t.session.edited).toBe(false);
  });

  it("a new text with something in it is one step and an edit", () => {
    const t = setup();
    const n = placeNew(t);
    t.trackId = n.trackId;
    const e = open(t, true, n.before, null);
    e.type("a");
    e.key("Escape");
    expect(t.session.past).toEqual([n.before]);
    expect(t.session.edited).toBe(true);
  });

  it("a paste past the cap leaves in the text only what the layer holds", () => {
    const t = setup(gen({ text: "x".repeat(TEXT_MAX_CHARS - 2) }));
    const e = open(t);
    e.type("x".repeat(TEXT_MAX_CHARS - 2) + "abcdef");
    expect(textOf(t.session.project, t.trackId)).toHaveLength(TEXT_MAX_CHARS);
    expect(e.div.textContent).toHaveLength(TEXT_MAX_CHARS);
    expect(e.div.textContent.endsWith("xab")).toBe(true);
  });
});

describe("Ctrl+Z inside the text", () => {
  it("steps through this editor's own typing bursts, and never past where it began", () => {
    const t = setup();
    const now = vi.spyOn(Date, "now");
    const e = open(t);
    // Nothing typed yet: the browser's page-wide undo is never reached.
    expect(e.key("z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(e.div.textContent).toBe("Hi");
    now.mockReturnValue(1000);
    e.type("Hi t");
    now.mockReturnValue(1300); // the same burst
    e.type("Hi th");
    now.mockReturnValue(2500); // a new burst
    e.type("Hi the");
    expect(e.key("z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(e.div.textContent).toBe("Hi th");
    expect(textOf(t.session.project, t.trackId)).toBe("Hi th");
    e.key("z", { ctrlKey: true });
    expect(e.div.textContent).toBe("Hi");
    e.key("z", { ctrlKey: true });
    expect(e.div.textContent).toBe("Hi");
    e.key("y", { ctrlKey: true });
    expect(e.div.textContent).toBe("Hi th");
    e.key("z", { ctrlKey: true, shiftKey: true });
    expect(e.div.textContent).toBe("Hi the");
    // The edit menu's Undo reaches the same list.
    expect(e.div.fire("beforeinput", { inputType: "historyUndo" }).defaultPrevented).toBe(true);
    expect(e.div.textContent).toBe("Hi th");
    // Still ONE step when it lands.
    e.key("Escape");
    expect(t.session.past).toHaveLength(1);
    expect(textOf(t.session.project, t.trackId)).toBe("Hi th");
  });
});

describe("a font that loads late", () => {
  it("an edit closed before its font arrived is measured again when it does, with no step of its own", async () => {
    const t = setup(gen({ fontFamily: "Segoe UI", fontId: "lib:Slow" }));
    fonts.slow.add("lib:Slow");
    const e = open(t);
    e.type("Hello");
    e.key("Escape");
    // Landed with the fallback's measure (10 px a character).
    expect(textOf(t.session.project, t.trackId)).toBe("Hello");
    expect(findLayer(t.session.project, t.trackId)!.media.width).toBe(52);
    expect(t.session.past).toHaveLength(1);
    await fontsArrive();
    expect(findLayer(t.session.project, t.trackId)!.media.width).toBe(87);
    expect(t.session.past).toHaveLength(1);
  });

  it("is not measured again once the step was undone", async () => {
    const t = setup(gen({ fontFamily: "Segoe UI", fontId: "lib:Slow" }));
    fonts.slow.add("lib:Slow");
    const e = open(t);
    e.type("Hello");
    e.key("Escape");
    t.session.undo();
    const undone = t.session.project;
    await fontsArrive();
    expect(t.session.project).toBe(undone);
  });
});

describe("the inspector's text section", () => {
  function section(t: Setup, closed = () => false) {
    const watchers: (() => void)[] = [];
    const s = buildTextSection(t.ctx as never, t.trackId, {
      watch: (read, write) => {
        let last: unknown = Symbol();
        const run = () => {
          const v = read();
          if (v !== last) write((last = v) as never);
        };
        run();
        watchers.push(run);
      },
      onCleanup() {},
      closed,
    }) as unknown as FEl;
    t.session.store.subscribe(() => watchers.forEach((w) => w()));
    return s;
  }

  it("a font that loads while the text was typed in goes onto the new text, never over it", async () => {
    const t = setup();
    section(t);
    fonts.slow.add("lib:Slow");
    fonts.picks[0]!({ legacy: "Segoe UI", fontId: "lib:Slow" });
    // Typed meanwhile (an editor's write).
    const g = findLayer(t.session.project, t.trackId)!.media.generator as TextGen;
    t.session.replace(setTextGen(t.session.project, t.trackId, { ...g, text: "Hi there" }, 82, 38));
    await fontsArrive();
    const now = findLayer(t.session.project, t.trackId)!.media.generator as TextGen;
    expect(now.text).toBe("Hi there");
    expect(now.fontId).toBe("lib:Slow");
    expect(t.session.past).toHaveLength(1);
  });

  it("a font that loads after the editor closed lands nothing", async () => {
    const t = setup();
    let gone = false;
    section(t, () => gone);
    fonts.slow.add("lib:Slow");
    fonts.picks[0]!({ legacy: "Segoe UI", fontId: "lib:Slow" });
    gone = true;
    await fontsArrive();
    expect(t.session.past).toHaveLength(0);
    expect((findLayer(t.session.project, t.trackId)!.media.generator as TextGen).fontId).toBeUndefined();
  });

  it("Edit text is greyed on a hidden layer and says why", async () => {
    const t = setup();
    const s = section(t);
    const btn = s.find((e) => e.className.includes("imged-text-edit-btn"))!;
    expect(btn.disabled).toBe(false);
    t.session.commit((p) => setLayerHidden(p, t.trackId, true));
    await settle();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Show this layer to type in it");
    t.session.undo();
    await settle();
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe("Type in this text on the canvas");
  });
});
