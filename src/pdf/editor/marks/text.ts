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

import type { PdfAnnot, PdfTextRun, PdfTextStyle } from "../../../core/types";
import { normalizeHexColor } from "../../../core/session";
import {
  applyRunStyle,
  clearRunFields,
  normalizeRuns,
  remapRuns,
  runsEqual,
  segmentsOf,
  styleSummary,
  type PdfResolvedStyle,
  type PdfRunField,
  type PdfRunPatch,
} from "../../../core/pdf-runs";
import { addAnnot, newId, pageAnnots, removeAnnots, setTextRuns, updateAnnot, type Box } from "../../model";
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
import { SVG_NS, n2, styleBoxLook, styleRunSpan, styleTextBox, textBoxHeight, textFaces } from "./render";
import { onFontsChanged } from "../../../fonts";

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
  // (for a box without runs, exactly textHeight(textLines(...).length, size))
  const H = Math.max(frameOf(base).H, textBoxHeight({ ...base, text }));
  return { ...base, text, ...withFrameH(base, H) };
}

/** `finishedText` for an editor with style runs in play (0.9.4): the mark
 *  carries `runs` (canonical for `text` over `base`; no key when none) and
 *  grows to the per-row height of its mixed sizes. */
export function finishedRuns(base: TextAnnot, text: string, runs: readonly PdfTextRun[] | undefined): TextAnnot | null {
  if (text.trim() === "") return null;
  const rest: TextAnnot = { ...base, text };
  delete (rest as { runs?: unknown }).runs;
  const r = normalizeRuns(text, base, runs);
  const mark: TextAnnot = r ? { ...rest, runs: r } : rest;
  const H = Math.max(frameOf(base).H, textBoxHeight(mark));
  return { ...mark, ...withFrameH(base, H) };
}

/* ------------------------------------------------------------------ */
/* One walker for the editor's text and its offsets (0.9.4 runs)       */
/* ------------------------------------------------------------------ */

/** Offsets are UTF-16 units of the text the walker reads: every text node's
 *  data, every <br> as "\n" — except Chromium's placeholder <br> (the last
 *  leaf of the content, nothing after it) and a <br> that is the last leaf of
 *  a block (`<div>…<br></div>`: that block's own line end), which are no
 *  character. Block elements the editor never builds (DIV, P: what a browser
 *  may make of Enter or a paste) are read the way `innerText` reads them: a
 *  block boundary with text before it (the start of a block) or after it (the
 *  end of a block) is ONE "\n", and boundaries with nothing between them
 *  collapse into one; so text is never silently joined. Reading the text and
 *  mapping a DOM point to an offset (and back) all go through `scan`, so the
 *  two can never disagree. */
interface Leaf {
  node: Node;
  start: number;
  /** characters this leaf stands for (a placeholder <br>: 0) */
  len: number;
  br: boolean;
  /** a block boundary's "\n" (no node of its own): where its point is */
  at?: { node: Node; offset: number };
}

const tagOf = (n: Node): string => String((n as Element).tagName ?? "").toUpperCase();
const isBr = (n: Node): boolean => n.nodeType === 1 && tagOf(n) === "BR";
const isBlock = (n: Node): boolean => n.nodeType === 1 && (tagOf(n) === "DIV" || tagOf(n) === "P");
const dataOf = (n: Node): string => (n as Text).data ?? n.textContent ?? "";
const indexIn = (n: Node): number => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;

type Item =
  | { k: "t"; node: Node }
  | { k: "br"; node: Node; blockLast: boolean }
  | { k: "open"; node: Node }
  | { k: "close"; node: Node }
  | { k: "pt" };

/** The one walker: the content's text, its leaves, the placeholder <br> and,
 *  with `target`, the offset of that DOM point (null when it is not met). */
