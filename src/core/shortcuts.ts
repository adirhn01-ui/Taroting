// Keyboard shortcut manager: chord normalization, an action registry bound
// from settings, and focus guards so typing in inputs never triggers edits.

import type { ActionId } from "./types";

/** Normalize a KeyboardEvent (or stored string) to a canonical chord like
 *  "Ctrl+Shift+Z", "Space", "ArrowLeft". Order: Ctrl, Alt, Shift, key. */
export function chordOf(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): string | null {
  const key = normalizeKey(e.key);
  if (!key) return null;
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

export type ActionHandler = (e: KeyboardEvent) => void;

/** Binds window keydown to actions according to a (rebindable) chord map. */
export class ShortcutManager {
  private chordToAction = new Map<string, ActionId>();
  private handlers = new Map<ActionId, ActionHandler>();
  private listener: (e: KeyboardEvent) => void;

  constructor() {
    this.listener = (e) => {
      if (isTypingTarget(e.target)) return;
      const chord = chordOf(e);
      if (!chord) return;
      const action = this.chordToAction.get(chord);
      if (!action) return;
      const handler = this.handlers.get(action);
      if (!handler) return;
      e.preventDefault();
      if (e.repeat && !REPEATABLE.has(action)) return;
      handler(e);
    };
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
