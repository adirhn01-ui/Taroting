import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../core/ipc";
import { settingsStore } from "../core/session";
import { ACTION_MODES, DEFAULT_SHORTCUTS } from "../core/types";
import type { ActionId } from "../core/types";
import { ACTION_LABELS, ACTION_ORDER, LIVE_MODES, changeCacheLimit, colorRow, liveConflicts } from "./settings";

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
