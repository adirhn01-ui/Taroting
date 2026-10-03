// Relink dialog: a self-managed modal that lets the user point missing media
// files (by id) at their new location on disk. Per row: Locate… → probe the
// chosen file → sanity-check kind + duration (warn, but allow) → replace the
// whole probed MediaRef record, clamp any clip's source window into the
// (possibly shorter) source and its crop into the (possibly smaller) frame, and
// re-track the media so previews rebuild. Unresolved rows are surfaced via a
// toast if the user closes early.

import { escapeHtml, fileExt, fileName, fileStem } from "../../core/format";
import { inTauri, ipc } from "../../core/ipc";
import { findMedia, MIN_CLIP_DUR, updateClip, updateMedia } from "../../core/project";
import type { ProjectSession } from "../../core/session";
import type { Clip, MediaInfo, MediaRef, ProjectFile } from "../../core/types";
import { focusFirst, trapTab } from "../../ui/focus";
import { icon } from "../../ui/icons";
import { toast } from "../../ui/toast";
import { clampCrop } from "../preview/canvas-math";
import type { MediaManager } from "./media";

export interface RelinkCtx {
  session: ProjectSession;
  /** Only `retrack` is used, so that is all a caller has to supply: the image
   *  editor has no MediaManager and passes its own cache invalidation. */
  media: Pick<MediaManager, "retrack">;
  /** media ids whose file is missing or changed on disk */
  missing: string[];
  /** Image projects: a photo layer may only ever be relinked to a still. A
   *  pick that is anything else is refused outright ("This isn't a still
   *  image."), with NO "Use anyway" — a video or GIF behind a photo layer is a
   *  kind change the image renderer cannot draw. Absent/false: the video
   *  editor's warn-but-allow flow, unchanged. */
  stillsOnly?: boolean;
}

/**
 * Clamp a single clip's source window into `[0, dur]` for a source that is now
 * `dur` seconds long. Both edges move: srcOut drops to EOF, and srcIn is pulled
 * back if needed so at least one min-length clip's worth of source survives
 * (`MIN_CLIP_DUR * speed` source-seconds keeps timeline duration >= MIN_CLIP_DUR
 * without touching speed). Returns null when nothing needs to change. Identity
 * (timelineStart/speed/keyframes) is the caller's to preserve; this only reports
 * the new srcIn/srcOut. Degenerate case `dur < minSrcLen`: best-effort [0, dur].
 *
 * A non-positive (or non-finite) `dur` carries NO information about the source
 * and is refused outright: ffprobe reports images as `duration: 0` (png_pipe
 * has no duration field at all), and clamping into [0, 0] would silently
 * collapse the clip to zero length, drop it off the timeline and let autosave
 * write that loss to disk 500 ms later.
 */
export function clampSrcWindow(
  clip: Pick<Clip, "srcIn" | "srcOut" | "speed">,
  dur: number,
): { srcIn: number; srcOut: number } | null {
  if (!(dur > 0)) return null; // no usable source length (image / unknown)
  if (clip.srcIn >= 0 && clip.srcOut <= dur) return null; // fits already
  const minSrcLen = MIN_CLIP_DUR * clip.speed; // source-seconds for one min clip
  const srcOut = Math.min(clip.srcOut, dur);
  const srcIn = Math.max(0, Math.min(clip.srcIn, srcOut - minSrcLen));
  return { srcIn, srcOut };
}

/** A probe result an image project may relink a photo layer to: a still file.
 *  `generator` is never set on a probe, and is tested anyway — the same rule
 *  every other `kind === "image"` check in the tree follows. The `stillsOnly`
 *  gate; exported for the tests. */
export function isStillInfo(info: MediaInfo): boolean {
  return info.kind === "image" && !info.generator;
}

