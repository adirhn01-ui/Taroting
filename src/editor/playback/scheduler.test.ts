// The scheduler's per-layer behaviour, driven through the real Scheduler
// against the fakes in test-fakes.ts (vitest runs in node, with no DOM).
//
// Covered here:
//  - slaved video layers are drift-corrected on every playing tick, not only
//    when activate() runs (syncSlaves);
//  - an ended or errored master element stops being the clock;
//  - a preloaded element is adopted after a still, a long gap or a loop wrap;
//  - a <video> error marks its media failed, but only while still current;
//  - the text layer keeps the export's 1.25 line height;
//  - the per-tick queries stop allocating where they safely can.

import { describe, expect, it } from "vitest";
import { sourceTime, timelineTime } from "../../core/time";
import type { Clip, MediaRef } from "../../core/types";
import { cssFont } from "../media/generators";
import type { MediaState } from "../media/media";
import { NUDGE_SEC, Scheduler, slaveRate } from "./scheduler";
import {
  clipOf,
  fakeMedia,
  fakeStage,
  projectOf,
  readyStatus,
  videoMedia,
  type FakeVideo,
} from "./test-fakes";

const FRAME = 1 / 60;

function ready(...media: MediaRef[]): Record<string, MediaState> {
  const out: Record<string, MediaState> = {};
  for (const m of media) out[m.id] = readyStatus(m);
  return out;
}

/* ------------------------------------------------------------------ */
/* slaveRate — the shared three-band decision                         */
/* ------------------------------------------------------------------ */

