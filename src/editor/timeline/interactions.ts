// Pointer interactions: select, move, trim, scrub, zoom, pan, and the lane
// auto-scroll that lets a clip move reach a lane scrolled out of view. Drags are
// transient (rendered as overrides); the project mutates once on pointer-up.

import { moveClip, moveMarkerTo, removeMarker, trimClip, findClip } from "../../core/project";
import { clipDuration, clipEnd } from "../../core/time";
import type { Clip, Marker, ProjectFile, Track } from "../../core/types";
import { showMenu } from "../../ui/menu";
import {
  AUDIO_LANE_H,
  EDGE_ZONE_PX,
  KF_STRIP_H,
  MARKER_HIT_PX,
  RULER_H,
  clipDiamondTimes,
  laneLayout,
  laneScroll,
  maxLaneScroll,
} from "./render";
import { LANE_HYSTERESIS_FRAC, laneTargetForMove } from "./lane-target";
import { collectCandidates, snapMove, snapTime } from "./snap";
import type { TimelineController } from "./timeline";

export type DragState =
  | { kind: "move"; clipId: string; start: number; toTrackId: string }
  | { kind: "trimIn"; clipId: string; t: number }
  | { kind: "trimOut"; clipId: string; t: number }
  /**
   * A marker being dragged, and the ONLY record of where the drag has put it.
   *
   * The marker drag used to live-write the shared project on every pointermove,
   * which is why it is the one gesture the file header's promise was not true
   * of. Any commit that landed mid-drag — a shortcut, a menu action, an
   * autosave-adjacent edit — snapshotted the marker WHERE THE POINTER HAPPENED
   * TO BE, so undoing that unrelated edit restored the marker to a position it
   * had merely passed through. Nothing put it back afterwards, so the residue
   * survived the whole history.
   *
   * Now the project keeps the marker at its pointerdown position for the whole
   * gesture and render.ts draws it from `t`, so a foreign snapshot can only ever
   * capture a position the marker actually had.
   */
  | { kind: "marker"; markerId: string; t: number }
  | null;

/** "Is this the same position?" for gesture bookkeeping: far below one frame at
 *  120 fps, and far above the float noise of running the same placement
 *  arithmetic twice over the same numbers. */
const POS_EPS = 1e-9;

/**
 * Where a move gesture will ACTUALLY land the clip.
 *
 * `snapMove` answers "what is the pointer asking for", which is not where the
 * clip goes: the commit runs `moveClip`, and that pushes the requested start
 * through `resolvePosition`, which relocates the clip to the nearest gap big
 * enough to hold it. Previewing the request drew the ghost at 12 s while the
 * commit put the clip at 300 s on a dense track — the clip snapped out from
 * under the cursor on release, and on a long track it landed off-screen, which
 * reads as "my clip disappeared".
 *
 * So the preview runs the real mutator and reads the result back, exactly as the
 * trim path does. It is cheap for the same reason: ProjectFile is structurally
 * shared, so the throwaway project rebuilds two track arrays and reuses every
 * clip, media and marker object underneath.
 */
export function resolveMoveStart(
  project: ProjectFile,
  clipId: string,
  requestedStart: number,
  toTrackId: string,
): number {
  const preview = moveClip(project, clipId, requestedStart, toTrackId);
  // moveClip is total: an unknown clip, or a lane of the wrong kind, returns the
  // project untouched. Reading the position back out of it then reports "the
  // clip does not move", which is exactly what the commit would do.
  return findClip(preview, clipId)?.clip.timelineStart ?? requestedStart;
}

/* ---------------- lane auto-scroll: the pure part ----------------
 *
 * Dragging a clip to a lane that is scrolled out of view needs the stack to come
 * to the pointer, so a move gesture near the top or bottom of the lane area
 * scrolls it. Everything about WHERE it engages, HOW FAST it pulls and how far
 * one frame may carry it lives in the pure functions below; the loop that drives
 * them is in `attachInteractions` and exists only for the duration of a move
 * gesture. There is deliberately no scroll offset anywhere in here — lane
 * geometry comes from `laneLayout`, which folds it in, so hit-testing and
 * drawing cannot drift apart (see the note on laneScrollY in render.ts). */

/** Height of the band at each end of the lane area that arms auto-scroll. Just
 *  under half a video lane: deep enough to be easy to hold, shallow enough that
 *  the middle of the viewport — where most targeting happens — is inert. */
export const AUTOSCROLL_ZONE_PX = 26;

