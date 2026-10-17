// The PDF feature's internal contract: the page view both the viewer and the
// PDF editor mount (src/pdf/view/), and the context the editor's parts share
// (src/pdf/editor/). Interfaces only — no code, no imports of pdf.js values —
// so any module may import it without pulling a chunk in.
//
// UNITS, once, because every bug here would be a unit mix-up:
//   - page space — PDF points of the page as its source stores it: UNROTATED,
//     origin at the crop box's top-left, y DOWN (core/types.ts PdfAnnot).
//   - client px  — CSS px, what pointer events and layout report.
//   - `zoom`     — CSS px per point (1 = 72 dpi at 100% display scaling;
//     the UI's "100%" is zoom 96/72 so a page shows at its printed size).
// A page's on-screen box is its page box turned by (source /Rotate + the
// project's PdfPage.rotate) and scaled by zoom; the conversions below are the
// ONLY way any tool goes between page space and the screen.

import type { PdfRotation } from "../core/types";
import type { Store } from "../core/store";
import type { ProjectSession } from "../core/session";

/** An opened source document. `doc` is pdf.js's PDFDocumentProxy, typed
 *  loosely here so this file never imports pdf.js. */
export interface PdfDoc {
  /** PdfSource.id in a project; the file path in the viewer */
  id: string;
  path: string;
  doc: unknown;
  numPages: number;
  /** per page (0-based): crop box size in points, unrotated, and its own /Rotate */
  pageInfo(index: number): Promise<{ w: number; h: number; rotate: PdfRotation }>;
  /** ends the worker-side document; the view stops using it first */
  destroy(): Promise<void>;
}

/** Why a document did not open. "password" → ask, then call open again with it. */
export type PdfOpenError =
  | { kind: "password"; retry: boolean }
  | { kind: "invalid" }
  | { kind: "missing" }
  | { kind: "other"; message: string };

/** One page slot in the strip, in display order. */
export interface PdfViewPage {
  /** stable key: PdfPage.id in the editor, "p<index>" in the viewer */
  key: string;
  /** null = blank page of w×h points */
  doc: PdfDoc | null;
  index: number;
  /** added to the page's own /Rotate */
  rotate: PdfRotation;
  w?: number;
  h?: number;
}

export type PdfFit = "width" | "page";

export interface PdfViewState {
  /** CSS px per point */
  zoom: number;
  /** the fit mode zoom follows on resize, or null once the user zooms by hand */
  fit: PdfFit | null;
  /** 0-based slot index of the page that owns the viewport centre line */
  current: number;
  count: number;
}

/** Result of a hit test or conversion: a point on a page, in page space. */
export interface PagePoint {
  key: string;
  x: number;
  y: number;
}

/** A rectangle in PAGE SPACE: [x, y, w, h] (points, origin top-left, y down).
 *  Search hits, selectionRects(), reveal() and PdfAnnot highlight rects all use it. */
export type PageRect = [number, number, number, number];

/** A search hit: page slot + rects in page space (for highlighting/scrolling). */
export interface PdfSearchHit {
  key: string;
  rects: PageRect[];
}

export interface PdfViewEvents {
  /** a page slot came within the render margin (its overlay now exists) */
  pagevisible: { key: string; overlay: HTMLElement };
  /** a page slot left the render margin (its overlay is about to be removed) */
  pagehidden: { key: string };
  /** a page's canvas finished painting at the current zoom */
  pagerendered: { key: string };
  /** zoom or layout changed: overlays must re-place their content */
  layout: void;
}

/**
 * The continuous page strip. Vertical scroll, pages centred, a gap between
 * them. Only pages within ~1 viewport of the visible area are rendered; their
 * canvases are recycled and the total of rendered backing pixels is capped.
 * Text layers exist only on rendered pages. Nothing runs at rest: no timer, no
 * frame loop; work happens on scroll, resize, zoom or setPages.
 */
