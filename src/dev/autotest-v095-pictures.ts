// 0.9.5 E2E blocks: pictures as PDF pages. DEV-only, loaded lazily by the
// harness; nothing under src/pdf is imported statically (the PDF editor, the
// view, pdf.js and the export are lazy chunks: every runtime module a block
// drives is reached with `await import(...)` inside it).
//
// Three blocks, one PDF editor mount each, on a TEMPORARY project made from
// plain_3p.pdf (deleted in finally):
//   (a) pictures-as-pages-insert — two fixture pictures of different shapes
//       (image_grid_641x361.png, landscape; photo_o6.jpg, 64x36 coded with
//       EXIF orientation 6 → shown 36x64, portrait) inserted after page 1
//       through the page panel's own op; asserted ON SCREEN: each new page's
//       box has its picture's aspect, the page picture's node covers the page
//       box and is what a point inside it shows, its file decodes, and a
//       Select click on it selects nothing (while a click on a mark placed
//       over it selects that mark — so the click provably reached the tools).
//       Then the grid's page turned 90 degrees: its box and its picture's
//       painted box turn with it, and the rail shows it from the small cached
//       thumbnail (not the original), turned too.
//   (b) pictures-as-pages-export — the same project exported (marks kept as
//       annotations) to a scratch PDF; asserted FROM ITS BYTES: page count and
//       MediaBoxes, the first thing each picture page paints is a form whose
//       resources hold an /Image XObject, no annotation stands for the
//       pictures, and pdf.js (annotations off) paints the grid's colours where
//       the picture's quadrants are.
//   (c) pictures-as-pages-cover — a project whose FIRST page is a picture
//       page, kept: its Home card picture is really written (recents entry,
//       file on disk) and is the picture, not a blank white card.

import { invoke } from "@tauri-apps/api/core";
import { errorDetail, ipc, mediaUrl } from "../core/ipc";
import { navigate } from "../core/nav";
import { currentSession, type ProjectSession } from "../core/session";
import type { PdfAnnot } from "../core/types";
import type { PdfDoc, PdfEditorCtx, PdfView } from "../pdf/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the PDF blocks (autotest-pdf.ts runPdfBlocks). */
export type PicturePagesCtx = Wave1Ctx;

const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

/** What the PDF editor publishes on window while mounted (shell.ts, DEV). */
interface PdfEditorDev {
  session: ProjectSession;
  ctx: PdfEditorCtx;
  view: PdfView;
  docs: ReadonlyMap<string, PdfDoc>;
  panel: {
    ops: {
      insertPictures(afterSlot: number, given?: { paths?: readonly string[]; sizing?: "picture" | "a4" | "letter" }): Promise<void>;
      rotate(slots: readonly number[], delta: 90 | -90): void;
    };
  };
}
interface PdfPageLite {
  view: number[];
  getAnnotations(): Promise<{ subtype?: string }[]>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfProxyLite {
  numPages: number;
  getPage(n: number): Promise<PdfPageLite>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pageRaf = window.requestAnimationFrame.bind(window);
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => pageRaf(() => r()));
};
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
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
function rendered(el: Element | null): el is HTMLElement {
  return el instanceof Element && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}
function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}
function pdfEdDev(): PdfEditorDev | undefined {
  return (window as unknown as { __tarotingPdfDev?: PdfEditorDev }).__tarotingPdfDev;
}
const onScreen = (): string => ($(".pdfed") ? "PDF editor" : $(".home") ? "home" : $("#vw") ? "viewer" : "?");

/** Mean colour of a w×h square at (x, y) of a canvas. */
function meanRgb(c: HTMLCanvasElement, x: number, y: number, r = 3): [number, number, number] {
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const d = g.getImageData(Math.max(0, Math.round(x) - r), Math.max(0, Math.round(y) - r), 2 * r + 1, 2 * r + 1).data;
  let R = 0;
  let G = 0;
  let B = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    R += d[i]!;
    G += d[i + 1]!;
    B += d[i + 2]!;
  }
  return [Math.round(R / n), Math.round(G / n), Math.round(B / n)];
}
const near = (a: readonly number[], b: readonly number[], tol: number): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

