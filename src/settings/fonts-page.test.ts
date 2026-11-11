import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontFamilyInfo, FontImportResult } from "../core/types";
import { El, body, doc, docListenerCount, fakeWindow, flush, focusState, pressKey, until } from "./markup-dom.test-util";

// The Fonts page (fonts-page.ts) against the markup fake DOM and a fake font
// runtime. The fixture families DIFFER on every axis the sorts read: name
// order, date-added order and size order are three different orders, so a
// sort wired to the wrong field (or the wrong direction) puts the rows in an
// order the test does not expect.

const f = vi.hoisted(() => ({
  library: [] as FontFamilyInfo[],
  catalogCalls: 0,
  picks: [] as string[],
  importCalls: [] as Array<{ paths: string[]; replace: boolean | undefined }>,
  importImpl: (paths: string[], _replace: boolean | undefined): FontImportResult[] =>
    paths.map((path) => ({ path, ok: true })),
  removeCalls: [] as string[],
  removeFails: new Set<string>(),
  listeners: new Set<() => void>(),
  ensureCalls: [] as string[],
  ready: new Set<string>(),
  missing: new Set<string>(),
  toasts: [] as Array<{ kind: string; message: string }>,
  navigations: [] as unknown[],
  observers: [] as Array<{ observed: Set<unknown>; cb: (e: unknown[]) => void; disconnected: boolean }>,
}));

vi.mock("../fonts", () => ({
  fontCatalog: async () => {
    f.catalogCalls++;
    return { library: f.library.map((x) => ({ ...x })), installed: [] };
  },
  importFonts: async (paths: string[], replace?: boolean) => {
    f.importCalls.push({ paths: [...paths], replace });
    return f.importImpl(paths, replace);
  },
  removeFont: async (id: string) => {
    f.removeCalls.push(id);
    if (f.removeFails.has(id)) throw new Error("locked");
    f.library = f.library.filter((x) => x.id !== id);
  },
  onFontsChanged: (cb: () => void) => {
    f.listeners.add(cb);
    return () => void f.listeners.delete(cb);
  },
  ensureFonts: async (reqs: Array<{ id: string }>) => {
    for (const r of reqs) {
      f.ensureCalls.push(r.id);
      f.ready.add(r.id);
    }
  },
  fontsReady: (reqs: Array<{ id: string }>) => reqs.every((r) => f.ready.has(r.id)),
  fontFace: (legacy: string, id: string) =>
    f.missing.has(id)
      ? { family: legacy, bold: false, italic: false, missing: true }
      : { family: `tfont-${id.replace(/[^a-z0-9]/gi, "")}`, bold: false, italic: false, missing: false },
}));
vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return { ...real, pickFontFiles: async () => [...f.picks] };
});
vi.mock("../core/nav", () => ({ navigate: (route: unknown) => void f.navigations.push(route) }));
vi.mock("../ui/icons", () => ({ icon: () => "" }));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (message: string) => void f.toasts.push({ kind: "info", message }),
    error: (message: string) => void f.toasts.push({ kind: "error", message }),
  },
}));

class FakeObserver {
  rec: { observed: Set<unknown>; cb: (e: unknown[]) => void; disconnected: boolean };
  constructor(cb: (e: unknown[]) => void) {
    this.rec = { observed: new Set(), cb, disconnected: false };
    f.observers.push(this.rec);
  }
  observe(el: unknown): void {
    this.rec.observed.add(el);
  }
  unobserve(el: unknown): void {
    this.rec.observed.delete(el);
  }
  disconnect(): void {
    this.rec.observed.clear();
    this.rec.disconnected = true;
  }
}

vi.stubGlobal("document", doc);
vi.stubGlobal("window", fakeWindow);
vi.stubGlobal("IntersectionObserver", FakeObserver);

const page = await import("./fonts-page");
const { mountFontsPage, sortFamilies, filterFamilies, removeLabel } = page;

/* ---------------- fixtures ---------------- */

