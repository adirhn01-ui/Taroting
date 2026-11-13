// Paces the seeks of a HEAVY video element while the playhead is dragged.
//
// A heavy file (a high bit rate and a keyframe only every few seconds: screen
// and game recordings) decodes every seek from the keyframe before its target.
// An exact seek late in a group of pictures takes 0.6-1.4 s there, a seek that
// lands ON a keyframe 3-48 ms. A drag writes currentTime on every pointer
// move, each write cancels the seek in flight, so during a continuous drag no
// seek ever finished and the picture stayed frozen until the pointer stopped.
//
// So, for a heavy element only, and only while a pointer drag moves the
// playhead:
//  - PAUSED: one seek in flight per element. A FAST drag aims at the keyframe
//    nearest the asked source time (a real, sharp picture at once); a SLOW one
//    seeks exactly, and the newest position waits for the seek in flight and
//    wins when it lands. A keyframe target never waits behind an exact seek
//    (it supersedes it); an exact one waits behind anything.
//  - a pointer still for REST_MS, or the release, writes the exact asked
//    frame at once: it is the last write, so the exact frame ends on screen.
//  - PLAYING: the element is HELD. It stops being the engine's clock (the
//    engine runs its own from the asked times) and is held to that clock as
//    any slaved layer is, one seek at a time. REST_MS after the last move, or
//    at the release, the hold starts to END: it ends, with no write, once the
//    element is back within the slave band of the clock (or after one more
//    re-aim, or HOLD_SETTLE_MS), so the clock is never handed to an element
//    still on its way to a position the pointer has since left.
// Anything that is not a pointer drag (a click, a key, a refresh, play, pause,
// a cut) cancels this state without a write, and the scheduler then seeks
// exactly, as it does for every light file.
//
// Idle cost: nothing. A pacer exists only for a layer that has been dragged
// over a heavy file; its rest timer, its `seeked` listener and the window's
// release listeners exist only during such a drag. The decision core reads no
// DOM global: timers, the input kind, the index and the release listening are
// injected (browserPacingDeps is the one place that touches the browser).

import { HEAVY_BITS_PER_S, heavyGap, nearestKeyframe } from "../../core/heavy-clip";
import { ipc, type KeyframeIndex } from "../../core/ipc";
import type { MediaRef } from "../../core/types";

// Tunable by feel on real heavy clips. They start at the viewer's values and
// are kept as the editor's own copies, so either can be tuned alone.

/** A drag covering at least this many median keyframe gaps of source time per
 *  wall second is FAST and aims at keyframes; slower is exact. */
export const FAST_GOPS_PER_S = 1.0;
/** A pointer held still this long (ms) gets its exact frame; a playing drag
 *  hands the clock back to the element. */
export const REST_MS = 150;
/** The pointer's speed is measured over about this much wall time (ms). */
export const SPEED_WINDOW_MS = 100;
/** Until the speed samples span this long (ms), every move is slow (exact), so
 *  a wobble right after the press never flashes a keyframe a gap away. */
export const MIN_SPEED_SPAN_MS = 30;
/** The scheduler's exact-seek margin (s): a target this close to where the
 *  element is, or is already going, is not asked again. */
export const SEEK_TOLERANCE_S = 0.01;
/** Speed samples kept: 100 ms of 240 Hz pointer events fits, and a move
 *  allocates nothing. */
export const SAMPLE_RING = 32;
/** An ending hold gives the clock back after this many re-aims at most, even
 *  when the element never lands inside the slave band. */
export const HOLD_REAIMS = 2;
/** ...and after this long (ms) at most, whatever the element does. */
export const HOLD_SETTLE_MS = 1000;

/** What the event being dispatched right now says about a seek: a pointer
 *  press, a move with the primary button held, or anything else. */
export type SeekCause = "none" | "press" | "move";

/** The slice of a <video> the pacer reads and writes. */
export interface SeekTarget {
  currentTime: number;
  readonly seeking: boolean;
  readonly readyState: number;
  addEventListener(type: "seeked", fn: () => void): void;
  removeEventListener(type: "seeked", fn: () => void): void;
}

export interface PacingTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

export interface PacingDeps {
  timers: PacingTimers;
  /** What event is being dispatched right now. */
  inputKind(): SeekCause;
  /** The played file's keyframe index, or null (never rejects). */
  keyframeTimes(path: string): Promise<KeyframeIndex | null>;
  /** Listen for the end of a pointer gesture (up, cancel, window blur);
   *  returns the remover. */
  listenEnd(onEnd: () => void): () => void;
}

