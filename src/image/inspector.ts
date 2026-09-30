// The image editor's inspector (right-docked, the video inspector's markup and
// classes): the selected layer's position, scale, rotation, flips, opacity and
// crop, a photo's adjustments, the text/solid generator controls, a drawing's
// stroke count — or, with nothing selected, the image's size and background.
//
// Live commit, as in the video inspector: continuous changes go through
// session.replace() (no history), and ONE history entry lands on release via
// commitFrom(before). Both hard-won fixes from there are kept — begin() on
// every input event (a range fires input+change per arrow key, so a second
// nudge arrives after the first commit), and a focusout commit (focus can
// leave without a change event). Stricter here:
//   * a pending gesture is COMMITTED before anything tears it down (a layer
//     switch mid-drag, a rebuild, dispose) or anything else takes the pointer
//     (a press outside the panel), never dropped: dropping it left the live
//     edit in the project with no undo step;
//   * a commit lands only if the project is still the one the gesture wrote —
//     another writer in between (a canvas tool, an undo) means the step is
//     dropped rather than pushed over theirs (see createGestures);
//   * autosave is held while the pointer is down on a slider, so a
//     half-dragged slider is never what lands on disk (the image editor's
//     pointer-down rule); a typed edit is not held;
//   * during a crop the panel is inert.
//
// REBUILD DISCIPLINE. `layersOf` hands back fresh Layer objects on every
// project change, and the select tool replace()s on every pointermove — so
// "rebuild when the layer changed" would rebuild the whole panel per mouse
// move. The panel rebuilds only when its STRUCTURE changes (another layer,
// another kind, a text/solid generator edited through its own section);
// otherwise every control re-reads its value and writes the DOM only when
// that value moved (the idempotent-write pattern). Nothing at all happens
// while a gesture of ours is pending. Idle cost: zero — no timers, no rAF;
// the one document listener (the outside press) returns on an integer compare
// while nothing is pending.

import "../editor/inspector/inspector.css";
import "./inspector.css";
import { escapeHtml } from "../core/format";
import { describeError } from "../core/ipc";
import { normalizeHexColor } from "../core/session";
import type { ClipAdjust, ClipCrop, ClipTransform, ProjectFile, Stroke } from "../core/types";
import { buildGeneratedSection } from "../editor/inspector/generated";
import type { ColorPickerHandle } from "../ui/color-picker";
import { toast } from "../ui/toast";
import { ADJUST_IDENTITY, isIdentityAdjust } from "./adjust/plan";
import { openCanvasSizeDialog } from "./canvas-size-dialog";
import type { ImageEditorCtx } from "./context";
import { IMAGE_SCALE_GUARD, layerToCanvas, visibleBox } from "./geom";
import { imgIcon } from "./icons";
import {
  eraseStrokes,
  findLayer,
  setBackground,
  setLayerAdjust,
  setLayerTransform,
  type Layer,
} from "./layers";
import { forEachStroke, strokeCount } from "./strokes";

/* ------------------------------------------------------------------ */
/* Pure rules (exported for the tests)                                 */
/* ------------------------------------------------------------------ */

/** A typed Scale % as a layer scale (canvas px per source px; 100 % = actual
 *  pixels). Any positive size is allowed — there is no 10-400 % window in an
 *  image project — so only a value that could not describe a size (0, a
 *  negative, not a number) is refused, as null. The crafted-file guard is the
 *  only bound. */
export function scaleFromPercent(v: number): number | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.min(Math.max(v / 100, IMAGE_SCALE_GUARD.min), IMAGE_SCALE_GUARD.max);
}

/** The scale that shows the layer's whole visible (cropped, turned) box as
 *  large as fits inside the canvas. */
export function fitScale(t: ClipTransform, srcW: number, srcH: number, W: number, H: number): number {
  const box = visibleBox(t, srcW, srcH);
  const quarter = t.rotate === 90 || t.rotate === 270;
  const bw = quarter ? box.h : box.w;
  const bh = quarter ? box.w : box.h;
  const k = Math.min(W / bw, H / bh);
  return Number.isFinite(k) && k > 0
    ? Math.min(Math.max(k, IMAGE_SCALE_GUARD.min), IMAGE_SCALE_GUARD.max)
    : 1;
}

/** The four crop fields as a crop, in whole source px: undefined when it is
 *  the whole source (stored as no crop), null when it does not fit inside the
 *  source — refused, the video inspector's rule, rather than silently moved
 *  somewhere the user did not type. The floor is one pixel, as on the canvas:
 *  an image layer may legitimately be a sliver. */
