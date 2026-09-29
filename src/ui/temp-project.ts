// Temporary (quick-view) projects: the one "Keep temporary project?" prompt,
// what Keep and Discard actually do to the session and its scratch file, and
// the leave gate every exit from a temp project goes through.
//
// SIGNATURE STUB: the bodies below are placeholders until the implementation is
// extracted from the mountEditor closure in editor/editor.ts. Nothing calls
// them yet; editor.ts still holds the live code.

import type { ProjectSession } from "../core/session";

export type KeepChoice = "keep" | "discard" | "cancel";

/** The one "Keep temporary project?" modal: .modal-backdrop + trapTab + focus on Keep;
 *  Esc, backdrop and X = cancel; trap released and capture keydown removed on EVERY close path.
 *  Resolves exactly once. Discard is a plain .btn, never .btn--danger. */
export function askKeepTemp(): Promise<KeepChoice> {
  throw new Error("not implemented");
}

/** ipc.newProjectPath(session.project.name) → session.relocate(dest) → session.temp.set(false)
 *  → best-effort ipc.deleteProject(old temp path). Returns dest. Throws on failure: the session
 *  is then still temp at its old path. */
export function keepTempSession(_session: ProjectSession): Promise<string> {
  throw new Error("not implemented");
}

/** session.discard() FIRST (so no flush resurrects the file), then best-effort
 *  ipc.deleteProject(session.path). Never throws. */
export function discardTempSession(_session: ProjectSession): Promise<void> {
  throw new Error("not implemented");
}

export interface TempLeaveGate {
  /** Not temp → dest() now. Temp → askKeepTemp(): keep → keepTempSession → dest;
   *  discard → discardTempSession → dest; cancel, re-entrancy bail, or keep failure (toast)
   *  → onCancel. EXACTLY ONE of dest/onCancel fires, on every path. */
  confirmLeave(dest: () => void, onCancel?: () => void): void;
  /** Same as a promise (for session.leaveGuard and the close gate): true = proceed. */
  confirm(): Promise<boolean>;
  /** True from modal open until keep/discard settles (the old `keeping` latch). */
  readonly busy: boolean;
}

export function createTempLeaveGate(_session: ProjectSession): TempLeaveGate {
  throw new Error("not implemented");
}

/** The gate with its prompt injected, so the decision logic is testable under
 *  vitest's node environment (no DOM, no modal). `createTempLeaveGate` is this
 *  with `askKeepTemp`. */
export function createTempLeaveGateWith(
  _session: ProjectSession,
  _ask: () => Promise<KeepChoice>,
): TempLeaveGate {
  throw new Error("not implemented");
}

/** Close-gate modal. `message` is the first line; buttons [Stay] (focused) [Close anyway].
 *  true = close anyway. */
export function askCloseAnyway(_message: string): Promise<boolean> {
  throw new Error("not implemented");
}
