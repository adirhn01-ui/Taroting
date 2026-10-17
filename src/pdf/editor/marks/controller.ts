// The PDF editor's pointer and keyboard for marks. ONE capture-phase
// pointerdown on the page strip decides who owns a press:
//   - Fill forms mode: nobody here (form widgets own the pointer);
//   - the ruler, when the press lands on it;
//   - the active tool (draw.ts, select.ts, text.ts, edit-tool.ts, the armed
//     signature). Text, Shapes, Whiteout and Highlight also act on a mark OF
//     THEIR OWN KIND under the press (and on the selection's handles): it is
//     selected and moved (or resized) instead of a new one being drawn. With
//     Text, a click on a box types in it, caret where clicked;
//   - with Select or Highlight, a press on a text-layer span (or a form
//     widget / link) is left to the browser, so native text selection works —
//     Highlight then turns that selection into marks on release.
// Any press on a page also clears the page panel's selection (the inspector
// shows what was touched last). Copy / paste / duplicate (clipboard.ts) and
// Delete act on the selected marks whatever the tool.
// A started gesture captures the pointer, holds autosave until it ends, and
// paints at most once per frame. Nothing runs at rest: no timer, no frame
// loop; listeners return on a compare when idle.
//
// The text layer follows the tool: ON for Select and Highlight (and in Fill
// forms mode), OFF while any other tool owns the pointer.

import type { PdfAnnot, PdfRotation, PdfSignature } from "../../../core/types";
import type { PdfToolId } from "../../types";
import { normalizeHexColor } from "../../../core/session";
import { shortcutsBlocked } from "../../../core/shortcuts";
import { PalmFilter } from "../../../image/ink/input";
import { addAnnot, newId, pageAnnots, removeAnnots, translateAnnot, updateAnnot, type PdfAnnotPatch } from "../../model";
import type { PdfEditorCtx } from "../../types";
import type { Env, Gesture } from "./env";
import {
  DRAG_CSS,
  HANDLE_REACH_CSS,
  HIT_CSS,
  handleBox,
  moveGesture,
  onNativeTarget,
  paintChrome,
  resizeGesture,
  selectedMarks,
  startRuler,
  startSelect,
  type SelRef,
} from "./select";
import { highlightSelection, startBox, startEraser, startInk, startShape } from "./draw";
import { boxForFrame, boxPoints, clampFont, geometryPatch, handleAt, onBoxEdge, rotField, screenToPageDelta, stepSize, topmostAt } from "./geom";
import type { MarkLayer, PageInfo } from "./layer";
import { openTextEditor, type CaretAt, type TextEditor } from "./text";
import { copyMarks, duplicateMarks, pasteMarks } from "./clipboard";
import { createEditTextTool } from "./edit-tool";

/** A placed signature's default width, points (aspect kept). */
export const SIGNATURE_W = 160;

/**
 * A placed signature's box, centred on the click (x, y): SIGNATURE_W wide ON
 * SCREEN at its aspect — upright on a page shown turned (`r`, see geom.ts) —
 * scaled down (aspect kept) to fit the page, and kept on it. Pure.
 */
export function signatureBox(
  info: PageInfo | null,
  x: number,
  y: number,
  aspect: number,
): { x: number; y: number; w: number; h: number; r?: PdfRotation } {
  const rot = info?.rot ?? 0;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  let W = SIGNATURE_W;
  let H = W / a;
  if (info) {
    const shown = boxPoints(info.w, info.h, rot);
    const k = Math.min(1, shown.W / W, shown.H / H);
    W *= k;
    H *= k;
  }
  const { w, h } = boxForFrame(W, H, rot);
  let bx = x - w / 2;
  let by = y - h / 2;
  if (info) {
    bx = Math.max(0, Math.min(bx, info.w - w));
    by = Math.max(0, Math.min(by, info.h - h));
  }
  return { x: bx, y: by, w, h, ...rotField(rot) };
}

/** Is a key event's target a form control (or inside the inspector), where
 *  arrow keys belong to the control? Duck-typed (no HTMLElement in tests). */
function onFormControl(target: EventTarget | null): boolean {
  const t = target as { tagName?: unknown; closest?: (s: string) => unknown } | null;
  if (!t) return false;
  const tag = typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return true;
  return typeof t.closest === "function" && !!t.closest(".inspector");
}

