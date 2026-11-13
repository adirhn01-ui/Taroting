// The viewer's SCRUB COPY: on a HEAVY video (seek-pacer's rule), a small
// all-keyframe copy made in the background (src-tauri/src/media/scrub.rs) is
// shown over the picture while the pointer drags the seek bar, so the picture
// under the pointer is the frame at the pointer — every seek of the copy lands
// on a keyframe, where an exact seek of the original decodes up to a whole
// GOP (0.6-1.4 s per picture measured on the owner's clips).
//
// The rules, in order of the viewer's use:
//  1. Light videos, audio, stills and PDFs never get here: no element, no
//     command, no timer (`indexed(…, false)` does nothing; `press` only
//     counts).
//  2. The copy is asked for SCRUB_DWELL_MS after a heavy video's index is
//     known while it is still on screen, or at once when a press on its seek
//     bar came first. A new source (`reset`: a step, a swap, a reload, leaving)
//     cancels a job still running and forgets the copy.
//  3. Until it is ready, nothing changes: the seek pacer snaps to keyframes.
//  4. Ready, it sits loaded in a second <video>, hidden.
//  5. A DRAG on the bar (a press, then a move) with the copy ready: the main
//     video is not seeked while the pointer moves (paused for the drag if it
//     played, resumed on release); the copy is seeked to the pointer, one
//     seek in flight, the newest waiting; it shows once a frame of THIS drag
//     has been presented on it.
//  6. Resting REST_MS, or released: ONE exact seek of the main video to the
//     pointer. The copy stays up until the main video has presented it, then
//     hides; a move before that keeps it up.
//  7. A click (no move) and keyboard seeks: the copy is never shown.
//  8. Any failure falls back to the pacer for that file for the rest of the
//     viewer session, silently; the reason is kept for the dev hook.
// A frame counts as presented once the element is `!seeking && readyState >=
// 2` and two animation frames have passed: requestVideoFrameCallback on a
// PAUSED element fires once per new frame, and a hook attached after a fast
// seek never fires.
//
// State machine only, with its elements, timers and IPC injected (like
// SeekPacer), so vitest drives it with fakes; viewer.ts wires it.

import type { ScrubPlan } from "../core/ipc";
import { REST_MS, type PacerTimers } from "./seek-pacer";

/** A heavy video's copy is asked for this long after its index is known
 *  while it stays on screen (ms). Tuned by the owner's feel. */
export const SCRUB_DWELL_MS = 1000;
/** A seek of the copy that has not landed after this long is a decode stall:
 *  the copy is given up for the file (ms). */
export const COPY_STALL_MS = 3000;
/** A copy seek to within this of where it is is not made (seconds). */
const SAME_POSITION_S = 0.01;

export type ScrubCopyState = "none" | "waiting" | "making" | "ready" | "failed";

/** What the dev hook reads. */
export interface ScrubCopySnapshot {
  state: ScrubCopyState;
  shown: boolean;
  file: string | null;
  reason?: string;
}

export interface ScrubJobHandlers {
  done(id: number, path: string | null): void;
  failed(id: number, message: string): void;
}

export interface ScrubCopyDeps {
  /** The viewer's #vw-video. */
  main: HTMLVideoElement;
  /** Make the copy's <video>: once, on the first copy, already in the stage
   *  and hidden. */
  createCopy(): HTMLVideoElement;
  /** One EXACT seek of the main video (the viewer's own exact path). */
  seekMain(t: number): void;
  plan(file: string): Promise<ScrubPlan>;
  cancel(jobId: number): void;
  /** Listen to job:done / job:failed; resolves to the unlisten. */
  listen(h: ScrubJobHandlers): Promise<() => void>;
  /** The URL the webview loads a cache file from. */
  url(path: string): string;
  timers?: PacerTimers;
  raf?: (fn: () => void) => void;
}

const browserTimers: PacerTimers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  now: () => performance.now(),
};
const browserRaf = (fn: () => void): void => void requestAnimationFrame(() => fn());

export class ScrubCopy {
  private readonly d: ScrubCopyDeps;
  private readonly timers: PacerTimers;
  private readonly raf: (fn: () => void) => void;
  /** Files whose copy failed this viewer session (and why). */
  private readonly failedFiles = new Map<string, string>();

