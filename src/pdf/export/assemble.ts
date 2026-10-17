// Stage 1 of export, in pdf.js: fill each source's form values (pdf.js writes
// the field appearances itself — Hebrew included, verified in the spike) and
// assemble the output's source pages, in order, into one document with
// `extractPages`, which keeps outlines, destinations and page labels and
// merges the sources' AcroForms.

import type { PdfFormValue, PdfMeta } from "../../core/types";
import type { ExportDeps, PdfjsDocLike, PdfjsLike, PdfjsTaskLike } from "./deps";
import { PdfExportError, baseName } from "./errors";
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
 *  are when it has none). */
export async function fillForms(
  lib: PdfjsLike,
  bytes: Uint8Array,
  path: string,
  values: Record<string, PdfFormValue> | undefined,
  opts?: Record<string, unknown>,
  password?: string,
): Promise<Uint8Array> {
  const entries = Object.entries(values ?? {});
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

/** Assemble the planned source pages into one PDF (blank pages excluded). */
export async function assemble(
  pdf: PdfMeta,
  plan: ExtractPlan,
  bytesOf: (srcId: string) => Promise<Uint8Array>,
  deps: ExportDeps,
  passwords: Record<string, string> = {},
): Promise<Uint8Array | null> {
  if (plan.primary === null) return null;
  const lib = await deps.pdfjs();
  const opts = deps.pdfjsOptions;
  const pathOf = (id: string): string => pdf.sources.find((s) => s.id === id)?.path ?? id;
  const filled = new Map<string, Uint8Array>();
  for (const e of plan.entries) {
    if (filled.has(e.src)) continue;
    filled.set(e.src, await fillForms(lib, await bytesOf(e.src), pathOf(e.src), pdf.forms?.[e.src], opts, passwords[e.src]));
  }
  const { doc, task } = await open(lib, filled.get(plan.primary)!, pathOf(plan.primary), opts, passwords[plan.primary]);
  let failure: unknown;
  try {
    const out = await doc.extractPages(
      plan.entries.map((e) => {
        const pw = passwords[e.src];
        return {
          document: e.src === plan.primary ? null : filled.get(e.src)!,
          ...(pw !== undefined && e.src !== plan.primary ? { password: pw } : {}),
          includePages: e.includePages,
          pageIndices: e.pageIndices,
        };
      }),
    );
    if (out) return out;
  } catch (e) {
    failure = e;
  } finally {
    await task.destroy().catch(() => {});
  }
  // pdf.js only warns about a source it could not open (a password, damage)
  // and then fails on the missing pages; open each one to say which and why.
  for (const id of filled.keys()) {
    if (id === plan.primary) continue;
    const { task: t } = await open(lib, filled.get(id)!, pathOf(id), opts, passwords[id]);
    await t.destroy().catch(() => {});
  }
  throw new PdfExportError(
    "source-invalid",
    `The pages could not be put together${failure instanceof Error ? ` (${failure.message})` : ""}.`,
  );
}
