// Temporary (quick-view) projects: the one "Keep temporary project?" prompt,
// what Keep and Discard actually do to the session and its scratch file, and
// the leave gate every exit from a temp project goes through.
//
// A temp session lives in tmp-projects, which startup cleanup sweeps, so ANY
// route away from it must offer keep-or-discard first — Back, Ctrl+W, the
// Settings gear, an OS "open with" from File Explorer (through
// `session.leaveGuard`), and the window close when the project was edited.
// Keep on the editor's Temporary badge is the one way to settle it without
// leaving; it uses `keepTempSession` below directly. Every exit goes
// through ONE gate, so the guard cannot be applied to three exits and forgotten
// on the fourth (the v0.7.3 quick-view gap was exactly that).

import { describeError, ipc } from "../core/ipc";
import { isTempProjectPath } from "../core/open-media";
import type { ProjectSession } from "../core/session";
import { focusFirst, trapTab } from "./focus";
import { icon } from "./icons";
import { toast } from "./toast";

export type KeepChoice = "keep" | "discard" | "cancel";

/** The one "Keep temporary project?" modal: .modal-backdrop + trapTab + focus on Keep;
 *  Esc, backdrop and X = cancel; trap released and capture keydown removed on EVERY close path.
 *  Resolves exactly once. Discard is a plain .btn, never .btn--danger. */
export function askKeepTemp(): Promise<KeepChoice> {
  return new Promise<KeepChoice>((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Keep temporary project?">
        <div class="modal__header"><span>Keep temporary project?</span><button class="btn btn--ghost btn--icon btn--sm" data-act="cancel" title="Cancel" aria-label="Cancel">${icon("x", 14)}</button></div>
        <div class="modal__body">
          <div class="modal__text">This is a temporary project and isn't in your library yet. Keep it, or discard it? Discarding removes only this temporary copy — your media file is untouched.</div>
        </div>
        <div class="modal__footer">
          <button class="btn" data-act="discard">Discard</button>
          <button class="btn btn--primary" data-act="keep">Keep project</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const releaseTrap = trapTab(backdrop);
    let closed = false;
    // Every exit — X, Escape, a click on the backdrop, Keep, Discard — funnels
    // through here, which is what keeps the trap and the capture listener from
    // being released on some paths and not others, and the promise from
    // resolving twice.
    const close = (choice: KeepChoice): void => {
      if (closed) return;
      closed = true;
      releaseTrap();
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(choice);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        close("cancel");
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close("cancel");
    });
    backdrop.querySelector('[data-act="cancel"]')!.addEventListener("click", () => close("cancel"));
    backdrop.querySelector('[data-act="keep"]')!.addEventListener("click", () => close("keep"));
    backdrop.querySelector('[data-act="discard"]')!.addEventListener("click", () => close("discard"));
    // Deferred a frame so the modal is laid out (focusFirst skips anything with
    // no offsetParent). Keep is the safe default here: Enter keeps the work.
    requestAnimationFrame(() => focusFirst(backdrop, '[data-act="keep"]'));
  });
}

/** ipc.newProjectPath(session.project.name) → session.relocate(dest) → session.temp.set(false)
 *  → best-effort ipc.deleteProject(old temp path). Returns dest. Throws on failure: the session
 *  is then still temp at its old path. */
export async function keepTempSession(session: ProjectSession): Promise<string> {
  const oldPath = session.path;
  const dest = await ipc.newProjectPath(session.project.name);
  // relocate() moves autosave to `dest` and writes there, coalescing with any
  // write still in flight to the temp path — edits made during it included. So
  // the permanent file holds everything, and every LATER autosave (and the
  // dispose flush) lands there too rather than in the doomed scratch file.
  // saveProject upserts recents + the thumbnail for a non-temp path, exactly as
  // the old save-until-stable loop did.
  await session.relocate(dest);
  session.temp.set(false);
  // The scratch .trt is nobody's path any more. Fail-soft: a locked file is
  // swept by the next startup's temp-dir cleanup.
  try {
    await ipc.deleteProject(oldPath);
  } catch {
    // left for the startup sweep
  }
  return dest;
}

/** session.discard() FIRST (so no flush resurrects the file), then best-effort
 *  ipc.deleteProject(session.path) — ONLY when that path is inside the temp-projects dir.
 *  Never throws. */
export async function discardTempSession(session: ProjectSession): Promise<void> {
  // discard() runs FIRST so the editor's dispose flush (which targets this same
  // temp path) can't resurrect the file after we delete it. deleteProject
  // fail-softs: a locked file is caught by startup cleanup. The media original
  // is never touched — only the throwaway .trt (+ its .bak) go. No recents
  // entry exists for a temp path, so deleteProject's recents-retain is a
  // harmless no-op.
  session.discard();
  // The path is read once, right after the session stops, and only a path
  // inside tmp-projects is ever deleted. A Keep that already relocated this
  // session (a badge Keep, or a gate's Keep racing a close-time discard) has
  // moved it into the library, and deleting THAT would undo the Keep and lose
  // the user's project. The guard lives here, not in the callers, so every
  // discard gets it. An unknown temp dir answers "not temp": the file is left
  // for the startup sweep rather than risked.
  const path = session.path;
  try {
    if (!(await isTempProjectPath(path))) return;
    await ipc.deleteProject(path);
  } catch {
    // Fail-soft: the temp file stays for the next startup's temp-dir sweep.
  }
}