const face = (style: string, bold = false, italic = false) => ({
  bold,
  italic,
  weight: bold ? 700 : 400,
  style,
  embed: "full" as const,
});
const lib = (name: string, addedMs: number, bytes: number, faces = [face("Regular")]): FontFamilyInfo => ({
  id: `lib:${name}`,
  name,
  source: "library",
  faces,
  addedMs,
  bytes,
});
// name:   Alpha Sans, beta Mono, Delta, Gamma 10   (lower-case b: case ignored)
// date:   Gamma 10 (5000) > Alpha (3000) > Delta (2000) > beta (1000)
// size:   beta (900) > Gamma (500) > Delta (300) > Alpha (100)
const ALPHA = lib("Alpha Sans", 3000, 100, [face("Regular"), face("Bold", true)]);
const BETA = lib("beta Mono", 1000, 900);
const DELTA = lib("Delta", 2000, 300);
const GAMMA = lib("Gamma 10", 5000, 500);
const FOUR = [GAMMA, BETA, ALPHA, DELTA]; // the catalogue's own order is none of the sorts

/* ---------------- helpers ---------------- */

let root: El;
let view: { dispose(): void } | null = null;
let docBaseline = 0;

async function mount(): Promise<void> {
  root = new El("div");
  body.appendChild(root);
  view = mountFontsPage(root as unknown as HTMLElement);
  await until(() => f.catalogCalls > 0 && f.listeners.size === 1, "the catalogue and the subscription");
  await flush();
}

const q = (sel: string): El => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
const names = (): string[] => root.querySelectorAll(".fontlib__name").map((e) => e.textContent);
const rowOf = (name: string): El => root.querySelectorAll("[data-font]").find((r) => r.getAttribute("data-font") === `lib:${name}`)!;
const removeOf = (name: string): El => rowOf(name).querySelector("[data-font-remove]")!;
const backdrops = (): El[] => body.children.filter((c) => c.className === "modal-backdrop");
const emptyText = (): string => root.querySelector(".fontlib__empty")?.textContent.replace(/\s+/g, " ").trim() ?? "";
function typeSearch(text: string): void {
  const s = q("#fontlib-search");
  s.value = text;
  s.fire("input");
}
function chooseSort(v: string): void {
  const s = q("#fontlib-sort");
  s.value = v;
  s.fire("change");
}

beforeEach(() => {
  f.library = FOUR.map((x) => ({ ...x }));
  f.catalogCalls = 0;
  f.picks = [];
  f.importCalls.length = 0;
  f.importImpl = (paths) => paths.map((path) => ({ path, ok: true }));
  f.removeCalls.length = 0;
  f.removeFails.clear();
  f.listeners.clear();
  f.ensureCalls.length = 0;
  f.ready.clear();
  f.missing.clear();
  f.toasts.length = 0;
  f.navigations.length = 0;
  f.observers.length = 0;
  focusState.el = null;
  docBaseline = docListenerCount();
});

afterEach(() => {
  view?.dispose();
  view = null;
  for (const c of [...body.children]) c.remove();
});

/* ---------------- pure helpers ---------------- */

describe("sortFamilies", () => {
  const n = (list: FontFamilyInfo[]): string[] => list.map((x) => x.name);
  it.each([
    ["name", ["Alpha Sans", "beta Mono", "Delta", "Gamma 10"]],
    ["nameDesc", ["Gamma 10", "Delta", "beta Mono", "Alpha Sans"]],
    ["newest", ["Gamma 10", "Alpha Sans", "Delta", "beta Mono"]],
    ["oldest", ["beta Mono", "Delta", "Alpha Sans", "Gamma 10"]],
    ["largest", ["beta Mono", "Gamma 10", "Delta", "Alpha Sans"]],
    ["smallest", ["Alpha Sans", "Delta", "Gamma 10", "beta Mono"]],
  ] as const)("%s", (key, order) => {
    expect(n(sortFamilies(FOUR, key))).toEqual(order);
  });

  it("orders numbers by value and never mutates its input", () => {
    const list = [lib("Font 10", 1, 1), lib("Font 9", 1, 1)];
    expect(n(sortFamilies(list, "name"))).toEqual(["Font 9", "Font 10"]);
    expect(n(list)).toEqual(["Font 10", "Font 9"]);
  });
});

