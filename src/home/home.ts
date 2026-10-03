// Home screen: recents grid, search, sort, New/Open, whole-window drag & drop.

import "./home.css";
import {
  escapeHtml,
  fileExt,
  fileName,
  fileStem,
  formatBytes,
  formatDuration,
  formatRelative,
} from "../core/format";
import { describeError, ipc, mediaUrl, onDragDrop, pickOpenFiles } from "../core/ipc";
import { navigate } from "../core/nav";
import { isTempProjectPath, runOnOpenChain } from "../core/open-media";
import { addMedia, createProject } from "../core/project";
import { chordOf, physicalChordOf } from "../core/shortcuts";
import type { ChordSource } from "../core/shortcuts";
import { MEDIA_FILE_EXTENSIONS } from "../core/types";
import type { RecentItem } from "../core/types";
import { focusFirst, trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { closeMenu, showMenu } from "../ui/menu";
import { toast } from "../ui/toast";

/* ---------------- sorting ---------------- */

export type SortKey = "name" | "lastOpened" | "modified" | "size";
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

/** The one name order on this screen, the order Explorer uses: numbers by
 *  value ("Clip 2" before "Clip 10"), case ignored. Built on first use, not at
 *  import: a collator loads collation data, and Home is on the boot path while
 *  the default sort is Last opened. */
let nameCollator: Intl.Collator | null = null;
function compareNames(a: string, b: string): number {
  nameCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return nameCollator.compare(a, b);
}

export function sortRecents(items: readonly RecentItem[], key: SortKey): RecentItem[] {
  const out = items.slice();
  switch (key) {
    case "name":
      out.sort((a, b) => compareNames(a.name, b.name));
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

/* ---------------- Open and drop routing ---------------- */

/** Where a set of chosen (or dropped) files goes. There is deliberately no
 *  viewer here: opening media from Home is starting a project with it, and
 *  the "Open as" dialog asks which kind. */
export type OpenRoute =
  | { kind: "nothing" }
  /** `ignored`: the other files that came with it (a drop only; Open refuses) */
  | { kind: "project"; path: string; ignored: number }
  /** a .trt together with anything else, another .trt included */
  | { kind: "mixed" }
  | { kind: "unsupported"; count: number }
  /** allowlisted media in natural name order, plus how many files were not */
  | { kind: "media"; media: string[]; skipped: number };

/** The allowlist, then natural name order ("2" before "10"): the pickers hand
 *  files back in no particular order, and the first file names the project
 *  and, for an image project, sets the canvas and the bottom layer. The
 *  pickers' filters can be typed around ("*.*"), so the allowlist is applied
 *  here too, as it is on every other way in. */
function mediaRoute(paths: readonly string[]): OpenRoute {
  const media = paths.filter((p) => MEDIA_FILE_EXTENSIONS.has(fileExt(p)));
  const skipped = paths.length - media.length;
  if (media.length === 0) return { kind: "unsupported", count: skipped };
  media.sort((a, b) => compareNames(fileName(a), fileName(b)));
  return { kind: "media", media, skipped };
}

/** Home's Open: one project opens; media goes to "Open as"; a project picked
 *  together with anything else is refused rather than guessed at. */
export function routeOpenPicks(paths: readonly string[]): OpenRoute {
  if (paths.length === 0) return { kind: "nothing" };
  if (paths.some((p) => fileExt(p) === "trt")) {
    return paths.length === 1 ? { kind: "project", path: paths[0]!, ignored: 0 } : { kind: "mixed" };
  }
  return mediaRoute(paths);
}

/** A drop on Home: a dropped project still opens directly (the first one, as
 *  it always has), and the rest are counted so Home can say they were not
 *  opened; media takes the same "Open as" question as Open. */
export function routeDrop(paths: readonly string[]): OpenRoute {
  if (paths.length === 0) return { kind: "nothing" };
  const project = paths.find((p) => fileExt(p) === "trt");
  if (project) return { kind: "project", path: project, ignored: paths.length - 1 };
  return mediaRoute(paths);
}

/** The information (not error) toast for a route, if any: a dropped project
 *  opens, but the files dropped with it do not, and Open refuses the same set
 *  out loud, so the drop says so too. */
export function openRouteInfo(route: OpenRoute): string | null {
  if (route.kind !== "project" || route.ignored === 0) return null;
  return `Opened the project. The other ${route.ignored === 1 ? "file was" : `${route.ignored} files were`} not opened.`;
}

/** The toast a route shows, if any. */
export function openRouteNotice(route: OpenRoute): string | null {
  switch (route.kind) {
    case "mixed":
      return "Open one project at a time, or choose media files to start a new project.";
    case "unsupported":
      return route.count === 1 ? "Unsupported file type." : `None of these ${route.count} files is a supported type.`;
    case "media":
      if (route.skipped === 0) return null;
      return route.skipped === 1
        ? "Skipped 1 file of an unsupported type."
        : `Skipped ${route.skipped} files of an unsupported type.`;
    default:
      return null;
  }
}

/* ---------------- keyboard decisions and markup (pure, exported for the tests) ---------------- */

/** The part of an event target the keyboard decisions read. */
interface Closest {
  closest(selector: string): unknown;
}

/** What Enter does on the recents grid: toggle the card in select mode, open
 *  it otherwise, or nothing. Nothing on a card's More button, because the
 *  engine turns Enter on a <button> into that button's own click, which opens
 *  the menu — opening the project here as well took the user somewhere they
 *  had not asked to go. Nothing inside a live rename either: its own handler
 *  commits it. */
export function gridEnterAction(target: Closest, selectMode: boolean): "toggle" | "open" | null {
  if (target.closest(".project-card") === null) return null;
  if (selectMode) return "toggle";
  if (target.closest("[data-more]") !== null) return null;
  if (target.closest(".project-card__rename") !== null) return null;
  return "open";
}

/** Whether Enter confirms a Home dialog: only when typed into its name field.
 *  On a button the engine already activates that button, so Enter on a
 *  focused Cancel cancels; confirming from the dialog's keydown as well (and
 *  calling preventDefault, which suppressed Cancel's own click) made Cancel
 *  duplicate. An Enter that ends an IME composition is the IME's. */
export function modalEnterConfirms(
  e: { key: string; target: unknown; isComposing?: boolean },
  input: unknown,
): boolean {
  return e.key === "Enter" && e.isComposing !== true && input != null && e.target === input;
}

/** Ctrl+F, the search shortcut: by the label the layout typed, or by the key's
 *  position where the layout typed a non-Latin letter (core/shortcuts explains
 *  the guard), so Ctrl+F on a Hebrew or Russian layout still finds. */
export function isSearchChord(e: ChordSource): boolean {
  return chordOf(e) === "Ctrl+F" || physicalChordOf(e) === "Ctrl+F";
}

/** What the grid shows when it has no cards. `error`: the recents list could
 *  not be read, which is not the same as having no projects — "No projects
 *  yet" there told the user their library was gone. */
export function emptyGridHtml(state: "error" | "searching" | "none"): string {
  if (state === "error") {
    return `
      <div class="empty-state">
        ${icon("warning", 32)}
        <div>Couldn't read your recent projects.</div>
        <div class="faint">Your project files are not affected.</div>
        <button class="btn" data-act="retry-recents">Try again</button>
      </div>`;
  }
  const searching = state === "searching";
  return `
      <div class="empty-state">
        ${icon("film", 32)}
        <div>${searching ? "No projects match your search." : "No projects yet."}</div>
        ${searching ? "" : `<div class="faint">Create one, or drop a video anywhere in this window.</div>`}
      </div>`;
}

/** One line per temporary project a crash or a logoff left behind with edits
 *  in it. Keyed by index, never by path, so no path has to survive a trip
 *  through an attribute; the name is the file's own (a temporary project is
 *  named after its media). */
export function orphanRowsHtml(paths: readonly string[]): string {
  return paths
    .map(
      (p, i) => `
      <div class="home-recover__row">
        <span class="home-recover__text">Unsaved temporary project <strong>${escapeHtml(fileStem(p))}</strong> was left open when Taroting closed.</span>
        <button class="btn btn--sm" data-recover="${i}">Recover</button>
      </div>`,
    )
    .join("");
}

/** What Home publishes on window for the in-app E2E (dev + autotest only):
 *  the native file picker cannot be driven, so a block hands paths straight
 *  to the same routing the picker's result and a drop take. */
interface HomeDev {
  open(paths: string[]): void;
  drop(paths: string[]): void;
}
type HomeDevWindow = { __tarotingHomeDev?: HomeDev; __tarotingAutotest?: boolean };

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
              <button class="btn btn--primary" id="btn-new" aria-haspopup="menu">${icon("plus")}New project</button>
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
          <div class="home__recover" id="home-recover" hidden></div>
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
  const newBtn = root.querySelector<HTMLButtonElement>("#btn-new")!;
  const recoverEl = root.querySelector<HTMLElement>("#home-recover")!;

  let recents: RecentItem[] = [];
  /** The last read of the recents list failed: the grid says so, with a way
   *  to try again, instead of "No projects yet". */
  let recentsError = false;
  /** Temporary projects a crash or a logoff left behind with edits in them
   *  (see loadOrphans), in the order their Recover lines show. */
  let orphans: string[] = [];
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

  /** A card with no picture: the kind's own glyph, so an image project never
   *  borrows the film strip. */
  function placeholderFor(item: RecentItem | undefined): string {
    return icon(item?.kind === "image" ? "image" : "film", 28);
  }

  function cardHtml(item: RecentItem): string {
    const thumb = item.thumb
      ? `<img src="${escapeHtml(mediaUrl(item.thumb))}" alt="" loading="lazy" />`
      : placeholderFor(item);
    const size = item.sizeBytes > 0 ? `<span>·</span><span>${formatBytes(item.sizeBytes)}</span>` : "";
    const selected = selectMode && selection.has(item.path);
    // An image has no running time, so its card never shows one: the duration
    // is printed only above zero, and an image project's recents entry carries 0.
    return `
      <div class="project-card${selected ? " is-selected" : ""}" data-path="${escapeHtml(item.path)}"${item.kind === "image" ? ' data-kind="image"' : ""} tabindex="0" role="button"${selected ? ' aria-pressed="true"' : ""}>
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
      const state = recentsError ? "error" : search.value.trim().length > 0 ? "searching" : "none";
      grid.innerHTML = emptyGridHtml(state);
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
     until the backend can produce one. One shot per thumb-less path per mount
     (no polling); on a hit, swap just that card's placeholder for an <img>
     without re-rendering the grid.

     ONE batch in flight at a time, through one queue and one pump. Every batch
     lands on the backend's single thumbnail lane anyway, so firing them all at
     once bought nothing but a line of waits, each counting toward its own
     timeout behind the ones ahead of it — a big cold library timed out its
     later batches. And the first pump waits (armBackgroundWork) until every
     open in progress has settled and the window is idle: a Home painted as the
     fallback while a launch file is still being opened must not compete with
     that file for the disk and the decoder. */
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

  /** Paths waiting for their batch, in card order. */
  const thumbQueue: string[] = [];
  /** A pump is running; another call only adds to its queue. */
  let thumbPumping = false;
  /** The first pump's wait is over (armBackgroundWork). Until then the queue
   *  only fills. */
  let backgroundArmed = false;

  function backfillThumbs(): void {
    for (const item of recents) {
      // An image project's card picture is RENDERED by the image editor when
      // it is left, never derived from a source file, so there is nothing to
      // backfill. Skipped before the IPC, not just in Rust: asking would read
      // and parse a possibly multi-megabyte .trt for every picture-less image
      // card on every Home visit, only to be told no.
      if (item.kind === "image") continue;
      if (item.thumb || thumbTried.has(item.path)) continue;
      thumbTried.add(item.path);
      thumbQueue.push(item.path);
    }
    void pumpThumbs();
  }

  async function pumpThumbs(): Promise<void> {
    if (!backgroundArmed || thumbPumping) return;
    thumbPumping = true;
    try {
      while (!disposed && thumbQueue.length > 0) {
        // A project deleted or removed from the list while it waited is not
        // worth an ffmpeg run.
        const batch = thumbQueue.splice(0, THUMB_BATCH).filter((p) => recentByPath(p) !== undefined);
        if (batch.length === 0) continue;
        try {
          const found = await ipc.refreshRecentThumbs(batch);
          if (disposed) return;
          // Only projects that resolved come back; a missing key is the batch
          // equivalent of the single-path `null`.
          for (const [path, thumb] of Object.entries(found)) {
            if (thumb) paintThumb(path, thumb);
          }
        } catch {
          // Best-effort: the backend already fails soft. A fresh mount clears
          // thumbTried, so the next home visit retries.
        }
      }
    } finally {
      thumbPumping = false;
    }
  }

  /* A card picture whose file is gone. "Clear cache" empties the thumbs folder
     but cannot reach the recents list, so every entry keeps naming a file that
     no longer exists, and the card showed the webview's broken-image glyph for
     good. `error` does not bubble, so this listens in the capture phase on the
     grid (never an inline onerror: the CSP refuses it).

     The dead name is dropped from the model, so a later re-render (search,
     sort, rename) paints the placeholder instead of the broken <img> again,
     and a video card then goes through the ordinary backfill, which makes the
     picture again from the project's first clip. That backfill is one shot per
     card per mount (`thumbTried`), so a picture that still cannot be shown
     settles on the placeholder rather than looping. An image card just keeps
     its placeholder until the image editor renders a new picture — never the
     raw photo, which would show none of the edits. Errors from one render are
     gathered for a moment so a cleared cache costs the same batched calls as a
     mount's own backfill, not one call per card. */
  let thumbRetry: number | undefined;
  function onThumbError(e: Event): void {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const thumbEl = img.closest<HTMLElement>(".project-card__thumb");
    const card = img.closest<HTMLElement>(".project-card");
    if (!thumbEl || !card) return;
    const model = recentByPath(card.dataset.path ?? "");
    if (model) model.thumb = null;
    thumbEl.innerHTML = placeholderFor(model);
    if (!model || model.kind === "image" || thumbTried.has(model.path)) return;
    window.clearTimeout(thumbRetry);
    thumbRetry = window.setTimeout(() => {
      thumbRetry = undefined;
      if (!disposed) backfillThumbs();
    }, 100);
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
      // A store that could read neither recents.json nor its backup may say so
      // in the answer rather than reject; with nothing to show, that is the
      // same "couldn't read", not "no projects".
      recentsError = (index as { unreadable?: unknown }).unreadable === true && recents.length === 0;
    } catch (e) {
      toast.error(`Couldn't read recent projects: ${describeError(e)}`);
      recents = [];
      recentsError = true;
    }
    // The read is async: a screen left meanwhile has no grid to paint.
    if (disposed) return;
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
      } else if (modalEnterConfirms(e, input)) {
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

  /* "New project" asks which kind in a menu under the button: a video project
     is made on the spot, an image project through the "New image project"
     dialog. `fromKeyboard`: opened with Enter/Space, so the menu starts on
     its first row and the next Enter chooses it. */
  function openNewMenu(fromKeyboard = false): void {
    const r = newBtn.getBoundingClientRect();
    showMenu(
      r.left,
      r.bottom + 4,
      [
        {
          label: "Video project",
          icon: icon("film", 18),
          hint: "Clips, photos and music on a timeline",
          onSelect: () => void createNew([]),
        },
        {
          label: "Image project",
          icon: icon("image", 18),
          hint: "Draw on, adjust and export a picture",
          onSelect: () => void openNewImage(),
        },
      ],
      r.top - 4,
      fromKeyboard,
    );
  }

  /* "New image project": a dialog rather than one click, because a blank image
     needs a size and a background before it is anything. The dialog is its
     own small chunk, fetched on this choice and never at boot; the image
     editor it leads to is another, fetched only when the project opens. `busy`
     covers only the fetch: the dialog runs its own guard, and Home must not
     sit frozen behind a dialog the user may simply cancel. */
  async function openNewImage(): Promise<void> {
    if (guard()) return;
    try {
      const { openNewImageDialog } = await import("./new-image-dialog");
      if (disposed) return;
      // The dialog lives on document.body; teardown closes it (see
      // openOverlays). Every way it closes — Create, Cancel, Escape, the
      // teardown itself — drops its entry through onClosed, so a cancelled
      // dialog's detached DOM is not held until Home unmounts.
      let close: () => void = () => {};
      close = openNewImageDialog({
        onCreated: (projectPath) => {
          if (!disposed) navigate({ view: "editor", projectPath });
        },
        onClosed: () => openOverlays.delete(close),
        isDisposed: () => disposed,
      });
      openOverlays.add(close);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      busy = false;
    }
  }

  /** `openedInfo`: an information toast shown only once the project really
   *  opens (openRouteInfo), so a missing file never reads "Opened". */
  async function openPath(path: string, openedInfo: string | null = null): Promise<void> {
    if (guard()) return;
    try {
      const ext = fileExt(path);
      if (ext !== "trt") {
        // Only projects come here. Media chosen with Open or dropped on Home
        // never goes to the viewer, whatever "Open files from File Explorer
        // in" says (that setting is about Explorer): opening files from Home
        // is starting a project with them, so they go to the "Open as" dialog
        // (routeOpenPicks / routeDrop) and the user says which kind.
        toast.refuse("Unsupported file type.");
        return;
      }
      if (!(await ipc.pathExists(path))) {
        toast.error("Project file not found");
        await refresh();
        return;
      }
      // A .trt inside tmp-projects is a temporary project (a drop, or the
      // picker pointed at the scratch folder): it opens as temp, so it gets the
      // Temporary badge and the keep gate instead of being edited in place
      // outside the library — the same classification an Explorer open applies.
      const temp = await isTempProjectPath(path);
      // Both checks are disk round-trips; see createNew for why a disposed
      // screen must not navigate once they resolve.
      if (disposed) return;
      navigate(temp ? { view: "editor", projectPath: path, temp: true } : { view: "editor", projectPath: path });
      if (openedInfo) toast.info(openedInfo);
    } finally {
      busy = false;
    }
  }

  /* ---------------- recovering orphaned temporary projects ---------------- */

  /* A temporary project's keep-or-discard question is asked when it is left —
     Back, the window close, another open. A crash, a Windows logoff or a forced
     close never asks it, and the startup sweep then keeps the edited ones
     (untouched ones it deletes; Home never sees those). Each kept one gets a
     calm line here that reopens it as what it is, a TEMPORARY project, so the
     ordinary question settles it: Keep files it in the library, Discard
     removes it. It is never added to recents here, and nothing about it is
     decided on the user's behalf. Listed once per mount, after the first paint
     and any open in progress (armBackgroundWork): the folder is normally
     empty, and nothing on screen waits for the answer. */
  async function loadOrphans(): Promise<void> {
    let paths: string[];
    try {
      paths = await ipc.listOrphanTempProjects();
    } catch {
      // Best-effort: the files stay where they are, and the next Home visit
      // asks again.
      return;
    }
    if (disposed) return;
    orphans = paths.filter((p) => typeof p === "string" && fileExt(p) === "trt");
    renderOrphans();
  }

  function renderOrphans(): void {
    const none = orphans.length === 0;
    if (recoverEl.hidden !== none) recoverEl.hidden = none;
    recoverEl.innerHTML = none ? "" : orphanRowsHtml(orphans);
  }

  async function recoverOrphan(path: string): Promise<void> {
    if (guard()) return;
    let gone = false;
    try {
      gone = !(await ipc.pathExists(path));
      if (disposed) return;
      if (gone) {
        toast.error("Temporary project not found");
        return;
      }
      // Always temporary, by route, not by asking where the file lives: the
      // keep gate is the whole point of this line.
      navigate({ view: "editor", projectPath: path, temp: true });
    } catch (e) {
      if (!disposed) toast.error(describeError(e));
    } finally {
      busy = false;
      // Whatever removed the file may have removed others: list again rather
      // than leave lines that lead nowhere.
      if (gone && !disposed) void loadOrphans();
    }
  }

  /* Media → the "Open as" dialog, its own small chunk fetched on use and never
     at boot. `busy` covers only the fetch, as for the New image project
     dialog: the choice then runs createNew or makeImageProject, each under
     its own guard, and the dialog stays up, busy, until that promise
     settles (or this screen's teardown closes it on the way out). */
  async function offerOpenAs(media: string[]): Promise<void> {
    if (guard()) return;
    try {
      const dialog = await import("./open-as-dialog");
      if (disposed) return;
      let close: () => void = () => {};
      close = dialog.openOpenAsDialog({
        paths: media,
        onVideo: () => createNew(media),
        onImage: () => makeImageProject(dialog.createImageProjectFrom, media),
        onClosed: () => openOverlays.delete(close),
      });
      openOverlays.add(close);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      busy = false;
    }
  }

  /** "Image project" from "Open as": a real library project, like createNew's. */
  async function makeImageProject(
    create: (paths: readonly string[], gone: () => boolean) => Promise<string | null>,
    media: string[],
  ): Promise<void> {
    if (guard()) return;
    try {
      const projectPath = await create(media, () => disposed);
      // See createNew for why a disposed screen must not navigate.
      if (projectPath && !disposed) navigate({ view: "editor", projectPath });
    } catch (e) {
      if (!disposed) toast.error(describeError(e));
    } finally {
      busy = false;
    }
  }

  function followRoute(route: OpenRoute): void {
    // A refusal, never recorded: nothing failed, the files were declined.
    const notice = openRouteNotice(route);
    if (notice) toast.refuse(notice);
    if (route.kind === "project") void openPath(route.path, openRouteInfo(route));
    else if (route.kind === "media") void offerOpenAs(route.media);
  }

  async function openViaDialog(): Promise<void> {
    // A project is being made (or opened): a pick now would be dropped by the
    // guard with no word, so do not open the picker at all.
    if (busy) return;
    const paths = await pickOpenFiles();
    // The picker was open for as long as the user took; see createNew for why
    // a disposed screen must not act once it resolves.
    if (disposed) return;
    followRoute(routeOpenPicks(paths));
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

  /** `fromKeyboard`: opened with Enter or Space on the More button, so the
   *  menu starts on its first row and the arrow keys and Enter work at once. */
  function openMore(path: string, x: number, y: number, fromKeyboard = false): void {
    const item = recentByPath(path);
    if (!item) return;
    const card = grid.querySelector<HTMLElement>(`.project-card[data-path="${CSS.escape(path)}"]`);
    showMenu(
      x,
      y,
      [
        { label: "Open", onSelect: () => void openPath(path) },
        { label: "Rename", onSelect: () => card && startRename(card, item) },
        { label: "Duplicate", onSelect: () => promptDuplicate(item) },
        { label: "Remove from list", onSelect: () => removeFromList(path) },
        { label: "Delete file", danger: true, onSelect: () => promptDelete(item) },
      ],
      undefined,
      fromKeyboard,
    );
  }

  function handleDroppedPaths(paths: string[]): void {
    // A second dialog over an open one would stack two focus traps, and one
    // Escape would close both. Say why the drop did nothing — and a busy
    // Open as dialog cannot be closed, so do not ask for that.
    if (busy && openOverlays.size > 0) {
      toast.info("A project is being made. Wait for it to open.");
      return;
    }
    if (openOverlays.size > 0 || document.querySelector(".modal-backdrop")) {
      toast.info("Close the open dialog first, then drop the files again.");
      return;
    }
    followRoute(routeDrop(paths));
  }

  /* ---------------- wiring ---------------- */

  // detail 0: activated from the keyboard (Enter/Space), not by a pointer.
  newBtn.addEventListener("click", (e) => openNewMenu(e.detail === 0));
  grid.addEventListener("error", onThumbError, true);
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
  //
  // Ctrl+F goes to the search field. Home no longer focuses it on mount (see
  // the end of this function), so this is the keyboard's way there besides
  // Tab. Not over a dialog or a menu, whose keys are their own, and not during
  // an inline rename, which the blur would commit.
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (!selectMode || deleting) return;
      if (document.querySelector(".modal-backdrop")) return;
      e.preventDefault();
      leaveSelectMode();
      return;
    }
    if (!isSearchChord(e) || renaming) return;
    if (document.querySelector(".modal-backdrop, .ctx-menu")) return;
    e.preventDefault();
    search.focus();
    search.select();
  };
  document.addEventListener("keydown", onDocKey, true);

  grid.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    // The unreadable-recents state's own button (no cards exist then).
    if (target.closest('[data-act="retry-recents"]')) {
      void refresh();
      return;
    }
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
      // detail 0: Enter or Space on the button, not a pointer.
      openMore(moreBtn.dataset.more!, rect.left, rect.bottom + 2, e.detail === 0);
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
    const action = gridEnterAction(target, selectMode);
    if (action === null) return;
    const card = target.closest<HTMLElement>(".project-card")!;
    if (action === "toggle") {
      // Enter toggles selection in select mode instead of opening. The
      // preventDefault also stops Enter on the (inert) More button from
      // turning into a click that would toggle the card a second time.
      e.preventDefault();
      toggleSelection(card.dataset.path!);
    } else {
      void openPath(card.dataset.path!);
    }
  });
  recoverEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-recover]");
    const path = btn ? orphans[Number(btn.dataset.recover)] : undefined;
    if (path !== undefined) void recoverOrphan(path);
  });
  grid.addEventListener("contextmenu", (e) => {
    // The per-card menu is inert during select mode.
    if (selectMode) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>(".project-card");
    if (!card) return;
    e.preventDefault();
    openMore(card.dataset.path!, e.clientX, e.clientY);
  });

  // A right-click on "New project" is the same question as a click. (It used
  // to open a media picker and make a VIDEO project of the pick unasked; Open
  // now picks media, and asks.)
  newBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openNewMenu();
  });

  const devWin = window as unknown as HomeDevWindow;
  const dev: HomeDev | null =
    import.meta.env.DEV && devWin.__tarotingAutotest === true
      ? {
          open: (paths) => followRoute(routeOpenPicks(paths)),
          drop: (paths) => handleDroppedPaths(paths),
        }
      : null;
  if (dev) devWin.__tarotingHomeDev = dev;

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

  /* The work that can wait: thumbnail backfill and the orphan listing. First
     every open already queued or running settles — a launch whose file is still
     opening painted this Home only as a fallback, and that open then navigates
     away, which disposes this screen before any of it starts — and then the
     window goes idle, so the first paint and the first input come first. The
     wait is a no-op task on the open chain, and nothing waits on IT, so it
     cannot hold anything up. An open parked on a question (keep or discard?)
     holds the thumbnails until it is answered, which is the right order. */
  function armBackgroundWork(): void {
    const start = (): void => {
      if (disposed) return;
      backgroundArmed = true;
      void pumpThumbs();
      void loadOrphans();
    };
    void runOnOpenChain(async () => {}).then(() => {
      if (disposed) return;
      if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 1000 });
      else window.setTimeout(start, 50);
    });
  }

  void refresh();
  armBackgroundWork();
  // The search field is NOT focused here. Home is the first screen of every
  // plain launch, so a focused field ate whatever the user typed first — a
  // keypress meant for another window while this one came up landed in it as
  // a stray letter and filtered the grid. Tab and Ctrl+F reach it.

  return {
    dispose() {
      disposed = true;
      window.clearTimeout(thumbRetry);
      unlistenDrop?.();
      unlistenDrop = null;
      document.removeEventListener("keydown", onDocKey, true);
      // The context menu and any open dialog live on document.body, outside the
      // subtree the router clears — and both hold callbacks (promptDelete,
      // startRename, the confirm handler) that reach back into this screen.
      // Closing them is teardown's job; nothing else will ever do it.
      closeMenu();
      closeOverlays();
      if (dev && devWin.__tarotingHomeDev === dev) delete devWin.__tarotingHomeDev;
    },
  };
}
