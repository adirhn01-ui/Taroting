// Home's PDF projects: one or more PDFs, chosen with "New project → PDF
// project", Open, or a drop — or pictures, through "Open as → PDF project"
// (every picture a page) — become ONE real library project in
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
import { stillSizeProblem } from "../core/open-media";
import type { PicturePageSizing } from "../core/picture-page";
import { uid } from "../core/project";
import { DEFAULT_EXPORT_PRESET, PDF_MAX_PAGES, PDF_SCHEMA } from "../core/types";
import type { MediaInfo, ProjectFile } from "../core/types";
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

/* ---------------- pictures → a PDF project (0.9.5) ---------------- */

/** A PDF project with no page yet, the shape `createPdfProject` gives a PDF
 *  (schema 4, kind "pdf", the empty timeline, the default export preset):
 *  only ever a step on the way, never saved without pages. */
async function emptyPdfProject(name: string): Promise<ProjectFile> {
  const { emptyPdfTimeline } = await import("../core/pdf-sanitize");
  const now = new Date().toISOString();
  return {
    schema: PDF_SCHEMA,
    kind: "pdf",
    app: "taroting",
    id: uid(),
    name,
    createdAt: now,
    modifiedAt: now,
    media: [],
    timeline: emptyPdfTimeline(uid()),
    export: { ...DEFAULT_EXPORT_PRESET },
    pdf: {
      sources: [],
      pages: [],
      annots: Object.create(null) as Record<string, never>,
      forms: Object.create(null) as Record<string, never>,
    },
  };
}

/** Home's "Open as → PDF project": every picture a page, in the order Home
 *  hands them over (natural name order), each page sized by `sizing`
 *  (core/picture-page). Probes every picture, drops (and names, in a toast)
 *  any that fails or is not a still with a size — the words "Open as → Image
 *  project" uses — and saves ONE real library project named after the first
 *  picture. Returns its path, or null when nothing was made. `gone` is asked
 *  after every await. */
export async function createPdfProjectFromPictures(
  paths: readonly string[],
  sizing: PicturePageSizing,
  gone: () => boolean,
): Promise<string | null> {
  const infos: MediaInfo[] = [];
  for (const path of paths) {
    const stem = fileStem(path);
    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(path);
    } catch (e) {
      if (gone()) return null;
      toast.error(`Couldn't open ${stem}: ${describeError(e)}`);
      continue;
    }
    if (gone()) return null;
    const problem =
      info.kind !== "image" || info.generator ? `${stem} is not a still picture, so it was left out.` : stillSizeProblem(info);
    if (problem) {
      toast.refuse(problem);
      continue;
    }
    infos.push(info);
  }
  if (infos.length === 0) {
    toast.refuse("None of the pictures could be opened, so no project was made.");
    return null;
  }
  if (infos.length > PDF_MAX_PAGES) {
    toast.refuse(`A PDF project holds up to ${PDF_MAX_PAGES} pages.`);
    return null;
  }
  const { insertPicturePages } = await import("../pdf/model");
  if (gone()) return null;
  const projectPath = await ipc.newProjectPath(fileStem(infos[0]!.path));
  if (gone()) return null;
  // Named after the file the backend picked, as for a PDF.
  const base = await emptyPdfProject(fileStem(projectPath));
  const project = insertPicturePages(base, 0, infos, sizing);
  // The model refuses only what was checked above; never write a project
  // without pages.
  if (project === base || (project.pdf?.pages.length ?? 0) === 0) return null;
  await ipc.saveProject(projectPath, project);
  return projectPath;
}
