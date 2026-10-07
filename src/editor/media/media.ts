// Media readiness manager: asks the backend how each media file will be
// previewed (direct / cached remux / background proxy), tracks preparation
// jobs, loads waveform peaks and thumbnails, and exposes reactive maps the
// editor UI renders from.

import type { JobDone, JobFailed, JobProgress, MediaKey, RepairNote, UpgradeJob } from "../../core/ipc";
import { codecHints, describeError, ipc, mediaUrl, onJobEvents } from "../../core/ipc";
import { settingsStore } from "../../core/session";
import { Store } from "../../core/store";
import type { MediaRef, ProjectFile } from "../../core/types";
import { recordError } from "../../ui/errors";

export type MediaState =
  | { state: "checking" }
  | { state: "ready"; url: string; sourcePath: string }
  /** `jobId` is null only while a repair plan has been asked for and has not
   *  named its job yet (see `MediaManager.playbackFailed`): the media has to
   *  leave "ready" at once, or the scheduler reloads the dead file meanwhile.
   *  While an instant copy's full repair runs, it may name that UPGRADE job
   *  (the instant copy failed in the element; see `playbackFailed`). */
  | { state: "preparing"; ratio: number | null; jobId: number | null }
  | { state: "failed"; message: string };

/**
 * What the editor knows about a DAMAGED video: one whose preview had to be
 * repaired because the WebView's decoder refused it (see `RepairNote`).
 * Published per media id in `MediaManager.damage`, which healthy media never
 * enter — so the bin, the stage and the toast can tell the user, and the
 * normal case (an empty map) costs them nothing.
 *
 * `until`: SOURCE seconds from 0 that cannot be read (`damagedUntil`), or
 * null when the backend found no damaged prefix. `phase`: "repairing" while
 * the full repair runs (the instant copy plays meanwhile, or nothing does),
 * "recovered" once the full repair is what plays (the damaged part then
 * shows whatever ffmpeg could conceal), "unrecovered" when the full repair
 * failed and the instant copy is all there is. `ratio`: the running full
 * repair's progress, null before its first report and outside "repairing".
 */
export interface DamageState {
  until: number | null;
  phase: "repairing" | "recovered" | "unrecovered";
  ratio: number | null;
}

/** `RepairNote.damagedUntil` as a damage range end: a positive, finite number
 *  of source seconds, or null. The note crossed IPC from a scan of a damaged
 *  file, so nothing about its shape is taken on trust. */
function damagedUntilOf(note: RepairNote): number | null {
  const u: unknown = note.damagedUntil;
  return typeof u === "number" && Number.isFinite(u) && u > 0 ? u : null;
}

/** MediaError codes that say the WebView could not DECODE the file it was
 *  handed (3, MEDIA_ERR_DECODE) or would not take it at all (4,
 *  MEDIA_ERR_SRC_NOT_SUPPORTED) — the two a repair copy decoded by ffmpeg can
 *  answer. Chromium stops a whole file at its first undecodable frame, where
 *  ffmpeg conceals the frame and carries on. Spelled out because the node test
 *  environment has no MediaError. */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** A failed repair, worded as the element's failure (`message`, which the
 *  overlay and the bin's Failed tooltip already read well) with the backend's
 *  own detail after it, so the diagnosis is not lost. */
function repairFailedText(message: string, detail: string): string {
  return detail === "" ? message : `${message}: ${detail}`;
}

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
  /** `repair`: the plan that started the job named a REPAIR copy, so its
   *  `job:done` publishes one (see `MediaManager.publishReady`). Absent for
   *  every ordinary remux and proxy. */
  | { type: "playback"; mediaId: string; output: string; repair?: RepairNote; file?: MediaKey }
  /** The FULL repair running behind an instant copy (`PlaybackPlan.upgrade`).
   *  A lane of its own because the media is already READY on the instant
   *  copy: its progress feeds `MediaManager.damage`, never the status (a
   *  playback target's progress would drag the playing media back to
   *  "Preparing"), and its `job:done` swaps the full copy in. `repair` is the
   *  plan's (instant) note; `file` the identity the plan was made against.
   *  `dropsHeaders` is learned when the instant copy is published (so an
   *  export meanwhile decodes the same way); the swap re-learns it for that
   *  identity, or learns it first when the instant copy never played. */
  | { type: "upgrade"; mediaId: string; output: string; repair: RepairNote; file: MediaKey }
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
 * Forget `mediaId`'s waiter in ONE lane of job `id`, leaving every other
 * waiter on it — co-waiters on a shared job, and the media's own other lanes.
 * `dropMediaTargets` cuts a media loose from everything; this is for the
 * single job a media stops wanting while it stays tracked (an instant copy's
 * full repair once the media is failed for good; see `markFailed`).
 */
