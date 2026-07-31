import { describe, expect, it } from "vitest";
import {
  contrastRatioHex,
  CUSTOM_THEME_VARS,
  deriveCustomTheme,
  NAV_RESCUE_RATIO,
  needsChromeRescue,
  needsNavRescue,
  normalizeHexColor,
  SAFE_APPEARANCE,
  SAFE_THEME_VARS,
  sanitizeSettings,
} from "./session";
import { normalizeChord } from "./shortcuts";
import { DEFAULT_CUSTOM_THEME, DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from "./types";
import type { ActionId, CustomTheme } from "./types";

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

/** Composite an `rgba(r, g, b, a)` string over an opaque `#rrggbb`, the way the
 *  compositor does for a translucent fill on a card. `--accent-dim` is the only
 *  non-opaque token, and the selected theme button is drawn on it. */
function overlay(rgba: string, base: string): string {
  const m = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), ([\d.]+)\)$/.exec(rgba);
  expect(m, `not an rgba literal: ${rgba}`).not.toBeNull();
  const a = Number(m![4]);
  const b = channels(base);
  const out = [1, 2, 3].map((i, k) => Math.round(Number(m![i]!) * a + b[k]! * (1 - a)));
  return `#${out.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Settings → Appearance is the ONE surface that does not follow the user's
 * colours, because it is the only place a theme that hid everything can be
 * undone. Its palette (and the colour picker's, since "Reset to default" lives
 * there) is a pair of fixed constants selected by the background's direction —
 * so its legibility is a property of those constants and nothing else.
 *
 * These tests measure the real contrast ratios of what actually ships. If one
 * fails, the card can no longer be read, which means a user can be permanently
 * locked out of their own app — do not relax the bar, fix the constants.
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

describe("the Appearance escape hatch", () => {
  /** What the card actually renders in, for a given user theme. */
  function paletteFor(c: CustomTheme): Record<string, string> {
    return SAFE_APPEARANCE[deriveCustomTheme(c).surface];
  }

  /** Card surfaces a label, a value or a control can land on. */
  const SAFE_SURFACES = [
    "--safe-panel",
    "--safe-raised",
    "--safe-input",
    "--safe-hover",
    "--safe-active",
  ] as const;

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

  it("does not depend on the user's colours at all", () => {
    // Identity, not equality: the card is handed one of exactly two fixed
    // objects, so there is no path by which a pick can reach it. This is the
    // whole mechanism — everything below is just measuring those two objects.
    for (const c of [...PATHOLOGICAL, ...rgbCube(51).map((h) => ({ background: h, accent: h, text: h }))]) {
      const p = paletteFor(c);
      expect(p === SAFE_APPEARANCE.dark || p === SAFE_APPEARANCE.light, c.background).toBe(true);
    }
  });

  it("keeps every label and hex value in the card readable, in every pathological case", () => {
    for (const c of PATHOLOGICAL) {
      const p = paletteFor(c);
      const where = `all-${c.background}`;
      for (const surface of SAFE_SURFACES) {
        // Row labels, the theme buttons and the mono hex captions.
        expect(contrastRatioHex(p["--safe-text-1"]!, p[surface]!), `${where} ${surface}`)
          .toBeGreaterThanOrEqual(4.5);
      }
      // The hex caption on a colour button, which is what a user reads to type
      // a value back in — held to the body-text bar, not the UI one.
      expect(contrastRatioHex(p["--safe-text-2"]!, p["--safe-panel"]!), where)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrastRatioHex(p["--safe-text-2"]!, p["--safe-raised"]!), where)
        .toBeGreaterThanOrEqual(4.5);
      // Section head and row hints.
      expect(contrastRatioHex(p["--safe-text-3"]!, p["--safe-panel"]!), where)
        .toBeGreaterThanOrEqual(3);
      expect(contrastRatioHex(p["--safe-text-3"]!, p["--safe-raised"]!), where)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the theme control operable, in every pathological case", () => {
    for (const c of PATHOLOGICAL) {
      const p = paletteFor(c);
      const where = `all-${c.background}`;
      // The SELECTED segment (Dark / Light / System / Custom) is
      // --accent-strong text on an --accent-dim fill composited over the card.
      // If this goes, the user cannot see which theme is active.
      const selected = overlay(p["--safe-accent-dim"]!, p["--safe-panel"]!);
      expect(contrastRatioHex(p["--safe-accent-strong"]!, selected), `${where} selected`)
        .toBeGreaterThanOrEqual(4.5);
      // …and the selected fill has to be distinguishable from an unselected one.
      expect(channelDistance(selected, p["--safe-panel"]!), `${where} fill`).toBeGreaterThan(6);
      // The focus ring, which is how this card is operated from the keyboard.
      expect(contrastRatioHex(p["--safe-accent"]!, p["--safe-panel"]!), `${where} ring`)
        .toBeGreaterThanOrEqual(3);
      expect(contrastRatioHex(p["--safe-accent"]!, p["--safe-raised"]!), `${where} ring`)
        .toBeGreaterThanOrEqual(3);
    }
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
    // Legibility does not depend on this — both palettes are internally
    // legible — but a dark card on a white app (or the reverse) reads as a
    // rendering bug rather than as the one thing still working.
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
