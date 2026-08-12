import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, normalizeSettingsRead } from "./ipc";
import { createProject } from "./project";
import {
  CARD_RESCUE_RATIO,
  contrastRatioHex,
  CUSTOM_THEME_VARS,
  deriveCustomTheme,
  initSettings,
  NAV_RESCUE_RATIO,
  needsAppearanceRescue,
  needsChromeRescue,
  needsNavRescue,
  normalizeHexColor,
  ProjectSession,
  SAFE_APPEARANCE,
  SAFE_THEME_VARS,
  sanitizeSettings,
  settingsLoadFailure,
  settingsStore,
  updateSettings,
} from "./session";
import { normalizeChord } from "./shortcuts";
import { Store } from "./store";
import { DEFAULT_CUSTOM_THEME, DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "./types";
import type { ActionId, CustomTheme, Settings } from "./types";

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
    customTheme: { background: 0xff0000, accent: "javascript:alert(1)", text: ["#fff"] },
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
    expect(s.customTheme).toEqual(DEFAULT_CUSTOM_THEME);
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
      customTheme: { background: "#101820", accent: "#ff8800", text: "#e8e8ff" },
      shortcuts: { ...DEFAULT_SHORTCUTS, split: "Ctrl+Alt+S" } as Record<ActionId, string>,
    };
    expect(sanitizeSettings(valid)).toEqual(valid);
  });
});

/* ---------------- custom theme colours ---------------- */

const HEX6 = /^#[0-9a-f]{6}$/;
const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.\d+\)$/;
const FALLBACK = "#6c7cff";

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The largest per-channel difference between two colours. Contrast ratio is
 *  blind to hue, so it is the wrong tool for "are these two fills telling the
 *  user different things". */
function channelDistance(a: string, b: string): number {
  const x = channels(a);
  const y = channels(b);
  return Math.max(...[0, 1, 2].map((i) => Math.abs(x[i]! - y[i]!)));
}

/** Derivation constants are measured against the shipped palette, so "close to
 *  what shipped" is the real assertion — an exact match would only pin this
 *  test to its own rounding. */
function expectNear(actual: string, expected: string, tol = 4): void {
  const a = channels(actual);
  const e = channels(expected);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(a[i]! - e[i]!)).toBeLessThanOrEqual(tol);
  }
}

/** A regular lattice of the RGB cube — 216 colours at the default step, enough
 *  to cover every hue, both extremes and the mid-luminance band where the
 *  contrast rules bite. */
