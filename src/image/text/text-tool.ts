// The image editor's Text tool: click on the canvas to place a text layer and
// type into it; click a text layer to type in it again. Owns the one in-place
// editor (text-edit.ts) whichever way it was opened — the tool, a double-click
// with Select, the inspector's Edit text, or Layers → Add → Text — and
// publishes it on `ctx.textEdit` so the inspector restyles the open text.
//
// Zero overhead at rest: the pointer surface exists only while the Text tool is
// in hand, and nothing runs until a press.

import { shortcutsBlocked } from "../../core/shortcuts";
import type { Store } from "../../core/store";
import { measureText } from "../../editor/media/generators";
import type { ImageEditorCtx, TextEditHandle } from "../context";
import { hitLayer } from "../geom";
import { addTextLayer, findLayer, layersOf, opacityOf, type Layer } from "../layers";
import { closedBy, openTextEditor, type CaretAt, type TextEditor } from "./text-edit";
import { newTextGen } from "./text-style";
import "./text.css";

const modalOpen = (): boolean => document.querySelector(".modal-backdrop") !== null;

/** The topmost visible text layer under canvas point (x, y), or null. Hidden
 *  and 0% layers are never typed into: nobody can see what lands there. */
export function textLayerAt(layers: readonly Layer[], W: number, H: number, x: number, y: number): Layer | null {
  for (const l of layers) {
    if (l.kind !== "text" || l.hidden || opacityOf(l) <= 0) continue;
    const w = l.media.width;
    const h = l.media.height;
    if (!w || !h) continue;
    if (hitLayer(l.transform, w, h, W, H, x, y)) return l;
  }
  return null;
}

export interface TextTool {
  /** A new text layer at canvas point `at` (null: the middle of what the
   *  stage shows), open for typing. False when refused. */
  begin(at: { x: number; y: number } | null): boolean;
  /** Text layer `trackId` open for typing. False when it cannot be. */
  edit(trackId: string, caret?: CaretAt): boolean;
  /** Land the open edit now, if any (the window is closing). */
  commit(): void;
  dispose(): void;
}

export function mountTextTool(ctx: ImageEditorCtx, textEdit: Store<TextEditHandle | null>): TextTool {
  const { session, tools, view, stage, selection, mode } = ctx;
  let disposed = false;
  let editor: TextEditor | null = null;

  const refused = (): boolean => disposed || mode.get() !== "idle" || modalOpen();

  const open = (trackId: string, isNew: boolean, before: typeof session.project, prevSelection: string | null, caret: CaretAt): boolean => {
    const ed = openTextEditor({
      ctx,
      trackId,
      before,
      isNew,
      prevSelection,
      caret,
      onClose: () => {
        if (editor === ed) {
          editor = null;
          if (textEdit.get() === ed) textEdit.set(null);
        }
      },
    });
    if (!ed) return false;
    editor = ed;
    textEdit.set(ed);
    return true;
  };

  const begin = (at: { x: number; y: number } | null): boolean => {
    if (refused()) return false;
    editor?.commit();
    const p = session.project;
    let point = at;
    if (point === null) {
      const r = stage.getBoundingClientRect();
      const c = view.clientToCanvas(r.left + r.width / 2, r.top + r.height / 2);
      const W = p.timeline.width;
      const H = p.timeline.height;
      point = { x: Math.min(Math.max(c.x, 0), W), y: Math.min(Math.max(c.y, 0), H) };
    }
    const v = view.store.get();
    const gen = newTextGen(tools.get(), v.dpr, v.zoom);
    // An empty text measures the same in every font: no font to wait for.
    const box = measureText(gen);
    const prevSelection = selection.get();
    const made = addTextLayer(p, gen, box.width, box.height, point, { above: prevSelection });
    // Not an edit yet (nothing typed): taken back without a trace if it stays
    // empty, and a temporary project closes without asking.
    session.replace(made.project, { edit: false });
    selection.set(made.trackId);
    if (!open(made.trackId, true, p, prevSelection, "end")) {
      session.replace(p, { edit: false });
      selection.set(prevSelection);
      return false;
    }
    ctx.requestRender();
    return true;
  };

  const edit = (trackId: string, caret: CaretAt = "end"): boolean => {
    if (refused()) return false;
    if (editor && editor.trackId === trackId) {
      editor.refocus();
      return true;
    }
    editor?.commit();
    const l = findLayer(session.project, trackId);
    if (!l || l.kind !== "text" || l.hidden) return false;
    if (selection.get() !== trackId) selection.set(trackId);
    return open(trackId, false, session.project, trackId, caret);
  };

  /* ---------------- the pointer surface (Text tool only) ---------------- */

  let surface: HTMLElement | null = null;

  const onSurfaceDown = (e: PointerEvent): void => {
    // The press that finished an open text only finishes it: a click away
    // never also starts a new one.
    if (closedBy.has(e)) return;
    if (e.button !== 0 || view.panning || refused() || shortcutsBlocked()) return;
    e.preventDefault();
    const p = session.project;
    const W = p.timeline.width;
    const H = p.timeline.height;
    const pt = view.clientToCanvas(e.clientX, e.clientY);
    const hit = textLayerAt(layersOf(p), W, H, pt.x, pt.y);
    if (hit) {
      edit(hit.trackId, { clientX: e.clientX, clientY: e.clientY });
      return;
    }
    // The grey pasteboard holds nothing to type into.
    if (pt.x < 0 || pt.y < 0 || pt.x > W || pt.y > H) return;
    begin(pt);
  };

  const showSurface = (on: boolean): void => {
    if (on && !surface) {
      surface = document.createElement("div");
      surface.className = "imged-textsurface";
      surface.addEventListener("pointerdown", onSurfaceDown);
      stage.appendChild(surface);
    } else if (!on && surface) {
      surface.removeEventListener("pointerdown", onSurfaceDown);
      surface.remove();
      surface = null;
    }
  };
  const paintSurface = (): void => {
    if (!disposed) showSurface(tools.get().tool === "text" && mode.get() === "idle");
  };

  const unsubs = [tools.subscribe(paintSurface), mode.subscribe(paintSurface)];
  paintSurface();

  return {
    begin,
    edit,
    commit(): void {
      editor?.commit();
    },
    dispose(): void {
      if (disposed) return;
      // A finished edit is still an edit: it lands before the session's
      // last save.
      editor?.commit();
      disposed = true;
      for (const u of unsubs) u();
      showSurface(false);
    },
  };
}
