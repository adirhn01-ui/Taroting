// Home screen: recents grid, search, sort, New/Open, whole-window drag & drop.

import "./home.css";
import {
  escapeHtml,
  fileExt,
  fileStem,
  formatBytes,
  formatDuration,
  formatRelative,
} from "../core/format";
import { describeError, ipc, mediaUrl, onDragDrop, pickMediaFiles, pickProjectFile } from "../core/ipc";
import { navigate } from "../core/nav";
import { addMedia, createProject } from "../core/project";
import { MEDIA_FILE_EXTENSIONS } from "../core/types";
import type { RecentItem } from "../core/types";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { showMenu } from "../ui/menu";
import { toast } from "../ui/toast";

/* ---------------- sorting ---------------- */

type SortKey = "name" | "lastOpened" | "modified" | "size";
const SORT_KEY = "taroting.homeSort";
const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  lastOpened: "Last opened",
  modified: "Date modified",
  size: "Size",
};

function loadSort(): SortKey {
  const v = localStorage.getItem(SORT_KEY);
  return v === "name" || v === "lastOpened" || v === "modified" || v === "size" ? v : "lastOpened";
}

function sortRecents(items: RecentItem[], key: SortKey): RecentItem[] {
  const out = items.slice();
  switch (key) {
    case "name":
      out.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "lastOpened":
      out.sort((a, b) => Date.parse(b.openedAt ?? b.modifiedAt) - Date.parse(a.openedAt ?? a.modifiedAt));
      break;
    case "modified":
      out.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
      break;
    case "size":
      out.sort((a, b) => b.sizeBytes - a.sizeBytes);
      break;
  }
  return out;
}

/* three-dot "More" glyph (icons.ts has no such icon and isn't ours to edit) */
const MORE_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

