// 0.9.5 E2E: an image project exported as a PDF through the export dialog.
// DEV-only: imported lazily by the harness, never part of a release bundle.
//
// Same rules as autotest-image.ts: nothing under src/image is imported
// statically (the image editor is a lazy chunk), pdf-lib is fetched inside
// the block, and what is asserted is what is ON DISK: the file read back
// through the asset protocol and parsed. The fixture canvas is 641×361 and the
// export runs at 50 % (321×181 px → 240.75×135.75 pt), so a swapped axis, the
// canvas size or a 1 px = 1 pt page cannot land on a matching number.

import { invoke } from "@tauri-apps/api/core";
import { errorDetail, ipc, mediaUrl } from "../core/ipc";
import { navigate } from "../core/nav";
import { picturePageLayout } from "../core/picture-page";
import { currentSession, settingsStore, updateSettings } from "../core/session";
import type { ProjectFile } from "../core/types";
import type { PDFNumber, PDFRawStream as RawStreamT } from "pdf-lib";
import type { PreviewResources } from "../image/render";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the image blocks. */
export type ImagePdfCtx = Wave1Ctx;

/** The part of the image editor's DEV handle this block reads. */
interface ImageDevLite {
  res: PreviewResources;
  layers(): readonly { kind: string; trackId: string }[];
}

const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const $ = <E extends Element = HTMLElement>(sel: string): E | null => document.querySelector<E>(sel);
const text = (sel: string): string => ($(sel)?.textContent ?? "").trim();
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

