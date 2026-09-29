// The monitor (listening) volume shared by every surface that plays sound —
// the editor's transport and theater bars today, the viewer's bar next. The
// level is the user's preference, persisted in settings.json; it is NEVER baked
// into clips or exports.
//
// Two layers. The pure state machine (makeMonitorVolume / setMonitorLevel /
// toggleMonitorMute) holds no DOM or audio references, so it is unit-testable
// and every surface drives it identically. The controller (createMonitorVolume)
// owns the one live state per mounted screen: it applies each change to the
// caller's audio sink, fans it out to the UIs, and persists the settled level.

import { settingsStore, updateSettings } from "./session";

/** Pure state for the monitor-volume control. `level` is the live 0..1 value;
 *  `lastNonZero` is what a mute toggle restores to (seeded to 1 so an un-mute
 *  from a fresh 0 still makes sound). Holds no DOM/audio references. */
export interface MonitorVolumeState {
  level: number;
  lastNonZero: number;
}

/** Total sanitizer: coerce anything (numeric string, NaN, null, boolean, …)
 *  with Number(); a non-finite result falls back to the safe default 1 (a
 *  corrupted persisted level must never blank the editor), then clamp to 0..1.
 *  Exported so an audio sink can apply the same guard independently. */
export const clampMonitorLevel = (v: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
};

/** Seed the state machine from a persisted level (clamped). */
export function makeMonitorVolume(initial: number): MonitorVolumeState {
  const level = clampMonitorLevel(initial);
  return { level, lastNonZero: level > 0 ? level : 1 };
}

/** User dragged the slider to `v`. Clamps; a non-zero value becomes the new
 *  restore point. Returns the next state (does not mutate the input). */
export function setMonitorLevel(s: MonitorVolumeState, v: number): MonitorVolumeState {
  const level = clampMonitorLevel(v);
  return { level, lastNonZero: level > 0 ? level : s.lastNonZero };
}

/** Speaker click: mute if audible, else restore the last non-zero level. */
export function toggleMonitorMute(s: MonitorVolumeState): MonitorVolumeState {
  if (s.level > 0) return { level: 0, lastNonZero: s.level };
  return { level: s.lastNonZero, lastNonZero: s.lastNonZero };
}

export interface MonitorVolumeController {
  get(): MonitorVolumeState;
  setLevel(v: number): void;
  toggleMute(): void;
  subscribe(fn: (s: MonitorVolumeState) => void): () => void;
  /** Write a pending debounced level now. Idempotent. */
  flush(): void;
  /** flush() + drop subscribers; later setLevel/toggleMute are no-ops. */
  dispose(): void;
}

/** How long the level must sit still before it is written to settings.json. */
const SAVE_DEBOUNCE_MS = 300;

/** Seeds from settingsStore.get().monitorVolume; calls apply(level) now and on every change;
 *  debounces updateSettings({monitorVolume}) by 300 ms. core must not import ui/toast, so the
 *  caller supplies the failure reporter. */
export function createMonitorVolume(
  apply: (level: number) => void,
  onSaveError: (e: unknown) => void,
): MonitorVolumeController {
  let state = makeMonitorVolume(settingsStore.get().monitorVolume);
  apply(state.level);
  const subs = new Set<(s: MonitorVolumeState) => void>();

  // Persisting to disk on every drag frame would be dozens of writes/sec; the
  // apply is immediate (smooth audio) but the settings write is debounced so
  // only the settled level lands on disk. `pending` is what makes flush()
  // idempotent: a second flush with nothing new owed writes nothing.
  let saveTimer: number | undefined;
  let pending = false;
  const flush = (): void => {
    window.clearTimeout(saveTimer);
    if (!pending) return;
    pending = false;
    // SAY SO if the write fails. The slider already shows the new level (the
    // sink is updated before the IPC is even issued), so a bare `void` here
    // left a rejected write looking exactly like a successful one — silent
    // until the next launch reverted it. Same shape as settings.ts persist().
    void updateSettings({ monitorVolume: state.level }).catch(onSaveError);
  };

  // After dispose() the sink belongs to a torn-down screen and the final level
  // is already written: a late change (a queued input event, a stray
  // subscriber) must not touch the dead sink or re-arm a write that lands
  // after the NEXT screen's own controller has saved its level.
  let disposed = false;
  const change = (next: MonitorVolumeState): void => {
    if (disposed) return;
    state = next;
    apply(next.level);
    pending = true;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    for (const fn of subs) fn(next);
  };

  return {
    get: () => state,
    setLevel: (v) => change(setMonitorLevel(state, v)),
    toggleMute: () => change(toggleMonitorMute(state)),
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    flush,
    dispose() {
      flush();
      disposed = true;
      subs.clear();
    },
  };
}
