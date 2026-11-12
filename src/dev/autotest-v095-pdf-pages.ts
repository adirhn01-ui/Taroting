// 0.9.5 E2E blocks: several PDF pages exported as pictures from the PDF
// editor's Export dialog (Image tab → All pages / Page range, into a folder).
// DEV-only: imported lazily by autotest.ts, never part of a release bundle.
//
// Like autotest-pdf.ts, nothing under src/pdf is imported statically (the PDF
// editor, pdf.js and pdf-lib are lazy chunks); type-only imports are erased.
//
// What a block asserts is ON DISK: every expected file exists in a scratch
// folder inside the autotest root, under the single-page export's name, with
// PNG / JPEG magic bytes and the pixel size the dialog promised for THAT page
// (read from the file's own header, not from the DOM). Both blocks share one
// editor mount on plain_3p.pdf, shaped so every page has its own picture size
// (page 2 turned, page 3 a 400 x 300 pt blank: a wrong page fails the size
// check), and delete everything they wrote.

import { invoke } from "@tauri-apps/api/core";
import { ipc, mediaUrl } from "../core/ipc";
import { navigate } from "../core/nav";
import { currentSession, settingsStore, updateSettings, type ProjectSession } from "../core/session";
import type { PdfDoc, PdfEditorCtx } from "../pdf/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as runPdfBlocks. */
export type PdfPagesCtx = Wave1Ctx;

const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

interface PdfEditorDev {
  session: ProjectSession;
  ctx: PdfEditorCtx;
  docs: ReadonlyMap<string, PdfDoc>;
}
function pdfEdDev(): PdfEditorDev | undefined {
  return (window as unknown as { __tarotingPdfDev?: PdfEditorDev }).__tarotingPdfDev;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | null | undefined | false, ms: number, what: () => string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what()}`);
    await sleep(20);
  }
}
const $ = <E extends Element = HTMLElement>(sel: string): E | null => document.querySelector<E>(sel);
const text = (sel: string): string => ($(sel)?.textContent ?? "").trim();
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

/** A file's bytes through the asset protocol, never from the HTTP cache. */
async function fileBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(mediaUrl(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`reading ${baseName(path)} back failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG's IHDR size, or null when the bytes are not a PNG. */
function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24 || PNG_MAGIC.some((m, i) => b[i] !== m)) return null;
  const be = (o: number): number => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
  return { w: be(16), h: be(20) };
}
/** A JPEG's frame size (the first SOFn), or null when the bytes are not a JPEG. */
function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    const len = (b[i + 2]! << 8) + b[i + 3]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (b[i + 5]! << 8) + b[i + 6]!, w: (b[i + 7]! << 8) + b[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}

