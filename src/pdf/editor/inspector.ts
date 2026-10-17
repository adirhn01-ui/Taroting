// The PDF editor's right-hand panel — the video inspector's markup and sheet
// (.insp-section, .insp-slider, the twin number), one of four panels:
//   - marks selected → their properties: colour, width, opacity, the text
//     style, Delete;
//   - only pages selected (the rail) → "N pages selected", turn, delete;
//   - Fill forms mode → a note (the tools are off);
//   - otherwise → the active tool's style: colour, size, font.
//
// Live commit, as in the image inspector: a control's continuous changes go
// through session.replace() and ONE history step lands when the gesture ends
// (commitFrom(before)); a commit lands only if the project is still the one
// this gesture last wrote (another writer in between wins). Tool style edits
// write ctx.tools only — never the project, never history.
//
// REBUILD DISCIPLINE: the panel rebuilds only when its STRUCTURE changes
// (another panel kind, another mix of mark kinds); otherwise each control
// re-reads its value and writes the DOM only when it moved. Nothing at rest.

import "../../editor/inspector/inspector.css";
import "./marks/marks.css";
import type { FontFamily, PdfAnnot, ProjectFile, ShapeKind } from "../../core/types";
import { describeError } from "../../core/ipc";
import { INK_COLORS_MAX, normalizeHexColor, settingsStore, updateSettings } from "../../core/session";
import type { ColorPickerHandle } from "../../ui/color-picker";
import { toast } from "../../ui/toast";
import { imgIcon } from "../../image/icons";
import { deletePages, removeAnnots, rotatePages, updateAnnot, type PdfAnnotPatch } from "../model";
import type { PdfEditorCtx, PdfEditorPart, PdfToolId, PdfToolState } from "../types";
import { sameEdit } from "./marks/env";
import { FONT_MIN, SIZE_MAX, SIZE_MIN, clampFont, clampSize, frameOf, plainOnly, textHeight, withFrameH } from "./marks/geom";
import { textLines } from "./marks/render";
import { selectedMarks } from "./marks/select";

/* ------------------------------------------------------------------ */
/* Pure rules                                                          */
/* ------------------------------------------------------------------ */

export const FONTS: readonly FontFamily[] = ["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact"];

/** The image editor's base ink shelf (BASE_INK_COLORS, image/toolbar.ts —
 *  not importable from the PDF chunk). Recents first, these fill to twelve. */
export const BASE_INK_COLORS: readonly string[] = [
  "#000000", "#ffffff", "#7f7f7f", "#e5484d", "#f76b15", "#ffd400",
  "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8e4e1d",
];
const PRESET_ROW = 12;

/** Recent colours (newest first) then the base shelf, deduped, twelve
 *  (image/toolbar.ts inkPresets). */
export function inkPresets(recent: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of [...recent.slice(0, INK_COLORS_MAX), ...BASE_INK_COLORS]) {
    const c = normalizeHexColor(raw, "");
    if (c !== "" && !out.includes(c)) out.push(c);
    if (out.length === PRESET_ROW) break;
  }
  return out;
}

/** `hex` first in the recents (deduped, ≤ six), or null when already first
 *  (image/toolbar.ts withRecent). */
export function withRecent(recent: readonly string[], hex: string): string[] | null {
  const c = normalizeHexColor(hex, "");
  if (c === "" || recent[0] === c) return null;
  return [c, ...recent.filter((x) => x !== c)].slice(0, INK_COLORS_MAX);
}

type ColorKey = keyof PdfToolState["colors"];
type SizeKey = keyof PdfToolState["sizes"];

/** The tool colour a tool draws with (signature = the pen's), or null. */
export function toolColorKey(tool: PdfToolId): ColorKey | null {
  switch (tool) {
    case "highlight":
    case "pen":
    case "pencil":
    case "marker":
    case "shape":
    case "text":
      return tool;
    case "signature":
      return "pen";
    default:
      return null;
  }
}
export function toolSizeKey(tool: PdfToolId): SizeKey | null {
  return tool === "pen" || tool === "pencil" || tool === "marker" || tool === "eraser" || tool === "shape" || tool === "text" ? tool : null;
}