/** A played file's keyframes and median gap, while it is heavy. */
export interface HeavyIndex {
  readonly times: readonly number[];
  readonly gap: number;
}

export interface PacingCounters {
  issued: number;
  landed: number;
  keyAimed: number;
  exact: number;
  superseded: number;
  deferred: number;
  heldMoves: number;
  indexAsks: number;
  cancels: number;
  rests: number;
  releases: number;
}

export interface PacerSnapshot {
  bound: boolean;
  dragging: boolean;
  held: boolean;
  flight: "none" | "key" | "exact";
  flightTarget: number;
  want: { kind: "key" | "exact"; t: number } | null;
  restArmed: boolean;
  listening: boolean;
  shownKey: number;
}

export interface PacingSnapshot {
  counters: PacingCounters;
  holding: boolean;
  listeningEnd: boolean;
  engaged: number;
  indexed: Array<{ file: string; done: boolean; heavy: boolean; forced: boolean }>;
  pacers: PacerSnapshot[];
}

/** The development seam (read only behind import.meta.env.DEV). */
export interface PacingDev {
  /** true: inputKind() is "none", so every activate is the unpaced path. */
  disabled: boolean;
  /** Skip the bit-rate precheck and the heavy thresholds (not the index's own
   *  sanity). */
  forceHeavy: boolean;
  /** With forceHeavy: only played files whose path ends with this
   *  (case-insensitive); null: every file. */
  forceOnly: string | null;
  readonly counters: PacingCounters;
  resetCounters(): void;
  snapshot(): PacingSnapshot;
  /** Run the end-of-gesture handler, as a pointerup would. */
  release(): void;
}

/** The browser's timers, event and index. Every global is looked up when a
 *  function is called, never when this is built. */
export function browserPacingDeps(): PacingDeps {
  return {
    timers: {
      now: () => performance.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    },
    inputKind: () => {
      // Every drag of the playhead seeks synchronously inside its pointermove
      // listener, and every press inside its pointerdown: the event being
      // dispatched is what made this seek.
      const ev = (globalThis as { event?: Event }).event;
      if (ev === undefined || ev === null) return "none";
      if (ev.type === "pointerdown") return "press";
      if (ev.type === "pointermove" && ((ev as PointerEvent).buttons & 1) === 1) return "move";
      return "none";
    },
    keyframeTimes: (p) => ipc.keyframeTimes(p).catch(() => null),
    listenEnd: (fn) => {
      // blur WITHOUT capture: focus events do not bubble, but a capturing
      // window listener also hears every element's blur. Only the window's
      // own blur ends the gesture.
      window.addEventListener("pointerup", fn, true);
      window.addEventListener("pointercancel", fn, true);
      window.addEventListener("blur", fn);
      return () => {
        window.removeEventListener("pointerup", fn, true);
        window.removeEventListener("pointercancel", fn, true);
        window.removeEventListener("blur", fn);
      };
    },
  };
}

/** Whether a media may be heavy at all, from its own size and duration: the
 *  free precheck before a keyframe index is asked. `force` skips the bit rate. */
export function heavyCandidate(m: MediaRef, force: boolean): boolean {
  return (
    m.kind === "video" &&
    !m.generator &&
    Number.isFinite(m.duration) &&
    m.duration > 0 &&
    (force || (Number.isFinite(m.size) && m.size > 0 && (m.size * 8) / m.duration >= HEAVY_BITS_PER_S))
  );
}

interface IndexEntry {
  done: boolean;
  /** heavy by the thresholds; null: light or unknown */
  heavy: HeavyIndex | null;
  /** heavy by the index's sanity alone (the forced view) */
  forced: HeavyIndex | null;
}

function heavyOf(ix: KeyframeIndex | null, force: boolean): HeavyIndex | null {
  const gap = heavyGap(ix, force);
  return gap === null || ix === null ? null : { times: ix.times, gap };
}

function zeroCounters(): PacingCounters {
  return {
    issued: 0, landed: 0, keyAimed: 0, exact: 0, superseded: 0, deferred: 0,
    heldMoves: 0, indexAsks: 0, cancels: 0, rests: 0, releases: 0,
  };
}

/** One per Scheduler: the index cache, the shared release listening and the
 *  counters. Built always; attaches nothing until a heavy drag. */
