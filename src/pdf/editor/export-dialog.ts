// The PDF editor's Export dialog: the document as a new PDF (all pages or a
// range, marks and form fields optionally flattened), or one page as a
// picture (PNG / JPEG at 100-300 %), with "Open as image project".
//
// Mirrors the image editor's export dialog (src/image/export-dialog.ts) —
// the same `.export-*` rows, segmented controls, file name + folder row with
// Choose, overwrite strip with Replace / Rename, progress view, result views,
// remembered folder and run hold — so the three export dialogs read as one
// app. That module is NOT imported (it belongs to the image chunk); what this
// one needs of it is copied below with a note, or comes from the shared
// helpers it also uses (src/editor/export/export-dialog.ts, export-ipc.ts).
//
// What runs is never loaded until Export is pressed: the PDF export pipeline
// (pdf-lib) and the page renderer (pdf.js) are dynamic imports.

import "../../editor/export/export.css";
import "./export-dialog.css";
import { registerCloseTask } from "../../core/app-close";
import { createExportRunHold } from "../../core/export-hold";
import { escapeHtml, fileExt, fileStem } from "../../core/format";
import { errorDetail, ipc } from "../../core/ipc";
import { pdfSourcePaths } from "../../core/pdf-project";
import { settingsStore, updateSettings } from "../../core/session";
import type { PdfExportPreset, ProjectFile, Settings } from "../../core/types";
import {
  destinationProblem,
  isProjectSource,
  joinPath,
  MISSING_FOLDER,
  RENAME_ATTEMPT_LIMIT,
  renameWithSuffix,
  sanitizeFileName,
  splitPath,
} from "../../editor/export/export-dialog";
import {
  clearTaskbarProgress,
  pathExists,
  revealInExplorer,
  saveFileDialog,
  setTaskbarProgress,
} from "../../editor/export/export-ipc";
import { detailPane, recordError } from "../../ui/errors";
import { focusFirst, trapTab } from "../../ui/focus";
import { icon } from "../../ui/icons";
import { toast } from "../../ui/toast";
import type { PdfExportErrorCode } from "../export/errors";
import type { PdfSaveIpc } from "../export/write";
import { setExportPreset } from "../model";
import type { PdfEditorCtx } from "../types";
import { CANVAS_MAX_AREA } from "../view/math";
import { renderPageImage, saveImageBlob } from "./page-image";

/* ---------------- pure helpers (tested) ---------------- */

export type PdfExportTab = "pdf" | "image";
export type PageImageFormat = "png" | "jpeg";

export const FLATTEN_MARKS_TIP = "Draw marks into the page so they can't be moved or removed";
export const FLATTEN_FORMS_TIP = "Turn filled fields into plain text — they can't be edited afterwards";
export const PAGE_SOURCE_UNOPENED = "This page's PDF couldn't be opened.";
export const ORIGINAL_FILE_WARNING = "That's one of the project's own files — choose a different name. Originals are never changed.";

/** Quality JPEG opens on (the image export's default). */
export const DEFAULT_QUALITY = 92;
/** The Image tab's sizes: percent of the page at 96 dpi (its printed size on
 *  a 100 % display). */
export const IMAGE_SCALES = [100, 200, 300] as const;
export type ImageScale = (typeof IMAGE_SCALES)[number];
/** Longest side a page picture is written at. */
export const PAGE_IMAGE_MAX_SIDE = 8000;
/** A4 portrait, for a blank page without a usable size (the export's own
 *  fallback, src/pdf/export/export.ts DEFAULT_BLANK). */
const DEFAULT_BLANK: [number, number] = [595.28, 841.89];

export type RangeCheck = { ok: true; range: [number, number] | undefined } | { ok: false; error: string };

export const RANGE_NOT_NUMBERS = "Enter the first and last page as whole numbers.";
export const RANGE_REVERSED = "The first page must come before the last page.";
/** `name` (no extension), or "name (edited)", "name (edited 2)"… — the first
 *  whose `folder/name.pdf` is none of `taken` (compared like Windows paths:
 *  case-insensitive, either slash). */
export function nameClearOf(name: string, folder: string, taken: readonly string[]): string {
  const norm = (p: string): string => p.replace(/[\\\/]+/g, "/").toLowerCase();
  const used = new Set(taken.map(norm));
  const at = (n: string): string => norm(`${folder}/${n}.pdf`);
  if (!used.has(at(name))) return name;
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? `${name} (edited)` : `${name} (edited ${i})`;
    if (!used.has(at(n))) return n;
  }
  return `${name} (edited)`;
}

export function rangeOutside(count: number): string {
  return count === 1 ? "This document has only 1 page." : `Pages go from 1 to ${count}.`;
}

/** A typed "Pages from __ to __" (1-based, inclusive, over the CURRENT page
 *  order) → the export's range. A range that covers every page is the whole
 *  document (undefined). Refused: anything but whole numbers, a page outside
 *  1..count, and a reversed range. */
