// App-wide session state: settings (theme, shortcuts, …) and the currently
// open project with autosave + undo/redo orchestration.

import { History } from "./history";
import { describeError, ipc, type SettingsRead } from "./ipc";
import { touchModified } from "./project";
import { Store } from "./store";
import type { ActionId, CustomTheme, ProjectFile, Settings } from "./types";
import {
  DEFAULT_CUSTOM_THEME,
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  LEGACY_BASE_COLORS,
} from "./types";

/* ---------------- settings ---------------- */

export const settingsStore = new Store<Settings>(DEFAULT_SETTINGS);

/* ---------------- custom theme colours ----------------
 *
 * WHAT THE THREE USER COLOURS MAP TO
 *
 *   background → --bg-app (the literal pick), the surface ramp derived from it
 *                (--bg-panel, --bg-raised, --bg-input, --bg-hover, --bg-active,
 *                --border, --border-strong, --ruler-tick), and --on-accent
 *   accent     → --accent (the literal pick), --accent-strong, --accent-dim,
 *                --clip-video-bg/-border, --clip-audio-bg/-border, --wave
 *   text       → --text-1 (the literal pick), --text-2, --text-3
 *
 * EVERY PICK IS USED VERBATIM. There is no contrast floor here, no lightness
 * search, and no "we moved your colour" note. Whatever hex is chosen is the hex
 * that ships, however low its contrast: the user knows their own screen, and a
 * control that quietly refuses to keep getting darker is a worse experience
 * than one that shows exactly what was asked for. What IS derived is only what
 * the user did NOT pick — the ramp shades, the two quieter text steps, the clip
 * tints — because those exist to sit at a fixed distance from a pick, not to
 * overrule it.
 *
 * --on-accent (the ink drawn ON accent-filled surfaces: primary buttons, the
 * home brand mark, the switch knob, the project-card check) is simply the
 * BACKGROUND colour. One rule, no derivation, no contrast test: "whatever sits
 * on the accent is your background colour". That is what makes the brand mark
 * come out as a background-coloured "T" in an accent-coloured tile, and it is a
 * pairing a user can predict without knowing anything about relative luminance.
 *
 * The accent is the app's one interactive colour: primary buttons, the
 * toggled-on state, focus rings, ::selection, the home brand mark, the switch,
 * every drop overlay, and the whole timeline — video clips, audio clips and the
 * waveform. Clip fills were never an independent colour anyway (in BOTH shipped
 * palettes they are desaturated tints of the accent hue), so they are mixed
 * from the accent toward the derived panel. Audio sits at a weaker mix than
 * video purely so the two lanes stay distinguishable at a glance; it is the
 * same hue.
 *
 * DELIBERATELY NOT THEMABLE: --danger / --danger-dim (destructive), --ok,
 * --warn (status semantics) and --playhead (the one marker that must always be
 * findable). Those keep the built-in palette's values — a user-chosen hex on
 * any of them either hides a destructive action or loses the playhead. The
 * --shadow-* triple is likewise left alone: shadows are black/near-black alpha,
 * and the light/dark pair is picked by the surface direction below.
 *
 * THE ONE EXCEPTION is the escape hatch — see SAFE_APPEARANCE further down.
 * Settings → Appearance and its colour picker deliberately do NOT render in the
 * user's colours, so a theme that hides everything can always be undone. Read
 * that comment before "fixing" it for consistency.
 */

type RGB = readonly [number, number, number];

/** Exactly `rgb` or `rrggbb`, ASCII hex only. Anchored with no alternation
 *  that can backtrack, and only ever run on an already length-bounded string. */
const HEX_BODY = /^[0-9a-f]{3}$|^[0-9a-f]{6}$/;

/**
 * Coerce an arbitrary persisted value into a lowercase `#rrggbb` literal.
 *
 * VALIDATE BEFORE YOU SLICE — the v0.7.2 `parse_color` lesson, applied on this
 * side of the wire. The length is bounded before anything allocates, the WHOLE
 * body is proven to be ASCII hex before a single character is read
 * positionally, and the result is rebuilt from characters that passed. So no
 * string that was not proven to be a hex colour can reach a CSS custom
 * property, a `background:` declaration, or an FFmpeg sink downstream. A CSS
 * colour NAME is deliberately rejected too: `#rrggbb` is the only shape the
 * derivation below can do arithmetic on.
 *
 * Accepts `#rgb`, `#rrggbb`, and both without the leading `#` (plausible
 * hand-edits). Everything else — non-strings, wrong lengths, non-hex or
 * non-ASCII characters, `javascript:` URLs, CSS injection attempts, megabyte
 * blobs — returns `fallback`.
 */
