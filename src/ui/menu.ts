// Framework-less context menu. One reused host div on document.body; a single
// menu is open at a time. No editor imports — usable from anywhere.

import { blockShortcuts } from "../core/shortcuts";

export interface MenuItem {
  label: string;
  /** Trusted inline SVG markup (from an icons module, never user text) shown
   *  before the label. */
  icon?: string;
  /** One muted line under the label (plain text, escaped when rendered). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Native tooltip — used to explain why a disabled item can't be chosen. */
  title?: string;
  onSelect(): void;
}

let host: HTMLDivElement | null = null;
let items: MenuItem[] = [];
let activeIndex = -1;
/** Where focus was when the menu opened, so closing can put it back. Captured
 *  only from OUTSIDE the host, so a menu that replaces another menu still
 *  remembers the control the user actually came from. */
let openerFocus: HTMLElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.setAttribute("role", "menu");
  document.body.appendChild(el);
  host = el;
  return el;
}

function isOpen(): boolean {
  return host !== null && host.style.display === "block";
}

function focusableIndices(): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) if (!items[i]!.disabled) out.push(i);
  return out;
}

function setActive(index: number): void {
  if (!host) return;
  activeIndex = index;
  const buttons = host.querySelectorAll<HTMLButtonElement>(".ctx-menu__item");
  buttons.forEach((b, i) => {
    if (i === index) {
      b.classList.add("ctx-menu__item--active");
      b.focus();
    } else {
      b.classList.remove("ctx-menu__item--active");
    }
  });
}

function moveActive(delta: number): void {
  const idxs = focusableIndices();
  if (idxs.length === 0) return;
  const pos = idxs.indexOf(activeIndex);
  const next = pos < 0 ? (delta > 0 ? 0 : idxs.length - 1) : (pos + delta + idxs.length) % idxs.length;
  setActive(idxs[next]!);
}

function select(index: number): void {
  const item = items[index];
  if (!item || item.disabled) return;
  closeMenu();
  item.onSelect();
}

function onKeyDown(e: KeyboardEvent): void {
  if (!isOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeIndex >= 0) select(activeIndex);
  } else if (e.key === "Tab") {
    // Tab dismisses rather than cycling. A context menu is not a dialog and has
    // no business owning the Tab ring; the hole this closes is that Tab used to
    // walk the SCREEN BEHIND an open menu — which is still shortcut-blocked and
    // still swallowing Enter, so the next Enter would fire the menu item while
    // the ring had moved somewhere else entirely.
    e.preventDefault();
    closeMenu();
  }
}

function onOutsidePointerDown(e: PointerEvent): void {
  if (!host) return;
  if (!host.contains(e.target as Node)) closeMenu();
}

function onDismiss(): void {
  closeMenu();
}

/**
 * Released when the menu closes. An open menu is modal in intent — it is the
 * only thing the keyboard is talking to — but it has no `.modal-backdrop`, so
 * the editor's dialog guard did not see it and every global chord still fired
 * behind it. Worst case measured: right-clicking a lane does not change the
 * selection, so Delete removed the previously selected clip on a DIFFERENT lane,
 * invisibly, and the menu's own "Delete layer" then applied as well — two
 * destructive edits and two undos for one intent.
 *
 * A token rather than a class the editor pattern-matches on: this file is the
 * one that knows when a menu is open, so it is the one that should say so.
 * Only the four keys `onKeyDown` handles stay live, which is the point — Escape
 * still closes, the arrows still move the highlight, Enter still selects.
 */
let releaseShortcuts: (() => void) | null = null;

function addListeners(): void {
  // capture phase so an outside pointerdown closes before other handlers run
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("wheel", onDismiss, true);
  window.addEventListener("resize", onDismiss);
  window.addEventListener("blur", onDismiss);
  releaseShortcuts = blockShortcuts();
}

function removeListeners(): void {
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("wheel", onDismiss, true);
  window.removeEventListener("resize", onDismiss);
  window.removeEventListener("blur", onDismiss);
  // Paired with addListeners, which showMenu only calls when nothing was open,
  // so the count cannot drift on a menu that replaces another menu.
  releaseShortcuts?.();
  releaseShortcuts = null;
}

/** A row with an icon and/or a hint: the icon, then the label over a muted
 *  hint line. Only the icon goes in as markup (it is the app's own SVG, never
 *  user text); the label and hint are text nodes, so neither can inject. A row
 *  with neither keeps the plain one-text-node button every other menu uses.
 *  Home's "Open as" dialog wears the same icon/label/hint classes, so the two
 *  choices look the same in both places. */
