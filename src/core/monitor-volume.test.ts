import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMonitorVolume } from "./monitor-volume";
import { settingsStore, updateSettings } from "./session";
import { DEFAULT_SETTINGS } from "./types";

// Only the disk write is replaced; settingsStore stays the real one, so the
// controller is seeded exactly the way the app seeds it.
vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  updateSettings: vi.fn(() => Promise.resolve()),
}));

/**
 * The controller behind every monitor-volume UI (transport flyout, theater bar,
 * and the viewer's bar next). The pure state machine has its own tests in
 * src/editor/playback/monitor-volume.test.ts; these pin what the controller
 * adds: the sink is applied synchronously, the settings write is debounced to
 * the SETTLED level, and a pending write is never lost on teardown.
 *
 * Levels differ everywhere (seed 0.35, drags 0.1..0.55, flush 0.8) so an
 * assertion on "the level that was written" can only pass for one reason.
 */

const SEED = 0.35;
const write = vi.mocked(updateSettings);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
  });
  settingsStore.set({ ...DEFAULT_SETTINGS, monitorVolume: SEED });
  write.mockReset();
  write.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createMonitorVolume", () => {
  it("applies the seeded level at once and every change synchronously", () => {
    const applied: number[] = [];
    const v = createMonitorVolume((l) => applied.push(l), () => {});
    expect(applied).toEqual([SEED]);
    v.setLevel(0.1);
    expect(applied).toEqual([SEED, 0.1]); // before any timer ran
    v.toggleMute();
    v.toggleMute();
    expect(applied).toEqual([SEED, 0.1, 0, 0.1]);
    expect(v.get()).toEqual({ level: 0.1, lastNonZero: 0.1 });
  });

  it("coalesces a burst of changes into ONE settings write of the last level", () => {
    const v = createMonitorVolume(() => {}, () => {});
    for (const l of [0.1, 0.2, 0.3, 0.4, 0.55]) v.setLevel(l);
    vi.advanceTimersByTime(299);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ monitorVolume: 0.55 });
  });

  it("each change restarts the 300 ms wait", () => {
    const v = createMonitorVolume(() => {}, () => {});
    v.setLevel(0.2);
    vi.advanceTimersByTime(200);
    v.setLevel(0.3);
    vi.advanceTimersByTime(200);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ monitorVolume: 0.3 });
  });

  it("flush() writes a pending level now, and is idempotent", () => {
    const v = createMonitorVolume(() => {}, () => {});
    v.setLevel(0.8);
    v.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ monitorVolume: 0.8 });
    v.flush();
    vi.advanceTimersByTime(1000); // the debounce timer was cancelled too
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing owed writes nothing (mounting never touches settings.json)", () => {
    const v = createMonitorVolume(() => {}, () => {});
    v.flush();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("dispose() lands the pending level and stops notifying subscribers", () => {
    const v = createMonitorVolume(() => {}, () => {});
    const seen: number[] = [];
    v.subscribe((s) => seen.push(s.level));
    v.setLevel(0.45);
    expect(seen).toEqual([0.45]);
    v.dispose();
    expect(write).toHaveBeenCalledWith({ monitorVolume: 0.45 });
    v.setLevel(0.25);
    expect(seen).toEqual([0.45]);
  });

  it("after dispose() a change touches neither the sink nor settings.json", () => {
    const applied: number[] = [];
    const v = createMonitorVolume((l) => applied.push(l), () => {});
    v.setLevel(0.15);
    v.dispose();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ monitorVolume: 0.15 });
    v.setLevel(0.65);
    v.toggleMute();
    vi.advanceTimersByTime(1000);
    v.flush();
    expect(write).toHaveBeenCalledTimes(1); // no late write over the next screen's level
    expect(applied).toEqual([SEED, 0.15]); // the torn-down sink is left alone
    expect(v.get().level).toBe(0.15);
  });

  it("an unsubscribed listener is not called again", () => {
    const v = createMonitorVolume(() => {}, () => {});
    const seen: number[] = [];
    const off = v.subscribe((s) => seen.push(s.level));
    v.setLevel(0.6);
    off();
    v.setLevel(0.7);
    expect(seen).toEqual([0.6]);
  });

  it("a failed write is reported to the caller, not swallowed", async () => {
    const boom = new Error("settings.json is read-only");
    write.mockImplementation(() => Promise.reject(boom));
    const errors: unknown[] = [];
    const v = createMonitorVolume(() => {}, (e) => errors.push(e));
    v.setLevel(0.9);
    v.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([boom]);
  });
});
