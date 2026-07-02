// Editor shell: loads the project, owns the session (autosave, undo) and the
// media manager. M2 renders a live media panel; preview/timeline land in M3.

import "./editor.css";
import { escapeHtml, fileExt, fileStem, formatDuration } from "../core/format";
import { describeError, ipc, mediaUrl, onDragDrop, pickMediaFiles } from "../core/ipc";
import { navigate } from "../core/nav";
import { importMediaAsClip } from "../core/project";
import { ProjectSession, currentSession } from "../core/session";
import { MEDIA_FILE_EXTENSIONS } from "../core/types";
import type { MediaInfo, MediaRef } from "../core/types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { MediaManager } from "./media/media";

export async function mountEditor(
  root: HTMLElement,
  projectPath: string,
): Promise<{ dispose(): Promise<void> }> {
  let loaded;
  try {
    loaded = await ipc.loadProject(projectPath);
  } catch (e) {
    toast.error(describeError(e));
    navigate({ view: "home" });
    return { dispose: async () => {} };
  }

  const session = new ProjectSession(projectPath, loaded.project);
  currentSession.set(session);
  const media = new MediaManager(() => session.project);
  await media.init();
  media.ensureAll(session.project);

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");
  if (loaded.missing.length > 0) {
    toast.error(
      `${loaded.missing.length} media file(s) are missing on disk. Relinking arrives in a later update.`,
    );
  }

  root.innerHTML = `
    <div class="editor">
      <div class="editor__topbar">
        <button class="btn btn--ghost btn--icon" id="ed-home" title="Back to projects">${icon("chevronLeft")}</button>
        <div class="editor__name" id="ed-name">${escapeHtml(session.project.name)}</div>
        <div class="editor__savestate" id="ed-save">Saved</div>
        <div class="grow"></div>
        <button class="btn" id="ed-import">${icon("plus")}Import media</button>
        <button class="btn btn--primary" id="ed-export" disabled title="Export arrives in a later milestone">${icon("export")}Export</button>
      </div>
      <div class="editor__body">
        <aside class="media-panel">
          <div class="media-panel__header no-select">Media</div>
          <div class="media-list" id="media-list"></div>
        </aside>
        <div class="editor__stage empty-state grow">
          ${icon("film", 32)}
          <div>Preview &amp; timeline arrive in the next milestone.</div>
          <div class="faint">Drop more media anywhere to import.</div>
        </div>
      </div>
      <div class="drop-overlay" id="ed-drop">
        <div class="drop-overlay__inner">Drop to import into this project</div>
      </div>
    </div>
  `;

  const mediaList = root.querySelector<HTMLElement>("#media-list")!;
  const saveBadge = root.querySelector<HTMLElement>("#ed-save")!;

  /* ---------------- media panel rendering ---------------- */

  function statusHtml(m: MediaRef): string {
    const s = media.status.get()[m.id];
    if (!s || s.state === "checking") {
      return `<span class="media-row__status">Checking…</span>`;
    }
    switch (s.state) {
      case "ready":
        return `<span class="media-row__status media-row__status--ok">Ready</span>`;
      case "preparing": {
        const pct = s.ratio === null ? "" : ` ${Math.round(s.ratio * 100)}%`;
        return `
          <span class="media-row__status">Preparing${pct}</span>
          <div class="media-row__bar"><div style="width:${Math.round((s.ratio ?? 0.05) * 100)}%"></div></div>`;
      }
      case "failed":
        return `<span class="media-row__status media-row__status--bad" title="${escapeHtml(s.message)}">Failed</span>`;
    }
  }

  function renderMedia(): void {
    const items = session.project.media;
    if (items.length === 0) {
      mediaList.innerHTML = `<div class="empty-state">${icon("film", 24)}<div class="faint">No media yet.</div></div>`;
      return;
    }
    const thumbs = media.thumbs.get();
    mediaList.innerHTML = items
      .map((m) => {
        const thumb = thumbs[m.id]
          ? `<img src="${escapeHtml(mediaUrl(thumbs[m.id]!))}" alt="" />`
          : icon(m.kind === "audio" ? "music" : "film", 18);
        return `
        <div class="media-row" title="${escapeHtml(m.path)}">
          <div class="media-row__thumb">${thumb}</div>
          <div class="media-row__meta">
            <div class="media-row__name">${escapeHtml(fileStem(m.path))}</div>
            <div class="media-row__sub">${m.kind} · ${formatDuration(m.duration)}</div>
          </div>
          <div class="media-row__state">${statusHtml(m)}</div>
        </div>`;
      })
      .join("");
  }

  const unsubs = [
    session.store.subscribe(renderMedia),
    media.status.subscribe(renderMedia),
    media.thumbs.subscribe(renderMedia),
    session.saveState.subscribe((s) => {
      saveBadge.classList.toggle("editor__savestate--error", s === "error");
      saveBadge.textContent =
        s === "saved" ? "Saved" : s === "saving" ? "Saving…" : s === "dirty" ? "Edited" : "Save failed";
    }),
  ];
  renderMedia();

  /* ---------------- importing ---------------- */

  async function importPaths(paths: string[]): Promise<void> {
    const usable = paths.filter((p) => MEDIA_FILE_EXTENSIONS.has(fileExt(p)));
    if (usable.length === 0) {
      toast.error("Unsupported file type.");
      return;
    }
    for (const path of usable) {
      try {
        const info: MediaInfo = await ipc.probeMedia(path);
        session.commit((p) => importMediaAsClip(p, info).project);
      } catch (e) {
        toast.error(`Couldn't import ${fileStem(path)}: ${describeError(e)}`);
      }
    }
    media.ensureAll(session.project);
  }

  /* ---------------- wiring ---------------- */

  root.querySelector("#ed-home")!.addEventListener("click", () => navigate({ view: "home" }));
  root.querySelector("#ed-import")!.addEventListener("click", () => {
    void pickMediaFiles().then((files) => {
      if (files.length) void importPaths(files);
    });
  });

  const dropOverlay = root.querySelector<HTMLElement>("#ed-drop")!;
  let unlistenDrop: () => void = () => {};
  void onDragDrop({
    onHover: () => dropOverlay.classList.add("active"),
    onCancel: () => dropOverlay.classList.remove("active"),
    onDrop: (paths) => {
      dropOverlay.classList.remove("active");
      void importPaths(paths);
    },
  }).then((u) => (unlistenDrop = u));

  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      void session.save();
    } else if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      session.undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      session.redo();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    async dispose() {
      window.removeEventListener("keydown", onKeyDown);
      for (const u of unsubs) u();
      unlistenDrop();
      media.dispose();
      currentSession.set(null);
      await session.dispose();
    },
  };
}
