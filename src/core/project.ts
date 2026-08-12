// Pure project mutations. Every function returns a NEW ProjectFile with
// structural sharing — callers never mutate state in place.
//
// Invariants (verified by checkInvariants + fuzz tests):
//  - >=1 video track; video tracks form a contiguous prefix; tracks[0] is video
//    (array order = z-order, tracks[0] topmost)
//  - per track: clips sorted by timelineStart, non-overlapping
//  - 0 <= srcIn < srcOut <= media.duration (still images excepted)
//  - every clip.mediaId resolves; speed within [MIN_SPEED, MAX_SPEED]
//  - markers sorted ascending; keyframe arrays strictly ascending, x/y paired
//  - timeline width/height even integers in [16, 8192]

import type {
  AnimProp,
  Clip,
  ClipAudio,
  ClipCrop,
  ClipKeyframes,
  ClipTransform,
  Generator,
  Keyframe,
  Marker,
  MediaInfo,
  MediaRef,
  ProjectFile,
  Rational,
  Track,
} from "./types";
import { DEFAULT_EXPORT_PRESET } from "./types";
import { EPS_KF, removeKfNear, upsertKf } from "./anim";
import { clipDuration, clipEnd } from "./time";

export const MIN_CANVAS = 16;
export const MAX_CANVAS = 8192;

export const MIN_CLIP_DUR = 1 / 120; // one frame at 120fps — hard floor
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const IMAGE_DEFAULT_DUR = 5;
const EPS = 1e-6;

// Transform scale clamp — mirrors the inspector slider bounds and canvas-math's
// SCALE_MIN/SCALE_MAX (kept as local literals so core has no preview-layer dep).
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

export const uid = (): string => crypto.randomUUID();

export const defaultAudio = (): ClipAudio => ({
  volume: 1,
  muted: false,
  fadeInSec: 0,
  fadeOutSec: 0,
  gainOffsetDb: 0,
  detached: false,
});

export const defaultTransform = (): ClipTransform => ({
  rotate: 0,
  flipH: false,
  flipV: false,
  scale: 1,
  x: 0,
  y: 0,
  opacity: 1,
});

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export function createProject(name: string): ProjectFile {
  const now = new Date().toISOString();
  return {
    schema: 1,
    app: "taroting",
    id: uid(),
    name,
    createdAt: now,
    modifiedAt: now,
    media: [],
    timeline: {
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      tracks: [{ id: uid(), kind: "video", name: "Video", muted: false, clips: [] }],
    },
    export: { ...DEFAULT_EXPORT_PRESET },
  };
}

/** Register a media file. If it's the first visual media on an empty timeline,
 *  the project adopts its resolution and frame rate. */
export function addMedia(
  p: ProjectFile,
  info: MediaInfo,
): { project: ProjectFile; media: MediaRef } {
  const media: MediaRef = { id: uid(), ...info };
  let timeline = p.timeline;
  const isVisual = info.kind === "video" || info.kind === "gif" || info.kind === "imageSeq";
  const timelineEmpty = p.timeline.tracks.every((t) => t.clips.length === 0);
  if (isVisual && timelineEmpty && info.width && info.height) {
    timeline = {
      ...timeline,
      width: clampCanvas(info.width),
      height: clampCanvas(info.height),
      fps: info.fps ?? timeline.fps,
    };
  }
  return { project: { ...p, media: [...p.media, media], timeline }, media };
}

export function findMedia(p: ProjectFile, mediaId: string): MediaRef | undefined {
  return p.media.find((m) => m.id === mediaId);
}

/** Pure clip factory for a media item. */
export function makeClip(media: MediaRef, at: number): Clip {
  const isAudio = media.kind === "audio";
  const dur = media.kind === "image" ? IMAGE_DEFAULT_DUR : Math.max(media.duration, MIN_CLIP_DUR);
  const clip: Clip = {
    id: uid(),
    mediaId: media.id,
    timelineStart: Math.max(0, at),
    srcIn: 0,
    srcOut: dur,
    speed: 1,
    audio: defaultAudio(),
  };
  if (!isAudio) clip.transform = defaultTransform();
  return clip;
}

/* ------------------------------------------------------------------ */
/* Track helpers                                                       */
/* ------------------------------------------------------------------ */

export function findTrack(p: ProjectFile, trackId: string): Track | undefined {
  return p.timeline.tracks.find((t) => t.id === trackId);
}

export function findClip(
  p: ProjectFile,
  clipId: string,
): { track: Track; clip: Clip; index: number } | undefined {
  for (const track of p.timeline.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return undefined;
}

function withTrack(p: ProjectFile, trackId: string, fn: (t: Track) => Track): ProjectFile {
  const tracks = p.timeline.tracks.map((t) => (t.id === trackId ? fn(t) : t));
  return { ...p, timeline: { ...p.timeline, tracks } };
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
}

/** The contiguous video prefix (per the z-order invariant). */
export function videoTracks(p: ProjectFile): Track[] {
  return p.timeline.tracks.filter((t) => t.kind === "video");
}

/** The topmost video track (tracks[0] per the invariant). */
export function topVideoTrack(p: ProjectFile): Track {
  return p.timeline.tracks[0]!;
}

/** Add an audio track. */
export function addAudioTrack(p: ProjectFile): { project: ProjectFile; trackId: string } {
  const id = uid();
  const n = p.timeline.tracks.filter((t) => t.kind === "audio").length + 1;
  const track: Track = { id, kind: "audio", name: `Audio ${n}`, muted: false, clips: [] };
  return {
    project: { ...p, timeline: { ...p.timeline, tracks: [...p.timeline.tracks, track] } },
    trackId: id,
  };
}

/** Add a video track as the new TOPMOST layer (unshifted to index 0). */
export function addVideoTrack(p: ProjectFile): { project: ProjectFile; trackId: string } {
  const id = uid();
  const n = videoTracks(p).length + 1;
  const track: Track = { id, kind: "video", name: `Video ${n}`, muted: false, clips: [] };
  return {
    project: { ...p, timeline: { ...p.timeline, tracks: [track, ...p.timeline.tracks] } },
    trackId: id,
  };
}

/** Remove a track (with any clips it holds when `force`). Audio tracks are
 *  optional — auto-created on demand (detachAudio/importMediaAsClip) — so any
 *  audio track may be removed, including the last one. A video track may be
 *  removed only when at least 2 video tracks exist (>=1 must always remain);
 *  without `force` a NON-EMPTY video track is refused (returns p unchanged).
 *  The video-prefix contiguity invariant is preserved: filtering never reorders
 *  the surviving tracks, so the remaining video tracks stay a contiguous prefix. */
export function removeTrack(
  p: ProjectFile,
  trackId: string,
  opts?: { force?: boolean },
): ProjectFile {
  const t = findTrack(p, trackId);
  if (!t) return p;
  if (t.kind === "video") {
    if (videoTracks(p).length < 2) return p; // never remove the last video track
    if (t.clips.length > 0 && !opts?.force) return p; // non-empty needs force
  }
  const tracks = p.timeline.tracks.filter((x) => x.id !== trackId);
  return { ...p, timeline: { ...p.timeline, tracks } };
}

/* ------------------------------------------------------------------ */
/* Placement: gaps, insertion, movement                                */
/* ------------------------------------------------------------------ */

interface Gap {
  start: number;
  end: number; // Infinity for the tail gap
}

function gapsOf(clips: Clip[]): Gap[] {
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const c of clips) {
    if (c.timelineStart - cursor > EPS) gaps.push({ start: cursor, end: c.timelineStart });
    cursor = Math.max(cursor, clipEnd(c));
  }
  gaps.push({ start: cursor, end: Infinity });
  return gaps;
}

