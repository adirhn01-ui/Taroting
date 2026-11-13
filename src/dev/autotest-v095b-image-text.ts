// 0.9.5 E2E blocks: the image editor's Text tool (click to place a text
// layer, type in it in place, restyle it while it is open) and the text
// rules on load and on save. DEV-only: imported lazily by autotest.ts, never
// part of a release bundle.
//
// NOTHING under src/image or src/editor is imported statically here: each
// block reaches the module it drives with `await import(...)` (type-only
// imports are erased), so loading this file loads no lazy chunk.
//
// What a block asserts is what is ON SCREEN or ON DISK: the element hit at a
// point, the caret's own client rectangle, the stage's pixels, a decoded PNG
// export, what the save command accepts or refuses. Typing goes through the
// browser's editing pipeline (`execCommand("insertText")`), so the editor
// hears the same beforeinput / input events a keyboard makes.
//
// Fixture values differ on every axis: a 301×203 canvas (odd sides, not a
// video size), a click at (60, 80) (neither centred nor on the axes), a text
// size that is not the tool default.
//
// Every block works on its own temporary project and ends on Home with every
// file it wrote deleted. Waits poll at 20 ms with their own short deadline.

import { describeError, ipc } from "../core/ipc";
import { createBlankImageProject } from "../core/image-project";
import { navigate } from "../core/nav";
import { currentSession, type ProjectSession } from "../core/session";
import type { Store } from "../core/store";
import type { Generator, ProjectFile } from "../core/types";
import type { ImageEditorCtx, ViewController } from "../image/context";
import type { Layer } from "../image/layers";
import type { ToolState } from "../image/tool-state";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type ImageTextCtx = Wave1Ctx;

type TextGen = Extract<Generator, { type: "text" }>;

/** What the image editor publishes on window while mounted (image-editor.ts, DEV). */
interface ImageDev {
  session: ProjectSession;
  tools: Store<ToolState>;
  view: ViewController;
  selection: Store<string | null>;
  canvas: HTMLCanvasElement;
  ctx: ImageEditorCtx;
  renderNow(): void;
  layers(): readonly Layer[];
}

const W = 301;
const H = 203;

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
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
const f1 = (n: number): string => n.toFixed(1);

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

const imageDev = (): ImageDev | undefined => (window as unknown as { __tarotingImageDev?: ImageDev }).__tarotingImageDev;

/** A key as the keyboard sends it: at the focused element (or <body>), up to window. */
function key(k: string, code: string, target: EventTarget = document.activeElement ?? document.body, mods: { ctrl?: boolean } = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, code, ctrlKey: mods.ctrl === true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

/** A left press at a client point, delivered to what is THERE. */
function pressAt(x: number, y: number): Element | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
  hit.dispatchEvent(new PointerEvent("pointerdown", init));
  hit.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  return hit;
}

/** Type through the browser's editing pipeline (beforeinput / input). */
function type(text: string): boolean {
  return document.execCommand("insertText", false, text);
}

const textOf = (l: Layer | undefined): TextGen | null => (l && l.media.generator?.type === "text" ? (l.media.generator as TextGen) : null);
const editorEl = (): HTMLElement | null => $(".imged-textedit");

interface Luma { w: number; h: number; y: Uint8ClampedArray }
function lumaOf(data: Uint8ClampedArray, w: number, h: number): Luma {
  const y = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) y[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  return { w, h, y };
}
/** Dark pixels (< 128) inside [x0,x1)×[y0,y1). */
function darkIn(l: Luma, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(l.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(l.w, x1); x++) if (l.y[y * l.w + x]! < 128) n++;
  return n;
}

