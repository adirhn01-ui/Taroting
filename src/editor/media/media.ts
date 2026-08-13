// Media readiness manager: asks the backend how each media file will be
// previewed (direct / cached remux / background proxy), tracks preparation
// jobs, loads waveform peaks and thumbnails, and exposes reactive maps the
// editor UI renders from.

import type { CodecHints, JobDone, JobFailed, JobProgress, MediaKey } from "../../core/ipc";
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

export type JobTarget =
  | { type: "playback"; mediaId: string; output: string }
  | { type: "waveform"; mediaId: string; output: string };

/**
 * What a single job id is preparing something FOR — one media entry, or several.
 *
 * ONE BACKEND JOB LEGITIMATELY SERVES MANY MEDIA ENTRIES. Preparation jobs are
 * de-duplicated per output path (`src-tauri/src/media/playability.rs:163-172`),
 * and the output path is hashed from `{path,size,mtimeMs}` — which is IDENTICAL
 * for two media entries pointing at one file. Importing the same file twice (or
 * relinking two entries onto one file) therefore gets the SAME job id back from
 * two `plan_playback` calls, by design.
 *
 * This used to be a plain `Map<number, JobTarget>`, so the second registration
 * overwrote the first: the shared job finished, resolved exactly one of its
 * waiters, and the other sat on "Preparing 5%" for the rest of the session — no
 * picture, no sound (audio-graph only voices clips whose media is ready), until
 * the project was reopened against a warm cache. Only reachable when the cache
 * entry is absent (first open after import, or after a trim) and only for media
 * that needs a job at all — i.e. every .mov/.mkv/HEVC source.
 *
 * A LONE TARGET IS STORED DIRECTLY, NOT IN A ONE-ELEMENT ARRAY. The one-media,
 * one-job case is the overwhelming majority and it must not pay for the rare
 * one: it stores the very same object in the very same Map slot it always did,
 * and reading it back costs one `Array.isArray` branch. The array is allocated
 * only when a second waiter actually turns up, and `dropMediaTargets` collapses
 * it back to a lone target when the count falls to one, so the fast shape is
 * restored rather than left behind.
 */
export type JobEntry = JobTarget | JobTarget[];

/** Two targets are the same waiter when they name the same media and lane. */
function sameTarget(a: JobTarget, b: JobTarget): boolean {
  return a.mediaId === b.mediaId && a.type === b.type;
}

/**
 * Register `target` as a waiter on job `id`, keeping any waiters already there.
 *
 * Re-registering the same (media, lane) REPLACES rather than appends, so a
 * repeated `ensure` can never queue a media entry twice against one job — the
 * newest target wins, because it carries the newest `output`.
 */
export function addJobTarget(jobs: Map<number, JobEntry>, id: number, target: JobTarget): void {
  const entry = jobs.get(id);
  if (entry === undefined) {
    jobs.set(id, target);
    return;
  }
  if (!Array.isArray(entry)) {
    jobs.set(id, sameTarget(entry, target) ? target : [entry, target]);
    return;
  }
  const i = entry.findIndex((t) => sameTarget(t, target));
  if (i >= 0) entry[i] = target;
  else entry.push(target);
}

/**
 * Forget every job target belonging to `mediaId`, leaving its co-waiters alone.
 *
 * This is what `retrack` owes the map. Dropping the id from `tracked` is not
 * enough on its own: the media stays registered against the job the OLD file
 * started, so when that job finishes or fails it writes over the relinked
 * media's fresh status — a "failed" stamp from a file the project no longer
 * references, on top of a perfectly healthy preparing/ready state.
 *
 * Siblings must survive. Two entries can share the job, and relinking one of
 * them says nothing about the other, which is still legitimately waiting on it.
 */
export function dropMediaTargets(jobs: Map<number, JobEntry>, mediaId: string): void {
  for (const [id, entry] of jobs) {
    if (!Array.isArray(entry)) {
      if (entry.mediaId === mediaId) jobs.delete(id);
      continue;
    }
    // Compact in place; `kept` ends up as the number of survivors.
    let kept = 0;
    for (let i = 0; i < entry.length; i++) {
      if (entry[i]!.mediaId !== mediaId) entry[kept++] = entry[i]!;
    }
    if (kept === entry.length) continue;
    if (kept === 0) jobs.delete(id);
    else if (kept === 1) jobs.set(id, entry[0]!); // back to the lone-target shape
    else entry.length = kept;
  }
}

