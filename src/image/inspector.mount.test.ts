import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../core/types";
import { Store } from "../core/store";
import { createPhotoImageProject } from "../core/image-project";
import { updateMedia } from "../core/project";
import {
  addDrawingLayer,
  addGeneratorLayer,
  layersOf,
  setLayerAdjust,
  setLayerHidden,
  setLayerTransform,
  findLayer,
} from "./layers";

// The inspector mounted against a small fake DOM (vitest runs in node): the
// Canvas panel with nothing selected, one value per slider row, and the layer
// crop's button and fields. A 1000×500 photo on its own 1000×500 canvas; a
// rotate swaps those, so a no-op cannot pass for one.

const spies = vi.hoisted(() => ({
  crops: 0,
  resizes: 0,
  toastInfo: [] as string[],
  toastError: [] as string[],
  toastRefuse: [] as string[],
  /** Stands in for the text/solid section when set (null: no section). */
  genSection: null as null | ((ctx: unknown, target: { clip: unknown; media: { id: string } }) => unknown),
}));
vi.mock("./crop-image", () => ({
  startImageCrop: () => {
    spies.crops++;
    return () => {};
  },
}));
vi.mock("./canvas-size-dialog", () => ({
  openCanvasSizeDialog: () => {
    spies.resizes++;
  },
}));
vi.mock("../editor/inspector/generated", () => ({
  buildGeneratedSection: (ctx: unknown, target: { clip: unknown; media: { id: string } }) =>
    spies.genSection ? spies.genSection(ctx, target) : null,
}));
vi.mock("../ui/menu", () => ({ showMenu: () => {}, closeMenu: () => {} }));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (m: string) => void spies.toastInfo.push(m),
    error: (m: string) => void spies.toastError.push(m),
    refuse: (m: string) => void spies.toastRefuse.push(m),
  },
}));
vi.mock("./icons", () => ({ imgIcon: (n: string) => `<svg data-i="${n}"></svg>` }));

const { mountImageInspector } = await import("./inspector");

type Handler = (e: unknown) => void;