export function parseCrop(
  x: number,
  y: number,
  w: number,
  h: number,
  srcW: number,
  srcH: number,
): ClipCrop | undefined | null {
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const c = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  if (c.x < 0 || c.y < 0 || c.w < 1 || c.h < 1 || c.x + c.w > srcW || c.y + c.h > srcH) return null;
  return c.x === 0 && c.y === 0 && c.w === srcW && c.h === srcH ? undefined : c;
}

/** A new crop with the SOURCE pinned on the canvas: every canvas point of a
 *  layer is centre + L·(p − cropCentre), so the pixels that stay visible stay
 *  where they were when the centre moves by L·(cropCentre' − cropCentre). The
 *  on-canvas crop keeps the same invariant; without it Apply would jump the
 *  remaining picture to where the old crop's centre was. */
export function pinnedCrop(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  W: number,
  H: number,
  crop: ClipCrop | undefined,
): Pick<ClipTransform, "crop" | "x" | "y"> {
  const m = layerToCanvas(t, srcW, srcH, W, H);
  const was = visibleBox(t, srcW, srcH);
  const now = visibleBox({ ...t, crop }, srcW, srcH);
  const dx = now.x + now.w / 2 - (was.x + was.w / 2);
  const dy = now.y + now.h / 2 - (was.y + was.h / 2);
  return { crop, x: t.x + m[0] * dx + m[2] * dy, y: t.y + m[1] * dx + m[3] * dy };
}

export type BackgroundChoice = "transparent" | "white" | "black" | "color";

/** The background button set, in order. `value` is what `setBackground` gets;
 *  "color" has none — it opens the picker. */
export const BACKGROUND_CHOICES: readonly { id: BackgroundChoice; label: string; value: string | null }[] = [
  { id: "transparent", label: "Transparent", value: "transparent" },
  { id: "white", label: "White", value: "#ffffff" },
  { id: "black", label: "Black", value: "#000000" },
  { id: "color", label: "Color", value: null },
];

/** Which button is on for a stored background. Absent or unreadable is
 *  transparent — the renderer's own reading. */
export function backgroundChoiceOf(bg: string | undefined): BackgroundChoice {
  const v = bg === undefined || bg === "transparent" ? "" : normalizeHexColor(bg, "");
  if (v === "") return "transparent";
  if (v === "#ffffff") return "white";
  if (v === "#000000") return "black";
  return "color";
}

/** The stored background as the setBackground value it stands for:
 *  "transparent" or a lowercase #rrggbb. */
function bgNow(p: ProjectFile): string {
  const bg = p.image?.background;
  return backgroundChoiceOf(bg) === "transparent" ? "transparent" : normalizeHexColor(bg, "");
}

/** A background wants its own shelf, not the accent spread: paper whites,
 *  greys, black, and a few soft tints. */
const BACKGROUND_PRESETS = [
  "#ffffff", "#f4f1ea", "#e5e5e5", "#a3a3a3", "#525252", "#000000",
  "#fde68a", "#fecaca", "#ddd6fe", "#bfdbfe", "#bbf7d0", "#1e293b",
] as const;

/** The nine adjustments, in the order the panel lists them. */
const ADJUST_ROWS: readonly { key: keyof ClipAdjust; label: string }[] = [
  { key: "exposure", label: "Exposure" },
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "saturation", label: "Saturation" },
  { key: "warmth", label: "Warmth" },
  { key: "tint", label: "Tint" },
  { key: "hue", label: "Hue" },
];

const ADJUST_HINT = "Select a photo layer to adjust it.";

/** "+17", "0", "−23" — a real minus, so the column lines up in mono. */
const signed = (v: number): string => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
/** At most two decimals, no trailing zeros ("12.5", not "12.50"). */
const short = (v: number): string => String(Number(v.toFixed(2)));
/** A number input's value as a number; an empty or half-typed field ("-",
 *  "1e") reads "" and must not count as 0. */
const numOf = (input: HTMLInputElement): number =>
  input.value.trim() === "" ? Number.NaN : Number(input.value);

/** "Nothing written yet" for `watch`, distinct from every model value. */
const UNSET: unique symbol = Symbol("unset");

/** Identity stamp of a MediaRef, for the structural key: a text/solid section
 *  is built from its generator, so an edit through it (a new MediaRef) is a
 *  rebuild; a photo's or drawing's media changing is only a value refresh. */
