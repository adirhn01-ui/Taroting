import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentItem, RecentsIndex } from "../core/types";

// mountHome against a stub DOM (vitest runs in node): every element Home looks
// up is a stub that records what Home does to it. What this pins is behaviour
// a pure helper cannot show — where focus starts, what the grid says when the
// recents list cannot be read, how the thumbnail backfill is paced, and the
// Recover lines for temporary projects a crash left behind.

const m = vi.hoisted(() => ({
  recents: null as null | (() => Promise<RecentsIndex>),
  listCalls: 0,
  orphans: [] as string[],
  orphanCalls: 0,
  exists: new Set<string>(),
  thumbCalls: [] as string[][],
  inFlight: 0,
  maxInFlight: 0,
  thumbGate: null as null | Promise<void>,
  navigations: [] as unknown[],
  menus: [] as Array<{ activateFirst: boolean | undefined }>,
  errors: [] as string[],
  refusals: [] as string[],
  picks: [] as string[],
}));

vi.mock("../core/ipc", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  mediaUrl: (p: string) => `asset://${p}`,
  onDragDrop: async () => () => {},
  pickOpenFiles: async () => m.picks.slice(),
  ipc: {
    listRecents: () => {
      m.listCalls++;
      return m.recents ? m.recents() : Promise.resolve({ schema: 1, items: [] });
    },
    refreshRecentThumbs: async (paths: string[]) => {
      m.thumbCalls.push(paths);
      m.inFlight++;
      m.maxInFlight = Math.max(m.maxInFlight, m.inFlight);
      try {
        await (m.thumbGate ?? Promise.resolve());
        await new Promise((r) => setTimeout(r, 1));
      } finally {
        m.inFlight--;
      }
      return {};
    },
    listOrphanTempProjects: async () => {
      m.orphanCalls++;
      return m.orphans.slice();
    },
    pathExists: async (p: string) => m.exists.has(p),
    tempProjectsDir: async () => "C:\\Users\\u\\AppData\\Local\\Taroting\\tmp-projects",
  },
}));
vi.mock("../core/nav", () => ({ navigate: (r: unknown) => void m.navigations.push(r) }));
vi.mock("../ui/menu", () => ({
  showMenu: (_x: number, _y: number, _items: unknown, _flip?: number, activateFirst?: boolean) =>
    void m.menus.push({ activateFirst }),
  closeMenu: () => {},
}));
vi.mock("../ui/toast", () => ({
  toast: {
    error: (s: string) => void m.errors.push(s),
    info: () => {},
    refuse: (s: string) => void m.refusals.push(s),
  },
}));

/* ---------------- the stub DOM ---------------- */

type Handler = (e: unknown) => void;

class Stub {
  readonly sel: string;
  private listeners = new Map<string, Set<Handler>>();
  hidden = false;
  disabled = false;
  value = "";
  innerHTML = "";
  dataset: Record<string, string> = {};
  focusCalls = 0;
  classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  constructor(sel: string) {
    this.sel = sel;
  }
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
  focus(): void {
    this.focusCalls++;
    doc.activeElement = this;
  }
  select(): void {}
  setAttribute(): void {}
  removeAttribute(): void {}
  getBoundingClientRect() {
    return { left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20 };
  }
  /** Home looks up cards by data-path only to repaint them; no card exists here. */
  querySelector(_sel: string): Stub | null {
    return null;
  }
}

class Root extends Stub {
  private stubs = new Map<string, Stub>();
  override querySelector(sel: string): Stub {
    if (!this.stubs.has(sel)) this.stubs.set(sel, new Stub(sel));
    return this.stubs.get(sel)!;
  }
  el(sel: string): Stub {
    return this.querySelector(sel);
  }
}

