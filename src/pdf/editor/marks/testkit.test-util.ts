// Test kit for the marks' mount tests: the editor's fake DOM (plus SVG
// elements and a frame queue), a fake PdfView over plain objects, a fake
// session that counts history steps, and a PdfEditorCtx built from them.
// Test-only: nothing in the app imports it.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from "vitest";
import { Store } from "../../../core/store";
import { createPdfProject } from "../../../core/pdf-project";
import type { ActionId, PdfAnnot, ProjectFile } from "../../../core/types";
import type { PdfDoc, PdfEditorCtx, PdfEditorHosts, PdfSearchHit, PdfTextEditing, PdfToolState, PdfView, PdfViewEvents, PdfViewState } from "../../types";
import { FakeElement, FakeEvent, installFakeDom, type FakeDocument } from "../fake-dom.test-util";
import { setTextMeasurer } from "./render";

export { FakeElement, FakeEvent };

/** Page height in client px (zoom 1): page P1 is client y 0..792, P2 below it. */
export const PAGE_W = 612;
export const PAGE_H = 792;

export interface Kit {
  doc: FakeDocument;
  ctx: PdfEditorCtx;
  view: FakeView;
  session: FakeSession;
  hosts: PdfEditorHosts;
  frames: (() => void)[];
  runFrames(): void;
  keys: Map<ActionId, ((e: KeyboardEvent) => void)[]>;
  overlays: (() => void)[];
  /** fire a pointer event on a page (client coords) */
  pointer(type: string, x: number, y: number, extra?: Record<string, unknown>, target?: FakeElement): FakeEvent;
  /** fire a key on the document */
  keydown(key: string, extra?: Record<string, unknown>): FakeEvent;
  /** press a bound action */
  action(a: ActionId): void;
  flush(): Promise<void>;
}

export class FakeSession {
  store: Store<ProjectFile>;
  steps = 0;
  replaces = 0;
  holds = 0;
  released = 0;
  history: ProjectFile[] = [];
  /** the real session's `edited`: set by commits and by replace() unless
   *  `{ edit: false }` */
  edited = false;
  constructor(p: ProjectFile) {
    this.store = new Store(p);
  }
  get project(): ProjectFile {
    return this.store.get();
  }
  commit(mutate: (p: ProjectFile) => ProjectFile): void {
    const before = this.store.get();
    const after = mutate(before);
    if (after === before) return;
    this.history.push(before);
    this.steps++;
    this.edited = true;
    this.store.set(after);
  }
  commitFrom(before: ProjectFile): void {
    if (this.store.get() === before) return;
    this.history.push(before);
    this.steps++;
    this.edited = true;
  }
  replace(next: ProjectFile, opts?: { edit?: boolean }): void {
    if (next === this.store.get()) return;
    this.replaces++;
    if (opts?.edit !== false) this.edited = true;
    this.store.set(next);
  }
  holdAutosave(): () => void {
    this.holds++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.released++;
    };
  }
}

export class FakeView implements PdfView {
  el = new FakeElement("div") as any;
  page = new Map<string, FakeElement>();
  overlays = new Map<string, FakeElement>();
  state = new Store<PdfViewState>({ zoom: 1, fit: null, current: 0, count: 2 });
  textLayer: boolean[] = [];
  selection: PdfSearchHit[] = [];
  keys: string[];
  private ls = new Map<string, Set<(e: any) => void>>();
  constructor(keys: string[]) {
    this.keys = keys;
    this.el.className = "pdfv";
    for (const k of keys) {
      const root = new FakeElement("div");
      root.className = "pdfv-page";
      const text = new FakeElement("div");
      text.className = "textLayer";
      const span = new FakeElement("span");
      text.appendChild(span);
      const ov = new FakeElement("div");
      ov.className = "pdfv-overlay";
      root.append(text, ov);
      this.el.appendChild(root);
      this.page.set(k, root);
      this.overlays.set(k, ov);
    }
  }
  /** the text-layer span of a page (native-selection target) */
  span(key: string): FakeElement {
    return this.page.get(key)!.querySelector("span")!;
  }
  private top(key: string): number {
    return this.keys.indexOf(key) * PAGE_H;
  }
  setPages(): void {}
  scrollToPage(): void {}
  reveal(): void {}
  setSearchHits(): void {}
  setZoom(z: number): void {
    this.state.set({ ...this.state.get(), zoom: z });
  }
  fit(): void {}
  overlay(key: string): HTMLElement | null {
    return (this.overlays.get(key) as any) ?? null;
  }
  pageToClient(key: string, x: number, y: number) {
    const z = this.state.get().zoom;
    return { x: x * z, y: y * z + this.top(key) * z };
  }
  clientToPage(cx: number, cy: number) {
    const z = this.state.get().zoom;
    const i = Math.floor(cy / z / PAGE_H);
    const key = this.keys[i];
    if (!key || cx < 0 || cx / z > PAGE_W) return null;
    return { key, x: cx / z, y: cy / z - i * PAGE_H };
  }
  clientToPageOf(key: string, cx: number, cy: number) {
    const z = this.state.get().zoom;
    return { x: cx / z, y: cy / z - this.top(key) };
  }
  selectionRects(): PdfSearchHit[] {
    return this.selection;
  }
  setTextLayer(on: boolean): void {
    this.textLayer.push(on);
  }
  setFormsLayer(): void {}
  on<K extends keyof PdfViewEvents>(type: K, fn: (e: PdfViewEvents[K]) => void): () => void {
    let s = this.ls.get(type);
    if (!s) this.ls.set(type, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit<K extends keyof PdfViewEvents>(type: K, e: PdfViewEvents[K]): void {
    for (const fn of [...(this.ls.get(type) ?? [])]) fn(e);
  }
  listeners(type: string): number {
    return this.ls.get(type)?.size ?? 0;
  }
  invalidate(): void {}
  dispose(): void {}
}

export function defaultTools(): PdfToolState {
  return {
    tool: "select",
    colors: { highlight: "#ffd400", pen: "#000000", pencil: "#3a3a3a", marker: "#ffd400", shape: "#e5484d", text: "#000000" },
    sizes: { pen: 4, pencil: 2, marker: 18, eraser: 16, shape: 4, text: 14 },
    shape: "rect",
    font: "Segoe UI",
    textBg: null,
    textBorder: null,
    ruler: null,
  };
}

/** A two-page PDF project (pages P1, P2 of source "src"), with `annots`. */
export function project(annots: Record<string, PdfAnnot[]> = {}): ProjectFile {
  const ids = ["src", "P1", "P2"];
  let n = 0;
  const p = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 2 }, { id: () => ids[n++] ?? `id${n}` });
  const rec = Object.create(null) as Record<string, PdfAnnot[]>;
  for (const k of Object.keys(annots)) rec[k] = annots[k]!;
  return { ...p, pdf: { ...p.pdf!, annots: rec } };
}

