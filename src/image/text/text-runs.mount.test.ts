// Styling part of a text in the image editor's in-place text tool (0.9.5),
// mounted against a small fake DOM with real child nodes and a selection the
// test moves, and a session with a real history.
//
// Fixture: "Hello world" in Georgia 30 px #abcdef; "world" [6, 11) carries a
// 64 px run in a different colour, so a span built in the base style, a size
// read from the base, or a colour cleared from the wrong field each shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankImageProject } from "../../core/image-project";
import { Store } from "../../core/store";
import type { Generator, PdfTextRun, ProjectFile } from "../../core/types";
import { addGeneratorLayer, findLayer } from "../layers";
import { DEFAULT_TOOL_STATE } from "../tool-state";
import type { TextEditHandle } from "../context";

type TextGen = Extract<Generator, { type: "text" }>;

const notes = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock("../../editor/media/generators", () => {
  const box = (g: TextGen) => {
    const lines = g.text.split("\n");
    return { width: Math.max(...lines.map((l) => l.length)) * 10 + 2, height: Math.round(lines.length * g.sizePx * 1.25) };
  };
  return {
    cssFont: (g: TextGen) => `${g.bold ? "bold " : ""}${g.sizePx}px/1.25 ${g.fontFamily}`,
    measureText: box,
    measureTextWhenReady: (g: TextGen) => ({ gen: g, ...box(g) }),
    withFont: (g: TextGen, v: { legacy: TextGen["fontFamily"]; fontId?: string }) => ({ ...g, fontFamily: v.legacy }),
    styleAvailability: (f: string) => ({ bold: f !== "Impact", italic: f !== "Impact" }),
  };
});
// The shared font picker: a button in its host, as the real one makes.
const picks = vi.hoisted(() => ({ list: [] as ((v: { legacy: string; fontId?: string }) => void)[] }));
vi.mock("../../fonts", () => ({
  mountFontPicker: (host: { appendChild(n: unknown): unknown }, o: { onPick: (v: { legacy: string; fontId?: string }) => void }) => {
    host.appendChild((document as unknown as { createElement(t: string): unknown }).createElement("button"));
    picks.list.push(o.onPick);
    return { dispose() {}, refresh() {} };
  },
}));
vi.mock("../../ui/toast",() => ({ toast: { notice: (m: string) => void notes.list.push(m), info() {}, error() {} } }));

/* ---------------- a fake DOM with child nodes ---------------- */

type Handler = (e: Record<string, unknown>) => void;

