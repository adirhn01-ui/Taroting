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
import { focusFirst, trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { closeMenu, showMenu } from "../ui/menu";
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

/* Checkmark for the selection badge (icons.ts has no such icon and isn't ours to edit) */
const CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 12.5 10 17.5 19 6.5"/></svg>';

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
            <div class="row home__actions" id="home-actions">
              <button class="btn btn--primary" id="btn-new">${icon("plus")}New project</button>
              <button class="btn" id="btn-open">${icon("folder")}Open</button>
              <button class="btn btn--ghost" id="btn-select" title="Select projects" hidden>Select</button>
            </div>
            <div class="row home__select-bar" id="home-select-bar" hidden>
              <span class="home__select-count" id="home-select-count">0 selected</span>
              <button class="btn btn--danger" id="btn-select-delete" title="Delete selected projects" disabled>${icon("trash")}Delete</button>
              <button class="btn btn--ghost" id="btn-select-all" title="Select all projects matching the current search">Select all</button>
              <button class="btn btn--ghost" id="btn-select-cancel" title="Leave select mode">Cancel</button>
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
  const actionsBar = root.querySelector<HTMLElement>("#home-actions")!;
  const selectBar = root.querySelector<HTMLElement>("#home-select-bar")!;
  const selectBtn = root.querySelector<HTMLButtonElement>("#btn-select")!;
  const selectCount = root.querySelector<HTMLElement>("#home-select-count")!;
  const selectDeleteBtn = root.querySelector<HTMLButtonElement>("#btn-select-delete")!;
  const selectAllBtn = root.querySelector<HTMLButtonElement>("#btn-select-all")!;
  const selectCancelBtn = root.querySelector<HTMLButtonElement>("#btn-select-cancel")!;

  let recents: RecentItem[] = [];
  let sortKey: SortKey = loadSort();
  let busy = false;
  let disposed = false;
  // Multi-select state. `selection` survives re-renders (search/sort) while the
  // mode is active; entries that scroll out of the current filter stay selected
  // unless deleted. `deleting` guards the mass-delete against double-fire.
  let selectMode = false;
  let deleting = false;
  const selection = new Set<string>();
  // Set true while an inline rename input is live; blocks entering select mode.
  let renaming = false;
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
    const selected = selectMode && selection.has(item.path);
    return `
      <div class="project-card${selected ? " is-selected" : ""}" data-path="${escapeHtml(item.path)}" tabindex="0" role="button"${selected ? ' aria-pressed="true"' : ""}>
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
        <div class="project-card__check" aria-hidden="true">${CHECK_SVG}</div>
      </div>
    `;
  }

  function currentItems(): RecentItem[] {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? recents.filter((r) => r.name.toLowerCase().includes(q)) : recents;
    return sortRecents(filtered, sortKey);
  }

  function renderGrid(): void {
    grid.classList.toggle("recents-grid--select", selectMode);
    const items = currentItems();
    if (items.length === 0) {
      const searching = search.value.trim().length > 0;
      grid.innerHTML = `
        <div class="empty-state">
          ${icon("film", 32)}
          <div>${searching ? "No projects match your search." : "No projects yet."}</div>
          ${searching ? "" : `<div class="faint">Create one, or drop a video anywhere in this window.</div>`}
        </div>`;
      return;
    }
    grid.innerHTML = items.map(cardHtml).join("");
  }

  /* The Select entry point is meaningless with zero projects; hide it there.
     A live rename would be lost on entering select mode, so disable until it
     commits. Called after every refresh() and whenever rename state flips. */
  function syncSelectAvailability(): void {
    if (selectMode) return;
    selectBtn.hidden = recents.length === 0;
    selectBtn.disabled = renaming;
  }

  /* ---------------- multi-select ---------------- */

  /* Reflect selection count into the bar: label + Delete enablement. */
  function updateSelectBar(): void {
    const n = selection.size;
    selectCount.textContent = `${n} selected`;
    selectDeleteBtn.disabled = n === 0 || deleting;
  }

  function enterSelectMode(): void {
    if (selectMode || renaming || recents.length === 0) return;
    selectMode = true;
    selection.clear();
    actionsBar.hidden = true;
    selectBar.hidden = false;
    updateSelectBar();
    renderGrid();
    selectCancelBtn.focus();
  }

  /* Leaving always clears the selection (per spec). Safe to call redundantly.
     A mid-flight mass-delete owns the exit itself; don't tear the mode down
     under it. (The delete run calls this once it finishes.) */
  function leaveSelectMode(): void {
    if (!selectMode || deleting) return;
    selectMode = false;
    selection.clear();
    selectBar.hidden = true;
    actionsBar.hidden = false;
    renderGrid();
    syncSelectAvailability();
    if (!selectBtn.hidden && !selectBtn.disabled) selectBtn.focus();
  }

  function toggleSelection(path: string): void {
    if (selection.has(path)) selection.delete(path);
    else selection.add(path);
    const card = grid.querySelector<HTMLElement>(
      `.project-card[data-path="${CSS.escape(path)}"]`,
    );
    if (card) {
      const on = selection.has(path);
      card.classList.toggle("is-selected", on);
      if (on) card.setAttribute("aria-pressed", "true");
      else card.removeAttribute("aria-pressed");
    }
    updateSelectBar();
  }

  /* "Select all" targets the CURRENT filter (the visible cards) — not the whole
     recents list — matching the button title. Paths already selected but hidden
     by the filter are left untouched. */
  function selectAllVisible(): void {
    for (const item of currentItems()) selection.add(item.path);
    renderGrid();
    updateSelectBar();
  }

  function confirmDeleteSelection(): void {
    const paths = [...selection];
    if (paths.length === 0 || deleting) return;
    const n = paths.length;
    openModal({
      title: n === 1 ? "Delete 1 project?" : `Delete ${n} projects?`,
      bodyHtml: `<div class="home-modal__body-text">The ${n === 1 ? "project file" : `${n} project files`} will be permanently deleted from your disk. Media files are not affected.</div>`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        // Guard the whole run: a double confirm (Enter + click) can't fire twice.
        if (deleting || disposed) return;
        deleting = true;
        updateSelectBar();
        let failures = 0;
        for (const path of paths) {
          try {
            await ipc.deleteProject(path);
          } catch {
            failures++;
          }
        }
        deleting = false;
        // The view may have been torn down mid-delete; don't touch dead DOM.
        if (disposed) return;
        if (failures === 0) {
          toast.info(n === 1 ? "Deleted 1 project" : `Deleted ${n} projects`);
        } else {
          toast.error(`${failures} of ${n} projects couldn't be deleted`);
        }
        leaveSelectMode();
        await refresh();
      },
    });
  }

  /* Backfill missing thumbnails. Projects opened via the OS "Open with" get a
     recents entry before any thumb is cached, so their card shows a placeholder
     until the backend can produce one. Fire one shot per thumb-less path per
     mount (no polling/timers); on a hit, swap just that card's placeholder for
     an <img> without re-rendering the grid. */
  /** Cards per backend call. The batched command does ONE recents read/write and
   *  ONE thumbs-dir scan per call, so a whole mount used to cost ~7 filesystem
   *  ops per card. Batching all of them would be cheapest, but generation inside
   *  a batch is sequential — on a cold thumb cache the grid would then sit blank
   *  and fill in one jump. Four keeps the fill progressive while still cutting
   *  the writes several-fold. */
  const THUMB_BATCH = 4;

  function paintThumb(path: string, thumb: string): void {
    // Keep the in-memory model in sync so a later renderGrid() (sort, search,
    // rename) carries the thumb through instead of dropping it.
    const model = recentByPath(path);
    if (model) model.thumb = thumb;
    const card = grid.querySelector<HTMLElement>(
      `.project-card[data-path="${CSS.escape(path)}"]`,
    );
    const thumbEl = card?.querySelector<HTMLElement>(".project-card__thumb");
    if (thumbEl) {
      thumbEl.innerHTML = `<img src="${escapeHtml(mediaUrl(thumb))}" alt="" loading="lazy" />`;
    }
  }

  function backfillThumbs(): void {
    const pending: string[] = [];
    for (const item of recents) {
      if (item.thumb || thumbTried.has(item.path)) continue;
      thumbTried.add(item.path);
      pending.push(item.path);
    }
    for (let i = 0; i < pending.length; i += THUMB_BATCH) {
      const batch = pending.slice(i, i + THUMB_BATCH);
      void ipc
        .refreshRecentThumbs(batch)
        .then((found) => {
          if (disposed) return;
          // Only projects that resolved come back; a missing key is the batch
          // equivalent of the single-path `null`.
          for (const [path, thumb] of Object.entries(found)) {
            if (thumb) paintThumb(path, thumb);
          }
        })
        .catch(() => {
          // Best-effort: the backend already fails soft. A fresh mount clears
          // thumbTried, so the next home visit retries.
        });
    }
  }

  async function refresh(): Promise<void> {
    // Every caller is an async continuation of something the user started —
    // delete, duplicate, rename, remove-from-list, the not-found path in
    // openPath — so any of them can land after the screen is gone. One guard
    // here covers all of them instead of one per call site: no recents read for
    // a screen nobody is looking at, and no paint into detached DOM.
    if (disposed) return;
    try {
      const index = await ipc.listRecents();
      recents = index.items;
    } catch (e) {
      toast.error(`Couldn't read recent projects: ${describeError(e)}`);
      recents = [];
    }
    renderGrid();
    backfillThumbs();
    syncSelectAvailability();
  }

  function recentByPath(path: string): RecentItem | undefined {
    return recents.find((r) => r.path === path);
  }

  /* ---------------- modal helper ---------------- */

  /* Closers for everything this screen has parked on document.body.
   *
   * A modal backdrop is appended to document.body, NOT to the screen's own
   * subtree — it has to be, to sit above everything. But the router tears a
   * screen down by calling dispose() and then clearing #app, and neither of
   * those touches document.body. An open dialog therefore outlives the screen
   * that opened it: still visible, still holding the focus trap, still wired to
   * this screen's callbacks. On the "Delete 'X'?" dialog that means a Delete
   * button floating over the editor that really does delete the file.
   *
   * The way this happens without anyone doing anything odd: open the delete
   * confirm on home, then let an OS "open with" arrive (double-click a .trt or
   * a media file in Explorer, or a second launch forwarding a path).
   * routeOpenPath navigates straight to the editor without closing anything.
   *
   * So: everything appended to document.body registers its closer here, and
   * teardown closes the lot. */
  const openOverlays = new Set<() => void>();

  function closeOverlays(): void {
    // Each close() removes itself from the set, so iterate a copy.
    for (const close of [...openOverlays]) close();
    openOverlays.clear();
  }

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
    // Nothing new goes onto document.body once the screen is gone: teardown has
    // already run, so there would be no owner left to close it.
    if (disposed) return;
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
    } else {
      // Nothing to type into, so focus a BUTTON — the trap only exists while
      // focus is inside the backdrop, and a confirm that opens with focus on
      // <body> lets Tab walk the project grid behind it.
      //
      // Never the red one. A danger modal's confirm deletes a real file for
      // good, and seating focus there turns "Tab escaped the dialog" into "Enter
      // permanently deleted a project" — a worse bug than the one being fixed.
      // Cancel is also what enterSelectMode focuses, so the screen stays
      // consistent about where a destructive prompt starts.
      focusFirst(backdrop, opts.danger ? '[data-act="cancel"]' : '[data-act="confirm"]');
    }

    const releaseTrap = trapTab(backdrop);
    let closed = false;
    // Every exit — Cancel, confirm, Escape, a click on the backdrop, and
    // teardown — funnels through here, which is what keeps the focus trap from
    // being released on some paths and not others.
    const close = (): void => {
      if (closed) return;
      closed = true;
      openOverlays.delete(close);
      releaseTrap();
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    openOverlays.add(close);
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
      // Probing and importing take real time, and an OS "open with" can land a
      // whole navigation inside that window. A screen that has been torn down
      // must not steer the app afterwards: whatever replaced it is the newer
      // intent, and jumping to this project instead would silently override it.
      // Nothing is lost either way — save_project has already written the file
      // and upserted it into recents, so it is one click away on the next visit.
      if (disposed) return;
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
      // The existence check is a disk round-trip; see createNew for why a
      // disposed screen must not navigate once it resolves.
      if (disposed) return;
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
        // Same guard the bulk delete carries: a confirm must not act on behalf
        // of a screen that no longer exists. Teardown closes the dialog now, so
        // this should be unreachable — but it is the second lock on the door
        // that made the first one's absence destructive.
        if (disposed) return;
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
        // Never delete a file for a screen the user has already left — see the
        // note on promptDuplicate. This is the one where the missing guard cost
        // real data.
        if (disposed) return;
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
    // Rename is inert during select mode (cards are selection targets there).
    if (selectMode) return;
    const nameEl = card.querySelector<HTMLElement>(".project-card__name");
    if (!nameEl || nameEl.querySelector("input")) return;
    // Flag a live rename so entering select mode is blocked until it resolves.
    renaming = true;
    syncSelectAvailability();
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

    const finishRename = (): void => {
      renaming = false;
      syncSelectAvailability();
    };
    const cancel = (): void => {
      if (done) return;
      done = true;
      nameEl.textContent = item.name;
      finishRename();
    };
    const commit = async (): Promise<void> => {
      if (done) return;
      const value = input.value.trim();
      if (value.length === 0 || value === item.name) {
        cancel();
        return;
      }
      done = true;
      finishRename();
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

  selectBtn.addEventListener("click", enterSelectMode);
  selectCancelBtn.addEventListener("click", leaveSelectMode);
  selectAllBtn.addEventListener("click", selectAllVisible);
  selectDeleteBtn.addEventListener("click", confirmDeleteSelection);
  // Esc leaves select mode. Capture phase so it beats the search field; skipped
  // when a modal is up so Esc there cancels the dialog, not the whole mode.
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !selectMode || deleting) return;
    if (document.querySelector(".modal-backdrop")) return;
    e.preventDefault();
    leaveSelectMode();
  };
  document.addEventListener("keydown", onEscape, true);

  grid.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    // In select mode a card click toggles selection and never opens; the "..."
    // menu and rename affordances are inert.
    if (selectMode) {
      const card = target.closest<HTMLElement>(".project-card");
      if (card) toggleSelection(card.dataset.path!);
      return;
    }
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
    // Enter toggles selection in select mode instead of opening.
    if (selectMode) {
      const card = target.closest<HTMLElement>(".project-card");
      if (card) {
        e.preventDefault();
        toggleSelection(card.dataset.path!);
      }
      return;
    }
    if (target.closest(".project-card__rename")) return;
    const card = target.closest<HTMLElement>(".project-card");
    if (card) void openPath(card.dataset.path!);
  });
  grid.addEventListener("contextmenu", (e) => {
    // The per-card menu is inert during select mode.
    if (selectMode) return;
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

  // Registration is async, so dispose() can land BEFORE the listener exists.
  // Start from null (not a no-op) and hand the real unlisten straight back if
  // teardown already happened: calling a placeholder would leak the listener
  // for the rest of the process, and a later drop would then run this dead
  // handler as well as the live screen's.
  let unlistenDrop: (() => void) | null = null;
  void onDragDrop({
    onHover: () => overlay.classList.add("active"),
    onCancel: () => overlay.classList.remove("active"),
    onDrop: (paths) => {
      overlay.classList.remove("active");
      handleDroppedPaths(paths);
    },
  }).then((u) => {
    if (disposed) u();
    else unlistenDrop = u;
  });

  void refresh();
  search.focus();

  return {
    dispose() {
      disposed = true;
      unlistenDrop?.();
      unlistenDrop = null;
      document.removeEventListener("keydown", onEscape, true);
      // The context menu and any open dialog live on document.body, outside the
      // subtree the router clears — and both hold callbacks (promptDelete,
      // startRename, the confirm handler) that reach back into this screen.
      // Closing them is teardown's job; nothing else will ever do it.
      closeMenu();
      closeOverlays();
    },
  };
}