  /** Bumped by every reset: an answer for an older source is dropped. */
  private gen = 0;
  private disposed = false;
  private state: ScrubCopyState = "none";
  private reason: string | undefined;
  /** The file the main video plays (its index was asked of it). */
  private file: string | null = null;
  private heavy = false;
  /** A press on the seek bar happened on this source. */
  private pressed = false;
  private dwellTimer: number | undefined;
  private jobId: number | null = null;
  private unlisten: (() => void) | null = null;
  /** Job ends that arrived before the plan named the job. */
  private early = new Map<number, { path: string | null } | { failed: string }>();
  /** Jobs an older source's plan started after that source was left (id →
   *  the file it copies): cancelled unless a plan now waiting for the same
   *  file may be answered with the same job (one job per output file). */
  private readonly orphans = new Map<number, string>();

  private copy: HTMLVideoElement | null = null;
  /** The src this source loaded into the copy (null: none). */
  private copySrc: string | null = null;

  /* the drag */
  /** Bumped by every press: frames of an earlier drag never count. */
  private dragId = 0;
  /** A press on the bar is held, and the copy drives it. */
  private dragging = false;
  /** That drag has moved (a click never does). */
  private moved = false;
  private cursor = 0;
  /** The pointer position the last exact seek of the main video went to
   *  (NaN: none since the last move). */
  private exactAt = Number.NaN;
  private restTimer: number | undefined;
  /** The main video was playing when the drag began and is paused for it. */
  private resume = false;

  /* the copy's seeks */
  private inflight = false;
  private inflightDrag = -1;
  private want: number | null = null;
  private stallTimer: number | undefined;
  /** The drag whose frame the copy has presented (-1: none). */
  private copyFrameDrag = -1;

  /* the main video's exact seek */
  private awaitMain = false;
  private mainSeq = 0;
  /** The main video presented the exact frame and nothing moved since. */
  private caughtUp = false;

  private shown = false;
  /** DEV: seeks issued to the copy. */
  copySeeks = 0;

  private readonly rested = (): void => {
    this.restTimer = undefined;
    if (this.dragging && this.moved && this.exactAt !== this.cursor) this.exactMain(this.cursor);
  };
  private readonly stalled = (): void => {
    this.stallTimer = undefined;
    if (this.inflight) this.fail("a seek of the copy did not land (decode stall)");
  };

  constructor(deps: ScrubCopyDeps) {
    this.d = deps;
    this.timers = deps.timers ?? browserTimers;
    this.raf = deps.raf ?? browserRaf;
  }

  /** The current source's keyframe index answered for `file`: heavy or not.
   *  A light answer does nothing at all. */
  indexed(file: string, heavy: boolean): void {
    if (this.disposed) return;
    if (this.file !== file) {
      // Another source's answer can only arrive after a reset; this one is new.
      this.file = file;
    }
    this.heavy = heavy;
    if (!heavy || this.state !== "none") return;
    const failed = this.failedFiles.get(file);
    if (failed !== undefined) {
      this.state = "failed";
      this.reason = failed;
      return;
    }
    if (this.pressed) this.request();
    else if (this.dwellTimer === undefined) this.dwellTimer = this.timers.setTimeout(this.dwelled, SCRUB_DWELL_MS);
  }

  private readonly dwelled = (): void => {
    this.dwellTimer = undefined;
    this.request();
  };

  /** A press on the seek bar at `t` (the viewer seeks it exactly itself). */
  press(t: number): void {
    if (this.disposed) return;
    this.pressed = true;
    this.dragId++;
    this.moved = false;
    this.cursor = t;
    this.exactAt = Number.NaN;
    this.caughtUp = false;
    this.awaitMain = false;
    this.want = null;
    this.clearRest();
    this.dragging = this.state === "ready";
    if (this.heavy && this.state === "none") this.request();
    this.paint();
  }

  /** The held pointer moved to `t`. True: the copy took it (the main video
   *  must not be seeked); false: the viewer's own path. */
  move(t: number): boolean {
    if (!this.dragging || this.state !== "ready" || this.copy === null) return false;
    this.cursor = t;
    this.exactAt = Number.NaN;
    this.caughtUp = false;
    this.awaitMain = false;
    if (!this.moved) {
      this.moved = true;
      if (!this.d.main.paused) {
        this.resume = true;
        this.d.main.pause();
      }
    }
    this.seekCopy(t);
    this.clearRest();
    this.restTimer = this.timers.setTimeout(this.rested, REST_MS);
    this.paint();
    return true;
  }

  /** The pointer let go. One exact seek of the main video when the drag moved
   *  (none for a click, none again after a rest that already sent it), and
   *  playback resumes if the drag paused it. */
  release(): void {
    const held = this.dragging;
    this.dragging = false;
    this.clearRest();
    if (held && this.moved && this.exactAt !== this.cursor) this.exactMain(this.cursor);
    if (this.resume) {
      this.resume = false;
      void this.d.main.play().catch(() => {});
    }
    this.paint();
  }

