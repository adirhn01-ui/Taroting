import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../core/types";

// Home's PDF projects: PDFs in, ONE saved library project out. The real
// createPdfProject and the real page model build the project, so what is
// asserted is the file that would be written.

const m = vi.hoisted(() => ({
  stats: new Map<string, { size: number; mtimeMs: number }>(),
  /** page count, or the PdfOpenError kind countPages rejects with */
  pages: new Map<string, number | "password" | "invalid" | "missing" | "other">(),
  counted: [] as string[],
  saved: [] as Array<{ path: string; project: ProjectFile }>,
  errors: [] as string[],
  infos: [] as string[],
  refusals: [] as string[],
}));
vi.mock("../core/ipc", () => ({
  ipc: {
    fileStat: async (p: string) => m.stats.get(p) ?? null,
    newProjectPath: async (s?: string) => `C:\\Docs\\Taroting\\${s ?? "Untitled"} (2).trt`,
    saveProject: async (path: string, project: ProjectFile) => void m.saved.push({ path, project }),
  },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../ui/toast", () => ({
  toast: {
    error: (s: string) => void m.errors.push(s),
    info: (s: string) => void m.infos.push(s),
    refuse: (s: string) => void m.refusals.push(s),
  },
}));
vi.mock("../pdf/view/loader", () => ({
  countPages: async (p: string) => {
    m.counted.push(p);
    const v = m.pages.get(p);
    if (typeof v === "number") return v;
    const kind = v ?? "missing";
    throw Object.assign(new Error(kind === "other" ? "broken xref" : kind), {
      kind,
      ...(kind === "password" ? { retry: false } : {}),
      ...(kind === "other" ? { message: "broken xref" } : {}),
    });
  },
}));

const { createPdfProjectFrom, PDF_MISSING, PDF_PROTECTED } = await import("./pdf-project-from");

function pdf(path: string, pages: number | "password" | "invalid" | "other", size = 1000, mtimeMs = 1_700_000_000_000): string {
  m.stats.set(path, { size, mtimeMs });
  m.pages.set(path, pages);
  return path;
}
const live = (): boolean => false;

beforeEach(() => {
  m.stats.clear();
  m.pages.clear();
  m.counted = [];
  m.saved = [];
  m.errors = [];
  m.infos = [];
  m.refusals = [];
});

describe("createPdfProjectFrom", () => {
  it("saves one PDF as a schema-4 PDF project with its identity and every page", async () => {
    const a = pdf("C:\\d\\Report.pdf", 3, 4321, 1_699_000_000_000);
    const path = await createPdfProjectFrom([a], live);
    expect(path).toBe("C:\\Docs\\Taroting\\Report (2).trt");
    expect(m.saved).toHaveLength(1);
    const { project } = m.saved[0]!;
    expect(m.saved[0]!.path).toBe(path);
    expect(project.schema).toBe(4);
    expect(project.kind).toBe("pdf");
    // Named after the file the backend picked, de-duplication included.
    expect(project.name).toBe("Report (2)");
    expect(project.pdf!.sources).toHaveLength(1);
    expect(project.pdf!.sources[0]).toMatchObject({ path: a, size: 4321, mtimeMs: 1_699_000_000_000, pages: 3 });
    const src = project.pdf!.sources[0]!.id;
    expect(project.pdf!.pages.map((p) => [p.src, p.page])).toEqual([
      [src, 0],
      [src, 1],
      [src, 2],
    ]);
    expect(m.errors).toEqual([]);
  });

  it("makes ONE project of several PDFs, every page in the order the files came", async () => {
    const a = pdf("C:\\d\\cover.pdf", 1, 10);
    const b = pdf("C:\\d\\body.pdf", 2, 20);
    const c = pdf("C:\\d\\appendix.pdf", 1, 30);
    await createPdfProjectFrom([a, b, c], live);
    expect(m.saved).toHaveLength(1);
    const meta = m.saved[0]!.project.pdf!;
    expect(meta.sources.map((s) => s.path)).toEqual([a, b, c]);
    const pathOf = new Map(meta.sources.map((s) => [s.id, s.path]));
    expect(meta.pages.map((p) => [pathOf.get(p.src!), p.page])).toEqual([
      [a, 0],
      [b, 0],
      [b, 1],
      [c, 0],
    ]);
    expect(new Set(meta.pages.map((p) => p.id)).size).toBe(4);
    expect(m.saved[0]!.project.name).toBe("cover (2)");
  });

  it("says a missing PDF is missing and makes nothing, before pdf.js is ever asked", async () => {
    expect(await createPdfProjectFrom(["C:\\d\\gone.pdf"], live)).toBeNull();
    expect(m.errors).toEqual([PDF_MISSING]);
    expect(m.counted).toEqual([]);
    expect(m.saved).toEqual([]);
  });

  it("makes nothing of a protected PDF and says to open it to read it, as information", async () => {
    expect(await createPdfProjectFrom([pdf("C:\\d\\Locked.pdf", "password")], live)).toBeNull();
    expect(m.infos).toEqual([PDF_PROTECTED]);
    expect(PDF_PROTECTED).toBe("Protected PDFs can't be edited — open it to read it instead.");
    expect(m.errors).toEqual([]);
    expect(m.saved).toEqual([]);
  });

  it("says an invalid PDF couldn't be read, in Home's words, and makes nothing", async () => {
    expect(await createPdfProjectFrom([pdf("C:\\d\\Fake.pdf", "invalid")], live)).toBeNull();
    expect(m.errors).toEqual(["Couldn't read Fake as a PDF."]);
    expect(await createPdfProjectFrom([pdf("C:\\d\\Odd.pdf", "other")], live)).toBeNull();
    expect(m.errors[1]).toBe("Couldn't open Odd: broken xref");
    expect(m.saved).toEqual([]);
  });

  it("skips protected PDFs in a multi-pick with ONE toast naming how many, and keeps the rest", async () => {
    const locked1 = pdf("C:\\d\\locked 1.pdf", "password");
    const a = pdf("C:\\d\\a.pdf", 2);
    const locked2 = pdf("C:\\d\\locked 2.pdf", "password");
    const b = pdf("C:\\d\\b.pdf", 1, 2000);
    await createPdfProjectFrom([locked1, a, locked2, b], live);
    expect(m.infos).toEqual([
      "Skipped 2 protected PDFs — protected PDFs can't be edited. Open them to read them instead.",
    ]);
    const meta = m.saved[0]!.project.pdf!;
    // The first READABLE one makes and names the project.
    expect(m.saved[0]!.project.name).toBe("a (2)");
    expect(meta.sources.map((s) => s.path)).toEqual([a, b]);
    expect(meta.pages).toHaveLength(3);
  });

  it("makes nothing and says nothing once Home is gone", async () => {
    let gone = false;
    const a = pdf("C:\\d\\a.pdf", 2);
    const run = createPdfProjectFrom([a, pdf("C:\\d\\gone.pdf", "invalid")], () => gone);
    gone = true;
    expect(await run).toBeNull();
    expect(m.saved).toEqual([]);
    expect(m.errors).toEqual([]);
  });

  it("says which PDF was left out when the pages would not fit", async () => {
    const big = pdf("C:\\d\\big.pdf", 9_999);
    const more = pdf("C:\\d\\more.pdf", 5);
    await createPdfProjectFrom([big, more], live);
    expect(m.refusals).toEqual(["more was left out: a PDF project holds up to 10000 pages."]);
    expect(m.saved[0]!.project.pdf!.pages).toHaveLength(9_999);
  });
});
