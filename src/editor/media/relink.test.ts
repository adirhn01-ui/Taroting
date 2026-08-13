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
import { addJobTarget, dropMediaTargets, type JobEntry, type JobTarget } from "./media";

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

/* ------------------------------------------------------------------ */
/* job target mapping — one backend job, many media entries            */
/* ------------------------------------------------------------------ */

/**
 * Preparation jobs are de-duplicated per output path on the backend
 * (`src-tauri/src/media/playability.rs:163-172`) and the output path hashes
 * `{path,size,mtimeMs}` — so two media entries pointing at ONE file get the
 * SAME job id back. The map from job id to waiter therefore has to be
 * one-to-many; when it was one-to-one the second registration silently
 * overwrote the first, and that media never left "Preparing".
 *
 * `retrack` is the other half: it must be able to withdraw ONE media from the
 * jobs the old file started without disturbing anything else waiting on them.
 */
const pb = (mediaId: string, output = `proxy/${mediaId}.mp4`): JobTarget => ({
  type: "playback",
  mediaId,
  output,
});
const wf = (mediaId: string, output = `wave/${mediaId}.pk`): JobTarget => ({
  type: "waveform",
  mediaId,
  output,
});

describe("addJobTarget", () => {
  it("stores a lone waiter directly, so the common case allocates no array", () => {
    const jobs = new Map<number, JobEntry>();
    const a = pb("a");
    addJobTarget(jobs, 7, a);
    expect(jobs.get(7)).toBe(a); // the very same object, in the very same slot
    expect(Array.isArray(jobs.get(7))).toBe(false);
    expect(jobs.size).toBe(1);
  });

  it("KEEPS the first waiter when a second media lands on the same job", () => {
    // The bug, at the level it lived: `jobs.set(id, b)` dropped `a` on the
    // floor, and `a` was the entry already on the timeline.
    const jobs = new Map<number, JobEntry>();
    const a = pb("a");
    const b = pb("b");
    addJobTarget(jobs, 7, a);
    addJobTarget(jobs, 7, b);
    expect(jobs.get(7)).toEqual([a, b]); // registration order
  });

  it("grows past two waiters", () => {
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 7, pb("a"));
    addJobTarget(jobs, 7, pb("b"));
    addJobTarget(jobs, 7, pb("c"));
    expect((jobs.get(7) as JobTarget[]).map((t) => t.mediaId)).toEqual(["a", "b", "c"]);
  });

  it("replaces rather than queues when the same media+lane re-registers", () => {
    // A repeated ensure() for one media must not make it a waiter twice over,
    // and the newest target wins because it carries the newest output path.
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 7, pb("a", "old.mp4"));
    const fresh = pb("a", "new.mp4");
    addJobTarget(jobs, 7, fresh);
    expect(jobs.get(7)).toBe(fresh); // still the lone-target shape

    addJobTarget(jobs, 7, pb("b"));
    const newer = pb("a", "newer.mp4");
    addJobTarget(jobs, 7, newer);
    expect((jobs.get(7) as JobTarget[]).length).toBe(2);
    expect((jobs.get(7) as JobTarget[])[0]).toBe(newer); // position preserved
  });

  it("treats the playback and waveform lanes of one media as separate waiters", () => {
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 7, pb("a"));
    addJobTarget(jobs, 7, wf("a"));
    expect((jobs.get(7) as JobTarget[]).map((t) => t.type)).toEqual(["playback", "waveform"]);
  });

  it("never mixes waiters across job ids", () => {
    const jobs = new Map<number, JobEntry>();
    const a = pb("a");
    const b = pb("b");
    addJobTarget(jobs, 1, a);
    addJobTarget(jobs, 2, b);
    expect(jobs.get(1)).toBe(a);
    expect(jobs.get(2)).toBe(b);
  });
});

describe("dropMediaTargets", () => {
  it("deletes the job entry when the relinked media was its only waiter", () => {
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 7, pb("a"));
    dropMediaTargets(jobs, "a");
    expect(jobs.has(7)).toBe(false);
  });

  it("leaves a job belonging to someone else completely alone", () => {
    const jobs = new Map<number, JobEntry>();
    const other = pb("b");
    addJobTarget(jobs, 7, other);
    dropMediaTargets(jobs, "a");
    expect(jobs.get(7)).toBe(other); // same reference: untouched
  });

  it("removes only the named media, keeping the order of the survivors", () => {
    const jobs = new Map<number, JobEntry>();
    for (const id of ["a", "b", "c"]) addJobTarget(jobs, 7, pb(id));
    dropMediaTargets(jobs, "b");
    expect((jobs.get(7) as JobTarget[]).map((t) => t.mediaId)).toEqual(["a", "c"]);
  });

  it("collapses back to the lone-target shape when one waiter is left", () => {
    // Otherwise a job that once had company keeps paying the array's read cost
    // for the rest of its life.
    const jobs = new Map<number, JobEntry>();
    const a = pb("a");
    const b = pb("b");
    addJobTarget(jobs, 7, a);
    addJobTarget(jobs, 7, b);
    dropMediaTargets(jobs, "a");
    expect(jobs.get(7)).toBe(b);
    expect(Array.isArray(jobs.get(7))).toBe(false);
  });

  it("deletes the entry when every waiter on it belonged to that media", () => {
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 7, pb("a"));
    addJobTarget(jobs, 7, wf("a"));
    dropMediaTargets(jobs, "a");
    expect(jobs.size).toBe(0);
  });

  it("withdraws the media from EVERY job it was waiting on", () => {
    // A relink invalidates the media's whole cache identity, so its playback
    // job, its waveform job and any job it shares are all stale for it.
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 1, pb("a"));
    addJobTarget(jobs, 2, wf("a"));
    addJobTarget(jobs, 3, pb("b"));
    addJobTarget(jobs, 3, pb("a"));
    dropMediaTargets(jobs, "a");
    expect(jobs.has(1)).toBe(false);
    expect(jobs.has(2)).toBe(false);
    expect((jobs.get(3) as JobTarget).mediaId).toBe("b");
  });

  it("is a no-op for a media that is waiting on nothing", () => {
    const jobs = new Map<number, JobEntry>();
    const a = pb("a");
    const b = pb("b");
    addJobTarget(jobs, 7, a);
    addJobTarget(jobs, 7, b);
    dropMediaTargets(jobs, "zzz");
    expect(jobs.get(7)).toEqual([a, b]);
  });

  it("round-trips: a dropped media can register again and both waiters resolve", () => {
    const jobs = new Map<number, JobEntry>();
    addJobTarget(jobs, 1, pb("a"));
    addJobTarget(jobs, 1, pb("b"));
    dropMediaTargets(jobs, "a"); // relink
    addJobTarget(jobs, 2, pb("a", "relinked.mp4")); // new file, new job
    expect(jobs.get(1)).toEqual(pb("b"));
    expect(jobs.get(2)).toEqual(pb("a", "relinked.mp4"));
  });
});
