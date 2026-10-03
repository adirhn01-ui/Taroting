// Keyboard shortcut manager: chord normalization, an action registry bound
// from settings, and focus guards so typing in inputs never triggers edits.

import { ACTION_MODES, DEFAULT_SHORTCUTS } from "./types";
import type { ActionId, ShortcutMode } from "./types";

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
  /** KeyboardEvent.getModifierState. Optional so plain-object test sources still type-check.
   *  Used ONLY to detect AltGraph (Windows reports AltGr as ctrlKey+altKey both true). */
  getModifierState?(key: string): boolean;
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
  if (isAltGraph(e) && e.key.length === 1 && key !== "Space" && key !== altGraphBase(e)) {
    // AltGr is how a Polish user types "ą" and a German one "@" or "€": a
    // CHARACTER key, not a Ctrl+Alt command. Windows reports it as ctrlKey AND
    // altKey both down, so the plain join would turn every AltGr-typed
    // character into a "Ctrl+Alt+…" chord and AltGr+A would fire a Ctrl+Alt+A
    // binding the user never pressed. The chord is the character alone.
    //
    // ONLY when the layout actually typed something. A key AltGr does not map
    // (German AltGr+S) still reports its own letter, and a named key (arrows,
    // Space, F1) never types anything; stripping those would turn an inert
    // Ctrl+Alt+S into a bare "S" that splits the clip, and would break a stored
    // Ctrl+Alt+P binding if the engine flags a left Ctrl+Alt as AltGraph. Those
    // fall through and keep what was physically pressed.
    //
    // Known limitation: Shift is dropped with Ctrl+Alt. normalizeKey uppercases
    // a single character, so AltGr+A ("ą") and AltGr+Shift+A ("Ą") both chord
    // as "Ą" and cannot be bound separately. Kept deliberately — the Shortcuts
    // card captures through this same function, so what it stores always
    // matches what fires.
    return key;
  }
  return joinChord(e, key);
}

/** The letter/digit printed on the key under an AltGr press, from `e.code`, or
 *  null when the position carries none (Comma, Slash, …). Compared against the
 *  typed character to tell "AltGr produced a character" from "AltGr is mapped
 *  to nothing on this key". */
function altGraphBase(e: ChordSource): string | null {
  const m = e.code === undefined ? null : PHYSICAL_CODE.exec(e.code);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** True while AltGr is held. Only the real KeyboardEvent can say: ctrlKey plus
 *  altKey is also exactly what a genuine Ctrl+Alt press looks like. */
function isAltGraph(e: ChordSource): boolean {
  return e.getModifierState?.("AltGraph") === true;
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
  // Modifier keys alone never form a chord. "AltGraph" is what the AltGr key
  // itself reports; without it a bare AltGr press in the Shortcuts capture
  // would be stored as a binding instead of waiting for the key it modifies.
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(key)) return null;
  // "+" is the chord separator, so it cannot also be the key: "Ctrl++" splits
  // into nothing but the modifier, and normalizeChord read that as "deliberately
  // unbound" — rebinding Zoom in to the numpad + (or the German + key) silently
  // erased the action's chord. The key is spelled out instead.
  if (key === "+") return "Plus";
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
  // Under AltGr the Ctrl+Alt the OS reports is not a command. Where the layout
  // typed a character, reading the position would hand AltGr+A ("ą",
  // non-ASCII) to a Ctrl+Alt+A binding; an unmapped or named key is ASCII or a
  // name and would stop at the check below anyway.
  if (isAltGraph(e)) return null;
  // Named keys (ArrowLeft, Delete, F1, …) are already layout-independent, and a
  // single ASCII character is a label a Latin layout could legitimately mean.
  if (e.key.length !== 1 || e.key.codePointAt(0)! <= 127) return null;
  const m = e.code === undefined ? null : PHYSICAL_CODE.exec(e.code);
  if (!m) return null;
  return joinChord(e, m[1] ?? m[2]!);
}

/** e.key chord first; the physical chord only if the e.key chord yields no
 *  ACCEPTED action. Within one chord the FIRST accepted action in list order
 *  wins. Exported because that ORDER is the whole fix and `window` does not
 *  exist under the node test environment.
 *
 *  A LIST per chord plus `accept`, because one chord can legitimately name
 *  several actions. With one action per chord the row written LAST simply won,
 *  so an action the screen had no handler for could shadow one it had, and the
 *  key went silently dead. Asking "which of these can you run?" instead of
 *  "who was written last?" removes that by construction. */
export function resolveChord<T>(
  e: ChordSource,
  bindings: ReadonlyMap<string, readonly T[]>,
  accept: (t: T) => boolean = () => true,
): T | undefined {
  const chord = chordOf(e);
  if (!chord) return undefined;
  const hit = firstAccepted(bindings.get(chord), accept);
  if (hit !== undefined) return hit;
  const physical = physicalChordOf(e);
  return physical === null ? undefined : firstAccepted(bindings.get(physical), accept);
}

function firstAccepted<T>(list: readonly T[] | undefined, accept: (t: T) => boolean): T | undefined {
  if (list) for (const t of list) if (accept(t)) return t;
  return undefined;
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
  plus: "Plus",
};

