// Media readiness manager: asks the backend how each media file will be
// previewed (direct / cached remux / background proxy), tracks preparation
// jobs, loads waveform peaks and thumbnails, and exposes reactive maps the
// editor UI renders from.

import type { CodecHints, MediaKey } from "../../core/ipc";
import { describeError, inTauri, ipc, mediaUrl, onJobEvents } from "../../core/ipc";
import { settingsStore } from "../../core/session";
import { Store } from "../../core/store";
import type { MediaRef, ProjectFile } from "../../core/types";
import { recordError } from "../../ui/errors";

export type MediaState =
  | { state: "checking" }
  | { state: "ready"; url: string; sourcePath: string }
  | { state: "preparing"; ratio: number | null; jobId: number }
  | { state: "failed"; message: string };

export interface WaveformData {
  pairsPerSec: number;
  mins: Int8Array;
  maxs: Int8Array;
}

export function keyOf(m: MediaRef): MediaKey {
  return { path: m.path, size: m.size, mtimeMs: m.mtimeMs };
}

export function codecHints(): CodecHints {
  if (!inTauri || typeof MediaSource === "undefined") return { hevc: false, av1: true };
  return {
    hevc: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L123.B0"'),
    av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"'),
  };
}

function parsePk(buf: ArrayBuffer): WaveformData | null {
  const view = new DataView(buf);
  if (buf.byteLength < 12) return null;
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "TPK1") return null;
  const pairsPerSec = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const mins = new Int8Array(count);
  const maxs = new Int8Array(count);
  const data = new Int8Array(buf, 12);
  for (let i = 0; i < count && i * 2 + 1 < data.length; i++) {
    mins[i] = data[i * 2]!;
    maxs[i] = data[i * 2 + 1]!;
  }
  return { pairsPerSec, mins, maxs };
}

type JobTarget =
  | { type: "playback"; mediaId: string; output: string }
  | { type: "waveform"; mediaId: string; output: string };

/**
 * How long a cache-enforcement request waits for company.
 *
 * Enforcement is a whole-cache walk on the backend: read_dir over five kind
 * directories plus a metadata() syscall per file, all of it BEFORE the
 * `total <= cap` early-out — so it is the same overhead whether or not anything
 * gets evicted. Measured: 1.34 ms at 50 files, 12.3 ms at 500, 48.2 ms at 2000.
 *
 * It used to run once per finished job. Opening a project with 20 media means
 * ~40 completions (a playback plan and a waveform each) landing within a second
 * or two of each other, i.e. ~40 full walks — 50 ms to 2 s of disk work on the
 * project-open path, all of it redundant because the 40th walk sees what the
 * 39th did. One second collapses any such burst into a single walk while still
 * trimming promptly after the last job of the batch settles.
 */
const CACHE_ENFORCE_COALESCE_MS = 1000;

export class MediaManager {
  /** mediaId → preview readiness */
  readonly status = new Store<Record<string, MediaState>>({});
  /** mediaId → decoded waveform peaks */
  readonly waveforms = new Store<Record<string, WaveformData>>({});
  /** mediaId → thumbnail file path */
  readonly thumbs = new Store<Record<string, string>>({});

