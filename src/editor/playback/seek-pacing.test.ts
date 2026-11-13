// The seek pacing's decision core (seek-pacing.ts), driven directly: a fake
// element whose seeks stay in flight until the test lands them, and fake
// timers. Keyframes [0, 2.1, 4.0, 6.3, 8.4] (median gap 2.1); no cursor value
// below sits on a keyframe, so a keyframe write and an exact write can never
// be mistaken for each other.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HEAVY_BITS_PER_S } from "../../core/heavy-clip";
import type { KeyframeIndex } from "../../core/ipc";
import type { MediaRef } from "../../core/types";
import {
  browserPacingDeps,
  FAST_GOPS_PER_S,
  heavyCandidate,
  HOLD_REAIMS,
  HOLD_SETTLE_MS,
  MIN_SPEED_SPAN_MS,
  REST_MS,
  SAMPLE_RING,
  ScrubPacing,
  SPEED_WINDOW_MS,
  type HeavyIndex,
  type LayerPacer,
  type SeekTarget,
} from "./seek-pacing";
import { fakePacingDeps, type FakePacing } from "./test-fakes";

const TIMES = [0, 2.1, 4.0, 6.3, 8.4];
const IDX: HeavyIndex = { times: TIMES, gap: 2.1 };

/** A <video>'s seek surface: a write is in flight (seeking) until land(). */
class FakeTarget implements SeekTarget {
  seeking = false;
  readyState = 4;
  /** false: a write settles at once (a frame already decoded) */
  latent = true;
  writes: number[] = [];
  private ct = 0;
  private readonly ls = new Set<() => void>();
  get currentTime(): number {
    return this.ct;
  }
  set currentTime(v: number) {
    this.ct = v;
    this.writes.push(v);
    this.seeking = this.latent;
  }
  addEventListener(_type: "seeked", fn: () => void): void {
    this.ls.add(fn);
  }
  removeEventListener(_type: "seeked", fn: () => void): void {
    this.ls.delete(fn);
  }
  get listeners(): number {
    return this.ls.size;
  }
  /** The seek in flight lands: `seeked` fires. */
  land(): void {
    this.seeking = false;
    for (const fn of [...this.ls]) fn();
  }
}

interface Rig {
  f: FakePacing;
  sp: ScrubPacing;
  p: LayerPacer;
  el: FakeTarget;
}

function rig(): Rig {
  const f = fakePacingDeps();
  const sp = new ScrubPacing(f.deps);
  const p = sp.createPacer();
  const el = new FakeTarget();
  p.bind(el, "c1", "u1", IDX);
  return { f, sp, p, el };
}

/** The press as the scheduler makes it: its own exact write, then press(). */
function press(r: Rig, c: number): void {
  r.el.currentTime = c;
  r.p.press(c);
}

/** Fast moves: `n` moves `dt` ms apart, each `step` source seconds on. */
function moves(r: Rig, from: number, step: number, n: number, dt = 10): number {
  let c = from;
  for (let i = 0; i < n; i++) {
    r.f.advance(dt);
    c += step;
    r.p.move(c);
  }
  return c;
}

describe("press", () => {
  it("writes nothing, arms no timer and attaches no listener", () => {
    const r = rig();
    r.p.press(1.2);
    expect(r.el.writes).toEqual([]);
    expect(r.f.pending()).toBe(0);
    expect(r.el.listeners).toBe(0);
    expect(r.f.endListeners()).toBe(0);
  });

  it("a first slow move while the press's seek decodes waits for it (adopted), then the latest wins", () => {
    const r = rig();
    press(r, 1.2);
    r.el.writes.length = 0;
    r.f.advance(10);
    r.p.move(1.3);
    expect(r.el.writes).toEqual([]);
    r.el.land();
    expect(r.el.writes).toEqual([1.3]);
  });
});

describe("slow moves", () => {
  it("queue behind the exact seek in flight; one write of the LAST cursor when it lands", () => {
    const r = rig();
    press(r, 1.2);
    r.el.writes.length = 0;
    // 0.01 s per 40 ms: far below 2.1 s/s
    for (const c of [1.21, 1.23, 1.26]) {
      r.f.advance(40);
      r.p.move(c);
    }
    expect(r.el.writes).toEqual([]);
    expect(r.p.snapshot().want).toEqual({ kind: "exact", t: 1.26 });
    expect(r.el.listeners).toBe(1);
    r.el.land();
    expect(r.el.writes).toEqual([1.26]);
  });
});

