// The page panel: the thumbnail rail in the editor's left panel, its context
// menu and the small footer under it (Insert, rotate). Every page operation is
// one undo step through the session, made with the pure ops of ../model.ts;
// the rail and the strip follow the project through the shell's page sync.
//
// "The selected pages" are the rail's selection, or the current page when
// nothing is selected — so a right-click, a footer button and the Delete key
// always act on something the user can see.

import { fileName } from "../../core/format";
import { describeError, ipc, mediaUrl, pickImageFiles, pickPdfFiles } from "../../core/ipc";
import { PDF_MAX_PAGES } from "../../core/types";
import { Store } from "../../core/store";
import type { MediaInfo, MediaRef, PdfPage, PdfSource, ProjectFile } from "../../core/types";
import { PICTURE_PAGE_SIZINGS, type PicturePageSizing } from "../../core/picture-page";
import { imgIcon } from "../../image/icons";
import { icon } from "../../ui/icons";
import { closeMenu, showMenu } from "../../ui/menu";
import type { MenuItem } from "../../ui/menu";
import { toast } from "../../ui/toast";
import {
  canAddPages,
  deletePages,
  duplicatePages,
  insertBlankPage,
  insertPicturePages,
  insertSourcePages,
  isPagePicture,
  isPagePictureSource,
  isPicturePage,
  mediaFileKey,
  missingPicturesOn,
  pageAnnots,
  newId,
  picturePageSizingOf,
  reorderPages,
  rotatePages,
  setPicturePageSizing,
} from "../model";
import type { PdfDoc, PdfEditorCtx, PdfThumbRail, PdfViewPage, PdfViewPicture } from "../types";
import { createThumbRail, isPdfOpenError, openPdf } from "../view";
import { button, el } from "./el";
import { PICTURE_SIZING_LABELS, askPicturePagesSizing } from "./pictures-dialog";
import { notePicturesFound } from "./missing-pictures";

/** A4 portrait in points: the size of a blank page with nothing to follow. */
export const A4: readonly [number, number] = [595.28, 841.89];
const SIDE_MIN = 1;
const SIDE_MAX = 14_400;

export interface PagePanelDeps {
  /** a part of the editor went away while an await was pending */
  isDisposed(): boolean;
  /** new documents to show (ctx.docs gains them; the shell re-syncs the strip) */
  addDocs(docs: PdfDoc[]): void;
  /** documents a refused insert opened and nothing uses */
  dropDocs(docs: PdfDoc[]): void;
  /** the export dialog, opened on a page: Extract pages (the PDF tab),
   *  Export page as image (the image tab) */
  openExport(pageSlot: number, tab: "pdf" | "image"): void;
  /** tests: stands in for the native multi-picture picker */
  pickPictures?(): Promise<string[]>;
  /** (0.9.5) open the picture relink for these media ids (the files of the
   *  pages' missing pictures). Absent: no "Relink picture" entry. */
  relinkPictures?(mediaIds: string[]): void;
}

export interface PagePanel {
  readonly rail: PdfThumbRail;
  setPages(pages: PdfViewPage[]): void;
  setCurrent(slot: number): void;
  /** the page operations, for the shell's own controls and the tests */
  ops: PageOps;
  dispose(): void;
}

export interface PageOps {
  /** sorted, de-duplicated, in range: `slots`, else the selection, else the current page */
  targets(slots?: readonly number[]): number[];
  rotate(slots: readonly number[], delta: 90 | -90): void;
  duplicate(slots: readonly number[]): void;
  /** false when refused (it would delete every page) */
  remove(slots: readonly number[]): boolean;
  insertBlank(afterSlot: number): Promise<void>;
  insertFromPdf(afterSlot: number): Promise<void>;
  /** Pictures as pages after `afterSlot` (0.9.5). `given` skips the picker
   *  (its paths are used in the order given) and/or the size question. */
  insertPictures(afterSlot: number, given?: { paths?: readonly string[]; sizing?: PicturePageSizing }): Promise<void>;
  /** (0.9.5) give the picture pages among `slots` another sizing, one undo
   *  step; other pages are skipped. False when nothing changed. */
  setSizing(slots: readonly number[], sizing: PicturePageSizing): boolean;
  /** (0.9.5) the media ids of the missing pictures on `slots`, one per file */
  missingOn(slots: readonly number[]): string[];
  /** `at`: where the menu was opened (the Page size choices open there) */
  menuItems(slots: readonly number[], at?: { clientX: number; clientY: number }): MenuItem[];
}

