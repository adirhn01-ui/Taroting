// The PDF project model: the pure edit operations every part of the PDF
// editor calls, and the page-space geometry its tools share.
//
// PURE AND IMMUTABLE. Every operation takes a ProjectFile and returns a new
// one; inputs are never mutated, and everything an operation does not touch is
// shared BY REFERENCE (untouched pages, mark lists, marks, sources, form
// records, the timeline, the media list) — history snapshots share structure,
// so unlimited undo stays linear in memory.
//
// REFUSAL STYLE (one rule for the whole module): an operation that cannot or
// need not do anything returns its input `p` ITSELF — the codebase's no-op
// idiom (`setProjectCanvas`, `moveMarkerTo`, …), which the session already
// reads as "nothing changed, push no history". Nothing here throws. Refusals:
// a project that is not a PDF project, an unknown page / mark / source id, a
// page order that is not a permutation, deleting every page (a document keeps
// at least one), going over PDF_MAX_PAGES or PDF_MAX_ANNOTS_PER_PAGE, a page
// index outside its source, a blank size outside 1..14400, an invalid form
// value. A caller that must explain a refusal asks first: `canAddPages`,
// `canAddAnnots`.
//
// RECORDS. `annots` and `forms` are id-keyed records. Ids reaching them are
// `uid()`s or sanitized ids (`isPdfId` refuses "__proto__", "constructor",
// "prototype"), every READ goes through an own-property check (`pageAnnots`,
// `formValues`, `formValue`), and every record written here is a fresh
// `Object.create(null)` copy — a key can never resolve to Object.prototype.
//
// Coordinates are PAGE SPACE (core/types.ts): points, unrotated, y down.
// Geometry results are clamped to ±PDF_COORD_MAX so a saved project always
// passes the loader's bounds.

import type {
  FontFamily,
  FontId,
  MediaRef,
  PdfAnnot,
  PdfAnnotKind,
  PdfExportPreset,
  PdfFormValue,
  PdfMeta,
  PdfPage,
  PdfRotation,
  PdfSource,
  PdfTextRun,
  ProjectFile,
} from "../core/types";
import { PDF_MAX_ANNOTS_PER_PAGE, PDF_MAX_PAGES } from "../core/types";
import { uid } from "../core/project";
import { isFontId, isLegacyFont } from "../core/font-id";
import { normalizeRuns, runsEqual } from "../core/pdf-runs";
import {
  PDF_COORD_MAX,
  PDF_PAGE_SIDE_MAX,
  PDF_PAGE_SIDE_MIN,
  isPdfFilePath,
  isPdfFieldId,
  isPdfId,
  sanitizePdfFormValue,
} from "../core/pdf-sanitize";
import { decodePoints, encodePoints } from "../image/strokes";

/** A fresh id for a page, source or mark — the same helper core/project uses. */
export const newId = (): string => uid();

/** [x, y, w, h] in page space. */
export type Box = [number, number, number, number];

/** A partial update of one mark: any of its own fields except `id` and `t`. */
export type PdfAnnotPatch = {
  [K in PdfAnnotKind]: Partial<Omit<Extract<PdfAnnot, { t: K }>, "id" | "t">>;
}[PdfAnnotKind];

/** Names one mark: the page it is on and its id. */
export interface AnnotRef {
  pageId: string;
  id: string;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function pdfOf(p: ProjectFile): PdfMeta | null {
  return p.kind === "pdf" && p.pdf ? p.pdf : null;
}

function withPdf(p: ProjectFile, pdf: PdfMeta): ProjectFile {
  return { ...p, pdf };
}

/** A null-prototype copy of `rec` with `key` set to `value` (in place of its
 *  old position when present, appended otherwise) — or REMOVED when `value`
 *  is undefined. */
function setKey<T>(rec: Readonly<Record<string, T>>, key: string, value: T | undefined): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  let placed = false;
  for (const k of Object.keys(rec)) {
    if (k === key) {
      placed = true;
      if (value !== undefined) out[k] = value;
    } else {
      out[k] = rec[k]!;
    }
  }
  if (!placed && value !== undefined) out[key] = value;
  return out;
}

