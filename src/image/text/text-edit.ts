// Typing in a text layer, in place on the stage.
//
// A `contenteditable="plaintext-only"` div sits over the layer, laid out in
// the layer's own space: its CSS matrix is the stage's canvas-to-screen
// scale times the layer's matrix (geom.ts layerToCanvas), so the caret and
// the selection are drawn where the canvas draws the glyphs, at the layer's
// size, quarter turn, flip and the view's zoom. Its own text is TRANSPARENT:
// every input re-measures the box, writes the generator through
// `session.replace` and the ONE Canvas2D renderer paints the real pixels
// (z-order, opacity and crop included), so what is typed is what exports.
//
// One edit = one undo step. Typing, and any restyle from the text section or
// the tool row's font while the text is open, write through `replace`;
// closing lands `commitFrom(before)` once. Ctrl+Z / Ctrl+Y inside the text
// step through what was typed in THIS editor (bursts of typing, its own
// list), never the browser's page-wide editing history. A new layer that ends
// up empty is taken back as if it had never been placed (no step, not an
// edit); an existing layer the user emptied is removed in one step.
//
// Another writer never lands inside the edit: a press on any other control
// ends the edit first (capture phase), a history write (`commit`, `undo`,
// `redo`, wrapped while a text is open) lands it first, and a write without
// a history step (a decoded-size fix-up) closes it with its step.
//
// Zero overhead at rest: nothing here exists until a text is opened, and an open
// editor runs nothing per frame — it re-places itself only when the view or
// the project changes.

import { cssFont, measureText, measureTextWhenReady, styleAvailability } from "../../editor/media/generators";
import {
  activeRuns,
  changedRunFields,
  genRunBase,
  genSegments,
  genSummary,
  hasStrongRtl,
  styleGen,
  styleGenRangeChecked,
  withGenText,
  withRunsKey,
} from "../../core/gen-text-runs";
import { clearRunFields, normalizeRuns, runsEqual } from "../../core/pdf-runs";
import type { PdfTextRun, ProjectFile } from "../../core/types";
import {
  dataOf,
  editorText,
  highlightRegistry,
  isBr,
  kindOf,
  offsetOf,
  pointAt,
  readSelection,
  UNDO_BURST_MS,
  windowSelection,
  writeSelection,
  type EditKind,
  type SelOffsets,
} from "../../ui/rich-text/dom";
import { toast } from "../../ui/toast";
import type { ImageEditorCtx, TextEditHandle, TextRangeStyle, TextStylePatch } from "../context";
import { layerToCanvas } from "../geom";
import { cutText, findLayer, removeLayer, setTextGen, TEXT_MAX_CHARS } from "../layers";
import { sameEdit } from "../same-edit";
import { applyTextStyle, readRawText, readText, runPatchOf, type TextGen } from "./text-style";

/** Said once when a range style would give a text more styled parts than
 *  a text may hold. */
export const TOO_MANY_STYLES = "This text has too many styles to add another";
/** The highlight name text.css paints (`::highlight(imged-text-kept)`): the
 *  selected part of an open text while focus is in a styling surface. */
export const KEPT_HIGHLIGHT = "imged-text-kept";
/** Snapshots the styled editor's own undo keeps (the opening state always
 *  stays). */
const RICH_STEPS_MAX = 500;

/** How an editor closed: its own keys (Escape, Ctrl+Enter) or anything else. */
export type CloseHow = "key" | "other";

/** Where the caret goes when an editor opens. */
export type CaretAt = "end" | { clientX: number; clientY: number };

export interface TextEditor extends TextEditHandle {
  /** Is `t` the editor or inside it? */
  contains(t: EventTarget | null): boolean;
  /** Close without landing anything (another writer took the project). */
  leave(): void;
  readonly closed: boolean;
}

/** Is `t` a surface that styles the open text (the inspector's TEXT section,
 *  the tool row's font, a colour picker, the shared font picker's control or
 *  its list)? A press or focus going there keeps the editor open. The rest of
 *  the inspector (position, opacity, flips, adjustments) writes the project
 *  itself: a press there ends the edit first. */
export function stylingTarget(t: EventTarget | null): boolean {
  const e = t as { closest?: (s: string) => unknown } | null;
  return !!e && typeof e.closest === "function" && !!e.closest(".imged-text-section, .imged-fontpick, .cp, .fontpk");
}

/** Typing within this long of the last keystroke is one Ctrl+Z step. */
export const TYPING_BURST_MS = 500;
/** The most Ctrl+Z steps one open editor keeps. */
const TYPING_STEPS_MAX = 200;

