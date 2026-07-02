import { describe, expect, it } from "vitest";
import { History } from "./history";
import {
  addAudioTrack,
  addGeneratedMedia,
  addMarkerAt,
  addMedia,
  addVideoTrack,
  checkInvariants,
  clearAnimation,
  createProject,
  detachAudio,
  findClip,
  insertClip,
  moveMarkerTo,
  removeClipAudio,
  removeKeyframesNear,
  removeMarker,
  removeMediaCascade,
  removeTrack,
  makeClip,
  moveClip,
  removeClip,
  resolvePosition,
  rippleDelete,
  setClipSpeed,
  setKeyframe,
  setPositionKeyframes,
  setProjectCanvas,
  splitClip,
  topVideoTrack,
  trimClip,
  videoTracks,
} from "./project";
import { EPS_KF } from "./anim";
import { clipDuration, clipEnd, rat } from "./time";
import type { Generator, MediaInfo, ProjectFile } from "./types";

const videoInfo = (duration = 60): MediaInfo => ({
  path: "C:\\media\\test video.mp4",
  size: 1000,
  mtimeMs: 1,
  kind: "video",
  duration,
  fps: rat(30),
  width: 1280,
  height: 720,
  hasAudio: true,
});

const audioInfo = (duration = 120): MediaInfo => ({
  path: "C:\\media\\music.mp3",
  size: 500,
  mtimeMs: 2,
  kind: "audio",
  duration,
  hasAudio: true,
});

/** Project with one 60s video media + one clip [0..60) on the video track. */
function baseProject(): { p: ProjectFile; mediaId: string; clipId: string } {
  let p = createProject("Test");
  const added = addMedia(p, videoInfo());
  p = added.project;
  const clip = makeClip(added.media, 0);
  p = insertClip(p, p.timeline.tracks[0]!.id, clip);
  return { p, mediaId: added.media.id, clipId: clip.id };
}

const expectClean = (p: ProjectFile) => expect(checkInvariants(p)).toEqual([]);

describe("createProject / addMedia", () => {
  it("starts valid with a single video track", () => {
    const p = createProject("New");
    expectClean(p);
    expect(p.timeline.tracks).toHaveLength(1);
  });

  it("adopts resolution + fps from the first visual media", () => {
    let p = createProject("New");
    p = addMedia(p, videoInfo()).project;
    expect(p.timeline.width).toBe(1280);
    expect(p.timeline.height).toBe(720);
    expect(p.timeline.fps).toEqual(rat(30));
    expectClean(p);
  });
});

describe("placement", () => {
  it("resolvePosition clamps into the nearest feasible gap", () => {
    const { p, clipId } = baseProject();
    const track = p.timeline.tracks[0]!;
    const others = track.clips.filter((c) => c.id !== clipId);
    // empty others: anywhere is fine
    expect(resolvePosition(others, 10, 42)).toBe(42);
    // with the 0..60 clip present, a 10s clip requested at 5 goes after it
    expect(resolvePosition(track.clips, 10, 5)).toBe(60);
  });

  it("insertClip never overlaps", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const c2 = makeClip(media, 30); // wants to land inside the existing clip
    p = insertClip(p, p.timeline.tracks[0]!.id, c2);
    expectClean(p);
    expect(findClip(p, c2.id)!.clip.timelineStart).toBe(60);
  });

  it("moveClip moves within the track and clamps", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const c2 = makeClip(media, 60);
    p = insertClip(p, p.timeline.tracks[0]!.id, c2);
    // move second clip to t=200 (free)
    p = moveClip(p, c2.id, 200);
    expect(findClip(p, c2.id)!.clip.timelineStart).toBe(200);
    // move it onto the first clip → clamps against it
    p = moveClip(p, c2.id, 10);
    expectClean(p);
    const start = findClip(p, c2.id)!.clip.timelineStart;
    expect(start).toBeGreaterThanOrEqual(60);
  });

  it("moveClip across audio tracks, but never across kinds", () => {
    let { p } = baseProject();
    const a1 = addAudioTrack(p);
    p = a1.project;
    const am = addMedia(p, audioInfo());
    p = am.project;
    const ac = makeClip(am.media, 0);
    p = insertClip(p, a1.trackId, ac);
    const a2 = addAudioTrack(p);
    p = a2.project;
    // audio → audio track OK
    p = moveClip(p, ac.id, 5, a2.trackId);
    expect(findClip(p, ac.id)!.track.id).toBe(a2.trackId);
    // audio → video track rejected (no-op)
    const before = p;
    p = moveClip(p, ac.id, 0, p.timeline.tracks[0]!.id);
    expect(p).toBe(before);
    expectClean(p);
  });
});