/** Normalize a user-stored chord string ("ctrl + shift + z" → "Ctrl+Shift+Z"). */
export function normalizeChord(stored: string): string {
  // A trailing "+" that follows another "+" (or stands alone) is the plus KEY,
  // as chordOf wrote it before it learned to say "Plus": "Ctrl++" was stored by
  // every earlier build, and reading it as the key here migrates those strings
  // instead of leaving the action unbound.
  const trimmed = stored.trim();
  const plusKey = trimmed === "+" || /\+\s*\+$/.test(trimmed);
  const bits = (plusKey ? trimmed.slice(0, -1) : trimmed)
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
  if (plusKey) key = "Plus";
  if (!key) return "";
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Every ShortcutMode, once. A Record so the compiler demands an entry when a
 *  mode is added: a mode missing here would silently never report a conflict. */
const MODE_SET: Record<ShortcutMode, true> = { editor: true, viewer: true, image: true };
const MODES = Object.keys(MODE_SET) as ShortcutMode[];

/** One chord bound to two or more actions that share a screen. */
export interface ShortcutConflict {
  chord: string;
  mode: ShortcutMode;
  actions: ActionId[];
}

/** Duplicate chords among actions that share a mode. Unknown keys ignored.
 *
 *  Per MODE, because a chord is only ambiguous where both of its actions can
 *  fire: ArrowRight is the editor's next frame and the viewer's next file, which
 *  is two screens with one meaning each, not a clash. Actions are walked in
 *  DEFAULT_SHORTCUTS key order (the binding order), so `actions` lists them in
 *  the order a ShortcutManager would try them. */
export function findConflicts(shortcuts: Record<string, string>): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  for (const mode of MODES) {
    const byChord = new Map<string, ActionId[]>();
    for (const action of Object.keys(DEFAULT_SHORTCUTS) as ActionId[]) {
      if (!ACTION_MODES[action].includes(mode)) continue;
      const stored = shortcuts[action];
      if (typeof stored !== "string") continue;
      const chord = normalizeChord(stored);
      if (!chord) continue;
      const group = byChord.get(chord);
      if (group) group.push(action);
      else byChord.set(chord, [action]);
    }
    for (const [chord, actions] of byChord) {
      if (actions.length >= 2) conflicts.push({ chord, mode, actions });
    }
  }
  return conflicts;
}

/** Every action named in any conflict (per-row marking in Settings). */
export function conflictingActions(conflicts: readonly ShortcutConflict[]): Set<ActionId> {
  const out = new Set<ActionId>();
  for (const c of conflicts) for (const a of c.actions) out.add(a);
  return out;
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
  /** chord → this mode's actions on it, in DEFAULT_SHORTCUTS key order. */
  private chordToActions = new Map<string, ActionId[]>();
  private handlers = new Map<ActionId, ActionHandler>();
  private listener: (e: KeyboardEvent) => void;
  /** While this returns true the app's chords are inert. */
  private suppressed: (() => boolean) | null = null;
  /** The screen this manager serves; only actions whose ACTION_MODES row names
   *  it are ever bound. */
  private readonly mode: ShortcutMode;

  constructor(mode: ShortcutMode) {
    this.mode = mode;
    this.listener = (e) => {
      if (isTypingTarget(e.target)) return;
      // Only an action this screen can actually run counts as a match. A chord
      // whose actions are all unhandled resolves to nothing, and the key falls
      // through to the browser untouched exactly as an unbound one does.
      const action = resolveChord(e, this.chordToActions, (a) => this.handlers.has(a));
      if (!action) return;
      const handler = this.handlers.get(action)!;
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

  /** Binds ONLY actions whose ACTION_MODES include the mode; chord → ActionId[] in
   *  DEFAULT_SHORTCUTS key order. Dispatch fires the first listed action that has a handler. */
  setBindings(shortcuts: Record<ActionId, string>): void {
    this.chordToActions.clear();
    // Walked over the KNOWN actions in declared order, not over the map's own
    // entries: the map is user data (settings.json, typed by a cast), so its key
    // order is whatever was last written and it may name actions that do not
    // exist. Declared order is what gives "first listed wins" a fixed meaning.
    for (const action of Object.keys(DEFAULT_SHORTCUTS) as ActionId[]) {
      // Only this screen's actions. The editor and the viewer give ArrowLeft /
      // ArrowRight different meanings (frame step vs previous/next file); the
      // other screen's action has no business being tried here at all.
      if (!ACTION_MODES[action].includes(this.mode)) continue;
      const stored = shortcuts[action];
      if (typeof stored !== "string") continue;
      const chord = normalizeChord(stored);
      if (!chord) continue; // "" = deliberately unbound
      const list = this.chordToActions.get(chord);
      if (list) list.push(action);
      else this.chordToActions.set(chord, [action]);
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

/** Actions a HELD key keeps firing; everything else fires once per press (a
 *  held S must not split at every frame it passes). The viewer's file stepping
 *  and seeking repeat like the editor's frame stepping; the alternate redo
 *  repeats like redo; the image editor's brush size and zoom step like a
 *  slider held by its key. Exported only so the membership is testable. */
export const REPEATABLE: ReadonlySet<ActionId> = new Set<ActionId>([
  "stepFwd",
  "stepBack",
  "jumpFwd",
  "jumpBack",
  "undo",
  "redo",
  "redoAlt",
  "prevFile",
  "nextFile",
  "seekBack",
  "seekFwd",
  "imgSizeDown",
  "imgSizeUp",
  "imgZoomIn",
  "imgZoomOut",
]);