describe("fast moves", () => {
  it("aim at the nearest keyframe, superseding an exact seek in flight", () => {
    const r = rig();
    press(r, 0.5);
    r.el.writes.length = 0;
    // 0.5 s every 10 ms = 50 s/s; the span reaches 30 ms on the third move
    moves(r, 0.5, 0.5, 2);
    expect(r.el.writes).toEqual([]); // slow until the span is long enough: queued behind the press
    const before = r.sp.counters.superseded;
    r.f.advance(10);
    r.p.move(2.2);
    expect(r.el.writes).toEqual([2.1]);
    expect(r.el.writes[0]).not.toBe(2.2);
    expect(r.sp.counters.superseded).toBe(before + 1);
    expect(r.sp.counters.keyAimed).toBe(1);
  });

  it("a further fast move while that keyframe is in flight queues, the same keyframe asks nothing", () => {
    const r = rig();
    press(r, 0.5);
    moves(r, 0.5, 0.5, 2);
    r.f.advance(10);
    r.p.move(2.2); // key 2.1 in flight
    r.el.writes.length = 0;
    r.f.advance(10);
    r.p.move(2.4); // nearest is still 2.1: nothing
    expect(r.el.writes).toEqual([]);
    expect(r.p.snapshot().want).toBeNull();
    r.f.advance(10);
    r.p.move(3.7); // nearest 4.0: waits
    expect(r.el.writes).toEqual([]);
    expect(r.p.snapshot().want).toEqual({ kind: "key", t: 4.0 });
    r.el.land();
    expect(r.el.writes).toEqual([4.0]);
  });

  it("a keyframe already on screen is not asked again", () => {
    const r = rig();
    press(r, 0.5);
    moves(r, 0.5, 0.5, 2);
    r.f.advance(10);
    r.p.move(2.2);
    r.el.land(); // 2.1 shown
    expect(r.p.snapshot().shownKey).toBe(2.1);
    r.el.writes.length = 0;
    r.f.advance(10);
    r.p.move(2.6);
    expect(r.el.writes).toEqual([]);
  });

  it("a wobble inside MIN_SPEED_SPAN_MS of the press stays exact even across a whole gap", () => {
    const r = rig();
    r.el.latent = false;
    press(r, 1.0);
    r.el.writes.length = 0;
    r.f.advance(MIN_SPEED_SPAN_MS - 22);
    r.p.move(4.5);
    expect(r.el.writes).toEqual([4.5]);
    expect(r.sp.counters.keyAimed).toBe(0);
  });
});

describe("rest", () => {
  it("REST_MS after the last move writes the exact cursor, superseding a keyframe in flight", () => {
    const r = rig();
    press(r, 0.5);
    const c = moves(r, 0.5, 0.55, 3); // 2.15: key 2.1 in flight
    expect(r.el.writes.at(-1)).toBe(2.1);
    const sup = r.sp.counters.superseded;
    r.el.writes.length = 0;
    r.f.advance(REST_MS - 1);
    expect(r.el.writes).toEqual([]);
    r.f.advance(1);
    expect(r.el.writes).toEqual([c]);
    expect(r.sp.counters.superseded).toBe(sup + 1);
  });

  it("writes nothing when that exact target is already in flight", () => {
    const r = rig();
    press(r, 1.2);
    r.f.advance(40);
    r.p.move(1.205); // within 0.01 of the press's seek in flight
    r.el.writes.length = 0;
    r.f.advance(REST_MS);
    expect(r.el.writes).toEqual([]);
  });

  it("writes nothing when the element already sits there, settled", () => {
    const r = rig();
    r.el.latent = false;
    press(r, 1.2);
    r.f.advance(40);
    r.p.move(1.25); // exact, settles at once
    r.el.writes.length = 0;
    r.f.advance(REST_MS);
    expect(r.el.writes).toEqual([]);
    expect(r.sp.counters.rests).toBe(1);
  });
});

