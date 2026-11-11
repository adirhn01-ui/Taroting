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
import { currentSession, normalizeHexColor, settingsStore, settingsWritesSettled, updateSettings, type ProjectSession } from "../core/session";
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
      // The switch lives in the right panel's Document section: Select tool,
      // nothing selected.
      d.ctx.selection.set([]);
      d.ctx.pageSelection.set([]);
      d.ctx.tools.update((t) => (t.tool === "select" ? t : { ...t, tool: "select" }));
      const sw = await until(() => {
        const i = $<HTMLInputElement>("#pdfed-fill-forms");
        return i && rendered(i.closest(".insp-field")) && !i.disabled ? i : null;
      }, 2_000, () => "the Fill forms switch to show, enabled, in the right panel");
      const label = sw.closest(".insp-field") as HTMLElement;
      const lHit = hitAtCentreOf(sw);
      assert(lHit !== null && label.contains(lHit), `the Fill forms switch's centre shows ${describeEl(lHit)}`);
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
      // The panel rebuilt when the mode changed: the live switch, not the one clicked on.
      const swOff = await until(() => {
        const i = $<HTMLInputElement>("#pdfed-fill-forms");
        return i && i.isConnected && rendered(i.closest(".insp-field")) ? i : null;
      }, 2_000, () => "the Fill forms switch in Fill forms mode");
      assert(hitAtCentreOf(swOff) !== null && swOff.closest(".insp-field")!.contains(hitAtCentreOf(swOff)), "the Fill forms switch is covered in Fill forms mode");
      swOff.click();
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

  // 0.9.4: the two panel toggles, on the shared editor. form_acro.pdf is one
  // page, so two blank A4 pages are added for the block (undone in finally)
  // and the strip parked on the middle one: "the current page is unchanged"
  // must be able to fail. Geometry is read off the screen, never a class.
  await test("pdf-panels-collapse", async () => {
    const t0 = performance.now();
    let added = 0;
    let s: ProjectSession | null = null;
    const press = (chord: "F4" | "Shift+F4"): void => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", code: "F4", shiftKey: chord === "Shift+F4", bubbles: true, cancelable: true }));
    };
    try {
      needFixtures();
      const d = await ensureEditor();
      s = d.session;
      const sc = settingsStore.get().shortcuts;
      assert(sc.pdfPages === "F4" && sc.pdfProperties === "Shift+F4", `the run's shortcuts are pdfPages "${sc.pdfPages}", pdfProperties "${sc.pdfProperties}", not the defaults F4 / Shift+F4`);
      const stage = $("#pdfed-stage")!;
      const insp = $("#pdfed-inspector")!;
      const pages = $("#pdfed-pages")!;
      const inspBtn = $<HTMLButtonElement>("#pdfed-insp-toggle");
      const railBtn = $<HTMLButtonElement>("#pdfed-rail-toggle");
      assert(rendered(inspBtn) && rendered(railBtn), `the toggles are not both rendered (properties ${rendered(inspBtn)}, pages ${rendered(railBtn)})`);
      // An earlier failure may have left one shut: start from both open.
      if (!rendered(insp)) inspBtn!.click();
      if (!rendered(pages)) railBtn!.click();
      assert(rendered(insp) && rendered(pages), `the panels do not start open (properties ${insp.getClientRects().length} rects, pages ${pages.getClientRects().length} rects)`);

      const { insertBlankPage } = await import("../pdf/model");
      for (const at of [1, 2]) {
        const before = s.project;
        s.commit((p) => insertBlankPage(p, at, 595.28, 841.89));
        if (s.project !== before) added++;
      }
      assert(added === 2, `only ${added} of 2 blank pages could be added`);
      await until(() => text("#pdfed-page-count") === "/ 3" || null, 2_000, () => `"/ 3" in the page box (shows "${text("#pdfed-page-count")}")`);
      d.view.scrollToPage(1);
      await until(() => d.view.state.get().current === 1 || null, 2_000, () => `the strip on page 2 (current slot ${d.view.state.get().current})`);
      await frames(2);
      const settle = async (): Promise<void> => {
        // the strip re-lays out from its ResizeObserver, a frame after the width change
        await frames(3);
      };
      const w = (e: Element): number => e.getBoundingClientRect().width;

      // Properties, by the button.
      const stage0 = w(stage);
      const insp0 = w(insp);
      const cur0 = d.view.state.get().current;
      inspBtn!.click();
      await settle();
      const stage1 = w(stage);
      const cur1 = d.view.state.get().current;
      assert(insp.getClientRects().length === 0, `after the properties toggle the inspector still has ${insp.getClientRects().length} client rects (${w(insp)} px wide)`);
      assert(Math.abs(stage1 - stage0 - insp0) <= 4, `the stage went ${stage0.toFixed(1)} → ${stage1.toFixed(1)} px (+${(stage1 - stage0).toFixed(1)}), the inspector was ${insp0.toFixed(1)} px`);
      assert(cur1 === cur0, `the current page went from slot ${cur0} to ${cur1} when the inspector collapsed`);
      assert(inspBtn!.getAttribute("aria-pressed") === "false", `the properties toggle reads aria-pressed "${inspBtn!.getAttribute("aria-pressed")}" while collapsed`);
      // Back, by Shift+F4.
      press("Shift+F4");
      await settle();
      const stage2 = w(stage);
      const cur2 = d.view.state.get().current;
      assert(rendered(insp) && Math.abs(w(insp) - insp0) <= 1, `after Shift+F4 the inspector is ${rendered(insp) ? `${w(insp).toFixed(1)} px wide` : "still not rendered"} (was ${insp0.toFixed(1)})`);
      assert(Math.abs(stage2 - stage0) <= 1, `after Shift+F4 the stage is ${stage2.toFixed(1)} px, was ${stage0.toFixed(1)}`);
      assert(cur2 === cur0, `the current page went from slot ${cur0} to ${cur2} when the inspector came back`);

      // Pages, by the button, then F4.
      const pages0 = w(pages);
      railBtn!.click();
      await settle();
      const stage3 = w(stage);
      const cur3 = d.view.state.get().current;
      assert(pages.getClientRects().length === 0, `after the pages toggle the rail still has ${pages.getClientRects().length} client rects (${w(pages)} px wide)`);
      assert(Math.abs(stage3 - stage0 - pages0) <= 4, `the stage went ${stage0.toFixed(1)} → ${stage3.toFixed(1)} px (+${(stage3 - stage0).toFixed(1)}), the rail was ${pages0.toFixed(1)} px`);
      assert(cur3 === cur0, `the current page went from slot ${cur0} to ${cur3} when the rail collapsed`);
      press("F4");
      await settle();
      const stage4 = w(stage);
      const cur4 = d.view.state.get().current;
      assert(rendered(pages) && Math.abs(w(pages) - pages0) <= 1, `after F4 the rail is ${rendered(pages) ? `${w(pages).toFixed(1)} px wide` : "still not rendered"} (was ${pages0.toFixed(1)})`);
      assert(Math.abs(stage4 - stage0) <= 1, `after F4 the stage is ${stage4.toFixed(1)} px, was ${stage0.toFixed(1)}`);
      assert(cur4 === cur0, `the current page went from slot ${cur0} to ${cur4} when the rail came back`);
      return `on page ${cur0 + 1} of 3: properties button → inspector 0 rects, stage ${stage0.toFixed(1)} → ${stage1.toFixed(1)} px (inspector was ${insp0.toFixed(1)}), Shift+F4 → ${stage2.toFixed(1)}; pages button → stage ${stage3.toFixed(1)} (rail was ${pages0.toFixed(1)}), F4 → ${stage4.toFixed(1)}; current page held throughout — ${ms(t0)}`;
    } finally {
      // Both panels open again, and the two blank pages gone, for the next block.
      if (!rendered($("#pdfed-inspector"))) $<HTMLButtonElement>("#pdfed-insp-toggle")?.click();
      if (!rendered($("#pdfed-pages"))) $<HTMLButtonElement>("#pdfed-rail-toggle")?.click();
      if (s && currentSession.get() === s) for (let i = 0; i < added; i++) s.undo();
    }
  });

  /* ---------------------------------------------------------------- */
  /* 0.9.4: per-range text styles ("runs"), on the shared editor       */
  /* ---------------------------------------------------------------- */
  // Both blocks drive what a user does: the Text tool's button, a press on
  // the page, typing into the in-place editor (execCommand insertText, else a
  // beforeinput/DOM/input fallback the detail line names), a selection made
  // with the Selection API from an offset walker of THIS file (not the
  // editor's own helpers, so a bug there cannot agree with itself), and
  // clicks on the inspector's rendered controls. What they assert is computed
  // style and client rects, the mark the session holds, and exported bytes.

  /** The Text tool's look both blocks start from (put back in finally):
   *  Segoe UI (it has a bold face) 12 pt black, no fill / border. */
  const runsTools = (d: PdfEditorDev): (() => void) => {
    const before = d.ctx.tools.get();
    d.ctx.tools.update((s) => {
      const { fontId: _drop, ...rest } = s;
      void _drop;
      return { ...rest, font: "Segoe UI", sizes: { ...s.sizes, text: 12 }, colors: { ...s.colors, text: "#000000" }, textBg: null, textBorder: null };
    });
    return () => d.ctx.tools.set(before);
  };
  /** A user's click on a control: pointer/mouse down and up at its centre,
   *  then the click (after a hit test that it is on top). */
  const pressEl = (el: HTMLElement, what: string): void => {
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    assert(hit !== null && el.contains(hit), `${what}: its centre shows ${describeEl(hit)}, not the control`);
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...o, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...o, buttons: 1, detail: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", { ...o, detail: 1 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, detail: 1 }));
  };
  /** Pick the Text tool by its toolbar button. */
  const pickTextTool = async (d: PdfEditorDev): Promise<void> => {
    const b = await until(() => {
      const x = $<HTMLButtonElement>('button[data-tool="text"]');
      return x && rendered(x) && !x.disabled ? x : null;
    }, 2_000, () => `the Text tool button (${$('button[data-tool="text"]') ? "present but not rendered / disabled" : "absent"})`);
    pressEl(b, "the Text tool button");
    assert(d.ctx.tools.get().tool === "text", `the Text tool button was clicked but the tool is "${d.ctx.tools.get().tool}"`);
  };
  /** Press on page `key` at page point (x, y) with the Text tool: a new box
   *  opens there. Returns its editor element and the id it will land under. */
  const openNewBox = async (d: PdfEditorDev, key: string, x: number, y: number): Promise<{ div: HTMLElement; id: string }> => {
    d.view.reveal(key, [x, y - 20, 220, 120]);
    await frames(2);
    const c = await until(() => toClient(d, key, x, y), 2_000, () => `page point ${x},${y} to map to the screen`);
    const target = document.elementFromPoint(c.x, c.y);
    assert(target !== null && d.view.el.contains(target), `page point ${x},${y} (client ${Math.round(c.x)},${Math.round(c.y)}) shows ${describeEl(target)}, not the page strip`);
    const o = { bubbles: true, cancelable: true, composed: true, clientX: c.x, clientY: c.y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    target!.dispatchEvent(new PointerEvent("pointerdown", { ...o, buttons: 1 }));
    target!.dispatchEvent(new PointerEvent("pointerup", o));
    const open = await until(() => {
      const e = d.ctx.textEdit.get();
      const div = $(".pdfmk-text-edit");
      return e && e.draft && rendered(div) ? { div: div!, id: e.id } : null;
    }, 2_000, () => `a new text box editor (textEdit ${d.ctx.textEdit.get() ? `open on ${d.ctx.textEdit.get()!.id}, draft ${d.ctx.textEdit.get()!.draft ? "yes" : "no"}` : "null"}, .pdfmk-text-edit ${$(".pdfmk-text-edit") ? "present" : "absent"})`);
    open.div.focus();
    return open;
  };
  /** Type `s` at the editor's selection the way the keyboard does
   *  (execCommand insertText); when the engine refuses it here, the same
   *  events by hand. Which path ran is returned for the detail line. */
  const typeInto = (div: HTMLElement, s: string): "exec" | "dom" => {
    if (document.activeElement !== div) div.focus();
    const before = walkText(div);
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, s);
    } catch {
      ok = false;
    }
    if (ok && walkText(div) !== before) return "exec";
    const sel = window.getSelection();
    assert(sel !== null && sel.rangeCount > 0 && div.contains(sel.anchorNode), `typing "${s}": execCommand did nothing and there is no caret in the editor`);
    const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: s });
    if (!div.dispatchEvent(bi)) return "dom";
    const r = sel!.getRangeAt(0);
    r.deleteContents();
    const tn = document.createTextNode(s);
    r.insertNode(tn);
    sel!.setBaseAndExtent(tn, s.length, tn, s.length);
    div.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: s }));
    return "dom";
  };
  /** Make a line break at the editor's caret the way the Enter key does, by
   *  the first of these that gives the text one more "\n" (by this file's
   *  walker): (a) a real keydown/keyup for Enter (a synthetic key event
   *  usually does not run the browser's default editing; the app may handle
   *  it itself), (b) execCommand("insertParagraph"), (c)
   *  execCommand("insertLineBreak"), (d) by hand: beforeinput insertParagraph
   *  and, when nothing prevented it, a "\n" text node at the caret and an
   *  input event. A step that changed the text WITHOUT adding exactly one
   *  line break stops the ladder (a later step would stack a second break on
   *  a mangled DOM): the assertion names the step and shows the DOM.
   *  Returns the steps tried, e.g. "a✗ b✓". */
  const breakLine = (div: HTMLElement): string => {
    if (document.activeElement !== div) div.focus();
    const nl = (s: string): number => (s.match(/\n/g) ?? []).length;
    const tried: string[] = [];
    const step = (name: string, run: () => void): boolean => {
      const before = walkText(div);
      try {
        run();
      } catch (e) {
        tried.push(`${name}✗(threw ${e instanceof Error ? e.message : String(e)})`);
        return false;
      }
      const after = walkText(div);
      if (nl(after) === nl(before) + 1 && after.replace(/\n/g, "") === before.replace(/\n/g, "")) {
        tried.push(`${name}✓`);
        return true;
      }
      assert(after === before, `line break by ${name} changed the editor's text from ${JSON.stringify(before)} to ${JSON.stringify(after)} without adding exactly one line break (tried ${[...tried, name].join(" ")}; DOM ${htmlOf(div)})`);
      tried.push(`${name}✗`);
      return false;
    };
    const exec = (cmd: string) => (): void => {
      if (!document.execCommand(cmd, false)) throw new Error(`execCommand("${cmd}") returned false`);
    };
    if (step("a:keydown", () => keyOn(div, "Enter"))) return tried.join(" ");
    if (step("b:insertParagraph", exec("insertParagraph"))) return tried.join(" ");
    if (step("c:insertLineBreak", exec("insertLineBreak"))) return tried.join(" ");
    const ok = step("d:dom", () => {
      const sel = window.getSelection();
      assert(sel !== null && sel.rangeCount > 0 && div.contains(sel.anchorNode), "line break by hand: there is no caret in the editor");
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" });
      if (!div.dispatchEvent(bi)) {
        tried.push("(d: beforeinput prevented)");
        return;
      }
      const r = sel!.getRangeAt(0);
      r.deleteContents();
      const tn = document.createTextNode("\n");
      r.insertNode(tn);
      sel!.setBaseAndExtent(tn, 1, tn, 1);
      div.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertParagraph" }));
    });
    assert(ok, `no way of making a line break added one to the editor's text (tried ${tried.join(" ")}; text ${JSON.stringify(walkText(div))}; DOM ${htmlOf(div)})`);
    return tried.join(" ");
  };
  /** An element's markup for a message, cut to 300 characters. */
  const htmlOf = (el: Element): string => {
    const h = el.innerHTML;
    return JSON.stringify(h.length > 300 ? `${h.slice(0, 300)}…` : h);
  };
  /** Ctrl+<k> / Escape on the editor, as the keyboard sends it. */
  const keyOn = (el: HTMLElement, key: string, ctrl = false): void => {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    el.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey: ctrl, bubbles: true, cancelable: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, code, ctrlKey: ctrl, bubbles: true, cancelable: true, composed: true }));
  };
  const undoDepth = (s: ProjectSession): number => (s.history as unknown as { undoStack: unknown[] }).undoStack.length;
  const textMark = (d: PdfEditorDev, key: string, id: string): Extract<PdfAnnot, { t: "text" }> | null => {
    const a = (d.session.project.pdf?.annots[key] ?? []).find((x) => x.id === id);
    return a && a.t === "text" ? a : null;
  };
  const savedNode = (d: PdfEditorDev, key: string, id: string): SVGElement | null =>
    d.view.overlay(key)?.querySelector<SVGElement>(`.pdfmk-marks [data-id="${id}"]`) ?? null;
  /** A computed style in a few words, for messages. */
  const cs = (el: Element): string => {
    const c = getComputedStyle(el);
    return `${c.fontWeight}/${c.fontSize}/${c.color}`;
  };
  const isBold = (el: Element): boolean => Number(getComputedStyle(el).fontWeight) >= 600;
  const rgbOf = (hex: string): string => {
    const h = hex.replace("#", "");
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
  };
  /** Runs as a comparable string (key order aside). */
  const runsKey = (runs: readonly object[] | undefined): string =>
    runs === undefined ? "none" : JSON.stringify(runs.map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))));
  /** Settings the runs blocks may write (recent colours, the tool look). */
  const settingsSnap = (): { ink: unknown; tool: unknown } => {
    const st = settingsStore.get() as unknown as { inkColors?: unknown; pdfToolStyle?: unknown };
    return { ink: st.inkColors, tool: st.pdfToolStyle };
  };
  const settingsBack = async (was: { ink: unknown; tool: unknown }): Promise<void> => {
    try {
      // the tool look is saved on a short debounce: let it land first
      await sleep(400);
      await settingsWritesSettled();
      const now = settingsSnap();
      const patch: Record<string, unknown> = {};
      if (JSON.stringify(now.ink) !== JSON.stringify(was.ink)) patch.inkColors = was.ink;
      if (JSON.stringify(now.tool) !== JSON.stringify(was.tool)) patch.pdfToolStyle = was.tool;
      if (Object.keys(patch).length) await updateSettings(patch as Parameters<typeof updateSettings>[0]);
      await settingsWritesSettled();
    } catch (e) {
      console.error("pdf autotest: settings not put back", e);
    }
  };
  /** Close any open editor (discard) and remove a box a block placed. */
  const runsTeardown = async (d: PdfEditorDev | null, key: string, id: string): Promise<void> => {
    if (!d) return;
    try {
      d.ctx.textEdit.get()?.discard();
      d.ctx.selection.set([]);
      if (id && currentSession.get() === d.session && textMark(d, key, id)) {
        const { removeAnnots } = await import("../pdf/model");
        d.session.commit((p) => removeAnnots(p, [{ pageId: key, id }]));
      }
    } catch (e) {
      console.error("pdf autotest: the runs box was not removed", e);
    }
  };

  await test("pdf-text-runs-style-export", async () => {
    const t0 = performance.now();
    const TEXT = "Hello world again";
    const S = 6;
    const E = 11;
    let d: PdfEditorDev | null = null;
    let key = "";
    let id = "";
    let restoreTools: (() => void) | null = null;
    const was = settingsSnap();
    const outs: string[] = [];
    const opened: PdfDoc[] = [];
    try {
      needFixtures();
      d = await ensureEditor();
      const dd = d;
      key = firstPageId(dd);
      dd.ctx.textEdit.get()?.commit();
      dd.ctx.selection.set([]);
      restoreTools = runsTools(dd);
      await pickTextTool(dd);
      const depth0 = undoDepth(dd.session);
      const open = await openNewBox(dd, key, 60, 560);
      id = open.id;
      const div = open.div;
      const how = typeInto(div, TEXT);
      assert(walkText(div) === TEXT, `typed "${TEXT}" (${how}) but the editor holds "${walkText(div)}"`);

      // Select "world" with the Selection API, as a drag would leave it.
      setSel(div, S, E);
      document.dispatchEvent(new Event("selectionchange"));
      await until(() => {
        const r = dd.ctx.textEdit.get()?.range;
        return r && r.s === S && r.e === E ? r : null;
      }, 1_500, () => `the editor to publish range {s:${S},e:${E}} (publishes ${JSON.stringify(dd.ctx.textEdit.get()?.range)}, DOM selection ${JSON.stringify(selOffsets(div))})`);

      // Bold, by the inspector's button.
      const boldBtn = (): HTMLButtonElement | null => $<HTMLButtonElement>('#pdfed-inspector button[aria-label="Bold"]');
      const b0 = await until(() => {
        const b = boldBtn();
        return b && rendered(b) && !b.disabled ? b : null;
      }, 2_000, () => `the inspector's Bold button, enabled (${boldBtn() ? `disabled ${boldBtn()!.disabled}` : "absent"}; inspector shows "${text("#pdfed-inspector .insp-header__name")}")`);
      assert(b0.getAttribute("aria-pressed") !== "true", `Bold reads pressed for the plain range "world" before any click`);
      pressEl(b0, "the Bold button");
      const findSpan = (root: ParentNode, t: string): HTMLElement | null => $$<HTMLElement>("span", root).find((s) => s.textContent === t) ?? null;
      await until(() => {
        const s = findSpan(div, "world");
        return s && isBold(s) ? s : null;
      }, 1_500, () => `a bold span "world" in the editor after Bold (spans: ${$$("span", div).map((s) => `"${s.textContent}" ${cs(s)}`).join(", ") || "none"})`);

      // A colour that is not the base colour, by a swatch of the Color row.
      const base = normalizeHexColor(dd.ctx.textEdit.get()?.draft?.c ?? "#000000", "#000000");
      const swatches = $$<HTMLButtonElement>('#pdfed-inspector [role="group"][aria-label="Mark color"] button.pdfmk-swatch:not(.pdfmk-swatch--none)');
      // the most saturated one: unmistakable against black text and white paper
      const chroma = (h: string): number => {
        const a = rgbOf(h).match(/\d+/g)!.map(Number);
        return Math.max(...a) - Math.min(...a);
      };
      const pick = swatches.map((b) => ({ b, c: normalizeHexColor(b.title, "") })).filter((x) => x.c && x.c !== base).sort((x, y) => chroma(y.c) - chroma(x.c))[0];
      assert(pick !== undefined, `the Mark color row has no swatch other than the base ${base} (swatches: ${swatches.map((b) => b.title).join(", ") || "none"})`);
      const C = pick!.c;
      pressEl(pick!.b, `the ${C} swatch`);
      const worldSpan = await until(() => {
        const s = findSpan(div, "world");
        return s && isBold(s) && getComputedStyle(s).color === rgbOf(C) ? s : null;
      }, 1_500, () => `"world" bold AND ${rgbOf(C)} in the editor (spans: ${$$("span", div).map((s) => `"${s.textContent}" ${cs(s)}`).join(", ") || "none"})`);
      const selNow = selOffsets(div);
      const rNow = dd.ctx.textEdit.get()?.range;
      assert(rNow?.s === S && rNow.e === E, `after Bold + colour the editor publishes range ${JSON.stringify(rNow)}, not ${S}..${E}`);
      assert(selNow?.s === S && selNow.e === E, `after Bold + colour the DOM selection is ${JSON.stringify(selNow)} (active ${describeEl(document.activeElement)}), not ${S}..${E}`);
      const others = $$<HTMLElement>("span", div).filter((s) => s !== worldSpan);
      const before = others.find((s) => s.textContent === "Hello ");
      const after = others.find((s) => s.textContent === " again");
      assert(before !== undefined && after !== undefined, `the editor's other spans are ${others.map((s) => `"${s.textContent}"`).join(", ")}, not "Hello " and " again"`);
      assert(!isBold(before!) && !isBold(after!), `the text around "world" is bold: "Hello " ${cs(before!)}, " again" ${cs(after!)}`);
      const editShown = `"world" ${cs(worldSpan)}; "Hello " ${cs(before!)}`;

      // The editor's own undo: one step per style.
      keyOn(div, "z", true);
      await until(() => {
        const s = findSpan(div, "world");
        return s && isBold(s) && getComputedStyle(s).color === rgbOf(base) ? s : null;
      }, 1_000, () => `Ctrl+Z to take the colour off "world" and keep bold (spans: ${$$("span", div).map((s) => `"${s.textContent}" ${cs(s)}`).join(", ")})`);
      keyOn(div, "y", true);
      await until(() => {
        const s = findSpan(div, "world");
        return s && isBold(s) && getComputedStyle(s).color === rgbOf(C) ? s : null;
      }, 1_000, () => `Ctrl+Y to put ${rgbOf(C)} back on "world" (spans: ${$$("span", div).map((s) => `"${s.textContent}" ${cs(s)}`).join(", ")})`);
      assert(depth0 === undoDepth(dd.session), `styling inside the open editor touched the project history (${depth0} → ${undoDepth(dd.session)})`);

      // Escape: the box lands in one step with its run.
      keyOn(div, "Escape");
      await until(() => (!dd.ctx.textEdit.get() && !$(".pdfmk-text-edit") ? true : null), 1_500, () => `the editor to close on Escape (textEdit ${dd.ctx.textEdit.get() ? "still open" : "null"})`);
      const m1 = textMark(dd, key, id);
      assert(m1 !== null && m1.text === TEXT, `after Escape the page holds ${m1 ? `"${m1.text}"` : "no box"} under ${id}`);
      const want1 = runsKey([{ s: S, e: E, bold: true, c: C }]);
      assert(runsKey(m1!.runs) === want1, `the box's runs are ${runsKey(m1!.runs)}, not ${want1}`);
      assert(!m1!.bold && normalizeHexColor(m1!.c, "") === base, `the box's own style changed: bold ${m1!.bold}, c ${m1!.c} (base ${base})`);
      const steps = undoDepth(dd.session) - depth0;
      assert(steps === 1, `the whole edit (new box, text, two range styles) took ${steps} history steps, not 1`);
      const sel1 = dd.ctx.selection.get();
      assert(sel1.length === 1 && sel1[0]!.id === id, `after Escape the selection is ${JSON.stringify(sel1)}, not the box`);

      const savedSpans = async (what: string, ok: (sp: HTMLElement[]) => boolean): Promise<HTMLElement[]> =>
        until(() => {
          const n = savedNode(dd, key, id);
          const sp = n ? $$<HTMLElement>(".pdfmk-text__line span", n) : [];
          return sp.length && ok(sp) ? sp : null;
        }, 1_500, () => {
          const n = savedNode(dd, key, id);
          return `${what} (saved node ${n ? (rendered(n) ? "rendered" : "not rendered") : "absent"}; spans: ${n ? $$<HTMLElement>(".pdfmk-text__line span", n).map((s) => `"${s.textContent}" ${cs(s)}`).join(", ") || "none" : "-"})`;
        });
      const sp1 = await savedSpans(`the saved box to draw "world" bold in ${rgbOf(C)}, the rest plain`, (sp) => {
        const w = sp.find((s) => s.textContent === "world");
        return !!w && isBold(w) && getComputedStyle(w).color === rgbOf(C) && sp.filter((s) => s !== w).every((s) => !isBold(s) && getComputedStyle(s).color === rgbOf(base));
      });
      assert(sp1.every((s) => rendered(s)), "a span of the saved box is not rendered");
      const savedShown = sp1.map((s) => `"${s.textContent}" ${cs(s)}`).join(", ");

      // Not editing, the box selected: Bold is the whole box's.
      const b1 = await until(() => {
        const b = boldBtn();
        return b && rendered(b) && !b.disabled && !dd.ctx.textEdit.get() ? b : null;
      }, 2_000, () => `the Bold button for the selected box (${boldBtn() ? `disabled ${boldBtn()!.disabled}` : "absent"})`);
      const depth1 = undoDepth(dd.session);
      pressEl(b1, "the Bold button (whole box)");
      const m2 = await until(() => {
        const m = textMark(dd, key, id);
        return m && m.bold ? m : null;
      }, 1_000, () => `the box to turn bold (bold ${textMark(dd, key, id)?.bold}, runs ${runsKey(textMark(dd, key, id)?.runs)})`);
      const want2 = runsKey([{ s: S, e: E, c: C }]);
      assert(runsKey(m2.runs) === want2, `after the whole-box Bold the runs are ${runsKey(m2.runs)}, not ${want2} (bold must leave the run, colour stay)`);
      assert(undoDepth(dd.session) === depth1 + 1, `the whole-box Bold took ${undoDepth(dd.session) - depth1} steps, not 1`);
      await savedSpans("every span of the saved box bold, \"world\" still coloured", (sp) => sp.every((s) => isBold(s)) && getComputedStyle(sp.find((s) => s.textContent === "world") ?? sp[0]!).color === rgbOf(C));

      // The app's undo button takes it back.
      const undoBtn = $<HTMLButtonElement>("#pdfed-undo");
      assert(rendered(undoBtn) && !undoBtn!.disabled, `the Undo button is ${undoBtn ? (undoBtn.disabled ? "disabled" : "not rendered") : "absent"}`);
      pressEl(undoBtn!, "the Undo button");
      const m3 = await until(() => {
        const m = textMark(dd, key, id);
        return m && !m.bold ? m : null;
      }, 1_000, () => `Undo to take the whole-box Bold off (bold ${textMark(dd, key, id)?.bold})`);
      assert(runsKey(m3.runs) === want1, `after Undo the runs are ${runsKey(m3.runs)}, not ${want1}`);
      await savedSpans("after Undo: only \"world\" bold again", (sp) => sp.filter((s) => isBold(s)).map((s) => s.textContent).join("|") === "world");

      // Export: the box alone on its page, flattened into page content.
      const p = dd.session.project;
      const only = { ...p, pdf: { ...p.pdf!, annots: { ...p.pdf!.annots, [key]: [m3] } } };
      const dir = await scratchDir();
      const out = `${dir}\\autotest-pdf-runs-${Date.now().toString(36)}.pdf`;
      outs.push(out);
      const { exportPdf } = await import("../pdf/export/export");
      const t1 = performance.now();
      const res = await exportPdf(only, { flattenMarks: true, flattenForms: false }, out).catch((e: unknown) => {
        throw new Error(`the export of the box with runs failed: ${errorDetail(e).message}`);
      });
      const exportMs = Math.round(performance.now() - t1);
      const got = await pdfLibFonts(res.path);
      assert(got.pages === 1, `pdf-lib loads the export with ${got.pages} pages, not 1`);
      const srcNames = (await pdfLibFonts(fx("form_acro.pdf"))).names;
      const fresh = got.names.filter((n) => !srcNames.includes(n));
      const regular = fresh.find((n) => /segoe/i.test(n) && !/bold/i.test(n));
      const boldF = fresh.find((n) => /segoe/i.test(n) && /bold/i.test(n));
      assert(regular !== undefined && boldF !== undefined, `the export (${got.bytes} bytes) does not embed both a regular and a bold Segoe UI face: new fonts ${fresh.join(", ") || "none"} (source has ${srcNames.join(", ") || "none"})`);
      // pdf.js: the text items of "world" and "Hello" are drawn in different fonts
      const { openPdf } = await import("../pdf/view");
      const doc = await openPdf("autotest-runs-out", res.path);
      opened.push(doc);
      const pg = await (doc.doc as PdfProxyLite).getPage(1);
      const tc = await (pg as unknown as { getTextContent(): Promise<{ items: { str?: string; fontName?: string }[] }> }).getTextContent();
      const items = tc.items.filter((i) => typeof i.str === "string" && i.str.trim() !== "");
      const wItem = items.find((i) => i.str!.includes("world"));
      const hItem = items.find((i) => i.str!.includes("Hello"));
      assert(wItem !== undefined && hItem !== undefined, `pdf.js reads no "world"/"Hello" text in the export (items: ${items.map((i) => `"${i.str}"`).join(", ") || "none"})`);
      assert(wItem!.fontName !== hItem!.fontName, `"world" and "Hello" are drawn in the same font ${wItem!.fontName} (items: ${items.map((i) => `"${i.str}"@${i.fontName}`).join(", ")})`);
      pg.cleanup();
      return `typed (${how}); "world" 6..11 → Bold + ${C} by the panel: editor ${editShown}, range held; Ctrl+Z → colour off / bold kept, Ctrl+Y → back; Escape → runs ${runsKey(m1!.runs)}, 1 history step, saved ${savedShown}; whole-box Bold → runs ${runsKey(m2.runs)}, all bold; Undo → back; export ${exportMs} ms (${got.bytes} B, pdf-lib 1 page): ${regular} + ${boldF}, pdf.js "world"@${wItem!.fontName} vs "Hello"@${hItem!.fontName} — ${ms(t0)}`;
    } finally {
      await runsTeardown(d, key, id);
      restoreTools?.();
      for (const doc of opened) await doc.destroy().catch(() => {});
      for (const o of outs) await removeTestFile(o).catch(() => {});
      await settingsBack(was);
    }
  });

  await test("pdf-text-runs-mixed-size-fits", async () => {
    const t0 = performance.now();
    const LINE1 = "Hello BIG word";
    const LINE2 = "second line";
    const S = 6;
    const E = 9;
    const BIG = 30;
    const TOL = 1.5;
    let d: PdfEditorDev | null = null;
    let key = "";
    let id = "";
    let restoreTools: (() => void) | null = null;
    const was = settingsSnap();
    try {
      needFixtures();
      d = await ensureEditor();
      const dd = d;
      key = firstPageId(dd);
      dd.ctx.textEdit.get()?.commit();
      dd.ctx.selection.set([]);
      restoreTools = runsTools(dd);
      await pickTextTool(dd);
      const open = await openNewBox(dd, key, 60, 650);
      id = open.id;
      const div = open.div;
      // Two lines the way a person types them: line 1, Enter, line 2.
      const { readText } = await import("../pdf/editor/marks/text");
      const howA = typeInto(div, LINE1);
      const brk1 = breakLine(div);
      const html1 = htmlOf(div);
      const howB = typeInto(div, LINE2);
      const how = `${howA}/${howB}`;
      const typed = walkText(div);
      const appRead = readText(div);
      const html1b = htmlOf(div);
      const brkShown = `line break ${brk1}, DOM after it ${html1}, after line 2 ${html1b}; walker ${JSON.stringify(typed)}, readText ${JSON.stringify(appRead)}`;
      assert(typed === `${LINE1}\n${LINE2}`, `typed two lines (${how}) but the editor holds ${JSON.stringify(typed)} — ${brkShown}`);

      setSel(div, S, E);
      document.dispatchEvent(new Event("selectionchange"));
      await until(() => {
        const r = dd.ctx.textEdit.get()?.range;
        return r && r.s === S && r.e === E ? r : null;
      }, 1_500, () => `the editor to publish range {s:${S},e:${E}} (publishes ${JSON.stringify(dd.ctx.textEdit.get()?.range)})`);

      // The size, by the inspector's slider (a drag's events).
      const range = await until(() => {
        const r = $<HTMLInputElement>('#pdfed-inspector input[type="range"][aria-label="Font size in points"]');
        return r && rendered(r) ? r : null;
      }, 2_000, () => "the inspector's Font size slider");
      const pr = range.getBoundingClientRect();
      const po = { bubbles: true, cancelable: true, clientX: pr.left + pr.width / 2, clientY: pr.top + pr.height / 2, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
      range.dispatchEvent(new PointerEvent("pointerdown", { ...po, buttons: 1 }));
      range.value = String(BIG);
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
      range.dispatchEvent(new PointerEvent("pointerup", po));
      /** the 30 pt span "BIG" (re-queried: the styled editor rebuilds its spans) */
      const bigSpanOf = (): HTMLElement | null =>
        $$<HTMLElement>("span", div).find((s) => s.textContent === "BIG" && parseFloat(getComputedStyle(s).fontSize) === BIG) ?? null;
      const spansShown = (): string => $$("span", div).map((s) => `${JSON.stringify(s.textContent)} ${cs(s)}`).join(", ") || "none";
      await until(bigSpanOf, 1_500, () => `a ${BIG}px span "BIG" in the editor (spans: ${spansShown()}; text ${JSON.stringify(walkText(div))}; DOM ${htmlOf(div)})`);
      assert(walkText(div) === `${LINE1}\n${LINE2}`, `after the ${BIG} pt style the editor holds ${JSON.stringify(walkText(div))}, not the two lines (DOM ${htmlOf(div)})`);
      await frames(2);
      const nl = LINE1.length;

      // Styled mode: Enter at the end of line 1 opens a new line between the
      // two; "Q" on it. The run still covers exactly "BIG".
      setSel(div, nl, nl);
      document.dispatchEvent(new Event("selectionchange"));
      const brk2 = breakLine(div);
      const html2 = htmlOf(div);
      const howQ = typeInto(div, "Q");
      await frames(1);
      const wantQ = `${LINE1}\nQ\n${LINE2}`;
      const afterQ = walkText(div);
      assert(afterQ === wantQ, `after a line break (${brk2}) at the end of line 1 and "Q" (${howQ}) the styled editor holds ${JSON.stringify(afterQ)}, not ${JSON.stringify(wantQ)} (DOM after the break ${html2}, now ${htmlOf(div)})`);
      const cq = selOffsets(div);
      assert(cq !== null && cq.s === nl + 2 && cq.e === nl + 2, `after typing "Q" on the new line the caret is at ${JSON.stringify(cq)}, not ${nl + 2} (DOM ${htmlOf(div)})`);
      const bigNow = $$<HTMLElement>("span", div).filter((s) => parseFloat(getComputedStyle(s).fontSize) === BIG).map((s) => s.textContent).join("");
      assert(bigNow === "BIG", `after the line break and "Q" the ${BIG}px text in the editor is ${JSON.stringify(bigNow)}, not "BIG" (spans: ${spansShown()})`);
      const qShown = `styled break ${brk2}, DOM after it ${html2}, "Q" (${howQ}) → ${JSON.stringify(afterQ)}, ${BIG}px text ${JSON.stringify(bigNow)}`;
      await frames(1);

      // Editing: the browser's own line boxes for the mixed sizes (line 1
      // against the last line, "second line").
      const l3 = nl + 3;
      const e1 = rangeBox(div, 0, nl);
      const e2 = rangeBox(div, l3, l3 + LINE2.length);
      assert(e1 !== null && e2 !== null, `the editor's lines have no client rects (${JSON.stringify(e1)}, ${JSON.stringify(e2)})`);
      assert(e1!.h > 1.5 * e2!.h, `while editing, line 1's glyphs are ${e1!.h.toFixed(1)} px tall and line 3's ${e2!.h.toFixed(1)} px — the ${BIG} pt word did not make line 1 clearly taller`);

      // Typing at the very start of the large run, then at the end of the text.
      const bigSpan = bigSpanOf();
      assert(bigSpan !== null && bigSpan.firstChild !== null, `the ${BIG}px span "BIG" is gone before typing "x" (spans: ${spansShown()})`);
      const bigText = bigSpan!.firstChild!;
      window.getSelection()!.setBaseAndExtent(bigText, 0, bigText, 0);
      document.dispatchEvent(new Event("selectionchange"));
      const how1 = typeInto(div, "x");
      await frames(1);
      const c1 = selOffsets(div);
      assert(c1 !== null && c1.s === S + 1 && c1.e === S + 1, `after typing "x" at the start of the large run the caret is at ${JSON.stringify(c1)}, not ${S + 1}`);
      assert(walkText(div).slice(0, S + 2) === "Hello xB", `after typing "x" the text starts ${JSON.stringify(walkText(div).slice(0, 10))}`);
      const xEl = charEl(div, S);
      const prevEl = charEl(div, S - 1);
      assert(xEl !== null && prevEl !== null, "the typed character or the one before it has no element");
      const xSize = parseFloat(getComputedStyle(xEl!).fontSize);
      const prevSize = parseFloat(getComputedStyle(prevEl!).fontSize);
      assert(xSize === prevSize && xSize !== BIG, `the "x" typed at the start of the ${BIG} pt run renders at ${xSize}px; the character before it is ${prevSize}px (it must take the style of the character before it)`);
      const endAt = walkText(div).length;
      setSel(div, endAt, endAt);
      document.dispatchEvent(new Event("selectionchange"));
      const how2 = typeInto(div, "y");
      await frames(1);
      const c2 = selOffsets(div);
      assert(c2 !== null && c2.s === endAt + 1 && c2.e === endAt + 1, `after typing "y" at the end (${endAt}) the caret is at ${JSON.stringify(c2)}, not ${endAt + 1}`);
      const yEl = charEl(div, endAt);
      assert(yEl !== null && parseFloat(getComputedStyle(yEl).fontSize) === 12, `the "y" typed at the end renders ${yEl ? cs(yEl) : "nowhere"}, not 12px`);

      // What the editor shows just before Escape (its frame, client px).
      await frames(1);
      const outline = $<SVGElement>(".pdfmk-edit-chrome .pdfmk-sel");
      assert(rendered(outline), "the editor's frame (.pdfmk-edit-chrome .pdfmk-sel) is not rendered");
      const edH = outline!.getBoundingClientRect().height;
      const ed1 = rangeBox(div, 0, nl)!;
      const ed2 = rangeBox(div, l3, walkText(div).length)!;
      const divPt = div.offsetHeight;

      keyOn(div, "Escape");
      await until(() => (!dd.ctx.textEdit.get() && !$(".pdfmk-text-edit") ? true : null), 1_500, () => `the editor to close on Escape (textEdit ${dd.ctx.textEdit.get() ? "still open" : "null"})`);
      const m = textMark(dd, key, id);
      const wantText = `Hello xBIG word\nQ\n${LINE2}y`;
      assert(m !== null && m.text === wantText, `after Escape the box holds ${m ? JSON.stringify(m.text) : "nothing"}, not ${JSON.stringify(wantText)}`);
      const wantRuns = runsKey([{ s: S + 1, e: E + 1, size: BIG }]);
      assert(runsKey(m!.runs) === wantRuns, `after Escape the runs are ${runsKey(m!.runs)}, not ${wantRuns}`);

      // Saved: the app's rows, on screen.
      const n = await until(() => {
        const x = savedNode(dd, key, id);
        return x && rendered(x) && $$(".pdfmk-text__line", x).length === 3 ? x : null;
      }, 1_500, () => `the saved box with 3 line divs (node ${savedNode(dd, key, id) ? `${$$(".pdfmk-text__line", savedNode(dd, key, id)!).length} lines` : "absent"})`);
      await frames(1);
      const boxR = n.getBoundingClientRect();
      const lines = $$<HTMLElement>(".pdfmk-text__line", n);
      // client px per point (page 1 is not turned; the box is m.w pt wide)
      const k = boxR.width / m!.w;
      /** A line's glyph boxes (span client rects) and how far the font's own
       *  content area may stand out of its line-height box by CSS: half of
       *  (content height − size × 1.25), per span, 0 when it fits. A span's
       *  rect is its font's ascent + descent, which for Segoe UI (1.33 em) is
       *  taller than the 1.25 line height the app (and the export) uses. */
      const glyphs = (ln: HTMLElement): { top: number; bottom: number; left: number; right: number; h: number; over: number } | null => {
        const rs: DOMRect[] = [];
        let over = 0;
        for (const s of $$<HTMLElement>("span", ln)) {
          const lh = parseFloat(getComputedStyle(s).fontSize) * 1.25 * k;
          for (const r of Array.from(s.getClientRects())) {
            if (r.width <= 0 && r.height <= 0) continue;
            rs.push(r);
            over = Math.max(over, (r.height - lh) / 2);
          }
        }
        if (!rs.length) return null;
        const top = Math.min(...rs.map((r) => r.top));
        const bottom = Math.max(...rs.map((r) => r.bottom));
        return { top, bottom, left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)), h: bottom - top, over: Math.max(0, over) };
      };
      // line 1 (with the 30 pt run), line 2 ("Q"), line 3 ("second liney")
      const g1 = glyphs(lines[0]!);
      const gQ = glyphs(lines[1]!);
      const g2 = glyphs(lines[2]!);
      assert(g1 !== null && gQ !== null && g2 !== null, "a saved line has no glyph rects");
      const row1 = lines[0]!.getBoundingClientRect().height;
      const rowQ = lines[1]!.getBoundingClientRect().height;
      const row2 = lines[2]!.getBoundingClientRect().height;
      const nums = `editor: frame ${edH.toFixed(1)} px (div ${divPt} pt), line glyphs 1 ${ed1.h.toFixed(1)} / 3 ${ed2.h.toFixed(1)} px; saved: box ${boxR.height.toFixed(1)} px (h ${m!.h.toFixed(2)} pt), rows ${row1.toFixed(1)} / ${rowQ.toFixed(1)} / ${row2.toFixed(1)} px, line glyphs ${g1!.h.toFixed(1)} / ${gQ!.h.toFixed(1)} / ${g2!.h.toFixed(1)} px`;
      assert(row1 > 1.5 * row2 && g1!.h > 1.5 * g2!.h, `saved: line 1 is not clearly taller than line 3 — ${nums}`);
      const overs: string[] = [];
      for (const [i, g] of [g1!, gQ!, g2!].entries()) {
        const tolV = TOL + g.over;
        overs.push(`line ${i + 1}: top ${(boxR.top - g.top).toFixed(1)} / bottom ${(g.bottom - boxR.bottom).toFixed(1)} px out, CSS overhang ${g.over.toFixed(1)}`);
        const out = g.top < boxR.top - tolV || g.bottom > boxR.bottom + tolV || g.left < boxR.left - TOL || g.right > boxR.right + TOL;
        assert(!out, `saved line ${i + 1}'s glyphs (${g.left.toFixed(1)},${g.top.toFixed(1)}–${g.right.toFixed(1)},${g.bottom.toFixed(1)}) leave the box (${boxR.left.toFixed(1)},${boxR.top.toFixed(1)}–${boxR.right.toFixed(1)},${boxR.bottom.toFixed(1)}) by more than ${TOL} px + the span's own CSS overhang ${g.over.toFixed(1)} px — ${nums}`);
      }
      assert(Math.abs(boxR.height - edH) <= TOL, `the box jumped on commit: the editor showed ${edH.toFixed(1)} px, the saved box is ${boxR.height.toFixed(1)} px (Δ ${(boxR.height - edH).toFixed(1)}) — ${nums}`);
      return `typed (${how}/${how1}/${how2}); ${brkShown}; "BIG" → ${BIG} pt by the slider; ${qShown}; while editing line glyphs (1 / 3) ${e1!.h.toFixed(1)} / ${e2!.h.toFixed(1)} px; "x" at the run's start → caret ${c1!.s}, ${xSize}px like the char before; "y" at the end → caret ${c2!.s}; runs ${runsKey(m!.runs)}; ${nums}; glyphs vs box: ${overs.join("; ")}; ${k.toFixed(3)} px/pt, zoom ${dd.view.state.get().zoom.toFixed(3)} — ${ms(t0)}`;
    } finally {
      await runsTeardown(d, key, id);
      restoreTools?.();
      await settingsBack(was);
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

/* ------------------------------------------------------------------ */
/* An offset walker for the text editor, independent of the editor's   */
/* own (marks/text.ts): text nodes count their data, a <br> counts one  */
/* "\n" unless it is the trailing placeholder Chromium keeps after a    */
/* last empty line (the last leaf, nothing after it), and the boundary  */
/* of a block-level child (<div>, <p>: what Chromium builds for a       */
/* paragraph break) counts one "\n" when text stands on both sides of   */
/* it, the way innerText reads it (consecutive boundaries collapse to   */
/* one). A boundary leaf is `br: true` with `at`, the DOM point where    */
/* the boundary sits (before the block it enters / after the one it     */
/* leaves), so every `!l.br` filter skips it as it skips a <br>.         */
/* ------------------------------------------------------------------ */

interface WalkLeaf {
  node: Node;
  start: number;
  len: number;
  br: boolean;
  /** a block boundary: its DOM point */
  at?: { node: Node; offset: number };
}

const isBlockEl = (n: Node): boolean => n.nodeType === Node.ELEMENT_NODE && (n.nodeName === "DIV" || n.nodeName === "P");
const indexIn = (n: Node): number => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;

function walkLeaves(root: Node): WalkLeaf[] {
  const raw: { node: Node; br: boolean; at?: { node: Node; offset: number } }[] = [];
  /** a block boundary passed since the last leaf, waiting for content after it */
  let pending: { node: Node; at: { node: Node; offset: number } } | null = null;
  let content = false;
  const leaf = (c: Node, br: boolean): void => {
    if (pending && content) raw.push({ node: pending.node, br: true, at: pending.at });
    pending = null;
    raw.push({ node: c, br });
    content = true;
  };
  const walk = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        if ((c as Text).data.length > 0) leaf(c, false);
        else raw.push({ node: c, br: false });
      } else if (c.nodeName === "BR") leaf(c, true);
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const block = isBlockEl(c);
        if (block) pending ??= { node: c, at: { node: n, offset: indexIn(c) } };
        walk(c);
        if (block) pending ??= { node: c, at: { node: n, offset: indexIn(c) + 1 } };
      }
    }
  };
  walk(root);
  let placeholder: Node | null = null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const l = raw[i]!;
    if (l.at) break;
    if (l.br) {
      placeholder = l.node;
      break;
    }
    if ((l.node as Text).data.length > 0) break;
  }
  let at = 0;
  return raw.map((l) => {
    const len = l.at ? 1 : l.br ? (l.node === placeholder ? 0 : 1) : (l.node as Text).data.length;
    const out: WalkLeaf = { node: l.node, start: at, len, br: l.br };
    if (l.at) out.at = l.at;
    at += len;
    return out;
  });
}