/** A null-prototype copy of `rec` without any of `keys`; `rec` itself when
 *  none of them is present. */
function dropKeys<T>(rec: Readonly<Record<string, T>>, keys: ReadonlySet<string>): Record<string, T> {
  let hit = false;
  for (const k of keys) {
    if (hasOwn(rec, k)) {
      hit = true;
      break;
    }
  }
  if (!hit) return rec;
  const out = Object.create(null) as Record<string, T>;
  for (const k of Object.keys(rec)) if (!keys.has(k)) out[k] = rec[k]!;
  return out;
}

function pageIndex(pdf: PdfMeta, pageId: string): number {
  return pdf.pages.findIndex((pg) => pg.id === pageId);
}

function clampCoord(v: number): number {
  return Math.min(Math.max(v, -PDF_COORD_MAX), PDF_COORD_MAX);
}
function clampExtent(v: number): number {
  return Math.min(Math.max(v, 0), PDF_COORD_MAX);
}

/** Clamp an insertion index into 0..n (truncated); null when not finite. */
function gapIndex(at: number, n: number): number | null {
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(Math.trunc(at), 0), n);
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const NO_ANNOTS: readonly PdfAnnot[] = Object.freeze([]);

/** The marks on a page, bottom first (array order is drawing order); an empty
 *  list for a page without any — or for a key that is not an own entry. */
export function pageAnnots(p: ProjectFile, pageId: string): readonly PdfAnnot[] {
  const pdf = pdfOf(p);
  if (!pdf || !hasOwn(pdf.annots, pageId)) return NO_ANNOTS;
  return pdf.annots[pageId] ?? NO_ANNOTS;
}

/** The typed-in values of one source's form fields (own entry or undefined). */
export function formValues(
  p: ProjectFile,
  srcId: string,
): Readonly<Record<string, PdfFormValue>> | undefined {
  const pdf = pdfOf(p);
  if (!pdf || !hasOwn(pdf.forms, srcId)) return undefined;
  return pdf.forms[srcId];
}

/** One field's value (own entry or undefined). */
export function formValue(p: ProjectFile, srcId: string, annotId: string): PdfFormValue | undefined {
  const rec = formValues(p, srcId);
  return rec && hasOwn(rec, annotId) ? rec[annotId] : undefined;
}

/** Whether `n` more pages fit under PDF_MAX_PAGES. */
export function canAddPages(p: ProjectFile, n: number): boolean {
  const pdf = pdfOf(p);
  return !!pdf && pdf.pages.length + n <= PDF_MAX_PAGES;
}

/** Whether `n` more marks fit on the page under PDF_MAX_ANNOTS_PER_PAGE. */
export function canAddAnnots(p: ProjectFile, pageId: string, n: number): boolean {
  const pdf = pdfOf(p);
  if (!pdf || pageIndex(pdf, pageId) < 0) return false;
  return pageAnnots(p, pageId).length + n <= PDF_MAX_ANNOTS_PER_PAGE;
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

/** Put `annot` on top of the page's marks. Refused: unknown page, a full page,
 *  or an id already on that page. The annot object is stored as given (marks
 *  are immutable once built; the caller makes it with `newId()`). */
export function addAnnot(p: ProjectFile, pageId: string, annot: PdfAnnot): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || pageIndex(pdf, pageId) < 0) return p;
  const list = pageAnnots(p, pageId);
  if (list.length >= PDF_MAX_ANNOTS_PER_PAGE) return p;
  if (list.some((a) => a.id === annot.id)) return p;
  return withPdf(p, { ...pdf, annots: setKey(pdf.annots, pageId, [...list, annot]) });
}

/** Merge `patch` into one mark. Only fields the mark already has are applied
 *  (`id` and `t` never are), so a patch cannot change its kind or give it
 *  another kind's fields. Refused: unknown page/mark, or nothing changes. */