describe("release", () => {
  it("writes the exact cursor at once, clears the timer, and lets go of every listener once landed", () => {
    const r = rig();
    press(r, 0.5);
    const c = moves(r, 0.5, 0.55, 3);
    expect(r.f.endListeners()).toBe(1);
    r.el.writes.length = 0;
    r.f.end();
    expect(r.el.writes).toEqual([c]);
    expect(r.f.pending()).toBe(0);
    expect(r.f.endListeners()).toBe(0);
    expect(r.el.listeners).toBe(1); // settling: the exact seek is in flight
    r.el.land();
    expect(r.el.listeners).toBe(0);
    expect(r.sp.counters.releases).toBe(1);
  });
});

describe("hold (a playing drag)", () => {
  it("never writes; holds the bound element only; the rest starts the hold's end", () => {
    const r = rig();
    r.p.hold(3.3);
    r.f.advance(10);
    r.p.hold(5.1);
    expect(r.el.writes).toEqual([]);
    expect(r.p.holdsClock(r.el)).toBe(true);
    expect(r.p.holdsClock(new FakeTarget())).toBe(false);
    expect(r.sp.holding()).toBe(true);
    r.f.advance(REST_MS);
    // still held: the element may be on its way to a position the pointer left
    expect(r.sp.holding()).toBe(true);
    r.p.clockChecked(new FakeTarget(), true); // another element: ignored
    expect(r.sp.holding()).toBe(true);
    r.p.clockChecked(r.el, true); // back in the slave band: the clock is its again
    expect(r.sp.holding()).toBe(false);
    expect(r.p.holdsClock(r.el)).toBe(false);
    expect(r.f.pending()).toBe(0);
    r.f.end();
    expect(r.el.writes).toEqual([]);
    expect(r.f.endListeners()).toBe(0);
  });

  it("a moving hold ignores clock checks; an ending one ends after HOLD_REAIMS re-aims", () => {
    const r = rig();
    r.p.hold(3.3);
    r.p.clockChecked(r.el, true);
    expect(r.sp.holding()).toBe(true);
    r.f.end();
    expect(r.sp.holding()).toBe(true);
    for (let i = 1; i < HOLD_REAIMS; i++) {
      r.p.clockChecked(r.el, false);
      expect(r.sp.holding()).toBe(true);
    }
    r.p.clockChecked(r.el, false);
    expect(r.sp.holding()).toBe(false);
    expect(r.f.pending()).toBe(0);
    expect(r.el.writes).toEqual([]);
  });

  it("an ending hold ends HOLD_SETTLE_MS after the release whatever the element does", () => {
    const r = rig();
    r.p.hold(3.3);
    r.f.end();
    r.f.advance(HOLD_SETTLE_MS - 1);
    expect(r.sp.holding()).toBe(true);
    r.f.advance(1);
    expect(r.sp.holding()).toBe(false);
    expect(r.f.pending()).toBe(0);
    expect(r.el.writes).toEqual([]);
    // and a rested hold the same, HOLD_SETTLE_MS after the rest
    r.p.hold(4);
    r.f.advance(REST_MS + HOLD_SETTLE_MS - 1);
    expect(r.sp.holding()).toBe(true);
    r.f.advance(1);
    expect(r.sp.holding()).toBe(false);
  });

  it("a new move during the hold's end holds again", () => {
    const r = rig();
    r.p.hold(3.3);
    r.f.advance(REST_MS);
    r.p.hold(3.5);
    r.p.clockChecked(r.el, true);
    expect(r.sp.holding()).toBe(true);
  });

  it("cancel ends the hold at once, without a write", () => {
    const r = rig();
    r.p.hold(3.4);
    expect(r.sp.heldCount).toBe(1);
    r.p.cancel();
    expect(r.sp.heldCount).toBe(0);
    expect(r.el.writes).toEqual([]);
    expect(r.f.pending()).toBe(0);
    expect(r.f.endListeners()).toBe(0);
  });

  it("a hold over a paused flight drops the waiting target and the listener", () => {
    const r = rig();
    press(r, 1.2);
    r.f.advance(400); // slow: waits behind the press
    r.p.move(1.5); // waits behind the press
    expect(r.p.snapshot().want).not.toBeNull();
    r.p.hold(1.6);
    expect(r.p.snapshot().want).toBeNull();
    expect(r.p.snapshot().flight).toBe("none");
    expect(r.el.listeners).toBe(0);
    r.el.writes.length = 0;
    r.el.land();
    expect(r.el.writes).toEqual([]);
  });
});