  /** The copy owns the position (the viewer's `asked` must not be let go of
   *  when a main-video seek lands). */
  holding(): boolean {
    return this.dragging && this.moved;
  }

  /** The main video is paused for the drag (the viewer keeps its playIntent). */
  pausing(): boolean {
    return this.resume;
  }

  /** The viewer's `seeked` / `canplay` of the main video. */
  mainSeeked(): void {
    this.checkMain();
  }

  /** The main video gets another source, or none: cancel a job still
   *  running, forget the copy and everything about the drag. */
  reset(): void {
    this.gen++;
    if (this.jobId !== null) this.d.cancel(this.jobId);
    this.jobId = null;
    this.stopListening();
    this.early.clear();
    this.timers.clearTimeout(this.dwellTimer);
    this.dwellTimer = undefined;
    this.clearRest();
    this.timers.clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.dropCopySrc();
    this.state = "none";
    this.reason = undefined;
    this.file = null;
    this.heavy = false;
    this.pressed = false;
    this.dragging = false;
    this.moved = false;
    this.resume = false;
    this.inflight = false;
    this.want = null;
    this.copyFrameDrag = -1;
    this.awaitMain = false;
    this.caughtUp = false;
    this.exactAt = Number.NaN;
    this.paint();
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
    this.settleOrphans();
  }

  snapshot(): ScrubCopySnapshot {
    const s: ScrubCopySnapshot = { state: this.state, shown: this.shown, file: this.file };
    if (this.reason !== undefined) s.reason = this.reason;
    return s;
  }

  /* ---------------- asking ---------------- */

  private request(): void {
    if (this.disposed || this.state !== "none" || this.file === null) return;
    this.timers.clearTimeout(this.dwellTimer);
    this.dwellTimer = undefined;
    // (A file that failed this session never gets here: indexed() marks it.)
    this.state = "waiting";
    const my = this.gen;
    const file = this.file;
    // Listening first: a job that ends while the plan is answered is not missed.
    this.d
      .listen({
        done: (id, path) => this.jobEnded(my, id, { path }),
        failed: (id, message) => this.jobEnded(my, id, { failed: message }),
      })
      .then((un) => {
        if (my !== this.gen) {
          un();
          this.settleOrphans();
          return;
        }
        this.unlisten = un;
        return this.d.plan(file).then((p) => this.planned(my, file, p));
      })
      .catch((e: unknown) => {
        if (my === this.gen) this.fail(`asking for the copy failed: ${String(e)}`);
      });
  }

  private planned(my: number, file: string, p: ScrubPlan): void {
    if (my !== this.gen || this.state !== "waiting") {
      // The source was left while the plan was answered: a job it started
      // must not run on for nobody.
      if (p.mode === "pending") this.orphans.set(p.jobId, file);
      this.settleOrphans();
      return;
    }
    if (p.mode === "ready") {
      this.load(p.path);
    } else if (p.mode === "pending") {
      this.state = "making";
      this.jobId = p.jobId;
      const ended = this.early.get(p.jobId);
      this.early.clear();
      if (ended !== undefined) this.jobEnded(my, p.jobId, ended);
    } else {
      this.fail(`no copy: ${p.reason}`);
    }
    this.settleOrphans();
  }

  /** Cancel every orphaned job, except the one the current source adopted
   *  and those a plan still waiting for the same file may yet adopt. */
  private settleOrphans(): void {
    for (const [id, file] of this.orphans) {
      if (id === this.jobId) {
        this.orphans.delete(id);
        continue;
      }
      if (!this.disposed && this.state === "waiting" && this.file === file) continue;
      this.orphans.delete(id);
      this.d.cancel(id);
    }
  }

  private jobEnded(my: number, id: number, end: { path: string | null } | { failed: string }): void {
    if (my !== this.gen) return;
    if (this.state === "waiting") {
      this.early.set(id, end);
      return;
    }
    if (this.state !== "making" || id !== this.jobId) return;
    this.jobId = null;
    this.stopListening();
    if ("failed" in end) this.fail(`the copy job failed: ${end.failed}`);
    else if (end.path === null) this.fail("the copy job named no file");
    else this.load(end.path);
  }

  private stopListening(): void {
    const un = this.unlisten;
    this.unlisten = null;
    if (un) un();
  }

  /* ---------------- the copy element ---------------- */

  private load(path: string): void {
    this.stopListening();
    this.state = "making";
    const c = this.copy ?? this.makeCopy();
    const url = this.d.url(path);
    this.copySrc = url;
    c.src = url;
  }