export function makeKit(p: ProjectFile = project()): Kit {
  const { doc } = installFakeDom((n, v) => vi.stubGlobal(n, v));
  (doc as any).createElementNS = (_ns: string, tag: string) => new FakeElement(tag);
  const frames: (() => void)[] = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setTextMeasurer({ width: (_f, s) => [...s].length * 6 });

  const view = new FakeView(p.pdf!.pages.map((pg) => pg.id));
  doc.body.appendChild(view.el);
  const session = new FakeSession(p);
  const keys = new Map<ActionId, ((e: KeyboardEvent) => void)[]>();
  const overlays: (() => void)[] = [];
  const pdfDoc: PdfDoc = {
    id: "src",
    path: "C:\\a.pdf",
    doc: null,
    numPages: 2,
    pageInfo: async () => ({ w: PAGE_W, h: PAGE_H, rotate: 0 }),
    destroy: async () => {},
  };
  const ctx: PdfEditorCtx = {
    session: session as any,
    view,
    docs: new Map([["src", pdfDoc]]),
    tools: new Store(defaultTools()),
    selection: new Store<{ key: string; id: string }[]>([]),
    pageSelection: new Store<number[]>([]),
    textEdit: new Store<PdfTextEditing | null>(null),
    mode: new Store<"annotate" | "forms">("annotate"),
    hasForms: new Store(false),
    holdAutosave: () => session.holdAutosave(),
    registerOverlay(close) {
      overlays.push(close);
      return () => {
        const i = overlays.indexOf(close);
        if (i >= 0) overlays.splice(i, 1);
      };
    },
    bindKey(action, fn) {
      const list = keys.get(action) ?? [];
      list.push(fn);
      keys.set(action, list);
      return () => {
        const l = keys.get(action)!;
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      };
    },
    isTyping: (t) => {
      const e = t as any;
      return !!e && (e.isContentEditable === true || (typeof e.getAttribute === "function" && e.getAttribute("contenteditable") !== null));
    },
  };
  const hosts: PdfEditorHosts = {
    toolbar: new FakeElement("div") as any,
    inspector: new FakeElement("aside") as any,
    topbar: new FakeElement("div") as any,
  };
  for (const h of Object.values(hosts)) doc.body.appendChild(h as any);

  const kit: Kit = {
    doc,
    ctx,
    view,
    session,
    hosts,
    frames,
    runFrames() {
      while (frames.length) frames.shift()!();
    },
    keys,
    overlays,
    pointer(type, x, y, extra = {}, target) {
      const e = new FakeEvent(type, {
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        pressure: 0.5,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        detail: 1,
        timeStamp: 0,
        ...extra,
      });
      const t = target ?? view.page.get(view.clientToPage(x, y)?.key ?? view.keys[0]!)!;
      t.dispatchEvent(e);
      return e;
    },
    keydown(key, extra = {}) {
      const e = new FakeEvent("keydown", { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra });
      const t = (doc.activeElement ?? doc.body) as FakeElement;
      t.dispatchEvent(e);
      return e;
    },
    action(a) {
      const l = keys.get(a);
      l?.[l.length - 1]?.(new FakeEvent("keydown") as any);
    },
    async flush() {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
  };
  return kit;
}

/** Show every page's overlay to the layer (the view's pagevisible). */
export function showPages(kit: Kit): void {
  for (const k of kit.view.keys) kit.view.emit("pagevisible", { key: k, overlay: kit.view.overlay(k)! });
}
