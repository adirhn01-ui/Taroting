// Focus management for modal dialogs.

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Everything inside `container` the keyboard can actually reach: enabled, and
 *  rendered (a hidden row has no offsetParent). One definition, so the Tab ring
 *  and the focus a dialog opens on can never disagree about what is reachable. */
function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
  );
}

/**
 * Seat focus inside `container`: on the element matching `selector` when one is
 * given and reachable, otherwise on the first focusable element. Returns false
 * when there is nothing to focus.
 *
 * `trapTab` listens on the container, so it only ever sees a keydown while
 * focus is ALREADY inside — which makes this its precondition, not a courtesy.
 * A dialog that opens with focus still on <body>, or one that rewrites its body
 * and destroys the focused node, has no trap at all: Tab walks the screen
 * behind it, and the first Enter lands on whatever it found there.
 */
export function focusFirst(container: HTMLElement, selector?: string): boolean {
  const items = focusables(container);
  const target = (selector ? items.find((el) => el.matches(selector)) : undefined) ?? items[0];
  if (!target) return false;
  target.focus();
  return true;
}

/** Trap Tab / Shift+Tab focus within `container`, wrapping at the ends.
 *  Returns a disposer that removes the listener. */
export function trapTab(container: HTMLElement): () => void {
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const items = focusables(container);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", onKeydown);
  return () => container.removeEventListener("keydown", onKeydown);
}
