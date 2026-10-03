// Typed IPC surface. This is the ONLY file that talks to @tauri-apps APIs.
// In a plain browser (UI preview during development) read commands return
// inert fallbacks and mutations reject, so screens stay previewable.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EncoderSummary, FfmpegFailure } from "./diagnostics";
import { sanitizeProject } from "./project";
import { MEDIA_EXTENSIONS, MEDIA_FILE_EXTENSIONS } from "./types";
import type {
  ImageExportFormat,
  MediaInfo,
  MediaRef,
  ProjectFile,
  RecentsIndex,
  Settings,
  StepFamily,
} from "./types";

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

export interface CodecHints {
  hevc: boolean;
  av1: boolean;
}

/** What this webview can decode natively, as the backend's playback planner
 *  needs to know it. Lives here (not in the editor's media manager) because the
 *  viewer asks the same question and must get the same answer. */
export function codecHints(): CodecHints {
  if (!inTauri || typeof MediaSource === "undefined") return { hevc: false, av1: true };
  return {
    hevc: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L123.B0"'),
    av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"'),
  };
}

/** A media file's neighbours in its folder — a mirror of `SiblingWindow` in
 *  src-tauri/src/media/siblings.rs. Bounded by `radius` on each side so a
 *  folder of thousands of photos never crosses the IPC boundary whole. */
export interface SiblingWindow {
  /** stepping order, nearest neighbour LAST, at most `radius` entries: the
   *  view order held for the folder (File Explorer's, when one was read), then
   *  natural name order for names that order does not rank */
  before: string[];
  /** the same order, nearest neighbour FIRST, at most `radius` entries */
  after: string[];
  /** 1-based position of `path` among the family's files; null when it is not listed
   *  (vanished, hidden, or renamed since it was opened) */
  index: number | null;
  /** number of files of the family in the folder (a vanished current file is not counted) */
  total: number;
  family: StepFamily;
}

/** How a file would play, decided WITHOUT starting any job — a mirror of
 *  `PlaybackClass` in src-tauri/src/media/playability.rs, derived there from the
 *  same decision `plan_playback` acts on so the two can never disagree.
 *  `containerOnly` = only the container is wrong (a quick remux); `remux` = the
 *  audio needs re-encoding too; `proxy` = the video must be transcoded. */
