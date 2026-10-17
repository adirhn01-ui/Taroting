// The PDF project's source documents: opening them when the editor mounts,
// noticing one that is missing, changed on disk or locked with a password,
// and the calm dialog that points such a source at a file again (Locate) or
// closes the project.
//
// The project never holds a PDF's bytes, only its path and identity (size +
// mtime, like a video project's MediaRef). A source whose identity no longer
// matches still opens when it can — its pages show — but it is listed in the
// dialog: Locate on the same file accepts its new identity.

import { fileName } from "../../core/format";
import { ipc, pickPdfFiles } from "../../core/ipc";
import { isPdfFilePath } from "../../core/pdf-sanitize";
import type { ProjectSession } from "../../core/session";
import { PDF_MAX_PAGES } from "../../core/types";
import type { PdfSource, ProjectFile } from "../../core/types";
import { focusFirst, trapTab } from "../../ui/focus";
import { icon } from "../../ui/icons";
import type { PdfDoc } from "../types";
import { isPdfOpenError, openPdf } from "../view";
import { button, el } from "./el";

export type SourceProblem = "missing" | "changed" | "password" | "unreadable";

export interface SourceIssue {
  source: PdfSource;
  problem: SourceProblem;
  /** "changed" because the file opened with fewer pages than the project
   *  shows from it: its page count, and how many the project needs. On
   *  Continue the pages past the end are dropped (the shell's onContinue). */
  short?: { has: number; need: number };
}

/** What a source's file looks like now. */
export interface SourceStat {
  size: number;
  mtimeMs: number;
}

/* ------------------------------ pure ------------------------------ */

/** Why a source's file no longer matches what the project recorded, from its
 *  current stat (null = gone); null when it matches. */
export function statProblem(src: PdfSource, stat: SourceStat | null): "missing" | "changed" | null {
  if (!stat) return "missing";
  return stat.size === src.size && stat.mtimeMs === src.mtimeMs ? null : "changed";
}

/** The highest 0-based page index the project shows from `srcId`, or -1. */
export function maxPageUsed(p: ProjectFile, srcId: string): number {
  let max = -1;
  for (const pg of p.pdf?.pages ?? []) if (pg.src === srcId && pg.page > max) max = pg.page;
  return max;
}

/** Point source `srcId` at another file (or the same file with a new
 *  identity). Pure; returns `p` itself when refused: not a PDF project, an
 *  unknown source, an invalid path / size / mtime / page count, a page count
 *  that no longer covers every page the project shows from it, or nothing
 *  changing. Pages, marks and form values keep pointing at the same id. */
export function relinkSource(
  p: ProjectFile,
  srcId: string,
  next: { path: string; size: number; mtimeMs: number; pages: number },
): ProjectFile {
  const pdf = p.kind === "pdf" ? p.pdf : undefined;
  if (!pdf) return p;
  const i = pdf.sources.findIndex((s) => s.id === srcId);
  if (i < 0) return p;
  const ok = (v: number): boolean => Number.isFinite(v) && v >= 0;
  if (!isPdfFilePath(next.path) || !ok(next.size) || !ok(next.mtimeMs)) return p;
  if (!Number.isInteger(next.pages) || next.pages < 1 || next.pages > PDF_MAX_PAGES) return p;
  if (maxPageUsed(p, srcId) >= next.pages) return p;
  const cur = pdf.sources[i]!;
  if (cur.path === next.path && cur.size === next.size && cur.mtimeMs === next.mtimeMs && cur.pages === next.pages) {
    return p;
  }
  const sources = pdf.sources.slice();
  sources[i] = { id: cur.id, path: next.path, size: next.size, mtimeMs: next.mtimeMs, pages: next.pages };
  return { ...p, pdf: { ...pdf, sources } };
}

/** The problem an open failure stands for. */
function openProblem(e: unknown): SourceProblem {
  if (isPdfOpenError(e)) {
    if (e.kind === "password") return "password";
    if (e.kind === "missing") return "missing";
  }
  return "unreadable";
}

