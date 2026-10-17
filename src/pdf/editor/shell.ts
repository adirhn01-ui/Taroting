// PDF editor shell: a PDF project (kind "pdf", schema 4) opened from the
// ordinary editor route. Loaded lazily by `mountEditor` once the project is
// known to be a PDF project; never prefetched, so a user who never opens one
// never loads this chunk (or pdf.js).
//
// The shell owns the frame (top bar, page panel, page strip, tool row), the
// session, the open source documents and the app-shell duties of the image
// editor's SHELL CONTRACT (src/image/image-editor.ts, the comment above
// mountImageEditor — all ten points apply here unchanged). The tools, the
// inspector and the Fill forms switch are PARTS mounted into hosts it gives
// them, and they only talk to it through the PdfEditorCtx it builds. It reuses
// the video editor's shell classes and route-out ids (#ed-home, #ed-name,
// #ed-save, #ed-keep, #ed-settings, #ed-export), so the nav rescue, the
// Temporary badge and the E2E helpers apply unchanged.
//
// Zero overhead at idle: no frame loop and no timer of its own (the strip
// renders on scroll/zoom/resize only; the session's autosave and a form
// field's 1 s typing pause are the only timers, both armed by an edit).

import "../../editor/editor.css";
import "./editor.css";
import { registerCloseTask } from "../../core/app-close";
import { describeError, ipc } from "../../core/ipc";
import type { LoadedProject } from "../../core/ipc";
import { exitDest, navigate } from "../../core/nav";
import type { EditorRoute, Route } from "../../core/nav";
import { isPdfProject } from "../../core/pdf-project";
import { ProjectSession, currentSession, settingsStore } from "../../core/session";
import {
  ShortcutManager,
  chordOf,
  isTypingTarget,
  normalizeChord,
  physicalChordOf,
  shortcutsBlocked,
} from "../../core/shortcuts";
import { Store } from "../../core/store";
import type { ActionId, PdfFormValue, PdfPage, ProjectFile } from "../../core/types";
import { imgIcon } from "../../image/icons";
import { icon } from "../../ui/icons";
import { closeMenu, showMenu } from "../../ui/menu";
import { createTempExits, createTempLeaveGate } from "../../ui/temp-project";
import { toast } from "../../ui/toast";
import { deletePages, formValue, setFormValue } from "../model";
import type { PdfDoc, PdfEditorCtx, PdfEditorHosts, PdfToolState, PdfViewPage } from "../types";
import { createPdfView, createSearch, renderPageToBlob } from "../view";
import { button, el } from "./el";
import { openPdfExportDialog } from "./export-dialog";
import { mountFind } from "./find";
import { formsPart } from "./forms";
import { inspectorPart } from "./inspector";
import { PageSelection, mountPagePanel } from "./pages";
import { blankCover, writeCover } from "./save";
import { openSources, openSourcesDialog } from "./sources";
import type { SourceIssue } from "./sources";
import { toolsPart } from "./tools";

/** CSS px per point at the UI's "100%": a page at its printed size. */
export const ZOOM_100 = 96 / 72;
/** The zoom ladder, in the UI's percent (100 = printed size). */
export const ZOOM_LADDER: readonly number[] = [10, 25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600];
/** A form field's typing becomes one undo step after this pause (or on blur). */
export const FORM_IDLE_MS = 1000;
/** Long side of the Home card cover, px. */
const COVER_PX = 512;
const THUMB_CAP_MS = 1500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The UI's zoom percent for a view zoom. */
export const zoomPct = (zoom: number): number => Math.round((zoom / ZOOM_100) * 100);

/** The next rung of ZOOM_LADDER above/below the current zoom, as a view
 *  zoom; null at the ends. */
export function zoomStep(zoom: number, dir: 1 | -1): number | null {
  const pct = (zoom / ZOOM_100) * 100;
  let next: number | undefined;
  if (dir > 0) next = ZOOM_LADDER.find((p) => p > pct + 0.5);
  else for (let i = ZOOM_LADDER.length - 1; i >= 0 && next === undefined; i--) if (ZOOM_LADDER[i]! < pct - 0.5) next = ZOOM_LADDER[i];
  return next === undefined ? null : (next / 100) * ZOOM_100;
}

/** Ctrl+wheel: a zoom factor per wheel event (deltaY in px). */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-300, Math.min(300, px)) * 0.002);
}

/** The tool state a mount starts with (transient: never saved). Colours and
 *  sizes match the image editor's defaults where the tool exists there. */
export function defaultToolState(): PdfToolState {
  return {
    tool: "select",
    colors: { highlight: "#ffd400", pen: "#000000", pencil: "#3a3a3a", marker: "#ffd400", shape: "#e5484d", text: "#000000" },
    sizes: { pen: 4, pencil: 2, marker: 18, eraser: 16, shape: 4, text: 14 },
    shape: "arrow",
    font: "Segoe UI",
    ruler: null,
  };
}

