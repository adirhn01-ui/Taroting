import { describe, expect, it } from "vitest";
import {
  CARD_RESCUE_RATIO,
  contrastRatioHex,
  CUSTOM_THEME_VARS,
  deriveCustomTheme,
  NAV_RESCUE_RATIO,
  needsAppearanceRescue,
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

/**
 * Every (ink, surface) pair the Appearance card and the colour picker actually
 * paint, in the form `[ink, surface]` — the same list `CARD_PAIRS` in session.ts
 * carries, rebuilt here from the stylesheets rather than imported, so the two
 * have to agree instead of moving together.
 *
 * NOT the three-ink × three-surface cross product it looks like it should be.
 * That shape measures `--text-2`/`--bg-panel`, `--text-2`/`--bg-input` and
 * `--text-3`/`--bg-input`, none of which is painted anywhere (the quiet inks
 * only appear on buttons and inside the popover), while missing `--bg-hover` and
 * `--bg-active` entirely. Both errors are load-bearing: the phantom
 * `--text-3`/`--bg-input` pair wrongly rescued real palettes — Rosé Pine Dawn
 * and Solarized Light among them — and the missing hover/active pairs let a
 * theme through whose row label vanishes the moment the pointer reaches it.
 */
const CARD_PAIRS = [
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

type SafeVar = keyof (typeof SAFE_APPEARANCE)["dark"];

/** The same pairs in the fixed escape-hatch palette, for measuring what a fired
 *  rescue actually delivers. One `--safe-*` token per token above, derived from
 *  that list rather than written out again so the two cannot drift apart. */
const SAFE_PAIRS = CARD_PAIRS.map(
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
    // The --safe-* names below are DERIVED from CARD_PAIRS by string surgery,
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
  /** The `--accent-dim` fill composited over the segmented control's track —
   *  what the selected option sits on WHILE THE POINTER IS ON IT.
   *
   *  Recomputed from the emitted `rgba()` literal rather than from the spec
   *  constant that produced it, so this arrives at the compositor's answer by a
   *  different route than the implementation does. */
  function dimFillOverTrack(c: CustomTheme): string {
    const { vars: v } = deriveCustomTheme(c);
    const m = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), ([\d.]+)\)$/.exec(v["--accent-dim"]);
    expect(m, `not an rgba literal: ${v["--accent-dim"]}`).not.toBeNull();
    const a = Number(m![4]);
    const base = channels(v["--bg-input"]);
    const out = [1, 2, 3].map((i, k) => Math.round(Number(m![i]!) * a + base[k]! * (1 - a)));
    return `#${out.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  /** Every tier the card is made of, measured off what `deriveCustomTheme`
   *  actually emits: the painted (ink, surface) pairs above, plus the selected
   *  segment of the theme control, which is the one tier that does not depend on
   *  the text ramp at all.
   *
   *  The segment has TWO painted states and they are different colours. At rest
   *  it is `--accent-strong` on the BARE `--bg-input` track: the `.btn--on` rule
   *  that would put an `--accent-dim` fill under it loses the cascade to
   *  `.settings__segmented .btn { background: transparent }` (one class against
   *  two). Under the pointer that fill DOES land, because
   *  `.settings__segmented .btn--on:hover` ties `.settings__segmented .btn:hover`
   *  at (0,3,0) and wins on source order. The weaker of the two decides, the
   *  same rule the text tiers get for `--bg-hover` and `--bg-active`.
   *
   *  Neither state dominates in general — over the cube, 1460 themes fail only
   *  hovered and 469 fail only at rest — so both are load-bearing and each has a
   *  fixture below. */
  function cardTiers(c: CustomTheme): Record<string, number> {
    const { vars: v } = deriveCustomTheme(c);
    const out: Record<string, number> = {};
    for (const [ink, surface] of CARD_PAIRS) {
      out[`${ink} on ${surface}`] = contrastRatioHex(v[ink], v[surface]);
    }
    out["the selected theme segment"] = Math.min(
      contrastRatioHex(v["--accent-strong"], v["--bg-input"]),
      contrastRatioHex(v["--accent-strong"], dimFillOverTrack(c)),
    );
    return out;
  }

  /** What the predicate compares against CARD_RESCUE_RATIO: the weakest tier. */
  const cardMin = (c: CustomTheme): number => Math.min(...Object.values(cardTiers(c)));
  /** Which tier that is, for a failure message worth reading. */
  const weakestTier = (c: CustomTheme): string =>
    Object.entries(cardTiers(c)).sort((a, b) => a[1] - b[1])[0]![0];
  const rescued = (c: CustomTheme): boolean => needsAppearanceRescue(deriveCustomTheme(c));

  it("pins the threshold, because the threshold IS the decision", () => {
    // Calibrated on --text-3, the faintest tier, which compresses toward 1:1 far
    // faster than a row label does: it sits above the worst theme whose labels
    // read while its hints have gone (1.37) and below the weakest theme that is
    // genuinely still usable (1.68). It is numerically equal to NAV_RESCUE_RATIO
    // and that is a coincidence of calibration, not a dependency — different ink
    // at a different size on a different surface, free to move apart.
    expect(CARD_RESCUE_RATIO).toBe(1.5);
    expect(CARD_RESCUE_RATIO).toBeGreaterThan(1);
    expect(CARD_RESCUE_RATIO).toBeLessThan(3);
  });

  it("leaves both shipped palettes, fed back in as custom, completely alone", () => {
    for (const [name, c] of [["dark", DEFAULT_CUSTOM_THEME], ["light", LIGHT_STOCK]] as const) {
      expect(cardMin(c), name).toBeGreaterThan(3.2);
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
      [{ background: "#111113", accent: "#6c7cff", text: "#ececf1" }, 3.31, "stock dark"],
      [{ background: "#f6f6f8", accent: "#5563e8", text: "#1b1b20" }, 3.22, "stock light"],
      // Ordinary themes somebody would actually choose and keep.
      [{ background: "#1c1917", accent: "#f59e0b", text: "#fafaf9" }, 3.43, "warm dark"],
      [{ background: "#0d1b2a", accent: "#4cc9f0", text: "#e0e1dd" }, 2.93, "navy on cyan"],
      [{ background: "#fbf7ef", accent: "#b45309", text: "#3f3f46" }, 2.57, "paper"],
      // Deliberately low contrast, and still nobody's emergency.
      [{ background: "#e5e5e5", accent: "#555555", text: "#4a4a4a" }, 2.32, "gray on gray"],
      // Row labels at 4.70:1 — comfortably readable, hints merely quiet.
      [{ background: "#3b3b46", accent: "#8a8ad0", text: "#b0b0c0" }, 1.82, "muted mid-gray"],
      // Row labels 4.94:1, hints quiet but legible.
      [{ background: "#002b36", accent: "#268bd2", text: "#93a1a1" }, 1.68, "Solarized-like dark"],
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
      [{ background: "#2e3440", accent: "#88c0d0", text: "#d8dee9" }, 2.51, "Nord"],
      [{ background: "#282828", accent: "#d79921", text: "#ebdbb2" }, 2.67, "Gruvbox Dark"],
      [{ background: "#282a36", accent: "#bd93f9", text: "#f8f8f2" }, 3.11, "Dracula"],
      [{ background: "#eff1f5", accent: "#1e66f5", text: "#4c4f69" }, 2.31, "Catppuccin Latte"],
      [{ background: "#1a1b26", accent: "#7aa2f7", text: "#c0caf5" }, 2.61, "Tokyo Night"],
      [{ background: "#282c34", accent: "#61afef", text: "#abb2bf" }, 2.04, "One Dark"],
      [{ background: "#ffffff", accent: "#0969da", text: "#1f2328" }, 3.08, "GitHub Light"],
    ];
    for (const [c, ratio, where] of palettes) {
      expect(cardMin(c), `${where} fixture drifted (weakest: ${weakestTier(c)})`)
        .toBeCloseTo(ratio, 2);
      expect(rescued(c), `${where} was rescued — a real palette lost the user's colours`).toBe(false);
    }
  });

  it("leaves the three thinnest real margins alone, which is where the bar is set", () => {
    // The themes that decide whether this threshold is right. All three sit
    // between 1.53 and 1.62, and the first two were WRONGLY RESCUED until the
    // predicate stopped measuring pairs nothing paints: the phantom
    // --text-3/--bg-input pair scored them 1.47 and 1.44, because on a light
    // ramp --bg-raised equals --bg-panel while --bg-input sits on the far side
    // of the background, so a pair that never appears decided the verdict.
    const thin: [CustomTheme, number, string][] = [
      [{ background: "#faf4ed", accent: "#907aa9", text: "#9893a5" }, 1.61, "Rosé Pine Dawn muted"],
      [{ background: "#002b36", accent: "#268bd2", text: "#839496" }, 1.55, "Solarized Dark on base0"],
      // THE thinnest margin any real palette has: 2% of headroom. Pinned on its
      // own because it is the constraint on CARD_RESCUE_RATIO from above —
      // raising the bar past 1.53 costs Solarized Light its colours on the one
      // card those colours were chosen from, and the number to weigh that
      // against is that firing wrongly only ever costs one mismatched panel.
      [{ background: "#fdf6e3", accent: "#268bd2", text: "#93a1a1" }, 1.53, "Solarized Light on base1"],
    ];
    for (const [c, ratio, where] of thin) {
      expect(cardMin(c), `${where} fixture drifted (weakest: ${weakestTier(c)})`)
        .toBeCloseTo(ratio, 2);
      expect(rescued(c), `${where}: a real palette was overridden`).toBe(false);
    }
    // Stated as an inequality as well as a fixture, so the constraint survives
    // someone reading only one of the two.
    const solarizedLight: CustomTheme = { background: "#fdf6e3", accent: "#268bd2", text: "#93a1a1" };
    expect(CARD_RESCUE_RATIO, "the threshold has been raised past a real palette")
      .toBeLessThan(cardMin(solarizedLight));
  });

  it("fires when a tier of the card has gone", () => {
    const gone: [CustomTheme, number, string][] = [
      // Labels at 2.62:1 and perfectly readable; hints and section head GONE.
      // A --text-1 gate would leave this user with a card they cannot read the
      // hints on, which is also the card the nav rescue deliberately does not
      // fire for — the two flags are independent, see below.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#6a5f85" }, 1.37, "hints gone"],
      // From here down the weakest pair is a HOVER or ACTIVE one — the label or
      // the hex caption on a button the pointer is already on. Those pairs are
      // in the list precisely so a control does not vanish at the moment it is
      // being used, and dropping them changes these four numbers.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#4d4266" }, 1.11, "text picked on bg"],
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#463b60" }, 1.03, "closer still"],
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#453274" }, 1.00, "editor chrome gone too"],
      // The exact pick the E2E pins as legal-but-unreadable.
      [{ background: "#241a3d", accent: "#ff5fa2", text: "#3a2f55" }, 1.00, "the E2E fixture"],
      // The same on a LIGHT surface, where the ramp derives the other way: a
      // trigger keyed off the wrong end of the ink crossover shows up here and
      // nowhere else.
      [{ background: "#ffffff", accent: "#5563e8", text: "#c8c8c8" }, 1.27, "light"],
      [{ background: "#ffffff", accent: "#5563e8", text: "#d0d0d0" }, 1.21, "light, closer"],
      [{ background: "#000000", accent: "#00ff00", text: "#333333" }, 1.09, "black"],
      // The theme the in-app E2E paints to prove this in real pixels. Pinned
      // here so that block's assumption is guarded by a test that runs in a
      // second rather than only by a run that needs a window.
      [{ background: "#3d1f6e", accent: "#3d1f6e", text: "#3d1f6e" }, 1.03, "the E2E's PATHO"],
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
    // above. The worst of these (a #999900 app) still only reaches 1.09:1.
    for (const c of [...PATHOLOGICAL, ...ALL_ONE_COLOUR]) {
      expect(cardMin(c), `${c.background} is no longer a pathological theme`)
        .toBeLessThan(CARD_RESCUE_RATIO);
      expect(rescued(c), c.background).toBe(true);
    }
    // The least-bad one, pinned: if a derivation change ever walks this toward
    // 1.5 the sweep above stops being a meaningful margin long before it starts
    // failing.
    const worst = Math.max(...ALL_ONE_COLOUR.map((c) => cardMin(c)));
    expect(worst).toBeCloseTo(1.09, 2);
  });

  it("fires on a theme whose row labels read fine and whose hints have gone", () => {
    // THE case the multi-tier design exists for: --text-1 comfortably clear of
    // the line on every surface the card paints it on, --text-3 under it on
    // both of its. Restricting the predicate to --text-1 makes exactly this
    // test fail.
    const c: CustomTheme = { background: "#241a3d", accent: "#ff5fa2", text: "#6a5f85" };
    const t = cardTiers(c);
    for (const [ink, surface] of CARD_PAIRS) {
      const r = t[`${ink} on ${surface}`]!;
      if (ink === "--text-1") {
        expect(r, `label on ${surface} drifted`).toBeGreaterThan(2);
      }
      if (ink === "--text-3") {
        expect(r, `hint on ${surface} drifted`).toBeLessThan(CARD_RESCUE_RATIO);
      }
    }
    // The row label a --text-1 gate would have been looking at, pinned: 2.62:1
    // on the card, i.e. 1.7x the bar and plainly readable.
    expect(t["--text-1 on --bg-panel"]!).toBeCloseTo(2.62, 2);
    expect(t["--text-3 on --bg-raised"]!).toBeCloseTo(1.37, 2);
    expect(rescued(c)).toBe(true);
  });

  it("fires on a theme where ONLY the faintest tier has gone", () => {
    // The tier-specific version of the case above, because #6a5f85 no longer
    // isolates --text-3: its --text-2 caption on a pressed button measures
    // 1.4946, so that theme would still fire with the hint tier removed. This
    // fixture was found by search rather than by taste — every --text-1 and
    // --text-2 pair clears the line, the segment clears it four times over, and
    // ONLY the two --text-3 pairs are under. Drop them and nothing is left to
    // notice that the section head and every row hint have gone.
    const c: CustomTheme = { background: "#3b3b46", accent: "#ff5fa2", text: "#0f142d" };
    const t = cardTiers(c);
    let loudest = Infinity;
    for (const [ink, surface] of CARD_PAIRS) {
      if (ink === "--text-3") continue;
      loudest = Math.min(loudest, t[`${ink} on ${surface}`]!);
    }
    expect(loudest, "the loud tiers stopped being clear of the line").toBeGreaterThan(
      CARD_RESCUE_RATIO,
    );
    expect(t["the selected theme segment"]!, "the segment must not be what fires this")
      .toBeGreaterThan(CARD_RESCUE_RATIO * 2);
    expect(t["--text-3 on --bg-panel"]!, "the section head and hints").toBeCloseTo(1.31, 2);
    expect(t["--text-3 on --bg-raised"]!, "the picker's slider labels").toBeCloseTo(1.44, 2);
    expect(rescued(c), "the faintest tier is gone and nothing noticed").toBe(true);
  });

  it("fires on a theme whose label survives until the pointer reaches it", () => {
    // The pairs that are easiest to forget, and the reason they are in the list:
    // this theme's row label clears the bar on the card, the popover and the
    // segmented track, and then goes under on --bg-hover and --bg-active — so
    // the label on a colour button is legible right up to the moment a user puts
    // the pointer on it to click it.
    //
    // Under a pair set without hover and active this theme measured 1.5020 and
    // was SILENT, by two thousandths. Dropping either surface from CARD_PAIRS
    // makes this test fail.
    const c: CustomTheme = { background: "#66aa00", accent: "#6c7cff", text: "#c000f0" };
    const t = cardTiers(c);
    expect(t["--text-1 on --bg-panel"]!, "at rest on the card").toBeCloseTo(1.94, 2);
    expect(t["--text-1 on --bg-input"]!, "at rest on the track").toBeCloseTo(1.50, 2);
    expect(t["--text-1 on --bg-hover"]!, "under the pointer").toBeCloseTo(1.40, 2);
    expect(t["--text-1 on --bg-active"]!, "pressed").toBeCloseTo(1.18, 2);
    // Every pair that is NOT a hover or active one is above the line, which is
    // what makes this a test of those two surfaces and nothing else.
    let atRest = Infinity;
    for (const [ink, surface] of CARD_PAIRS) {
      if (surface === "--bg-hover" || surface === "--bg-active") continue;
      atRest = Math.min(atRest, t[`${ink} on ${surface}`]!);
    }
    expect(atRest, "the at-rest pairs stopped being clear of the line").toBeGreaterThan(
      CARD_RESCUE_RATIO,
    );
    expect(t["the selected theme segment"]!).toBeGreaterThan(CARD_RESCUE_RATIO);
    expect(rescued(c), "a label that dies under the pointer went unnoticed").toBe(true);
  });

  it("fires when only the selected theme segment has collapsed", () => {
    // The tier that does not come from the text ramp at all. An accent picked on
    // top of the background erases WHICH THEME IS ACTIVE while every label
    // around it still reads perfectly, so it has to be its own term rather than
    // something the text tiers can be trusted to notice.
    //
    // Measured on the BARE --bg-input track: `.settings__segmented .btn` sets
    // `background: transparent` at two-class specificity and beats
    // `.btn--on { background: var(--accent-dim) }`, so there is no fill under
    // the selected option at rest. Both fixtures are chosen so this tier clearly
    // dominates — text at 3.2:1 or better, labels above 15:1, segment ~17%
    // under. Deliberately NOT the near-miss accent theme at 1.51, which sits
    // within 1% of the bar and would pin nothing but rounding.
    const accentGone: [CustomTheme, number, number, string][] = [
      // Accent black on the stock dark app: labels 15.19:1, segment 1.28:1.
      [{ background: "#111113", accent: "#000000", text: "#ececf1" }, 1.28, 3.31, "dark"],
      // …and the mirror on a white app: labels 17.15:1, segment 1.24:1.
      [{ background: "#ffffff", accent: "#ffffff", text: "#1b1b20" }, 1.24, 3.22, "light"],
    ];
    for (const [c, segment, textFloor, where] of accentGone) {
      const t = cardTiers(c);
      expect(t["the selected theme segment"]!, `${where} segment drifted`).toBeCloseTo(segment, 2);
      // The text half of the card is fine, so nothing else in the predicate can
      // be doing this work — which is what makes it a test of the accent term.
      const textMin = Math.min(
        ...CARD_PAIRS.map(([ink, surface]) => t[`${ink} on ${surface}`]!),
      );
      expect(textMin, `${where}: the text tiers stopped being comfortable`)
        .toBeCloseTo(textFloor, 2);
      expect(textMin, `${where}: the text tiers must not be what fires this`)
        .toBeGreaterThan(CARD_RESCUE_RATIO * 2);
      expect(weakestTier(c), where).toBe("the selected theme segment");
      expect(rescued(c), `${where}: the theme control is unreadable and was not rescued`).toBe(true);
    }
  });

  /** The selected segment's two painted states, measured separately. The tier in
   *  `cardTiers` is the minimum of these; the two cases below pin each one. */
  const segmentAtRest = (c: CustomTheme): number =>
    contrastRatioHex(deriveCustomTheme(c).vars["--accent-strong"], deriveCustomTheme(c).vars["--bg-input"]);
  const segmentHovered = (c: CustomTheme): number =>
    contrastRatioHex(deriveCustomTheme(c).vars["--accent-strong"], dimFillOverTrack(c));

  it("fires when the selected segment reads at rest and dies under the pointer", () => {
    // The hovered half of the segment tier. Both themes are legible while the
    // pointer is elsewhere and go under the moment it arrives on the option —
    // which is the moment the user is trying to click it to change theme.
    //
    // The second row is worth its history. It used to be pinned here as a
    // MUST-NOT-FIRE, proving the term measured the bare track (1.68:1) rather
    // than the dim fill (1.33:1) that loses the cascade at rest. That reading
    // was right about the resting state and wrong about the control: the fill
    // does land on hover. Its numbers are unchanged; its verdict flipped when
    // the hovered state was added, and the guard it used to provide now lives in
    // the case below.
    const hoverOnly: [CustomTheme, number, number, number, string][] = [
      [{ background: "#0033ff", accent: "#330000", text: "#33ffff" }, 1.63, 1.31, 1.83, "blue"],
      [{ background: "#00cc33", accent: "#ff00ff", text: "#000000" }, 1.68, 1.33, 3.39, "green"],
    ];
    for (const [c, atRest, hovered, textFloor, where] of hoverOnly) {
      expect(segmentAtRest(c), `${where}: fixture drifted, it no longer reads at rest`)
        .toBeCloseTo(atRest, 2);
      expect(segmentHovered(c), `${where}: fixture drifted, it no longer dies hovered`)
        .toBeCloseTo(hovered, 2);
      expect(segmentAtRest(c), where).toBeGreaterThan(CARD_RESCUE_RATIO);
      expect(segmentHovered(c), where).toBeLessThan(CARD_RESCUE_RATIO);
      // Every text pair is clear of the line, so the segment alone decides.
      const textMin = Math.min(
        ...CARD_PAIRS.map(([ink, surface]) =>
          contrastRatioHex(deriveCustomTheme(c).vars[ink], deriveCustomTheme(c).vars[surface]),
        ),
      );
      expect(textMin, `${where}: the text pairs stopped being irrelevant`).toBeCloseTo(textFloor, 2);
      expect(textMin, where).toBeGreaterThan(CARD_RESCUE_RATIO);
      expect(rescued(c), `${where}: the theme control dies under the pointer and nothing noticed`)
        .toBe(true);
    }
  });

  it("fires when the selected segment dies at rest even though hovering it would pass", () => {
    // The resting half, and the direction that is easy to lose: the hovered
    // state is USUALLY the weaker one, so a term that measured only the
    // composited fill would look right nearly everywhere and still strand this
    // user. It happens when the accent is much darker than the track — the dim
    // fill then drags the surface AWAY from the lifted --accent-strong ink and
    // hovering makes the option easier to see, not harder.
    //
    // This is the guard the #00cc33 fixture above used to provide, restated for
    // an implementation that takes the minimum of two states rather than picking
    // one: it fails if the resting term is ever dropped.
    const c: CustomTheme = { background: "#cc0033", accent: "#0066cc", text: "#000000" };
    expect(segmentAtRest(c), "fixture drifted: the segment no longer dies at rest")
      .toBeCloseTo(1.33, 2);
    expect(segmentHovered(c), "fixture drifted: hovering no longer rescues it")
      .toBeCloseTo(1.68, 2);
    expect(segmentAtRest(c)).toBeLessThan(CARD_RESCUE_RATIO);
    expect(segmentHovered(c)).toBeGreaterThan(CARD_RESCUE_RATIO);
    const { vars: v } = deriveCustomTheme(c);
    const textMin = Math.min(...CARD_PAIRS.map(([ink, surface]) => contrastRatioHex(v[ink], v[surface])));
    expect(textMin, "the text pairs stopped being irrelevant here").toBeCloseTo(2.07, 2);
    expect(textMin).toBeGreaterThan(CARD_RESCUE_RATIO);
    expect(rescued(c), "the theme control is unreadable until you hover it, and nothing noticed")
      .toBe(true);
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
    // literally one of the ten tiers this predicate takes the minimum over, so
    // an unreadable editor topbar cannot happen without an unreadable card. It
    // is asserted as the fact it is rather than straddled, because no fixture in
    // the other direction can exist while that term is in the set.
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
    // the home gear are both fine. This is the fixture the E2E paints to show
    // the same theme leaving the gear alone and rescuing the card.
    const cardOnly: CustomTheme = { background: "#241a3d", accent: "#ff5fa2", text: "#6a5f85" };
    const d = deriveCustomTheme(cardOnly);
    expect(contrastRatioHex(d.vars["--text-1"], d.vars["--bg-app"])).toBeCloseTo(2.78, 2);
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
    expect(cardMin(other)).toBeCloseTo(1.68, 2);
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