describe("slaveRate", () => {
  it("runs at the intended rate inside the dead band", () => {
    expect(slaveRate(0.03, 1.875)).toBe(1.875);
    expect(slaveRate(-0.03, 1.875)).toBe(1.875);
  });

  it("nudges 2% against the drift between 40 and 120 ms", () => {
    expect(slaveRate(0.07, 1.875)).toBeCloseTo(1.875 * 0.98, 12);
    expect(slaveRate(-0.07, 1.875)).toBeCloseTo(1.875 * 1.02, 12);
  });

  it("asks for a re-seek past 120 ms", () => {
    expect(slaveRate(0.2, 1.875)).toBeNull();
    expect(slaveRate(-0.2, 1.875)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* C96 — per-tick slave correction                                    */
/* ------------------------------------------------------------------ */

/**
 * Two overlapping video layers. The top one is the clock: clip M on [1, 11],
 * srcIn 3, speed 1. The bottom one is slaved: clip S on [0.5, 10.5], srcIn 2,
 * speed 1.5. Preview speed 1.25, so the slave's intended rate is 1.875 and the
 * clock's 1.25 — every mapping axis differs between the two.
 */
function twoLayers() {
  const a = videoMedia("master", 40);
  const b = videoMedia("slave", 40);
  const m = clipOf(a, 1, 3, 13, 1);
  const s = clipOf(b, 0.5, 2, 17, 1.5);
  const project = projectOf([a, b], [[m], [s]]);
  const stage = fakeStage();
  const sched = new Scheduler(stage, () => project, fakeMedia(ready(a, b)));
  sched.previewSpeed = 1.25;
  const master = stage.sets[0]!.a;
  const slave = stage.sets[1]!.a;
  return { sched, master, slave, m, s };
}

/** One playing frame: both elements decode a frame, then the engine's tick
 *  order — read the clock, then hold the slaves to it. Returns the slave's
 *  drift in source seconds. */
function frame(sched: Scheduler, master: FakeVideo, slave: FakeVideo, s: Clip): number {
  master.advance(FRAME);
  slave.advance(FRAME);
  const t = sched.masterClockTime()!;
  sched.syncSlaves(t);
  return slave.currentTime - sourceTime(s, t - s.timelineStart);
}

describe("Scheduler.syncSlaves — slaved layers stay on the clock", () => {
  it("pulls a 70 ms offset back inside the dead band and returns to the base rate", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    expect(slave.currentTime).toBeCloseTo(sourceTime(s, 1.5), 9);
    slave.jump(0.07);
    let drift = 0;
    for (let i = 0; i < 180; i++) drift = frame(sched, master, slave, s);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
    expect(slave.playbackRate).toBe(1.875);
  });

  it("does not let a nudge applied at activate() overshoot", () => {
    // activate() applies the nudge; before the fix nothing ever lifted it, so
    // the layer ran 2% slow until the next cut and drifted off the other way.
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    slave.jump(0.07);
    sched.activate(sched.masterClockTime()!, true);
    expect(slave.playbackRate).toBeCloseTo(1.875 * 0.98, 12);
    let worst = 0;
    let drift = 0;
    for (let i = 0; i < 60 * 20; i++) {
      drift = frame(sched, master, slave, s);
      if (i > 120) worst = Math.max(worst, Math.abs(drift));
    }
    expect(worst).toBeLessThanOrEqual(NUDGE_SEC);
    expect(slave.playbackRate).toBe(1.875);
  });

  it("re-seeks once for an offset past 120 ms, and never touches the clock", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    frame(sched, master, slave, s); // consumes the post-activate skip
    const seeks = slave.seeks;
    const masterSeeks = master.seeks;
    const masterRates = master.rateWrites;
    slave.jump(0.2);
    let drift = 0;
    for (let i = 0; i < 120; i++) drift = frame(sched, master, slave, s);
    expect(slave.seeks - seeks).toBe(1);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
    expect(master.seeks).toBe(masterSeeks);
    expect(master.rateWrites).toBe(masterRates);
  });

  it("writes nothing while the layers are in sync", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    frame(sched, master, slave, s);
    const seeks = slave.seeks;
    const rates = slave.rateWrites;
    for (let i = 0; i < 300; i++) frame(sched, master, slave, s);
    expect(slave.seeks).toBe(seeks);
    expect(slave.rateWrites).toBe(rates);
  });

  it("leaves a seeking element alone", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    frame(sched, master, slave, s);
    slave.seeking = true;
    slave.jump(0.2);
    const seeks = slave.seeks;
    const rates = slave.rateWrites;
    for (let i = 0; i < 30; i++) frame(sched, master, slave, s);
    expect(slave.seeks).toBe(seeks);
    expect(slave.rateWrites).toBe(rates);
  });

  it("leaves a paused element alone", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    frame(sched, master, slave, s);
    slave.pause();
    slave.jump(0.2);
    const seeks = slave.seeks;
    const rates = slave.rateWrites;
    for (let i = 0; i < 30; i++) frame(sched, master, slave, s);
    expect(slave.seeks).toBe(seeks);
    expect(slave.rateWrites).toBe(rates);
  });

  it("skips the tick activate() just corrected, and only that one", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    slave.jump(0.2);
    const seeks = slave.seeks;
    frame(sched, master, slave, s);
    expect(slave.seeks).toBe(seeks);
    frame(sched, master, slave, s);
    expect(slave.seeks).toBe(seeks + 1);
  });

  it("costs nothing with a single layer", () => {
    const a = videoMedia("solo", 40);
    const project = projectOf([a], [[clipOf(a, 0, 1, 11, 1)]]);
    const stage = fakeStage();
    const sched = new Scheduler(stage, () => project, fakeMedia(ready(a)));
    sched.activate(1, true);
    const el = stage.sets[0]!.a;
    sched.syncSlaves(1);
    el.jump(0.5);
    const seeks = el.seeks;
    sched.syncSlaves(1);
    expect(el.seeks).toBe(seeks);
  });
});

/* ------------------------------------------------------------------ */
/* C96 — a slave whose seeks take time                                */
/* ------------------------------------------------------------------ */

/**
 * A real seek is not instant: the element's clock stands still while it
 * decodes up to the target, and the engine's does not. A slave that seeks to
 * "where it should be now" lands behind by latency x intended rate — 0.28 s at
 * 150 ms and 0.47 s at 250 ms for this fixture's 1.875x — which is past the
 * 120 ms hard-resync bar, so without a learned lead it re-seeks on every
 * settled tick, forever, and visibly stutters. FakeVideo's instant seek hid it.
 */
