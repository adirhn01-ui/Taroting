// Typed IPC surface. This is the ONLY file that talks to @tauri-apps APIs.
// In a plain browser (UI preview during development) read commands return
// inert fallbacks and mutations reject, so screens stay previewable.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EncoderSummary, FfmpegFailure } from "./diagnostics";
import { sanitizeProject } from "./project";
import type { MediaInfo, MediaRef, ProjectFile, RecentsIndex, Settings } from "./types";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
  fallback?: () => T,
): Promise<T> {
  if (!inTauri) {
    if (fallback) return fallback();
    throw new Error(`"${cmd}" is only available in the desktop app`);
  }
  return invoke<T>(cmd, args);
}

export interface IpcError {
  code: string;
  message: string;
}

export function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as IpcError).message);
  return String(e);
}

/** Like describeError, but keeps the AppError `code` the backend sent. The code
 *  is otherwise discarded at the IPC boundary and never reaches a human, which
 *  is exactly the identifier that makes a bug report actionable. */
export function errorDetail(e: unknown): { code: string; message: string } {
  if (e && typeof e === "object" && "message" in e) {
    const err = e as Partial<IpcError>;
    return {
      code: typeof err.code === "string" ? err.code : "",
      message: String(err.message),
    };
  }
  return { code: "", message: String(e) };
}

export interface LoadedProject {
  project: ProjectFile;
  missing: string[];
  recovered: boolean;
}

/* ---------------- reading settings.json ---------------- */

/**
 * How `get_settings` found settings.json — a mirror of `SettingsRead` /
 * `SettingsStatus` in `src-tauri/src/settings.rs`, field for field and string
 * for string. Deliberately NOT renamed into local vocabulary: these three
 * discriminants are the contract, and a type that spells them the way the wire
 * does is a rename either side cannot make quietly.
 *
 *     { "status": "ok",         "settings": { … }, "recovered": false }
 *     { "status": "absent",     "settings": null,  "recovered": false }
 *     { "status": "unreadable", "settings": null,  "recovered": false }
 *
 * The distinction that earns its keep is `absent` vs `unreadable`, and it is the
 * same one `JsonRead` draws on the Rust side. "There is nothing stored" is a
 * legitimate empty state a caller may freely write over; "something is stored
 * but we could not read it" is NOT, because writing defaults over it rotates the
 * last good copy into `.bak` and then hides it forever. Collapsing the two into
 * a single `null` is precisely why the settings-clobber guard in `session.ts`
 * never fired: `get_settings` RESOLVED with `null` instead of rejecting, so boot
 * reported a clean "defaults" run, no toast appeared, and the first
 * `updateSettings` of the session put `{ ...DEFAULTS, ...patch }` over a
 * perfectly intact file that had merely been locked by a scanner for a moment.
 *
 * `recovered` says the settings ARE intact but the file they came from was not:
 * the primary was corrupt and the `.bak` supplied them. Carried through so boot
 * can say so rather than let the user wonder.
 */
export type SettingsRead =
  | { status: "ok"; settings: unknown; recovered: boolean }
  | { status: "absent" }
  | { status: "unreadable" };

/**
 * The ONE place that knows the wire shape of `get_settings`.
 *
 * FAIL SAFE, NOT LENIENT. Anything this function does not positively recognise —
 * an unknown status, a missing or null `settings` under `"ok"`, a bare value, a
 * shape from a build that does not match this one — becomes `unreadable`, the
 * state that REFUSES to write. The tempting fallback is the opposite (treat an
 * unrecognised object as the settings themselves), and it is exactly how this
 * bug would come back: the real `unreadable` payload would be mistaken for
 * settings, `sanitizeSettings` would turn `{status, settings, recovered}` into
 * pure defaults, boot would report a successful read, and the guard would never
 * fire again — under a fix that looks correct. There is no legacy shape to be
 * lenient toward: the backend and this file ship together, so an answer we do
 * not understand means something is wrong, and the safe reading of "something is
 * wrong" is "do not overwrite the user's file".
 */
export function normalizeSettingsRead(raw: unknown): SettingsRead {
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // `settings` is non-null EXACTLY when the status is "ok" (the Rust type
    // guarantees it); an "ok" without one is a contradiction, not a read.
    if (o.status === "ok" && o.settings !== null && o.settings !== undefined) {
      return { status: "ok", settings: o.settings, recovered: o.recovered === true };
    }
    if (o.status === "absent") return { status: "absent" };
  }
  return { status: "unreadable" };
}

export interface MediaKey {
  path: string;
  size: number;
  mtimeMs: number;
}

export type PlaybackPlan =
  | { mode: "direct"; path: string }
  | { mode: "ready"; path: string }
  | { mode: "pending"; jobId: number; output: string };

export type WaveformResult =
  | { state: "ready"; path: string }
  | { state: "pending"; jobId: number; output: string }
  | { state: "none" };