/** The editor's text, by this walker. */
function walkText(root: Node): string {
  return walkLeaves(root)
    .map((l) => (l.br ? (l.len ? "\n" : "") : (l.node as Text).data))
    .join("");
}

/** The DOM point for text offset `at` (the earlier text node wins at an edge). */
function walkPoint(root: Node, at: number): { node: Node; offset: number } {
  for (const l of walkLeaves(root)) {
    if (!l.br && at >= l.start && at <= l.start + l.len) return { node: l.node, offset: at - l.start };
    if (l.at && at === l.start) return l.at;
    if (l.br && l.len && at === l.start) {
      const p = l.node.parentNode!;
      return { node: p, offset: Array.prototype.indexOf.call(p.childNodes, l.node) as number };
    }
  }
  return { node: root, offset: root.childNodes.length };
}

/** The text offset of a DOM point inside `root`, or null. */
function walkOffset(root: Node, node: Node, off: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  const leaves = walkLeaves(root);
  if (node.nodeType === Node.TEXT_NODE) {
    const l = leaves.find((x) => x.node === node);
    return l ? l.start + Math.min(off, l.len) : null;
  }
  const r = document.createRange();
  r.setStart(node, off);
  r.collapse(true);
  let pos = 0;
  for (const l of leaves) {
    // a block boundary counts once the caret is strictly past its point
    if (l.at) {
      if (r.comparePoint(l.at.node, l.at.offset) < 0) pos += l.len;
    } else if (l.br) {
      const p = l.node.parentNode!;
      const i = Array.prototype.indexOf.call(p.childNodes, l.node) as number;
      if (r.comparePoint(p, i + 1) <= 0) pos += l.len;
    } else if (r.comparePoint(l.node, (l.node as Text).data.length) <= 0) pos += l.len;
  }
  return pos;
}

