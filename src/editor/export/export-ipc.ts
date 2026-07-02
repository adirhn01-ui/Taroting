// Typed wrappers for the export backend commands plus the platform helpers
// the export dialog needs (Save As dialog, reveal-in-Explorer, taskbar progress).
//
// This module talks to @tauri-apps APIs directly — an intentional exception to
// the "only ipc.ts imports @tauri-apps/api/core" rule, so the export feature can
// be built in parallel without editing shared files. Everything degrades to a
// no-op / rejection outside the desktop app so the dialog stays previewable.

import { invoke } from "@tauri-apps/api/core";
import type { ExportPreset, MediaRef, Timeline } from "../../core/types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ---------------- command contracts ---------------- */

/** ffmpeg encoder names per family. "*_nvenc"/"*_qsv"/"*_amf" ⇒ hardware
 *  available; "libx264"/"libx265"/"libsvtav1" (or similar) ⇒ software only. */
export interface EncoderReport {
  h264: string;
  hevc: string;
  av1: string;
  detail: string[];
}

export interface ExportEstimate {
  bytes: number;
  exact: boolean;
}

/** The payload passed to estimate_export / start_export. */
export interface ExportSpec {
  media: MediaRef[];
  timeline: Timeline;
  preset: ExportPreset;
  outPath: string;
}

/** Detect (or re-detect, when force) available ffmpeg encoders. */
export function detectEncoders(force: boolean): Promise<EncoderReport> {
  if (!inTauri) {
    return Promise.resolve({ h264: "libx264", hevc: "libx265", av1: "libsvtav1", detail: [] });
  }
  return invoke<EncoderReport>("detect_encoders", { force });
}

/** Estimate the output size for a spec. */
export function estimateExport(spec: ExportSpec): Promise<ExportEstimate> {
  if (!inTauri) return Promise.resolve({ bytes: 0, exact: false });
  return invoke<ExportEstimate>("estimate_export", { spec });
}

/** Kick off an export; resolves to the job id. */
export function startExport(spec: ExportSpec): Promise<number> {
  if (!inTauri) return Promise.reject(new Error("Export is only available in the desktop app"));
  return invoke<number>("start_export", { spec });
}

/** Does a file already exist at this path? (reuses the existing backend command) */
export function pathExists(path: string): Promise<boolean> {
  if (!inTauri) return Promise.resolve(false);
  return invoke<boolean>("path_exists", { path });
}

/** Cancel a running job (kills ffmpeg + removes the partial output). */
export function cancelJob(id: number): Promise<boolean> {
  if (!inTauri) return Promise.resolve(false);
  return invoke<boolean>("cancel_job", { id });
}

/* ---------------- platform helpers ---------------- */

/** Native Save As dialog. Returns the chosen absolute path, or null if canceled. */
export async function saveFileDialog(opts: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!inTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const result = await save({ defaultPath: opts.defaultPath, filters: opts.filters });
  return typeof result === "string" ? result : null;
}

/** Open the OS file manager with the exported file selected. */
export async function revealInExplorer(path: string): Promise<void> {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Set the Windows taskbar progress bar. `ratio` is 0..1. */
export async function setTaskbarProgress(ratio: number): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow, ProgressBarStatus } = await import("@tauri-apps/api/window");
  const clamped = Math.max(0, Math.min(1, ratio));
  await getCurrentWindow().setProgressBar({
    status: ProgressBarStatus.Normal,
    progress: Math.round(clamped * 100),
  });
}

/** Clear the taskbar progress bar. */
export async function clearTaskbarProgress(): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow, ProgressBarStatus } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setProgressBar({ status: ProgressBarStatus.None });
}