const SHAPE_CHOICES: readonly [ShapeKind, string][] = [
  ["line", "Line"],
  ["arrow", "Arrow"],
  ["rect", "Rectangle"],
  ["ellipse", "Ellipse"],
];

const TOOL_LABEL: Record<PdfToolId, string> = {
  select: "Select",
  highlight: "Highlight",
  pen: "Pen",
  pencil: "Pencil",
  marker: "Marker",
  eraser: "Eraser",
  shape: "Shapes",
  text: "Text",
  whiteout: "Whiteout",
  image: "Image",
  signature: "Signature",
};

const KIND_LABEL: Record<PdfAnnot["t"], string> = {
  ink: "Ink",
  highlight: "Highlight",
  text: "Text",
  line: "Line",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  whiteout: "Whiteout",
  image: "Image",
  signature: "Signature",
};

const hasColor = (a: PdfAnnot): boolean => a.t !== "image";
const hasWidth = (a: PdfAnnot): boolean => a.t === "ink" || a.t === "line" || a.t === "arrow" || a.t === "rect" || a.t === "ellipse";
const hasOpacity = (a: PdfAnnot): boolean => a.t === "ink" || a.t === "highlight";

/** Width limits in the panel, points. */
export const WIDTH_MIN = 0.5;
export const WIDTH_MAX = 72;

/** Which panel fields a mark kind takes: a field shared by name across kinds
 *  must not cross them (the Width control's `w` is a stroke width on ink and
 *  shapes, but a BOX width on text, whiteout, pictures and signatures). */
const FIELD_KINDS: Record<string, (a: PdfAnnot) => boolean> = {
  w: hasWidth,
  c: hasColor,
  o: hasOpacity,
  font: (a) => a.t === "text",
  size: (a) => a.t === "text",
  bold: (a) => a.t === "text",
  italic: (a) => a.t === "text",
  align: (a) => a.t === "text",
};

/** `patch` cut to the fields mark `a`'s kind takes from the panel. */
export function patchForKind(a: PdfAnnot, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    const ok = FIELD_KINDS[k];
    if (ok && ok(a)) out[k] = patch[k];
  }
  return out;
}

/** A patch for one mark: only the fields its kind takes; a text mark's box
 *  grows (along its upright frame's down direction) to keep every line. */
export function patchFor(a: PdfAnnot, patch: Record<string, unknown>): PdfAnnotPatch {
  const own = patchForKind(a, patch);
  if (a.t !== "text") return own as PdfAnnotPatch;
  const next = { ...a, ...own } as Extract<PdfAnnot, { t: "text" }>;
  const H = Math.max(frameOf(next).H, textHeight(textLines(next).length, next.size));
  if (H === frameOf(a).H) return own as PdfAnnotPatch;
  return { ...own, ...withFrameH(a, H) } as PdfAnnotPatch;
}

/** `p` with `patch` applied to every selected mark, each taking only the
 *  fields its kind has (see FIELD_KINDS). */
export function patchSelected(p: ProjectFile, sel: readonly { key: string; id: string }[], patch: Record<string, unknown>): ProjectFile {
  let next = p;
  for (const m of selectedMarks(p, sel)) {
    const own = patchFor(m.a, patch);
    if (Object.keys(own).length) next = updateAnnot(next, m.key, m.a.id, own);
  }
  return next;
}

/** A label for the selected marks: "Ink", "3 marks". */
export function selectionLabel(marks: readonly PdfAnnot[]): string {
  if (marks.length === 1) return KIND_LABEL[marks[0]!.t];
  return `${marks.length} marks`;
}

/* ------------------------------------------------------------------ */
/* Gestures (live edit → one step), as image/inspector.ts createGestures */
/* ------------------------------------------------------------------ */