/**
 * A copy of `map` without `key` — or `map` ITSELF when the key was not in it.
 *
 * The identity matters: `Store.set` early-outs on an identical reference, so
 * forgetting a media entry that never got as far as publishing anything costs
 * one `in` test and notifies nobody. Removing the last import of a project
 * would otherwise re-render every subscriber three times over for nothing.
 */
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

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

  /** job id → the media entry (or entries) waiting on it; see `JobEntry`. */
  private jobs = new Map<number, JobEntry>();
  private tracked = new Set<string>();
  /**
   * mediaId → how many times that id's identity has been withdrawn.
   *
   * `ensure` awaits the backend, and a media entry can be relinked or removed
   * from the bin while it is waiting. The answer that then arrives describes a
   * file the project no longer points at, and publishing it stamps a stale job
   * id and a stale status over the fresh ones — visibly, a relinked clip that
   * drops back to "Preparing" on a job nobody will ever finish. So each
   * `ensure` captures this number on entry and abandons everything it was about
   * to publish if it has moved.
   *
   * ABSENT MEANS ZERO, so nothing is written here until something is actually
   * withdrawn: a project that never relinks and never removes media pays one
   * `Map.get` per media at mount and nothing at all afterwards. The entry then
   * has to STAY — it is what makes the abandoned `ensure` recognise itself as
   * stale — but ids are UUIDs, so the map is bounded by the number of media
   * withdrawn in one session.
   */
  private generations = new Map<string, number>();
  private unlisten: (() => void) | null = null;
  private disposed = false;
  /** Pending coalesced cache enforcement (see CACHE_ENFORCE_COALESCE_MS). */
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private getProject: () => ProjectFile) {}

  async init(): Promise<void> {
    const unlisten = await onJobEvents({
      // Each handler resolves EVERY waiter on the job, not just the last one
      // registered. The `Array.isArray` branch is deliberately written out
      // rather than hidden behind an iteration helper: a callback would mean a
      // closure allocation on every job event, and the one-media-one-job path
      // has to stay exactly as cheap as it was — one branch, one call, nothing
      // allocated. See `JobEntry`.
      onProgress: (e) => {
        const entry = this.jobs.get(e.id);
        if (entry === undefined) return;
        if (Array.isArray(entry)) {
          for (let i = 0; i < entry.length; i++) this.targetProgress(entry[i]!, e);
        } else {
          this.targetProgress(entry, e);
        }
      },
      onDone: (e) => {
        const entry = this.jobs.get(e.id);
        if (entry === undefined) return;
        this.jobs.delete(e.id);
        if (Array.isArray(entry)) {
          for (let i = 0; i < entry.length; i++) this.targetDone(entry[i]!, e);
        } else {
          this.targetDone(entry, e);
        }
        this.enforceCache();
      },
      onFailed: (e) => {
        const entry = this.jobs.get(e.id);
        if (entry === undefined) return;
        this.jobs.delete(e.id);
        if (Array.isArray(entry)) {
          for (let i = 0; i < entry.length; i++) this.targetFailed(entry[i]!, e);
        } else {
          this.targetFailed(entry, e);
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

  /* --- what one job event means for ONE of its waiters ------------------ *
   * Split out so the three handlers above can apply them to a lone target or
   * to each of several without duplicating the body. Bodies are unchanged
   * from when the mapping was one-to-one. */

  private targetProgress(target: JobTarget, e: JobProgress): void {
    if (target.type !== "playback") return;
    this.patchStatus(target.mediaId, { state: "preparing", ratio: e.ratio, jobId: e.id });
  }

  private targetDone(target: JobTarget, e: JobDone): void {
    const path = String(e.output.path ?? target.output);
    if (target.type === "playback") {
      this.patchStatus(target.mediaId, { state: "ready", url: mediaUrl(path), sourcePath: path });
    } else {
      void this.loadWaveform(target.mediaId, path);
    }
  }

  private targetFailed(target: JobTarget, e: JobFailed): void {
    if (target.type === "playback" && !e.canceled) {
      this.patchStatus(target.mediaId, { state: "failed", message: e.message });
    }
  }

  /** Track every media item in the project (idempotent). */
  ensureAll(project: ProjectFile): void {
    for (const media of project.media) void this.ensure(media);
  }

  /** The current generation of `mediaId`; absent is zero. See `generations`. */
  private generationOf(mediaId: string): number {
    return this.generations.get(mediaId) ?? 0;
  }

  /** Withdraw this id's identity: every `ensure` already in flight for it will
   *  drop whatever the backend eventually tells it. */
  private bumpGeneration(mediaId: string): void {
    this.generations.set(mediaId, this.generationOf(mediaId) + 1);
  }

  /** Has the `ensure` that captured `gen` been overtaken? */
  private overtaken(mediaId: string, gen: number): boolean {
    return this.generationOf(mediaId) !== gen;
  }

  /** Forget a media item's tracking and re-ensure it against the current
   *  project (e.g. after a relink changed its path/size/mtime → new cache
   *  keys). Safe no-op if the media no longer exists. */
  retrack(mediaId: string): void {
    this.tracked.delete(mediaId);
    // Cut it loose from the jobs the OLD file started, or their eventual
    // outcome lands on the relinked media — most visibly a "failed" stamp from
    // a file the project no longer references, over a fresh preparing/ready
    // state. Co-waiters on those jobs are untouched. See `dropMediaTargets`.
    dropMediaTargets(this.jobs, mediaId);
    // Dropping the TARGETS closes the window for a job that has already been
    // registered; this closes the one before that. An `ensure` still waiting on
    // `plan_playback` for the old file has not registered anything yet, so
    // there is nothing to drop — it would register the old job AFTER this ran,
    // and the fresh state would be overwritten by a job the old file started.
    this.bumpGeneration(mediaId);
    const m = this.getProject().media.find((x) => x.id === mediaId);
    if (m) void this.ensure(m);
  }

  /**
   * Forget a media item completely: it has left the project.
   *
   * `retrack`'s sibling, and the half that was missing. Removing media from the
   * bin dropped it from the project but not from here, so its id stayed in
   * `tracked` and in the three published maps for the rest of the session —
   * every status notification carrying a state for a media nothing can render,
   * and a waveform's peak arrays (the largest thing this class holds) pinned
   * behind an id no clip references. Unlike `retrack` there is nothing to
   * re-ensure afterwards, and the generation bump is what stops a `plan_playback`
   * still in flight from publishing a status for the departed entry.
   */
  untrack(mediaId: string): void {
    this.tracked.delete(mediaId);
    dropMediaTargets(this.jobs, mediaId);
    this.bumpGeneration(mediaId);
    this.status.update((s) => withoutKey(s, mediaId));
    this.waveforms.update((w) => withoutKey(w, mediaId));
    this.thumbs.update((t) => withoutKey(t, mediaId));
  }

  async ensure(media: MediaRef): Promise<void> {
    if (this.disposed || this.tracked.has(media.id)) return;
    this.tracked.add(media.id);
    // Captured BEFORE the first await, and re-checked in every continuation
    // below: each one publishes something derived from the file this media
    // pointed at when the work started. See `generations`.
    const gen = this.generationOf(media.id);

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
          if (this.disposed || this.overtaken(media.id, gen)) return;
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
          if (this.disposed || this.overtaken(media.id, gen)) return;
          if (wf.state === "ready") void this.loadWaveform(media.id, wf.path);
          else if (wf.state === "pending") {
            addJobTarget(this.jobs, wf.jobId, {
              type: "waveform",
              mediaId: media.id,
              output: wf.output,
            });
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
      // The one that was actually reachable, if only just: a relink cuts the
      // media loose from its old jobs, but a plan still in flight has not
      // registered one yet, so without this it registers the OLD job after the
      // cut and drags the relinked media back to "Preparing" on a job that will
      // never report to it.
      if (this.disposed || this.overtaken(media.id, gen)) return;
      if (plan.mode === "direct" || plan.mode === "ready") {
        this.patchStatus(media.id, {
          state: "ready",
          url: mediaUrl(plan.path),
          sourcePath: plan.path,
        });
      } else {
        addJobTarget(this.jobs, plan.jobId, {
          type: "playback",
          mediaId: media.id,
          output: plan.output,
        });
        this.patchStatus(media.id, { state: "preparing", ratio: null, jobId: plan.jobId });
      }
    } catch (e) {
      // A failure belonging to the file this ensure started against, reported
      // onto a media entry that has since been relinked or removed, is the same
      // stale write wearing its most alarming face.
      if (this.disposed || this.overtaken(media.id, gen)) return;
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
