// OS file-open routing: File Explorer "Open with", a second launch, and the
// launch file itself (core/boot hands it here). A ".trt" opens that project. A
// media file goes where Settings → Opening files says: the viewer (no project
// at all), or a TEMPORARY one-clip project in the editor. Neither creates
// anything permanent — the user keeps a temporary project only by choosing
// Keep (owner decision; Home's "New project" is the one permanent creation
// path).
//
// Injectable, like core/boot: main.ts hands in the navigator, the leave check,
// the open helpers and the toast, so every branch — the user's reported path
// among them — is unit-tested without a window. Serialization is the caller's:
// main.ts runs each open on the open chain (core/open-media), so overlapping
// launches cannot interleave two project creations.

import { describeError } from "./ipc";
import { fileExt, fileName } from "./format";
import type { Route } from "./nav";
import type { ProjectSession } from "./session";
import { MEDIA_FILE_EXTENSIONS } from "./types";

export interface OpenRouteDeps {
  navigate(route: Route): void;
  /** The open session, or null (core/session `currentSession.get()`). */
  currentSession(): ProjectSession | null;
  /** core/app-close `confirmLeaveCurrentSession`: false cancels the open. */
  confirmLeave(): Promise<boolean>;
  /** core/session `leaveBlockedReason`: why a session refuses to be left. */
  leaveBlockedReason(): string | null;
  isTempProjectPath(path: string): Promise<boolean>;
  /** core/open-media: writes a temporary project for a media file, returns its path. */
  openMediaAsProject(path: string): Promise<string>;
  /** Settings → Opening files, read at the moment of the open. */
  openWith(): "viewer" | "editor";
  /** The mounted viewer, if any: a second open swaps the file in place. */
  activeViewer(): { show(path: string): void } | null;
  toast: {
    info(message: string): void;
    error(message: string): void;
    refuse(message: string): void;
  };
}

/** Route one OS-opened path. Reports its own failures and never rejects on a
 *  failed open; an unknown file type is ignored. */
export function createOpenRouter(deps: OpenRouteDeps): (path: string) => Promise<void> {
  return async function routeOpenPath(path: string): Promise<void> {
    const ext = fileExt(path);
    const isProject = ext === "trt";
    if (!isProject && !MEDIA_FILE_EXTENSIONS.has(ext)) return; // unknown type: ignore

    // An OS open-path replaces whatever is on screen WITHOUT going through any
    // of the editor's own exits (Back, Ctrl+W, the Settings gear), so it has to
    // honour the same leave gate they do. Without this, opening a second file
    // while a quick-view project is live disposes the editor past its
    // keep/discard prompt: the session flushes into the temp scratch file,
    // which the next launch's temp sweep deletes — and temp projects are
    // excluded from recents, so there is no way back. A permanent project gets
    // its final save first, and a failed one asks. False cancels this open
    // entirely, before any project file is created — and false is SAID: a
    // running export refuses by name, and a Cancel or Stay (or a prompt
    // already open) used to drop the open without a word, which reads as
    // "Explorer did nothing".
    //
    // Sampled BEFORE the gate: a temporary session only gets through it by Keep
    // (relocated to a permanent file) or Discard (disposed, its file deleted).
    // Either way the user has agreed to leave that screen, and the editor left
    // on it no longer edits what it shows — a Discarded one saves nothing, and
    // a Kept one still carries the scratch route. See the catch below.
    const leaving = deps.currentSession();
    // Only a temp editor whose gate actually asked: without a guard the leave
    // went through unasked, and that editor is still live — never navigate over it.
    const leavingTemp = leaving?.temp.get() === true && !!leaving.leaveGuard;
    if (!(await deps.confirmLeave())) {
      const why = deps.leaveBlockedReason();
      const name = fileName(path);
      // A refusal by policy (an export running) is styled as one and kept out
      // of the recent-errors ring; the user's own Cancel or Stay is just news.
      if (why) deps.toast.refuse(`${why} ${name} wasn't opened.`);
      else deps.toast.info(`Still editing. ${name} wasn't opened.`);
      return; // settles, so the chain moves on to the next open
    }

    if (isProject) {
      // A .trt that physically lives in the temp-projects dir is a live
      // quick-view scratch file: route it as temp so the editor shows the
      // Temporary badge and applies the keep gate on exit, matching the recents
      // exclusion the backend already enforces for that dir. Anything outside
      // it is a normal project.
      const temp = await deps.isTempProjectPath(path);
      deps.navigate(temp ? { view: "editor", projectPath: path, temp: true } : { view: "editor", projectPath: path });
      return;
    }

    if (deps.openWith() === "viewer") {
      // A viewer already on screen swaps the file in place: no remount, no
      // reload of the chunk, and the folder is re-listed for the new file.
      const viewer = deps.activeViewer();
      if (viewer) viewer.show(path);
      else deps.navigate({ view: "viewer", path });
      return;
    }

    // "editor": a temporary project in tmp-projects (never in recents) until
    // the user keeps it. Called directly, not through runOnOpenChain: this
    // already runs on the chain, and a task that awaits the chain awaits itself.
    try {
      const projectPath = await deps.openMediaAsProject(path);
      deps.navigate({ view: "editor", projectPath, temp: true });
    } catch (e) {
      deps.toast.error(describeError(e));
      // The open the user agreed to leave for has failed. An editor whose temp
      // session went through the gate (Kept or Discarded above) and is STILL
      // the screen goes home rather than staying on a dead editor: with Discard
      // its edits would be silently dropped, and its Keep button toasts
      // "already closed". Home is where a finished Keep is visible, in the
      // library. A permanent session (no gate to pass) keeps its editor —
      // nothing happened to it. Only this branch needs the rule: a .trt has
      // navigated already, and an editor that cannot load that file routes
      // itself away (mountEditor); the viewer branches cannot fail here.
      if (leavingTemp && deps.currentSession() === leaving) deps.navigate({ view: "home" });
    }
  };
}
