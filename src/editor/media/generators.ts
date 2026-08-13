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
    submitted = true;
    const gen = currentGen();
    // Measured HERE and nowhere else in this dialog: a 137-line paste is ~1100
    // canvas measurements, which is a keystroke's worth of jank if the live
    // preview did it too — so the preview styles a div and only the confirm
    // measures. The result is committed as-is, whatever its size.
    const { width, height } = measureText(gen);
    ctx.session.commit(
      (p) => addGeneratedMedia(p, gen, width, height, textLabel(gen.text)).project,
    );
    ctx.media.ensureAll(ctx.session.project);
    toast.info(`Added text — ${width}×${height}`);
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