export function dropJobTarget(
  jobs: Map<number, JobEntry>,
  id: number,
  mediaId: string,
  type: JobTarget["type"],
): void {
  const entry = jobs.get(id);
  if (entry === undefined) return;
  const doomed = (t: JobTarget): boolean => t.mediaId === mediaId && t.type === type;
  if (!Array.isArray(entry)) {
    if (doomed(entry)) jobs.delete(id);
    return;
  }
  const kept = entry.filter((t) => !doomed(t));
  if (kept.length === entry.length) return;
  if (kept.length === 0) jobs.delete(id);
  else jobs.set(id, kept.length === 1 ? kept[0]! : kept);
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

/**
 * How long a discarded project's remux or proxy is left running for the next
 * editor to join before it is canceled (see `abandonPlaybackJob`).
 *
 * It has to cover the gap between one editor's teardown and the next one's
 * `plan_playback` answer: an Explorer open in editor mode probes the file and
 * writes a temporary project before the editor even mounts, which on a slow
 * machine is seconds. A job the timer cancels after a successor joined it is
 * not lost — the successor hears the cancel and plans again — it is only
 * restarted, which is what this window exists to avoid. The price of a longer
 * window is that a transcode nobody wants holds the one transcode worker that
 * long before the next file's own preparation can start.
 */
export const ABANDON_GRACE_MS = 8000;

/**
 * Playback jobs a discarded project left behind, by job id, each with the timer
 * that cancels it. Module-level on purpose: the manager that can rejoin one is
 * the NEXT editor's, a different instance from the one that let it go.
 */
const abandoned = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Let go of a discarded project's remux or proxy: cancel it, but only once the
 * next editor has had `ABANDON_GRACE_MS` to join it.
 *
 * Canceling at once (as 0.9.1 first did) threw away the transcode the very
 * next screen needed whenever that screen showed the SAME file — an untouched
 * temporary project is discarded without a question, so Explorer reopening the
 * file it showed restarted a minutes-long proxy from 0%. Never canceling
 * (0.9.0) left every discarded file's transcode queued on the single transcode
 * worker ahead of the next file's. This keeps both: a successor that joins the
 * job claims it (`reclaimPlaybackJob`), and nobody else's wait grows unbounded.
 */
function abandonPlaybackJob(jobId: number): void {
  if (abandoned.has(jobId)) return;
  abandoned.set(
    jobId,
    setTimeout(() => {
      abandoned.delete(jobId);
      void ipc.cancelJob(jobId).catch(() => {});
    }, ABANDON_GRACE_MS),
  );
}

/** A live manager's plan named this job: it is wanted again, so it is no longer
 *  anyone's to cancel. A no-op for a job nobody abandoned. */
function reclaimPlaybackJob(jobId: number): void {
  const timer = abandoned.get(jobId);
  if (timer === undefined) return;
  clearTimeout(timer);
  abandoned.delete(jobId);
}

/**
 * Whether a closing editor abandons its playback preparation (see
 * `MediaManager.dispose`). Only a DISCARDED project does — a kept or permanent
 * one will be opened again and lets its transcodes run on into the cache — and
 * not even then when the editor goes back to the viewer it came from: the
 * viewer shows the same file again and joins the same job, but it is not a
 * MediaManager and cannot claim it, so the grace timer would cancel the
 * transcode it is waiting on. The viewer cancels its own jobs when it steps
 * past the file, so that case stays bounded without this.
 */
export function abandonsPlayback(discarded: boolean, returnsToViewer: boolean): boolean {
  return discarded && !returnsToViewer;
}

export interface MediaManagerOptions {
  /**
   * A repair copy of `mediaId` — the full one, or the instant copy playing
   * while it runs — says the stream decodes only with its in-band H.264
   * headers (SPS/PPS/SEI) removed (`RepairNote.dropsHeaders`), and the
   * project's media does not say so yet. The editor records it on the media
   * (`dropInbandHeaders`) as a fixup the user did not make, so the export
   * decodes the file the same way and the next open plans the repair
   * straight away. Called only while the media is in the project and lacks
   * the flag — again whenever the project loses it (see `watchProject`).
   */
  onDropHeaders?: (mediaId: string) => void;
  /**
   * Subscribe `onChange` to every change of the project `getProject` reads;
   * returns the unsubscribe. The manager holds the subscription from
   * construction to `dispose`, and uses it only to call `onDropHeaders`
   * again for media whose record of it an older project took away (see
   * `MediaManager.restampDropHeaders`). A project with nothing to record
   * pays one size check per change.
   */
  watchProject?: (onChange: () => void) => () => void;
  /**
   * `mediaId` was just found DAMAGED: a repair plan answered for it, and
   * `state` is what `damage` now says. `quick`: that plan named the instant
   * copy, so everything after the damage plays at once. Called ONCE per media
   * per session, however often the file is re-planned or re-repaired — the
   * editor raises its "This video is damaged" notice here when a repair has
   * to run (`damageNotice`), and the bin and the stage keep saying so for as
   * long as the media is shown. A relink onto a
   * different file earns the new file a notice of its own.
   */
  onDamaged?: (mediaId: string, state: DamageState, quick: boolean) => void;
}

export class MediaManager {
  /** mediaId → preview readiness */
  readonly status = new Store<Record<string, MediaState>>({});
  /** mediaId → decoded waveform peaks */
  readonly waveforms = new Store<Record<string, WaveformData>>({});
  /** mediaId → thumbnail file path */
  readonly thumbs = new Store<Record<string, string>>({});
  /**
   * mediaId → what is known about that media's damage (see `DamageState`).
   * Written only for media a repair plan answered for; a healthy project
   * never writes it, so its subscribers are never notified and every reader
   * finds an empty map. Cleared for an id by `untrack` and by a `retrack`
   * onto a different file; a same-file retrack keeps it until the fresh plan
   * says otherwise.
   */
  readonly damage = new Store<Record<string, DamageState>>({});

  /** job id → the media entry (or entries) waiting on it; see `JobEntry`. */
  private jobs = new Map<number, JobEntry>();
  private tracked = new Set<string>();
  /**
   * Ids the preview's own element could not play: stamped by `markFailed`, or
   * refused and then failed their repair attempt too (`planFailed`). Empty
   * unless an element has failed, so `healSiblings` costs one size check per
   * ready plan. Cleared for an id by `retrack` and `untrack`.
   */
  private elementFailed = new Set<string>();
  /**
   * Ids `healSiblings` retracked whose fresh plan has not come back yet. That
   * plan's ready answer heals nobody in turn: two entries for one file the
   * element cannot play, both on stage, would otherwise retrack each other
   * for ever — each round a plan, a thumbnail, a waveform and a bin re-render.
   * Consumed by the id's next ready plan; cleared by any other `retrack` and
   * by `untrack`. Empty unless a heal ran.
   */
  private healed = new Set<string>();
  /**
   * Ids that have spent their one repair attempt this session (see
   * `playbackFailed`), each with the message the preview's element reported —
   * the wording a failed repair is reported under. One attempt, because a
   * repair copy is a transcode: a file whose copy fails too, or whose answer
   * is not a repair, must not start another for every element error. Cleared
   * for an id by `retrack` and `untrack`: a relinked file is a different file
   * and gets its own attempt. Empty unless an element has refused a file.
   */
  private repairTried = new Map<string, string>();
  /**
   * Ids whose CURRENT ready state came from a plan (or a job) carrying
   * `repair`: the url the element plays is already the repair copy, so its
   * failing is final. Kept by `publishReady`, the one place a ready state is
   * published; cleared by `retrack` and `untrack`. Empty unless a repair copy
   * was planned.
   */
  private repairReady = new Set<string>();
  /**
   * Ids playing an INSTANT copy whose full repair is still running, each with
   * that upgrade's job id. While it runs, the instant copy failing in the
   * element is not final — the media waits on the full copy instead (see
   * `playbackFailed`). Set where a plan names an upgrade (`noteRepair`);
   * deleted when that job ends, by `markFailed`, `retrack` and `untrack`.
   * Empty unless a damaged file is being repaired.
   */
  private upgrades = new Map<string, number>();
  /**
   * Ids the user has been told are damaged this session (`onDamaged`), so a
   * re-plan, a foreign cancel or a heal never repeats the notice. Kept by
   * `untrack` (an undo can bring the same media back); cleared by a `retrack`
   * onto a different file, which is news of its own. Empty unless a repair
   * plan answered.
   */
  private damageNoticed = new Set<string>();
  /**
   * Ids whose repair copy says their stream decodes only without its in-band
   * headers (`RepairNote.dropsHeaders`, learned from the instant copy as soon
   * as it plays — see `publishReady`) this session: their media must say
   * `dropInbandHeaders`, or the export decodes the very garbage the preview
   * was repaired around. Remembered because the project's record of it is a
   * fixup outside history (`onDropHeaders`), which an undo or a cancelled
   * drag can take away; `restampDropHeaders` puts it back. Cleared for an
   * id by a relink (`retrack` with `fileChanged`) and by `untrack`: a
   * different file learns this for itself. A same-file retrack keeps it — the
   * stream did not change. Empty unless a repair copy dropped headers.
   *
   * Keyed by id but held for the FILE the repair was planned against
   * ({path, size, mtimeMs}), and only ever stamped while the id still points
   * at that file. An undo can swap the file under an id without any retrack —
   * undoing a relink brings the previous file back — and the record of a
   * damaged stream must never land on a healthy one: it would send that file
   * through a repair transcode on every later open and change how it exports.
   */
  private dropsLearned = new Map<string, MediaKey>();
  /** The `watchProject` subscription, held from construction to `dispose`. */
  private unwatchProject: (() => void) | null = null;
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
  /** Set by `dispose({ abandonPlayback: true })`: the project is gone for
   *  good, so its playback preparation is abandoned too (see `dispose`). */
  private abandonPlayback = false;
  /** Pending coalesced cache enforcement (see CACHE_ENFORCE_COALESCE_MS). */
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private getProject: () => ProjectFile,
    private opts: MediaManagerOptions = {},
  ) {
    // Here rather than in `init`, which is async: `dispose` can land before it
    // resolves. Every way out of an editor — a superseded mount, a mount that
    // throws, the screen's own dispose — reaches `dispose`, which drops it.
    if (opts.watchProject !== undefined) {
      this.unwatchProject = opts.watchProject(() => this.restampDropHeaders());
    }
  }

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
    if (target.type === "waveform") return;
    if (target.type === "upgrade") {
      this.damageProgress(target.mediaId, e.ratio);
      // The instant copy failed in the element and the media waits on this
      // job (`playbackFailed`): its Preparing bar follows the job as well.
      // Otherwise the media is READY on the instant copy and stays so.
      const st = this.status.get()[target.mediaId];
      if (st?.state === "preparing" && st.jobId === e.id) {
        this.patchStatus(target.mediaId, { state: "preparing", ratio: e.ratio, jobId: e.id });
      }
      return;
    }
    if (this.quickSuperseded(target)) return;
    this.patchStatus(target.mediaId, { state: "preparing", ratio: e.ratio, jobId: e.id });
    // A full repair with no instant copy in front of it: the damage record
    // reports its progress too. An instant copy's own (sub-second) remux is
    // not the repair, and must not move the repair's number.
    if (target.repair !== undefined && target.repair.quick !== true) this.damageProgress(target.mediaId, e.ratio);
  }

  private targetDone(target: JobTarget, e: JobDone): void {
    const path = String(e.output.path ?? target.output);
    if (target.type === "playback") {
      if (this.quickSuperseded(target)) return;
      this.publishReady(target.mediaId, path, target.repair, target.file);
      if (target.repair !== undefined && target.repair.quick !== true) this.setDamagePhase(target.mediaId, "recovered");
    } else if (target.type === "upgrade") {
      this.upgradeDone(target, path, e.id);
    } else {
      void this.loadWaveform(target.mediaId, path);
    }
  }

  /**
   * An instant copy's own job reporting AFTER the full repair behind it has
   * already been swapped in (`upgradeDone`): only possible when this editor
   * joined a full repair that was about to finish, but then its progress
   * would drag the playing full copy back to "Preparing" and its end would
   * put the worse copy back on screen. Recognised by the damage record: a
   * fresh plan sets it back to "repairing" before its instant copy can
   * report, so "recovered" here can only mean the swap already happened.
   */
  private quickSuperseded(target: JobTarget): boolean {
    return (
      target.type === "playback" &&
      target.repair?.quick === true &&
      this.damage.get()[target.mediaId]?.phase === "recovered"
    );
  }

  /**
   * The full repair behind an instant copy finished: swap it in. The media
   * goes ready on the full copy — the scheduler sees a new url and reloads
   * the element at the playhead (see `Scheduler`) — and the damaged part now
   * shows what ffmpeg recovered. The in-band headers rule goes through
   * `publishReady` again (the note minus `quick`), for the file the plan was
   * made against; the instant copy normally taught it already, and the stamp
   * then finds the project saying so. Not when that copy never got published
   * (its own remux failed, or this repair beat it): then it is learned here.
   *
   * Published whatever the status says now: "preparing" on this job (the
   * instant copy failed in the element), or even "failed" (the instant
   * copy's own remux failed). The full copy is the best preview there is.
   * Failed for good (`markFailed`) has already cut this target loose.
   */
  private upgradeDone(target: Extract<JobTarget, { type: "upgrade" }>, path: string, jobId: number): void {
    const id = target.mediaId;
    if (this.upgrades.get(id) === jobId) this.upgrades.delete(id);
    this.elementFailed.delete(id);
    const note = target.repair;
    this.publishReady(
      id,
      path,
      note.damagedUntil === undefined
        ? { dropsHeaders: note.dropsHeaders }
        : { dropsHeaders: note.dropsHeaders, damagedUntil: note.damagedUntil },
      target.file,
    );
    this.setDamagePhase(id, "recovered");
  }

  /**
   * The full repair behind an instant copy failed or was canceled.
   *
   * Canceled under us is someone else's cancel of a job we joined (see
   * `targetFailed`): the repair is asked for again — the instant copy keeps
   * playing, and the backend starts a new full repair. It cannot spin: each
   * round needs a fresh cancel from outside.
   *
   * A real failure keeps the instant copy playing; the damage becomes
   * "unrecovered" (the damaged part stays unreadable). Unless the instant
   * copy had ALSO failed in the element and the media was waiting on this
   * job: then nothing is left, and it fails as an element failure with no
   * repair would — in the element's words, the job's detail after them.
   */
  private upgradeFailed(target: Extract<JobTarget, { type: "upgrade" }>, e: JobFailed): void {
    const id = target.mediaId;
    if (this.upgrades.get(id) === e.id) this.upgrades.delete(id);
    if (e.canceled) {
      const media = this.getProject().media.find((m) => m.id === id);
      if (media !== undefined) void this.requestPlan(media, this.generationOf(id), true, false);
      return;
    }
    const st = this.status.get()[id];
    if (st?.state === "preparing" && st.jobId === e.id) this.patchStatus(id, this.planFailed(id, e.message));
    this.setDamagePhase(id, "unrecovered");
  }

  private targetFailed(target: JobTarget, e: JobFailed): void {
    if (target.type === "upgrade") {
      this.upgradeFailed(target, e);
      return;
    }
    if (this.quickSuperseded(target)) return;
    if (!e.canceled) {
      if (target.type === "playback") {
        this.patchStatus(target.mediaId, this.planFailed(target.mediaId, e.message));
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
    this.elementFailed.delete(mediaId);
    // A retrack for any other reason (a relink, a foreign cancel) is a fresh
    // try of its own, free to heal; `healSiblings` marks its own after this.
    this.healed.delete(mediaId);
    // A relinked file is a different file: its own repair attempt, and no
    // claim that what it will be planned ready on is a repair copy.
    this.repairTried.delete(mediaId);
    this.repairReady.delete(mediaId);
    // Its upgrade's target goes with the rest below; the fresh plan names
    // the full repair again if one is still wanted.
    this.upgrades.delete(mediaId);
    // Nor does it inherit the old file's damaged stream (applyRelink drops
    // the project's record of it too), or the notice that it was damaged.
    // The same file asked about again keeps what was learned of it.
    if (fileChanged) {
      this.dropsLearned.delete(mediaId);
      this.damageNoticed.delete(mediaId);
    }
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
      this.damage.update((d) => withoutKey(d, mediaId));
    }
    const m = this.getProject().media.find((x) => x.id === mediaId);
    if (m) void this.ensure(m);
  }

  /**
   * Stamp a media entry as failed from OUTSIDE the manager — the preview's own
   * <video> reporting that it cannot play what the manager said was ready (a
   * missing or undecodable file the backend classified as directly playable).
   * The scheduler reaches it through `playbackFailed`, which first decides
   * whether the file gets a repair attempt instead.
   *
   * Only the CURRENT identity is stamped. A disposed manager, or an id it does
   * not track (never ensured, or removed from the bin since), is left alone:
   * stamping one would resurrect a status for media nothing can render. The
   * caller still owes its own staleness check — an error from an element that
   * was showing the file BEFORE a relink describes a file the media no longer
   * points at; the scheduler compares the element's URL with the ready state's.
   *
   * The stamp sticks until the media is retracked — a relink, or the same file
   * coming up ready again under another id (`healSiblings`) — or removed: the
   * generation is bumped, so an answer already in flight for this identity — a
   * plan that would say "ready" for a path that is not there, or a thumbnail —
   * is dropped instead of painting over the failure. A playback job already
   * REGISTERED for the id is not cut loose; the intended callers stamp media
   * that is ready, and a ready media has no playback job left to finish. The
   * one job a ready media can still be waiting on — an instant copy's full
   * repair — IS cut loose (`dropUpgrade`), or its end would publish the full
   * copy straight over the stamp. It runs on into the cache.
   */
  markFailed(mediaId: string, message: string): void {
    if (this.disposed || !this.tracked.has(mediaId)) return;
    this.elementFailed.add(mediaId);
    this.bumpGeneration(mediaId);
    this.dropUpgrade(mediaId);
    this.patchStatus(mediaId, { state: "failed", message });
  }

  /** Stop waiting on `mediaId`'s upgrade, if one runs (see `upgrades`). */
  private dropUpgrade(mediaId: string): void {
    const jobId = this.upgrades.get(mediaId);
    if (jobId === undefined) return;
    this.upgrades.delete(mediaId);
    dropJobTarget(this.jobs, jobId, mediaId, "upgrade");
  }

  /**
   * The preview's own <video> could not play `url`, which the manager had
   * published as `mediaId`'s ready state; `code` is its MediaError code. What
   * the scheduler reports instead of calling `markFailed` itself.
   *
   * Ignored exactly where `markFailed` and the scheduler's own check ignore it:
   * a disposed manager, an id not tracked, a media no longer ready, or ready on
   * a different url (an error describing a file the media no longer points at).
   *
   * Otherwise it is usually final (`markFailed`), but not for a decode or
   * not-supported error on a file that has not been repaired yet. Chromium
   * treats ANY decode error as fatal, so one undecodable stretch — a damaged
   * recording's first minute, say — loses the whole file, where ffmpeg
   * conceals the bad frames and decodes the rest. Such a file gets ONE repair
   * attempt per session (`repairTried`): a repair plan, published through the
   * same code `ensure` uses (`requestPlan`), whose ready url is the copy. A
   * failure on the copy itself (`repairReady`), a second failure, or any other
   * code is final as before.
   *
   * The repair is planned under the CURRENT generation; unlike `markFailed`,
   * this does not bump it. A ready media has no plan in flight — ready is
   * published only once its plan has answered — so all a bump could drop is
   * the original ensure's thumbnail or waveform, and those describe this very
   * file and are still wanted: a cold thumbnail can take seconds, where the
   * element refuses a file within a fraction of one. What must not land on
   * the repair bumps on its own: a relink or a foreign cancel (`retrack`), a
   * removal (`untrack`). Nor is the id marked `elementFailed` yet: the media
   * is not failed while its repair runs; a repair that fails is
   * (`planFailed`). The status leaves "ready" at once — the scheduler would
   * otherwise load the dead url again while the plan is asked for — and shows
   * "Preparing" until the plan names its copy or its job.
   *
   * An INSTANT copy refused the same way while its full repair still runs
   * (`upgrades`) is not final either, and needs no new plan: the media shows
   * "Preparing" on that repair's job until it lands (`upgradeDone`) or fails
   * (`upgradeFailed`). Checked before the copy test above, which an instant
   * copy also passes. The element's words are kept (`repairTried`) for a
   * failure of that repair to be reported under.
   */
  playbackFailed(mediaId: string, url: string, code: number, message: string): void {
    if (this.disposed || !this.tracked.has(mediaId)) return;
    const st = this.status.get()[mediaId];
    if (st?.state !== "ready" || st.url !== url) return;
    const media = this.getProject().media.find((m) => m.id === mediaId);
    const refused = code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED;
    const upgrade = this.upgrades.get(mediaId);
    if (media !== undefined && refused && upgrade !== undefined) {
      if (!this.repairTried.has(mediaId)) this.repairTried.set(mediaId, message);
      const ratio = this.damage.get()[mediaId]?.ratio ?? null;
      this.patchStatus(mediaId, { state: "preparing", ratio, jobId: upgrade });
      return;
    }
    if (
      media === undefined ||
      !refused ||
      this.repairReady.has(mediaId) ||
      this.repairTried.has(mediaId)
    ) {
      this.markFailed(mediaId, message);
      return;
    }
    this.repairTried.set(mediaId, message);
    const gen = this.generationOf(mediaId);
    this.patchStatus(mediaId, { state: "preparing", ratio: null, jobId: null });
    void this.requestPlan(media, gen, true, false);
  }

  /**
   * Forget a media item completely: it has left the project.
   *
   * `retrack`'s sibling, and the half that was missing. Removing media from the
   * bin dropped it from the project but not from here, so its id stayed in
   * `tracked` and in the published maps for the rest of the session —
   * every status notification carrying a state for a media nothing can render,
   * and a waveform's peak arrays (the largest thing this class holds) pinned
   * behind an id no clip references. Unlike `retrack` there is nothing to
   * re-ensure afterwards, and the generation bump is what stops a `plan_playback`
   * still in flight from publishing a status for the departed entry. A damage
   * record goes too (the bin and the stage stop saying "Damaged"); the notice
   * that it was damaged is kept, so an undo bringing it back says nothing new.
   */
  untrack(mediaId: string): void {
    this.tracked.delete(mediaId);
    this.withheld.delete(mediaId);
    this.elementFailed.delete(mediaId);
    this.healed.delete(mediaId);
    this.repairTried.delete(mediaId);
    this.repairReady.delete(mediaId);
    this.upgrades.delete(mediaId);
    this.dropsLearned.delete(mediaId);
    dropMediaTargets(this.jobs, mediaId);
    this.bumpGeneration(mediaId);
    this.status.update((s) => withoutKey(s, mediaId));
    this.waveforms.update((w) => withoutKey(w, mediaId));
    this.thumbs.update((t) => withoutKey(t, mediaId));
    this.damage.update((d) => withoutKey(d, mediaId));
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

    // Playback plan. A file an earlier preview found the WebView cannot decode
    // as-is carries `dropInbandHeaders` (stamped from a repair answer), and
    // goes straight to its repair rather than failing in the element first.
    // Every other file asks exactly what it always did.
    await this.requestPlan(media, gen, media.dropInbandHeaders === true, true);
  }

  /**
   * Ask the backend how `media` will be previewed and publish the answer.
   * Split out of `ensure` so a repair attempt (`playbackFailed`) is published
   * by the very same code, and the two can never drift apart.
   *
   * `repair`: ask for the REPAIR copy (`planPlayback`'s `repair`).
   * `heals`: a ready answer may give failed siblings another try
   * (`healSiblings`). `ensure`'s plan does — a flagged media's too, though it
   * names the repair copy: an ensure is a fresh try like any other. A repair
   * ATTEMPT's (`playbackFailed`) never does — its ready answer says the
   * original file could NOT be played as it is, and two entries for one such
   * file, each repaired in turn, would otherwise retrack each other for as
   * long as either copy failed in the element.
   */
  private async requestPlan(media: MediaRef, gen: number, repair: boolean, heals: boolean): Promise<void> {
    try {
      const plan = await ipc.planPlayback(media, codecHints(), settingsStore.get().proxyMedia, repair);
      // Answered after dispose: a pending job is deliberately LEFT RUNNING,
      // not canceled — see `cancelOrphan` for why playback preparation outlives
      // the editor that asked for it — unless the project was discarded, when
      // it is abandoned like the ones `dispose` held. It is registered nowhere,
      // so this is the only chance to. A full repair named as the plan's
      // upgrade is the same kind of job, and goes the same way.
      if (this.disposed) {
        if (this.abandonPlayback && plan.mode === "pending") abandonPlaybackJob(plan.jobId);
        if (this.abandonPlayback && plan.mode !== "direct" && plan.upgrade !== undefined) {
          abandonPlaybackJob(plan.upgrade.jobId);
        }
        return;
      }
      // The one that was actually reachable, if only just: a relink cuts the
      // media loose from its old jobs, but a plan still in flight has not
      // registered one yet, so without this it registers the OLD job after the
      // cut and drags the relinked media back to "Preparing" on a job that will
      // never report to it.
      if (this.overtaken(media.id, gen)) return;
      if (plan.mode === "direct" || plan.mode === "ready") {
        const repair = plan.mode === "ready" ? plan.repair : undefined;
        this.publishReady(media.id, plan.path, repair, keyOf(media));
        if (repair !== undefined) this.noteRepair(media, repair, plan.mode === "ready" ? plan.upgrade : undefined, true);
        // A plan a heal asked for heals nobody back (see `healed`); the mark
        // is spent by any ready answer, a repair's included.
        if (!this.healed.delete(media.id) && heals) this.healSiblings(media);
      } else {
        // A job a discarded project let go of is this media's now: keep its
        // grace timer from canceling what this editor is about to wait on.
        reclaimPlaybackJob(plan.jobId);
        // The note rides on the target so `job:done` publishes a repair copy
        // as one; an ordinary job's target keeps the shape it always had.
        addJobTarget(
          this.jobs,
          plan.jobId,
          plan.repair === undefined
            ? { type: "playback", mediaId: media.id, output: plan.output }
            : { type: "playback", mediaId: media.id, output: plan.output, repair: plan.repair, file: keyOf(media) },
        );
        this.patchStatus(media.id, { state: "preparing", ratio: null, jobId: plan.jobId });
        // Before the claim below: an instant copy that already finished must
        // find its damage record (and its upgrade) in place.
        if (plan.repair !== undefined) this.noteRepair(media, plan.repair, plan.upgrade, false);
        // Last, so a job that already finished lands on top of "Preparing".
        this.claimOrphan(plan.jobId);
      }
    } catch (e) {
      // A failure belonging to the file this ensure started against, reported
      // onto a media entry that has since been relinked or removed, is the same
      // stale write wearing its most alarming face.
      if (this.disposed || this.overtaken(media.id, gen)) return;
      this.patchStatus(media.id, this.planFailed(media.id, describeError(e)));
    }
  }

  /**
   * Publish `mediaId` ready on the file at `path` — the one place a ready
   * state for a file is published, whether a plan named it (`requestPlan`) or
   * a job finished it (`targetDone`, `upgradeDone`).
   *
   * `repair`: the plan or job named a REPAIR copy, so an element failing on
   * it has nothing left to fall back on (`repairReady`) — unless it is an
   * instant copy whose full repair still runs (see `playbackFailed`). When the
   * note says the repair decodes the stream with its in-band headers removed
   * (`dropsHeaders`), the id is learned (`dropsLearned`) for `file`, the file
   * the plan was made against — whether or not the project already says so —
   * and the project is told (`stampDropHeaders`): the export has to decode
   * the file the same way, or it meets the same garbage the WebView did.
   *
   * Learned from an INSTANT copy too, not only when its full repair lands.
   * The backend decides `dropsHeaders` once, before either copy starts, and
   * builds both notes from that one answer, so the instant copy's note says
   * exactly what the full one will. Waiting for the swap left the export
   * decoding the raw garbage for as long as the full repair ran — half a
   * minute here, minutes on a slow PC — and an export started in that window
   * came out rotated and resized: the very frames the repair exists to avoid.
   * It stays right if the full repair then fails: the stream is still the
   * same damaged H.264.
   */
  private publishReady(
    mediaId: string,
    path: string,
    repair: RepairNote | undefined,
    file: MediaKey | undefined,
  ): void {
    this.patchStatus(mediaId, { state: "ready", url: mediaUrl(path), sourcePath: path });
    if (repair === undefined) {
      this.repairReady.delete(mediaId);
      return;
    }
    this.repairReady.add(mediaId);
    if (!repair.dropsHeaders || file === undefined) return;
    this.dropsLearned.set(mediaId, file);
    this.stampDropHeaders(mediaId);
  }

  /**
   * A plan answered with a REPAIR (`repair`): `media` is damaged. Publish what
   * is known of it (`damage`), wait on the full repair behind an instant copy
   * (`upgrade`), and tell the user once (`onDamaged`). `ready`: the plan named
   * a file that plays now, rather than a job still making one.
   *
   * The phase follows from the answer: a running full repair — the upgrade,
   * or a pending plan that IS the full repair — is "repairing"; a ready full
   * copy (cached, typically a flagged media's reopen) is "recovered"; an
   * instant copy with no repair behind it can only be "unrecovered".
   */
  private noteRepair(media: MediaRef, repair: RepairNote, upgrade: UpgradeJob | undefined, ready: boolean): void {
    const quick = repair.quick === true;
    const state: DamageState = {
      until: damagedUntilOf(repair),
      phase: upgrade !== undefined || (!quick && !ready) ? "repairing" : quick ? "unrecovered" : "recovered",
      ratio: null,
    };
    this.setDamage(media.id, state);
    if (upgrade !== undefined) {
      // As for a plan's own job: one a discarded project let go of is ours now.
      reclaimPlaybackJob(upgrade.jobId);
      addJobTarget(this.jobs, upgrade.jobId, {
        type: "upgrade",
        mediaId: media.id,
        output: upgrade.output,
        repair,
        file: keyOf(media),
      });
      this.upgrades.set(media.id, upgrade.jobId);
    }
    if (!this.damageNoticed.has(media.id)) {
      this.damageNoticed.add(media.id);
      this.opts.onDamaged?.(media.id, state, quick);
    }
    // Last, as in `requestPlan`: a full repair that already finished lands
    // on top of everything this answer published.
    if (upgrade !== undefined) this.claimOrphan(upgrade.jobId);
  }

  private setDamage(mediaId: string, state: DamageState): void {
    this.damage.update((d) => ({ ...d, [mediaId]: state }));
  }

  /** Move a damaged media's record to `phase`; a no-op for one without a
   *  record or already there. The ratio only means anything while repairing. */
  private setDamagePhase(mediaId: string, phase: DamageState["phase"]): void {
    const d = this.damage.get()[mediaId];
    if (d === undefined || d.phase === phase) return;
    this.setDamage(mediaId, { until: d.until, phase, ratio: phase === "repairing" ? d.ratio : null });
  }

  /** The running full repair of `mediaId` reported `ratio`. Only a record
   *  still "repairing" takes it; an unchanged ratio notifies nobody. */
  private damageProgress(mediaId: string, ratio: number | null): void {
    const d = this.damage.get()[mediaId];
    if (d === undefined || d.phase !== "repairing" || d.ratio === ratio) return;
    this.setDamage(mediaId, { until: d.until, phase: d.phase, ratio });
  }

  /**
   * Tell the project (`onDropHeaders`) that `mediaId`'s file drops its
   * in-band headers, unless its media has left, already says so, or no
   * longer points at the file this was learned for (see `dropsLearned`).
   * Looked up in the project as it is NOW — a job finishes long after the plan
   * that started it, and a stamp made earlier in the same loop changes it.
   */
  private stampDropHeaders(mediaId: string): void {
    const notify = this.opts.onDropHeaders;
    const file = this.dropsLearned.get(mediaId);
    if (notify === undefined || file === undefined) return;
    const m = this.getProject().media.find((x) => x.id === mediaId);
    if (m === undefined || m.dropInbandHeaders === true) return;
    if (m.path !== file.path || m.size !== file.size || m.mtimeMs !== file.mtimeMs) return;
    notify(mediaId);
  }

  /**
   * The project changed (`watchProject`): put the record back on every
   * learned id whose media lost it — an undo or redo to a project from before
   * the stamp, a cancelled canvas drag putting back where it started. Nothing
   * learned is the normal case and costs this one size check. It cannot loop:
   * the stamp's own change finds the record there.
   */
  private restampDropHeaders(): void {
    if (this.dropsLearned.size === 0 || this.disposed) return;
    for (const id of this.dropsLearned.keys()) this.stampDropHeaders(id);
  }

  /**
   * The status for a playback plan or job that failed with `detail`: the
   * detail, as it always was — unless what failed is this id's repair attempt
   * (`repairTried`), which is reported in the element's own words with the
   * detail after them. Both a plan's rejection and a job's failure land here.
   *
   * A failed repair attempt also marks the id `elementFailed`, as the
   * element's failure would have been marked had there been no repair to try
   * (`markFailed`): it is what lets a re-import or Replace media of the same
   * file heal the entry (`healSiblings`). An element error before metadata —
   * a missing file, one still being copied — is code 4, so that transient
   * case comes this way now. An ordinary plan or job failure is not the
   * element's, and stays unmarked as before. Both callers have already
   * dropped a disposed or overtaken answer, so only the current identity is
   * marked.
   */
  private planFailed(mediaId: string, detail: string): MediaState {
    const asked = this.repairTried.get(mediaId);
    if (asked === undefined) return { state: "failed", message: detail };
    this.elementFailed.add(mediaId);
    return { state: "failed", message: repairFailedText(asked, detail) };
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
   * A DISCARDED project (`dispose({ abandonPlayback: true })`) does not leave
   * its remuxes and proxies to run forever either — opening one file after
   * another would queue one transcode per file on the single transcode worker
   * ahead of the one the user is looking at. They are not canceled HERE,
   * though: the next screen is often showing the same file (an untouched
   * temporary project is discarded without a question), so they are handed to
   * `abandonPlaybackJob`, which cancels them only if no new editor joins them
   * within its grace window.
   *
   * A successor that had ALREADY joined the job hears it canceled and asks
   * again (`targetFailed`); the backend never hands a canceled job to a fresh
   * request. Best-effort — a job that finished in the meantime simply isn't
   * there to cancel.
   */
  private cancelOrphan(jobId: number): void {
    void ipc.cancelJob(jobId).catch(() => {});
  }

  /**
   * The file behind `media` was just planned ready: give every OTHER entry for
   * the same path that the preview's element had failed (`elementFailed`)
   * another try.
   *
   * Nothing else could. The stamp is cleared only by `retrack`, which only the
   * relink dialog calls, and that dialog opens at load for files reported
   * missing — so an element failure mid-session (a file still being copied, a
   * USB stick unplugged for a moment) failed the media until the project was
   * reopened, its audio-track clips silent with it. The way the Failed badge
   * invites — re-import the file, or Replace media with it — is exactly what
   * lands here, and now heals the old entry too.
   *
   * ONE try per heal. A file that really cannot be played fails again on its
   * next load, and the entry healed here must not heal in turn when its own
   * plan comes back ready: with two entries for that file on stage at once,
   * each one's ready plan retracked the other after the element had failed
   * it, and the pair re-planned each other without end. So the ids retracked
   * here are marked (`healed`) and their next ready plan skips this. Only an
   * ensure's plan nobody healed heals — an import, Replace media, a relink,
   * and a flagged media's plan straight onto its repair copy alike. A repair
   * ATTEMPT's answer never does (see `requestPlan`). An entry whose repair
   * attempt failed is marked like any element failure (`planFailed`), so a
   * re-import heals it too, on the same terms: the retrack gives it one more
   * repair attempt should the element refuse it again, and nothing further
   * until another fresh plan comes up ready.
   */
  private healSiblings(media: MediaRef): void {
    if (this.elementFailed.size === 0) return;
    for (const m of this.getProject().media) {
      if (m.id !== media.id && m.path === media.path && this.elementFailed.has(m.id)) {
        this.retrack(m.id);
        // After the retrack, which clears the mark for every other caller.
        this.healed.add(m.id);
      }
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
   * `abandonPlayback` (see `abandonsPlayback` for when): the project will
   * never be opened again (a discarded temporary project), so its playback
   * preparation is abandoned — every job it holds here, and in `ensure` a plan
   * that answers late. Abandoned is not canceled yet: `abandonPlaybackJob`
   * gives the next editor a window to join the job before it goes. Left unset,
   * remuxes and proxies run on into the cache for the next open (see
   * `cancelOrphan`). Another consumer riding on a canceled job hears the cancel
   * and plans again (`targetFailed`), so canceling a shared job cannot strand
   * it.
   */
  dispose(opts?: { abandonPlayback?: boolean }): void {
    this.disposed = true;
    if (opts?.abandonPlayback === true) this.abandonPlayback = true;
    this.unlisten?.();
    this.unlisten = null;
    this.unwatchProject?.();
    this.unwatchProject = null;
    this.dropsLearned.clear();
    // A coalesced trim must not be lost just because the editor closed inside
    // the collection window — that is how a cache quietly grows past its cap.
    // getProject() is still valid here: the editor disposes this manager before
    // it tears the session down.
    if (this.cacheTimer !== null) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
      this.runEnforceCache();
    }
    // Waveform scans are canceled now; remuxes and proxies run on into the
    // cache for the next open to rejoin or find (see `cancelOrphan`) — or,
    // for a discarded project, are abandoned to the grace timer. A job id never
    // mixes lanes (the two write different outputs), but the test is per
    // waiter all the same: a job any playback waiter rides on is never
    // canceled outright.
    for (const [id, entry] of this.jobs) {
      if (Array.isArray(entry) ? entry.every(isWaveform) : isWaveform(entry)) this.cancelOrphan(id);
      else if (this.abandonPlayback) abandonPlaybackJob(id);
    }
    this.jobs.clear();
    this.upgrades.clear();
    this.orphans.clear();
    this.withheld.clear();
  }
}