describe("cancel, reset, forget, dispose", () => {
  it("cancel on an idle pacer changes nothing", () => {
    const r = rig();
    const before = { ...r.sp.counters };
    r.p.cancel();
    expect(r.sp.counters).toEqual(before);
    expect(r.el.writes).toEqual([]);
  });

  for (const how of ["cancel", "reset", "forget", "dispose", "whole"] as const) {
    it(`${how} mid-drag with a waiting target leaves nothing behind`, () => {
      const r = rig();
      press(r, 1.2);
      r.f.advance(400); // slow: waits behind the press
      r.p.move(1.5);
      expect(r.p.snapshot().want).not.toBeNull();
      if (how === "cancel") r.p.cancel();
      else if (how === "reset") r.p.reset();
      else if (how === "forget") r.p.forget(r.el);
      else if (how === "dispose") r.p.dispose();
      else r.sp.dispose();
      expect(r.el.listeners).toBe(0);
      expect(r.f.pending()).toBe(0);
      expect(r.f.endListeners()).toBe(0);
      r.el.writes.length = 0;
      r.el.land();
      r.f.advance(1000);
      expect(r.el.writes).toEqual([]);
    });
  }

  it("forget of another element keeps the drag", () => {
    const r = rig();
    press(r, 1.2);
    r.f.advance(400); // slow: waits behind the press
    r.p.move(1.5);
    r.p.forget(new FakeTarget());
    expect(r.p.snapshot().want).not.toBeNull();
  });
});

describe("bind", () => {
  for (const what of ["element", "clip", "url"] as const) {
    it(`a different ${what} resets: a waiting target never reaches the new binding`, () => {
      const r = rig();
      press(r, 1.2);
      r.f.advance(400); // slow: waits behind the press
      r.p.move(1.5);
      expect(r.p.snapshot().want).not.toBeNull();
      const other = new FakeTarget();
      if (what === "element") r.p.bind(other, "c1", "u1", IDX);
      else if (what === "clip") r.p.bind(r.el, "c2", "u1", IDX);
      else r.p.bind(r.el, "c1", "u2", IDX);
      expect(r.p.snapshot().want).toBeNull();
      r.el.writes.length = 0;
      r.el.land();
      other.land();
      r.f.advance(1000);
      expect(r.el.writes).toEqual([]);
      expect(other.writes).toEqual([]);
    });
  }

  it("the same binding keeps the drag", () => {
    const r = rig();
    press(r, 1.2);
    r.f.advance(400); // slow: waits behind the press
    r.p.move(1.5);
    r.p.bind(r.el, "c1", "u1", IDX);
    expect(r.p.snapshot().want).toEqual({ kind: "exact", t: 1.5 });
  });
});

describe("a seek that settles at once", () => {
  it("lands synchronously, and a keyframe counts as shown", () => {
    const r = rig();
    r.el.latent = false;
    press(r, 0.5);
    moves(r, 0.5, 0.55, 2);
    const landed = r.sp.counters.landed;
    r.f.advance(10);
    r.p.move(2.15);
    expect(r.el.writes.at(-1)).toBe(2.1);
    expect(r.p.snapshot().flight).toBe("none");
    expect(r.sp.counters.landed).toBe(landed + 1);
    expect(r.p.snapshot().shownKey).toBe(2.1);
  });
});

describe("the speed ring", () => {
  it("reuses its fixed buffers and measures the viewer's speed over the window", () => {
    const r = rig();
    r.el.latent = false;
    const priv = r.p as unknown as { ringT: Float64Array; ringAt: Float64Array; speed(now: number): number };
    const ringT = priv.ringT;
    const ringAt = priv.ringAt;
    // the viewer's formula: samples oldest first, trimmed to the window but
    // never below two
    const samples: Array<{ t: number; at: number }> = [];
    let c = 0.3;
    r.p.press(c);
    samples.push({ t: c, at: r.f.now() });
    for (let i = 0; i < 40; i++) {
      r.f.advance(4);
      c += 0.003 * (i % 3 === 0 ? -1 : 2);
      r.p.move(c);
      const now = r.f.now();
      samples.push({ t: c, at: now });
      while (samples.length > 2 && samples[0]!.at < now - SPEED_WINDOW_MS) samples.shift();
      const a = samples[0]!;
      const b = samples.at(-1)!;
      const want = b.at - a.at < MIN_SPEED_SPAN_MS ? 0 : (Math.abs(b.t - a.t) * 1000) / (b.at - a.at);
      expect(priv.speed(now)).toBeCloseTo(want, 9);
    }
    expect(priv.ringT).toBe(ringT);
    expect(priv.ringAt).toBe(ringAt);
    expect(ringT.length).toBe(SAMPLE_RING);
    // a slow drag made no keyframe seek
    expect(r.sp.counters.keyAimed).toBe(0);
    expect(FAST_GOPS_PER_S * IDX.gap).toBeGreaterThan(0.5);
  });
});

