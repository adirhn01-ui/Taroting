// The continuous page strip (PdfView, ../types.ts) — the shell around math.ts.
//
// Mechanisms, adapted from Tarotalking's reader/pdf-view.ts:
//   - every slot is laid out from its page size before anything renders (an
//     estimate first, then pageInfo in batches, each batch re-laid out with
//     the page under the viewport centre held still), so the scrollbar is
//     right from the start and nothing jumps;
//   - only slots within one viewport above/below the visible area have DOM
//     (a page box, its canvas, text/annotation layers, a hit layer and the
//     host's overlay); leaving that window cancels the render and recycles the
//     canvas (0×0) — the rest of the strip is arithmetic;
//   - a render queue with at most MAX_INFLIGHT renders in flight, visible
//     slots first, nearest the centre first, so a fast flick never floods the
//     worker; the total of backing pixels is capped (math.ts pickEvictions);
//   - zoom re-lays out at once and CSS-stretches the canvases (the text and
//     annotation layers follow through --scale-factor), then re-renders once
//     the zoom has been still for SETTLE_MS;
//   - every async continuation checks the slot's generation, so a slot that
//     was hidden, re-rendered or disposed meanwhile is left alone.
// Nothing runs at rest: one ResizeObserver, one passive scroll listener that
// coalesces into a frame, a settle timer only while zooming.

import "./view.css";
import { Store } from "../../core/store";
import type { PdfRotation } from "../../core/types";
import type {
  PagePoint,
  PdfDoc,
  PdfFit,
  PdfSearchHit,
  PdfView,
  PdfViewEvents,
  PdfViewOptions,
  PdfViewPage,
  PdfViewState,
} from "../types";
import * as M from "./math";
import { formsBridge, type WidgetLite } from "./forms";
import { canvasPatch, paperAndInk } from "./text-lines";
import { loadPdfjs, pdfjsNow, type PDFPageProxy, type Pdfjs } from "./pdfjs";
import { pageText } from "./search";

type RenderTask = import("pdfjs-dist").RenderTask;
type TextLayer = import("pdfjs-dist").TextLayer;
type AnnotationLayer = import("pdfjs-dist").AnnotationLayer;
type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;

/** Renders in flight at once (the worker is shared with the rail). */
const MAX_INFLIGHT = 2;
/** Quiet time after the last zoom step before pages re-render. */
const SETTLE_MS = 150;
const DEFAULT_GAP = 16;
/** Page sizes requested per batch while measuring a long document. */
const MEASURE_BATCH = 64;
/** Recycled canvases kept around (each 0×0 while pooled). */
const CANVAS_POOL = 8;

/** The PdfView plus the additive method search needs. */
export interface PdfViewExt extends PdfView {
  /** paint search hits (page-space rects) on rendered pages; `active` is the
   *  index in `hits` drawn as the current one (-1 = none). [] clears. */
  setSearchHits(hits: PdfSearchHit[], active: number): void;
}

interface SlotDom {
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  hits: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  /** backing pixels of the displayed canvas */
  px: number;
  renderedZoom: number;
  renderedForms: boolean;
  /** wants a (re)render at the current zoom/mode */
  stale: boolean;
  /** dropped under the pixel budget; renders again once visible */
  evicted: boolean;
  error: boolean;
  /** a render() is running for this slot */
  busy: boolean;
  task: RenderTask | null;
  /** bumped on hide/invalidate; stale continuations bail */
  gen: number;
  proxy: PDFPageProxy | null;
  userUnit: number;
  text: { layer: TextLayer; div: HTMLDivElement } | null;
  textBusy: boolean;
  annot: { layer: AnnotationLayer; div: HTMLDivElement; forms: boolean } | null;
  canvasMap: Map<string, HTMLCanvasElement>;
}

interface Slot extends M.SlotDims {
  key: string;
  page: PdfViewPage;
  srcRot: PdfRotation;
  known: boolean;
  dom: SlotDom | null;
}

const sameSlot = (a: PdfViewPage, b: PdfViewPage): boolean =>
  a.key === b.key &&
  a.doc === b.doc &&
  a.index === b.index &&
  a.rotate === b.rotate &&
  (a.doc !== null || (a.w === b.w && a.h === b.h));