export async function runPdfPagesBlocks(ctx: PdfPagesCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const src = `${fixturesDir}\\pdf\\plain_3p.pdf`;
  const haveFixture = await ipc.pathExists(src).catch(() => false);
  const needFixture = (): void => assert(haveFixture, "plain_3p.pdf is missing — run npm run fixtures");

  const stamp = Date.now().toString(36);
  const projectName = `Autotest pages ${stamp}`;
  let edPath = "";
  let outDir = "";
  const written = new Set<string>();
  const lastExportDir0 = settingsStore.get().lastExportDir;

  const scratchDir = async (): Promise<string> => {
    if (outDir) return outDir;
    const dir = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
    assert(/taroting-autotest/i.test(dir), `the scratch folder ${dir} is not inside the autotest root — refusing to write test output there`);
    outDir = dir;
    return dir;
  };

  /** Close the dialog (and menus), discard the temp session, park on Home. */
  const backHome = async (): Promise<void> => {
    try {
      closeMenu();
      for (const b of Array.from(document.querySelectorAll<HTMLElement>(".modal-backdrop"))) {
        const out = b.querySelector<HTMLElement>("[data-cancel], [data-close-btn], [data-close]");
        if (out) out.click();
        else b.remove();
      }
      const s = currentSession.get();
      if (s && s.temp.get()) await discardTempSession(s);
      navigate({ view: "home" });
      await until(() => $(".home") && !$(".editor"), 5_000, () => "Home");
    } catch (e) {
      console.error("pdf pages autotest: cleanup did not finish", e);
    }
  };

  const ensureEditor = async (): Promise<PdfEditorDev> => {
    const up = pdfEdDev();
    if (up && $(".pdfed") && currentSession.get() === up.session && up.session.project.name === projectName) return up;
    await backHome();
    const stat = await ipc.fileStat(src);
    assert(stat !== null, "plain_3p.pdf could not be stat'ed");
    const { countPages } = await import("../pdf/view/loader");
    const { createPdfProject } = await import("../core/pdf-project");
    const pages = await countPages(src);
    assert(pages === 3, `plain_3p.pdf has ${pages} pages, not 3`);
    const project = createPdfProject(projectName, { path: src, size: stat!.size, mtimeMs: stat!.mtimeMs, pages });
    edPath = await ipc.tempProjectPath(projectName);
    await ipc.saveProject(edPath, project);
    const prev = pdfEdDev();
    navigate({ view: "editor", projectPath: edPath, temp: true });
    const d = await until(
      () => {
        const d = pdfEdDev();
        return d && d !== prev && $(".pdfed") && d.session.project.name === projectName ? d : null;
      },
      8_000,
      () => "the PDF editor on plain_3p.pdf",
    );
    await shapePages(d);
    return d;
  };

  /** plain_3p.pdf's pages all have one size, so a wrong page (off by one,
   *  reordered) would export at the right size. Make every page's picture
   *  size its own, through the session like the other PDF blocks: page 2
   *  turned 90 degrees (landscape), page 3 replaced by a 400 x 300 pt blank.
   *  The temporary project is discarded by backHome. */
  const shapePages = async (d: PdfEditorDev): Promise<void> => {
    const { rotatePages, deletePages, insertBlankPage } = await import("../pdf/model");
    const s = d.session;
    const ids = s.project.pdf!.pages.map((pg) => pg.id);
    assert(ids.length === 3, `the project has ${ids.length} pages, not 3`);
    s.commit((p) => rotatePages(p, [ids[1]!], 90));
    s.commit((p) => deletePages(p, [ids[2]!]));
    s.commit((p) => insertBlankPage(p, 2, 400, 300));
    const got = s.project.pdf!.pages;
    assert(
      got.length === 3 && got[0]!.id === ids[0] && got[1]!.id === ids[1] && got[1]!.rotate === 90 && got[2]!.src === null && got[2]!.w === 400 && got[2]!.h === 300,
      `after rotate/delete/insert the pages are ${JSON.stringify(got.map((pg) => ({ src: pg.src, rotate: pg.rotate, w: pg.w, h: pg.h })))}`,
    );
  };

  /** The pixel size page `n` (1-based) must have, from its own page box (a
   *  blank page's size, else the source page's) and the dialog's fit. */
  const expectedSize = async (d: PdfEditorDev, n: number, scale: number): Promise<{ w: number; h: number }> => {
    const { pageImageSize } = await import("../pdf/editor/export-dialog");
    const pg = d.session.project.pdf!.pages[n - 1]!;
    let w: number;
    let h: number;
    let rotate: number = pg.rotate;
    if (pg.src === null) {
      w = pg.w!;
      h = pg.h!;
    } else {
      const doc = d.docs.get(pg.src);
      assert(!!doc, `page ${n}'s PDF is not open in the editor`);
      const info = await doc!.pageInfo(pg.page);
      w = info.w;
      h = info.h;
      rotate += info.rotate;
    }
    const s = pageImageSize(w, h, rotate, scale);
    return { w: s.w, h: s.h };
  };

  /** Every chosen page's expected size, refused unless they all differ (else
   *  a wrong page could still match). */
  const expectedSizes = async (d: PdfEditorDev, pages: readonly number[], scale: number): Promise<{ w: number; h: number }[]> => {
    const want = await Promise.all(pages.map((n) => expectedSize(d, n, scale)));
    const keys = want.map((s) => `${s.w}x${s.h}`);
    assert(new Set(keys).size === keys.length, `the fixture's pages are not distinguishable by size: ${keys.join(", ")}`);
    return want;
  };
  const sizeList = (pages: readonly number[], want: readonly { w: number; h: number }[]): string =>
    pages.map((n, i) => `page ${n} ${want[i]!.w}x${want[i]!.h}`).join(", ");

  const fire = (el: HTMLElement): void => {
    el.click();
  };
  const setInput = (sel: string, value: string): void => {
    const el = $<HTMLInputElement>(sel);
    assert(!!el, `${sel} is not in the dialog`);
    el!.value = value;
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** Open the Export dialog on the Image tab, pick `mode`, point it at the
   *  scratch folder and press Export. */
  const startRun = async (d: PdfEditorDev, mode: "all" | "range", setup?: () => void): Promise<void> => {
    const { openPdfExportDialog } = await import("../pdf/editor/export-dialog");
    openPdfExportDialog(d.ctx, { tab: "image" });
    const pagesBtn = await until(() => $<HTMLElement>(`[data-pages="${mode}"]`), 1_000, () => `the "${mode}" pages button`);
    fire(pagesBtn);
    setup?.();
    setInput("#px-folder", await scratchDir());
    const run = await until(() => {
      const b = $<HTMLButtonElement>("#px-run");
      return b && !b.disabled ? b : null;
    }, 1_000, () => `an enabled Export button (note: "${text("#px-note-img-range")}${text("#px-note-source")}")`);
    fire(run);
  };

  /** Wait for the run's end: the success view, else say what is on screen. */
  const awaitDone = async (): Promise<string> => {
    await until(
      () => !!($(".export-result__icon--ok") || $(".export-result__icon--bad") || $(".export-warn")),
      8_000,
      () => `the export to finish (phase "${text("#px-phase")}")`,
    );
    assert(!$(".export-warn"), `a warning strip instead of an export: "${text(".export-warn__msg")}"`);
    assert(!$(".export-result__icon--bad"), `the export failed: "${text(".export-result__msg")}"`);
    return text(".export-result__title");
  };

  const closeDialog = (): void => {
    $<HTMLElement>("[data-close-btn]")?.click();
  };

  await test("pdf-pages-png-all", async () => {
    const t0 = performance.now();
    try {
      needFixture();
      const d = await ensureEditor();
      const dir = await scratchDir();
      const { pageImageFileName } = await import("../pdf/editor/export-dialog");
      const paths = [1, 2, 3].map((n) => `${dir}\\${pageImageFileName(projectName, n, "png")}`);
      for (const p of paths) assert(!(await ipc.pathExists(p)), `${baseName(p)} is already there before the run`);
      paths.forEach((p) => written.add(p));

      await startRun(d, "all");
      const title = await awaitDone();
      assert(title === "Exported 3 pages", `the result says "${title}", not "Exported 3 pages"`);
      closeDialog();

      const want = await expectedSizes(d, [1, 2, 3], 100);
      const got: string[] = [];
      for (let i = 0; i < 3; i++) {
        const p = paths[i]!;
        assert(await ipc.pathExists(p), `${baseName(p)} was not written`);
        const size = pngSize(await fileBytes(p));
        assert(size !== null, `${baseName(p)} is not a PNG (no PNG signature)`);
        assert(
          Math.abs(size!.w - want[i]!.w) <= 1 && Math.abs(size!.h - want[i]!.h) <= 1,
          `${baseName(p)} is ${size!.w}x${size!.h}, page ${i + 1} must be ${want[i]!.w}x${want[i]!.h} (expected: ${sizeList([1, 2, 3], want)})`,
        );
        got.push(`${i + 1}: ${size!.w}x${size!.h}`);
      }
      // nothing else under the same names in the other format
      const stray = `${dir}\\${pageImageFileName(projectName, 1, "jpg")}`;
      assert(!(await ipc.pathExists(stray)), `${baseName(stray)} was written by a PNG run`);
      return `All pages → 3 PNGs named "${projectName} - page N.png" (${got.join(", ")}) — ${ms(t0)}`;
    } finally {
      closeDialog();
    }
  });

  await test("pdf-pages-jpeg-range-replace", async () => {
    const t0 = performance.now();
    try {
      needFixture();
      const d = await ensureEditor();
      const dir = await scratchDir();
      const { pageImageFileName } = await import("../pdf/editor/export-dialog");
      const paths = [2, 3].map((n) => `${dir}\\${pageImageFileName(projectName, n, "jpg")}`);
      const page1 = `${dir}\\${pageImageFileName(projectName, 1, "jpg")}`;
      paths.forEach((p) => written.add(p));
      written.add(page1);
      for (const p of [...paths, page1]) assert(!(await ipc.pathExists(p)), `${baseName(p)} is already there before the run`);

      const rangeJpeg200 = (): void => {
        setInput("#px-img-from", "2");
        setInput("#px-img-to", "3");
        $<HTMLElement>('[data-format="jpeg"]')!.click();
        $<HTMLElement>('[data-scale="200"]')!.click();
      };
      await startRun(d, "range", rangeJpeg200);
      const title = await awaitDone();
      assert(title === "Exported 2 pages", `the first run says "${title}", not "Exported 2 pages"`);
      closeDialog();
      const before = await Promise.all(paths.map((p) => ipc.fileStat(p)));
      assert(before.every((s) => s !== null), "the first run did not write both pages");
      await sleep(30);

      // Second run onto the same names: one strip with the count, then Replace.
      await startRun(d, "range", rangeJpeg200);
      const strip = await until(() => $(".export-warn__msg"), 2_000, () => "the replace strip");
      assert(strip.textContent === "2 files in this folder will be replaced.", `the strip says "${strip.textContent}"`);
      assert(document.activeElement === $('[data-w="cancel"]'), "the strip's Cancel is not focused");
      $<HTMLElement>('[data-w="replace"]')!.click();
      const title2 = await awaitDone();
      assert(title2 === "Exported 2 pages", `the replace run says "${title2}"`);
      closeDialog();

      // pages 1-3 differ (checked), so page 1's size cannot stand in either
      const want = await expectedSizes(d, [2, 3, 1], 200);
      const got: string[] = [];
      for (let i = 0; i < 2; i++) {
        const p = paths[i]!;
        const st = await ipc.fileStat(p);
        assert(st !== null && st.mtimeMs > before[i]!.mtimeMs, `${baseName(p)} was not rewritten by Replace`);
        const size = jpegSize(await fileBytes(p));
        assert(size !== null, `${baseName(p)} is not a JPEG (no SOI / frame header)`);
        assert(
          Math.abs(size!.w - want[i]!.w) <= 1 && Math.abs(size!.h - want[i]!.h) <= 1,
          `${baseName(p)} is ${size!.w}x${size!.h}, page ${i + 2} must be ${want[i]!.w}x${want[i]!.h} at 200 % (expected: ${sizeList([2, 3, 1], want)})`,
        );
        got.push(`${i + 2}: ${size!.w}x${size!.h}`);
      }
      assert(!(await ipc.pathExists(page1)), "page 1 was written although the range was 2 to 3");
      return `Page range 2-3, JPEG 200 % → ${got.join(", ")}; second run: "2 files in this folder will be replaced.", Cancel focused, Replace rewrote both — ${ms(t0)}`;
    } finally {
      closeDialog();
      for (const p of written) await removeTestFile(p).catch(() => {});
      written.clear();
      await backHome();
      if (edPath) await ipc.deleteProject(edPath).catch(() => {});
      edPath = "";
      if (settingsStore.get().lastExportDir !== lastExportDir0) await updateSettings({ lastExportDir: lastExportDir0 }).catch(() => {});
    }
  });
}