describe("trim", () => {
  it("trims the in-edge, adjusting srcIn", () => {
    let { p, clipId } = baseProject();
    p = trimClip(p, clipId, "in", 10);
    const c = findClip(p, clipId)!.clip;
    expect(c.timelineStart).toBe(10);
    expect(c.srcIn).toBe(10);
    expectClean(p);
  });

  it("trims the out-edge, adjusting srcOut", () => {
    let { p, clipId } = baseProject();
    p = trimClip(p, clipId, "out", 42);
    const c = findClip(p, clipId)!.clip;
    expect(c.srcOut).toBe(42);
    expectClean(p);
  });

  it("cannot extend beyond the source media", () => {
    let { p, clipId } = baseProject();
    p = trimClip(p, clipId, "out", 999); // media is 60s
    const c = findClip(p, clipId)!.clip;
    expect(clipEnd(c)).toBeCloseTo(60, 9);
    expectClean(p);
  });

  it("cannot trim into its neighbour", () => {
    let { p, mediaId, clipId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const c2 = makeClip(media, 60);
    p = insertClip(p, p.timeline.tracks[0]!.id, c2);
    // first clip trimmed shorter, then try to extend past the second's start
    p = trimClip(p, clipId, "out", 30);
    p = trimClip(p, clipId, "out", 80);
    const c = findClip(p, clipId)!.clip;
    expect(clipEnd(c)).toBeLessThanOrEqual(60 + 1e-9);
    expectClean(p);
  });

  it("respects speed when mapping trims to source time", () => {
    let { p, clipId } = baseProject();
    p = setClipSpeed(p, clipId, 2); // 60s source → 30s footprint
    p = trimClip(p, clipId, "in", 5);
    const c = findClip(p, clipId)!.clip;
    expect(c.srcIn).toBeCloseTo(10, 9); // 5s timeline at 2x = 10s source
    expectClean(p);
  });
});

describe("split", () => {
  it("produces two contiguous clips sharing the source split point", () => {
    const { p, clipId } = baseProject();
    const { project, rightId } = splitClip(p, clipId, 20);
    expect(rightId).not.toBeNull();
    const left = findClip(project, clipId)!.clip;
    const right = findClip(project, rightId!)!.clip;
    expect(left.srcOut).toBeCloseTo(right.srcIn, 12);
    expect(clipEnd(left)).toBeCloseTo(right.timelineStart, 12);
    expectClean(project);
  });

  it("zeroes the fades at the cut", () => {
    let { p, clipId } = baseProject();
    p = {
      ...p,
      timeline: {
        ...p.timeline,
        tracks: p.timeline.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, audio: { ...c.audio, fadeInSec: 1, fadeOutSec: 1 } } : c,
          ),
        })),
      },
    };
    const { project, rightId } = splitClip(p, clipId, 20);
    const left = findClip(project, clipId)!.clip;
    const right = findClip(project, rightId!)!.clip;
    expect(left.audio.fadeInSec).toBe(1);
    expect(left.audio.fadeOutSec).toBe(0);
    expect(right.audio.fadeInSec).toBe(0);
    expect(right.audio.fadeOutSec).toBe(1);
  });

  it("refuses to split at the very edges", () => {
    const { p, clipId } = baseProject();
    expect(splitClip(p, clipId, 0).rightId).toBeNull();
    expect(splitClip(p, clipId, 60).rightId).toBeNull();
  });
});

