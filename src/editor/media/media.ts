// Media readiness manager: asks the backend how each media file will be
// previewed (direct / cached remux / background proxy), tracks preparation
// jobs, loads waveform peaks and thumbnails, and exposes reactive maps the
// editor UI renders from.

import type { JobDone, JobFailed, JobProgress, MediaKey } from "../../core/ipc";
import { codecHints, describeError, ipc, mediaUrl, onJobEvents } from "../../core/ipc";
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

// Moved to core/ipc.ts (the viewer asks the same question); re-exported so
// existing importers keep working.
export { codecHints };

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

function isWaveform(t: JobTarget): boolean {
  return t.type === "waveform";
}

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

/**
 * How many recent terminal job events a MediaManager remembers, so a plan or
 * waveform answer still on its way can claim one (see `MediaManager.orphans`).
 *
 * Every terminal event is remembered, matched or not: one job can serve two
 * media entries, and the second answer may land after the event has already
 * resolved the first. So the ring has to outlast the whole burst a project
 * open produces (about one remux or proxy plus one waveform per media, some
 * forty completions for a large project) while the slowest answer of that
 * burst is still in flight. Sixty-four leaves headroom over that. The ring is
 * keyed by job id, so a repeated event never takes a second slot, and it holds
 * only the event objects the listener already received. The viewer keeps 4
 * for the same race (`ORPHAN_KEEP` in viewer/loader.ts); the two constants are
 * kept apart on purpose: the viewer chunk must not import editor code, nor the
 * reverse.
 */
export const ORPHAN_KEEP = 64;

/** A terminal job event, remembered for an answer that may name it later.
 *  Only a failure carries `canceled`, which is how the two are told apart. */