const pagesOf = (p: ProjectFile) => p.pdf?.pages ?? [];

/**
 * The rail's selection (ctx.pageSelection): slots to its readers, but held
 * as PAGE IDS underneath. Every set() reads its slots against the project's
 * pages at that moment and remembers the ids behind them; `remap` (the
 * shell's page sync, after any page change) turns those ids back into slots.
 * So a drag-reorder or an undo/redo keeps the same pages selected, and Delete
 * never removes a page that merely moved into a selected slot.
 */
export class PageSelection extends Store<number[]> {
  private ids: string[] = [];
  private readonly pages: () => readonly PdfPage[];
  constructor(pages: () => readonly PdfPage[]) {
    super([]);
    this.pages = pages;
  }
  override set(slots: number[]): void {
    const pages = this.pages();
    this.ids = slots.map((s) => pages[s]?.id).filter((id): id is string => id !== undefined);
    super.set(slots);
  }
  /** Re-map the remembered ids onto `pages` (pages gone drop out). */
  remap(pages: readonly PdfPage[]): void {
    const at = new Map(pages.map((pg, i) => [pg.id, i] as const));
    const kept = this.ids.filter((id) => at.has(id));
    const slots = kept.map((id) => at.get(id)!);
    this.ids = kept;
    const cur = this.get();
    if (slots.length !== cur.length || slots.some((s, i) => s !== cur[i])) super.set(slots);
  }
}

const clampSide = (v: number): number => Math.min(SIDE_MAX, Math.max(SIDE_MIN, v));

/** The Page size choices' marks: a tick on the current one, an empty glyph
 *  of the same size on the others so the labels line up (the app's own
 *  markup, never user text). */
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const NO_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"></svg>';

/* ---------------- pictures as pages (0.9.5) ---------------- */

let nameCollator: Intl.Collator | null = null;
/** The picker's paths in natural name order (Explorer's: "2" before "10",
 *  case ignored) — the picker's own order is none in particular. */
export function sortByName(paths: readonly string[]): string[] {
  nameCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const c = nameCollator;
  return [...paths].sort((a, b) => c.compare(fileName(a), fileName(b)));
}

/** Said once for the files a pick of pictures left out (the picture mark's
 *  own refusal, counted). */
export function skippedPicturesText(n: number): string {
  return n === 1
    ? "Skipped 1 file: only still pictures can be placed on a page."
    : `Skipped ${n} files: only still pictures can be placed on a page.`;
}

/** Probe the picked files, a few at a time, keeping their order; a file that
 *  fails or is not a still picture with a size is left out (counted by the
 *  caller). null when the editor went away meanwhile. */
