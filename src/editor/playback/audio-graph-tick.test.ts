// AudioGraph against a recording fake of the Web Audio API: what actually gets
// scheduled on the AudioParams, tick by tick. Complements the pure tests
// (envelope-breakpoints.test.ts, envelope-rearm.test.ts, voice-pool.test.ts)
// by checking the wiring between them and the scheduler.
//
// Covered here:
//  - an envelope reaches the GainNode mapped through the preview speed, with
//    the fade-out-only clip audible from its first frame (C95);
//  - a video element that goes inactive is zeroed ONCE, not rewritten on every
//    tick it stays inactive, and is re-armed when it comes back (C102).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef } from "../../core/types";
import type { MediaState } from "../media/media";
import { AudioGraph } from "./audio-graph";
import { Scheduler } from "./scheduler";
import { clipOf, fakeMedia, fakeStage, projectOf, readyStatus, videoMedia } from "./test-fakes";

type Call = [op: string, value: number, time: number];

class FakeParam {
  value = 0;
  calls: Call[] = [];
  cancelScheduledValues(time: number): void {
    this.calls.push(["cancel", 0, time]);
  }
  setValueAtTime(value: number, time: number): void {
    this.calls.push(["set", value, time]);
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push(["ramp", value, time]);
  }
  setTargetAtTime(value: number, time: number): void {
    this.calls.push(["target", value, time]);
  }
}

class FakeGain {
  gain = new FakeParam();
  connect(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  currentTime = 50;
  state = "running";
  destination = {};
  /** the gain node each media element's source was connected to */
  sources = new Map<unknown, FakeGain>();
  constructor() {
    FakeAudioContext.last = this;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createMediaElementSource(el: unknown): { connect: (g: FakeGain) => void } {
    return { connect: (g) => this.sources.set(el, g) };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAudio {
  preload = "";
  crossOrigin = "";
  src = "";
  paused = true;
  currentTime = 0;
  playbackRate = 1;
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudio);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ready(...media: MediaRef[]): Record<string, MediaState> {
  const out: Record<string, MediaState> = {};
  for (const m of media) out[m.id] = readyStatus(m);
  return out;
}

/** One video track: clip V on [2.5, 6.5] (srcIn 1.25, speed 1.5, volume 0.6,
 *  a 1 s fade-out and no fade-in), nothing before it or after it. */
function rig() {
  const a = videoMedia("voiced", 40);
  const v = clipOf(a, 2.5, 1.25, 7.25, 1.5, { volume: 0.6, fadeOutSec: 1 });
  const project = projectOf([a], [[v]]);
  const stage = fakeStage();
  const media = fakeMedia(ready(a));
  const sched = new Scheduler(stage, () => project, media);
  const graph = new AudioGraph(() => project, media, sched);
  const ctx = FakeAudioContext.last!;
  const el = stage.sets[0]!.a;
  return { sched, graph, ctx, el };
}

describe("AudioGraph — envelopes on the video element's gain", () => {
  it("schedules the fade-out-only clip audible from its first frame, at preview speed", () => {
    const { sched, graph, ctx, el } = rig();
    sched.previewSpeed = 2;
    sched.activate(2.5, true);
    graph.tick(2.5, true, 2);
    const gain = ctx.sources.get(el)!;
    expect(gain).toBeDefined();
    // 2 timeline seconds of hold reach the fade-out at ctx +1.5 (speed 2), the
    // end at ctx +2
    expect(gain.gain.calls).toEqual([
      ["cancel", 0, 50],
      ["set", 0.6, 50],
      ["ramp", 0.6, 51.5],
      ["ramp", 0, 52],
    ]);
  });
});

describe("AudioGraph — an inactive video element", () => {
  it("is zeroed once, not on every tick it stays inactive", () => {
    const { sched, graph, ctx, el } = rig();
    sched.activate(3, true);
    graph.tick(3, true, 1);
    const param = ctx.sources.get(el)!.gain;
    // into the gap after the clip: the element goes inactive
    sched.activate(7, true);
    ctx.currentTime = 54;
    graph.tick(7, true, 1);
    const afterZero = param.calls.length;
    expect(param.calls.slice(-2)).toEqual([
      ["cancel", 0, 54],
      ["set", 0, 54],
    ]);
    for (let i = 1; i <= 30; i++) {
      ctx.currentTime = 54 + i / 60;
      graph.tick(7 + i / 60, true, 1);
    }
    expect(param.calls.length).toBe(afterZero);
  });

  it("is re-armed when it comes back", () => {
    const { sched, graph, ctx, el } = rig();
    sched.activate(3, true);
    graph.tick(3, true, 1);
    const param = ctx.sources.get(el)!.gain;
    sched.activate(7, true);
    graph.tick(7, true, 1);
    graph.tick(7.02, true, 1);
    // a seek back into the clip
    sched.activate(4, true);
    ctx.currentTime = 60;
    const before = param.calls.length;
    graph.tick(4, true, 1);
    expect(param.calls.slice(before)).toEqual([
      ["cancel", 0, 60],
      ["set", 0.6, 60],
      ["ramp", 0.6, 61.5],
      ["ramp", 0, 62.5],
    ]);
  });
});
