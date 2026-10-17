// mountEditor's kind dispatch for PDF projects: a project of kind "pdf" goes
// to the PDF editor's own lazy chunk — through `await import("../pdf/editor")`
// and nothing else — with the same route, the same `isStale` and the loaded
// project, before anything of the video editor is built. A chunk that fails
// to load routes out like a failed load, and a mount superseded during the
// chunk load steps aside.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loaded: null as unknown,
  pdfMounts: [] as unknown[][],
  imageMounts: 0,
  navigations: [] as unknown[],
  toasts: [] as string[],
}));

vi.mock("../core/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/ipc")>()),
  ipc: { loadProject: async () => h.loaded },
}));
vi.mock("../core/nav", () => ({
  exitDest: (r: { returnTo?: string }) => (r.returnTo ? { view: "viewer", path: r.returnTo } : { view: "home" }),
  navigate: (r: unknown) => void h.navigations.push(r),
}));
vi.mock("../ui/toast", () => ({
  toast: { error: (m: string) => void h.toasts.push(m), info: () => {}, refuse: () => {}, notice: () => {} },
}));
vi.mock("../image/image-editor", () => ({
  mountImageEditor: async () => {
    h.imageMounts++;
    return { dispose: async () => {} };
  },
}));
vi.mock("../pdf/editor", () => {
  return {
    mountPdfEditor: async (...args: unknown[]) => {
      h.pdfMounts.push(args);
      return { dispose: async () => {} };
    },
  };
});

const { mountEditor } = await import("./editor");

const here = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  h.pdfMounts.length = 0;
  h.imageMounts = 0;
  h.navigations.length = 0;
  h.toasts.length = 0;
  h.loaded = { project: { kind: "pdf", name: "Report" }, missing: [], recovered: false };
});

describe("the PDF dispatch", () => {
  it("hands a PDF project to mountPdfEditor with the route, isStale and the loaded project", async () => {
    const root = {} as HTMLElement;
    const route = { view: "editor" as const, projectPath: "C:/p/r.trt", returnTo: "D:/v/r.pdf" };
    const isStale = (): boolean => false;
    await mountEditor(root, route, isStale);
    expect(h.pdfMounts).toEqual([[root, route, isStale, h.loaded]]);
    expect(h.imageMounts).toBe(0);
  });

  it("a mount superseded while the chunk loads steps aside", async () => {
    let calls = 0;
    // stale from the check after the chunk load on
    await mountEditor({} as HTMLElement, { view: "editor", projectPath: "C:/p/r.trt" }, () => ++calls > 1);
    expect(h.pdfMounts).toEqual([]);
    expect(h.navigations).toEqual([]);
  });

  it("reaches the PDF editor ONLY through the dynamic import", () => {
    const src = readFileSync(resolve(here, "editor.ts"), "utf8");
    expect(src).toContain('await import("../pdf/editor")');
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*?from\s+["'](?:\.\.\/)+pdf\//m);
    const dynamic = [...src.matchAll(/import\(\s*["']([^"']*pdf[^"']*)["']\s*\)/g)].map((m) => m[1]);
    expect(dynamic.every((s) => s === "../pdf/editor")).toBe(true);
  });
});