export function updateAnnot(
  p: ProjectFile,
  pageId: string,
  id: string,
  patch: PdfAnnotPatch,
): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const list = pageAnnots(p, pageId);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return p;
  const cur = list[i]!;
  const next: Record<string, unknown> = { ...cur };
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (k === "id" || k === "t" || !hasOwn(cur, k)) continue;
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined || v === next[k]) continue;
    next[k] = v;
    changed = true;
  }
  if (!changed) return p;
  const out = list.slice();
  out[i] = next as unknown as PdfAnnot;
  return withPdf(p, { ...pdf, annots: setKey(pdf.annots, pageId, out) });
}

/** Remove marks. Unknown refs are ignored; a page left with none loses its
 *  entry. Refused when nothing matched. */
export function removeAnnots(p: ProjectFile, refs: readonly AnnotRef[]): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || refs.length === 0) return p;
  const byPage = new Map<string, Set<string>>();
  for (const r of refs) {
    let s = byPage.get(r.pageId);
    if (!s) byPage.set(r.pageId, (s = new Set()));
    s.add(r.id);
  }
  let annots = pdf.annots;
  for (const [pageId, ids] of byPage) {
    const list = pageAnnots(p, pageId);
    const kept = list.filter((a) => !ids.has(a.id));
    if (kept.length === list.length) continue;
    annots = setKey(annots, pageId, kept.length > 0 ? kept : undefined);
  }
  return annots === pdf.annots ? p : withPdf(p, { ...pdf, annots });
}

/** Move one mark to the top of another page's marks, unchanged (same id, same
 *  page-space geometry — translate it separately if needed). Refused: same
 *  page, unknown page/mark, a full target page, or the id already there. */
export function moveAnnot(p: ProjectFile, from: AnnotRef, toPageId: string): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || from.pageId === toPageId || pageIndex(pdf, toPageId) < 0) return p;
  const src = pageAnnots(p, from.pageId);
  const a = src.find((x) => x.id === from.id);
  if (!a) return p;
  const dst = pageAnnots(p, toPageId);
  if (dst.length >= PDF_MAX_ANNOTS_PER_PAGE || dst.some((x) => x.id === a.id)) return p;
  const kept = src.filter((x) => x !== a);
  let annots = setKey(pdf.annots, from.pageId, kept.length > 0 ? kept : undefined);
  annots = setKey(annots, toPageId, [...dst, a]);
  return withPdf(p, { ...pdf, annots });
}

/** A text box's optional look: its fill and 1 pt border. */
export interface TextBoxLook {
  /** #rrggbb sets it, null removes it, absent leaves it */
  bg?: string | null;
  border?: string | null;
}

/** Set or remove a text mark's fill / border — fields `updateAnnot` cannot
 *  add or drop (it only touches fields a mark already has). A colour must be
 *  lowercase #rrggbb (anything else is ignored). Refused: not a text mark,
 *  unknown page/mark, or nothing changes. */
export function setTextBox(p: ProjectFile, pageId: string, id: string, look: TextBoxLook): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const list = pageAnnots(p, pageId);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return p;
  const cur = list[i]!;
  if (cur.t !== "text") return p;
  const next: Record<string, unknown> = { ...cur };
  let changed = false;
  for (const k of ["bg", "border"] as const) {
    if (!hasOwn(look, k)) continue;
    const v = look[k];
    if (v === null) {
      if (hasOwn(next, k)) {
        delete next[k];
        changed = true;
      }
    } else if (typeof v === "string" && /^#[0-9a-f]{6}$/.test(v) && next[k] !== v) {
      next[k] = v;
      changed = true;
    }
  }
  if (!changed) return p;
  const out = list.slice();
  out[i] = next as unknown as PdfAnnot;
  return withPdf(p, { ...pdf, annots: setKey(pdf.annots, pageId, out) });
}

/** A font pick for a text mark (core/font-id `fontChoice`): the legacy font,
 *  and a non-legacy font's id when one was picked. */
export interface TextFontPick {
  legacy: FontFamily;
  fontId?: FontId;
}

