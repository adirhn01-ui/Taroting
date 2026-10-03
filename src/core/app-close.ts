// The window-close gate: every close request (X, Alt+F4, taskbar) runs one
// flow that keeps, discards, flushes or asks before the window goes, and
// never leaves the window unclosable (every wait is capped). It also owns the
// one "flush, or ask" rule that every exit from a permanent project shares
// (`flushOrAsk`), and the leave check an OS open runs before replacing the
// screen (`confirmLeaveCurrentSession`).
//
// Why a flow at all: the editor's own exits (Back, Ctrl+W, the gear) run its
// teardown, which ends in the final save and the keep/discard prompt. Closing
// the window runs NONE of that — the process simply ends — so without this an
// edit made in the last autosave interval was lost, and an edited temporary
// project went to the next start's temp sweep without the user ever being
// asked about it.

import { ipc, onCloseRequested } from "./ipc";
import { TEARDOWN_WAIT_MS, isTempProjectPath } from "./open-media";
import {
  currentSession,
  leaveBlockedReason,
  settingsWritesSettled,
  type ProjectSession,
} from "./session";
// ../ui/temp-project (the Keep question, "close anyway?", the scratch-file
// discard) is imported where it is used, never at the top: this module is in
// the boot chunk, and those dialogs are needed only once a close actually
// asks or discards. The editors import it statically, so it is normally
// already loaded by then.

export type CloseDecision = "destroy" | "flush" | "discard" | "prompt" | "export";

/** Pure. no session → destroy; blocked → export; temp && edited → prompt;
 *  temp && !edited → discard; permanent → flush. */
export function decideClose(s: {
  hasSession: boolean;
  temp: boolean;
  edited: boolean;
  blocked: boolean;
}): CloseDecision {
  if (!s.hasSession) return "destroy";
  // Blocked beats temp: a running export is asked about FIRST, and the flow
  // then falls through to what the session itself needs (see runCloseFlow).
  if (s.blocked) return "export";
  if (s.temp) return s.edited ? "prompt" : "discard";
  return "flush";
}

