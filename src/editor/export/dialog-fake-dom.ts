// A small fake DOM for mounting the export dialogs under vitest (which runs in
// node). Test-only: nothing in the app imports it.
//
// The dialogs build their views with `innerHTML`, so this parses the markup
// they write — tags, double-quoted attributes, text — into elements that
// answer the questions the dialogs and the REAL ui/focus module ask: simple
// selectors (tag, #id, .class, [attr], [attr="v"], :not(...), comma lists),
// `hidden`/`disabled`/`value` properties, rendered-ness through `offsetParent`
// (hidden attribute or the `.export-row--hidden` class anywhere up the tree),
// and a document whose `activeElement` falls back to <body> when the focused
// node is removed — which is exactly how a browser loses focus on an
// innerHTML swap, and what the focus tests are about.

type Handler = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ---------------- selectors ---------------- */

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: { name: string; value: string | null }[];
  nots: Compound[];
}

function parseCompound(sel: string): Compound {
  const c: Compound = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let rest = sel.trim();
  if (rest.startsWith("*")) rest = rest.slice(1);
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    c.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(rest))) c.ids.push(m[1]!);
    else if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1]!);
    else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) c.attrs.push({ name: m[1]!, value: m[2] ?? null });
    else if ((m = /^:not\(([^)]*)\)/.exec(rest))) c.nots.push(parseCompound(m[1]!));
    else throw new Error(`fake DOM: unsupported selector "${sel}"`);
    rest = rest.slice(m[0].length);
  }
  return c;
}

function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  for (const id of c.ids) if (el.getAttribute("id") !== id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const n of c.nots) if (matchesCompound(el, n)) return false;
  return true;
}

function matchesSelector(el: FakeElement, sel: string): boolean {
  return sel.split(",").some((part) => matchesCompound(el, parseCompound(part)));
}

/* ---------------- elements ---------------- */

