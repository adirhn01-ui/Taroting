// Typed IPC surface. This is the ONLY file that talks to @tauri-apps APIs.
// In a plain browser (UI preview during development) read commands return
// inert fallbacks and mutations reject, so screens stay previewable.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { MediaInfo, ProjectFile, RecentsIndex, Settings } from "./types";

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
};

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
