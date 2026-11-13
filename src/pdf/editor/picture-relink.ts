// Relinking a picture whose file has moved (0.9.5): the app's own relink
// dialog (src/editor/media/relink.ts) with its stills-only rule, and the PDF
// project's way of applying a located file. Loaded by the shell only when a
// relink is asked for, so a project whose pictures are all there never
// fetches the dialog.

import { applyRelink, openRelinkDialog } from "../../editor/media/relink";
import { pickImageFile } from "../../core/ipc";
import type { ProjectSession } from "../../core/session";
import type { MediaInfo, ProjectFile } from "../../core/types";
import { refitPagePictures, sameFileMedia } from "../model";
import type { PdfEditorCtx } from "../types";
import { notePicturesFound } from "./missing-pictures";

/**
 * Point every picture that uses `mediaId`'s FILE at `path` (probed as
 * `info`), as one new project: each MediaRef of that file takes the probe
 * (`applyRelink`), so every page and mark using it is fixed at once. A page
 * picture keeps its PAGE: a new file of another shape is fitted inside its
 * old box, centred; an ordinary picture mark keeps its box. Pure; `p` itself
 * when `mediaId` is unknown.
 */
export function relinkPicture(p: ProjectFile, mediaId: string, path: string, info: MediaInfo): ProjectFile {
  const ids = sameFileMedia(p, mediaId);
  if (ids.length === 0) return p;
  const hasSize = (w: unknown, h: unknown): w is number => typeof w === "number" && typeof h === "number" && w > 0 && h > 0;
  // A probe that reports no picture size keeps the old one: a page picture
  // and its Page size choices need it, and the box stays as it was.
  const old = p.media.find((m) => m.id === mediaId);
  const sized = hasSize(info.width, info.height) || !old || !hasSize(old.width, old.height) ? info : { ...info, width: old.width, height: old.height };
  let q = p;
  for (const id of ids) q = applyRelink(q, id, path, sized);
  if (hasSize(info.width, info.height)) q = refitPagePictures(q, new Set(ids), info.width, info.height!);
  return q;
}

export interface PictureRelinkOpts {
  session: ProjectSession;
  /** media ids of the missing pictures, one per file */
  missing: string[];
  /** the editor's missing picture files: a located file leaves it */
  missingPictures?: PdfEditorCtx["missingPictures"];
  /** a file was relinked (after its commit) */
  onRelinked(mediaId: string): void;
}

/** Open the relink dialog for pictures; returns its quiet closer (for the
 *  editor's overlay registry). */
export function openPictureRelink(opts: PictureRelinkOpts): () => void {
  return openRelinkDialog({
    session: opts.session,
    media: {
      retrack: (id: string) => {
        // The located file is there now. Even at its old place (put back,
        // a drive plugged in again) it has the same identity, so only this
        // tells the pages it is no longer missing.
        const ref = opts.session.project.media.find((m) => m.id === id);
        if (ref) notePicturesFound(opts, [ref]);
        opts.onRelinked(id);
      },
    },
    missing: opts.missing,
    stillsOnly: true,
    relink: relinkPicture,
    // Any still picture the editor takes (the set "Insert → Pictures"
    // offers), not only the missing file's own extension.
    pick: () => pickImageFile(),
  });
}
