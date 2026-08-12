// Lane reachability: the geometry contract between what render.ts DRAWS and
// what interactions.ts can HIT.
//
// The bug these tests exist for: the timeline panel is a fixed 280px, leaving a
// ~231px host once the transport row is subtracted, while the lane stack grows
// without bound ("Add video layer" is unlimited, and detachAudio / audio imports
// append lanes at the bottom). Lane 4 got a 9px sliver and lane 5 nothing at
// all, so a detached audio clip on an ordinary three-layer project could not be
// selected, moved, trimmed or deleted. draw() was handed an inflated height and
// painted those lanes into pixels the canvas did not have; hitTest's y was
// bounded by the host, so the two disagreed about where a lane is.
//
// The invariant asserted below is the one that was violated: for ANY lane count,
// every lane can be brought entirely inside the surface that can receive a
// pointer — and drawing and hit-testing read that geometry from the same place.

import { beforeEach, describe, expect, it } from "vitest";
import type { Clip, ProjectFile, Track } from "../../core/types";
import {
  AUDIO_LANE_H,
  LANE_GAP,
  RULER_H,
  VIDEO_LANE_H,
  clampLaneScroll,
  draw,
  laneLayout,
  laneScroll,
  maxLaneScroll,
  setLaneScroll,
  totalLanesHeight,
} from "./render";

/** The real host: a 280px panel less the ~49px transport row. */
const VIEW_H = 231;

function clip(id: string): Clip {
  return {
    id,
    mediaId: "m",
    timelineStart: 0,
    srcIn: 0,
    srcOut: 100,
    speed: 1,
    audio: {
      volume: 1,
      muted: false,
      fadeInSec: 0,
      fadeOutSec: 0,
      gainOffsetDb: 0,
      detached: false,
    },
  };
}

function track(id: string, kind: "video" | "audio"): Track {
  return { id, kind, name: id, muted: false, clips: [clip(`c-${id}`)] };
}

/** A project with `video` video lanes followed by `audio` audio lanes — the
 *  order core/project.ts maintains (video tracks are a contiguous prefix). */
function project(video: number, audio = 0): ProjectFile {
  const tracks: Track[] = [];
  for (let i = 0; i < video; i++) tracks.push(track(`v${i}`, "video"));
  for (let i = 0; i < audio; i++) tracks.push(track(`a${i}`, "audio"));
  return {
    schema: 1,
    app: "taroting",
    id: "p",
    name: "p",
    createdAt: "",
    modifiedAt: "",
    media: [],
    timeline: { fps: { num: 30, den: 1 }, width: 1920, height: 1080, tracks },
    export: {} as ProjectFile["export"],
  };
}

/**
 * How much of a lane a pointer can actually reach, in px.
 *
 * This mirrors interactions.ts hitTest exactly: a y below RULER_H is the ruler,
 * never a lane, and y cannot exceed the canvas, which is the host's height. So
 * the reachable part of a lane is its intersection with [RULER_H, VIEW_H].
 */
function reachable(y: number, h: number): number {
  return Math.max(0, Math.min(y + h, VIEW_H) - Math.max(y, RULER_H));
}

/** Flat colors so a recorded op can be attributed to what drew it. */
const PROBE_COLORS = {
  bg: "BG",
  laneBg: "LANEBG",
  border: "BORDER",
  text1: "T1",
  text2: "T2",
  text3: "T3",
  accent: "ACCENT",
  accentDim: "ACCENTDIM",
  clipVideoBg: "VCLIP",
  clipVideoBorder: "VCLIPB",
  clipAudioBg: "ACLIP",
  clipAudioBorder: "ACLIPB",
  wave: "WAVE",
  playhead: "PLAYHEAD",
  rulerTick: "TICK",
};

/** Run the real draw() and return the `y` of every lane background it painted,
 *  in order. A minimal recording stand-in for CanvasRenderingContext2D — no DOM
 *  is involved, and only the ops draw actually calls are implemented. */
