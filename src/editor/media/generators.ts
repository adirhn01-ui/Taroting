// Generated media (text / solid) creation dialogs.
//
// A self-contained modal (same .modal-backdrop pattern as the export dialog:
// self-managed, Esc / backdrop close, first field focused) collects the
// parameters for a synthetic media item and, on confirm, registers it in the
// project bin via addGeneratedMedia — never on the timeline. The measureText
// helper (offscreen-canvas text metrics) is shared with the inspector's
// generated-media editor so both compute identical intrinsic sizes, and so is
// fitText, which keeps those sizes inside the range the export can synthesize.

import "./generators.css";
import { addGeneratedMedia } from "../../core/project";
import type { ProjectSession } from "../../core/session";
import type { FontFamily, Generator } from "../../core/types";
import { trapTab } from "../../ui/focus";
import { toast } from "../../ui/toast";
import type { MediaManager } from "./media";

export interface GeneratorDialogCtx {
  session: ProjectSession;
  media: MediaManager;
}

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
/** Upper bound on either dimension of a generated element. Shared with the
 *  solid dialog (evenDim), the inspector's solid editor and the project canvas
 *  (setProjectCanvas in core/project.ts) — exported so the text path's tests
 *  pin the same number rather than a copy of it. */
export const MAX_DIM = 8192;
const LINE_HEIGHT = 1.25;
/** Re-measurements fitText may spend before it gives up. The first estimate is
 *  exact for a linear font, so this is only slack for glyph hinting. */
const FIT_STEPS = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** Round UP to the next even integer, min 2. */
const evenUp = (v: number): number => Math.max(2, Math.ceil(v / 2) * 2);
/** Round to the nearest even integer, clamped to the canvas range. */
const evenDim = (v: number): number => clamp(Math.round(v / 2) * 2, MIN_DIM, MAX_DIM);

