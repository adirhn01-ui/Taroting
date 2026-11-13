// 0.9.5 E2E blocks: styling part of a text in an image project. DEV-only:
// imported lazily by autotest.ts, never part of a release bundle.
//
// NOTHING under src/image or src/editor is imported statically here: each
// block reaches the module it drives with `await import(...)` (type-only
// imports are erased), so loading this file loads no lazy chunk.
//
// What a block asserts is what is ON SCREEN or ON DISK: the stage's pixels at
// zoom 1, a decoded PNG export's alpha, what a saved file reads back as.
// Selections go through the document's own selection, so the editor hears the
// same selectionchange a mouse makes.
//
// Every block works on its own temporary project and ends on Home with every
// file it wrote deleted. Waits poll at 20 ms with their own short deadline.

import { ipc } from "../core/ipc";
import { createBlankImageProject } from "../core/image-project";
import { navigate } from "../core/nav";
import { currentSession, type ProjectSession } from "../core/session";
import type { Generator, ProjectFile } from "../core/types";
import type { ImageEditorCtx, TextEditHandle, ViewController } from "../image/context";
import type { Layer } from "../image/layers";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type TextRunsCtx = Wave1Ctx;

type TextGen = Extract<Generator, { type: "text" }>;

/** What the image editor publishes on window while mounted (image-editor.ts, DEV). */
interface ImageDev {
  session: ProjectSession;
  view: ViewController;
  canvas: HTMLCanvasElement;
  ctx: ImageEditorCtx;
  text: { edit(trackId: string): boolean };
  renderNow(): void;
  layers(): readonly Layer[];
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
/** JSON with every object's keys sorted: the project file and the IPC answer
 *  carry a generator's keys in their own order, so two generators are
 *  compared by content, never by key order. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
}
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

const imageDev = (): ImageDev | undefined => (window as unknown as { __tarotingImageDev?: ImageDev }).__tarotingImageDev;
const textOf = (l: Layer | undefined): TextGen | null => (l && l.media.generator?.type === "text" ? (l.media.generator as TextGen) : null);

/** A PNG export of `p` at 100%, decoded: its RGBA. */
async function exportRgba(p: ProjectFile): Promise<{ w: number; h: number; d: Uint8ClampedArray }> {
  const { renderImageExport } = await import("../image/render/export");
  const W = p.timeline.width;
  const H = p.timeline.height;
  const blob = await renderImageExport(p, { format: "png", quality: 92, outW: W, outH: H }, new AbortController().signal, () => {});
  const bmp = await createImageBitmap(blob);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const g = oc.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return { w: oc.width, h: oc.height, d: g.getImageData(0, 0, oc.width, oc.height).data };
}

export async function runTextRunsBlocks(ctx: TextRunsCtx): Promise<void> {
  const { test, assert } = ctx;

  /** Close dialogs, discard a temp session, park on Home, delete `paths`.
   *  Never throws. */
  const backHome = async (paths: readonly string[] = []): Promise<void> => {
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
      console.error("text runs autotest: cleanup did not finish", e);
    }
    for (const p of paths) if (p) await ipc.deleteProject(p).catch(() => {});
  };

  /** A project with one text layer (its box measured for real), saved to a
   *  temporary path and opened in the image editor at 100% on whole device
   *  pixels. */
  const openWithText = async (name: string, W: number, H: number, g: TextGen, paths: string[]): Promise<{ dev: ImageDev; path: string; trackId: string }> => {
    const { addGeneratorLayer } = await import("../image/layers");
    const { measureText } = await import("../editor/media/generators");
    const box = measureText(g);
    const made = addGeneratorLayer(createBlankImageProject(name, W, H, "#ffffff"), g, box.width, box.height, "Text");
    const path = await ipc.tempProjectPath(name);
    paths.push(path);
    await ipc.saveProject(path, made.project);
    const prev = imageDev();
    navigate({ view: "editor", projectPath: path, temp: true });
    const dev = await until(() => {
      const d = imageDev();
      return d && d !== prev && $(".imged") ? d : null;
    }, 8_000, () => `the image editor on "${name}" — on screen: ${onScreen()}`);
    await frames(2);
    // The stage is not at 100% until asked: at 100%, on whole device pixels.
    dev.view.actual();
    const v = dev.view.store.get();
    const dx = Math.round(v.panX) - v.panX;
    const dy = Math.round(v.panY) - v.panY;
    if (dx !== 0 || dy !== 0) dev.view.panBy(dx / v.dpr, dy / v.dpr);
    const p = dev.view.store.get();
    if (!Number.isInteger(p.panX) || !Number.isInteger(p.panY)) dev.view.store.set({ ...p, panX: Math.round(p.panX), panY: Math.round(p.panY) });
    await frames(2);
    const trackId = dev.layers().find((l) => l.kind === "text")!.trackId;
    return { dev, path, trackId };
  };