/** Set a text mark's font the seam's way: `font` = the legacy field, and
 *  `fontId` added, replaced, or — for a legacy pick — DELETED (the key is
 *  absent, never undefined or null). `updateAnnot` cannot do this: it only
 *  touches fields a mark already has. Refused: not a text mark, unknown
 *  page/mark, an unknown legacy font or an ill-shaped / legacy `fontId`, or
 *  nothing changes. */
export function setTextFont(p: ProjectFile, pageId: string, id: string, pick: TextFontPick): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || !isLegacyFont(pick.legacy)) return p;
  const fontId = pick.fontId;
  if (fontId !== undefined && (!isFontId(fontId) || isLegacyFont(fontId))) return p;
  const list = pageAnnots(p, pageId);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return p;
  const cur = list[i]!;
  if (cur.t !== "text") return p;
  const had = hasOwn(cur, "fontId");
  if (cur.font === pick.legacy && (fontId === undefined ? !had : had && cur.fontId === fontId)) return p;
  const next: Record<string, unknown> = { ...cur, font: pick.legacy };
  if (fontId === undefined) delete next.fontId;
  else next.fontId = fontId;
  const out = list.slice();
  out[i] = next as unknown as PdfAnnot;
  return withPdf(p, { ...pdf, annots: setKey(pdf.annots, pageId, out) });
}

/**
 * Set a text box's style runs (0.9.4): `runs` are put in canonical form
 * against the mark's OWN text and style (`normalizeRuns`) and stored; none
 * left, or `undefined`, DELETES the key (never `runs: []`). Refused (returns
 * `p`): not a PDF project, unknown page / mark, not a text mark, or the
 * canonical runs equal what the mark already has (nothing changes). Set the
 * text first (`updateAnnot`) when both change: runs are clipped to the text.
 */
export function setTextRuns(p: ProjectFile, pageId: string, id: string, runs: readonly PdfTextRun[] | undefined): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const list = pageAnnots(p, pageId);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return p;
  const cur = list[i]!;
  if (cur.t !== "text") return p;
  const next = normalizeRuns(cur.text, cur, runs);
  const had = hasOwn(cur, "runs");
  if (next === undefined ? !had : had && runsEqual(cur.runs, next)) return p;
  const out = list.slice();
  const mark: Record<string, unknown> = { ...cur };
  if (next === undefined) delete mark.runs;
  else mark.runs = next;
  out[i] = mark as unknown as PdfAnnot;
  return withPdf(p, { ...pdf, annots: setKey(pdf.annots, pageId, out) });
}

/**
 * Paste copies of `marks` on top of page `pageId`, each moved by (dx, dy),
 * with fresh ids (`ids()`), in ONE new project. A picture whose
 * MediaRef the project lacks brings it along from `media` (reusing a ref of
 * the same file when there is one). Refused (returns `p`, no ids): not a PDF
 * project, unknown page, nothing to paste, or not all of them fit on it.
 */
export function pasteAnnots(
  p: ProjectFile,
  pageId: string,
  marks: readonly PdfAnnot[],
  dx: number,
  dy: number,
  media: readonly MediaRef[],
  ids: () => string = newId,
): { project: ProjectFile; ids: string[] } {
  const none = { project: p, ids: [] as string[] };
  const pdf = pdfOf(p);
  if (!pdf || marks.length === 0 || !canAddAnnots(p, pageId, marks.length)) return none;
  let mediaList = p.media;
  const mediaMap = new Map<string, string>();
  const out: PdfAnnot[] = [];
  const newIds: string[] = [];
  for (const m of marks) {
    let a = translateAnnot(m, dx, dy);
    if (a.t === "image" && !mediaMap.has(a.media)) {
      const want = a.media;
      if (mediaList.some((r) => r.id === want)) mediaMap.set(want, want);
      else {
        const ref = media.find((r) => r.id === want);
        if (!ref) return none;
        const same = mediaList.find((r) => r.kind === ref.kind && !r.generator && r.path === ref.path && r.size === ref.size && r.mtimeMs === ref.mtimeMs);
        if (same) mediaMap.set(want, same.id);
        else {
          mediaList = [...mediaList, ref];
          mediaMap.set(want, ref.id);
        }
      }
    }
    if (a.t === "image") a = { ...a, media: mediaMap.get(a.media)! };
    const id = ids();
    newIds.push(id);
    out.push({ ...a, id });
  }
  const list = pageAnnots(p, pageId);
  const next: ProjectFile = mediaList === p.media ? p : { ...p, media: mediaList };
  return { project: withPdf(next, { ...pdf, annots: setKey(pdf.annots, pageId, [...list, ...out]) }), ids: newIds };
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** Put the pages in exactly `order` (page ids). Refused unless `order` is a
 *  permutation of the current ids, or when it is the current order. */
export function reorderPages(p: ProjectFile, order: readonly string[]): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || order.length !== pdf.pages.length) return p;
  const byId = new Map(pdf.pages.map((pg) => [pg.id, pg] as const));
  const seen = new Set<string>();
  const pages: PdfPage[] = [];
  let same = true;
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    const pg = byId.get(id);
    if (!pg || seen.has(id)) return p;
    seen.add(id);
    pages.push(pg);
    if (pg !== pdf.pages[i]) same = false;
  }
  return same ? p : withPdf(p, { ...pdf, pages });
}

