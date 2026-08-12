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
  /** The marker's own time at pointerdown — NOT a whole-project snapshot; see
   *  the commit and cancel paths for why that distinction is the fix for a
   *  marker drag swallowing unrelated edits into its undo entry. */
  | { name: "marker-move"; markerId: string; startT: number };

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
      if (y < lane.y || y > lane.y + lane.h) continue;
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
      mode = { name: "marker-move", markerId: hit.marker.id, startT: hit.marker.t };
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
      const id = mode.markerId;
      const t = Math.max(0, tl.tOf(x));
      tl.liveReplace((p) => moveMarkerTo(p, id, t));
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
   *  (deleted mid-gesture — see the commit and cancel paths). */
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
   * Move and trim need no rollback: they only ever wrote a drag override, and
   * the project is untouched until pointerup. The marker drag DID write to the
   * project, through the history-free `replace()`, so it is rolled back the same
   * way — the marker goes back to `startT`, again history-free, so history comes
   * out exactly as it was before pointerdown rather than gaining an entry for a
   * gesture the user cancelled.
   *
   * The revert is scoped to the MARKER, not to a whole-project snapshot: a
   * commit that landed mid-drag is not part of this gesture and must keep both
   * its effect and its own undo entry (same reasoning as the commit path).
   *
   * Selection is deliberately not restored. It is not project state, nothing in
   * the app makes it undoable, and the click that changed it is not the part
   * being cancelled.
   */
  const cancelGesture = (): void => {
    if (mode.name === "marker-move") {
      const { markerId, startT } = mode;
      const now = markerTimeNow(markerId);
      if (now !== null && Math.abs(now - startT) > POS_EPS) {
        tl.liveReplace((p) => moveMarkerTo(p, markerId, startT));
        tl.seek(startT);
      }
    } else if (mode.name === "scrub") {
      tl.seek(mode.startT);
    }
    endGesture();
  };

  const onPointerUp = (): void => {
    const drag = tl.drag;

    if (mode.name === "marker-move") {
      // ONE history entry for the marker move, and ONLY for the marker move.
      // `before` used to be a snapshot taken on pointerdown, so any commit that
      // landed during the drag — Delete, a shortcut, a context-menu action — was
      // swallowed into the same undo step: one Ctrl+Z reverted both edits, the
      // next Ctrl+Z was a visible no-op, and redo needed two presses.
      //
      // The entry is reconstructed from the CURRENT project instead: everything
      // exactly as it stands now, with just this marker put back where the drag
      // started. That is the state undo should land on, so the intervening
      // commit keeps its own entry underneath and both edits stay individually
      // undoable.
      const { markerId, startT } = mode;
      const now = markerTimeNow(markerId);
      // Gone, or never actually moved: there is nothing to record.
      if (now !== null && Math.abs(now - startT) > POS_EPS) {
        tl.commitFrom(moveMarkerTo(tl.project(), markerId, startT));
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
      tl.laneMenu(hit.track, e.clientX, e.clientY);
    }
    // ruler / empty: leave the global suppression to swallow the default
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
