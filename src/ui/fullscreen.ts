// Element fullscreen for one surface (the editor's theater today, the viewer
// next): the best-effort request, the late-resolve hand-back, and the
// fullscreenchange bookkeeping, in one place so both behave identically.
//
// Best-effort by design. requestFullscreen rejects without user activation (the
// in-app E2E, a synthetic key), so the caller's in-window layout must already
// be the whole mode; true fullscreen only enlarges it. Nothing is registered
// until request(), and release() takes it all back, so an unused surface
// carries no listener.

export interface ElementFullscreen {
  /** Best-effort requestFullscreen on `el` (rejection swallowed: no user activation in tests).
   *  Attaches the fullscreenchange listener. If the request RESOLVES after stillWanted() turned
   *  false (fast F→Esc), fullscreen is handed straight back. */
  request(): void;
  /** Leave element fullscreen iff `el` holds it; detach the listener. Idempotent. */
  release(): void;
  holds(): boolean;
  dispose(): void;
}

export function elementFullscreen(
  el: HTMLElement,
  opts: {
    stillWanted(): boolean;
    /** fullscreenchange while stillWanted() && document.fullscreenElement !== el. */
    onLost(): void;
    /** every other fullscreenchange (refit hook). */
    onChange?(): void;
  },
): ElementFullscreen {
  let listening = false;

  // OS-level Esc leaves element fullscreen but not the caller's in-window
  // layer; this catches the resulting fullscreenchange and lets the caller
  // finish its teardown, so the two never desync. Either direction (gain OR
  // lose fullscreen) resizes the element, so every other change is a refit.
  const onFsChange = (): void => {
    // Exact-element, not merely "any fullscreen": in the rejected-request
    // fallback no fullscreenchange ever fires for US, so an event that arrives
    // while we are wanted is either our own element changing state or another
    // element taking the screen — and the caller should stand down for both
    // departures. Today no other element CAN enter fullscreen (the pooled
    // videos carry no `controls` attribute), so the distinction is free
    // future-proofing, not a behaviour change.
    if (opts.stillWanted() && document.fullscreenElement !== el) opts.onLost();
    else opts.onChange?.();
  };

  const detach = (): void => {
    if (!listening) return;
    listening = false;
    document.removeEventListener("fullscreenchange", onFsChange);
  };

  const release = (): void => {
    // Detach first: the exit below fires one more fullscreenchange, and it
    // belongs to a surface that has already stood down.
    detach();
    // Only ever leave fullscreen WE hold. Nothing else can be fullscreen
    // today, but a release must never pull the screen out from under an
    // element this surface did not put there.
    if (document.fullscreenElement === el) document.exitFullscreen?.().catch(() => {});
  };

  return {
    request(): void {
      // Idempotent attach: a second request() must not bind a second listener
      // (onLost would then fire twice for one Esc).
      if (!listening) {
        listening = true;
        document.addEventListener("fullscreenchange", onFsChange);
      }
      const rf = el.requestFullscreen?.();
      if (!rf) return;
      rf.then(
        () => {
          // Resolved after the caller already stood down (a fast F→Esc): the
          // fullscreen element is not populated until the OS transition
          // completes, so release()'s own check read null and could not undo a
          // transition that had not landed — and it had already detached the
          // listener, so nothing else will. The window is fullscreen with
          // nothing over it; hand it back. `stillWanted()` alone is the right
          // predicate — if a NEW session has started meanwhile, fullscreen is
          // wanted, whoever requested it.
          if (!opts.stillWanted()) document.exitFullscreen?.().catch(() => {});
        },
        () => {},
      );
    },
    release,
    holds: (): boolean => document.fullscreenElement === el,
    dispose: release,
  };
}