export function mountHome(root: HTMLElement): { dispose(): void } {
  root.innerHTML = `
    <div class="home">
      <header class="home__header">
        <div class="home__brand"><span class="home__brand-mark">T</span>Taroting</div>
        <button class="btn btn--ghost btn--icon" id="home-settings" title="Settings">${icon("gear")}</button>
      </header>
      <main class="home__main">
        <div class="home__inner">
          <div class="home__hero">
            <div class="home__title">Projects</div>
            <div class="row" style="gap:var(--sp-2)">
              <button class="btn btn--primary" id="btn-new">${icon("plus")}New project</button>
              <button class="btn" id="btn-open">${icon("folder")}Open</button>
            </div>
          </div>
          <div class="home__toolbar">
            <input class="input home__search" id="home-search" placeholder="Search projects" spellcheck="false" />
            <select class="select select--sm home__sort" id="home-sort" title="Sort by">
              ${(Object.keys(SORT_LABELS) as SortKey[])
                .map((k) => `<option value="${k}">${SORT_LABELS[k]}</option>`)
                .join("")}
            </select>
          </div>
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
  const sortSelect = root.querySelector<HTMLSelectElement>("#home-sort")!;
  const overlay = root.querySelector<HTMLElement>("#drop-overlay")!;

  let recents: RecentItem[] = [];
  let sortKey: SortKey = loadSort();
  let busy = false;
  let disposed = false;
  // Paths whose thumbnail backfill we've already kicked off this mount, so
  // repeated refresh() calls (rename/delete/duplicate) never re-fire ffmpeg.
  const thumbTried = new Set<string>();
  sortSelect.value = sortKey;

  /* ---------------- rendering ---------------- */

  function cardHtml(item: RecentItem): string {
    const thumb = item.thumb
      ? `<img src="${escapeHtml(mediaUrl(item.thumb))}" alt="" loading="lazy" />`
      : icon("film", 28);
    const size = item.sizeBytes > 0 ? `<span>·</span><span>${formatBytes(item.sizeBytes)}</span>` : "";
    return `
      <div class="project-card" data-path="${escapeHtml(item.path)}" tabindex="0" role="button">
        <div class="project-card__thumb">${thumb}</div>
        <div class="project-card__meta">
          <div class="project-card__name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
          <div class="project-card__sub">
            <span>${escapeHtml(formatRelative(item.modifiedAt))}</span>
            ${item.durationSec > 0 ? `<span>·</span><span>${formatDuration(item.durationSec)}</span>` : ""}
            ${size}
          </div>
        </div>
        <button class="project-card__more" data-more="${escapeHtml(item.path)}" title="More">${MORE_SVG}</button>
      </div>
    `;
  }

  function currentItems(): RecentItem[] {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? recents.filter((r) => r.name.toLowerCase().includes(q)) : recents;
    return sortRecents(filtered, sortKey);
  }

  function renderGrid(): void {
    const items = currentItems();
    if (items.length === 0) {
      const searching = search.value.trim().length > 0;
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1">
          ${icon("film", 32)}
          <div>${searching ? "No projects match your search." : "No projects yet."}</div>
          ${searching ? "" : `<div class="faint">Create one, or drop a video anywhere in this window.</div>`}
        </div>`;
      return;
    }
    grid.innerHTML = items.map(cardHtml).join("");
  }

  /* Backfill missing thumbnails. Projects opened via the OS "Open with" get a
     recents entry before any thumb is cached, so their card shows a placeholder
     until the backend can produce one. Fire one shot per thumb-less path per
     mount (no polling/timers); on a hit, swap just that card's placeholder for
     an <img> without re-rendering the grid. */
  function backfillThumbs(): void {
    for (const item of recents) {
      if (item.thumb || thumbTried.has(item.path)) continue;
      thumbTried.add(item.path);
      const path = item.path;
      void ipc
        .refreshRecentThumb(path)
        .then((thumb) => {
          if (disposed || !thumb) return;
          // Keep the in-memory model in sync so a later renderGrid() (sort,
          // search, rename) carries the thumb through instead of dropping it.
          const model = recentByPath(path);
          if (model) model.thumb = thumb;
          const card = grid.querySelector<HTMLElement>(
            `.project-card[data-path="${CSS.escape(path)}"]`,
          );
          const thumbEl = card?.querySelector<HTMLElement>(".project-card__thumb");
          if (thumbEl) {
            thumbEl.innerHTML = `<img src="${escapeHtml(mediaUrl(thumb))}" alt="" loading="lazy" />`;
          }
        })
        .catch(() => {
          // Best-effort: the backend already fails soft to null. A fresh mount
          // clears thumbTried, so the next home visit retries.
        });
    }
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
    backfillThumbs();
  }

  function recentByPath(path: string): RecentItem | undefined {
    return recents.find((r) => r.path === path);
  }

  /* ---------------- modal helper ---------------- */

  interface ModalOpts {
    title: string;
    bodyHtml: string;
    confirmLabel: string;
    danger?: boolean;
    /** if set, a text input is shown prefilled with this value; resolves to it */
    input?: string;
    onConfirm(value: string): void | Promise<void>;
  }

  function openModal(opts: ModalOpts): void {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal home-modal" role="dialog" aria-modal="true">
        <div class="modal__header">${escapeHtml(opts.title)}</div>
        <div class="modal__body">
          ${opts.bodyHtml}
          ${opts.input !== undefined ? `<input class="input home-modal__input" id="home-modal-input" spellcheck="false" />` : ""}
        </div>
        <div class="modal__footer">
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn ${opts.danger ? "btn--danger" : "btn--primary"}" data-act="confirm">${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector<HTMLInputElement>("#home-modal-input");
    if (input) {
      input.value = opts.input!;
      input.addEventListener("focus", () => input.select());
      // defer so the modal is laid out before selecting
      requestAnimationFrame(() => input.focus());
    }

    const releaseTrap = trapTab(backdrop);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      releaseTrap();
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const confirm = async (): Promise<void> => {
      const value = input ? input.value.trim() : "";
      if (input && value.length === 0) {
        input.focus();
        return;
      }
      close();
      await opts.onConfirm(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter" && input) {
        e.preventDefault();
        void confirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('[data-act="cancel"]')!.addEventListener("click", close);
    backdrop.querySelector('[data-act="confirm"]')!.addEventListener("click", () => void confirm());
  }

  /* ---------------- project actions ---------------- */

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
      // Bin-first: media is registered only (no clips). addMedia still adopts
      // the first visual media's resolution/fps for the new project.
      for (const p of mediaPaths) {
        try {
          const info = await ipc.probeMedia(p);
          project = addMedia(project, info).project;
        } catch (e) {
          failures++;
          toast.error(`Couldn't import ${fileStem(p)}: ${describeError(e)}`);
        }
      }
      if (mediaPaths.length > 0 && failures === mediaPaths.length) {
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
      if (!(await ipc.pathExists(path))) {
        toast.error("Project file not found");
        await refresh();
        return;
      }
      navigate({ view: "editor", projectPath: path });
    } finally {
      busy = false;
    }
  }

  async function openViaDialog(): Promise<void> {
    const path = await pickProjectFile();
    if (path) await openPath(path);
  }

  function removeFromList(path: string): void {
    void ipc.removeRecent(path).then(refresh);
  }

  function promptDuplicate(item: RecentItem): void {
    openModal({
      title: "Duplicate project",
      bodyHtml: `<div class="home-modal__label">Name the copy:</div>`,
      input: `${item.name} copy`,
      confirmLabel: "Duplicate",
      onConfirm: async (value) => {
        try {
          await ipc.duplicateProject(item.path, value, crypto.randomUUID());
          await refresh();
          toast.info("Duplicated");
        } catch (e) {
          toast.error(describeError(e));
        }
      },
    });
  }

  function promptDelete(item: RecentItem): void {
    openModal({
      title: `Delete '${item.name}'?`,
      bodyHtml: `<div class="home-modal__body-text">The project file will be permanently deleted from your disk. Media files are not affected.</div>`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await ipc.deleteProject(item.path);
          await refresh();
          toast.info("Deleted");
        } catch (e) {
          toast.error(describeError(e));
        }
      },
    });
  }

  /* Inline rename: replace the card's name with an input. */
  function startRename(card: HTMLElement, item: RecentItem): void {
    const nameEl = card.querySelector<HTMLElement>(".project-card__name");
    if (!nameEl || nameEl.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "input project-card__rename";
    input.value = item.name;
    input.spellcheck = false;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const stop = (e: Event): void => e.stopPropagation();
    input.addEventListener("pointerdown", stop);
    input.addEventListener("click", stop);
    input.addEventListener("keydown", stop);

    const cancel = (): void => {
      if (done) return;
      done = true;
      nameEl.textContent = item.name;
    };
    const commit = async (): Promise<void> => {
      if (done) return;
      const value = input.value.trim();
      if (value.length === 0 || value === item.name) {
        cancel();
        return;
      }
      done = true;
      try {
        await ipc.renameProject(item.path, value);
        await refresh();
      } catch (e) {
        toast.error(describeError(e));
        nameEl.textContent = item.name;
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", () => void commit());
  }

  function openMore(path: string, x: number, y: number): void {
    const item = recentByPath(path);
    if (!item) return;
    const card = grid.querySelector<HTMLElement>(`.project-card[data-path="${CSS.escape(path)}"]`);
    showMenu(x, y, [
      { label: "Open", onSelect: () => void openPath(path) },
      { label: "Rename", onSelect: () => card && startRename(card, item) },
      { label: "Duplicate", onSelect: () => promptDuplicate(item) },
      { label: "Remove from list", onSelect: () => removeFromList(path) },
      { label: "Delete file", danger: true, onSelect: () => promptDelete(item) },
    ]);
  }

  function handleDroppedPaths(paths: string[]): void {
    const project = paths.find((p) => fileExt(p) === "trt");
    if (project) {
      void openPath(project);
      return;
    }
    const media = paths.filter((p) => MEDIA_FILE_EXTENSIONS.has(fileExt(p)));
    if (media.length === 0) {
      toast.error("Unsupported file type.");
      return;
    }
    void createNew(media);
  }

  /* ---------------- wiring ---------------- */

  root.querySelector("#btn-new")!.addEventListener("click", () => void createNew([]));
  root.querySelector("#btn-open")!.addEventListener("click", () => void openViaDialog());
  root.querySelector("#home-settings")!.addEventListener("click", () => navigate({ view: "settings" }));
  search.addEventListener("input", renderGrid);
  sortSelect.addEventListener("change", () => {
    sortKey = sortSelect.value as SortKey;
    localStorage.setItem(SORT_KEY, sortKey);
    renderGrid();
  });

  grid.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const moreBtn = target.closest<HTMLElement>("[data-more]");
    if (moreBtn) {
      e.stopPropagation();
      const rect = moreBtn.getBoundingClientRect();
      openMore(moreBtn.dataset.more!, rect.left, rect.bottom + 2);
      return;
    }
    // A rename in progress swallows its own clicks; guard the card open.
    if (target.closest(".project-card__rename")) return;
    const card = target.closest<HTMLElement>(".project-card");
    if (card) void openPath(card.dataset.path!);
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    if (target.closest(".project-card__rename")) return;
    const card = target.closest<HTMLElement>(".project-card");
    if (card) void openPath(card.dataset.path!);
  });
  grid.addEventListener("contextmenu", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".project-card");
    if (!card) return;
    e.preventDefault();
    openMore(card.dataset.path!, e.clientX, e.clientY);
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
      disposed = true;
      unlistenDrop();
    },
  };
}