interface Gesture {
  /** a live write; `apply` gets the gesture's START snapshot, so a value
   *  dragged up and back down lands from where it began (a text box grown
   *  by a large font size shrinks back when the size comes back down) */
  write(apply: (base: ProjectFile) => void): void;
  hold(): void;
  commit(): void;
}

export function createGestures(
  session: { readonly project: ProjectFile; commitFrom(before: ProjectFile): void },
  holdAutosave: () => () => void,
): { gesture(): Gesture; flush(): void; readonly pending: number } {
  const pending = new Set<Gesture>();
  const gesture = (): Gesture => {
    let before: ProjectFile | null = null;
    let written: ProjectFile | null = null;
    let release: (() => void) | null = null;
    const begin = (): void => {
      if (before) return;
      before = session.project;
      written = before;
      pending.add(g);
    };
    const g: Gesture = {
      hold() {
        begin();
        release ??= holdAutosave();
      },
      write(apply) {
        begin();
        if (!sameEdit(session.project, written!)) before = session.project;
        apply(before!);
        written = session.project;
      },
      commit() {
        const b = before;
        const mine = written !== null && sameEdit(session.project, written);
        before = null;
        written = null;
        pending.delete(g);
        if (b && mine && !sameEdit(session.project, b)) session.commitFrom(b);
        release?.();
        release = null;
      },
    };
    return g;
  };
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

const UNSET: unique symbol = Symbol("unset");

export const inspectorPart: PdfEditorPart = (ctx: PdfEditorCtx, hosts) => {
  const host = hosts.inspector;
  const { session } = ctx;
  host.classList.add("inspector");
  const root = document.createElement("div");
  root.className = "insp-body pdfmk-insp";
  host.appendChild(root);

  let disposed = false;
  let cleanup: (() => void)[] = [];
  let syncs: (() => void)[] = [];
  let builtKey: string | null = null;
  let picker: ColorPickerHandle | null = null;
  let unregisterPicker: (() => void) | null = null;
  let pickerLoading = false;
  const gestures = createGestures(session, () => ctx.holdAutosave());

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function on(t: EventTarget, type: string, fn: (e: Event) => void): void {
    t.addEventListener(type, fn);
    cleanup.push(() => t.removeEventListener(type, fn));
  }
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
  function button(html: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = el("button", cls);
    b.type = "button";
    b.innerHTML = html;
    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }
    on(b, "click", (e) => {
      if ((e as MouseEvent).detail > 0) b.blur();
      onClick();
    });
    return b;
  }

  const sel = (): { key: string; id: string }[] => ctx.selection.get();
  const marks = (): PdfAnnot[] => selectedMarks(session.project, sel()).map((m) => m.a);

  /* ---------- controls ---------- */

  const pushRecent = (hex: string): void => {
    const next = withRecent(settingsStore.get().inkColors, hex);
    if (!next) return;
    void updateSettings({ inkColors: next }).catch((e: unknown) => {
      toast.error("Couldn't save your recent colors.", { detail: describeError(e), op: "Settings", title: "Save" });
    });
  };

  interface ColorTarget {
    read(): string;
    /** a finished pick (swatch, picker commit) */
    commit(hex: string): void;
    /** a picker drag frame */
    preview(hex: string): void;
    /** the picker closed: land a pending preview */
    end(): void;
    label: string;
    fallback: string;
  }

  function colorRow(t: ColorTarget): HTMLElement {
    const wrap = el("div", "pdfmk-swatches");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", t.label);
    const swatches: { b: HTMLButtonElement; c: string }[] = [];
    for (const c of inkPresets(settingsStore.get().inkColors)) {
      const b = el("button", "pdfmk-swatch");
      b.type = "button";
      b.title = c;
      b.setAttribute("aria-label", c);
      b.style.background = c;
      on(b, "click", () => {
        t.commit(c);
        pushRecent(c);
      });
      swatches.push({ b, c });
      wrap.appendChild(b);
    }
    const more = el("button", "btn btn--ghost btn--icon btn--sm pdfmk-swatch-more");
    more.type = "button";
    more.title = "More colors";
    more.setAttribute("aria-label", "More colors");
    more.setAttribute("aria-haspopup", "dialog");
    const face = el("span", "pdfmk-swatch-face");
    more.appendChild(face);
    wrap.appendChild(more);
    watch(
      () => normalizeHexColor(t.read(), t.fallback),
      (cur) => {
        face.style.background = cur;
        for (const s of swatches) s.b.setAttribute("aria-pressed", String(s.c === cur));
      },
    );
    on(more, "click", () => {
      more.blur();
      if (picker) {
        picker.close();
        return;
      }
      if (pickerLoading) return;
      const opened = normalizeHexColor(t.read(), t.fallback);
      pickerLoading = true;
      import("../../ui/color-picker")
        .then(({ openColorPicker }) => {
          pickerLoading = false;
          if (disposed || picker) return;
          const handle = openColorPicker({
            anchor: more,
            value: opened,
            defaultValue: t.fallback,
            label: t.label,
            presets: inkPresets(settingsStore.get().inkColors),
            onPreview: (hex) => t.preview(hex),
            onCommit: (hex) => {
              t.preview(hex);
              t.end();
              if (normalizeHexColor(hex, "") !== opened) pushRecent(hex);
            },
            onClose: () => {
              if (picker === handle) picker = null;
              t.end();
              unregisterPicker?.();
              unregisterPicker = null;
            },
          });
          picker = handle;
          unregisterPicker = ctx.registerOverlay(() => handle.close());
        })
        .catch((e: unknown) => {
          pickerLoading = false;
          toast.error("Couldn't open the color picker.", { detail: describeError(e), op: "PDF editor" });
        });
    });
    return wrap;
  }

  interface SliderOpts {
    label: string;
    min: number;
    max: number;
    step: number;
    unit: string;
    read: () => number;
    /** live value; `done` once per finished gesture */
    write: (v: number) => void;
    done?: () => void;
    /** pointer-down on the range (the autosave hold, for marks) */
    hold?: () => void;
  }
  function slider(o: SliderOpts): HTMLElement {
    const wrap = el("div", "insp-slider");
    const range = el("input", "slider");
    range.type = "range";
    range.min = String(o.min);
    range.max = String(o.max);
    range.step = String(o.step);
    range.setAttribute("aria-label", o.label);
    const num = el("input", "input insp-num insp-num--twin");
    num.type = "number";
    num.min = String(o.min);
    num.max = String(o.max);
    num.step = String(o.step);
    num.setAttribute("aria-label", o.label);
    const unit = el("span", "pdfmk-insp-unit", o.unit);
    unit.setAttribute("aria-hidden", "true");
    wrap.append(range, num, unit);
    const fmt = (v: number): string => String(Math.round(v * 100) / 100);
    watch(o.read, (v) => {
      range.value = String(v);
      if (document.activeElement !== num) num.value = fmt(v);
    });
    const clamp = (v: number): number => Math.min(Math.max(v, o.min), o.max);
    on(range, "input", () => {
      const v = clamp(Number(range.value));
      num.value = fmt(v);
      o.write(v);
    });
    on(num, "input", () => {
      const raw = Number(num.value);
      if (num.value === "" || !Number.isFinite(raw)) return;
      const v = clamp(raw);
      range.value = String(v);
      o.write(v);
    });
    const done = (): void => {
      o.done?.();
      sync();
    };
    if (o.hold) on(range, "pointerdown", o.hold);
    on(range, "change", done);
    on(range, "pointerup", done);
    on(range, "focusout", done);
    on(num, "change", done);
    on(num, "focusout", done);
    return wrap;
  }

  /** A slider editing the selected marks: one history step per gesture. */
  function markSlider(label: string, min: number, max: number, step: number, unit: string, read: () => number, patch: (v: number) => Record<string, unknown>): HTMLElement {
    const g = gestures.gesture();
    return slider({
      label,
      min,
      max,
      step,
      unit,
      read,
      write: (v) => g.write((base) => session.replace(patchSelected(base, sel(), patch(v)))),
      done: () => g.commit(),
      hold: () => g.hold(),
    });
  }

  /** One finished edit of the selected marks: one history step. */
  const commitMarks = (patch: Record<string, unknown>): void => {
    const s = sel();
    session.commit((p) => patchSelected(p, s, patch));
  };

  function toggleBtn(label: string, html: string, read: () => boolean, onClick: () => void): HTMLButtonElement {
    const b = button(html, "btn btn--sm", onClick, label);
    watch(read, (v) => {
      b.classList.toggle("btn--on", v);
      b.setAttribute("aria-pressed", String(v));
    });
    return b;
  }

  function fontSelect(read: () => FontFamily, apply: (f: FontFamily) => void): HTMLSelectElement {
    const s = el("select", "select select--sm");
    s.setAttribute("aria-label", "Font");
    for (const f of FONTS) {
      const o = el("option", undefined, f);
      o.value = f;
      s.appendChild(o);
    }
    watch(read, (v) => {
      s.value = v;
    });
    on(s, "change", () => {
      const v = s.value as FontFamily;
      if (FONTS.includes(v)) apply(v);
    });
    return s;
  }

  /* ---------- panels ---------- */

  function buildMarks(list: PdfAnnot[]): void {
    const header = el("div", "insp-header");
    const name = el("div", "insp-header__name");
    watch(() => selectionLabel(marks()), (v) => (name.textContent = v));
    header.appendChild(name);
    root.appendChild(header);

    const first = <T,>(pick: (a: PdfAnnot) => T | undefined, fb: T): T => {
      for (const a of marks()) {
        const v = pick(a);
        if (v !== undefined) return v;
      }
      return fb;
    };

    const style = section("Style");
    let any = false;
    if (list.some(hasColor)) {
      any = true;
      const g = gestures.gesture();
      style.appendChild(
        field(
          "Color",
          colorRow({
            label: "Mark color",
            fallback: "#000000",
            read: () => first((a) => ("c" in a ? a.c : undefined), "#000000"),
            commit: (hex) => commitMarks({ c: normalizeHexColor(hex, "#000000") }),
            preview: (hex) => g.write((base) => session.replace(patchSelected(base, sel(), { c: normalizeHexColor(hex, "#000000") }))),
            end: () => g.commit(),
          }),
        ),
      );
    }
    if (list.some(hasWidth)) {
      any = true;
      style.appendChild(
        field(
          "Width",
          markSlider("Width in points", WIDTH_MIN, WIDTH_MAX, 0.5, "pt", () => first((a) => (hasWidth(a) && "w" in a ? a.w : undefined), 1), (v) => ({ w: v })),
        ),
      );
    }
    if (list.some(hasOpacity)) {
      any = true;
      style.appendChild(
        field(
          "Opacity",
          markSlider(
            "Opacity",
            0,
            100,
            1,
            "%",
            () => Math.round(first((a) => (hasOpacity(a) && "o" in a ? a.o : undefined), 1) * 100),
            (v) => ({ o: Math.min(Math.max(v / 100, 0), 1) }),
          ),
        ),
      );
    }
    if (any) root.appendChild(style);

    if (list.some((a) => a.t === "text")) {
      const t = section("Text");
      const text = (): Extract<PdfAnnot, { t: "text" }> | undefined => marks().find((a): a is Extract<PdfAnnot, { t: "text" }> => a.t === "text");
      t.appendChild(field("Font", fontSelect(() => text()?.font ?? "Segoe UI", (f) => commitMarks({ font: f }))));
      t.appendChild(
        field(
          "Size",
          markSlider("Font size in points", FONT_MIN, 96, 0.5, "pt", () => text()?.size ?? 12, (v) => ({ size: clampFont(v) })),
        ),
      );
      const styleRow = el("div", "insp-row");
      // a regular-only font (Impact) exports plain: no Bold / Italic for it
      const plain = (): boolean => plainOnly(text()?.font ?? "");
      const bold = toggleBtn("Bold", "<b>B</b>", () => !plain() && (text()?.bold ?? false), () => {
        if (!plain()) commitMarks({ bold: !(text()?.bold ?? false) });
      });
      const italic = toggleBtn("Italic", "<i>I</i>", () => !plain() && (text()?.italic ?? false), () => {
        if (!plain()) commitMarks({ italic: !(text()?.italic ?? false) });
      });
      watch(plain, (v) => {
        bold.disabled = v;
        italic.disabled = v;
      });
      styleRow.append(bold, italic);
      t.appendChild(styleRow);
      const alignRow = el("div", "insp-row");
      for (const [al, label] of [["left", "Left"], ["center", "Center"], ["right", "Right"]] as const) {
        alignRow.appendChild(toggleBtn(`Align ${label.toLowerCase()}`, label, () => (text()?.align ?? "left") === al, () => commitMarks({ align: al })));
      }
      t.appendChild(alignRow);
      root.appendChild(t);
    }

    const actions = section("Mark");
    actions.appendChild(
      button("Delete", "btn btn--sm insp-block", () => {
        const s = sel();
        session.commit((p) => removeAnnots(p, s.map((r) => ({ pageId: r.key, id: r.id }))));
        ctx.selection.set([]);
      }),
    );
    root.appendChild(actions);
  }

  function buildPages(): void {
    const header = el("div", "insp-header");
    const name = el("div", "insp-header__name");
    watch(
      () => ctx.pageSelection.get().length,
      (n) => (name.textContent = n === 1 ? "1 page selected" : `${n} pages selected`),
    );
    header.appendChild(name);
    root.appendChild(header);
    const ids = (): string[] => {
      const pages = session.project.pdf?.pages ?? [];
      return ctx.pageSelection.get().map((i) => pages[i]?.id).filter((x): x is string => !!x);
    };
    const s = section("Pages");
    const rot = el("div", "insp-row");
    rot.appendChild(button(`${imgIcon("rotateLeft", 14)}Left`, "btn btn--sm", () => session.commit((p) => rotatePages(p, ids(), -90)), "Rotate left"));
    rot.appendChild(button(`${imgIcon("rotateRight", 14)}Right`, "btn btn--sm", () => session.commit((p) => rotatePages(p, ids(), 90)), "Rotate right"));
    s.appendChild(rot);
    s.appendChild(
      button("Delete pages", "btn btn--sm insp-block", () => {
        const before = session.project;
        session.commit((p) => deletePages(p, ids()));
        if (session.project === before) toast.refuse("A document keeps at least one page.");
        else ctx.pageSelection.set([]);
      }),
    );
    root.appendChild(s);
  }

  function buildForms(): void {
    const s = section("Fill forms");
    s.appendChild(el("div", "insp-note", "Type into the form fields on the pages. Turn Fill forms off to mark the pages."));
    root.appendChild(s);
  }

  function buildTool(tool: PdfToolId): void {
    const header = el("div", "insp-header");
    header.appendChild(el("div", "insp-header__name", TOOL_LABEL[tool]));
    root.appendChild(header);
    const ck = toolColorKey(tool);
    const sk = toolSizeKey(tool);
    if (!ck && !sk) {
      const s = section("Tip");
      const tip =
        tool === "select"
          ? "Click a mark to change it. Drag to move it, or drag on the page to select several."
          : tool === "whiteout"
            ? "Drag a box to cover part of the page. Put a text box on top to replace what was there."
            : tool === "eraser"
              ? "Drag over marks to remove them."
              : "Use the tool row below the pages.";
      s.appendChild(el("div", "insp-note", tip));
      root.appendChild(s);
      return;
    }
    const s = section("Style");
    if (tool === "shape") {
      // The shape choice lives here, beside its colour and size, so the tool
      // row keeps one width whatever tool is active.
      const sel = el("select", "select select--sm");
      sel.setAttribute("aria-label", "Shape");
      for (const [v, label] of SHAPE_CHOICES) {
        const o = el("option", undefined, label);
        o.value = v;
        sel.appendChild(o);
      }
      watch(
        () => ctx.tools.get().shape,
        (v) => {
          sel.value = v;
        },
      );
      on(sel, "change", () => {
        const v = sel.value as ShapeKind;
        if (SHAPE_CHOICES.some(([k]) => k === v)) ctx.tools.update((st) => (st.shape === v ? st : { ...st, shape: v }));
      });
      s.appendChild(field("Shape", sel));
    }
    if (ck) {
      const setColor = (hex: string): void => {
        const c = normalizeHexColor(hex, "");
        if (c === "") return;
        ctx.tools.update((st) => (st.colors[ck] === c ? st : { ...st, colors: { ...st.colors, [ck]: c } }));
      };
      s.appendChild(
        field(
          "Color",
          colorRow({
            label: `${TOOL_LABEL[tool]} color`,
            fallback: "#000000",
            read: () => ctx.tools.get().colors[ck],
            commit: setColor,
            preview: setColor,
            end: () => {},
          }),
        ),
      );
    }
    if (sk === "text") {
      s.appendChild(field("Font", fontSelect(() => ctx.tools.get().font, (f) => ctx.tools.update((st) => ({ ...st, font: f })))));
      s.appendChild(
        field(
          "Size",
          slider({
            label: "Font size in points",
            min: FONT_MIN,
            max: 96,
            step: 0.5,
            unit: "pt",
            read: () => ctx.tools.get().sizes.text,
            write: (v) => {
              const f = clampFont(v);
              ctx.tools.update((st) => (st.sizes.text === f ? st : { ...st, sizes: { ...st.sizes, text: f } }));
            },
          }),
        ),
      );
    } else if (sk) {
      s.appendChild(
        field(
          "Size",
          slider({
            label: "Size in pixels",
            min: SIZE_MIN,
            max: SIZE_MAX,
            step: 1,
            unit: "px",
            read: () => ctx.tools.get().sizes[sk],
            write: (v) => {
              const n = clampSize(v);
              ctx.tools.update((st) => (st.sizes[sk] === n ? st : { ...st, sizes: { ...st.sizes, [sk]: n } }));
            },
          }),
        ),
      );
    }
    root.appendChild(s);
  }

  /* ---------- build / sync ---------- */

  function structureKey(): string {
    if (ctx.mode.get() === "forms") return "forms";
    const list = marks();
    if (list.length) return `marks:${[...new Set(list.map((a) => a.t))].sort().join(",")}`;
    if (ctx.pageSelection.get().length) return "pages";
    return `tool:${ctx.tools.get().tool}`;
  }

  function teardown(): void {
    gestures.flush();
    picker?.close();
    for (const fn of cleanup) fn();
    cleanup = [];
    syncs = [];
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function sync(): void {
    if (disposed || gestures.pending > 0) return;
    const key = structureKey();
    if (key !== builtKey) {
      teardown();
      builtKey = key;
      if (key === "forms") buildForms();
      else if (key === "pages") buildPages();
      else if (key.startsWith("marks:")) buildMarks(marks());
      else buildTool(ctx.tools.get().tool);
      return;
    }
    for (const fn of syncs) fn();
  }

  const unsubs = [
    session.store.subscribe(sync),
    ctx.selection.subscribe(sync),
    ctx.pageSelection.subscribe(sync),
    ctx.tools.subscribe(sync),
    ctx.mode.subscribe(sync),
  ];
  sync();

  return {
    dispose() {
      if (disposed) return;
      teardown();
      disposed = true;
      for (const u of unsubs) u();
      root.remove();
      host.classList.remove("inspector");
    },
  };
};

