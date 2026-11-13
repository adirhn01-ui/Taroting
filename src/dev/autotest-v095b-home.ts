// 0.9.5 E2E blocks: Home makes ONE PDF project of PDFs and pictures together.
// DEV-only, loaded lazily by the harness; nothing under src/pdf is imported
// statically (the PDF editor, the view and pdf.js are lazy chunks: every
// runtime module a block drives is reached with `await import(...)`, and the
// types below are erased).
//
// The native file picker cannot be driven, so the blocks hand fixture paths
// to Home's own code through `window.__tarotingHomeDev` (published by
// mountHome only under dev + autotest): `newPdf` is "New project → PDF
// project" with the paths as the picker's answer, `drop` is the handler a
// real window drop runs. What a block asserts is ON SCREEN (the strip's page
// boxes, what a point inside a page shows, the rail) and ON DISK (the saved
// .trt, read back through the backend), never a class alone.
//
// Three blocks:
//   (a) home-new-pdf-mixed — New project → PDF project with plain_3p.pdf and
//       image_grid_641x361.png, handed over PDF first: name order puts the
//       picture first. One permanent project: a 480.75 x 270.75 pt picture
//       page, then the PDF's three pages; the strip's first box has the
//       picture's aspect and paints the picture; the rail lists four pages.
//   (b) home-drop-pdf-and-picture — the same PDF dropped with photo_o6.jpg
//       (64x36 coded, EXIF 6, shown 36x64): no Open as dialog at any point,
//       one PDF project, the picture's page first at 27 x 48 pt.
//   (c) home-drop-pdf-picture-video — a PDF dropped with a picture AND a
//       video keeps today's path: the Open as dialog for the two media, the
//       "open separately" toast, and no project written.
//
// Each block ends on Home with every project it made, and its card picture,
// deleted. Waits poll at 20 ms with their own short deadline and a message
// naming what they waited for and what was there instead.

