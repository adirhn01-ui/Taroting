// Opening documents: bytes over the asset protocol (local, so no range
// requests), pdf.js on the shared worker, errors mapped to PdfOpenError. The
// core (`createLoader`) takes its pdf.js, byte reader and worker as deps so the
// error mapping and the worker refcount are tested under Node with pdf.js's
// legacy build and real fixtures.

import { ipc, mediaUrl } from "../../core/ipc";
import type { PdfRotation } from "../../core/types";
import type { PdfDoc, PdfOpenError } from "../types";
import { displayRotation, normRotation, backingSize } from "./math";
import type { SharedResource } from "./lifecycle";

/** The slice of pdf.js the loader uses (the browser and legacy builds both fit). */
export interface PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<unknown>; destroy(): Promise<void> };
}

export interface LoaderDeps {
  pdfjs(): Promise<PdfjsLike>;
  /** the file's bytes, or null when it does not exist */
  readBytes(path: string): Promise<Uint8Array | null>;
  params(): Record<string, unknown>;
  /** the shared worker; null = pdf.js makes its own (tests) */
  worker: SharedResource<unknown> | null;
}

/** An Error carrying a PdfOpenError's fields (`kind`, …). */
export type PdfOpenFailure = Error & PdfOpenError;

export function isPdfOpenError(e: unknown): e is PdfOpenFailure {
  const k = (e as { kind?: unknown } | null)?.kind;
  return k === "password" || k === "invalid" || k === "missing" || k === "other";
}

function failure(err: PdfOpenError, message: string): PdfOpenFailure {
  return Object.assign(new Error(message), err);
}

/** Map whatever pdf.js (or the reader) threw to a PdfOpenError. */
export function toOpenError(e: unknown, hadPassword: boolean): PdfOpenFailure {
  if (isPdfOpenError(e)) return e;
  const name = (e as { name?: unknown } | null)?.name;
  const message = e instanceof Error ? e.message : String(e ?? "");
  if (name === "PasswordException") {
    // pdf.js: code 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD
    const code = (e as { code?: unknown }).code;
    return failure({ kind: "password", retry: code === 2 || hadPassword }, message || "Password required");
  }
  if (name === "InvalidPDFException") return failure({ kind: "invalid" }, message || "Not a valid PDF");
  return failure({ kind: "other", message: message || "The PDF could not be opened" }, message || "The PDF could not be opened");
}

/** What the view needs of pdf.js's document beyond the PdfDoc contract. */
interface ProxyLike {
  numPages: number;
  getPage(n: number): Promise<{ view: number[]; rotate: number; userUnit?: number }>;
}

class OpenedDoc implements PdfDoc {
  readonly numPages: number;
  private info = new Map<number, Promise<{ w: number; h: number; rotate: PdfRotation }>>();
  private gone: Promise<void> | null = null;

  constructor(
    readonly id: string,
    readonly path: string,
    readonly doc: unknown,
    private task: { destroy(): Promise<void> },
    private onGone: () => void,
  ) {
    this.numPages = (doc as ProxyLike).numPages;
  }

  pageInfo(index: number): Promise<{ w: number; h: number; rotate: PdfRotation }> {
    let p = this.info.get(index);
    if (!p) {
      p = (this.doc as ProxyLike).getPage(index + 1).then((page) => {
        const v = page.view;
        return {
          w: Math.abs((v[2] ?? 0) - (v[0] ?? 0)),
          h: Math.abs((v[3] ?? 0) - (v[1] ?? 0)),
          rotate: normRotation(page.rotate),
        };
      });
      // a failed lookup is not cached: the next caller retries
      p.catch(() => this.info.delete(index));
      this.info.set(index, p);
    }
    return p;
  }

  destroy(): Promise<void> {
    this.gone ??= this.task
      .destroy()
      .catch(() => {})
      .finally(() => this.onGone());
    return this.gone;
  }
}

export interface Loader {
  openPdf(id: string, path: string, opts?: { password?: string }): Promise<PdfDoc>;
  countPages(path: string): Promise<number>;
}

