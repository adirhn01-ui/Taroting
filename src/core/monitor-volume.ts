// The monitor (listening) volume shared by every surface that plays sound —
// the editor's transport and theater bars today, the viewer's bar next. The
// level is the user's preference, persisted in settings.json; it is NEVER baked
// into clips or exports.
//
// SIGNATURE STUB: the bodies below are placeholders until the pure helpers move
// here from editor/playback/audio-graph.ts and the controller from editor.ts.
// Nothing calls them yet; those two files still hold the live implementation.

/** Pure state for the monitor-volume control. `level` is the live 0..1 value;
 *  `lastNonZero` is what a mute toggle restores to (seeded to 1 so an un-mute
 *  from a fresh 0 still makes sound). Holds no DOM/audio references. */
export interface MonitorVolumeState {
  level: number;
  lastNonZero: number;
}

/** Seed the state machine from a persisted level (clamped). */
export function makeMonitorVolume(_initial: number): MonitorVolumeState {
  throw new Error("not implemented");
}

/** User dragged the slider to `v`. Clamps; a non-zero value becomes the new
 *  restore point. Returns the next state (does not mutate the input). */
export function setMonitorLevel(_s: MonitorVolumeState, _v: number): MonitorVolumeState {
  throw new Error("not implemented");
}

/** Speaker click: mute if audible, else restore the last non-zero level. */
export function toggleMonitorMute(_s: MonitorVolumeState): MonitorVolumeState {
  throw new Error("not implemented");
}

export interface MonitorVolumeController {
  get(): MonitorVolumeState;
  setLevel(v: number): void;
  toggleMute(): void;
  subscribe(fn: (s: MonitorVolumeState) => void): () => void;
  /** Write a pending debounced level now. Idempotent. */
  flush(): void;
  /** flush() + drop subscribers. */
  dispose(): void;
}

/** Seeds from settingsStore.get().monitorVolume; calls apply(level) now and on every change;
 *  debounces updateSettings({monitorVolume}) by 300 ms. core must not import ui/toast, so the
 *  caller supplies the failure reporter. */
export function createMonitorVolume(
  _apply: (level: number) => void,
  _onSaveError: (e: unknown) => void,
): MonitorVolumeController {
  throw new Error("not implemented");
}