describe("Scheduler.syncSlaves — slow-seeking slaves converge", () => {
  /** 5 s of 60 Hz playing frames from activate(), the slave seeking with
   *  `latency`. Counts every slave seek, the one activate() issues included. */
  function play(latency: number) {
    const { sched, master, slave, s } = twoLayers();
    slave.seekLatency = latency;
    const seeks = slave.seeks;
    sched.activate(2, true);
    let drift = 0;
    for (let i = 0; i < 60 * 5; i++) drift = frame(sched, master, slave, s);
    return { sched, master, slave, s, seeks: slave.seeks - seeks, drift };
  }

  it("seeks at most twice at 150 ms latency, then holds the clock", () => {
    const r = play(0.15);
    expect(r.seeks).toBeLessThanOrEqual(2);
    expect(Math.abs(r.drift)).toBeLessThanOrEqual(NUDGE_SEC);
    expect(r.slave.playbackRate).toBe(1.875);
  });

  it("seeks at most twice at 250 ms latency, then holds the clock", () => {
    const r = play(0.25);
    expect(r.seeks).toBeLessThanOrEqual(2);
    expect(Math.abs(r.drift)).toBeLessThanOrEqual(NUDGE_SEC);
    expect(r.slave.playbackRate).toBe(1.875);
  });

  it("unlearns a lead that has become too long when seeks get faster", () => {
    // The first seeks were slow (a cold long-GOP decode); later ones land in
    // data already decoded. A lead that only ever grows now lands AHEAD by
    // more than 120 ms and loops the other way.
    const r = play(0.25);
    r.slave.seekLatency = 0.04;
    r.slave.jump(-0.3); // a stall leaves it well behind
    const seeks = r.slave.seeks;
    let drift = 0;
    for (let i = 0; i < 60 * 5; i++) drift = frame(r.sched, r.master, r.slave, r.s);
    expect(r.slave.seeks - seeks).toBeLessThanOrEqual(2);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
  });

  it("never aims more than half a second ahead after one very slow seek", () => {
    // One 2 s seek (a disk waking up) must not teach a 3.75 s lead: the
    // following fast seek would throw the layer that far ahead of the clock.
    const { sched, master, slave, s } = twoLayers();
    slave.seekLatency = 2;
    sched.activate(2, true);
    slave.seekLatency = 0.04; // the in-flight seek keeps its 2 s
    let worst = 0;
    let drift = 0;
    for (let i = 0; i < 60 * 5; i++) {
      drift = frame(sched, master, slave, s);
      // mid-seek currentTime reads back the target, so this sees every aim
      worst = Math.max(worst, drift);
    }
    expect(worst).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
  });

  it("does not learn from an exact seek a refresh issued mid-seek", () => {
    // Mid-seek the element is not decodable, so a refresh's activate() takes
    // the exact-seek branch; that landing's lag is not a miss of the lead.
    const r = play(0.15);
    r.slave.jump(-0.3);
    const seeks = r.slave.seeks;
    frame(r.sched, r.master, r.slave, r.s); // the lead seek goes out
    expect(r.slave.seeking).toBe(true);
    frame(r.sched, r.master, r.slave, r.s);
    r.sched.activate(r.sched.masterClockTime()!, true); // the refresh
    let drift = 0;
    for (let i = 0; i < 60 * 3; i++) drift = frame(r.sched, r.master, r.slave, r.s);
    // the lead seek, the refresh's exact seek, one more lead seek
    expect(r.slave.seeks - seeks).toBeLessThanOrEqual(3);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
  });

  it("does not learn from a seek still in flight that reports data", () => {
    // An engine may keep readyState at HAVE_ENOUGH_DATA through a seek into
    // buffered data; currentTime is then the frozen target, not a landing.
    const r = play(0.25);
    r.slave.jump(-0.3);
    const seeks = r.slave.seeks;
    frame(r.sched, r.master, r.slave, r.s); // the lead seek goes out
    for (let i = 0; i < 6; i++) frame(r.sched, r.master, r.slave, r.s);
    expect(r.slave.seeking).toBe(true);
    r.slave.readyState = 4;
    r.sched.activate(r.sched.masterClockTime()!, true); // a refresh, mid-seek
    let drift = 0;
    for (let i = 0; i < 60 * 3; i++) drift = frame(r.sched, r.master, r.slave, r.s);
    expect(r.slave.seeks - seeks).toBeLessThanOrEqual(2);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
  });

  it("keeps the lead through a loop restart into the same clip", () => {
    // The layer leaves its clip with a lead seek in flight (the slave clip
    // ends before the master's) and the loop brings it straight back.
    const r = play(0.25);
    r.slave.jump(-0.3);
    frame(r.sched, r.master, r.slave, r.s); // the lead seek goes out
    expect(r.slave.seeking).toBe(true);
    r.sched.activate(10.75, true); // past the slave clip's end
    for (let i = 0; i < 30; i++) frame(r.sched, r.master, r.slave, r.s);
    const seeks = r.slave.seeks;
    r.sched.activate(2, true); // the loop restart
    let drift = 0;
    for (let i = 0; i < 60 * 3; i++) drift = frame(r.sched, r.master, r.slave, r.s);
    // one seek, aimed with the lead already learned, and it lands on time
    expect(r.slave.seeks - seeks).toBe(1);
    expect(Math.abs(drift)).toBeLessThanOrEqual(NUDGE_SEC);
  });

  it("forgets the lead when the slave moves on to another clip", () => {
    const a = videoMedia("master", 40);
    const b = videoMedia("slow", 40);
    const c = videoMedia("fast", 40);
    const m = clipOf(a, 1, 3, 13, 1);
    const s1 = clipOf(b, 0.5, 2, 9.5, 1.5);
    const s2 = clipOf(c, 5.5, 4, 12, 1.5);
    const project = projectOf([a, b, c], [[m], [s1, s2]]);
    const stage = fakeStage();
    const sched = new Scheduler(stage, () => project, fakeMedia(ready(a, b, c)));
    sched.previewSpeed = 1.25;
    const master = stage.sets[0]!.a;
    const slow = stage.sets[1]!.a;
    slow.seekLatency = 0.25;
    sched.activate(2, true);
    for (let i = 0; i < 60 * 2; i++) frame(sched, master, slow, s1);
    // the lead is learned now (0.47 s); s2's element seeks instantly
    sched.advanceBoundary(5.5);
    sched.activate(5.5, true);
    const fast = stage.sets[1]!.b;
    expect(fast.currentTime).toBeCloseTo(sourceTime(s2, 0), 9);
  });
});

