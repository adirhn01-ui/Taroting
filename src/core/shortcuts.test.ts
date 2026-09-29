import { afterEach, describe, expect, it, vi } from "vitest";
import { chordOf, conflictingActions, findConflicts, normalizeChord } from "./shortcuts";

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
  it("reports a duplicate once per mode the two actions share", () => {
    // undo and redo live on the editor AND the image screen, so one clash is
    // two conflicts; `ctrl+z` is normalized before comparing; playPause sits
    // alone on its chord and is not reported.
    expect(findConflicts({ undo: "Ctrl+Z", redo: "ctrl+z", playPause: "Space" })).toEqual([
      { chord: "Ctrl+Z", mode: "editor", actions: ["undo", "redo"] },
      { chord: "Ctrl+Z", mode: "image", actions: ["undo", "redo"] },
    ]);
    expect(findConflicts({ undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" })).toEqual([]);
  });

  it("ignores unknown keys, non-string values and unbound actions", () => {
    expect(findConflicts({ a: "Ctrl+Z", b: "ctrl+z", undo: "Ctrl+Z" })).toEqual([]);
    const junk = { undo: 7, redo: "Ctrl+Z" } as unknown as Record<string, string>;
    expect(findConflicts(junk)).toEqual([]);
    expect(findConflicts({ split: "", addMarker: "" })).toEqual([]);
  });

  it("finds nothing in the shipped defaults", () => {
    // Every mode's defaults are conflict-free, although ArrowLeft/ArrowRight and
    // Shift+ArrowLeft/Right each name two actions (one per screen).
    expect(findConflicts(DEFAULT_SHORTCUTS)).toEqual([]);
  });

  it("does not call a chord shared across screens a conflict", () => {
    // jumpFwd (editor) and seekFwd (viewer) share Shift+ArrowRight by design.
    expect(DEFAULT_SHORTCUTS.jumpFwd).toBe(DEFAULT_SHORTCUTS.seekFwd);
    expect(findConflicts({ jumpFwd: "Shift+ArrowRight", seekFwd: "shift+right" })).toEqual([]);
  });

  it("scopes a clash to the screen where it bites", () => {
    // playPause is on the editor and the viewer; nextFile only on the viewer.
    expect(findConflicts({ ...DEFAULT_SHORTCUTS, nextFile: "Space" })).toEqual([
      { chord: "Space", mode: "viewer", actions: ["playPause", "nextFile"] },
    ]);
    // fullscreen (editor + viewer) moved onto ArrowRight clashes with the
    // editor's next frame AND the viewer's next file — two conflicts, each
    // listing its actions in binding order.
    expect(findConflicts({ ...DEFAULT_SHORTCUTS, fullscreen: "ArrowRight" })).toEqual([
      { chord: "ArrowRight", mode: "editor", actions: ["stepFwd", "fullscreen"] },
      { chord: "ArrowRight", mode: "viewer", actions: ["fullscreen", "nextFile"] },
    ]);
  });
});

describe("conflictingActions", () => {
  it("is the union of every conflict's actions", () => {
    const conflicts = findConflicts({ ...DEFAULT_SHORTCUTS, fullscreen: "ArrowRight", split: "M" });
    expect([...conflictingActions(conflicts)].sort()).toEqual(
      ["addMarker", "fullscreen", "nextFile", "split", "stepFwd"].sort(),
    );
    expect(conflictingActions([]).size).toBe(0);
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

import {
  blockShortcuts,
  physicalChordOf,
  REPEATABLE,
  resolveChord,
  ShortcutManager,
  shortcutsBlocked,
} from "./shortcuts";
import { ACTION_MODES, DEFAULT_SHORTCUTS } from "./types";
import type { ActionId, ShortcutMode } from "./types";

/** An event with a physical `code`, as the browser delivers. */
const kev = (
  key: string,
  code: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({ ...ev(key, mods), code });

/** The editor's real bindings, mapped exactly as ShortcutManager("editor").setBindings
 *  does — viewer-only actions (prevFile/nextFile on the bare arrows) are never bound
 *  there. */
const defaults = (): ReadonlyMap<string, readonly ActionId[]> => {
  const m = new Map<string, ActionId[]>();
  for (const [action, stored] of Object.entries(DEFAULT_SHORTCUTS) as [ActionId, string][]) {
    if (!ACTION_MODES[action].includes("editor")) continue;
    const chord = normalizeChord(stored);
    if (chord) m.set(chord, [...(m.get(chord) ?? []), action]);
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
    ];
    for (const [layout, key, mods, code] of traps) {
      expect(resolveChord(kev(key, code, mods), map), `${layout} ${key}`).toBeUndefined();
    }
    // DE-QWERTZ prints "y" on KeyZ. It used to sit in the table above (would be
    // undo); since Ctrl+Y became the alternate redo the LAYOUT chord legitimately
    // resolves — the key says Y, so it redoes. What must still never happen is
    // the physical fallback reading KeyZ as undo.
    expect(resolveChord(kev("y", "KeyZ", { ctrl: true }), map), "DE-QWERTZ y").toBe("redoAlt");
  });

  it("prefers the layout chord when both it and the position are bound", () => {
    // A Hebrew user who rebinds gets stored what they pressed (chordOf is what
    // the Shortcuts card captures), and that must keep winning.
    const map = new Map<string, ActionId[]>([["ד", ["addMarker"]], ["S", ["split"]]]);
    expect(resolveChord(kev("ד", "KeyS"), map)).toBe("addMarker");
    expect(resolveChord(kev("ז", "KeyS"), map)).toBe("split"); // unbound ז → position
  });
});

describe("resolveChord with several actions on one chord", () => {
  const map = new Map<string, ActionId[]>([
    ["ArrowRight", ["stepFwd", "nextFile"]],
    ["ד", ["addMarker"]],
    ["S", ["split"]],
  ]);

  it("takes the first action in list order when every one is accepted", () => {
    expect(resolveChord(kev("ArrowRight", "ArrowRight"), map)).toBe("stepFwd");
  });

  it("skips an action the caller cannot run and takes the next one", () => {
    expect(resolveChord(kev("ArrowRight", "ArrowRight"), map, (a) => a !== "stepFwd")).toBe(
      "nextFile",
    );
    expect(resolveChord(kev("ArrowRight", "ArrowRight"), map, () => false)).toBeUndefined();
  });

  it("tries the position only when nothing on the layout chord is accepted", () => {
    // "ד" is bound, but to an action the caller refuses — so the physical S
    // gets its turn, exactly as if "ד" were unbound.
    expect(resolveChord(kev("ד", "KeyS"), map, (a) => a !== "addMarker")).toBe("split");
    expect(resolveChord(kev("ד", "KeyS"), map, (a) => a === "addMarker")).toBe("addMarker");
  });
});

/* ============================================================================
 * AltGr. Windows reports it as ctrlKey + altKey both down, so without a guard
 * every AltGr-typed character (Polish "ą", German "@" and "€") would build a
 * Ctrl+Alt chord, and the physical fallback would map a non-ASCII one onto a
 * Ctrl+Alt+<letter> binding the user never pressed.
 * ==========================================================================*/

/** An AltGr press as Chromium delivers it on Windows. */
const altgr = (key: string, code: string, shift = false) => ({
  ...kev(key, code, { ctrl: true, alt: true, shift }),
  getModifierState: (k: string) => k === "AltGraph",
});

describe("AltGr", () => {
  it("chords the typed character alone", () => {
    expect(chordOf(altgr("@", "KeyQ"))).toBe("@");
    expect(physicalChordOf(altgr("@", "KeyQ"))).toBeNull();
    // The same event WITHOUT AltGraph is a genuine Ctrl+Alt press and keeps both.
    expect(chordOf(kev("@", "KeyQ", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+@");
    expect(chordOf({ ...kev("@", "KeyQ", { ctrl: true, alt: true }), getModifierState: () => false })).toBe(
      "Ctrl+Alt+@",
    );
  });

  it("drops Shift from a typed character (a documented limitation)", () => {
    // normalizeKey uppercases, so AltGr+A ("ą") and AltGr+Shift+A ("Ą") are the
    // same chord. Pinned so a change to that is a decision, not an accident.
    expect(chordOf(altgr("Ą", "KeyA", true))).toBe("Ą");
    expect(chordOf(altgr("ą", "KeyA"))).toBe("Ą");
    // Without AltGr, today's behaviour stands exactly: Shift is kept on a char.
    expect(chordOf(kev(">", "Period", { shift: true }))).toBe("Shift+>");
  });

  it("keeps the pressed chord on a key AltGr does not map", () => {
    // German AltGr+S types nothing and reports its own "s". Stripping Ctrl+Alt
    // would make it a bare "S" — the split key.
    expect(chordOf(altgr("s", "KeyS"))).toBe("Ctrl+Alt+S");
    expect(chordOf(altgr("S", "KeyS", true))).toBe("Ctrl+Alt+Shift+S");
    expect(chordOf(altgr("1", "Digit1"))).toBe("Ctrl+Alt+1");
    // A typed digit-row character is still the character alone.
    expect(chordOf(altgr("²", "Digit2"))).toBe("²");
  });

  it("keeps the pressed chord on a named key", () => {
    // A named key types nothing, so AltGr has nothing to have produced.
    // (Previously "Shift+ArrowLeft" / "ArrowLeft": Ctrl+Alt was dropped.)
    expect(chordOf(altgr("ArrowLeft", "ArrowLeft", true))).toBe("Ctrl+Alt+Shift+ArrowLeft");
    expect(chordOf(altgr("ArrowLeft", "ArrowLeft"))).toBe("Ctrl+Alt+ArrowLeft");
    expect(chordOf(altgr(" ", "Space"))).toBe("Ctrl+Alt+Space");
  });

  it("never reaches a Ctrl+Alt+<letter> binding through the position", () => {
    // Polish AltGr+A types "ą": non-ASCII on KeyA, which is precisely what the
    // physical fallback would otherwise read as Ctrl+Alt+A.
    const map = new Map<string, ActionId[]>([["Ctrl+Alt+A", ["split"]]]);
    expect(resolveChord(altgr("ą", "KeyA"), map)).toBeUndefined();
    // The guard is AltGr, not the letter: a real Ctrl+Alt on a Cyrillic layout
    // still recovers the position.
    expect(resolveChord(kev("ф", "KeyA", { ctrl: true, alt: true }), map)).toBe("split");
  });

  it("does not turn a bare AltGr press into a chord", () => {
    expect(chordOf(altgr("AltGraph", "AltRight"))).toBeNull();
    expect(chordOf(kev("AltGraph", "AltRight", { ctrl: true, alt: true }))).toBeNull();
  });
});

/* ============================================================================
 * ShortcutManager dispatch, through the REAL keydown listener. Under the node
 * environment there is no `window` and no `HTMLElement`; both are stubbed just
 * far enough for `attach()` to hand the listener over and for
 * `isTypingTarget`'s instanceof to run.
 * ==========================================================================*/

class FakeElement {}

interface Pressed {
  prevented: boolean;
}

function harness(
  mode: ShortcutMode,
  handled: readonly ActionId[],
  shortcuts: Record<ActionId, string> = DEFAULT_SHORTCUTS,
) {
  let listener: ((e: unknown) => void) | null = null;
  vi.stubGlobal("window", {
    addEventListener: (_type: string, fn: (e: unknown) => void) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
  });
  vi.stubGlobal("HTMLElement", FakeElement);
  const fired: ActionId[] = [];
  const manager = new ShortcutManager(mode);
  manager.setBindings(shortcuts);
  for (const a of handled) manager.on(a, () => fired.push(a));
  manager.attach();
  const press = (ev: object, extra: { repeat?: boolean; target?: unknown } = {}): Pressed => {
    const out: Pressed = { prevented: false };
    listener?.({
      target: null,
      repeat: false,
      ...ev,
      ...extra,
      preventDefault() {
        out.prevented = true;
      },
    });
    return out;
  };
  return { fired, press, manager };
}

/** Every action has a handler, as on a screen that implements all of its own. */
const ALL = Object.keys(DEFAULT_SHORTCUTS) as ActionId[];

describe("ShortcutManager dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the editor's ArrowRight steps a frame even with every action handled", () => {
    // The last-wins trap: nextFile comes AFTER stepFwd in key order and shares
    // its chord. Bound into the editor, it would shadow the frame step.
    const h = harness("editor", ALL);
    h.press(kev("ArrowRight", "ArrowRight"));
    h.press(kev("ArrowLeft", "ArrowLeft"));
    h.press(kev("ArrowRight", "ArrowRight", { shift: true }));
    expect(h.fired).toEqual(["stepFwd", "stepBack", "jumpFwd"]);
  });

  it("the viewer's ArrowRight steps a file, and the editor's rows are never bound there", () => {
    const h = harness("viewer", ALL);
    h.press(kev("ArrowRight", "ArrowRight"));
    h.press(kev("ArrowLeft", "ArrowLeft"));
    h.press(kev("ArrowLeft", "ArrowLeft", { shift: true }));
    h.press(kev("ArrowRight", "ArrowRight", { shift: true }));
    // S (split) is an editor action: in the viewer the key is simply unbound.
    const s = h.press(kev("s", "KeyS"));
    expect(h.fired).toEqual(["nextFile", "prevFile", "seekBack", "seekFwd"]);
    expect(s.prevented).toBe(false);
  });

  it("an action with a handler wins over an earlier unhandled one on the same chord", () => {
    // split comes before redoAlt in key order; this screen only runs redoAlt.
    const h = harness("editor", ["redoAlt"], { ...DEFAULT_SHORTCUTS, split: "Ctrl+Y" });
    const p = h.press(kev("y", "KeyY", { ctrl: true }));
    expect(h.fired).toEqual(["redoAlt"]);
    expect(p.prevented).toBe(true);
  });

  it("the first listed action wins when both on a chord are handled", () => {
    const h = harness("editor", ["split", "redoAlt"], { ...DEFAULT_SHORTCUTS, split: "Ctrl+Y" });
    h.press(kev("y", "KeyY", { ctrl: true }));
    expect(h.fired).toEqual(["split"]);
  });

  it("leaves a chord whose actions are all unhandled to the browser", () => {
    const h = harness("editor", ["playPause"]);
    const p = h.press(kev("s", "KeyS"));
    expect(h.fired).toEqual([]);
    expect(p.prevented).toBe(false);
  });

  it("never binds an unbound (empty) chord", () => {
    const h = harness("editor", ALL, { ...DEFAULT_SHORTCUTS, redoAlt: "" });
    const p = h.press(kev("y", "KeyY", { ctrl: true }));
    expect(h.fired).toEqual([]);
    expect(p.prevented).toBe(false);
  });

  it("redoes on Ctrl+Y, and on a Hebrew layout through the position", () => {
    const h = harness("editor", ALL);
    h.press(kev("y", "KeyY", { ctrl: true }));
    h.press(kev("ט", "KeyY", { ctrl: true })); // Hebrew ט sits on KeyY
    expect(physicalChordOf(kev("ט", "KeyY", { ctrl: true }))).toBe("Ctrl+Y");
    expect(h.fired).toEqual(["redoAlt", "redoAlt"]);
  });

  it("an AltGr-typed character never fires a Ctrl+Alt binding", () => {
    const h = harness("editor", ALL, { ...DEFAULT_SHORTCUTS, split: "Ctrl+Alt+A" });
    const p = h.press(altgr("ą", "KeyA"));
    expect(h.fired).toEqual([]);
    expect(p.prevented).toBe(false);
  });

  it("AltGr on an unmapped key neither splits nor breaks a Ctrl+Alt binding", () => {
    // Defaults: S is split. German AltGr+S types nothing — it must stay inert.
    const inert = harness("editor", ALL);
    const p = inert.press(altgr("s", "KeyS"));
    expect(inert.fired).toEqual([]);
    expect(p.prevented).toBe(false);
    vi.unstubAllGlobals();
    // A stored Ctrl+Alt+P still fires if the engine flags the press as AltGraph.
    const bound = harness("editor", ALL, { ...DEFAULT_SHORTCUTS, split: "Ctrl+Alt+P" });
    bound.press(altgr("p", "KeyP"));
    expect(bound.fired).toEqual(["split"]);
  });

  it("stays inert, and does not preventDefault, while blocked or suppressed", () => {
    const h = harness("viewer", ALL);
    const release = blockShortcuts();
    try {
      expect(h.press(kev(" ", "Space")).prevented).toBe(false);
    } finally {
      release();
    }
    let suppressed = true;
    h.manager.setSuppressed(() => suppressed);
    expect(h.press(kev(" ", "Space")).prevented).toBe(false);
    suppressed = false;
    expect(h.press(kev(" ", "Space")).prevented).toBe(true);
    expect(h.fired).toEqual(["playPause"]);
  });

  it("ignores keys typed into a text field", () => {
    const h = harness("viewer", ALL);
    const input = Object.assign(new FakeElement(), {
      isContentEditable: false,
      tagName: "INPUT",
      type: "text",
    });
    const p = h.press(kev("ArrowRight", "ArrowRight"), { target: input });
    expect(h.fired).toEqual([]);
    expect(p.prevented).toBe(false);
  });

  it("repeats a held key only for repeatable actions", () => {
    const h = harness("viewer", ALL);
    h.press(kev("ArrowRight", "ArrowRight"), { repeat: true }); // held: keeps stepping
    const held = h.press(kev("f", "KeyF"), { repeat: true }); // held F: toggles once
    expect(h.fired).toEqual(["nextFile"]);
    // Swallowed rather than handed to the browser, like any bound chord.
    expect(held.prevented).toBe(true);
  });

  it("stops dispatching after detach", () => {
    const h = harness("viewer", ALL);
    h.manager.detach();
    h.press(kev("ArrowRight", "ArrowRight"));
    expect(h.fired).toEqual([]);
  });
});

describe("REPEATABLE", () => {
  it("is exactly the stepping, seeking and undo/redo actions", () => {
    expect([...REPEATABLE].sort()).toEqual(
      [
        "stepFwd", "stepBack", "jumpFwd", "jumpBack", "undo", "redo",
        "redoAlt", "prevFile", "nextFile", "seekBack", "seekFwd",
      ].sort(),
    );
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