export async function runImageTextToolBlocks(ctx: ImageTextCtx): Promise<void> {
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
      console.error("image text autotest: cleanup did not finish", e);
    }
    for (const p of paths) if (p) await ipc.deleteProject(p).catch(() => {});
  };

  /** A white 301×203 image project, optionally with layers, opened at 100%. */
  const openImage = async (name: string, paths: string[], build?: (p: ProjectFile) => Promise<ProjectFile>): Promise<ImageDev> => {
    let p = createBlankImageProject(name, W, H, "#ffffff");
    if (build) p = await build(p);
    const path = await ipc.tempProjectPath(name);
    paths.push(path);
    await ipc.saveProject(path, p);
    const prev = imageDev();
    navigate({ view: "editor", projectPath: path, temp: true });
    const dev = await until(() => {
      const d = imageDev();
      return d && d !== prev && $(".imged") ? d : null;
    }, 8_000, () => `the image editor on "${name}" — on screen: ${onScreen()}`);
    await frames(2);
    dev.view.actual();
    await frames(2);
    await alignPan(dev);
    return dev;
  };

  /** `actual()` centres the canvas: (stage − 301) / 2 and (stage − 203) / 2
   *  are half a device pixel whenever the stage's side has the other parity,
   *  and the stage then draws every glyph straddling two pixels (fewer dark
   *  pixels than the export, which draws on whole ones). Move the canvas by
   *  that half pixel, through the user's own pan, so the stage and the export
   *  put the same canvas pixel on a whole device pixel. */
  const alignPan = async (dev: ImageDev): Promise<void> => {
    const v = dev.view.store.get();
    const dx = Math.round(v.panX) - v.panX;
    const dy = Math.round(v.panY) - v.panY;
    if (dx === 0 && dy === 0) return;
    dev.view.panBy(dx / v.dpr, dy / v.dpr);
    // CSS px × dpr can come back a hair off a whole number: settle it exactly.
    const p = dev.view.store.get();
    if (!Number.isInteger(p.panX) || !Number.isInteger(p.panY)) dev.view.store.set({ ...p, panX: Math.round(p.panX), panY: Math.round(p.panY) });
    await frames(2);
  };

  /** A project with one text layer, its box measured for real. */
  const withText = (g: TextGen) => async (p: ProjectFile): Promise<ProjectFile> => {
    const { addGeneratorLayer } = await import("../image/layers");
    const { measureText } = await import("../editor/media/generators");
    const box = measureText(g);
    return addGeneratorLayer(p, g, box.width, box.height, "Text").project;
  };

  const client = (dev: ImageDev, x: number, y: number): { x: number; y: number } => dev.view.canvasToClient(x, y);

  /** The canvas px of a layer's layer-local (0, 0): its box's top-left. */
  const originOf = async (l: Layer): Promise<{ x: number; y: number }> => {
    const { layerToCanvas } = await import("../image/geom");
    const m = layerToCanvas(l.transform, l.media.width!, l.media.height!, W, H);
    return { x: m[4], y: m[5] };
  };

  /** The stage at zoom 1 on whole device pixels, the canvas region only, as
   *  luma. */
  const stageLuma = (dev: ImageDev): Luma | string => {
    dev.renderNow();
    const v = dev.view.store.get();
    if (v.zoom !== 1) return `zoom ${v.zoom}, not 1 after actual()`;
    if (!Number.isInteger(v.panX) || !Number.isInteger(v.panY)) return `the canvas sits at (${v.panX}, ${v.panY}) on the stage, not on whole device pixels`;
    const x0 = v.panX;
    const y0 = v.panY;
    if (x0 < 0 || y0 < 0 || x0 + W > dev.canvas.width || y0 + H > dev.canvas.height) {
      return `the canvas at zoom 1 (${x0},${y0}) does not fit the ${dev.canvas.width}x${dev.canvas.height} stage`;
    }
    return lumaOf(dev.canvas.getContext("2d")!.getImageData(x0, y0, W, H).data, W, H);
  };

  await test("image-text-place-type", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const dev = await openImage("Autotest image text place", paths);
      const { session } = dev;
      assert(dev.layers().length === 0 && !session.history.canUndo, `a fresh blank project has ${dev.layers().length} layers, canUndo ${session.history.canUndo}`);

      // T takes up the Text tool (the image screen's own chord).
      key("t", "KeyT", document.body);
      await frames(1);
      assert(dev.tools.get().tool === "text", `T left the tool at ${dev.tools.get().tool}`);
      const btn = $<HTMLButtonElement>('.imged-toolbar [data-tool="text"]');
      assert(btn !== null && btn.classList.contains("btn--on"), `the toolbar's Text button is ${btn ? "not pressed" : "missing"}`);

      // A click on the canvas at (60, 80): what is there is the tool's surface.
      const at = client(dev, 60, 80);
      const hit = pressAt(at.x, at.y);
      assert(hit !== null && hit.classList.contains("imged-textsurface"), `the press at canvas (60, 80) landed on ${describeEl(hit)}, not the Text tool's surface`);
      const ed = await until(editorEl, 1_000, () => "the in-place text editor to open");
      assert(document.activeElement === ed, `the keyboard is on ${describeEl(document.activeElement)}, not the text`);
      const placed = dev.layers();
      assert(placed.length === 1 && placed[0]!.kind === "text", `the click left ${placed.length} layers (${placed.map((l) => l.kind).join(", ")})`);
      const id = placed[0]!.trackId;
      assert(dev.selection.get() === id, "the new text is not the selected layer");
      assert(!session.history.canUndo, "placing an empty text already pushed an undo step");
      const size = textOf(placed[0])!.sizePx;
      const step = size * 1.25;

      // Type two lines through the editing pipeline.
      assert(type("Hello"), "execCommand insertText was refused");
      document.execCommand("insertLineBreak");
      type("World");
      await frames(1);
      const live = dev.layers().find((l) => l.trackId === id);
      assert(textOf(live)?.text === "Hello\nWorld", `the layer holds ${JSON.stringify(textOf(live)?.text)}, not "Hello\\nWorld"`);
      // The box grew right and down: its left edge is still the click, its
      // first line still centred on it (whole pixels).
      const o = await originOf(live!);
      assert(Math.abs(o.x - 60) <= 0.5 && Math.abs(o.y - (80 - step / 2)) <= 0.5, `the box's top-left is (${f1(o.x)}, ${f1(o.y)}), not (60, ${f1(80 - step / 2)})`);
      assert(live!.media.height! >= 2 * step - 1, `the box is ${live!.media.height} px high for two ${f1(step)} px lines`);

      // The caret is on line 2 where the canvas draws it, at zoom 1.
      const sel = window.getSelection();
      assert(sel !== null && sel.rangeCount === 1, "no caret in the text");
      const cr = sel!.getRangeAt(0).getClientRects()[0] ?? sel!.getRangeAt(0).getBoundingClientRect();
      const line2 = client(dev, 0, o.y + 1.5 * step).y;
      const mid = cr.top + cr.height / 2;
      assert(cr.height > 0 && Math.abs(mid - line2) <= step * 0.35, `the caret's middle is at y ${f1(mid)}, line 2's middle at ${f1(line2)} (step ${f1(step)})`);
      const right = client(dev, o.x + live!.media.width!, 0).x;
      assert(cr.left > at.x + 5 && cr.left <= right + 2, `the caret sits at x ${f1(cr.left)}, outside the text (${f1(at.x)} to ${f1(right)})`);

      // The canvas draws the typed text: dark pixels inside the box.
      const s = stageLuma(dev);
      assert(typeof s !== "string", String(s));
      const ink = darkIn(s as Luma, Math.floor(o.x), Math.floor(o.y), Math.ceil(o.x + live!.media.width!), Math.ceil(o.y + live!.media.height!));
      assert(ink > 60, `only ${ink} dark pixels in the text's box on the stage`);

      // Escape lands ONE step, keeps the layer selected and the tool in hand.
      const esc = key("Escape", "Escape", ed);
      assert(esc.defaultPrevented, "the editor did not take its Escape");
      await frames(1);
      assert(editorEl() === null, "the editor is still open after Escape");
      assert(session.history.canUndo, "the typed text left no undo step");
      assert(dev.tools.get().tool === "text" && dev.selection.get() === id, `after Escape: tool ${dev.tools.get().tool}, selection ${dev.selection.get()}`);
      session.undo();
      await frames(1);
      assert(dev.layers().length === 0, `one undo left ${dev.layers().length} layers: the edit was more than one step`);
      assert(!session.history.canUndo, "the text took more than one undo step");
      session.redo();
      await frames(1);
      assert(textOf(dev.layers()[0])?.text === "Hello\nWorld", "redo did not bring the text back whole");

      // Idle: no frame asked for while nothing changes.
      let asked = 0;
      const realRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        asked++;
        return realRaf.call(window, cb);
      };
      try {
        await sleep(300);
      } finally {
        window.requestAnimationFrame = realRaf;
      }
      assert(asked === 0, `an idle editor with a committed text asked for ${asked} frames in 300 ms`);

      // The 100% PNG export against the stage at zoom 1, both read now, with
      // the text landed (the same project the export renders).
      const shown = stageLuma(dev);
      assert(typeof shown !== "string", String(shown));
      const box = [Math.floor(o.x), Math.floor(o.y), Math.ceil(o.x + live!.media.width!), Math.ceil(o.y + live!.media.height!)] as const;
      const shownInk = darkIn(shown as Luma, ...box);
      // The canvas under the open editor is the canvas after it closed: the
      // editor's own text is transparent and draws nothing there.
      assert(Math.abs(shownInk - ink) <= 2, `the stage had ${ink} dark pixels in the text's box while it was open and ${shownInk} after Escape`);
      const { renderImageExport } = await import("../image/render/export");
      const blob = await renderImageExport(session.project, { format: "png", quality: 92, outW: W, outH: H }, new AbortController().signal, () => {});
      const bmp = await createImageBitmap(blob);
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const og = oc.getContext("2d")!;
      og.drawImage(bmp, 0, 0);
      bmp.close();
      assert(oc.width === W && oc.height === H, `the PNG decodes at ${oc.width}x${oc.height}`);
      const ex = lumaOf(og.getImageData(0, 0, W, H).data, W, H);
      const v = dev.view.store.get();
      let close = 0;
      for (let i = 0; i < ex.y.length; i++) if (Math.abs(ex.y[i]! - (shown as Luma).y[i]!) <= 2) close++;
      const share = close / ex.y.length;
      const exInk = darkIn(ex, ...box);
      // Both sides are the one Canvas2D renderer on whole pixels at 1:1, so
      // what may differ is the rasteriser of the stage's canvas against the
      // export's (a luma step or two at a glyph's edge: the fonts block sees
      // 100% within ±2). 1% of the pixels, and 3% of the ink (~30 px here),
      // absorb that; a real mismatch does not fit: half a pixel of offset
      // took ~10% of the ink, one px of font size ~6%.
      const where = `zoom ${v.zoom}, dpr ${v.dpr}, canvas at (${v.panX}, ${v.panY}); stage region ${W}x${H} of ${dev.canvas.width}x${dev.canvas.height}, export ${oc.width}x${oc.height}; text ${size} px, box ${box.join(",")}`;
      assert(share >= 0.99, `only ${(share * 100).toFixed(2)}% of the export's pixels are within ±2 of the stage (export ink ${exInk}, stage ink ${shownInk}; ${where})`);
      assert(Math.abs(exInk - shownInk) <= Math.max(6, shownInk * 0.03), `export ink ${exInk} vs stage ink ${shownInk} (${where})`);
      return `placed at (60, 80), ${size} px; two lines typed, caret on line 2 (Δ ${f1(Math.abs(mid - line2))} px); one undo step; 0 idle frames; export ${(share * 100).toFixed(2)}% within ±2, ink ${exInk} vs ${shownInk} at zoom 1, canvas at (${v.panX}, ${v.panY}) — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });

  await test("image-text-empty-and-emptied", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const keep: TextGen = { type: "text", text: "Keep me", fontFamily: "Arial", sizePx: 26, color: "#1a2b3c", bold: false, italic: false };
      const dev = await openImage("Autotest image text empty", paths, withText(keep));
      const { session } = dev;
      const id = dev.layers()[0]!.trackId;

      // A new text left empty: taken back, no step, not even an edit.
      key("t", "KeyT", document.body);
      await frames(1);
      const at = client(dev, 30, 30);
      pressAt(at.x, at.y);
      const ed = await until(editorEl, 1_000, () => "the editor for a new text");
      assert(dev.layers().length === 2, `the press placed ${dev.layers().length - 1} layers`);
      key("Escape", "Escape", ed);
      await frames(1);
      assert(editorEl() === null && dev.layers().length === 1, `an empty new text stayed: ${dev.layers().length} layers, editor ${editorEl() ? "open" : "closed"}`);
      assert(!session.history.canUndo, "an empty new text left an undo step");
      assert(!session.edited, "an empty new text counted as an edit of the temporary project");

      // The pasteboard holds nothing to type into.
      const v = dev.view.store.get();
      const off = client(dev, -12, H / 2);
      const stageRect = dev.canvas.getBoundingClientRect();
      if (off.x > stageRect.left + 2) {
        pressAt(off.x, off.y);
        await frames(1);
        assert(editorEl() === null && dev.layers().length === 1, "a press on the pasteboard opened a text");
      }

      // Select, double-click the text: it opens for typing, not its crop.
      key("v", "KeyV", document.body);
      await frames(1);
      const l = dev.layers()[0]!;
      const o = await originOf(l);
      const c = client(dev, o.x + l.media.width! / 2, o.y + l.media.height! / 2);
      dev.canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y, button: 0, detail: 2 }));
      const ed2 = await until(editorEl, 1_000, () => `the editor from a double-click (mode ${String(dev.ctx.mode.get())})`);
      assert(dev.ctx.mode.get() === "idle", `the double-click entered ${String(dev.ctx.mode.get())}`);
      assert(ed2.textContent === "Keep me", `the editor opened on ${JSON.stringify(ed2.textContent)}`);

      // Emptied and closed: the layer goes, in one step that undo takes back.
      document.execCommand("selectAll");
      document.execCommand("delete");
      await frames(1);
      assert(textOf(dev.layers()[0])?.text === "", `the emptied text reads ${JSON.stringify(textOf(dev.layers()[0])?.text)}`);
      key("Escape", "Escape", ed2);
      await frames(1);
      assert(dev.layers().length === 0, `the emptied text layer stayed (${dev.layers().length} layers)`);
      session.undo();
      await frames(1);
      const back = dev.layers();
      assert(back.length === 1 && back[0]!.trackId === id && textOf(back[0])?.text === "Keep me", `one undo gave ${back.length} layers, text ${JSON.stringify(textOf(back[0])?.text)}`);
      assert(!session.history.canUndo, "removing the emptied text took more than one step");
      return `empty new text taken back (no step, not an edit); pasteboard press ${off.x > stageRect.left + 2 ? "ignored" : "not reachable at this stage size"}; double-click typed, emptied text removed in one step — ${ms(t0)}${v.zoom === 1 ? "" : ` (zoom ${v.zoom})`}`;
    } finally {
      await backHome(paths);
    }
  });

  await test("image-text-restyle-while-open", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const g: TextGen = { type: "text", text: "Hi", fontFamily: "Georgia", sizePx: 34, color: "#203040", bold: false, italic: false };
      const dev = await openImage("Autotest image text restyle", paths, withText(g));
      const { session } = dev;
      const id = dev.layers()[0]!.trackId;
      dev.selection.set(id);
      await frames(2);
      const editBtn = await until(() => $<HTMLButtonElement>(".imged-text-section .imged-text-edit-btn"), 1_000, () => "the inspector's Edit text button");
      editBtn.click();
      const ed = await until(editorEl, 1_000, () => "the editor from Edit text");
      const o0 = await originOf(dev.layers()[0]!);
      const h0 = dev.layers()[0]!.media.height!;

      // Size from the inspector: the open text grows, from the same corner.
      const size = $<HTMLInputElement>('.imged-text-section input[type="number"]');
      assert(size !== null, "no size field in the text section");
      size!.value = "61";
      size!.dispatchEvent(new Event("change", { bubbles: true }));
      await frames(1);
      let l = dev.layers()[0]!;
      assert(textOf(l)?.sizePx === 61, `the size field left sizePx at ${textOf(l)?.sizePx}`);
      assert(editorEl() === ed && ed.isConnected, "the size change closed the editor");
      assert(l.media.height! > h0, `the box did not grow with the size (${h0} → ${l.media.height})`);
      const o1 = await originOf(l);
      assert(Math.abs(o1.x - o0.x) < 1e-6 && Math.abs(o1.y - o0.y) < 1e-6, `the box moved: (${f1(o0.x)}, ${f1(o0.y)}) → (${f1(o1.x)}, ${f1(o1.y)})`);
      assert(getComputedStyle(ed).fontSize === "61px", `the editor's text is ${getComputedStyle(ed).fontSize}, not 61px`);

      // Bold: still open, and the keyboard is back in the text.
      const bold = $$<HTMLInputElement>(".imged-text-section input.switch")[0];
      assert(bold !== undefined && !bold.disabled, "no Bold switch, or it is disabled for Georgia");
      // A real press moves the keyboard to the switch first (a synthetic
      // click alone would leave it in the text, and the hand-back below
      // would pass whether or not it works).
      bold!.focus();
      assert(document.activeElement === bold, `focusing Bold left the keyboard on ${describeEl(document.activeElement)}`);
      assert(editorEl() === ed && ed.isConnected, "moving the keyboard to Bold closed the editor");
      bold!.click();
      await frames(1);
      l = dev.layers()[0]!;
      assert(textOf(l)?.bold === true && editorEl() === ed, `bold ${textOf(l)?.bold}, editor ${editorEl() === ed ? "open" : "closed"}`);
      assert(document.activeElement === ed, `after Bold the keyboard is on ${describeEl(document.activeElement)}`);
      type("!");
      await frames(1);
      assert(textOf(dev.layers()[0])?.text === "Hi!", `typing after the restyle gave ${JSON.stringify(textOf(dev.layers()[0])?.text)}`);

      key("Escape", "Escape", ed);
      await frames(1);
      assert(editorEl() === null, "Escape left the editor open");
      // One step for the whole edit: the text, the size and the bold together.
      session.undo();
      await frames(1);
      const u = textOf(dev.layers()[0]);
      assert(u !== null && u.text === "Hi" && u.sizePx === 34 && u.bold === false, `one undo gave ${JSON.stringify(u)}`);
      assert(!session.history.canUndo, "the restyled edit took more than one undo step");
      return `size 34 → 61 and Bold while open (box ${h0} → ${l.media.height} px, corner fixed), typed after; one undo step — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });

  await test("image-text-save-rules", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const { addGeneratorLayer, validateImageProject, TEXT_MAX_CHARS } = await import("../image/layers");
      const crafted = {
        type: "text",
        text: "x".repeat(TEXT_MAX_CHARS + 7),
        fontFamily: "Comic Sans MS",
        fontId: "lib:",
        sizePx: 9000,
        color: "red",
        // Booleans stay booleans: the typed parse (not the text rules) would
        // refuse anything else before the check this block is about.
        bold: true,
        italic: false,
      } as unknown as TextGen;
      const p = addGeneratorLayer(createBlankImageProject("Autotest image text rules", W, H, "#ffffff"), crafted, 120, 40, "Text").project;
      const path = await ipc.tempProjectPath("Autotest image text rules");
      paths.push(path);
      // The save check refuses it, naming the layer, and writes nothing.
      let refused = "";
      try {
        await ipc.saveProject(path, p);
      } catch (e) {
        refused = describeError(e);
      }
      assert(/text layer 'Text'/.test(refused), `saving the crafted text ${refused ? `was refused with "${refused}"` : "was accepted"}`);
      assert(!(await ipc.pathExists(path)), "a refused save left a file behind");
      // What the editor's load makes of it saves: the two sides agree.
      const out = validateImageProject(p);
      const g = out.project.media[0]!.generator as TextGen;
      assert(out.shortenedTexts === 1 && g.text.length === TEXT_MAX_CHARS, `the load cut ${out.shortenedTexts ?? 0} texts to ${g.text.length}`);
      assert(g.sizePx === 2048 && g.fontFamily === "Segoe UI" && !("fontId" in g) && g.color === "#000000" && g.bold === true, `the load left ${JSON.stringify({ ...g, text: g.text.length })}`);
      await ipc.saveProject(path, out.project);
      assert(await ipc.pathExists(path), "the cleaned project was not written");
      return `crafted text refused ("${refused.slice(0, 80)}"); the loader's repair saves — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });
}
