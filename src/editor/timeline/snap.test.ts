import { describe, expect, it } from "vitest";
import { collectCandidates, snapMove, snapTime } from "./snap";
import { resolveMoveStart } from "./interactions";
import {
  addVideoTrack,
  createProject,
  findClip,
  insertClip,
  makeClip,
  moveClip,
  moveMarkerTo,
  removeClip,
} from "../../core/project";
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

/* ------------------------------------------------------------------ *
 * Timeline drag gestures (interactions.ts)
 *
 * These live here rather than in an interactions.test.ts because the drag
 * ghost's position is the other half of what snapMove computes: snapMove says
 * what the pointer ASKS for, and the project's placement rules say where the
 * clip actually GOES. The gap between the two was the bug.
 *
 * vite.config.ts runs tests in `environment: "node"`, so nothing here touches a
 * canvas or a pointer — only the pure functions the handlers call.
 * ------------------------------------------------------------------ */

const VIDEO: MediaRef = {
  id: "mv", path: "v.mp4", size: 1, mtimeMs: 1, kind: "video",
  duration: 600, hasAudio: false, width: 1920, height: 1080,
};

/** A project with one video track and no clips. */
function emptyProject(): ProjectFile {
  const p = createProject("t");
  return { ...p, media: [VIDEO] };
}

/** Append a clip of `dur` seconds at `at` on `trackId`; returns its id. */
function addClip(p: ProjectFile, trackId: string, at: number, dur: number): {
  project: ProjectFile;
  id: string;
} {
  const clip: Clip = { ...makeClip(VIDEO, at), srcIn: 0, srcOut: dur };
  return { project: insertClip(p, trackId, clip), id: clip.id };
}

/** What the COMMIT does: run the real mutator and read the clip back. This is
 *  the ground truth every preview assertion below is measured against. */
function committedStart(
  p: ProjectFile,
  clipId: string,
  requested: number,
  toTrackId: string,
): { start: number; trackId: string } {
  const after = moveClip(p, clipId, requested, toTrackId);
  const found = findClip(after, clipId)!;
  return { start: found.clip.timelineStart, trackId: found.track.id };
}