function recordLaneTops(p: ProjectFile): number[] {
  const tops: number[] = [];
  const noop = (): void => {};
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    globalAlpha: 1,
    setTransform: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    roundRect: noop,
    clip: noop,
    clearRect: noop,
    fill: noop,
    stroke: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    setLineDash: noop,
    fillText: noop,
    fillRect(_x: number, y: number): void {
      if (ctx.fillStyle === PROBE_COLORS.laneBg) tops.push(y);
    },
  };
  draw(ctx as unknown as CanvasRenderingContext2D, {
    project: p,
    t0: 0,
    pxPerSec: 4,
    width: 700,
    height: VIEW_H,
    playhead: -99,
    selectedClipId: null,
    drag: null,
    guideT: null,
    colors: PROBE_COLORS,
    waveforms: {},
    mediaById: new Map(),
  });
  return tops;
}

beforeEach(() => setLaneScroll(0));

describe("lane scroll geometry", () => {
  it("keeps the classic layout untouched at scroll 0", () => {
    const lanes = laneLayout(project(3));
    expect(lanes.map((l) => l.y)).toEqual([
      RULER_H + LANE_GAP,
      RULER_H + LANE_GAP + (VIDEO_LANE_H + LANE_GAP),
      RULER_H + LANE_GAP + 2 * (VIDEO_LANE_H + LANE_GAP),
    ]);
    expect(lanes.map((l) => l.h)).toEqual([VIDEO_LANE_H, VIDEO_LANE_H, VIDEO_LANE_H]);
  });

  it("offsets every lane by the scroll, with no drift over repeated scrolling", () => {
    const p = project(6);
    const base = laneLayout(p).map((l) => l.y);

    setLaneScroll(40);
    expect(laneLayout(p).map((l) => l.y)).toEqual(base.map((y) => y - 40));

    // walk down and back up through the cached-refill path
    for (let s = 0; s <= 120; s += 7) setLaneScroll(s);
    for (let s = 120; s >= 0; s -= 3) setLaneScroll(s);
    setLaneScroll(0);
    expect(laneLayout(p).map((l) => l.y)).toEqual(base);
  });

  it("reports no scrollable range while the lanes already fit", () => {
    // 1..3 video lanes fit in 231px; the 4th does not (this is exactly the
    // boundary the bug lived on).
    expect(maxLaneScroll(project(1), VIEW_H)).toBe(0);
    expect(maxLaneScroll(project(2), VIEW_H)).toBe(0);
    expect(maxLaneScroll(project(3), VIEW_H)).toBe(0);
    expect(maxLaneScroll(project(4), VIEW_H)).toBeGreaterThan(0);
  });

  it("clamps and pixel-snaps a proposed scroll", () => {
    const p = project(6);
    const max = maxLaneScroll(p, VIEW_H);
    expect(clampLaneScroll(p, -500, VIEW_H)).toBe(0);
    expect(clampLaneScroll(p, max + 500, VIEW_H)).toBe(max);
    expect(clampLaneScroll(p, 12.4, VIEW_H)).toBe(12);
    // nothing to scroll → pinned at the top whatever is asked for
    expect(clampLaneScroll(project(1), 999, VIEW_H)).toBe(0);
  });

  it("scrolls far enough to put the last lane's bottom at the viewport bottom", () => {
    const p = project(8);
    setLaneScroll(maxLaneScroll(p, VIEW_H));
    const lanes = laneLayout(p);
    const last = lanes[lanes.length - 1]!;
    // totalLanesHeight ends with a trailing LANE_GAP, which becomes bottom pad
    expect(last.y + last.h).toBe(VIEW_H - LANE_GAP);
  });
});

/* ------------------------------------------------------------------ *
 * The regression test proper.
 * ------------------------------------------------------------------ */

