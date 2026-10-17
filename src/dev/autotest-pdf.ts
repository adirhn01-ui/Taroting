// 0.9.3 E2E blocks: the PDF viewer, the PDF editor (marks, Fill forms, export,
// page operations), clip volume to 500%, the per-row shortcut reset and the
// damaged-start thumbnail. DEV-only: imported lazily by autotest.ts, never
// part of a release bundle.
//
// NOTHING under src/pdf (or src/image) is imported statically here: the PDF
// view, pdf.js, the PDF editor and the export (pdf-lib) are lazy chunks, and
// this module is loaded before its first block runs — a static import would
// load them as a side effect of the harness and blind the chunk check. Every
// runtime module a block drives is reached with `await import(...)` inside it
// (type-only imports are erased).
//
// What a block asserts is what is ON SCREEN or ON DISK: page canvases read
// back for ink, the element hit at a point, client rects against the view's
// own page→client mapping, an exported file reopened with pdf.js and rendered
// with its annotations OFF (so a flattened mark has to be page content to
// show) — never a class or a state field alone.
//
// Viewer blocks (1–4) start and end on Home. The editor blocks (5–8) share ONE
// PDF editor mount (one mount is most of their time); each starts with
// `ensureEditor()`, so a failure in an earlier one does not cascade into a
// silent skip, and the last one (and a final safety net) tears it down. The
// others each mount what they need and end on Home with everything they wrote
// deleted and every setting put back.

import { invoke } from "@tauri-apps/api/core";
import { errorDetail, ipc, mediaUrl } from "../core/ipc";
import { navigate } from "../core/nav";
import { createProject, importMediaAsClip } from "../core/project";
import { currentSession, settingsStore, settingsWritesSettled, updateSettings, type ProjectSession } from "../core/session";
import type { ActionId, PdfAnnot } from "../core/types";
import type { PdfDoc, PdfEditorCtx, PdfView } from "../pdf/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { DevHook } from "./autotest";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the Wave 1, viewer and image blocks. */
export type PdfCtx = Wave1Ctx;

/** Deletes a non-project file a block wrote (scratch root / derived cache
 *  only; the backend refuses anything else and exists only under the harness). */
const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

/** What the PDF editor publishes on window while mounted (shell.ts, DEV). */
interface PdfEditorDev {
  session: ProjectSession;
  ctx: PdfEditorCtx;
  view: PdfView;
  docs: ReadonlyMap<string, PdfDoc>;
}
/** What the viewer's PDF mode publishes on window while mounted (pdf-mode.ts, DEV). */
interface PdfViewDev {
  view: PdfView;
  doc(): PdfDoc | null;
}
/** The video editor's hook, with the two members DevHook does not type. */
type VideoDev = DevHook & {
  timeline: { select(id: string | null): void };
  scheduler: { activeVideoInfos(): { el: HTMLVideoElement }[] };
};

/** The slice of pdf.js's document / page proxies the export checks read. */
interface PdfPageLite {
  getAnnotations(): Promise<{ subtype?: string; id?: string }[]>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}
type FieldObjects = Map<string, { value?: unknown }[]> | Record<string, { value?: unknown }[]> | null;
const fieldOf = (f: FieldObjects, name: string): { value?: unknown }[] | undefined =>
  !f ? undefined : f instanceof Map ? f.get(name) : f[name];
const fieldCountOf = (f: FieldObjects): number => (!f ? 0 : f instanceof Map ? f.size : Object.keys(f).length);
interface PdfProxyLite {
  numPages: number;
  getPage(n: number): Promise<PdfPageLite>;
  /** pdf.js 6 answers a Map; older builds a plain object; null = no AcroForm */
  getFieldObjects(): Promise<FieldObjects>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pageRaf = window.requestAnimationFrame.bind(window);
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => pageRaf(() => r()));
};

/** Poll every 20 ms; `what` is evaluated only on timeout, so the message says
 *  what was on screen then. */
async function until<T>(get: () => T | null | undefined | false, ms: number, what: () => string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what()}`);
    await sleep(20);
  }
}

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E | null => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E[] => Array.from(root.querySelectorAll<E>(sel));
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const text = (sel: string): string => ($(sel)?.textContent ?? "").trim();
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

/** Laid out AND painted: a box, no display:none ancestor, not visibility:hidden. */
function rendered(el: Element | null): el is HTMLElement {
  return el instanceof Element && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}

/** The centre of the part of `el` that is inside `clip` (null: none of it). */
function visibleCentre(el: Element, clip: Element): { x: number; y: number } | null {
  const a = el.getBoundingClientRect();
  const b = clip.getBoundingClientRect();
  const l = Math.max(a.left, b.left, 0);
  const t = Math.max(a.top, b.top, 0);
  const r = Math.min(a.right, b.right, window.innerWidth);
  const btm = Math.min(a.bottom, b.bottom, window.innerHeight);
  return r - l > 4 && btm - t > 4 ? { x: (l + r) / 2, y: (t + btm) / 2 } : null;
}

/** Element hit at an element's own centre. */
function hitAtCentreOf(el: Element): Element | null {
  const r = el.getBoundingClientRect();
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
}

/** Pixels of a canvas that are not paper: any channel under 230 (anti-aliased
 *  12 pt text survives the downscale). Read through a small scratch copy, so a
 *  page canvas of any size costs the same. */
function inkPixels(src: HTMLCanvasElement): number {
  if (src.width === 0 || src.height === 0) return 0;
  const k = Math.min(1, 256 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return 0;
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.min(d[i]!, d[i + 1]!, d[i + 2]!) < 230) n++;
  c.width = 0;
  return n;
}

/** The darkest luminance in a (2r+1)² square around (x, y) of a canvas. */
function darkestAround(c: HTMLCanvasElement, x: number, y: number, r = 2): number {
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const x0 = Math.max(0, Math.round(x) - r);
  const y0 = Math.max(0, Math.round(y) - r);
  const d = g.getImageData(x0, y0, 2 * r + 1, 2 * r + 1).data;
  let min = 255;
  for (let i = 0; i < d.length; i += 4) min = Math.min(min, 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!);
  return Math.round(min);
}

/** The page canvas of slot `key` inside `root`, once it has ink. */
function inkedCanvas(root: ParentNode, key: string): HTMLCanvasElement | null {
  const c = $<HTMLCanvasElement>(`.pdfv-page[data-key="${key}"] > canvas.pdfv-canvas`, root);
  return c && rendered(c) && inkPixels(c) > 3 ? c : null;
}

function pdfViewDev(): PdfViewDev | undefined {
  return (window as unknown as { __tarotingPdfViewDev?: PdfViewDev }).__tarotingPdfViewDev;
}
function pdfEdDev(): PdfEditorDev | undefined {
  return (window as unknown as { __tarotingPdfDev?: PdfEditorDev }).__tarotingPdfDev;
}
function videoDev(): VideoDev | undefined {
  return (window as unknown as { __tarotingDev?: VideoDev }).__tarotingDev;
}
function imageDevSet(): boolean {
  return (window as unknown as { __tarotingImageDev?: unknown }).__tarotingImageDev !== undefined;
}

function onScreen(): string {
  return $(".pdfed")
    ? "PDF editor"
    : $(".imged")
      ? "image editor"
      : $(".editor")
        ? "video editor"
        : $("#vw")
          ? `viewer (status "${rendered($("#vw-status")) ? text("#vw-status") : ""}", page "${text("#vw-pdf-page")}")`
          : $(".settings")
            ? "settings"
            : $(".home")
              ? "home"
              : "?";
}