function renderRich(btn: HTMLButtonElement, item: MenuItem): void {
  btn.classList.add("ctx-menu__item--rich");
  if (item.icon) {
    const ico = document.createElement("span");
    ico.className = "ctx-menu__icon";
    ico.setAttribute("aria-hidden", "true");
    ico.innerHTML = item.icon;
    btn.appendChild(ico);
  }
  const text = document.createElement("span");
  text.className = "ctx-menu__text";
  const label = document.createElement("span");
  label.className = "ctx-menu__label";
  label.textContent = item.label;
  text.appendChild(label);
  if (item.hint) {
    const hint = document.createElement("span");
    hint.className = "ctx-menu__hint";
    hint.textContent = item.hint;
    text.appendChild(hint);
  }
  btn.appendChild(text);
}

/** `flipAboveY`: for a menu anchored to a control, the anchor's top edge. When
 *  the menu does not fit below `y` it opens ABOVE that edge (as native menus
 *  do) instead of being clamped up over the control that opened it. Omitted,
 *  the menu is only clamped into the viewport — every point-anchored menu.
 *  `activateFirst`: a menu button opened from the KEYBOARD (Enter/Space) starts
 *  on its first enabled row, focused, so the next Enter chooses it — as a
 *  native menu button does. A pointer open leaves nothing highlighted. */
export function showMenu(x: number, y: number, menuItems: MenuItem[], flipAboveY?: number, activateFirst = false): void {
  const wasOpen = isOpen();
  // Read before the host is rebuilt below: emptying it drops focus to <body>,
  // so on a menu that replaces another menu there would be nothing left to read.
  const opener = document.activeElement;
  if (opener instanceof HTMLElement && !(host && host.contains(opener))) openerFocus = opener;
  const el = ensureHost();
  items = menuItems;
  activeIndex = -1;

  el.textContent = "";
  menuItems.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-menu__item";
    if (item.danger) btn.classList.add("ctx-menu__item--danger");
    if (item.icon || item.hint) renderRich(btn, item);
    else btn.textContent = item.label;
    if (item.title) btn.title = item.title;
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => select(i));
      btn.addEventListener("pointerenter", () => setActive(i));
    }
    el.appendChild(btn);
  });

  // measure off-screen, then clamp into the viewport
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";
  const rect = el.getBoundingClientRect();
  const pad = 4;
  const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
  const fitsBelow = y + rect.height <= window.innerHeight - pad;
  const want = !fitsBelow && flipAboveY !== undefined ? flipAboveY - rect.height : y;
  const top = Math.max(pad, Math.min(want, window.innerHeight - rect.height - pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  if (!wasOpen) addListeners();
  if (activateFirst) moveActive(1);
}

/**
 * Close the menu and release everything it holds: the buttons, the
 * document-level listeners, and `items` — whose `onSelect` closures capture the
 * screen that opened them.
 *
 * This is also the teardown a screen must call from its own dispose(). The host
 * div lives on document.body, which a route change never touches: clearing the
 * app root leaves an open menu on screen, still listening, its items still
 * pointing at callbacks on the screen the user just left. The next pointerdown
 * anywhere dismisses it, so it is a nuisance rather than a hazard — but it is
 * the same shape as an orphaned dialog and has the same one-line fix.
 *
 * Safe to call when nothing is open, and safe to call twice: removeEventListener
 * on an unregistered handler is a no-op.
 */
export function closeMenu(): void {
  // Ahead of the host check so a call before the first showMenu() still clears
  // state — the guard must never be the reason something stays referenced.
  items = [];
  activeIndex = -1;
  removeListeners();
  const opener = openerFocus;
  openerFocus = null;
  if (!host) return;
  // Asked BEFORE the host is emptied: removing the focused button is itself what
  // drops focus to <body>, so afterwards this is false for every keyboard
  // dismissal — the only case that wants the focus back.
  const hadFocus = host.contains(document.activeElement);
  host.style.display = "none";
  host.textContent = "";
  // Only when the menu was holding focus — which covers keyboard use and the
  // hover highlight (setActive focuses), but leaves a menu that never took it
  // alone. Without this the ring restarted at the top of the document on every
  // dismissal, so Tab after a right-click landed nowhere near the clip.
  //
  // `isConnected` covers the screen having been torn down underneath us.
  // Restored here rather than after `item.onSelect()` deliberately: an item that
  // opens a dialog must be the LAST thing to touch focus, or the dialog's own
  // opening focus is overwritten a moment later.
  if (hadFocus && opener?.isConnected) opener.focus();
}
