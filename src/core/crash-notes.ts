// Crash notes, shown once. The backend writes a short local note as the
// process dies (a Rust panic or a native fault) or as the WebView2 engine
// stops, writes one at the next launch for a run that ended without any of
// those, and keeps an in-memory note when this run's page had to be reloaded
// (src-tauri/src/crash.rs). Boot asks for them once (main.ts) and this turns
// each into an error toast whose Details button opens the note.
//
// Nothing new is built for the details: `toast.error` with `detail` already
// records the entry into Settings → Diagnostics → Recent errors and opens the
// copyable pane, and both of those run the text through `createRedactor`
// (src/ui/errors.ts) before anyone can copy it — a panic message can name the
// file that was being opened. Nothing here is sent anywhere.

import type { CrashNote } from "./ipc";
import { toast, type ToastOptions } from "../ui/toast";

/** The one-line message per kind. Sentence case, no trailing ellipses. */
export const CRASH_TITLES = {
  panic: "Taroting closed unexpectedly last time.",
  fault: "Taroting closed unexpectedly last time.",
  // A run that ended without writing any note (crash.rs `exit_note_text`,
  // found by the next launch): the process was gone before it could say why.
  // Out of memory is the in-process cause; from outside, Windows ending it at
  // shutdown, an installer replacing it, or Task Manager.
  exit:
    "Taroting closed unexpectedly last time without leaving an error report. It may have run out of memory, or been ended from outside (a Windows shutdown, Task Manager).",
  page: "The page stopped working, so Taroting reloaded it. Edits made since the last autosave may be lost.",
  engine:
    "Taroting's display engine stopped, so Taroting restarted. Edits made since the last autosave may be lost.",
} as const;

/** An engine note whose restart was refused (the engine had already stopped
 *  less than a minute earlier, crash.rs `engine_restart_allowed`): the app
 *  ended instead of restarting, so the "restarted" title would be untrue. */
export const ENGINE_NOT_RESTARTED =
  "Taroting's display engine stopped, so Taroting closed. Edits made since the last autosave may be lost.";

/** An engine note written because the display engine could not be created at
 *  all (crash.rs `startup_failure_note_text`, `reason: could not be created at
 *  startup`). No page ever loaded in that run, so nothing could have been
 *  edited: the "may be lost" sentence the other engine titles carry would be
 *  untrue, and would send the user looking for work that never existed. */
export const ENGINE_FAILED_AT_STARTUP = "Taroting's display engine could not start last time, so Taroting closed.";

/** A page note whose reload kept the temporary project that was open (crash.rs
 *  adds the line `temporary project: kept` once it has handed that project to
 *  Home's recover list). The reloaded page boots to Home with no memory of
 *  where it was, and that project is in no other list for the rest of the run
 *  (temporary projects never enter recents), so without saying where it went
 *  the user had no way to find it until the next launch offered it back. */
export const PAGE_TEMP_KEPT =
  "The page stopped working, so Taroting reloaded it. A temporary project you were editing can be recovered from Home; edits since the last autosave may be lost.";

/** A page note whose reload was refused (the page had already been reloaded
 *  too often, crash.rs `take_reload`; the line is `reloaded: no`). No reload
 *  means no page to show it on, so this note is read at the next launch, and
 *  the default title's "reloaded it" would be untrue. */
export const PAGE_NOT_RELOADED =
  "The page kept stopping last time, so Taroting stopped reloading it. Edits made since the last autosave may be lost.";

/** The title for a note's kind. A kind this build does not know (a newer
 *  backend, a damaged note) reads as the plain "closed unexpectedly". The
 *  detail is read only for an engine note: its `reason:` line says whether the
 *  engine ever started, and its `restarted:` line whether the restart the
 *  default title promises actually happened. A page note's `reloaded:` and
 *  `temporary project:` lines do the same for the page title. */
export function crashTitle(kind: string, detail = ""): string {
  if (kind === "engine" && /^reason: could not be created at startup\r?$/m.test(detail)) return ENGINE_FAILED_AT_STARTUP;
  if (kind === "engine" && /^restarted: no\b/m.test(detail)) return ENGINE_NOT_RESTARTED;
  if (kind === "page" && /^reloaded: no\b/m.test(detail)) return PAGE_NOT_RELOADED;
  if (kind === "page" && /^temporary project: kept\b/m.test(detail)) return PAGE_TEMP_KEPT;
  return Object.hasOwn(CRASH_TITLES, kind)
    ? CRASH_TITLES[kind as keyof typeof CRASH_TITLES]
    : CRASH_TITLES.panic;
}

/** Where the notes go: the app's toast, or a recorder in a unit test. */
export interface CrashNoteSink {
  error(message: string, opts?: ToastOptions): void;
}

/** One error toast per note, with the note itself behind Details. */
export function showCrashNotes(notes: readonly CrashNote[], sink: CrashNoteSink = toast): void {
  for (const note of notes) {
    sink.error(crashTitle(note.kind, note.detail), { detail: note.detail, op: "Crash", title: "Crash report" });
  }
}
