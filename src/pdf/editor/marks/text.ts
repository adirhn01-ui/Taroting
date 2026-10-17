// The text box's in-place editor: an editable div in a foreignObject on the
// page itself (inside the page's turned group, so it sits, turns and zooms
// exactly like the finished text), styled like the final text — font, fill
// and border, re-read live while it is open (the inspector edits the mark or
// the Text tool's defaults under it). It wears the selection's own frame and
// eight handles, so typing in a box and having it selected look the same.
// Escape or Ctrl+Enter commits (the box stays selected) — also while focus is
// in the panel, unless a picker / menu / dialog is open (its own Escape comes
// first). Enter is a new line. A click away or focus leaving commits; the
// inspector and its colour picker do not: while a box is open the panel shows
// THAT box (ctx.textEdit) and edits it live, a button there never takes focus
// from the text, and `refocus` puts the caret back where it was after a
// select or slider. Empty text deletes the box (or adds nothing). A new box
// lands in ONE history step with its text and whatever look it was given
// while typed; an existing box's text lands in one step (none when unchanged).
//
// On a page shown turned (`r`, see geom.ts "Upright content"), the editor is
// the same upright frame the saved text draws in, turned into the box, so it
// reads upright on screen and grows downward on screen.

import type { PdfAnnot, PdfTextStyle } from "../../../core/types";
import { normalizeHexColor } from "../../../core/session";
import { addAnnot, newId, pageAnnots, removeAnnots, updateAnnot, type Box } from "../../model";
import type { Env } from "./env";
import {
  HANDLES,
  boxForFrame,
  boxPoints,
  clampFont,
  frameOf,
  frameRect,
  frameRoom,
  frameTransform,
  handlePoint,
  rotField,
  screenToPageDelta,
  textHeight,
  withFrameH,
} from "./geom";
import { SVG_NS, n2, styleBoxLook, styleTextBox, textLines } from "./render";

type TextAnnot = Extract<PdfAnnot, { t: "text" }>;

/** A new box: 200 pt wide, one line tall (24 pt at the default 12 pt). */
export const TEXT_BOX_W = 200;
export const TEXT_BOX_H = 24;
/** The loader's cap on a text box's characters (PDF_TEXT_MAX_CHARS). */
const TEXT_MAX = 20_000;
/** Handle size in SCREEN px — select.ts HANDLE_CSS (the same look). */
const HANDLE_CSS = 8;

export interface TextEditor {
  readonly key: string;
  /** the mark being edited, or null for a new box */
  readonly id: string | null;
  contains(target: EventTarget | null): boolean;
  /** the box as it stands now (grown to its typed lines), page space */
  box(): Box;
  /** re-place the frame and handles (the zoom changed) */
  refresh(): void;
  /** land the edit (idempotent); the id of the mark it leaves, or null */
  commit(): string | null;
}

/** How an editor closed: by its own keys (Escape, Ctrl+Enter — the box stays
 *  selected) or anything else (a click away, focus leaving, a tool change). */
export type CloseHow = "key" | "other";

/** Where the caret goes when an editor opens on an existing box. */
export type CaretAt = "end" | { clientX: number; clientY: number };

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

/** Put the caret in `div` at a client point (or at the end). Feature-
 *  detected: a document without caret hit-testing puts it at the end. */
function placeCaret(div: HTMLElement, at: CaretAt): void {
  try {
    const sel = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!sel || typeof document.createRange !== "function") return;
    let range: Range | null = null;
    if (at !== "end") {
      const d = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      if (typeof d.caretRangeFromPoint === "function") range = d.caretRangeFromPoint(at.clientX, at.clientY);
      else if (typeof d.caretPositionFromPoint === "function") {
        const pos = d.caretPositionFromPoint(at.clientX, at.clientY);
        if (pos) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
        }
      }
      if (range && !div.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(div);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* a caret we cannot place stays where focus put it */
  }
}

/** Is `t` inside the inspector or a colour picker? Focus going there keeps
 *  the editor open: the user is styling the box. */
function stylingTarget(t: EventTarget | null): boolean {
  const e = t as { closest?: (s: string) => unknown } | null;
  return !!e && typeof e.closest === "function" && !!e.closest(".inspector, .cp");
}

/** Is a surface open that owns Escape (a colour picker, a menu, a dialog)? */
function popoverOpen(): boolean {
  return typeof document !== "undefined" && typeof document.querySelector === "function" && !!document.querySelector(".cp, .ctx-menu, .modal-backdrop");
}

