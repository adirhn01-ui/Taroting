// The PDF editor's mark tools part: the tool row (in the shell's transport
// row, the image editor's own button markup), the mark layer that draws the
// saved marks on every rendered page (marks/layer.ts), and the pointer /
// keyboard controller behind every tool (marks/controller.ts).
//
// The row writes `ctx.tools` (and, picking a tool, lets the page panel's
// selection go, so the inspector shows that tool); Image and Signature act
// at once (pick a picture / open the signature menu). Every control is
// disabled in Fill forms mode. Each tool's style is remembered in Settings
// (pdfToolStyle), written ~300 ms after the last change — never at rest. IDEMPOTENT PAINT: store notifications funnel into
// `paint()`, which writes the DOM only where a value flipped; titles carry
// the live chord ("Pen (P)").

import "./marks/marks.css";
import type { ActionId, PdfToolStyle } from "../../core/types";
import { describeError } from "../../core/ipc";
import { settingsStore, updateSettings } from "../../core/session";
import { toast } from "../../ui/toast";
import { imgIcon, type ImgIconName } from "../../image/icons";
import type { PdfEditorPart, PdfToolId, PdfToolState } from "../types";
import { mountMarkTools, pickTool } from "./marks/controller";
import { pdfIcon, type PdfIconName } from "./marks/icons";
import { createMarkLayer } from "./marks/layer";
import { insertPicture } from "./marks/picture";
import { toggleSignatureMenu } from "./marks/signature";

interface ToolDef {
  id: PdfToolId;
  label: string;
  action: ActionId | null;
  icon: { img: ImgIconName } | { pdf: PdfIconName };
}

export const TOOL_DEFS: readonly ToolDef[] = [
  { id: "select", label: "Select", action: "imgSelect", icon: { img: "select" } },
  { id: "highlight", label: "Highlight", action: "pdfHighlight", icon: { pdf: "highlight" } },
  { id: "pen", label: "Pen", action: "imgPen", icon: { img: "pen" } },
  { id: "pencil", label: "Pencil", action: "imgPencil", icon: { img: "pencil" } },
  { id: "marker", label: "Marker", action: "imgMarker", icon: { img: "marker" } },
  { id: "eraser", label: "Eraser", action: "imgEraser", icon: { img: "eraser" } },
  { id: "shape", label: "Shapes", action: "imgShape", icon: { img: "shapes" } },
  { id: "text", label: "Text", action: "pdfText", icon: { img: "text" } },
  { id: "whiteout", label: "Whiteout", action: "pdfWhiteout", icon: { pdf: "whiteout" } },
];

/** How long after the last style change Settings is written, ms. */
export const STYLE_SAVE_MS = 300;

/** What Settings remembers of a tool state (pdfToolStyle). */
export function toolStyleOf(s: PdfToolState): PdfToolStyle {
  return {
    colors: { ...s.colors },
    sizes: { ...s.sizes },
    shape: s.shape,
    font: s.font,
    textBg: s.textBg,
    textBorder: s.textBorder,
  };
}

/** Do two tool states differ in anything Settings remembers? */
function styleChanged(a: PdfToolState, b: PdfToolState): boolean {
  if (a.colors !== b.colors || a.sizes !== b.sizes) {
    for (const k of Object.keys(a.colors) as (keyof PdfToolState["colors"])[]) if (a.colors[k] !== b.colors[k]) return true;
    for (const k of Object.keys(a.sizes) as (keyof PdfToolState["sizes"])[]) if (a.sizes[k] !== b.sizes[k]) return true;
  }
  return a.shape !== b.shape || a.font !== b.font || a.textBg !== b.textBg || a.textBorder !== b.textBorder;
}

const glyph = (i: ToolDef["icon"]): string => ("img" in i ? imgIcon(i.img) : pdfIcon(i.pdf));
const titled = (label: string, chord: string | undefined): string => (chord ? `${label} (${chord})` : label);

function iconButton(html: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn--ghost btn--icon btn--sm";
  b.setAttribute("aria-label", label);
  b.innerHTML = html;
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement("span");
  s.className = "pdfmk-sep";
  s.setAttribute("aria-hidden", "true");
  return s;
}