/** The CSS `font` shorthand the preview / stage use: "{italic} {bold} {px} {family}". */
export function fontString(g: Extract<Generator, { type: "text" }>): string {
  const style = g.italic ? "italic" : "normal";
  const weight = g.bold ? "bold" : "normal";
  return `${style} ${weight} ${g.sizePx}px ${g.fontFamily}`;
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
 *  Falls back to a size-based estimate if no 2D context is available. */
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

/* ------------------------------------------------------------------ */
/* Fitting text into a box the export can synthesize                   */
/* ------------------------------------------------------------------ */
//
// A text element's media box IS its measured box, and both renderers depend on
// that equality. The preview puts the glyphs in a `media.width × media.height`
// div (`.stage-layer__gen`, `overflow: hidden`), where block flow starts them at
// the TOP; the export synthesizes a `w×h` frame and hands drawtext
// `boxw=w:boxh=h:text_align=L+M`, where `M` CENTRES them. Those two agree only
// while the box equals the natural text extent — the moment the box is smaller,
// the preview shows the first lines and the export shows the middle ones.
//
// So the 16..8192 clamp its solid siblings apply (evenDim, and setProjectCanvas
// in core/project.ts) cannot simply be pointed at the measured box: clamping
// alone trades an export that aborts for one that quietly renders different
// lines than the preview, which is the same bug wearing a different face. Both
// ends of the clamp break the equality, which is also why nothing here applies
// MIN_DIM — evenUp already only ever rounds UP, so the box is never smaller
// than its text.
//
// What CAN move without breaking the equality is the font size: the preview
// (`styleGen` in playback/scheduler.ts) and the export (`drawtext fontsize=`)
// both read it from the same generator. Oversized text therefore shrinks to
// fit, the way "shrink text on overflow" does elsewhere — every character
// survives, nothing is cropped, and the box still equals the text. When even
// MIN_SIZE overflows there is no honest box left, and the edit is refused
// rather than committed as a silent crop.

/** The largest integer font size at or below `sizePx` whose text box fits
 *  MAX_DIM on both axes, given `natural` measured AT `sizePx`. Both axes are
 *  linear in the size — advance widths scale with the em, and the height is
 *  literally lines × sizePx × LINE_HEIGHT — so one multiply lands on it or just
 *  under. `fits` is false when the size that would be needed is below MIN_SIZE,
 *  i.e. no allowed size fits. Pure: no canvas, no DOM. */
export function fitTextSize(
  natural: { width: number; height: number },
  sizePx: number,
): { sizePx: number; fits: boolean } {
  const longest = Math.max(natural.width, natural.height, 1);
  if (longest <= MAX_DIM) return { sizePx, fits: true };
  // floor, never round: undershooting the limit costs a pixel, overshooting it
  // is the bug.
  const next = Math.floor(sizePx * (MAX_DIM / longest));
  return { sizePx: Math.max(MIN_SIZE, next), fits: next >= MIN_SIZE };
}

export interface TextFit {
  /** The generator to store: the input, with `sizePx` lowered iff it had to be.
   *  Never commit the caller's original generator next to these dims. */
  gen: Extract<Generator, { type: "text" }>;
  /** A true `measureText(gen)`, ≤ MAX_DIM on both axes unless `tooLarge`. */
  width: number;
  height: number;
  /** The authored size, when it was lowered to fit; null when it fit as-is. */
  shrunkFrom: number | null;
  /** No allowed font size fits. NOTHING here may be committed; `width`/`height`
   *  are the box at MIN_SIZE — the smallest this text can be — so the caller
   *  can say by how much it misses. */
  tooLarge: boolean;
}

/** Measure a text generator and, while its box exceeds MAX_DIM, lower the font
 *  size until it does not. The returned dims are always a true measurement of
 *  the returned generator — that identity is what keeps the preview and the
 *  export describing the same frame. */
export function fitText(g: Extract<Generator, { type: "text" }>): TextFit {
  let gen = g;
  let box = measureText(gen);
  for (let step = 0; step <= FIT_STEPS; step++) {
    if (box.width <= MAX_DIM && box.height <= MAX_DIM) {
      return {
        gen,
        ...box,
        shrunkFrom: gen.sizePx === g.sizePx ? null : g.sizePx,
        tooLarge: false,
      };
    }
    const fit = fitTextSize(box, gen.sizePx);
    if (!fit.fits) break;
    gen = { ...gen, sizePx: fit.sizePx };
    box = measureText(gen);
  }
  // Either no allowed size fits, or the estimate failed to converge within
  // FIT_STEPS. MIN_SIZE is the last thing worth trying; if even that overflows,
  // there is no box that holds this text and the caller must refuse.
  const min = { ...gen, sizePx: MIN_SIZE };
  const minBox = measureText(min);
  const fits = minBox.width <= MAX_DIM && minBox.height <= MAX_DIM;
  return {
    gen: min,
    ...minBox,
    shrunkFrom: fits && min.sizePx !== g.sizePx ? g.sizePx : null,
    tooLarge: !fits,
  };
}

/** The clause both call sites append when a text element's size was lowered. */
export function textShrunkNote(fit: TextFit): string {
  return `size reduced ${fit.shrunkFrom} → ${fit.gen.sizePx} px so all of it fits`;
}

/** The refusal, shown identically wherever the user hits it. */
export function showTextTooLarge(fit: TextFit): void {
  toast.error("That text is too large to draw — shorten it or break the long line up.", {
    op: "Text",
    title: "Text too large",
    detail:
      `A text element can be at most ${MAX_DIM}×${MAX_DIM} px — the same limit ` +
      `a solid element and the project canvas have.\n\n` +
      `Even at the smallest font size (${MIN_SIZE} px) this text measures ` +
      `${fit.width}×${fit.height} px, so it could only be drawn by cutting ` +
      `part of it off. Nothing was changed.\n\n` +
      `Shorten the text, or split the long line into several shorter ones — ` +
      `a single very long line is the usual cause.`,
  });
}

/** First ~24 chars of the text, single line, ellipsised — used as the bin label. */
export function textLabel(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  const short = single.length > 24 ? single.slice(0, 24) + "…" : single;
  return `Text — ${short || "Title"}`;
}

/* ------------------------------------------------------------------ */
/* Modal shell                                                         */
/* ------------------------------------------------------------------ */

interface Modal {
  backdrop: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close(): void;
}

function openModal(title: string): Modal {
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
  const close = (): void => {
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    backdrop.remove();
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

  return { backdrop, body, footer, close };
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
 *  is added to the project bin (not the timeline). */
export function openGeneratorDialog(kind: "text" | "solid", ctx: GeneratorDialogCtx): void {
  if (kind === "text") openTextDialog(ctx);
  else openSolidDialog(ctx);
}

/* ---------------- TEXT ---------------- */

function openTextDialog(ctx: GeneratorDialogCtx): void {
  const m = openModal("Add text");

  // Content
  const textarea = document.createElement("textarea");
  textarea.className = "input gen-textarea";
  textarea.rows = 3;
  textarea.value = "Title";

  // Font family
  const fontSel = document.createElement("select");
  fontSel.className = "select select--sm";
  for (const f of TEXT_FONTS) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    fontSel.appendChild(o);
  }

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

  const currentGen = (): Extract<Generator, { type: "text" }> => ({
    type: "text",
    text: textarea.value,
    fontFamily: fontSel.value as FontFamily,
    sizePx: clamp(Math.round(Number(sizeInput.value) || MIN_SIZE), MIN_SIZE, MAX_SIZE),
    color: colorInput.value,
    bold: boldSwitch.checked,
    italic: italicSwitch.checked,
  });

  const syncImpact = (): void => {
    const impact = fontSel.value === "Impact";
    if (impact) {
      boldSwitch.checked = false;
      italicSwitch.checked = false;
    }
    boldSwitch.disabled = impact;
    italicSwitch.disabled = impact;
  };

  const renderPreview = (): void => {
    const g = currentGen();
    // Render at a bounded font size so the preview row stays readable.
    const shownPx = Math.min(g.sizePx, 48);
    previewText.style.font = fontString({ ...g, sizePx: shownPx });
    previewText.style.color = g.color;
    previewText.style.whiteSpace = "pre";
    previewText.style.lineHeight = String(LINE_HEIGHT);
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
  fontSel.addEventListener("change", () => {
    syncImpact();
    renderPreview();
  });

  const boldRow = fieldRow("Bold", boldSwitch);
  const italicRow = fieldRow("Italic", italicSwitch);
  const toggles = document.createElement("div");
  toggles.className = "gen-row";
  toggles.append(boldRow, italicRow);

  m.body.append(
    fieldRow("Text", textarea),
    fieldRow("Font", fontSel),
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
    const fit = fitText(currentGen());
    if (fit.tooLarge) {
      // Nothing is added and the dialog stays open with the text intact, so the
      // fix is one edit away rather than a re-type.
      showTextTooLarge(fit);
      return;
    }
    submitted = true;
    const { gen, width, height } = fit;
    ctx.session.commit(
      (p) => addGeneratedMedia(p, gen, width, height, textLabel(gen.text)).project,
    );
    ctx.media.ensureAll(ctx.session.project);
    toast.info(
      fit.shrunkFrom === null
        ? `Added text — ${width}×${height}`
        : `Added text — ${width}×${height} · ${textShrunkNote(fit)}`,
    );
    m.close();
  });
  m.footer.append(cancel, confirm);

  setTimeout(() => {
    textarea.focus();
    textarea.select();
  }, 0);
}

/* ---------------- SOLID ---------------- */

function openSolidDialog(ctx: GeneratorDialogCtx): void {
  const m = openModal("Add solid");
  const p = ctx.session.project;

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
  wInput.min = String(MIN_DIM);
  wInput.max = String(MAX_DIM);
  wInput.step = "2";
  wInput.value = String(p.timeline.width);
  const hInput = document.createElement("input");
  hInput.type = "number";
  hInput.className = "input gen-num";
  hInput.min = String(MIN_DIM);
  hInput.max = String(MAX_DIM);
  hInput.step = "2";
  hInput.value = String(p.timeline.height);

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
    const w = evenDim(Number(wInput.value) || MIN_DIM);
    const h = evenDim(Number(hInput.value) || MIN_DIM);
    const g: Generator = { type: "solid", color: hex };
    ctx.session.commit((pr) => addGeneratedMedia(pr, g, w, h, `Solid ${hex}`).project);
    ctx.media.ensureAll(ctx.session.project);
    toast.info(`Added solid — ${w}×${h}`);
    m.close();
  });
  m.footer.append(cancel, confirm);

  setTimeout(() => colorInput.focus(), 0);
}