/** Move the given pages (kept in their current document order) as one block
 *  to the gap `toIndex` of the CURRENT list (0 = before the first page,
 *  length = after the last), as a drag-and-drop gap reads. Unknown ids are
 *  ignored. Refused when nothing moves. */
export function movePages(p: ProjectFile, pageIds: readonly string[], toIndex: number): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const gap = gapIndex(toIndex, pdf.pages.length);
  if (gap === null) return p;
  const ids = new Set(pageIds);
  const moving: PdfPage[] = [];
  const rest: PdfPage[] = [];
  let at = 0;
  pdf.pages.forEach((pg, i) => {
    if (ids.has(pg.id)) moving.push(pg);
    else {
      rest.push(pg);
      if (i < gap) at++;
    }
  });
  if (moving.length === 0) return p;
  const pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return pages.every((pg, i) => pg === pdf.pages[i]) ? p : withPdf(p, { ...pdf, pages });
}

/** Turn pages by `delta` degrees clockwise (mod 360). Marks stay in page
 *  space, so they turn with their page. Unknown ids ignored; refused when no
 *  page matched or `delta` is not 90 / -90 / 180. */
export function rotatePages(p: ProjectFile, pageIds: readonly string[], delta: 90 | -90 | 180): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || (delta !== 90 && delta !== -90 && delta !== 180)) return p;
  const ids = new Set(pageIds);
  let hit = false;
  const pages = pdf.pages.map((pg) => {
    if (!ids.has(pg.id)) return pg;
    hit = true;
    return { ...pg, rotate: (((pg.rotate + delta) % 360) + 360) % 360 as PdfRotation };
  });
  return hit ? withPdf(p, { ...pdf, pages }) : p;
}

/** Delete pages and their marks. Sources stay (see `dropUnusedSources`).
 *  Refused when no page matched or EVERY page would go. */
export function deletePages(p: ProjectFile, pageIds: readonly string[]): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const ids = new Set(pageIds);
  const pages = pdf.pages.filter((pg) => !ids.has(pg.id));
  if (pages.length === pdf.pages.length || pages.length === 0) return p;
  const gone = new Set(pdf.pages.filter((pg) => ids.has(pg.id)).map((pg) => pg.id));
  return withPdf(p, { ...pdf, pages, annots: dropKeys(pdf.annots, gone) });
}

/** Duplicate pages: each copy goes right after its original, with a fresh id
 *  and copies of its marks under fresh ids (the marks' nested arrays are
 *  shared — they are immutable). Unknown ids ignored; refused when none
 *  matched or the copies would pass PDF_MAX_PAGES. */
