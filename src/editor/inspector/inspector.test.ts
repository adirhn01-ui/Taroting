import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../core/store";
import { touchModified, trimClip, updateClip } from "../../core/project";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";

// The video editor's inspector mounted against a small fake DOM (vitest runs
// in node). The fake focus model is the part that matters: focus() records the
// value a field had, and blur() fires change (when that value moved), then
// blur and focusout, the way a browser does — and removing a focused element
// fires nothing at all, which is what made a rebuild lose a typed edit.
//
// Fixture values differ on every axis the code could confuse: the clip starts
// at 2 s on the timeline, plays its source from 1.5 s at 2x, so timeline time,
// clip-local time and source time are three different numbers everywhere.

const spies = vi.hoisted(() => ({
  info: [] as string[],
  error: [] as string[],
  refuse: [] as string[],
  scans: [] as { path: string; srcIn: number; srcOut: number; settle: (v: unknown, fail?: boolean) => void }[],
}));
vi.mock("../../ui/toast", () => ({
  toast: {
    info: (m: string) => void spies.info.push(m),
    error: (m: string) => void spies.error.push(m),
    refuse: (m: string) => void spies.refuse.push(m),
  },
}));
vi.mock("../../core/ipc", () => ({
  ipc: {
    normalizeScan: (path: string, srcIn: number, srcOut: number) =>
      new Promise((resolve, reject) => {
        spies.scans.push({ path, srcIn, srcOut, settle: (v, fail) => (fail ? reject(v) : resolve(v)) });
      }),
  },
}));
// The real measureText needs a canvas 2D context the fake DOM does not have.
vi.mock("../media/generators", () => ({
  TEXT_FONTS: ["Segoe UI", "Arial", "Impact"],
  measureText: (g: { text: string; sizePx: number }) => ({ width: g.text.length * 10, height: g.sizePx * 2 }),
}));

const { mountInspector } = await import("./inspector");

type Handler = (e: unknown) => void;

const focus = { active: null as El | null };

class El {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  cls = new Set<string>();
  private html = "";
  textContent = "";
  title = "";
  type = "";
  min = "";
  max = "";
  step = "";
  value = "";
  rows = 0;
  checked = false;
  selected = false;
  disabled = false;
  focusValue = "";
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
  // innerHTML only ever receives escaped text or an svg here; setting it
  // replaces the children, as the real property does.
  set innerHTML(v: string) {
    for (const c of [...this.children]) c.remove();
    this.html = v;
  }
  get innerHTML(): string {
    return this.html;
  }
  classList = {
    add: (...c: string[]) => void c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => void c.forEach((x) => this.cls.delete(x)),
    contains: (c: string) => this.cls.has(c),
  };
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string): void {
    const ev = { target: this, preventDefault() {} };
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev);
  }
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
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
  focus(): void {
    if (focus.active === this) return;
    focus.active?.blur();
    focus.active = this;
    this.focusValue = this.value;
    this.fire("focusin");
  }
  blur(): void {
    if (focus.active !== this) return;
    if (this.value !== this.focusValue) this.fire("change");
    focus.active = null;
    this.fire("blur");
    this.fire("focusout");
  }
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

/** Type into a field: the value changes and `input` fires. */
function type(field: El, value: string): void {
  field.value = value;
  field.fire("input");
}

let mounted: { dispose(): void }[] = [];