export function checkPageRange(from: string, to: string, count: number): RangeCheck {
  const f = from.trim();
  const t = to.trim();
  if (!/^\d{1,6}$/.test(f) || !/^\d{1,6}$/.test(t)) return { ok: false, error: RANGE_NOT_NUMBERS };
  const a = Number(f);
  const b = Number(t);
  if (a < 1 || b < 1 || a > count || b > count) return { ok: false, error: rangeOutside(count) };
  if (a > b) return { ok: false, error: RANGE_REVERSED };
  if (a === 1 && b === count) return { ok: true, range: undefined };
  return { ok: true, range: [a, b] };
}

/** A typed page number for the Image tab, or null. */
export function parsePageNumber(raw: string, count: number): number | null {
  const t = raw.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= count ? n : null;
}

/**
 * The pixel size of a page picture: the page box as SHOWN (turned by its own
 * /Rotate plus the project's), at 96 dpi × `scale` %, fitted so the long side
 * is at most PAGE_IMAGE_MAX_SIDE and the area within the engine's canvas
 * limit. Aspect is kept; `reduced` says the fit cut it down.
 */
export function pageImageSize(
  wPt: number,
  hPt: number,
  rotate: number,
  scale: number,
): { w: number; h: number; reduced: boolean } {
  const turned = ((rotate % 360) + 360) % 360 === 90 || ((rotate % 360) + 360) % 360 === 270;
  const bw = turned ? hPt : wPt;
  const bh = turned ? wPt : hPt;
  const k = (96 / 72) * (scale / 100);
  const w0 = Math.max(1, bw * k);
  const h0 = Math.max(1, bh * k);
  let fit = 1;
  fit = Math.min(fit, PAGE_IMAGE_MAX_SIDE / Math.max(w0, h0));
  fit = Math.min(fit, Math.sqrt(CANVAS_MAX_AREA / (w0 * h0)));
  if (fit >= 1) return { w: Math.max(1, Math.round(w0)), h: Math.max(1, Math.round(h0)), reduced: false };
  return { w: Math.max(1, Math.floor(w0 * fit)), h: Math.max(1, Math.floor(h0 * fit)), reduced: true };
}

/** Last export folder, else the default one, else the first source's folder
 *  (the image dialog's rule, with PDF sources). */
export function defaultPdfFolder(settings: Pick<Settings, "lastExportDir" | "defaultExportDir">, project: ProjectFile): string {
  if (settings.lastExportDir) return settings.lastExportDir;
  if (settings.defaultExportDir) return settings.defaultExportDir;
  const first = pdfSourcePaths(project)[0];
  return first ? splitPath(first).dir : "";
}

/** What each PDF export failure says when its own message is empty. */
export const PDF_EXPORT_MESSAGES: Readonly<Record<PdfExportErrorCode, string>> = {
  "source-missing": "A PDF this project uses is missing. Put it back, then export again.",
  "source-changed": "A PDF this project uses has changed since it was added. Reopen the project, then export again.",
  "source-invalid": "A PDF this project uses couldn't be read.",
  password: "A PDF this project uses is password-protected.",
  "font-missing": "A font one of the text boxes uses isn't installed on this PC.",
  "font-restricted": "A font in one of the text boxes can't go in a PDF because its license doesn't allow it, so pick another font for that text box.",
  "image-missing": "A picture on one of the pages is missing.",
  "image-invalid": "A picture on one of the pages couldn't be read.",
  range: "Those pages aren't in the document.",
  empty: "There are no pages to export.",
};

/** The backend's write refusals, said plainly. */
const BACKEND_MESSAGES: Readonly<Record<string, string>> = {
  bad_input: "That file can't be written — it may be one of the project's own files.",
  io: "The file couldn't be written. Check that the folder still exists and isn't read-only.",
};

/** Any export failure → what the dialog says, and the code kept for a report. */
export function describeExportFailure(e: unknown): { message: string; code: string } {
  const o = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (o && o.name === "PdfExportError" && typeof o.code === "string" && o.code in PDF_EXPORT_MESSAGES) {
    const own = typeof o.message === "string" ? o.message.trim() : "";
    return { message: own || PDF_EXPORT_MESSAGES[o.code as PdfExportErrorCode], code: o.code };
  }
  const d = errorDetail(e);
  const plain = d.code && BACKEND_MESSAGES[d.code];
  return { message: plain || d.message || "The export failed.", code: d.code };
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The export was canceled.", "AbortError");
}

/** The write path of exportPdf with a cancel on it: the build stops on
 *  opts.signal; the write stops here — a cancel refuses the next begin /
 *  chunk / commit, and writePdf then aborts the partial file. */
export function abortableSaveIpc(signal: AbortSignal): PdfSaveIpc {
  const guard = (): void => {
    if (signal.aborted) throw abortError();
  };
  return {
    pdfSaveBegin: async (dest, total) => {
      guard();
      return ipc.pdfSaveBegin(dest, total);
    },
    imageSaveChunk: async (token, bytes) => {
      guard();
      return ipc.imageSaveChunk(token, bytes);
    },
    imageSaveCommit: async (token) => {
      guard();
      return ipc.imageSaveCommit(token);
    },
    imageSaveAbort: (token) => ipc.imageSaveAbort(token),
  };
}

