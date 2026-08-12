// Keyboard shortcut manager: chord normalization, an action registry bound
// from settings, and focus guards so typing in inputs never triggers edits.

import type { ActionId } from "./types";

/** The parts of a KeyboardEvent a chord is built from. `code` is optional so
 *  plain object literals (tests, the settings capture) still satisfy it. */
export interface ChordSource {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  /** Physical key position, layout-independent — see `physicalChordOf`. */
  code?: string;
}

/** Normalize a KeyboardEvent (or stored string) to a canonical chord like
 *  "Ctrl+Shift+Z", "Space", "ArrowLeft". Order: Ctrl, Alt, Shift, key.
 *
 *  Built from `e.key`, i.e. the character the ACTIVE LAYOUT produces. That is
 *  deliberate and must stay that way: this is also what the Shortcuts card
 *  captures and displays, so a rebind is stored as the label the user pressed.
 *  `physicalChordOf` handles the layouts where that label is unusable. */
export function chordOf(e: ChordSource): string | null {
  const key = normalizeKey(e.key);
  if (!key) return null;
  return joinChord(e, key);
}

function joinChord(e: ChordSource, key: string): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function normalizeKey(key: string): string | null {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "Esc") return "Escape";
  // modifier keys alone never form a chord
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key.length === 1) return key.toUpperCase();
  return key; // ArrowLeft, Delete, Home, F1, …
}

/** `Key<A-Z>` / `Digit<0-9>` — the only `e.code` values that name a key a chord
 *  can be written with. Everything else (Comma, Slash, Backquote, …) is left
 *  alone: its position carries no letter to recover. */
const PHYSICAL_CODE = /^(?:Key([A-Z])|Digit([0-9]))$/;

/**
 * Layout-independent chord from `e.code`, tried ONLY after the `e.key` chord
 * matched no binding.
 *
 * Why it exists: `e.key` is the character the active layout produces, so on a
 * Hebrew or Russian layout every letter binding is dead. Verified against the
 * Win32 layout tables (`ToUnicodeEx` per scancode) and the real defaults: on
 * both layouts ALL TWELVE letter/Ctrl chords produce a chord that matches
 * nothing — S is "ד"/"Ы", Ctrl+Z is "Ctrl+ז"/"Ctrl+Я" — while Space, the arrows,
 * Home/End and Delete keep working, because those `e.key` values are names, not
 * characters. That is the "arbitrarily half-broken" symptom.
 *
 * WHY THE GUARD IS SO NARROW. `e.code` is a physical position, so trusting it
 * whenever the layout chord misses breaks Latin layouts that simply arrange the
 * letters differently: measured against these same tables, an unguarded
 * fallback makes a French AZERTY "," drop a marker (KeyM), German Ctrl+Y undo
 * (KeyZ), and Dvorak Ctrl+, go home (KeyW). Those are silent wrong edits — the
 * exact failure this layer is supposed to prevent.
 *
 * So the fallback is allowed only when the layout produced a NON-ASCII
 * character, which no Latin layout ever does for a letter key and which can
 * therefore never be a Latin binding the user meant. Measured over nine
 * layouts, that recovers 35 of the 36 broken chords and fires zero times on any
 * Latin layout (QWERTY, Dvorak, AZERTY, QWERTZ, Spanish, Turkish-Q).
 *
 * WHAT IT COSTS: the one chord it does not recover. The Hebrew layout puts an
 * ASCII apostrophe on KeyW, so Ctrl+W ("go home") arrives as "Ctrl+'" and stays
 * inert — and it must, because Dvorak's comma sits on that same key and would
 * be sent home instead. An inert key is the mild failure; the wrong edit is not.
 * A Hebrew user who wants it rebinds it, and the Shortcuts card stores and shows
 * "Ctrl+'", which is exactly the key they pressed.
 */
export function physicalChordOf(e: ChordSource): string | null {
  // Named keys (ArrowLeft, Delete, F1, …) are already layout-independent, and a
  // single ASCII character is a label a Latin layout could legitimately mean.
  if (e.key.length !== 1 || e.key.codePointAt(0)! <= 127) return null;
  const m = e.code === undefined ? null : PHYSICAL_CODE.exec(e.code);
  if (!m) return null;
  return joinChord(e, m[1] ?? m[2]!);
}

/** Look an event up in a chord map: what the layout printed first, the physical
 *  position only if that matched nothing. Exported because that ORDER is the
 *  whole fix and `window` does not exist under the node test environment. */
export function resolveChord<T>(e: ChordSource, bindings: ReadonlyMap<string, T>): T | undefined {
  const chord = chordOf(e);
  if (!chord) return undefined;
  const hit = bindings.get(chord);
  if (hit !== undefined) return hit;
  const physical = physicalChordOf(e);
  return physical === null ? undefined : bindings.get(physical);
}

const KEY_ALIASES: Record<string, string> = {
  space: "Space",
  spacebar: "Space",
  esc: "Escape",
  escape: "Escape",
  delete: "Delete",
  del: "Delete",
  backspace: "Backspace",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
};

