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
import { ProjectFileError } from "./project";
import {
  PDF_COORD_MAX,
  PDF_STROKE_MAX_POINTS,
  PDF_TOTAL_MAX_POINTS,
  checkPdfInvariants,
  isPdfFieldId,
  decodePdfPoints,
  emptyPdfTimeline,
  pdfHexColor,
  sanitizePdfAnnot,
  sanitizePdfMeta,
} from "./pdf-sanitize";
import { createPdfProject } from "./pdf-project";
import { errorDetail } from "./ipc";
import { normalizeHexColor } from "./session";
import { decodePoints, MAX_STROKE_POINTS, MAX_TOTAL_POINTS } from "../image/strokes";
import type { MediaRef, PdfAnnot, PdfMeta } from "./types";
import { PDF_MAX_ANNOTS_PER_PAGE, PDF_MAX_PAGES } from "./types";

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

  it("keeps the FIRST visual's canvas when a batch lands on an empty timeline", () => {
    // Import is bin-first: the timeline stays empty through the whole batch.
    // Width, height and fps all differ between the two files, so a last-wins
    // adoption fails every assertion.
    let p = createProject("New");
    p = addMedia(p, videoInfo()).project; // 1280x720 @ 30
    const portrait: MediaInfo = {
      ...videoInfo(),
      path: "C:\\media\\phone.mp4",
      fps: rat(60),
      width: 1080,
      height: 1920,
    };
    p = addMedia(p, portrait).project;
    expect(p.timeline.width).toBe(1280);
    expect(p.timeline.height).toBe(720);
    expect(p.timeline.fps).toEqual(rat(30));
    expect(p.media).toHaveLength(2);
    expectClean(p);
  });

  // A guard for the fix above, not a pin of it: it passes with or without it.
  it("an audio file already in the bin does not block the first visual's adoption", () => {
    let p = createProject("New");
    p = addMedia(p, audioInfo()).project;
    p = addMedia(p, videoInfo()).project;
    expect(p.timeline.width).toBe(1280);
    expect(p.timeline.height).toBe(720);
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

describe("image-project canvas (the kind branch)", () => {
  /** A project of the given kind with a hand-edited canvas, sanitized. */
  function canvasAfterLoad(kind: "image" | undefined, w: number, h: number): [number, number] {
    const p = createProject("Canvas");
    const raw: ProjectFile = { ...p, timeline: { ...p.timeline, width: w, height: h } };
    if (kind) Object.assign(raw, { schema: 3, kind });
    const t = sanitizeProject(raw).timeline;
    return [t.width, t.height];
  }

  it("keeps an image canvas's odd size; a video canvas of the same numbers is evened", () => {
    // Same input both ways, so the only thing that differs is the kind.
    expect(canvasAfterLoad("image", 641, 361)).toEqual([641, 361]);
    expect(canvasAfterLoad(undefined, 641, 361)).toEqual([642, 362]);
  });

  it("caps an image canvas at 65535 (not 8192) and floors it at 1 (not 16)", () => {
    expect(canvasAfterLoad("image", 70000, 9000)).toEqual([65535, 9000]);
    expect(canvasAfterLoad(undefined, 70000, 9000)).toEqual([MAX_CANVAS, MAX_CANVAS]);
    expect(canvasAfterLoad("image", 0, 3)).toEqual([1, 3]);
  });

  it("reads a NaN image side as 1, where a video's reads as 1920 × 1080", () => {
    expect(canvasAfterLoad("image", NaN, NaN)).toEqual([1, 1]);
    expect(canvasAfterLoad(undefined, NaN, NaN)).toEqual([1920, 1080]);
  });

  it("hands a healthy image project back as the same reference", () => {
    const p = createProject("Canvas");
    const img: ProjectFile = { ...p, schema: 3, kind: "image", timeline: { ...p.timeline, width: 641, height: 361 } };
    expect(sanitizeProject(img)).toBe(img);
  });

  it("checkInvariants holds an image canvas to integers in [1, 65535]", () => {
    const p = createProject("Canvas");
    const at = (kind: "image" | undefined, w: number, h: number): string[] => {
      const q: ProjectFile = { ...p, timeline: { ...p.timeline, width: w, height: h } };
      if (kind) Object.assign(q, { schema: 3, kind });
      return checkInvariants(q);
    };
    expect(at("image", 641, 1)).toEqual([]);
    expect(at("image", 65535, 9000)).toEqual([]);
    expect(at("image", 0, 361)).toEqual(["timeline width 0 not an integer in [1, 65535]"]);
    expect(at("image", 641, 65536)).toEqual(["timeline height 65536 not an integer in [1, 65535]"]);
    expect(at("image", 641.5, 361)).toEqual(["timeline width 641.5 not an integer in [1, 65535]"]);
    expect(at(undefined, 641, 360)).toEqual(["timeline width 641 not an even integer in [16, 8192]"]);
  });
});

/**
 * `tempEdited` arrives untyped (load_project hands the raw JSON on). It is what
 * keeps a crash orphan away from the startup sweep, so the loader must never
 * lose a real `true` — and must not let a hand-edited "yes" ride along into
 * the session and back onto disk. Whether a project WAS edited is the
 * session's call, so nothing is ever invented here.
 */
describe("sanitizeProject and tempEdited", () => {
  it("keeps a real flag, and returns the project itself when nothing else needs repair", () => {
    const p: ProjectFile = { ...createProject("orphan"), tempEdited: true };
    expect(sanitizeProject(p)).toBe(p);
  });

  it("invents nothing for a project without one", () => {
    const p = createProject("plain");
    const out = sanitizeProject(p);
    expect(out).toBe(p);
    expect("tempEdited" in out).toBe(false);
  });

  it.each<[string, unknown]>([
    ["a string", "yes"],
    ["a number", 1],
    ["false", false],
    ["null", null],
  ])("drops %s, leaving everything else as it was", (_why, value) => {
    const p = { ...createProject("hand-edited"), tempEdited: value } as unknown as ProjectFile;
    const out = sanitizeProject(p);
    expect("tempEdited" in out).toBe(false);
    expect(out.name).toBe("hand-edited");
    expect(out.timeline).toBe(p.timeline);
    // The input object itself is never mutated.
    expect((p as unknown as { tempEdited: unknown }).tempEdited).toBe(value);
  });

  it("keeps the flag while repairing something else", () => {
    const p: ProjectFile = { ...createProject("orphan"), tempEdited: true };
    const broken = { ...p, timeline: { ...p.timeline, width: 0 } };
    const out = sanitizeProject(broken);
    expect(out).not.toBe(broken);
    expect(out.tempEdited).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* PDF projects: sanitizePdfMeta, the PDF branch of sanitizeProject,   */
/* checkPdfInvariants. Every case crafts the raw JSON a hostile .trt   */
/* could carry (load_project hands it over untyped).                   */
/* ------------------------------------------------------------------ */

/** [x, y, pressure]* → the stored `p` (unpadded base64 of Float32LE). */
function pdfPts(...v: number[]): string {
  const bytes = new Uint8Array(new Float32Array(v).buffer);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

const PIC: MediaRef = {
  id: "pic1",
  path: "C:\\Pics\\stamp.png",
  size: 10,
  mtimeMs: 20,
  kind: "image",
  duration: 0,
  width: 100,
  height: 50,
  hasAudio: false,
};

/** One valid mark of every kind, ids a1..a10. */
function everyKind(): Record<string, unknown>[] {
  return [
    { id: "a1", t: "ink", kind: "pen", c: "#112233", w: 2, o: 1, p: pdfPts(1, 2, 0.5, 3, 4, 1) },
    { id: "a2", t: "highlight", c: "#ffff00", o: 0.4, rects: [[10, 10, 50, 12]] },
    {
      id: "a3",
      t: "text",
      x: 5,
      y: 6,
      w: 100,
      h: 20,
      text: "hello",
      font: "Arial",
      size: 12,
      c: "#000000",
      bold: false,
      italic: true,
      align: "left",
    },
    { id: "a4", t: "line", c: "#ff0000", w: 1, a: [0, 0], b: [10, 10] },
    { id: "a5", t: "rect", c: "#ff0000", w: 1, a: [0, 0], b: [10, 10] },
    { id: "a6", t: "ellipse", c: "#ff0000", w: 1, a: [0, 0], b: [10, 10] },
    { id: "a7", t: "arrow", c: "#ff0000", w: 1, a: [0, 0], b: [10, 10] },
    { id: "a8", t: "whiteout", x: 1, y: 1, w: 10, h: 10, c: "#ffffff" },
    { id: "a9", t: "image", x: 1, y: 1, w: 10, h: 10, media: "pic1" },
    { id: "a10", t: "signature", x: 1, y: 1, w: 10, h: 5, c: "#000080", strokes: [pdfPts(0, 0, 1, 1, 1, 1)] },
  ];
}

/** A healthy raw PDF project as JSON would hand it over: one source "s1" of
 *  4 pages, pages p1..p3 (p3 blank), marks on p1. */
function rawPdf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 4,
    kind: "pdf",
    app: "taroting",
    id: "proj",
    name: "Doc",
    createdAt: "2026-10-17T00:00:00.000Z",
    modifiedAt: "2026-10-17T00:00:00.000Z",
    media: [PIC],
    timeline: emptyPdfTimeline("track1"),
    export: { ...createProject("x").export },
    pdf: {
      sources: [{ id: "s1", path: "C:\\Docs\\a.pdf", size: 100, mtimeMs: 200, pages: 4 }],
      pages: [
        { id: "p1", src: "s1", page: 0, rotate: 0 },
        { id: "p2", src: "s1", page: 3, rotate: 90 },
        { id: "p3", src: null, page: 0, rotate: 0, w: 612, h: 792 },
      ],
      annots: { p1: everyKind() },
      forms: { s1: { "12R": "Dana", "13R": true, "14R": ["a", "b"] } },
      ...over,
    },
  };
}

/** sanitizeProject over a raw project, through a JSON round trip first. */
function loadRaw(raw: Record<string, unknown>): ProjectFile {
  return sanitizeProject(JSON.parse(JSON.stringify(raw)) as ProjectFile);
}

/** Sanitize a pdf block whose only page p1 (of source s1) carries `marks`. */
function marksAfterLoad(marks: unknown[], media: MediaRef[] = [PIC]): PdfAnnot[] {
  const meta = sanitizePdfMeta(
    JSON.parse(
      JSON.stringify({
        sources: [{ id: "s1", path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: 1 }],
        pages: [{ id: "p1", src: "s1", page: 0, rotate: 0 }],
        annots: { p1: marks },
        forms: {},
      }),
    ),
    media,
  );
  return meta.annots.p1 ?? [];
}
const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe("PDF project load: the healthy file", () => {
  it("keeps every field of a healthy file and passes the invariants", () => {
    const raw = rawPdf();
    const out = loadRaw(raw);
    expect(checkInvariants(out)).toEqual([]);
    expect(out.pdf).toEqual((raw as { pdf: PdfMeta }).pdf);
    expect(ids(out.pdf!.annots.p1!)).toEqual(ids(everyKind() as { id: string }[]));
  });

  it("keeps the empty timeline by reference and returns a new project", () => {
    const p = JSON.parse(JSON.stringify(rawPdf())) as ProjectFile;
    const out = sanitizeProject(p);
    expect(out).not.toBe(p);
    expect(out.timeline).toBe(p.timeline);
  });

  it("builds annots, forms and each form record without a prototype", () => {
    const pdf = loadRaw(rawPdf()).pdf!;
    expect(Object.getPrototypeOf(pdf.annots)).toBeNull();
    expect(Object.getPrototypeOf(pdf.forms)).toBeNull();
    expect(Object.getPrototypeOf(pdf.forms.s1)).toBeNull();
  });

  it("strips fields a mark's kind does not have", () => {
    const [a] = marksAfterLoad([{ id: "w", t: "whiteout", x: 1, y: 1, w: 1, h: 1, c: "#fff", evil: "x", p: "AAAA" }]);
    expect(a).toEqual({ id: "w", t: "whiteout", x: 1, y: 1, w: 1, h: 1, c: "#ffffff" });
  });

  it("leaves a video project with a stray pdf field alone, by reference", () => {
    const { p } = baseProject();
    const q = { ...p, pdf: { pages: "junk" } } as unknown as ProjectFile;
    expect(sanitizeProject(q)).toBe(q);
  });
});

describe("PDF project load: an unusable file", () => {
  it("throws a bad_input ProjectFileError when the pdf block is missing", () => {
    const raw = rawPdf();
    delete raw.pdf;
    expect(() => loadRaw(raw)).toThrow(ProjectFileError);
    try {
      loadRaw(raw);
    } catch (e) {
      // the shape the app's error paths read off a backend AppError
      expect(errorDetail(e).code).toBe("bad_input");
      expect(errorDetail(e).message).toMatch(/no page/);
    }
  });

  it("throws when no page survives", () => {
    expect(() => loadRaw(rawPdf({ pages: [] }))).toThrow(ProjectFileError);
    expect(() => loadRaw(rawPdf({ pages: "p1" }))).toThrow(ProjectFileError);
    expect(() => loadRaw(rawPdf({ pages: [{ id: "p1", src: "nope", page: 0, rotate: 0 }] }))).toThrow(
      ProjectFileError,
    );
  });

  it("treats a non-object pdf block as empty", () => {
    for (const pdf of [null, 7, "x", []]) {
      expect(() => sanitizePdfMeta(pdf)).toThrow(ProjectFileError);
    }
  });
});

describe("PDF project load: sources", () => {
  const src = (over: Record<string, unknown>) => ({ id: "s9", path: "C:\\b.pdf", size: 1, mtimeMs: 1, pages: 2, ...over });
  /** source ids kept when `extra` is added after the healthy s1 */
  const keptSources = (extra: Record<string, unknown>): string[] => {
    const raw = rawPdf();
    const pdf = raw.pdf as { sources: unknown[] };
    pdf.sources.push(extra);
    return loadRaw(raw).pdf!.sources.map((s) => s.id);
  };

  it("keeps a valid second source", () => {
    expect(keptSources(src({}))).toEqual(["s1", "s9"]);
  });

  it("drops a source with an invalid or reserved id", () => {
    for (const id of ["", "a b", "x".repeat(65), 5, null, "__proto__", "constructor", "prototype"]) {
      expect(keptSources(src({ id }))).toEqual(["s1"]);
    }
  });

  it("drops a later source reusing an id", () => {
    expect(keptSources(src({ id: "s1", path: "C:\\other.pdf" }))).toEqual(["s1"]);
    expect(loadRaw(rawPdf()).pdf!.sources[0]!.path).toBe("C:\\Docs\\a.pdf");
  });

  it("drops a path that is empty, has control characters, or is a URL", () => {
    for (const path of ["", "C:\\a\u0000.pdf", "C:\\a\n.pdf", "http://evil/x.pdf", "file:///C:/x.pdf", "smb://h/x", 7]) {
      expect(keptSources(src({ path }))).toEqual(["s1"]);
    }
    // a drive letter is not a scheme, and UNC paths stay allowed (owner call)
    expect(keptSources(src({ path: "D:\\x.pdf" }))).toEqual(["s1", "s9"]);
    expect(keptSources(src({ path: "\\\\nas\\share\\x.pdf" }))).toEqual(["s1", "s9"]);
  });

  it("drops a size or mtime that is negative or not a number", () => {
    for (const bad of [{ size: -1 }, { size: "1" }, { mtimeMs: -5 }, { mtimeMs: null }]) {
      expect(keptSources(src(bad))).toEqual(["s1"]);
    }
  });

  it("drops a page count outside 1..PDF_MAX_PAGES or not an integer", () => {
    for (const pages of [0, -1, 1.5, PDF_MAX_PAGES + 1, "3"]) {
      expect(keptSources(src({ pages }))).toEqual(["s1"]);
    }
    expect(keptSources(src({ pages: PDF_MAX_PAGES }))).toEqual(["s1", "s9"]);
  });

  it("drops the pages of a dropped source", () => {
    const raw = rawPdf({
      sources: [{ id: "s1", path: "http://x/a.pdf", size: 1, mtimeMs: 1, pages: 4 }],
    });
    // p1 and p2 named s1; only the blank p3 survives
    expect(loadRaw(raw).pdf!.pages.map((p) => p.id)).toEqual(["p3"]);
  });
});

describe("PDF project load: pages", () => {
  const pagesAfter = (pages: unknown[]) => loadRaw(rawPdf({ pages, annots: {} })).pdf!.pages;
  const ok = { id: "p1", src: "s1", page: 0, rotate: 0 };

  it("reads an unknown rotation as 0 and keeps the four real ones", () => {
    const out = pagesAfter([
      { ...ok, id: "a", rotate: 45 },
      { ...ok, id: "b", rotate: "90" },
      { ...ok, id: "c", rotate: 270 },
      { ...ok, id: "d", rotate: 180 },
      { ...ok, id: "e", rotate: 360 },
    ]);
    expect(out.map((p) => p.rotate)).toEqual([0, 0, 270, 180, 0]);
  });

  it("drops a page index outside its source or not an integer", () => {
    const out = pagesAfter([
      { ...ok, id: "a", page: 3 },
      { ...ok, id: "b", page: 4 },
      { ...ok, id: "c", page: -1 },
      { ...ok, id: "d", page: 1.5 },
      { ...ok, id: "e", page: "0" },
    ]);
    expect(out.map((p) => p.id)).toEqual(["a"]);
  });

  it("drops a page naming an unknown source, or with no src at all", () => {
    const out = pagesAfter([ok, { ...ok, id: "x", src: "s2" }, { id: "y", page: 0, rotate: 0 }]);
    expect(out.map((p) => p.id)).toEqual(["p1"]);
  });

  it("keeps a blank page of 1..14400 points and drops any other size", () => {
    const blank = (id: string, w: unknown, h: unknown) => ({ id, src: null, page: 7, rotate: 0, w, h });
    const out = pagesAfter([
      blank("a", 612, 792),
      blank("b", 1, 14400),
      blank("c", 0, 792),
      blank("d", 612, 14401),
      blank("e", "612", 792),
      blank("f", undefined, 792),
    ]);
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
    // a blank page's `page` is meaningless and normalised
    expect(out[0]).toEqual({ id: "a", src: null, page: 0, rotate: 0, w: 612, h: 792 });
  });

  it("drops a page with an invalid, reserved or repeated id", () => {
    const out = pagesAfter([ok, { ...ok }, { ...ok, id: "__proto__" }, { ...ok, id: "" }, { ...ok, id: 3 }]);
    expect(out.map((p) => p.id)).toEqual(["p1"]);
  });

  it("caps the document at PDF_MAX_PAGES pages", () => {
    const many = Array.from({ length: PDF_MAX_PAGES + 5 }, (_, i) => ({ ...ok, id: `p${i}` }));
    const meta = sanitizePdfMeta({
      sources: [{ id: "s1", path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: 1 }],
      pages: many,
    });
    expect(meta.pages).toHaveLength(PDF_MAX_PAGES);
    expect(meta.pages[PDF_MAX_PAGES - 1]!.id).toBe(`p${PDF_MAX_PAGES - 1}`);
  });
});

describe("PDF project load: marks", () => {
  it("keeps every valid kind", () => {
    expect(ids(marksAfterLoad(everyKind()))).toEqual(ids(everyKind() as { id: string }[]));
  });

  it("drops marks keyed by a page that does not exist, keeping the real page's", () => {
    const out = loadRaw(rawPdf({ annots: { p1: everyKind().slice(0, 1), ghost: everyKind().slice(1, 2) } }));
    expect(Object.keys(out.pdf!.annots)).toEqual(["p1"]);
  });

  it("does not let a __proto__ key pollute or survive", () => {
    const json =
      '{"sources":[{"id":"s1","path":"C:\\\\a.pdf","size":1,"mtimeMs":1,"pages":1}],' +
      '"pages":[{"id":"p1","src":"s1","page":0,"rotate":0},{"id":"__proto__","src":"s1","page":0,"rotate":0}],' +
      '"annots":{"__proto__":[{"id":"z","t":"whiteout","x":0,"y":0,"w":1,"h":1,"c":"#fff"}],"constructor":[]},' +
      '"forms":{"__proto__":{"polluted":"yes"},"s1":{"__proto__":"x","constructor":"y","1R":"ok"}}}';
    const meta = sanitizePdfMeta(JSON.parse(json));
    expect(meta.pages.map((p) => p.id)).toEqual(["p1"]);
    expect(Object.keys(meta.annots)).toEqual([]);
    expect(Object.keys(meta.forms)).toEqual(["s1"]);
    expect(Object.keys(meta.forms.s1!)).toEqual(["1R"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(meta.annots.constructor).toBeUndefined();
  });

  it("drops a mark list that is not a list", () => {
    expect(Object.keys(loadRaw(rawPdf({ annots: { p1: { 0: everyKind()[0] } } })).pdf!.annots)).toEqual([]);
    expect(Object.keys(loadRaw(rawPdf({ annots: [everyKind()] })).pdf!.annots)).toEqual([]);
  });

  it("drops a mark whose id is invalid or already used anywhere in the document", () => {
    const [ink] = everyKind();
    const out = loadRaw(
      rawPdf({
        annots: {
          p1: [ink, { ...ink }, { ...ink, id: "__proto__" }, { ...ink, id: "" }],
          p2: [{ ...ink }],
        },
      }),
    );
    expect(ids(out.pdf!.annots.p1!)).toEqual(["a1"]);
    expect(out.pdf!.annots.p2).toBeUndefined();
  });

  it("drops an unknown kind", () => {
    expect(marksAfterLoad([{ id: "x", t: "erase", w: 1, p: pdfPts(0, 0, 1) }, { id: "y", c: "#fff" }])).toEqual([]);
  });

  it("caps marks at PDF_MAX_ANNOTS_PER_PAGE per page", () => {
    const many = Array.from({ length: PDF_MAX_ANNOTS_PER_PAGE + 3 }, (_, i) => ({
      id: `w${i}`,
      t: "whiteout",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      c: "#fff",
    }));
    const kept = marksAfterLoad(many);
    expect(kept).toHaveLength(PDF_MAX_ANNOTS_PER_PAGE);
    expect(kept[0]!.id).toBe("w0");
  });

  /** The single mark `base` with `patch` applied survives the load? */
  const survives = (base: Record<string, unknown>, patch: Record<string, unknown>): boolean =>
    marksAfterLoad([{ ...base, ...patch }]).length === 1;
  const kinds = everyKind();
  const K = (id: string) => kinds.find((k) => k.id === id)!;

  it("normalises a colour and drops an unreadable one", () => {
    const [w] = marksAfterLoad([{ ...K("a8"), c: " #ABC " }]);
    expect((w as { c: string }).c).toBe("#aabbcc");
    for (const id of ["a1", "a2", "a3", "a4", "a8", "a10"]) {
      for (const c of ["#ggg", "red", "", 0, "#1234567", "#aaaaaÀa"]) expect(survives(K(id), { c })).toBe(false);
    }
  });

  it("holds every coordinate to |v| <= 1e6 and box sides to >= 0", () => {
    expect(survives(K("a8"), { x: PDF_COORD_MAX })).toBe(true);
    expect(survives(K("a8"), { x: PDF_COORD_MAX + 1 })).toBe(false);
    expect(survives(K("a8"), { y: -PDF_COORD_MAX - 1 })).toBe(false);
    expect(survives(K("a8"), { w: -1 })).toBe(false);
    expect(survives(K("a9"), { h: -0.5 })).toBe(false);
    expect(survives(K("a3"), { x: "5" })).toBe(false);
    expect(survives(K("a10"), { w: null })).toBe(false);
    expect(survives(K("a4"), { a: [0, PDF_COORD_MAX + 1] })).toBe(false);
    expect(survives(K("a5"), { b: [0] })).toBe(false);
    expect(survives(K("a2"), { rects: [[0, 0, -1, 1]] })).toBe(false);
    expect(survives(K("a2"), { rects: [[0, 2e6, 1, 1]] })).toBe(false);
    expect(survives(K("a2"), { rects: [[0, 0, 1]] })).toBe(false);
  });

  it("holds stroke widths to (0, 1000]", () => {
    for (const id of ["a1", "a4", "a5", "a6", "a7"]) {
      expect(survives(K(id), { w: 1000 })).toBe(true);
      for (const w of [0, -1, 1000.5, "2", null]) expect(survives(K(id), { w })).toBe(false);
    }
  });

  it("clamps a finite opacity into [0, 1] and drops a missing one", () => {
    expect((marksAfterLoad([{ ...K("a1"), o: 2 }])[0] as { o: number }).o).toBe(1);
    expect((marksAfterLoad([{ ...K("a2"), o: -1 }])[0] as { o: number }).o).toBe(0);
    for (const o of [undefined, "1", null]) {
      expect(survives(K("a1"), { o })).toBe(false);
      expect(survives(K("a2"), { o })).toBe(false);
    }
  });

  it("checks ink: kind, and points that decode within page space", () => {
    expect(survives(K("a1"), { kind: "erase" })).toBe(false);
    expect(survives(K("a1"), { kind: "pencil" })).toBe(true);
    for (const p of ["", "AAAA", pdfPts(0, 0, 1).slice(0, 15), pdfPts(0, 0, 1) + "=", "!".repeat(16), 5]) {
      expect(survives(K("a1"), { p })).toBe(false);
    }
    expect(survives(K("a1"), { p: pdfPts(0, 0, 2) })).toBe(false); // pressure > 1
    expect(survives(K("a1"), { p: pdfPts(2e6, 0, 1) })).toBe(false); // off any page
    expect(survives(K("a1"), { p: pdfPts(NaN, 0, 1) })).toBe(false);
  });

  it("checks a highlight's rect count: 1..1000", () => {
    const r = [0, 0, 1, 1];
    expect(survives(K("a2"), { rects: Array(1000).fill(r) })).toBe(true);
    expect(survives(K("a2"), { rects: Array(1001).fill(r) })).toBe(false);
    expect(survives(K("a2"), { rects: [] })).toBe(false);
  });

  it("checks text: length, font whitelist, size, booleans, alignment", () => {
    expect(survives(K("a3"), { text: "x".repeat(20_000) })).toBe(true);
    expect(survives(K("a3"), { text: "x".repeat(20_001) })).toBe(false);
    expect(survives(K("a3"), { text: 5 })).toBe(false);
    for (const font of ["Comic Sans MS", "arial", "", "toString", "__proto__"]) expect(survives(K("a3"), { font })).toBe(false);
    expect(survives(K("a3"), { font: "Times New Roman" })).toBe(true);
    for (const size of [4, 288]) expect(survives(K("a3"), { size })).toBe(true);
    for (const size of [3.9, 289, "12", null]) expect(survives(K("a3"), { size })).toBe(false);
    expect(survives(K("a3"), { bold: "true" })).toBe(false);
    expect(survives(K("a3"), { italic: 1 })).toBe(false);
    expect(survives(K("a3"), { align: "justify" })).toBe(false);
    expect(survives(K("a3"), { align: "right" })).toBe(true);
  });

  it("keeps a turn of 90/180/270 on text, image and signature marks, and no other", () => {
    for (const k of ["a3", "a9", "a10"]) {
      for (const r of [90, 180, 270]) {
        const out = marksAfterLoad([{ ...K(k), r }], [PIC]);
        expect((out[0] as { r?: number }).r, `${k} r=${r}`).toBe(r);
      }
      for (const r of [0, 45, -90, 360, "90", null, NaN]) {
        const out = marksAfterLoad([{ ...K(k), r }], [PIC]);
        expect(out.length, `${k} r=${String(r)} keeps the mark`).toBe(1);
        expect("r" in out[0]!, `${k} r=${String(r)} is no turn`).toBe(false);
      }
    }
    // the other kinds never carry one
    const w = marksAfterLoad([{ ...K("a8"), r: 90 }]);
    expect("r" in w[0]!).toBe(false);
  });

  it("keeps an image mark only when its media is a real image in the project", () => {
    expect(marksAfterLoad([K("a9")], [])).toEqual([]);
    expect(marksAfterLoad([K("a9")], [{ ...PIC, kind: "video" }])).toEqual([]);
    expect(marksAfterLoad([K("a9")], [{ ...PIC, generator: { type: "solid", color: "#fff" } }])).toEqual([]);
    expect(survives(K("a9"), { media: "other" })).toBe(false);
    expect(survives(K("a9"), { media: 1 })).toBe(false);
  });

  it("checks a signature: 1..1000 strokes that each decode", () => {
    const s = pdfPts(0, 0, 1);
    expect(survives(K("a10"), { strokes: [] })).toBe(false);
    expect(survives(K("a10"), { strokes: Array(1000).fill(s) })).toBe(true);
    expect(survives(K("a10"), { strokes: Array(1001).fill(s) })).toBe(false);
    expect(survives(K("a10"), { strokes: [s, "AAAA"] })).toBe(false);
    expect(survives(K("a10"), { strokes: [s, pdfPts(0, 0, 5)] })).toBe(false);
    expect(survives(K("a10"), { strokes: s })).toBe(false);
  });

  it("refuses ink over the remaining point budget, before decoding", () => {
    const two = { ...K("a1"), p: pdfPts(0, 0, 1, 1, 1, 1) };
    expect(sanitizePdfAnnot(two, new Set(), 2)).not.toBeNull();
    expect(sanitizePdfAnnot(two, new Set(), 1)).toBeNull();
    const sig = { ...K("a10"), strokes: [pdfPts(0, 0, 1), pdfPts(0, 0, 1)] };
    expect(sanitizePdfAnnot(sig, new Set(), 2)).not.toBeNull();
    expect(sanitizePdfAnnot(sig, new Set(), 1)).toBeNull();
  });

  it("refuses a stroke over PDF_STROKE_MAX_POINTS by its length alone", () => {
    // 1e6 + 1 points of "A" would decode to zeros; the length check must come
    // first (a crafted file can carry many of these). The document-wide
    // PDF_TOTAL_MAX_POINTS budget reaches each mark through the same
    // `maxPoints` argument tested above.
    const big = { ...K("a1"), id: "big", p: "A".repeat((PDF_STROKE_MAX_POINTS + 1) * 16) };
    expect(sanitizePdfAnnot(big, new Set())).toBeNull();
    expect(ids(marksAfterLoad([big, K("a8")]))).toEqual(["a8"]);
  });
});

describe("PDF project load: a text box's fill and border", () => {
  const text = () => everyKind().find((k) => k.id === "a3")! as Record<string, unknown>;
  const one = (patch: Record<string, unknown>) => marksAfterLoad([{ ...text(), ...patch }]);

  it("keeps a readable fill and border, colours normalised", () => {
    const [a] = one({ bg: "#ABC", border: "#102030" });
    expect(a).toMatchObject({ bg: "#aabbcc", border: "#102030" });
    // and a second load changes nothing
    expect(marksAfterLoad([a])).toEqual([a]);
  });

  it("leaves out an unreadable fill or border, keeping the box", () => {
    for (const v of ["red", "#ggg", 5, null, "#1234567"]) {
      const [a] = one({ bg: v, border: v });
      expect(a, String(v)).toBeDefined();
      expect("bg" in a! || "border" in a!, String(v)).toBe(false);
    }
  });

  it("a stored `edit` field (an unreleased build's) is dropped: the box loads as a plain text box", () => {
    const edit = { rects: [[10.5, 20, 30, 12]], cover: "#f0f0f0", orig: "Old words" };
    const raw = rawPdf({ annots: { p1: [{ ...text(), bg: "#ffffff", edit }] } });
    const out = loadRaw(raw);
    expect(checkInvariants(out)).toEqual([]);
    const [a] = out.pdf!.annots.p1!;
    expect(a).toMatchObject({ t: "text", text: "hello", bg: "#ffffff" });
    expect("edit" in a!).toBe(false);
  });

  it("checkPdfInvariants reports a fill or border the sanitizer would drop", () => {
    const p = createPdfProject("x", { path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: 1 });
    const id = p.pdf!.pages[0]!.id;
    const bad = { ...text(), bg: "red", border: "#ffffff" } as unknown as PdfAnnot;
    const errs = checkPdfInvariants({ ...p, pdf: { ...p.pdf!, annots: { [id]: [bad] } } });
    expect(errs).toContain("mark a3: invalid bg");
    const good = { ...text(), bg: "#ffffff" } as unknown as PdfAnnot;
    expect(checkPdfInvariants({ ...p, pdf: { ...p.pdf!, annots: { [id]: [sanitizePdfAnnot(good, new Set())!] } } })).toEqual([]);
  });
});

describe("PDF project load: forms and export options", () => {
  const formsAfter = (forms: unknown) => loadRaw(rawPdf({ forms })).pdf!.forms;

  it("keeps string, boolean and string-list values", () => {
    expect({ ...formsAfter({ s1: { "12R": "Dana", "13R": true, "14R": ["a"] } }).s1 }).toEqual({
      "12R": "Dana",
      "13R": true,
      "14R": ["a"],
    });
  });

  it("drops values of the wrong type or past the bounds", () => {
    const rec = formsAfter({
      s1: {
        "1R": "x", // ok
        "2R": 5,
        "3R": null,
        "4R": { a: 1 },
        "5R": "x".repeat(20_001),
        "6R": Array(501).fill("a"),
        "7R": ["a", 1],
        "8R": ["x".repeat(20_001)],
        "9R": Array(500).fill("a"), // ok
      },
    }).s1!;
    expect(Object.keys(rec)).toEqual(["1R", "9R"]);
  });

  it("drops field ids that are not ids", () => {
    // pdf.js widget ids: "<num>R", "<num>R<gen>", or "annot_p<page>_<n>" — all kept
    expect(
      Object.keys(formsAfter({ s1: { "a b": "x", "": "y", "1R": "z", "12R3": "g", annot_p1_2: "a" } }).s1!),
    ).toEqual(["1R", "12R3", "annot_p1_2"]);
  });

  it("drops a key that is an id but not a pdf.js widget id", () => {
    // pdf.js reads a "pdfjs_internal_editor_" storage key as a NEW annotation
    // and the export breaks on it; built-in names are no field either
    const keys = ["pdfjs_internal_editor_0", "toString", "R", "12", "12R3x", "annot_", "annot_x", "x1R", "7R"];
    expect(Object.keys(formsAfter({ s1: Object.fromEntries(keys.map((k) => [k, "v"])) }).s1!)).toEqual(["7R"]);
    expect(isPdfFieldId("pdfjs_internal_editor_0")).toBe(false);
    expect(checkPdfInvariants(loadRaw(rawPdf())).length).toBe(0);
  });

  it("drops forms keyed by an unknown source, and a source with no value left", () => {
    const forms = formsAfter({ s2: { "1R": "x" }, s1: { bad: 1 } });
    expect(Object.keys(forms)).toEqual([]);
    expect(Object.keys(formsAfter([{ "1R": "x" }]))).toEqual([]);
  });

  it("keeps an absent export block absent", () => {
    expect("export" in loadRaw(rawPdf()).pdf!).toBe(false);
    expect("export" in loadRaw(rawPdf({ export: "yes" })).pdf!).toBe(false);
  });

  it("reads an export flag as true only when it is literally true", () => {
    expect(loadRaw(rawPdf({ export: { flattenMarks: "true", flattenForms: true } })).pdf!.export).toEqual({
      flattenMarks: false,
      flattenForms: true,
    });
    expect(loadRaw(rawPdf({ export: {} })).pdf!.export).toEqual({ flattenMarks: false, flattenForms: false });
  });
});

describe("PDF project load: media, timeline, tempEdited", () => {
  const withProject = (over: Record<string, unknown>) => loadRaw({ ...rawPdf(), ...over });

  it("keeps only real still images on disk, once each", () => {
    const out = withProject({
      media: [
        PIC,
        { ...PIC },
        { ...PIC, id: "v", kind: "video" },
        { ...PIC, id: "g", generator: { type: "solid", color: "#fff" } },
        { ...PIC, id: "u", path: "https://x/y.png" },
        { ...PIC, id: "w", width: 0 },
        { ...PIC, id: "s", size: -1 },
        "junk",
      ],
    });
    expect(out.media.map((m) => m.id)).toEqual(["pic1"]);
  });

  it("reads a media list that is not a list as empty, dropping image marks with it", () => {
    const out = withProject({ media: "junk" });
    expect(out.media).toEqual([]);
    expect(ids(out.pdf!.annots.p1!)).not.toContain("a9");
  });

  it("replaces a timeline with clips, markers or a bad shape by the empty one", () => {
    const { p } = baseProject();
    for (const timeline of [
      p.timeline,
      { ...emptyPdfTimeline(), markers: [{ id: "m", t: 1, color: 0 }] },
      { ...emptyPdfTimeline(), width: 641 },
      { ...emptyPdfTimeline(), tracks: [] },
      { ...emptyPdfTimeline(), fps: { num: 30, den: 0 } },
      "junk",
    ]) {
      const out = withProject({ timeline });
      expect(out.timeline.tracks).toHaveLength(1);
      expect(out.timeline.tracks[0]!.clips).toEqual([]);
      expect(checkInvariants(out)).toEqual([]);
    }
  });

  it("applies the tempEdited rule to a PDF project too", () => {
    expect("tempEdited" in withProject({ tempEdited: "yes" })).toBe(false);
    expect(withProject({ tempEdited: true }).tempEdited).toBe(true);
  });
});

describe("PDF sanitizer mirrors (core cannot import their originals)", () => {
  it("pdfHexColor answers exactly as normalizeHexColor(v, '')", () => {
    for (const v of ["#abc", "#ABCDEF", " #a1b2c3 ", "a1b2c3", "#abcd", "#ggg", "", "#1234567", "x".repeat(13), 5, null, "#aaaaaÀa"]) {
      expect(pdfHexColor(v) ?? "").toBe(normalizeHexColor(v, ""));
    }
  });

  it("decodePdfPoints agrees with decodePoints inside page space", () => {
    for (const p of [pdfPts(1, 2, 0.5), pdfPts(0, 0, 2), pdfPts(NaN, 0, 1), "AAAA", "", pdfPts(1, 2, 0.5) + "=", "!".repeat(16)]) {
      expect(decodePdfPoints(p)).toEqual(decodePoints(p));
    }
    // …and adds the page-space bound decodePoints does not have
    expect(decodePoints(pdfPts(2e6, 0, 1))).not.toBeNull();
    expect(decodePdfPoints(pdfPts(2e6, 0, 1))).toBeNull();
  });

  it("keeps the point caps no higher than the image editor's, and at the export-safe sizes", () => {
    expect(PDF_STROKE_MAX_POINTS).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(PDF_TOTAL_MAX_POINTS).toBeLessThanOrEqual(MAX_TOTAL_POINTS);
    // a crafted file at the old 20M made an export run for minutes / GBs
    expect(PDF_STROKE_MAX_POINTS).toBe(100_000);
    expect(PDF_TOTAL_MAX_POINTS).toBe(2_000_000);
  });
});

describe("checkPdfInvariants", () => {
  const fresh = () => createPdfProject("x", { path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: 2 });
  const withPdf = (p: ProjectFile, over: Partial<PdfMeta>): ProjectFile => ({ ...p, pdf: { ...p.pdf!, ...over } });

  it("holds for a new project and is reached through checkInvariants", () => {
    const p = fresh();
    expect(checkPdfInvariants(p)).toEqual([]);
    expect(checkInvariants({ ...p, schema: 3 })).toContain("pdf project has schema 3, expected 4");
  });

  it("reports what the sanitizer would have dropped", () => {
    const p = fresh();
    const [pg] = p.pdf!.pages;
    const ink = everyKind()[0] as unknown as PdfAnnot;
    expect(checkPdfInvariants({ ...p, pdf: undefined })).toEqual(["pdf project has no pdf block"]);
    expect(checkPdfInvariants(withPdf(p, { pages: [] }))).toContain("pdf project has no pages");
    expect(checkPdfInvariants(withPdf(p, { pages: [{ ...pg!, src: "nope" }] }))).toContain(`page ${pg!.id}: invalid`);
    expect(checkPdfInvariants(withPdf(p, { pages: [pg!, pg!] }))).toContain(`page ${pg!.id}: duplicate id`);
    const badSrc = withPdf(p, { sources: [{ ...p.pdf!.sources[0]!, path: "http://x/a.pdf" }] });
    expect(checkPdfInvariants(badSrc)).toEqual(expect.arrayContaining([`page ${pg!.id}: invalid`]));
    expect(checkPdfInvariants(withPdf(p, { annots: { ghost: [ink] } }))).toContain("annots keyed by unknown page ghost");
    expect(checkPdfInvariants(withPdf(p, { annots: { [pg!.id]: [ink, ink] } }))).toContain("mark a1: duplicate id");
    expect(checkPdfInvariants(withPdf(p, { annots: { [pg!.id]: [{ ...ink, w: 0 } as PdfAnnot] } }))).toContain(
      "mark a1: invalid",
    );
    expect(checkPdfInvariants(withPdf(p, { forms: { nope: { "1R": "x" } } }))).toContain(
      "forms keyed by unknown source nope",
    );
    const { p: video } = baseProject();
    expect(checkPdfInvariants({ ...p, timeline: video.timeline })).toContain(
      "pdf project timeline is not the empty one",
    );
  });
});