describe("filterFamilies and labels", () => {
  it("matches a substring of the name, case ignored, trimmed", () => {
    expect(filterFamilies(FOUR, "  MONO ").map((x) => x.name)).toEqual(["beta Mono"]);
    expect(filterFamilies(FOUR, "a").map((x) => x.name)).toEqual(["Gamma 10", "beta Mono", "Alpha Sans", "Delta"]);
    expect(filterFamilies(FOUR, "")).toHaveLength(4);
  });
  it("labels the select bar's action", () => {
    expect([removeLabel(0), removeLabel(1), removeLabel(3)]).toEqual(["Remove fonts", "Remove 1 font", "Remove 3 fonts"]);
  });
});

/* ---------------- the page ---------------- */

describe("the list", () => {
  it("shows every family in name order with its sample and meta line", async () => {
    await mount();
    expect(names()).toEqual(["Alpha Sans", "beta Mono", "Delta", "Gamma 10"]);
    const alpha = rowOf("Alpha Sans");
    expect(alpha.querySelector(".fontlib__sample")!.textContent).toBe("The quick brown fox jumps over the lazy dog");
    const meta = alpha.querySelector(".fontlib__meta")!.textContent;
    expect(meta.startsWith("Regular, Bold · Added ")).toBe(true);
    expect(meta.endsWith(" · 100 B")).toBe(true);
    expect(removeOf("Alpha Sans").getAttribute("aria-label")).toBe("Remove Alpha Sans");
    expect(q("#fontlib-toolbar").hidden).toBe(false);
  });

  it.each([
    ["nameDesc", ["Gamma 10", "Delta", "beta Mono", "Alpha Sans"]],
    ["newest", ["Gamma 10", "Alpha Sans", "Delta", "beta Mono"]],
    ["oldest", ["beta Mono", "Delta", "Alpha Sans", "Gamma 10"]],
    ["largest", ["beta Mono", "Gamma 10", "Delta", "Alpha Sans"]],
    ["smallest", ["Alpha Sans", "Delta", "Gamma 10", "beta Mono"]],
    ["name", ["Alpha Sans", "beta Mono", "Delta", "Gamma 10"]],
  ])("sorts by %s, and remembers it for the session", async (key, order) => {
    await mount();
    chooseSort(key);
    expect(names()).toEqual(order);
    view!.dispose();
    for (const c of [...body.children]) c.remove();
    f.catalogCalls = 0;
    f.listeners.clear();
    await mount();
    expect(q("#fontlib-sort").value).toBe(key);
    expect(names()).toEqual(order);
  });

  it("filters by search and says when nothing matches", async () => {
    await mount();
    typeSearch("mono");
    expect(names()).toEqual(["beta Mono"]);
    typeSearch("zzz");
    expect(names()).toEqual([]);
    expect(emptyText()).toBe('No fonts match "zzz"');
    typeSearch("");
    expect(names()).toHaveLength(4);
  });

  it("shows the empty state with an Import button when the library is empty", async () => {
    f.library = [];
    await mount();
    expect(emptyText()).toBe("No fonts imported yet. Import fonts");
    expect(q("#fontlib-empty-import").textContent).toBe("Import fonts");
    expect(q("#fontlib-toolbar").hidden).toBe(true);
  });
});

describe("previews", () => {
  it("loads a family's face only when its row nears the viewport, and draws the sample in it", async () => {
    f.missing.add("lib:beta Mono");
    await mount();
    const obs = f.observers.at(-1)!;
    expect(obs.observed.size).toBe(4);
    expect(f.ensureCalls).toEqual([]); // nothing loaded until a row is near
    const sample = (name: string): El => rowOf(name).querySelector("[data-sample]")!;
    obs.cb([{ isIntersecting: true, target: sample("Delta") }, { isIntersecting: false, target: sample("Gamma 10") }]);
    await flush();
    expect(f.ensureCalls).toEqual(["lib:Delta"]);
    expect(sample("Delta").style.fontFamily).toBe("tfont-libDelta, var(--font-ui)");
    expect(sample("Gamma 10").style.fontFamily).toBeUndefined();
    // A face that cannot load leaves the UI font.
    obs.cb([{ isIntersecting: true, target: sample("beta Mono") }]);
    await flush();
    expect(sample("beta Mono").style.fontFamily).toBeUndefined();
    // A re-render styles an already-loaded family at once, without observing it.
    typeSearch("e");
    expect(sample("Delta").style.fontFamily).toBe("tfont-libDelta, var(--font-ui)");
    expect([...f.observers.at(-1)!.observed]).not.toContain(sample("Delta"));
  });
});