class FNode {
  parentNode: FEl | null = null;
  childNodes: FNode[] = [];
  constructor(readonly nodeType: number) {}
  get firstChild(): FNode | null {
    return this.childNodes[0] ?? null;
  }
  contains(n: unknown): boolean {
    for (let x = n as FNode | null; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
}
class FText extends FNode {
  constructor(public data: string) {
    super(3);
  }
  get textContent(): string {
    return this.data;
  }
}
class FEl extends FNode {
  readonly tagName: string;
  className = "";
  title = "";
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
    super(1);
    this.tagName = tag.toUpperCase();
  }
  get children(): FEl[] {
    return this.childNodes.filter((c): c is FEl => c instanceof FEl);
  }
  get textContent(): string {
    return this.childNodes.map((c) => (c instanceof FText ? c.data : c instanceof FEl ? c.textContent : "")).join("");
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "") this.appendChild(new FText(v));
  }
  get innerText(): string {
    return this.textContent;
  }
  get lastChild(): FNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  innerHTML = "";
  classList = {
    contains: (c: string) => this.className.split(" ").includes(c),
    add: (c: string) => void this.classList.toggle(c, true),
    remove: (c: string) => void this.classList.toggle(c, false),
    toggle: (c: string, on?: boolean): boolean => {
      const set = new Set(this.className.split(" ").filter(Boolean));
      const want = on ?? !set.has(c);
      if (want) set.add(c);
      else set.delete(c);
      this.className = [...set].join(" ");
      return want;
    },
  };
  append(...cs: FNode[]): void {
    for (const c of cs) this.appendChild(c);
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  listenerCount(t: string): number {
    return this.listeners.get(t)?.size ?? 0;
  }
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
  appendChild<T extends FNode>(c: T): T {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild<T extends FNode>(c: T): T {
    this.childNodes = this.childNodes.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
    if (doc.activeElement === this) doc.activeElement = doc.body;
  }
  closest(): null {
    return null;
  }
  focus(): void {
    doc.activeElement = this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  }
}

/** The document selection, as the test sets it. */
const selection = {
  anchorNode: null as FNode | null,
  anchorOffset: 0,
  focusNode: null as FNode | null,
  focusOffset: 0,
  get rangeCount() {
    return this.anchorNode ? 1 : 0;
  },
  get isCollapsed() {
    return this.anchorNode === this.focusNode && this.anchorOffset === this.focusOffset;
  },
  toString: () => "",
  getRangeAt() {
    const n = this.anchorNode;
    return { startContainer: n, cloneRange: () => ({ startContainer: n }) };
  },
  removeAllRanges() {
    this.anchorNode = null;
    this.focusNode = null;
  },
  addRange() {},
  setBaseAndExtent(a: FNode, ao: number, f: FNode, fo: number) {
    this.anchorNode = a;
    this.anchorOffset = ao;
    this.focusNode = f;
    this.focusOffset = fo;
  },
};

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
const fireDoc = (t: string): void => {
  for (const fn of [...(docListeners.get(t) ?? [])]) fn({});
};

beforeEach(() => {
  vi.stubGlobal("Node", FNode);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    getSelection: () => selection,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  });
  docListeners.clear();
  selection.removeAllRanges();
  doc.activeElement = doc.body;
  notes.list.length = 0;
  picks.list.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const { openTextEditor, KEPT_HIGHLIGHT } = await import("./text-edit");
const { pointAt, offsetOf } = await import("../../ui/rich-text/dom");
const { buildTextSection, RTL_RANGE_TITLE } = await import("./text-section");

/* ---------------- a session with a real history ---------------- */

class FakeSession {
  readonly store: Store<ProjectFile>;
  past: ProjectFile[] = [];
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
    this.store.set(a);
  }
  commitFrom(before: ProjectFile): void {
    if (this.store.get() === before) return;
    this.past.push(before);
  }
  replace(next: ProjectFile): void {
    this.store.set(next);
  }
  undo(): void {}
  redo(): void {}
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const RUN: PdfTextRun = { s: 6, e: 11, size: 64, c: "#ff3300" };
const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Hello world",
  fontFamily: "Georgia",
  sizePx: 30,
  color: "#abcdef",
  bold: false,
  italic: false,
  runs: [RUN],
  ...over,
});

