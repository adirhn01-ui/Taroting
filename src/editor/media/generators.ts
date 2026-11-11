// Generated media (text / solid) creation dialogs.
//
// A self-contained modal (same .modal-backdrop pattern as the export dialog:
// self-managed, Esc / backdrop close, first field focused) collects the
// parameters for a synthetic media item and, on confirm, registers it in the
// project bin via addGeneratedMedia — never on the timeline. The measureText
// helper (offscreen-canvas text metrics) is shared with the inspector's
// generated-media editor so both compute identical intrinsic sizes.
//
// TEXT IS NEVER RESIZED TO FIT. measureText gives the natural box, that box IS
// the media size, and both call sites commit it without inspecting it — no
// clamp, no shrink-to-fit, no refusal. A previous revision added all three and
// the owner ruled them out: long text is a user preference, and a box far
// bigger than the canvas is a legitimate thing to author — the export's
// placement() already scales oversized media DOWN to fit (fit = min(cw/fit_w,
// ch/fit_h)), so the whole text renders, small and complete, and the clip's own
// transform scale multiplies it from there. That is exactly how you start a
// title huge and animate it down into frame. Same ruling that removed contrast
// clamping from the theme system: do not reintroduce it.

import "./generators.css";
import { fontRequestOf, isFontId, missingFontNotice } from "../../core/font-id";
import { textLabel } from "../../core/media-name";
import { addGeneratedMedia } from "../../core/project";
import type { ProjectSession } from "../../core/session";
import {
  IMAGE_CANVAS_MAX_SIDE,
  type FontFamily,
  type FontId,
  type FontRequest,
  type Generator,
  type MediaRef,
} from "../../core/types";
// The font runtime. A static import on purpose: fontString / cssFont stay
// synchronous for the preview and playback call sites, which must not change.
// This module is reached only from lazy chunks (the editor and the image
// editor), never from the boot chunk, so neither is src/fonts.
import { ensureFonts, facesOf, fontFace, fontsReady, missingFonts, mountFontPicker } from "../../fonts";
import { trapTab } from "../../ui/focus";
import { toast } from "../../ui/toast";
import type { MediaManager } from "./media";

export interface GeneratorDialogCtx {
  session: ProjectSession;
  media: MediaManager;
}

/** The image editor's use of the same two dialogs: nothing goes into a bin —
 *  the confirmed element is handed to `onCreate`, which makes it a layer (one
 *  commit, owned by the caller). `defaultSize` pre-fills a solid's box (the
 *  image canvas). An image project's sizes are plain integers ≥ 1: its canvas
 *  is never even-rounded, so neither is a solid that is meant to cover it — a
 *  641×361 canvas gets a 641×361 solid, not a 642×362 one overhanging it. */
export type GeneratorCreate = {
  session: ProjectSession;
  onCreate(
    gen: Extract<Generator, { type: "solid" | "text" }>,
    w: number,
    h: number,
    label: string,
  ): void;
  defaultSize?: { w: number; h: number };
  /** Runs exactly once, last, on EVERY close path — Add, Cancel, Escape, the
   *  backdrop, X and the returned closer alike — so a caller that registered
   *  the dialog somewhere (the image shell's overlay set) can drop it on a
   *  Cancel too, not only on a create. */
  onClose?(): void;
};

/** A solid's side in an image project: an integer in [1, IMAGE_CANVAS_MAX_SIDE]. */
const imageDim = (v: number): number =>
  clamp(Math.round(Number.isFinite(v) ? v : 1), 1, IMAGE_CANVAS_MAX_SIDE);

/** The 6 fonts a text generator may use (all ship with Windows). */
export const TEXT_FONTS: FontFamily[] = [
  "Segoe UI",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Impact",
];

const MIN_SIZE = 8;
const MAX_SIZE = 512;
const MIN_DIM = 16;
/** Upper bound on either dimension of a SOLID element — the box there is a
 *  number the user types, so it gets the same 16..8192 clamp its siblings use
 *  (evenDim in the inspector's solid editor, setProjectCanvas in
 *  core/project.ts). The text path deliberately has no such bound: its box is
 *  measured, not typed. */
