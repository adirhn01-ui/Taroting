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

/** The payload passed to start_export. */
export interface ExportSpec {
  media: MediaRef[];
  timeline: Timeline;
  preset: ExportPreset;
  outPath: string;
}

/**
 * The payload passed to estimate_export: everything the size estimate reads,
 * and nothing else.
 *
 * This used to be a whole ExportSpec — the entire media list plus every clip on
 * every track — for a backend command that touches four scalars and the preset.
 * The dialog re-estimates on a 300 ms debounce after every control change, and
 * the serialization is on the UI thread. Measured payload / JSON.stringify:
 *
 *      60 clips    29.5 KB   0.049 ms   →   213 B   0.0003 ms
 *     240 clips   117.2 KB   0.190 ms   →   213 B   0.0003 ms
 *    1600 clips   783.3 KB   1.497 ms   →   213 B   0.0003 ms
 *
 * The payload is now constant, so the backend's parse of it is constant too.
 *
 * `durationSec` and `fps` are derived by exactly the arithmetic the backend
 * used to do itself (timelineDuration = latest clip end across tracks; fps =
 * num / max(1, den)), so the estimate is byte-identical either way. A Rust test
 * runs both entry points over the same project and asserts they agree.
 */
export interface EstimateInput {
  durationSec: number;
  /** Project canvas size — the resolution preset scales against it. */
  width: number;
  height: number;
  /** Timeline frame rate as a plain number. */
  fps: number;
  preset: ExportPreset;
}

/** Detect (or re-detect, when force) available ffmpeg encoders. */
export function detectEncoders(force: boolean): Promise<EncoderReport> {
  if (!inTauri) {
    return Promise.resolve({ h264: "libx264", hevc: "libx265", av1: "libsvtav1", detail: [] });
  }
  return invoke<EncoderReport>("detect_encoders", { force });
}

/** Estimate the output size. */
export function estimateExport(input: EstimateInput): Promise<ExportEstimate> {
  if (!inTauri) return Promise.resolve({ bytes: 0, exact: false });
  return invoke<ExportEstimate>("estimate_export", { input });
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
