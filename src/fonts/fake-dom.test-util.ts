// A small fake DOM for the font runtime and picker tests (vitest runs in
// node). Test-only: nothing in the app imports it. The picker builds its DOM
// with createElement / textContent only, so this needs no markup parser: just
// elements, a document and a window that keep their listeners countable,
// events that capture (window, then document) and bubble, and focus.

type Handler = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeEl;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class Target {
  private map = new Map<string, Set<Handler>>();
  addEventListener(t: string, fn: Handler, capture?: boolean | { capture?: boolean }): void {
    const k = `${t}|${capOf(capture)}`;
    if (!this.map.has(k)) this.map.set(k, new Set());
    this.map.get(k)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler, capture?: boolean | { capture?: boolean }): void {
    this.map.get(`${t}|${capOf(capture)}`)?.delete(fn);
  }
  /** Run this node's listeners for one phase. */
  run(e: FakeEvent, capture: boolean): void {
    for (const fn of [...(this.map.get(`${e.type}|${capture}`) ?? [])]) fn(e);
  }
  /** Every listener still attached, of any type and phase. */
  listenerCount(): number {
    let n = 0;
    for (const s of this.map.values()) n += s.size;
    return n;
  }
}
const capOf = (c: boolean | { capture?: boolean } | undefined): boolean =>
  typeof c === "boolean" ? c : c?.capture === true;

export class FakeEl extends Target {
  readonly tagName: string;
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  private cls = new Set<string>();
  private attrs = new Map<string, string>();
  private text = "";
  style: Record<string, string> = {};
  id = "";
  type = "";
  value = "";
  placeholder = "";
  spellcheck = true;
  autocomplete = "";
  disabled = false;
  hidden = false;
  rect = { left: 10, top: 10, right: 210, bottom: 36, width: 200, height: 26 };
  constructor(
    tag: string,
    private readonly doc: FakeDocument,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this.cls = new Set(v.split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  classList = {
    add: (c: string): void => void this.cls.add(c),
    remove: (c: string): void => void this.cls.delete(c),
    contains: (c: string): boolean => this.cls.has(c),
  };
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.text = v;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  appendChild(c: FakeEl): FakeEl {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
    if (this.doc.activeElement && !this.doc.body.contains(this.doc.activeElement)) {
      this.doc.activeElement = this.doc.body;
    }
  }
  contains(n: FakeEl | null): boolean {
    for (let c: FakeEl | null = n; c; c = c.parentNode) if (c === this) return true;
    return false;
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }
  scrollIntoView(): void {}
  /** Depth-first descendants matching a class. */
  findAll(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => {
      for (const c of e.children) {
        if (c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export class FakeDocument extends Target {
  body: FakeEl;
  activeElement: FakeEl;
  constructor() {
    super();
    this.body = new FakeEl("body", this);
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeEl {
    return new FakeEl(tag, this);
  }
}

export class FakeWindow extends Target {
  innerWidth = 1280;
  innerHeight = 800;
}

export interface FakeDom {
  doc: FakeDocument;
  win: FakeWindow;
  /** Dispatch like a browser: window then document capture, then the target
   *  and its ancestors (bubbling), then document and window bubbling. */
  fire(target: FakeEl, type: string, init?: Partial<FakeEvent>): FakeEvent;
  restore(): void;
}

/** Install a fake `document` and `window` on globalThis. */
export function installFakeDom(): FakeDom {
  const g = globalThis as Record<string, unknown>;
  const prev = { document: g.document, window: g.window };
  const doc = new FakeDocument();
  const win = new FakeWindow();
  g.document = doc;
  g.window = win;
  const fire = (target: FakeEl, type: string, init: Partial<FakeEvent> = {}): FakeEvent => {
    const e: FakeEvent = {
      type,
      target,
      key: "",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...init,
    };
    const path: FakeEl[] = [];
    for (let n: FakeEl | null = target; n; n = n.parentNode) path.push(n);
    win.run(e, true);
    if (!e.propagationStopped) doc.run(e, true);
    for (const n of path) {
      if (e.propagationStopped) break;
      n.run(e, false);
    }
    if (!e.propagationStopped) doc.run(e, false);
    if (!e.propagationStopped) win.run(e, false);
    return e;
  };
  return {
    doc,
    win,
    fire,
    restore() {
      g.document = prev.document;
      g.window = prev.window;
    },
  };
}