describe("remove one", () => {
  it("asks first; Escape keeps it and returns focus; confirm removes it and focus moves to the next row", async () => {
    await mount();
    removeOf("Delta").focus();
    removeOf("Delta").click();
    await flush();
    expect(backdrops()).toHaveLength(1);
    const dlg = backdrops()[0]!;
    expect(dlg.querySelector(".modal__header")!.textContent).toBe("Remove Delta?");
    expect(dlg.querySelector(".modal__text")!.textContent).toBe(
      "Projects that use it show Segoe UI until you import it again. The file you imported it from is not touched.",
    );
    expect(doc.activeElement).toBe(dlg.querySelector("[data-cancel]"));
    pressKey("Escape");
    await flush();
    expect(backdrops()).toHaveLength(0);
    expect(f.removeCalls).toEqual([]);
    expect(f.navigations).toEqual([]); // the dialog's Escape is not the page's
    expect(doc.activeElement).toBe(removeOf("Delta"));

    removeOf("Delta").click();
    await flush();
    backdrops()[0]!.querySelector("[data-confirm]")!.click();
    await until(() => !names().includes("Delta"), "the list without Delta");
    expect(f.removeCalls).toEqual(["lib:Delta"]);
    expect(names()).toEqual(["Alpha Sans", "beta Mono", "Gamma 10"]);
    expect(doc.activeElement).toBe(removeOf("Gamma 10"));
  });

  it("removing the last font shows the empty state and focuses its Import button", async () => {
    f.library = [{ ...DELTA }];
    await mount();
    removeOf("Delta").click();
    await flush();
    backdrops()[0]!.querySelector("[data-confirm]")!.click();
    await until(() => emptyText().startsWith("No fonts imported yet."), "the empty state");
    expect(doc.activeElement).toBe(q("#fontlib-empty-import"));
  });

  it("says so when a removal fails, and keeps the row", async () => {
    f.removeFails.add("lib:Delta");
    await mount();
    removeOf("Delta").click();
    await flush();
    backdrops()[0]!.querySelector("[data-confirm]")!.click();
    await until(() => f.toasts.length > 0, "the error toast");
    expect(f.toasts).toEqual([{ kind: "error", message: "Couldn't remove Delta." }]);
    await flush();
    expect(names()).toContain("Delta");
    expect(removeOf("Delta").disabled).toBe(false);
  });
});

describe("select mode", () => {
  it("removes many: toggles rows, labels the action, confirms by count, then leaves select mode", async () => {
    await mount();
    q("#fontlib-select").click();
    expect(q("#fontlib-select-bar").hidden).toBe(false);
    expect(root.querySelectorAll("[data-font-remove]")).toHaveLength(0);
    expect(q("#fontlib-select-remove").disabled).toBe(true);
    rowOf("Alpha Sans").click();
    rowOf("Gamma 10").click();
    rowOf("Delta").click();
    pressKey("Enter", { target: rowOf("Delta") }); // Enter toggles Delta back off
    expect(q("#fontlib-select-count").textContent).toBe("2 selected");
    expect(q("#fontlib-select-remove").textContent).toBe("Remove 2 fonts");
    expect(rowOf("Alpha Sans").getAttribute("aria-checked")).toBe("true");
    expect(rowOf("Delta").getAttribute("aria-checked")).toBe("false");
    q("#fontlib-select-remove").click();
    await flush();
    const dlg = backdrops()[0]!;
    expect(dlg.querySelector(".modal__header")!.textContent).toBe("Remove 2 fonts?");
    expect(dlg.querySelector(".modal__text")!.textContent).toBe(
      "Projects that use them show Segoe UI until you import them again. The files you imported them from are not touched.",
    );
    expect(doc.activeElement).toBe(dlg.querySelector("[data-cancel]"));
    dlg.querySelector("[data-confirm]")!.click();
    await until(() => names().length === 2, "the two rows left");
    expect([...f.removeCalls].sort()).toEqual(["lib:Alpha Sans", "lib:Gamma 10"]);
    expect(names()).toEqual(["beta Mono", "Delta"]);
    expect(q("#fontlib-select-bar").hidden).toBe(true);
    // Alpha was the first row: focus lands on the row now first.
    expect(doc.activeElement).toBe(removeOf("beta Mono"));
  });

  it("Select all takes the rows the search shows; Escape leaves select mode before it goes back", async () => {
    await mount();
    typeSearch("a"); // all four contain an "a"
    typeSearch("delta");
    q("#fontlib-select").click();
    q("#fontlib-select-all").click();
    expect(q("#fontlib-select-count").textContent).toBe("1 selected");
    pressKey("Escape");
    expect(q("#fontlib-select-bar").hidden).toBe(true);
    expect(f.navigations).toEqual([]);
    pressKey("Escape"); // clears the search
    expect(q("#fontlib-search").value).toBe("");
    expect(names()).toHaveLength(4);
    expect(f.navigations).toEqual([]);
    pressKey("Escape"); // now goes back
    expect(f.navigations).toEqual([{ view: "settings" }]);
  });
});