/* ------------------------------ opening ------------------------------ */

/** Stat and open one source. A changed file that still opens is returned
 *  WITH its issue, so its pages show while the dialog asks about it. `need`
 *  is how many pages the project shows from it (maxPageUsed + 1): the
 *  project's recorded page count is not trusted (a crafted .trt can claim
 *  any), the opened document's is — fewer than `need` is a "changed" file. */
export async function openSource(src: PdfSource, need = 0): Promise<{ doc: PdfDoc | null; issue: SourceIssue | null }> {
  let stat: SourceStat | null;
  try {
    stat = await ipc.fileStat(src.path);
  } catch {
    stat = null;
  }
  const changed = statProblem(src, stat);
  if (changed === "missing") return { doc: null, issue: { source: src, problem: "missing" } };
  try {
    const doc = await openPdf(src.id, src.path);
    if (doc.numPages < need) return { doc, issue: { source: src, problem: "changed", short: { has: doc.numPages, need } } };
    return { doc, issue: changed ? { source: src, problem: changed } : null };
  } catch (e) {
    return { doc: null, issue: { source: src, problem: openProblem(e) } };
  }
}

/** Open every source at once; `project` gives the pages each must hold. */
export async function openSources(
  sources: readonly PdfSource[],
  project?: ProjectFile,
): Promise<{ docs: Map<string, PdfDoc>; issues: SourceIssue[] }> {
  const results = await Promise.all(sources.map((s) => openSource(s, project ? maxPageUsed(project, s.id) + 1 : 0)));
  const docs = new Map<string, PdfDoc>();
  const issues: SourceIssue[] = [];
  for (const r of results) {
    if (r.doc) docs.set(r.doc.id, r.doc);
    if (r.issue) issues.push(r.issue);
  }
  return { docs, issues };
}

/* ------------------------------ the dialog ------------------------------ */

const PROBLEM_TEXT: Record<SourceProblem, string> = {
  missing: "Missing",
  changed: "Changed since it was added",
  password: "Protected with a password",
  unreadable: "Couldn't be opened",
};

export interface SourcesDialogOpts {
  session: ProjectSession;
  issues: readonly SourceIssue[];
  /** a source now opens from a (new) file: the shell swaps it in */
  onRelinked(srcId: string, doc: PdfDoc): void;
  /** "Close project": the shell leaves through its exits */
  onCloseProject(): void;
  /** Continue (also Esc, X, the backdrop): the user edits on. The shell drops
   *  the pages a short source does not have. Not called on Close project nor
   *  when the editor closes the dialog itself. */
  onContinue?(): void;
}

/**
 * The "some source PDFs need you" dialog. One row per source with Locate;
 * the footer offers Close project, or Continue (also Esc, X, backdrop) to
 * edit on — a source that stays missing shows blank pages. Returns the quiet
 * closer the shell's overlay registry calls on dispose.
 */
