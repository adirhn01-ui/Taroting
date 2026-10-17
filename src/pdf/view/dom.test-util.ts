// Test-only: the strip and the rail mounted on the PDF editor's fake DOM
// (vitest runs in Node), with a fake pdf.js module and fake documents whose
// page proxies record render() and cleanup(). Each test file mocks "./pdfjs"
// with `pdfjsModule()` (vi.mock is only hoisted inside the test file itself).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from "vitest";
import { FakeElement, FakeNode, installFakeDom, type FakeDocument, type FakeWindow } from "../editor/fake-dom.test-util";
import type { PdfDoc, PdfViewPage } from "../types";

/* ------------------------------ fake pdf.js ------------------------------ */

/** Every AnnotationLayer.render call (div + the annotations it got). */
export const annotRenders: { div: FakeElement; annotations: any[] }[] = [];

class FakeAnnotationLayer {
  div: FakeElement;
  constructor(o: { div: FakeElement }) {
    this.div = o.div;
  }
  async render(p: { annotations: any[] }): Promise<void> {
    annotRenders.push({ div: this.div, annotations: p.annotations });
    for (const a of p.annotations) {
      if (a.subtype !== "Link") continue;
      // what pdf.js's _bindLink makes of an internal destination
      const link = (globalThis as any).document.createElement("a") as FakeElement;
      link.setAttribute("href", "#");
      (link as any).onclick = () => false;
      const section = (globalThis as any).document.createElement("section") as FakeElement;
      section.appendChild(link);
      this.div.appendChild(section);
    }
  }
  update(): void {}
}

class FakeTextLayer {
  textDivs: unknown[] = [];
  async render(): Promise<void> {}
  update(): void {}
  cancel(): void {}
}

export const fakePdfjs = {
  AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
  AnnotationLayer: FakeAnnotationLayer,
  TextLayer: FakeTextLayer,
};

/** The body of `vi.mock("./pdfjs", ...)`. */
export function pdfjsModule(): Record<string, unknown> {
  return {
    loadPdfjs: async () => fakePdfjs,
    pdfjsNow: () => fakePdfjs,
    documentParams: () => ({}),
    sharedWorker: { acquire: () => null, release: () => {}, refs: 0, peek: () => null },
    WORKER_GRACE_MS: 0,
  };
}

/* ------------------------------ fake documents ------------------------------ */

export class FakeStorage {
  map = new Map<string, Record<string, unknown>>();
  setValue(key: string, value: Record<string, unknown>): void {
    this.map.set(key, { ...(this.map.get(key) ?? {}), ...value });
  }
  getRawValue(key: string): unknown {
    return this.map.get(key);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

export interface FakePage {
  view: number[];
  rotate: number;
  userUnit: number;
  getViewport(o: { scale: number; rotation: number }): { width: number; height: number };
  getAnnotations: () => Promise<any[]>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
}

export interface FakeDoc extends PdfDoc {
  pageInfo: ReturnType<typeof vi.fn> & PdfDoc["pageInfo"];
  /** pdf.js page number (1-based) → its one proxy */
  proxies: Map<number, FakePage>;
  storage: FakeStorage;
}

export function fakeDoc(
  n: number,
  o: { w?: number; h?: number; id?: string; annots?: (index: number) => any[] } = {},
): FakeDoc {
  const w = o.w ?? 612;
  const h = o.h ?? 792;
  const storage = new FakeStorage();
  const proxies = new Map<number, FakePage>();
  const page = (num: number): FakePage => {
    let p = proxies.get(num);
    if (!p) {
      p = {
        view: [0, 0, w, h],
        rotate: 0,
        userUnit: 1,
        getViewport: ({ scale, rotation }) =>
          rotation % 180 !== 0 ? { width: h * scale, height: w * scale } : { width: w * scale, height: h * scale },
        getAnnotations: async () => o.annots?.(num - 1) ?? [],
        render: vi.fn(() => ({ promise: Promise.resolve(), cancel: () => {} })),
        cleanup: vi.fn(() => true),
      };
      proxies.set(num, p);
    }
    return p;
  };
  const doc = {
    id: o.id ?? "d1",
    path: "x.pdf",
    numPages: n,
    doc: { getPage: async (num: number) => page(num), annotationStorage: storage },
    pageInfo: vi.fn(async () => ({ w, h, rotate: 0 as const })),
    destroy: async () => {},
    proxies,
    storage,
  };
  return doc as unknown as FakeDoc;
}

export function pagesOf(doc: PdfDoc, n = doc.numPages): PdfViewPage[] {
  return Array.from({ length: n }, (_, i) => ({ key: `p${i}`, doc, index: i, rotate: 0 }) as PdfViewPage);
}

/* ------------------------------ globals ------------------------------ */

export interface Env {
  win: FakeWindow;
  doc: FakeDocument;
  /** run the queued animation frames */
  flushFrames(): void;
  /** the rail's IntersectionObserver callbacks, newest last */
  io: { cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void }[];
}

/** DocumentFragment: appending one moves its children (patched in once). */
const FRAGMENT = "#FRAGMENT";
let fragmentsPatched = false;
function patchFragments(): void {
  if (fragmentsPatched) return;
  fragmentsPatched = true;
  const append = FakeNode.prototype.appendChild;
  FakeNode.prototype.appendChild = function <T extends FakeNode>(this: FakeNode, c: T): T {
    if (c instanceof FakeElement && c.tagName === FRAGMENT) {
      for (const k of [...c.childNodes]) append.call(this, k);
      return c;
    }
    return append.call(this, c) as T;
  };
}

export function installEnv(): Env {
  const { win, doc } = installFakeDom(vi.stubGlobal);
  patchFragments();
  (doc as any).createDocumentFragment = () => new FakeElement(FRAGMENT);
  let frames: (() => void)[] = [];
  const raf = (fn: () => void): number => {
    frames.push(fn);
    return frames.length;
  };
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  win.requestAnimationFrame = raf;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  const io: Env["io"] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: Env["io"][number]["cb"];
      constructor(cb: Env["io"][number]["cb"]) {
        this.cb = cb;
        io.push(this);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  return {
    win,
    doc,
    io,
    flushFrames(): void {
      const run = frames;
      frames = [];
      for (const f of run) f();
    },
  };
}

/** Poll (macrotask turns) until `cond` holds; throws after `turns`. */
export async function until(cond: () => boolean, turns = 300): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("condition never held");
}
