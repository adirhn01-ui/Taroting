// The editor's scrub copies, per FILE: is the file the editor plays heavy to
// seek in (one keyframe-index read), and if so, its all-keyframe copy made by
// the backend's `plan_scrub` (src-tauri/src/media/scrub.rs).
//
// The rules:
//  - One record per played file, however many clips or media use it: one
//    index read and one job per file.
//  - A light verdict is final for the editor session: no plan, no element,
//    no further read (a DEV `force` re-weighs it from the index it kept).
//  - Heavy files queue; at most ONE copy job belongs to the editor at a time.
//    The files under the playhead go to the front. A job is never cancelled
//    because the playhead moved on.
//  - Job events are listened to BEFORE the plan is asked (a job that ends
//    while the plan is being answered is not missed: its end is buffered),
//    and only while some record is waiting or making.
//  - A file the project no longer plays (`reconcile`) is let go: its job is
//    cancelled once, every late answer for it is dropped.
//  - Failures are silent and per file; the reason is kept for the dev hook.
//
// State machine only: the backend calls and the job events are injected, so
// vitest drives it with fakes.

import { heavyGap } from "../../core/heavy-clip";
import type { KeyframeIndex, ScrubPlan } from "../../core/ipc";

export type CopyFileState = "unknown" | "indexing" | "light" | "heavy" | "waiting" | "making" | "ready" | "failed";

export interface CopyJobHandlers {
  done(id: number, path: string | null): void;
  failed(id: number, message: string): void;
}

export interface CopyRegistryDeps {
  keyframeTimes(file: string): Promise<KeyframeIndex | null>;
  plan(file: string): Promise<ScrubPlan>;
  cancel(jobId: number): void;
  /** Listen to job:done / job:failed; resolves to the unlisten. */
  listen(h: CopyJobHandlers): Promise<() => void>;
  /** The URL the webview loads a cache file from. */
  url(path: string): string;
  /** A record became ready or failed (the layers may show or drop it). */
  changed?(file: string): void;
  /** A record was let go; `url` is its copy's url when it had one. */
  released?(file: string, url: string | null): void;
}

export interface CopyFileSnapshot {
  file: string;
  state: CopyFileState;
  reason: string | null;
  jobId: number | null;
}

interface FileRecord {
  readonly file: string;
  state: CopyFileState;
  /** Bumped when the record is let go: an answer from before is dropped. */
  gen: number;
  index: KeyframeIndex | null;
  jobId: number | null;
  url: string | null;
  reason: string | null;
  /** Errors of a copy element after it was ready (the first one re-plans). */
  elementErrors: number;
}

type JobEnd = { path: string | null } | { failed: string };

export class ScrubCopyRegistry {
  private readonly d: CopyRegistryDeps;
  private readonly records = new Map<string, FileRecord>();
  /** Heavy files waiting for their job, front first. */
  private queue: string[] = [];
  private listening: { un: (() => void) | null; ready: Promise<void> } | null = null;
  /** Job ends that arrived before the plan named the job. */
  private readonly early = new Map<number, JobEnd>();
  /** DEV: the files whose thresholds are skipped. */
  private force: (file: string) => boolean = () => false;
  private failNext: string | null = null;
  private disposed = false;

  /** DEV counters. */
  indexCalls = 0;
  planCalls = 0;
  cancels = 0;

  constructor(deps: CopyRegistryDeps) {
    this.d = deps;
  }

  /* ---------------- asking ---------------- */

  /** The playhead is on these files: weigh any not weighed yet, and move the
   *  heavy ones waiting for a job to the front of the queue. */
  ask(files: readonly string[]): void {
    if (this.disposed) return;
    const front: string[] = [];
    for (const file of files) {
      let rec = this.records.get(file);
      if (rec === undefined) {
        rec = this.newRecord(file);
        this.weigh(rec);
      }
      if (rec.state === "heavy" && !front.includes(file)) front.push(file);
    }
    if (front.length > 0) {
      this.queue = [...front, ...this.queue.filter((f) => !front.includes(f))];
      this.pump();
    }
  }

  /** The copy url of a ready file, else null. */
  readyUrl(file: string): string | null {
    const rec = this.records.get(file);
    return rec !== undefined && rec.state === "ready" ? rec.url : null;
  }

  state(file: string): CopyFileState | null {
    return this.records.get(file)?.state ?? null;
  }