/** Resource names (and Vite's dev style tags) loaded so far. */
const resources = (): string[] => performance.getEntriesByType("resource").map((e) => e.name.replace(/\\/g, "/"));
const devStyles = (): string[] =>
  Array.from(document.querySelectorAll("style[data-vite-dev-id]"), (s) => (s.getAttribute("data-vite-dev-id") ?? "").replace(/\\/g, "/"));
/** pdf.js's library module (not its worker, not the `?url` stub naming it). */
const isPdfjsLib = (n: string): boolean => /pdfjs-dist/.test(n) && !/worker/i.test(n);

export async function runPdfBlocks(ctx: PdfCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const pdfDir = `${fixturesDir}\\pdf`;
  const fx = (name: string): string => `${pdfDir}\\${name}`;

  const FIXTURES = ["plain_3p.pdf", "scanned_jpx.pdf", "encrypted.pdf", "form_acro.pdf"].map(fx);
  const OTHER = [`${fixturesDir}\\counter_audio_h264.mp4`, `${fixturesDir}\\damaged_h264.mp4`];
  const present = await Promise.all([...FIXTURES, ...OTHER].map((f) => ipc.pathExists(f).catch(() => false)));
  const missing = [...FIXTURES, ...OTHER].filter((_, i) => !present[i]).map(baseName);
  const needFixtures = (): void => assert(missing.length === 0, `fixtures missing (${missing.join(", ")}) — run npm run fixtures`);

  // The resource-timing buffer is full long before these blocks (the run has
  // loaded hundreds of dev modules), and a full buffer records nothing new:
  // start a fresh one so the chunk checks below see what THESE blocks load.
  try {
    performance.clearResourceTimings();
    performance.setResourceTimingBufferSize(4000);
  } catch {
    // no Resource Timing: the chunk checks say so instead of passing
  }
  /** /src/image/ modules fetched before the PDF blocks (none: just cleared) —
   *  the image-chunk check counts only what appears after. */
  const imageResBefore = new Set(resources().filter((n) => n.includes("/src/image/")));
  /** Whether any PDF block ever had the image editor mounted. */
  let imageEditorSeen = false;
  const noteImageEditor = (): void => {
    if ($(".imged") || imageDevSet()) imageEditorSeen = true;
  };

  /** Scratch output: the autotest root, never the repo or the owner's folders. */
  let outDir = "";
  const scratchDir = async (): Promise<string> => {
    if (outDir) return outDir;
    const dir = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
    assert(/taroting-autotest/i.test(dir), `the scratch folder ${dir} is not inside the autotest root — refusing to write test output there`);
    outDir = dir;
    return dir;
  };

  /** Close menus and dialogs, discard a temp session, park on Home. Never throws. */
  const backHome = async (): Promise<void> => {
    try {
      closeMenu();
      for (const b of $$(".modal-backdrop")) {
        const out = b.querySelector<HTMLElement>('[data-act="cancel"], [data-cancel], [data-close], [data-close-btn]');
        if (out) out.click();
        else b.remove();
      }
      const s = currentSession.get();
      if (s && s.temp.get()) await discardTempSession(s);
      navigate({ view: "home" });
      await until(() => $(".home") && !$(".editor") && !$("#vw") && !$(".settings"), 5_000, () => `Home (${onScreen()})`);
    } catch (e) {
      console.error("pdf autotest: cleanup did not finish", e);
    }
  };

  /* ================================================================ */
  /* The viewer                                                        */
  /* ================================================================ */

  /** Open `path` in the viewer (the route Home and Explorer reach) and wait
   *  for the PDF mode's hook to show a document with `pages` pages. */
  const openViewerPdf = async (path: string): Promise<PdfViewDev> => {
    navigate({ view: "viewer", path });
    return until(
      () => {
        const d = pdfViewDev();
        return $("#vw") && d && d.doc()?.path === path ? d : null;
      },
      8_000,
      () => `the viewer's PDF mode on ${baseName(path)} — ${onScreen()}`,
    );
  };

  await test("pdf-viewer-renders", async () => {
    const t0 = performance.now();
    let railClicked = false;
    try {
      needFixtures();
      // Chunk discipline, before: nothing has fetched pdf.js or mounted the PDF
      // view. pdfjs.ts itself is tiny (no static pdf.js import) and holds the
      // loaded library, so asking it is the direct question.
      const pdfjsMod = await import("../pdf/view/pdfjs");
      const libBefore = pdfjsMod.pdfjsNow();
      const viewCssBefore = devStyles().filter((n) => n.includes("/src/pdf/"));
      const libResBefore = resources().filter(isPdfjsLib);
      assert(libBefore === null, "pdf.js was already loaded before the run's first PDF was opened — something prefetches it");
      assert(viewCssBefore.length === 0, `the PDF view's styles were in before any PDF opened: ${viewCssBefore.map(baseName).join(", ")}`);

      const path = fx("plain_3p.pdf");
      const dev = await openViewerPdf(path);
      noteImageEditor();
      const strip = await until(() => $("#vw-pdf .pdfv"), 2_000, () => `the page strip (#vw-pdf .pdfv) — ${onScreen()}`);
      const canvas = await until(() => inkedCanvas(strip, "p0"), 6_000, () => `page 1's canvas with ink — ${onScreen()}, canvases ${$$("#vw-pdf canvas.pdfv-canvas").length}`);
      const ink = inkPixels(canvas);
      await until(() => text("#vw-pdf-page") === "Page 1 of 3" && rendered($("#vw-pdf-page")), 2_000, () => `"Page 1 of 3" in the top bar (got "${text("#vw-pdf-page")}")`);

      // The rail: 3 thumbnails, rendered (opened for the check when the
      // window's width started it closed, and put back).
      if (!rendered($("#vw-pdf-rail"))) {
        $<HTMLButtonElement>("#vw-pdf-railbtn")!.click();
        railClicked = true;
      }
      const thumbs = await until(
        () => {
          const t = $$("#vw-pdf-rail .pdfv-thumb");
          return t.length === 3 && t.every(rendered) ? t : null;
        },
        2_000,
        () => `3 rendered thumbnails in the rail (got ${$$("#vw-pdf-rail .pdfv-thumb").length}, rail ${rendered($("#vw-pdf-rail")) ? "shown" : "hidden"})`,
      );

      // What the page's visible centre shows is the page — no bar, card or
      // rail over it.
      const page = $(`.pdfv-page[data-key="p0"]`, strip)!;
      const at = visibleCentre(page, strip);
      assert(at !== null, `page 1 is not inside the strip's visible area (page ${JSON.stringify(page.getBoundingClientRect())})`);
      const hit = document.elementFromPoint(at!.x, at!.y);
      assert(hit !== null && page.contains(hit), `the page's visible centre shows ${describeEl(hit)}, not page 1`);

      // Chunk discipline, after: pdf.js is in now, and the view's styles with it.
      const lib = pdfjsMod.pdfjsNow();
      assert(lib !== null, "a PDF is on screen but pdfjs.ts reports pdf.js not loaded");
      assert(devStyles().some((n) => n.includes("/src/pdf/view/view.css")), "a PDF is on screen but the PDF view's stylesheet never loaded");
      const libRes = resources().filter(isPdfjsLib).filter((n) => !libResBefore.includes(n));
      return `plain_3p.pdf: page 1 canvas ${canvas.width}x${canvas.height} with ${ink} ink px (of a 256-px copy), "Page 1 of 3", rail ${thumbs.length} thumbs, visible centre hits ${describeEl(hit)} inside page 1; pdf.js loaded only now (before: not loaded, no PDF styles${libRes.length ? `; fetched ${libRes.map((n) => baseName(n.split("?")[0]!)).join(", ")}` : "; its fetch is not in Resource Timing (prebundled/cached) — pdfjsNow() is the evidence"}); dev hook ${dev ? "up" : "absent"} — ${ms(t0)}`;
    } finally {
      if (railClicked) $<HTMLButtonElement>("#vw-pdf-railbtn")?.click();
      await backHome();
    }
  });

  await test("pdf-viewer-jpx", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      const before = new Set(resources());
      await openViewerPdf(fx("scanned_jpx.pdf"));
      const canvas = await until(
        () => inkedCanvas($("#vw-pdf") ?? document, "p0"),
        8_000,
        () => `the JPEG 2000 page to paint — ${onScreen()}, page error ${$("#vw-pdf .pdfv-page--error") ? "SHOWN" : "none"}`,
      );
      const ink = inkPixels(canvas);
      assert(!$("#vw-pdf .pdfv-page--error"), "the JPEG 2000 page shows the page-error card");
      // The decoder runs in the pdf.js WORKER, whose fetches are not in this
      // window's Resource Timing: the evidence is the painted page itself,
      // decoded with useWasm:false under the real CSP (script-src 'self', no
      // 'wasm-unsafe-eval'). A fallback fetch seen from here is reported, never
      // required.
      const seen = resources().filter((n) => !before.has(n) && /openjpeg/i.test(n));
      return `scanned_jpx.pdf (JPXDecode) painted ${ink} ink px (of a 256-px copy) on a ${canvas.width}x${canvas.height} canvas under the app's CSP, no page-error card${seen.length ? `; seen from the window: ${seen.map((n) => baseName(n.split("?")[0]!)).join(", ")}` : " (the decoder's fetch is worker-side, not observable from the window)"} — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("pdf-viewer-find", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      const dev = await openViewerPdf(fx("plain_3p.pdf"));
      await until(() => inkedCanvas($("#vw-pdf") ?? document, "p0"), 6_000, () => `page 1 painted — ${onScreen()}`);
      assert(dev.view.state.get().current === 0, `the viewer opened at slot ${dev.view.state.get().current}, not page 1`);
      const findBtn = $<HTMLButtonElement>("#vw-pdf-findbtn");
      assert(rendered(findBtn), "the Find button is not rendered");
      findBtn!.click();
      const input = await until(() => {
        const i = $<HTMLInputElement>("#vw-pdf-find-input");
        return i && rendered(i) ? i : null;
      }, 1_000, () => "the find box");
      const inputHit = hitAtCentreOf(input);
      assert(inputHit === input, `the find box's centre shows ${describeEl(inputHit)}, not its input`);
      input.value = "needle";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "needle" }));
      await until(() => text("#vw-pdf-find-count") === "1 of 1", 4_000, () => `"1 of 1" (got "${text("#vw-pdf-find-count")}")`);
      // The hit is on page 2, scrolled to, and drawn where it can be seen.
      await until(() => dev.view.state.get().current === 1 || null, 2_000, () => `page 2 to be current (current slot ${dev.view.state.get().current})`);
      const strip = $("#vw-pdf .pdfv")!;
      const mark = await until(() => {
        const m = $(`.pdfv-page[data-key="p1"] .pdfv-hit--active`, strip);
        return m && rendered(m) && visibleCentre(m, strip) ? m : null;
      }, 2_000, () => `the active hit on page 2 inside the strip's view (hits: ${$$(".pdfv-hit", strip).map((h) => (h.closest(".pdfv-page") as HTMLElement | null)?.dataset.key).join(",") || "none"})`);
      const others = $$(".pdfv-hit", strip).filter((h) => (h.closest(".pdfv-page") as HTMLElement | null)?.dataset.key !== "p1");
      assert(others.length === 0, `hits drawn on other pages too: ${others.length}`);
      await until(() => text("#vw-pdf-page") === "Page 2 of 3", 2_000, () => `"Page 2 of 3" (got "${text("#vw-pdf-page")}")`);
      const r = mark.getBoundingClientRect();
      return `"needle": 1 of 1, on page 2 (current slot 1, "Page 2 of 3"), active hit ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)} inside the strip's view, none elsewhere — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("pdf-viewer-password", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      const path = fx("encrypted.pdf");
      navigate({ view: "viewer", path });
      const pw = await until(() => {
        const i = $<HTMLInputElement>("#vw-pdf-password");
        return i && rendered(i) && rendered($("#vw-pdf-lock")) ? i : null;
      }, 6_000, () => `the password prompt — ${onScreen()}`);
      const hit = hitAtCentreOf(pw);
      assert(hit === pw, `the password field's centre shows ${describeEl(hit)} — the prompt is covered`);
      assert(!$("#vw-pdf canvas.pdfv-canvas"), "a page canvas is up behind the password prompt");
      pw.value = "taroting";
      $<HTMLButtonElement>("#vw-pdf-open")!.click();
      const dev = await until(() => {
        const d = pdfViewDev();
        return d && d.doc()?.path === path ? d : null;
      }, 6_000, () => `encrypted.pdf to open with the password — ${onScreen()}, error ${rendered($("#vw-pdf-lock-error")) ? "SHOWN" : "none"}`);
      const canvas = await until(() => inkedCanvas($("#vw-pdf") ?? document, "p0"), 6_000, () => `the decrypted page to paint — ${onScreen()}`);
      assert(!$("#vw-pdf-lock"), "the password prompt is still up after the page opened");
      return `prompt shown and on top (hit = #vw-pdf-password), "taroting" opened ${dev.doc()!.numPages} page(s), page 1 painted ${inkPixels(canvas)} ink px, prompt gone — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  /* ================================================================ */
  /* The PDF editor (one mount for blocks 5–8)                         */
  /* ================================================================ */

  let edPath = "";
  /** Mark ids block 5 placed (block 7 reads their kinds and places). */
  const placed: { ink: string; text: string; hl: string } = { ink: "", text: "", hl: "" };
  const TYPED = "Taroting E2E";
  const HEBREW = "שלום Taroting";
  /** form_acro.pdf's "name" field, in page space: pdf-lib placed it at
   *  x 160, y 750, 300 x 22 on A4 (841.89 pt high), y up. */
  const NAME_FIELD = { x: 160, y: 841.89 - 772, w: 300, h: 22 };
  const INK_Y = 420;
  const TEXT_BOX = { x: 100, y: 470, w: 320, h: 40 };

  /** The mounted PDF editor, mounting one on form_acro.pdf when there is none. */
  const ensureEditor = async (): Promise<PdfEditorDev> => {
    const up = pdfEdDev();
    if (up && $(".pdfed") && currentSession.get() === up.session) return up;
    await backHome();
    const src = fx("form_acro.pdf");
    const stat = await ipc.fileStat(src);
    assert(stat !== null, "form_acro.pdf could not be stat'ed");
    const { countPages } = await import("../pdf/view/loader");
    const { createPdfProject } = await import("../core/pdf-project");
    const pages = await countPages(src);
    const project = createPdfProject("Autotest PDF form", { path: src, size: stat!.size, mtimeMs: stat!.mtimeMs, pages });
    edPath = await ipc.tempProjectPath("Autotest PDF form");
    await ipc.saveProject(edPath, project);
    const prev = pdfEdDev();
    navigate({ view: "editor", projectPath: edPath, temp: true });
    const dev = await until(
      () => {
        const d = pdfEdDev();
        return d && d !== prev && $(".pdfed") && $("#ed-save") ? d : null;
      },
      8_000,
      () => `the PDF editor on form_acro.pdf — ${onScreen()}`,
    );
    noteImageEditor();
    return dev;
  };
  const tearDownEditor = async (): Promise<void> => {
    await backHome();
    if (edPath) await ipc.deleteProject(edPath).catch(() => {});
    edPath = "";
  };
  const firstPageId = (d: PdfEditorDev): string => d.session.project.pdf!.pages[0]!.id;
  /** A point in page space → client px (null: page not rendered). */
  const toClient = (d: PdfEditorDev, key: string, x: number, y: number): { x: number; y: number } | null =>
    d.view.pageToClient(key, x, y);

  await test("pdf-project-roundtrip", async () => {
    const t0 = performance.now();
    const restore: (() => void)[] = [];
    try {
      needFixtures();
      const d = await ensureEditor();
      const stage = $("#pdfed-stage");
      assert(rendered(stage), "#pdfed-stage is not rendered");
      const key = firstPageId(d);
      const canvas = await until(() => inkedCanvas(stage!, key), 6_000, () => `the editor's page 1 canvas with ink — canvases ${$$("#pdfed-stage canvas.pdfv-canvas").length}`);

      // Three marks through the session, the way the tools commit them.
      const { addAnnot, newId } = await import("../pdf/model");
      const { encodePoints } = await import("../image/strokes");
      placed.ink = newId();
      placed.text = newId();
      placed.hl = newId();
      const ink: PdfAnnot = {
        id: placed.ink, t: "ink", kind: "pen", c: "#000000", w: 8, o: 1,
        p: encodePoints(new Float32Array([100, INK_Y, 1, 175, INK_Y, 1, 250, INK_Y, 1, 325, INK_Y, 1, 400, INK_Y, 1])),
      };
      const box: PdfAnnot = {
        id: placed.text, t: "text", ...TEXT_BOX, text: HEBREW,
        font: "Arial", size: 18, c: "#1a1a1a", bold: false, italic: false, align: "left",
      };
      const hl: PdfAnnot = { id: placed.hl, t: "highlight", c: "#ffd400", o: 0.4, rects: [[55, 64, 50, 22]] };
      d.session.commit((p) => addAnnot(addAnnot(addAnnot(p, key, ink), key, box), key, hl));
      const annots = d.session.project.pdf!.annots[key] ?? [];
      assert(annots.length === 3, `the session holds ${annots.length} marks on page 1, not 3`);

      // Their SVG nodes, in the page's overlay.
      d.view.reveal(key, [100, 400, 320, 110]);
      const overlay = d.view.overlay(key);
      assert(overlay !== null, "page 1 has no overlay");
      const node = (id: string): SVGElement | null => overlay!.querySelector<SVGElement>(`.pdfmk-marks [data-id="${id}"]`);
      await until(() => node(placed.ink) && node(placed.text) && node(placed.hl), 3_000, () => `the three mark nodes in page 1's overlay (got ${overlay!.querySelectorAll(".pdfmk-marks [data-id]").length})`);
      await frames(2);

      // Painted where they belong: each node's client box against the view's
      // own page→client mapping (the mark layer opts out of hit testing).
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
      const boxCheck = (id: string, bx: number, by: number, bw: number, bh: number, what: string): string => {
        const r = node(id)!.getBoundingClientRect();
        const tl = toClient(d, key, bx, by);
        const br = toClient(d, key, bx + bw, by + bh);
        assert(tl !== null && br !== null, `${what}: page 1 is not mapped`);
        const ok = near(r.left, tl!.x) && near(r.top, tl!.y) && near(r.right, br!.x) && near(r.bottom, br!.y);
        assert(ok, `${what} is drawn at ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}, the page maps it to ${Math.round(tl!.x)},${Math.round(tl!.y)}–${Math.round(br!.x)},${Math.round(br!.y)}`);
        return `${Math.round(r.width)}x${Math.round(r.height)}`;
      };
      const textGeom = boxCheck(placed.text, TEXT_BOX.x, TEXT_BOX.y, TEXT_BOX.w, TEXT_BOX.h, "the text box");
      const hlGeom = boxCheck(placed.hl, 55, 64, 50, 22, "the highlight");
      const textNode = node(placed.text)!;
      assert(textNode.textContent?.includes("שלום") === true, `the text box shows "${textNode.textContent}", not the Hebrew`);

      // Paint order: the layer is pointer-events:none on purpose, so each mark
      // is opted into hit testing for the probe alone (put back in finally).
      // The text box must then be the top element over its own box, and the
      // ink path must be hit ON its stroke and NOT 30 pt below it — an SVG
      // path is hit only where it paints.
      const optIn = (el: SVGElement): void => {
        const was = el.style.pointerEvents;
        el.style.pointerEvents = "auto";
        restore.push(() => {
          el.style.pointerEvents = was;
        });
      };
      optIn(textNode);
      optIn(node(placed.ink)!);
      const tc = toClient(d, key, TEXT_BOX.x + 160, TEXT_BOX.y + 10)!;
      const tHit = document.elementFromPoint(tc.x, tc.y);
      assert(tHit !== null && textNode.contains(tHit), `the text box's first line shows ${describeEl(tHit)}, not the text mark`);
      const on = toClient(d, key, 250, INK_Y)!;
      const off = toClient(d, key, 250, INK_Y + 30)!;
      const inkNode = node(placed.ink)!;
      const onHit = document.elementFromPoint(on.x, on.y);
      const offHit = document.elementFromPoint(off.x, off.y);
      assert(onHit === inkNode, `on the pen stroke the hit is ${describeEl(onHit)}, not the ink path`);
      assert(offHit !== inkNode, "30 pt below the pen stroke still hits the ink path — it paints where it shouldn't");
      for (const f of restore.splice(0)) f();

      // Save, read back from disk, compare.
      await d.session.save();
      const loaded = await ipc.loadProject(d.session.path);
      const back = loaded.project.pdf?.annots[key] ?? [];
      const byId = new Map(back.map((a) => [a.id, a]));
      const bInk = byId.get(placed.ink);
      const bText = byId.get(placed.text);
      const bHl = byId.get(placed.hl);
      assert(bInk?.t === "ink" && bInk.p === (ink as { p: string }).p && bInk.w === 8, `the pen mark did not survive the round trip (${JSON.stringify(bInk)?.slice(0, 120)})`);
      assert(bText?.t === "text" && bText.text === HEBREW && bText.x === TEXT_BOX.x && bText.font === "Arial", `the text box did not survive the round trip (${JSON.stringify(bText)?.slice(0, 160)})`);
      assert(bHl?.t === "highlight" && JSON.stringify(bHl.rects) === JSON.stringify([[55, 64, 50, 22]]), `the highlight did not survive the round trip (${JSON.stringify(bHl)})`);
      return `editor up, page 1 canvas ${canvas.width}x${canvas.height} (${inkPixels(canvas)} ink px); 3 marks committed, nodes in the overlay at the page's own mapping (text ${textGeom}, highlight ${hlGeom}); hit tests: text box → ${describeEl(tHit)}, on the stroke → path, 30 pt below → ${describeEl(offHit)}; saved + loadProject: ink/text("${HEBREW}")/highlight identical — ${ms(t0)}`;
    } finally {
      for (const f of restore.splice(0)) f();
      // The editor stays up for the next three blocks.
    }
  });

  await test("pdf-fill-forms", async () => {
    const t0 = performance.now();
    let switched = false;
    try {
      needFixtures();
      const d = await ensureEditor();
      const key = firstPageId(d);
      const srcId = d.session.project.pdf!.sources[0]!.id;
      await until(() => d.ctx.hasForms.get() || null, 4_000, () => "form_acro.pdf to be detected as fillable (hasForms)");
      const sw = $<HTMLInputElement>("#pdfed-fill-forms");
      const label = sw?.closest("label") ?? null;
      await until(() => rendered(label) || null, 1_000, () => "the Fill forms switch to show");
      const lHit = hitAtCentreOf(label!);
      assert(lHit !== null && label!.contains(lHit), `the Fill forms switch's centre shows ${describeEl(lHit)}`);
      d.view.reveal(key, [NAME_FIELD.x, NAME_FIELD.y, NAME_FIELD.w, NAME_FIELD.h]);
      sw!.click();
      switched = true;
      assert(d.ctx.mode.get() === "forms", `the switch was clicked but the mode is "${d.ctx.mode.get()}"`);

      const field = await until(() => {
        const i = $<HTMLInputElement>(`#pdfed-stage .annotationLayer [data-element-id="9R"]`);
        return i && rendered(i) ? i : null;
      }, 4_000, () => `the "name" widget (9R) as an input — widgets: ${$$("#pdfed-stage .annotationLayer [data-element-id]").map((e) => e.getAttribute("data-element-id")).join(",") || "none"}`);
      const fHit = hitAtCentreOf(field);
      assert(fHit === field, `the name field's centre shows ${describeEl(fHit)} — the widget is covered`);
      field.focus();
      field.value = TYPED;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: TYPED }));
      const { formValue } = await import("../pdf/model");
      await until(() => formValue(d.session.project, srcId, "9R") === TYPED || null, 2_000, () => `the project to hold "${TYPED}" for 9R (holds ${JSON.stringify(formValue(d.session.project, srcId, "9R"))})`);
      field.blur();

      // Off: the widgets go inert — at the field's place the hit is not a form control.
      sw!.click();
      switched = false;
      assert(d.ctx.mode.get() === "annotate", `the switch was clicked off but the mode is "${d.ctx.mode.get()}"`);
      const c = toClient(d, key, NAME_FIELD.x + NAME_FIELD.w / 2, NAME_FIELD.y + NAME_FIELD.h / 2);
      assert(c !== null, "page 1 is not mapped");
      const after = await until(() => {
        const h = document.elementFromPoint(c!.x, c!.y);
        return h && !h.closest("input, textarea, select") ? h : null;
      }, 3_000, () => `the name field to go inert (hit: ${describeEl(document.elementFromPoint(c!.x, c!.y))})`);
      assert(formValue(d.session.project, srcId, "9R") === TYPED, "turning Fill forms off lost the typed value");
      return `hasForms → switch shown and on top; on: 9R is an input on top, an InputEvent stored "${TYPED}" in the project; off: the field's place hits ${describeEl(after)}, value kept — ${ms(t0)}`;
    } finally {
      if (switched) $<HTMLInputElement>("#pdfed-fill-forms")?.click();
    }
  });

  await test("pdf-export", async () => {
    const t0 = performance.now();
    const outs: string[] = [];
    const opened: PdfDoc[] = [];
    try {
      needFixtures();
      const d = await ensureEditor();
      const key = firstPageId(d);
      const srcId = d.session.project.pdf!.sources[0]!.id;
      // Block 5/6 may not have run (or failed): put back what this one checks.
      const { addAnnot, newId, pageAnnots, setFormValue, formValue } = await import("../pdf/model");
      if (!pageAnnots(d.session.project, key).some((a) => a.t === "ink" && a.id === placed.ink)) {
        const { encodePoints } = await import("../image/strokes");
        placed.ink = newId();
        placed.text = newId();
        placed.hl = newId();
        d.session.commit((p) =>
          addAnnot(
            addAnnot(
              addAnnot(p, key, { id: placed.ink, t: "ink", kind: "pen", c: "#000000", w: 8, o: 1, p: encodePoints(new Float32Array([100, INK_Y, 1, 250, INK_Y, 1, 400, INK_Y, 1])) }),
              key,
              { id: placed.text, t: "text", ...TEXT_BOX, text: HEBREW, font: "Arial", size: 18, c: "#1a1a1a", bold: false, italic: false, align: "left" },
            ),
            key,
            { id: placed.hl, t: "highlight", c: "#ffd400", o: 0.4, rects: [[55, 64, 50, 22]] },
          ),
        );
      }
      if (formValue(d.session.project, srcId, "9R") !== TYPED) d.session.commit((p) => setFormValue(p, srcId, "9R", TYPED));

      const dir = await scratchDir();
      const stamp = Date.now().toString(36);
      const keepPath = `${dir}\\autotest-pdf-${stamp}-marks.pdf`;
      const flatPath = `${dir}\\autotest-pdf-${stamp}-flat.pdf`;
      outs.push(keepPath, flatPath);
      const { exportPdf } = await import("../pdf/export/export");
      const project = d.session.project;
      const t1 = performance.now();
      const a = await exportPdf(project, { flattenMarks: false, flattenForms: false }, keepPath).catch((e: unknown) => {
        throw new Error(`export (marks as annotations) failed: ${errorDetail(e).message}`);
      });
      const b = await exportPdf(project, { flattenMarks: true, flattenForms: true }, flatPath).catch((e: unknown) => {
        throw new Error(`export (flattened) failed: ${errorDetail(e).message}`);
      });
      const exportMs = Math.round(performance.now() - t1);

      const { openPdf } = await import("../pdf/view");
      const { loadPdfjs } = await import("../pdf/view/pdfjs");
      const pdfjs = await loadPdfjs();
      const keep = await openPdf("autotest-out-a", a.path);
      opened.push(keep);
      const flat = await openPdf("autotest-out-b", b.path);
      opened.push(flat);
      const kp = keep.doc as PdfProxyLite;
      const fp = flat.doc as PdfProxyLite;
      assert(kp.numPages === 1 && fp.numPages === 1, `the outputs have ${kp.numPages} and ${fp.numPages} pages, not 1`);

      // Kept as annotations: the three subtypes, and the typed value in the field.
      const kAnn = await (await kp.getPage(1)).getAnnotations();
      const subtypes = kAnn.map((x) => x.subtype ?? "?");
      for (const want of ["Ink", "FreeText", "Highlight"]) {
        assert(subtypes.includes(want), `the export has no ${want} annotation (subtypes: ${subtypes.join(", ")})`);
      }
      const kFields = await kp.getFieldObjects();
      // pdf.js lists a field's parent (no value, page -1) before its widgets.
      const nameVal = fieldOf(kFields, "name")?.find((f) => f.value !== undefined)?.value;
      assert(nameVal === TYPED, `the export's "name" field holds ${JSON.stringify(nameVal)}, not "${TYPED}"`);

      // Flattened: no marks, no widgets, no fields left.
      const fAnn = await (await fp.getPage(1)).getAnnotations();
      const left = fAnn.map((x) => x.subtype ?? "?").filter((s) => ["Ink", "FreeText", "Highlight", "Widget"].includes(s));
      assert(left.length === 0, `the flattened export still carries annotations: ${left.join(", ")}`);
      const fFields = await fp.getFieldObjects();
      const fieldCount = fieldCountOf(fFields);
      assert(fieldCount === 0, `the flattened export still has ${fieldCount} form field(s)`);

      // Pixels with annotations NOT drawn: in the flattened file the pen
      // stroke is page content, in the other it exists only as an annotation.
      const paint = async (p: PdfProxyLite): Promise<HTMLCanvasElement> => {
        const page = await p.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await page.render({ canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE, background: "#ffffff" }).promise;
        page.cleanup();
        return c;
      };
      const kc = await paint(kp);
      const fc = await paint(fp);
      const kInk = darkestAround(kc, 250, INK_Y);
      const fInk = darkestAround(fc, 250, INK_Y);
      const fBlank = darkestAround(fc, 250, INK_Y + 30);
      assert(kInk > 200, `the unflattened page content is dark (${kInk}) at the pen stroke — the mark was drawn into the page`);
      assert(fInk < 90, `the flattened page shows luminance ${fInk} at the pen stroke — the mark is not in the page content`);
      assert(fBlank > 200, `the flattened page is dark (${fBlank}) 30 pt below the stroke`);
      const fText = inkPixelsIn(fc, TEXT_BOX.x, TEXT_BOX.y, TEXT_BOX.w, TEXT_BOX.h);
      const kText = inkPixelsIn(kc, TEXT_BOX.x, TEXT_BOX.y, TEXT_BOX.w, TEXT_BOX.h);
      assert(fText > kText + 20, `the text box area gained no ink when flattened (${kText} → ${fText} px)`);
      kc.width = fc.width = 0;
      return `exported in ${exportMs} ms (${a.bytes} + ${b.bytes} bytes): kept → 1 page, annotations ${subtypes.join("/")}, name = "${nameVal}"; flattened → 1 page, no marks/widgets, 0 fields; rendered with annotations off: stroke luminance ${kInk} (kept) vs ${fInk} (flat), text box ink ${kText} → ${fText} px — ${ms(t0)}`;
    } finally {
      for (const doc of opened) await doc.destroy().catch(() => {});
      for (const p of outs) await removeTestFile(p).catch(() => {});
    }
  });

  await test("pdf-page-ops", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      const d = await ensureEditor();
      const s = d.session;
      const before = s.project.pdf!.pages;
      const beforeJson = JSON.stringify(before);
      const p1 = before[0]!.id;
      const count = (): number => $$("#pdfed-pages .pdfv-thumb").length;
      const slot = (key: string): HTMLElement | null => $(`#pdfed-stage .pdfv-page[data-key="${key}"]`);
      const aspect = (key: string): number => {
        const r = slot(key)?.getBoundingClientRect();
        return r && r.height > 0 ? r.width / r.height : 0;
      };
      assert(before.length === 1, `form_acro.pdf should be one page, the project has ${before.length}`);
      await until(() => count() === 1 && text("#pdfed-page-count") === "/ 1", 2_000, () => `1 thumbnail and "/ 1" (got ${count()}, "${text("#pdfed-page-count")}")`);
      d.view.scrollToPage(0);
      const a0 = await until(() => aspect(p1) || null, 2_000, () => "page 1's slot");
      assert(a0 < 1, `page 1 (A4 portrait) shows ${a0.toFixed(2)} wide per tall`);

      const { insertBlankPage, rotatePages, reorderPages } = await import("../pdf/model");
      s.commit((p) => insertBlankPage(p, 1, 400, 300));
      s.commit((p) => rotatePages(p, [p1], 90));
      s.commit((p) => reorderPages(p, [...p.pdf!.pages].reverse().map((pg) => pg.id)));
      const mid = s.project.pdf!.pages;
      assert(mid.length === 2 && mid[1]!.id === p1 && mid[1]!.rotate === 90 && mid[0]!.src === null, `after insert/rotate/reorder the pages are ${JSON.stringify(mid.map((pg) => ({ src: pg.src, rotate: pg.rotate })))}`);
      await until(() => count() === 2 && text("#pdfed-page-count") === "/ 2", 2_000, () => `2 thumbnails and "/ 2" (got ${count()}, "${text("#pdfed-page-count")}")`);
      d.view.scrollToPage(1);
      const turned = await until(() => (aspect(p1) > 1 ? aspect(p1) : null), 3_000, () => `page 1's slot to turn landscape (aspect ${aspect(p1).toFixed(2)})`);

      // Undo ×3 through the editor's own button.
      const undoBtn = $<HTMLButtonElement>("#pdfed-undo")!;
      for (let i = 0; i < 3; i++) {
        assert(rendered(undoBtn) && !undoBtn.disabled, `the Undo button is ${undoBtn.disabled ? "disabled" : "not rendered"} at step ${i + 1}`);
        undoBtn.click();
      }
      assert(JSON.stringify(s.project.pdf!.pages) === beforeJson, `after three undos the pages are ${JSON.stringify(s.project.pdf!.pages.map((pg) => ({ id: pg.id, rotate: pg.rotate })))}`);
      await until(() => count() === 1 && text("#pdfed-page-count") === "/ 1", 2_000, () => `back to 1 thumbnail and "/ 1" (got ${count()}, "${text("#pdfed-page-count")}")`);
      d.view.scrollToPage(0);
      const back = await until(() => (aspect(p1) > 0 && aspect(p1) < 1 ? aspect(p1) : null), 3_000, () => `page 1's slot back to portrait (aspect ${aspect(p1).toFixed(2)})`);
      return `insert blank + rotate p1 + reorder → 2 pages ("/ 2", 2 thumbs), p1's slot ${a0.toFixed(2)} → ${turned.toFixed(2)} wide/tall; Undo ×3 (button) → pages identical, "/ 1", 1 thumb, slot ${back.toFixed(2)} — ${ms(t0)}`;
    } finally {
      await tearDownEditor();
    }
  });

  await test("pdf-no-image-chunk", async () => {
    // WEAK BY POSITION, and says so: the image blocks ran first, so the image
    // editor's modules are already loaded and could not be fetched again. What
    // CAN be checked: no PDF block mounted the image editor, and no /src/image/
    // module that had not loaded yet appeared during them beyond the two the
    // PDF code imports on purpose (shell.ts → image/icons, model.ts → image/strokes).
    noteImageEditor();
    assert(!imageEditorSeen, "a PDF block had the image editor mounted");
    const fresh = resources()
      .filter((n) => n.includes("/src/image/") && !imageResBefore.has(n))
      .map((n) => n.split("?")[0]!)
      .filter((n) => !/\/src\/image\/(icons|strokes)\.ts$/.test(n));
    assert(fresh.length === 0, `PDF blocks fetched image-editor modules: ${fresh.map(baseName).join(", ")}`);
    return "no PDF block mounted the image editor and no new /src/image/ module beyond icons/strokes was fetched (weak: the image chunk was already loaded by the earlier image blocks)";
  });

  /* ================================================================ */
  /* Volume to 500%                                                    */
  /* ================================================================ */

  await test("volume-500", async () => {
    const t0 = performance.now();
    let path = "";
    let dev: VideoDev | undefined;
    try {
      needFixtures();
      const info = await ipc.probeMedia(`${fixturesDir}\\counter_audio_h264.mp4`);
      assert(info.hasAudio, "counter_audio_h264.mp4 must carry audio");
      const r = importMediaAsClip(createProject("Autotest volume"), info);
      path = await ipc.tempProjectPath("Autotest volume");
      await ipc.saveProject(path, r.project);
      const prev = videoDev();
      navigate({ view: "editor", projectPath: path, temp: true });
      dev = await until(() => {
        const h = videoDev();
        return h && h !== prev && $(".editor") && !$(".pdfed") && !$(".imged") && $("#ed-save") ? h : null;
      }, 8_000, () => `the video editor — ${onScreen()}`);
      const d = dev;
      const s = d.session;
      const clipId = r.clipId;
      await until(() => d.media.status.get()[r.mediaId]?.state === "ready" || null, 10_000, () => `the clip's media to be ready (${d.media.status.get()[r.mediaId]?.state ?? "no status"})`);
      d.timeline.select(clipId);

      const slider = await until(() => {
        const f = $$("#ed-inspector .insp-field").find((x) => x.querySelector("label")?.textContent?.trim() === "Volume");
        const i = f?.querySelector<HTMLInputElement>('input[type="range"]');
        return i && rendered(i) ? { field: f!, input: i } : null;
      }, 2_000, () => `the inspector's Volume slider (fields: ${$$("#ed-inspector .insp-field label").map((l) => l.textContent?.trim()).join(", ") || "none"})`);
      assert(slider.input.max === "200", `the Volume track runs to ${slider.input.max}, not 200 (VOLUME_SCALE.posMax)`);
      // The slider's own path: focus (begin), input, change (commit).
      slider.input.focus();
      slider.input.value = slider.input.max;
      slider.input.dispatchEvent(new Event("input", { bubbles: true }));
      slider.input.dispatchEvent(new Event("change", { bubbles: true }));
      slider.input.blur();
      const { findClip } = await import("../core/project");
      await until(() => findClip(s.project, clipId)?.clip.audio.volume === 5 || null, 1_000, () => `the clip's volume to be 5 (is ${findClip(s.project, clipId)?.clip.audio.volume})`);

      // Rebuilt after the commit: read the live controls again.
      const f2 = $$("#ed-inspector .insp-field").find((x) => x.querySelector("label")?.textContent?.trim() === "Volume")!;
      const readout = f2.querySelector<HTMLElement>(".insp-slider__value");
      const range = f2.querySelector<HTMLInputElement>('input[type="range"]')!;
      assert(rendered(readout) && readout!.textContent?.trim() === "500%", `the readout says "${readout?.textContent?.trim()}", not "500%"`);
      assert(Number(range.value) === Number(range.max), `the thumb sits at ${range.value} of ${range.max}, not the right end`);

      // The audio graph: the clip's element gain follows the envelope to 5.
      const running = await d.audioGraph.devEnsureRunning();
      // AGENTS.md "E2E lesson": under autotest master is not connected to the
      // speakers, and only the analyser tap pulls the graph — without it the
      // element's clock freezes and the clip's gain is never driven.
      d.audioGraph.devMasterAnalyser();
      d.engine.seek(1);
      await sleep(150);
      d.engine.play();
      let gain = 0;
      let el: HTMLVideoElement | null = null;
      const deadline = performance.now() + 3_000;
      while (performance.now() < deadline) {
        el = d.scheduler.activeVideoInfos()[0]?.el ?? null;
        if (el) {
          gain = d.audioGraph.devVideoGainValue(el);
          if (Math.abs(gain - 5) < 0.01) break;
        }
        await sleep(30);
      }
      d.engine.pause();
      assert(el !== null, "no active video element over the clip while playing");
      assert(d.audioGraph.devVideoWired(el!), "the clip's <video> is not routed through the audio graph");
      if (running) assert(Math.abs(gain - 5) < 0.01, `the clip's gain node reads ${gain.toFixed(3)}, not 5`);
      return `slider to the right end → project volume 5, readout "500%", thumb ${range.value}/${range.max}; ${running ? `gain node ${gain.toFixed(3)} while playing (ctx running)` : `ctx suspended — gain NOT measured (read ${gain.toFixed(3)})`} — ${ms(t0)}`;
    } finally {
      try {
        dev?.engine.pause();
      } catch {
        // gone with the editor
      }
      await backHome();
      if (path) await ipc.deleteProject(path).catch(() => {});
    }
  });

  /* ================================================================ */
  /* One shortcut row back to its default                             */
  /* ================================================================ */

  await test("shortcut-reset-row", async () => {
    const t0 = performance.now();
    const before = settingsStore.get().shortcuts;
    const ACTION: ActionId = "find";
    const CHORD = "Ctrl+Alt+F9";
    try {
      const { DEFAULT_SHORTCUTS } = await import("../core/types");
      const def = DEFAULT_SHORTCUTS[ACTION];
      if (before[ACTION] !== def) await updateSettings({ shortcuts: { ...before, [ACTION]: def } });
      navigate({ view: "settings" });
      await until(() => $(`.settings__shortcut[data-action="${ACTION}"]`), 5_000, () => `the "${ACTION}" shortcut row — ${onScreen()}`);
      assert(!$(`[data-reset-action="${ACTION}"]`), "the ↺ shows on a row that is at its default");

      await updateSettings({ shortcuts: { ...settingsStore.get().shortcuts, [ACTION]: CHORD } });
      await settingsWritesSettled();
      const btn = await until(() => $<HTMLButtonElement>(`[data-reset-action="${ACTION}"]`), 2_000, () => "the ↺ on the rebound row");
      btn.scrollIntoView({ block: "center" });
      await frames(2);
      const hit = hitAtCentreOf(btn);
      assert(hit !== null && btn.contains(hit), `the ↺'s centre shows ${describeEl(hit)}, not the button`);
      const row = $(`.settings__shortcut[data-action="${ACTION}"]`)!;
      assert(row.textContent?.includes("F9") === true, `the row does not show the new chord ("${row.textContent?.trim()}")`);
      btn.click();
      await until(() => settingsStore.get().shortcuts[ACTION] === def || null, 2_000, () => `"${ACTION}" back to ${def} (is ${settingsStore.get().shortcuts[ACTION]})`);
      await settingsWritesSettled();
      await until(() => !$(`[data-reset-action="${ACTION}"]`) || null, 2_000, () => "the ↺ to go");
      const others = Object.keys(before).filter((k) => k !== ACTION && settingsStore.get().shortcuts[k as ActionId] !== before[k as ActionId]);
      assert(others.length === 0, `the row's reset changed other bindings: ${others.join(", ")}`);
      return `"${ACTION}" rebound to ${CHORD} → ↺ on its row, on top (hit ${describeEl(hit)}); clicked → back to ${def}, ↺ gone, no other binding touched — ${ms(t0)}`;
    } finally {
      try {
        if (JSON.stringify(settingsStore.get().shortcuts) !== JSON.stringify(before)) await updateSettings({ shortcuts: before });
        await settingsWritesSettled();
      } catch {
        // a failed write must not mask the block's own result
      }
      await backHome();
    }
  });

  /* ================================================================ */
  /* The thumbnail of a recording with a damaged start                */
  /* ================================================================ */

  await test("damaged-thumb", async () => {
    const t0 = performance.now();
    const img = new Image();
    let timer = 0;
    try {
      needFixtures();
      const path = `${fixturesDir}\\damaged_h264.mp4`;
      const st = await ipc.fileStat(path);
      assert(st !== null, "damaged_h264.mp4 could not be stat'ed");
      const key = { path, size: st!.size, mtimeMs: st!.mtimeMs };
      // Home/editor ask at min(0.5, duration / 2): inside the damage. A thumb
      // cached by an earlier run would answer without making one, so the
      // first answer is deleted and the second must be MADE.
      const first = await ipc.getThumbnail(key, 0.5).catch((e: unknown) => {
        throw new Error(`get_thumbnail failed: ${errorDetail(e).message}`);
      });
      await removeTestFile(first).catch(() => {});
      assert(!(await ipc.pathExists(first)), `the cached thumbnail could not be removed: ${first}`);
      const t1 = performance.now();
      const made = await ipc.getThumbnail(key, 0.5).catch((e: unknown) => {
        throw new Error(`get_thumbnail failed on a fresh make: ${errorDetail(e).message}`);
      });
      const makeMs = Math.round(performance.now() - t1);
      const fst = await ipc.fileStat(made);
      assert(fst !== null && fst.size > 0, `the thumbnail ${made} is ${fst ? "empty" : "missing"}`);
      img.src = mediaUrl(made);
      const decoding = img.decode();
      decoding.catch(() => {});
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("timed out decoding the thumbnail")), 4_000);
      });
      await Promise.race([decoding, timeout]);
      assert(img.naturalWidth > 0 && img.naturalHeight > 0, "the thumbnail does not decode to a picture");
      return `damaged_h264.mp4 at 0.5 s (inside the damage): cached copy removed, made again in ${makeMs} ms → ${baseName(made)}, ${fst!.size} bytes, decodes ${img.naturalWidth}x${img.naturalHeight} — ${ms(t0)}`;
    } finally {
      clearTimeout(timer);
      img.removeAttribute("src");
    }
  });

  // Safety net: whatever a failed block left, the Home blocks start on Home.
  if (edPath) await tearDownEditor();
  if (!$(".home")) await backHome();
}

/** Ink pixels inside a page-space box of a scale-1 page render. */
function inkPixelsIn(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const d = g.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.min(d[i]!, d[i + 1]!, d[i + 2]!) < 160) n++;
  return n;
}