/** Open the editor on page `key`: on an existing text mark (`id`) or as a new
 *  box at `at`. `onClose` runs once, after the commit, with the id of the
 *  mark the edit left (null: none) and how it closed. */
export function openTextEditor(
  env: Env,
  key: string,
  target: { id: string } | { at: { x: number; y: number } },
  onClose: (id: string | null, how: CloseHow) => void,
  caret: CaretAt = "end",
): TextEditor | null {
  const { ctx } = env;
  const frame = env.layer.frame(key);
  if (!frame) return null;
  const session = ctx.session;
  /** a new box's look: the Text tool's defaults as they are NOW */
  const toolStyle = (): PdfTextStyle & { bg?: string; border?: string } => {
    const s = ctx.tools.get();
    const bg = s.textBg ? normalizeHexColor(s.textBg, "") : "";
    const border = s.textBorder ? normalizeHexColor(s.textBorder, "") : "";
    return {
      font: s.font,
      size: clampFont(s.sizes.text),
      c: normalizeHexColor(s.colors.text, "#000000"),
      bold: false,
      italic: false,
      align: "left",
      ...(bg ? { bg } : {}),
      ...(border ? { border } : {}),
    };
  };
  let base: TextAnnot;
  let existing: TextAnnot | null = null;
  if ("id" in target) {
    const a = pageAnnots(session.project, key).find((x) => x.id === target.id);
    if (!a || a.t !== "text") return null;
    existing = a;
    base = a;
  } else {
    const style = toolStyle();
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
  const id = base.id;
  /** the mark as it stands now (the inspector may restyle it while open) */
  const current = (): TextAnnot => {
    if (existing) {
      const a = pageAnnots(session.project, key).find((x) => x.id === id);
      return a && a.t === "text" ? a : base;
    }
    // a new box: the look the panel gave it (ctx.textEdit's draft)
    const e = ctx.textEdit.get();
    return e && e.id === id && e.draft ? e.draft : base;
  };

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
  let styled: TextAnnot | null = null;
  const restyle = (): void => {
    const a = current();
    const s = styled;
    if (s && a.font === s.font && a.size === s.size && a.c === s.c && a.bold === s.bold && a.italic === s.italic && a.align === s.align && a.bg === s.bg && a.border === s.border) return;
    styled = a;
    styleTextBox(div, a);
    styleBoxLook(div, a);
  };
  restyle();
  div.style.minHeight = `${fh}px`;
  // every paragraph takes its own direction, as the saved text does
  div.style.unicodeBidi = "plaintext";
  div.textContent = base.text;
  fo.appendChild(div);

  // the selection's own frame and handles, around the box as it grows
  const chrome = document.createElementNS(SVG_NS, "g");
  chrome.setAttribute("class", "pdfmk-edit-chrome");
  const outline = document.createElementNS(SVG_NS, "rect");
  outline.setAttribute("class", "pdfmk-sel");
  chrome.appendChild(outline);
  const handles = HANDLES.map((h) => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("class", `pdfmk-handle pdfmk-handle--${h}`);
    chrome.appendChild(r);
    return r;
  });

  // The saved text hides while its editor is open. An edited box's cover
  // (Edit text) stays, so the page's own text does not show through.
  // A box committed this very tick (Edit text) is painted by the layer on its
  // next notification, after this opens: the store listener below looks again.
  let hidden: SVGElement | null = null;
  const hideSaved = (): void => {
    if (!existing) return;
    for (const n of Array.from(frame.marks.children)) {
      if (n.getAttribute("data-id") !== id) continue;
      const shown = (n.tagName.toLowerCase() === "g" ? n.children[n.children.length - 1] : n) as SVGElement | undefined;
      if (shown && shown !== hidden) {
        if (hidden) hidden.style.visibility = "";
        hidden = shown;
        shown.style.visibility = "hidden";
      }
    }
  };
  hideSaved();
  frame.live.appendChild(fo);
  frame.live.appendChild(chrome);

  const grownH = (): number => {
    const h = typeof div.offsetHeight === "number" && Number.isFinite(div.offsetHeight) ? div.offsetHeight : 0;
    return Math.max(fh, h);
  };
  const box = (): Box => {
    const g = withFrameH(base, grownH());
    return [g.x, g.y, g.w, g.h];
  };
  const place = (): void => {
    const b = box();
    outline.setAttribute("x", n2(b[0]));
    outline.setAttribute("y", n2(b[1]));
    outline.setAttribute("width", n2(b[2]));
    outline.setAttribute("height", n2(b[3]));
    const s = HANDLE_CSS / env.zoom();
    HANDLES.forEach((h, i) => {
      const [hx, hy] = handlePoint(b, h);
      const r = handles[i]!;
      r.setAttribute("x", n2(hx - s / 2));
      r.setAttribute("y", n2(hy - s / 2));
      r.setAttribute("width", n2(s));
      r.setAttribute("height", n2(s));
    });
  };
  place();

  const unsubs = [
    session.store.subscribe(() => {
      restyle();
      hideSaved();
    }),
    ctx.textEdit.subscribe(restyle),
  ];

  // the caret, kept while focus is in the panel
  let caretRange: Range | null = null;
  const saveCaret = (): void => {
    try {
      const sel = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (div.contains(r.startContainer)) caretRange = r.cloneRange();
      }
    } catch {
      /* no caret to keep */
    }
  };
  const refocus = (): void => {
    if (done) return;
    div.focus();
    if (!caretRange) return;
    try {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(caretRange);
    } catch {
      /* the caret stays where focus put it */
    }
  };
  // A press in the panel: the editor stays open (focusout's relatedTarget
  // is null for a click on a non-focusable spot), and a BUTTON there does not
  // take focus at all, so typing goes on after a swatch or a toggle.
  let pressInPanel = false;
  const onDocDown = (e: Event): void => {
    pressInPanel = stylingTarget(e.target);
    if (!pressInPanel || e.type !== "mousedown") return;
    const t = e.target as { closest?: (s: string) => unknown };
    if (typeof t.closest === "function" && t.closest(".inspector button") && !t.closest(".cp")) e.preventDefault();
  };
  // Escape / Ctrl+Enter while focus is in the panel (the text's own keys
  // are handled on it)
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || !(e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey)))) return;
    if (popoverOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    commit("key");
  };
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("keydown", onDocKey, true);

  let done = false;
  let landed: string | null = null;
  const commit = (how: CloseHow | "discard"): string | null => {
    if (done) return landed;
    done = true;
    const now = current();
    for (const u of unsubs) u();
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
    div.removeEventListener("keydown", onKey);
    div.removeEventListener("focusout", onBlur);
    div.removeEventListener("input", place);
    const text = readText(div);
    fo.remove();
    chrome.remove();
    if (hidden) hidden.style.visibility = "";
    if (ctx.textEdit.get()?.id === id) ctx.textEdit.set(null);
    if (how === "discard") {
      landed = null;
      onClose(null, "other");
      return null;
    }
    const fin = finishedText(now, text);
    if (existing) {
      if (!pageAnnots(session.project, key).some((x) => x.id === id)) landed = null;
      else if (!fin) {
        session.commit((p) => removeAnnots(p, [{ pageId: key, id }]));
        landed = null;
      } else {
        if (fin.text !== now.text) session.commit((p) => updateAnnot(p, key, id, { text: fin.text, x: fin.x, y: fin.y, w: fin.w, h: fin.h }));
        landed = id;
      }
    } else if (fin) {
      const before = session.project;
      session.commit((p) => addAnnot(p, key, fin));
      landed = session.project !== before ? id : null;
    }
    onClose(landed, how);
    return landed;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      commit("key");
    }
  };
  const onBlur = (e: Event): void => {
    // styling the box in the inspector keeps it open
    if (pressInPanel || stylingTarget((e as FocusEvent).relatedTarget ?? null)) {
      saveCaret();
      return;
    }
    commit("other");
  };
  div.addEventListener("keydown", onKey);
  div.addEventListener("focusout", onBlur);
  div.addEventListener("input", place);
  ctx.textEdit.set({
    key,
    id,
    draft: existing ? null : base,
    commit: () => void commit("key"),
    discard: () => void commit("discard"),
    refocus,
  });
  div.focus();
  if (existing) placeCaret(div, caret);

  return {
    key,
    id: existing ? existing.id : null,
    contains: (t) => {
      for (let n = t as Node | null; n; n = n.parentNode) if (n === fo || n === chrome) return true;
      return false;
    },
    box,
    refresh: place,
    commit: () => commit("other"),
  };
}
