// Missing pictures on the pages (0.9.5): a "Relink picture" button over the
// first missing picture of every rendered page that has one, in the page's
// overlay. The marks themselves draw their placeholder (marks/render.ts);
// this adds only the action. Mounted by the shell only once a picture file is
// known to be missing, so a project whose pictures are all there pays nothing.
//
// The button lives in the view's per-page overlay (removed with it when the
// page leaves the render window) and is placed in FRACTIONS of the shown page,
// so a zoom never moves it off its picture. Its press is kept from the tools by
// the shell's capture listener (`RELINK_BUTTON` there).

import type { MediaRef, PdfRotation } from "../../core/types";
import { icon } from "../../ui/icons";
import { mediaFileKey, missingPicturesOn, nextMissingSet, pageAnnots, usedPictureFiles } from "../model";
import type { PdfEditorCtx } from "../types";
import { button } from "./el";

/** The class the shell's capture listener recognises. */
export const RELINK_BUTTON = "pdfed-relink-pic";

/** Where a page-space point shows on a page shown turned clockwise by `rot`,
 *  as fractions (0..1) of the shown page. `w`×`h`: the unrotated page. Pure. */
export function shownFraction(x: number, y: number, w: number, h: number, rot: PdfRotation): { fx: number; fy: number } {
  const u = w > 0 ? x / w : 0.5;
  const v = h > 0 ? y / h : 0.5;
  switch (rot) {
    case 90:
      return { fx: 1 - v, fy: u };
    case 180:
      return { fx: 1 - u, fy: 1 - v };
    case 270:
      return { fx: v, fy: 1 - u };
    default:
      return { fx: u, fy: v };
  }
}

const normRot = (deg: number): PdfRotation => ((((Math.round(deg / 90) % 4) + 4) % 4) * 90) as PdfRotation;

export interface MissingPictureButtons {
  /** place the buttons again (the project or the missing files changed) */
  refresh(): void;
  dispose(): void;
}

export function mountMissingPictureButtons(ctx: PdfEditorCtx, onRelink: (mediaIds: string[]) => void): MissingPictureButtons {
  const { session, view } = ctx;
  let disposed = false;
  /** rendered pages: their overlay, and the button shown on it */
  const shown = new Map<string, { overlay: HTMLElement; btn: HTMLButtonElement | null; token: number }>();
  let tokens = 0;

  const isMissing = (ref: MediaRef): boolean => {
    const set = ctx.missingPictures?.get();
    return !!set && set.has(mediaFileKey(ref));
  };

  function place(key: string): void {
    const slot = shown.get(key);
    if (!slot) return;
    slot.btn?.remove();
    slot.btn = null;
    const token = (slot.token = ++tokens);
    const p = session.project;
    const ids = missingPicturesOn(p, key, isMissing);
    if (ids.length === 0) return;
    const first = pageAnnots(p, key).find((a) => a.t === "image" && a.media === ids[0]);
    const page = p.pdf?.pages.find((pg) => pg.id === key);
    if (!first || first.t !== "image" || !page) return;
    const put = (w: number, h: number, rot: PdfRotation): void => {
      if (disposed || shown.get(key) !== slot || slot.token !== token) return;
      const { fx, fy } = shownFraction(first.x + first.w / 2, first.y + first.h / 2, w, h, rot);
      const b = button("btn--sm", { className: RELINK_BUTTON, icon: icon("warning", 14), text: "Relink picture", title: "Find this picture's file again" });
      b.style.left = `${Math.round(fx * 1e5) / 1e3}%`;
      b.style.top = `${Math.round(fy * 1e5) / 1e3}%`;
      b.addEventListener("click", (e) => {
        if (e.detail > 0) b.blur();
        // the files missing on this page NOW (one may have been relinked)
        const now = missingPicturesOn(session.project, key, isMissing);
        if (now.length > 0) onRelink(now);
      });
      slot.overlay.appendChild(b);
      slot.btn = b;
    };
    if (page.src === null) {
      put(page.w ?? 612, page.h ?? 792, normRot(page.rotate));
      return;
    }
    const doc = ctx.docs.get(page.src);
    if (!doc) {
      // a source that did not open: its page shows at the default size
      put(612, 792, normRot(page.rotate));
      return;
    }
    void doc.pageInfo(page.page).then(
      (i) => put(i.w, i.h, normRot(i.rotate + page.rotate)),
      () => {},
    );
  }

  const unVisible = view.on("pagevisible", (e) => {
    shown.get(e.key)?.btn?.remove();
    shown.set(e.key, { overlay: e.overlay, btn: null, token: 0 });
    place(e.key);
  });
  const unHidden = view.on("pagehidden", (e) => {
    shown.get(e.key)?.btn?.remove();
    shown.delete(e.key);
  });
  // Pages already rendered when this mounts.
  for (const pg of session.project.pdf?.pages ?? []) {
    const overlay = view.overlay(pg.id);
    if (overlay) {
      shown.set(pg.id, { overlay, btn: null, token: 0 });
      place(pg.id);
    }
  }

  let last = session.project;
  const refresh = (): void => {
    if (disposed) return;
    last = session.project;
    for (const key of [...shown.keys()]) place(key);
  };
  const unProject = session.store.subscribe((p) => {
    // pictures move with marks, pages and files: anything else leaves them be
    const was = last;
    if (p.media === was.media && p.pdf?.annots === was.pdf?.annots && p.pdf?.pages === was.pdf?.pages) return;
    refresh();
  });
  const unMissing = ctx.missingPictures?.subscribe(refresh);

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      unVisible();
      unHidden();
      unProject();
      unMissing?.();
      for (const s of shown.values()) s.btn?.remove();
      shown.clear();
    },
  };
}