/** Map the project's pages to the strip's slots. A page whose source did not
 *  open shows as a blank slot of the default size. */
export function viewPagesOf(pages: readonly PdfPage[], docs: ReadonlyMap<string, PdfDoc>): PdfViewPage[] {
  return pages.map((pg) =>
    pg.src === null
      ? { key: pg.id, doc: null, index: 0, rotate: pg.rotate, w: pg.w, h: pg.h }
      : { key: pg.id, doc: docs.get(pg.src) ?? null, index: pg.page, rotate: pg.rotate },
  );
}

/** What the Home card shows: the first page's identity. A change to it (a
 *  reorder, a rotate, a relinked source) makes a new card owed. */
export function coverKey(p: ProjectFile): string {
  const pg = p.pdf?.pages[0];
  if (!pg) return "";
  if (pg.src === null) return `blank|${pg.w}|${pg.h}|${pg.rotate}`;
  const s = p.pdf!.sources.find((x) => x.id === pg.src);
  return `${s?.path}|${s?.size}|${s?.mtimeMs}|${pg.page}|${pg.rotate}`;
}

/** Whether the rail is open: per app session, not saved. */
let railOpen = true;

/**
 * Mount the PDF editor for a project `mountEditor` has already loaded (and
 * sanitized: ipc.loadProject lazily loads core/pdf-sanitize for kind "pdf").
 * Honours the image editor's SHELL CONTRACT in full; never rejects.
 */
export async function mountPdfEditor(
  root: HTMLElement,
  route: EditorRoute,
  isStale: () => boolean,
  loaded: LoadedProject,
): Promise<{ dispose(): Promise<void> }> {
  const noop = { dispose: async (): Promise<void> => {} };
  if (isStale()) return noop;
  const built: Built = { session: null, teardown: [], closeOverlays: null, docs: null };
  try {
    // Validate first: nothing below reads a project that is not a PDF one.
    const project = loaded.project;
    if (!isPdfProject(project) || !project.pdf || project.pdf.pages.length === 0) {
      throw new Error("This file isn't a PDF project Taroting can open.");
    }
    const { docs, issues } = await openSources(project.pdf.sources, project);
    built.docs = docs;
    // Superseded while the documents opened: give them back, touch nothing.
    if (isStale()) {
      void destroyDocs(docs);
      return noop;
    }
    return mount(root, route, loaded, issues, built);
  } catch (e) {
    built.closeOverlays?.();
    runTeardown(built.teardown);
    closeMenu();
    const s = built.session;
    if (s) {
      if (currentSession.get() === s) currentSession.set(null);
      void s.dispose();
    }
    if (built.docs) void destroyDocs(built.docs);
    // Superseded: the root belongs to the newer screen now — leave it be.
    if (isStale()) return noop;
    root.textContent = "";
    toast.error(`Couldn't open this PDF project: ${describeError(e)}`);
    navigate(exitDest(route));
    return noop;
  }
}

interface Built {
  session: ProjectSession | null;
  teardown: (() => void)[];
  closeOverlays: (() => void) | null;
  docs: Map<string, PdfDoc> | null;
}

function runTeardown(list: (() => void)[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i]!();
    } catch (e) {
      console.error("A PDF editor part failed to close", e);
    }
  }
  list.length = 0;
}

async function destroyDocs(docs: Map<string, PdfDoc>, keep?: PdfDoc | null, after?: Promise<void>): Promise<void> {
  const all = [...new Set(docs.values())];
  docs.clear();
  await Promise.all(
    all.map((d) => {
      // The document a cover render still reads goes when that render is done.
      if (d === keep && after) {
        void after.finally(() => d.destroy());
        return Promise.resolve();
      }
      return d.destroy().catch(() => {});
    }),
  );
}

/** The synchronous body of the mount: no await, so no window in which a newer
 *  navigation could supersede it half-way. */
