// Inspector section for generated (solid / text) media. Edits the shared
// MediaRef.generator via updateMedia — so changes apply to EVERY clip that
// uses the element — and for text re-measures the intrinsic width/height with
// the same offscreen-canvas helper the creation dialog uses.

import { updateMedia } from "../../core/project";
import type { Clip, FontFamily, Generator, MediaRef } from "../../core/types";
import { TEXT_FONTS, measureText } from "../media/generators";
import type { InspectorCtx } from "./inspector";

const MIN_SIZE = 8;
const MAX_SIZE = 512;
const MIN_DIM = 16;
const MAX_DIM = 8192;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const evenDim = (v: number): number => clamp(Math.round(v / 2) * 2, MIN_DIM, MAX_DIM);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el("div", "field insp-field");
  f.appendChild(el("label", undefined, label));
  f.appendChild(control);
  return f;
}

/** Build the generated-media editor for the selected clip, or null when the
 *  media has no generator. Commits (history entry) + refreshes on every edit. */
export function buildGeneratedSection(
  ctx: InspectorCtx,
  target: { clip: Clip; media: MediaRef },
): HTMLElement | null {
  const gen = target.media.generator;
  if (!gen) return null;
  const mediaId = target.media.id;

  const s = el("div", "insp-section");
  s.appendChild(el("div", "insp-section__title", gen.type === "solid" ? "Solid" : "Text"));

  const commitMedia = (patch: Partial<MediaRef>): void => {
    ctx.session.commit((p) => updateMedia(p, mediaId, patch));
    ctx.refresh();
  };

  if (gen.type === "solid") {
    buildSolid(s, gen, target.media, commitMedia);
  } else {
    buildText(s, gen, commitMedia);
  }

  s.appendChild(
    el(
      "div",
      "insp-note",
      "Edits apply to every clip using this element.",
    ),
  );
  return s;
}

/* ---------------- SOLID ---------------- */

function buildSolid(
  s: HTMLElement,
  gen: Extract<Generator, { type: "solid" }>,
  media: MediaRef,
  commitMedia: (patch: Partial<MediaRef>) => void,
): void {
  const color = el("input", "gen-color");
  color.type = "color";
  color.value = gen.color;
  color.addEventListener("change", () => {
    commitMedia({ generator: { type: "solid", color: color.value } });
  });
  s.appendChild(field("Color", color));

  const wInput = el("input", "input insp-num");
  wInput.type = "number";
  wInput.min = String(MIN_DIM);
  wInput.max = String(MAX_DIM);
  wInput.step = "2";
  wInput.value = String(media.width ?? MIN_DIM);
  const hInput = el("input", "input insp-num");
  hInput.type = "number";
  hInput.min = String(MIN_DIM);
  hInput.max = String(MAX_DIM);
  hInput.step = "2";
  hInput.value = String(media.height ?? MIN_DIM);

  const applyDims = (): void => {
    const w = evenDim(Number(wInput.value) || MIN_DIM);
    const h = evenDim(Number(hInput.value) || MIN_DIM);
    wInput.value = String(w);
    hInput.value = String(h);
    commitMedia({ width: w, height: h });
  };
  wInput.addEventListener("change", applyDims);
  hInput.addEventListener("change", applyDims);

  const row = el("div", "insp-row");
  row.appendChild(field("Width", wInput));
  row.appendChild(field("Height", hInput));
  s.appendChild(row);
}

/* ---------------- TEXT ---------------- */

function buildText(
  s: HTMLElement,
  gen: Extract<Generator, { type: "text" }>,
  commitMedia: (patch: Partial<MediaRef>) => void,
): void {
  // Commit the given text generator + re-measured intrinsic box.
  const commitGen = (g: Extract<Generator, { type: "text" }>): void => {
    const { width, height } = measureText(g);
    commitMedia({ generator: g, width, height });
  };

  const textarea = el("textarea", "input gen-textarea");
  textarea.rows = 3;
  textarea.value = gen.text;

  const fontSel = el("select", "select select--sm");
  for (const f of TEXT_FONTS) {
    const o = el("option");
    o.value = f;
    o.textContent = f;
    if (f === gen.fontFamily) o.selected = true;
    fontSel.appendChild(o);
  }

  const sizeInput = el("input", "input insp-num");
  sizeInput.type = "number";
  sizeInput.min = String(MIN_SIZE);
  sizeInput.max = String(MAX_SIZE);
  sizeInput.step = "1";
  sizeInput.value = String(gen.sizePx);

  const color = el("input", "gen-color");
  color.type = "color";
  color.value = gen.color;

  const boldSwitch = el("input", "switch");
  boldSwitch.type = "checkbox";
  boldSwitch.checked = gen.bold;
  const italicSwitch = el("input", "switch");
  italicSwitch.type = "checkbox";
  italicSwitch.checked = gen.italic;

  const syncImpact = (): void => {
    const impact = fontSel.value === "Impact";
    if (impact) {
      boldSwitch.checked = false;
      italicSwitch.checked = false;
    }
    boldSwitch.disabled = impact;
    italicSwitch.disabled = impact;
  };
  syncImpact();

  const readGen = (): Extract<Generator, { type: "text" }> => ({
    type: "text",
    text: textarea.value,
    fontFamily: fontSel.value as FontFamily,
    sizePx: clamp(Math.round(Number(sizeInput.value) || MIN_SIZE), MIN_SIZE, MAX_SIZE),
    color: color.value,
    bold: boldSwitch.checked,
    italic: italicSwitch.checked,
  });

  const commit = (): void => commitGen(readGen());

  textarea.addEventListener("change", commit);
  sizeInput.addEventListener("change", commit);
  color.addEventListener("change", commit);
  boldSwitch.addEventListener("change", commit);
  italicSwitch.addEventListener("change", commit);
  fontSel.addEventListener("change", () => {
    syncImpact();
    commit();
  });

  s.appendChild(field("Text", textarea));
  s.appendChild(field("Font", fontSel));
  const row = el("div", "insp-row");
  row.appendChild(field("Size (px)", sizeInput));
  row.appendChild(field("Color", color));
  s.appendChild(row);
  const toggles = el("div", "insp-row");
  toggles.appendChild(field("Bold", boldSwitch));
  toggles.appendChild(field("Italic", italicSwitch));
  s.appendChild(toggles);
}