/** Stage-local CSS px per canvas px, and the stage-local CSS position of the
 *  canvas origin: the select tool's reading of the view, so the editor lands
 *  exactly where its chrome does. */
export function stageMapping(ctx: Pick<ImageEditorCtx, "stage" | "view">): { ox: number; oy: number; sx: number; sy: number } {
  const r = ctx.stage.getBoundingClientRect();
  const a = ctx.view.canvasToClient(0, 0);
  const b = ctx.view.canvasToClient(1, 0);
  const c = ctx.view.canvasToClient(0, 1);
  return {
    ox: a.x - r.left - ctx.stage.clientLeft,
    oy: a.y - r.top - ctx.stage.clientTop,
    sx: b.x - a.x,
    sy: c.y - a.y,
  };
}

/** The CSS `matrix()` that lays out layer-local px on the stage, and the
 *  screen px one layer px spans (for a one-pixel outline at any zoom). */
export function editMatrix(
  m: readonly [number, number, number, number, number, number],
  map: { ox: number; oy: number; sx: number; sy: number },
): { css: string; px: number } {
  const a = map.sx * m[0];
  const b = map.sy * m[1];
  const c = map.sx * m[2];
  const d = map.sy * m[3];
  const e = map.ox + map.sx * m[4];
  const f = map.oy + map.sy * m[5];
  const n = (v: number): string => String(Math.round(v * 1e6) / 1e6 + 0);
  return { css: `matrix(${n(a)}, ${n(b)}, ${n(c)}, ${n(d)}, ${n(e)}, ${n(f)})`, px: Math.hypot(a, b) || 1 };
}

/** Put the caret in `div` at a client point, or at the end. A document
 *  without caret hit-testing puts it at the end. */
