// Settings screen: a full-window route (like home) for appearance, autosave,
// export defaults, where files opened from Explorer land, performance, cache,
// and rebindable keyboard shortcuts.
// Everything persists immediately via updateSettings and reflects settingsStore
// live. The screen fully re-renders on store changes EXCEPT during shortcut
// capture and while a colour picker is open — both of those mutate the single
// row they own in place instead, because a rebuild would drop the element the
// interaction is anchored to.
//
// NOTHING HERE PAINTS FROM AN INLINE `style` ATTRIBUTE. The packaged app's CSP
// refuses them — read the block comment above `colorRow` before adding one, in
// this file or in any other screen. It is not a style preference; the attribute
// does not arrive.

import "./settings.css";
import { escapeHtml, formatBytes } from "../core/format";
import { appVersion, describeError, errorDetail, ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import {
  currentSession,
  normalizeHexColor,
  previewCustomTheme,
  settingsStore,
  updateSettings,
} from "../core/session";
import { chordOf, conflictingActions, findConflicts, normalizeChord } from "../core/shortcuts";
import type { ShortcutConflict } from "../core/shortcuts";
import type { ActionId, CustomTheme, OpenWith, Settings, ShortcutMode } from "../core/types";
import { DEFAULT_CUSTOM_THEME, DEFAULT_SHORTCUTS } from "../core/types";
import type { ColorPickerHandle } from "../ui/color-picker";
import {
  copyText,
  formatRecentErrors,
  openErrorDialog,
  recentErrors,
  recordError,
} from "../ui/errors";
import { focusFirst, trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

/** Human-readable label for every rebindable action. */
export const ACTION_LABELS: Record<ActionId, string> = {
  playPause: "Play / Pause",
  stop: "Stop",
  stepFwd: "Next frame",
  stepBack: "Previous frame",
  jumpFwd: "Jump forward 1s",
  jumpBack: "Jump back 1s",
  goStart: "Go to start",
  goEnd: "Go to end",
  split: "Split clip",
  delete: "Delete",
  rippleDelete: "Ripple delete",
  undo: "Undo",
  redo: "Redo",
  save: "Save",
  copy: "Copy",
  paste: "Paste",
  toggleSnap: "Toggle snapping",
  toggleLoop: "Toggle loop",
  addMarker: "Add marker",
  export: "Export",
  // One action, two screens: the editor closes the project, the viewer goes back.
  goHome: "Back / close",
  fullscreen: "Fullscreen playback",
  redoAlt: "Redo (alternate)",
  prevFile: "Previous file (viewer)",
  nextFile: "Next file (viewer)",
  seekBack: "Back 5s (viewer)",
  seekFwd: "Forward 5s (viewer)",
  imgSelect: "Select / move (image)",
  imgPen: "Pen (image)",
  imgPencil: "Pencil (image)",
  imgMarker: "Marker (image)",
  imgEraser: "Eraser (image)",
  imgShape: "Shapes (image)",
  imgRuler: "Show or hide ruler (image)",
  imgSizeDown: "Smaller brush (image)",
  imgSizeUp: "Larger brush (image)",
  imgZoomIn: "Zoom in (image)",
  imgZoomOut: "Zoom out (image)",
  imgZoomFit: "Fit to window (image)",
  imgZoom100: "Actual size (image)",
  imgPanHold: "Hold to pan (image)",
};

/** The screens that have a ShortcutManager. The conflict warning names a mode,
 *  so a mode joins this list only together with the screen that binds it —
 *  "Ctrl+Z (image)" must never point at a screen the user cannot open. The
 *  image editor mounts `new ShortcutManager("image")`, so image clashes are
 *  real and shown. */
export const LIVE_MODES: readonly ShortcutMode[] = ["editor", "viewer", "image"];

/** `findConflicts` restricted to LIVE_MODES — the one result the Shortcuts card
 *  reads for both its row marks and its warning. */
export function liveConflicts(shortcuts: Record<string, string>): ShortcutConflict[] {
  return findConflicts(shortcuts).filter((c) => LIVE_MODES.includes(c.mode));
}

/** Action row order — mirrors the ActionId union for a predictable list. */
export const ACTION_ORDER: ActionId[] = [
  "playPause",
  "stop",
  "stepFwd",
  "stepBack",
  "jumpFwd",
  "jumpBack",
  "goStart",
  "goEnd",
  "fullscreen",
  "split",
  "delete",
  "rippleDelete",
  "undo",
  "redo",
  "redoAlt",
  "save",
  "copy",
  "paste",
  "toggleSnap",
  "toggleLoop",
  "addMarker",
  "export",
  "goHome",
  "prevFile",
  "nextFile",
  "seekBack",
  "seekFwd",
  "imgSelect",
  "imgPen",
  "imgPencil",
  "imgMarker",
  "imgEraser",
  "imgShape",
  "imgRuler",
  "imgSizeDown",
  "imgSizeUp",
  "imgZoomIn",
  "imgZoomOut",
  "imgZoomFit",
  "imgZoom100",
  "imgPanHold",
];

/** The three user-settable colours of the custom theme, in the order they are
 *  offered: what the app sits on, what it highlights with, what it says. */
type ColorRole = "background" | "accent" | "text";
const ROLE_LABELS: Record<ColorRole, string> = {
  background: "Background",
  accent: "Accent",
  text: "Text",
};
const ROLE_HINTS: Record<ColorRole, string> = {
  background: "The app background. Panels, inputs, borders and the ruler follow it.",
  accent: "Buttons, selection, focus rings, clips and waveforms.",
  text: "Every label, value and caption in the app.",
};

/** Swatches worth offering per role. The picker's own default spread is a set
 *  of accent hues, which is exactly wrong for the other two: a background wants
 *  near-blacks and papers, and text wants inks. Both lists carry the shipped
 *  dark and light values first, so the two built-in themes are one click away.
 *  Twelve each, matching the row the popover lays out. */
const ROLE_PRESETS: Record<ColorRole, readonly string[] | undefined> = {
  background: [
    "#111113", "#000000", "#0d1117", "#171214", "#101a16", "#1a1524",
    "#f6f6f8", "#ffffff", "#f4f1ea", "#eef3f8", "#f7eef2", "#edf4ee",
  ],
  accent: undefined, // the picker's own hue spread is already the right shelf
  text: [
    "#ececf1", "#ffffff", "#e6e0d4", "#dde6f2", "#f0e2e8", "#c8c8d2",
    "#1b1b20", "#000000", "#2a2118", "#16202c", "#2c1c24", "#55555f",
  ],
};

/* ---------------- why no `style="…"` anywhere on this screen ----------------
 *
 * READ THIS BEFORE PUTTING A COLOUR BACK INTO THE MARKUP.
 *
 * An inline `style` ATTRIBUTE does not survive into the packaged app. It is
 * dropped, silently, with the element left exactly as its stylesheet rules
 * leave it — which for the colour swatch is an empty 16x16 box.
 *
 * The chain, all of it Tauri's, none of it visible from this repo:
 *
 *   1. `index.html` carries a `<style>` block (the critical dark first paint).
 *   2. At build time tauri-codegen's `inject_nonce_token` stamps every `<style>`
 *      in the bundled HTML with `nonce="__TAURI_STYLE_NONCE__"`.
 *   3. At serve time `replace_csp_nonce` swaps that token for a random value AND
 *      APPENDS `'nonce-<random>'` to the `style-src` directive of the CSP we
 *      configured in `src-tauri/tauri.conf.json`.
 *   4. CSP Level 3: once a directive names a nonce-source or a hash-source,
 *      `'unsafe-inline'` in that same directive IS IGNORED. So the shipped
 *      `style-src 'self' 'unsafe-inline' 'nonce-…'` is strictly a nonce policy.
 *   5. A `style` attribute cannot carry a nonce, and matching one by hash needs
 *      `'unsafe-hashes'`, which is not (and should not be) in the policy.
 *      Result: every inline style attribute in the app is refused.
 *
 * The CSSOM is NOT gated by any of that. `el.style.background = value` and
 * `el.style.setProperty(…)` always apply. That is why the app is themed
 * correctly (`applyTheme` writes twenty-one custom properties this way), why the
 * colour picker's own swatch and presets are right, and why `paintColorButton`
 * below works — while the same colour written into the markup does not.
 *
 * THAT ASYMMETRY IS WHAT MADE THIS BUG SO CONFUSING. The swatch and its hex
 * caption were interpolated from one value in one template, so an empty swatch
 * beside a correct caption looked impossible — a paint bug, or a save bug, but
 * surely not a data bug. And it hid: pick a colour and `paintColorButton`
 * repainted the swatch through the CSSOM, so the screen looked right for as long
 * as you stayed on it. Leave and come back and the row was rebuilt from the
 * markup, with nothing to paint it, and the fill was gone.
 *
 * It also cannot be caught by running the app. `npm run dev` loads the frontend
 * from Vite's dev server, which Tauri never rewrites — no `<style>` nonce, no
 * neutralised `'unsafe-inline'`, inline styles all fine. The in-app E2E runs
 * there too. This exists only in a packaged build.
 *
 * SO: nothing on this screen paints from a `style` attribute. A colour reaches a
 * swatch through `paintColorButton`, which `render` calls for all three rows
 * right after the markup lands.
 *
 * AND NOT VIA `var(--accent)` / `var(--text-1)` IN settings.css, which is the
 * obvious CSS-only alternative — those tokens ARE the user's literal picks, but
 * `html[data-rescue-appearance] .settings__card--appearance` re-points both of
 * them at the fixed `--safe-*` palette INSIDE this card. The swatches would then
 * show the escape hatch's colours instead of the user's, which is precisely the
 * one thing the escape hatch is documented never to do. Per-element, from the
 * store, is the only source that stays true.
 */

/**
 * One colour row: a label, a hint, and a button whose swatch and caption are the
 * current colour.
 *
 * The swatch span is emitted EMPTY and UNSTYLED on purpose — see the block
 * above. Its fill is applied by `paintColorButton` immediately after this
 * markup is written, in the same synchronous turn, so there is never a frame in
 * which an unfilled swatch is on screen.
 *
 * `hex` still lands in the caption and the accessible name, where it is text
 * rather than CSS and nothing can refuse it. It is interpolated directly because
 * `normalizeHexColor` has already proven it is exactly `#rrggbb` — see the note
 * on that function in core/session.ts.
 *
 * Module scope rather than a closure inside `mountSettings`, and exported, for
 * the reason `deriveCustomTheme` is: it is pure, and the one invariant that
 * broke here — no colour in the markup — is then assertable without a DOM.
 */
export function colorRow(role: ColorRole, hex: string): string {
  const label = ROLE_LABELS[role];
  return `
      <div class="settings__row">
        <div class="settings__row-text">
          <div class="settings__row-label">${escapeHtml(label)}</div>
          <div class="settings__hint">${escapeHtml(ROLE_HINTS[role])}</div>
        </div>
        <button class="btn btn--sm settings__color-btn" id="settings-color-${role}"
                aria-label="${escapeHtml(label)}, ${hex}" aria-haspopup="dialog">
          <span class="settings__color-swatch"></span>
          <span class="mono">${hex}</span>
        </button>
      </div>`;
}

/** What each "Opening files" choice does, shown under the control for the one
 *  that is on. Both say plainly that nothing lands in the library on its own:
 *  the viewer makes no project at all, and the editor's is temporary until the
 *  user keeps it. */
const OPEN_WITH_HINTS: Record<OpenWith, string> = {
  viewer: "Shows the file on its own. Use the arrows to move through its folder.",
  editor:
    "Opens a temporary project with the file in it: a picture as an image project, anything else on a timeline. Keep it any time; leaving asks only if you changed it.",
};

const AUTOSAVE_OPTIONS = [1, 3, 5, 10, 30];
const CACHE_LIMIT_OPTIONS_MB = [1024, 2048, 5120, 10240, 20480];
const CACHE_KIND_ORDER = ["remux", "proxy", "waveform", "thumbs", "filmstrip"];

type CacheStats = { totalBytes: number; byKind: Record<string, number> };

/** The cache-limit wording. The list's own values say "2 GB" for 2048 MB, so an
 *  off-list value is put in the same binary units — `formatBytes` counts in
 *  thousands and would call 3000 MB "3.1 GB", more than the 2.9 it is here. */
export function cacheLimitLabel(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  return `${Number((mb / 1024).toFixed(1))} GB`;
}

/**
 * A numeric `<select>` that always shows the value actually in effect.
 *
 * `sanitizeSettings` accepts any value in a range (autosave 1-3600 s, cache
 * 1 MB-1 TB), but the list offers five. A hand-edited or older settings.json
 * holding 7 s or 3000 MB used to render with nothing marked `selected`, so the
 * browser showed the FIRST option — "1s", "1 GB" — while the app went on using
 * the real value. The screen lied, and re-picking the shown option to "keep" it
 * silently changed the setting. An off-list value now gets its own option, in
 * numeric order, and nothing is written back: the file keeps what it says.
 */
export function selectHtml(
  id: string,
  value: number,
  options: readonly number[],
  labelOf: (v: number) => string,
): string {
  const values =
    options.includes(value) || !Number.isFinite(value)
      ? [...options]
      : [...options, value].sort((a, b) => a - b);
  return `<select class="select select--sm" id="${id}">${values
    .map(
      (v) =>
        `<option value="${v}" ${v === value ? "selected" : ""}>${escapeHtml(labelOf(v))}</option>`,
    )
    .join("")}</select>`;
}

/** True when every action is bound exactly as shipped. Compared chord by chord
 *  through `normalizeChord`, so a hand-written "ctrl+z" counts as the default
 *  "Ctrl+Z" (the same key does the same thing), while an action the loader
 *  emptied because its default chord was taken does not. */
export function shortcutsAtDefaults(shortcuts: Record<string, string>): boolean {
  return ACTION_ORDER.every(
    (a) => normalizeChord(shortcuts[a] ?? "") === normalizeChord(DEFAULT_SHORTCUTS[a]),
  );
}

/**
 * The look of a two-step confirm while it waits for its second click: the
 * accent fill, so it is plainly not the button it was a moment ago. NOT
 * `btn--danger` — that red is reserved for permanently deleting a real library
 * item, and neither of these does: the cache regenerates, and shortcuts can be
 * bound again.
 */
const ARMED_CLASS = "btn--primary";

export function clearCacheButton(armed: boolean): string {
  return `<button class="btn btn--sm ${armed ? ARMED_CLASS : ""}" id="settings-clear-cache">${armed ? "Really clear?" : "Clear cache"}</button>`;
}

/** Disabled while the shortcuts already are the defaults: there is nothing to
 *  reset, and a "Really reset?" that changes nothing would only teach the user
 *  to click straight through it. */
export function resetShortcutsButton(armed: boolean, atDefaults: boolean): string {
  const on = armed && !atDefaults;
  return `<button class="btn btn--sm ${on ? ARMED_CLASS : "btn--ghost"}" id="settings-reset-shortcuts" ${atDefaults ? "disabled" : ""}>${on ? "Really reset?" : "Reset to defaults"}</button>`;
}

/** What to tell the user when the Uninstall button finds no uninstaller to run:
 *  a portable copy (or a dev build) has no `uninstall.exe` beside it, and
 *  `uninstall_app` then says exactly "not installed" with code `bad_input`.
 *  Matched on BOTH, because the same code also carries a real failure
 *  ("uninstall task failed: …"), which must stay an error. Null means a genuine
 *  failure. */
export function uninstallRefusal(e: unknown): string | null {
  const { code, message } = errorDetail(e);
  if (code === "bad_input" && message === "not installed") {
    return "This is a portable copy. To remove it, delete its folder.";
  }
  return null;
}

/* ---------------- keeping keyboard focus across a re-render ----------------
 *
 * The screen rebuilds its markup on every settings change, every two-step
 * confirm arm and disarm, every shortcut capture and when the cache figure
 * lands. Rebuilding destroys the focused node, so focus fell to <body>: the
 * next Tab started again at the theme buttons, and "Really clear?" was out of a
 * keyboard user's reach — Enter on Clear cache re-rendered the button out from
 * under them. A render now notes WHICH control had focus (by id, or by the data
 * attribute a repeated control carries) and seats focus on its successor. Keys
 * are matched by comparing attribute values, never by building a selector from
 * them, so no value ever needs escaping. */

type FocusKey = { id: string } | { attr: string; value: string };

/** The data attributes that name a control without an id: the theme and
 *  opening-files choices, and the shortcut rows. */
const FOCUS_ATTRS = ["data-theme-opt", "data-openwith-opt", "data-action"] as const;

/** Where focus goes when the control it was on is gone or disabled after the
 *  render. Each of these takes itself out of reach by being used. */
const FOCUS_FALLBACK: Record<string, FocusKey> = {
  // "Clear" empties the folder, which disables it.
  "settings-clear-dir": { id: "settings-choose-dir" },
  // The confirming "Really reset?" restores the defaults, which disables it.
  "settings-reset-shortcuts": { attr: "data-action", value: ACTION_ORDER[0]! },
  // The cache error's Details button goes away once usage reads cleanly.
  "settings-cache-error": { id: "settings-cache-limit" },
};

function focusKeyOf(el: Element): FocusKey | null {
  if (el.id) return { id: el.id };
  for (const attr of FOCUS_ATTRS) {
    const value = el.getAttribute(attr);
    if (value !== null) return { attr, value };
  }
  return null;
}

function findByKey(container: HTMLElement, key: FocusKey): HTMLElement | null {
  const attr = "id" in key ? "id" : key.attr;
  const value = "id" in key ? key.id : key.value;
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    if (el.getAttribute(attr) === value) return el;
  }
  return null;
}

function reachable(el: HTMLElement | null): el is HTMLElement {
  return !!el && !(el as HTMLButtonElement).disabled;
}

/** Seat focus on the control `key` names inside `container`, or on its fallback
 *  when that one is gone or disabled. Never scrolls: the control is where the
 *  user just was. */
function restoreFocus(container: HTMLElement, key: FocusKey): void {
  let target = findByKey(container, key);
  if (!reachable(target) && "id" in key) {
    const fallback = FOCUS_FALLBACK[key.id];
    if (fallback) target = findByKey(container, fallback);
  }
  if (reachable(target)) target.focus({ preventScroll: true });
}

/**
 * Write a settings change, and SAY SO if the write fails.
 *
 * Every one of these used to be a bare `void updateSettings(...)`. That paints
 * the new value immediately (the store and `applyTheme` are updated before the
 * IPC is awaited), so a rejected write left the app looking exactly as though it
 * had saved — until the next launch, when everything silently reverted. There
 * was no toast, no console error, nothing: `void` on a rejecting promise is an
 * unhandled rejection and nothing in this app listens for those.
 *
 * The optimistic paint is deliberate and stays — the alternative is a settings
 * screen that lags every toggle by a disk round trip. What was missing is the
 * failure being visible when the optimism turns out to be wrong.
 */
function persist(patch: Partial<Settings>): void {
  void updateSettings(patch).catch((e: unknown) => {
    toast.error("Couldn't save your settings.", {
      detail: describeError(e),
      op: "Settings",
      title: "Save",
    });
  });
}

/**
 * Set the cache limit. A LOWER limit also trims the cache to it now: trims
 * otherwise run only when some job finishes, so the cache stayed over the
 * new cap until then. Nothing is kept — Settings replaced whatever screen was
 * using the cache, so nothing on screen is reading from it. Returns the trim
 * (to repaint the usage figure once it lands), or null when none was needed.
 */
export function changeCacheLimit(next: number): Promise<void> | null {
  // Read before persist(): it updates the store at once.
  const prev = settingsStore.get().cacheLimitMB;
  persist({ cacheLimitMB: next });
  if (!(next < prev)) return null;
  return ipc.enforceCacheLimit(next, []).then(
    () => {},
    () => {},
  );
}

export function mountSettings(root: HTMLElement): { dispose(): void } {
  root.innerHTML = `
    <div class="settings">
      <header class="settings__header">
        <button class="btn btn--icon btn--ghost" id="settings-back" title="Back to home">${icon("chevronLeft")}</button>
        <div class="settings__title">Settings</div>
      </header>
      <main class="settings__main">
        <div class="settings__inner" id="settings-inner"></div>
      </main>
    </div>
  `;

  const inner = root.querySelector<HTMLElement>("#settings-inner")!;
  root
    .querySelector<HTMLButtonElement>("#settings-back")!
    .addEventListener("click", () => navigate({ view: "home" }));

  let cacheStats: CacheStats | null = null;
  /** null = fine; a string = the reason, kept so the user can read it instead
   *  of only being told "something went wrong". */
  let cacheStatsError: string | null = null;
  // Two-step "Clear cache" confirm and shortcut-capture state live outside the
  // render so we can suppress full re-renders while capturing.
  let clearConfirmTimer: number | undefined;
  let clearConfirmArmed = false;
  // "Reset to defaults" is the same two-step confirm: one click used to wipe
  // every custom shortcut at once, with nothing to undo it.
  let resetConfirmTimer: number | undefined;
  let resetConfirmArmed = false;
  /** True while a system report is being built and written. The button is
   *  rendered disabled from this, not just disabled in place, because any
   *  re-render while the ffmpeg probe runs (the cache figure landing, a settings
   *  change) would otherwise hand back an enabled button mid-save. */
  let savingReport = false;
  /** The Uninstall confirm is up: a second one must never stack on it. */
  let uninstallOpen = false;
  /** Uninstall was confirmed and the backend has not answered: on success the
   *  app exits (~300 ms after uninstall.exe starts, plus the cache flush), so
   *  until then the dialog cannot be left and no second one can open — either
   *  would let a second Confirm start a second uninstaller. Cleared only by a
   *  failure. */
  let uninstalling = false;
  let capturing: ActionId | null = null;
  let captureCleanup: (() => void) | null = null;
  // An open colour picker is anchored to a button inside `inner`, so a full
  // re-render would tear its anchor out from under it — suppressed exactly the
  // way shortcut capture already is.
  let picker: ColorPickerHandle | null = null;
  /** Guards the dynamic import against a double click landing two pickers. */
  let pickerLoading = false;
  // Set by dispose(): in-flight async work must not rebuild a detached DOM.
  let disposed = false;
  /* Closers for everything this screen has parked on document.body.
   *
   * A modal backdrop has to be appended to the body to sit above everything,
   * but the router tears a screen down by calling dispose() and then clearing
   * the app root — neither of which touches the body. An open dialog therefore
   * outlives the screen that opened it: still visible, still holding the focus
   * trap, still wired to this screen's handlers. Here that is the Uninstall
   * confirm, left floating over the editor after an OS "open with" navigates
   * away underneath it. Teardown closes whatever is registered. */
  const openOverlays = new Set<() => void>();

  function closeOverlays(): void {
    // Each close() removes itself from the set, so iterate a copy.
    for (const close of [...openOverlays]) close();
    openOverlays.clear();
  }

  /** `openErrorDialog`, tied to this screen's lifetime.
   *
   *  The dialog parks its backdrop on `document.body`, which the router never
   *  clears, so an unregistered one survives teardown holding the focus trap —
   *  the same shape as the confirm modals above, and reachable from all three
   *  of this screen's error panes. `openErrorDialog`'s `close` is idempotent, so
   *  a dialog the user already dismissed simply no-ops at teardown; that is why
   *  the closer can stay registered rather than needing a dismissal callback.
   *
   *  The `disposed` check matters for the async caller: `copySystemReport`
   *  awaits an ffmpeg probe before falling back to a dialog, and that can land
   *  after the screen is gone. */
  function showError(opts: Parameters<typeof openErrorDialog>[0]): void {
    if (disposed) return;
    openOverlays.add(openErrorDialog(opts));
  }
  /** Resolved once on mount; empty until then so the first paint isn't blocked. */
  let appVer = "";

  /* ---------------- section builders ---------------- */

  function segmented(
    active: string,
    options: { value: string; label: string }[],
    attr: string,
  ): string {
    // `btn--on` paints the choice; `aria-pressed` says it to a screen reader,
    // which reads a class as nothing. Keep both: the custom-theme E2E reads the
    // class.
    return `<div class="settings__segmented">${options
      .map((o) => {
        const on = o.value === active;
        return `<button class="btn btn--sm ${on ? "btn--on" : ""}" aria-pressed="${on}" ${attr}="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`;
      })
      .join("")}</div>`;
  }

  function switchRow(id: string, label: string, on: boolean, hint?: string): string {
    return `
      <div class="settings__row">
        <div class="settings__row-text">
          <div class="settings__row-label">${escapeHtml(label)}</div>
          ${hint ? `<div class="settings__hint">${escapeHtml(hint)}</div>` : ""}
        </div>
        <input type="checkbox" class="switch" id="${id}" ${on ? "checked" : ""} />
      </div>`;
  }

  /** The area the "Custom" option expands into. Rendered only for that option,
   *  so every other theme costs exactly what it did before. Each pick is shown
   *  exactly as chosen — nothing here is second-guessed. */
  function customThemeArea(c: CustomTheme): string {
    const safe = validCustomTheme(c);
    return `
      <div class="settings__custom">
        ${colorRow("background", safe.background)}
        ${colorRow("accent", safe.accent)}
        ${colorRow("text", safe.text)}
      </div>`;
  }

  // `settings__card--appearance` is not just a layout hook: it is the escape
  // hatch's selector. That card (and the colour picker it opens) renders in a
  // fixed palette instead of the user's colours, so a theme that hides
  // everything can still be undone — see SAFE_APPEARANCE in core/session.ts and
  // the matching block in settings.css. Do not drop the class.
  function appearanceSection(s: Settings): string {
    const seg = segmented(
      s.theme,
      [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "system", label: "System" },
        { value: "custom", label: "Custom" },
      ],
      "data-theme-opt",
    );
    return `
      <section class="card settings__card settings__card--appearance">
        <div class="settings__section-head">Appearance</div>
        <div class="settings__row">
          <div class="settings__row-label">Theme</div>
          ${seg}
        </div>
        ${s.theme === "custom" ? customThemeArea(s.customTheme) : ""}
      </section>`;
  }

  function autosaveSection(s: Settings): string {
    const sel = selectHtml("settings-autosave", s.autosaveSeconds, AUTOSAVE_OPTIONS, (n) => `${n}s`);
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Autosave</div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Interval</div>
            <div class="settings__hint">How often changes are written to disk.</div>
          </div>
          ${sel}
        </div>
      </section>`;
  }

  function exportSection(s: Settings): string {
    const dir = s.defaultExportDir;
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Export</div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Default export folder</div>
            <div class="settings__path ${dir ? "" : "settings__path--empty"}" title="${dir ? escapeHtml(dir) : ""}">${dir ? escapeHtml(dir) : "Not set"}</div>
          </div>
          <div class="settings__row-actions">
            <button class="btn btn--sm" id="settings-choose-dir">Choose</button>
            <button class="btn btn--sm btn--ghost" id="settings-clear-dir" ${dir ? "" : "disabled"}>Clear</button>
          </div>
        </div>
      </section>`;
  }

  // Its own card rather than a row under Performance: where a file lands is a
  // choice about behaviour, not speed. The hint follows the selection, so the
  // screen says what the current choice does rather than what one of them does.
  function openingSection(s: Settings): string {
    const seg = segmented(
      s.openWith,
      [
        { value: "viewer", label: "Viewer" },
        { value: "editor", label: "Editor" },
      ],
      "data-openwith-opt",
    );
    return `
      <section class="card settings__card settings__card--opening">
        <div class="settings__section-head">Opening files</div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Open files from File Explorer in</div>
            <div class="settings__hint">${escapeHtml(OPEN_WITH_HINTS[s.openWith === "editor" ? "editor" : "viewer"])}</div>
          </div>
          ${seg}
        </div>
      </section>`;
  }

  function performanceSection(s: Settings): string {
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Performance</div>
        ${switchRow("settings-hwaccel", "Hardware acceleration", s.hardwareAccel)}
        ${switchRow(
          "settings-proxy",
          "Proxy media",
          s.proxyMedia,
          // "while editing": the viewer plays 4K directly and never proxies, so
          // an unqualified hint would promise something this switch does not do.
          "Use lighter preview copies for heavy or 4K files while editing",
        )}
        ${switchRow(
          "settings-snap-center",
          "Snap to center guides",
          s.snapCenterGuides,
          "Dragged clips snap to the canvas center",
        )}
      </section>`;
  }

  function cacheSection(s: Settings): string {
    let usageHtml: string;
    if (cacheStatsError !== null) {
      usageHtml = `
        <div class="settings__hint">Couldn't read cache usage.</div>
        <div class="err-pane__actions"><button class="btn btn--sm btn--ghost" id="settings-cache-error">Details</button></div>`;
    } else if (!cacheStats) {
      usageHtml = `<div class="settings__hint">Reading cache usage</div>`;
    } else {
      const parts = CACHE_KIND_ORDER.map(
        (k) => `${k} ${formatBytes(cacheStats!.byKind[k] ?? 0)}`,
      ).join(" · ");
      usageHtml = `
        <div class="settings__cache-total">${formatBytes(cacheStats.totalBytes)} used</div>
        <div class="settings__hint settings__cache-breakdown">${escapeHtml(parts)}</div>`;
    }
    const sel = selectHtml("settings-cache-limit", s.cacheLimitMB, CACHE_LIMIT_OPTIONS_MB, cacheLimitLabel);
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Cache</div>
        <div class="settings__row settings__row--stack">
          <div class="settings__row-text">${usageHtml}</div>
        </div>
        <div class="settings__row">
          <div class="settings__row-label">Cache size limit</div>
          ${sel}
        </div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Clear cache</div>
            <div class="settings__hint">Remove generated previews, waveforms and thumbnails. Originals are never touched.</div>
          </div>
          ${clearCacheButton(clearConfirmArmed)}
        </div>
      </section>`;
  }

  function shortcutsSection(s: Settings): string {
    // Computed ONCE and read by both the row marks and the warning, so the two
    // can never disagree about what a conflict is. Marked per ACTION, not per
    // chord: the editor's ArrowRight and the viewer's ArrowRight share a chord
    // and are not a conflict, so "is this chord in a conflict" would paint rows
    // that are fine.
    const conflicts = liveConflicts(s.shortcuts);
    const marked = conflictingActions(conflicts);
    const rows = ACTION_ORDER.map((action) => {
      const chord = normalizeChord(s.shortcuts[action] ?? "");
      const isConflict = marked.has(action);
      const isCapturing = capturing === action;
      let valueHtml: string;
      if (isCapturing) {
        valueHtml = `<span class="settings__capturing">Press a key combination (Esc cancels)</span>`;
      } else if (chord) {
        valueHtml = chord
          .split("+")
          .map((k) => `<kbd class="settings__kbd">${escapeHtml(k)}</kbd>`)
          .join('<span class="settings__kbd-sep">+</span>');
      } else {
        valueHtml = `<span class="settings__hint">Not set</span>`;
      }
      return `
        <div class="settings__shortcut ${isConflict ? "settings__shortcut--conflict" : ""} ${isCapturing ? "settings__shortcut--capturing" : ""}" data-action="${action}" role="button" tabindex="0">
          <span class="settings__shortcut-label">${escapeHtml(ACTION_LABELS[action])}</span>
          <span class="settings__shortcut-chord">${valueHtml}</span>
        </div>`;
    }).join("");

    // "ArrowRight (viewer)": the mode is what tells the user where the clash
    // bites, since the same chord may be fine on the other screen.
    const warning =
      conflicts.length > 0
        ? `<div class="settings__conflict-warn">${icon("warning", 14)}<span>Duplicate shortcuts: ${escapeHtml(conflicts.map((c) => `${c.chord} (${c.mode})`).join(", "))}</span></div>`
        : "";

    return `
      <section class="card settings__card">
        <div class="settings__section-head settings__section-head--row">
          <span>Keyboard shortcuts</span>
          ${resetShortcutsButton(resetConfirmArmed, shortcutsAtDefaults(s.shortcuts))}
        </div>
        ${warning}
        <div class="settings__shortcuts">${rows}</div>
      </section>`;
  }

  function diagnosticsSection(): string {
    const n = recentErrors().length;
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Diagnostics</div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Recent errors</div>
            <div class="settings__hint">${n === 0 ? "Nothing has failed this session." : `${n} this session. Kept in memory only, never written to disk.`}</div>
          </div>
          <button class="btn btn--sm" id="settings-view-errors" ${n === 0 ? "disabled" : ""}>View</button>
        </div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">System report</div>
            <div class="settings__hint">App version, detected encoders and your settings, with file names and personal details removed. Nothing is sent anywhere — you choose where it goes.</div>
          </div>
          <div class="settings__row-actions">
            <button class="btn btn--sm" id="settings-copy-report">Copy details</button>
            <button class="btn btn--sm" id="settings-save-report" ${savingReport ? "disabled" : ""}>Save report</button>
          </div>
        </div>
      </section>`;
  }

  // Sits between Diagnostics and Uninstall on purpose: the version is the first
  // line of any bug report, so it belongs next to the report buttons — and the
  // destructive card stays last. Deliberately app version only: the FFmpeg
  // version would mean calling detectEncoders, which on a cold cache runs real
  // test encodes and would stall this screen on open.
  function aboutSection(): string {
    return `
      <section class="card settings__card">
        <div class="settings__section-head">About</div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Version</div>
            <div class="settings__hint">Free and open source. Taroting works entirely offline and makes no network calls.</div>
          </div>
          <div class="settings__version">${appVer ? escapeHtml(`Taroting ${appVer}`) : "Taroting"}</div>
        </div>
      </section>`;
  }

  function dangerSection(): string {
    return `
      <section class="card settings__card settings__card--danger">
        <div class="settings__section-head">Uninstall</div>
        <div class="settings__row">
          <div class="settings__row-text">
            <div class="settings__row-label">Uninstall Taroting</div>
            <div class="settings__hint">Removes the app. The uninstaller asks whether to remove your settings and caches too. Your projects in Documents\\Taroting and exported files are kept.</div>
          </div>
          <button class="btn btn--sm btn--danger settings__uninstall-btn" id="settings-uninstall">Uninstall Taroting</button>
        </div>
      </section>`;
  }

  /* ---------------- rendering ---------------- */

  function render(): void {
    const s = settingsStore.get();
    // Read BEFORE the markup is replaced: the assignment detaches the focused
    // node and focus falls to <body>. Only focus inside this screen's own
    // content is carried over — never a dialog's or a toast's, and never the
    // header's Back button, which this render does not touch.
    const active = document.activeElement;
    const focusKey = active && active !== inner && inner.contains(active) ? focusKeyOf(active) : null;
    inner.innerHTML = [
      appearanceSection(s),
      autosaveSection(s),
      exportSection(s),
      openingSection(s),
      performanceSection(s),
      cacheSection(s),
      shortcutsSection(s),
      diagnosticsSection(),
      aboutSection(),
      dangerSection(),
    ].join("");
    // The one thing on this screen the markup cannot carry: three colours the
    // packaged app's CSP refuses as `style` attributes. Painted here, in the
    // same synchronous turn as the markup that needs them, so nothing is ever
    // laid out with an empty swatch. See the block comment above colorRow.
    paintColorSwatches(s);
    wire();
    if (focusKey) restoreFocus(inner, focusKey);
  }

  /* ---------------- wiring (re-run after each render) ---------------- */

  function wire(): void {
    // Theme segmented buttons
    inner.querySelectorAll<HTMLButtonElement>("[data-theme-opt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        persist({ theme: btn.dataset.themeOpt as Settings["theme"] });
      });
    });

    // Where a file opened from File Explorer lands
    inner.querySelectorAll<HTMLButtonElement>("[data-openwith-opt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        persist({ openWith: btn.dataset.openwithOpt as OpenWith });
      });
    });

    // Custom theme: one button per colour. There is no dark/light switch any
    // more — the direction is read off the background colour itself.
    for (const role of ["background", "accent", "text"] as const) {
      inner
        .querySelector<HTMLButtonElement>(`#settings-color-${role}`)
        ?.addEventListener("click", (e) => openColor(role, e.currentTarget as HTMLElement));
    }

    // Autosave interval
    inner
      .querySelector<HTMLSelectElement>("#settings-autosave")
      ?.addEventListener("change", (e) => {
        const v = Number((e.target as HTMLSelectElement).value);
        persist({ autosaveSeconds: v });
      });

    // Export folder
    inner
      .querySelector<HTMLButtonElement>("#settings-choose-dir")
      ?.addEventListener("click", () => void chooseExportDir());
    inner
      .querySelector<HTMLButtonElement>("#settings-clear-dir")
      ?.addEventListener("click", () => persist({ defaultExportDir: null }));

    // Performance switches
    inner
      .querySelector<HTMLInputElement>("#settings-hwaccel")
      ?.addEventListener("change", (e) => {
        persist({ hardwareAccel: (e.target as HTMLInputElement).checked });
      });
    inner
      .querySelector<HTMLInputElement>("#settings-proxy")
      ?.addEventListener("change", (e) => {
        persist({ proxyMedia: (e.target as HTMLInputElement).checked });
      });
    inner
      .querySelector<HTMLInputElement>("#settings-snap-center")
      ?.addEventListener("change", (e) => {
        persist({ snapCenterGuides: (e.target as HTMLInputElement).checked });
      });

    // Cache limit
    inner
      .querySelector<HTMLSelectElement>("#settings-cache-limit")
      ?.addEventListener("change", (e) => {
        const v = Number((e.target as HTMLSelectElement).value);
        const trim = changeCacheLimit(v);
        if (trim) void trim.then(() => loadCacheStats());
      });

    // Clear cache (two-step confirm)
    inner
      .querySelector<HTMLButtonElement>("#settings-clear-cache")
      ?.addEventListener("click", () => void handleClearCache());

    // Reset shortcuts (two-step confirm)
    inner
      .querySelector<HTMLButtonElement>("#settings-reset-shortcuts")
      ?.addEventListener("click", () => handleResetShortcuts());

    // Cache read failure → let the user actually read the reason
    inner
      .querySelector<HTMLButtonElement>("#settings-cache-error")
      ?.addEventListener("click", () => {
        showError({
          title: "Cache usage",
          message: "Couldn't read cache usage.",
          report: cacheStatsError ?? "",
        });
      });

    // Diagnostics
    inner
      .querySelector<HTMLButtonElement>("#settings-view-errors")
      ?.addEventListener("click", () => {
        const list = recentErrors();
        showError({
          title: "Recent errors",
          message: `${list.length} error${list.length === 1 ? "" : "s"} this session. This list lives in memory only and is never written to disk.`,
          report: formatRecentErrors(list),
        });
      });
    inner
      .querySelector<HTMLButtonElement>("#settings-copy-report")
      ?.addEventListener("click", () => void copySystemReport());
    inner
      .querySelector<HTMLButtonElement>("#settings-save-report")
      ?.addEventListener("click", () => void saveSystemReport());

    // Uninstall (danger zone)
    inner
      .querySelector<HTMLButtonElement>("#settings-uninstall")
      ?.addEventListener("click", () => confirmUninstall());

    // Shortcut rows → capture
    inner.querySelectorAll<HTMLElement>(".settings__shortcut").forEach((rowEl) => {
      const action = rowEl.dataset.action as ActionId;
      rowEl.addEventListener("click", () => beginCapture(action));
      rowEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          beginCapture(action);
        }
      });
    });
  }

  /* ---------------- custom theme colours ---------------- */

  /** Three proven `#rrggbb` colours. The store is seeded from an opaque
   *  settings.json, so this is the last place before a colour reaches a
   *  `background:` declaration or the picker. */
  function validCustomTheme(c: CustomTheme): CustomTheme {
    return {
      background: normalizeHexColor(c.background, DEFAULT_CUSTOM_THEME.background),
      accent: normalizeHexColor(c.accent, DEFAULT_CUSTOM_THEME.accent),
      text: normalizeHexColor(c.text, DEFAULT_CUSTOM_THEME.text),
    };
  }

  function customTheme(): CustomTheme {
    return validCustomTheme(settingsStore.get().customTheme);
  }

  function withRole(c: CustomTheme, role: ColorRole, value: string): CustomTheme {
    if (role === "background") return { ...c, background: value };
    if (role === "accent") return { ...c, accent: value };
    return { ...c, text: value };
  }

  /**
   * Put one colour onto one colour button. THE ONLY WAY A COLOUR EVER REACHES
   * THE DOM ON THIS SCREEN — the markup deliberately carries none (see the
   * block comment above `colorRow`), so this runs on every render as well as on
   * every picker frame.
   *
   * That it works mid-gesture is the second reason it exists: the button is the
   * picker's anchor, and re-rendering the screen to show a new colour would pull
   * the popover's positioning reference out from under it.
   *
   * NOTE THE ASYMMETRY IF `value` IS EVER NOT A COLOUR. `textContent` takes
   * anything; `style.background` silently REJECTS an unparseable value and
   * leaves whatever was there before. A bad value would therefore show up in the
   * caption while the swatch kept a stale fill — the opposite of the failure
   * this function was rewritten to fix, and just as confusing. Every caller
   * passes a `normalizeHexColor` result; keep it that way.
   */
  function paintColorButton(role: ColorRole, value: string): void {
    const btn = inner.querySelector<HTMLElement>(`#settings-color-${role}`);
    if (!btn) return;
    const swatch = btn.querySelector<HTMLElement>(".settings__color-swatch");
    const caption = btn.querySelector<HTMLElement>(".mono");
    if (swatch) swatch.style.background = value;
    if (caption) caption.textContent = value;
    btn.setAttribute("aria-label", `${ROLE_LABELS[role]}, ${value}`);
  }

  /** Fill all three swatches from the store, after a render has replaced them.
   *  A no-op for every other theme, which renders no colour rows at all — so a
   *  Dark/Light/System Settings screen costs exactly one comparison for this. */
  function paintColorSwatches(s: Settings): void {
    if (s.theme !== "custom") return;
    const c = validCustomTheme(s.customTheme);
    paintColorButton("background", c.background);
    paintColorButton("accent", c.accent);
    paintColorButton("text", c.text);
  }

  function openColor(role: ColorRole, anchor: HTMLElement): void {
    if (picker) {
      // A second click on the same button toggles it shut (the popover treats
      // its own anchor as "inside", so it does not self-close first).
      picker.close();
      return;
    }
    if (pickerLoading) return;
    pickerLoading = true;
    // Loaded on the click, not on mount: opening Settings — or using any other
    // theme — never pays for the picker.
    void import("../ui/color-picker")
      .then(({ openColorPicker }) => {
        if (disposed) return;
        picker = openColorPicker({
          anchor,
          label: `${ROLE_LABELS[role]} color`,
          value: customTheme()[role],
          defaultValue: DEFAULT_CUSTOM_THEME[role],
          presets: ROLE_PRESETS[role],
          onPreview: (value) => {
            paintColorButton(role, value);
            previewCustomTheme(withRole(customTheme(), role, value));
          },
          onCommit: (value) => {
            paintColorButton(role, value);
            persist({ customTheme: withRole(customTheme(), role, value) });
          },
          onClose: () => {
            // Cleared on a microtask, deliberately: the closing commit has
            // already queued a store notification, and letting that one fire a
            // full re-render would swap out the very buttons the in-flight
            // pointer sequence is about to land a click on. Nothing needs
            // rebuilding anyway — paintColorButton has already updated the
            // swatch in place, and the rest of the screen is painted from the
            // same custom properties the whole app reads.
            queueMicrotask(() => {
              picker = null;
            });
          },
        });
      })
      .catch((e: unknown) => {
        toast.error("Couldn't open the color picker.", {
          detail: describeError(e),
          op: "Settings",
          title: "Appearance",
        });
      })
      .finally(() => {
        pickerLoading = false;
      });
  }

  /* ---------------- export folder ---------------- */

  async function chooseExportDir(): Promise<void> {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ directory: true, multiple: false });
      // Through persist(), like every other write on this screen. It used to be
      // a bare awaited updateSettings inside this try, which folded a failed
      // SAVE into the catch below and reported it as "Couldn't pick a folder" —
      // the folder had been picked fine; it was the write that was lost. The
      // catch now covers only the dialog, which is all it ever understood.
      if (typeof result === "string") persist({ defaultExportDir: result });
    } catch (e) {
      toast.error("Couldn't pick a folder.", {
        detail: describeError(e),
        op: "Settings",
        title: "Choose export folder",
      });
    }
  }

  /* ---------------- diagnostics ---------------- */

  /** The same builder the export-failure view uses, with no failing operation:
   *  a user can file a good "no hardware encoder detected" report before
   *  anything has crashed. Built only when a button is pressed. */
  async function systemReport(full: boolean): Promise<string> {
    // Loaded on the button press, not on mount: opening Settings costs nothing.
    const [{ buildReport }, version, encoders] = await Promise.all([
      import("../core/diagnostics"),
      appVersion(),
      ipc.detectEncoders().catch(() => null),
    ]);
    const session = currentSession.get();
    return buildReport({
      at: new Date().toISOString(),
      appVersion: version,
      platform: navigator.platform || "",
      userAgent: navigator.userAgent,
      encoders,
      project: session ? session.project : null,
      settings: settingsStore.get(),
      recentErrors: recentErrors(),
      full,
    });
  }

  async function copySystemReport(): Promise<void> {
    const report = await systemReport(false);
    // Building the report costs an ffmpeg probe on first run, which can outlive
    // the click's transient activation — if the write is refused, hand the text
    // over in a pane the user can copy from directly.
    if (await copyText(report)) return;
    showError({
      title: "System report",
      message: "Select the text below and copy it.",
      report,
    });
  }

  /** Enable or disable the CURRENT Save report button — a render may have
   *  replaced the one that was clicked. */
  function setSaveReportBusy(busy: boolean): void {
    const btn = inner.querySelector<HTMLButtonElement>("#settings-save-report");
    if (btn) btn.disabled = busy;
  }

  async function saveSystemReport(): Promise<void> {
    // One save at a time. A double click used to build two reports, write two
    // files and show two toasts and two Explorer windows. The whole sequence is
    // covered, the slow part first: building the report waits on an ffmpeg
    // probe on a cold cache.
    if (savingReport) return;
    savingReport = true;
    const hadFocus = document.activeElement === inner.querySelector("#settings-save-report");
    setSaveReportBusy(true);
    try {
      const report = await systemReport(true);
      let path: string;
      try {
        path = await ipc.saveDiagnosticReport(report);
      } catch (e) {
        // The report itself rides along as the detail, so a failed write never
        // costs the user the text they asked for.
        toast.error("Couldn't save the report.", {
          detail: `${describeError(e)}\n\n${report}`,
          op: "Settings",
          title: "System report",
        });
        return;
      }
      toast.info("Report saved");
      try {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(path);
      } catch {
        /* the file is written; showing it in Explorer is a nicety */
      }
    } catch (e) {
      // Building the report failed (its lazy module could not load). Said, not
      // dropped: this used to be an unhandled rejection with no feedback at all.
      toast.error("Couldn't build the report.", {
        detail: describeError(e),
        op: "Settings",
        title: "System report",
      });
    } finally {
      savingReport = false;
      if (!disposed) {
        setSaveReportBusy(false);
        // Disabling a focused button drops focus to <body>. Hand it back to a
        // keyboard user who pressed Enter here, unless focus has gone elsewhere.
        const ae = document.activeElement;
        if (hadFocus && (!ae || ae === document.body)) {
          inner.querySelector<HTMLElement>("#settings-save-report")?.focus({ preventScroll: true });
        }
      }
    }
  }

  /* ---------------- cache ---------------- */

  async function loadCacheStats(): Promise<void> {
    try {
      cacheStats = await ipc.cacheStats();
      cacheStatsError = null;
    } catch (e) {
      cacheStats = null;
      cacheStatsError = describeError(e);
      // Shown inline (with a Details button), so it belongs in the ring too.
      recordError({ at: Date.now(), op: "Settings", message: "Couldn't read cache usage.", detail: cacheStatsError });
    }
    if (disposed) return; // resolved after the view went away — nothing to paint
    if (!capturing && !picker) render();
  }

  function disarmClearConfirm(): void {
    window.clearTimeout(clearConfirmTimer);
    clearConfirmArmed = false;
  }

  async function handleClearCache(): Promise<void> {
    if (!clearConfirmArmed) {
      clearConfirmArmed = true;
      render();
      clearConfirmTimer = window.setTimeout(() => {
        clearConfirmArmed = false;
        if (!capturing && !picker) render();
      }, 3000);
      return;
    }
    disarmClearConfirm();
    try {
      const freed = await ipc.clearCache([]);
      toast.info(`Cleared ${formatBytes(freed)} of cache.`);
    } catch (e) {
      toast.error("Couldn't clear cache.", {
        detail: describeError(e),
        op: "Settings",
        title: "Clear cache",
      });
    }
    await loadCacheStats();
  }

  /* ---------------- shortcuts reset ---------------- */

  function disarmResetConfirm(): void {
    window.clearTimeout(resetConfirmTimer);
    resetConfirmArmed = false;
  }

  /** The Clear-cache pattern: the first click arms "Really reset?" for three
   *  seconds, the second restores the defaults. A no-op when there is nothing to
   *  reset (the button is disabled then anyway). */
  function handleResetShortcuts(): void {
    if (shortcutsAtDefaults(settingsStore.get().shortcuts)) {
      disarmResetConfirm();
      return;
    }
    if (!resetConfirmArmed) {
      resetConfirmArmed = true;
      render();
      resetConfirmTimer = window.setTimeout(() => {
        resetConfirmArmed = false;
        if (!capturing && !picker) render();
      }, 3000);
      return;
    }
    disarmResetConfirm();
    persist({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  }

  /* ---------------- uninstall ---------------- */

  function confirmUninstall(): void {
    // Nothing new goes onto document.body once the screen is gone: teardown has
    // already run, so there would be no owner left to close it.
    if (disposed || uninstallOpen || uninstalling) return;
    uninstallOpen = true;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Uninstall Taroting">
        <div class="modal__header"><span>Uninstall Taroting?</span></div>
        <div class="modal__body">
          <p>Your projects in <strong>Documents\\Taroting</strong> and exported files are kept.
          The uninstaller that opens next asks whether to remove settings and caches.</p>
        </div>
        <div class="modal__footer">
          <button class="btn btn--sm" data-cancel>Cancel</button>
          <button class="btn btn--sm btn--danger" data-confirm>Uninstall</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const releaseTrap = trapTab(backdrop);
    // Focus starts INSIDE the dialog, on Cancel (danger dialogs never open on
    // the red button). It used to stay on the Uninstall button behind the
    // backdrop, so the trap above never saw a key, Tab walked the screen
    // underneath, and Enter clicked Uninstall again — stacking a second dialog.
    focusFirst(backdrop, "[data-cancel]");
    let closed = false;
    // Every exit — Cancel, Escape, a click on the backdrop, a failed uninstall,
    // and teardown — funnels through here, which is what keeps the focus trap
    // from being released on some paths and not others. Idempotent: the failure
    // path can fire after teardown has already closed the dialog.
    const close = (): void => {
      if (closed) return;
      closed = true;
      uninstallOpen = false;
      openOverlays.delete(close);
      document.removeEventListener("keydown", onKey, true);
      releaseTrap();
      backdrop.remove();
    };
    openOverlays.add(close);
    /** A close the user asked for: focus goes back to the button that opened
     *  the dialog (re-queried, a render may have replaced it). Teardown calls
     *  plain `close` — there is no screen left to return to. */
    const dismiss = (): void => {
      // Escape, the backdrop and Cancel all come here; none of them may close
      // a dialog whose uninstall is under way (see `uninstalling`).
      if (uninstalling) return;
      close();
      if (!disposed) inner.querySelector<HTMLElement>("#settings-uninstall")?.focus({ preventScroll: true });
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) dismiss();
    });
    const cancelBtn = backdrop.querySelector<HTMLButtonElement>("[data-cancel]")!;
    cancelBtn.addEventListener("click", dismiss);
    const confirmBtn = backdrop.querySelector<HTMLButtonElement>("[data-confirm]")!;
    confirmBtn.addEventListener("click", () => {
      // The second lock, matching the delete confirms on home: a torn-down
      // screen never acts. Teardown now closes this dialog, so a click here
      // should be impossible afterwards — but the listener outlives the node,
      // and this particular button uninstalls the application.
      if (disposed || confirmBtn.disabled) return;
      // One uninstaller. On success the backend waits ~300 ms for uninstall.exe
      // to re-launch itself before the app exits, and a second click inside
      // that window used to start a second wizard. Disabling Confirm covers
      // this dialog; `uninstalling` covers the way round it — Escape, then
      // Uninstall and Confirm again in a fresh dialog. Cancel is disabled too,
      // so the dialog does not offer a way out it would then ignore.
      uninstalling = true;
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      // On success the app process exits before this promise resolves.
      void ipc.uninstallApp().catch((e: unknown) => {
        uninstalling = false;
        dismiss();
        // A portable copy has no uninstaller: not a failure, just not how this
        // copy is removed — so it is said, not recorded among the errors.
        const refusal = uninstallRefusal(e);
        if (refusal) {
          toast.refuse(refusal);
          return;
        }
        toast.error("Couldn't uninstall Taroting.", {
          detail: describeError(e),
          op: "Settings",
          title: "Uninstall",
        });
      });
    });
  }

  /* ---------------- shortcut capture ---------------- */

  function beginCapture(action: ActionId): void {
    if (capturing === action) return;
    endCapture(); // cancel any in-flight capture first
    capturing = action;
    render();

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        endCapture();
        render();
        return;
      }
      const chord = chordOf(e);
      if (!chord) return; // modifier-only press: keep waiting
      const current = settingsStore.get().shortcuts;
      capturing = null;
      captureCleanup?.();
      captureCleanup = null;
      // updateSettings triggers a store change → subscribe re-renders.
      persist({ shortcuts: { ...current, [action]: chord } });
    };

    window.addEventListener("keydown", onKey, true);
    captureCleanup = () => window.removeEventListener("keydown", onKey, true);
  }

  function endCapture(): void {
    capturing = null;
    captureCleanup?.();
    captureCleanup = null;
  }

  /* ---------------- live updates ---------------- */

  const unsubscribe = settingsStore.subscribe(() => {
    // Never blow away the DOM mid-capture (would drop the "Press a key…" row and
    // the focused listener context feels jumpy). Capture completion nulls it out
    // before updateSettings fires, so completed rebinds still re-render.
    // Same for an open colour picker: its anchor lives in this DOM, and the
    // swatch it commits is already repainted in place by paintColorButton.
    if (capturing || picker) return;
    render();
  });

  render();
  void loadCacheStats();
  // Cheap: appVersion() is a cached lazy import, so this only pays once per run.
  void appVersion().then((v) => {
    if (disposed || !v) return;
    appVer = v;
    if (!capturing && !picker) render();
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      endCapture();
      disarmClearConfirm();
      disarmResetConfirm();
      // Closing commits the value on screen, so leaving Settings mid-pick can
      // never strand a previewed colour that was never persisted.
      picker?.close();
      picker = null;
      // The Uninstall confirm lives on document.body, outside the subtree the
      // router clears, and its buttons are wired to this screen. Closing it is
      // teardown's job; nothing else will ever do it.
      closeOverlays();
    },
  };
}