export async function probePictures(
  paths: readonly string[],
  probe: (path: string) => Promise<MediaInfo>,
  gone: () => boolean,
): Promise<MediaInfo[] | null> {
  const out: (MediaInfo | null)[] = new Array<MediaInfo | null>(paths.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length && !gone()) {
      const i = next++;
      try {
        const info = await probe(paths[i]!);
        out[i] = isPagePictureSource(info) ? info : null;
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
  if (gone()) return null;
  return out.filter((x): x is MediaInfo => x !== null);
}

/** The rail's pages with each picture page's picture (its file and its box
 *  as fractions of the page), so the thumbnail shows what the page shows.
 *  Without any, the very list given comes back: no copy, no media lookup
 *  table, no URL or thumbnail helper reached. The media are looked up
 *  through a Map built once per call, on the first page picture met.
 *  `look.thumb` gives the small cached thumbnail of a file (see
 *  `railThumbs`); without it the rail shows the original. */
export function withPagePictures(
  pages: PdfViewPage[],
  p: ProjectFile,
  look: { url?: (path: string) => string; thumb?: (ref: MediaRef) => Promise<string>; missing?: (ref: MediaRef) => boolean } = {},
): PdfViewPage[] {
  let out: PdfViewPage[] | null = null;
  let byId: Map<string, MediaRef> | null = null;
  const missing = look.missing;
  for (let i = 0; i < pages.length; i++) {
    const vp = pages[i]!;
    // (0.9.5) any page with a missing picture is marked in the rail; asked
    // only while some file is known missing
    if (missing && missingPicturesOn(p, vp.key, missing).length > 0) {
      out ??= pages.slice();
      out[i] = { ...out[i]!, missingPicture: true };
    }
    if (vp.doc !== null) continue;
    const a = pageAnnots(p, vp.key).find(isPagePicture);
    if (!a) continue;
    byId ??= new Map(p.media.map((m) => [m.id, m]));
    const ref = byId.get(a.media);
    const w = vp.w ?? A4[0];
    const h = vp.h ?? A4[1];
    if (!ref || !(w > 0) || !(h > 0)) continue;
    const thumb = look.thumb;
    const gone = missing?.(ref) === true;
    const picture: PdfViewPicture = {
      file: mediaFileKey(ref),
      url: (look.url ?? mediaUrl)(ref.path),
      ...(thumb && !gone ? { thumb: () => thumb(ref) } : {}),
      ...(gone ? { missing: true as const } : {}),
      x: a.x / w,
      y: a.y / h,
      w: a.w / w,
      h: a.h / h,
    };
    out ??= pages.slice();
    out[i] = { ...out[i]!, picture };
  }
  return out ?? pages;
}

/** The rail's source of small pictures: the app's cached still thumbnail
 *  (`get_thumbnail` at 0 s — the same 320-px JPEG the media bin and Home ask
 *  for, turned as the WebView shows the file), asked ONCE per file identity
 *  for the editor's life (a failure is forgotten so a later rebuild may ask
 *  again; the rail falls back to the original meanwhile). */
export function railThumbs(ask: (ref: MediaRef) => Promise<string> = (ref) => ipc.getThumbnail({ path: ref.path, size: ref.size, mtimeMs: ref.mtimeMs }, 0).then(mediaUrl)): (ref: MediaRef) => Promise<string> {
  const asked = new Map<string, Promise<string>>();
  return (ref) => {
    const k = `${ref.path}|${ref.size}|${ref.mtimeMs}`;
    let pr = asked.get(k);
    if (!pr) {
      pr = ask(ref);
      asked.set(k, pr);
      pr.catch(() => {
        if (asked.get(k) === pr) asked.delete(k);
      });
    }
    return pr;
  };
}

export function createPageOps(ctx: PdfEditorCtx, deps: PagePanelDeps): PageOps {
  const { session } = ctx;
  let picturesBusy = false;

  const targets = (slots?: readonly number[]): number[] => {
    const n = pagesOf(session.project).length;
    const sel = slots && slots.length > 0 ? slots : ctx.pageSelection.get();
    const raw = sel.length > 0 ? sel : [ctx.view.state.get().current];
    return [...new Set(raw)].filter((s) => Number.isInteger(s) && s >= 0 && s < n).sort((a, b) => a - b);
  };
  const idsOf = (slots: readonly number[]): string[] => {
    const pages = pagesOf(session.project);
    return slots.map((s) => pages[s]?.id).filter((id): id is string => id !== undefined);
  };
  /** select these page ids in the rail (after an op moved them) */
  const reselect = (ids: readonly string[]): void => {
    const want = new Set(ids);
    const slots: number[] = [];
    pagesOf(session.project).forEach((pg, i) => {
      if (want.has(pg.id)) slots.push(i);
    });
    ctx.pageSelection.set(slots);
  };

  const rotate = (slots: readonly number[], delta: 90 | -90): void => {
    const ids = idsOf(targets(slots));
    if (ids.length > 0) session.commit((p) => rotatePages(p, ids, delta));
  };

  const duplicate = (slots: readonly number[]): void => {
    const ids = idsOf(targets(slots));
    if (ids.length === 0) return;
    const before = new Set(pagesOf(session.project).map((pg) => pg.id));
    session.commit((p) => duplicatePages(p, ids));
    const copies = pagesOf(session.project).filter((pg) => !before.has(pg.id)).map((pg) => pg.id);
    if (copies.length === 0) {
      toast.refuse(`A PDF project holds up to ${PDF_MAX_PAGES.toLocaleString()} pages.`);
      return;
    }
    reselect(copies);
  };

  const remove = (slots: readonly number[]): boolean => {
    const t = targets(slots);
    const n = pagesOf(session.project).length;
    if (t.length === 0) return false;
    if (t.length >= n) {
      toast.refuse("A document keeps at least one page.");
      return false;
    }
    const ids = idsOf(t);
    session.commit((p) => deletePages(p, ids));
    const left = pagesOf(session.project);
    const next = Math.min(t[0]!, left.length - 1);
    ctx.pageSelection.set(next >= 0 ? [next] : []);
    return true;
  };

  /** The displayed size of the page at `slot` (a blank inserted after it
   *  takes its shape), or A4 portrait. */
  const sizeOf = async (slot: number): Promise<[number, number]> => {
    const pg = pagesOf(session.project)[slot];
    if (!pg) return [A4[0], A4[1]];
    let w: number;
    let h: number;
    let turned = pg.rotate % 180 !== 0;
    if (pg.src === null) {
      w = pg.w ?? A4[0];
      h = pg.h ?? A4[1];
    } else {
      const doc = ctx.docs.get(pg.src);
      if (!doc) return [A4[0], A4[1]];
      try {
        const info = await doc.pageInfo(pg.page);
        w = info.w;
        h = info.h;
        turned = (info.rotate + pg.rotate) % 180 !== 0;
      } catch {
        return [A4[0], A4[1]];
      }
    }
    if (!(w > 0) || !(h > 0)) return [A4[0], A4[1]];
    return turned ? [clampSide(h), clampSide(w)] : [clampSide(w), clampSide(h)];
  };

  const insertBlank = async (afterSlot: number): Promise<void> => {
    const [w, h] = await sizeOf(afterSlot);
    if (deps.isDisposed()) return;
    if (!canAddPages(session.project, 1)) {
      toast.refuse(`A PDF project holds up to ${PDF_MAX_PAGES.toLocaleString()} pages.`);
      return;
    }
    const before = new Set(pagesOf(session.project).map((pg) => pg.id));
    session.commit((p) => insertBlankPage(p, afterSlot + 1, w, h));
    const added = pagesOf(session.project).filter((pg) => !before.has(pg.id)).map((pg) => pg.id);
    reselect(added);
    if (added.length > 0) ctx.view.scrollToPage(afterSlot + 1);
  };

  const insertFromPdf = async (afterSlot: number): Promise<void> => {
    const paths = await pickPdfFiles(true);
    if (deps.isDisposed() || paths.length === 0) return;
    const opened: { source: PdfSource; doc: PdfDoc }[] = [];
    const giveBack = (): void => deps.dropDocs(opened.map((o) => o.doc));
    let refusedProtected = false;
    for (const path of paths) {
      let stat: { size: number; mtimeMs: number } | null;
      try {
        stat = await ipc.fileStat(path);
      } catch {
        stat = null;
      }
      if (deps.isDisposed()) return giveBack();
      if (!stat) {
        toast.error(`Couldn't find ${fileName(path)}.`);
        continue;
      }
      const id = newId();
      try {
        const doc = await openPdf(id, path);
        if (deps.isDisposed()) {
          opened.push({ source: { id, path, size: stat.size, mtimeMs: stat.mtimeMs, pages: doc.numPages }, doc });
          return giveBack();
        }
        opened.push({ source: { id, path, size: stat.size, mtimeMs: stat.mtimeMs, pages: doc.numPages }, doc });
      } catch (e) {
        if (deps.isDisposed()) return giveBack();
        if (isPdfOpenError(e) && e.kind === "password") refusedProtected = true;
        else toast.error(`Couldn't open ${fileName(path)}.`);
      }
    }
    if (refusedProtected) toast.refuse("Protected PDFs can't be added.");
    if (opened.length === 0) return;
    const total = opened.reduce((n, o) => n + o.source.pages, 0);
    if (!canAddPages(session.project, total)) {
      toast.refuse(`A PDF project holds up to ${PDF_MAX_PAGES.toLocaleString()} pages.`);
      return giveBack();
    }
    // Shown before the commit: the strip's sync after it finds every new page's document.
    deps.addDocs(opened.map((o) => o.doc));
    const before = new Set(pagesOf(session.project).map((pg) => pg.id));
    // One undo step for the whole pick.
    session.commit((p) => {
      let q = p;
      let at = afterSlot + 1;
      for (const o of opened) {
        const n = pagesOf(q).length;
        q = insertSourcePages(q, at, o.source);
        at += pagesOf(q).length - n;
      }
      return q;
    });
    // A file already in the project under the same identity is reused: its
    // freshly opened copy is not needed.
    const used = new Set((session.project.pdf?.sources ?? []).map((s) => s.id));
    const spare = opened.filter((o) => !used.has(o.doc.id)).map((o) => o.doc);
    if (spare.length > 0) deps.dropDocs(spare);
    const added = pagesOf(session.project).filter((pg) => !before.has(pg.id)).map((pg) => pg.id);
    reselect(added);
    if (added.length > 0) ctx.view.scrollToPage(afterSlot + 1);
  };

  const insertPictures = async (afterSlot: number, given?: { paths?: readonly string[]; sizing?: PicturePageSizing }): Promise<void> => {
    if (picturesBusy) return;
    picturesBusy = true;
    // The picker, the size question and the probes all wait on the user or
    // the disk: pages may be deleted or moved meanwhile. The new pages go
    // after the page that was asked for, wherever it is by then — or at the
    // end when it is gone.
    const anchor = afterSlot >= 0 ? pagesOf(session.project)[afterSlot]?.id : undefined;
    const gapNow = (p: ProjectFile): number => {
      const list = pagesOf(p);
      if (afterSlot < 0) return 0;
      const i = anchor === undefined ? -1 : list.findIndex((pg) => pg.id === anchor);
      return i >= 0 ? i + 1 : list.length;
    };
    try {
      const picked = given?.paths ? [...given.paths] : sortByName(await (deps.pickPictures ?? pickImageFiles)());
      if (deps.isDisposed() || picked.length === 0) return;
      if (!canAddPages(session.project, picked.length)) {
        toast.refuse(`A PDF project holds up to ${PDF_MAX_PAGES.toLocaleString()} pages.`);
        return;
      }
      const sizing = given?.sizing ?? (await askPicturePagesSizing(ctx, picked.length));
      if (deps.isDisposed() || sizing === null) return;
      const infos = await probePictures(picked, (path) => ipc.probeMedia(path), deps.isDisposed);
      if (infos === null) return;
      const skipped = picked.length - infos.length;
      if (skipped > 0) toast.refuse(skippedPicturesText(skipped));
      if (infos.length === 0) return;
      const before = new Set(pagesOf(session.project).map((pg) => pg.id));
      // One undo step for the whole pick.
      let at = 0;
      session.commit((p) => {
        at = gapNow(p);
        return insertPicturePages(p, at, infos, sizing);
      });
      const added = pagesOf(session.project).filter((pg) => !before.has(pg.id)).map((pg) => pg.id);
      if (added.length === 0) {
        // only the page limit refuses a set of readable stills
        toast.refuse(`A PDF project holds up to ${PDF_MAX_PAGES.toLocaleString()} pages.`);
        return;
      }
      // a file picked again that was missing is there after all
      notePicturesFound(ctx, infos);
      reselect(added);
      ctx.view.scrollToPage(at);
    } catch (e) {
      if (!deps.isDisposed()) toast.error(`Couldn't add the pictures: ${describeError(e)}`);
    } finally {
      picturesBusy = false;
    }
  };

  const setSizing = (slots: readonly number[], sizing: PicturePageSizing): boolean => {
    const ids = idsOf(targets(slots));
    if (ids.length === 0) return false;
    const before = session.project;
    session.commit((p) => setPicturePageSizing(p, ids, sizing));
    return session.project !== before;
  };

  const missingOn = (slots: readonly number[]): string[] => {
    const set = ctx.missingPictures?.get();
    if (!set || set.size === 0) return [];
    const isMissing = (ref: MediaRef): boolean => set.has(mediaFileKey(ref));
    const p = session.project;
    const out: string[] = [];
    const files = new Set<string>();
    for (const id of idsOf(targets(slots))) {
      for (const m of missingPicturesOn(p, id, isMissing)) {
        const ref = p.media.find((x) => x.id === m)!;
        const key = mediaFileKey(ref);
        if (files.has(key)) continue;
        files.add(key);
        out.push(m);
      }
    }
    return out;
  };

  /** The Page size choices for the picture pages among `t`, the sizing they
   *  all share now marked (none when they differ or match none). */
  const sizingItems = (t: readonly number[]): MenuItem[] => {
    const pages = pagesOf(session.project);
    const ids = t.map((s) => pages[s]?.id).filter((id): id is string => id !== undefined && isPicturePage(session.project, id));
    const now = new Set(ids.map((id) => picturePageSizingOf(session.project, id)));
    const current = now.size === 1 ? [...now][0]! : null;
    return PICTURE_PAGE_SIZINGS.map((s) => ({
      label: PICTURE_SIZING_LABELS[s],
      icon: s === current ? CHECK_ICON : NO_ICON,
      onSelect: () => void setSizing(t, s),
    }));
  };

  const menuItems = (slots: readonly number[], at?: { clientX: number; clientY: number }): MenuItem[] => {
    const t = targets(slots);
    const n = pagesOf(session.project).length;
    const last = t[t.length - 1] ?? n - 1;
    const many = t.length > 1;
    const pages = pagesOf(session.project);
    const pictures = t.filter((s) => pages[s] !== undefined && isPicturePage(session.project, pages[s]!.id));
    const extra: MenuItem[] = [];
    if (pictures.length > 0) {
      const now = new Set(pictures.map((s) => picturePageSizingOf(session.project, pages[s]!.id)));
      const current = now.size === 1 ? [...now][0]! : null;
      extra.push({
        label: "Page size",
        hint: current ? PICTURE_SIZING_LABELS[current] : undefined,
        onSelect: () => {
          // the choices open where the page menu was
          const x = at?.clientX ?? 0;
          const y = at?.clientY ?? 0;
          showMenu(x, y, sizingItems(t), undefined, at === undefined);
        },
      });
    }
    const gone = deps.relinkPictures ? missingOn(t) : [];
    if (gone.length > 0) {
      extra.push({ label: "Relink picture", icon: icon("warning", 14), onSelect: () => deps.relinkPictures?.(gone) });
    }
    return [
      { label: "Rotate right", icon: imgIcon("rotateRight", 14), onSelect: () => rotate(t, 90) },
      { label: "Rotate left", icon: imgIcon("rotateLeft", 14), onSelect: () => rotate(t, -90) },
      { label: many ? "Duplicate pages" : "Duplicate page", onSelect: () => duplicate(t) },
      {
        label: many ? "Delete pages" : "Delete page",
        icon: icon("trash", 14),
        disabled: t.length >= n,
        title: t.length >= n ? "A document keeps at least one page" : undefined,
        onSelect: () => void remove(t),
      },
      { label: "Insert blank page after", icon: icon("plus", 14), onSelect: () => void insertBlank(last) },
      { label: "Insert pages from PDF", onSelect: () => void insertFromPdf(last) },
      { label: "Extract pages", onSelect: () => deps.openExport(t[0] ?? 0, "pdf") },
      { label: "Export page as image", onSelect: () => deps.openExport(t[0] ?? 0, "image") },
      ...extra,
    ];
  };

  return { targets, rotate, duplicate, remove, insertBlank, insertFromPdf, insertPictures, setSizing, missingOn, menuItems };
}

/** Mount the rail and its footer into the left panel. */
export function mountPagePanel(host: HTMLElement, ctx: PdfEditorCtx, deps: PagePanelDeps): PagePanel {
  const ops = createPageOps(ctx, deps);
  const thumb = railThumbs();
  const rail = createThumbRail({
    onPick: (slot) => ctx.view.scrollToPage(slot),
    onReorder: (keys) => ctx.session.commit((p) => reorderPages(p, keys)),
    onContextMenu: (slots, at) => showMenu(at.clientX, at.clientY, ops.menuItems(slots, at)),
    selection: ctx.pageSelection,
  });
  rail.el.classList.add("pdfed-rail");

  // Delete with the rail focused deletes pages, never the marks a tool has
  // selected: stopped here, before the window's shortcut listener hears it.
  const onRailKey = (e: KeyboardEvent): void => {
    if (e.key !== "Delete" || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    ops.remove(ops.targets());
  };
  rail.el.addEventListener("keydown", onRailKey);

  // Blur after a click: a focused button would take the next Space (hold to
  // pan) as a click. A keyboard activation keeps focus for the next key.
  const onClick = (b: HTMLButtonElement, fn: (e: MouseEvent) => void): void => {
    b.addEventListener("click", (e) => {
      if (e.detail > 0) b.blur();
      fn(e);
    });
  };
  const insertBtn = button("btn--ghost btn--sm", {
    id: "pdfed-insert",
    icon: icon("plus", 14),
    text: "Insert",
    title: "Insert pages after the selected page",
    attrs: { "aria-haspopup": "menu" },
  });
  const rotL = button("btn--ghost btn--icon btn--sm", { id: "pdfed-rot-left", title: "Rotate left", label: "Rotate left", icon: imgIcon("rotateLeft", 14) });
  const rotR = button("btn--ghost btn--icon btn--sm", { id: "pdfed-rot-right", title: "Rotate right", label: "Rotate right", icon: imgIcon("rotateRight", 14) });
  onClick(insertBtn, (e) => {
    const t = ops.targets();
    const after = t[t.length - 1] ?? 0;
    const r = insertBtn.getBoundingClientRect();
    showMenu(
      r.left,
      r.bottom + 4,
      [
        { label: "Blank page", onSelect: () => void ops.insertBlank(after) },
        { label: "Pictures", onSelect: () => void ops.insertPictures(after) },
        { label: "Pages from PDF", onSelect: () => void ops.insertFromPdf(after) },
      ],
      r.top - 4,
      e.detail === 0,
    );
  });
  onClick(rotL, () => ops.rotate(ops.targets(), -90));
  onClick(rotR, () => ops.rotate(ops.targets(), 90));
  const footer = el("div", { className: "pdfed-pages__footer" }, [insertBtn, el("div", { className: "grow" }), rotL, rotR]);

  host.appendChild(rail.el);
  host.appendChild(footer);

  return {
    rail,
    ops,
    setPages: (pages) => {
      const set = ctx.missingPictures?.get();
      const missing = set && set.size > 0 ? (ref: MediaRef): boolean => set.has(mediaFileKey(ref)) : undefined;
      rail.setPages(withPagePictures(pages, ctx.session.project, { thumb, ...(missing ? { missing } : {}) }));
    },
    setCurrent: (slot) => rail.setCurrent(slot),
    dispose() {
      closeMenu();
      rail.el.removeEventListener("keydown", onRailKey);
      rail.dispose();
      rail.el.remove();
      footer.remove();
    },
  };
}
