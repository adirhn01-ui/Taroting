// The image editor's tool state: which tool is active, and each tool's colour
// and size. Data only — the toolbar writes it, the ink and select tools read
// it. Transient: never saved in the project (recent colours live in Settings).

import { Store } from "../core/store";
import type { ShapeKind } from "../core/types";

export type ToolId = "select" | "pen" | "pencil" | "marker" | "eraser" | "shape";
export type EraserMode = "stroke" | "pixel";

/** canvas px, degrees (−180, 180] */
export interface RulerState {
  cx: number;
  cy: number;
  angle: number;
}

export interface ToolState {
  tool: ToolId;
  colors: { pen: string; pencil: string; marker: string; shape: string };
  /** nominal size per tool in SCREEN (CSS) px at the current zoom; stored strokes are in source px */
  sizes: { pen: number; pencil: number; marker: number; eraser: number; shape: number };
  eraserMode: EraserMode;
  shape: ShapeKind;
  /** null = hidden */
  ruler: RulerState | null;
}

export const SIZE_MIN = 1;
export const SIZE_MAX = 200;

export const DEFAULT_TOOL_STATE: ToolState = {
  tool: "select",
  colors: { pen: "#000000", pencil: "#3a3a3a", marker: "#ffd400", shape: "#e5484d" },
  sizes: { pen: 4, pencil: 2, marker: 18, eraser: 16, shape: 4 },
  eraserMode: "stroke",
  shape: "arrow",
  ruler: null,
};

/** A fresh store per editor mount. The nested objects are copied, so no mount
 *  can mutate the shared defaults through its own state. */
export function createToolStore(): Store<ToolState> {
  return new Store({
    ...DEFAULT_TOOL_STATE,
    colors: { ...DEFAULT_TOOL_STATE.colors },
    sizes: { ...DEFAULT_TOOL_STATE.sizes },
  });
}

/** Screen CSS px → source px of a layer drawn at `zoom` device px per canvas px
 *  and layer scale k. */
export function cssToSource(css: number, dpr: number, zoom: number, k: number): number {
  return (css * dpr) / (zoom * k);
}
