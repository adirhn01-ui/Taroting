// PDF projects at the edges of the app: creating one (a PDF opened as a
// project from Home, Explorer or the viewer) and telling one apart.
//
// NOT at boot: open-media fetches it with a dynamic import only when a PDF is
// opened as a project — keep it that way (no static import from main, Home or
// open-media). It must stay tiny and must NEVER import anything under
// src/pdf/** or pdf.js: every path that reaches it runs before the PDF editor
// is wanted, and one such import would drag the editor (and pdf.js) in with it.
//
// Loading a PDF project is NOT here: the sanitizer (`sanitizePdfMeta`) and the
// invariants live in core/project.ts, because ipc.loadProject runs them on the
// boot path before any editor is dispatched.

import type { PdfPage, ProjectFile } from "./types";
import { DEFAULT_EXPORT_PRESET, PDF_MAX_PAGES, PDF_SCHEMA } from "./types";
import { uid } from "./project";
import { emptyPdfTimeline } from "./pdf-sanitize";

/** What the caller knows about the PDF: the backend's stat (identity) and
 *  pdf.js's page count. */
export interface PdfSourceInfo {
  path: string;
  size: number;
  mtimeMs: number;
  pages: number;
}

/** A NEW PDF project of one source: schema 4, kind "pdf", no media, the empty
 *  timeline (`emptyPdfTimeline`), the default video export preset (opaque
 *  here — the file shape is shared and the Rust loader types that field), and
 *  `pdf` = that source, one page per source page in order (rotate 0, fresh
 *  ids), no marks, no form values.
 *
 *  Throws a RangeError when `pages` is not an integer in 1..PDF_MAX_PAGES — a
 *  project the loader would refuse must never be written; the message is
 *  written for the person opening the file. `opts` exist for tests: a fixed
 *  clock and a deterministic id source. */
export function createPdfProject(
  name: string,
  source: PdfSourceInfo,
  opts?: { now?: Date; id?: () => string },
): ProjectFile {
  const { pages: count } = source;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("This PDF has no pages to open.");
  }
  if (count > PDF_MAX_PAGES) {
    throw new RangeError(
      `This PDF has ${count} pages; a PDF project can hold up to ${PDF_MAX_PAGES}.`,
    );
  }
  const id = opts?.id ?? uid;
  const now = (opts?.now ?? new Date()).toISOString();
  const srcId = id();
  const pages: PdfPage[] = [];
  for (let i = 0; i < count; i++) pages.push({ id: id(), src: srcId, page: i, rotate: 0 });
  return {
    // 4 marks a PDF project and nothing else (the Rust `migrate()` pairs it
    // with `kind: "pdf"`, as it pairs 3 with "image").
    schema: PDF_SCHEMA,
    kind: "pdf",
    app: "taroting",
    id: id(),
    name,
    createdAt: now,
    modifiedAt: now,
    media: [],
    timeline: emptyPdfTimeline(id()),
    export: { ...DEFAULT_EXPORT_PRESET },
    pdf: {
      sources: [
        { id: srcId, path: source.path, size: source.size, mtimeMs: source.mtimeMs, pages: count },
      ],
      pages,
      annots: Object.create(null) as Record<string, never>,
      forms: Object.create(null) as Record<string, never>,
    },
  };
}

/** The one test for "is this a PDF project". */
export function isPdfProject(p: ProjectFile): boolean {
  return p.kind === "pdf";
}

/** Every file a PDF project READS — each source PDF and every picture in its
 *  media (in a PDF project `media` holds only the pictures image marks use) —
 *  de-duplicated, in first-seen order. Export refuses to write over any of
 *  these. Case-sensitive: the export side compares by its own rule. Empty for
 *  any other kind of project. */
export function pdfSourcePaths(p: ProjectFile): string[] {
  if (p.kind !== "pdf" || !p.pdf) return [];
  const seen = new Set<string>();
  for (const s of p.pdf.sources) seen.add(s.path);
  for (const m of p.media) seen.add(m.path);
  return [...seen];
}
