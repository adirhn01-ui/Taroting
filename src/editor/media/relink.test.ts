import { describe, expect, it } from "vitest";
import {
  addMedia,
  createProject,
  findClip,
  findMedia,
  IMAGE_DEFAULT_DUR,
  insertClip,
  makeClip,
  MIN_CLIP_DUR,
  updateClip,
} from "../../core/project";
import { rat } from "../../core/time";
import type { MediaInfo, ProjectFile } from "../../core/types";
import { applyRelink, clampClipsToDuration, clampSrcWindow } from "./relink";

/** clampSrcWindow keeps the clip's source window inside a (possibly shorter)
 *  source, never collapsing it to zero length. Guards the relink-to-shorter-file
 *  regression where srcIn beyond the new EOF produced an invisible clip. */
describe("clampSrcWindow", () => {
  it("returns null (no-op) for a longer or equal-length source", () => {
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 1 }, 60)).toBeNull();
    expect(clampSrcWindow({ srcIn: 0, srcOut: 10, speed: 1 }, 10)).toBeNull();
  });

  it("lowers only srcOut when srcIn still fits", () => {
    // srcIn (2) < new dur (5) < srcOut (8) → clamp srcOut to EOF, keep srcIn
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 1 }, 5)).toEqual({
      srcIn: 2,
      srcOut: 5,
    });
  });

  it("pulls srcIn back when it lands beyond the new EOF", () => {
    // srcIn (30) >= new dur (10): naive clamp would collapse to [10,10].
    // Instead srcIn is pulled back so a min-length window survives.
    const w = clampSrcWindow({ srcIn: 30, srcOut: 50, speed: 1 }, 10)!;
    expect(w.srcOut).toBe(10);
    expect(w.srcIn).toBeCloseTo(10 - MIN_CLIP_DUR, 12);
    expect(w.srcOut - w.srcIn).toBeGreaterThanOrEqual(MIN_CLIP_DUR - 1e-12);
  });

  it("never produces a zero-length clip (srcIn < srcOut, source length >= floor)", () => {
    for (const speed of [0.25, 1, 4]) {
      const w = clampSrcWindow({ srcIn: 100, srcOut: 120, speed }, 3)!;
      expect(w.srcIn).toBeGreaterThanOrEqual(0);
      expect(w.srcOut).toBeLessThanOrEqual(3);
      expect(w.srcOut).toBeGreaterThan(w.srcIn);
      // timeline duration = (srcOut - srcIn) / speed stays >= the min floor
      expect((w.srcOut - w.srcIn) / speed).toBeGreaterThanOrEqual(MIN_CLIP_DUR - 1e-12);
    }
  });

  it("scales the source floor with speed so timeline duration meets the min", () => {
    // At 4x, one min-length timeline clip needs 4 * MIN_CLIP_DUR source-seconds.
    const w = clampSrcWindow({ srcIn: 100, srcOut: 120, speed: 4 }, 10)!;
    expect(w.srcOut - w.srcIn).toBeCloseTo(4 * MIN_CLIP_DUR, 12);
  });

  it("clamps into [0, dur] best-effort when the source is shorter than one frame", () => {
    // dur (0.001s) < minSrcLen: cannot satisfy the floor; keep it in-bounds.
    const w = clampSrcWindow({ srcIn: 5, srcOut: 9, speed: 1 }, 0.001)!;
    expect(w.srcIn).toBe(0);
    expect(w.srcOut).toBe(0.001);
  });

  it("refuses a non-positive duration instead of collapsing the clip", () => {
    // ffprobe reports every still image as duration 0 (png_pipe carries no
    // duration field at all), so 0 means "no information", not "empty file".
    // Clamping into [0, 0] made the clip zero-length: it vanished from the
    // timeline and autosave wrote that to disk 500 ms later, with no warning
    // (the "duration differs" notice is gated on oldDur > 0).
    expect(clampSrcWindow({ srcIn: 0, srcOut: 5, speed: 1 }, 0)).toBeNull();
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 0.25 }, 0)).toBeNull();
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 1 }, -3)).toBeNull();
    expect(clampSrcWindow({ srcIn: 2, srcOut: 8, speed: 1 }, NaN)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* applyRelink — the whole repair a relink performs                    */
/* ------------------------------------------------------------------ */

// Deliberately mismatched on EVERY axis the code could confuse: the original is
// a 1920x1080 60s h264 video with audio, the replacement a 640x480 12.5s hevc
// file without. Coinciding numbers would turn these into no-ops.
const originalInfo: MediaInfo = {
  path: "C:\\media\\original.mp4",
  size: 100_000,
  mtimeMs: 1,
  kind: "video",
  duration: 60,
  fps: rat(30),
  width: 1920,
  height: 1080,
  container: "mp4",
  vcodec: "h264",
  acodec: "aac",
  hasAudio: true,
  audioRate: 48_000,
  audioChannels: 2,
};

const imageInfo: MediaInfo = {
  path: "C:\\media\\still.png",
  size: 2048,
  mtimeMs: 2,
  kind: "image",
  duration: 0, // every image probes as 0
  width: 300,
  height: 200,
  hasAudio: false,
};

/** One media + one clip covering it, on the first video track. */
function projectWith(info: MediaInfo): {
  p: ProjectFile;
  mediaId: string;
  clipId: string;
} {
  let p = createProject("Relink");
  const added = addMedia(p, info);
  p = added.project;
  const clip = makeClip(added.media, 0);
  p = insertClip(p, p.timeline.tracks[0]!.id, clip);
  return { p, mediaId: added.media.id, clipId: clip.id };
}

describe("clampClipsToDuration", () => {
  it("skips image media entirely (no source duration to clamp into)", () => {
    const { p, mediaId, clipId } = projectWith(imageInfo);
    const before = findClip(p, clipId)!.clip;
    expect(before.srcOut).toBe(IMAGE_DEFAULT_DUR);

    const q = clampClipsToDuration(p, mediaId, 0);
    expect(q).toBe(p); // same reference: nothing was touched
    const after = findClip(q, clipId)!.clip;
    expect(after.srcIn).toBe(before.srcIn);
    expect(after.srcOut).toBe(before.srcOut);
  });

  it("still clamps a video whose replacement really is shorter", () => {
    const { p, mediaId, clipId } = projectWith(originalInfo);
    const q = clampClipsToDuration(p, mediaId, 12.5);
    expect(findClip(q, clipId)!.clip.srcOut).toBe(12.5);
  });
});

describe("applyRelink", () => {
  it("replaces the whole probed record, not just path/size/mtime/duration", () => {
    const { p, mediaId } = projectWith(originalInfo);
    const replacement: MediaInfo = {
      path: "D:\\elsewhere\\small.mov",
      size: 777,
      mtimeMs: 99,
      kind: "video",
      duration: 12.5,
      fps: rat(24),
      width: 640,
      height: 480,
      container: "mov",
      vcodec: "hevc",
      hasAudio: false,
    };
    const q = applyRelink(p, mediaId, replacement.path, replacement);
    const m = findMedia(q, mediaId)!;

    expect(m.id).toBe(mediaId); // identity survives
    expect(m.path).toBe("D:\\elsewhere\\small.mov");
    expect(m.size).toBe(777);
    expect(m.mtimeMs).toBe(99);
    expect(m.duration).toBe(12.5);
    // the fields the old patch left stale — stale dims make computeTransformInto
    // fit to the OLD aspect and size the export's alphamerge mask wrongly
    expect(m.width).toBe(640);
    expect(m.height).toBe(480);
    expect(m.fps).toEqual(rat(24));
    expect(m.vcodec).toBe("hevc");
    expect(m.container).toBe("mov");
    expect(m.hasAudio).toBe(false);
    // fields the NEW probe doesn't report must not keep the old file's values
    expect(m.acodec).toBeUndefined();
    expect(m.audioRate).toBeUndefined();
    expect(m.audioChannels).toBeUndefined();
  });

  it("clamps an out-of-range crop into the new, smaller frame", () => {
    const { p, mediaId, clipId } = projectWith(originalInfo);
    // a crop only the 1920x1080 original can hold
    const cropped = updateClip(p, clipId, (c) => ({
      ...c,
      transform: { ...c.transform!, crop: { x: 1500, y: 900, w: 400, h: 180 } },
    }));

    const q = applyRelink(cropped, mediaId, "D:\\elsewhere\\small.mov", {
      path: "D:\\elsewhere\\small.mov",
      size: 777,
      mtimeMs: 99,
      kind: "video",
      duration: 12.5,
      width: 640,
      height: 480,
      hasAudio: false,
    });

    const crop = findClip(q, clipId)!.clip.transform!.crop!;
    expect(crop).toEqual({ x: 240, y: 300, w: 400, h: 180 });
    expect(crop.x + crop.w).toBeLessThanOrEqual(640);
    expect(crop.y + crop.h).toBeLessThanOrEqual(480);
    // and the source window followed the shorter duration
    expect(findClip(q, clipId)!.clip.srcOut).toBe(12.5);
  });

  it("leaves a crop that already fits alone", () => {
    const { p, mediaId, clipId } = projectWith(originalInfo);
    const crop = { x: 10, y: 20, w: 320, h: 240 };
    const cropped = updateClip(p, clipId, (c) => ({
      ...c,
      transform: { ...c.transform!, crop },
    }));
    const q = applyRelink(cropped, mediaId, "D:\\elsewhere\\small.mov", {
      ...originalInfo,
      path: "D:\\elsewhere\\small.mov",
      width: 640,
      height: 480,
    });
    expect(findClip(q, clipId)!.clip.transform!.crop).toEqual(crop);
  });

  it("relinking to an image keeps the clip's source window intact", () => {
    // The data-loss case: the image probes as duration 0, and the old code
    // clamped the clip to [0, 0] — it disappeared from the timeline and
    // autosave persisted the loss within 500 ms.
    const { p, mediaId, clipId } = projectWith(originalInfo);
    const before = findClip(p, clipId)!.clip;

    const q = applyRelink(p, mediaId, imageInfo.path, imageInfo);
    const m = findMedia(q, mediaId)!;
    expect(m.kind).toBe("image"); // a PNG in a <video> renders nothing
    expect(m.width).toBe(300);
    expect(m.height).toBe(200);
    expect(m.fps).toBeUndefined();
    expect(m.vcodec).toBeUndefined();

    const after = findClip(q, clipId)!.clip;
    expect(after.srcIn).toBe(before.srcIn);
    expect(after.srcOut).toBe(before.srcOut);
    expect(after.srcOut).toBeGreaterThan(after.srcIn);
  });

  it("relinking an image to another image never collapses the clip", () => {
    const { p, mediaId, clipId } = projectWith(imageInfo);
    const q = applyRelink(p, mediaId, "D:\\other.jpg", {
      ...imageInfo,
      path: "D:\\other.jpg",
      width: 4000,
      height: 3000,
    });
    const after = findClip(q, clipId)!.clip;
    expect(after.srcOut - after.srcIn).toBe(IMAGE_DEFAULT_DUR);
  });
});