/** Is a modal dialog open (the Export dialog, the signature pad)? */
function modalOpen(): boolean {
  return typeof document !== "undefined" && !!document.querySelector(".modal-backdrop");
}

/** Does this tool want the text layer (native text selection)? Edit text
 *  keeps it too: its picking may read the page's text spans. */
export function wantsTextLayer(tool: PdfToolId, mode: "annotate" | "forms"): boolean {
  return mode === "forms" || tool === "select" || tool === "highlight" || tool === "edittext";
}

/** The marks a tool acts on directly (select / move / resize) instead of
 *  drawing a new one over them; null: none. */
export function ownKind(tool: PdfToolId): ((a: PdfAnnot) => boolean) | null {
  switch (tool) {
    case "text":
      return (a) => a.t === "text";
    case "shape":
      return (a) => a.t === "line" || a.t === "arrow" || a.t === "rect" || a.t === "ellipse";
    case "whiteout":
      return (a) => a.t === "whiteout";
    case "highlight":
      return (a) => a.t === "highlight";
    default:
      return null;
  }
}

/** Pick a tool (a tool button, its shortcut): the tool's panel comes back,
 *  so the page panel's and the marks' selections give way (also when the
 *  tool was already the active one). */
export function pickTool(ctx: PdfEditorCtx, tool: PdfToolId): void {
  if (ctx.pageSelection.get().length) ctx.pageSelection.set([]);
  if (ctx.selection.get().length) ctx.selection.set([]);
  ctx.tools.update((s) => (s.tool === tool ? s : { ...s, tool }));
}

/** How far INSIDE a text box being typed in its frame can still be grabbed
 *  (screen px); outside it reaches HANDLE_REACH_CSS. */
export const EDGE_IN_CSS = 1;

/** Copy the page text the user selected (Ctrl+C with no marks selected: the
 *  bound chord took the browser's own copy away). */
function copyPageText(): void {
  try {
    const text = typeof window !== "undefined" && typeof window.getSelection === "function" ? (window.getSelection()?.toString() ?? "") : "";
    if (text && typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {});
  } catch {
    /* nothing to copy */
  }
}

/** The cursor class a tool puts on the strip. */
export function cursorClass(tool: PdfToolId): string | null {
  switch (tool) {
    case "pen":
    case "pencil":
    case "marker":
    case "eraser":
      return "pdfmk-cur-brush";
    case "shape":
    case "whiteout":
    case "signature":
      return "pdfmk-cur-cross";
    case "text":
    case "highlight":
    case "edittext":
      return "pdfmk-cur-text";
    default:
      return null;
  }
}

const BRUSH_TOOLS: ReadonlySet<PdfToolId> = new Set(["pen", "pencil", "marker", "eraser"]);

export interface MarkTools {
  /** arm a click-to-place signature (switches to the Signature tool) */
  armSignature(sig: PdfSignature): void;
  readonly armed: PdfSignature | null;
  toggleRuler(): void;
  /** the page key the view shows as current (where an inserted picture goes) */
  currentKey(): string | null;
  /** remove the selected marks (one step); false when none */
  deleteSelection(): boolean;
  dispose(): void;
}

