// Inspector section for generated (solid / text) media. Edits the shared
// MediaRef.generator via updateMedia — so changes apply to EVERY clip that
// uses the element — and for text re-measures the intrinsic width/height with
// the same offscreen-canvas helper the creation dialog uses, so both call sites
// compute identical boxes. That measurement is committed as-is: text is never
// clamped, shrunk to fit or refused for being large (see the note at the top of
// ../media/generators.ts).

import { updateMedia } from "../../core/project";
import type { Clip, FontFamily, FontId, Generator, MediaRef } from "../../core/types";
import { mountFontPicker } from "../../fonts";
import { measureTextWhenReady, styleAvailability, withFont } from "../media/generators";
import type { InspectorCtx } from "./inspector";

/** The newest font-awaiting commit per media id: an older one that finishes
 *  its font load later must not overwrite a newer edit. Module-level because a
 *  commit rebuilds the section, so the newer edit usually comes from another
 *  build of it. An entry lives only while its font loads (at most the
 *  runtime's load bound). */
const pendingCommit = new Map<string, number>();
let commitSeq = 0;

const MIN_SIZE = 8;
const MAX_SIZE = 512;
const MIN_DIM = 16;
const MAX_DIM = 8192;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const evenDim = (v: number): number => clamp(Math.round(v / 2) * 2, MIN_DIM, MAX_DIM);

/** A number field's value, or `fallback` when it holds none. An emptied field
 *  (or one left at "-") reads "", and Number("") is 0 — which used to commit
 *  the minimum size, an 8 px text or a 16 px solid, for a field the user had
 *  only cleared on the way to typing a new number. */
function numberOr(input: HTMLInputElement, fallback: number): number {
  if (input.value === "") return fallback;
  const v = Number(input.value);
  return Number.isFinite(v) ? v : fallback;
}

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
 *  media has no generator (or is a drawing, which has nothing to edit here).
 *  Commits (history entry) + refreshes on every edit.
 *
 *  Only `session` and `refresh` are read, so that is all the ctx asks for: the
 *  image editor's inspector passes its own. `sharedNote: false` drops the
 *  "every clip using this element" note, which is untrue where every layer
 *  owns its media 1:1. */
export function buildGeneratedSection(
  ctx: Pick<InspectorCtx, "session" | "refresh">,
  target: { clip: Clip; media: MediaRef },
  opts: {
    sharedNote?: boolean;
    /** Registers a function the inspector runs when it replaces this section
     *  or is disposed: it disposes the font picker. */
    onCleanup: (fn: () => void) => void;
    /** True once the editor itself has closed (the inspector's dispose). A
     *  commit still waiting for its font is then dropped; on a rebuild or a
     *  section replacement it still lands, since it names its media id and
     *  the session outlives the section. */
    closed: () => boolean;
  },
): HTMLElement | null {
  const gen = target.media.generator;
  if (!gen || gen.type === "drawing") return null;
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
    opts.onCleanup(buildText(s, gen, mediaId, commitMedia, opts.closed));
  }

  if (opts.sharedNote !== false) {
    s.appendChild(
      el(
        "div",
        "insp-note",
        "Edits apply to every clip using this element.",
      ),
    );
  }
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
    const w = evenDim(numberOr(wInput, media.width ?? MIN_DIM));
    const h = evenDim(numberOr(hInput, media.height ?? MIN_DIM));
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
  mediaKey: string,
  commitMedia: (patch: Partial<MediaRef>) => void,
  closed: () => boolean,
): () => void {
  // Commit the generator the user asked for, alongside its natural box. The
  // dims are always a true measurement of the generator stored beside them —
  // that identity is what keeps the preview and the export describing the same
  // frame — and no size is too big to commit.
  //
  // A non-legacy font that is not ready yet is loaded BEFORE measuring: canvas
  // would silently measure the fallback font and that wrong box would be
  // saved. The six (and a ready font) commit at once, as they always have.
  const commitGen = (g: Extract<Generator, { type: "text" }>): void => {
    const box = measureTextWhenReady(g);
    if (!(box instanceof Promise)) {
      // Anything still awaiting a font for this element is older: drop it.
      pendingCommit.delete(mediaKey);
      commitMedia({ generator: box.gen, width: box.width, height: box.height });
      return;
    }
    const seq = ++commitSeq;
    pendingCommit.set(mediaKey, seq);
    void box.then((b) => {
      // A newer edit of the same element went in meanwhile: it wins.
      if (pendingCommit.get(mediaKey) !== seq) return;
      pendingCommit.delete(mediaKey);
      // The editor closed meanwhile: its session may be gone, so the commit
      // lands nowhere. (A mere rebuild or replacement lets it land: what was
      // typed or picked while the font loaded is not thrown away.)
      if (closed()) return;
      commitMedia({ generator: b.gen, width: b.width, height: b.height });
    });
  };

  const textarea = el("textarea", "input gen-textarea");
  textarea.rows = 3;
  textarea.value = gen.text;

  // Font: the shared picker, holding the fields a pick stores (a legacy font
  // has no fontId at all).
  let font: { legacy: FontFamily; fontId?: FontId } =
    gen.fontId === undefined ? { legacy: gen.fontFamily } : { legacy: gen.fontFamily, fontId: gen.fontId };
  const fontHost = el("div");

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

  // The Impact rule, generalized: a switch for a face the font does not have
  // is off and disabled (the six keep exactly the old rule).
  const syncImpact = (): void => {
    const can = styleAvailability(font.legacy, font.fontId);
    if (!can.bold) boldSwitch.checked = false;
    if (!can.italic) italicSwitch.checked = false;
    boldSwitch.disabled = !can.bold;
    italicSwitch.disabled = !can.italic;
  };
  syncImpact();

  const readGen = (): Extract<Generator, { type: "text" }> =>
    withFont(
      {
        type: "text",
        text: textarea.value,
        fontFamily: font.legacy,
        sizePx: clamp(Math.round(numberOr(sizeInput, gen.sizePx)), MIN_SIZE, MAX_SIZE),
        color: color.value,
        bold: boldSwitch.checked,
        italic: italicSwitch.checked,
      },
      font,
    );

  const commit = (): void => commitGen(readGen());

  textarea.addEventListener("change", commit);
  sizeInput.addEventListener("change", commit);
  color.addEventListener("change", commit);
  boldSwitch.addEventListener("change", commit);
  italicSwitch.addEventListener("change", commit);
  const picker = mountFontPicker(fontHost, {
    value: () => font,
    onPick: (v) => {
      font = v;
      syncImpact();
      commit();
    },
  });

  s.appendChild(field("Text", textarea));
  s.appendChild(field("Font", fontHost));
  const row = el("div", "insp-row");
  row.appendChild(field("Size (px)", sizeInput));
  row.appendChild(field("Color", color));
  s.appendChild(row);
  const toggles = el("div", "insp-row");
  toggles.appendChild(field("Bold", boldSwitch));
  toggles.appendChild(field("Italic", italicSwitch));
  s.appendChild(toggles);

  // An open list held blockShortcuts: dispose releases it. A commit still
  // waiting for its font is NOT dropped here (see commitGen's `closed`).
  return picker.dispose;
}