/* ------------------------------------------------------------------ */
/* the precheck and the index                                          */
/* ------------------------------------------------------------------ */

const BYTES_AT_LIMIT = (HEAVY_BITS_PER_S * 10) / 8; // a 10 s file exactly at the limit

function media(over: Partial<MediaRef> = {}): MediaRef {
  return { id: "m", path: "C:\\v.mp4", kind: "video", duration: 10, size: BYTES_AT_LIMIT, ...over } as MediaRef;
}

describe("heavyCandidate", () => {
  it("passes at the bit-rate limit and fails just below it", () => {
    expect(heavyCandidate(media(), false)).toBe(true);
    expect(heavyCandidate(media({ size: BYTES_AT_LIMIT - 1 }), false)).toBe(false);
  });

  it("refuses generators, images, audio, a bad duration and a zero size", () => {
    expect(heavyCandidate(media({ generator: { type: "solid", color: "#000000" } } as Partial<MediaRef>), false)).toBe(false);
    expect(heavyCandidate(media({ kind: "image" }), false)).toBe(false);
    expect(heavyCandidate(media({ kind: "audio" }), false)).toBe(false);
    expect(heavyCandidate(media({ duration: Number.NaN }), false)).toBe(false);
    expect(heavyCandidate(media({ duration: 0 }), false)).toBe(false);
    expect(heavyCandidate(media({ size: 0 }), false)).toBe(false);
  });

  it("force skips the bit rate only", () => {
    expect(heavyCandidate(media({ size: 0 }), true)).toBe(true);
    expect(heavyCandidate(media({ kind: "image" }), true)).toBe(false);
    expect(heavyCandidate(media({ duration: 0 }), true)).toBe(false);
  });
});

const HEAVY_IX: KeyframeIndex = { allSync: false, times: TIMES, duration: 10, bytes: 30_000_000 };
const LIGHT_IX: KeyframeIndex = { allSync: false, times: TIMES, duration: 10, bytes: 1_000_000 };

