// Resolves a file for display in the viewer: stills straight to an <img>,
// video/audio through probe → classify → direct / remux / "Prepare preview".
// One subscription to job events for the loader's whole life.
//
// WHY STILLS NEVER PROBE: the <img> shows a still exactly as the editor
// preview does (same engine — Chromium applies EXIF orientation where it
// applies it at all, GIF animates natively). The per-file orientation rule
// lives in the backend for export and thumbnails; the viewer has nothing to
// fix and must not try.
//
// WHY VIDEO/AUDIO ALWAYS PROBE: a raw file is never assumed to play (G16). The
// probe feeds `classifyPlayback`, a pure backend decision derived from the same
// table `planPlayback` acts on, so the viewer can say "direct", start a quick
// remux, or wait for the user's "Prepare preview" without ever starting a job
// it did not mean to.
//
// WHY A DAMAGED VIDEO IS REPAIRED UNASKED: the probe cannot see a damaged
// stream (a recording whose first minute is garbage NALs still probes as clean
// H.264), so the first sign is the WebView refusing it — and Chromium stops the
// whole file at the first undecodable frame, so without a repair the user sees
// nothing at all. A proxy-class file is a format the user can choose to wait
// on; a refused file has no other way to be shown, so its repair is planned at
// once (owner decision). Where the backend's scan finds a damaged PREFIX, the
// plan names an INSTANT copy — a lossless stream copy whose video starts at the
// first sound keyframe and whose audio is whole — that plays at once, and the
// full repair runs behind it as the plan's `upgrade`; its job:done swaps the
// full copy in, which shows ffmpeg's concealed picture for the damaged part
// where the instant copy has none. The user is told the file is damaged at
// every step (`damage` on ready, `damaged` on preparing).

import {
  codecHints,
  describeError,
  ipc,
  mediaUrl,
  onJobEvents,
  type JobDone,
  type JobFailed,
  type JobProgress,
  type PlaybackClass,
  type PlaybackPlan,
  type RepairNote,
  type UpgradeJob,
} from "../core/ipc";
import { fileExt } from "../core/format";
import { settingsStore } from "../core/session";
import { mediaFamilyOf, type MediaInfo, type MediaRef } from "../core/types";
import type { ViewElement } from "./stepper";

/** What the user is told about a damaged video on screen: the top-bar pill,
 *  the shaded seek range, and the cover over the instant copy's unreadable
 *  part. */
export interface Damage {
  /** SOURCE seconds from 0 that could not be read (`RepairNote.damagedUntil`);
   *  null when the repair named no damaged prefix. Kept after recovery: the
   *  range is still the damaged one, only now shown as ffmpeg recovered it. */
  until: number | null;
  /** `repairing`: the instant copy plays while the full repair runs behind it.
   *  `recovered`: a full repair copy is on screen. `unrecovered`: the instant
   *  copy plays and no full repair will replace it (it failed). */
  phase: "repairing" | "recovered" | "unrecovered";
  /** The full repair's progress while `repairing`; null when not yet known,
   *  and in every other phase. */
  ratio: number | null;
}

export type LoadState =
  | { state: "loading" }
  | {
      state: "ready";
      element: ViewElement;
      url: string;
      kind: "image" | "video" | "audio";
      /** container-only DIRECT attempt: the viewer must call playbackFailed() on a media `error`
       *  or when `loadedmetadata` has not fired within DIRECT_TIMEOUT_MS */
      tryingDirect: boolean;
      /** Only for a video repaired because the WebView refused it. Re-emitted with the SAME
       *  url when only the full repair's progress or phase changes — and only when the
       *  rounded percent or the phase does; a DIFFERENT url on the same load means the full
       *  repair replaced the instant copy (the viewer swaps it in where playback was). */
      damage?: Damage;
    }
  /** `damaged`: the job is a repair of a video the WebView refused — the user is told so
   *  while it runs, not only once it plays. `quick` (with `damaged`): what runs is the
   *  instant copy's own job, a stream copy that plays the moment it lands — never a
   *  percent then (`ratio` null): its progress is not the repair's, and the repair's own
   *  percent starts from 0 once that copy plays, so showing it would go backwards. */
  | { state: "preparing"; ratio: number | null; damaged?: true; quick?: true }
  | { state: "needsPrepare" }
  | { state: "failed"; message: string };

export const DIRECT_TIMEOUT_MS = 4000;