describe("resolveMoveStart — the drag ghost matches the commit", () => {
  it("same-lane drop onto an occupied span lands past the occupant, not under the cursor", () => {
    // Blocker at 5–15; the dragged clip is 10 s long, parked at 20–30. The only
    // gap that can hold it is the tail after 15, so a request at 6.2 s commits
    // at 15 s — the ghost used to draw at 6.2 and the clip jumped on release.
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    p = addClip(p, trackId, 5, 10).project;
    const added = addClip(p, trackId, 20, 10);
    p = added.project;

    const requested = 6.2;
    const preview = resolveMoveStart(p, added.id, requested, trackId);
    const commit = committedStart(p, added.id, requested, trackId);

    expect(preview).toBe(15);
    expect(preview).toBe(commit.start);
    expect(preview).not.toBe(requested); // the old preview drew here
  });

  it("dense track: a drop into a fully packed range lands at the tail, and the ghost says so", () => {
    // 30 x 10 s clips covering 0–300, plus the dragged clip parked at 300.
    // Every candidate gap is too small, so the only feasible spot is 300 —
    // 288 s away from where the pointer asked, and off-screen at any useful zoom.
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    for (let i = 0; i < 30; i++) p = addClip(p, trackId, i * 10, 10).project;
    const added = addClip(p, trackId, 300, 10);
    p = added.project;

    const requested = 12;
    const preview = resolveMoveStart(p, added.id, requested, trackId);
    const commit = committedStart(p, added.id, requested, trackId);

    expect(preview).toBe(300);
    expect(preview).toBe(commit.start);
  });

  it("cross-lane drop into an occupied target lane lands after the occupant", () => {
    // V1 (the new top track) is occupied 0–20; the clip is dragged up from V2.
    let p = emptyProject();
    const v2 = p.timeline.tracks[0]!.id;
    const withTop = addVideoTrack(p);
    p = withTop.project;
    const v1 = withTop.trackId;
    p = addClip(p, v1, 0, 20).project;
    const added = addClip(p, v2, 30, 5);
    p = added.project;

    const requested = 8;
    const preview = resolveMoveStart(p, added.id, requested, v1);
    const commit = committedStart(p, added.id, requested, v1);

    expect(preview).toBe(20);
    expect(preview).toBe(commit.start);
    expect(commit.trackId).toBe(v1); // it really did change lane
  });

  it("an unobstructed move previews exactly the requested position", () => {
    // The common case must not be perturbed by running the mutator: with room
    // to land, the preview is the snapped request, character for character.
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    const added = addClip(p, trackId, 40, 10);
    p = added.project;

    expect(resolveMoveStart(p, added.id, 12.5, trackId)).toBe(12.5);
  });

  it("is idempotent: previewing the resolved position returns that same position", () => {
    // This is what lets pointerup treat "landed where it already is" as a real
    // no-op instead of pushing an undo entry for a move that changed nothing.
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    p = addClip(p, trackId, 5, 10).project;
    const added = addClip(p, trackId, 20, 10);
    p = added.project;

    const once = resolveMoveStart(p, added.id, 6.2, trackId);
    expect(resolveMoveStart(p, added.id, once, trackId)).toBe(once);
    // and committing at it leaves the clip exactly there
    expect(committedStart(p, added.id, once, trackId).start).toBe(once);
  });

  it("a clip dragged nowhere resolves to where it already is (the no-op guard's premise)", () => {
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    const added = addClip(p, trackId, 12, 10);
    p = added.project;
    const start = findClip(p, added.id)!.clip.timelineStart;

    expect(resolveMoveStart(p, added.id, start, trackId)).toBe(start);
  });

  it("a vanished clip or a mismatched lane previews as 'no move' rather than throwing", () => {
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    const added = addClip(p, trackId, 12, 10);
    p = added.project;

    expect(resolveMoveStart(p, "no-such-clip", 40, trackId)).toBe(40);
    expect(resolveMoveStart(p, added.id, 40, "no-such-track")).toBe(12);
  });

  it("snapMove feeding resolveMoveStart: the snapped request is what gets placed", () => {
    // The two halves as the handler composes them — snap first, then place.
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    p = addClip(p, trackId, 50, 10).project; // blocker 50–60, its start is a candidate
    const added = addClip(p, trackId, 80, 10);
    p = added.project;

    // dragged to 40.4 with a candidate at 50: the END edge (50.4) snaps to 50,
    // so the request becomes 40 — which is feasible, so that is where it lands.
    const snapped = snapMove(40.4, 10, [50], 10, true);
    expect(snapped.t).toBeCloseTo(40, 9);
    expect(resolveMoveStart(p, added.id, snapped.t, trackId)).toBeCloseTo(40, 9);
  });
});

describe("marker drag history: reconstructing the undo target", () => {
  // pointerup no longer pushes a pointerdown snapshot (that swallowed any commit
  // landing mid-drag into the same undo step). It pushes the CURRENT project with
  // just the marker put back, so undo reverts the marker move and nothing else.
  it("undoing the marker move keeps an edit that landed during the drag", () => {
    let p = emptyProject();
    const trackId = p.timeline.tracks[0]!.id;
    const added = addClip(p, trackId, 0, 10);
    p = added.project;
    p = { ...p, timeline: { ...p.timeline, markers: [{ id: "mk", t: 2, color: 0 }] } };

    const startT = 2;
    // …drag the marker (history-free replaces) …
    let live = moveMarkerTo(p, "mk", 4);
    // …a Delete lands mid-drag (its own commit, its own history entry) …
    live = removeClip(live, added.id);
    // …the drag continues …
    live = moveMarkerTo(live, "mk", 7);

    // what pointerup pushes as the undo target
    const undoTarget = moveMarkerTo(live, "mk", startT);

    // undo #1 restores the marker AND leaves the deletion in place
    expect(undoTarget.timeline.markers).toEqual([{ id: "mk", t: startT, color: 0 }]);
    expect(findClip(undoTarget, added.id)).toBeUndefined();
    // and it is exactly "the project as the other edit left it, marker unmoved"
    expect(undoTarget).toEqual(removeClip(p, added.id));
  });

  it("with no intervening edit it is the pre-drag project, so undo behaves as before", () => {
    let p = emptyProject();
    p = { ...p, timeline: { ...p.timeline, markers: [{ id: "mk", t: 2, color: 0 }] } };
    const live = moveMarkerTo(p, "mk", 9);
    expect(moveMarkerTo(live, "mk", 2)).toEqual(p);
  });
});
