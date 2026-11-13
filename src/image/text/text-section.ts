// The inspector's section for a text layer: Edit text (type on the canvas),
// the font (the shared picker), the size in image px, the colour, Bold and
// Italic. The text itself is typed in place on the stage, never in a field.
//
// While the layer is open for typing, every control restyles the OPEN text
// (`ctx.textEdit`): the change is part of that edit's one undo step, and the
// keyboard goes back into the text afterwards. Otherwise a control is its own
// step, measured with its font loaded and anchored at the box's top-left, as
// the open editor anchors it.
//
// Values refresh through the inspector's `watch`: the section is built once
// per layer, never per keystroke.

import { measureText, measureTextWhenReady, styleAvailability } from "../../editor/media/generators";
import { mountFontPicker } from "../../fonts";
import { hasStrongRtl } from "../../core/gen-text-runs";
import type { ImageEditorCtx, TextRangeStyle, TextStylePatch } from "../context";
import { findLayer, setTextGen, TEXT_SIZE_MAX, TEXT_SIZE_MIN } from "../layers";
import { applyTextStyle, uiTextSize, type TextGen } from "./text-style";

/** The title of a range control a right-to-left text disables. */
export const RTL_RANGE_TITLE = "Styling part of right-to-left text is not available yet";

export interface TextSectionHooks {
  /** Register a value refresher (runs now, then on every project change). */
  watch<T>(read: () => T, write: (v: T) => void): void;
  /** Runs when the section is replaced or the inspector is disposed. */
  onCleanup(fn: () => void): void;
  /** True once the inspector itself is gone (the editor closed): a style
   *  still waiting for its font then lands nothing. */
  closed?: () => boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el("div", "field insp-field");
  f.appendChild(el("label", undefined, label));
  f.appendChild(control);
  return f;
}

/** The newest style commit still waiting for its font, per section build. */
let commitSeq = 0;

