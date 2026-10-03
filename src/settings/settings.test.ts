import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../core/ipc";
import { settingsStore } from "../core/session";
import { ACTION_MODES, DEFAULT_SHORTCUTS } from "../core/types";
import type { ActionId } from "../core/types";
import {
  ACTION_LABELS,
  ACTION_ORDER,
  LIVE_MODES,
  cacheLimitLabel,
  changeCacheLimit,
  clearCacheButton,
  colorRow,
  liveConflicts,
  resetShortcutsButton,
  selectHtml,
  shortcutsAtDefaults,
  uninstallRefusal,
} from "./settings";

// The real store, a fake disk write: updateSettings paints the store the way
// the real one does (synchronously on a verified session) and never reaches IPC.
const writes = vi.hoisted(() => [] as unknown[]);
vi.mock("../core/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/session")>();
  return {
    ...real,
    updateSettings: async (patch: Record<string, unknown>) => {
      writes.push(patch);
      real.settingsStore.set({ ...real.settingsStore.get(), ...patch });
    },
  };
});

describe("ACTION_ORDER", () => {
  it("lists every ActionId exactly once", () => {
    const ids = Object.keys(DEFAULT_SHORTCUTS);
    // Length AND set: a duplicate row would hide a missing one from a set check.
    expect(ACTION_ORDER.length).toBe(ids.length);
    expect(new Set(ACTION_ORDER)).toEqual(new Set(ids));
  });
});

describe("liveConflicts", () => {
  it("reports a clash on every screen that binds both actions", () => {
    // undo and redo share the editor AND image modes, and both screens exist,
    // so one clash is two rows — one per screen the user can meet it on.
    const shortcuts = { ...DEFAULT_SHORTCUTS, redo: "Ctrl+Z" };
    expect(ACTION_MODES.undo).toContain("image");
    expect(LIVE_MODES).toContain("image");

    const live = liveConflicts(shortcuts);
    expect(live).toEqual([
      { chord: "Ctrl+Z", mode: "editor", actions: ["undo", "redo"] },
      { chord: "Ctrl+Z", mode: "image", actions: ["undo", "redo"] },
    ]);
  });


  it("keeps a clash on the viewer", () => {
    const live = liveConflicts({ ...DEFAULT_SHORTCUTS, nextFile: "Space" });
    expect(live).toEqual([{ chord: "Space", mode: "viewer", actions: ["playPause", "nextFile"] }]);
  });

  it("is empty for the defaults", () => {
    expect(liveConflicts(DEFAULT_SHORTCUTS)).toEqual([]);
  });
});

describe("ACTION_LABELS", () => {
  it("has a label for every ActionId", () => {
    const actionIds = Object.keys(DEFAULT_SHORTCUTS) as ActionId[];
    for (const id of actionIds) {
      expect(ACTION_LABELS[id], `missing label for "${id}"`).toBeTruthy();
    }
  });

  it("has no extra keys beyond the ActionId set", () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(Object.keys(DEFAULT_SHORTCUTS).sort());
  });
});

/**
 * THE REGRESSION THESE PIN, in one sentence: a custom theme's colour swatches
 * rendered as empty boxes in the PACKAGED app, because the fill was an inline
 * `style="background:…"` attribute and the shipped CSP refuses those.
 *
 * Tauri stamps a nonce onto the `<style>` block in index.html and appends
 * `'nonce-…'` to `style-src`, which under CSP Level 3 makes the `'unsafe-inline'`
 * we configured inert — and a style ATTRIBUTE can never carry a nonce. The
 * CSSOM is not gated by any of that, so `paintColorButton` was quietly the only
 * thing that had ever made a swatch visible, and only until you left the screen
 * and came back to a freshly rendered row with nothing to paint it. The whole
 * chain is documented above `colorRow` in settings.ts.
 *
 * `colorRow` is pure and is the only place a colour could get back into the
 * markup, so the half of the fix that matters is assertable here, with no DOM.
 * The other half — that `render` calls `paintColorButton` for all three roles
 * before returning — is genuinely DOM-only and is not covered by these tests.
 */
describe("colorRow", () => {
  const ROLES = ["background", "accent", "text"] as const;
  const HEX = "#c58e8e";

  it("emits no inline style attribute — the packaged CSP would drop it", () => {
    for (const role of ROLES) {
      expect(colorRow(role, HEX), `the ${role} row carries an inline style`).not.toMatch(/style\s*=/);
    }
  });

  it("leaves the swatch empty, so the CSSOM paint stays load-bearing", () => {
    for (const role of ROLES) {
      // Exactly this shape: a swatch that carries its own fill again, by any
      // route, is the bug coming back.
      expect(colorRow(role, HEX)).toContain(`<span class="settings__color-swatch"></span>`);
      expect(colorRow(role, HEX)).not.toContain(HEX.slice(1) + '"></span>');
    }
  });

  it("still carries the hex where it is text: the caption and the accessible name", () => {
    for (const role of ROLES) {
      const html = colorRow(role, HEX);
      // Deleting the hex is not a valid way to make the assertions above pass.
      expect(html).toContain(`<span class="mono">${HEX}</span>`);
      expect(html).toContain(`, ${HEX}"`);
      expect(html).toContain(`id="settings-color-${role}"`);
    }
  });
});