export class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> = {};
  readOnly = false;
  spellcheck = false;
  private attrs = new Map<string, string>();
  private ownText = "";
  private html = "";
  private listeners = new Map<string, Set<Handler>>();
  private _value: string | null = null;
  private _checked: boolean | null = null;

  constructor(
    tag: string,
    readonly doc: FakeDocument,
  ) {
    this.tagName = tag.toUpperCase();
  }

  /* attributes */
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  attributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get title(): string {
    return this.getAttribute("title") ?? "";
  }
  set title(v: string) {
    this.setAttribute("title", v);
  }
  private boolAttr(name: string, on: boolean): void {
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
  }
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }
  set hidden(v: boolean) {
    this.boolAttr("hidden", v);
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
  set disabled(v: boolean) {
    this.boolAttr("disabled", v);
  }
  get checked(): boolean {
    return this._checked ?? this.hasAttribute("checked");
  }
  set checked(v: boolean) {
    this._checked = v;
  }
  get value(): string {
    if (this._value !== null) return this._value;
    if (this.tagName === "SELECT") {
      const opts = this.querySelectorAll("option");
      const sel = opts.find((o) => o.hasAttribute("selected")) ?? opts[0];
      return sel ? (sel.getAttribute("value") ?? sel.textContent) : "";
    }
    return this.getAttribute("value") ?? "";
  }
  set value(v: string) {
    this._value = String(v);
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) {
      if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return out;
  }
  get classList(): {
    contains(c: string): boolean;
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): boolean;
  } {
    const list = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (l: string[]): void => {
      this.className = l.join(" ");
    };
    return {
      contains: (c) => list().includes(c),
      add: (c) => {
        if (!list().includes(c)) write([...list(), c]);
      },
      remove: (c) => write(list().filter((x) => x !== c)),
      toggle: (c, on) => {
        const want = on ?? !list().includes(c);
        if (want) {
          if (!list().includes(c)) write([...list(), c]);
        } else write(list().filter((x) => x !== c));
        return want;
      },
    };
  }

  /* tree */
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = String(v);
  }
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = "";
    this.html = v;
    parseInto(this, v);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get parentElement(): FakeElement | null {
    return this.parent;
  }
  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...kids: FakeElement[]): void {
    for (const k of kids) this.appendChild(k);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(node: unknown): boolean {
    for (let n = node as FakeElement | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  get isConnected(): boolean {
    let n: FakeElement = this;
    while (n.parent) n = n.parent;
    return n === this.doc.body;
  }
  /** Rendered-ness, as focusables() reads it. */
  get offsetParent(): object | null {
    if (!this.isConnected) return null;
    for (let n: FakeElement | null = this; n; n = n.parent) {
      if (n.hidden || n.classList.contains("export-row--hidden")) return null;
    }
    return this.parent ?? {};
  }

  /* queries */
  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  matches(sel: string): boolean {
    return matchesSelector(this, sel);
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.descendants().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): FakeElement | null {
    return this.descendants().find((e) => e.matches(sel)) ?? null;
  }
  closest(sel: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }

  /* events + focus */
  addEventListener(type: string, fn: Handler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Fire `type` here and bubble it up the tree. */
  dispatch(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
    let stopped = false;
    const e: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      ...extra,
    };
    for (let n: FakeElement | null = this; n && !stopped; n = n.parent) {
      for (const fn of [...(n.listeners.get(type) ?? [])]) fn(e);
    }
    return e;
  }
  /** A click as a user makes it: nothing happens on a disabled control. */
  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }
  /** Type a value into a field: set it, then fire `input`. */
  typeText(value: string): void {
    this.value = value;
    this.dispatch("input");
  }
  focus(): void {
    this.doc.focused = this;
  }
  blur(): void {
    if (this.doc.focused === this) this.doc.focused = null;
  }
  select(): void {}
}

/** Parse `html` into `root`'s children. Enough for the markup the export
 *  dialogs write — not a general HTML parser. */
function parseInto(root: FakeElement, html: string): void {
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  const stack: FakeElement[] = [root];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]!;
    if (m[1]) {
      // closing tag: pop to the matching element (tolerant of strays)
      const name = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tagName === name) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const el = new FakeElement(m[2], root.doc);
      const attrRe = /([\w:-]+)(?:="([^"]*)")?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[3] ?? ""))) el.setAttribute(a[1]!, decode(a[2] ?? ""));
      top.appendChild(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5] && m[5].trim()) {
      const t = new FakeElement("#text", root.doc);
      t.textContent = decode(m[5]);
      top.appendChild(t);
    }
  }
}

export class FakeDocument {
  readonly body: FakeElement;
  focused: FakeElement | null = null;
  private listeners = new Map<string, Set<Handler>>();

  constructor() {
    this.body = new FakeElement("body", this);
  }
  /** What a browser reports: the focused node while it is still in the
   *  document, else <body>. */
  get activeElement(): FakeElement {
    return this.focused && this.focused.isConnected ? this.focused : this.body;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  addEventListener(type: string, fn: Handler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** A key press: capture listeners on the document first, then the focused
   *  element and up. */
  key(key: string): FakeEvent {
    const target = this.activeElement;
    let stopped = false;
    const e: FakeEvent = {
      type: "keydown",
      key,
      target,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    for (const fn of [...(this.listeners.get("keydown") ?? [])]) fn(e);
    if (!stopped) target.dispatch("keydown", e);
    return e;
  }
}

/** Install a fresh fake `document` + `window` timers on globalThis. Returns
 *  the document and an uninstaller. */
export function installFakeDom(): { doc: FakeDocument; uninstall: () => void } {
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  const had = { document: g.document, window: g.window };
  const doc = new FakeDocument();
  g.document = doc;
  g.window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  return {
    doc,
    uninstall: () => {
      g.document = had.document;
      g.window = had.window;
      if (had.document === undefined) delete g.document;
      if (had.window === undefined) delete g.window;
    },
  };
}

/** Let pending promise chains (and zero-delay timers) settle. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
