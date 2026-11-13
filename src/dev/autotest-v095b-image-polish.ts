// 0.9.5 E2E blocks: three details of styled text in an image project — the
// crop ghost of a text with styled parts, the tool row's font on a selected
// part, and the selected part kept visible while a styling control has the
// keyboard. DEV-only: imported lazily by autotest.ts, never part of a release
// bundle.
//
// NOTHING under src/image, src/editor or src/ui/rich-text is imported
// statically here: each block reaches the module it drives with
// `await import(...)` (type-only imports are erased), so loading this file
// loads no lazy chunk.
//
// What a block asserts is what is ON SCREEN: the stage's pixels at zoom 1,
// the crop ghost canvas's own pixels, the element hit at a point, client
// rectangles, the CSS highlight registry. Selections go through the
// document's own selection, so the editor hears the same selectionchange a
// mouse makes; focus moves through focus(), so the editor hears the same
// focusout a press makes (each move checks the event really arrived, since a
// page without window focus moves the keyboard silently).
//
// Every block works on its own temporary project and ends on Home with every
// file it wrote deleted. Waits poll at 20 ms with their own short deadline.

import { ipc } from "../core/ipc";
import { createBlankImageProject } from "../core/image-project";
import { navigate } from "../core/nav";
import { currentSession, type ProjectSession } from "../core/session";
import type { Store } from "../core/store";
import type { Generator } from "../core/types";
import type { ImageEditorCtx, ViewController } from "../image/context";
import type { Layer } from "../image/layers";
import type { ToolState } from "../image/tool-state";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type ImagePolishCtx = Wave1Ctx;

type TextGen = Extract<Generator, { type: "text" }>;

/** What the image editor publishes on window while mounted (image-editor.ts, DEV). */
interface ImageDev {
  session: ProjectSession;
  tools: Store<ToolState>;
  view: ViewController;
  selection: Store<string | null>;
  canvas: HTMLCanvasElement;
  ctx: ImageEditorCtx;
  text: { edit(trackId: string): boolean };
  renderNow(): void;
  layers(): readonly Layer[];
}

/** The registry and the constructor of the CSS Custom Highlight API. */
interface HighlightApi {
  reg: { has(n: string): boolean; get(n: string): Iterable<AbstractRange> | undefined };
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
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
const f1 = (n: number): string => n.toFixed(1);

/** JSON with every object's keys sorted (a generator read from disk keeps
 *  the file's key order). */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
}

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}

/**
 * The `::highlight(name)` rule in the loaded stylesheets (nested rules
 * included) and the alpha its background-color resolves to on this page:
 * the value is applied to a probe element (so custom properties resolve)
 * and the computed colour is painted on a 1x1 canvas and read back.
 */
function highlightPaint(name: string): { rule: string | null; resolved: string; alpha: number } {
  const want = `::highlight(${name})`;
  let found: string | null = null;
  const walk = (rules: CSSRuleList): void => {
    for (const r of Array.from(rules)) {
      if (found !== null) return;
      if (r instanceof CSSStyleRule && r.selectorText.replace(/\s+/g, "") === want && r.style.backgroundColor) {
        found = r.style.backgroundColor;
        return;
      }
      const nested = (r as Partial<CSSGroupingRule>).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      /* a sheet whose rules cannot be read */
    }
    if (found !== null) break;
  }
  if (found === null) return { rule: null, resolved: "", alpha: 0 };
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-99px;top:-99px;width:1px;height:1px";
  probe.style.backgroundColor = found;
  document.body.appendChild(probe);
  let resolved = "";
  try {
    resolved = getComputedStyle(probe).backgroundColor;
  } finally {
    probe.remove();
  }
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return { rule: found, resolved, alpha: 0 };
  g.fillStyle = resolved || "transparent";
  g.fillRect(0, 0, 1, 1);
  return { rule: found, resolved, alpha: g.getImageData(0, 0, 1, 1).data[3] ?? 0 };
}

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

const imageDev = (): ImageDev | undefined => (window as unknown as { __tarotingImageDev?: ImageDev }).__tarotingImageDev;
const textOf = (l: Layer | undefined): TextGen | null => (l && l.media.generator?.type === "text" ? (l.media.generator as TextGen) : null);
const editorEl = (): HTMLElement | null => $(".imged-textedit");

/** A key as the keyboard sends it: at the focused element (or <body>), up to window. */
function key(k: string, code: string, target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

/** The pointer half of a left press on `el` at its centre, as a mouse sends it. */
function pointerPress(el: Element): void {
  const r = el.getBoundingClientRect();
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new MouseEvent("mousedown", init));
}

