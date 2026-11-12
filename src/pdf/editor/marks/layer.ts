// The mark layer: one SVG per RENDERED page, inside the view's overlay for
// that page, whose coordinate system is page space (viewBox = the turned page
// box in points, a group transform turns page space into it). Zoom therefore
// never repaints a mark — the overlay is the page box, the SVG fills it, only
// its CSS size changes.
//
// Inside the turned group, bottom to top:
//   marks  — the saved marks (render.ts; page pictures first, drawOrder),
//            repainted for a page only when that
//            page's mark list (`pdf.annots[pageId]`, an immutable array)
//            changes reference; a repaint builds nodes only for the mark
//            objects it has not drawn before (one node per mark object);
//   chrome — selection outlines, handles and the ruler (the tools own it);
//   live   — the mark a pointer is drawing, and the text editor.
//
// Page sizes come from the source documents (`PdfDoc.pageInfo`, cached per
// page) or a blank page's own w/h. A frame lives exactly between the view's
// `pagevisible` and `pagehidden` for its page; pages already visible when the
// layer mounts are picked up at once. Nothing runs at rest.

import type { PdfAnnot, PdfPage, PdfRotation, ProjectFile } from "../../../core/types";
import { mediaUrl } from "../../../core/ipc";
import { onFontsChanged } from "../../../fonts";
import { drawOrder, pageAnnots } from "../../model";
import type { PdfEditorCtx } from "../../types";
import { boxPoints, pageTransform } from "./geom";
import { SVG_NS, fontStateOf, markNode, needsFontRuntime } from "./render";

export interface PageInfo {
  /** unrotated page size, points */
  w: number;
  h: number;
  /** display rotation (source /Rotate + the page's own turn) */
  rot: PdfRotation;
}

export interface PageFrame {
  key: string;
  info: PageInfo;
  svg: SVGSVGElement;
  /** the turned group (page space) */
  root: SVGGElement;
  marks: SVGGElement;
  chrome: SVGGElement;
  live: SVGGElement;
}

export interface MarkLayer {
  /** the frame of a rendered page, else null */
  frame(key: string): PageFrame | null;
  /** every rendered page's frame */
  frames(): Iterable<PageFrame>;
  /** a page's size, when known */
  info(key: string): PageInfo | null;
  /** a page's size, measured if needed (null: no such page) */
  infoAsync(key: string): Promise<PageInfo | null>;
  /** called when a page's frame appears (or is rebuilt) and when it goes */
  onFrame(fn: (key: string, frame: PageFrame | null) => void): () => void;
  dispose(): void;
}

/** a text box drawing with a non-legacy font: its own or a style run's */
const hasFontId = needsFontRuntime;

const normRot = (deg: number): PdfRotation => ((((Math.round(deg / 90) % 4) + 4) % 4) * 90) as PdfRotation;

function pageOf(p: ProjectFile, key: string): PdfPage | undefined {
  return p.pdf?.pages.find((pg) => pg.id === key);
}

