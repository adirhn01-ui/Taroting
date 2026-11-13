// 0.9.5 E2E blocks: how a PDF project's text boxes export. DEV-only:
// imported lazily by autotest.ts, never part of a release bundle.
//
// NOTHING under src/fonts or src/pdf is imported statically here: each block
// reaches the module it drives with `await import(...)` (type-only imports
// are erased), so loading this file loads no lazy chunk as a side effect.
//
// The blocks build a one-page PDF project in memory (a blank Letter page, no
// source file), export it through the app's own path (`exportPdf` with the
// app's dependencies: the WebView's canvas, the asset protocol, the save
// IPC) into the autotest scratch folder, and read the file back with the
// app's pdf.js: its text content, its operator list and its pixels. Every
// file a block writes is deleted in its finally.
//
// 1. pdf-arabic-real-text: a box with a mixed Arabic / Latin / digits
//    paragraph and an Arabic-only box export as TEXT (no picture operator on
//    the page), pdf.js reads the Arabic back in logical order (each Arabic
//    box as one item, its lam-alef ligature lam then alef), and a box
//    with a colour run inside a word paints exactly as the same box without
//    runs (the word stays joined).
// 2. pdf-mixed-fonts-last-line: a box in Arial with a run in a library font
//    of very different metrics (Consolas, a stock Windows file imported into
//    the autotest library) sized exactly as the editor sizes it: every
//    exported baseline within half a point of the editor's row, and the last
//    line (with descenders) drawn whole: the fitted box's pixels equal a
//    taller box's.

import { invoke } from "@tauri-apps/api/core";
import { errorDetail, ipc } from "../core/ipc";
import type { FontId, PdfAnnot, ProjectFile } from "../core/types";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type PdfTextCtx = Wave1Ctx;

type TextMark = Extract<PdfAnnot, { t: "text" }>;

const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

const CONSOLAS_FILE = "C:\\Windows\\Fonts\\consola.ttf";
const LIB_ID: FontId = "lib:Consolas";
const PAGE_W = 612;
const PAGE_H = 792;
/** Rendering scale for pixel checks (px per point). */
const SCALE = 2;

const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const f2 = (n: number): string => n.toFixed(2);

async function within<T>(p: Promise<T>, msMax: number, what: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`timed out after ${msMax} ms waiting for ${what}`)), msMax);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- the slice of pdf.js the blocks read ---------------- */

interface TextItemLite {
  str?: string;
  transform?: number[];
  fontName?: string;
}
interface PageLite {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: TextItemLite[] }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
  render(o: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}
interface ProxyLite {
  numPages: number;
  getPage(n: number): Promise<PageLite>;
}

/** A one-page PDF project on a blank Letter page holding `marks`. */
function pdfProject(marks: PdfAnnot[]): ProjectFile {
  const pageId = `p-${Math.random().toString(36).slice(2, 8)}`;
  return {
    schema: 4,
    kind: "pdf",
    app: "taroting",
    id: `autotest-pdf-text-${Date.now().toString(36)}`,
    name: "autotest pdf text",
    createdAt: "",
    modifiedAt: "",
    media: [],
    timeline: { tracks: [] } as unknown as ProjectFile["timeline"],
    export: {} as ProjectFile["export"],
    pdf: { sources: [], pages: [{ id: pageId, src: null, page: 0, rotate: 0, w: PAGE_W, h: PAGE_H }], annots: { [pageId]: marks }, forms: {} },
  } as ProjectFile;
}

const textMark = (over: Partial<TextMark>): TextMark => ({
  id: `t-${Math.random().toString(36).slice(2, 8)}`,
  t: "text",
  x: 72,
  y: 90,
  w: 400,
  h: 60,
  text: "",
  font: "Arial",
  size: 20,
  c: "#000000",
  bold: false,
  italic: false,
  align: "left",
  ...over,
});

/** Luma of a rendered page (0..255), row-major, `w` × `h` px. */
interface Luma {
  w: number;
  h: number;
  y: Uint8ClampedArray;
}

/** Ink (luma < 160) inside a page-space rect (points, y down), and outside it
 *  within `pad` points around it. */
