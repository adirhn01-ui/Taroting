// Home's "New image" dialog: a blank canvas (a preset size or a custom one,
// and a background) or a photo, created as an image project and opened.
//
// Must stay small and must NEVER import anything under src/image/: Home is in
// the main chunk, and one such import would pull the whole image editor into
// startup. Project creation goes through core/image-project.ts.
//
// Not implemented yet (opens nothing): the declaration below is the contract.

/** Opens the dialog and returns its closer, for Home's `openOverlays`.
 *  `onCreated` receives the new project's path; `isDisposed` is checked after
 *  every await, so a Home that has gone away is never navigated from. */
export function openNewImageDialog(opts: {
  onCreated(projectPath: string): void;
  isDisposed(): boolean;
}): () => void;
export function openNewImageDialog(): () => void {
  return () => {};
}