/** Best feasible start for a clip of duration `dur` near `requested`,
 *  given the other clips on the track. Total: always returns a position. */
export function resolvePosition(others: Clip[], dur: number, requested: number): number {
  const target = Math.max(0, requested);
  let best = 0;
  let bestDist = Infinity;
  for (const g of gapsOf(others)) {
    if (g.end - g.start + EPS < dur) continue; // too small
    const clamped = Math.min(Math.max(target, g.start), g.end === Infinity ? target : g.end - dur);
    const pos = Math.max(g.start, clamped);
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = pos;
    }
  }
  return best;
}

/** Insert a clip on a track at (or near) clip.timelineStart. */
export function insertClip(p: ProjectFile, trackId: string, clip: Clip): ProjectFile {
  return withTrack(p, trackId, (t) => {
    const start = resolvePosition(t.clips, clipDuration(clip), clip.timelineStart);
    return { ...t, clips: sortClips([...t.clips, { ...clip, timelineStart: start }]) };
  });
}

/** Move a clip within its track (or to another track of the same kind).
 *
 *  Returns `p` UNCHANGED when the clip already sits on the destination track at
 *  the resolved start — the same no-change signal `insertClip`, `trimClip` and
 *  `setClipSpeed` use, and the one `session.commit` reads to decide whether to
 *  push an undo step. Without it a drag that moved nothing still produced a
 *  fresh reference and therefore a history entry, and with snapping on that is
 *  the NORMAL outcome of nudging a clip against its neighbour: the first Ctrl+Z
 *  then appeared to do nothing.
 *
 *  RESOLVED, not requested. The two differ whenever the requested span is
 *  occupied, which is the entire reason this function goes through
 *  `resolvePosition` — comparing against `requestedStart` would both miss real
 *  no-ops (a drag into an occupied span that lands back where it started) and
 *  claim false ones. The comparison is exact rather than epsilon-based: the
 *  resolved start of a genuine no-op is computed from the same operands as the
 *  clip's current start, so it comes back bit-identical, and an epsilon would
 *  let this report "nothing changed" about a move it did not actually make. */
export function moveClip(
  p: ProjectFile,
  clipId: string,
  requestedStart: number,
  toTrackId?: string,
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { track, clip } = found;
  const destId = toTrackId ?? track.id;
  const dest = findTrack(p, destId);
  if (!dest || dest.kind !== track.kind) return p;

  // Resolved against the destination WITHOUT this clip — a clip never blocks
  // its own move. (For a cross-track move the filter is a no-op; for a
  // same-track one it is exactly what the removal below would have left.)
  const others = dest.clips.filter((c) => c.id !== clipId);
  const start = resolvePosition(others, clipDuration(clip), requestedStart);
  if (destId === track.id && start === clip.timelineStart) return p;

  // Remove from source track…
  let next = withTrack(p, track.id, (t) => ({
    ...t,
    clips: t.clips.filter((c) => c.id !== clipId),
  }));
  // …then place on destination at the start already resolved above.
  next = withTrack(next, destId, (t) => ({
    ...t,
    clips: sortClips([...t.clips, { ...clip, timelineStart: start }]),
  }));
  return next;
}

/* ------------------------------------------------------------------ */
/* Editing: trim, split, delete, ripple                                */
/* ------------------------------------------------------------------ */

/** Trim a clip edge to a requested timeline time (clamped to all bounds). */
export function trimClip(
  p: ProjectFile,
  clipId: string,
  edge: "in" | "out",
  requestedT: number,
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { track, clip, index } = found;
  const media = findMedia(p, clip.mediaId);
  if (!media) return p;
  const isImage = media.kind === "image";
  const srcMax = isImage ? Infinity : media.duration;

  const start = clip.timelineStart;
  const end = clipEnd(clip);

  if (edge === "in") {
    const prev = track.clips[index - 1];
    const minByTrack = prev ? clipEnd(prev) : 0;
    const minBySrc = start - clip.srcIn / clip.speed; // srcIn' >= 0
    const lo = Math.max(minByTrack, minBySrc, 0);
    const hi = end - MIN_CLIP_DUR;
    const t = Math.min(Math.max(requestedT, lo), hi);
    if (!Number.isFinite(t) || Math.abs(t - start) < EPS) return p;
    const srcIn = clip.srcIn + (t - start) * clip.speed;
    return withTrack(p, track.id, (tr) => ({
      ...tr,
      clips: tr.clips.map((c) =>
        c.id === clipId ? { ...c, timelineStart: t, srcIn: Math.max(0, srcIn) } : c,
      ),
    }));
  } else {
    const next = track.clips[index + 1];
    const maxByTrack = next ? next.timelineStart : Infinity;
    const maxBySrc = start + (srcMax - clip.srcIn) / clip.speed; // srcOut' <= media.duration
    const lo = start + MIN_CLIP_DUR;
    const hi = Math.min(maxByTrack, maxBySrc);
    const t = Math.min(Math.max(requestedT, lo), hi);
    if (!Number.isFinite(t) || Math.abs(t - end) < EPS) return p;
    const srcOut = clip.srcIn + (t - start) * clip.speed;
    return withTrack(p, track.id, (tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (c.id === clipId ? { ...c, srcOut } : c)),
    }));
  }
}