  /** DEV: skip the thresholds (not the index's own sanity) for every file,
   *  or for the files `on` accepts. Turning it on re-weighs every light
   *  record it covers from the index it kept. */
  setForce(on: boolean | ((file: string) => boolean)): void {
    const pred = typeof on === "function" ? on : () => on;
    this.force = pred;
    if (this.disposed) return;
    let queued = false;
    for (const rec of this.records.values()) {
      if (rec.state === "light" && pred(rec.file) && heavyGap(rec.index, true) !== null) {
        rec.state = "heavy";
        this.queue.push(rec.file);
        queued = true;
      }
    }
    if (queued) this.pump();
  }

  /** DEV: the next plan answers "unavailable" with this reason. */
  failNextPlan(reason: string): void {
    this.failNext = reason;
  }

  private newRecord(file: string): FileRecord {
    const rec: FileRecord = {
      file,
      state: "unknown",
      gen: 0,
      index: null,
      jobId: null,
      url: null,
      reason: null,
      elementErrors: 0,
    };
    this.records.set(file, rec);
    return rec;
  }

  private current(rec: FileRecord, gen: number): boolean {
    return !this.disposed && this.records.get(rec.file) === rec && rec.gen === gen;
  }

  private weigh(rec: FileRecord): void {
    rec.state = "indexing";
    const my = rec.gen;
    this.indexCalls++;
    this.d
      .keyframeTimes(rec.file)
      .catch(() => null)
      .then((index) => {
        if (!this.current(rec, my) || rec.state !== "indexing") return;
        rec.index = index;
        if (heavyGap(index, this.force(rec.file)) === null) {
          rec.state = "light";
          return;
        }
        rec.state = "heavy";
        // Asked for by the playhead: the front of the queue.
        this.queue.unshift(rec.file);
        this.pump();
      });
  }

  /* ---------------- the one job ---------------- */

  private busy(): boolean {
    for (const rec of this.records.values()) if (rec.state === "waiting" || rec.state === "making") return true;
    return false;
  }

  private pump(): void {
    if (this.disposed || this.busy()) return;
    while (this.queue.length > 0) {
      const file = this.queue.shift()!;
      const rec = this.records.get(file);
      if (rec === undefined || rec.state !== "heavy") continue;
      this.request(rec);
      return;
    }
    this.stopListeningIfIdle();
  }

  private request(rec: FileRecord): void {
    rec.state = "waiting";
    const my = rec.gen;
    // Listening first: a job that ends while the plan is answered is not missed.
    this.ensureListening()
      .then(() => {
        if (!this.current(rec, my) || rec.state !== "waiting") return;
        const failNext = this.failNext;
        if (failNext !== null) {
          this.failNext = null;
          this.planned(rec, my, { mode: "unavailable", reason: failNext });
          return;
        }
        this.planCalls++;
        return this.d.plan(rec.file).then((p) => this.planned(rec, my, p));
      })
      .catch((e: unknown) => {
        if (this.current(rec, my)) this.fail(rec.file, `asking for the copy failed: ${String(e)}`);
      });
  }

  private planned(rec: FileRecord, my: number, p: ScrubPlan): void {
    if (!this.current(rec, my) || rec.state !== "waiting") {
      // Let go (or disposed) while the plan was out: a job it started is
      // cancelled here, the only place its id is ever seen. Not when a newer
      // record of the same file is waiting for or making a job: the backend
      // runs one job per file, so that job is the newer record's.
      if (p.mode === "pending" && !this.ownsFileJob(rec.file)) this.cancelJob(p.jobId);
      return;
    }
    if (p.mode === "ready") {
      this.early.clear();
      this.becomeReady(rec, p.path);
    } else if (p.mode === "pending") {
      rec.state = "making";
      rec.jobId = p.jobId;
      const ended = this.early.get(p.jobId);
      this.early.clear();
      if (ended !== undefined) this.jobEnded(p.jobId, ended);
    } else {
      this.early.clear();
      this.fail(rec.file, `no copy: ${p.reason}`);
    }
  }

  private jobEnded(id: number, end: JobEnd): void {
    if (this.disposed) return;
    let making: FileRecord | null = null;
    let waiting = false;
    for (const rec of this.records.values()) {
      if (rec.state === "making" && rec.jobId === id) making = rec;
      if (rec.state === "waiting") waiting = true;
    }
    if (making === null) {
      // Not named yet: kept until the plan answers (one job at a time, so at
      // most one plan is out).
      if (waiting) this.early.set(id, end);
      return;
    }
    making.jobId = null;
    if ("failed" in end) this.fail(making.file, `the copy job failed: ${end.failed}`);
    else if (end.path === null) this.fail(making.file, "the copy job named no file");
    else this.becomeReady(making, end.path);
  }