/** Normalize a user-stored chord string ("ctrl + shift + z" → "Ctrl+Shift+Z"). */
export function normalizeChord(stored: string): string {
  const bits = stored
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const mods = { ctrl: false, alt: false, shift: false };
  let key: string | null = null;
  for (const bit of bits) {
    const low = bit.toLowerCase();
    if (low === "ctrl" || low === "control" || low === "cmd" || low === "meta") mods.ctrl = true;
    else if (low === "alt") mods.alt = true;
    else if (low === "shift") mods.shift = true;
    else if (bit.length === 1) key = bit.toUpperCase();
    else if (KEY_ALIASES[low]) key = KEY_ALIASES[low]!;
    else if (/^f\d{1,2}$/.test(low)) key = low.toUpperCase();
    else key = bit.charAt(0).toUpperCase() + bit.slice(1);
  }
  if (!key) return "";
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Find duplicate bindings in a shortcuts map. Returns conflicting chords. */
export function findConflicts(shortcuts: Record<string, string>): string[] {
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const [action, stored] of Object.entries(shortcuts)) {
    const chord = normalizeChord(stored);
    if (!chord) continue;
    if (seen.has(chord) && seen.get(chord) !== action) conflicts.add(chord);
    seen.set(chord, action);
  }
  return [...conflicts];
}

/** True when the event target is a place where typing is expected. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "range", "button"].includes(type);
  }
  return false;
}

/* ---------------- keyboard ownership ---------------- */

/**
 * How many surfaces currently own the keyboard. While this is above zero every
 * bound chord is inert, app-wide.
 *
 * A REGISTRATION, NOT A SELECTOR. The editor already suppresses chords behind a
 * dialog by looking for `.modal-backdrop`, and that guard had a hole: the
 * context menu builds a `.ctx-menu` with no backdrop, so with a menu open a
 * global shortcut still fired behind it. The worst case was two destructive
 * edits from one intent — right-clicking a lane does not change the selection,
 * so Delete removed the previously selected clip on another lane, invisibly,
 * and the menu's own "Delete layer" then ran as well.
 *
 * Adding `.ctx-menu` to that selector would have fixed today's bug and left the
 * shape of it in place: the guard would still be a list of class names that the
 * next floating surface has to remember to join, in a file that surface knows
 * nothing about. Here the surface declares itself instead — it holds a token for
 * exactly as long as it is open, and the manager consults the count with no idea
 * who is holding it. A new popover cannot forget to be in a list it never sees;
 * it either takes a token or it doesn't.
 *
 * Ref-counted because surfaces nest and close out of order. The token is
 * idempotent so a double release (closeMenu is documented safe to call twice)
 * cannot drop someone else's block.
 *
 * Cost: one integer comparison per BOUND chord press. The selector guard is
 * kept alongside it for the dialogs that still rely on it — see the note at
 * `setSuppressed`.
 */
let blockers = 0;

/** Take the keyboard for as long as a surface is open. Returns the release. */
export function blockShortcuts(): () => void {
  blockers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    blockers = Math.max(0, blockers - 1);
  };
}

/** True while any surface holds a `blockShortcuts` token. */
export function shortcutsBlocked(): boolean {
  return blockers > 0;
}

export type ActionHandler = (e: KeyboardEvent) => void;

/** Binds window keydown to actions according to a (rebindable) chord map. */
export class ShortcutManager {
  private chordToAction = new Map<string, ActionId>();
  private handlers = new Map<ActionId, ActionHandler>();
  private listener: (e: KeyboardEvent) => void;
  /** While this returns true the app's chords are inert. */
  private suppressed: (() => boolean) | null = null;

  constructor() {
    this.listener = (e) => {
      if (isTypingTarget(e.target)) return;
      const action = resolveChord(e, this.chordToAction);
      if (!action) return;
      const handler = this.handlers.get(action);
      if (!handler) return;
      // Checked BEFORE preventDefault so a blocked chord falls through to the
      // browser untouched — that is what lets Space/Enter activate a focused
      // button in an open dialog or context menu instead of being swallowed by
      // a dead binding, and what leaves Escape to the surface's own handler.
      if (shortcutsBlocked() || this.suppressed?.()) return;
      e.preventDefault();
      if (e.repeat && !REPEATABLE.has(action)) return;
      handler(e);
    };
  }

  /** Install a predicate that makes every chord inert while it returns true.
   *  Pass null to clear.
   *
   *  Additive to `blockShortcuts`, not replaced by it: the app's dialogs are
   *  built in half a dozen modules that all mark themselves the same way (a
   *  `.modal-backdrop` element) and none of which expose a close callback to
   *  hang a release token on. A predicate covers them all without a seam in
   *  each. New surfaces should take a token instead — it does not depend on
   *  anyone remembering a class name. */
  setSuppressed(fn: (() => boolean) | null): void {
    this.suppressed = fn;
  }

  setBindings(shortcuts: Record<ActionId, string>): void {
    this.chordToAction.clear();
    for (const [action, stored] of Object.entries(shortcuts) as [ActionId, string][]) {
      const chord = normalizeChord(stored);
      if (chord) this.chordToAction.set(chord, action);
    }
  }

  on(action: ActionId, handler: ActionHandler): void {
    this.handlers.set(action, handler);
  }

  attach(): void {
    window.addEventListener("keydown", this.listener);
  }

  detach(): void {
    window.removeEventListener("keydown", this.listener);
  }
}

const REPEATABLE = new Set<ActionId>(["stepFwd", "stepBack", "jumpFwd", "jumpBack", "undo", "redo"]);