export class ScrubPacing {
  readonly counters: PacingCounters = zeroCounters();
  /** Layers held to the engine clock by a playing drag. */
  heldCount = 0;
  /** Layers whose hold ended and whose element may still run at a nudged
   *  rate: the scheduler puts their rate back on its next playing tick. */
  ratesDue = 0;
  private readonly index = new Map<string, IndexEntry>();
  private readonly engaged = new Set<LayerPacer>();
  private unlistenEnd: (() => void) | null = null;
  private disposed = false;
  private readonly pacers: LayerPacer[] = [];
  private readonly devState: PacingDev;
  private readonly onEnd = (): void => {
    this.counters.releases++;
    for (const p of [...this.engaged]) p.release();
    this.engaged.clear();
    this.unlisten();
  };

  constructor(readonly deps: PacingDeps) {
    const counters = this.counters;
    this.devState = {
      disabled: false,
      forceHeavy: false,
      forceOnly: null,
      counters,
      resetCounters: () => {
        const z = zeroCounters();
        for (const k of Object.keys(z) as Array<keyof PacingCounters>) counters[k] = 0;
      },
      snapshot: () => this.snapshot(),
      release: () => this.onEnd(),
    };
  }

  /** The cause of the seek being made now ("none" whenever pacing is off). */
  inputKind(): SeekCause {
    if (import.meta.env.DEV && this.devState.disabled) return "none";
    return this.deps.inputKind();
  }

  /** The played `file`'s keyframes while it is heavy, else null. The first
   *  call for a candidate asks the index (once per file); until it answers,
   *  null. The answer only fills the cache: no element is touched from it. */
  heavyIndex(media: MediaRef, file: string): HeavyIndex | null {
    const d = this.devState;
    const force =
      import.meta.env.DEV &&
      d.forceHeavy &&
      (d.forceOnly === null || file.toLowerCase().endsWith(d.forceOnly.toLowerCase()));
    if (file === "" || !heavyCandidate(media, force)) return null;
    const e = this.index.get(file);
    if (e === undefined) {
      this.index.set(file, { done: false, heavy: null, forced: null });
      this.counters.indexAsks++;
      this.deps.keyframeTimes(file).then(
        (ix) => {
          if (this.disposed) return;
          this.index.set(file, { done: true, heavy: heavyOf(ix, false), forced: heavyOf(ix, true) });
        },
        () => {
          if (!this.disposed) this.index.set(file, { done: true, heavy: null, forced: null });
        },
      );
      return null;
    }
    if (!e.done) return null;
    return force ? e.forced : e.heavy;
  }

  createPacer(): LayerPacer {
    const p = new LayerPacer(this);
    this.pacers.push(p);
    return p;
  }

  engage(p: LayerPacer): void {
    this.engaged.add(p);
    if (this.unlistenEnd === null) this.unlistenEnd = this.deps.listenEnd(this.onEnd);
  }

  disengage(p: LayerPacer): void {
    this.engaged.delete(p);
    if (this.engaged.size === 0) this.unlisten();
  }

  private unlisten(): void {
    if (this.unlistenEnd !== null) {
      this.unlistenEnd();
      this.unlistenEnd = null;
    }
  }

  /** Some layer is held to the engine clock by a playing drag. */
  holding(): boolean {
    return this.heldCount > 0;
  }

  dev(): PacingDev {
    return this.devState;
  }

  snapshot(): PacingSnapshot {
    const indexed: PacingSnapshot["indexed"] = [];
    for (const [file, e] of this.index) {
      indexed.push({ file, done: e.done, heavy: e.heavy !== null, forced: e.forced !== null });
    }
    return {
      counters: { ...this.counters },
      holding: this.holding(),
      listeningEnd: this.unlistenEnd !== null,
      engaged: this.engaged.size,
      indexed,
      pacers: this.pacers.map((p) => p.snapshot()),
    };
  }

  /** Forget everything without a write; a late index answer is ignored. */
  dispose(): void {
    for (const p of this.pacers) p.reset();
    this.engaged.clear();
    this.unlisten();
    this.heldCount = 0;
    this.ratesDue = 0;
    this.disposed = true;
    this.index.clear();
  }
}

type Flight = "none" | "key" | "exact";

/** One per video layer, created on its first heavy drag, bound to one
 *  (element, clip, url) at a time. */
export class LayerPacer {
  private el: SeekTarget | null = null;
  private clipId: string | null = null;
  private url: string | null = null;
  private times: readonly number[] = [];
  private gap = 0;

