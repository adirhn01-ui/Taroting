// Settings screen: a full-window route (like home) for appearance, autosave,
// export defaults, performance, cache, and rebindable keyboard shortcuts.
// Everything persists immediately via updateSettings and reflects settingsStore
// live. The screen fully re-renders on store changes EXCEPT during shortcut
// capture (where we mutate a single row in place).

import "./settings.css";
import { escapeHtml, formatBytes } from "../core/format";
import { describeError, ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { settingsStore, updateSettings } from "../core/session";
import { chordOf, findConflicts, normalizeChord } from "../core/shortcuts";
import type { ActionId, Settings } from "../core/types";
import { DEFAULT_SHORTCUTS } from "../core/types";
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
  let cacheStatsError = false;
  // Two-step "Clear cache" confirm and shortcut-capture state live outside the
  // render so we can suppress full re-renders while capturing.
  let clearConfirmTimer: number | undefined;
  let clearConfirmArmed = false;
  let capturing: ActionId | null = null;
  let captureCleanup: (() => void) | null = null;

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

  function appearanceSection(s: Settings): string {
    const seg = segmented(
      s.theme,
      [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "system", label: "System" },
      ],
      "data-theme-opt",
    );
    return `
      <section class="card settings__card">
        <div class="settings__section-head">Appearance</div>
        <div class="settings__row">
          <div class="settings__row-label">Theme</div>
          ${seg}
        </div>
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
      </section>`;
  }

  function cacheSection(s: Settings): string {
    let usageHtml: string;
    if (cacheStatsError) {
      usageHtml = `<div class="settings__hint">Couldn't read cache usage.</div>`;
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

  /* ---------------- export folder ---------------- */

  async function chooseExportDir(): Promise<void> {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ directory: true, multiple: false });
      if (typeof result === "string") {
        await updateSettings({ defaultExportDir: result });
      }
    } catch (e) {
      toast.error(`Couldn't pick a folder: ${describeError(e)}`);
    }
  }

  /* ---------------- cache ---------------- */

  async function loadCacheStats(): Promise<void> {
    try {
      cacheStats = await ipc.cacheStats();
      cacheStatsError = false;
    } catch {
      cacheStats = null;
      cacheStatsError = true;
    }
    if (!capturing) render();
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
        if (!capturing) render();
      }, 3000);
      return;
    }
    disarmClearConfirm();
    try {
      const freed = await ipc.clearCache([]);
      toast.info(`Cleared ${formatBytes(freed)} of cache.`);
    } catch (e) {
      toast.error(`Couldn't clear cache: ${describeError(e)}`);
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
      void ipc.uninstallApp().catch((e) => {
        close();
        toast.error(`Couldn't uninstall: ${describeError(e)}`);
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
    if (capturing) return;
    render();
  });

  render();
  void loadCacheStats();

  return {
    dispose() {
      unsubscribe();
      endCapture();
      disarmClearConfirm();
    },
  };
}
