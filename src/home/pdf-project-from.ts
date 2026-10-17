// Home's PDF projects: one or more PDFs, chosen with "New project → PDF
// project", Open, or a drop, become ONE real library project in
// Documents\Taroting (never a temporary one — Home's New and Open are the
// permanent way in), its pages in the order Home hands the files over (natural
// name order, see home.ts mediaRoute).
//
// Its own lazy chunk, fetched by Home only when there are PDFs to make a
// project of, or when "New project → PDF project" is chosen (the picker is
// here too, so Home carries none of this at boot). Everything PDF-specific is
// fetched from HERE with dynamic imports, and only once the first file has
// been found on disk: the page counter pulls pdf.js, and pdf-project / the
// page model are only wanted on this path. Home itself must never import any
// of them (the boundary test in src/dev/image-chunk-boundary.test.ts pins
// that).
//
// Reading a PDF (stat → page count → which failure) is core/pdf-open's, the
// one copy open-media uses too; only the words are Home's.

import { fileStem } from "../core/format";
import { describeError, ipc, pickPdfFiles } from "../core/ipc";
import { PDF_MISSING, readPdfSource } from "../core/pdf-open";
import type { PdfSourceInfo } from "../core/pdf-project";
import { uid } from "../core/project";
import { PDF_MAX_PAGES } from "../core/types";
import type { ProjectFile } from "../core/types";
import { toast } from "../ui/toast";

export { PDF_MISSING };
/** Said for one password-protected PDF: Home makes nothing of it. */
export const PDF_PROTECTED = "Protected PDFs can't be edited — open it to read it instead.";

/** Several protected PDFs in one pick or drop: skipped, said once. */
export function protectedSkippedText(n: number): string {
  return n === 1
    ? "Skipped 1 protected PDF — protected PDFs can't be edited. Open it to read it instead."
    : `Skipped ${n} protected PDFs — protected PDFs can't be edited. Open them to read them instead.`;
}

type Readable = PdfSourceInfo;
type ReadResult = { ok: Readable } | { protectedPdf: true } | { failed: true };

/** One PDF read for the project. Every failure but "protected" is reported
 *  here, in Home's words; "protected" is left to the caller, which knows how
 *  many. */
async function readPdf(path: string, gone: () => boolean): Promise<ReadResult | null> {
  const stem = fileStem(path);
  let read;
  try {
    read = await readPdfSource(path, gone);
  } catch (e) {
    if (gone()) return null;
    toast.error(`Couldn't open ${stem}: ${describeError(e)}`);
    return { failed: true };
  }
  if (read === null) return null;
  if ("ok" in read) return read;
  switch (read.problem) {
    case "protected":
      return { protectedPdf: true };
    case "missing":
      toast.error(PDF_MISSING);
      break;
    case "invalid":
      toast.error(`Couldn't read ${stem} as a PDF.`);
      break;
    case "other":
      toast.error(`Couldn't open ${stem}: ${read.message || "it isn't a readable PDF."}`);
      break;
  }
  return { failed: true };
}

/** "New project → PDF project": one PDF from the picker (none when cancelled). */
export async function pickNewPdf(): Promise<string[]> {
  return (await pickPdfFiles(false)).slice(0, 1);
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
