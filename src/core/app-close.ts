// The window-close gate: every close request (X, Alt+F4, taskbar) runs one
// flow that keeps, discards, flushes or asks before the window goes, and
// never leaves the window unclosable (every wait is capped).
//
// Why a flow at all: the editor's own exits (Back, Ctrl+W, the gear) run its
// teardown, which ends in the final save and the keep/discard prompt. Closing
// the window runs NONE of that — the process simply ends — so without this an
// edit made in the last autosave interval was lost, and an edited temporary
// project went to the next start's temp sweep without the user ever being
// asked about it.

import { ipc, onCloseRequested } from "./ipc";
import { TEARDOWN_WAIT_MS, isTempProjectPath } from "./open-media";
import { settingsWritesSettled, type ProjectSession } from "./session";
import { askCloseAnyway, createTempLeaveGate, discardTempSession } from "../ui/temp-project";

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

/** A final save that has not landed by now is treated as failed: the user decides. */
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
    return await askCloseAnyway(message);
  } catch (e) {
    console.error("The close prompt could not be shown", e);
    return true;
  }
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
      const confirm = s.leaveGuard ?? (() => createTempLeaveGate(s).confirm());
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
      await discardTempSession(s);
      return true;
    case "flush":
      return flushForClose(s);
    default:
      return true;
  }
}

/** The final save before the window goes. true = go on closing. */
async function flushForClose(s: ProjectSession): Promise<boolean> {
  // Already on disk: nothing to write. save() always writes (and restamps
  // modifiedAt), so skipping it keeps an untouched project from jumping to
  // the top of Home's "Date modified" sort just because it was open at
  // close — the same rule the editor's own dispose follows.
  if (s.saveState.get() === "saved") return true;
  const landed = await within(s.save(), FLUSH_CAP_MS);
  // A timeout is never a silent close: the write may yet land, but the
  // user is told it has not, and decides.
  if (!landed || s.saveState.get() === "error") return closeAnyway(SAVE_FAILED);
  return true;
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

/* ---------------- a running export ---------------- */

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
