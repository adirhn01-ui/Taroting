// Copy image: the whole composite to the clipboard as PNG.
//
// The clipboard only accepts a write that starts INSIDE the user's gesture,
// and a render can take a while. So the write is started synchronously in the
// click with a Promise-valued ClipboardItem, and the render fills it in —
// awaiting the render first and then writing would lose the gesture and be
// refused (NotAllowedError). Paste goes the other way through the DOM `paste`
// event (image/paste.ts), never `clipboard.read()`.

import { describeError } from "../core/ipc";
import type { ProjectFile } from "../core/types";
import { toast } from "../ui/toast";
import { maxRenderSize, renderImageExport } from "./render/export";

export const COPY_REFUSED_MESSAGE = "Couldn't copy the image — click the window and try again.";

/** The copy whose render is still running. A new copy aborts it: five fast
 *  clicks on a 48 MP canvas must not run five full-size renders at once. */
let inFlight: AbortController | null = null;

function errorName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
}

/** MUST be called synchronously inside the user gesture: the clipboard write
 *  is started there with a Promise-valued ClipboardItem, and the render fills
 *  it in. Toasts on rejection. */
export function copyImage(doc: ProjectFile): void {
  inFlight?.abort();
  const ac = new AbortController();
  inFlight = ac;

  const { w, h } = maxRenderSize(doc.timeline.width, doc.timeline.height);
  const png = renderImageExport(doc, { format: "png", quality: 100, outW: w, outH: h }, ac.signal, () => {});
  // The render promise is also handed to the clipboard, which reports its
  // failure through write(). This reaction keeps a failed render from also
  // surfacing as an unhandled rejection, and remembers WHY it failed: an
  // engine may report any rejected item as NotAllowedError, which would tell
  // the user to click the window when the real cause is a missing photo.
  // Registered before the write, so it has run by the time the write settles.
  let renderErr: unknown = null;
  const settled = (): void => {
    if (inFlight === ac) inFlight = null;
  };
  png.then(settled, (e: unknown) => {
    renderErr = e;
    settled();
  });

  const refused = (e: unknown): void => {
    const cause = renderErr ?? e;
    const name = errorName(cause);
    // Superseded by a newer copy: that one reports.
    if (name === "AbortError") return;
    if (renderErr === null && (name === "NotAllowedError" || name === "SecurityError")) {
      toast.error(COPY_REFUSED_MESSAGE);
      return;
    }
    toast.error("Couldn't copy the image.", { detail: describeError(cause), op: "Copy image" });
  };

  try {
    const item = new ClipboardItem({ "image/png": png });
    navigator.clipboard.write([item]).then(
      () => toast.info("Image copied"),
      (e: unknown) => {
        // Refused (no focus, no permission): nothing will ever take the
        // render, which on a large canvas is a full-size encode — stop it.
        // `refused` reads the render's own error synchronously, and the
        // AbortError that follows is swallowed by the render's handler.
        ac.abort();
        refused(e);
      },
    );
  } catch (e) {
    // No clipboard API at all, or ClipboardItem refused the promise: nothing
    // will ever take the render, so stop it.
    ac.abort();
    refused(e);
  }
}