/* ------------------------------------------------------------------ */
/* C98 — an ended or errored master is not a clock                    */
/* ------------------------------------------------------------------ */

describe("Scheduler.masterClockTime — a frozen element is not a clock", () => {
  function single() {
    const a = videoMedia("short", 40);
    const c = clipOf(a, 0.75, 1.5, 9.5, 1.25);
    const project = projectOf([a], [[c]]);
    const stage = fakeStage();
    const sched = new Scheduler(stage, () => project, fakeMedia(ready(a)));
    sched.activate(2, true);
    return { sched, el: stage.sets[0]!.a, c };
  }

  it("reads a playing element", () => {
    const { sched, el, c } = single();
    expect(sched.masterClockTime()).toBeCloseTo(timelineTime(c, el.currentTime), 12);
  });

  it("gives up the clock when the element has ended short of the out-point", () => {
    const { sched, el } = single();
    el.ended = true;
    expect(sched.masterClockTime()).toBeNull();
  });

  it("gives up the clock when the element has errored", () => {
    const { sched, el } = single();
    el.error = { code: 3 };
    expect(sched.masterClockTime()).toBeNull();
  });

  it("hands the clock to the next layer down", () => {
    const { sched, master, slave, s } = twoLayers();
    sched.activate(2, true);
    master.ended = true;
    expect(sched.masterClockTime()).toBeCloseTo(timelineTime(s, slave.currentTime), 12);
  });
});

/* ------------------------------------------------------------------ */
/* C101 — element errors reach the media manager                      */
/* ------------------------------------------------------------------ */

