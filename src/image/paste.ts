// Paste an image (Ctrl+V from a screenshot tool, a browser, Paint…) as a new
// photo layer.
//
// Through the DOM `paste` event, never `navigator.clipboard.read()`: the event
// carries the pixels with no permission prompt, and it is also why `paste` is
// NOT an image-mode shortcut — the ShortcutManager preventDefault()s a bound
// chord, which would kill the very event this reads.
//
// A pasted image needs a real file behind it (a photo layer is a MediaRef with
// a path, and the project must reopen tomorrow): it is written to
// Documents\Taroting\Pasted images through the image-save protocol, which
// picks a free name, then probed and added like any dropped photo.

import { describeError, ipc } from "../core/ipc";
import { isTypingTarget, shortcutsBlocked } from "../core/shortcuts";
import { isStillInfo } from "../editor/media/relink";
import { toast } from "../ui/toast";
import type { ImageEditorCtx } from "./context";
import { addPhotoLayer } from "./layers";
import { saveBlob } from "./save";

/** Index of the first image file on a clipboard payload, or −1. Pure over the
 *  items, so the choice is testable without a clipboard. */
export function firstImageItem(items: ArrayLike<{ kind: string; type: string }>): number {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === "file" && it.type.startsWith("image/")) return i;
  }
  return -1;
}

/** Why an image cannot be added right now, or null to take it: the one rule
 *  behind a paste and a drop from File Explorer, each re-checked after its
 *  awaits (image-editor's `dropRefusal` words it for a drop). In this order: a
 *  crop also holds the keyboard, and its message is the one that tells the
 *  user what to finish. An open picker or menu holds the keyboard too, and a
 *  layer added under a colour picker's preview would record that unpicked
 *  colour as the undo step before it. `retry` ends every message. */
export function addRefusal(
  mode: "idle" | "crop-image" | "crop-layer",
  modal: boolean,
  blocked: boolean,
  retry: string,
): string | null {
  if (mode !== "idle") return `Finish the crop first, then ${retry}.`;
  if (modal) return `Close the dialog first, then ${retry}.`;
  if (blocked) return `Close the open menu or picker first, then ${retry}.`;
  return null;
}

/** PNG bytes for a pasted image: as-is when it already is one, otherwise
 *  decoded and re-encoded (a JPEG from a browser, a BMP from an old app). */
async function asPng(file: Blob): Promise<Blob> {
  if (file.type === "image/png") return file;
  const bmp = await createImageBitmap(file);
  try {
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const g = oc.getContext("2d");
    if (!g) throw new Error("This image could not be read.");
    g.drawImage(bmp, 0, 0);
    const out = await oc.convertToBlob({ type: "image/png" });
    if (out.type !== "image/png" || out.size === 0) throw new Error("This image could not be converted.");
    return out;
  } finally {
    bmp.close();
  }
}

/** Install the document `paste` listener. Returns its removal. */
export function installPaste(ctx: ImageEditorCtx, isDisposed: () => boolean): () => void {
  let told = false;
  // One paste at a time: a second Ctrl+V while the first is still being
  // written would race it for the layer order the user expects.
  let busy = false;

  const onPaste = (e: ClipboardEvent): void => {
    // The §2.8 guards: a paste into a text field (a layer rename, a dialog's
    // number box) is that field's; nothing lands behind a modal or menu.
    if (isTypingTarget(document.activeElement) || isTypingTarget(e.target)) return;
    if (document.querySelector(".modal-backdrop") || shortcutsBlocked()) return;
    if (ctx.mode.get() !== "idle") return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const i = firstImageItem(items);
    if (i < 0) return;
    const file = items[i]!.getAsFile();
    if (!file) return;
    e.preventDefault();
    if (busy) return;
    busy = true;
    void run(file).finally(() => {
      busy = false;
    });
  };

  const run = async (file: File): Promise<void> => {
    try {
      const png = await asPng(file);
      if (isDisposed()) return;
      const { path } = await saveBlob({ kind: "pasted", projectName: ctx.session.project.name }, "png", png);
      if (isDisposed()) return;
      const info = await ipc.probeMedia(path);
      if (isDisposed()) return;
      // Whatever opened while this was saved and probed: a crop (a commit now
      // would land inside it), a dialog, or a menu or picker (under a colour
      // preview, the paste would record that colour as its undo step). The
      // file is already in Pasted images, so nothing is lost.
      const refused = addRefusal(
        ctx.mode.get(),
        document.querySelector(".modal-backdrop") !== null,
        shortcutsBlocked(),
        "paste the image again",
      );
      if (refused !== null) {
        toast.info(refused);
        return;
      }
      // The drop's own guard, applied here too: a probe that is not a still
      // (an animated or mis-typed payload) would otherwise reach
      // addPhotoLayer and surface as its raw refusal.
      if (!isStillInfo(info)) {
        toast.error("Only images can be added to an image project.");
        return;
      }
      let added: string | null = null;
      ctx.session.commit((p) => {
        const r = addPhotoLayer(p, info, { above: ctx.selection.get() });
        added = r.trackId;
        return r.project;
      });
      if (added !== null) ctx.selection.set(added);
      if (!told) {
        told = true;
        toast.info("Pasted image saved to Documents\\Taroting\\Pasted images.");
      }
    } catch (err) {
      if (isDisposed()) return;
      toast.error(`Couldn't paste the image: ${describeError(err)}`);
    }
  };

  document.addEventListener("paste", onPaste);
  return () => document.removeEventListener("paste", onPaste);
}