export type FilmstripResult =
  | { state: "ready"; dir: string; frameCount: number }
  | { state: "pending"; jobId: number; dir: string };

export interface CodecHints {
  hevc: boolean;
  av1: boolean;
}

export interface JobProgress {
  id: number;
  kind: string;
  ratio: number | null;
  outTimeMs: number;
  fps: number;
  speed: number;
  etaSec: number | null;
}

export interface JobDone {
  id: number;
  kind: string;
  output: Record<string, unknown>;
}

export interface JobFailed {
  id: number;
  kind: string;
  canceled: boolean;
  message: string;
  logTail: string[];
}

/** Standalone (rather than an arrow inside `ipc`) so `ipc.getSettings` can be
 *  expressed in terms of it without the object literal referencing itself. */
async function readSettings(): Promise<SettingsRead> {
  // Outside the desktop app the fallback must be an EXPLICIT `absent`: a UI
  // preview has no settings.json and nothing to protect, and the fail-safe
  // default of `unreadable` would leave every previewed screen unable to save.
  const fallback = (): unknown => ({ status: "absent", settings: null, recovered: false });
  return normalizeSettingsRead(await call<unknown>("get_settings", undefined, fallback));
}

export const ipc = {
  listRecents: () =>
    call<RecentsIndex>("list_recents", undefined, () => ({ schema: 1, items: [] })),
  removeRecent: (path: string) => call<void>("remove_recent", { path }),
  /** The one point at which a `.trt` becomes app state, and therefore where its
   *  numbers are repaired — see `sanitizeProject`. `load_project` returns the
   *  RAW json (the typed Rust struct it deserializes on the way past is used
   *  only for the missing-media scan and the recents stamp), so a `speed: 0`
   *  file reached `ProjectSession` unexamined and gave the editor an infinite
   *  clip duration while the export path, which DOES read the typed struct,
   *  computed a different one. */
  loadProject: async (path: string): Promise<LoadedProject> => {
    const loaded = await call<LoadedProject>("load_project", { path });
    return { ...loaded, project: sanitizeProject(loaded.project) };
  },
  saveProject: (path: string, project: ProjectFile) =>
    call<{ modifiedAt: string }>("save_project", { path, project }),
  refreshRecentThumb: (path: string) =>
    call<string | null>("refresh_recent_thumb", { path }, () => null),
  /** Batched form: ONE recents read/write and ONE thumbs-dir scan for the whole
   *  set, instead of ~7 filesystem ops per card. Only projects that resolved
   *  appear in the result — a missing key is the batch equivalent of `null`. */
  refreshRecentThumbs: (paths: string[]) =>
    call<Record<string, string>>("refresh_recent_thumbs", { paths }, () => ({})),
  probeMedia: (path: string) => call<MediaInfo>("probe_media", { path }),
  pathExists: (path: string) => call<boolean>("path_exists", { path }),
  newProjectPath: (name?: string) =>
    call<string>("new_project_path", { name: name ?? null }),
  tempProjectPath: (name?: string) =>
    call<string>("temp_project_path", { name: name ?? null }),
  tempProjectsDir: () => call<string>("temp_projects_dir", undefined, () => ""),
  renameProject: (path: string, newName: string) =>
    call<string>("rename_project", { path, newName }),
  duplicateProject: (path: string, newName: string, newId: string) =>
    call<string>("duplicate_project", { path, newName, newId }),
  deleteProject: (path: string) => call<void>("delete_project", { path }),
  /** Read settings.json, keeping "there is nothing there" and "there is
   *  something there we could not read" apart. Anything that goes on to WRITE
   *  settings must use this rather than `getSettings` — see `SettingsRead`. */
  readSettings: readSettings,
  /** Lossy convenience over `readSettings`: the stored value, or `null` for
   *  BOTH empty states. Only safe for a caller that just wants to look — the
   *  in-app E2E harness reading settings.json back to prove a write landed. */
  getSettings: async (): Promise<Settings | null> => {
    const read = await readSettings();
    return read.status === "ok" ? (read.settings as Settings) : null;
  },
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  planPlayback: (media: MediaRef, hints: CodecHints, forceProxyLarge: boolean) =>
    call<PlaybackPlan>("plan_playback", { media, hints, forceProxyLarge }),
  ensureWaveform: (key: MediaKey, duration: number, hasAudio: boolean) =>
    call<WaveformResult>("ensure_waveform", { key, duration, hasAudio }),
  getThumbnail: (key: MediaKey, atSec: number) =>
    call<string>("get_thumbnail", { key, atSec }),
  normalizeScan: (path: string, srcIn: number, srcOut: number) =>
    call<{ maxVolumeDb: number; suggestedGainDb: number }>("normalize_scan", {
      path,
      srcIn,
      srcOut,
    }),
  ensureFilmstrip: (key: MediaKey, duration: number, intervalSec: number, heightPx: number) =>
    call<FilmstripResult>("ensure_filmstrip", { key, duration, intervalSec, heightPx }),
  cancelJob: (id: number) => call<boolean>("cancel_job", { id }),
  cacheStats: () =>
    call<{ totalBytes: number; byKind: Record<string, number> }>("cache_stats"),
  clearCache: (keepActive: MediaKey[]) => call<number>("clear_cache", { keepActive }),
  enforceCacheLimit: (capMb: number, keepActive: MediaKey[]) =>
    call<number>("enforce_cache_limit", { capMb, keepActive }),

  /* OS integration */
  // Atomically drain the server-side open-path queue. Each queued path is
  // returned to exactly one caller, so the startup drain and the "open-path"
  // wake-up handler can both call this without double-opening a file.
  takePendingOpenPaths: () =>
    call<string[]>("take_pending_open_paths", undefined, () => []),
  uninstallApp: () => call<void>("uninstall_app"),

  /* diagnostics — all three are on-demand only; nothing is buffered, probed
   * or written unless the user asked for a report. */
  /** Which encoder ffmpeg resolved per family (cached backend-side). The
   *  export dialog has its own richer wrapper; this one exists so Settings can
   *  answer "no hardware encoder detected" without pulling in the export
   *  module graph. */
  detectEncoders: () => call<EncoderSummary>("detect_encoders", { force: false }),
  /** Everything the backend remembers about the last failed ffmpeg run, or
   *  null when nothing has failed this session. */
  exportFailureReport: () =>
    call<FfmpegFailure | null>("export_failure_report", undefined, () => null),
  /** Write a diagnostic report next to the user's projects; returns the path. */
  saveDiagnosticReport: (content: string) =>
    call<string>("save_diagnostic_report", { content }),

  /* dev-only (hard error in release builds) */
  debugInfo: () =>
    call<{ autotest: boolean; fixturesDir: string; reportPath: string }>("debug_info"),
  debugWriteReport: (content: string) => call<void>("debug_write_report", { content }),
};