beforeEach(() => {
  spies.info = [];
  spies.error = [];
  spies.refuse = [];
  spies.scans = [];
  focus.active = null;
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("document", {
    createElement: (t: string) => new El(t),
    get activeElement() {
      return focus.active;
    },
  });
});
afterEach(() => {
  for (const m of mounted) m.dispose();
  mounted = [];
  vi.unstubAllGlobals();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const VIDEO: MediaRef = {
  id: "m-video", path: "C:/clips/beach.day.mp4", size: 10, mtimeMs: 1, kind: "video",
  duration: 20, width: 1280, height: 720, hasAudio: true,
};
const TEXT: MediaRef = {
  id: "m-text", path: "Text — www.site.com", size: 0, mtimeMs: 0, kind: "image", duration: 0,
  hasAudio: false, width: 50, height: 96,
  generator: { type: "text", text: "Hello", fontFamily: "Arial", sizePx: 48, color: "#ff0000", bold: false, italic: false },
};

function clip(id: string, mediaId: string, extra: Partial<Clip> = {}): Clip {
  return {
    id, mediaId, timelineStart: 2, srcIn: 1.5, srcOut: 9.5, speed: 2,
    transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 40, y: -30, opacity: 0.8 },
    audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
    ...extra,
  };
}

function project(clips: Clip[]): ProjectFile {
  return {
    schema: 2, app: "taroting", id: "p", name: "P", createdAt: "", modifiedAt: "",
    media: [VIDEO, TEXT],
    timeline: {
      fps: { num: 30, den: 1 }, width: 1920, height: 1080,
      tracks: [{ id: "v1", kind: "video", name: "Video", muted: false, clips }],
    },
    export: {} as ProjectFile["export"],
  };
}

function mount(base: ProjectFile, selected: string | null, opts: { time?: number; playing?: boolean } = {}) {
  const store = new Store<ProjectFile>(base);
  const history: ProjectFile[] = [];
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
      history.push(store.get());
      store.set(next);
    },
    commitFrom(before: ProjectFile) {
      if (store.get() === before) return;
      history.push(before);
    },
  };
  const ticks = new Set<(t: number, playing: boolean) => void>();
  const engine = {
    time: opts.time ?? 3,
    playing: opts.playing ?? false,
    pauses: 0,
    onTick(fn: (t: number, playing: boolean) => void) {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
    pause() {
      if (!this.playing) return;
      this.playing = false;
      this.pauses++;
      for (const fn of ticks) fn(this.time, false);
    },
    refresh() {
      for (const fn of ticks) fn(this.time, this.playing);
    },
  };
  const overlay = { active: false };
  const selection = new Store<string | null>(selected);
  const host = new El("aside");
  const handle = mountInspector(host as never, {
    session: session as never,
    media: {} as never,
    engine: engine as never,
    selection,
    refresh: () => engine.refresh(),
    overlayGestureActive: () => overlay.active,
  });
  mounted.push(handle);
  const fieldControl = (label: string): El =>
    host.find((e) => e.cls.has("insp-field") && e.children[0]?.tagName === "LABEL" && (e.children[0].innerHTML || e.children[0].textContent) === label)!
      .children[1]!;
  /** The [range, readout, number] of an animatable group's slider. */
  const groupSlider = (label: string): { range: El; num: El } => {
    const head = host.find(
      (e) => e.cls.has("insp-grouphead") && e.children[0]?.innerHTML === label,
    )!;
    const sib = head.parentNode!.children;
    const wrap = sib[sib.indexOf(head) + 1]!;
    return { range: wrap.children[0]!, num: wrap.children[2]! };
  };
  const button = (text: string): El | undefined =>
    host.find((e) => e.tagName === "BUTTON" && e.textContent === text);
  const header = (): string => host.find((e) => e.cls.has("insp-header__name"))!.innerHTML;
  const clipNow = (id = "a"): Clip =>
    store.get().timeline.tracks[0]!.clips.find((c) => c.id === id)!;
  return { store, history, engine, overlay, selection, host, handle, fieldControl, groupSlider, button, header, clipNow };
}

describe("C89: a rebuild lets the focused field finish first", () => {
  it("commits a typed generator text when another clip is selected", async () => {
    const t = mount(project([clip("a", "m-text"), clip("b", "m-video", { timelineStart: 7 })]), "a");
    const text = t.host.find((e) => e.tagName === "TEXTAREA")!;
    text.focus();
    text.value = "World wide";
    t.selection.set("b");
    await flush();
    const gen = t.store.get().media.find((m) => m.id === "m-text")!.generator;
    expect(gen).toMatchObject({ type: "text", text: "World wide" });
    expect(t.history.length).toBe(1);
    expect(t.header()).toBe("beach.day");
  });

  it("gives a number field's live edit its own history entry when the selection moves", async () => {
    const t = mount(project([clip("a", "m-video"), clip("b", "m-video", { timelineStart: 7 })]), "a");
    const x = t.fieldControl("X");
    x.focus();
    type(x, "123");
    expect(t.clipNow().transform!.x).toBe(123);
    t.selection.set("b");
    await flush();
    expect(t.history.length).toBe(1);
    expect(t.history[0]!.timeline.tracks[0]!.clips[0]!.transform!.x).toBe(40);
    expect(t.clipNow().transform!.x).toBe(123);
  });

  it("commits a typed custom canvas width when a clip gets selected", async () => {
    const t = mount(project([clip("a", "m-video")]), null);
    const size = t.fieldControl("Size");
    size.value = "custom";
    size.fire("change");
    const w = t.fieldControl("Width");
    w.focus();
    w.value = "1280";
    t.selection.set("a");
    await flush();
    expect(t.store.get().timeline.width).toBe(1280);
    expect(t.store.get().timeline.height).toBe(1080);
  });

  it("does not rebuild under a field being typed in for an autosave stamp", async () => {
    const t = mount(project([clip("a", "m-text")]), "a");
    const text = t.host.find((e) => e.tagName === "TEXTAREA")!;
    text.focus();
    text.value = "Wor";
    t.store.set(touchModified(t.store.get()));
    await flush();
    expect(t.host.contains(text)).toBe(true);
    expect(focus.active).toBe(text);
    expect(t.history.length).toBe(0);
  });
});