  /** The stage's pixels of the canvas rectangle (zoom 1). */
  const stagePixels = (dev: ImageDev, W: number, H: number): Uint8ClampedArray => {
    dev.renderNow();
    const v = dev.view.store.get();
    assert(v.zoom === 1, `the stage is at zoom ${v.zoom}, not 1`);
    // Pixels outside the stage read as transparent black: the whole canvas
    // must be on it, or "black" pixels would come from nowhere.
    const x0 = Math.round(v.panX);
    const y0 = Math.round(v.panY);
    assert(
      x0 >= 0 && y0 >= 0 && x0 + W <= dev.canvas.width && y0 + H <= dev.canvas.height,
      `the ${W}x${H} canvas at zoom 1 (${x0}, ${y0}) does not fit the ${dev.canvas.width}x${dev.canvas.height} stage`,
    );
    return dev.canvas.getContext("2d")!.getImageData(Math.round(v.panX), Math.round(v.panY), W, H).data;
  };

  /** Select [s, e) of the open text through the document's selection. */
  const selectInEditor = (s: number, e: number): void => {
    const el = $(".imged-textedit");
    assert(el !== null, "no text is open for typing");
    const walker = document.createTreeWalker(el!, NodeFilter.SHOW_TEXT);
    let at = 0;
    let a: { n: Node; o: number } | null = null;
    let b: { n: Node; o: number } | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = (n as Text).data.length;
      if (!a && s <= at + len) a = { n, o: s - at };
      if (!b && e <= at + len) b = { n, o: e - at };
      at += len;
    }
    assert(a !== null && b !== null, `[${s}, ${e}) is not inside the open text`);
    document.getSelection()!.setBaseAndExtent(a!.n, a!.o, b!.n, b!.o);
  };

  await test("image-text-range-style", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const W = 420;
      const H = 220;
      const g: TextGen = { type: "text", text: "Ab Cd", fontFamily: "Georgia", sizePx: 96, color: "#000000", bold: false, italic: false };
      const { dev, path, trackId } = await openWithText("Autotest text runs", W, H, g, paths);
      assert(dev.text.edit(trackId), "the text did not open for typing");
      const te = dev.ctx.textEdit!;
      await until(() => te.get()?.trackId === trackId, 2_000, () => "the open text's handle");
      selectInEditor(3, 5);
      const h = await until(
        () => {
          const x = te.get();
          return x && x.range && x.range.s === 3 && x.range.e === 5 ? x : null;
        },
        2_000,
        () => `the selected part [3, 5) on the handle (it says ${JSON.stringify(te.get()?.range ?? null)})`,
      );
      assert(typeof h.applyRange === "function", "the handle cannot style a selected part");
      h.applyRange!({ color: "#0044ff" });
      const gNow = textOf(dev.layers().find((l) => l.trackId === trackId));
      assert(canon(gNow?.runs) === canon([{ s: 3, e: 5, c: "#0044ff" }]), `the layer's runs are ${JSON.stringify(gNow?.runs)}`);
      await frames(1);

      // "Cd" blue, "Ab" black, and nothing blue left of the last black pixel.
      const px = stagePixels(dev, W, H);
      let blue = 0;
      let black = 0;
      let blueMinX = Infinity;
      let blackMaxX = -Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const r = px[i]!;
          const gg = px[i + 1]!;
          const b = px[i + 2]!;
          if (b > 150 && b - r > 90 && b - gg > 40) {
            blue++;
            if (x < blueMinX) blueMinX = x;
          } else if (r < 70 && gg < 70 && b < 70) {
            black++;
            if (x > blackMaxX) blackMaxX = x;
          }
        }
      }
      assert(blue > 300 && black > 300, `the stage shows ${blue} blue and ${black} black pixels`);
      assert(blueMinX > blackMaxX, `blue starts at x ${blueMinX}, black reaches x ${blackMaxX}: the colour is not on "Cd" alone`);

      // The export draws what the stage draws.
      const ex = await exportRgba(dev.session.project);
      let exBlue = 0;
      for (let i = 0; i < ex.d.length; i += 4) if (ex.d[i + 2]! > 150 && ex.d[i + 2]! - ex.d[i]! > 90 && ex.d[i + 2]! - ex.d[i + 1]! > 40) exBlue++;
      assert(Math.abs(exBlue - blue) <= 0.05 * blue, `the export has ${exBlue} blue pixels, the stage ${blue}`);

      // Escape lands ONE step; one undo takes the style back.
      const el = $(".imged-textedit")!;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      await until(() => !$(".imged-textedit"), 2_000, () => "the text to close on Escape");
      const landed = textOf(dev.layers().find((l) => l.trackId === trackId))!;
      dev.session.undo();
      const undone = textOf(dev.layers().find((l) => l.trackId === trackId))!;
      assert(!("runs" in undone) && undone.text === "Ab Cd", `after one undo the text is ${JSON.stringify(undone)}`);
      dev.session.redo();

      // Saved and read back: the same generator, field for field (the file
      // keeps its keys in its own order).
      await ipc.saveProject(path, dev.session.project);
      const back = await ipc.loadProject(path);
      const read = back.project.media.find((m) => m.generator?.type === "text")?.generator;
      assert(canon(read) === canon(landed), `read back ${JSON.stringify(read)}, saved ${JSON.stringify(landed)}`);
      return `"Cd" ${blue} blue px from x ${blueMinX}, "Ab" ${black} black px to x ${blackMaxX}; export ${exBlue} blue; undo and the saved bytes OK — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });

  await test("image-colour-run-mask", async () => {
    const t0 = performance.now();
    const { addGeneratorLayer } = await import("../image/layers");
    const { measureText } = await import("../editor/media/generators");
    const W = 520;
    const H = 260;
    const plain: TextGen = { type: "text", text: "Sky glyph\nquay", fontFamily: "Times New Roman", sizePx: 72, color: "#202020", bold: false, italic: false };
    const styled: TextGen = { ...plain, runs: [{ s: 4, e: 9, c: "#e01060" }] };
    const make = (g: TextGen): ProjectFile => {
      const b = measureText(g);
      return addGeneratorLayer(createBlankImageProject("Autotest run mask", W, H, "transparent"), g, b.width, b.height, "Text").project;
    };
    const bp = measureText(plain);
    const bs = measureText(styled);
    assert(bp.width === bs.width && bp.height === bs.height, `a colour-only style changed the box: ${bp.width}x${bp.height} vs ${bs.width}x${bs.height}`);
    const a = await exportRgba(make(plain));
    const b = await exportRgba(make(styled));
    let inkA = 0;
    let off = 0;
    let colored = 0;
    for (let i = 3; i < a.d.length; i += 4) {
      if (a.d[i]! > 0) inkA++;
      if (Math.abs(a.d[i]! - b.d[i]!) > 24) off++;
      if (b.d[i]! > 200 && b.d[i - 3]! > 150 && b.d[i - 1]! < 140) colored++;
    }
    assert(inkA > 1000, `the plain text drew ${inkA} pixels`);
    assert(colored > 200, `the recoloured word drew ${colored} pink pixels`);
    // The same glyphs in the same places: a baseline moved the wrong way
    // shifts every glyph and this count with it.
    assert(off <= 0.01 * inkA, `${off} of ${inkA} inked pixels differ in alpha between the plain and the recoloured text`);
    return `alpha masks agree: ${off} of ${inkA} pixels off by > 24; ${colored} pink — ${ms(t0)}`;
  });

  await test("text-runs-r1", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const W = 301;
      const H = 203;
      const g: TextGen = { type: "text", text: "Plain", fontFamily: "Arial", sizePx: 40, color: "#336699", bold: false, italic: false };
      const { dev, trackId } = await openWithText("Autotest text plain", W, H, g, paths);
      assert(dev.text.edit(trackId), "the text did not open for typing");
      const el = await until(() => $(".imged-textedit"), 2_000, () => "the open text");
      assert(el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE, `a plain text is typed as ${el.childNodes.length} nodes (${el.innerHTML.slice(0, 80)})`);
      const typed = document.execCommand("insertText", false, "x");
      assert(typed, "typing did not reach the text");
      assert(el.querySelector("span") === null, "a plain text grew spans");
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      await until(() => !$(".imged-textedit"), 2_000, () => "the text to close on Escape");
      const out = textOf(dev.layers().find((l) => l.trackId === trackId))!;
      const want = { ...g, text: "Plainx" };
      // Field for field: the opened generator came from disk, in the file's
      // key order.
      assert(canon(out) === canon(want), `the plain text saved as ${JSON.stringify(out)}`);
      const h: TextEditHandle | null = dev.ctx.textEdit?.get() ?? null;
      assert(h === null, "a handle is still published after the text closed");
      return `plain text typed as one text node, closed as ${JSON.stringify(out)} — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });
}