/** Split a clip at a timeline time. Returns the project and the new right-half id. */
export function splitClip(
  p: ProjectFile,
  clipId: string,
  atT: number,
): { project: ProjectFile; rightId: string | null } {
  const found = findClip(p, clipId);
  if (!found) return { project: p, rightId: null };
  const { track, clip } = found;
  const start = clip.timelineStart;
  const end = clipEnd(clip);
  if (atT < start + MIN_CLIP_DUR || atT > end - MIN_CLIP_DUR) {
    return { project: p, rightId: null };
  }
  const srcSplit = clip.srcIn + (atT - start) * clip.speed;
  const rightId = uid();
  const left: Clip = {
    ...clip,
    srcOut: srcSplit,
    audio: { ...clip.audio, fadeOutSec: 0 },
  };
  const right: Clip = {
    ...clip,
    id: rightId,
    timelineStart: atT,
    srcIn: srcSplit,
    audio: { ...clip.audio, fadeInSec: 0 },
  };
  const project = withTrack(p, track.id, (tr) => ({
    ...tr,
    clips: sortClips([...tr.clips.filter((c) => c.id !== clipId), left, right]),
  }));
  return { project, rightId };
}

export function removeClip(p: ProjectFile, clipId: string): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  return withTrack(p, found.track.id, (t) => ({
    ...t,
    clips: t.clips.filter((c) => c.id !== clipId),
  }));
}

/** Ripple delete: remove the clip and close the gap it occupied.
 *  Clips starting at/after the removed clip's end shift left on ALL tracks
 *  (keeps sync), clamped so nothing overlaps on its own track. */
export function rippleDelete(p: ProjectFile, clipId: string): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { clip } = found;
  const dur = clipDuration(clip);
  const threshold = clipEnd(clip) - EPS;

  const removed = removeClip(p, clipId);
  const tracks = removed.timeline.tracks.map((t) => {
    let cursor = 0;
    const clips = t.clips.map((c) => {
      let c2 = c;
      if (c.timelineStart >= threshold) {
        const want = c.timelineStart - dur;
        c2 = { ...c, timelineStart: Math.max(want, cursor) };
      }
      cursor = Math.max(cursor, clipEnd(c2));
      return c2;
    });
    return { ...t, clips };
  });
  return { ...removed, timeline: { ...removed.timeline, tracks } };
}

/* ------------------------------------------------------------------ */
/* Property updates                                                    */
/* ------------------------------------------------------------------ */

/** Patch arbitrary clip fields (transform, audio, …). Accepts a partial patch
 *  object or an updater that returns the full replacement clip. */
export function updateClip(
  p: ProjectFile,
  clipId: string,
  patch: Partial<Clip> | ((clip: Clip) => Clip),
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  return withTrack(p, found.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) =>
      c.id === clipId ? (typeof patch === "function" ? patch(c) : { ...c, ...patch }) : c,
    ),
  }));
}

/** Change playback speed; the clip's timeline footprint changes. If the new
 *  footprint would overlap the next clip, the source out-point is trimmed. */
export function setClipSpeed(p: ProjectFile, clipId: string, speed: number): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { track, clip, index } = found;
  const s = Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED);
  const next = track.clips[index + 1];
  const maxDur = next ? next.timelineStart - clip.timelineStart : Infinity;
  let srcOut = clip.srcOut;
  if ((clip.srcOut - clip.srcIn) / s > maxDur) {
    srcOut = clip.srcIn + maxDur * s;
  }
  const dur = (srcOut - clip.srcIn) / s;
  if (dur < MIN_CLIP_DUR) return p;
  return withTrack(p, track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, speed: s, srcOut } : c)),
  }));
}

/** Detach a video clip's embedded audio into its own audio-track clip.
 *  The new clip shares the source range/speed and gets its own copy of the
 *  audio settings; the source clip is marked audio.detached so it contributes
 *  no sound. The new clip lands on the first audio track that can hold it at
 *  the same start; otherwise a fresh audio track is created. No-op unless the
 *  clip lives on the video track, its media has audio, and it isn't already
 *  detached. */
export function detachAudio(
  p: ProjectFile,
  clipId: string,
): { project: ProjectFile; audioClipId: string | null } {
  const found = findClip(p, clipId);
  if (!found || found.track.kind !== "video") return { project: p, audioClipId: null };
  const { clip } = found;
  const media = findMedia(p, clip.mediaId);
  if (!media || !media.hasAudio || clip.audio.detached) {
    return { project: p, audioClipId: null };
  }

  const audioClipId = uid();
  const audioClip: Clip = {
    id: audioClipId,
    mediaId: clip.mediaId,
    timelineStart: clip.timelineStart,
    srcIn: clip.srcIn,
    srcOut: clip.srcOut,
    speed: clip.speed,
    audio: { ...clip.audio, detached: false },
  };

  // mark the source clip detached
  let project = updateClip(p, clipId, { audio: { ...clip.audio, detached: true } });

  // find an audio track that keeps the clip at the same start
  const dur = clipDuration(audioClip);
  let trackId: string | null = null;
  for (const t of project.timeline.tracks) {
    if (t.kind !== "audio") continue;
    const pos = resolvePosition(t.clips, dur, audioClip.timelineStart);
    if (Math.abs(pos - audioClip.timelineStart) <= EPS) {
      trackId = t.id;
      break;
    }
  }
  if (trackId === null) {
    const r = addAudioTrack(project);
    project = r.project;
    trackId = r.trackId;
  }
  project = insertClip(project, trackId, audioClip);
  return { project, audioClipId };
}

