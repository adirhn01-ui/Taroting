import { describe, expect, it } from "vitest";
import { chordOf, findConflicts, normalizeChord } from "./shortcuts";

const ev = (key: string, mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("chordOf", () => {
  it("normalizes keys and modifier order", () => {
    expect(chordOf(ev(" "))).toBe("Space");
    expect(chordOf(ev("z", { ctrl: true }))).toBe("Ctrl+Z");
    expect(chordOf(ev("Z", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+Z");
    expect(chordOf(ev("ArrowLeft"))).toBe("ArrowLeft");
    expect(chordOf(ev("Delete", { shift: true }))).toBe("Shift+Delete");
    expect(chordOf(ev("s", { meta: true }))).toBe("Ctrl+S"); // meta folds into Ctrl
  });

  it("modifier keys alone produce no chord", () => {
    expect(chordOf(ev("Control", { ctrl: true }))).toBeNull();
    expect(chordOf(ev("Shift", { shift: true }))).toBeNull();
  });
});

describe("normalizeChord", () => {
  it("cleans up user-entered chords", () => {
    expect(normalizeChord("ctrl + shift + z")).toBe("Ctrl+Shift+Z");
    expect(normalizeChord("SHIFT+delete")).toBe("Shift+Delete");
    expect(normalizeChord("cmd+s")).toBe("Ctrl+S");
    expect(normalizeChord("n")).toBe("N");
    expect(normalizeChord("")).toBe("");
  });
});

describe("findConflicts", () => {
  it("detects duplicate bindings", () => {
    expect(
      findConflicts({ a: "Ctrl+Z", b: "ctrl+z", c: "Space" }),
    ).toEqual(["Ctrl+Z"]);
    expect(findConflicts({ a: "Ctrl+Z", b: "Ctrl+Y" })).toEqual([]);
  });
});

/* ============================================================================
 * Keyboard layouts and keyboard ownership.
 *
 * The `key` values below are not invented. They came out of the Win32 layout
 * tables on a real machine: for each `e.code` the physical scancode was mapped
 * to that layout's virtual key (MapVirtualKeyEx, MAPVK_VSC_TO_VK_EX) and run
 * through ToUnicodeEx — which is the same OS mapping Chromium reads to fill in
 * KeyboardEvent.key. Nine layouts were dumped; the rows that matter are here.
 * ==========================================================================*/

import { blockShortcuts, physicalChordOf, resolveChord, shortcutsBlocked } from "./shortcuts";
import { DEFAULT_SHORTCUTS } from "./types";
import type { ActionId } from "./types";

/** An event with a physical `code`, as the browser delivers. */
const kev = (
  key: string,
  code: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({ ...ev(key, mods), code });

/** The app's real bindings, mapped exactly as ShortcutManager.setBindings does. */
const defaults = (): ReadonlyMap<string, ActionId> => {
  const m = new Map<string, ActionId>();
  for (const [action, stored] of Object.entries(DEFAULT_SHORTCUTS) as [ActionId, string][]) {
    const chord = normalizeChord(stored);
    if (chord) m.set(chord, action);
  }
  return m;
};

/** code -> the character each layout puts on that physical key. */
const HEBREW: Record<string, string> = {
  KeyS: "ד", KeyM: "צ", KeyN: "מ", KeyL: "ך", KeyF: "כ",
  KeyZ: "ז", KeyC: "ב", KeyV: "ה", KeyE: "ק", KeyW: "'",
};
const RUSSIAN: Record<string, string> = {
  KeyS: "ы", KeyM: "ь", KeyN: "т", KeyL: "д", KeyF: "а",
  KeyZ: "я", KeyC: "с", KeyV: "м", KeyE: "у", KeyW: "ц",
};
const QWERTY: Record<string, string> = {
  KeyS: "s", KeyM: "m", KeyN: "n", KeyL: "l", KeyF: "f",
  KeyZ: "z", KeyC: "c", KeyV: "v", KeyE: "e", KeyW: "w",
};

/** Every letter/Ctrl chord in DEFAULT_SHORTCUTS, as (code, modifiers, action). */
const LETTER_CHORDS: [string, Partial<Record<"ctrl" | "shift", boolean>>, ActionId][] = [
  ["KeyS", {}, "split"],
  ["KeyM", {}, "addMarker"],
  ["KeyN", {}, "toggleSnap"],
  ["KeyL", {}, "toggleLoop"],
  ["KeyF", {}, "fullscreen"],
  ["KeyZ", { ctrl: true }, "undo"],
  ["KeyZ", { ctrl: true, shift: true }, "redo"],
  ["KeyC", { ctrl: true }, "copy"],
  ["KeyV", { ctrl: true }, "paste"],
  ["KeyS", { ctrl: true }, "save"],
  ["KeyE", { ctrl: true }, "export"],
];

describe("physicalChordOf", () => {
  it("recovers the Latin chord from a non-Latin layout", () => {
    expect(physicalChordOf(kev("ד", "KeyS"))).toBe("S"); // Hebrew ד
    expect(physicalChordOf(kev("я", "KeyZ", { ctrl: true }))).toBe("Ctrl+Z"); // Russian я
    expect(
      physicalChordOf(kev("Я", "KeyZ", { ctrl: true, shift: true })),
    ).toBe("Ctrl+Shift+Z");
    expect(physicalChordOf(kev("σ", "KeyS"))).toBe("S"); // Greek σ
  });

  it("never fires for a key the layout printed as ASCII", () => {
    // This is the guard that keeps every Latin layout untouched. A physical
    // position alone cannot tell Hebrew's apostrophe-on-KeyW from Dvorak's
    // comma-on-KeyW, so an ASCII character is always taken at face value.
    expect(physicalChordOf(kev("s", "KeyS"))).toBeNull(); // QWERTY
    expect(physicalChordOf(kev("o", "KeyS"))).toBeNull(); // Dvorak
    expect(physicalChordOf(kev(",", "KeyM"))).toBeNull(); // AZERTY
    expect(physicalChordOf(kev("y", "KeyZ", { ctrl: true }))).toBeNull(); // QWERTZ
    expect(physicalChordOf(kev("'", "KeyW", { ctrl: true }))).toBeNull(); // Hebrew
    expect(physicalChordOf(kev("5", "Digit5"))).toBeNull();
  });

  it("ignores named keys, unusable codes and a missing code", () => {
    expect(physicalChordOf(kev("ArrowLeft", "ArrowLeft"))).toBeNull();
    expect(physicalChordOf(kev(" ", "Space"))).toBeNull();
    expect(physicalChordOf(kev("Delete", "Delete"))).toBeNull();
    // non-ASCII, but the position names no letter to recover
    expect(physicalChordOf(kev("ת", "Comma"))).toBeNull();
    expect(physicalChordOf(kev("ד", "Backquote"))).toBeNull();
    expect(physicalChordOf(ev("ד"))).toBeNull(); // no `code` at all
  });

  it("uses digit positions too", () => {
    expect(physicalChordOf(kev("й", "Digit7", { ctrl: true }))).toBe("Ctrl+7");
  });
});

describe("resolveChord on a US layout", () => {
  it("resolves every default binding", () => {
    const map = defaults();
    for (const [code, mods, action] of LETTER_CHORDS) {
      expect(resolveChord(kev(QWERTY[code]!, code, mods), map), code).toBe(action);
    }
    expect(resolveChord(kev("w", "KeyW", { ctrl: true }), map)).toBe("goHome");
    expect(resolveChord(kev(" ", "Space"), map)).toBe("playPause");
    expect(resolveChord(kev("Delete", "Delete"), map)).toBe("delete");
  });

  it("leaves an unbound chord unresolved", () => {
    const map = defaults();
    expect(resolveChord(kev("x", "KeyX"), map)).toBeUndefined();
    expect(resolveChord(kev("j", "KeyJ", { ctrl: true }), map)).toBeUndefined();
  });
});

describe("resolveChord on a non-Latin layout", () => {
  it("recovers the letter and Ctrl chords under Hebrew", () => {
    const map = defaults();
    for (const [code, mods, action] of LETTER_CHORDS) {
      expect(resolveChord(kev(HEBREW[code]!, code, mods), map), code).toBe(action);
    }
  });

  it("recovers the letter and Ctrl chords under Russian", () => {
    const map = defaults();
    for (const [code, mods, action] of LETTER_CHORDS) {
      expect(resolveChord(kev(RUSSIAN[code]!, code, mods), map), code).toBe(action);
    }
    expect(resolveChord(kev(RUSSIAN.KeyW!, "KeyW", { ctrl: true }), map)).toBe("goHome");
  });

  it("still leaves Hebrew Ctrl+W inert — the one chord this cannot reach", () => {
    // The Hebrew layout puts a plain ASCII apostrophe on KeyW, so this chord is
    // indistinguishable from Dvorak's Ctrl+comma. Recovering it would send a
    // Dvorak user home; refusing to leaves a Hebrew user one key to rebind.
    // Deliberate, and the cheaper of the two failures. If this ever starts
    // resolving, check what it now does to Dvorak before celebrating.
    expect(resolveChord(kev("'", "KeyW", { ctrl: true }), defaults())).toBeUndefined();
  });

  it("does not touch keys that were never layout-dependent", () => {
    const map = defaults();
    for (const [key, action] of [
      [" ", "playPause"], ["ArrowLeft", "stepBack"], ["ArrowRight", "stepFwd"],
      ["Home", "goStart"], ["End", "goEnd"], ["Delete", "delete"],
    ] as const) {
      expect(resolveChord(kev(key, "Irrelevant"), map), key).toBe(action);
    }
  });
});

describe("resolveChord never misfires on a rearranged Latin layout", () => {
  it("ignores the physical position when the layout printed a Latin character", () => {
    const map = defaults();
    // Each row: what the user pressed, and the action an unguarded e.code
    // fallback would have fired. Every one must resolve to nothing.
    const traps: [string, string, Partial<Record<"ctrl" | "shift", boolean>>, string][] = [
      ["US-Dvorak", ",", { ctrl: true }, "KeyW"], // would be goHome
      ["US-Dvorak", ";", { ctrl: true }, "KeyZ"], // would be undo
      ["US-Dvorak", ".", { ctrl: true }, "KeyE"], // would be export
      ["US-Dvorak", "o", {}, "KeyS"], // would be split
      ["US-Dvorak", "b", {}, "KeyN"], // would be toggleSnap
      ["FR-AZERTY", ",", {}, "KeyM"], // would be addMarker
      ["DE-QWERTZ", "y", { ctrl: true }, "KeyZ"], // would be undo
    ];
    for (const [layout, key, mods, code] of traps) {
      expect(resolveChord(kev(key, code, mods), map), `${layout} ${key}`).toBeUndefined();
    }
  });

  it("prefers the layout chord when both it and the position are bound", () => {
    // A Hebrew user who rebinds gets stored what they pressed (chordOf is what
    // the Shortcuts card captures), and that must keep winning.
    const map = new Map<string, ActionId>([["ד", "addMarker"], ["S", "split"]]);
    expect(resolveChord(kev("ד", "KeyS"), map)).toBe("addMarker");
    expect(resolveChord(kev("ז", "KeyS"), map)).toBe("split"); // unbound ז → position
  });
});

describe("blockShortcuts", () => {
  it("blocks while a surface holds a token and clears on release", () => {
    expect(shortcutsBlocked()).toBe(false);
    const release = blockShortcuts();
    expect(shortcutsBlocked()).toBe(true);
    release();
    expect(shortcutsBlocked()).toBe(false);
  });

  it("ref-counts, so an inner surface closing does not unblock an outer one", () => {
    const outer = blockShortcuts();
    const inner = blockShortcuts();
    inner();
    expect(shortcutsBlocked()).toBe(true);
    outer();
    expect(shortcutsBlocked()).toBe(false);
  });

  it("ignores a repeated release, so a double close cannot free someone else", () => {
    // closeMenu() is documented safe to call twice, and the editor's dispose
    // calls it on top of whatever already closed the menu.
    const first = blockShortcuts();
    first();
    first();
    const second = blockShortcuts();
    first();
    expect(shortcutsBlocked()).toBe(true);
    second();
    expect(shortcutsBlocked()).toBe(false);
  });
});