export function placeCaret(div: HTMLElement, at: CaretAt): void {
  try {
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!sel || typeof document.createRange !== "function") return;
    let range: Range | null = null;
    if (at !== "end") {
      const d = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      if (typeof d.caretRangeFromPoint === "function") range = d.caretRangeFromPoint(at.clientX, at.clientY);
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

export interface OpenTextOpts {
  ctx: ImageEditorCtx;
  trackId: string;
  /** the project the edit's one undo step goes back to */
  before: ProjectFile;
  /** a layer placed for this edit: taken back (no step) when left empty */
  isNew: boolean;
  /** the selection to restore when a new layer is taken back */
  prevSelection: string | null;
  caret: CaretAt;
  /** runs once, after the edit has landed (or was left) */
  onClose(how: CloseHow): void;
}

const genOf = (p: ProjectFile, trackId: string): TextGen | null => {
  const l = findLayer(p, trackId);
  const g = l?.media.generator;
  return l && g?.type === "text" ? g : null;
};

/** Open text layer `trackId` for typing. Null when it is not a text layer. */
export function openTextEditor(o: OpenTextOpts): TextEditor | null {
  const { ctx, trackId, before } = o;
  const { session } = ctx;
  const start = genOf(session.project, trackId);
  if (!start) return null;
  const startText = start.text;
  const opened: TextGen = start;

  /** the generator as the user has asked for it (a measure may still be
   *  waiting for its font); every edit builds on this */
  let cur: TextGen = start;
  /** the project this editor last wrote (or found): anything else in the
   *  store is another writer's edit */
  let written: ProjectFile = session.project;
  let closed = false;
  /** the newest write still waiting for its font: an older one is dropped */
  let measureSeq = 0;
  let pending = false;
  /** the caret / selection when focus last left the text for a styling
   *  surface, so a restyle can hand the keyboard back where it was */
  let savedRange: Range | null = null;

  // Styled parts (0.9.5). Everything they need engages only once the text
  // has runs or a range is styled ("rich"); a text without them is typed
  // exactly as before: one text node, readRawText, the plain undo list.
  let rich = false;
  /** an IME composition is running: nothing is rebuilt until it ends */
  let composing = false;
  /** the selected part, as published on the handle (null: none) */
  let published: { s: number; e: number } | null = null;
  /** the selection as offsets, kept while focus is in a styling surface
   *  (a DOM Range dies when the spans are rebuilt) */
  let sel: SelOffsets | null = null;

  const div = document.createElement("div");
  div.className = "imged-textedit";
  div.setAttribute("contenteditable", "plaintext-only");
  div.setAttribute("role", "textbox");
  div.setAttribute("aria-multiline", "true");
  div.setAttribute("aria-label", "Text");
  div.setAttribute("dir", "ltr");
  div.spellcheck = false;
  div.dataset.track = trackId;
  div.textContent = start.text;

  let shownFont = "";
  let shownMinH = "";
  const styleFont = (g: TextGen): void => {
    const f = cssFont(g);
    if (f !== shownFont) {
      shownFont = f;
      div.style.font = f;
    }
    // An empty line still has the height of one, so the caret shows.
    const minH = `${g.sizePx * 1.25}px`;
    if (minH !== shownMinH) {
      shownMinH = minH;
      div.style.minHeight = minH;
    }
  };

  let shownMatrix = "";
  const place = (): void => {
    if (closed) return;
    const p = session.project;
    const l = findLayer(p, trackId);
    if (!l) return;
    const w = l.media.width ?? 1;
    const h = l.media.height ?? 1;
    const m = layerToCanvas(l.transform, w, h, p.timeline.width, p.timeline.height);
    const { css, px } = editMatrix(m, stageMapping(ctx));
    if (css === shownMatrix) return;
    shownMatrix = css;
    div.style.transform = css;
    // One screen pixel of outline whatever the zoom and the layer's scale.
    div.style.setProperty("--imged-textedit-px", `${1 / px}px`);
  };

  styleFont(start);
  ctx.stage.appendChild(div);
  place();

  /* ---------------- writing ---------------- */

  const foreign = (): boolean => !sameEdit(session.project, written);

  // A new layer's typing is not an edit until it lands with something in it:
  // typed and cleared again, it leaves the project as it found it.
  const writeOpts = { edit: !o.isNew };
  const write = (g: TextGen, w: number, h: number): void => {
    if (closed || foreign()) return;
    const next = setTextGen(session.project, trackId, g, w, h);
    session.replace(next, writeOpts);
    written = session.project;
    cur = g;
    styleFont(g);
    place();
    // a measure may have turned a run's missing face off: the spans follow
    if (rich && !composing && !domMatches()) rerender();
  };

  const apply = (g: TextGen): void => {
    cur = g;
    styleFont(g);
    const box = measureTextWhenReady(g);
    if (!(box instanceof Promise)) {
      measureSeq++;
      pending = false;
      write(box.gen, box.width, box.height);
      return;
    }
    const seq = ++measureSeq;
    pending = true;
    void box.then((b) => {
      if (seq !== measureSeq) return;
      if (closed) {
        lateMeasure(b);
        return;
      }
      pending = false;
      write(b.gen, b.width, b.height);
    });
  };

  /** The generator an edit closed with while its font was still loading
   *  (measured with the fallback). */
  let landedEarly: TextGen | null = null;
  /** The font arrived after the edit closed: the box is measured again, as a
   *  fix-up of that very step (no step of its own, not an edit), but only
   *  while the layer still holds exactly what the edit left. */
  const lateMeasure = (b: { gen: TextGen; width: number; height: number }): void => {
    const g = landedEarly;
    landedEarly = null;
    if (g === null || genOf(session.project, trackId) !== g) return;
    session.replace(setTextGen(session.project, trackId, b.gen, b.width, b.height), { edit: false });
  };

  /* ---------------- Ctrl+Z inside the text ---------------- */

  const past: string[] = [];
  const future: string[] = [];
  let lastTypedAt = Number.NEGATIVE_INFINITY;
  const noteTyping = (prev: string): void => {
    const now = Date.now();
    if (now - lastTypedAt > TYPING_BURST_MS) {
      past.push(prev);
      if (past.length > TYPING_STEPS_MAX) past.shift();
    }
    future.length = 0;
    lastTypedAt = now;
  };
  const stepText = (back: boolean): void => {
    if (closed) return;
    const from = back ? past : future;
    const t = from.pop();
    if (t === undefined) return;
    (back ? future : past).push(cur.text);
    lastTypedAt = Number.NEGATIVE_INFINITY;
    savedRange = null;
    div.textContent = t;
    placeCaret(div, "end");
    apply(withGenText(cur, t));
  };

  const onInput = (e?: Event): void => {
    if (closed) return;
    if (rich) {
      savedRange = null;
      const t = (e as InputEvent | undefined)?.inputType;
      if (!composing && !(e as InputEvent | undefined)?.isComposing) reconcile(kindOf(t), typeof t === "string" ? t : "");
      return;
    }
    // Typed since the caret was saved: that caret is out of date.
    savedRange = null;
    const raw = readRawText(div);
    const text = cutText(raw);
    // A paste past the cap: the text holds only what the layer holds, so the
    // caret never sits in a tail the canvas does not draw.
    if (text !== raw) {
      div.textContent = text;
      placeCaret(div, "end");
    }
    if (text === cur.text) return;
    noteTyping(cur.text);
    apply(withGenText(cur, text));
  };

  /** Typing past the cap is refused before it lands (a paste is cut by
   *  onInput instead). */
  const onBeforeInput = (e: InputEvent): void => {
    // The browser's editing history is one per page, not per field: it could
    // reach back into an editor already gone. This text keeps its own.
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      if (rich) go(e.inputType === "historyUndo" ? at - 1 : at + 1);
      else stepText(e.inputType === "historyUndo");
      return;
    }
    if (rich && richBeforeInput(e)) return;
    if (e.inputType !== "insertText" && e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") return;
    const sel = window.getSelection();
    const replacing = sel && !sel.isCollapsed ? sel.toString().length : 0;
    const adding = e.inputType === "insertText" ? (e.data ?? "").length : 1;
    if (readText(div).length - replacing + adding > TEXT_MAX_CHARS) e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      close("key");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      // Ctrl+B / Ctrl+I: bold / italic for the selected part (on only when
      // all of it has it). A caret alone does nothing here, and the key goes
      // on as if this text were not open.
      if (!e.shiftKey && (k === "b" || k === "i")) {
        onSelChange();
        if (!published || hasStrongRtl(cur.text)) return;
        e.preventDefault();
        e.stopPropagation();
        const st = styleOf();
        const can = styleAvailability(st.font, st.fontId);
        if (k === "b" ? !can.bold : !can.italic) return;
        applyRange(k === "b" ? { bold: !st.bold } : { italic: !st.italic });
        return;
      }
      const z = k === "z" || e.code === "KeyZ";
      const y = k === "y" || e.code === "KeyY";
      if (!z && !y) return;
      e.preventDefault();
      e.stopPropagation();
      if (rich) go(z && !e.shiftKey ? at - 1 : at + 1);
      else stepText(z && !e.shiftKey);
    }
  };

  const onFocusOut = (e: FocusEvent): void => {
    if (closed) return;
    const next = e.relatedTarget;
    // Nowhere in particular (the window lost focus, a click on something
    // that takes none): a press is judged by the press handler instead.
    if (next === null || div.contains(next as Node)) return;
    if (stylingTarget(next)) {
      goAway();
      return;
    }
    // Tab, or anything else that moved the keyboard away: done.
    close("other");
  };

  const saveRange = (): void => {
    const ws = window.getSelection();
    if (ws && ws.rangeCount > 0 && div.contains(ws.getRangeAt(0).startContainer)) {
      savedRange = ws.getRangeAt(0).cloneRange();
      if (rich) sel = readSelection(div) ?? sel;
    }
  };

  /* ---------------- the selection, kept while focus is away ---------------- */

  // The native selection is drawn only while the text has focus. Once focus
  // goes to a styling surface (the inspector, a font list, a colour picker)
  // the selected part (the published range) is painted with the CSS Custom
  // Highlight API, from its offsets (the spans may be rebuilt meanwhile); an
  // engine without it paints nothing. Painted only between that focus move and the text's next focus
  // or its close; nothing runs otherwise.
  /** focus left the text for a styling surface and has not come back */
  let away = false;
  /** this editor's highlight is in the registry */
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
    const reg = away && !closed ? highlightRegistry() : null;
    // the part a style would go to: the published range
    const o = published;
    if (!reg || !o || o.e <= o.s || typeof document.createRange !== "function") {
      clearKept();
      return;
    }
    try {
      const len = cur.text.length;
      const a = pointAt(div, Math.min(o.s, len));
      const b = pointAt(div, Math.min(o.e, len));
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      const H = (globalThis as unknown as { Highlight: new (r: Range) => unknown }).Highlight;
      reg.set(KEPT_HIGHLIGHT, new H(r));
      kept = true;
    } catch {
      clearKept();
    }
  };
  const onFocusIn = (): void => {
    away = false;
    clearKept();
  };
  /** Focus went to a styling surface: keep the selection and paint it. */
  const goAway = (): void => {
    saveRange();
    away = true;
    paintKept();
  };

  /** A press outside the text and outside every styling surface ends the
   *  edit FIRST, before whatever was pressed acts (capture phase). */
  const onDocPress = (e: PointerEvent): void => {
    if (closed) return;
    if (e.target instanceof Node && div.contains(e.target)) return;
    if (stylingTarget(e.target)) {
      saveRange();
      return;
    }
    // A styling field still holding a typed value (the size, before Enter)
    // gives it up NOW, while the text is open, so it lands on the selected
    // part. Left to the browser's own blur after this press, its change
    // would arrive with the text closed and restyle the whole text.
    closedBy.add(e);
    const a = document.activeElement as (Element & { blur?: () => void }) | null;
    if (a && a !== div && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && stylingTarget(a) && typeof a.blur === "function") a.blur();
    close("other");
  };

  /* ---------------- styled parts: the selected range ---------------- */

  /** Every handle this editor published (the editor itself, and a fresh
   *  object each time its range or its styles change: the store ignores
   *  the same reference). */
  const mine = new WeakSet<object>();
  const republish = (): void => {
    const st = ctx.textEdit;
    const h = st?.get();
    if (!st || !h || !mine.has(h)) return;
    st.set(handle());
  };
  const publish = (r: { s: number; e: number } | null): void => {
    if (r === published || (r && published && r.s === published.s && r.e === published.e)) return;
    published = r;
    if (away) paintKept();
    republish();
  };
  /** A selection inside the text that is a range publishes it; one that
   *  collapses takes it back. A selection that LEAVES the text (focus into a
   *  styling surface) keeps it: the user is styling it. A caret with no
   *  range published costs no walk of the text. */
  function onSelChange(): void {
    if (closed) return;
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
  }

  /* ---------------- styled parts: the spans ---------------- */

  /** the spans built from the generator → their font (a DOM that still
   *  matches is left alone) */
  const spanKeys = new WeakMap<Node, string>();
  /** The pieces the text is shown as: one per style while its runs are
   *  active, else one in the base style (a right-to-left text is drawn
   *  plain, and so is laid out plain here). */
  function shownSegments(): { s: number; e: number; font: string }[] {
    const t = cur.text;
    if (activeRuns(cur)) return genSegments(cur).map((g) => ({ s: g.s, e: g.e, font: cssFont(styleGen(g.style)) }));
    return t.length > 0 ? [{ s: 0, e: t.length, font: cssFont(cur) }] : [];
  }
  /** Rebuild the spans from the generator. Text through textContent only;
   *  the glyphs stay transparent (the canvas paints the pixels). */
  function render(): void {
    while (div.firstChild) div.removeChild(div.firstChild);
    for (const g of shownSegments()) {
      const span = document.createElement("span");
      span.style.font = g.font;
      span.textContent = cur.text.slice(g.s, g.e);
      spanKeys.set(span, g.font);
      div.appendChild(span);
    }
    // a last empty line needs a line box for the caret (the walker skips it)
    if (cur.text.endsWith("\n")) div.appendChild(document.createElement("br"));
  }
  /** do the spans in the DOM still say what the generator says? */
  function domMatches(): boolean {
    const segs = shownSegments();
    const kids = Array.from(div.childNodes);
    const tail = cur.text.endsWith("\n") ? 1 : 0;
    if (kids.length !== segs.length + tail) return false;
    for (let i = 0; i < segs.length; i++) {
      const k = kids[i]!;
      const g = segs[i]!;
      if (spanKeys.get(k) !== g.font || k.childNodes.length !== 1) return false;
      const t = k.firstChild!;
      if (t.nodeType !== 3 || dataOf(t) !== cur.text.slice(g.s, g.e)) return false;
    }
    return !tail || isBr(kids[kids.length - 1]!);
  }
  const clampSel = (o: SelOffsets, len: number): SelOffsets => ({ s: Math.min(o.s, len), e: Math.min(o.e, len), backward: o.backward });
  /** rebuild the spans; the selection goes back by offset (into the text
   *  when it has focus, else kept for when it comes back) */
  function rerender(): void {
    const active = document.activeElement === div;
    const keep = active ? (readSelection(div) ?? sel) : sel;
    render();
    sel = keep ? clampSel(keep, cur.text.length) : null;
    if (active && sel) writeSelection(div, sel);
    // the old nodes are gone: a kept highlight is drawn again on the new ones
    else if (!active) paintKept();
  }

  /* ---------------- styled parts: the editor's own undo ---------------- */

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
  /** the selection just before the input being handled, and the range the
   *  input says it replaces when the engine tells */
  let pre: SelOffsets | null = null;
  let preTarget: { s: number; e: number } | null = null;

  const runsNow = (): PdfTextRun[] | undefined => normalizeRuns(cur.text, genRunBase(cur), cur.runs);
  const push = (snap: Snap, merge: boolean): void => {
    stack.length = at + 1;
    if (merge && at > 0) stack[at] = snap;
    else {
      stack.push(snap);
      at = stack.length - 1;
      if (stack.length > RICH_STEPS_MAX) {
        stack.splice(1, 1);
        at--;
      }
    }
  };
  /** after an input: one undo step per typing burst (same kind, no pause
   *  over UNDO_BURST_MS, the caret where the last input left it) */
  const record = (kind: EditKind): void => {
    const top = stack[at];
    const now = readSelection(div);
    const pr = pre;
    pre = null;
    preTarget = null;
    const runs = runsNow();
    if (!top || (top.text === cur.text && runsEqual(top.runs, runs))) return;
    const t = Date.now();
    const jumped = pr !== null && (pr.s !== pr.e || pr.e !== burstCaret);
    const merge = kind !== "other" && burst === kind && t - burstAt <= UNDO_BURST_MS && !jumped;
    push({ text: cur.text, runs, sel: now }, merge);
    burst = kind === "other" ? null : kind;
    burstAt = t;
    burstCaret = now ? now.e : -1;
  };
  /** the old-text range an input replaced, from the selection before it and
   *  its type (undefined: not known, `remapRuns` then finds it) */
  const hintFor = (inputType: string, oldLen: number, newLen: number): { s: number; e: number } | undefined => {
    if (preTarget) return preTarget;
    const pr = pre;
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
  /** what the DOM holds, as the layer takes it (the cap; tabs as spaces) */
  const domText = (): string => cutText(editorText(div, TEXT_MAX_CHARS + 2).replace(/\t/g, " "));
  /** an input landed in the DOM: the generator follows it (it wins) */
  function reconcile(kind: EditKind, inputType = ""): void {
    const next = domText();
    if (next !== cur.text) apply(withGenText(cur, next, hintFor(inputType, cur.text.length, next.length)));
    if (!domMatches()) {
      const keep = readSelection(div);
      render();
      if (keep) writeSelection(div, clampSel(keep, cur.text.length));
    }
    record(kind);
  }
  /** undo / redo inside the text: to snapshot `to` (never below the
   *  opening state). The style the text has as a whole stays. */
  function go(to: number): void {
    if (closed || composing || to < 0 || to >= stack.length || to === at) return;
    at = to;
    const s = stack[at]!;
    const g = withRunsKey({ ...cur, text: s.text }, normalizeRuns(s.text, genRunBase(cur), s.runs));
    savedRange = null;
    apply(g);
    render();
    sel = s.sel ? clampSel(s.sel, s.text.length) : { s: s.text.length, e: s.text.length, backward: false };
    if (document.activeElement === div) writeSelection(div, sel);
    burst = null;
    pre = null;
    preTarget = null;
    publish(sel.e > sel.s ? { s: sel.s, e: sel.e } : null);
  }
  /** put `str` in place of the selection THROUGH THE GENERATOR (the
   *  browser's own edit was prevented): a line break, multi-line text */
  const insertThroughModel = (str: string, kind: EditKind): void => {
    const len = cur.text.length;
    const o = preTarget ?? pre ?? sel ?? { s: len, e: len, backward: false };
    const s0 = Math.min(o.s, len);
    const e0 = Math.min(o.e, len);
    const ins = cutText(str, Math.max(0, TEXT_MAX_CHARS - (len - (e0 - s0))));
    const next = cur.text.slice(0, s0) + ins + cur.text.slice(e0);
    if (next !== cur.text) apply(withGenText(cur, next, { s: s0, e: e0 }));
    render();
    const caret: SelOffsets = { s: s0 + ins.length, e: s0 + ins.length, backward: false };
    sel = caret;
    writeSelection(div, caret);
    record(kind);
    publish(null);
  };
  /** the input's own target range as offsets, when the engine gives one */
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
  /** The styled editor's part of beforeinput: a line break and any text
   *  holding one go through the generator, never the DOM a browser would
   *  build for them. True when it handled the input. */
  function richBeforeInput(e: InputEvent): boolean {
    if (composing || e.isComposing) return false;
    const t = e.inputType;
    pre = readSelection(div);
    preTarget = targetOf(e as never);
    if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      insertThroughModel("\n", "break");
      return true;
    }
    if (t === "insertText" || t === "insertFromPaste" || t === "insertFromDrop" || t === "insertReplacementText") {
      let raw: string | null = typeof e.data === "string" ? e.data : null;
      if (raw === null) {
        try {
          const g = e.dataTransfer?.getData?.("text/plain");
          raw = typeof g === "string" ? g : null;
        } catch {
          raw = null;
        }
      }
      if (raw !== null && /[\r\n]/.test(raw)) {
        if (t === "insertFromDrop" && !preTarget) return false;
        e.preventDefault();
        insertThroughModel(raw.replace(/\r\n?/g, "\n").replace(/\t/g, " "), t === "insertText" ? "insert" : "other");
        return true;
      }
    }
    return false;
  }
  const onCompStart = (): void => {
    composing = true;
  };
  const onCompEnd = (): void => {
    composing = false;
    if (closed || !rich) return;
    pre = null;
    preTarget = null;
    reconcile("other");
  };
  /** A plain editor turns styled: spans from the generator, and the undo
   *  list starts at the opening state, then what was typed so far. */
  function goRich(): void {
    rich = true;
    div.addEventListener("compositionstart", onCompStart);
    div.addEventListener("compositionend", onCompEnd);
    const opening: Snap = {
      text: startText,
      runs: normalizeRuns(startText, genRunBase(opened), opened.runs),
      sel: null,
    };
    stack = [opening];
    at = 0;
    const runs = runsNow();
    if (cur.text !== opening.text || !runsEqual(runs, opening.runs)) push({ text: cur.text, runs, sel: readSelection(div) ?? sel }, false);
    burst = null;
    rerender();
  }

  /* ---------------- styled parts: styling ---------------- */

  const styleOf = (): TextRangeStyle => genSummary(cur, published);

  /** Style the selected part (the inspector, Ctrl+B / Ctrl+I): one step of
   *  the editor's own undo, part of the edit's one project step. Refused on
   *  a right-to-left text, and past the run cap (one notice). */
  function applyRange(patch: TextStylePatch): void {
    if (closed || composing || !published || hasStrongRtl(cur.text)) return;
    const r = published;
    const rp = runPatchOf(patch);
    if (Object.keys(rp).length === 0) return;
    const res = styleGenRangeChecked(cur, r, rp);
    if (res.refused) {
      toast.notice(TOO_MANY_STYLES);
      return;
    }
    if (res.gen === cur) return;
    if (!rich) goRich();
    const keep: SelOffsets = { s: r.s, e: r.e, backward: sel !== null && sel.s === r.s && sel.e === r.e ? sel.backward : false };
    apply(res.gen);
    sel = keep;
    render();
    if (document.activeElement === div) writeSelection(div, keep);
    else paintKept();
    push({ text: cur.text, runs: runsNow(), sel: keep }, false);
    burst = null;
    // the inspector re-reads styleOf
    republish();
  }

  /** A whole-text style while styled: the changed properties leave every
   *  run, in the undo list too, and the spans follow. */
  function restyleWhole(g: TextGen): void {
    if (!rich) {
      apply(g);
      return;
    }
    const fields = changedRunFields(cur, g);
    if (fields.length > 0) {
      const base = genRunBase(g);
      stack = stack.map((x) => ({ ...x, runs: clearRunFields(base, x.runs, fields) }));
    }
    apply(g);
    if (!composing) rerender();
    republish();
  }

  function handle(): TextEditHandle {
    const h: TextEditHandle = {
      trackId,
      restyle: (p) => editor.restyle(p),
      commit: () => editor.commit(),
      refocus: () => editor.refocus(),
      range: published,
      applyRange,
      styleOf,
    };
    mine.add(h);
    return h;
  }

  div.addEventListener("input", onInput);
  div.addEventListener("beforeinput", onBeforeInput);
  document.addEventListener("selectionchange", onSelChange);
  div.addEventListener("keydown", onKeyDown);
  div.addEventListener("focusout", onFocusOut);
  div.addEventListener("focus", onFocusIn);
  document.addEventListener("pointerdown", onDocPress, true);

  const openTool = ctx.tools.get().tool;
  const unsubs = [
    ctx.view.store.subscribe(() => {
      shownMatrix = "";
      place();
    }),
    session.store.subscribe(() => {
      if (closed) return;
      // A write that took no step of its own (history writes are wrapped
      // below): the edit lands on top of it.
      if (foreign()) {
        close("other");
        return;
      }
      place();
    }),
    ctx.selection.subscribe((id) => {
      if (id !== trackId) close("other");
    }),
    ctx.mode.subscribe((m) => {
      if (m !== "idle") close("other");
    }),
    // Another tool taken up (a chord while focus is in a styling surface):
    // the edit lands. A change of the tool's own settings (the tool row's
    // font) is not a change of tool.
    ctx.tools.subscribe((s) => {
      if (s.tool !== openTool) close("other");
    }),
  ];

  // A history write while the text is open lands the edit FIRST, so the step
  // it records goes back to a project that already holds the text, and one
  // undo after it takes back the text alone.
  type Wrapped = "commit" | "undo" | "redo";
  const methods = session as unknown as Record<Wrapped, (...a: unknown[]) => unknown>;
  const unwrap: (() => void)[] = [];
  for (const k of ["commit", "undo", "redo"] as const) {
    const own = Object.prototype.hasOwnProperty.call(methods, k);
    const orig = methods[k];
    const guarded = (...a: unknown[]): unknown => {
      close("other");
      return orig.apply(session, a);
    };
    methods[k] = guarded;
    unwrap.push(() => {
      if (methods[k] !== guarded) return;
      if (own) methods[k] = orig;
      else delete (methods as Partial<Record<Wrapped, unknown>>)[k];
    });
  }

  const teardown = (): void => {
    closed = true;
    for (const u of unwrap) u();
    for (const u of unsubs) u();
    div.removeEventListener("input", onInput);
    div.removeEventListener("beforeinput", onBeforeInput);
    div.removeEventListener("keydown", onKeyDown);
    div.removeEventListener("focusout", onFocusOut);
    div.removeEventListener("focus", onFocusIn);
    div.removeEventListener("compositionstart", onCompStart);
    div.removeEventListener("compositionend", onCompEnd);
    document.removeEventListener("pointerdown", onDocPress, true);
    document.removeEventListener("selectionchange", onSelChange);
    away = false;
    clearKept();
    stack = [];
    // A handle published for a range is not the editor itself: it is taken
    // back here (the owner of the store takes back the editor).
    const shown = ctx.textEdit?.get();
    if (shown && shown !== editor && mine.has(shown)) ctx.textEdit!.set(null);
    // A focused node removed hands the keyboard back to <body>: the next
    // tool chord (Escape to Select, V, a zoom) works at once.
    div.remove();
  };

  let closeHow: CloseHow = "other";
  function close(how: CloseHow): void {
    if (closed) return;
    closeHow = how;
    const mine = !foreign();
    teardown();
    // A write still waiting for its font: what was typed lands now, measured
    // with whatever font the canvas has, and measured again when the font
    // arrives (lateMeasure).
    if (pending) {
      const b = measureText(cur);
      session.replace(setTextGen(session.project, trackId, cur, b.width, b.height), writeOpts);
      landedEarly = genOf(session.project, trackId);
    }
    land(mine);
    o.onClose(closeHow);
  }

  /** `mine`: the project is still the one this editor last wrote. */
  function land(mine: boolean): void {
    const g = genOf(session.project, trackId);
    const empty = g === null || g.text.trim() === "";
    if (empty) {
      if (o.isNew) {
        // Never placed, as far as the history and the close prompt know.
        // Under another writer's fix-up, only the layer goes.
        landedEarly = null;
        session.replace(mine ? before : removeLayer(session.project, trackId), { edit: false });
        const prev = o.prevSelection;
        ctx.selection.set(prev !== null && findLayer(session.project, prev) ? prev : null);
        return;
      }
      // Removed only when the user emptied it: a layer that was blank to
      // begin with and merely opened stays as it was.
      if (g !== null && g.text !== startText) session.replace(removeLayer(session.project, trackId));
    }
    if (!sameEdit(session.project, before)) session.commitFrom(before);
  }

  function leave(): void {
    if (closed) return;
    teardown();
    o.onClose("other");
  }

  // A text that already has styled parts opens as spans.
  if (Array.isArray(start.runs) && start.runs.length > 0) goRich();
  div.focus({ preventScroll: true });
  placeCaret(div, o.caret);

  const editor: TextEditor = {
    trackId,
    get closed() {
      return closed;
    },
    contains: (t) => t instanceof Node && div.contains(t),
    get range() {
      return published;
    },
    applyRange,
    styleOf,
    restyle(patch: TextStylePatch): void {
      if (closed) return;
      // With a part selected, a control outside the inspector (the tool
      // row's font) styles that part, as the inspector does; it never
      // replaces the parts' own styles with the whole text's. A right-to-left
      // text has no part styling yet: the whole text takes it.
      if (published && !hasStrongRtl(cur.text)) {
        applyRange(patch);
        return;
      }
      const g = applyTextStyle(cur, patch);
      if (g !== cur) restyleWhole(g);
    },
    commit(): void {
      close("other");
    },
    refocus(): void {
      if (closed) return;
      // After the current task: a font list or a colour picker that closes
      // right after its pick hands focus back to its own control first, and
      // the text must be the last thing to take it.
      window.setTimeout(() => {
        if (closed) return;
        if (document.activeElement !== div) div.focus({ preventScroll: true });
        // the native selection takes over from the kept highlight
        onFocusIn();
        const r = savedRange;
        savedRange = null;
        if (rich) {
          // spans may have been rebuilt meanwhile: back by offset
          if (sel) writeSelection(div, clampSel(sel, cur.text.length));
          return;
        }
        if (!r) return;
        try {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(r);
        } catch {
          /* the range went stale: the caret stays where focus put it */
        }
      }, 0);
    },
    leave,
  };
  mine.add(editor);
  return editor;
}

/** Presses that closed an editor: the Text tool reads it so the same press
 *  does not open a new text (a click away only finishes the edit). */
export const closedBy = new WeakSet<Event>();