const MAX_DIM = 8192;
const LINE_HEIGHT = 1.25;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** Round UP to the next even integer, min 2. */
const evenUp = (v: number): number => Math.max(2, Math.ceil(v / 2) * 2);
/** Round to the nearest even integer, clamped to the canvas range. */
const evenDim = (v: number): number => clamp(Math.round(v / 2) * 2, MIN_DIM, MAX_DIM);

type TextGen = Extract<Generator, { type: "text" }>;

/** The font for a CANVAS context: "{italic} {bold} {px} {family}". `ctx.font`
 *  has no line height, so this one carries none — a DOM element wants
 *  `cssFont`. */
export function fontString(g: Extract<Generator, { type: "text" }>): string {
  return fontShorthand(g, "");
}

/**
 * The `font` shorthand a text generator is drawn with; `lineHeight` is "" or
 * "/1.25".
 *
 * Without a well-shaped `fontId` it is written from the generator's own
 * fields: the six legacy fonts get exactly the strings 0.9.3 wrote, with no
 * call into the font runtime and nothing allocated but the string (I1).
 *
 * With one, the runtime's `fontFace` answers: the font's alias first and the
 * legacy name, quoted, as the fallback, so DOM text shows the legacy font until
 * the face has loaded and then swaps it in by itself; the flags are the real
 * face's (a family without a bold face answers bold off: nothing is faked). A
 * font known missing on this PC answers the legacy name alone, which is then
 * the 0.9.3 string again.
 */
function fontShorthand(g: TextGen, lineHeight: string): string {
  let family: string = g.fontFamily;
  let bold = g.bold;
  let italic = g.italic;
  if (isFontId(g.fontId)) {
    const f = fontFace(g.fontFamily, g.fontId, bold, italic);
    bold = f.bold;
    italic = f.italic;
    if (!f.missing && f.family !== family) family = `${f.family}, "${family}"`;
  }
  return `${italic ? "italic" : "normal"} ${bold ? "bold" : "normal"} ${g.sizePx}px${lineHeight} ${family}`;
}

/** The runtime request for a text generator's font, or null for a legacy font
 *  (which needs none). */
const requestOf = (g: TextGen): FontRequest | null => fontRequestOf(g.fontFamily, g.fontId, g.bold, g.italic);

/** The distinct font requests of every text generator in `media` (bin items
 *  included: the bin previews them too). Empty for a project that only uses
 *  the six legacy fonts. */