  private dragging = false;
  /** Held to the engine clock by a playing drag (no writes of its own). */
  private held = false;
  /** The current drag began (or went on) while playing: its rest and release
   *  write nothing, the element plays on from the clock. */
  private playDrag = false;
  /** The hold is ending: the pointer rested or let go, and the clock goes
   *  back to the element once it is on the clock again (clockChecked). */
  private holdEnding = false;
  /** Re-aims seen while the hold is ending. */
  private reaims = 0;
  /** The hold ended and the element may still run at a slave's nudged rate:
   *  the scheduler puts its own rate back (takeRateDue). */
  private rateDue = false;
  /** The asked source time (s). */
  private cursor = 0;

  private readonly ringT = new Float64Array(SAMPLE_RING);
  private readonly ringAt = new Float64Array(SAMPLE_RING);
  private head = 0;
  private count = 0;

  private flight: Flight = "none";
  private flightTarget = Number.NaN;
  /** The keyframe a landed keyframe seek put on screen; NaN otherwise. */
  private shownKey = Number.NaN;
  /** ONE target waiting for the seek in flight (the latest wins). */
  private wantKind: Flight = "none";
  private wantT = Number.NaN;

  private restTimer: number | undefined;
  private listening = false;
  /** No state, timer or listener at all: cancel() is one field read. */
  private idle = true;

  private readonly onSeeked = (): void => this.seeked();
  private readonly onRest = (): void => this.rested();

  constructor(private readonly pacing: ScrubPacing) {}

  /** Bind to the element now showing `clipId` from `url`. A different
   *  binding forgets everything about the old one first. */
  bind(el: SeekTarget, clipId: string, url: string, idx: HeavyIndex): void {
    if (el !== this.el || clipId !== this.clipId || url !== this.url) {
      this.reset();
      this.el = el;
      this.clipId = clipId;
      this.url = url;
    }
    this.times = idx.times;
    this.gap = idx.gap;
  }

  /** A pointer press: the scheduler writes the exact seek itself. Remembered
   *  as the first speed sample of the drag that may follow. */
  press(c: number): void {
    this.cancel();
    this.count = 0;
    this.head = 0;
    this.pushSample(c, this.pacing.deps.timers.now());
    this.cursor = c;
  }

  /** A paused drag moved the playhead to source time `c`. */
  move(c: number): void {
    const el = this.el;
    if (el === null) return;
    if (this.held) this.endHold();
    this.playDrag = false;
    this.dragging = true;
    this.idle = false;
    this.pacing.engage(this);
    this.attach();
    // The press's own exact seek (or one made before the index answered) is
    // still decoding: it is the seek in flight.
    if (this.flight === "none" && el.seeking) {
      this.flight = "exact";
      this.flightTarget = el.currentTime;
    }
    this.cursor = c;
    const now = this.pacing.deps.timers.now();
    this.pushSample(c, now);
    this.armRest();
    if (this.speed(now) >= FAST_GOPS_PER_S * this.gap) this.aimKey(nearestKeyframe(this.times, c));
    else this.aimExact(c);
  }

  /** A playing drag moved the playhead to source time `c`: never writes. */
  hold(c: number): void {
    if (this.el === null) return;
    if (this.flight !== "none" || this.wantKind !== "none") {
      this.flight = "none";
      this.clearWant();
      this.shownKey = Number.NaN;
    }
    this.detach();
    this.dragging = true;
    this.playDrag = true;
    this.idle = false;
    this.holdEnding = false;
    if (!this.held) {
      this.held = true;
      this.pacing.heldCount++;
    }
    this.pacing.engage(this);
    this.cursor = c;
    this.armRest();
    this.pacing.counters.heldMoves++;
  }

  /** `e` is held to the engine clock: its position is not the playhead. */
  holdsClock(e: SeekTarget): boolean {
    return this.held && e === this.el;
  }

  /** The scheduler held `e` to the clock on a playing tick: `inBand` when it
   *  needed no seek to stay there. An ending hold ends then (or after
   *  HOLD_REAIMS re-aims). */
  clockChecked(e: SeekTarget, inBand: boolean): void {
    if (!this.holdEnding || e !== this.el) return;
    if (inBand || ++this.reaims >= HOLD_REAIMS) this.endHold();
  }

