// A small fake DOM for the PDF editor's mount tests (vitest runs in node).
// Enough of the real thing for the shell, the page panel, the find bar and
// the sources dialog: an element tree built through createElement, simple
// selectors (tag, #id, .class, [attr], [attr="v"], descendant, comma lists),
// events with capture / target / bubble phases up through document to
// window, focus, classList, attributes. innerHTML is stored, never parsed —
// the shell only ever puts trusted icon markup there.

/* eslint-disable @typescript-eslint/no-explicit-any */

type Fn = (e: any) => void;

export class FakeEvent {
  type: string;
  target: any = null;
  currentTarget: any = null;
  defaultPrevented = false;
  stopped = false;
  bubbles = true;
  [k: string]: any;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
  stopImmediatePropagation(): void {
    this.stopped = true;
  }
}

export class FakeTarget {
  private ls = new Map<string, { fn: Fn; capture: boolean }[]>();
  /** where an event goes after this node (document → window) */
  eventParent: FakeTarget | null = null;
  addEventListener(type: string, fn: Fn, opts?: boolean | { capture?: boolean; passive?: boolean }): void {
    const capture = opts === true || (typeof opts === "object" && opts?.capture === true);
    const list = this.ls.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture });
    this.ls.set(type, list);
  }
  removeEventListener(type: string, fn: Fn, opts?: boolean | { capture?: boolean }): void {
    const capture = opts === true || (typeof opts === "object" && opts?.capture === true);
    const list = this.ls.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  listenerCount(type: string): number {
    return this.ls.get(type)?.length ?? 0;
  }
  invoke(e: FakeEvent, phase: "capture" | "target" | "bubble"): void {
    for (const l of [...(this.ls.get(e.type) ?? [])]) {
      if (phase === "capture" && !l.capture) continue;
      if (phase === "bubble" && l.capture) continue;
      e.currentTarget = this;
      l.fn(e);
    }
  }
  dispatchEvent(e: FakeEvent): boolean {
    e.target = this;
    const path: FakeTarget[] = [];
    for (let n: FakeTarget | null = this.eventParentOf(); n; n = n.eventParentOf()) path.push(n);
    for (let i = path.length - 1; i >= 0 && !e.stopped; i--) path[i]!.invoke(e, "capture");
    if (!e.stopped) this.invoke(e, "target");
    if (e.bubbles) for (const n of path) {
      if (e.stopped) break;
      n.invoke(e, "bubble");
    }
    return !e.defaultPrevented;
  }
  eventParentOf(): FakeTarget | null {
    return this.eventParent;
  }
}

export class FakeNode extends FakeTarget {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  nodeType = 1;
  override eventParentOf(): FakeTarget | null {
    return this.parentNode ?? this.eventParent;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v) this.appendChild(new FakeText(String(v)) as any);
  }
  appendChild<T extends FakeNode>(c: T): T {
    c.parentNode?.removeChild(c);
    this.childNodes.push(c);
    c.parentNode = this as any;
    return c;
  }
  removeChild<T extends FakeNode>(c: T): T {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
    c.parentNode = this as any;
    return c;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  contains(n: FakeNode | null): boolean {
    for (let x: FakeNode | null = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get isConnected(): boolean {
    let x: FakeNode = this;
    while (x.parentNode) x = x.parentNode;
    return x === (globalThis as any).document?.documentElement;
  }
}

export class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
    this.nodeType = 3;
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(v: string) {
    this.data = v;
  }
}

/* ------------------------------ selectors ------------------------------ */

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
}

function parseCompound(s: string): Compound {
  const c: Compound = { classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|\*/g;
  for (const m of s.matchAll(re)) {
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], value: m[5] });
  }
  return c;
}

function matchCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  return true;
}

function matchSelector(el: FakeElement, sel: string): boolean {
  return sel.split(",").some((part) => {
    const chain = part.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, chain[chain.length - 1]!)) return false;
    let i = chain.length - 2;
    for (let x = el.parentNode; x && i >= 0; x = x.parentNode) if (x instanceof FakeElement && matchCompound(x, chain[i]!)) i--;
    return i < 0;
  });
}

/* ------------------------------ elements ------------------------------ */