/** Clamp every clip's source window for `mediaId` into the shorter source
 *  `maxDur`. Images are skipped entirely: they legitimately have no source
 *  duration (`trimClip` gives them `srcMax = Infinity` for the same reason), so
 *  their probed 0 is an absence of information, not a zero-length file.
 *  Exported for the regression tests. */
export function clampClipsToDuration(p: ProjectFile, mediaId: string, maxDur: number): ProjectFile {
  if (findMedia(p, mediaId)?.kind === "image") return p;
  let q = p;
  for (const track of q.timeline.tracks) {
    for (const c of track.clips) {
      if (c.mediaId !== mediaId) continue;
      const w = clampSrcWindow(c, maxDur);
      if (w) q = updateClip(q, c.id, (cl) => ({ ...cl, srcIn: w.srcIn, srcOut: w.srcOut }));
    }
  }
  return q;
}

/** Clamp every clip's crop rect for `mediaId` into the media's CURRENT frame.
 *  A relinked file may be smaller than the original, which would leave the crop
 *  window hanging outside the frame — the preview and the export filtergraph
 *  then disagree about the visible region. No-op when the media has no known
 *  dimensions (audio) or no clip crops anything. Exported for the tests. */
export function clampClipCrops(p: ProjectFile, mediaId: string): ProjectFile {
  const m = findMedia(p, mediaId);
  const w = m?.width;
  const h = m?.height;
  if (!w || !h) return p;
  let q = p;
  for (const track of q.timeline.tracks) {
    for (const c of track.clips) {
      if (c.mediaId !== mediaId) continue;
      const crop = c.transform?.crop;
      if (!crop) continue;
      const next = clampCrop(crop, w, h);
      if (next.x === crop.x && next.y === crop.y && next.w === crop.w && next.h === crop.h) continue;
      q = updateClip(q, c.id, (cl) => ({
        ...cl,
        transform: { ...cl.transform!, crop: next },
      }));
    }
  }
  return q;
}

/** Every OPTIONAL MediaRef field, blanked. `updateMedia` merges, so a patch
 *  built only from the fresh probe would leave the OLD file's value in place
 *  for any field the new file doesn't report (a relinked audio file has no
 *  width/height; a plain file has no generator). Spreading this first makes the
 *  probe authoritative for the whole record. `undefined` values vanish on
 *  JSON.stringify, so nothing extra is written to the `.trt`. */
const BLANK_OPTIONAL_MEDIA: Partial<MediaRef> = {
  fps: undefined,
  width: undefined,
  height: undefined,
  container: undefined,
  vcodec: undefined,
  acodec: undefined,
  pixFmt: undefined,
  bitDepth: undefined,
  audioRate: undefined,
  audioChannels: undefined,
  generator: undefined,
  // A still's "this size already accounts for EXIF" stamp: a claim about the
  // OLD file. Relinked to a video (or anything else the probe does not stamp),
  // the record must not inherit it.
  oriented: undefined,
  // "Export this file -noautorotate": decided per FILE from the old file's
  // header. Inherited by a new file whose tag the WebView turns, it would
  // make the export decode that photo unturned against its turned size.
  noAutorotate: undefined,
};

/** Point `mediaId` at a freshly probed file and repair everything that derives
 *  from the media's identity. Pure — exported for the regression tests. */
export function applyRelink(
  p: ProjectFile,
  mediaId: string,
  path: string,
  info: MediaInfo,
): ProjectFile {
  // Replace the ENTIRE probed record, not just path/size/mtime/duration. The
  // dialog explicitly allows a mismatched file ("Use anyway"), so kind, width,
  // height, fps and hasAudio can all change — and stale dims make
  // computeTransformInto fit to the OLD aspect (stretching the video), clamp
  // crop against the old frame, and size the export's alphamerge mask from
  // dimensions the source no longer has.
  let q = updateMedia(p, mediaId, { ...BLANK_OPTIONAL_MEDIA, ...info, path });
  q = clampClipsToDuration(q, mediaId, info.duration);
  q = clampClipCrops(q, mediaId);
  return q;
}

