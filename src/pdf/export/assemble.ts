// Stage 1 of export, in pdf.js: fill each source's form values (pdf.js writes
// the field appearances itself) and assemble the output's source pages, in
// order, into one document with `extractPages`, which keeps outlines,
// destinations and page labels and merges the sources' AcroForms.
//
// An ENCRYPTED source: pdf.js decrypts what it reads, and writes a plain file
// from several documents — but from ONE document it copies the source's
// /Encrypt into the output (its `#makeEncrypt`, used when every page comes
// from a single file). pdf-lib cannot read that back, and a PDF with only an
// owner password (opens without one, permissions locked) is common. So an
// encrypted source exported on its own gets a SENTINEL: one blank page of a
// tiny second document, placed last, which makes the extraction multi-file —
// a plain output — and is removed again with pdf-lib. A multi-file
// extraction leaves out the document information and page labels; the
// information is copied back from the source (`Assembled.info`).

import { PDFDocument } from "pdf-lib";
import { isPdfFieldId } from "../../core/pdf-sanitize";
import type { PdfFormValue, PdfMeta } from "../../core/types";
import { throwIfAborted } from "./cancel";
import type { ExportDeps, PdfjsDocLike, PdfjsLike, PdfjsTaskLike } from "./deps";
import { PdfExportError, baseName, own } from "./errors";
import type { ExtractPlan } from "./plan";

function isPasswordError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "PasswordException";
}

async function open(
  lib: PdfjsLike,
  data: Uint8Array,
  path: string,
  opts: Record<string, unknown> | undefined,
  password?: string,
): Promise<{ doc: PdfjsDocLike; task: PdfjsTaskLike }> {
  // pdf.js may transfer the buffer it is handed to its worker: give it a copy
  // so the caller's bytes stay usable.
  const task = lib.getDocument({ ...opts, data: data.slice(), ...(password !== undefined ? { password } : {}) });
  try {
    return { doc: await task.promise, task };
  } catch (e) {
    await task.destroy().catch(() => {});
    if (isPasswordError(e)) {
      throw new PdfExportError("password", `${baseName(path)} is protected by a password, so it cannot be exported.`, path);
    }
    throw new PdfExportError("source-invalid", `${baseName(path)} could not be read as a PDF.`, path);
  }
}

/** The pdf.js storage value for one form value. */
export function storageValue(v: PdfFormValue): Record<string, unknown> | null {
  if (typeof v === "string") return { value: v };
  if (typeof v === "boolean") return { value: v };
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) return { value: v };
  return null;
}

/** The source's bytes with its form values written in (or the bytes as they
 *  are when it has none). Only pdf.js widget ids are written: pdf.js reads a
 *  "pdfjs_internal_editor_…" key as a new annotation and fails on it. */
