// Opening media from outside the app (File Explorer "Open with", a second
// launch, the viewer's "Open as project"): the one serialized chain every
// open/creation step runs on, the temp-projects path test, and the one place a
// media file becomes a temporary one-clip project.
//
// SIGNATURE STUB: the bodies below are placeholders until the implementation
// lands; nothing calls them yet.

/** Run `task` after every earlier open/creation step settled (the chain that was main.ts
 *  `openChain` + `enqueueOpen`). The chain never rejects; the returned promise does.
 *  NEVER call from inside a task already on the chain (routeOpenPath runs on it): a task
 *  that awaits the chain awaits itself forever. */
export function runOnOpenChain<T>(_task: () => Promise<T>): Promise<T> {
  throw new Error("not implemented");
}

/** Moved from main.ts (`tempProjectsDirPrefix` with normalizePath): case-insensitive prefix
 *  test against the tmp-projects dir, resolved once per run; "" in a plain browser → always
 *  false. */
export function isTempProjectPath(_path: string): Promise<boolean> {
  throw new Error("not implemented");
}

/** Aspect-preserving clamp of a photo's display-oriented size so the LONG side is ≤ MAX_CANVAS;
 *  setProjectCanvas then applies even/16 rounding. 12000x3000 → 8192x2048; 1001x667 → 1001x667
 *  (setProjectCanvas makes it 1002x668). */
export function photoCanvas(_width: number, _height: number): { width: number; height: number } {
  throw new Error("not implemented");
}

/** Create a TEMPORARY one-clip project for `path`: tempProjectPath(fileStem) → createProject →
 *  probeMedia → importMediaAsClip → [kind "image": setProjectCanvas(photoCanvas(w,h)) —
 *  PHASE-3 SEAM: Phase 3 replaces this branch with image-project creation] → saveProject.
 *  Returns the .trt path. Does NOT navigate. NOT chain-wrapped: callers outside the chain wrap
 *  it in runOnOpenChain. Throws on failure after best-effort deleting a .trt it already wrote. */
export function openMediaAsProject(_path: string): Promise<string> {
  throw new Error("not implemented");
}