describe("every lane is reachable at any lane count", () => {
  // Video-only stacks well past the 6-lane soft warning, plus the mixes that
  // detachAudio and audio imports produce.
  const cases: Array<[number, number]> = [
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [8, 0],
    [16, 0],
    [3, 1], // detach audio on an ordinary three-layer project
    [3, 4],
    [6, 6],
    [1, 12],
  ];

  for (const [v, a] of cases) {
    it(`${v} video + ${a} audio: each lane fits entirely inside the hit surface at some legal scroll`, () => {
      const p = project(v, a);
      const max = maxLaneScroll(p, VIEW_H);
      const count = v + a;

      for (let i = 0; i < count; i++) {
        let bestScroll = -1;
        // Exhaustive over the legal range: "reachable" means there EXISTS a
        // scroll the user can actually reach at which the whole lane is inside
        // the band that can receive a pointer.
        for (let s = 0; s <= max; s++) {
          setLaneScroll(s);
          const lane = laneLayout(p)[i]!;
          if (reachable(lane.y, lane.h) === lane.h) {
            bestScroll = s;
            break;
          }
        }
        expect(bestScroll, `lane ${i} of ${count} is never fully reachable`).toBeGreaterThanOrEqual(
          0,
        );
        expect(bestScroll).toBeLessThanOrEqual(max);
      }
    });
  }

  it("witnesses the original bug: without scrolling, lanes past the third are unreachable", () => {
    // This is the state the editor was permanently stuck in — scroll pinned at
    // 0 because there was no vertical scroll at all. If `reachable` were not
    // discriminating, this expectation would not hold and the suite above would
    // be vacuous.
    setLaneScroll(0);
    const lanes = laneLayout(project(5));
    const spans = lanes.map((l) => reachable(l.y, l.h));
    expect(spans[0]).toBe(VIDEO_LANE_H);
    expect(spans[1]).toBe(VIDEO_LANE_H);
    expect(spans[2]).toBe(VIDEO_LANE_H);
    expect(spans[3]).toBe(9); // the 9px sliver
    expect(spans[4]).toBe(0); // nothing at all
    expect(laneScroll()).toBe(0);
  });

  it("witnesses the detach-audio case: the appended audio lane needs scrolling", () => {
    const p = project(3, 1);
    setLaneScroll(0);
    const audio = laneLayout(p)[3]!;
    expect(audio.h).toBe(AUDIO_LANE_H);
    expect(reachable(audio.y, audio.h)).toBe(9); // a 9px sliver, unusable

    setLaneScroll(maxLaneScroll(p, VIEW_H));
    const scrolled = laneLayout(p)[3]!;
    expect(reachable(scrolled.y, scrolled.h)).toBe(AUDIO_LANE_H);
  });
});