describe("C90: the canvas overlay's drags do not rebuild the panel per move", () => {
  it("skips store-driven rebuilds while the overlay drags and rebuilds once at its end", async () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const firstHeader = t.host.children[0];
    t.overlay.active = true;
    for (const x of [55, 70, 91]) {
      t.store.set(updateClip(t.store.get(), "a", (c) => ({ ...c, transform: { ...c.transform!, x } })));
      await flush();
    }
    expect(t.host.children[0] === firstHeader).toBe(true);
    expect(t.fieldControl("X").value).toBe("40");
    t.overlay.active = false;
    t.handle.overlayGestureEnded();
    expect(t.host.children[0] === firstHeader).toBe(false);
    expect(t.fieldControl("X").value).toBe("91");
  });

  it("does not rebuild at a gesture end that skipped nothing", () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const firstHeader = t.host.children[0];
    t.handle.overlayGestureEnded();
    expect(t.host.children[0] === firstHeader).toBe(true);
  });
});

describe("C91: an animated edit keys where the playhead is when the edit starts", () => {
  const animated = (): Clip =>
    clip("a", "m-video", { keyframes: { scale: [{ t: 1.5, v: 1 }, { t: 9.5, v: 2 }] } });

  it("pauses playback and keys at the edit's source time, not the build's", () => {
    // Built at timeline 3 s (source 3.5); edited at timeline 5 s (source 7.5).
    const t = mount(project([animated()]), "a", { time: 3, playing: true });
    const { range } = t.groupSlider("Scale");
    t.engine.time = 5;
    range.fire("pointerdown");
    type(range, "1.7");
    expect(t.engine.pauses).toBe(1);
    // The pause's tick did not rebuild the slider out from under the pointer.
    expect(t.host.contains(range)).toBe(true);
    expect(t.clipNow().keyframes!.scale).toEqual([
      { t: 1.5, v: 1 },
      { t: 7.5, v: 1.7 },
      { t: 9.5, v: 2 },
    ]);
    // A second input in the same gesture keys the same time even if the
    // playhead were moved meanwhile.
    t.engine.time = 5.5;
    type(range, "1.8");
    expect(t.clipNow().keyframes!.scale!.map((k) => k.t)).toEqual([1.5, 7.5, 9.5]);
    range.fire("pointerup");
    expect(t.history.length).toBe(1);
    // The paused panel is rebuilt to describe the frame now on screen.
    expect(t.host.contains(range)).toBe(false);
  });

  it("writes nothing when the playhead has left the clip since the build", () => {
    const base = project([animated()]);
    const t = mount(base, "a", { time: 3, playing: true });
    const { range, num } = t.groupSlider("Scale");
    t.engine.time = 10; // the clip spans 2..6 on the timeline
    range.fire("pointerdown");
    type(range, "1.7");
    expect(t.store.get()).toBe(base);
    range.fire("pointerup");
    expect(t.history.length).toBe(0);
    expect(num.value).toBe("1.25"); // evaluated at the build time, untouched
  });

  it("keys a paired position edit at the edit's source time", () => {
    const t = mount(
      project([clip("a", "m-video", { keyframes: { x: [{ t: 1.5, v: 0 }, { t: 9.5, v: 80 }], y: [{ t: 1.5, v: 10 }, { t: 9.5, v: 50 }] } })]),
      "a",
      { time: 3, playing: true },
    );
    const x = t.fieldControl("X");
    t.engine.time = 5; // source 7.5: y evaluates to 10 + 40 * 0.75 = 40
    x.focus();
    type(x, "-12");
    const kfs = t.clipNow().keyframes!;
    expect(kfs.x).toContainEqual({ t: 7.5, v: -12 });
    expect(kfs.y).toContainEqual({ t: 7.5, v: 40 });
    expect(t.engine.pauses).toBe(1);
  });
});