export type PlaybackClass = "direct" | "containerOnly" | "remux" | "proxy";
export interface PlaybackClassInfo {
  class: PlaybackClass;
  /** a remux/proxy of this exact file ({path,size,mtimeMs}) is already in the cache, so planning
   *  would return `ready` without starting a job. Always false for `direct`. */
  prepared: boolean;
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

/** Where an image-save stream lands — a mirror of `ImageSaveDest` in
 *  src-tauri/src/image_save.rs (`kind`-tagged, camelCase fields; a wire test
 *  there deserializes exactly these three shapes).
 *
 *  - `user`: an export the user named. `sources` = every non-generator media
 *    path of the IN-MEMORY project, so the backend can refuse to write over an
 *    original — including a layer added since the last save.
 *  - `projectThumb`: the Home card of an image project (rendered, never the raw
 *    photo). The backend derives the file name from `projectId`.
 *  - `pasted`: a pasted image, written where the user can see and relink it
 *    (Documents\Taroting\Pasted images). The backend picks the file name.
 *
 *  The destination travels ONLY in this JSON begin call, never in a header. */
export type ImageSaveDest =
  | { kind: "user"; path: string; sources: string[] }
  | { kind: "projectThumb"; projectPath: string; projectId: string }
  | { kind: "pasted"; projectName: string };

/** Something that went wrong badly enough to end the app or its page — a
 *  mirror of `CrashNote` in src-tauri/src/crash.rs (camelCase on the wire).
 *
 *  - `panic` / `fault`: the previous run ended (a Rust panic, or a native
 *    fault such as an access violation inside a DLL), read from the note it
 *    wrote as it died — shown once, then kept on disk as last-crash.seen.txt.
 *  - `engine`: the WebView2 engine itself stopped and Taroting restarted.
 *  - `page`: THIS run's page process stopped and was reloaded (in memory only).
 *
 *  `detail` is the whole note text. It can carry file paths (a panic message
 *  may name the file being opened), so it is only ever shown through the
 *  redacting detail pane (`toast.error` → Details), never copied raw. */
export interface CrashNote {
  kind: "panic" | "fault" | "engine" | "page";
  /** UTC "YYYY-MM-DDTHH:MM:SSZ" from the note, when it has one. */
  at: string | null;
  detail: string;
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
  /** Temporary projects the startup sweep kept: ones a crash, a logoff or a
   *  forced close left behind before their keep-or-discard question was ever
   *  asked. Absolute `.trt` paths in tmp-projects; [] when there are none (the
   *  normal case) and outside the desktop app. */
  listOrphanTempProjects: () =>
    call<string[]>("list_orphan_temp_projects", undefined, () => []),
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
  /** Pure: one decision + one cache stat, no job, no ffmpeg. */
  classifyPlayback: (media: MediaRef, hints: CodecHints, forceProxyLarge: boolean) =>
    call<PlaybackClassInfo>("classify_playback", { media, hints, forceProxyLarge },
      () => ({ class: "direct", prepared: false })),
  /** The folder neighbours of `path` in its own step family (see SiblingWindow),
   *  in the order the File Explorer window showing that folder lists them, or
   *  natural name order when none does. `fresh`: try to read that order from
   *  Explorer now (a file newly shown by navigation); when Explorer shows
   *  nothing for the folder, the order already held for it is kept. Not fresh
   *  (refills, settles): reuse the held order, so stepping never re-queries
   *  Explorer and the order cannot change mid-session when Explorer closes. */
  listSiblings: (path: string, radius: number, fresh: boolean) =>
    call<SiblingWindow>("list_siblings", { path, radius, fresh },
      () => ({ before: [], after: [], index: 1, total: 1, family: "visual" })),
  /** Drop the Explorer order held for the viewer's folder (the viewer is left
   *  for good, not for a project that returns to it). */
  forgetSiblingOrder: () => call<void>("forget_sibling_order", {}, () => undefined),
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
  /** Native screen colour pick (see src-tauri/src/screen_pick.rs). Resolves
   *  to lowercase "#rrggbb" on a click, `null` when the user cancelled. Rejects
   *  while a pick is already running, and on a platform with no native picker
   *  ("not available on this platform" — the picker matches that phrase to
   *  fall back to the web EyeDropper API). */
  screenPickColor: () => call<string | null>("screen_pick_color"),

  /* image saves: begin (JSON) → chunk (raw body) ×N → commit, or abort.
   * The backend writes `<target>.taroting-part` and renames it on commit, checking
   * extension, magic bytes and size; see src-tauri/src/image_save.rs. */
  /** Open a save. Resolves the token for the chunks and the path it will land at. */
  imageSaveBegin: (dest: ImageSaveDest, format: ImageExportFormat, totalBytes: number) =>
    call<{ token: number; path: string }>("image_save_begin", { dest, format, totalBytes }),
  /** RAW body (application/octet-stream → InvokeBody::Raw). Never pass a plain
   *  array: it would travel as JSON, one number per byte, and the backend
   *  refuses a JSON body. The token rides in a header because the body is the
   *  bytes themselves. */
  imageSaveChunk: (token: number, bytes: Uint8Array) =>
    inTauri
      ? invoke<void>("image_save_chunk", bytes, { headers: { "x-taroting-save": String(token) } })
      : Promise.reject(new Error("image_save_chunk is only available in the desktop app")),
  /** Verify and move the finished file into place; resolves its final path. */
  imageSaveCommit: (token: number) =>
    call<{ token: number; path: string }>("image_save_commit", { token }),
  /** Drop an open save and its partial file. Idempotent. */
  imageSaveAbort: (token: number) => call<void>("image_save_abort", { token }),

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
  /** The crash notes waiting to be shown: the previous run's (once — the
   *  backend marks it seen as it returns it) and any page reloads of this run.
   *  [] on a launch after a clean exit, and outside the desktop app. */
  takeCrashNotes: () => call<CrashNote[]>("take_crash_notes", undefined, () => []),