export class FakeElement extends FakeNode {
  readonly tagName: string;
  id = "";
  private cls = new Set<string>();
  private attrs = new Map<string, string>();
  style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(Object.create(null), {
    setProperty(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
  });
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = "";
  type = "";
  title = "";
  placeholder = "";
  spellcheck = true;
  checked = false;
  tabIndex = 0;
  scrollTop = 0;
  scrollLeft = 0;
  clientWidth = 800;
  clientHeight = 600;
  isContentEditable = false;
  html = "";
  width = 0;
  height = 0;
  /** pointer ids captured */
  captured = new Set<number>();
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  set className(v: string) {
    this.cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get classList() {
    const self = this;
    return {
      add: (...c: string[]) => c.forEach((x) => self.cls.add(x)),
      remove: (...c: string[]) => c.forEach((x) => self.cls.delete(x)),
      contains: (c: string) => self.cls.has(c),
      toggle(c: string, force?: boolean): boolean {
        const on = force ?? !self.cls.has(c);
        if (on) self.cls.add(c);
        else self.cls.delete(c);
        return on;
      },
    };
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.html = v;
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const n of nodes) this.appendChild(typeof n === "string" ? new FakeText(n) : n);
  }
  after(...nodes: FakeNode[]): void {
    const p = this.parentNode;
    if (!p) return;
    let ref: FakeNode | null = p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
    for (const n of nodes) {
      p.insertBefore(n, ref);
      ref = p.childNodes[p.childNodes.indexOf(n) + 1] ?? null;
    }
  }
  setAttribute(k: string, v: string): void {
    if (k === "id") this.id = v;
    else if (k === "class") this.className = v;
    else this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    if (k === "id") return this.id || null;
    if (k === "class") return this.className || null;
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.getAttribute(k) !== null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  matches(sel: string): boolean {
    return matchSelector(this, sel);
  }
  closest(sel: string): FakeElement | null {
    for (let x: FakeNode | null = this; x; x = x.parentNode) if (x instanceof FakeElement && x.matches(sel)) return x;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode): void => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  focus(): void {
    const d = (globalThis as any).document as FakeDocument;
    const prev = d.activeElement;
    if (prev === this) return;
    d.activeElement = this;
    if (prev && prev !== d.body) prev.dispatchEvent(new FakeEvent("blur", { bubbles: false }));
    if (prev && prev !== d.body) prev.dispatchEvent(new FakeEvent("focusout", { relatedTarget: this }));
    this.dispatchEvent(new FakeEvent("focus", { bubbles: false }));
  }
  blur(): void {
    const d = (globalThis as any).document as FakeDocument;
    if (d.activeElement !== this) return;
    d.activeElement = d.body;
    this.dispatchEvent(new FakeEvent("blur", { bubbles: false }));
    this.dispatchEvent(new FakeEvent("focusout"));
  }
  select(): void {}
  click(detail = 1): void {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click", { detail, button: 0 }));
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, right: 110, bottom: 44, width: 100, height: 24, x: 10, y: 20 };
  }
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
  scrollTo(): void {}
  scrollIntoView(): void {}
  /* canvas */
  getContext(): unknown {
    return { fillStyle: "", fillRect: () => {}, drawImage: () => {} };
  }
  toBlob(cb: (b: Blob | null) => void, type?: string): void {
    const blob = new Blob([new Uint8Array(4)], { type: type ?? "image/png" });
    (blob as any).size0 = [this.width, this.height];
    queueMicrotask(() => cb(blob));
  }
}

export class FakeDocument extends FakeTarget {
  documentElement = new FakeElement("html");
  body = new FakeElement("body");
  activeElement: FakeElement;
  constructor(win: FakeTarget) {
    super();
    this.documentElement.appendChild(this.body);
    this.documentElement.eventParent = this;
    this.eventParent = win;
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  createTextNode(s: string): FakeText {
    return new FakeText(s);
  }
  querySelector(sel: string): FakeElement | null {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.documentElement.querySelectorAll(sel);
  }
  get fullscreenElement(): null {
    return null;
  }
}

export interface FakeWindow extends FakeTarget {
  [k: string]: any;
}

/** Install a fresh fake window + document as globals (with vi.stubGlobal). */
export function installFakeDom(stub: (name: string, value: unknown) => void): { win: FakeWindow; doc: FakeDocument } {
  const win = new FakeTarget() as FakeWindow;
  Object.assign(win, {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: unknown) => globalThis.clearTimeout(id as never),
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id: unknown) => globalThis.clearInterval(id as never),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    getSelection: () => null,
  });
  const doc = new FakeDocument(win);
  stub("window", win);
  stub("document", doc);
  stub("Element", FakeElement);
  stub("HTMLElement", FakeElement);
  stub("Node", FakeNode);
  return { win, doc };
}

/** Fire a keyboard event at `target` (bubbling to window). */
export function key(target: FakeTarget, k: string, extra: Record<string, unknown> = {}, type = "keydown"): FakeEvent {
  const e = new FakeEvent(type, {
    key: k,
    code: k === " " ? "Space" : k.length === 1 ? `Key${k.toUpperCase()}` : k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...extra,
  });
  target.dispatchEvent(e);
  return e;
}