describe("pooled <video> errors", () => {
  function setup() {
    const a = videoMedia("broken", 40);
    const b = videoMedia("next", 40);
    const project = projectOf([a, b], [[clipOf(a, 0, 1, 3, 1), clipOf(b, 2.5, 4, 9, 1)]]);
    const stage = fakeStage();
    const media = fakeMedia(ready(a, b));
    const sched = new Scheduler(stage, () => project, media);
    sched.activate(0.5, false);
    return { sched, media, a, b, set: stage.sets[0]! };
  }

  it("marks the slot's media failed", () => {
    const { media, a, set } = setup();
    set.a.error = { code: 4 };
    set.a.fire("error");
    expect(media.failed).toEqual([[a.id, "This file couldn't be played"]]);
  });

  it("attributes a preload slot's error to the preloaded media", () => {
    const { sched, media, b, set } = setup();
    sched.preload(1.5);
    expect(set.b.src).toBe(`url:${b.path}`);
    set.b.error = { code: 4 };
    set.b.fire("error");
    expect(media.failed).toEqual([[b.id, "This file couldn't be played"]]);
  });

  it("ignores an error from a file the media no longer points at", () => {
    const { media, a, set } = setup();
    // a relink: the media is ready again, at a different url
    media.statuses[a.id] = { state: "ready", url: "url:C:\\elsewhere\\broken.mp4", sourcePath: "C:\\elsewhere\\broken.mp4" };
    set.a.error = { code: 4 };
    set.a.fire("error");
    expect(media.failed).toEqual([]);
  });

  it("ignores an error once the media is no longer ready", () => {
    const { media, a, set } = setup();
    media.statuses[a.id] = { state: "checking" };
    set.a.error = { code: 4 };
    set.a.fire("error");
    expect(media.failed).toEqual([]);
  });

  it("ignores an aborted load", () => {
    const { media, set } = setup();
    set.a.error = { code: 1 };
    set.a.fire("error");
    expect(media.failed).toEqual([]);
  });

  it("stops listening on dispose", () => {
    const { sched, media, set } = setup();
    expect(set.a.listenerCount("error")).toBe(1);
    sched.dispose();
    expect(set.a.listenerCount("error")).toBe(0);
    set.a.error = { code: 4 };
    set.a.fire("error");
    expect(media.failed).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* C100 — the text layer's line height                                */
/* ------------------------------------------------------------------ */

describe("text layer styling", () => {
  it("keeps line-height 1.25 through the font shorthand", () => {
    const g = {
      type: "text" as const,
      text: "Two\nlines",
      fontFamily: "Segoe UI" as const,
      sizePx: 72,
      color: "#ffcc00",
      bold: true,
      italic: false,
    };
    const media: MediaRef = {
      id: "m-text", path: "", size: 0, mtimeMs: 0, kind: "image", duration: 5,
      width: 300, height: 180, hasAudio: false, generator: g,
    };
    const project = projectOf([media], [[clipOf(media, 0.5, 0, 5, 1)]]);
    const stage = fakeStage();
    const sched = new Scheduler(stage, () => project, fakeMedia({}));
    sched.activate(1, false);
    const gen = stage.sets[0]!.gen;
    expect(gen.textContent).toBe("Two\nlines");
    expect(gen.style.font).toBe(cssFont(g));
    // the shorthand reset is modelled by the fake style, as a browser does it
    expect(gen.style.lineHeight).toBe("1.25");
  });
});

/* ------------------------------------------------------------------ */
/* C102 — per-tick queries                                            */
/* ------------------------------------------------------------------ */

describe("per-tick queries", () => {
  it("videoElements is stable until a layer is added", () => {
    const { sched } = twoLayers();
    const first = sched.videoElements();
    expect(first).toHaveLength(4);
    expect(sched.videoElements()).toBe(first);
  });

  it("activeVideoScratch answers like activeVideoInfos", () => {
    const { sched, m, s } = twoLayers();
    sched.activate(2, true);
    const fresh = sched.activeVideoInfos();
    const scratch = sched.activeVideoScratch();
    expect(scratch.map((i) => [i.el, i.clip.id, i.track.id])).toEqual(
      fresh.map((i) => [i.el, i.clip.id, i.track.id]),
    );
    expect(scratch.map((i) => i.clip.id)).toEqual([m.id, s.id]);
  });

  it("re-reads the video tracks when the project's tracks change", () => {
    const a = videoMedia("one", 40);
    const b = videoMedia("two", 40);
    let project = projectOf([a, b], [[clipOf(a, 0, 1, 11, 1)]]);
    const stage = fakeStage();
    const sched = new Scheduler(stage, () => project, fakeMedia(ready(a, b)));
    sched.activate(1, false);
    expect(sched.activeVideoInfos()).toHaveLength(1);
    project = projectOf([a, b], [[clipOf(a, 0, 1, 11, 1)], [clipOf(b, 0, 2, 12, 1)]]);
    sched.activate(1, false);
    expect(sched.activeVideoInfos()).toHaveLength(2);
    expect(sched.videoElements()).toHaveLength(4);
  });
});
