// Pointer interactions: select, move, trim, scrub, zoom, pan. Drags are
// transient (rendered as overrides); the project mutates once on pointer-up.

import { moveClip, trimClip, findClip } from "../../core/project";
import { clipDuration, clipEnd } from "../../core/time";
import type { Clip, ProjectFile, Track } from "../../core/types";
import { EDGE_ZONE_PX, RULER_H, laneLayout } from "./render";
import { collectCandidates, snapMove, snapTime } from "./snap";
import type { TimelineController } from "./timeline";

export type DragState =
  | { kind: "move"; clipId: string; start: number; toTrackId: string }
  | { kind: "trimIn"; clipId: string; t: number }
  | { kind: "trimOut"; clipId: string; t: number }
  | null;

type Hit =
  | { type: "ruler" }
  | { type: "clip"; clip: Clip; track: Track; edge: "in" | "out" | null }
  | { type: "lane"; track: Track }
  | { type: "empty" };

type Mode =
  | { name: "idle" }
  | { name: "scrub" }
  | {
      name: "maybe-move";
      clip: Clip;
      track: Track;
      grabOffset: number;
      startX: number;
      startY: number;
    }
  | { name: "move"; clip: Clip; track: Track; grabOffset: number; candidates: number[] }
  | { name: "trim"; clip: Clip; edge: "in" | "out"; candidates: number[] };

export function attachInteractions(tl: TimelineController): () => void {
  const canvas = tl.canvas;
  let mode: Mode = { name: "idle" };

  const hitTest = (x: number, y: number): Hit => {
    if (y < RULER_H) return { type: "ruler" };
    const project = tl.project();
    const t = tl.tOf(x);
    for (const lane of laneLayout(project)) {
      if (y < lane.y || y > lane.y + lane.h) continue;
      for (const clip of lane.track.clips) {
        const cx = tl.xOf(clip.timelineStart);
        const cw = clipDuration(clip) * tl.view.pxPerSec;
        if (x < cx - 2 || x > cx + cw + 2) continue;
        let edge: "in" | "out" | null = null;
        if (cw > EDGE_ZONE_PX * 3) {
          if (x - cx <= EDGE_ZONE_PX) edge = "in";
          else if (cx + cw - x <= EDGE_ZONE_PX) edge = "out";
        }
        return { type: "clip", clip, track: lane.track, edge };
      }
      return { type: "lane", track: lane.track };
    }
    void t;
    return { type: "empty" };
  };

  const laneAt = (y: number): Track | null => {
    for (const lane of laneLayout(tl.project())) {
      if (y >= lane.y && y <= lane.y + lane.h) return lane.track;
    }
    return null;
  };

  const localPos = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /* ---------------- pointer handlers ---------------- */

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = localPos(e);
    const hit = hitTest(x, y);

    if (hit.type === "clip") {
      tl.select(hit.clip.id);
      if (hit.edge) {
        mode = {
          name: "trim",
          clip: hit.clip,
          edge: hit.edge,
          candidates: collectCandidates(tl.project(), hit.clip.id, tl.playhead()),
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
      mode = { name: "scrub" };
      tl.seek(Math.max(0, tl.tOf(x)));
    }
    tl.requestRender();
  };

  const onPointerMove = (e: PointerEvent): void => {
    const { x, y } = localPos(e);

    if (mode.name === "idle") {
      const hit = hitTest(x, y);
      canvas.style.cursor =
        hit.type === "clip" ? (hit.edge ? "ew-resize" : "grab") : "default";
      return;
    }

    if (mode.name === "scrub") {
      tl.seek(Math.max(0, tl.tOf(x)));
      return;
    }

    if (mode.name === "maybe-move") {
      if (Math.abs(x - mode.startX) + Math.abs(y - mode.startY) < 4) return;
      mode = {
        name: "move",
        clip: mode.clip,
        track: mode.track,
        grabOffset: mode.grabOffset,
        candidates: collectCandidates(tl.project(), mode.clip.id, tl.playhead()),
      };
      canvas.style.cursor = "grabbing";
    }

    if (mode.name === "move") {
      const raw = Math.max(0, tl.tOf(x) - mode.grabOffset);
      const snap = snapMove(
        raw,
        clipDuration(mode.clip),
        mode.candidates,
        tl.view.pxPerSec,
        tl.snapEnabled() && !e.altKey,
      );
      const targetLane = laneAt(y);
      const toTrackId =
        targetLane && targetLane.kind === mode.track.kind ? targetLane.id : mode.track.id;
      tl.setDrag(
        { kind: "move", clipId: mode.clip.id, start: Math.max(0, snap.t), toTrackId },
        snap.guide,
      );
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

  const onPointerUp = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const drag = tl.drag;

    if (mode.name === "move" && drag?.kind === "move") {
      tl.commit((p: ProjectFile) => moveClip(p, drag.clipId, drag.start, drag.toTrackId));
    } else if (mode.name === "trim" && (drag?.kind === "trimIn" || drag?.kind === "trimOut")) {
      tl.commit((p: ProjectFile) =>
        trimClip(p, drag.clipId, drag.kind === "trimIn" ? "in" : "out", drag.t),
      );
    }

    mode = { name: "idle" };
    canvas.style.cursor = "default";
    tl.setDrag(null, null);
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
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
  };
}