/** Inline check icon (the export dialogs' own, not part of the icon set). */
function checkIcon(size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
}

/** A focused control where Enter belongs to the control, not the dialog. */
function isTextField(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; type?: string } | null;
  const tag = el?.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return true;
  if (tag !== "INPUT") return false;
  const type = (el?.type ?? (t as HTMLElement).getAttribute?.("type") ?? "text").toLowerCase();
  return !["checkbox", "radio", "range"].includes(type);
}

/* ---------------- dialog ---------------- */

/** The open dialog's closer: opening a second one closes the first. */
let openCloser: (() => void) | null = null;

export interface PdfExportDialogOptions {
  /** 0-based slot: preselect that page (PDF: a one-page range; Image: the page) */
  pageSlot?: number;
  /** which tab opens (default "pdf"); "Export page as image" passes "image" */
  tab?: PdfExportTab;
}

export function openPdfExportDialog(ctx: PdfEditorCtx, opts?: PdfExportDialogOptions): void {
  openCloser?.();
  const session = ctx.session;
  const pages = (): number => session.project.pdf?.pages.length ?? 0;

  let tab: PdfExportTab = opts?.tab === "image" ? "image" : "pdf";
  const slot0 =
    typeof opts?.pageSlot === "number" && Number.isInteger(opts.pageSlot) && opts.pageSlot >= 0 && opts.pageSlot < pages()
      ? opts.pageSlot
      : null;

  // PDF tab
  const preset0: PdfExportPreset = session.project.pdf?.export ?? { flattenMarks: false, flattenForms: false };
  let flattenMarks = preset0.flattenMarks;
  let flattenForms = preset0.flattenForms;
  let rangeMode: "all" | "range" = slot0 !== null ? "range" : "all";
  let rangeFrom = String(slot0 !== null ? slot0 + 1 : 1);
  let rangeTo = String(slot0 !== null ? slot0 + 1 : Math.max(1, pages()));
  let pdfName = sanitizeFileName(session.project.name);

  // Image tab
  const current = Math.min(Math.max(0, ctx.view.state.get().current), Math.max(0, pages() - 1));
  let pageText = String((slot0 ?? current) + 1);
  let imgFormat: PageImageFormat = "png";
  let quality = DEFAULT_QUALITY;
  let scale: ImageScale = 100;
  let imgNameTouched = false;
  let imgName = defaultImageName(Number(pageText));
  /** the page box (points, as shown) of the Image tab's page, once known */
  let pageBox: { page: number; w: number; h: number; rotate: number } | null = null;

  let folder = defaultPdfFolder(settingsStore.get(), session.project);
  // The default folder is often the source PDF's own: never offer to write the
  // export over a file the project reads (the backend would refuse it).
  pdfName = nameClearOf(pdfName, folder, pdfSourcePaths(session.project));

  function defaultImageName(n: number): string {
    return sanitizeFileName(`${session.project.name} - page ${n}`);
  }

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal export-modal" role="dialog" aria-modal="true" aria-label="Export">
      <div class="modal__header">
        <span>Export</span>
        <button class="btn btn--ghost btn--icon btn--sm" data-close title="Close">${icon("x", 14)}</button>
      </div>
      <div class="modal__body" id="px-body"></div>
      <div class="modal__footer" id="px-footer"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const bodyEl = backdrop.querySelector<HTMLElement>("#px-body")!;
  const footerEl = backdrop.querySelector<HTMLElement>("#px-footer")!;
  const releaseTrap = trapTab(backdrop);

  let exporting = false;
  let closed = false;
  let run: AbortController | null = null;
  let running: Promise<void> | null = null;
  let lastTaskbarPct = -1;

  const runHold = createExportRunHold(session, registerCloseTask, async () => {
    run?.abort();
    await running?.catch(() => {});
  });
  const unregisterOverlay = ctx.registerOverlay(() => forceClose());

  function teardown(): void {
    if (closed) return;
    closed = true;
    runHold.release();
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    unregisterOverlay();
    if (lastTaskbarPct !== -1) void clearTaskbarProgress();
    backdrop.remove();
    if (openCloser === forceClose) openCloser = null;
  }

  /** Esc, the backdrop, X, Cancel and Close: never while an export runs. */
  function close(): void {
    if (exporting) return;
    teardown();
  }

  /** The editor going away (or a second dialog opening): abort and close. */
  function forceClose(): void {
    if (closed) return;
    run?.abort();
    exporting = false;
    teardown();
  }
  openCloser = forceClose;

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (exporting) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      if (exporting || isTextField(e.target)) return;
      const primary = q<HTMLButtonElement>("#px-run") ?? q<HTMLButtonElement>("[data-close-btn]");
      if (!primary || primary.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      primary.click();
    }
  }
  document.addEventListener("keydown", onKeydown, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("[data-close]")!.addEventListener("click", () => close());

  function q<T extends HTMLElement>(sel: string): T | null {
    return backdrop.querySelector<T>(sel);
  }

  function ext(): string {
    return tab === "pdf" ? "pdf" : imgFormat === "jpeg" ? "jpg" : "png";
  }
  function filename(): string {
    return tab === "pdf" ? pdfName : imgName;
  }
  function setFilename(v: string): void {
    if (tab === "pdf") pdfName = v;
    else {
      imgName = v;
      imgNameTouched = true;
    }
  }
  function outPath(): string {
    return joinPath(folder, `${filename()}.${ext()}`);
  }
  /** The project's own files as the overwrite check reads them. */
  function sourcesAsMedia(): { path: string }[] {
    return pdfSourcePaths(session.project).map((path) => ({ path }));
  }

  function rangeCheck(): RangeCheck {
    if (rangeMode === "all") return { ok: true, range: undefined };
    return checkPageRange(rangeFrom, rangeTo, pages());
  }
  function imagePage(): number | null {
    return parsePageNumber(pageText, pages());
  }
  function imageSize(): { w: number; h: number; reduced: boolean } | null {
    const n = imagePage();
    if (n === null || !pageBox || pageBox.page !== n) return null;
    return pageImageSize(pageBox.w, pageBox.h, pageBox.rotate, scale);
  }

  /** Why page `n` (1-based) has no picture to give, or null. */
  function pageProblem(n: number | null): string | null {
    if (n === null) return null;
    const pg = session.project.pdf?.pages[n - 1];
    if (!pg || pg.src === null) return null;
    return ctx.docs.has(pg.src) ? null : PAGE_SOURCE_UNOPENED;
  }

  /** The page box of page `n` (1-based) as the view shows it. */
  async function loadPageBox(n: number): Promise<void> {
    const pg = session.project.pdf?.pages[n - 1];
    if (!pg) return;
    let w: number;
    let h: number;
    let rotate: number = pg.rotate;
    if (pg.src === null) {
      const ok = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1;
      [w, h] = ok(pg.w) && ok(pg.h) ? [pg.w, pg.h] : DEFAULT_BLANK;
    } else {
      const doc = ctx.docs.get(pg.src);
      if (!doc) return;
      try {
        const info = await doc.pageInfo(pg.page);
        w = info.w;
        h = info.h;
        rotate += info.rotate;
      } catch {
        return;
      }
    }
    // Typed on meanwhile ("1" then "12"): an older answer must not replace
    // the box of the page now asked for.
    if (closed || imagePage() !== n) return;
    pageBox = { page: n, w, h, rotate };
    refresh();
  }

  /* ============================ FORM ============================ */

  function renderForm(): void {
    const n = pages();
    const tabs = `
      <div class="export-row">
        <label>Export as</label>
        <div class="export-seg" id="px-tab" role="tablist">
          <button class="btn ${tab === "pdf" ? "btn--on" : ""}" data-tab="pdf" role="tab" aria-selected="${tab === "pdf"}">PDF</button>
          <button class="btn ${tab === "image" ? "btn--on" : ""}" data-tab="image" role="tab" aria-selected="${tab === "image"}">Image</button>
        </div>
      </div>`;
    const pdfRows = `
      <div class="export-row">
        <label>Pages</label>
        <div class="export-seg" id="px-range-mode">
          <button class="btn ${rangeMode === "all" ? "btn--on" : ""}" data-range="all">All pages</button>
          <button class="btn ${rangeMode === "range" ? "btn--on" : ""}" data-range="range">Range</button>
        </div>
      </div>
      <div class="export-row ${rangeMode === "range" ? "" : "export-row--hidden"}" id="px-range-row">
        <label for="px-from">From</label>
        <div class="export-row__control">
          <input class="input export-num" id="px-from" type="number" min="1" max="${n}" step="1" value="${escapeHtml(rangeFrom)}" aria-label="First page" />
          <span class="export-dim-x">to</span>
          <input class="input export-num" id="px-to" type="number" min="1" max="${n}" step="1" value="${escapeHtml(rangeTo)}" aria-label="Last page" />
          <span class="pdfx-of">of ${n}</span>
        </div>
      </div>
      <div class="export-note" id="px-note-range" hidden></div>
      <div class="export-row" title="${escapeHtml(FLATTEN_MARKS_TIP)}">
        <label for="px-flat-marks">Flatten marks</label>
        <div class="export-row__control">
          <input class="switch" type="checkbox" id="px-flat-marks" ${flattenMarks ? "checked" : ""} />
        </div>
      </div>
      ${
        ctx.hasForms.get()
          ? `<div class="export-row" title="${escapeHtml(FLATTEN_FORMS_TIP)}">
        <label for="px-flat-forms">Flatten form fields</label>
        <div class="export-row__control">
          <input class="switch" type="checkbox" id="px-flat-forms" ${flattenForms ? "checked" : ""} />
        </div>
      </div>`
          : ""
      }`;
    const imageRows = `
      <div class="export-row">
        <label for="px-page">Page</label>
        <div class="export-row__control">
          <input class="input export-num" id="px-page" type="number" min="1" max="${n}" step="1" value="${escapeHtml(pageText)}" />
          <span class="pdfx-of">of ${n}</span>
        </div>
      </div>
      <div class="export-row">
        <label>Format</label>
        <div class="export-seg" id="px-format">
          <button class="btn ${imgFormat === "png" ? "btn--on" : ""}" data-format="png">PNG</button>
          <button class="btn ${imgFormat === "jpeg" ? "btn--on" : ""}" data-format="jpeg">JPEG</button>
        </div>
      </div>
      <div class="export-row ${imgFormat === "jpeg" ? "" : "export-row--hidden"}" id="px-quality-row">
        <label for="px-quality">Quality</label>
        <div class="export-row__control pdfx-quality">
          <input class="slider" id="px-quality" type="range" min="1" max="100" step="1" value="${quality}" />
          <span class="mono pdfx-quality__value" id="px-quality-value">${quality}</span>
        </div>
      </div>
      <div class="export-row">
        <label>Size</label>
        <div class="export-row__control">
          <div class="export-seg" id="px-scale">
            ${IMAGE_SCALES.map((s) => `<button class="btn ${s === scale ? "btn--on" : ""}" data-scale="${s}">${s}%</button>`).join("")}
          </div>
          <span class="mono pdfx-px" id="px-px"></span>
        </div>
      </div>
      <div class="export-note" id="px-note-page" hidden>Enter a page number from 1 to ${n}.</div>
      <div class="export-note" id="px-note-source" hidden>${escapeHtml(PAGE_SOURCE_UNOPENED)}</div>
      <div class="export-note" id="px-note-reduced" hidden></div>`;
    bodyEl.innerHTML = `
      <div class="export-form">
        ${tabs}
        ${tab === "pdf" ? pdfRows : imageRows}
        <div class="export-row">
          <label for="px-name">File name</label>
          <div class="export-row__control">
            <input class="input" id="px-name" value="${escapeHtml(filename())}" spellcheck="false" />
            <span class="export-ext" id="px-ext">.${ext()}</span>
          </div>
        </div>
        <div class="export-row">
          <label for="px-folder">Destination</label>
          <div class="export-row__control">
            <input class="input" id="px-folder" value="${escapeHtml(folder)}" placeholder="Choose a folder" spellcheck="false" />
            <button class="btn" id="px-choose">${icon("folder", 14)}Choose</button>
          </div>
        </div>
        <div class="export-outpath" id="px-outpath"></div>
        <div id="px-warn-slot"></div>
      </div>
    `;
    footerEl.innerHTML = `
      ${tab === "image" ? `<button class="btn" id="px-open-image">Open as image project</button><div class="grow"></div>` : ""}
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn--primary" id="px-run">${icon("export", 14)}Export</button>
    `;
    wireForm();
    refresh();
    if (tab === "image") {
      const n1 = imagePage();
      if (n1 !== null && (!pageBox || pageBox.page !== n1)) void loadPageBox(n1);
    }
    if (!backdrop.contains(document.activeElement)) focusFirst(backdrop, "#px-run");
  }

  /** Everything derived, written in place (the slider keeps its drag). */
  function refresh(): void {
    let ok = true;
    if (tab === "pdf") {
      const r = rangeCheck();
      const note = q<HTMLElement>("#px-note-range");
      if (note) {
        note.hidden = r.ok;
        note.textContent = r.ok ? "" : r.error;
      }
      ok = r.ok;
    } else {
      const n = imagePage();
      const notePage = q<HTMLElement>("#px-note-page");
      if (notePage) notePage.hidden = n !== null;
      const noteSrc = q<HTMLElement>("#px-note-source");
      if (noteSrc) noteSrc.hidden = pageProblem(n) === null;
      const size = imageSize();
      const px = q<HTMLElement>("#px-px");
      if (px) px.textContent = size ? `${size.w} × ${size.h} px` : "";
      const red = q<HTMLElement>("#px-note-reduced");
      if (red) {
        red.hidden = !size?.reduced;
        red.textContent = size?.reduced ? `Large page — it will be exported at ${size.w} × ${size.h}.` : "";
      }
      const qVal = q<HTMLElement>("#px-quality-value");
      if (qVal) qVal.textContent = String(quality);
      q<HTMLElement>("#px-quality-row")?.classList.toggle("export-row--hidden", imgFormat !== "jpeg");
      ok = n !== null && size !== null;
      const openBtn = q<HTMLButtonElement>("#px-open-image");
      if (openBtn) openBtn.disabled = !ok;
    }
    const e = q<HTMLElement>("#px-ext");
    if (e) e.textContent = `.${ext()}`;
    const out = q<HTMLElement>("#px-outpath");
    if (out) out.textContent = outPath();
    const runBtn = q<HTMLButtonElement>("#px-run");
    if (runBtn) runBtn.disabled = !ok;
    const slot = q<HTMLElement>("#px-warn-slot");
    if (slot && slot.childElementCount) slot.innerHTML = "";
  }

  function segClick(sel: string, attr: string, onPick: (v: string) => void): void {
    q<HTMLElement>(sel)?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(`[${attr}]`);
      if (!btn || btn.disabled) return;
      const v = btn.getAttribute(attr)!;
      for (const b of q<HTMLElement>(sel)!.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        b.classList.toggle("btn--on", b.getAttribute(attr) === v);
      }
      onPick(v);
    });
  }

  function wireForm(): void {
    segClick("#px-tab", "data-tab", (v) => {
      const next = v === "image" ? "image" : "pdf";
      if (next === tab) return;
      tab = next;
      renderForm();
    });
    if (tab === "pdf") {
      segClick("#px-range-mode", "data-range", (v) => {
        rangeMode = v === "range" ? "range" : "all";
        q<HTMLElement>("#px-range-row")?.classList.toggle("export-row--hidden", rangeMode !== "range");
        refresh();
      });
      const from = q<HTMLInputElement>("#px-from")!;
      const to = q<HTMLInputElement>("#px-to")!;
      from.addEventListener("input", () => {
        rangeFrom = from.value;
        refresh();
      });
      to.addEventListener("input", () => {
        rangeTo = to.value;
        refresh();
      });
      const fm = q<HTMLInputElement>("#px-flat-marks")!;
      fm.addEventListener("change", () => {
        flattenMarks = fm.checked;
      });
      const ff = q<HTMLInputElement>("#px-flat-forms");
      ff?.addEventListener("change", () => {
        flattenForms = ff.checked;
      });
    } else {
      const page = q<HTMLInputElement>("#px-page")!;
      page.addEventListener("input", () => {
        pageText = page.value;
        const n = imagePage();
        if (n !== null && !imgNameTouched) {
          imgName = defaultImageName(n);
          const nameInput = q<HTMLInputElement>("#px-name");
          if (nameInput) nameInput.value = imgName;
        }
        if (n !== null && (!pageBox || pageBox.page !== n)) void loadPageBox(n);
        refresh();
      });
      segClick("#px-format", "data-format", (v) => {
        imgFormat = v === "jpeg" ? "jpeg" : "png";
        refresh();
      });
      const slider = q<HTMLInputElement>("#px-quality")!;
      slider.addEventListener("input", () => {
        quality = Math.min(100, Math.max(1, Math.round(Number(slider.value) || DEFAULT_QUALITY)));
        refresh();
      });
      segClick("#px-scale", "data-scale", (v) => {
        const s = Number(v);
        scale = (IMAGE_SCALES as readonly number[]).includes(s) ? (s as ImageScale) : 100;
        refresh();
      });
      q<HTMLElement>("#px-open-image")!.addEventListener("click", () => void onOpenAsImage());
    }

    const nameInput = q<HTMLInputElement>("#px-name")!;
    nameInput.addEventListener("input", () => {
      setFilename(nameInput.value);
      refresh();
    });
    nameInput.addEventListener("blur", () => {
      setFilename(sanitizeFileName(nameInput.value));
      nameInput.value = filename();
      refresh();
    });
    const folderInput = q<HTMLInputElement>("#px-folder")!;
    folderInput.addEventListener("input", () => {
      folder = folderInput.value;
      refresh();
    });
    q<HTMLElement>("#px-choose")!.addEventListener("click", () => void chooseDestination());
    q<HTMLElement>("#px-run")!.addEventListener("click", () => void onExportClick());
    footerEl.querySelector("[data-cancel]")!.addEventListener("click", () => close());
  }

  async function chooseDestination(): Promise<string | null> {
    const e = ext();
    const filters =
      tab === "pdf"
        ? [{ name: "PDF", extensions: ["pdf"] }]
        : imgFormat === "jpeg"
          ? [{ name: "JPEG", extensions: ["jpg", "jpeg"] }]
          : [{ name: "PNG", extensions: [e] }];
    const chosen = await saveFileDialog({ defaultPath: outPath() || undefined, filters });
    if (!chosen || closed) return null;
    const { dir, file } = splitPath(chosen);
    folder = dir;
    const chosenExt = fileExt(file);
    setFilename(chosenExt ? file.slice(0, file.length - chosenExt.length - 1) : file);
    const nameInput = q<HTMLInputElement>("#px-name");
    if (nameInput) nameInput.value = filename();
    const folderInput = q<HTMLInputElement>("#px-folder");
    if (folderInput) folderInput.value = folder;
    refresh();
    return outPath();
  }

  function showWarning(message: string, onReplace: (() => void) | null, onRename: () => void): void {
    const slot = q<HTMLElement>("#px-warn-slot");
    if (!slot) return;
    slot.innerHTML = `
      <div class="export-warn">
        ${icon("warning", 16)}
        <div class="export-warn__msg">${escapeHtml(message)}</div>
        <div class="export-warn__actions">
          ${onReplace === null ? "" : `<button class="btn btn--sm" data-w="replace">Replace</button>`}
          <button class="btn btn--sm" data-w="rename">Rename</button>
          <button class="btn btn--sm" data-w="cancel">Cancel</button>
        </div>
      </div>`;
    const clear = (): void => {
      slot.innerHTML = "";
      reseat();
    };
    slot.querySelector('[data-w="replace"]')?.addEventListener("click", () => {
      clear();
      onReplace?.();
    });
    slot.querySelector('[data-w="rename"]')!.addEventListener("click", () => {
      clear();
      onRename();
    });
    slot.querySelector('[data-w="cancel"]')!.addEventListener("click", clear);
  }

  function reseat(): void {
    if (!backdrop.contains(document.activeElement)) focusFirst(backdrop, "#px-run");
  }

  async function onExportClick(): Promise<void> {
    if (exporting) return;
    if (tab === "pdf") {
      const r = rangeCheck();
      if (!r.ok) {
        toast.refuse(r.error);
        return;
      }
    } else if (!imageSize()) {
      return;
    }
    if (!folder) {
      const picked = await chooseDestination();
      if (!picked) return;
    }
    setFilename(sanitizeFileName(filename()));
    const bad = destinationProblem(folder);
    if (bad) {
      toast.refuse(bad);
      return;
    }
    const folderExists = await pathExists(folder);
    if (closed) return;
    if (!folderExists) {
      toast.refuse(MISSING_FOLDER);
      return;
    }

    const target = outPath();
    if (isProjectSource(target, sourcesAsMedia())) {
      showWarning(ORIGINAL_FILE_WARNING, null, () => void renameThenExport());
      return;
    }
    if (await pathExists(target)) {
      if (closed) return;
      showWarning("A file with this name already exists.", () => void beginExport(target), () => void renameThenExport());
      return;
    }
    if (closed) return;
    void beginExport(target);
  }

  async function renameThenExport(): Promise<void> {
    const e = ext();
    const dir = folder;
    const media = sourcesAsMedia();
    const name = filename();
    const free = await renameWithSuffix(name, async (candidate) => {
      const path = joinPath(dir, `${candidate}.${e}`);
      return isProjectSource(path, media) || (await pathExists(path));
    });
    if (closed) return;
    if (free === null) {
      toast.error("Couldn't find a free file name.", {
        op: "Export",
        title: "Rename",
        detail:
          `Tried ${RENAME_ATTEMPT_LIMIT} numbered variations of "${name}.${e}" in ${dir}` +
          ` and every one already exists. Nothing was overwritten — choose a different name or folder.`,
      });
      reseat();
      return;
    }
    setFilename(free);
    const nameInput = q<HTMLInputElement>("#px-name");
    if (nameInput) nameInput.value = free;
    refresh();
    void beginExport(outPath());
  }

  /* ============================ RUN ============================ */

  function start(): AbortController {
    const ac = new AbortController();
    run = ac;
    exporting = true;
    lastTaskbarPct = -1;
    runHold.hold();
    renderProgress();
    return ac;
  }

  /** The choices an export that actually starts leaves behind (a Cancel at
   *  the overwrite / own-file warning leaves none). */
  function rememberChoices(): void {
    // The flags on the project — once, and only when they changed. Like the
    // image export's preset, not an edit of the document: it must not make an
    // untouched temporary project ask "keep?", nor become an undo step.
    if (tab === "pdf") {
      const p = session.project;
      const next = setExportPreset(p, { flattenMarks, flattenForms });
      if (next !== p) session.replace(next, { edit: false });
    }
    void updateSettings({ lastExportDir: folder }).catch((e: unknown) => {
      toast.error("Couldn't save your settings.", {
        detail: errorDetail(e).message,
        op: "Settings",
        title: "Export folder",
      });
    });
  }

  function beginExport(target: string): Promise<void> {
    if (exporting || closed) return Promise.resolve();
    rememberChoices();
    const which = tab;
    const r = rangeCheck();
    const range = r.ok ? r.range : undefined;
    const flags = { flattenMarks, flattenForms: ctx.hasForms.get() ? flattenForms : false };
    const page = imagePage();
    const size = imageSize();
    const fmt = imgFormat;
    const q100 = quality;
    const ac = start();
    const job = (async (): Promise<void> => {
      try {
        // Read the project live: an edit made while the dialog was open is
        // the one that gets exported.
        const project = session.project;
        let path: string;
        if (which === "pdf") {
          progress(0, "Preparing pages");
          const { exportPdf } = await import("../export/export");
          // Cancel stops the build (opts.signal) and the write (the save IPC).
          const done = await exportPdf(project, { ...flags, range, signal: ac.signal }, target, undefined, abortableSaveIpc(ac.signal), (x) =>
            progress(x, "Saving"),
          );
          path = done.path;
        } else {
          progress(0, "Rendering");
          const blob = await renderPageImage(
            project,
            { page: page!, w: size!.w, h: size!.h, type: fmt === "jpeg" ? "image/jpeg" : "image/png", quality: q100 },
            ac.signal,
          );
          const saved = await saveImageBlob({ kind: "user", path: target, sources: pdfSourcePaths(project) }, fmt, blob, ac.signal, (x) =>
            progress(0.8 + x * 0.2, "Saving"),
          );
          path = saved.path;
        }
        if (closed) return;
        finish();
        renderSuccess(path);
      } catch (e) {
        if (closed) return;
        finish();
        if (isAbort(e) || ac.signal.aborted) {
          toast.info("Export canceled");
          renderForm();
          return;
        }
        renderError(describeExportFailure(e), e);
      }
    })();
    running = job;
    return job;
  }

  /** "Open as image project": the page as a PNG in the pasted-pictures
   *  folder (where the user can see and relink it), a permanent image
   *  project made from it, and the editor switched to that project — through
   *  ctx.leave, the shell's exits: a bare navigate() would skip a temporary
   *  PDF project's Keep/Discard prompt (main.ts go() never reads leaveGuard)
   *  and lose the way back to the viewer. A Cancel at that prompt keeps the
   *  user here; the image project stays saved in the library. */
  async function onOpenAsImage(): Promise<void> {
    if (exporting) return;
    const n = imagePage();
    const size = imageSize();
    if (n === null || !size) return;
    const ac = start();
    const job = (async (): Promise<void> => {
      try {
        const project = session.project;
        progress(0, "Rendering");
        const blob = await renderPageImage(project, { page: n, w: size.w, h: size.h, type: "image/png", quality: 100 }, ac.signal);
        const saved = await saveImageBlob({ kind: "pasted", projectName: project.name }, "png", blob, ac.signal, (x) =>
          progress(0.8 + x * 0.15, "Saving"),
        );
        if (ac.signal.aborted) throw abortError();
        const info = await ipc.probeMedia(saved.path);
        const { createPhotoImageProject } = await import("../../core/image-project");
        const projectPath = await ipc.newProjectPath(`${project.name} - page ${n}`);
        if (ac.signal.aborted) throw abortError();
        await ipc.saveProject(projectPath, createPhotoImageProject(fileStem(projectPath), info));
        if (closed) return;
        finish();
        teardown();
        ctx.leave?.({ view: "editor", projectPath });
      } catch (e) {
        if (closed) return;
        finish();
        if (isAbort(e) || ac.signal.aborted) {
          toast.info("Export canceled");
          renderForm();
          return;
        }
        renderError(describeExportFailure(e), e);
      }
    })();
    running = job;
  }

  function finish(): void {
    exporting = false;
    run = null;
    running = null;
    runHold.release();
    if (lastTaskbarPct !== -1) void clearTaskbarProgress();
    lastTaskbarPct = -1;
  }

  function renderProgress(): void {
    bodyEl.innerHTML = `
      <div class="export-progress">
        <div class="export-progress__pct" id="px-pct">0%</div>
        <div class="export-bar"><div class="export-bar__fill" id="px-fill"></div></div>
        <div class="export-progress__meta"><span id="px-phase">Preparing pages</span></div>
      </div>
    `;
    // Plain, not danger-red: canceling deletes nothing of the user's.
    footerEl.innerHTML = `<button class="btn" id="px-cancel">Cancel</button>`;
    q<HTMLElement>("#px-cancel")!.addEventListener("click", () => {
      if (!run) return;
      run.abort();
      // The build stops at its next checkpoint, not at once: say that the
      // cancel is landing rather than look stuck.
      const phase = q<HTMLElement>("#px-phase");
      if (phase) phase.textContent = "Canceling";
      const c = q<HTMLButtonElement>("#px-cancel");
      if (c) c.disabled = true;
    });
    focusFirst(backdrop, "#px-cancel");
  }

  function progress(ratio: number, phase: string): void {
    if (closed) return;
    const r = Math.min(1, Math.max(0, ratio));
    const pct = Math.round(r * 100);
    const pctEl = q<HTMLElement>("#px-pct");
    const fillEl = q<HTMLElement>("#px-fill");
    const phaseEl = q<HTMLElement>("#px-phase");
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (phaseEl && !run?.signal.aborted && phaseEl.textContent !== phase) phaseEl.textContent = phase;
    if (pct !== lastTaskbarPct) {
      lastTaskbarPct = pct;
      void setTaskbarProgress(r);
    }
  }

  function renderSuccess(path: string): void {
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--ok">${checkIcon(24)}</div>
        <div class="export-result__title">Exported</div>
        <div class="export-result__path">${escapeHtml(path)}</div>
      </div>
    `;
    footerEl.innerHTML = `
      <button class="btn" id="px-reveal">${icon("folder", 14)}Show in folder</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    q<HTMLElement>("#px-reveal")!.addEventListener("click", () => void revealInExplorer(path));
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", () => close());
    focusFirst(backdrop, "[data-close-btn]");
  }

  function renderError(err: { code: string; message: string }, raw: unknown): void {
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--bad">${icon("warning", 22)}</div>
        <div class="export-result__title">Export failed</div>
        <div class="export-result__msg">${escapeHtml(err.message)}</div>
      </div>
    `;
    const own = errorDetail(raw).message;
    const lines = [err.message];
    if (own && own !== err.message) lines.push(own);
    if (err.code) lines.push(`code: ${err.code}`);
    const detail = lines.join("\n\n");
    recordError({ at: Date.now(), op: "Export PDF", message: err.message, detail });
    bodyEl.querySelector(".export-result")!.appendChild(detailPane(detail));
    footerEl.innerHTML = `
      <button class="btn" id="px-back">Back</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    q<HTMLElement>("#px-back")!.addEventListener("click", () => renderForm());
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", () => close());
    focusFirst(backdrop, ".err-detail");
  }

  renderForm();
}
