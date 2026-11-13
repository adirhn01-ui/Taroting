// The editor's scrub copy, pure half: which media could ever be heavy (a
// free bit-rate test on the MediaRef, before any file is read), and what each
// layer shows under the playhead (its clip, the file the editor actually
// plays, and the source time the scheduler seeks that file to).
//
// Nothing here touches an element, a timer or the backend.

import { HEAVY_BITS_PER_S } from "../../core/heavy-clip";
import { sourceTime } from "../../core/time";
import type { Clip, MediaRef, ProjectFile, Rational } from "../../core/types";
import type { DamageState, MediaState } from "../media/media";
import type { VisibleClip } from "../playback/scheduler";

/** A paused playhead resting this long on a heavy clip asks for its copy (ms).
 *  The viewer's value; tuned by feel. */
export const DWELL_MS = 1000;
/** A held pointer that has not moved the playhead by more than
 *  `restTolerance` for this long counts as resting (smaller moves do not count):
 *  each copy waits for its real element to show the exact frame, then hides
 *  (ms). */
export const REST_MS = 150;
/** A seek of a copy that has not landed after this long is a decode stall:
 *  the copy is given up for the file (ms). */
export const COPY_STALL_MS = 3000;
/** After a release, a copy hides at the latest this long later, whatever its
 *  real element is doing (ms). */
export const CATCHUP_MAX_MS = 4000;
/** This long after the last copy hid with no new press, every copy lets go of
 *  its file (ms). */
export const IDLE_RELEASE_MS = 30000;
/** A copy seek to within this of where it already is is not made (seconds). */
export const SAME_POSITION_S = 0.01;

/** How far (seconds of timeline) the playhead must move from where the rest
 *  wait was last started before a held pointer starts it again: one frame of
 *  the project's timebase, never less than SAME_POSITION_S. The ruler seeks
 *  to unsnapped times, so a hand held still trembles across a few sub-frame
 *  times that all show the same picture. */
export function restTolerance(fps: Rational | undefined): number {
  const frame = fps !== undefined && fps.num > 0 && fps.den > 0 ? fps.den / fps.num : 0;
  return Number.isFinite(frame) && frame > SAME_POSITION_S ? frame : SAME_POSITION_S;
}

/** Could this media be a heavy video? A video file (not generated) whose
 *  overall bit rate reaches the shared threshold; `force` (DEV seam only)
 *  skips the bit-rate test, never the kind. Light files are never read. */
export function isCandidate(m: MediaRef, force: boolean): boolean {
  if (m.kind !== "video" || m.generator !== undefined) return false;
  if (!Number.isFinite(m.duration) || !(m.duration > 0)) return false;
  if (force) return true;
  if (!Number.isFinite(m.size) || !(m.size > 0)) return false;
  return (m.size * 8) / m.duration >= HEAVY_BITS_PER_S;
}

/** What one layer shows under the playhead, when its copy may be used. */
export interface LayerTarget {
  /** The layer index: 0 is the topmost video track (the stage's order). */
  layer: number;
  clip: Clip;
  media: MediaRef;
  /** The file the editor actually plays (`status.sourcePath`). */
  file: string;
  /** The url the layer's real element was given for it (`status.url`). */
  url: string;
  /** The source time the scheduler seeks that file to at `t`. */
  srcT: number;
}

/**
 * Per layer index (one entry per video track, topmost first), the target
 * whose copy may stand in for the real element at timeline time `t`, or null.
 * A layer qualifies only when its visible clip is a candidate video that is
 * ready to play and not inside an unrecovered repair.
 */
export function layerTargets(
  project: ProjectFile,
  statuses: Readonly<Record<string, MediaState>>,
  damage: Readonly<Record<string, DamageState>>,
  visible: readonly VisibleClip[],
  t: number,
  force: boolean | ((m: MediaRef) => boolean),
): (LayerTarget | null)[] {
  const tracks = project.timeline.tracks.filter((tr) => tr.kind === "video");
  const out: (LayerTarget | null)[] = tracks.map(() => null);
  for (const v of visible) {
    const layer = tracks.findIndex((tr) => tr === v.track || tr.id === v.track.id);
    if (layer < 0) continue;
    const m = v.media;
    if (!isCandidate(m, typeof force === "function" ? force(m) : force)) continue;
    const s = statuses[m.id];
    if (s === undefined || s.state !== "ready") continue;
    const d = damage[m.id];
    if (d !== undefined && d.phase !== "recovered") continue;
    out[layer] = {
      layer,
      clip: v.clip,
      media: m,
      file: s.sourcePath,
      url: s.url,
      srcT: sourceTime(v.clip, t - v.clip.timelineStart),
    };
  }
  return out;
}

/** Every file the project's ready media are played from. */
export function liveFiles(project: ProjectFile, statuses: Readonly<Record<string, MediaState>>): Set<string> {
  const out = new Set<string>();
  for (const m of project.media) {
    const s = statuses[m.id];
    if (s !== undefined && s.state === "ready") out.add(s.sourcePath);
  }
  return out;
}
