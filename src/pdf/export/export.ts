// PDF export: a PDF project → the bytes of a NEW PDF → the chosen file.
//
//   1. pdf.js fills each source's form values and assembles the output's
//      source pages in order (assemble.ts, plan.ts).
//   2. pdf-lib inserts blank pages, turns pages, optionally flattens the form
//      (flatten.ts), adds the marks as annotations or page content
//      (marks.ts), and saves — always with updateFieldAppearances:false:
//      pdf-lib's own regeneration is Helvetica/WinAnsi and throws on any
//      non-Latin value; pdf.js already wrote the appearances.
//   3. the backend's chunked save writes the file (write.ts).
//
// A LAZY chunk: imported only when the user exports. pdf-lib, fontkit and
// bidi-js are reachable from nowhere else.

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, degrees } from "pdf-lib";
import type { PdfExportPreset, ProjectFile } from "../../core/types";
import { assemble } from "./assemble";
import { appDeps, type ExportDeps } from "./deps";
import { PdfExportError, baseName } from "./errors";
import { flattenForms } from "./flatten";
import { buildAppearance, markContext, pageGeom, placeAppearances, type Appearance } from "./marks";
import { planExtract } from "./plan";
import type { PdfSaveIpc } from "./write";
import { writePdf } from "./write";

export { PdfExportError } from "./errors";
export type { ExportDeps } from "./deps";

export interface PdfExportOptions extends PdfExportPreset {
  /** export only these OUTPUT pages, 1-based inclusive (extract / split) */
  range?: [number, number];
  /** by PdfSource.id, for a source that needs one (none in v1: projects with
   *  a password-protected source are refused when it is added) */
  passwords?: Record<string, string>;
}

/** A4 portrait, for a blank page whose size did not survive. */
const DEFAULT_BLANK: [number, number] = [595.28, 841.89];

function blankSize(w: number | undefined, h: number | undefined): [number, number] {
  const ok = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 14400;
  return ok(w) && ok(h) ? [w, h] : DEFAULT_BLANK;
}

/** The new PDF's bytes. */
export async function buildPdf(project: ProjectFile, opts: PdfExportOptions, deps: ExportDeps): Promise<Uint8Array> {
  const pdf = project.pdf;
  if (!pdf) throw new PdfExportError("empty", "This project has no PDF pages.");
  const plan = planExtract(pdf.pages, opts.range);

  // Every source the output reads: present, and the same file it was.
  const bytes = new Map<string, Uint8Array>();
  for (const id of new Set(plan.entries.map((e) => e.src))) {
    const src = pdf.sources.find((s) => s.id === id);
    if (!src) throw new PdfExportError("source-missing", "A page comes from a PDF that is no longer in the project.");
    const st = await deps.fileStat(src.path).catch(() => null);
    if (!st) {
      throw new PdfExportError("source-missing", `${baseName(src.path)} is missing. Put it back or relink it, then export again.`, src.path);
    }
    if (st.size !== src.size || Math.abs(st.mtimeMs - src.mtimeMs) >= 1) {
      throw new PdfExportError(
        "source-changed",
        `${baseName(src.path)} has changed since it was added. Reopen the project so its pages are checked again, then export.`,
        src.path,
      );
    }
    try {
      bytes.set(id, await deps.readBytes(src.path));
    } catch {
      throw new PdfExportError("source-missing", `${baseName(src.path)} could not be read.`, src.path);
    }
  }

  const assembled = await assemble(pdf, plan, async (id) => bytes.get(id)!, deps, opts.passwords);
  bytes.clear();

  const doc = assembled
    ? await PDFDocument.load(assembled, { updateMetadata: false })
    : await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);

  plan.pages.forEach((p, i) => {
    if (p.src === null) doc.insertPage(i, blankSize(p.w, p.h));
  });
  const pages = doc.getPages();
  if (pages.length !== plan.pages.length) {
    throw new PdfExportError("source-invalid", "Some pages could not be put together.");
  }

  plan.pages.forEach((p, i) => {
    const turn = p.rotate === 90 || p.rotate === 180 || p.rotate === 270 ? p.rotate : 0;
    if (!turn) return;
    const page = pages[i]!;
    const own = ((page.getRotation().angle % 360) + 360) % 360;
    page.setRotation(degrees((own + turn) % 360));
  });

  // Forms first: in a flattened export the marks paint over the fields, as
  // they sit on top of them in the editor.
  if (opts.flattenForms) flattenForms(doc);

  const cx = markContext(doc, project, deps);
  const now = deps.now();
  for (let i = 0; i < plan.pages.length; i++) {
    const marks = pdf.annots?.[plan.pages[i]!.id];
    if (!marks?.length) continue;
    const page = pages[i]!;
    const geom = pageGeom(page);
    const items: { id: string; app: Appearance }[] = [];
    for (const a of marks) {
      const app = await buildAppearance(a, geom, cx);
      if (app && app.ops) items.push({ id: a.id, app });
    }
    placeAppearances(doc, page, items, opts.flattenMarks, now);
  }

  doc.setModificationDate(now);
  return doc.save({ updateFieldAppearances: false, useObjectStreams: true });
}

/** Every file the project reads — the backend refuses to write over one. */
export function projectSources(project: ProjectFile): string[] {
  const out = new Set<string>();
  for (const s of project.pdf?.sources ?? []) out.add(s.path);
  for (const m of project.media) if (!m.generator && m.path) out.add(m.path);
  return [...out];
}

/** Build the PDF and write it to `target` (a path the user chose). */
export async function exportPdf(
  project: ProjectFile,
  opts: PdfExportOptions,
  target: string,
  deps?: ExportDeps,
  io?: PdfSaveIpc,
  onProgress?: (r: number) => void,
): Promise<{ path: string; pages: number; bytes: number }> {
  const d = deps ?? (await appDeps());
  const out = await buildPdf(project, opts, d);
  const saver = io ?? (await import("../../core/ipc")).ipc;
  const path = await writePdf(saver, target, projectSources(project), out, onProgress);
  const pages = planExtract(project.pdf!.pages, opts.range).pages.length;
  return { path, pages, bytes: out.length };
}