/** Select [s, e) of the editor's text with the Selection API. */
function setSel(root: Node, s: number, e: number): void {
  const a = walkPoint(root, s);
  const b = walkPoint(root, e);
  window.getSelection()!.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
}

/** The document selection as offsets into `root` (null: not inside it). */
function selOffsets(root: Node): { s: number; e: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  const a = walkOffset(root, sel.anchorNode, sel.anchorOffset);
  const f = walkOffset(root, sel.focusNode, sel.focusOffset);
  return a === null || f === null ? null : { s: Math.min(a, f), e: Math.max(a, f) };
}

/** The union of the client rects of text [s, e) (glyph boxes), or null. */
function rangeBox(root: Node, s: number, e: number): { top: number; bottom: number; h: number } | null {
  const a = walkPoint(root, s);
  const b = walkPoint(root, e);
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  const rs = Array.from(r.getClientRects()).filter((x) => x.width > 0 && x.height > 0);
  if (!rs.length) return null;
  const top = Math.min(...rs.map((x) => x.top));
  const bottom = Math.max(...rs.map((x) => x.bottom));
  return { top, bottom, h: bottom - top };
}

/** The element holding character `at` of the editor's text. */
function charEl(root: Node, at: number): Element | null {
  const l = walkLeaves(root).find((x) => !x.br && at >= x.start && at < x.start + x.len);
  return l ? l.node.parentElement : null;
}

/** An exported PDF read back with pdf-lib (the export chunk's own library,
 *  lazily): every font dictionary's /BaseFont (one per object, so a Type0
 *  font and its descendant both count), the page count and the size. A file
 *  pdf-lib cannot load throws — that is the "valid PDF" check. */
async function pdfLibFonts(path: string): Promise<{ names: string[]; pages: number; bytes: number }> {
  const res = await fetch(mediaUrl(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`reading ${baseName(path)} back failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { PDFDict, PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }).catch((e: unknown) => {
    throw new Error(`pdf-lib cannot load ${baseName(path)} (${bytes.length} bytes): ${e instanceof Error ? e.message : String(e)}`);
  });
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Type"))?.toString() !== "/Font") continue;
    names.push(obj.get(PDFName.of("BaseFont"))?.toString().replace(/^\//, "") ?? "(no /BaseFont)");
  }
  return { names, pages: doc.getPageCount(), bytes: bytes.length };
}

/** Ink pixels inside a page-space box of a scale-1 page render. */
function inkPixelsIn(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const d = g.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.min(d[i]!, d[i + 1]!, d[i + 2]!) < 160) n++;
  return n;
}
