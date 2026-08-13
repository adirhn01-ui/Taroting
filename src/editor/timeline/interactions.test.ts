// Gesture-level behaviour of the timeline canvas: what a right-click selects,
// where a hit lands relative to what is painted, what a marker drag writes and
// when, and the auto-scroll loop the media-bin drop borrows from here.
//
// vite.config pins `environment: "node"`, so there is no DOM. `attachInteractions`
// needs very little of one — a canvas that records listeners, a window that takes
// a keydown, and a frame clock — so the harness below supplies exactly that and
// drives the REAL handlers. Everything the tests assert against is either the
// real `draw()` output or the real project/history mutators.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { History } from "../../core/history";
import { addMarkerAt, removeMarker } from "../../core/project";
import type { Clip, Marker, ProjectFile, Track } from "../../core/types";
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
} from "./render";
import {
  AUTOSCROLL_MAX_PX_PER_SEC,
  AUTOSCROLL_ZONE_PX,
  attachInteractions,
  createLaneAutoScroll,
  laneAutoScrollVelocity,
} from "./interactions";
import type { TimelineController } from "./timeline";

/** The real host: a 280px panel less the ~49px transport row. */
const VIEW_H = 231;
/** Whole pixels per second, so every fixture time maps to an exact x and `tOf`
 *  inverts `xOf` without float slack. */
const PPS = 4;

/* ------------------------------------------------------------------ *
 * Fixtures. Every value differs on every axis the code could confuse:
 * no lane is at t=0, no two markers are evenly spaced, the dragged marker
 * is neither the first nor the last, and the drag target is not a midpoint.
 * ------------------------------------------------------------------ */

function track(id: string, kind: "video" | "audio", clips: Clip[] = []): Track {
  return { id, kind, name: id, muted: false, clips };
}

function project(video: number, audio = 0, markers?: Marker[]): ProjectFile {
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
    timeline: { fps: { num: 30, den: 1 }, width: 1920, height: 1080, tracks, markers },
    export: {} as ProjectFile["export"],
  };
}

/** Three markers at unequal spacing; `m-b` is the one every drag test moves, so
 *  a fix that moved the wrong marker (or all of them) fails visibly. */
const MARKERS: Marker[] = [
  { id: "m-a", t: 3.5, color: 0 }, // x = 14
  { id: "m-b", t: 11.25, color: 2 }, // x = 45
  { id: "m-c", t: 19.75, color: 4 }, // x = 79
];
const DRAG_TO_T = 17.5; // x = 70 — past m-b's neighbour spacing, not a midpoint

/* ------------------------------------------------------------------ *
 * A recording 2D context, so "what does render.ts actually paint here?"
 * is answered by running the real draw() rather than by restating it.
 * ------------------------------------------------------------------ */

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

interface Painted {
  /** Lane background bands, in draw order: exactly the lanes draw() emitted. */
  lanes: Array<{ y: number; h: number }>;
  /** Distinct x of every marker stem/pennant vertex, which draw() is alone in
   *  emitting at y === 2. */
  markerX: number[];
}

function paint(p: ProjectFile, drag: Parameters<typeof draw>[1]["drag"] = null): Painted {
  const lanes: Array<{ y: number; h: number }> = [];
  const markerX = new Set<number>();
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
    lineTo: noop,
    closePath: noop,
    setLineDash: noop,
    fillText: noop,
    moveTo(x: number, y: number): void {
      // Markers are the only thing draw() starts at y === 2 (ruler ticks start
      // at RULER_H-12 / RULER_H-6, the playhead arrow at y === 0).
      if (y === 2) markerX.add(x);
    },
    fillRect(_x: number, y: number, _w: number, h: number): void {
      if (ctx.fillStyle === PROBE_COLORS.laneBg) lanes.push({ y, h });
    },
  };
  draw(ctx as unknown as CanvasRenderingContext2D, {
    project: p,
    t0: 0,
    pxPerSec: PPS,
    width: 700,
    height: VIEW_H,
    playhead: -99, // parked off-screen so it cannot be mistaken for a marker
    selectedClipId: null,
    drag,
    guideT: null,
    colors: PROBE_COLORS,
    waveforms: {},
    mediaById: new Map(),
  });
  return { lanes, markerX: [...markerX].sort((a, b) => a - b) };
}