export interface TempLeaveGate {
  /** Busy → onCancel. Not temp, or already discarded → dest() now. Temp and never
   *  edited → discardTempSession → dest, without asking. Temp and edited →
   *  askKeepTemp():keep → keepTempSession → dest; discard → discardTempSession →
   *  dest; cancel, re-entrancy bail, or keep failure (toast) → onCancel. EXACTLY ONE
   *  of dest/onCancel fires, on every path. */
  confirmLeave(dest: () => void, onCancel?: () => void): void;
  /** Same as a promise (for session.leaveGuard and the close gate): true = proceed. */
  confirm(): Promise<boolean>;
  /** True from modal open until keep/discard settles (the old `keeping` latch).
   *  Checked before the temp flag, so no exit slips through mid-Keep. */
  readonly busy: boolean;
}

export function createTempLeaveGate(session: ProjectSession): TempLeaveGate {
  return createTempLeaveGateWith(session, askKeepTemp);
}

/** The gate with its prompt injected, so the decision logic is testable under
 *  vitest's node environment (no DOM, no modal). `createTempLeaveGate` is this
 *  with `askKeepTemp`. */
export function createTempLeaveGateWith(
  session: ProjectSession,
  ask: () => Promise<KeepChoice>,
): TempLeaveGate {
  // `busy` guards the WHOLE leave lifecycle — from opening the prompt until
  // Keep or Discard has fully settled. It is checked FIRST, before the temp
  // flag, because Keep drops that flag mid-flight (relocate done, the scratch
  // file's delete still awaited): an exit landing in that window saw a
  // permanent session, passed straight through, and then Keep's own dest()
  // navigated over it — an OS open lost to a second navigation home. Released
  // on cancel and on a failed Keep (the user stays, and may try again), and
  // once Keep or Discard completes.
  //
  // `discarded` is what a FINISHED Discard leaves behind: nothing is left to
  // lose, so every later exit passes straight through. It must not stay
  // latched instead. The Discard's own dest() is not always a navigation
  // already under way: an OS open asks this gate before it probes the file,
  // and a corrupt file then toasts and stays — and a latched gate would have
  // left the user in an editor whose edits are silently dropped (the session
  // is disposed), with Back, Ctrl+W, the gear and the window close all inert.
  // A Discard still in progress is covered by `busy` and bails.
  let busy = false;
  let discarded = false;

  // `onCancel` MUST fire on every path that does not reach `dest()`, including
  // the re-entrancy bail: an OS open-path request awaits this decision through
  // `session.leaveGuard`, and a promise that never settles would stall the open
  // queue for the rest of the session.
  const confirmLeave = (dest: () => void, onCancel?: () => void): void => {
    if (busy) {
      onCancel?.();
      return;
    }
    if (discarded || !session.temp.get()) {
      // Synchronous: a throw here reaches the caller's own stack, and no latch
      // has been taken that it could strand.
      dest();
      return;
    }
    busy = true;
    // run() cannot reject on its own; only a throwing callback can make it.
    // Reported, not left as an unhandled rejection — by then the latch is
    // already released (see run's `finally`).
    void run(dest, onCancel).catch((e: unknown) => {
      console.error("A temporary-project exit callback threw", e);
    });
  };

  const run = async (dest: () => void, onCancel?: () => void): Promise<void> => {
    let proceed = false;
    try {
      let choice: KeepChoice;
      if (!session.edited) {
        // Nothing of the user's is in it: no question, the scratch copy just
        // goes — the rule the window close already follows (core/app-close
        // decideClose). Back, Ctrl+W, the gear and an OS open used to ask
        // even about a project nobody had touched.
        choice = "discard";
      } else {
        try {
          choice = await ask();
        } catch {
          // A prompt that could not even be shown is a cancel: stay, nothing lost.
          choice = "cancel";
        }
      }
      if (choice === "keep") {
        try {
          await keepTempSession(session);
          proceed = true;
        } catch (e) {
          // stay in the editor so the work isn't lost silently
          toast.error(`Couldn't save this project: ${describeError(e)}`);
        }
      } else if (choice === "discard") {
        await discardTempSession(session);
        discarded = true;
        proceed = true;
      }
    } finally {
      // ONE exit for every outcome, and the latch is released BEFORE either
      // callback runs: whatever throws — a toast with no DOM, a caller's
      // dest or onCancel — exactly one of them has still fired, and the gate
      // is never left latched with a confirm() waiting on it forever.
      busy = false;
      if (proceed) dest();
      else onCancel?.();
    }
  };

  return {
    confirmLeave,
    confirm: () =>
      new Promise<boolean>((resolve) =>
        confirmLeave(
          () => resolve(true),
          () => resolve(false),
        ),
      ),
    get busy() {
      return busy;
    },
  };
}