function setup(g: TextGen = gen()) {
  const blank = createBlankImageProject("Card", 301, 203, "#ffffff");
  const made = addGeneratorLayer(blank, g, 112, 80, "Text");
  const session = new FakeSession(made.project);
  const stage = new FEl("div");
  const textEdit = new Store<TextEditHandle | null>(null);
  const ctx = {
    session,
    stage,
    textEdit,
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
  const before = session.project;
  const ed = openTextEditor({
    ctx: ctx as never,
    trackId: made.trackId,
    before,
    isNew: false,
    prevSelection: made.trackId,
    caret: "end",
    onClose: () => {},
  })!;
  textEdit.set(ed);
  const div = stage.children.find((c) => c.className === "imged-textedit")!;
  const genNow = () => findLayer(session.project, made.trackId)!.media.generator as TextGen;
  /** select [s, e) of the text and tell the editor */
  const select = (s: number, e: number) => {
    const a = pointAt(div as never, s);
    const b = pointAt(div as never, e);
    selection.setBaseAndExtent(a.node as never, a.offset, b.node as never, b.offset);
    fireDoc("selectionchange");
  };
  const key = (k: string, mods: Record<string, unknown> = {}) => div.fire("keydown", { key: k, code: `Key${k.toUpperCase()}`, isComposing: false, ...mods });
  return { session, ctx, textEdit, ed, div, before, genNow, select, key };
}

describe("styled parts in the in-place text tool", () => {
  it("opens a text with runs as transparent spans in each part's font", () => {
    const t = setup();
    const spans = t.div.children;
    expect(spans.map((s) => s.textContent)).toEqual(["Hello ", "world"]);
    expect(spans[0]!.style.font).toBe("30px/1.25 Georgia");
    expect(spans[1]!.style.font).toBe("64px/1.25 Georgia");
    // never a colour of their own: the canvas paints the pixels
    expect(spans.every((s) => s.style.color === undefined)).toBe(true);
  });

  it("a selection publishes a fresh handle; a range style lands as ONE step on close", async () => {
    const t = setup();
    t.select(0, 5);
    await settle();
    const h = t.textEdit.get()!;
    expect(h).not.toBe(t.ed);
    expect(h.range).toEqual({ s: 0, e: 5 });
    expect(h.styleOf!().size).toBe(30);
    h.applyRange!({ color: "#00FF00" });
    expect(t.genNow().runs).toEqual([{ s: 0, e: 5, c: "#00ff00" }, RUN]);
    expect(t.session.past).toHaveLength(0);
    await settle();
    // the inspector re-reads the style from a new handle
    expect(t.textEdit.get()).not.toBe(h);
    t.ed.commit();
    expect(t.session.past).toEqual([t.before]);
    expect(t.textEdit.get()).toBeNull();
  });

  it("with nothing selected a colour is the whole text's and leaves the runs", () => {
    const t = setup();
    t.ed.restyle({ color: "#010203" });
    const g = t.genNow();
    expect(g.color).toBe("#010203");
    expect(g.runs).toEqual([{ s: 6, e: 11, size: 64 }]);
  });

  it("Ctrl+Z inside the text steps the editor's own list, and stops at the opening state", () => {
    const t = setup();
    t.select(0, 5);
    t.ed.applyRange!({ bold: true });
    expect(t.genNow().runs).toEqual([{ s: 0, e: 5, bold: true }, RUN]);
    t.key("z", { ctrlKey: true });
    expect(t.genNow().runs).toEqual([RUN]);
    t.key("z", { ctrlKey: true });
    expect(t.genNow().runs).toEqual([RUN]);
    t.key("y", { ctrlKey: true });
    expect(t.genNow().runs).toEqual([{ s: 0, e: 5, bold: true }, RUN]);
  });

  it("Ctrl+B with a range toggles bold; with a caret it is not taken", () => {
    const t = setup();
    t.select(6, 11);
    const ev = t.key("b", { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(t.genNow().runs).toEqual([{ ...RUN, bold: true }]);
    t.select(3, 3);
    const caret = t.key("b", { ctrlKey: true });
    expect(caret.defaultPrevented).toBe(false);
    expect(t.genNow().runs).toEqual([{ ...RUN, bold: true }]);
  });

  it("a right-to-left text keeps its runs and refuses a range style", () => {
    const t = setup(gen({ text: "Hello אorld" }));
    t.select(0, 5);
    t.ed.applyRange!({ color: "#00ff00" });
    expect(t.genNow().runs).toEqual([RUN]);
    // shown in the base style: one span
    expect(t.div.children.map((s) => s.style.font)).toEqual(["30px/1.25 Georgia"]);
  });

  it("past the run cap nothing changes and one notice says so", () => {
    const text = "ab".repeat(2000);
    const runs: PdfTextRun[] = [];
    for (let i = 0; i < 2000; i++) runs.push({ s: i * 2, e: i * 2 + 1, c: i % 2 ? "#010101" : "#020202" });
    const t = setup(gen({ text, runs }));
    const before = t.genNow();
    t.select(text.length - 1, text.length);
    t.ed.applyRange!({ color: "#030303" });
    expect(t.genNow()).toBe(before);
    expect(notes.list).toEqual(["This text has too many styles to add another"]);
  });

  it("typing inside a styled part keeps its style", () => {
    const t = setup();
    // the browser typed "!" at the end of "world"
    const last = t.div.children[1]!.childNodes[0] as FText;
    last.data = "world!";
    selection.setBaseAndExtent(last, 6, last, 6);
    t.div.fire("input", { inputType: "insertText" });
    expect(t.genNow().text).toBe("Hello world!");
    expect(t.genNow().runs).toEqual([{ ...RUN, e: 12 }]);
  });

  it("the tool row's font with a part selected styles that part and keeps the other parts' fonts", () => {
    const own: PdfTextRun = { s: 0, e: 5, font: "Courier New" };
    const t = setup(gen({ runs: [own, RUN] }));
    t.select(6, 11);
    // what toolbar.ts does with a pick: restyle the published handle
    t.textEdit.get()!.restyle({ font: { legacy: "Arial" } });
    const g = t.genNow();
    expect(g.fontFamily).toBe("Georgia");
    expect(g.runs).toEqual([own, { ...RUN, font: "Arial" }]);
  });

  it("the tool row's style on a right-to-left text with a part selected is the whole text's", () => {
    const t = setup(gen({ text: "Hello אorld" }));
    t.select(0, 5);
    t.textEdit.get()!.restyle({ color: "#00ff00" });
    const g = t.genNow();
    expect(g.color).toBe("#00ff00");
    expect(g.runs).toEqual([{ s: 6, e: 11, size: 64 }]);
  });
});

describe("the inspector's text section on a styled text", () => {
  type Node = { tagName: string; type?: string; disabled?: boolean; title?: string; value?: string; children: Node[]; fire?(t: string): unknown };
  const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
  function section(t: ReturnType<typeof setup>) {
    const watchers: (() => void)[] = [];
    const root = buildTextSection(t.ctx as never, t.ctx.selection.get()!, {
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
    }) as unknown as Node;
    t.session.store.subscribe(() => watchers.forEach((w) => w()));
    const els = all(root);
    return {
      fontBtn: els.find((e) => e.tagName === "BUTTON" && e.type !== "button")!,
      color: els.find((e) => e.tagName === "INPUT" && e.type === "color")!,
      size: els.find((e) => e.tagName === "INPUT" && e.type === "number")!,
    };
  }

  it("a selected part of a right-to-left text disables every range control, the font too", async () => {
    const t = setup(gen({ text: "Hello אorld" }));
    const s = section(t);
    expect(s.fontBtn.disabled).toBe(false);
    t.select(0, 5);
    await settle();
    expect(s.size.disabled).toBe(true);
    expect(s.color.disabled).toBe(true);
    expect(s.fontBtn.disabled).toBe(true);
    expect(s.size.title).toBe(RTL_RANGE_TITLE);
    t.select(2, 2);
    await settle();
    expect(s.fontBtn.disabled).toBe(false);
    expect(s.color.title).toBe("");
  });

  it("a colour with a part selected styles that part; with none, the whole text", async () => {
    const t = setup();
    const s = section(t);
    t.select(0, 5);
    await settle();
    s.color.value = "#00aa00";
    (s.color as unknown as { fire(t: string): unknown }).fire("change");
    expect(t.genNow().color).toBe("#abcdef");
    expect(t.genNow().runs).toEqual([{ s: 0, e: 5, c: "#00aa00" }, RUN]);
    t.select(3, 3);
    await settle();
    s.color.value = "#0000aa";
    (s.color as unknown as { fire(t: string): unknown }).fire("change");
    expect(t.genNow().color).toBe("#0000aa");
    expect(t.genNow().runs).toEqual([{ s: 6, e: 11, size: 64 }]);
  });
});

const { mountToolbar } = await import("../toolbar");

describe("the tool row's font and the inspector's size on an open text", () => {
  /** The real tool row over the open text; its font picker's pick. */
  function toolbar(t: ReturnType<typeof setup>) {
    const host = new FEl("div");
    const h = mountToolbar(host as never, { ...t.ctx, registerOverlay: () => () => {} } as never);
    const pick = picks.list[picks.list.length - 1]!;
    return { pick, dispose: () => h.dispose() };
  }
  // "Hello" [0, 5) has its own font, so a whole-text font that leaves the
  // runs' font alone, or a range font that lands on the base, each shows.
  const OWN: PdfTextRun = { s: 0, e: 5, font: "Courier New" };

  it("with a part selected, a font picked in the tool row styles that part only", () => {
    const t = setup(gen({ runs: [OWN, RUN] }));
    const tb = toolbar(t);
    t.select(6, 11);
    tb.pick({ legacy: "Arial" });
    const g = t.genNow();
    expect(g.fontFamily).toBe("Georgia");
    expect(g.runs).toEqual([OWN, { ...RUN, font: "Arial" }]);
    expect(t.ctx.tools.get().font).toEqual({ legacy: "Arial" });
    tb.dispose();
  });

  it("with a caret, the font is the whole text's and leaves every run", () => {
    const t = setup(gen({ runs: [OWN, RUN] }));
    const tb = toolbar(t);
    t.select(3, 3);
    tb.pick({ legacy: "Arial" });
    const g = t.genNow();
    expect(g.fontFamily).toBe("Arial");
    expect(g.runs).toEqual([RUN]);
    tb.dispose();
  });

  it("with no text open, the pick is the tool's font for the next text only", () => {
    const t = setup(gen({ runs: [OWN, RUN] }));
    t.ed.commit();
    const before = t.genNow();
    const tb = toolbar(t);
    tb.pick({ legacy: "Arial" });
    expect(t.genNow()).toBe(before);
    expect(t.ctx.tools.get().font).toEqual({ legacy: "Arial" });
    tb.dispose();
  });

  it("a size field left empty with a part selected goes back to that part's size", async () => {
    const t = setup();
    const watchers: (() => void)[] = [];
    const root = buildTextSection(t.ctx as never, t.ctx.selection.get()!, {
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
    }) as unknown as FEl;
    t.session.store.subscribe(() => watchers.forEach((w) => w()));
    const all = (n: FEl): FEl[] => [n, ...n.children.flatMap(all)];
    const size = all(root).find((e) => e.tagName === "INPUT" && (e as unknown as { type: string }).type === "number") as unknown as FEl & { value: string };
    t.select(6, 11);
    await settle();
    expect(size.value).toBe("64");
    size.value = "";
    size.fire("change");
    expect(size.value).toBe("64");
    expect(t.genNow().runs).toEqual([RUN]);
  });
});

describe("the selected part, painted while focus is in a styling surface", () => {
  class FakeHighlight {
    constructor(readonly range: { startContainer: FNode; startOffset: number; endContainer: FNode; endOffset: number }) {}
  }
  let highlights: Map<string, FakeHighlight>;
  const withRegistry = () => {
    highlights = new Map();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("Highlight", FakeHighlight);
    (doc as unknown as { createRange(): unknown }).createRange = () => {
      const r = {
        startContainer: null as FNode | null,
        startOffset: 0,
        endContainer: null as FNode | null,
        endOffset: 0,
        setStart(n: FNode, o: number) {
          r.startContainer = n;
          r.startOffset = o;
        },
        setEnd(n: FNode, o: number) {
          r.endContainer = n;
          r.endOffset = o;
        },
      };
      return r;
    };
  };
  afterEach(() => {
    delete (doc as unknown as { createRange?: unknown }).createRange;
  });
  /** a control inside a styling surface (it answers `closest`) */
  const STYLING = { closest: () => ({}) };
  const away = (t: ReturnType<typeof setup>) => {
    doc.activeElement = doc.body;
    t.div.fire("focusout", { relatedTarget: STYLING });
  };
  const span = (t: ReturnType<typeof setup>, h: FakeHighlight) => [
    offsetOf(t.div as never, h.range.startContainer as never, h.range.startOffset),
    offsetOf(t.div as never, h.range.endContainer as never, h.range.endOffset),
  ];

  it("paints the selected part of a plain text once focus leaves for the panel, and clears it on refocus", () => {
    withRegistry();
    const t = setup(gen({ runs: undefined }));
    t.select(1, 4);
    expect(highlights.has(KEPT_HIGHLIGHT)).toBe(false);
    away(t);
    const h = highlights.get(KEPT_HIGHLIGHT)!;
    expect(h).toBeInstanceOf(FakeHighlight);
    expect(span(t, h)).toEqual([1, 4]);
    t.ed.refocus();
    expect(highlights.has(KEPT_HIGHLIGHT)).toBe(false);
  });

  it("a caret paints nothing", () => {
    withRegistry();
    const t = setup();
    t.select(3, 3);
    away(t);
    expect(highlights.size).toBe(0);
  });

  it("follows the spans a range style rebuilds while focus is away", () => {
    withRegistry();
    const t = setup();
    t.select(1, 4);
    away(t);
    const first = highlights.get(KEPT_HIGHLIGHT)!;
    t.textEdit.get()!.applyRange!({ sizePx: 50 });
    const h = highlights.get(KEPT_HIGHLIGHT)!;
    expect(h).not.toBe(first);
    expect(t.div.contains(h.range.startContainer)).toBe(true);
    expect(span(t, h)).toEqual([1, 4]);
    // the old start node left the text with the rebuild
    expect(t.div.contains(first.range.startContainer)).toBe(false);
  });

  it("without the highlight API nothing is painted and styling still works", () => {
    const t = setup();
    t.select(0, 5);
    away(t);
    t.textEdit.get()!.applyRange!({ color: "#00ff00" });
    expect(t.genNow().runs).toEqual([{ s: 0, e: 5, c: "#00ff00" }, RUN]);
    expect((globalThis as { CSS?: unknown }).CSS).toBeUndefined();
  });

  const exits: [string, (t: ReturnType<typeof setup>) => void | Promise<void>][] = [
    ["commit", (t) => t.ed.commit()],
    ["Escape", (t) => void t.key("Escape")],
    ["leave", (t) => t.ed.leave()],
    ["an undo (it may take the layer away)", (t) => t.session.undo()],
    ["another layer selected", async (t) => {
      t.ctx.selection.set(null);
      await settle();
    }],
    ["a crop mode", async (t) => {
      t.ctx.mode.set("crop-layer");
      await settle();
    }],
    ["another tool", async (t) => {
      t.ctx.tools.set({ ...t.ctx.tools.get(), tool: "pen" });
      await settle();
    }],
    ["another writer", async (t) => {
      t.session.replace({ ...t.session.project, name: "Renamed elsewhere" });
      await settle();
    }],
  ];
  for (const [how, exit] of exits) {
    it(`leaves no highlight and no listener after ${how}`, async () => {
      withRegistry();
      const t = setup();
      t.select(1, 4);
      away(t);
      expect(highlights.has(KEPT_HIGHLIGHT)).toBe(true);
      await exit(t);
      expect(t.textEdit.get()).toBeNull();
      expect(highlights.size).toBe(0);
      expect(docListeners.get("selectionchange")?.size ?? 0).toBe(0);
      expect(docListeners.get("pointerdown")?.size ?? 0).toBe(0);
      for (const ev of ["focus", "focusout", "input", "beforeinput", "keydown", "compositionstart"]) expect(t.div.listenerCount(ev)).toBe(0);
    });
  }

  it("the tool row's font changes no tool: the edit and its highlight stay", async () => {
    withRegistry();
    const t = setup();
    t.select(1, 4);
    away(t);
    t.ctx.tools.update((s) => ({ ...s, font: { legacy: "Arial" } }));
    await settle();
    expect(t.textEdit.get()).not.toBeNull();
    expect(highlights.has(KEPT_HIGHLIGHT)).toBe(true);
  });
});