/** The track whose PAINTED band covers `y`, or null when nothing is painted
 *  there. The lane bands come from the real draw(); mapping them back to a
 *  track goes through laneLayout, which draw() itself used. */
function paintedTrackAt(p: ProjectFile, y: number): string | null {
  const lanes = laneLayout(p);
  for (const band of paint(p).lanes) {
    if (y >= band.y && y < band.y + band.h) {
      const lane = lanes.find((l) => l.y === band.y && l.h === band.h);
      return lane ? lane.track.id : null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The harness: the real attachInteractions against a stand-in canvas.
 * ------------------------------------------------------------------ */

type AnyFn = (e: never) => void;

interface Harness {
  /** Ordered log of everything the controller was asked to do, so a test can
   *  assert ORDER (select before menu) and not just occurrence. */
  log: string[];
  markerAt(id: string): number | null;
  project(): ProjectFile;
  undo(): void;
  /** A commit from outside the gesture — a shortcut, a menu action. */
  foreignCommit(mutate: (p: ProjectFile) => ProjectFile): void;
  playhead(): number;
  drag(): TimelineController["drag"];
  down(x: number, y: number): void;
  move(x: number, y: number): void;
  up(): void;
  escape(): void;
  cancel(): void;
  context(x: number, y: number): void;
  detach(): void;
}

function harness(initial: ProjectFile): Harness {
  const listeners = new Map<string, AnyFn[]>();
  const winListeners = new Map<string, AnyFn[]>();
  const add = (map: Map<string, AnyFn[]>, type: string, fn: AnyFn): void => {
    const arr = map.get(type);
    if (arr) arr.push(fn);
    else map.set(type, [fn]);
  };
  const remove = (map: Map<string, AnyFn[]>, type: string, fn: AnyFn): void => {
    const arr = map.get(type);
    if (arr) map.set(type, arr.filter((f) => f !== fn));
  };

  const canvas = {
    style: { cursor: "" },
    addEventListener: (t: string, fn: AnyFn) => add(listeners, t, fn),
    removeEventListener: (t: string, fn: AnyFn) => remove(listeners, t, fn),
    setPointerCapture: (): void => {},
    hasPointerCapture: (): boolean => true,
    releasePointerCapture: (): void => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: VIEW_H }),
  };

  // attachInteractions binds Escape on window in the capture phase.
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (t: string, fn: AnyFn) => add(winListeners, t, fn),
    removeEventListener: (t: string, fn: AnyFn) => remove(winListeners, t, fn),
  };

  // Mirrors ProjectSession exactly: commit pushes the state BEFORE the mutation
  // and treats an unchanged reference as "no change"; commitFrom pushes a
  // caller-supplied before; replace writes with no history entry.
  const history = new History<ProjectFile>();
  let current = initial;
  let head = -99;
  const log: string[] = [];

  const tl = {
    canvas,
    view: { t0: 0, pxPerSec: PPS, width: 700, height: VIEW_H },
    drag: null as TimelineController["drag"],
    project: () => current,
    playhead: () => head,
    xOf: (t: number) => (t - 0) * PPS,
    tOf: (x: number) => x / PPS,
    snapEnabled: () => true,
    select(id: string | null) {
      log.push(`select:${id ?? "null"}`);
    },
    seek(t: number) {
      head = t;
    },
    requestRender() {},
    commit(mutate: (p: ProjectFile) => ProjectFile) {
      const before = current;
      const after = mutate(before);
      if (after === before) return;
      history.push(before);
      current = after;
      log.push("commit");
    },
    commitFrom(before: ProjectFile) {
      if (current === before) return;
      history.push(before);
      log.push("commitFrom");
    },
    setDrag(d: TimelineController["drag"]) {
      tl.drag = d;
    },
    clipMenu(clip: Clip) {
      log.push(`clipMenu:${clip.id}`);
    },
    laneMenu(t: Track) {
      log.push(`laneMenu:${t.id}`);
    },
    scrollLanesTo(px: number) {
      setLaneScroll(clampLaneScroll(current, px, VIEW_H));
    },
  };

  const detachInteractions = attachInteractions(tl as unknown as TimelineController);

  const fire = (map: Map<string, AnyFn[]>, type: string, e: unknown): void => {
    for (const fn of [...(map.get(type) ?? [])]) (fn as (x: unknown) => void)(e);
  };
  const pointer = (x: number, y: number): unknown => ({
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
  });

  return {
    log,
    markerAt: (id) => current.timeline.markers?.find((m) => m.id === id)?.t ?? null,
    project: () => current,
    undo() {
      const prev = history.undo(current);
      if (prev) current = prev;
    },
    foreignCommit(mutate) {
      const before = current;
      const after = mutate(before);
      if (after === before) return;
      history.push(before);
      current = after;
    },
    playhead: () => head,
    drag: () => tl.drag,
    down: (x, y) => fire(listeners, "pointerdown", pointer(x, y)),
    move: (x, y) => fire(listeners, "pointermove", pointer(x, y)),
    up: () => fire(listeners, "pointerup", pointer(0, 0)),
    escape: () =>
      fire(winListeners, "keydown", {
        key: "Escape",
        preventDefault() {},
        stopPropagation() {},
      }),
    cancel: () => fire(listeners, "pointercancel", pointer(0, 0)),
    context: (x, y) => fire(listeners, "contextmenu", pointer(x, y)),
    detach() {
      detachInteractions();
      delete (globalThis as unknown as { window?: unknown }).window;
    },
  };
}