describe("ScrubPacing.heavyIndex", () => {
  it("never asks for a non-candidate", () => {
    const f = fakePacingDeps();
    const sp = new ScrubPacing(f.deps);
    expect(sp.heavyIndex(media({ size: 1 }), "C:\\light.mp4")).toBeNull();
    expect(sp.heavyIndex(media(), "")).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("asks once per file across calls and pacers; null until the answer, then the heavy index", async () => {
    const f = fakePacingDeps();
    const sp = new ScrubPacing(f.deps);
    sp.createPacer();
    sp.createPacer();
    expect(sp.heavyIndex(media(), "C:\\a.mp4")).toBeNull();
    expect(sp.heavyIndex(media(), "C:\\a.mp4")).toBeNull();
    expect(sp.heavyIndex(media(), "C:\\b.mp4")).toBeNull();
    expect(f.calls).toEqual(["C:\\a.mp4", "C:\\b.mp4"]);
    f.answers.set("C:\\a.mp4", HEAVY_IX);
    f.answers.set("C:\\b.mp4", LIGHT_IX);
    await f.flush();
    const a = sp.heavyIndex(media(), "C:\\a.mp4");
    expect(a?.gap).toBeCloseTo(2.1, 12);
    expect(a?.times).toBe(TIMES);
    // the same object every time: a move allocates nothing
    expect(sp.heavyIndex(media(), "C:\\a.mp4")).toBe(a);
    expect(sp.heavyIndex(media(), "C:\\b.mp4")).toBeNull();
    expect(f.calls.length).toBe(2);
    expect(sp.counters.indexAsks).toBe(2);
  });

  it("forceHeavy with forceOnly affects only the matching file", async () => {
    const f = fakePacingDeps();
    const sp = new ScrubPacing(f.deps);
    const dev = sp.dev();
    dev.forceHeavy = true;
    dev.forceOnly = "COUNTER.mp4";
    // forced: no bit-rate precheck for the matching file only
    expect(sp.heavyIndex(media({ size: 1 }), "C:\\x\\counter.mp4")).toBeNull();
    expect(sp.heavyIndex(media({ size: 1 }), "C:\\x\\other.mp4")).toBeNull();
    expect(f.calls).toEqual(["C:\\x\\counter.mp4"]);
    sp.heavyIndex(media(), "C:\\x\\other.mp4");
    f.answers.set("C:\\x\\counter.mp4", LIGHT_IX);
    f.answers.set("C:\\x\\other.mp4", LIGHT_IX);
    await f.flush();
    expect(sp.heavyIndex(media({ size: 1 }), "C:\\x\\counter.mp4")?.gap).toBeCloseTo(2.1, 12);
    expect(sp.heavyIndex(media(), "C:\\x\\other.mp4")).toBeNull();
  });

  it("disabled makes inputKind() none", () => {
    const f = fakePacingDeps();
    const sp = new ScrubPacing(f.deps);
    f.kind = "move";
    expect(sp.inputKind()).toBe("move");
    sp.dev().disabled = true;
    expect(sp.inputKind()).toBe("none");
  });

  it("ignores an answer after dispose", async () => {
    const f = fakePacingDeps();
    const sp = new ScrubPacing(f.deps);
    sp.heavyIndex(media(), "C:\\a.mp4");
    sp.dispose();
    f.answers.set("C:\\a.mp4", HEAVY_IX);
    await f.flush();
    expect(sp.snapshot().indexed).toEqual([]);
  });

  it("a rejected ask is cached as no index and never asked again", async () => {
    const f = fakePacingDeps();
    const sp = new ScrubPacing(f.deps);
    sp.heavyIndex(media(), "C:\\a.mp4");
    f.answers.set("C:\\a.mp4", new Error("read failed"));
    await f.flush();
    expect(sp.heavyIndex(media(), "C:\\a.mp4")).toBeNull();
    expect(sp.snapshot().indexed).toEqual([{ file: "C:\\a.mp4", done: true, heavy: false, forced: false }]);
    expect(f.calls.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* the browser's input kind                                            */
/* ------------------------------------------------------------------ */

describe("browserPacingDeps().inputKind", () => {
  const g = globalThis as { event?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "event");
  const saved = g.event;
  afterEach(() => {
    if (had) g.event = saved;
    else delete g.event;
  });

  it("classifies the event being dispatched", () => {
    const kind = browserPacingDeps().inputKind;
    g.event = { type: "pointerdown", buttons: 1 };
    expect(kind()).toBe("press");
    g.event = { type: "pointermove", buttons: 1 };
    expect(kind()).toBe("move");
    g.event = { type: "pointermove", buttons: 3 };
    expect(kind()).toBe("move");
    g.event = { type: "pointermove", buttons: 0 };
    expect(kind()).toBe("none");
    g.event = { type: "pointermove", buttons: 2 };
    expect(kind()).toBe("none");
    g.event = { type: "keydown" };
    expect(kind()).toBe("none");
    g.event = { type: "click" };
    expect(kind()).toBe("none");
    g.event = undefined;
    expect(kind()).toBe("none");
  });
});

describe("browserPacingDeps().listenEnd", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures pointerup/pointercancel, but hears only the WINDOW's own blur", () => {
    // A capturing window listener would also hear every element's blur (focus
    // events do not bubble, but they do pass the capture phase).
    const log: string[] = [];
    const live = new Set<string>();
    const key = (type: string, capture: unknown): string => `${type}:${capture === true ? "capture" : "bubble"}`;
    vi.stubGlobal("window", {
      addEventListener: (type: string, _fn: unknown, capture?: unknown) => {
        log.push(`+${key(type, capture)}`);
        live.add(key(type, capture));
      },
      removeEventListener: (type: string, _fn: unknown, capture?: unknown) => {
        log.push(`-${key(type, capture)}`);
        live.delete(key(type, capture));
      },
    });
    const off = browserPacingDeps().listenEnd(() => {});
    expect(log).toEqual(["+pointerup:capture", "+pointercancel:capture", "+blur:bubble"]);
    off();
    expect(live.size).toBe(0);
  });
});
