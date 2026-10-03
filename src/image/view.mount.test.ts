import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockShortcuts } from "../core/shortcuts";
import { createViewController } from "./view";

// Hold to pan, mounted against a small fake DOM (vitest runs in node): which
// keyboard holds it passes through, and which focused controls keep their own
// Space. The view's listeners are the real ones; only the browser is faked.

type Handler = (e: unknown) => void;

/** Event listeners by type, the way the window and the stage keep them. */
class Target {
  private listeners = new Map<string, Set<Handler>>();
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
}

class FakeElement extends Target {}

/** An element that answers `closest` for the selector forms SPACE_ACTIVATES
 *  is written in (`tag`, `tag:not([type=x])`, `[role=x]`), walking parents. */
class FakeHTMLElement extends FakeElement {
  isContentEditable = false;
  readonly tagName: string;
  constructor(
    tag: string,
    readonly attrs: { role?: string; type?: string } = {},
    readonly parent: FakeHTMLElement | null = null,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get type(): string {
    return this.attrs.type ?? "text";
  }
  private matchesOne(sel: string): boolean {
    const role = /^\[role=([\w-]+)\]$/.exec(sel);
    if (role) return this.attrs.role === role[1];
    const not = /^(\w+):not\(\[type=(\w+)\]\)$/.exec(sel);
    if (not) return this.tagName === not[1]!.toUpperCase() && this.attrs.type !== not[2];
    if (!/^\w+$/.test(sel)) throw new Error(`the fake cannot match "${sel}"`);
    return this.tagName === sel.toUpperCase();
  }
  closest(selector: string): FakeHTMLElement | null {
    const parts = selector.split(",").map((s) => s.trim());
    for (let el: FakeHTMLElement | null = this; el; el = el.parent) {
      if (parts.some((p) => el!.matchesOne(p))) return el;
    }
    return null;
  }
}

class FakeStage extends FakeHTMLElement {
  readonly classes = new Set<string>();
  classList = {
    toggle: (c: string, on: boolean): void => {
      if (on) this.classes.add(c);
      else this.classes.delete(c);
    },
  };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 900, height: 500 };
  }
  setPointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  releasePointerCapture(): void {}
}

let win: Target & { devicePixelRatio: number };
let modal = false;

beforeEach(() => {
  modal = false;
  win = Object.assign(new Target(), { devicePixelRatio: 1 });
  const doc = Object.assign(new Target(), {
    querySelector: (s: string) => (modal && s === ".modal-backdrop" ? {} : null),
    visibilityState: "visible",
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function mount(panThroughBlock?: () => boolean) {
  const stage = new FakeStage("div");
  const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const view = createViewController(
    stage as unknown as HTMLElement,
    canvas,
    () => ({ w: 641, h: 361 }),
    panThroughBlock ? { panThroughBlock } : undefined,
  );
  /** Space pressed on `target`; whether the view claimed it. */
  const space = (target: unknown = null): { prevented: boolean } => {
    const r = { prevented: false };
    win.fire("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      target,
      preventDefault: () => {
        r.prevented = true;
      },
    });
    return r;
  };
  const release = (): void => win.fire("keyup", { key: " ", code: "Space" });
  /** A left-button drag on the stage; whether the view took it as a pan. */
  const drag = (dx: number, dy: number): { claimed: boolean } => {
    const r = { claimed: false };
    const ev = (x: number, y: number) => ({
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: x,
      clientY: y,
      target: stage,
      stopPropagation: () => {
        r.claimed = true;
      },
      preventDefault: () => {},
    });
    stage.fire("pointerdown", ev(300, 200));
    stage.fire("pointermove", ev(300 + dx, 200 + dy));
    stage.fire("pointerup", ev(300 + dx, 200 + dy));
    return r;
  };
  return { view, stage, space, release, drag };
}

describe("hold to pan through a crop's keyboard hold (C126)", () => {
  it("a crop's hold lets Space pan, and a held left-drag moves the view, not the crop", () => {
    const m = mount(() => true);
    const release = blockShortcuts();
    try {
      const before = m.view.store.get();
      expect(m.space().prevented).toBe(true);
      expect(m.view.panning).toBe(true);
      // The capture-phase pointerdown claims it (stopPropagation), so the
      // crop window under it never sees the press.
      expect(m.drag(-37, 23).claimed).toBe(true);
      const after = m.view.store.get();
      expect(after.panX - before.panX).toBe(-37);
      expect(after.panY - before.panY).toBe(23);
      m.release();
      expect(m.view.panning).toBe(false);
    } finally {
      release();
      m.view.dispose();
    }
  });

  it("any other hold still keeps Space inert (a menu or picker without a crop)", () => {
    const m = mount(() => false);
    const release = blockShortcuts();
    try {
      expect(m.space().prevented).toBe(false);
      expect(m.view.panning).toBe(false);
      expect(m.drag(-37, 23).claimed).toBe(false);
    } finally {
      release();
      m.view.dispose();
    }
  });

  it("with no option at all a hold keeps Space inert, as before", () => {
    const m = mount();
    const release = blockShortcuts();
    try {
      expect(m.space().prevented).toBe(false);
      expect(m.view.panning).toBe(false);
    } finally {
      release();
      m.view.dispose();
    }
  });

  it("a dialog keeps Space inert even inside a crop", () => {
    const m = mount(() => true);
    const release = blockShortcuts();
    modal = true;
    try {
      expect(m.space().prevented).toBe(false);
      expect(m.view.panning).toBe(false);
    } finally {
      release();
      m.view.dispose();
    }
  });

  it("control: with nothing held, Space pans whatever the option says", () => {
    const m = mount(() => false);
    try {
      expect(m.space().prevented).toBe(true);
      expect(m.view.panning).toBe(true);
    } finally {
      m.view.dispose();
    }
  });
});

describe("Space on a focused control is the control's (C127)", () => {
  const cases: [string, FakeHTMLElement][] = [
    ["the Flip switch (a checkbox input)", new FakeHTMLElement("input", { type: "checkbox" })],
    ["a button", new FakeHTMLElement("button")],
    ["an icon inside a button", new FakeHTMLElement("svg", {}, new FakeHTMLElement("button"))],
    ["an ARIA switch", new FakeHTMLElement("div", { role: "switch" })],
    ["a menu item", new FakeHTMLElement("div", { role: "menuitem" })],
  ];
  for (const [name, target] of cases) {
    it(`${name}: not prevented, no pan`, () => {
      const m = mount();
      try {
        expect(m.space(target).prevented).toBe(false);
        expect(m.view.panning).toBe(false);
      } finally {
        m.view.dispose();
      }
    });
  }

  // Focus that Space has no meaning for stays a pan: the ruler and a range
  // input keep focus after a drag, and "place the ruler, hold Space, drag" is
  // the everyday sequence.
  const panning: [string, FakeHTMLElement][] = [
    ["the ruler (role slider)", new FakeHTMLElement("div", { role: "slider" })],
    ["an inspector range input", new FakeHTMLElement("input", { type: "range" })],
    ["the Layers list", new FakeHTMLElement("div", { role: "listbox" })],
    ["the project name (a focusable div)", new FakeHTMLElement("div")],
  ];
  for (const [name, target] of panning) {
    it(`${name}: still pans`, () => {
      const m = mount();
      try {
        expect(m.space(target).prevented).toBe(true);
        expect(m.view.panning).toBe(true);
      } finally {
        m.view.dispose();
      }
    });
  }
});