function mount(
  root: HTMLElement,
  route: EditorRoute,
  loaded: LoadedProject,
  issues: SourceIssue[],
  built: Built,
): { dispose(): Promise<void> } {
  const undo = built.teardown;
  const docs = built.docs!;

  /* ---------------- session, publish ---------------- */

  const session = new ProjectSession(route.projectPath, loaded.project, {
    temp: route.temp === true,
    debounceMs: 2500,
  });
  built.session = session;
  const exits = createTempExits(session, createTempLeaveGate(session));
  if (session.temp.get()) session.leaveGuard = () => exits.confirm();
  currentSession.set(session);

  let disposed = false;
  // The failure path too: anything a pending await resumes into sees this.
  undo.push(() => {
    disposed = true;
  });

  /* ---------------- layout ---------------- */

  const shortcutsNow = settingsStore.get().shortcuts;
  const titled = (label: string, action: ActionId): string => {
    const chord = normalizeChord(shortcutsNow[action] ?? "");
    return chord ? `${label} (${chord})` : label;
  };
  const homeLabel = route.returnTo ? "Back to viewer" : "Back to projects";

  const homeBtn = button("btn--ghost btn--icon", { id: "ed-home", title: homeLabel, label: homeLabel, icon: icon("chevronLeft") });
  const nameEl = el("div", { id: "ed-name", className: "editor__name", title: "Rename project", text: session.project.name, attrs: { tabindex: "0" } });
  const saveEl = el("div", { id: "ed-save", className: "editor__savestate", text: "Saved" });
  const topHost = el("div", { id: "pdfed-topbar", className: "pdfed-topbar" });
  const settingsBtn = button("btn--ghost btn--icon", { id: "ed-settings", title: "Settings", label: "Settings", icon: icon("gear") });
  const exportBtn = button("btn--primary", { id: "ed-export", title: titled("Export", "export"), icon: icon("export"), text: "Export" });

  const pagesEl = el("aside", { id: "pdfed-pages", className: "media-panel pdfed-pages" });
  const stage = el("div", { id: "pdfed-stage", className: "editor__preview pdfed-stage" });
  const toolsHost = el("div", { id: "pdfed-tools", className: "pdfed-tools" });
  const sep = (): HTMLElement => el("span", { className: "pdfed-sep", attrs: { "aria-hidden": "true" } });
  const railBtn = button("btn--ghost btn--icon btn--sm", { id: "pdfed-rail-toggle", title: "Pages", label: "Show pages", icon: imgIcon("layers", 14) });
  const undoBtn = button("btn--ghost btn--icon btn--sm", { id: "pdfed-undo", title: titled("Undo", "undo"), label: "Undo", icon: imgIcon("undo", 14) });
  const redoBtn = button("btn--ghost btn--icon btn--sm", { id: "pdfed-redo", title: titled("Redo", "redo"), label: "Redo", icon: imgIcon("redo", 14) });
  const zoomOutBtn = button("btn--ghost btn--icon btn--sm", { id: "pdfed-zoom-out", title: titled("Zoom out", "imgZoomOut"), label: "Zoom out", icon: icon("zoomOut", 14) });
  const zoomBtn = button("btn--ghost btn--sm mono pdfed-zoom", { id: "pdfed-zoom", title: "Zoom", text: "100%", attrs: { "aria-haspopup": "menu" } });
  const zoomInBtn = button("btn--ghost btn--icon btn--sm", { id: "pdfed-zoom-in", title: titled("Zoom in", "imgZoomIn"), label: "Zoom in", icon: icon("zoomIn", 14) });
  const pageInput = el("input", { id: "pdfed-page", className: "input mono pdfed-pagenum", title: "Go to page", attrs: { "aria-label": "Page number", inputmode: "numeric" } });
  pageInput.type = "text";
  pageInput.spellcheck = false;
  const pageCount = el("span", { id: "pdfed-page-count", className: "pdfed-pagecount mono", text: "/ 0" });
  const findBtn = button("btn--ghost btn--icon btn--sm", { id: "pdfed-find-btn", title: titled("Find", "find"), label: "Find", icon: icon("search", 14) });
  const inspectorHost = el("aside", { id: "pdfed-inspector", className: "inspector-panel pdfed-inspector" });
  undoBtn.disabled = true;
  redoBtn.disabled = true;

  const frame = el("div", { className: "editor pdfed" }, [
    el("div", { className: "editor__topbar" }, [homeBtn, nameEl, saveEl, el("div", { className: "grow" }), topHost, settingsBtn, exportBtn]),
    el("div", { className: "editor__body" }, [
      pagesEl,
      el("div", { className: "editor__main" }, [
        stage,
        el("div", { className: "transport pdfed-toolrow no-select" }, [
          railBtn,
          sep(),
          toolsHost,
          el("div", { id: "pdfed-viewctl", className: "pdfed-viewctl" }, [
            undoBtn,
            redoBtn,
            sep(),
            zoomOutBtn,
            zoomBtn,
            zoomInBtn,
            sep(),
            el("div", { className: "pdfed-pageind" }, [pageInput, pageCount]),
            sep(),
            findBtn,
          ]),
        ]),
      ]),
      inspectorHost,
    ]),
  ]);
  root.textContent = "";
  root.appendChild(frame);
  undo.push(() => {
    // Only while the root still shows this frame: a failed mount that a newer
    // navigation superseded must not wipe that screen.
    if (frame.parentNode === root) root.textContent = "";
  });

  /* ---------------- overlays (body-parked surfaces) ---------------- */

  const overlays = new Set<() => void>();
  const registerOverlay = (close: () => void): (() => void) => {
    const entry = (): void => close();
    overlays.add(entry);
    return () => {
      overlays.delete(entry);
    };
  };
  const closeOverlays = (): void => {
    for (const close of [...overlays]) {
      overlays.delete(close);
      try {
        close();
      } catch (e) {
        console.error("A PDF editor overlay failed to close", e);
      }
    }
  };
  built.closeOverlays = closeOverlays;

  /* ---------------- form typing: one undo step per field ---------------- */

  // Typing in a form field is shown at once through replace() (no history)
  // and becomes ONE undo step when the field loses focus, another field is
  // typed into, 1 s passes without a keystroke, or anything else commits /
  // undoes — the inspector's slider-drag pattern.
  const rawCommit = session.commit.bind(session);
  const rawCommitFrom = session.commitFrom.bind(session);
  const rawUndo = session.undo.bind(session);
  const rawRedo = session.redo.bind(session);
  /** the form values the strip shows (see syncForms) */
  let shownForms: Record<string, Record<string, PdfFormValue>> | null = session.project.pdf?.forms ?? null;
  let typing: { field: string; before: ProjectFile; timer: number } | null = null;
  const endTyping = (): void => {
    const t = typing;
    if (!t) return;
    typing = null;
    window.clearTimeout(t.timer);
    rawCommitFrom(t.before);
    if (!disposed) refreshUndo();
  };
  undo.push(() => {
    if (typing) window.clearTimeout(typing.timer);
  });
  const formSet = (docId: string, annotId: string, value: PdfFormValue): void => {
    if (disposed) return;
    const field = `${docId}\n${annotId}`;
    if (typing && typing.field !== field) endTyping();
    const next = setFormValue(session.project, docId, annotId, value);
    if (next === session.project) return;
    if (!typing) typing = { field, before: session.project, timer: 0 };
    window.clearTimeout(typing.timer);
    // The field already shows this value: the forms sync must not re-render
    // the page under the user's cursor for it.
    shownForms = next.pdf?.forms ?? null;
    session.replace(next);
    typing.timer = window.setTimeout(endTyping, FORM_IDLE_MS);
  };
  // Every other history change first closes the typing step, so the steps
  // stay in the order they happened. Nothing to restore on dispose: the
  // session dies with the screen.
  session.commit = (mutate) => {
    endTyping();
    rawCommit(mutate);
  };
  session.commitFrom = (before) => {
    endTyping();
    rawCommitFrom(before);
    if (!disposed) refreshUndo();
  };
  session.undo = () => {
    endTyping();
    rawUndo();
  };
  session.redo = () => {
    endTyping();
    rawRedo();
  };

  /* ---------------- view, ctx ---------------- */

  const view = createPdfView({
    textLayer: true,
    forms: {
      get: (docId, annotId) => formValue(session.project, docId, annotId),
      set: formSet,
    },
  });
  view.el.classList.add("pdfed-strip");
  stage.appendChild(view.el);
  undo.push(() => view.dispose());

  const shortcuts = new ShortcutManager("pdf");
  shortcuts.setBindings(settingsStore.get().shortcuts);
  const modalOpen = (): boolean => document.querySelector(".modal-backdrop") !== null;
  shortcuts.setSuppressed(modalOpen);
  // Parts share the one manager: per action a stack, the latest handler wins
  // until its unbind. The manager has no removal, so an action keeps its
  // dispatcher once bound; an empty stack does nothing.
  const stacks = new Map<ActionId, ((e: KeyboardEvent) => void)[]>();
  const bindKey = (action: ActionId, fn: (e: KeyboardEvent) => void): (() => void) => {
    let stack = stacks.get(action);
    if (!stack) {
      const s: ((e: KeyboardEvent) => void)[] = [];
      stack = s;
      stacks.set(action, s);
      shortcuts.on(action, (e) => s[s.length - 1]?.(e));
    }
    const entry = (e: KeyboardEvent): void => fn(e);
    stack.push(entry);
    const own = stack;
    return () => {
      const i = own.indexOf(entry);
      if (i >= 0) own.splice(i, 1);
      // An empty stack must not keep swallowing the chord.
      if (own.length === 0 && stacks.get(action) === own) {
        stacks.delete(action);
        shortcuts.off(action);
      }
    };
  };

  const isTyping = (target: EventTarget | null): boolean => {
    if (isTypingTarget(target)) return true;
    if (!(target instanceof Element)) return false;
    // pdf.js form widgets (checkboxes and buttons too: Space and Delete
    // belong to them) and anything a tool made editable inside the strip.
    if (target.closest(".annotationLayer") && target.closest("input, textarea, select, button")) return true;
    return target.closest(".textLayer [contenteditable], .annotationLayer [contenteditable]") !== null;
  };

  const ctx: PdfEditorCtx = {
    session,
    view,
    docs,
    tools: new Store<PdfToolState>(defaultToolState()),
    selection: new Store<{ key: string; id: string }[]>([]),
    pageSelection: new PageSelection(() => session.project.pdf?.pages ?? []),
    mode: new Store<"annotate" | "forms">("annotate"),
    hasForms: new Store<boolean>(false),
    holdAutosave: () => session.holdAutosave(),
    registerOverlay,
    bindKey,
    isTyping,
    leave: (to) => leave(to),
  };

  /* ---------------- page panel, find ---------------- */

  const panel = mountPagePanel(pagesEl, ctx, {
    isDisposed: () => disposed,
    addDocs: (list) => {
      for (const d of list) docs.set(d.id, d);
    },
    dropDocs: (list) => {
      for (const d of list) {
        if (docs.get(d.id) === d) docs.delete(d.id);
        void d.destroy();
      }
      if (!disposed) syncPages(true);
    },
    openExport: (pageSlot, tab) => openExport({ pageSlot, tab }),
  });
  undo.push(() => panel.dispose());

  let viewPages: PdfViewPage[] = [];
  const search = createSearch(() => viewPages);
  const find = mountFind(stage, ctx, search, () => viewPages.map((p) => p.key));
  undo.push(() => find.dispose());

  /* ---------------- page sync ---------------- */

  let shownPages: readonly PdfPage[] | null = null;
  function syncPages(force = false): void {
    const pages = session.project.pdf?.pages ?? [];
    if (!force && pages === shownPages) return;
    shownPages = pages;
    viewPages = viewPagesOf(pages, docs);
    view.setPages(viewPages);
    panel.setPages(viewPages);
    // The selection stays on the same pages (moved, or gone).
    (ctx.pageSelection as PageSelection).remap(pages);
    find.refresh();
    paintPage();
  }

  /* ---------------- form values on screen ---------------- */

  // The strip reads a field's value when it renders the page, and keeps the
  // pages (setFormValue leaves pdf.pages alone), so an undo/redo of a value or
  // a Clear form would leave the fields showing the old values. Any change of
  // pdf.forms that the user did not just type re-renders the pages of the
  // sources whose values changed.
  function syncForms(): void {
    const forms = session.project.pdf?.forms ?? null;
    if (forms === shownForms) return;
    const was = shownForms;
    shownForms = forms;
    const changed = new Set<string>();
    for (const id of new Set([...Object.keys(was ?? {}), ...Object.keys(forms ?? {})])) {
      if (was?.[id] !== forms?.[id]) changed.add(id);
    }
    if (changed.size === 0) return;
    for (const pg of session.project.pdf?.pages ?? []) {
      if (pg.src !== null && changed.has(pg.src)) view.invalidate(pg.id);
    }
  }

  const unsubs: (() => void)[] = [];
  undo.push(() => {
    for (const u of unsubs) u();
  });

  /* ---------------- top bar: save badge, Keep, name ---------------- */

  function paintSaveBadge(): void {
    const s = session.saveState.get();
    saveEl.classList.toggle("editor__savestate--error", s === "error");
    const text = session.temp.get()
      ? s === "error"
        ? "Save failed"
        : "Temporary"
      : s === "saved"
        ? "Saved"
        : s === "saving"
          ? "Saving"
          : s === "dirty"
            ? "Edited"
            : "Save failed";
    if (saveEl.textContent !== text) saveEl.textContent = text;
    paintKeep();
  }
  let keepBtn: HTMLButtonElement | null = null;
  function paintKeep(): void {
    if (!session.temp.get()) {
      keepBtn?.remove();
      keepBtn = null;
      session.leaveGuard = null;
      return;
    }
    if (keepBtn) return;
    const b = button("btn--ghost btn--sm editor__keep", { id: "ed-keep", title: "Keep this project in your library", text: "Keep" });
    b.addEventListener("click", () => {
      b.blur();
      void exits.keep().then((r) => {
        // The Home card needs a picture of the project it now lists.
        if (r === "kept" && !disposed) void writeCoverNow();
      });
    });
    saveEl.after(b);
    keepBtn = b;
  }
  paintSaveBadge();
  unsubs.push(session.saveState.subscribe(paintSaveBadge));
  unsubs.push(session.temp.subscribe(paintSaveBadge));

  let renaming = false;
  function syncName(): void {
    if (!renaming && nameEl.textContent !== session.project.name) nameEl.textContent = session.project.name;
  }
  function startRename(): void {
    if (renaming) return;
    renaming = true;
    const current = session.project.name;
    const input = el("input", { className: "input editor__name-input" });
    input.value = current;
    input.spellcheck = false;
    nameEl.textContent = "";
    nameEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      renaming = false;
      if (save) {
        const value = input.value.trim();
        if (value.length > 0 && value !== current) session.commit((p) => ({ ...p, name: value }));
      }
      nameEl.textContent = session.project.name;
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }
  nameEl.addEventListener("click", startRename);
  nameEl.addEventListener("keydown", (e) => {
    if (!renaming && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      // the rename's key: hold-to-pan must not hear this Space
      e.stopPropagation();
      startRename();
    }
  });

  /* ---------------- tool row ---------------- */

  function refreshUndo(): void {
    const u = !session.history.canUndo && typing === null;
    const r = !session.history.canRedo;
    if (undoBtn.disabled !== u) undoBtn.disabled = u;
    if (redoBtn.disabled !== r) redoBtn.disabled = r;
  }
  const doUndo = (): void => {
    session.undo();
    refreshUndo();
  };
  const doRedo = (): void => {
    session.redo();
    refreshUndo();
  };

  function paintZoom(): void {
    const text = `${zoomPct(view.state.get().zoom)}%`;
    if (zoomBtn.textContent !== text) zoomBtn.textContent = text;
  }
  function paintPage(): void {
    const s = view.state.get();
    const total = viewPages.length;
    const count = `/ ${total}`;
    if (pageCount.textContent !== count) pageCount.textContent = count;
    if (document.activeElement !== pageInput) {
      const v = total > 0 ? String(Math.min(s.current, total - 1) + 1) : "";
      if (pageInput.value !== v) pageInput.value = v;
    }
  }
  const zoomBy = (dir: 1 | -1): void => {
    const next = zoomStep(view.state.get().zoom, dir);
    if (next !== null) view.setZoom(next);
  };

  // Blur after a POINTER click, like the transport: a focused button would
  // take the next Space (hold to pan) as a click.
  const onClick = (b: HTMLElement, fn: (e: MouseEvent) => void): void => {
    b.addEventListener("click", (e) => {
      if (e.detail > 0) b.blur();
      fn(e);
    });
  };
  onClick(undoBtn, doUndo);
  onClick(redoBtn, doRedo);
  onClick(zoomOutBtn, () => zoomBy(-1));
  onClick(zoomInBtn, () => zoomBy(1));
  onClick(zoomBtn, (e) => {
    const r = zoomBtn.getBoundingClientRect();
    showMenu(
      r.left,
      r.bottom + 4,
      [
        { label: "Fit width", onSelect: () => view.fit("width") },
        { label: "Fit page", onSelect: () => view.fit("page") },
        { label: "100%", onSelect: () => view.setZoom(ZOOM_100) },
        { label: "200%", onSelect: () => view.setZoom(2 * ZOOM_100) },
      ],
      r.top - 4,
      e.detail === 0,
    );
  });
  onClick(findBtn, () => find.open());

  const paintRail = (): void => {
    pagesEl.classList.toggle("pdfed-pages--collapsed", !railOpen);
    railBtn.setAttribute("aria-pressed", railOpen ? "true" : "false");
    railBtn.title = railOpen ? "Hide pages" : "Show pages";
  };
  onClick(railBtn, () => {
    railOpen = !railOpen;
    paintRail();
  });
  paintRail();

  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const n = Number.parseInt(pageInput.value.trim(), 10);
      if (Number.isInteger(n) && n >= 1 && n <= viewPages.length) view.scrollToPage(n - 1);
      view.el.focus();
      paintPage();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      view.el.focus();
      paintPage();
    }
  });
  pageInput.addEventListener("focus", () => pageInput.select());
  pageInput.addEventListener("blur", paintPage);

  /* ---------------- exits, export ---------------- */

  const goHome = (): void => exits.confirmLeave(() => navigate(exitDest(route)));
  const goSettings = (): void => exits.confirmLeave(() => navigate({ view: "settings" }));
  /** ctx.leave: a part's way out (the export dialog's "Open as image
   *  project"). Another editor inherits this one's way back to the viewer. */
  function leave(to: Route): void {
    const dest: Route = to.view === "editor" && !to.returnTo && route.returnTo ? { ...to, returnTo: route.returnTo } : to;
    exits.confirmLeave(() => navigate(dest));
  }
  // The dialog registers its own closer (ctx.registerOverlay) and holds
  // ctx.session.blockLeave + a registerCloseTask while an export runs.
  function openExport(opts?: Parameters<typeof openPdfExportDialog>[1]): void {
    endTyping();
    openPdfExportDialog(ctx, opts);
  }
  homeBtn.addEventListener("click", goHome);
  settingsBtn.addEventListener("click", goSettings);
  exportBtn.addEventListener("click", () => openExport());

  /* ---------------- Home card cover ---------------- */

  let coverFor: string | null = session.temp.get() ? null : coverKey(session.project);
  let cardAsked = false;
  /** the cover render still running past its wait, and the doc it reads */
  let coverWork: { doc: PdfDoc | null; done: Promise<void> } | null = null;
  async function cardMissing(): Promise<boolean> {
    const path = session.path;
    const idx = await ipc.listRecents();
    const entry = idx.items.find((r) => r.path === path);
    if (!entry) return false;
    return !entry.thumb || !(await ipc.pathExists(entry.thumb));
  }
  async function coverOwed(deadline: number): Promise<boolean> {
    if (session.temp.get()) return false;
    if (coverFor === null || coverFor !== coverKey(session.project)) return true;
    if (cardAsked) return false;
    cardAsked = true;
    try {
      return await Promise.race([cardMissing(), sleep(Math.max(0, deadline - Date.now())).then(() => false)]);
    } catch {
      return false;
    }
  }
  async function writeCoverNow(deadline = Date.now() + THUMB_CAP_MS): Promise<void> {
    const p = session.project;
    const pg = p.pdf?.pages[0];
    if (!pg) return;
    coverFor = coverKey(p);
    const doc = pg.src === null ? null : (docs.get(pg.src) ?? null);
    // A source that never opened has no picture to give: Home keeps its placeholder.
    if (pg.src !== null && !doc) return;
    const turned = pg.rotate % 180 !== 0;
    const render = (): Promise<Blob> =>
      doc
        ? renderPageToBlob(doc, pg.page, pg.rotate, COVER_PX, "image/jpeg")
        : blankCover(turned ? (pg.h ?? 842) : (pg.w ?? 595), turned ? (pg.w ?? 595) : (pg.h ?? 842), COVER_PX);
    const w = writeCover(session.path, p.id, render, deadline);
    const work = { doc, done: w.done };
    coverWork = work;
    void w.done.finally(() => {
      if (coverWork === work) coverWork = null;
    });
    await w.waited;
  }
  const writeCoverIfOwed = async (): Promise<void> => {
    const deadline = Date.now() + THUMB_CAP_MS;
    if (await coverOwed(deadline)) await writeCoverNow(deadline);
  };
  undo.push(registerCloseTask(() => writeCoverIfOwed()));

  /* ---------------- subscriptions ---------------- */

  unsubs.push(
    session.store.subscribe(() => {
      syncName();
      refreshUndo();
      syncPages();
      syncForms();
    }),
  );
  unsubs.push(
    view.state.subscribe((s, prev) => {
      if (s.zoom !== prev.zoom) paintZoom();
      if (s.current !== prev.current || s.count !== prev.count) {
        paintPage();
        panel.setCurrent(s.current);
      }
    }),
  );
  unsubs.push(
    settingsStore.subscribe((s, prev) => {
      if (s.shortcuts !== prev.shortcuts) shortcuts.setBindings(s.shortcuts);
    }),
  );

  /* ---------------- strip input: Ctrl+wheel, keys, hold to pan ---------------- */

  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const z = view.state.get().zoom;
    view.setZoom(z * wheelFactor(e.deltaY, e.deltaMode), { clientX: e.clientX, clientY: e.clientY });
  };
  view.el.addEventListener("wheel", onWheel, { passive: false });
  undo.push(() => view.el.removeEventListener("wheel", onWheel));

  // Page keys step a PAGE at a time (the strip's native PageDown moves a
  // viewport, which on a zoomed page lands mid-page).
  const onStripKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || isTyping(e.target)) return;
    const s = view.state.get();
    const last = Math.max(0, viewPages.length - 1);
    let to: number;
    if (e.key === "PageDown") to = Math.min(last, s.current + 1);
    else if (e.key === "PageUp") to = Math.max(0, s.current - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = last;
    else return;
    e.preventDefault();
    view.scrollToPage(to);
  };
  view.el.addEventListener("keydown", onStripKey);
  undo.push(() => view.el.removeEventListener("keydown", onStripKey));

  // Hold to pan (imgPanHold, Space by default): while held, a drag anywhere
  // on the strip scrolls it, ahead of every tool (capture phase).
  let panCode: string | null = null;
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  const panMatches = (e: KeyboardEvent): boolean => {
    const want = normalizeChord(settingsStore.get().shortcuts.imgPanHold ?? "");
    if (!want) return false;
    return chordOf(e) === want || physicalChordOf(e) === want;
  };
  const endPan = (): void => {
    panCode = null;
    view.el.classList.remove("pdfed-pan");
  };
  const onPanKeyDown = (e: KeyboardEvent): void => {
    if (panCode !== null) {
      if (e.code === panCode) e.preventDefault();
      return;
    }
    if (e.defaultPrevented || e.repeat || !panMatches(e)) return;
    if (isTyping(e.target) || modalOpen() || shortcutsBlocked()) return;
    // A focused button takes its own Space.
    if (e.target instanceof Element && e.target.closest("button, a, [role='menuitem'], [role='option']")) return;
    e.preventDefault();
    panCode = e.code ?? e.key;
    view.el.classList.add("pdfed-pan");
  };
  const onPanKeyUp = (e: KeyboardEvent): void => {
    if (panCode !== null && (e.code ?? e.key) === panCode) endPan();
  };
  const onPanDown = (e: PointerEvent): void => {
    if (panCode === null || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: view.el.scrollLeft, top: view.el.scrollTop };
    view.el.setPointerCapture?.(e.pointerId);
    view.el.classList.add("pdfed-panning");
  };
  const onPanMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    view.el.scrollLeft = drag.left - (e.clientX - drag.x);
    view.el.scrollTop = drag.top - (e.clientY - drag.y);
  };
  const onPanUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    drag = null;
    view.el.classList.remove("pdfed-panning");
  };
  window.addEventListener("keydown", onPanKeyDown);
  window.addEventListener("keyup", onPanKeyUp);
  window.addEventListener("blur", endPan);
  view.el.addEventListener("pointerdown", onPanDown, true);
  view.el.addEventListener("pointermove", onPanMove, true);
  view.el.addEventListener("pointerup", onPanUp, true);
  view.el.addEventListener("pointercancel", onPanUp, true);
  undo.push(() => {
    window.removeEventListener("keydown", onPanKeyDown);
    window.removeEventListener("keyup", onPanKeyUp);
    window.removeEventListener("blur", endPan);
    view.el.removeEventListener("pointerdown", onPanDown, true);
    view.el.removeEventListener("pointermove", onPanMove, true);
    view.el.removeEventListener("pointerup", onPanUp, true);
    view.el.removeEventListener("pointercancel", onPanUp, true);
  });

  // A form field that loses focus closes its typing step.
  view.el.addEventListener("focusout", endTyping, true);
  undo.push(() => view.el.removeEventListener("focusout", endTyping, true));

  /* ---------------- shortcuts ---------------- */

  bindKey("undo", doUndo);
  bindKey("redo", doRedo);
  bindKey("redoAlt", doRedo);
  bindKey("save", () => {
    endTyping();
    void session.save();
  });
  bindKey("export", () => openExport());
  bindKey("goHome", goHome);
  bindKey("find", () => find.open());
  bindKey("imgZoomIn", () => zoomBy(1));
  bindKey("imgZoomOut", () => zoomBy(-1));
  bindKey("imgZoomFit", () => view.fit("width"));
  bindKey("imgZoom100", () => view.setZoom(ZOOM_100));
  shortcuts.attach();
  undo.push(() => shortcuts.detach());

  /* ---------------- first paint, parts ---------------- */

  syncPages(true);
  paintZoom();
  refreshUndo();

  const hosts: PdfEditorHosts = { toolbar: toolsHost, inspector: inspectorHost, topbar: topHost };
  // Each part in its own teardown entry, so one that throws on close still
  // lets the others (and the session's final save) run.
  for (const part of [toolsPart, inspectorPart, formsPart]) {
    const p = part(ctx, hosts);
    undo.push(() => p.dispose());
  }

  /* ---------------- sources, recovered ---------------- */

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");
  /** Continue past the sources dialog: a source that opened with fewer pages
   *  than the project shows from it (a crafted or replaced file) loses those
   *  pages, as ONE step. */
  function dropImpossiblePages(): void {
    if (disposed) return;
    const p = session.project;
    const gone = (p.pdf?.pages ?? []).filter((pg) => {
      if (pg.src === null) return false;
      const d = docs.get(pg.src);
      return !!d && pg.page >= d.numPages;
    });
    if (gone.length === 0) return;
    const ids = gone.map((pg) => pg.id);
    session.commit((q) => deletePages(q, ids));
    if (session.project === p) {
      // deletePages keeps at least one page: nothing could go.
      toast.refuse("None of this project's pages are in its PDFs any more.");
      return;
    }
    const n = gone.length;
    toast.info(`${n} ${n === 1 ? "page wasn't" : "pages weren't"} in the PDF any more and ${n === 1 ? "was" : "were"} removed.`);
  }
  if (issues.length > 0) {
    registerOverlay(
      openSourcesDialog({
        session,
        issues,
        onRelinked: (srcId, doc) => {
          if (disposed) {
            void doc.destroy();
            return;
          }
          const old = docs.get(srcId);
          docs.set(srcId, doc);
          if (old && old !== doc) void old.destroy();
          syncPages(true);
        },
        onCloseProject: goHome,
        onContinue: dropImpossiblePages,
      }),
    );
  }

  /* ---------------- dev hook ---------------- */

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__tarotingPdfDev = { session, ctx, view, docs, panel, find };
    undo.push(() => {
      delete (window as unknown as Record<string, unknown>).__tarotingPdfDev;
    });
  }

  return {
    async dispose() {
      if (disposed) return;
      // The typing step lands while everything is still alive.
      endTyping();
      disposed = true;
      closeOverlays();
      closeMenu();
      endPan();
      runTeardown(undo);
      // Unpublished before the first await (the image editor's reason: a leave
      // landing during the cover wait must not see this screen as current).
      if (currentSession.get() === session) currentSession.set(null);
      await writeCoverIfOwed();
      // The shared pdf.js worker shuts down once every document is gone.
      const work = coverWork as { doc: PdfDoc | null; done: Promise<void> } | null;
      await destroyDocs(docs, work?.doc ?? null, work?.done);
      await session.dispose();
    },
  };
}