describe("navigation and import", () => {
  it("Back goes to Settings", async () => {
    await mount();
    q("#fontlib-back").click();
    expect(f.navigations).toEqual([{ view: "settings" }]);
  });

  it("Ctrl+F focuses the search field", async () => {
    await mount();
    expect(pressKey("f", { ctrlKey: true, code: "KeyF" })).toBe(true);
    expect(doc.activeElement).toBe(q("#fontlib-search"));
  });

  it("leaves Ctrl+F alone while a dialog is up", async () => {
    await mount();
    removeOf("Delta").click();
    await flush();
    const cancel = backdrops()[0]!.querySelector("[data-cancel]");
    expect(doc.activeElement).toBe(cancel);
    expect(pressKey("f", { ctrlKey: true, code: "KeyF" })).toBe(false);
    expect(doc.activeElement).toBe(cancel);
  });

  it("imports from the header, lists the new family and shows failures", async () => {
    f.library = [];
    await mount();
    f.picks = ["C:\\x\\Zeta.ttf", "C:\\x\\bad.woff"];
    f.importImpl = (paths) => {
      f.library = [lib("Zeta", 9000, 42)];
      return paths.map((path) =>
        path.endsWith(".ttf") ? { path, ok: true, id: "lib:Zeta" } : { path, ok: false, error: "extension" as const },
      );
    };
    q("#fontlib-import").click();
    await until(() => names().length === 1, "the imported family");
    expect(names()).toEqual(["Zeta"]);
    expect(root.querySelectorAll(".settings__font-error").map((e) => e.textContent)).toEqual([
      "bad.woff isn't a .ttf or .otf file.",
    ]);
    expect(f.importCalls).toEqual([{ paths: ["C:\\x\\Zeta.ttf", "C:\\x\\bad.woff"], replace: undefined }]);
  });

  it("follows a change made elsewhere", async () => {
    await mount();
    f.library = [...f.library, lib("Epsilon", 7000, 7)];
    for (const cb of f.listeners) cb();
    await until(() => names().includes("Epsilon"), "the new family");
  });
});

describe("dispose", () => {
  it("leaves no listener, observer, subscription or dialog behind", async () => {
    await mount();
    const els = [
      "#fontlib-back",
      "#fontlib-import",
      "#fontlib-search",
      "#fontlib-sort",
      "#fontlib-select",
      "#fontlib-select-remove",
      "#fontlib-select-all",
      "#fontlib-select-cancel",
      "#fontlib-list",
    ].map(q);
    expect(els.every((e) => e.listenerCount() > 0)).toBe(true);
    expect(docListenerCount()).toBeGreaterThan(docBaseline);
    removeOf("Delta").click();
    await flush();
    expect(backdrops()).toHaveLength(1);
    view!.dispose();
    view = null;
    await flush();
    expect(els.map((e) => e.listenerCount())).toEqual(els.map(() => 0));
    expect(docListenerCount()).toBe(docBaseline);
    expect(f.listeners.size).toBe(0);
    expect(f.observers.every((o) => o.disconnected && o.observed.size === 0)).toBe(true);
    expect(backdrops()).toHaveLength(0);
    expect(f.removeCalls).toEqual([]);
    // A notification after teardown does nothing (and throws nothing).
    expect(() => pressKey("Escape")).not.toThrow();
    expect(f.navigations).toEqual([]);
  });
});