export interface SourceLoader {
  /** Resolve `path` for display; supersedes the previous load. Previous pending jobs are
   *  canceled (ipc.cancelJob) even if handOff() ran for them: a load on a live loader means
   *  the editor never got them. Only dispose() honours a hand-off. */
  load(path: string): void;
  /** The user pressed "Prepare preview" (only meaningful in state needsPrepare: a
   *  proxy-class file). */
  prepare(): void;
  /** The <video> this load handed out failed: `code` is its MediaError code, null for the
   *  container-only attempt's DIRECT_TIMEOUT_MS. A container-only attempt → plan a remux,
   *  whatever the code. A settled video the WebView could not decode (3) or would not take
   *  (4), from the file itself or a remux, with no repair tried yet → the repair is planned
   *  at once ("preparing", damaged). The instant copy refused → wait for the full repair
   *  behind it. Anything else → failed. Ignored while no video of this load is out. */
  playbackFailed(code: number | null): void;
  /** Open-as-project hand-off. Keeps the current pending jobs — the job the load waits on,
   *  the full repair behind an instant copy, and any job this same load starts afterwards —
   *  ONLY if classifyPlayback(media, hints, settings.proxyMedia) equals the class the viewer
   *  planned (the editor will then join the same Inflight jobs); otherwise cancels them,
   *  emitting nothing. One classify per load; repeat calls share it — until a refusal
   *  starts the repair: that withdraws the promise (a repair started then is the viewer's
   *  to cancel), and a hand-off asked for after it decides afresh. */
  handOff(): Promise<void>;
  debug(): { loads: number; lastClass: PlaybackClass | null; jobId: number | null };
  dispose(): void;
}

/** The MediaRef id the viewer's one media file travels under. Nothing keys on
 *  it — the backend's cache keys are {path, size, mtimeMs} — but MediaRef
 *  requires one. */
const VIEWER_MEDIA_ID = "viewer";

/** Terminal job events that named no job we were waiting on, kept briefly. See
 *  `orphans` below for why. Tiny on purpose: it only has to bridge the gap
 *  between one plan being issued and its answer arriving. */
const ORPHAN_KEEP = 4;

/** Where the current load is resting. Gates `prepare()` / `playbackFailed()`
 *  so a second press, or a stale call from a file the user already stepped
 *  past, starts nothing. */
type Phase =
  | "loading" //      probing / classifying, or a still (which never leaves it)
  | "tryingDirect" // container-only file handed to the element as-is
  | "needsPrepare" // proxy-class, waiting for the user
  | "planning" //     planPlayback in flight
  | "preparing" //    a job is running for this file, nothing on screen
  | "settled"; //     a video on screen (from a plan / a job), or failed

/** What the video a load put on screen was made from. Only a refusal of the
 *  file itself or of a stream-copy remux says the STREAM is damaged; a proxy
 *  or a full repair is ffmpeg's own encode, and the WebView refusing one of
 *  those is not something another copy would fix. `quick`: the instant copy of
 *  a damaged file — still the damaged stream (from its first sound keyframe),
 *  so a refusal of it waits for the full repair instead. */
type Source = "direct" | "remux" | "proxy" | "repair" | "quick";

/** What the pending job's end means. `prep`: the copy the load waits on (a
 *  remux, a proxy, or a full repair with nothing shown before it). `quick`: the
 *  instant copy of a damaged file, with the full repair `queued` behind it.
 *  `upgrade`: that full repair, followed once the instant copy plays — its
 *  progress and its end are the damage's, never a "preparing". */
type JobKind = "prep" | "quick" | "upgrade";

/** MediaError.MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED: the codes a
 *  damaged stream earns. Spelled out because the node test environment has no
 *  MediaError. A network error (2) is a file that went away, not one to repair. */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** DEV-only E2E knob (S19): treat `prepared` and `repaired` as false, because
 *  the cache persists across runs and would otherwise turn "Prepare preview"
 *  into an instant ready — and a damaged file straight into its repair copy —
 *  from the second run on. The viewer owns the object; the loader only reads
 *  it. `import.meta.env.DEV` first so a release build drops the whole lookup. */
function forceUnprepared(): boolean {
  return (
    import.meta.env.DEV &&
    (globalThis as { __tarotingViewerDev?: { forceUnprepared?: unknown } }).__tarotingViewerDev
      ?.forceUnprepared === true
  );
}

/** The damaged prefix a repair note names, when it is a usable number. The
 *  note is backend data, but a NaN or a negative here would paint a cover over
 *  the whole file or none of it, so only a positive finite one counts. */
