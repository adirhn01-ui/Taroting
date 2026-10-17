// The PDF editor's mark tools part: the tool row (in the shell's transport
// row, the image editor's own button markup), the mark layer that draws the
// saved marks on every rendered page (marks/layer.ts), and the pointer /
// keyboard controller behind every tool (marks/controller.ts).
//
// The row writes `ctx.tools` and nothing else; Image and Signature act at
// once (pick a picture / open the signature menu). Every control is disabled
// in Fill forms mode. IDEMPOTENT PAINT: store notifications funnel into
// `paint()`, which writes the DOM only where a value flipped; titles carry
// the live chord ("Pen (P)").

import "./marks/marks.css";
import type { ActionId } from "../../core/types";
import { settingsStore } from "../../core/session";
import { imgIcon, type ImgIconName } from "../../image/icons";
import type { PdfEditorPart, PdfToolId } from "../types";
import { mountMarkTools } from "./marks/controller";
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
      ctx.tools.update((s) => (s.tool === t.id ? s : { ...s, tool: t.id }));
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

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      marks.dispose();
      layer.dispose();
      for (const fn of cleanup.splice(0)) fn();
      row.remove();
    },
  };
};