/** Silence a clip's audio contribution by marking it detached (in place).
 *  Works for video-track clips; no-op if already detached or media has no
 *  audio. */
export function removeClipAudio(p: ProjectFile, clipId: string): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { clip } = found;
  if (clip.audio.detached) return p;
  const media = findMedia(p, clip.mediaId);
  if (!media || !media.hasAudio) return p;
  return updateClip(p, clipId, { audio: { ...clip.audio, detached: true } });
}

export function touchModified(p: ProjectFile): ProjectFile {
  return { ...p, modifiedAt: new Date().toISOString() };
}

/** Import media and append a clip for it at the end of the fitting track
 *  (video track for visual media; first audio track — created on demand —
 *  for audio files). */
export function importMediaAsClip(
  p: ProjectFile,
  info: MediaInfo,
): { project: ProjectFile; mediaId: string; clipId: string } {
  const added = addMedia(p, info);
  let project = added.project;

  let trackId: string;
  if (added.media.kind === "audio") {
    const audioTrack = project.timeline.tracks.find((t) => t.kind === "audio");
    if (audioTrack) {
      trackId = audioTrack.id;
    } else {
      const r = addAudioTrack(project);
      project = r.project;
      trackId = r.trackId;
    }
  } else {
    trackId = topVideoTrack(project).id;
  }

  const track = project.timeline.tracks.find((t) => t.id === trackId)!;
  const last = track.clips[track.clips.length - 1];
  const clip = makeClip(added.media, last ? clipEnd(last) : 0);
  project = insertClip(project, trackId, clip);
  return { project, mediaId: added.media.id, clipId: clip.id };
}

/* ------------------------------------------------------------------ */
/* Markers                                                             */
/* ------------------------------------------------------------------ */

function withMarkers(p: ProjectFile, markers: Marker[]): ProjectFile {
  return { ...p, timeline: { ...p.timeline, markers } };
}

function sortMarkers(markers: Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.t - b.t);
}

/** Add a marker at timeline time t, keeping markers sorted. */
export function addMarkerAt(
  p: ProjectFile,
  t: number,
  color = 0,
): { project: ProjectFile; markerId: string } {
  const markerId = uid();
  const markers = sortMarkers([...(p.timeline.markers ?? []), { id: markerId, t, color }]);
  return { project: withMarkers(p, markers), markerId };
}

/** Move a marker to a new timeline time (re-sorts). */
export function moveMarkerTo(p: ProjectFile, markerId: string, t: number): ProjectFile {
  const cur = p.timeline.markers;
  if (!cur) return p;
  const markers = sortMarkers(cur.map((m) => (m.id === markerId ? { ...m, t } : m)));
  return withMarkers(p, markers);
}

export function removeMarker(p: ProjectFile, markerId: string): ProjectFile {
  const cur = p.timeline.markers;
  if (!cur) return p;
  return withMarkers(p, cur.filter((m) => m.id !== markerId));
}

/* ------------------------------------------------------------------ */
/* Project canvas                                                      */
/* ------------------------------------------------------------------ */

function clampCanvas(n: number): number {
  const even = Math.round(n / 2) * 2;
  return Math.min(Math.max(even, MIN_CANVAS), MAX_CANVAS);
}

/** Set the project canvas size, clamped to even integers within [16, 8192].
 *  No-op (same reference) if unchanged. */
export function setProjectCanvas(p: ProjectFile, width: number, height: number): ProjectFile {
  const w = clampCanvas(width);
  const h = clampCanvas(height);
  if (w === p.timeline.width && h === p.timeline.height) return p;
  return { ...p, timeline: { ...p.timeline, width: w, height: h } };
}

/* ------------------------------------------------------------------ */
/* Transform auto-fit                                                  */
/* ------------------------------------------------------------------ */

/** Scale that makes a clip's cropped (and possibly rotated) region "fit"
 *  (letterbox inside the canvas) or "fill" (cover the canvas, cropping edges).
 *
 *  The preview/export chain (transforms.ts) already auto-fits the cropped region
 *  at scale=1 via k = fit * scale where fit = min(projW/fitW, projH/fitH). So the
 *  fit scale is exactly 1, and the fill scale is the ratio that turns that min
 *  into the covering max: max(projW/fitW, projH/fitH) / fit. The visible extents
 *  are the crop clamped to the frame (matching computeTransformInto), with W/H
 *  swapped under 90/270 rotation. Result is clamped to [MIN_SCALE, MAX_SCALE]. */
export function fitFillScale(
  mediaW: number,
  mediaH: number,
  crop: { x: number; y: number; w: number; h: number } | undefined,
  projW: number,
  projH: number,
  mode: "fit" | "fill",
  rotate: 0 | 90 | 180 | 270 = 0,
): number {
  const srcW = Math.max(1, mediaW);
  const srcH = Math.max(1, mediaH);
  const c = crop ?? { x: 0, y: 0, w: srcW, h: srcH };
  // visible cropped extents, matching transforms.ts computeTransformInto
  const cropW = Math.max(1, Math.min(c.w, srcW - c.x));
  const cropH = Math.max(1, Math.min(c.h, srcH - c.y));
  const rotated = rotate === 90 || rotate === 270;
  const fitW = rotated ? cropH : cropW;
  const fitH = rotated ? cropW : cropH;
  const sx = projW / fitW;
  const sy = projH / fitH;
  // fit uses min (letterbox); scale=1 already fits, so the multiplier is min/min=1.
  // fill uses max (cover); the multiplier is max/min.
  const raw = mode === "fill" ? Math.max(sx, sy) / Math.min(sx, sy) : 1;
  return Math.min(Math.max(raw, MIN_SCALE), MAX_SCALE);
}

/* ------------------------------------------------------------------ */
/* Keyframes                                                           */
/* ------------------------------------------------------------------ */

const PROPS_OF_GROUP: Record<"position" | "scale" | "opacity", AnimProp[]> = {
  position: ["x", "y"],
  scale: ["scale"],
  opacity: ["opacity"],
};

/** Write a rebuilt keyframes object onto a clip. Empty arrays are stripped; an
 *  empty object collapses to no `keyframes` key at all (structural cleanliness
 *  so undo-all equality holds). */
