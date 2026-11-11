import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontCatalog, FontImportResult, FontRequest, ResolvedFont } from "../core/types";

// The font runtime against a fake FontFace / document.fonts and a fake IPC.
// Each test gets a fresh module (the runtime holds its state in the module).

const ipcMock = vi.hoisted(() => ({
  fontsResolve: vi.fn(),
  fontsList: vi.fn(),
  fontsImport: vi.fn(),
  fontsRemove: vi.fn(),
}));
vi.mock("../core/ipc", () => ({
  ipc: ipcMock,
  mediaUrl: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));

type Fonts = typeof import("./index");
let F: Fonts;

/** A controllable FontFace: each instance's load settles when the test says. */
class FakeFontFace {
  static all: FakeFontFace[] = [];
  loadCalls = 0;
  private settle!: { ok(): void; fail(): void };
  private readonly loaded: Promise<FakeFontFace>;
  constructor(
    readonly family: string,
    readonly source: string,
    readonly desc: { weight?: string; style?: string; display?: string },
  ) {
    this.loaded = new Promise<FakeFontFace>((ok, fail) => {
      this.settle = { ok: () => ok(this), fail: () => fail(new Error("bad font")) };
    });
    FakeFontFace.all.push(this);
  }
  load(): Promise<FakeFontFace> {
    this.loadCalls++;
    return this.loaded;
  }
  finish(): void {
    this.settle.ok();
  }
  fail(): void {
    this.settle.fail();
  }
}
let fontSet: Set<unknown>;

/** What Rust answers for a request, from a table of families: each family
 *  lists the (bold, italic) faces it really has, face-choice order applied. */
function resolver(table: Record<string, { faces: [boolean, boolean][]; dir: string }>) {
  return async (reqs: FontRequest[]): Promise<ResolvedFont[]> =>
    reqs.map((r) => {
      const fam = table[r.id];
      if (!fam) return { requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" };
      const has = (b: boolean, i: boolean): boolean => fam.faces.some(([fb, fi]) => fb === b && fi === i);
      const [b, i] = has(r.bold, r.italic)
        ? [r.bold, r.italic]
        : has(false, r.italic)
          ? [false, r.italic]
          : has(false, false)
            ? [false, false]
            : fam.faces[0]!;
      return {
        requested: r.id,
        found: true,
        bold: b,
        italic: i,
        path: `${fam.dir}\\${b ? "B" : "R"}${i ? "I" : ""}.ttf`,
        lineHeightEm: 1.25,
        embed: "full",
      };
    });
}

const TABLE = {
  Consolas: { faces: [[false, false], [true, false], [false, true], [true, true]] as [boolean, boolean][], dir: "C:\\Windows\\Fonts\\consola" },
  // A family with ONE face (regular): bold and italic resolve to it.
  "lib:Plain": { faces: [[false, false]] as [boolean, boolean][], dir: "D:\\lib\\plain" },
};

const req = (id: string, bold = false, italic = false): FontRequest => ({ id, bold, italic });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
/** Every (id, bold, italic) the runtime ever asked Rust to resolve. */
const resolvedKeys = (): string[] =>
  ipcMock.fontsResolve.mock.calls.flatMap(([reqs]) => (reqs as FontRequest[]).map((r) => `${r.id}|${r.bold}|${r.italic}`));

beforeEach(async () => {
  vi.resetModules();
  for (const f of Object.values(ipcMock)) f.mockReset();
  ipcMock.fontsResolve.mockImplementation(resolver(TABLE));
  ipcMock.fontsList.mockResolvedValue({ library: [], installed: [] } satisfies FontCatalog);
  FakeFontFace.all = [];
  fontSet = new Set();
  const g = globalThis as Record<string, unknown>;
  g.FontFace = FakeFontFace;
  g.document = { fonts: { add: (f: unknown) => fontSet.add(f), delete: (f: unknown) => fontSet.delete(f) } };
  F = await import("./index");
});

afterEach(() => {
  vi.useRealTimers();
  const g = globalThis as Record<string, unknown>;
  delete g.FontFace;
  delete g.document;
});

describe("legacy fonts (I1)", () => {
  it("a legacy request, or none, makes no IPC call and no FontFace", async () => {
    await F.ensureFonts([req("Arial", true), req("Impact"), req("Segoe UI", false, true)]);
    await F.ensureFonts([]);
    expect(ipcMock.fontsResolve).not.toHaveBeenCalled();
    expect(FakeFontFace.all).toHaveLength(0);
    expect(F.fontsReady([req("Georgia", true, true)])).toBe(true);
    expect(F.missingFonts([req("Courier New")])).toEqual([]);
    expect(F.fontFace("Times New Roman", undefined, true, false)).toEqual({
      family: "Times New Roman",
      bold: true,
      italic: false,
      missing: false,
    });
  });
});

describe("resolving", () => {
  it("resolves each distinct face once, however many callers ask", async () => {
    const a = F.ensureFonts([req("Consolas"), req("Consolas", true)]);
    const b = F.ensureFonts([req("Consolas", false, true)]);
    const c = F.ensureFonts([req("lib:Plain"), req("Consolas", true, true)]);
    await flush();
    for (const f of FakeFontFace.all) f.finish();
    await Promise.all([a, b, c]);
    await F.ensureFonts([req("Consolas"), req("lib:Plain", true)]);
    const keys = resolvedKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      ["Consolas", "lib:Plain"].flatMap((id) => [`${id}|false|false`, `${id}|false|true`, `${id}|true|false`, `${id}|true|true`]).sort(),
    );
  });

  it("registers all four slots, each from the file Rust chose for it", async () => {
    const p = F.ensureFonts([req("Consolas")]);
    await flush();
    const slots = FakeFontFace.all.map((f) => `${f.desc.weight}/${f.desc.style} ${f.source}`);
    expect(slots).toEqual([
      `400/normal url("http://asset.localhost/${encodeURIComponent("C:\\Windows\\Fonts\\consola\\R.ttf")}")`,
      `700/normal url("http://asset.localhost/${encodeURIComponent("C:\\Windows\\Fonts\\consola\\B.ttf")}")`,
      `400/italic url("http://asset.localhost/${encodeURIComponent("C:\\Windows\\Fonts\\consola\\RI.ttf")}")`,
      `700/italic url("http://asset.localhost/${encodeURIComponent("C:\\Windows\\Fonts\\consola\\BI.ttf")}")`,
    ]);
    expect(new Set(FakeFontFace.all.map((f) => f.family)).size).toBe(1);
    expect(FakeFontFace.all.every((f) => fontSet.has(f) && f.loadCalls === 1)).toBe(true);
    // Swap, not block: DOM text shows the fallback while a face loads.
    expect(FakeFontFace.all.every((f) => f.desc.display === "swap")).toBe(true);
    for (const f of FakeFontFace.all) f.finish();
    await p;
  });

  it("the alias is stable for an id, differs between ids, and needs no quoting", () => {
    const a1 = F.fontFace("Segoe UI", "Consolas", false, false).family;
    const a2 = F.fontFace("Arial", "Consolas", true, true).family;
    const b = F.fontFace("Segoe UI", "lib:Consolas", false, false).family;
    const c = F.fontFace("Segoe UI", "Consola", false, false).family;
    expect(a1).toBe(a2);
    expect(new Set([a1, b, c]).size).toBe(3);
    for (const alias of [a1, b, c]) expect(alias).toMatch(/^[a-z][a-z0-9-]*$/);
    // CSS matches family names without regard to case, and an id may hold the
    // very characters the alias escapes with.
    const tricky = ["Consolas", "consolas", "aA", "a-0041", "a b", "a-0020b"].map((id) => F.fontFace("Segoe UI", id, false, false).family.toLowerCase());
    expect(new Set(tricky).size).toBe(tricky.length);
  });
});

describe("fontFace", () => {
  it("answers the alias before, during and after the load, and the legacy font once missing", async () => {
    const alias = F.fontFace("Segoe UI", "lib:Plain", true, true).family;
    // Before ensureFonts: the alias with the requested flags.
    expect(F.fontFace("Segoe UI", "lib:Plain", true, true)).toEqual({ family: alias, bold: true, italic: true, missing: false });
    expect(F.fontsReady([req("lib:Plain", true, true)])).toBe(false);

    const p = F.ensureFonts([req("lib:Plain", true, true)]);
    await flush();
    // Resolved, still loading: the real face's flags, not yet ready.
    expect(F.fontFace("Segoe UI", "lib:Plain", true, true)).toEqual({ family: alias, bold: false, italic: false, missing: false });
    expect(F.fontsReady([req("lib:Plain", true, true)])).toBe(false);

    for (const f of FakeFontFace.all) f.finish();
    await p;
    expect(F.fontFace("Segoe UI", "lib:Plain", true, true)).toEqual({ family: alias, bold: false, italic: false, missing: false });
    expect(F.fontsReady([req("lib:Plain", true, true)])).toBe(true);
    expect(F.missingFonts([req("lib:Plain")])).toEqual([]);

    await F.ensureFonts([req("lib:Gone", true)]);
    expect(F.fontFace("Georgia", "lib:Gone", true, false)).toEqual({ family: "Georgia", bold: true, italic: false, missing: true });
    expect(F.fontsReady([req("lib:Gone", true)])).toBe(true);
    expect(F.missingFonts([req("lib:Gone"), req("lib:Plain"), req("lib:Gone", true), req("Arial")])).toEqual(["lib:Gone"]);
  });

  it("makes an id's alias once, forgets it with the id, and leaves a legacy call map-free", async () => {
    const id = "lib:Plain";
    const replace = vi.spyOn(String.prototype, "replace");
    const test = vi.spyOn(RegExp.prototype, "test");
    const get = vi.spyOn(Map.prototype, "get");
    const made = (): number => replace.mock.contexts.filter((c) => String(c) === id).length;
    const shapeChecks = (): number => test.mock.calls.filter(([s]) => s === id).length;
    try {
      const alias = F.fontFace("Segoe UI", id, false, true).family;
      for (let i = 0; i < 50; i++) expect(F.fontFace("Arial", id, i % 2 === 0, false).family).toBe(alias);
      expect([made(), shapeChecks()]).toEqual([1, 2]);
      const p = F.ensureFonts([req(id)]);
      await flush();
      for (const f of FakeFontFace.all) f.finish();
      await p;
      expect(FakeFontFace.all.every((f) => f.family === alias)).toBe(true);
      expect(F.fontFace("Segoe UI", id, true, true).family).toBe(alias);
      expect(made()).toBe(1);

      // A legacy call reads no map at all.
      const before = get.mock.calls.length;
      F.fontFace("Times New Roman", undefined, true, false);
      F.fontFace("Segoe UI", "Impact", false, true);
      expect(get.mock.calls.length).toBe(before);

      // Removed: forgotten, so made again (and still the same alias).
      ipcMock.fontsRemove.mockResolvedValue(undefined);
      await F.removeFont(id);
      expect(F.fontFace("Georgia", id, false, false).family).toBe(alias);
      expect(made()).toBe(2);
    } finally {
      replace.mockRestore();
      test.mockRestore();
      get.mockRestore();
    }
  });

  it("a family without a bold face answers bold: false after resolve, and facesOf says so", async () => {
    expect(F.facesOf("lib:Plain")).toBeNull();
    const p = F.ensureFonts([req("lib:Plain", true)]);
    await flush();
    for (const f of FakeFontFace.all) f.finish();
    await p;
    expect(F.fontFace("Segoe UI", "lib:Plain", true, false).bold).toBe(false);
    expect(F.facesOf("lib:Plain")?.map((f) => [f.bold, f.italic])).toEqual([[false, false]]);
  });

  it("a font none of whose faces will load is drawn and reported as missing", async () => {
    const p = F.ensureFonts([req("Consolas")]);
    await flush();
    for (const f of FakeFontFace.all) f.fail();
    await p;
    expect(F.fontFace("Arial", "Consolas", false, false)).toEqual({ family: "Arial", bold: false, italic: false, missing: true });
    expect(F.missingFonts([req("Consolas")])).toEqual(["Consolas"]);
    expect(fontSet.size).toBe(0);
  });

  it("one face that will not load leaves nothing to wait on, and leaves document.fonts", async () => {
    const p = F.ensureFonts([req("Consolas")]);
    await flush();
    const bold = FakeFontFace.all[1]!;
    for (const f of FakeFontFace.all) if (f === bold) f.fail(); else f.finish();
    await p;
    // ensureFonts has nothing left to do for the bold slot: a caller that
    // waits on fontsReady must not wait for ever.
    expect(F.fontsReady([req("Consolas", true)])).toBe(true);
    expect(F.missingFonts([req("Consolas")])).toEqual([]);
    expect(fontSet.has(bold)).toBe(false);
    expect(fontSet.size).toBe(3);
  });
});

describe("the 5 s bound", () => {
  it("ensureFonts gives up waiting at 5 s, never rejects, and a later load still notifies", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    F.onFontsChanged(changed);
    let settled = false;
    void F.ensureFonts([req("Consolas")]).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(F.fontsReady([req("Consolas")])).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    FakeFontFace.all[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(F.fontsReady([req("Consolas")])).toBe(true);
  });
});

describe("onFontsChanged", () => {
  it("fires on load, import and removal, and its unsubscribe works", async () => {
    const changed = vi.fn();
    const off = F.onFontsChanged(changed);

    const p = F.ensureFonts([req("Consolas")]);
    await flush();
    FakeFontFace.all[0]!.finish();
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    for (const f of FakeFontFace.all) f.finish();
    await p;

    const ok: FontImportResult = { path: "D:\\in\\Inter.ttf", ok: true, id: "lib:Inter", family: "Inter", style: "Regular" };
    ipcMock.fontsImport.mockResolvedValue([ok]);
    expect(await F.importFonts(["D:\\in\\Inter.ttf"])).toEqual([ok]);
    const afterImport = changed.mock.calls.length;
    expect(afterImport).toBeGreaterThan(1);

    ipcMock.fontsRemove.mockResolvedValue(undefined);
    await F.removeFont("lib:Inter");
    expect(ipcMock.fontsRemove).toHaveBeenCalledWith("lib:Inter");
    const afterRemove = changed.mock.calls.length;
    expect(afterRemove).toBeGreaterThan(afterImport);

    off();
    await F.removeFont("lib:Inter");
    expect(changed.mock.calls.length).toBe(afterRemove);
  });

  it("an import that only failed does not notify", async () => {
    const changed = vi.fn();
    F.onFontsChanged(changed);
    ipcMock.fontsImport.mockResolvedValue([{ path: "D:\\x.txt", ok: false, error: "extension" }]);
    await F.importFonts(["D:\\x.txt"]);
    expect(changed).not.toHaveBeenCalled();
    expect(ipcMock.fontsList).not.toHaveBeenCalled();
  });
});

describe("the library changing under an open project", () => {
  it("importing a font that was missing heals it: it is resolved again and drawn", async () => {
    await F.ensureFonts([req("lib:Inter")]);
    expect(F.missingFonts([req("lib:Inter")])).toEqual(["lib:Inter"]);

    (TABLE as Record<string, { faces: [boolean, boolean][]; dir: string }>)["lib:Inter"] = { faces: [[false, false]], dir: "D:\\lib\\inter" };
    try {
      ipcMock.fontsImport.mockResolvedValue([{ path: "D:\\in\\Inter.ttf", ok: true, id: "lib:Inter" }]);
      await F.importFonts(["D:\\in\\Inter.ttf"]);
      await flush();
      expect(F.missingFonts([req("lib:Inter")])).toEqual([]);
      expect(F.fontFace("Segoe UI", "lib:Inter", false, false).missing).toBe(false);
      expect(FakeFontFace.all.length).toBe(4);
    } finally {
      delete (TABLE as Record<string, unknown>)["lib:Inter"];
    }
  });

  it("removing a font takes its faces out of document.fonts", async () => {
    const p = F.ensureFonts([req("lib:Plain")]);
    await flush();
    for (const f of FakeFontFace.all) f.finish();
    await p;
    expect(fontSet.size).toBe(4);
    ipcMock.fontsRemove.mockResolvedValue(undefined);
    await F.removeFont("lib:Plain");
    expect(FakeFontFace.all.slice(0, 4).some((f) => fontSet.has(f))).toBe(false);
  });
});

describe("fontCatalog", () => {
  it("enumerates on the first call only, unless asked to refresh", async () => {
    const cat: FontCatalog = { library: [], installed: [{ id: "Consolas", name: "Consolas", source: "installed", faces: [] }] };
    ipcMock.fontsList.mockResolvedValue(cat);
    expect(ipcMock.fontsList).not.toHaveBeenCalled();
    await F.fontCatalog();
    await F.fontCatalog();
    expect(ipcMock.fontsList.mock.calls).toEqual([[false]]);
    await F.fontCatalog(true);
    expect(ipcMock.fontsList.mock.calls).toEqual([[false], [true]]);
  });
});