describe("drawing and hit-testing cannot disagree", () => {
  // render.draw, interactions.hitTest and the external-drop resolver in
  // editor.ts all read geometry from laneLayout and nothing else, so the only
  // way they can disagree is if laneLayout could return a stale offset. It
  // cannot: the offset is folded in on the cached path too, so a caller that
  // holds no reference and re-asks mid-gesture sees the same rects as one that
  // asked before the scroll.
  it("reflects a scroll on the cached path, with a stable array identity", () => {
    const p = project(6);
    const first = laneLayout(p);
    setLaneScroll(30);
    const second = laneLayout(p);
    expect(second).toBe(first); // same array: no per-call allocation
    expect(second[0]!.y).toBe(RULER_H + LANE_GAP - 30);
  });

  it("agrees for two callers reading either side of a scroll", () => {
    const p = project(6);
    setLaneScroll(0);
    const drawSees = laneLayout(p).map((l) => l.y);
    setLaneScroll(55);
    const hitSees = laneLayout(p).map((l) => l.y);
    expect(hitSees).toEqual(drawSees.map((y) => y - 55));
    // and re-reading without a scroll change is idempotent
    expect(laneLayout(p).map((l) => l.y)).toEqual(hitSees);
  });

  it("draws exactly the lanes a pointer can reach — no more, no fewer", () => {
    // Runs the REAL draw() against a recording context (vite.config sets
    // environment: "node", so there is no canvas — but draw only needs the 2D
    // API surface, and what we are checking is the geometry it emits).
    //
    // This is the half of the invariant the pure-layout tests cannot see: the
    // original bug was draw() being handed a height taller than the canvas and
    // painting lanes into pixels that did not exist. Here the drawn set is
    // compared against the set a pointer can actually land on.
    for (const [v, a] of [
      [1, 0],
      [4, 0],
      [8, 0],
      [3, 1],
      [16, 4],
    ] as Array<[number, number]>) {
      const p = project(v, a);
      const max = maxLaneScroll(p, VIEW_H);
      for (let s = 0; s <= max; s += Math.max(1, Math.floor(max / 12) || 1)) {
        setLaneScroll(s);
        const drawn = recordLaneTops(p);
        const visible = laneLayout(p)
          .filter((l) => reachable(l.y, l.h) > 0)
          .map((l) => l.y);
        expect(drawn, `${v}v+${a}a at scroll ${s}`).toEqual(visible);
      }
    }
  });

  it("keeps drawing work proportional to the viewport, not the lane count", () => {
    // 40 lanes must not cost 40 lane draws a frame — the old code drew them all.
    const p = project(40, 4);
    const most = Math.ceil((VIEW_H - RULER_H) / (AUDIO_LANE_H + LANE_GAP)) + 1;
    const max = maxLaneScroll(p, VIEW_H);
    for (let s = 0; s <= max; s += 37) {
      setLaneScroll(s);
      expect(recordLaneTops(p).length).toBeLessThanOrEqual(most);
    }
  });

  it("bounds the scroll by the content, so no scroll can push every lane off", () => {
    for (const [v, a] of [
      [1, 0],
      [4, 0],
      [3, 1],
      [9, 3],
    ] as Array<[number, number]>) {
      const p = project(v, a);
      const max = maxLaneScroll(p, VIEW_H);
      setLaneScroll(max);
      const lanes = laneLayout(p);
      const visible = lanes.filter((l) => reachable(l.y, l.h) > 0);
      expect(visible.length, `${v}v+${a}a`).toBeGreaterThan(0);
      // fully scrolled: the last lane is always completely in view
      const last = lanes[lanes.length - 1]!;
      expect(reachable(last.y, last.h)).toBe(last.h);
    }
    expect(totalLanesHeight(project(1))).toBe(RULER_H + LANE_GAP + VIDEO_LANE_H + LANE_GAP);
  });
});

/* ------------------------------------------------------------------ *
 * Auto-scroll: dragging a clip to a lane that is scrolled out of view.
 *
 * Scrolling made every lane REACHABLE; a drag still could not get to one,
 * because the gesture had no way to bring the target into range. The pure part
 * is below — where the edge zones are, how hard they pull, and how the step is
 * clamped. The gesture-level behaviour (the rAF loop, and that it dies with the
 * gesture on every exit path) is driven against the real attachInteractions in a
 * scratch harness, since there is no DOM here.
 * ------------------------------------------------------------------ */

import {
  AUTOSCROLL_MAX_PX_PER_SEC,
  AUTOSCROLL_MAX_STEP_PX,
  AUTOSCROLL_MAX_STEP_SEC,
  AUTOSCROLL_MIN_PX_PER_SEC,
  AUTOSCROLL_ZONE_PX,
  autoScrollSubStepCount,
  laneAutoScrollVelocity,
  nextLaneScroll,
} from "./interactions";
import { LANE_HYSTERESIS_FRAC, laneTargetForMove } from "./lane-target";

/** The speed the ramp should produce at a given fraction into the zone. */
function rampAt(depth: number): number {
  return AUTOSCROLL_MIN_PX_PER_SEC + (AUTOSCROLL_MAX_PX_PER_SEC - AUTOSCROLL_MIN_PX_PER_SEC) * depth;
}

