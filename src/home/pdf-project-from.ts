// Home's PDF projects: one or more PDFs, chosen with "New project → PDF
// project", Open, or a drop, become ONE real library project in
// Documents\Taroting (never a temporary one — Home's New and Open are the
// permanent way in), its pages in the order the files came.
//
// Its own lazy chunk, fetched by Home only when there are PDFs to make a
// project of. Everything PDF-specific is fetched from HERE with dynamic
// imports, and only once the first file has been found on disk: the page
// counter pulls pdf.js, and pdf-project / the page model are only wanted on
// this path. Home itself must never import any of them (the boundary test in
// src/dev/image-chunk-boundary.test.ts pins that).
//
// The stat → page count → error mapping mirrors core/open-media's pdfProject
// (which makes a TEMPORARY project and is not exported); keep the two saying
// the same words.

import { fileStem } from "../core/format";
import { describeError, ipc } from "../core/ipc";
import { uid } from "../core/project";
import { PDF_MAX_PAGES } from "../core/types";
import type { ProjectFile } from "../core/types";
import { toast } from "../ui/toast";

/** Said for a file that is gone, or that the backend cannot stat. The same
 *  words core/open-media and the backend use for a missing PDF. */
export const PDF_MISSING = "This PDF is missing or can't be read.";
/** Said for one password-protected PDF: Home makes nothing of it. */
export const PDF_PROTECTED = "Protected PDFs can't be edited — open it to read it instead.";

/** Several protected PDFs in one pick or drop: skipped, said once. */
export function protectedSkippedText(n: number): string {
  return n === 1
    ? "Skipped 1 protected PDF — protected PDFs can't be edited. Open it to read it instead."
    : `Skipped ${n} protected PDFs — protected PDFs can't be edited. Open them to read them instead.`;
}

/** One PDF that went into the project: its identity and page count. */
interface Readable {
  path: string;
  size: number;
  mtimeMs: number;
  pages: number;
}

type ReadResult = { ok: Readable } | { protectedPdf: true } | { failed: true };

/** The kind a PdfOpenError (or anything else pdf.js threw) carries. */
function openErrorKind(e: unknown): unknown {
  return e && typeof e === "object" && "kind" in e ? (e as { kind: unknown }).kind : null;
}

/** Stat, then count the pages. A missing file stops at the stat, before
 *  pdf.js is ever fetched. Every failure but "protected" is reported here, in
 *  Home's words; "protected" is left to the caller, which knows how many. */
async function readPdf(path: string, gone: () => boolean): Promise<ReadResult | null> {
  const stem = fileStem(path);
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await ipc.fileStat(path);
  } catch {
    stat = null;
  }
  if (gone()) return null;
  if (!stat) {
    toast.error(PDF_MISSING);
    return { failed: true };
  }
  let pages: number;
  try {
    const { countPages } = await import("../pdf/view/loader");
    pages = await countPages(path);
  } catch (e) {
    if (gone()) return null;
    const kind = openErrorKind(e);
    if (kind === "password") return { protectedPdf: true };
    if (kind === "missing") toast.error(PDF_MISSING);
    else if (kind === "invalid") toast.error(`Couldn't read ${stem} as a PDF.`);
    else if (kind === "other") {
      const message = (e as { message?: unknown }).message;
      toast.error(`Couldn't open ${stem}: ${typeof message === "string" && message ? message : "it isn't a readable PDF."}`);
    } else toast.error(`Couldn't open ${stem}: ${describeError(e)}`);
    return { failed: true };
  }
  if (gone()) return null;
  return { ok: { path, size: stat.size, mtimeMs: stat.mtimeMs, pages } };
}

/** Reads every PDF in order, drops (and names, in a toast) any that is
 *  missing, protected or unreadable, and saves ONE PDF project of the rest:
 *  the first readable PDF makes it (and names it), each further one's pages
 *  follow in the order given. Returns the new project's path, or null when
 *  nothing was made. `gone` is asked after every await: a Home that has been
 *  left makes nothing and says nothing. */
export async function createPdfProjectFrom(
  paths: readonly string[],
  gone: () => boolean,
): Promise<string | null> {
  const readable: Readable[] = [];
  let protectedCount = 0;
  for (const path of paths) {
    const r = await readPdf(path, gone);
    if (r === null) return null;
    if ("ok" in r) readable.push(r.ok);
    else if ("protectedPdf" in r) protectedCount++;
  }
  if (protectedCount > 0) {
    // Declined, not failed: the file is fine, it just cannot be edited.
    toast.info(paths.length === 1 ? PDF_PROTECTED : protectedSkippedText(protectedCount));
  }
  if (readable.length === 0) return null;

  const [first, ...rest] = readable as [Readable, ...Readable[]];
  const { createPdfProject } = await import("../core/pdf-project");
  if (gone()) return null;
  const projectPath = await ipc.newProjectPath(fileStem(first.path));
  if (gone()) return null;
  let project: ProjectFile;
  try {
    // Named after the file the backend picked, so a de-duplicated "Report (2)"
    // reads the same on the card as on disk.
    project = createPdfProject(fileStem(projectPath), first);
  } catch (e) {
    // A RangeError written for the user (no pages, too many pages).
    toast.error(describeError(e));
    return null;
  }
  if (rest.length > 0) {
    const { insertSourcePages } = await import("../pdf/model");
    if (gone()) return null;
    for (const pdf of rest) {
      const at = project.pdf?.pages.length ?? 0;
      const next = insertSourcePages(project, at, { id: uid(), ...pdf });
      // The model refuses by handing the same project back: here, only
      // because the pages would not fit. Said, never dropped silently.
      if (next === project) {
        toast.refuse(`${fileStem(pdf.path)} was left out: a PDF project holds up to ${PDF_MAX_PAGES} pages.`);
        continue;
      }
      project = next;
    }
  }
  await ipc.saveProject(projectPath, project);
  return projectPath;
}
