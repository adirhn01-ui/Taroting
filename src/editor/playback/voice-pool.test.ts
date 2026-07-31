// Voice-pool allocation policy (see claimVoiceSlot in audio-graph.ts).
//
// The bug this guards: `syncAudioTracks` fills `wanted` in TRACK order with up
// to two entries per audio track — the clip playing right now AND a lookahead
// — and used to hand out voices in that single order. With 4+ audio tracks
// (reachable by detaching audio from overlapping clips, since detachAudio makes
// a fresh track whenever none fits) track 1's LOOKAHEAD took the voice track
// 4's PLAYING clip needed. Preview went silent; the export, built from the
// project rather than this pool, stayed correct — so it read as "preview audio
// randomly missing".

import { describe, expect, it } from "vitest";
import { claimVoiceSlot } from "./audio-graph";

interface Slot {
  clipId: string | null;
}

const pool = (n: number): Slot[] => Array.from({ length: n }, () => ({ clipId: null }));
const held = (voices: readonly Slot[]): string[] =>
  voices.map((v) => v.clipId).filter((id): id is string => id !== null);

/**
 * The allocator loop from `AudioGraph.syncAudioTracks`, reduced to the part
 * that decides who gets a voice: park anything no longer wanted, then two
 * passes over `wanted` (audible clips first, lookaheads with what is left).
 * `wanted` maps clipId → active, in the same insertion order the real code
 * builds it (per track: playing clip, then lookahead).
 */
function allocate(voices: Slot[], wanted: ReadonlyMap<string, boolean>): void {
  for (const v of voices) {
    if (v.clipId !== null && !wanted.has(v.clipId)) v.clipId = null;
  }
  const isLookahead = (id: string): boolean => wanted.get(id) === false;
  for (let pass = 0; pass < 2; pass++) {
    const wantActive = pass === 0;
    for (const [clipId, active] of wanted) {
      if (active !== wantActive) continue;
      const voice = claimVoiceSlot(voices, clipId, active, isLookahead);
      if (voice) voice.clipId = clipId;
    }
  }
}

/** `wanted` for `n` audio tracks, each with a playing clip + a lookahead. */
function tracks(n: number, opts: { lookaheads?: boolean } = {}): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (let i = 1; i <= n; i++) {
    m.set(`a${i}`, true);
    if (opts.lookaheads !== false) m.set(`h${i}`, false);
  }
  return m;
}

describe("claimVoiceSlot", () => {
  const never = (): boolean => false;

  it("reuses the slot already holding the clip", () => {
    const voices: Slot[] = [{ clipId: null }, { clipId: "c1" }, { clipId: null }];
    expect(claimVoiceSlot(voices, "c1", true, never)).toBe(voices[1]);
  });

  it("prefers its own slot even when a free one comes first", () => {
    const voices: Slot[] = [{ clipId: null }, { clipId: "c1" }];
    expect(claimVoiceSlot(voices, "c1", true, never)).toBe(voices[1]);
  });

  it("takes the first free slot when the clip has none", () => {
    const voices: Slot[] = [{ clipId: "x" }, { clipId: null }, { clipId: null }];
    expect(claimVoiceSlot(voices, "c1", true, never)).toBe(voices[1]);
  });

  it("prefers a free slot over evicting a lookahead", () => {
    const voices: Slot[] = [{ clipId: "look" }, { clipId: null }];
    const isLookahead = (id: string): boolean => id === "look";
    expect(claimVoiceSlot(voices, "c1", true, isLookahead)).toBe(voices[1]);
    expect(voices[0]!.clipId).toBe("look");
  });

  it("an audible clip reclaims a slot a lookahead is squatting on", () => {
    const voices: Slot[] = [{ clipId: "aud" }, { clipId: "look" }];
    const isLookahead = (id: string): boolean => id === "look";
    expect(claimVoiceSlot(voices, "c1", true, isLookahead)).toBe(voices[1]);
  });

  it("a lookahead never evicts anything", () => {
    const voices: Slot[] = [{ clipId: "look1" }, { clipId: "look2" }];
    const isLookahead = (): boolean => true;
    expect(claimVoiceSlot(voices, "look3", false, isLookahead)).toBeNull();
  });

  it("returns null when every slot is already audible", () => {
    const voices: Slot[] = [{ clipId: "a" }, { clipId: "b" }];
    const isLookahead = (): boolean => false;
    expect(claimVoiceSlot(voices, "c", true, isLookahead)).toBeNull();
  });

  it("does not evict a clip that is not a lookahead of this tick", () => {
    // A voice holding something `wanted` knows nothing about is left alone —
    // the release pass owns those, not the allocator.
    const voices: Slot[] = [{ clipId: "stranger" }];
    expect(claimVoiceSlot(voices, "c1", true, (id) => id === "look")).toBeNull();
  });
});

describe("voice pool allocation (6 slots)", () => {
  it("keeps every audible clip of 4 audio tracks audible", () => {
    // The reported bug: 8 wanted entries, 6 slots. A single track-ordered pass
    // spent slots on h1/h2/h3 and left a4 silent.
    const voices = pool(6);
    allocate(voices, tracks(4));
    for (const id of ["a1", "a2", "a3", "a4"]) {
      expect(held(voices)).toContain(id);
    }
    // the two leftover slots went to lookaheads, in track order
    expect(held(voices).filter((id) => id.startsWith("h"))).toEqual(["h1", "h2"]);
  });

  it("stays stable across an idle tick — nothing is reshuffled", () => {
    const voices = pool(6);
    const wanted = tracks(4);
    allocate(voices, wanted);
    const first = voices.map((v) => v.clipId);
    allocate(voices, wanted);
    expect(voices.map((v) => v.clipId)).toEqual(first);
  });

  it("a track that becomes audible later reclaims a lookahead's slot", () => {
    // Voice ownership persists across ticks, so a two-pass allocation ALONE is
    // not enough: at t=8s three tracks fill all six slots (3 audible + 3
    // lookaheads); when track 4's clip starts at t=10s nothing has been
    // released, and without eviction it would stay silent for its whole run.
    const voices = pool(6);
    allocate(voices, tracks(3));
    expect(held(voices)).toHaveLength(6);

    allocate(voices, tracks(4));
    expect(held(voices)).toContain("a4");
    for (const id of ["a1", "a2", "a3"]) expect(held(voices)).toContain(id);
    // exactly one lookahead gave way
    expect(held(voices).filter((id) => id.startsWith("h"))).toHaveLength(2);
  });

  it("never drops an audible clip while a lookahead keeps a slot", () => {
    // Grow one track at a time up to the pool size and re-check the invariant
    // after every step: audible always beats pre-roll.
    const voices = pool(6);
    for (let n = 1; n <= 6; n++) {
      allocate(voices, tracks(n));
      for (let i = 1; i <= n; i++) expect(held(voices)).toContain(`a${i}`);
    }
    // at 6 tracks the pool is entirely audible — no lookahead survives
    expect(held(voices).filter((id) => id.startsWith("h"))).toEqual([]);
  });

  it("beyond the pool size the overflow is audible clips, not silence for all", () => {
    const voices = pool(6);
    allocate(voices, tracks(8, { lookaheads: false }));
    // 6 of the 8 play; the pool is genuinely full of audible audio
    expect(held(voices)).toHaveLength(6);
    expect(new Set(held(voices)).size).toBe(6);
  });

  it("releases voices whose clip left the timeline window", () => {
    const voices = pool(6);
    allocate(voices, tracks(4));
    const later = new Map<string, boolean>([["a9", true]]);
    allocate(voices, later);
    expect(held(voices)).toEqual(["a9"]);
  });
});