export function buildTextSection(ctx: ImageEditorCtx, trackId: string, hooks: TextSectionHooks): HTMLElement {
  const { session } = ctx;
  let disposed = false;
  const cleanups: (() => void)[] = [];
  hooks.onCleanup(() => {
    disposed = true;
    for (const c of cleanups) c();
  });

  const genOf = (p: typeof session.project): TextGen | null => {
    const g = findLayer(p, trackId)?.media.generator;
    return g?.type === "text" ? g : null;
  };
  const genNow = (): TextGen | null => genOf(session.project);
  const openHere = () => {
    const h = ctx.textEdit?.get() ?? null;
    return h && h.trackId === trackId ? h : null;
  };
  /** The selected part's style while the open text has one, else null
   *  (the controls show the whole text). */
  const rangeStyle = (): TextRangeStyle | null => {
    const h = openHere();
    return h && h.range && h.styleOf ? h.styleOf() : null;
  };
  /** A part of a right-to-left text is selected: no range styling yet. */
  const rtlRange = (): boolean => {
    const h = openHere();
    const g = genNow();
    return !!h && !!h.range && !!g && hasStrongRtl(g.text);
  };

  let pendingSeq = 0;
  /** Restyle the layer: into the open text, or as a step of its own. */
  const style = (patch: TextStylePatch, refocus: boolean): void => {
    const h = openHere();
    if (h) {
      // A selected part of the open text takes the style alone; with
      // nothing selected the whole text does.
      if (h.range && h.applyRange) h.applyRange(patch);
      else h.restyle(patch);
      if (refocus) h.refocus();
      return;
    }
    const g = genNow();
    if (!g) return;
    const next = applyTextStyle(g, patch);
    if (next === g) return;
    const land = (b: { gen: TextGen; width: number; height: number }): void => {
      session.commit((p) => setTextGen(p, trackId, b.gen, b.width, b.height));
    };
    /** The font has arrived. The layer moved on meanwhile (typed in, or
     *  restyled elsewhere): the change goes onto what it holds NOW, never
     *  over it. */
    const landLate = (b: { gen: TextGen; width: number; height: number }): void => {
      const now = genOf(session.project);
      if (!now) return;
      if (now === g) {
        land(b);
        return;
      }
      const h = openHere();
      if (h) {
        h.restyle(patch);
        return;
      }
      const again = applyTextStyle(now, patch);
      if (again === now) return;
      const m = measureText(again);
      land({ gen: again, width: m.width, height: m.height });
    };
    const box = measureTextWhenReady(next);
    if (!(box instanceof Promise)) {
      pendingSeq = 0;
      land(box);
      return;
    }
    const seq = (pendingSeq = ++commitSeq);
    void box.then((b) => {
      // A newer change of this section went in meanwhile: it wins. A section
      // replaced (another layer selected) still lands what was picked.
      if (pendingSeq !== seq || hooks.closed?.() === true) return;
      pendingSeq = 0;
      landLate(b);
    });
  };

  const s = el("div", "insp-section imged-text-section");
  s.appendChild(el("div", "insp-section__title", "Text"));

  const editBtn = el("button", "btn btn--sm imged-text-edit-btn", "Edit text");
  editBtn.type = "button";
  editBtn.title = "Type in this text on the canvas";
  editBtn.addEventListener("click", () => {
    ctx.editText?.(trackId);
  });
  s.appendChild(editBtn);
  // A hidden layer is never typed into (nobody could see the text land).
  hooks.watch(
    () => findLayer(session.project, trackId)?.hidden === true,
    (hidden) => {
      editBtn.disabled = hidden;
      editBtn.title = hidden ? "Show this layer to type in it" : "Type in this text on the canvas";
    },
  );

  // Font: the shared picker.
  const fontHost = el("div");
  const picker = mountFontPicker(fontHost, {
    value: () => {
      const r = rangeStyle();
      if (r) return r.fontId === undefined ? { legacy: r.font } : { legacy: r.font, fontId: r.fontId };
      const g = genNow();
      if (!g) return { legacy: "Segoe UI" };
      return g.fontId === undefined ? { legacy: g.fontFamily } : { legacy: g.fontFamily, fontId: g.fontId };
    },
    onPick: (v) => style({ font: v }, true),
  });
  cleanups.push(() => picker.dispose());
  s.appendChild(field("Font", fontHost));

  const sizeInput = el("input", "input insp-num");
  sizeInput.type = "number";
  sizeInput.min = String(TEXT_SIZE_MIN);
  sizeInput.max = String(TEXT_SIZE_MAX);
  sizeInput.step = "1";
  sizeInput.setAttribute("aria-label", "Text size in pixels");
  const applySize = (refocus: boolean): void => {
    const g = genNow();
    if (!g) return;
    const raw = sizeInput.value.trim() === "" ? Number.NaN : Number(sizeInput.value);
    if (!Number.isFinite(raw)) {
      sizeInput.value = String(g.sizePx);
      return;
    }
    const v = uiTextSize(raw);
    sizeInput.value = String(v);
    style({ sizePx: v }, refocus);
  };
  sizeInput.addEventListener("change", () => applySize(false));
  sizeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applySize(true);
    }
  });

  const color = el("input", "gen-color");
  color.type = "color";
  color.setAttribute("aria-label", "Text color");
  color.addEventListener("change", () => style({ color: color.value }, true));

  const row = el("div", "insp-row");
  row.appendChild(field("Size (px)", sizeInput));
  row.appendChild(field("Color", color));
  s.appendChild(row);

  const boldSwitch = el("input", "switch");
  boldSwitch.type = "checkbox";
  boldSwitch.setAttribute("aria-label", "Bold");
  const italicSwitch = el("input", "switch");
  italicSwitch.type = "checkbox";
  italicSwitch.setAttribute("aria-label", "Italic");
  boldSwitch.addEventListener("change", () => style({ bold: boldSwitch.checked }, true));
  italicSwitch.addEventListener("change", () => style({ italic: italicSwitch.checked }, true));
  const toggles = el("div", "insp-row");
  toggles.appendChild(field("Bold", boldSwitch));
  toggles.appendChild(field("Italic", italicSwitch));
  s.appendChild(toggles);

  // Every refresher, also run when the open text's selected part changes
  // (that is not a project change).
  const refreshers: (() => void)[] = [];
  const watch = <T>(read: () => T, write: (v: T) => void): void => {
    hooks.watch(read, write);
    refreshers.push(() => write(read()));
  };

  watch(
    () => {
      const r = rangeStyle();
      if (r) return `${r.font}\u0000${r.fontId ?? ""}`;
      const g = genNow();
      return g ? `${g.fontFamily}\u0000${g.fontId ?? ""}` : "";
    },
    () => {
      if (!disposed) picker.refresh();
    },
  );
  watch(
    () => rangeStyle()?.size ?? genNow()?.sizePx ?? 0,
    (v) => {
      // Never fight the field the user is typing in.
      if (document.activeElement !== sizeInput) sizeInput.value = String(v);
    },
  );
  watch(
    () => rangeStyle()?.c ?? genNow()?.color ?? "#000000",
    (v) => {
      color.value = v;
    },
  );
  watch(
    () => {
      const r = rangeStyle();
      if (r) {
        const can = styleAvailability(r.font, r.fontId);
        return `${r.bold ? 1 : 0}${r.italic ? 1 : 0}${can.bold ? 1 : 0}${can.italic ? 1 : 0}${rtlRange() ? 1 : 0}`;
      }
      const g = genNow();
      if (!g) return "";
      const can = styleAvailability(g.fontFamily, g.fontId);
      return `${g.bold ? 1 : 0}${g.italic ? 1 : 0}${can.bold ? 1 : 0}${can.italic ? 1 : 0}`;
    },
    (k) => {
      if (k === "") return;
      boldSwitch.checked = k[0] === "1";
      italicSwitch.checked = k[1] === "1";
      boldSwitch.disabled = k[2] !== "1" || k[4] === "1";
      italicSwitch.disabled = k[3] !== "1" || k[4] === "1";
    },
  );
  // A selected part of a right-to-left text cannot be styled yet: its
  // controls say so instead of doing nothing.
  watch(rtlRange, (off) => {
    const why = off ? RTL_RANGE_TITLE : "";
    sizeInput.disabled = off;
    color.disabled = off;
    // The picker's own button: a disabled one opens no list.
    for (const c of Array.from(fontHost.children)) if (c.tagName === "BUTTON") (c as HTMLButtonElement).disabled = off;
    sizeInput.title = why;
    color.title = why;
    fontHost.title = why;
    boldSwitch.title = why;
    italicSwitch.title = why;
  });

  const te = ctx.textEdit;
  if (te) {
    cleanups.push(
      te.subscribe(() => {
        if (!disposed) for (const r of refreshers) r();
      }),
    );
  }

  return s;
}