export function createLoader(deps: LoaderDeps): Loader {
  async function openPdf(id: string, path: string, opts?: { password?: string }): Promise<PdfDoc> {
    const hadPassword = typeof opts?.password === "string";
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.readBytes(path);
    } catch (e) {
      throw toOpenError(e, hadPassword);
    }
    if (!bytes) throw failure({ kind: "missing" }, `File not found: ${path}`);
    const pdfjs = await deps.pdfjs();
    const worker = deps.worker ? deps.worker.acquire() : undefined;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      deps.worker?.release();
    };
    let task: { promise: Promise<unknown>; destroy(): Promise<void> };
    try {
      task = pdfjs.getDocument({
        ...deps.params(),
        data: bytes,
        ...(worker ? { worker } : {}),
        ...(hadPassword ? { password: opts!.password } : {}),
      });
    } catch (e) {
      release();
      throw toOpenError(e, hadPassword);
    }
    let proxy: unknown;
    try {
      proxy = await task.promise;
    } catch (e) {
      await task.destroy().catch(() => {});
      release();
      throw toOpenError(e, hadPassword);
    }
    return new OpenedDoc(id, path, proxy, task, release);
  }

  async function countPages(path: string): Promise<number> {
    const doc = await openPdf(path, path);
    const n = doc.numPages;
    await doc.destroy();
    return n;
  }

  return { openPdf, countPages };
}

/* ------------------------------ page → image ------------------------------ */

interface RenderablePage {
  rotate: number;
  getViewport(o: { scale: number; rotation?: number }): { width: number; height: number };
  render(o: { canvas: HTMLCanvasElement; viewport: unknown; background?: string }): { promise: Promise<void> };
}

/**
 * One page as an image no larger than `maxSide` px on its long side (Home's
 * card cover, "export page as image"). Painted on white, so a JPEG never gets
 * a black background.
 */
export async function renderPageToBlob(
  doc: PdfDoc,
  index: number,
  rotate: PdfRotation,
  maxSide: number,
  type: "image/jpeg" | "image/png",
): Promise<Blob> {
  const proxy = doc.doc as { getPage(n: number): Promise<RenderablePage & { cleanup(): void }> };
  const page = await proxy.getPage(index + 1);
  const rotation = displayRotation(page.rotate, rotate);
  const vp1 = page.getViewport({ scale: 1, rotation });
  const long = Math.max(vp1.width, vp1.height) || 1;
  const want = Math.max(1, maxSide) / long;
  // stay inside the canvas limits whatever was asked
  const { ratio } = backingSize(vp1.width, vp1.height, want);
  const vp = page.getViewport({ scale: ratio, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  try {
    await page.render({ canvas, viewport: vp, background: "#ffffff" }).promise;
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The page could not be encoded"))), type, 0.9);
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

/* ------------------------------ the app's loader ------------------------------ */

/** Bytes over the asset protocol; null when the file does not exist. */
async function readBytes(path: string): Promise<Uint8Array | null> {
  const stat = await ipc.fileStat(path);
  if (!stat) return null;
  const res = await fetch(mediaUrl(path));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The file could not be read (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

let appLoader: Loader | null = null;
function loader(): Loader {
  appLoader ??= createLoader({
    pdfjs: async () => {
      const m = await import("./pdfjs");
      return (await m.loadPdfjs()) as unknown as PdfjsLike;
    },
    readBytes,
    params: () => documentParamsNow(),
    worker: lazyWorker,
  });
  return appLoader;
}

// pdfjs.ts is reached through import() so this module stays cheap to load
// (open-media imports it just to count pages); by the time params/worker are
// needed, deps.pdfjs() has resolved it. core/ipc, by contrast, is imported
// statically: it is on the boot path already, and an import() of it only
// split it into a chunk of its own at startup.
let pdfjsMod: typeof import("./pdfjs") | null = null;
const pdfjsModReady = import("./pdfjs").then((m) => (pdfjsMod = m));
function documentParamsNow(): Record<string, unknown> {
  return pdfjsMod ? pdfjsMod.documentParams() : {};
}
const lazyWorker: SharedResource<unknown> = {
  acquire: () => pdfjsMod!.sharedWorker.acquire(),
  release: () => pdfjsMod?.sharedWorker.release(),
  get refs() {
    return pdfjsMod?.sharedWorker.refs ?? 0;
  },
  peek: () => pdfjsMod?.sharedWorker.peek() ?? null,
};

/** Open a PDF on the app's shared worker. Throws a PdfOpenError-shaped Error. */
export async function openPdf(id: string, path: string, opts?: { password?: string }): Promise<PdfDoc> {
  await pdfjsModReady;
  return loader().openPdf(id, path, opts);
}

/** A PDF's page count (opens and closes it). Throws like openPdf. */
export async function countPages(path: string): Promise<number> {
  await pdfjsModReady;
  return loader().countPages(path);
}
