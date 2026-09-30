// The image editor's tool row: the tools, their colour and size controls, and
// the ruler toggle. Writes `ctx.tools` (and the recent ink colours in
// Settings); never touches the project.
//
// Built from the video editor's own pieces so it reads as the same app: the
// transport row's `btn btn--ghost btn--icon btn--sm` buttons with `btn--on`,
// the monitor-volume flyout for the size slider, the Settings colour swatch
// ring, `select--sm`, and the shared colour picker (with its screen eyedropper).
//
// IDEMPOTENT PAINT. Every store notification funnels into `paint()`, which
// compares against what it last wrote and touches the DOM only where a value
// actually flipped — a colour-picker drag re-notifies the tool store every
// frame, and that must not rewrite six buttons' attributes each time. The
// titles carry the LIVE chord ("Pen (P)"), re-read when Settings change.

import type { ActionId, ShapeKind } from "../core/types";
import { describeError } from "../core/ipc";
import { blockShortcuts } from "../core/shortcuts";
import { INK_COLORS_MAX, normalizeHexColor, settingsStore, updateSettings } from "../core/session";
import type { ColorPickerHandle } from "../ui/color-picker";
import { toast } from "../ui/toast";
import type { ImageEditorCtx } from "./context";
import { imgIcon, type ImgIconName } from "./icons";
import { toggleRuler } from "./ink/ruler";
import { drawingTarget } from "./layers";
import { DEFAULT_TOOL_STATE, SIZE_MAX, SIZE_MIN, type ToolId, type ToolState } from "./tool-state";
import "./toolbar.css";

type ColorKey = keyof ToolState["colors"];
type SizeKey = keyof ToolState["sizes"];

const TOOLS: readonly { id: ToolId; action: ActionId; label: string; icon: ImgIconName }[] = [
  { id: "select", action: "imgSelect", label: "Select", icon: "select" },
  { id: "pen", action: "imgPen", label: "Pen", icon: "pen" },
  { id: "pencil", action: "imgPencil", label: "Pencil", icon: "pencil" },
  { id: "marker", action: "imgMarker", label: "Marker", icon: "marker" },
  { id: "eraser", action: "imgEraser", label: "Eraser", icon: "eraser" },
  { id: "shape", action: "imgShape", label: "Shapes", icon: "shapes" },
];

const COLOR_LABELS: Record<ColorKey, string> = { pen: "Pen", pencil: "Pencil", marker: "Marker", shape: "Shape" };

const SHAPES: readonly { id: ShapeKind; label: string }[] = [
  { id: "line", label: "Line" },
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "arrow", label: "Arrow" },
];

/** The base shelf under the recent colours: ink colours, not UI accents. The
 *  picker's row holds twelve; recents come first and these fill the rest. */
export const BASE_INK_COLORS: readonly string[] = [
  "#000000",
  "#ffffff",
  "#7f7f7f",
  "#e5484d",
  "#f76b15",
  "#ffd400",
  "#30a46c",
  "#12a594",
  "#0090ff",
  "#6e56cf",
  "#d6409f",
  "#8e4e1d",
];
const PRESET_ROW = 12;

export const HINT_NOTHING_TO_ERASE = "Nothing to erase on this layer.";

/** Recent colours (newest first) then the base shelf, deduped, twelve. */
export function inkPresets(recent: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of [...recent.slice(0, INK_COLORS_MAX), ...BASE_INK_COLORS]) {
    const c = normalizeHexColor(raw, "");
    if (c !== "" && !out.includes(c)) out.push(c);
    if (out.length === PRESET_ROW) break;
  }
  return out;
}

/** `hex` pushed to the front of the recents (deduped, at most six), or null
 *  when it is already first — no write for a colour that changes nothing. */
export function withRecent(recent: readonly string[], hex: string): string[] | null {
  const c = normalizeHexColor(hex, "");
  if (c === "" || recent[0] === c) return null;
  return [c, ...recent.filter((x) => x !== c)].slice(0, INK_COLORS_MAX);
}

/** The size slider is log-mapped (0..1000 → 1..200): the small sizes a pen
 *  lives at get most of the travel. */