export function openSourcesDialog(opts: SourcesDialogOpts): () => void {
  const { session } = opts;
  const backdrop = el("div", { className: "modal-backdrop" });
  const closeX = button("btn--ghost btn--icon btn--sm", { title: "Close", label: "Close", icon: icon("x", 14) });
  const list = el("div", { className: "relink-list" });
  const closeProject = button("", { text: "Close project", attrs: { "data-close-project": "" } });
  const cont = button("btn--primary", { text: "Continue", attrs: { "data-continue": "" } });
  const intro = el("p", {
    className: "pdfed-sources__intro",
    text:
      opts.issues.length === 1
        ? "One of the PDFs this project is made from can't be used as it was. Locate it to carry on."
        : "Some of the PDFs this project is made from can't be used as they were. Locate them to carry on.",
  });
  backdrop.appendChild(
    el("div", { className: "modal relink-modal pdfed-sources", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Source PDFs" } }, [
      el("div", { className: "modal__header" }, [el("span", { text: "Source PDFs" }), closeX]),
      el("div", { className: "modal__body" }, [intro, list]),
      el("div", { className: "modal__footer" }, [closeProject, cont]),
    ]),
  );
  document.body.appendChild(backdrop);
  const releaseTrap = trapTab(backdrop);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    backdrop.remove();
  }
  /** Esc, the X and a click outside just close: removing pages is a real
   *  edit, so only the Continue button (which says it removes them) does it. */
  function dismiss(): void {
    close();
  }
  function carryOn(): void {
    if (closed) return;
    close();
    opts.onContinue?.();
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  }
  document.addEventListener("keydown", onKeydown, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) dismiss();
  });
  closeX.addEventListener("click", dismiss);
  cont.addEventListener("click", carryOn);
  closeProject.addEventListener("click", () => {
    close();
    opts.onCloseProject();
  });

  async function locate(src: PdfSource, row: HTMLElement, status: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    const setStatus = (text: string, bad: boolean): void => {
      status.className = `relink-row__status${bad ? " relink-row__status--bad" : ""}`;
      status.textContent = text;
    };
    const [path] = await pickPdfFiles(false);
    if (!path || closed) return;
    setStatus("Checking", false);
    let stat: SourceStat | null = null;
    try {
      stat = await ipc.fileStat(path);
    } catch {
      stat = null;
    }
    if (closed) return;
    if (!stat) {
      setStatus("That file can't be found", true);
      return;
    }
    let doc: PdfDoc;
    try {
      doc = await openPdf(src.id, path);
    } catch (e) {
      if (closed) return;
      const p = openProblem(e);
      setStatus(p === "password" ? "That PDF is protected with a password" : "That file couldn't be opened", true);
      return;
    }
    // Closed meanwhile (the user moved on, or the editor went): nothing
    // will use this document.
    if (closed) {
      void doc.destroy();
      return;
    }
    const need = maxPageUsed(session.project, src.id) + 1;
    if (need > doc.numPages) {
      void doc.destroy();
      setStatus(`That PDF has ${doc.numPages} ${doc.numPages === 1 ? "page" : "pages"}; this project uses ${need}`, true);
      return;
    }
    const info = { path, size: stat.size, mtimeMs: stat.mtimeMs, pages: doc.numPages };
    const next = relinkSource(session.project, src.id, info);
    const cur = session.project.pdf?.sources.find((s) => s.id === src.id);
    const same =
      !!cur && cur.path === path && cur.size === info.size && cur.mtimeMs === info.mtimeMs && cur.pages === info.pages;
    if (next === session.project && !same) {
      void doc.destroy();
      setStatus("That file can't be used here", true);
      return;
    }
    // A fix-up of where the file lives, not an edit step: undo never walks
    // a source back to a file that is gone.
    session.replace(next);
    opts.onRelinked(src.id, doc);
    row.classList.add("relink-row--resolved");
    setStatus("Found", false);
    btn.disabled = true;
    row.title = path;
    resolvedCount++;
    if (resolvedCount === opts.issues.length) close();
  }

  let resolvedCount = 0;
  for (const issue of opts.issues) {
    const src = issue.source;
    const text = issue.short
      ? `Changed: it now has ${issue.short.has} ${issue.short.has === 1 ? "page" : "pages"}; this project uses ${issue.short.need}. Continue removes the missing pages`
      : PROBLEM_TEXT[issue.problem];
    const status = el("div", { className: "relink-row__status relink-row__status--bad", text });
    const locateBtn = button("btn--sm", { icon: icon("folder", 14), text: "Locate", attrs: { "data-locate": "" } });
    const row = el("div", { className: "relink-row" }, [
      el("div", { className: "relink-row__info" }, [
        el("div", { className: "relink-row__name", text: fileName(src.path) }),
        el("div", { className: "relink-row__path", title: src.path, text: src.path }),
        status,
      ]),
      locateBtn,
    ]);
    locateBtn.addEventListener("click", () => void locate(src, row, status, locateBtn));
    list.appendChild(row);
  }
  focusFirst(backdrop, "[data-locate]");
  return close;
}