  private jobs = new Map<number, JobTarget>();
  private tracked = new Set<string>();
  private unlisten: (() => void) | null = null;
  private disposed = false;
  /** Pending coalesced cache enforcement (see CACHE_ENFORCE_COALESCE_MS). */
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private getProject: () => ProjectFile) {}

  async init(): Promise<void> {
    const unlisten = await onJobEvents({
      onProgress: (e) => {
        const target = this.jobs.get(e.id);
        if (!target || target.type !== "playback") return;
        this.patchStatus(target.mediaId, {
          state: "preparing",
          ratio: e.ratio,
          jobId: e.id,
        });
      },
      onDone: (e) => {
        const target = this.jobs.get(e.id);
        if (!target) return;
        this.jobs.delete(e.id);
        if (target.type === "playback") {
          const path = String(e.output.path ?? target.output);
          this.patchStatus(target.mediaId, {
            state: "ready",
            url: mediaUrl(path),
            sourcePath: path,
          });
        } else {
          void this.loadWaveform(target.mediaId, String(e.output.path ?? target.output));
        }
        this.enforceCache();
      },
      onFailed: (e) => {
        const target = this.jobs.get(e.id);
        if (!target) return;
        this.jobs.delete(e.id);
        if (target.type === "playback" && !e.canceled) {
          this.patchStatus(target.mediaId, { state: "failed", message: e.message });
        }
      },
    });
    // Registration is async, so dispose() can land BEFORE the listener exists.
    // It had nothing to call, so hand the unlisten back here — otherwise the
    // listener leaks for the rest of the process and keeps feeding job events
    // into a disposed manager.
    if (this.disposed) unlisten();
    else this.unlisten = unlisten;
  }

  /** Track every media item in the project (idempotent). */
  ensureAll(project: ProjectFile): void {
    for (const media of project.media) void this.ensure(media);
  }

  /** Forget a media item's tracking and re-ensure it against the current
   *  project (e.g. after a relink changed its path/size/mtime → new cache
   *  keys). Safe no-op if the media no longer exists. */
  retrack(mediaId: string): void {
    this.tracked.delete(mediaId);
    const m = this.getProject().media.find((x) => x.id === mediaId);
    if (m) void this.ensure(m);
  }

  async ensure(media: MediaRef): Promise<void> {
    if (this.disposed || this.tracked.has(media.id)) return;
    this.tracked.add(media.id);

    // Generated media (solid / text) has no file on disk: no probe, no
    // playback plan, no thumbnail, no waveform. The preview renders it
    // directly from the generator; report it ready with an empty url.
    if (media.generator) {
      this.patchStatus(media.id, { state: "ready", url: "", sourcePath: "" });
      return;
    }

    this.patchStatus(media.id, { state: "checking" });

    // Thumbnail (visual media) — runs on its own lane, fire and forget.
    if (media.kind !== "audio") {
      const at = Math.min(0.5, Math.max(0, media.duration / 2));
      void ipc
        .getThumbnail(keyOf(media), at)
        .then((path) => {
          if (this.disposed) return;
          this.thumbs.update((t) => ({ ...t, [media.id]: path }));
        })
        .catch((e: unknown) =>
          this.noteSoftFailure(
            "Thumbnail",
            `Couldn't create a thumbnail for ${media.path}`,
            describeError(e),
          ),
        );
    }

    // Waveform peaks
    if (media.hasAudio) {
      void ipc
        .ensureWaveform(keyOf(media), media.duration, true)
        .then((wf) => {
          if (this.disposed) return;
          if (wf.state === "ready") void this.loadWaveform(media.id, wf.path);
          else if (wf.state === "pending") {
            this.jobs.set(wf.jobId, { type: "waveform", mediaId: media.id, output: wf.output });
          }
        })
        .catch((e: unknown) =>
          this.noteSoftFailure(
            "Waveform",
            `Couldn't build the audio waveform for ${media.path}`,
            describeError(e),
          ),
        );
    }

    // Playback plan
    try {
      const plan = await ipc.planPlayback(media, codecHints(), settingsStore.get().proxyMedia);
      if (this.disposed) return;
      if (plan.mode === "direct" || plan.mode === "ready") {
        this.patchStatus(media.id, {
          state: "ready",
          url: mediaUrl(plan.path),
          sourcePath: plan.path,
        });
      } else {
        this.jobs.set(plan.jobId, { type: "playback", mediaId: media.id, output: plan.output });
        this.patchStatus(media.id, { state: "preparing", ratio: null, jobId: plan.jobId });
      }
    } catch (e) {
      this.patchStatus(media.id, { state: "failed", message: describeError(e) });
    }
  }

  private patchStatus(mediaId: string, state: MediaState): void {
    this.status.update((s) => ({ ...s, [mediaId]: state }));
  }

  /**
   * Record a soft media failure in the diagnostics ring, deliberately WITHOUT a
   * toast. Thumbnails and waveforms are progressive enhancement — a missing one
   * must never nag — but until v0.7.3 they were dropped without a trace, so
   * "why is this thumbnail missing?" had no answer. The ring is in memory only,
   * bounded, and only ever written on a failure, so a healthy session still
   * costs nothing; a broken one becomes explainable from Settings →
   * Diagnostics and from a diagnostic report.
   */
  private noteSoftFailure(op: string, message: string, detail: string): void {
    recordError({ at: Date.now(), op, message, detail });
  }

  /** Source path behind a media id (falls back to `alt` if it has gone away). */
  private mediaPath(mediaId: string, alt: string): string {
    return this.getProject().media.find((m) => m.id === mediaId)?.path ?? alt;
  }

  private async loadWaveform(mediaId: string, path: string): Promise<void> {
    // Still progressive enhancement: clips render without a waveform and the
    // user is never interrupted. Both failure modes are now traceable.
    try {
      const res = await fetch(mediaUrl(path));
      const data = parsePk(await res.arrayBuffer());
      if (this.disposed) return;
      if (data) {
        this.waveforms.update((w) => ({ ...w, [mediaId]: data }));
      } else {
        this.noteSoftFailure(
          "Waveform",
          `Waveform data for ${this.mediaPath(mediaId, path)} couldn't be read`,
          `Peaks cache file: ${path}`,
        );
      }
    } catch (e) {
      if (this.disposed) return;
      this.noteSoftFailure(
        "Waveform",
        `Couldn't load the audio waveform for ${this.mediaPath(mediaId, path)}`,
        `${describeError(e)}\nPeaks cache file: ${path}`,
      );
    }
  }

  /**
   * Ask for a cache trim, at most once per CACHE_ENFORCE_COALESCE_MS.
   *
   * Deliberately NOT a resetting debounce: the first request in a burst arms
   * the timer and later ones ride along, so a steady stream of job completions
   * can never starve enforcement — it always runs within a second of the first
   * request, and any request that arrives after the timer fires arms a fresh
   * one. The `keep` list is built when the timer fires rather than when the
   * request came in, so it reflects the project as it is at trim time.
   */
  private enforceCache(): void {
    if (this.cacheTimer !== null) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.runEnforceCache();
    }, CACHE_ENFORCE_COALESCE_MS);
  }

  /** Issue the trim. The `keep` list is built here, not when the request came
   *  in, so it reflects the project as it is at trim time. */
  private runEnforceCache(): void {
    const keep = this.getProject().media.map(keyOf);
    void ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, keep).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    // A coalesced trim must not be lost just because the editor closed inside
    // the collection window — that is how a cache quietly grows past its cap.
    // getProject() is still valid here: the editor disposes this manager before
    // it tears the session down.
    if (this.cacheTimer !== null) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
      this.runEnforceCache();
    }
    this.jobs.clear();
  }
}
