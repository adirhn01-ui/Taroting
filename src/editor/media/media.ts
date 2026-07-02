// Media readiness manager: asks the backend how each media file will be
// previewed (direct / cached remux / background proxy), tracks preparation
// jobs, loads waveform peaks and thumbnails, and exposes reactive maps the
// editor UI renders from.

import type { CodecHints, MediaKey } from "../../core/ipc";
import { describeError, inTauri, ipc, mediaUrl, onJobEvents } from "../../core/ipc";
import { settingsStore } from "../../core/session";
import { Store } from "../../core/store";
import type { MediaRef, ProjectFile } from "../../core/types";

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
  private unlisten: () => void = () => {};
  private disposed = false;

  constructor(private getProject: () => ProjectFile) {}

  async init(): Promise<void> {
    this.unlisten = await onJobEvents({
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
  }

  /** Track every media item in the project (idempotent). */
  ensureAll(project: ProjectFile): void {
    for (const media of project.media) void this.ensure(media);
  }

  async ensure(media: MediaRef): Promise<void> {
    if (this.disposed || this.tracked.has(media.id)) return;
    this.tracked.add(media.id);
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
        .catch(() => {});
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
        .catch(() => {});
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

  private async loadWaveform(mediaId: string, path: string): Promise<void> {
    try {
      const res = await fetch(mediaUrl(path));
      const data = parsePk(await res.arrayBuffer());
      if (data && !this.disposed) {
        this.waveforms.update((w) => ({ ...w, [mediaId]: data }));
      }
    } catch {
      // waveform is progressive enhancement — clips render without it
    }
  }

  private enforceCache(): void {
    const keep = this.getProject().media.map(keyOf);
    void ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, keep).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten();
    this.jobs.clear();
  }
}
