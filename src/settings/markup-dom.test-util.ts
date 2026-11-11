// A small fake DOM for the Settings → Fonts and Fonts page tests (vitest runs
// in node; no DOM library is a dependency). Test-only: nothing in the app
// imports it. These screens are built from markup strings, so the fake parses
// the markup it is handed — only the shapes they write: tags, quoted and
// boolean attributes, void <input>, text — and matches the simple selectors
// they query with (tag, #id, .class, [attr], [attr="v"], :not(…), comma lists).
//
// What it models of a real engine, because the behaviour under test depends
// on it: replacing markup detaches the focused node and focus falls to <body>;
// a disabled control cannot hold focus; a click on a disabled button is not
// delivered; `focus.ts`'s reachability test (`offsetParent`) is "attached"; a
// key event runs document capture listeners, then the target and its
// ancestors, then document bubble listeners, and stopPropagation ends it.
//
// Install with `vi.stubGlobal("document", doc)` (and a window) in the test.

type Handler = (e: unknown) => void;

const VOID = new Set(["input", "br", "img", "hr", "meta", "path", "circle"]);

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export class El {
  readonly tagName: string;
  nodes: Array<El | string> = [];
  parentNode: El | null = null;
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  value = "";
  checked = false;
  listeners = new Map<string, Set<Handler>>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get children(): El[] {
    return this.nodes.filter((n): n is El => typeof n !== "string");
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  classList = {
    contains: (c: string): boolean => this.classes.includes(c),
    add: (c: string): void => {
      if (!this.classes.includes(c)) this.className = [...this.classes, c].join(" ");
    },
    remove: (c: string): void => {
      this.className = this.classes.filter((x) => x !== c).join(" ");
    },
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.includes(c);
      if (on) this.classList.add(c);
      else this.classList.remove(c);
      return on;
    },
  };
  get disabled(): boolean {
    return this.attrs.has("disabled");
  }
  set disabled(v: boolean) {
    if (v) this.attrs.set("disabled", "");
    else this.attrs.delete("disabled");
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) {
      if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return out;
  }
  get textContent(): string {
    return this.nodes.map((n) => (typeof n === "string" ? n : n.textContent)).join("");
  }
  set textContent(v: string) {
    this.detachAll();
    this.nodes = [v];
  }
  set innerHTML(html: string) {
    this.detachAll();
    parseInto(this, html);
  }
  get innerHTML(): string {
    return "";
  }
  get isConnected(): boolean {
    let n: El | null = this;
    while (n) {
      if (n === body) return true;
      n = n.parentNode;
    }
    return false;
  }
  get offsetParent(): El | null {
    if (!this.isConnected) return null;
    for (let n: El | null = this; n; n = n.parentNode) if (n.hidden) return null;
    return this.parentNode;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  private detachAll(): void {
    for (const c of this.children) c.parentNode = null;
    this.nodes = [];
  }
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.nodes.push(c);
    return c;
  }
  remove(): void {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.nodes = p.nodes.filter((n) => n !== this);
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  /** Every listener still attached to this element (any type). */
  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  fire(t: string, extra: Record<string, unknown> = {}): void {
    let stopped = false;
    const ev: Record<string, unknown> = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
      ...extra,
    };
    for (let n: El | null = this; n && !stopped; n = n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners.get(t) ?? [])]) fn(ev);
    }
  }
  click(): void {
    if (!this.disabled) this.fire("click");
  }
  focus(): void {
    focusState.el = this;
  }
  blur(): void {
    if (focusState.el === this) focusState.el = null;
  }
  select(): void {}
  scrollIntoView(): void {}
  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchCompound(this, part.trim()));
  }
  closest(selector: string): El | null {
    for (let n: El | null = this; n; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  all(): El[] {
    const out: El[] = [];
    const walk = (e: El): void => {
      for (const c of e.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(selector: string): El[] {
    return this.all().filter((e) => e.matches(selector));
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchCompound(el: El, sel: string): boolean {
  let rest = sel;
  while (rest.length > 0) {
    let mm: RegExpMatchArray | null;
    if ((mm = rest.match(/^:not\(([^)]*)\)/))) {
      if (matchCompound(el, mm[1]!)) return false;
    } else if ((mm = rest.match(/^#([\w-]+)/))) {
      if (el.id !== mm[1]) return false;
    } else if ((mm = rest.match(/^\.([\w-]+)/))) {
      if (!el.classes.includes(mm[1]!)) return false;
    } else if ((mm = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\]/))) {
      const v = el.getAttribute(mm[1]!);
      if (v === null || (mm[2] !== undefined && v !== mm[2])) return false;
    } else if ((mm = rest.match(/^[a-zA-Z][\w-]*/))) {
      if (el.tagName !== mm[0].toUpperCase()) return false;
    } else {
      throw new Error(`fake DOM: unsupported selector "${sel}"`);
    }
    rest = rest.slice(mm[0].length);
  }
  return true;
}

const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseInto(root: El, html: string): void {
  const stack: El[] = [root];
  for (const t of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (t[0].startsWith("<!--")) continue;
    if (t[1]) {
      const tag = t[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tagName === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (t[2]) {
      const el = new El(t[2]);
      for (const a of (t[3] ?? "").matchAll(ATTR)) {
        el.attrs.set(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
      }
      top.appendChild(el);
      if (!VOID.has(t[2].toLowerCase()) && !t[0].endsWith("/>")) stack.push(el);
    } else {
      top.nodes.push(decode(t[0]));
    }
  }
}

export const focusState = { el: null as El | null };
export const body = new El("body");

/** Document listeners by phase: `${type}|capture` / `${type}|bubble`. */
const docListeners = new Map<string, Set<Handler>>();
const phaseOf = (c: unknown): string =>
  (typeof c === "boolean" ? c : (c as { capture?: boolean } | undefined)?.capture === true) ? "capture" : "bubble";

export const doc = {
  body,
  get activeElement(): El {
    const el = focusState.el;
    return el && el.isConnected && !el.disabled ? el : body;
  },
  createElement: (tag: string) => new El(tag),
  querySelector: (sel: string) => body.querySelector(sel),
  querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  addEventListener: (t: string, fn: Handler, capture?: unknown) => {
    const k = `${t}|${phaseOf(capture)}`;
    if (!docListeners.has(k)) docListeners.set(k, new Set());
    docListeners.get(k)!.add(fn);
  },
  removeEventListener: (t: string, fn: Handler, capture?: unknown) =>
    void docListeners.get(`${t}|${phaseOf(capture)}`)?.delete(fn),
};

/** Listeners on the document, of every type and phase. */
export function docListenerCount(): number {
  let n = 0;
  for (const s of docListeners.values()) n += s.size;
  return n;
}

/** A keydown as a browser delivers it: document capture, the target (the
 *  focused element unless given) and its ancestors, document bubble. Answers
 *  whether a listener called preventDefault. */
export function pressKey(key: string, opts: { target?: El; ctrlKey?: boolean; code?: string } = {}): boolean {
  let stopped = false;
  let prevented = false;
  const target = opts.target ?? doc.activeElement;
  const ev: Record<string, unknown> = {
    type: "keydown",
    key,
    code: opts.code ?? "",
    ctrlKey: opts.ctrlKey === true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  for (const fn of [...(docListeners.get("keydown|capture") ?? [])]) if (!stopped) fn(ev);
  for (let n: El | null = target; n && !stopped; n = n.parentNode) {
    for (const fn of [...(n.listeners.get("keydown") ?? [])]) fn(ev);
  }
  if (!stopped) for (const fn of [...(docListeners.get("keydown|bubble") ?? [])]) fn(ev);
  return prevented;
}

export const fakeWindow = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  addEventListener: () => {},
  removeEventListener: () => {},
};

/** Let promises and one macrotask run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Flush until `cond` holds (bounded): a dynamic import can take more than
 *  one macrotask to land. */
export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}