function inkAround(l: Luma, x: number, y: number, w: number, h: number, pad: number): { inside: number; outside: number; bottom: number } {
  let inside = 0;
  let outside = 0;
  let bottom = -Infinity;
  const X0 = Math.floor((x - pad) * SCALE);
  const X1 = Math.ceil((x + w + pad) * SCALE);
  const Y0 = Math.floor((y - pad) * SCALE);
  const Y1 = Math.ceil((y + h + pad) * SCALE);
  for (let py = Math.max(0, Y0); py < Math.min(l.h, Y1); py++) {
    for (let px = Math.max(0, X0); px < Math.min(l.w, X1); px++) {
      if (l.y[py * l.w + px]! >= 160) continue;
      const ptX = (px + 0.5) / SCALE;
      const ptY = (py + 0.5) / SCALE;
      if (ptX >= x && ptX <= x + w && ptY >= y && ptY <= y + h) {
        inside++;
        if (ptY > bottom) bottom = ptY;
      } else outside++;
    }
  }
  return { inside, outside, bottom };
}

/* ================================================================== */

export async function runPdfTextExportBlocks(ctx: PdfTextCtx): Promise<void> {
  const { test, assert } = ctx;

  /** Scratch output: the autotest root, never the repo or the owner's folders. */
  let outDir = "";
  const scratchDir = async (): Promise<string> => {
    if (outDir) return outDir;
    const dir = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
    assert(/taroting-autotest/i.test(dir), `the scratch folder ${dir} is not inside the autotest root — refusing to write test output there`);
    outDir = dir;
    return dir;
  };

  /** Export `project` flattened into the scratch folder; the written path. */
  const exportTo = async (project: ProjectFile, tag: string, outs: string[]): Promise<{ path: string; bytes: number; ms: number }> => {
    const dir = await scratchDir();
    const target = `${dir}\\autotest-pdf-text-${tag}-${Date.now().toString(36)}.pdf`;
    outs.push(target);
    const { exportPdf } = await import("../pdf/export/export");
    const t = performance.now();
    const res = await within(exportPdf(project, { flattenMarks: true, flattenForms: false }, target), 8_000, `the ${tag} export`).catch((e: unknown) => {
      throw new Error(`the ${tag} export failed: ${errorDetail(e).message}`);
    });
    if (res.path !== target) outs.push(res.path);
    return { path: res.path, bytes: res.bytes, ms: Math.round(performance.now() - t) };
  };

  /** Open an exported file with the app's pdf.js; page 1. */
  const openFirstPage = async (path: string, opened: { destroy(): Promise<void> }[]): Promise<{ page: PageLite; ops: Record<string, number> }> => {
    const { openPdf } = await import("../pdf/view");
    const { loadPdfjs } = await import("../pdf/view/pdfjs");
    const pdfjs = (await loadPdfjs()) as unknown as { OPS: Record<string, number> };
    const doc = await within(openPdf(`autotest-pdf-text-${opened.length}`, path), 5_000, `pdf.js to open ${path}`);
    opened.push(doc);
    const proxy = doc.doc as ProxyLite;
    assert(proxy.numPages === 1, `the export has ${proxy.numPages} pages, not 1`);
    return { page: await proxy.getPage(1), ops: pdfjs.OPS };
  };

  /** Page 1 rendered at SCALE with annotations off, as luma. */
  const paint = async (page: PageLite): Promise<Luma> => {
    const { loadPdfjs } = await import("../pdf/view/pdfjs");
    const pdfjs = (await loadPdfjs()) as unknown as { AnnotationMode: { DISABLE: number } };
    const vp = page.getViewport({ scale: SCALE });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    try {
      await page.render({ canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE, background: "#ffffff" }).promise;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const y = new Uint8ClampedArray(c.width * c.height);
      for (let i = 0; i < y.length; i++) y[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
      return { w: c.width, h: c.height, y };
    } finally {
      c.width = 0;
      c.height = 0;
    }
  };

  await test("pdf-arabic-real-text", async () => {
    const t0 = performance.now();
    const outs: string[] = [];
    const opened: { destroy(): Promise<void> }[] = [];
    try {
      const MIXED = "مرحبا بالعالم Hello 2026";
      const ARABIC = "سلام عليكم";
      const mixed = textMark({ text: MIXED, x: 72, y: 90, w: 420, h: 40 });
      const pure = textMark({ text: ARABIC, x: 72, y: 200, w: 300, h: 40, size: 24, align: "right" });
      // the same box with a colour run INSIDE the first word (an
      // all-but-black "لا"): drawn in three pieces, it must still be joined
      // exactly as the box without runs
      const joined = { ...pure, id: `${pure.id}-runs`, y: 300, runs: [{ s: 1, e: 3, c: "#010101" }] };
      const out = await exportTo(pdfProject([mixed, pure, joined]), "arabic", outs);
      const { page, ops } = await openFirstPage(out.path, opened);

      // Text, not a picture: no image painting on the page, text shown.
      const list = await page.getOperatorList();
      const imageOps = ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintImageXObjectRepeat"].map((k) => ops[k]).filter((v): v is number => typeof v === "number");
      const images = list.fnArray.filter((f) => imageOps.includes(f)).length;
      const shows = list.fnArray.filter((f) => f === ops["showText"]).length;
      assert(images === 0, `the export paints ${images} picture(s): an Arabic box was rasterized (${list.fnArray.length} operators)`);
      // mixed: the Latin + digits group and the Arabic group (2); Arabic-only
      // box: one shaped run (1); the run box: before, in and after the run (3)
      assert(shows === 6, `the export shows text ${shows} time(s), not 6 (2 visual groups + 1 shaped run + 3 pieces of the run box)`);

      // pdf.js reads the text back in logical order.
      const tc = await page.getTextContent();
      const items = tc.items.filter((i) => typeof i.str === "string" && i.str.trim() !== "");
      const all = items.map((i) => i.str!).join(" ");
      const shown = items.map((i) => JSON.stringify(i.str)).join(", ");
      for (const w of ["مرحبا", "بالعالم", "Hello", "2026"]) assert(all.includes(w), `pdf.js reads no "${w}" in the export (items: ${shown})`);
      assert(!all.includes("ابحرم"), `pdf.js reads "مرحبا" reversed (items: ${shown})`);
      // each one-line Arabic box (with and without the run inside its first
      // word) reads back as ONE item, exactly the text typed: a lam-alef
      // ligature must come back lam then alef
      const inBox = (b: TextMark) => (i: TextItemLite): boolean => i.transform !== undefined && PAGE_H - i.transform[5]! > b.y && PAGE_H - i.transform[5]! < b.y + b.h;
      for (const [b, what] of [[pure, "the Arabic-only box"], [joined, "the Arabic box with a run inside a word"]] as const) {
        const found = items.filter(inBox(b)).map((i) => i.str!.trim());
        assert(found.length === 1 && found[0] === ARABIC, `${what} reads back as ${found.length ? found.map((s) => JSON.stringify(s)).join(" + ") : "no text item at all"}, not ${JSON.stringify(ARABIC)} (items: ${shown})`);
      }

      // Pixels: ink in each box (the export clips every box to its frame, so
      // ink OUTSIDE a box proves nothing and is not asked), and the run box
      // painted exactly as the box without runs: the same joined glyphs at
      // the same places (isolated letters would differ in hundreds of px).
      const l = await paint(page);
      page.cleanup();
      const inkM = inkAround(l, mixed.x, mixed.y, mixed.w, mixed.h, 0);
      const inkP = inkAround(l, pure.x, pure.y, pure.w, pure.h, 0);
      assert(inkM.inside > 200 && inkP.inside > 200, `too little ink inside the boxes (mixed ${inkM.inside} px, Arabic ${inkP.inside} px)`);
      let differ = 0;
      const dy = Math.round((joined.y - pure.y) * SCALE);
      for (let py = Math.floor(pure.y * SCALE); py < Math.ceil((pure.y + pure.h) * SCALE); py++) {
        for (let px = Math.floor(pure.x * SCALE); px < Math.ceil((pure.x + pure.w) * SCALE); px++) {
          if (Math.abs(l.y[py * l.w + px]! - l.y[(py + dy) * l.w + px]!) > 48) differ++;
        }
      }
      assert(differ <= 4, `the box with a run inside a word paints ${differ} px differently from the same box without runs: its word is not joined as the editor shows it`);
      return `export ${out.ms} ms (${out.bytes} B): ${list.fnArray.length} operators, ${shows} text shows, 0 pictures; pdf.js items ${shown}; ink mixed ${inkM.inside} / Arabic ${inkP.inside} px; run box differs in ${differ} px — ${ms(t0)}`;
    } finally {
      for (const d of opened) await d.destroy().catch(() => {});
      for (const o of outs) await removeTestFile(o).catch(() => {});
    }
  });

  await test("pdf-mixed-fonts-last-line", async () => {
    const t0 = performance.now();
    const outs: string[] = [];
    const opened: { destroy(): Promise<void> }[] = [];
    let imported = false;
    const rt = await import("../fonts");
    try {
      // Consolas in the (autotest) library: its box is 0.92 + 0.25 em against
      // its hhea 0.74 + 0.26 em, so the old export laid its row out taller.
      const cat = await within(rt.fontCatalog(), 3_000, "the font catalogue (fonts_list)");
      if (!cat.library.some((f) => f.id === LIB_ID)) {
        const res = await within(rt.importFonts([CONSOLAS_FILE]), 3_000, `importFonts(${CONSOLAS_FILE})`);
        assert(res[0] !== undefined && (res[0].ok || res[0].error === "exists"), `importing ${CONSOLAS_FILE} failed: ${JSON.stringify(res[0])}`);
        imported = res[0]!.ok === true;
      }
      await within(rt.ensureFonts([{ id: LIB_ID, bold: false, italic: false }]), 3_000, "lib:Consolas to load");
      const face = rt.fontFace("Arial", LIB_ID, false, false);
      assert(!face.missing, `lib:Consolas is missing after the import (${JSON.stringify(face)})`);

      const LINE1 = "first line";
      const LINE2 = "second CODE here";
      const LINE3 = "third gyp";
      const text = `${LINE1}\n${LINE2}\n${LINE3}`;
      const S = LINE1.length + 1 + "second ".length;
      const base = textMark({ text, font: "Arial", size: 12, x: 80, y: 120, w: 300, h: 100, runs: [{ s: S, e: S + 4, font: "Arial", fontId: LIB_ID }] });

      // The editor's own rows and the height it gives the box.
      const { textRows, textBoxHeight } = await import("../pdf/editor/marks/render");
      const rows = textRows(base);
      const fitH = textBoxHeight(base);
      assert(rows.length === 3, `the editor lays the box out in ${rows.length} rows, not 3`);
      const fitted = { ...base, h: fitH };
      const tall = { ...base, id: `${base.id}-tall`, x: 80, y: 420, h: fitH + 40 };

      const outF = await exportTo(pdfProject([fitted]), "fitted", outs);
      const outT = await exportTo(pdfProject([tall]), "tall", outs);
      const pf = await openFirstPage(outF.path, opened);
      const pt = await openFirstPage(outT.path, opened);

      // Baselines: pdf.js text items, page space (y down) below the box top.
      const tc = await pf.page.getTextContent();
      const ys = [...new Set(tc.items.filter((i) => (i.str ?? "").trim() !== "" && i.transform).map((i) => Math.round((PAGE_H - i.transform![5]! - fitted.y) * 1000) / 1000))].sort((a, b) => a - b);
      const screen = rows.map((r) => r.top + r.baseline);
      const shown = `export ${ys.map(f2).join(" / ")} pt, editor ${screen.map(f2).join(" / ")} pt (rows ${rows.map((r) => f2(r.height)).join(" + ")} = ${f2(fitH)} pt)`;
      assert(ys.length === 3, `the export's text sits on ${ys.length} baselines, not 3 — ${shown}`);
      ys.forEach((y, i) => assert(Math.abs(y - screen[i]!) <= 0.5, `line ${i + 1}'s baseline is ${f2(y - screen[i]!)} pt off the editor's — ${shown}`));

      // The last line whole: inside the fitted box exactly the ink of the
      // same box drawn with room to spare.
      const lf = await paint(pf.page);
      const lt = await paint(pt.page);
      pf.page.cleanup();
      pt.page.cleanup();
      const inkF = inkAround(lf, fitted.x, fitted.y, fitted.w, fitted.h, 0);
      const inkT = inkAround(lt, tall.x, tall.y, tall.w, fitH, 0);
      const below = inkAround(lt, tall.x, tall.y + fitH, tall.w, 40, 0);
      let diff = 0;
      const dy = Math.round((tall.y - fitted.y) * SCALE);
      for (let py = Math.floor(fitted.y * SCALE); py < Math.ceil((fitted.y + fitH) * SCALE); py++) {
        for (let px = Math.floor(fitted.x * SCALE); px < Math.ceil((fitted.x + fitted.w) * SCALE); px++) {
          if (Math.abs(lf.y[py * lf.w + px]! - lt.y[(py + dy) * lt.w + px]!) > 48) diff++;
        }
      }
      assert(inkF.inside > 300, `too little ink in the fitted box (${inkF.inside} px)`);
      assert(below.inside === 0, `the tall box has ${below.inside} px of ink below the editor's height (${f2(fitH)} pt): the last line reaches past it — ${shown}`);
      assert(diff <= 4, `the fitted box differs from the tall one in ${diff} px: its last line is clipped (ink ${inkF.inside} vs ${inkT.inside} px, lowest ink ${f2(inkF.bottom - fitted.y)} vs ${f2(inkT.bottom - tall.y)} pt) — ${shown}`);
      return `${shown}; ink fitted ${inkF.inside} px = tall ${inkT.inside} px (${diff} px differ), none below the box; exports ${outF.ms} + ${outT.ms} ms — ${ms(t0)}`;
    } finally {
      for (const d of opened) await d.destroy().catch(() => {});
      for (const o of outs) await removeTestFile(o).catch(() => {});
      if (imported) await rt.removeFont(LIB_ID).catch(() => {});
    }
  });
}