const docListeners = new Map<string, Set<Handler>>();
const doc = {
  activeElement: null as unknown,
  /** What document.querySelector finds: set to simulate an open dialog. */
  present: new Set<string>(),
  /** Elements document.querySelector hands back as real nodes, checked first:
   *  the menu host, whose `style.display` says whether a menu is showing. */
  nodes: new Map<string, object>(),
  body: new Stub("body"),
  addEventListener(t: string, fn: Handler): void {
    if (!docListeners.has(t)) docListeners.set(t, new Set());
    docListeners.get(t)!.add(fn);
  },
  removeEventListener(t: string, fn: Handler): void {
    docListeners.get(t)?.delete(fn);
  },
  querySelector(sel: string): object | null {
    const node = doc.nodes.get(sel.trim());
    if (node) return node;
    return sel.split(",").some((s) => doc.present.has(s.trim())) ? {} : null;
  },
};
function fireDoc(t: string, e: unknown): void {
  for (const fn of [...(docListeners.get(t) ?? [])]) fn(e);
}

vi.stubGlobal("document", doc);
vi.stubGlobal("window", globalThis);
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("CSS", { escape: (s: string) => s });
vi.stubGlobal("requestIdleCallback", (cb: () => void) => setTimeout(cb, 0));

const { mountHome } = await import("./home");
const { runOnOpenChain } = await import("../core/open-media");

/* ---------------- helpers ---------------- */

const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};

function item(i: number, extra: Partial<RecentItem> = {}): RecentItem {
  return {
    path: `C:\\Docs\\Taroting\\Cut ${i}.trt`,
    name: `Cut ${i}`,
    modifiedAt: "2026-09-01T10:00:00Z",
    durationSec: 10 + i,
    thumb: null,
    sizeBytes: 1000 + i,
    ...extra,
  };
}

function keyEvent(over: Record<string, unknown>) {
  const e = {
    key: "",
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    ...over,
  };
  return e;
}

/** A grid event target whose `closest` answers from a selector → element map. */
function target(map: Record<string, object>) {
  return { closest: (sel: string) => map[sel] ?? null };
}

let mounted: Array<{ dispose(): void }> = [];
function mount(): Root {
  const root = new Root("root");
  mounted.push(mountHome(root as unknown as HTMLElement));
  return root;
}

beforeEach(() => {
  m.recents = null;
  m.listCalls = 0;
  m.orphans = [];
  m.orphanCalls = 0;
  m.exists.clear();
  m.thumbCalls = [];
  m.inFlight = 0;
  m.maxInFlight = 0;
  m.thumbGate = null;
  m.navigations = [];
  m.menus = [];
  m.errors = [];
  m.refusals = [];
  m.picks = [];
  doc.activeElement = null;
  doc.present.clear();
  doc.nodes.clear();
});
afterEach(() => {
  for (const v of mounted.splice(0)) v.dispose();
});

/* ---------------- tests ---------------- */

describe("Home's search field", () => {
  it("is not focused on mount, so the first keypress of a launch is not eaten", async () => {
    const root = mount();
    await flush();
    expect(root.el("#home-search").focusCalls).toBe(0);
    expect(doc.activeElement).not.toBe(root.el("#home-search"));
  });

  it("is reached with Ctrl+F, also on a non-Latin layout, but not over a dialog", async () => {
    const root = mount();
    await flush();
    const search = root.el("#home-search");
    const plain = keyEvent({ key: "f", code: "KeyF", ctrlKey: true });
    fireDoc("keydown", plain);
    expect(search.focusCalls).toBe(1);
    expect(plain.defaultPrevented).toBe(true);
    // Hebrew layout: the key types "כ", its position is still KeyF.
    fireDoc("keydown", keyEvent({ key: "כ", code: "KeyF", ctrlKey: true }));
    expect(search.focusCalls).toBe(2);
    // A plain "f" is typing, not the shortcut.
    fireDoc("keydown", keyEvent({ key: "f", code: "KeyF" }));
    expect(search.focusCalls).toBe(2);
    // Over a dialog the keys are the dialog's.
    doc.present.add(".modal-backdrop");
    const over = keyEvent({ key: "f", code: "KeyF", ctrlKey: true });
    fireDoc("keydown", over);
    expect(search.focusCalls).toBe(2);
    expect(over.defaultPrevented).toBe(false);
  });

  it("is still reached with Ctrl+F after a menu has been opened and closed", async () => {
    const root = mount();
    await flush();
    const search = root.el("#home-search");
    // ui/menu.ts creates its host once and only hides it on close: after the
    // first menu of a session it stays on <body> for good.
    const host = { className: "ctx-menu", style: { display: "none" } };
    doc.nodes.set(".ctx-menu", host);
    const after = keyEvent({ key: "f", code: "KeyF", ctrlKey: true });
    fireDoc("keydown", after);
    expect(search.focusCalls).toBe(1);
    expect(after.defaultPrevented).toBe(true);
    // While a menu is SHOWING, its keys are its own.
    host.style.display = "block";
    const open = keyEvent({ key: "f", code: "KeyF", ctrlKey: true });
    fireDoc("keydown", open);
    expect(search.focusCalls).toBe(1);
    expect(open.defaultPrevented).toBe(false);
  });
});

