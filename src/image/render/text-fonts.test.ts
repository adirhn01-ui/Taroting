// Library and installed fonts on the image canvas (Taroting 0.9.4): the
// compositor's text-look cache and the export's one font barrier, driven
// through a small call-recording Canvas2D double (vitest runs in node). The
// font runtime (src/fonts) is faked: whether a font is ready or missing is the
// fixture, and `fontString` answers from that same fake state the way the
// real one does (an alias for a loaded font, the legacy name otherwise).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontRequest, Generator, ProjectFile } from "../../core/types";
import { createBlankImageProject } from "../../core/image-project";
import { addGeneratorLayer, setLayerHidden } from "../layers";

/* ---------------- the fake font runtime ---------------- */

const f = vi.hoisted(() => ({
  /** ids whose face has loaded */
  loaded: new Set<string>(),
  /** ids known not to be on this PC */
  missing: new Set<string>(),
  /** every ensureFonts call, with the requests it was handed */
  ensures: [] as FontRequest[][],
  /** every fontsReady call */
  readyCalls: 0,
  /** how the pending ensureFonts calls finish */
  pending: [] as { resolve: () => void; reject: (e: unknown) => void }[],
  /** log shared with the canvas double, to order awaits against draws */
  log: [] as string[],
  /** a loading font's string names the alias with the default behind it
   *  (otherwise it names the legacy family alone) */
  loadingString: false,
}));

vi.mock("../../fonts", () => ({
  ensureFonts: (reqs: FontRequest[]) => {
    f.ensures.push(reqs);
    f.log.push(`ensure:${reqs.map((r) => r.id).join(",")}`);
    return new Promise<void>((resolve, reject) => {
      f.pending.push({
        resolve: () => {
          f.log.push("ensured");
          resolve();
        },
        reject,
      });
    });
  },
  fontsReady: (reqs: FontRequest[]) => {
    f.readyCalls++;
    return reqs.every((r) => f.loaded.has(r.id) || f.missing.has(r.id));
  },
}));

vi.mock("../../editor/media/generators", () => ({
  fontString: (g: Extract<Generator, { type: "text" }>) => {
    if (g.fontId !== undefined && f.loaded.has(g.fontId)) return `${g.sizePx}px alias-${g.fontId}`;
    if (g.fontId !== undefined && f.loadingString && !f.missing.has(g.fontId)) return `${g.sizePx}px alias-${g.fontId}, Segoe UI`;
    return `${g.sizePx}px ${g.fontFamily}`;
  },
}));

/* ---------------- the recording double ---------------- */

class RecCtx {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle: unknown = "#000000";
  font = "";
  textAlign = "start";
  textBaseline = "alphabetic";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  constructor(readonly canvas: FakeCanvas) {}
  setTransform(): void {}
  fillRect(): void {}
  clearRect(): void {}
  drawImage(): void {}
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  fillText(t: string): void {
    f.log.push(`text:${t}|${this.font}`);
  }
}

class FakeCanvas {
  private ctx: RecCtx | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): RecCtx {
    this.ctx ??= new RecCtx(this);
    return this.ctx;
  }
  async convertToBlob(opts: { type: string }): Promise<Blob> {
    return new Blob([new Uint8Array(3)], { type: opts.type });
  }
}

const { invalidateTextLooks, renderComposite, textFontRequests } = await import("./composite");
const { renderImageExport, renderThumbnail } = await import("./export");
const { layersOf } = await import("../layers");

/* ---------------- fixtures ---------------- */

type TextGen = Extract<Generator, { type: "text" }>;
const text = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Hello",
  fontFamily: "Segoe UI",
  sizePx: 40,
  color: "#123456",
  bold: false,
  italic: false,
  ...over,
});

