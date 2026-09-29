// The image editor's view: zoom and pan over the stage, the canvas backing
// store sized to the stage's device pixels, and the conversions between client
// (CSS) px and canvas px every tool goes through.
//
// Not implemented yet: the declaration below is the contract.

import type { ViewController } from "./context";

/** One `ResizeObserver` on `stage` and one DPR listener; `fit()` on mount and
 *  on the first resize. `getCanvasSize` is read live (a crop or a canvas
 *  resize changes it). `dispose()` disconnects everything it attached. */
export function createViewController(
  stage: HTMLElement,
  canvas: HTMLCanvasElement,
  getCanvasSize: () => { w: number; h: number },
): ViewController & { dispose(): void };
export function createViewController(): never {
  throw new Error("not implemented");
}
