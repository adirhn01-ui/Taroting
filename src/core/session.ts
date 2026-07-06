// App-wide session state: settings (theme, shortcuts, …) and the currently
// open project with autosave + undo/redo orchestration.

import { History } from "./history";
import { ipc } from "./ipc";
import { touchModified } from "./project";
import { Store } from "./store";
import type { ProjectFile, Settings } from "./types";
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "./types";

/* ---------------- settings ---------------- */

export const settingsStore = new Store<Settings>(DEFAULT_SETTINGS);

export function applyTheme(theme: Settings["theme"]): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.dataset.theme = resolved;
}

export async function initSettings(): Promise<void> {
  try {
    const loaded = await ipc.getSettings();
    if (loaded) {
      settingsStore.set({
        ...DEFAULT_SETTINGS,
        ...loaded,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...loaded.shortcuts },
      });
    }
  } catch {
    // defaults are fine; settings UI reports persistence problems later
  }
  applyTheme(settingsStore.get().theme);
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => applyTheme(settingsStore.get().theme));
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...settingsStore.get(), ...patch };
  settingsStore.set(next);
  if (patch.theme) applyTheme(patch.theme);
  await ipc.saveSettings(next);
}

/* ---------------- project session ---------------- */

export type SaveState = "saved" | "dirty" | "saving" | "error";

const AUTOSAVE_DEBOUNCE_MS = 500;

/** The open project: a reactive store, an undo history, and an autosaver. */
export class ProjectSession {
  readonly store: Store<ProjectFile>;
  readonly saveState = new Store<SaveState>("saved");
  readonly history = new History<ProjectFile>();
  readonly path: string;

  private debounceTimer: number | undefined;
  private intervalTimer: number | undefined;
  private saving = false;
  private pendingSave = false;
  private disposed = false;

  constructor(path: string, initial: ProjectFile) {
    this.path = path;
    this.store = new Store(initial);
    const seconds = Math.max(1, settingsStore.get().autosaveSeconds);
    this.intervalTimer = window.setInterval(() => {
      if (this.saveState.get() === "dirty") void this.save();
    }, seconds * 1000);
  }

  get project(): ProjectFile {
    return this.store.get();
  }

  /** Apply a committed mutation: one undo step + autosave scheduling.
   *  Mutators must be pure; returning the same reference means "no change". */
  commit(mutate: (p: ProjectFile) => ProjectFile): void {
    const before = this.store.get();
    const after = mutate(before);
    if (after === before) return;
    this.history.push(before);
    this.store.set(after);
    this.markDirty();
  }

  /** Commit a history step for changes already applied via replace().
   *  Used by slider drags: live edits go through replace() (no history),
   *  then one history entry is pushed on release. `before` is the snapshot
   *  captured when the drag began. No-op if nothing actually changed. */
  commitFrom(before: ProjectFile): void {
    if (this.store.get() === before) return;
    this.history.push(before);
    this.markDirty();
  }

  /** Replace state without a history entry (e.g. media relink fixups). */
  replace(next: ProjectFile): void {
    if (next === this.store.get()) return;
    this.store.set(next);
    this.markDirty();
  }

  undo(): void {
    const prev = this.history.undo(this.store.get());
    if (prev) {
      this.store.set(prev);
      this.markDirty();
    }
  }

  redo(): void {
    const next = this.history.redo(this.store.get());
    if (next) {
      this.store.set(next);
      this.markDirty();
    }
  }

  private markDirty(): void {
    this.saveState.set("dirty");
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DEBOUNCE_MS);
  }

  /** Serialize + write. Coalesces concurrent calls. */
  async save(): Promise<void> {
    if (this.disposed) return;
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    this.saving = true;
    this.saveState.set("saving");
    try {
      const stamped = touchModified(this.store.get());
      this.store.set(stamped);
      await ipc.saveProject(this.path, stamped);
      if (this.saveState.get() === "saving") this.saveState.set("saved");
    } catch {
      this.saveState.set("error");
    } finally {
      this.saving = false;
      if (this.pendingSave) {
        this.pendingSave = false;
        void this.save();
      }
    }
  }

  /** Flush and stop timers (called when leaving the editor). */
  async dispose(): Promise<void> {
    window.clearTimeout(this.debounceTimer);
    window.clearInterval(this.intervalTimer);
    if (!this.disposed && this.saveState.get() !== "saved") {
      await this.save();
    }
    this.disposed = true;
  }

  /** Abandon this session WITHOUT flushing: cancel timers and mark disposed so
   *  any in-flight or scheduled autosave becomes a no-op. Used by the quick-view
   *  "Discard" gesture, where the temp file is deleted right after — a dispose
   *  flush (which targets that temp path) would otherwise resurrect it. Setting
   *  `disposed` makes save() short-circuit, so the later dispose() also skips
   *  its flush. Idempotent. */
  discard(): void {
    window.clearTimeout(this.debounceTimer);
    window.clearInterval(this.intervalTimer);
    this.disposed = true;
  }
}

/** The currently open session (null on the home screen). */
export const currentSession = new Store<ProjectSession | null>(null);
