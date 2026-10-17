// The PDF editor shell's pure pieces: the zoom ladder, the page mapping the
// strip is fed, the Home card's identity, the find bar's arithmetic, the
// source relink op, and the cover writer's chunked save and ordering.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfProject } from "../../core/pdf-project";
import type { PdfPage, ProjectFile } from "../../core/types";
import type { PdfDoc } from "../types";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  failChunk: false,
}));

vi.mock("../view", () => ({}));
vi.mock("./tools", () => ({ toolsPart: () => ({ dispose() {} }) }));
vi.mock("./inspector", () => ({ inspectorPart: () => ({ dispose() {} }) }));
vi.mock("./forms", () => ({ formsPart: () => ({ dispose() {} }) }));
vi.mock("./export-dialog", () => ({ openPdfExportDialog: () => {} }));
vi.mock("../../core/ipc", () => ({
  ipc: {
    imageSaveBegin: async (dest: { kind: string }, fmt: string, size: number) => {
      h.calls.push(`begin:${dest.kind}:${fmt}:${size}`);
      return { token: 3, path: "x" };
    },
    imageSaveChunk: async (_t: number, b: Uint8Array) => {
      if (h.failChunk) throw new Error("disk full");
      h.calls.push(`chunk:${b.length}`);
    },
    imageSaveCommit: async () => void h.calls.push("commit"),
    imageSaveAbort: async () => void h.calls.push("abort"),
  },
  pickPdfFiles: async () => [],
}));

const shell = await import("./shell");
const { countText, firstHitFrom } = await import("./find");
const { maxPageUsed, relinkSource, statProblem } = await import("./sources");
const { saveCover, writeCover } = await import("./save");

beforeEach(() => {
  h.calls.length = 0;
  h.failChunk = false;
});

function project(): ProjectFile {
  let n = 0;
  return createPdfProject("R", { path: "C:/a.pdf", size: 10, mtimeMs: 2, pages: 4 }, { id: () => `i${n++}` });
}

