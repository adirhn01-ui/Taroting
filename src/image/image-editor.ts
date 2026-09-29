// Image editor shell: an image project (kind "image", schema 3) opened from
// the ordinary editor route. Loaded lazily by `mountEditor` once the project
// is known to be an image project; never prefetched, so a user who never opens
// one never pays for this chunk.
//
// Not implemented yet: the declaration below is the contract.

import "./image-editor.css";
import type { LoadedProject } from "../core/ipc";
import type { EditorRoute } from "../core/nav";

/**
 * Mount the image editor for a project `mountEditor` has already loaded
 * (`loaded` is `ipc.loadProject`'s result, already through `sanitizeProject`).
 *
 * THE SHELL CONTRACT. To the app shell this IS the editor: main.ts
 * (`routeOpenPath`) and core/app-close (`runCloseFlow`) decide what to do by
 * reading `currentSession.get()`, and an editor that does not publish itself
 * would let an Explorer open or a window close walk straight over an edited
 * image project ("no session → destroy"). So it owes, in full, everything
 * `mountEditor` does for a video project:
 *
 *  1. Supersession. `isStale` is the caller's navigation-token check (main.ts
 *     go()). After EVERY await, if it returns true: undo what was built
 *     privately (`void session.dispose()` if one exists — it has no edits, so
 *     it writes nothing) and return a no-op handle, having touched nothing
 *     shared — no DOM, no toast, no navigation, no `currentSession`.
 *     (`mountEditor` has already checked it once this chunk loaded.)
 *  2. Validate first: `validateImageProject(loaded.project)` (image/layers.ts)
 *     before anything reads the project; one toast when it dropped data.
 *  3. Session: `new ProjectSession(route.projectPath, project, { temp:
 *     route.temp === true, debounceMs: 2500 })`; every pointer-down gesture
 *     inside `session.holdAutosave()`. A fix-up the user did not make (the
 *     decoded-size repair) goes through `session.replace(next, { edit: false
 *     })`, so an untouched temporary photo never prompts on close.
 *  4. Publish: `currentSession.set(session)` once mounted; in dispose clear it
 *     ONLY while it is still ours — `if (currentSession.get() === session)
 *     currentSession.set(null)` — because a newer mount may already own it
 *     and nulling it would strip that screen's leave guard.
 *  5. Temporary projects: `const exits = createTempExits(session,
 *     createTempLeaveGate(session))` (ui/temp-project.ts), and
 *     `if (session.temp.get()) session.leaveGuard = () => exits.confirm()`.
 *     The Temporary badge is the video editor's: `#ed-save` reads "Temporary"
 *     while `session.temp` is true, and a `#ed-keep` button beside it calls
 *     `exits.keep()`; once the session is no longer temp the button goes and
 *     `session.leaveGuard` is cleared (editor.ts `paintKeep`).
 *  6. Exits: Back (`#ed-home`) and Ctrl+W go through `exits.confirmLeave(()
 *     => navigate(exitDest(route)))` — `exitDest` from core/nav, never a
 *     hard-coded home, so a project opened from the viewer returns to the
 *     viewer's file. The gear (`#ed-settings`) goes to `{ view: "settings" }`
 *     through the same `exits.confirmLeave`.
 *  7. Export: while one runs, `session.blockLeave` is set (an OS open then
 *     refuses, naming the reason) and a `registerCloseTask` (core/app-close)
 *     cancels it on window close; both are released on every way the export
 *     ends (the video export dialog's `createExportRunHold` is the pattern).
 *  8. `loaded.missing` → `openRelinkDialog({ …, stillsOnly: true })`;
 *     `loaded.recovered` → the backup toast the video editor shows.
 *  9. Never rejects. A failure after the chunk loaded toasts and routes out
 *     through `exitDest(route)` (unless stale), returning a no-op handle —
 *     a rejection here would escape go() and leave a blank window.
 * 10. Dispose: close every body-parked overlay and `closeMenu()`, detach keys
 *     and listeners, dispose the children, release `currentSession` (if still
 *     ours), and `await session.dispose()` LAST so the final save lands.
 */
export function mountImageEditor(
  root: HTMLElement,
  route: EditorRoute,
  isStale: () => boolean,
  loaded: LoadedProject,
): Promise<{ dispose(): Promise<void> }>;
export async function mountImageEditor(): Promise<{ dispose(): Promise<void> }> {
  return { dispose: async (): Promise<void> => {} };
}