describe("C92: number fields show what the project holds", () => {
  it("shows an over-the-top value clamped at once, and settles on it at commit", () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const { num } = t.groupSlider("Opacity");
    num.focus();
    type(num, "5");
    expect(num.value).toBe("1");
    expect(t.clipNow().transform!.opacity).toBe(1);
    num.blur();
    expect(num.value).toBe("1");
  });

  it("does not rewrite a below-the-bottom prefix while it is typed", () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const { num } = t.groupSlider("Scale");
    num.focus();
    type(num, "0");
    expect(num.value).toBe("0"); // on its way to 0.5 — the minimum is 0.1
    expect(t.clipNow().transform!.scale).toBe(0.1);
    type(num, "0.5");
    expect(t.clipNow().transform!.scale).toBe(0.5);
    num.blur();
    expect(num.value).toBe("0.5");
  });

  it("never applies 0 for an emptied number field, and restores it on blur", () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const x = t.fieldControl("X");
    x.focus();
    type(x, "");
    expect(t.clipNow().transform!.x).toBe(40);
    x.blur();
    expect(x.value).toBe("40");
    expect(t.history.length).toBe(0);
  });

  it("keeps the canvas size when a custom Width is emptied and left", () => {
    const t = mount(project([clip("a", "m-video")]), null);
    const size = t.fieldControl("Size");
    size.value = "custom";
    size.fire("change");
    const w = t.fieldControl("Width");
    w.focus();
    w.value = "";
    w.blur();
    expect(t.store.get().timeline.width).toBe(1920);
    expect(t.store.get().timeline.height).toBe(1080);
    expect(t.history.length).toBe(0);
    expect(w.value).toBe("1920");
  });

  it("restores a slider twin left holding a bad input to the last applied value", () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const { num } = t.groupSlider("Opacity");
    num.focus();
    type(num, "0.35");
    type(num, ""); // what a number input reads while it holds "-" or "1e"
    expect(t.clipNow().transform!.opacity).toBe(0.35);
    num.blur();
    expect(num.value).toBe("0.35");
    expect(t.history.length).toBe(1);
  });

  it("shows an evaluated position rounded to a whole pixel", () => {
    const t = mount(
      project([clip("a", "m-video", { keyframes: { x: [{ t: 1.5, v: 0 }, { t: 9.5, v: 10 }], y: [{ t: 1.5, v: 0 }, { t: 9.5, v: 7 }] } })]),
      "a",
      { time: 3 }, // source 3.5: x = 2.5, y = 1.75
    );
    expect(t.fieldControl("X").value).toBe("3");
    expect(t.fieldControl("Y").value).toBe("2");
  });

  it("keeps a text's size when its field is emptied and left", () => {
    const t = mount(project([clip("a", "m-text")]), "a");
    const size = t.fieldControl("Size (px)");
    size.focus();
    size.value = "";
    size.blur();
    const gen = t.store.get().media.find((m) => m.id === "m-text")!.generator;
    expect(gen).toMatchObject({ sizePx: 48 });
  });
});

describe("C93: Normalize applies only to the clip it measured", () => {
  const gain = (t: ReturnType<typeof mount>) => t.clipNow().audio.gainOffsetDb;
  const result = { maxVolumeDb: -7.25, suggestedGainDb: 6.25 };

  it("keeps a rebuilt button busy, scans once, and applies the answer", async () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    t.button("Normalize")!.fire("click");
    expect(spies.scans).toHaveLength(1);
    expect(spies.scans[0]).toMatchObject({ path: VIDEO.path, srcIn: 1.5, srcOut: 9.5 });
    t.selection.set(null);
    await flush();
    t.selection.set("a");
    await flush();
    const busy = t.button("Analyzing")!;
    expect(busy.disabled).toBe(true);
    busy.fire("click");
    expect(spies.scans).toHaveLength(1);
    spies.scans[0]!.settle(result);
    await flush();
    expect(gain(t)).toBe(6.25);
    expect(t.button("Normalize")!.disabled).toBe(false);
    expect(spies.info).toHaveLength(1);
  });

  it("drops an answer for a range the clip no longer plays, and frees the button", async () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    t.button("Normalize")!.fire("click");
    const trimmed = trimClip(t.store.get(), "a", "in", 3);
    expect(trimmed.timeline.tracks[0]!.clips[0]!.srcIn).not.toBe(1.5);
    t.store.set(trimmed);
    await flush();
    expect(t.button("Analyzing")).toBeDefined();
    spies.scans[0]!.settle(result);
    await flush();
    expect(gain(t)).toBe(0);
    expect(spies.info).toEqual(["The clip changed during analysis — run Normalize again."]);
    const btn = t.button("Normalize")!;
    expect(btn.disabled).toBe(false);
  });

  it("does nothing once the editor has closed", async () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    t.button("Normalize")!.fire("click");
    t.handle.dispose();
    spies.scans[0]!.settle(result);
    await flush();
    expect(gain(t)).toBe(0);
    expect(t.history).toHaveLength(0);
    expect(spies.info).toHaveLength(0);
    expect(spies.error).toHaveLength(0);
  });
});

describe("C94 + toasts", () => {
  it("names a text clip by its current text in the header", () => {
    const t = mount(project([clip("a", "m-text")]), "a");
    expect(t.header()).toBe("Text — Hello");
  });

  it("refuses an out-of-bounds crop without recording an error", () => {
    const t = mount(project([clip("a", "m-video")]), "a");
    const crop = t.host.find((e) => e.cls.has("insp-crop"))!;
    const w = crop.all((e) => e.tagName === "INPUT")[2]!;
    w.value = "5000";
    t.button("Apply")!.fire("click");
    expect(spies.refuse).toEqual(["Crop must fit inside 1280×720."]);
    expect(spies.error).toHaveLength(0);
  });
});
