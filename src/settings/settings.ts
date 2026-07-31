// Settings screen: a full-window route (like home) for appearance, autosave,
// export defaults, performance, cache, and rebindable keyboard shortcuts.
// Everything persists immediately via updateSettings and reflects settingsStore
// live. The screen fully re-renders on store changes EXCEPT during shortcut
// capture and while a colour picker is open — both of those mutate the single
// row they own in place instead, because a rebuild would drop the element the
// interaction is anchored to.

import "./settings.css";
import { escapeHtml, formatBytes } from "../core/format";
import { appVersion, describeError, ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import {
  currentSession,
  normalizeHexColor,
  previewCustomTheme,
  settingsStore,
  updateSettings,
} from "../core/session";
import { chordOf, findConflicts, normalizeChord } from "../core/shortcuts";
import type { ActionId, CustomTheme, Settings } from "../core/types";
import { DEFAULT_CUSTOM_THEME, DEFAULT_SHORTCUTS } from "../core/types";
import type { ColorPickerHandle } from "../ui/color-picker";
import {
  copyText,
  formatRecentErrors,
  openErrorDialog,
  recentErrors,
  recordError,
} from "../ui/errors";
import { trapTab } from "../ui/focus";
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
  goHome: "Close project",
  fullscreen: "Fullscreen playback",
};