export async function fillForms(
  lib: PdfjsLike,
  bytes: Uint8Array,
  path: string,
  values: Record<string, PdfFormValue> | undefined,
  opts?: Record<string, unknown>,
  password?: string,
): Promise<Uint8Array> {
  const entries = Object.entries(values ?? {}).filter(([id]) => isPdfFieldId(id));
  if (!entries.length) return bytes;
  const { doc, task } = await open(lib, bytes, path, opts, password);
  try {
    for (const [id, v] of entries) {
      const sv = storageValue(v);
      if (sv) doc.annotationStorage.setValue(id, sv);
    }
    return await doc.saveDocument();
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** Have pdf.js draw the appearance of each widget in `rotations` (pdf.js id →
 *  its current /MK /R turn) from the value the file already holds: a storage
 *  entry with only the widget's own turn makes pdf.js regenerate it without
 *  changing anything else. Used before flattening, on a file whose
 *  /NeedAppearances was cleared (pdf.js writes no appearance while it is set). */
export async function drawFieldAppearances(
  deps: ExportDeps,
  bytes: Uint8Array,
  rotations: ReadonlyMap<string, number>,
): Promise<Uint8Array> {
  const lib = await deps.pdfjs();
  const { doc, task } = await open(lib, bytes, "the document", deps.pdfjsOptions);
  try {
    for (const [id, rotation] of rotations) doc.annotationStorage.setValue(id, { rotation });
    return await doc.saveDocument();
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** One blank 1×1 pt page, the sentinel's document (see the header). */
let sentinelBytes: Promise<Uint8Array> | null = null;
function sentinelDocument(): Promise<Uint8Array> {
  sentinelBytes ??= (async () => {
    const d = await PDFDocument.create({ updateMetadata: false });
    d.addPage([1, 1]);
    return d.save({ useObjectStreams: false });
  })();
  return sentinelBytes;
}

/** Document information entries copied back after a sentinel extraction. */
const INFO_KEYS = ["Title", "Author", "Subject", "Keywords"] as const;
export type InfoKey = (typeof INFO_KEYS)[number];

export interface Assembled {
  bytes: Uint8Array;
  /** the extraction carries one throwaway page LAST: remove it */
  sentinel: boolean;
  /** the source's document information, when the sentinel cost it */
  info: Partial<Record<InfoKey, string>> | null;
}

function pagesError(path: string, page: number, count: number): PdfExportError {
  return new PdfExportError(
    "source-invalid",
    `This project refers to page ${page + 1} of ${baseName(path)}, which has only ${count} page${count === 1 ? "" : "s"}.`,
    path,
  );
}

/** Assemble the planned source pages into one PDF (blank pages excluded). */
export async function assemble(
  pdf: PdfMeta,
  plan: ExtractPlan,
  bytesOf: (srcId: string) => Promise<Uint8Array>,
  deps: ExportDeps,
  passwords: Record<string, string> = Object.create(null) as Record<string, string>,
  signal?: AbortSignal,
): Promise<Assembled | null> {
  if (plan.primary === null) return null;
  const primary = plan.primary;
  const lib = await deps.pdfjs();
  const opts = deps.pdfjsOptions;
  const pathOf = (id: string): string => pdf.sources.find((s) => s.id === id)?.path ?? id;
  const pw = (id: string): string | undefined => {
    const v = own(passwords, id);
    return typeof v === "string" ? v : undefined;
  };
  /** the highest source page the plan reads, per source */
  const maxPage = new Map<string, number>();
  for (const e of plan.entries) maxPage.set(e.src, Math.max(maxPage.get(e.src) ?? -1, ...e.includePages));
  const filled = new Map<string, Uint8Array>();
  for (const e of plan.entries) {
    if (filled.has(e.src)) continue;
    throwIfAborted(signal);
    filled.set(e.src, await fillForms(lib, await bytesOf(e.src), pathOf(e.src), own(pdf.forms, e.src), opts, pw(e.src)));
  }
  throwIfAborted(signal);
  const { doc, task } = await open(lib, filled.get(primary)!, pathOf(primary), opts, pw(primary));
  let failure: unknown;
  try {
    const top = maxPage.get(primary)!;
    if (top >= doc.numPages) throw pagesError(pathOf(primary), top, doc.numPages);
    const entries = plan.entries.map((e) => {
      const p = pw(e.src);
      return {
        document: e.src === primary ? null : filled.get(e.src)!,
        ...(p !== undefined && e.src !== primary ? { password: p } : {}),
        includePages: e.includePages,
        pageIndices: e.pageIndices,
      };
    });
    let sentinel = false;
    let info: Assembled["info"] = null;
    if (plan.entries.every((e) => e.src === primary)) {
      const meta = await doc.getMetadata().catch(() => null);
      const raw = (meta?.info ?? {}) as Record<string, unknown>;
      if (raw["EncryptFilterName"]) {
        sentinel = true;
        info = {};
        for (const k of INFO_KEYS) {
          const v = raw[k];
          if (typeof v === "string" && v) info[k] = v;
        }
        const slots = plan.entries.reduce((n, e) => n + e.pageIndices.length, 0);
        entries.push({ document: await sentinelDocument(), includePages: [0], pageIndices: [slots] });
      }
    }
    throwIfAborted(signal);
    const out = await doc.extractPages(entries);
    if (out) return { bytes: out, sentinel, info };
  } catch (e) {
    if (e instanceof PdfExportError) throw e;
    failure = e;
  } finally {
    await task.destroy().catch(() => {});
  }
  throwIfAborted(signal);
  // pdf.js only warns about a source it could not open (a password, damage)
  // and then fails on the missing pages; open each one to say which and why.
  for (const id of filled.keys()) {
    if (id === primary) continue;
    const { doc: d, task: t } = await open(lib, filled.get(id)!, pathOf(id), opts, pw(id));
    const count = d.numPages;
    await t.destroy().catch(() => {});
    const top = maxPage.get(id) ?? -1;
    if (top >= count) throw pagesError(pathOf(id), top, count);
  }
  throw new PdfExportError(
    "source-invalid",
    `The pages could not be put together${failure instanceof Error ? ` (${failure.message})` : ""}.`,
  );
}
