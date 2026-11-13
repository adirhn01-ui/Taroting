// Home's PDF projects: PDFs and pictures, chosen with "New project → PDF
// project", Open, or a drop, in any mix — or pictures alone, through "Open as
// → PDF project" (every picture a page) — become ONE real library project in
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

import { fileExt, fileStem } from "../core/format";
import { describeError, ipc, pickPdfAndPictureFiles } from "../core/ipc";
import { PDF_MISSING, readPdfSource } from "../core/pdf-open";
import type { PdfSourceInfo } from "../core/pdf-project";
import { stillSizeProblem } from "../core/open-media";
import type { PicturePageSizing } from "../core/picture-page";
import { uid } from "../core/project";
import { DEFAULT_EXPORT_PRESET, DOCUMENT_FILE_EXTENSIONS, PDF_MAX_PAGES, PDF_SCHEMA } from "../core/types";
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

/** "New project → PDF project": any number of PDFs and pictures from one
 *  picker (none when cancelled), as the picker hands them back; Home applies
 *  the allowlist and the name order. */
export async function pickNewPdfProjectFiles(): Promise<string[]> {
  return pickPdfAndPictureFiles();
}

/** Whether Home reads this file as a PDF (else as a picture). */
function isPdfPath(path: string): boolean {
  return DOCUMENT_FILE_EXTENSIONS.has(fileExt(path));
}

/** One picture probed for a page. Every failure is said here in the words
 *  "Open as → PDF project" uses; null: Home is gone. */
async function readPicture(path: string, gone: () => boolean): Promise<MediaInfo | "failed" | null> {
  const stem = fileStem(path);
  let info: MediaInfo;
  try {
    info = await ipc.probeMedia(path);
  } catch (e) {
    if (gone()) return null;
    toast.error(`Couldn't open ${stem}: ${describeError(e)}`);
    return "failed";
  }
  if (gone()) return null;
  const problem =
    info.kind !== "image" || info.generator ? `${stem} is not a still picture, so it was left out.` : stillSizeProblem(info);
  if (problem) {
    toast.refuse(problem);
    return "failed";
  }
  return info;
}

/** Said once when pictures did not fit after the pages already in. */
export function picturesLeftOutText(n: number): string {
  return n === 1
    ? `1 picture was left out: a PDF project holds up to ${PDF_MAX_PAGES} pages.`
    : `${n} pictures were left out: a PDF project holds up to ${PDF_MAX_PAGES} pages.`;
}

type Part = { pdf: Readable } | { picture: MediaInfo };

/** Why a PDF among other files cannot go in after `pagesSoFar` pages, in
 *  the words the user reads; null when it fits. */
function pdfLeftOutText(pdf: Readable, pagesSoFar: number): string | null {
  const stem = fileStem(pdf.path);
  if (!Number.isInteger(pdf.pages) || pdf.pages < 1) return `${stem} was left out: it has no pages.`;
  if (pagesSoFar + pdf.pages > PDF_MAX_PAGES) return `${stem} was left out: a PDF project holds up to ${PDF_MAX_PAGES} pages.`;
  return null;
}

/** PDFs and pictures, in any mix, to ONE PDF project, in the order given:
 *  a PDF gives every page, a picture one page at its own size ("Picture
 *  size", core/picture-page). Reads every file first, drops (and names, in a
 *  toast) any that is missing, protected, unreadable or not a still picture,
 *  then saves the project, named after the first file that could be used.
 *  What does not fit under PDF_MAX_PAGES is said, never dropped silently.
 *  Returns the new project's path, or null when nothing was made. `gone` is
 *  asked after every await: a Home that has been left makes nothing and says
 *  nothing. */
