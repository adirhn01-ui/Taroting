// The "Canvas" menu on the tool row: operations on the WHOLE picture, never on
// the selected layer (the inspector edits a layer). Each is ONE commit (one
// undo step); the shell refits the view whenever the canvas size changes, so a
// rotate or crop (and its undo) always lands with the whole canvas in view.
// Built on the app's one context menu (ui/menu), which already owns the
// keyboard while open and is closed by the shell's dispose. The inspector's
// Canvas panel runs the same actions through the helpers below.

import { showMenu } from "../ui/menu";
import type { MenuItem } from "../ui/menu";
import { openCanvasSizeDialog } from "./canvas-size-dialog";
import type { ImageEditorCtx } from "./context";
import { startImageCrop } from "./crop-image";
import { flipImage, rotateImage } from "./layers";

/** Turn the whole canvas a quarter: one commit. */
export function rotateCanvas(ctx: ImageEditorCtx, dir: 90 | -90): void {
  ctx.session.commit((p) => rotateImage(p, dir));
}

/** Mirror the whole canvas: one commit. */
export function flipCanvas(ctx: ImageEditorCtx, axis: "h" | "v"): void {
  ctx.session.commit((p) => flipImage(p, axis));
}

/** The menu's rows, in order. Pure data over `ctx`, so the order and the
 *  "one commit per row" rule are readable in one place. */
export function imageMenuItems(ctx: ImageEditorCtx): MenuItem[] {
  const busy = ctx.mode.get() !== "idle";
  const why = busy ? "Finish the crop first." : undefined;
  return [
    { label: "Crop canvas", disabled: busy, title: why, onSelect: () => void startImageCrop(ctx) },
    { label: "Resize canvas", disabled: busy, title: why, onSelect: () => openCanvasSizeDialog(ctx) },
    { label: "Rotate canvas left", disabled: busy, title: why, onSelect: () => rotateCanvas(ctx, -90) },
    { label: "Rotate canvas right", disabled: busy, title: why, onSelect: () => rotateCanvas(ctx, 90) },
    { label: "Flip canvas horizontally", disabled: busy, title: why, onSelect: () => flipCanvas(ctx, "h") },
    { label: "Flip canvas vertically", disabled: busy, title: why, onSelect: () => flipCanvas(ctx, "v") },
  ];
}

/** Open the menu under `anchor`, or above it when there is no room below (the
 *  tool row sits at the window's bottom edge). `fromKeyboard` (the button was
 *  activated with Enter/Space: its click has detail 0) starts the menu on its
 *  first enabled row, so the next Enter picks it. */
export function openImageMenu(anchor: HTMLElement, ctx: ImageEditorCtx, fromKeyboard = false): void {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, imageMenuItems(ctx), r.top - 4, fromKeyboard);
}