export function textFontRequests(media: readonly Pick<MediaRef, "generator">[]): FontRequest[] {
  const out: FontRequest[] = [];
  const seen = new Set<string>();
  for (const m of media) {
    const g = m.generator;
    if (g?.type !== "text") continue;
    const req = requestOf(g);
    if (!req) continue;
    const key = `${req.bold ? 1 : 0}${req.italic ? 1 : 0}${req.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  return out;
}

/**
 * On a project open: load the fonts its text names (so the stage's DOM text
 * swaps them in), then say once which of them are not on this PC. A project
 * whose text uses only the six legacy fonts makes no font call at all (I1).
 * Never rejects. `disposed` stops the notice from landing on another screen.
 */
export async function prepareProjectFonts(
  media: readonly Pick<MediaRef, "generator">[],
  disposed: () => boolean,
): Promise<void> {
  const reqs = textFontRequests(media);
  if (reqs.length === 0) return;
  try {
    await ensureFonts(reqs);
    if (disposed()) return;
    const note = missingFontNotice(missingFonts(reqs));
    if (note) toast.notice(note);
  } catch {
    // The runtime never rejects by contract; a broken one must not break the open.
  }
}

/**
 * Which style switches a font can honour. The six keep the Impact rule exactly
 * (Impact: neither; the other five: both). Any other font follows its real
 * faces once they are known (`facesOf`), and leaves both on while they are not.
 */
export function styleAvailability(
  legacy: FontFamily,
  fontId: FontId | undefined,
): { bold: boolean; italic: boolean } {
  if (!isFontId(fontId)) {
    const impact = legacy === "Impact";
    return { bold: !impact, italic: !impact };
  }
  const faces = facesOf(fontId);
  if (!faces) return { bold: true, italic: true };
  return { bold: faces.some((f) => f.bold), italic: faces.some((f) => f.italic) };
}

/** `g` with any style switch its font cannot honour turned off (a font whose
 *  faces are not known yet keeps both). `g` itself when nothing changes, and
 *  always for the six. */
function honourFaces(g: TextGen): TextGen {
  if (!isFontId(g.fontId)) return g;
  const can = styleAvailability(g.fontFamily, g.fontId);
  const bold = g.bold && can.bold;
  const italic = g.italic && can.italic;
  return bold === g.bold && italic === g.italic ? g : { ...g, bold, italic };
}

/**
 * Measure a text generator with its font loaded, and hand back the generator
 * to store with that box. A legacy font, or one already ready, is measured at
 * once and comes back as the same object (no awaited barrier: I1); otherwise
 * the font is awaited first, because canvas silently measures a fallback font
 * and that wrong box would be saved into the project. Once the font's faces
 * are known, a Bold or Italic it has no face for is turned off before
 * measuring, so the stored switches match what is drawn.
 */
export function measureTextWhenReady(
  g: TextGen,
): { gen: TextGen; width: number; height: number } | Promise<{ gen: TextGen; width: number; height: number }> {
  const done = (): { gen: TextGen; width: number; height: number } => {
    const gen = honourFaces(g);
    return { gen, ...measureText(gen) };
  };
  const req = requestOf(g);
  if (!req) return { gen: g, ...measureText(g) };
  if (fontsReady([req])) return done();
  return ensureFonts([req]).then(done, done);
}

/** `g` with the picked font fields: `fontId` set, or removed (no key) for a
 *  legacy pick. Every other field and the key order are kept. */
export function withFont(
  g: Extract<Generator, { type: "text" }>,
  v: { legacy: FontFamily; fontId?: FontId },
): Extract<Generator, { type: "text" }> {
  const next = { ...g, fontFamily: v.legacy };
  if (v.fontId === undefined) delete next.fontId;
  else next.fontId = v.fontId;
  return next;
}

/**
 * The CSS `font` shorthand for a DOM element showing a text generator:
 * "{italic} {bold} {px}/1.25 {family}". The one font for every such element —
 * the dialog preview, the crop ghost, the stage layer — because the line height
 * has to travel INSIDE the shorthand: setting `font` resets line-height to
 * `normal`, so a lineHeight written before it is silently wiped, and Segoe UI's
 * `normal` (~1.33) then spaces lines wider than the 1.25 the media box and the
 * export's drawtext are measured at.
 */
export function cssFont(g: Extract<Generator, { type: "text" }>): string {
  return fontShorthand(g, `/${LINE_HEIGHT}`);
}

// One reused offscreen canvas context for text measurement.
let measureCtx: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  // `typeof document` rather than a bare reference: the fit logic below is
  // exercised from vitest, whose environment is "node" and has no DOM at all,
  // and the estimate in measureText is the documented answer to "no context".
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  measureCtx = c.getContext("2d");
  return measureCtx;
}

/** Intrinsic pixel box for a text generator: width = ceil(max line width),
 *  height = ceil(lines * sizePx * 1.25), each rounded UP to even, min 2×2.
 *  Falls back to a size-based estimate if no 2D context is available.
 *  Synchronous, and it assumes the font is ready: a caller measuring a
 *  non-legacy font awaits it first (measureTextWhenReady), since canvas
 *  measures a fallback font without a word. */
export function measureText(g: Extract<Generator, { type: "text" }>): { width: number; height: number } {
  const lines = g.text.split("\n");
  const c = ctx2d();
  let maxW = 0;
  if (c) {
    c.font = fontString(g);
    for (const line of lines) maxW = Math.max(maxW, c.measureText(line).width);
  } else {
    // headless fallback: rough monospace-ish estimate
    for (const line of lines) maxW = Math.max(maxW, line.length * g.sizePx * 0.6);
  }
  const width = evenUp(maxW);
  const height = evenUp(lines.length * g.sizePx * LINE_HEIGHT);
  return { width, height };
}

// The label rule lives with the other media names (core/media-name.ts), so the
// timeline and the inspector can name a text clip without importing this
// dialog module; re-exported for the callers that always found it here.
export { textLabel };

/* ------------------------------------------------------------------ */
/* Modal shell                                                         */
/* ------------------------------------------------------------------ */

interface Modal {
  backdrop: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close(): void;
  /** True once any close path has run. */
  isClosed(): boolean;
}

function openModal(title: string, onClose?: () => void): Modal {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal gen-modal" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal__header">
        <span>${title}</span>
        <button class="btn btn--ghost btn--sm" data-close title="Close">✕</button>
      </div>
      <div class="modal__body gen-body"></div>
      <div class="modal__footer gen-footer"></div>
    </div>`;
  document.body.appendChild(backdrop);

  const body = backdrop.querySelector<HTMLElement>(".gen-body")!;
  const footer = backdrop.querySelector<HTMLElement>(".gen-footer")!;

  const releaseTrap = trapTab(backdrop);
  // Idempotent: a create closes it, and the caller's teardown may call the
  // returned closer again afterwards — `onClose` must still fire only once.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    backdrop.remove();
    onClose?.();
  };
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKeydown, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("[data-close]")!.addEventListener("click", close);

  return { backdrop, body, footer, close, isClosed: () => closed };
}