/** Returns the dialog's closer for the screen that opened it: the dialog is
 *  parked on document.body, so a navigation that tears the editor down (an
 *  Explorer open, the window's own flow) must close it too — left behind it
 *  sits over the next screen and relinks into a project nobody saves. The
 *  closer is quiet (no "still missing" toast) and a no-op once closed. */
export function openRelinkDialog(ctx: RelinkCtx): () => void {
  const { session, media } = ctx;
  // resolve ids → refs once; ignore ids no longer present
  const rows = ctx.missing
    .map((id) => findMedia(session.project, id))
    .filter((m): m is MediaRef => m !== undefined);

  if (rows.length === 0) return () => {};

  const resolved = new Set<string>();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal relink-modal" role="dialog" aria-modal="true" aria-label="Relink media">
      <div class="modal__header">
        <span>Relink missing media</span>
        <button class="btn btn--ghost btn--icon btn--sm" data-close title="Close">${icon("x", 14)}</button>
      </div>
      <div class="modal__body">
        <div class="relink-list" id="rl-list"></div>
      </div>
      <div class="modal__footer">
        <button class="btn btn--primary" data-close-btn>Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const listEl = backdrop.querySelector<HTMLElement>("#rl-list")!;

  const releaseTrap = trapTab(backdrop);

  let closed = false;
  /** Closed by the screen that opened it (the quiet closer: an Explorer open
   *  replaced the editor) rather than by the user's own Close. */
  let closedByScreen = false;
  function close(quiet = false): void {
    if (closed) return;
    closed = true;
    closedByScreen = quiet;
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    backdrop.remove();
    if (quiet) return;
    const left = rows.length - resolved.size;
    if (left > 0) {
      toast.error(`${left} media file(s) still missing on disk.`);
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKeydown, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("[data-close]")!.addEventListener("click", () => close());
  backdrop.querySelector("[data-close-btn]")!.addEventListener("click", () => close());

  /** Apply a probed replacement for a media id. A closed dialog applies
   *  nothing: the editor that opened it has closed with it, and its session
   *  must not take a relink nobody will see saved. */
  function apply(m: MediaRef, path: string, info: MediaInfo, row: HTMLElement): void {
    if (closed) return;
    session.commit((p) => applyRelink(p, m.id, path, info));
    // `fileChanged`: this is a different file now, so the old one's waveform
    // and thumbnail go with it instead of standing in until a reopen.
    media.retrack(m.id, true);
    resolved.add(m.id);
    markResolved(row, path);
  }

  /** The row is the one Locate was pressed on, handed through rather than
   *  looked up again: a lookup built a selector from the media id, and an id
   *  holding a quote or a bracket made querySelector throw AFTER the relink
   *  had committed, so the row never said "Relinked". */
  function markResolved(row: HTMLElement, path: string): void {
    row.classList.add("relink-row--resolved");
    const status = row.querySelector<HTMLElement>(".relink-row__status");
    if (status) {
      status.className = "relink-row__status relink-row__status--ok";
      status.textContent = "Relinked";
    }
    const btn = row.querySelector<HTMLButtonElement>("[data-locate]");
    if (btn) btn.disabled = true;
    const warn = row.querySelector<HTMLElement>(".relink-row__warn");
    if (warn) warn.remove();
    row.title = path;
  }

  /** Show an inline "kind/duration differs" warning with a Use-anyway button. */
  function showWarn(row: HTMLElement, message: string, onProceed: () => void): void {
    row.querySelector(".relink-row__warn")?.remove();
    const warn = document.createElement("div");
    warn.className = "relink-row__warn";
    warn.innerHTML = `${icon("warning", 14)}<span>${escapeHtml(message)}</span>
      <button class="btn btn--sm" data-use>Use anyway</button>`;
    warn.querySelector("[data-use]")!.addEventListener("click", () => {
      warn.remove();
      onProceed();
    });
    row.appendChild(warn);
  }

  async function locate(m: MediaRef, row: HTMLElement): Promise<void> {
    if (!inTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const ext = fileExt(m.path);
    const picked = await open({
      multiple: false,
      filters: ext ? [{ name: fileStem(m.path), extensions: [ext] }] : undefined,
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    // The picker and the probe below are awaits the dialog can close across.
    if (closed) {
      refuseClosed(path);
      return;
    }

    const status = row.querySelector<HTMLElement>(".relink-row__status");
    if (status) {
      status.className = "relink-row__status";
      status.textContent = "Checking";
    }

    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(path);
    } catch (e) {
      if (closed) {
        refuseClosed(path);
        return;
      }
      if (status) {
        status.className = "relink-row__status relink-row__status--bad";
        status.textContent = "Couldn't read that file.";
      }
      void e;
      return;
    }
    if (closed) {
      refuseClosed(path);
      return;
    }

    // Refused, not warned: there is nothing to "use anyway" in an image
    // project, whose renderer only draws stills. A warning left by an earlier
    // pick in this row goes too, so its button cannot apply that older file.
    if (ctx.stillsOnly && !isStillInfo(info)) {
      row.querySelector(".relink-row__warn")?.remove();
      if (status) {
        status.className = "relink-row__status relink-row__status--bad";
        status.textContent = "This isn't a still image.";
      }
      return;
    }

    const kindDiffers = info.kind !== m.kind;
    const oldDur = m.duration;
    const durDiffers = oldDur > 0 && Math.abs(info.duration - oldDur) / oldDur > 0.01;
    if (kindDiffers || durDiffers) {
      const parts: string[] = [];
      if (kindDiffers) parts.push(`kind ${m.kind} → ${info.kind}`);
      if (durDiffers) parts.push(`length ${oldDur.toFixed(1)}s → ${info.duration.toFixed(1)}s`);
      if (status) status.textContent = "Differs from original";
      showWarn(row, `This file differs (${parts.join(", ")}).`, () => apply(m, path, info, row));
      return;
    }
    apply(m, path, info, row);
  }

  /** A pick that answered after the dialog closed is dropped. When the screen
   *  closed it, the user never chose to stop, so they are told; a dialog they
   *  closed themselves needs no word. */
  function refuseClosed(path: string): void {
    if (closedByScreen) toast.refuse(`${fileName(path)} wasn't relinked because the project was closed.`);
  }

  for (const m of rows) {
    const row = document.createElement("div");
    row.className = "relink-row";
    row.dataset.row = m.id;
    row.innerHTML = `
      <div class="relink-row__info">
        <div class="relink-row__name">${escapeHtml(fileStem(m.path))}</div>
        <div class="relink-row__path" title="${escapeHtml(m.path)}">${escapeHtml(m.path)}</div>
        <div class="relink-row__status relink-row__status--bad">Missing</div>
      </div>
      <button class="btn btn--sm" data-locate>${icon("folder", 14)}Locate</button>
    `;
    row.querySelector("[data-locate]")!.addEventListener("click", () => void locate(m, row));
    listEl.appendChild(row);
  }

  // Seated after the rows exist, or there is no Locate button to aim at. The
  // first one is the whole point of the dialog, and this is also the only reason
  // `trapTab` above does anything at all: the trap listens on the backdrop, so
  // until focus is inside it, Tab walks the editor behind a "your files are
  // missing" dialog and Enter lands on a timeline control. This file had no
  // focus call of any kind, so the trap had never engaged.
  //
  // Close is named explicitly for the rowless case (which the early return
  // above makes unreachable today) — the bare fallback would settle on the
  // header X, and the footer button is the one the eye goes to.
  const firstLocate = backdrop.querySelector("[data-locate]");
  focusFirst(backdrop, firstLocate ? "[data-locate]" : "[data-close-btn]");
  return () => close(true);
}
