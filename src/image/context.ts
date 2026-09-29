// What every part of the image editor is handed: the session, the tool and
// selection state, the view, the preview resources and the stage. The editor
// shell builds one `ImageEditorCtx` per mount; the panels and tools only ever
// read from it.

import type { ProjectSession } from "../core/session";
import type { Store } from "../core/store";
import type { PreviewResources, LiveInk, ViewXf } from "./render";
import type { ToolState } from "./tool-state";

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
}