function writeKeyframes(p: ProjectFile, clipId: string, kfs: ClipKeyframes): ProjectFile {
  const cleaned: ClipKeyframes = {};
  for (const [prop, arr] of Object.entries(kfs) as [AnimProp, Keyframe[] | undefined][]) {
    if (arr && arr.length > 0) cleaned[prop] = arr;
  }
  const hasAny = Object.keys(cleaned).length > 0;
  return updateClip(p, clipId, (clip) => {
    if (!hasAny) {
      if (clip.keyframes === undefined) return clip;
      const { keyframes: _drop, ...rest } = clip;
      return rest;
    }
    return { ...clip, keyframes: cleaned };
  });
}

/** Upsert a keyframe on a single prop at source time s. */
export function setKeyframe(
  p: ProjectFile,
  clipId: string,
  prop: AnimProp,
  s: number,
  v: number,
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const kfs: ClipKeyframes = { ...found.clip.keyframes };
  kfs[prop] = upsertKf(kfs[prop], s, v, EPS_KF);
  return writeKeyframes(p, clipId, kfs);
}

/** Upsert BOTH x and y keyframes at source time s (kept paired). */
export function setPositionKeyframes(
  p: ProjectFile,
  clipId: string,
  s: number,
  x: number,
  y: number,
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const kfs: ClipKeyframes = { ...found.clip.keyframes };
  kfs.x = upsertKf(kfs.x, s, x, EPS_KF);
  kfs.y = upsertKf(kfs.y, s, y, EPS_KF);
  return writeKeyframes(p, clipId, kfs);
}

/** Remove the keyframe(s) near source time s from a group. Position removes
 *  from both x and y. Empty arrays drop their keys; an empty keyframes object
 *  becomes undefined. */
export function removeKeyframesNear(
  p: ProjectFile,
  clipId: string,
  group: "position" | "scale" | "opacity",
  s: number,
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { clip } = found;
  if (!clip.keyframes) return p;
  const kfs: ClipKeyframes = { ...clip.keyframes };
  for (const prop of PROPS_OF_GROUP[group]) {
    const arr = kfs[prop];
    if (!arr) continue;
    kfs[prop] = removeKfNear(arr, s, EPS_KF);
  }
  return writeKeyframes(p, clipId, kfs);
}

/** Clear a group's animation. Deletes the group's arrays and, when `bake` is
 *  provided, writes those static values into clip.transform. */
export function clearAnimation(
  p: ProjectFile,
  clipId: string,
  group: "position" | "scale" | "opacity",
  bake?: Partial<{ x: number; y: number; scale: number; opacity: number }>,
): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { clip } = found;
  const kfs: ClipKeyframes = { ...clip.keyframes };
  for (const prop of PROPS_OF_GROUP[group]) delete kfs[prop];
  let next = writeKeyframes(p, clipId, kfs);
  if (bake && clip.transform) {
    next = updateClip(next, clipId, { transform: { ...clip.transform, ...bake } });
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

/** Patch fields on a media item. */
export function updateMedia(
  p: ProjectFile,
  mediaId: string,
  patch: Partial<MediaRef>,
): ProjectFile {
  return { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, ...patch } : m)) };
}

/** Remove a media item AND every clip referencing it on every track. */
export function removeMediaCascade(p: ProjectFile, mediaId: string): ProjectFile {
  const tracks = p.timeline.tracks.map((t) => ({
    ...t,
    clips: t.clips.filter((c) => c.mediaId !== mediaId),
  }));
  return {
    ...p,
    media: p.media.filter((m) => m.id !== mediaId),
    timeline: { ...p.timeline, tracks },
  };
}

/** Register a synthetic (generated) media item — solid or text. Unlike addMedia
 *  it never adopts the project resolution/fps. kind is "image"; path is the
 *  display label only. */
export function addGeneratedMedia(
  p: ProjectFile,
  generator: Generator,
  width: number,
  height: number,
  label: string,
): { project: ProjectFile; media: MediaRef } {
  const media: MediaRef = {
    id: uid(),
    path: label,
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 0,
    hasAudio: false,
    width,
    height,
    generator,
  };
  return { project: { ...p, media: [...p.media, media] }, media };
}

/* ------------------------------------------------------------------ */
/* Loading a .trt: numeric sanitation                                  */
/* ------------------------------------------------------------------ */

/**
 * WHY THIS EXISTS, AND WHY IT IS ON THIS SIDE OF THE WIRE.
 *
 * `load_project` hands the frontend the RAW json (`store.rs` types it `Value`
 * and returns `migrated`); the typed Rust struct it deserializes on the way
 * past is used only for the missing-media scan and the recents stamp. So a
 * `deserialize_with` on the Rust schema — `de_speed`, which normalises a zero,
 * negative or non-finite `speed` — protects the EXPORT path (which does read
 * the typed struct) and nothing else. `editor.ts` feeds the raw value straight
 * into `ProjectSession`, and `save_project` writes the raw value back, so
 * before this a `"speed": 0` file gave the editor `clipDuration() = Infinity`
 * while the exporter computed something else entirely: a silent preview/export
 * disagreement about how long a clip is, repaired nowhere and on nothing.
 *
 * `checkInvariants` below is TEST-ONLY — it never runs at runtime — so it is
 * not the guard, and cannot be made into one cheaply (it reports, it does not
 * repair). This function is the runtime one, and it follows the convention
 * `sanitizeSettings` already set for settings.json: coerce field by field on
 * READ, because a hand-edited or corrupt file must never crash a mount.
 *
 * WHAT IT DOES AND DOES NOT TOUCH. Only values with NO honest meaning are
 * repaired — non-finite results, a divisor that is zero, a negative where
 * negative is not a thing. Legal-but-unusual values are left exactly as
 * authored: a speed of 8 (outside the editor's [0.25, 4]) still works and stays
 * in step with the video chain, so clamping it would change a working project.
 * That line matters because Rust repairs only `speed`: any repair here is a
 * DIVERGENCE from the raw file until the session's next write puts the repaired
 * value on disk. Confining repairs to values whose alternative is `inf`/`nan`
 * reaching ffmpeg means the thing being diverged from was never going to
 * render anyway.
 *
 * STRUCTURE IS NOT CHECKED. `load_project` has already deserialized the file
 * into the typed struct, so shapes and JSON types are guaranteed by the time
 * this runs — every clip has every field, `tracks` is an array of tracks. Only
 * the VALUES are unconstrained (plus what `u32` already rejects: `width`,
 * `height`, `rotate` and the fps pair cannot arrive negative or fractional,
 * but they CAN arrive as zero). Structural invariants — track order, clip
 * overlap, x/y keyframe pairing — are deliberately left to `checkInvariants`:
 * repairing them means reordering or deleting a user's work, which is a much
 * larger decision than replacing a value that cannot be rendered.
 *
 * Everything returns the SAME reference when nothing needed repair, so the
 * overwhelmingly common case (a healthy project) allocates nothing and keeps
 * object identity for `ProjectSession`'s reference comparisons.
 */