describe("changeCacheLimit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    writes.length = 0;
  });

  it("lowering the limit saves it and trims the cache to it now, keeping nothing", async () => {
    settingsStore.set({ ...settingsStore.get(), cacheLimitMB: 10240 });
    const trim = vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    const done = changeCacheLimit(2048);
    expect(done).not.toBeNull();
    await done;
    expect(writes).toEqual([{ cacheLimitMB: 2048 }]);
    expect(trim).toHaveBeenCalledTimes(1);
    expect(trim).toHaveBeenCalledWith(2048, []);
  });

  it("raising it (or setting the same value) saves it and trims nothing", () => {
    settingsStore.set({ ...settingsStore.get(), cacheLimitMB: 2048 });
    const trim = vi.spyOn(ipc, "enforceCacheLimit").mockResolvedValue(0);
    expect(changeCacheLimit(5120)).toBeNull();
    expect(changeCacheLimit(5120)).toBeNull();
    expect(writes).toEqual([{ cacheLimitMB: 5120 }, { cacheLimitMB: 5120 }]);
    expect(trim).not.toHaveBeenCalled();
  });

  it("a trim that fails still settles, so the usage figure repaints", async () => {
    settingsStore.set({ ...settingsStore.get(), cacheLimitMB: 5120 });
    vi.spyOn(ipc, "enforceCacheLimit").mockRejectedValue(new Error("no backend"));
    await expect(changeCacheLimit(1024)).resolves.toBeUndefined();
  });
});

describe("selectHtml", () => {
  const CACHE = [1024, 2048, 5120, 10240, 20480];
  const selected = (html: string) => [...html.matchAll(/<option value="([^"]*)"\s*selected>([^<]*)</g)].map((x) => [x[1], x[2]]);
  const values = (html: string) => [...html.matchAll(/<option value="([^"]*)"/g)].map((x) => Number(x[1]));

  it("shows an off-list cache limit as itself, in order, instead of the first option", () => {
    const html = selectHtml("c", 3000, CACHE, cacheLimitLabel);
    // Exactly one selected option, and it is the real value — not "1 GB".
    expect(selected(html)).toEqual([["3000", "2.9 GB"]]);
    expect(values(html)).toEqual([1024, 2048, 3000, 5120, 10240, 20480]);
  });

  it("shows an off-list autosave interval as itself", () => {
    const html = selectHtml("a", 7, [1, 3, 5, 10, 30], (n) => `${n}s`);
    expect(selected(html)).toEqual([["7", "7s"]]);
    expect(values(html)).toEqual([1, 3, 5, 7, 10, 30]);
  });

  it("adds nothing for a value that is on the list", () => {
    const html = selectHtml("c", 5120, CACHE, cacheLimitLabel);
    expect(selected(html)).toEqual([["5120", "5 GB"]]);
    expect(values(html)).toEqual(CACHE);
  });

  it("labels a sub-gigabyte limit in megabytes", () => {
    expect(cacheLimitLabel(500)).toBe("500 MB");
    expect(cacheLimitLabel(2048)).toBe("2 GB");
  });
});

describe("shortcutsAtDefaults", () => {
  it("is true for the defaults, however a chord is spelled", () => {
    expect(shortcutsAtDefaults({ ...DEFAULT_SHORTCUTS })).toBe(true);
    expect(shortcutsAtDefaults({ ...DEFAULT_SHORTCUTS, undo: "ctrl+z" })).toBe(true);
  });

  it("is false for a rebound action, and for one emptied because its default was taken", () => {
    expect(shortcutsAtDefaults({ ...DEFAULT_SHORTCUTS, split: "Ctrl+K" })).toBe(false);
    expect(shortcutsAtDefaults({ ...DEFAULT_SHORTCUTS, stop: "" })).toBe(false);
  });
});

describe("two-step confirm buttons", () => {
  it("Clear cache asks again without destructive red: the cache regenerates", () => {
    expect(clearCacheButton(false)).toContain(">Clear cache<");
    expect(clearCacheButton(true)).toContain(">Really clear?<");
    expect(clearCacheButton(true)).not.toContain("btn--danger");
    expect(clearCacheButton(true)).toContain("btn--primary");
  });

  it("Reset to defaults arms, never in red, and is disabled with nothing to reset", () => {
    expect(resetShortcutsButton(false, false)).toContain(">Reset to defaults<");
    expect(resetShortcutsButton(true, false)).toContain(">Really reset?<");
    expect(resetShortcutsButton(true, false)).not.toContain("btn--danger");
    expect(resetShortcutsButton(false, true)).toMatch(/\sdisabled>/);
    // Already at the defaults: never shows as armed.
    expect(resetShortcutsButton(true, true)).toContain(">Reset to defaults<");
    expect(resetShortcutsButton(false, false)).not.toMatch(/\sdisabled>/);
  });
});

describe("uninstallRefusal", () => {
  it("turns the backend's 'not installed' into how to remove a portable copy", () => {
    expect(uninstallRefusal({ code: "bad_input", message: "not installed" })).toBe(
      "This is a portable copy. To remove it, delete its folder.",
    );
  });

  it("leaves every other failure an error — the same code, or the same words under another code", () => {
    expect(uninstallRefusal({ code: "bad_input", message: "uninstall task failed: x" })).toBeNull();
    expect(uninstallRefusal({ code: "io", message: "not installed" })).toBeNull();
    expect(uninstallRefusal(new Error("not installed"))).toBeNull();
  });
});