/** Speed at the shallow edge of the zone, px/s. Deliberately NOT zero: a ramp
 *  that starts at zero makes the first few px of the zone a dead band that looks
 *  like auto-scroll is broken, and the user overshoots past it hunting for the
 *  speed. 60 px/s is about one video lane per second — unmistakably moving, slow
 *  enough to stop on the lane you want. */
export const AUTOSCROLL_MIN_PX_PER_SEC = 60;

/** Speed at (and past) the far edge of the zone, px/s. Crosses the ~231 px lane
 *  area in under half a second, so a 40-lane project is traversable without
 *  letting go, and it is reached only by pushing the pointer fully to the edge. */
export const AUTOSCROLL_MAX_PX_PER_SEC = 520;

/** Longest elapsed time a single tick will integrate, seconds. A dropped frame
 *  (GC, a background tab, a slow export writing frames) must not teleport the
 *  lane stack half a project on the tick that follows it. */
export const AUTOSCROLL_MAX_STEP_SEC = 0.05;

/**
 * Largest scroll one retarget sample may cover, px.
 *
 * `laneTargetForMove` only adopts a lane once the pointer is inside that lane's
 * hysteresis core — the lane inset by LANE_HYSTERESIS_FRAC at each end — and the
 * narrowest core in the app is an audio lane's, 42 * 0.2 = 8.4 px. A single
 * frame at full speed is wider than that (520 px/s is ~8.7 px at 60 Hz, ~17 px
 * at 30 Hz), so sampling the target once per frame would let a lane's core slide
 * past a parked pointer between two samples and the target would skip it.
 *
 * Half the narrowest core guarantees at least one sample lands inside every core
 * the stack drags past, which is what makes a fast auto-scroll settle on the
 * same lane a slow one would.
 */
export const AUTOSCROLL_MAX_STEP_PX = (AUDIO_LANE_H * (1 - 2 * LANE_HYSTERESIS_FRAC)) / 2;

/** Speed for a normalized depth into the edge zone (0 at the inner boundary, 1
 *  at the outer edge and beyond). Affine in the depth: "twice as far in" really
 *  is twice as much of the range, which is what makes it predictable to aim. */
function autoScrollSpeed(depth: number): number {
  const d = depth > 1 ? 1 : depth;
  return (
    AUTOSCROLL_MIN_PX_PER_SEC + (AUTOSCROLL_MAX_PX_PER_SEC - AUTOSCROLL_MIN_PX_PER_SEC) * d
  );
}

/**
 * Scroll velocity in px/s for a pointer at canvas-local `y`: negative scrolls the
 * lane stack up (towards lane 0), positive down, 0 means the pointer is not in an
 * edge zone at all.
 *
 * The scrollable band is [RULER_H, viewportH] — the ruler is pinned and is not
 * part of it. A pointer beyond either end (the drag has pointer capture, so it
 * keeps reporting positions outside the canvas) is simply the deepest case, i.e.
 * full speed.
 *
 * On a host too short to hold two whole zones they meet in the middle instead of
 * overlapping, so no y is ever in both and the sign is never ambiguous.
 */
export function laneAutoScrollVelocity(
  y: number,
  viewportH: number,
  zone = AUTOSCROLL_ZONE_PX,
): number {
  const z = Math.min(zone, (viewportH - RULER_H) / 2);
  if (!(z > 0)) return 0;
  const up = RULER_H + z - y;
  if (up > 0) return -autoScrollSpeed(up / z);
  const down = y - (viewportH - z);
  if (down > 0) return autoScrollSpeed(down / z);
  return 0;
}

/**
 * Advance a scroll position by `velocity` over `dtSec`, clamped to [0, max].
 *
 * Elapsed time, not a per-frame constant: the same gesture must travel the same
 * distance per second on a 60 Hz and a 165 Hz display.
 *
 * `pos` is a float and the caller keeps it that way. The controller pixel-snaps
 * what it stores, so feeding the stored value back would round every sub-pixel
 * step away and the slow end of the ramp would never move at all.
 */
export function nextLaneScroll(
  pos: number,
  velocity: number,
  dtSec: number,
  max: number,
): number {
  const dt = dtSec > 0 ? Math.min(dtSec, AUTOSCROLL_MAX_STEP_SEC) : 0;
  const next = pos + velocity * dt;
  if (!(next > 0)) return 0;
  return next > max ? max : next;
}

/** How many retarget samples one frame's scroll of `dy` px must be split into —
 *  see AUTOSCROLL_MAX_STEP_PX. Always at least 1, so a still frame still samples
 *  once. */
