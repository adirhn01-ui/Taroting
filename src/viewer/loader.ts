// Resolves a file for display in the viewer: stills straight to an <img>,
// video/audio through probe → classify → direct / remux / "Prepare preview".
// One subscription to job events for the loader's whole life.

import type { PlaybackClass } from "../core/ipc";
import type { ViewElement } from "./stepper";

export type LoadState =
  | { state: "loading" }
  | {
      state: "ready";
      element: ViewElement;
      url: string;
      kind: "image" | "video" | "audio";
      /** container-only DIRECT attempt: the viewer must call directFailed() on a media `error`
       *  or when `loadedmetadata` has not fired within DIRECT_TIMEOUT_MS */
      tryingDirect: boolean;
    }
  | { state: "preparing"; ratio: number | null }
  | { state: "needsPrepare" }
  | { state: "failed"; message: string };

export const DIRECT_TIMEOUT_MS = 4000;

export interface SourceLoader {
  /** Resolve `path` for display; supersedes the previous load. A previous pending job is
   *  canceled (ipc.cancelJob) unless handOff() ran for it. */
  load(path: string): void;
  /** The user pressed "Prepare preview" (only meaningful in state needsPrepare). */
  prepare(): void;
  /** The container-only direct attempt failed → plan a remux. */
  directFailed(): void;
  /** Open-as-project hand-off. Keeps the current pending job ONLY if
   *  classifyPlayback(media, hints, settings.proxyMedia) equals the class the viewer planned
   *  (the editor will then join the same Inflight job); otherwise cancels it. Idempotent. */
  handOff(): Promise<void>;
  debug(): { loads: number; lastClass: PlaybackClass | null; jobId: number | null };
  dispose(): void;
}

export function createSourceLoader(_onState: (path: string, s: LoadState) => void): SourceLoader {
  throw new Error("not implemented");
}