export function mountMarkTools(ctx: PdfEditorCtx, layer: MarkLayer): MarkTools {
  const { view, session } = ctx;
  let disposed = false;
  const cleanup: (() => void)[] = [];
  const palm = new PalmFilter();
  let gesture: Gesture | null = null;
  let pointerId = -1;
  let releaseHold: (() => void) | null = null;
  let editor: TextEditor | null = null;
  let armed: PdfSignature | null = null;
  let pendingHighlight = false;

  /* ---------- frame coalescing ---------- */
  const queue = new Set<() => void>();
  let rafId = 0;
  const raf = (fn: () => void): number =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number);
  const caf = (id: number): void => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    else clearTimeout(id);
  };
  const flushFrame = (): void => {
    rafId = 0;
    const fns = [...queue];
    queue.clear();
    for (const fn of fns) fn();
  };

  const env: Env = {
    ctx,
    layer,
    zoom: () => {
      const z = view.state.get().zoom;
      return z > 0 && Number.isFinite(z) ? z : 1;
    },
    pt: (key, e) => view.clientToPageOf(key, e.clientX, e.clientY),
    frame(fn) {
      queue.add(fn);
      if (!rafId) rafId = raf(flushFrame);
    },
  };

  /* ---------- gesture plumbing ---------- */

  const onMove = (e: PointerEvent): void => {
    if (gesture && e.pointerId === pointerId) gesture.move(e);
  };
  const onUp = (e: PointerEvent): void => {
    if (!gesture || e.pointerId !== pointerId) return;
    const g = finish();
    g.up(e);
    releaseHold?.();
    releaseHold = null;
  };
  const onCancel = (e: PointerEvent): void => {
    if (!gesture || e.pointerId !== pointerId) return;
    cancelGesture();
  };

  /** Detach the running gesture's listeners and capture; returns it. */
  function finish(): Gesture {
    const g = gesture!;
    gesture = null;
    view.el.removeEventListener("pointermove", onMove);
    view.el.removeEventListener("pointerup", onUp);
    view.el.removeEventListener("pointercancel", onCancel);
    view.el.removeEventListener("lostpointercapture", onCancel);
    try {
      if (view.el.hasPointerCapture?.(pointerId)) view.el.releasePointerCapture(pointerId);
    } catch {
      /* synthetic ids throw */
    }
    pointerId = -1;
    return g;
  }

  function cancelGesture(): void {
    if (!gesture) return;
    const g = finish();
    g.cancel();
    releaseHold?.();
    releaseHold = null;
  }

  function begin(g: Gesture, e: PointerEvent): void {
    gesture = g;
    pointerId = e.pointerId;
    releaseHold = ctx.holdAutosave();
    view.el.addEventListener("pointermove", onMove);
    view.el.addEventListener("pointerup", onUp);
    view.el.addEventListener("pointercancel", onCancel);
    view.el.addEventListener("lostpointercapture", onCancel);
    try {
      view.el.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic ids throw */
    }
  }

  /* ---------- the text editor ---------- */

  function editText(key: string, target: { id: string } | { at: { x: number; y: number } }, caret: CaretAt = "end"): void {
    editor?.commit();
    const ed = openTextEditor(
      env,
      key,
      target,
      (id, how) => {
        if (editor === ed) editor = null;
        if (disposed) return;
        // Escape / Ctrl+Enter: the box stays selected
        if (how === "key" && id) ctx.selection.set([{ key, id }]);
        repaintChrome();
      },
      caret,
    );
    editor = ed;
    // an existing box being typed in is the selected mark (its panel shows)
    if (ed?.id) ctx.selection.set([{ key, id: ed.id }]);
    else if (ed && ctx.selection.get().length) ctx.selection.set([]);
    repaintChrome();
  }

  /** A press on a mark of the active tool's own kind (or on the selection's
   *  handles): select + move / resize it. Text: a click without a drag types
   *  in the box, caret where clicked. Null: the press is not on one. */
  function ownKindPress(e: PointerEvent, key: string, match: (a: PdfAnnot) => boolean, typeOnClick: boolean): Gesture | null {
    const at = env.pt(key, e);
    if (!at) return null;
    const zoom = env.zoom();
    const before = session.project;
    const hb = handleBox(before, ctx.selection.get());
    if (hb && hb.key === key) {
      const h = handleAt(hb.box, at.x, at.y, HANDLE_REACH_CSS / zoom);
      if (h) return resizeGesture(env, key, hb.box, h, before);
    }
    const on = topmostAt(pageAnnots(before, key).filter(match), at.x, at.y, HIT_CSS / zoom);
    if (!on) return null;
    if (!ctx.selection.get().some((r) => r.key === key && r.id === on.id)) ctx.selection.set([{ key, id: on.id }]);
    const mg = moveGesture(env, key, at, before);
    if (!typeOnClick) return mg;
    let dragged = false;
    return {
      move(ev) {
        const q = env.pt(key, ev);
        if (q && Math.hypot(q.x - at.x, q.y - at.y) * zoom >= DRAG_CSS) dragged = true;
        mg.move(ev);
      },
      up(ev) {
        mg.up(ev);
        if (!dragged && !disposed && ctx.tools.get().tool === "text") editText(key, { id: on.id }, { clientX: ev.clientX, clientY: ev.clientY });
      },
      cancel: () => mg.cancel(),
    };
  }

  /* ---------- pointer-down: who owns this press ---------- */

  const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const editTool = createEditTextTool(
    env,
    (key, id) => editText(key, { id }, "end"),
    () => !disposed && !editor && !gesture,
  );
  cleanup.push(() => editTool.dispose());

  const onDown = (e: PointerEvent): void => {
    if (disposed) return;
    palm.note(e.pointerType, now());
    // defaultPrevented: someone ahead of us took this press (the shell's
    // hold-to-pan listens in the capture phase on the same element)
    if (ctx.mode.get() === "forms" || e.button !== 0 || gesture || e.defaultPrevented) return;
    const hit = view.clientToPage(e.clientX, e.clientY);
    // a press on the pages: the inspector follows it, not the page panel
    if (hit && ctx.pageSelection.get().length) ctx.pageSelection.set([]);
    const tool = ctx.tools.get().tool;
    if (editor) {
      // the box being typed in: its handles resize it, its frame edge moves it
      if (tool === "text") {
        const key = editor.key;
        const at = env.pt(key, e);
        const box = editor.box();
        const reach = HANDLE_REACH_CSS / env.zoom();
        const h = at ? handleAt(box, at.x, at.y, reach) : null;
        // grabbed from just outside the frame (or on its line): inside it, a
        // click is for the caret
        if (at && (h || onBoxEdge(box, at.x, at.y, reach, EDGE_IN_CSS / env.zoom()))) {
          e.preventDefault();
          const id = editor.commit();
          if (!id) return;
          ctx.selection.set([{ key, id }]);
          const before = session.project;
          let g: Gesture | null = null;
          if (h) {
            const hb = handleBox(before, ctx.selection.get());
            if (hb) g = resizeGesture(env, key, hb.box, h, before);
          } else {
            g = moveGesture(env, key, at, before);
          }
          if (g) begin(g, e);
          return;
        }
      }
      if (editor.contains(e.target)) return;
      // a click away commits the edit. With Text it goes on to place the next
      // box (or open the one clicked); with any other tool it is only that.
      editor.commit();
      if (tool !== "text") {
        e.preventDefault();
        return;
      }
    }
    if (!palm.mayDraw(e.pointerType, now())) return;
    if (!hit) return;
    const key = hit.key;
    editTool.clear();

    let g: Gesture | null = startRuler(env, e, key);
    if (!g) {
      const own = ownKind(tool);
      if (own && !(tool === "highlight" && e.altKey)) {
        g = ownKindPress(e, key, own, tool === "text");
        // not on one of its own: a press elsewhere lets the selection go
        if (!g && ctx.selection.get().length) ctx.selection.set([]);
      }
    }
    if (!g) {
      switch (tool) {
        case "select":
          g = startSelect(env, e, key);
          break;
        case "pen":
        case "pencil":
        case "marker":
          g = startInk(env, e, key, tool);
          break;
        case "eraser":
          g = startEraser(env, e, key);
          break;
        case "shape":
          g = startShape(env, e, key);
          break;
        case "whiteout":
          g = startBox(env, e, key, "whiteout");
          break;
        case "highlight":
          if (onNativeTarget(e.target) && !e.altKey) {
            // the browser selects the text; release turns it into marks
            pendingHighlight = true;
            return;
          }
          g = startBox(env, e, key, "highlight");
          break;
        case "text":
          e.preventDefault();
          editText(key, { at: { x: hit.x, y: hit.y } });
          return;
        case "edittext":
          g = editTool.start(e, key);
          break;
        case "signature":
          if (armed) {
            e.preventDefault();
            placeSignature(key, hit.x, hit.y, armed);
          }
          return;
        default:
          return;
      }
    }
    if (!g) return;
    e.preventDefault();
    begin(g, e);
  };
  view.el.addEventListener("pointerdown", onDown, true);
  cleanup.push(() => view.el.removeEventListener("pointerdown", onDown, true));

  // Double-click a text mark with Select: edit it in place. (A dblclick, not
  // pointerdown's `detail`, which PointerEvents need not carry.)
  const onDblClick = (e: MouseEvent): void => {
    if (disposed || editor || gesture || ctx.mode.get() === "forms" || ctx.tools.get().tool !== "select") return;
    const hit = view.clientToPage(e.clientX, e.clientY);
    if (!hit) return;
    const on = topmostAt(pageAnnots(session.project, hit.key), hit.x, hit.y, HIT_CSS / env.zoom());
    if (!on || on.t !== "text") return;
    e.preventDefault();
    ctx.selection.set([{ key: hit.key, id: on.id }]);
    editText(hit.key, { id: on.id });
  };
  view.el.addEventListener("dblclick", onDblClick);
  cleanup.push(() => view.el.removeEventListener("dblclick", onDblClick));

  // Highlight from a text selection: the release may land anywhere.
  const onDocUp = (): void => {
    if (!pendingHighlight) return;
    pendingHighlight = false;
    if (ctx.tools.get().tool === "highlight" && ctx.mode.get() === "annotate") highlightSelection(env);
  };
  document.addEventListener("pointerup", onDocUp);
  cleanup.push(() => document.removeEventListener("pointerup", onDocUp));

  function placeSignature(key: string, x: number, y: number, sig: PdfSignature): void {
    const info = layer.info(key);
    const box = signatureBox(info, x, y, sig.aspect);
    const c = normalizeHexColor(ctx.tools.get().colors.pen, "#000000");
    const id = newId();
    const before = session.project;
    session.commit((p) => addAnnot(p, key, { id, t: "signature", ...box, c, strokes: [...sig.strokes] }));
    if (session.project !== before) {
      armed = null;
      ctx.tools.update((s) => ({ ...s, tool: "select" }));
      ctx.selection.set([{ key, id }]);
    }
  }

  /* ---------- the brush circle ---------- */

  const brush = document.createElement("div");
  brush.className = "pdfmk-brush";
  brush.hidden = true;
  document.body.appendChild(brush);
  cleanup.push(() => brush.remove());
  let brushSize = -1;
  const onHover = (e: PointerEvent): void => {
    const s = ctx.tools.get();
    if (s.tool === "edittext" && !gesture && !editor) editTool.hover(e);
    if (!BRUSH_TOOLS.has(s.tool) || ctx.mode.get() === "forms" || !view.clientToPage(e.clientX, e.clientY)) {
      if (!brush.hidden) brush.hidden = true;
      return;
    }
    const size = s.sizes[s.tool as "pen"];
    if (size !== brushSize) {
      brushSize = size;
      brush.style.width = `${size}px`;
      brush.style.height = `${size}px`;
    }
    brush.style.transform = `translate(${e.clientX - size / 2}px, ${e.clientY - size / 2}px)`;
    if (brush.hidden) brush.hidden = false;
  };
  const onLeave = (): void => {
    if (!brush.hidden) brush.hidden = true;
    editTool.clear();
  };
  view.el.addEventListener("pointermove", onHover);
  view.el.addEventListener("pointerleave", onLeave);
  cleanup.push(() => {
    view.el.removeEventListener("pointermove", onHover);
    view.el.removeEventListener("pointerleave", onLeave);
  });

  /* ---------- tool / mode side effects ---------- */

  let lastTool: PdfToolId | null = null;
  let lastText: boolean | null = null;
  let lastCursor: string | null = null;
  let lastMode = ctx.mode.get();
  const sync = (): void => {
    if (disposed) return;
    const s = ctx.tools.get();
    const mode = ctx.mode.get();
    if (mode !== lastMode) {
      lastMode = mode;
      if (mode === "forms") {
        cancelGesture();
        editor?.commit();
        armed = null;
        if (ctx.selection.get().length) ctx.selection.set([]);
      }
    }
    if (s.tool !== lastTool) {
      const prev = lastTool;
      lastTool = s.tool;
      if (prev === "text" || s.tool !== "select") editor?.commit();
      if (s.tool !== "select" && ctx.selection.get().length) ctx.selection.set([]);
      if (s.tool !== "signature") armed = null;
      pendingHighlight = false;
      editTool.clear();
      if (!BRUSH_TOOLS.has(s.tool)) brush.hidden = true;
    }
    const text = wantsTextLayer(s.tool, mode);
    if (text !== lastText) {
      lastText = text;
      view.setTextLayer(text);
    }
    const cur = mode === "forms" ? null : cursorClass(s.tool);
    if (cur !== lastCursor) {
      if (lastCursor) view.el.classList.remove(lastCursor);
      if (cur) view.el.classList.add(cur);
      view.el.classList.toggle("pdfmk-draw", cur !== null && cur !== "pdfmk-cur-text");
      lastCursor = cur;
    }
  };
  cleanup.push(ctx.tools.subscribe(sync), ctx.mode.subscribe(sync));
  cleanup.push(() => {
    if (lastCursor) view.el.classList.remove(lastCursor);
    view.el.classList.remove("pdfmk-draw");
  });
  sync();

  /* ---------- chrome (selection + ruler) ---------- */

  let chromeShown = false;
  let lastRuler = ctx.tools.get().ruler;
  let chromeTool = ctx.tools.get().tool;
  const repaintChrome = (): void => {
    if (disposed) return;
    const want = ctx.selection.get().length > 0 || ctx.tools.get().ruler !== null;
    if (!want && !chromeShown) return;
    chromeShown = want;
    const tool = ctx.tools.get().tool;
    // handles only where a press on them resizes: Select and the tools that
    // act on their own kind
    paintChrome(env, tool === "select" || ownKind(tool) !== null, editor?.id ?? null);
    editor?.refresh();
  };
  cleanup.push(ctx.selection.subscribe(repaintChrome));
  cleanup.push(
    ctx.tools.subscribe((s) => {
      if (s.ruler !== lastRuler || s.tool !== chromeTool) {
        lastRuler = s.ruler;
        chromeTool = s.tool;
        repaintChrome();
      }
    }),
  );
  cleanup.push(view.on("layout", repaintChrome));
  // Fill forms mode hides the ruler (paintChrome skips it) and leaving the
  // mode shows it again where it was
  let chromeMode = ctx.mode.get();
  cleanup.push(
    ctx.mode.subscribe((m) => {
      if (m === chromeMode) return;
      chromeMode = m;
      repaintChrome();
    }),
  );
  cleanup.push(
    layer.onFrame((key, f) => {
      if (!f && editor && editor.key === key) editor.commit();
      if (f) {
        chromeShown = true;
        repaintChrome();
      }
    }),
  );

  // the project changed: drop selected marks that are gone, redraw the chrome
  cleanup.push(
    session.store.subscribe((p) => {
      const sel = ctx.selection.get();
      if (sel.length) {
        const live = selectedMarks(p, sel);
        if (live.length !== sel.length) ctx.selection.set(live.map((m) => ({ key: m.key, id: m.a.id })));
      }
      const r = ctx.tools.get().ruler;
      if (r && !p.pdf?.pages.some((pg) => pg.id === r.key)) ctx.tools.update((s) => ({ ...s, ruler: null }));
      repaintChrome();
    }),
  );

  /* ---------- keyboard ---------- */

  const blocked = (): boolean => disposed || ctx.mode.get() === "forms";

  function deleteSelection(): boolean {
    const sel = ctx.selection.get();
    // the box being typed in owns its keys, wherever focus went
    if (!sel.length || editor) return false;
    session.commit((p) => removeAnnots(p, sel.map((r) => ({ pageId: r.key, id: r.id }))));
    ctx.selection.set([]);
    return true;
  }

  /** Move the selection by a SCREEN step: each mark's page turns it into its
   *  own page-space step, so Right moves right on screen on a turned page. */
  function nudge(sel: readonly SelRef[], dx: number, dy: number): void {
    session.commit((p) => {
      let next = p;
      for (const m of selectedMarks(p, sel)) {
        const d = screenToPageDelta(dx, dy, layer.info(m.key)?.rot ?? 0);
        next = updateAnnot(next, m.key, m.a.id, geometryPatch(translateAnnot(m.a, d.x, d.y)) as PdfAnnotPatch);
      }
      return next;
    });
  }

  const onKey = (e: KeyboardEvent): void => {
    if (blocked() || e.defaultPrevented || ctx.isTyping(e.target) || shortcutsBlocked() || modalOpen()) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const sel = ctx.selection.get();
    if (e.key === "Escape") {
      if (armed) {
        armed = null;
        ctx.tools.update((s) => ({ ...s, tool: "select" }));
        e.preventDefault();
      } else if (sel.length) {
        ctx.selection.set([]);
        e.preventDefault();
      }
      return;
    }
    // a focused slider / select / button owns its arrow keys
    if (!sel.length || onFormControl(e.target)) return;
    const step = e.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    nudge(sel, dx, dy);
  };
  document.addEventListener("keydown", onKey);
  cleanup.push(() => document.removeEventListener("keydown", onKey));

  const setTool = (tool: PdfToolId): void => {
    if (blocked()) return;
    pickTool(ctx, tool);
  };
  const bind = (a: Parameters<PdfEditorCtx["bindKey"]>[0], fn: (e: KeyboardEvent) => void): void => {
    cleanup.push(ctx.bindKey(a, fn));
  };
  bind("imgSelect", () => setTool("select"));
  bind("imgPen", () => setTool("pen"));
  bind("imgPencil", () => setTool("pencil"));
  bind("imgMarker", () => setTool("marker"));
  bind("imgEraser", () => setTool("eraser"));
  bind("imgShape", () => setTool("shape"));
  bind("pdfHighlight", () => setTool("highlight"));
  bind("pdfText", () => setTool("text"));
  bind("pdfWhiteout", () => setTool("whiteout"));
  bind("pdfEditText", () => setTool("edittext"));
  bind("imgRuler", () => {
    if (!blocked()) toggleRuler();
  });
  const resize = (up: boolean): void => {
    if (blocked()) return;
    ctx.tools.update((s) => {
      const t = s.tool;
      if (t === "text") {
        const v = clampFont(s.sizes.text + (up ? 1 : -1));
        return v === s.sizes.text ? s : { ...s, sizes: { ...s.sizes, text: v } };
      }
      if (t === "pen" || t === "pencil" || t === "marker" || t === "eraser" || t === "shape") {
        const v = stepSize(s.sizes[t], up);
        return v === s.sizes[t] ? s : { ...s, sizes: { ...s.sizes, [t]: v } };
      }
      return s;
    });
  };
  bind("imgSizeDown", () => resize(false));
  bind("imgSizeUp", () => resize(true));
  // marks only: the page rail deletes pages itself while it has focus
  bind("delete", () => {
    if (!blocked()) deleteSelection();
  });
  bind("copy", () => {
    if (!blocked() && !editor && copyMarks(ctx)) return;
    copyPageText();
  });
  bind("paste", () => {
    if (!blocked() && !editor) pasteMarks(ctx, layer, currentKey());
  });
  bind("duplicate", () => {
    if (!blocked() && !editor) duplicateMarks(ctx, layer);
  });

  function currentKey(): string | null {
    const pages = session.project.pdf?.pages ?? [];
    const i = Math.min(Math.max(view.state.get().current, 0), pages.length - 1);
    return pages[i]?.id ?? null;
  }

  function toggleRuler(): void {
    const r = ctx.tools.get().ruler;
    if (r) {
      ctx.tools.update((s) => ({ ...s, ruler: null }));
      return;
    }
    const key = currentKey();
    if (!key) return;
    const info = layer.info(key);
    const w = info?.w ?? 612;
    const h = info?.h ?? 792;
    // level on screen whatever the page's turn
    const angle = info && info.rot ? -info.rot : 0;
    ctx.tools.update((s) => ({ ...s, ruler: { key, cx: w / 2, cy: h / 2, angle } }));
  }

  return {
    armSignature(sig) {
      if (blocked()) return;
      armed = sig;
      ctx.tools.update((s) => (s.tool === "signature" ? s : { ...s, tool: "signature" }));
    },
    get armed() {
      return armed;
    },
    toggleRuler,
    currentKey,
    deleteSelection,
    dispose() {
      if (disposed) return;
      cancelGesture();
      editor?.commit();
      disposed = true;
      if (rafId) caf(rafId);
      rafId = 0;
      queue.clear();
      for (const fn of cleanup.splice(0)) fn();
    },
  };
}