describe("zoom", () => {
  it("100% is a page at its printed size", () => {
    expect(shell.ZOOM_100).toBeCloseTo(96 / 72);
    expect(shell.zoomPct(96 / 72)).toBe(100);
  });
  it("steps the ladder both ways and stops at its ends", () => {
    const K = 96 / 72;
    expect(shell.zoomStep(K, 1)).toBeCloseTo(1.1 * K);
    expect(shell.zoomStep(K, -1)).toBeCloseTo(0.9 * K);
    // between rungs: to the nearest rung that way
    expect(shell.zoomStep(1.05 * K, 1)).toBeCloseTo(1.1 * K);
    expect(shell.zoomStep(1.05 * K, -1)).toBeCloseTo(K);
    expect(shell.zoomStep(6 * K, 1)).toBeNull();
    expect(shell.zoomStep(0.1 * K, -1)).toBeNull();
  });
  it("a Ctrl+wheel notch up zooms in, down zooms out, lines and pages count more", () => {
    expect(shell.wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(shell.wheelFactor(100, 0)).toBeLessThan(1);
    expect(shell.wheelFactor(3, 1)).toBeCloseTo(shell.wheelFactor(48, 0));
    expect(shell.wheelFactor(100000, 0)).toBeCloseTo(shell.wheelFactor(300, 0));
  });
});

describe("defaultToolState", () => {
  it("starts on select with the image editor's colours, highlight yellow, black text", () => {
    const s = shell.defaultToolState();
    expect(s.tool).toBe("select");
    expect(s.colors).toEqual({ highlight: "#ffd400", pen: "#000000", pencil: "#3a3a3a", marker: "#ffd400", shape: "#e5484d", text: "#000000" });
    expect(s.shape).toBe("arrow");
    expect(s.font).toBe("Segoe UI");
    expect(s.ruler).toBeNull();
    // a fresh object each time: no mount can change another's defaults
    expect(shell.defaultToolState().colors).not.toBe(s.colors);
    expect([s.textBg, s.textBorder]).toEqual([null, null]);
  });

  it("brings back the remembered styles (Settings → pdfToolStyle), clamped; tool and ruler start fresh", () => {
    const s = shell.defaultToolState({
      colors: { pen: "#ABCDEF", marker: "not a colour" },
      sizes: { pen: 9, text: 500, eraser: 0.5 },
      shape: "ellipse",
      font: "Georgia",
      textBg: "#fff3a0",
      textBorder: null,
    });
    expect(s.tool).toBe("select");
    expect(s.ruler).toBeNull();
    expect(s.colors.pen).toBe("#abcdef");
    expect(s.colors.marker).toBe("#ffd400");
    expect(s.colors.shape).toBe("#e5484d");
    expect(s.sizes.pen).toBe(9);
    expect(s.sizes.text).toBe(288);
    expect(s.sizes.eraser).toBe(1);
    expect(s.sizes.marker).toBe(18);
    expect([s.shape, s.font, s.textBg, s.textBorder]).toEqual(["ellipse", "Georgia", "#fff3a0", null]);
  });
});

describe("viewPagesOf", () => {
  it("maps pages to slots keyed by page id; blank pages and unopened sources have no doc", () => {
    const doc = { id: "s" } as PdfDoc;
    const pages: PdfPage[] = [
      { id: "p1", src: "s", page: 2, rotate: 90 },
      { id: "p2", src: null, page: 0, rotate: 0, w: 100, h: 200 },
      { id: "p3", src: "gone", page: 0, rotate: 0 },
    ];
    expect(shell.viewPagesOf(pages, new Map([["s", doc]]))).toEqual([
      { key: "p1", doc, index: 2, rotate: 90 },
      { key: "p2", doc: null, index: 0, rotate: 0, w: 100, h: 200 },
      { key: "p3", doc: null, index: 0, rotate: 0 },
    ]);
  });
});

describe("coverKey", () => {
  it("changes with the first page, its rotation and its source's identity — nothing else", () => {
    const p = project();
    const k = shell.coverKey(p);
    const pdf = p.pdf!;
    expect(shell.coverKey({ ...p, name: "Other" })).toBe(k);
    expect(shell.coverKey({ ...p, pdf: { ...pdf, pages: [pdf.pages[0]!, pdf.pages[2]!, pdf.pages[1]!, pdf.pages[3]!] } })).toBe(k);
    expect(shell.coverKey({ ...p, pdf: { ...pdf, pages: [...pdf.pages].reverse() } })).not.toBe(k);
    expect(shell.coverKey({ ...p, pdf: { ...pdf, pages: [{ ...pdf.pages[0]!, rotate: 90 }, ...pdf.pages.slice(1)] } })).not.toBe(k);
    expect(shell.coverKey({ ...p, pdf: { ...pdf, sources: [{ ...pdf.sources[0]!, mtimeMs: 99 }] } })).not.toBe(k);
  });
});

describe("find arithmetic", () => {
  it("starts on the first hit on or after the current page, wrapping to the first", () => {
    const hits = [
      { key: "a", rects: [] },
      { key: "c", rects: [] },
    ];
    expect(firstHitFrom(hits, ["a", "b", "c"], 0)).toBe(0);
    expect(firstHitFrom(hits, ["a", "b", "c"], 1)).toBe(1);
    expect(firstHitFrom(hits, ["a", "b", "c", "d"], 3)).toBe(0);
    expect(firstHitFrom([], ["a"], 0)).toBe(-1);
  });
  it("says 3 of 12, No results, or nothing", () => {
    expect(countText("x", 12, 2)).toBe("3 of 12");
    expect(countText("x", 0, -1)).toBe("No results");
    expect(countText("  ", 0, -1)).toBe("");
  });
});

describe("sources", () => {
  it("statProblem: gone, changed, or fine", () => {
    const src = { id: "s", path: "C:/a.pdf", size: 10, mtimeMs: 2, pages: 4 };
    expect(statProblem(src, null)).toBe("missing");
    expect(statProblem(src, { size: 11, mtimeMs: 2 })).toBe("changed");
    expect(statProblem(src, { size: 10, mtimeMs: 3 })).toBe("changed");
    expect(statProblem(src, { size: 10, mtimeMs: 2 })).toBeNull();
  });

  it("relinkSource points the source at a new file and keeps everything else", () => {
    const p = project();
    const id = p.pdf!.sources[0]!.id;
    const q = relinkSource(p, id, { path: "D:/b.pdf", size: 5, mtimeMs: 7, pages: 4 });
    expect(q.pdf!.sources[0]).toEqual({ id, path: "D:/b.pdf", size: 5, mtimeMs: 7, pages: 4 });
    expect(q.pdf!.pages).toBe(p.pdf!.pages);
    expect(p.pdf!.sources[0]!.path).toBe("C:/a.pdf");
  });

  it("relinkSource refuses what would break the project, returning it unchanged", () => {
    const p = project();
    const id = p.pdf!.sources[0]!.id;
    const ok = { path: "D:/b.pdf", size: 5, mtimeMs: 7, pages: 4 };
    expect(maxPageUsed(p, id)).toBe(3);
    expect(relinkSource(p, id, { ...ok, pages: 3 })).toBe(p);
    expect(relinkSource(p, "nope", ok)).toBe(p);
    expect(relinkSource(p, id, { ...ok, path: "https://x.test/a.pdf" })).toBe(p);
    expect(relinkSource(p, id, { ...ok, size: Number.NaN })).toBe(p);
    expect(relinkSource(p, id, { ...ok, pages: 1.5 })).toBe(p);
    expect(relinkSource(p, id, { path: "C:/a.pdf", size: 10, mtimeMs: 2, pages: 4 })).toBe(p);
    expect(relinkSource({ ...p, kind: "image" }, id, ok)).toEqual({ ...p, kind: "image" });
  });
});

describe("the cover writer", () => {
  it("streams a card as a projectThumb JPEG: begin, chunk, commit", async () => {
    await saveCover("C:/p.trt", "pid", new Blob([new Uint8Array(10)]));
    expect(h.calls).toEqual(["begin:projectThumb:jpeg:10", "chunk:10", "commit"]);
  });

  it("aborts the open save when a chunk fails, and rethrows", async () => {
    h.failChunk = true;
    await expect(saveCover("C:/p.trt", "pid", new Blob([new Uint8Array(10)]))).rejects.toThrow("disk full");
    expect(h.calls).toEqual(["begin:projectThumb:jpeg:10", "abort"]);
  });

  it("a newer cover of the same project aborts the older one, which then writes nothing", async () => {
    let finishOld!: (b: Blob) => void;
    const old = writeCover("C:/q.trt", "pid", () => new Promise<Blob>((r) => (finishOld = r)), Date.now() + 50);
    const fresh = writeCover("C:/q.trt", "pid", async () => new Blob([new Uint8Array(2)]), Date.now() + 50);
    await fresh.done;
    finishOld(new Blob([new Uint8Array(9)]));
    await old.done;
    expect(h.calls).toEqual(["begin:projectThumb:jpeg:2", "chunk:2", "commit"]);
  });

  it("never rejects, and stops WAITING at the deadline while the work runs on", async () => {
    vi.useFakeTimers();
    let finish!: (b: Blob) => void;
    const w = writeCover("C:/r.trt", "pid", () => new Promise<Blob>((r) => (finish = r)), Date.now() + 100);
    let waited = false;
    void w.waited.then(() => (waited = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(waited).toBe(true);
    expect(h.calls).toEqual([]);
    vi.useRealTimers();
    finish(new Blob([new Uint8Array(1)]));
    await w.done;
    expect(h.calls).toEqual(["begin:projectThumb:jpeg:1", "chunk:1", "commit"]);
    const failing = writeCover("C:/s.trt", "pid", async () => {
      throw new Error("render failed");
    }, Date.now());
    await expect(failing.done).resolves.toBeUndefined();
  });
});