class El {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  style: Record<string, string> = {};
  cls = new Set<string>();
  attrs = new Map<string, string>();
  innerHTML = "";
  textContent = "";
  title = "";
  type = "";
  min = "";
  max = "";
  step = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  inert = false;
  private listeners = new Map<string, Set<Handler>>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this.cls = new Set(v.split(" ").filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  classList = {
    add: (...c: string[]) => void c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => void c.forEach((x) => this.cls.delete(x)),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.cls.has(c);
      if (want) this.cls.add(c);
      else this.cls.delete(c);
      return want;
    },
    contains: (c: string) => this.cls.has(c),
  };
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string, e: Record<string, unknown> = {}): void {
    const ev = { target: this, detail: 0, preventDefault() {}, ...e };
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]): void {
    for (const c of cs) this.appendChild(c);
  }
  prepend(c: El): void {
    c.remove();
    c.parentNode = this;
    this.children.unshift(c);
  }
  replaceChildren(...cs: El[]): void {
    for (const c of [...this.children]) c.remove();
    this.append(...cs);
  }
  remove(): void {
    if (!this.parentNode) return;
    const s = this.parentNode.children;
    s.splice(s.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  get isConnected(): boolean {
    return true;
  }
  blur(): void {}
  all(pred: (e: El) => boolean, out: El[] = []): El[] {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
  find(pred: (e: El) => boolean): El | undefined {
    return this.all(pred)[0];
  }
}

let docPress: Handler[] = [];
// What the fake document reports for focus: a real blur moves activeElement
// to <body> with the document still focused; a window deactivation (alt-tab)
// leaves the field active and the document unfocused.
const focus = { active: null as unknown, has: true };
let mounted: { dispose(): void }[] = [];

beforeEach(() => {
  spies.crops = 0;
  spies.resizes = 0;
  spies.toastInfo = [];
  spies.toastError = [];
  spies.toastRefuse = [];
  spies.genSection = null;
  docPress = [];
  focus.active = null;
  focus.has = true;
  vi.stubGlobal("Node", El);
  vi.stubGlobal("Element", El);
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("document", {
    createElement: (t: string) => new El(t),
    querySelector: () => null,
    get activeElement() {
      return focus.active;
    },
    hasFocus: () => focus.has,
    addEventListener: (t: string, fn: Handler) => {
      if (t === "pointerdown") docPress.push(fn);
    },
    removeEventListener: (t: string, fn: Handler) => {
      if (t === "pointerdown") docPress = docPress.filter((f) => f !== fn);
    },
  });
});
afterEach(() => {
  for (const m of mounted) m.dispose();
  mounted = [];
  vi.unstubAllGlobals();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mount(selected: boolean, drawing = false) {
  let base = createPhotoImageProject("p", {
    path: "C:/p.png", size: 1, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 1000, height: 500,
  });
  const photoId = layersOf(base)[0]!.trackId;
  const withDrawing = drawing ? addDrawingLayer(base) : null;
  const id = withDrawing ? withDrawing.trackId : photoId;
  if (withDrawing) base = withDrawing.project;
  const store = new Store<ProjectFile>(base);
  const commits: ProjectFile[] = [];
  const session = {
    store,
    get project() {
      return store.get();
    },
    replace(p: ProjectFile) {
      store.set(p);
    },
    commit(fn: (p: ProjectFile) => ProjectFile) {
      const next = fn(store.get());
      if (next === store.get()) return;
      commits.push(store.get());
      store.set(next);
    },
    commitFrom(before: ProjectFile) {
      commits.push(before);
    },
  };
  const cropAsks: string[] = [];
  let cropAnswer = true;
  const ctx = {
    session,
    selection: new Store<string | null>(selected ? id : null),
    mode: new Store<"idle" | "crop-image" | "crop-layer">("idle"),
    holdAutosave: () => () => {},
    registerOverlay: () => () => {},
    requestRender: () => {},
  };
  const host = new El("aside");
  const handle = mountImageInspector(host as never, ctx as never, {
    cropLayer: (trackId) => {
      cropAsks.push(trackId);
      return cropAnswer;
    },
  });
  mounted.push(handle);
  const buttonTitled = (t: string) => host.find((e) => e.tagName === "BUTTON" && e.title === t);
  const buttonReading = (t: string) =>
    host.find((e) => e.tagName === "BUTTON" && e.innerHTML.replace(/<svg[^>]*><\/svg>/g, "") === t);
  const fieldOf = (label: string) =>
    host.find((e) => e.cls.has("insp-field") && e.children[0]?.tagName === "LABEL" && e.children[0].textContent === label);
  const cropInput = (k: "X" | "Y" | "W" | "H") => host.find((e) => e.getAttribute("aria-label") === `Crop ${k}`)!;
  const layer = () => findLayer(store.get(), id)!;
  return {
    id, base, store, commits, ctx, host, cropAsks, buttonTitled, buttonReading, fieldOf, cropInput, layer,
    refuseCrop: () => {
      cropAnswer = false;
    },
  };
}

const ADJUST_LABELS = [
  "Exposure", "Brightness", "Contrast", "Highlights", "Shadows", "Saturation", "Warmth", "Tint", "Hue",
];

describe("inspector: nothing selected is the Canvas panel", () => {
  it("is headed Canvas and says how to reach a layer", () => {
    const t = mount(false);
    const header = t.host.find((e) => e.cls.has("insp-header__name"))!;
    expect(header.textContent).toBe("Canvas");
    expect(t.host.find((e) => e.cls.has("imged-insp-hint"))?.textContent).toBe("Select a layer to edit just that layer.");
    expect(t.host.find((e) => e.textContent === "Image")).toBeUndefined();
  });

  it("offers the whole-canvas operations, each one commit (or the crop / the dialog)", () => {
    const t = mount(false);
    expect(t.buttonReading("Change size")).toBeUndefined();
    t.buttonReading("Resize canvas")!.fire("click");
    expect(spies.resizes).toBe(1);
    t.buttonReading("Crop canvas")!.fire("click");
    expect(spies.crops).toBe(1);
    expect(t.commits).toHaveLength(0);

    t.buttonTitled("Rotate canvas left")!.fire("click");
    expect(t.commits).toHaveLength(1);
    expect([t.store.get().timeline.width, t.store.get().timeline.height]).toEqual([500, 1000]);
    t.buttonTitled("Rotate canvas right")!.fire("click");
    expect([t.store.get().timeline.width, t.store.get().timeline.height]).toEqual([1000, 500]);
    t.buttonTitled("Flip canvas horizontally")!.fire("click");
    expect(t.layer().transform.flipH).toBe(true);
    t.buttonTitled("Flip canvas vertically")!.fire("click");
    expect(t.layer().transform.flipV).toBe(true);
    // Actions, not toggles: nothing reads as pressed.
    expect(t.buttonTitled("Flip canvas horizontally")!.cls.has("btn--on")).toBe(false);
    expect(t.commits).toHaveLength(4);
  });

  it("keeps canvas and layer controls apart", async () => {
    const t = mount(false);
    expect(t.fieldOf("Opacity")).toBeUndefined();
    expect(t.host.find((e) => e.getAttribute("aria-label") === "Crop layer")).toBeUndefined();
    t.ctx.selection.set(t.id);
    await flush();
    expect(t.host.find((e) => e.cls.has("insp-header__name"))!.textContent).toBe("p");
    expect(t.buttonTitled("Rotate canvas left")).toBeUndefined();
    expect(t.buttonReading("Crop canvas")).toBeUndefined();
    expect(t.fieldOf("Opacity")).toBeDefined();
  });
});

describe("inspector: one value per slider row", () => {
  it("each slider row shows its value once, in the number field, with its unit", async () => {
    const t = mount(true);
    // Values that differ per row, so a field wired to the wrong row fails.
    t.store.set(
      setLayerTransform(
        setLayerAdjust(t.store.get(), t.id, {
          exposure: 11, brightness: -22, contrast: 33, highlights: -44, shadows: 55,
          saturation: -66, warmth: 77, tint: -88, hue: -171,
        }),
        t.id,
        { opacity: 0.37 },
      ),
    );
    await flush();
    const want: Record<string, [string, string]> = {
      Exposure: ["11", ""], Brightness: ["-22", ""], Contrast: ["33", ""], Highlights: ["-44", ""],
      Shadows: ["55", ""], Saturation: ["-66", ""], Warmth: ["77", ""], Tint: ["-88", ""],
      Hue: ["-171", "°"], Opacity: ["37", "%"],
    };
    for (const label of [...ADJUST_LABELS, "Opacity"]) {
      const row = t.fieldOf(label)!.find((e) => e.cls.has("insp-slider"))!;
      expect(row, label).toBeDefined();
      // No mono readout beside the field any more.
      expect(row.all((e) => e.cls.has("insp-slider__value")), label).toHaveLength(0);
      const nums = row.all((e) => e.tagName === "INPUT" && e.type === "number");
      expect(nums, label).toHaveLength(1);
      const unit = row.all((e) => e.cls.has("imged-insp-unit"));
      expect(unit, label).toHaveLength(1);
      expect([nums[0]!.value, unit[0]!.textContent], label).toEqual(want[label]);
    }
  });
});

describe("inspector: Adjust is for photos only", () => {
  const adjustSection = (host: El) =>
    host.find((e) => e.cls.has("insp-section") && e.children[0]?.textContent === "Adjust")!;

  it("a drawing layer's Adjust section is the one-line note, with no sliders", () => {
    const t = mount(true, true);
    expect(t.layer().media.generator?.type).toBe("drawing");
    const adjust = adjustSection(t.host);
    expect(adjust).toBeDefined();
    expect(adjust.all((e) => e.cls.has("insp-note")).map((e) => e.textContent)).toEqual([
      "Select a photo layer to adjust it.",
    ]);
    expect(adjust.all((e) => e.cls.has("insp-slider"))).toHaveLength(0);
    expect(adjust.all((e) => e.tagName === "INPUT")).toHaveLength(0);
    for (const label of ADJUST_LABELS) expect(t.fieldOf(label), label).toBeUndefined();
    expect(t.buttonReading("Reset adjustments")).toBeUndefined();
    // The layer's own sliders are still there: the panel is not simply empty.
    expect(t.fieldOf("Opacity")!.find((e) => e.cls.has("insp-slider"))).toBeDefined();
  });

  it("a photo layer keeps every slider and Reset, with no note", () => {
    const t = mount(true);
    const adjust = adjustSection(t.host);
    expect(adjust.all((e) => e.cls.has("insp-note"))).toHaveLength(0);
    expect(adjust.all((e) => e.cls.has("insp-slider"))).toHaveLength(ADJUST_LABELS.length);
    expect(t.buttonReading("Reset adjustments")).toBeDefined();
  });
});

describe("inspector: the layer's Crop", () => {
  it("the Crop button asks for the on-canvas crop of THIS layer", () => {
    const t = mount(true);
    const btn = t.host.find((e) => e.getAttribute("aria-label") === "Crop layer")!;
    expect(btn.innerHTML).toContain('data-i="crop"');
    expect(btn.title).toMatch(/double-click/);
    btn.fire("click");
    expect(t.cropAsks).toEqual([t.id]);
    expect(spies.toastInfo).toEqual([]);
  });

  it("says why when the crop is refused for a hidden layer", () => {
    const t = mount(true);
    t.store.set(setLayerHidden(t.store.get(), t.id, true));
    t.refuseCrop();
    t.host.find((e) => e.getAttribute("aria-label") === "Crop layer")!.fire("click");
    expect(spies.toastInfo).toEqual(["Show this layer to crop it."]);
  });

  it("Reset is off while uncropped, and puts the whole layer back", async () => {
    const t = mount(true);
    const reset = t.host.find((e) => e.getAttribute("aria-label") === "Reset crop")!;
    expect(reset.innerHTML).toBe("Reset");
    expect(reset.disabled).toBe(true);
    expect(t.buttonReading("Apply")).toBeUndefined();
    expect(t.buttonReading("Clear")).toBeUndefined();
    t.cropInput("W").value = "600";
    t.cropInput("W").fire("input");
    t.cropInput("W").fire("keydown", { key: "Enter" });
    expect(t.layer().transform.crop).toEqual({ x: 0, y: 0, w: 600, h: 500 });
    await flush();
    expect(reset.disabled).toBe(false);
    reset.fire("click");
    expect(t.layer().transform.crop).toBeUndefined();
    await flush();
    expect(reset.disabled).toBe(true);
    expect(t.commits).toHaveLength(2);
  });

  it("the fields commit on Enter, once, with no Apply button", () => {
    const t = mount(true);
    const x = t.cropInput("X");
    x.value = "100";
    x.fire("input");
    t.cropInput("W").value = "300";
    // Enter in one field judges all four together.
    x.fire("keydown", { key: "Enter" });
    expect(t.layer().transform.crop).toEqual({ x: 100, y: 0, w: 300, h: 500 });
    expect(t.commits).toHaveLength(1);
    // Focus leaving afterwards finds nothing new: no empty second step.
    x.fire("focusout", { relatedTarget: null });
    expect(t.commits).toHaveLength(1);
  });

  it("a fraction typed over the stored whole pixel reads the stored value again", () => {
    const t = mount(true);
    const y = t.cropInput("Y");
    y.value = "0.4";
    y.fire("input");
    y.fire("keydown", { key: "Enter" });
    // Rounds to the crop the layer already has: nothing to record, and the
    // field must not keep showing a number that is not the crop.
    expect(t.commits).toHaveLength(0);
    expect(y.value).toBe("0");
  });

  it("tabbing between the fields does not judge the rect; leaving them does", () => {
    const t = mount(true);
    // x=600 alone would not fit a 1000 px source with w still 1000.
    t.cropInput("X").value = "600";
    t.cropInput("X").fire("input");
    t.cropInput("X").fire("focusout", { relatedTarget: t.cropInput("W") });
    expect(spies.toastError).toEqual([]);
    expect(spies.toastRefuse).toEqual([]);
    expect(t.commits).toHaveLength(0);
    t.cropInput("W").value = "400";
    t.cropInput("W").fire("input");
    t.cropInput("W").fire("focusout", { relatedTarget: null });
    expect(t.layer().transform.crop).toEqual({ x: 600, y: 0, w: 400, h: 500 });
    expect(t.commits).toHaveLength(1);
  });

  it("a rect that does not fit is refused out loud, and the fields show the layer again", () => {
    const t = mount(true);
    const w = t.cropInput("W");
    w.value = "5000";
    w.fire("input");
    w.fire("keydown", { key: "Enter" });
    // A refusal, not a failure: said in error styling, never recorded.
    expect(spies.toastRefuse).toEqual(["Crop must fit inside 1000×500."]);
    expect(spies.toastError).toEqual([]);
    expect(w.value).toBe("1000");
    expect(t.layer().transform.crop).toBeUndefined();
    expect(t.commits).toHaveLength(0);
  });

  it("a press outside the panel lands the typed rect first", () => {
    const t = mount(true);
    const h = t.cropInput("H");
    h.value = "250";
    h.fire("input");
    // The field still has focus (the canvas tools preventDefault the press),
    // and the press blurs it after landing the rect: a real blur's focusout
    // must then find nothing new to record.
    focus.active = h;
    let blurred = 0;
    h.blur = () => {
      blurred++;
      focus.active = null;
      h.fire("focusout", { relatedTarget: null });
    };
    const canvas = new El("canvas");
    for (const fn of docPress) fn({ target: canvas });
    expect(t.layer().transform.crop).toEqual({ x: 0, y: 0, w: 1000, h: 250 });
    expect(blurred).toBe(1);
    expect(t.commits).toHaveLength(1);
    expect([spies.toastError, spies.toastRefuse]).toEqual([[], []]);
  });

  it("Escape in a field drops the typed numbers: a later press outside records nothing", () => {
    const t = mount(true);
    const x = t.cropInput("X");
    x.value = "100";
    x.fire("input");
    t.cropInput("W").value = "300";
    x.fire("keydown", { key: "Escape" });
    // Back to what the layer really has, straight away.
    expect([x.value, t.cropInput("W").value]).toEqual(["0", "1000"]);
    // The blur that follows (focus now on <body>) finds nothing to record.
    focus.active = null;
    x.fire("focusout", { relatedTarget: null });
    for (const fn of docPress) fn({ target: new El("canvas") });
    expect(t.layer().transform.crop).toBeUndefined();
    expect(t.commits).toHaveLength(0);
    expect(spies.toastError).toEqual([]);
    expect(spies.toastRefuse).toEqual([]);
  });

  it("switching windows mid-edit does not judge the half-typed rect", () => {
    const t = mount(true);
    // x=600 alone would not fit a 1000 px source with w still 1000.
    const x = t.cropInput("X");
    x.value = "600";
    x.fire("input");
    // Alt-tab: the field loses focus with no relatedTarget but stays active.
    focus.active = x;
    focus.has = false;
    x.fire("focusout", { relatedTarget: null });
    expect(spies.toastError).toEqual([]);
    expect(spies.toastRefuse).toEqual([]);
    expect(x.value).toBe("600");
    expect(t.commits).toHaveLength(0);
    // Either signal alone is enough (engines differ on which they report).
    focus.has = true;
    x.fire("focusout", { relatedTarget: null });
    focus.active = null;
    focus.has = false;
    x.fire("focusout", { relatedTarget: null });
    expect(spies.toastError).toEqual([]);
    expect(spies.toastRefuse).toEqual([]);
    expect(t.commits).toHaveLength(0);
    // Back in the window, the user finishes the rect and it lands whole.
    focus.has = true;
    t.cropInput("W").value = "400";
    t.cropInput("W").fire("keydown", { key: "Enter" });
    expect(t.layer().transform.crop).toEqual({ x: 600, y: 0, w: 400, h: 500 });
    expect(t.commits).toHaveLength(1);
  });

  it("the half-typed rect still lands on a press outside after switching back", () => {
    const t = mount(true);
    t.cropInput("H").value = "250";
    t.cropInput("H").fire("input");
    focus.active = t.cropInput("H");
    focus.has = false;
    t.cropInput("H").fire("focusout", { relatedTarget: null });
    expect(t.commits).toHaveLength(0);
    focus.has = true;
    for (const fn of docPress) fn({ target: new El("canvas") });
    expect(t.layer().transform.crop).toEqual({ x: 0, y: 0, w: 1000, h: 250 });
    expect(t.commits).toHaveLength(1);
  });

  it("typed numbers are dropped, not committed, once a crop mode has begun", () => {
    const t = mount(true);
    t.cropInput("H").value = "250";
    t.cropInput("H").fire("input");
    t.ctx.mode.set("crop-layer");
    // The panel going inert takes focus out of the field.
    t.cropInput("H").fire("focusout", { relatedTarget: null });
    expect(t.commits).toHaveLength(0);
    expect(t.cropInput("H").value).toBe("500");
    expect(t.store.get()).toBe(t.base);
  });
});

describe("inspector: the header names the kind in words", () => {
  it("a photo says Photo and a drawing says Drawing (never the raw kind)", () => {
    const badge = (host: El) => host.find((e) => e.cls.has("badge"))!.textContent;
    expect(badge(mount(true).host)).toBe("Photo");
    expect(badge(mount(true, true).host)).toBe("Drawing");
  });

  it("a solid colour layer says Solid color", async () => {
    const t = mount(false);
    const s = addGeneratorLayer(t.store.get(), { type: "solid", color: "#123456" }, 40, 30, "Solid");
    t.store.set(s.project);
    t.ctx.selection.set(s.trackId);
    await flush();
    expect(t.host.find((e) => e.cls.has("badge"))!.textContent).toBe("Solid color");
  });
});

describe("inspector: the layer's flips say they are the layer's own", () => {
  it("labels them as layer flips, explains rotation, and each switch sets its own flag", async () => {
    const t = mount(true);
    const flip = t.fieldOf("Flip layer")!;
    expect(flip).toBeDefined();
    expect(flip.title).toMatch(/own sides, before its rotation/);
    const h = t.host.find((e) => e.getAttribute("aria-label") === "Flip layer horizontally")!;
    const v = t.host.find((e) => e.getAttribute("aria-label") === "Flip layer vertically")!;
    expect(h.title).toBe(flip.title);
    expect(v.title).toBe(flip.title);
    expect(t.fieldOf("Flip H")).toBeUndefined();
    // On a quarter-turned layer the switch still means the layer's own axis:
    // Horizontal sets flipH (and leaves the rotation alone).
    t.store.set(setLayerTransform(t.store.get(), t.id, { rotate: 90 }));
    await flush();
    h.checked = true;
    h.fire("change");
    expect(t.layer().transform).toMatchObject({ flipH: true, flipV: false, rotate: 90 });
    v.checked = true;
    v.fire("change");
    expect(t.layer().transform).toMatchObject({ flipH: true, flipV: true, rotate: 90 });
  });
});

describe("inspector: Actual size and Fit land on whole pixels", () => {
  it("Actual size puts an odd-parity layer on the nearest whole-pixel offset", () => {
    // A 1000×500 photo on a 1001×500 canvas: centred, its left edge is at 0.5.
    const t = mount(true);
    t.store.set({ ...t.store.get(), timeline: { ...t.store.get().timeline, width: 1001 } });
    t.store.set(setLayerTransform(t.store.get(), t.id, { scale: 0.4, x: 0, y: 3 }));
    t.buttonReading("Actual size")!.fire("click");
    expect(t.layer().transform).toMatchObject({ scale: 1, x: 0.5, y: 3 });
    expect(t.commits).toHaveLength(1);
  });

  it("Fit to canvas centres exactly when it scales, and on whole pixels when the fit is 100%", () => {
    const t = mount(true);
    // 1000×500 on 1001×500: the fit is min(1.001, 1) = 1 — actual size.
    t.store.set({ ...t.store.get(), timeline: { ...t.store.get().timeline, width: 1001 } });
    t.store.set(setLayerTransform(t.store.get(), t.id, { scale: 0.4, x: 20, y: 7 }));
    t.buttonReading("Fit to canvas")!.fire("click");
    expect(t.layer().transform).toMatchObject({ scale: 1, x: 0.5, y: 0 });
    // 1000×500 on 2001×1500: fit 2.001 — resampled anyway, exactly centred.
    t.store.set({ ...t.store.get(), timeline: { ...t.store.get().timeline, width: 2001, height: 1500 } });
    t.buttonReading("Fit to canvas")!.fire("click");
    expect(t.layer().transform).toMatchObject({ x: 0, y: 0 });
    expect(t.layer().transform.scale).toBeCloseTo(2.001, 9);
  });
});

describe("inspector: a typed text edit survives a click on another layer", () => {
  // The real text section commits its textarea on `change`, which a browser
  // fires when the field blurs. The canvas tools preventDefault their
  // pointerdown, so a click on another layer never blurs it; a field removed
  // while focused fires nothing.
  async function withText() {
    const t = mount(false);
    const photoId = t.id;
    const gen = { type: "text", text: "Old", fontFamily: "Arial", sizePx: 40, color: "#ffffff", bold: false, italic: false } as const;
    const made = addGeneratorLayer(t.store.get(), gen, 94, 50, "Text — Old");
    t.store.set(made.project);
    const areas: El[] = [];
    spies.genSection = (ctx, target) => {
      const sec = new El("div");
      const area = new El("textarea");
      area.value = "Old";
      const session = (ctx as { session: { commit(fn: (p: ProjectFile) => ProjectFile): void } }).session;
      area.addEventListener("change", () =>
        session.commit((p) => updateMedia(p, target.media.id, { generator: { ...gen, text: area.value } })),
      );
      // A real blur: focus moves to <body>, and a changed value fires change.
      area.blur = () => {
        if (focus.active !== area) return;
        focus.active = null;
        if (area.value !== "Old") area.fire("change");
      };
      sec.appendChild(area);
      areas.push(area);
      return sec;
    };
    t.ctx.selection.set(made.trackId);
    await flush();
    const area = areas.at(-1)!;
    focus.active = area;
    area.value = "New";
    const textOf = () => {
      const g = findLayer(t.store.get(), made.trackId)!.media.generator;
      return g?.type === "text" ? g.text : null;
    };
    return { ...t, photoId, textId: made.trackId, area, textOf };
  }

  it("a press on the canvas lands the text BEFORE the tool acts", async () => {
    const t = await withText();
    for (const fn of docPress) fn({ target: new El("canvas") });
    // Already committed, before the select tool would read the project.
    expect(t.textOf()).toBe("New");
    t.ctx.selection.set(t.photoId);
    await flush();
    expect(t.textOf()).toBe("New");
    expect(t.commits).toHaveLength(1);
    expect(t.host.find((e) => e.cls.has("insp-header__name"))!.textContent).toBe("p");
  });

  it("a selection change with the field still focused commits it to ITS layer first", async () => {
    const t = await withText();
    // No press at all (the selection moved some other way).
    t.ctx.selection.set(t.photoId);
    await flush();
    expect(t.textOf()).toBe("New");
    expect(t.commits).toHaveLength(1);
    // The panel now shows the photo, built once.
    expect(t.host.all((e) => e.cls.has("insp-header"))).toHaveLength(1);
    expect(t.host.find((e) => e.cls.has("insp-header__name"))!.textContent).toBe("p");
    expect(t.host.find((e) => e.cls.has("badge"))!.textContent).toBe("Photo");
  });
});