describe("lane auto-scroll: where it engages", () => {
  it("is completely inert between the two edge zones", () => {
    for (let y = RULER_H + AUTOSCROLL_ZONE_PX; y <= VIEW_H - AUTOSCROLL_ZONE_PX; y += 0.5) {
      expect(laneAutoScrollVelocity(y, VIEW_H), `y=${y}`).toBe(0);
    }
  });

  it("pulls up near the ruler and down near the bottom", () => {
    expect(laneAutoScrollVelocity(RULER_H + 1, VIEW_H)).toBeLessThan(0);
    expect(laneAutoScrollVelocity(VIEW_H - 1, VIEW_H)).toBeGreaterThan(0);
    // the zone is half-open: exactly on the inner boundary is still inert
    expect(laneAutoScrollVelocity(RULER_H + AUTOSCROLL_ZONE_PX, VIEW_H)).toBe(0);
    expect(laneAutoScrollVelocity(VIEW_H - AUTOSCROLL_ZONE_PX, VIEW_H)).toBe(0);
  });

  it("ramps affinely from the floor at the boundary to the cap at the edge", () => {
    const z = AUTOSCROLL_ZONE_PX;
    for (const depth of [0.25, 0.5, 0.75, 1]) {
      expect(laneAutoScrollVelocity(VIEW_H - z + z * depth, VIEW_H)).toBeCloseTo(rampAt(depth), 9);
      expect(laneAutoScrollVelocity(RULER_H + z - z * depth, VIEW_H)).toBeCloseTo(-rampAt(depth), 9);
    }
    // One px in is the floor, not zero: a ramp starting at zero makes the first
    // few px of the zone a dead band that reads as "auto-scroll is broken".
    expect(laneAutoScrollVelocity(VIEW_H - z + 1, VIEW_H)).toBeCloseTo(rampAt(1 / z), 9);
    expect(laneAutoScrollVelocity(VIEW_H - z + 1, VIEW_H)).toBeGreaterThan(
      AUTOSCROLL_MIN_PX_PER_SEC,
    );
  });

  it("caps at the ends instead of running away past the panel", () => {
    // pointer capture keeps reporting positions from outside the canvas
    expect(laneAutoScrollVelocity(VIEW_H + 500, VIEW_H)).toBe(AUTOSCROLL_MAX_PX_PER_SEC);
    expect(laneAutoScrollVelocity(-500, VIEW_H)).toBe(-AUTOSCROLL_MAX_PX_PER_SEC);
    // over the pinned ruler is "above the lanes" — full speed up, not a dead spot
    expect(laneAutoScrollVelocity(0, VIEW_H)).toBe(-AUTOSCROLL_MAX_PX_PER_SEC);
  });

  it("never reports both directions on a host too short for two zones", () => {
    const shortH = RULER_H + 20; // 10px of zone at each end, meeting in the middle
    let ups = 0;
    let downs = 0;
    for (let y = RULER_H; y <= shortH; y += 0.25) {
      const v = laneAutoScrollVelocity(y, shortH);
      if (v < 0) {
        ups++;
        expect(y, "an up-pull below the midpoint").toBeLessThan(RULER_H + 10);
      }
      if (v > 0) {
        downs++;
        expect(y, "a down-pull above the midpoint").toBeGreaterThan(RULER_H + 10);
      }
    }
    expect(ups).toBeGreaterThan(0);
    expect(downs).toBeGreaterThan(0);
    // exactly on the seam, neither
    expect(laneAutoScrollVelocity(RULER_H + 10, shortH)).toBe(0);
  });

  it("engages nowhere at all when the lane band has no height", () => {
    expect(laneAutoScrollVelocity(10, RULER_H)).toBe(0);
    expect(laneAutoScrollVelocity(10, 0)).toBe(0);
  });
});

