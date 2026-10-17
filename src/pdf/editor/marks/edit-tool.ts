// The Edit text tool's pointer side (the picking itself is edit-text.ts):
//   - hover: a quiet outline of the line of page text under the pointer —
//     at most one pick per frame, a stale answer (the pointer moved on, the
//     tool changed) is dropped;
//   - click: the paragraph under the pointer (Alt+click: just its line)
//     becomes a text box that REPLACES it (one history step), opened for
//     typing with the caret at the end;
//   - drag: every line the box touches, as one paragraph.
// No text there: a quiet toast. Nothing runs at rest: hover work happens only
// on pointer moves while the tool is active.

import { normalizeHexColor } from "../../../core/session";
import { toast } from "../../../ui/toast";
import { addAnnot, canAddAnnots, newId } from "../../model";
import type { PageRect } from "../../types";
import type { Env, Gesture } from "./env";
import { PAGE_FULL } from "./draw";
import { pickTextAt, pickTextIn, type EditCandidate } from "./edit-text";
import { boxFrom, clampFont, rotField } from "./geom";
import { SVG_NS, n2 } from "./render";

/** The toast when a click finds no page text. */
export const NO_TEXT_HERE = "No text here to edit.";
/** A press moving less than this (screen px) is a click (select.ts DRAG_CSS). */
const DRAG_CSS = 3;

export interface EditTextTool {
  /** a pointer move over the strip while the tool is active */
  hover(e: { clientX: number; clientY: number; altKey?: boolean }): void;
  /** drop the hover outline (pointer left, tool changed, a gesture began) */
  clear(): void;
  /** pointer-down on page `key` */
  start(e: PointerEvent, key: string): Gesture | null;
  dispose(): void;
}

export function createEditTextTool(env: Env, open: (key: string, id: string) => void, alive: () => boolean): EditTextTool {
  const { ctx, layer } = env;
  let disposed = false;
  /** bumps on every new pick and every clear: an answer for an older one is stale */
  let seq = 0;
  let want: { clientX: number; clientY: number; line: boolean } | null = null;
  let queued = false;
  let inFlight = false;
  let outline: SVGRectElement | null = null;

  const active = (): boolean => !disposed && alive() && ctx.tools.get().tool === "edittext" && ctx.mode.get() === "annotate";

  function draw(c: EditCandidate | null): void {
    const f = c ? layer.frame(c.key) : null;
    if (!c || !f) {
      outline?.remove();
      outline = null;
      return;
    }
    if (!outline || outline.parentNode !== f.live) {
      outline?.remove();
      outline = document.createElementNS(SVG_NS, "rect");
      outline.setAttribute("class", "pdfmk-edit-hover");
      f.live.appendChild(outline);
    }
    const [x, y, w, h] = c.box;
    outline.setAttribute("x", n2(x));
    outline.setAttribute("y", n2(y));
    outline.setAttribute("width", n2(w));
    outline.setAttribute("height", n2(h));
  }

  function run(): void {
    queued = false;
    if (!active() || !want) return;
    if (inFlight) return; // the answer in flight schedules the next pick
    const at = want;
    want = null;
    const hit = ctx.view.clientToPage(at.clientX, at.clientY);
    if (!hit) {
      draw(null);
      return;
    }
    const mine = ++seq;
    inFlight = true;
    void pickTextAt(env, hit.key, at.clientX, at.clientY, { line: at.line })
      .catch(() => null)
      .then((c) => {
        inFlight = false;
        if (mine === seq && active()) draw(c);
        if (want && !queued && active()) {
          queued = true;
          env.frame(run);
        }
      });
  }

  function clear(): void {
    seq++;
    want = null;
    draw(null);
  }

  async function apply(pick: Promise<EditCandidate | null>): Promise<void> {
    const mine = ++seq;
    draw(null);
    let c: EditCandidate | null = null;
    try {
      c = await pick;
    } catch {
      c = null;
    }
    if (mine !== seq || !active()) return;
    if (!c) {
      toast.info(NO_TEXT_HERE);
      return;
    }
    const cand = c;
    const key = cand.key;
    if (!canAddAnnots(ctx.session.project, key, 1)) {
      toast.refuse(PAGE_FULL);
      return;
    }
    const [x, y, w, h] = cand.box;
    const id = newId();
    const before = ctx.session.project;
    ctx.session.commit((p) =>
      addAnnot(p, key, {
        id,
        t: "text",
        x,
        y,
        w,
        h,
        text: cand.text,
        font: cand.font,
        size: clampFont(cand.size),
        c: normalizeHexColor(cand.color, "#000000"),
        bold: cand.bold,
        italic: cand.italic,
        align: cand.align,
        edit: cand.edit,
        ...rotField(layer.info(key)?.rot ?? 0),
      }),
    );
    if (ctx.session.project === before) return;
    ctx.selection.set([{ key, id }]);
    open(key, id);
  }

  function start(e: PointerEvent, key: string): Gesture | null {
    const at = env.pt(key, e);
    if (!at) return null;
    clear();
    const zoom = env.zoom();
    let box: PageRect = boxFrom(at.x, at.y, at.x, at.y);
    let node: SVGRectElement | null = null;
    let queuedPaint = false;
    let ended = false;
    const paint = (): void => {
      queuedPaint = false;
      if (ended) return;
      const f = layer.frame(key);
      if (!f) return;
      if (!node || !node.isConnected) {
        node = document.createElementNS(SVG_NS, "rect");
        node.setAttribute("class", "pdfmk-marquee");
        f.live.appendChild(node);
      }
      node.setAttribute("x", n2(box[0]));
      node.setAttribute("y", n2(box[1]));
      node.setAttribute("width", n2(box[2]));
      node.setAttribute("height", n2(box[3]));
    };
    const track = (ev: PointerEvent): void => {
      const q = env.pt(key, ev);
      if (!q) return;
      box = boxFrom(at.x, at.y, q.x, q.y);
      if (!queuedPaint) {
        queuedPaint = true;
        env.frame(paint);
      }
    };
    const end = (): void => {
      ended = true;
      node?.remove();
      node = null;
    };
    return {
      move: track,
      up(ev) {
        track(ev);
        end();
        const click = box[2] * zoom < DRAG_CSS && box[3] * zoom < DRAG_CSS;
        // a click takes the paragraph; Alt+click a single line
        void apply(click ? pickTextAt(env, key, ev.clientX, ev.clientY, { line: ev.altKey }) : pickTextIn(env, key, box));
      },
      cancel: end,
    };
  }

  return {
    hover(e) {
      if (!active()) return;
      want = { clientX: e.clientX, clientY: e.clientY, line: e.altKey === true };
      if (queued) return;
      queued = true;
      env.frame(run);
    },
    clear,
    start,
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
    },
  };
}
