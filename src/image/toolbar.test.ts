import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../core/types";
import { Store } from "../core/store";
import { DEFAULT_SETTINGS } from "../core/types";
import { settingsStore } from "../core/session";
import { createToolStore } from "./tool-state";

const target = vi.hoisted(() => ({ create: true }));
vi.mock("./layers", () => ({
  drawingTarget: () => (target.create ? { create: { above: null } } : { trackId: "t-draw" }),
}));
vi.mock("./icons", () => ({ imgIcon: (n: string) => `<svg data-i="${n}"></svg>` }));

/** Every picker opened, with the options it was opened on and its close count. */
const pickers = vi.hoisted(() => [] as { opts: { label: string; onPreview(h: string): void; onClose(): void }; closes: number }[]);
vi.mock("../ui/color-picker", () => ({
  openColorPicker: (opts: { label: string; onPreview(h: string): void; onClose(): void }) => {
    const rec = { opts, closes: 0 };
    pickers.push(rec);
    let open = true;
    return {
      close: () => {
        rec.closes++;
        if (!open) return;
        open = false;
        opts.onClose();
      },
    };
  },
}));

const { mountToolbar, inkPresets, withRecent, sliderToSize, sizeToSlider, dotDiameter, BASE_INK_COLORS, HINT_NOTHING_TO_ERASE } =
  await import("./toolbar");

/* ---------------- a fake DOM that counts every write ---------------- */

let writes: string[] = [];
type Handler = (e: unknown) => void;

class El {
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  private _hidden = false;
  private _title = "";
  private _value = "";
  private _text = "";
  private cls = new Set<string>();
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<Handler>>();
  type = "";
  min = "";
  max = "";
  step = "";
  innerHTML = "";
  style: Record<string, unknown>;
  constructor(readonly tagName: string) {
    const style: Record<string, unknown> = {};
    this.style = new Proxy(style, {
      set: (o, k, v) => {
        writes.push(`style.${String(k)}`);
        o[k as string] = v;
        return true;
      },
    });
  }
  set className(v: string) {
    this.cls = new Set(v.split(" ").filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  classList = {
    toggle: (c: string, on?: boolean): boolean => {
      const want = on ?? !this.cls.has(c);
      if (want !== this.cls.has(c)) writes.push(`class.${c}`);
      if (want) this.cls.add(c);
      else this.cls.delete(c);
      return want;
    },
    contains: (c: string) => this.cls.has(c),
  };
  get hidden(): boolean {
    return this._hidden;
  }
  set hidden(v: boolean) {
    writes.push("hidden");
    this._hidden = v;
  }
  get title(): string {
    return this._title;
  }
  set title(v: string) {
    writes.push("title");
    this._title = v;
  }
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    writes.push("value");
    this._value = v;
  }
  get textContent(): string {
    return this._text;
  }
  set textContent(v: string) {
    this._text = v;
  }
  setAttribute(k: string, v: string): void {
    writes.push(`attr.${k}`);
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: El): El {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    if (!this.parentNode) return;
    const s = this.parentNode.children;
    s.splice(s.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    if (n === this) return true;
    return this.children.some((c) => c.contains(n));
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown = {}): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e);
  }
  blur(): void {}
  focus(): void {}
  /** depth-first find */
  find(pred: (e: El) => boolean): El | undefined {
    for (const c of this.children) {
      if (pred(c)) return c;
      const d = c.find(pred);
      if (d) return d;
    }
    return undefined;
  }
}

