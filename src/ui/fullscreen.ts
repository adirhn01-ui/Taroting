// Element fullscreen for one surface (the editor's theater today, the viewer
// next): the best-effort request, the late-resolve hand-back, and the
// fullscreenchange bookkeeping, in one place so both behave identically.
//
// SIGNATURE STUB: the body below is a placeholder until the implementation is
// extracted from editor/preview/theater.ts. Nothing calls it yet; theater.ts
// still holds the live code.

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
  _el: HTMLElement,
  _opts: {
    stillWanted(): boolean;
    /** fullscreenchange while stillWanted() && document.fullscreenElement !== el. */
    onLost(): void;
    /** every other fullscreenchange (refit hook). */
    onChange?(): void;
  },
): ElementFullscreen {
  throw new Error("not implemented");
}