/* ---------------- app identity ---------------- */

let cachedVersion: string | null = null;

/** The packaged app version, for diagnostic reports. Resolved once, lazily —
 *  nothing on the startup path asks for it. */
export async function appVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  if (!inTauri) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    cachedVersion = await getVersion();
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/* ---------------- job events ---------------- */

export interface JobEventHandlers {
  onProgress?: (e: JobProgress) => void;
  onDone?: (e: JobDone) => void;
  onFailed?: (e: JobFailed) => void;
}

/** Subscribe to job lifecycle events. Returns an unlisten function. */
export async function onJobEvents(handlers: JobEventHandlers): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const subs = await Promise.all([
    handlers.onProgress
      ? listen<JobProgress>("job:progress", (e) => handlers.onProgress!(e.payload))
      : Promise.resolve(() => {}),
    handlers.onDone
      ? listen<JobDone>("job:done", (e) => handlers.onDone!(e.payload))
      : Promise.resolve(() => {}),
    handlers.onFailed
      ? listen<JobFailed>("job:failed", (e) => handlers.onFailed!(e.payload))
      : Promise.resolve(() => {}),
  ]);
  return () => {
    for (const un of subs) un();
  };
}

/* ---------------- OS open-path events ---------------- */

/** Subscribe to "open-path" wake-up events (a second launch forwarding a file
 *  path to the already-running instance). The event payload is ignored: the
 *  path lives in the server-side queue, and the callback fires so the caller can
 *  drain it via `ipc.takePendingOpenPaths`. Returns an unlisten function. */
export async function onOpenPath(cb: () => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("open-path", () => cb());
}

/** URL that the webview can load for a local media/cache file. */
export function mediaUrl(path: string): string {
  return inTauri ? convertFileSrc(path) : path;
}

/* ---------------- dialogs ---------------- */

export async function pickProjectFile(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: false,
    filters: [{ name: "Taroting project", extensions: ["trt"] }],
  });
  return typeof result === "string" ? result : null;
}

export async function pickMediaFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: true,
    filters: [
      {
        name: "Media",
        extensions: [
          "mp4", "mov", "mkv", "avi", "webm", "gif",
          "mp3", "wav", "flac", "aac", "m4a", "ogg",
          "png", "jpg", "jpeg",
        ],
      },
    ],
  });
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

/* ---------------- window drag & drop ---------------- */

export type DragDropHandler = {
  onHover?: (position: { x: number; y: number }) => void;
  onDrop: (paths: string[]) => void;
  onCancel?: () => void;
};

export async function onDragDrop(handler: DragDropHandler): Promise<() => void> {
  if (!inTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "enter" || payload.type === "over") {
      handler.onHover?.(payload.position);
    } else if (payload.type === "drop") {
      handler.onDrop(payload.paths);
    } else {
      handler.onCancel?.();
    }
  });
  return unlisten;
}