export async function runPicturePagesBlocks(ctx: PicturePagesCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const SRC = `${fixturesDir}\\pdf\\plain_3p.pdf`;
  const GRID = `${fixturesDir}\\image_grid_641x361.png`;
  const TURNED = `${fixturesDir}\\photo_o6.jpg`;
  /** image_grid_641x361.png's quadrant colours (scripts/make-fixtures.mjs). */
  const GRID_TL = [224, 64, 32];
  const GRID_BR = [32, 192, 96];

  const present = await Promise.all([SRC, GRID, TURNED].map((f) => ipc.pathExists(f).catch(() => false)));
  const needFixtures = (): void => assert(present.every(Boolean), "fixtures missing (plain_3p.pdf, image_grid_641x361.png, photo_o6.jpg) — run npm run fixtures");

  let projectPath = "";
  /** The two picture pages' ids, and their pictures' mark ids, once inserted. */
  let made: { pages: [string, string]; marks: [string, string] } | null = null;

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
      console.error("picture pages autotest: cleanup did not finish", e);
    }
  };

  /** Mount the PDF editor on a fresh temporary project of plain_3p.pdf. */
  const mountEditor = async (): Promise<PdfEditorDev> => {
    await backHome();
    const stat = await ipc.fileStat(SRC);
    assert(stat !== null, "plain_3p.pdf could not be stat'ed");
    const { countPages } = await import("../pdf/view/loader");
    const { createPdfProject } = await import("../core/pdf-project");
    const project = createPdfProject("Autotest picture pages", { path: SRC, size: stat!.size, mtimeMs: stat!.mtimeMs, pages: await countPages(SRC) });
    projectPath = await ipc.tempProjectPath("Autotest picture pages");
    await ipc.saveProject(projectPath, project);
    const prev = pdfEdDev();
    navigate({ view: "editor", projectPath, temp: true });
    return until(
      () => {
        const d = pdfEdDev();
        return d && d !== prev && $(".pdfed") && d.panel ? d : null;
      },
      8_000,
      () => `the PDF editor on plain_3p.pdf — ${onScreen()}`,
    );
  };

  /** Insert the two pictures after page 1 through the page panel's op. */
  const insertPictures = async (d: PdfEditorDev): Promise<{ pages: [string, string]; marks: [string, string] }> => {
    const before = d.session.project.pdf!.pages.map((pg) => pg.id);
    await d.panel.ops.insertPictures(0, { paths: [GRID, TURNED], sizing: "picture" });
    const after = d.session.project.pdf!.pages.map((pg) => pg.id);
    assert(after.length === before.length + 2, `inserting 2 pictures made ${after.length - before.length} pages`);
    assert(after[0] === before[0] && after[3] === before[1], `the pictures did not land after page 1 (order ${after.join(",")})`);
    // ONE undo step takes both away; redo brings both back
    d.session.undo();
    const undone = d.session.project.pdf!.pages.map((pg) => pg.id);
    assert(undone.join(",") === before.join(","), `one undo left ${undone.length} pages, not ${before.length}`);
    d.session.redo();
    assert(d.session.project.pdf!.pages.map((pg) => pg.id).join(",") === after.join(","), "redo did not bring both picture pages back");
    const { pageAnnots, isPagePicture } = await import("../pdf/model");
    const ids: [string, string] = [after[1]!, after[2]!];
    const marks = ids.map((id) => {
      const list = pageAnnots(d.session.project, id);
      assert(list.length === 1 && isPagePicture(list[0]!), `page ${id} carries ${JSON.stringify(list).slice(0, 160)}, not one page picture`);
      return list[0]!.id;
    }) as [string, string];
    return { pages: ids, marks };
  };

  await test("pictures-as-pages-insert", async () => {
    const t0 = performance.now();
    const restore: (() => void)[] = [];
    try {
      needFixtures();
      const d = await mountEditor();
      made = await insertPictures(d);
      const [gridPage, turnedPage] = made.pages;
      const pages = d.session.project.pdf!.pages;
      const pg1 = pages[1]!;
      const pg2 = pages[2]!;
      // Picture size: 641x361 px → 480.75 x 270.75 pt; 36x64 (shown) → 27 x 48 pt.
      assert(pg1.w === 480.75 && pg1.h === 270.75, `the grid's page is ${pg1.w} x ${pg1.h} pt, not 480.75 x 270.75`);
      assert(pg2.w === 27 && pg2.h === 48, `the turned photo's page is ${pg2.w} x ${pg2.h} pt, not 27 x 48 (its EXIF turn was lost?)`);

      const stage = $("#pdfed-stage")!;
      const checks: string[] = [];
      for (const [i, key] of [gridPage, turnedPage].entries()) {
        d.view.scrollToPage(i + 1);
        const pageEl = await until(() => {
          const e = $(`.pdfv-page[data-key="${key}"]`, stage);
          return e && rendered(e) ? e : null;
        }, 3_000, () => `page ${i + 2}'s box in the strip`);
        const node = await until(
          () => d.view.overlay(key)?.querySelector<SVGImageElement>(`.pdfmk-marks image[data-id="${made!.marks[i]}"]`) ?? null,
          3_000,
          () => `page ${i + 2}'s page picture node`,
        );
        await frames(2);
        const pr = pageEl.getBoundingClientRect();
        const want = i === 0 ? 641 / 361 : 36 / 64;
        const got = pr.width / pr.height;
        assert(Math.abs(got - want) / want < 0.02, `page ${i + 2}'s box is ${Math.round(pr.width)}x${Math.round(pr.height)} (aspect ${got.toFixed(3)}), its picture's is ${want.toFixed(3)}`);
        const nr = node.getBoundingClientRect();
        const covers = Math.abs(nr.left - pr.left) <= 2 && Math.abs(nr.top - pr.top) <= 2 && Math.abs(nr.right - pr.right) <= 2 && Math.abs(nr.bottom - pr.bottom) <= 2;
        assert(covers, `page ${i + 2}'s picture is drawn at ${Math.round(nr.left)},${Math.round(nr.top)}–${Math.round(nr.right)},${Math.round(nr.bottom)}, its page box is ${Math.round(pr.left)},${Math.round(pr.top)}–${Math.round(pr.right)},${Math.round(pr.bottom)}`);
        // Painted: its file decodes, and a point inside the page shows it (the
        // mark layer opts out of hit testing: opted in for the probe alone).
        const href = node.getAttribute("href") ?? "";
        const img = new Image();
        img.src = href;
        await img.decode().catch(() => {
          throw new Error(`page ${i + 2}'s picture (${href}) does not decode`);
        });
        assert(img.naturalWidth > 0, `page ${i + 2}'s picture decodes to ${img.naturalWidth} px`);
        const was = node.style.pointerEvents;
        node.style.pointerEvents = "auto";
        restore.push(() => {
          node.style.pointerEvents = was;
        });
        const cx = pr.left + pr.width / 2;
        const cy = pr.top + pr.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        assert(hit === node, `page ${i + 2}'s centre shows ${describeEl(hit)}, not its picture`);
        for (const f of restore.splice(0)) f();
        checks.push(`p${i + 2} ${Math.round(pr.width)}x${Math.round(pr.height)} (${got.toFixed(3)}), picture ${img.naturalWidth}x${img.naturalHeight} decoded, covers the box`);
      }

      // Select: a click on the picture selects nothing; on a whiteout placed
      // over it, the whiteout (so the clicks provably reach the tools).
      const { addAnnot, newId, removeAnnots } = await import("../pdf/model");
      const wid = newId();
      const white: PdfAnnot = { id: wid, t: "whiteout", x: 20, y: 20, w: 100, h: 60, c: "#ffffff" };
      d.session.commit((p) => addAnnot(p, gridPage, white));
      restore.push(() => d.session.commit((p) => removeAnnots(p, [{ pageId: gridPage, id: wid }])));
      d.ctx.tools.update((t) => (t.tool === "select" ? t : { ...t, tool: "select" }));
      d.ctx.selection.set([]);
      d.view.scrollToPage(1);
      await until(() => d.view.overlay(gridPage)?.querySelector(`[data-id="${wid}"]`), 3_000, () => "the whiteout's node");
      await frames(2);
      const click = (x: number, y: number): string => {
        const c = d.view.pageToClient(gridPage, x, y);
        assert(c !== null, "the grid's page is not mapped");
        const target = document.elementFromPoint(c!.x, c!.y) ?? stage;
        assert(d.view.el.contains(target), `page point ${x},${y} shows ${describeEl(target)}, not the page strip`);
        const o = { bubbles: true, cancelable: true, composed: true, clientX: c!.x, clientY: c!.y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
        target.dispatchEvent(new PointerEvent("pointerdown", { ...o, buttons: 1 }));
        target.dispatchEvent(new PointerEvent("pointerup", o));
        return describeEl(target);
      };
      const onWhite = click(70, 50);
      const selWhite = d.ctx.selection.get();
      assert(selWhite.length === 1 && selWhite[0]!.id === wid, `a Select click on the whiteout (target ${onWhite}) selected ${JSON.stringify(selWhite)} — the clicks do not reach the tools`);
      const onPicture = click(380, 200);
      const selPic = d.ctx.selection.get();
      assert(selPic.length === 0, `a Select click on the page picture (target ${onPicture}) selected ${JSON.stringify(selPic)}`);
      for (const f of restore.splice(0)) f();

      // Turned: the grid's page (slot 1) a quarter turn right. Its box and
      // the picture's painted box turn with it; the rail's thumbnail too, from
      // the small cached thumbnail.
      d.panel.ops.rotate([1], 90);
      restore.push(() => d.panel.ops.rotate([1], -90));
      d.view.scrollToPage(1);
      const turnedAspect = 361 / 641;
      const tEl = await until(
        () => {
          const e = $(`.pdfv-page[data-key="${gridPage}"]`, stage);
          if (!e || !rendered(e)) return null;
          const r = e.getBoundingClientRect();
          return Math.abs(r.width / r.height - turnedAspect) / turnedAspect < 0.02 ? e : null;
        },
        2_000,
        () => `the turned grid page's box to be portrait (${turnedAspect.toFixed(3)})`,
      );
      await frames(2);
      const tr = tEl.getBoundingClientRect();
      const tNode = d.view.overlay(gridPage)?.querySelector<SVGImageElement>(`.pdfmk-marks image[data-id="${made.marks[0]}"]`);
      assert(!!tNode, "the turned page lost its page picture node");
      const tn = tNode!.getBoundingClientRect();
      const tCovers = Math.abs(tn.left - tr.left) <= 2 && Math.abs(tn.top - tr.top) <= 2 && Math.abs(tn.right - tr.right) <= 2 && Math.abs(tn.bottom - tr.bottom) <= 2;
      assert(
        tCovers,
        `the turned page's picture is painted at ${Math.round(tn.left)},${Math.round(tn.top)}–${Math.round(tn.right)},${Math.round(tn.bottom)}, its box is ${Math.round(tr.left)},${Math.round(tr.top)}–${Math.round(tr.right)},${Math.round(tr.bottom)}`,
      );
      const railRow = $(`.pdfed-rail .pdfv-thumb[data-slot="1"]`);
      assert(railRow !== null, "the rail has no item for page 2");
      railRow!.scrollIntoView({ block: "nearest" });
      const railImg = await until(
        () => {
          const i = railRow!.querySelector<HTMLImageElement>(".pdfv-thumb__pic img");
          return i && i.complete && i.naturalWidth > 0 ? i : null;
        },
        2_000,
        () => "the rail's page picture to load",
      );
      assert(railImg.src !== mediaUrl(GRID), `the rail shows the original file (${railImg.src}), not the cached thumbnail`);
      assert(railImg.naturalWidth <= 320, `the rail's picture is ${railImg.naturalWidth} px wide: not the small thumbnail`);
      const hr = railImg.closest(".pdfv-thumb__pic")!.getBoundingClientRect();
      assert(
        hr.height > hr.width && Math.abs(hr.width / hr.height - turnedAspect) / turnedAspect < 0.05,
        `the rail's picture box is ${Math.round(hr.width)}x${Math.round(hr.height)}, not turned with its page`,
      );
      for (const f of restore.splice(0)) f();
      return `2 picture pages after page 1 in one step: ${checks.join("; ")}; Select: whiteout → selected, picture → nothing; turned 90°: box ${Math.round(tr.width)}x${Math.round(tr.height)}, picture covers it, rail ${railImg.naturalWidth}-px thumbnail in a ${Math.round(hr.width)}x${Math.round(hr.height)} box — ${ms(t0)}`;
    } finally {
      for (const f of restore.splice(0)) {
        try {
          f();
        } catch {
          /* best effort */
        }
      }
      // The editor stays up for the export block.
    }
  });

  await test("pictures-as-pages-export", async () => {
    const t0 = performance.now();
    let out = "";
    let opened: PdfDoc | null = null;
    try {
      needFixtures();
      let d = pdfEdDev();
      if (!d || !$(".pdfed") || currentSession.get() !== d.session || !made) {
        d = await mountEditor();
        made = await insertPictures(d);
      }
      const project = d.session.project;
      const dir = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
      assert(/taroting-autotest/i.test(dir), `the scratch folder ${dir} is not inside the autotest root`);
      out = `${dir}\\autotest-picture-pages-${Date.now().toString(36)}.pdf`;
      const { exportPdf } = await import("../pdf/export/export");
      const res = await exportPdf(project, { flattenMarks: false, flattenForms: false }, out).catch((e: unknown) => {
        throw new Error(`export failed: ${errorDetail(e).message}`);
      });
      const { appDeps } = await import("../pdf/export/deps");
      const bytes = await (await appDeps()).readBytes(res.path);

      // From the bytes (pdf-lib): page count, MediaBoxes, what each picture
      // page paints first.
      const { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } = await import("pdf-lib");
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      assert(doc.getPageCount() === 5, `the export has ${doc.getPageCount()} pages, not 5`);
      const boxes: string[] = [];
      for (const [slot, want] of [
        [1, [480.75, 270.75]],
        [2, [27, 48]],
      ] as const) {
        const page = doc.getPage(slot);
        const { width, height } = page.getMediaBox();
        assert(Math.abs(width - want[0]) < 0.01 && Math.abs(height - want[1]) < 0.01, `page ${slot + 1}'s MediaBox is ${width} x ${height}, not ${want[0]} x ${want[1]}`);
        const c = page.node.get(PDFName.of("Contents"));
        const arr = c instanceof PDFRef ? doc.context.lookup(c) : c;
        const refs = arr instanceof PDFArray ? Array.from({ length: arr.size() }, (_, k) => arr.get(k)) : [c];
        const text = refs
          .map((r) => {
            const s = r instanceof PDFRef ? doc.context.lookup(r) : r;
            if (s instanceof PDFRawStream) return new TextDecoder().decode(decodePDFRawStream(s).decode());
            return s instanceof PDFStream ? new TextDecoder().decode((s as unknown as { getContents(): Uint8Array }).getContents()) : "";
          })
          .join("\n");
        const first = /\/(\S+) Do/.exec(text);
        assert(first !== null && first[1]!.startsWith("TrtPage"), `page ${slot + 1} first paints ${first ? `/${first[1]}` : "nothing"}, not the page picture`);
        const xo = page.node.Resources()?.lookup(PDFName.of("XObject"));
        const form = xo instanceof PDFDict ? xo.lookup(PDFName.of(first![1]!)) : null;
        const inner = form instanceof PDFStream ? form.dict.lookup(PDFName.of("Resources")) : null;
        const innerXo = inner instanceof PDFDict ? inner.lookup(PDFName.of("XObject")) : null;
        const hasImage =
          innerXo instanceof PDFDict &&
          innerXo.values().some((v) => {
            const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
            return s instanceof PDFStream && s.dict.get(PDFName.of("Subtype"))?.toString() === "/Image";
          });
        assert(hasImage, `page ${slot + 1}'s page picture form holds no /Image XObject`);
        const annots = page.node.Annots();
        assert(!annots || annots.size() === 0, `page ${slot + 1} carries ${annots?.size()} annotation(s) — the picture must be page content`);
        boxes.push(`p${slot + 1} ${width}x${height}, /${first![1]} → /Image first, no annots`);
      }

      // What a viewer paints with annotations OFF: the grid's quadrant colours.
      const { openPdf } = await import("../pdf/view");
      const { loadPdfjs } = await import("../pdf/view/pdfjs");
      const pdfjs = await loadPdfjs();
      opened = await openPdf("autotest-picture-pages", res.path);
      const proxy = opened.doc as PdfProxyLite;
      const page = await proxy.getPage(2);
      const vp = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE, background: "#ffffff" }).promise;
      page.cleanup();
      const tl = meanRgb(canvas, canvas.width * 0.25, canvas.height * 0.25);
      const br = meanRgb(canvas, canvas.width * 0.75, canvas.height * 0.75);
      canvas.width = 0;
      assert(near(tl, GRID_TL, 24), `the exported grid page's top-left quadrant paints rgb(${tl.join(",")}), not about rgb(${GRID_TL.join(",")})`);
      assert(near(br, GRID_BR, 24), `the exported grid page's bottom-right quadrant paints rgb(${br.join(",")}), not about rgb(${GRID_BR.join(",")})`);
      return `exported ${res.bytes} bytes, 5 pages: ${boxes.join("; ")}; pdf.js with annotations off paints TL rgb(${tl.join(",")}) / BR rgb(${br.join(",")}) — ${ms(t0)}`;
    } finally {
      if (opened) await opened.destroy().catch(() => {});
      if (out) await removeTestFile(out).catch(() => {});
      await backHome();
      if (projectPath) await ipc.deleteProject(projectPath).catch(() => {});
      projectPath = "";
      made = null;
    }
  });
  await test("pictures-as-pages-cover", async () => {
    const t0 = performance.now();
    let thumb = "";
    try {
      needFixtures();
      const d = await mountEditor();
      // the grid as the FIRST page (before slot 0), the page = the picture
      await d.panel.ops.insertPictures(-1, { paths: [GRID], sizing: "picture" });
      const first = d.session.project.pdf!.pages[0]!;
      assert(first.src === null && first.w === 480.75, `page 1 is ${first.src === null ? `a ${first.w} pt blank` : "a source page"}, not the grid's picture page`);
      const s = d.session;
      const keep = $<HTMLButtonElement>("#ed-keep");
      assert(rendered(keep), "#ed-keep is not rendered");
      keep!.click();
      await until(() => !s.temp.get() && !$("#ed-keep"), 5_000, () => `Keep to finish (temp ${String(s.temp.get())})`);
      projectPath = s.path;
      let item: { thumb: string | null } | undefined;
      const tThumb = performance.now();
      for (;;) {
        item = (await ipc.listRecents()).items.find((i) => i.path.toLowerCase() === projectPath.toLowerCase());
        if (item?.thumb && (await ipc.pathExists(item.thumb))) break;
        if (performance.now() - tThumb > 2_000) throw new Error(`no card picture within 2 s (recents entry ${item ? `thumb ${String(item.thumb)}` : "missing"})`);
        await sleep(50);
      }
      thumb = item!.thumb!;
      const thumbMs = Math.round(performance.now() - tThumb);
      // read the card's pixels the way the app reads files (an <img> from the
      // asset origin would taint the canvas)
      const res = await fetch(mediaUrl(thumb));
      assert(res.ok, `the card picture could not be read (${res.status})`);
      const bmp = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
      const aspect = canvas.width / canvas.height;
      const tl = meanRgb(canvas, canvas.width * 0.25, canvas.height * 0.25);
      const br = meanRgb(canvas, canvas.width * 0.75, canvas.height * 0.75);
      const size = `${canvas.width}x${canvas.height}`;
      canvas.width = 0;
      assert(Math.abs(aspect - 641 / 361) / (641 / 361) < 0.03, `the card is ${size}, not the picture page's shape`);
      assert(
        near(tl, GRID_TL, 24) && near(br, GRID_BR, 24),
        `the card paints rgb(${tl.join(",")}) / rgb(${br.join(",")}), not the grid's quadrants — a blank card?`,
      );
      return `picture-first project kept → card ${size} written in ${thumbMs} ms, TL rgb(${tl.join(",")}) / BR rgb(${br.join(",")}) — ${ms(t0)}`;
    } finally {
      await backHome();
      if (projectPath) await ipc.deleteProject(projectPath).catch(() => {});
      if (thumb) await removeTestFile(thumb).catch(() => {});
      projectPath = "";
    }
  });
}
