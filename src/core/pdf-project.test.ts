import { describe, expect, it } from "vitest";
import "./pdf-sanitize"; // registers the PDF rules sanitizeProject dispatches to
import { createPdfProject, isPdfProject, pdfSourcePaths } from "./pdf-project";
import { checkInvariants, createProject, sanitizeProject } from "./project";
import type { MediaRef, ProjectFile } from "./types";
import { DEFAULT_EXPORT_PRESET, PDF_MAX_PAGES } from "./types";

const SRC = { path: "C:\\Docs\\lease.pdf", size: 1234, mtimeMs: 5678, pages: 3 };

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

describe("createPdfProject", () => {
  it("builds a schema-4 pdf project with one page per source page", () => {
    const now = new Date("2026-10-17T10:00:00.000Z");
    const p = createPdfProject("Lease", SRC, { now, id: counter() });
    expect(p.schema).toBe(4);
    expect(p.kind).toBe("pdf");
    expect(p.app).toBe("taroting");
    expect(p.name).toBe("Lease");
    expect(p.createdAt).toBe("2026-10-17T10:00:00.000Z");
    expect(p.modifiedAt).toBe(p.createdAt);
    expect(p.media).toEqual([]);
    expect(p.export).toEqual(DEFAULT_EXPORT_PRESET);
    expect(p.export).not.toBe(DEFAULT_EXPORT_PRESET);
    const pdf = p.pdf!;
    expect(pdf.sources).toEqual([{ id: "id1", path: SRC.path, size: 1234, mtimeMs: 5678, pages: 3 }]);
    expect(pdf.pages).toEqual([
      { id: "id2", src: "id1", page: 0, rotate: 0 },
      { id: "id3", src: "id1", page: 1, rotate: 0 },
      { id: "id4", src: "id1", page: 2, rotate: 0 },
    ]);
    expect(Object.keys(pdf.annots)).toEqual([]);
    expect(Object.keys(pdf.forms)).toEqual([]);
    expect(pdf.export).toBeUndefined();
  });

  it("gives every id a fresh value by default", () => {
    const p = createPdfProject("Lease", SRC);
    const ids = [p.id, p.timeline.tracks[0]!.id, ...p.pdf!.sources.map((s) => s.id), ...p.pdf!.pages.map((pg) => pg.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries an empty timeline that passes the invariants unchanged", () => {
    const p = createPdfProject("Lease", SRC);
    expect(p.timeline.tracks).toHaveLength(1);
    expect(p.timeline.tracks[0]!.kind).toBe("video");
    expect(p.timeline.tracks[0]!.clips).toEqual([]);
    expect(checkInvariants(p)).toEqual([]);
  });

  it("survives a save/load round trip as the same document", () => {
    const p = createPdfProject("Lease", SRC);
    const loaded = sanitizeProject(JSON.parse(JSON.stringify(p)) as ProjectFile);
    expect(loaded).toEqual(p);
    // the timeline was already the empty one, so it is kept as read
    expect(checkInvariants(loaded)).toEqual([]);
  });

  it("makes annots and forms prototype-free records", () => {
    const p = createPdfProject("Lease", SRC);
    expect(Object.getPrototypeOf(p.pdf!.annots)).toBeNull();
    expect(Object.getPrototypeOf(p.pdf!.forms)).toBeNull();
  });

  it("refuses a page count the loader would refuse", () => {
    for (const pages of [0, -1, 1.5, NaN, PDF_MAX_PAGES + 1]) {
      expect(() => createPdfProject("x", { ...SRC, pages })).toThrow(RangeError);
    }
    expect(createPdfProject("x", { ...SRC, pages: PDF_MAX_PAGES }).pdf!.pages).toHaveLength(PDF_MAX_PAGES);
  });
});

describe("isPdfProject", () => {
  it("is true only for kind pdf", () => {
    expect(isPdfProject(createPdfProject("x", SRC))).toBe(true);
    expect(isPdfProject(createProject("x"))).toBe(false);
    expect(isPdfProject({ ...createProject("x"), schema: 3, kind: "image" })).toBe(false);
  });
});

describe("pdfSourcePaths", () => {
  const pic: MediaRef = {
    id: "m1",
    path: "C:\\Pics\\stamp.png",
    size: 1,
    mtimeMs: 1,
    kind: "image",
    duration: 0,
    hasAudio: false,
  };

  it("lists every source and every picture, de-duplicated in order", () => {
    const p = createPdfProject("x", SRC);
    const q: ProjectFile = {
      ...p,
      media: [pic, { ...pic, id: "m2" }],
      pdf: {
        ...p.pdf!,
        sources: [
          ...p.pdf!.sources,
          { id: "s2", path: "C:\\Docs\\annex.pdf", size: 1, mtimeMs: 1, pages: 1 },
          { id: "s3", path: SRC.path, size: 9, mtimeMs: 9, pages: 1 },
        ],
      },
    };
    expect(pdfSourcePaths(q)).toEqual([SRC.path, "C:\\Docs\\annex.pdf", pic.path]);
  });

  it("is empty for a project that is not a PDF project", () => {
    const v = createProject("v");
    expect(pdfSourcePaths({ ...v, media: [pic] })).toEqual([]);
  });
});
