// The folder viewer: one file at a time, arrows through its folder, no project.
// Lazy route chunk, never prefetched; imports only main-chunk modules plus
// ./loader and ./stepper (never anything under src/editor/).

export interface ViewerHandle {
  /** Replace the shown file in place (second Explorer open while viewing): no remount,
   *  re-lists the new file's folder. Synchronous; the async work is generation-guarded. */
  show(path: string): void;
  /** The file currently shown (becomes EditorRoute.returnTo). */
  current(): string;
  dispose(): void;
}

export function mountViewer(_root: HTMLElement, _path: string): ViewerHandle {
  throw new Error("not implemented");
}