export function duplicatePages(p: ProjectFile, pageIds: readonly string[]): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const ids = new Set(pageIds);
  const n = pdf.pages.reduce((k, pg) => k + (ids.has(pg.id) ? 1 : 0), 0);
  if (n === 0 || pdf.pages.length + n > PDF_MAX_PAGES) return p;
  const pages: PdfPage[] = [];
  let annots = pdf.annots;
  for (const pg of pdf.pages) {
    pages.push(pg);
    if (!ids.has(pg.id)) continue;
    const copy: PdfPage = { ...pg, id: newId() };
    pages.push(copy);
    const marks = pageAnnots(p, pg.id);
    if (marks.length > 0) {
      annots = setKey(annots, copy.id, marks.map((a) => ({ ...a, id: newId() }) as PdfAnnot));
    }
  }
  return withPdf(p, { ...pdf, pages, annots });
}

/** Insert a blank `w`×`h`-point page at gap `atIndex` (clamped into 0..length).
 *  Refused: a side outside 1..14400, a full document. */
export function insertBlankPage(p: ProjectFile, atIndex: number, w: number, h: number): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || pdf.pages.length >= PDF_MAX_PAGES) return p;
  const side = (v: number) => Number.isFinite(v) && v >= PDF_PAGE_SIDE_MIN && v <= PDF_PAGE_SIDE_MAX;
  if (!side(w) || !side(h)) return p;
  const at = gapIndex(atIndex, pdf.pages.length);
  if (at === null) return p;
  const page: PdfPage = { id: newId(), src: null, page: 0, rotate: 0, w, h };
  const pages = [...pdf.pages.slice(0, at), page, ...pdf.pages.slice(at)];
  return withPdf(p, { ...pdf, pages });
}

/** Insert pages of `source` at gap `atIndex` (clamped into 0..length), in the
 *  order of `pageIndices` (0-based; default: every page). A source already in
 *  the project (same path + size + mtimeMs) is reused; otherwise it is added —
 *  under its own id when that id is valid and unused, else a fresh one.
 *  Refused (whole): an invalid source, any index outside it, an empty list,
 *  or going over PDF_MAX_PAGES. */
export function insertSourcePages(
  p: ProjectFile,
  atIndex: number,
  source: PdfSource,
  pageIndices?: readonly number[],
): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const okNum = (v: number) => Number.isFinite(v) && v >= 0;
  if (!isPdfFilePath(source.path) || !okNum(source.size) || !okNum(source.mtimeMs)) return p;
  if (!Number.isInteger(source.pages) || source.pages < 1 || source.pages > PDF_MAX_PAGES) return p;
  const indices = pageIndices ?? Array.from({ length: source.pages }, (_, i) => i);
  if (indices.length === 0 || pdf.pages.length + indices.length > PDF_MAX_PAGES) return p;
  for (const i of indices) if (!Number.isInteger(i) || i < 0 || i >= source.pages) return p;
  const at = gapIndex(atIndex, pdf.pages.length);
  if (at === null) return p;

  let sources = pdf.sources;
  let src = pdf.sources.find(
    (s) => s.path === source.path && s.size === source.size && s.mtimeMs === source.mtimeMs,
  );
  if (!src) {
    const free = isPdfId(source.id) && !pdf.sources.some((s) => s.id === source.id);
    src = {
      id: free ? source.id : newId(),
      path: source.path,
      size: source.size,
      mtimeMs: source.mtimeMs,
      pages: source.pages,
    };
    sources = [...pdf.sources, src];
  }
  const srcId = src.id;
  const added: PdfPage[] = indices.map((i) => ({ id: newId(), src: srcId, page: i, rotate: 0 }));
  const pages = [...pdf.pages.slice(0, at), ...added, ...pdf.pages.slice(at)];
  return withPdf(p, { ...pdf, sources, pages });
}

/** Drop sources no page uses, with their form values. Refused when every
 *  source is in use. */
export function dropUnusedSources(p: ProjectFile): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const used = new Set<string>();
  for (const pg of pdf.pages) if (pg.src !== null) used.add(pg.src);
  const sources = pdf.sources.filter((s) => used.has(s.id));
  if (sources.length === pdf.sources.length) return p;
  const gone = new Set(pdf.sources.filter((s) => !used.has(s.id)).map((s) => s.id));
  return withPdf(p, { ...pdf, sources, forms: dropKeys(pdf.forms, gone) });
}

