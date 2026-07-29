// App-wide session state: settings (theme, shortcuts, …) and the currently
// open project with autosave + undo/redo orchestration.

import { History } from "./history";
import { ipc } from "./ipc";
import { touchModified } from "./project";
import { Store } from "./store";
import type { ActionId, ProjectFile, Settings } from "./types";
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

/* ---------------- settings sanitation ---------------- */

// The backend stores settings opaquely (serde_json::Value), so NOTHING between
// a hand-edited or corrupted settings.json and the app is typed — this file is
// the only sanitizer. A blind spread over the defaults let real values through
// and crashed on first use:
//   shortcuts.<action> not a string → normalizeChord's stored.split("+") throws
//                                     (an unknown EXTRA key was enough)
//   defaultExportDir a number       → escapeHtml's s.replace throws
//   autosaveSeconds "soon"          → Math.max(1, NaN) = NaN, and
//                                     setInterval(fn, NaN) is a 4 ms timer for
//                                     the lifetime of the app (perf veto)
// Every field is therefore coerced to its declared type with a default
// fallback, the way clampVol (playback/audio-graph.ts) already guards
// monitorVolume.

/** Finite number in [lo, hi]. Numeric strings are accepted (a stringified
 *  number is a plausible hand-edit); anything else falls back. */
function asNum(v: unknown, fallback: number, lo: number, hi: number): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** A filesystem path or "not set". Anything non-string becomes null rather than
 *  reaching escapeHtml / the dialog plugin. */
function asPath(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Coerce an arbitrary persisted value into a valid Settings. Never throws. */
export function sanitizeSettings(raw: unknown): Settings {
  const o: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  // Rebuild the shortcut map from the defaults: only KNOWN actions bound to a
  // STRING survive, so neither an extra key nor a non-string binding can reach
  // normalizeChord.
  const rawShortcuts: Record<string, unknown> =
    o.shortcuts !== null && typeof o.shortcuts === "object"
      ? (o.shortcuts as Record<string, unknown>)
      : {};
  const shortcuts = { ...DEFAULT_SHORTCUTS };
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ActionId[]) {
    const chord = rawShortcuts[action];
    if (typeof chord === "string") shortcuts[action] = chord;
  }

  const theme = o.theme;
  return {
    schema: 1,
    theme:
      theme === "dark" || theme === "light" || theme === "system"
        ? theme
        : DEFAULT_SETTINGS.theme,
    // >= 1 s keeps setInterval off the 4 ms floor; the cap is a sanity bound.
    autosaveSeconds: asNum(o.autosaveSeconds, DEFAULT_SETTINGS.autosaveSeconds, 1, 3600),
    defaultExportDir: asPath(o.defaultExportDir),
    lastExportDir: asPath(o.lastExportDir),
    hardwareAccel: asBool(o.hardwareAccel, DEFAULT_SETTINGS.hardwareAccel),
    cacheLimitMB: asNum(o.cacheLimitMB, DEFAULT_SETTINGS.cacheLimitMB, 1, 1024 * 1024),
    proxyMedia: asBool(o.proxyMedia, DEFAULT_SETTINGS.proxyMedia),
    snapCenterGuides: asBool(o.snapCenterGuides, DEFAULT_SETTINGS.snapCenterGuides),
    tempOpenWith: asBool(o.tempOpenWith, DEFAULT_SETTINGS.tempOpenWith),
    monitorVolume: asNum(o.monitorVolume, DEFAULT_SETTINGS.monitorVolume, 0, 1),
    shortcuts,
  };
}

export async function initSettings(): Promise<void> {
  try {
    const loaded = await ipc.getSettings();
    if (loaded) settingsStore.set(sanitizeSettings(loaded));
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

/** A confirmation the owning view requires before this session is torn down by
 *  a navigation it did not initiate. Resolves true to proceed, false to cancel.
 *  Installed by the editor for a quick-view (temp) session — see
 *  `ProjectSession.leaveGuard`. */
export type LeaveGuard = () => Promise<boolean>;

const AUTOSAVE_DEBOUNCE_MS = 500;

/** The open project: a reactive store, an undo history, and an autosaver. */
export class ProjectSession {
  readonly store: Store<ProjectFile>;
  readonly saveState = new Store<SaveState>("saved");
  readonly history = new History<ProjectFile>();
  readonly path: string;

  /** Optional keep-or-discard gate, set by the view that owns this session and
   *  scoped to its lifetime (the session reference is dropped on dispose, so
   *  there is nothing to unregister). `null` means "nothing to confirm". */
  leaveGuard: LeaveGuard | null = null;

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

/** Ask the open session (if any) to confirm being replaced by a navigation it
 *  did not initiate — today that is only the OS open-path route in main.ts,
 *  which otherwise walks straight past the quick-view keep/discard prompt and
 *  lets a temporary project be flushed to a path that startup cleanup deletes.
 *  Resolves true when there is nothing to confirm. */
export async function confirmLeaveCurrentSession(): Promise<boolean> {
  const guard = currentSession.get()?.leaveGuard;
  return guard ? await guard() : true;
}
