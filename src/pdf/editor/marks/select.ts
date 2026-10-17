// The select tool and the page chrome it draws: click a mark (topmost by draw
// order), Shift/Ctrl-click to add or remove one, drag on empty page for a
// marquee, drag the selection to move it (dropped on another page = moved to
// that page), eight handles to resize it, and the ruler (drag its body to move
// it, its knob to turn it). Every gesture is one history step: live edits go
// through session.replace() from the snapshot taken on pointer-down, then ONE
// commitFrom(before) on release.

import type { PdfAnnot, ProjectFile } from "../../../core/types";
import { annotBounds, moveAnnot, pageAnnots, scaleAnnot, translateAnnot, updateAnnot, type Box, type PdfAnnotPatch } from "../../model";
import type { Env, Gesture } from "./env";
import { sameEdit } from "./env";
import {
  HANDLES,
  RULER_LEN,
  RULER_THICK,
  boxFrom,
  geometryPatch,
  handleAt,
  handlePoint,
  marqueeHits,
  onRuler,
  onRulerKnob,
  resizeBox,
  topmostAt,
  unionBounds,
  type Handle,
} from "./geom";
import { rulerOn } from "./draw";
import { SVG_NS, n2 } from "./render";

export type SelRef = { key: string; id: string };

/** Click tolerance, handle size and handle reach, in SCREEN px. */
export const HIT_CSS = 4;
export const HANDLE_CSS = 8;
export const HANDLE_REACH_CSS = 7;
/** A press moving less than this (screen px) is a click, not a drag. */
export const DRAG_CSS = 3;

/** The selected marks that exist, resolved against `p`. */
export function selectedMarks(p: ProjectFile, sel: readonly SelRef[]): { key: string; a: PdfAnnot }[] {
  const out: { key: string; a: PdfAnnot }[] = [];
  for (const r of sel) {
    const a = pageAnnots(p, r.key).find((x) => x.id === r.id);
    if (a) out.push({ key: r.key, a });
  }
  return out;
}

/** The selection's handle box: every selected mark on ONE page and none of
 *  them a highlight (those follow the text they mark); else null. */
export function handleBox(p: ProjectFile, sel: readonly SelRef[]): { key: string; box: Box } | null {
  const marks = selectedMarks(p, sel);
  if (marks.length === 0) return null;
  const key = marks[0]!.key;
  if (marks.some((m) => m.key !== key || m.a.t === "highlight")) return null;
  const box = unionBounds(marks.map((m) => m.a));
  return box[2] > 0 || box[3] > 0 ? { key, box } : null;
}

/** `p` with each mark replaced by `f(mark)` (geometry only). */
function mapSelected(p: ProjectFile, marks: readonly { key: string; a: PdfAnnot }[], f: (a: PdfAnnot) => PdfAnnot): ProjectFile {
  let next = p;
  for (const m of marks) {
    const moved = f(m.a);
    if (moved === m.a) continue;
    next = updateAnnot(next, m.key, m.a.id, geometryPatch(moved) as PdfAnnotPatch);
  }
  return next;
}

/** Does a selection keep picture / signature proportions on a corner drag? */
function keepsAspect(marks: readonly { a: PdfAnnot }[]): boolean {
  return marks.length === 1 && (marks[0]!.a.t === "image" || marks[0]!.a.t === "signature");
}

/** Is the event's target text the native selection should own (a text-layer
 *  span) or a form widget / link? */
export function onNativeTarget(target: EventTarget | null): boolean {
  const t = target as (Element & { closest?: (s: string) => Element | null }) | null;
  if (!t || typeof t.closest !== "function") return false;
  if (t.closest(".annotationLayer")) return true;
  const layer = t.closest(".textLayer");
  return !!layer && layer !== t && t.tagName === "SPAN";
}

/** Pointer-down with the select tool on page `key`. */
export function startSelect(env: Env, e: PointerEvent, key: string): Gesture | null {
  const { ctx } = env;
  const at = env.pt(key, e);
  if (!at) return null;
  const zoom = env.zoom();
  const session = ctx.session;
  const before = session.project;
  const sel = ctx.selection.get();
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;

  // 1. a handle of the current selection
  const hb = handleBox(before, sel);
  if (hb && hb.key === key && !additive) {
    const h = handleAt(hb.box, at.x, at.y, HANDLE_REACH_CSS / zoom);
    if (h) return resizeGesture(env, key, hb.box, h, before);
  }

  // 2. a mark
  const hit = topmostAt(pageAnnots(before, key), at.x, at.y, HIT_CSS / zoom);
  if (hit) {
    const isSel = sel.some((r) => r.key === key && r.id === hit.id);
    if (additive) {
      ctx.selection.set(isSel ? sel.filter((r) => !(r.key === key && r.id === hit.id)) : [...sel, { key, id: hit.id }]);
      return null;
    }
    if (!isSel) ctx.selection.set([{ key, id: hit.id }]);
    return moveGesture(env, key, at, before);
  }

  // 3. text or a widget: the browser's own selection / form handling
  if (onNativeTarget(e.target)) {
    if (!additive && sel.length) ctx.selection.set([]);
    return null;
  }

  // 4. empty page: a marquee
  if (!additive && sel.length) ctx.selection.set([]);
  return marqueeGesture(env, key, at, additive ? sel : []);
}

