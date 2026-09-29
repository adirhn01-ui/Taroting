// Opening media from outside the app (File Explorer "Open with", a second
// launch, the viewer's "Open as project"): the one serialized chain every
// open/creation step runs on, the record of screen teardowns an open has to
// wait for, the temp-projects path test, and the one place a media file
// becomes a temporary one-clip project.
//
// core, not ui: nothing here toasts or navigates. Callers own both, so the same
// creation step can serve main.ts's open routing and a screen's own menu.

import { fileStem } from "./format";
import { ipc } from "./ipc";
import { MAX_CANVAS, createProject, importMediaAsClip, setProjectCanvas } from "./project";

/* ------------------------------------------------------------------ */
/* The open chain                                                      */
/* ------------------------------------------------------------------ */

// Every open/creation step waits for the one before it: two Explorer launches
// a moment apart must not interleave two project creations, and a leave gate
// one of them raised must settle before the next open asks again. `chain` only
// ever holds a promise that cannot reject, so one failed open never stalls the
// ones queued behind it.
let chain: Promise<unknown> = Promise.resolve();

/** Run `task` after every earlier open/creation step settled (the chain that was main.ts
 *  `openChain` + `enqueueOpen`). The chain never rejects; the returned promise does.
 *  NEVER call from inside a task already on the chain (routeOpenPath runs on it): a task
 *  that awaits the chain awaits itself forever. */
export function runOnOpenChain<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* Screen teardowns                                                    */
/* ------------------------------------------------------------------ */

/**
 * How long a navigation waits for the screens before it to finish closing.
 *
 * The wait is there for ordering: an editor's teardown ends in its final
 * save, and a screen that mounted before that landed could reopen the same
 * .trt from before the flush. But a save can hang — `saveProject` stuck on an
 * unplugged drive or a dead network share never answers — and an unbounded
 * wait then froze EVERY later navigation, Explorer opens included, behind it
 * for good. Three seconds is far past any healthy flush (a project write is
 * one small JSON file) and short enough that a hung disk reads as a pause,
 * not a dead app. Past it the next screen mounts anyway; the teardown keeps
 * running and still reports its own failure if it has one.
 */
export const TEARDOWN_WAIT_MS = 3000;

export interface Teardowns {
  /** Start `fn` now. A throw or rejection goes to the tracker's `onError`, never back to the
   *  caller, so one broken teardown cannot strand navigation half-way. */
  track(fn: () => void | Promise<void>): void;
  /** Every teardown tracked so far, however long that takes. Never rejects. What the app's
   *  close gate waits on: closing the window must not cut a final save short. */
  settled(): Promise<void>;
  /** `settled()`, given up on after `ms`: true when everything closed in time, false when the
   *  wait ran out. What a navigation waits on (see TEARDOWN_WAIT_MS). */
  settledWithin(ms: number): Promise<boolean>;
}

/** The shell's record of screen teardowns still in flight (main.ts owns the one instance). */
export function createTeardowns(onError: (e: unknown) => void): Teardowns {
  // Two views of the same work. `all` is every teardown ever tracked, and the
  // close gate waits on it in full. `nav` is what navigations wait on, and it is
  // forgiven once a wait runs out: one teardown hung on a dead disk must cost
  // the NEXT navigation its three seconds, not every navigation for the rest of
  // the session (a never-settling member would keep a combined promise pending
  // for good).
  let all: Promise<void> = Promise.resolve();
  let nav: Promise<void> = Promise.resolve();
  return {
    track(fn) {
      const run = (async () => {
        try {
          await fn();
        } catch (e) {
          // The reporter must not become a second failure: a throw here would
          // reject `run`, and `all` is promised never to reject.
          try {
            onError(e);
          } catch {
            /* nothing left to tell */
          }
        }
      })();
      all = Promise.all([all, run]).then(() => {});
      nav = Promise.all([nav, run]).then(() => {});
    },
    settled: () => all,
    settledWithin(ms) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          // Given up on: whatever is still running no longer holds up later
          // navigations (it still reports its own failure, and `all` still
          // waits for it at close).
          nav = Promise.resolve();
          resolve(false);
        }, ms);
      });
      // The timer is cleared the moment the teardowns win: a healthy
      // navigation must not leave a three-second timer behind it.
      return Promise.race([nav.then(() => true), expiry]).finally(() => clearTimeout(timer));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Temp-project paths                                                  */
/* ------------------------------------------------------------------ */

/** Backslashes + lowercase: a case-insensitive Windows prefix test. */
function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