function scan(root: Node, target?: { node: Node; off: number }): { leaves: Leaf[]; text: string; placeholder: Node | null; found: number | null } {
  const items: Item[] = [];
  // blocks open around the walk, each with the index of its last leaf item
  const open: { last: number }[] = [];
  let tOff = 0;
  const leaf = (it: Item): void => {
    items.push(it);
    for (const b of open) b.last = items.length - 1;
  };
  const walk = (n: Node): void => {
    const kids = Array.from(n.childNodes);
    for (let i = 0; i < kids.length; i++) {
      if (target && target.node === n && target.off === i) items.push({ k: "pt" });
      const c = kids[i]!;
      if (c.nodeType === 3) {
        if (target && target.node === c) tOff = target.off;
        leaf({ k: "t", node: c });
      } else if (isBr(c)) leaf({ k: "br", node: c, blockLast: false });
      else if (c.nodeType === 1) {
        const block = isBlock(c);
        if (block) {
          items.push({ k: "open", node: c });
          open.push({ last: -1 });
        }
        walk(c);
        if (block) {
          const b = open.pop()!;
          const last = items[b.last];
          if (last && last.k === "br") last.blockLast = true;
          items.push({ k: "close", node: c });
        }
      }
    }
    if (target && target.node === n && target.off >= kids.length) items.push({ k: "pt" });
  };
  walk(root);
  // the placeholder: a <br> with no character after it
  let placeholder: Node | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const l = items[i]!;
    if (l.k === "br") {
      placeholder = l.node;
      break;
    }
    if (l.k === "t" && dataOf(l.node).length > 0) break;
  }
  const leaves: Leaf[] = [];
  let text = "";
  let found: number | null = null;
  /** the last thing read was a block boundary (no line content since) */
  let boundary = false;
  /** a block ended: its "\n" comes before the next character */
  let pending: { node: Node; offset: number } | null = null;
  const brk = (at: { node: Node; offset: number }): void => {
    leaves.push({ node: at.node, start: text.length, len: 1, br: true, at });
    text += "\n";
    boundary = true;
    pending = null;
  };
  for (const it of items) {
    if (it.k === "open") {
      if (pending) brk(pending);
      else if (text.length > 0 && !boundary) brk({ node: it.node.parentNode!, offset: indexIn(it.node) });
    } else if (it.k === "close") {
      if (!boundary) pending = { node: it.node.parentNode!, offset: indexIn(it.node) + 1 };
    } else if (it.k === "pt") {
      found = text.length;
    } else if (it.k === "t") {
      const d = dataOf(it.node);
      if (d.length > 0 && pending) brk(pending);
      if (target && target.node === it.node) found = text.length + Math.max(0, Math.min(tOff, d.length));
      leaves.push({ node: it.node, start: text.length, len: d.length, br: false });
      text += d;
      if (d.length > 0) boundary = false;
    } else {
      const n = it.node === placeholder || it.blockLast ? 0 : 1;
      if (n > 0 && pending) brk(pending);
      if (target && target.node === it.node) found = text.length;
      leaves.push({ node: it.node, start: text.length, len: n, br: true });
      if (n > 0) text += "\n";
      // a block's own (empty) line counts as line content
      boundary = false;
    }
  }
  return { leaves, text, placeholder, found };
}

/** The text an editor's content holds, by the walker (capped like readText). */
export function editorText(root: Node): string {
  return scan(root).text.slice(0, TEXT_MAX);
}

/** The text offset of the DOM point (`node`, `off`) inside `root`, or null
 *  when the point is not in it. */
export function offsetOf(root: Node, node: Node, off: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  const { text, found } = scan(root, { node, off });
  return found === null ? null : Math.min(found, text.length);
}

/** The DOM point for text offset `at` (clamped). At the edge of two text
 *  nodes the earlier one wins (the end of the run before), which is where
 *  typing inherits its style from (`remapRuns`). */
export function pointAt(root: Node, at: number): { node: Node; offset: number } {
  const { leaves, text, placeholder } = scan(root);
  const v = Math.max(0, Math.min(at, text.length));
  for (const l of leaves) {
    if (l.at) {
      if (v === l.start) return l.at;
    } else if (!l.br && v >= l.start && v <= l.start + l.len) return { node: l.node, offset: v - l.start };
    else if (l.br && l.node !== placeholder && v === l.start) return beforeNode(l.node);
  }
  if (placeholder) return beforeNode(placeholder);
  return { node: root, offset: root.childNodes.length };
}

function beforeNode(n: Node): { node: Node; offset: number } {
  const p = n.parentNode!;
  return { node: p, offset: Array.prototype.indexOf.call(p.childNodes, n) as number };
}

/** A selection as text offsets: [s, e), and which end the focus is at. */
export interface SelOffsets {
  s: number;
  e: number;
  backward: boolean;
}

function windowSelection(): Selection | null {
  try {
    return typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
  } catch {
    return null;
  }
}

/** The document selection as offsets into `root`, or null when either end is
 *  outside it (or there is none). */
export function readSelection(root: Node): SelOffsets | null {
  const sel = windowSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  const a = offsetOf(root, sel.anchorNode, sel.anchorOffset);
  const f = offsetOf(root, sel.focusNode, sel.focusOffset);
  if (a === null || f === null) return null;
  return { s: Math.min(a, f), e: Math.max(a, f), backward: f < a };
}