export interface PdfView {
  /** the scroll container; the host places it */
  readonly el: HTMLElement;
  readonly state: Store<PdfViewState>;
  /** replace the strip (editor: after any page op). Keeps the page that was
   *  current in view when it still exists. Unchanged slots keep their canvas. */
  setPages(pages: PdfViewPage[]): void;
  scrollToPage(slot: number, opts?: { smooth?: boolean }): void;
  /** scroll so this page-space rect is visible (search hits) */
  reveal(key: string, rect: PageRect): void;
  /** draw search hits as an overlay layer; `active` (index into hits) is
   *  emphasised. [] clears. */
  setSearchHits(hits: PdfSearchHit[], active: number): void;
  setZoom(zoom: number, anchor?: { clientX: number; clientY: number }): void;
  fit(mode: PdfFit): void;
  /** the overlay container of a page while it is rendered, else null. Absolutely
   *  positioned over the page box, same size, pointer-events none by default
   *  (tools set it on the surfaces they add). Cleared by the view on pagehidden. */
  overlay(key: string): HTMLElement | null;
  /** page space → client px (accounts for rotation, zoom and scroll) */
  pageToClient(key: string, x: number, y: number): { x: number; y: number } | null;
  /** client px → page space of the page under the point, or null (gap/outside) */
  clientToPage(clientX: number, clientY: number): PagePoint | null;
  /** client px → page space of a GIVEN page (may fall outside it: drags) */
  clientToPageOf(key: string, clientX: number, clientY: number): { x: number; y: number } | null;
  /** the page-space rects of the current text selection, grouped by page
   *  (the Highlight tool's input); [] when nothing is selected */
  selectionRects(): PdfSearchHit[];
  /** text layer on/off (the editor turns it off while an ink tool owns the pointer) */
  setTextLayer(on: boolean): void;
  /** forms layer (pdf.js AnnotationLayer, renderForms) on/off — Fill forms mode */
  setFormsLayer(on: boolean): void;
  on<K extends keyof PdfViewEvents>(type: K, fn: (e: PdfViewEvents[K]) => void): () => void;
  /** re-render one page's canvas (e.g. a source changed); cheap no-op if hidden */
  invalidate(key: string): void;
  dispose(): void;
}

export interface PdfViewOptions {
  /** text selection layer (viewer: on; editor: on unless an ink tool is active) */
  textLayer: boolean;
  /** forms values: read on render, written on user input (Fill forms mode).
   *  Absent → forms layer unavailable. Keyed by (doc id, pdf.js annotation id). */
  forms?: {
    get(docId: string, annotId: string): import("../core/types").PdfFormValue | undefined;
    set(docId: string, annotId: string, value: import("../core/types").PdfFormValue): void;
  };
  /** page gap in CSS px (default 16) */
  gap?: number;
}

export interface PdfSearch {
  /** runs over every page's text (cached after the first pass; off the UI
   *  thread's critical path: yields between pages) */
  find(query: string, opts?: { caseSensitive?: boolean }): Promise<PdfSearchHit[]>;
  /** a pending find() then resolves to [] */
  cancel(): void;
}

/** The thumbnail rail. Lazily renders small images on idle, only for rail
 *  items near its own viewport. */
export interface PdfThumbRail {
  readonly el: HTMLElement;
  setPages(pages: PdfViewPage[]): void;
  /** follows the view's current page */
  setCurrent(slot: number): void;
  dispose(): void;
}

export interface PdfThumbRailOptions {
  onPick(slot: number): void;
  /** editor only: drag to reorder; called once on drop with the new order of keys */
  onReorder?(keys: string[]): void;
  /** editor only: right-click / menu key on a thumbnail */
  onContextMenu?(slots: number[], at: { clientX: number; clientY: number }): void;
  /** editor only: multi-select (Ctrl/Shift click) — the selected slots */
  selection?: Store<number[]>;
}

/* ------------------------------ editor ------------------------------ */

export type PdfToolId =
  | "select"
  | "highlight"
  | "pen"
  | "pencil"
  | "marker"
  | "eraser"
  | "shape"
  | "text"
  | "whiteout"
  | "image"
  | "signature";

export interface PdfToolState {
  tool: PdfToolId;
  colors: { highlight: string; pen: string; pencil: string; marker: string; shape: string; text: string };
  /** CSS px at the current zoom for ink/eraser/shape; points for text */
  sizes: { pen: number; pencil: number; marker: number; eraser: number; shape: number; text: number };
  shape: import("../core/types").ShapeKind;
  font: import("../core/types").FontFamily;
  /** null = hidden; page space of the page it lies on */
  ruler: { key: string; cx: number; cy: number; angle: number } | null;
}

/** What every part of the PDF editor is handed. Built once per mount by the
 *  shell (src/pdf/editor/shell.ts); parts read it and never replace it. */
export interface PdfEditorCtx {
  session: ProjectSession;
  view: PdfView;
  /** open source documents by PdfSource.id */
  docs: ReadonlyMap<string, PdfDoc>;
  tools: Store<PdfToolState>;
  /** selected annotation ids (with their page keys) — the select tool's state */
  selection: Store<{ key: string; id: string }[]>;
  /** selected page slots in the rail */
  pageSelection: Store<number[]>;
  /** "annotate" = tools own the pointer; "forms" = Fill forms mode (form
   *  widgets own it, tools are disabled). Transient, default "annotate". */
  mode: Store<"annotate" | "forms">;
  /** true when any open source has fillable fields (shows the Fill forms switch) */
  hasForms: Store<boolean>;
  /** ProjectSession.holdAutosave passthrough (pointer-down → hold, up → release) */
  holdAutosave(): () => void;
  /** register a body-parked surface's closer; dispose closes all */
  registerOverlay(close: () => void): () => void;
}

/** A part of the editor (tools, panels): mounted with the ctx, disposed with the editor. */
export type PdfEditorPart = (ctx: PdfEditorCtx) => { dispose(): void };