export function createMarkLayer(ctx: PdfEditorCtx): MarkLayer {
  const { session, view } = ctx;
  let disposed = false;
  const frames = new Map<string, PageFrame>();
  /** what each frame last painted: the page object and its mark list */
  const painted = new Map<string, { page: PdfPage; annots: readonly unknown[]; media: readonly unknown[] }>();
  /** each frame's node per (immutable) mark object; null = draws nothing */
  const nodeCache = new Map<string, Map<PdfAnnot, SVGElement | null>>();
  /** measured source sizes, by "src|index" */
  const srcInfo = new Map<string, { w: number; h: number; rotate: PdfRotation }>();
  const pending = new Map<string, Promise<{ w: number; h: number; rotate: PdfRotation } | null>>();
  const listeners = new Set<(key: string, frame: PageFrame | null) => void>();
  /** pages the view says are visible (their overlays exist) */
  const visible = new Set<string>();

  const emit = (key: string, f: PageFrame | null): void => {
    for (const fn of [...listeners]) fn(key, f);
  };

  function infoNow(page: PdfPage): PageInfo | null {
    if (page.src === null) return { w: page.w ?? 612, h: page.h ?? 792, rot: normRot(page.rotate) };
    const s = srcInfo.get(`${page.src}|${page.page}`);
    return s ? { w: s.w, h: s.h, rot: normRot(s.rotate + page.rotate) } : null;
  }

  async function measure(page: PdfPage): Promise<PageInfo | null> {
    const now = infoNow(page);
    if (now || page.src === null) return now;
    const k = `${page.src}|${page.page}`;
    let job = pending.get(k);
    if (!job) {
      const doc = ctx.docs.get(page.src);
      job = doc
        ? doc.pageInfo(page.page).then(
            (i) => {
              const v = { w: i.w > 0 ? i.w : 612, h: i.h > 0 ? i.h : 792, rotate: i.rotate };
              srcInfo.set(k, v);
              return v;
            },
            () => null,
          )
        : Promise.resolve(null);
      pending.set(k, job);
      void job.finally(() => pending.delete(k));
    }
    const got = await job;
    return got ? { w: got.w, h: got.h, rot: normRot(got.rotate + page.rotate) } : null;
  }

  function el<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] {
    const e = document.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  function placeFrame(f: PageFrame): void {
    const { W, H } = boxPoints(f.info.w, f.info.h, f.info.rot);
    f.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const t = pageTransform(f.info.w, f.info.h, f.info.rot);
    if (t) f.root.setAttribute("transform", t);
    else f.root.removeAttribute("transform");
  }

  /** The library changed (a font imported or removed, a face loaded): a
   *  fontId box laid out before may now draw in another font, but its node is
   *  cached by mark identity. Drop the nodes of the boxes whose own font
   *  changed (`fontStates`: a face of another font, or another face of the
   *  same one, landing touches nothing; a box's fonts include its style
   *  runs') and repaint; legacy boxes keep theirs. Subscribed only once a
   *  fontId mark (base or run) is painted (I1: a project without one adds no
   *  listener and makes no font call). */
  const fontStates = new WeakMap<PdfAnnot, string>();
  let unFonts: (() => void) | null = null;
  function relayFonts(): void {
    if (disposed) return;
    for (const f of [...frames.values()]) {
      const cache = nodeCache.get(f.key);
      if (!cache) continue;
      let hit = false;
      for (const a of [...cache.keys()]) {
        if (hasFontId(a) && fontStates.get(a) !== fontStateOf(a)) {
          cache.delete(a);
          hit = true;
        }
      }
      if (hit) paintMarks(f, session.project);
    }
  }

  /** Bring a page's mark nodes up to `p`: marks are immutable, so a mark
   *  object seen before keeps its node (only new or changed marks are built;
   *  pictures are rebuilt when the media list changed — a relink moves their
   *  file). Nodes are then put in draw order. */
  function paintMarks(f: PageFrame, p: ProjectFile): void {
    const page = pageOf(p, f.key);
    const annots = pageAnnots(p, f.key);
    const last = painted.get(f.key);
    const mediaChanged = !!last && last.media !== p.media;
    painted.set(f.key, { page: page!, annots, media: p.media });
    const prev = nodeCache.get(f.key) ?? new Map<PdfAnnot, SVGElement | null>();
    const next = new Map<PdfAnnot, SVGElement | null>();
    const want: SVGElement[] = [];
    // page pictures first, under every other mark (model.ts drawOrder)
    for (const a of drawOrder(annots)) {
      let node: SVGElement | null;
      if (prev.has(a) && !(mediaChanged && a.t === "image")) node = prev.get(a)!;
      else {
        node = markNode(a, p.media, mediaUrl);
        if (hasFontId(a)) fontStates.set(a, fontStateOf(a));
      }
      next.set(a, node);
      if (node) want.push(node);
    }
    nodeCache.set(f.key, next);
    if (!unFonts && annots.some(hasFontId)) unFonts = onFontsChanged(relayFonts);
    // drop the nodes no longer wanted, then order the rest (moves, no builds)
    const keep = new Set<Node>(want);
    for (const n of Array.from(f.marks.childNodes)) if (!keep.has(n)) f.marks.removeChild(n);
    const kids = f.marks.childNodes; // live
    for (let i = 0; i < want.length; i++) {
      if (kids[i] !== want[i]) f.marks.insertBefore(want[i]!, kids[i] ?? null);
    }
  }

  function build(key: string, info: PageInfo): void {
    const overlay = view.overlay(key);
    if (!overlay || disposed) return;
    drop(key, false);
    const svg = el("svg", "pdfmk-marks");
    svg.setAttribute("preserveAspectRatio", "none");
    const root = el("g");
    const marks = el("g");
    const chrome = el("g", "pdfmk-chrome");
    const live = el("g", "pdfmk-live");
    root.append(marks, chrome, live);
    svg.appendChild(root);
    const f: PageFrame = { key, info, svg, root, marks, chrome, live };
    placeFrame(f);
    paintMarks(f, session.project);
    overlay.appendChild(svg);
    frames.set(key, f);
    emit(key, f);
  }

  function drop(key: string, tell = true): void {
    const f = frames.get(key);
    if (!f) return;
    frames.delete(key);
    painted.delete(key);
    nodeCache.delete(key);
    f.svg.remove();
    if (tell) emit(key, null);
  }

  function show(key: string): void {
    visible.add(key);
    const page = pageOf(session.project, key);
    if (!page) return;
    const now = infoNow(page);
    if (now) {
      build(key, now);
      return;
    }
    void measure(page).then((info) => {
      if (!info || disposed || !visible.has(key) || frames.has(key)) return;
      build(key, info);
    });
  }

  const unVisible = view.on("pagevisible", (e) => show(e.key));
  const unHidden = view.on("pagehidden", (e) => {
    visible.delete(e.key);
    drop(e.key);
  });

  // Pages rendered before this layer mounted.
  for (const pg of session.project.pdf?.pages ?? []) {
    if (view.overlay(pg.id)) show(pg.id);
  }

  const unProject = session.store.subscribe((p) => {
    if (disposed) return;
    for (const f of [...frames.values()]) {
      const page = pageOf(p, f.key);
      if (!page) {
        drop(f.key);
        continue;
      }
      const last = painted.get(f.key);
      if (last && last.page !== page) {
        const info = infoNow(page);
        if (info && (info.rot !== f.info.rot || info.w !== f.info.w || info.h !== f.info.h)) {
          f.info = info;
          placeFrame(f);
          emit(f.key, f);
        }
      }
      const annots = pageAnnots(p, f.key);
      if (!last || last.annots !== annots || (last.media !== p.media && annots.some((a) => a.t === "image"))) {
        paintMarks(f, p);
      } else if (last.page !== page) {
        painted.set(f.key, { ...last, page });
      }
    }
  });

  return {
    frame: (key) => frames.get(key) ?? null,
    frames: () => frames.values(),
    info(key) {
      const f = frames.get(key);
      if (f) return f.info;
      const page = pageOf(session.project, key);
      return page ? infoNow(page) : null;
    },
    async infoAsync(key) {
      const page = pageOf(session.project, key);
      return page ? measure(page) : null;
    },
    onFrame(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unVisible();
      unHidden();
      unProject();
      unFonts?.();
      unFonts = null;
      for (const k of [...frames.keys()]) drop(k, false);
      listeners.clear();
    },
  };
}