describe("lane auto-scroll: the step is elapsed-time based and clamped", () => {
  /** Integrate `seconds` of wall clock at `hz`, as the rAF loop would. */
  function travel(hz: number, seconds: number, v: number, max: number): number {
    const dt = 1 / hz;
    let pos = 0;
    for (let i = 0; i < hz * seconds; i++) pos = nextLaneScroll(pos, v, dt, max);
    return pos;
  }

  it("travels the same distance per second at 60 Hz and at 165 Hz", () => {
    const v = AUTOSCROLL_MAX_PX_PER_SEC;
    expect(travel(60, 1, v, 1e6)).toBeCloseTo(v, 6);
    expect(travel(165, 1, v, 1e6)).toBeCloseTo(v, 6);
    expect(travel(30, 2, v, 1e6)).toBeCloseTo(2 * v, 6);
    // …which is the whole point: with a per-frame constant the same gesture
    // would run 2.75x faster on the 165 Hz display than on the 60 Hz one.
    expect(travel(165, 1, v, 1e6)).toBeCloseTo(travel(60, 1, v, 1e6), 6);
  });

  it("clamps one long stall so a dropped frame cannot teleport the stack", () => {
    // 5 s of elapsed time (a background tab, a GC pause) counts as one capped step
    expect(nextLaneScroll(0, 400, 5, 1e6)).toBeCloseTo(400 * AUTOSCROLL_MAX_STEP_SEC, 9);
    expect(nextLaneScroll(0, 400, 0.01, 1e6)).toBeCloseTo(4, 9);
  });

  it("ignores a zero, negative or NaN elapsed time", () => {
    expect(nextLaneScroll(17, 400, 0, 1e6)).toBe(17);
    expect(nextLaneScroll(17, 400, -0.5, 1e6)).toBe(17);
    expect(nextLaneScroll(17, 400, Number.NaN, 1e6)).toBe(17);
  });

  it("never leaves the legal range, from either end", () => {
    expect(nextLaneScroll(95, 500, 0.05, 100)).toBe(100);
    expect(nextLaneScroll(5, -500, 0.05, 100)).toBe(0);
    // and it re-clamps a position the range has shrunk past (a lane was deleted)
    expect(nextLaneScroll(400, 0, 0.016, 100)).toBe(100);
  });

  it("does nothing at all when there is nothing to scroll", () => {
    // 1–3 lanes: maxLaneScroll is 0, so the drag behaves exactly as it did before
    expect(maxLaneScroll(project(3), VIEW_H)).toBe(0);
    for (const v of [-AUTOSCROLL_MAX_PX_PER_SEC, -1, 1, AUTOSCROLL_MAX_PX_PER_SEC]) {
      expect(nextLaneScroll(0, v, 0.016, 0)).toBe(0);
    }
  });

  it("keeps the sub-pixel remainder, or the slow end of the ramp never moves", () => {
    // clampLaneScroll pixel-snaps, so at 60 px/s on a 165 Hz display a step is
    // 0.36 px: feeding the STORED position back would round it away every frame
    // and the shallow end of the zone would be permanently stuck.
    const dt = 1 / 165;
    const v = AUTOSCROLL_MIN_PX_PER_SEC;
    const p = project(20);
    let float = 0;
    let rounded = 0;
    for (let i = 0; i < 165; i++) {
      float = nextLaneScroll(float, v, dt, 1000);
      rounded = clampLaneScroll(p, nextLaneScroll(rounded, v, dt, 1000), VIEW_H);
    }
    expect(float).toBeCloseTo(60, 6);
    expect(rounded).toBe(0); // the stall this guards against
  });
});

