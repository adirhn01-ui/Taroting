import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmDeleteLayer, replaceMediaRefusal } from "./editor";
import type { MediaKind } from "../core/types";

/* ---------------- Replace media: the lane rule ---------------- */

describe("replaceMediaRefusal", () => {
  const VIDEO = "Choose a video or picture for a video layer.";
  const AUDIO = "Choose a sound file for an audio layer.";

  it("refuses a sound file on a video layer", () => {
    expect(replaceMediaRefusal("video", "audio")).toBe(VIDEO);
  });

  it("refuses every picture or video kind on an audio layer", () => {
    for (const kind of ["video", "image", "gif", "imageSeq"] as MediaKind[]) {
      expect(replaceMediaRefusal("audio", kind), kind).toBe(AUDIO);
    }
  });

  it("accepts every matching kind", () => {
    for (const kind of ["video", "image", "gif", "imageSeq"] as MediaKind[]) {
      expect(replaceMediaRefusal("video", kind), kind).toBeNull();
    }
    expect(replaceMediaRefusal("audio", "audio")).toBeNull();
  });
});

/* ---------------- Delete-layer confirm ---------------- */

// A small fake DOM (vitest runs in node) that is just enough for the dialog and
// the REAL ui/focus module: innerHTML is scanned for its buttons, which answer
// matches/offsetParent/hasAttribute/focus the way focusFirst and trapTab read
// them. Focus is recorded on the fake document, so the test sees exactly which
// button the dialog seated it on.

type Handler = (e: unknown) => void;

class Listeners {
  private map = new Map<string, Set<Handler>>();
  addEventListener(type: string, fn: Handler): void {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.map.get(type)?.delete(fn);
  }
  fire(type: string, e: unknown): void {
    for (const fn of [...(this.map.get(type) ?? [])]) fn(e);
  }
  count(type: string): number {
    return this.map.get(type)?.size ?? 0;
  }
}

class Btn extends Listeners {
  offsetParent: object = {};
  constructor(
    readonly className: string,
    readonly act: string,
  ) {
    super();
  }
  hasAttribute(): boolean {
    return false;
  }
  matches(sel: string): boolean {
    return sel === `[data-act="${this.act}"]`;
  }
  focus(): void {
    fakeDoc.activeElement = this;
  }
  click(): void {
    this.fire("click", { target: this });
  }
}

class Div extends Listeners {
  className = "";
  buttons: Btn[] = [];
  removed = 0;
  private html = "";
  set innerHTML(v: string) {
    this.html = v;
    this.buttons = [...v.matchAll(/<button class="([^"]*)" data-act="([^"]+)">/g)].map(
      (m) => new Btn(m[1]!, m[2]!),
    );
  }
  get innerHTML(): string {
    return this.html;
  }
  querySelector(sel: string): Btn | null {
    return this.buttons.find((b) => b.matches(sel)) ?? null;
  }
  querySelectorAll(): Btn[] {
    return this.buttons;
  }
  remove(): void {
    this.removed++;
    fakeDoc.body.children = fakeDoc.body.children.filter((c) => c !== this);
  }
}

class FakeDocument extends Listeners {
  activeElement: unknown = null;
  body = {
    children: [] as Div[],
    appendChild: (el: Div) => void fakeDoc.body.children.push(el),
  };
  createElement(): Div {
    return new Div();
  }
}

let fakeDoc: FakeDocument;

beforeEach(() => {
  fakeDoc = new FakeDocument();
  (globalThis as unknown as { document: unknown }).document = fakeDoc;
});
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

function open(): { backdrop: Div; cancel: Btn; del: Btn; confirms: () => number; close: () => void } {
  let n = 0;
  const close = confirmDeleteLayer("V2", 3, () => n++);
  const backdrop = fakeDoc.body.children[0]!;
  return {
    backdrop,
    cancel: backdrop.querySelector('[data-act="cancel"]')!,
    del: backdrop.querySelector('[data-act="confirm"]')!,
    confirms: () => n,
    close,
  };
}

function key(k: string): { key: string; prevented: number; preventDefault: () => void } {
  const e = {
    key: k,
    prevented: 0,
    preventDefault: () => {
      e.prevented++;
    },
  };
  return e;
}

describe("confirmDeleteLayer", () => {
  it("opens with focus on Cancel, never on Delete", () => {
    const { cancel } = open();
    expect(fakeDoc.activeElement).toBe(cancel);
  });

  it("Enter is left to the focused button: no document-wide delete, no swallowed key", () => {
    const d = open();
    const e = key("Enter");
    fakeDoc.fire("keydown", e);
    expect(d.confirms()).toBe(0);
    // Not prevented either: a handler that dropped the delete but still
    // preventDefault()ed would kill the button's own activation.
    expect(e.prevented).toBe(0);
    expect(fakeDoc.body.children).toContain(d.backdrop);
    // The browser then activates the focused button — Cancel.
    (fakeDoc.activeElement as Btn).click();
    expect(d.confirms()).toBe(0);
    expect(fakeDoc.body.children).not.toContain(d.backdrop);
  });

  it("Delete is the primary button, not danger-red: the action is undoable", () => {
    const { del } = open();
    expect(del.className.split(" ")).toContain("btn--primary");
    expect(del.className).not.toContain("btn--danger");
  });

  it("Delete deletes once and closes", () => {
    const d = open();
    d.del.click();
    expect(d.confirms()).toBe(1);
    expect(fakeDoc.body.children).not.toContain(d.backdrop);
    expect(fakeDoc.count("keydown")).toBe(0);
  });

  it("Escape still cancels", () => {
    const d = open();
    const e = key("Escape");
    fakeDoc.fire("keydown", e);
    expect(e.prevented).toBe(1);
    expect(d.confirms()).toBe(0);
    expect(fakeDoc.body.children).not.toContain(d.backdrop);
    expect(fakeDoc.count("keydown")).toBe(0);
  });

  it("returns a closer that takes the dialog down with the editor, once, without deleting", () => {
    const d = open();
    expect(fakeDoc.count("keydown")).toBe(1);
    d.close();
    d.close();
    expect(d.backdrop.removed).toBe(1);
    expect(fakeDoc.body.children).not.toContain(d.backdrop);
    expect(fakeDoc.count("keydown")).toBe(0);
    expect(d.backdrop.count("keydown")).toBe(0); // the Tab trap released too
    expect(d.confirms()).toBe(0);
  });
});
