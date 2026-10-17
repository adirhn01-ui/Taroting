// The theater bar's drag on a track: down + every move while held, pointer
// capture keeping the drag alive off the thin track. One copy, shared by the
// viewer's seek bar and the PDF page scrubber (pdf-mode.ts), so the two feel
// the same under the mouse.

export interface ScrubHandlers {
  /** May a drag start now (left button already checked)? */
  enabled(): boolean;
  /** The pointer is at this fraction of the track (0..1, clamped). */
  at(ratio: number): void;
  /** A drag began / ended (the viewer holds its chrome up meanwhile). */
  start?(): void;
  end?(): void;
}

/** Wires the drag on `track`; returns the unbind. */
export function bindScrub(track: HTMLElement, h: ScrubHandlers): () => void {
  let held = false;
  const fromX = (clientX: number): void => {
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return;
    h.at(Math.min(Math.max((clientX - box.left) / box.width, 0), 1));
  };
  const down = (e: PointerEvent): void => {
    if (e.button !== 0 || !h.enabled()) return;
    e.preventDefault();
    held = true;
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer (autotest): listeners still fire on the element */
    }
    h.start?.();
    fromX(e.clientX);
  };
  const move = (e: PointerEvent): void => {
    if (held) fromX(e.clientX);
  };
  const up = (e: PointerEvent): void => {
    if (!held) return;
    held = false;
    try {
      track.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    h.end?.();
  };
  track.addEventListener("pointerdown", down);
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
  return () => {
    track.removeEventListener("pointerdown", down);
    track.removeEventListener("pointermove", move);
    track.removeEventListener("pointerup", up);
    track.removeEventListener("pointercancel", up);
  };
}
