import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "./session";
import { normalizeChord } from "./shortcuts";
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "./types";
import type { ActionId } from "./types";

/** Settings are persisted opaquely by the Rust side (serde_json::Value), so the
 *  frontend is the ONLY sanitizer between a hand-edited or corrupted
 *  settings.json and app mount. Each hostile value below was verified to break
 *  something real under the old defaults-spread. */
describe("sanitizeSettings", () => {
  /** One hostile value per field, plus a shortcuts map with a non-string
   *  binding, a null binding and an unknown extra action. */
  const hostile: unknown = {
    schema: "one",
    theme: { dark: true }, // cosmetic breakage
    autosaveSeconds: "soon", // Math.max(1, NaN) → setInterval(fn, NaN) = 4 ms
    defaultExportDir: 42, // escapeHtml's s.replace throws
    lastExportDir: [], // ditto
    hardwareAccel: "false", // truthy string reads as ON
    cacheLimitMB: null,
    proxyMedia: "true",
    snapCenterGuides: 0,
    tempOpenWith: "yes",
    monitorVolume: "loud",
    shortcuts: {
      playPause: "Ctrl+Space", // legitimate rebind: must survive
      split: 7, // normalizeChord: stored.split is not a function
      undo: null,
      notAnAction: "Ctrl+Q", // extra key the old spread merged straight in
    },
  };

  it("never throws and returns every field at its declared type", () => {
    const s = sanitizeSettings(hostile);
    expect(s.schema).toBe(1);
    expect(["dark", "light", "system"]).toContain(s.theme);
    expect(typeof s.autosaveSeconds).toBe("number");
    expect(s.defaultExportDir).toBeNull();
    expect(s.lastExportDir).toBeNull();
    expect(typeof s.hardwareAccel).toBe("boolean");
    expect(typeof s.cacheLimitMB).toBe("number");
    expect(typeof s.proxyMedia).toBe("boolean");
    expect(typeof s.snapCenterGuides).toBe("boolean");
    expect(typeof s.tempOpenWith).toBe("boolean");
    expect(typeof s.monitorVolume).toBe("number");
  });

  it("keeps autosaveSeconds finite and >= 1 (setInterval must not hit 4 ms)", () => {
    for (const raw of ["soon", NaN, Infinity, -Infinity, null, undefined, 0, -5, 0.001, {}]) {
      const s = sanitizeSettings({ autosaveSeconds: raw });
      expect(Number.isFinite(s.autosaveSeconds)).toBe(true);
      expect(s.autosaveSeconds).toBeGreaterThanOrEqual(1);
    }
    expect(sanitizeSettings({ autosaveSeconds: "soon" }).autosaveSeconds).toBe(
      DEFAULT_SETTINGS.autosaveSeconds,
    );
    // a stringified number is a plausible hand-edit and is accepted
    expect(sanitizeSettings({ autosaveSeconds: "10" }).autosaveSeconds).toBe(10);
  });

  it("drops non-string and unknown shortcut entries, keeping valid rebinds", () => {
    const s = sanitizeSettings(hostile);
    expect(s.shortcuts.playPause).toBe("Ctrl+Space");
    expect(s.shortcuts.split).toBe(DEFAULT_SHORTCUTS.split);
    expect(s.shortcuts.undo).toBe(DEFAULT_SHORTCUTS.undo);
    expect(Object.keys(s.shortcuts).sort()).toEqual(Object.keys(DEFAULT_SHORTCUTS).sort());
    expect(Object.keys(s.shortcuts)).not.toContain("notAnAction");
    // the actual crash site: every surviving binding must be chord-normalizable
    for (const chord of Object.values(s.shortcuts)) {
      expect(typeof chord).toBe("string");
      expect(() => normalizeChord(chord)).not.toThrow();
    }
  });

  it("never mutates the shared DEFAULT_SHORTCUTS object", () => {
    sanitizeSettings({ shortcuts: { split: "Ctrl+Alt+P" } });
    expect(DEFAULT_SHORTCUTS.split).toBe("S");
  });

  it("falls back wholesale for a non-object payload", () => {
    for (const raw of [null, undefined, 0, "", "settings", [], true]) {
      const s = sanitizeSettings(raw);
      expect(s).toEqual(DEFAULT_SETTINGS);
      expect(s.shortcuts).not.toBe(DEFAULT_SHORTCUTS); // fresh copy
    }
  });

  it("clamps numbers into their valid ranges", () => {
    expect(sanitizeSettings({ monitorVolume: 5 }).monitorVolume).toBe(1);
    expect(sanitizeSettings({ monitorVolume: -2 }).monitorVolume).toBe(0);
    expect(sanitizeSettings({ monitorVolume: 0.35 }).monitorVolume).toBe(0.35);
    expect(sanitizeSettings({ monitorVolume: "loud" }).monitorVolume).toBe(
      DEFAULT_SETTINGS.monitorVolume,
    );
    expect(sanitizeSettings({ cacheLimitMB: -1 }).cacheLimitMB).toBe(1);
    expect(sanitizeSettings({ cacheLimitMB: 5120 }).cacheLimitMB).toBe(5120);
  });

  it("passes a fully valid settings object through unchanged", () => {
    const valid = {
      ...DEFAULT_SETTINGS,
      theme: "light" as const,
      autosaveSeconds: 10,
      defaultExportDir: "D:\\Exports",
      lastExportDir: "D:\\Exports\\2026",
      hardwareAccel: false,
      cacheLimitMB: 5120,
      proxyMedia: false,
      snapCenterGuides: false,
      tempOpenWith: true,
      monitorVolume: 0.5,
      shortcuts: { ...DEFAULT_SHORTCUTS, split: "Ctrl+Alt+S" } as Record<ActionId, string>,
    };
    expect(sanitizeSettings(valid)).toEqual(valid);
  });
});