/** A labelled field row. */
function fieldRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "field gen-field";
  const l = document.createElement("label");
  l.textContent = label;
  row.append(l, control);
  return row;
}

function makeButton(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

/** Open the creation dialog for a text or solid element; on confirm the media
 *  is added to the project bin (not the timeline) — or, for the image editor
 *  (`GeneratorCreate`), handed to its `onCreate`. Returns the dialog's closer
 *  (idempotent), so a screen that is torn down can close a dialog it opened. */
export function openGeneratorDialog(
  kind: "text" | "solid",
  ctx: GeneratorDialogCtx | GeneratorCreate,
): () => void {
  return kind === "text" ? openTextDialog(ctx) : openSolidDialog(ctx);
}

/* ---------------- TEXT ---------------- */

function openTextDialog(ctx: GeneratorDialogCtx | GeneratorCreate): () => void {
  // The picker's listeners go with the dialog, on every close path.
  let picker: { refresh(): void; dispose(): void } | null = null;
  const callerClose = "onCreate" in ctx ? ctx.onClose : undefined;
  const m = openModal("Add text", () => {
    picker?.dispose();
    picker = null;
    callerClose?.();
  });

  // Content
  const textarea = document.createElement("textarea");
  textarea.className = "input gen-textarea";
  textarea.rows = 3;
  textarea.value = "Title";

  // Font: the shared picker. `font` holds the fields a pick stores (a legacy
  // font has no fontId at all).
  let font: { legacy: FontFamily; fontId?: FontId } = { legacy: TEXT_FONTS[0]! };
  const fontHost = document.createElement("div");

  // Size
  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.className = "input gen-num";
  sizeInput.min = String(MIN_SIZE);
  sizeInput.max = String(MAX_SIZE);
  sizeInput.step = "1";
  sizeInput.value = "96";

  // Color
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "gen-color";
  colorInput.value = "#ffffff";

  // Bold / Italic switches
  const boldSwitch = document.createElement("input");
  boldSwitch.type = "checkbox";
  boldSwitch.className = "switch";
  const italicSwitch = document.createElement("input");
  italicSwitch.type = "checkbox";
  italicSwitch.className = "switch";

  // Live preview
  const preview = document.createElement("div");
  preview.className = "gen-preview";
  const previewText = document.createElement("div");
  previewText.className = "gen-preview__text";
  preview.appendChild(previewText);

  const currentGen = (): Extract<Generator, { type: "text" }> =>
    withFont(
      {
        type: "text",
        text: textarea.value,
        fontFamily: font.legacy,
        sizePx: clamp(Math.round(Number(sizeInput.value) || MIN_SIZE), MIN_SIZE, MAX_SIZE),
        color: colorInput.value,
        bold: boldSwitch.checked,
        italic: italicSwitch.checked,
      },
      font,
    );

  // The Impact rule, generalized: a switch for a face the font does not have
  // is off and disabled.
  const syncImpact = (): void => {
    const can = styleAvailability(font.legacy, font.fontId);
    if (!can.bold) boldSwitch.checked = false;
    if (!can.italic) italicSwitch.checked = false;
    boldSwitch.disabled = !can.bold;
    italicSwitch.disabled = !can.italic;
  };

  const renderPreview = (): void => {
    const g = currentGen();
    // Render at a bounded font size so the preview row stays readable.
    const shownPx = Math.min(g.sizePx, 48);
    previewText.style.font = cssFont({ ...g, sizePx: shownPx });
    previewText.style.color = g.color;
    previewText.style.whiteSpace = "pre";
    previewText.textContent = g.text || " ";
  };

  syncImpact();
  renderPreview();
  for (const ev of ["input", "change"]) {
    textarea.addEventListener(ev, renderPreview);
    sizeInput.addEventListener(ev, renderPreview);
    colorInput.addEventListener(ev, renderPreview);
    boldSwitch.addEventListener(ev, renderPreview);
    italicSwitch.addEventListener(ev, renderPreview);
  }
  picker = mountFontPicker(fontHost, {
    value: () => font,
    onPick: (v) => {
      font = v;
      syncImpact();
      renderPreview();
      // Start loading a non-legacy font now, so the preview swaps it in and
      // the switches learn its faces; nothing runs for the six.
      const req = fontRequestOf(v.legacy, v.fontId, boldSwitch.checked, italicSwitch.checked);
      if (!req) return;
      void ensureFonts([req]).then(
        () => {
          if (m.isClosed() || font !== v) return;
          syncImpact();
          renderPreview();
        },
        () => {},
      );
    },
  });

  const boldRow = fieldRow("Bold", boldSwitch);
  const italicRow = fieldRow("Italic", italicSwitch);
  const toggles = document.createElement("div");
  toggles.className = "gen-row";
  toggles.append(boldRow, italicRow);

  m.body.append(
    fieldRow("Text", textarea),
    fieldRow("Font", fontHost),
    (() => {
      const row = document.createElement("div");
      row.className = "gen-row";
      row.append(fieldRow("Size (px)", sizeInput), fieldRow("Color", colorInput));
      return row;
    })(),
    toggles,
    preview,
  );

  const cancel = makeButton("Cancel", "btn btn--ghost btn--sm");
  cancel.addEventListener("click", m.close);
  const confirm = makeButton("Add text", "btn btn--primary btn--sm");
  let submitted = false;
  confirm.addEventListener("click", () => {
    if (submitted) return;
    submitted = true;
    // Measured HERE and nowhere else in this dialog: a 137-line paste is ~1100
    // canvas measurements, which is a keystroke's worth of jank if the live
    // preview did it too — so the preview styles a div and only the confirm
    // measures. The result is committed as-is, whatever its size.
    // A non-legacy font that is not ready yet is awaited first (a box measured
    // with the fallback font would be saved); the six measure at once, as ever.
    const add = ({ gen, width, height }: { gen: TextGen; width: number; height: number }): void => {
      // Closed while the font was loading (Escape, X, a teardown): add nothing.
      if (m.isClosed()) return;
      if ("onCreate" in ctx) {
        ctx.onCreate(gen, width, height, textLabel(gen.text));
      } else {
        ctx.session.commit(
          (p) => addGeneratedMedia(p, gen, width, height, textLabel(gen.text)).project,
        );
        ctx.media.ensureAll(ctx.session.project);
      }
      toast.info(`Added text — ${width}×${height}`);
      m.close();
    };
    const box = measureTextWhenReady(currentGen());
    if (box instanceof Promise) {
      confirm.disabled = true;
      void box.then(add);
    } else {
      add(box);
    }
  });
  m.footer.append(cancel, confirm);

  setTimeout(() => {
    textarea.focus();
    textarea.select();
  }, 0);
  return m.close;
}

/* ---------------- SOLID ---------------- */

function openSolidDialog(ctx: GeneratorDialogCtx | GeneratorCreate): () => void {
  const m = openModal("Add solid", "onCreate" in ctx ? ctx.onClose : undefined);
  const p = ctx.session.project;
  // Image mode: integer sides ≥ 1 (never even-rounded, never 16..8192-clamped),
  // pre-filled with the caller's size. The video branch is unchanged.
  const image = "onCreate" in ctx;
  const initial = image && ctx.defaultSize
    ? ctx.defaultSize
    : { w: p.timeline.width, h: p.timeline.height };

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "gen-color";
  colorInput.value = "#000000";

  const swatchRow = document.createElement("div");
  swatchRow.className = "gen-swatches";
  const preset = (label: string, hex: string): void => {
    const b = makeButton(label, "btn btn--ghost btn--sm gen-swatch");
    const dot = document.createElement("span");
    dot.className = "gen-swatch__dot";
    dot.style.background = hex;
    b.prepend(dot);
    b.addEventListener("click", () => {
      colorInput.value = hex;
      renderPreview();
    });
    swatchRow.appendChild(b);
  };
  preset("Black", "#000000");
  preset("White", "#ffffff");

  const colorWrap = document.createElement("div");
  colorWrap.className = "gen-row gen-row--color";
  colorWrap.append(colorInput, swatchRow);

  const wInput = document.createElement("input");
  wInput.type = "number";
  wInput.className = "input gen-num";
  wInput.min = String(image ? 1 : MIN_DIM);
  wInput.max = String(image ? IMAGE_CANVAS_MAX_SIDE : MAX_DIM);
  wInput.step = image ? "1" : "2";
  wInput.value = String(initial.w);
  const hInput = document.createElement("input");
  hInput.type = "number";
  hInput.className = "input gen-num";
  hInput.min = String(image ? 1 : MIN_DIM);
  hInput.max = String(image ? IMAGE_CANVAS_MAX_SIDE : MAX_DIM);
  hInput.step = image ? "1" : "2";
  hInput.value = String(initial.h);

  const dimRow = document.createElement("div");
  dimRow.className = "gen-row";
  dimRow.append(fieldRow("Width", wInput), fieldRow("Height", hInput));

  const preview = document.createElement("div");
  preview.className = "gen-preview gen-preview--solid";
  const renderPreview = (): void => {
    preview.style.background = colorInput.value;
  };
  renderPreview();
  colorInput.addEventListener("input", renderPreview);

  m.body.append(fieldRow("Color", colorWrap), dimRow, preview);

  const cancel = makeButton("Cancel", "btn btn--ghost btn--sm");
  cancel.addEventListener("click", m.close);
  const confirm = makeButton("Add solid", "btn btn--primary btn--sm");
  let submitted = false;
  confirm.addEventListener("click", () => {
    if (submitted) return;
    submitted = true;
    const hex = colorInput.value;
    let w: number;
    let h: number;
    if ("onCreate" in ctx) {
      w = imageDim(Number(wInput.value) || 1);
      h = imageDim(Number(hInput.value) || 1);
      ctx.onCreate({ type: "solid", color: hex }, w, h, `Solid ${hex}`);
    } else {
      w = evenDim(Number(wInput.value) || MIN_DIM);
      h = evenDim(Number(hInput.value) || MIN_DIM);
      const g: Generator = { type: "solid", color: hex };
      ctx.session.commit((pr) => addGeneratedMedia(pr, g, w, h, `Solid ${hex}`).project);
      ctx.media.ensureAll(ctx.session.project);
    }
    toast.info(`Added solid — ${w}×${h}`);
    m.close();
  });
  m.footer.append(cancel, confirm);

  setTimeout(() => colorInput.focus(), 0);
  return m.close;
}