export function autoScrollSubStepCount(dy: number): number {
  const n = Math.ceil(Math.abs(dy) / AUTOSCROLL_MAX_STEP_PX);
  return n > 1 ? n : 1;
}

/* ---------------- lane auto-scroll: for a gesture that is not ours ----------------
 *
 * The canvas drag above is not the only way a clip lands on a lane. Dragging a
 * row out of the media bin resolves its target lane from `laneLayout`, exactly
 * as `hitTest` does — so a lane scrolled out of view was a lane a bin item could
 * not be dropped on, while an identical-looking drag of a clip already on the
 * timeline reached it fine. That gesture lives in editor.ts (it is a pointer
 * drag, not HTML5 drag-and-drop), so what it needs from here is the loop, driven
 * from outside.
 *
 * A rAF loop rather than an event-driven tick, for the reason the gesture exists
 * at all: the pointer PARKS at the edge and waits for the stack to come to it,
 * and a stationary pointer emits no move events. Ticking off the events would
 * stall at exactly the moment the feature is being used.
 */

export interface LaneAutoScroller {
  /** Point the loop at a canvas-local y, or `null` when the pointer is not over
   *  the lane area at all. Idempotent and cheap enough for every pointermove:
   *  the zone test is pure arithmetic and answers "no" almost always, so the
   *  common case never walks the tracks. */
  aim(y: number | null): void;
  /** Stop, unconditionally and idempotently. The caller's single exit — wire it
   *  to whatever ends the drag, the way `endGesture` owns `stopAutoScroll`. */
  stop(): void;
}

/**
 * A lane auto-scroll loop for an outside gesture.
 *
 * Where it engages, how hard it pulls and how far one frame may carry it all
 * come from the same pure functions the canvas loop uses, so the two gestures
 * scroll identically — a drag from the bin and a drag of a clip feel the same
 * because they ARE the same numbers.
 *
 * `onStep` runs after each frame that actually scrolled: the lanes have slid
 * under a stationary pointer, so whatever the caller resolved from the old
 * offset — its target lane, its drop guide — is stale. Skipping it is the same
 * preview/commit divergence `updateMovePreview` exists to prevent.
 *
 * There is deliberately NO sub-stepping here (contrast the canvas loop, and see
 * AUTOSCROLL_MAX_STEP_PX). Sub-steps exist for `laneTargetForMove`'s hysteresis,
 * which only adopts a lane the pointer has been INSIDE, so a wide frame can step
 * clean over one. A drop resolver has no hysteresis — it reads whichever lane is
 * under the pointer at the current offset — so its answer depends only on where
 * a frame ENDS, never on the path taken to get there. Sampling it more often
 * would be per-frame work that cannot change the outcome.
 *
 * Zero cost until it is aimed into an edge zone, and nothing survives `stop`.
 */
export function createLaneAutoScroll(
  tl: TimelineController,
  onStep: () => void,
): LaneAutoScroller {
  /** rAF handle; 0 when the loop is not running. */
  let raf = 0;
  /** Previous tick's timestamp; -1 means "first tick, just start the clock". */
  let prev = -1;
  /** The scroll position carried as a float across ticks — see nextLaneScroll. */
  let pos = 0;
  let aimY: number | null = null;

  /** The velocity this aim asks for, or 0 when there is nothing to do: not
   *  aimed, not in an edge zone, no overflow to scroll, or already pinned
   *  against the end it is pulling towards. */
  const wanted = (): number => {
    if (aimY === null) return 0;
    const v = laneAutoScrollVelocity(aimY, tl.view.height);
    if (v === 0) return 0;
    const max = maxLaneScroll(tl.project(), tl.view.height);
    if (max <= 0) return 0;
    return v < 0 ? (laneScroll() > 0 ? v : 0) : laneScroll() < max ? v : 0;
  };

  const stop = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const tick = (now: number): void => {
    raf = 0;
    const v = wanted();
    // Left the zone, or ran out of scroll: let the loop die rather than respin.
    // A later `aim` re-arms it if the pointer asks again.
    if (v === 0) return;

    let moved = false;
    if (prev < 0) {
      prev = now;
    } else {
      const from = pos;
      const to = nextLaneScroll(
        from,
        v,
        (now - prev) / 1000,
        maxLaneScroll(tl.project(), tl.view.height),
      );
      prev = now;
      if (to !== from) {
        pos = to;
        moved = true;
      }
    }

    // Re-armed BEFORE the callback, not after. `onStep` re-resolves the drop
    // target, and that calls back into `aim`; an `aim` that found the handle
    // clear would arm a SECOND loop, whose handle the line below would then
    // overwrite — two ticks a frame, and one rAF nothing could ever cancel.
    // Armed first, `aim` sees a loop already running and does nothing, while a
    // `stop()` from inside the callback still wins.
    raf = requestAnimationFrame(tick);
    if (moved) {
      tl.scrollLanesTo(pos);
      onStep();
    }
  };

  return {
    aim(y: number | null): void {
      aimY = y;
      if (wanted() === 0) {
        stop();
        return;
      }
      if (raf !== 0) return;
      // Seeded from the STORED offset, which is pixel-snapped; the float is
      // carried from here on so the slow end of the ramp is not rounded away.
      pos = laneScroll();
      prev = -1;
      raf = requestAnimationFrame(tick);
    },
    stop,
  };
}

