// 0.9.5 E2E blocks: picture pages afterwards. DEV-only, loaded lazily by the
// harness; nothing under src/pdf is imported statically (every runtime module
// a block drives is reached with `await import(...)` inside it).
//
// Two blocks, one PDF editor mount each, on a TEMPORARY project made from
// plain_3p.pdf plus a picture page of image_grid_641x361.png (deleted in
// finally; nothing is written outside the autotest folder):
//   (a) pdf-picture-page-size — the grid's page (picture size) with a
//       whiteout over the picture's top-left quadrant. Through the RAIL's own
//       context menu: "Page size" shows the current sizing, its choices open
//       with Picture size ticked, A4 is chosen. Asserted ON SCREEN: the page
//       box now has A4 landscape's shape, the picture node sits where the
//       layout puts it, and the whiteout is still over the SAME spot of the
//       picture (its centre at the same fractions of the picture's painted
//       box). One undo step takes it back to the picture's own size.
//   (b) pdf-picture-missing-relink — the same project saved with the
//       picture's file pointing at a path that does not exist. On open: the
//       relink dialog asks for it (closed unanswered); the page draws the
//       placeholder where the picture was; the page's "Relink picture"
//       button is what the screen shows at its centre, and its click opens
//       the relink dialog; the rail marks the page and shows the placeholder
//       in its thumbnail. Then the file is relinked to a picture of another
//       shape (photo_o6.jpg, portrait) by the commit the dialog makes (the
//       native file picker cannot be driven): one undo step, the page keeps
//       its size, the picture is fitted inside its old box, centred, and is
//       drawn as a picture that decodes; the rail's mark goes.