describe("refreshes that answer out of order", () => {
  it("paint only the newest one's list, and no stale error", async () => {
    const answers: Array<{ resolve: (v: RecentsIndex) => void; reject: (e: unknown) => void }> = [];
    m.recents = () =>
      new Promise<RecentsIndex>((resolve, reject) => void answers.push({ resolve, reject }));
    const root = mount();
    await flush();
    expect(answers).toHaveLength(1);
    const grid = root.el("#recents");
    // A second refresh while the mount's read is still out (the retry button
    // stands in for any mutation's refresh: they all call the same function).
    grid.fire("click", { target: target({ '[data-act="retry-recents"]': {} }) });
    await flush();
    expect(answers).toHaveLength(2);
    // The newer read answers first, after the card "Cut 1" was removed...
    answers[1]!.resolve({ schema: 1, items: [item(2)] });
    await flush();
    expect(grid.innerHTML).toContain("Cut 2");
    expect(grid.innerHTML).not.toContain("Cut 1");
    // ...then the older one lands with the list from before the removal.
    answers[0]!.resolve({ schema: 1, items: [item(1), item(2)] });
    await flush();
    expect(grid.innerHTML).toContain("Cut 2");
    expect(grid.innerHTML).not.toContain("Cut 1");

    // A stale FAILURE is dropped the same way: no toast, no "couldn't read".
    grid.fire("click", { target: target({ '[data-act="retry-recents"]': {} }) });
    grid.fire("click", { target: target({ '[data-act="retry-recents"]': {} }) });
    await flush();
    expect(answers).toHaveLength(4);
    answers[3]!.resolve({ schema: 1, items: [item(3)] });
    answers[2]!.reject(new Error("share went to sleep"));
    await flush();
    expect(m.errors).toEqual([]);
    expect(grid.innerHTML).toContain("Cut 3");
    expect(grid.innerHTML).not.toContain("Couldn't read");
  });
});

describe("an unreadable recents list", () => {
  it("says so with a way to try again, never 'No projects yet', and keeps Select hidden", async () => {
    m.recents = () => Promise.reject(new Error("recents.json is locked"));
    const root = mount();
    await flush();
    const grid = root.el("#recents");
    expect(grid.innerHTML).toContain("Couldn't read your recent projects.");
    expect(grid.innerHTML).toContain('data-act="retry-recents"');
    expect(grid.innerHTML).not.toContain("No projects yet.");
    expect(root.el("#btn-select").hidden).toBe(true);
    expect(m.errors).toEqual(["Couldn't read recent projects: recents.json is locked"]);

    // Try again reads the list again, and an empty answer is then "No projects yet".
    m.recents = () => Promise.resolve({ schema: 1, items: [] });
    grid.fire("click", { target: target({ '[data-act="retry-recents"]': {} }) });
    await flush();
    expect(m.listCalls).toBe(2);
    expect(grid.innerHTML).toContain("No projects yet.");
    expect(grid.innerHTML).not.toContain("Couldn't read");
  });

  it("also treats an answer flagged unreadable with nothing in it as couldn't-read", async () => {
    m.recents = () => Promise.resolve({ schema: 1, items: [], unreadable: true } as RecentsIndex);
    const root = mount();
    await flush();
    expect(root.el("#recents").innerHTML).toContain("Couldn't read your recent projects.");
  });
});