  private makeCopy(): HTMLVideoElement {
    const c = this.d.createCopy();
    this.copy = c;
    c.addEventListener("loadeddata", () => {
      if (this.state !== "making" || this.copySrc === null || c.getAttribute("src") !== this.copySrc) return;
      this.state = "ready";
      // A drag already held when the copy became ready stays the pacer's;
      // the next press is the copy's.
    });
    c.addEventListener("error", () => {
      // Clearing the src fires one too: only the copy we loaded counts.
      if (this.copySrc === null || c.getAttribute("src") !== this.copySrc) return;
      if (this.state !== "making" && this.state !== "ready") return;
      this.fail(`the copy would not play (media error ${String(c.error?.code ?? "?")})`);
    });
    c.addEventListener("seeked", () => this.copySeeked());
    return c;
  }

  private dropCopySrc(): void {
    const c = this.copy;
    this.copySrc = null;
    if (c === null) return;
    if (c.hasAttribute("src")) {
      c.removeAttribute("src");
      c.load();
    }
  }

  /* ---------------- the copy's seeks ---------------- */

  private seekCopy(t: number): void {
    if (this.inflight) {
      // Latest wins: a stale waiting position is replaced.
      this.want = t;
      return;
    }
    this.issue(t);
  }

  private issue(t: number): void {
    const c = this.copy;
    this.want = null;
    if (c === null) return;
    if (!c.seeking && Math.abs(c.currentTime - t) <= SAME_POSITION_S) {
      this.presentCheck(this.dragId);
      return;
    }
    this.inflight = true;
    this.inflightDrag = this.dragId;
    c.currentTime = t;
    this.copySeeks++;
    this.timers.clearTimeout(this.stallTimer);
    this.stallTimer = this.timers.setTimeout(this.stalled, COPY_STALL_MS);
  }

  private copySeeked(): void {
    if (!this.inflight || this.copy === null || this.copy.seeking) return;
    this.inflight = false;
    this.timers.clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    // Before the next seek: the landed frame is the one on screen until the
    // next one decodes.
    this.presentCheck(this.inflightDrag);
    if (this.want !== null && this.state === "ready") this.issue(this.want);
  }

  /** The copy's frame for drag `drag` is on screen once the element is
   *  settled and two animation frames have passed. */
  private presentCheck(drag: number): void {
    const c = this.copy;
    if (c === null || c.seeking || c.readyState < 2) return;
    const my = this.gen;
    this.raf(() =>
      this.raf(() => {
        if (my !== this.gen || this.state !== "ready" || drag !== this.dragId) return;
        this.copyFrameDrag = drag;
        this.paint();
      }),
    );
  }

  /* ---------------- the main video's exact seek ---------------- */

  private exactMain(t: number): void {
    this.exactAt = t;
    this.awaitMain = true;
    this.caughtUp = false;
    this.mainSeq++;
    this.d.seekMain(t);
    this.checkMain();
  }

  private checkMain(): void {
    if (!this.awaitMain) return;
    const m = this.d.main;
    if (m.seeking || m.readyState < 2) return;
    const seq = this.mainSeq;
    const my = this.gen;
    // A move meanwhile clears awaitMain: the copy stays up.
    this.raf(() =>
      this.raf(() => {
        if (my !== this.gen || seq !== this.mainSeq || !this.awaitMain) return;
        if (m.seeking) return;
        this.awaitMain = false;
        this.caughtUp = true;
        this.paint();
      }),
    );
  }

  /* ---------------- failure ---------------- */

  private fail(reason: string): void {
    if (this.state === "failed") return;
    // The main video goes where the pointer is now; later moves are the
    // pacer's (move() answers false from here on).
    const owed = this.dragging && this.moved && this.exactAt !== this.cursor;
    this.state = "failed";
    this.reason = reason;
    if (this.file !== null) this.failedFiles.set(this.file, reason);
    if (this.jobId !== null) this.d.cancel(this.jobId);
    this.jobId = null;
    this.stopListening();
    this.early.clear();
    this.timers.clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.clearRest();
    this.inflight = false;
    this.want = null;
    this.dropCopySrc();
    this.dragging = false;
    if (owed) this.d.seekMain(this.cursor);
    this.paint();
  }

  /* ---------------- painting ---------------- */

  private clearRest(): void {
    this.timers.clearTimeout(this.restTimer);
    this.restTimer = undefined;
  }

  private paint(): void {
    const on =
      this.state === "ready" &&
      this.copy !== null &&
      this.moved &&
      this.copyFrameDrag === this.dragId &&
      !this.caughtUp &&
      (this.dragging || this.awaitMain);
    if (on === this.shown) return;
    this.shown = on;
    if (this.copy !== null) this.copy.hidden = !on;
  }
}
