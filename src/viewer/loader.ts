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
} from "../core/ipc";
import { fileExt } from "../core/format";
import { settingsStore } from "../core/session";
import { mediaFamilyOf, type MediaInfo, type MediaRef } from "../core/types";
import type { ViewElement } from "./stepper";

export type LoadState =
  | { state: "loading" }
  | {
      state: "ready";
      element: ViewElement;
      url: string;
      kind: "image" | "video" | "audio";
      /** container-only DIRECT attempt: the viewer must call directFailed() on a media `error`
       *  or when `loadedmetadata` has not fired within DIRECT_TIMEOUT_MS */
      tryingDirect: boolean;
    }
  | { state: "preparing"; ratio: number | null }
  | { state: "needsPrepare" }
  | { state: "failed"; message: string };

export const DIRECT_TIMEOUT_MS = 4000;

export interface SourceLoader {
  /** Resolve `path` for display; supersedes the previous load. A previous pending job is
   *  canceled (ipc.cancelJob) even if handOff() ran for it: a load on a live loader means
   *  the editor never got the job. Only dispose() honours a hand-off. */
  load(path: string): void;
  /** The user pressed "Prepare preview" (only meaningful in state needsPrepare). */
  prepare(): void;
  /** The container-only direct attempt failed → plan a remux. */
  directFailed(): void;
  /** Open-as-project hand-off. Keeps the current pending job — and any job this same load
   *  starts afterwards — ONLY if classifyPlayback(media, hints, settings.proxyMedia) equals the
   *  class the viewer planned (the editor will then join the same Inflight job); otherwise
   *  cancels it, emitting nothing. One classify per load; repeat calls share it. */
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

/** Where the current load is resting. Gates `prepare()` / `directFailed()` so
 *  a second press, or a stale call from a file the user already stepped past,
 *  starts nothing. */
type Phase =
  | "loading" //      probing / classifying, or a still (which never leaves it)
  | "tryingDirect" // container-only file handed to the element as-is
  | "needsPrepare" // proxy-class, waiting for the user
  | "planning" //     planPlayback in flight
  | "preparing" //    a job is running for this file
  | "settled"; //     ready from a plan / a job, or failed

/** DEV-only E2E knob (S19): treat `prepared` as false, because the cache
 *  persists across runs and would otherwise turn "Prepare preview" into an
 *  instant ready from the second run on. The viewer owns the object; the
 *  loader only reads it. `import.meta.env.DEV` first so a release build drops
 *  the whole lookup. */
function forceUnprepared(): boolean {
  return (
    import.meta.env.DEV &&
    (globalThis as { __tarotingViewerDev?: { forceUnprepared?: unknown } }).__tarotingViewerDev
      ?.forceUnprepared === true
  );
}

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
  /** The pending preparation job the CURRENT load waits on. Every cancel this
   *  loader issues nulls it FIRST, so a canceled event that still matches it
   *  is by definition somebody else's — the one case that earns a re-plan. */
  let jobId: number | null = null;
  /** What the pending job writes; the done event normally names it too. */
  let jobOutput = "";
  /** A job handOff() decided the editor will join: dispose() leaves it running. */
  let handedOffJob: number | null = null;
  /** The load (gen) handOff() last ran for, the editor's class for that file
   *  (null until known, or when its classify failed), and the one decision
   *  every call for that load shares. Recorded even when no job exists yet: the
   *  4 s direct timeout or a "Prepare preview" press can start one WHILE the
   *  project opens, and the editor joins that job just the same. */
  let handOffGen = -1;
  let handOffClass: PlaybackClass | null = null;
  let handOffStep: Promise<void> = Promise.resolve();
  /** The job-event subscription failed: a job we start could never be followed. */
  let listenFailed = false;
  /** The current load already re-planned once after a foreign cancel. */
  let replanned = false;
  /** The step the current load is working through (probe → classify → plan,
   *  or a plan started by prepare()/directFailed()/a re-plan). handOff() waits
   *  on it so a plan still in flight has its job id before the hand-off
   *  decides what to keep. Never rejects. */
  let pipeline: Promise<void> = Promise.resolve();

  /**
   * Terminal events for job ids nobody here is waiting on — yet. Tauri events
   * and invoke answers travel separate channels, so a stream-copy remux of a
   * small file can report `job:done` BEFORE `planPlayback`'s `pending` answer
   * naming that job reaches us; dropped, it would leave the viewer on
   * "Preparing" forever. Consulted exactly once, for the id a plan just
   * returned. Stale ids never come back from a plan (the backend never hands
   * out a canceled job, and a finished one answers `ready`), so everything
   * else in here simply ages out — "events for a stale job are ignored" holds.
   */
  const orphans: Orphan[] = [];
  function keepOrphan(o: Orphan): void {
    orphans.push(o);
    if (orphans.length > ORPHAN_KEEP) orphans.shift();
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

  /** Drop the current job, canceling it unless `honourHandOff` and the editor
   *  was promised it. Only dispose() honours the promise: a load() on a live
   *  loader means the open never reached the editor (it failed, or an Explorer
   *  open superseded it), so a transcode kept for it would run for nobody. */
  function releaseJob(honourHandOff: boolean): void {
    const j = jobId;
    if (j === null) return;
    jobId = null; // before the cancel: our own canceled event must not match
    if (!honourHandOff || j !== handedOffJob) cancel(j);
  }

  function fail(message: string): void {
    phase = "settled";
    emit({ state: "failed", message });
  }

  function readyVideo(url: string, tryingDirect: boolean): void {
    emit({ state: "ready", element: "video", url, kind, tryingDirect });
  }

  /* ---- job events: ONE subscription, before any plan can be issued (G11) ---- */

  function onProgress(e: JobProgress): void {
    if (disposed || e.id !== jobId) return;
    emit({ state: "preparing", ratio: e.ratio });
  }

  function onDone(e: JobDone): void {
    if (disposed) return;
    if (e.id !== jobId) {
      keepOrphan({ id: e.id, done: e });
      return;
    }
    const m = media;
    jobId = null;
    phase = "settled";
    readyVideo(mediaUrl(String(e.output.path ?? jobOutput)), false);
    // A new file just landed in the cache: trim it back under the cap, never
    // evicting what is on screen (G17). Same call the editor makes on done.
    if (m !== null) {
      const key = { path: m.path, size: m.size, mtimeMs: m.mtimeMs };
      void ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, [key]).catch(() => {});
    }
  }