/** Finite, or `fallback`. */
function fin(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Finite and >= `lo`, or `fallback`. */
function finMin(v: number, lo: number, fallback: number): number {
  return Number.isFinite(v) && v >= lo ? v : fallback;
}

/** A crop whose numbers cannot describe a rectangle is dropped rather than
 *  guessed at: no crop is the identity, and it is the one repair that cannot
 *  invent a region the user never asked for. */
function sanitizeCrop(c: ClipCrop | undefined): ClipCrop | undefined {
  if (!c) return c;
  const ok =
    Number.isFinite(c.x) &&
    Number.isFinite(c.y) &&
    c.x >= 0 &&
    c.y >= 0 &&
    Number.isFinite(c.w) &&
    Number.isFinite(c.h) &&
    c.w > 0 &&
    c.h > 0;
  return ok ? c : undefined;
}

/** `rotate` is `u32` in the schema but `0 | 90 | 180 | 270` in the type, and
 *  every consumer switches on those four; `scale`, `x`, `y` and `opacity` reach
 *  both the canvas matrix and the exporter's filter expressions, where a
 *  non-finite value is printed literally as `nan`/`inf` and ffmpeg refuses the
 *  graph. A scale of zero is the same kind of dead end (`scale=0:0`). */
function sanitizeTransform(t: ClipTransform): ClipTransform {
  const rotate: ClipTransform["rotate"] =
    t.rotate === 90 || t.rotate === 180 || t.rotate === 270 ? t.rotate : 0;
  const scale = Number.isFinite(t.scale) && t.scale > 0 ? t.scale : 1;
  const x = fin(t.x, 0);
  const y = fin(t.y, 0);
  const opacity = fin(t.opacity, 1);
  const crop = sanitizeCrop(t.crop);
  if (
    rotate === t.rotate &&
    scale === t.scale &&
    x === t.x &&
    y === t.y &&
    opacity === t.opacity &&
    crop === t.crop
  ) {
    return t;
  }
  const out: ClipTransform = { ...t, rotate, scale, x, y, opacity };
  if (crop) out.crop = crop;
  else delete out.crop;
  return out;
}

/** Both audio sinks multiply `volume` by `10 ** (gainOffsetDb / 20)`: the
 *  preview's GainNode, which THROWS on a non-finite assignment and so takes the
 *  whole playback graph down, and the exporter's `volume=` filter, which prints
 *  `NaN`/`inf` and makes ffmpeg reject the chain. A pair whose product is not
 *  representable is reset whole, since either one alone could be the culprit.
 *
 *  A NEGATIVE volume is its own preview/export disagreement, live today: the
 *  preview graph applies `Math.max(0, volume)` (silence) while the exporter
 *  passes the negative straight into `volume=`. Zero is the honest reading of
 *  "less than none". */
function sanitizeAudio(a: ClipAudio): ClipAudio {
  let volume = Number.isFinite(a.volume) ? Math.max(0, a.volume) : 1;
  let gainOffsetDb = fin(a.gainOffsetDb, 0);
  if (!Number.isFinite(volume * 10 ** (gainOffsetDb / 20))) {
    volume = 1;
    gainOffsetDb = 0;
  }
  const fadeInSec = finMin(a.fadeInSec, 0, 0);
  const fadeOutSec = finMin(a.fadeOutSec, 0, 0);
  if (
    volume === a.volume &&
    gainOffsetDb === a.gainOffsetDb &&
    fadeInSec === a.fadeInSec &&
    fadeOutSec === a.fadeOutSec
  ) {
    return a;
  }
  return { ...a, volume, gainOffsetDb, fadeInSec, fadeOutSec };
}

/** One prop's track. `evalKfs` and `KfCursor` both assume finite values and a
 *  STRICTLY ascending `t` — a descending pair is binary-searched wrongly and
 *  `clampedBreakpoints` emits it as decreasing timestamps into the export
 *  expression. Entries that cannot be placed (non-finite `t`) or cannot be
 *  interpolated (non-finite `v`) are dropped; the survivors are sorted and
 *  de-duplicated, which preserves more of the user's work than dropping the
 *  array. An empty result becomes `undefined`, matching `writeKeyframes`'s
 *  rule that an empty array is a violation rather than an absence. */
function sanitizeKfs(arr: Keyframe[]): Keyframe[] | undefined {
  let clean = arr.length > 0;
  let prevT = -Infinity;
  for (const k of arr) {
    if (!Number.isFinite(k.t) || !Number.isFinite(k.v) || !(k.t > prevT)) {
      clean = false;
      break;
    }
    prevT = k.t;
  }
  if (clean) return arr;
  const kept = arr
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v))
    .sort((a, b) => a.t - b.t);
  const out: Keyframe[] = [];
  for (const k of kept) {
    if (out.length === 0 || k.t > out[out.length - 1]!.t) out.push(k);
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeKeyframes(kfs: ClipKeyframes): ClipKeyframes | undefined {
  let changed = false;
  const out: ClipKeyframes = {};
  for (const prop of ["x", "y", "scale", "opacity"] as const) {
    const arr = kfs[prop];
    if (arr === undefined) continue;
    const next = sanitizeKfs(arr);
    if (next !== arr) changed = true;
    if (next) out[prop] = next;
  }
  if (!changed) return kfs;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * POSTCONDITION: `clipDuration()` and `clipEnd()` of the returned clip are
 * finite, and the duration is > 0.
 *
 * `speed` mirrors `de_speed` in `schema.rs` EXACTLY — non-finite or <= 0
 * becomes 1.0, and nothing else moves — so the two sides of the wire agree
 * rather than trading one silent disagreement for another. The extra step is
 * the one case that survives both: a finite, positive speed small enough that
 * `(srcOut - srcIn) / speed` overflows. Rust would compute `inf` there too, so
 * the sides still AGREE about the file being unusable; the difference is that
 * an infinite `timelineDuration` serialises to JSON `null`, and the export
 * dialog's estimate input types it `f64`, so the estimate errors out. Making a
 * finite duration a postcondition here is what closes that.
 */
function sanitizeClip(c: Clip): Clip {
  const timelineStart = finMin(c.timelineStart, 0, 0);
  let srcIn = finMin(c.srcIn, 0, 0);
  let srcOut = c.srcOut;
  if (!(Number.isFinite(srcOut) && srcOut > srcIn)) {
    srcOut = srcIn + MIN_CLIP_DUR;
    // …and if srcIn is so large that adding a frame does not move it, there is
    // no in-point near it that can hold a clip at all.
    if (!(srcOut > srcIn)) {
      srcIn = 0;
      srcOut = MIN_CLIP_DUR;
    }
  }
  let speed = Number.isFinite(c.speed) && c.speed > 0 ? c.speed : 1;
  if (!Number.isFinite((srcOut - srcIn) / speed)) speed = 1;

  const audio = sanitizeAudio(c.audio);
  const transform = c.transform ? sanitizeTransform(c.transform) : c.transform;
  const keyframes = c.keyframes ? sanitizeKeyframes(c.keyframes) : c.keyframes;
  if (
    timelineStart === c.timelineStart &&
    srcIn === c.srcIn &&
    srcOut === c.srcOut &&
    speed === c.speed &&
    audio === c.audio &&
    transform === c.transform &&
    keyframes === c.keyframes
  ) {
    return c;
  }
  const out: Clip = { ...c, timelineStart, srcIn, srcOut, speed, audio };
  if (transform) out.transform = transform;
  else delete out.transform;
  if (keyframes) out.keyframes = keyframes;
  else delete out.keyframes;
  return out;
}

/** `fpsValue` is `num / den` and every time helper divides by it, so a zero
 *  `den` (which `u32` happily accepts) is `speed: 0` wearing a different hat:
 *  `frameOf` returns ±Infinity and `snapToFrame` returns NaN, which is the
 *  playhead, the ruler and the exporter's `-r` all at once. */
function sanitizeFps(fps: Rational): Rational {
  const rate = fps.num / fps.den;
  const ok =
    Number.isFinite(fps.num) &&
    fps.num > 0 &&
    Number.isFinite(fps.den) &&
    fps.den > 0 &&
    Number.isFinite(rate) &&
    rate > 0;
  return ok ? fps : { num: 30, den: 1 };
}

/** Media metadata is re-derived by `probe_media` on relink, but `duration`
 *  reaches ffmpeg directly as the `duration` argument of the waveform and
 *  filmstrip jobs, where a non-finite value serialises to JSON `null` and the
 *  `f64` parameter rejects it. */
function sanitizeMediaRef(m: MediaRef): MediaRef {
  const duration = finMin(m.duration, 0, 0);
  return duration === m.duration ? m : { ...m, duration };
}

/**
 * Repair the numeric fields of a freshly loaded project. Total: never throws,
 * and returns `p` itself when nothing needed repair.
 *
 * Called from `ipc.loadProject`, which is the single point at which a `.trt`
 * becomes app state — putting it there rather than in the editor means every
 * consumer (the session, the preview, the export spec the dialog builds from
 * the in-memory project) sees the same repaired numbers, so preview and export
 * cannot disagree, and the session's next write puts them on disk.
 */
export function sanitizeProject(p: ProjectFile): ProjectFile {
  const t = p.timeline;

  const fps = sanitizeFps(t.fps);
  // clampCanvas is the app's own rule for this pair (even integers in
  // [16, 8192], enforced by setProjectCanvas), but it is arithmetic: NaN in,
  // NaN out. A canvas of 0 is what `u32` lets through and what `scale=0:0`
  // chokes on.
  const width = Number.isFinite(t.width) ? clampCanvas(t.width) : 1920;
  const height = Number.isFinite(t.height) ? clampCanvas(t.height) : 1080;

  // THE ONE STRUCTURAL REPAIR, and the reason it is the only one.
  //
  // Everything else here repairs a VALUE that has no honest meaning and leaves
  // structure alone, because reordering or dropping tracks would be discarding
  // the user's work. A timeline with no video track is the exception: there is
  // no work to preserve, and `topVideoTrack` is `tracks[0]!` — so an empty array
  // makes it `undefined` and the first `.id` throws. That is a hard crash on
  // import from a hand-edited or truncated `.trt`, and the crafted `.trt` is
  // this app's main threat surface.
  //
  // An audio-only `tracks` array is the subtler half of the same bug: `tracks[0]`
  // would be an AUDIO track and `topVideoTrack` would hand it back silently, so
  // an imported clip lands on a lane that cannot show it. The invariant the rest
  // of the tree relies on (addVideoTrack unshifts, addAudioTrack appends) is
  // "video tracks first, at least one of them" — restore exactly that, keeping
  // every existing track and its clips.
  const hasVideoFirst = t.tracks[0]?.kind === "video";
  const baseTracks: Track[] = hasVideoFirst
    ? t.tracks
    : [{ id: uid(), kind: "video", name: "Video 1", muted: false, clips: [] }, ...t.tracks];

  let tracksChanged = baseTracks !== t.tracks;
  const tracks = baseTracks.map((track) => {
    let clipsChanged = false;
    const clips = track.clips.map((c) => {
      const next = sanitizeClip(c);
      if (next !== c) clipsChanged = true;
      return next;
    });
    if (!clipsChanged) return track;
    tracksChanged = true;
    return { ...track, clips };
  });

  // A marker whose time is not a number cannot be drawn anywhere on the ruler,
  // so there is nothing to repair it TO — it is dropped. Order is left alone:
  // an out-of-order marker still draws in the right place.
  let markers = t.markers;
  if (markers) {
    const kept = markers.filter((m) => Number.isFinite(m.t));
    if (kept.length !== markers.length) markers = kept;
  }

  let mediaChanged = false;
  const media = p.media.map((m) => {
    const next = sanitizeMediaRef(m);
    if (next !== m) mediaChanged = true;
    return next;
  });

  const timelineChanged =
    fps !== t.fps ||
    width !== t.width ||
    height !== t.height ||
    tracksChanged ||
    markers !== t.markers;
  if (!timelineChanged && !mediaChanged) return p;

  let timeline = t;
  if (timelineChanged) {
    // Spread first so an ABSENT `markers` key stays absent (rather than becoming
    // an explicit `undefined`), then overwrite only if something was dropped.
    timeline = { ...t, fps, width, height, tracks };
    if (markers !== t.markers) timeline.markers = markers;
  }
  return { ...p, media, timeline };
}

/* ------------------------------------------------------------------ */
/* Invariants (used by tests and the fuzz harness)                     */
/* ------------------------------------------------------------------ */

function checkKfArray(errors: string[], clipId: string, prop: string, arr: Keyframe[]): void {
  // An EMPTY array is a violation, not an absence. writeKeyframes strips them,
  // but schema.rs types the tracks Option<Vec<Keyframe>> and happily
  // deserializes `[]` from a shared/hand-edited .trt — and every consumer gates
  // on truthiness, which `[]` passes, so it reaches evalKfs and throws.
  if (arr.length === 0) errors.push(`clip ${clipId} kf ${prop}: empty array`);
  let prevT = -Infinity;
  for (const k of arr) {
    if (!Number.isFinite(k.v)) errors.push(`clip ${clipId} kf ${prop}: non-finite v`);
    if (!(k.t > prevT)) errors.push(`clip ${clipId} kf ${prop}: not strictly ascending`);
    if (prop === "scale" && !(k.v > 0)) errors.push(`clip ${clipId} kf scale: v <= 0`);
    if (prop === "opacity" && (k.v < 0 || k.v > 1))
      errors.push(`clip ${clipId} kf opacity: v out of [0,1]`);
    prevT = k.t;
  }
}

export function checkInvariants(p: ProjectFile): string[] {
  const errors: string[] = [];
  const vtracks = p.timeline.tracks.filter((t) => t.kind === "video");
  if (vtracks.length < 1) errors.push("expected >=1 video track, got 0");
  if (p.timeline.tracks[0]?.kind !== "video") errors.push("tracks[0] is not a video track");
  // contiguity: no video track appears after the first audio track
  let seenAudio = false;
  for (const t of p.timeline.tracks) {
    if (t.kind === "audio") seenAudio = true;
    else if (seenAudio) errors.push("video track after an audio track (non-contiguous)");
  }

  // canvas: even integers within bounds
  for (const [dim, val] of [
    ["width", p.timeline.width],
    ["height", p.timeline.height],
  ] as const) {
    if (!Number.isInteger(val) || val % 2 !== 0 || val < MIN_CANVAS || val > MAX_CANVAS)
      errors.push(`timeline ${dim} ${val} not an even integer in [16, 8192]`);
  }

  // markers: sorted ascending + finite t
  const markers = p.timeline.markers;
  if (markers) {
    let prevT = -Infinity;
    for (const m of markers) {
      if (!Number.isFinite(m.t)) errors.push(`marker ${m.id}: non-finite t`);
      if (m.t < prevT - EPS) errors.push(`marker ${m.id}: out of order`);
      prevT = m.t;
    }
  }

  const mediaIds = new Set(p.media.map((m) => m.id));
  for (const track of p.timeline.tracks) {
    let prevEnd = -Infinity;
    let prevStart = -Infinity;
    for (const c of track.clips) {
      if (!mediaIds.has(c.mediaId)) errors.push(`clip ${c.id}: unknown media ${c.mediaId}`);
      if (c.timelineStart < prevStart - EPS)
        errors.push(`track ${track.name}: clips not sorted at ${c.id}`);
      if (c.timelineStart < prevEnd - EPS)
        errors.push(`track ${track.name}: overlap at ${c.id}`);
      if (c.timelineStart < -EPS) errors.push(`clip ${c.id}: negative start`);
      if (!(c.srcIn < c.srcOut)) errors.push(`clip ${c.id}: srcIn >= srcOut`);
      if (c.srcIn < -EPS) errors.push(`clip ${c.id}: negative srcIn`);
      const media = p.media.find((m) => m.id === c.mediaId);
      if (media && media.kind !== "image" && c.srcOut > media.duration + 1e-3) {
        errors.push(`clip ${c.id}: srcOut ${c.srcOut} beyond media ${media.duration}`);
      }
      if (c.speed < MIN_SPEED - EPS || c.speed > MAX_SPEED + EPS)
        errors.push(`clip ${c.id}: speed ${c.speed} out of range`);
      if (clipDuration(c) < MIN_CLIP_DUR - EPS)
        errors.push(`clip ${c.id}: below minimum duration`);
      if (c.keyframes) {
        for (const [prop, arr] of Object.entries(c.keyframes)) {
          if (arr) checkKfArray(errors, c.id, prop, arr);
        }
        const xs = c.keyframes.x;
        const ys = c.keyframes.y;
        if ((xs === undefined) !== (ys === undefined)) {
          errors.push(`clip ${c.id}: x/y keyframes not paired`);
        } else if (xs && ys) {
          if (xs.length !== ys.length) errors.push(`clip ${c.id}: x/y kf length mismatch`);
          else
            for (let k = 0; k < xs.length; k++) {
              if (Math.abs(xs[k]!.t - ys[k]!.t) > 1e-9)
                errors.push(`clip ${c.id}: x/y kf time mismatch at ${k}`);
            }
        }
      }
      prevEnd = clipEnd(c);
      prevStart = c.timelineStart;
    }
  }
  return errors;
}