/** A project with the given text layers, the first one bottom-most. */
function project(...gens: TextGen[]): ProjectFile {
  let p = createBlankImageProject("Card", 320, 200, "#ffffff");
  let top: string | null = null;
  for (const g of gens) {
    const r = addGeneratorLayer(p, g, 120, 60, "Text", { above: top });
    p = r.project;
    top = r.trackId;
  }
  return p;
}

const noRes = { photo: () => null, drawingRaster: () => null };
const view = { zoom: 1, panX: 0, panY: 0 };
const preview = (p: ProjectFile): void => {
  const c = new FakeCanvas(320, 200).getContext();
  renderComposite(c as never, p, noRes, view, { underlay: "none" });
};
const exportPng = (p: ProjectFile, signal = new AbortController().signal): Promise<Blob> =>
  renderImageExport(p, { format: "png", quality: 100, outW: 320, outH: 200 }, signal, () => {});
const texts = (): string[] => f.log.filter((l) => l.startsWith("text:"));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  f.loaded.clear();
  f.missing.clear();
  f.ensures.length = 0;
  f.readyCalls = 0;
  f.pending.length = 0;
  f.log.length = 0;
  f.loadingString = false;
  invalidateTextLooks();
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  // `yieldToUi` takes a macrotask in node: keep it immediate.
  vi.stubGlobal("scheduler", { yield: () => Promise.resolve() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- the export barrier ---------------- */

describe("render() waits for the fonts before drawing", () => {
  it("awaits ensureFonts with the text layers' requests before the first layer is drawn", async () => {
    const p = project(text({ text: "Lib", fontId: "lib:Inter", bold: true }), text({ text: "Sys", fontId: "Consolas", italic: true }));
    const out = exportPng(p);
    await flush();
    // Asked once, for both fonts, with their styles; nothing drawn yet.
    expect(f.ensures).toEqual([[
      { id: "Consolas", bold: false, italic: true },
      { id: "lib:Inter", bold: true, italic: false },
    ]]);
    expect(texts()).toEqual([]);
    f.loaded.add("lib:Inter");
    f.loaded.add("Consolas");
    f.pending[0]!.resolve();
    await out;
    // Drawn after the fonts landed, with the real faces' strings.
    expect(f.log.indexOf("ensured")).toBeLessThan(f.log.indexOf("text:Lib|40px alias-lib:Inter"));
    expect(texts()).toEqual(["text:Lib|40px alias-lib:Inter", "text:Sys|40px alias-Consolas"]);
  });

  it("asks for each distinct font once", async () => {
    const p = project(text({ text: "A", fontId: "lib:Inter" }), text({ text: "B", fontId: "lib:Inter" }));
    const out = exportPng(p);
    await flush();
    expect(f.ensures).toEqual([[{ id: "lib:Inter", bold: false, italic: false }]]);
    f.pending[0]!.resolve();
    await out;
  });

  it("leaves out the fonts of hidden layers (they are not drawn)", async () => {
    let p = project(text({ text: "A", fontId: "lib:Inter" }), text({ text: "C", fontId: "Hidden Font" }));
    p = setLayerHidden(p, layersOf(p)[0]!.trackId, true);
    const out = exportPng(p);
    await flush();
    expect(f.ensures).toEqual([[{ id: "lib:Inter", bold: false, italic: false }]]);
    f.pending[0]!.resolve();
    await out;
  });

  it("a font load that fails still renders, with the legacy font", async () => {
    const p = project(text({ text: "Lib", fontId: "lib:Inter", fontFamily: "Arial" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = exportPng(p);
    await flush();
    f.pending[0]!.reject(new Error("ipc down"));
    await expect(out).resolves.toBeInstanceOf(Blob);
    expect(texts()).toEqual(["text:Lib|40px Arial"]);
    warn.mockRestore();
  });

  it("a cancel during a font load that never finishes rejects at once, drawing nothing", async () => {
    const p = project(text({ text: "Lib", fontId: "lib:Inter" }));
    const ac = new AbortController();
    const out = exportPng(p, ac.signal);
    await flush();
    expect(f.ensures).toHaveLength(1);
    ac.abort();
    await expect(out).rejects.toMatchObject({ name: "AbortError" });
    expect(texts()).toEqual([]);
  });

  it("the Home thumbnail goes through the same barrier", async () => {
    const p = project(text({ text: "Lib", fontId: "lib:Inter" }));
    const out = renderThumbnail(p);
    await flush();
    expect(f.ensures).toHaveLength(1);
    expect(texts()).toEqual([]);
    f.loaded.add("lib:Inter");
    f.pending[0]!.resolve();
    await out;
    expect(texts()).toEqual(["text:Lib|40px alias-lib:Inter"]);
  });

  it("a missing font draws with the layer's legacy family, even after a preview drew it loading", async () => {
    const p = project(text({ text: "Gone", fontId: "lib:Gone", fontFamily: "Georgia" }));
    // The stage drew it first, while the font was still loading: that look
    // (the fallback's string, Segoe UI here) is cached.
    f.loadingString = true;
    preview(p);
    expect(texts()).toEqual(["text:Gone|40px alias-lib:Gone, Segoe UI"]);
    f.log.length = 0;
    const out = exportPng(p);
    await flush();
    f.missing.add("lib:Gone");
    f.pending[0]!.resolve();
    await out;
    expect(texts()).toEqual(["text:Gone|40px Georgia"]);
  });
});

/* ---------------- I1: legacy-only projects ---------------- */

describe("a project without any fontId", () => {
  it("makes no font call at all: export, thumbnail and preview", async () => {
    const p = project(text({ text: "One", fontFamily: "Impact", bold: true }), text({ text: "Two", fontFamily: "Courier New", italic: true }));
    await exportPng(p);
    await renderThumbnail(p);
    preview(p);
    preview(p);
    expect(f.ensures).toEqual([]);
    expect(f.readyCalls).toBe(0);
    expect(textFontRequests(layersOf(p))).toEqual([]);
    // And it drew, with the legacy strings.
    expect(texts()).toContain("text:One|40px Impact");
  });

  it("an ill-shaped fontId counts as none (the legacy font is in force)", async () => {
    const p = project(text({ text: "Bad", fontId: " padded" }));
    await exportPng(p);
    expect(f.ensures).toEqual([]);
    expect(f.readyCalls).toBe(0);
  });
});

/* ---------------- the preview's look cache ---------------- */

describe("the text look cache", () => {
  it("re-resolves the font string when the font becomes ready", () => {
    const p = project(text({ text: "Lib", fontId: "lib:Inter" }));
    preview(p);
    expect(texts()).toEqual(["text:Lib|40px Segoe UI"]);
    // Same generator object, font now loaded: the fallback is not kept.
    f.loaded.add("lib:Inter");
    preview(p);
    expect(texts()).toEqual(["text:Lib|40px Segoe UI", "text:Lib|40px alias-lib:Inter"]);
  });

  it("a look built with a ready font is reused without asking again", () => {
    f.loaded.add("lib:Inter");
    const p = project(text({ text: "Lib", fontId: "lib:Inter" }));
    preview(p);
    const asked = f.readyCalls;
    preview(p);
    preview(p);
    expect(f.readyCalls).toBe(asked);
  });

  it("invalidateTextLooks rebuilds a ready look (a font removed or replaced)", () => {
    f.loaded.add("lib:Inter");
    const p = project(text({ text: "Lib", fontId: "lib:Inter" }));
    preview(p);
    f.loaded.delete("lib:Inter");
    f.missing.add("lib:Inter");
    invalidateTextLooks();
    preview(p);
    expect(texts()).toEqual(["text:Lib|40px alias-lib:Inter", "text:Lib|40px Segoe UI"]);
  });

  it("the preview never asks for a font load itself", () => {
    const p = project(text({ text: "Lib", fontId: "lib:Inter" }));
    preview(p);
    expect(f.ensures).toEqual([]);
  });
});