function imageDev(): ImageDevLite | undefined {
  return (window as unknown as { __tarotingImageDev?: ImageDevLite }).__tarotingImageDev;
}
function onScreen(): string {
  const scr = $(".imged") ? "image editor" : $(".editor") ? "video editor" : $(".home") ? "home" : "?";
  const dlg = $(".modal-backdrop") ? `dialog "${text(".modal-backdrop .modal__header")}"` : "no dialog";
  return `${scr}, ${dlg}`;
}
async function until<T>(get: () => T | null | undefined | false, timeoutMs: number, what: () => string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what()}`);
    await sleep(20);
  }
}

export async function runImagePdfBlocks(ctx: ImagePdfCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const GRID = `${fixturesDir}\\image_grid_641x361.png`;
  /** clear columns beside opaque ones (the fixture autotest-image.ts's alpha export uses) */
  const ALPHA = `${fixturesDir}\\image_alpha_97x61.png`;

  await test("image-export-pdf", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    let out = "";
    const lastDir = settingsStore.get().lastExportDir;
    try {
      assert(await ipc.pathExists(GRID).catch(() => false), "image fixture image_grid_641x361.png missing — run npm run fixtures");
      // Scratch output: the autotest root, never the owner's folders.
      const dir = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
      assert(/taroting-autotest/i.test(dir), `the scratch folder ${dir} is not inside the autotest root — refusing to write there`);
      out = `${dir}\\autotest-image-export.pdf`;
      await removeTestFile(out).catch(() => {});

      const info = await ipc.probeMedia(GRID).catch((e: unknown) => {
        throw new Error(`probing the grid fixture failed: ${errorDetail(e).message}`);
      });
      const { createPhotoImageProject } = await import("../core/image-project");
      const project: ProjectFile = createPhotoImageProject("Autotest image PDF", info);
      const path = await ipc.tempProjectPath("Autotest image PDF");
      paths.push(path);
      await ipc.saveProject(path, project);
      const prev = imageDev();
      navigate({ view: "editor", projectPath: path, temp: true });
      const dev = await until(
        () => {
          const d = imageDev();
          return d && d !== prev && $(".imged") && $("#ed-export") ? d : null;
        },
        8_000,
        () => `the image editor — on screen: ${onScreen()}`,
      );
      const photo = dev.layers().find((l) => l.kind === "photo");
      assert(photo !== undefined, "the project has no photo layer");
      await until(() => dev.res.status(photo!.trackId).state !== "loading", 4_000, () => "the photo to decode");

      // The dialog: PDF, 50 %, the scratch folder.
      $<HTMLButtonElement>("#ed-export")!.click();
      await until(() => $(".export-modal #ix-name"), 2_000, () => `the export dialog (${onScreen()})`);
      const pdfBtn = $<HTMLButtonElement>('.export-modal [data-format="pdf"]');
      assert(pdfBtn !== null, "the export dialog offers no PDF format");
      pdfBtn!.click();
      assert(text(".export-modal #ix-ext") === ".pdf", `the file name ends in "${text(".export-modal #ix-ext")}", not ".pdf"`);
      const sel = $<HTMLSelectElement>(".export-modal #ix-size")!;
      sel.value = "50";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      assert(text(".export-modal #ix-px") === "321 × 181 px", `the dialog plans "${text(".export-modal #ix-px")}" for 50%, not "321 × 181 px"`);
      const quality = text(".export-modal #ix-quality-value");
      for (const [s, value] of [["#ix-folder", dir], ["#ix-name", "autotest-image-export"]] as const) {
        const el = $<HTMLInputElement>(`.export-modal ${s}`)!;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      $<HTMLButtonElement>(".export-modal #ix-run")!.click();
      const end = await until(
        () =>
          $(".export-modal #ix-reveal")
            ? "ok"
            : $(".export-modal .export-result__icon--bad")
              ? "error"
              : $(".export-modal #ix-warn-slot .export-warn")
                ? "warn"
                : null,
        8_000,
        () => `the PDF export to finish (dialog "${text(".export-modal #ix-body").slice(0, 160)}")`,
      );
      assert(end === "ok", `the PDF export ended in ${end}: "${text(".export-modal #ix-body").slice(0, 160)}"`);
      $<HTMLButtonElement>(".export-modal [data-close-btn]")!.click();
      await until(() => !$(".export-modal"), 2_000, () => "the export dialog to close");
      for (const ext of [".taroting-part", ".part"]) {
        assert(!(await ipc.pathExists(out + ext)), `the PDF export left autotest-image-export.pdf${ext} behind`);
      }

      // Read it back and parse it.
      const res = await fetch(mediaUrl(out), { cache: "no-store" });
      assert(res.ok, `reading the exported PDF back failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const magic = new TextDecoder("latin1").decode(bytes.slice(0, 5));
      assert(magic === "%PDF-", `the exported file starts "${magic}", not "%PDF-"`);
      const { PDFDocument, PDFName, PDFRawStream } = await import("pdf-lib");
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      assert(pdf.getPageCount() === 1, `the PDF has ${pdf.getPageCount()} pages, not 1`);
      const want = picturePageLayout(321, 181, "picture");
      const box = pdf.getPage(0).getMediaBox();
      assert(
        Math.abs(box.width - want.pageW) < 0.01 && Math.abs(box.height - want.pageH) < 0.01 && box.x === 0 && box.y === 0,
        `the page's MediaBox is ${box.x},${box.y} ${box.width}×${box.height}, not 0,0 ${want.pageW}×${want.pageH}`,
      );
      const images: { w: number; h: number; filter: string; smask: boolean }[] = [];
      for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
        const n = (k: string): number => (obj.dict.get(PDFName.of(k)) as PDFNumber | undefined)?.asNumber() ?? -1;
        images.push({ w: n("Width"), h: n("Height"), filter: String(obj.dict.get(PDFName.of("Filter"))), smask: obj.dict.has(PDFName.of("SMask")) });
      }
      // A lossless page also holds its alpha as a second (mask) image of the
      // same size: the picture is the one that names a mask.
      const sized = images.filter((i) => i.w === 321 && i.h === 181);
      const main = sized.find((i) => i.smask) ?? sized[0];
      assert(main !== undefined, `no image XObject of 321×181 in the PDF (found ${images.map((i) => `${i.w}×${i.h} ${i.filter}`).join(", ") || "none"})`);
      const expectFilter = quality === "Lossless" ? "/FlateDecode" : "/DCTDecode";
      assert(main!.filter === expectFilter, `the page's picture is ${main!.filter} at quality "${quality}", expected ${expectFilter}`);
      assert(pdf.getAuthor() === undefined, `the PDF names an author: "${String(pdf.getAuthor())}"`);

      // Lossless (quality 100) of a picture WITH transparency: the streamed
      // path (canvas strips → CompressionStream → raw /FlateDecode image + a
      // DeviceGray /SMask). Rendered through the same function the dialog
      // calls, on the 97×61 alpha fixture (clear columns beside opaque ones),
      // so the real canvas readback and the engine's deflate are exercised.
      assert(await ipc.pathExists(ALPHA).catch(() => false), "image fixture image_alpha_97x61.png missing — run npm run fixtures");
      const alphaInfo = await ipc.probeMedia(ALPHA);
      const alphaDoc: ProjectFile = createPhotoImageProject("Autotest image PDF alpha", alphaInfo);
      assert(alphaDoc.image?.background === "transparent", `precondition: the alpha project's background is ${String(alphaDoc.image?.background)}`);
      const { renderImageExport } = await import("../image/render/export");
      const seen: number[] = [];
      const lossless = await renderImageExport(alphaDoc, { format: "pdf", quality: 100, outW: 97, outH: 61 }, new AbortController().signal, (r) =>
        seen.push(r),
      );
      const lb = new Uint8Array(await lossless.arrayBuffer());
      const lmagic = new TextDecoder("latin1").decode(lb.slice(0, 5));
      assert(lossless.type === "application/pdf" && lmagic === "%PDF-", `the lossless export is ${lossless.type} starting "${lmagic}", not a PDF`);
      assert(seen.at(-1) === 1, `the lossless export's progress ended at ${String(seen.at(-1))}, not 1`);
      const lpdf = await PDFDocument.load(lb, { updateMetadata: false });
      assert(lpdf.getPageCount() === 1, `the lossless PDF has ${lpdf.getPageCount()} pages, not 1`);
      let picture: RawStreamT | null = null;
      for (const [, obj] of lpdf.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image") && obj.dict.has(PDFName.of("SMask"))) picture = obj;
      }
      assert(picture !== null, "the lossless PDF of a transparent picture has no image with an /SMask");
      const pd = picture!.dict;
      const pn = (d: typeof pd, k: string): number => (d.get(PDFName.of(k)) as PDFNumber | undefined)?.asNumber() ?? -1;
      assert(pn(pd, "Width") === 97 && pn(pd, "Height") === 61, `the lossless picture is ${pn(pd, "Width")}×${pn(pd, "Height")}, not 97×61`);
      assert(String(pd.get(PDFName.of("Filter"))) === "/FlateDecode", `the lossless picture is ${String(pd.get(PDFName.of("Filter")))}, not /FlateDecode`);
      const maskObj = lpdf.context.lookup(pd.get(PDFName.of("SMask")));
      assert(maskObj instanceof PDFRawStream, "the /SMask is not a stream");
      const inflate = async (b: Uint8Array): Promise<Uint8Array> =>
        new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
      const rgb = await inflate(picture!.contents);
      const alpha = await inflate((maskObj as RawStreamT).contents);
      assert(rgb.length === 97 * 61 * 3, `the picture inflates to ${rgb.length} B, not ${97 * 61 * 3}`);
      assert(alpha.length === 97 * 61, `the mask inflates to ${alpha.length} B, not ${97 * 61}`);
      assert(alpha.includes(0) && alpha.includes(255), `the mask holds no fully clear AND no fully opaque pixel (min ${Math.min(...alpha)}, max ${Math.max(...alpha)})`);
      return `dialog PDF 50% → ${bytes.length} B, 1 page ${box.width}×${box.height} pt, picture 321×181 ${main!.filter} at quality "${quality}", no author; lossless alpha → ${lb.length} B, /FlateDecode 97×61 + /SMask (clear and opaque pixels) — ${ms(t0)}`;
    } finally {
      try {
        closeMenu();
        for (const b of Array.from(document.querySelectorAll<HTMLElement>(".modal-backdrop"))) {
          const x = b.querySelector<HTMLElement>("[data-cancel], [data-close], [data-close-btn]");
          if (x) x.click();
          else b.remove();
        }
        const s = currentSession.get();
        if (s && s.temp.get()) await discardTempSession(s);
        navigate({ view: "home" });
        await until(() => $(".home") && !$(".editor"), 5_000, () => `Home (${onScreen()})`);
      } catch (e) {
        console.error("image PDF autotest: cleanup did not finish", e);
      }
      for (const p of paths) await ipc.deleteProject(p).catch(() => {});
      if (out) await removeTestFile(out).catch(() => {});
      await updateSettings({ lastExportDir: lastDir }).catch(() => {});
    }
  });
}