describe("thumbnail backfill", () => {
  it("keeps one batch in flight at a time, in card order, skipping image projects", async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i));
    items[4] = item(4, { kind: "image" });
    items[6] = item(6, { thumb: "C:\\cache\\t6.jpg" });
    m.recents = () => Promise.resolve({ schema: 1, items });
    mount();
    await flush(20);
    expect(m.thumbCalls.map((b) => b.map((p) => p.match(/Cut (\d+)/)![1]).join(","))).toEqual([
      "0,1,2,3",
      "5,7,8,9",
    ]);
    expect(m.maxInFlight).toBe(1);
  });

  it("waits for an open already on the open chain before the first batch", async () => {
    m.recents = () => Promise.resolve({ schema: 1, items: [item(1), item(2)] });
    let release!: () => void;
    const opening = runOnOpenChain(() => new Promise<void>((r) => (release = r)));
    mount();
    await flush(8);
    expect(m.thumbCalls).toEqual([]);
    expect(m.orphanCalls).toBe(0);
    release();
    await opening;
    await flush(8);
    expect(m.thumbCalls.length).toBe(1);
    expect(m.orphanCalls).toBe(1);
  });

  it("stops between batches once Home is gone", async () => {
    m.recents = () => Promise.resolve({ schema: 1, items: Array.from({ length: 12 }, (_, i) => item(i)) });
    let open!: () => void;
    m.thumbGate = new Promise<void>((r) => (open = r));
    mount();
    await flush(8);
    expect(m.thumbCalls.length).toBe(1);
    mounted.splice(0).forEach((v) => v.dispose());
    open();
    await flush(10);
    expect(m.thumbCalls.length).toBe(1);
  });
});

describe("Recover lines for orphaned temporary projects", () => {
  const A = "C:\\Users\\u\\AppData\\Local\\Taroting\\tmp-projects\\Holiday.trt";
  const B = "C:\\Users\\u\\AppData\\Local\\Taroting\\tmp-projects\\Screen 2.trt";

  it("shows nothing when there are none", async () => {
    const root = mount();
    await flush();
    expect(m.orphanCalls).toBe(1);
    expect(root.el("#home-recover").hidden).toBe(true);
    expect(root.el("#home-recover").innerHTML).toBe("");
  });

  it("lists each one and reopens the chosen one as a TEMPORARY project", async () => {
    m.orphans = [A, B];
    m.exists.add(B);
    const root = mount();
    // The stub starts visible; Home must hide it until there is something to show.
    root.el("#home-recover").hidden = true;
    await flush();
    const rec = root.el("#home-recover");
    expect(rec.hidden).toBe(false);
    expect(rec.innerHTML).toContain("<strong>Holiday</strong>");
    expect(rec.innerHTML).toContain("<strong>Screen 2</strong>");
    rec.fire("click", { target: target({ "[data-recover]": { dataset: { recover: "1" } } }) });
    await flush();
    expect(m.navigations).toEqual([{ view: "editor", projectPath: B, temp: true }]);
  });

  it("reopens one whose crash left only its .bak, which the load recovers from", async () => {
    // Death between atomic_write's two renames: the primary went to .bak, the
    // staged .tmp never came in (and the sweep removed it). The store still
    // offers the .trt path, and load_project reads the .bak.
    m.orphans = [A, B];
    m.exists.add(`${A}.bak`);
    m.exists.add(B);
    const root = mount();
    await flush();
    root.el("#home-recover").fire("click", { target: target({ "[data-recover]": { dataset: { recover: "0" } } }) });
    await flush();
    expect(m.errors).toEqual([]);
    expect(m.navigations).toEqual([{ view: "editor", projectPath: A, temp: true }]);
  });

  it("says a vanished one is gone and lists again instead of opening anything", async () => {
    m.orphans = [A];
    const root = mount();
    await flush();
    m.orphans = [];
    root.el("#home-recover").fire("click", { target: target({ "[data-recover]": { dataset: { recover: "0" } } }) });
    await flush();
    expect(m.navigations).toEqual([]);
    expect(m.errors).toEqual(["Temporary project not found"]);
    expect(m.orphanCalls).toBe(2);
    expect(root.el("#home-recover").hidden).toBe(true);
  });
});