const SLIDER_MAX = 1000;
export function sliderToSize(v: number): number {
  const t = Math.min(Math.max(v / SLIDER_MAX, 0), 1);
  return clampSize(Math.round(Math.exp(Math.log(SIZE_MIN) + t * (Math.log(SIZE_MAX) - Math.log(SIZE_MIN)))));
}
export function sizeToSlider(size: number): number {
  const s = clampSize(size);
  return Math.round(((Math.log(s) - Math.log(SIZE_MIN)) / (Math.log(SIZE_MAX) - Math.log(SIZE_MIN))) * SLIDER_MAX);
}
export function clampSize(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), SIZE_MIN), SIZE_MAX) : SIZE_MIN;
}
/** The size button's dot: 3..16 css px, log-scaled like the slider. */
export function dotDiameter(size: number): number {
  return Math.round(3 + (13 * sizeToSlider(size)) / SLIDER_MAX);
}

function colorKeyOf(tool: ToolId): ColorKey | null {
  return tool === "pen" || tool === "pencil" || tool === "marker" || tool === "shape" ? tool : null;
}
function sizeKeyOf(tool: ToolId): SizeKey | null {
  return tool === "select" ? null : tool;
}

/** "Pen (P)", or just "Pen" when the action has no chord. */
function titled(label: string, chord: string | undefined): string {
  return chord ? `${label} (${chord})` : label;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function iconButton(icon: ImgIconName, label: string): HTMLButtonElement {
  const b = el("button", "btn btn--ghost btn--icon btn--sm");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.innerHTML = imgIcon(icon);
  return b;
}

export function mountToolbar(host: HTMLElement, ctx: ImageEditorCtx): { dispose(): void } {
  let disposed = false;
  const cleanup: (() => void)[] = [];
  const on = <T extends EventTarget>(t: T, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void => {
    t.addEventListener(type, fn, opts);
    cleanup.push(() => t.removeEventListener(type, fn, opts));
  };

  const row = el("div", "imged-toolbar");
  row.setAttribute("role", "toolbar");
  row.setAttribute("aria-label", "Drawing tools");

  /* ---------- tools ---------- */

  const toolBtns = new Map<ToolId, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = iconButton(t.icon, t.label);
    b.dataset.tool = t.id;
    toolBtns.set(t.id, b);
    row.appendChild(b);
    on(b, "click", () => {
      ctx.tools.update((s) => (s.tool === t.id ? s : { ...s, tool: t.id }));
      // A focused button treats Space as a click; Space is the pan key here.
      b.blur();
    });
  }
  row.appendChild(separator());

  const rulerBtn = iconButton("ruler", "Ruler");
  row.appendChild(rulerBtn);
  on(rulerBtn, "click", () => {
    toggleRuler(ctx);
    rulerBtn.blur();
  });
  row.appendChild(separator());

  /* ---------- colour ---------- */

  const swatchBtn = el("button", "btn btn--ghost btn--icon btn--sm imged-swatch-btn");
  swatchBtn.type = "button";
  swatchBtn.setAttribute("aria-haspopup", "dialog");
  const swatch = el("span", "imged-swatch");
  swatchBtn.appendChild(swatch);
  row.appendChild(swatchBtn);

  let picker: ColorPickerHandle | null = null;
  /** The tool colour the open picker edits: its previews write THAT key, so
   *  the picker closes the moment the tool in hand stops being that one. */
  let pickerKey: ColorKey | null = null;
  let unregisterPicker: (() => void) | null = null;
  let pickerLoading = false;

  const setColor = (key: ColorKey, hex: string): void => {
    const c = normalizeHexColor(hex, "");
    if (c === "") return;
    ctx.tools.update((s) => (s.colors[key] === c ? s : { ...s, colors: { ...s.colors, [key]: c } }));
  };

  const pushRecent = (hex: string): void => {
    const next = withRecent(settingsStore.get().inkColors, hex);
    if (!next) return;
    void updateSettings({ inkColors: next }).catch((e: unknown) => {
      toast.error("Couldn't save your recent colors.", { detail: describeError(e), op: "Settings", title: "Save" });
    });
  };

  on(swatchBtn, "click", () => {
    swatchBtn.blur();
    if (picker) {
      picker.close();
      return;
    }
    const key = colorKeyOf(ctx.tools.get().tool);
    if (!key || pickerLoading) return;
    const opened = ctx.tools.get().colors[key];
    pickerLoading = true;
    import("../ui/color-picker")
      .then(({ openColorPicker }) => {
        pickerLoading = false;
        // The tool changed while the chunk loaded: the click was for a colour
        // the row no longer shows.
        if (disposed || picker || colorKeyOf(ctx.tools.get().tool) !== key) return;
        const handle = openColorPicker({
          anchor: swatchBtn,
          value: opened,
          defaultValue: DEFAULT_TOOL_STATE.colors[key],
          label: `${COLOR_LABELS[key]} color`,
          presets: inkPresets(settingsStore.get().inkColors),
          onPreview: (hex) => setColor(key, hex),
          onCommit: (hex) => {
            setColor(key, hex);
            // Escape commits the colour the picker opened on: not a new pick.
            if (normalizeHexColor(hex, "") !== normalizeHexColor(opened, "")) pushRecent(hex);
          },
          onClose: () => {
            if (picker === handle) {
              picker = null;
              pickerKey = null;
            }
            unregisterPicker?.();
            unregisterPicker = null;
          },
        });
        picker = handle;
        pickerKey = key;
        unregisterPicker = ctx.registerOverlay(() => handle.close());
      })
      .catch((e: unknown) => {
        pickerLoading = false;
        toast.error("Couldn't open the color picker.", { detail: describeError(e), op: "Image editor" });
      });
  });

  /* ---------- size ---------- */

  const sizeWrap = el("div", "imged-brush");
  const sizeBtn = el("button", "btn btn--ghost btn--icon btn--sm imged-brush__btn");
  sizeBtn.type = "button";
  sizeBtn.setAttribute("aria-haspopup", "true");
  sizeBtn.setAttribute("aria-expanded", "false");
  const dot = el("span", "imged-brush__dot");
  sizeBtn.appendChild(dot);
  const flyout = el("div", "imged-brush__flyout");
  flyout.hidden = true;
  const slider = el("input", "slider imged-brush__slider");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(SLIDER_MAX);
  slider.step = "1";
  slider.setAttribute("aria-label", "Brush size");
  const num = el("input", "input imged-brush__num mono");
  num.type = "number";
  num.min = String(SIZE_MIN);
  num.max = String(SIZE_MAX);
  num.step = "1";
  num.setAttribute("aria-label", "Brush size in pixels");
  const unit = el("span", "imged-brush__unit");
  unit.textContent = "px";
  flyout.append(slider, num, unit);
  sizeWrap.append(sizeBtn, flyout);
  row.appendChild(sizeWrap);

  const setSize = (v: number): void => {
    const key = sizeKeyOf(ctx.tools.get().tool);
    if (!key) return;
    const s = clampSize(v);
    ctx.tools.update((st) => (st.sizes[key] === s ? st : { ...st, sizes: { ...st.sizes, [key]: s } }));
  };

  let flyoutOpen = false;
  let releaseKeys: (() => void) | null = null;
  let unregisterFlyout: (() => void) | null = null;

  const onDocPointerDown = (e: Event): void => {
    if (!sizeWrap.contains(e.target as Node)) closeFlyout();
  };
  const openFlyout = (): void => {
    if (flyoutOpen) return;
    flyoutOpen = true;
    flyout.hidden = false;
    sizeBtn.setAttribute("aria-expanded", "true");
    // The flyout owns the keyboard while open: its range input answers arrows,
    // and no tool chord fires behind it.
    releaseKeys = blockShortcuts();
    unregisterFlyout = ctx.registerOverlay(closeFlyout);
    document.addEventListener("pointerdown", onDocPointerDown, true);
  };
  const closeFlyout = (): void => {
    if (!flyoutOpen) return;
    flyoutOpen = false;
    flyout.hidden = true;
    sizeBtn.setAttribute("aria-expanded", "false");
    releaseKeys?.();
    releaseKeys = null;
    const un = unregisterFlyout;
    unregisterFlyout = null;
    un?.();
    document.removeEventListener("pointerdown", onDocPointerDown, true);
  };
  cleanup.push(closeFlyout);

  on(sizeBtn, "click", () => {
    if (flyoutOpen) {
      closeFlyout();
      sizeBtn.blur();
    } else {
      openFlyout();
      // Straight to the slider: arrows adjust the size at once.
      slider.focus();
    }
  });
  on(flyout, "keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Escape" || k.key === "Enter") {
      k.preventDefault();
      k.stopPropagation();
      closeFlyout();
      sizeBtn.focus();
    }
  });
  on(sizeWrap, "focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    // null = focus went nowhere in particular (a click on the stage, a blur()):
    // the outside-pointer rule closes those. Only focus moving to another
    // control closes it here.
    if (next && !sizeWrap.contains(next)) closeFlyout();
  });
  on(slider, "input", () => {
    const v = sliderToSize(Number(slider.value));
    num.value = String(v);
    setSize(v);
  });
  on(num, "input", () => {
    const raw = Number(num.value);
    if (num.value === "" || !Number.isFinite(raw)) return;
    const v = clampSize(raw);
    slider.value = String(sizeToSlider(v));
    setSize(v);
  });
  const settleNum = (): void => {
    const key = sizeKeyOf(ctx.tools.get().tool);
    if (key) num.value = String(ctx.tools.get().sizes[key]);
  };
  on(num, "change", settleNum);
  on(num, "blur", settleNum);

  /* ---------- eraser mode, shape kind, hint ---------- */

  const seg = el("div", "imged-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Eraser mode");
  const strokeBtn = el("button", "btn btn--sm");
  strokeBtn.type = "button";
  strokeBtn.textContent = "Stroke";
  strokeBtn.title = "Erase whole strokes";
  const pixelBtn = el("button", "btn btn--sm");
  pixelBtn.type = "button";
  pixelBtn.textContent = "Pixel";
  pixelBtn.title = "Erase part of a drawing";
  seg.append(strokeBtn, pixelBtn);
  row.appendChild(seg);
  on(strokeBtn, "click", () => {
    ctx.tools.update((s) => (s.eraserMode === "stroke" ? s : { ...s, eraserMode: "stroke" }));
    strokeBtn.blur();
  });
  on(pixelBtn, "click", () => {
    ctx.tools.update((s) => (s.eraserMode === "pixel" ? s : { ...s, eraserMode: "pixel" }));
    pixelBtn.blur();
  });

  const shapeSel = el("select", "select select--sm imged-shape");
  shapeSel.setAttribute("aria-label", "Shape");
  shapeSel.title = "Shape";
  for (const s of SHAPES) {
    const o = el("option");
    o.value = s.id;
    o.textContent = s.label;
    shapeSel.appendChild(o);
  }
  row.appendChild(shapeSel);
  on(shapeSel, "change", () => {
    const v = shapeSel.value as ShapeKind;
    if (!SHAPES.some((s) => s.id === v)) return;
    ctx.tools.update((s) => (s.shape === v ? s : { ...s, shape: v }));
  });

  const hint = el("span", "imged-hint");
  hint.textContent = HINT_NOTHING_TO_ERASE;
  row.appendChild(hint);

  host.appendChild(row);

  /* ---------- paint (writes only what flipped) ---------- */

  const shown = {
    tool: null as ToolId | null,
    titles: new Map<HTMLElement, string>(),
    ruler: null as boolean | null,
    colorVisible: null as boolean | null,
    color: "",
    sizeVisible: null as boolean | null,
    size: -1,
    eraserVisible: null as boolean | null,
    eraserMode: "",
    shapeVisible: null as boolean | null,
    shape: "",
    hint: null as boolean | null,
  };

  const setTitle = (b: HTMLElement, t: string): void => {
    if (shown.titles.get(b) === t) return;
    shown.titles.set(b, t);
    b.title = t;
  };
  const setHidden = (e: HTMLElement, hidden: boolean): void => {
    if (e.hidden !== hidden) e.hidden = hidden;
  };
  const setPressed = (b: HTMLElement, onState: boolean): void => {
    b.classList.toggle("btn--on", onState);
    b.setAttribute("aria-pressed", String(onState));
  };

  /** Pixel mode with no drawing layer to cut: the target would be a NEW layer. */
  const nothingToErase = (s: ToolState): boolean => {
    if (s.tool !== "eraser" || s.eraserMode !== "pixel") return false;
    try {
      return "create" in drawingTarget(ctx.session.project, ctx.selection.get());
    } catch {
      return false;
    }
  };

  const paint = (): void => {
    if (disposed) return;
    const s = ctx.tools.get();
    const chords = settingsStore.get().shortcuts;

    for (const t of TOOLS) setTitle(toolBtns.get(t.id)!, titled(t.label, chords[t.action]));
    setTitle(rulerBtn, titled("Ruler", chords.imgRuler));

    if (shown.tool !== s.tool) {
      for (const [id, b] of toolBtns) {
        const was = shown.tool === id;
        const is = s.tool === id;
        if (shown.tool === null || was !== is) setPressed(b, is);
      }
      shown.tool = s.tool;
    }

    const rulerOn = s.ruler !== null;
    if (shown.ruler !== rulerOn) {
      shown.ruler = rulerOn;
      setPressed(rulerBtn, rulerOn);
    }

    const ck = colorKeyOf(s.tool);
    const colorVisible = ck !== null;
    if (shown.colorVisible !== colorVisible) {
      shown.colorVisible = colorVisible;
      setHidden(swatchBtn, !colorVisible);
    }
    if (ck) {
      const c = normalizeHexColor(s.colors[ck], "#000000");
      if (shown.color !== c) {
        shown.color = c;
        swatch.style.background = c;
      }
      setTitle(swatchBtn, `${COLOR_LABELS[ck]} color`);
    }
    // A tool switch (shortcut) with the picker open: a picker left editing the
    // pen while the swatch shows the marker would paint the wrong colour.
    if (picker && pickerKey !== ck) picker.close();

    const sk = sizeKeyOf(s.tool);
    const sizeVisible = sk !== null;
    if (shown.sizeVisible !== sizeVisible) {
      shown.sizeVisible = sizeVisible;
      setHidden(sizeWrap, !sizeVisible);
    }
    if (!sizeVisible) closeFlyout();
    if (sk) {
      const size = clampSize(s.sizes[sk]);
      if (shown.size !== size) {
        shown.size = size;
        const d = dotDiameter(size);
        dot.style.width = `${d}px`;
        dot.style.height = `${d}px`;
        // Never fight the field the user is holding.
        if (document.activeElement !== slider) slider.value = String(sizeToSlider(size));
        if (document.activeElement !== num) num.value = String(size);
      }
      setTitle(sizeBtn, `Size: ${size} px`);
    }

    const eraserVisible = s.tool === "eraser";
    if (shown.eraserVisible !== eraserVisible) {
      shown.eraserVisible = eraserVisible;
      setHidden(seg, !eraserVisible);
    }
    if (shown.eraserMode !== s.eraserMode) {
      shown.eraserMode = s.eraserMode;
      setPressed(strokeBtn, s.eraserMode === "stroke");
      setPressed(pixelBtn, s.eraserMode === "pixel");
    }

    const shapeVisible = s.tool === "shape";
    if (shown.shapeVisible !== shapeVisible) {
      shown.shapeVisible = shapeVisible;
      setHidden(shapeSel, !shapeVisible);
    }
    if (shown.shape !== s.shape) {
      shown.shape = s.shape;
      shapeSel.value = s.shape;
    }

    const showHint = nothingToErase(s);
    if (shown.hint !== showHint) {
      shown.hint = showHint;
      setHidden(hint, !showHint);
    }
  };

  // The hint depends on the project and the selection, but only matters in
  // pixel-erase mode; the project listener is a no-op otherwise.
  let lastTimeline = ctx.session.project.timeline;
  const unTools = ctx.tools.subscribe(paint);
  const unSel = ctx.selection.subscribe(paint);
  const unProject = ctx.session.store.subscribe((p) => {
    if (p.timeline === lastTimeline) return;
    lastTimeline = p.timeline;
    const s = ctx.tools.get();
    if (s.tool === "eraser" && s.eraserMode === "pixel") paint();
  });
  let lastShortcuts = settingsStore.get().shortcuts;
  const unSettings = settingsStore.subscribe((st) => {
    if (st.shortcuts === lastShortcuts) return;
    lastShortcuts = st.shortcuts;
    paint();
  });
  paint();

  return {
    dispose(): void {
      if (disposed) return;
      picker?.close();
      disposed = true;
      unTools();
      unSel();
      unProject();
      unSettings();
      for (const fn of cleanup) fn();
      row.remove();
    },
  };
}

function separator(): HTMLElement {
  const s = el("span", "imged-sep");
  s.setAttribute("aria-hidden", "true");
  return s;
}
