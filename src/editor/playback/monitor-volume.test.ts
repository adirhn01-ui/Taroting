import { describe, expect, it } from "vitest";
import {
  makeMonitorVolume,
  setMonitorLevel,
  toggleMonitorMute,
} from "./audio-graph";

describe("monitor volume state machine", () => {
  it("seeds level + restore point from a persisted value", () => {
    const s = makeMonitorVolume(0.6);
    expect(s.level).toBe(0.6);
    expect(s.lastNonZero).toBe(0.6);
  });

  it("clamps the seed to 0..1", () => {
    expect(makeMonitorVolume(2).level).toBe(1);
    expect(makeMonitorVolume(-1).level).toBe(0);
  });

  it("seeding at 0 keeps a non-zero restore point so un-mute makes sound", () => {
    const s = makeMonitorVolume(0);
    expect(s.level).toBe(0);
    expect(s.lastNonZero).toBe(1);
    const un = toggleMonitorMute(s);
    expect(un.level).toBe(1);
  });

  it("setLevel clamps and updates the restore point when audible", () => {
    let s = makeMonitorVolume(0.5);
    s = setMonitorLevel(s, 0.8);
    expect(s.level).toBe(0.8);
    expect(s.lastNonZero).toBe(0.8);
    s = setMonitorLevel(s, 1.5);
    expect(s.level).toBe(1);
    s = setMonitorLevel(s, -0.2);
    expect(s.level).toBe(0);
  });

  it("dragging the slider to 0 does NOT overwrite the restore point", () => {
    let s = makeMonitorVolume(0.7);
    s = setMonitorLevel(s, 0);
    expect(s.level).toBe(0);
    expect(s.lastNonZero).toBe(0.7);
    // un-muting after a drag-to-zero returns to the last audible level
    s = toggleMonitorMute(s);
    expect(s.level).toBe(0.7);
  });

  it("mute → un-mute round-trips through the last audible level", () => {
    let s = makeMonitorVolume(0.4);
    s = toggleMonitorMute(s); // mute
    expect(s.level).toBe(0);
    expect(s.lastNonZero).toBe(0.4);
    s = toggleMonitorMute(s); // un-mute
    expect(s.level).toBe(0.4);
  });

  it("muting from a fresh setLevel remembers that level", () => {
    let s = makeMonitorVolume(1);
    s = setMonitorLevel(s, 0.25);
    s = toggleMonitorMute(s);
    expect(s.level).toBe(0);
    expect(s.lastNonZero).toBe(0.25);
    s = toggleMonitorMute(s);
    expect(s.level).toBe(0.25);
  });

  it("sanitizes a malformed persisted seed to a safe, finite in-range state", () => {
    // A hand-edited or corrupted settings.json can persist a non-numeric or
    // non-finite monitorVolume. clampVol must coerce (Number()) and fall back
    // to the safe default 1 for anything non-finite — never NaN/Infinity out.
    // Every one of these must yield finite, in-range state and never throw.
    const malformed: unknown[] = [
      "abc",
      NaN,
      undefined,
      null,
      true,
      false,
      Infinity,
      -Infinity,
      {},
      [],
    ];
    for (const bad of malformed) {
      const s = makeMonitorVolume(bad as number);
      expect(Number.isFinite(s.level)).toBe(true);
      expect(s.level).toBeGreaterThanOrEqual(0);
      expect(s.level).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s.lastNonZero)).toBe(true);
      expect(s.lastNonZero).toBeGreaterThan(0);
      expect(s.lastNonZero).toBeLessThanOrEqual(1);
      // a malformed seed never throws downstream and un-mute stays audible
      expect(() => toggleMonitorMute(s)).not.toThrow();
    }
  });

  it("falls back to a full, audible level for genuinely non-finite seeds", () => {
    // Anything that Number() cannot turn into a finite value (NaN/Infinity/
    // non-numeric string/object) defaults to 1 rather than silencing preview.
    for (const bad of ["abc", NaN, undefined, true, Infinity, -Infinity, {}] as unknown[]) {
      const s = makeMonitorVolume(bad as number);
      expect(s.level).toBe(1);
      expect(s.lastNonZero).toBe(1);
    }
    // Values that DO coerce to a finite number keep that coerced value:
    expect(makeMonitorVolume(null as unknown as number).level).toBe(0); // Number(null) === 0
    expect(makeMonitorVolume(false as unknown as number).level).toBe(0); // Number(false) === 0
  });

  it("coerces a numeric string seed like a number (no data loss)", () => {
    const s = makeMonitorVolume("0.5" as unknown as number);
    expect(s.level).toBe(0.5);
    expect(s.lastNonZero).toBe(0.5);
  });

  it("sanitizes malformed values passed to setLevel too", () => {
    let s = makeMonitorVolume(0.4);
    for (const bad of ["abc", NaN, undefined, null, true, Infinity] as unknown[]) {
      s = setMonitorLevel(s, bad as number);
      expect(Number.isFinite(s.level)).toBe(true);
      expect(s.level).toBeGreaterThanOrEqual(0);
      expect(s.level).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s.lastNonZero)).toBe(true);
    }
  });

  it("is pure — inputs are not mutated", () => {
    const s = makeMonitorVolume(0.5);
    const frozen = Object.freeze({ ...s });
    setMonitorLevel(frozen, 0.9);
    toggleMonitorMute(frozen);
    expect(frozen.level).toBe(0.5);
    expect(frozen.lastNonZero).toBe(0.5);
  });
});