describe("lane auto-scroll: a fast scroll cannot skip a lane", () => {
  /** Walk the scroll from 0 to max in frames of `pxPerFrame`, retargeting the
   *  way the loop does, and report the lane the drag ends up on. `subStep` off
   *  is the naive "sample the target once per frame" version. */
  function walkTarget(p: ProjectFile, y: number, pxPerFrame: number, subStep: boolean): string {
    const max = maxLaneScroll(p, VIEW_H);
    const source = p.timeline.tracks[0]!.id;
    let target = source;
    let pos = 0;
    setLaneScroll(0);
    while (pos < max) {
      const to = Math.min(max, pos + pxPerFrame);
      const steps = subStep ? autoScrollSubStepCount(to - pos) : 1;
      for (let i = 1; i <= steps; i++) {
        setLaneScroll(clampLaneScroll(p, pos + ((to - pos) * i) / steps, VIEW_H));
        target = laneTargetForMove(y, laneLayout(p), "video", target, source);
      }
      pos = to;
    }
    return target;
  }

  it("sub-steps no wider than half the narrowest hysteresis core", () => {
    const narrowestCore = AUDIO_LANE_H * (1 - 2 * LANE_HYSTERESIS_FRAC);
    expect(AUTOSCROLL_MAX_STEP_PX).toBeCloseTo(narrowestCore / 2, 9);
    expect(AUTOSCROLL_MAX_STEP_PX).toBeLessThan(narrowestCore);
    for (const dy of [0, 0.4, 4.2, 8.7, 17.3, -17.3]) {
      const n = autoScrollSubStepCount(dy);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(Math.abs(dy) / n).toBeLessThanOrEqual(AUTOSCROLL_MAX_STEP_PX);
    }
    // one 30 Hz frame at full speed is ~17 px: five samples, not one
    expect(autoScrollSubStepCount(17.3)).toBe(5);
    expect(autoScrollSubStepCount(0)).toBe(1);
  });

  it("lands on the same lane at every speed a frame can ask for", () => {
    // 0.1 to 40 px covers every (speed, refresh rate) pair the ramp can produce:
    // the slowest is 60 px/s on a 165 Hz display (0.36 px) and the fastest is
    // 520 px/s on a 30 Hz one (17.3 px), with margin either side.
    const p = project(8);
    const last = p.timeline.tracks[7]!.id;
    const y = VIEW_H - 5; // parked hard against the bottom edge
    for (let px = 0.1; px <= 40; px += 0.1) {
      expect(walkTarget(p, y, px, true), `${px.toFixed(1)} px/frame`).toBe(last);
    }
  });

  it("witnesses the skip: sampling once per frame loses lanes at some speeds", () => {
    // Without sub-stepping, a frame wider than a lane's 12 px core can step
    // clean over it, and the drop lands on a lane the user never dragged
    // through. Which speeds miss depends on how the frames happen to line up
    // with the lane pitch — that is exactly the framerate dependence the
    // sub-step removes, and if it were not a real failure the sweep above would
    // be proving nothing.
    const p = project(8);
    const last = p.timeline.tracks[7]!.id;
    const y = VIEW_H - 5;
    const misses: number[] = [];
    for (let px = 0.1; px <= 40; px += 0.1) {
      if (walkTarget(p, y, px, false) !== last) misses.push(px);
    }
    expect(misses.length).toBeGreaterThan(0);
    expect(Math.min(...misses)).toBeGreaterThan(AUTOSCROLL_MAX_STEP_PX);
    // every speed that misses without sub-stepping lands correctly with it
    for (const px of misses) {
      expect(walkTarget(p, y, px, true), `${px.toFixed(1)} px/frame`).toBe(last);
    }
  });

  it("walks back up through the stack the same way", () => {
    const p = project(8);
    const ids = p.timeline.tracks.map((t) => t.id);
    const y = RULER_H + 5;
    let target = ids[7]!;
    let pos = maxLaneScroll(p, VIEW_H);
    while (pos > 0) {
      const to = Math.max(0, pos - 17.3);
      const steps = autoScrollSubStepCount(to - pos);
      for (let i = 1; i <= steps; i++) {
        setLaneScroll(clampLaneScroll(p, pos + ((to - pos) * i) / steps, VIEW_H));
        target = laneTargetForMove(y, laneLayout(p), "video", target, ids[7]!);
      }
      pos = to;
    }
    expect(target).toBe(ids[0]);
  });
});
