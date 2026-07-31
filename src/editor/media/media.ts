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

  private enforceCache(): void {
    const keep = this.getProject().media.map(keyOf);
    void ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, keep).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.jobs.clear();
  }
}