/** The element painted at the centre of `el`'s first client rectangle. */
function hitAtCentre(el: Element): Element | null {
  const r = el.getClientRects()[0];
  if (!r) return null;
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
}

/** Select [s, e) of the open text through the document's selection (a caret
 *  when s === e). */
function selectInEditor(s: number, e: number): void {
  const el = editorEl();
  if (!el) throw new Error("no text is open for typing");
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  let a: { n: Node; o: number } | null = null;
  let b: { n: Node; o: number } | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n as Text).data.length;
    if (!a && s <= at + len) a = { n, o: s - at };
    if (!b && e <= at + len) b = { n, o: e - at };
    at += len;
  }
  if (!a || !b) throw new Error(`[${s}, ${e}) is not inside the open text ("${el.textContent}")`);
  document.getSelection()!.setBaseAndExtent(a.n, a.o, b.n, b.o);
}

/** The CSS Custom Highlight API, or a message naming what is missing. */
function highlightApi(): HighlightApi | string {
  const g = globalThis as unknown as { CSS?: { highlights?: HighlightApi["reg"] }; Highlight?: unknown };
  if (typeof g.Highlight !== "function") return "this WebView has no Highlight constructor (CSS Custom Highlight API)";
  if (!g.CSS || !g.CSS.highlights) return "this WebView has no CSS.highlights registry";
  return { reg: g.CSS.highlights };
}

interface Luma { w: number; h: number; y: Uint8ClampedArray }

/** Dark pixels (luma < 128) per column of [x0,x1)×[y0,y1). */
function columnInk(l: Luma, x0: number, x1: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  for (let x = Math.max(0, x0); x < Math.min(l.w, x1); x++) {
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(l.h, y1); y++) if (l.y[y * l.w + x]! < 128) n++;
    out.push(n);
  }
  return out;
}
const sum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const profileDiff = (a: readonly number[], b: readonly number[]): number => {
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d;
};