export type KeepInPlaceResult = "kept" | "failed" | "ignored";

/** The leave gate plus Keep WITHOUT leaving (the editor's Temporary badge). */
export interface TempExits {
  /** The gate's confirmLeave, run only once any in-place Keep has settled.
   *  EXACTLY ONE of dest/onCancel fires, as with the gate itself. */
  confirmLeave(dest: () => void, onCancel?: () => void): void;
  /** Same as a promise (session.leaveGuard, the close gate): true = proceed. */
  confirm(): Promise<boolean>;
  /** keepTempSession + a toast either way. "ignored" (nothing done) while
   *  another Keep runs, while the gate's prompt is open or resolving, or once
   *  the session is no longer temp. Never rejects. */
  keep(): Promise<KeepInPlaceResult>;
}

/**
 * Put an in-place Keep and the leave gate behind ONE latch.
 *
 * Without it, an exit landing while a badge Keep is still relocating (Back, an
 * OS open, the window close) reaches the gate with the gate idle and the
 * session still temp — so it prompts AGAIN, and a second Keep relocates from
 * where the first had already moved autosave and deletes the FIRST kept file
 * as its "scratch" file. So every exit waits for the Keep: after a successful
 * one the gate sees a permanent session and passes straight through; after a
 * failed one it asks as usual. And the badge does nothing while the gate is
 * deciding (its own Keep or Discard is settling this project's fate).
 */
export function createTempExits(session: ProjectSession, gate: TempLeaveGate): TempExits {
  let keeping: Promise<KeepInPlaceResult> | null = null;

  const confirmLeave = (dest: () => void, onCancel?: () => void): void => {
    if (keeping) {
      // Reported like the gate's own callback throws, never left unhandled.
      void keeping
        .then(() => gate.confirmLeave(dest, onCancel))
        .catch((e: unknown) => console.error("A temporary-project exit callback threw", e));
    } else gate.confirmLeave(dest, onCancel);
  };

  return {
    confirmLeave,
    confirm: () =>
      new Promise<boolean>((resolve) =>
        confirmLeave(
          () => resolve(true),
          () => resolve(false),
        ),
      ),
    keep() {
      if (keeping || gate.busy || !session.temp.get()) return Promise.resolve("ignored");
      // A toast that throws must neither strand the latch nor turn a finished
      // Keep into a rejection, hence the try around each.
      const run = keepTempSession(session)
        .then(
          (): KeepInPlaceResult => {
            try {
              toast.info("Kept in your library.");
            } catch {
              // the Keep itself is done
            }
            return "kept";
          },
          (e: unknown): KeepInPlaceResult => {
            // Still temp at its old path: the user can try again, or leave
            // through the prompt.
            try {
              toast.error(`Couldn't keep this project: ${describeError(e)}`);
            } catch {
              // nothing more to report it with
            }
            return "failed";
          },
        )
        .finally(() => {
          keeping = null;
        });
      keeping = run;
      return run;
    },
  };
}

/** Close-gate modal. `message` is the first line; buttons [Stay] (focused) [Close anyway].
 *  true = close anyway. */
export function askCloseAnyway(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Close Taroting?">
        <div class="modal__header"><span>Close Taroting?</span><button class="btn btn--ghost btn--icon btn--sm" data-act="stay" title="Stay" aria-label="Stay">${icon("x", 14)}</button></div>
        <div class="modal__body">
          <div class="modal__text"></div>
        </div>
        <div class="modal__footer">
          <button class="btn" data-act="close">Close anyway</button>
          <button class="btn btn--primary" data-act="stay">Stay</button>
        </div>
      </div>`;
    // textContent, not markup: the message is plain copy from the caller.
    backdrop.querySelector(".modal__text")!.textContent = message;
    document.body.appendChild(backdrop);

    const releaseTrap = trapTab(backdrop);
    let closed = false;
    // One exit for every path (X, Escape, backdrop, Stay, Close anyway), as in
    // askKeepTemp. Anything that is not an explicit "Close anyway" stays.
    const finish = (closeAnyway: boolean): void => {
      if (closed) return;
      closed = true;
      releaseTrap();
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(closeAnyway);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) finish(false);
    });
    for (const b of backdrop.querySelectorAll('[data-act="stay"]')) {
      b.addEventListener("click", () => finish(false));
    }
    backdrop.querySelector('[data-act="close"]')!.addEventListener("click", () => finish(true));
    // Focus Stay, never the button that loses work: a stray Enter must keep the
    // window open (the home delete dialog's rule for its destructive confirm).
    requestAnimationFrame(() => focusFirst(backdrop, '.modal__footer [data-act="stay"]'));
  });
}