export interface CloseDeps {
  session(): ProjectSession | null;
  /** resolves once go()'s in-flight dispose (if any) has finished */
  settle(): Promise<void>;
  destroy(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

// Every wait below is bounded, and each bound is chosen so the longest stretch
// in which X visibly does nothing stays near seven seconds: a screen still
// closing (at most TEARDOWN_WAIT_MS, the same bound a navigation waits), OR a
// flush (FLUSH_CAP_MS) — after either cap the user is ASKED, never closed on
// silently — then the close tasks and the settings queue (1.5 s each). A hung
// disk costs a pause and a question; it never makes the window unclosable.

/** A final save that has not landed by now is asked about ("still being saved"): the user decides. */
const FLUSH_CAP_MS = 4000;
/** Each registered close task (they run side by side, so this is also their total). */
const TASK_CAP_MS = 1500;
/** The settings.json write queue (a volume level changed just before closing). */
const SETTINGS_CAP_MS = 1500;

const SAVE_FAILED = "Your latest changes couldn't be saved.";
const STILL_SAVING = "Your latest changes are still being saved.";
const EXPORT_RUNNING = "An export is running. Closing now stops it.";

/** True when `p` fulfilled within `ms`; false when the cap ran out first or `p`
 *  rejected. Never rejects, and never leaves its timer behind a fast `p`. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([
    p.then(
      () => true,
      () => false,
    ),
    cap,
  ]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/* Before-close tasks                                                  */
/* ------------------------------------------------------------------ */

const beforeTasks = new Set<() => void>();

/** Work that must run BEFORE the close flow decides anything: revert transient previews
 *  that must never be saved (an unapplied crop, a colour being previewed). Synchronous;
 *  each task is try/caught; runs once per close request, right after the close ack and
 *  before the settle wait and the decision. Returns the unregister function. */
export function registerBeforeClose(task: () => void): () => void {
  // Wrapped for the same reason as registerCloseTask: each unregister removes
  // exactly its own registration.
  const entry = (): void => task();
  beforeTasks.add(entry);
  return () => {
    beforeTasks.delete(entry);
  };
}

function runBeforeClose(): void {
  // A snapshot: a task that unregisters itself (or another) mid-run changes
  // nothing about this run. A throwing one is only logged — the flow goes on.
  for (const task of [...beforeTasks]) {
    try {
      task();
    } catch (e) {
      console.error("A before-close task failed", e);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Close tasks                                                         */
/* ------------------------------------------------------------------ */

const tasks = new Set<() => void | Promise<void>>();

/** Work that must run before the window goes (volume flush, a running export's cancel).
 *  Returns the unregister function. */
export function registerCloseTask(task: () => void | Promise<void>): () => void {
  // Wrapped, so registering the same function twice gives two entries and each
  // unregister removes exactly its own — a Set of the bare function would let
  // one owner's unregister silently drop another's task.
  const entry = (): void | Promise<void> => task();
  tasks.add(entry);
  return () => {
    tasks.delete(entry);
  };
}

async function runCloseTasks(): Promise<void> {
  // Side by side, each under its own cap: one hung task (a cancel IPC that
  // never answers) must not starve the others, and a throwing one is only
  // logged — the window still goes.
  await Promise.all(
    [...tasks].map((task) =>
      within(
        (async () => {
          try {
            await task();
          } catch (e) {
            console.error("A close task failed", e);
          }
        })(),
        TASK_CAP_MS,
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* The flow                                                            */
/* ------------------------------------------------------------------ */

/** Ask "close anyway?". A prompt that cannot even be shown closes: the flow
 *  must never be the thing that makes X do nothing. */
async function closeAnyway(message: string): Promise<boolean> {
  try {
    // Inside the try: a dialog chunk that fails to load is a prompt that
    // cannot be shown, and closes like one.
    const { askCloseAnyway } = await import("../ui/temp-project");
    return await askCloseAnyway(message);
  } catch (e) {
    console.error("The close prompt could not be shown", e);
    return true;
  }
}

/** Ask "leave anyway?". The opposite failure rule from closeAnyway: a prompt
 *  that cannot be shown STAYS. Staying loses nothing, and the window's own X
 *  still has its escape hatch, so the user is never trapped by it. */
async function leaveAnyway(message: string): Promise<boolean> {
  try {
    const { askCloseAnyway } = await import("../ui/temp-project");
    return await askCloseAnyway(message, "leave");
  } catch (e) {
    console.error("The leave prompt could not be shown", e);
    return false;
  }
}

/** What flushOrAsk asks when the save did not land: true = go anyway. */
export type AskAnyway = (message: string) => Promise<boolean>;

// The permanent sessions a LEAVE is already flushing or asking about. A
// temporary project has one latch for every exit (its gate's `busy`, reached
// through `leaveGuard` by an OS open too), but a permanent one has no
// leaveGuard: Back and Ctrl+W go through the gate's latch, while an OS open
// comes here directly. Without this set both pass at once — their saves
// coalesce, both resolve true, the open navigates and then Back's dest()
// navigates over it; with a failing save the user gets two stacked "Leave this
// project?" prompts, and answering the stale one later sends them away from the
// screen they just opened. The second leave now stays (an OS open says so).
//
// A CLOSE never consults it: a close that bailed while a leave prompt is up
// would make X do nothing, and the window must never be unclosable. Its prompt
// stacking over the leave one is the right answer there.
const leaving = new WeakSet<ProjectSession>();

/**
 * The final save before a permanent project's screen goes, and the question
 * when it does not land. true = go on (closing, or leaving); false = stay.
 *
 * ONE rule for every exit, because the exits used to disagree. The window close
 * already asked when its final save failed; Back, Ctrl+W, the gear and an OS
 * open did not — they went straight to the editor's dispose, whose one save
 * cannot report a failure to anyone (the badge that would have said "Save
 * failed" is torn down with the screen). A OneDrive or antivirus lock, a full
 * disk or an unplugged drive then dropped the user's latest edits without a
 * word, and in a video session an edit stays unsaved for up to the autosave
 * interval, so the window for it was wide.
 *
 * Already on disk: nothing is written. save() always writes (and restamps
 * modifiedAt on disk), so skipping it keeps an untouched project from jumping
 * to the top of Home's "Date modified" sort just because it was open — the
 * rule the editor's own dispose follows. A save that has not landed within
 * FLUSH_CAP_MS asks too, but says what is true: the changes are still being
 * saved (the write may yet land), not that they couldn't be — and the user
 * decides.
 *
 * A leave while another leave of the same session is still out stays at once
 * (false), checked before the on-disk shortcut: the first one is about to
 * navigate, and a second true would navigate over it. See `leaving`.
 */
export async function flushOrAsk(
  s: ProjectSession,
  verb: "close" | "leave",
  ask?: AskAnyway,
): Promise<boolean> {
  const latch = verb === "leave";
  if (latch && leaving.has(s)) return false;
  if (s.saveState.get() === "saved") return true;
  if (latch) leaving.add(s);
  try {
    let failed = false;
    const save = s.save().catch((e: unknown) => {
      failed = true;
      throw e;
    });
    const landed = await within(save, FLUSH_CAP_MS);
    if (landed && s.saveState.get() !== "error") return true;
    // A save still running at the cap has not failed, and saying it had was
    // a false alarm: on a slow disk, a OneDrive-locked folder or a large image
    // project the write is merely late, and every leave of a permanent project
    // now waits for it, not only the close. Only a save that rejected, or one
    // the session reports as failed, is "couldn't be saved".
    const message = !landed && !failed && s.saveState.get() !== "error" ? STILL_SAVING : SAVE_FAILED;
    if (ask) return await ask(message);
    return await (verb === "close" ? closeAnyway(message) : leaveAnyway(message));
  } finally {
    if (latch) leaving.delete(s);
  }
}

/**
 * Ask the open session (if any) to confirm being replaced by a navigation it
 * did not initiate — today that is only the OS open-path route (core/open-route).
 * Resolves true when there is nothing to confirm, or the user agreed.
 *
 * A running export refuses outright, before any question. A session with a
 * leave guard (a temporary project) answers through it, so a temporary project
 * is never flushed to a scratch file the startup sweep deletes. Any other
 * session is a permanent project, and gets the same flush-or-ask as every other
 * exit: a failed final save asks "leave anyway?", and Stay cancels the open.
 *
 * Lives here rather than beside `currentSession` in core/session: the flush
 * rule is this module's, and session must not import it back (core has no
 * import cycles).
 */
export async function confirmLeaveCurrentSession(ask?: AskAnyway): Promise<boolean> {
  if (leaveBlockedReason() !== null) return false;
  const s = currentSession.get();
  if (!s) return true;
  if (s.leaveGuard) return await s.leaveGuard();
  return flushOrAsk(s, "leave", ask);
}

/** true = go on closing; false = the user chose to stay. */
async function confirmForSession(s: ProjectSession): Promise<boolean> {
  const facts = { hasSession: true, temp: s.temp.get(), edited: s.edited, blocked: !!s.blockLeave };
  let decision = decideClose(facts);
  if (decision === "export") {
    if (!(await closeAnyway(EXPORT_RUNNING))) return false;
    // Stopping the export is not the end of it: the project behind it still
    // needs its own answer. An edited temp project must still be offered Keep
    // (otherwise "close anyway" would silently hand the user's edits to the
    // temp sweep) and a permanent one still needs its final save.
    decision = decideClose({ ...facts, blocked: false });
  }
  switch (decision) {
    case "prompt": {
      // The editor's own TempLeaveGate: Keep saves permanently, Discard
      // deletes, Cancel (or a gate already busy with a prompt the user opened
      // from Back) stays. A temp session always has one; the fallback is the
      // same gate, so a missing guard can never mean a silent loss.
      const confirm =
        s.leaveGuard ??
        (async () => {
          const { createTempLeaveGate } = await import("../ui/temp-project");
          return createTempLeaveGate(s).confirm();
        });
      // The one wait in the flow with no cap: the question, then a Keep's
      // write. See the repeat-X rule in runCloseFlow.
      inUncappedWait = true;
      try {
        return await confirm();
      } finally {
        inUncappedWait = false;
      }
    }
    case "discard":
      // A Keep still in flight (the badge, or Keep in a Back prompt) points the
      // session at its PERMANENT file before it writes, and drops the temp flag
      // only after — so "temp and unedited" can describe a session whose path
      // is already the file the user just chose to keep. Discarding it would
      // delete that file. The path decides, not the flag: anything outside
      // tmp-projects is flushed like the permanent project it has become.
      if (!(await isTempProjectPath(s.path))) return flushForClose(s);
      // Unedited temp: nothing of the user's is in it, so no question (owner
      // decision) — the scratch file just goes now instead of at next start.
      const { discardTempSession } = await import("../ui/temp-project");
      await discardTempSession(s);
      return true;
    case "flush":
      return flushForClose(s);
    default:
      return true;
  }
}

/** The final save before the window goes. true = go on closing. */
function flushForClose(s: ProjectSession): Promise<boolean> {
  return flushOrAsk(s, "close");
}

/** Tells the Rust escape hatch this webview is alive and answering. */
function ackClose(): void {
  try {
    void ipc.closeAck().catch(() => {});
  } catch {
    /* no backend: nothing to tell */
  }
}

/** A modal is on screen — mid-flow, the Keep question or "close anyway?". */
function promptOnScreen(): boolean {
  // `document` is absent under the unit tests' node environment.
  return typeof document !== "undefined" && document.querySelector(".modal-backdrop") !== null;
}

let running = false;
/** The flow is inside its one UNCAPPED wait (the Keep question and its write). */
let inUncappedWait = false;

/** Never rejects. "stayed" = the user chose to stay (window not destroyed). */
export async function runCloseFlow(deps: CloseDeps): Promise<"closed" | "stayed"> {
  // One flow at a time. A second request while one runs is ignored: a prompt
  // on screen keeps answering it, and a flush is capped. Released on EVERY
  // outcome below, so the next request runs a fresh flow.
  if (running) {
    // A repeat X is acked — the webview is alive — EXCEPT while the flow sits
    // in its one uncapped wait with nothing on screen (a Keep's write on a
    // hung disk): staying silent there lets the Rust escape hatch force-close
    // on an X at least five seconds after the unanswered one, instead of every
    // X being acked into doing nothing forever. Every other wait is capped
    // and ends in a close or a question, so an unacked X during one would only
    // let the hatch destroy the window mid final save; and a user clicking X
    // twice past their own Keep prompt is never force-closed.
    if (!inUncappedWait || promptOnScreen()) ackClose();
    return "stayed";
  }
  // FIRST, before anything can wait: tells the Rust escape hatch this webview
  // is alive and answering.
  ackClose();
  running = true;
  try {
    // Transient previews (an unapplied crop, a colour being tried) go back
    // before anything below can read the project: they must never be saved,
    // kept or counted as an edit.
    runBeforeClose();
    let proceed: boolean;
    try {
      // A screen still closing (an editor mid final save after Back) finishes
      // first — bounded like every navigation's wait, so a teardown hung on a
      // dead disk costs seconds, not the close. Running out is never a silent
      // close either: that teardown may be the final save, and the editor
      // has already let go of its session, so nothing below would see it.
      const settled = await within(deps.settle(), TEARDOWN_WAIT_MS);
      if (!settled && !(await closeAnyway(STILL_SAVING))) return "stayed";
      const s = deps.session();
      proceed = s ? await confirmForSession(s) : true;
    } catch (e) {
      // Something in the flow itself broke. Treat it as a flush that failed:
      // the user is asked, and the window stays closable.
      console.error("The close flow failed", e);
      proceed = await closeAnyway(SAVE_FAILED);
    }
    if (!proceed) return "stayed";
    // The common tail, for every decision that goes on closing — including
    // "destroy" (home, settings, the viewer): a volume level set a moment ago
    // is still owed to settings.json.
    await runCloseTasks();
    await within(settingsWritesSettled(), SETTINGS_CAP_MS);
    try {
      await deps.destroy();
      return "closed";
    } catch (e) {
      // The window is still here and still closable: the next X runs a fresh flow.
      console.error("Couldn't close the window", e);
      return "stayed";
    }
  } finally {
    running = false;
  }
}

let installed = false;

/** main.ts calls this once at boot. */
export function installCloseGate(deps: CloseDeps): void {
  // App lifetime: installed once and never removed, so there is no unlisten to
  // race (G11). A second call is a no-op rather than a second flow per click.
  if (installed) return;
  installed = true;
  void onCloseRequested(() => {
    void runCloseFlow(deps);
  }).catch((e: unknown) => {
    // Not listening means Tauri closes natively: no gate, but never stuck.
    console.error("Couldn't install the close gate", e);
  });
}