export function normalizeHexColor(v: unknown, fallback: string): string {
  // Bound the work FIRST: settings.json is opaque to the backend, so this can
  // be handed a megabyte-long string, and trim()/toLowerCase() on one is a real
  // allocation. 12 is "#rrggbb" plus slack for stray whitespace.
  if (typeof v !== "string" || v.length > 12) return fallback;
  const s = v.trim().toLowerCase();
  const body = s.startsWith("#") ? s.slice(1) : s;
  if (!HEX_BODY.test(body)) return fallback;
  if (body.length === 3) {
    const r = body[0]!;
    const g = body[1]!;
    const b = body[2]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return `#${body}`;
}

/** Only ever called with a string that passed `normalizeHexColor`. */
function hexToRgb(hex: string): RGB {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

/** Always emits a 7-character `#rrggbb` built from clamped integers, so the
 *  string handed to `style.setProperty` is one this module constructed rather
 *  than one it was given. */
function rgbToHex(c: RGB): string {
  const n = (clamp255(c[0]) << 16) | (clamp255(c[1]) << 8) | clamp255(c[2]);
  return `#${(n | 0x1000000).toString(16).slice(1)}`;
}

/** h in degrees, s and l in percent. */
function rgbToHsl(c: RGB): [number, number, number] {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (l > 0.5 ? 2 - max - min : max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const hh = ((h % 360) + 360) % 360;
  const f = (n: number): number => {
    const k = (n + hh / 30) % 12;
    return ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [clamp255(f(0) * 255), clamp255(f(8) * 255), clamp255(f(4) * 255)];
}

/** WCAG 2.1 relative luminance. */
function luminance(c: RGB): number {
  const ch = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colours, 1 .. 21. */
export function contrastRatioHex(a: string, b: string): number {
  const la = luminance(hexToRgb(normalizeHexColor(a, "#000000")));
  const lb = luminance(hexToRgb(normalizeHexColor(b, "#000000")));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Blend toward `base`, the same arithmetic as `color-mix(in srgb, …)`.
 *  Rounded to whole channels so what the contrast maths measures is exactly
 *  what `rgbToHex` later writes. */
function mix(c: RGB, base: RGB, amount: number): RGB {
  return [
    clamp255(c[0] * amount + base[0] * (1 - amount)),
    clamp255(c[1] * amount + base[1] * (1 - amount)),
    clamp255(c[2] * amount + base[2] * (1 - amount)),
  ];
}

/**
 * The relative luminance at which black ink and white ink are exactly as
 * legible: (1.05)/(L+0.05) == (L+0.05)/0.05, i.e. L = sqrt(1.05*0.05) - 0.05
 * ≈ 0.1791. At or above it the app renders as a LIGHT surface, below it as a
 * dark one.
 *
 * This replaces the old explicit `base: "dark" | "light"` switch. Reading the
 * direction off the background is the only thing that can work once the
 * background is an arbitrary colour, and the ink crossover is the right
 * threshold rather than "lightness > 50%": it is defined by which ink actually
 * reads on the colour, which is precisely the decision every derived step below
 * has to make. #ff0000 (luminance 0.213) is therefore a LIGHT surface — black
 * text on red reads 5.25:1, white only 4.0:1 — which is correct however
 * surprising a red app looks.
 */
const LIGHT_SURFACE_LUM = Math.sqrt(1.05 * 0.05) - 0.05;

interface SurfaceSpec {
  /** Signed HSL lightness offsets (percentage points) from the user's
   *  background, one per derived surface. Measured off the two shipped
   *  palettes, so feeding the stock #111113 / #f6f6f8 back in reproduces them
   *  channel-for-channel. Hue and saturation always come from the background,
   *  so a tinted background yields a tinted ramp instead of gray patches. */
  panel: number;
  raised: number;
  input: number;
  hover: number;
  active: number;
  border: number;
  borderStrong: number;
  rulerTick: number;
  /** --text-2 / --text-3 as the surviving fraction of --text-1 on the way to
   *  --bg-panel (1 = the text colour, 0 = the panel). Also measured off the
   *  shipped ramps. */
  text2: number;
  text3: number;
  /** --accent-dim alpha, matching the shipped palette. */
  dimAlpha: number;
  /** --accent-strong (the hover state): the fraction of the remaining distance
   *  from the accent's lightness toward white (positive → dark surface, where
   *  hover is lighter) or toward black (negative → light surface, where hover
   *  is darker). Reproduces the shipped pairs almost exactly: dark 71.2% →
   *  76.4% (shipped 76.1%), light 62.2% → 55.3% (shipped 55.1%). */
  strongLift: number;
  /** How far --clip-video-bg / --clip-video-border sit from the panel colour on
   *  the way to the accent. Pinned rather than taken from the user's colour, so
   *  a clip fill stays legible against its lane whatever hex is chosen. */
  clipVideo: readonly [number, number];
  /** The same for audio clips, deliberately weaker: both lanes are the accent
   *  now, and two identical fills would make a video and an audio clip
   *  indistinguishable at a glance. */
  clipAudio: readonly [number, number];
}

const DARK_SURFACE: SurfaceSpec = {
  panel: 2.549,
  raised: 5.098,
  input: 3.922,
  hover: 8.039,
  active: 10.98,
  border: 9.02,
  borderStrong: 15.294,
  rulerTick: 24.118,
  text2: 0.662,
  text3: 0.408,
  dimAlpha: 0.15,
  strongLift: 0.18,
  clipVideo: [0.25, 0.58],
  clipAudio: [0.16, 0.42],
};

const LIGHT_SURFACE: SurfaceSpec = {
  panel: 3.137,
  raised: 3.137,
  input: -1.373,
  hover: -2.549,
  active: -5.294,
  border: -6.471,
  borderStrong: -13.922,
  rulerTick: -22.157,
  text2: 0.719,
  text3: 0.491,
  dimAlpha: 0.12,
  strongLift: -0.11,
  clipVideo: [0.2, 0.65],
  clipAudio: [0.13, 0.48],
};

/** The exact set of custom properties a custom theme owns. Written together,
 *  cleared together — nothing else on the root is ever touched. Anything NOT on
 *  this list keeps the built-in palette value for the derived surface direction
 *  (see the header comment for what is deliberately left fixed). */
export const CUSTOM_THEME_VARS = [
  "--bg-app",
  "--bg-panel",
  "--bg-raised",
  "--bg-input",
  "--bg-hover",
  "--bg-active",
  "--border",
  "--border-strong",
  "--ruler-tick",
  "--text-1",
  "--text-2",
  "--text-3",
  "--accent",
  "--accent-strong",
  "--accent-dim",
  "--on-accent",
  "--clip-video-bg",
  "--clip-video-border",
  "--clip-audio-bg",
  "--clip-audio-border",
  "--wave",
] as const;

type CustomVarName = (typeof CUSTOM_THEME_VARS)[number];

export interface DerivedTheme {
  vars: Record<CustomVarName, string>;
  /** Which built-in palette supplies everything a custom theme does NOT
   *  override, and which `color-scheme` the webview gets. */
  surface: "dark" | "light";
}

/* ---------------- the escape hatch ----------------
 *
 * WHY THIS ONE CARD IS DIFFERENT — do NOT "consistency-fix" it back to the
 * user's colours.
 *
 * Every pick above is honoured literally, which means a user can set
 * background, accent and text all to the same hex (or all to black, or all to
 * white) and end up with an app in which nothing at all is visible. That is
 * allowed. What is NOT allowed is being STUCK there.
 *
 * So Settings → Appearance — the one screen that can undo it — and the colour
 * picker it opens can render in a palette of their own: the built-in Dark or
 * Light values, chosen by the direction the background implies so the card
 * still matches the app's overall character, but never computed FROM the user's
 * colours. Whatever the three picks are, that palette is legible against
 * itself, because nothing about it depends on the picks.
 *
 * The picker gets the same treatment on purpose: it is the second half of the
 * same recovery gesture (it is where "Reset to default" lives), and an
 * unreadable Reset button is exactly the dead end this exists to prevent. One
 * flag covers both; a readable card that opens an unreadable popover is still
 * a dead end.
 *
 * CONDITIONAL, since v0.7.5 — see `needsAppearanceRescue` below for the
 * trigger and how it is calibrated. Until then the card rendered from these
 * constants for EVERY custom theme, which made its legibility a structural
 * guarantee but also left a permanently mismatched card sitting in the middle
 * of an app the user had deliberately coloured. It now behaves like the nav
 * rescue: the user's own colours until they measurably stop working.
 *
 * That trade is worth naming. A guarantee that held by construction now holds
 * by measurement, so the predicate is the whole feature — if it is wrong in the
 * "did not fire" direction a user is permanently stranded. The tests in
 * `session.test.ts` are load-bearing, not a formality.
 *
 * Scope: `applyTheme` writes these ONLY while a custom theme is active (the
 * home and editor rescues read them too, so they are published whenever custom
 * is on, not only when this card needs them), and `settings.css` consumes them
 * ONLY under `.settings__card--appearance` and `.cp`, gated on
 * `html[data-rescue-appearance]`. The rest of Settings, and the rest of the
 * app, stay fully in the user's colours. The gate is load-bearing: that
 * attribute is only ever stamped inside the custom branch, and with no custom
 * theme these properties do not exist — a `var(--safe-…)` with no fallback
 * would resolve to the guaranteed-invalid value rather than to the palette.
 *
 * The colour SWATCHES are deliberately still the user's literal picks — that is
 * the whole point of the card — so each one carries a `--border-strong` outline
 * from this palette, which keeps a swatch findable even when it matches the
 * card exactly.
 */

/** The card-local overrides. One per palette token the Appearance card or the
 *  colour picker can reach: `.card`, `.btn`, `.btn--on`, `.input`, `.slider`,
 *  `:focus-visible` and the settings rows between them. */
export const SAFE_THEME_VARS = [
  "--safe-panel",
  "--safe-raised",
  "--safe-input",
  "--safe-hover",
  "--safe-active",
  "--safe-border",
  "--safe-border-strong",
  "--safe-text-1",
  "--safe-text-2",
  "--safe-text-3",
  "--safe-accent",
  "--safe-accent-strong",
  "--safe-accent-dim",
] as const;

type SafeVarName = (typeof SAFE_THEME_VARS)[number];

/** Verbatim copies of the two shipped palettes' values for those tokens. They
 *  are literals rather than anything derived precisely so that no user input
 *  can reach them — that independence IS the guarantee. If the palettes in
 *  tokens.css are ever retuned, retune these with them. */
export const SAFE_APPEARANCE: Record<"dark" | "light", Record<SafeVarName, string>> = {
  dark: {
    "--safe-panel": "#17171a",
    "--safe-raised": "#1d1d21",
    "--safe-input": "#1a1a1e",
    "--safe-hover": "#242429",
    "--safe-active": "#2b2b31",
    "--safe-border": "#26262c",
    "--safe-border-strong": "#35353d",
    "--safe-text-1": "#ececf1",
    "--safe-text-2": "#a4a4af",
    "--safe-text-3": "#6e6e79",
    "--safe-accent": "#6c7cff",
    "--safe-accent-strong": "#8592ff",
    "--safe-accent-dim": "rgba(108, 124, 255, 0.15)",
  },
  light: {
    "--safe-panel": "#ffffff",
    "--safe-raised": "#ffffff",
    "--safe-input": "#f2f2f5",
    "--safe-hover": "#efeff2",
    "--safe-active": "#e7e7ec",
    "--safe-border": "#e4e4e9",
    "--safe-border-strong": "#cfcfd8",
    "--safe-text-1": "#1b1b20",
    "--safe-text-2": "#5b5b66",
    "--safe-text-3": "#8f8f9b",
    "--safe-accent": "#5563e8",
    "--safe-accent-strong": "#4351d6",
    "--safe-accent-dim": "rgba(85, 99, 232, 0.12)",
  },
};

/* ---------------- the nav rescue ----------------
 *
 * The escape hatch above guarantees Settings → Appearance is readable ONCE YOU
 * ARE THERE. It says nothing about getting there. On the home screen the only
 * route into Settings is the gear (`#home-settings`), a `.btn--ghost.btn--icon`:
 * transparent fill, transparent border, so its ONLY ink is the icon stroke, in
 * `--text-1` (inherited from `.btn`; `.btn--ghost` overrides background and
 * border, not colour), on `--bg-app` (the header and `.home` paint nothing, so
 * the surface behind it is `body`'s background). Pick a text that matches the
 * background and the way out of the theme becomes invisible.
 *
 * So this flag exists — and, unlike the Appearance card, it is CONDITIONAL.
 * A deliberately ugly theme that is merely hard to read is left completely
 * alone; that is the whole point of shipping the picks verbatim. It fires only
 * when the gear is effectively not there at all.
 *
 * WHY 1.5:1, and not the number an accessibility checker would hand you.
 *
 * The anchors: 1.0 is literally the same colour; 3.0 is WCAG 2.1 SC 1.4.11, the
 * minimum for a user-interface component; 4.5 is body-text AA. The bar here is
 * "you actually can't see it at all", which is far BELOW 1.4.11 — a gear at
 * 2.8:1 already fails WCAG and is still perfectly easy to find. Triggering at
 * 3:1 would rescue every merely-poor theme, which is contrast clamping wearing
 * a different hat.
 *
 * It is also not a text bar, and that pushes the number UP rather than down.
 * `icon()` emits `stroke-width="2"` in a 24-unit viewBox, and `.btn svg` renders
 * it into 16x16 — so the gear is drawn with a 2 * 16/24 = 1.33 px stroke. At
 * 100% scale essentially every pixel of that line is a partial-coverage
 * antialias blend, so what reaches the eye is a fraction of the nominal ratio,
 * and there is no repeated stem pattern (the way a word of 13 px text has) to
 * integrate over. For a text label "gone" would be around 1.3:1; for a hairline
 * glyph the same perceptual point sits higher. 1.5 is that adjustment, and it
 * lands exactly where it should: identical colours (1.00), a near-identical pick
 * (1.005) and the 1.33:1 pick the E2E pins as legal-but-unreadable all fire,
 * while 1.77:1 and 2.78:1 picks — bad, WCAG-failing, but findable — do not.
 */

/** Below this contrast ratio the home gear counts as not visible at all. Half
 *  the WCAG UI-component floor, deliberately: see the comment above before
 *  changing it, and note that raising it toward 3 turns this into clamping. */
export const NAV_RESCUE_RATIO = 1.5;

/**
 * Would the home Settings gear be effectively invisible under this theme?
 *
 * Measured off the EMITTED tokens rather than the raw picks, so it stays true
 * to what is actually painted if the mapping ever changes: `--text-1` is the
 * gear's real ink and `--bg-app` is the real surface behind it. Pure, and cheap
 * enough to run on every pointer frame of a colour drag (six pow() calls
 * against twenty-one style writes already in flight).
 */
export function needsNavRescue(derived: DerivedTheme): boolean {
  return contrastRatioHex(derived.vars["--text-1"], derived.vars["--bg-app"]) < NAV_RESCUE_RATIO;
}

/**
 * The same question for the EDITOR's route-out controls (Back and the gear),
 * which sit on `.editor__topbar` — `--bg-panel`, a DERIVED shade, not `--bg-app`.
 *
 * This genuinely needs its own predicate rather than reusing the one above: the
 * two disagree in both directions. `{bg #241a3d, text #453274}` measures 1.52:1
 * on the app background but 1.43:1 on the panel — home is correctly left alone
 * while the editor chrome would be invisible and unrescued; `{bg #3d1f6e,
 * text #11091e}` straddles it the other way (1.50 app / 1.61 panel).
 */
export function needsChromeRescue(derived: DerivedTheme): boolean {
  return contrastRatioHex(derived.vars["--text-1"], derived.vars["--bg-panel"]) < NAV_RESCUE_RATIO;
}

/* ---------------- the Appearance card rescue ----------------
 *
 * The third flag: it decides whether the escape hatch above renders at all.
 *
 * IT IS THE SAME QUESTION AS THE GEAR, asked about more surfaces. All three
 * predicates now gate on `--text-1`, because in all three cases that ink IS the
 * escape route. The gear is one ink on `--bg-app`; the editor chrome is the same
 * ink on `--bg-panel`; this card is the same ink on the five surfaces the card
 * and the picker paint buttons and labels on. See `CARD_PAIRS` for which, and
 * why the quieter tiers are deliberately NOT in the list.
 *
 * WHY 1.5:1. Same bar as the nav rescue, and now genuinely the same measurement,
 * so it is the same number for the same reason: "you cannot see it at all", well
 * below WCAG's 3:1 for a UI component, because firing on a merely-poor theme is
 * contrast clamping wearing a different hat. Measured on what actually ships:
 *
 *   left alone  11.9 / 13.9  both shipped palettes fed back in as custom
 *                2.3 – 3.4   ordinary custom themes: a dusty red app, a muted
 *                            mid-gray, true Solarized Dark on base0, Solarized
 *                            Light on base1
 *                2.09        text picked close enough that the HINTS are gone
 *                            while every label and button still reads — left
 *                            alone on purpose, see CARD_PAIRS
 *   ---- 1.5 ----
 *   rescued      1.49        text picked on the background, light surface
 *                1.00 – 1.38 the same on dark, and the legal-but-unreadable
 *                            pick the E2E pins
 *                1.07 – 1.22 every all-one-colour theme
 *
 * The gap either side of 1.5 is wide — 1.49 to 2.09 — which is the point. The
 * previous, broader rule put the same bar between 1.37 and 1.53, a 2% margin
 * where a real palette sat one rounding step from losing its colours.
 *
 * WHICH WAY TO BE WRONG — and the owner's ruling on it, 2026-08-11. Failing to
 * fire strands someone with no way to undo their theme. Firing when it was not
 * needed puts a mismatched card in the middle of an app they deliberately
 * coloured, on the one screen they went to in order to colour it. The first is
 * worse, so the primary ink is measured against every surface it lands on and
 * the weakest decides. But the second is not free, and the earlier calibration
 * paid it too often — a perfectly readable dusty-red theme was rescued because a
 * blue accent went quiet against the derived track. The bar is "truly cannot see
 * it", effectively the all-one-colour case, and NOT "some caption went faint".
 */

/** Below this contrast ratio the Appearance card's primary ink counts as gone,
 *  and the card plus the colour picker fall back to the fixed `--safe-*`
 *  palette. Same bar and same meaning as `NAV_RESCUE_RATIO` — see the note
 *  above before moving it. Kept as its own constant because the two protect
 *  different controls and may still need to move apart. */
export const CARD_RESCUE_RATIO = 1.5;

/**
 * The pairs that decide it: `--text-1` — and ONLY `--text-1` — against every
 * surface the card and the picker paint it on.
 *
 * WHY ONLY THE PRIMARY INK (owner's ruling, 2026-08-11, after seeing it run).
 *
 * Recovery needs exactly two things to be visible: the unselected segments
 * (Dark / Light / System) so a built-in theme can be clicked, and the picker's
 * "Reset to default". Both are `--text-1` on a `.btn`-family surface. That is
 * the whole escape route. The quieter tiers are comfort, not escape:
 *
 *   --text-2  the mono hex captions and .cp__title — nice to read, but nothing
 *             here is the way out
 *   --text-3  the section head and the row hints — the faintest tier, and by
 *             construction `--text-1` walked 40.8% toward the panel, so it sits
 *             near 1:1 for whole families of perfectly usable themes
 *   --accent-strong  the SELECTED segment. If it vanishes you lose "which theme
 *             is live", but Dark/Light/System are still `--text-1` beside it and
 *             still clickable, so you are not stuck.
 *
 * Gating on the weakest of all of those fired on themes that are entirely
 * readable. A dusty-red app (`#a86060`) with row labels at 3.6:1 was rescued
 * because a blue accent measured 1.47 against the derived track — a mismatched
 * card in an app the user had deliberately coloured, which is precisely the
 * eyesore this release set out to remove. The bar is "you truly cannot see it",
 * effectively the all-one-colour case, not "one caption went quiet".
 *
 * This deliberately reverses the earlier, broader rule. What is given up is
 * stated plainly: a theme CAN now keep the user's colours while its hints and
 * section head are unreadable. That is accepted — those are not the way out,
 * and the way out is what this flag exists to protect.
 *
 * Hover and active stay in the list for the same reason the home gear's rescue
 * restyles `:hover`: a label that is legible until the pointer reaches it has
 * still failed at the moment it is being used.
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
] as const;

/**
 * Would Settings → Appearance (and the picker it opens) be unreadable in the
 * user's own colours?
 *
 * Measured off the EMITTED tokens, like the two predicates above, so it stays
 * true to what is actually painted rather than to the three raw picks.
 */
export function needsAppearanceRescue(derived: DerivedTheme): boolean {
  const v = derived.vars;
  for (const [ink, surface] of CARD_PAIRS) {
    if (contrastRatioHex(v[ink], v[surface]) < CARD_RESCUE_RATIO) return true;
  }
  return false;
}

/**
 * Turn the three user colours into the custom properties above. Pure, so it is
 * unit-testable without a DOM.
 *
 * The user sets --bg-app, --accent and --text-1 and gets exactly those. Every
 * OTHER value is derived here and none of them is settable — not to protect the
 * user from their own picks, but because a ramp is only meaningful as a set of
 * offsets from one colour. Hand-picking a panel shade, a hover shade and a
 * border independently of the background is how you get an app that looks
 * broken rather than themed.
 */
export function deriveCustomTheme(custom: CustomTheme): DerivedTheme {
  // Re-validated AT THE SINK, not just on load: updateSettings takes a partial
  // from any caller, so the store is not by itself a trusted source.
  const background = hexToRgb(
    normalizeHexColor(custom.background, DEFAULT_CUSTOM_THEME.background),
  );
  const accent = hexToRgb(normalizeHexColor(custom.accent, DEFAULT_CUSTOM_THEME.accent));
  const text1 = hexToRgb(normalizeHexColor(custom.text, DEFAULT_CUSTOM_THEME.text));

  const surface = luminance(background) >= LIGHT_SURFACE_LUM ? "light" : "dark";
  const spec = surface === "light" ? LIGHT_SURFACE : DARK_SURFACE;

  const [bh, bs, bl] = rgbToHsl(background);
  const shade = (d: number): RGB => hslToRgb(bh, bs, bl + d);
  const panel = shade(spec.panel);

  const [ah, asat, al] = rgbToHsl(accent);
  const strongL =
    spec.strongLift >= 0 ? al + (100 - al) * spec.strongLift : al + al * spec.strongLift;

  return {
    surface,
    vars: {
      "--bg-app": rgbToHex(background),
      "--bg-panel": rgbToHex(panel),
      "--bg-raised": rgbToHex(shade(spec.raised)),
      "--bg-input": rgbToHex(shade(spec.input)),
      "--bg-hover": rgbToHex(shade(spec.hover)),
      "--bg-active": rgbToHex(shade(spec.active)),
      "--border": rgbToHex(shade(spec.border)),
      "--border-strong": rgbToHex(shade(spec.borderStrong)),
      "--ruler-tick": rgbToHex(shade(spec.rulerTick)),
      "--text-1": rgbToHex(text1),
      // The two quieter steps are the text colour walked toward the panel, so
      // they stay in the user's own ink rather than turning gray.
      "--text-2": rgbToHex(mix(text1, panel, spec.text2)),
      "--text-3": rgbToHex(mix(text1, panel, spec.text3)),
      "--accent": rgbToHex(accent),
      "--accent-strong": rgbToHex(hslToRgb(ah, asat, strongL)),
      "--accent-dim": `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${spec.dimAlpha})`,
      // Ink on accent surfaces IS the background colour — see the header.
      "--on-accent": rgbToHex(background),
      "--clip-video-bg": rgbToHex(mix(accent, panel, spec.clipVideo[0])),
      "--clip-video-border": rgbToHex(mix(accent, panel, spec.clipVideo[1])),
      "--clip-audio-bg": rgbToHex(mix(accent, panel, spec.clipAudio[0])),
      "--clip-audio-border": rgbToHex(mix(accent, panel, spec.clipAudio[1])),
      // The waveform is the accent itself: the audio clip fill it is drawn on
      // is a mix of that same accent toward the panel, so the two separate by
      // exactly the mix amount, whatever colour was picked.
      "--wave": rgbToHex(accent),
    },
  };
}

/** True only while a custom theme's variables are actually on the root
 *  element. A non-custom theme therefore costs exactly what it did before this
 *  feature existed — one dataset write and one boolean test — and nothing is
 *  ever cleared that was never written. */
let customVarsWritten = false;

/** Which escape-hatch palette is currently on the root, so a drag that never
 *  crosses the ink crossover writes those thirteen properties exactly once
 *  instead of once per pointer frame. */
let safeVarsSurface: "dark" | "light" | null = null;

/** Whether `data-rescue-nav` is currently stamped, for the same reason: a drag
 *  through the invisible band must not write the attribute (and invalidate
 *  style) on every pointer frame — only on an actual crossing. */
let rescueNavOn = false;

/** Same, for the editor chrome. Tracked separately because it is measured
 *  against `--bg-panel` and genuinely crosses at different picks. */
let rescueChromeOn = false;

/** Same, for the Appearance card and the colour picker. Crosses at different
 *  picks again: it is the minimum over four tiers, not one ink on one surface,
 *  so it fires for themes both nav flags leave alone. */
let rescueAppearanceOn = false;

export function applyTheme(theme: Settings["theme"], custom?: CustomTheme): DerivedTheme | null {
  const root = document.documentElement;

  if (theme === "custom") {
    const derived = deriveCustomTheme(custom ?? DEFAULT_CUSTOM_THEME);
    // Whatever a custom theme does NOT override still comes from a real
    // built-in palette — danger/ok/warn/playhead, the shadows, color-scheme —
    // so the direction read off the background picks which one.
    root.dataset.theme = derived.surface;
    for (const name of CUSTOM_THEME_VARS) root.style.setProperty(name, derived.vars[name]);
    if (safeVarsSurface !== derived.surface) {
      const safe = SAFE_APPEARANCE[derived.surface];
      for (const name of SAFE_THEME_VARS) root.style.setProperty(name, safe[name]);
      safeVarsSurface = derived.surface;
    }
    // The flag settings.css gates the escape hatch on. Without it the card
    // would reference custom properties that do not exist under Dark/Light.
    // Set once, not per pointer frame: it is cleared only on the way out of
    // custom, which clears customVarsWritten with it.
    if (!customVarsWritten) root.dataset.customTheme = "1";
    customVarsWritten = true;
    // …and the conditional half of the same idea: the one control that REACHES
    // that card, stamped only while the theme actually hides it. Written after
    // the --safe-* group above so the attribute can never be live for a frame in
    // which the properties home.css reads from it do not exist yet.
    const rescue = needsNavRescue(derived);
    if (rescueNavOn !== rescue) {
      if (rescue) root.dataset.rescueNav = "1";
      else delete root.dataset.rescueNav;
      rescueNavOn = rescue;
    }
    // The editor's Back and gear sit on --bg-panel, so they get their own flag.
    // A user can be stranded in a project just as easily as on home.
    const chrome = needsChromeRescue(derived);
    if (rescueChromeOn !== chrome) {
      if (chrome) root.dataset.rescueChrome = "1";
      else delete root.dataset.rescueChrome;
      rescueChromeOn = chrome;
    }
    // And the card those two exits lead to. Same shape, same reason for the
    // guard: a colour drag must not rewrite the attribute on every frame.
    const appearance = needsAppearanceRescue(derived);
    if (rescueAppearanceOn !== appearance) {
      if (appearance) root.dataset.rescueAppearance = "1";
      else delete root.dataset.rescueAppearance;
      rescueAppearanceOn = appearance;
    }
    return derived;
  }

  root.dataset.theme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  if (customVarsWritten) {
    for (const name of CUSTOM_THEME_VARS) root.style.removeProperty(name);
    for (const name of SAFE_THEME_VARS) root.style.removeProperty(name);
    delete root.dataset.customTheme;
    // Built-in Dark/Light and System can never need the rescue — their ink and
    // their surface are the shipped palette's — so this is only ever a cleanup
    // of a flag the custom branch set, never a value this path computes.
    delete root.dataset.rescueNav;
    delete root.dataset.rescueChrome;
    delete root.dataset.rescueAppearance;
    safeVarsSurface = null;
    rescueNavOn = false;
    rescueChromeOn = false;
    rescueAppearanceOn = false;
    customVarsWritten = false;
  }
  return null;
}

/** Paint a candidate custom theme WITHOUT touching the store or disk, and hand
 *  back what was derived in case the caller wants it. The colour picker calls
 *  this while dragging so the whole app previews live at the cost of one
 *  derivation and 21 style writes per pointer frame —
 *  persisting per pointermove would mean an IPC round trip and a settings.json
 *  write per frame. The commit at the end of the gesture goes through
 *  updateSettings and is authoritative. */
export function previewCustomTheme(custom: CustomTheme): DerivedTheme {
  return applyTheme("custom", custom)!;
}

/* ---------------- settings sanitation ---------------- */

// The backend stores settings opaquely (serde_json::Value), so NOTHING between
// a hand-edited or corrupted settings.json and the app is typed — this file is
// the only sanitizer. A blind spread over the defaults let real values through
// and crashed on first use:
//   shortcuts.<action> not a string → normalizeChord's stored.split("+") throws
//                                     (an unknown EXTRA key was enough)
//   defaultExportDir a number       → escapeHtml's s.replace throws
//   autosaveSeconds "soon"          → Math.max(1, NaN) = NaN, and
//                                     setInterval(fn, NaN) is a 4 ms timer for
//                                     the lifetime of the app (perf veto)
// Every field is therefore coerced to its declared type with a default
// fallback, the way clampVol (playback/audio-graph.ts) already guards
// monitorVolume.

/** Finite number in [lo, hi]. Numeric strings are accepted (a stringified
 *  number is a plausible hand-edit); anything else falls back. */
function asNum(v: unknown, fallback: number, lo: number, hi: number): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** A filesystem path or "not set". Anything non-string becomes null rather than
 *  reaching escapeHtml / the dialog plugin. */
function asPath(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Always a FRESH object with three proven `#rrggbb` colours, so no hand-edited
 *  string can reach `style.setProperty` and nothing aliases the shared
 *  DEFAULT_CUSTOM_THEME.
 *
 *  MIGRATION. The pre-release shape was `{ base: "dark"|"light", primary,
 *  secondary }`, and a settings.json written by that build is already on disk.
 *  `base` was an ENUM, so normalizing it as a colour would throw the user's
 *  choice away — it is mapped to the matching stock background/text pair
 *  instead, and used as the fallback for whatever the new keys don't supply.
 *  `primary` becomes the accent. `secondary` is dropped: audio clips and
 *  waveforms follow the accent now, so there is nothing left for it to mean.
 *  New keys always win; a legacy key is only consulted when its replacement is
 *  missing or fails validation. */
function asCustomTheme(v: unknown): CustomTheme {
  const o: Record<string, unknown> =
    v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const legacy = o.base === "light" ? LEGACY_BASE_COLORS.light : LEGACY_BASE_COLORS.dark;
  return {
    background: normalizeHexColor(o.background, legacy.background),
    accent: normalizeHexColor(o.accent, normalizeHexColor(o.primary, DEFAULT_CUSTOM_THEME.accent)),
    text: normalizeHexColor(o.text, legacy.text),
  };
}

/** Coerce an arbitrary persisted value into a valid Settings. Never throws. */
export function sanitizeSettings(raw: unknown): Settings {
  const o: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  // Rebuild the shortcut map from the defaults: only KNOWN actions bound to a
  // STRING survive, so neither an extra key nor a non-string binding can reach
  // normalizeChord.
  const rawShortcuts: Record<string, unknown> =
    o.shortcuts !== null && typeof o.shortcuts === "object"
      ? (o.shortcuts as Record<string, unknown>)
      : {};
  const shortcuts = { ...DEFAULT_SHORTCUTS };
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ActionId[]) {
    const chord = rawShortcuts[action];
    if (typeof chord === "string") shortcuts[action] = chord;
  }

  const theme = o.theme;
  return {
    schema: 1,
    theme:
      theme === "dark" || theme === "light" || theme === "system" || theme === "custom"
        ? theme
        : DEFAULT_SETTINGS.theme,
    customTheme: asCustomTheme(o.customTheme),
    // >= 1 s keeps setInterval off the 4 ms floor; the cap is a sanity bound.
    autosaveSeconds: asNum(o.autosaveSeconds, DEFAULT_SETTINGS.autosaveSeconds, 1, 3600),
    defaultExportDir: asPath(o.defaultExportDir),
    lastExportDir: asPath(o.lastExportDir),
    hardwareAccel: asBool(o.hardwareAccel, DEFAULT_SETTINGS.hardwareAccel),
    cacheLimitMB: asNum(o.cacheLimitMB, DEFAULT_SETTINGS.cacheLimitMB, 1, 1024 * 1024),
    proxyMedia: asBool(o.proxyMedia, DEFAULT_SETTINGS.proxyMedia),
    snapCenterGuides: asBool(o.snapCenterGuides, DEFAULT_SETTINGS.snapCenterGuides),
    tempOpenWith: asBool(o.tempOpenWith, DEFAULT_SETTINGS.tempOpenWith),
    monitorVolume: asNum(o.monitorVolume, DEFAULT_SETTINGS.monitorVolume, 0, 1),
    shortcuts,
  };
}

/* ---------------- loading settings, and not destroying them ----------------
 *
 * THE BUG THIS SHAPE EXISTS TO PREVENT. `initSettings` used to swallow a
 * rejecting `get_settings` with a bare `catch {}` and leave the store at
 * DEFAULT_SETTINGS. Nothing was surfaced, so the app simply came up looking
 * like a fresh install — and then the FIRST `updateSettings` wrote
 * `{ ...DEFAULTS, ...patch }` straight over the user's real settings.json. One
 * switch toggle was enough to replace a configured export folder with `null`
 * and every rebound shortcut with its stock chord. The write after that rotated
 * the last good `.bak` away too, so the recovery copy the Rust side keeps for
 * exactly this case was gone as well.
 *
 * `get_settings` RESOLVING was the same trap wearing a friendlier face, and it
 * is why the guard below never actually fired. `read_json_with_bak` mapped BOTH
 * "there is no file yet" and "neither the file nor its .bak could be read" to
 * `Ok(None)`, and a Windows file lock — an antivirus scanner, a backup agent, a
 * roaming profile still syncing — makes `std::fs::read` fail on a settings.json
 * that is perfectly intact. Boot concluded "first run" about a file full of the
 * user's preferences, `initSettings` reported a cheerful `{ok:true,
 * source:"defaults"}`, main.ts showed no toast, and the re-read below found the
 * same `null` and treated it as permission to write.
 *
 * `ipc.readSettings` keeps the two apart (see `SettingsRead`), so the store can
 * carry an explicit answer to "is what I hold actually what is on disk?", and a
 * write is only allowed to be a blind overwrite when it is. When it is not, the
 * first write of the session RE-READS first:
 *
 *   ok         → they were there all along. Adopt them (which repairs the UI
 *       too) and merge the patch onto THEM, not onto defaults.
 *   absent     → the backend is sure there is nothing to restore, so there is
 *       nothing to lose. Write.
 *   unreadable → a settings.json IS there and we cannot see inside it. REFUSE,
 *       and let the caller say so, rather than overwrite it to find out. The
 *       session stays unverified, so the NEXT write asks again — the file may
 *       simply have been locked for a moment.
 *   the call itself rejects → we know nothing at all. Refuse if boot already
 *       failed or found an unreadable file; stay permissive if boot positively
 *       established there is nothing on disk, so a genuine first run with a
 *       flaky backend is not locked out of saving forever.
 *
 * That costs one extra IPC round trip, once, and only in a session whose boot
 * read came back empty or failed. Every session that read real settings — which
 * is every session of every user who has ever changed a setting — pays nothing:
 * `settingsVerified` is true from boot and never consulted again.
 */

/** What the user is told when settings.json is present but unreadable. Shared
 *  by the boot report and the refused write so both name the same condition. */
const SETTINGS_UNREADABLE =
  "settings.json is on disk but neither it nor its backup could be read — " +
  "another program may have it open.";

/** Whether `settingsStore` is known to match settings.json. False until a read
 *  (or a write) has proven it, which is what gates the re-read above. */
let settingsVerified = false;

/** The boot read's failure, kept so a screen mounted later can still report
 *  what start-up saw, and so a second failure can be told apart from a first. */
let settingsReadFailure: string | null = null;

/** How the one-time boot read of settings.json went.
 *
 *  `source` distinguishes the two SUCCESSFUL outcomes: "disk" means stored
 *  settings were read and applied, "defaults" means the backend positively
 *  established there is nothing to restore. A settings.json that exists but
 *  could not be read is NOT one of them — it is `{ok:false}`, so main.ts's
 *  toast fires and the user learns why the app looks factory-fresh.
 *
 *  `recovered` is true when settings.json itself was corrupt and the `.bak`
 *  supplied the settings instead. The preferences are intact and already
 *  applied — but the user's file was silently repaired underneath them, which is
 *  worth saying out loud rather than leaving to be discovered. Always false for
 *  "defaults": there was nothing to recover. */
export type SettingsLoad =
  | { ok: true; source: "disk" | "defaults"; recovered: boolean }
  | { ok: false; error: string };

/** The boot read's failure, or null when it went fine. For a caller that was
 *  not around when `initSettings` resolved (the Settings screen is mounted
 *  later, and this is precisely the screen a user visits when their
 *  preferences look wrong). */
export function settingsLoadFailure(): string | null {
  return settingsReadFailure;
}

/**
 * Read settings, paint the theme, and REPORT what happened.
 *
 * The result is returned rather than toasted here on purpose: this module is
 * core and has no business importing the toast UI. The caller (main.ts) owns
 * the reporting. The `console.error` is a floor, not the mechanism — a data
 * loss risk this quiet must not depend on a caller remembering to look.
 */
export async function initSettings(): Promise<SettingsLoad> {
  let result: SettingsLoad;
  settingsVerified = false;
  settingsReadFailure = null;
  try {
    const read = await ipc.readSettings();
    if (read.status === "ok") {
      settingsStore.set(sanitizeSettings(read.settings));
      settingsVerified = true;
      result = { ok: true, source: "disk", recovered: read.recovered };
    } else if (read.status === "unreadable") {
      // A file IS there. Running on defaults is a symptom, not the state of the
      // world — say so, and stay unverified so the first write re-reads.
      settingsReadFailure = SETTINGS_UNREADABLE;
      console.error("Could not read settings; running on defaults", SETTINGS_UNREADABLE);
      result = { ok: false, error: settingsReadFailure };
    } else {
      // Nothing on disk: a first run. Still left unverified so the first write
      // re-reads — the answer costs one round trip and it is the only thing
      // standing between a momentary lock and a wiped settings.json.
      result = { ok: true, source: "defaults", recovered: false };
    }
  } catch (e) {
    settingsReadFailure = describeError(e);
    console.error("Could not read settings; running on defaults", e);
    result = { ok: false, error: settingsReadFailure };
  }
  const s = settingsStore.get();
  applyTheme(s.theme, s.customTheme);
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    // Only "system" tracks the OS scheme; "custom" derives its own direction
    // from the chosen background, so an OS flip must not redraw (or re-derive)
    // anything for it.
    const cur = settingsStore.get();
    if (cur.theme === "system") applyTheme("system");
  });
  return result;
}

/**
 * Re-read settings.json before the first write of a session that never
 * confirmed one. Returns true when real settings were found and adopted.
 *
 * Throws whenever writing would be destructive AND we cannot see what we would
 * be destroying — a settings.json that is present but unreadable, or a read
 * that failed outright in a session whose boot read had already failed. A boot
 * that positively found NOTHING is left permissive: two independent "there is
 * nothing here" answers must not lock a genuine first run out of saving its
 * preferences forever.
 *
 * `settingsVerified` is deliberately NOT set on the refusing paths. Marking the
 * session verified would let the very next write go straight through without
 * asking again, which is the whole thing this exists to prevent; leaving it
 * false means a lock that clears in the next few seconds is picked up on the
 * next attempt.
 */
async function reconcileSettings(): Promise<boolean> {
  let read: SettingsRead;
  try {
    read = await ipc.readSettings();
  } catch (e) {
    if (settingsReadFailure !== null) {
      throw new Error(
        "Your settings file could not be read when the app started, and still can't be. " +
          "Saving now would replace it with defaults, so nothing was written. " +
          `The reason given was: ${describeError(e)}`,
      );
    }
    // Start-up already established there is nothing on disk to protect.
    settingsVerified = true;
    return false;
  }
  if (read.status === "unreadable") {
    // Recorded even when boot saw nothing: a file has appeared since, and a
    // Settings screen mounted later should be able to say so.
    settingsReadFailure = SETTINGS_UNREADABLE;
    throw new Error(
      "Your settings file is on disk but could not be read. Saving now would replace " +
        `it with defaults, so nothing was written. ${SETTINGS_UNREADABLE}`,
    );
  }
  settingsVerified = true;
  settingsReadFailure = null;
  if (read.status === "absent") return false;
  // `read.recovered` is deliberately not surfaced here: this is mid-write, with
  // no reporting channel, and the write that follows immediately rewrites the
  // primary from exactly these settings — which repairs the corrupt file rather
  // than merely noting it.
  settingsStore.set(sanitizeSettings(read.settings));
  return true;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  // Only ever true after a boot read that came back empty or failed, and only
  // for the first write of that session — see the block comment above. It is
  // also the one path on which the store is read AFTER an await rather than
  // synchronously, which is the price of not painting over the truth.
  const adopted = settingsVerified ? false : await reconcileSettings();
  const next = { ...settingsStore.get(), ...patch };
  settingsStore.set(next);
  // Either key can change the painted theme: switching TO custom, or editing
  // the colours while already on it. `adopted` forces a repaint as well — the
  // app has been showing the default theme since boot, and the settings we just
  // recovered may name a different one.
  if (adopted || patch.theme || patch.customTheme) applyTheme(next.theme, next.customTheme);
  await ipc.saveSettings(next);
  // The file is now ours: whatever was unreadable at boot has been replaced by
  // something we wrote, so later writes can go straight through.
  settingsVerified = true;
}

/* ---------------- project session ---------------- */

export type SaveState = "saved" | "dirty" | "saving" | "error";

/** A confirmation the owning view requires before this session is torn down by
 *  a navigation it did not initiate. Resolves true to proceed, false to cancel.
 *  Installed by the editor for a quick-view (temp) session — see
 *  `ProjectSession.leaveGuard`. */
export type LeaveGuard = () => Promise<boolean>;

const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * How many autosave ticks to wait before retrying after a failed write. Doubles
 * per consecutive failure and stops here.
 *
 * A failed write leaves `saveState` at "error", never at "dirty", so the
 * interval's dirty check alone meant NOTHING ever tried again: the project sat
 * unsaved, showing "Save failed", until the user made another edit or left the
 * editor. A cause that would have cleared on its own — an antivirus scan
 * holding the file, a network drive spinning up, a lock from a sync client —
 * never healed.
 *
 * Backed off rather than retried every tick because a retry is not free. Each
 * attempt re-stamps `modifiedAt` and pushes a new project object through the
 * store, which notifies every editor subscriber; against a destination that is
 * permanently gone (the folder was deleted, the drive was unplugged) an
 * every-tick retry is a re-render loop for as long as the editor stays open.
 * At the 3 s default this settles at roughly one attempt a minute.
 */
const SAVE_RETRY_MAX_TICKS = 16;

/** The open project: a reactive store, an undo history, and an autosaver. */
export class ProjectSession {
  readonly store: Store<ProjectFile>;
  readonly saveState = new Store<SaveState>("saved");
  readonly history = new History<ProjectFile>();
  readonly path: string;

  /** Optional keep-or-discard gate, set by the view that owns this session and
   *  scoped to its lifetime (the session reference is dropped on dispose, so
   *  there is nothing to unregister). `null` means "nothing to confirm". */
  leaveGuard: LeaveGuard | null = null;

  private debounceTimer: number | undefined;
  private intervalTimer: number | undefined;
  /** The write currently draining, or null when idle. A PROMISE rather than the
   *  old boolean, because a call that coalesces into it has to be able to WAIT
   *  for it — see `save()`. */
  private inFlight: Promise<void> | null = null;
  private pendingSave = false;
  private disposed = false;
  /** Consecutive failed writes, and the interval ticks left before the next
   *  retry. Both reset by any successful write. See SAVE_RETRY_MAX_TICKS. */
  private failedSaves = 0;
  private retryTicks = 0;

  constructor(path: string, initial: ProjectFile) {
    this.path = path;
    this.store = new Store(initial);
    const seconds = Math.max(1, settingsStore.get().autosaveSeconds);
    this.intervalTimer = window.setInterval(() => {
      const state = this.saveState.get();
      if (state === "dirty") {
        void this.save();
      } else if (state === "error" && this.retryTicks > 0 && --this.retryTicks === 0) {
        // The retry path. Gated on `retryTicks > 0` rather than on the countdown
        // alone so that "error" without a scheduled retry can never fall through
        // to an every-tick attempt.
        void this.save();
      }
    }, seconds * 1000);
  }

  get project(): ProjectFile {
    return this.store.get();
  }

  /** Apply a committed mutation: one undo step + autosave scheduling.
   *  Mutators must be pure; returning the same reference means "no change". */
  commit(mutate: (p: ProjectFile) => ProjectFile): void {
    const before = this.store.get();
    const after = mutate(before);
    if (after === before) return;
    this.history.push(before);
    this.store.set(after);
    this.markDirty();
  }

  /** Commit a history step for changes already applied via replace().
   *  Used by slider drags: live edits go through replace() (no history),
   *  then one history entry is pushed on release. `before` is the snapshot
   *  captured when the drag began. No-op if nothing actually changed. */
  commitFrom(before: ProjectFile): void {
    if (this.store.get() === before) return;
    this.history.push(before);
    this.markDirty();
  }

  /** Replace state without a history entry (e.g. media relink fixups). */
  replace(next: ProjectFile): void {
    if (next === this.store.get()) return;
    this.store.set(next);
    this.markDirty();
  }

  undo(): void {
    const prev = this.history.undo(this.store.get());
    if (prev) {
      this.store.set(prev);
      this.markDirty();
    }
  }

  redo(): void {
    const next = this.history.redo(this.store.get());
    if (next) {
      this.store.set(next);
      this.markDirty();
    }
  }

  private markDirty(): void {
    this.saveState.set("dirty");
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Serialize + write, coalescing concurrent calls.
   *
   * THE PROMISE MEANS "THE STATE AS OF THIS CALL IS ON DISK". That is why a
   * coalesced call returns the in-flight promise instead of resolving straight
   * away, and it is the whole fix for a real data loss:
   *
   *   edit → autosave starts → edit again while that write is in flight →
   *   leave the editor (Back, Ctrl+W, the Settings gear, an OS open-path)
   *
   * `dispose()` awaits `save()` and then sets `disposed`. When `save()`
   * resolved early — merely having recorded `pendingSave` — dispose marked the
   * session disposed BEFORE the follow-up write ran, and the follow-up then
   * short-circuited on `disposed` and never wrote. The second edit was silently
   * gone, and every exit from the editor goes through `dispose()`.
   */
  async save(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      // Don't start a second concurrent write to the same path: ask the running
      // drain for one more pass. That pass serializes whatever the store holds
      // by then, which includes this caller's edits — so waiting on it is
      // exactly waiting for them to land.
      this.pendingSave = true;
      return this.inFlight;
    }
    // Published BEFORE `drain()` is invoked, so a `save()` arriving during the
    // drain's first synchronous stretch coalesces instead of racing it. (Today
    // nothing in that stretch can re-enter — store notifications are
    // microtask-batched — but the ordering is free and the alternative is a
    // second writer to the same file if that ever stops being true.)
    let settle!: () => void;
    this.inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      await this.drain();
    } finally {
      this.inFlight = null;
      settle();
    }
  }

  /** One write, then another for as long as edits kept arriving while the last
   *  was in flight. Never throws: a failure is reported through `saveState` and
   *  retried by the autosave interval. */
  private async drain(): Promise<void> {
    do {
      this.pendingSave = false;
      this.saveState.set("saving");
      try {
        const stamped = touchModified(this.store.get());
        this.store.set(stamped);
        await ipc.saveProject(this.path, stamped);
        this.failedSaves = 0;
        this.retryTicks = 0;
        // An edit made DURING the write already set "dirty"; don't paint over it.
        if (this.saveState.get() === "saving") this.saveState.set("saved");
      } catch {
        this.failedSaves++;
        this.retryTicks = Math.min(2 ** (this.failedSaves - 1), SAVE_RETRY_MAX_TICKS);
        this.saveState.set("error");
      }
      // `discard()` can land mid-write — the quick-view "Discard" gesture
      // deletes the temp file immediately afterwards — so stop rather than
      // resurrect it with a follow-up.
    } while (this.pendingSave && !this.disposed);
  }

  /** Flush and stop timers (called when leaving the editor). */
  async dispose(): Promise<void> {
    window.clearTimeout(this.debounceTimer);
    window.clearInterval(this.intervalTimer);
    // `save()` now resolves only once the state at the time of this call has
    // actually been written, coalesced follow-up included, so `disposed` is set
    // after the last byte is out rather than while a write is still owed.
    if (!this.disposed && this.saveState.get() !== "saved") {
      await this.save();
    }
    this.disposed = true;
  }

  /** Abandon this session WITHOUT flushing: cancel timers and mark disposed so
   *  any in-flight or scheduled autosave becomes a no-op. Used by the quick-view
   *  "Discard" gesture, where the temp file is deleted right after — a dispose
   *  flush (which targets that temp path) would otherwise resurrect it. Setting
   *  `disposed` makes save() short-circuit, so the later dispose() also skips
   *  its flush. Idempotent. */
  discard(): void {
    window.clearTimeout(this.debounceTimer);
    window.clearInterval(this.intervalTimer);
    this.disposed = true;
  }
}

/** The currently open session (null on the home screen). */
export const currentSession = new Store<ProjectSession | null>(null);

/** Ask the open session (if any) to confirm being replaced by a navigation it
 *  did not initiate — today that is only the OS open-path route in main.ts,
 *  which otherwise walks straight past the quick-view keep/discard prompt and
 *  lets a temporary project be flushed to a path that startup cleanup deletes.
 *  Resolves true when there is nothing to confirm. */
export async function confirmLeaveCurrentSession(): Promise<boolean> {
  const guard = currentSession.get()?.leaveGuard;
  return guard ? await guard() : true;
}
