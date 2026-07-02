// Relink dialog: a self-managed modal that lets the user point missing media
// files (by id) at their new location on disk. Per row: Locate… → probe the
// chosen file → sanity-check kind + duration (warn, but allow) → patch the
// MediaRef (path/size/mtime), clamp any clip srcOut that now overruns the
// shorter source, and re-track the media so previews rebuild. Unresolved rows
// are surfaced via a toast if the user closes early.

import { escapeHtml, fileExt, fileStem } from "../../core/format";
import { inTauri, ipc } from "../../core/ipc";
import { findMedia, updateClip, updateMedia } from "../../core/project";
import type { ProjectSession } from "../../core/session";
import type { MediaInfo, MediaRef, ProjectFile } from "../../core/types";
import { icon } from "../../ui/icons";
import { toast } from "../../ui/toast";
import type { MediaManager } from "./media";

export interface RelinkCtx {
  session: ProjectSession;
  media: MediaManager;
  /** media ids whose file is missing or changed on disk */
  missing: string[];
}

/** Clamp every clip's srcOut for `mediaId` down to `maxDur` if it overruns. */
function clampClipsToDuration(p: ProjectFile, mediaId: string, maxDur: number): ProjectFile {
  let q = p;
  for (const track of q.timeline.tracks) {
    for (const c of track.clips) {
      if (c.mediaId !== mediaId || c.srcOut <= maxDur) continue;
      const srcOut = Math.max(c.srcIn, maxDur);
      q = updateClip(q, c.id, (cl) => ({ ...cl, srcOut }));
    }
  }
  return q;
}

export function openRelinkDialog(ctx: RelinkCtx): void {
  const { session, media } = ctx;
  // resolve ids → refs once; ignore ids no longer present
  const rows = ctx.missing
    .map((id) => findMedia(session.project, id))
    .filter((m): m is MediaRef => m !== undefined);

  if (rows.length === 0) return;

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

  function close(): void {
    document.removeEventListener("keydown", onKeydown, true);
    backdrop.remove();
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
  backdrop.querySelector("[data-close]")!.addEventListener("click", close);
  backdrop.querySelector("[data-close-btn]")!.addEventListener("click", close);

  /** Apply a probed replacement for a media id. */
  function apply(m: MediaRef, path: string, info: MediaInfo): void {
    session.commit((p) => {
      let q = updateMedia(p, m.id, {
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        duration: info.duration,
      });
      q = clampClipsToDuration(q, m.id, info.duration);
      return q;
    });
    media.retrack(m.id);
    resolved.add(m.id);
    markResolved(m.id, path);
  }

  function markResolved(id: string, path: string): void {
    const row = listEl.querySelector<HTMLElement>(`[data-row="${id}"]`);
    if (!row) return;
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

    const status = row.querySelector<HTMLElement>(".relink-row__status");
    if (status) {
      status.className = "relink-row__status";
      status.textContent = "Checking…";
    }

    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(path);
    } catch (e) {
      if (status) {
        status.className = "relink-row__status relink-row__status--bad";
        status.textContent = "Couldn't read that file.";
      }
      void e;
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
      showWarn(row, `This file differs (${parts.join(", ")}).`, () => apply(m, path, info));
      return;
    }
    apply(m, path, info);
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
      <button class="btn btn--sm" data-locate>${icon("folder", 14)}Locate…</button>
    `;
    row.querySelector("[data-locate]")!.addEventListener("click", () => void locate(m, row));
    listEl.appendChild(row);
  }
}
