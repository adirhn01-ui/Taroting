// The text box's in-place editor: an editable div in a foreignObject on the
// page itself (inside the page's turned group, so it sits, turns and zooms
// exactly like the finished text), styled like the final text. Escape, a
// click away, or focus leaving commits; empty text deletes the box (or adds
// nothing). One history step per edit.

import type { PdfAnnot, PdfTextStyle } from "../../../core/types";
import { normalizeHexColor } from "../../../core/session";
import { addAnnot, newId, pageAnnots, removeAnnots, updateAnnot } from "../../model";
import type { Env } from "./env";
import { clampFont, textHeight } from "./geom";
import { SVG_NS, n2, styleTextBox, textLines } from "./render";

type TextAnnot = Extract<PdfAnnot, { t: "text" }>;

/** A new box: 200 pt wide, one line tall (24 pt at the default 12 pt). */
export const TEXT_BOX_W = 200;
export const TEXT_BOX_H = 24;
/** The loader's cap on a text box's characters (PDF_TEXT_MAX_CHARS). */
const TEXT_MAX = 20_000;

export interface TextEditor {
  readonly key: string;
  /** the mark being edited, or null for a new box */
  readonly id: string | null;
  contains(target: EventTarget | null): boolean;
  /** land the edit (idempotent) */
  commit(): void;
}

/** The text a contenteditable holds, without the trailing newline Chromium
 *  keeps after a last empty line. */
function readText(el: HTMLElement): string {
  const raw = typeof el.innerText === "string" ? el.innerText : (el.textContent ?? "");
  return raw.replace(/\r\n?/g, "\n").replace(/\n$/, "").slice(0, TEXT_MAX);
}

/** The finished mark for an edit, or null when the box ends up empty. Pure:
 *  the box grows to show every line, never shrinks. */
export function finishedText(base: TextAnnot, text: string): TextAnnot | null {
  if (text.trim() === "") return null;
  const lines = textLines({ ...base, text }).length;
  const h = Math.max(base.h, textHeight(lines, base.size));
  return { ...base, text, h };
}

/** Open the editor on page `key`: on an existing text mark (`id`) or as a new
 *  box at `at`. `onClose` runs once, after the commit. */
export function openTextEditor(
  env: Env,
  key: string,
  target: { id: string } | { at: { x: number; y: number } },
  onClose: () => void,
): TextEditor | null {
  const { ctx } = env;
  const frame = env.layer.frame(key);
  if (!frame) return null;
  const session = ctx.session;
  let base: TextAnnot;
  let existing: TextAnnot | null = null;
  if ("id" in target) {
    const a = pageAnnots(session.project, key).find((x) => x.id === target.id);
    if (!a || a.t !== "text") return null;
    existing = a;
    base = a;
  } else {
    const s = ctx.tools.get();
    const style: PdfTextStyle = {
      font: s.font,
      size: clampFont(s.sizes.text),
      c: normalizeHexColor(s.colors.text, "#000000"),
      bold: false,
      italic: false,
      align: "left",
    };
    const info = frame.info;
    const w = Math.min(TEXT_BOX_W, info.w);
    const h = Math.max(TEXT_BOX_H, textHeight(1, style.size));
    const x = Math.max(0, Math.min(target.at.x, info.w - w));
    const y = Math.max(0, Math.min(target.at.y - h / 2, info.h - h));
    base = { id: newId(), t: "text", x, y, w, h, text: "", ...style };
  }

  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", n2(base.x));
  fo.setAttribute("y", n2(base.y));
  fo.setAttribute("width", n2(base.w));
  fo.setAttribute("height", n2(Math.max(base.h, frame.info.h - base.y)));
  const div = document.createElement("div");
  div.className = "pdfmk-text pdfmk-text-edit";
  div.setAttribute("contenteditable", "plaintext-only");
  div.setAttribute("role", "textbox");
  div.setAttribute("aria-multiline", "true");
  div.setAttribute("aria-label", "Text box");
  div.setAttribute("dir", "auto");
  div.spellcheck = false;
  styleTextBox(div, base);
  div.style.minHeight = `${base.h}px`;
  div.textContent = base.text;
  fo.appendChild(div);

  // the saved node hides while its editor is open
  let hidden: Element | null = null;
  if (existing) {
    for (const n of Array.from(frame.marks.children)) {
      if (n.getAttribute("data-id") === existing.id) {
        hidden = n;
        (n as SVGElement).style.visibility = "hidden";
      }
    }
  }
  frame.live.appendChild(fo);

  let done = false;
  const commit = (): void => {
    if (done) return;
    done = true;
    div.removeEventListener("keydown", onKey);
    div.removeEventListener("focusout", onBlur);
    const text = readText(div);
    fo.remove();
    if (hidden) (hidden as SVGElement).style.visibility = "";
    const fin = finishedText(base, text);
    if (existing) {
      if (!fin) session.commit((p) => removeAnnots(p, [{ pageId: key, id: existing!.id }]));
      else if (fin.text !== existing.text || fin.h !== existing.h) session.commit((p) => updateAnnot(p, key, existing!.id, { text: fin.text, h: fin.h }));
    } else if (fin) {
      session.commit((p) => addAnnot(p, key, fin));
    }
    onClose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  };
  const onBlur = (): void => commit();
  div.addEventListener("keydown", onKey);
  div.addEventListener("focusout", onBlur);
  div.focus();

  return {
    key,
    id: existing ? existing.id : null,
    contains: (t) => {
      for (let n = t as Node | null; n; n = n.parentNode) if (n === fo) return true;
      return false;
    },
    commit,
  };
}