/* ------------------------------------------------------------------ */
/* Forms + export                                                      */
/* ------------------------------------------------------------------ */

function sameValue(a: PdfFormValue | undefined, b: PdfFormValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Set one form field of a source (pdf.js widget id). The value is validated
 *  like the loader does and stored as a copy. Refused: unknown source, an
 *  invalid field id or value, or the same value. */
export function setFormValue(
  p: ProjectFile,
  srcId: string,
  annotId: string,
  value: PdfFormValue,
): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf || !pdf.sources.some((s) => s.id === srcId) || !isPdfFieldId(annotId)) return p;
  const clean = sanitizePdfFormValue(value);
  if (clean === null || sameValue(formValue(p, srcId, annotId), clean)) return p;
  const rec = formValues(p, srcId) ?? (Object.create(null) as Record<string, PdfFormValue>);
  const forms = setKey(pdf.forms, srcId, setKey(rec, annotId, clean));
  return withPdf(p, { ...pdf, forms });
}

/** Clear one form field (back to the PDF's own value). A source left with no
 *  values loses its entry. Refused when the field has no value. */
export function clearFormValue(p: ProjectFile, srcId: string, annotId: string): ProjectFile {
  const pdf = pdfOf(p);
  const rec = formValues(p, srcId);
  if (!pdf || !rec || !hasOwn(rec, annotId)) return p;
  const next = setKey<PdfFormValue>(rec, annotId, undefined);
  const forms = setKey(pdf.forms, srcId, Object.keys(next).length > 0 ? next : undefined);
  return withPdf(p, { ...pdf, forms });
}

/** Merge into the PDF export options (each flag false when never set).
 *  Refused when nothing changes. */
export function setExportPreset(p: ProjectFile, preset: Partial<PdfExportPreset>): ProjectFile {
  const pdf = pdfOf(p);
  if (!pdf) return p;
  const cur: PdfExportPreset = pdf.export ?? { flattenMarks: false, flattenForms: false };
  const next: PdfExportPreset = {
    flattenMarks: preset.flattenMarks ?? cur.flattenMarks,
    flattenForms: preset.flattenForms ?? cur.flattenForms,
  };
  if (next.flattenMarks === cur.flattenMarks && next.flattenForms === cur.flattenForms) return p;
  return withPdf(p, { ...pdf, export: next });
}

/* ------------------------------------------------------------------ */
/* Geometry (page space)                                               */
/* ------------------------------------------------------------------ */

const decoded = new WeakMap<object, Float32Array>();
const EMPTY = new Float32Array(0);

/** Decoded [x, y, pressure]* of a `p` string, cached by the (immutable) mark
 *  or signature object that holds it. Empty when it does not decode (marks
 *  are validated on load, so that is only reachable by a bug). */
function pointsOf(owner: object, p: string): Float32Array {
  let pts = decoded.get(owner);
  if (pts === undefined) {
    pts = decodePoints(p) ?? EMPTY;
    decoded.set(owner, pts);
  }
  return pts;
}

/** Points → `p`, through the image editor's own codec (a leaf module the PDF
 *  chunk may share — see src/dev/image-chunk-boundary.test.ts). Coordinates
 *  are clamped into page space first, so the result always reloads. */
function encodePagePoints(pts: Float32Array): string {
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i]!;
    out[i] = i % 3 === 2 ? v : clampCoord(Number.isFinite(v) ? v : 0);
  }
  return encodePoints(out);
}

function unionBox(minX: number, minY: number, maxX: number, maxY: number): Box {
  if (!(minX <= maxX && minY <= maxY)) return [0, 0, 0, 0];
  return [minX, minY, maxX - minX, maxY - minY];
}

/** The page-space box a mark covers, [x, y, w, h]: ink = its points ± half
 *  the width; highlight = the union of its rects; shapes = their two ends ±
 *  half the width; every box mark = its x, y, w, h. A mark with no points is
 *  [0, 0, 0, 0]. */