/** These files were just found on disk (a relink located one, or one was
 *  picked again to insert): they no longer count as missing. A relink to the
 *  file at its OWN place (put back, or a drive plugged in again) keeps the
 *  same identity, so only this tells the page it is back. */
export function notePicturesFound(ctx: Pick<PdfEditorCtx, "missingPictures">, files: readonly { path: string; size: number; mtimeMs: number }[]): void {
  const store = ctx.missingPictures;
  const set = store?.get();
  if (!store || !set || set.size === 0) return;
  const gone = files.map(mediaFileKey).filter((k) => set.has(k));
  if (gone.length === 0) return;
  const next = new Set(set);
  for (const k of gone) next.delete(k);
  store.set(next);
}

/**
 * Look again on disk for every picture file the project uses (`exists`: the
 * path check) and set the missing files to what is found now: a file moved
 * away while the editor is open shows its placeholder, one put back loses it.
 * Resolves true when some picture is missing afterwards. A newer check makes
 * an older one's answer moot (`isCurrent`).
 */
export async function recheckPictures(
  ctx: Pick<PdfEditorCtx, "session" | "missingPictures">,
  exists: (path: string) => Promise<boolean>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const store = ctx.missingPictures;
  if (!store) return false;
  const files = usedPictureFiles(ctx.session.project);
  if (files.length === 0) return store.get().size > 0;
  const found = await Promise.all(files.map((m) => exists(m.path).catch(() => true)));
  if (!isCurrent()) return store.get().size > 0;
  const next = nextMissingSet(store.get(), files, found.map((f) => !f));
  if (next !== store.get()) store.set(next);
  return files.some((m) => next.has(mediaFileKey(m)));
}

/** Resolves once no dialog is open (`.modal-backdrop` on the page), at once
 *  when none is. `cancel` stops waiting (the promise then never resolves). */
export function whenNoModal(): { done: Promise<void>; cancel(): void } {
  const open = (): boolean => document.querySelector(".modal-backdrop") !== null;
  let cancel = (): void => {};
  const done = new Promise<void>((resolve) => {
    if (!open()) {
      resolve();
      return;
    }
    const obs = new MutationObserver(() => {
      if (open()) return;
      obs.disconnect();
      resolve();
    });
    obs.observe(document.body, { childList: true });
    cancel = () => obs.disconnect();
  });
  return { done, cancel: () => cancel() };
}
