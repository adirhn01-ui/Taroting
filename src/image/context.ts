// What every part of the image editor is handed: the session, the tool and
// selection state, the view, the preview resources and the stage. The editor
// shell builds one `ImageEditorCtx` per mount; the panels and tools only ever
// read from it.

import type { ProjectSession } from "../core/session";
import type { Store } from "../core/store";
import type { PreviewResources, LiveInk, ViewXf } from "./render";
import type { ToolState } from "./tool-state";
import type { FontFamily, FontId } from "../core/types";

export interface ViewState extends ViewXf {
  dpr: number;
  /** device px */
  stageW: number;
  stageH: number;
}

export interface ViewController {
  readonly store: Store<ViewState>;
  canvasToClient(x: number, y: number): { x: number; y: number };
  clientToCanvas(clientX: number, clientY: number): { x: number; y: number };
  /** whole canvas visible, 24 css px margin */
  fit(): void;
  /** zoom = 1 (one canvas px per device px), centred */
  actual(): void;
  /** clamps to [min(fit, 0.01), 32] */
  zoomAt(factor: number, clientX: number, clientY: number): void;
  panBy(dxCss: number, dyCss: number): void;
  /** true while a pan gesture (Space-hold, middle drag, two-finger) owns the pointer */
  readonly panning: boolean;
}

export interface ImageEditorCtx {
  session: ProjectSession;
  tools: Store<ToolState>;
  view: ViewController;
  /** selected layer trackId */
  selection: Store<string | null>;
  res: PreviewResources;
  /** the stage element; tools/overlays append their surfaces here (position:relative, overflow:hidden) */
  stage: HTMLElement;
  /** coalesced to one rAF; no-op when nothing changed */
  requestRender(): void;
  setLive(live: LiveInk | null): void;
  /** ProjectSession.holdAutosave passthrough (pointer-down → hold, up → release) */
  holdAutosave(): () => void;
  /** exclusive stage modes; tools check it before claiming the pointer */
  mode: Store<"idle" | "crop-image" | "crop-layer">;
  /** register a body-parked surface's closer; dispose() closes all (Home's
   *  openOverlays pattern). Returns the unregister. */
  registerOverlay(close: () => void): () => void;
  /** The text open for typing on the stage, if any (text/text-tool.ts). Set
   *  by the shell; absent in a ctx built without the text tool. */
  textEdit?: Store<TextEditHandle | null>;
  /** Open a NEW text layer for typing: at a canvas point, or (null) at the
   *  centre of the visible canvas. False when refused (a crop, a dialog). */
  beginText?(at: { x: number; y: number } | null): boolean;
  /** Open text layer `trackId` for typing, the caret at the end. */
  editText?(trackId: string): boolean;
}

/** What the inspector and the toolbar may do to the text being typed. */
export interface TextEditHandle {
  readonly trackId: string;
  /** Restyle the open text (a font, size, colour, bold or italic change):
   *  part of the edit's one undo step. With a part selected (`range`), that
   *  part alone, as `applyRange` (a right-to-left text: the whole text). */
  restyle(patch: TextStylePatch): void;
  /** Land the edit now (idempotent). */
  commit(): void;
  /** Put the keyboard back in the text, where the caret was. */
  refocus(): void;
  /** The selected part of the open text ([s, e) in UTF-16 units), or null
   *  for none. A new handle is published whenever it changes. */
  readonly range?: { s: number; e: number } | null;
  /** Style the selected part only: part of the edit's one undo step. */
  applyRange?(patch: TextStylePatch): void;
  /** The style the controls show: the selected part's (its first
   *  character's font, size and colour; bold / italic only when all of it
   *  is), or the whole text's. */
  styleOf?(): TextRangeStyle;
}

/** What `styleOf` answers (core/pdf-runs PdfResolvedStyle). */
export interface TextRangeStyle {
  font: FontFamily;
  fontId?: FontId;
  size: number;
  c: string;
  bold: boolean;
  italic: boolean;
}

export interface TextStylePatch {
  font?: { legacy: FontFamily; fontId?: FontId };
  sizePx?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}