export function annotBounds(a: PdfAnnot): Box {
  switch (a.t) {
    case "ink": {
      const pts = pointsOf(a, a.p);
      if (pts.length === 0) return [0, 0, 0, 0];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i]!;
        const y = pts[i + 1]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const r = a.w / 2;
      return unionBox(minX - r, minY - r, maxX + r, maxY + r);
    }
    case "highlight": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y, w, h] of a.rects) {
        minX = Math.min(minX, x, x + w);
        minY = Math.min(minY, y, y + h);
        maxX = Math.max(maxX, x, x + w);
        maxY = Math.max(maxY, y, y + h);
      }
      return unionBox(minX, minY, maxX, maxY);
    }
    case "line":
    case "rect":
    case "ellipse":
    case "arrow": {
      const r = a.w / 2;
      return unionBox(
        Math.min(a.a[0], a.b[0]) - r,
        Math.min(a.a[1], a.b[1]) - r,
        Math.max(a.a[0], a.b[0]) + r,
        Math.max(a.a[1], a.b[1]) + r,
      );
    }
    default:
      return [a.x, a.y, a.w, a.h];
  }
}

/** A point map applied to a mark's geometry. */
type Map2 = (x: number, y: number) => [number, number];

function mapPoints(pts: Float32Array, f: Map2): Float32Array {
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    const [x, y] = f(pts[i]!, pts[i + 1]!);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = pts[i + 2]!;
  }
  return out;
}

function mapPair(v: [number, number], f: Map2): [number, number] {
  const [x, y] = f(v[0], v[1]);
  return [clampCoord(x), clampCoord(y)];
}

/** A rect mapped by its two corners, normalised (a negative scale flips it). */
function mapRect(x: number, y: number, w: number, h: number, f: Map2): Box {
  const [x0, y0] = f(x, y);
  const [x1, y1] = f(x + w, y + h);
  return [
    clampCoord(Math.min(x0, x1)),
    clampCoord(Math.min(y0, y1)),
    clampExtent(Math.abs(x1 - x0)),
    clampExtent(Math.abs(y1 - y0)),
  ];
}

/** Apply a point map to every coordinate of a mark (widths, font sizes and
 *  signature strokes — normalised to their box — are left as they are). */
function mapAnnot(a: PdfAnnot, f: Map2): PdfAnnot {
  switch (a.t) {
    case "ink": {
      // A `p` that does not decode (only a bug reaches one) is left alone
      // rather than re-encoded into something that never existed.
      const pts = pointsOf(a, a.p);
      return pts.length === 0 ? a : { ...a, p: encodePagePoints(mapPoints(pts, f)) };
    }
    case "highlight":
      return { ...a, rects: a.rects.map(([x, y, w, h]) => mapRect(x, y, w, h, f)) };
    case "line":
    case "rect":
    case "ellipse":
    case "arrow":
      return { ...a, a: mapPair(a.a, f), b: mapPair(a.b, f) };
    default: {
      const [x, y, w, h] = mapRect(a.x, a.y, a.w, a.h, f);
      return { ...a, x, y, w, h };
    }
  }
}

/** The mark moved by (dx, dy) points: a new object, same id. */
export function translateAnnot(a: PdfAnnot, dx: number, dy: number): PdfAnnot {
  if (dx === 0 && dy === 0) return a;
  return mapAnnot(a, (x, y) => [x + dx, y + dy]);
}

/** The mark carried from `fromBox` to `toBox` (a resize handle drag): every
 *  coordinate maps by the box-to-box affine; ink points scale, a text box's
 *  w/h change but never its font size, stroke widths stay. A zero-sized
 *  `fromBox` side maps with scale 1 on that axis (it cannot be stretched). */
export function scaleAnnot(a: PdfAnnot, fromBox: Box, toBox: Box): PdfAnnot {
  const [fx, fy, fw, fh] = fromBox;
  const [tx, ty, tw, th] = toBox;
  const sx = fw !== 0 ? tw / fw : 1;
  const sy = fh !== 0 ? th / fh : 1;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return a;
  return mapAnnot(a, (x, y) => [tx + (x - fx) * sx, ty + (y - fy) * sy]);
}