  /** Whether `e`'s hold ended since the last call and its rate is still to be
   *  put back (cleared by the call). The pacer never writes a rate itself. */
  takeRateDue(e: SeekTarget): boolean {
    if (!this.rateDue || e !== this.el) return false;
    this.clearRateDue();
    return true;
  }

  /** The gesture ended (pointer up, cancel, window blur). */
  release(): void {
    this.dragging = false;
    this.clearRest();
    this.count = 0;
    this.head = 0;
    if (this.held) {
      // No write: the hold ends once the element is on the clock again.
      if (!this.holdEnding) this.beginHoldEnd();
      else this.armTimer(HOLD_SETTLE_MS);
    } else if (!this.playDrag && this.el !== null) {
      this.settleExact();
    }
    this.playDrag = false;
    if (this.flight === "none" && !this.held) {
      this.detach();
      this.idle = true;
    }
  }

  /** Drop every pending seek, timer and listener. Never writes. */
  cancel(): void {
    this.clearRateDue();
    if (this.idle) return;
    this.clearRest();
    this.clearWant();
    this.flight = "none";
    this.flightTarget = Number.NaN;
    this.shownKey = Number.NaN;
    this.count = 0;
    this.head = 0;
    if (this.held) this.pacing.heldCount--;
    this.dragging = false;
    this.held = false;
    this.holdEnding = false;
    this.playDrag = false;
    this.detach();
    this.pacing.disengage(this);
    this.idle = true;
    this.pacing.counters.cancels++;
  }

  /** cancel(), then forget the binding. */
  reset(): void {
    this.cancel();
    this.el = null;
    this.clipId = null;
    this.url = null;
    this.times = [];
    this.gap = 0;
    this.count = 0;
    this.head = 0;
  }

  /** The element `e` errored: if it is the bound one, forget it. */
  forget(e: SeekTarget): void {
    if (e === this.el) this.reset();
  }

  dispose(): void {
    this.reset();
  }

  snapshot(): PacerSnapshot {
    return {
      bound: this.el !== null,
      dragging: this.dragging,
      held: this.held,
      flight: this.flight,
      flightTarget: this.flightTarget,
      want: this.wantKind === "none" ? null : { kind: this.wantKind, t: this.wantT },
      restArmed: this.restTimer !== undefined,
      listening: this.listening,
      shownKey: this.shownKey,
    };
  }

  /* ---------------- internals ---------------- */

  private seeked(): void {
    const el = this.el;
    if (el === null || el.seeking || this.flight === "none") return;
    this.land();
    const kind = this.wantKind;
    const t = this.wantT;
    this.clearWant();
    if (kind !== "none" && this.dragging && !this.held) {
      if (kind === "key") this.aimKey(t);
      else this.aimExact(t);
    }
    // land() and the aim above moved the flight (the narrowing above is stale).
    if (!this.dragging && (this.flight as Flight) === "none") {
      this.detach();
      if (this.restTimer === undefined) this.idle = true;
    }
  }

  private rested(): void {
    this.restTimer = undefined;
    this.pacing.counters.rests++;
    if (this.held) {
      // The pointer rested: the hold starts to end. A second firing is the
      // HOLD_SETTLE_MS bound: the clock goes back now, whatever the element.
      if (!this.holdEnding) this.beginHoldEnd();
      else this.endHold();
      return;
    }
    if (this.playDrag || this.el === null) return;
    this.settleExact();
  }

  private beginHoldEnd(): void {
    this.holdEnding = true;
    this.reaims = 0;
    this.armTimer(HOLD_SETTLE_MS);
  }

  /** The held element is the clock again. No write. */
  private endHold(): void {
    if (!this.held) return;
    this.held = false;
    this.holdEnding = false;
    this.pacing.heldCount--;
    if (!this.rateDue) {
      this.rateDue = true;
      this.pacing.ratesDue++;
    }
    this.clearRest();
    if (!this.dragging && this.flight === "none") {
      this.detach();
      this.idle = true;
    }
  }

  /** The exact asked frame, now: the last write of a resting or released
   *  paused drag. Nothing when that exact target is already in flight or
   *  already shown. */
  private settleExact(): void {
    const el = this.el!;
    this.clearWant();
    const c = this.cursor;
    if (this.flight === "exact" && Math.abs(this.flightTarget - c) <= SEEK_TOLERANCE_S) return;
    if (this.flight === "none" && !el.seeking && Math.abs(el.currentTime - c) <= SEEK_TOLERANCE_S) return;
    if (this.flight !== "none") this.pacing.counters.superseded++;
    this.issue("exact", c);
  }

