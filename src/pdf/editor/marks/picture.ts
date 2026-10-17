// Image: pick a picture, probe it, and put it on the current page — sized to
// fit half the page at its own aspect, centred, selected. The MediaRef (so a
// moved file can be relinked) and the mark land in ONE commit.

import type { MediaInfo, MediaRef, ProjectFile } from "../../../core/types";
import { describeError, ipc, pickImageFile } from "../../../core/ipc";
import { toast } from "../../../ui/toast";
import { addAnnot, newId } from "../../model";
import type { PdfEditorCtx } from "../../types";
import { fitCentered } from "./geom";
import type { MarkLayer } from "./layer";

/** A probe result that is a still picture (the image editor's isStillInfo
 *  rule, src/editor/media/relink.ts, which the PDF chunk does not import). */
export function isStill(info: MediaInfo): boolean {
  return info.kind === "image" && (info.width ?? 0) > 0 && (info.height ?? 0) > 0;
}

/** The project with the picture's MediaRef (an existing one for the same
 *  file is reused) and an image mark of `box` on `pageId`; `p` itself when
 *  the mark could not be added. Pure. */
export function withPicture(
  p: ProjectFile,
  pageId: string,
  info: MediaInfo,
  box: [number, number, number, number],
  markId: string,
): ProjectFile {
  const same = p.media.find((m) => m.kind === "image" && !m.generator && m.path === info.path && m.size === info.size && m.mtimeMs === info.mtimeMs);
  const media: MediaRef = same ?? { ...info, id: newId() };
  const withMedia = same ? p : { ...p, media: [...p.media, media] };
  const next = addAnnot(withMedia, pageId, { id: markId, t: "image", x: box[0], y: box[1], w: box[2], h: box[3], media: media.id });
  return next === withMedia ? p : next;
}

export interface PictureDeps {
  pick(): Promise<string | null>;
  probe(path: string): Promise<MediaInfo>;
}
const realDeps: PictureDeps = { pick: pickImageFile, probe: (path) => ipc.probeMedia(path) };

let busy = false;

/** Insert a picture on the current page. Resolves true when one landed. */
export async function insertPicture(
  ctx: PdfEditorCtx,
  layer: MarkLayer,
  currentKey: () => string | null,
  isLive: () => boolean,
  deps: PictureDeps = realDeps,
): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try {
    const path = await deps.pick();
    if (!path || !isLive()) return false;
    const info = await deps.probe(path);
    if (!isLive()) return false;
    if (!isStill(info)) {
      toast.refuse("Only still pictures can be placed on a page.");
      return false;
    }
    const key = currentKey();
    if (!key) return false;
    const page = await layer.infoAsync(key);
    if (!page || !isLive()) return false;
    const box = fitCentered(page.w, page.h, info.width! / info.height!, 0.5);
    const id = newId();
    const before = ctx.session.project;
    ctx.session.commit((p) => withPicture(p, key, info, box, id));
    if (ctx.session.project === before) return false;
    ctx.tools.update((s) => (s.tool === "select" ? s : { ...s, tool: "select" }));
    ctx.selection.set([{ key, id }]);
    return true;
  } catch (e) {
    if (isLive()) toast.error(`Couldn't add the picture: ${describeError(e)}`);
    return false;
  } finally {
    busy = false;
  }
}
