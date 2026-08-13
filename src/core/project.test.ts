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
  defaultAudio,
  defaultTransform,
  detachAudio,
  findClip,
  findTrack,
  fitFillScale,
  insertClip,
  MAX_CANVAS,
  MIN_CANVAS,
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
  sanitizeProject,
  setClipSpeed,
  setKeyframe,
  setPositionKeyframes,
  setProjectCanvas,
  splitClip,
  topVideoTrack,
  trimClip,
  updateClip,
  videoTracks,
} from "./project";
import { EPS_KF } from "./anim";
import { clipDuration, clipEnd, fpsValue, rat, snapToFrame, timelineDuration } from "./time";
import type { Clip, Generator, MediaInfo, ProjectFile } from "./types";

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

  /**
   * The version stamp is a claim about the MEDIA in the file: schema 2 means
   * "these width/height values are display-oriented". A project created today
   * records them from `probe_media`, which reads the display matrix, so the
   * claim is true the moment the file exists — and stamping 1 would ask the
   * Rust loader (gated on `ROTATION_REPAIR_SCHEMA`, project/schema.rs) to
   * ffprobe every video in the project on its first open, then rewrite the
   * file, only to find nothing to correct.
   */
  it("stamps a new project at the schema its media already satisfies", () => {
    expect(createProject("New").schema).toBe(2);
  });

  it("never restamps a project it did not create", () => {
    // `sanitizeProject` repairs VALUES. The version is the loader's business —
    // `migrate` and the rotation re-probe are both keyed off it — so a file
    // that arrives claiming 1 has to come out claiming 1, or the one pass that
    // corrects a sideways phone recording is skipped for good.
    const old: ProjectFile = { ...createProject("Old"), schema: 1 };
    expect(sanitizeProject(old).schema).toBe(1);
  });

  it("adopts resolution + fps from the first visual media", () => {
    let p = createProject("New");
    p = addMedia(p, videoInfo()).project;
    expect(p.timeline.width).toBe(1280);
    expect(p.timeline.height).toBe(720);
    expect(p.timeline.fps).toEqual(rat(30));
    expectClean(p);
  });

  it("clamps adopted odd dimensions to an even, in-range canvas", () => {
    let p = createProject("New");
    const gifInfo: MediaInfo = {
      path: "C:\\media\\odd.gif",
      size: 100,
      mtimeMs: 3,
      kind: "gif",
      duration: 2,
      fps: rat(15),
      width: 301,
      height: 201,
      hasAudio: false,
    };
    p = addMedia(p, gifInfo).project;
    expect(p.timeline.width).toBe(302);
    expect(p.timeline.height).toBe(202);
    expect(p.timeline.width % 2).toBe(0);
    expect(p.timeline.height % 2).toBe(0);
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

  it("removeTrack: non-empty video not removable without force, empty extra video removable", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const r = addVideoTrack(p);
    p = r.project;
    // put a clip on the new top track → not removable without force
    p = insertClip(p, r.trackId, makeClip(media, 0));
    expect(removeTrack(p, r.trackId)).toBe(p);
    // clear it → removable now (2 video tracks exist)
    p = removeClip(p, findClip(p, topVideoTrack(p).clips[0]!.id)!.clip.id);
    const removed = removeTrack(p, r.trackId);
    expect(videoTracks(removed)).toHaveLength(1);
    expectClean(removed);
  });

  it("removeTrack force: removes a non-empty video track WITH its clips", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const r = addVideoTrack(p);
    p = r.project;
    p = insertClip(p, r.trackId, makeClip(media, 0));
    const clipId = findTrack(p, r.trackId)!.clips[0]!.id;
    const removed = removeTrack(p, r.trackId, { force: true });
    expect(findTrack(removed, r.trackId)).toBeUndefined();
    expect(findClip(removed, clipId)).toBeUndefined();
    expect(videoTracks(removed)).toHaveLength(1);
    expectClean(removed);
  });

  it("removeTrack: last video refused even with force", () => {
    const { p } = baseProject();
    const only = topVideoTrack(p).id;
    expect(removeTrack(p, only, { force: true })).toBe(p);
    expectClean(removeTrack(p, only, { force: true }));
  });

  it("removeTrack: surviving video tracks stay a contiguous prefix", () => {
    let { p } = baseProject();
    // three video tracks then an audio track (contiguous prefix precondition)
    p = addVideoTrack(p).project;
    const mid = addVideoTrack(p);
    p = mid.project; // tracks: [V?, mid, V?, ...] — mid is tracks[0], remove a middle one
    const at = addAudioTrack(p);
    p = at.project;
    // remove the middle video track (index 1)
    const midVideoId = p.timeline.tracks[1]!.id;
    const removed = removeTrack(p, midVideoId);
    expect(videoTracks(removed)).toHaveLength(2);
    expectClean(removed); // checkInvariants asserts tracks[0] video + contiguity
    expect(removed.timeline.tracks.at(-1)!.kind).toBe("audio");
  });

  it("removeTrack force: undo round-trip restores the track AND its clips exactly", () => {
    let { p, mediaId } = baseProject();
    const media = p.media.find((m) => m.id === mediaId)!;
    const r = addVideoTrack(p);
    p = r.project;
    p = insertClip(p, r.trackId, makeClip(media, 0));
    const before = p;

    const history = new History<ProjectFile>();
    history.push(before);
    p = removeTrack(p, r.trackId, { force: true });
    expect(findTrack(p, r.trackId)).toBeUndefined();
    expectClean(p);

    p = history.undo(p)!;
    expect(p).toEqual(before);
    expect(findTrack(p, r.trackId)!.clips).toHaveLength(1);
    expectClean(p);
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

describe("fitFillScale", () => {
  it("fit is always 1 for same-aspect landscape media", () => {
    // 1280x720 into 1920x1080 (both 16:9): fit letterboxes exactly -> scale 1.
    expect(fitFillScale(1280, 720, undefined, 1920, 1080, "fit")).toBeCloseTo(1, 6);
    // fill on matching aspect adds no extra scale.
    expect(fitFillScale(1280, 720, undefined, 1920, 1080, "fill")).toBeCloseTo(1, 6);
  });

  it("fill covers the canvas for landscape media on a portrait canvas", () => {
    // sx = 1080/1280, sy = 1920/720 -> fill = max/min.
    const sx = 1080 / 1280;
    const sy = 1920 / 720;
    expect(fitFillScale(1280, 720, undefined, 1080, 1920, "fill")).toBeCloseTo(
      Math.max(sx, sy) / Math.min(sx, sy),
      6,
    );
    // fit stays 1 regardless of aspect mismatch.
    expect(fitFillScale(1280, 720, undefined, 1080, 1920, "fit")).toBeCloseTo(1, 6);
  });

  it("fill covers the canvas for portrait media on a landscape canvas", () => {
    const sx = 1920 / 720;
    const sy = 1080 / 1280;
    expect(fitFillScale(720, 1280, undefined, 1920, 1080, "fill")).toBeCloseTo(
      Math.max(sx, sy) / Math.min(sx, sy),
      6,
    );
  });

  it("uses the cropped (visible) region, not the full frame", () => {
    // crop 500x250 out of a 1000x1000 frame into a 1000x1000 canvas.
    const crop = { x: 0, y: 0, w: 500, h: 250 };
    // fitW=500, fitH=250 -> sx=2, sy=4 -> fill = 4/2 = 2.
    expect(fitFillScale(1000, 1000, crop, 1000, 1000, "fill")).toBeCloseTo(2, 6);
    expect(fitFillScale(1000, 1000, crop, 1000, 1000, "fit")).toBeCloseTo(1, 6);
  });

  it("clamps a crop that overhangs the frame to the visible extent", () => {
    // crop.x=600 with w=800 -> visible cropW = min(800, 1000-600) = 400.
    const crop = { x: 600, y: 0, w: 800, h: 1000 };
    // fitW=400, fitH=1000 -> sx=2.5, sy=1 -> fill = 2.5.
    expect(fitFillScale(1000, 1000, crop, 1000, 1000, "fill")).toBeCloseTo(2.5, 6);
  });

  it("swaps width/height under 90/270 rotation", () => {
    // 1280x720 rotated 90 into 1920x1080: fitW=720, fitH=1280.
    const sx = 1920 / 720;
    const sy = 1080 / 1280;
    const expected = Math.max(sx, sy) / Math.min(sx, sy);
    expect(fitFillScale(1280, 720, undefined, 1920, 1080, "fill", 90)).toBeCloseTo(expected, 6);
    expect(fitFillScale(1280, 720, undefined, 1920, 1080, "fill", 270)).toBeCloseTo(expected, 6);
    // 180 keeps the axes, so it matches the unrotated result.
    expect(fitFillScale(1280, 720, undefined, 1920, 1080, "fill", 180)).toBeCloseTo(
      fitFillScale(1280, 720, undefined, 1920, 1080, "fill", 0),
      6,
    );
  });

  it("clamps fill to MAX_SCALE for extreme aspect ratios", () => {
    // 4000x100 into 100x4000: raw fill would be 1600, clamp to 4.
    expect(fitFillScale(4000, 100, undefined, 100, 4000, "fill")).toBeCloseTo(4, 6);
  });

  it("guards against zero/degenerate media dimensions", () => {
    // Falls back to 1px min for width/height; must return a finite scale.
    const v = fitFillScale(0, 0, undefined, 1920, 1080, "fit");
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(1, 6);
    const f = fitFillScale(0, 0, undefined, 1920, 1080, "fill");
    expect(Number.isFinite(f)).toBe(true);
  });
});

/**
 * `load_project` hands the frontend the RAW json — the typed Rust struct it
 * deserializes on the way past feeds only the missing-media scan and the recents
 * stamp — so `de_speed` in `schema.rs` protects the EXPORT path and nothing
 * else, and `save_project` writes the raw value back unrepaired. Every value
 * below therefore reached `ProjectSession` unexamined, and `checkInvariants` is
 * test-only, so nothing at runtime ever looked.
 *
 * The rule under test is narrow on purpose: repair values with NO honest
 * meaning, leave legal-but-unusual ones exactly as authored. Anything repaired
 * here is a divergence from the file on disk until the session's next write, so
 * it is confined to values whose alternative is `inf`/`nan` reaching ffmpeg.
 */
describe("sanitizeProject", () => {
  /** The single clip of `baseProject`, hand-edited to `patch` and sanitized. */
  function withClip(patch: Partial<Clip>): { p: ProjectFile; clip: () => Clip } {
    const { p, clipId } = baseProject();
    const out = sanitizeProject(updateClip(p, clipId, patch));
    return { p: out, clip: () => findClip(out, clipId)!.clip };
  }

  /* ---- the one structural repair: there must be a video track at index 0 ---- */

  it("restores a video track when the timeline has none, so import cannot crash", () => {
    // `topVideoTrack` is `tracks[0]!`. An empty array makes it undefined and the
    // first `.id` throws — a hard crash importing a hand-edited or truncated
    // .trt, which is this app's main threat surface.
    const { p } = baseProject();
    const out = sanitizeProject({ ...p, timeline: { ...p.timeline, tracks: [] } });
    expect(out.timeline.tracks).toHaveLength(1);
    expect(out.timeline.tracks[0]!.kind).toBe("video");
    expect(() => topVideoTrack(out).id).not.toThrow();
  });

  it("puts a video track in front of an audio-only timeline, keeping the audio", () => {
    // The subtler half: with only audio tracks, `tracks[0]` IS a track, so
    // nothing throws — `topVideoTrack` just silently hands back an AUDIO track
    // and an imported clip lands on a lane that cannot show it.
    const { p } = baseProject();
    const audio = { id: "a1", kind: "audio" as const, name: "Audio 1", muted: false, clips: [] };
    const out = sanitizeProject({ ...p, timeline: { ...p.timeline, tracks: [audio] } });
    expect(out.timeline.tracks).toHaveLength(2);
    expect(out.timeline.tracks[0]!.kind).toBe("video");
    expect(out.timeline.tracks[1]).toBe(audio);
    expect(topVideoTrack(out).kind).toBe("video");
  });

  it("leaves a healthy track list untouched, by reference", () => {
    // The repair must not cost a healthy open an allocation, and must not
    // reorder tracks that were already correct.
    const { p } = baseProject();
    expect(sanitizeProject(p)).toBe(p);
  });

  /* ---- speed: the confirmed bug, and the shape of the fix ---- */

  it("normalises a speed that cannot divide, exactly as de_speed does", () => {
    for (const speed of [0, -1, -0.5, NaN, Infinity, -Infinity]) {
      expect(withClip({ speed }).clip().speed).toBe(1);
    }
  });

  it("gives the editor a finite clip duration for a speed:0 file", () => {
    const { p, clip } = withClip({ speed: 0 });
    // Before: (60 - 0) / 0 = Infinity in the editor, while the export path's
    // typed struct saw de_speed's 1.0 and computed 60 — a silent preview/export
    // disagreement about how long the clip is.
    expect(clipDuration(clip())).toBe(60);
    expect(Number.isFinite(clipEnd(clip()))).toBe(true);
    // …and the second-order failure: an infinite timelineDuration serialises to
    // JSON `null`, and the export dialog's estimate input types it as a number.
    expect(JSON.parse(JSON.stringify({ d: timelineDuration(p.timeline) })).d).toBe(60);
  });

  it("leaves a legal-but-out-of-range speed alone, so it stays in step with Rust", () => {
    // 8 is outside the editor's [0.25, 4] but works, and is what the video chain
    // will render. Clamping it here would change a project that plays fine.
    expect(withClip({ speed: 8 }).clip().speed).toBe(8);
    expect(withClip({ speed: 0.1 }).clip().speed).toBe(0.1);
  });

  it("catches the one bad speed that survives Rust too: an unrepresentable duration", () => {
    // Finite and positive, so de_speed keeps it — and (60 - 0) / 5e-324 is
    // Infinity on both sides of the wire.
    const { clip } = withClip({ speed: 5e-324 });
    expect(clip().speed).toBe(1);
    expect(Number.isFinite(clipDuration(clip()))).toBe(true);
  });

  /* ---- the other numbers that reach arithmetic or ffmpeg ---- */

  it("repairs source and timeline times", () => {
    expect(withClip({ srcIn: -5 }).clip().srcIn).toBe(0);
    expect(withClip({ srcIn: NaN }).clip().srcIn).toBe(0);
    expect(withClip({ timelineStart: -3 }).clip().timelineStart).toBe(0);
    expect(withClip({ timelineStart: Infinity }).clip().timelineStart).toBe(0);
    // srcOut must leave the clip a positive length: a reversed or infinite
    // out-point gives clipDuration a negative or non-finite value, and both
    // reach ffmpeg's `-t`.
    const reversed = withClip({ srcIn: 10, srcOut: 4 }).clip();
    expect(reversed.srcOut).toBeGreaterThan(reversed.srcIn);
    for (const c of [
      withClip({ srcOut: Infinity }).clip(),
      withClip({ srcOut: NaN }).clip(),
      withClip({ srcIn: 1e308, srcOut: NaN }).clip(), // adding a frame does not move srcIn
      withClip({ srcIn: -Infinity, srcOut: -Infinity }).clip(),
    ]) {
      expect(clipDuration(c)).toBeGreaterThan(0);
      expect(Number.isFinite(clipEnd(c))).toBe(true);
    }
  });

  it("repairs the canvas, which u32 lets through as zero", () => {
    const { p } = baseProject();
    const zero = sanitizeProject({ ...p, timeline: { ...p.timeline, width: 0, height: 0 } });
    expect(zero.timeline.width).toBe(MIN_CANVAS);
    expect(zero.timeline.height).toBe(MIN_CANVAS);
    const huge = sanitizeProject({
      ...p,
      timeline: { ...p.timeline, width: 100000, height: NaN },
    });
    expect(huge.timeline.width).toBe(MAX_CANVAS);
    expect(Number.isInteger(huge.timeline.height)).toBe(true);
    expect(huge.timeline.height % 2).toBe(0);
  });

  it("repairs an fps whose denominator is zero", () => {
    // `Rational` is a u32 pair, so a zero den parses fine — and then fpsValue is
    // Infinity, frameOf returns Infinity and snapToFrame returns NaN, which is
    // the playhead, the ruler and the exporter's `-r` all at once.
    const { p } = baseProject();
    for (const fps of [rat(30, 0), rat(0, 1), { num: NaN, den: 1 }]) {
      const out = sanitizeProject({ ...p, timeline: { ...p.timeline, fps } });
      expect(fpsValue(out.timeline.fps)).toBe(30);
      expect(Number.isFinite(snapToFrame(1.234, out.timeline.fps))).toBe(true);
    }
    // A legitimate NTSC rate is untouched.
    const ntsc = sanitizeProject({ ...p, timeline: { ...p.timeline, fps: rat(30000, 1001) } });
    expect(ntsc.timeline.fps).toEqual(rat(30000, 1001));
  });

  it("repairs keyframe times and values", () => {
    const kfs = {
      // one unplaceable, one uninterpolable, and a descending pair
      x: [{ t: 0, v: 0 }, { t: NaN, v: 5 }, { t: 2, v: Infinity }, { t: 1, v: 10 }],
      opacity: [],
      scale: [{ t: 0, v: 1 }],
    };
    const out = withClip({ keyframes: kfs }).clip().keyframes!;
    expect(out.x).toEqual([{ t: 0, v: 0 }, { t: 1, v: 10 }]);
    // An empty array is a violation rather than an absence — writeKeyframes
    // strips them, and a consumer that gates on truthiness alone hands one to
    // evalKfs, which throws.
    expect(out.opacity).toBeUndefined();
    expect(out.scale).toEqual([{ t: 0, v: 1 }]);
    // …and a keyframes object with nothing left in it disappears entirely.
    expect(withClip({ keyframes: { x: [{ t: NaN, v: 1 }] } }).clip().keyframes).toBeUndefined();
  });

  it("repairs audio gains and fades", () => {
    const a = defaultAudio();
    // The preview graph applies Math.max(0, volume); the exporter passes the
    // negative straight into `volume=`. That is a live preview/export
    // disagreement, not merely an odd number.
    expect(withClip({ audio: { ...a, volume: -2 } }).clip().audio.volume).toBe(0);
    expect(withClip({ audio: { ...a, volume: NaN } }).clip().audio.volume).toBe(1);
    expect(withClip({ audio: { ...a, gainOffsetDb: NaN } }).clip().audio.gainOffsetDb).toBe(0);
    expect(withClip({ audio: { ...a, fadeInSec: -1 } }).clip().audio.fadeInSec).toBe(0);
    expect(withClip({ audio: { ...a, fadeOutSec: Infinity } }).clip().audio.fadeOutSec).toBe(0);
    // Both sinks multiply the pair: a GainNode THROWS on a non-finite
    // assignment, and ffmpeg is handed the literal `inf`.
    const loud = withClip({ audio: { ...a, gainOffsetDb: 99999 } }).clip().audio;
    expect(Number.isFinite(loud.volume * 10 ** (loud.gainOffsetDb / 20))).toBe(true);
    // A real Normalize result is left exactly as the scan set it.
    expect(withClip({ audio: { ...a, gainOffsetDb: -6.2 } }).clip().audio.gainOffsetDb).toBe(-6.2);
  });

  it("repairs transform values that would print as nan in a filter graph", () => {
    const t = defaultTransform();
    expect(withClip({ transform: { ...t, scale: 0 } }).clip().transform!.scale).toBe(1);
    expect(withClip({ transform: { ...t, scale: NaN } }).clip().transform!.scale).toBe(1);
    expect(withClip({ transform: { ...t, x: Infinity } }).clip().transform!.x).toBe(0);
    expect(withClip({ transform: { ...t, opacity: NaN } }).clip().transform!.opacity).toBe(1);
    // `rotate` is u32 in the schema but 0|90|180|270 everywhere it is read.
    const odd = { ...t, rotate: 37 as unknown as 0 };
    expect(withClip({ transform: odd }).clip().transform!.rotate).toBe(0);
    expect(withClip({ transform: { ...t, rotate: 270 } }).clip().transform!.rotate).toBe(270);
    // A crop that cannot describe a rectangle becomes NO crop — the identity —
    // rather than a guessed-at region.
    const bad = { ...t, crop: { x: 0, y: 0, w: NaN, h: 100 } };
    expect(withClip({ transform: bad }).clip().transform!.crop).toBeUndefined();
    const good = { ...t, crop: { x: 10, y: 10, w: 100, h: 50 } };
    expect(withClip({ transform: good }).clip().transform!.crop).toEqual(good.crop);
  });

  it("drops a marker that cannot be placed on the ruler", () => {
    let { p } = baseProject();
    p = addMarkerAt(p, 5).project;
    p = addMarkerAt(p, NaN).project;
    const out = sanitizeProject(p);
    expect(out.timeline.markers).toHaveLength(1);
    expect(out.timeline.markers![0]!.t).toBe(5);
  });

  it("clears a non-finite media duration, which reaches ffmpeg as a job argument", () => {
    const { p } = baseProject();
    const out = sanitizeProject({
      ...p,
      media: p.media.map((m) => ({ ...m, duration: Infinity })),
    });
    expect(out.media[0]!.duration).toBe(0);
  });

  /* ---- what it costs, and what it guarantees ---- */

  it("returns the very same project when nothing needs repair", () => {
    const { p } = baseProject();
    // Reference identity, not deep equality: this runs on every project open,
    // and ProjectSession compares references to decide whether anything changed.
    expect(sanitizeProject(p)).toBe(p);
    const marked = addMarkerAt(p, 5).project;
    expect(sanitizeProject(marked)).toBe(marked);
  });

  it("leaves a repaired project passing the invariant check", () => {
    const { p, clipId } = baseProject();
    const hostile = updateClip(p, clipId, {
      speed: 0,
      srcIn: -1,
      timelineStart: -2,
      audio: { ...defaultAudio(), volume: NaN, fadeInSec: -1 },
      transform: { ...defaultTransform(), scale: 0, opacity: NaN },
      keyframes: { x: [{ t: NaN, v: 0 }] },
    });
    expect(checkInvariants(hostile).length).toBeGreaterThan(0);
    expect(checkInvariants(sanitizeProject(hostile))).toEqual([]);
  });
});

/**
 * A drag that moves nothing must not become an undo step.
 *
 * `moveClip` always returned a fresh reference, and `session.commit` reads a new
 * reference as "something changed" — so it pushed a history entry for a drag
 * that ended exactly where it began. With snapping on that is the NORMAL outcome
 * of nudging a clip against its neighbour, so the first Ctrl+Z after a nudge
 * appeared to do nothing at all.
 *
 * The comparison has to be against the RESOLVED start, not the requested one:
 * the two differ whenever the requested span is occupied, which is the whole
 * reason the mutator exists.
 */
describe("moveClip no-op detection", () => {
  /** One 60s media, two back-to-back clips on the video track: [0,60) [60,120). */
  function twoClips(): { p: ProjectFile; trackId: string; aId: string; bId: string } {
    let p = createProject("Test");
    const added = addMedia(p, videoInfo());
    p = added.project;
    const trackId = p.timeline.tracks[0]!.id;
    const a = makeClip(added.media, 0);
    p = insertClip(p, trackId, a);
    const b = makeClip(added.media, 60);
    p = insertClip(p, trackId, b);
    return { p, trackId, aId: a.id, bId: b.id };
  }

  it("returns the same project when the clip is asked for the start it already has", () => {
    const { p, bId } = twoClips();
    expect(moveClip(p, bId, 60)).toBe(p);
  });

  it("returns the same project when the resolved start snaps back to the current one", () => {
    const { p, bId } = twoClips();
    // Dragged left, into the span its neighbour occupies: resolvePosition pushes
    // it back to 60, which is exactly where it started. This is the case that
    // made Ctrl+Z look broken, and the one a requested-start comparison misses.
    expect(moveClip(p, bId, 30)).toBe(p);
    expect(moveClip(p, bId, 0)).toBe(p);
  });

  it("still moves — and still reports a change — when the resolved start differs", () => {
    const { p, bId } = twoClips();
    const moved = moveClip(p, bId, 100);
    expect(moved).not.toBe(p);
    expect(findClip(moved, bId)!.clip.timelineStart).toBe(100);
    expectClean(moved);
  });

  it("counts a change of track at the same start as a change", () => {
    const { p, aId } = twoClips();
    const added = addVideoTrack(p);
    const moved = moveClip(added.project, aId, 0, added.trackId);
    expect(moved).not.toBe(added.project);
    expect(findClip(moved, aId)!.track.id).toBe(added.trackId);
    expect(findClip(moved, aId)!.clip.timelineStart).toBe(0);
    expectClean(moved);
  });

  it("resolves the destination without letting the clip block itself", () => {
    // The moving clip is excluded from the gap scan, so a same-track move into
    // its own span is not treated as occupied.
    const { p, aId } = twoClips();
    const moved = moveClip(p, aId, 10);
    expect(findClip(moved, aId)!.clip.timelineStart).toBe(0);
    // …and because that resolves back to 0, it is a no-op, not a new reference.
    expect(moved).toBe(p);
  });
});