import { errorDetail, ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { currentSession, type ProjectSession } from "../core/session";
import type { MediaInfo, PdfAnnot, ProjectFile } from "../core/types";
import type { PdfDoc, PdfEditorCtx, PdfView } from "../pdf/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the font blocks (autotest-fonts.ts runFontBlocks). */
export type PdfPictures2Ctx = Wave1Ctx;

/** What the PDF editor publishes on window while mounted (shell.ts, DEV). */
interface PdfEditorDev {
  session: ProjectSession;
  ctx: PdfEditorCtx;
  view: PdfView;
  docs: ReadonlyMap<string, PdfDoc>;
  panel: { ops: { menuItems(slots: readonly number[]): { label: string }[] } };
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
const r1 = (v: number): number => Math.round(v * 10) / 10;

export async function runPdfPictureBlocks2(ctx: PdfPictures2Ctx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const SRC = `${fixturesDir}\\pdf\\plain_3p.pdf`;
  const GRID = `${fixturesDir}\\image_grid_641x361.png`;
  const TURNED = `${fixturesDir}\\photo_o6.jpg`;

  const present = await Promise.all([SRC, GRID, TURNED].map((f) => ipc.pathExists(f).catch(() => false)));
  const needFixtures = (): void => assert(present.every(Boolean), "fixtures missing (plain_3p.pdf, image_grid_641x361.png, photo_o6.jpg) — run npm run fixtures");

  let projectPath = "";

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
      console.error("picture pages (2) autotest: cleanup did not finish", e);
    }
  };

  /** A temporary project: plain_3p.pdf, then the grid as a picture page at
   *  slot 1 (picture size) with a whiteout over its top-left quadrant; the
   *  grid's MediaRef pointed at `gonePath` when given. Opened in the editor. */
  const mountWith = async (gonePath?: string): Promise<{ d: PdfEditorDev; page: string; pic: string; white: string }> => {
    await backHome();
    const stat = await ipc.fileStat(SRC);
    assert(stat !== null, "plain_3p.pdf could not be stat'ed");
    const { countPages } = await import("../pdf/view/loader");
    const { createPdfProject } = await import("../core/pdf-project");
    const { addAnnot, insertPicturePages, isPagePicture, newId, pageAnnots } = await import("../pdf/model");
    const grid: MediaInfo = await ipc.probeMedia(GRID);
    let p: ProjectFile = createPdfProject("Autotest picture pages 2", { path: SRC, size: stat!.size, mtimeMs: stat!.mtimeMs, pages: await countPages(SRC) });
    p = insertPicturePages(p, 1, [grid], "picture");
    const page = p.pdf!.pages[1]!.id;
    const pic = pageAnnots(p, page).find(isPagePicture)!;
    const white = newId();
    // the grid's top-left quadrant is the picture's top-left quarter
    const wo: PdfAnnot = { id: white, t: "whiteout", x: pic.w * 0.1, y: pic.h * 0.1, w: pic.w * 0.2, h: pic.h * 0.2, c: "#ffffff" };
    p = addAnnot(p, page, wo);
    if (gonePath) p = { ...p, media: p.media.map((m) => (m.id === pic.media ? { ...m, path: gonePath } : m)) };
    projectPath = await ipc.tempProjectPath("Autotest picture pages 2");
    await ipc.saveProject(projectPath, p);
    const prev = pdfEdDev();
    navigate({ view: "editor", projectPath, temp: true });
    const d = await until(
      () => {
        const x = pdfEdDev();
        return x && x !== prev && $(".pdfed") && x.panel ? x : null;
      },
      8_000,
      () => `the PDF editor — ${onScreen()}`,
    );
    return { d, page, pic: pic.id, white };
  };

  /** The page's box in the strip, scrolled into view and rendered. */
  const pageBox = async (d: PdfEditorDev, key: string, slot: number, aspect?: number): Promise<HTMLElement> => {
    d.view.scrollToPage(slot);
    return until(
      () => {
        const e = $(`#pdfed-stage .pdfv-page[data-key="${key}"]`);
        if (!e || !rendered(e)) return null;
        if (aspect === undefined) return e;
        const r = e.getBoundingClientRect();
        return Math.abs(r.width / r.height - aspect) / aspect < 0.02 ? e : null;
      },
      2_000,
      () => `page ${slot + 1}'s box${aspect ? ` at aspect ${aspect.toFixed(3)}` : ""}`,
    );
  };

  /** Open the rail's context menu on `slot` (a real contextmenu event). */
  const railMenu = async (slot: number): Promise<void> => {
    const row = await until(() => $(`.pdfed-rail .pdfv-thumb[data-slot="${slot}"]`), 2_000, () => `the rail's item ${slot + 1}`);
    row.scrollIntoView({ block: "nearest" });
    await frames(1);
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
    await until(() => $$(".ctx-menu .ctx-menu__item").length > 0 && rendered($(".ctx-menu")), 1_000, () => "the page menu");
  };
  const menuItem = (label: string): HTMLButtonElement | null =>
    $$<HTMLButtonElement>(".ctx-menu .ctx-menu__item").find((b) => (b.querySelector(".ctx-menu__label")?.textContent ?? b.textContent ?? "").trim() === label) ?? null;

  await test("pdf-picture-page-size", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      const { d, page, pic, white } = await mountWith();
      const { picturePageSizingOf } = await import("../pdf/model");
      const { PAPER_PT, picturePageLayout } = await import("../core/picture-page");
      // Before: the page is the picture (641×361 px → 480.75×270.75 pt).
      await pageBox(d, page, 1, 641 / 361);
      await until(() => d.view.overlay(page)?.querySelector(`[data-id="${white}"]`), 2_000, () => "the whiteout's node");
      await frames(2);
      const spot = (): { fx: number; fy: number; ir: DOMRect } => {
        const img = d.view.overlay(page)!.querySelector(`image[data-id="${pic}"]`)!;
        const wo = d.view.overlay(page)!.querySelector(`[data-id="${white}"]`)!;
        const ir = img.getBoundingClientRect();
        const wr = wo.getBoundingClientRect();
        return { fx: (wr.left + wr.width / 2 - ir.left) / ir.width, fy: (wr.top + wr.height / 2 - ir.top) / ir.height, ir };
      };
      const before = spot();

      // The rail's menu: Page size, its hint the current sizing.
      await railMenu(1);
      const sizeItem = menuItem("Page size");
      assert(rendered(sizeItem), `the page menu has no rendered "Page size" (items: ${$$(".ctx-menu .ctx-menu__item").map((b) => b.textContent).join(" | ")})`);
      const hint = sizeItem!.querySelector(".ctx-menu__hint")?.textContent ?? "";
      assert(hint === "Picture size", `"Page size" says "${hint}", not "Picture size"`);
      sizeItem!.click();
      await until(() => menuItem("A4") && rendered(menuItem("A4")), 1_000, () => "the Page size choices");
      const ticked = ["Picture size", "A4", "Letter"].filter((l) => menuItem(l)?.querySelector(".ctx-menu__icon path") != null);
      assert(ticked.join(",") === "Picture size", `ticked: [${ticked.join(", ")}], not [Picture size]`);
      const was0 = d.session.project;
      menuItem("A4")!.click();
      assert(picturePageSizingOf(d.session.project, page) === "a4", `the page is now ${String(picturePageSizingOf(d.session.project, page))}, not A4`);

      // On screen: A4 landscape, the picture where the layout puts it, the
      // whiteout over the same spot of the picture.
      const aspect = PAPER_PT.a4.h / PAPER_PT.a4.w;
      const box = await pageBox(d, page, 1, aspect);
      await frames(2);
      const br = box.getBoundingClientRect();
      const l = picturePageLayout(641, 361, "a4");
      const after = spot();
      const fx = (after.ir.left - br.left) / br.width;
      const fy = (after.ir.top - br.top) / br.height;
      const fw = after.ir.width / br.width;
      const fh = after.ir.height / br.height;
      const want = [l.x / l.pageW, l.y / l.pageH, l.w / l.pageW, l.h / l.pageH];
      assert(
        [fx, fy, fw, fh].every((v, i) => Math.abs(v - want[i]!) < 0.01),
        `the picture is painted at ${[fx, fy, fw, fh].map((v) => v.toFixed(3)).join(",")} of the page, the layout says ${want.map((v) => v.toFixed(3)).join(",")}`,
      );
      assert(
        Math.abs(after.fx - before.fx) < 0.01 && Math.abs(after.fy - before.fy) < 0.01,
        `the whiteout moved on the picture: centre at ${before.fx.toFixed(3)},${before.fy.toFixed(3)} of it before, ${after.fx.toFixed(3)},${after.fy.toFixed(3)} after`,
      );
      // Its own centre on screen shows the whiteout (painted over the picture).
      const wo = d.view.overlay(page)!.querySelector<SVGElement>(`[data-id="${white}"]`)!;
      const wr = wo.getBoundingClientRect();
      const was = wo.style.pointerEvents;
      wo.style.pointerEvents = "auto";
      const hit = document.elementFromPoint(wr.left + wr.width / 2, wr.top + wr.height / 2);
      wo.style.pointerEvents = was;
      assert(hit === wo, `the whiteout's centre shows ${describeEl(hit)}`);

      // One undo step: back to the picture's own size.
      d.session.undo();
      const back = d.session.project.pdf!.pages[1]!;
      const orig = was0.pdf!.pages[1]!;
      assert(back.w === orig.w && back.h === orig.h, `one undo left the page ${back.w}x${back.h}, not ${orig.w}x${orig.h}`);
      assert(picturePageSizingOf(d.session.project, page) === "picture", `one undo left the page ${String(picturePageSizingOf(d.session.project, page))}`);
      await pageBox(d, page, 1, 641 / 361);
      return `Page size (hint "${hint}", Picture size ticked) → A4: box ${Math.round(br.width)}x${Math.round(br.height)}, picture at ${[fx, fy, fw, fh].map((v) => v.toFixed(3)).join(",")}, whiteout centre ${r1(before.fx * 100)}%,${r1(before.fy * 100)}% → ${r1(after.fx * 100)}%,${r1(after.fy * 100)}% of the picture; one undo → picture size — ${ms(t0)}`;
    } finally {
      closeMenu();
      await backHome();
      if (projectPath) await ipc.deleteProject(projectPath).catch(() => {});
      projectPath = "";
    }
  });

  await test("pdf-picture-missing-relink", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      // A path in the autotest folder that does not exist.
      const scratch = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
      assert(/taroting-autotest/i.test(scratch), `the scratch folder ${scratch} is not inside the autotest root`);
      const gone = `${scratch}\\moved-away-${Date.now()}.png`;
      assert(!(await ipc.pathExists(gone)), `${gone} exists`);
      const { d, page, pic } = await mountWith(gone);

      // Asked on open, in the relink dialog's words; closed unanswered.
      const modal = await until(() => $(".relink-modal"), 2_000, () => "the relink dialog on open");
      const row = $(".relink-row", modal);
      assert(row !== null && (row.querySelector(".relink-row__path")?.textContent ?? "") === gone, `the dialog lists ${row?.querySelector(".relink-row__path")?.textContent ?? "nothing"}, not the moved picture`);
      $<HTMLButtonElement>("[data-close-btn]", modal)!.click();
      await until(() => !$(".relink-modal"), 1_000, () => "the dialog to close");

      // The page: the placeholder where the picture was, and the button.
      const box = await pageBox(d, page, 1, 641 / 361);
      const ph = await until(() => d.view.overlay(page)?.querySelector<SVGGElement>(`g.pdfmk-missing[data-id="${pic}"]`), 2_000, () => "the placeholder");
      assert(!d.view.overlay(page)!.querySelector(`image[data-id="${pic}"]`), "an <image> is still drawn for the missing picture");
      await frames(2);
      const pr = ph.getBoundingClientRect();
      const bx = box.getBoundingClientRect();
      assert(Math.abs(pr.width - bx.width) <= 2 && Math.abs(pr.height - bx.height) <= 2, `the placeholder is ${Math.round(pr.width)}x${Math.round(pr.height)}, the page ${Math.round(bx.width)}x${Math.round(bx.height)}`);
      const btn = await until(() => d.view.overlay(page)?.querySelector<HTMLButtonElement>(".pdfed-relink-pic"), 2_000, () => "the page's Relink picture button");
      assert(rendered(btn) && (btn.textContent ?? "").includes("Relink picture"), `the button reads "${btn.textContent}"`);
      const brc = btn.getBoundingClientRect();
      const cx = brc.left + brc.width / 2;
      const cy = brc.top + brc.height / 2;
      assert(Math.abs(cx - (bx.left + bx.width / 2)) <= 2 && Math.abs(cy - (bx.top + bx.height / 2)) <= 2, `the button sits at ${Math.round(cx)},${Math.round(cy)}, the picture's centre is ${Math.round(bx.left + bx.width / 2)},${Math.round(bx.top + bx.height / 2)}`);
      const hit = document.elementFromPoint(cx, cy);
      assert(hit !== null && btn.contains(hit), `the button's centre shows ${describeEl(hit)}`);
      // a real press + click on it: no mark is made, the dialog opens
      const steps = d.session.project;
      const o = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
      d.ctx.tools.update((t) => ({ ...t, tool: "pen" }));
      hit!.dispatchEvent(new PointerEvent("pointerdown", { ...o, buttons: 1 }));
      hit!.dispatchEvent(new PointerEvent("pointerup", o));
      (hit as HTMLElement).click();
      d.ctx.tools.update((t) => ({ ...t, tool: "select" }));
      assert(d.session.project === steps, "the press on the button changed the project");
      await until(() => $(".relink-modal"), 2_000, () => "the relink dialog from the page's button");
      $<HTMLButtonElement>(".relink-modal [data-close-btn]")!.click();
      await until(() => !$(".relink-modal"), 1_000, () => "the dialog to close");

      // The rail: the page marked, its thumbnail a placeholder.
      const railRow = await until(() => $(`.pdfed-rail .pdfv-thumb[data-slot="1"]`), 2_000, () => "the rail's item 2");
      railRow.scrollIntoView({ block: "nearest" });
      assert(rendered(railRow.querySelector(".pdfv-thumb__badge")), "the rail's item 2 has no rendered missing mark");
      assert($(`.pdfed-rail .pdfv-thumb[data-slot="0"] .pdfv-thumb__badge`) === null, "the rail marks page 1 too");
      await until(() => rendered(railRow.querySelector(".pdfv-thumb__pic--missing")), 2_000, () => "the rail's placeholder");
      assert(railRow.querySelector(".pdfv-thumb__pic img") === null, "the rail still asks for the missing file");
      // the page menu offers it too
      const items = d.panel.ops.menuItems([1]).map((i) => i.label);
      assert(items.includes("Relink picture"), `the page menu offers [${items.join(", ")}]`);

      // Relinked to a portrait picture by the dialog's own commit.
      const { relinkPicture } = await import("../pdf/editor/picture-relink");
      const { pageAnnots } = await import("../pdf/model");
      const info = await ipc.probeMedia(TURNED);
      const mediaId = (pageAnnots(d.session.project, page).find((a) => a.id === pic) as Extract<PdfAnnot, { t: "image" }>).media;
      const pageBefore = d.session.project.pdf!.pages[1]!;
      d.session.commit((q) => relinkPicture(q, mediaId, TURNED, info));
      const pageAfter = d.session.project.pdf!.pages[1]!;
      assert(pageAfter.w === pageBefore.w && pageAfter.h === pageBefore.h, `the page went ${pageBefore.w}x${pageBefore.h} → ${pageAfter.w}x${pageAfter.h}`);
      const img = await until(() => d.view.overlay(page)?.querySelector<SVGImageElement>(`image[data-id="${pic}"]`), 2_000, () => "the picture drawn again");
      await frames(2);
      const ir = img.getBoundingClientRect();
      const bx2 = (await pageBox(d, page, 1)).getBoundingClientRect();
      const shown = (info.width ?? 0) / (info.height ?? 1);
      assert(Math.abs(ir.height - bx2.height) <= 2 && Math.abs(ir.width / ir.height - shown) / shown < 0.05, `the new picture is ${Math.round(ir.width)}x${Math.round(ir.height)} in a ${Math.round(bx2.width)}x${Math.round(bx2.height)} page (want full height at ${shown.toFixed(3)})`);
      assert(Math.abs(ir.left + ir.width / 2 - (bx2.left + bx2.width / 2)) <= 2, "the new picture is not centred across the page");
      const dec = new Image();
      dec.src = img.getAttribute("href") ?? "";
      await dec.decode().catch((e) => {
        throw new Error(`the relinked picture does not decode: ${errorDetail(e)}`);
      });
      assert(!d.view.overlay(page)!.querySelector(".pdfed-relink-pic"), "the page's button stayed after the relink");
      await until(() => $(`.pdfed-rail .pdfv-thumb[data-slot="1"] .pdfv-thumb__badge`) === null, 2_000, () => "the rail's mark to go");
      // one undo step brings the missing file back
      d.session.undo();
      await until(() => d.view.overlay(page)?.querySelector(`g.pdfmk-missing[data-id="${pic}"]`), 2_000, () => "the placeholder again after one undo");
      return `asked on open; placeholder ${Math.round(pr.width)}x${Math.round(pr.height)} over the page, button at its centre (press made nothing, click opened the dialog), rail marked; relinked to a portrait: page ${pageAfter.w}x${pageAfter.h} kept, picture ${Math.round(ir.width)}x${Math.round(ir.height)} centred, decodes; one undo → missing again — ${ms(t0)}`;
    } finally {
      closeMenu();
      await backHome();
      if (projectPath) await ipc.deleteProject(projectPath).catch(() => {});
      projectPath = "";
    }
  });
}