  private becomeReady(rec: FileRecord, path: string): void {
    rec.state = "ready";
    rec.url = this.d.url(path);
    rec.reason = null;
    this.d.changed?.(rec.file);
    this.pump();
  }

  /* ---------------- listening ---------------- */

  private ensureListening(): Promise<void> {
    if (this.listening !== null) return this.listening.ready;
    const l: { un: (() => void) | null; ready: Promise<void> } = { un: null, ready: Promise.resolve() };
    this.listening = l;
    l.ready = this.d
      .listen({
        done: (id, path) => this.jobEnded(id, { path }),
        failed: (id, message) => this.jobEnded(id, { failed: message }),
      })
      .then(
        (un) => {
          if (this.listening !== l) {
            un();
            return;
          }
          l.un = un;
        },
        (e: unknown) => {
          // Not kept: the next file asks again.
          if (this.listening === l) this.listening = null;
          throw e;
        },
      );
    return l.ready;
  }

  private stopListeningIfIdle(): void {
    if (this.busy()) return;
    const l = this.listening;
    this.listening = null;
    this.early.clear();
    if (l?.un) l.un();
  }

  /** DEV: is a job listener held (or being set up)? */
  isListening(): boolean {
    return this.listening !== null;
  }

  /* ---------------- failing and letting go ---------------- */

  /** The file's copy is given up for the editor session. */
  fail(file: string, reason: string): void {
    const rec = this.records.get(file);
    if (rec === undefined || rec.state === "failed") return;
    const url = rec.url;
    if (rec.jobId !== null) this.cancelJob(rec.jobId);
    rec.jobId = null;
    rec.gen++;
    rec.state = "failed";
    rec.reason = reason;
    rec.url = null;
    this.queue = this.queue.filter((f) => f !== file);
    if (url !== null) this.d.released?.(file, url);
    this.d.changed?.(file);
    this.pump();
  }

  /** A copy element of this file could not play. The first time after the
   *  copy was ready it is planned again (the cache may have trimmed the file);
   *  the second time the file fails. */
  elementError(file: string, detail: string): void {
    const rec = this.records.get(file);
    if (rec === undefined || rec.state !== "ready") return;
    rec.elementErrors++;
    if (rec.elementErrors >= 2) {
      this.fail(file, `the copy would not play (${detail})`);
      return;
    }
    const url = rec.url;
    rec.gen++;
    rec.url = null;
    rec.state = "heavy";
    if (url !== null) this.d.released?.(file, url);
    this.queue.unshift(file);
    this.pump();
  }

  /** Let go of every record whose file is not in `live`: its job cancelled
   *  (once), every later answer dropped. Light and failed verdicts hold
   *  nothing and are kept, so a file that comes back is not weighed again. */
  reconcile(live: ReadonlySet<string>): void {
    if (this.disposed) return;
    let dropped = false;
    for (const rec of [...this.records.values()]) {
      if (live.has(rec.file) || rec.state === "light" || rec.state === "failed") continue;
      this.release(rec);
      dropped = true;
    }
    if (dropped) {
      this.queue = this.queue.filter((f) => this.records.has(f));
      this.pump();
      this.stopListeningIfIdle();
    }
  }

  private release(rec: FileRecord): void {
    if (rec.jobId !== null) this.cancelJob(rec.jobId);
    rec.jobId = null;
    rec.gen++;
    this.records.delete(rec.file);
    if (rec.url !== null) this.d.released?.(rec.file, rec.url);
  }

  /** A live record of `file` is waiting for or making its job. */
  private ownsFileJob(file: string): boolean {
    if (this.disposed) return false;
    const rec = this.records.get(file);
    return rec !== undefined && (rec.state === "waiting" || rec.state === "making");
  }

  private cancelJob(id: number): void {
    this.cancels++;
    this.d.cancel(id);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const rec of [...this.records.values()]) {
      if (rec.jobId !== null) this.cancelJob(rec.jobId);
      rec.jobId = null;
      rec.gen++;
    }
    this.records.clear();
    this.queue = [];
    this.disposed = true;
    const l = this.listening;
    this.listening = null;
    this.early.clear();
    if (l?.un) l.un();
  }

  snapshot(): CopyFileSnapshot[] {
    return [...this.records.values()].map((r) => ({ file: r.file, state: r.state, reason: r.reason, jobId: r.jobId }));
  }
}
