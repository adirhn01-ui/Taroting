// Formatting helpers: timecode, durations, bytes, dates.

import type { Rational } from "./types";
import { frameOf } from "./time";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** h:mm:ss:ff timecode (hours omitted when zero). */
export function formatTimecode(t: number, fps: Rational): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const totalFrames = frameOf(t, fps);
  const fpsRound = Math.round(fps.num / fps.den);
  const ff = totalFrames % fpsRound;
  const totalSec = Math.floor(totalFrames / fpsRound);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return h > 0
    ? `${h}:${pad2(m)}:${pad2(s)}:${pad2(ff)}`
    : `${pad2(m)}:${pad2(s)}:${pad2(ff)}`;
}

/** Compact duration like 0:42, 3:07, 1:02:03. */
export function formatDuration(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const total = Math.round(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Last path segment ("C:\a\b.mp4" → "b.mp4"). */
export function fileName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** File name without its extension. */
export function fileStem(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** File extension, lowercased, without the dot. */
export function fileExt(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** "just now", "5m ago", "3h ago", "yesterday", else a short date. */
export function formatRelative(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: day > 300 ? "numeric" : undefined,
  });
}
