// The page panel: the thumbnail rail in the editor's left panel, its context
// menu and the small footer under it (Insert, rotate). Every page operation is
// one undo step through the session, made with the pure ops of ../model.ts;
// the rail and the strip follow the project through the shell's page sync.
//
// "The selected pages" are the rail's selection, or the current page when
// nothing is selected — so a right-click, a footer button and the Delete key
// always act on something the user can see.

import { fileName } from "../../core/format";
import { ipc, pickPdfFiles } from "../../core/ipc";
import { PDF_MAX_PAGES } from "../../core/types";
import type { PdfSource, ProjectFile } from "../../core/types";
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
  insertSourcePages,
  newId,
  reorderPages,
  rotatePages,
} from "../model";
import type { PdfDoc, PdfEditorCtx, PdfThumbRail, PdfViewPage } from "../types";
import { createThumbRail, isPdfOpenError, openPdf } from "../view";
import { button, el } from "./el";

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
  menuItems(slots: readonly number[]): MenuItem[];
}

const pagesOf = (p: ProjectFile) => p.pdf?.pages ?? [];

const clampSide = (v: number): number => Math.min(SIDE_MAX, Math.max(SIDE_MIN, v));

export function createPageOps(ctx: PdfEditorCtx, deps: PagePanelDeps): PageOps {
  const { session } = ctx;

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

  const menuItems = (slots: readonly number[]): MenuItem[] => {
    const t = targets(slots);
    const n = pagesOf(session.project).length;
    const last = t[t.length - 1] ?? n - 1;
    const many = t.length > 1;
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
    ];
  };

  return { targets, rotate, duplicate, remove, insertBlank, insertFromPdf, menuItems };
}

/** Mount the rail and its footer into the left panel. */
export function mountPagePanel(host: HTMLElement, ctx: PdfEditorCtx, deps: PagePanelDeps): PagePanel {
  const ops = createPageOps(ctx, deps);
  const rail = createThumbRail({
    onPick: (slot) => ctx.view.scrollToPage(slot),
    onReorder: (keys) => ctx.session.commit((p) => reorderPages(p, keys)),
    onContextMenu: (slots, at) => showMenu(at.clientX, at.clientY, ops.menuItems(slots)),
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
    setPages: (pages) => rail.setPages(pages),
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