/** Ink bounding box and count of one colour class. */
interface Ink { n: number; x0: number; y0: number; x1: number; y1: number }
const noInk = (): Ink => ({ n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
function addInk(b: Ink, x: number, y: number): void {
  b.n++;
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}
const inkH = (b: Ink): number => (b.n > 0 ? b.y1 - b.y0 + 1 : 0);
const boxStr = (b: Ink): string => (b.n > 0 ? `${b.n} px in (${f1(b.x0)}, ${f1(b.y0)})-(${f1(b.x1)}, ${f1(b.y1)})` : "none");
/** Saturated red / near-black, read off opaque-enough pixels. */
const isRed = (r: number, g: number, b: number): boolean => r >= 150 && g <= 90 && b <= 90;
const isDark = (r: number, g: number, b: number): boolean => r <= 90 && g <= 90 && b <= 90;

export async function runImageTextPolishBlocks(ctx: ImagePolishCtx): Promise<void> {
  const { test, assert } = ctx;

  /** Close dialogs, discard a temp session, park on Home, delete `paths`.
   *  Never throws. */
  const backHome = async (paths: readonly string[] = []): Promise<void> => {
    try {
      closeMenu();
      for (const p of $$(".fontpk__pop")) p.remove();
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
      console.error("image text polish autotest: cleanup did not finish", e);
    }
    for (const p of paths) if (p) await ipc.deleteProject(p).catch(() => {});
  };

  /** A white W×H image project with one text layer (its box measured for
   *  real), saved to a temporary path and opened at 100% on whole device
   *  pixels. */
  const openWithText = async (name: string, W: number, H: number, g: TextGen, paths: string[]): Promise<{ dev: ImageDev; trackId: string }> => {
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
    // At 100%, and the canvas moved by the half device pixel centring can
    // leave, through the user's own pan, so stage pixels are canvas pixels.
    dev.view.actual();
    const v = dev.view.store.get();
    const dx = Math.round(v.panX) - v.panX;
    const dy = Math.round(v.panY) - v.panY;
    if (dx !== 0 || dy !== 0) dev.view.panBy(dx / v.dpr, dy / v.dpr);
    const p = dev.view.store.get();
    if (!Number.isInteger(p.panX) || !Number.isInteger(p.panY)) dev.view.store.set({ ...p, panX: Math.round(p.panX), panY: Math.round(p.panY) });
    await frames(2);
    const trackId = dev.layers().find((l) => l.kind === "text")!.trackId;
    return { dev, trackId };
  };

  /** The stage's RGBA of the W×H canvas rectangle (zoom 1, whole pixels). */
  const stageRgba = (dev: ImageDev, W: number, H: number): Uint8ClampedArray => {
    dev.renderNow();
    const v = dev.view.store.get();
    assert(v.zoom === 1, `the stage is at zoom ${v.zoom}, not 1`);
    assert(Number.isInteger(v.panX) && Number.isInteger(v.panY), `the canvas sits at (${v.panX}, ${v.panY}) on the stage, not on whole device pixels`);
    assert(
      v.panX >= 0 && v.panY >= 0 && v.panX + W <= dev.canvas.width && v.panY + H <= dev.canvas.height,
      `the ${W}x${H} canvas at zoom 1 (${v.panX}, ${v.panY}) does not fit the ${dev.canvas.width}x${dev.canvas.height} stage`,
    );
    return dev.canvas.getContext("2d")!.getImageData(v.panX, v.panY, W, H).data;
  };
  const lumaOf = (d: Uint8ClampedArray, w: number, h: number): Luma => {
    const y = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) y[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
    return { w, h, y };
  };

  /** A layer's box in canvas px. */
  const boxOf = async (l: Layer, W: number, H: number): Promise<{ x: number; y: number; w: number; h: number }> => {
    const { layerToCanvas } = await import("../image/geom");
    const m = layerToCanvas(l.transform, l.media.width!, l.media.height!, W, H);
    return { x: m[4], y: m[5], w: l.media.width!, h: l.media.height! };
  };

  /* ------------------------------------------------------------------ */

  await test("image-crop-ghost-styled", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const W = 520;
      const H = 300;
      // "CD" twice the size and red; "AB" stays the base: black, 60 px.
      const styled: TextGen = { type: "text", text: "AB CD", fontFamily: "Arial", sizePx: 60, color: "#000000", bold: false, italic: false, runs: [{ s: 3, e: 5, c: "#ff0000", size: 120 }] };
      const plain: TextGen = { type: "text", text: "AB CD", fontFamily: "Arial", sizePx: 60, color: "#000000", bold: false, italic: false };
      const { dev, trackId } = await openWithText("Autotest crop ghost styled", W, H, styled, paths);
      const { session } = dev;

      /** Red and dark ink on the stage (canvas px), the layer alone on white. */
      const stageInk = (): { red: Ink; dark: Ink } => {
        const d = stageRgba(dev, W, H);
        const red = noInk();
        const dark = noInk();
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (isRed(d[i]!, d[i + 1]!, d[i + 2]!)) addInk(red, x + 0.5, y + 0.5);
            else if (isDark(d[i]!, d[i + 1]!, d[i + 2]!)) addInk(dark, x + 0.5, y + 0.5);
          }
        }
        return { red, dark };
      };

      /** Enter the layer's crop through the inspector's Crop button and read
       *  the ghost canvas: red and dark ink, boxes in canvas px, heights in
       *  canvas px. */
      const cropAndReadGhost = async (): Promise<{ red: Ink; dark: Ink; redH: number; darkH: number }> => {
        dev.selection.set(trackId);
        const btn = await until(() => $<HTMLButtonElement>('button[aria-label="Crop layer"]'), 2_000, () => "the inspector's Crop button");
        btn.click();
        await until(() => dev.ctx.mode.get() === "crop-layer", 1_000, () => `crop mode (mode ${String(dev.ctx.mode.get())})`);
        const ghost = await until(
          () => {
            const c = $<HTMLCanvasElement>("canvas.imged-select__ghost");
            return c && c.width > 0 && c.height > 0 && c.getClientRects().length > 0 ? c : null;
          },
          1_000,
          () => {
            const c = $<HTMLCanvasElement>("canvas.imged-select__ghost");
            return `a painted, shown crop ghost (${c ? `${c.width}x${c.height}, ${c.getClientRects().length} rects` : "no ghost canvas"})`;
          },
        );
        await frames(2);
        const gw = ghost.width;
        const gh = ghost.height;
        const rect = ghost.getBoundingClientRect();
        const d = ghost.getContext("2d")!.getImageData(0, 0, gw, gh).data;
        const red = noInk();
        const dark = noInk();
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            const i = (y * gw + x) * 4;
            if (d[i + 3]! < 160) continue;
            if (isRed(d[i]!, d[i + 1]!, d[i + 2]!)) addInk(red, x, y);
            else if (isDark(d[i]!, d[i + 1]!, d[i + 2]!)) addInk(dark, x, y);
          }
        }
        // ghost px → canvas px, through the view (pixel centres)
        const toCanvas = (gx: number, gy: number): { x: number; y: number } =>
          dev.view.clientToCanvas(rect.left + ((gx + 0.5) * rect.width) / gw, rect.top + ((gy + 0.5) * rect.height) / gh);
        const k = ((dev.view.canvasToClient(1, 0).x - dev.view.canvasToClient(0, 0).x) * gw) / rect.width;
        const mapped = (b: Ink): Ink => {
          if (b.n === 0) return b;
          const a = toCanvas(b.x0, b.y0);
          const z = toCanvas(b.x1, b.y1);
          return { n: b.n, x0: a.x, y0: a.y, x1: z.x, y1: z.y };
        };
        return { red: mapped(red), dark: mapped(dark), redH: inkH(red) / k, darkH: inkH(dark) / k };
      };

      const cancelCrop = async (): Promise<void> => {
        const cancel = $$<HTMLButtonElement>(".imged-select__cropbar button").find((b) => b.textContent === "Cancel");
        assert(cancel !== undefined, "the crop bar has no Cancel button");
        cancel!.click();
        await until(() => dev.ctx.mode.get() === "idle" && !$(".imged-select.is-cropping"), 1_000, () => `the crop to close (mode ${String(dev.ctx.mode.get())})`);
      };

      const near = (a: Ink, b: Ink, tol: number): boolean =>
        Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.y1 - b.y1) <= tol;

      // The styled text: the compositor's own picture first (nothing selected,
      // no chrome), then the ghost.
      const st = stageInk();
      assert(st.red.n > 300 && st.dark.n > 150, `the stage shows the styled text as ${st.red.n} red and ${st.dark.n} dark pixels`);
      const gs = await cropAndReadGhost();
      assert(gs.red.n > 300, `the crop ghost of the styled text has ${gs.red.n} red pixels (the stage ${st.red.n}): the styled part is not painted in its colour`);
      assert(gs.dark.n > 150, `the crop ghost of the styled text has ${gs.dark.n} dark pixels`);
      assert(gs.redH >= 1.6 * gs.darkH, `in the ghost the styled part is ${f1(gs.redH)} px high, the base part ${f1(gs.darkH)} px: the 120 px part is not drawn larger than the 60 px one`);
      assert(gs.red.x0 > gs.dark.x1, `in the ghost red starts at x ${f1(gs.red.x0)} and dark reaches x ${f1(gs.dark.x1)}: the colour is not on "CD" alone`);
      assert(near(gs.red, st.red, 2), `the ghost's red ink ${boxStr(gs.red)} is not where the stage draws it: ${boxStr(st.red)}`);
      assert(near(gs.dark, st.dark, 2), `the ghost's dark ink ${boxStr(gs.dark)} is not where the stage draws it: ${boxStr(st.dark)}`);
      await cancelCrop();

      // The control: the same layer without styled parts.
      const { setTextGen } = await import("../image/layers");
      const { measureText } = await import("../editor/media/generators");
      const pb = measureText(plain);
      session.commit((p) => setTextGen(p, trackId, plain, pb.width, pb.height));
      dev.selection.set(null);
      await frames(2);
      const g1 = textOf(dev.layers().find((l) => l.trackId === trackId));
      assert(g1 !== null && !g1.runs, `the control layer still has runs: ${JSON.stringify(g1?.runs)}`);
      const sp = stageInk();
      assert(sp.red.n === 0 && sp.dark.n > 300, `the stage shows the plain text as ${sp.red.n} red and ${sp.dark.n} dark pixels`);
      const gp = await cropAndReadGhost();
      assert(gp.red.n === 0, `the crop ghost of the plain text has ${gp.red.n} red pixels`);
      assert(gp.dark.n > 300, `the crop ghost of the plain text has ${gp.dark.n} dark pixels`);
      // Arial's capitals at 60 px are ~43 px high; anything near 120 px is a
      // styled size leaking in.
      assert(gp.darkH <= 0.85 * 60, `the plain text's ghost ink is ${f1(gp.darkH)} px high for a 60 px text`);
      assert(near(gp.dark, sp.dark, 2), `the ghost's ink ${boxStr(gp.dark)} is not where the stage draws it: ${boxStr(sp.dark)}`);
      await cancelCrop();
      return `styled ghost: ${gs.red.n} red px ${f1(gs.redH)} px high vs ${gs.dark.n} dark ${f1(gs.darkH)} px high, boxes on the stage's within 2 px; plain ghost: 0 red, ${f1(gp.darkH)} px high — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });

  /* ------------------------------------------------------------------ */

  await test("image-toolbar-font-range", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      const W = 560;
      const H = 240;
      const SIZE = 48;
      const g: TextGen = { type: "text", text: "Hello world", fontFamily: "Georgia", sizePx: SIZE, color: "#101820", bold: false, italic: false };
      const { dev, trackId } = await openWithText("Autotest toolbar font range", W, H, g, paths);
      const { session } = dev;

      // The widths the fonts give "world" and "Hello" (canvas measure).
      const oc = new OffscreenCanvas(8, 8).getContext("2d")!;
      const widthIn = (family: string, s: string): number => {
        oc.font = `${SIZE}px "${family}"`;
        return oc.measureText(s).width;
      };
      const worldArial = widthIn("Arial", "world");
      const worldGeorgia = widthIn("Georgia", "world");
      assert(Math.abs(worldArial - worldGeorgia) > 4, `"world" measures ${f1(worldArial)} px in Arial and ${f1(worldGeorgia)} px in Georgia: the fixture cannot tell them apart`);
      const helloW = widthIn("Georgia", "Hello");
      const helloSpaceW = widthIn("Georgia", "Hello ");

      // The Text tool in hand: the tool row shows its font picker.
      dev.tools.update((s) => ({ ...s, tool: "text" }));
      await frames(1);
      assert(dev.text.edit(trackId), "the text did not open for typing");
      const ed = await until(editorEl, 2_000, () => "the open text");
      const te = dev.ctx.textEdit!;
      await until(() => te.get()?.trackId === trackId, 2_000, () => "the open text's handle");

      const l0 = dev.layers().find((l) => l.trackId === trackId)!;
      const box0 = await boxOf(l0, W, H);
      const rows = [Math.floor(box0.y) - 2, Math.ceil(box0.y + box0.h) + 2] as const;
      const helloCols = [Math.floor(box0.x), Math.floor(box0.x + helloW)] as const;
      const worldCols = [Math.ceil(box0.x + helloSpaceW), Math.ceil(box0.x + Math.max(box0.w, helloSpaceW + worldGeorgia)) + 2] as const;
      const profiles = (): { hello: number[]; world: number[] } => {
        const l = lumaOf(stageRgba(dev, W, H), W, H);
        return { hello: columnInk(l, helloCols[0], helloCols[1], rows[0], rows[1]), world: columnInk(l, worldCols[0], worldCols[1], rows[0], rows[1]) };
      };
      const before = profiles();
      assert(sum(before.hello) > 150 && sum(before.world) > 150, `the stage shows ${sum(before.hello)} dark px of "Hello" and ${sum(before.world)} of "world"`);

      /** Pick `family` in the TOOL ROW's font picker, as a mouse does. */
      const pickInToolbar = async (family: string): Promise<void> => {
        const ctl = await until(
          () => $<HTMLButtonElement>(".imged-toolbar .imged-fontpick .fontpk__ctl"),
          1_000,
          () => "the tool row's font picker",
        );
        assert(ctl.getClientRects().length > 0, "the tool row's font picker is not shown with the Text tool in hand");
        const hit = hitAtCentre(ctl);
        assert(hit !== null && ctl.contains(hit), `the tool row's font picker is covered by ${describeEl(hit)}`);
        pointerPress(ctl);
        ctl.focus();
        assert(editorEl() === ed && ed.isConnected, "moving the keyboard to the tool row's font closed the text");
        ctl.click();
        // Type the name in the list's search field (the list keeps the
        // keyboard there), so the row is among the first shown.
        const search = await until(() => $<HTMLInputElement>(".fontpk__pop .fontpk__search"), 2_000, () => "the font list's search field");
        assert(document.activeElement === search, `the open font list left the keyboard on ${describeEl(document.activeElement)}`);
        search.value = family;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        const name = await until(
          () => $$<HTMLElement>(".fontpk__pop .fontpk__row:not([hidden]) .fontpk__name").find((n) => n.textContent === family) ?? null,
          3_000,
          () => `"${family}" in the font list (${$(".fontpk__pop") ? `${$$(".fontpk__pop .fontpk__row").length} rows` : "no list open"})`,
        );
        const rowHit = hitAtCentre(name);
        assert(rowHit !== null && name.closest(".fontpk__row")!.contains(rowHit), `the "${family}" row is covered by ${describeEl(rowHit)}`);
        pointerPress(name);
        name.click();
        await until(() => !$(".fontpk__pop"), 1_000, () => "the font list to close after the pick");
        // The pick hands the keyboard back to the text after the current task.
        await until(() => document.activeElement === ed, 1_000, () => `the keyboard back in the text (it is on ${describeEl(document.activeElement)})`);
        await frames(1);
      };

      // A part selected: only that part takes the font.
      selectInEditor(6, 11);
      await until(
        () => {
          const h = te.get();
          return h && h.range && h.range.s === 6 && h.range.e === 11 ? h : null;
        },
        2_000,
        () => `the selected part [6, 11) on the handle (it says ${JSON.stringify(te.get()?.range ?? null)})`,
      );
      await pickInToolbar("Arial");
      assert(editorEl() === ed && ed.isConnected, "picking a font closed the text");
      const gA = textOf(dev.layers().find((l) => l.trackId === trackId))!;
      assert(gA.fontFamily === "Georgia", `the whole text's font became ${gA.fontFamily}: the pick did not stay on the selected part`);
      assert(canon(gA.runs) === canon([{ s: 6, e: 11, font: "Arial" }]), `the layer's runs are ${JSON.stringify(gA.runs)}`);

      // On screen: the typed spans, and the stage.
      const spans = $$<HTMLSpanElement>("span", ed).filter((s) => (s.textContent ?? "") !== "");
      assert(spans.length === 2 && spans[0]!.textContent === "Hello " && spans[1]!.textContent === "world", `the open text shows ${spans.length} parts: ${spans.map((s) => JSON.stringify(s.textContent)).join(", ")}`);
      const ffA0 = getComputedStyle(spans[0]!).fontFamily;
      const ffA1 = getComputedStyle(spans[1]!).fontFamily;
      assert(/Georgia/i.test(ffA0) && /Arial/i.test(ffA1), `the parts are in ${ffA0} and ${ffA1}`);
      const sx = dev.view.canvasToClient(1, 0).x - dev.view.canvasToClient(0, 0).x;
      const worldShown = spans[1]!.getBoundingClientRect().width / sx;
      assert(
        Math.abs(worldShown - worldArial) <= Math.max(1.5, worldArial * 0.02),
        `"world" is ${f1(worldShown)} canvas px wide in the open text; Arial gives ${f1(worldArial)}, Georgia ${f1(worldGeorgia)}`,
      );
      const afterA = profiles();
      const helloMoved = profileDiff(before.hello, afterA.hello);
      const worldMoved = profileDiff(before.world, afterA.world);
      assert(helloMoved <= Math.max(8, sum(before.hello) * 0.06), `"Hello" changed on the stage: ${helloMoved} of ${sum(before.hello)} dark px moved between columns`);
      assert(worldMoved >= Math.max(40, sum(before.world) * 0.2), `"world" did not change on the stage: only ${worldMoved} of ${sum(before.world)} dark px moved between columns`);

      // A caret only: the whole text takes the font, and the parts' own font
      // goes.
      selectInEditor(3, 3);
      await until(() => {
        const h = te.get();
        return h && h.trackId === trackId && !h.range ? h : null;
      }, 2_000, () => `the caret (no part) on the handle (it says ${JSON.stringify(te.get()?.range ?? null)})`);
      await pickInToolbar("Courier New");
      const gC = textOf(dev.layers().find((l) => l.trackId === trackId))!;
      assert(gC.fontFamily === "Courier New", `with a caret only the whole text's font is ${gC.fontFamily}`);
      assert(!gC.runs || gC.runs.length === 0, `with a caret only the parts kept their own style: ${JSON.stringify(gC.runs)}`);
      const fams = ($$<HTMLSpanElement>("span", ed).length > 0 ? $$<HTMLSpanElement>("span", ed) : [ed]).map((s) => getComputedStyle(s).fontFamily);
      assert(fams.every((f) => /Courier New/i.test(f)), `the open text is shown in ${fams.join(" | ")}`);
      const afterC = profiles();
      const helloMovedC = profileDiff(afterA.hello, afterC.hello);
      assert(helloMovedC >= Math.max(40, sum(afterA.hello) * 0.2), `"Hello" did not change on the stage with the whole text's font: ${helloMovedC} of ${sum(afterA.hello)} dark px moved`);

      // Escape lands one step; one undo gives the opening text back.
      const esc = key("Escape", "Escape", ed);
      assert(esc.defaultPrevented, "the open text did not take its Escape");
      await until(() => !editorEl(), 1_000, () => "the text to close on Escape");
      session.undo();
      await frames(1);
      const back = textOf(dev.layers().find((l) => l.trackId === trackId));
      assert(canon(back) === canon(g), `one undo gave ${JSON.stringify(back)}`);
      return `range pick: runs ${JSON.stringify(gA.runs)}, "world" ${f1(worldShown)} px (Arial ${f1(worldArial)}, Georgia ${f1(worldGeorgia)}), stage "Hello" Δ${helloMoved} / "world" Δ${worldMoved}; caret pick: whole text Courier New, "Hello" Δ${helloMovedC}; one undo — ${ms(t0)}`;
    } finally {
      await backHome(paths);
    }
  });

  /* ------------------------------------------------------------------ */

  await test("image-text-kept-selection", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    try {
      // The app targets WebView2, which has the API: without it the kept
      // selection is never painted, and that is a failure here.
      const api = highlightApi();
      assert(typeof api !== "string", String(api));
      const reg = (api as HighlightApi).reg;
      const { KEPT_HIGHLIGHT } = await import("../image/text/text-edit");
      const { offsetOf } = await import("../ui/rich-text/dom");
      assert(KEPT_HIGHLIGHT === "imged-text-kept", `the kept highlight is named ${KEPT_HIGHLIGHT}`);
      assert(!reg.has(KEPT_HIGHLIGHT), "a kept highlight is registered before any text is open");

      const W = 333;
      const H = 177;
      const g: TextGen = { type: "text", text: "Hello world", fontFamily: "Georgia", sizePx: 36, color: "#2a1a0a", bold: false, italic: false };
      const { dev, trackId } = await openWithText("Autotest text kept selection", W, H, g, paths);
      const te = dev.ctx.textEdit!;

      const open = async (): Promise<HTMLElement> => {
        assert(dev.text.edit(trackId), "the text did not open for typing");
        const ed = await until(editorEl, 2_000, () => "the open text");
        await until(() => te.get()?.trackId === trackId, 2_000, () => "the open text's handle");
        return ed;
      };
      const selectPart = async (s: number, e: number): Promise<void> => {
        selectInEditor(s, e);
        await until(
          () => {
            const h = te.get();
            return h && h.range && h.range.s === s && h.range.e === e ? h : null;
          },
          2_000,
          () => `the selected part [${s}, ${e}) on the handle (it says ${JSON.stringify(te.get()?.range ?? null)})`,
        );
      };
      const boldSwitch = async (): Promise<HTMLInputElement> =>
        until(() => {
          const b = $$<HTMLInputElement>(".imged-text-section input.switch")[0];
          return b && !b.disabled ? b : null;
        }, 1_000, () => "the text section's Bold switch, enabled");
      /** Move the keyboard to the Bold switch (a styling surface). */
      const away = async (ed: HTMLElement): Promise<HTMLInputElement> => {
        const bold = await boldSwitch();
        // The editor hears the move through focusout. A window whose page is
        // not focused moves activeElement without sending focus events: tell
        // that apart from the editor not answering the event.
        let heard: Element | null | undefined;
        const spy = (e: FocusEvent): void => {
          heard = e.relatedTarget as Element | null;
        };
        ed.addEventListener("focusout", spy, { once: true });
        try {
          bold.focus();
        } finally {
          ed.removeEventListener("focusout", spy);
        }
        assert(document.activeElement === bold, `focusing Bold left the keyboard on ${describeEl(document.activeElement)}`);
        // The test window cannot take the keyboard, and whether its page
        // counts as focused is settled at start-up: when it does not, send
        // the event the page would have sent for this same move.
        if (heard === undefined) {
          ed.addEventListener("focusout", spy, { once: true });
          ed.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: bold }));
          ed.removeEventListener("focusout", spy);
        }
        assert(heard === bold, `the open text's focusout named ${describeEl(heard ?? null)} as the next focus, not the Bold switch`);
        assert(editorEl() === ed && ed.isConnected, "moving the keyboard to Bold closed the text");
        return bold;
      };
      /** Move the keyboard back into the open text, checking the page sends the focus event. */
      const back = (ed: HTMLElement): void => {
        let heard = false;
        const spy = (): void => {
          heard = true;
        };
        ed.addEventListener("focus", spy, { once: true });
        try {
          ed.focus();
        } finally {
          ed.removeEventListener("focus", spy);
        }
        assert(document.activeElement === ed, `focusing the text left the keyboard on ${describeEl(document.activeElement)}`);
        // As in away(): an unfocused page moves activeElement silently.
        if (!heard) {
          ed.addEventListener("focus", spy, { once: true });
          ed.dispatchEvent(new FocusEvent("focus"));
          ed.removeEventListener("focus", spy);
        }
        assert(heard, "the open text heard no focus event, real or sent");
      };

      // 1. A part selected, then the keyboard to the inspector: the part is
      // kept as a highlight over exactly those characters.
      const ed = await open();
      await selectPart(2, 7);
      await away(ed);
      assert(reg.has(KEPT_HIGHLIGHT), `no "${KEPT_HIGHLIGHT}" highlight while the Bold switch has the keyboard`);
      const ranges = [...(reg.get(KEPT_HIGHLIGHT) ?? [])] as Range[];
      assert(ranges.length === 1, `the kept highlight holds ${ranges.length} ranges`);
      const r = ranges[0]!;
      assert(ed.contains(r.startContainer) && ed.contains(r.endContainer), `the kept highlight lies in ${describeEl(r.startContainer.parentElement)} … ${describeEl(r.endContainer.parentElement)}, not in the open text`);
      const so = offsetOf(ed, r.startContainer, r.startOffset);
      const eo = offsetOf(ed, r.endContainer, r.endOffset);
      assert(so === 2 && eo === 7, `the kept highlight covers [${so}, ${eo}), not the selected [2, 7)`);
      assert(r.toString() === "llo w", `the kept highlight covers ${JSON.stringify(r.toString())}`);
      const rects = Array.from(r.getClientRects()).filter((q) => q.width > 0 && q.height > 0);
      const er = ed.getBoundingClientRect();
      assert(rects.length > 0, "the kept highlight's range has no client rectangle: nothing to paint");
      assert(
        rects.every((q) => q.left >= er.left - 2 && q.right <= er.right + 2 && q.top >= er.top - 2 && q.bottom <= er.bottom + 2),
        `the kept highlight's rectangles ${rects.map((q) => `(${f1(q.left)}, ${f1(q.top)}, ${f1(q.width)}x${f1(q.height)})`).join(" ")} leave the open text (${f1(er.left)}, ${f1(er.top)}, ${f1(er.width)}x${f1(er.height)})`,
      );

      // A registered name paints nothing without a ::highlight() rule: find
      // the rule (top level or nested in @layer / @media) and resolve its
      // background against the page, which must not be transparent.
      const paint = highlightPaint(KEPT_HIGHLIGHT);
      assert(paint.rule !== null, `no "::highlight(${KEPT_HIGHLIGHT})" rule in any loaded stylesheet: the kept selection is registered but never painted`);
      assert(paint.alpha > 0, `the "::highlight(${KEPT_HIGHLIGHT})" rule's background ${JSON.stringify(paint.rule)} resolves to ${paint.resolved}: nothing is painted`);

      // 2. The keyboard back in the text: the native selection takes over.
      back(ed);
      assert(!reg.has(KEPT_HIGHLIGHT), "the kept highlight stayed after the keyboard came back to the text");
      await frames(1);

      // 3. Away again, then another tool taken up by its key from there: the
      // text closes and leaves no highlight behind.
      await selectPart(2, 7);
      const bold = await away(ed);
      assert(reg.has(KEPT_HIGHLIGHT), "no kept highlight on the second move to Bold");
      assert(dev.tools.get().tool === "select", `the tool is ${dev.tools.get().tool} before the chord`);
      key("t", "KeyT", bold);
      await until(() => !editorEl(), 1_000, () => `the text to close when the tool changed (tool ${dev.tools.get().tool})`);
      assert(dev.tools.get().tool === "text", `T left the tool at ${dev.tools.get().tool}`);
      assert(!reg.has(KEPT_HIGHLIGHT), "the kept highlight stayed after a tool change closed the text");
      assert(te.get() === null, "a handle is still published after the tool change closed the text");

      // 4. Open again, away, then Escape from the inspector: the same.
      const ed2 = await open();
      await selectPart(6, 11);
      const bold2 = await away(ed2);
      assert(reg.has(KEPT_HIGHLIGHT), "no kept highlight on the third move to Bold");
      key("Escape", "Escape", bold2);
      await until(() => !editorEl(), 1_000, () => `the text to close on Escape from the inspector (tool ${dev.tools.get().tool})`);
      assert(!reg.has(KEPT_HIGHLIGHT), "the kept highlight stayed after Escape closed the text");
      assert(te.get() === null, "a handle is still published after Escape closed the text");
      // Nothing was typed or styled: no step landed.
      assert(!dev.session.history.canUndo, "opening and leaving the text left an undo step");
      return `kept highlight [${so}, ${eo}) "${r.toString()}" in ${rects.length} rect(s) inside the text; cleared on focus back, on a tool change and on Escape — ${ms(t0)}`;
    } finally {
      // A failed assertion above must not leave a highlight for later blocks.
      try {
        const api = highlightApi();
        if (typeof api !== "string") (api.reg as unknown as { delete(n: string): void }).delete("imged-text-kept");
      } catch {
        /* nothing registered */
      }
      await backHome(paths);
    }
  });
}