/** Action row order — mirrors the ActionId union for a predictable list. */
const ACTION_ORDER: ActionId[] = [
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
  "save",
  "copy",
  "paste",
  "toggleSnap",
  "toggleLoop",
  "addMarker",
  "export",
  "goHome",
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

const AUTOSAVE_OPTIONS = [1, 3, 5, 10, 30];
const CACHE_LIMIT_OPTIONS_MB = [1024, 2048, 5120, 10240, 20480];
const CACHE_KIND_ORDER = ["remux", "proxy", "waveform", "thumbs", "filmstrip"];

type CacheStats = { totalBytes: number; byKind: Record<string, number> };

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
  /** Resolved once on mount; empty until then so the first paint isn't blocked. */
  let appVer = "";

  /* ---------------- section builders ---------------- */

  function segmented(
    active: string,
    options: { value: string; label: string }[],
    attr: string,
  ): string {
    return `<div class="settings__segmented">${options
      .map(
        (o) =>
          `<button class="btn btn--sm ${o.value === active ? "btn--on" : ""}" ${attr}="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`,
      )
      .join("")}</div>`;
  }

  function selectHtml(
    id: string,
    value: number,
    options: { value: number; label: string }[],
  ): string {
    return `<select class="select select--sm" id="${id}">${options
      .map(
        (o) =>
          `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${escapeHtml(o.label)}</option>`,
      )
      .join("")}</select>`;
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

  /** One colour row: a label, a hint, and a button whose swatch and caption are
   *  the current colour. The hex is interpolated directly because
   *  `normalizeHexColor` has already proven it is exactly `#rrggbb` — see the
   *  note on that function in core/session.ts. */
  function colorRow(role: ColorRole, hex: string): string {
    const label = ROLE_LABELS[role];
    return `
      <div class="settings__row">
        <div class="settings__row-text">
          <div class="settings__row-label">${escapeHtml(label)}</div>
          <div class="settings__hint">${escapeHtml(ROLE_HINTS[role])}</div>
        </div>
        <button class="btn btn--sm settings__color-btn" id="settings-color-${role}"
                aria-label="${escapeHtml(label)}, ${hex}" aria-haspopup="dialog">
          <span class="settings__color-swatch" style="background:${hex}"></span>
          <span class="mono">${hex}</span>
        </button>
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
    const sel = selectHtml(
      "settings-autosave",
      s.autosaveSeconds,
      AUTOSAVE_OPTIONS.map((n) => ({ value: n, label: `${n}s` })),
    );
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

  function performanceSection(s: Settings): string {
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Performance</div>
        ${switchRow("settings-hwaccel", "Hardware acceleration", s.hardwareAccel)}
        ${switchRow(
          "settings-proxy",
          "Proxy media",
          s.proxyMedia,
          "Use lighter preview copies for heavy or 4K files",
        )}
        ${switchRow(
          "settings-snap-center",
          "Snap to center guides",
          s.snapCenterGuides,
          "Dragged clips snap to the canvas center",
        )}
        ${switchRow(
          "settings-temp-open",
          "Quick view from File Explorer",
          s.tempOpenWith,
          "Media opened from File Explorer becomes a temporary project. You choose whether to keep it when you leave",
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
    const sel = selectHtml(
      "settings-cache-limit",
      s.cacheLimitMB,
      CACHE_LIMIT_OPTIONS_MB.map((mb) => ({ value: mb, label: `${mb / 1024} GB` })),
    );
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
          <button class="btn btn--sm ${clearConfirmArmed ? "btn--danger" : ""}" id="settings-clear-cache">${clearConfirmArmed ? "Really clear?" : "Clear cache"}</button>
        </div>
      </section>`;
  }

  function shortcutsSection(s: Settings): string {
    const conflicts = new Set(findConflicts(s.shortcuts));
    const rows = ACTION_ORDER.map((action) => {
      const chord = normalizeChord(s.shortcuts[action] ?? "");
      const isConflict = chord !== "" && conflicts.has(chord);
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

    const dupes = findConflicts(s.shortcuts);
    const warning =
      dupes.length > 0
        ? `<div class="settings__conflict-warn">${icon("warning", 14)}<span>Duplicate shortcuts: ${escapeHtml(dupes.join(", "))}</span></div>`
        : "";

    return `
      <section class="card settings__card">
        <div class="settings__section-head settings__section-head--row">
          <span>Keyboard shortcuts</span>
          <button class="btn btn--sm btn--ghost" id="settings-reset-shortcuts">Reset to defaults</button>
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
            <button class="btn btn--sm" id="settings-save-report">Save report</button>
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
            <div class="settings__hint">Removes the app, its settings and caches. Your projects in Documents\\Taroting and exported files are kept.</div>
          </div>
          <button class="btn btn--sm btn--danger settings__uninstall-btn" id="settings-uninstall">Uninstall Taroting</button>
        </div>
      </section>`;
  }

  /* ---------------- rendering ---------------- */

  function render(): void {
    const s = settingsStore.get();
    inner.innerHTML = [
      appearanceSection(s),
      autosaveSection(s),
      exportSection(s),
      performanceSection(s),
      cacheSection(s),
      shortcutsSection(s),
      diagnosticsSection(),
      aboutSection(),
      dangerSection(),
    ].join("");
    wire();
  }

  /* ---------------- wiring (re-run after each render) ---------------- */

  function wire(): void {
    // Theme segmented buttons
    inner.querySelectorAll<HTMLButtonElement>("[data-theme-opt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        void updateSettings({ theme: btn.dataset.themeOpt as Settings["theme"] });
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
        void updateSettings({ autosaveSeconds: v });
      });

    // Export folder
    inner
      .querySelector<HTMLButtonElement>("#settings-choose-dir")
      ?.addEventListener("click", () => void chooseExportDir());
    inner
      .querySelector<HTMLButtonElement>("#settings-clear-dir")
      ?.addEventListener("click", () => void updateSettings({ defaultExportDir: null }));

    // Performance switches
    inner
      .querySelector<HTMLInputElement>("#settings-hwaccel")
      ?.addEventListener("change", (e) => {
        void updateSettings({ hardwareAccel: (e.target as HTMLInputElement).checked });
      });
    inner
      .querySelector<HTMLInputElement>("#settings-proxy")
      ?.addEventListener("change", (e) => {
        void updateSettings({ proxyMedia: (e.target as HTMLInputElement).checked });
      });
    inner
      .querySelector<HTMLInputElement>("#settings-snap-center")
      ?.addEventListener("change", (e) => {
        void updateSettings({ snapCenterGuides: (e.target as HTMLInputElement).checked });
      });
    inner
      .querySelector<HTMLInputElement>("#settings-temp-open")
      ?.addEventListener("change", (e) => {
        void updateSettings({ tempOpenWith: (e.target as HTMLInputElement).checked });
      });

    // Cache limit
    inner
      .querySelector<HTMLSelectElement>("#settings-cache-limit")
      ?.addEventListener("change", (e) => {
        const v = Number((e.target as HTMLSelectElement).value);
        void updateSettings({ cacheLimitMB: v });
      });

    // Clear cache (two-step confirm)
    inner
      .querySelector<HTMLButtonElement>("#settings-clear-cache")
      ?.addEventListener("click", () => void handleClearCache());

    // Reset shortcuts
    inner
      .querySelector<HTMLButtonElement>("#settings-reset-shortcuts")
      ?.addEventListener("click", () => {
        void updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } });
      });

    // Cache read failure → let the user actually read the reason
    inner
      .querySelector<HTMLButtonElement>("#settings-cache-error")
      ?.addEventListener("click", () => {
        openErrorDialog({
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
        openErrorDialog({
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

  /** Update one colour button in place rather than re-rendering the screen:
   *  the button is the picker's anchor, and rebuilding it mid-gesture would
   *  pull the popover's positioning reference out from under it. Same reason
   *  shortcut capture mutates a single row. */
  function paintColorButton(role: ColorRole, value: string): void {
    const btn = inner.querySelector<HTMLElement>(`#settings-color-${role}`);
    if (!btn) return;
    const swatch = btn.querySelector<HTMLElement>(".settings__color-swatch");
    const caption = btn.querySelector<HTMLElement>(".mono");
    if (swatch) swatch.style.background = value;
    if (caption) caption.textContent = value;
    btn.setAttribute("aria-label", `${ROLE_LABELS[role]}, ${value}`);
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
            void updateSettings({ customTheme: withRole(customTheme(), role, value) });
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
      if (typeof result === "string") {
        await updateSettings({ defaultExportDir: result });
      }
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
    openErrorDialog({
      title: "System report",
      message: "Select the text below and copy it.",
      report,
    });
  }

  async function saveSystemReport(): Promise<void> {
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

  /* ---------------- uninstall ---------------- */

  function confirmUninstall(): void {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Uninstall Taroting">
        <div class="modal__header"><span>Uninstall Taroting?</span></div>
        <div class="modal__body">
          <p>Your projects in <strong>Documents\\Taroting</strong> and exported files are kept.
          Settings and caches are removed.</p>
        </div>
        <div class="modal__footer">
          <button class="btn btn--sm" data-cancel>Cancel</button>
          <button class="btn btn--sm btn--danger" data-confirm>Uninstall</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const releaseTrap = trapTab(backdrop);
    const close = (): void => {
      document.removeEventListener("keydown", onKey, true);
      releaseTrap();
      backdrop.remove();
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector("[data-cancel]")!.addEventListener("click", close);
    backdrop.querySelector("[data-confirm]")!.addEventListener("click", () => {
      // On success the app process exits before this promise resolves; on
      // failure (e.g. a dev build with no registry entry) surface the error.
      void ipc.uninstallApp().catch((e: unknown) => {
        close();
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
      void updateSettings({ shortcuts: { ...current, [action]: chord } });
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
      // Closing commits the value on screen, so leaving Settings mid-pick can
      // never strand a previewed colour that was never persisted.
      picker?.close();
      picker = null;
    },
  };
}
