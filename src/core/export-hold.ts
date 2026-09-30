// What a running export holds on the rest of the app: the leave block that
// makes an OS open refuse, and the close task that stops the encoder when the
// window closes. Its own module (not core/app-close, which loads at boot)
// because only the two export dialogs use it — each in its own lazy chunk —
// so a launch that never exports never parses it.

/** The reason a running export gives for refusing a navigation it did not
 *  start (an OS open from File Explorer). Also the close gate's cue. */
export const EXPORT_RUNNING_REASON = "An export is running.";

export interface ExportRunHold {
  /** An export run started: refuse outside navigations and make the window
   *  close cancel it. Idempotent. */
  hold(): void;
  /** The run reached a terminal state (done, failed, canceled, dialog gone).
   *  Idempotent: a cancel reaches both the cancel path and the canceled-failure
   *  event, and both release. */
  release(): void;
}

/**
 * What a running export holds on the rest of the app, as one pair so every
 * terminal path releases exactly what the start took.
 *
 * `session.blockLeave` makes an OS open refuse (with a toast) instead of
 * tearing the editor — and this dialog, parked on document.body — down under a
 * running ffmpeg. The close task makes a window close stop the export instead
 * of leaving the encoder writing a `.part` nobody will ever publish. Either one
 * left behind after the run is its own bug: a stale block refuses every later
 * open for the rest of the session, a stale task cancels a job id that may by
 * then belong to something else.
 *
 * Release clears the block only while it is still OURS: it never clobbers a
 * reason something else set.
 */
export function createExportRunHold(
  session: { blockLeave: string | null },
  register: (task: () => void | Promise<void>) => () => void,
  cancel: () => void | Promise<void>,
): ExportRunHold {
  let unregister: (() => void) | null = null;
  return {
    hold() {
      session.blockLeave = EXPORT_RUNNING_REASON;
      if (unregister === null) unregister = register(cancel);
    },
    release() {
      if (session.blockLeave === EXPORT_RUNNING_REASON) session.blockLeave = null;
      if (unregister !== null) {
        const u = unregister;
        unregister = null;
        u();
      }
    },
  };
}