  /* dev-only (hard error in release builds) */
  debugInfo: () =>
    call<{ autotest: boolean; fixturesDir: string; reportPath: string }>("debug_info"),
  debugWriteReport: (content: string) => call<void>("debug_write_report", { content }),
  /** Queue `path` exactly as a second launch would and emit "open-path", so the
   *  E2E drives the real open routing with no second process and no window. */
  debugPushOpenPath: (path: string) => call<void>("debug_push_open_path", { path }),
  /** Autotest only: write a synthetic crash note through the panic hook's own
   *  writer (no real panic), for the round trip through `takeCrashNotes`. */
  debugWriteCrashNote: (kind: "panic" | "fault" | "engine", message: string) =>
    call<void>("debug_write_crash_note", { kind, message }),
  /** tells the Rust close escape hatch (os::CloseWatch) that the webview
   *  answered this close request, so a later X is not treated as a hang */
  closeAck: () => call<void>("close_ack", undefined, () => undefined),
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

/* ---------------- the app window ---------------- */

/** Set the OS window title (taskbar, alt-tab). No-op outside the desktop app.
 *  `core:window:allow-set-title` is granted in capabilities/main.json. */
export async function setWindowTitle(title: string): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}

/** The OS window title ("" outside the desktop app). `core:window:allow-title`
 *  comes with `core:window:default`. */
export async function getWindowTitle(): Promise<string> {
  if (!inTauri) return "";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().title();
}

/** Intercept the window's close requests (X, Alt+F4, taskbar). The inner
 *  handler ALWAYS preventDefaults and fires `handler` without awaiting it: the
 *  close flow decides, and destroys the window itself (`destroyWindow`). A
 *  webview that never answers is covered by the Rust escape hatch
 *  (os::CloseWatch), not here. Returns an unlisten function. */
export async function onCloseRequested(handler: () => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onCloseRequested((ev) => {
    ev.preventDefault();
    handler();
  });
}

/** Close the window for real (`core:window:allow-destroy` in capabilities). */
export async function destroyWindow(): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}

/** Open File Explorer with `path` selected (`opener:default` is granted). */
export async function revealInFolder(path: string): Promise<void> {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
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

/** Subscribe to the colour under the cursor while a native screen pick is
 *  running (`ipc.screenPickColor`). Throttled backend-side to ~60 Hz and only
 *  on change, so previewing on every event is cheap. Returns an unlisten
 *  function; the caller unsubscribes when the pick settles. */
export async function onScreenPickHover(cb: (hex: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ hex: string }>("screen-pick-hover", (e) => cb(e.payload.hex));
}

/** URL that the webview can load for a local media/cache file. */
export function mediaUrl(path: string): string {
  return inTauri ? convertFileSrc(path) : path;
}

/* ---------------- dialogs ---------------- */

/** Home's Open picker: one project, or any number of media files (which Home
 *  then asks to open as a video or an image project). One filter. */
export async function pickOpenFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: true,
    filters: [{ name: "Projects and media", extensions: ["trt", ...MEDIA_FILE_EXTENSIONS] }],
  });
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickMediaFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: true,
    // Derived from media-extensions.json, so the picker can never offer a
    // different set than drop and open-with accept. media-extensions.test.ts
    // fails if a quoted extension literal reappears in this function.
    filters: [{ name: "Media", extensions: [...MEDIA_FILE_EXTENSIONS] }],
  });
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

/** One still image (the image family of media-extensions.json): a new image
 *  project from a photo, or a photo layer. Derived from the one list like
 *  `pickMediaFiles`, so it can never offer a format drop or import refuses. */
export async function pickImageFile(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: [...MEDIA_EXTENSIONS.image] }],
  });
  return typeof result === "string" ? result : null;
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
