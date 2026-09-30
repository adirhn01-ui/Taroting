// The "Image" menu on the tool row: whole-image operations. Each is ONE commit
// (one undo step); the shell refits the view whenever the canvas size changes,
// so a rotate or crop (and its undo) always lands with the whole image in view.
// Built on the app's one context menu (ui/menu), which already owns the
// keyboard while open and is closed by the shell's dispose.

import { showMenu } from "../ui/menu";
import type { MenuItem } from "../ui/menu";
import { openCanvasSizeDialog } from "./canvas-size-dialog";
import type { ImageEditorCtx } from "./context";
import { startImageCrop } from "./crop-image";
import { flipImage, rotateImage } from "./layers";

/** The menu's rows, in order. Pure data over `ctx`, so the order and the
 *  "one commit per row" rule are readable in one place. */
export function imageMenuItems(ctx: ImageEditorCtx): MenuItem[] {
  const busy = ctx.mode.get() !== "idle";
  const why = busy ? "Finish the crop first." : undefined;
  return [
    { label: "Crop image", disabled: busy, title: why, onSelect: () => void startImageCrop(ctx) },
    { label: "Rotate left", disabled: busy, title: why, onSelect: () => ctx.session.commit((p) => rotateImage(p, -90)) },
    { label: "Rotate right", disabled: busy, title: why, onSelect: () => ctx.session.commit((p) => rotateImage(p, 90)) },
    { label: "Flip horizontal", disabled: busy, title: why, onSelect: () => ctx.session.commit((p) => flipImage(p, "h")) },
    { label: "Flip vertical", disabled: busy, title: why, onSelect: () => ctx.session.commit((p) => flipImage(p, "v")) },
    { label: "Canvas size", disabled: busy, title: why, onSelect: () => openCanvasSizeDialog(ctx) },
  ];
}

/** Open the menu under `anchor`, or above it when there is no room below (the
 *  tool row sits at the window's bottom edge). */
export function openImageMenu(anchor: HTMLElement, ctx: ImageEditorCtx): void {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, imageMenuItems(ctx), r.top - 4);
}