const mediaStamps = new WeakMap<object, number>();
let nextStamp = 1;
function stampOf(o: object): number {
  let s = mediaStamps.get(o);
  if (s === undefined) {
    s = nextStamp++;
    mediaStamps.set(o, s);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Gestures (live edit → one commit)                                   */
/* ------------------------------------------------------------------ */

/** One control's live edit. `begin` snapshots the project the step undoes
 *  to; `write` runs a replace() through the gesture so it knows which project
 *  is ITS; `hold` takes the autosave hold (the pointer-down path only);
 *  `commit` lands the step and releases the hold. */
export interface Gesture {
  begin(): void;
  hold(): void;
  write(apply: () => void): void;
  commit(): void;
}

export interface GestureSet {
  gesture(): Gesture;
  /** Commit every pending gesture (a teardown or an outside press is about
   *  to take its control). */
  flush(): void;
  readonly pending: number;
}

/** The inspector's gesture bookkeeping, apart from the DOM so its rules can be
 *  pinned. The one hazard it exists for: another writer (the canvas select
 *  tool, an undo) can replace the project while an edit of ours is pending —
 *  the canvas presses preventDefault, so focus never leaves the field. A late
 *  commitFrom(before) would then push our stale snapshot OVER that writer's
 *  step, and a second undo would bring the typed value back from the dead.
 *  So a commit lands only while the project is still the one this gesture
 *  last wrote; otherwise it is dropped — at worst one undo step lost, never a
 *  value resurrected. A write after such an interruption re-bases on the
 *  project as it is now, for the same reason. */
export function createGestures(
  session: { readonly project: ProjectFile; commitFrom(before: ProjectFile): void },
  holdAutosave: () => () => void,
): GestureSet {
  const pending = new Set<Gesture>();

  function gesture(): Gesture {
    let before: ProjectFile | null = null;
    /** The project this gesture's last write left; `before` until one lands. */
    let written: ProjectFile | null = null;
    let release: (() => void) | null = null;
    const g: Gesture = {
      begin() {
        if (before) return;
        before = session.project;
        written = before;
        pending.add(g);
      },
      hold() {
        g.begin();
        release ??= holdAutosave();
      },
      write(apply) {
        g.begin();
        if (session.project !== written) before = session.project;
        apply();
        written = session.project;
      },
      commit() {
        const b = before;
        const mine = session.project === written;
        before = null;
        written = null;
        pending.delete(g);
        if (b && mine) session.commitFrom(b);
        release?.();
        release = null;
      },
    };
    return g;
  }

  return {
    gesture,
    flush() {
      for (const g of [...pending]) g.commit();
    },
    get pending() {
      return pending.size;
    },
  };
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

export function mountImageInspector(host: HTMLElement, ctx: ImageEditorCtx): { dispose(): void } {
  host.classList.add("inspector");
  const { session } = ctx;

  let disposed = false;
  /** Listener teardown for the current build. */
  let cleanup: (() => void)[] = [];
  /** Value refreshers for the current build (see REBUILD DISCIPLINE). */
  let syncs: (() => void)[] = [];
  /** The structure the DOM was built for. */
  let builtKey: string | null = null;

  /* -------- gestures (live edit → one commit) -------- */

  const gestures = createGestures(session, () => ctx.holdAutosave());
  const gesture = gestures.gesture;
  const flushGestures = gestures.flush;

  /* -------- small builders -------- */

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function on<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void): void {
    const h = fn as EventListener;
    target.addEventListener(type, h);
    cleanup.push(() => target.removeEventListener(type, h));
  }

  /** Register a refresher and run it once. `read` yields the model value;
   *  `write` touches the DOM only when it differs from the last one written. */
  function watch<T>(read: () => T, write: (v: T) => void): void {
    let last: T | typeof UNSET = UNSET;
    const run = (): void => {
      const v = read();
      if (Object.is(v, last)) return;
      last = v;
      write(v);
    };
    run();
    syncs.push(run);
  }

  function section(title: string): HTMLElement {
    const s = el("div", "insp-section");
    s.appendChild(el("div", "insp-section__title", title));
    return s;
  }

  function field(label: string, control: HTMLElement): HTMLElement {
    const f = el("div", "field insp-field");
    f.appendChild(el("label", undefined, label));
    f.appendChild(control);
    return f;
  }

  /** A button that gives focus back after a POINTER click, so a following
   *  Space (hold to pan) cannot press it again. A keyboard activation keeps
   *  focus where the user put it. */
  function button(html: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = el("button", cls);
    b.type = "button";
    b.innerHTML = html;
    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }
    on<MouseEvent>(b, "click", (e) => {
      if (e.detail > 0) b.blur();
      onClick();
    });
    return b;
  }

  function switchToggle(label: string, read: () => boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const input = el("input", "switch");
    input.type = "checkbox";
    input.setAttribute("aria-label", label);
    on(input, "change", () => onChange(input.checked));
    // Same reason as button(): Space on a still-focused switch would flip it.
    on<MouseEvent>(input, "click", (e) => {
      if (e.detail > 0) input.blur();
    });
    watch(read, (v) => {
      input.checked = v;
    });
    return input;
  }

  const commit = (mutate: (p: ProjectFile) => ProjectFile): void => {
    session.commit(mutate);
  };

  interface SliderOpts {
    min: number;
    max: number;
    read: () => number;
    format: (v: number) => string;
    apply: (v: number) => void;
    disabledHint?: string;
    label: string;
  }

  /** Live-commit slider with a readout and a numeric twin (the video
   *  inspector's `.insp-slider`). Integer steps. */
  function slider(o: SliderOpts): HTMLElement {
    const wrap = el("div", "insp-slider");
    const range = el("input", "slider");
    range.type = "range";
    range.min = String(o.min);
    range.max = String(o.max);
    range.step = "1";
    range.setAttribute("aria-label", o.label);
    const readout = el("div", "insp-slider__value mono");
    const num = el("input", "input insp-num insp-num--twin");
    num.type = "number";
    num.min = String(o.min);
    num.max = String(o.max);
    num.step = "1";
    num.setAttribute("aria-label", o.label);
    wrap.append(range, readout, num);

    const paint = (v: number): void => {
      range.value = String(v);
      num.value = String(v);
      readout.textContent = o.format(v);
    };

    if (o.disabledHint !== undefined) {
      paint(0);
      range.disabled = true;
      num.disabled = true;
      range.title = o.disabledHint;
      num.title = o.disabledHint;
      return wrap;
    }
    watch(o.read, paint);

    const clampRange = (v: number): number => Math.min(Math.max(Math.round(v), o.min), o.max);
    const g = gesture();
    const onRange = (): void => {
      const v = clampRange(Number(range.value));
      num.value = String(v);
      readout.textContent = o.format(v);
      g.write(() => o.apply(v));
    };
    const onNum = (): void => {
      const raw = numOf(num);
      if (!Number.isFinite(raw)) return;
      const v = clampRange(raw);
      range.value = String(v);
      readout.textContent = o.format(v);
      g.write(() => o.apply(v));
    };
    const done = (): void => {
      g.commit();
      sync();
    };
    // The autosave hold is the pointer-down rule and nothing more: a typed or
    // arrow-key edit keeps its one-step history but never holds the save (a
    // field left focused over an alt-tab would hold it indefinitely).
    on(range, "pointerdown", () => g.hold());
    on(range, "input", onRange);
    on(range, "change", done);
    on(range, "pointerup", done);
    on(range, "focusout", done);
    on(num, "input", onNum);
    on(num, "change", done);
    on(num, "focusout", done);
    return wrap;
  }

  /** Live-commit number input: any finite value the `parse` rule accepts is
   *  applied as it is typed; a refused one is ignored, and the field shows the
   *  real value again when editing ends. */
  function numberInput(o: {
    label: string;
    read: () => number;
    format: (v: number) => string;
    parse: (raw: number) => number | null;
    apply: (v: number) => void;
  }): HTMLInputElement {
    const input = el("input", "input insp-num");
    input.type = "number";
    input.step = "any";
    input.setAttribute("aria-label", o.label);
    watch(o.read, (v) => {
      input.value = o.format(v);
    });
    const g = gesture();
    on(input, "input", () => {
      const v = o.parse(numOf(input));
      if (v === null) return;
      g.write(() => o.apply(v));
    });
    const done = (): void => {
      g.commit();
      // A refused or half-typed entry leaves the model where it was; show it.
      input.value = o.format(o.read());
      sync();
    };
    on(input, "change", done);
    on(input, "focusout", done);
    return input;
  }

  /* -------- the selected layer, read fresh every time -------- */

  const selected = (): Layer | undefined => {
    const id = ctx.selection.get();
    return id === null ? undefined : findLayer(session.project, id);
  };

  /** The selected layer's transform NOW (not at build time: an undo, a canvas
   *  drag or another control may have moved it since). */
  const tf = (trackId: string): ClipTransform | undefined => findLayer(session.project, trackId)?.transform;

  const setTf = (trackId: string, patch: Partial<ClipTransform>): void => {
    session.replace(setLayerTransform(session.project, trackId, patch));
  };

  const dims = (l: Layer): { w: number; h: number } => ({
    w: l.media.width && l.media.width > 0 ? l.media.width : 1,
    h: l.media.height && l.media.height > 0 ? l.media.height : 1,
  });

  /* -------- sections -------- */

  function buildHeader(l: Layer): HTMLElement {
    const header = el("div", "insp-header");
    const name = el("div", "insp-header__name");
    watch(
      () => selected()?.name ?? l.name,
      (v) => {
        name.textContent = v;
      },
    );
    header.appendChild(name);
    const meta = el("div", "insp-header__meta");
    meta.appendChild(el("span", "badge", l.kind));
    if (l.kind === "photo") {
      const size = el("span", "insp-header__dur mono");
      watch(
        () => {
          const cur = selected();
          return cur ? `${cur.media.width ?? "?"} × ${cur.media.height ?? "?"}` : "";
        },
        (v) => {
          size.textContent = v;
        },
      );
      meta.appendChild(size);
    }
    header.appendChild(meta);
    return header;
  }

  function buildLayerSection(l: Layer): HTMLElement {
    const s = section("Layer");
    const id = l.trackId;

    // Position: offset of the layer's centre from the canvas centre, canvas
    // px. NOT rounded: an odd-sized layer on an even canvas sits on whole
    // pixels only at a .5 offset.
    const pos = el("div", "insp-row");
    for (const axis of ["x", "y"] as const) {
      pos.appendChild(
        field(
          axis.toUpperCase(),
          numberInput({
            label: `Position ${axis.toUpperCase()}`,
            read: () => tf(id)?.[axis] ?? 0,
            format: short,
            parse: (v) => (Number.isFinite(v) ? v : null),
            apply: (v) => setTf(id, { [axis]: v }),
          }),
        ),
      );
    }
    s.appendChild(pos);

    // Scale, in percent of actual pixels.
    s.appendChild(
      field(
        "Scale (%)",
        numberInput({
          label: "Scale in percent",
          read: () => tf(id)?.scale ?? 1,
          format: (k) => short(k * 100),
          parse: scaleFromPercent,
          apply: (k) => setTf(id, { scale: k }),
        }),
      ),
    );
    const sizeRow = el("div", "insp-row");
    sizeRow.appendChild(
      button("Fit to canvas", "btn btn--sm", () => {
        const cur = findLayer(session.project, id);
        if (!cur) return;
        const { w, h } = dims(cur);
        const { width: W, height: H } = session.project.timeline;
        commit((p) => setLayerTransform(p, id, { scale: fitScale(cur.transform, w, h, W, H), x: 0, y: 0 }));
      }),
    );
    sizeRow.appendChild(button("Actual size", "btn btn--sm", () => commit((p) => setLayerTransform(p, id, { scale: 1 }))));
    s.appendChild(sizeRow);

    // Rotation: quarter turns about the layer's own centre.
    const rot = el("div", "insp-readout");
    rot.appendChild(el("span", undefined, "Rotation"));
    const rotVal = el("span", "mono");
    rot.appendChild(rotVal);
    watch(
      () => tf(id)?.rotate ?? 0,
      (v) => {
        rotVal.textContent = `${v}°`;
      },
    );
    s.appendChild(rot);
    const turn = (by: 90 | 270): void => {
      const cur = tf(id);
      if (!cur) return;
      commit((p) => setLayerTransform(p, id, { rotate: ((cur.rotate + by) % 360) as ClipTransform["rotate"] }));
    };
    const rotRow = el("div", "insp-row");
    rotRow.appendChild(button(`${imgIcon("rotateLeft", 14)}Left`, "btn btn--sm", () => turn(270), "Rotate left"));
    rotRow.appendChild(button(`${imgIcon("rotateRight", 14)}Right`, "btn btn--sm", () => turn(90), "Rotate right"));
    s.appendChild(rotRow);

    const flips = el("div", "insp-row");
    flips.appendChild(
      field(
        "Flip H",
        switchToggle(
          "Flip horizontally",
          () => tf(id)?.flipH ?? false,
          (v) => commit((p) => setLayerTransform(p, id, { flipH: v })),
        ),
      ),
    );
    flips.appendChild(
      field(
        "Flip V",
        switchToggle(
          "Flip vertically",
          () => tf(id)?.flipV ?? false,
          (v) => commit((p) => setLayerTransform(p, id, { flipV: v })),
        ),
      ),
    );
    s.appendChild(flips);

    s.appendChild(
      field(
        "Opacity",
        slider({
          label: "Opacity",
          min: 0,
          max: 100,
          read: () => Math.round((tf(id)?.opacity ?? 1) * 100),
          format: (v) => `${v}%`,
          apply: (v) => setTf(id, { opacity: v / 100 }),
        }),
      ),
    );

    if (l.kind !== "drawing") s.appendChild(buildCrop(id));
    return s;
  }

  function buildCrop(id: string): HTMLElement {
    const wrap = el("div", "insp-crop");
    wrap.appendChild(el("div", "insp-sublabel", "Crop"));
    const grid = el("div", "insp-crop__grid");
    const inputs = (["X", "Y", "W", "H"] as const).map((label) => {
      const input = el("input", "input insp-num");
      input.type = "number";
      input.step = "1";
      input.setAttribute("aria-label", `Crop ${label}`);
      grid.appendChild(field(label, input));
      return input;
    });
    wrap.appendChild(grid);
    // Refreshed only when the stored crop (or the source size) really
    // changes, so a half-typed crop survives unrelated edits elsewhere.
    watch(
      () => {
        const cur = findLayer(session.project, id);
        if (!cur) return "";
        const { w, h } = dims(cur);
        const c = cur.transform.crop ?? { x: 0, y: 0, w, h };
        return `${c.x},${c.y},${c.w},${c.h}`;
      },
      (v) => {
        const parts = v.split(",");
        inputs.forEach((input, i) => {
          input.value = parts[i] ?? "";
        });
      },
    );

    const setCrop = (crop: ClipCrop | undefined): void => {
      const cur = findLayer(session.project, id);
      if (!cur) return;
      const { w, h } = dims(cur);
      const { width: W, height: H } = session.project.timeline;
      commit((p) => setLayerTransform(p, id, pinnedCrop(cur.transform, w, h, W, H, crop)));
    };
    const btns = el("div", "insp-row");
    btns.appendChild(
      button("Apply", "btn btn--sm", () => {
        const cur = findLayer(session.project, id);
        if (!cur) return;
        const { w, h } = dims(cur);
        const [x, y, cw, ch] = inputs.map(numOf) as [number, number, number, number];
        const crop = parseCrop(x, y, cw, ch, w, h);
        if (crop === null) {
          toast.error(`Crop must fit inside ${w}×${h}.`);
          return;
        }
        setCrop(crop);
      }),
    );
    btns.appendChild(button("Clear", "btn btn--ghost btn--sm", () => setCrop(undefined)));
    wrap.appendChild(btns);
    return wrap;
  }

  function buildAdjustSection(l: Layer): HTMLElement {
    const s = section("Adjust");
    const photo = l.kind === "photo";
    const id = l.trackId;
    if (!photo) s.appendChild(el("div", "insp-note", ADJUST_HINT));

    const current = (): ClipAdjust => findLayer(session.project, id)?.clip.adjust ?? ADJUST_IDENTITY;
    for (const row of ADJUST_ROWS) {
      const range = row.key === "hue" ? 180 : 100;
      s.appendChild(
        field(
          row.label,
          slider({
            label: row.label,
            min: -range,
            max: range,
            read: () => current()[row.key],
            format: row.key === "hue" ? (v) => `${signed(v)}°` : signed,
            apply: (v) =>
              session.replace(setLayerAdjust(session.project, id, { ...current(), [row.key]: v })),
            disabledHint: photo ? undefined : ADJUST_HINT,
          }),
        ),
      );
    }
    if (photo) {
      const reset = button("Reset adjustments", "btn btn--ghost btn--sm insp-block", () =>
        commit((p) => setLayerAdjust(p, id, undefined)),
      );
      watch(
        () => isIdentityAdjust(findLayer(session.project, id)?.clip.adjust),
        (v) => {
          reset.disabled = v;
        },
      );
      s.appendChild(reset);
    }
    return s;
  }

  function buildDrawingSection(l: Layer): HTMLElement {
    const s = section("Drawing");
    const id = l.trackId;
    const chunksOf = (): readonly Stroke[][] => {
      const g = findLayer(session.project, id)?.media.generator;
      return g?.type === "drawing" ? g.chunks : [];
    };
    const row = el("div", "insp-readout");
    row.appendChild(el("span", undefined, "Strokes"));
    const count = el("span", "mono");
    row.appendChild(count);
    s.appendChild(row);
    // Every stroke gone in one commit: undo brings the whole drawing back.
    // Not btn--danger — it is undoable.
    const clear = button("Clear drawing", "btn btn--sm insp-block", () => {
      const all = new Set<Stroke>();
      forEachStroke(chunksOf(), (st) => all.add(st));
      if (all.size > 0) commit((p) => eraseStrokes(p, new Map([[id, all]])));
    });
    watch(
      () => strokeCount(chunksOf()),
      (n) => {
        count.textContent = String(n);
        clear.disabled = n === 0;
      },
    );
    s.appendChild(clear);
    return s;
  }

  /* -------- nothing selected: the image itself -------- */

  let picker: ColorPickerHandle | null = null;
  let pickerLoading = false;
  let unregisterPicker: (() => void) | null = null;

  function closePicker(): void {
    picker?.close();
  }

  function buildImagePanel(): HTMLElement {
    const wrap = el("div", "insp-project");
    const header = el("div", "insp-header");
    header.appendChild(el("div", "insp-header__name", "Image"));
    wrap.appendChild(header);

    const canvas = section("Canvas");
    const size = el("div", "insp-readout");
    size.appendChild(el("span", undefined, "Size"));
    const sizeVal = el("span", "mono");
    size.appendChild(sizeVal);
    watch(
      () => `${session.project.timeline.width} × ${session.project.timeline.height}`,
      (v) => {
        sizeVal.textContent = v;
      },
    );
    canvas.appendChild(size);
    canvas.appendChild(button("Change size", "btn btn--sm insp-block", () => openCanvasSizeDialog(ctx)));
    wrap.appendChild(canvas);

    const bgSec = section("Background");
    const grid = el("div", "imged-insp-bg");
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Background");
    const buttons = new Map<BackgroundChoice, HTMLButtonElement>();
    for (const choice of BACKGROUND_CHOICES) {
      const b = button(escapeHtml(choice.label), "btn btn--sm", () => {
        if (choice.value !== null) {
          const v = choice.value;
          commit((p) => setBackground(p, v));
        } else {
          openBackgroundPicker(b);
        }
      });
      if (choice.id === "color") {
        const sw = el("span", "imged-insp-swatch");
        sw.setAttribute("aria-hidden", "true");
        b.prepend(sw);
        // The literal pick, through the CSSOM (no style attribute survives the
        // packaged CSP). Hidden unless a colour of the user's is in use.
        watch(
          () => {
            const bg = session.project.image?.background;
            return backgroundChoiceOf(bg) === "color" ? normalizeHexColor(bg, "") : "";
          },
          (hex) => {
            sw.hidden = hex === "";
            sw.style.background = hex;
          },
        );
      }
      buttons.set(choice.id, b);
      grid.appendChild(b);
    }
    watch(
      () => backgroundChoiceOf(session.project.image?.background),
      (on) => {
        for (const [id, b] of buttons) {
          b.classList.toggle("btn--on", id === on);
          b.setAttribute("aria-pressed", String(id === on));
        }
      },
    );
    bgSec.appendChild(grid);
    wrap.appendChild(bgSec);
    return wrap;
  }

  function openBackgroundPicker(anchor: HTMLElement): void {
    if (picker) {
      picker.close();
      return;
    }
    if (pickerLoading) return;
    pickerLoading = true;
    // What the picker opens on, and what Escape goes back to. The picker only
    // speaks hex, so a transparent background opens it on white — and its
    // Escape ("the value it opened on") would then mean white. Escape is seen
    // here first instead (window capture runs before the picker's document
    // listener), so a cancel restores transparent, not white.
    const openBg = bgNow(session.project);
    let cancelled = false;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") cancelled = true;
    };
    // The project before the first preview of a gesture: previews replace(),
    // and each completed pick lands as ONE undo step from here.
    let before: ProjectFile | null = null;
    void import("../ui/color-picker")
      .then(({ openColorPicker }) => {
        pickerLoading = false;
        // (A crop may have begun while the module loaded: the panel is inert.)
        if (disposed || picker || !anchor.isConnected || ctx.mode.get() !== "idle") return;
        let closed = false;
        const handle = openColorPicker({
          anchor,
          value: openBg === "transparent" ? "#ffffff" : openBg,
          defaultValue: "#ffffff",
          label: "Background color",
          presets: BACKGROUND_PRESETS,
          onPreview: (hex) => {
            if (!before) before = session.project;
            session.replace(setBackground(session.project, hex));
          },
          onCommit: (hex) => {
            const target = cancelled ? openBg : normalizeHexColor(hex, "");
            const base = before ?? session.project;
            before = null;
            const cur = session.project;
            let next = cur;
            if (target !== "") {
              // Back exactly where this gesture began (a cancel, or a pick of
              // the starting colour): restore that very project, so no empty
              // undo step is recorded.
              if (bgNow(base) === target && cur.timeline === base.timeline && cur.media === base.media) next = base;
              else if (bgNow(cur) !== target) next = setBackground(cur, target);
            }
            session.replace(next);
            session.commitFrom(base);
          },
          onClose: () => {
            closed = true;
            window.removeEventListener("keydown", onKey, true);
            if (picker === handle) picker = null;
            unregisterPicker?.();
            unregisterPicker = null;
          },
        });
        if (closed) return;
        // Only once the picker is really open: a throw from openColorPicker
        // must not strand a capture listener on window. Window capture still
        // runs before the picker's own document listener, whatever the order
        // the two were added in.
        window.addEventListener("keydown", onKey, true);
        picker = handle;
        unregisterPicker = ctx.registerOverlay(() => handle.close());
      })
      .catch((e: unknown) => {
        pickerLoading = false;
        toast.error("Couldn't open the color picker.", { detail: describeError(e), op: "Image editor" });
      });
  }

  /* -------- rebuild / refresh -------- */

  function structKey(): string {
    const l = selected();
    if (!l) return "image";
    const gen = l.kind === "text" || l.kind === "solid" ? `|${stampOf(l.media)}` : "";
    return `${l.trackId}|${l.kind}${gen}`;
  }

  function clearBuild(): void {
    // Commit first: the controls holding these gestures are about to go.
    flushGestures();
    closePicker();
    for (const c of cleanup) c();
    cleanup = [];
    syncs = [];
  }

  function rebuild(key: string): void {
    clearBuild();
    host.replaceChildren();
    builtKey = key;
    const l = selected();
    if (!l) {
      host.appendChild(buildImagePanel());
      return;
    }
    host.appendChild(buildHeader(l));
    const body = el("div", "insp-body");
    if (l.kind === "text" || l.kind === "solid") {
      const gen = buildGeneratedSection(
        { session, refresh: () => ctx.requestRender() },
        { clip: l.clip, media: l.media },
        { sharedNote: false },
      );
      if (gen) body.appendChild(gen);
    } else if (l.kind === "drawing") {
      body.appendChild(buildDrawingSection(l));
    }
    body.appendChild(buildLayerSection(l));
    body.appendChild(buildAdjustSection(l));
    host.appendChild(body);
  }

  /** Values only, unless the structure changed. */
  function sync(): void {
    if (disposed || gestures.pending > 0) return;
    const key = structKey();
    if (key !== builtKey) {
      rebuild(key);
      return;
    }
    for (const s of syncs) s();
  }

  const unsubSel = ctx.selection.subscribe(() => {
    if (disposed) return;
    // A layer switch mid-drag lands the pending step on the layer it began
    // on, then shows the new one.
    flushGestures();
    sync();
  });
  const unsubSession = session.store.subscribe(() => sync());

  // A press anywhere outside the panel lands a pending edit FIRST. The canvas
  // tools preventDefault their pointerdown, so focus never leaves the field
  // and its focusout commit would otherwise arrive after the tool's own step
  // (createGestures drops that late commit rather than corrupt history — this
  // keeps the step instead). Capture phase, so it runs before the tool reads
  // the project; one integer compare per press while nothing is pending.
  const onPressOutside = (e: PointerEvent): void => {
    if (gestures.pending === 0) return;
    if (e.target instanceof Node && host.contains(e.target)) return;
    flushGestures();
  };
  document.addEventListener("pointerdown", onPressOutside, true);

  // While the stage is in a modal mode (a crop), the panel is inert, as the
  // layers panel is: an edit landing mid-crop would edit under the crop's
  // baseline. Pending work lands first, and the background picker — parked
  // on <body>, out of inert's reach — closes. Values keep refreshing, so the
  // panel is current the moment the crop ends.
  let inertShown = false;
  const paintInert = (): void => {
    const inert = ctx.mode.get() !== "idle";
    if (inert === inertShown) return;
    inertShown = inert;
    if (inert) {
      flushGestures();
      closePicker();
    }
    host.inert = inert;
  };
  const unsubMode = ctx.mode.subscribe(paintInert);

  rebuild(structKey());
  paintInert();

  return {
    dispose(): void {
      if (disposed) return;
      // First: clearBuild's flush and the picker's close both commit, and a
      // commit must not re-run sync() on a panel being torn down.
      disposed = true;
      clearBuild();
      document.removeEventListener("pointerdown", onPressOutside, true);
      unsubSel();
      unsubSession();
      unsubMode();
      host.inert = false;
      host.replaceChildren();
      host.classList.remove("inspector");
    },
  };
}