let active: Harness | null = null;
beforeEach(() => setLaneScroll(0));
afterEach(() => {
  active?.detach();
  active = null;
  setLaneScroll(0);
});

/* ------------------------------------------------------------------ *
 * 1. Right-clicking a lane must not leave a selection behind it.
 * ------------------------------------------------------------------ */

describe("lane context menu and the selection under it", () => {
  /** Inside lane 1 at scroll 0: RULER_H + LANE_GAP + VIDEO_LANE_H + LANE_GAP. */
  const LANE1_Y = RULER_H + LANE_GAP + VIDEO_LANE_H + LANE_GAP + 10;

  it("clears the selection BEFORE opening the menu", () => {
    const h = (active = harness(project(3)));
    h.context(200, LANE1_Y);
    // Order matters: a menu built while a stale selection is still live is the
    // window in which an item could read it.
    expect(h.log).toEqual(["select:null", "laneMenu:v1"]);
  });

  it("still opens the menu for the lane actually under the cursor", () => {
    const h = (active = harness(project(4)));
    h.context(120, RULER_H + LANE_GAP + 5); // lane 0
    h.context(120, LANE1_Y); // lane 1
    expect(h.log.filter((l) => l.startsWith("laneMenu"))).toEqual(["laneMenu:v0", "laneMenu:v1"]);
  });

  it("leaves the selection alone over the ruler, which opens no menu at all", () => {
    const h = (active = harness(project(3)));
    h.context(200, RULER_H - 1);
    expect(h.log).toEqual([]);
  });

  it("leaves the selection alone below the last lane, which also opens no menu", () => {
    const h = (active = harness(project(1)));
    // 1 video lane: everything past RULER_H + LANE_GAP + VIDEO_LANE_H is empty.
    h.context(200, RULER_H + LANE_GAP + VIDEO_LANE_H + 20);
    expect(h.log).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. hitTest boundary: the row at RULER_H, and every lane's last row.
 * ------------------------------------------------------------------ */

describe("a hit lands on the surface that is painted there", () => {
  /** The scroll at which lane 0's BOTTOM sits exactly on RULER_H: it has no
   *  visible row left, draw() skips it, and it is the lane an inclusive end
   *  bound handed the y === RULER_H pixel to. */
  const SCROLL_LANE0_FLUSH = RULER_H + LANE_GAP + VIDEO_LANE_H - RULER_H; // 64

  /** What the context menu reveals about the hit: a lane id, or null for the
   *  ruler and for empty space (neither opens a menu). */
  function hitTrackAt(h: Harness, y: number): string | null {
    const before = h.log.length;
    h.context(200, y);
    const entry = h.log.slice(before).find((l) => l.startsWith("laneMenu:"));
    return entry ? entry.slice("laneMenu:".length) : null;
  }

  it("pins the three rows around the ruler seam to what draw() paints", () => {
    const p = project(8);
    expect(maxLaneScroll(p, VIEW_H)).toBeGreaterThan(SCROLL_LANE0_FLUSH);
    setLaneScroll(SCROLL_LANE0_FLUSH);
    const h = (active = harness(p));

    // Lane 0 is flush against the ruler and lane 1 starts LANE_GAP below it, so
    // the seam reads: ruler, then gap, then gap — no lane on any of the three.
    expect(paintedTrackAt(p, RULER_H - 1)).toBe(null);
    expect(paintedTrackAt(p, RULER_H)).toBe(null);
    expect(paintedTrackAt(p, RULER_H + 1)).toBe(null);

    expect(hitTrackAt(h, RULER_H - 1)).toBe(null); // the ruler owns y < RULER_H
    expect(hitTrackAt(h, RULER_H)).toBe(null); // was lane 0 — a lane with no visible row
    expect(hitTrackAt(h, RULER_H + 1)).toBe(null);

    // …and the first row lane 1 actually paints does hit lane 1, so the fix did
    // not simply make the seam inert.
    const lane1 = laneLayout(p)[1]!;
    expect(lane1.y).toBe(RULER_H + LANE_GAP);
    expect(paintedTrackAt(p, lane1.y)).toBe("v1");
    expect(hitTrackAt(h, lane1.y)).toBe("v1");
  });

  it("gives every lane exactly the rows it paints, and the gaps to nobody", () => {
    const p = project(3, 1);
    const h = (active = harness(p));
    for (const lane of laneLayout(p)) {
      const last = lane.y + lane.h - 1;
      const past = lane.y + lane.h;
      expect(paintedTrackAt(p, lane.y), `top of ${lane.track.id}`).toBe(lane.track.id);
      expect(paintedTrackAt(p, last), `last row of ${lane.track.id}`).toBe(lane.track.id);
      expect(paintedTrackAt(p, past), `gap under ${lane.track.id}`).not.toBe(lane.track.id);

      expect(hitTrackAt(h, lane.y), `hit top of ${lane.track.id}`).toBe(lane.track.id);
      expect(hitTrackAt(h, last), `hit last row of ${lane.track.id}`).toBe(lane.track.id);
      expect(hitTrackAt(h, past), `hit gap under ${lane.track.id}`).not.toBe(lane.track.id);
    }
  });

  it("agrees with draw() on every row of the lane band, at several scrolls", () => {
    const p = project(6, 2);
    const max = maxLaneScroll(p, VIEW_H);
    for (const s of [0, 17, 64, 93, max]) {
      setLaneScroll(s);
      const h = harness(p);
      try {
        for (let y = RULER_H; y < VIEW_H; y++) {
          expect(hitTrackAt(h, y), `scroll ${s}, y ${y}`).toBe(paintedTrackAt(p, y));
        }
      } finally {
        h.detach();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. A marker drag previews; it does not write the project until release.
 * ------------------------------------------------------------------ */

describe("marker drag: preview, commit, and what an undo lands on", () => {
  const M_B_X = 45; // xOf(11.25)
  const DRAG_X = 70; // xOf(17.5)

  it("writes nothing to the project while the drag is in flight", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    const before = h.project();

    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);

    // Same project OBJECT: no replace, no commit, no dirty flag, no history.
    expect(h.project()).toBe(before);
    expect(h.markerAt("m-b")).toBe(11.25);
    expect(h.log).toEqual([]);
    // The position lives in the drag override instead.
    expect(h.drag()).toEqual({ kind: "marker", markerId: "m-b", t: DRAG_TO_T });
    // and the playhead follows, so you can see the frame you are marking
    expect(h.playhead()).toBe(DRAG_TO_T);
  });

  it("commits exactly one entry on release", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);
    h.up();

    expect(h.log).toEqual(["commit"]);
    expect(h.markerAt("m-b")).toBe(DRAG_TO_T);
    // the other two are untouched
    expect(h.markerAt("m-a")).toBe(3.5);
    expect(h.markerAt("m-c")).toBe(19.75);

    h.undo();
    expect(h.markerAt("m-b")).toBe(11.25);
  });

  it("records nothing at all for a press that never moved the marker", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    const before = h.project();
    h.down(M_B_X, 10);
    h.up();
    expect(h.log).toEqual([]);
    expect(h.project()).toBe(before);
  });

  it("restores the PRE-DRAG position when a foreign edit made mid-drag is undone", () => {
    // The residual bug, in the order it actually happens: the drag starts, an
    // unrelated commit lands while it is in flight, the drag is released, and
    // both are undone. Every marker time here is distinct, so a wrong answer can
    // only be the mid-drag position — nothing else in the fixture equals 17.5.
    const h = (active = harness(project(2, 0, MARKERS)));

    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);

    // A shortcut deletes a DIFFERENT marker while the drag is held.
    h.foreignCommit((p) => removeMarker(p, "m-c"));
    expect(h.markerAt("m-c")).toBe(null);

    h.up();
    expect(h.markerAt("m-b")).toBe(DRAG_TO_T);

    // First undo: the drag only. The foreign delete stays deleted.
    h.undo();
    expect(h.markerAt("m-b")).toBe(11.25);
    expect(h.markerAt("m-c")).toBe(null);

    // Second undo: the foreign delete. m-c returns — and m-b must be where it
    // was BEFORE the drag, not at the position the pointer merely passed
    // through. This is the assertion the old live-write shape failed: the
    // foreign commit snapshotted the marker at 17.5.
    h.undo();
    expect(h.markerAt("m-c")).toBe(19.75);
    expect(h.markerAt("m-b")).toBe(11.25);
  });

  it("keeps a foreign ADD made mid-drag intact through the drag's own commit", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);
    h.foreignCommit((p) => addMarkerAt(p, 27.5, 3).project);
    h.up();

    expect(h.markerAt("m-b")).toBe(DRAG_TO_T);
    expect(h.project().timeline.markers?.some((m) => m.t === 27.5)).toBe(true);
    h.undo();
    // the drag undone, the added marker still there
    expect(h.markerAt("m-b")).toBe(11.25);
    expect(h.project().timeline.markers?.some((m) => m.t === 27.5)).toBe(true);
  });

  it("drops the override on Escape without committing anything", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    const before = h.project();
    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);
    h.escape();

    expect(h.project()).toBe(before);
    expect(h.markerAt("m-b")).toBe(11.25);
    expect(h.log).toEqual([]);
    expect(h.drag()).toBe(null);
    expect(h.playhead()).toBe(11.25); // playhead back where the drag started
  });

  it("drops the override on pointercancel too", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    const before = h.project();
    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);
    h.cancel();

    expect(h.project()).toBe(before);
    expect(h.drag()).toBe(null);
    expect(h.log).toEqual([]);
  });

  it("commits nothing when the marker was deleted mid-drag", () => {
    const h = (active = harness(project(2, 0, MARKERS)));
    h.down(M_B_X, 10);
    h.move(DRAG_X, 10);
    h.foreignCommit((p) => removeMarker(p, "m-b"));
    h.up();
    expect(h.log).toEqual([]); // no resurrection, no empty history entry
    expect(h.markerAt("m-b")).toBe(null);
  });

  it("draws the dragged marker from the override and the rest from the project", () => {
    const p = project(2, 0, MARKERS);
    const at = (t: number): number => Math.round(t * PPS) + 0.5;

    expect(paint(p).markerX).toEqual([at(3.5), at(11.25), at(19.75)]);

    const dragged = paint(p, { kind: "marker", markerId: "m-b", t: DRAG_TO_T });
    expect(dragged.markerX).toEqual([at(3.5), at(DRAG_TO_T), at(19.75)]);
    // the project itself is untouched by drawing
    expect(p.timeline.markers?.find((m) => m.id === "m-b")?.t).toBe(11.25);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The auto-scroll loop the media-bin drop borrows.
 * ------------------------------------------------------------------ */

describe("createLaneAutoScroll", () => {
  interface Pump {
    /** Frames currently requested. */
    depth(): number;
    /** Run every pending frame with timestamp `ms`. */
    frame(ms: number): void;
    restore(): void;
  }

  function fakeRaf(): Pump {
    const realReq = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    let pending: Array<{ id: number; fn: FrameRequestCallback }> = [];
    let next = 1;
    globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
      const id = next++;
      pending.push({ id, fn });
      return id;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      pending = pending.filter((f) => f.id !== id);
    }) as typeof globalThis.cancelAnimationFrame;
    return {
      depth: () => pending.length,
      frame(ms: number) {
        const due = pending;
        pending = [];
        for (const f of due) f.fn(ms);
      },
      restore() {
        globalThis.requestAnimationFrame = realReq;
        globalThis.cancelAnimationFrame = realCancel;
      },
    };
  }

  function scroller(p: ProjectFile, onStep: () => void = () => {}) {
    const tl = {
      view: { t0: 0, pxPerSec: PPS, width: 700, height: VIEW_H },
      project: () => p,
      scrollLanesTo(px: number) {
        setLaneScroll(clampLaneScroll(p, px, VIEW_H));
      },
    };
    return createLaneAutoScroll(tl as unknown as TimelineController, onStep);
  }

  let pump: Pump;
  beforeEach(() => {
    pump = fakeRaf();
  });
  afterEach(() => pump.restore());

  it("stays completely asleep until it is aimed into an edge zone", () => {
    const s = scroller(project(8));
    expect(pump.depth()).toBe(0);
    s.aim(null);
    expect(pump.depth()).toBe(0);
    // the inert middle of the viewport
    s.aim(RULER_H + AUTOSCROLL_ZONE_PX + 20);
    expect(pump.depth()).toBe(0);
    s.stop();
    expect(pump.depth()).toBe(0);
  });

  it("does nothing on a project with nothing to scroll", () => {
    // 3 video lanes fit in 231px, so maxLaneScroll is 0 and a bin drag over the
    // edge must behave exactly as it did before this existed.
    const p = project(3);
    expect(maxLaneScroll(p, VIEW_H)).toBe(0);
    const s = scroller(p);
    s.aim(VIEW_H - 1);
    expect(pump.depth()).toBe(0);
    expect(laneScroll()).toBe(0);
  });

  it("scrolls at the ramp velocity over elapsed time, and re-resolves each step", () => {
    const p = project(10);
    let steps = 0;
    const s = scroller(p, () => steps++);
    const y = VIEW_H - 1; // one px from the bottom: near full speed
    const v = laneAutoScrollVelocity(y, VIEW_H);
    expect(v).toBeGreaterThan(0);

    s.aim(y);
    expect(pump.depth()).toBe(1);

    pump.frame(1000); // first tick only starts the clock
    expect(laneScroll()).toBe(0);
    expect(steps).toBe(0);

    pump.frame(1040); // 40 ms
    expect(laneScroll()).toBe(Math.round(v * 0.04));
    expect(steps).toBe(1);

    pump.frame(1080);
    expect(laneScroll()).toBe(Math.round(v * 0.08));
    expect(steps).toBe(2);
  });

  it("pulls the other way from the ruler end, and stops once pinned at the top", () => {
    const p = project(10);
    setLaneScroll(30);
    const s = scroller(p);
    s.aim(RULER_H + 1); // deep in the top zone
    // Each tick is capped at AUTOSCROLL_MAX_STEP_SEC however long the frame
    // took, so reaching the top is several ticks whatever timestamps are fed in
    // — which is the dropped-frame clamp doing its job, not a slow loop.
    let ts = 0;
    for (let i = 0; i < 200 && pump.depth() > 0; i++) pump.frame((ts += 16));
    expect(laneScroll()).toBe(0);
    // pinned at the top: the loop found no velocity left and died on its own
    expect(pump.depth()).toBe(0);
  });

  it("stops at the bottom instead of spinning forever", () => {
    const p = project(10);
    const max = maxLaneScroll(p, VIEW_H);
    const s = scroller(p);
    s.aim(VIEW_H + 200); // outside the canvas: the deepest case, full speed
    expect(laneAutoScrollVelocity(VIEW_H + 200, VIEW_H)).toBe(AUTOSCROLL_MAX_PX_PER_SEC);
    let ts = 0;
    for (let i = 0; i < 400 && pump.depth() > 0; i++) pump.frame((ts += 16));
    expect(laneScroll()).toBe(max);
    expect(pump.depth()).toBe(0);
  });

  it("parks on aim(null) and on stop(), from any state", () => {
    const p = project(10);
    const s = scroller(p);
    s.aim(VIEW_H - 1);
    pump.frame(0);
    pump.frame(32);
    const reached = laneScroll();
    expect(reached).toBeGreaterThan(0);

    s.aim(null);
    expect(pump.depth()).toBe(0);
    pump.frame(64);
    expect(laneScroll()).toBe(reached);

    // and re-aiming picks up from where the stack actually is
    s.aim(VIEW_H - 1);
    pump.frame(100);
    pump.frame(140);
    expect(laneScroll()).toBeGreaterThan(reached);

    s.stop();
    expect(pump.depth()).toBe(0);
    s.stop(); // idempotent
    expect(pump.depth()).toBe(0);
  });

  it("never runs two loops, even when onStep aims it again", () => {
    // The drop resolver calls aim() from inside onStep. If the loop re-armed
    // AFTER the callback, that aim would find the handle clear and start a
    // second loop whose handle the first then overwrote — two ticks a frame and
    // one rAF nothing could cancel.
    const p = project(10);
    let s: ReturnType<typeof scroller>;
    let reentered = 0;
    s = scroller(p, () => {
      reentered++;
      s.aim(VIEW_H - 1);
    });
    s.aim(VIEW_H - 1);
    let ts = 0;
    for (let i = 0; i < 6; i++) {
      expect(pump.depth(), `after frame ${i}`).toBe(1);
      pump.frame((ts += 16));
    }
    expect(reentered).toBeGreaterThan(0);
    expect(pump.depth()).toBe(1);
  });

  it("brings a lane that no bin drag could reach under the pointer", () => {
    // The bug, end to end. `resolveLane` is the media-bin resolver's predicate
    // (editor.ts): the lane whose laneLayout rect contains the pointer. At
    // scroll 0 the last lane of a tall project is not among them at any y, so
    // the drop could never target it.
    const p = project(9, 2);
    const lanes = () => laneLayout(p);
    const resolveLane = (y: number): string | null =>
      lanes().find((l) => y >= l.y && y < l.y + l.h)?.track.id ?? null;
    const lastId = p.timeline.tracks[p.timeline.tracks.length - 1]!.id;

    setLaneScroll(0);
    for (let y = RULER_H; y < VIEW_H; y++) expect(resolveLane(y)).not.toBe(lastId);

    // Park the pointer on the last row a lane can ever occupy. `totalLanesHeight`
    // ends with a trailing LANE_GAP that becomes bottom padding, so at full
    // scroll the last lane stops at VIEW_H - LANE_GAP and the final few rows are
    // pad, not lane. Still well inside the bottom edge zone, so the pull is the
    // same one a pointer held against the very edge gets.
    const y = VIEW_H - LANE_GAP - 1;
    expect(y).toBeGreaterThanOrEqual(VIEW_H - AUTOSCROLL_ZONE_PX);
    const s = scroller(p);
    s.aim(y);
    let ts = 0;
    for (let i = 0; i < 400 && pump.depth() > 0; i++) pump.frame((ts += 16));

    expect(laneScroll()).toBe(maxLaneScroll(p, VIEW_H));
    expect(resolveLane(y)).toBe(lastId);
    // …and it agrees with what draw() paints there, which is the invariant the
    // note on laneScrollY in render.ts names.
    expect(paintedTrackAt(p, y)).toBe(lastId);
  });

  it("reaches the audio lanes at the bottom of a mixed stack", () => {
    const p = project(6, 3);
    const s = scroller(p);
    const y = VIEW_H - LANE_GAP - 1;
    s.aim(y);
    let ts = 0;
    for (let i = 0; i < 400 && pump.depth() > 0; i++) pump.frame((ts += 16));
    const lane = laneLayout(p).find((l) => y >= l.y && y < l.y + l.h);
    expect(lane?.track.kind).toBe("audio");
    expect(lane?.h).toBe(AUDIO_LANE_H);
  });
});