type Orphan = JobDone | JobFailed;

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
  /**
   * Recent terminal events by job id, whether or not anyone here was waiting
   * on them. Tauri events and invoke answers travel separate channels, so a
   * short remux (or a job this plan JOINED as it was finishing) can report
   * `job:done` before the `plan_playback` answer naming it reaches us.
   * Dropped, as it used to be, it left the media on "Preparing" for the rest
   * of the session: the job never reports again. A lost foreign cancel was
   * just as sticky, and also defeated the re-plan in `targetFailed`.
   *
   * MATCHED events are kept too: one job can serve two media entries (see
   * `JobEntry`), and an end that lands between their two answers resolves the
   * first and finds nobody yet for the second. Consulted only for an id an
   * answer just returned (`claimOrphan`), and never removed by it, for the
   * same reason. Leaving the entry is safe because the backend never hands a
   * finished or canceled job to a fresh request, so no later answer can name
   * it by mistake; it simply ages out. Insertion order, oldest evicted first,
   * bounded by ORPHAN_KEEP; cleared on dispose.
   */
  private orphans = new Map<number, Orphan>();
  /**
   * Media ids `load_project` reported missing or changed on disk, not yet
   * ensured. `ensure` stats each one ONCE before doing anything for it: a file
   * that is not there gets "File not found" and no thumbnail, waveform or
   * playback request at all. Previously each of those went out for a path the
   * backend had just said was gone (a crafted `.trt` aims them wherever it
   * likes), and `plan_playback` answered "direct" for it, so the bin said Ready
   * over a black stage. A file that is there but CHANGED (a new mtime from a
   * copy) is ensured as before: the relink dialog already asks about it, and
   * withholding it would stop a project that merely moved machines from
   * previewing until every file was relinked.
   *
   * Empty for any project whose media are all intact, so the check costs one
   * `Set.delete` per ensure.
   */
  private withheld = new Set<string>();
  private unlisten: (() => void) | null = null;
  private disposed = false;
  /** Set by `dispose({ cancelPlayback: true })`: the project is gone for good,
   *  so its playback preparation is canceled too (see `dispose`). */
  private cancelPlayback = false;
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
      onDone: (e) => this.jobDone(e),
      onFailed: (e) => this.jobFailed(e),
    });
    // Registration is async, so dispose() can land BEFORE the listener exists.
    // It had nothing to call, so hand the unlisten back here — otherwise the
    // listener leaks for the rest of the process and keeps feeding job events
    // into a disposed manager.
    if (this.disposed) unlisten();
    else this.unlisten = unlisten;
  }

  /** A job finished: remember it for an answer that may still name it (see
   *  `orphans`), then resolve whoever is already waiting on it. */
  private jobDone(e: JobDone): void {
    this.keepOrphan(e);
    const entry = this.jobs.get(e.id);
    if (entry === undefined) return;
    this.jobs.delete(e.id);
    this.resolveDone(entry, e);
  }

  /** A job failed or was canceled: remembered and resolved exactly as in
   *  `jobDone`. */
  private jobFailed(e: JobFailed): void {
    this.keepOrphan(e);
    const entry = this.jobs.get(e.id);
    if (entry === undefined) return;
    this.jobs.delete(e.id);
    this.resolveFailed(entry, e);
  }

  /** Resolve every waiter in an entry already taken out of `jobs`, then ask
   *  for a cache trim. */
  private resolveDone(entry: JobEntry, e: JobDone): void {
    if (Array.isArray(entry)) {
      for (let i = 0; i < entry.length; i++) this.targetDone(entry[i]!, e);
    } else {
      this.targetDone(entry, e);
    }
    this.enforceCache();
  }

  /** Tell every waiter in an entry already taken out of `jobs`. */
  private resolveFailed(entry: JobEntry, e: JobFailed): void {
    if (Array.isArray(entry)) {
      for (let i = 0; i < entry.length; i++) this.targetFailed(entry[i]!, e);
    } else {
      this.targetFailed(entry, e);
    }
  }

  private keepOrphan(e: Orphan): void {
    if (this.disposed) return;
    // Deleted first so a repeat moves to the newest end instead of keeping its
    // old place in line.
    this.orphans.delete(e.id);
    this.orphans.set(e.id, e);
    if (this.orphans.size > ORPHAN_KEEP) {
      const oldest = this.orphans.keys().next();
      if (!oldest.done) this.orphans.delete(oldest.value);
    }
  }

  /**
   * A plan or waveform answer just named job `jobId` and its waiter is now
   * registered: if that job's terminal event already arrived, resolve the
   * waiter with it. Called only AFTER everything the answer publishes is in
   * place, so the replayed outcome is the last word — replayed before the
   * "preparing" patch, a finished job would be painted straight back over
   * with "Preparing".
   *
   * It resolves directly rather than going back through `jobDone`/`jobFailed`:
   * the event is already in the ring, and a second trip would only re-insert
   * it. Nor is it taken out: a second media entry sharing the job may still be
   * waiting for its own answer, and it needs the same replay (see `orphans`).
   */
  private claimOrphan(jobId: number): void {
    const o = this.orphans.get(jobId);
    if (o === undefined) return;
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return;
    this.jobs.delete(jobId);
    if ("canceled" in o) this.resolveFailed(entry, o);
    else this.resolveDone(entry, o);
  }

  /* --- what one job event means for ONE of its waiters ------------------ *
   * Split out so the handlers above can apply them to a lone target or
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
    if (!e.canceled) {
      if (target.type === "playback") {
        this.patchStatus(target.mediaId, { state: "failed", message: e.message });
      }
      return;
    }
    // CANCELED UNDER US. A live manager never cancels a job it is listening
    // to: every cancel it issues happens in or after `dispose`, which
    // unlistens first (a waveform always; a playback job only when the
    // project was discarded — see `dispose`). So this
    // is SOMEONE ELSE'S cancel of a job we joined — the backend hands every
    // consumer of one output path the same job, and a closing editor (or a
    // viewer stepping past a file) cancels the one it started even when we
    // are riding on it. Ignoring it, as this used to, left the media on
    // "Preparing" for the rest of the session (or without a waveform), on a
    // job that will never report again. Asking again is safe: the backend
    // never hands a canceled job to a fresh request, it starts a new one. And
    // it cannot spin — each round needs a fresh cancel from outside.
    //
    // `jobFailed` (or `claimOrphan`, replaying one) has already deleted this
    // job id from `jobs` before calling here, so `retrack`'s `dropMediaTargets` never touches the entry array
    // the caller is still iterating.
    if (target.type === "playback") {
      this.retrack(target.mediaId);
      return;
    }
    // A waveform re-asks for just the waveform: retracking would re-plan the
    // playback too, and flash a perfectly good preview back to "checking".
    const media = this.getProject().media.find((m) => m.id === target.mediaId);
    if (media?.hasAudio) this.requestWaveform(media, this.generationOf(media.id));
  }

  /**
   * Track every media item in the project (idempotent).
   *
   * `missing`: the ids `load_project` reported missing or changed, passed once,
   * on the call that follows the load. Each is checked for existence before
   * anything else is asked for it (see `withheld`). The ids are taken BEFORE
   * the loop because `ensure` reads them synchronously, up to its first await.
   */
  ensureAll(project: ProjectFile, missing?: readonly string[]): void {
    if (missing) for (const id of missing) this.withheld.add(id);
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
   *  keys). Safe no-op if the media no longer exists.
   *
   *  `fileChanged`: the media now points at a DIFFERENT file (a relink), so the
   *  waveform and thumbnail published for the old one are dropped before the
   *  re-ensure. Without it they stay for the whole session — the re-ensure only
   *  ever ADDS: a relinked file with no audio asks for no waveform, so the old
   *  file's peaks went on being drawn on every clip, and a thumbnail that fails
   *  for the new file left the old picture in the bin. False (the default) is
   *  the same file asked about again — a foreign cancel's re-plan — where the
   *  display data is still right and dropping it would only flash it away. */
  retrack(mediaId: string, fileChanged = false): void {
    this.tracked.delete(mediaId);
    // A relink resolved it: the new file is ensured like any other.
    this.withheld.delete(mediaId);
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
    if (fileChanged) {
      // After the bump, so an old-file answer still in flight cannot put back
      // what this just took away. `withoutKey` hands back the same map when
      // there was nothing to drop, so nobody is notified for nothing.
      this.waveforms.update((w) => withoutKey(w, mediaId));
      this.thumbs.update((t) => withoutKey(t, mediaId));
    }
    const m = this.getProject().media.find((x) => x.id === mediaId);
    if (m) void this.ensure(m);
  }

  /**
   * Stamp a media entry as failed from OUTSIDE the manager — the preview's own
   * <video> reporting that it cannot play what the manager said was ready (a
   * missing or undecodable file the backend classified as directly playable).
   *
   * Only the CURRENT identity is stamped. A disposed manager, or an id it does
   * not track (never ensured, or removed from the bin since), is left alone:
   * stamping one would resurrect a status for media nothing can render. The
   * caller still owes its own staleness check — an error from an element that
   * was showing the file BEFORE a relink describes a file the media no longer
   * points at; the scheduler compares the element's URL with the ready state's.
   *
   * The stamp sticks until the media is retracked (a relink) or removed: the
   * generation is bumped, so an answer already in flight for this identity — a
   * plan that would say "ready" for a path that is not there, or a thumbnail —
   * is dropped instead of painting over the failure. A job already REGISTERED
   * for the id is not cut loose; the intended callers stamp media that is
   * ready, and a ready media has no playback job left to finish.
   */
  markFailed(mediaId: string, message: string): void {
    if (this.disposed || !this.tracked.has(mediaId)) return;
    this.bumpGeneration(mediaId);
    this.patchStatus(mediaId, { state: "failed", message });
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
    this.withheld.delete(mediaId);
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

    // Reported missing or changed by the load: find out which before asking the
    // backend for anything (see `withheld`). The stat is the one `load_project`
    // already made of the same path, so it reaches nothing new.
    if (this.withheld.delete(media.id)) {
      let present: boolean;
      try {
        present = await ipc.pathExists(media.path);
      } catch {
        // The question could not be asked; behave as before rather than
        // declare a file gone on no evidence.
        present = true;
      }
      if (this.disposed || this.overtaken(media.id, gen)) return;
      if (!present) {
        this.patchStatus(media.id, { state: "failed", message: "File not found" });
        return;
      }
    }

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
            [media.path],
          ),
        );
    }

    // Waveform peaks
    if (media.hasAudio) this.requestWaveform(media, gen);

    // Playback plan
    try {
      const plan = await ipc.planPlayback(media, codecHints(), settingsStore.get().proxyMedia);
      // Answered after dispose: a pending job is deliberately LEFT RUNNING,
      // not canceled — see `cancelOrphan` for why playback preparation outlives
      // the editor that asked for it — unless the project was discarded, when
      // nothing will ever rejoin it. It is registered nowhere, so this is the
      // only chance to stop it.
      if (this.disposed) {
        if (this.cancelPlayback && plan.mode === "pending") this.cancelOrphan(plan.jobId);
        return;
      }
      // The one that was actually reachable, if only just: a relink cuts the
      // media loose from its old jobs, but a plan still in flight has not
      // registered one yet, so without this it registers the OLD job after the
      // cut and drags the relinked media back to "Preparing" on a job that will
      // never report to it.
      if (this.overtaken(media.id, gen)) return;
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
        // Last, so a job that already finished lands on top of "Preparing".
        this.claimOrphan(plan.jobId);
      }
    } catch (e) {
      // A failure belonging to the file this ensure started against, reported
      // onto a media entry that has since been relinked or removed, is the same
      // stale write wearing its most alarming face.
      if (this.disposed || this.overtaken(media.id, gen)) return;
      this.patchStatus(media.id, { state: "failed", message: describeError(e) });
    }
  }

  /**
   * Ask for one media entry's waveform peaks and register the job if one has
   * to run. Split out of `ensure` so `targetFailed` can re-ask for JUST the
   * waveform when someone else cancels a job we joined.
   */
  private requestWaveform(media: MediaRef, gen: number): void {
    void ipc
      .ensureWaveform(keyOf(media), media.duration, true)
      .then((wf) => {
        if (this.disposed) {
          if (wf.state === "pending") this.cancelOrphan(wf.jobId);
          return;
        }
        if (this.overtaken(media.id, gen)) return;
        if (wf.state === "ready") void this.loadWaveform(media.id, wf.path);
        else if (wf.state === "pending") {
          addJobTarget(this.jobs, wf.jobId, {
            type: "waveform",
            mediaId: media.id,
            output: wf.output,
          });
          this.claimOrphan(wf.jobId);
        }
      })
      .catch((e: unknown) =>
        this.noteSoftFailure(
          "Waveform",
          `Couldn't build the audio waveform for ${media.path}`,
          describeError(e),
          [media.path],
        ),
      );
  }

  /**
   * Cancel a job nobody here will ever read — as a rule, a WAVEFORM job.
   *
   * Only waveforms, deliberately. A closed editor's waveform scans are pure
   * display, a few seconds of decode each, and cheap to redo — letting them run
   * on for a project no longer on screen buys nothing. Playback preparation is
   * the opposite on every count: a remux or proxy can be minutes of transcode,
   * and its output is what the next open needs to play the file AT ALL. The
   * backend shares one job per output path, so an editor closed mid-proxy and
   * reopened (Editor → Settings → Editor, Edit → Back → Edit) rejoins the job
   * still running, or finds the result in the cache — where canceling it here
   * restarted the transcode from zero on every return. Those jobs are left to
   * finish into the cache. Note the trim is NOT immediate: `enforceCache` runs
   * on a `job:done` some live manager hears, so a proxy that lands after the
   * last editor closed waits for the next trim to be counted against the cap.
   *
   * Two callers: `dispose` for every waveform job this manager registered, and
   * `requestWaveform` for an answer that arrived after dispose — that job was
   * started for us and is registered nowhere, so without this it escapes.
   *
   * The one exception to "only waveforms" is a DISCARDED project
   * (`dispose({ cancelPlayback: true })`): its temporary file is deleted, no
   * open will ever rejoin its remuxes or proxies, and stepping through a folder
   * of such files would otherwise queue one transcode per file behind the one
   * the user is looking at. Then `dispose` cancels every job it holds and
   * `ensure` cancels a pending plan that answers late.
   *
   * A successor that had ALREADY joined the job hears it canceled and asks
   * again (`targetFailed`); the backend never hands a canceled job to a fresh
   * request. Best-effort — a job that finished in the meantime simply isn't
   * there to cancel.
   */
  private cancelOrphan(jobId: number): void {
    void ipc.cancelJob(jobId).catch(() => {});
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
   *
   * `paths`: every whole path the message and detail name. The redactor is
   * seeded only with the OPEN project's media, so an entry about media that
   * has since been removed or relinked, or about a peaks file in the cache,
   * would otherwise leave it hunting for the path in free text, where a name
   * with a space can be cut short and half of it left in a pasted report.
   */
  private noteSoftFailure(op: string, message: string, detail: string, paths: string[]): void {
    recordError({ at: Date.now(), op, message, detail, paths });
  }

  /** Source path behind a media id, or undefined if it has left the project. */
  private mediaPath(mediaId: string): string | undefined {
    return this.getProject().media.find((m) => m.id === mediaId)?.path;
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
        const source = this.mediaPath(mediaId);
        this.noteSoftFailure(
          "Waveform",
          `Waveform data for ${source ?? path} couldn't be read`,
          `Peaks cache file: ${path}`,
          source === undefined ? [path] : [source, path],
        );
      }
    } catch (e) {
      if (this.disposed) return;
      const source = this.mediaPath(mediaId);
      this.noteSoftFailure(
        "Waveform",
        `Couldn't load the audio waveform for ${source ?? path}`,
        `${describeError(e)}\nPeaks cache file: ${path}`,
        source === undefined ? [path] : [source, path],
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

  /**
   * Stop listening and let go of this project's work.
   *
   * `cancelPlayback`: the project will never be opened again (a discarded
   * temporary project), so its playback preparation is canceled along with its
   * waveforms — here for every job it holds, and in `ensure` for a plan that
   * answers late. Left unset, remuxes and proxies run on into the cache for the
   * next open (see `cancelOrphan`). Another consumer riding on a canceled job
   * hears the cancel and plans again (`targetFailed`), so canceling a shared
   * job cannot strand it.
   */
  dispose(opts?: { cancelPlayback?: boolean }): void {
    this.disposed = true;
    if (opts?.cancelPlayback === true) this.cancelPlayback = true;
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
    // Waveform scans only; remuxes and proxies run on into the cache for the
    // next open to rejoin or find (see `cancelOrphan`). A job id never mixes
    // lanes (the two write different outputs), but the test is per waiter all
    // the same: a job any playback waiter rides on is never canceled — unless
    // the project was discarded, when everything goes.
    for (const [id, entry] of this.jobs) {
      if (this.cancelPlayback || (Array.isArray(entry) ? entry.every(isWaveform) : isWaveform(entry))) {
        this.cancelOrphan(id);
      }
    }
    this.jobs.clear();
    this.orphans.clear();
    this.withheld.clear();
  }
}
