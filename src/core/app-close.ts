// The window-close gate: every close request (X, Alt+F4, taskbar) runs one
// flow that keeps, discards, flushes or asks before the window goes, and
// never leaves the window unclosable (every wait is capped).

import type { ProjectSession } from "./session";

export type CloseDecision = "destroy" | "flush" | "discard" | "prompt" | "export";

/** Pure. no session → destroy; blocked → export; temp && edited → prompt;
 *  temp && !edited → discard; permanent → flush. */
export function decideClose(_s: {
  hasSession: boolean;
  temp: boolean;
  edited: boolean;
  blocked: boolean;
}): CloseDecision {
  throw new Error("not implemented");
}

export interface CloseDeps {
  session(): ProjectSession | null;
  /** resolves once go()'s in-flight dispose (if any) has finished */
  settle(): Promise<void>;
  destroy(): Promise<void>;
}

/** Never rejects. "stayed" = the user chose to stay (window not destroyed). */
export function runCloseFlow(_deps: CloseDeps): Promise<"closed" | "stayed"> {
  throw new Error("not implemented");
}

/** main.ts calls this once at boot. */
export function installCloseGate(_deps: CloseDeps): void {
  throw new Error("not implemented");
}

/** Work that must run before the window goes (volume flush, a running export's cancel).
 *  Returns the unregister function. */
export function registerCloseTask(_task: () => void | Promise<void>): () => void {
  throw new Error("not implemented");
}
