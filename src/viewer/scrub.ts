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

/** A wired track. */
export interface ScrubBinding {
  /** End a drag in progress as if the button were let go (end() runs); a
   *  no-op when nothing is held. The viewer calls it when the media under the
   *  bar goes away, so a held bar never seeks the NEXT file. */
  cancel(): void;
  /** Remove the listeners. */
  dispose(): void;
}

/** Wires the drag on `track`. */
export function bindScrub(track: HTMLElement, h: ScrubHandlers): ScrubBinding {
  let held = false;
  let heldPointer = -1;
  const fromX = (clientX: number): void => {
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return;
    h.at(Math.min(Math.max((clientX - box.left) / box.width, 0), 1));
  };
  const down = (e: PointerEvent): void => {
    if (e.button !== 0 || !h.enabled()) return;
    e.preventDefault();
    held = true;
    heldPointer = e.pointerId;
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
  const release = (pointerId: number): void => {
    if (!held) return;
    held = false;
    try {
      track.releasePointerCapture(pointerId);
    } catch {
      /* not captured */
    }
    h.end?.();
  };
  const up = (e: PointerEvent): void => release(e.pointerId);
  track.addEventListener("pointerdown", down);
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
  return {
    cancel: () => release(heldPointer),
    dispose: () => {
      track.removeEventListener("pointerdown", down);
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
    },
  };
}