/** Move the current selection from `start` (one step on release; dropped
 *  on another page = moved there). */
export function moveGesture(env: Env, key: string, start: { x: number; y: number }, before: ProjectFile): Gesture {
  const { ctx } = env;
  const session = ctx.session;
  const marks = selectedMarks(before, ctx.selection.get());
  const zoom = env.zoom();
  let moved = false;
  let written: ProjectFile = before;
  let want: [number, number] = [0, 0];
  let queued = false;
  let ended = false; // a frame queued by the last move must not write after up/cancel
  // a preview, not yet the user's edit (the release commits it; a cancel
  // leaves the project as it was, unedited)
  const apply = (): void => {
    queued = false;
    if (ended || !sameEdit(session.project, written)) return; // someone else wrote
    const next = mapSelected(before, marks, (a) => translateAnnot(a, want[0], want[1]));
    written = next;
    session.replace(next, { edit: false });
  };
  const track = (ev: PointerEvent): void => {
    const q = env.pt(key, ev);
    if (!q) return;
    const dx = q.x - start.x;
    const dy = q.y - start.y;
    if (!moved && Math.hypot(dx, dy) * zoom < DRAG_CSS) return;
    moved = true;
    want = [dx, dy];
    // one project write per frame, however fast the pointer reports
    if (!queued) {
      queued = true;
      env.frame(apply);
    }
  };
  return {
    move: track,
    up(ev) {
      track(ev);
      if (moved) apply(); // the final position, now
      ended = true;
      if (!moved || !sameEdit(session.project, written)) return;
      // dropped on another page: the marks go there
      const drop = ctx.view.clientToPage(ev.clientX, ev.clientY);
      if (drop && drop.key !== key && marks.every((m) => m.key === key)) {
        let next = before;
        const dx = drop.x - start.x;
        const dy = drop.y - start.y;
        for (const m of marks) {
          const t = translateAnnot(m.a, dx, dy);
          next = moveAnnot(next, { pageId: key, id: m.a.id }, drop.key);
          next = updateAnnot(next, drop.key, m.a.id, geometryPatch(t) as PdfAnnotPatch);
        }
        if (next !== before) {
          session.replace(next, { edit: false });
          ctx.selection.set(marks.map((m) => ({ key: drop.key, id: m.a.id })));
        }
      }
      session.commitFrom(before);
    },
    cancel() {
      ended = true;
      if (moved && sameEdit(session.project, written)) session.replace(before, { edit: false });
    },
  };
}

/** Resize the current selection by handle `h` of `from` (one step). */
export function resizeGesture(env: Env, key: string, from: Box, h: Handle, before: ProjectFile): Gesture {
  const { ctx } = env;
  const session = ctx.session;
  const marks = selectedMarks(before, ctx.selection.get());
  const aspect = keepsAspect(marks);
  let written: ProjectFile = before;
  let moved = false;
  let to: Box = from;
  let queued = false;
  let ended = false; // see moveGesture
  const apply = (): void => {
    queued = false;
    if (ended || !sameEdit(session.project, written)) return;
    const next = mapSelected(before, marks, (a) => scaleAnnot(a, from, to));
    written = next;
    session.replace(next, { edit: false });
  };
  const track = (ev: PointerEvent): void => {
    const q = env.pt(key, ev);
    if (!q || !sameEdit(session.project, written)) return;
    to = resizeBox(from, h, q.x, q.y, aspect || ev.shiftKey);
    moved = true;
    if (!queued) {
      queued = true;
      env.frame(apply);
    }
  };
  return {
    move: track,
    up(ev) {
      track(ev);
      if (moved) apply();
      ended = true;
      if (moved && sameEdit(session.project, written)) session.commitFrom(before);
    },
    cancel() {
      ended = true;
      if (moved && sameEdit(session.project, written)) session.replace(before, { edit: false });
    },
  };
}

