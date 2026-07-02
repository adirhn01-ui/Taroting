// Home screen: recents grid, search, New/Open, whole-window drag & drop.

import "./home.css";
import {
  escapeHtml,
  fileExt,
  fileStem,
  formatDuration,
  formatRelative,
} from "../core/format";
import { describeError, ipc, mediaUrl, onDragDrop, pickMediaFiles, pickProjectFile } from "../core/ipc";
import { navigate } from "../core/nav";
import { createProject, importMediaAsClip } from "../core/project";
import type { RecentItem } from "../core/types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

const MEDIA_EXTS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "gif",
  "mp3", "wav", "flac", "aac", "m4a", "ogg",
  "png", "jpg", "jpeg",
]);

export function mountHome(root: HTMLElement): { dispose(): void } {
  root.innerHTML = `
    <div class="home">
      <header class="home__header">
        <div class="home__brand"><span class="home__brand-mark">T</span>Taroting</div>
      </header>
      <main class="home__main">
        <div class="home__inner">
          <div class="home__hero">
            <div class="home__title">Projects</div>
            <div class="row" style="gap:var(--sp-2)">
              <button class="btn btn--primary" id="btn-new">${icon("plus")}New project</button>
              <button class="btn" id="btn-open">${icon("folder")}Open…</button>
            </div>
          </div>
          <input class="input home__search" id="home-search" placeholder="Search projects…" spellcheck="false" />
          <div class="recents-grid" id="recents"></div>
        </div>
      </main>
      <div class="home__drop-hint">Drop media files or a .trt project anywhere</div>
      <div class="drop-overlay" id="drop-overlay">
        <div class="drop-overlay__inner">Drop to import</div>
      </div>
    </div>
  `;

  const grid = root.querySelector<HTMLElement>("#recents")!;
  const search = root.querySelector<HTMLInputElement>("#home-search")!;
  const overlay = root.querySelector<HTMLElement>("#drop-overlay")!;

  let recents: RecentItem[] = [];
  let busy = false;

  /* ---------------- rendering ---------------- */

  function cardHtml(item: RecentItem): string {
    const thumb = item.thumb
      ? `<img src="${escapeHtml(mediaUrl(item.thumb))}" alt="" loading="lazy" />`
      : icon("film", 28);
    return `
      <div class="project-card" data-path="${escapeHtml(item.path)}" tabindex="0" role="button">
        <div class="project-card__thumb">${thumb}</div>
        <div class="project-card__meta">
          <div class="project-card__name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
          <div class="project-card__sub">
            <span>${escapeHtml(formatRelative(item.modifiedAt))}</span>
            ${item.durationSec > 0 ? `<span>·</span><span>${formatDuration(item.durationSec)}</span>` : ""}
          </div>
        </div>
        <button class="project-card__remove" data-remove="${escapeHtml(item.path)}" title="Remove from list">${icon("x", 13)}</button>
      </div>
    `;
  }

  function renderGrid(): void {
    const q = search.value.trim().toLowerCase();
    const items = q ? recents.filter((r) => r.name.toLowerCase().includes(q)) : recents;
    if (items.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1">
          ${icon("film", 32)}
          <div>${q ? "No projects match your search." : "No projects yet."}</div>
          ${q ? "" : `<div class="faint">Create one, or drop a video anywhere in this window.</div>`}
        </div>`;
      return;
    }
    grid.innerHTML = items.map(cardHtml).join("");
  }

  async function refresh(): Promise<void> {
    try {
      const index = await ipc.listRecents();
      recents = index.items;
    } catch (e) {
      toast.error(`Couldn't read recent projects: ${describeError(e)}`);
      recents = [];
    }
    renderGrid();
  }

  /* ---------------- actions ---------------- */

  function guard(): boolean {
    if (busy) return true;
    busy = true;
    return false;
  }

  async function createNew(mediaPaths: string[]): Promise<void> {
    if (guard()) return;
    try {
      const suggested = mediaPaths[0] ? fileStem(mediaPaths[0]) : undefined;
      const projectPath = await ipc.newProjectPath(suggested);
      let project = createProject(fileStem(projectPath));
      let failures = 0;
      for (const p of mediaPaths) {
        try {
          const info = await ipc.probeMedia(p);
          project = importMediaAsClip(project, info).project;
        } catch (e) {
          failures++;
          toast.error(`Couldn't import ${fileStem(p)}: ${describeError(e)}`);
        }
      }
      if (mediaPaths.length > 0 && failures === mediaPaths.length) {
        // nothing usable was imported; still open the empty project
        toast.info("Created an empty project.");
      }
      await ipc.saveProject(projectPath, project);
      navigate({ view: "editor", projectPath });
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      busy = false;
    }
  }

  async function openPath(path: string): Promise<void> {
    if (guard()) return;
    try {
      navigate({ view: "editor", projectPath: path });
    } finally {
      busy = false;
    }
  }

  async function openViaDialog(): Promise<void> {
    const path = await pickProjectFile();
    if (path) await openPath(path);
  }

  function handleDroppedPaths(paths: string[]): void {
    const project = paths.find((p) => fileExt(p) === "trt");
    if (project) {
      void openPath(project);
      return;
    }
    const media = paths.filter((p) => MEDIA_EXTS.has(fileExt(p)));
    if (media.length === 0) {
      toast.error("Unsupported file type.");
      return;
    }
    void createNew(media);
  }

  /* ---------------- wiring ---------------- */

  root.querySelector("#btn-new")!.addEventListener("click", () => void createNew([]));
  root.querySelector("#btn-open")!.addEventListener("click", () => void openViaDialog());
  search.addEventListener("input", renderGrid);

  grid.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const removeBtn = target.closest<HTMLElement>("[data-remove]");
    if (removeBtn) {
      e.stopPropagation();
      const path = removeBtn.dataset.remove!;
      void ipc.removeRecent(path).then(refresh);
      return;
    }
    const card = target.closest<HTMLElement>(".project-card");
    if (card) void openPath(card.dataset.path!);
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const card = (e.target as HTMLElement).closest<HTMLElement>(".project-card");
      if (card) void openPath(card.dataset.path!);
    }
  });

  // “New project” should also work with a picker when users prefer clicking.
  root.querySelector("#btn-new")!.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void pickMediaFiles().then((files) => {
      if (files.length) void createNew(files);
    });
  });

  let unlistenDrop: () => void = () => {};
  void onDragDrop({
    onHover: () => overlay.classList.add("active"),
    onCancel: () => overlay.classList.remove("active"),
    onDrop: (paths) => {
      overlay.classList.remove("active");
      handleDroppedPaths(paths);
    },
  }).then((u) => (unlistenDrop = u));

  void refresh();
  search.focus();

  return {
    dispose() {
      unlistenDrop();
    },
  };
}
