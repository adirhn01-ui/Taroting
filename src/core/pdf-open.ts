// Reading a PDF to make a project of it: the ONE copy of stat → page count →
// what went wrong, shared by core/open-media (a TEMPORARY project, from
// Explorer or the viewer) and home/pdf-project-from (Home's library project).
// Each caller words the failures its own way; what counts as which failure is
// decided only here.
//
// NOT at boot: open-media and pdf-project-from both reach it with a dynamic
// import (open-media is on the boot path; the boundary test in
// src/dev/image-chunk-boundary.test.ts pins that). pdf.js and pdf-project are
// fetched from here, again dynamically, only once the file is known to exist.

import { fileStem } from "./format";
import { ipc } from "./ipc";
import type { PdfSourceInfo } from "./pdf-project";
import type { ProjectFile } from "./types";

/** Said for a file that is gone, or that the backend cannot stat: the words
 *  the backend (media/source.rs) uses for a missing PDF. */
export const PDF_MISSING = "This PDF is missing or can't be read.";

/** A PDF read for a project: its identity and page count, or why not.
 *  `problem` "other" carries pdf.js's own words (`message`, possibly empty). */
export type PdfRead =
  | { ok: PdfSourceInfo }
  | { problem: "missing" | "protected" | "invalid" }
  | { problem: "other"; message: string };

/** Stat, then count the pages. A missing file (or a stat that fails) stops at
 *  the stat, before pdf.js is ever fetched. Anything that is not a PdfOpenError
 *  (a chunk that failed to load) is thrown as it is. `gone` is asked after each
 *  await: true makes the read return null and stop. */
export async function readPdfSource(path: string, gone: () => boolean = () => false): Promise<PdfRead | null> {
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await ipc.fileStat(path);
  } catch {
    stat = null;
  }
  if (gone()) return null;
  if (!stat) return { problem: "missing" };
  let pages: number;
  try {
    const { countPages } = await import("../pdf/view/loader");
    pages = await countPages(path);
  } catch (e) {
    if (gone()) return null;
    const kind = e && typeof e === "object" && "kind" in e ? (e as { kind: unknown }).kind : null;
    if (kind === "password") return { problem: "protected" };
    if (kind === "missing" || kind === "invalid") return { problem: kind };
    if (kind === "other") {
      const message = (e as { message?: unknown }).message;
      return { problem: "other", message: typeof message === "string" ? message : "" };
    }
    throw e;
  }
  if (gone()) return null;
  return { ok: { path, size: stat.size, mtimeMs: stat.mtimeMs, pages } };
}

/** The temporary PDF project open-media makes of `path`, named `name`. A
 *  failure is thrown as an Error in words; a protected PDF throws `protectedError`
 *  (open-media's PdfProtectedError, built there so the class stays on the boot
 *  path without this chunk). */
export async function pdfTempProject(
  name: string,
  path: string,
  protectedError: (path: string) => Error,
): Promise<ProjectFile> {
  const read = (await readPdfSource(path))!;
  if ("problem" in read) {
    const unreadable = `Couldn't read ${fileStem(path)} as a PDF.`;
    switch (read.problem) {
      case "protected":
        throw protectedError(path);
      case "missing":
        throw new Error(PDF_MISSING);
      case "invalid":
        throw new Error(unreadable);
      case "other":
        throw new Error(read.message || unreadable);
    }
  }
  const { createPdfProject } = await import("./pdf-project");
  return createPdfProject(name, read.ok);
}
