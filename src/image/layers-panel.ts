// The image editor's Layers panel: one row per layer, top first, with the eye
// toggle, rename, duplicate, reorder and delete, and "Add layer" (drawing,
// photo, text, solid colour).
//
// Built from the video editor's media bin (.media-panel / .media-list /
// .media-row*) so it reads as the same app. Rows are KEYED by track id and
// written idempotently: a stroke commit changes the layer list's identity, but
// only the text or attribute that actually changed is touched, and a photo's
// thumbnail is redrawn only when its pixels or its crop/rotation/flip do —
// never a re-downscale of every photo per stroke. Nothing runs while nothing
// changes: the panel listens to stores and to the preview resources' change
// event, and owns no timer and no animation frame.
//
// Every edit is ONE commit, so every edit is one undo step. Delete is not a
// danger action here: it is undoable, and a layer is not a library item.

import "./layers-panel.css";
import { describeError, ipc, pickImageFile } from "../core/ipc";
import { isTypingTarget, shortcutsBlocked } from "../core/shortcuts";
import { normalizeHexColor } from "../core/session";
import type { ProjectFile } from "../core/types";
import { openGeneratorDialog } from "../editor/media/generators";
import { isStillInfo } from "../editor/media/relink";
import { icon } from "../ui/icons";
import { closeMenu, showMenu, type MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";
import type { ImageEditorCtx } from "./context";
import { layerCorners, layerToCanvas } from "./geom";
import { imgIcon, type ImgIconName } from "./icons";
import {
  addDrawingLayer,
  addGeneratorLayer,
  addPhotoLayer,
  duplicateLayer,
  duplicateRefusal,
  KIND_LABEL,
  layersOf,
  moveLayer,
  nextSelectionAfterRemove,
  removeLayer,
  renameLayer,
  setLayerHidden,
  type Layer,
  type LayerKind,
} from "./layers";
import { addRefusal } from "./paste";
import { maxRenderSize } from "./render/export";

/** Drag dead zone in client px before a row press becomes a reorder. */
const DRAG_THRESHOLD_PX = 4;
/** Thumbnail box, CSS px (the media bin's .media-row__thumb). */
const THUMB_W = 56;
const THUMB_H = 32;

const KIND_ICON: Record<LayerKind, ImgIconName> = {
  photo: "image",
  drawing: "drawing",
  text: "text",
  solid: "solid",
};

/** The gap (0..n) a reorder drag drops into, given each row's vertical
 *  midpoint: the number of rows whose midpoint is above the pointer. */
export function dropGap(mids: readonly number[], y: number): number {
  let g = 0;
  while (g < mids.length && mids[g]! < y) g++;
  return g;
}

/** The layer index a row at `from` ends up at when dropped into gap `gap`
 *  (gaps count from the top; the row's own two gaps mean "stay"). */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** The layer sub-label: the kind, a photo's pixel size, and the size a photo
 *  too big for the browser's canvas limits is actually rendered at. */
export function layerSubLabel(l: Layer, strokes: number): string {
  if (l.kind === "drawing") return `Drawing · ${strokes} ${strokes === 1 ? "stroke" : "strokes"}`;
  const w = l.media.width;
  const h = l.media.height;
  if (!w || !h) return KIND_LABEL[l.kind];
  let s = `${KIND_LABEL[l.kind]} · ${w}×${h}`;
  if (l.kind === "photo") {
    try {
      const r = maxRenderSize(w, h);
      if (r.reduced) s += ` · exports at ${r.w}×${r.h}`;
    } catch {
      /* the size is informational; never let it break the row */
    }
  }
  return s;
}

function strokeTotal(l: Layer): number {
  const g = l.media.generator;
  if (g?.type !== "drawing") return 0;
  let n = 0;
  for (const c of g.chunks) n += c.length;
  return n;
}

interface Row {
  el: HTMLDivElement;
  thumb: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  swatch: HTMLDivElement | null;
  name: HTMLDivElement;
  sub: HTMLDivElement;
  status: HTMLSpanElement;
  eye: HTMLButtonElement;
  more: HTMLButtonElement;
  /** last written values, so a refresh writes only what changed */
  w: {
    name: string;
    sub: string;
    status: string;
    statusBad: boolean;
    hidden: boolean | null;
    selected: boolean | null;
    thumbKind: string;
    thumbKey: string;
    thumbSrc: CanvasImageSource | null;
    /** the clip adjust the thumbnail was drawn with (identity-compared) */
    thumbAdjust: unknown;
    swatch: string;
  };
}

/** The density a photo row asks the preview resources for: exactly the one
 *  the stage composite asks for (`composite.ts`, photo branch), so a panel
 *  call is always a cache hit. A thumbnail-sized density would overwrite the
 *  photo's wanted size, close the stage-sized level and flip the single-slot
 *  adjusted copy on every drag frame. The scale is sanitised the same way, or
 *  a crafted scale gives a NaN that never hits the cache. */
export function thumbDensity(scale: number, zoom: number): number {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return k * zoom;
}

export function mountLayersPanel(host: HTMLElement, ctx: ImageEditorCtx): { dispose(): void } {
  const { session, selection, res } = ctx;
  let disposed = false;

  host.textContent = "";
  const header = document.createElement("div");
  header.className = "media-panel__header no-select";
  header.textContent = "Layers";
  const addRow = document.createElement("div");
  addRow.className = "media-panel__add no-select";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn--sm";
  addBtn.id = "imged-add-layer";
  addBtn.title = "Add a layer";
  addBtn.innerHTML = `${icon("plus")}Add layer`;
  addRow.appendChild(addBtn);
  const list = document.createElement("div");
  list.className = "media-list imged-layer-list";
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Layers");
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = `${imgIcon("layers", 24)}<div class="faint">No layers yet.<br/>Draw, or add a layer.</div>`;
  const dropLine = document.createElement("div");
  dropLine.className = "imged-layer-drop";
  host.append(header, addRow, list);

  const rows = new Map<string, Row>();
  let lastLayers: readonly Layer[] | null = null;
  let lastSel: string | null | undefined;
  let renaming: string | null = null;
  let inertShown = false;

  /* ---------------- rows ---------------- */

  function button(cls: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn btn--ghost btn--icon btn--sm ${cls}`;
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  }

  function makeRow(trackId: string): Row {
    const el = document.createElement("div");
    el.className = "media-row imged-layer";
    el.dataset.track = trackId;
    el.setAttribute("role", "option");
    const thumb = document.createElement("div");
    thumb.className = "media-row__thumb";
    const meta = document.createElement("div");
    meta.className = "media-row__meta";
    const name = document.createElement("div");
    name.className = "media-row__name";
    const sub = document.createElement("div");
    sub.className = "media-row__sub";
    meta.append(name, sub);
    const status = document.createElement("span");
    status.className = "media-row__status imged-layer__status";
    status.hidden = true;
    const actions = document.createElement("div");
    actions.className = "imged-layer__actions";
    const eye = button("imged-layer__eye", "Hide layer");
    const more = button("imged-layer__more", "Layer options");
    more.innerHTML = icon("more");
    actions.append(eye, more);
    el.append(thumb, meta, status, actions);
    return {
      el, thumb, canvas: null, swatch: null, name, sub, status, eye, more,
      w: {
        name: "", sub: "", status: "", statusBad: false, hidden: null, selected: null,
        thumbKind: "", thumbKey: "", thumbSrc: null, thumbAdjust: undefined, swatch: "",
      },
    };
  }

  /** `force`: the preview resources changed (a decode or an adjustment
   *  landed), so ask for the pixels again. Otherwise a store change that left
   *  the thumbnail's own inputs alone (a move, a scale, another layer's edit —
   *  every pointermove of a drag) never reaches `res.photo` at all. */
  function paintThumb(r: Row, l: Layer, force: boolean): void {
    const g = l.media.generator;
    if (l.kind === "photo") {
      const t = l.transform;
      const c = t.crop;
      const key = `${l.media.id}|${l.media.width}x${l.media.height}|${c ? `${c.x},${c.y},${c.w},${c.h}` : ""}|${t.rotate}|${t.flipH}|${t.flipV}`;
      const adjust: unknown = l.clip.adjust;
      if (!force && r.w.thumbKind === "photo" && r.canvas && key === r.w.thumbKey && adjust === r.w.thumbAdjust) return;
      const src = res.photo(l, thumbDensity(t.scale, ctx.view.store.get().zoom));
      if (!src) {
        // Pixels in flight (a re-decode, an adjustment being applied): keep the
        // last thumbnail rather than flashing the placeholder. Only a photo
        // that has none, or failed, shows the icon.
        if (r.canvas && res.status(l.trackId).state !== "failed") return;
        if (r.w.thumbKind !== "icon-photo") {
          r.thumb.innerHTML = imgIcon("image", 18);
          r.canvas = null;
          r.swatch = null;
          r.w.thumbKind = "icon-photo";
          r.w.thumbSrc = null;
          r.w.thumbKey = "";
          r.w.thumbAdjust = undefined;
        }
        return;
      }
      if (r.w.thumbKind !== "photo" || !r.canvas) {
        const c = document.createElement("canvas");
        c.className = "imged-layer__thumb";
        r.thumb.replaceChildren(c);
        r.canvas = c;
        r.swatch = null;
        r.w.thumbKind = "photo";
        r.w.thumbSrc = null;
        r.w.thumbKey = "";
      }
      // Skip the redraw only for a source whose pixels cannot change under
      // the same object: an ImageBitmap. The photo cache rewrites its adjusted
      // canvas IN PLACE while the level size holds, so "same object" there
      // does not mean "same pixels" — skipping would freeze the thumbnail at
      // the first adjustment. (`typeof` keeps the node test env happy.)
      if (
        src === r.w.thumbSrc &&
        key === r.w.thumbKey &&
        adjust === r.w.thumbAdjust &&
        typeof ImageBitmap !== "undefined" &&
        src instanceof ImageBitmap
      ) {
        return;
      }
      r.w.thumbSrc = src;
      r.w.thumbKey = key;
      r.w.thumbAdjust = adjust;
      drawPhotoThumb(r.canvas, l, src);
      return;
    }
    if (g?.type === "solid") {
      if (r.w.thumbKind !== "solid" || !r.swatch) {
        const s = document.createElement("div");
        s.className = "media-row__swatch";
        r.thumb.replaceChildren(s);
        r.swatch = s;
        r.canvas = null;
        r.w.thumbKind = "solid";
        r.w.swatch = "";
      }
      // A literal colour the user picked, written through the CSSOM (the media
      // bin's rule: no inline style attribute, no theme token in its place).
      const col = normalizeHexColor(g.color, "#000000");
      if (col !== r.w.swatch) {
        r.swatch.style.background = col;
        r.w.swatch = col;
      }
      return;
    }
    const kind = `icon-${l.kind}`;
    if (r.w.thumbKind !== kind) {
      r.thumb.innerHTML = imgIcon(KIND_ICON[l.kind], 18);
      r.canvas = null;
      r.swatch = null;
      r.w.thumbKind = kind;
    }
  }

  /** The layer as it sits on the canvas (crop, rotation and flip applied),
   *  contained in the thumbnail box — drawn through the layer's own affine so
   *  it can never face a different way from the stage. */
  function drawPhotoThumb(c: HTMLCanvasElement, l: Layer, src: CanvasImageSource): void {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(THUMB_W * dpr);
    const bh = Math.round(THUMB_H * dpr);
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);
    const sw = l.media.width;
    const sh = l.media.height;
    if (!sw || !sh) return;
    const { width: W, height: H } = session.project.timeline;
    let m: readonly number[];
    let box: { x: number; y: number; w: number; h: number };
    try {
      m = layerToCanvas(l.transform, sw, sh, W, H);
      const q = layerCorners(l.transform, sw, sh, W, H);
      const xs = q.map((p) => p[0]);
      const ys = q.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      box = { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
    } catch {
      return;
    }
    if (!(box.w > 0) || !(box.h > 0)) return;
    const s = Math.min(bw / box.w, bh / box.h);
    const ox = (bw - box.w * s) / 2;
    const oy = (bh - box.h * s) / 2;
    g.beginPath();
    g.rect(ox, oy, box.w * s, box.h * s);
    g.clip();
    g.setTransform(s, 0, 0, s, ox - box.x * s, oy - box.y * s);
    g.transform(m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!);
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, sw, sh);
  }

  function paintStatus(r: Row, l: Layer): void {
    let text = "";
    let bad = false;
    if (l.kind === "photo") {
      const st = res.status(l.trackId);
      if (st.state === "loading") text = "Loading";
      else if (st.state === "failed") {
        text = "Missing";
        bad = true;
        const tip = st.message ?? "The image could not be read";
        if (r.status.title !== tip) r.status.title = tip;
      }
    }
    if (text !== r.w.status) {
      r.status.textContent = text;
      r.status.hidden = text === "";
      r.w.status = text;
    }
    if (bad !== r.w.statusBad) {
      r.status.classList.toggle("media-row__status--bad", bad);
      r.w.statusBad = bad;
    }
  }

  function paintRow(r: Row, l: Layer, selected: boolean): void {
    if (renaming !== l.trackId && l.name !== r.w.name) {
      r.name.textContent = l.name;
      r.el.title = l.name;
      r.w.name = l.name;
    }
    const sub = layerSubLabel(l, strokeTotal(l));
    if (sub !== r.w.sub) {
      r.sub.textContent = sub;
      r.w.sub = sub;
    }
    if (l.hidden !== r.w.hidden) {
      r.el.classList.toggle("is-hidden", l.hidden);
      r.eye.innerHTML = imgIcon(l.hidden ? "eyeOff" : "eye");
      r.eye.setAttribute("aria-pressed", String(l.hidden));
      const t = l.hidden ? "Show layer" : "Hide layer";
      r.eye.title = t;
      r.eye.setAttribute("aria-label", t);
      r.w.hidden = l.hidden;
    }
    if (selected !== r.w.selected) {
      r.el.classList.toggle("is-selected", selected);
      r.el.setAttribute("aria-selected", String(selected));
      r.w.selected = selected;
    }
    paintThumb(r, l, false);
    paintStatus(r, l);
  }

  function render(): void {
    if (disposed) return;
    const layers = layersOf(session.project);
    let sel = selection.get();
    // A selection whose layer is gone (undo of an add, a delete) is cleared;
    // the tools and the inspector then read "nothing selected" consistently.
    if (sel !== null && layers !== lastLayers && !layers.some((l) => l.trackId === sel)) {
      selection.set(null);
      sel = null;
    }
    if (layers === lastLayers && sel === lastSel) return;
    lastLayers = layers;
    lastSel = sel;

    const live = new Set<string>();
    for (const l of layers) live.add(l.trackId);
    for (const [id, r] of rows) {
      if (!live.has(id)) {
        r.el.remove();
        rows.delete(id);
        if (renaming === id) renaming = null;
      }
    }
    if (layers.length === 0) {
      if (empty.parentNode !== list) list.replaceChildren(empty);
      return;
    }
    if (empty.parentNode === list) empty.remove();
    let i = 0;
    for (const l of layers) {
      let r = rows.get(l.trackId);
      if (!r) {
        r = makeRow(l.trackId);
        rows.set(l.trackId, r);
      }
      paintRow(r, l, l.trackId === sel);
      // Reorder only where the order actually differs.
      if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] ?? null);
      i++;
    }
  }

  function repaintStatus(): void {
    if (disposed || !lastLayers) return;
    for (const l of lastLayers) {
      const r = rows.get(l.trackId);
      if (!r) continue;
      paintThumb(r, l, true);
      paintStatus(r, l);
      const sub = layerSubLabel(l, strokeTotal(l));
      if (sub !== r.w.sub) {
        r.sub.textContent = sub;
        r.w.sub = sub;
      }
    }
  }

  /* ---------------- edits (one commit each) ---------------- */

  const layerAt = (trackId: string): { l: Layer; index: number; count: number } | null => {
    const ls = layersOf(session.project);
    const index = ls.findIndex((l) => l.trackId === trackId);
    return index < 0 ? null : { l: ls[index]!, index, count: ls.length };
  };

  function commitAdd(make: (p: ProjectFile) => { project: ProjectFile; trackId: string }): void {
    let added: string | null = null;
    session.commit((p) => {
      const r = make(p);
      added = r.trackId;
      return r.project;
    });
    if (added !== null) selection.set(added);
    ctx.requestRender();
  }

  function move(trackId: string, toIndex: number): void {
    session.commit((p) => moveLayer(p, trackId, toIndex));
    ctx.requestRender();
  }

  function remove(trackId: string): void {
    if (!layerAt(trackId)) return;
    // The row that takes its place stays selected: the one below, else above.
    // The shared rule, so the Delete key (image-editor.ts) picks the same row.
    const next = nextSelectionAfterRemove(session.project, trackId);
    session.commit((p) => removeLayer(p, trackId));
    if (selection.get() === trackId) selection.set(next);
    ctx.requestRender();
  }

  function toggleHidden(trackId: string): void {
    const at = layerAt(trackId);
    if (!at) return;
    session.commit((p) => setLayerHidden(p, trackId, !at.l.hidden));
    ctx.requestRender();
  }

  async function addImage(): Promise<void> {
    let path: string | null;
    try {
      path = await pickImageFile();
    } catch (e) {
      if (!disposed) toast.error(describeError(e));
      return;
    }
    if (disposed || !path) return;
    try {
      const info = await ipc.probeMedia(path);
      if (disposed) return;
      // The paste's and the drop's own re-check, for whatever opened while the
      // picker and the probe ran (a slow disk makes that a real window): a
      // crop (a commit now would merge into it), a dialog, or a menu or
      // picker (under a colour preview, the layer would record that unpicked
      // colour as the undo step before it).
      const refused = addRefusal(
        ctx.mode.get(),
        document.querySelector(".modal-backdrop") !== null,
        shortcutsBlocked(),
        "add the photo again",
      );
      if (refused !== null) {
        toast.info(refused);
        return;
      }
      // A still with a size: one without would be placed at the canvas size
      // and drawn from nothing.
      if (!isStillInfo(info) || !info.width || !info.height) {
        toast.refuse("This isn't a still image.");
        return;
      }
      const above = selection.get();
      commitAdd((p) => addPhotoLayer(p, info, { above }));
    } catch (e) {
      if (!disposed) toast.error(describeError(e));
    }
  }

  function openAddMenu(): void {
    const r = addBtn.getBoundingClientRect();
    const items: MenuItem[] = [
      {
        label: "Drawing layer",
        onSelect: () => {
          const above = selection.get();
          commitAdd((p) => addDrawingLayer(p, { above }));
        },
      },
      { label: KIND_LABEL.photo, onSelect: () => void addImage() },
      { label: "Text", onSelect: () => openGenerator("text") },
      { label: "Solid color", onSelect: () => openGenerator("solid") },
    ];
    showMenu(r.left, r.bottom + 4, items);
  }

  function openGenerator(kind: "text" | "solid"): void {
    const { width: w, height: h } = session.project.timeline;
    let unreg: () => void = () => {};
    const close = openGeneratorDialog(kind, {
      session,
      defaultSize: { w, h },
      // Every close path — Add, Cancel, Escape, the backdrop, X — drops the
      // closer from the shell's overlay set. A cancelled dialog left behind
      // would read as a surface still open to anything that asks the set.
      onClose: () => unreg(),
      onCreate: (gen, gw, gh, label) => {
        if (disposed) return;
        // Read at confirm time: the selection may have moved while it was open.
        const above = selection.get();
        commitAdd((p) => addGeneratorLayer(p, gen, gw, gh, label, { above }));
      },
    });
    unreg = ctx.registerOverlay(close);
  }

  function openRowMenu(trackId: string, x: number, y: number): void {
    const at = layerAt(trackId);
    if (!at) return;
    if (selection.get() !== trackId) selection.set(trackId);
    showMenu(x, y, [
      { label: "Rename", onSelect: () => startRename(trackId) },
      {
        label: "Duplicate",
        onSelect: () => {
          // Refused out loud: a copy past the drawing caps would make every
          // later save fail.
          const refused = duplicateRefusal(session.project, trackId);
          if (refused !== null) {
            toast.refuse(refused);
            return;
          }
          commitAdd((p) => duplicateLayer(p, trackId));
        },
      },
      {
        label: "Move up",
        disabled: at.index === 0,
        onSelect: () => move(trackId, at.index - 1),
      },
      {
        label: "Move down",
        disabled: at.index >= at.count - 1,
        onSelect: () => move(trackId, at.index + 1),
      },
      { label: "Delete", onSelect: () => remove(trackId) },
    ]);
  }

  /* ---------------- inline rename (Home's pattern) ---------------- */

  function startRename(trackId: string): void {
    const r = rows.get(trackId);
    const at = layerAt(trackId);
    if (!r || !at || renaming) return;
    renaming = trackId;
    const old = at.l.name;
    const input = document.createElement("input");
    input.className = "input imged-layer__rename";
    input.value = old;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Layer name");
    r.name.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const stop = (e: Event): void => e.stopPropagation();
    input.addEventListener("pointerdown", stop);
    input.addEventListener("click", stop);
    input.addEventListener("dblclick", stop);
    const finish = (): void => {
      renaming = null;
      r.name.textContent = r.w.name;
      // The row may have been renamed while the input was up; show the truth.
      lastLayers = null;
      render();
    };
    const cancel = (): void => {
      if (done) return;
      done = true;
      finish();
    };
    const commit = (): void => {
      if (done) return;
      const value = input.value.trim();
      if (value.length === 0 || value === old) {
        cancel();
        return;
      }
      done = true;
      session.commit((p) => renameLayer(p, trackId, value));
      finish();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        list.focus();
      }
    });
    input.addEventListener("blur", commit);
  }

  /* ---------------- pointer: select, row drag reorder ---------------- */

  interface Drag {
    trackId: string;
    from: number;
    pointerId: number;
    startY: number;
    armed: boolean;
    /** row midpoints in list-content px, read once when the drag arms */
    mids: number[];
    tops: number[];
    bottom: number;
    gap: number;
  }
  let drag: Drag | null = null;

  function rowOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(".imged-layer") : null;
  }

  function onListPointerDown(e: PointerEvent): void {
    if (disposed || e.button !== 0 || drag) return;
    const t = e.target as Element;
    if (t.closest("button, input")) return;
    const row = rowOf(t);
    const id = row?.dataset.track;
    if (!row || !id) return;
    if (selection.get() !== id) selection.set(id);
    const at = layerAt(id);
    if (!at) return;
    drag = {
      trackId: id,
      from: at.index,
      pointerId: e.pointerId,
      startY: e.clientY,
      armed: false,
      mids: [],
      tops: [],
      bottom: 0,
      gap: at.index,
    };
    // Not captured yet: a capture now would retarget the click and dblclick
    // of a plain press to the list, and rename-on-double-click would never
    // see its row. The capture is taken once the press becomes a drag.
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
    window.addEventListener("pointercancel", onDragCancel);
    // Alt-Tab mid-drag: no pointerup ever arrives, and a drag left live would
    // swallow the next press (`if (drag) return`).
    window.addEventListener("blur", onDragBlur);
  }

  function onDragMove(e: PointerEvent): void {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.armed) {
      if (Math.abs(e.clientY - d.startY) <= DRAG_THRESHOLD_PX) return;
      d.armed = true;
      try { list.setPointerCapture(d.pointerId); } catch { /* synthetic pointer */ }
      // One layout read, before any write: rows in list-content coordinates.
      const lr = list.getBoundingClientRect();
      const base = lr.top - list.scrollTop;
      for (const l of layersOf(session.project)) {
        const r = rows.get(l.trackId);
        if (!r) continue;
        const b = r.el.getBoundingClientRect();
        d.tops.push(b.top - base);
        d.mids.push(b.top - base + b.height / 2);
        d.bottom = b.bottom - base;
      }
      rows.get(d.trackId)?.el.classList.add("is-dragging");
      list.appendChild(dropLine);
      dropLine.style.display = "block";
    }
    const lr = list.getBoundingClientRect();
    const y = e.clientY - lr.top + list.scrollTop;
    const gap = dropGap(d.mids, y);
    d.gap = gap;
    const lineY = gap < d.tops.length ? d.tops[gap]! - 1 : d.bottom + 1;
    dropLine.style.transform = `translateY(${lineY - 1}px)`;
  }

  function endDrag(): Drag | null {
    const d = drag;
    if (!d) return null;
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
    window.removeEventListener("pointercancel", onDragCancel);
    window.removeEventListener("blur", onDragBlur);
    try { list.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
    rows.get(d.trackId)?.el.classList.remove("is-dragging");
    dropLine.style.display = "none";
    dropLine.remove();
    return d;
  }

  function onDragUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = endDrag();
    if (!d || !d.armed) return;
    const to = dropIndex(d.from, d.gap);
    // Onto itself: moveLayer returns the same reference, so no commit happens.
    if (to !== d.from) move(d.trackId, to);
  }

  function onDragCancel(e: PointerEvent): void {
    if (drag && e.pointerId === drag.pointerId) endDrag();
  }

  function onDragBlur(): void {
    endDrag();
  }

  function onListClick(e: MouseEvent): void {
    const t = e.target as Element;
    const row = rowOf(t);
    const id = row?.dataset.track;
    if (!row || !id) return;
    if (t.closest(".imged-layer__eye")) {
      e.stopPropagation();
      toggleHidden(id);
      (t.closest("button") as HTMLButtonElement | null)?.blur();
    } else if (t.closest(".imged-layer__more")) {
      e.stopPropagation();
      const b = (t.closest("button") as HTMLButtonElement).getBoundingClientRect();
      openRowMenu(id, b.left, b.bottom + 4);
    }
  }

  function onListDblClick(e: MouseEvent): void {
    const t = e.target as Element;
    if (t.closest("button, input")) return;
    const id = rowOf(t)?.dataset.track;
    if (id) startRename(id);
  }

  function onContextMenu(e: MouseEvent): void {
    const id = rowOf(e.target)?.dataset.track;
    if (!id || (e.target as Element).closest("input")) return;
    e.preventDefault();
    openRowMenu(id, e.clientX, e.clientY);
  }

  /* ---------------- keyboard (list focused) ---------------- */

  function onListKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (isTypingTarget(e.target) || shortcutsBlocked()) return;
    if (document.querySelector(".modal-backdrop")) return;
    if (e.ctrlKey || e.metaKey) return;
    const ls = layersOf(session.project);
    if (ls.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.key === "ArrowUp" ? -1 : 1;
    const sel = selection.get();
    const i = ls.findIndex((l) => l.trackId === sel);
    if (e.altKey) {
      if (i < 0) return;
      const to = i + dir;
      if (to >= 0 && to < ls.length) move(ls[i]!.trackId, to);
      return;
    }
    const next = i < 0 ? (dir > 0 ? 0 : ls.length - 1) : Math.min(Math.max(i + dir, 0), ls.length - 1);
    selection.set(ls[next]!.trackId);
    rows.get(ls[next]!.trackId)?.el.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- wiring ---------------- */

  function onAddClick(): void {
    addBtn.blur();
    openAddMenu();
  }

  addBtn.addEventListener("click", onAddClick);
  list.addEventListener("pointerdown", onListPointerDown);
  list.addEventListener("click", onListClick);
  list.addEventListener("dblclick", onListDblClick);
  list.addEventListener("contextmenu", onContextMenu);
  list.addEventListener("keydown", onListKey);

  function paintInert(): void {
    // While the stage is in a modal mode (a crop), the panel is inert: a delete
    // or eye toggle landing mid-crop would edit under the crop's baseline.
    const inert = ctx.mode.get() !== "idle";
    if (inert !== inertShown) {
      host.inert = inert;
      inertShown = inert;
      if (inert) endDrag();
    }
  }

  const unsubs = [
    session.store.subscribe(render),
    selection.subscribe(render),
    ctx.mode.subscribe(paintInert),
    res.onChange(repaintStatus),
  ];
  render();
  paintInert();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      endDrag();
      for (const u of unsubs) u();
      closeMenu();
      addBtn.removeEventListener("click", onAddClick);
      list.removeEventListener("pointerdown", onListPointerDown);
      list.removeEventListener("click", onListClick);
      list.removeEventListener("dblclick", onListDblClick);
      list.removeEventListener("contextmenu", onContextMenu);
      list.removeEventListener("keydown", onListKey);
      if (inertShown) host.inert = false;
      host.textContent = "";
      rows.clear();
    },
  };
}