export function createPdfView(opts: PdfViewOptions): PdfViewExt {
  const gap = opts.gap ?? DEFAULT_GAP;
  const el = document.createElement("div");
  el.className = "pdfv";
  el.tabIndex = -1;
  const sizer = document.createElement("div");
  sizer.className = "pdfv__sizer";
  el.appendChild(sizer);

  const state = new Store<PdfViewState>({ zoom: 1, fit: "width", current: 0, count: 0 });
  let disposed = false;
  let slots: Slot[] = [];
  let byKey = new Map<string, number>();
  let L: M.StripLayout = M.layoutStrip([], 1, gap, 0);
  let zoom = 1;
  let textOn = opts.textLayer;
  let formsOn = false;
  let zooming = false;
  let settleTimer = 0;
  let frame = 0;
  let inflight = 0;
  let measureGen = 0;
  let lastW = -1;
  let lastH = -1;
  /** slots with DOM, in slot order */
  let live: Slot[] = [];
  const pool: HTMLCanvasElement[] = [];
  const listeners = new Map<keyof PdfViewEvents, Set<(e: unknown) => void>>();
  let hitsByKey = new Map<string, { rects: M.Rect4[]; active: boolean }[]>();

  function emit<K extends keyof PdfViewEvents>(type: K, e: PdfViewEvents[K]): void {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(e);
      } catch (err) {
        console.error(`pdf view ${type} listener threw`, err);
      }
    }
  }

  function setState(patch: Partial<PdfViewState>): void {
    const cur = state.get();
    let changed = false;
    for (const k of Object.keys(patch) as (keyof PdfViewState)[]) {
      if (cur[k] !== patch[k]) changed = true;
    }
    if (changed) state.set({ ...cur, ...patch });
  }

  /* ------------------------------ geometry ------------------------------ */

  function viewport(): { w: number; h: number } {
    return { w: el.clientWidth, h: el.clientHeight };
  }

  /** client px → content px */
  function toContent(clientX: number, clientY: number): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left - el.clientLeft + el.scrollLeft, y: clientY - r.top - el.clientTop + el.scrollTop };
  }

  /** The page point under a viewport offset (centre by default) — what a
   *  re-layout keeps still. */
  function captureAnchor(offX?: number, offY?: number): { slot: number; x: number; y: number; offX: number; offY: number } | null {
    if (slots.length === 0 || L.tops.length !== slots.length) return null;
    const v = viewport();
    const ox = offX ?? v.w / 2;
    // At the very top, keep the TOP still (a fit or a resize on open must not
    // scroll the first page's head out of view); elsewhere the centre.
    const oy = offY ?? (el.scrollTop <= 0 ? 0 : v.h / 2);
    const cx = el.scrollLeft + ox;
    const cy = el.scrollTop + oy;
    const slot = M.slotAtY(L, cy);
    if (slot < 0) return null;
    const p = M.contentToPage(L, slots, slot, cx, cy);
    return { slot, x: p.x, y: p.y, offX: ox, offY: oy };
  }

  function position(s: Slot, i: number): void {
    const d = s.dom;
    if (!d) return;
    const st = d.root.style;
    st.left = `${L.lefts[i]}px`;
    st.top = `${L.tops[i]}px`;
    st.width = `${L.W[i]}px`;
    st.height = `${L.H[i]}px`;
    const uu = d.userUnit || 1;
    st.setProperty("--scale-factor", String(zoom / uu));
    st.setProperty("--user-unit", String(uu));
  }

  /** Re-derive the layout (fit zoom included), keep `anchor` still, then
   *  sync the render window. */
  function relayout(anchor: ReturnType<typeof captureAnchor>): void {
    const v = viewport();
    const fit = state.get().fit;
    if (fit && slots.length > 0 && v.w > 0) {
      const cur = slots[Math.min(slots.length - 1, Math.max(0, anchor?.slot ?? state.get().current))]!;
      zoom = M.fitZoom(fit, cur, v.w, v.h, gap);
    }
    L = M.layoutStrip(slots, zoom, gap, v.w);
    sizer.style.width = `${L.width}px`;
    sizer.style.height = `${L.height}px`;
    for (const s of live) position(s, byKey.get(s.key)!);
    // any canvas now painted at another zoom: stretch it, re-render on settle
    if (live.some((s) => s.dom!.canvas && s.dom!.renderedZoom !== zoom)) beginZoom();
    if (anchor) {
      const sc = M.anchoredScroll(L, slots, anchor, anchor.offX, anchor.offY, v.w, v.h);
      el.scrollLeft = sc.left;
      el.scrollTop = sc.top;
    }
    setState({ zoom });
    syncWindow();
    emit("layout", undefined);
  }

  /* ------------------------------ window ------------------------------ */

  function visibleRange(): [number, number] {
    const v = viewport();
    return M.slotsInRange(L, el.scrollTop, el.scrollTop + Math.max(1, v.h));
  }

  function syncWindow(): void {
    if (disposed) return;
    const v = viewport();
    const [a, b] = M.renderWindow(L, el.scrollTop, Math.max(1, v.h), Math.max(1, v.h));
    const keep: Slot[] = [];
    for (const s of live) {
      const i = byKey.get(s.key);
      if (i === undefined || slots[i] !== s || i < a || i > b) hide(s);
      else keep.push(s);
    }
    live = keep;
    if (a >= 0) {
      for (let i = a; i <= b; i++) {
        const s = slots[i]!;
        if (!s.dom) show(s, i);
      }
    }
    live.sort((x, y) => byKey.get(x.key)! - byKey.get(y.key)!);
    updateCurrent();
    pump();
  }

  function show(s: Slot, i: number): void {
    const root = document.createElement("div");
    root.className = "pdfv-page";
    root.dataset.key = s.key;
    if (!s.page.doc) root.classList.add("pdfv-page--blank");
    const hits = document.createElement("div");
    hits.className = "pdfv-hits";
    const overlay = document.createElement("div");
    overlay.className = "pdfv-overlay";
    root.append(hits, overlay);
    s.dom = {
      root,
      overlay,
      hits,
      canvas: null,
      px: 0,
      renderedZoom: 0,
      renderedForms: false,
      stale: s.page.doc !== null,
      evicted: false,
      error: false,
      busy: false,
      task: null,
      gen: 0,
      proxy: null,
      userUnit: 1,
      text: null,
      textBusy: false,
      annot: null,
      canvasMap: new Map(),
    };
    position(s, i);
    // slot order in the DOM = tab order of form fields and links
    let next: Slot | null = null;
    for (const o of live) {
      const k = byKey.get(o.key)!;
      if (k > i && o.dom && (!next || k < byKey.get(next.key)!)) next = o;
    }
    sizer.insertBefore(root, next?.dom?.root ?? null);
    live.push(s);
    drawHits(s);
    emit("pagevisible", { key: s.key, overlay });
    if (!s.page.doc) emit("pagerendered", { key: s.key });
  }

  function dropCanvas(c: HTMLCanvasElement | null): void {
    if (!c) return;
    c.width = 0;
    c.height = 0;
    c.remove();
    if (pool.length < CANVAS_POOL) pool.push(c);
  }

  function takeCanvas(): HTMLCanvasElement {
    const c = pool.pop() ?? document.createElement("canvas");
    c.className = "pdfv-canvas";
    return c;
  }

  function removeText(d: SlotDom): void {
    if (!d.text) return;
    d.text.layer.cancel();
    d.text.div.remove();
    d.text = null;
  }

  function removeAnnot(d: SlotDom): void {
    if (!d.annot) return;
    d.annot.div.remove();
    d.annot = null;
  }

  function hide(s: Slot): void {
    const d = s.dom;
    if (!d) return;
    emit("pagehidden", { key: s.key });
    d.gen++;
    if (d.task) {
      d.task.cancel();
      d.task = null;
    }
    removeText(d);
    removeAnnot(d);
    dropCanvas(d.canvas);
    d.canvas = null;
    d.canvasMap.clear();
    // pdf.js keeps a page's operator list, fonts and images until cleanup();
    // with a render still in flight it defers until that one settles.
    d.proxy?.cleanup();
    d.root.remove();
    s.dom = null;
  }

  function updateCurrent(): void {
    if (slots.length === 0) return;
    const c = M.currentSlot(L, el.scrollTop, viewport().h);
    if (c >= 0) setState({ current: c });
  }

  /* ------------------------------ measuring ------------------------------ */

  function applyInfo(s: Slot, info: { w: number; h: number; rotate: PdfRotation }): boolean {
    const rot = M.displayRotation(info.rotate, s.page.rotate);
    const changed = !s.known || s.w !== info.w || s.h !== info.h || s.rot !== rot;
    s.known = true;
    s.w = info.w > 0 ? info.w : M.DEFAULT_PAGE_W;
    s.h = info.h > 0 ? info.h : M.DEFAULT_PAGE_H;
    s.srcRot = info.rotate;
    s.rot = rot;
    return changed;
  }

  async function measure(gen: number): Promise<void> {
    const todo = slots.filter((s) => !s.known && s.page.doc);
    for (let k = 0; k < todo.length; k += MEASURE_BATCH) {
      const batch = todo.slice(k, k + MEASURE_BATCH);
      const infos = await Promise.all(
        batch.map((s) => s.page.doc!.pageInfo(s.page.index).catch(() => null)),
      );
      if (disposed || gen !== measureGen) return;
      const anchor = captureAnchor();
      let changed = false;
      batch.forEach((s, j) => {
        const info = infos[j];
        if (info && byKey.get(s.key) !== undefined) changed = applyInfo(s, info) || changed;
        else s.known = true; // leave the estimate; render reports the error
      });
      if (changed) relayout(anchor);
    }
  }

  /* ------------------------------ rendering ------------------------------ */

  function pendingSlots(vis: [number, number]): number[] {
    const out: number[] = [];
    for (const s of live) {
      const d = s.dom!;
      if (!d.stale || d.busy || d.error || !s.page.doc || !s.known) continue;
      const i = byKey.get(s.key)!;
      const visible = i >= vis[0] && i <= vis[1];
      if (d.evicted && !visible) continue;
      // mid-zoom: stretched canvases wait for the settle; blank boxes don't
      if (zooming && d.canvas) continue;
      out.push(i);
    }
    return out;
  }

  function pump(): void {
    if (disposed) return;
    while (inflight < MAX_INFLIGHT) {
      const vis = visibleRange();
      const pending = pendingSlots(vis);
      if (pending.length === 0) return;
      const centre = state.get().current;
      const i = M.nextToRender(pending, vis[0], vis[1], centre);
      if (i < 0) return;
      const s = slots[i]!;
      inflight++;
      void render(s, s.dom!).finally(() => {
        inflight--;
        pump();
      });
    }
  }

  function makeRoom(px: number, forSlot: number): void {
    const vis = visibleRange();
    const keep = new Set<number>([forSlot]);
    for (let i = vis[0]; i >= 0 && i <= vis[1]; i++) keep.add(i);
    const rendered = live
      .filter((s) => s.dom?.canvas)
      .map((s) => ({ slot: byKey.get(s.key)!, px: s.dom!.px }));
    for (const v of M.pickEvictions(rendered, px, M.PIXEL_BUDGET, state.get().current, keep)) {
      const d = slots[v]?.dom;
      if (!d) continue;
      dropCanvas(d.canvas);
      d.canvas = null;
      d.px = 0;
      d.evicted = true;
      d.stale = true;
      // the proxy stays valid (and cached): a later render re-fetches its data
      d.proxy?.cleanup();
    }
  }

  async function getPage(doc: PdfDoc, index: number): Promise<PDFPageProxy> {
    return (doc.doc as PDFDocumentProxy).getPage(index + 1);
  }

  async function render(s: Slot, d: SlotDom): Promise<void> {
    const gen = d.gen;
    const doc = s.page.doc!;
    const z = zoom;
    const forms = formsOn;
    d.stale = false;
    d.busy = true;
    const gone = (): boolean => disposed || d.gen !== gen || s.dom !== d;
    try {
      const pdfjs = pdfjsNow() ?? (await loadPdfjs());
      const proxy = d.proxy ?? (await getPage(doc, s.page.index));
      if (gone()) return;
      d.proxy = proxy;
      d.userUnit = proxy.userUnit || 1;
      const v = proxy.view;
      const info = { w: Math.abs(v[2]! - v[0]!), h: Math.abs(v[3]! - v[1]!), rotate: M.normRotation(proxy.rotate) };
      if (applyInfo(s, info)) {
        // the estimate was off: fix the layout, render at what it says now
        relayout(captureAnchor());
        if (gone()) return;
        d.stale = true;
        return;
      }
      position(s, byKey.get(s.key)!);

      type Annot = WidgetLite & Record<string, unknown>;
      let annots: Annot[] | null = null;
      if (opts.forms) {
        const list = (await proxy.getAnnotations({ intent: "display" })) as Annot[];
        if (gone()) return;
        annots = list;
        formsBridge(doc, opts.forms).seed(list);
      }

      const vp = proxy.getViewport({ scale: z / d.userUnit, rotation: s.rot });
      const dpr = window.devicePixelRatio || 1;
      const { bw, bh, ratio } = M.backingSize(vp.width, vp.height, dpr);
      makeRoom(bw * bh, byKey.get(s.key)!);
      const canvas = takeCanvas();
      canvas.width = bw;
      canvas.height = bh;
      const rvp = proxy.getViewport({ scale: (z / d.userUnit) * ratio, rotation: s.rot });
      const task = proxy.render({
        canvas,
        viewport: rvp,
        annotationMode: forms ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE_STORAGE,
        annotationCanvasMap: forms ? d.canvasMap : undefined,
      });
      d.task = task;
      try {
        await task.promise;
      } catch (e) {
        if (d.task === task) d.task = null;
        dropCanvas(canvas);
        if (gone() || (e as { name?: string })?.name === "RenderingCancelledException") return;
        throw e;
      }
      if (d.task === task) d.task = null;
      if (gone()) {
        dropCanvas(canvas);
        return;
      }
      dropCanvas(d.canvas);
      d.root.insertBefore(canvas, d.root.firstChild);
      d.canvas = canvas;
      d.px = bw * bh;
      d.renderedZoom = z;
      d.renderedForms = forms;
      d.evicted = false;
      d.error = false;
      d.root.classList.remove("pdfv-page--error");
      if (z !== zoom || forms !== formsOn) d.stale = true;
      await layers(s, d, gen, pdfjs, proxy, vp, annots, forms);
      if (gone()) return;
      emit("pagerendered", { key: s.key });
    } catch (e) {
      if (gone()) return;
      console.warn(`pdf page ${s.page.index + 1}: ${e instanceof Error ? e.message : String(e)}`);
      showError(d);
    } finally {
      d.busy = false;
    }
  }

  function showError(d: SlotDom): void {
    d.error = true;
    dropCanvas(d.canvas);
    d.canvas = null;
    d.px = 0;
    removeText(d);
    d.root.classList.add("pdfv-page--error");
    if (!d.root.querySelector(".pdfv-page__error")) {
      const note = document.createElement("div");
      note.className = "pdfv-page__error";
      note.textContent = "This page couldn't be shown";
      d.root.appendChild(note);
    }
  }

  type Viewport = ReturnType<PDFPageProxy["getViewport"]>;

  async function layers(
    s: Slot,
    d: SlotDom,
    gen: number,
    pdfjs: Pdfjs,
    proxy: PDFPageProxy,
    vp: Viewport,
    annots: Record<string, unknown>[] | null,
    forms: boolean,
  ): Promise<void> {
    const gone = (): boolean => disposed || d.gen !== gen || s.dom !== d;
    if (textOn) await buildText(s, d, pdfjs, vp);
    if (gone()) return;
    // annotation layer: links always, form widgets in Fill forms mode
    if (d.annot && d.annot.forms === forms) {
      d.annot.layer.update({ viewport: vp } as Parameters<AnnotationLayer["update"]>[0]);
      return;
    }
    const list = annots ?? ((await proxy.getAnnotations({ intent: "display" })) as Record<string, unknown>[]);
    if (gone()) return;
    removeAnnot(d);
    if (list.length === 0) return;
    const div = document.createElement("div");
    div.className = "annotationLayer";
    // Internal links are href="#" with an onclick that returns false, which
    // covers Shift/Ctrl-click; a middle click is an auxclick that never runs
    // onclick and would open the app's page in a new window.
    div.addEventListener("auxclick", stopLinkAux);
    const linkService = makeLinkService(s.page.doc!);
    const storage = (s.page.doc!.doc as PDFDocumentProxy).annotationStorage;
    const layer = new pdfjs.AnnotationLayer({
      div,
      page: proxy,
      viewport: vp,
      linkService,
      annotationStorage: storage,
      accessibilityManager: null,
      annotationCanvasMap: d.canvasMap,
      annotationEditorUIManager: null,
      structTreeLayer: null,
      commentManager: null,
    });
    if (forms && opts.forms) {
      const bridge = formsBridge(s.page.doc!, opts.forms);
      const onUser = (): void => bridge.userEvent();
      // pdf.js commits text on input and again on blur (formatting), and
      // checkboxes/radios/choices on change or click.
      for (const type of ["input", "change", "click", "focusout", "keydown"]) div.addEventListener(type, onUser, true);
    }
    // overlay stays on top: annotation layer goes right under it
    d.root.insertBefore(div, d.overlay);
    d.annot = { layer, div, forms };
    await layer.render({
      viewport: vp,
      div,
      annotations: list,
      page: proxy,
      linkService,
      annotationStorage: storage,
      renderForms: forms,
      enableScripting: false,
      hasJSActions: false,
      fieldObjects: null,
      imageResourcesPath: "",
      annotationCanvasMap: d.canvasMap,
    } as unknown as Parameters<AnnotationLayer["render"]>[0]);
  }

  async function buildText(s: Slot, d: SlotDom, pdfjs: Pdfjs, vp: Viewport): Promise<void> {
    if (!s.page.doc) return;
    if (d.text) {
      d.text.layer.update({ viewport: vp, onBefore: undefined } as unknown as Parameters<TextLayer["update"]>[0]);
      return;
    }
    if (d.textBusy) return;
    d.textBusy = true;
    const gen = d.gen;
    try {
      const entry = await pageText(s.page.doc, s.page.index);
      if (disposed || d.gen !== gen || s.dom !== d || !textOn || d.text) return;
      const div = document.createElement("div");
      div.className = "textLayer";
      const layer = new pdfjs.TextLayer({
        textContentSource: entry.content as never,
        container: div,
        viewport: vp,
      });
      // above the canvas and hits, under links/forms and the overlay
      d.root.insertBefore(div, d.annot?.div ?? d.overlay);
      d.text = { layer, div };
      await layer.render().catch(() => {});
    } catch {
      /* no text: the page still shows; selection just finds nothing */
    } finally {
      d.textBusy = false;
    }
  }

  /* ------------------------------ links ------------------------------ */

  function stopLinkAux(e: Event): void {
    if (!(e.target as HTMLElement | null)?.closest?.("a")) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function makeLinkService(doc: PdfDoc): Record<string, unknown> {
    const stop = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    return {
      eventBus: null,
      externalLinkEnabled: false,
      // External links are never followed (offline app; the navigation guard
      // would block them anyway): the URL shows as a tooltip, a click does nothing.
      addLinkAttributes(link: HTMLAnchorElement, url: string): void {
        link.removeAttribute("href");
        link.title = url;
        link.setAttribute("aria-label", url);
        link.classList.add("pdfv-extlink");
        link.addEventListener("click", stop);
        link.addEventListener("auxclick", stop);
      },
      getDestinationHash: (): string => "#",
      getAnchorUrl: (): string => "#",
      goToDestination: (dest: unknown): void => void goToDest(doc, dest),
      executeNamedAction(action: string): void {
        const cur = state.get().current;
        const n = slots.length;
        const to =
          action === "NextPage" ? cur + 1 : action === "PrevPage" ? cur - 1 : action === "FirstPage" ? 0 : action === "LastPage" ? n - 1 : -1;
        if (to >= 0 && to < n) api.scrollToPage(to);
      },
      executeSetOCGState(): void {},
      getAttachmentContent: async (): Promise<null> => null,
    };
  }

  async function goToDest(doc: PdfDoc, dest: unknown): Promise<void> {
    try {
      const pdf = doc.doc as PDFDocumentProxy;
      const explicit = (typeof dest === "string" ? await pdf.getDestination(dest) : dest) as unknown[] | null;
      if (!Array.isArray(explicit) || explicit.length === 0) return;
      const ref = explicit[0];
      const index =
        typeof ref === "number" ? ref : ref && typeof ref === "object" ? await pdf.getPageIndex(ref as never) : -1;
      if (disposed || typeof index !== "number" || index < 0) return;
      // the slot showing that page; the nearest one if it shows twice
      const cur = state.get().current;
      let best = -1;
      slots.forEach((s, i) => {
        if (s.page.doc === doc && s.page.index === index && (best < 0 || Math.abs(i - cur) < Math.abs(best - cur))) best = i;
      });
      if (best < 0) return;
      const kind = (explicit[1] as { name?: string } | undefined)?.name;
      const top = explicit[3];
      if (kind === "XYZ" && typeof top === "number") {
        const page = await pdf.getPage(index + 1);
        const y = (page.view[3] ?? 0) - top;
        const s = slots[best]!;
        const c = M.pageToContent(L, slots, best, 0, Math.max(0, Math.min(s.h, y)));
        el.scrollTo({ top: Math.max(0, c.y - gap) });
        return;
      }
      api.scrollToPage(best);
    } catch {
      /* a broken destination goes nowhere */
    }
  }

  /* ------------------------------ search hits ------------------------------ */

  function drawHits(s: Slot): void {
    const d = s.dom;
    if (!d) return;
    d.hits.textContent = "";
    const list = hitsByKey.get(s.key);
    if (!list) return;
    // percent of the box, so a zoom stretches them with the page
    const box = M.boxSize(s.w, s.h, s.rot, 1);
    for (const hit of list) {
      for (const r of hit.rects) {
        const b = M.pageRectToBox(r, s.w, s.h, s.rot, 1);
        const div = document.createElement("div");
        div.className = hit.active ? "pdfv-hit pdfv-hit--active" : "pdfv-hit";
        div.style.left = `${(b[0] / box.W) * 100}%`;
        div.style.top = `${(b[1] / box.H) * 100}%`;
        div.style.width = `${(b[2] / box.W) * 100}%`;
        div.style.height = `${(b[3] / box.H) * 100}%`;
        d.hits.appendChild(div);
      }
    }
  }

  /* ------------------------------ observers ------------------------------ */

  const onScroll = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncWindow();
    });
  };
  el.addEventListener("scroll", onScroll, { passive: true });

  const ro = new ResizeObserver(() => {
    if (disposed) return;
    const v = viewport();
    if (v.w === lastW && v.h === lastH) return;
    const anchor = lastW < 0 ? null : captureAnchor();
    lastW = v.w;
    lastH = v.h;
    relayout(anchor);
  });
  ro.observe(el);

  /* ------------------------------ public ------------------------------ */

  function indexOfKey(key: string): number {
    return byKey.get(key) ?? -1;
  }

  const api: PdfViewExt = {
    el,
    state,

    setPages(pages: PdfViewPage[]): void {
      if (disposed) return;
      const prevCurrent = slots[state.get().current];
      // The current page's top keeps its place on screen across any page
      // operation (rotate, insert, delete, reorder): a page turned to
      // landscape gets shorter, and keeping the CENTRE still would slide the
      // next page under the eye.
      const curIndex = state.get().current;
      const curOffset = prevCurrent && L.tops.length === slots.length ? L.tops[curIndex]! - el.scrollTop : null;
      const old = new Map(slots.map((s) => [s.key, s] as const));
      const estimate = slots.find((s) => s.known) ?? null;
      const next: Slot[] = pages.map((p) => {
        const prev = old.get(p.key);
        if (prev && sameSlot(prev.page, p)) {
          old.delete(p.key);
          prev.page = p;
          return prev;
        }
        // Only turned (same document and page): its size is already known.
        if (prev && prev.page.doc === p.doc && prev.page.index === p.index && prev.known && p.doc !== null) {
          return { key: p.key, page: p, w: prev.w, h: prev.h, srcRot: prev.srcRot, rot: M.displayRotation(prev.srcRot, p.rotate), known: true, dom: null };
        }
        const blank = p.doc === null;
        const w = blank ? (p.w ?? M.DEFAULT_PAGE_W) : (estimate?.w ?? M.DEFAULT_PAGE_W);
        const h = blank ? (p.h ?? M.DEFAULT_PAGE_H) : (estimate?.h ?? M.DEFAULT_PAGE_H);
        const srcRot: PdfRotation = blank ? 0 : (estimate?.srcRot ?? 0);
        return { key: p.key, page: p, w, h, srcRot, rot: M.displayRotation(srcRot, p.rotate), known: blank, dom: null };
      });
      // slots that went away (or changed) lose their DOM first
      for (const s of old.values()) hide(s);
      live = live.filter((s) => s.dom);
      slots = next;
      byKey = new Map(slots.map((s, i) => [s.key, i] as const));
      setState({ count: slots.length, current: Math.min(state.get().current, Math.max(0, slots.length - 1)) });
      relayout(null);
      const i = prevCurrent ? byKey.get(prevCurrent.key) : undefined;
      el.scrollTop = i !== undefined ? Math.max(0, L.tops[i]! - (curOffset ?? gap)) : 0;
      updateCurrent();
      const gen = ++measureGen;
      void measure(gen);
    },

    scrollToPage(slot: number, o?: { smooth?: boolean }): void {
      if (disposed || slots.length === 0) return;
      const i = Math.max(0, Math.min(slots.length - 1, Math.round(slot)));
      el.scrollTo({ top: Math.max(0, L.tops[i]! - gap), behavior: o?.smooth ? "smooth" : "auto" });
    },

    reveal(key, rect): void {
      const i = indexOfKey(key);
      if (i < 0 || disposed) return;
      const a = M.pageToContent(L, slots, i, rect[0], rect[1]);
      const b = M.pageToContent(L, slots, i, rect[0] + rect[2], rect[1] + rect[3]);
      const top = Math.min(a.y, b.y);
      const bottom = Math.max(a.y, b.y);
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const v = viewport();
      const margin = Math.min(48, v.h / 4);
      let st = el.scrollTop;
      if (top < st + margin || bottom > st + v.h - margin) st = (top + bottom) / 2 - v.h / 2;
      let sl = el.scrollLeft;
      if (left < sl || right > sl + v.w) sl = (left + right) / 2 - v.w / 2;
      el.scrollTo({ top: Math.max(0, st), left: Math.max(0, sl) });
    },

    setZoom(z: number, anchor?: { clientX: number; clientY: number }): void {
      if (disposed) return;
      const next = M.clampZoom(z);
      setState({ fit: null });
      if (next === zoom) return;
      let a: ReturnType<typeof captureAnchor>;
      if (anchor) {
        const r = el.getBoundingClientRect();
        a = captureAnchor(anchor.clientX - r.left - el.clientLeft, anchor.clientY - r.top - el.clientTop);
      } else a = captureAnchor();
      zoom = next;
      relayout(a);
    },

    fit(mode: PdfFit): void {
      if (disposed) return;
      const a = captureAnchor();
      setState({ fit: mode });
      relayout(a);
    },

    overlay(key): HTMLElement | null {
      const i = indexOfKey(key);
      return i >= 0 ? (slots[i]!.dom?.overlay ?? null) : null;
    },

    pageToClient(key, x, y): { x: number; y: number } | null {
      const i = indexOfKey(key);
      if (i < 0) return null;
      const c = M.pageToContent(L, slots, i, x, y);
      const r = el.getBoundingClientRect();
      return { x: c.x - el.scrollLeft + r.left + el.clientLeft, y: c.y - el.scrollTop + r.top + el.clientTop };
    },

    clientToPage(clientX, clientY): PagePoint | null {
      const c = toContent(clientX, clientY);
      const i = M.slotAtPoint(L, c.x, c.y);
      if (i < 0) return null;
      const p = M.contentToPage(L, slots, i, c.x, c.y);
      return { key: slots[i]!.key, x: p.x, y: p.y };
    },

    clientToPageOf(key, clientX, clientY): { x: number; y: number } | null {
      const i = indexOfKey(key);
      if (i < 0) return null;
      const c = toContent(clientX, clientY);
      return M.contentToPage(L, slots, i, c.x, c.y);
    },

    selectionRects(): PdfSearchHit[] {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
      const range = sel.getRangeAt(0);
      if (!range.intersectsNode(sizer)) return [];
      const out: PdfSearchHit[] = [];
      const sub = document.createRange();
      for (const s of live) {
        const t = s.dom?.text;
        if (!t || !range.intersectsNode(t.div)) continue;
        const rects: M.Rect4[] = [];
        for (const span of t.layer.textDivs) {
          const tn = span.firstChild;
          if (!tn || tn.nodeType !== Node.TEXT_NODE || !range.intersectsNode(span)) continue;
          sub.selectNodeContents(tn);
          if (range.compareBoundaryPoints(Range.START_TO_START, sub) > 0) sub.setStart(range.startContainer, range.startOffset);
          if (range.compareBoundaryPoints(Range.END_TO_END, sub) < 0) sub.setEnd(range.endContainer, range.endOffset);
          if (sub.collapsed) continue;
          for (const r of sub.getClientRects()) {
            if (r.width <= 0 || r.height <= 0) continue;
            const a = api.clientToPageOf(s.key, r.left, r.top)!;
            const b = api.clientToPageOf(s.key, r.right, r.bottom)!;
            const x0 = Math.max(0, Math.min(a.x, b.x));
            const y0 = Math.max(0, Math.min(a.y, b.y));
            const x1 = Math.min(s.w, Math.max(a.x, b.x));
            const y1 = Math.min(s.h, Math.max(a.y, b.y));
            if (x1 > x0 && y1 > y0) rects.push([x0, y0, x1 - x0, y1 - y0]);
          }
        }
        const merged = M.mergeLineRects(rects);
        if (merged.length > 0) out.push({ key: s.key, rects: merged });
      }
      return out;
    },

    setTextLayer(on: boolean): void {
      if (disposed || on === textOn) return;
      textOn = on;
      el.classList.toggle("pdfv--notext", !on);
      if (!on) {
        for (const s of live) removeText(s.dom!);
        return;
      }
      const pdfjs = pdfjsNow();
      if (!pdfjs) return;
      for (const s of live) {
        const d = s.dom!;
        if (!d.canvas || !d.proxy) continue;
        const vp = d.proxy.getViewport({ scale: zoom / d.userUnit, rotation: s.rot });
        void buildText(s, d, pdfjs, vp);
      }
    },

    setFormsLayer(on: boolean): void {
      const want = on && !!opts.forms;
      if (disposed || want === formsOn) return;
      formsOn = want;
      el.classList.toggle("pdfv--forms", want);
      for (const s of live) {
        const d = s.dom!;
        if (s.page.doc) d.stale = true;
      }
      pump();
    },

    on<K extends keyof PdfViewEvents>(type: K, fn: (e: PdfViewEvents[K]) => void): () => void {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      const f = fn as (e: unknown) => void;
      set.add(f);
      return () => {
        set!.delete(f);
      };
    },

    invalidate(key: string): void {
      const i = indexOfKey(key);
      const d = i >= 0 ? slots[i]!.dom : null;
      if (!d || !slots[i]!.page.doc || disposed) return;
      d.gen++;
      if (d.task) {
        d.task.cancel();
        d.task = null;
      }
      d.proxy = null;
      removeText(d);
      removeAnnot(d);
      d.error = false;
      d.evicted = false;
      d.stale = true;
      d.root.querySelector(".pdfv-page__error")?.remove();
      pump();
    },

    samplePage(key, rect): { ink: string; paper: string } | null {
      const i = indexOfKey(key);
      const s = i >= 0 ? slots[i]! : null;
      const canvas = s?.dom?.canvas;
      if (disposed || !s || !canvas || s.dom!.error) return null;
      const patch = canvasPatch(rect, s.w, s.h, s.rot, canvas.width, canvas.height);
      if (!patch) return null;
      try {
        const g = canvas.getContext("2d");
        if (!g) return null;
        const img = g.getImageData(patch.x, patch.y, patch.w, patch.h);
        return paperAndInk(img.data, patch.w, patch.h, patch.inner);
      } catch {
        return null;
      }
    },

    setSearchHits(hits: PdfSearchHit[], active: number): void {
      if (disposed) return;
      const next = new Map<string, { rects: M.Rect4[]; active: boolean }[]>();
      hits.forEach((h, i) => {
        let list = next.get(h.key);
        if (!list) next.set(h.key, (list = []));
        list.push({ rects: h.rects, active: i === active });
      });
      const touched = new Set([...hitsByKey.keys(), ...next.keys()]);
      hitsByKey = next;
      for (const s of live) if (touched.has(s.key)) drawHits(s);
    },

    dispose(): void {
      if (disposed) return;
      for (const s of live) hide(s);
      disposed = true;
      measureGen++;
      live = [];
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
      frame = settleTimer = 0;
      for (const c of pool) {
        c.width = 0;
        c.height = 0;
      }
      pool.length = 0;
      listeners.clear();
      hitsByKey.clear();
      slots = [];
      byKey.clear();
      el.remove();
    },
  };

  /** A zoom step: canvases stretch now, re-render once it has been still. */
  function beginZoom(): void {
    zooming = true;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      zooming = false;
      if (disposed) return;
      for (const s of live) {
        const d = s.dom!;
        if (s.page.doc && d.renderedZoom !== zoom) d.stale = true;
      }
      pump();
    }, SETTLE_MS);
    for (const s of live) {
      const d = s.dom!;
      if (s.page.doc && d.renderedZoom !== zoom) d.stale = true;
    }
  }

  return api;
}