  function onFailed(e: JobFailed): void {
    if (disposed) return;
    if (e.id !== jobId) {
      keepOrphan({ id: e.id, failed: e });
      return;
    }
    jobId = null;
    if (e.canceled && !replanned) {
      // CANCELED UNDER US — by another consumer of the same output (the
      // backend shares one job per output path), or by our own cancel of an
      // earlier visit to this file that the fresh plan rejoined before the
      // cancel landed. Ask once more: the backend never hands a canceled job
      // to a fresh request. Once only, so a second cancel cannot loop.
      replanned = true;
      pipeline = plan(gen);
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

  /** planPlayback for the current file, never forcing a proxy (4K plays direct
   *  in the viewer — owner decision). Never rejects. */
  async function plan(g: number): Promise<void> {
    const m = media;
    if (m === null) return;
    const cls = lastClass;
    phase = "planning";
    // A job can finish in milliseconds; its events must have somewhere to go.
    await listening;
    if (!live(g)) return;
    let p: PlaybackPlan;
    try {
      p = await ipc.planPlayback(m, codecHints(), false);
    } catch (e) {
      if (live(g)) fail(describeError(e));
      return;
    }
    if (!live(g)) {
      // Superseded while the backend started a job for us: nobody will ever
      // read it (G17). Unless the current load is riding that very job — a
      // quick step away and back onto the same file rejoins it — or the
      // viewer closed INTO the editor, which joins it: still on this load
      // (g === gen) and not live means dispose() came after a matching handOff.
      if (
        p.mode === "pending" &&
        p.jobId !== jobId &&
        p.jobId !== handedOffJob &&
        !(g === gen && promised(g, cls))
      )
        cancel(p.jobId);
      return;
    }
    if (p.mode === "direct" || p.mode === "ready") {
      phase = "settled";
      readyVideo(mediaUrl(p.path), false);
      return;
    }
    if (listenFailed) {
      // Its progress and its end would never reach us.
      cancel(p.jobId);
      fail("Couldn't follow the preview preparation");
      return;
    }
    // Started after handOff() already agreed with the editor for this load:
    // the editor's own plan joins this job too.
    if (promised(g, cls)) handedOffJob = p.jobId;
    jobId = p.jobId;
    jobOutput = p.output;
    phase = "preparing";
    emit({ state: "preparing", ratio: null });
    const i = orphans.findIndex((o) => o.id === p.jobId);
    if (i >= 0) {
      const o = orphans.splice(i, 1)[0]!;
      if ("done" in o) onDone(o.done);
      else onFailed(o.failed);
    }
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
    try {
      const c = await ipc.classifyPlayback(m, codecHints(), false);
      cls = c.class;
      prepared = c.prepared === true;
    } catch (e) {
      if (live(g)) fail(describeError(e));
      return;
    }
    if (!live(g)) return;
    lastClass = cls;
    if (prepared && !forceUnprepared()) {
      // A remux/proxy of this exact file is cached: planning answers `ready`
      // without starting anything.
      await plan(g);
      return;
    }
    switch (cls) {
      case "direct":
        phase = "settled";
        readyVideo(mediaUrl(p), false);
        return;
      case "containerOnly":
        // Only the container is wrong; WebView2 often plays it anyway (mov
        // H.264/AAC). Try the file itself; the viewer reports a refusal.
        phase = "tryingDirect";
        readyVideo(mediaUrl(p), true);
        return;
      case "remux":
        // "Auto-remux when quick": a stream copy, audio re-encoded at most.
        await plan(g);
        return;
      case "proxy":
        // A real transcode: nothing starts until the user asks.
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
      // Same class → same cache target → the editor's plan joins this job.
      // The CURRENT one: a plan that answered during the classify replaced it.
      if (jobId !== null) handedOffJob = jobId;
      return;
    }
    // The editor would prepare something else (a proxy of a large file the
    // viewer only remuxes): this job would run for nobody. Cancel it and say
    // nothing — the project is opening, and a "Prepare preview" flashing up
    // under the busy latch is wrong copy. An open that fails must load() the
    // file again, which re-offers whatever it needs.
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
      handedOffJob = null;
      replanned = false;
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

    directFailed(): void {
      if (disposed || phase !== "tryingDirect") return;
      pipeline = plan(gen);
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
