import { afterEach, describe, expect, it, vi } from "vitest";

// The context menu rendered against a small fake DOM (vitest runs in node):
// plain rows must stay exactly what every existing menu renders, and a row
// with an icon/hint renders the icon as markup and the hint as TEXT.

vi.mock("../core/shortcuts", () => ({ blockShortcuts: () => () => {} }));

type Handler = (e: unknown) => void;

class Listeners {
  private map = new Map<string, Set<Handler>>();
  addEventListener(t: string, fn: Handler): void {
    if (!this.map.has(t)) this.map.set(t, new Set());
    this.map.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.map.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown): void {
    for (const fn of [...(this.map.get(t) ?? [])]) fn(e);
  }
  count(t: string): number {
    return this.map.get(t)?.size ?? 0;
  }
}

class El extends Listeners {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  cls = new Set<string>();
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  title = "";
  type = "";
  disabled = false;
  /** Every string assigned to innerHTML, so a test can prove text never went in as markup. */
  htmlWrites: string[] = [];
  private text = "";
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this.cls = new Set(v.split(" ").filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  classList = {
    add: (c: string) => void this.cls.add(c),
    remove: (c: string) => void this.cls.delete(c),
    contains: (c: string) => this.cls.has(c),
  };
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.text = v;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set innerHTML(v: string) {
    this.htmlWrites.push(v);
    this.textContent = "";
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  appendChild(c: El): El {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  contains(n: unknown): boolean {
    for (let x = n as El | null; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  focus(): void {
    doc.activeElement = this;
  }
  get isConnected(): boolean {
    return true;
  }
  getBoundingClientRect(): { width: number; height: number } {
    return { width: 200, height: 80 };
  }
  /** Only the one selector menu.ts asks: every descendant carrying the class. */
  querySelectorAll(sel: string): El[] {
    const want = sel.replace(/^\./, "");
    const out: El[] = [];
    const walk = (e: El): void => {
      for (const c of e.children) {
        if (c.cls.has(want)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const body = new El("body");
const doc = Object.assign(new Listeners(), {
  body,
  activeElement: body as El | null,
  createElement: (tag: string) => new El(tag),
});
const win = Object.assign(new Listeners(), { innerWidth: 1200, innerHeight: 800 });
vi.stubGlobal("document", doc);
vi.stubGlobal("window", win);
vi.stubGlobal("HTMLElement", El);

const { closeMenu, showMenu } = await import("./menu");

const host = (): El => body.children[0]!;
const rows = (): El[] => host().children;
const key = (k: string): void => doc.fire("keydown", { key: k, preventDefault: () => {} });

afterEach(() => closeMenu());

describe("showMenu rendering", () => {
  it("renders plain rows exactly as before: one text node, no children, no rich class", () => {
    showMenu(10, 10, [
      { label: "Open", onSelect: () => {} },
      { label: "Delete <file>", danger: true, onSelect: () => {} },
      { label: "Merge", disabled: true, title: "Needs two clips", onSelect: () => {} },
    ]);
    expect(rows()).toHaveLength(3);
    for (const r of rows()) {
      expect(r.tagName).toBe("BUTTON");
      expect(r.children).toEqual([]);
      expect(r.htmlWrites).toEqual([]);
      expect(r.cls.has("ctx-menu__item--rich")).toBe(false);
    }
    expect(rows().map((r) => r.className)).toEqual([
      "ctx-menu__item",
      "ctx-menu__item ctx-menu__item--danger",
      "ctx-menu__item",
    ]);
    expect(rows().map((r) => r.textContent)).toEqual(["Open", "Delete <file>", "Merge"]);
    expect(rows()[2]!.disabled).toBe(true);
    expect(rows()[2]!.title).toBe("Needs two clips");
    // A disabled row is inert: no click or hover handler at all.
    expect(rows()[2]!.count("click")).toBe(0);
    expect(rows()[0]!.count("click")).toBe(1);
  });

  it("renders an icon as markup before the label and the hint as a second, escaped line", () => {
    const svg = '<svg data-i="film"></svg>';
    showMenu(10, 10, [
      { label: "Video <b>project</b>", icon: svg, hint: "Clips & <i>music</i>", onSelect: () => {} },
    ]);
    const row = rows()[0]!;
    expect(row.className).toBe("ctx-menu__item ctx-menu__item--rich");
    expect(row.htmlWrites).toEqual([]);
    const [ico, text] = row.children;
    expect(ico!.className).toBe("ctx-menu__icon");
    expect(ico!.htmlWrites).toEqual([svg]);
    expect(ico!.attrs.get("aria-hidden")).toBe("true");
    const [label, hint] = text!.children;
    expect(label!.className).toBe("ctx-menu__label");
    expect(hint!.className).toBe("ctx-menu__hint");
    // Text, never markup: the angle brackets stay characters.
    expect(label!.textContent).toBe("Video <b>project</b>");
    expect(hint!.textContent).toBe("Clips & <i>music</i>");
    expect(label!.htmlWrites).toEqual([]);
    expect(hint!.htmlWrites).toEqual([]);
    expect(text!.htmlWrites).toEqual([]);
  });

  it("an icon without a hint has no hint line; a hint without an icon has no icon tile", () => {
    showMenu(10, 10, [
      { label: "A", icon: "<svg></svg>", onSelect: () => {} },
      { label: "B", hint: "why", onSelect: () => {} },
    ]);
    const [a, b] = rows();
    expect(a!.children.map((c) => c.className)).toEqual(["ctx-menu__icon", "ctx-menu__text"]);
    expect(a!.children[1]!.children.map((c) => c.className)).toEqual(["ctx-menu__label"]);
    expect(b!.children.map((c) => c.className)).toEqual(["ctx-menu__text"]);
    expect(b!.textContent).toBe("Bwhy");
  });

  it("keeps keyboard navigation over rich rows: the arrows skip a disabled row and Enter selects", () => {
    const picked: string[] = [];
    showMenu(10, 10, [
      { label: "Video project", icon: "<svg></svg>", hint: "h1", onSelect: () => picked.push("video") },
      { label: "Off", icon: "<svg></svg>", hint: "h2", disabled: true, onSelect: () => picked.push("off") },
      { label: "Image project", icon: "<svg></svg>", hint: "h3", onSelect: () => picked.push("image") },
    ]);
    // Only the three buttons are rows: the spans inside them are not.
    expect(host().querySelectorAll(".ctx-menu__item")).toHaveLength(3);
    key("ArrowDown");
    expect(doc.activeElement).toBe(rows()[0]);
    key("ArrowDown");
    expect(doc.activeElement).toBe(rows()[2]);
    key("Enter");
    expect(picked).toEqual(["image"]);
    expect(host().style.display).toBe("none");
    expect(host().children).toEqual([]);
  });

  // A menu button opened from the keyboard (Home's "New project" on Enter)
  // starts on its first ENABLED row, so the very next Enter chooses it. Row 0
  // is disabled here so "the first row" and "the first enabled row" differ.
  const kbRows = (picked: string[]) => [
    { label: "Off", disabled: true, onSelect: () => picked.push("off") },
    { label: "Video project", icon: "<svg></svg>", hint: "h1", onSelect: () => picked.push("video") },
    { label: "Image project", icon: "<svg></svg>", hint: "h2", onSelect: () => picked.push("image") },
  ];

  it("activateFirst: the first enabled row is highlighted and focused, and Enter chooses it", () => {
    const picked: string[] = [];
    showMenu(10, 10, kbRows(picked), undefined, true);
    expect(doc.activeElement).toBe(rows()[1]);
    expect(rows()[1]!.cls.has("ctx-menu__item--active")).toBe(true);
    expect(rows()[0]!.cls.has("ctx-menu__item--active")).toBe(false);
    key("Enter");
    expect(picked).toEqual(["video"]);
    expect(host().style.display).toBe("none");
  });

  it("without activateFirst (a pointer open) nothing is highlighted and Enter does nothing", () => {
    const picked: string[] = [];
    doc.activeElement = body;
    showMenu(10, 10, kbRows(picked));
    expect(doc.activeElement).toBe(body);
    expect(rows().some((r) => r.cls.has("ctx-menu__item--active"))).toBe(false);
    key("Enter");
    expect(picked).toEqual([]);
    expect(host().style.display).toBe("block");
  });

  it("Escape closes without selecting", () => {
    const picked: string[] = [];
    showMenu(10, 10, [{ label: "Video project", icon: "<svg></svg>", onSelect: () => picked.push("v") }]);
    key("ArrowDown");
    key("Escape");
    expect(picked).toEqual([]);
    expect(host().style.display).toBe("none");
  });
});