function untilOf(note: RepairNote | undefined): number | null {
  const u = note?.damagedUntil;
  return typeof u === "number" && Number.isFinite(u) && u > 0 ? u : null;
}

/** The whole percent a ratio reads as (null: unknown) — the grain a damage
 *  update is emitted at. */
function percentOf(r: number | null): number | null {
  if (r === null || !Number.isFinite(r)) return null;
  return Math.round(Math.min(Math.max(r, 0), 1) * 100);
}

/** What a damage report says to the user: two reports with the same key read
 *  the same, so the second is never emitted. */
const said = (d: Damage | null): string => (d === null ? "" : `${d.phase} ${String(percentOf(d.ratio))}`);

type Orphan = { id: number; done: JobDone } | { id: number; failed: JobFailed };

export function createSourceLoader(onState: (path: string, s: LoadState) => void): SourceLoader {
  /** Bumped by every load(): each async continuation captures it and drops
   *  whatever it learned once it no longer matches (G9). */
  let gen = 0;
  let loads = 0;
  let disposed = false;
  let path = "";
  let phase: Phase = "loading";
  /** The probed file behind the current load (null for stills / before the probe). */
  let media: MediaRef | null = null;
  let kind: "video" | "audio" = "video";
  let lastClass: PlaybackClass | null = null;
  /** The pending job the CURRENT load follows. Every cancel this loader issues
   *  nulls it FIRST, so a canceled event that still matches it is by definition
   *  somebody else's — the one case that earns a re-plan. */
  let jobId: number | null = null;
  /** What the pending job writes; the done event normally names it too. */
  let jobOutput = "";
  /** The pending job was planned as a repair: its done event shows a repair,
   *  and a foreign cancel re-plans a repair (the plain plan writes elsewhere). */
  let jobRepair = false;
  let jobKind: JobKind = "prep";
  /** The full repair behind the instant copy whose job (`jobId`, kind `quick`)
   *  is still running. Both are live at once, so both are released together. */
  let queued: UpgradeJob | null = null;
  /** What the video on screen for this load came from; null while none is
   *  (loading, preparing, failed). Decides what a playback failure earns. */
  let shownFrom: Source | null = null;
  /** The url of the video on screen, re-emitted when only its damage changes. */
  let shownUrl = "";
  /** The current load already planned a repair: a refusal of the file (or its
   *  remux) after that fails, never repairs again. */
  let repairTried = false;
  /** What this load tells the user about a damaged file; null for a healthy one. */
  let damage: Damage | null = null;
  /** `said(damage)` as the last ready carried it, so a stream of progress
   *  events at one percentage emits nothing. */
  let damageSaid = "";
  /** The instant copy was refused: an answer naming it again is not shown, the
   *  load waits for the full repair instead. */
  let quickRefused = false;
  /** A re-plan is in flight that keeps the instant copy on screen (its full
   *  repair was canceled under us); a refusal meanwhile lets its answer decide. */
  let quietPlan = false;
  /** Jobs handOff() decided the editor will join: dispose() leaves them running. */
  const handedOff = new Set<number>();
  /** The load (gen) handOff() last ran for, the editor's class for that file
   *  (null until known, or when its classify failed), and the one decision
   *  every call for that load shares. Recorded even when no job exists yet: the
   *  4 s direct timeout or a "Prepare preview" press can start one WHILE the
   *  project opens, and the editor joins that job just the same. Reset to -1
   *  when a refusal starts the repair (see playbackFailed). */
  let handOffGen = -1;
  let handOffClass: PlaybackClass | null = null;
  let handOffStep: Promise<void> = Promise.resolve();
  /** The job-event subscription failed: a job we start could never be followed. */
  let listenFailed = false;
  /** The current load already re-planned once after a foreign cancel. */
  let replanned = false;
  /** The step the current load is working through (probe → classify → plan,
   *  or a plan started by prepare()/playbackFailed()/a re-plan). handOff() waits
   *  on it so a plan still in flight has its job id before the hand-off
   *  decides what to keep. Never rejects. */
  let pipeline: Promise<void> = Promise.resolve();

  /**
   * Terminal events for job ids nobody here is waiting on — yet. Tauri events
   * and invoke answers travel separate channels, so a stream-copy remux of a
   * small file can report `job:done` BEFORE `planPlayback`'s `pending` answer
   * naming that job reaches us; dropped, it would leave the viewer on
   * "Preparing" forever. The full repair behind an instant copy is followed
   * only once that copy lands, so its end can wait here too. Consulted exactly
   * once, for an id a plan just named. Stale ids never come back from a plan
   * (the backend never hands out a canceled job, and a finished one answers
   * `ready`), so everything else in here simply ages out — "events for a stale
   * job are ignored" holds.
   */
  const orphans: Orphan[] = [];
  function keepOrphan(o: Orphan): void {
    orphans.push(o);
    if (orphans.length > ORPHAN_KEEP) orphans.shift();
  }
  /** Run the terminal event `id` reported before we knew to wait for it. */
  function replayOrphan(id: number): void {
    const i = orphans.findIndex((o) => o.id === id);
    if (i < 0) return;
    const o = orphans.splice(i, 1)[0]!;
    if ("done" in o) onDone(o.done);
    else onFailed(o.failed);
  }

  const live = (g: number): boolean => !disposed && g === gen;
  const emit = (s: LoadState): void => onState(path, s);

  function cancel(id: number): void {
    // Best-effort: a job that finished meanwhile simply isn't there.
    void ipc.cancelJob(id).catch(() => {});
  }

  /** handOff() found the editor prepares what load `g` (planned as `cls`) does. */
  const promised = (g: number, cls: PlaybackClass | null): boolean =>
    handOffGen === g && handOffClass !== null && handOffClass === cls;

  /** Drop the current jobs, canceling each unless `honourHandOff` and the
   *  editor was promised it. Only dispose() honours the promise: a load() on a
   *  live loader means the open never reached the editor (it failed, or an
   *  Explorer open superseded it), so a transcode kept for it would run for
   *  nobody. */
  function releaseJob(honourHandOff: boolean): void {
    const ids: number[] = [];
    if (jobId !== null) ids.push(jobId);
    if (queued !== null) ids.push(queued.jobId);
    // Before the cancels: our own canceled events must not match.
    jobId = null;
    queued = null;
    jobKind = "prep";
    for (const j of ids) if (!honourHandOff || !handedOff.has(j)) cancel(j);
  }

  /** A job a plan named that this load will not follow: cancel it — unless the
   *  current load is riding it (a quick step away and back onto the same file
   *  rejoins it), or the viewer closed INTO the editor, which joins it: still
   *  on load `g` (g === gen) with the hand-off agreed. */
  function discard(g: number, id: number, cls: PlaybackClass | null): void {
    if (id === jobId || id === queued?.jobId || handedOff.has(id) || (g === gen && promised(g, cls))) return;
    cancel(id);
  }

  /** Every job a plan answer named, discarded (a superseded answer). */
  function discardPlan(g: number, p: PlaybackPlan, cls: PlaybackClass | null): void {
    if (p.mode === "direct") return;
    if (p.mode === "pending") discard(g, p.jobId, cls);
    if (p.upgrade) discard(g, p.upgrade.jobId, cls);
  }

  function fail(message: string): void {
    // A failed load reads nothing more: a full repair still queued or running
    // behind it would run for nobody.
    releaseJob(false);
    phase = "settled";
    shownFrom = null;
    emit({ state: "failed", message });
  }

  function readyVideo(url: string, tryingDirect: boolean, from: Source): void {
    shownFrom = from;
    shownUrl = url;
    damageSaid = said(damage);
    emit(
      damage === null
        ? { state: "ready", element: "video", url, kind, tryingDirect }
        : { state: "ready", element: "video", url, kind, tryingDirect, damage: { ...damage } },
    );
  }

  /** The damage of the video on screen changed: tell the viewer — same url,
   *  so it repaints its indicators and leaves the element alone — but only
   *  when what the user reads changes. */
  function retell(): void {
    if (shownFrom === null || said(damage) === damageSaid) return;
    readyVideo(shownUrl, false, shownFrom);
  }

  function preparing(ratio: number | null): void {
    if (jobKind === "quick") {
      // The instant copy is being made: "preparing", no percent (see LoadState).
      emit({ state: "preparing", ratio: null, damaged: true, quick: true });
      return;
    }
    emit(repairTried || jobRepair ? { state: "preparing", ratio, damaged: true } : { state: "preparing", ratio });
  }

  /** What a plan's or a job's output is, for the class the load planned. */
  function planned(repair: boolean): Source {
    if (repair) return "repair";
    return lastClass === "proxy" ? "proxy" : "remux";
  }

  function trimCache(): void {
    // A new file just landed in the cache: trim it back under the cap, never
    // evicting what is on screen (G17) — the key keeps every copy of this
    // file, the instant one and the full repair alike. Same call the editor
    // makes on done.
    const m = media;
    if (m === null) return;
    const key = { path: m.path, size: m.size, mtimeMs: m.mtimeMs };
    void ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, [key]).catch(() => {});
  }

  /** Follow `up`, the full repair behind the instant copy: from now on its
   *  progress and its end are the damage's. Its progress starts unknown: an
   *  earlier job's percent (one canceled under us) says nothing about it. */
  function adopt(up: UpgradeJob): void {
    jobId = up.jobId;
    jobOutput = up.output;
    jobRepair = true;
    jobKind = "upgrade";
    damage = { until: damage?.until ?? null, phase: "repairing", ratio: null };
  }

  /** The instant copy at `p` exists: play it, and follow the full repair `up`
   *  behind it (none: it will stay the instant copy). */
  function landQuick(p: string, up: UpgradeJob | null): void {
    if (up !== null) adopt(up);
    else damage = { until: damage?.until ?? null, phase: "unrecovered", ratio: null };
    if (quickRefused) {
      // The WebView already refused this copy on this load (an answer after a
      // re-plan names it again): wait for the full repair rather than show it.
      if (up === null) {
        fail("");
        return;
      }
      phase = "preparing";
      preparing(damage?.ratio ?? null);
    } else {
      phase = "settled";
      readyVideo(mediaUrl(p), false, "quick");
    }
    if (up !== null) replayOrphan(up.jobId);
  }

  /* ---- job events: ONE subscription, before any plan can be issued (G11) ---- */

  function onProgress(e: JobProgress): void {
    if (disposed || e.id !== jobId) return;
    // The instant copy's own job: the card already says "preparing", and its
    // percent is not one the user is shown.
    if (jobKind === "quick") return;
    if (jobKind !== "upgrade") {
      preparing(e.ratio);
      return;
    }
    damage = { until: damage?.until ?? null, phase: "repairing", ratio: e.ratio };
    if (shownFrom !== null) retell();
    // The instant copy was refused: the full repair is what the card waits on.
    else if (phase === "preparing") preparing(e.ratio);
  }

  function onDone(e: JobDone): void {
    if (disposed) return;
    if (e.id !== jobId) {
      keepOrphan({ id: e.id, done: e });
      return;
    }
    const k = jobKind;
    const out = String(e.output.path ?? jobOutput);
    jobId = null;
    jobKind = "prep";
    if (k === "quick") {
      const up = queued;
      queued = null;
      landQuick(out, up);
    } else {
      // A full repair landed — behind an instant copy (the viewer swaps it in
      // where playback is) or with nothing shown before it.
      if (jobRepair) damage = { until: damage?.until ?? null, phase: "recovered", ratio: null };
      phase = "settled";
      readyVideo(mediaUrl(out), false, planned(jobRepair));
    }
    trimCache();
  }

  function onFailed(e: JobFailed): void {
    if (disposed) return;
    if (e.id !== jobId) {
      keepOrphan({ id: e.id, failed: e });
      return;
    }
    const k = jobKind;
    jobId = null;
    jobKind = "prep";
    if (e.canceled && !replanned) {
      // CANCELED UNDER US — by another consumer of the same output (the
      // backend shares one job per output path), or by our own cancel of an
      // earlier visit to this file that the fresh plan rejoined before the
      // cancel landed. Ask once more: the backend never hands a canceled job
      // to a fresh request. Once only, so a second cancel cannot loop. The
      // same kind of plan: a repair asked again as a plain plan would answer
      // with the very copy the WebView already refused. A full repair canceled
      // behind the instant copy on screen is asked for again WITHOUT taking
      // that copy down.
      replanned = true;
      pipeline = plan(gen, jobRepair, k === "upgrade" && shownFrom === "quick");
      return;
    }
    if (k === "upgrade" && shownFrom === "quick") {
      // The instant copy keeps playing; its damaged part stays covered.
      damage = { until: damage?.until ?? null, phase: "unrecovered", ratio: null };
      retell();
      return;
    }
    if (k === "quick" && queued !== null) {
      // The instant copy could not be made; the full repair behind it still
      // can be, and it is what the user waits on now.
      const up = queued;
      queued = null;
      adopt(up);
      phase = "preparing";
      preparing(damage?.ratio ?? null);
      replayOrphan(up.jobId);
      return;
    }
    fail(e.message);
  }

  let unlisten: (() => void) | null = null;
  const listening: Promise<void> = onJobEvents({ onProgress, onDone, onFailed }).then(
    (un) => {
      // Registration is async, so dispose() can land BEFORE the listener
      // exists; it had nothing to call, so hand the unlisten back here.
      if (disposed) un();
      else unlisten = un;
    },
    // No events will ever arrive. Carry on: direct files still play, and the
    // alternative (refusing every load) strands the viewer entirely. A job
    // would sit on "Preparing" forever, so plan() refuses those instead.
    () => {
      listenFailed = true;
    },
  );

  /* ---- planning ---- */

  /** The answer to a re-plan made with the instant copy on screen (its full
   *  repair was canceled under us): keep that copy up, follow whatever full
   *  repair the answer names, and never put a "preparing" over a playing
   *  video. */
  function settleQuiet(g: number, p: PlaybackPlan, cls: PlaybackClass | null): void {
    if (p.mode === "ready" && p.repair?.quick !== true && p.upgrade === undefined) {
      // The full repair finished meanwhile: swap it in.
      damage = { until: untilOf(p.repair) ?? damage?.until ?? null, phase: "recovered", ratio: null };
      readyVideo(mediaUrl(p.path), false, "repair");
      return;
    }
    // The full repair to follow: a plan's `upgrade`, or a pending job that is
    // itself the full repair. Another instant copy is not needed — one plays.
    let up: UpgradeJob | null = p.mode === "direct" ? null : (p.upgrade ?? null);
    if (p.mode === "pending") {
      if (up === null && p.repair?.quick !== true) up = { jobId: p.jobId, output: p.output };
      if (up?.jobId !== p.jobId) discard(g, p.jobId, cls);
    }
    if (up === null) {
      damage = { until: damage?.until ?? null, phase: "unrecovered", ratio: null };
      retell();
      return;
    }
    if (promised(g, cls)) handedOff.add(up.jobId);
    adopt(up);
    retell();
    replayOrphan(up.jobId);
  }

  /** planPlayback for the current file, never forcing a proxy (4K plays direct
   *  in the viewer — owner decision). `repair`: plan the repair of a file the
   *  WebView refused instead. `keepShown`: the instant copy is on screen and
   *  stays there (see settleQuiet). Never rejects. */
  async function plan(g: number, repair = false, keepShown = false): Promise<void> {
    const m = media;
    if (m === null) return;
    const cls = lastClass;
    if (keepShown) quietPlan = true;
    else phase = "planning";
    if (repair) repairTried = true;
    // A job can finish in milliseconds; its events must have somewhere to go.
    await listening;
    if (!live(g)) return;
    let p: PlaybackPlan;
    try {
      p = await ipc.planPlayback(m, codecHints(), false, repair);
    } catch (e) {
      if (!live(g)) return;
      quietPlan = false;
      if (keepShown && shownFrom === "quick") {
        // The instant copy still plays; only its upgrade is lost.
        damage = { until: damage?.until ?? null, phase: "unrecovered", ratio: null };
        retell();
        return;
      }
      fail(describeError(e));
      return;
    }
    if (!live(g)) {
      // Superseded while the backend started jobs for us: nobody will ever
      // read them (G17) — unless discard() finds them still wanted.
      discardPlan(g, p, cls);
      return;
    }
    quietPlan = false;
    // Asked with the instant copy up, and it still is (a refusal meanwhile
    // turns this into an ordinary answer, read with `quickRefused` set).
    if (keepShown && shownFrom === "quick") {
      settleQuiet(g, p, cls);
      return;
    }
    const up = p.mode === "direct" ? null : (p.upgrade ?? null);
    // A full repair queued behind an earlier answer's instant copy is let go
    // unless this answer names it again (the backend shares one job per output).
    const prev = queued;
    queued = null;
    if (prev !== null && prev.jobId !== up?.jobId && !handedOff.has(prev.jobId)) cancel(prev.jobId);
    if (p.mode === "direct") {
      // The backend plays the file as it is: nothing repaired to report.
      damage = null;
      phase = "settled";
      readyVideo(mediaUrl(p.path), false, "direct");
      return;
    }
    // A repair either way: asked for, or named by the backend's note.
    const isRepair = repair || p.repair !== undefined || up !== null;
    // The instant copy: a stream copy that plays at once, a full repair behind it.
    const instant = p.repair?.quick === true || up !== null;
    if (isRepair) {
      damage = {
        until: untilOf(p.repair),
        phase: instant ? (up !== null ? "repairing" : "unrecovered") : p.mode === "ready" ? "recovered" : "repairing",
        ratio: null,
      };
    }
    // Started after handOff() already agreed with the editor for this load:
    // the editor's own plan joins these jobs too.
    if (promised(g, cls)) {
      if (p.mode === "pending") handedOff.add(p.jobId);
      if (up !== null) handedOff.add(up.jobId);
    }
    if (p.mode === "ready") {
      if (!instant) {
        phase = "settled";
        readyVideo(mediaUrl(p.path), false, planned(isRepair));
        return;
      }
      if (up !== null && listenFailed) {
        // Its progress and its end would never reach us: the instant copy
        // plays, and stays the instant copy.
        cancel(up.jobId);
        landQuick(p.path, null);
        return;
      }
      landQuick(p.path, up);
      return;
    }
    if (listenFailed) {
      // Its progress and its end would never reach us.
      cancel(p.jobId);
      if (up !== null) cancel(up.jobId);
      fail("Couldn't follow the preview preparation");
      return;
    }
    jobId = p.jobId;
    jobOutput = p.output;
    jobRepair = isRepair;
    jobKind = instant ? "quick" : "prep";
    queued = instant ? up : null;
    phase = "preparing";
    preparing(null);
    replayOrphan(p.jobId);
  }

  /** probe → classify → act. Never rejects. */
  async function resolveMedia(g: number, p: string): Promise<void> {
    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(p);
    } catch (e) {
      if (live(g)) fail(describeError(e));
      return;
    }
    if (!live(g)) return;
    const m: MediaRef = { ...info, id: VIEWER_MEDIA_ID };
    media = m;
    kind = info.kind === "audio" ? "audio" : "video";
    let cls: PlaybackClass;
    let prepared: boolean;
    let repaired: boolean;
    try {
      const c = await ipc.classifyPlayback(m, codecHints(), false);
      cls = c.class;
      prepared = c.prepared === true;
      repaired = c.repaired === true;
    } catch (e) {
      if (live(g)) fail(describeError(e));
      return;
    }
    if (!live(g)) return;
    lastClass = cls;
    // Before `prepared`: a container-only or remux file can have both a cached
    // remux and a cached repair, and the repair exists because the remux was
    // refused. Not a proxy: its preview is already ffmpeg's own encode, never
    // repaired here.
    if (
      repaired &&
      (cls === "direct" || cls === "containerOnly" || cls === "remux") &&
      !forceUnprepared()
    ) {
      // An earlier visit found this exact file undecodable and a repair of it
      // is cached: planning it answers at once (with whatever copy and upgrade
      // the backend has), while trying the file (or its remux) again would
      // only be refused the same way first.
      await plan(g, true);
      return;
    }
    if (prepared && !forceUnprepared()) {
      // A remux/proxy of this exact file is cached: planning answers `ready`
      // without starting anything.
      await plan(g);
      return;
    }
    switch (cls) {
      case "direct":
        phase = "settled";
        readyVideo(mediaUrl(p), false, "direct");
        return;
      case "containerOnly":
        // Only the container is wrong; WebView2 often plays it anyway (mov
        // H.264/AAC). Try the file itself; the viewer reports a refusal.
        phase = "tryingDirect";
        readyVideo(mediaUrl(p), true, "direct");
        return;
      case "remux":
        // "Auto-remux when quick": a stream copy, audio re-encoded at most.
        await plan(g);
        return;
      case "proxy":
        // A real transcode of a file that is not damaged, just in a format
        // the WebView does not play: nothing starts until the user asks.
        phase = "needsPrepare";
        emit({ state: "needsPrepare" });
        return;
    }
  }

  /** The one hand-off decision for load `g`. Never rejects. */
  async function decideHandOff(g: number): Promise<void> {
    // Let a probe/classify/plan still in flight finish, so a job it is about
    // to start is known before deciding; otherwise dispose() would cancel
    // the job the editor is about to join. Re-read: a re-plan may replace it.
    let step: Promise<void>;
    do {
      step = pipeline;
      await step;
    } while (step !== pipeline && live(g));
    const m = media;
    if (!live(g) || m === null) return; // a still / a failed probe: no job, ever
    let editorClass: PlaybackClass | null = null;
    try {
      editorClass = (await ipc.classifyPlayback(m, codecHints(), settingsStore.get().proxyMedia)).class;
    } catch {
      // Unknown → not provably the same job → cancel below, as the contract says.
    }
    if (!live(g)) return;
    handOffClass = editorClass;
    if (promised(g, lastClass)) {
      // Same class → same cache targets → the editor's plans join these jobs.
      // The CURRENT ones: a plan that answered during the classify replaced them.
      if (jobId !== null) handedOff.add(jobId);
      if (queued !== null) handedOff.add(queued.jobId);
      return;
    }
    // The editor would prepare something else (a proxy of a large file the
    // viewer only remuxes): these jobs would run for nobody. Cancel them and
    // say nothing — the project is opening, and a "Prepare preview" flashing
    // up under the busy latch is wrong copy. An open that fails must load()
    // the file again, which re-plans whatever it needs (the viewer does so
    // for a full repair it was still showing progress for).
    releaseJob(false);
  }

  return {
    load(p: string): void {
      if (disposed) return;
      gen++;
      loads++;
      releaseJob(false);
      // The promise made to the editor concerned the file being left; this
      // load owes nothing to it. (handOffGen needs no reset: gen just moved.)
      handedOff.clear();
      replanned = false;
      jobRepair = false;
      shownFrom = null;
      shownUrl = "";
      repairTried = false;
      damage = null;
      damageSaid = "";
      quickRefused = false;
      quietPlan = false;
      lastClass = null;
      media = null;
      kind = "video";
      path = p;
      phase = "loading";
      emit({ state: "loading" });
      const family = mediaFamilyOf(fileExt(p));
      if (family === "image" || family === "gif") {
        pipeline = Promise.resolve();
        emit({ state: "ready", element: "img", url: mediaUrl(p), kind: "image", tryingDirect: false });
        return;
      }
      if (family === null) {
        // Every route in is allowlisted first (G1); this is the loader not
        // trusting that. No detail: the viewer's heading already says it
        // can't show the file, and an empty detail renders no line.
        pipeline = Promise.resolve();
        fail("");
        return;
      }
      pipeline = resolveMedia(gen, p);
    },

    prepare(): void {
      if (disposed || phase !== "needsPrepare") return;
      pipeline = plan(gen);
    },

    playbackFailed(code: number | null): void {
      if (disposed) return;
      if (phase === "tryingDirect") {
        // The container-only attempt was refused (or timed out): the remux it
        // was always going to need, whatever the refusal said.
        pipeline = plan(gen);
        return;
      }
      // No video of this load is out (still loading, preparing, a still, a
      // failure on screen): the report is about something already left.
      if (phase !== "settled" || shownFrom === null) return;
      if (shownFrom === "quick") {
        // The instant copy refused too (a WebView that will not take even the
        // sound part of the stream as-is). The full repair is ffmpeg's own
        // encode: wait for it rather than fail.
        quickRefused = true;
        shownFrom = null;
        if (jobKind === "upgrade" && jobId !== null) {
          phase = "preparing";
          preparing(damage?.ratio ?? null);
          return;
        }
        if (quietPlan) {
          // A re-plan is already asking for the full repair again; its answer
          // decides (read with `quickRefused` set).
          phase = "planning";
          preparing(null);
          return;
        }
        fail("");
        return;
      }
      if (
        (code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED) &&
        (shownFrom === "direct" || shownFrom === "remux") &&
        kind === "video" &&
        !repairTried
      ) {
        // The stream itself is the problem (a stream copy carries it over
        // unchanged). ffmpeg conceals what the WebView's decoder gives up on,
        // so a repair plays — and with nothing else to show, it starts now. A
        // video only: the repair is a video recipe, and an audio file the
        // WebView refuses is reported as before.
        shownFrom = null;
        // A hand-off made before this refusal may have promised the editor
        // this load's jobs. Its open may since have failed — and a failed open
        // leaves a settled video's load in place, claim included — so a repair
        // started now would be kept by dispose() for an editor that never
        // came. The refusal withdraws the claim; an open asked for after it
        // decides afresh.
        if (handOffGen === gen) handOffGen = -1;
        // plan() marks the repair tried before its first await, so the card
        // below already says the file is damaged.
        pipeline = plan(gen, true);
        preparing(null);
        return;
      }
      fail("");
    },

    handOff(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (handOffGen === gen) return handOffStep;
      handOffGen = gen;
      handOffClass = null;
      handOffStep = decideHandOff(gen);
      return handOffStep;
    },

    debug() {
      return { loads, lastClass, jobId };
    },

    dispose(): void {
      if (disposed) return;
      releaseJob(true);
      disposed = true;
      orphans.length = 0;
      if (unlisten !== null) {
        unlisten();
        unlisten = null;
      }
    },
  };
}
