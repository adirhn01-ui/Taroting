// The text box's in-place editor: an editable div in a foreignObject on the
// page itself (inside the page's turned group, so it sits, turns and zooms
// exactly like the finished text), styled like the final text. Escape, a
// click away, or focus leaving commits; empty text deletes the box (or adds
// nothing). One history step per edit, and none when the text did not
// change.
//
// On a page shown turned (`r`, see geom.ts "Upright content"), the editor is
// the same upright frame the saved text draws in, turned into the box, so it
// reads upright on screen and grows downward on screen.

import type { PdfAnnot, PdfTextStyle } from "../../../core/types";
import { normalizeHexColor } from "../../../core/session";
import { addAnnot, newId, pageAnnots, removeAnnots, updateAnnot } from "../../model";
import type { Env } from "./env";
import { boxForFrame, boxPoints, clampFont, frameOf, frameRect, frameRoom, frameTransform, rotField, screenToPageDelta, textHeight, withFrameH } from "./geom";
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

/** The text a contenteditable holds. Chromium keeps a placeholder <br> after
 *  a last empty line, which innerText reads as one extra newline: only THAT
 *  is dropped — a newline the text itself holds (typed, or loaded from the
 *  mark) is kept, so opening and closing an editor never changes the text. */
export function readText(el: HTMLElement): string {
  const raw = (typeof el.innerText === "string" ? el.innerText : (el.textContent ?? "")).replace(/\r\n?/g, "\n");
  const last = el.lastChild as (Node & { tagName?: string }) | null;
  const placeholder = !!last && typeof last.tagName === "string" && last.tagName.toUpperCase() === "BR";
  return (placeholder ? raw.replace(/\n$/, "") : raw).slice(0, TEXT_MAX);
}

/** The finished mark for an edit, or null when the box ends up empty. Pure:
 *  the box grows (along its frame's down direction) to show every line,
 *  never shrinks. */
export function finishedText(base: TextAnnot, text: string): TextAnnot | null {
  if (text.trim() === "") return null;
  const lines = textLines({ ...base, text }).length;
  const H = Math.max(frameOf(base).H, textHeight(lines, base.size));
  return { ...base, text, ...withFrameH(base, H) };
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
    // upright on screen: the frame is W wide on screen, its left edge at the
    // click, centred on it vertically (on screen)
    const W = Math.min(TEXT_BOX_W, boxPoints(info.w, info.h, info.rot).W);
    const H = Math.max(TEXT_BOX_H, textHeight(1, style.size));
    const { w, h } = boxForFrame(W, H, info.rot);
    const half = screenToPageDelta(W / 2, 0, info.rot);
    const cx = target.at.x + half.x;
    const cy = target.at.y + half.y;
    const x = Math.max(0, Math.min(cx - w / 2, info.w - w));
    const y = Math.max(0, Math.min(cy - h / 2, info.h - h));
    base = { id: newId(), t: "text", x, y, w, h, text: "", ...style, ...rotField(info.rot) };
  }

  const [fx, fy, fw, fh] = frameRect(base);
  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", n2(fx));
  fo.setAttribute("y", n2(fy));
  fo.setAttribute("width", n2(fw));
  // room to grow down (on screen) to the page's edge
  fo.setAttribute("height", n2(Math.max(fh, frameRoom(base, frame.info.w, frame.info.h))));
  const turn = frameTransform(base);
  if (turn) fo.setAttribute("transform", turn);
  const div = document.createElement("div");
  div.className = "pdfmk-text pdfmk-text-edit";
  div.setAttribute("contenteditable", "plaintext-only");
  div.setAttribute("role", "textbox");
  div.setAttribute("aria-multiline", "true");
  div.setAttribute("aria-label", "Text box");
  div.setAttribute("dir", "auto");
  div.spellcheck = false;
  styleTextBox(div, base);
  div.style.minHeight = `${fh}px`;
  // every paragraph takes its own direction, as the saved text does
  div.style.unicodeBidi = "plaintext";
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
      else if (fin.text !== existing.text) {
        session.commit((p) => updateAnnot(p, key, existing!.id, { text: fin.text, x: fin.x, y: fin.y, w: fin.w, h: fin.h }));
      }
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
