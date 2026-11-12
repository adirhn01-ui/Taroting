// The PDF project's Home card: a picture of its first page, written through
// the chunked image-save protocol (src-tauri/src/image_save.rs) as a
// `projectThumb`. The image editor's src/image/save.ts is not one of the
// modules the PDF chunk may import (src/dev/image-chunk-boundary.test.ts), so
// the begin → chunk → commit loop is repeated here at its smallest: a card is
// a few dozen KB, one chunk in practice.

import { ipc } from "../../core/ipc";

/** Equal to the backend's per-chunk cap (src/image/save.ts SAVE_CHUNK_BYTES). */
const CHUNK = 8 * 1024 * 1024;

/** Write `blob` as the Home card of `projectPath`. Aborts the open save on
 *  any failure so no partial file is left behind; rethrows. */
export async function saveCover(projectPath: string, projectId: string, blob: Blob): Promise<void> {
  const { token } = await ipc.imageSaveBegin({ kind: "projectThumb", projectPath, projectId }, "jpeg", blob.size);
  try {
    for (let at = 0; at < blob.size; at += CHUNK) {
      const buf = await blob.slice(at, Math.min(at + CHUNK, blob.size)).arrayBuffer();
      await ipc.imageSaveChunk(token, new Uint8Array(buf));
    }
    await ipc.imageSaveCommit(token);
  } catch (e) {
    await ipc.imageSaveAbort(token).catch(() => {});
    throw e;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The cover render still running for each project path, and the tail of that
 *  card's save queue — module level, as in the image editor: a Keep, a leave
 *  and the next mount of the same project can all be writing one card. */
const renders = new Map<string, AbortController>();
const saves = new Map<string, Promise<void>>();

/**
 * Render a cover with `render` and save it for `projectPath`, WAITING at most
 * until `deadline` (a Date.now() time). The deadline stops only the wait: the
 * work runs on and saves late. A newer call aborts the older one, and saves
 * queue (each re-checking its abort when its turn comes), so an older picture
 * never lands over a newer one — the image editor's writeProjectThumb rule.
 *
 * Returns `done`, settling when the work itself has finished (the shell frees
 * the document the render reads only then). Never rejects.
 */
export function writeCover(
  projectPath: string,
  projectId: string,
  render: (signal: AbortSignal) => Promise<Blob>,
  deadline: number,
): { waited: Promise<void>; done: Promise<void> } {
  renders.get(projectPath)?.abort();
  const ac = new AbortController();
  renders.set(projectPath, ac);
  const { signal } = ac;
  const done = (async (): Promise<void> => {
    try {
      const blob = await render(signal);
      if (signal.aborted) return;
      const save = (saves.get(projectPath) ?? Promise.resolve())
        .then(async () => {
          if (signal.aborted) return;
          await saveCover(projectPath, projectId, blob);
        })
        .catch(() => {});
      saves.set(projectPath, save);
      await save;
      if (saves.get(projectPath) === save) saves.delete(projectPath);
    } catch {
      // superseded or failed: Home keeps its placeholder
    } finally {
      if (renders.get(projectPath) === ac) renders.delete(projectPath);
    }
  })();
  const waited = Promise.race([done, sleep(Math.max(0, deadline - Date.now()))]);
  return { waited, done };
}

/** A picture page's picture for its cover (0.9.5): the file's URL, its box
 *  on the UNROTATED page (points), the page's unrotated size and its turn. */
export interface CoverPicture {
  url: string;
  box: [number, number, number, number];
  pageW: number;
  pageH: number;
  rotate: number;
  /** the MediaRef's flag: the WebView leaves this file's EXIF turn unapplied,
   *  so the cover does too (as the editor shows it) */
  noAutorotate?: boolean;
}

/** Decodes a cover's picture at `size` (CSS px of the picture's own, upright
 *  box) honouring `orientation`; null when the file cannot be read. */
export type CoverPictureLoader = (url: string, size: { w: number; h: number }, orientation: ImageOrientation) => Promise<ImageBitmap | null>;

/** The app's canvas path for a picture file: fetch through the asset
 *  protocol (an `<img>` from that origin would taint the canvas and make
 *  toBlob throw), then decode once, already at the card's size. */
export const loadCoverPicture: CoverPictureLoader = async (url, size, orientation) => {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.size === 0) return null;
  return createImageBitmap(blob, {
    imageOrientation: orientation,
    resizeWidth: Math.max(1, Math.ceil(size.w)),
    resizeHeight: Math.max(1, Math.ceil(size.h)),
    resizeQuality: "high",
  });
};

/** Page space (points, y down, the UNROTATED page) → cover pixels of a cover
 *  `coverW` px wide showing the page turned clockwise by `rotate`: a canvas
 *  transform [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f) and
 *  the points-to-px scale. Pure. */
export function coverPictureMatrix(
  picture: Pick<CoverPicture, "pageW" | "pageH" | "rotate">,
  coverW: number,
): { m: [number, number, number, number, number, number]; k: number } {
  const turn = ((Math.round(picture.rotate / 90) % 4) + 4) % 4;
  const { pageW: W, pageH: H } = picture;
  const k = coverW / (turn % 2 ? H : W);
  switch (turn) {
    case 1: // (x, y) → (H − y, x)
      return { m: [0, k, -k, 0, k * H, 0], k };
    case 2: // (x, y) → (W − x, H − y)
      return { m: [-k, 0, 0, -k, k * W, k * H], k };
    case 3: // (x, y) → (y, W − x)
      return { m: [0, -k, k, 0, 0, k * W], k };
    default:
      return { m: [k, 0, 0, k, 0, 0], k };
  }
}

/** A white JPEG of a blank page's shape, `maxSide` px on its long side — with
 *  a picture page's picture drawn in, turned with the page, when `picture` is
 *  given (a picture that does not load leaves the page white). `load` is the
 *  decoder (tests inject one). */
export async function blankCover(
  w: number,
  h: number,
  maxSide: number,
  picture?: CoverPicture,
  load: CoverPictureLoader = loadCoverPicture,
): Promise<Blob> {
  const long = Math.max(w, h) || 1;
  const k = maxSide / long;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const g = canvas.getContext("2d");
  if (g) {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    const pw = picture?.pageW ?? 0;
    const ph = picture?.pageH ?? 0;
    if (picture && pw > 0 && ph > 0) {
      const { m, k: kp } = coverPictureMatrix(picture, canvas.width);
      const [x, y, bw, bh] = picture.box;
      let bmp: ImageBitmap | null = null;
      try {
        bmp = await load(picture.url, { w: bw * kp, h: bh * kp }, picture.noAutorotate ? "none" : "from-image");
        if (bmp) {
          g.save();
          g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          g.drawImage(bmp, x, y, bw, bh);
          g.restore();
        }
      } catch {
        /* the page stays white: Home still gets a card of the right shape */
      } finally {
        bmp?.close();
      }
    }
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        canvas.width = 0;
        canvas.height = 0;
        if (b) resolve(b);
        else reject(new Error("The cover could not be encoded"));
      },
      "image/jpeg",
      0.9,
    );
  });
}