type Hit =
  | { type: "marker"; marker: Marker }
  | { type: "ruler" }
  | { type: "kf"; clip: Clip; track: Track; t: number }
  | { type: "clip"; clip: Clip; track: Track; edge: "in" | "out" | null }
  | { type: "lane"; track: Track }
  | { type: "empty" };

type Mode =
  | { name: "idle" }
  /** `startT` is the playhead as it was on pointerdown, so a cancelled scrub
   *  puts it back. */
  | { name: "scrub"; startT: number }
  | {
      name: "maybe-move";
      clip: Clip;
      track: Track;
      grabOffset: number;
      startX: number;
      startY: number;
    }
  | {
      name: "move";
      clip: Clip;
      track: Track;
      grabOffset: number;
      candidates: number[];
      /** sticky lane target, retained across moves for hysteresis */
      toTrackId: string;
    }
  | { name: "trim"; clip: Clip; edge: "in" | "out"; candidates: number[] }
  /** `startT` is the marker's own time at pointerdown — NOT a whole-project
   *  snapshot; see the commit path for why that distinction is the fix for a
   *  marker drag swallowing unrelated edits into its undo entry. `t` is where
   *  the drag has moved it to, which is a PREVIEW and not project state: it is
   *  mirrored into the drag override and reaches the project once, on release. */
  | { name: "marker-move"; markerId: string; startT: number; t: number };