export async function createPdfProjectFromFiles(
  paths: readonly string[],
  gone: () => boolean,
): Promise<string | null> {
  const parts: Part[] = [];
  let protectedCount = 0;
  let pictureCount = 0;
  for (const path of paths) {
    if (isPdfPath(path)) {
      const r = await readPdf(path, gone);
      if (r === null) return null;
      if ("ok" in r) parts.push({ pdf: r.ok });
      else if ("protectedPdf" in r) protectedCount++;
    } else {
      pictureCount++;
      const r = await readPicture(path, gone);
      if (r === null) return null;
      if (r !== "failed") parts.push({ picture: r });
    }
  }
  if (protectedCount > 0) {
    // Declined, not failed: the file is fine, it just cannot be edited.
    toast.info(paths.length === 1 ? PDF_PROTECTED : protectedSkippedText(protectedCount));
  }
  if (parts.length === 0) {
    // Pictures alone: the sentence "Open as → PDF project" says. Each PDF's
    // own failure has already been said.
    if (pictureCount > 0 && pictureCount === paths.length) {
      toast.refuse("None of the pictures could be opened, so no project was made.");
    }
    return null;
  }

  // The page model is wanted only when something is added to a first file.
  const needModel = parts.length > 1 || "picture" in parts[0]!;
  const [{ createPdfProject }, model] = await Promise.all([
    import("../core/pdf-project"),
    needModel ? import("../pdf/model") : Promise.resolve(null),
  ]);
  if (gone()) return null;
  // Built first, named once the file is: the project is named after the
  // first file that actually made it in, whatever came before it.
  let project: ProjectFile | null = null;
  let firstPath = "";
  let picturesLeftOut = 0;
  for (let i = 0; i < parts.length; ) {
    const part = parts[i]!;
    const at = project?.pdf?.pages.length ?? 0;
    if ("pdf" in part) {
      i++;
      const stem = fileStem(part.pdf.path);
      if (parts.length === 1) {
        // One PDF alone: its own words, as always.
        try {
          project = createPdfProject(stem, part.pdf);
        } catch (e) {
          // A RangeError written for the user (no pages, too many pages).
          toast.error(describeError(e));
          return null;
        }
        firstPath = part.pdf.path;
        continue;
      }
      // Among other files a PDF that cannot go in is left out and named,
      // wherever it sorts: the rest still make the project.
      const why = pdfLeftOutText(part.pdf, at);
      if (why) {
        toast.refuse(why);
        continue;
      }
      if (!project) {
        project = createPdfProject(stem, part.pdf);
        firstPath = part.pdf.path;
        continue;
      }
      const next = model!.insertSourcePages(project, at, { id: uid(), ...part.pdf });
      // Pages and room were checked above; any other refusal is a file
      // the model could not take as a PDF.
      if (next === project) toast.error(`Couldn't read ${stem} as a PDF.`);
      else project = next;
      continue;
    }
    // A run of pictures goes in as one insert: as many as still fit.
    const run: MediaInfo[] = [];
    while (i < parts.length && "picture" in parts[i]!) run.push((parts[i++] as { picture: MediaInfo }).picture);
    const fit = run.slice(0, Math.max(0, PDF_MAX_PAGES - at));
    picturesLeftOut += run.length - fit.length;
    if (fit.length === 0) continue;
    const base: ProjectFile = project ?? (await emptyPdfProject(fileStem(fit[0]!.path)));
    if (gone()) return null;
    const next = model!.insertPicturePages(base, at, fit, "picture");
    if (next === base) {
      picturesLeftOut += fit.length;
      continue;
    }
    if (!project) firstPath = fit[0]!.path;
    project = next;
  }
  if (picturesLeftOut > 0) toast.refuse(picturesLeftOutText(picturesLeftOut));
  // Never write a project without pages.
  if (!project || (project.pdf?.pages.length ?? 0) === 0) return null;
  const projectPath = await ipc.newProjectPath(fileStem(firstPath));
  if (gone()) return null;
  // Named after the file the backend picked, so a de-duplicated "Report (2)"
  // reads the same on the card as on disk.
  project = { ...project, name: fileStem(projectPath) };
  await ipc.saveProject(projectPath, project);
  return projectPath;
}

/** PDFs only: the same making under the name its callers and tests know. */
export function createPdfProjectFrom(paths: readonly string[], gone: () => boolean): Promise<string | null> {
  return createPdfProjectFromFiles(paths, gone);
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
    const r = await readPicture(path, gone);
    if (r === null) return null;
    if (r !== "failed") infos.push(r);
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