function marqueeGesture(env: Env, key: string, start: { x: number; y: number }, base: readonly SelRef[]): Gesture {
  const { ctx } = env;
  let box = boxFrom(start.x, start.y, start.x, start.y);
  let node: SVGRectElement | null = null;
  let queued = false;
  let ended = false; // a frame queued by the last move must not redraw it (draw.ts startInk)
  const paint = (): void => {
    queued = false;
    if (ended) return;
    const f = env.layer.frame(key);
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
    box = boxFrom(start.x, start.y, q.x, q.y);
    if (!queued) {
      queued = true;
      env.frame(paint);
    }
  };
  return {
    move: track,
    up(ev) {
      track(ev);
      ended = true;
      node?.remove();
      node = null;
      if (box[2] * env.zoom() < DRAG_CSS && box[3] * env.zoom() < DRAG_CSS) return;
      const hits = marqueeHits(pageAnnots(ctx.session.project, key), box).map((a) => ({ key, id: a.id }));
      const out = [...base];
      for (const h of hits) if (!out.some((r) => r.key === h.key && r.id === h.id)) out.push(h);
      ctx.selection.set(out);
    },
    cancel() {
      ended = true;
      node?.remove();
      node = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ruler gestures                                                      */
/* ------------------------------------------------------------------ */

/** A press on the ruler of page `key` (null when it missed it). */
export function startRuler(env: Env, e: PointerEvent, key: string): Gesture | null {
  const { ctx } = env;
  const pose = rulerOn(env, key);
  const at = env.pt(key, e);
  if (!pose || !at) return null;
  const knob = onRulerKnob(pose, at.x, at.y, HANDLE_REACH_CSS / env.zoom());
  if (!knob && !onRuler(pose, at.x, at.y)) return null;
  const r0 = ctx.tools.get().ruler!;
  const set = (patch: Partial<typeof r0>): void => {
    ctx.tools.update((s) => (s.ruler ? { ...s, ruler: { ...s.ruler, ...patch } } : s));
  };
  return {
    move(ev) {
      const q = env.pt(key, ev);
      if (!q) return;
      if (knob) {
        let deg = (Math.atan2(q.y - r0.cy, q.x - r0.cx) * 180) / Math.PI;
        // Shift: 15° steps
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        set({ angle: deg });
      } else {
        set({ cx: r0.cx + q.x - at.x, cy: r0.cy + q.y - at.y });
      }
    },
    up() {},
    cancel() {
      set({ cx: r0.cx, cy: r0.cy, angle: r0.angle });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Chrome: selection outlines, handles, the ruler                      */
/* ------------------------------------------------------------------ */

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  return e;
}

/** Redraw every rendered page's chrome group from the selection, the ruler
 *  and the zoom (handles keep their screen size). `skip`: a mark the text
 *  editor is typing in (it draws the same frame around the growing box). */
export function paintChrome(env: Env, showHandles: boolean, skip: string | null = null): void {
  const { ctx } = env;
  const p = ctx.session.project;
  const sel = skip === null ? ctx.selection.get() : ctx.selection.get().filter((r) => r.id !== skip);
  const zoom = env.zoom();
  const hb = showHandles ? handleBox(p, sel) : null;
  // the ruler is a marking aid: hidden (not dropped) in Fill forms mode
  const ruler = ctx.mode.get() === "forms" ? null : ctx.tools.get().ruler;
  for (const f of env.layer.frames()) {
    const g = f.chrome;
    while (g.firstChild) g.removeChild(g.firstChild);
    for (const m of selectedMarks(p, sel)) {
      if (m.key !== f.key) continue;
      const [x, y, w, h] = annotBounds(m.a);
      g.appendChild(svgEl("rect", { x: n2(x), y: n2(y), width: n2(w), height: n2(h), class: "pdfmk-sel" }));
    }
    if (hb && hb.key === f.key) {
      const s = HANDLE_CSS / zoom;
      for (const h of HANDLES) {
        const [hx, hy] = handlePoint(hb.box, h);
        g.appendChild(svgEl("rect", { x: n2(hx - s / 2), y: n2(hy - s / 2), width: n2(s), height: n2(s), class: `pdfmk-handle pdfmk-handle--${h}` }));
      }
    }
    if (ruler && ruler.key === f.key) g.appendChild(rulerNode(ruler.cx, ruler.cy, ruler.angle));
  }
}

function rulerNode(cx: number, cy: number, deg: number): SVGGElement {
  const g = svgEl("g", { class: "pdfmk-ruler", transform: `translate(${n2(cx)} ${n2(cy)}) rotate(${n2(deg)})` });
  const L = RULER_LEN;
  const T = RULER_THICK;
  g.appendChild(svgEl("rect", { x: n2(-L / 2), y: n2(-T / 2), width: n2(L), height: n2(T), rx: "4", class: "pdfmk-ruler__body" }));
  // a tick every 10 pt, longer every 50
  let d = "";
  for (let u = -L / 2 + 10; u < L / 2; u += 10) {
    const len = Math.round(u + L / 2) % 50 === 0 ? 10 : 5;
    d += `M${n2(u)} ${n2(-T / 2)}v${len}M${n2(u)} ${n2(T / 2)}v${-len}`;
  }
  g.appendChild(svgEl("path", { d, class: "pdfmk-ruler__ticks" }));
  g.appendChild(svgEl("circle", { cx: n2(L / 2 - 10), cy: "0", r: "5", class: "pdfmk-ruler__knob" }));
  return g;
}