describe("Open's refusals", () => {
  it("decline unsupported files as a refusal, which Diagnostics never records", async () => {
    m.picks = ["C:\\Users\\u\\notes.txt", "C:\\Users\\u\\sheet.xlsx"];
    const root = mount();
    await flush();
    root.el("#btn-open").fire("click", {});
    await flush();
    expect(m.refusals).toEqual(["None of these 2 files is a supported type."]);
    expect(m.errors).toEqual([]);
  });
});

describe("the recents grid's keyboard", () => {
  const P = "C:\\Docs\\Taroting\\Cut 1.trt";

  it("Enter on a card's More button leaves the opening to the button's own click", async () => {
    m.recents = () => Promise.resolve({ schema: 1, items: [item(1)] });
    m.exists.add(P);
    const root = mount();
    await flush();
    const grid = root.el("#recents");
    const card = { dataset: { path: P } };
    const more = { dataset: { more: P }, getBoundingClientRect: () => ({ left: 1, bottom: 2, top: 0 }) };
    const onMore = keyEvent({ key: "Enter", target: target({ ".project-card": card, "[data-more]": more }) });
    grid.fire("keydown", onMore);
    await flush();
    expect(m.navigations).toEqual([]);
    expect(onMore.defaultPrevented).toBe(false);
    // The click the engine makes of that Enter (detail 0) opens the menu on its first row.
    grid.fire("click", { target: target({ ".project-card": card, "[data-more]": more }), detail: 0, stopPropagation() {} });
    expect(m.menus).toEqual([{ activateFirst: true }]);
    // A mouse click does not.
    grid.fire("click", { target: target({ ".project-card": card, "[data-more]": more }), detail: 1, stopPropagation() {} });
    expect(m.menus.at(-1)).toEqual({ activateFirst: false });

    // Enter on the card itself still opens it.
    grid.fire("keydown", keyEvent({ key: "Enter", target: target({ ".project-card": card }) }));
    await flush();
    expect(m.navigations).toEqual([{ view: "editor", projectPath: P }]);
  });
});

describe("opening a recents card", () => {
  const P = "C:\Docs\Taroting\Cut 1.trt";
  const Q = "C:\Docs\Taroting\Cut 2.trt";

  it("opens one whose .trt is gone but whose .bak survives, as the list promises", async () => {
    m.recents = () => Promise.resolve({ schema: 1, items: [item(1), item(2)] });
    // Only the backup of Cut 1 is on disk; Cut 2 has its primary. A bare
    // `${P}.bak` must not satisfy a check for Q, nor Q's file one for P.
    m.exists.add(`${P}.bak`);
    m.exists.add(Q);
    const root = mount();
    await flush();
    root.el("#recents").fire("keydown", keyEvent({ key: "Enter", target: target({ ".project-card": { dataset: { path: P } } }) }));
    await flush();
    expect(m.errors).toEqual([]);
    expect(m.navigations).toEqual([{ view: "editor", projectPath: P }]);
  });

  it("still says not found when neither the .trt nor its .bak exists", async () => {
    m.recents = () => Promise.resolve({ schema: 1, items: [item(1)] });
    m.exists.add(`${P}.tmp`);
    const root = mount();
    await flush();
    const before = m.listCalls;
    root.el("#recents").fire("keydown", keyEvent({ key: "Enter", target: target({ ".project-card": { dataset: { path: P } } }) }));
    await flush();
    expect(m.navigations).toEqual([]);
    expect(m.errors).toEqual(["Project file not found"]);
    expect(m.listCalls).toBe(before + 1);
  });
});