export const toolsPart: PdfEditorPart = (ctx, hosts) => {
  let disposed = false;
  const cleanup: (() => void)[] = [];
  const on = (t: EventTarget, type: string, fn: (e: Event) => void): void => {
    t.addEventListener(type, fn);
    cleanup.push(() => t.removeEventListener(type, fn));
  };

  const layer = createMarkLayer(ctx);
  const marks = mountMarkTools(ctx, layer);

  const row = document.createElement("div");
  row.className = "pdfmk-toolbar";
  row.setAttribute("role", "toolbar");
  row.setAttribute("aria-label", "Mark tools");

  const toolBtns = new Map<PdfToolId, HTMLButtonElement>();
  for (const t of TOOL_DEFS) {
    const b = iconButton(glyph(t.icon), t.label);
    b.dataset.tool = t.id;
    toolBtns.set(t.id, b);
    row.appendChild(b);
    on(b, "click", () => {
      if (ctx.mode.get() === "forms") return;
      pickTool(ctx, t.id);
      // Space is the pan key: a focused button would take it as a click
      b.blur();
    });
  }

  row.appendChild(sep());

  const imageBtn = iconButton(imgIcon("image"), "Image");
  imageBtn.title = "Image";
  row.appendChild(imageBtn);
  on(imageBtn, "click", () => {
    imageBtn.blur();
    if (ctx.mode.get() === "forms") return;
    void insertPicture(ctx, layer, () => marks.currentKey(), () => !disposed);
  });

  const sigBtn = iconButton(pdfIcon("signature"), "Signature");
  sigBtn.title = "Signature";
  sigBtn.setAttribute("aria-haspopup", "menu");
  row.appendChild(sigBtn);
  on(sigBtn, "click", () => {
    sigBtn.blur();
    if (ctx.mode.get() === "forms") return;
    toggleSignatureMenu(ctx, sigBtn, { arm: (sig) => marks.armSignature(sig) });
  });

  const rulerBtn = iconButton(imgIcon("ruler"), "Ruler");
  row.appendChild(rulerBtn);
  on(rulerBtn, "click", () => {
    rulerBtn.blur();
    if (ctx.mode.get() === "forms") return;
    marks.toggleRuler();
  });

  hosts.toolbar.appendChild(row);

  /* ---------- paint (writes only what flipped) ---------- */

  const shown = {
    tool: null as PdfToolId | null,
    forms: null as boolean | null,
    ruler: null as boolean | null,
    shapeVisible: null as boolean | null,
    shape: "",
    titles: new Map<HTMLElement, string>(),
  };
  const setTitle = (b: HTMLElement, t: string): void => {
    if (shown.titles.get(b) === t) return;
    shown.titles.set(b, t);
    b.title = t;
  };
  const setPressed = (b: HTMLElement, v: boolean): void => {
    b.classList.toggle("btn--on", v);
    b.setAttribute("aria-pressed", String(v));
  };
  const paint = (): void => {
    if (disposed) return;
    const s = ctx.tools.get();
    const forms = ctx.mode.get() === "forms";
    const chords = settingsStore.get().shortcuts;
    for (const t of TOOL_DEFS) setTitle(toolBtns.get(t.id)!, titled(t.label, t.action ? chords[t.action] : undefined));
    setTitle(rulerBtn, titled("Ruler", chords.imgRuler));
    if (shown.forms !== forms) {
      shown.forms = forms;
      for (const b of [...toolBtns.values(), imageBtn, sigBtn, rulerBtn]) b.disabled = forms;
    }
    // the armed signature lights the Signature button
    const tool = s.tool;
    if (shown.tool !== tool) {
      for (const [id, b] of toolBtns) setPressed(b, id === tool);
      setPressed(sigBtn, tool === "signature");
      shown.tool = tool;
    }
    const rulerOn = s.ruler !== null;
    if (shown.ruler !== rulerOn) {
      shown.ruler = rulerOn;
      setPressed(rulerBtn, rulerOn);
    }
  };
  cleanup.push(ctx.tools.subscribe(paint), ctx.mode.subscribe(paint));
  let lastShortcuts = settingsStore.get().shortcuts;
  cleanup.push(
    settingsStore.subscribe((st) => {
      if (st.shortcuts === lastShortcuts) return;
      lastShortcuts = st.shortcuts;
      paint();
    }),
  );
  paint();

  /* ---------- remembered styles (Settings → pdfToolStyle) ---------- */

  let saved = ctx.tools.get();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    saveTimer = null;
    const now = ctx.tools.get();
    if (!styleChanged(saved, now)) return;
    saved = now;
    void updateSettings({ pdfToolStyle: toolStyleOf(now) }).catch((e: unknown) => {
      toast.error("Couldn't remember the tool settings.", { detail: describeError(e), op: "Settings", title: "Save" });
    });
  };
  cleanup.push(
    ctx.tools.subscribe((s) => {
      if (saveTimer !== null || !styleChanged(saved, s)) return;
      saveTimer = setTimeout(save, STYLE_SAVE_MS);
    }),
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      // a change still waiting (or not yet even announced) is written now
      if (saveTimer !== null) clearTimeout(saveTimer);
      save();
      marks.dispose();
      layer.dispose();
      for (const fn of cleanup.splice(0)) fn();
      row.remove();
    },
  };
};