import { invoke } from "@tauri-apps/api/core";
import { ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { isTempProjectPath } from "../core/open-media";
import type { ProjectSession } from "../core/session";
import type { PdfAnnot, ProjectFile } from "../core/types";
import type { PdfView } from "../pdf/types";
import { closeMenu } from "../ui/menu";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type HomePdfPictureCtx = Wave1Ctx;

const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

/** What Home publishes on window while it is mounted (home.ts, dev + autotest). */
interface HomeDev {
  open(paths: string[]): void;
  drop(paths: string[]): void;
  newPdf(paths: string[]): void;
}
/** What the PDF editor publishes on window while mounted (shell.ts, DEV). */
interface PdfEditorDev {
  session: ProjectSession;
  view: PdfView;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pageRaf = window.requestAnimationFrame.bind(window);
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => pageRaf(() => r()));
};
/** Poll every 20 ms; `what` is evaluated only on timeout. */
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
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").trim();
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const norm = (p: string): string => p.replace(/\//g, "\\").toLowerCase();
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

function rendered(el: Element | null | undefined): el is HTMLElement {
  return el instanceof Element && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}
function homeDev(): HomeDev | undefined {
  return (window as unknown as { __tarotingHomeDev?: HomeDev }).__tarotingHomeDev;
}
function pdfEdDev(): PdfEditorDev | undefined {
  return (window as unknown as { __tarotingPdfDev?: PdfEditorDev }).__tarotingPdfDev;
}
function openAsDialog(): HTMLElement | null {
  return $(".openas-modal");
}
function onScreen(): string {
  const scr = $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $(".home") ? "home" : "?";
  const dlg = $(".modal-backdrop") ? `dialog "${text($(".modal-backdrop .modal__header"))}"` : "no dialog";
  const toasts = $$(".toast").map((t) => text(t)).join(" | ");
  return `${scr}, ${dlg}${toasts ? `, toasts: ${toasts}` : ""}`;
}

/** One saved page as the block reads it: a PDF page, or a picture page. */
type PageOnDisk = { pdf: string; page: number } | { picture: string; w: number; h: number };

function pagesOnDisk(p: ProjectFile): PageOnDisk[] {
  const meta = p.pdf;
  if (!meta) return [];
  const pathOf = new Map(meta.sources.map((s) => [s.id, s.path]));
  return meta.pages.map((pg): PageOnDisk => {
    if (pg.src !== null) return { pdf: pathOf.get(pg.src) ?? "?", page: pg.page };
    const marks = (meta.annots[pg.id] ?? []) as PdfAnnot[];
    const pic = marks.find((a): a is Extract<PdfAnnot, { t: "image" }> => a.t === "image" && a.bg === true);
    return { picture: p.media.find((x) => x.id === pic?.media)?.path ?? "?", w: pg.w ?? NaN, h: pg.h ?? NaN };
  });
}
function describePages(list: readonly PageOnDisk[]): string {
  return list.map((x) => ("pdf" in x ? `${baseName(x.pdf)}#${x.page}` : `${baseName(x.picture)} ${x.w}x${x.h}`)).join(", ");
}

export async function runHomePdfPictureBlocks(ctx: HomePdfPictureCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const SRC = `${fixturesDir}\\pdf\\plain_3p.pdf`;
  const GRID = `${fixturesDir}\\image_grid_641x361.png`;
  const TURNED = `${fixturesDir}\\photo_o6.jpg`;
  const VIDEO = `${fixturesDir}\\counter_h264.mp4`;
  /** image_grid_641x361.png's top-left quadrant colour (scripts/make-fixtures.mjs). */
  const GRID_TL = [224, 64, 32];

  const present = await Promise.all([SRC, GRID, TURNED, VIDEO].map((f) => ipc.pathExists(f).catch(() => false)));
  const needFixtures = (): void =>
    assert(present.every(Boolean), "fixtures missing (plain_3p.pdf, image_grid_641x361.png, photo_o6.jpg, counter_h264.mp4) — run npm run fixtures");

  /** Dismiss anything left open and park on a FRESH Home. Never throws. */
  const freshHome = async (): Promise<void> => {
    try {
      closeMenu();
      for (const b of $$(".modal-backdrop")) {
        const out = b.querySelector<HTMLElement>('[data-act="cancel"]');
        if (out) out.click();
        else b.remove();
      }
      const old = $(".home");
      navigate({ view: "home" });
      await until(() => $(".home") && $(".home") !== old && !$(".editor") && !$("#vw") && homeDev(), 5_000, () => `a fresh Home (${onScreen()})`);
    } catch (e) {
      console.error("home pdf/picture autotest: did not reach Home", e);
    }
  };

  /** Delete every project a block made, with the card picture its editor wrote. */
  const cleanUp = async (made: readonly string[]): Promise<void> => {
    await freshHome();
    const recents = await ipc.listRecents().catch(() => ({ items: [] as { path: string; thumb?: string | null }[] }));
    for (const p of made) {
      const thumb = recents.items.find((i) => norm(i.path) === norm(p))?.thumb;
      await ipc.deleteProject(p).catch(() => {});
      if (thumb) await removeTestFile(thumb).catch(() => {});
    }
  };

  /** The PDF editor on a NEW project (not the one up before), with the Open
   *  as dialog never shown on the way: checked on every poll. */
  const waitPdfEditor = async (prev: PdfEditorDev | undefined, what: string): Promise<PdfEditorDev> => {
    let sawDialog = false;
    const d = await until(
      () => {
        if (openAsDialog()) sawDialog = true;
        const dev = pdfEdDev();
        return dev && dev !== prev && $(".pdfed") ? dev : null;
      },
      8_000,
      () => `the PDF editor after ${what} — ${onScreen()}`,
    );
    assert(!sawDialog, `${what} showed the Open as dialog`);
    return d;
  };

  /** The saved project, read back from disk, checked to be a PERMANENT library project. */
  const savedProject = async (d: PdfEditorDev): Promise<{ path: string; disk: ProjectFile }> => {
    const path = d.session.path;
    assert(!d.session.temp.get() && !(await isTempProjectPath(path)), `the new PDF project is temporary: ${path}`);
    const disk = (await ipc.loadProject(path)).project;
    assert(disk.kind === "pdf" && disk.schema === 4, `the saved project is kind ${String(disk.kind)}, schema ${disk.schema}`);
    return { path, disk };
  };

  await test("home-new-pdf-mixed", async () => {
    const t0 = performance.now();
    const made: string[] = [];
    try {
      needFixtures();
      await freshHome();
      const prev = pdfEdDev();
      // Handed over PDF first, as a picker may: name order ("image_grid…"
      // before "plain_3p") puts the picture first.
      homeDev()!.newPdf([SRC, GRID]);
      const d = await waitPdfEditor(prev, "New project → PDF project with a PDF and a picture");
      const { path, disk } = await savedProject(d);
      made.push(path);
      const pages = pagesOnDisk(disk);
      const want: PageOnDisk[] = [
        { picture: GRID, w: 480.75, h: 270.75 },
        { pdf: SRC, page: 0 },
        { pdf: SRC, page: 1 },
        { pdf: SRC, page: 2 },
      ];
      const same =
        pages.length === want.length &&
        pages.every((p, i) => {
          const w = want[i]!;
          if ("pdf" in w) return "pdf" in p && norm(p.pdf) === norm(w.pdf) && p.page === w.page;
          return "picture" in p && norm(p.picture) === norm(w.picture) && p.w === w.w && p.h === w.h;
        });
      assert(same, `the saved pages are [${describePages(pages)}], not [${describePages(want)}]`);
      assert(baseName(path).toLowerCase().startsWith("image_grid_641x361"), `the project is named ${baseName(path)}, not after the first file in name order`);

      // On screen: the first page's box has the picture's shape and paints it.
      const stage = $("#pdfed-stage")!;
      const firstId = d.session.project.pdf!.pages[0]!.id;
      d.view.scrollToPage(0);
      const pageEl = await until(() => {
        const e = $(`.pdfv-page[data-key="${firstId}"]`, stage);
        return e && rendered(e) ? e : null;
      }, 3_000, () => "the first page's box in the strip");
      const node = await until(() => d.view.overlay(firstId)?.querySelector<SVGImageElement>(".pdfmk-marks image") ?? null, 3_000, () => "the first page's picture node");
      await frames(2);
      const pr = pageEl.getBoundingClientRect();
      const aspect = pr.width / pr.height;
      assert(Math.abs(aspect - 641 / 361) / (641 / 361) < 0.02, `the first page's box is ${Math.round(pr.width)}x${Math.round(pr.height)} (aspect ${aspect.toFixed(3)}), the picture's is ${(641 / 361).toFixed(3)}`);
      const hit = document.elementFromPoint(pr.left + pr.width / 4, pr.top + pr.height / 4);
      assert(hit !== null && pageEl.contains(hit), `a point inside the first page shows ${hit ? hit.tagName.toLowerCase() : "nothing"}, not the page`);
      // The page picture's file decodes, and its top-left quadrant is the grid's.
      // Read as a blob and decoded with createImageBitmap: an <img> from the
      // asset origin would taint the canvas and getImageData would throw.
      const href = node.getAttribute("href") ?? "";
      const res = await fetch(href, { cache: "no-store" });
      assert(res.ok, `the first page's picture (${href}) reads back as HTTP ${res.status}`);
      const img = await createImageBitmap(await res.blob()).catch(() => {
        throw new Error(`the first page's picture (${href}) does not decode`);
      });
      const c = document.createElement("canvas");
      c.width = 8;
      c.height = 8;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, img.width / 4, img.height / 4, 0, 0, 8, 8);
      img.close();
      const px = Array.from(g.getImageData(4, 4, 1, 1).data.slice(0, 3));
      assert(px.every((v, i) => Math.abs(v - GRID_TL[i]!) <= 24), `the first page's picture shows rgb(${px.join(",")}) top-left, not the grid's rgb(${GRID_TL.join(",")})`);
      // The rail lists four pages.
      const rows = await until(() => {
        const r = $$(".pdfed-rail .pdfv-thumb").filter(rendered);
        return r.length === 4 ? r : null;
      }, 3_000, () => `four pages in the rail (${$$(".pdfed-rail .pdfv-thumb").length} there)`);
      return `[${describePages(pages)}] → ${baseName(path)}; first box ${Math.round(pr.width)}x${Math.round(pr.height)}, picture top-left rgb(${px.join(",")}); rail ${rows.length} — ${ms(t0)}`;
    } finally {
      await cleanUp(made);
    }
  });

  await test("home-drop-pdf-and-picture", async () => {
    const t0 = performance.now();
    const made: string[] = [];
    try {
      needFixtures();
      await freshHome();
      const prev = pdfEdDev();
      homeDev()!.drop([SRC, TURNED]);
      const d = await waitPdfEditor(prev, "a PDF dropped with a picture");
      const { path, disk } = await savedProject(d);
      made.push(path);
      const pages = pagesOnDisk(disk);
      // "photo_o6" before "plain_3p"; shown 36x64 px → 27 x 48 pt (the EXIF turn kept).
      const first = pages[0];
      assert(
        pages.length === 4 && first !== undefined && "picture" in first && norm(first.picture) === norm(TURNED) && first.w === 27 && first.h === 48,
        `the saved pages are [${describePages(pages)}], not [photo_o6.jpg 27x48, plain_3p.pdf#0..2]`,
      );
      assert(
        pages.slice(1).every((p, i) => "pdf" in p && norm(p.pdf) === norm(SRC) && p.page === i),
        `the PDF's pages are not 0, 1, 2 after the picture: [${describePages(pages)}]`,
      );
      // On screen: the picture's page is portrait, the PDF's first page follows.
      const stage = $("#pdfed-stage")!;
      const ids = d.session.project.pdf!.pages.map((pg) => pg.id);
      const box = await until(() => {
        const e = $(`.pdfv-page[data-key="${ids[0]}"]`, stage);
        return e && rendered(e) ? e : null;
      }, 3_000, () => "the picture page's box");
      await frames(2);
      const r = box.getBoundingClientRect();
      assert(Math.abs(r.width / r.height - 27 / 48) / (27 / 48) < 0.02, `the picture page's box is ${Math.round(r.width)}x${Math.round(r.height)}, not 27:48`);
      return `[${describePages(pages)}] → ${baseName(path)}, no Open as; picture page ${Math.round(r.width)}x${Math.round(r.height)} on screen — ${ms(t0)}`;
    } finally {
      await cleanUp(made);
    }
  });

  await test("home-drop-pdf-picture-video", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await freshHome();
      const before = (await ipc.listRecents()).items.length;
      const prevEditor = pdfEdDev();
      homeDev()!.drop([SRC, GRID, VIDEO]);
      const dlg = await until(() => (rendered(openAsDialog()) ? openAsDialog() : null), 3_000, () => `the Open as dialog — ${onScreen()}`);
      const title = text($(".modal__header", dlg.closest(".modal-backdrop") ?? document));
      assert(title.includes("Open 2 files as"), `the dialog reads "${title}", not "Open 2 files as" (the PDF must be left aside)`);
      const aside = "PDFs and media open separately. Open the PDFs on their own to make a PDF project.";
      await until(() => $$(".toast").some((t) => text(t).includes(aside)), 2_000, () => `the open-separately toast — ${onScreen()}`);
      const cancel = $<HTMLButtonElement>(".openas-modal .modal__footer [data-act='cancel']");
      assert(rendered(cancel), "the dialog has no rendered Cancel");
      cancel!.click();
      await until(() => !openAsDialog(), 2_000, () => `the dialog to close — ${onScreen()}`);
      await sleep(100);
      assert(pdfEdDev() === prevEditor && !$(".pdfed"), `a PDF editor opened (${onScreen()})`);
      const after = (await ipc.listRecents()).items.length;
      assert(after === before, `recents went from ${before} to ${after}: a project was written`);
      return `"${title}", toast "${aside.slice(0, 32)}…", Cancel → nothing made — ${ms(t0)}`;
    } finally {
      await freshHome();
    }
  });
}