describe("ripple delete", () => {
  it("closes the gap across all tracks", () => {
    let { p, mediaId, clipId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const videoTrack = p.timeline.tracks[0]!.id;

    // second video clip after the first
    const c2 = makeClip(media, 60);
    p = insertClip(p, videoTrack, c2);

    // audio clip starting at 70
    const at = addAudioTrack(p);
    p = at.project;
    const am = addMedia(p, audioInfo());
    p = am.project;
    const ac = makeClip(am.media, 70);
    p = insertClip(p, at.trackId, ac);

    // ripple-delete the first 60s clip → everything shifts left by 60
    p = rippleDelete(p, clipId);
    expectClean(p);
    expect(findClip(p, c2.id)!.clip.timelineStart).toBe(0);
    expect(findClip(p, ac.id)!.clip.timelineStart).toBe(10);
  });

  it("plain remove leaves the gap", () => {
    let { p, mediaId, clipId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const c2 = makeClip(media, 60);
    p = insertClip(p, p.timeline.tracks[0]!.id, c2);
    p = removeClip(p, clipId);
    expect(findClip(p, c2.id)!.clip.timelineStart).toBe(60);
    expectClean(p);
  });
});

describe("speed", () => {
  it("clamps into range and trims to fit before a neighbour", () => {
    let { p, mediaId, clipId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const c2 = makeClip(media, 60);
    p = insertClip(p, p.timeline.tracks[0]!.id, c2);
    // slowing to 0.5 would need 120s but only 60 available → srcOut trimmed
    p = setClipSpeed(p, clipId, 0.5);
    const c = findClip(p, clipId)!.clip;
    expect(c.speed).toBe(0.5);
    expect(clipDuration(c)).toBeLessThanOrEqual(60 + 1e-9);
    expectClean(p);
  });
});

describe("markers", () => {
  it("inserts keeping sorted order", () => {
    let { p } = baseProject();
    p = addMarkerAt(p, 30).project;
    p = addMarkerAt(p, 10, 2).project;
    p = addMarkerAt(p, 20).project;
    expect(p.timeline.markers!.map((m) => m.t)).toEqual([10, 20, 30]);
    expect(p.timeline.markers!.find((m) => m.t === 10)!.color).toBe(2);
    expectClean(p);
  });

  it("moveMarkerTo re-sorts", () => {
    let { p } = baseProject();
    const a = addMarkerAt(p, 5);
    p = a.project;
    p = addMarkerAt(p, 15).project;
    p = moveMarkerTo(p, a.markerId, 25);
    expect(p.timeline.markers!.map((m) => m.t)).toEqual([15, 25]);
    expectClean(p);
  });

  it("removeMarker drops it", () => {
    let { p } = baseProject();
    const a = addMarkerAt(p, 5);
    p = a.project;
    p = removeMarker(p, a.markerId);
    expect(p.timeline.markers).toHaveLength(0);
    expectClean(p);
  });
});

describe("video tracks", () => {
  it("addVideoTrack unshifts a topmost layer", () => {
    let { p } = baseProject();
    const original = topVideoTrack(p).id;
    const r = addVideoTrack(p);
    p = r.project;
    expect(topVideoTrack(p).id).toBe(r.trackId);
    expect(p.timeline.tracks[1]!.id).toBe(original);
    expect(videoTracks(p)).toHaveLength(2);
    expect(topVideoTrack(p).name).toBe("Video 2");
    expectClean(p);
  });

  it("removeTrack: last video not removable", () => {
    const { p } = baseProject();
    const only = topVideoTrack(p).id;
    expect(removeTrack(p, only)).toBe(p);
    expectClean(removeTrack(p, only));
  });

  it("removeTrack: non-empty video not removable, empty extra video removable", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const r = addVideoTrack(p);
    p = r.project;
    // put a clip on the new top track → not removable
    p = insertClip(p, r.trackId, makeClip(media, 0));
    expect(removeTrack(p, r.trackId)).toBe(p);
    // clear it → removable now (2 video tracks exist)
    p = removeClip(p, findClip(p, topVideoTrack(p).clips[0]!.id)!.clip.id);
    const removed = removeTrack(p, r.trackId);
    expect(videoTracks(removed)).toHaveLength(1);
    expectClean(removed);
  });

  it("moveClip crosses video tracks", () => {
    let { p, clipId } = baseProject();
    const r = addVideoTrack(p);
    p = r.project;
    p = moveClip(p, clipId, 0, r.trackId);
    expect(findClip(p, clipId)!.track.id).toBe(r.trackId);
    expectClean(p);
  });
});

describe("project canvas", () => {
  it("clamps to even integers within bounds", () => {
    const { p } = baseProject();
    let q = setProjectCanvas(p, 1921, 1081);
    expect(q.timeline.width % 2).toBe(0);
    expect(q.timeline.height % 2).toBe(0);
    q = setProjectCanvas(p, 4, 99999);
    expect(q.timeline.width).toBe(16);
    expect(q.timeline.height).toBe(8192);
    expectClean(q);
  });

  it("no-op when unchanged (same reference)", () => {
    const { p } = baseProject();
    const same = setProjectCanvas(p, p.timeline.width, p.timeline.height);
    expect(same).toBe(p);
  });
});

describe("keyframes", () => {
  it("setKeyframe upserts and dedupes within eps", () => {
    let { p, clipId } = baseProject();
    p = setKeyframe(p, clipId, "opacity", 1, 0.5);
    p = setKeyframe(p, clipId, "opacity", 1 + EPS_KF / 2, 0.8);
    const kfs = findClip(p, clipId)!.clip.keyframes!.opacity!;
    expect(kfs).toHaveLength(1);
    expect(kfs[0]!.v).toBe(0.8);
    expectClean(p);
  });

  it("setPositionKeyframes keeps x/y paired", () => {
    let { p, clipId } = baseProject();
    p = setPositionKeyframes(p, clipId, 0, 10, 20);
    p = setPositionKeyframes(p, clipId, 5, 30, 40);
    const kf = findClip(p, clipId)!.clip.keyframes!;
    expect(kf.x!.map((k) => k.t)).toEqual(kf.y!.map((k) => k.t));
    expect(kf.x).toHaveLength(2);
    expectClean(p);
  });

  it("removeKeyframesNear empties keys and the object", () => {
    let { p, clipId } = baseProject();
    p = setPositionKeyframes(p, clipId, 3, 10, 20);
    // removing the sole position keyframe drops x, y, and the whole object
    p = removeKeyframesNear(p, clipId, "position", 3);
    expect(findClip(p, clipId)!.clip.keyframes).toBeUndefined();
    expectClean(p);
  });

  it("clearAnimation bakes values into transform", () => {
    let { p, clipId } = baseProject();
    p = setKeyframe(p, clipId, "scale", 0, 1);
    p = setKeyframe(p, clipId, "scale", 5, 2);
    p = clearAnimation(p, clipId, "scale", { scale: 1.5 });
    const c = findClip(p, clipId)!.clip;
    expect(c.keyframes).toBeUndefined();
    expect(c.transform!.scale).toBe(1.5);
    expectClean(p);
  });
});

describe("media", () => {
  it("removeMediaCascade clears clips across multiple tracks", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    // second video track with another clip of the same media
    const r = addVideoTrack(p);
    p = r.project;
    p = insertClip(p, r.trackId, makeClip(media, 0));
    // audio clip of a different media stays
    const at = addAudioTrack(p);
    p = at.project;
    const am = addMedia(p, audioInfo());
    p = am.project;
    p = insertClip(p, at.trackId, makeClip(am.media, 0));

    p = removeMediaCascade(p, mediaId);
    expect(p.media.find((m) => m.id === mediaId)).toBeUndefined();
    const remaining = p.timeline.tracks.flatMap((t) => t.clips);
    expect(remaining.every((c) => c.mediaId !== mediaId)).toBe(true);
    expect(remaining).toHaveLength(1); // only the audio clip survives
    expectClean(p);
  });

  it("addGeneratedMedia does not adopt project resolution", () => {
    const p = createProject("Gen");
    const gen: Generator = {
      type: "text",
      text: "Hi",
      fontFamily: "Arial",
      sizePx: 96,
      color: "#ffffff",
      bold: false,
      italic: false,
    };
    const r = addGeneratedMedia(p, gen, 400, 200, "Text: Hi");
    expect(r.media.kind).toBe("image");
    expect(r.media.width).toBe(400);
    expect(r.media.generator).toEqual(gen);
    // project canvas unchanged (unlike addMedia's first-visual adoption)
    expect(r.project.timeline.width).toBe(1920);
    expectClean(r.project);
  });
});

/* ------------------------------------------------------------------ */
/* Fuzz: 1000 random ops keep invariants; undo-all restores initial    */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fuzz", () => {
  it("1000 random ops preserve invariants and undo-all restores the initial state", () => {
    const rnd = mulberry32(0x7a2071);
    let { p } = baseProject();
    const am = addMedia(p, audioInfo());
    p = am.project;
    const at = addAudioTrack(p);
    p = at.project;
    // start with a second video track so cross-video-track moves are exercised
    p = addVideoTrack(p).project;
    const initial = p;

    const history = new History<ProjectFile>();
    const allClips = (proj: ProjectFile) =>
      proj.timeline.tracks.flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })));

    for (let i = 0; i < 1000; i++) {
      const before = p;
      const clips = allClips(p);
      const pick = clips.length ? clips[Math.floor(rnd() * clips.length)] : undefined;
      const op = Math.floor(rnd() * 12);
      let next = p;
      switch (op) {
        case 0: {
          // insert a clip from a random media on a fitting track
          const media = p.media[Math.floor(rnd() * p.media.length)]!;
          const c = makeClip(media, rnd() * 300);
          // shorten so the timeline doesn't grow unbounded
          c.srcOut = Math.min(c.srcOut, c.srcIn + 1 + rnd() * 10);
          const targetTracks = p.timeline.tracks.filter((t) =>
            media.kind === "audio" ? t.kind === "audio" : t.kind === "video",
          );
          const track = targetTracks[Math.floor(rnd() * targetTracks.length)]!;
          next = insertClip(p, track.id, c);
          break;
        }
        case 1:
          if (pick) {
            // sometimes move to another track of the same kind (incl. video↔video)
            const sameKind = p.timeline.tracks.filter((t) => t.kind === pick.track.kind);
            const dest = sameKind[Math.floor(rnd() * sameKind.length)]!;
            next = moveClip(p, pick.clip.id, rnd() * 300, dest.id);
          }
          break;
        case 2:
          if (pick)
            next = trimClip(
              p,
              pick.clip.id,
              rnd() < 0.5 ? "in" : "out",
              pick.clip.timelineStart + (rnd() - 0.25) * 20,
            );
          break;
        case 3:
          if (pick) {
            const at2 =
              pick.clip.timelineStart + rnd() * clipDuration(pick.clip);
            next = splitClip(p, pick.clip.id, at2).project;
          }
          break;
        case 4:
          if (pick) next = removeClip(p, pick.clip.id);
          break;
        case 5:
          if (pick) next = rippleDelete(p, pick.clip.id);
          break;
        case 6:
          if (pick) next = setClipSpeed(p, pick.clip.id, 0.25 + rnd() * 3.75);
          break;
        case 7:
          // add a video track, but cap growth so the timeline stays bounded
          if (videoTracks(p).length < 4) next = addVideoTrack(p).project;
          break;
        case 8:
          next = addMarkerAt(p, rnd() * 300, Math.floor(rnd() * 6)).project;
          break;
        case 9: {
          const ms = p.timeline.markers ?? [];
          if (ms.length) next = removeMarker(p, ms[Math.floor(rnd() * ms.length)]!.id);
          break;
        }
        case 10:
          if (pick && pick.clip.transform) {
            // key a source time within the clip's source range
            const s = pick.clip.srcIn + rnd() * (pick.clip.srcOut - pick.clip.srcIn);
            const which = Math.floor(rnd() * 3);
            if (which === 0) next = setPositionKeyframes(p, pick.clip.id, s, rnd() * 100 - 50, rnd() * 100 - 50);
            else if (which === 1) next = setKeyframe(p, pick.clip.id, "scale", s, 0.1 + rnd() * 3.9);
            else next = setKeyframe(p, pick.clip.id, "opacity", s, rnd());
          }
          break;
        case 11:
          if (pick && pick.clip.keyframes) {
            const groups = ["position", "scale", "opacity"] as const;
            const g = groups[Math.floor(rnd() * groups.length)]!;
            const s = pick.clip.srcIn + rnd() * (pick.clip.srcOut - pick.clip.srcIn);
            next = removeKeyframesNear(p, pick.clip.id, g, s);
          }
          break;
      }
      if (next !== p) {
        history.push(before);
        p = next;
      }
      const errors = checkInvariants(p);
      if (errors.length) {
        throw new Error(`invariants broken after op ${op} @ ${i}: ${errors.join("; ")}`);
      }
    }

    while (history.canUndo) {
      p = history.undo(p)!;
    }
    expect(p).toEqual(initial);
  });
});

