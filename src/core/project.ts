// Pure project mutations. Every function returns a NEW ProjectFile with
// structural sharing — callers never mutate state in place.
//
// Invariants (verified by checkInvariants + fuzz tests):
//  - exactly one video track, at tracks[0]
//  - per track: clips sorted by timelineStart, non-overlapping
//  - 0 <= srcIn < srcOut <= media.duration (still images excepted)
//  - every clip.mediaId resolves; speed within [MIN_SPEED, MAX_SPEED]

import type {
  Clip,
  ClipAudio,
  ClipTransform,
  MediaInfo,
  MediaRef,
  ProjectFile,
  Track,
} from "./types";
import { DEFAULT_EXPORT_PRESET } from "./types";
import { clipDuration, clipEnd } from "./time";

export const MIN_CLIP_DUR = 1 / 120; // one frame at 120fps — hard floor
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const IMAGE_DEFAULT_DUR = 5;
const EPS = 1e-6;

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
      width: info.width,
      height: info.height,
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

export function removeTrack(p: ProjectFile, trackId: string): ProjectFile {
  const t = findTrack(p, trackId);
  if (!t || t.kind === "video") return p; // the video track is permanent
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

/** Move a clip within its track (or to another track of the same kind). */
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

  // Remove from source track…
  let next = withTrack(p, track.id, (t) => ({
    ...t,
    clips: t.clips.filter((c) => c.id !== clipId),
  }));
  // …then place on destination near the requested start.
  next = withTrack(next, destId, (t) => {
    const start = resolvePosition(t.clips, clipDuration(clip), requestedStart);
    return { ...t, clips: sortClips([...t.clips, { ...clip, timelineStart: start }]) };
  });
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

/** Patch arbitrary clip fields (transform, audio, …). */
export function updateClip(p: ProjectFile, clipId: string, patch: Partial<Clip>): ProjectFile {
  const found = findClip(p, clipId);
  if (!found) return p;
  return withTrack(p, found.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
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
    trackId = project.timeline.tracks[0]!.id;
  }

  const track = project.timeline.tracks.find((t) => t.id === trackId)!;
  const last = track.clips[track.clips.length - 1];
  const clip = makeClip(added.media, last ? clipEnd(last) : 0);
  project = insertClip(project, trackId, clip);
  return { project, mediaId: added.media.id, clipId: clip.id };
}

/* ------------------------------------------------------------------ */
/* Invariants (used by tests and the fuzz harness)                     */
/* ------------------------------------------------------------------ */

export function checkInvariants(p: ProjectFile): string[] {
  const errors: string[] = [];
  const videoTracks = p.timeline.tracks.filter((t) => t.kind === "video");
  if (videoTracks.length !== 1) errors.push(`expected 1 video track, got ${videoTracks.length}`);
  if (p.timeline.tracks[0]?.kind !== "video") errors.push("tracks[0] is not the video track");

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
      prevEnd = clipEnd(c);
      prevStart = c.timelineStart;
    }
  }
  return errors;
}