  private aimKey(k: number): void {
    // Already on its way, or already on screen: nothing new to show.
    if (this.flight === "key" && k === this.flightTarget) {
      this.clearWant();
      return;
    }
    if (this.flight === "none" && k === this.shownKey) {
      this.clearWant();
      return;
    }
    if (this.flight === "key") {
      this.setWant("key", k);
      return;
    }
    this.clearWant();
    // A keyframe never waits behind an exact seek: the write supersedes it.
    if (this.flight === "exact") this.pacing.counters.superseded++;
    this.issue("key", k);
  }

  private aimExact(c: number): void {
    const el = this.el!;
    if (this.flight === "none") {
      this.clearWant();
      if (!el.seeking && Math.abs(el.currentTime - c) <= SEEK_TOLERANCE_S) return;
      this.issue("exact", c);
      return;
    }
    if (this.flight === "exact" && Math.abs(this.flightTarget - c) <= SEEK_TOLERANCE_S) {
      this.clearWant();
      return;
    }
    this.setWant("exact", c);
  }

  private issue(kind: "key" | "exact", t: number): void {
    const el = this.el!;
    el.currentTime = t;
    this.flight = kind;
    this.flightTarget = t;
    const c = this.pacing.counters;
    c.issued++;
    if (kind === "key") c.keyAimed++;
    else {
      c.exact++;
      this.shownKey = Number.NaN;
    }
    // Settled at once (a frame already decoded): it has landed.
    if (!el.seeking) this.land();
  }

  private land(): void {
    const el = this.el!;
    this.pacing.counters.landed++;
    this.shownKey =
      this.flight === "key" && Math.abs(el.currentTime - this.flightTarget) <= SEEK_TOLERANCE_S
        ? this.flightTarget
        : Number.NaN;
    this.flight = "none";
  }

  private setWant(kind: "key" | "exact", t: number): void {
    this.wantKind = kind;
    this.wantT = t;
    this.pacing.counters.deferred++;
  }

  private clearRateDue(): void {
    if (this.rateDue) {
      this.rateDue = false;
      this.pacing.ratesDue--;
    }
  }

  private clearWant(): void {
    this.wantKind = "none";
    this.wantT = Number.NaN;
  }

  private pushSample(t: number, at: number): void {
    this.ringT[this.head] = t;
    this.ringAt[this.head] = at;
    this.head = (this.head + 1) % SAMPLE_RING;
    if (this.count < SAMPLE_RING) this.count++;
  }

  /** Source seconds per wall second, from the newest sample to the oldest one
   *  inside SPEED_WINDOW_MS (or the one before the newest when none other is):
   *  the viewer's formula over a fixed ring. 0 until the span reaches
   *  MIN_SPEED_SPAN_MS. */
  private speed(now: number): number {
    if (this.count < 2) return 0;
    const n = SAMPLE_RING;
    const newest = (this.head - 1 + n) % n;
    let pick = -1;
    for (let i = 1; i < this.count; i++) {
      const idx = (this.head - 1 - i + 2 * n) % n;
      if (this.ringAt[idx]! >= now - SPEED_WINDOW_MS) pick = idx;
      else break;
    }
    if (pick < 0) pick = (this.head - 2 + n) % n;
    const dt = this.ringAt[newest]! - this.ringAt[pick]!;
    if (dt < MIN_SPEED_SPAN_MS) return 0;
    return (Math.abs(this.ringT[newest]! - this.ringT[pick]!) * 1000) / dt;
  }

  private armRest(): void {
    this.armTimer(REST_MS);
  }

  /** The one timer: the rest wait, or an ending hold's bound. */
  private armTimer(ms: number): void {
    const t = this.pacing.deps.timers;
    t.clearTimeout(this.restTimer);
    this.restTimer = t.setTimeout(this.onRest, ms);
  }

  private clearRest(): void {
    if (this.restTimer !== undefined) {
      this.pacing.deps.timers.clearTimeout(this.restTimer);
      this.restTimer = undefined;
    }
  }

  private attach(): void {
    if (this.listening || this.el === null) return;
    this.el.addEventListener("seeked", this.onSeeked);
    this.listening = true;
  }

  private detach(): void {
    if (!this.listening) return;
    this.el?.removeEventListener("seeked", this.onSeeked);
    this.listening = false;
  }
}
