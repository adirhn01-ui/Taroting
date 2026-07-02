// Typed IPC surface. This is the ONLY file that talks to @tauri-apps APIs.
// In a plain browser (UI preview during development) read commands return
// inert fallbacks and mutations reject, so screens stay previewable.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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

export interface LoadedProject {
  project: ProjectFile;
  missing: string[];
  recovered: boolean;
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

export const ipc = {
  listRecents: () =>
    call<RecentsIndex>("list_recents", undefined, () => ({ schema: 1, items: [] })),
  removeRecent: (path: string) => call<void>("remove_recent", { path }),
  loadProject: (path: string) => call<LoadedProject>("load_project", { path }),
  saveProject: (path: string, project: ProjectFile) =>
    call<{ modifiedAt: string }>("save_project", { path, project }),
  probeMedia: (path: string) => call<MediaInfo>("probe_media", { path }),
  pathExists: (path: string) => call<boolean>("path_exists", { path }),
  newProjectPath: (name?: string) =>
    call<string>("new_project_path", { name: name ?? null }),
  getSettings: () => call<Settings | null>("get_settings", undefined, () => null),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  planPlayback: (media: MediaRef, hints: CodecHints, forceProxyLarge: boolean) =>
    call<PlaybackPlan>("plan_playback", { media, hints, forceProxyLarge }),
  ensureWaveform: (key: MediaKey, duration: number, hasAudio: boolean) =>
    call<WaveformResult>("ensure_waveform", { key, duration, hasAudio }),
  getThumbnail: (key: MediaKey, atSec: number) =>
    call<string>("get_thumbnail", { key, atSec }),
  ensureFilmstrip: (key: MediaKey, duration: number, intervalSec: number, heightPx: number) =>
    call<FilmstripResult>("ensure_filmstrip", { key, duration, intervalSec, heightPx }),
  cancelJob: (id: number) => call<boolean>("cancel_job", { id }),
  cacheStats: () =>
    call<{ totalBytes: number; byKind: Record<string, number> }>("cache_stats"),
  clearCache: (keepActive: MediaKey[]) => call<number>("clear_cache", { keepActive }),
  enforceCacheLimit: (capMb: number, keepActive: MediaKey[]) =>
    call<number>("enforce_cache_limit", { capMb, keepActive }),

  /* dev-only (hard error in release builds) */
  debugInfo: () =>
    call<{ autotest: boolean; fixturesDir: string; reportPath: string }>("debug_info"),
  debugWriteReport: (content: string) => call<void>("debug_write_report", { content }),
};

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