describe("audio detach / remove", () => {
  it("detaches into an aligned audio clip, invariants hold", () => {
    const { p, clipId } = baseProject();
    const src = findClip(p, clipId)!.clip;
    const { project, audioClipId } = detachAudio(p, clipId);
    expect(audioClipId).not.toBeNull();
    expectClean(project);

    // source clip is now detached
    expect(findClip(project, clipId)!.clip.audio.detached).toBe(true);

    // new clip is on an audio track, aligned, sharing source params
    const found = findClip(project, audioClipId!)!;
    expect(found.track.kind).toBe("audio");
    expect(found.clip.timelineStart).toBeCloseTo(src.timelineStart, 6);
    expect(found.clip.srcIn).toBe(src.srcIn);
    expect(found.clip.srcOut).toBe(src.srcOut);
    expect(found.clip.speed).toBe(src.speed);
    expect(found.clip.mediaId).toBe(src.mediaId);
    expect(found.clip.audio.detached).toBe(false);
    expect(found.clip.transform).toBeUndefined();
  });

  it("detaching twice is a no-op", () => {
    const { p, clipId } = baseProject();
    const once = detachAudio(p, clipId);
    const twice = detachAudio(once.project, clipId);
    expect(twice.audioClipId).toBeNull();
    expect(twice.project).toBe(once.project);
  });

  it("detach uses a new track when the first is occupied at that position", () => {
    let { p, clipId } = baseProject();
    // occupy an audio track at [0..60) so the detached clip can't align there
    const media = p.media.find((m) => m.kind === "video")!;
    const at = addAudioTrack(p);
    p = at.project;
    const blocker = makeClip(media, 0);
    p = insertClip(p, at.trackId, blocker);

    const before = p.timeline.tracks.filter((t) => t.kind === "audio").length;
    const { project, audioClipId } = detachAudio(p, clipId);
    const after = project.timeline.tracks.filter((t) => t.kind === "audio").length;
    expect(after).toBe(before + 1);
    const found = findClip(project, audioClipId!)!;
    expect(found.clip.timelineStart).toBeCloseTo(0, 6);
    expect(found.track.id).not.toBe(at.trackId);
    expectClean(project);
  });

  it("removeClipAudio marks detached and round-trips", () => {
    const { p, clipId } = baseProject();
    const removed = removeClipAudio(p, clipId);
    expect(findClip(removed, clipId)!.clip.audio.detached).toBe(true);
    expectClean(removed);
    // already detached → no-op (same reference)
    expect(removeClipAudio(removed, clipId)).toBe(removed);
  });
});