export function attachInteractions(tl: TimelineController): () => void {
  const canvas = tl.canvas;
  let mode: Mode = { name: "idle" };
  /** The pointer the gesture captured, kept so an end that is NOT a pointerup
   *  (Escape) can still release it. */
  let capturedPointerId: number | null = null;

  const hitTest = (x: number, y: number): Hit => {
    const project = tl.project();
    if (y < RULER_H) {
      // markers first: a point within ±MARKER_HIT_PX of a marker stem wins
      const markers = project.timeline.markers;
      if (markers) {
        let best: Marker | null = null;
        let bestDx = MARKER_HIT_PX;
        for (const m of markers) {
          const dx = Math.abs(tl.xOf(m.t) - x);
          if (dx <= bestDx) {
            bestDx = dx;
            best = m;
          }
        }
        if (best) return { type: "marker", marker: best };
      }
      return { type: "ruler" };
    }
    for (const lane of laneLayout(project)) {
      // Half-open, [lane.y, lane.y + lane.h), because that is exactly the band
      // `fillRect(0, lane.y, width, lane.h)` paints: the row AT lane.y + lane.h
      // is the first row of the gap below, drawn in the app background. An
      // inclusive end claimed it for the lane, so one pixel row of every gap
      // opened that lane's context menu while looking like empty space — and at
      // the scroll where a lane's bottom lands exactly on RULER_H it claimed
      // y === RULER_H too, a lane draw() had already skipped as having no
      // visible row at all. The ruler owns y < RULER_H (above), lanes own
      // whatever they paint, and nothing owns the gaps.
      if (y < lane.y || y >= lane.y + lane.h) continue;
      for (const clip of lane.track.clips) {
        const cx = tl.xOf(clip.timelineStart);
        const cw = clipDuration(clip) * tl.view.pxPerSec;
        if (x < cx - 2 || x > cx + cw + 2) continue;
        // keyframe diamonds live on the clip's bottom strip; a point inside the
        // strip within ±4px of a diamond wins over the clip/edge hit.
        if (clip.keyframes) {
          const clipTop = lane.y + 2;
          const clipBot = clipTop + (lane.h - 4);
          if (y >= clipBot - KF_STRIP_H && y <= clipBot) {
            const times = clipDiamondTimes(clip);
            if (times && times.length > 0) {
              let bestT: number | null = null;
              let bestDx = 4;
              for (const tt of times) {
                const dx = Math.abs(tl.xOf(tt) - x);
                if (dx <= bestDx) {
                  bestDx = dx;
                  bestT = tt;
                }
              }
              if (bestT !== null) return { type: "kf", clip, track: lane.track, t: bestT };
            }
          }
        }
        let edge: "in" | "out" | null = null;
        if (cw > EDGE_ZONE_PX * 3) {
          if (x - cx <= EDGE_ZONE_PX) edge = "in";
          else if (cx + cw - x <= EDGE_ZONE_PX) edge = "out";
        }
        return { type: "clip", clip, track: lane.track, edge };
      }
      return { type: "lane", track: lane.track };
    }
    return { type: "empty" };
  };

  const localPos = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /* ---------------- lane auto-scroll: the loop ---------------- */

  /** Where the pointer was on the last pointermove, canvas-local, plus the Alt
   *  state that goes with it. The auto-scroll tick replays the move preview from
   *  these because scrolling slides the lanes under a STATIONARY pointer: the
   *  lane under the cursor changes with no pointer event to announce it. */
  let lastX = 0;
  let lastY = 0;
  let lastAlt = false;

  /** rAF handle of the auto-scroll loop; 0 when it is not running.
   *
   *  The loop is armed only from the `move` branch of pointermove, and only
   *  while the pointer is in an edge zone with somewhere to scroll. It is torn
   *  down by `endGesture` — which is the single exit shared by pointerup,
   *  Escape and pointercancel — and by the detach disposer, so it cannot outlive
   *  the gesture that started it by any path. Outside a move gesture nothing
   *  here runs at all. */
  let autoRaf = 0;
  /** Timestamp of the previous tick; -1 means "first tick, just start the
   *  clock", which keeps the elapsed-time step honest without reading a second
   *  clock at arm time. */
  let autoPrev = -1;
  /** The scroll position carried as a float across ticks — see nextLaneScroll. */
  let autoPos = 0;

  const stopAutoScroll = (): void => {
    if (autoRaf === 0) return;
    cancelAnimationFrame(autoRaf);
    autoRaf = 0;
  };

  /** The velocity the current pointer position asks for, or 0 when there is
   *  nothing to do: no overflow at all (1–3 lanes, `maxLaneScroll` 0 — the drag
   *  then behaves exactly as it did before this existed), or already pinned
   *  against the end the pointer is pulling towards. */
  const wantedVelocity = (): number => {
    // Zone test first, and it is pure arithmetic: this runs on every pointermove
    // of every move gesture, and the answer is "not in a zone" almost always, so
    // the common case must not walk the tracks (maxLaneScroll does).
    const v = laneAutoScrollVelocity(lastY, tl.view.height);
    if (v === 0) return 0;
    const max = maxLaneScroll(tl.project(), tl.view.height);
    if (max <= 0) return 0;
    return v < 0 ? (laneScroll() > 0 ? v : 0) : laneScroll() < max ? v : 0;
  };

  const autoTick = (now: number): void => {
    autoRaf = 0;
    // A cancel both clears `mode` and cancels the pending handle, but a tick that
    // is already in flight must be inert on its own merits too.
    if (mode.name !== "move") return;
    const m = mode;
    const v = wantedVelocity();
    // Left the zone, or ran out of scroll: stop rather than respin. A later
    // pointermove re-arms if the pointer asks for it again.
    if (v === 0) return;

    if (autoPrev < 0) {
      autoPrev = now;
    } else {
      const from = autoPos;
      const to = nextLaneScroll(
        from,
        v,
        (now - autoPrev) / 1000,
        maxLaneScroll(tl.project(), tl.view.height),
      );
      autoPrev = now;
      if (to !== from) {
        autoPos = to;
        // Walk to the new offset in sub-steps, sampling the lane target at each:
        // the target only switches once the pointer is inside a lane's
        // hysteresis core, and one frame at full speed can be wider than the
        // narrowest core. See AUTOSCROLL_MAX_STEP_PX.
        const steps = autoScrollSubStepCount(to - from);
        for (let i = 1; i <= steps; i++) {
          tl.scrollLanesTo(from + ((to - from) * i) / steps);
          m.toTrackId = laneTargetForMove(
            lastY,
            laneLayout(tl.project()),
            m.track.kind,
            m.toTrackId,
            m.track.id,
          );
        }
        // The lanes moved under the pointer, so the ghost is stale: re-resolve it
        // against the geometry that is now on screen. Skipping this is exactly
        // the ghost/commit divergence the move preview was fixed for.
        updateMovePreview();
      }
    }
    autoRaf = requestAnimationFrame(autoTick);
  };

  /** Arm or disarm the loop for wherever the pointer is now. */
  const syncAutoScroll = (): void => {
    if (wantedVelocity() === 0) {
      stopAutoScroll();
      return;
    }
    if (autoRaf !== 0) return;
    autoPos = laneScroll();
    autoPrev = -1;
    autoRaf = requestAnimationFrame(autoTick);
  };

  /**
   * Recompute the move ghost from the last pointer position.
   *
   * Driven by pointermove and by every auto-scroll step, so the two can never
   * disagree about where the clip is going: both read the lane geometry from
   * `laneLayout` (offset already folded in) and both run the real `moveClip`
   * through `resolveMoveStart`, which is what keeps the ghost and the commit on
   * the same answer.
   */
  const updateMovePreview = (): void => {
    if (mode.name !== "move") return;
    const m = mode;
    const raw = Math.max(0, tl.tOf(lastX) - m.grabOffset);
    const snap = snapMove(
      raw,
      clipDuration(m.clip),
      m.candidates,
      tl.view.pxPerSec,
      tl.snapEnabled() && !lastAlt,
    );
    // Hysteresis: the lane target only switches once the pointer travels
    // meaningfully into a neighboring same-kind lane, so a clip dragged near a
    // boundary does not flip-flop between lanes.
    const toTrackId = laneTargetForMove(
      lastY,
      laneLayout(tl.project()),
      m.track.kind,
      m.toTrackId,
      m.track.id,
    );
    m.toTrackId = toTrackId;
    // run the real (relocating) move against the current project and read the
    // landing position back — preview always matches what commit will do, the
    // same discipline as the trim path below
    const want = Math.max(0, snap.t);
    const start = resolveMoveStart(tl.project(), m.clip.id, want, toTrackId);
    // The snap guide is only honest when the snap actually survived placement.
    // If the clip was relocated to a feasible gap, the line would point at a
    // candidate edge the clip is not touching.
    const guide = Math.abs(start - want) < POS_EPS ? snap.guide : null;
    tl.setDrag({ kind: "move", clipId: m.clip.id, start, toTrackId }, guide);
  };

  /* ---------------- pointer handlers ---------------- */

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    capturedPointerId = e.pointerId;
    const { x, y } = localPos(e);
    const hit = hitTest(x, y);

    if (hit.type === "marker") {
      tl.seek(hit.marker.t);
      mode = {
        name: "marker-move",
        markerId: hit.marker.id,
        startT: hit.marker.t,
        t: hit.marker.t,
      };
    } else if (hit.type === "kf") {
      // diamond: select the clip and seek to it; no drag.
      tl.select(hit.clip.id);
      tl.seek(Math.max(0, hit.t));
      mode = { name: "idle" };
    } else if (hit.type === "clip") {
      tl.select(hit.clip.id);
      if (hit.edge) {
        mode = {
          name: "trim",
          clip: hit.clip,
          edge: hit.edge,
          candidates: collectCandidates(tl.project(), hit.clip.id, tl.playhead(), hit.clip),
        };
      } else {
        mode = {
          name: "maybe-move",
          clip: hit.clip,
          track: hit.track,
          grabOffset: tl.tOf(x) - hit.clip.timelineStart,
          startX: x,
          startY: y,
        };
      }
    } else {
      if (hit.type !== "ruler") tl.select(null);
      // playhead read BEFORE the seek below: that is the value a cancel restores
      mode = { name: "scrub", startT: tl.playhead() };
      tl.seek(Math.max(0, tl.tOf(x)));
    }
    tl.requestRender();
  };

  const onPointerMove = (e: PointerEvent): void => {
    const { x, y } = localPos(e);
    lastX = x;
    lastY = y;
    lastAlt = e.altKey;

    if (mode.name === "idle") {
      const hit = hitTest(x, y);
      // Same idempotent-write rule as the play button: the value is identical
      // across almost every pointermove, so only touch the CSSOM on a change.
      const cursor =
        hit.type === "marker"
          ? "ew-resize"
          : hit.type === "kf"
            ? "pointer"
            : hit.type === "clip"
              ? hit.edge
                ? "ew-resize"
                : "grab"
              : "default";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
      return;
    }

    if (mode.name === "scrub") {
      tl.seek(Math.max(0, tl.tOf(x)));
      return;
    }

    if (mode.name === "marker-move") {
      // A PREVIEW, exactly like move and trim: the position goes into the drag
      // override and render.ts draws the marker from it. The project is not
      // touched until pointer-up, so a commit landing mid-drag cannot snapshot
      // a position the marker was only passing through — and the drag no longer
      // marks the project dirty on every pointermove either.
      const t = Math.max(0, tl.tOf(x));
      mode.t = t;
      tl.setDrag({ kind: "marker", markerId: mode.markerId, t }, null);
      tl.seek(t);
      return;
    }

    if (mode.name === "maybe-move") {
      if (Math.abs(x - mode.startX) + Math.abs(y - mode.startY) < 4) return;
      mode = {
        name: "move",
        clip: mode.clip,
        track: mode.track,
        grabOffset: mode.grabOffset,
        candidates: collectCandidates(tl.project(), mode.clip.id, tl.playhead(), mode.clip),
        toTrackId: mode.track.id,
      };
      canvas.style.cursor = "grabbing";
    }

    if (mode.name === "move") {
      updateMovePreview();
      // Entering an edge zone starts the scroll loop; leaving it — or moving
      // back off the edge — stops it. This is the only place it is armed.
      syncAutoScroll();
      return;
    }

    if (mode.name === "trim") {
      const raw = tl.tOf(x);
      const snap = snapTime(raw, mode.candidates, tl.view.pxPerSec, tl.snapEnabled() && !e.altKey);
      // run the real (clamping) trim against the current project, then read
      // back the resulting edge — preview always matches what commit will do
      const preview = trimClip(
        tl.project(),
        mode.clip.id,
        mode.edge === "in" ? "in" : "out",
        snap.t,
      );
      const result = findClip(preview, mode.clip.id)?.clip ?? mode.clip;
      const edgeT = mode.edge === "in" ? result.timelineStart : clipEnd(result);
      tl.setDrag(
        mode.edge === "in"
          ? { kind: "trimIn", clipId: mode.clip.id, t: edgeT }
          : { kind: "trimOut", clipId: mode.clip.id, t: edgeT },
        snap.guide,
      );
    }
  };

  /** The marker's time right now, or null if it is no longer in the project
   *  (deleted mid-gesture — see the commit path). */
  const markerTimeNow = (markerId: string): number | null => {
    const m = tl.project().timeline.markers?.find((x) => x.id === markerId);
    return m ? m.t : null;
  };

  /** Drop every transient bit of gesture state and let the pointer go. Shared by
   *  the commit path and the cancel path so neither can forget half of it. */
  const endGesture = (): void => {
    // First, and unconditionally: an auto-scroll loop that outlives its gesture
    // would keep scrolling a timeline nobody is dragging on, and would keep a
    // rAF alive against the project forever. Every exit — pointerup, Escape,
    // pointercancel — comes through here.
    stopAutoScroll();
    mode = { name: "idle" };
    canvas.style.cursor = "default";
    tl.setDrag(null, null);
    if (capturedPointerId !== null) {
      if (canvas.hasPointerCapture(capturedPointerId)) {
        canvas.releasePointerCapture(capturedPointerId);
      }
      capturedPointerId = null;
    }
  };

  /**
   * Abandon the gesture instead of committing it.
   *
   * Escape means cancel everywhere else in the app — the media-bin drag
   * (editor.ts) and the canvas overlay's crop gesture both revert — and
   * `pointercancel` is the same thing with no key involved: the browser or the
   * OS taking the pointer away mid-drag. It used to be wired straight to the
   * commit path, so an interrupted move landed the clip.
   *
   * NO gesture needs a project rollback any more, marker drags included: all
   * three write nothing but a drag override, and `endGesture` drops that. The
   * marker drag used to roll back through the history-free `replace()`, which
   * worked but only because it was undoing its own live writes; not making them
   * is strictly better, and it removes the one path on which a cancel had to
   * reason about a commit that had landed underneath it.
   *
   * What IS restored is the playhead. Both the scrub and the marker drag drive
   * it (a marker drag seeks as it goes, so you can see the frame you are
   * marking), and it is not project state, so nothing else puts it back.
   *
   * Selection is deliberately not restored. It is not project state, nothing in
   * the app makes it undoable, and the click that changed it is not the part
   * being cancelled.
   */
  const cancelGesture = (): void => {
    if (mode.name === "marker-move" || mode.name === "scrub") {
      tl.seek(mode.startT);
    }
    endGesture();
  };

  const onPointerUp = (): void => {
    const drag = tl.drag;

    if (mode.name === "marker-move") {
      // ONE history entry for the marker move, and ONLY for the marker move —
      // the whole drag reaches the project right here, in a single ordinary
      // commit, so it is bounded the same way a move or a trim is.
      //
      // Two earlier shapes were wrong for the same underlying reason. A `before`
      // snapshot taken on pointerdown swallowed any commit that landed during
      // the drag into this undo step. Reconstructing the entry from the current
      // project fixed that, but the drag was still live-writing the project, so
      // the FOREIGN commit's own snapshot captured the marker mid-flight and
      // undoing it stranded the marker somewhere the user never dropped it. With
      // the position held in the drag override there is nothing mid-flight to
      // capture, and both edits stay individually undoable.
      const { markerId, t } = mode;
      const now = markerTimeNow(markerId);
      // Gone (deleted mid-drag), or already exactly there: nothing to record.
      // Compared against the marker's CURRENT time rather than `startT` because
      // that is precisely the question "would this commit change anything" —
      // `moveMarkerTo` always returns a fresh project, so an unguarded call
      // would push a history entry for a marker that never moved.
      if (now !== null && Math.abs(t - now) > POS_EPS) {
        tl.commit((p: ProjectFile) => moveMarkerTo(p, markerId, t));
      }
    } else if (mode.name === "move" && drag?.kind === "move") {
      const { clipId, start, toTrackId } = drag;
      tl.commit((p: ProjectFile) => {
        // `start` is already the position moveClip resolves to (the drag ran the
        // real mutator every frame), so a clip that ends the gesture on the same
        // lane at the same time genuinely changes nothing — and moveClip always
        // returns a fresh reference, which would otherwise push an undo entry
        // for it. Returning `p` is the session's own "no change" signal, so no
        // history entry and no dirty flag. This suppresses nothing real: any
        // actual movement fails the comparison.
        const cur = findClip(p, clipId);
        const settled =
          cur !== undefined &&
          cur.track.id === toTrackId &&
          Math.abs(cur.clip.timelineStart - start) < POS_EPS;
        if (settled) return p;
        return moveClip(p, clipId, start, toTrackId);
      });
    } else if (mode.name === "trim" && (drag?.kind === "trimIn" || drag?.kind === "trimOut")) {
      tl.commit((p: ProjectFile) =>
        trimClip(p, drag.clipId, drag.kind === "trimIn" ? "in" : "out", drag.t),
      );
    }

    endGesture();
  };

  /** Escape while a gesture is in flight cancels it. Capture phase on window, so
   *  it wins over every other Escape handler in the app (theater, dialogs) for
   *  as long as the timeline owns the pointer — and costs one string compare per
   *  keystroke when it does not. */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || mode.name === "idle") return;
    e.preventDefault();
    e.stopPropagation();
    cancelGesture();
  };

  /* ---------------- context menu ---------------- */

  const onContextMenu = (e: MouseEvent): void => {
    const { x, y } = localPos(e as unknown as PointerEvent);
    const hit = hitTest(x, y);
    if (hit.type === "marker") {
      e.preventDefault();
      const id = hit.marker.id;
      showMenu(e.clientX, e.clientY, [
        { label: "Delete marker", danger: true, onSelect: () => tl.commit((p) => removeMarker(p, id)) },
      ]);
    } else if (hit.type === "clip" || hit.type === "kf") {
      e.preventDefault();
      tl.select(hit.clip.id);
      tl.clipMenu(hit.clip, e.clientX, e.clientY);
    } else if (hit.type === "lane") {
      e.preventDefault();
      // Empty lane: drop the selection first, the same way a LEFT click on the
      // same pixel does. Right-click was the one way to open a menu over the
      // timeline while a clip elsewhere stayed selected and outlined, and a menu
      // whose items are scoped to the lane under the cursor sitting over a
      // highlight somewhere else is an invitation to read one as the other.
      // Selecting before showing the menu is also what the clip branch above
      // does, so whatever a lane item comes to read, it reads the truth.
      tl.select(null);
      tl.laneMenu(hit.track, e.clientX, e.clientY);
    }
    // ruler / empty: no menu is opened, so there is nothing to disambiguate and
    // the selection is left alone. The ruler deliberately keeps it on left click
    // too — scrubbing is not a deselect gesture.
  };

  /* ---------------- wheel: zoom / pan ---------------- */

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x } = localPos(e as unknown as PointerEvent);
    if (e.ctrlKey) {
      const factor = Math.pow(1.0015, -e.deltaY);
      tl.zoomAt(x, factor);
    } else {
      const px = e.shiftKey ? e.deltaY * 3 : e.deltaY;
      tl.panBy(px);
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", cancelGesture);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown, true);

  return () => {
    // Detaching mid-drag (project closed, editor unmounted) is another way a
    // gesture can end without a pointerup.
    stopAutoScroll();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", cancelGesture);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
