import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, PdfAnnot, ProjectFile } from "../core/types";

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
  probes: new Map<string, MediaInfo | Error>(),
  /** called when a project is named: lets a test leave Home at that moment */
  onNewPath: null as null | (() => void),
}));
vi.mock("../core/ipc", () => ({
  ipc: {
    fileStat: async (p: string) => m.stats.get(p) ?? null,
    probeMedia: async (p: string) => {
      const v = m.probes.get(p);
      if (!v || v instanceof Error) throw v ?? new Error("no such file");
      return v;
    },
    newProjectPath: async (s?: string) => {
      m.onNewPath?.();
      return `C:\\Docs\\Taroting\\${s ?? "Untitled"} (2).trt`;
    },
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

const { createPdfProjectFrom, createPdfProjectFromFiles, createPdfProjectFromPictures, PDF_MISSING, PDF_PROTECTED, picturesLeftOutText } =
  await import("./pdf-project-from");
const { checkInvariants } = await import("../core/project");
await import("../core/pdf-sanitize");

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
  m.probes.clear();
  m.onNewPath = null;
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

describe("createPdfProjectFromPictures (0.9.5)", () => {
  const P = (name: string): string => `C:\\p\\${name}`;
  const DOCS = "C:\\Docs\\Taroting\\";
  const still = (path: string, w: number, h: number, patch: Partial<MediaInfo> = {}): MediaInfo => {
    const info: MediaInfo = { path, size: 100, mtimeMs: 200, kind: "image", duration: 0, width: w, height: h, hasAudio: false, ...patch };
    m.probes.set(path, info);
    return info;
  };

  it("saves ONE PDF project, a page per picture in the order given, sized as asked, named after the first", async () => {
    still(P("scan 1.jpg"), 1200, 1600);
    still(P("scan 2.png"), 1600, 900);
    const out = await createPdfProjectFromPictures([P("scan 1.jpg"), P("scan 2.png")], "letter", live);
    expect(out).toBe(DOCS + "scan 1 (2).trt");
    expect(m.saved).toHaveLength(1);
    const p = m.saved[0]!.project;
    expect([p.schema, p.kind, p.name]).toEqual([4, "pdf", "scan 1 (2)"]);
    expect(p.pdf!.sources).toEqual([]);
    // Letter, turned to each picture: portrait, then landscape
    expect(p.pdf!.pages.map((pg) => [pg.src, pg.w, pg.h])).toEqual([
      [null, 612, 792],
      [null, 792, 612],
    ]);
    const paths = p.pdf!.pages.map((pg) => {
      const a = p.pdf!.annots[pg.id]![0] as Extract<PdfAnnot, { t: "image" }>;
      expect(a.bg).toBe(true);
      return p.media.find((x) => x.id === a.media)!.path;
    });
    expect(paths).toEqual([P("scan 1.jpg"), P("scan 2.png")]);
    expect(checkInvariants(p)).toEqual([]);
  });

  it("names and skips what is not a readable still, and keeps the rest", async () => {
    m.probes.set(P("bad.jpg"), new Error("corrupt"));
    still(P("anim.webp"), 5, 5, { kind: "video" });
    still(P("ok.png"), 40, 30);
    const out = await createPdfProjectFromPictures([P("bad.jpg"), P("anim.webp"), P("ok.png")], "picture", live);
    expect(out).toBe(DOCS + "ok (2).trt");
    expect(m.errors).toEqual(["Couldn't open bad: corrupt"]);
    expect(m.refusals).toEqual(["anim is not a still picture, so it was left out."]);
    expect(m.saved[0]!.project.pdf!.pages.map((pg) => [pg.w, pg.h])).toEqual([[30, 22.5]]);
  });

  it("makes nothing when none can be read, or once Home is gone", async () => {
    expect(await createPdfProjectFromPictures([P("gone.jpg")], "a4", live)).toBeNull();
    expect(m.refusals).toEqual(["None of the pictures could be opened, so no project was made."]);
    still(P("a.jpg"), 10, 10);
    expect(await createPdfProjectFromPictures([P("a.jpg")], "a4", () => true)).toBeNull();
    expect(m.saved).toEqual([]);
  });
});

describe("createPdfProjectFromFiles: PDFs and pictures together (0.9.5)", () => {
  const still = (path: string, w: number, h: number, patch: Partial<MediaInfo> = {}): string => {
    m.probes.set(path, { path, size: 100 + w, mtimeMs: 300 + h, kind: "image", duration: 0, width: w, height: h, hasAudio: false, ...patch });
    return path;
  };
  /** Each page as [the PDF it comes from and its page] or [the picture's path, w, h]. */
  function pagesOf(p: ProjectFile): Array<[string, number] | [string, number, number]> {
    const meta = p.pdf!;
    const pathOf = new Map(meta.sources.map((s) => [s.id, s.path]));
    return meta.pages.map((pg) => {
      if (pg.src !== null) return [pathOf.get(pg.src)!, pg.page];
      const a = meta.annots[pg.id]![0] as Extract<PdfAnnot, { t: "image" }>;
      expect(a.bg).toBe(true);
      return [p.media.find((x) => x.id === a.media)!.path, pg.w!, pg.h!];
    });
  }

  it("interleaves every PDF's pages and a page per picture, in the order given, pictures at their own size", async () => {
    const a = pdf("C:\\d\\a cover.pdf", 2, 10);
    const b = still("C:\\d\\b photo.jpg", 40, 30);
    const c = pdf("C:\\d\\c body.pdf", 1, 20);
    const d = still("C:\\d\\d scan.png", 20, 60);
    const out = await createPdfProjectFromFiles([a, b, c, d], live);
    expect(out).toBe("C:\\Docs\\Taroting\\a cover (2).trt");
    const p = m.saved[0]!.project;
    // "Picture size": 0.75 pt per pixel, each picture's own shape.
    expect(pagesOf(p)).toEqual([
      [a, 0],
      [a, 1],
      [b, 30, 22.5],
      [c, 0],
      [d, 15, 45],
    ]);
    expect(p.name).toBe("a cover (2)");
    expect(checkInvariants(p)).toEqual([]);
    expect([m.errors, m.refusals, m.infos]).toEqual([[], [], []]);
  });

  it("starts from a picture when one comes first, and names the project after it", async () => {
    const b = still("C:\\d\\00 front.png", 80, 40);
    const a = pdf("C:\\d\\01 text.pdf", 1, 10);
    await createPdfProjectFromFiles([b, a], live);
    const p = m.saved[0]!.project;
    expect([p.schema, p.kind, p.name]).toEqual([4, "pdf", "00 front (2)"]);
    expect(pagesOf(p)).toEqual([
      [b, 60, 30],
      [a, 0],
    ]);
  });

  it("pictures alone make the same project, one page each", async () => {
    const x = still("C:\\d\\x.jpg", 12, 8);
    const y = still("C:\\d\\y.jpg", 8, 12);
    await createPdfProjectFromFiles([x, y], live);
    expect(pagesOf(m.saved[0]!.project)).toEqual([
      [x, 9, 6],
      [y, 6, 9],
    ]);
  });

  it("names and drops what cannot be used, PDFs and pictures alike, and keeps the rest", async () => {
    const locked = pdf("C:\\d\\locked.pdf", "password");
    const bad = "C:\\d\\bad.jpg";
    m.probes.set(bad, new Error("corrupt"));
    const anim = still("C:\\d\\anim.webp", 5, 5, { kind: "video" });
    const fake = pdf("C:\\d\\fake.pdf", "invalid");
    const ok = still("C:\\d\\ok.png", 40, 24);
    await createPdfProjectFromFiles([locked, bad, anim, fake, ok], live);
    expect(m.infos).toEqual(["Skipped 1 protected PDF — protected PDFs can't be edited. Open it to read it instead."]);
    expect(m.errors).toEqual(["Couldn't open bad: corrupt", "Couldn't read fake as a PDF."]);
    expect(m.refusals).toEqual(["anim is not a still picture, so it was left out."]);
    expect(pagesOf(m.saved[0]!.project)).toEqual([[ok, 30, 18]]);
    expect(m.saved[0]!.project.name).toBe("ok (2)");
  });

  it("makes nothing when no file can be used; pictures alone say so once more", async () => {
    expect(await createPdfProjectFromFiles(["C:\\d\\gone.jpg", "C:\\d\\gone 2.png"], live)).toBeNull();
    expect(m.refusals).toEqual(["None of the pictures could be opened, so no project was made."]);
    m.refusals = [];
    m.errors = [];
    // With a PDF among them each file's own words are all that is said.
    expect(await createPdfProjectFromFiles(["C:\\d\\gone.jpg", "C:\\d\\gone.pdf"], live)).toBeNull();
    expect(m.refusals).toEqual([]);
    expect(m.errors).toEqual(["Couldn't open gone: no such file", PDF_MISSING]);
    expect(m.saved).toEqual([]);
  });

  it("says how many pictures did not fit after the pages already in, and keeps those that did", async () => {
    const big = pdf("C:\\d\\big.pdf", 9_998);
    const p1 = still("C:\\d\\p1.png", 10, 10);
    const p2 = still("C:\\d\\p2.png", 11, 10);
    const p3 = still("C:\\d\\p3.png", 12, 10);
    const p4 = still("C:\\d\\p4.png", 13, 10);
    await createPdfProjectFromFiles([big, p1, p2, p3, p4], live);
    expect(m.refusals).toEqual([picturesLeftOutText(2)]);
    expect(picturesLeftOutText(2)).toBe("2 pictures were left out: a PDF project holds up to 10000 pages.");
    expect(picturesLeftOutText(1)).toBe("1 picture was left out: a PDF project holds up to 10000 pages.");
    const pages = pagesOf(m.saved[0]!.project);
    expect(pages).toHaveLength(10_000);
    expect(pages.slice(-2)).toEqual([
      [p1, 7.5, 7.5],
      [p2, 8.25, 7.5],
    ]);
  });

  it("a PDF that cannot go in is left out and named wherever it sorts; the rest still make the project", async () => {
    // First in name order, over the limit: before, the whole set was lost.
    const big = pdf("C:\\d\\a big.pdf", 12_000);
    const empty = pdf("C:\\d\\b empty.pdf", 0);
    const pic = still("C:\\d\\c photo.png", 40, 24);
    const tail = pdf("C:\\d\\d tail.pdf", 2, 30);
    const out = await createPdfProjectFromFiles([big, empty, pic, tail], live);
    expect(m.refusals).toEqual([
      "a big was left out: a PDF project holds up to 10000 pages.",
      "b empty was left out: it has no pages.",
    ]);
    expect(m.errors).toEqual([]);
    // Named after the first file that made it in, not the first file given.
    expect(out).toBe("C:\\Docs\\Taroting\\c photo (2).trt");
    const p = m.saved[0]!.project;
    expect(p.name).toBe("c photo (2)");
    expect(pagesOf(p)).toEqual([
      [pic, 30, 18],
      [tail, 0],
      [tail, 1],
    ]);
    expect(checkInvariants(p)).toEqual([]);
  });

  it("a first PDF left out hands the project to the next PDF, named after it", async () => {
    const big = pdf("C:\\d\\a big.pdf", 10_001);
    const next = pdf("C:\\d\\b next.pdf", 1, 40);
    await createPdfProjectFromFiles([big, next], live);
    expect(m.refusals).toEqual(["a big was left out: a PDF project holds up to 10000 pages."]);
    const p = m.saved[0]!.project;
    expect([p.name, p.pdf!.sources.map((s) => s.path)]).toEqual(["b next (2)", [next]]);
  });

  it("one PDF alone keeps its own words when it cannot be a project", async () => {
    expect(await createPdfProjectFromFiles([pdf("C:\\d\\huge.pdf", 12_000)], live)).toBeNull();
    expect(m.errors).toEqual(["This PDF has 12000 pages; a PDF project can hold up to 10000."]);
    expect(m.refusals).toEqual([]);
    expect(m.saved).toEqual([]);
  });

  it("a PDF after pictures that already filled the project is left out by name", async () => {
    const big = pdf("C:\\d\\a big.pdf", 9_999);
    const pic = still("C:\\d\\b photo.png", 16, 12);
    const late = pdf("C:\\d\\c late.pdf", 1, 50);
    await createPdfProjectFromFiles([big, pic, late], live);
    expect(m.refusals).toEqual(["c late was left out: a PDF project holds up to 10000 pages."]);
    const pages = pagesOf(m.saved[0]!.project);
    expect(pages).toHaveLength(10_000);
    expect(pages[9_999]).toEqual([pic, 12, 9]);
  });

  it("makes nothing once Home is gone while the project is being named", async () => {
    let gone = false;
    m.onNewPath = () => void (gone = true);
    const out = await createPdfProjectFromFiles([still("C:\\d\\a.png", 4, 6), pdf("C:\\d\\b.pdf", 1)], () => gone);
    expect(out).toBeNull();
    expect(m.saved).toEqual([]);
  });

  it("makes nothing and says nothing once Home is gone", async () => {
    let gone = false;
    const run = createPdfProjectFromFiles([still("C:\\d\\a.png", 4, 4), pdf("C:\\d\\b.pdf", "invalid")], () => gone);
    gone = true;
    expect(await run).toBeNull();
    expect(m.saved).toEqual([]);
    expect([m.errors, m.refusals]).toEqual([[], []]);
  });
});
