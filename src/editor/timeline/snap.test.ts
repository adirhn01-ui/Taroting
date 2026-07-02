import { describe, expect, it } from "vitest";
import { collectCandidates, snapMove, snapTime } from "./snap";
import { createProject, insertClip, makeClip } from "../../core/project";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";

function projectWithClip(): { project: ProjectFile; clip: Clip } {
  let p = createProject("t");
  const media: MediaRef = {
    id: "m1", path: "x.mp4", size: 1, mtimeMs: 1, kind: "video",
    duration: 20, hasAudio: false, width: 1920, height: 1080,
  };
  p = { ...p, media: [media] };
  const clip = makeClip(media, 5); // timelineStart 5, srcIn 0, srcOut 20, speed 1
  p = insertClip(p, p.timeline.tracks[0]!.id, clip);
  const placed = p.timeline.tracks[0]!.clips[0]!;
  return { project: p, clip: placed };
}

describe("snapTime", () => {
  const candidates = [0, 10, 20];

  it("snaps within the pixel threshold", () => {
    // 8px threshold at 10 px/sec = 0.8s
    expect(snapTime(10.5, candidates, 10, true)).toEqual({ t: 10, guide: 10 });
    expect(snapTime(9.3, candidates, 10, true)).toEqual({ t: 10, guide: 10 });
  });

  it("does not snap outside the threshold", () => {
    expect(snapTime(11.5, candidates, 10, true)).toEqual({ t: 11.5, guide: null });
  });

  it("threshold scales with zoom", () => {
    // at 100 px/sec the threshold is 0.08s
    expect(snapTime(10.5, candidates, 100, true).guide).toBeNull();
    expect(snapTime(10.05, candidates, 100, true).guide).toBe(10);
  });

  it("disabled → passthrough", () => {
    expect(snapTime(10.01, candidates, 100, false)).toEqual({ t: 10.01, guide: null });
  });
});

describe("snapMove", () => {
  it("snaps whichever edge is closer to a candidate", () => {
    const candidates = [50];
    // clip duration 10; start 40.5 → end 50.5 is 0.5s from 50 (within the
    // 0.8s threshold at 10 px/sec); the start edge is 9.5s away
    const r = snapMove(40.5, 10, candidates, 10, true);
    expect(r.guide).toBe(50);
    expect(r.t).toBeCloseTo(40, 9); // start moved so END sits at 50
  });

  it("prefers the start edge when it is nearer", () => {
    const r = snapMove(49.5, 10, [50], 10, true);
    expect(r.t).toBe(50);
  });

  it("no candidates in range → unchanged", () => {
    expect(snapMove(30, 5, [100], 10, true)).toEqual({ t: 30, guide: null });
  });
});

describe("collectCandidates", () => {
  it("includes 0, playhead, and clip edges", () => {
    const { project } = projectWithClip();
    const cands = collectCandidates(project, null, 3);
    expect(cands).toContain(0);
    expect(cands).toContain(3);
    expect(cands).toContain(5); // clip start
    expect(cands).toContain(25); // clip end (5 + 20)
  });

  it("excludes the dragged clip's own edges", () => {
    const { project, clip } = projectWithClip();
    const cands = collectCandidates(project, clip.id, 3);
    expect(cands).not.toContain(5);
    expect(cands).not.toContain(25);
  });

  it("adds a selected clip's in-range keyframe timeline-times, skipping ghosts", () => {
    const { project, clip } = projectWithClip();
    // srcIn 0, srcOut 20, speed 1, start 5 → tl = 5 + srcT
    const withKf: Clip = {
      ...clip,
      keyframes: {
        x: [
          { t: -3, v: 0 }, // ghost (before srcIn) → skipped
          { t: 4, v: 10 }, // → tl 9
          { t: 30, v: 20 }, // ghost (after srcOut) → skipped
        ],
        y: [
          { t: -3, v: 0 },
          { t: 4, v: 0 },
          { t: 30, v: 0 },
        ],
      },
    };
    const cands = collectCandidates(project, null, 3, withKf);
    expect(cands).toContain(9); // in-range keyframe mapped to timeline time
    // ghost keyframes map to 2 and 35 — neither should appear
    expect(cands).not.toContain(2);
    expect(cands).not.toContain(35);
  });

  it("no selected clip / no keyframes → no extra candidates", () => {
    const { project, clip } = projectWithClip();
    const a = collectCandidates(project, null, 3);
    const b = collectCandidates(project, null, 3, clip); // clip has no keyframes
    expect(b).toEqual(a);
  });
});
