import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Floating surfaces under element fullscreen (errors.ts `placeOverlay`, and the
 * error dialog built on it).
 *
 * Element fullscreen puts the viewer or the theater container in the browser's
 * top layer, which paints above everything else in the document whatever its
 * z-index: a dialog appended to <body> there is open, focused and invisible.
 * So it goes inside the fullscreen element — and has to come back OUT when
 * fullscreen ends: the theater's container outlives that change (its exit only
 * drops a class and its listeners), so a dialog left inside would stay parked
 * in the preview subtree instead of on <body> with every other overlay.
 *
 * A small fake DOM (vitest runs in node): appends MOVE nodes, connection is
 * "hangs off <body>", and focus is dropped by a move exactly as a real
 * remove-and-insert drops it.
 */

vi.mock("./focus", () => ({ trapTab: () => () => {} }));
vi.mock("./icons", () => ({ icon: () => "" }));

type Handler = (e?: unknown) => void;

class Node_ {
  children: Node_[] = [];
  parentNode: Node_ | null = null;
  className = "";
  value = "";
  readOnly = false;
  spellcheck = false;
  textContent = "";
  style: Record<string, string> = {};
  handlers = new Map<string, Handler[]>();
  /** Every element querySelector handed out, by selector, so the dialog's
   *  buttons are real children of the backdrop. */
  private picked = new Map<string, Node_>();
  set innerHTML(_v: string) {}
  setAttribute(): void {}
  appendChild(c: Node_): Node_ {
    // A connected node that moves loses focus, as in a real DOM.
    if (c.parentNode && c.contains(doc.activeElement)) doc.activeElement = body;
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: Node_[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  replaceWith(n: Node_): void {
    const parent = this.parentNode!;
    parent.children = parent.children.map((x) => (x === this ? n : x));
    n.parentNode = parent;
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    for (let x = n as Node_ | null; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get isConnected(): boolean {
    for (let x: Node_ | null = this; x; x = x.parentNode) if (x === body) return true;
    return false;
  }
  /** Real children only, by class, in document order — never the lazy
   *  `picked` map, which would invent nodes. */
  querySelectorAll(sel: string): Node_[] {
    const cls = sel.replace(/^\./, "");
    const out: Node_[] = [];
    const walk = (n: Node_): void => {
      for (const c of n.children) {
        if (c.className.split(" ").includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): Node_ {
    let n = this.picked.get(sel);
    if (!n) {
      n = new Node_();
      this.picked.set(sel, n);
      this.appendChild(n);
    }
    return n;
  }
  addEventListener(t: string, fn: Handler): void {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]);
  }
  focus(): void {
    doc.activeElement = this;
  }
}

let body: Node_;
const listeners = new Map<string, Set<Handler>>();
const doc = {
  body: null as unknown as Node_,
  fullscreenElement: null as Node_ | null,
  activeElement: null as Node_ | null,
  createElement: () => new Node_(),
  addEventListener(t: string, fn: Handler): void {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  },
  removeEventListener(t: string, fn: Handler): void {
    listeners.get(t)?.delete(fn);
  },
  querySelectorAll: (sel: string): Node_[] => body.querySelectorAll(sel),
};
const keydown = new Set<Handler>();
const win = {
  addEventListener(t: string, fn: Handler): void {
    if (t === "keydown") keydown.add(fn);
  },
  removeEventListener(t: string, fn: Handler): void {
    if (t === "keydown") keydown.delete(fn);
  },
};
function pressEscape(): void {
  const e = { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} };
  for (const fn of [...keydown]) fn(e);
}

const fsListeners = (): number => listeners.get("fullscreenchange")?.size ?? 0;
function fireFullscreenChange(): void {
  for (const fn of [...(listeners.get("fullscreenchange") ?? [])]) fn();
}

beforeEach(() => {
  body = new Node_();
  doc.body = body;
  doc.fullscreenElement = null;
  doc.activeElement = body;
  listeners.clear();
  keydown.clear();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const { openErrorDialog, overlayParent, placeOverlay } = await import("./errors");

function fullscreen(): Node_ {
  const viewer = new Node_();
  body.appendChild(viewer);
  doc.fullscreenElement = viewer;
  return viewer;
}

describe("placeOverlay", () => {
  it("puts a surface on <body> and listens for nothing when nothing is fullscreen", () => {
    const n = new Node_();
    placeOverlay(n as unknown as Element);
    expect(n.parentNode).toBe(body);
    expect(overlayParent()).toBe(body);
    expect(fsListeners()).toBe(0);
  });

  it("puts it inside the fullscreen element, with ONE listener however often it is placed", () => {
    const viewer = fullscreen();
    const n = new Node_();
    placeOverlay(n as unknown as Element);
    placeOverlay(n as unknown as Element);
    expect(n.parentNode).toBe(viewer);
    expect(fsListeners()).toBe(1);
  });

  it("carries it back to <body> when fullscreen ends — focus included — and stops listening", () => {
    const viewer = fullscreen();
    const n = new Node_();
    const button = new Node_();
    n.appendChild(button);
    placeOverlay(n as unknown as Element);
    button.focus();

    doc.fullscreenElement = null;
    fireFullscreenChange();
    expect(n.parentNode).toBe(body);
    expect(viewer.children.includes(n)).toBe(false);
    expect(doc.activeElement).toBe(button);
    expect(fsListeners()).toBe(0);
  });

  it("leaves a surface alone once released, or once it has left the document", () => {
    const viewer = fullscreen();
    const released = new Node_();
    const gone = new Node_();
    placeOverlay(released as unknown as Element)();
    placeOverlay(gone as unknown as Element);
    expect(fsListeners()).toBe(1);
    gone.remove();

    doc.fullscreenElement = null;
    fireFullscreenChange();
    expect(released.parentNode).toBe(viewer);
    expect(gone.parentNode).toBe(null);
    expect(fsListeners()).toBe(0);
  });
});

describe("the error dialog under element fullscreen", () => {
  const opts = { title: "Monitor volume", message: "Couldn't save your settings.", report: "denied" };
  const backdropIn = (parent: Node_): Node_ | undefined =>
    parent.children.find((c) => c.className === "modal-backdrop");

  it("opens inside the fullscreen element, and is back on <body> — still focused — after Esc leaves it", () => {
    const viewer = fullscreen();
    const close = openErrorDialog(opts);
    const backdrop = backdropIn(viewer)!;
    expect(backdrop).toBeDefined();
    expect(backdropIn(body)).toBeUndefined();
    const ok = backdrop.querySelector("[data-ok]");
    expect(doc.activeElement).toBe(ok);

    doc.fullscreenElement = null;
    fireFullscreenChange();
    expect(backdropIn(body)).toBe(backdrop);
    expect(doc.activeElement).toBe(ok);
    close();
    expect(backdropIn(body)).toBeUndefined();
  });

  it("drops its fullscreen listener when it closes", () => {
    fullscreen();
    const close = openErrorDialog(opts);
    expect(fsListeners()).toBe(1);
    close();
    expect(fsListeners()).toBe(0);
  });

  it("opens on <body> with no listener when nothing is fullscreen", () => {
    const close = openErrorDialog(opts);
    expect(backdropIn(body)).toBeDefined();
    expect(fsListeners()).toBe(0);
    close();
  });

  // Inside the fullscreen element the dialog comes EARLIER in document order
  // than a backdrop on <body>, yet it is the one on screen: the body one is
  // behind the top layer. Counting by document order alone, Esc did nothing.
  it("closes on Esc under fullscreen even when a backdrop on <body> comes later in the document", () => {
    const viewer = fullscreen();
    const hidden = new Node_();
    hidden.className = "modal-backdrop";
    body.appendChild(hidden);
    openErrorDialog(opts);
    const shown = backdropIn(viewer)!;
    expect(shown).toBeDefined();

    pressEscape();
    expect(backdropIn(viewer)).toBeUndefined();
    expect(shown.parentNode).toBe(null);
    expect(hidden.parentNode).toBe(body);
  });

  it("closes only the last of two dialogs on Esc when nothing is fullscreen", () => {
    openErrorDialog(opts);
    openErrorDialog({ ...opts, title: "Export" });
    const [under, over] = body.children.filter((c) => c.className === "modal-backdrop");
    pressEscape();
    expect(over!.parentNode).toBe(null);
    expect(under!.parentNode).toBe(body);
    pressEscape();
    expect(under!.parentNode).toBe(null);
  });
});