/** Put the document selection at `o` inside `root` (focus end kept). */
export function writeSelection(root: Node, o: SelOffsets): void {
  const sel = windowSelection();
  if (!sel) return;
  try {
    const anchor = pointAt(root, o.backward ? o.e : o.s);
    const focus = pointAt(root, o.backward ? o.s : o.e);
    if (typeof sel.setBaseAndExtent === "function") sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    else if (typeof document.createRange === "function") {
      const r = document.createRange();
      r.setStart(anchor.node, anchor.offset);
      r.setEnd(focus.node, focus.offset);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } catch {
    /* the caret stays where it is */
  }
}

/** The CSS Custom Highlight registry, when this engine has one. */
function highlightRegistry(): { set(name: string, h: unknown): unknown; delete(name: string): unknown } | null {
  const g = globalThis as unknown as { CSS?: { highlights?: { set(n: string, h: unknown): unknown; delete(n: string): unknown } }; Highlight?: unknown };
  return g.CSS && g.CSS.highlights && typeof g.Highlight === "function" ? g.CSS.highlights : null;
}
/** The highlight name `marks.css` paints (`::highlight(pdfmk-kept)`). */
export const KEPT_HIGHLIGHT = "pdfmk-kept";

/** A typing burst merges into one undo step while it stays the same kind and
 *  no gap between two inputs is longer than this. */
export const UNDO_BURST_MS = 500;
/** Snapshots kept by the editor's own undo (the opening state always stays). */
const UNDO_MAX = 500;

/** "break": a line break (Enter), a kind of its own in the burst rule */
type EditKind = "insert" | "delete" | "break" | "other";
function kindOf(inputType: unknown): EditKind {
  const t = typeof inputType === "string" ? inputType : "";
  if (t === "insertParagraph" || t === "insertLineBreak") return "break";
  if (t === "insertText") return "insert";
  if (t.startsWith("delete")) return "delete";
  return "other";
}

const styleKey = (s: PdfResolvedStyle): string => `${s.font}\u0000${s.fontId ?? ""}\u0000${s.size}\u0000${s.c}\u0000${s.bold}\u0000${s.italic}`;

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

/** Is `t` inside the inspector, a colour picker or the shared font picker
 *  (its control and its list, which lives on <body>: both carry `fontpk`)?
 *  Focus going there keeps the editor open: the user is styling the box. */
function stylingTarget(t: EventTarget | null): boolean {
  const e = t as { closest?: (s: string) => unknown } | null;
  return !!e && typeof e.closest === "function" && !!e.closest(".inspector, .cp, .fontpk");
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
      ...(s.fontId !== undefined ? { fontId: s.fontId } : {}),
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
  // Style runs (0.9.4). Everything they need engages only when the box has
  // runs or a range style is applied in this session ("rich"); a box without
  // them edits exactly as before (R1): plain text, the browser's own undo,
  // readText, the same commit.
  let rich = false;
  /** while rich, the text and its canonical runs: the model the DOM follows */
  let model = "";
  let runs: PdfTextRun[] | undefined;
  /** the spans built from the model → their style (a DOM that still matches is left alone) */
  const spanKeys = new WeakMap<Node, string>();
  /** an IME composition is running: nothing is rebuilt until it ends */
  let composing = false;
  let styled: TextAnnot | null = null;
  /** the runs the mark (or draft) carried when last looked at: a change
   *  there came from outside the editor (a whole-box write in the panel, a
   *  project undo) */
  let seenRuns: PdfTextRun[] | undefined = base.runs;
  /** the fields this editor's own panel routing just cleared (`clearFields`):
   *  the project write that follows it is not an outside change */
  let routed: readonly PdfRunField[] | null = null;
  let routedGen = 0;
  // A library change re-lays every fontId box on the layer as a NEW node
  // (layer.ts), so the saved text this editor hides is looked for again once
  // the layer is done. Subscribed only once the box has a fontId (I1).
  let unFonts: (() => void) | null = null;
  const onFonts = (): void => {
    queueMicrotask(() => {
      if (!done) hideSaved();
    });
  };
  const restyle = (): void => {
    const a = current();
    const s = styled;
    if (!unFonts && a.fontId !== undefined) unFonts = onFontsChanged(onFonts);
    // (the mark's runs changed from outside is a change too)
    if (s && a.font === s.font && a.fontId === s.fontId && a.size === s.size && a.c === s.c && a.bold === s.bold && a.italic === s.italic && a.align === s.align && a.bg === s.bg && a.border === s.border && a.runs === seenRuns) return;
    styled = a;
    styleTextBox(div, a);
    styleBoxLook(div, a);
    if (!s) return;
    if (rich) baseChanged(s, a);
    else if (a.runs !== seenRuns) {
      // runs arrived from outside (a project undo) on a box typed in plain
      // mode: it turns styled, the mark's runs remapped onto the text
      seenRuns = a.runs;
      if (!composing && normalizeRuns(a.text, a, a.runs)) {
        goRich();
        runs = normalizeRuns(model, a, remapRuns(normalizeRuns(a.text, a, a.runs), a.text, model));
        stack[at] = { ...stack[at]!, runs };
        rerender();
        place();
      }
    }
  };
  restyle();
  div.style.minHeight = `${fh}px`;
  // every paragraph takes its own direction, as the saved text does
  div.style.unicodeBidi = "plaintext";
  const openRuns = existing ? normalizeRuns(base.text, base, base.runs) : undefined;
  // a box with runs is built as spans below, once that machinery exists
  if (!openRuns) div.textContent = base.text;
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

  // The saved text hides while its editor is open. The layer repaints a
  // changed mark as a new node: the store listener below looks again.
  let hidden: SVGElement | null = null;
  const hideSaved = (): void => {
    if (!existing) return;
    for (const n of Array.from(frame.marks.children)) {
      if (n.getAttribute("data-id") !== id) continue;
      const shown = n as SVGElement;
      if (shown !== hidden) {
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

  // The selection, kept as text OFFSETS while focus is in the panel (a DOM
  // Range would die when the spans are rebuilt), and painted there with the
  // CSS Custom Highlight API (the native highlight goes with the focus).
  let sel: SelOffsets | null = null;
  const clampSel = (o: SelOffsets, len: number): SelOffsets => ({ s: Math.min(o.s, len), e: Math.min(o.e, len), backward: o.backward });
  let kept = false;
  const clearKept = (): void => {
    if (!kept) return;
    kept = false;
    try {
      highlightRegistry()?.delete(KEPT_HIGHLIGHT);
    } catch {
      /* nothing painted */
    }
  };
  const paintKept = (): void => {
    const reg = highlightRegistry();
    if (done || !reg || !sel || sel.e <= sel.s || typeof document.createRange !== "function") {
      clearKept();
      return;
    }
    try {
      const r = document.createRange();
      const a = pointAt(div, sel.s);
      const b = pointAt(div, sel.e);
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      const H = (globalThis as unknown as { Highlight: new (r: Range) => unknown }).Highlight;
      reg.set(KEPT_HIGHLIGHT, new H(r));
      kept = true;
    } catch {
      clearKept();
    }
  };
  const onFocus = (): void => clearKept();
  const saveCaret = (): void => {
    sel = readSelection(div) ?? sel;
    paintKept();
  };

  // `range`, published on the store when the selection becomes or stops being
  // a non-collapsed range inside the text. A selection that LEAVES the text
  // (focus into the panel, the font picker's search) keeps the range: the
  // user is styling it. A collapsed caret with no range published costs no
  // DOM walk, so typing with a caret publishes nothing.
  let published: { s: number; e: number } | null = null;
  const publish = (r: { s: number; e: number } | null): void => {
    if (r === published || (r && published && r.s === published.s && r.e === published.e)) return;
    published = r;
    styleStep = null;
    const e = ctx.textEdit.get();
    // a fresh object: the store ignores the same reference
    if (e && e.id === id) ctx.textEdit.set({ ...e, range: r });
  };
  const onSelChange = (): void => {
    if (done) return;
    const ws = windowSelection();
    if (!ws || ws.rangeCount === 0 || !ws.anchorNode || !ws.focusNode) return;
    if (!div.contains(ws.anchorNode) || !div.contains(ws.focusNode)) return;
    if (ws.isCollapsed) {
      if (published) {
        sel = readSelection(div) ?? sel;
        publish(null);
      }
      return;
    }
    const o = readSelection(div);
    if (!o) return;
    sel = o;
    publish(o.e > o.s ? { s: o.s, e: o.e } : null);
  };
  document.addEventListener("selectionchange", onSelChange);

  /* ---------- rich mode: spans, remap, own undo ---------- */

  interface Snap {
    text: string;
    runs: PdfTextRun[] | undefined;
    sel: SelOffsets | null;
  }
  let stack: Snap[] = [];
  let at = 0;
  /** the typing step on top: its kind, last input time and caret after it */
  let burst: EditKind | null = null;
  let burstAt = 0;
  let burstCaret = -1;
  /** the range-style step on top, still open for streamed applyRange calls */
  let styleStep: { s: number; e: number; keys: string } | null = null;
  /** the selection just before the input being handled (beforeinput) */
  let pre: SelOffsets | null = null;
  /** the range the input says it will replace (`getTargetRanges`), when the
   *  engine tells: exact for every input type, a drop's target included */
  let preTarget: { s: number; e: number } | null = null;

  const render = (): void => {
    const a = current();
    while (div.firstChild) div.removeChild(div.firstChild);
    for (const g of segmentsOf(model, a, runs)) {
      const span = document.createElement("span");
      styleRunSpan(span, g.style);
      span.textContent = model.slice(g.s, g.e);
      spanKeys.set(span, styleKey(g.style));
      div.appendChild(span);
    }
    // a last empty line needs a line box for the caret (the walker skips it)
    if (model.endsWith("\n")) div.appendChild(document.createElement("br"));
    if (!unFonts && existing && runs?.some((r) => r.fontId !== undefined)) unFonts = onFontsChanged(onFonts);
  };
  /** do the spans in the DOM still say what the model says? */
  const domMatches = (): boolean => {
    const segs = segmentsOf(model, current(), runs);
    const kids = Array.from(div.childNodes);
    const tail = model.endsWith("\n") ? 1 : 0;
    if (kids.length !== segs.length + tail) return false;
    for (let i = 0; i < segs.length; i++) {
      const k = kids[i]!;
      const g = segs[i]!;
      if (spanKeys.get(k) !== styleKey(g.style) || k.childNodes.length !== 1) return false;
      const t = k.firstChild!;
      if (t.nodeType !== 3 || dataOf(t) !== model.slice(g.s, g.e)) return false;
    }
    return !tail || isBr(kids[kids.length - 1]!);
  };
  /** rebuild the spans; the selection goes back by offset (into the text
   *  when it has focus, else kept for the panel and its highlight repainted) */
  const rerender = (): void => {
    const active = document.activeElement === div;
    const keep = active ? (readSelection(div) ?? sel) : sel;
    render();
    sel = keep ? clampSel(keep, model.length) : null;
    if (active && sel) writeSelection(div, sel);
    else if (!active) paintKept();
  };
  const push = (snap: Snap, merge: boolean): void => {
    stack.length = at + 1;
    if (merge && at > 0) stack[at] = snap;
    else {
      stack.push(snap);
      at = stack.length - 1;
      if (stack.length > UNDO_MAX) {
        stack.splice(1, 1);
        at--;
      }
    }
  };
  /** after an input: one undo step per typing burst (same kind, no pause
   *  over UNDO_BURST_MS, the caret where the last input left it) */
  const record = (kind: EditKind): void => {
    const top = stack[at];
    const cur = readSelection(div);
    const pr = pre;
    pre = null;
    preTarget = null;
    if (!top || (top.text === model && runsEqual(top.runs, runs))) return;
    const now = Date.now();
    const jumped = pr !== null && (pr.s !== pr.e || pr.e !== burstCaret);
    const merge = kind !== "other" && burst === kind && now - burstAt <= UNDO_BURST_MS && !jumped;
    push({ text: model, runs, sel: cur }, merge);
    burst = kind === "other" ? null : kind;
    burstAt = now;
    burstCaret = cur ? cur.e : -1;
    styleStep = null;
  };
  /** the old-text range an input replaced, from the selection before it
   *  (`pre`) and its type: a selection is replaced whatever the input; at a
   *  caret, an insertion replaces nothing and a delete removes the characters
   *  that went before (Backward) or after (Forward) it. Undefined when not
   *  known (`remapRuns` then guesses). */
  const hintFor = (inputType: string, oldLen: number, newLen: number): { s: number; e: number } | undefined => {
    if (preTarget) return preTarget;
    const pr = pre;
    // a drop lands where the pointer is, not at the selection
    if (!pr || inputType === "insertFromDrop") return undefined;
    if (pr.e > pr.s) return { s: pr.s, e: pr.e };
    const c = pr.s;
    if (inputType.startsWith("insert")) return { s: c, e: c };
    const n = oldLen - newLen;
    if (!inputType.startsWith("delete") || n <= 0) return undefined;
    if (inputType.endsWith("Backward")) return { s: c - n, e: c };
    if (inputType.endsWith("Forward")) return { s: c, e: c + n };
    return undefined;
  };
  /** an input landed in the DOM: follow it in the model (the model wins) */
  const reconcile = (kind: EditKind, inputType = ""): void => {
    const next = editorText(div);
    if (next !== model) {
      runs = normalizeRuns(next, current(), remapRuns(runs, model, next, hintFor(inputType, model.length, next.length)));
      model = next;
    }
    if (!domMatches()) {
      const keep = readSelection(div);
      render();
      if (keep) writeSelection(div, clampSel(keep, model.length));
    }
    record(kind);
  };
  /** undo / redo: to snapshot `to` (never below the opening state) */
  const go = (to: number): void => {
    if (composing || to < 0 || to >= stack.length || to === at) return;
    at = to;
    const s = stack[at]!;
    model = s.text;
    runs = s.runs;
    render();
    sel = s.sel ? clampSel(s.sel, model.length) : { s: model.length, e: model.length, backward: false };
    if (document.activeElement === div) writeSelection(div, sel);
    else paintKept();
    burst = null;
    styleStep = null;
    pre = null;
    preTarget = null;
    place();
    publish(sel.e > sel.s ? { s: sel.s, e: sel.e } : null);
  };
  /** a base field or the mark's runs changed under the open editor.
   *  - From this editor's own panel routing (`clearFields` just ran: a
   *    whole-box write while the box is open): the live runs win, they
   *    already lost the cleared fields; the user's other uncommitted styles
   *    stay, and the editor's undo can bring the cleared ones back.
   *  - Anything else (a project undo / redo): the outside write wins. Changed
   *    runs are taken from the mark, remapped onto the text typed since (they
   *    agree with the mark's base already); a base-only change takes its
   *    fields off every live run. Either way changed base fields leave every
   *    undo snapshot, and the current snapshot is the new state. */
  const baseChanged = (s: TextAnnot, a: TextAnnot): void => {
    const fields: PdfRunField[] = [];
    if (a.font !== s.font || a.fontId !== s.fontId) fields.push("font");
    if (a.size !== s.size) fields.push("size");
    if (a.c !== s.c) fields.push("c");
    if (a.bold !== s.bold) fields.push("bold");
    if (a.italic !== s.italic) fields.push("italic");
    const outside = a.runs !== seenRuns;
    seenRuns = a.runs;
    const mine = routed;
    routed = null;
    if (!outside && fields.length === 0) return;
    if (mine) {
      runs = clearRunFields(a, runs, [...new Set<PdfRunField>([...mine, ...fields])]);
      if (stack[at]) stack[at] = { ...stack[at]!, runs };
    } else {
      if (outside) runs = normalizeRuns(model, a, remapRuns(normalizeRuns(a.text, a, a.runs), a.text, model));
      else runs = clearRunFields(a, runs, fields);
      if (fields.length > 0) stack = stack.map((x) => ({ ...x, runs: clearRunFields(a, x.runs, fields) }));
      if (stack[at]) stack[at] = { ...stack[at]!, runs };
      styleStep = null;
    }
    if (!composing) {
      rerender();
      place();
    }
  };
  /** put `str` in place of the selection `r` THROUGH THE MODEL (the browser's
   *  own edit was prevented): a line break, multi-line typed / pasted /
   *  dropped text; one step by the burst rule, the caret after it */
  const insertThroughModel = (str: string, kind: EditKind, r: SelOffsets | null, target: { s: number; e: number } | null): void => {
    const o = target ?? r ?? sel ?? { s: model.length, e: model.length, backward: false };
    const s0 = Math.min(o.s, model.length);
    const e0 = Math.min(o.e, model.length);
    const ins = str.slice(0, Math.max(0, TEXT_MAX - (model.length - (e0 - s0))));
    const next = model.slice(0, s0) + ins + model.slice(e0);
    if (next !== model) {
      runs = normalizeRuns(next, current(), remapRuns(runs, model, next, { s: s0, e: e0 }));
      model = next;
    }
    render();
    const caret: SelOffsets = { s: s0 + ins.length, e: s0 + ins.length, backward: false };
    sel = caret;
    writeSelection(div, caret);
    pre = r;
    record(kind);
    place();
    publish(null);
  };
  /** the input's own target range as offsets, when the engine gives one
   *  inside the text */
  const targetOf = (ie: { getTargetRanges?: () => ArrayLike<{ startContainer: Node; startOffset: number; endContainer: Node; endOffset: number }> }): { s: number; e: number } | null => {
    try {
      const r = typeof ie.getTargetRanges === "function" ? ie.getTargetRanges()[0] : undefined;
      if (!r) return null;
      const a = offsetOf(div, r.startContainer, r.startOffset);
      const b = offsetOf(div, r.endContainer, r.endOffset);
      return a === null || b === null ? null : { s: Math.min(a, b), e: Math.max(a, b) };
    } catch {
      return null;
    }
  };
  const onBeforeInput = (e: Event): void => {
    const ie = e as InputEvent & { dataTransfer?: { getData?(t: string): string } | null };
    const t = ie.inputType;
    if (t === "historyUndo" || t === "historyRedo") {
      e.preventDefault();
      go(t === "historyUndo" ? at - 1 : at + 1);
      return;
    }
    if (composing || ie.isComposing) return;
    pre = readSelection(div);
    preTarget = targetOf(ie);
    // a line break never depends on the DOM the browser would build for it
    if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      insertThroughModel("\n", "break", pre, preTarget);
      return;
    }
    if (t === "insertText" || t === "insertFromPaste" || t === "insertFromDrop" || t === "insertReplacementText") {
      let raw: string | null = typeof ie.data === "string" ? ie.data : null;
      if (raw === null) {
        try {
          const g = ie.dataTransfer?.getData?.("text/plain");
          raw = typeof g === "string" ? g : null;
        } catch {
          raw = null;
        }
      }
      if (raw !== null && /[\r\n]/.test(raw)) {
        // a drop the engine does not place for us is left to it (the walker
        // still reads whatever DOM it builds)
        if (t === "insertFromDrop" && !preTarget) return;
        e.preventDefault();
        insertThroughModel(raw.replace(/\r\n?/g, "\n"), t === "insertText" ? "insert" : "other", pre, preTarget);
      }
    }
  };
  const onCompStart = (): void => {
    composing = true;
  };
  const onCompEnd = (): void => {
    composing = false;
    if (done || !rich) return;
    pre = null;
    preTarget = null;
    reconcile("other");
    place();
  };
  const enterRich = (): void => {
    rich = true;
    div.addEventListener("beforeinput", onBeforeInput);
    div.addEventListener("compositionstart", onCompStart);
    div.addEventListener("compositionend", onCompEnd);
  };
  /** a plain editor turns styled: the model is read from the DOM by the
   *  walker (a block the browser made is a line break, see `scan`) and the
   *  undo stack starts at the opening state (caret at the end), then the
   *  typing so far. The caller rebuilds the spans from the model. */
  const goRich = (): void => {
    const opening: Snap = { text: existing ? base.text : "", runs: undefined, sel: null };
    enterRich();
    model = editorText(div);
    runs = undefined;
    seenRuns = current().runs;
    stack = [opening];
    at = 0;
    if (model !== opening.text) push({ text: model, runs: undefined, sel: readSelection(div) ?? sel }, false);
  };
  const onInput = (e: Event): void => {
    const t = (e as InputEvent).inputType;
    if (rich && !composing && !(e as InputEvent).isComposing) reconcile(kindOf(t), typeof t === "string" ? t : "");
    place();
  };

  const styleOf = (): PdfResolvedStyle => {
    const a = current();
    return rich ? styleSummary(model, a, runs, published) : styleSummary(a.text, a, undefined, null);
  };
  /** Style the published range (the panel, Ctrl+B / Ctrl+I). Streamed calls
   *  (a slider drag, colour previews) on the same range and fields are ONE
   *  undo step until `refocus`, typing or a selection change closes it;
   *  Bold / Italic are a step per call. */
  const applyRange = (patch: PdfRunPatch): void => {
    if (done || composing || !published) return;
    const r = published;
    if (!rich) goRich();
    const a = current();
    const next = applyRunStyle(model, a, runs, r, patch);
    const keys = Object.keys(patch).sort().join(",");
    const toggle = "bold" in patch || "italic" in patch;
    const merge = !toggle && !!styleStep && styleStep.s === r.s && styleStep.e === r.e && styleStep.keys === keys;
    if (runsEqual(next, runs)) return;
    runs = next;
    const keep: SelOffsets = { s: r.s, e: r.e, backward: sel && sel.s === r.s && sel.e === r.e ? sel.backward : false };
    sel = keep;
    const active = document.activeElement === div;
    render();
    if (active) writeSelection(div, keep);
    else paintKept();
    push({ text: model, runs, sel: keep }, merge);
    styleStep = toggle ? null : { s: r.s, e: r.e, keys };
    burst = null;
    place();
    // the panel re-reads styleOf
    const e = ctx.textEdit.get();
    if (e && e.id === id) ctx.textEdit.set({ ...e });
  };

  /** The panel's whole-box write of these per-run fields while this box is
   *  open (D1): they leave every live run as ONE undo step of the editor's
   *  own (a streamed write — a slider drag — changes the runs on its first
   *  call only, so it stays one step), the spans are rebuilt and the caret
   *  kept. The project write that follows
   *  is then known as this editor's own (`routed`), not an outside change. */
  const clearFields = (fields: readonly PdfRunField[]): void => {
    if (done || composing || !rich || fields.length === 0) return;
    routed = [...fields];
    const gen = ++routedGen;
    setTimeout(() => {
      if (routedGen === gen) routed = null;
    }, 0);
    const next = clearRunFields(current(), runs, fields);
    if (runsEqual(next, runs)) return;
    runs = next;
    rerender();
    push({ text: model, runs, sel }, false);
    styleStep = null;
    burst = null;
    place();
    const e = ctx.textEdit.get();
    if (e && e.id === id) ctx.textEdit.set({ ...e });
  };

  const refocus = (): void => {
    if (done) return;
    // a streamed style gesture ends here
    styleStep = null;
    div.focus();
    if (sel) writeSelection(div, sel);
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
    unFonts?.();
    unFonts = null;
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
    div.removeEventListener("keydown", onKey);
    div.removeEventListener("focusout", onBlur);
    div.removeEventListener("focus", onFocus);
    div.removeEventListener("input", onInput);
    div.removeEventListener("beforeinput", onBeforeInput);
    div.removeEventListener("compositionstart", onCompStart);
    div.removeEventListener("compositionend", onCompEnd);
    document.removeEventListener("selectionchange", onSelChange);
    clearKept();
    let text: string;
    if (rich) {
      // whatever the DOM holds now (an unfinished composition included)
      const t = editorText(div);
      if (t !== model) {
        runs = normalizeRuns(t, now, remapRuns(runs, model, t));
        model = t;
      }
      text = model;
    } else text = readText(div);
    stack = [];
    fo.remove();
    chrome.remove();
    if (hidden) hidden.style.visibility = "";
    if (ctx.textEdit.get()?.id === id) ctx.textEdit.set(null);
    if (how === "discard") {
      landed = null;
      onClose(null, "other");
      return null;
    }
    const fin = rich ? finishedRuns(now, text, runs) : finishedText(now, text);
    if (existing) {
      if (!pageAnnots(session.project, key).some((x) => x.id === id)) landed = null;
      else if (!fin) {
        session.commit((p) => removeAnnots(p, [{ pageId: key, id }]));
        landed = null;
      } else {
        if (rich) {
          // the text, then the runs (clipped to it), in ONE history step;
          // a change of the runs alone lands too
          if (fin.text !== now.text || !runsEqual(fin.runs, normalizeRuns(now.text, now, now.runs))) {
            session.commit((p) => setTextRuns(updateAnnot(p, key, id, { text: fin.text, x: fin.x, y: fin.y, w: fin.w, h: fin.h }), key, id, fin.runs));
          }
        } else if (fin.text !== now.text) session.commit((p) => updateAnnot(p, key, id, { text: fin.text, x: fin.x, y: fin.y, w: fin.w, h: fin.h }));
        landed = id;
      }
    } else if (fin) {
      const before = session.project;
      if (rich) {
        const plain: TextAnnot = { ...fin };
        delete (plain as { runs?: unknown }).runs;
        session.commit((p) => setTextRuns(addAnnot(p, key, plain), key, id, fin.runs));
      } else session.commit((p) => addAnnot(p, key, fin));
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
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
    const k = typeof e.key === "string" ? e.key.toLowerCase() : "";
    // Ctrl+B / Ctrl+I: bold / italic for the selected range (on only when
    // every character has it). A collapsed caret does nothing here: the
    // whole box's toggles are the panel's.
    if (!e.shiftKey && (k === "b" || k === "i")) {
      onSelChange();
      if (!published) return;
      e.preventDefault();
      e.stopPropagation();
      const st = styleOf();
      // the panel's face rule: a face the font lacks is never stored (D5)
      const faces = textFaces(st);
      if (k === "b" ? !faces.bold : !faces.italic) return;
      applyRange(k === "b" ? { bold: !st.bold } : { italic: !st.italic });
      return;
    }
    // the editor's own undo, once runs are in play (R1: else the browser's)
    if (rich && (k === "z" || (k === "y" && !e.shiftKey))) {
      e.preventDefault();
      e.stopPropagation();
      go(k === "z" && !e.shiftKey ? at - 1 : at + 1);
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
  div.addEventListener("input", onInput);
  div.addEventListener("focus", onFocus);
  if (openRuns) {
    enterRich();
    model = base.text;
    runs = openRuns;
    render();
    place();
  }
  ctx.textEdit.set({
    key,
    id,
    draft: existing ? null : base,
    commit: () => void commit("key"),
    discard: () => void commit("discard"),
    refocus,
    range: null,
    applyRange,
    styleOf,
    clearFields,
  });
  div.focus();
  if (existing) placeCaret(div, caret);
  // the opening state: undo stops here
  if (rich) stack = [{ text: model, runs, sel: readSelection(div) }];

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