// The temp-projects dir, resolved once per app run (a stable OS path) and
// cached as a promise so concurrent opens share the one IPC round-trip. Only an
// ANSWER is cached: a failed lookup used to be remembered as "" for the rest of
// the run, after which every quick-view scratch file opened from Explorer
// routed as a permanent project and skipped the keep/discard gate. Now the next
// open simply asks again. An empty answer (a plain browser, the ipc fallback)
// is a real answer, and makes every test below false.
let tempDirPrefix: Promise<string> | null = null;
function tempProjectsDirPrefix(): Promise<string> {
  if (!tempDirPrefix) {
    const lookup = ipc.tempProjectsDir().then((dir) => {
      if (!dir) return "";
      // Always end on exactly one separator, so the prefix test stops at a
      // folder boundary: `tmp-projects-old\x.trt` is not inside `tmp-projects`.
      return `${normalizePath(dir).replace(/\\+$/, "")}\\`;
    });
    tempDirPrefix = lookup;
    lookup.catch(() => {
      if (tempDirPrefix === lookup) tempDirPrefix = null;
    });
  }
  return tempDirPrefix;
}

/** Moved from main.ts (`tempProjectsDirPrefix` with normalizePath): case-insensitive prefix
 *  test against the tmp-projects dir, resolved once per run; "" in a plain browser → always
 *  false. */
export async function isTempProjectPath(path: string): Promise<boolean> {
  let prefix: string;
  try {
    prefix = await tempProjectsDirPrefix();
  } catch {
    // Unknown is "not temp": the file opens as the ordinary project it looks
    // like, which is what every build before quick view did with it.
    return false;
  }
  return prefix.length > 0 && normalizePath(path).startsWith(prefix);
}

/* ------------------------------------------------------------------ */
/* Media → temporary project                                           */
/* ------------------------------------------------------------------ */

/** Aspect-preserving clamp of a photo's display-oriented size so the LONG side is ≤ MAX_CANVAS;
 *  setProjectCanvas then applies even/16 rounding. 12000x3000 → 8192x2048; 1001x667 → 1001x667
 *  (setProjectCanvas makes it 1002x668). */
export function photoCanvas(width: number, height: number): { width: number; height: number } {
  // Not a size at all (a probe that reported none): hand it back untouched and
  // let the caller decide — scaling NaN would only launder it into a canvas.
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width, height };
  }
  const long = Math.max(width, height);
  if (long <= MAX_CANVAS) return { width, height };
  const k = MAX_CANVAS / long;
  // The long side is pinned to exactly MAX_CANVAS rather than recomputed, so
  // rounding can never nudge it one past the cap. The short side keeps at
  // least one pixel; setProjectCanvas lifts it to its own 16 px floor.
  return width >= height
    ? { width: MAX_CANVAS, height: Math.max(1, Math.round(height * k)) }
    : { width: Math.max(1, Math.round(width * k)), height: MAX_CANVAS };
}

/** Create a TEMPORARY one-clip project for `path`: tempProjectPath(fileStem) → createProject →
 *  probeMedia → importMediaAsClip → [kind "image": setProjectCanvas(photoCanvas(w,h)) —
 *  PHASE-3 SEAM: Phase 3 replaces this branch with image-project creation] → saveProject.
 *  Returns the .trt path. Does NOT navigate. NOT chain-wrapped: callers outside the chain wrap
 *  it in runOnOpenChain. Throws on failure after best-effort deleting a .trt it already wrote. */
export async function openMediaAsProject(path: string): Promise<string> {
  const projectPath = await ipc.tempProjectPath(fileStem(path));
  // Nothing exists on disk until saveProject lands (tempProjectPath only picks
  // a free name), so a failure before it has nothing to clean up.
  let written = false;
  try {
    let project = createProject(fileStem(projectPath));
    const info = await ipc.probeMedia(path);
    project = importMediaAsClip(project, info).project;
    // PHASE-3 SEAM: a photo becomes an image project here instead.
    // Until then it gets a video project whose canvas IS the photo, rather
    // than the 1920x1080 default letterboxing a portrait shot into a sliver.
    // addMedia adopts a VIDEO's size already; stills are left to us. `info` is
    // a probe result, so `generator` is never set — tested anyway, the same way
    // every other `kind === "image"` check in the tree tests it first.
    const w = info.width ?? 0;
    const h = info.height ?? 0;
    if (info.kind === "image" && !info.generator && w > 0 && h > 0) {
      const c = photoCanvas(w, h);
      project = setProjectCanvas(project, c.width, c.height);
    }
    await ipc.saveProject(projectPath, project);
    written = true;
    // Any step added after the save goes HERE, inside the try: the catch below
    // then removes the scratch file a half-finished creation left behind.
    return projectPath;
  } catch (e) {
    if (written) await ipc.deleteProject(projectPath).catch(() => {});
    throw e;
  }
}