function rgbCube(step = 51): string[] {
  const out: string[] = [];
  for (let r = 0; r <= 255; r += step) {
    for (let g = 0; g <= 255; g += step) {
      for (let b = 0; b <= 255; b += step) {
        out.push(`#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
      }
    }
  }
  return out;
}

/** A custom theme colour is written straight into a CSS custom property and an
 *  inline `background:`, and settings.json is opaque to the backend — so it can
 *  arrive as literally anything. v0.7.2's `parse_color` hole was exactly this
 *  shape: match on a length, then slice by index. The rule here is that the
 *  WHOLE string is proven before any character is read positionally. */
describe("normalizeHexColor", () => {
  it("rejects every non-string payload", () => {
    for (const raw of [null, undefined, 0, 0xff0000, NaN, true, [], {}, ["#ff0000"], () => "#f00"]) {
      expect(normalizeHexColor(raw, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("rejects wrong-length and malformed hex", () => {
    for (const raw of ["", "#", "#f", "#ff", "#ffff", "#fffff", "#fffffff", "ff", "#12345"]) {
      expect(normalizeHexColor(raw, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("rejects non-hex characters, including a multi-byte char mid-string", () => {
    // "#aaaaaÀa" is the crafted shape that panicked parse_color: 8 chars but 9
    // bytes, so a byte-indexed slice landed mid-character. Here it must simply
    // fail the whole-string check.
    for (const raw of ["#aaaaaÀa", "#aaaaÀ", "#gggggg", "#12345z", "#ff 000", "#ff-000", "#ффffff"]) {
      expect(normalizeHexColor(raw, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("rejects URLs, CSS injection and colour names", () => {
    for (const raw of [
      "javascript:alert(1)",
      "url(x)",
      "#ff0000; --bg-app: #ff0000",
      "red",
      "var(--accent)",
      "rgb(1,2,3)",
      "#ff0000)",
    ]) {
      expect(normalizeHexColor(raw, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("rejects an absurdly long string", () => {
    expect(normalizeHexColor("#".repeat(1_000_000), FALLBACK)).toBe(FALLBACK);
    expect(normalizeHexColor(`#ff0000${" ".repeat(500_000)}`, FALLBACK)).toBe(FALLBACK);
    expect(normalizeHexColor("a".repeat(200_000), FALLBACK)).toBe(FALLBACK);
  });

  it("accepts #rgb, #rrggbb and bare hex, normalising to lowercase #rrggbb", () => {
    expect(normalizeHexColor("#6c7cff", FALLBACK)).toBe("#6c7cff");
    expect(normalizeHexColor("#6C7CFF", FALLBACK)).toBe("#6c7cff");
    expect(normalizeHexColor("6c7cff", FALLBACK)).toBe("#6c7cff");
    expect(normalizeHexColor("#abc", FALLBACK)).toBe("#aabbcc");
    expect(normalizeHexColor("ABC", FALLBACK)).toBe("#aabbcc");
    expect(normalizeHexColor("  #abc  ", FALLBACK)).toBe("#aabbcc");
    expect(normalizeHexColor("#000", FALLBACK)).toBe("#000000");
  });

  it("only ever returns an exact #rrggbb literal", () => {
    const inputs: unknown[] = [
      null, 42, "red", "#abc", "#ABCDEF", "javascript:x", "#ff0000; x", "a".repeat(50), {},
    ];
    for (const raw of inputs) expect(normalizeHexColor(raw, FALLBACK)).toMatch(HEX6);
  });
});

describe("custom theme sanitation", () => {
  it("falls back per field and never aliases the shared default", () => {
    const s = sanitizeSettings({
      customTheme: { background: "javascript:alert(1)", accent: "#0F8", text: 42 },
    });
    expect(s.customTheme.background).toBe(DEFAULT_CUSTOM_THEME.background);
    expect(s.customTheme.accent).toBe("#00ff88");
    expect(s.customTheme.text).toBe(DEFAULT_CUSTOM_THEME.text);
    expect(s.customTheme).not.toBe(DEFAULT_CUSTOM_THEME);
    expect(sanitizeSettings({}).customTheme).not.toBe(DEFAULT_CUSTOM_THEME);
  });

  it("survives a customTheme that is not an object at all", () => {
    for (const raw of [null, undefined, 0, "", "custom", [], true, () => 0]) {
      const s = sanitizeSettings({ customTheme: raw });
      expect(s.customTheme).toEqual(DEFAULT_CUSTOM_THEME);
      expect(s.customTheme.background).toMatch(HEX6);
      expect(s.customTheme.accent).toMatch(HEX6);
      expect(s.customTheme.text).toMatch(HEX6);
    }
  });

  it("rejects a hostile value in every field, one field at a time", () => {
    const hostileValues: unknown[] = [
      null,
      undefined,
      42,
      true,
      [],
      {},
      "red",
      "#12345",
      "#aaaaaÀa",
      "javascript:alert(1)",
      "#ff0000; --bg-app: #000000",
      "url(x)",
      "var(--accent)",
      "x".repeat(200_000),
    ];
    for (const field of ["background", "accent", "text"] as const) {
      for (const bad of hostileValues) {
        const s = sanitizeSettings({ customTheme: { ...DEFAULT_CUSTOM_THEME, [field]: bad } });
        expect(s.customTheme[field]).toBe(DEFAULT_CUSTOM_THEME[field]);
        // The other two must survive untouched — a bad field is not a reason to
        // throw away the whole theme.
        for (const other of ["background", "accent", "text"] as const) {
          expect(s.customTheme[other]).toMatch(HEX6);
        }
      }
    }
  });

  it('accepts theme:"custom" and still rejects unknown themes', () => {
    expect(sanitizeSettings({ theme: "custom" }).theme).toBe("custom");
    for (const raw of ["Custom", "neon", 7, null, { custom: true }]) {
      expect(sanitizeSettings({ theme: raw }).theme).toBe(DEFAULT_SETTINGS.theme);
    }
  });
});

/** The pre-release v0.7.4 shape. A settings.json carrying it is already on disk
 *  in this tree, so `base` — an ENUM where a colour now lives — MUST NOT reach
 *  normalizeHexColor as a colour and MUST NOT produce a fallback that throws the
 *  user's dark/light choice away. */
describe("custom theme migration from base/primary/secondary", () => {
  it('maps base:"dark" to the stock dark background and text', () => {
    const c = sanitizeSettings({
      customTheme: { base: "dark", primary: "#ff8800", secondary: "#00c2a8" },
    }).customTheme;
    expect(c).toEqual({ background: "#111113", accent: "#ff8800", text: "#ececf1" });
  });

  it('maps base:"light" to the stock light background and text', () => {
    const c = sanitizeSettings({
      customTheme: { base: "light", primary: "#ff8800", secondary: "#00c2a8" },
    }).customTheme;
    expect(c).toEqual({ background: "#f6f6f8", accent: "#ff8800", text: "#1b1b20" });
  });

  it("keeps a legacy theme readable after migration", () => {
    for (const base of ["dark", "light"]) {
      const c = sanitizeSettings({
        customTheme: { base, primary: "#ff8800", secondary: "#00c2a8" },
      }).customTheme;
      const v = deriveCustomTheme(c).vars;
      expect(contrastRatioHex(v["--text-1"], v["--bg-panel"])).toBeGreaterThanOrEqual(4.5);
      expect(deriveCustomTheme(c).surface).toBe(base);
    }
  });

  it("does not read a legacy enum as a colour", () => {
    // "dark"/"light"/"neon" are not hex; the migration must supply the colour,
    // not normalizeHexColor's generic fallback path.
    const c = sanitizeSettings({ customTheme: { base: "light" } }).customTheme;
    expect(c.background).toBe("#f6f6f8");
    expect(c.background).not.toBe(DEFAULT_CUSTOM_THEME.background);
    // An unrecognised enum is dark, exactly as the old sanitizer treated it.
    expect(sanitizeSettings({ customTheme: { base: "neon" } }).customTheme).toEqual(
      DEFAULT_CUSTOM_THEME,
    );
  });

  it("prefers the new keys when a file carries both shapes", () => {
    const c = sanitizeSettings({
      customTheme: {
        base: "light",
        primary: "#ff8800",
        secondary: "#00c2a8",
        background: "#0a0a12",
        accent: "#22cc88",
        text: "#f0f0ff",
      },
    }).customTheme;
    expect(c).toEqual({ background: "#0a0a12", accent: "#22cc88", text: "#f0f0ff" });
  });

  it("falls back to the legacy value only when the new one is missing or invalid", () => {
    const c = sanitizeSettings({
      customTheme: { base: "light", primary: "#ff8800", accent: "not-a-colour" },
    }).customTheme;
    expect(c.accent).toBe("#ff8800");
    // …and a hostile legacy value falls all the way through to the default.
    const d = sanitizeSettings({
      customTheme: { primary: "javascript:alert(1)", accent: {} },
    }).customTheme;
    expect(d.accent).toBe(DEFAULT_CUSTOM_THEME.accent);
  });
});

/** The stock LIGHT palette expressed in the new three-colour model: --bg-app,
 *  --accent and --text-1 of `html[data-theme="light"]`. */
const LIGHT_STOCK: CustomTheme = {
  background: "#f6f6f8",
  accent: "#5563e8",
  text: "#1b1b20",
};

/** Named backgrounds worth calling out: the two shipped ones, both extremes, a
 *  strongly tinted dark and light, a saturated hue whose luminance puts it on
 *  the LIGHT side of the ink crossover, two mid-grays either side of it, and an
 *  olive that used to be the worst case for the old contrast search. */
const BACKGROUNDS = [
  "#111113",
  "#f6f6f8",
  "#000000",
  "#ffffff",
  "#241a3d",
  "#fff4e0",
  "#ff0000",
  "#606060",
  "#8a8a8a",
  "#666600",
];

/** What the "used verbatim" sweeps run over. A hand-picked list is exactly how
 *  a colour test passes by construction, so the named backgrounds are only a
 *  seed — the cube is what makes a role-confusion or a stray rewrite fail. */
const SWEEP_BACKGROUNDS = [...BACKGROUNDS, ...rgbCube(85)];

/** Every surface token a line of text or a filled control can land on. */
const SURFACE_VARS = [
  "--bg-app",
  "--bg-panel",
  "--bg-raised",
  "--bg-input",
  "--bg-hover",
  "--bg-active",
] as const;

describe("deriveCustomTheme", () => {
  const stock = { ...DEFAULT_CUSTOM_THEME };

  it("emits exactly the themable variables", () => {
    const { vars } = deriveCustomTheme(stock);
    expect(Object.keys(vars).sort()).toEqual([...CUSTOM_THEME_VARS].sort());
    expect(CUSTOM_THEME_VARS).toHaveLength(21);
  });

  it("only ever emits colour literals it built itself, even from hostile input", () => {
    const hostile = [
      "red",
      "javascript:alert(1)",
      "#ff0000; --bg-app: #ff0000",
      "",
      "#",
      "x".repeat(100_000),
      42 as unknown as string,
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const bad of hostile) {
      for (const theme of [
        { background: bad, accent: bad, text: bad },
        { background: bad, accent: stock.accent, text: stock.text },
        { background: "#ffffff", accent: bad, text: bad },
      ]) {
        const { vars } = deriveCustomTheme(theme);
        for (const name of CUSTOM_THEME_VARS) {
          const value = vars[name];
          expect(HEX6.test(value) || RGBA.test(value)).toBe(true);
        }
      }
    }
  });

  it("reproduces the shipped dark palette from the stock colours", () => {
    const { vars: v, surface } = deriveCustomTheme(stock);
    expect(surface).toBe("dark");
    // The three the user picked come back untouched, and the derived ramp
    // reproduces the built-in Dark theme it was measured from.
    expect(v["--bg-app"]).toBe("#111113");
    expect(v["--accent"]).toBe("#6c7cff");
    expect(v["--text-1"]).toBe("#ececf1");
    expect(v["--accent-dim"]).toBe("rgba(108, 124, 255, 0.15)");
    // The ONE token where a custom theme deliberately diverges from built-in
    // Dark: the ink on accent surfaces is the background, not white. That is
    // what makes the home brand mark a background-coloured "T" on accent.
    expect(v["--on-accent"]).toBe("#111113");
    expect(v["--bg-panel"]).toBe("#17171a");
    expectNear(v["--bg-raised"], "#1d1d21", 2);
    expectNear(v["--bg-input"], "#1a1a1e", 2);
    expectNear(v["--bg-hover"], "#242429", 2);
    expectNear(v["--bg-active"], "#2b2b31", 2);
    expectNear(v["--border"], "#26262c", 2);
    expectNear(v["--border-strong"], "#35353d", 2);
    expectNear(v["--ruler-tick"], "#4a4a55", 3);
    expectNear(v["--text-2"], "#a4a4af", 8);
    expectNear(v["--text-3"], "#6e6e79", 8);
    expectNear(v["--accent-strong"], "#8592ff");
    expectNear(v["--clip-video-bg"], "#2c3253");
    expectNear(v["--clip-video-border"], "#4a54a0");
  });

  it("reproduces the shipped light palette from the light stock colours", () => {
    const { vars: v, surface } = deriveCustomTheme(LIGHT_STOCK);
    expect(surface).toBe("light");
    expect(v["--bg-app"]).toBe("#f6f6f8");
    expect(v["--accent"]).toBe("#5563e8");
    expect(v["--text-1"]).toBe("#1b1b20");
    expect(v["--accent-dim"]).toBe("rgba(85, 99, 232, 0.12)");
    expect(v["--bg-panel"]).toBe("#ffffff");
    expect(v["--bg-raised"]).toBe("#ffffff");
    expectNear(v["--bg-input"], "#f2f2f5", 2);
    expectNear(v["--bg-hover"], "#efeff2", 2);
    expectNear(v["--bg-active"], "#e7e7ec", 2);
    expectNear(v["--border"], "#e4e4e9", 2);
    expectNear(v["--border-strong"], "#cfcfd8", 2);
    expectNear(v["--ruler-tick"], "#b9b9c4", 3);
    expectNear(v["--text-2"], "#5b5b66", 8);
    expectNear(v["--text-3"], "#8f8f9b", 10);
    expectNear(v["--clip-video-bg"], "#dfe3fa", 8);
    expectNear(v["--clip-video-border"], "#8b96e8", 8);
    // The shipped light hover also desaturates slightly; the derivation
    // deliberately preserves the user's saturation and only moves lightness,
    // so it lands in the same shade a little more vividly.
    expectNear(v["--accent-strong"], "#4351d6", 16);
  });

  /* ---------------- the picks are used verbatim ---------------- */

  it("uses all three picks verbatim, whatever their contrast", () => {
    // The headline guarantee, and the one the old contrast clamps broke: no
    // pick is ever rewritten. 48816 triples, sweeping the cube rather than a
    // hand-picked list, because a hand-picked list is how a colour test passes
    // by construction. accent and text are deliberately DIFFERENT colours on
    // every row, so a derivation that confused the two roles cannot survive.
    const cube = rgbCube();
    for (const background of SWEEP_BACKGROUNDS) {
      for (let i = 0; i < cube.length; i++) {
        const accent = cube[i]!;
        const text = cube[(i + 97) % cube.length]!;
        const { vars: v } = deriveCustomTheme({ background, accent, text });
        expect(v["--bg-app"], `background ${background}`).toBe(background);
        expect(v["--accent"], `accent ${accent} on ${background}`).toBe(accent);
        expect(v["--text-1"], `text ${text} on ${background}`).toBe(text);
        // The rule for the ink on accent surfaces, over the same sweep.
        expect(v["--on-accent"], `on-accent for ${background}`).toBe(background);
      }
    }
  });

  it("uses a pick verbatim even when it makes the app unreadable", () => {
    // Every one of these is a legal theme now. The assertion that MATTERS is
    // the last one: if anything still nudged a colour for readability, the
    // measured contrast would climb off 1:1 and this would fail.
    for (const c of ["#000000", "#ffffff", "#808080", "#6c7cff", "#123456", "#666600"]) {
      const { vars: v } = deriveCustomTheme({ background: c, accent: c, text: c });
      expect(v["--bg-app"], c).toBe(c);
      expect(v["--accent"], c).toBe(c);
      expect(v["--text-1"], c).toBe(c);
      expect(v["--on-accent"], c).toBe(c);
      expect(contrastRatioHex(v["--text-1"], v["--bg-panel"]), c).toBeLessThan(1.5);
      expect(contrastRatioHex(v["--accent"], v["--bg-panel"]), c).toBeLessThan(1.5);
    }
  });

  it("keeps hue, saturation and lightness of a pick that would once have moved", () => {
    // Near-black ink on a near-black app: the old derivation walked both of
    // these lighter until they cleared a floor. Now they arrive as chosen.
    const dark = deriveCustomTheme({ background: "#111113", accent: "#0d0d18", text: "#191922" });
    expect(dark.vars["--accent"]).toBe("#0d0d18");
    expect(dark.vars["--text-1"]).toBe("#191922");
    // …and the mirror image on a near-white app.
    const light = deriveCustomTheme({ background: "#f6f6f8", accent: "#f2f2ff", text: "#eeeef4" });
    expect(light.vars["--accent"]).toBe("#f2f2ff");
    expect(light.vars["--text-1"]).toBe("#eeeef4");
  });

  /* ---------------- --on-accent is the background ---------------- */

  it("draws the ink on accent surfaces in the background colour", () => {
    // The home brand mark is `background: var(--accent); color: var(--on-accent)`,
    // so this is literally "a background-coloured T in an accent-coloured tile".
    // Named separately from the sweep above because it is a product rule, not a
    // range check: it must hold for the stock colours too.
    expect(deriveCustomTheme(stock).vars["--on-accent"]).toBe(stock.background);
    expect(deriveCustomTheme(LIGHT_STOCK).vars["--on-accent"]).toBe(LIGHT_STOCK.background);
    // Changing the accent must not move it; changing the background must.
    expect(deriveCustomTheme({ ...stock, accent: "#ffff00" }).vars["--on-accent"]).toBe("#111113");
    expect(deriveCustomTheme({ ...stock, background: "#3a0f0f" }).vars["--on-accent"]).toBe(
      "#3a0f0f",
    );
    // It tracks the background even where that is plainly illegible on the
    // accent — no contrast test survives anywhere in this path.
    const same = deriveCustomTheme({ background: "#6c7cff", accent: "#6c7cff", text: "#000000" });
    expect(same.vars["--on-accent"]).toBe("#6c7cff");
    expect(contrastRatioHex(same.vars["--on-accent"], same.vars["--accent"])).toBe(1);
  });

  /* ---------------- what IS still derived ---------------- */

  it("derives the surface ramp from the background alone", () => {
    // The accent and the text must not leak into a single surface token.
    const a = deriveCustomTheme({ background: "#241a3d", accent: "#6c7cff", text: "#ececf1" }).vars;
    const b = deriveCustomTheme({ background: "#241a3d", accent: "#ff0000", text: "#00ff00" }).vars;
    for (const name of [...SURFACE_VARS, "--border", "--border-strong", "--ruler-tick"] as const) {
      expect(b[name], name).toBe(a[name]);
    }
  });

  it("derives the quieter text steps between the pick and the panel", () => {
    // --text-2 and --text-3 are the text colour walked toward the panel by two
    // fixed fractions, so in EVERY channel each step sits between the pick and
    // the panel, and --text-3 (the hint step) sits closer to the panel than
    // --text-2. The ±1 slack is mix()'s rounding, nothing else.
    //
    // Asserted in channel space rather than as a contrast ordering because
    // contrast is NOT monotonic along that walk: on an #ff0000 app the walk
    // raises red while lowering green and blue, and the quietest step measures
    // a HIGHER ratio (1.17:1) than the middle one (1.09:1). A ratio-ordering
    // assertion reads plausible and is simply false.
    for (const background of BACKGROUNDS) {
      for (const text of ["#ffffff", "#000000", "#8a8a8a", "#3a2f55", "#ffe08a"]) {
        const { vars: v } = deriveCustomTheme({ background, accent: "#6c7cff", text });
        const where = `bg ${background}, text ${text}`;
        expect(v["--text-1"], where).toBe(text);
        const pick = channels(v["--text-1"]);
        const panel = channels(v["--bg-panel"]);
        const two = channels(v["--text-2"]);
        const three = channels(v["--text-3"]);
        for (let i = 0; i < 3; i++) {
          const lo = Math.min(pick[i]!, panel[i]!) - 1;
          const hi = Math.max(pick[i]!, panel[i]!) + 1;
          expect(two[i]!, `${where} ch${i}`).toBeGreaterThanOrEqual(lo);
          expect(two[i]!, `${where} ch${i}`).toBeLessThanOrEqual(hi);
          expect(three[i]!, `${where} ch${i}`).toBeGreaterThanOrEqual(lo);
          expect(three[i]!, `${where} ch${i}`).toBeLessThanOrEqual(hi);
          expect(
            Math.abs(three[i]! - panel[i]!),
            `${where} ch${i}: the hint step must be the quieter one`,
          ).toBeLessThanOrEqual(Math.abs(two[i]! - panel[i]!) + 1);
        }
      }
    }
  });

  /* ---------------- surface direction + ramp ---------------- */

  it("reads the surface direction off the background's luminance", () => {
    for (const [background, want] of [
      ["#111113", "dark"],
      ["#000000", "dark"],
      ["#241a3d", "dark"],
      ["#606060", "dark"],
      ["#f6f6f8", "light"],
      ["#ffffff", "light"],
      ["#fff4e0", "light"],
      // Pure red is a LIGHT surface: black on it reads 5.25:1, white only 4.0:1.
      ["#ff0000", "light"],
      ["#8a8a8a", "light"],
    ] as const) {
      expect(deriveCustomTheme({ ...stock, background }).surface, background).toBe(want);
    }
  });

  it("derives a surface ramp that separates from the background in both directions", () => {
    for (const background of BACKGROUNDS) {
      const { vars: v } = deriveCustomTheme({ ...stock, background });
      // Panels must be distinguishable from the page, and the strong border
      // from the plain one, whatever the background is.
      expect(v["--bg-panel"], background).not.toBe(v["--bg-active"]);
      expect(v["--border"], background).not.toBe(v["--border-strong"]);
      expect(contrastRatioHex(v["--border-strong"], v["--bg-app"])).toBeGreaterThan(
        contrastRatioHex(v["--border"], v["--bg-app"]),
      );
      expect(contrastRatioHex(v["--ruler-tick"], v["--bg-app"])).toBeGreaterThan(
        contrastRatioHex(v["--border-strong"], v["--bg-app"]),
      );
    }
  });

  it("keeps the surface ramp on the background's own hue", () => {
    // A tinted background must not decay into gray panels.
    const { vars: v } = deriveCustomTheme({ ...stock, background: "#241a3d" });
    for (const name of ["--bg-panel", "--bg-raised", "--bg-hover", "--border"] as const) {
      const [r, g, b] = channels(v[name]);
      expect(b, `${name} should stay violet`).toBeGreaterThan(r);
      expect(r).toBeGreaterThan(g);
    }
  });

  it("draws the waveform in the accent and keeps it off its own clip fill", () => {
    // The wave IS the accent; the audio clip it sits on is that same accent
    // mixed most of the way to the panel, so the two separate by the mix amount
    // whatever colour was chosen. Measured as a channel distance, not a
    // contrast ratio — two fills can be equally bright and still obviously
    // different colours.
    for (const background of BACKGROUNDS) {
      for (const accent of ["#000000", "#ffffff", "#808080", "#ff0000", "#6fd3ae", "#0a2f22"]) {
        const { vars: v } = deriveCustomTheme({ background, accent, text: "#ececf1" });
        expect(v["--wave"], `${background}/${accent}`).toBe(accent);
        // Only degenerate when the accent already IS the panel, which is the
        // user asking for an invisible waveform.
        if (v["--accent"] !== v["--bg-panel"]) {
          expect(
            channelDistance(v["--wave"], v["--clip-audio-bg"]),
            `${background}/${accent}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps video and audio clips distinguishable from each other and their lane", () => {
    // Both clip families are the accent now, so the only thing keeping a video
    // clip apart from an audio one is the deliberately different mix. Measured
    // as a channel distance, not a contrast ratio: two fills can be equally
    // bright and still obviously different colours, which is the whole point.
    for (const background of BACKGROUNDS) {
      const { vars: v } = deriveCustomTheme({ ...stock, background });
      expect(channelDistance(v["--clip-video-bg"], v["--clip-audio-bg"]), background).toBeGreaterThan(
        6,
      );
      expect(channelDistance(v["--clip-video-border"], v["--bg-panel"]), background).toBeGreaterThan(
        12,
      );
    }
  });

  it("derives a hover shade that moves away from the background", () => {
    const dark = deriveCustomTheme({ ...stock, accent: "#3344aa" });
    const light = deriveCustomTheme({ ...LIGHT_STOCK, accent: "#3344aa" });
    // dark surface → hover is lighter; light surface → hover is darker
    expect(contrastRatioHex(dark.vars["--accent-strong"], "#000000")).toBeGreaterThan(
      contrastRatioHex(dark.vars["--accent"], "#000000"),
    );
    expect(contrastRatioHex(light.vars["--accent-strong"], "#000000")).toBeLessThan(
      contrastRatioHex(light.vars["--accent"], "#000000"),
    );
  });
});

/* ---------------- the escape hatch ---------------- */

/**
 * Every (ink, surface) pair the Appearance card and the colour picker actually
 * PAINT, read off the two stylesheets. This is what the card renders — not what
 * the rescue is gated on. The two are deliberately different sets now; see
 * `GATE_PAIRS` below.
 *
 * NOT the three-ink × three-surface cross product it looks like it should be.
 * That shape measures `--text-2`/`--bg-panel`, `--text-2`/`--bg-input` and
 * `--text-3`/`--bg-input`, none of which is painted anywhere (the quiet inks
 * only appear on buttons and inside the popover), while missing `--bg-hover` and
 * `--bg-active` entirely.
 */
const PAINTED_PAIRS = [
  // .settings__row-label, on the .card itself.
  ["--text-1", "--bg-panel"],
  // .btn labels: each colour button, and the picker's Done / Reset to default.
  ["--text-1", "--bg-raised"],
  // The segmented control's own track, and the picker's .cp__hex field.
  ["--text-1", "--bg-input"],
  // The same buttons under the pointer, and pressed.
  ["--text-1", "--bg-hover"],
  ["--text-1", "--bg-active"],
  // The mono hex caption inside each colour button, and .cp__title.
  ["--text-2", "--bg-raised"],
  ["--text-2", "--bg-hover"],
  ["--text-2", "--bg-active"],
  // The "Appearance" section head and every row hint — the faintest tier.
  ["--text-3", "--bg-panel"],
  // .cp__slider-label, inside the popover.
  ["--text-3", "--bg-raised"],
] as const;

/**
 * The pairs the RESCUE IS GATED ON — `--text-1` only, mirroring `CARD_PAIRS` in
 * session.ts. Rebuilt here rather than imported, so the two have to agree
 * instead of moving together.
 *
 * This is a strict subset of what the card paints, and that gap is the whole
 * decision. Recovery needs exactly two things visible: the unselected
 * Dark/Light/System segments, and the picker's "Reset to default". Both are
 * `--text-1` on a `.btn`. Row hints, the mono hex captions and the marker on the
 * SELECTED segment are comfort — losing them makes the card ugly, not
 * inescapable.
 *
 * WHAT THIS GIVES UP, stated plainly because it is a real cost: a theme can now
 * keep the user's colours while its hints and section head are unreadable. The
 * `#6a5f85` fixture below is exactly that theme, and it USED to be the flagship
 * must-fire case. It is now a must-NOT-fire case.
 *
 * The reason is that the wider gate over-fired on themes the owner considered
 * perfectly readable — a dusty-red app whose labels measure 3.6:1 was being
 * rescued because its blue accent went quiet against the derived track, which is
 * precisely the permanently-mismatched panel this release set out to remove.
 * Firing wrongly is not free: it is the eyesore, and it is visible on every
 * ordinary theme rather than only on a broken one.
 */
const GATE_PAIRS = PAINTED_PAIRS.filter(([ink]) => ink === "--text-1");

type SafeVar = keyof (typeof SAFE_APPEARANCE)["dark"];

/** Every painted pair in the fixed escape-hatch palette, for measuring what a
 *  fired rescue actually delivers. Derived from PAINTED_PAIRS, not GATE_PAIRS:
 *  once the card IS rescued, every tier it draws has to be legible, including
 *  the quiet ones the gate no longer consults. */
const SAFE_PAIRS = PAINTED_PAIRS.map(
  ([ink, surface]) =>
    [`--safe-${ink.slice(2)}` as SafeVar, `--safe-${surface.slice(5)}` as SafeVar] as const,
);

/**
 * Settings → Appearance is the ONE surface allowed to stop following the user's
 * colours, because it is the only place a theme that hid everything can be
 * undone. When it does, its palette (and the colour picker's, since "Reset to
 * default" lives there) is a pair of fixed constants selected by the
 * background's direction — so its legibility is a property of those constants
 * and nothing else.
 *
 * These tests measure the real contrast ratios of what actually ships. If one
 * fails, a rescued card can no longer be read, which means a user can be
 * permanently locked out of their own app — do not relax the bar, fix the
 * constants.
 *
 * EVERY CASE HERE FIRST ASSERTS THAT THE RESCUE ACTUALLY FIRES for the theme it
 * is measuring. Before v0.7.5 the card rendered from these constants for every
 * custom theme, so measuring them alone was the whole story; now it is
 * conditional, and a block that measures the safe palette without ever checking
 * it is in use would keep passing while the card had quietly stopped using it.
 * That is the hollow test this file exists to avoid — the trigger itself is
 * covered in "the Appearance card rescue" below.
 */
/** Themes that leave the app with nothing visible at all. Every one is legal —
 *  that is the point of removing the clamps — so every one has to stay
 *  recoverable, both in the card that can undo it (below) and in the control
 *  that reaches that card (the nav rescue, further down). */
const PATHOLOGICAL: CustomTheme[] = [
  { background: "#000000", accent: "#000000", text: "#000000" },
  { background: "#ffffff", accent: "#ffffff", text: "#ffffff" },
  { background: "#808080", accent: "#808080", text: "#808080" },
  { background: "#111113", accent: "#111113", text: "#111113" },
  { background: "#6c7cff", accent: "#6c7cff", text: "#6c7cff" },
  { background: "#f6f6f8", accent: "#f6f6f8", text: "#f6f6f8" },
];

/** What the card actually renders in, for a given user theme — consulted only
 *  when `needsAppearanceRescue` says so, which is why every case below asserts
 *  that first. */
function paletteFor(c: CustomTheme): Record<string, string> {
  return SAFE_APPEARANCE[deriveCustomTheme(c).surface];
}

/** Every all-one-colour theme in the cube, the sweep both the escape hatch and
 *  its trigger are held to: the pathological case is not one colour, it is
 *  every colour. */
const ALL_ONE_COLOUR: CustomTheme[] = rgbCube(51).map((h) => ({
  background: h,
  accent: h,
  text: h,
}));

describe("the Appearance escape hatch", () => {
  it("publishes one literal for every variable, in both directions", () => {
    expect(SAFE_THEME_VARS).toHaveLength(13);
    for (const dir of ["dark", "light"] as const) {
      const p = SAFE_APPEARANCE[dir];
      expect(Object.keys(p).sort()).toEqual([...SAFE_THEME_VARS].sort());
      for (const name of SAFE_THEME_VARS) {
        expect(HEX6.test(p[name]) || RGBA.test(p[name]), `${dir} ${name}`).toBe(true);
      }
    }
  });

  it("names a real published token for every painted pair", () => {
    // The --safe-* names below are DERIVED from PAINTED_PAIRS by string surgery,
    // and a wrong one would not throw: the palette is read as a plain record, so
    // a miss reads as undefined and contrastRatioHex quietly scores it against
    // its #000000 fallback — every ratio would pass and nothing would be tested.
    // Checked once, here, so the rest of the block can index freely.
    expect(SAFE_PAIRS).toHaveLength(10);
    for (const [ink, surface] of SAFE_PAIRS) {
      expect(SAFE_THEME_VARS, `${ink} is not a published token`).toContain(ink);
      expect(SAFE_THEME_VARS, `${surface} is not a published token`).toContain(surface);
      for (const dir of ["dark", "light"] as const) {
        expect(HEX6.test(SAFE_APPEARANCE[dir][ink]), `${dir} ${ink}`).toBe(true);
        expect(HEX6.test(SAFE_APPEARANCE[dir][surface]), `${dir} ${surface}`).toBe(true);
      }
    }
  });

  it("hands a rescued card one of exactly two fixed objects, never a derived one", () => {
    // Identity, not equality: the card is handed one of exactly two fixed
    // objects, so there is no path by which a pick can reach it. This is the
    // whole mechanism — everything below is just measuring those two objects.
    // The rescue is asserted first because that mechanism is only reached when
    // it fires; without this line the case would still pass for a build in
    // which the card had stopped consulting the palette entirely.
    for (const c of [...PATHOLOGICAL, ...ALL_ONE_COLOUR]) {
      expect(needsAppearanceRescue(deriveCustomTheme(c)), c.background).toBe(true);
      const p = paletteFor(c);
      expect(p === SAFE_APPEARANCE.dark || p === SAFE_APPEARANCE.light, c.background).toBe(true);
    }
  });

  it("keeps every label and hex value readable in a card it has rescued", () => {
    // Measured on the pairs the card and the picker really paint, not on a
    // cross product: asserting a ratio for ink that never lands on that surface
    // makes the block look thorough while proving nothing about what a user
    // sees, and it was exactly that shape of mistake in the TRIGGER that
    // rescued readable palettes.
    for (const c of PATHOLOGICAL) {
      const where = `all-${c.background}`;
      expect(needsAppearanceRescue(deriveCustomTheme(c)), `${where}: not rescued at all`).toBe(true);
      const p = paletteFor(c);
      for (const [ink, surface] of SAFE_PAIRS) {
        // The quiet tiers are held lower than the loud ones, but every pair has
        // to clear the bar for a section head or a row hint to be legible at
        // all: --text-3 is the tier the trigger is calibrated on, so a rescue
        // that delivered it at the ratio that triggered it would be pointless.
        const floor = ink === "--safe-text-3" ? 3 : 4.5;
        expect(contrastRatioHex(p[ink]!, p[surface]!), `${where} ${ink} on ${surface}`)
          .toBeGreaterThanOrEqual(floor);
      }
    }
    // What a fired rescue is worth at its weakest, pinned so a retune of
    // SAFE_APPEARANCE cannot quietly erode it: 3.20:1 on the faintest painted
    // pair, 2.1x the 1.5 that triggered the rescue in the first place.
    let worst = Infinity;
    for (const dir of ["dark", "light"] as const) {
      for (const [ink, surface] of SAFE_PAIRS) {
        worst = Math.min(worst, contrastRatioHex(SAFE_APPEARANCE[dir][ink]!, SAFE_APPEARANCE[dir][surface]!));
      }
    }
    expect(worst).toBeCloseTo(3.2, 1);
    expect(worst).toBeGreaterThan(CARD_RESCUE_RATIO * 2);
  });

  it("keeps the theme control operable in a card it has rescued", () => {
    for (const c of PATHOLOGICAL) {
      const where = `all-${c.background}`;
      expect(needsAppearanceRescue(deriveCustomTheme(c)), `${where}: not rescued at all`).toBe(true);
      const p = paletteFor(c);
      // The SELECTED segment (Dark / Light / System / Custom) is --accent-strong
      // ink on the segmented control's BARE track, which is --bg-input.
      //
      // Not on an --accent-dim fill, however much the `.btn--on` rule suggests
      // it: `.settings__segmented .btn { background: transparent }` is a
      // two-class selector and outranks the one-class `.btn--on { background:
      // var(--accent-dim) }` in components.css, so at rest there is no fill to
      // composite. The in-app E2E measures this button at 6.24:1, which is
      // --safe-accent-strong on bare --safe-input to two decimals and NOT the
      // 5.13:1 it would read on a dim fill — the painted pixels agree with the
      // cascade, so this is the number to hold.
      expect(contrastRatioHex(p["--safe-accent-strong"]!, p["--safe-input"]!), `${where} selected`)
        .toBeGreaterThanOrEqual(4.5);
      // With no fill of its own, selection is conveyed by INK ALONE — so what
      // has to be true is not "this fill differs from that fill" (it does not
      // differ; there is one track) but "the selected option's ink is plainly
      // not the unselected options' ink". Measured as a channel distance as well
      // as a ratio, because two colours can be equally bright and still
      // obviously different, which is the entire mechanism here.
      expect(channelDistance(p["--safe-accent-strong"]!, p["--safe-text-1"]!), `${where} selected ink`)
        .toBeGreaterThan(60);
      expect(contrastRatioHex(p["--safe-accent-strong"]!, p["--safe-text-1"]!), `${where} selected ink`)
        .toBeGreaterThan(2);
      // The focus ring, which is how this card is operated from the keyboard.
      for (const surface of ["--safe-panel", "--safe-raised", "--safe-input"] as const) {
        expect(contrastRatioHex(p["--safe-accent"]!, p[surface]!), `${where} ring on ${surface}`)
          .toBeGreaterThanOrEqual(3);
      }
    }
    // The two numbers the selected segment collapses to, pinned. 6.24 is the
    // one the E2E reports from real pixels.
    expect(contrastRatioHex(SAFE_APPEARANCE.dark["--safe-accent-strong"], SAFE_APPEARANCE.dark["--safe-input"]))
      .toBeCloseTo(6.24, 2);
    expect(contrastRatioHex(SAFE_APPEARANCE.light["--safe-accent-strong"], SAFE_APPEARANCE.light["--safe-input"]))
      .toBeCloseTo(5.55, 2);
  });

  it("keeps a colour swatch findable even when the pick matches the card", () => {
    // The three swatches deliberately show the LITERAL picks, so one of them
    // can be exactly the card's own fill. Its outline is drawn in the card's
    // own --border-strong: a hairline by design (the same one every other
    // swatch in the app gets), and the mono hex beside it carries the actual
    // information at 4.5:1 or better.
    for (const dir of ["dark", "light"] as const) {
      const p = SAFE_APPEARANCE[dir];
      expect(contrastRatioHex(p["--safe-border-strong"], p["--safe-panel"]), dir)
        .toBeGreaterThan(1.4);
      expect(contrastRatioHex(p["--safe-border-strong"], p["--safe-border"]), dir)
        .toBeGreaterThan(1.1);
    }
  });

  it("tracks the direction the background implies, so the card is not alien", () => {
    // WHICH of the two palettes a rescue would use, independent of whether this
    // particular theme triggers one. Legibility does not depend on it — both
    // palettes are internally legible — but a dark card on a white app (or the
    // reverse) reads as a rendering bug rather than as the one thing still
    // working.
    expect(paletteFor({ background: "#000000", accent: "#fff", text: "#fff" })).toBe(
      SAFE_APPEARANCE.dark,
    );
    expect(paletteFor({ background: "#ffffff", accent: "#000", text: "#000" })).toBe(
      SAFE_APPEARANCE.light,
    );
    expect(paletteFor({ background: "#241a3d", accent: "#000", text: "#000" })).toBe(
      SAFE_APPEARANCE.dark,
    );
    expect(paletteFor({ background: "#fff4e0", accent: "#000", text: "#000" })).toBe(
      SAFE_APPEARANCE.light,
    );
  });
});

/* ---------------- the Appearance card rescue ---------------- */

/**
 * The trigger for everything above, and the reason that block is worth
 * anything.
 *
 * Until v0.7.5 the card's palette was a STRUCTURAL guarantee: those constants
 * were used for every custom theme, so no user input could reach them. It is
 * now a MEASURED one — the user keeps their own colours until this predicate
 * says the card has stopped working. The two failure directions are not
 * comparable. Firing when it was not needed costs one mismatched card the user
 * can see and re-pick around; failing to fire when it was needed leaves someone
 * permanently unable to undo their own theme, with no other route out. So both
 * directions are asserted here, every fixture carries the ratio it was chosen
 * for, and the ratio is asserted BEFORE the predicate: a fixture that drifts
 * across the line then fails loudly and says which one, instead of silently
 * ceasing to test anything.
 *
 * The ratios are recomputed here from the emitted tokens rather than read back
 * out of the implementation, so a change to which surfaces or inks are measured
 * shows up as a disagreement rather than as two things moving together.
 */
describe("the Appearance card rescue", () => {
  /** Every tier the GATE is made of, measured off what `deriveCustomTheme`
   *  actually emits: `--text-1` on each of the five surfaces the card and the
   *  picker draw it on. An independent recomputation of the same question
   *  `needsAppearanceRescue` asks.
   *
   *  The quiet tiers the card also paints — `--text-2` hex captions, `--text-3`
   *  hints, and the `--accent-strong` marker on the selected segment — are
   *  deliberately absent. They are measured in the escape-hatch block above,
   *  which is about what a FIRED rescue delivers, but they do not decide whether
   *  it fires. See GATE_PAIRS for why. */
  function cardTiers(c: CustomTheme): Record<string, number> {
    const { vars: v } = deriveCustomTheme(c);
    const out: Record<string, number> = {};
    for (const [ink, surface] of GATE_PAIRS) {
      out[`${ink} on ${surface}`] = contrastRatioHex(v[ink], v[surface]);
    }
    return out;
  }

  /** What the predicate compares against CARD_RESCUE_RATIO: the weakest tier. */
  const cardMin = (c: CustomTheme): number => Math.min(...Object.values(cardTiers(c)));
  /** Which tier that is, for a failure message worth reading. */
  const weakestTier = (c: CustomTheme): string =>
    Object.entries(cardTiers(c)).sort((a, b) => a[1] - b[1])[0]![0];
  const rescued = (c: CustomTheme): boolean => needsAppearanceRescue(deriveCustomTheme(c));

  it("gates on the route out, and on nothing else", () => {
    // The shape of the rule, asserted as a fact rather than left implicit in the
    // fixtures: five terms, all of them --text-1, one per surface the card and
    // the picker paint a button label or a row label on. If a quiet tier ever
    // comes back into the gate this fails first and says which.
    expect(GATE_PAIRS).toHaveLength(5);
    for (const [ink] of GATE_PAIRS) expect(ink).toBe("--text-1");
    expect(GATE_PAIRS.map(([, surface]) => surface)).toEqual([
      "--bg-panel",
      "--bg-raised",
      "--bg-input",
      "--bg-hover",
      "--bg-active",
    ]);
    // …and the card still PAINTS more than the gate measures. That difference is
    // the accepted cost, not an oversight.
    expect(PAINTED_PAIRS.length).toBeGreaterThan(GATE_PAIRS.length);
  });

  it("pins the threshold, because the threshold IS the decision", () => {
    // Calibrated on --text-1 against the five surfaces it lands on. The nearest
    // theme either side is 1.4945 (rescued) and 1.7049 (left alone), so the bar
    // has room in both directions — far more than the 1.37/1.53 pair the older
    // multi-tier gate ran on, which is the main robustness argument for the
    // narrower rule. It is numerically equal to NAV_RESCUE_RATIO and that is a
    // coincidence of calibration, not a dependency.
    expect(CARD_RESCUE_RATIO).toBe(1.5);
    expect(CARD_RESCUE_RATIO).toBeGreaterThan(1);
    expect(CARD_RESCUE_RATIO).toBeLessThan(3);
  });

  it("keeps a wide gap between the worst theme it keeps and the best it rescues", () => {
    // The robustness argument, measured rather than asserted in prose. Under the
    // old multi-tier gate these two numbers were 1.37 and 1.53 — 12% apart, so
    // any drift in the derivation moved themes across the line. On --text-1 the
    // band is much wider, which is what makes the fixtures either side stable.
    const worstKept = Math.min(
      ...[
        { background: "#006600", accent: "#00cc00", text: "#660099" },
        { background: "#241a3d", accent: "#ff5fa2", text: "#6a5f85" },
        { background: "#fdf6e3", accent: "#268bd2", text: "#93a1a1" },
        { background: "#002b36", accent: "#268bd2", text: "#839496" },
        { background: "#a86060", accent: "#6c7cff", text: "#ececf1" },
      ].map(cardMin),
    );
    const bestRescued = Math.max(
      ...[
        { background: "#ffffff", accent: "#5563e8", text: "#c8c8c8" },
        { background: "#ffffff", accent: "#5563e8", text: "#d0d0d0" },
        { background: "#000000", accent: "#00ff00", text: "#333333" },
        { background: "#3d1f6e", accent: "#3d1f6e", text: "#3d1f6e" },
      ].map(cardMin),
    );
    expect(bestRescued).toBeCloseTo(1.49, 2);
    expect(worstKept).toBeCloseTo(1.70, 2);
    expect(bestRescued).toBeLessThan(CARD_RESCUE_RATIO);
    expect(worstKept).toBeGreaterThan(CARD_RESCUE_RATIO);
    // 14% of headroom between them, and the threshold sits inside it.
    expect(worstKept / bestRescued).toBeGreaterThan(1.12);
  });

  it("leaves both shipped palettes, fed back in as custom, completely alone", () => {
    for (const [name, c] of [["dark", DEFAULT_CUSTOM_THEME], ["light", LIGHT_STOCK]] as const) {
      expect(cardMin(c), name).toBeGreaterThan(10);
      expect(rescued(c), name).toBe(false);
    }
  });

  it("leaves an ugly, low-contrast, WCAG-failing but usable theme in the user's colours", () => {
    // The half of this feature that is easy to get wrong in the comfortable
    // direction: an app that quietly restyles a card the user CAN read is
    // contrast clamping by another route, and clamping is what this release
    // removed. Every row carries its measured weakest pair, so a fixture that
    // drifts fails on the ratio first and names itself.
    const usable: [CustomTheme, number, string][] = [
      // Both shipped palettes as a user would re-enter them.
      [{ background: "#111113", accent: "#6c7cff", text: "#ececf1" }, 11.95, "stock dark"],
      [{ background: "#f6f6f8", accent: "#5563e8", text: "#1b1b20" }, 13.92, "stock light"],
      // Ordinary themes somebody would actually choose and keep.
      [{ background: "#1c1917", accent: "#f59e0b", text: "#fafaf9" }, 11.69, "warm dark"],
      [{ background: "#0d1b2a", accent: "#4cc9f0", text: "#e0e1dd" }, 9.39, "navy on cyan"],
      [{ background: "#fbf7ef", accent: "#b45309", text: "#3f3f46" }, 8.91, "paper"],
      // Deliberately low contrast, and still nobody's emergency.
      [{ background: "#e5e5e5", accent: "#555555", text: "#4a4a4a" }, 6.22, "gray on gray"],
      // Row labels at 4.70:1 — comfortably readable, hints merely quiet.
      [{ background: "#3b3b46", accent: "#8a8ad0", text: "#b0b0c0" }, 3.42, "muted mid-gray"],
      // Row labels 4.94:1, hints quiet but legible.
      [{ background: "#002b36", accent: "#268bd2", text: "#93a1a1" }, 3.00, "Solarized-like dark"],
    ];
    for (const [c, ratio, where] of usable) {
      expect(cardMin(c), `${where} fixture drifted (weakest: ${weakestTier(c)})`)
        .toBeCloseTo(ratio, 2);
      expect(cardMin(c), `${where} is no longer above the line`).toBeGreaterThan(CARD_RESCUE_RATIO);
      expect(rescued(c), `${where}: the user's readable card was overridden — that is clamping`)
        .toBe(false);
    }
  });

  it("leaves the palettes people actually paste in alone", () => {
    // Named palettes at their real body foreground. A user who reproduces the
    // editor theme they already read code in all day must not be told their
    // Settings card is unreadable, and these are the concrete themes a retune of
    // the threshold would break first. Every one is a WCAG-failing HINT tier and
    // a perfectly ordinary app.
    const palettes: [CustomTheme, number, string][] = [
      [{ background: "#2e3440", accent: "#88c0d0", text: "#d8dee9" }, 6.18, "Nord"],
      [{ background: "#282828", accent: "#d79921", text: "#ebdbb2" }, 7.10, "Gruvbox Dark"],
      [{ background: "#282a36", accent: "#bd93f9", text: "#f8f8f2" }, 9.14, "Dracula"],
      [{ background: "#eff1f5", accent: "#1e66f5", text: "#4c4f69" }, 6.15, "Catppuccin Latte"],
      [{ background: "#1a1b26", accent: "#7aa2f7", text: "#c0caf5" }, 7.67, "Tokyo Night"],
      [{ background: "#282c34", accent: "#61afef", text: "#abb2bf" }, 4.38, "One Dark"],
      [{ background: "#ffffff", accent: "#0969da", text: "#1f2328" }, 14.11, "GitHub Light"],
    ];
    for (const [c, ratio, where] of palettes) {
      expect(cardMin(c), `${where} fixture drifted (weakest: ${weakestTier(c)})`)
        .toBeCloseTo(ratio, 2);
      expect(rescued(c), `${where} was rescued — a real palette lost the user's colours`).toBe(false);
    }
  });

  it("leaves the dusty-red themes alone — the over-fire that forced this rule", () => {
    // The concrete complaint. The owner ran the build, saw the Appearance card
    // still rendering in the fixed palette on themes they considered perfectly
    // readable, and ruled that the card should keep the user's colours at any
    // theme short of genuinely invisible.
    //
    // The middle row is the proven over-fire and the reason the gate narrowed:
    // its row labels measure 3.60:1 — comfortably readable by any standard —
    // and the OLD multi-tier gate rescued it anyway, because the blue accent
    // went quiet (1.47:1) against the derived track. A mismatched panel in the
    // middle of a deliberately coloured app, triggered by a tier that has
    // nothing to do with getting back out.
    const dusty: [CustomTheme, number, number, string][] = [
      [{ background: "#894848", accent: "#6c7cff", text: "#ececf1" }, 3.97, 5.31, "the owner's own screenshot"],
      [{ background: "#a86060", accent: "#6c7cff", text: "#ececf1" }, 2.63, 3.60, "the proven over-fire"],
      [{ background: "#9a5555", accent: "#6c7cff", text: "#ececf1" }, 3.15, 4.30, "between the two"],
    ];
    for (const [c, min, labels, where] of dusty) {
      expect(cardMin(c), `${where} fixture drifted (weakest: ${weakestTier(c)})`)
        .toBeCloseTo(min, 2);
      // The row label specifically, because "the labels are fine and it was
      // rescued anyway" is the whole complaint.
      expect(
        contrastRatioHex(deriveCustomTheme(c).vars["--text-1"], deriveCustomTheme(c).vars["--bg-panel"]),
        `${where}: the row labels drifted`,
      ).toBeCloseTo(labels, 2);
      expect(rescued(c), `${where}: still over-firing on a readable theme`).toBe(false);
    }
  });

  it("no longer fires for a theme whose quiet tiers have gone, which is the accepted trade", () => {
    // THE INVERSION, and it is deliberate — do not "fix" this back.
    //
    // This theme was the flagship must-fire case for two revisions: row labels
    // readable at 2.62:1, hints and section head gone at 1.37:1. The owner's
    // call is that hints are comfort, not an escape route: what recovery needs
    // is the unselected Dark/Light/System segments and the picker's "Reset to
    // default", and both of those are --text-1 on a .btn. So this theme now
    // keeps the user's colours, with its hints unreadable, on purpose.
    //
    // What that costs is real and worth restating: a user on this theme opens
    // Settings, cannot read the row hints, and CAN still read every label and
    // reach every control that changes the theme.
    const c: CustomTheme = { background: "#241a3d", accent: "#ff5fa2", text: "#6a5f85" };
    const { vars: v } = deriveCustomTheme(c);
    expect(cardMin(c), `fixture drifted (weakest: ${weakestTier(c)})`).toBeCloseTo(2.09, 2);
    // The tiers that no longer participate, pinned at the values that used to
    // fire this. If the gate is ever widened back to the quiet inks, THIS is the
    // theme that starts being rescued again — and the failure message says so.
    expect(contrastRatioHex(v["--text-3"], v["--bg-raised"]), "the hint tier drifted")
      .toBeCloseTo(1.37, 2);
    expect(contrastRatioHex(v["--text-2"], v["--bg-active"]), "the caption tier drifted")
      .toBeCloseTo(1.49, 2);
    expect(
      rescued(c),
      "the Appearance card rescue fired for a theme whose LABELS are readable at 2.62:1 — " +
        "the gate has been widened back to --text-2/--text-3 and the over-fire is back",
    ).toBe(false);
    // The route out, measured: what the user can still reach on this theme.
    for (const [ink, surface] of GATE_PAIRS) {
      expect(contrastRatioHex(v[ink], v[surface]), `${ink} on ${surface}`)
        .toBeGreaterThan(CARD_RESCUE_RATIO);
    }
  });

  it("ignores the accent entirely, however completely it has collapsed", () => {
    // The accent is not part of the gate any more. This theme's accent IS the
    // background — the selected segment's marker is invisible, so the card
    // cannot tell you which theme is currently active — and it is still left in
    // the user's colours, because every label and every unselected segment
    // reads at 11.95:1 and the way out is wide open.
    //
    // It used to sit 1% from the line and was explicitly unpinnable. Under a
    // --text-1 gate it is 8x clear of it, which makes it a stable fixture for
    // exactly the property that changed.
    const c: CustomTheme = { background: "#111113", accent: "#111113", text: "#ececf1" };
    const { vars: v } = deriveCustomTheme(c);
    expect(cardMin(c)).toBeCloseTo(11.95, 2);
    expect(contrastRatioHex(v["--accent-strong"], v["--bg-input"]), "the segment marker drifted")
      .toBeCloseTo(1.51, 2);
    expect(rescued(c), "the accent is back in the gate").toBe(false);
  });

  it("fires when a tier of the card has gone", () => {
    const gone: [CustomTheme, number, string][] = [
      // THE closest theme to the line on the firing side, and the one that
      // guards the bar from below: lower CARD_RESCUE_RATIO past 1.49 and a user
      // whose row labels have gone stops being rescued.
      [{ background: "#ffffff", accent: "#5563e8", text: "#c8c8c8" }, 1.49, "light, closest to the line"],
      [{ background: "#ffffff", accent: "#5563e8", text: "#d0d0d0" }, 1.38, "light, closer still"],
      [{ background: "#000000", accent: "#00ff00", text: "#333333" }, 1.35, "black"],
      // The weakest pair on all four of these is a HOVER or ACTIVE one — the
      // label on a button the pointer is already on. Those two surfaces are in
      // the gate precisely so a control does not vanish at the moment it is
      // being used, and dropping them changes these numbers.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#4d4266" }, 1.33, "text picked on bg"],
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#463b60" }, 1.20, "closer still"],
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#453274" }, 1.14, "editor chrome gone too"],
      // The exact pick the E2E pins as legal-but-unreadable.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#3a2f55" }, 1.00, "the E2E fixture"],
      // The theme the in-app E2E paints to prove this in real pixels. Pinned
      // here so that block's assumption is guarded by a test that runs in a
      // second rather than only by a run that needs a window.
      [{ background: "#3d1f6e", accent: "#3d1f6e", text: "#3d1f6e" }, 1.07, "the E2E's PATHO"],
    ];
    for (const [c, ratio, where] of gone) {
      expect(cardMin(c), `${where} fixture drifted (weakest: ${weakestTier(c)})`)
        .toBeCloseTo(ratio, 2);
      expect(rescued(c), `${where}: the user cannot undo their own theme`).toBe(true);
    }
  });

  it("fires for an all-one-colour theme at every point in the RGB cube", () => {
    // The state the escape hatch exists for, swept rather than sampled: a
    // trigger that only handled dark backgrounds would pass every named fixture
    // above. The worst of these (a #333300 app) still only reaches 1.21:1.
    for (const c of [...PATHOLOGICAL, ...ALL_ONE_COLOUR]) {
      expect(cardMin(c), `${c.background} is no longer a pathological theme`)
        .toBeLessThan(CARD_RESCUE_RATIO);
      expect(rescued(c), c.background).toBe(true);
    }
    // The least-bad one, pinned: if a derivation change ever walks this toward
    // 1.5 the sweep above stops being a meaningful margin long before it starts
    // failing.
    const worst = Math.max(...ALL_ONE_COLOUR.map((c) => cardMin(c)));
    expect(worst).toBeCloseTo(1.21, 2);
  });

  it("fires on a theme whose label survives until the pointer reaches it", () => {
    // The two surfaces easiest to leave out of a gate, and the reason they are
    // in it: this theme's label clears the bar on the card, the popover and the
    // segmented track, and then goes under on --bg-hover and --bg-active. The
    // label on a colour button is legible right up to the moment the user puts
    // the pointer on it to click it, which is the moment it has to work.
    //
    // Dropping either surface from GATE_PAIRS makes this test fail: at rest this
    // theme measures 1.5020, two thousandths clear of the line.
    const c: CustomTheme = { background: "#66aa00", accent: "#6c7cff", text: "#c000f0" };
    const t = cardTiers(c);
    expect(t["--text-1 on --bg-panel"]!, "at rest on the card").toBeCloseTo(1.94, 2);
    expect(t["--text-1 on --bg-input"]!, "at rest on the track").toBeCloseTo(1.50, 2);
    expect(t["--text-1 on --bg-hover"]!, "under the pointer").toBeCloseTo(1.40, 2);
    expect(t["--text-1 on --bg-active"]!, "pressed").toBeCloseTo(1.18, 2);
    // Every pair that is NOT a hover or active one is above the line, which is
    // what makes this a test of those two surfaces and nothing else.
    let atRest = Infinity;
    for (const [ink, surface] of GATE_PAIRS) {
      if (surface === "--bg-hover" || surface === "--bg-active") continue;
      atRest = Math.min(atRest, t[`${ink} on ${surface}`]!);
    }
    expect(atRest, "the at-rest pairs stopped being clear of the line").toBeGreaterThan(
      CARD_RESCUE_RATIO,
    );
    expect(rescued(c), "a label that dies under the pointer went unnoticed").toBe(true);
  });

  it("delivers a readable card AND a readable picker wherever it fires", () => {
    // What firing is worth, measured on the surfaces the two halves of the
    // recovery gesture actually use: the card is --bg-panel, the picker popover
    // is --bg-raised, and the segmented control and the picker's hex field are
    // --bg-input. All three are overridden by the same flag, because a readable
    // card that opens an unreadable "Reset to default" is the same dead end.
    for (const c of [...PATHOLOGICAL, ...ALL_ONE_COLOUR]) {
      expect(rescued(c), c.background).toBe(true);
      const p = paletteFor(c);
      for (const [ink, surface] of SAFE_PAIRS) {
        // The same painted pairs the trigger measures, in the palette it swaps
        // in: row labels and button captions at body-text AA, and the hint tier
        // that fired the rescue delivered at more than twice the 1.5 that
        // triggered it.
        const floor = ink === "--safe-text-3" ? 3 : 4.5;
        expect(contrastRatioHex(p[ink]!, p[surface]!), `${c.background} ${ink} on ${surface}`)
          .toBeGreaterThanOrEqual(floor);
      }
      // "Which theme is active", on the segmented control's own bare track.
      expect(
        contrastRatioHex(p["--safe-accent-strong"]!, p["--safe-input"]!),
        `${c.background} selected segment`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  /* ---------------- independence from the two nav flags ---------------- */

  it("is strictly more eager than the editor chrome flag, which it contains", () => {
    // A CONTAINMENT, not a coincidence: `--text-1` against `--bg-panel` is
    // literally one of the five pairs this predicate takes the minimum over, so
    // an unreadable editor topbar cannot happen without an unreadable card. It
    // is asserted as the fact it is rather than straddled, because no fixture in
    // the other direction can exist while that term is in the set. The narrowed
    // gate did not change this: both predicates now measure the same ink.
    for (const c of [
      { background: "#241a3d", accent: "#ff5fa2", text: "#453274" },
      { background: "#3d1f6e", accent: "#ff5fa2", text: "#3d1f6e" },
      ...PATHOLOGICAL,
      ...ALL_ONE_COLOUR,
    ]) {
      const d = deriveCustomTheme(c);
      if (needsChromeRescue(d)) {
        expect(needsAppearanceRescue(d), `${c.background}/${c.text}: chrome gone, card not rescued`)
          .toBe(true);
      }
    }
    // …and the containment is strict: a card can be gone while the topbar and
    // the home gear are both fine, because the card is measured on four surfaces
    // the topbar never uses. This theme's label holds up on --bg-panel (1.67:1,
    // so the editor chrome is left alone) and goes under when a colour button is
    // pressed (1.49:1 on --bg-active), which is enough to rescue the card.
    //
    // It replaces #6a5f85, which used to be this witness and no longer fires at
    // all now that the gate is --text-1 only.
    const cardOnly: CustomTheme = { background: "#ffffff", accent: "#5563e8", text: "#c8c8c8" };
    const d = deriveCustomTheme(cardOnly);
    expect(contrastRatioHex(d.vars["--text-1"], d.vars["--bg-app"]), "the gear")
      .toBeCloseTo(1.67, 2);
    expect(contrastRatioHex(d.vars["--text-1"], d.vars["--bg-panel"]), "the editor topbar")
      .toBeCloseTo(1.67, 2);
    expect(contrastRatioHex(d.vars["--text-1"], d.vars["--bg-active"]), "a pressed colour button")
      .toBeCloseTo(1.49, 2);
    expect(needsNavRescue(d)).toBe(false);
    expect(needsChromeRescue(d)).toBe(false);
    expect(needsAppearanceRescue(d)).toBe(true);
  });

  it("does not contain the home gear flag, which measures a surface it never uses", () => {
    // The straddler in the direction that DOES exist — found by sweeping the
    // cube rather than by taste, which is why it is a green app with purple
    // text. The gear is invisible on --bg-app (1.43:1) so the nav rescue fires,
    // while every tier of the card clears the line on the DERIVED surfaces
    // (1.70:1 at worst) so the card correctly keeps the user's colours.
    //
    // This is also the case that catches a predicate measuring the wrong base
    // surface: swap --bg-panel for --bg-app in the card's surface set and this
    // theme starts being rescued, because --bg-app is the one surface the card
    // is never painted on.
    const gearOnly: CustomTheme = { background: "#006600", accent: "#00cc00", text: "#660099" };
    const d = deriveCustomTheme(gearOnly);
    expect(contrastRatioHex(d.vars["--text-1"], d.vars["--bg-app"]), "gear fixture drifted")
      .toBeCloseTo(1.43, 2);
    expect(cardMin(gearOnly), `card fixture drifted (weakest: ${weakestTier(gearOnly)})`)
      .toBeCloseTo(1.70, 2);
    expect(needsNavRescue(d)).toBe(true);
    expect(needsChromeRescue(d)).toBe(false);
    expect(needsAppearanceRescue(d), "the card reads fine and was overridden anyway").toBe(false);
    // A second one, so the containment is refuted by more than a single point.
    const other: CustomTheme = { background: "#006633", accent: "#cc6666", text: "#660099" };
    const e = deriveCustomTheme(other);
    expect(contrastRatioHex(e.vars["--text-1"], e.vars["--bg-app"])).toBeCloseTo(1.46, 2);
    expect(cardMin(other)).toBeCloseTo(1.73, 2);
    expect(needsNavRescue(e)).toBe(true);
    expect(needsAppearanceRescue(e)).toBe(false);
  });

  it("keys off the card's own inks and surfaces, not the app background", () => {
    // Role confusion, the same failure the nav rescue guards against, from the
    // other side: --bg-app is not a surface this card is ever painted on, and
    // its own tiers are what decide. The pair below differs only in the app
    // background's relationship to the text, and the verdict must follow the
    // card, not the page.
    const cardGoneAppFine: CustomTheme = { background: "#ffffff", accent: "#5563e8", text: "#c8c8c8" };
    const appGoneCardFine: CustomTheme = { background: "#006600", accent: "#00cc00", text: "#660099" };
    expect(rescued(cardGoneAppFine)).toBe(true);
    expect(rescued(appGoneCardFine)).toBe(false);
  });
});

/* ---------------- the nav rescue ---------------- */

/**
 * The escape hatch above makes Settings → Appearance readable once you are on
 * it. This makes it REACHABLE: the home gear is the only route in, it is a
 * ghost icon button whose only ink is a 1.33 px stroke in --text-1 on --bg-app,
 * and a text colour picked on top of the background erases it.
 *
 * The hard part is not the styling, it is the TRIGGER, so that is what these
 * measure. The rescue must fire when the control is genuinely not there, and it
 * must NOT fire for a theme that is merely ugly — an app that quietly restyles
 * a control the user CAN see is contrast clamping by another route, and that is
 * exactly what this release removed. Both directions are therefore asserted
 * against measured ratios, not against the predicate's own opinion.
 */
/**
 * The editor's Back/gear ride on --bg-panel, not --bg-app, so they need their
 * own predicate. These tests exist because the two genuinely disagree: a mutation
 * that swapped the surface under the HOME predicate passed the suite until the
 * straddler fixtures below were added, which is what proved one shared flag
 * would leave the editor chrome invisible and unrescued.
 */
describe("the chrome rescue", () => {
  const chromeRatio = (c: CustomTheme): number => {
    const { vars } = deriveCustomTheme(c);
    return contrastRatioHex(vars["--text-1"], vars["--bg-panel"]);
  };
  const appRatio = (c: CustomTheme): number => {
    const { vars } = deriveCustomTheme(c);
    return contrastRatioHex(vars["--text-1"], vars["--bg-app"]);
  };

  it("measures the panel, not the app background", () => {
    // Invisible on the topbar while home is (just) fine. One shared flag would
    // leave a user stranded inside a project with both exits unreadable.
    const straddler: CustomTheme = {
      background: "#241a3d",
      accent: "#ff5fa2",
      text: "#453274",
    };
    expect(appRatio(straddler)).toBeGreaterThan(NAV_RESCUE_RATIO);
    expect(chromeRatio(straddler)).toBeLessThan(NAV_RESCUE_RATIO);
    expect(needsNavRescue(deriveCustomTheme(straddler))).toBe(false);
    expect(needsChromeRescue(deriveCustomTheme(straddler))).toBe(true);
  });

  it("straddles the other way too, so neither predicate subsumes the other", () => {
    const other: CustomTheme = {
      background: "#3d1f6e",
      accent: "#ff5fa2",
      text: "#11091e",
    };
    expect(appRatio(other)).toBeLessThan(NAV_RESCUE_RATIO);
    expect(chromeRatio(other)).toBeGreaterThan(NAV_RESCUE_RATIO);
    expect(needsNavRescue(deriveCustomTheme(other))).toBe(true);
    expect(needsChromeRescue(deriveCustomTheme(other))).toBe(false);
  });

  it("fires for every all-one-colour theme, where both exits vanish", () => {
    for (const c of PATHOLOGICAL) {
      expect(needsChromeRescue(deriveCustomTheme(c)), c.background).toBe(true);
    }
  });

  it("leaves an ugly but visible theme alone", () => {
    const ugly: CustomTheme = {
      background: "#241a3d",
      accent: "#ff5fa2",
      text: "#6a5f85",
    };
    expect(chromeRatio(ugly)).toBeGreaterThan(NAV_RESCUE_RATIO);
    expect(needsChromeRescue(deriveCustomTheme(ugly))).toBe(false);
  });
});

describe("the nav rescue", () => {
  const rescued = (c: CustomTheme): boolean => needsNavRescue(deriveCustomTheme(c));
  /** The gear's real ink against the real surface behind it. */
  const gearRatio = (c: CustomTheme): number => {
    const { vars } = deriveCustomTheme(c);
    return contrastRatioHex(vars["--text-1"], vars["--bg-app"]);
  };
  /** The one thing a fired rescue actually promises: the glyph, drawn in
   *  --safe-text-1 on --safe-raised, both fixed constants. */
  const rescuedGlyphRatio = (c: CustomTheme): number => {
    const p = SAFE_APPEARANCE[deriveCustomTheme(c).surface];
    return contrastRatioHex(p["--safe-text-1"], p["--safe-raised"]);
  };

  it("pins the threshold, because the threshold IS the decision", () => {
    // 3:1 is WCAG 2.1 SC 1.4.11, the floor for a UI component being legible —
    // firing there would rescue themes that are only poor, which is clamping.
    // 1.0 catches nothing but an exact collision. 1.5 is half the UI floor,
    // raised off a pure text bar because the gear is a 1.33 px antialiased
    // stroke rather than a run of glyphs. Moving it must be deliberate.
    expect(NAV_RESCUE_RATIO).toBe(1.5);
    expect(NAV_RESCUE_RATIO).toBeGreaterThan(1);
    expect(NAV_RESCUE_RATIO).toBeLessThan(3);
  });

  it("leaves both shipped palettes completely alone", () => {
    for (const [name, c] of [["dark", DEFAULT_CUSTOM_THEME], ["light", LIGHT_STOCK]] as const) {
      expect(gearRatio(c), name).toBeGreaterThan(15);
      expect(rescued(c), name).toBe(false);
    }
  });

  it("leaves an ugly but visible theme alone, in both directions", () => {
    // Each fixture carries the ratio it was chosen for. If one ever drifts
    // across the line the ratio assertion fails FIRST and says so, instead of
    // the case silently stopping to test anything (the recurring failure mode).
    const ugly: [CustomTheme, number, string][] = [
      // Fails WCAG for a UI component and is still perfectly easy to find.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#6a5f85" }, 2.78, "poor"],
      // Genuinely bad. Still not the thing this feature is for.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#4d4266" }, 1.77, "bad"],
      // The closest a theme can sit to the line and still be the user's own.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#463b60" }, 1.59, "borderline"],
      // WHICH SURFACE, pinned. This text is 1.52:1 on --bg-app but only 1.43:1
      // on the --bg-panel derived from it — so it stays untouched here and
      // would be wrongly rescued by a predicate that measured the panel. The
      // home header paints nothing; the gear sits on the app background.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#453274" }, 1.52, "app-vs-panel"],
      // The same two cases on a LIGHT surface, where the ramp derives the other
      // way — a rescue keyed off the wrong end of the ink crossover would show
      // up here and nowhere else.
      [{ background: "#ffffff", accent: "#5563e8", text: "#c8c8c8" }, 1.67, "light bad"],
      [{ background: "#ffffff", accent: "#5563e8", text: "#d0d0d0" }, 1.54, "light borderline"],
      [{ background: "#000000", accent: "#00ff00", text: "#333333" }, 1.66, "black bad"],
    ];
    for (const [c, ratio, where] of ugly) {
      expect(gearRatio(c), `${where} fixture drifted`).toBeCloseTo(ratio, 2);
      expect(rescued(c), `${where}: the user's visible choice was overridden`).toBe(false);
    }
  });

  it("fires when the gear is effectively not there", () => {
    const gone: [CustomTheme, number, string][] = [
      // Background == text: the two-click route to a dead end.
      [{ background: "#3d1f6e", accent: "#ff5fa2", text: "#3d1f6e" }, 1.0, "identical"],
      // One channel step apart — "near-identical" has to count too.
      [{ background: "#3d1f6e", accent: "#ff5fa2", text: "#3d1f70" }, 1.005, "near-identical"],
      // The exact pick the E2E pins as legal-but-unreadable. It is used
      // VERBATIM and always will be; this only adds a way back out.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#3a2f55" }, 1.33, "the E2E fixture"],
      // …and on a light surface.
      [{ background: "#ffffff", accent: "#5563e8", text: "#e8e8e8" }, 1.23, "light"],
      // The same surface axis as above, taken from the other side: 1.50:1 on
      // --bg-app and 1.61:1 on the panel derived from it, so a predicate that
      // measured the panel would leave this user stranded.
      [{ background: "#3d1f6e", accent: "#ff5fa2", text: "#11091e" }, 1.497, "app-vs-panel"],
    ];
    for (const [c, ratio, where] of gone) {
      expect(gearRatio(c), `${where} fixture drifted`).toBeCloseTo(ratio, 2);
      expect(rescued(c), `${where}: no way back to Settings`).toBe(true);
    }
  });

  it("fires for an all-one-colour theme at every point in the RGB cube", () => {
    // The pathological case is not one colour, it is every colour. A rescue
    // that only handled dark backgrounds would pass every named fixture above.
    for (const h of rgbCube(51)) {
      expect(rescued({ background: h, accent: h, text: h }), h).toBe(true);
    }
  });

  it("keys off the gear's own ink, not the accent", () => {
    // Role confusion is the failure this catches: --accent does not touch a
    // ghost icon button, so an invisible accent is not this feature's problem
    // (and hijacking it would restyle the gear on a perfectly readable app).
    const accentGone: CustomTheme = {
      background: "#111113",
      accent: "#111113",
      text: "#ececf1",
    };
    expect(rescued(accentGone)).toBe(false);
    // The mirror image: a loud accent must not mask a text that is gone.
    const textGone: CustomTheme = {
      background: "#111113",
      accent: "#ff5fa2",
      text: "#111113",
    };
    expect(rescued(textGone)).toBe(true);
  });

  it("produces a genuinely visible control wherever it fires", () => {
    // What a fired rescue promises is the GLYPH: --safe-text-1 on
    // --safe-raised, one of two fixed pairs, so the number below cannot be
    // moved by any pick. The chip around it may coincide with the page (a user
    // is free to pick exactly #1d1d21) — that is accepted, and it is why the
    // guarantee is stated on the ink and not on the fill.
    const worst = [
      ...PATHOLOGICAL,
      ...rgbCube(51).map((h) => ({ background: h, accent: h, text: h })),
    ];
    for (const c of worst) {
      expect(rescued(c), c.background).toBe(true);
      // Body-text AA, three times the WCAG floor the gear actually has to meet.
      expect(rescuedGlyphRatio(c), c.background).toBeGreaterThanOrEqual(4.5);
    }
    // The two numbers those cases collapse to, pinned so a retune of
    // SAFE_APPEARANCE cannot quietly weaken the promise.
    expect(contrastRatioHex(SAFE_APPEARANCE.dark["--safe-text-1"], SAFE_APPEARANCE.dark["--safe-raised"]))
      .toBeCloseTo(14.27, 1);
    expect(contrastRatioHex(SAFE_APPEARANCE.light["--safe-text-1"], SAFE_APPEARANCE.light["--safe-raised"]))
      .toBeCloseTo(17.15, 1);
    // The chip's edge, which is what makes it read as a button rather than a
    // floating glyph, against the fill it is drawn on.
    for (const dir of ["dark", "light"] as const) {
      const p = SAFE_APPEARANCE[dir];
      expect(channelDistance(p["--safe-border-strong"], p["--safe-raised"]), dir).toBeGreaterThan(6);
      expect(channelDistance(p["--safe-hover"], p["--safe-raised"]), `${dir} hover`).toBeGreaterThan(3);
    }
  });
});

/* ================================================================== */
/* Session lifetime: the autosaver, and settings persistence          */
/* ================================================================== */

/**
 * A stand-in for the two globals `session.ts` reaches for.
 *
 * `vite.config.ts` runs these in `environment: "node"`, so there is no DOM:
 * `applyTheme` needs a root element to write dataset and style onto, and
 * `ProjectSession` schedules its debounce and its autosave interval through
 * `window`. The timer members DELEGATE at call time rather than capturing the
 * function, so vitest's fake timers — installed per test below — are what
 * actually runs.
 */
function installGlobalStubs(): void {
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: () => {}, removeProperty: () => {} },
  };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id?: number) => globalThis.clearInterval(id),
  });
}

/** Only the timers, so the microtask queue (and therefore `Store`'s batched
 *  notifications) keeps running normally, and `touchModified`'s `Date` stays
 *  real. */
function fakeTimerOptions(): Parameters<typeof vi.useFakeTimers>[0] {
  return { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };
}

const PROJECT_PATH = "C:\\Users\\adirh\\Videos\\Taroting\\cut.trt";

/** One full autosave period at the shipped default. */
const TICK_MS = DEFAULT_SETTINGS.autosaveSeconds * 1000;

/**
 * The data loss this block exists for: an edit made while an autosave was
 * already writing, on a session that is then torn down before that write
 * returns. Every exit from the editor — Back, Ctrl+W, the Settings gear, an OS
 * open-path — goes through `dispose()`, so this is not an exotic path.
 *
 * `save()` used to return the moment it saw a write in flight, having only
 * recorded that a follow-up was owed. `dispose()` awaited that instant
 * resolution and set `disposed`, and the follow-up then short-circuited on
 * `disposed` and never wrote. The suite could not see it because nothing else
 * in the app depends on what `save()`'s promise MEANS.
 */
describe("autosave while a write is already in flight", () => {
  beforeEach(() => {
    installGlobalStubs();
    settingsStore.set(DEFAULT_SETTINGS);
    vi.useFakeTimers(fakeTimerOptions());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A writer whose FIRST call blocks until released, recording the project
   *  name of everything that actually reaches disk. */
  function blockingWriter(): { written: string[]; release: () => void } {
    const written: string[] = [];
    let release!: () => void;
    const firstReturns = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    vi.spyOn(ipc, "saveProject").mockImplementation(async (_path, project) => {
      written.push(project.name);
      if (first) {
        first = false;
        await firstReturns;
      }
      return { modifiedAt: project.modifiedAt };
    });
    return { written, release };
  }

  it("writes an edit made mid-write even when the editor is left immediately after", async () => {
    const { written, release } = blockingWriter();
    const session = new ProjectSession(PROJECT_PATH, createProject("start"));

    session.commit((p) => ({ ...p, name: "first edit" }));
    const autosave = session.save(); // the write that is now in flight
    session.commit((p) => ({ ...p, name: "second edit" }));

    const leaving = session.dispose(); // Back / Ctrl+W / the Settings gear
    release();
    await leaving;
    await autosave;

    expect(written).toEqual(["first edit", "second edit"]);
    expect(session.saveState.get()).toBe("saved");
  });

  it("resolves a coalesced save only once the edits it carries are on disk", async () => {
    const { written, release } = blockingWriter();
    const session = new ProjectSession(PROJECT_PATH, createProject("start"));

    session.commit((p) => ({ ...p, name: "first edit" }));
    const autosave = session.save();
    session.commit((p) => ({ ...p, name: "second edit" }));

    // The contract dispose() leans on: this promise is "my state is on disk",
    // not "somebody noted that it should be".
    let settled = false;
    const coalesced = session.save().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(written).toEqual(["first edit"]);

    release();
    await coalesced;
    expect(written).toEqual(["first edit", "second edit"]);

    await autosave;
    session.discard();
  });
});

/**
 * A failed write leaves `saveState` at "error", never at "dirty" — so the
 * interval's dirty check alone meant nothing ever tried again while the editor
 * sat idle. The "Save failed" badge showed, so this was never silent, but a
 * transient cause could not clear itself: only a fresh edit or leaving the
 * editor would attempt another write.
 */
describe("autosave after a failed write", () => {
  beforeEach(() => {
    installGlobalStubs();
    settingsStore.set(DEFAULT_SETTINGS);
    vi.useFakeTimers(fakeTimerOptions());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries on its own, with no edit and no navigation", async () => {
    let attempts = 0;
    vi.spyOn(ipc, "saveProject").mockImplementation(async (_path, project) => {
      attempts++;
      if (attempts === 1) throw new Error("the file was locked");
      return { modifiedAt: project.modifiedAt };
    });

    const session = new ProjectSession(PROJECT_PATH, createProject("cut"));
    await session.save();
    expect(session.saveState.get()).toBe("error");
    expect(attempts).toBe(1);

    // One autosave period passes. The user does nothing at all.
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(attempts).toBe(2);
    expect(session.saveState.get()).toBe("saved");
    session.discard();
  });

  it("backs off instead of retrying every tick while the cause persists", async () => {
    const saveProject = vi
      .spyOn(ipc, "saveProject")
      .mockRejectedValue(new Error("the drive is gone"));

    const session = new ProjectSession(PROJECT_PATH, createProject("cut"));
    await session.save(); // attempt 1
    await vi.advanceTimersByTimeAsync(TICK_MS * 20);

    // Retries land on ticks 1, 3, 7 and 15 — the doubling backoff — never on
    // all twenty. Each attempt re-stamps modifiedAt and notifies every project
    // subscriber, so an every-tick retry against a dead destination would be a
    // re-render loop for as long as the editor stays open.
    expect(saveProject).toHaveBeenCalledTimes(5);
    expect(session.saveState.get()).toBe("error");
    session.discard();
  });
});

/**
 * The other data loss: a settings.json that could not be READ at boot, silently
 * replaced by defaults on the very next write.
 *
 * WHY THIS BLOCK WAS REWRITTEN. It used to model "unreadable" as a REJECTING
 * `get_settings` — which is exactly why every case here passed while the real
 * path did not. The backend does not reject: `read_json_with_bak` collapsed both
 * "there is no file yet" and "the file is there but neither it nor its .bak
 * could be read" into `Ok(None)`, so what the app actually meets when a Windows
 * file lock (an antivirus scanner, a sync client) defeats a perfectly intact
 * settings.json is a RESOLUTION — and it walked straight through a guard whose
 * only trigger was a throw. `initSettings` reported `{ok:true,
 * source:"defaults"}`, main.ts showed no toast, and `reconcileSettings` marked
 * itself verified and let `{...DEFAULTS, ...patch}` go over the user's file.
 *
 * So the unreadable cases below are modelled as `ipc.readSettings` RESOLVING
 * `{ status: "unreadable" }`. The rejection is kept, but as its own separate
 * case: the command can still fail on its own terms (an unresolvable data
 * directory, a dead IPC bridge), and that is a different question from what the
 * file on disk is.
 */
describe("settings that could not be read at start-up", () => {
  beforeEach(() => {
    installGlobalStubs();
    // The store is module state shared with every other block in this file.
    settingsStore.set(DEFAULT_SETTINGS);
    // initSettings reports a failed read here too; keep it out of the output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /* ---- the file is there, and unreadable (the path that used to be silent) ---- */

  it("reports a present-but-unreadable file instead of coming up as a fresh install", async () => {
    vi.spyOn(ipc, "readSettings").mockResolvedValue({ status: "unreadable" });

    const load = await initSettings();
    // NOT {ok:true, source:"defaults"} — that is what made main.ts stay quiet
    // while every preference on screen was a lie.
    expect(load.ok).toBe(false);
    // …and still reachable from a screen mounted later, which is exactly the
    // screen a user opens when their preferences look wrong.
    expect(settingsLoadFailure()).toMatch(/settings\.json is on disk/);
  });

  it("refuses to overwrite a settings file it could not read", async () => {
    vi.spyOn(ipc, "readSettings").mockResolvedValue({ status: "unreadable" });
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    await initSettings();
    await expect(updateSettings({ defaultExportDir: "D:\\Exports" })).rejects.toThrow(
      /could not be read/,
    );

    expect(saveSettings).not.toHaveBeenCalled();
    // Nothing was painted either: the optimistic store write is skipped on the
    // one path where the optimism would be a lie.
    expect(settingsStore.get().defaultExportDir).toBeNull();
  });

  it("does not mark itself verified, so the next write asks about the file again", async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, defaultExportDir: "D:\\Exports" };
    const readSettings = vi
      .spyOn(ipc, "readSettings")
      .mockResolvedValueOnce({ status: "unreadable" }) // boot
      .mockResolvedValueOnce({ status: "unreadable" }) // still locked
      .mockResolvedValueOnce({ status: "ok", settings: stored, recovered: false }); // the lock cleared
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    await initSettings();
    await expect(updateSettings({ proxyMedia: false })).rejects.toThrow(/nothing was written/);
    // Refusing is only half of it. Marking the session verified on the way out
    // would let this second write go straight through — over the same file.
    await updateSettings({ proxyMedia: false });

    expect(readSettings).toHaveBeenCalledTimes(3);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // …and the write that finally landed carried the recovered value, not a
    // default, which is only possible because the re-read happened.
    expect(saveSettings.mock.calls[0]![0].defaultExportDir).toBe("D:\\Exports");
  });

  it("refuses when a file appears between boot and the first write", async () => {
    vi.spyOn(ipc, "readSettings")
      .mockResolvedValueOnce({ status: "absent" }) // a genuine-looking first run…
      .mockResolvedValueOnce({ status: "unreadable" }); // …but there IS one now
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    expect(await initSettings()).toEqual({ ok: true, source: "defaults", recovered: false });
    await expect(updateSettings({ proxyMedia: false })).rejects.toThrow(/nothing was written/);

    expect(saveSettings).not.toHaveBeenCalled();
    // A boot that saw nothing recorded no failure; the reconcile did.
    expect(settingsLoadFailure()).toMatch(/settings\.json is on disk/);
  });

  it("merges the next change onto the real file once a read finally succeeds", async () => {
    const stored: Settings = {
      ...DEFAULT_SETTINGS,
      defaultExportDir: "D:\\Exports",
      shortcuts: { ...DEFAULT_SHORTCUTS, split: "Q" },
    };
    vi.spyOn(ipc, "readSettings")
      .mockResolvedValueOnce({ status: "unreadable" })
      .mockResolvedValueOnce({ status: "ok", settings: stored, recovered: false });
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    expect((await initSettings()).ok).toBe(false);
    await updateSettings({ hardwareAccel: false });

    const written = saveSettings.mock.calls[0]![0];
    expect(written.hardwareAccel).toBe(false);
    // The two values the old code destroyed: a configured export folder became
    // null, and a rebound shortcut went back to its stock chord.
    expect(written.defaultExportDir).toBe("D:\\Exports");
    expect(written.shortcuts.split).toBe("Q");
  });

  /* ---- the command itself failing: a different question, kept separate ---- */

  it("reports a rejecting get_settings too", async () => {
    vi.spyOn(ipc, "readSettings").mockRejectedValue(new Error("the file is in use"));

    expect(await initSettings()).toEqual({ ok: false, error: "the file is in use" });
    expect(settingsLoadFailure()).toBe("the file is in use");
  });

  it("refuses to overwrite when the call fails at boot and fails again", async () => {
    vi.spyOn(ipc, "readSettings").mockRejectedValue(new Error("the file is in use"));
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    await initSettings();
    await expect(updateSettings({ defaultExportDir: "D:\\Exports" })).rejects.toThrow(
      /could not be read/,
    );

    expect(saveSettings).not.toHaveBeenCalled();
    expect(settingsStore.get().defaultExportDir).toBeNull();
  });

  /* ---- and the states that must stay permissive ---- */

  it("re-reads before the first write when start-up found nothing at all", async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, monitorVolume: 0.25 };
    const readSettings = vi
      .spyOn(ipc, "readSettings")
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "ok", settings: stored, recovered: false });
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    expect(await initSettings()).toEqual({ ok: true, source: "defaults", recovered: false });
    await updateSettings({ proxyMedia: false });

    expect(readSettings).toHaveBeenCalledTimes(2);
    const written = saveSettings.mock.calls[0]![0];
    expect(written.monitorVolume).toBe(0.25);
    expect(written.proxyMedia).toBe(false);
  });

  it("still saves on a genuine first run, and re-reads only once", async () => {
    const readSettings = vi.spyOn(ipc, "readSettings").mockResolvedValue({ status: "absent" });
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    await initSettings();
    await updateSettings({ proxyMedia: false });
    await updateSettings({ hardwareAccel: false });

    expect(saveSettings).toHaveBeenCalledTimes(2);
    // Boot plus one reconcile — the gate must not turn every preference change
    // into a disk round trip.
    expect(readSettings).toHaveBeenCalledTimes(2);
    expect(saveSettings.mock.calls[1]![0].proxyMedia).toBe(false);
  });

  it("costs nothing extra when start-up read the file", async () => {
    const readSettings = vi
      .spyOn(ipc, "readSettings")
      .mockResolvedValue({ status: "ok", settings: { ...DEFAULT_SETTINGS, cacheLimitMB: 4096 }, recovered: false });
    const saveSettings = vi.spyOn(ipc, "saveSettings").mockResolvedValue(undefined);

    expect(await initSettings()).toEqual({ ok: true, source: "disk", recovered: false });
    expect(settingsLoadFailure()).toBeNull();
    await updateSettings({ proxyMedia: false });

    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0]![0].cacheLimitMB).toBe(4096);
  });

  it("says so when the settings came back from the .bak", async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, cacheLimitMB: 4096 };
    vi.spyOn(ipc, "readSettings").mockResolvedValue({
      status: "ok",
      settings: stored,
      recovered: true,
    });

    // Nothing is missing and nothing needs doing — but settings.json itself was
    // corrupt and a backup supplied these, which main.ts turns into a toast
    // rather than letting the repair happen invisibly.
    expect(await initSettings()).toEqual({ ok: true, source: "disk", recovered: true });
    expect(settingsStore.get().cacheLimitMB).toBe(4096);
    expect(settingsLoadFailure()).toBeNull();
  });
});

/**
 * The wire shape itself. `normalizeSettingsRead` is the ONE place that knows how
 * `get_settings` answers, so it is the one place a backend change can silently
 * re-collapse the three states into two — which is the bug this whole block
 * exists to keep closed.
 */
describe("normalizeSettingsRead", () => {
  it("reads the three payloads settings.rs actually serialises", () => {
    // Asserted against the LITERAL objects, copied from the serialization test
    // in src-tauri/src/settings.rs — not against the TS type, which would agree
    // with itself while the wire drifted. A rename on either side fails here.
    expect(
      normalizeSettingsRead({ status: "ok", settings: { theme: "dark" }, recovered: true }),
    ).toEqual({ status: "ok", settings: { theme: "dark" }, recovered: true });
    expect(normalizeSettingsRead({ status: "absent", settings: null, recovered: false })).toEqual({
      status: "absent",
    });
    expect(
      normalizeSettingsRead({ status: "unreadable", settings: null, recovered: false }),
    ).toEqual({ status: "unreadable" });
  });

  it("keeps the settings usable end to end", () => {
    const read = normalizeSettingsRead({
      status: "ok",
      settings: { schema: 1, theme: "light", cacheLimitMB: 4096 },
      recovered: false,
    });
    expect(sanitizeSettings(read.status === "ok" ? read.settings : null).theme).toBe("light");
  });

  /**
   * The fail-safe half, and the reason this function exists at all.
   *
   * The tempting fallback — "an object I don't recognise must be the settings" —
   * is how the bug comes back wearing a fix: the real `unreadable` payload would
   * be read AS settings, `sanitizeSettings` would turn `{status, settings,
   * recovered}` into pure defaults, boot would report a clean read, and the
   * overwrite guard would never fire again. Anything not positively recognised
   * therefore lands on the one state that refuses to write.
   */
  it("treats anything it does not recognise as unreadable", () => {
    for (const raw of [
      null,
      undefined,
      42,
      "unreadable",
      {},
      { status: "nonsense" },
      { status: "OK", settings: { theme: "dark" } }, // wrong case
      { state: "parsed", value: { theme: "dark" } }, // a shape that was never shipped
      { schema: 1, theme: "dark" }, // the settings alone, with no envelope
      // …and the contradiction the Rust type forbids: "ok" with nothing in it.
      { status: "ok", settings: null, recovered: false },
    ]) {
      expect(normalizeSettingsRead(raw)).toEqual({ status: "unreadable" });
    }
  });

  it("defaults recovered to false rather than trusting a missing flag", () => {
    expect(normalizeSettingsRead({ status: "ok", settings: { theme: "dark" } })).toEqual({
      status: "ok",
      settings: { theme: "dark" },
      recovered: false,
    });
  });
});

/**
 * `Store` is the shared primitive under every screen, so one subscriber's bug
 * used to become every later subscriber's bug: the notify loop had no
 * per-listener guard, and `prevNotified` is advanced before it runs, so a throw
 * both aborted the delivery and made that value unreachable for good. A throw
 * in the Settings re-render stopped the editor re-binding its shortcuts, with
 * nothing anywhere to say so.
 */
describe("Store notifications when a subscriber throws", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still notifies every other subscriber, and reports the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new Store(0);
    const seen: string[] = [];

    store.subscribe((n) => seen.push(`first:${n}`));
    store.subscribe(() => {
      throw new Error("the Settings re-render blew up");
    });
    store.subscribe((n) => seen.push(`third:${n}`));

    store.set(1);
    await Promise.resolve();

    expect(seen).toEqual(["first:1", "third:1"]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("does not silence a later subscriber permanently", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new Store(0);
    const seen: number[] = [];

    store.subscribe(() => {
      throw new Error("the Settings re-render blew up");
    });
    store.subscribe((n) => seen.push(n));

    store.set(1);
    await Promise.resolve();
    store.set(2);
    await Promise.resolve();

    // Under the old loop this subscriber saw neither value, and never would.
    expect(seen).toEqual([1, 2]);
  });

  it("keeps going when several subscribers throw", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new Store("a");
    const seen: string[] = [];

    store.subscribe(() => {
      throw new Error("first failure");
    });
    store.subscribe((s) => seen.push(`middle:${s}`));
    store.subscribe(() => {
      throw new Error("second failure");
    });
    store.subscribe((s) => seen.push(`last:${s}`));

    store.set("b");
    await Promise.resolve();

    expect(seen).toEqual(["middle:b", "last:b"]);
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