beforeEach(() => {
  writes = [];
  target.create = true;
  vi.stubGlobal("document", {
    createElement: (t: string) => new El(t),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  });
  settingsStore.set({
    ...DEFAULT_SETTINGS,
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts, imgPen: "Shift+P", imgMarker: "" },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  settingsStore.set(DEFAULT_SETTINGS);
});

function mount() {
  const host = new El("div");
  const tools = createToolStore();
  const session = { store: new Store<ProjectFile>({ timeline: {} } as ProjectFile), get project() {
    return this.store.get();
  } };
  const ctx = {
    tools,
    session,
    selection: new Store<string | null>(null),
    registerOverlay: () => () => {},
    stage: new El("div"),
    view: { clientToCanvas: (x: number, y: number) => ({ x, y }) },
  };
  const handle = mountToolbar(host as never, ctx as never);
  const tool = (id: string) => host.find((e) => e.dataset.tool === id)!;
  const byClass = (c: string) => host.find((e) => e.classList.contains(c))!;
  return { host, tools, ctx, handle, tool, byClass };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("toolbar paint", () => {
  it("writes nothing when a notification changes nothing it shows", async () => {
    const t = mount();
    await flush();
    writes = [];
    // A colour drag re-notifies the tool store with a new object every frame;
    // with the tool on select, nothing the row shows depends on it.
    t.tools.set({ ...t.tools.get(), colors: { ...t.tools.get().colors, pen: "#101010" } });
    t.tools.set({ ...t.tools.get() });
    t.ctx.selection.set("t-photo");
    settingsStore.set({ ...settingsStore.get() });
    await flush();
    expect(writes).toEqual([]);
    t.handle.dispose();
  });

  it("flips only the two tool buttons that changed, and shows the tool's controls", async () => {
    const t = mount();
    await flush();
    writes = [];
    t.tools.set({ ...t.tools.get(), tool: "pen" });
    await flush();
    expect(writes.filter((w) => w === "class.btn--on")).toHaveLength(2);
    expect(writes.filter((w) => w === "attr.aria-pressed")).toHaveLength(2);
    expect(t.tool("pen").classList.contains("btn--on")).toBe(true);
    expect(t.tool("pen").getAttribute("aria-pressed")).toBe("true");
    expect(t.tool("select").getAttribute("aria-pressed")).toBe("false");
    expect(t.byClass("imged-swatch-btn").hidden).toBe(false);
    expect(t.byClass("imged-brush").hidden).toBe(false);
    expect(t.byClass("imged-seg").hidden).toBe(true);
    expect(t.byClass("imged-shape").hidden).toBe(true);
    // the same notification again writes nothing
    writes = [];
    t.tools.set({ ...t.tools.get() });
    await flush();
    expect(writes).toEqual([]);
    t.handle.dispose();
  });

  it("titles carry the LIVE chord, and none when unbound", async () => {
    const t = mount();
    expect(t.tool("pen").title).toBe("Pen (Shift+P)");
    expect(t.tool("marker").title).toBe("Marker");
    expect(t.tool("pencil").title).toBe(`Pencil (${DEFAULT_SETTINGS.shortcuts.imgPencil})`);
    settingsStore.set({ ...settingsStore.get(), shortcuts: { ...settingsStore.get().shortcuts, imgPen: "Q" } });
    await flush();
    expect(t.tool("pen").title).toBe("Pen (Q)");
    t.handle.dispose();
  });

  it("eraser: no colour, the Stroke | Pixel pair, and the hint only with nothing to cut", async () => {
    const t = mount();
    t.tools.set({ ...t.tools.get(), tool: "eraser" });
    await flush();
    expect(t.byClass("imged-swatch-btn").hidden).toBe(true);
    expect(t.byClass("imged-seg").hidden).toBe(false);
    const hint = t.byClass("imged-hint");
    expect(hint.textContent).toBe(HINT_NOTHING_TO_ERASE);
    // stroke mode never shows it
    expect(hint.hidden).toBe(true);
    t.tools.set({ ...t.tools.get(), eraserMode: "pixel" });
    await flush();
    expect(hint.hidden).toBe(false);
    target.create = false;
    t.ctx.selection.set("t-draw");
    await flush();
    expect(hint.hidden).toBe(true);
    t.handle.dispose();
  });

  it("the size dot and the slider follow the ACTIVE tool's size", async () => {
    const t = mount();
    t.tools.set({ ...t.tools.get(), tool: "marker" });
    await flush();
    const dot = t.byClass("imged-brush__dot");
    expect(dot.style.width).toBe(`${dotDiameter(18)}px`);
    expect(t.byClass("imged-brush__slider").value).toBe(String(sizeToSlider(18)));
    // the slider writes the size of the tool in hand
    const slider = t.byClass("imged-brush__slider");
    slider.value = String(sizeToSlider(40));
    slider.fire("input");
    await flush();
    expect(t.tools.get().sizes.marker).toBe(40);
    expect(t.tools.get().sizes.pen).toBe(4);
    t.handle.dispose();
  });

  it("the colour picker closes when the tool it edits changes, not when its own colour does", async () => {
    pickers.length = 0;
    const t = mount();
    t.tools.set({ ...t.tools.get(), tool: "pen" });
    await flush();
    t.byClass("imged-swatch-btn").fire("click");
    await flush();
    expect(pickers).toHaveLength(1);
    expect(pickers[0]!.opts.label).toBe("Pen color");
    // its own previews re-notify the tool store: the picker stays open
    pickers[0]!.opts.onPreview("#224466");
    await flush();
    expect(t.tools.get().colors.pen).toBe("#224466");
    expect(pickers[0]!.closes).toBe(0);
    // a shortcut switches to the marker (a tool that HAS a colour): closed
    t.tools.set({ ...t.tools.get(), tool: "marker" });
    await flush();
    expect(pickers[0]!.closes).toBe(1);
    // and the next click opens one for the marker
    t.byClass("imged-swatch-btn").fire("click");
    await flush();
    expect(pickers).toHaveLength(2);
    expect(pickers[1]!.opts.label).toBe("Marker color");
    t.handle.dispose();
  });

  it("clicking a tool selects it", async () => {
    const t = mount();
    t.tool("shape").fire("click");
    expect(t.tools.get().tool).toBe("shape");
    await flush();
    expect(t.byClass("imged-shape").hidden).toBe(false);
    t.handle.dispose();
  });
});

describe("size mapping", () => {
  it("is log-scaled over 1..200 and round-trips", () => {
    expect(sliderToSize(0)).toBe(1);
    expect(sliderToSize(1000)).toBe(200);
    expect(sliderToSize(500)).toBe(14);
    for (const s of [1, 2, 4, 7, 18, 64, 200]) expect(sliderToSize(sizeToSlider(s))).toBe(s);
    expect(dotDiameter(1)).toBe(3);
    expect(dotDiameter(200)).toBe(16);
  });
});

describe("recent ink colours", () => {
  it("pushes a new pick to the front, deduped, six at most", () => {
    const six = ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"];
    expect(withRecent(six, "#333333")).toEqual(["#333333", "#111111", "#222222", "#444444", "#555555", "#666666"]);
    expect(withRecent(six, "#ABCDEF")).toEqual(["#abcdef", ...six.slice(0, 5)]);
    // already first → no write at all
    expect(withRecent(six, "#111111")).toBeNull();
    expect(withRecent(six, "nope")).toBeNull();
  });

  it("offers recents first, then the base shelf, twelve in all", () => {
    const p = inkPresets(["#123456", "#000000"]);
    expect(p).toHaveLength(12);
    expect(p.slice(0, 2)).toEqual(["#123456", "#000000"]);
    // #000000 is not offered twice
    expect(p.filter((c) => c === "#000000")).toHaveLength(1);
    expect(inkPresets([])).toEqual(BASE_INK_COLORS);
  });
});
